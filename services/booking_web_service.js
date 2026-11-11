const { sqlObj, getDBPool } = require("../configs/database");

const { randomInt, randomUUID } = require("node:crypto");
const { createBookingCheckout } = require("./booking_checkout_service");

const DAY_MS = 86_400_000;
const MAX_STAY_NIGHTS = 90;
const MAX_SQL_INT = 2_147_483_647;
const TAX_BPS = Number(process.env.BOOKING_TAX_BPS ?? 0);

function badRequest(message) {
    return Object.assign(new Error(message), { statusCode: 400 });
}

function readAccommodationId(value) {
    if (
        (typeof value !== "string" && typeof value !== "number") ||
        !/^[1-9]\d*$/.test(String(value)) ||
        Number(value) > MAX_SQL_INT
    ) {
        throw badRequest("accommodationId phải là số nguyên dương.");
    }

    return Number(value);
}

function readDate(value, field) {
    if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) {
        throw badRequest(`${field} phải có định dạng YYYY-MM-DD.`);
    }

    const timestamp = Date.parse(`${value}T00:00:00Z`);

    if (
        !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString().slice(0, 10) !== value
    ) {
        throw badRequest(`${field} không phải ngày hợp lệ.`);
    }

    return timestamp;
}

function readStay({ checkinDate, checkoutDate, rooms = 1 }) {
    const start = readDate(checkinDate, "checkinDate");
    const end = readDate(checkoutDate, "checkoutDate");
    const totalNights = (end - start) / DAY_MS;

    if (totalNights < 1 || totalNights > MAX_STAY_NIGHTS) {
        throw badRequest(`Kỳ lưu trú phải từ 1 đến ${MAX_STAY_NIGHTS} đêm.`);
    }

    if (!Number.isSafeInteger(rooms) || rooms < 1 || rooms > MAX_SQL_INT) {
        throw badRequest("rooms phải là số nguyên dương.");
    }

    const nights = Array.from({ length: totalNights }, (_, index) => {
        const date = new Date(start + index * DAY_MS);

        return {
            stayDate: date.toISOString().slice(0, 10),
            dayOfWeek: date.getUTCDay() || 7,
        };
    });

    return { checkinDate, checkoutDate, rooms, totalNights, nights };
}

function groupRows(rows, key) {
    const groups = new Map();

    for (const row of rows) {
        const { [key]: id, ...data } = row;

        if (!groups.has(id)) {
            groups.set(id, []);
        }

        groups.get(id).push(data);
    }

    return groups;
}

function toCents(value) {
    return Math.round(Number(value) * 100);
}

function fromCents(value) {
    return value / 100;
}

async function loadRoomData(pool, accommodationId, stay, { includeActivePending = false } = {}) {
    const result = await pool.request()
        .input("accommodationId", sqlObj.Int, accommodationId)
        .input("checkin", sqlObj.VarChar(10), stay.checkinDate)
        .input("checkout", sqlObj.VarChar(10), stay.checkoutDate)
        .query(`
            DECLARE @start date = CONVERT(date, @checkin, 23);
            DECLARE @end date = CONVERT(date, @checkout, 23);

            SELECT a.id
            INTO #ActiveAccommodation
            FROM dbo.accommodations AS a
            WHERE a.id = @accommodationId
              AND a.status = 1
              AND a.deleted_at IS NULL;

            SELECT rt.id
            INTO #ActiveRoomTypes
            FROM dbo.room_types AS rt
            JOIN #ActiveAccommodation AS a ON a.id = rt.accommodation_id
            WHERE rt.status = 1 AND rt.deleted_at IS NULL;

            SELECT id FROM #ActiveAccommodation;

            SELECT
                rt.id,
                rt.code,
                rt.name,
                rt.short_description AS shortDescription,
                rt.description,
                rt.base_price AS basePrice,
                rt.area_sqm AS areaSqm,
                rt.bed_description AS bedDescription,
                rt.bedroom_count AS bedRoomCount,
                rt.bathroom_count AS bathRoomCount,
                rt.quantity,
                rt.included_adults AS includedAdults,
                rt.included_children AS includedChildren,
                rt.max_adults AS maxAdults,
                rt.max_children AS maxChildren,
                rt.max_occupancy AS maxOccupancy,
                rt.extra_adult_fee AS extraAdultFeePerNight,
                rt.extra_child_fee AS extraChildFeePerNight
            FROM dbo.room_types AS rt
            JOIN #ActiveRoomTypes AS active ON active.id = rt.id
            ORDER BY rt.sort_order, rt.id;

            SELECT
                bi.room_type_id AS roomTypeId,
                CONVERT(char(10), b.check_in_date, 23) AS checkinDate,
                CONVERT(char(10), b.check_out_date, 23) AS checkoutDate,
                COUNT_BIG(*) AS bookedQuantity
            FROM dbo.bookings AS b
            JOIN dbo.booking_items AS bi ON bi.booking_id = b.id
            JOIN #ActiveRoomTypes AS active ON active.id = bi.room_type_id
            WHERE b.accommodation_id = @accommodationId
              AND (
                    b.status = 'CONFIRMED'
                    ${includeActivePending ? "OR (b.status = 'PENDING' AND b.pending_expires_at > SYSDATETIME())" : ""}
              )
              AND b.check_in_date < @end
              AND b.check_out_date > @start
            GROUP BY bi.room_type_id, b.check_in_date, b.check_out_date;

            SELECT
                r.room_type_id AS roomTypeId,
                r.day_of_week AS dayOfWeek,
                r.price
            FROM dbo.room_weekday_rates AS r
            JOIN #ActiveRoomTypes AS active ON active.id = r.room_type_id;

            SELECT
                r.room_type_id AS roomTypeId,
                CONVERT(char(10), p.start_date, 23) AS startDate,
                CONVERT(char(10), p.end_date, 23) AS endDate,
                r.adjustment_type AS adjustmentType,
                r.adjustment_value AS adjustmentValue
            FROM dbo.room_period_rates AS r
            JOIN #ActiveRoomTypes AS active ON active.id = r.room_type_id
            JOIN dbo.accommodation_rate_periods AS ar
                ON ar.id = r.accommodation_rate_period_id
            JOIN dbo.rate_periods AS p ON p.id = ar.rate_period_id
            WHERE ar.accommodation_id = @accommodationId
              AND ar.is_active = 1
              AND p.is_active = 1
              AND p.deleted_at IS NULL
              AND p.start_date < @end
              AND p.end_date > @start
            ORDER BY p.start_date DESC, p.id DESC;

            SELECT
                i.room_type_id AS roomTypeId,
                i.id AS image_id,
                i.image_url,
                i.alt_text,
                i.caption,
                i.is_cover
            FROM dbo.room_type_images AS i
            JOIN #ActiveRoomTypes AS active ON active.id = i.room_type_id
            ORDER BY i.room_type_id, i.is_cover DESC, i.sort_order, i.id;

            SELECT
                ra.room_type_id AS roomTypeId,
                am.id AS amenity_id,
                am.name,
                am.code,
                am.category_code,
                am.icon_key,
                am.description,
                ra.is_chargeable,
                ra.note AS room_note
            FROM dbo.room_type_amenities AS ra
            JOIN #ActiveRoomTypes AS active ON active.id = ra.room_type_id
            JOIN dbo.amenities AS am ON am.id = ra.amenity_id
            ORDER BY ra.room_type_id, am.id;

            DROP TABLE #ActiveRoomTypes;
            DROP TABLE #ActiveAccommodation;
        `);

    const [accommodationRows, ...roomRecordsets] = result.recordsets;

    return accommodationRows.length > 0 ? roomRecordsets : null;
}

function calculateNightPrice(basePrice, weekdayPrice, period) {
    const normalPrice = toCents(weekdayPrice ?? basePrice);

    if (!period) {
        return normalPrice;
    }

    const adjustment = Number(period.adjustmentValue);
    const type = String(period.adjustmentType).trim().toLowerCase();

    switch (type) {
        case "fixed_price":
            return toCents(adjustment);

        case "increase_percent":
            return Math.round(normalPrice * (1 + adjustment / 100));

        case "decrease_percent":
            return Math.round(normalPrice * (1 - adjustment / 100));

        case "increase_amount":
            return normalPrice + toCents(adjustment);

        case "decrease_amount": {
            const price = normalPrice - toCents(adjustment);

            if (price <= 0) {
                throw new Error("Giá đêm sau khi giảm theo rate period phải lớn hơn 0.");
            }

            return price;
        }

        default:
            throw new Error(`Loại điều chỉnh giá không hợp lệ: ${type}`);
    }
}

function buildRoomTypes(recordsets, stay) {
    const [roomRows, bookedRows, weekdayRows, periodRows, imageRows, amenityRows] =
        recordsets;

    const bookings = groupRows(bookedRows, "roomTypeId");
    const weekdays = groupRows(weekdayRows, "roomTypeId");
    const periods = groupRows(periodRows, "roomTypeId");
    const images = groupRows(imageRows, "roomTypeId");
    const amenities = groupRows(amenityRows, "roomTypeId");

    return roomRows.map(room => {
        const roomBookings = bookings.get(room.id) ?? [];
        const weekdayRates = weekdays.get(room.id) ?? [];
        const periodRates = periods.get(room.id) ?? [];

        let maxBooked = 0;
        let roomSubtotalInCents = 0;

        const nightlyRates = stay.nights.map(({ stayDate, dayOfWeek }) => {
            const bookedOnNight = roomBookings.reduce((sum, booking) => {
                if (booking.checkinDate <= stayDate && stayDate < booking.checkoutDate) {
                    return sum + Number(booking.bookedQuantity);
                }

                return sum;
            }, 0);

            maxBooked = Math.max(maxBooked, bookedOnNight);

            const weekdayPrice = weekdayRates.find(
                rate => rate.dayOfWeek === dayOfWeek
            )?.price;

            const period = periodRates.find(
                rate => rate.startDate <= stayDate && stayDate < rate.endDate
            );

            const price = calculateNightPrice(room.basePrice, weekdayPrice, period);
            roomSubtotalInCents += price;

            return { stayDate, price: fromCents(price) };
        });

        return {
            ...room,
            availableQuantity: Math.max(0, room.quantity - maxBooked),
            roomSubtotal: fromCents(roomSubtotalInCents),
            nightlyRates,
            images: images.get(room.id) ?? [],
            amenities: amenities.get(room.id) ?? [],
        };
    });
}

async function loadOpenBookingSelection(pool, customerId, accommodationId, stay) {
    const result = await pool.request()
        .input("customerId", sqlObj.UniqueIdentifier, customerId)
        .input("accommodationId", sqlObj.Int, accommodationId)
        .input("checkin", sqlObj.VarChar(10), stay.checkinDate)
        .input("checkout", sqlObj.VarChar(10), stay.checkoutDate)
        .query(`
            SELECT
                CONVERT(varchar(20), b.id) AS bookingId,
                b.status AS bookingStatus,
                bi.room_type_id AS roomTypeId,
                bi.adults,
                bi.children
            FROM (
                SELECT TOP (1) id, status
                FROM dbo.bookings
                WHERE user_id = @customerId
                  AND accommodation_id = @accommodationId
                  AND check_in_date = CONVERT(date, @checkin, 23)
                  AND check_out_date = CONVERT(date, @checkout, 23)
                  AND status = 'PENDING'
                  AND pending_expires_at > SYSDATETIME()
                ORDER BY id DESC
            ) AS b
            JOIN dbo.booking_items AS bi ON bi.booking_id = b.id
            ORDER BY bi.id;
        `);

    const rows = result.recordset;

    return {
        bookingId: rows[0]?.bookingId ?? null,
        bookingStatus: rows[0]?.bookingStatus ?? null,
        selectedRooms: rows,
    };
}

function buildAvailability(allRoomTypes, requestedRooms) {
    const totalAvailableRooms = allRoomTypes.reduce(
        (sum, room) => sum + room.availableQuantity,
        0
    );

    let status = "AVAILABLE";
    let message = null;

    if (totalAvailableRooms === 0) {
        status = "SOLD_OUT";
        message = "Cơ sở lưu trú đã hết phòng trong kỳ lưu trú này.";
    } else if (totalAvailableRooms < requestedRooms) {
        status = "INSUFFICIENT_ROOMS";
        message = `Chỉ còn ${totalAvailableRooms}/${requestedRooms} phòng theo yêu cầu.`;
    }

    return { status, requestedRooms, totalAvailableRooms, message };
}

function reconcileSelectedRooms(selectedRooms, roomById) {
    const validRooms = [];
    const selectionIssues = [];
    const keptCountByType = new Map();
    const removedCountByType = new Map();

    for (const [index, selection] of selectedRooms.entries()) {
        const roomTypeId = selection?.roomTypeId;
        const room = roomById.get(roomTypeId);

        if (!room) {
            selectionIssues.push({
                code: "INVALID_ROOM_TYPE",
                index,
                roomTypeId: roomTypeId ?? null,
                message: "Đã bỏ một phòng vì hạng phòng này không còn mở bán.",
            });
            continue;
        }

        const { adults, children } = selection;

        if (
            !Number.isSafeInteger(adults) || adults < 1 ||
            !Number.isSafeInteger(children) || children < 0 ||
            adults > room.maxAdults ||
            children > room.maxChildren ||
            adults + children > room.maxOccupancy
        ) {
            selectionIssues.push({
                code: "INVALID_OCCUPANCY",
                index,
                roomTypeId,
                message: `Đã bỏ một phòng ${room.name} vì số khách không phù hợp với sức chứa.`,
            });
            continue;
        }

        const keptCount = keptCountByType.get(roomTypeId) ?? 0;

        if (keptCount >= room.availableQuantity) {
            const removedCount = removedCountByType.get(roomTypeId) ?? 0;
            removedCountByType.set(roomTypeId, removedCount + 1);
            continue;
        }

        validRooms.push(selection);
        keptCountByType.set(roomTypeId, keptCount + 1);
    }

    const removedRoomTypes = Array.from(
        removedCountByType,
        ([roomTypeId, removedQuantity]) => {
            const room = roomById.get(roomTypeId);
            const keptQuantity = keptCountByType.get(roomTypeId) ?? 0;
            const selectedQuantity = keptQuantity + removedQuantity;
            const soldOut = room.availableQuantity === 0;

            return {
                roomTypeId,
                selectedQuantity,
                keptQuantity,
                removedQuantity,
                availableQuantity: room.availableQuantity,
                reason: soldOut ? "ROOM_TYPE_SOLD_OUT" : "ROOM_TYPE_INSUFFICIENT",
                message: soldOut
                    ? `Đã bỏ ${removedQuantity} phòng ${room.name} vì hạng này đã hết phòng.`
                    : `Đã giảm từ ${selectedQuantity} xuống ${keptQuantity} phòng ${room.name} vì chỉ còn ${room.availableQuantity} phòng trống.`,
            };
        }
    );

    return { validRooms, selectionIssues, removedRoomTypes };
}

function calculateQuote(accommodationId, selectedRooms, roomById, totalNights) {
    let roomsSubtotal = 0;
    let extraGuestTotal = 0;

    const quotedRooms = selectedRooms.map((selection, index) => {
        const { roomTypeId, adults, children } = selection;
        const room = roomById.get(roomTypeId);
        const subtotal = toCents(room.roomSubtotal);

        const extraAdultTotal =
            Math.max(0, adults - room.includedAdults) *
            toCents(room.extraAdultFeePerNight) *
            totalNights;

        const extraChildTotal =
            Math.max(0, children - room.includedChildren) *
            toCents(room.extraChildFeePerNight) *
            totalNights;

        roomsSubtotal += subtotal;
        extraGuestTotal += extraAdultTotal + extraChildTotal;

        return {
            roomId: `room-${accommodationId}-${roomTypeId}-${index + 1}`,
            roomTypeId,
            includedAdults: room.includedAdults,
            includedChildren: room.includedChildren,
            adults,
            children,
            maxAdults: room.maxAdults,
            maxChildren: room.maxChildren,
            maxOccupancy: room.maxOccupancy,
            roomSubtotal: room.roomSubtotal,
            extraAdultFeePerNight: room.extraAdultFeePerNight,
            extraChildFeePerNight: room.extraChildFeePerNight,
            extraAdultTotal: fromCents(extraAdultTotal),
            extraChildTotal: fromCents(extraChildTotal),
            discountAmount: 0,
            totalAmount: fromCents(subtotal + extraAdultTotal + extraChildTotal),
            nightlyRates: room.nightlyRates,
        };
    });

    if (!Number.isInteger(TAX_BPS) || TAX_BPS < 0 || TAX_BPS > 10000) {
        throw new Error("BOOKING_TAX_BPS không hợp lệ.");
    }

    const taxableAmount = roomsSubtotal + extraGuestTotal;
    const taxAmount = Math.round(taxableAmount * TAX_BPS / 10000);

    return {
        roomsSubtotal: fromCents(roomsSubtotal),
        extraGuestTotal: fromCents(extraGuestTotal),
        roomDiscountTotal: 0,
        discountAmount: 0,
        taxAmount: fromCents(taxAmount),
        totalAmount: fromCents(taxableAmount + taxAmount),
        selectedRooms: quotedRooms,
    };
}


async function getBookingPreview(body, customerId) {
    console.log("[getBookingPreview service] Data cua body : ", body);

    const accommodationId = readAccommodationId(body.accommodationId);
    const stay = readStay(body);
    const { draftBooking } = body;
    const hasDraft = draftBooking != null;

    if (hasDraft && (typeof draftBooking !== "object" || Array.isArray(draftBooking))) {
        throw badRequest("draftBooking phải là một JSON object.");
    }

    if (
        hasDraft &&
        draftBooking.selectedRooms != null &&
        !Array.isArray(draftBooking.selectedRooms)
    ) {
        throw badRequest("draftBooking.selectedRooms phải là mảng.");
    }

    const pool = await getDBPool();
    const recordsets = await loadRoomData(pool, accommodationId, stay);

    if (!recordsets) {
        return null;
    }

    const allRoomTypes = buildRoomTypes(recordsets, stay);
    const roomById = new Map(allRoomTypes.map(room => [room.id, room]));

    const data = {
        allRoomTypes,
        bookingData: null,
        availability: buildAvailability(allRoomTypes, stay.rooms),
        quoteStatus: "NO_SELECTION",
        selectionIssues: [],
        removedRoomTypes: [],
    };

    let bookingId = null;
    let bookingStatus = null;
    let selectedRooms = [];

    if (hasDraft) {
        const matchesStay =
            draftBooking.accommodationId === accommodationId &&
            draftBooking.checkinDate === stay.checkinDate &&
            draftBooking.checkoutDate === stay.checkoutDate;

        if (!matchesStay) {
            return {
                ...data,
                quoteStatus: "DRAFT_MISMATCH",
                selectionIssues: [
                    {
                        code: "DRAFT_MISMATCH",
                        message: "Lựa chọn đã lưu thuộc cơ sở lưu trú hoặc kỳ lưu trú khác.",
                    },
                ],
            };
        }

        selectedRooms = draftBooking.selectedRooms ?? [];
    } else if (customerId) {
        const saved = await loadOpenBookingSelection(
            pool,
            customerId,
            accommodationId,
            stay
        );

        bookingId = saved.bookingId;
        bookingStatus = saved.bookingStatus;
        selectedRooms = saved.selectedRooms;
    }

    if (selectedRooms.length === 0) {
        return data;
    }

    const { validRooms, selectionIssues, removedRoomTypes } =
        reconcileSelectedRooms(selectedRooms, roomById);

    if (validRooms.length === 0) {
        return {
            ...data,
            quoteStatus: "INVALID_SELECTION",
            selectionIssues,
            removedRoomTypes,
        };
    }

    return {
        ...data,
        quoteStatus: "READY",
        selectionIssues,
        removedRoomTypes,
        bookingData: {
            bookingId,
            bookingStatus,
            accommodationId,
            checkinDate: stay.checkinDate,
            checkoutDate: stay.checkoutDate,
            totalNights: stay.totalNights,
            ...calculateQuote(accommodationId, validRooms, roomById, stay.totalNights),
        },
    };
}


function draftError(statusCode, errorCode, message, errorsDetail = {}) {
    return Object.assign(new Error(message), {
        statusCode,
        errorCode,
        errorsDetail,
    });
}

function createBookingCodeTimestamp(date) {
    const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    });

    const parts = Object.fromEntries(
        formatter.formatToParts(date).map(({ type, value }) => [type, value])
    );

    return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

function createBookingCodeSuffix() {
    const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let suffix = "";

    for (let index = 0; index < 12; index += 1) {
        suffix += alphabet[randomInt(alphabet.length)];
    }

    return suffix;
}

async function lockDraftCustomer(transaction, customerId) {
    const result = await new sqlObj.Request(transaction)
        .input("customerId", sqlObj.UniqueIdentifier, customerId)
        .query(`
            SELECT email
            FROM dbo.users WITH (UPDLOCK, HOLDLOCK)
            WHERE id = @customerId
              AND status = 1
              AND role = 'CUSTOMER';
        `);

    return result.recordset[0] ?? null;
}

async function persistPendingBooking(transaction, customerId, email, draft) {
    const { accommodationId, stay, quote } = draft;

    const totalAdults = quote.selectedRooms.reduce(
        (total, room) => total + room.adults,
        0
    );

    const totalChildren = quote.selectedRooms.reduce(
        (total, room) => total + room.children,
        0
    );

    const codeTimestamp = createBookingCodeTimestamp(new Date());
    const temporaryBookingCode = `TMP-${codeTimestamp}-${randomUUID()}`;
    const bookingCodeSuffix = createBookingCodeSuffix();

    const result = await new sqlObj.Request(transaction)
        .input("customerId", sqlObj.UniqueIdentifier, customerId)
        .input("temporaryBookingCode", sqlObj.VarChar(55), temporaryBookingCode)
        .input("codeTimestamp", sqlObj.VarChar(14), codeTimestamp)
        .input("bookingCodeSuffix", sqlObj.VarChar(12), bookingCodeSuffix)
        .input("contactEmail", sqlObj.VarChar(255), email)
        .input("accommodationId", sqlObj.Int, accommodationId)
        .input("checkin", sqlObj.VarChar(10), stay.checkinDate)
        .input("checkout", sqlObj.VarChar(10), stay.checkoutDate)
        .input("totalNights", sqlObj.Int, stay.totalNights)
        .input("totalRooms", sqlObj.Int, quote.selectedRooms.length)
        .input("totalAdults", sqlObj.Int, totalAdults)
        .input("totalChildren", sqlObj.Int, totalChildren)
        .input("roomsSubtotal", sqlObj.Decimal(18, 2), quote.roomsSubtotal)
        .input("extraGuestTotal", sqlObj.Decimal(18, 2), quote.extraGuestTotal)
        .input("roomDiscountTotal", sqlObj.Decimal(18, 2), quote.roomDiscountTotal)
        .input("discountAmount", sqlObj.Decimal(18, 2), quote.discountAmount)
        .input("taxAmount", sqlObj.Decimal(18, 2), quote.taxAmount)
        .input("totalAmount", sqlObj.Decimal(18, 2), quote.totalAmount)
        .query(`
            DECLARE @now datetime2 = SYSDATETIME();
            DECLARE @bookingId bigint;
            DECLARE @created bit = 0;

            UPDATE dbo.bookings
            SET status = 'EXPIRED', updated_at = @now
            WHERE user_id = @customerId
              AND status = 'PENDING'
              AND (pending_expires_at IS NULL OR pending_expires_at <= @now);

            SELECT TOP (1) @bookingId = id
            FROM dbo.bookings WITH (UPDLOCK, HOLDLOCK)
            WHERE user_id = @customerId
              AND status = 'PENDING'
              AND pending_expires_at > @now
            ORDER BY id DESC;

            IF @bookingId IS NULL
            BEGIN
                DECLARE @inserted TABLE (id bigint NOT NULL);

                INSERT INTO dbo.bookings (
                    booking_code,
                    user_id,
                    accommodation_id,
                    check_in_date,
                    check_out_date,
                    total_nights,
                    contact_name,
                    contact_email,
                    contact_phone,
                    total_rooms,
                    total_adults,
                    total_children,
                    rooms_subtotal,
                    extra_guest_total,
                    room_discount_total,
                    discount_amount,
                    tax_amount,
                    service_fee,
                    total_amount,
                    currency,
                    status,
                    pending_expires_at
                )
                OUTPUT inserted.id INTO @inserted(id)
                VALUES (
                    @temporaryBookingCode,
                    @customerId,
                    @accommodationId,
                    CONVERT(date, @checkin, 23),
                    CONVERT(date, @checkout, 23),
                    @totalNights,
                    N'',
                    @contactEmail,
                    '',
                    @totalRooms,
                    @totalAdults,
                    @totalChildren,
                    @roomsSubtotal,
                    @extraGuestTotal,
                    @roomDiscountTotal,
                    @discountAmount,
                    @taxAmount,
                    0,
                    @totalAmount,
                    'VND',
                    'PENDING',
                    DATEADD(minute, 30, @now)
                );

                SELECT @bookingId = id FROM @inserted;

                UPDATE dbo.bookings
                SET booking_code = CONCAT(
                    'VP-',
                    CONVERT(varchar(20), @bookingId),
                    '-',
                    @codeTimestamp,
                    '-',
                    @bookingCodeSuffix
                )
                WHERE id = @bookingId;

                SET @created = 1;
            END
            ELSE
            BEGIN
                DELETE nr
                FROM dbo.booking_item_nightly_rates AS nr
                JOIN dbo.booking_items AS bi
                    ON bi.id = nr.booking_item_id
                WHERE bi.booking_id = @bookingId;

                DELETE FROM dbo.booking_items
                WHERE booking_id = @bookingId;

                UPDATE dbo.bookings
                SET
                    accommodation_id = @accommodationId,
                    check_in_date = CONVERT(date, @checkin, 23),
                    check_out_date = CONVERT(date, @checkout, 23),
                    total_nights = @totalNights,
                    total_rooms = @totalRooms,
                    total_adults = @totalAdults,
                    total_children = @totalChildren,
                    rooms_subtotal = @roomsSubtotal,
                    extra_guest_total = @extraGuestTotal,
                    room_discount_total = @roomDiscountTotal,
                    discount_amount = @discountAmount,
                    tax_amount = @taxAmount,
                    service_fee = 0,
                    total_amount = @totalAmount,
                    updated_at = @now
                WHERE id = @bookingId;
            END;

            SELECT
                CONVERT(varchar(20), id) AS bookingId,
                booking_code AS bookingCode,
                status AS bookingStatus,
                DATEDIFF(second, @now, pending_expires_at) AS expiresInSeconds,
                @created AS created
            FROM dbo.bookings
            WHERE id = @bookingId;
        `);

    return result.recordset[0];
}

async function insertPendingBookingItem(transaction, bookingId, room, roomType) {
    await new sqlObj.Request(transaction)
        .input("bookingId", sqlObj.BigInt, bookingId)
        .input("roomTypeId", sqlObj.Int, room.roomTypeId)
        .input("roomTypeName", sqlObj.NVarChar(255), roomType.name)
        .input("adults", sqlObj.Int, room.adults)
        .input("children", sqlObj.Int, room.children)
        .input("includedAdults", sqlObj.Int, room.includedAdults)
        .input("includedChildren", sqlObj.Int, room.includedChildren)
        .input("basePrice", sqlObj.Decimal(18, 2), roomType.basePrice)
        .input("roomSubtotal", sqlObj.Decimal(18, 2), room.roomSubtotal)
        .input("extraAdultFee", sqlObj.Decimal(18, 2), room.extraAdultFeePerNight)
        .input("extraChildFee", sqlObj.Decimal(18, 2), room.extraChildFeePerNight)
        .input("extraAdultTotal", sqlObj.Decimal(18, 2), room.extraAdultTotal)
        .input("extraChildTotal", sqlObj.Decimal(18, 2), room.extraChildTotal)
        .input("discountAmount", sqlObj.Decimal(18, 2), room.discountAmount)
        .input("totalAmount", sqlObj.Decimal(18, 2), room.totalAmount)
        .input(
            "nightlyRates",
            sqlObj.NVarChar(sqlObj.MAX),
            JSON.stringify(room.nightlyRates)
        )
        .query(`
            DECLARE @inserted TABLE (id bigint NOT NULL);

            INSERT INTO dbo.booking_items (
                booking_id,
                room_type_id,
                room_type_name,
                adults,
                children,
                included_adults,
                included_children,
                base_price,
                room_subtotal,
                extra_adult_fee,
                extra_child_fee,
                extra_adult_total,
                extra_child_total,
                discount_amount,
                total_amount
            )
            OUTPUT inserted.id INTO @inserted(id)
            VALUES (
                @bookingId,
                @roomTypeId,
                @roomTypeName,
                @adults,
                @children,
                @includedAdults,
                @includedChildren,
                @basePrice,
                @roomSubtotal,
                @extraAdultFee,
                @extraChildFee,
                @extraAdultTotal,
                @extraChildTotal,
                @discountAmount,
                @totalAmount
            );

            INSERT INTO dbo.booking_item_nightly_rates (
                booking_item_id,
                stay_date,
                nightly_price
            )
            SELECT
                item.id,
                rate.stayDate,
                rate.price
            FROM @inserted AS item
            CROSS JOIN OPENJSON(@nightlyRates)
            WITH (
                stayDate date '$.stayDate',
                price decimal(18, 2) '$.price'
            ) AS rate;
        `);
}

async function savePendingBooking(draftBooking, customerId) {
    if (!customerId) {
        throw draftError(401, "UNAUTHENTICATED", "Vui lòng đăng nhập để đặt phòng.");
    }

    if (
        !draftBooking ||
        typeof draftBooking !== "object" ||
        Array.isArray(draftBooking)
    ) {
        throw badRequest("Body phải là một JSON object.");
    }

    const accommodationId = readAccommodationId(draftBooking.accommodationId);
    const stay = readStay(draftBooking);
    const { selectedRooms } = draftBooking;

    if (!Array.isArray(selectedRooms) || selectedRooms.length === 0) {
        throw badRequest("Vui lòng chọn ít nhất một phòng.");
    }

    const pool = await getDBPool();

    // loadRoomData() tiếp tục dùng pool.request() trước transaction.
    const recordsets = await loadRoomData(pool, accommodationId, stay);

    if (!recordsets) {
        throw draftError(
            404,
            "ACCOMMODATION_NOT_FOUND",
            "Không tìm thấy cơ sở lưu trú."
        );
    }

    const allRoomTypes = buildRoomTypes(recordsets, stay);
    const roomById = new Map(allRoomTypes.map(room => [room.id, room]));

    const { validRooms, selectionIssues, removedRoomTypes } =
        reconcileSelectedRooms(selectedRooms, roomById);

    if (validRooms.length !== selectedRooms.length) {
        throw draftError(
            409,
            "BOOKING_SELECTION_CHANGED",
            "Một số phòng đã chọn không còn hợp lệ. Vui lòng kiểm tra lại.",
            {
                availability: buildAvailability(allRoomTypes, selectedRooms.length),
                selectionIssues,
                removedRoomTypes,
            }
        );
    }

    const quote = calculateQuote(
        accommodationId,
        validRooms,
        roomById,
        stay.totalNights
    );

    const transaction = new sqlObj.Transaction(pool);
    await transaction.begin(sqlObj.ISOLATION_LEVEL.READ_COMMITTED);

    try {
        const customer = await lockDraftCustomer(transaction, customerId);

        if (!customer) {
            throw draftError(
                401,
                "UNAUTHENTICATED",
                "Tài khoản không còn phiên đăng nhập hợp lệ."
            );
        }

        const saved = await persistPendingBooking(
            transaction,
            customerId,
            customer.email,
            { accommodationId, stay, quote }
        );

        for (const room of quote.selectedRooms) {
            await insertPendingBookingItem(
                transaction,
                saved.bookingId,
                room,
                roomById.get(room.roomTypeId)
            );
        }

        await transaction.commit();

        return {
            ...saved,
            accommodationId,
            checkinDate: stay.checkinDate,
            checkoutDate: stay.checkoutDate,
            totalNights: stay.totalNights,
            ...quote,
        };
    } catch (error) {
        try {
            await transaction.rollback();
        } catch (rollbackError) {
            console.error("[booking-draft.rollback]", rollbackError);
        }

        throw error;
    }
}


async function getBookingDetail(bookingId, customerId) {
    if (!customerId) {
        throw Object.assign(
            new Error('Vui lòng đăng nhập để xem đặt phòng.'),
            { statusCode: 401, errorCode: 'LOGIN_REQUIRED' }
        );
    }

    const id = typeof bookingId === 'string'
        ? bookingId
        : Number.isSafeInteger(bookingId)
            ? String(bookingId)
            : '';

    if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
        throw Object.assign(
            new Error('Mã định danh đặt phòng không hợp lệ.'),
            { statusCode: 400, errorCode: 'INVALID_BOOKING_ID' }
        );
    }

    const pool = await getDBPool();

    const { recordset } = await pool.request()
        .input('bookingId', sqlObj.VarChar(19), id)
        .input('customerId', sqlObj.UniqueIdentifier, customerId)
        .query(`
            SELECT
                CONVERT(VARCHAR(19), b.id) AS id,
                b.booking_code AS bookingCode,
                b.status,
                b.accommodation_id AS accommodationId,
                a.accommodation_name AS accommodationName,
                a.address_line AS address,
                CONVERT(CHAR(10), b.check_in_date, 23) AS checkinDate,
                CONVERT(CHAR(10), b.check_out_date, 23) AS checkoutDate,
                b.total_nights AS nights,
                b.total_rooms AS numberOfRooms,
                b.total_adults AS totalAdults,
                b.total_children AS totalChildren,
                b.contact_name AS contactName,
                b.contact_email AS contactEmail,
                b.contact_phone AS contactPhone,
                b.is_booking_for_other AS isBookingForOther,
                b.guest_name AS guestName,
                b.guest_email AS guestEmail,
                b.guest_phone AS guestPhone,
                b.expected_arrival_time AS expectedArrivalTime,
                b.special_requests AS specialRequests,
                b.rooms_subtotal AS roomSubtotal,
                b.extra_guest_total AS extraGuestsSubtotal,
                b.room_discount_total AS roomDiscountTotal,
                b.discount_amount AS discountAmount,
                b.tax_amount AS taxAmount,
                b.service_fee AS serviceFee,
                b.total_amount AS totalAmount,
                b.currency,
                b.created_at AS createdAt,
                b.pending_expires_at AS pendingExpiresAt,
                b.confirmed_at AS confirmedAt,
                b.cancelled_at AS cancelledAt,
                b.cancellation_reason AS cancellationReason,
                b.failed_at AS failedAt,
                (
                    SELECT
                        CONVERT(VARCHAR(19), i.id) AS id,
                        i.room_type_id AS roomTypeId,
                        i.room_type_name AS roomName,
                        i.adults,
                        i.children,
                        i.included_adults AS includedAdults,
                        i.included_children AS includedChildren,
                        i.base_price AS basePrice,
                        i.room_subtotal AS roomStayPrice,
                        i.extra_adult_fee AS extraAdultFee,
                        i.extra_child_fee AS extraChildFee,
                        i.extra_adult_total AS extraAdultTotal,
                        i.extra_child_total AS extraChildTotal,
                        i.discount_amount AS discountAmount,
                        i.total_amount AS totalAmount,
                        JSON_QUERY((
                            SELECT
                                CONVERT(CHAR(10), n.stay_date, 23) AS stayDate,
                                n.nightly_price AS price
                            FROM dbo.booking_item_nightly_rates AS n
                            WHERE n.booking_item_id = i.id
                            ORDER BY n.stay_date
                            FOR JSON PATH
                        )) AS nightlyRates
                    FROM dbo.booking_items AS i
                    WHERE i.booking_id = b.id
                    ORDER BY i.id
                    FOR JSON PATH
                ) AS itemsJson
            FROM dbo.bookings AS b WITH (HOLDLOCK)
            LEFT JOIN dbo.accommodations AS a ON a.id = b.accommodation_id
            WHERE b.id = CONVERT(BIGINT, @bookingId)
              AND b.user_id = @customerId;
        `);

    const row = recordset[0];

    if (!row) {
        throw Object.assign(
            new Error('Không tìm thấy đơn đặt phòng.'),
            { statusCode: 404, errorCode: 'BOOKING_NOT_FOUND' }
        );
    }

    const { itemsJson, ...booking } = row;

    return {
        ...booking,
        items: JSON.parse(itemsJson || '[]').map(item => ({
            ...item,
            nightlyRates: item.nightlyRates ?? [],
        })),
    };
}


module.exports = {
    getBookingPreview,
    loadRoomData,
    buildRoomTypes,
    savePendingBooking,
    getBookingDetail,
    ...createBookingCheckout(reconcileSelectedRooms),
};

// T13: chỉnh sửa booking phía admin — đổi ngày nhận/trả (re-quote theo giá thật)
// và sửa thông tin liên hệ khách.
// Scope: ADMIN toàn hệ thống, MANAGER_ACCOMMODATION đúng accommodation (T03).
// Trạng thái cho phép sửa: PENDING / CONFIRMED (CANCELLED/EXPIRED/FAILED chặn).

const sql = require("mssql");
const db = require("../configs/database");
const { getAccommodationScope } = require("./accommodation_access_service");
const { ERROR_CODES } = require("../constants/error_codes");
const { loadRoomData, buildRoomTypes } = require("./booking_web_service");

const DAY_MS = 86_400_000;
const MAX_STAY_NIGHTS = 90;
const TAX_BPS = Number(process.env.BOOKING_TAX_BPS ?? 0);

class BookingUpdateError extends Error {
    constructor(message, statusCode = 400, errorCode = ERROR_CODES.VALIDATION_ERROR, errors = null) {
        super(message);
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.errors = errors;
    }
}

function toCents(value) {
    return Math.round(Number(value ?? 0) * 100);
}

function fromCents(value) {
    return Number((value / 100).toFixed(2));
}

function parsePositiveInt(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readDate(value, field) {
    if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) {
        throw new BookingUpdateError(`${field} phải có định dạng YYYY-MM-DD.`, 400, ERROR_CODES.VALIDATION_ERROR);
    }
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
        throw new BookingUpdateError(`${field} không phải ngày hợp lệ.`, 400, ERROR_CODES.VALIDATION_ERROR);
    }
    return timestamp;
}

function buildStayDates(checkinDate, checkoutDate) {
    const start = readDate(checkinDate, "checkinDate");
    const end = readDate(checkoutDate, "checkoutDate");
    const totalNights = (end - start) / DAY_MS;

    if (totalNights < 1 || totalNights > MAX_STAY_NIGHTS) {
        throw new BookingUpdateError(
            `Kỳ lưu trú phải từ 1 đến ${MAX_STAY_NIGHTS} đêm.`,
            400, ERROR_CODES.VALIDATION_ERROR,
        );
    }

    const nights = Array.from({ length: totalNights }, (_, index) => {
        const date = new Date(start + index * DAY_MS);
        return {
            stayDate: date.toISOString().slice(0, 10),
            dayOfWeek: date.getUTCDay() || 7,
        };
    });

    return { checkinDate, checkoutDate, totalNights, nights };
}

async function loadBookingScoped(pool, bookingId, currentUser) {
    const scope = getAccommodationScope(currentUser, "a");
    const request = pool.request().input("bookingId", sql.BigInt, bookingId);
    scope.inputs.forEach((input) => request.input(input.name, input.type, input.value));

    const result = await request.query(`
        SELECT b.id, b.booking_code, b.status, b.accommodation_id, b.discount_amount,
               b.check_in_date, b.check_out_date, b.total_nights, b.total_amount
        FROM dbo.bookings b
        JOIN dbo.accommodations a ON a.id = b.accommodation_id
        WHERE b.id = @bookingId
          AND ${scope.condition};
    `);

    const booking = result.recordset[0];
    if (!booking) {
        throw new BookingUpdateError("Không tìm thấy đặt phòng.", 404, ERROR_CODES.NOT_FOUND);
    }
    return booking;
}

function assertEditableStatus(status) {
    if (!["PENDING", "CONFIRMED"].includes(status)) {
        throw new BookingUpdateError(
            `Chỉ có thể sửa booking đang ở trạng thái PENDING hoặc CONFIRMED (hiện tại: ${status}).`,
            409, ERROR_CODES.INVALID_STATE,
        );
    }
}

async function writeAudit(pool, { actorType, actorUserId, action, resourceId, reason = null, detail = null }) {
    try {
        await pool.request()
            .input("actorType", sql.VarChar(30), actorType)
            .input("actorUserId", sql.UniqueIdentifier, actorUserId ?? null)
            .input("action", sql.VarChar(100), action)
            .input("resourceId", sql.BigInt, resourceId)
            .input("reason", sql.NVarChar(1000), reason)
            .input("detailJson", sql.NVarChar(sql.MAX), detail ? JSON.stringify(detail) : null)
            .query(`
                INSERT INTO dbo.audit_logs
                    (actor_type, actor_user_id, action, resource_type, resource_id, decision, reason, detail_json)
                VALUES
                    (@actorType, @actorUserId, @action, 'booking', @resourceId, 'ALLOW', @reason, @detailJson);
            `);
    } catch (error) {
        console.error("[booking_admin_update_service] audit failed:", error.message);
    }
}

// ---------- Đổi ngày nhận/trả (re-quote) ----------

async function updateBookingDates(bookingId, { checkinDate, checkoutDate }, currentUser) {
    const id = parsePositiveInt(bookingId);
    if (!id) {
        throw new BookingUpdateError("Mã đặt phòng không hợp lệ.");
    }
    const stay = buildStayDates(checkinDate, checkoutDate);

    const pool = db.getDBPool();
    const booking = await loadBookingScoped(pool, id, currentUser);
    assertEditableStatus(booking.status);

    // Booking items: mỗi item = 1 phòng (selectedRooms per-room của checkout)
    const itemsResult = await pool.request()
        .input("bookingId", sql.BigInt, id)
        .query(`
            SELECT id, room_type_id, adults, children, discount_amount
            FROM dbo.booking_items
            WHERE booking_id = @bookingId
            ORDER BY id;
        `);
    const items = itemsResult.recordset;
    if (!items.length) {
        throw new BookingUpdateError("Booking không có hạng phòng nào để tính lại.", 409, ERROR_CODES.INVALID_STATE);
    }

    // Giá theo kỳ lưu trú MỚI — dùng đúng pipeline preview (weekday + period)
    const recordsets = await loadRoomData(pool, booking.accommodation_id, stay, {
        includeActivePending: true,
    });
    if (!recordsets) {
        throw new BookingUpdateError(
            "Cơ sở lưu trú đang tạm ngừng bán hoặc không còn hoạt động — không thể đổi ngày.",
            409, ERROR_CODES.INVALID_STATE,
        );
    }
    const roomTypes = buildRoomTypes(recordsets, stay);
    const roomById = new Map(roomTypes.map((room) => [room.id, room]));

    // Số phòng cần theo hạng (mỗi item 1 phòng)
    const needCountByType = new Map();
    for (const item of items) {
        needCountByType.set(item.room_type_id, (needCountByType.get(item.room_type_id) ?? 0) + 1);
    }

    // Availability: availableQuantity đã tính booked trong cửa sổ mới.
    // Nếu cửa sổ CŨ overlap cửa sổ MỚI thì phòng của chính booking này bị tính
    // vào booked — hoàn lại vào available (chỉnh chính xác phần của mình).
    const oldStart = new Date(booking.check_in_date).toISOString().slice(0, 10);
    const oldEnd = new Date(booking.check_out_date).toISOString().slice(0, 10);
    const overlap = oldStart < stay.checkoutDate && stay.checkinDate < oldEnd;

    for (const [roomTypeId, needed] of needCountByType.entries()) {
        const room = roomById.get(roomTypeId);
        if (!room) {
            throw new BookingUpdateError(
                `Hạng phòng ${roomTypeId} không còn mở bán cho kỳ lưu trú mới.`,
                409, ERROR_CODES.INVALID_STATE,
            );
        }
        const effectiveAvailable = room.availableQuantity + (overlap ? (needCountByType.get(roomTypeId) ?? 0) : 0);
        if (needed > effectiveAvailable) {
            throw new BookingUpdateError(
                `${room.name} chỉ còn ${room.availableQuantity} phòng trống cho kỳ lưu trú mới — không thể đổi ngày.`,
                409, "ROOM_TYPE_SOLD_OUT",
            );
        }
    }

    // Re-quote từng item (mỗi item 1 phòng)
    const quotedItems = items.map((item) => {
        const room = roomById.get(item.room_type_id);
        const subtotalCents = room.nightlyRates.reduce(
            (sum, rate) => sum + toCents(rate.price), 0,
        );
        const extraAdultTotal = Math.max(0, item.adults - room.includedAdults)
            * toCents(room.extraAdultFeePerNight) * stay.totalNights;
        const extraChildTotal = Math.max(0, item.children - room.includedChildren)
            * toCents(room.extraChildFeePerNight) * stay.totalNights;
        const discountCents = toCents(item.discount_amount);

        return {
            itemId: item.id,
            roomTypeId: item.room_type_id,
            roomSubtotal: fromCents(subtotalCents),
            extraAdultTotal: fromCents(extraAdultTotal),
            extraChildTotal: fromCents(extraChildTotal),
            discountAmount: fromCents(discountCents),
            totalAmount: fromCents(subtotalCents + extraAdultTotal + extraChildTotal - discountCents),
            nightlyRates: room.nightlyRates,
        };
    });

    const roomsSubtotal = quotedItems.reduce((sum, item) => sum + toCents(item.roomSubtotal), 0);
    const extraGuestTotal = quotedItems.reduce(
        (sum, item) => sum + toCents(item.extraAdultTotal) + toCents(item.extraChildTotal), 0,
    );
    const roomDiscountTotal = quotedItems.reduce((sum, item) => sum + toCents(item.discountAmount), 0);
    const discountAmount = toCents(booking.discount_amount);
    // Giữ công thức khớp calculateQuote (discount hiện tại luôn 0); nếu có discount
    // thì trừ trước tính thuế như lưu trong booking.
    const taxable = roomsSubtotal + extraGuestTotal - roomDiscountTotal - discountAmount;
    const taxAmount = Math.round(taxable * TAX_BPS / 10000);
    const totalAmount = taxable + taxAmount;

    // Booking CONFIRMED = đã thanh toán: tổng tiền là bất biến. Kỳ mới làm
    // thay đổi tổng tiền thì từ chối (chỉ chấp nhận kỳ có giá khớp số đã thu).
    if (booking.status === "CONFIRMED") {
        const paidTotalCents = toCents(booking.total_amount);
        if (totalAmount !== paidTotalCents) {
            throw new BookingUpdateError(
                "Đơn đã thanh toán, không thể thay đổi ngày nhận phòng.",
                409, "BOOKING_TOTAL_MISMATCH",
            );
        }
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
        // 1. Cập nhật booking
        await new sql.Request(transaction)
            .input("bookingId", sql.BigInt, id)
            .input("checkin", sql.VarChar(10), stay.checkinDate)
            .input("checkout", sql.VarChar(10), stay.checkoutDate)
            .input("totalNights", sql.Int, stay.totalNights)
            .input("roomsSubtotal", sql.Decimal(18, 2), fromCents(roomsSubtotal))
            .input("extraGuestTotal", sql.Decimal(18, 2), fromCents(extraGuestTotal))
            .input("roomDiscountTotal", sql.Decimal(18, 2), fromCents(roomDiscountTotal))
            .input("taxAmount", sql.Decimal(18, 2), fromCents(taxAmount))
            .input("totalAmount", sql.Decimal(18, 2), fromCents(totalAmount))
            .query(`
                UPDATE dbo.bookings
                SET check_in_date = CONVERT(date, @checkin, 23),
                    check_out_date = CONVERT(date, @checkout, 23),
                    total_nights = @totalNights,
                    rooms_subtotal = @roomsSubtotal,
                    extra_guest_total = @extraGuestTotal,
                    room_discount_total = @roomDiscountTotal,
                    tax_amount = @taxAmount,
                    total_amount = @totalAmount,
                    updated_at = SYSDATETIME()
                WHERE id = @bookingId;
            `);

        // 2. Cập nhật từng item + ghi lại giá đêm
        for (const item of quotedItems) {
            await new sql.Request(transaction)
                .input("itemId", sql.BigInt, item.itemId)
                .input("roomSubtotal", sql.Decimal(18, 2), item.roomSubtotal)
                .input("extraAdultTotal", sql.Decimal(18, 2), item.extraAdultTotal)
                .input("extraChildTotal", sql.Decimal(18, 2), item.extraChildTotal)
                .input("totalAmount", sql.Decimal(18, 2), item.totalAmount)
                .input("nightlyRates", sql.NVarChar(sql.MAX), JSON.stringify(item.nightlyRates))
                .query(`
                    UPDATE dbo.booking_items
                    SET room_subtotal = @roomSubtotal,
                        extra_adult_total = @extraAdultTotal,
                        extra_child_total = @extraChildTotal,
                        total_amount = @totalAmount,
                        updated_at = SYSDATETIME()
                    WHERE id = @itemId;

                    DELETE FROM dbo.booking_item_nightly_rates WHERE booking_item_id = @itemId;

                    INSERT INTO dbo.booking_item_nightly_rates (booking_item_id, stay_date, nightly_price)
                    SELECT @itemId, rate.stayDate, rate.price
                    FROM OPENJSON(@nightlyRates)
                    WITH (stayDate date '$.stayDate', price decimal(18, 2) '$.price') AS rate;
                `);
        }

        await transaction.commit();
    } catch (error) {
        await transaction.rollback().catch(() => {});
        throw new BookingUpdateError(
            `Không thể cập nhật booking: ${error.message}`,
            500, ERROR_CODES.INTERNAL_ERROR,
        );
    }

    const pool2 = db.getDBPool();
    await writeAudit(pool2, {
        actorType: currentUser.role === "ADMIN" ? "ADMIN" : "ACCOMMODATION_MANAGER",
        actorUserId: currentUser.id,
        action: "booking.dates_updated",
        resourceId: id,
        detail: {
            booking_code: booking.booking_code,
            old: { checkin: oldStart, checkout: oldEnd },
            new: { checkin: stay.checkinDate, checkout: stay.checkoutDate, nights: stay.totalNights },
            newTotals: { roomsSubtotal: fromCents(roomsSubtotal), extraGuestTotal: fromCents(extraGuestTotal), taxAmount: fromCents(taxAmount), totalAmount: fromCents(totalAmount) },
        },
    });

    return {
        id,
        code: booking.booking_code,
        dates: { checkinDate: stay.checkinDate, checkoutDate: stay.checkoutDate, totalNights: stay.totalNights },
        totals: {
            roomsSubtotal: fromCents(roomsSubtotal),
            extraGuestTotal: fromCents(extraGuestTotal),
            roomDiscountTotal: fromCents(roomDiscountTotal),
            taxAmount: fromCents(taxAmount),
            totalAmount: fromCents(totalAmount),
        },
        items: quotedItems.map(({ itemId, roomSubtotal, totalAmount }) => ({ itemId, roomSubtotal, totalAmount })),
    };
}

// ---------- Sửa thông tin liên hệ ----------

async function updateBookingContact(bookingId, { contactName, contactEmail, contactPhone }, currentUser) {
    const id = parsePositiveInt(bookingId);
    if (!id) {
        throw new BookingUpdateError("Mã đặt phòng không hợp lệ.");
    }

    const name = typeof contactName === "string" ? contactName.trim() : "";
    const email = typeof contactEmail === "string" ? contactEmail.trim() : "";
    const phone = typeof contactPhone === "string" ? contactPhone.trim() : "";

    const errors = {};
    if (!name || name.length > 255) errors.contactName = "Họ tên liên hệ bắt buộc, tối đa 255 ký tự.";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) {
        errors.contactEmail = "Email không hợp lệ.";
    }
    if (!phone || phone.length > 30) errors.contactPhone = "Số điện thoại bắt buộc, tối đa 30 ký tự.";
    if (Object.keys(errors).length) {
        throw new BookingUpdateError("Thông tin liên hệ chưa hợp lệ.", 400, ERROR_CODES.VALIDATION_ERROR, errors);
    }

    const pool = db.getDBPool();
    const booking = await loadBookingScoped(pool, id, currentUser);
    assertEditableStatus(booking.status);

    await pool.request()
        .input("bookingId", sql.BigInt, id)
        .input("contactName", sql.NVarChar(255), name)
        .input("contactEmail", sql.VarChar(255), email)
        .input("contactPhone", sql.VarChar(30), phone)
        .query(`
            UPDATE dbo.bookings
            SET contact_name = @contactName,
                contact_email = @contactEmail,
                contact_phone = @contactPhone,
                updated_at = SYSDATETIME()
            WHERE id = @bookingId;
        `);

    await writeAudit(pool, {
        actorType: currentUser.role === "ADMIN" ? "ADMIN" : "ACCOMMODATION_MANAGER",
        actorUserId: currentUser.id,
        action: "booking.contact_updated",
        resourceId: id,
        detail: { booking_code: booking.booking_code, contactName: name, contactEmail: email, contactPhone: phone },
    });

    return { id, code: booking.booking_code, contact: { name, email, phone } };
}

module.exports = { updateBookingDates, updateBookingContact };

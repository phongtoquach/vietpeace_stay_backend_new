const { createHash, createHmac, randomBytes } = require("node:crypto");
const { sqlObj: sql, getDBPool } = require("../configs/database");
const { getCustomerDataById } = require("./auth_service");

const PAYMENT_MINUTES = 15;
const MAX_BIGINT = 9223372036854775807n;
const NOT_FOUND = "Không tìm thấy thông tin đặt phòng cần thanh toán.";

function checkoutError(statusCode, errorCode, message, errors = {}) {
    return Object.assign(new Error(message), {
        statusCode,
        errorCode,
        errors,
    });
}

function validateBookingId(value) {
    const id = typeof value === "string"
        ? value
        : Number.isSafeInteger(value) ? String(value) : "";

    if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > MAX_BIGINT) {
        throw checkoutError(400, "INVALID_BOOKING_ID", NOT_FOUND);
    }

    return id;
}

function validateCustomer(customerId) {
    if (!customerId) {
        throw checkoutError(401, "LOGIN_REQUIRED", "Vui lòng đăng nhập để thanh toán.");
    }
}

async function withTransaction(work) {
    const transaction = new sql.Transaction(await getDBPool());
    await transaction.begin();

    try {
        const result = await work(transaction);
        await transaction.commit();
        return result;
    } catch (error) {
        try {
            await transaction.rollback();
        } catch (rollbackError) {
            if (!["EABORT", "ENOTBEG"].includes(rollbackError.code)) {
                console.error("[checkout rollback]", rollbackError);
            }
        }

        throw error;
    }
}

function bookingRequest(transaction, bookingId) {
    // Bind chuỗi rồi convert trong SQL để giữ chính xác toàn bộ miền BIGINT.
    return new sql.Request(transaction).input("bookingId", sql.VarChar(19), bookingId);
}

async function loadBooking(transaction, bookingId, customerId) {
    const { recordset } = await bookingRequest(transaction, bookingId)
        .input("customerId", sql.UniqueIdentifier, customerId)
        .query(`
            SELECT b.*, CONVERT(VARCHAR(19), b.id) AS checkout_id,
                   CONVERT(VARCHAR(30), b.total_amount) AS amount_text,
                   CONVERT(CHAR(10), b.check_in_date, 23) AS checkin_date_text,
                   CONVERT(CHAR(10), b.check_out_date, 23) AS checkout_date_text,
                   CASE WHEN b.pending_expires_at > SYSDATETIME() THEN 1 ELSE 0 END AS pending_open,
                   CASE WHEN b.check_in_date >= CONVERT(DATE, DATEADD(HOUR, 7, SYSUTCDATETIME()))
                        THEN 1 ELSE 0 END AS dates_open,
                   a.accommodation_name, a.address_line, a.status AS accommodation_status,
                   a.deleted_at AS accommodation_deleted_at
            FROM dbo.bookings b WITH (UPDLOCK, HOLDLOCK)
            JOIN dbo.accommodations a ON a.id = b.accommodation_id
            WHERE b.id = CONVERT(BIGINT, @bookingId) AND b.user_id = @customerId;
        `);

    if (!recordset[0]) {
        throw checkoutError(404, "BOOKING_NOT_FOUND", NOT_FOUND);
    }

    return recordset[0];
}

async function loadProcessingPayment(transaction, bookingId) {
    const { recordset } = await bookingRequest(transaction, bookingId).query(`
        SELECT payment_method, provider_order_id, currency,
               CONVERT(VARCHAR(30), amount) AS amount_text,
               CASE WHEN expires_at > SYSDATETIME() THEN 1 ELSE 0 END AS is_open,
               CONVERT(CHAR(8), DATEADD(MINUTE,
                   420 - DATEPART(TZOFFSET, SYSDATETIMEOFFSET()), processing_at), 112)
               + REPLACE(CONVERT(CHAR(8), DATEADD(MINUTE,
                   420 - DATEPART(TZOFFSET, SYSDATETIMEOFFSET()), processing_at), 108), ':', '') AS vnp_created,
               CONVERT(CHAR(8), DATEADD(MINUTE,
                   420 - DATEPART(TZOFFSET, SYSDATETIMEOFFSET()), expires_at), 112)
               + REPLACE(CONVERT(CHAR(8), DATEADD(MINUTE,
                   420 - DATEPART(TZOFFSET, SYSDATETIMEOFFSET()), expires_at), 108), ':', '') AS vnp_expires
        FROM dbo.payments WITH (UPDLOCK, HOLDLOCK)
        WHERE booking_id = CONVERT(BIGINT, @bookingId) AND status = 'PROCESSING';
    `);

    if (recordset.length > 1) {
        throw new Error("Booking has multiple PROCESSING payments.");
    }

    return recordset[0];
}

async function loadItems(transaction, bookingId) {
    const { recordsets } = await bookingRequest(transaction, bookingId).query(`
        SELECT CONVERT(VARCHAR(19), i.id) AS item_id,
               i.room_type_id, i.room_type_name, i.adults, i.children,
               i.included_adults, i.included_children, i.room_subtotal,
               i.extra_adult_fee, i.extra_child_fee, i.extra_adult_total,
               i.extra_child_total, i.discount_amount, i.total_amount,
               r.max_adults, r.max_children, r.max_occupancy
        FROM dbo.booking_items i
        JOIN dbo.bookings b ON b.id = i.booking_id
        LEFT JOIN dbo.room_types r ON r.id = i.room_type_id
            AND r.accommodation_id = b.accommodation_id
            AND r.status = 1
            AND r.deleted_at IS NULL
        WHERE i.booking_id = CONVERT(BIGINT, @bookingId)
        ORDER BY i.id;

        SELECT CONVERT(VARCHAR(19), n.booking_item_id) AS item_id,
               CONVERT(CHAR(10), n.stay_date, 23) AS stay_date, n.nightly_price
        FROM dbo.booking_item_nightly_rates n
        JOIN dbo.booking_items i ON i.id = n.booking_item_id
        WHERE i.booking_id = CONVERT(BIGINT, @bookingId)
        ORDER BY n.booking_item_id, n.stay_date;
    `);

    const rates = new Map();

    for (const row of recordsets[1]) {
        if (!rates.has(row.item_id)) {
            rates.set(row.item_id, []);
        }

        rates.get(row.item_id).push({
            stayDate: row.stay_date,
            price: Number(row.nightly_price),
        });
    }

    return recordsets[0].map(row => ({
        ...row,
        nightlyRates: rates.get(row.item_id) || [],
    }));
}

async function loadRoomAvailability(transaction, bookingId) {
    const { recordset } = await bookingRequest(transaction, bookingId).query(`
        ;WITH target AS (
            SELECT id, accommodation_id, check_in_date, check_out_date
            FROM dbo.bookings
            WHERE id = CONVERT(BIGINT, @bookingId)
        ), requested AS (
            SELECT i.room_type_id, COUNT(*) AS requested_rooms
            FROM dbo.booking_items i
            JOIN target t ON t.id = i.booking_id
            GROUP BY i.room_type_id
        ), overlaps AS (
            SELECT i.room_type_id,
                   CASE WHEN b.check_in_date < t.check_in_date
                        THEN t.check_in_date ELSE b.check_in_date END AS start_date,
                   CASE WHEN b.check_out_date > t.check_out_date
                        THEN t.check_out_date ELSE b.check_out_date END AS end_date
            FROM target t
            JOIN dbo.bookings b ON b.accommodation_id = t.accommodation_id
                AND b.status = 'CONFIRMED'
                AND b.id <> t.id
                AND b.check_in_date < t.check_out_date
                AND b.check_out_date > t.check_in_date
            JOIN dbo.booking_items i ON i.booking_id = b.id
            JOIN requested q ON q.room_type_id = i.room_type_id
        ), events AS (
            SELECT room_type_id, start_date AS stay_date, CONVERT(BIGINT, 1) AS delta
            FROM overlaps
            UNION ALL
            SELECT room_type_id, end_date, CONVERT(BIGINT, -1)
            FROM overlaps
        ), daily_events AS (
            SELECT room_type_id, stay_date, SUM(delta) AS delta
            FROM events
            GROUP BY room_type_id, stay_date
        ), occupied AS (
            SELECT room_type_id, SUM(delta) OVER (
                PARTITION BY room_type_id
                ORDER BY stay_date ROWS UNBOUNDED PRECEDING
            ) AS booked
            FROM daily_events
        ), peak AS (
            SELECT room_type_id, MAX(booked) AS max_booked
            FROM occupied
            GROUP BY room_type_id
        )
        SELECT q.room_type_id, q.requested_rooms,
               CASE WHEN r.quantity > COALESCE(p.max_booked, 0)
                    THEN r.quantity - COALESCE(p.max_booked, 0)
                    ELSE 0 END AS available_rooms
        FROM requested q
        CROSS JOIN target t
        LEFT JOIN dbo.room_types r ON r.id = q.room_type_id
            AND r.accommodation_id = t.accommodation_id
            AND r.status = 1
            AND r.deleted_at IS NULL
        LEFT JOIN peak p ON p.room_type_id = q.room_type_id;
    `);

    return recordset.map(row => ({
        roomTypeId: row.room_type_id,
        requestedRooms: row.requested_rooms,
        availableRooms: Number(row.available_rooms),
    }));
}

function blocked(state, message, extra = {}) {
    return {
        state,
        message,
        isValid: false,
        isAvailable: null,
        canPay: false,
        ...extra,
    };
}

function serializeBooking(booking, items) {
    return {
        id: booking.checkout_id,
        status: booking.status,
        bookingCode: booking.booking_code,
        accommodationId: booking.accommodation_id,
        accommodationName: booking.accommodation_name,
        address: booking.address_line,
        checkinDate: booking.checkin_date_text,
        checkoutDate: booking.checkout_date_text,
        nights: booking.total_nights,
        numberOfRooms: booking.total_rooms,
        totalAdults: booking.total_adults,
        totalChildren: booking.total_children,
        contactName: booking.contact_name?.trim() || "",
        contactEmail: booking.contact_email?.trim() || "",
        contactPhone: booking.contact_phone?.trim() || "",
        guestName: booking.guest_name,
        guestEmail: booking.guest_email,
        guestPhone: booking.guest_phone,
        expectedArrivalTime: booking.expected_arrival_time,
        specialRequests: booking.special_requests,
        roomSubtotal: Number(booking.rooms_subtotal),
        extraGuestsSubtotal: Number(booking.extra_guest_total),
        roomDiscountTotal: Number(booking.room_discount_total),
        discountAmount: Number(booking.discount_amount),
        taxAmount: Number(booking.tax_amount),
        serviceFee: Number(booking.service_fee),
        totalAmount: Number(booking.total_amount),
        currency: booking.currency,
        items: items.map(item => ({
            id: item.item_id,
            roomTypeId: item.room_type_id,
            roomName: item.room_type_name,
            adults: item.adults,
            children: item.children,
            includedAdults: item.included_adults,
            includedChildren: item.included_children,
            roomStayPrice: Number(item.room_subtotal),
            extraAdultFee: Number(item.extra_adult_fee),
            extraChildFee: Number(item.extra_child_fee),
            extraAdultTotal: Number(item.extra_adult_total),
            extraChildTotal: Number(item.extra_child_total),
            discountAmount: Number(item.discount_amount),
            totalAmount: Number(item.total_amount),
            nightlyRates: item.nightlyRates,
        })),
    };
}


async function checkStoredBookingRooms(
    transaction,
    bookingId,
    bookingRow,
    reconcileSelectedRooms
) {
    const items = await loadItems(transaction, bookingId);
    const roomAvailability = await loadRoomAvailability(transaction, bookingId);

    const availableByType = new Map(
        roomAvailability.map(room => [
            room.roomTypeId,
            room.availableRooms,
        ])
    );

    const roomById = new Map();

    const selectedRooms = items.map(item => {
        if (item.max_occupancy != null && !roomById.has(item.room_type_id)) {
            roomById.set(item.room_type_id, {
                name: item.room_type_name,
                maxAdults: item.max_adults,
                maxChildren: item.max_children,
                maxOccupancy: item.max_occupancy,
                availableQuantity: availableByType.get(item.room_type_id) ?? 0,
            });
        }

        return {
            roomTypeId: item.room_type_id,
            adults: item.adults,
            children: item.children,
        };
    });

    const { validRooms } = reconcileSelectedRooms(selectedRooms, roomById);

    const totalAdults = items.reduce((sum, item) => sum + item.adults, 0);
    const totalChildren = items.reduce((sum, item) => sum + item.children, 0);

    const roomsValid =
        items.length > 0 &&
        items.length === bookingRow.total_rooms &&
        totalAdults === bookingRow.total_adults &&
        totalChildren === bookingRow.total_children &&
        validRooms.length === items.length;

    return { items, roomAvailability, roomsValid };
}


async function inspectCheckout(transaction, bookingId, customerId, reconcileSelectedRooms) {
    const row = await loadBooking(transaction, bookingId, customerId);

    if (!["PENDING", "PAYMENT_PROCESSING"].includes(row.status)) {
        return {
            view: blocked("INVALID_STATUS", "Đơn đặt phòng này không thể thanh toán."),
        };
    }

    if (row.status === "PENDING" && !row.pending_open) {
        return {
            view: blocked(
                "BOOKING_EXPIRED",
                "Đơn đặt phòng đã hết hạn. Vui lòng chọn phòng lại."
            ),
        };
    }

    const payment = await loadProcessingPayment(transaction, bookingId);
    const processing = row.status === "PAYMENT_PROCESSING";

    const awaitingResult = processing && (
        !payment?.is_open ||
        payment.payment_method !== "VNPAY" ||
        !payment.provider_order_id ||
        !payment.vnp_created ||
        !payment.vnp_expires ||
        payment.amount_text !== row.amount_text ||
        payment.currency !== row.currency
    );

    const items = await loadItems(transaction, bookingId);
    const roomAvailability = await loadRoomAvailability(transaction, bookingId);

    const availableByType = new Map(
        roomAvailability.map(room => [room.roomTypeId, room.availableRooms])
    );

    const roomById = new Map();

    const selectedRooms = items.map(item => {
        if (item.max_occupancy != null && !roomById.has(item.room_type_id)) {
            roomById.set(item.room_type_id, {
                name: item.room_type_name,
                maxAdults: item.max_adults,
                maxChildren: item.max_children,
                maxOccupancy: item.max_occupancy,
                availableQuantity: availableByType.get(item.room_type_id) ?? 0,
            });
        }

        return {
            roomTypeId: item.room_type_id,
            adults: item.adults,
            children: item.children,
        };
    });

    const { validRooms } = reconcileSelectedRooms(selectedRooms, roomById);

    const isAvailable = Boolean(
        row.dates_open &&
        row.accommodation_status === 1 &&
        !row.accommodation_deleted_at &&
        items.length > 0 &&
        items.length === row.total_rooms &&
        validRooms.length === items.length
    );

    const booking = serializeBooking(row, items);

    if (awaitingResult || (!processing && payment)) {
        const message = payment && !payment.is_open
            ? "Phiên thanh toán đã hết hạn. Hệ thống đang kiểm tra kết quả giao dịch."
            : "Hệ thống đang kiểm tra kết quả giao dịch.";

        return {
            view: blocked("PAYMENT_RECONCILING", message, {
                booking,
                isValid: true,
                isAvailable,
                roomAvailability,
            }),
        };
    }

    if (!isAvailable) {
        return {
            view: blocked(
                "ROOMS_UNAVAILABLE",
                "Đơn đặt phòng không còn đáp ứng điều kiện lưu trú. Vui lòng kiểm tra lại lựa chọn.",
                { booking, isValid: true, isAvailable, roomAvailability }
            ),
        };
    }

    const state = processing ? "RESUME_PAYMENT" : "READY";
    const bookingVersion = createHash("sha256")
        .update(JSON.stringify(booking))
        .digest("hex");

    return {
        row,
        payment,
        view: {
            state,
            isValid: true,
            isAvailable,
            canPay: true,
            bookingVersion,
            booking,
            roomAvailability,
        },
    };
}

async function getBookingCheckout(reconcileSelectedRooms, bookingId, customerId) {
    const id = validateBookingId(bookingId);
    validateCustomer(customerId);

    const { view } = await withTransaction(transaction =>
        inspectCheckout(transaction, id, customerId, reconcileSelectedRooms)
    );

    const booking = view.booking;

    if (booking && (!booking.contactName || !booking.contactEmail || !booking.contactPhone)) {
        const result = await getCustomerDataById(customerId);
        const customer = result?.success ? result.data?.customer : null;

        if (customer) {
            booking.contactName ||= customer.full_name?.trim() || "";
            booking.contactEmail ||= customer.email?.trim() || "";
            booking.contactPhone ||= customer.phone_number?.trim() || "";
        }
    }

    return view;
}

const ARRIVAL_WINDOWS = new Set(Array.from({ length: 24 }, (_, hour) => {
    const time = h => String(h).padStart(2, "0") + ":00";
    return time(hour) + " - " + time((hour + 1) % 24);
}));

function validateCheckoutForm(body) {
    const errors = {};
    const fields = {};

    console.log("[validateCheckoutForm] Data cua body : ", body);

    const phone = value => /^\+?[0-9\s().-]{7,25}$/.test(value) &&
        (value.match(/\d/g) || []).length >= 7 &&
        (value.match(/\d/g) || []).length <= 16;

    const email = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

    function field(key, limit, required = false, valid = () => true) {
        const raw = body[key];
        const value = typeof raw === "string" ? raw.trim() : "";

        if (
            (raw != null && typeof raw !== "string") ||
            value.length > limit ||
            (required && !value) ||
            (value && !valid(value))
        ) {
            errors[key] = "Vui lòng kiểm tra lại thông tin này.";
        }

        fields[key] = value || null;
    }

    field("contact_name", 255, true);
    field("contact_email", 255, true, email);
    field("contact_phone", 30, true, phone);

    if (typeof body.is_booking_for_other !== "boolean") {
        errors.is_booking_for_other = "Vui lòng chọn người đại diện nhận phòng.";
    }
    else {
        fields.is_booking_for_other = body.is_booking_for_other;
    }

    if (body.is_booking_for_other === true) {
        field("guest_name", 255, true);
        field("guest_phone", 30, true, phone);
        field("guest_email", 255, false, email);
    } else {
        fields.guest_name = null;
        fields.guest_phone = null;
        fields.guest_email = null;
    }

    field("special_requests", 2000);
    field("expected_arrival_time", 30, false, value => ARRIVAL_WINDOWS.has(value));

    if (body.terms_accepted !== true) {
        errors.terms_accepted = "Vui lòng đồng ý điều khoản đặt phòng.";
    }

    if (Object.keys(errors).length) {
        throw checkoutError(
            400,
            "INVALID_CHECKOUT_FORM",
            "Vui lòng kiểm tra lại thông tin thanh toán.",
            errors
        );
    }

    console.log("[validateCheckoutForm] Data cua fields : ", fields);

    return fields;
}

function buildVnpayUrl(payment, bookingId, ipAddress) {
    const {
        VNPAY_PAYMENT_URL,
        VNPAY_RETURN_URL,
        VNPAY_TMN_CODE,
        VNPAY_HASH_SECRET,
    } = process.env;

    if (!VNPAY_PAYMENT_URL || !VNPAY_RETURN_URL || !VNPAY_TMN_CODE || !VNPAY_HASH_SECRET) {
        throw new Error("Missing VNPay configuration.");
    }

    const url = new URL(VNPAY_PAYMENT_URL);

    if (url.protocol !== "https:" || url.search || url.hash) {
        throw new Error("Invalid VNPAY_PAYMENT_URL.");
    }

    const amount = /^(\d+)\.00$/.exec(payment.amount_text);

    if (!amount || BigInt(amount[1]) <= 0n || payment.currency !== "VND") {
        throw checkoutError(
            409,
            "INVALID_PAYMENT_AMOUNT",
            "Số tiền thanh toán VNPay không hợp lệ."
        );
    }

    const params = {
        vnp_Version: "2.1.0",
        vnp_Command: "pay",
        vnp_TmnCode: VNPAY_TMN_CODE,
        vnp_Amount: String(BigInt(amount[1]) * 100n),
        vnp_CurrCode: "VND",
        vnp_TxnRef: payment.provider_order_id,
        vnp_OrderInfo: "Thanh toan dat phong " + bookingId,
        vnp_OrderType: "other",
        vnp_Locale: "vn",
        vnp_ReturnUrl: VNPAY_RETURN_URL,
        vnp_IpAddr: (ipAddress || "127.0.0.1")
            .replace(/^::ffff:/, "")
            .replace(/^::1$/, "127.0.0.1"),
        vnp_CreateDate: payment.vnp_created,
        vnp_ExpireDate: payment.vnp_expires,
    };

    const encode = value => encodeURIComponent(value).replace(/%20/g, "+");

    const query = Object.keys(params)
        .sort()
        .map(key => encode(key) + "=" + encode(params[key]))
        .join("&");

    const signature = createHmac("sha512", VNPAY_HASH_SECRET)
        .update(query, "utf8")
        .digest("hex");

    return url.toString() + "?" + query + "&vnp_SecureHash=" + signature;
}

async function createProcessingPayment(transaction, bookingId, form) {
    const request = bookingRequest(transaction, bookingId)
        .input("paymentCode", sql.VarChar(150), "PAY-" + randomBytes(16).toString("hex"))
        .input("paymentCodeSuffix", sql.VarChar(16), randomBytes(8).toString("hex").toUpperCase())
        .input("suffix", sql.VarChar(12), randomBytes(6).toString("hex").toUpperCase())
        .input("minutes", sql.Int, PAYMENT_MINUTES)
        .input("contactName", sql.NVarChar(255), form.contact_name)
        .input("contactEmail", sql.VarChar(255), form.contact_email)
        .input("contactPhone", sql.VarChar(30), form.contact_phone)
        .input("isBookingForOther", sql.Bit, form.is_booking_for_other)
        .input("guestName", sql.NVarChar(255), form.guest_name)
        .input("guestEmail", sql.VarChar(255), form.guest_email)
        .input("guestPhone", sql.VarChar(30), form.guest_phone)
        .input("arrivalTime", sql.VarChar(30), form.expected_arrival_time)
        .input("specialRequests", sql.NVarChar(2000), form.special_requests);

    const { recordset } = await request.query(`
        DECLARE @now DATETIME2 = SYSDATETIME();
        DECLARE @vnNow DATETIME2 = DATEADD(
            MINUTE, 420 - DATEPART(TZOFFSET, SYSDATETIMEOFFSET()), @now
        );
        DECLARE @stamp CHAR(14) = CONVERT(CHAR(8), @vnNow, 112)
            + REPLACE(CONVERT(CHAR(8), @vnNow, 108), ':', '');

        UPDATE dbo.bookings SET
            contact_name = @contactName,
            contact_email = @contactEmail,
            contact_phone = @contactPhone,
            is_booking_for_other = @isBookingForOther,
            guest_name = @guestName,
            guest_email = @guestEmail,
            guest_phone = @guestPhone,
            expected_arrival_time = @arrivalTime,
            special_requests = @specialRequests,
            status = 'PAYMENT_PROCESSING',
            payment_processing_at = @now,
            updated_at = @now
        WHERE id = CONVERT(BIGINT, @bookingId)
          AND status = 'PENDING'
          AND pending_expires_at > @now;

        IF @@ROWCOUNT = 0 RETURN;

        DECLARE @inserted TABLE (id BIGINT NOT NULL);

        INSERT dbo.payments (
            booking_id, payment_code, payment_method, amount,
            currency, status, processing_at, expires_at
        )
        OUTPUT inserted.id INTO @inserted
        SELECT id, @paymentCode, 'VNPAY', total_amount, currency, 'PROCESSING',
               @now, DATEADD(MINUTE, @minutes, @now)
        FROM dbo.bookings
        WHERE id = CONVERT(BIGINT, @bookingId);

        UPDATE p
        SET payment_code = CONCAT('PAY-', CONVERT(VARCHAR(19), p.id), '-', @paymentCodeSuffix),
            provider_order_id = CONCAT('VP', CONVERT(VARCHAR(19), p.id), @stamp, @suffix)
        FROM dbo.payments p
        JOIN @inserted i ON i.id = p.id;

        SELECT p.provider_order_id, p.currency,
               CONVERT(VARCHAR(30), p.amount) AS amount_text,
               @stamp AS vnp_created,
               CONVERT(CHAR(8), DATEADD(MINUTE, @minutes, @vnNow), 112)
               + REPLACE(CONVERT(CHAR(8), DATEADD(MINUTE, @minutes, @vnNow), 108), ':', '') AS vnp_expires
        FROM dbo.payments p
        JOIN @inserted i ON i.id = p.id;
    `);

    return recordset?.[0];
}

async function startVnpayCheckout(reconcileSelectedRooms, bookingId, customerId, body, ipAddress) {
    const id = validateBookingId(bookingId);
    validateCustomer(customerId);

    return withTransaction(async transaction => {
        const { view, payment, row } = await inspectCheckout(
            transaction,
            id,
            customerId,
            reconcileSelectedRooms
        );

        if (!view.canPay) {
            throw checkoutError(409, view.state, view.message);
        }

        if (body.booking_version !== view.bookingVersion) {
            throw checkoutError(
                409,
                "BOOKING_CHANGED",
                "Đơn đặt phòng đã thay đổi. Vui lòng kiểm tra lại."
            );
        }

        if (view.state === "RESUME_PAYMENT") {
            const currentPayment = await loadProcessingPayment(transaction, id);

            if (!currentPayment?.is_open || currentPayment.provider_order_id !== payment.provider_order_id) {
                throw checkoutError(
                    409,
                    "PAYMENT_RECONCILING",
                    "Phiên thanh toán đã hết hạn. Hệ thống đang kiểm tra giao dịch."
                );
            }

            return { paymentUrl: buildVnpayUrl(currentPayment, id, ipAddress) };
        }

        if (row.currency !== "VND" || !/^\d+\.00$/.test(row.amount_text) || Number(row.amount_text) <= 0) {
            throw checkoutError(
                409,
                "INVALID_PAYMENT_AMOUNT",
                "Số tiền thanh toán VNPay không hợp lệ."
            );
        }

        const form = validateCheckoutForm(body);
        const createdPayment = await createProcessingPayment(transaction, id, form);

        if (!createdPayment) {
            throw checkoutError(
                409,
                "BOOKING_EXPIRED",
                "Đơn đặt phòng đã hết hạn. Vui lòng chọn phòng lại."
            );
        }

        // Ký URL trước khi commit để lỗi cấu hình có thể rollback cả booking và payment.
        return { paymentUrl: buildVnpayUrl(createdPayment, id, ipAddress) };
    });
}

function createBookingCheckout(reconcileSelectedRooms) {
    return {
        getBookingCheckout: (bookingId, customerId) =>
            getBookingCheckout(reconcileSelectedRooms, bookingId, customerId),

        startVnpayCheckout: (bookingId, customerId, body, ipAddress) =>
            startVnpayCheckout(reconcileSelectedRooms, bookingId, customerId, body, ipAddress),

        checkStoredBookingRooms: (transaction, bookingId, bookingRow) =>
            checkStoredBookingRooms(transaction, bookingId, bookingRow, reconcileSelectedRooms),
    };
}

module.exports = { createBookingCheckout };
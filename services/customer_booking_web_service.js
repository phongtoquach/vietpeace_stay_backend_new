const { sqlObj, getDBPool } = require('../configs/database');

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
            DECLARE @now DATETIME2 = SYSDATETIME();

            SELECT
                CONVERT(VARCHAR(19), b.id) AS id,
                b.booking_code AS bookingCode,
                b.status,
                b.accommodation_id AS accommodationId,
                a.accommodation_name AS accommodationName,
                a.address_line AS address,
                l.name AS locationName,
                province.full_name AS provinceFullName,
                ward.full_name AS wardFullName,
                cover.image_url AS accommodationImageUrl,
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
                CASE WHEN b.status = 'FAILED' THEN b.failure_code END AS failureCode,
                CASE WHEN b.status = 'FAILED' THEN b.failure_message END AS failureMessage,
                CAST(CASE WHEN b.status = 'PENDING' AND b.pending_expires_at > @now
                    THEN 1 ELSE 0 END AS BIT) AS isPendingOpen,
                CONVERT(VARCHAR(19), p.id) AS paymentId,
                p.payment_code AS paymentCode,
                p.payment_method AS paymentMethod,
                p.status AS paymentStatus,
                p.amount AS paymentAmount,
                p.currency AS paymentCurrency,
                p.refunded_amount AS paymentRefundedAmount,
                p.processing_at AS paymentProcessingAt,
                p.paid_at AS paymentPaidAt,
                p.refunded_at AS paymentRefundedAt,
                p.expires_at AS paymentExpiresAt,
                CAST(CASE WHEN p.status = 'PROCESSING' AND p.expires_at > @now
                    THEN 1 ELSE 0 END AS BIT) AS isPaymentSessionOpen,
                (
                    SELECT
                        CONVERT(VARCHAR(19), i.id) AS id,
                        i.room_type_id AS roomTypeId,
                        i.room_type_name AS roomName,
                        roomCover.image_url AS roomTypeImageUrl,
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
                    OUTER APPLY (
                        SELECT TOP (1) ri.image_url
                        FROM dbo.room_type_images AS ri
                        WHERE ri.room_type_id = i.room_type_id
                        ORDER BY ri.is_cover DESC, ri.sort_order, ri.id
                    ) AS roomCover
                    WHERE i.booking_id = b.id
                    ORDER BY i.id
                    FOR JSON PATH, INCLUDE_NULL_VALUES
                ) AS itemsJson
            FROM dbo.bookings AS b WITH (HOLDLOCK)
            LEFT JOIN dbo.accommodations AS a ON a.id = b.accommodation_id
            LEFT JOIN dbo.locations AS l ON l.id = a.location_id
            LEFT JOIN dbo.provinces AS province ON province.id = l.province_id
            LEFT JOIN dbo.wards AS ward ON ward.id = a.ward_id
            OUTER APPLY (
                SELECT TOP (1) ai.image_url
                FROM dbo.accommodation_images AS ai
                WHERE ai.accommodation_id = b.accommodation_id
                ORDER BY ai.is_cover DESC, ai.sort_order, ai.id
            ) AS cover
            OUTER APPLY (
                SELECT TOP (1)
                    bp.id, bp.payment_code, bp.payment_method, bp.status, bp.amount,
                    bp.currency, bp.refunded_amount, bp.processing_at, bp.paid_at,
                    bp.refunded_at, bp.expires_at
                FROM dbo.payments AS bp
                WHERE bp.booking_id = b.id
                  AND b.status <> 'PENDING'
                  AND (b.status <> 'PAYMENT_PROCESSING' OR bp.status = 'PROCESSING')
                ORDER BY
                    CASE
                        WHEN b.status = 'FAILED'
                            AND bp.status IN ('REFUND_PENDING', 'REFUND_PROCESSING') THEN 0
                        WHEN b.status = 'FAILED'
                            AND bp.status IN ('REFUNDED', 'PARTIALLY_REFUNDED') THEN 1
                        WHEN b.status = 'FAILED' AND bp.paid_at IS NOT NULL THEN 2
                        WHEN b.status = 'CONFIRMED' AND bp.status = 'SUCCESS' THEN 0
                        WHEN b.status = 'CONFIRMED' AND bp.status = 'PARTIALLY_REFUNDED' THEN 1
                        ELSE 3
                    END,
                    bp.id DESC
            ) AS p
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

    const {
        itemsJson, paymentId, paymentCode, paymentMethod, paymentStatus,
        paymentAmount, paymentCurrency, paymentRefundedAmount,
        paymentProcessingAt, paymentPaidAt, paymentRefundedAt, paymentExpiresAt,
        isPaymentSessionOpen, ...booking
    } = row;

    const payment = paymentId == null ? null : {
        id: paymentId,
        code: paymentCode,
        method: paymentMethod,
        status: paymentStatus,
        amount: paymentAmount,
        currency: paymentCurrency,
        refundedAmount: paymentRefundedAmount,
        processingAt: paymentProcessingAt,
        paidAt: paymentPaidAt,
        refundedAt: paymentRefundedAt,
        expiresAt: paymentExpiresAt,
        isSessionOpen: isPaymentSessionOpen,
    };

    return {
        ...booking,
        payment,
        items: JSON.parse(itemsJson || '[]').map(item => ({
            ...item,
            nightlyRates: item.nightlyRates ?? [],
        })),
    };
}

async function getCustomerBookings(filters, customerId) {
    if (!customerId) {
        throw Object.assign(
            new Error('Vui lòng đăng nhập để xem danh sách đặt phòng.'),
            { statusCode: 401, errorCode: 'LOGIN_REQUIRED' }
        );
    }

    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
        throw Object.assign(
            new Error('Body phải là một JSON object.'),
            { statusCode: 400, errorCode: 'INVALID_BOOKING_FILTERS' }
        );
    }

    let defaultPageSize = 3;
    if (process.env.CUSTOMER_BOOKINGS_PAGESIZE) {
        const configPageSize = Number(process.env.CUSTOMER_BOOKINGS_PAGESIZE);
        console.log("[getCustomerBookings service] Value cua configPageSize : ", configPageSize);

        if (Number.isInteger(configPageSize) && configPageSize >= 1 && configPageSize <= 100) {
            console.log("[getCustomerBookings service] configPageSize hop le !");
            defaultPageSize = configPageSize;
        }
    }
    console.log("[getCustomerBookings service] Value sau cung cua defaultPageSize : ", defaultPageSize);

    const { status = 'CONFIRMED', page = 1, pageSize = defaultPageSize } = filters;

    console.log("[getCustomerBookings service] Value sau cung cua pageSize : ", pageSize);

    if (!['CONFIRMED', 'PENDING', 'PAYMENT_PROCESSING'].includes(status)) {
        throw Object.assign(
            new Error('Trạng thái lọc booking không hợp lệ.'),
            { statusCode: 400, errorCode: 'INVALID_BOOKING_STATUS' }
        );
    }

    if (!Number.isSafeInteger(page) || page < 1 || page > 2147483647) {
        throw Object.assign(
            new Error('page phải là số nguyên dương hợp lệ.'),
            { statusCode: 400, errorCode: 'INVALID_PAGE' }
        );
    }

    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        throw Object.assign(
            new Error('pageSize phải là số nguyên từ 1 đến 100.'),
            { statusCode: 400, errorCode: 'INVALID_PAGE_SIZE' }
        );
    }

    const pool = await getDBPool();
    const { recordset } = await pool.request()
        .input('customerId', sqlObj.UniqueIdentifier, customerId)
        .input('status', sqlObj.VarChar(30), status)
        .input('page', sqlObj.Int, page)
        .input('pageSize', sqlObj.Int, pageSize)
        .query(`
            DECLARE @now DATETIME2 = SYSDATETIME();
            DECLARE @offset BIGINT = (CONVERT(BIGINT, @page) - 1) * @pageSize;

            ;WITH filtered AS (
                SELECT b.id, b.booking_code, b.status, b.accommodation_id,
                    b.check_in_date, b.check_out_date, b.total_nights,
                    b.total_rooms, b.total_adults, b.total_children, b.total_amount,
                    b.currency, b.pending_expires_at, b.confirmed_at, b.created_at
                FROM dbo.bookings AS b
                WHERE b.user_id = @customerId
                  AND b.status = @status
                  AND (@status <> 'PENDING' OR b.pending_expires_at > @now)
            ),
            totals AS (
                SELECT COUNT_BIG(*) AS totalItems FROM filtered
            ),
            page_rows AS (
                SELECT *
                FROM filtered
                ORDER BY created_at DESC, id DESC
                OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
            )
            SELECT
                t.totalItems,
                CONVERT(VARCHAR(19), b.id) AS id,
                b.booking_code AS bookingCode,
                b.status,
                b.accommodation_id AS accommodationId,
                a.accommodation_name AS accommodationName,
                l.name AS locationName,
                province.full_name AS provinceFullName,
                ward.full_name AS wardFullName,
                a.address_line AS address,
                cover.image_url AS accommodationImageUrl,
                CONVERT(CHAR(10), b.check_in_date, 23) AS checkinDate,
                CONVERT(CHAR(10), b.check_out_date, 23) AS checkoutDate,
                b.total_nights AS nights,
                b.total_rooms AS numberOfRooms,
                b.total_adults AS totalAdults,
                b.total_children AS totalChildren,
                b.total_amount AS totalAmount,
                b.currency,
                b.pending_expires_at AS pendingExpiresAt,
                b.confirmed_at AS confirmedAt,
                b.created_at AS createdAt,
                CAST(CASE WHEN b.status = 'PENDING' AND b.pending_expires_at > @now
                    THEN 1 ELSE 0 END AS BIT) AS isPendingOpen,
                CONVERT(VARCHAR(19), p.id) AS paymentId,
                p.payment_method AS paymentMethod,
                p.status AS paymentStatus,
                p.expires_at AS paymentExpiresAt,
                p.paid_at AS paymentPaidAt,
                CAST(CASE WHEN p.status = 'PROCESSING' AND p.expires_at > @now
                    THEN 1 ELSE 0 END AS BIT) AS isPaymentSessionOpen
            FROM totals AS t
            LEFT JOIN page_rows AS b ON 1 = 1
            LEFT JOIN dbo.accommodations AS a ON a.id = b.accommodation_id
            LEFT JOIN dbo.locations AS l ON l.id = a.location_id
            LEFT JOIN dbo.provinces AS province ON province.id = l.province_id
            LEFT JOIN dbo.wards AS ward ON ward.id = a.ward_id
            OUTER APPLY (
                SELECT TOP (1) ai.image_url
                FROM dbo.accommodation_images AS ai
                WHERE ai.accommodation_id = b.accommodation_id
                ORDER BY ai.is_cover DESC, ai.sort_order, ai.id
            ) AS cover
            OUTER APPLY (
                SELECT TOP (1) bp.id, bp.payment_method, bp.status, bp.expires_at, bp.paid_at
                FROM dbo.payments AS bp
                WHERE bp.booking_id = b.id
                  AND (
                      (b.status = 'PAYMENT_PROCESSING' AND bp.status = 'PROCESSING')
                      OR (b.status = 'CONFIRMED' AND bp.status = 'SUCCESS')
                  )
                ORDER BY bp.id DESC
            ) AS p
            ORDER BY b.created_at DESC, b.id DESC;
        `);

    const totalItems = Number(recordset[0]?.totalItems ?? 0);
    const items = [];

    for (const row of recordset) {
        if (row.id == null) continue;

        const {
            totalItems: _totalItems, paymentId, paymentMethod, paymentStatus,
            paymentExpiresAt, paymentPaidAt, isPaymentSessionOpen, ...booking
        } = row;

        items.push({
            ...booking,
            payment: paymentId == null ? null : {
                id: paymentId,
                method: paymentMethod,
                status: paymentStatus,
                expiresAt: paymentExpiresAt,
                paidAt: paymentPaidAt,
                isSessionOpen: isPaymentSessionOpen,
            },
        });
    }

    return { status, page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize), items };
}

module.exports = {
    getBookingDetail,
    getCustomerBookings
};
const { createHmac, timingSafeEqual, randomBytes } = require('node:crypto');
const { getDBPool, sqlObj: sql } = require('../../configs/database');
const bookingWebService = require('../booking_web_service');

const REFUND_RESPONSE_FIELDS = [
    'vnp_ResponseId',
    'vnp_Command',
    'vnp_ResponseCode',
    'vnp_Message',
    'vnp_TmnCode',
    'vnp_TxnRef',
    'vnp_Amount',
    'vnp_OrderInfo',
    'vnp_BankCode',
    'vnp_PayDate',
    'vnp_TransactionNo',
    'vnp_TransactionType',
    'vnp_TransactionStatus',
];

function invalid(message) {
    return Object.assign(new Error(message), { statusCode: 400 });
}

function config() {
    const merchant = process.env.VNPAY_TMN_CODE;
    const secret = process.env.VNPAY_HASH_SECRET;

    if (!merchant || !secret) {
        throw new Error('Missing VNPay merchant configuration.');
    }

    return { merchant, secret };
}

function sign(value, secret) {
    return createHmac('sha512', secret).update(value, 'utf8').digest();
}

function matchesSignature(value, received, secret) {
    return typeof received === 'string' &&
        /^[a-f0-9]{128}$/i.test(received) &&
        timingSafeEqual(sign(value, secret), Buffer.from(received, 'hex'));
}

function verifyPayload(body, { merchant, secret }) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw invalid('Dữ liệu trả về từ VNPay không hợp lệ.');
    }

    const keys = Object.keys(body);

    if (
        keys.length > 32 ||
        keys.some(key =>
            !/^vnp_[A-Za-z0-9]+$/.test(key) ||
            typeof body[key] !== 'string' ||
            body[key].length > 1024
        )
    ) {
        throw invalid('Tham số trả về từ VNPay không hợp lệ.');
    }

    if (
        !/^[A-Za-z0-9]{1,100}$/.test(body.vnp_TxnRef || '') ||
        !/^[0-9]{1,12}$/.test(body.vnp_Amount || '') ||
        !/^[0-9]{2}$/.test(body.vnp_ResponseCode || '') ||
        !/^[0-9]{2}$/.test(body.vnp_TransactionStatus || '') ||
        body.vnp_TmnCode !== merchant
    ) {
        throw invalid('Thiếu thông tin giao dịch hoặc mã merchant không khớp.');
    }

    const encode = value => encodeURIComponent(value).replace(/%20/g, '+');
    const signed = keys
        .filter(key => key !== 'vnp_SecureHash' && key !== 'vnp_SecureHashType')
        .sort()
        .map(key => encode(key) + '=' + encode(body[key]))
        .join('&');

    if (!matchesSignature(signed, body.vnp_SecureHash, secret)) {
        throw invalid('Chữ ký VNPay không hợp lệ.');
    }

    const paid =
        body.vnp_ResponseCode === '00' &&
        body.vnp_TransactionStatus === '00';

    if (
        paid &&
        (
            !/^[0-9]{1,15}$/.test(body.vnp_TransactionNo || '') ||
            BigInt(body.vnp_TransactionNo) === 0n ||
            !/^[0-9]{14}$/.test(body.vnp_PayDate || '')
        )
    ) {
        throw invalid('Thiếu mã giao dịch hoặc thời điểm thanh toán VNPay.');
    }

    return {
        ref: body.vnp_TxnRef,
        amount: BigInt(body.vnp_Amount),
        transactionNo: body.vnp_TransactionNo,
        payDate: body.vnp_PayDate,
        responseCode: body.vnp_ResponseCode,
        paid,
        failed:
            body.vnp_ResponseCode !== '00' &&
            body.vnp_TransactionStatus === '02',
    };
}

async function inTransaction(pool, work) {
    const tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

    try {
        const result = await work(tx);
        await tx.commit();
        return result;
    } catch (error) {
        try {
            await tx.rollback();
        } catch (rollbackError) {
            console.error('[vnpay rollback]', rollbackError.code || rollbackError.name);
        }

        throw error;
    }
}

function byRef(source, ref) {
    return new sql.Request(source).input('ref', sql.VarChar(150), ref);
}

function byPayment(source, paymentId) {
    return new sql.Request(source).input('paymentId', sql.VarChar(19), paymentId);
}

async function lockAccommodation(tx, accommodationId) {
    const { recordset } = await new sql.Request(tx)
        .input('resource', sql.NVarChar(255), 'vietpeace:inventory:' + accommodationId)
        .query(`
            DECLARE @result INT;

            EXEC @result = sys.sp_getapplock
                @Resource = @resource,
                @LockMode = 'Exclusive',
                @LockOwner = 'Transaction',
                @LockTimeout = 8000;

            SELECT @result AS result;
        `);

    if (recordset[0].result < 0) {
        throw new Error('Cannot lock accommodation inventory.');
    }
}

async function getLockedBooking(tx, bookingId) {
    const { recordset } = await new sql.Request(tx)
        .input('bookingId', sql.VarChar(19), bookingId)
        .query(`
            SELECT
                CONVERT(VARCHAR(19), b.id) AS id,
                b.accommodation_id,
                b.status,
                b.total_rooms,
                b.total_adults,
                b.total_children,
                b.currency,
                b.booking_code,
                CONVERT(VARCHAR(36), b.user_id) AS user_id,
                CONVERT(VARCHAR(30), b.total_amount) AS amount_text,
                CONVERT(CHAR(10), b.check_in_date, 23) AS checkin_date,
                CONVERT(CHAR(10), b.check_out_date, 23) AS checkout_date,
                b.total_nights,
                a.accommodation_name,
                CASE
                    WHEN a.status = 1
                        AND a.deleted_at IS NULL
                        AND b.check_in_date >= CONVERT(
                            DATE, DATEADD(HOUR, 7, SYSUTCDATETIME())
                        )
                    THEN 1
                    ELSE 0
                END AS eligible
            FROM dbo.bookings b WITH (UPDLOCK, HOLDLOCK)
            JOIN dbo.accommodations a WITH (HOLDLOCK)
                ON a.id = b.accommodation_id
            WHERE b.id = CONVERT(BIGINT, @bookingId);
        `);

    return recordset[0];
}

async function getLockedPayment(tx, ref) {
    const { recordset } = await byRef(tx, ref).query(`
        SELECT
            CONVERT(VARCHAR(19), id) AS id,
            CONVERT(VARCHAR(19), booking_id) AS booking_id,
            status,
            currency,
            provider_order_id,
            provider_transaction_id,
            CONVERT(VARCHAR(30), amount) AS amount_text
        FROM dbo.payments WITH (UPDLOCK, HOLDLOCK)
        WHERE payment_method = 'VNPAY'
          AND provider_order_id = @ref;
    `);

    return recordset[0];
}

function minorAmount(decimal) {
    if (!/^\d+\.\d{2}$/.test(decimal)) {
        throw new Error('Invalid stored decimal amount.');
    }

    return BigInt(decimal.replace('.', ''));
}

function confirmedView(booking, customerId) {
    const result = { state: 'CONFIRMED' };

    if (
        typeof customerId === 'string' &&
        customerId.toLowerCase() === booking.user_id.toLowerCase()
    ) {
        result.booking = {
            bookingId: booking.id,
            bookingCode: booking.booking_code,
            accommodationName: booking.accommodation_name,
            checkinDate: booking.checkin_date,
            checkoutDate: booking.checkout_date,
            nights: booking.total_nights,
            numberOfRooms: booking.total_rooms,
            totalAmount: Number(booking.amount_text),
        };
    }

    return result;
}

async function recordPaid(tx, payment, event, canConfirm, isCurrentPayment) {
    await byPayment(tx, payment.id)
        .input('transactionNo', sql.VarChar(255), event.transactionNo)
        .input('payDate', sql.Char(14), event.payDate)
        .input('requestId', sql.VarChar(32), randomBytes(16).toString('hex'))
        .input('canConfirm', sql.Bit, canConfirm)
        .input('isCurrent', sql.Bit, isCurrentPayment)
        .query(`
            DECLARE @id BIGINT = CONVERT(BIGINT, @paymentId);
            DECLARE @now DATETIME2 = SYSDATETIME();

            DECLARE @paidVietnam DATETIME2 = CONVERT(DATETIME2,
                CONCAT(
                    SUBSTRING(@payDate, 1, 4), '-',
                    SUBSTRING(@payDate, 5, 2), '-',
                    SUBSTRING(@payDate, 7, 2), 'T',
                    SUBSTRING(@payDate, 9, 2), ':',
                    SUBSTRING(@payDate, 11, 2), ':',
                    SUBSTRING(@payDate, 13, 2)
                ), 126
            );

            UPDATE dbo.payments
            SET
                status = CASE WHEN @canConfirm = 1 THEN 'SUCCESS' ELSE 'REFUND_PENDING' END,
                provider_transaction_id = @transactionNo,
                paid_at = DATEADD(
                    MINUTE,
                    DATEPART(TZOFFSET, SYSDATETIMEOFFSET()) - 420,
                    @paidVietnam
                ),
                updated_at = @now,
                failure_code = NULL,
                failure_message = NULL,
                refund_reason = CASE WHEN @canConfirm = 0
                    THEN N'Không thể xác nhận booking.' ELSE NULL END
            WHERE id = @id
              AND status IN ('PROCESSING', 'FAILED', 'CANCELLED');

            IF @@ROWCOUNT <> 1 THROW 50001, 'Payment state changed.', 1;

            IF @isCurrent = 1
            BEGIN
                UPDATE b
                SET
                    status = CASE WHEN @canConfirm = 1 THEN 'CONFIRMED' ELSE 'FAILED' END,
                    confirmed_at = CASE WHEN @canConfirm = 1 THEN @now ELSE NULL END,
                    failed_at = CASE WHEN @canConfirm = 0 THEN @now ELSE NULL END,
                    failure_code = CASE WHEN @canConfirm = 0
                        THEN 'BOOKING_NOT_CONFIRMABLE' ELSE NULL END,
                    failure_message = CASE WHEN @canConfirm = 0
                        THEN N'Không thể xác nhận booking sau thanh toán.' ELSE NULL END,
                    updated_at = @now
                FROM dbo.bookings b
                JOIN dbo.payments p ON p.booking_id = b.id
                WHERE p.id = @id
                  AND b.status = 'PAYMENT_PROCESSING';

                IF @@ROWCOUNT <> 1 THROW 50002, 'Booking state changed.', 1;
            END;

            IF @canConfirm = 0
                INSERT dbo.vnpay_full_refunds (
                    payment_id, request_id, original_pay_date
                )
                VALUES (@id, @requestId, @payDate);
        `);
}

async function recordFailure(tx, payment, event, isCurrentPayment) {
    await byPayment(tx, payment.id)
        .input('failureCode', sql.VarChar(100), 'VNPAY_' + event.responseCode)
        .input('isCurrent', sql.Bit, isCurrentPayment)
        .query(`
            DECLARE @id BIGINT = CONVERT(BIGINT, @paymentId);
            DECLARE @now DATETIME2 = SYSDATETIME();

            UPDATE dbo.payments
            SET
                status = 'FAILED',
                failure_code = @failureCode,
                failure_message = N'VNPay báo giao dịch thất bại.',
                updated_at = @now
            WHERE id = @id
              AND status = 'PROCESSING';

            IF @@ROWCOUNT <> 1 THROW 50001, 'Payment state changed.', 1;

            IF @isCurrent = 1
                UPDATE b
                SET
                    status = 'FAILED',
                    failed_at = @now,
                    failure_code = @failureCode,
                    failure_message = N'VNPay báo giao dịch thất bại.',
                    updated_at = @now
                FROM dbo.bookings b
                JOIN dbo.payments p ON p.booking_id = b.id
                WHERE p.id = @id
                  AND b.status = 'PAYMENT_PROCESSING';
        `);
}

async function finalizePayment(pool, event, customerId) {
    const { recordset } = await byRef(pool, event.ref).query(`
        SELECT
            CONVERT(VARCHAR(19), b.id) AS booking_id,
            b.accommodation_id
        FROM dbo.payments p
        JOIN dbo.bookings b ON b.id = p.booking_id
        WHERE p.payment_method = 'VNPAY'
          AND p.provider_order_id = @ref;
    `);

    const target = recordset[0];

    if (!target) {
        throw invalid('Không tìm thấy giao dịch VNPay phù hợp.');
    }

    return inTransaction(pool, async tx => {
        await lockAccommodation(tx, target.accommodation_id);

        const booking = await getLockedBooking(tx, target.booking_id);
        const payment = await getLockedPayment(tx, event.ref);

        if (
            !booking ||
            !payment ||
            booking.accommodation_id !== target.accommodation_id ||
            payment.booking_id !== target.booking_id
        ) {
            throw new Error('Booking changed during verification.');
        }

        if (
            payment.provider_order_id !== event.ref ||
            payment.currency !== 'VND' ||
            minorAmount(payment.amount_text) !== event.amount
        ) {
            throw invalid('Mã giao dịch hoặc số tiền VNPay không khớp.');
        }

        if (
            event.paid &&
            payment.provider_transaction_id &&
            payment.provider_transaction_id !== event.transactionNo
        ) {
            throw invalid('Mã giao dịch VNPay không khớp với giao dịch đã ghi nhận.');
        }

        if (payment.status === 'SUCCESS' && booking.status === 'CONFIRMED') {
            console.log("[finalizePayment] payment.status = " + payment.status + " ; booking.status = " + booking.status + " ! Booking này đã được confirmed rồi, nên ko cần check tiếp nữa ! Return ngay !");
            return confirmedView(booking, customerId);
        }

        if (payment.status === 'REFUNDED') {
            return { state: 'REFUNDED' };
        }

        if (['REFUND_PENDING', 'REFUND_PROCESSING', 'PARTIALLY_REFUNDED'].includes(payment.status)) {
            return { state: 'REFUND_PENDING', refundId: payment.id };
        }

        const isCurrent =
            payment.status === 'PROCESSING' &&
            booking.status === 'PAYMENT_PROCESSING';

        if (!event.paid) {
            if (['FAILED', 'CANCELLED'].includes(payment.status)) {
                return { state: 'FAILED' };
            }

            if (payment.status !== 'PROCESSING' || !event.failed) {
                return { state: 'VERIFY_PENDING' };
            }

            await recordFailure(tx, payment, event, isCurrent);
            return { state: 'FAILED' };
        }

        if (!['PROCESSING', 'FAILED', 'CANCELLED'].includes(payment.status)) {
            return { state: 'VERIFY_PENDING' };
        }

        let canConfirm = false;

        if (
            isCurrent &&
            booking.eligible &&
            booking.currency === 'VND' &&
            minorAmount(booking.amount_text) === event.amount
        ) {
            const { roomsValid } = await bookingWebService.checkStoredBookingRooms(
                tx,
                payment.booking_id,
                booking
            );

            canConfirm = roomsValid;
        }

        await recordPaid(tx, payment, event, canConfirm, isCurrent);

        console.log("[finalizePayment] Value của canConfirm là : ", canConfirm);
        if (canConfirm) {
            console.log("[finalizePayment] canConfirm = true ! Return state = CONFIRMED ! Value của payment.booking_id ", payment.booking_id);

            //return confirmedView(booking, customerId);
            return {
                ...confirmedView(booking, customerId),
                bookingIdToEmail: payment.booking_id
            };
        }
        else {
            console.log("[finalizePayment] canConfirm = false ! Return state = REFUND_PENDING va refundId " + payment.id);
            return { state: 'REFUND_PENDING', refundId: payment.id };
        }
    });
}

function vietnamTimestamp(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);

    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));

    return values.year + values.month + values.day +
        values.hour + values.minute + values.second;
}

async function claimRefund(pool, paymentId) {
    return inTransaction(pool, async tx => {
        const { recordset } = await byPayment(tx, paymentId).query(`
            DECLARE @id BIGINT = CONVERT(BIGINT, @paymentId);

            UPDATE p
            SET status = 'REFUND_PROCESSING', updated_at = SYSDATETIME()
            FROM dbo.payments p
            JOIN dbo.vnpay_full_refunds r ON r.payment_id = p.id
            WHERE p.id = @id
              AND p.payment_method = 'VNPAY'
              AND p.status = 'REFUND_PENDING'
              AND p.refunded_amount = 0
              AND r.sent_at IS NULL;

            IF @@ROWCOUNT = 0 RETURN;

            UPDATE dbo.vnpay_full_refunds
            SET sent_at = SYSDATETIME()
            WHERE payment_id = @id;

            SELECT
                r.request_id,
                r.original_pay_date,
                p.provider_order_id,
                p.provider_transaction_id,
                CONVERT(VARCHAR(30), p.amount) AS amount_text
            FROM dbo.vnpay_full_refunds r
            JOIN dbo.payments p ON p.id = r.payment_id
            WHERE p.id = @id;
        `);

        return recordset?.[0];
    });
}

async function settleRefund(pool, paymentId, responseCode, refunded) {
    await inTransaction(pool, tx => byPayment(tx, paymentId)
        .input('responseCode', sql.VarChar(10), responseCode)
        .input('refunded', sql.Bit, refunded)
        .query(`
            DECLARE @id BIGINT = CONVERT(BIGINT, @paymentId);

            UPDATE dbo.vnpay_full_refunds
            SET
                checked_at = SYSDATETIME(),
                gateway_response_code = @responseCode
            WHERE payment_id = @id;

            IF @refunded = 1
                UPDATE dbo.payments
                SET
                    status = 'REFUNDED',
                    refunded_amount = amount,
                    refunded_at = SYSDATETIME(),
                    updated_at = SYSDATETIME()
                WHERE id = @id
                  AND status = 'REFUND_PROCESSING';
        `));
}

async function sendPendingRefund(pool, paymentId, ipAddress, { merchant, secret }) {
    console.log("[sendPendingRefund] Đang chạy hàm sendPendingRefund() ! ");
    console.log("[sendPendingRefund] bien env VNPAY_API_URL : ", process.env.VNPAY_API_URL);
    console.log("[sendPendingRefund] paymentId : " + paymentId + " ; ipAddress : " + ipAddress);
    console.log("[sendPendingRefund] merchant : " + merchant + " ; secret : " + secret);

    if (!process.env.VNPAY_API_URL) return false;

    const url = new URL(process.env.VNPAY_API_URL);

    console.log("[sendPendingRefund] Value của url.protocol : ", url.protocol);

    if (url.protocol !== 'https:') {
        throw new Error('VNPAY_API_URL must use HTTPS.');
    }

    console.log("[sendPendingRefund] chuan bi claimRefund() !");

    const job = await claimRefund(pool, paymentId);
    console.log("[sendPendingRefund] Data cua job : ", job);

    if (!job) return false;

    // Giữ thứ tự các trường khi ký request refund.
    const request = {
        vnp_RequestId: job.request_id,
        vnp_Version: '2.1.0',
        vnp_Command: 'refund',
        vnp_TmnCode: merchant,
        vnp_TransactionType: '02',
        vnp_TxnRef: job.provider_order_id,
        vnp_Amount: String(minorAmount(job.amount_text)),
        vnp_TransactionNo: job.provider_transaction_id,
        vnp_TransactionDate: job.original_pay_date,
        vnp_CreateBy: 'VietPeaceStay',
        vnp_CreateDate: vietnamTimestamp(),
        vnp_IpAddr: (ipAddress || '127.0.0.1')
            .replace(/^::ffff:/, '')
            .replace(/^::1$/, '127.0.0.1'),
        vnp_OrderInfo: 'Hoan tien toan bo ' + job.provider_order_id,
    };

    request.vnp_SecureHash = sign(
        Object.values(request).join('|'),
        secret
    ).toString('hex');

    console.log("[sendPendingRefund] URL cua request : ", url);
    console.log("[sendPendingRefund] Data cua body trong request : ", request);

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
    });

    console.log("[sendPendingRefund] Ket qua goi API : ", response);

    if (!response.ok) return false;

    const data = await response.json();

    console.log("[sendPendingRefund] Data cua response : ", data);

    const fieldsAreScalar = data && REFUND_RESPONSE_FIELDS.every(key =>
        data[key] == null ||
        typeof data[key] === 'string' ||
        (typeof data[key] === 'number' && Number.isSafeInteger(data[key]))
    );

    console.log("[sendPendingRefund] Value của fieldsAreScalar : ", fieldsAreScalar);

    if (!fieldsAreScalar) return false;

    const signed = REFUND_RESPONSE_FIELDS.map(key => data[key] ?? '').join('|');

    console.log("[sendPendingRefund] Data của signed : ", signed);

    if (!matchesSignature(signed, data.vnp_SecureHash, secret)) {
        console.log("[sendPendingRefund] matchesSignature() tra ve false ! return false ngay !");
        return false;
    }

    const code = String(data.vnp_ResponseCode ?? '');

    const refunded =
        data.vnp_Command === 'refund' &&
        data.vnp_TmnCode === merchant &&
        data.vnp_TxnRef === job.provider_order_id &&
        String(data.vnp_Amount) === request.vnp_Amount &&
        String(data.vnp_TransactionType) === '02' &&
        code === '00' &&
        String(data.vnp_TransactionStatus) === '00';

    console.log("[sendPendingRefund] Value của biến refunded : ", refunded);

    await settleRefund(
        pool,
        paymentId,
        /^[0-9]{2}$/.test(code) ? code : null,
        refunded
    );

    return refunded;
}

async function verifyReturn(body, { customerId, ipAddress } = {}) {
    const settings = config();
    const event = verifyPayload(body, settings);
    const pool = await getDBPool();
    const result = await finalizePayment(pool, event, customerId);

    console.log("[verifyReturn service] Data của result sau khi chạy finalizePayment() : ", result);

    if (!result.refundId) {
        console.log("[verifyReturn service] Trong result không có refundId ! Return result ngay !");
        return result;
    }

    try {
        const refunded = await sendPendingRefund(
            pool,
            result.refundId,
            ipAddress,
            settings
        );

        return { state: refunded ? 'REFUNDED' : 'REFUND_PENDING' };
    } catch (error) {
        console.error('[vnpay refund]', error.code || error.name);
        return { state: 'REFUND_PENDING' };
    }
}

async function sendQueuedRefunds(ipAddress) {
    const settings = config();

    if (!process.env.VNPAY_API_URL) {
        throw new Error('Missing VNPAY_API_URL.');
    }

    const pool = await getDBPool();

    const { recordset } = await new sql.Request(pool).query(`
        SELECT TOP (20) CONVERT(VARCHAR(19), p.id) AS id
        FROM dbo.payments p
        JOIN dbo.vnpay_full_refunds r ON r.payment_id = p.id
        WHERE p.payment_method = 'VNPAY'
          AND p.status = 'REFUND_PENDING'
          AND p.refunded_amount = 0
          AND r.sent_at IS NULL
        ORDER BY r.created_at, p.id;
    `);

    for (const row of recordset) {
        try {
            await sendPendingRefund(pool, row.id, ipAddress, settings);
        } catch (error) {
            console.error('[vnpay queued refund]', error.code || error.name);
        }
    }
}

module.exports = { verifyReturn, sendQueuedRefunds };
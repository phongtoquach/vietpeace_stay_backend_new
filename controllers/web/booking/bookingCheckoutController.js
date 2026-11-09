const bookingWebService = require("../../../services/booking_web_service");

function sendError(res, error) {
    if (error.statusCode) {
        return res.status(error.statusCode).json({
            success: false,
            errorCode: error.errorCode,
            message: error.message,
            errors: error.errors || {},
        });
    }

    console.error('[booking checkout]', error);

    return res.status(500).json({
        success: false,
        errorCode: 'INTERNAL_SERVER_ERROR',
        message: 'Không thể xử lý yêu cầu thanh toán lúc này.',
    });
}

async function getBookingCheckout(req, res) {
    try {
        const { bookingId } = req.params;
        const customerId = req.session?.customer?.id;

        const data = await bookingWebService.getBookingCheckout(
            bookingId,
            customerId
        );

        return res.json({ success: true, data });
    } catch (error) {
        return sendError(res, error);
    }
}

async function startCheckout(req, res) {
    try {
        const body = req.body;

        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return res.status(400).json({
                success: false,
                errorCode: 'DATA_INVALID',
                message: 'Dữ liệu thanh toán không hợp lệ.',
            });
        }

        const { bookingId, payment_method } = body;
        const customerId = req.session?.customer?.id;

        switch (payment_method) {
            case 'VNPAY': {
                const data = await bookingWebService.startVnpayCheckout(
                    bookingId,
                    customerId,
                    body,
                    req.ip
                );

                return res.json({ success: true, data });
            }

            default:
                return res.status(400).json({
                    success: false,
                    errorCode: 'UNSUPPORTED_PAYMENT_METHOD',
                    message: 'Phương thức thanh toán không được hỗ trợ.',
                });
        }
    } catch (error) {
        return sendError(res, error);
    }
}

module.exports = {
    getBookingCheckout,
    startCheckout
};
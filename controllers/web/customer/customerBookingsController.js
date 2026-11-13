/**
 * Các hàm xử lý các API route về các booking của Customer (user) đã login vào web
 */

const customerBookingWebService = require("../../../services/customer_booking_web_service");


function sendBookingError(res, error) {
    if ([400, 401, 404].includes(error.statusCode)) {
        return res.status(error.statusCode).json({
            success: false,
            errorCode: error.errorCode,
            message: error.message,
        });
    }

    console.error('[customer bookings]', error);

    return res.status(500).json({
        success: false,
        errorCode: 'INTERNAL_SERVER_ERROR',
        message: 'Không thể tải thông tin đặt phòng lúc này.',
    });
}

async function getCustomerBookings(req, res) {
    res.set('Cache-Control', 'private, no-store');

    try {
        const data = await customerBookingWebService.getCustomerBookings(
            req.body,
            req.session?.customer?.id
        );

        return res.status(200).json({ success: true, data });
    } catch (error) {
        return sendBookingError(res, error);
    }
}

async function getBookingDetail(req, res) {
    res.set('Cache-Control', 'private, no-store');

    try {
        const data = await customerBookingWebService.getBookingDetail(
            req.params.bookingId,
            req.session?.customer?.id
        );

        return res.status(200).json({ success: true, data });
    } catch (error) {
        return sendBookingError(res, error);
    }
}


// export
module.exports = {
    getCustomerBookings,
    getBookingDetail
};
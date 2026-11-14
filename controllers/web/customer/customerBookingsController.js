/**
 * Các hàm xử lý các API route về các booking của Customer (user) đã login vào web
 */

const customerBookingWebService = require("../../../services/customer_booking_web_service");
const {
    listCustomerBookings,
    getCustomerBookingByCodeOrId,
} = require("../../../services/customer_booking_read_service");

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

async function listCustomerBookingsHandler(req, res) {
    try {
        const customerId = req.session?.customer?.id;
        if (!customerId) {
            return res.status(401).json({
                success: false,
                errorCode: "LOGIN_REQUIRED",
                message: "Vui lòng đăng nhập để xem lịch sử đặt phòng.",
            });
        }
        const bookingsList = await listCustomerBookings(customerId, req.query || {});
        return res.json({
            success: true,
            message: "Successful",
            data: { bookingsList },
        });
    } catch (error) {
        console.error("[customerBookingsController.list]", error);
        return res.status(500).json({
            success: false,
            errorCode: "INTERNAL_SERVER_ERROR",
            message: "Không thể tải danh sách đặt phòng lúc này.",
        });
    }
}

async function getCustomerBookingDetail(req, res) {
    try {
        const customerId = req.session?.customer?.id;
        if (!customerId) {
            return res.status(401).json({
                success: false,
                errorCode: "LOGIN_REQUIRED",
                message: "Vui lòng đăng nhập để xem chi tiết đặt phòng.",
            });
        }
        const param = String(req.params.bookingId || "").trim();
        const booking = await getCustomerBookingByCodeOrId(customerId, {
            bookingId: /^\d+$/.test(param) ? param : undefined,
            bookingCode: param,
        });
        if (!booking) {
            return res.status(404).json({
                success: false,
                errorCode: "BOOKING_NOT_FOUND",
                message: "Không tìm thấy đơn đặt phòng của bạn.",
            });
        }
        return res.json({
            success: true,
            message: "Successful",
            data: booking,
        });
    } catch (error) {
        console.error("[customerBookingsController.detail]", error);
        return res.status(500).json({
            success: false,
            errorCode: "INTERNAL_SERVER_ERROR",
            message: "Không thể tải chi tiết đặt phòng lúc này.",
        });
    }
}

module.exports = {
    getCustomerBookings,
    getBookingDetail,
    listCustomerBookingsHandler,
    getCustomerBookingDetail,
};
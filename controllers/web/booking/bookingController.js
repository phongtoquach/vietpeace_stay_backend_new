const bookingWebService = require("../../../services/booking_web_service");

async function getBookingPreview(req, res) {
    try {
        const body = req.body;

        console.log("[getBookingPreview] Data của req.body : ");
        console.log(body);

        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return res.status(200).json({
                success: false,
                message: "Body phải là một JSON object.",
                errorCode: "DATA_INVALID"
            });
        }

        const resultData = await bookingWebService.getBookingPreview(
            body,
            req.session?.customer?.id
        );

        //console.log("[getBookingPreview] Data của resultData : ", resultData);

        if (!resultData) {
            return res.status(200).json({
                success: false,
                message: "Không tìm thấy cơ sở lưu trú.",
                errorCode: "ACCOMMODATION_NOT_FOUND"
            });
        }

        return res.json({
            success: true,
            message: "Successful",
            data: resultData
        });
    } catch (error) {
        if (error.statusCode === 400) {
            return res.status(200).json({
                success: false,
                message: error.message,
                errorCode: "DATA_INVALID"
            });
        }

        console.error("[booking-preview]", error);

        return res.status(200).json({
            success: false,
            message: "Không thể tải thông tin cơ sở lưu trú lúc này.",
            errorCode: "INTERNAL_SERVER_ERROR"
        });
    }
}


async function savePendingBooking(req, res) {
    console.log("[savePendingBooking] Data cua req.session.customer : ", req.session.customer);
    try {
        const result_data = await bookingWebService.savePendingBooking(
            req.body,
            req.session?.customer?.id
        );

        return res.status(result_data.created ? 201 : 200).json({
            success: true,
            message: "Successful",
            data: result_data
        });
    } catch (error) {
        if ([400, 401, 404, 409].includes(error.statusCode)) {
            return res.status(error.statusCode).json({
                success: false,
                message: error.message,
                errorCode: error.errorCode ?? "DATA_INVALID",
                errors: error.errorsDetail ?? {}
            });
        }

        console.error("[booking-draft.save]", error);

        return res.status(500).json({
            success: false,
            message: "Không thể lưu đặt phòng lúc này.",
            errorCode: "INTERNAL_SERVER_ERROR",
            errors: {}
        });
    }
}


// export
module.exports = {
    getBookingPreview,
    savePendingBooking
};
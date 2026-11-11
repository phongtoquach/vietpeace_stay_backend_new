const vnpayReturnService = require('../../../services/vnpay_payment/vnpay_return_service');

const bookingConfirmMailService = require('../../../services/booking_confirmation_mail_service');

async function verifyReturn(req, res) {
    res.set('Cache-Control', 'no-store');

    let verifyReturn_result;

    try {
        verifyReturn_result = await vnpayReturnService.verifyReturn(req.body, {
            customerId: req.session?.customer?.id,
            ipAddress: req.ip,
        });

        console.log("[verifyReturn] Value của verifyReturn_result sau khi chạy hàm service verifyReturn() : ", verifyReturn_result);

        //return res.json({ success: true, data });
    } catch (error) {
        if (error.statusCode === 400) {
            return res.status(400).json({
                success: false,
                message: error.message,
            });
        }

        console.error('[vnpay return]', error.code || error.name);

        return res.status(503).json({
            success: false,
            message: 'Chưa thể xác minh kết quả. Vui lòng thử kiểm tra lại.',
        });
    }

    const { bookingIdToEmail, ...data } = verifyReturn_result;

    console.log("[verifyReturn] bookingIdToEmail lay ra tu verifyReturn_result : ", bookingIdToEmail);
    console.log("[verifyReturn] data lay ra tu verifyReturn_result : ", data);

    // response data về cho client side trước
    res.json({ success: true, data });

    // check bookingIdToEmail de quyet dinh co send mail xac nhan booking hay ko
    if (bookingIdToEmail != null) {
        console.log("[verifyReturn] Bắt đầu send mail xác nhận booking theo bookingIdToEmail : " + bookingIdToEmail + " !");

        void bookingConfirmMailService.sendBookingConfirmation(bookingIdToEmail)
        .then(info => {
            console.log("[verifyReturn - sendBookingConfirmation - then()] Data của info : ", info);

            console.log('[verifyReturn - sendBookingConfirmation - then()] SMTP đã nhận thư', {
                bookingId: bookingIdToEmail,
                messageId: info.messageId,
                acceptedCount: info.accepted?.length ?? 0,
            });
        })
        .catch(error => {
            console.log("[verifyReturn - sendBookingConfirmation - catch()] Data của error : ", error);

            console.error('[verifyReturn - sendBookingConfirmation - catch()] Gửi mail lỗi', {
                bookingId: bookingIdToEmail,
                errorCode: error?.code || error?.name || 'SEND_FAILED',
                message: error?.message,
            });
        });
    }
    else {
        console.log("[verifyReturn] bookingIdToEmail = null ! Không cần send mail xác nhận booking !");
    }
}


// export
module.exports = {
    verifyReturn
};
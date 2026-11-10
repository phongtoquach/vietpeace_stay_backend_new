const vnpayReturnService = require('../../../services/vnpay_payment/vnpay_return_service');

async function verifyReturn(req, res) {
    res.set('Cache-Control', 'no-store');

    try {
        const data = await vnpayReturnService.verifyReturn(req.body, {
            customerId: req.session?.customer?.id,
            ipAddress: req.ip,
        });

        return res.json({ success: true, data });
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
}


// export
module.exports = {
    verifyReturn
};
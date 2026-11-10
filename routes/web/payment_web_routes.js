/**
 * Các route này đều dùng cho các API có prefix /api/web/payment/* : là các API liên quan đến payment
 */

const express = require("express");

const router = express.Router();

const vnPayReturnController = require("../../controllers/web/payment/vnpayReturnController");

router.post(
    '/vnpay/return',
    express.json({ limit: '8kb' }),
    vnPayReturnController.verifyReturn
);


// export
module.exports = router;
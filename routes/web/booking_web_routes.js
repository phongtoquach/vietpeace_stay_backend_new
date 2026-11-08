/**
 * Các route này đều dùng cho các API có prefix /api/web/booking/* : là các API liên quan đến tính toán các giá tiền của booking
 */

const express = require("express");

const router = express.Router();

const bookingController = require("../../controllers/web/booking/bookingController");

const requireCustomerLogin = require("../../middlewares/requireCustomerLogin");


router.post("/booking-preview", bookingController.getBookingPreview);

router.post("/save-pending-booking", requireCustomerLogin, bookingController.savePendingBooking);


// export
module.exports = router;
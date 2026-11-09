/**
 * Các route này đều dùng cho các API có prefix /api/web/booking/* : là các API liên quan đến tính toán các giá tiền của booking
 */

const express = require("express");

const router = express.Router();

const bookingController = require("../../controllers/web/booking/bookingController");

const bookingCheckoutController = require("../../controllers/web/booking/bookingCheckoutController");

const requireCustomerLogin = require("../../middlewares/requireCustomerLogin");


router.post("/booking-preview", bookingController.getBookingPreview);

router.post("/save-pending-booking", requireCustomerLogin, bookingController.savePendingBooking);

router.get('/checkout/get-booking-checkout/:bookingId', requireCustomerLogin, bookingCheckoutController.getBookingCheckout);

router.post('/checkout/start-checkout', requireCustomerLogin, bookingCheckoutController.startCheckout);


// export
module.exports = router;
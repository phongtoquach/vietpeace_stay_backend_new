/**
 * Các route này đều dùng cho các API có prefix /api/web/customer/* : là các API dành cho customer (user) đã login vào web
 */

const express = require("express");
const router = express.Router();

const customerController = require("../../controllers/web/customer/customerController");
const customerBookingsController = require("../../controllers/web/customer/customerBookingsController");

//const requireCustomerLogin = require("../middlewares/requireCustomerLogin");

// API lấy thông tin profile của user login
router.get("/profile", customerController.getCustomerProfile);
// API update thông tin profile của user login
router.post("/profile/update", customerController.updateCustomerProfile);

// API change password của user login
router.post("/change-password", customerController.changeAccountPassword);


// API lấy danh sách các booking của user login
router.get("/bookings", customerBookingsController.getCustomerBookings);


// export
module.exports = router;
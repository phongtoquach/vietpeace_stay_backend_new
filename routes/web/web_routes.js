/**
 * Các route này đều dùng cho các API có prefix /api/web/* : là các API sử dụng cho phần web
 */

const express = require("express");
const router = express.Router();

const requireCustomerLogin = require("../../middlewares/requireCustomerLogin");


/**
 * WEB AUTH
 * /api/web/auth/*
 * Gồm các API như :
 * - /api/web/auth/login : thực hiện authen & login vào web cho customer
 * - /api/web/auth/register : thực hiện đăng ký customer account mới
 * - /api/web/auth/logout : thực hiện logout Customer account khỏi web
 * - /api/web/auth/reset-password : thực hiện reset password của Customer account (phục vụ cho tính năng Forgot password)
 * - /api/web/auth/loggedin-user : lấy thông tin user đã login vào web (API này dùng để check có user đang login trên web hay ko)
 */
const authRoutes = require("./auth_web_routes");
router.use("/auth", authRoutes);


/**
 * CUSTOMER ROUTES : là các API dành cho customer (user) đã login vào web
 * /api/web/customer/*
 * 
 * Các API này đều apply middleware requireCustomerLogin (yêu cầu user phải login)
 */
const customerWebRoutes = require("./customer_web_routes");
router.use("/customer", requireCustomerLogin, customerWebRoutes);


/**
 * [PUBLIC APIS] ACCOMMODATIONS
 * /api/web/accommodations/*
 * trong đây sẽ có luôn API search accommodation
 */
const accommodationRoutes = require("./accommodation_web_routes");
router.use("/accommodations", accommodationRoutes);


/**
 * Bookings
 * /api/web/booking/*
 */
const bookingWebRoutes = require("./booking_web_routes");
router.use("/booking", bookingWebRoutes);


/**
 * Payment
 * /api/web/payment/*
 */
const paymentWebRoutes = require("./payment_web_routes");
router.use("/payment", paymentWebRoutes);


/**
 * [PUBLIC APIS] Các API để lookup
 * 
*/
const lookupRoutes = require("./lookup_web_routes");
router.use("/lookup", lookupRoutes);


/**
 * [PUBLIC APIS] Các API về location
 * 
*/
const locationRoutes = require("./location_web_routes");
router.use("/locations", locationRoutes);



/**
 * [PUBLIC APIS] Các API để test
 */
const testApiRoutes = require("./testapi_web_routes");
router.use("/test", testApiRoutes);


/**
 * CHATBOT
 * /api/web/chatbot/*
 */
const chatbotWebRoutes = require("./chatbot_web_routes");
router.use("/chatbot", chatbotWebRoutes);


// export
module.exports = router;
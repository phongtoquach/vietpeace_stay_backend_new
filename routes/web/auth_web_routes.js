/**
 * Các route này đều dùng cho các API có prefix /api/web/auth/*
 */

const express = require("express");
const router = express.Router();

const authController = require("../../controllers/web/auth/authController");

const requireCustomerLogin = require("../../middlewares/requireCustomerLogin");


/**
 * Các API public (không yêu cầu user login)
 */
router.get("/captcha", authController.getCaptcha);
router.post("/captcha/verify", authController.verifyCaptcha);
router.post("/login", authController.login);
router.post("/register", authController.register);
router.post("/verify-email", authController.verifyEmail);
router.post("/resend-verification", authController.resendVerification);
router.post("/forgot-password", authController.forgotPassword);
router.post("/reset-password", authController.resetPassword);


/**
 * Các API áp dụng middleware requireCustomerLogin (yêu cầu user login)
 */
router.get("/loggedin-user", requireCustomerLogin, authController.getLoggedInUser);
router.post("/logout", requireCustomerLogin, authController.logout);


// export
module.exports = router;
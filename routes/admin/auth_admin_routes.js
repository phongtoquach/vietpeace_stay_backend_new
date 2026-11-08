/**
 * Các route này đều dùng cho các API có prefix /api/admin/auth/*
 */

const express = require("express");
const router = express.Router();

const authController = require("../../controllers/admin/auth/authController");
const requireAdminLogin = require("../../middlewares/requireAdminLogin");

/**
 * Các API public (không yêu cầu admin login)
 */
router.post("/login", authController.login);
router.post("/reset-password", authController.resetPassword);

/**
 * Các API yêu cầu admin login
 */
router.get("/loggedin-user", requireAdminLogin, authController.getLoggedInAdminUser);
router.post("/change-initial-password", requireAdminLogin, authController.changeInitialPassword);
router.post("/logout", requireAdminLogin, authController.logout);

module.exports = router;

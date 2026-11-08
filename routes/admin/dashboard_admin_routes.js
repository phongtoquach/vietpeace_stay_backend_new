/**
 * Các route này đều dùng cho các API có prefix /api/admin/dashboard/*
 */

const express = require("express");
const router = express.Router();

const dashboardController = require("../../controllers/admin/dashboard/dashboardController");
const requireAdminLogin = require("../../middlewares/requireAdminLogin");

router.get("/summary", requireAdminLogin, dashboardController.getDashboardSummary);
router.get("/charts", requireAdminLogin, dashboardController.getDashboardCharts);

module.exports = router;

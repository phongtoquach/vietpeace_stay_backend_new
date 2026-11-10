/**
 * Các route này đều dùng cho các API có prefix /api/admin/reports/*
 */

const express = require("express");
const router = express.Router();

const reportController = require("../../controllers/admin/reports/reportController");
const requireAdminLogin = require("../../middlewares/requireAdminLogin");
const requirePermission = require("../../middlewares/requirePermission");

router.get(
  "/revenue",
  requireAdminLogin,
  requirePermission("reports.view"),
  reportController.getRevenueReport,
);

router.get(
  "/bookings",
  requireAdminLogin,
  requirePermission("reports.view"),
  reportController.getBookingsReport,
);

router.get(
  "/occupancy",
  requireAdminLogin,
  requirePermission("reports.view"),
  reportController.getOccupancyReport,
);

router.get(
  "/orders",
  requireAdminLogin,
  requirePermission("reports.view"),
  reportController.getMonthlyOrders,
);

module.exports = router;

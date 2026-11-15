/**
 * Các route này đều dùng cho các API có prefix /api/admin/bookings/*
 */

const express = require("express");
const router = express.Router();

const bookingController = require("../../controllers/admin/booking/bookingController");
const requireAdminLogin = require("../../middlewares/requireAdminLogin");
const requirePermission = require("../../middlewares/requirePermission");

router.get(
  "/",
  requireAdminLogin,
  requirePermission("bookings.read"),
  bookingController.getBookingsList,
);
router.patch(
  "/:id/approve",
  requireAdminLogin,
  requirePermission("bookings.write"),
  bookingController.approveBooking,
);
router.patch(
  "/:id/check-in",
  requireAdminLogin,
  requirePermission("bookings.write"),
  bookingController.checkInBooking,
);
router.patch(
  "/:id/check-out",
  requireAdminLogin,
  requirePermission("bookings.write"),
  bookingController.checkOutBooking,
);
router.get(
  "/:id",
  requireAdminLogin,
  requirePermission("bookings.read"),
  bookingController.getBookingDetail,
);

module.exports = router;

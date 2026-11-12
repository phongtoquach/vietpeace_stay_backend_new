/**
 * Các route này đều dùng cho các API có prefix /api/admin/bookings/*
 */

const express = require("express");
const router = express.Router();

const bookingController = require("../../controllers/admin/booking/bookingController");
const requireAdminLogin = require("../../middlewares/requireAdminLogin");

router.get("/", requireAdminLogin, bookingController.getBookingsList);
router.patch("/:id/approve", requireAdminLogin, bookingController.approveBooking);
router.patch("/:id/check-in", requireAdminLogin, bookingController.checkInBooking);
router.patch("/:id/check-out", requireAdminLogin, bookingController.checkOutBooking);
router.patch("/:id/dates", requireAdminLogin, bookingController.updateBookingDates);
router.patch("/:id/contact", requireAdminLogin, bookingController.updateBookingContact);
router.get("/:id", requireAdminLogin, bookingController.getBookingDetail);

module.exports = router;

/**
 * Các route này đều dùng cho các API có prefix /api/admin/bookings/*
 */

const express = require("express");
const router = express.Router();

const bookingController = require("../../controllers/admin/booking/bookingController");
const checkoutSettlementController = require("../../controllers/admin/booking/checkoutSettlementController");
const compensationNegotiationController = require("../../controllers/admin/booking/compensationNegotiationController");
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
  "/:id/checkout-folio",
  requireAdminLogin,
  requirePermission("bookings.read"),
  checkoutSettlementController.getBookingCheckoutFolio,
);
router.post(
  "/:id/incidental-charges",
  requireAdminLogin,
  requirePermission("bookings.write"),
  checkoutSettlementController.addBookingIncidentalCharge,
);
router.patch(
  "/:id/incidental-charges/:chargeId",
  requireAdminLogin,
  requirePermission("bookings.write"),
  checkoutSettlementController.updateBookingIncidentalCharge,
);
router.delete(
  "/:id/incidental-charges/:chargeId",
  requireAdminLogin,
  requirePermission("bookings.write"),
  checkoutSettlementController.voidBookingIncidentalCharge,
);
router.post(
  "/:id/checkout-settle/vnpay-url",
  requireAdminLogin,
  requirePermission("bookings.write"),
  checkoutSettlementController.createBookingVnpaySettlementUrl,
);
router.post(
  "/:id/checkout-settle",
  requireAdminLogin,
  requirePermission("bookings.write"),
  checkoutSettlementController.settleBookingCheckout,
);
router.post(
  "/:id/compensation-negotiations",
  requireAdminLogin,
  requirePermission("bookings.write"),
  compensationNegotiationController.createBookingNegotiation,
);
router.get(
  "/:id",
  requireAdminLogin,
  requirePermission("bookings.read"),
  bookingController.getBookingDetail,
);

module.exports = router;

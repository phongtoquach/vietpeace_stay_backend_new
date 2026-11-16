const express = require("express");
const router = express.Router();

const controller = require("../../controllers/admin/booking/compensationNegotiationController");
const requireAdminLogin = require("../../middlewares/requireAdminLogin");
const requirePermission = require("../../middlewares/requirePermission");

router.get(
  "/summary",
  requireAdminLogin,
  requirePermission("bookings.read"),
  controller.getNegotiationSummary,
);

router.get(
  "/",
  requireAdminLogin,
  requirePermission("bookings.read"),
  controller.listNegotiations,
);

router.get(
  "/:negotiationId",
  requireAdminLogin,
  requirePermission("bookings.read"),
  controller.getNegotiationDetail,
);

router.post(
  "/:negotiationId/review",
  requireAdminLogin,
  requirePermission("bookings.write"),
  controller.reviewNegotiation,
);

router.post(
  "/:negotiationId/cancel",
  requireAdminLogin,
  requirePermission("bookings.write"),
  controller.cancelNegotiation,
);

router.post(
  "/:negotiationId/acknowledge",
  requireAdminLogin,
  requirePermission("bookings.read"),
  controller.acknowledgeNegotiation,
);

module.exports = router;

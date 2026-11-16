const express = require("express");
const router = express.Router();

const checkoutSettlementController = require("../../controllers/admin/booking/checkoutSettlementController");
const requireAdminLogin = require("../../middlewares/requireAdminLogin");
const requirePermission = require("../../middlewares/requirePermission");

router.put(
  "/:itemId",
  requireAdminLogin,
  requirePermission("bookings.write"),
  checkoutSettlementController.updateIncidentalCatalogItem,
);

router.delete(
  "/:itemId",
  requireAdminLogin,
  requirePermission("bookings.write"),
  checkoutSettlementController.deleteIncidentalCatalogItem,
);

module.exports = router;

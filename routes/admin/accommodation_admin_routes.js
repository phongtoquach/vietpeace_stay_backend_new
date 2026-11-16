/**
 * Các route này đều dùng cho các API có prefix /api/admin/accommodations/*
 */

const express = require("express");
const router = express.Router();

const accommodationController = require("../../controllers/admin/accommodation/accommodationController");
const accommodationManagerController = require("../../controllers/admin/accommodation/accommodationManagerController");
const checkoutSettlementController = require("../../controllers/admin/booking/checkoutSettlementController");

const requireAdminLogin = require("../../middlewares/requireAdminLogin");
const requirePermission = require("../../middlewares/requirePermission");
const requireRole = require("../../middlewares/requireRole");

// 1. Phân quyền & Quản lý Manager (Dành riêng cho Super Admin)
router.get(
  "/managers-overview",
  requireAdminLogin,
  requireRole("ADMIN"),
  accommodationManagerController.getManagersOverview
);
router.post(
  "/:id/assign-manager",
  requireAdminLogin,
  requireRole("ADMIN"),
  accommodationManagerController.assignManager
);
router.delete(
  "/:id/managers",
  requireAdminLogin,
  requireRole("ADMIN"),
  accommodationManagerController.revokeManager
);
router.post(
  "/:id/resend-manager-credentials",
  requireAdminLogin,
  requireRole("ADMIN"),
  accommodationManagerController.resendCredentials
);

// 2. Nghiệp vụ Accommodation thông thường
router.get("/", requireAdminLogin, accommodationController.getAccommodationsList);
router.get("/stats", requireAdminLogin, accommodationController.getAccommodationStats);
router.post(
  "/",
  requireAdminLogin,
  requireRole("ADMIN"),
  accommodationController.createAccommodation,
);
router.put("/:id", requireAdminLogin, accommodationController.updateAccommodation);
router.patch(
  "/:id/status",
  requireAdminLogin,
  accommodationController.updateAccommodationStatus,
);
router.patch(
  "/:id/featured",
  requireAdminLogin,
  accommodationController.updateAccommodationFeatured,
);
router.delete(
  "/:id",
  requireAdminLogin,
  requireRole("ADMIN"),
  accommodationController.deleteAccommodation,
);
router.get(
  "/:id/incidental-catalog",
  requireAdminLogin,
  requirePermission("bookings.read"),
  checkoutSettlementController.getIncidentalCatalog,
);
router.post(
  "/:id/incidental-catalog",
  requireAdminLogin,
  requirePermission("bookings.write"),
  checkoutSettlementController.createIncidentalCatalogItem,
);
router.get("/:id", requireAdminLogin, accommodationController.getAccommodationDetail);

// export
module.exports = router;

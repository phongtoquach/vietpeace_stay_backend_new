const express = require("express");
const router = express.Router();

const amenityController = require("../../controllers/admin/amenity/amenityController");
const requireAdminLogin = require("../../middlewares/requireAdminLogin");
const requirePermission = require("../../middlewares/requirePermission");
const requireRole = require("../../middlewares/requireRole");

router.get("/categories", requireAdminLogin, requirePermission("accommodations.read"), amenityController.getAmenityCategories);
router.get("/", requireAdminLogin, requirePermission("accommodations.read"), amenityController.getAmenitiesList);
router.post("/", requireAdminLogin, requireRole("ADMIN"), amenityController.createAmenity);
router.put("/:id", requireAdminLogin, requireRole("ADMIN"), amenityController.updateAmenity);

// Bật / tắt trạng thái tiện nghi
router.patch("/:id/status", requireAdminLogin, requireRole("ADMIN"), amenityController.toggleAmenityStatus);

// Bật / tắt tiện nghi nổi bật
router.patch("/:id/featured", requireAdminLogin, requireRole("ADMIN"), amenityController.toggleAmenityFeatured);

module.exports = router;
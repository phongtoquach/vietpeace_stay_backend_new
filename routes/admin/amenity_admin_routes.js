const express = require("express");
const router = express.Router();

const amenityController = require("../../controllers/admin/amenity/amenityController");
const requireAdminLogin = require("../../middlewares/requireAdminLogin");

router.get("/categories", requireAdminLogin, amenityController.getAmenityCategories);
router.get("/", requireAdminLogin, amenityController.getAmenitiesList);
router.post("/", requireAdminLogin, amenityController.createAmenity);
router.put("/:id", requireAdminLogin, amenityController.updateAmenity);

// Bật / tắt trạng thái tiện nghi
router.patch("/:id/status", requireAdminLogin, amenityController.toggleAmenityStatus);

// Bật / tắt tiện nghi nổi bật
router.patch("/:id/featured", requireAdminLogin, amenityController.toggleAmenityFeatured);

module.exports = router;
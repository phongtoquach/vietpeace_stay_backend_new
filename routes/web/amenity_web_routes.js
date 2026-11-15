/**
 * Các route này đều dùng cho các API có prefix /api/web/amenities/* : là các API để xử lý về amenity
 */

const express = require("express");
const router = express.Router();

const amenityWebController = require("../../controllers/web/amenity/amenityWebController");


router.get("/featured", amenityWebController.getFeaturedAmenities);

module.exports = router;
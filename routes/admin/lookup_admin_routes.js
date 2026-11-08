const express = require("express");
const controller = require("../../controllers/admin/lookup/lookupController");

const router = express.Router();

router.get("/accommodation-types", controller.getAccommodationTypes);
router.get("/provinces", controller.getProvinces);
router.get("/wards", controller.getWards);
router.get("/locations", controller.getLocations);
router.get("/amenities", controller.getAmenities);
router.get("/attractions", controller.getAttractions);

module.exports = router;

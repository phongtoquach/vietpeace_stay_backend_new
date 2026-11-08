/**
 * Các route này đều dùng cho các API có prefix /api/web/locations/* : là các API để lookup các tài nguyên data khác nhau trong hệ thống
 */

const express = require("express");
const router = express.Router();

const locationController = require("../../controllers/web/location/locationController");


// API lấy danh sách các featured locations
router.get("/featured-locations", locationController.listFeaturedLocations);


// export
module.exports = router;
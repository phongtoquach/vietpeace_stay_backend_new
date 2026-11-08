/**
 * Các route này đều dùng cho các API có prefix /api/web/lookup/* : là các API để lookup các tài nguyên data khác nhau trong hệ thống
 */

const express = require("express");
const router = express.Router();

const lookupController = require("../../controllers/web/lookupController");


// API lấy danh sách tất cả locations (destinations) va tất cả accommodations
router.get("/locations-and-accommodations", lookupController.getLocationsAndAccommdations);




// export
module.exports = router;
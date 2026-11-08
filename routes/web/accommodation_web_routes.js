/**
 * Các route này đều dùng cho các API có prefix /api/web/accommodations/* : là các API dành cho customer (user) đã login vào web
 */

const express = require("express");

const router = express.Router();

const accommodationController = require("../../controllers/web/accommodation/accommodationController");
const accommodationDetailController = require("../../controllers/web/accommodation/accommodationDetailController");


router.post("/search", accommodationController.searchAccommodations);

router.get("/detail/:accommodationId", accommodationDetailController.getAccommodationDetailByAccommodationId);


// export
module.exports = router;
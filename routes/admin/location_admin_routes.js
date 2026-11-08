const express = require("express");
const router = express.Router();

// Import controller
const locationController = require("../../controllers/admin/location/locationController");

// 1. API lấy danh sách tất cả điểm đến: GET /api/admin/locations
router.get("/", locationController.getLocationsList);

// 2. API lấy chi tiết 1 điểm đến theo id: GET /api/admin/locations/:id
router.get("/:id", locationController.getLocationDetail);

// 3. API thêm mới 1 điểm đến: POST /api/admin/locations
router.post("/", locationController.createLocation);

// 4. API cập nhật điểm đến: PUT /api/admin/locations/:id
router.put("/:id", locationController.updateLocation);

// 5. API xóa điểm đến: DELETE /api/admin/locations/:id
router.delete("/:id", locationController.deleteLocation);

module.exports = router;
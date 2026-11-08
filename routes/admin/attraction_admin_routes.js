const express = require("express");
const router = express.Router();

const attractionController = require("../../controllers/admin/attraction/attractionController");

// 1. Lấy danh sách điểm tham quan (có hỗ trợ lọc theo location_id, search, status, phân trang)
router.get("/", attractionController.getAttractionsList);

// 2. Lấy chi tiết 1 điểm tham quan
router.get("/:id", attractionController.getAttractionDetail);

// 3. Thêm mới 1 điểm tham quan
router.post("/", attractionController.createAttraction);

// 4. Cập nhật thông tin điểm tham quan
router.put("/:id", attractionController.updateAttraction);

// 5. Bật/tắt nhanh trạng thái hoạt động (Active <-> Inactive)
router.patch("/:id/status", attractionController.toggleAttractionStatus);

// 6. Xóa điểm tham quan
router.delete("/:id", attractionController.deleteAttraction);

module.exports = router;
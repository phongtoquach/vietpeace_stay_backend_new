const express = require("express");
const router = express.Router();

const roomTypeController = require("../../controllers/admin/room_type/roomTypeController");
const requirePermission = require("../../middlewares/requirePermission");

router.get("/", requirePermission("accommodations.read"), roomTypeController.getRoomTypesList);
router.post("/", requirePermission("accommodations.write"), roomTypeController.createRoomType);
router.get("/:id", requirePermission("accommodations.read"), roomTypeController.getRoomTypeDetail);
router.put("/:id", requirePermission("accommodations.write"), roomTypeController.updateRoomType);
router.delete("/:id", requirePermission("accommodations.delete"), roomTypeController.deleteRoomType);

module.exports = router;

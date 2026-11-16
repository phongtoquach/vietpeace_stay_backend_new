const express = require("express");
const router = express.Router();

const requireAdminLogin = require("../../middlewares/requireAdminLogin");
const requireRole = require("../../middlewares/requireRole");
const rolePermissionController = require("../../controllers/admin/roles/rolePermissionController");

// Lấy toàn bộ ma trận phân quyền từ DB (Chỉ Super Admin)
router.get("/permissions", requireAdminLogin, requireRole("ADMIN"), rolePermissionController.getRolePermissionsMatrix);

// Cập nhật ma trận phân quyền vào DB (Chỉ Super Admin)
router.put("/permissions", requireAdminLogin, requireRole("ADMIN"), rolePermissionController.updateRolePermissions);

module.exports = router;


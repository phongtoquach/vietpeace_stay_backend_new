const express = require("express");
const router = express.Router();

const requireAdminLogin = require("../../middlewares/requireAdminLogin");
const rolePermissionController = require("../../controllers/admin/roles/rolePermissionController");

// Lấy toàn bộ ma trận phân quyền từ DB
router.get("/permissions", requireAdminLogin, rolePermissionController.getRolePermissionsMatrix);

// Cập nhật ma trận phân quyền vào DB
router.put("/permissions", requireAdminLogin, rolePermissionController.updateRolePermissions);

module.exports = router;


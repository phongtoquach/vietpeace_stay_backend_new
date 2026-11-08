const permissionService = require("../../../services/permission_service");

/**
 * Lấy ma trận phân quyền hệ thống từ Database
 */
async function getRolePermissionsMatrix(req, res) {
    try {
        const matrix = await permissionService.getRolePermissionsMatrix();
        return res.status(200).json({
            success: true,
            data: matrix,
        });
    } catch (error) {
        console.error("[getRolePermissionsMatrix] error:", error);
        return res.status(500).json({
            success: false,
            message: "Không thể tải ma trận phân quyền từ cơ sở dữ liệu.",
        });
    }
}

/**
 * Cập nhật ma trận phân quyền của vai trò vào Database
 */
async function updateRolePermissions(req, res) {
    try {
        // Chỉ ADMIN mới có quyền sửa ma trận phân quyền
        if (req.currentAdmin?.role !== "ADMIN" && req.session?.admin?.role !== "ADMIN") {
            return res.status(403).json({
                success: false,
                message: "Bạn không có quyền thay đổi cấu hình phân quyền hệ thống.",
                errorCode: "FORBIDDEN",
            });
        }

        const { role = "ACCOMMODATION_MANAGER", permissions } = req.body || {};

        if (!permissions || typeof permissions !== "object") {
            return res.status(400).json({
                success: false,
                message: "Dữ liệu ma trận phân quyền không hợp lệ.",
            });
        }

        const result = await permissionService.updateRolePermissions(role, permissions);
        return res.status(200).json(result);
    } catch (error) {
        console.error("[updateRolePermissions] error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Không thể cập nhật ma trận phân quyền.",
        });
    }
}

module.exports = {
    getRolePermissionsMatrix,
    updateRolePermissions,
};


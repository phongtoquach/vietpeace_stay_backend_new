const userService = require("../../../services/user_admin_service");

/**
 * Lấy danh sách tài khoản quản trị
 */
async function listUsers(req, res) {
    try {
        const { search, role, status } = req.query || {};
        const items = await userService.listAdminUsers({ search, role, status });
        return res.status(200).json({
            success: true,
            message: "Lấy danh sách người dùng thành công.",
            data: { items },
        });
    } catch (error) {
        console.error("[listUsers] error:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            errorCode: error.errorCode || "INTERNAL_ERROR",
            message: error.message || "Lỗi khi lấy danh sách người dùng.",
        });
    }
}

/**
 * Thêm mới một Manager vào danh sách Manager
 */
async function createManager(req, res) {
    try {
        const { fullName, personalEmail, phoneNumber } = req.body || {};
        const created = await userService.createManagerUser({ fullName, personalEmail, phoneNumber });
        return res.status(201).json({
            success: true,
            message: "Đã thêm Manager vào danh sách thành công.",
            data: created,
        });
    } catch (error) {
        console.error("[createManager] error:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            errorCode: error.errorCode || "INTERNAL_ERROR",
            message: error.message || "Không thể thêm Manager lúc này.",
        });
    }
}

/**
 * Cập nhật thông tin tài khoản
 */
async function updateUser(req, res) {
    try {
        const userId = req.params.id;
        const { fullName, personalEmail, phoneNumber, status } = req.body || {};
        const updated = await userService.updateAdminUser(
            userId,
            { fullName, personalEmail, phoneNumber, status },
            req.currentAdmin
        );
        return res.status(200).json({
            success: true,
            message: "Cập nhật thông tin tài khoản thành công.",
            data: updated,
        });
    } catch (error) {
        console.error("[updateUser] error:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            errorCode: error.errorCode || "INTERNAL_ERROR",
            message: error.message || "Không thể cập nhật tài khoản.",
        });
    }
}

/**
 * Đổi trạng thái Hoạt động / Tạm khóa
 */
async function toggleStatus(req, res) {
    try {
        const userId = req.params.id;
        const result = await userService.toggleUserStatus(userId, req.currentAdmin);
        return res.status(200).json({
            success: true,
            message: result.message,
            data: result,
        });
    } catch (error) {
        console.error("[toggleStatus] error:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            errorCode: error.errorCode || "INTERNAL_ERROR",
            message: error.message || "Không thể đổi trạng thái tài khoản.",
        });
    }
}

/**
 * Đặt lại mật khẩu tài khoản
 */
async function resetPassword(req, res) {
    try {
        const userId = req.params.id;
        const { newPassword, sendEmail = true } = req.body || {};
        const result = await userService.resetUserPassword(userId, newPassword, req.currentAdmin, Boolean(sendEmail));
        return res.status(200).json({
            success: true,
            message: result.message,
            data: result,
        });
    } catch (error) {
        console.error("[resetPassword] error:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            errorCode: error.errorCode || "INTERNAL_ERROR",
            message: error.message || "Không thể đặt lại mật khẩu.",
        });
    }
}

/**
 * Xóa hoặc vô hiệu hóa tài khoản
 */
async function deleteUser(req, res) {
    try {
        const userId = req.params.id;
        const result = await userService.deleteAdminUser(userId, req.currentAdmin);
        return res.status(200).json({
            success: true,
            message: result.message,
            data: result,
        });
    } catch (error) {
        console.error("[deleteUser] error:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            errorCode: error.errorCode || "INTERNAL_ERROR",
            message: error.message || "Không thể xóa tài khoản.",
        });
    }
}

module.exports = {
    listUsers,
    createManager,
    updateUser,
    toggleStatus,
    resetPassword,
    deleteUser,
};

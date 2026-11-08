const managerService = require("../../../services/accommodation_manager_service");

/**
 * Super Admin: Xem tổng quan toàn bộ cơ sở và trạng thái Manager
 */
async function getManagersOverview(req, res) {
    try {
        const items = await managerService.getAccommodationsManagersOverview();
        return res.status(200).json({
            success: true,
            message: "Lấy danh sách phân công quản lý thành công.",
            data: { items }
        });
    } catch (error) {
        console.error("[getManagersOverview] error:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            errorCode: error.errorCode || "INTERNAL_ERROR",
            message: error.message || "Lỗi khi lấy danh sách phân công quản lý."
        });
    }
}

/**
 * Super Admin: Phân công Manager cho cơ sở lưu trú
 */
async function assignManager(req, res) {
    try {
        const accommodationId = Number(req.params.id);
        const { managerId, fullName, personalEmail, phoneNumber } = req.body || {};

        const result = await managerService.assignAccommodationManager(
            accommodationId,
            { managerId, fullName, personalEmail, phoneNumber },
            req.currentAdmin
        );

        return res.status(201).json({
            success: true,
            message: result.emailSent
                ? "Đã phân công quản lý. Máy chủ email đã chấp nhận thư bàn giao."
                : "Đã phân công quản lý nhưng chưa gửi được email. Vui lòng gửi lại thông tin bàn giao.",
            data: result
        });
    } catch (error) {
        console.error("[assignManager] error:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            errorCode: error.errorCode || "INTERNAL_ERROR",
            message: error.message || "Không thể phân công quản lý lúc này."
        });
    }
}

/**
 * Super Admin: Thu hồi quyền Manager
 */
async function revokeManager(req, res) {
    try {
        const accommodationId = Number(req.params.id);
        const result = await managerService.revokeAccommodationManager(accommodationId, req.body || {}, req.currentAdmin);

        return res.status(200).json({
            success: true,
            message: result.emailSent
                ? "Đã thu hồi quyền cũ và bàn giao cho Manager thay thế. Máy chủ email đã chấp nhận thư."
                : "Đã thay thế Manager nhưng chưa gửi được email. Vui lòng gửi lại thông tin bàn giao.",
            data: result,
        });
    } catch (error) {
        console.error("[revokeManager] error:", error);
        return res.status(error.statusCode || 500).json({
            success: false,
            errorCode: error.errorCode || "INTERNAL_ERROR",
            message: error.message || "Không thể gỡ quyền quản lý lúc này."
        });
    }
}

async function resendCredentials(req, res) {
    try {
        const result = await managerService.resendManagerCredentials(req.params.id, req.body?.expectedManagerId, req.currentAdmin);
        return res.status(result.emailSent ? 200 : 502).json({
            success: result.emailSent,
            message: result.emailSent
                ? "Máy chủ email đã chấp nhận thư gửi lại. Vui lòng kiểm tra cả thư rác."
                : "Chưa gửi được email. Vui lòng kiểm tra cấu hình SMTP và thử lại.",
            data: result,
        });
    } catch (error) {
        return res.status(error.statusCode || 500).json({
            success: false, errorCode: error.errorCode || "INTERNAL_ERROR",
            message: error.statusCode ? error.message : "Không thể gửi lại thông tin bàn giao lúc này.",
        });
    }
}

module.exports = {
    getManagersOverview,
    assignManager,
    revokeManager,
    resendCredentials,
};

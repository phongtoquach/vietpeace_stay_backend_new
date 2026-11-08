const permissionService = require("../services/permission_service");

/**
 * Middleware kiểm tra động quyền hạn dựa trên Database
 * @param {string} permissionKey Mã quyền cần kiểm tra, ví dụ: 'accommodations.write'
 */
function requirePermission(permissionKey) {
    return async function (req, res, next) {
        const userRole = req.currentAdmin?.role || req.session?.admin?.role;

        if (!userRole) {
            return res.status(401).json({
                success: false,
                message: "Vui lòng đăng nhập vào hệ thống quản trị.",
                errorCode: "UNAUTHENTICATED",
            });
        }

        // Quản trị viên cấp cao (ADMIN) luôn có toàn quyền
        if (userRole === "ADMIN") {
            return next();
        }

        try {
            const grantedPermissions = await permissionService.getGrantedPermissionsForRole(userRole);

            if (!grantedPermissions.includes(permissionKey)) {
                return res.status(403).json({
                    success: false,
                    message: `Tài khoản của bạn chưa được cấp quyền thực hiện hành động này (${permissionKey}).`,
                    errorCode: "PERMISSION_DENIED",
                    requiredPermission: permissionKey,
                });
            }

            return next();
        } catch (error) {
            console.error(`[requirePermission] error checking ${permissionKey}:`, error);
            return res.status(500).json({
                success: false,
                message: "Lỗi kiểm tra quyền hạn hệ thống.",
            });
        }
    };
}

module.exports = requirePermission;


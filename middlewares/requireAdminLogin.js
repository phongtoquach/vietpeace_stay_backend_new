const authService = require("../services/auth_service");

const ADMIN_SESSION_COOKIE_NAME = "vietpeace.admin.sid";
const ADMIN_SESSION_COOKIE_PATH = "/api/admin";

function sendUnauthenticated(res) {
    return res.status(401).json({
        success: false,
        message: "Vui lòng đăng nhập vào Admin Panel",
        errorCode: "UNAUTHENTICATED",
    });
}

async function revokeAdminSession(req, res) {
    await new Promise((resolve) => {
        req.session.destroy(() => resolve());
    });

    res.clearCookie(ADMIN_SESSION_COOKIE_NAME, {
        path: ADMIN_SESSION_COOKIE_PATH,
    });
}

async function requireAdminLogin(req, res, next) {
    if (!req.session?.admin?.id) {
        return sendUnauthenticated(res);
    }

    try {
        if (!req.currentAdmin) {
            const currentAdmin = await authService.getAdminUserById(req.session.admin.id);

            const sessionIsValid =
                currentAdmin &&
                req.session.admin.email === currentAdmin.email &&
                currentAdmin.status === 1 &&
                authService.isAdminPanelRole(currentAdmin.role) &&
                !currentAdmin.isRevoked;

            // User bị xóa, inactive hoặc mất role/bị thu hồi quyền quản lý: thu hồi phiên ngay lập tức.
            if (!sessionIsValid) {
                await revokeAdminSession(req, res);
                return sendUnauthenticated(res);
            }

            // Đồng bộ session
            req.session.admin.fullName = currentAdmin.full_name;
            req.session.admin.displayName = currentAdmin.display_name;
            req.session.admin.personalEmail = currentAdmin.personal_email;
            req.session.admin.role = currentAdmin.role;
            req.session.admin.status = currentAdmin.status;
            req.session.admin.mustChangePassword = Boolean(currentAdmin.must_change_password);
            req.session.admin.accommodationId = currentAdmin.accommodationId ?? null;
            req.session.admin.accommodationName = currentAdmin.accommodationName ?? null;
            req.currentAdmin = currentAdmin;
        }

        // BẢO MẬT: Chặn mọi request nghiệp vụ nếu tài khoản chưa đổi mật khẩu tạm thời
        if (req.currentAdmin.must_change_password === true || req.session.admin.mustChangePassword === true) {
            const currentPath = (req.originalUrl || req.url || "").split("?")[0];
            const isAllowed =
                currentPath.endsWith("/auth/change-initial-password") ||
                currentPath.endsWith("/auth/logout") ||
                currentPath.endsWith("/auth/loggedin-user");

            if (!isAllowed) {
                return res.status(403).json({
                    success: false,
                    errorCode: "REQUIRE_PASSWORD_CHANGE",
                    message: "Bạn đang sử dụng mật khẩu tạm thời. Vui lòng đổi mật khẩu mới để tiếp tục sử dụng hệ thống.",
                });
            }
        }

        return next();
    } catch (error) {
        console.error("[requireAdminLogin] admin lookup failed:", error.code || error.message || "UNKNOWN");

        return res.status(500).json({
            success: false,
            message: "Không thể xác thực phiên đăng nhập.",
            errorCode: "AUTH_LOOKUP_FAILED",
        });
    }
}

module.exports = requireAdminLogin;

const authService = require("../../../services/auth_service");
const permissionService = require("../../../services/permission_service");
const { revokeUserAccess } = require("../../../services/chat/identity");
const { triggerOutboxDrain } = require("../../../services/chat/runtime");

const ADMIN_LOGIN_ERROR_HTTP_STATUS = {
    REQUEST_BODY_INVALID: 400,
    LOGIN_AUDIENCE_INVALID: 400,
    DATA_INVALID: 400,
    USER_EMAIL_NOT_EXISTED: 401,
    WRONG_PASSWORD: 401,
    EMAIL_NOT_VERIFIED: 403,
    ACCOUNT_INACTIVE: 403,
    ACCOUNT_STATUS_INVALID: 403,
    LOGIN_FORBIDDEN: 403,
    ACCOMMODATION_NOT_ASSIGNED: 403,
};

const ADMIN_FORGOT_PASSWORD_ERROR_HTTP_STATUS = {
    DATA_INVALID: 400,
    USER_EMAIL_NOT_EXISTED: 404,
    ACCOUNT_INACTIVE: 403,
    ACCOUNT_STATUS_INVALID: 403,
    ACCOMMODATION_NOT_ASSIGNED: 403,
    FORGOT_PASSWORD_TOO_FREQUENT: 429,
    EMAIL_DELIVERY_FAILED: 502,
};

const ADMIN_PROFILE_ERROR_HTTP_STATUS = {
    UNAUTHENTICATED: 401,
    DATA_INVALID: 400,
    USER_NOT_FOUND: 404,
    ACCOUNT_INACTIVE: 403,
    EMAIL_ALREADY_EXISTS: 409,
    PHONE_ALREADY_EXISTS: 409,
    WRONG_CURRENT_PASSWORD: 400,
};

async function login(req, res) {
    try {
        const loginResult = await authService.login(req.body, "admin");

        if (!loginResult.success) {
            const statusCode = ADMIN_LOGIN_ERROR_HTTP_STATUS[loginResult.errorCode] ?? 400;
            return res.status(statusCode).json({
                success: false,
                message: loginResult.errorMsg,
                errorCode: loginResult.errorCode,
                errors: loginResult.errors || {},
            });
        }

        // Đổi session ID sau khi xác thực thành công.
        await new Promise((resolve, reject) => {
            req.session.regenerate((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });

        // Lấy danh sách quyền hạn được cấp từ DB
        const permissions = await permissionService.getGrantedPermissionsForRole(loginResult.user.role);

        // chuẩn bị login user data
        const loginUserData = {
            id: loginResult.user.id,
            email: loginResult.user.email,
            personalEmail: loginResult.user.personal_email || null,
            phoneNumber: loginResult.user.phone_number || "",
            fullName: loginResult.user.full_name,
            displayName: loginResult.user.display_name,
            role: loginResult.user.role,
            status: loginResult.user.status,
            mustChangePassword: Boolean(loginResult.user.must_change_password),
            accommodationId: loginResult.user.accommodationId ?? null,
            accommodationName: loginResult.user.accommodationName ?? null,
            permissions: permissions,
        };

        if (req.session.cookie && typeof req.body?.rememberMe === "boolean") {
            if (req.body.rememberMe) {
                req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000; // 7 ngày
            } else {
                req.session.cookie.expires = false;
            }
        }

        // tạo session admin (đây là session authen)
        req.session.admin = loginUserData;

        // Chờ lưu session thành công rồi mới trả response.
        await new Promise((resolve, reject) => {
            req.session.save((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });

        return res.status(200).json({
            success: true,
            message: "Đăng nhập thành công",
            data: {
                loginUserData: loginUserData
            }
        });
    } catch (error) {
        console.error("[admin authController - login] error:", error);
        return res.status(500).json({
            success: false,
            message: "Đã có lỗi xảy ra trong quá trình đăng nhập. Vui lòng thử lại sau.",
            errorCode: "INTERNAL_ERROR",
            errors: {},
        });
    }
}

async function getLoggedInAdminUser(req, res) {
    if (req.session?.admin?.role) {
        req.session.admin.permissions = await permissionService.getGrantedPermissionsForRole(req.session.admin.role);
    }
    return res.json({
        success: true,
        message: "Get logged-in admin user successfully",
        data: {
            userInfo: req.session.admin
        }
    });
}

/**
 * Quên mật khẩu cho Admin & Manager qua Gmail cá nhân
 */
async function forgotPassword(req, res) {
    try {
        const result = await authService.forgotAdminPortalPassword(req.body);

        if (!result.success) {
            const statusCode = ADMIN_FORGOT_PASSWORD_ERROR_HTTP_STATUS[result.errorCode] ?? 400;
            return res.status(statusCode).json({
                success: false,
                message: result.errorMsg,
                errorCode: result.errorCode,
                errors: result.errors || {},
                data: result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : undefined,
            });
        }

        return res.status(200).json({
            success: true,
            message: result.message,
            data: {
                personalEmail: result.personalEmail,
                cooldownSeconds: result.cooldownSeconds,
            },
        });
    } catch (error) {
        console.error("[admin authController - forgotPassword] error:", error);
        return res.status(500).json({
            success: false,
            message: "Không thể xử lý yêu cầu khôi phục mật khẩu lúc này. Vui lòng thử lại sau.",
            errorCode: "INTERNAL_ERROR",
            errors: {},
        });
    }
}

/**
 * Đổi mật khẩu lần đầu (bắt buộc khi dùng mật khẩu tạm)
 */
async function changeInitialPassword(req, res) {
    try {
        const userId = req.session?.admin?.id;
        const { newPassword } = req.body || {};

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Vui lòng đăng nhập vào Admin Panel.",
                errorCode: "UNAUTHENTICATED"
            });
        }

        const result = await authService.changeInitialPassword(userId, newPassword);

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.errorMsg,
                errorCode: result.errorCode,
                errors: result.errors || {}
            });
        }

        // Cập nhật session: gỡ cờ bắt buộc đổi mật khẩu
        req.session.admin.mustChangePassword = false;
        if (req.currentAdmin) {
            req.currentAdmin.must_change_password = false;
        }

        await new Promise((resolve) => req.session.save(() => resolve()));

        return res.status(200).json({
            success: true,
            message: result.message,
            data: {
                mustChangePassword: false
            }
        });
    } catch (error) {
        console.error("[changeInitialPassword] error:", error);
        return res.status(500).json({
            success: false,
            message: "Không thể đổi mật khẩu lúc này. Vui lòng thử lại sau.",
            errorCode: "INTERNAL_ERROR"
        });
    }
}

/**
 * Đổi mật khẩu chủ động trong phiên làm việc (yêu cầu mật khẩu hiện tại)
 */
async function changePassword(req, res) {
    try {
        const userId = req.session?.admin?.id;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Vui lòng đăng nhập vào Admin Panel.",
                errorCode: "UNAUTHENTICATED",
            });
        }

        const result = await authService.changeAdminPassword(userId, req.body);
        if (!result.success) {
            const statusCode = ADMIN_PROFILE_ERROR_HTTP_STATUS[result.errorCode] ?? 400;
            return res.status(statusCode).json({
                success: false,
                message: result.errorMsg,
                errorCode: result.errorCode,
                errors: result.errors || {},
            });
        }

        req.session.admin.mustChangePassword = false;
        if (req.currentAdmin) {
            req.currentAdmin.must_change_password = false;
        }
        await new Promise((resolve) => req.session.save(() => resolve()));

        return res.status(200).json({
            success: true,
            message: result.message,
        });
    } catch (error) {
        console.error("[admin authController - changePassword] error:", error);
        return res.status(500).json({
            success: false,
            message: "Không thể đổi mật khẩu lúc này. Vui lòng thử lại sau.",
            errorCode: "INTERNAL_ERROR",
        });
    }
}

/**
 * Cập nhật hồ sơ cá nhân của Admin / Manager đang đăng nhập (bao gồm bổ sung Gmail cá nhân)
 */
async function updateProfile(req, res) {
    try {
        const userId = req.session?.admin?.id;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Vui lòng đăng nhập vào Admin Panel.",
                errorCode: "UNAUTHENTICATED",
            });
        }

        const result = await authService.updateAdminOwnProfile(userId, req.body);
        if (!result.success) {
            const statusCode = ADMIN_PROFILE_ERROR_HTTP_STATUS[result.errorCode] ?? 400;
            return res.status(statusCode).json({
                success: false,
                message: result.errorMsg,
                errorCode: result.errorCode,
                errors: result.errors || {},
            });
        }

        req.session.admin.fullName = result.data.fullName;
        req.session.admin.displayName = result.data.displayName;
        req.session.admin.phoneNumber = result.data.phoneNumber;
        req.session.admin.personalEmail = result.data.personalEmail;

        if (req.currentAdmin) {
            req.currentAdmin.full_name = result.data.fullName;
            req.currentAdmin.display_name = result.data.displayName;
            req.currentAdmin.phone_number = result.data.phoneNumber;
            req.currentAdmin.personal_email = result.data.personalEmail;
        }

        await new Promise((resolve) => req.session.save(() => resolve()));

        return res.status(200).json({
            success: true,
            message: result.message,
            data: {
                userInfo: req.session.admin,
            },
        });
    } catch (error) {
        console.error("[admin authController - updateProfile] error:", error);
        return res.status(500).json({
            success: false,
            message: "Không thể cập nhật hồ sơ cá nhân lúc này. Vui lòng thử lại sau.",
            errorCode: "INTERNAL_ERROR",
        });
    }
}

async function logout(req, res) {
    const adminId = req.session?.admin?.id || null;
    req.session.destroy(async (err) => {
        if (err) {
            console.log("[logout] Xoa session that bai ! Error : ", err);
            return res.status(500).json({
                success: false,
                message: err
            });
        }

        if (adminId) {
            await revokeUserAccess(null, adminId, "LOGOUT", { audience: "admin" }).catch(() => {});
            triggerOutboxDrain();
        }

        console.log("[logout] Xoa session thanh cong !");
        console.log("[logout] Xoa cookie vietpeace.admin.sid !");
        res.clearCookie("vietpeace.admin.sid", {
            path: "/api/admin",
        });

        return res.status(200).json({
            success: true,
            message: "Đăng xuất user khỏi Admin Panel thành công",
        });
    });
}

async function resetPassword(_req, res) {
    return res.status(400).json({
        success: false,
        errorCode: "USE_FORGOT_PASSWORD",
        message: "Vui lòng dùng chức năng Quên mật khẩu bằng Gmail cá nhân để nhận thông tin đăng nhập mới.",
    });
}

module.exports = {
    login,
    forgotPassword,
    getLoggedInAdminUser,
    changeInitialPassword,
    changePassword,
    updateProfile,
    logout,
    resetPassword,
};

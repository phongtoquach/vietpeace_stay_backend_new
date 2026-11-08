const authService = require("../../../services/auth_service");
const permissionService = require("../../../services/permission_service");

async function login(req, res) {
    console.log("[authController - login] Value của req.body : ", req.body);

    const loginResult = await authService.login(req.body, "admin");
    console.log("[authController - login] Ket qua hàm authService.login() : ", loginResult);

    if (!loginResult.success) {
        return res.json({
            success: false,
            message: loginResult.errorMsg,
            errorCode: loginResult.errorCode,
            errors: loginResult.errors
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
        personalEmail: loginResult.user.personal_email,
        fullName: loginResult.user.full_name,
        displayName: loginResult.user.display_name,
        role: loginResult.user.role,
        status: loginResult.user.status,
        mustChangePassword: Boolean(loginResult.user.must_change_password),
        accommodationId: loginResult.user.accommodationId ?? null,
        accommodationName: loginResult.user.accommodationName ?? null,
        permissions: permissions,
    };

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
                errors: result.errors
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

async function logout(req, res) {
    req.session.destroy((err) => {
        if (err) {
            console.log("[logout] Xoa session that bai ! Error : ", err);
            return res.status(500).json({
                success: false,
                message: err
            });
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

async function resetPassword(req, res) {
    res.json({
        success: true,
        message: "Đặt lại mật khẩu thành công.",
    });
}

module.exports = {
    login,
    getLoggedInAdminUser,
    changeInitialPassword,
    logout,
    resetPassword,
};

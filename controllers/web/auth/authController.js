const authService = require("../../../services/auth_service");
const { revokeUserAccess } = require("../../../services/chat/identity");
const { triggerOutboxDrain } = require("../../../services/chat/runtime");


async function login(req, res) {
    console.log("[authController - login] Value của req.body : ", req.body);

    const loginResult = await authService.login(req.body, "web");
    console.log("[authController - login] Ket qua hàm authService.login() : ", loginResult);

    if (!loginResult.success) {
        //const statusCode = LOGIN_ERROR_HTTP_STATUS[result.errorCode] ?? 400;
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

    
    // chuẩn bị login user data
    const customerData = {
        id: loginResult.user.id,
        email: loginResult.user.email,
        fullName: loginResult.user.full_name,
        displayName: loginResult.user.display_name,
        role: loginResult.user.role,
        status: loginResult.user.status
    };

    // tạo session customer (đây là session authen)
    req.session.customer = customerData;
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
            loginCustomerInfo: customerData,
        }
    });
}


const REGISTER_ERROR_HTTP_STATUS = {
    DATA_INVALID: 400,
    EMAIL_ALREADY_EXISTS: 409,
};

const VERIFY_EMAIL_ERROR_HTTP_STATUS = {
    INVALID_VERIFICATION_TOKEN: 400,
    VERIFICATION_TOKEN_NOT_FOUND: 400,
    VERIFICATION_NOT_ALLOWED: 400,
    VERIFICATION_TOKEN_USED: 400,
    VERIFICATION_TOKEN_REVOKED: 400,
    VERIFICATION_TOKEN_EXPIRED: 400,
    ACCOUNT_INACTIVE: 403,
};

const RESEND_VERIFICATION_ERROR_HTTP_STATUS = {
    DATA_INVALID: 400,
    VERIFICATION_NOT_ALLOWED: 400,
    ACCOUNT_INACTIVE: 403,
    USER_EMAIL_NOT_EXISTED: 404,
    EMAIL_ALREADY_VERIFIED: 409,
    VERIFICATION_RESEND_TOO_FREQUENT: 429,
    EMAIL_DELIVERY_FAILED: 502,
};


async function register(req, res) {
    try {
        const result = await authService.register(req.body);

        if (!result.success) {
            const statusCode = REGISTER_ERROR_HTTP_STATUS[result.errorCode] ?? 400;
            return res.status(statusCode).json({
                success: false,
                message: result.errorMsg,
                errorCode: result.errorCode,
                errors: result.errors || {},
            });
        }

        return res.status(201).json({
            success: true,
            message: result.message,
            data: {
                customer: {
                    id: result.user.id,
                    email: result.user.email,
                    fullName: result.user.full_name,
                    displayName: result.user.display_name,
                    phoneNumber: result.user.phone_number,
                    status: result.user.status,
                },
                requiresEmailVerification: true,
                emailSent: result.emailSent,
                expiresInHours: result.expiresInHours,
            },
        });
    } catch (error) {
        console.error("[authController - register] Error:", error);
        return res.status(500).json({
            success: false,
            message: "Đã có lỗi xảy ra khi đăng ký tài khoản. Vui lòng thử lại sau.",
            errorCode: "INTERNAL_ERROR",
        });
    }
}


async function verifyEmail(req, res) {
    try {
        const result = await authService.verifyCustomerEmail(req.body?.token);

        if (!result.success) {
            const statusCode = VERIFY_EMAIL_ERROR_HTTP_STATUS[result.errorCode] ?? 400;
            return res.status(statusCode).json({
                success: false,
                message: result.errorMsg,
                errorCode: result.errorCode,
                data: result.email ? { email: result.email } : undefined,
            });
        }

        return res.status(200).json({
            success: true,
            message: result.message,
            data: {
                email: result.email,
                alreadyVerified: Boolean(result.alreadyVerified),
            },
        });
    } catch (error) {
        console.error("[authController - verifyEmail] Error:", error);
        return res.status(500).json({
            success: false,
            message: "Đã có lỗi xảy ra khi xác thực email. Vui lòng thử lại sau.",
            errorCode: "INTERNAL_ERROR",
        });
    }
}


async function resendVerification(req, res) {
    try {
        const result = await authService.resendCustomerVerificationEmail(req.body);

        if (!result.success) {
            const statusCode = RESEND_VERIFICATION_ERROR_HTTP_STATUS[result.errorCode] ?? 400;
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
                email: result.email,
                expiresInHours: result.expiresInHours,
                cooldownSeconds: result.cooldownSeconds,
            },
        });
    } catch (error) {
        console.error("[authController - resendVerification] Error:", error);
        return res.status(500).json({
            success: false,
            message: "Đã có lỗi xảy ra khi gửi lại email xác thực. Vui lòng thử lại sau.",
            errorCode: "INTERNAL_ERROR",
        });
    }
}


async function getLoggedInUser(req, res) {
    return res.json({
        success: true,
        message: "Get logged-in user successfully",
        data: {
            customerInfo: req.session.customer
        }
    });
}


async function logout(req, res) {
    const customerId = req.session?.customer?.id || null;
    req.session.destroy(async (err) => {
        if (err) {
            console.log("[logout] Xoa session that bai ! Error : ", err);
            return res.status(500).json({
                success: false,
                message: err
            });
        }

        if (customerId) {
            await revokeUserAccess(null, customerId, "LOGOUT", { audience: "web" }).catch(() => {});
            triggerOutboxDrain();
        }

        console.log("[logout] Xoa session thanh cong !");

        console.log("[logout] Xoa cookie vietpeace.customer.sid !");
        res.clearCookie("vietpeace.customer.sid",
            {
                path: "/api/web",
            }
        );

        console.log("[logout] Return voi status code 200 & message thong bao logout thanh cong !");
        return res.status(200).json({
            success: true,
            message: "Đăng xuất customer khỏi web thành công",
        });
    });
}


// async function forgotPassword(req, res) {
//     try {
//         // TODO:
//         // 1. nhận email
//         // 2. kiểm tra customer
//         // 3. tạo reset token
//         // 4. lưu token
//         // 5. gửi email

//         res.json({
//             success: true,
//             message:
//                 "Nếu email tồn tại, hướng dẫn đặt lại mật khẩu đã được gửi.",
//         });

//     } catch (error) {
//         return res.status(302).json({
//             success: false,
//             message: "Loggedin user not found !"
//         });
//     }
// }


async function resetPassword(req, res) {
    try {
        // TODO:
        // 1. verify token
        // 2. hash password mới
        // 3. update DB
        // 4. invalidate reset token

        res.json({
            success: true,
            message:
                "Đặt lại mật khẩu thành công.",
        });

    } catch (error) {
        return res.status(404).json({
            success: false,
            message: "Loggedin user not found !"
        });
    }
}


module.exports = {
    login,
    register,
    verifyEmail,
    resendVerification,
    getLoggedInUser,
    logout,
    resetPassword,
};
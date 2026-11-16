const authService = require("../../../services/auth_service");
const captchaService = require("../../../services/captcha_service");
const { revokeUserAccess } = require("../../../services/chat/identity");
const { triggerOutboxDrain } = require("../../../services/chat/runtime");

function resolveClientIp(req) {
    // Express resolves trusted proxies according to app.set('trust proxy').
    // Never trust a client-supplied forwarded header directly.
    return req?.ip || req?.socket?.remoteAddress || "unknown";
}

const LOGIN_ERROR_HTTP_STATUS = {
    REQUEST_BODY_INVALID: 400,
    LOGIN_AUDIENCE_INVALID: 400,
    DATA_INVALID: 400,
    INVALID_VERIFICATION_CODE: 400,
    VERIFICATION_CODE_INCORRECT: 400,
    VERIFICATION_CODE_USED: 400,
    VERIFICATION_CODE_REVOKED: 400,
    VERIFICATION_CODE_EXPIRED: 400,
    VERIFICATION_CODE_NOT_READY: 400,
    VERIFICATION_CODE_ATTEMPTS_EXCEEDED: 429,
    USER_EMAIL_NOT_EXISTED: 401,
    WRONG_PASSWORD: 401,
    EMAIL_VERIFICATION_CODE_REQUIRED: 403,
    EMAIL_NOT_VERIFIED: 403,
    ACCOUNT_INACTIVE: 403,
    ACCOUNT_STATUS_INVALID: 403,
    LOGIN_FORBIDDEN: 403,
};

const REGISTER_ERROR_HTTP_STATUS = {
    DATA_INVALID: 400,
    EMAIL_ALREADY_EXISTS: 409,
    VERIFICATION_RESEND_TOO_FREQUENT: 429,
};

const VERIFY_EMAIL_ERROR_HTTP_STATUS = {
    DATA_INVALID: 400,
    INVALID_VERIFICATION_CODE: 400,
    VERIFICATION_CODE_INCORRECT: 400,
    VERIFICATION_CODE_USED: 400,
    VERIFICATION_CODE_REVOKED: 400,
    VERIFICATION_CODE_EXPIRED: 400,
    VERIFICATION_CODE_NOT_READY: 400,
    VERIFICATION_CODE_ATTEMPTS_EXCEEDED: 429,
    INVALID_VERIFICATION_TOKEN: 400,
    VERIFICATION_TOKEN_NOT_FOUND: 400,
    VERIFICATION_NOT_ALLOWED: 400,
    VERIFICATION_TOKEN_USED: 400,
    VERIFICATION_TOKEN_REVOKED: 400,
    VERIFICATION_TOKEN_EXPIRED: 400,
    USER_EMAIL_NOT_EXISTED: 404,
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

const FORGOT_PASSWORD_ERROR_HTTP_STATUS = {
    DATA_INVALID: 400,
    FORGOT_PASSWORD_NOT_ALLOWED: 400,
    ACCOUNT_INACTIVE: 403,
    USER_EMAIL_NOT_EXISTED: 404,
    FORGOT_PASSWORD_TOO_FREQUENT: 429,
    EMAIL_DELIVERY_FAILED: 502,
};

async function getCaptcha(req, res) {
    try {
        const clientIp = resolveClientIp(req);
        const rateCheck = captchaService.checkRateLimit("captcha_issue", clientIp, {
            maxHits: 80,
            windowMs: 5 * 60 * 1000,
        });

        if (!rateCheck.allowed) {
            return res.status(429).json({
                success: false,
                errorCode: "TOO_MANY_REQUESTS",
                message: `Bạn thao tác quá nhanh. Vui lòng thử lại sau ${rateCheck.retryAfterSeconds} giây.`,
                data: { retryAfterSeconds: rateCheck.retryAfterSeconds },
            });
        }

        const challenge = captchaService.createChallenge(clientIp);
        res.set("Cache-Control", "no-store");
        return res.status(200).json({
            success: true,
            data: challenge,
        });
    } catch (error) {
        console.error("[authController - getCaptcha] Error:", error);
        return res.status(500).json({
            success: false,
            errorCode: "INTERNAL_ERROR",
            message: "Không thể khởi tạo mã captcha. Vui lòng thử lại.",
        });
    }
}

async function verifyCaptcha(req, res) {
    try {
        const clientIp = resolveClientIp(req);
        const rateCheck = captchaService.checkRateLimit("captcha_verify", clientIp, {
            maxHits: 80,
            windowMs: 5 * 60 * 1000,
        });

        if (!rateCheck.allowed) {
            return res.status(429).json({
                success: false,
                errorCode: "TOO_MANY_REQUESTS",
                message: `Bạn thử xác thực captcha quá nhiều lần. Vui lòng đợi ${rateCheck.retryAfterSeconds} giây.`,
                data: { retryAfterSeconds: rateCheck.retryAfterSeconds, shouldRefresh: true },
            });
        }

        const result = captchaService.verifyChallenge(req.body || {}, clientIp);
        if (!result.success) {
            return res.status(400).json({
                success: false,
                errorCode: result.errorCode,
                message: result.message,
                data: {
                    shouldRefresh: Boolean(result.shouldRefresh),
                },
            });
        }

        return res.status(200).json({
            success: true,
            message: result.message,
            data: {
                captchaToken: result.captchaToken,
                expiresAt: result.expiresAt,
            },
        });
    } catch (error) {
        console.error("[authController - verifyCaptcha] Error:", error);
        return res.status(500).json({
            success: false,
            errorCode: "INTERNAL_ERROR",
            message: "Đã có lỗi xảy ra khi kiểm tra captcha.",
        });
    }
}

async function login(req, res) {
    try {
        const clientIp = resolveClientIp(req);
        const rateCheck = captchaService.checkRateLimit("customer_login", clientIp, {
            maxHits: 45,
            windowMs: 5 * 60 * 1000,
        });

        if (!rateCheck.allowed) {
            return res.status(429).json({
                success: false,
                errorCode: "TOO_MANY_REQUESTS",
                message: `Phát hiện quá nhiều lượt đăng nhập liên tiếp. Vui lòng thử lại sau ${rateCheck.retryAfterSeconds} giây.`,
                errors: {},
                data: { retryAfterSeconds: rateCheck.retryAfterSeconds },
            });
        }

        const invalidInput = authService.validateCustomerLoginInput(req.body);
        if (invalidInput) {
            return res.status(400).json({ success: false, message: invalidInput.errorMsg,
                errorCode: invalidInput.errorCode, errors: invalidInput.errors || {}, data: { captchaConsumed: false } });
        }
        if (req.body?.rememberMe !== undefined && typeof req.body.rememberMe !== "boolean") {
            return res.status(400).json({ success: false, errorCode: "DATA_INVALID",
                message: "Lựa chọn ghi nhớ đăng nhập không hợp lệ.", data: { captchaConsumed: false } });
        }
        const captchaToken = req.body?.captchaToken || req.body?.captcha_token;
        const captchaCheck = captchaService.consumeVerifiedCaptcha(captchaToken);
        if (!captchaCheck.valid) {
            return res.status(400).json({
                success: false,
                message: captchaCheck.message,
                errorCode: captchaCheck.errorCode,
                errors: { captcha: captchaCheck.message },
                data: { captchaInvalid: true },
            });
        }

        const rememberMe = Boolean(req.body?.rememberMe);
        const loginResult = await authService.login(req.body, "web");

        if (!loginResult.success) {
            const statusCode = LOGIN_ERROR_HTTP_STATUS[loginResult.errorCode] ?? 400;
            return res.status(statusCode).json({
                success: false,
                message: loginResult.errorMsg,
                errorCode: loginResult.errorCode,
                errors: loginResult.errors || {},
                data: {
                    requiresVerificationCode: Boolean(loginResult.requiresVerificationCode),
                    email: loginResult.email || undefined,
                },
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

        const customerData = {
            id: loginResult.user.id,
            email: loginResult.user.email,
            fullName: loginResult.user.full_name,
            displayName: loginResult.user.display_name,
            phoneNumber: loginResult.user.phone_number || "",
            role: loginResult.user.role,
            status: loginResult.user.status,
        };

        if (req.session.cookie) {
            if (rememberMe) {
                req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 ngày
            } else {
                // Không tick "Ghi nhớ tài khoản và mật khẩu": dùng session cookie hết hạn khi đóng trình duyệt
                req.session.cookie.expires = false;
            }
        }

        req.session.customer = customerData;
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
            message: loginResult.activatedOnFirstLogin
                ? "Kích hoạt tài khoản và đăng nhập thành công"
                : "Đăng nhập thành công",
            data: {
                loginCustomerInfo: customerData,
                activatedOnFirstLogin: Boolean(loginResult.activatedOnFirstLogin),
                rememberMe,
            },
        });
    } catch (error) {
        console.error("[authController - login] Error:", error);
        return res.status(500).json({
            success: false,
            message: "Đã có lỗi xảy ra trong quá trình đăng nhập. Vui lòng thử lại sau.",
            errorCode: "INTERNAL_ERROR",
        });
    }
}

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
                data: result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : undefined,
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
                verificationMethod: "FIRST_LOGIN_CODE",
                emailSent: result.emailSent,
                cooldownSeconds: result.cooldownSeconds,
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
        const input = req.body?.code !== undefined
            ? { email: req.body?.email, code: req.body?.code }
            : req.body?.token;

        const result = await authService.verifyCustomerEmail(input);

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
            message: "Đã có lỗi xảy ra khi gửi lại mã xác nhận. Vui lòng thử lại sau.",
            errorCode: "INTERNAL_ERROR",
        });
    }
}

async function forgotPassword(req, res) {
    try {
        const clientIp = resolveClientIp(req);
        const rateCheck = captchaService.checkRateLimit("forgot_password", clientIp, {
            maxHits: 25,
            windowMs: 10 * 60 * 1000,
        });

        if (!rateCheck.allowed) {
            return res.status(429).json({
                success: false,
                errorCode: "TOO_MANY_REQUESTS",
                message: `Bạn gửi yêu cầu quên mật khẩu quá nhiều lần. Vui lòng thử lại sau ${rateCheck.retryAfterSeconds} giây.`,
                data: { retryAfterSeconds: rateCheck.retryAfterSeconds },
            });
        }

        const result = await authService.forgotCustomerPassword(req.body);

        if (!result.success) {
            const statusCode = FORGOT_PASSWORD_ERROR_HTTP_STATUS[result.errorCode] ?? 400;
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
                cooldownSeconds: result.cooldownSeconds,
                requiresVerificationCode: Boolean(result.requiresVerificationCode),
            },
        });
    } catch (error) {
        console.error("[authController - forgotPassword] Error:", error);
        return res.status(500).json({
            success: false,
            message: "Đã có lỗi xảy ra khi xử lý quên mật khẩu. Vui lòng thử lại sau.",
            errorCode: "INTERNAL_ERROR",
        });
    }
}

async function getLoggedInUser(req, res) {
    return res.json({
        success: true,
        message: "Get logged-in user successfully",
        data: {
            customerInfo: req.session.customer,
        },
    });
}

async function logout(req, res) {
    const customerId = req.session?.customer?.id || null;
    req.session.destroy(async (err) => {
        if (err) {
            console.log("[logout] Xoa session that bai ! Error : ", err);
            return res.status(500).json({
                success: false,
                message: err,
            });
        }

        if (customerId) {
            await revokeUserAccess(null, customerId, "LOGOUT", { audience: "web" }).catch(() => {});
            triggerOutboxDrain();
        }

        res.clearCookie("vietpeace.customer.sid", {
            path: "/api/web",
        });

        return res.status(200).json({
            success: true,
            message: "Đăng xuất customer khỏi web thành công",
        });
    });
}

module.exports = {
    getCaptcha,
    verifyCaptcha,
    login,
    register,
    verifyEmail,
    resendVerification,
    forgotPassword,
    resetPassword: forgotPassword,
    getLoggedInUser,
    logout,
};

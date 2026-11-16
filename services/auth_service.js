const crypto = require("crypto");
const sql = require("mssql");
const bcrypt = require("bcryptjs");

const { getDBPool } = require("../configs/database");
const mailService = require("./mail_service");
const { invalidateActorAuthCache } = require("./chat/identity");
const { generateTemporaryPassword } = require("../utils/account_generator");

const EMAIL_REGEX =
    /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PHONE_REGEX = /^[+0-9 ()\-]{9,20}$/;

const EMAIL_VERIFICATION_TTL_HOURS = 24;
const EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;
const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;
const EMAIL_VERIFICATION_PENDING_SECONDS = 120;
const FORGOT_PASSWORD_COOLDOWN_SECONDS = 60;
const forgotPasswordCooldowns = new Map();

const ADMIN_PANEL_ROLES = Object.freeze(["ADMIN", "ACCOMMODATION_MANAGER"]);

const LOGIN_ROLES = {
    web: ["CUSTOMER"],
    admin: ADMIN_PANEL_ROLES
};

function isAdminPanelRole(role) {
    return ADMIN_PANEL_ROLES.includes(role);
}

function failure(errorCode, errorMsg = "", errors = {}, extra = {}) {
    return {
        success: false,
        errorCode,
        errorMsg,
        errors,
        ...extra
    };
}

function isValidBody(body) {
    return (
        body !== null &&
        typeof body === "object" &&
        !Array.isArray(body)
    );
}

function validateCredentials(body) {
    const errors = {};

    const email = typeof body.email === "string" ? body.email.trim() : "";

    // Không trim password vì khoảng trắng có thể thuộc password.
    const password = typeof body.password === "string" ? body.password : "";

    if (!email) {
        errors.email = "Vui lòng nhập email.";
    } else if (email.length > 255) {
        errors.email = "Email không được vượt quá 255 ký tự.";
    } else if (!EMAIL_REGEX.test(email)) {
        errors.email = "Email không đúng định dạng.";
    }

    if (!password) {
        errors.password = "Vui lòng nhập mật khẩu.";
    } else if (password.length < 8) {
        errors.password = "Mật khẩu phải có ít nhất 8 ký tự.";
    } else if (Buffer.byteLength(password, "utf8") > 72) {
        errors.password = "Mật khẩu không được vượt quá 72 byte UTF-8.";
    }

    return {
        email,
        password,
        errors
    };
}

function validateCustomerLoginInput(body) {
    if (!isValidBody(body)) return failure("REQUEST_BODY_INVALID", "Request body không hợp lệ.");
    const { errors } = validateCredentials(body);
    return Object.keys(errors).length ? failure("DATA_INVALID", "Dữ liệu không hợp lệ.", errors) : null;
}

// Chỉ trả những thuộc tính được phép đưa ra frontend.
function generatePublicUserInfo(user) {
    return {
        id: user.id,
        email: user.email,
        personal_email: user.personal_email || null,
        full_name: user.full_name,
        display_name: user.display_name,
        phone_number: user.phone_number,
        avatar_url: user.avatar_url,
        role: user.role,
        status: user.status,
        must_change_password: Boolean(user.must_change_password),
        accommodationId: user.accommodationId ?? null,
        accommodationName: user.accommodationName ?? null,
        last_login_at: user.last_login_at
    };
}

/**
 * body: { email, password }
 * audience: "web" hoặc "admin", do controller truyền vào.
 */
async function login(body, audience = "web") {
    console.log("[auth_service - login()] audience : " + audience);
    
    if (!isValidBody(body)) {
        return failure("REQUEST_BODY_INVALID", "Request body không hợp lệ.");
    }

    if (audience !== "web" && audience !== "admin") {
        return failure("LOGIN_AUDIENCE_INVALID", "Login audience không hợp lệ");
    }

    const { email, password, errors } = validateCredentials(body);

    if (Object.keys(errors).length > 0) {
        return failure("DATA_INVALID", "Dữ liệu không hợp lệ.", errors);
    }

    const pool = getDBPool();

    const result = await pool
        .request()
        .input("email", sql.VarChar(255), email)
        .query(`
            SELECT
                id,
                email,
                personal_email,
                full_name,
                display_name,
                password_hash,
                phone_number,
                avatar_url,
                role,
                status,
                must_change_password,
                last_login_at
            FROM dbo.users
            WHERE email = @email;
        `);

    if (result.recordset.length === 0) {
        return failure(
            "USER_EMAIL_NOT_EXISTED",
            "Email không tồn tại trong hệ thống.",
            {
                email: "Email không tồn tại trong hệ thống.",
            }
        );
    }

    const user = result.recordset[0];
    console.log("[auth_service - login()] User lookup completed for email : " + email);

    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
        return failure(
            "WRONG_PASSWORD",
            "Mật khẩu không chính xác.",
            {
                password: "Mật khẩu không chính xác.",
            }
        );
    }

    if (user.status === 2) {
        return failure(
            "ACCOUNT_INACTIVE",
            "Tài khoản đã ngừng hoạt động hoặc đã bị thu hồi quyền truy cập."
        );
    }

    const allowedRoles = LOGIN_ROLES[audience];

    if (!allowedRoles.includes(user.role)) {
        return failure("LOGIN_FORBIDDEN", "Tài khoản này không có quyền đăng nhập vào " + ((audience === "admin") ? "Hệ thống quản trị !" : "Website đặt phòng !"));
    }

    // Kiểm tra và kích hoạt bằng mã xác nhận trong lần đăng nhập đầu tiên (status = 0).
    if (user.status === 0) {
        if (audience !== "web") {
            return failure(
                "EMAIL_NOT_VERIFIED",
                "Tài khoản chưa được xác thực email."
            );
        }

        const rawVerificationCode =
            body.verificationCode ?? body.verification_code ?? body.otpCode;
        const trimmedCode =
            typeof rawVerificationCode === "string"
                ? rawVerificationCode.trim()
                : "";

        if (!trimmedCode) {
            return failure(
                "EMAIL_VERIFICATION_CODE_REQUIRED",
                "Đây là lần đăng nhập đầu tiên. Vui lòng nhập mã xác nhận gồm 6 chữ số đã được gửi tới email của bạn để kích hoạt tài khoản.",
                {},
                {
                    requiresVerificationCode: true,
                    email: user.email,
                }
            );
        }

        const activationResult = await activateCustomerByVerificationCode({
            userId: user.id,
            rawCode: trimmedCode,
        });

        if (!activationResult.success) {
            return activationResult;
        }

        const activatedUser = activationResult.user;
        activatedUser.last_login_at = activatedUser.last_login_at
            ? activatedUser.last_login_at.toISOString().slice(0, 19).replace("T", " ")
            : "";

        return {
            success: true,
            activatedOnFirstLogin: true,
            user: generatePublicUserInfo(activatedUser),
        };
    }

    if (user.status !== 1) {
        return failure(
            "ACCOUNT_STATUS_INVALID",
            "Trạng thái tài khoản không hợp lệ."
        );
    }

    // Kiểm tra phạm vi cơ sở lưu trú của Manager
    if (user.role === "ACCOMMODATION_MANAGER") {
        const mgrCheck = await pool.request()
            .input("userId", sql.UniqueIdentifier, user.id)
            .query(`
                SELECT m.accommodation_id, a.accommodation_name
                FROM dbo.accommodation_managers m
                INNER JOIN dbo.accommodations a ON a.id = m.accommodation_id AND a.deleted_at IS NULL
                WHERE m.user_id = @userId;
            `);

        if (mgrCheck.recordset.length === 0) {
            return failure("ACCOMMODATION_NOT_ASSIGNED", "Tài khoản của bạn chưa được phân công cơ sở lưu trú nào hoặc quyền quản lý đã bị thu hồi.");
        }

        user.accommodationId = mgrCheck.recordset[0].accommodation_id;
        user.accommodationName = mgrCheck.recordset[0].accommodation_name;
    }

    const updateResult = await pool
        .request()
        .input("id", sql.UniqueIdentifier, user.id)
        .query(`
            UPDATE dbo.users SET last_login_at = SYSDATETIME()
            OUTPUT INSERTED.last_login_at
            WHERE id = @id;
        `);

    user.last_login_at = updateResult.recordset[0].last_login_at ? updateResult.recordset[0].last_login_at.toISOString().slice(0, 19).replace("T", " ") : "";

    return {
        success: true,
        user: generatePublicUserInfo(user)
    };
}

async function getAdminUserById(userId) {
    const pool = getDBPool();

    const result = await pool
        .request()
        .input("id", sql.UniqueIdentifier, userId)
        .query(`
            SELECT
                u.id,
                u.email,
                u.personal_email,
                u.full_name,
                u.display_name,
                u.phone_number,
                u.role,
                u.status,
                u.must_change_password,
                m.accommodation_id AS manager_accommodation_id,
                ma.accommodation_name AS manager_accommodation_name
            FROM dbo.users u
            LEFT JOIN dbo.accommodation_managers m ON m.user_id = u.id
            LEFT JOIN dbo.accommodations ma ON ma.id = m.accommodation_id AND ma.deleted_at IS NULL
            WHERE u.id = @id;
        `);

    const user = result.recordset[0];
    if (!user) return null;

    let isRevoked = false;
    if (user.role === "ACCOMMODATION_MANAGER") {
        if (!user.manager_accommodation_id) {
            isRevoked = true;
        } else {
            user.accommodationId = user.manager_accommodation_id;
            user.accommodationName = user.manager_accommodation_name;
        }
    }

    user.isRevoked = isRevoked;
    user.must_change_password = Boolean(user.must_change_password);
    return user;
}

/**
 * Đổi mật khẩu lần đầu (bắt buộc đối với tài khoản cấp phát tạm thời)
 */
async function changeInitialPassword(userId, newPassword) {
    const newPasswordError = validatePasswordField(newPassword, "newPassword", "Mật khẩu mới");
    if (newPasswordError) {
        return failure("PASSWORD_INVALID", newPasswordError, {
            newPassword: newPasswordError,
        });
    }

    const salt = await bcrypt.genSalt(10);
    // Không trim password vì khoảng trắng có thể thuộc mật khẩu giống luồng login().
    const passwordHash = await bcrypt.hash(newPassword, salt);

    const pool = getDBPool();
    const result = await pool.request()
        .input("id", sql.UniqueIdentifier, userId)
        .input("passwordHash", sql.VarChar(255), passwordHash)
        .query(`
            UPDATE dbo.users
            SET password_hash = @passwordHash,
                must_change_password = 0,
                password_change_at = SYSDATETIME(),
                updated_at = SYSDATETIME()
            OUTPUT INSERTED.id, INSERTED.email, INSERTED.must_change_password
            WHERE id = @id
              AND role IN ('ADMIN', 'ACCOMMODATION_MANAGER')
              AND status = 1;
        `);

    if (result.recordset.length === 0) {
        return failure("USER_NOT_FOUND", "Không tìm thấy thông tin người dùng hợp lệ.");
    }

    invalidateActorAuthCache(userId);

    return {
        success: true,
        message: "Đổi mật khẩu thành công. Tài khoản của bạn đã được kích hoạt hoàn toàn."
    };
}

/**
 * Đổi mật khẩu chủ động trong Admin Panel (bắt buộc xác thực mật khẩu hiện tại)
 */
async function changeAdminPassword(userId, body) {
    if (!userId) {
        return failure("UNAUTHENTICATED", "Vui lòng đăng nhập vào Admin Panel.");
    }

    if (!isValidBody(body)) {
        return failure("DATA_INVALID", "Request body không hợp lệ.");
    }

    const currentPassword = body.currentPassword ?? body.oldPassword;
    const newPassword = body.newPassword ?? body.password;
    const confirmPassword = body.confirmPassword ?? body.confirmNewPassword;

    const errors = {};
    if (!currentPassword || typeof currentPassword !== "string") {
        errors.currentPassword = "Vui lòng nhập mật khẩu hiện tại.";
    }

    const newPasswordError = validatePasswordField(newPassword, "newPassword", "Mật khẩu mới");
    if (newPasswordError) {
        errors.newPassword = newPasswordError;
    }

    if (confirmPassword !== undefined) {
        if (typeof confirmPassword !== "string" || confirmPassword !== newPassword) {
            errors.confirmPassword = "Mật khẩu xác nhận chưa khớp.";
        }
    }

    if (!errors.currentPassword && !errors.newPassword && currentPassword === newPassword) {
        errors.newPassword = "Mật khẩu mới phải khác mật khẩu hiện tại.";
    }

    if (Object.keys(errors).length > 0) {
        return failure("DATA_INVALID", "Vui lòng kiểm tra lại thông tin đổi mật khẩu.", errors);
    }

    const pool = getDBPool();
    const userRes = await pool
        .request()
        .input("id", sql.UniqueIdentifier, userId)
        .query(`
            SELECT id, password_hash, role, status
            FROM dbo.users
            WHERE id = @id;
        `);

    const userRow = userRes.recordset[0] || null;
    if (!userRow || !isAdminPanelRole(userRow.role)) {
        return failure("USER_NOT_FOUND", "Không tìm thấy tài khoản quản trị.");
    }

    if (userRow.status !== 1) {
        return failure("ACCOUNT_INACTIVE", "Tài khoản đã bị khóa hoặc ngừng hoạt động.");
    }

    const passwordMatches = await bcrypt.compare(currentPassword, userRow.password_hash);
    if (!passwordMatches) {
        return failure(
            "WRONG_CURRENT_PASSWORD",
            "Mật khẩu hiện tại không chính xác.",
            { currentPassword: "Mật khẩu hiện tại không chính xác." }
        );
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const updateRes = await pool
        .request()
        .input("id", sql.UniqueIdentifier, userId)
        .input("passwordHash", sql.VarChar(255), passwordHash)
        .query(`
            UPDATE dbo.users
            SET password_hash = @passwordHash,
                must_change_password = 0,
                password_change_at = SYSDATETIME(),
                updated_at = SYSDATETIME()
            WHERE id = @id
              AND role IN ('ADMIN', 'ACCOMMODATION_MANAGER')
              AND status = 1;
        `);

    if (!updateRes.rowsAffected || updateRes.rowsAffected[0] === 0) {
        return failure("ACCOUNT_INACTIVE", "Không thể đổi mật khẩu lúc này.");
    }

    invalidateActorAuthCache(userId);

    return {
        success: true,
        message: "Đã cập nhật mật khẩu tài khoản thành công.",
    };
}

/**
 * Cập nhật hồ sơ cá nhân của Admin / Manager (bao gồm bổ sung Email cá nhân để khôi phục mật khẩu)
 */
async function updateAdminOwnProfile(userId, body) {
    if (!userId) {
        return failure("UNAUTHENTICATED", "Vui lòng đăng nhập vào Admin Panel.");
    }

    if (!isValidBody(body)) {
        return failure("DATA_INVALID", "Request body không hợp lệ.");
    }

    const rawFullName = body.fullName ?? body.full_name;
    const fullName = typeof rawFullName === "string" ? rawFullName.trim() : "";

    const rawPhone = body.phoneNumber ?? body.phone ?? body.phone_number;
    const hasPhoneKey =
        Object.prototype.hasOwnProperty.call(body, "phoneNumber") ||
        Object.prototype.hasOwnProperty.call(body, "phone") ||
        Object.prototype.hasOwnProperty.call(body, "phone_number");

    const rawPersonalEmail = body.personalEmail ?? body.personal_email;
    const hasPersonalEmailKey =
        Object.prototype.hasOwnProperty.call(body, "personalEmail") ||
        Object.prototype.hasOwnProperty.call(body, "personal_email");

    const errors = {};
    if (!fullName) {
        errors.fullName = "Vui lòng nhập họ và tên.";
    } else if (fullName.length > 255) {
        errors.fullName = "Họ và tên không được vượt quá 255 ký tự.";
    }

    let cleanPhone = null;
    if (hasPhoneKey && rawPhone !== undefined && rawPhone !== null) {
        if (typeof rawPhone !== "string") {
            errors.phoneNumber = "Số điện thoại không hợp lệ.";
        } else {
            const stripped = rawPhone.trim().replace(/[\s().-]/g, "");
            if (stripped) {
                if (!/^\+?\d{8,15}$/.test(stripped)) {
                    errors.phoneNumber = "Số điện thoại phải gồm 8–15 chữ số hợp lệ.";
                } else {
                    cleanPhone = stripped;
                }
            }
        }
    }

    let cleanPersonalEmail = undefined;
    if (hasPersonalEmailKey) {
        if (rawPersonalEmail === null || rawPersonalEmail === "") {
            cleanPersonalEmail = "";
        } else if (typeof rawPersonalEmail !== "string") {
            errors.personalEmail = "Email cá nhân không hợp lệ.";
        } else {
            const trimmed = rawPersonalEmail.trim().toLowerCase();
            if (!trimmed) {
                cleanPersonalEmail = "";
            } else if (trimmed.length > 255 || !EMAIL_REGEX.test(trimmed)) {
                errors.personalEmail = "Email cá nhân không đúng định dạng.";
            } else {
                cleanPersonalEmail = trimmed;
            }
        }
    }

    if (Object.keys(errors).length > 0) {
        return failure("DATA_INVALID", "Vui lòng kiểm tra lại thông tin hồ sơ.", errors);
    }

    const pool = getDBPool();
    const existingRes = await pool
        .request()
        .input("id", sql.UniqueIdentifier, userId)
        .query(`
            SELECT id, email, personal_email, full_name, display_name, phone_number, role, status
            FROM dbo.users
            WHERE id = @id;
        `);

    const existing = existingRes.recordset[0] || null;
    if (!existing || !isAdminPanelRole(existing.role)) {
        return failure("USER_NOT_FOUND", "Không tìm thấy tài khoản quản trị.");
    }

    if (existing.status !== 1) {
        return failure("ACCOUNT_INACTIVE", "Tài khoản đã bị khóa hoặc ngừng hoạt động.");
    }

    // Manager bắt buộc giữ email cá nhân; nếu đang cập nhật personalEmail mới -> kiểm tra trùng
    let nextPersonalEmail = existing.personal_email || null;
    if (cleanPersonalEmail !== undefined) {
        if (!cleanPersonalEmail) {
            if (existing.role === "ACCOMMODATION_MANAGER") {
                return failure(
                    "DATA_INVALID",
                    "Tài khoản Quản lý cơ sở bắt buộc phải có email cá nhân.",
                    { personalEmail: "Vui lòng nhập email cá nhân." }
                );
            }
            nextPersonalEmail = null;
        } else {
            const dupEmail = await pool
                .request()
                .input("id", sql.UniqueIdentifier, userId)
                .input("personalEmail", sql.VarChar(255), cleanPersonalEmail)
                .query(`
                    SELECT TOP 1 id
                    FROM dbo.users
                    WHERE id <> @id
                      AND (
                          LOWER(LTRIM(RTRIM(personal_email))) = @personalEmail
                          OR LOWER(LTRIM(RTRIM(email))) = @personalEmail
                      );
                `);
            if (dupEmail.recordset.length > 0) {
                return failure(
                    "EMAIL_ALREADY_EXISTS",
                    `Email cá nhân "${cleanPersonalEmail}" đã được liên kết với một tài khoản khác trong hệ thống.`,
                    { personalEmail: "Email cá nhân này đã được sử dụng cho tài khoản khác." }
                );
            }
            nextPersonalEmail = cleanPersonalEmail;
        }
    }

    const nextPhone = hasPhoneKey ? cleanPhone : (existing.phone_number || null);
    if (nextPhone && existing.role === "ACCOMMODATION_MANAGER") {
        const phoneKey = nextPhone.replace(/^(?:\+84|0084)/, "0");
        const dupPhone = await pool
            .request()
            .input("id", sql.UniqueIdentifier, userId)
            .input("phoneKey", sql.VarChar(20), phoneKey)
            .query(`
                SELECT TOP 1 u.id
                FROM dbo.users u
                CROSS APPLY (
                    SELECT REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                        u.phone_number, ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), CHAR(9), '') AS phone
                ) p
                WHERE u.id <> @id
                  AND u.role = 'ACCOMMODATION_MANAGER'
                  AND CASE
                        WHEN p.phone LIKE '+84%' THEN '0' + SUBSTRING(p.phone, 4, 20)
                        WHEN p.phone LIKE '0084%' THEN '0' + SUBSTRING(p.phone, 5, 20)
                        ELSE p.phone
                      END = @phoneKey;
            `);
        if (dupPhone.recordset.length > 0) {
            return failure(
                "PHONE_ALREADY_EXISTS",
                "Số điện thoại đã thuộc về một Quản lý cơ sở khác.",
                { phoneNumber: "Số điện thoại đã thuộc về một Quản lý cơ sở khác." }
            );
        }
    }

    const updatedRes = await pool
        .request()
        .input("id", sql.UniqueIdentifier, userId)
        .input("fullName", sql.NVarChar(255), fullName)
        .input("displayName", sql.NVarChar(255), fullName)
        .input("phoneNumber", sql.VarChar(20), nextPhone)
        .input("personalEmail", sql.VarChar(255), nextPersonalEmail)
        .query(`
            UPDATE dbo.users
            SET full_name = @fullName,
                display_name = @displayName,
                phone_number = @phoneNumber,
                personal_email = @personalEmail,
                updated_at = SYSDATETIME()
            OUTPUT
                INSERTED.id,
                INSERTED.email,
                INSERTED.personal_email,
                INSERTED.full_name,
                INSERTED.display_name,
                INSERTED.phone_number,
                INSERTED.role,
                INSERTED.status,
                INSERTED.must_change_password
            WHERE id = @id
              AND role IN ('ADMIN', 'ACCOMMODATION_MANAGER')
              AND status = 1;
        `);

    if (updatedRes.recordset.length === 0) {
        return failure("ACCOUNT_INACTIVE", "Không thể cập nhật hồ sơ lúc này.");
    }

    const row = updatedRes.recordset[0];
    invalidateActorAuthCache(userId);

    return {
        success: true,
        message: "Cập nhật hồ sơ cá nhân thành công.",
        data: {
            fullName: row.full_name,
            displayName: row.display_name || row.full_name,
            phoneNumber: row.phone_number || "",
            personalEmail: row.personal_email || null,
        },
    };
}

/**
 * Quên mật khẩu cho Admin & Manager:
 * Nhập Gmail cá nhân đã đăng ký -> gửi email đăng nhập nội bộ hiện có + mật khẩu tạm thời mới về Gmail cá nhân đó.
 */
async function forgotAdminPortalPassword(body) {
    if (!isValidBody(body)) {
        return failure("DATA_INVALID", "Request body không hợp lệ.");
    }

    const rawPersonalEmail = body.personalEmail ?? body.email ?? "";
    const personalEmail = typeof rawPersonalEmail === "string"
        ? rawPersonalEmail.trim().toLowerCase()
        : "";

    if (!personalEmail) {
        return failure(
            "DATA_INVALID",
            "Vui lòng nhập email cá nhân đã đăng ký.",
            { personalEmail: "Vui lòng nhập email cá nhân đã đăng ký." }
        );
    }

    if (personalEmail.length > 255 || !EMAIL_REGEX.test(personalEmail)) {
        return failure(
            "DATA_INVALID",
            "Email cá nhân không đúng định dạng.",
            { personalEmail: "Email cá nhân không đúng định dạng." }
        );
    }

    const pool = getDBPool();
    const found = await pool
        .request()
        .input("personalEmail", sql.VarChar(255), personalEmail)
        .query(`
            SELECT TOP 2
                u.id,
                u.email,
                u.personal_email,
                u.full_name,
                u.role,
                u.status,
                m.accommodation_id,
                a.accommodation_name
            FROM dbo.users u
            LEFT JOIN dbo.accommodation_managers m ON m.user_id = u.id
            LEFT JOIN dbo.accommodations a ON a.id = m.accommodation_id AND a.deleted_at IS NULL
            WHERE LOWER(LTRIM(RTRIM(u.personal_email))) = @personalEmail
              AND u.role IN ('ADMIN', 'ACCOMMODATION_MANAGER')
            ORDER BY CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END, u.created_at DESC;
        `);

    const user = found.recordset[0] || null;
    if (!user) {
        return failure(
            "USER_EMAIL_NOT_EXISTED",
            "Email cá nhân này chưa được liên kết với tài khoản Quản trị viên hoặc Quản lý cơ sở nào.",
            { personalEmail: "Email cá nhân này chưa được đăng ký trong hệ thống quản trị." }
        );
    }

    if (user.status === 2) {
        return failure(
            "ACCOUNT_INACTIVE",
            "Tài khoản liên kết với email này đã ngừng hoạt động hoặc bị tạm khóa."
        );
    }

    if (user.status !== 1) {
        return failure(
            "ACCOUNT_STATUS_INVALID",
            "Trạng thái tài khoản không hợp lệ."
        );
    }

    if (user.role === "ACCOMMODATION_MANAGER" && !user.accommodation_id) {
        return failure(
            "ACCOMMODATION_NOT_ASSIGNED",
            "Tài khoản Quản lý của bạn chưa được phân công cơ sở lưu trú nên chưa thể đăng nhập hệ thống. Vui lòng liên hệ Quản trị viên cấp cao."
        );
    }

    const cooldownKey = `admin:${user.id}`;
    const now = Date.now();
    for (const [k, expiresAt] of forgotPasswordCooldowns.entries()) {
        if (expiresAt <= now) {
            forgotPasswordCooldowns.delete(k);
        }
    }

    const cooldownUntil = forgotPasswordCooldowns.get(cooldownKey);
    if (cooldownUntil && cooldownUntil > now) {
        const retryAfterSeconds = Math.max(1, Math.ceil((cooldownUntil - now) / 1000));
        return failure(
            "FORGOT_PASSWORD_TOO_FREQUENT",
            `Vui lòng đợi ${retryAfterSeconds} giây trước khi gửi yêu cầu khôi phục tiếp theo.`,
            {},
            { retryAfterSeconds }
        );
    }

    forgotPasswordCooldowns.set(cooldownKey, now + FORGOT_PASSWORD_COOLDOWN_SECONDS * 1000);

    const newPassword = generateTemporaryPassword(12);
    const passwordHash = await bcrypt.hash(newPassword, 12);

    let mailResult;
    try {
        mailResult = await mailService.sendAdminPortalForgotPasswordEmail({
            toPersonalEmail: user.personal_email,
            fullName: user.full_name,
            role: user.role,
            accommodationName: user.accommodation_name || null,
            internalEmail: user.email,
            newPassword,
        });
    } catch {
        forgotPasswordCooldowns.delete(cooldownKey);
        return failure(
            "EMAIL_DELIVERY_FAILED",
            "Không thể gửi email khôi phục lúc này. Vui lòng thử lại sau."
        );
    }

    if (!mailResult?.success) {
        forgotPasswordCooldowns.delete(cooldownKey);
        return failure(
            "EMAIL_DELIVERY_FAILED",
            "Không thể gửi email khôi phục đến Gmail cá nhân lúc này. Vui lòng kiểm tra cấu hình SMTP hoặc thử lại sau."
        );
    }

    await pool
        .request()
        .input("id", sql.UniqueIdentifier, user.id)
        .input("passwordHash", sql.VarChar(255), passwordHash)
        .query(`
            UPDATE dbo.users
            SET password_hash = @passwordHash,
                must_change_password = 1,
                password_change_at = SYSDATETIME(),
                updated_at = SYSDATETIME()
            WHERE id = @id
              AND role IN ('ADMIN', 'ACCOMMODATION_MANAGER')
              AND status = 1;
        `);

    invalidateActorAuthCache(user.id);

    return {
        success: true,
        personalEmail: user.personal_email,
        cooldownSeconds: FORGOT_PASSWORD_COOLDOWN_SECONDS,
        message: `Đã gửi email đăng nhập nội bộ và mật khẩu tạm thời mới tới ${user.personal_email}. Vui lòng kiểm tra hộp thư để đăng nhập.`,
    };
}

function hashVerificationToken(rawToken) {
    return crypto
        .createHash("sha256")
        .update(String(rawToken))
        .digest("hex");
}

function hashVerificationCode(userId, rawCode) {
    return crypto
        .createHash("sha256")
        .update(`otp:${String(userId).trim().toLowerCase()}:${String(rawCode).trim()}`)
        .digest("hex");
}

async function issueCustomerVerificationCode(transaction, userId, email) {
    let rawCode, codeHash;
    // A previously used/revoked six-digit code must never become valid again.
    for (let attempt = 0; attempt < 20; attempt += 1) {
        rawCode = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
        codeHash = hashVerificationCode(userId, rawCode);
        const exists = await new sql.Request(transaction).input("hash", sql.VarChar(150), codeHash)
            .query("SELECT id FROM dbo.email_verification_tokens WHERE token_hash=@hash;");
        if (!exists.recordset.length) break;
        if (attempt === 19) throw new Error("Cannot issue a unique verification code.");
    }

    await new sql.Request(transaction)
        .input("userId", sql.UniqueIdentifier, userId)
        .query(`
            UPDATE dbo.email_verification_tokens
            SET revoked_at = CASE WHEN SYSDATETIME() >= created_at THEN SYSDATETIME() ELSE created_at END
            WHERE user_id = @userId
              AND used_at IS NULL
              AND revoked_at IS NULL;
        `);

    const inserted = await new sql.Request(transaction)
        .input("userId", sql.UniqueIdentifier, userId)
        .input("email", sql.VarChar(255), email)
        .input("tokenHash", sql.VarChar(150), codeHash)
        .input("ttlHours", sql.Int, EMAIL_VERIFICATION_TTL_HOURS)
        .query(`
            INSERT INTO dbo.email_verification_tokens (
                user_id,
                email,
                token_hash,
                expires_at,
                delivery_status
            )
            OUTPUT INSERTED.id
            VALUES (
                @userId,
                @email,
                @tokenHash,
                DATEADD(hour, @ttlHours, SYSDATETIME()),
                'PENDING'
            );
        `);

    return { rawCode, tokenId: inserted.recordset[0].id };
}

async function verificationRetryAfter(transaction, userId) {
    const result = await new sql.Request(transaction).input("userId", sql.UniqueIdentifier, userId)
        .input("cooldown", sql.Int, EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS)
        .input("pending", sql.Int, EMAIL_VERIFICATION_PENDING_SECONDS).query(`
            SELECT ISNULL(MAX(CASE delivery_status
                WHEN 'SENT' THEN @cooldown-DATEDIFF(second,created_at,SYSDATETIME())
                WHEN 'PENDING' THEN @pending-DATEDIFF(second,created_at,SYSDATETIME())
                ELSE 0 END),0) AS retryAfterSeconds
            FROM dbo.email_verification_tokens WITH (HOLDLOCK) WHERE user_id=@userId;
        `);
    return Math.max(0, result.recordset[0]?.retryAfterSeconds || 0);
}

function verificationCooldownFailure(retryAfterSeconds) {
    return failure("VERIFICATION_RESEND_TOO_FREQUENT",
        `Vui lòng đợi ${retryAfterSeconds} giây trước khi yêu cầu gửi lại mã xác nhận.`, {}, { retryAfterSeconds });
}

async function deliverCustomerVerification(user, verification) {
    let mailResult;
    try {
        mailResult = await mailService.sendCustomerVerificationEmail({
            toEmail: user.email, fullName: user.full_name,
            verificationCode: verification.rawCode, expiresInHours: EMAIL_VERIFICATION_TTL_HOURS,
        });
    } catch {
        mailResult = { success: false, method: "smtp_error" };
    }
    const sent = mailResult?.success === true && mailResult.method !== "dev_log";
    const updated = await getDBPool().request().input("id", sql.BigInt, verification.tokenId)
        .input("status", sql.VarChar(16), sent ? "SENT" : "FAILED").query(`
            UPDATE dbo.email_verification_tokens
            SET delivery_status=@status,
                revoked_at=CASE WHEN @status='FAILED' THEN
                    CASE WHEN SYSDATETIME()>=created_at THEN SYSDATETIME() ELSE created_at END
                    ELSE revoked_at END
            OUTPUT INSERTED.id
            WHERE id=@id AND delivery_status='PENDING' AND used_at IS NULL AND revoked_at IS NULL;
        `);
    return { success: sent && updated.recordset.length > 0, method: mailResult?.method || "unknown" };
}

function validateCustomerProfileFields(body, { preserveMissingDisplayName = false } = {}) {
    const errors = {};

    const rawFullName = body.fullName ?? body.full_name;
    const fullName = typeof rawFullName === "string" ? rawFullName.trim() : "";

    const hasDisplayNameKey =
        Object.prototype.hasOwnProperty.call(body, "displayName") ||
        Object.prototype.hasOwnProperty.call(body, "display_name");
    const rawDisplayName = body.displayName ?? body.display_name;

    let displayName = fullName;
    if (rawDisplayName !== undefined && rawDisplayName !== null) {
        if (typeof rawDisplayName !== "string") {
            errors.displayName = "Tên hiển thị phải là chuỗi.";
        } else {
            const trimmedDisplayName = rawDisplayName.trim();
            displayName = trimmedDisplayName || fullName;
        }
    }

    const rawPhone = body.phone ?? body.phoneNumber ?? body.phone_number;
    let phoneNumber = "";

    if (!fullName) {
        errors.fullName = "Vui lòng nhập họ và tên.";
    } else if (fullName.length > 255) {
        errors.fullName = "Họ và tên không được vượt quá 255 ký tự.";
    }

    if (!errors.displayName && displayName.length > 255) {
        errors.displayName = "Tên hiển thị không được vượt quá 255 ký tự.";
    }

    if (rawPhone === undefined || rawPhone === null || (typeof rawPhone === "string" && !rawPhone.trim())) {
        errors.phone = "Vui lòng nhập số điện thoại.";
    } else if (typeof rawPhone !== "string") {
        errors.phone = "Số điện thoại phải là chuỗi.";
    } else {
        phoneNumber = rawPhone.trim();
        const digitCount = phoneNumber.replace(/\D/g, "").length;
        if (!PHONE_REGEX.test(phoneNumber) || digitCount < 9 || digitCount > 15) {
            errors.phone = "Số điện thoại phải gồm 9–15 chữ số hợp lệ.";
        }
    }

    return {
        fullName,
        displayName,
        hasDisplayName: hasDisplayNameKey && !preserveMissingDisplayName ? true : hasDisplayNameKey,
        phoneNumber,
        errors,
    };
}

function validatePasswordField(rawPassword, fieldName = "password", label = "Mật khẩu") {
    if (!rawPassword || typeof rawPassword !== "string") {
        return `Vui lòng nhập ${label.toLowerCase()}.`;
    }
    if (rawPassword.length < 8) {
        return `${label} phải có ít nhất 8 ký tự.`;
    }
    // bcrypt chỉ xử lý tối đa 72 byte password.
    if (Buffer.byteLength(rawPassword, "utf8") > 72) {
        return `${label} không được vượt quá 72 byte UTF-8.`;
    }
    return null;
}

/**
 * body:
 * {
 *     email,
 *     password,
 *     confirmPassword, // optional cho API caller, kiểm tra nếu được truyền
 *     fullName | full_name,
 *     displayName | display_name, // fallback sang fullName nếu không truyền
 *     phone | phoneNumber | phone_number
 * }
 */
async function register(body) {
    if (!isValidBody(body)) {
        return failure(
            "DATA_INVALID",
            "Request body không hợp lệ."
        );
    }

    const { email: rawEmail, password, errors } = validateCredentials(body);
    const email = rawEmail.toLowerCase();

    const profileValidation = validateCustomerProfileFields(body);
    const { fullName, displayName, phoneNumber, errors: profileErrors } = profileValidation;
    Object.assign(errors, profileErrors);

    const rawConfirmPassword = body.confirmPassword ?? body.confirm_password;

    // bcrypt chỉ xử lý tối đa 72 byte password.
    if (!errors.password && Buffer.byteLength(password, "utf8") > 72) {
        errors.password = "Mật khẩu không được vượt quá 72 byte UTF-8.";
    }

    if (rawConfirmPassword !== undefined) {
        if (typeof rawConfirmPassword !== "string" || rawConfirmPassword !== password) {
            errors.confirmPassword = "Mật khẩu xác nhận chưa khớp.";
        }
    }

    if (Object.keys(errors).length > 0) {
        return failure(
            "DATA_INVALID",
            "Vui lòng kiểm tra lại thông tin đăng ký.",
            errors
        );
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const transaction = new sql.Transaction(getDBPool());
    let transactionCommitted = false;
    let savedUser = null;
    let verification = null;

    try {
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        const existingResult = await new sql.Request(transaction)
            .input("email", sql.VarChar(255), email)
            .query(`
                SELECT id, role, status
                FROM dbo.users WITH (UPDLOCK, HOLDLOCK)
                WHERE email = @email;
            `);

        const existing = existingResult.recordset[0] || null;

        if (existing) {
            // Tài khoản chưa xác thực (status = 0, CUSTOMER) có thể đăng ký lại để nhận liên kết mới.
            if (existing.role !== "CUSTOMER" || existing.status !== 0) {
                await transaction.rollback();
                return failure(
                    "EMAIL_ALREADY_EXISTS",
                    "Email đã được sử dụng.",
                    {
                        email: "Email đã được sử dụng.",
                    }
                );
            }
            const retryAfterSeconds = await verificationRetryAfter(transaction, existing.id);
            if (retryAfterSeconds > 0) {
                await transaction.rollback();
                return verificationCooldownFailure(retryAfterSeconds);
            }

            const updated = await new sql.Request(transaction)
                .input("id", sql.UniqueIdentifier, existing.id)
                .input("full_name", sql.NVarChar(255), fullName)
                .input("display_name", sql.NVarChar(255), displayName)
                .input("password_hash", sql.VarChar(255), passwordHash)
                .input("phone_number", sql.VarChar(20), phoneNumber)
                .query(`
                    UPDATE dbo.users
                    SET full_name = @full_name,
                        display_name = @display_name,
                        password_hash = @password_hash,
                        phone_number = @phone_number,
                        updated_at = SYSDATETIME()
                    OUTPUT
                        INSERTED.id,
                        INSERTED.email,
                        INSERTED.full_name,
                        INSERTED.display_name,
                        INSERTED.phone_number,
                        INSERTED.avatar_url,
                        INSERTED.role,
                        INSERTED.status,
                        INSERTED.email_verified_at,
                        INSERTED.last_login_at,
                        INSERTED.created_at
                    WHERE id = @id
                      AND role = 'CUSTOMER'
                      AND status = 0;
                `);

            savedUser = updated.recordset[0];
        } else {
            const inserted = await new sql.Request(transaction)
                .input("email", sql.VarChar(255), email)
                .input("full_name", sql.NVarChar(255), fullName)
                .input("display_name", sql.NVarChar(255), displayName)
                .input("password_hash", sql.VarChar(255), passwordHash)
                .input("phone_number", sql.VarChar(20), phoneNumber)
                .query(`
                    INSERT INTO dbo.users (
                        email,
                        full_name,
                        display_name,
                        password_hash,
                        phone_number,
                        role,
                        status
                    )
                    OUTPUT
                        INSERTED.id,
                        INSERTED.email,
                        INSERTED.full_name,
                        INSERTED.display_name,
                        INSERTED.phone_number,
                        INSERTED.avatar_url,
                        INSERTED.role,
                        INSERTED.status,
                        INSERTED.email_verified_at,
                        INSERTED.last_login_at,
                        INSERTED.created_at
                    VALUES (
                        @email,
                        @full_name,
                        @display_name,
                        @password_hash,
                        @phone_number,
                        'CUSTOMER',
                        0
                    );
                `);

            savedUser = inserted.recordset[0];
        }

        verification = await issueCustomerVerificationCode(transaction, savedUser.id, savedUser.email);

        await transaction.commit();
        transactionCommitted = true;
    } catch (error) {
        if (!transactionCommitted) {
            try {
                await transaction.rollback();
            } catch {
                // Giữ lại lỗi gốc.
            }
        }

        const errorNumber =
            error.number ??
            error.originalError?.info?.number;

        if (errorNumber === 2601 || errorNumber === 2627) {
            return failure(
                "EMAIL_ALREADY_EXISTS",
                "Email đã được sử dụng.",
                {
                    email: "Email đã được sử dụng.",
                }
            );
        }

        throw error;
    }

    const mailResult = await deliverCustomerVerification(savedUser, verification);

    return {
        success: true,
        user: generatePublicUserInfo(savedUser),
        emailSent: Boolean(mailResult?.success),
        cooldownSeconds: mailResult?.success ? EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS : 0,
        emailDeliveryMethod: mailResult?.method || "unknown",
        expiresInHours: EMAIL_VERIFICATION_TTL_HOURS,
        message: mailResult?.success
            ? "Đăng ký thành công! Hệ thống đã gửi email chứa mã xác nhận để bạn nhập khi đăng nhập lần đầu tiên."
            : "Tài khoản đã được tạo nhưng hệ thống chưa gửi được email chứa mã xác nhận. Vui lòng thử bấm 'Gửi lại mã xác nhận'.",
    };
}

async function activateCustomerByVerificationCode({ userId, rawCode }) {
    const code = typeof rawCode === "string" ? rawCode.trim() : "";

    if (!/^\d{6}$/.test(code)) {
        return failure(
            "INVALID_VERIFICATION_CODE",
            "Mã xác nhận phải gồm đúng 6 chữ số.",
            { verificationCode: "Mã xác nhận gồm đúng 6 chữ số." },
            { requiresVerificationCode: true }
        );
    }

    const codeHash = hashVerificationCode(userId, code);
    const transaction = new sql.Transaction(getDBPool());
    let transactionCommitted = false;

    try {
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        // Use the same user -> token lock order as register/resend. The counter
        // is persisted and serialized across processes and simultaneous guesses.
        await new sql.Request(transaction).input("id", sql.UniqueIdentifier, userId)
            .query("SELECT id FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE id=@id;");
        const active = await new sql.Request(transaction).input("id", sql.UniqueIdentifier, userId).query(`
            SELECT TOP 1 id, failed_attempts,
                CASE WHEN expires_at<=SYSDATETIME() THEN 1 ELSE 0 END AS is_expired
            FROM dbo.email_verification_tokens WITH (UPDLOCK, HOLDLOCK)
            WHERE user_id=@id AND used_at IS NULL AND revoked_at IS NULL AND delivery_status='SENT'
            ORDER BY created_at DESC,id DESC;
        `);
        const activeCode = active.recordset[0];
        const attemptsExceeded = () => failure("VERIFICATION_CODE_ATTEMPTS_EXCEEDED",
            "Mã xác nhận đã bị khóa sau 5 lần nhập sai. Vui lòng gửi lại mã xác nhận mới.",
            { verificationCode: "Mã đã bị khóa. Vui lòng gửi lại mã mới." }, { requiresVerificationCode: true });
        if (activeCode && !activeCode.is_expired && activeCode.failed_attempts >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
            await transaction.rollback();
            return attemptsExceeded();
        }

        const matchedResult = await new sql.Request(transaction)
            .input("userId", sql.UniqueIdentifier, userId)
            .input("tokenHash", sql.VarChar(150), codeHash)
            .query(`
                SELECT TOP 1
                    t.id AS token_id,
                    t.user_id,
                    t.email AS token_email,
                    t.used_at,
                    t.revoked_at,
                    t.delivery_status,
                    CASE WHEN t.expires_at <= SYSDATETIME() THEN 1 ELSE 0 END AS is_expired,
                    u.id,
                    u.email,
                    u.personal_email,
                    u.full_name,
                    u.display_name,
                    u.phone_number,
                    u.avatar_url,
                    u.role,
                    u.status,
                    u.email_verified_at,
                    u.last_login_at,
                    u.must_change_password
                FROM dbo.email_verification_tokens t WITH (UPDLOCK, HOLDLOCK)
                INNER JOIN dbo.users u WITH (UPDLOCK, HOLDLOCK) ON u.id = t.user_id
                WHERE t.user_id = @userId
                  AND t.token_hash = @tokenHash
                ORDER BY t.created_at DESC, t.id DESC;
            `);

        const record = matchedResult.recordset[0] || null;

        if (!record) {
            if (activeCode && !activeCode.is_expired) {
                await new sql.Request(transaction).input("id", sql.BigInt, activeCode.id)
                    .query("UPDATE dbo.email_verification_tokens SET failed_attempts=failed_attempts+1 WHERE id=@id;");
                await transaction.commit();
                transactionCommitted = true;
                if (activeCode.failed_attempts + 1 >= EMAIL_VERIFICATION_MAX_ATTEMPTS) return attemptsExceeded();
            } else {
                await transaction.rollback();
            }
            return failure(
                "VERIFICATION_CODE_INCORRECT",
                "Mã xác nhận không chính xác. Vui lòng kiểm tra lại email mới nhất.",
                { verificationCode: "Mã xác nhận không chính xác." },
                { requiresVerificationCode: true }
            );
        }

        if (record.role !== "CUSTOMER") {
            await transaction.rollback();
            return failure(
                "VERIFICATION_NOT_ALLOWED",
                "Tài khoản này không áp dụng xác thực khách hàng."
            );
        }

        if (record.status === 2) {
            await transaction.rollback();
            return failure(
                "ACCOUNT_INACTIVE",
                "Tài khoản đã ngừng hoạt động hoặc đã bị thu hồi quyền truy cập."
            );
        }

        if (record.used_at !== null) {
            await transaction.rollback();
            if (record.status === 1) {
                return {
                    success: true,
                    alreadyVerified: true,
                    email: record.email,
                    user: record,
                    message: "Tài khoản của bạn đã được kích hoạt trước đó. Lần đăng nhập tiếp theo không cần nhập mã.",
                };
            }
            return failure(
                "VERIFICATION_CODE_USED",
                "Mã xác nhận này đã được sử dụng.",
                { verificationCode: "Mã xác nhận đã được sử dụng." },
                { requiresVerificationCode: true, email: record.email }
            );
        }

        if (record.revoked_at !== null) {
            await transaction.rollback();
            return failure(
                "VERIFICATION_CODE_REVOKED",
                "Mã xác nhận này đã hết hiệu lực do có mã mới hơn được gửi. Vui lòng sử dụng mã trong email mới nhất.",
                { verificationCode: "Mã xác nhận đã hết hiệu lực." },
                { requiresVerificationCode: true, email: record.email }
            );
        }

        if (record.delivery_status !== "SENT") {
            await transaction.rollback();
            return failure("VERIFICATION_CODE_NOT_READY", "Mã xác nhận chưa được gửi thành công. Vui lòng gửi lại mã mới.",
                { verificationCode: "Vui lòng gửi lại mã xác nhận." }, { requiresVerificationCode: true });
        }

        if (record.is_expired === 1) {
            await transaction.rollback();
            return failure(
                "VERIFICATION_CODE_EXPIRED",
                "Mã xác nhận đã hết hạn. Vui lòng bấm 'Gửi lại mã xác nhận' để nhận mã mới.",
                { verificationCode: "Mã xác nhận đã hết hạn." },
                { requiresVerificationCode: true, email: record.email }
            );
        }

        const updatedResult = await new sql.Request(transaction)
            .input("tokenId", sql.BigInt, record.token_id)
            .input("userId", sql.UniqueIdentifier, record.user_id)
            .query(`
                UPDATE dbo.email_verification_tokens
                SET used_at = CASE WHEN SYSDATETIME() >= created_at THEN SYSDATETIME() ELSE created_at END
                WHERE id = @tokenId
                  AND used_at IS NULL
                  AND revoked_at IS NULL;

                UPDATE dbo.email_verification_tokens
                SET revoked_at = CASE WHEN SYSDATETIME() >= created_at THEN SYSDATETIME() ELSE created_at END
                WHERE user_id = @userId
                  AND id <> @tokenId
                  AND used_at IS NULL
                  AND revoked_at IS NULL;

                UPDATE dbo.users
                SET status = 1,
                    email_verified_at = COALESCE(email_verified_at, SYSDATETIME()),
                    last_login_at = SYSDATETIME(),
                    updated_at = SYSDATETIME()
                OUTPUT
                    INSERTED.id,
                    INSERTED.email,
                    INSERTED.personal_email,
                    INSERTED.full_name,
                    INSERTED.display_name,
                    INSERTED.phone_number,
                    INSERTED.avatar_url,
                    INSERTED.role,
                    INSERTED.status,
                    INSERTED.email_verified_at,
                    INSERTED.last_login_at,
                    INSERTED.must_change_password
                WHERE id = @userId
                  AND status = 0;
            `);

        const activatedUser = updatedResult.recordset?.[0] || {
            ...record,
            status: 1,
            email_verified_at: new Date(),
            last_login_at: new Date(),
        };

        await transaction.commit();
        transactionCommitted = true;

        invalidateActorAuthCache(record.user_id);

        return {
            success: true,
            alreadyVerified: false,
            email: activatedUser.email,
            fullName: activatedUser.full_name,
            user: activatedUser,
            message: "Kích hoạt tài khoản và đăng nhập thành công!",
        };
    } catch (error) {
        if (!transactionCommitted) {
            try {
                await transaction.rollback();
            } catch {
                // Giữ lại lỗi gốc.
            }
        }
        throw error;
    }
}

async function verifyCustomerEmail(input) {
    if (input && typeof input === "object" && !Array.isArray(input)) {
        const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
        const code = typeof input.code === "string" ? input.code.trim() : "";

        if (!email || !EMAIL_REGEX.test(email)) {
            return failure(
                "DATA_INVALID",
                "Vui lòng nhập email hợp lệ để xác nhận.",
                { email: "Email không đúng định dạng." }
            );
        }

        const pool = getDBPool();
        const found = await pool
            .request()
            .input("email", sql.VarChar(255), email)
            .query(`
                SELECT TOP 1 id, email, role, status
                FROM dbo.users
                WHERE email = @email;
            `);

        const user = found.recordset[0] || null;
        if (!user) {
            return failure(
                "USER_EMAIL_NOT_EXISTED",
                "Email chưa được đăng ký trong hệ thống."
            );
        }

        if (user.status === 1) {
            return {
                success: true,
                alreadyVerified: true,
                email: user.email,
                message: "Tài khoản này đã được kích hoạt. Bạn có thể đăng nhập ngay.",
            };
        }

        return activateCustomerByVerificationCode({ userId: user.id, rawCode: code });
    }

    const token = typeof input === "string" ? input.trim() : "";

    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
        return failure(
            "INVALID_VERIFICATION_TOKEN",
            "Liên kết xác thực không hợp lệ hoặc bị thiếu."
        );
    }

    const tokenHash = hashVerificationToken(token);
    const transaction = new sql.Transaction(getDBPool());
    let transactionCommitted = false;

    try {
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        const found = await new sql.Request(transaction)
            .input("tokenHash", sql.VarChar(150), tokenHash)
            .query(`
                SELECT TOP 1
                    t.id AS token_id,
                    t.user_id,
                    t.email AS token_email,
                    t.used_at,
                    t.revoked_at,
                    CASE WHEN t.expires_at <= SYSDATETIME() THEN 1 ELSE 0 END AS is_expired,
                    u.email AS user_email,
                    u.full_name,
                    u.role,
                    u.status,
                    u.email_verified_at
                FROM dbo.email_verification_tokens t WITH (UPDLOCK, HOLDLOCK)
                INNER JOIN dbo.users u WITH (UPDLOCK, HOLDLOCK) ON u.id = t.user_id
                WHERE t.token_hash = @tokenHash;
            `);

        const record = found.recordset[0] || null;
        if (!record) {
            await transaction.rollback();
            return failure(
                "VERIFICATION_TOKEN_NOT_FOUND",
                "Liên kết xác thực không hợp lệ hoặc không tồn tại."
            );
        }

        if (record.role !== "CUSTOMER") {
            await transaction.rollback();
            return failure(
                "VERIFICATION_NOT_ALLOWED",
                "Tài khoản này không áp dụng xác thực khách hàng."
            );
        }

        if (record.status === 2) {
            await transaction.rollback();
            return failure(
                "ACCOUNT_INACTIVE",
                "Tài khoản đã ngừng hoạt động hoặc đã bị thu hồi quyền truy cập."
            );
        }

        if (record.used_at !== null) {
            await transaction.rollback();
            if (record.status === 1) {
                return {
                    success: true,
                    alreadyVerified: true,
                    email: record.user_email,
                    message: "Email của bạn đã được xác thực trước đó. Bạn có thể đăng nhập ngay.",
                };
            }
            return failure(
                "VERIFICATION_TOKEN_USED",
                "Liên kết xác thực này đã được sử dụng.",
                {},
                { email: record.user_email }
            );
        }

        if (record.revoked_at !== null) {
            await transaction.rollback();
            return failure(
                "VERIFICATION_TOKEN_REVOKED",
                "Liên kết xác thực này đã hết hiệu lực do có mã mới hơn được gửi.",
                {},
                { email: record.user_email }
            );
        }

        if (record.is_expired === 1) {
            await transaction.rollback();
            return failure(
                "VERIFICATION_TOKEN_EXPIRED",
                "Liên kết xác thực đã hết hạn. Vui lòng yêu cầu gửi lại mã xác nhận mới.",
                {},
                { email: record.user_email }
            );
        }

        await new sql.Request(transaction)
            .input("tokenId", sql.BigInt, record.token_id)
            .input("userId", sql.UniqueIdentifier, record.user_id)
            .query(`
                UPDATE dbo.email_verification_tokens
                SET used_at = CASE WHEN SYSDATETIME() >= created_at THEN SYSDATETIME() ELSE created_at END
                WHERE id = @tokenId
                  AND used_at IS NULL
                  AND revoked_at IS NULL;

                UPDATE dbo.users
                SET status = 1,
                    email_verified_at = COALESCE(email_verified_at, SYSDATETIME()),
                    updated_at = SYSDATETIME()
                WHERE id = @userId
                  AND status = 0;
            `);

        await transaction.commit();
        transactionCommitted = true;

        return {
            success: true,
            alreadyVerified: false,
            email: record.user_email,
            fullName: record.full_name,
            message: "Xác thực email thành công! Bạn có thể đăng nhập ngay bây giờ.",
        };
    } catch (error) {
        if (!transactionCommitted) {
            try {
                await transaction.rollback();
            } catch {
                // Giữ lại lỗi gốc.
            }
        }
        throw error;
    }
}

async function resendCustomerVerificationEmail(body) {
    if (!isValidBody(body)) {
        return failure("DATA_INVALID", "Request body không hợp lệ.");
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) {
        return failure("DATA_INVALID", "Vui lòng nhập email.", {
            email: "Vui lòng nhập email.",
        });
    }
    if (email.length > 255 || !EMAIL_REGEX.test(email)) {
        return failure("DATA_INVALID", "Email không đúng định dạng.", {
            email: "Email không đúng định dạng.",
        });
    }

    const transaction = new sql.Transaction(getDBPool());
    let transactionCommitted = false;
    let user = null;
    let verification = null;

    try {
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        const found = await new sql.Request(transaction)
            .input("email", sql.VarChar(255), email)
            .query(`
                SELECT TOP 1 id, email, full_name, role, status
                FROM dbo.users WITH (UPDLOCK, HOLDLOCK)
                WHERE email = @email;
            `);

        user = found.recordset[0] || null;
        if (!user) {
            await transaction.rollback();
            return failure(
                "USER_EMAIL_NOT_EXISTED",
                "Email chưa được đăng ký trong hệ thống.",
                { email: "Email chưa được đăng ký trong hệ thống." }
            );
        }

        if (user.role !== "CUSTOMER") {
            await transaction.rollback();
            return failure(
                "VERIFICATION_NOT_ALLOWED",
                "Tài khoản này không hỗ trợ gửi lại mã xác nhận khách hàng."
            );
        }

        if (user.status === 2) {
            await transaction.rollback();
            return failure(
                "ACCOUNT_INACTIVE",
                "Tài khoản đã ngừng hoạt động hoặc đã bị thu hồi quyền truy cập."
            );
        }

        if (user.status === 1) {
            await transaction.rollback();
            return failure(
                "EMAIL_ALREADY_VERIFIED",
                "Tài khoản này đã được kích hoạt trước đó. Bạn có thể đăng nhập mà không cần mã xác nhận."
            );
        }

        const retryAfterSeconds = await verificationRetryAfter(transaction, user.id);
        if (retryAfterSeconds > 0) {
            await transaction.rollback();
            return verificationCooldownFailure(retryAfterSeconds);
        }

        verification = await issueCustomerVerificationCode(transaction, user.id, user.email);

        await transaction.commit();
        transactionCommitted = true;
    } catch (error) {
        if (!transactionCommitted) {
            try {
                await transaction.rollback();
            } catch {
                // Giữ lại lỗi gốc.
            }
        }
        throw error;
    }

    const mailResult = await deliverCustomerVerification(user, verification);

    if (!mailResult?.success) {
        return failure(
            "EMAIL_DELIVERY_FAILED",
            "Không thể gửi mã xác nhận qua email lúc này. Vui lòng thử lại sau."
        );
    }

    return {
        success: true,
        email: user.email,
        expiresInHours: EMAIL_VERIFICATION_TTL_HOURS,
        cooldownSeconds: EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
        message: "Đã gửi lại mã xác nhận mới về email của bạn. Vui lòng kiểm tra hộp thư.",
    };
}

async function forgotCustomerPassword(body) {
    if (!isValidBody(body)) {
        return failure("DATA_INVALID", "Request body không hợp lệ.");
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) {
        return failure("DATA_INVALID", "Vui lòng nhập email đã đăng ký.", {
            email: "Vui lòng nhập email đã đăng ký.",
        });
    }
    if (email.length > 255 || !EMAIL_REGEX.test(email)) {
        return failure("DATA_INVALID", "Email không đúng định dạng.", {
            email: "Email không đúng định dạng.",
        });
    }

    const pool = getDBPool();
    const found = await pool
        .request()
        .input("email", sql.VarChar(255), email)
        .query(`
            SELECT TOP 1 id, email, full_name, role, status
            FROM dbo.users
            WHERE email = @email;
        `);

    const user = found.recordset[0] || null;
    if (!user) {
        return failure(
            "USER_EMAIL_NOT_EXISTED",
            "Email chưa được đăng ký trong hệ thống.",
            { email: "Email chưa được đăng ký trong hệ thống." }
        );
    }

    if (user.role !== "CUSTOMER") {
        return failure(
            "FORGOT_PASSWORD_NOT_ALLOWED",
            "Tài khoản này không hỗ trợ cấp lại mật khẩu tại cổng khách hàng."
        );
    }

    if (user.status === 2) {
        return failure(
            "ACCOUNT_INACTIVE",
            "Tài khoản đã ngừng hoạt động hoặc đã bị thu hồi quyền truy cập."
        );
    }

    const now = Date.now();
    for (const [k, expiresAt] of forgotPasswordCooldowns.entries()) {
        if (expiresAt <= now) {
            forgotPasswordCooldowns.delete(k);
        }
    }

    const cooldownUntil = forgotPasswordCooldowns.get(user.id);
    if (cooldownUntil && cooldownUntil > now) {
        const retryAfterSeconds = Math.max(1, Math.ceil((cooldownUntil - now) / 1000));
        return failure(
            "FORGOT_PASSWORD_TOO_FREQUENT",
            `Vui lòng đợi ${retryAfterSeconds} giây trước khi yêu cầu gửi mật khẩu mới tiếp theo.`,
            {},
            { retryAfterSeconds }
        );
    }

    forgotPasswordCooldowns.set(user.id, now + FORGOT_PASSWORD_COOLDOWN_SECONDS * 1000);

    const newPassword = generateTemporaryPassword(10);
    const passwordHash = await bcrypt.hash(newPassword, 12);

    let mailResult;
    try {
        mailResult = await mailService.sendCustomerNewPasswordEmail({
            toEmail: user.email,
            fullName: user.full_name,
            newPassword,
        });
    } catch (error) {
        forgotPasswordCooldowns.delete(user.id);
        return failure("EMAIL_DELIVERY_FAILED", "Không thể gửi mật khẩu mới về email lúc này. Vui lòng thử lại sau.");
    }

    if (!mailResult?.success) {
        forgotPasswordCooldowns.delete(user.id);
        return failure(
            "EMAIL_DELIVERY_FAILED",
            "Không thể gửi mật khẩu mới về email lúc này. Vui lòng kiểm tra cấu hình hoặc thử lại sau."
        );
    }

    await pool
        .request()
        .input("id", sql.UniqueIdentifier, user.id)
        .input("passwordHash", sql.VarChar(255), passwordHash)
        .query(`
            UPDATE dbo.users
            SET password_hash = @passwordHash,
                password_change_at = SYSDATETIME(),
                updated_at = SYSDATETIME()
            WHERE id = @id
              AND role = 'CUSTOMER'
              AND status IN (0, 1);
        `);

    invalidateActorAuthCache(user.id);

    return {
        success: true,
        email: user.email,
        cooldownSeconds: FORGOT_PASSWORD_COOLDOWN_SECONDS,
        requiresVerificationCode: user.status === 0,
        message: `Mật khẩu mới đã được gửi về email ${user.email}. Vui lòng kiểm tra hộp thư của bạn.` +
            (user.status === 0 ? " Tài khoản chưa kích hoạt: lần đăng nhập đầu tiên vẫn cần mã xác nhận 6 chữ số. Bạn có thể gửi lại mã tại trang đăng nhập." : ""),
    };
}

/**
 * Controller truyền req.session vào.
 * Controller chịu trách nhiệm clear cookie.
 */
async function logout(session) {
    if (session) {
        await new Promise((resolve, reject) => {
            session.destroy((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    }

    return {
        success: true,
    };
}


/**
 * Hàm này lấy data thông tin của customer (bảng users) theo param userId được truyền vào
 */
async function getCustomerDataById(userId) {
    const pool = getDBPool();

    const result = await pool
        .request()
        .input("id", sql.UniqueIdentifier, userId)
        .query(`
            SELECT u.id, u.email, u.full_name, u.display_name, u.phone_number, u.role, u.status
            FROM users u
            WHERE u.id = @id;
        `);

    if (result.recordset.length === 0) {
        return failure(
            "USER_NOT_EXISTED",
            "User không tồn tại trong hệ thống."
        );
    }

    const userRow = result.recordset[0];

    // chi chap nhan user co role la CUSTOMER
    if (userRow.role !== "CUSTOMER") {
        return failure(
            "ACCOUNT_IS_NOT_CUSTOMER",
            "Tài khoản này không phải là tài khoản Customer !"
        );
    }

    return {
        success: true,
        data: {
            customer: userRow
        }
    }; 
}


function mapCustomerProfile(userRow) {
    return {
        id: userRow.id,
        userId: userRow.id,
        email: userRow.email,
        fullName: userRow.full_name,
        displayName: userRow.display_name || userRow.full_name,
        phoneNumber: userRow.phone_number || "",
        avatarUrl: userRow.avatar_url || null,
        role: userRow.role,
        status: userRow.status,
        emailVerifiedAt: userRow.email_verified_at || null,
        createdAt: userRow.created_at || null,
        updatedAt: userRow.updated_at || null,
    };
}

async function loadActiveCustomerRow(userId, { includePasswordHash = false } = {}) {
    if (!userId) {
        return failure("NO_USER_SESSION", "Vui lòng đăng nhập vào website.");
    }

    const pool = getDBPool();
    const passwordCol = includePasswordHash ? ", u.password_hash" : "";
    const result = await pool
        .request()
        .input("id", sql.UniqueIdentifier, userId)
        .query(`
            SELECT
                u.id,
                u.email,
                u.full_name,
                u.display_name,
                u.phone_number,
                u.avatar_url,
                u.role,
                u.status,
                u.email_verified_at,
                u.created_at,
                u.updated_at${passwordCol}
            FROM dbo.users u
            WHERE u.id = @id;
        `);

    if (result.recordset.length === 0) {
        return failure("USER_NOT_EXISTED", "User không tồn tại trong hệ thống.");
    }

    const userRow = result.recordset[0];
    if (userRow.role !== "CUSTOMER") {
        return failure(
            "ACCOUNT_IS_NOT_CUSTOMER",
            "Tài khoản này không phải là tài khoản Customer !"
        );
    }

    if (userRow.status !== 1) {
        return failure(
            "ACCOUNT_INACTIVE",
            "Tài khoản chưa được kích hoạt hoặc đã bị khóa."
        );
    }

    return {
        success: true,
        data: { userRow },
    };
}

async function getCustomerProfileById(userId) {
    const loaded = await loadActiveCustomerRow(userId);
    if (!loaded.success) {
        return loaded;
    }

    return {
        success: true,
        data: {
            customer: mapCustomerProfile(loaded.data.userRow),
        },
    };
}

async function updateCustomerProfile(userId, body) {
    if (!userId) {
        return failure("NO_USER_SESSION", "Vui lòng đăng nhập vào website.");
    }

    if (!isValidBody(body)) {
        return failure("DATA_INVALID", "Request body không hợp lệ.");
    }

    const { fullName, displayName, hasDisplayName, phoneNumber, errors } =
        validateCustomerProfileFields(body, { preserveMissingDisplayName: true });

    if (Object.keys(errors).length > 0) {
        return failure(
            "DATA_INVALID",
            "Vui lòng kiểm tra lại thông tin hồ sơ.",
            errors
        );
    }

    const loaded = await loadActiveCustomerRow(userId);
    if (!loaded.success) {
        return loaded;
    }

    const existing = loaded.data.userRow;
    const finalDisplayName = hasDisplayName
        ? displayName
        : (!existing.display_name || existing.display_name === existing.full_name
            ? fullName
            : existing.display_name);

    const pool = getDBPool();
    const updatedResult = await pool
        .request()
        .input("id", sql.UniqueIdentifier, userId)
        .input("fullName", sql.NVarChar(255), fullName)
        .input("displayName", sql.NVarChar(255), finalDisplayName)
        .input("phoneNumber", sql.VarChar(20), phoneNumber)
        .query(`
            UPDATE dbo.users
            SET full_name = @fullName,
                display_name = @displayName,
                phone_number = @phoneNumber,
                updated_at = SYSDATETIME()
            OUTPUT
                INSERTED.id,
                INSERTED.email,
                INSERTED.full_name,
                INSERTED.display_name,
                INSERTED.phone_number,
                INSERTED.avatar_url,
                INSERTED.role,
                INSERTED.status,
                INSERTED.email_verified_at,
                INSERTED.created_at,
                INSERTED.updated_at
            WHERE id = @id
              AND role = 'CUSTOMER'
              AND status = 1;
        `);

    if (updatedResult.recordset.length === 0) {
        return failure("ACCOUNT_INACTIVE", "Không thể cập nhật thông tin tài khoản lúc này.");
    }

    invalidateActorAuthCache(userId);

    return {
        success: true,
        message: "Cập nhật thông tin tài khoản thành công.",
        data: {
            customer: mapCustomerProfile(updatedResult.recordset[0]),
        },
    };
}

async function changeCustomerPassword(userId, body) {
    if (!userId) {
        return failure("NO_USER_SESSION", "Vui lòng đăng nhập vào website.");
    }

    if (!isValidBody(body)) {
        return failure("DATA_INVALID", "Request body không hợp lệ.");
    }

    // Không trim password vì khoảng trắng có thể thuộc password.
    const currentPassword = body.currentPassword ?? body.oldPassword;
    const newPassword = body.newPassword ?? body.password;
    const confirmPassword = body.confirmPassword ?? body.confirmNewPassword ?? body.confirm_password;

    const errors = {};
    if (!currentPassword || typeof currentPassword !== "string") {
        errors.currentPassword = "Vui lòng nhập mật khẩu hiện tại.";
    }

    const newPasswordError = validatePasswordField(newPassword, "newPassword", "Mật khẩu mới");
    if (newPasswordError) {
        errors.newPassword = newPasswordError;
    }

    if (confirmPassword !== undefined) {
        if (typeof confirmPassword !== "string" || confirmPassword !== newPassword) {
            errors.confirmPassword = "Mật khẩu xác nhận chưa khớp.";
        }
    }

    if (!errors.currentPassword && !errors.newPassword && currentPassword === newPassword) {
        errors.newPassword = "Mật khẩu mới phải khác mật khẩu hiện tại.";
    }

    if (Object.keys(errors).length > 0) {
        return failure(
            "DATA_INVALID",
            "Vui lòng kiểm tra lại thông tin đổi mật khẩu.",
            errors
        );
    }

    const loaded = await loadActiveCustomerRow(userId, { includePasswordHash: true });
    if (!loaded.success) {
        return loaded;
    }

    const passwordMatches = await bcrypt.compare(currentPassword, loaded.data.userRow.password_hash);
    if (!passwordMatches) {
        return failure(
            "WRONG_CURRENT_PASSWORD",
            "Mật khẩu hiện tại không chính xác.",
            {
                currentPassword: "Mật khẩu hiện tại không chính xác.",
            }
        );
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const pool = getDBPool();
    const updateResult = await pool
        .request()
        .input("id", sql.UniqueIdentifier, userId)
        .input("passwordHash", sql.VarChar(255), passwordHash)
        .query(`
            UPDATE dbo.users
            SET password_hash = @passwordHash,
                must_change_password = 0,
                password_change_at = SYSDATETIME(),
                updated_at = SYSDATETIME()
            WHERE id = @id
              AND role = 'CUSTOMER'
              AND status = 1;
        `);

    if (!updateResult.rowsAffected || updateResult.rowsAffected[0] === 0) {
        return failure("ACCOUNT_INACTIVE", "Không thể đổi mật khẩu lúc này.");
    }

    invalidateActorAuthCache(userId);

    return {
        success: true,
        message: "Đổi mật khẩu thành công.",
        data: {
            userId,
        },
    };
}


module.exports = {
    validateCustomerLoginInput,
    login,
    register,
    verifyCustomerEmail,
    resendCustomerVerificationEmail,
    forgotCustomerPassword,
    forgotAdminPortalPassword,
    logout,
    getAdminUserById,
    changeInitialPassword,
    changeAdminPassword,
    updateAdminOwnProfile,
    isAdminPanelRole,
    getCustomerDataById,
    getCustomerProfileById,
    updateCustomerProfile,
    changeCustomerPassword
};

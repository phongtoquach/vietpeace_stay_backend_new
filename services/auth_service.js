const crypto = require("crypto");
const sql = require("mssql");
const bcrypt = require("bcryptjs");

const { getDBPool } = require("../configs/database");
const mailService = require("./mail_service");

const EMAIL_REGEX =
    /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PHONE_REGEX = /^[+0-9 ()\-]{9,20}$/;

const EMAIL_VERIFICATION_TTL_HOURS = 24;
const EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;

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
    }

    return {
        email,
        password,
        errors
    };
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

    // Chỉ kiểm tra và thông báo trạng thái khi password đã đúng.
    if (user.status === 0) {
        return failure(
            "EMAIL_NOT_VERIFIED",
            "Tài khoản chưa được xác thực email."
        );
    }

    if (user.status === 2) {
        return failure(
            "ACCOUNT_INACTIVE",
            "Tài khoản đã ngừng hoạt động hoặc đã bị thu hồi quyền truy cập."
        );
    }

    if (user.status !== 1) {
        return failure(
            "ACCOUNT_STATUS_INVALID",
            "Trạng thái tài khoản không hợp lệ."
        );
    }

    const allowedRoles = LOGIN_ROLES[audience];

    if (!allowedRoles.includes(user.role)) {
        return failure("LOGIN_FORBIDDEN", "Tài khoản này không có quyền đăng nhập vào " + ((audience === "admin") ? "Hệ thống quản trị !" : "Website đặt phòng !"));
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
    if (!newPassword || typeof newPassword !== "string" || newPassword.trim().length < 8) {
        return failure("PASSWORD_TOO_SHORT", "Mật khẩu mới phải có ít nhất 8 ký tự.", {
            newPassword: "Mật khẩu mới phải có ít nhất 8 ký tự."
        });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword.trim(), salt);

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
            WHERE id = @id;
        `);

    if (result.recordset.length === 0) {
        return failure("USER_NOT_FOUND", "Không tìm thấy thông tin người dùng.");
    }

    return {
        success: true,
        message: "Đổi mật khẩu thành công. Tài khoản của bạn đã được kích hoạt hoàn toàn."
    };
}

function hashVerificationToken(rawToken) {
    return crypto
        .createHash("sha256")
        .update(String(rawToken))
        .digest("hex");
}

function buildCustomerVerificationUrl(rawToken) {
    const rawDomain = (process.env.WEB_DOMAIN || "http://localhost:5178")
        .trim()
        .replace(/^["']|["']$/g, "");
    const verifyUrl = new URL("/verify-email", rawDomain);
    verifyUrl.searchParams.set("token", rawToken);
    return verifyUrl.toString();
}

async function issueCustomerVerificationToken(transaction, userId, email) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashVerificationToken(rawToken);

    await new sql.Request(transaction)
        .input("userId", sql.UniqueIdentifier, userId)
        .query(`
            UPDATE dbo.email_verification_tokens
            SET revoked_at = CASE WHEN SYSDATETIME() >= created_at THEN SYSDATETIME() ELSE created_at END
            WHERE user_id = @userId
              AND used_at IS NULL
              AND revoked_at IS NULL;
        `);

    await new sql.Request(transaction)
        .input("userId", sql.UniqueIdentifier, userId)
        .input("email", sql.VarChar(255), email)
        .input("tokenHash", sql.VarChar(150), tokenHash)
        .input("ttlHours", sql.Int, EMAIL_VERIFICATION_TTL_HOURS)
        .query(`
            INSERT INTO dbo.email_verification_tokens (
                user_id,
                email,
                token_hash,
                expires_at
            )
            VALUES (
                @userId,
                @email,
                @tokenHash,
                DATEADD(hour, @ttlHours, SYSDATETIME())
            );
        `);

    return rawToken;
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

    const rawFullName = body.fullName ?? body.full_name;
    const fullName = typeof rawFullName === "string" ? rawFullName.trim() : "";

    const rawDisplayName = body.displayName ?? body.display_name;
    const displayName = typeof rawDisplayName === "string" && rawDisplayName.trim()
        ? rawDisplayName.trim()
        : fullName;

    const rawPhone = body.phone ?? body.phoneNumber ?? body.phone_number;
    let phoneNumber = "";

    const rawConfirmPassword = body.confirmPassword ?? body.confirm_password;

    if (!fullName) {
        errors.fullName = "Vui lòng nhập họ và tên.";
    } else if (fullName.length > 255) {
        errors.fullName = "Họ và tên không được vượt quá 255 ký tự.";
    }

    if (displayName.length > 255) {
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
    let rawToken = null;

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

        rawToken = await issueCustomerVerificationToken(transaction, savedUser.id, savedUser.email);

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

    const verificationUrl = buildCustomerVerificationUrl(rawToken);
    const mailResult = await mailService.sendCustomerVerificationEmail({
        toEmail: savedUser.email,
        fullName: savedUser.full_name,
        verificationUrl,
        expiresInHours: EMAIL_VERIFICATION_TTL_HOURS,
    });

    return {
        success: true,
        user: generatePublicUserInfo(savedUser),
        emailSent: Boolean(mailResult?.success),
        emailDeliveryMethod: mailResult?.method || "unknown",
        expiresInHours: EMAIL_VERIFICATION_TTL_HOURS,
        message: mailResult?.success
            ? "Đăng ký thành công! Vui lòng kiểm tra hộp thư email để xác thực tài khoản trước khi đăng nhập."
            : "Tài khoản đã được tạo nhưng hệ thống chưa gửi được email xác thực. Vui lòng thử bấm 'Gửi lại email xác thực'.",
    };
}

async function verifyCustomerEmail(rawToken) {
    const token = typeof rawToken === "string" ? rawToken.trim() : "";

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
                "Liên kết xác thực này đã hết hiệu lực do có liên kết mới hơn được gửi đi. Vui lòng kiểm tra email mới nhất.",
                {},
                { email: record.user_email }
            );
        }

        if (record.is_expired === 1) {
            await transaction.rollback();
            return failure(
                "VERIFICATION_TOKEN_EXPIRED",
                "Liên kết xác thực đã hết hạn. Vui lòng yêu cầu gửi lại email xác thực mới.",
                {},
                { email: record.user_email }
            );
        }

        if (record.status === 1 && record.email_verified_at !== null) {
            await new sql.Request(transaction)
                .input("tokenId", sql.BigInt, record.token_id)
                .query(`
                    UPDATE dbo.email_verification_tokens
                    SET used_at = CASE WHEN SYSDATETIME() >= created_at THEN SYSDATETIME() ELSE created_at END
                    WHERE id = @tokenId
                      AND used_at IS NULL
                      AND revoked_at IS NULL;
                `);
            await transaction.commit();
            transactionCommitted = true;

            return {
                success: true,
                alreadyVerified: true,
                email: record.user_email,
                message: "Email của bạn đã được xác thực trước đó. Bạn có thể đăng nhập ngay.",
            };
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

                UPDATE dbo.email_verification_tokens
                SET revoked_at = CASE WHEN SYSDATETIME() >= created_at THEN SYSDATETIME() ELSE created_at END
                WHERE user_id = @userId
                  AND id <> @tokenId
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
            message: "Xác thực email thành công! Tài khoản của bạn đã được kích hoạt, bạn có thể đăng nhập ngay bây giờ.",
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
    let rawToken = null;

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
                "Tài khoản này không hỗ trợ gửi lại email xác thực khách hàng."
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
                "Email này đã được xác thực. Bạn có thể đăng nhập ngay."
            );
        }

        const cooldownResult = await new sql.Request(transaction)
            .input("userId", sql.UniqueIdentifier, user.id)
            .query(`
                SELECT TOP 1
                    DATEDIFF(second, created_at, SYSDATETIME()) AS seconds_since_last
                FROM dbo.email_verification_tokens WITH (HOLDLOCK)
                WHERE user_id = @userId
                ORDER BY created_at DESC, id DESC;
            `);

        const lastSeconds = cooldownResult.recordset[0]?.seconds_since_last;
        if (
            typeof lastSeconds === "number" &&
            lastSeconds >= 0 &&
            lastSeconds < EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS
        ) {
            const retryAfterSeconds = Math.max(
                1,
                EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS - lastSeconds
            );
            await transaction.rollback();
            return failure(
                "VERIFICATION_RESEND_TOO_FREQUENT",
                `Vui lòng đợi ${retryAfterSeconds} giây trước khi yêu cầu gửi lại email xác thực.`,
                {},
                { retryAfterSeconds }
            );
        }

        rawToken = await issueCustomerVerificationToken(transaction, user.id, user.email);

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

    const verificationUrl = buildCustomerVerificationUrl(rawToken);
    const mailResult = await mailService.sendCustomerVerificationEmail({
        toEmail: user.email,
        fullName: user.full_name,
        verificationUrl,
        expiresInHours: EMAIL_VERIFICATION_TTL_HOURS,
    });

    if (!mailResult?.success) {
        return failure(
            "EMAIL_DELIVERY_FAILED",
            "Không thể gửi email xác thực lúc này. Vui lòng kiểm tra lại sau."
        );
    }

    return {
        success: true,
        email: user.email,
        expiresInHours: EMAIL_VERIFICATION_TTL_HOURS,
        cooldownSeconds: EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
        message: "Đã gửi lại email xác thực. Vui lòng kiểm tra hộp thư đến hoặc thư rác.",
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
    console.log("[auth_service - getCustomerDataById()] Data cua user tim duoc : ", userRow);

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


module.exports = {
    login,
    register,
    verifyCustomerEmail,
    resendCustomerVerificationEmail,
    logout,
    getAdminUserById,
    changeInitialPassword,
    isAdminPanelRole,
    getCustomerDataById
};

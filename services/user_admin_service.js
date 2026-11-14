const sql = require("mssql");
const bcrypt = require("bcryptjs");
const { getDBPool } = require("../configs/database");
const { generateTemporaryPassword, generateUniqueInternalEmail } = require("../utils/account_generator");
const { sendPasswordResetEmail } = require("./mail_service");
const { revokeUserAccess } = require("./chat/identity");
const { triggerOutboxDrain } = require("./chat/runtime");

/**
 * Lấy danh sách tài khoản quản trị (ADMIN và ACCOMMODATION_MANAGER)
 */
async function listAdminUsers({ search = "", role = "", status = "" } = {}) {
    const pool = getDBPool();
    const request = pool.request();

    let query = `
        SELECT 
            u.id,
            u.email,
            u.personal_email,
            u.full_name,
            u.display_name,
            u.phone_number,
            u.avatar_url,
            u.role,
            u.status,
            u.must_change_password,
            u.last_login_at,
            u.created_at,
            m.accommodation_id,
            a.accommodation_name,
            a.accommodation_code
        FROM dbo.users u
        LEFT JOIN dbo.accommodation_managers m ON m.user_id = u.id
        LEFT JOIN dbo.accommodations a ON a.id = m.accommodation_id AND a.deleted_at IS NULL
        WHERE u.role IN ('ADMIN', 'ACCOMMODATION_MANAGER')
    `;

    if (search && search.trim()) {
        request.input("search", sql.NVarChar(255), `%${search.trim()}%`);
        query += ` AND (
            u.full_name LIKE @search
            OR u.email LIKE @search
            OR u.personal_email LIKE @search
            OR u.phone_number LIKE @search
            OR a.accommodation_name LIKE @search
            OR a.accommodation_code LIKE @search
        )`;
    }

    if (role && (role === "ADMIN" || role === "ACCOMMODATION_MANAGER")) {
        request.input("role", sql.VarChar(30), role);
        query += ` AND u.role = @role`;
    }

    if (status === "attention") {
        query += ` AND (u.status = 2 OR u.must_change_password = 1)`;
    } else if (status === "pending_password") {
        query += ` AND u.must_change_password = 1`;
    } else if (status !== "" && !isNaN(Number(status))) {
        request.input("status", sql.TinyInt, Number(status));
        query += ` AND u.status = @status`;
    }

    query += ` ORDER BY u.created_at DESC;`;

    const result = await request.query(query);

    return result.recordset.map((row) => ({
        id: row.id,
        fullName: row.full_name,
        displayName: row.display_name,
        email: row.email,
        personalEmail: row.personal_email || null,
        phoneNumber: row.phone_number || "",
        avatarUrl: row.avatar_url || null,
        role: row.role,
        status: row.status,
        mustChangePassword: Boolean(row.must_change_password),
        lastLoginAt: row.last_login_at ? row.last_login_at.toISOString().slice(0, 19).replace("T", " ") : null,
        createdAt: row.created_at ? row.created_at.toISOString().slice(0, 10) : null,
        accommodation: row.accommodation_id
            ? {
                  id: row.accommodation_id,
                  name: row.accommodation_name,
                  code: row.accommodation_code,
              }
            : null,
    }));
}

/**
 * Thêm mới một Manager vào danh sách Manager (chưa phân công cơ sở)
 */
async function createManagerUser({ fullName, personalEmail, phoneNumber }) {
    if (!fullName || typeof fullName !== "string" || !fullName.trim()) {
        throw { statusCode: 400, errorCode: "INVALID_NAME", message: "Vui lòng nhập họ và tên Manager." };
    }

    if (!personalEmail || typeof personalEmail !== "string" || !personalEmail.includes("@")) {
        throw { statusCode: 400, errorCode: "INVALID_EMAIL", message: "Vui lòng nhập địa chỉ email cá nhân hợp lệ." };
    }

    const pool = getDBPool();
    const cleanPersonalEmail = personalEmail.trim().toLowerCase();
    if (phoneNumber != null && typeof phoneNumber !== "string") {
        throw { statusCode: 400, errorCode: "INVALID_PHONE", message: "Số điện thoại không hợp lệ." };
    }
    const cleanPhoneNumber = (phoneNumber || "").trim().replace(/[\s().-]/g, "");
    if (cleanPhoneNumber && !/^\+?\d{8,15}$/.test(cleanPhoneNumber)) {
        throw { statusCode: 400, errorCode: "INVALID_PHONE", message: "Vui lòng nhập số điện thoại hợp lệ (8–15 chữ số)." };
    }

    // Chuẩn hóa +84/0084 về đầu 0 để so sánh cùng một số Việt Nam.
    const phoneKey = cleanPhoneNumber.replace(/^(?:\+84|0084)/, "0");
    const pendingInternalEmail = await generateUniqueInternalEmail("mgr", "pool");
    const initialPassword = generateTemporaryPassword(10);
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(initialPassword, salt);
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    let insertRes;
    try {

    // Kiểm tra trùng Gmail cá nhân
        const existingCheck = await new sql.Request(transaction)
            .input("personalEmail", sql.VarChar(255), cleanPersonalEmail)
            .query("SELECT TOP 1 id, full_name FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE LOWER(LTRIM(RTRIM(personal_email))) = @personalEmail OR LOWER(LTRIM(RTRIM(email))) = @personalEmail;");

        if (existingCheck.recordset.length > 0) {
            throw {
                statusCode: 409,
                errorCode: "EMAIL_ALREADY_EXISTS",
                message: `Địa chỉ email "${cleanPersonalEmail}" đã có trên hệ thống, thuộc tài khoản "${existingCheck.recordset[0].full_name}". Vui lòng sử dụng địa chỉ email khác.`,
            };
        }

        if (phoneKey) {
            const duplicatePhone = await new sql.Request(transaction)
                .input("phoneKey", sql.VarChar(20), phoneKey)
                .query(`SELECT TOP 1 u.id, u.full_name
                    FROM dbo.users u WITH (UPDLOCK, HOLDLOCK)
                    CROSS APPLY (SELECT REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                        u.phone_number, ' ', ''), '-', ''), '.', ''), '(', ''), ')', ''), CHAR(9), '') AS phone) p
                    WHERE u.role = 'ACCOMMODATION_MANAGER' AND
                        CASE WHEN p.phone LIKE '+84%' THEN '0' + SUBSTRING(p.phone, 4, 20)
                             WHEN p.phone LIKE '0084%' THEN '0' + SUBSTRING(p.phone, 5, 20)
                             ELSE p.phone END = @phoneKey;`);
            if (duplicatePhone.recordset.length) {
                throw {
                    statusCode: 409,
                    errorCode: "PHONE_ALREADY_EXISTS",
                    message: `Số điện thoại "${cleanPhoneNumber}" đã có trên hệ thống, thuộc Manager "${duplicatePhone.recordset[0].full_name}". Vui lòng sử dụng số điện thoại khác.`,
                };
            }
        }

        insertRes = await new sql.Request(transaction)
            .input("email", sql.VarChar(255), pendingInternalEmail)
            .input("personalEmail", sql.VarChar(255), cleanPersonalEmail)
            .input("fullName", sql.NVarChar(255), fullName.trim())
            .input("displayName", sql.NVarChar(255), fullName.trim())
            .input("passwordHash", sql.VarChar(255), passwordHash)
            .input("phoneNumber", sql.VarChar(20), cleanPhoneNumber || null)
            .input("role", sql.VarChar(30), "ACCOMMODATION_MANAGER")
            .input("status", sql.TinyInt, 1)
            .input("mustChangePassword", sql.Bit, 1)
            .query(`
                INSERT INTO dbo.users (
                    email, personal_email, full_name, display_name,
                    password_hash, phone_number, role, status,
                    must_change_password, email_verified_at
                )
                OUTPUT INSERTED.id, INSERTED.email, INSERTED.personal_email, INSERTED.full_name, INSERTED.phone_number, INSERTED.role, INSERTED.status, INSERTED.created_at
                VALUES (
                    @email, @personalEmail, @fullName, @displayName,
                    @passwordHash, @phoneNumber, @role, @status,
                    @mustChangePassword, SYSDATETIME()
                );
            `);
        await transaction.commit();
    } catch (error) {
        try { await transaction.rollback(); } catch { /* Giữ nguyên lỗi gốc. */ }
        throw error;
    }

    const row = insertRes.recordset[0];
    return {
        id: row.id,
        fullName: row.full_name,
        email: row.email,
        personalEmail: row.personal_email,
        phoneNumber: row.phone_number || "",
        role: row.role,
        status: row.status,
        accommodation: null,
        createdAt: row.created_at ? row.created_at.toISOString().slice(0, 10) : null,
    };
}

/**
 * Cập nhật thông tin tài khoản quản trị
 */
async function updateAdminUser(targetUserId, { fullName, personalEmail, phoneNumber, status }, currentAdmin) {
    if (!fullName || typeof fullName !== "string" || !fullName.trim()) {
        throw { statusCode: 400, errorCode: "INVALID_NAME", message: "Họ và tên không được để trống." };
    }

    const pool = getDBPool();

    // Tìm tài khoản
    const userRes = await pool
        .request()
        .input("id", sql.UniqueIdentifier, targetUserId)
        .query("SELECT id, role, status, personal_email FROM dbo.users WHERE id = @id;");

    if (userRes.recordset.length === 0) {
        throw { statusCode: 404, errorCode: "USER_NOT_FOUND", message: "Không tìm thấy người dùng." };
    }

    const targetUser = userRes.recordset[0];
    const newStatus = status !== undefined ? Number(status) : targetUser.status;
    if (![1, 2].includes(newStatus)) {
        throw { statusCode: 400, errorCode: "INVALID_STATUS", message: "Tài khoản quản trị chỉ có trạng thái hoạt động hoặc tạm khóa." };
    }
    if (targetUser.role === "ADMIN" && newStatus !== targetUser.status) {
        throw { statusCode: 403, errorCode: "ADMIN_STATUS_IMMUTABLE", message: "Không hỗ trợ khóa hoặc thay đổi trạng thái tài khoản ADMIN." };
    }
    let cleanPersonalEmail = targetUser.personal_email;

    if (personalEmail !== undefined && personalEmail !== null) {
        const trimmedEmail = String(personalEmail).trim().toLowerCase();
        if (trimmedEmail) {
            if (!trimmedEmail.includes("@")) {
                throw { statusCode: 400, errorCode: "INVALID_EMAIL", message: "Địa chỉ Gmail cá nhân không hợp lệ." };
            }
            const dupCheck = await pool
                .request()
                .input("id", sql.UniqueIdentifier, targetUserId)
                .input("personalEmail", sql.VarChar(255), trimmedEmail)
                .query("SELECT TOP 1 id, full_name FROM dbo.users WHERE id <> @id AND (personal_email = @personalEmail OR email = @personalEmail);");

            if (dupCheck.recordset.length > 0) {
                throw {
                    statusCode: 409,
                    errorCode: "EMAIL_ALREADY_EXISTS",
                    message: `Địa chỉ Gmail "${trimmedEmail}" đã thuộc về "${dupCheck.recordset[0].full_name}".`,
                };
            }
            cleanPersonalEmail = trimmedEmail;
        }
    }

    // Không cho phép tự khóa tài khoản của chính mình
    if (targetUser.id === currentAdmin.id && newStatus === 2) {
        throw { statusCode: 400, errorCode: "CANNOT_LOCK_SELF", message: "Bạn không thể tự khóa tài khoản của chính mình." };
    }

    await pool
        .request()
        .input("id", sql.UniqueIdentifier, targetUserId)
        .input("fullName", sql.NVarChar(255), fullName.trim())
        .input("displayName", sql.NVarChar(255), fullName.trim())
        .input("personalEmail", sql.VarChar(255), cleanPersonalEmail)
        .input("phoneNumber", sql.VarChar(20), phoneNumber ? phoneNumber.trim() : null)
        .input("status", sql.TinyInt, newStatus)
        .query(`
            UPDATE dbo.users
            SET full_name = @fullName,
                display_name = @displayName,
                personal_email = @personalEmail,
                phone_number = @phoneNumber,
                status = @status,
                updated_at = SYSDATETIME()
            WHERE id = @id;
        `);

    if (newStatus !== 1) {
        await revokeUserAccess(null, targetUserId, "USER_LOCKED").catch(() => {});
        triggerOutboxDrain();
    }

    return {
        id: targetUserId,
        fullName: fullName.trim(),
        personalEmail: cleanPersonalEmail,
        phoneNumber: phoneNumber ? phoneNumber.trim() : null,
        status: newStatus,
    };
}

/**
 * Đổi trạng thái Hoạt động <-> Tạm khóa nhanh
 */
async function toggleUserStatus(targetUserId, currentAdmin) {
    const pool = getDBPool();

    const userRes = await pool
        .request()
        .input("id", sql.UniqueIdentifier, targetUserId)
        .query("SELECT id, full_name, role, status FROM dbo.users WHERE id = @id;");

    if (userRes.recordset.length === 0) {
        throw { statusCode: 404, errorCode: "USER_NOT_FOUND", message: "Không tìm thấy người dùng." };
    }

    const targetUser = userRes.recordset[0];
    if (targetUser.role === "ADMIN") {
        throw { statusCode: 403, errorCode: "ADMIN_STATUS_IMMUTABLE", message: "Không hỗ trợ khóa hoặc thay đổi trạng thái tài khoản ADMIN." };
    }
    if (targetUserId === currentAdmin.id) {
        throw { statusCode: 400, errorCode: "CANNOT_LOCK_SELF", message: "Bạn không thể tự thay đổi trạng thái tài khoản của chính mình." };
    }
    const newStatus = targetUser.status === 1 ? 2 : 1;

    await pool
        .request()
        .input("id", sql.UniqueIdentifier, targetUserId)
        .input("status", sql.TinyInt, newStatus)
        .query(`
            UPDATE dbo.users
            SET status = @status,
                updated_at = SYSDATETIME()
            WHERE id = @id;
        `);

    if (newStatus !== 1) {
        await revokeUserAccess(null, targetUserId, "USER_LOCKED").catch(() => {});
        triggerOutboxDrain();
    }

    return {
        id: targetUserId,
        fullName: targetUser.full_name,
        status: newStatus,
        message: newStatus === 1 ? `Đã kích hoạt lại tài khoản ${targetUser.full_name}.` : `Đã tạm khóa tài khoản ${targetUser.full_name}.`,
    };
}

/**
 * Đặt lại mật khẩu tạm thời cho tài khoản
 */
async function resetUserPassword(targetUserId, newPassword, currentAdmin, sendEmail = true) {
    if (!newPassword || typeof newPassword !== "string" || newPassword.trim().length < 8) {
        throw { statusCode: 400, errorCode: "INVALID_PASSWORD", message: "Mật khẩu mới phải có ít nhất 8 ký tự." };
    }

    const pool = getDBPool();

    const userRes = await pool
        .request()
        .input("id", sql.UniqueIdentifier, targetUserId)
        .query(`
            SELECT 
                u.id, 
                u.full_name, 
                u.email, 
                u.personal_email,
                u.role,
                a.accommodation_name
            FROM dbo.users u
            LEFT JOIN dbo.accommodation_managers m ON m.user_id = u.id
            LEFT JOIN dbo.accommodations a ON a.id = m.accommodation_id AND a.deleted_at IS NULL
            WHERE u.id = @id;
        `);

    if (userRes.recordset.length === 0) {
        throw { statusCode: 404, errorCode: "USER_NOT_FOUND", message: "Không tìm thấy người dùng." };
    }

    const targetUser = userRes.recordset[0];

    // Quyền hạn: Tài khoản Admin không được phép thay đổi mật khẩu của Admin cùng cấp hoặc Manager đã phân bổ
    if (targetUser.role === "ADMIN") {
        throw {
            statusCode: 403,
            errorCode: "FORBIDDEN_RESET_ADMIN",
            message: "Tài khoản Quản trị viên (ADMIN) không được phép thay đổi mật khẩu của Admin cùng cấp.",
        };
    }

    if (targetUser.role === "ACCOMMODATION_MANAGER") {
        throw {
            statusCode: 403,
            errorCode: "FORBIDDEN_RESET_MANAGER",
            message: "Tài khoản Quản trị viên không được phép thay đổi mật khẩu của Quản lý cơ sở đã phân bổ.",
        };
    }
    const cleanNewPassword = newPassword.trim();
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(cleanNewPassword, salt);

    await pool
        .request()
        .input("id", sql.UniqueIdentifier, targetUserId)
        .input("passwordHash", sql.VarChar(255), passwordHash)
        .query(`
            UPDATE dbo.users
            SET password_hash = @passwordHash,
                must_change_password = 1,
                password_change_at = SYSDATETIME(),
                updated_at = SYSDATETIME()
            WHERE id = @id;
        `);

    let emailSent = false;
    const recipientEmail = targetUser.personal_email ? targetUser.personal_email.trim() : null;

    if (sendEmail && recipientEmail) {
        const mailRes = await sendPasswordResetEmail({
            toGmail: recipientEmail,
            fullName: targetUser.full_name,
            accommodationName: targetUser.accommodation_name || null,
            internalEmail: targetUser.email,
            newPassword: cleanNewPassword,
        });
        emailSent = Boolean(mailRes && mailRes.success);
    }

    return {
        id: targetUserId,
        fullName: targetUser.full_name,
        email: targetUser.email,
        personalEmail: recipientEmail,
        emailSent,
        message: emailSent
            ? `Đã đặt lại mật khẩu và gửi thông báo tới Gmail (${recipientEmail}) của ${targetUser.full_name}!`
            : `Đã đặt lại mật khẩu cho tài khoản ${targetUser.full_name}. Tài khoản này sẽ được yêu cầu đổi mật khẩu trong lần đăng nhập tới.`,
    };
}

/**
 * Xóa tài khoản (hoặc chuyển sang Vô hiệu hóa nếu có dữ liệu liên quan)
 */
async function deleteAdminUser(targetUserId, currentAdmin) {
    if (targetUserId === currentAdmin.id) {
        throw { statusCode: 400, errorCode: "CANNOT_DELETE_SELF", message: "Bạn không thể tự xóa tài khoản của chính mình." };
    }

    const pool = getDBPool();

    const userRes = await pool
        .request()
        .input("id", sql.UniqueIdentifier, targetUserId)
        .query("SELECT id, full_name, role FROM dbo.users WHERE id = @id;");

    if (userRes.recordset.length === 0) {
        throw { statusCode: 404, errorCode: "USER_NOT_FOUND", message: "Không tìm thấy người dùng." };
    }

    const targetUser = userRes.recordset[0];

    // Tuyệt đối không cho phép xóa tài khoản Quản trị viên cấp cao (ADMIN)
    if (targetUser.role === "ADMIN") {
        throw {
            statusCode: 403,
            errorCode: "CANNOT_DELETE_ADMIN",
            message: "Không thể xóa tài khoản Quản trị viên cấp cao (ADMIN). Đây là tài khoản cố định của hệ thống.",
        };
    }

    // Nếu là Manager, thu hồi liên kết cơ sở trước
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
        const assigned = await new sql.Request(transaction)
            .input("userId", sql.UniqueIdentifier, targetUserId)
            .query("SELECT accommodation_id FROM dbo.accommodation_managers WITH (UPDLOCK, HOLDLOCK) WHERE user_id = @userId;");
        if (assigned.recordset.length > 0) {
            throw { statusCode: 409, errorCode: "REPLACEMENT_REQUIRED", message: "Manager đang phụ trách cơ sở. Vui lòng thay thế quản lý trước khi xóa tài khoản." };
        }
        await new sql.Request(transaction)
            .input("userId", sql.UniqueIdentifier, targetUserId)
            .query("DELETE FROM dbo.accommodation_managers WHERE user_id = @userId;");

        await new sql.Request(transaction)
            .input("userId", sql.UniqueIdentifier, targetUserId)
            .query("DELETE FROM dbo.email_verification_tokens WHERE user_id = @userId;");

        await new sql.Request(transaction)
            .input("userId", sql.UniqueIdentifier, targetUserId)
            .query("DELETE FROM dbo.password_reset_tokens WHERE user_id = @userId;");

        await new sql.Request(transaction)
            .input("userId", sql.UniqueIdentifier, targetUserId)
            .query("DELETE FROM dbo.users WHERE id = @userId;");

        await transaction.commit();

        return {
            id: targetUserId,
            fullName: targetUser.full_name,
            message: `Đã xóa tài khoản ${targetUser.full_name} khỏi hệ thống.`,
        };
    } catch (err) {
        await transaction.rollback();

        if ((err.number ?? err.originalError?.info?.number) !== 547) throw err;

        // Nếu có ràng buộc khóa ngoại khác (như đơn đặt phòng, audit log), chuyển sang vô hiệu hóa
        await pool
            .request()
            .input("userId", sql.UniqueIdentifier, targetUserId)
            .query("UPDATE dbo.users SET status = 2, updated_at = SYSDATETIME() WHERE id = @userId;");

        await revokeUserAccess(null, targetUserId, "USER_DEACTIVATED").catch(() => {});
        triggerOutboxDrain();

        return {
            id: targetUserId,
            fullName: targetUser.full_name,
            message: `Tài khoản có dữ liệu liên kết nên hệ thống đã chuyển sang trạng thái Vô hiệu hóa (Tạm khóa) thay vì xóa hoàn toàn.`,
        };
    }
}

module.exports = {
    listAdminUsers,
    createManagerUser,
    updateAdminUser,
    toggleUserStatus,
    resetUserPassword,
    deleteAdminUser,
};

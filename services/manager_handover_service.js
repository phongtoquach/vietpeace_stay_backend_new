const sql = require('mssql');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { getDBPool } = require('../configs/database');
const { generateTemporaryPassword } = require('../utils/account_generator');
const { sendAccountProvisionEmail } = require('./mail_service');
const { encryptPassword, decryptPassword } = require('./handover_credentials_service');

function failure(statusCode, errorCode, message) {
    return Object.assign(new Error(message), { statusCode, errorCode });
}

function requireAdmin(admin) {
    if (admin?.role !== 'ADMIN') throw failure(403, 'FORBIDDEN', 'Chỉ ADMIN được bàn giao người quản lý.');
}

function accommodationId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
        throw failure(400, 'INVALID_ID', 'ID cơ sở lưu trú không hợp lệ.');
    }
    return id;
}

function managerProfile(profile) {
    const fullName = typeof profile.fullName === 'string' ? profile.fullName.trim() : '';
    const personalEmail = typeof profile.personalEmail === 'string' ? profile.personalEmail.trim().toLowerCase() : '';
    const phoneNumber = typeof profile.phoneNumber === 'string' ? profile.phoneNumber.trim() : '';
    if (!fullName || fullName.length > 255) throw failure(400, 'INVALID_NAME', 'Họ tên Manager phải có từ 1 đến 255 ký tự.');
    if (personalEmail.length > 255 || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(personalEmail)) {
        throw failure(400, 'INVALID_EMAIL', 'Địa chỉ email cá nhân không hợp lệ.');
    }
    if (phoneNumber.length > 20) throw failure(400, 'INVALID_PHONE', 'Số điện thoại không được vượt quá 20 ký tự.');
    return { fullName, personalEmail, phoneNumber };
}

async function deliver(user, accommodation, temporaryPassword) {
    let delivery;
    try {
        delivery = await sendAccountProvisionEmail({
            toGmail: user.personalEmail, fullName: user.fullName,
            roleTitle: 'Người quản lý cơ sở lưu trú (Accommodation Manager)',
            accommodationName: accommodation.accommodation_name,
            internalEmail: user.internalEmail, temporaryPassword,
        });
    } catch {
        delivery = { success: false, method: 'smtp_error' };
    }
    return {
        ...user, accommodationId: accommodation.id, accommodationName: accommodation.accommodation_name,
        mustChangePassword: true, canResendCredentials: true,
        emailSent: delivery.success === true && delivery.method === 'smtp', emailDelivery: delivery.method,
    };
}

// Replacement and initial assignment share one transaction. No standalone revoke
// is possible: the old manager stays assigned if any replacement write fails.
async function assignAccommodationManager(value, profile = {}, admin, options = {}) {
    requireAdmin(admin);
    const id = accommodationId(value);
    const replacing = options.replace === true;
    if (replacing && !options.expectedManagerId) {
        throw failure(400, 'REPLACEMENT_REQUIRED', 'Vui lòng chọn người thay thế trước khi thu hồi quyền.');
    }
    if (profile.managerId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profile.managerId)) {
        throw failure(400, 'INVALID_MANAGER', 'Manager được chọn không hợp lệ.');
    }
    const newProfile = profile.managerId ? null : managerProfile(profile);
    const temporaryPassword = generateTemporaryPassword(16);
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    const transaction = new sql.Transaction(getDBPool());
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    let user;
    let accommodation;
    try {
        const found = await new sql.Request(transaction).input('id', sql.Int, id)
            .query(`SELECT id, accommodation_code, accommodation_name
                FROM dbo.accommodations WITH (UPDLOCK, HOLDLOCK)
                WHERE id = @id AND deleted_at IS NULL;`);
        accommodation = found.recordset[0];
        if (!accommodation) throw failure(404, 'NOT_FOUND', 'Không tìm thấy cơ sở lưu trú.');
        const assignment = await new sql.Request(transaction).input('accommodationId', sql.Int, id)
            .query(`SELECT user_id FROM dbo.accommodation_managers WITH (UPDLOCK, HOLDLOCK)
                WHERE accommodation_id = @accommodationId;`);
        const previousId = assignment.recordset[0]?.user_id;
        if (replacing) {
            if (!previousId || String(previousId).toLowerCase() !== String(options.expectedManagerId).toLowerCase()) {
                throw failure(409, 'MANAGER_CHANGED', 'Người quản lý đã thay đổi. Vui lòng tải lại danh sách.');
            }
        } else if (previousId) {
            throw failure(409, 'ACCOMMODATION_ALREADY_HAS_MANAGER', 'Cơ sở đã có quản lý. Vui lòng dùng chức năng thay thế quản lý.');
        }
        let manager;
        if (profile.managerId) {
            const result = await new sql.Request(transaction).input('managerId', sql.UniqueIdentifier, profile.managerId)
                .query(`SELECT id, full_name, personal_email, phone_number, role, status
                    FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE id = @managerId;`);
            manager = result.recordset[0];
            if (!manager || manager.role !== 'ACCOMMODATION_MANAGER' || manager.status !== 1) {
                throw failure(400, 'INVALID_MANAGER', 'Vui lòng chọn Manager đang hoạt động và chưa được phân công.');
            }
            const assigned = await new sql.Request(transaction).input('managerId', sql.UniqueIdentifier, manager.id)
                .query(`SELECT accommodation_id FROM dbo.accommodation_managers WITH (UPDLOCK, HOLDLOCK)
                    WHERE user_id = @managerId;`);
            if (assigned.recordset.length) throw failure(409, 'MANAGER_ALREADY_ASSIGNED', 'Manager này đã được phân công. Vui lòng chọn người khác.');
        }
        // Existing profiles come from the DB; client-supplied contact overrides are ignored.
        const details = manager ? managerProfile({ fullName: manager.full_name, personalEmail: manager.personal_email, phoneNumber: manager.phone_number }) : newProfile;
        const duplicate = await new sql.Request(transaction)
            .input('email', sql.VarChar(255), details.personalEmail)
            .input('managerId', sql.UniqueIdentifier, manager?.id || null)
            .query(`SELECT id FROM dbo.users WITH (UPDLOCK, HOLDLOCK)
                WHERE (personal_email = @email OR email = @email)
                  AND (@managerId IS NULL OR id <> @managerId);`);
        if (duplicate.recordset.length) throw failure(409, 'EMAIL_ALREADY_EXISTS', 'Email cá nhân đã được tài khoản khác sử dụng.');

        const cleanCode = (accommodation.accommodation_code || 'accom').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
        const internalEmail = `mgr.${cleanCode}.${crypto.randomUUID().slice(0, 8)}@vietpeacestay.vn`;
        const saved = await new sql.Request(transaction)
            .input('managerId', sql.UniqueIdentifier, manager?.id || crypto.randomUUID())
            .input('email', sql.VarChar(255), internalEmail)
            .input('personalEmail', sql.VarChar(255), details.personalEmail)
            .input('fullName', sql.NVarChar(255), details.fullName)
            .input('phoneNumber', sql.VarChar(20), details.phoneNumber || null)
            .input('passwordHash', sql.VarChar(255), passwordHash)
            .query(manager ? `UPDATE dbo.users SET email = @email, password_hash = @passwordHash,
                status = 1, must_change_password = 1, password_change_at = SYSDATETIME(), updated_at = SYSDATETIME()
                OUTPUT INSERTED.id WHERE id = @managerId;` : `
                INSERT INTO dbo.users (id, email, personal_email, full_name, display_name, phone_number,
                    password_hash, role, status, must_change_password, email_verified_at, password_change_at)
                OUTPUT INSERTED.id VALUES (@managerId, @email, @personalEmail, @fullName, @fullName, @phoneNumber,
                    @passwordHash, 'ACCOMMODATION_MANAGER', 1, 1, SYSDATETIME(), SYSDATETIME());`);
        const userId = saved.recordset[0].id;
        if (replacing) {
            await new sql.Request(transaction)
                .input('accommodationId', sql.Int, id).input('previousId', sql.UniqueIdentifier, previousId)
                .input('poolEmail', sql.VarChar(255), `mgr.pool.${crypto.randomUUID()}@vietpeacestay.vn`)
                .query(`DELETE FROM dbo.accommodation_managers
                        WHERE accommodation_id = @accommodationId AND user_id = @previousId;
                    DELETE FROM dbo.manager_handover_credentials WHERE user_id = @previousId;
                    UPDATE dbo.users SET email = @poolEmail, must_change_password = 0,
                        status = 1, updated_at = SYSDATETIME() WHERE id = @previousId;`);
        }
        await new sql.Request(transaction)
            .input('accommodationId', sql.Int, id).input('userId', sql.UniqueIdentifier, userId)
            .input('adminId', sql.UniqueIdentifier, admin.id)
            .query(`INSERT INTO dbo.accommodation_managers (accommodation_id, user_id, assigned_by_user_id)
                VALUES (@accommodationId, @userId, @adminId);`);
        await new sql.Request(transaction).input('userId', sql.UniqueIdentifier, userId)
            .input('encryptedPassword', sql.NVarChar(1000), encryptPassword(temporaryPassword, userId))
            .query(`DELETE FROM dbo.manager_handover_credentials WHERE user_id = @userId;
                INSERT INTO dbo.manager_handover_credentials (user_id, encrypted_password, expires_at)
                VALUES (@userId, @encryptedPassword, DATEADD(day, 7, SYSUTCDATETIME()));`);
        user = { userId, internalEmail, ...details };
        await transaction.commit();
    } catch (error) {
        try { await transaction.rollback(); } catch { /* Preserve the original error. */ }
        if ([2601, 2627, 1205].includes(error.number)) {
            throw failure(409, 'ASSIGNMENT_CONFLICT', 'Dữ liệu phân công vừa thay đổi. Vui lòng tải lại và thử lại.');
        }
        throw error;
    }
    // SMTP is outside the committed transaction. Failure leaves a retryable handover.
    return deliver(user, accommodation, temporaryPassword);
}

async function revokeAccommodationManager(id, replacement = {}, admin) {
    if (!replacement.managerId && !replacement.fullName) {
        throw failure(400, 'REPLACEMENT_REQUIRED', 'Bắt buộc chọn hoặc thêm Manager thay thế trước khi thu hồi quyền.');
    }
    return assignAccommodationManager(id, replacement, admin, { replace: true, expectedManagerId: replacement.expectedManagerId });
}

async function resendManagerCredentials(value, expectedManagerId, admin) {
    requireAdmin(admin);
    const id = accommodationId(value);
    const result = await getDBPool().request().input('id', sql.Int, id)
        .query(`SELECT u.id, u.email, u.full_name, u.personal_email, u.password_hash,
                u.must_change_password, h.encrypted_password, a.accommodation_name
            FROM dbo.accommodation_managers m
            JOIN dbo.users u ON u.id = m.user_id AND u.status = 1 AND u.role = 'ACCOMMODATION_MANAGER'
            JOIN dbo.accommodations a ON a.id = m.accommodation_id AND a.deleted_at IS NULL
            JOIN dbo.manager_handover_credentials h ON h.user_id = u.id AND h.expires_at > SYSUTCDATETIME()
            WHERE m.accommodation_id = @id;`);
    const user = result.recordset[0];
    if (!expectedManagerId || !user || String(user.id).toLowerCase() !== String(expectedManagerId).toLowerCase() || !user.must_change_password) {
        throw failure(409, 'HANDOVER_NOT_AVAILABLE', 'Bàn giao đã hết hạn, Manager đã đổi mật khẩu hoặc người quản lý đã thay đổi. Vui lòng tải lại danh sách.');
    }
    const temporaryPassword = decryptPassword(user.encrypted_password, user.id);
    if (!await bcrypt.compare(temporaryPassword, user.password_hash)) {
        throw failure(409, 'HANDOVER_NOT_AVAILABLE', 'Mật khẩu đã thay đổi. Không thể gửi lại thông tin bàn giao cũ.');
    }
    return deliver({ userId: user.id, internalEmail: user.email, fullName: user.full_name, personalEmail: user.personal_email },
        { id, accommodation_name: user.accommodation_name }, temporaryPassword);
}

module.exports = { assignAccommodationManager, revokeAccommodationManager, resendManagerCredentials };

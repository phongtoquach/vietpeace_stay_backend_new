const sql = require("mssql");
const { getDBPool } = require("../configs/database");

/**
 * Lấy toàn bộ ma trận phân quyền của hệ thống từ database
 */
async function getRolePermissionsMatrix() {
    const pool = getDBPool();
    const result = await pool.request().query(`
        SELECT role, permission_key, is_granted
        FROM dbo.role_permissions
        ORDER BY role, permission_key;
    `);

    const matrix = {
        ADMIN: {},
        ACCOMMODATION_MANAGER: {},
    };

    result.recordset.forEach((row) => {
        if (!matrix[row.role]) {
            matrix[row.role] = {};
        }
        matrix[row.role][row.permission_key] = Boolean(row.is_granted);
    });

    return matrix;
}

/**
 * Lấy danh sách các quyền được cấp (is_granted = 1) cho một vai trò cụ thể
 */
async function getGrantedPermissionsForRole(role) {
    if (role === "ADMIN") {
        // ADMIN luôn có toàn quyền
        const pool = getDBPool();
        const res = await pool.request().query(`
            SELECT DISTINCT permission_key
            FROM dbo.role_permissions;
        `);
        return res.recordset.map((r) => r.permission_key);
    }

    const pool = getDBPool();
    const result = await pool
        .request()
        .input("role", sql.VarChar(50), role)
        .query(`
            SELECT permission_key
            FROM dbo.role_permissions
            WHERE role = @role AND is_granted = 1;
        `);

    return result.recordset.map((r) => r.permission_key);
}

/**
 * Cập nhật ma trận phân quyền cho một vai trò vào database
 * @param {string} role 'ACCOMMODATION_MANAGER' hoặc 'ADMIN'
 * @param {Record<string, boolean>} permissionsMap { 'accommodations.read': true, ... }
 */
async function updateRolePermissions(role, permissionsMap) {
    if (!role || (role !== "ACCOMMODATION_MANAGER" && role !== "ADMIN")) {
        throw new Error("Vai trò không hợp lệ để cập nhật phân quyền.");
    }

    if (!permissionsMap || typeof permissionsMap !== "object") {
        throw new Error("Dữ liệu phân quyền không hợp lệ.");
    }

    const pool = getDBPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
        for (const [permKey, isGranted] of Object.entries(permissionsMap)) {
            await new sql.Request(transaction)
                .input("role", sql.VarChar(50), role)
                .input("permKey", sql.VarChar(100), permKey)
                .input("granted", sql.Bit, isGranted ? 1 : 0)
                .query(`
                    MERGE dbo.role_permissions AS target
                    USING (SELECT @role AS role, @permKey AS permission_key) AS source
                    ON target.role = source.role AND target.permission_key = source.permission_key
                    WHEN MATCHED THEN
                        UPDATE SET is_granted = @granted, updated_at = SYSDATETIME()
                    WHEN NOT MATCHED THEN
                        INSERT (role, permission_key, is_granted) VALUES (source.role, source.permission_key, @granted);
                `);
        }

        await transaction.commit();
        return { success: true, message: `Đã cập nhật phân quyền cho vai trò ${role} thành công.` };
    } catch (err) {
        await transaction.rollback();
        throw err;
    }
}

module.exports = {
    getRolePermissionsMatrix,
    getGrantedPermissionsForRole,
    updateRolePermissions,
};


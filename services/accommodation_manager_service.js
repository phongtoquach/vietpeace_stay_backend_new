const sql = require("mssql");

const { getDBPool } = require("../configs/database");

/**
 * 1. Super Admin: Lấy danh sách tất cả cơ sở kèm thông tin Manager hiện tại
 */
async function getAccommodationsManagersOverview() {
    const pool = getDBPool();

    const result = await pool.request().query(`
        SELECT
            a.id AS accommodation_id,
            a.accommodation_code,
            a.accommodation_name,
            a.slug,
            a.status AS accommodation_status,
            a.address_line,
            l.name AS location_name,
            t.name AS type_name,
            cover.image_url AS cover_image_url,

            -- Thông tin manager (nếu có)
            u.id AS manager_user_id,
            u.full_name AS manager_full_name,
            u.email AS manager_internal_email,
            u.personal_email AS manager_personal_email,
            u.phone_number AS manager_phone_number,
            u.status AS manager_status,
            u.must_change_password AS manager_must_change_password,
            m.assigned_at AS manager_assigned_at,
            CASE WHEN h.user_id IS NOT NULL AND h.expires_at > SYSUTCDATETIME()
                AND u.must_change_password = 1 THEN 1 ELSE 0 END AS can_resend_credentials,
            assigner.full_name AS assigned_by_name

        FROM dbo.accommodations a
        INNER JOIN dbo.locations l ON l.id = a.location_id
        INNER JOIN dbo.accommodation_types t ON t.id = a.accommodation_type_id
        OUTER APPLY (
            SELECT TOP 1 image_url
            FROM dbo.accommodation_images img
            WHERE img.accommodation_id = a.id AND img.is_cover = 1
        ) cover
        LEFT JOIN dbo.accommodation_managers m ON m.accommodation_id = a.id
        LEFT JOIN dbo.users u ON u.id = m.user_id
        LEFT JOIN dbo.manager_handover_credentials h ON h.user_id = u.id
        LEFT JOIN dbo.users assigner ON assigner.id = m.assigned_by_user_id
        WHERE a.deleted_at IS NULL
        ORDER BY a.sort_order ASC, a.id ASC;
    `);

    return result.recordset.map((row) => ({
        id: row.accommodation_id,
        code: row.accommodation_code,
        name: row.accommodation_name,
        slug: row.slug,
        status: row.accommodation_status,
        address: row.address_line,
        locationName: row.location_name,
        typeName: row.type_name,
        coverImageUrl: row.cover_image_url,
        manager: row.manager_user_id
            ? {
                  userId: row.manager_user_id,
                  fullName: row.manager_full_name,
                  internalEmail: row.manager_internal_email,
                  personalEmail: row.manager_personal_email,
                  phoneNumber: row.manager_phone_number,
                  status: row.manager_status,
                  mustChangePassword: Boolean(row.manager_must_change_password),
                  canResendCredentials: Boolean(row.can_resend_credentials),
                  assignedAt: row.manager_assigned_at,
                  assignedByName: row.assigned_by_name,
              }
            : null,
    }));
}

module.exports = { getAccommodationsManagersOverview, ...require("./manager_handover_service") };

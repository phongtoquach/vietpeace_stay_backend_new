const { sqlObj } = require("../configs/database");

/**
 * Điều kiện SQL chuẩn xác định cơ sở đã được phân công Manager đang hoạt động.
 */
function activeManagerAssignedSql(alias = "a") {
  return `EXISTS (
    SELECT 1
    FROM dbo.accommodation_managers AS am
    INNER JOIN dbo.users AS mu ON mu.id = am.user_id
    WHERE am.accommodation_id = ${alias}.id
      AND mu.role = 'ACCOMMODATION_MANAGER'
      AND mu.status = 1
  )`;
}

/**
 * Chuyển toàn bộ cơ sở chưa có Manager đang hoạt động (nhưng đang ACTIVE = 1)
 * về trạng thái Ngừng hoạt động (status = 2).
 */
async function syncUnmanagedAccommodationsToInactive(executor) {
  if (!executor) return 0;
  const req = executor.request ? executor.request() : new sqlObj.Request(executor);
  const result = await req.query(`
    UPDATE a
    SET a.status = 2,
        a.updated_at = SYSDATETIME()
    FROM dbo.accommodations AS a
    WHERE a.deleted_at IS NULL
      AND a.status = 1
      AND NOT ${activeManagerAssignedSql("a")};
  `);
  return Number(result?.rowsAffected?.[0] || 0);
}

module.exports = {
  activeManagerAssignedSql,
  syncUnmanagedAccommodationsToInactive,
};

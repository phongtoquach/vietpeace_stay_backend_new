-- Chuẩn hóa quyền báo cáo thống kê: dùng key reports.view cho cả admin và manager.
-- Chạy 1 lần trên database VietPeaceStayDB. Migration idempotent.
--
-- Lưu ý: dbo.role_permissions.created_at/updated_at là NOT NULL và không có default,
-- nên INSERT phải ghi rõ thời điểm.
--
-- Rollback (chạy tay khi cần):
-- MERGE dbo.role_permissions AS target
-- USING (VALUES ('ADMIN'), ('ACCOMMODATION_MANAGER')) AS source(role)
-- ON target.role = source.role AND target.permission_key = 'reports.view_all'
-- WHEN NOT MATCHED THEN
--     INSERT (role, permission_key, is_granted, created_at, updated_at)
--     VALUES (source.role, 'reports.view_all', 1, SYSDATETIME(), SYSDATETIME());

MERGE dbo.role_permissions AS target
USING (VALUES
    ('ADMIN', 'reports.view'),
    ('ACCOMMODATION_MANAGER', 'reports.view')
) AS source(role, permission_key)
ON target.role = source.role
   AND target.permission_key = source.permission_key
WHEN MATCHED THEN
    UPDATE SET is_granted = 1, updated_at = SYSDATETIME()
WHEN NOT MATCHED THEN
    INSERT (role, permission_key, is_granted, created_at, updated_at)
    VALUES (source.role, source.permission_key, 1, SYSDATETIME(), SYSDATETIME());

DELETE FROM dbo.role_permissions
WHERE permission_key = 'reports.view_all';

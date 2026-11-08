-- Chay thu cong tren database VietPeaceStayDB cua tung thanh vien.
-- Chi go phan cong cu; khong xoa hoac sua tai khoan Manager.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Targets TABLE (
    user_id UNIQUEIDENTIFIER PRIMARY KEY,
    accommodation_id INT,
    full_name NVARCHAR(255)
);
INSERT INTO @Targets VALUES
('8E68C4D1-5E31-4AC4-9680-5149E5DB763A', 70, N'Huỳnh Thanh Trúc'),
('164D81A2-FC86-49F0-A25B-A526698B8BBB', 69, N'Võ Công Vinh'),
('132322DD-23F5-410C-BBAD-D32FC143F6AF', 68, N'Phan Mỹ Duyên'),
('44775395-8839-4FB8-BC21-D7C68B3085F9', 67, N'Đào Trọng Nhân'),
('7A40CF94-C87F-4DAC-B47D-6D00767EF6C4', 66, N'Đinh Mai Anh');

BEGIN TRY
    BEGIN TRANSACTION;

    IF (SELECT COUNT(*) FROM dbo.users u WITH (UPDLOCK, HOLDLOCK)
        JOIN @Targets t ON t.user_id = u.id
        WHERE u.role = 'ACCOMMODATION_MANAGER' AND u.status = 1
          AND u.full_name = t.full_name) <> 5
        THROW 50001, N'Không tìm đủ 5 Manager đúng ID, tên và trạng thái hoạt động. Database có thể khác bản dữ liệu gốc; chưa thay đổi dữ liệu.', 1;

    IF EXISTS (SELECT 1 FROM dbo.accommodation_managers m WITH (UPDLOCK, HOLDLOCK)
        JOIN @Targets t ON t.user_id = m.user_id
        WHERE m.accommodation_id <> t.accommodation_id)
        THROW 50002, N'Có Manager đã được phân công sang cơ sở khác. Dừng để tránh gỡ phân công mới.', 1;

    DELETE m
    OUTPUT DELETED.user_id AS released_manager_id,
           DELETED.accommodation_id AS previous_accommodation_id
    FROM dbo.accommodation_managers m
    JOIN @Targets t ON t.user_id = m.user_id
                  AND t.accommodation_id = m.accommodation_id;

    SELECT u.full_name AS manager_name, N'Chờ phân công' AS assignment_status
    FROM dbo.users u JOIN @Targets t ON t.user_id = u.id
    WHERE NOT EXISTS (SELECT 1 FROM dbo.accommodation_managers m WHERE m.user_id = u.id);

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;

-- Phase 3: lưu thời điểm nhận/trả phòng, KHÔNG đổi enum status của bookings.
-- Chạy 1 lần trên database VietPeaceStayDB.
--
-- Rollback (chạy tay khi cần):
-- ALTER TABLE dbo.bookings DROP COLUMN checked_out_by, checked_out_at, checked_in_by, checked_in_at;

IF COL_LENGTH('dbo.bookings', 'checked_in_at') IS NULL
BEGIN
    ALTER TABLE dbo.bookings ADD
        checked_in_at  DATETIME2 NULL,
        checked_out_at DATETIME2 NULL,
        checked_in_by  UNIQUEIDENTIFIER NULL,
        checked_out_by UNIQUEIDENTIFIER NULL;
END;

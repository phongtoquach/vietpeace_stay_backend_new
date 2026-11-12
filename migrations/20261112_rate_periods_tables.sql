-- T13: tạo 3 bảng rate-period mà services/booking_web_service.js (loadRoomData)
-- tham chiếu nhưng chưa tồn tại trong DB — đây là nguyên nhân booking-preview
-- trả 500 INTERNAL_SERVER_ERROR ("Invalid object name 'dbo.room_period_rates'")
-- ngay cả trước khi có tính năng chỉnh sửa booking.
-- adjustment_type khớp calculateNightPrice: fixed_price, increase_percent,
-- decrease_percent, increase_amount, decrease_amount.
-- Chạy 1 lần trên database VietPeaceStayDB. Migration idempotent.
--
-- Rollback (chạy tay khi cần, đúng thứ tự con trước cha):
-- DROP TABLE dbo.room_period_rates;
-- DROP TABLE dbo.accommodation_rate_periods;
-- DROP TABLE dbo.rate_periods;

IF OBJECT_ID(N'dbo.rate_periods', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.rate_periods (
        id INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_rate_periods PRIMARY KEY,
        name NVARCHAR(255) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        is_active BIT NOT NULL
            CONSTRAINT DF_rate_periods_is_active DEFAULT 1,
        deleted_at DATETIME2 NULL,
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_rate_periods_created_at DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2 NULL,
        CONSTRAINT CK_rate_periods_dates CHECK (start_date < end_date)
    );
END;

IF OBJECT_ID(N'dbo.accommodation_rate_periods', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.accommodation_rate_periods (
        id INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_accommodation_rate_periods PRIMARY KEY,
        accommodation_id INT NOT NULL,
        rate_period_id INT NOT NULL,
        is_active BIT NOT NULL
            CONSTRAINT DF_accommodation_rate_periods_is_active DEFAULT 1,
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_accommodation_rate_periods_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_accom_rate_periods_accommodation FOREIGN KEY (accommodation_id)
            REFERENCES dbo.accommodations(id),
        CONSTRAINT FK_accom_rate_periods_rate_period FOREIGN KEY (rate_period_id)
            REFERENCES dbo.rate_periods(id),
        CONSTRAINT UQ_accommodation_rate_periods UNIQUE (accommodation_id, rate_period_id)
    );
END;

IF OBJECT_ID(N'dbo.room_period_rates', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.room_period_rates (
        id INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_room_period_rates PRIMARY KEY,
        accommodation_rate_period_id INT NOT NULL,
        room_type_id INT NOT NULL,
        adjustment_type VARCHAR(30) NOT NULL,
        adjustment_value DECIMAL(18, 2) NOT NULL,
        CONSTRAINT FK_room_period_rates_period FOREIGN KEY (accommodation_rate_period_id)
            REFERENCES dbo.accommodation_rate_periods(id),
        CONSTRAINT FK_room_period_rates_room_type FOREIGN KEY (room_type_id)
            REFERENCES dbo.room_types(id),
        CONSTRAINT CK_room_period_rates_type CHECK (adjustment_type IN (
            'fixed_price', 'increase_percent', 'decrease_percent',
            'increase_amount', 'decrease_amount')),
        CONSTRAINT UQ_room_period_rates UNIQUE (accommodation_rate_period_id, room_type_id)
    );
END;

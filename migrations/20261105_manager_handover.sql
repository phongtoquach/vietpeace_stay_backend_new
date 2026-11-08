IF OBJECT_ID(N'dbo.manager_handover_credentials', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.manager_handover_credentials (
        user_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        encrypted_password NVARCHAR(1000) NOT NULL,
        expires_at DATETIME2 NOT NULL,
        created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_manager_handover_credentials_user
            FOREIGN KEY (user_id) REFERENCES dbo.users(id) ON DELETE CASCADE
    );
END;

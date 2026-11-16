// Additive, idempotent migration for compensation negotiation workflow.
async function ensureCompensationNegotiationSchema(pool) {
  await pool.request().query(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @lockResult int;
    EXEC @lockResult = sys.sp_getapplock
      @Resource='VietPeaceCompensationNegotiationV1', @LockMode='Exclusive',
      @LockOwner='Transaction', @LockTimeout=15000;
    IF @lockResult < 0 THROW 51000, 'Cannot acquire compensation negotiation migration lock', 1;

    IF OBJECT_ID(N'dbo.compensation_negotiations', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.compensation_negotiations (
        id                         BIGINT IDENTITY(1,1) NOT NULL,
        negotiation_code           VARCHAR(40)          NOT NULL,
        charge_id                  BIGINT               NOT NULL,
        booking_id                 BIGINT               NOT NULL,
        accommodation_id           INT                  NOT NULL,

        item_name                  NVARCHAR(200)        NOT NULL,
        quantity                   INT                  NOT NULL,
        unit_price                 DECIMAL(18,0)        NOT NULL,
        compensation_mode          VARCHAR(30)          NOT NULL,
        depreciation_percent       DECIMAL(5,2)         NOT NULL,
        original_gross_amount      DECIMAL(18,0)        NOT NULL,
        previous_adjustment_amount DECIMAL(18,0)        NOT NULL CONSTRAINT DF_cn_prev_adj DEFAULT (0),
        previous_final_amount      DECIMAL(18,0)        NOT NULL,

        requested_extra_reduction  DECIMAL(18,0)        NOT NULL,
        proposed_final_amount      DECIMAL(18,0)        NOT NULL,
        guest_opinion              NVARCHAR(1000)       NOT NULL,
        manager_note               NVARCHAR(1000)       NULL,
        evidence_images_json       NVARCHAR(MAX)        NOT NULL CONSTRAINT DF_cn_evidence_json DEFAULT (N'[]'),
        is_urgent                  BIT                  NOT NULL CONSTRAINT DF_cn_is_urgent DEFAULT (0),

        status                     VARCHAR(25)          NOT NULL CONSTRAINT DF_cn_status DEFAULT ('PENDING'),
        approved_extra_reduction   DECIMAL(18,0)        NULL,
        final_approved_amount      DECIMAL(18,0)        NULL,
        admin_decision_note        NVARCHAR(1000)       NULL,

        requested_by               UNIQUEIDENTIFIER     NOT NULL,
        reviewed_by                UNIQUEIDENTIFIER     NULL,
        reviewed_at                DATETIME2            NULL,
        manager_ack_at             DATETIME2            NULL,
        created_at                 DATETIME2            NOT NULL CONSTRAINT DF_cn_created_at DEFAULT (SYSDATETIME()),
        updated_at                 DATETIME2            NULL,
        version                    ROWVERSION           NOT NULL,

        CONSTRAINT PK_compensation_negotiations PRIMARY KEY CLUSTERED (id),
        CONSTRAINT UQ_cn_negotiation_code UNIQUE (negotiation_code),
        CONSTRAINT CK_cn_quantity CHECK (quantity >= 1),
        CONSTRAINT CK_cn_amounts CHECK (
          unit_price >= 0
          AND original_gross_amount >= 0
          AND previous_adjustment_amount >= 0
          AND previous_final_amount > 0
          AND requested_extra_reduction > 0
          AND requested_extra_reduction <= previous_final_amount
          AND proposed_final_amount = (previous_final_amount - requested_extra_reduction)
          AND (approved_extra_reduction IS NULL OR (approved_extra_reduction >= 0 AND approved_extra_reduction <= previous_final_amount))
          AND (final_approved_amount IS NULL OR (final_approved_amount >= 0 AND final_approved_amount <= previous_final_amount))
        ),
        CONSTRAINT CK_cn_evidence_json CHECK (ISJSON(evidence_images_json) = 1),
        CONSTRAINT CK_cn_status CHECK (
          status IN ('PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'CANCELLED')
        ),
        CONSTRAINT FK_cn_charge FOREIGN KEY (charge_id)
          REFERENCES dbo.booking_incidental_charges(id),
        CONSTRAINT FK_cn_booking FOREIGN KEY (booking_id)
          REFERENCES dbo.bookings(id),
        CONSTRAINT FK_cn_accommodation FOREIGN KEY (accommodation_id)
          REFERENCES dbo.accommodations(id),
        CONSTRAINT FK_cn_requested_by FOREIGN KEY (requested_by)
          REFERENCES dbo.users(id),
        CONSTRAINT FK_cn_reviewed_by FOREIGN KEY (reviewed_by)
          REFERENCES dbo.users(id)
      );
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = N'UX_cn_charge_pending'
        AND object_id = OBJECT_ID(N'dbo.compensation_negotiations')
    )
    BEGIN
      CREATE UNIQUE INDEX UX_cn_charge_pending
        ON dbo.compensation_negotiations (charge_id)
        WHERE status = 'PENDING';
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = N'IX_cn_booking_created'
        AND object_id = OBJECT_ID(N'dbo.compensation_negotiations')
    )
    BEGIN
      CREATE INDEX IX_cn_booking_created
        ON dbo.compensation_negotiations (booking_id, status, created_at DESC, id DESC);
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = N'IX_cn_accommodation_status'
        AND object_id = OBJECT_ID(N'dbo.compensation_negotiations')
    )
    BEGIN
      CREATE INDEX IX_cn_accommodation_status
        ON dbo.compensation_negotiations (accommodation_id, status, created_at DESC, id DESC);
    END;

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = N'IX_cn_status_created'
        AND object_id = OBJECT_ID(N'dbo.compensation_negotiations')
    )
    BEGIN
      CREATE INDEX IX_cn_status_created
        ON dbo.compensation_negotiations (status, is_urgent DESC, created_at DESC, id DESC);
    END;

    COMMIT TRANSACTION;
  `);
}

module.exports = { ensureCompensationNegotiationSchema };

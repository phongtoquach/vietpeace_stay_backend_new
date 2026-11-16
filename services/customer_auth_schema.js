// Additive, idempotent migration. Existing verification links remain valid.
async function ensureCustomerAuthSchema(pool) {
    await pool.request().query(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        DECLARE @lockResult int;
        EXEC @lockResult = sys.sp_getapplock
            @Resource='VietPeaceCustomerAuthSchemaV1', @LockMode='Exclusive',
            @LockOwner='Transaction', @LockTimeout=15000;
        IF @lockResult < 0 THROW 51000, 'Cannot acquire customer auth migration lock', 1;
        IF COL_LENGTH('dbo.email_verification_tokens', 'delivery_status') IS NULL
            ALTER TABLE dbo.email_verification_tokens ADD delivery_status varchar(16) NOT NULL
                CONSTRAINT DF_email_verification_delivery DEFAULT('SENT') WITH VALUES;
        IF COL_LENGTH('dbo.email_verification_tokens', 'failed_attempts') IS NULL
            ALTER TABLE dbo.email_verification_tokens ADD failed_attempts smallint NOT NULL
                CONSTRAINT DF_email_verification_attempts DEFAULT(0) WITH VALUES;
        COMMIT TRANSACTION;
    `);
}
module.exports = { ensureCustomerAuthSchema };

// One-time, explicit data correction. Preview by default; --apply commits it.
require('dotenv').config({ path: require('node:path').join(__dirname, '../.env'), quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { connectDB, sqlObj: sql } = require('../configs/database');

async function main() {
    const pool = await connectDB();
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
        const result = await new sql.Request(transaction).query(`
            SELECT * FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE role = 'ADMIN';
            SELECT * FROM dbo.users WITH (UPDLOCK, HOLDLOCK)
                WHERE role = 'ACCOMMODATION_MANAGER' AND must_change_password = 1;
        `);
        const admins = result.recordsets[0];
        const keep = admins.find(user => user.email === 'phongqt.admin@example.com' && user.full_name === 'Quách Tô Phong');
        if (!keep || keep.status !== 1) throw new Error('The designated active ADMIN was not found. No data changed.');
        const remove = admins.filter(user => user.id !== keep.id);
        if (remove.some(user => user.email !== 'thiennt_admin@example.com' || user.full_name !== 'Trần Ngọc Thiên')) {
            throw new Error('Unexpected ADMIN account. No data changed.');
        }
        console.log(JSON.stringify({ preview: !process.argv.includes('--apply'), keepAdmin: keep.full_name,
            removeAdmins: remove.map(user => user.full_name), activateManagers: result.recordsets[1].length }));
        if (!process.argv.includes('--apply')) { await transaction.rollback(); return; }

        const references = [];
        for (const user of remove) {
            const ref = await new sql.Request(transaction).input('id', sql.UniqueIdentifier, user.id)
                .query(`SELECT * FROM dbo.accommodation_managers WHERE assigned_by_user_id = @id;
                    SELECT COUNT(*) AS count FROM dbo.bookings WHERE user_id = @id;
                    SELECT COUNT(*) AS count FROM dbo.accommodation_managers WHERE user_id = @id;
                    SELECT * FROM dbo.email_verification_tokens WHERE user_id = @id;
                    SELECT * FROM dbo.password_reset_tokens WHERE user_id = @id;`);
            if (ref.recordsets[1][0].count || ref.recordsets[2][0].count) {
                throw new Error('ADMIN has business records that require explicit migration. No data changed.');
            }
            references.push({ userId: user.id, assignedBy: ref.recordsets[0], verificationTokens: ref.recordsets[3], resetTokens: ref.recordsets[4] });
        }
        const backupDir = path.join(__dirname, '../.local-backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const backupFile = path.join(backupDir, `admin-managers-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(backupFile, JSON.stringify({ createdAt: new Date().toISOString(), admins,
            managers: result.recordsets[1], references }, null, 2), { flag: 'wx', mode: 0o600 });

        for (const user of remove) {
            await new sql.Request(transaction).input('removeId', sql.UniqueIdentifier, user.id).input('keepId', sql.UniqueIdentifier, keep.id)
                .query(`UPDATE dbo.accommodation_managers SET assigned_by_user_id = @keepId WHERE assigned_by_user_id = @removeId;
                    DELETE FROM dbo.email_verification_tokens WHERE user_id = @removeId;
                    DELETE FROM dbo.password_reset_tokens WHERE user_id = @removeId;
                    DELETE FROM dbo.users WHERE id = @removeId AND role = 'ADMIN';`);
        }
        await new sql.Request(transaction).query(`
            UPDATE dbo.users SET status = 1, must_change_password = 0,
                email_verified_at = COALESCE(email_verified_at, SYSDATETIME()), updated_at = SYSDATETIME()
                WHERE role = 'ACCOMMODATION_MANAGER' AND must_change_password = 1;
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.users') AND name = 'UX_users_single_admin')
                CREATE UNIQUE INDEX UX_users_single_admin ON dbo.users(role) WHERE role = 'ADMIN';
        `);
        const migration = fs.readFileSync(path.join(__dirname, '../migrations/20261105_manager_handover.sql'), 'utf8');
        await new sql.Request(transaction).query(migration);
        const check = await new sql.Request(transaction).query(`
            SELECT id, full_name, email, status FROM dbo.users WHERE role = 'ADMIN';
            SELECT COUNT(*) AS totalManagers, SUM(CASE WHEN must_change_password = 1 THEN 1 ELSE 0 END) AS pendingPassword,
                SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS activeManagers FROM dbo.users WHERE role = 'ACCOMMODATION_MANAGER';
            SELECT COUNT(*) AS assignedManagers FROM dbo.accommodation_managers;
        `);
        if (check.recordsets[0].length !== 1 || check.recordsets[0][0].id !== keep.id || check.recordsets[1][0].pendingPassword !== 0) {
            throw new Error('Post-update verification failed. Rolling back.');
        }
        await transaction.commit();
        console.log(JSON.stringify({ committed: true, backupFile, verification: check.recordsets }, null, 2));
    } catch (error) {
        try { await transaction.rollback(); } catch { /* Preserve original failure. */ }
        throw error;
    } finally {
        await sql.close();
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

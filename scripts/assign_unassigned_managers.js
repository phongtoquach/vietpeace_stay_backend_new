// Explicit batch assignment: keep existing credentials and active status.
// Preview by default; --apply commits all assignments in one transaction.
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
            SELECT id, full_name FROM dbo.users
                WHERE role = 'ADMIN' AND status = 1 AND email = 'phongqt.admin@example.com';
            SELECT a.id, a.accommodation_name, a.accommodation_code
                FROM dbo.accommodations a WITH (UPDLOCK, HOLDLOCK)
                WHERE a.deleted_at IS NULL AND a.status = 1 AND NOT EXISTS (
                    SELECT 1 FROM dbo.accommodation_managers m WITH (UPDLOCK, HOLDLOCK)
                    WHERE m.accommodation_id = a.id)
                ORDER BY a.sort_order, a.id;
            SELECT u.id, u.full_name, u.email, u.status, u.must_change_password
                FROM dbo.users u WITH (UPDLOCK, HOLDLOCK)
                WHERE u.role = 'ACCOMMODATION_MANAGER' AND NOT EXISTS (
                    SELECT 1 FROM dbo.accommodation_managers m WITH (UPDLOCK, HOLDLOCK)
                    WHERE m.user_id = u.id)
                ORDER BY u.created_at, u.id;
            SELECT accommodation_id, user_id, assigned_by_user_id, assigned_at
                FROM dbo.accommodation_managers WITH (UPDLOCK, HOLDLOCK);
        `);
        const [admins, vacancies, managers, previousAssignments] = result.recordsets;
        if (admins.length !== 1) throw new Error('Designated active ADMIN was not found.');
        if (managers.length === 0) {
            console.log('All managers are already assigned. No data changed.');
            await transaction.rollback();
            return;
        }
        if (managers.length !== 20) throw new Error(`Expected exactly 20 unassigned managers; found ${managers.length}. No data changed.`);
        if (vacancies.length < managers.length) throw new Error('Not enough vacant active accommodations.');
        if (managers.some(user => user.status !== 1 || user.must_change_password)) {
            throw new Error('An unassigned manager is inactive or requires a password change. No data changed.');
        }
        const assignments = managers.map((manager, index) => ({
            userId: manager.id, fullName: manager.full_name, email: manager.email,
            accommodationId: vacancies[index].id,
            accommodationName: vacancies[index].accommodation_name,
            accommodationCode: vacancies[index].accommodation_code,
        }));
        console.log(JSON.stringify({ preview: !process.argv.includes('--apply'), assignments,
            remainingVacancies: vacancies.length - assignments.length }, null, 2));
        if (!process.argv.includes('--apply')) { await transaction.rollback(); return; }

        const backupDir = path.join(__dirname, '../.local-backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const auditFile = path.join(backupDir, `manager-assignments-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(auditFile, JSON.stringify({ createdAt: new Date().toISOString(),
            adminId: admins[0].id, previousAssignments, newAssignments: assignments }, null, 2), { flag: 'wx', mode: 0o600 });

        for (const assignment of assignments) {
            await new sql.Request(transaction)
                .input('userId', sql.UniqueIdentifier, assignment.userId)
                .input('accommodationId', sql.Int, assignment.accommodationId)
                .input('adminId', sql.UniqueIdentifier, admins[0].id)
                .query(`INSERT INTO dbo.accommodation_managers (accommodation_id, user_id, assigned_by_user_id)
                    VALUES (@accommodationId, @userId, @adminId);`);
        }
        const check = await new sql.Request(transaction).query(`
            SELECT COUNT(*) AS assignedManagers FROM dbo.accommodation_managers;
            SELECT COUNT(*) AS unassignedManagers FROM dbo.users u WHERE u.role = 'ACCOMMODATION_MANAGER'
                AND NOT EXISTS (SELECT 1 FROM dbo.accommodation_managers m WHERE m.user_id = u.id);
            SELECT COUNT(*) AS vacantAccommodations FROM dbo.accommodations a
                WHERE a.deleted_at IS NULL AND a.status = 1
                AND NOT EXISTS (SELECT 1 FROM dbo.accommodation_managers m WHERE m.accommodation_id = a.id);
            SELECT COUNT(*) AS pendingPassword FROM dbo.users
                WHERE role = 'ACCOMMODATION_MANAGER' AND must_change_password = 1;
        `);
        if (check.recordsets[0][0].assignedManagers !== previousAssignments.length + 20 || check.recordsets[1][0].unassignedManagers !== 0) {
            throw new Error('Assignment verification failed. Rolling back.');
        }
        await transaction.commit();
        console.log(JSON.stringify({ committed: true, auditFile, verification: check.recordsets }, null, 2));
    } catch (error) {
        try { await transaction.rollback(); } catch { /* Preserve original error. */ }
        throw error;
    } finally {
        await sql.close();
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

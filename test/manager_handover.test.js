const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
const { encryptPassword, decryptPassword } = require('../services/handover_credentials_service');

test('handover encryption authenticates ciphertext and binds it to the user', () => {
    const secret = 'TemporaryTestOnly123!';
    const encrypted = encryptPassword(secret, 'manager-1');
    assert.ok(!encrypted.includes(secret));
    assert.equal(decryptPassword(encrypted, 'MANAGER-1'), secret);
    assert.throws(() => decryptPassword(encrypted, 'manager-2'));
    const parts = encrypted.split('.');
    const tampered = Buffer.from(parts[2], 'base64');
    tampered[0] ^= 1;
    parts[2] = tampered.toString('base64');
    assert.throws(() => decryptPassword(parts.join('.'), 'manager-1'));
});

// Optional SQL integration tests use the real constraints/queries under an outer
// transaction. Service commits become savepoints and EVERY test is rolled back.
// Email is stubbed: no external recipients are contacted.
const integration = process.env.RUN_DB_HANDOVER_TESTS === '1';
let sql, pool, RealRequest, RealTransaction, db, service, originalPool, originalMail;
let activeTransaction;
let failCredentials = false;
let sent = [];
let delivery = { success: true, method: 'smtp' };

before(async () => {
    if (!integration) return;
    sql = require('mssql');
    db = require('../configs/database');
    pool = await db.connectDB();
    RealRequest = sql.Request;
    RealTransaction = sql.Transaction;
    originalPool = db.getDBPool;
    class SavepointTransaction {
        constructor() { this.savepoint = 'handover_' + crypto.randomBytes(6).toString('hex'); }
        async begin() { await new RealRequest(activeTransaction).query(`SAVE TRANSACTION ${this.savepoint};`); }
        async commit() {}
        async rollback() { await new RealRequest(activeTransaction).query(`ROLLBACK TRANSACTION ${this.savepoint};`); }
    }
    class TestRequest extends RealRequest {
        constructor(parent) { super(parent instanceof SavepointTransaction ? activeTransaction : parent); }
        async query(query) {
            if (failCredentials && query.includes('INSERT INTO dbo.manager_handover_credentials')) {
                throw new Error('Simulated credential write failure');
            }
            return super.query(query);
        }
    }
    sql.Transaction = SavepointTransaction;
    sql.Request = TestRequest;
    db.getDBPool = () => ({ request: () => new RealRequest(activeTransaction) });
    const mail = require('../services/mail_service');
    originalMail = mail.sendAccountProvisionEmail;
    mail.sendAccountProvisionEmail = async payload => { sent.push(payload); return delivery; };
    service = require('../services/manager_handover_service');
});

after(async () => {
    if (!integration) return;
    sql.Transaction = RealTransaction;
    sql.Request = RealRequest;
    db.getDBPool = originalPool;
    require('../services/mail_service').sendAccountProvisionEmail = originalMail;
    await sql.close();
});

async function fixture(run) {
    activeTransaction = new RealTransaction(pool);
    await activeTransaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    sent = [];
    delivery = { success: true, method: 'smtp' };
    failCredentials = false;
    try {
        const result = await new RealRequest(activeTransaction).query(`
            SELECT TOP (1) id, role FROM dbo.users WHERE role = 'ADMIN' AND status = 1;
            SELECT TOP (1) m.accommodation_id, m.user_id FROM dbo.accommodation_managers m
                JOIN dbo.accommodations a ON a.id = m.accommodation_id WHERE a.deleted_at IS NULL ORDER BY m.accommodation_id;
            SELECT TOP (1) u.id, u.email FROM dbo.users u WHERE u.role = 'ACCOMMODATION_MANAGER' AND u.status = 1
                AND NOT EXISTS (SELECT 1 FROM dbo.accommodation_managers m WHERE m.user_id = u.id);
            SELECT TOP (1) a.id FROM dbo.accommodations a WHERE a.deleted_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM dbo.accommodation_managers m WHERE m.accommodation_id = a.id);
        `);
        const [admins, assigned, available, vacant] = result.recordsets;
        assert.ok(admins[0] && assigned[0] && available[0] && vacant[0], 'Required test fixtures exist');
        await run({ admin: admins[0], old: assigned[0], available: available[0], vacant: vacant[0] });
    } finally {
        failCredentials = false;
        await activeTransaction.rollback();
        activeTransaction = null;
    }
}

function dbTest(name, run) { test(name, { skip: !integration }, () => fixture(run)); }
async function mapping(id) {
    const result = await new RealRequest(activeTransaction).input('id', sql.Int, id)
        .query('SELECT user_id FROM dbo.accommodation_managers WHERE accommodation_id = @id;');
    return result.recordset[0]?.user_id;
}

dbTest('revoke without replacement is rejected and original manager stays assigned', async ({ admin, old }) => {
    await assert.rejects(service.revokeAccommodationManager(old.accommodation_id, {}, admin), { errorCode: 'REPLACEMENT_REQUIRED' });
    assert.equal(await mapping(old.accommodation_id), old.user_id);
    assert.equal(sent.length, 0);
});

dbTest('manager cannot assign or resend credentials', async ({ old, available }) => {
    const manager = { id: available.id, role: 'ACCOMMODATION_MANAGER' };
    await assert.rejects(service.assignAccommodationManager(old.accommodation_id, { managerId: available.id }, manager), { errorCode: 'FORBIDDEN' });
    await assert.rejects(service.resendManagerCredentials(old.accommodation_id, old.user_id, manager), { errorCode: 'FORBIDDEN' });
});

dbTest('initial assignment and resend use the same encrypted temporary password', async ({ admin, available, vacant }) => {
    const assigned = await service.assignAccommodationManager(vacant.id, { managerId: available.id }, admin);
    assert.equal(assigned.emailSent, true);
    assert.equal(await mapping(vacant.id), available.id);
    const credentials = await new RealRequest(activeTransaction).input('id', sql.UniqueIdentifier, available.id)
        .query('SELECT encrypted_password FROM dbo.manager_handover_credentials WHERE user_id = @id;');
    assert.ok(!credentials.recordset[0].encrypted_password.includes(sent[0].temporaryPassword));
    const resent = await service.resendManagerCredentials(vacant.id, available.id, admin);
    assert.equal(resent.emailSent, true);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].temporaryPassword, sent[0].temporaryPassword);
    assert.equal(sent[1].internalEmail, sent[0].internalEmail);
    assert.ok(!JSON.stringify(resent).includes(sent[0].temporaryPassword));
});

dbTest('replacement succeeds atomically with an unassigned manager', async ({ admin, old, available }) => {
    const result = await service.revokeAccommodationManager(old.accommodation_id,
        { managerId: available.id, expectedManagerId: old.user_id }, admin);
    assert.equal(result.userId, available.id);
    assert.equal(await mapping(old.accommodation_id), available.id);
    const released = await new RealRequest(activeTransaction).input('id', sql.UniqueIdentifier, old.user_id)
        .query('SELECT email, must_change_password FROM dbo.users WHERE id = @id;');
    assert.match(released.recordset[0].email, /^mgr\.pool\./);
    assert.equal(released.recordset[0].must_change_password, false);
});

dbTest('a new replacement manager is created and assigned in the same transaction', async ({ admin, old }) => {
    const result = await service.revokeAccommodationManager(old.accommodation_id, {
        expectedManagerId: old.user_id, fullName: 'Integration Test Manager',
        personalEmail: `handover-${crypto.randomUUID()}@example.test`, phoneNumber: '0901234567',
    }, admin);
    assert.equal(await mapping(old.accommodation_id), result.userId);
    assert.equal(result.fullName, 'Integration Test Manager');
});

dbTest('stale replacement and selecting the current manager are rejected', async ({ admin, old, available }) => {
    await assert.rejects(service.revokeAccommodationManager(old.accommodation_id,
        { managerId: available.id, expectedManagerId: available.id }, admin), { errorCode: 'MANAGER_CHANGED' });
    await assert.rejects(service.revokeAccommodationManager(old.accommodation_id,
        { managerId: old.user_id, expectedManagerId: old.user_id }, admin), { errorCode: 'MANAGER_ALREADY_ASSIGNED' });
    assert.equal(await mapping(old.accommodation_id), old.user_id);
});

dbTest('a failed write rolls back removal, reassignment and password changes', async ({ admin, old, available }) => {
    failCredentials = true;
    await assert.rejects(service.revokeAccommodationManager(old.accommodation_id,
        { managerId: available.id, expectedManagerId: old.user_id }, admin), /Simulated credential write failure/);
    assert.equal(await mapping(old.accommodation_id), old.user_id);
    const unchanged = await new RealRequest(activeTransaction).input('id', sql.UniqueIdentifier, available.id)
        .query('SELECT email FROM dbo.users WHERE id = @id;');
    assert.equal(unchanged.recordset[0].email, available.email);
    assert.equal(sent.length, 0);
});

dbTest('SMTP failure keeps a retryable assignment and does not claim mail success', async ({ admin, available, vacant }) => {
    delivery = { success: false, method: 'smtp_error' };
    const result = await service.assignAccommodationManager(vacant.id, { managerId: available.id }, admin);
    assert.equal(result.emailSent, false);
    assert.equal(await mapping(vacant.id), available.id);
    delivery = { success: true, method: 'smtp' };
    const resent = await service.resendManagerCredentials(vacant.id, available.id, admin);
    assert.equal(resent.emailSent, true);
    assert.equal(sent[1].temporaryPassword, sent[0].temporaryPassword);
});

dbTest('resend is rejected after password change, expiration or manager change', async ({ admin, available, vacant, old }) => {
    await service.assignAccommodationManager(vacant.id, { managerId: available.id }, admin);
    await assert.rejects(service.resendManagerCredentials(vacant.id, old.user_id, admin), { errorCode: 'HANDOVER_NOT_AVAILABLE' });
    await new RealRequest(activeTransaction).input('id', sql.UniqueIdentifier, available.id)
        .query('UPDATE dbo.users SET must_change_password = 0 WHERE id = @id;');
    await assert.rejects(service.resendManagerCredentials(vacant.id, available.id, admin), { errorCode: 'HANDOVER_NOT_AVAILABLE' });
    await new RealRequest(activeTransaction).input('id', sql.UniqueIdentifier, available.id)
        .query(`UPDATE dbo.users SET must_change_password = 1 WHERE id = @id;
            UPDATE dbo.manager_handover_credentials SET expires_at = DATEADD(day, -1, SYSUTCDATETIME()) WHERE user_id = @id;`);
    await assert.rejects(service.resendManagerCredentials(vacant.id, available.id, admin), { errorCode: 'HANDOVER_NOT_AVAILABLE' });
    assert.equal(sent.length, 1);
});

function routeRequest(router, method, url, body, currentAdmin) {
    return new Promise((resolve, reject) => {
        const req = { method, url, originalUrl: '/api/admin/accommodations' + url, body,
            currentAdmin, session: { admin: { ...currentAdmin, mustChangePassword: false } } };
        const res = { status(code) { this.code = code; return this; }, json(value) { resolve({ code: this.code || 200, body: value }); return this; } };
        router.handle(req, res, error => reject(error || new Error('Unexpected router fallthrough')));
    });
}

dbTest('HTTP routes enforce ADMIN and reject standalone revoke', async ({ admin, old, available }) => {
    const router = require('../routes/admin/accommodation_admin_routes');
    const denied = await routeRequest(router, 'POST', `/${old.accommodation_id}/resend-manager-credentials`,
        { expectedManagerId: old.user_id }, { id: available.id, role: 'ACCOMMODATION_MANAGER' });
    assert.equal(denied.code, 403);
    const missing = await routeRequest(router, 'DELETE', `/${old.accommodation_id}/managers`, {}, admin);
    assert.equal(missing.code, 400);
    assert.equal(missing.body.errorCode, 'REPLACEMENT_REQUIRED');
    assert.equal(await mapping(old.accommodation_id), old.user_id);
});

dbTest('HTTP contract separates assignment success from failed email delivery', async ({ admin, vacant, available }) => {
    const router = require('../routes/admin/accommodation_admin_routes');
    delivery = { success: false, method: 'smtp_error' };
    const assigned = await routeRequest(router, 'POST', `/${vacant.id}/assign-manager`, { managerId: available.id }, admin);
    assert.equal(assigned.code, 201);
    assert.equal(assigned.body.success, true);
    assert.equal(assigned.body.data.emailSent, false);
    const resend = await routeRequest(router, 'POST', `/${vacant.id}/resend-manager-credentials`, { expectedManagerId: available.id }, admin);
    assert.equal(resend.code, 502);
    assert.equal(resend.body.success, false);
});

dbTest('assigned-manager deletion and invalid ADMIN status cannot bypass safeguards', async ({ admin, old }) => {
    const userService = require('../services/user_admin_service');
    await assert.rejects(userService.deleteAdminUser(old.user_id, admin), { errorCode: 'REPLACEMENT_REQUIRED' });
    assert.equal(await mapping(old.accommodation_id), old.user_id);
    await assert.rejects(userService.updateAdminUser(admin.id, { fullName: 'Admin', status: 0 }, admin), { errorCode: 'INVALID_STATUS' });
});

dbTest('SMTP success requires recipient acceptance; rejection/configuration failure stays failed', async () => {
    const nodemailer = require('nodemailer');
    const realTransport = nodemailer.createTransport;
    const names = ['SMTP_USER', 'SMTP_PASS', 'ADMIN_PANEL_DOMAIN'];
    const env = Object.fromEntries(names.map(name => [name, process.env[name]]));
    const message = { toGmail: 'handover@example.test', fullName: 'Test', roleTitle: 'Manager',
        accommodationName: 'Test', internalEmail: 'internal@example.test', temporaryPassword: 'TestOnly123!' };
    try {
        process.env.SMTP_USER = 'sender@example.test';
        process.env.SMTP_PASS = 'test-only';
        process.env.ADMIN_PANEL_DOMAIN = 'http://localhost:5175';
        let info = { accepted: [message.toGmail] };
        nodemailer.createTransport = () => ({ sendMail: async payload => {
            assert.ok(payload.html.includes('/login?email='));
            return info;
        } });
        assert.deepEqual(await originalMail(message), { success: true, method: 'smtp' });
        info = { accepted: [], rejected: [message.toGmail] };
        assert.deepEqual(await originalMail(message), { success: false, method: 'smtp_rejected' });
        delete process.env.SMTP_USER;
        assert.deepEqual(await originalMail(message), { success: false, method: 'smtp_not_configured' });
    } finally {
        nodemailer.createTransport = realTransport;
        for (const name of names) {
            if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
        }
    }
});

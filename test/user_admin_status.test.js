const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../configs/database');

let user;
let writes;
db.getDBPool = () => ({
    request() {
        const inputs = {};
        return {
            input(name, _type, value) { inputs[name] = value; return this; },
            async query(query) {
                if (query.includes('SELECT id,') && query.includes('FROM dbo.users WHERE id = @id')) {
                    return { recordset: user ? [{ ...user }] : [] };
                }
                if (query.includes('UPDATE dbo.users')) {
                    writes.push({ ...inputs });
                    user.status = inputs.status;
                    return { rowsAffected: [1] };
                }
                throw new Error('Unexpected query in status test');
            },
        };
    },
});
const service = require('../services/user_admin_service');
const admin = { id: 'admin-1', role: 'ADMIN' };

beforeEach(() => {
    user = { id: 'admin-1', role: 'ADMIN', status: 1, full_name: 'Admin', personal_email: null };
    writes = [];
});

test('ADMIN status toggle is forbidden for self and other callers', async () => {
    for (const caller of [admin, { id: 'another-admin', role: 'ADMIN' }]) {
        await assert.rejects(service.toggleUserStatus(user.id, caller), { statusCode: 403, errorCode: 'ADMIN_STATUS_IMMUTABLE' });
    }
    assert.equal(user.status, 1);
    assert.equal(writes.length, 0);
});

test('profile update cannot lock ADMIN', async () => {
    await assert.rejects(service.updateAdminUser(user.id, { fullName: 'Admin', status: 2 }, admin),
        { statusCode: 403, errorCode: 'ADMIN_STATUS_IMMUTABLE' });
    assert.equal(writes.length, 0);
});

test('ADMIN profile can still be edited without changing status', async () => {
    const result = await service.updateAdminUser(user.id, { fullName: 'Updated Admin', phoneNumber: '0901234567' }, admin);
    assert.equal(result.fullName, 'Updated Admin');
    assert.equal(result.status, 1);
    assert.equal(writes.length, 1);
});

test('invalid status cannot bypass ADMIN protection', async () => {
    for (const status of [0, 3, -1, 'invalid', null]) {
        await assert.rejects(service.updateAdminUser(user.id, { fullName: 'Admin', status }, admin), { errorCode: 'INVALID_STATUS' });
    }
    assert.equal(writes.length, 0);
});

test('manager lock and unlock still work', async () => {
    user = { id: 'manager-1', role: 'ACCOMMODATION_MANAGER', status: 1, full_name: 'Manager', personal_email: null };
    assert.equal((await service.toggleUserStatus(user.id, admin)).status, 2);
    assert.equal((await service.toggleUserStatus(user.id, admin)).status, 1);
    assert.equal(writes.length, 2);
});

test('manager status can still be changed through profile update', async () => {
    user = { id: 'manager-1', role: 'ACCOMMODATION_MANAGER', status: 1, full_name: 'Manager', personal_email: null };
    assert.equal((await service.updateAdminUser(user.id, { fullName: 'Manager', status: 2 }, admin)).status, 2);
});

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../configs/database');
const sql = require('mssql');
const generator = require('../utils/account_generator');

let emailOwner, phoneOwner, inserted, committed, rolledBack, inputsSeen;
class Transaction {
    async begin(level) { assert.equal(level, sql.ISOLATION_LEVEL.SERIALIZABLE); }
    async commit() { committed = true; }
    async rollback() { rolledBack = true; }
}
class Request {
    constructor() { this.inputs = {}; }
    input(name, _type, value) { this.inputs[name] = value; return this; }
    async query(query) {
        inputsSeen.push(this.inputs);
        if (query.includes('INSERT INTO dbo.users')) {
            inserted++;
            return { recordset: [{ id: 'new-manager', full_name: this.inputs.fullName, phone_number: this.inputs.phoneNumber }] };
        }
        assert.match(query, /UPDLOCK, HOLDLOCK/);
        if ('personalEmail' in this.inputs) return { recordset: emailOwner ? [emailOwner] : [] };
        if ('phoneKey' in this.inputs) return { recordset: phoneOwner ? [phoneOwner] : [] };
        throw new Error('Unexpected query');
    }
}
require.cache[require.resolve('mssql')].exports = { ...sql, Transaction, Request };
db.getDBPool = () => ({});
generator.generateUniqueInternalEmail = async () => 'pending@vietpeacestay.vn';
const { createManagerUser } = require('../services/user_admin_service');
const profile = { fullName: 'New Manager', personalEmail: ' NEW@example.com ', phoneNumber: '+84 912-345-678' };

beforeEach(() => {
    emailOwner = phoneOwner = null;
    inserted = 0;
    committed = rolledBack = false;
    inputsSeen = [];
});

test('duplicate email names the owner, requests a different email and creates no account', async () => {
    emailOwner = { full_name: 'Existing Manager' };
    await assert.rejects(createManagerUser(profile), error => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.errorCode, 'EMAIL_ALREADY_EXISTS');
        assert.match(error.message, /Existing Manager/);
        assert.match(error.message, /email khác/);
        return true;
    });
    assert.equal(inputsSeen[0].personalEmail, 'new@example.com');
    assert.equal(inserted, 0);
    assert.equal(rolledBack, true);
});

test('duplicate phone names the Manager and rejects formatted international numbers', async () => {
    phoneOwner = { full_name: 'Phone Owner' };
    await assert.rejects(createManagerUser(profile), error => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.errorCode, 'PHONE_ALREADY_EXISTS');
        assert.match(error.message, /Phone Owner/);
        assert.match(error.message, /số điện thoại khác/);
        return true;
    });
    assert.equal(inputsSeen[1].phoneKey, '0912345678');
    assert.equal(inserted, 0);
    assert.equal(rolledBack, true);
});

test('unique contacts can create an account', async () => {
    await createManagerUser(profile);
    assert.equal(inserted, 1);
    assert.equal(committed, true);
    assert.equal(rolledBack, false);
});

test('phone remains optional and skips duplicate checks when blank', async () => {
    await createManagerUser({ ...profile, phoneNumber: '   ' });
    assert.equal(inputsSeen.some(inputs => 'phoneKey' in inputs), false);
    assert.equal(inputsSeen.at(-1).phoneNumber, null);
    assert.equal(committed, true);
});

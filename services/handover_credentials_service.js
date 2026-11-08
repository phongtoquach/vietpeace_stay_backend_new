const crypto = require('node:crypto');

// Reuse the configured server secret with a separate derivation context. Never
// expose the ciphertext or plaintext through API responses or application logs.
function encryptionKey() {
    const secret = process.env.ADMIN_SESSION_SECRET;
    if (!secret) throw new Error('ADMIN_SESSION_SECRET is required for manager handovers.');
    return crypto.hkdfSync('sha256', secret, 'vietpeace-stay', 'manager-handover-v1', 32);
}

function encryptPassword(password, userId) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    cipher.setAAD(Buffer.from(String(userId).toLowerCase()));
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64')).join('.');
}

function decryptPassword(value, userId) {
    const [iv, tag, encrypted] = value.split('.').map(part => Buffer.from(part, 'base64'));
    const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    cipher.setAAD(Buffer.from(String(userId).toLowerCase()));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}

module.exports = { encryptPassword, decryptPassword };

const crypto = require("crypto");
const session = require("express-session");
const { getDBPool, sqlObj } = require("./database");

function hashSessionId(sid) {
  return crypto.createHash("sha256").update(String(sid)).digest("hex");
}

function resolveExpiryDate(sessionData) {
  const cookieExpires = sessionData?.cookie?.expires;
  if (cookieExpires) {
    const dt = new Date(cookieExpires);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  const maxAge = Number(sessionData?.cookie?.originalMaxAge);
  const ttl = Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ttl);
}

class SqlSessionStore extends session.Store {
  constructor(audience) {
    super();
    this.audience = audience;
  }

  get(sid, callback) {
    (async () => {
      const pool = getDBPool();
      const sidHash = hashSessionId(sid);
      const res = await pool
        .request()
        .input("sidHash", sqlObj.Char(64), sidHash)
        .input("audience", sqlObj.VarChar(20), this.audience)
        .query(`
          SELECT data, expires_at
          FROM dbo.chat_http_sessions
          WHERE sid_hash = @sidHash
            AND audience = @audience;
        `);
      const row = res.recordset[0];
      if (!row) return callback(null, null);
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await pool
          .request()
          .input("sidHash", sqlObj.Char(64), sidHash)
          .query(`DELETE FROM dbo.chat_http_sessions WHERE sid_hash = @sidHash;`);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.data));
    })().catch((err) => callback(err));
  }

  set(sid, sessionData, callback) {
    (async () => {
      const pool = getDBPool();
      const sidHash = hashSessionId(sid);
      const jsonData = JSON.stringify(sessionData);
      const expiresAt = resolveExpiryDate(sessionData);
      await pool
        .request()
        .input("sidHash", sqlObj.Char(64), sidHash)
        .input("audience", sqlObj.VarChar(20), this.audience)
        .input("data", sqlObj.NVarChar(sqlObj.MAX), jsonData)
        .input("expiresAt", sqlObj.DateTime2(3), expiresAt)
        .query(`
          MERGE dbo.chat_http_sessions AS target
          USING (SELECT @sidHash AS sid_hash) AS src
          ON target.sid_hash = src.sid_hash
          WHEN MATCHED THEN
            UPDATE SET audience = @audience, data = @data, expires_at = @expiresAt, updated_at = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN
            INSERT (sid_hash, audience, data, expires_at)
            VALUES (@sidHash, @audience, @data, @expiresAt);
        `);
      callback(null);
    })().catch((err) => callback(err));
  }

  touch(sid, sessionData, callback) {
    (async () => {
      const pool = getDBPool();
      const sidHash = hashSessionId(sid);
      const expiresAt = resolveExpiryDate(sessionData);
      await pool
        .request()
        .input("sidHash", sqlObj.Char(64), sidHash)
        .input("audience", sqlObj.VarChar(20), this.audience)
        .input("expiresAt", sqlObj.DateTime2(3), expiresAt)
        .query(`
          UPDATE dbo.chat_http_sessions
          SET expires_at = @expiresAt, updated_at = SYSUTCDATETIME()
          WHERE sid_hash = @sidHash AND audience = @audience;
        `);
      callback(null);
    })().catch((err) => callback(err));
  }

  destroy(sid, callback) {
    (async () => {
      const pool = getDBPool();
      const sidHash = hashSessionId(sid);
      await pool
        .request()
        .input("sidHash", sqlObj.Char(64), sidHash)
        .query(`DELETE FROM dbo.chat_http_sessions WHERE sid_hash = @sidHash;`);
      callback(null);
    })().catch((err) => callback(err));
  }
}

function createSessionStore(audience) {
  return new SqlSessionStore(audience);
}

async function readSessionById(sid, audience) {
  if (!sid) return null;
  const pool = getDBPool();
  const sidHash = hashSessionId(sid);
  const res = await pool
    .request()
    .input("sidHash", sqlObj.Char(64), sidHash)
    .input("audience", sqlObj.VarChar(20), audience)
    .query(`
      SELECT data, expires_at
      FROM dbo.chat_http_sessions
      WHERE sid_hash = @sidHash
        AND audience = @audience
        AND expires_at > SYSUTCDATETIME();
    `);
  if (!res.recordset[0]) return null;
  return JSON.parse(res.recordset[0].data);
}

async function deleteSessionByUserId(userId, audience = null) {
  if (!userId) return;
  const pool = getDBPool();
  const normalizedId = String(userId).toLowerCase();
  const res = await pool
    .request()
    .input("audience", sqlObj.VarChar(20), audience)
    .query(`
      SELECT sid_hash, audience, data
      FROM dbo.chat_http_sessions
      WHERE (@audience IS NULL OR audience = @audience);
    `);
  const toDelete = [];
  for (const row of res.recordset) {
    try {
      const parsed = JSON.parse(row.data);
      const sessUserId = (parsed?.customer?.id || parsed?.admin?.id || "").toLowerCase();
      if (sessUserId && sessUserId === normalizedId) {
        toDelete.push(row.sid_hash);
      }
    } catch {
      // ignore malformed JSON
    }
  }
  if (toDelete.length > 0) {
    await pool
      .request()
      .input("hashesJson", sqlObj.NVarChar(sqlObj.MAX), JSON.stringify(toDelete))
      .query(`
        DELETE s
        FROM dbo.chat_http_sessions AS s
        INNER JOIN OPENJSON(@hashesJson) WITH (sid_hash CHAR(64) '$') AS j
          ON j.sid_hash = s.sid_hash;
      `);
  }
}

module.exports = {
  SqlSessionStore,
  createSessionStore,
  hashSessionId,
  readSessionById,
  deleteSessionByUserId,
};

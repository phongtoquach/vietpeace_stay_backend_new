const config = require("../../configs/chat");
const { getDBPool, sqlObj } = require("../../configs/database");
const { chatError, sha256, randomToken, actorKeyForGuest } = require("./db");

// IP rate limit: 20 guest session creations per IP per hour
const ipCreations = new Map();

function enforceGuestIpRateLimit(ip) {
  const key = String(ip || "unknown");
  const now = Date.now();
  const windowMs = 3600 * 1000;
  const list = (ipCreations.get(key) || []).filter((ts) => now - ts < windowMs);
  if (list.length >= 20) {
    throw chatError(
      429,
      "GUEST_RATE_LIMIT",
      "Bạn đã khởi tạo quá nhiều phiên trò chuyện tạm trong 1 giờ. Vui lòng thử lại sau hoặc đăng nhập tài khoản.",
    );
  }
  list.push(now);
  ipCreations.set(key, list);
}

function parseCookies(req) {
  const rawHeader = req?.headers?.cookie || "";
  const map = {};
  for (const part of rawHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      map[name] = decodeURIComponent(val);
    } catch {
      map[name] = val;
    }
  }
  return map;
}

function getGuestRawToken(req) {
  const cookies = parseCookies(req);
  const token = cookies[config.guestCookieName];
  return token && typeof token === "string" && token.length >= 16 ? token.trim() : null;
}

function setGuestCookie(res, rawToken) {
  if (!res || typeof res.cookie !== "function") return;
  res.cookie(config.guestCookieName, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: config.guestSessionDays * 24 * 60 * 60 * 1000,
  });
}

function clearGuestCookie(res) {
  if (!res || typeof res.clearCookie !== "function") return;
  res.clearCookie(config.guestCookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

async function resolveGuestByRawToken(rawToken) {
  if (!rawToken) return null;
  const pool = getDBPool();
  const tokenHash = sha256(rawToken);
  const res = await pool
    .request()
    .input("tokenHash", sqlObj.Char(64), tokenHash)
    .query(`
      SELECT TOP 1
        id,
        claimed_by_user_id AS claimedByUserId,
        revoked_at AS revokedAt,
        expires_at AS expiresAt
      FROM dbo.chat_guest_sessions
      WHERE token_hash = @tokenHash;
    `);
  const row = res.recordset[0];
  if (!row) return null;
  if (row.revokedAt || row.claimedByUserId || new Date(row.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  await pool
    .request()
    .input("id", sqlObj.UniqueIdentifier, row.id)
    .query(`UPDATE dbo.chat_guest_sessions SET last_seen_at = SYSUTCDATETIME() WHERE id = @id;`);

  return {
    type: "GUEST",
    guestSessionId: row.id,
    actorKey: actorKeyForGuest(row.id),
    role: "GUEST",
    displayName: "Khách vãng lai",
    rawToken,
  };
}

async function createOrRefreshGuestSession(req, res) {
  const existingToken = getGuestRawToken(req);
  if (existingToken) {
    const valid = await resolveGuestByRawToken(existingToken);
    if (valid) {
      setGuestCookie(res, existingToken);
      return valid;
    }
  }

  enforceGuestIpRateLimit(req?.ip || req?.socket?.remoteAddress);
  const rawToken = randomToken(32);
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + config.guestSessionDays * 24 * 60 * 60 * 1000);

  const pool = getDBPool();
  const insertRes = await pool
    .request()
    .input("tokenHash", sqlObj.Char(64), tokenHash)
    .input("expiresAt", sqlObj.DateTime2(3), expiresAt)
    .query(`
      INSERT INTO dbo.chat_guest_sessions (token_hash, expires_at, last_seen_at)
      OUTPUT INSERTED.id
      VALUES (@tokenHash, @expiresAt, SYSUTCDATETIME());
    `);

  const guestId = insertRes.recordset[0].id;
  setGuestCookie(res, rawToken);

  return {
    type: "GUEST",
    guestSessionId: guestId,
    actorKey: actorKeyForGuest(guestId),
    role: "GUEST",
    displayName: "Khách vãng lai",
    rawToken,
  };
}

module.exports = {
  parseCookies,
  getGuestRawToken,
  setGuestCookie,
  clearGuestCookie,
  resolveGuestByRawToken,
  createOrRefreshGuestSession,
};

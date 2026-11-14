const config = require("../../configs/chat");
const { getDBPool, sqlObj } = require("../../configs/database");
const { readSessionById, deleteSessionByUserId } = require("../../configs/sessionStore");
const {
  chatError,
  sha256,
  randomToken,
  actorKeyForUser,
  enqueueOutbox,
  newRequest,
} = require("./db");
const { getGuestRawToken, resolveGuestByRawToken, parseCookies } = require("./guest");

// Short-lived auth validation cache for AI token streaming (invalidated immediately on logout/revocation)
const authCache = new Map();

function invalidateActorAuthCache(userId) {
  if (!userId) return;
  authCache.delete(String(userId).toLowerCase());
}

function cacheActor(userId, data) {
  authCache.set(String(userId).toLowerCase(), {
    data,
    expiresAt: Date.now() + config.authCacheTtlMs,
  });
}

function getCachedActor(userId) {
  const entry = authCache.get(String(userId).toLowerCase());
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    authCache.delete(String(userId).toLowerCase());
    return null;
  }
  return entry.data;
}

async function loadCustomerById(userId) {
  if (!userId) return null;
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("userId", sqlObj.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1
        id,
        email,
        full_name AS fullName,
        display_name AS displayName,
        phone_number AS phoneNumber,
        role,
        status,
        email_verified_at AS emailVerifiedAt
      FROM dbo.users
      WHERE id = @userId
        AND status = 1
        AND role = 'CUSTOMER';
    `);
  const row = res.recordset[0];
  if (!row) return null;
  return {
    type: "CUSTOMER",
    userId: String(row.id),
    actorKey: actorKeyForUser(row.id),
    role: "CUSTOMER",
    email: row.email,
    displayName: row.displayName || row.fullName || row.email,
    fullName: row.fullName || row.displayName || row.email,
    phoneNumber: row.phoneNumber || null,
  };
}

async function loadAdminOrManagerById(userId) {
  if (!userId) return null;
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("userId", sqlObj.UniqueIdentifier, userId)
    .query(`
      SELECT TOP 1
        u.id,
        u.email,
        u.personal_email AS personalEmail,
        u.full_name AS fullName,
        u.display_name AS displayName,
        u.role,
        u.status,
        u.must_change_password AS mustChangePassword,
        e.id AS assignmentEpochId,
        e.accommodation_id AS accommodationId,
        a.accommodation_name AS accommodationName
      FROM dbo.users AS u
      LEFT JOIN dbo.chat_manager_assignment_epochs AS e
        ON e.user_id = u.id AND e.revoked_at_utc IS NULL
      LEFT JOIN dbo.accommodations AS a
        ON a.id = e.accommodation_id AND a.deleted_at IS NULL
      WHERE u.id = @userId
        AND u.status = 1
        AND u.role IN ('ADMIN', 'ACCOMMODATION_MANAGER');

      SELECT permission_key
      FROM dbo.role_permissions
      WHERE role = (SELECT TOP 1 role FROM dbo.users WHERE id = @userId)
        AND is_granted = 1;
    `);
  const row = res.recordsets[0][0];
  if (!row) return null;
  if (row.mustChangePassword) {
    throw chatError(
      403,
      "MUST_CHANGE_PASSWORD",
      "Bạn cần đổi mật khẩu tạm trước khi sử dụng hệ thống Chat.",
    );
  }
  const permissions = new Set(res.recordsets[1].map((p) => p.permission_key));
  const actor = {
    type: row.role,
    userId: String(row.id),
    actorKey: actorKeyForUser(row.id),
    role: row.role,
    email: row.email,
    personalEmail: row.personalEmail || null,
    displayName: row.displayName || row.fullName || row.email,
    fullName: row.fullName || row.displayName || row.email,
    accommodationId: row.accommodationId ? Number(row.accommodationId) : null,
    accommodationName: row.accommodationName || null,
    assignmentEpochId: row.assignmentEpochId ? Number(row.assignmentEpochId) : null,
    permissions: [...permissions],
  };
  cacheActor(userId, actor);
  return actor;
}

async function resolveWebActor(req, { allowGuest = true } = {}) {
  const customerSessionUserId = req.session?.customer?.id;
  if (customerSessionUserId) {
    const customer = await loadCustomerById(customerSessionUserId);
    if (customer) {
      return {
        actor: customer,
        sourceSessionKey: req.sessionID ? `web:${req.sessionID}` : null,
      };
    }
  }

  if (allowGuest) {
    const rawToken = getGuestRawToken(req);
    if (rawToken) {
      const guest = await resolveGuestByRawToken(rawToken);
      if (guest) {
        return {
          actor: guest,
          sourceSessionKey: `guest:${guest.guestSessionId}`,
        };
      }
    }
  }

  return { actor: null, sourceSessionKey: null };
}

async function resolveAdminActor(req) {
  const adminSessionUserId = req.session?.admin?.id;
  if (!adminSessionUserId) {
    throw chatError(401, "ADMIN_UNAUTHENTICATED", "Vui lòng đăng nhập tài khoản quản trị.");
  }
  const actor = await loadAdminOrManagerById(adminSessionUserId);
  if (!actor) {
    throw chatError(403, "ADMIN_FORBIDDEN", "Tài khoản quản trị không hợp lệ hoặc đã bị khóa.");
  }
  return {
    actor,
    sourceSessionKey: req.sessionID ? `admin:${req.sessionID}` : null,
  };
}

function hasPermission(actor, permissionKey) {
  if (!actor || !Array.isArray(actor.permissions)) return false;
  return actor.permissions.includes(permissionKey);
}

async function issueSocketTicket(actor, audience, sourceSessionKey) {
  const rawToken = randomToken(32);
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + config.socketTicketSeconds * 1000);
  const pool = getDBPool();

  await pool
    .request()
    .input("tokenHash", sqlObj.Char(64), tokenHash)
    .input("audience", sqlObj.VarChar(20), audience)
    .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
    .input("userId", sqlObj.UniqueIdentifier, actor.userId || null)
    .input("guestSessionId", sqlObj.UniqueIdentifier, actor.guestSessionId || null)
    .input("sourceSessionKey", sqlObj.VarChar(128), sourceSessionKey || null)
    .input("expiresAt", sqlObj.DateTime2(3), expiresAt)
    .query(`
      INSERT INTO dbo.chat_socket_tickets (
        token_hash, audience, actor_key, user_id, guest_session_id, source_session_key, expires_at
      )
      VALUES (
        @tokenHash, @audience, @actorKey, @userId, @guestSessionId, @sourceSessionKey, @expiresAt
      );
    `);

  return {
    ticket: rawToken,
    expiresAt: expiresAt.toISOString(),
  };
}

function decodeSignedSessionCookie(rawCookieVal) {
  if (!rawCookieVal) return null;
  let val = String(rawCookieVal).trim();
  if (val.startsWith("s:")) val = val.slice(2);
  const dotIdx = val.lastIndexOf(".");
  return dotIdx > 0 ? val.slice(0, dotIdx) : val;
}

async function consumeSocketTicket(rawToken, handshakeReq) {
  if (!rawToken || typeof rawToken !== "string") {
    throw chatError(401, "INVALID_TICKET", "Thiếu vé xác thực Socket.");
  }
  const tokenHash = sha256(rawToken.trim());
  const pool = getDBPool();

  // Atomically claim the one-time ticket
  const claimRes = await pool
    .request()
    .input("tokenHash", sqlObj.Char(64), tokenHash)
    .query(`
      UPDATE dbo.chat_socket_tickets
      SET consumed_at = SYSUTCDATETIME()
      OUTPUT
        INSERTED.id,
        INSERTED.audience,
        INSERTED.actor_key AS actorKey,
        INSERTED.user_id AS userId,
        INSERTED.guest_session_id AS guestSessionId,
        INSERTED.source_session_key AS sourceSessionKey
      WHERE token_hash = @tokenHash
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > SYSUTCDATETIME();
    `);

  const ticketRow = claimRes.recordset[0];
  if (!ticketRow) {
    throw chatError(401, "INVALID_TICKET", "Vé kết nối realtime đã hết hạn hoặc không hợp lệ.");
  }

  // Re-verify live HTTP session or guest cookie on handshake
  const cookies = parseCookies(handshakeReq);

  if (ticketRow.audience === "admin") {
    const sid = decodeSignedSessionCookie(cookies["vietpeace.admin.sid"]);
    if (sid) {
      const sess = await readSessionById(sid, "admin");
      if (!sess || String(sess.admin?.id || "").toLowerCase() !== String(ticketRow.userId || "").toLowerCase()) {
        throw chatError(401, "SESSION_MISMATCH", "Phiên quản trị không còn hiệu lực.");
      }
    }
    const actor = await loadAdminOrManagerById(ticketRow.userId);
    if (!actor) throw chatError(403, "ADMIN_FORBIDDEN", "Tài khoản quản trị không hợp lệ.");
    return { audience: "admin", actor, sourceSessionKey: ticketRow.sourceSessionKey };
  }

  // audience === 'web'
  if (ticketRow.userId) {
    const sid = decodeSignedSessionCookie(cookies["vietpeace.customer.sid"]);
    if (sid) {
      const sess = await readSessionById(sid, "web");
      if (!sess || String(sess.customer?.id || "").toLowerCase() !== String(ticketRow.userId).toLowerCase()) {
        throw chatError(401, "SESSION_MISMATCH", "Phiên khách hàng không còn hiệu lực.");
      }
    }
    const actor = await loadCustomerById(ticketRow.userId);
    if (!actor) throw chatError(401, "CUSTOMER_INVALID", "Tài khoản khách hàng không hợp lệ.");
    return { audience: "web", actor, sourceSessionKey: ticketRow.sourceSessionKey };
  }

  if (ticketRow.guestSessionId) {
    const rawGuest = cookies[config.guestCookieName];
    if (rawGuest) {
      const valid = await resolveGuestByRawToken(rawGuest);
      if (!valid || String(valid.guestSessionId).toLowerCase() !== String(ticketRow.guestSessionId).toLowerCase()) {
        throw chatError(401, "GUEST_INVALID", "Phiên khách vãng lai đã hết hạn.");
      }
      return { audience: "web", actor: valid, sourceSessionKey: ticketRow.sourceSessionKey };
    }
    // Check DB directly if client connected via websocket without forwarding cookie header
    const gRes = await pool
      .request()
      .input("guestId", sqlObj.UniqueIdentifier, ticketRow.guestSessionId)
      .query(`
        SELECT id FROM dbo.chat_guest_sessions
        WHERE id = @guestId
          AND revoked_at IS NULL
          AND claimed_by_user_id IS NULL
          AND expires_at > SYSUTCDATETIME();
      `);
    if (!gRes.recordset[0]) {
      throw chatError(401, "GUEST_INVALID", "Phiên khách vãng lai đã hết hạn.");
    }
    return {
      audience: "web",
      actor: {
        type: "GUEST",
        guestSessionId: ticketRow.guestSessionId,
        actorKey: ticketRow.actorKey,
        role: "GUEST",
        displayName: "Khách vãng lai",
      },
      sourceSessionKey: ticketRow.sourceSessionKey,
    };
  }

  throw chatError(401, "INVALID_TICKET", "Vé xác thực không hợp lệ.");
}

async function revalidateSocketActor(socketData) {
  const actor = socketData?.actor;
  if (!actor) return null;

  if (actor.type === "GUEST") {
    const pool = getDBPool();
    const res = await pool
      .request()
      .input("id", sqlObj.UniqueIdentifier, actor.guestSessionId)
      .query(`
        SELECT TOP 1 id FROM dbo.chat_guest_sessions
        WHERE id = @id AND revoked_at IS NULL AND claimed_by_user_id IS NULL AND expires_at > SYSUTCDATETIME();
      `);
    return res.recordset[0] ? actor : null;
  }

  if (actor.type === "CUSTOMER") {
    return loadCustomerById(actor.userId);
  }

  const cached = getCachedActor(actor.userId);
  if (cached) return cached;
  try {
    return await loadAdminOrManagerById(actor.userId);
  } catch {
    return null;
  }
}

async function revokeUserAccess(txOrPool, userId, reason = "ACCESS_REVOKED", { audience = null } = {}) {
  if (!userId) return;
  invalidateActorAuthCache(userId);
  const req = newRequest(txOrPool)
    .input("userId", sqlObj.UniqueIdentifier, userId)
    .input("audience", sqlObj.VarChar(20), audience);

  await req.query(`
    UPDATE dbo.chat_socket_tickets
    SET revoked_at = SYSUTCDATETIME()
    WHERE user_id = @userId
      AND (@audience IS NULL OR audience = @audience)
      AND revoked_at IS NULL;
  `);

  if (["USER_LOCKED", "USER_DEACTIVATED"].includes(reason)) {
    await newRequest(txOrPool)
      .input("userId", sqlObj.UniqueIdentifier, userId)
      .input("reason", sqlObj.NVarChar(200), reason)
      .query(`
        UPDATE dbo.chat_internal_threads
        SET is_archived = 1,
            archived_reason = @reason,
            updated_at = SYSUTCDATETIME()
        WHERE (admin_user_id = @userId OR manager_user_id = @userId)
          AND is_archived = 0;
      `);
  }

  await deleteSessionByUserId(userId, audience);

  await enqueueOutbox(txOrPool, {
    kind: "ACCESS_REVOKED",
    conversationId: null,
    eventName: "access:revoked",
    payload: {
      actorKey: actorKeyForUser(userId),
      userId: String(userId),
      audience,
      reason,
    },
  });
}

module.exports = {
  invalidateActorAuthCache,
  loadCustomerById,
  loadAdminOrManagerById,
  resolveWebActor,
  resolveAdminActor,
  hasPermission,
  issueSocketTicket,
  consumeSocketTicket,
  revalidateSocketActor,
  revokeUserAccess,
};

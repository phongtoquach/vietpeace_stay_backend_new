const crypto = require("crypto");
const { getDBPool, sqlObj } = require("../../configs/database");

function chatError(statusCode, errorCode, message, extra = {}) {
  return Object.assign(new Error(message), {
    statusCode,
    errorCode,
    ...extra,
  });
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function actorKeyForUser(userId) {
  return `user:${String(userId).toLowerCase()}`;
}

function actorKeyForGuest(guestId) {
  return `guest:${String(guestId).toLowerCase()}`;
}

function previewText(content, maxLen = 280) {
  const clean = String(content || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

function parseJsonSafe(raw, fallback = null) {
  if (!raw || typeof raw !== "string") return raw ?? fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function withTransaction(work) {
  const pool = getDBPool();
  const tx = new sqlObj.Transaction(pool);
  await tx.begin();
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // preserve original error
    }
    throw err;
  }
}

function newRequest(executor) {
  if (!executor) return getDBPool().request();
  if (executor instanceof sqlObj.Transaction) return new sqlObj.Request(executor);
  return executor.request();
}

async function lockUsersInOrder(tx, userIds = []) {
  const unique = [...new Set(userIds.filter(Boolean).map((id) => String(id).toLowerCase()))].sort();
  for (const id of unique) {
    await newRequest(tx)
      .input("id", sqlObj.UniqueIdentifier, id)
      .query(`SELECT id FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE id = @id;`);
  }
}

async function lockGuestSessionsInOrder(tx, guestIds = []) {
  const unique = [...new Set(guestIds.filter(Boolean).map((id) => String(id).toLowerCase()))].sort();
  for (const id of unique) {
    await newRequest(tx)
      .input("id", sqlObj.UniqueIdentifier, id)
      .query(`SELECT id FROM dbo.chat_guest_sessions WITH (UPDLOCK, HOLDLOCK) WHERE id = @id;`);
  }
}

async function lockAccommodationsInOrder(tx, accomIds = []) {
  const unique = [
    ...new Set(accomIds.map((x) => Number(x)).filter((x) => Number.isSafeInteger(x) && x > 0)),
  ].sort((a, b) => a - b);
  for (const id of unique) {
    await newRequest(tx)
      .input("id", sqlObj.Int, id)
      .query(`SELECT id FROM dbo.accommodations WITH (UPDLOCK, HOLDLOCK) WHERE id = @id;`);
  }
}

async function lockConversationsInOrder(tx, conversationIds = []) {
  const unique = [
    ...new Set(conversationIds.map((x) => Number(x)).filter((x) => Number.isSafeInteger(x) && x > 0)),
  ].sort((a, b) => a - b);
  for (const id of unique) {
    await newRequest(tx)
      .input("id", sqlObj.BigInt, id)
      .query(`SELECT id FROM dbo.chat_conversations WITH (UPDLOCK, HOLDLOCK) WHERE id = @id;`);
  }
}

async function enqueueOutbox(
  tx,
  { kind, conversationId = null, eventName, payload = {}, availableAt = null },
) {
  const req = newRequest(tx)
    .input("kind", sqlObj.VarChar(32), kind)
    .input("conversationId", sqlObj.BigInt, conversationId === null ? null : Number(conversationId))
    .input("eventName", sqlObj.VarChar(100), eventName)
    .input("payloadJson", sqlObj.NVarChar(sqlObj.MAX), JSON.stringify(payload || {}))
    .input("availableAt", sqlObj.DateTime2(3), availableAt ? new Date(availableAt) : null);

  await req.query(`
    INSERT INTO dbo.chat_outbox (kind, conversation_id, event_name, payload_json, available_at)
    VALUES (@kind, @conversationId, @eventName, @payloadJson, COALESCE(@availableAt, SYSUTCDATETIME()));
  `);
}

async function recordChatEvent(
  tx,
  { conversationId = null, actorKey = null, eventType, clientRequestId = null, requestFingerprint = null, payload = null },
) {
  await newRequest(tx)
    .input("conversationId", sqlObj.BigInt, conversationId === null ? null : Number(conversationId))
    .input("actorKey", sqlObj.VarChar(100), actorKey || null)
    .input("eventType", sqlObj.VarChar(64), eventType)
    .input("clientRequestId", sqlObj.VarChar(100), clientRequestId || null)
    .input("requestFingerprint", sqlObj.VarChar(128), requestFingerprint || null)
    .input("payloadJson", sqlObj.NVarChar(sqlObj.MAX), payload ? JSON.stringify(payload) : null)
    .query(`
      INSERT INTO dbo.chat_events (
        conversation_id, actor_key, event_type, client_request_id, request_fingerprint, payload_json
      )
      VALUES (
        @conversationId, @actorKey, @eventType, @clientRequestId, @requestFingerprint, @payloadJson
      );
    `);
}

module.exports = {
  chatError,
  sha256,
  randomToken,
  actorKeyForUser,
  actorKeyForGuest,
  previewText,
  parseJsonSafe,
  withTransaction,
  newRequest,
  lockUsersInOrder,
  lockGuestSessionsInOrder,
  lockAccommodationsInOrder,
  lockConversationsInOrder,
  enqueueOutbox,
  recordChatEvent,
};

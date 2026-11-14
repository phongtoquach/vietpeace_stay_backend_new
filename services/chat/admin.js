const config = require("../../configs/chat");
const { getDBPool, sqlObj } = require("../../configs/database");
const {
  chatError,
  actorKeyForUser,
  actorKeyForGuest,
  withTransaction,
  newRequest,
  lockConversationsInOrder,
  enqueueOutbox,
  recordChatEvent,
  parseJsonSafe,
  previewText,
} = require("./db");
const { hasPermission } = require("./identity");
const { appendSystemMessage } = require("./lifecycle");
const provider = require("./provider");

function assertManagerAccess(actor) {
  if (!actor || actor.role !== "ACCOMMODATION_MANAGER") {
    throw chatError(403, "MANAGER_ONLY", "Thao tác này chỉ dành cho Quản lý cơ sở lưu trú.");
  }
  if (!actor.accommodationId || !actor.assignmentEpochId) {
    throw chatError(403, "NO_ACTIVE_ASSIGNMENT", "Tài khoản Quản lý chưa được phân công phụ trách cơ sở nào.");
  }
}

function assertStaffChatRead(actor) {
  if (!actor || !["ADMIN", "ACCOMMODATION_MANAGER"].includes(actor.role) || !hasPermission(actor, "chat.read")) {
    throw chatError(403, "FORBIDDEN", "Bạn không có quyền truy cập mục Chat.");
  }
}

async function listStaffConversations(actor, { accommodationId = null, status = "ALL", handlingMode = "ALL" } = {}) {
  assertStaffChatRead(actor);
  const pool = getDBPool();

  const statusFilter = ["OPEN", "RESOLVED"].includes(String(status).toUpperCase()) ? String(status).toUpperCase() : null;
  const modeFilter = ["AI", "WAITING_HUMAN", "HUMAN"].includes(String(handlingMode).toUpperCase())
    ? String(handlingMode).toUpperCase()
    : null;

  if (actor.role === "ACCOMMODATION_MANAGER") {
    if (!actor.accommodationId || !actor.assignmentEpochId) return [];

    const res = await pool
      .request()
      .input("accomId", sqlObj.Int, actor.accommodationId)
      .input("mgrId", sqlObj.UniqueIdentifier, actor.userId)
      .input("epochId", sqlObj.BigInt, actor.assignmentEpochId)
      .input("mgrActorKey", sqlObj.VarChar(100), actor.actorKey)
      .input("statusFilter", sqlObj.VarChar(16), statusFilter)
      .input("modeFilter", sqlObj.VarChar(20), modeFilter)
      .query(`
        SELECT
          c.id,
          c.scope_type AS scopeType,
          c.accommodation_id AS accommodationId,
          a.accommodation_name AS accommodationName,
          c.customer_user_id AS customerUserId,
          c.guest_session_id AS guestSessionId,
          COALESCE(cu.display_name, cu.full_name, N'Khách vãng lai') AS customerName,
          cu.email AS customerEmail,
          c.status,
          c.handling_mode AS handlingMode,
          c.retention_state AS retentionState,
          c.assigned_user_id AS assignedUserId,
          c.current_handoff_id AS currentHandoffId,
          h.status AS handoffStatus,
          h.requested_at AS handoffRequestedAt,
          h.expires_at AS handoffExpiresAt,
          h.claimed_at AS handoffClaimedAt,
          COALESCE(p.visible_from_sequence, h.visible_from_sequence, 0) AS visibleFromSequence,
          c.control_revision AS controlRevision,
          c.last_sequence AS lastSequence,
          c.last_message_at AS lastMessageAt,
          c.last_message_preview AS lastMessagePreview,
          c.manager_wait_expires_at AS managerWaitExpiresAt,
          p.last_delivered_sequence AS selfDeliveredSequence,
          p.last_read_sequence AS selfReadSequence,
          op.last_delivered_sequence AS ownerDeliveredSequence,
          op.last_delivered_at AS ownerDeliveredAt,
          op.last_read_sequence AS ownerReadSequence,
          op.last_read_at AS ownerReadAt,
          (
            SELECT COUNT(*)
            FROM dbo.chat_messages m
            WHERE m.conversation_id = c.id
              AND m.sequence >= COALESCE(p.visible_from_sequence, h.visible_from_sequence, 0)
              AND m.sequence > COALESCE(p.last_read_sequence, 0)
              AND m.visibility IN ('PUBLIC', 'STAFF')
              AND m.sender_actor_key <> @mgrActorKey
          ) AS unreadCount,
          c.created_at AS createdAt,
          c.updated_at AS updatedAt
        FROM dbo.chat_conversations AS c
        INNER JOIN dbo.accommodations AS a ON a.id = c.accommodation_id
        LEFT JOIN dbo.users AS cu ON cu.id = c.customer_user_id
        LEFT JOIN dbo.chat_handoff_sessions AS h ON h.id = c.current_handoff_id
        LEFT JOIN dbo.chat_participants AS p ON p.conversation_id = c.id AND p.actor_key = @mgrActorKey
        OUTER APPLY (
          SELECT TOP 1 last_delivered_sequence, last_delivered_at, last_read_sequence, last_read_at
          FROM dbo.chat_participants
          WHERE conversation_id = c.id AND participant_role IN ('CUSTOMER', 'GUEST')
          ORDER BY id DESC
        ) AS op
        WHERE c.scope_type = 'PROPERTY'
          AND c.accommodation_id = @accomId
          AND c.manager_assignment_epoch_id = @epochId
          AND (
            (c.handling_mode = 'WAITING_HUMAN' AND h.target_manager_user_id = @mgrId)
            OR (c.assigned_user_id = @mgrId)
          )
          AND (@statusFilter IS NULL OR c.status = @statusFilter)
          AND (@modeFilter IS NULL OR c.handling_mode = @modeFilter)
        ORDER BY
          CASE WHEN c.handling_mode = 'WAITING_HUMAN' THEN 0 WHEN c.status = 'OPEN' THEN 1 ELSE 2 END,
          COALESCE(c.last_message_at, c.created_at) DESC;
      `);

    return res.recordset.map((r) => formatStaffConvRow(r));
  }

  // ADMIN (chat.supervise) reads PERSISTENT conversations only
  if (!hasPermission(actor, "chat.supervise")) {
    throw chatError(403, "FORBIDDEN", "Admin thiếu quyền giám sát hội thoại.");
  }

  const accomFilter = Number.isSafeInteger(Number(accommodationId)) && Number(accommodationId) > 0
    ? Number(accommodationId)
    : null;

  const res = await pool
    .request()
    .input("accomId", sqlObj.Int, accomFilter)
    .input("statusFilter", sqlObj.VarChar(16), statusFilter)
    .input("modeFilter", sqlObj.VarChar(20), modeFilter)
    .query(`
      SELECT TOP 100
        c.id,
        c.scope_type AS scopeType,
        c.accommodation_id AS accommodationId,
        a.accommodation_name AS accommodationName,
        c.customer_user_id AS customerUserId,
        c.guest_session_id AS guestSessionId,
        COALESCE(cu.display_name, cu.full_name, N'Khách hàng') AS customerName,
        cu.email AS customerEmail,
        c.status,
        c.handling_mode AS handlingMode,
        c.retention_state AS retentionState,
        c.assigned_user_id AS assignedUserId,
        mu.full_name AS assignedManagerName,
        c.current_handoff_id AS currentHandoffId,
        h.status AS handoffStatus,
        h.requested_at AS handoffRequestedAt,
        h.expires_at AS handoffExpiresAt,
        h.claimed_at AS handoffClaimedAt,
        CAST(0 AS BIGINT) AS visibleFromSequence,
        c.control_revision AS controlRevision,
        c.last_sequence AS lastSequence,
        c.last_message_at AS lastMessageAt,
        c.last_message_preview AS lastMessagePreview,
        c.manager_wait_expires_at AS managerWaitExpiresAt,
        CAST(0 AS BIGINT) AS selfDeliveredSequence,
        CAST(0 AS BIGINT) AS selfReadSequence,
        op.last_delivered_sequence AS ownerDeliveredSequence,
        op.last_delivered_at AS ownerDeliveredAt,
        op.last_read_sequence AS ownerReadSequence,
        op.last_read_at AS ownerReadAt,
        CAST(0 AS INT) AS unreadCount,
        c.created_at AS createdAt,
        c.updated_at AS updatedAt
      FROM dbo.chat_conversations AS c
      LEFT JOIN dbo.accommodations AS a ON a.id = c.accommodation_id
      LEFT JOIN dbo.users AS cu ON cu.id = c.customer_user_id
      LEFT JOIN dbo.users AS mu ON mu.id = c.assigned_user_id
      LEFT JOIN dbo.chat_handoff_sessions AS h ON h.id = c.current_handoff_id
      OUTER APPLY (
        SELECT TOP 1 last_delivered_sequence, last_delivered_at, last_read_sequence, last_read_at
        FROM dbo.chat_participants
        WHERE conversation_id = c.id AND participant_role IN ('CUSTOMER', 'GUEST')
        ORDER BY id DESC
      ) AS op
      WHERE c.retention_state = 'PERSISTENT'
        AND (@accomId IS NULL OR c.accommodation_id = @accomId)
        AND (@statusFilter IS NULL OR c.status = @statusFilter)
        AND (@modeFilter IS NULL OR c.handling_mode = @modeFilter)
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC;
    `);

  return res.recordset.map((r) => formatStaffConvRow(r));
}

function formatStaffConvRow(r) {
  return {
    id: Number(r.id),
    scopeType: r.scopeType,
    accommodationId: r.accommodationId ? Number(r.accommodationId) : null,
    accommodationName: r.accommodationName || "Nền tảng VietPeace Stay",
    customerUserId: r.customerUserId ? String(r.customerUserId) : null,
    guestSessionId: r.guestSessionId ? String(r.guestSessionId) : null,
    customerName: r.customerName,
    customerEmail: r.customerEmail || null,
    status: r.status,
    handlingMode: r.handlingMode,
    retentionState: r.retentionState,
    assignedUserId: r.assignedUserId ? String(r.assignedUserId) : null,
    assignedManagerName: r.assignedManagerName || null,
    currentHandoffId: r.currentHandoffId ? Number(r.currentHandoffId) : null,
    handoffStatus: r.handoffStatus || null,
    handoffRequestedAt: r.handoffRequestedAt ? new Date(r.handoffRequestedAt).toISOString() : null,
    handoffExpiresAt: r.handoffExpiresAt ? new Date(r.handoffExpiresAt).toISOString() : null,
    handoffClaimedAt: r.handoffClaimedAt ? new Date(r.handoffClaimedAt).toISOString() : null,
    visibleFromSequence: Number(r.visibleFromSequence || 0),
    controlRevision: Number(r.controlRevision),
    lastSequence: Number(r.lastSequence),
    lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt).toISOString() : null,
    lastMessagePreview: r.lastMessagePreview || "",
    managerWaitExpiresAt: r.managerWaitExpiresAt ? new Date(r.managerWaitExpiresAt).toISOString() : null,
    unreadCount: Number(r.unreadCount || 0),
    counterpartyDelivery: {
      deliveredSequence: Number(r.ownerDeliveredSequence || 0),
      deliveredAt: r.ownerDeliveredAt ? new Date(r.ownerDeliveredAt).toISOString() : null,
      readSequence: Number(r.ownerReadSequence || 0),
      readAt: r.ownerReadAt ? new Date(r.ownerReadAt).toISOString() : null,
    },
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

async function listSuperviseAccommodations(actor) {
  assertStaffChatRead(actor);
  const pool = getDBPool();
  if (actor.role === "ACCOMMODATION_MANAGER") {
    if (!actor.accommodationId) return [];
    const res = await pool
      .request()
      .input("accomId", sqlObj.Int, actor.accommodationId)
      .query(`
        SELECT id, accommodation_name AS accommodationName
        FROM dbo.accommodations WHERE id = @accomId AND deleted_at IS NULL;
      `);
    return res.recordset.map((r) => ({ id: Number(r.id), accommodationName: r.accommodationName }));
  }

  const res = await pool.request().query(`
    SELECT a.id, a.accommodation_name AS accommodationName,
      (SELECT COUNT(*) FROM dbo.chat_conversations c WHERE c.accommodation_id = a.id AND c.retention_state = 'PERSISTENT') AS conversationCount
    FROM dbo.accommodations a
    WHERE a.status = 1 AND a.deleted_at IS NULL
    ORDER BY conversationCount DESC, a.accommodation_name ASC;
  `);
  return res.recordset.map((r) => ({
    id: Number(r.id),
    accommodationName: r.accommodationName,
    conversationCount: Number(r.conversationCount || 0),
  }));
}

async function assertStaffConversationAccess(actor, conversationId, txOrPool = getDBPool()) {
  assertStaffChatRead(actor);
  const cid = Number(conversationId);
  if (!Number.isSafeInteger(cid) || cid < 1) {
    throw chatError(400, "INVALID_CONVERSATION_ID", "Mã hội thoại không hợp lệ.");
  }

  const req = newRequest(txOrPool).input("cid", sqlObj.BigInt, cid);

  if (actor.role === "ACCOMMODATION_MANAGER") {
    assertManagerAccess(actor);
    const res = await req
      .input("accomId", sqlObj.Int, actor.accommodationId)
      .input("mgrId", sqlObj.UniqueIdentifier, actor.userId)
      .input("epochId", sqlObj.BigInt, actor.assignmentEpochId)
      .input("mgrKey", sqlObj.VarChar(100), actor.actorKey)
      .query(`
        SELECT
          c.id,
          c.customer_user_id AS customerUserId,
          c.guest_session_id AS guestSessionId,
          c.scope_type AS scopeType,
          c.accommodation_id AS accommodationId,
          a.accommodation_name AS accommodationName,
          COALESCE(cu.display_name, cu.full_name, N'Khách vãng lai') AS customerName,
          cu.email AS customerEmail,
          c.status,
          c.handling_mode AS handlingMode,
          c.retention_state AS retentionState,
          c.assigned_user_id AS assignedUserId,
          c.current_handoff_id AS currentHandoffId,
          c.manager_assignment_epoch_id AS managerAssignmentEpochId,
          c.control_revision AS controlRevision,
          c.last_sequence AS lastSequence,
          c.last_message_at AS lastMessageAt,
          c.last_message_preview AS lastMessagePreview,
          c.manager_wait_expires_at AS managerWaitExpiresAt,
          h.status AS handoffStatus,
          h.requested_at AS handoffRequestedAt,
          h.expires_at AS handoffExpiresAt,
          h.claimed_at AS handoffClaimedAt,
          h.target_manager_user_id AS targetManagerUserId,
          COALESCE(p.visible_from_sequence, h.visible_from_sequence, 0) AS visibleFromSequence,
          op.last_delivered_sequence AS ownerDeliveredSequence,
          op.last_delivered_at AS ownerDeliveredAt,
          op.last_read_sequence AS ownerReadSequence,
          op.last_read_at AS ownerReadAt,
          c.created_at AS createdAt,
          c.updated_at AS updatedAt
        FROM dbo.chat_conversations AS c
        INNER JOIN dbo.accommodations AS a ON a.id = c.accommodation_id
        LEFT JOIN dbo.users AS cu ON cu.id = c.customer_user_id
        LEFT JOIN dbo.chat_handoff_sessions AS h ON h.id = c.current_handoff_id
        LEFT JOIN dbo.chat_participants AS p ON p.conversation_id = c.id AND p.actor_key = @mgrKey
        OUTER APPLY (
          SELECT TOP 1 last_delivered_sequence, last_delivered_at, last_read_sequence, last_read_at
          FROM dbo.chat_participants
          WHERE conversation_id = c.id AND participant_role IN ('CUSTOMER', 'GUEST')
          ORDER BY id DESC
        ) AS op
        WHERE c.id = @cid
          AND c.scope_type = 'PROPERTY'
          AND c.accommodation_id = @accomId
          AND c.manager_assignment_epoch_id = @epochId
          AND (
            (c.handling_mode = 'WAITING_HUMAN' AND h.target_manager_user_id = @mgrId)
            OR c.assigned_user_id = @mgrId
          );
      `);
    const row = res.recordset[0];
    if (!row) {
      throw chatError(404, "CONVERSATION_NOT_FOUND", "Bạn không có quyền truy cập hoặc hội thoại không thuộc cơ sở/ca phụ trách.");
    }
    return row;
  }

  // ADMIN read-only supervise
  if (!hasPermission(actor, "chat.supervise")) {
    throw chatError(403, "FORBIDDEN", "Admin thiếu quyền giám sát hội thoại.");
  }
  const res = await req.query(`
    SELECT
      c.id,
      c.customer_user_id AS customerUserId,
      c.guest_session_id AS guestSessionId,
      c.scope_type AS scopeType,
      c.accommodation_id AS accommodationId,
      a.accommodation_name AS accommodationName,
      COALESCE(cu.display_name, cu.full_name, N'Khách hàng') AS customerName,
      cu.email AS customerEmail,
      c.status,
      c.handling_mode AS handlingMode,
      c.retention_state AS retentionState,
      c.assigned_user_id AS assignedUserId,
      mu.full_name AS assignedManagerName,
      c.current_handoff_id AS currentHandoffId,
      c.manager_assignment_epoch_id AS managerAssignmentEpochId,
      c.control_revision AS controlRevision,
      c.last_sequence AS lastSequence,
      c.last_message_at AS lastMessageAt,
      c.last_message_preview AS lastMessagePreview,
      c.manager_wait_expires_at AS managerWaitExpiresAt,
      h.status AS handoffStatus,
      h.requested_at AS handoffRequestedAt,
      h.expires_at AS handoffExpiresAt,
      h.claimed_at AS handoffClaimedAt,
      CAST(0 AS BIGINT) AS visibleFromSequence,
      op.last_delivered_sequence AS ownerDeliveredSequence,
      op.last_delivered_at AS ownerDeliveredAt,
      op.last_read_sequence AS ownerReadSequence,
      op.last_read_at AS ownerReadAt,
      c.created_at AS createdAt,
      c.updated_at AS updatedAt
    FROM dbo.chat_conversations AS c
    LEFT JOIN dbo.accommodations AS a ON a.id = c.accommodation_id
    LEFT JOIN dbo.users AS cu ON cu.id = c.customer_user_id
    LEFT JOIN dbo.users AS mu ON mu.id = c.assigned_user_id
    LEFT JOIN dbo.chat_handoff_sessions AS h ON h.id = c.current_handoff_id
    OUTER APPLY (
      SELECT TOP 1 last_delivered_sequence, last_delivered_at, last_read_sequence, last_read_at
      FROM dbo.chat_participants
      WHERE conversation_id = c.id AND participant_role IN ('CUSTOMER', 'GUEST')
      ORDER BY id DESC
    ) AS op
    WHERE c.id = @cid AND c.retention_state = 'PERSISTENT';
  `);
  const row = res.recordset[0];
  if (!row) {
    throw chatError(404, "CONVERSATION_NOT_FOUND", "Không tìm thấy hội thoại lưu trữ.");
  }
  return row;
}

async function getStaffConversationMessages(actor, conversationId, { limit = 60, beforeSequence = null } = {}) {
  const conv = await assertStaffConversationAccess(actor, conversationId);
  const pool = getDBPool();
  const minSeq = actor.role === "ACCOMMODATION_MANAGER" ? Number(conv.visibleFromSequence || 0) : 0;

  const res = await pool
    .request()
    .input("cid", sqlObj.BigInt, Number(conversationId))
    .input("minSeq", sqlObj.BigInt, minSeq)
    .input("beforeSeq", sqlObj.BigInt, beforeSequence ? Number(beforeSequence) : null)
    .input("limit", sqlObj.Int, Math.min(Math.max(Number(limit) || 60, 1), config.historyMaxLimit))
    .query(`
      SELECT TOP (@limit)
        id,
        conversation_id AS conversationId,
        sequence,
        sender_actor_key AS senderActorKey,
        sender_type AS senderType,
        message_type AS messageType,
        visibility,
        content,
        payload_json AS payloadJson,
        client_message_id AS clientMessageId,
        handoff_id AS handoffId,
        created_at AS createdAt
      FROM dbo.chat_messages
      WHERE conversation_id = @cid
        AND sequence >= @minSeq
        AND visibility IN ('PUBLIC', 'STAFF')
        AND (@beforeSeq IS NULL OR sequence < @beforeSeq)
      ORDER BY sequence DESC;
    `);

  return res.recordset.reverse().map((m) => ({
    ...m,
    id: Number(m.id),
    conversationId: Number(m.conversationId),
    sequence: Number(m.sequence),
    handoffId: m.handoffId ? Number(m.handoffId) : null,
    payload: parseJsonSafe(m.payloadJson, null),
    createdAt: new Date(m.createdAt).toISOString(),
  }));
}

async function claimConversation(actor, conversationId) {
  assertManagerAccess(actor);
  if (!hasPermission(actor, "chat.claim")) {
    throw chatError(403, "FORBIDDEN", "Bạn không có quyền tiếp nhận yêu cầu hỗ trợ.");
  }

  const cid = Number(conversationId);
  await withTransaction(async (tx) => {
    await lockConversationsInOrder(tx, [cid]);
    const conv = await assertStaffConversationAccess(actor, cid, tx);

    if (conv.status !== "OPEN" || conv.handlingMode !== "WAITING_HUMAN") {
      throw chatError(409, "NOT_CLAIMABLE", "Yêu cầu này không còn ở trạng thái chờ tiếp nhận.");
    }
    if (conv.managerWaitExpiresAt && new Date(conv.managerWaitExpiresAt).getTime() <= Date.now()) {
      throw chatError(409, "HANDOFF_EXPIRED", "Yêu cầu kết nối đã quá thời hạn 5 phút.");
    }

    const hid = Number(conv.currentHandoffId);
    const visSeq = Number(conv.visibleFromSequence || 0);

    await newRequest(tx)
      .input("hid", sqlObj.BigInt, hid)
      .input("mgrId", sqlObj.UniqueIdentifier, actor.userId)
      .query(`
        UPDATE dbo.chat_handoff_sessions
        SET status = 'CLAIMED', manager_user_id = @mgrId, claimed_at = SYSUTCDATETIME()
        WHERE id = @hid AND status = 'PENDING';
      `);

    // Promote Guest TEMPORARY to PERSISTENT upon Manager claim so human support is preserved cleanly
    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("mgrId", sqlObj.UniqueIdentifier, actor.userId)
      .query(`
        UPDATE dbo.chat_conversations
        SET handling_mode = 'HUMAN',
            assigned_user_id = @mgrId,
            retention_state = 'PERSISTENT',
            manager_wait_expires_at = NULL,
            guest_ai_close_at = NULL,
            temporary_cleanup_at = NULL,
            control_revision = control_revision + 1,
            updated_at = SYSUTCDATETIME()
        WHERE id = @cid;
      `);

    // Add or update Manager participant record
    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
      .input("mgrId", sqlObj.UniqueIdentifier, actor.userId)
      .input("epochId", sqlObj.BigInt, actor.assignmentEpochId)
      .input("visSeq", sqlObj.BigInt, visSeq)
      .input("lastSeq", sqlObj.BigInt, Number(conv.lastSequence))
      .query(`
        IF EXISTS (SELECT 1 FROM dbo.chat_participants WHERE conversation_id = @cid AND actor_key = @actorKey)
        BEGIN
          UPDATE dbo.chat_participants
          SET manager_assignment_epoch_id = @epochId,
              visible_from_sequence = @visSeq,
              left_at = NULL,
              last_delivered_sequence = CASE WHEN last_delivered_sequence < @lastSeq THEN @lastSeq ELSE last_delivered_sequence END,
              last_delivered_at = SYSUTCDATETIME()
          WHERE conversation_id = @cid AND actor_key = @actorKey;
        END
        ELSE
        BEGIN
          INSERT INTO dbo.chat_participants (
            conversation_id, actor_key, user_id, participant_role,
            manager_assignment_epoch_id, visible_from_sequence,
            last_delivered_sequence, last_delivered_at
          )
          VALUES (
            @cid, @actorKey, @mgrId, 'MANAGER',
            @epochId, @visSeq,
            @lastSeq, SYSUTCDATETIME()
          );
        END;
      `);

    const sysMsg = await appendSystemMessage(
      tx,
      cid,
      `Quản lý ${actor.displayName} (${actor.accommodationName || "cơ sở"}) đã tiếp nhận và tham gia trò chuyện với Quý khách.`,
      { handoffId: hid },
    );

    const ownerKey = conv.customerUserId
      ? actorKeyForUser(conv.customerUserId)
      : actorKeyForGuest(conv.guestSessionId);

    await recordChatEvent(tx, {
      conversationId: cid,
      actorKey: actor.actorKey,
      eventType: "HANDOFF_CLAIMED",
      payload: { handoffId: hid, managerUserId: actor.userId },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "message:created",
      payload: { conversationId: cid, ownerKey, assignedUserId: actor.userId, message: sysMsg, visibility: "PUBLIC" },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "conversation:updated",
      payload: {
        conversationId: cid,
        ownerKey,
        handlingMode: "HUMAN",
        retentionState: "PERSISTENT",
        assignedUserId: actor.userId,
        assignedManagerName: actor.displayName,
        managerWaitExpiresAt: null,
      },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "queue:updated",
      payload: { accommodationId: actor.accommodationId, managerUserId: actor.userId, conversationId: cid, action: "CLAIMED" },
    });
  });

  const updated = await assertStaffConversationAccess(actor, cid);
  return formatStaffConvRow(updated);
}

async function sendManagerReply(actor, conversationId, { content, clientMessageId = null, replyToMessageId = null }) {
  assertManagerAccess(actor);
  if (!hasPermission(actor, "chat.reply")) {
    throw chatError(403, "FORBIDDEN", "Bạn không có quyền nhắn tin trực tiếp với khách hàng.");
  }

  const cleanText = String(content || "").trim();
  if (!cleanText || cleanText.length > config.messageMaxLength) {
    throw chatError(400, "INVALID_MESSAGE", "Nội dung phản hồi không hợp lệ.");
  }
  const cleanClientId = clientMessageId ? String(clientMessageId).trim().slice(0, 100) : null;
  const cid = Number(conversationId);

  return withTransaction(async (tx) => {
    await lockConversationsInOrder(tx, [cid]);
    const conv = await assertStaffConversationAccess(actor, cid, tx);
    if (conv.status !== "OPEN" || conv.handlingMode !== "HUMAN" || String(conv.assignedUserId || "").toLowerCase() !== actor.userId.toLowerCase()) {
      throw chatError(409, "NOT_ASSIGNED_HUMAN", "Bạn cần ấn Tiếp nhận (Claim) hội thoại trước khi trả lời khách.");
    }

    if (cleanClientId) {
      const dupRes = await newRequest(tx)
        .input("cid", sqlObj.BigInt, cid)
        .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
        .input("clientMsgId", sqlObj.VarChar(100), cleanClientId)
        .query(`
          SELECT TOP 1 id, conversation_id AS conversationId, sequence, sender_actor_key AS senderActorKey,
            sender_type AS senderType, message_type AS messageType, visibility, content,
            payload_json AS payloadJson, client_message_id AS clientMessageId, created_at AS createdAt
          FROM dbo.chat_messages
          WHERE conversation_id = @cid AND sender_actor_key = @actorKey AND client_message_id = @clientMsgId;
        `);
      if (dupRes.recordset[0]) {
        const d = dupRes.recordset[0];
        return {
          duplicate: true,
          message: {
            ...d,
            id: Number(d.id),
            conversationId: Number(d.conversationId),
            sequence: Number(d.sequence),
            payload: parseJsonSafe(d.payloadJson, null),
            createdAt: new Date(d.createdAt).toISOString(),
          },
        };
      }
    }

    const seqRes = await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("preview", sqlObj.NVarChar(300), previewText(cleanText))
      .query(`
        UPDATE dbo.chat_conversations
        SET last_sequence = last_sequence + 1,
            last_message_at = SYSUTCDATETIME(),
            last_message_preview = @preview,
            updated_at = SYSUTCDATETIME()
        OUTPUT INSERTED.last_sequence AS seq
        WHERE id = @cid;
      `);
    const seq = Number(seqRes.recordset[0].seq);

    const ins = await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("seq", sqlObj.BigInt, seq)
      .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
      .input("uid", sqlObj.UniqueIdentifier, actor.userId)
      .input("clientMsgId", sqlObj.VarChar(100), cleanClientId)
      .input("content", sqlObj.NVarChar(sqlObj.MAX), cleanText)
      .input("replyToId", sqlObj.BigInt, replyToMessageId ? Number(replyToMessageId) : null)
      .input("hid", sqlObj.BigInt, conv.currentHandoffId ? Number(conv.currentHandoffId) : null)
      .query(`
        INSERT INTO dbo.chat_messages (
          conversation_id, sequence, sender_actor_key, sender_type, sender_user_id,
          client_message_id, message_type, visibility, content, reply_to_message_id, handoff_id
        )
        OUTPUT
          INSERTED.id, INSERTED.conversation_id AS conversationId, INSERTED.sequence,
          INSERTED.sender_actor_key AS senderActorKey, INSERTED.sender_type AS senderType,
          INSERTED.message_type AS messageType, INSERTED.visibility, INSERTED.content,
          INSERTED.client_message_id AS clientMessageId, INSERTED.handoff_id AS handoffId,
          INSERTED.created_at AS createdAt
        VALUES (
          @cid, @seq, @actorKey, 'MANAGER', @uid,
          @clientMsgId, 'TEXT', 'PUBLIC', @content, @replyToId, @hid
        );
      `);

    if (conv.currentHandoffId) {
      await newRequest(tx)
        .input("hid", sqlObj.BigInt, conv.currentHandoffId)
        .query(`
          UPDATE dbo.chat_handoff_sessions
          SET first_human_reply_at = COALESCE(first_human_reply_at, SYSUTCDATETIME())
          WHERE id = @hid;
        `);
    }

    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
      .input("seq", sqlObj.BigInt, seq)
      .query(`
        UPDATE dbo.chat_participants
        SET last_delivered_sequence = CASE WHEN last_delivered_sequence < @seq THEN @seq ELSE last_delivered_sequence END,
            last_delivered_at = CASE WHEN last_delivered_sequence < @seq THEN SYSUTCDATETIME() ELSE last_delivered_at END,
            last_read_sequence = CASE WHEN last_read_sequence < @seq THEN @seq ELSE last_read_sequence END,
            last_read_at = CASE WHEN last_read_sequence < @seq THEN SYSUTCDATETIME() ELSE last_read_at END
        WHERE conversation_id = @cid AND actor_key = @actorKey;
      `);

    const row = ins.recordset[0];
    const message = {
      ...row,
      id: Number(row.id),
      conversationId: Number(row.conversationId),
      sequence: Number(row.sequence),
      handoffId: row.handoffId ? Number(row.handoffId) : null,
      payload: null,
      createdAt: new Date(row.createdAt).toISOString(),
    };

    const ownerKey = conv.customerUserId
      ? actorKeyForUser(conv.customerUserId)
      : actorKeyForGuest(conv.guestSessionId);

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "message:created",
      payload: {
        conversationId: cid,
        ownerKey,
        assignedUserId: actor.userId,
        accommodationId: actor.accommodationId,
        message,
        visibility: "PUBLIC",
      },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "conversation:updated",
      payload: {
        conversationId: cid,
        ownerKey,
        handoffFirstHumanReplyAt: new Date().toISOString(),
      },
    });

    return { duplicate: false, message };
  });
}

async function addStaffNote(actor, conversationId, { content }) {
  assertStaffChatRead(actor);
  if (actor.role !== "ACCOMMODATION_MANAGER" && !hasPermission(actor, "chat.supervise")) {
    throw chatError(403, "FORBIDDEN", "Không có quyền tạo ghi chú nội bộ.");
  }
  const cleanText = String(content || "").trim();
  if (!cleanText) throw chatError(400, "INVALID_MESSAGE", "Ghi chú không được để trống.");

  const cid = Number(conversationId);
  return withTransaction(async (tx) => {
    await lockConversationsInOrder(tx, [cid]);
    const conv = await assertStaffConversationAccess(actor, cid, tx);

    const seqRes = await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .query(`
        UPDATE dbo.chat_conversations
        SET last_sequence = last_sequence + 1, updated_at = SYSUTCDATETIME()
        OUTPUT INSERTED.last_sequence AS seq
        WHERE id = @cid;
      `);
    const seq = Number(seqRes.recordset[0].seq);

    const ins = await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("seq", sqlObj.BigInt, seq)
      .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
      .input("senderType", sqlObj.VarChar(20), actor.role === "ADMIN" ? "ADMIN" : "MANAGER")
      .input("uid", sqlObj.UniqueIdentifier, actor.userId)
      .input("content", sqlObj.NVarChar(sqlObj.MAX), cleanText)
      .query(`
        INSERT INTO dbo.chat_messages (
          conversation_id, sequence, sender_actor_key, sender_type, sender_user_id,
          message_type, visibility, content
        )
        OUTPUT
          INSERTED.id, INSERTED.conversation_id AS conversationId, INSERTED.sequence,
          INSERTED.sender_actor_key AS senderActorKey, INSERTED.sender_type AS senderType,
          INSERTED.message_type AS messageType, INSERTED.visibility, INSERTED.content,
          INSERTED.created_at AS createdAt
        VALUES (
          @cid, @seq, @actorKey, @senderType, @uid,
          'INTERNAL_NOTE', 'STAFF', @content
        );
      `);

    const msg = {
      ...ins.recordset[0],
      id: Number(ins.recordset[0].id),
      conversationId: Number(ins.recordset[0].conversationId),
      sequence: Number(ins.recordset[0].sequence),
      payload: null,
      createdAt: new Date(ins.recordset[0].createdAt).toISOString(),
    };

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "message:created",
      payload: {
        conversationId: cid,
        assignedUserId: conv.assignedUserId ? String(conv.assignedUserId) : null,
        message: msg,
        visibility: "STAFF",
      },
    });

    return msg;
  });
}

async function generateAiDraftForManager(actor, conversationId) {
  assertManagerAccess(actor);
  const cid = Number(conversationId);
  const conv = await assertStaffConversationAccess(actor, cid);
  const messages = await getStaffConversationMessages(actor, cid, { limit: 15 });

  const contents = messages
    .filter((m) => m.visibility === "PUBLIC" && (m.senderType === "CUSTOMER" || m.senderType === "GUEST" || m.senderType === "MANAGER"))
    .map((m) => ({
      role: m.senderType === "MANAGER" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  if (contents.length === 0) {
    return { draftText: `Xin chào Quý khách, mình là Quản lý của ${conv.accommodationName}. Mình có thể hỗ trợ thông tin gì cho bạn ạ?` };
  }

  const res = await provider.generate({
    contents,
    system: `Bạn đang viết bản nháp câu trả lời gợi ý cho Quản lý cơ sở "${conv.accommodationName}". Hãy soạn 1 đoạn trả lời lịch sự, súc tích, chuyên nghiệp bằng tiếng Việt để Quản lý rà soát trước khi gửi cho khách.`,
    tools: [],
  });

  return { draftText: res.text.trim() };
}

async function returnConversationToAi(actor, conversationId) {
  assertManagerAccess(actor);
  if (!hasPermission(actor, "chat.transfer")) {
    throw chatError(403, "FORBIDDEN", "Bạn không có quyền trả hội thoại về AI.");
  }
  const cid = Number(conversationId);
  await withTransaction(async (tx) => {
    await lockConversationsInOrder(tx, [cid]);
    const conv = await assertStaffConversationAccess(actor, cid, tx);
    if (conv.handlingMode !== "HUMAN" || String(conv.assignedUserId || "").toLowerCase() !== actor.userId.toLowerCase()) {
      throw chatError(409, "INVALID_STATE", "Chỉ có thể trả về AI khi Quản lý đang tiếp nhận.");
    }

    if (conv.currentHandoffId) {
      await newRequest(tx)
        .input("hid", sqlObj.BigInt, conv.currentHandoffId)
        .query(`
          UPDATE dbo.chat_handoff_sessions
          SET status = 'RESOLVED', ended_at = SYSUTCDATETIME(), ended_reason = 'RETURNED_TO_AI'
          WHERE id = @hid AND status = 'CLAIMED';
        `);
    }

    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .query(`
        UPDATE dbo.chat_conversations
        SET handling_mode = 'AI',
            assigned_user_id = NULL,
            current_handoff_id = NULL,
            manager_wait_expires_at = NULL,
            control_revision = control_revision + 1,
            updated_at = SYSUTCDATETIME()
        WHERE id = @cid;
      `);

    const sysMsg = await appendSystemMessage(
      tx,
      cid,
      `Quản lý ${actor.displayName} đã hoàn tất trao đổi trực tiếp và chuyển hội thoại về Trợ lý AI VietPeace Stay.`,
    );

    const ownerKey = conv.customerUserId
      ? actorKeyForUser(conv.customerUserId)
      : actorKeyForGuest(conv.guestSessionId);

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "message:created",
      payload: { conversationId: cid, ownerKey, message: sysMsg, visibility: "PUBLIC" },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "conversation:updated",
      payload: {
        conversationId: cid,
        ownerKey,
        handlingMode: "AI",
        assignedUserId: null,
      },
    });
  });

  const updated = await assertStaffConversationAccess(actor, cid);
  return formatStaffConvRow(updated);
}

async function resolveConversationByManager(actor, conversationId) {
  assertManagerAccess(actor);
  const cid = Number(conversationId);
  await withTransaction(async (tx) => {
    await lockConversationsInOrder(tx, [cid]);
    const conv = await assertStaffConversationAccess(actor, cid, tx);
    if (conv.status === "RESOLVED") return;

    if (conv.currentHandoffId) {
      await newRequest(tx)
        .input("hid", sqlObj.BigInt, conv.currentHandoffId)
        .query(`
          UPDATE dbo.chat_handoff_sessions
          SET status = 'RESOLVED', ended_at = SYSUTCDATETIME(), ended_reason = 'MANAGER_RESOLVED'
          WHERE id = @hid AND status IN ('PENDING', 'CLAIMED');
        `);
    }

    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .query(`
        UPDATE dbo.chat_conversations
        SET status = 'RESOLVED',
            resolved_at = SYSUTCDATETIME(),
            ai_due_at = NULL,
            manager_wait_expires_at = NULL,
            control_revision = control_revision + 1,
            updated_at = SYSUTCDATETIME()
        WHERE id = @cid;
      `);

    const sysMsg = await appendSystemMessage(
      tx,
      cid,
      "Phiên tư vấn trực tiếp đã được Quản lý đánh dấu hoàn tất. Cảm ơn Quý khách đã sử dụng VietPeace Stay!",
    );

    const ownerKey = conv.customerUserId
      ? actorKeyForUser(conv.customerUserId)
      : actorKeyForGuest(conv.guestSessionId);

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "message:created",
      payload: { conversationId: cid, ownerKey, message: sysMsg, visibility: "PUBLIC" },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "conversation:updated",
      payload: { conversationId: cid, ownerKey, status: "RESOLVED" },
    });
  });

  const updated = await assertStaffConversationAccess(actor, cid);
  return formatStaffConvRow(updated);
}

/**
 * Strictly ONLY updates delivery/read when actor is the active assigned ACCOMMODATION_MANAGER.
 * Admin supervision NEVER advances customer-visible Đã nhận / Đã xem receipts!
 */
async function updateManagerReceipt(actor, conversationId, sequence, { kind = "delivered" } = {}) {
  if (!actor || actor.role !== "ACCOMMODATION_MANAGER") return null;
  const cid = Number(conversationId);
  const seq = Number(sequence);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;

  return withTransaction(async (tx) => {
    const conv = await assertStaffConversationAccess(actor, cid, tx);
    // Do not advance receipts while still WAITING_HUMAN or before claiming unless actively reading assigned HUMAN chat
    if (conv.handlingMode !== "HUMAN" && kind === "read") {
      return null;
    }

    const maxSeq = Math.min(seq, Number(conv.lastSequence));
    const epochId = actor.assignmentEpochId;

    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
      .input("mgrId", sqlObj.UniqueIdentifier, actor.userId)
      .input("epochId", sqlObj.BigInt, epochId)
      .input("visSeq", sqlObj.BigInt, Number(conv.visibleFromSequence || 0))
      .query(`
        IF NOT EXISTS (SELECT 1 FROM dbo.chat_participants WHERE conversation_id = @cid AND actor_key = @actorKey)
        BEGIN
          INSERT INTO dbo.chat_participants (
            conversation_id, actor_key, user_id, participant_role,
            manager_assignment_epoch_id, visible_from_sequence
          )
          VALUES (@cid, @actorKey, @mgrId, 'MANAGER', @epochId, @visSeq);
        END;
      `);

    if (kind === "read") {
      await newRequest(tx)
        .input("cid", sqlObj.BigInt, cid)
        .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
        .input("seq", sqlObj.BigInt, maxSeq)
        .query(`
          UPDATE dbo.chat_participants
          SET
            last_delivered_sequence = CASE WHEN last_delivered_sequence < @seq THEN @seq ELSE last_delivered_sequence END,
            last_delivered_at = CASE WHEN last_delivered_sequence < @seq THEN COALESCE(last_delivered_at, SYSUTCDATETIME()) ELSE last_delivered_at END,
            last_read_sequence = CASE WHEN last_read_sequence < @seq THEN @seq ELSE last_read_sequence END,
            last_read_at = CASE WHEN last_read_sequence < @seq THEN SYSUTCDATETIME() ELSE last_read_at END
          WHERE conversation_id = @cid AND actor_key = @actorKey;
        `);
    } else {
      await newRequest(tx)
        .input("cid", sqlObj.BigInt, cid)
        .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
        .input("seq", sqlObj.BigInt, maxSeq)
        .query(`
          UPDATE dbo.chat_participants
          SET
            last_delivered_sequence = CASE WHEN last_delivered_sequence < @seq THEN @seq ELSE last_delivered_sequence END,
            last_delivered_at = CASE WHEN last_delivered_sequence < @seq THEN SYSUTCDATETIME() ELSE last_delivered_at END
          WHERE conversation_id = @cid AND actor_key = @actorKey;
        `);
    }

    const partRes = await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
      .query(`
        SELECT last_delivered_sequence AS delivSeq, last_delivered_at AS delivAt,
               last_read_sequence AS readSeq, last_read_at AS readAt
        FROM dbo.chat_participants
        WHERE conversation_id = @cid AND actor_key = @actorKey;
      `);
    const p = partRes.recordset[0] || {};
    const ownerKey = conv.customerUserId
      ? actorKeyForUser(conv.customerUserId)
      : actorKeyForGuest(conv.guestSessionId);

    const payload = {
      conversationId: cid,
      ownerKey,
      actorKey: actor.actorKey,
      actorRole: actor.role,
      deliveredSequence: Number(p.delivSeq || 0),
      deliveredAt: p.delivAt ? new Date(p.delivAt).toISOString() : null,
      readSequence: Number(p.readSeq || 0),
      readAt: p.readAt ? new Date(p.readAt).toISOString() : null,
    };

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: kind === "read" ? "message:read-updated" : "message:delivery-updated",
      payload,
    });

    return payload;
  });
}

async function syncManagerDeliveredAll(actor) {
  if (!actor || actor.role !== "ACCOMMODATION_MANAGER" || !actor.accommodationId || !actor.assignmentEpochId) {
    return [];
  }
  const convs = await listStaffConversations(actor, { status: "OPEN" });
  const results = [];
  for (const c of convs) {
    if (c.handlingMode === "HUMAN" && c.lastSequence > 0) {
      const r = await updateManagerReceipt(actor, c.id, c.lastSequence, { kind: "delivered" }).catch(() => null);
      if (r) results.push(r);
    }
  }
  return results;
}

async function getConversationAuditEvents(actor, conversationId) {
  if (!hasPermission(actor, "chat.audit.read")) {
    throw chatError(403, "FORBIDDEN", "Bạn không có quyền xem nhật ký sự kiện.");
  }
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("cid", sqlObj.BigInt, Number(conversationId))
    .query(`
      SELECT TOP 100 id, actor_key AS actorKey, event_type AS eventType, payload_json AS payloadJson, created_at AS createdAt
      FROM dbo.chat_events
      WHERE conversation_id = @cid
      ORDER BY created_at DESC, id DESC;
    `);
  return res.recordset.map((e) => ({
    ...e,
    id: Number(e.id),
    payload: parseJsonSafe(e.payloadJson, null),
    createdAt: new Date(e.createdAt).toISOString(),
  }));
}

async function getSupportSettings(actor) {
  if (!hasPermission(actor, "chat.settings.manage")) {
    throw chatError(403, "FORBIDDEN", "Chỉ Admin mới được xem/sửa cấu hình Chat.");
  }
  const pool = getDBPool();
  const res = await pool.request().query(`
    SELECT id, accommodation_id AS accommodationId, ai_enabled AS aiEnabled,
           human_handoff_enabled AS humanHandoffEnabled, claim_timeout_seconds AS claimTimeoutSeconds,
           first_reply_timeout_seconds AS firstReplyTimeoutSeconds, offline_message AS offlineMessage,
           updated_at AS updatedAt
    FROM dbo.chat_support_settings
    ORDER BY accommodation_id ASC;
  `);
  return res.recordset;
}

async function updateSupportSettings(actor, body = {}) {
  if (!hasPermission(actor, "chat.settings.manage")) {
    throw chatError(403, "FORBIDDEN", "Chỉ Admin mới được sửa cấu hình Chat.");
  }
  const pool = getDBPool();
  const accomId = body.accommodationId ? Number(body.accommodationId) : null;
  const aiEnabled = body.aiEnabled !== undefined ? Boolean(body.aiEnabled) : true;
  const humanEnabled = body.humanHandoffEnabled !== undefined ? Boolean(body.humanHandoffEnabled) : true;
  const claimSec = Math.min(Math.max(Number(body.claimTimeoutSeconds || 300), 30), 3600);
  const offlineMsg = body.offlineMessage ? String(body.offlineMessage).slice(0, 500) : null;

  await pool
    .request()
    .input("scopeKey", sqlObj.Int, accomId || 0)
    .input("accomId", sqlObj.Int, accomId)
    .input("aiEnabled", sqlObj.Bit, aiEnabled ? 1 : 0)
    .input("humanEnabled", sqlObj.Bit, humanEnabled ? 1 : 0)
    .input("claimSec", sqlObj.Int, claimSec)
    .input("offlineMsg", sqlObj.NVarChar(500), offlineMsg)
    .input("adminId", sqlObj.UniqueIdentifier, actor.userId)
    .query(`
      MERGE dbo.chat_support_settings AS target
      USING (SELECT @scopeKey AS accommodation_scope_key) AS src
      ON target.accommodation_scope_key = src.accommodation_scope_key
      WHEN MATCHED THEN
        UPDATE SET ai_enabled = @aiEnabled, human_handoff_enabled = @humanEnabled,
                   claim_timeout_seconds = @claimSec, offline_message = @offlineMsg,
                   updated_by_user_id = @adminId, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (accommodation_id, ai_enabled, human_handoff_enabled, claim_timeout_seconds, offline_message, updated_by_user_id)
        VALUES (@accomId, @aiEnabled, @humanEnabled, @claimSec, @offlineMsg, @adminId);
    `);

  return getSupportSettings(actor);
}

// ============================================================
// Admin-Only Chat Reports (Missed 5-minute Handoffs + Low Ratings)
// ============================================================

function assertReportsAdmin(actor) {
  if (!actor || actor.role !== "ADMIN" || !hasPermission(actor, "chat.reports.read")) {
    throw chatError(403, "ADMIN_ONLY", "Chỉ Quản trị viên (Admin) mới được xem Báo cáo chat.");
  }
}

async function getAdminReportsSummary(actor) {
  assertReportsAdmin(actor);
  const pool = getDBPool();
  const res = await pool.request().query(`
    SELECT
      (SELECT COUNT(*) FROM dbo.chat_missed_handoff_reports WHERE admin_read_at IS NULL) AS unreadMissedCount,
      (SELECT COUNT(*) FROM dbo.chat_missed_handoff_reports) AS totalMissedCount,
      (SELECT COUNT(*) FROM dbo.chat_conversation_ratings WHERE admin_review_status = 'PENDING_REVIEW') AS pendingLowRatingsCount,
      (SELECT COUNT(*) FROM dbo.chat_conversation_ratings WHERE admin_review_status = 'CONFIRMED_VIOLATION') AS confirmedViolationsCount;
  `);
  const row = res.recordset[0] || {};
  const unreadMissedCount = Number(row.unreadMissedCount || 0);
  const pendingLowRatingsCount = Number(row.pendingLowRatingsCount || 0);
  return {
    unreadMissedCount,
    totalMissedCount: Number(row.totalMissedCount || 0),
    pendingLowRatingsCount,
    confirmedViolationsCount: Number(row.confirmedViolationsCount || 0),
    totalBadgeCount: unreadMissedCount + pendingLowRatingsCount,
  };
}

async function listMissedHandoffReports(actor, { unreadOnly = false, limit = 50, offset = 0 } = {}) {
  assertReportsAdmin(actor);
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("unreadOnly", sqlObj.Bit, unreadOnly ? 1 : 0)
    .input("limit", sqlObj.Int, Math.min(Math.max(Number(limit) || 50, 1), 100))
    .input("offset", sqlObj.Int, Math.max(Number(offset) || 0, 0))
    .query(`
      SELECT
        r.id,
        r.handoff_id AS handoffId,
        r.conversation_id AS conversationId,
        r.accommodation_id AS accommodationId,
        r.accommodation_name_snapshot AS accommodationName,
        r.manager_user_id AS managerUserId,
        r.manager_name_snapshot AS managerName,
        COALESCE(u.email, '') AS managerInternalEmail,
        COALESCE(u.personal_email, '') AS managerPersonalEmail,
        r.requester_type AS requesterType,
        r.requested_at AS requestedAt,
        r.expired_at AS expiredAt,
        r.timeout_seconds AS timeoutSeconds,
        r.admin_read_at AS adminReadAt,
        r.admin_acknowledged_by AS adminAcknowledgedBy,
        r.created_at AS createdAt
      FROM dbo.chat_missed_handoff_reports AS r
      LEFT JOIN dbo.users AS u ON u.id = r.manager_user_id
      WHERE (@unreadOnly = 0 OR r.admin_read_at IS NULL)
      ORDER BY CASE WHEN r.admin_read_at IS NULL THEN 0 ELSE 1 END, r.created_at DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
    `);

  return res.recordset.map((r) => ({
    ...r,
    id: Number(r.id),
    handoffId: r.handoffId ? Number(r.handoffId) : null,
    conversationId: r.conversationId ? Number(r.conversationId) : null,
    accommodationId: Number(r.accommodationId),
    timeoutSeconds: Number(r.timeoutSeconds || 300),
    requestedAt: new Date(r.requestedAt).toISOString(),
    expiredAt: new Date(r.expiredAt).toISOString(),
    adminReadAt: r.adminReadAt ? new Date(r.adminReadAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}

async function ackMissedHandoffReport(actor, reportId) {
  assertReportsAdmin(actor);
  const rid = Number(reportId);
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("rid", sqlObj.BigInt, rid)
    .input("adminId", sqlObj.UniqueIdentifier, actor.userId)
    .query(`
      UPDATE dbo.chat_missed_handoff_reports
      SET admin_read_at = COALESCE(admin_read_at, SYSUTCDATETIME()),
          admin_acknowledged_by = COALESCE(admin_acknowledged_by, @adminId)
      OUTPUT INSERTED.id, INSERTED.admin_read_at AS adminReadAt
      WHERE id = @rid;
    `);
  if (!res.recordset[0]) {
    throw chatError(404, "REPORT_NOT_FOUND", "Không tìm thấy báo cáo bỏ lỡ.");
  }
  return {
    id: Number(res.recordset[0].id),
    adminReadAt: new Date(res.recordset[0].adminReadAt).toISOString(),
  };
}

module.exports = {
  listStaffConversations,
  listSuperviseAccommodations,
  assertStaffConversationAccess,
  getStaffConversationMessages,
  claimConversation,
  sendManagerReply,
  addStaffNote,
  generateAiDraftForManager,
  returnConversationToAi,
  resolveConversationByManager,
  updateManagerReceipt,
  syncManagerDeliveredAll,
  getConversationAuditEvents,
  getSupportSettings,
  updateSupportSettings,
  getAdminReportsSummary,
  listMissedHandoffReports,
  ackMissedHandoffReport,
};

const config = require("../../configs/chat");
const { getDBPool, sqlObj } = require("../../configs/database");
const {
  chatError,
  withTransaction,
  newRequest,
  lockUsersInOrder,
  enqueueOutbox,
  previewText,
} = require("./db");
const { hasPermission } = require("./identity");

function assertInternalRead(actor) {
  if (!actor || !hasPermission(actor, "chat.internal.read")) {
    throw chatError(403, "FORBIDDEN", "Bạn không có quyền truy cập Chat nội bộ.");
  }
}

function assertInternalWrite(actor) {
  if (!actor || !hasPermission(actor, "chat.internal.write")) {
    throw chatError(403, "FORBIDDEN", "Bạn không có quyền nhắn tin nội bộ.");
  }
}

function buildCanonicalPair(userA, userB) {
  const a = { ...userA, userId: String(userA.userId).toLowerCase() };
  const b = { ...userB, userId: String(userB.userId).toLowerCase() };
  if (a.userId === b.userId) {
    throw chatError(400, "SELF_CHAT_NOT_ALLOWED", "Không thể tự tạo luồng chat nội bộ với chính mình.");
  }

  // Slot A: always ADMIN in ADMIN_MANAGER, else lexicographically smaller userId in MANAGER_MANAGER
  let sideA = a;
  let sideB = b;
  if (a.role === "ADMIN" && b.role !== "ADMIN") {
    sideA = a;
    sideB = b;
  } else if (b.role === "ADMIN" && a.role !== "ADMIN") {
    sideA = b;
    sideB = a;
  } else if (b.userId < a.userId) {
    sideA = b;
    sideB = a;
  }

  const threadType =
    sideA.role === "ADMIN" || sideB.role === "ADMIN" ? "ADMIN_MANAGER" : "MANAGER_MANAGER";
  const pairKey = `${threadType}:${sideA.userId}:${sideB.userId}`;
  return { threadType, sideA, sideB, pairKey };
}

function formatThreadForActor(row, actorUserId) {
  const me = String(actorUserId).toLowerCase();
  const isSideA = String(row.adminUserId).toLowerCase() === me;
  const peerUserId = isSideA ? String(row.managerUserId) : String(row.adminUserId);
  const defaultPeerName = isSideA ? row.managerNameSnapshot : row.adminNameSnapshot;
  const customPeerName = isSideA ? row.participantACustomName : row.participantBCustomName;
  const lastSeq = Number(row.lastSequence || 0);

  const myLastRead = isSideA ? Number(row.adminLastReadSequence || 0) : Number(row.managerLastReadSequence || 0);
  const myLastDelivered = isSideA ? Number(row.adminLastDeliveredSequence || 0) : Number(row.managerLastDeliveredSequence || 0);
  const peerLastDelivered = isSideA ? Number(row.managerLastDeliveredSequence || 0) : Number(row.adminLastDeliveredSequence || 0);
  const peerLastDeliveredAt = isSideA ? row.managerLastDeliveredAt : row.adminLastDeliveredAt;
  const peerLastRead = isSideA ? Number(row.managerLastReadSequence || 0) : Number(row.adminLastReadSequence || 0);
  const peerLastReadAt = isSideA ? row.managerLastReadAt : row.adminLastReadAt;

  return {
    id: Number(row.id),
    threadType: row.threadType,
    accommodationId: row.accommodationId ? Number(row.accommodationId) : null,
    accommodationName: row.accommodationName || null,
    peerUserId,
    peerRole: row.threadType === "ADMIN_MANAGER" ? (isSideA ? "ACCOMMODATION_MANAGER" : "ADMIN") : "ACCOMMODATION_MANAGER",
    peerEmail: row.peerEmail || null,
    peerName: customPeerName || defaultPeerName || "Nhân sự VietPeace Stay",
    defaultPeerName: defaultPeerName || "Nhân sự VietPeace Stay",
    customPeerName: customPeerName || null,
    lastSequence: lastSeq,
    lastMessageAt: row.lastMessageAt ? new Date(row.lastMessageAt).toISOString() : null,
    lastMessagePreview: row.lastMessagePreview || "",
    unreadCount: Number(row.unreadCount ?? Math.max(0, lastSeq - myLastRead)),
    myLastDeliveredSequence: myLastDelivered,
    myLastReadSequence: myLastRead,
    peerDelivery: {
      deliveredSequence: peerLastDelivered,
      deliveredAt: peerLastDeliveredAt ? new Date(peerLastDeliveredAt).toISOString() : null,
      readSequence: peerLastRead,
      readAt: peerLastReadAt ? new Date(peerLastReadAt).toISOString() : null,
    },
    isArchived: Boolean(row.isArchived),
    archivedReason: row.archivedReason || null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

async function listInternalContacts(actor) {
  assertInternalRead(actor);
  const pool = getDBPool();

  if (actor.role === "ADMIN") {
    const res = await pool
      .request()
      .input("me", sqlObj.UniqueIdentifier, actor.userId)
      .query(`
        SELECT
          u.id AS userId,
          u.role,
          u.full_name AS fullName,
          u.display_name AS displayName,
          u.email,
          e.id AS assignmentEpochId,
          e.accommodation_id AS accommodationId,
          a.accommodation_name AS accommodationName
        FROM dbo.users AS u
        LEFT JOIN dbo.chat_manager_assignment_epochs AS e
          ON e.user_id = u.id AND e.revoked_at_utc IS NULL
        LEFT JOIN dbo.accommodations AS a
          ON a.id = e.accommodation_id AND a.deleted_at IS NULL
        WHERE u.id <> @me
          AND u.role = 'ACCOMMODATION_MANAGER'
          AND u.status = 1
          AND u.must_change_password = 0
        ORDER BY CASE WHEN e.id IS NOT NULL THEN 0 ELSE 1 END, a.accommodation_name ASC, u.full_name ASC;
      `);
    return res.recordset.map((r) => ({
      userId: String(r.userId),
      role: r.role,
      fullName: r.displayName || r.fullName,
      email: r.email,
      accommodationId: r.accommodationId ? Number(r.accommodationId) : null,
      accommodationName: r.accommodationName || "Chưa gán cơ sở",
      assignmentEpochId: r.assignmentEpochId ? Number(r.assignmentEpochId) : null,
    }));
  }

  // Manager sees active ADMIN + active fellow ACCOMMODATION_MANAGER
  const res = await pool
    .request()
    .input("me", sqlObj.UniqueIdentifier, actor.userId)
    .query(`
      SELECT
        u.id AS userId,
        u.role,
        u.full_name AS fullName,
        u.display_name AS displayName,
        u.email,
        e.id AS assignmentEpochId,
        e.accommodation_id AS accommodationId,
        a.accommodation_name AS accommodationName
      FROM dbo.users AS u
      LEFT JOIN dbo.chat_manager_assignment_epochs AS e
        ON e.user_id = u.id AND e.revoked_at_utc IS NULL
      LEFT JOIN dbo.accommodations AS a
        ON a.id = e.accommodation_id AND a.deleted_at IS NULL
      WHERE u.id <> @me
        AND u.role IN ('ADMIN', 'ACCOMMODATION_MANAGER')
        AND u.status = 1
        AND u.must_change_password = 0
      ORDER BY CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END, a.accommodation_name ASC, u.full_name ASC;
    `);
  return res.recordset.map((r) => ({
    userId: String(r.userId),
    role: r.role,
    fullName: r.displayName || r.fullName,
    email: r.email,
    accommodationId: r.accommodationId ? Number(r.accommodationId) : null,
    accommodationName: r.role === "ADMIN" ? "Ban quản trị VietPeace Stay" : r.accommodationName || "Chưa gán cơ sở",
    assignmentEpochId: r.assignmentEpochId ? Number(r.assignmentEpochId) : null,
  }));
}

async function listInternalThreads(actor) {
  assertInternalRead(actor);
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("me", sqlObj.UniqueIdentifier, actor.userId)
    .query(`
      SELECT
        t.id,
        t.thread_type AS threadType,
        t.admin_user_id AS adminUserId,
        t.manager_user_id AS managerUserId,
        t.accommodation_id AS accommodationId,
        a.accommodation_name AS accommodationName,
        t.admin_name_snapshot AS adminNameSnapshot,
        t.manager_name_snapshot AS managerNameSnapshot,
        t.participant_a_custom_name AS participantACustomName,
        t.participant_b_custom_name AS participantBCustomName,
        CASE WHEN t.admin_user_id = @me THEN pu.email ELSE au.email END AS peerEmail,
        t.last_sequence AS lastSequence,
        t.last_message_at AS lastMessageAt,
        t.last_message_preview AS lastMessagePreview,
        t.admin_last_delivered_sequence AS adminLastDeliveredSequence,
        t.admin_last_delivered_at AS adminLastDeliveredAt,
        t.admin_last_read_sequence AS adminLastReadSequence,
        t.admin_last_read_at AS adminLastReadAt,
        t.manager_last_delivered_sequence AS managerLastDeliveredSequence,
        t.manager_last_delivered_at AS managerLastDeliveredAt,
        t.manager_last_read_sequence AS managerLastReadSequence,
        t.manager_last_read_at AS managerLastReadAt,
        t.is_archived AS isArchived,
        t.archived_reason AS archivedReason,
        (
          SELECT COUNT(*)
          FROM dbo.chat_internal_messages m
          WHERE m.thread_id = t.id
            AND m.sender_user_id <> @me
            AND m.sequence > CASE WHEN t.admin_user_id = @me THEN t.admin_last_read_sequence ELSE t.manager_last_read_sequence END
        ) AS unreadCount,
        t.created_at AS createdAt,
        t.updated_at AS updatedAt
      FROM dbo.chat_internal_threads AS t
      LEFT JOIN dbo.accommodations AS a ON a.id = t.accommodation_id
      LEFT JOIN dbo.users AS au ON au.id = t.admin_user_id
      LEFT JOIN dbo.users AS pu ON pu.id = t.manager_user_id
      WHERE t.admin_user_id = @me OR t.manager_user_id = @me
      ORDER BY t.is_archived ASC, COALESCE(t.last_message_at, t.created_at) DESC, t.id DESC;
    `);

  return res.recordset.map((r) => formatThreadForActor(r, actor.userId));
}

async function openOrCreateInternalThread(actor, targetUserId) {
  assertInternalRead(actor);
  const pool = getDBPool();

  const targetRes = await pool
    .request()
    .input("tid", sqlObj.UniqueIdentifier, targetUserId)
    .query(`
      SELECT TOP 1
        u.id AS userId,
        u.role,
        u.full_name AS fullName,
        u.display_name AS displayName,
        u.email,
        u.status,
        u.must_change_password AS mustChangePassword,
        e.id AS assignmentEpochId,
        e.accommodation_id AS accommodationId
      FROM dbo.users AS u
      LEFT JOIN dbo.chat_manager_assignment_epochs AS e ON e.user_id = u.id AND e.revoked_at_utc IS NULL
      WHERE u.id = @tid;
    `);
  const target = targetRes.recordset[0];
  if (!target || !target.status || target.mustChangePassword || !["ADMIN", "ACCOMMODATION_MANAGER"].includes(target.role)) {
    throw chatError(404, "CONTACT_NOT_FOUND", "Nhân sự này không tồn tại hoặc chưa đủ điều kiện hoạt động.");
  }
  if (actor.role === "ADMIN" && target.role === "ADMIN") {
    throw chatError(400, "INVALID_PAIR", "Chat nội bộ hỗ trợ cặp Admin ↔ Manager hoặc Manager ↔ Manager.");
  }

  const meObj = {
    userId: actor.userId,
    role: actor.role,
    displayName: actor.displayName,
    assignmentEpochId: actor.assignmentEpochId,
    accommodationId: actor.accommodationId,
  };
  const peerObj = {
    userId: String(target.userId),
    role: target.role,
    displayName: target.displayName || target.fullName || target.email,
    assignmentEpochId: target.assignmentEpochId ? Number(target.assignmentEpochId) : null,
    accommodationId: target.accommodationId ? Number(target.accommodationId) : null,
  };

  const { threadType, sideA, sideB, pairKey } = buildCanonicalPair(meObj, peerObj);

  const threadId = await withTransaction(async (tx) => {
    await lockUsersInOrder(tx, [sideA.userId, sideB.userId]);
    const existRes = await newRequest(tx)
      .input("pairKey", sqlObj.VarChar(120), pairKey)
      .query(`SELECT id FROM dbo.chat_internal_threads WITH (UPDLOCK, HOLDLOCK) WHERE participant_pair_key = @pairKey;`);
    if (existRes.recordset[0]) {
      return Number(existRes.recordset[0].id);
    }

    const ins = await newRequest(tx)
      .input("type", sqlObj.VarChar(20), threadType)
      .input("aid", sqlObj.UniqueIdentifier, sideA.userId)
      .input("bid", sqlObj.UniqueIdentifier, sideB.userId)
      .input("mgrEpoch", sqlObj.BigInt, sideB.assignmentEpochId || null)
      .input("admEpoch", sqlObj.BigInt, sideA.assignmentEpochId || null)
      .input("accomId", sqlObj.Int, sideB.accommodationId || sideA.accommodationId || null)
      .input("pairKey", sqlObj.VarChar(120), pairKey)
      .input("aName", sqlObj.NVarChar(255), sideA.displayName)
      .input("bName", sqlObj.NVarChar(255), sideB.displayName)
      .query(`
        INSERT INTO dbo.chat_internal_threads (
          thread_type, admin_user_id, manager_user_id,
          manager_assignment_epoch_id, admin_assignment_epoch_id,
          accommodation_id, participant_pair_key,
          admin_name_snapshot, manager_name_snapshot
        )
        OUTPUT INSERTED.id
        VALUES (
          @type, @aid, @bid,
          @mgrEpoch, @admEpoch,
          @accomId, @pairKey,
          @aName, @bName
        );
      `);
    return Number(ins.recordset[0].id);
  });

  const threads = await listInternalThreads(actor);
  return threads.find((t) => t.id === threadId);
}

async function assertThreadParticipant(actor, threadId, txOrPool = getDBPool()) {
  assertInternalRead(actor);
  const tid = Number(threadId);
  if (!Number.isSafeInteger(tid) || tid < 1) {
    throw chatError(400, "INVALID_THREAD_ID", "Mã luồng nội bộ không hợp lệ.");
  }
  const res = await newRequest(txOrPool)
    .input("tid", sqlObj.BigInt, tid)
    .input("me", sqlObj.UniqueIdentifier, actor.userId)
    .query(`
      SELECT
        t.*,
        a.accommodation_name AS accommodationName,
        CASE WHEN t.admin_user_id = @me THEN pu.email ELSE au.email END AS peerEmail
      FROM dbo.chat_internal_threads AS t
      LEFT JOIN dbo.accommodations AS a ON a.id = t.accommodation_id
      LEFT JOIN dbo.users AS au ON au.id = t.admin_user_id
      LEFT JOIN dbo.users AS pu ON pu.id = t.manager_user_id
      WHERE t.id = @tid
        AND (t.admin_user_id = @me OR t.manager_user_id = @me);
    `);
  const row = res.recordset[0];
  if (!row) {
    throw chatError(404, "THREAD_NOT_FOUND", "Không tìm thấy luồng chat nội bộ.");
  }
  return row;
}

async function listInternalMessages(actor, threadId, { limit = 60, beforeSequence = null } = {}) {
  await assertThreadParticipant(actor, threadId);
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("tid", sqlObj.BigInt, Number(threadId))
    .input("beforeSeq", sqlObj.BigInt, beforeSequence ? Number(beforeSequence) : null)
    .input("limit", sqlObj.Int, Math.min(Math.max(Number(limit) || 60, 1), config.historyMaxLimit))
    .query(`
      SELECT TOP (@limit)
        id,
        thread_id AS threadId,
        sequence,
        sender_user_id AS senderUserId,
        sender_name_snapshot AS senderName,
        client_message_id AS clientMessageId,
        content,
        reply_to_message_id AS replyToMessageId,
        created_at AS createdAt
      FROM dbo.chat_internal_messages
      WHERE thread_id = @tid
        AND (@beforeSeq IS NULL OR sequence < @beforeSeq)
      ORDER BY sequence DESC;
    `);
  return res.recordset.reverse().map((m) => ({
    ...m,
    id: Number(m.id),
    threadId: Number(m.threadId),
    sequence: Number(m.sequence),
    senderUserId: String(m.senderUserId),
    createdAt: new Date(m.createdAt).toISOString(),
  }));
}

async function sendInternalMessage(actor, threadId, { content, clientMessageId = null, replyToMessageId = null }) {
  assertInternalWrite(actor);
  const cleanText = String(content || "").trim();
  if (!cleanText || cleanText.length > config.messageMaxLength) {
    throw chatError(400, "INVALID_MESSAGE", "Nội dung tin nhắn nội bộ không hợp lệ.");
  }
  const cleanClientId = clientMessageId ? String(clientMessageId).trim().slice(0, 100) : null;
  const tid = Number(threadId);

  return withTransaction(async (tx) => {
    await newRequest(tx)
      .input("tid", sqlObj.BigInt, tid)
      .query(`SELECT id FROM dbo.chat_internal_threads WITH (UPDLOCK, HOLDLOCK) WHERE id = @tid;`);

    const row = await assertThreadParticipant(actor, tid, tx);
    if (row.is_archived) {
      throw chatError(409, "THREAD_ARCHIVED", "Luồng chat cũ của ca phân công trước đã chuyển sang chế độ chỉ đọc.");
    }

    if (cleanClientId) {
      const dup = await newRequest(tx)
        .input("tid", sqlObj.BigInt, tid)
        .input("uid", sqlObj.UniqueIdentifier, actor.userId)
        .input("cid", sqlObj.VarChar(100), cleanClientId)
        .query(`
          SELECT TOP 1 id, thread_id AS threadId, sequence, sender_user_id AS senderUserId,
            sender_name_snapshot AS senderName, client_message_id AS clientMessageId, content, created_at AS createdAt
          FROM dbo.chat_internal_messages
          WHERE thread_id = @tid AND sender_user_id = @uid AND client_message_id = @cid;
        `);
      if (dup.recordset[0]) {
        const d = dup.recordset[0];
        return {
          duplicate: true,
          message: {
            ...d,
            id: Number(d.id),
            threadId: Number(d.threadId),
            sequence: Number(d.sequence),
            senderUserId: String(d.senderUserId),
            createdAt: new Date(d.createdAt).toISOString(),
          },
        };
      }
    }

    const isSideA = String(row.admin_user_id).toLowerCase() === actor.userId.toLowerCase();
    const seqRes = await newRequest(tx)
      .input("tid", sqlObj.BigInt, tid)
      .input("preview", sqlObj.NVarChar(300), previewText(cleanText))
      .query(`
        UPDATE dbo.chat_internal_threads
        SET last_sequence = last_sequence + 1,
            last_message_at = SYSUTCDATETIME(),
            last_message_preview = @preview,
            ${isSideA
              ? `admin_last_delivered_sequence = last_sequence + 1,
                 admin_last_delivered_at = SYSUTCDATETIME(),
                 admin_last_read_sequence = last_sequence + 1,
                 admin_last_read_at = SYSUTCDATETIME(),`
              : `manager_last_delivered_sequence = last_sequence + 1,
                 manager_last_delivered_at = SYSUTCDATETIME(),
                 manager_last_read_sequence = last_sequence + 1,
                 manager_last_read_at = SYSUTCDATETIME(),`}
            updated_at = SYSUTCDATETIME()
        OUTPUT INSERTED.last_sequence AS seq
        WHERE id = @tid;
      `);

    const seq = Number(seqRes.recordset[0].seq);
    const ins = await newRequest(tx)
      .input("tid", sqlObj.BigInt, tid)
      .input("seq", sqlObj.BigInt, seq)
      .input("uid", sqlObj.UniqueIdentifier, actor.userId)
      .input("name", sqlObj.NVarChar(255), actor.displayName)
      .input("cid", sqlObj.VarChar(100), cleanClientId)
      .input("content", sqlObj.NVarChar(sqlObj.MAX), cleanText)
      .input("replyToId", sqlObj.BigInt, replyToMessageId ? Number(replyToMessageId) : null)
      .query(`
        INSERT INTO dbo.chat_internal_messages (
          thread_id, sequence, sender_user_id, sender_name_snapshot, client_message_id, content, reply_to_message_id
        )
        OUTPUT
          INSERTED.id, INSERTED.thread_id AS threadId, INSERTED.sequence,
          INSERTED.sender_user_id AS senderUserId, INSERTED.sender_name_snapshot AS senderName,
          INSERTED.client_message_id AS clientMessageId, INSERTED.content, INSERTED.created_at AS createdAt
        VALUES (@tid, @seq, @uid, @name, @cid, @content, @replyToId);
      `);

    const msg = {
      ...ins.recordset[0],
      id: Number(ins.recordset[0].id),
      threadId: Number(ins.recordset[0].threadId),
      sequence: Number(ins.recordset[0].sequence),
      senderUserId: String(ins.recordset[0].senderUserId),
      createdAt: new Date(ins.recordset[0].createdAt).toISOString(),
    };

    const peerUserId = isSideA ? String(row.manager_user_id) : String(row.admin_user_id);

    await enqueueOutbox(tx, {
      kind: "INTERNAL_EVENT",
      conversationId: null,
      eventName: "internal:message-created",
      payload: {
        threadId: tid,
        adminUserId: String(row.admin_user_id),
        managerUserId: String(row.manager_user_id),
        peerUserId,
        message: msg,
      },
    });

    await enqueueOutbox(tx, {
      kind: "INTERNAL_EVENT",
      conversationId: null,
      eventName: "internal:thread-updated",
      payload: {
        threadId: tid,
        adminUserId: String(row.admin_user_id),
        managerUserId: String(row.manager_user_id),
        lastSequence: seq,
        lastMessageAt: msg.createdAt,
        lastMessagePreview: previewText(cleanText),
      },
    });

    return { duplicate: false, message: msg };
  });
}

async function updateInternalReceipt(actor, threadId, sequence, { kind = "delivered" } = {}) {
  const tid = Number(threadId);
  const seq = Number(sequence);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;

  return withTransaction(async (tx) => {
    await newRequest(tx)
      .input("tid", sqlObj.BigInt, tid)
      .query(`SELECT id FROM dbo.chat_internal_threads WITH (UPDLOCK, HOLDLOCK) WHERE id = @tid;`);
    const row = await assertThreadParticipant(actor, tid, tx);
    const maxSeq = Math.min(seq, Number(row.last_sequence || 0));
    const isSideA = String(row.admin_user_id).toLowerCase() === actor.userId.toLowerCase();

    const delivCol = isSideA ? "admin_last_delivered_sequence" : "manager_last_delivered_sequence";
    const delivAtCol = isSideA ? "admin_last_delivered_at" : "manager_last_delivered_at";
    const readCol = isSideA ? "admin_last_read_sequence" : "manager_last_read_sequence";
    const readAtCol = isSideA ? "admin_last_read_at" : "manager_last_read_at";

    const upd = await newRequest(tx)
      .input("tid", sqlObj.BigInt, tid)
      .input("seq", sqlObj.BigInt, maxSeq)
      .query(`
        UPDATE dbo.chat_internal_threads
        SET
          ${delivCol} = CASE WHEN ${delivCol} < @seq THEN @seq ELSE ${delivCol} END,
          ${delivAtCol} = CASE WHEN ${delivCol} < @seq THEN COALESCE(${delivAtCol}, SYSUTCDATETIME()) ELSE ${delivAtCol} END
          ${kind === "read"
            ? `, ${readCol} = CASE WHEN ${readCol} < @seq THEN @seq ELSE ${readCol} END,
               ${readAtCol} = CASE WHEN ${readCol} < @seq THEN SYSUTCDATETIME() ELSE ${readAtCol} END`
            : ""}
        OUTPUT
          INSERTED.${delivCol} AS deliveredSequence,
          INSERTED.${delivAtCol} AS deliveredAt,
          INSERTED.${readCol} AS readSequence,
          INSERTED.${readAtCol} AS readAt
        WHERE id = @tid;
      `);

    const out = upd.recordset[0] || {};
    const payload = {
      threadId: tid,
      actorUserId: actor.userId,
      adminUserId: String(row.admin_user_id),
      managerUserId: String(row.manager_user_id),
      deliveredSequence: Number(out.deliveredSequence || 0),
      deliveredAt: out.deliveredAt ? new Date(out.deliveredAt).toISOString() : null,
      readSequence: Number(out.readSequence || 0),
      readAt: out.readAt ? new Date(out.readAt).toISOString() : null,
    };

    await enqueueOutbox(tx, {
      kind: "INTERNAL_EVENT",
      conversationId: null,
      eventName: kind === "read" ? "internal:read-updated" : "internal:delivery-updated",
      payload,
    });

    return payload;
  });
}

async function syncInternalDeliveredAll(actor) {
  assertInternalRead(actor);
  const threads = await listInternalThreads(actor);
  const results = [];
  for (const t of threads) {
    if (t.lastSequence > t.myLastDeliveredSequence) {
      const r = await updateInternalReceipt(actor, t.id, t.lastSequence, { kind: "delivered" }).catch(() => null);
      if (r) results.push(r);
    }
  }
  return results;
}

async function renameInternalThread(actor, threadId, customName) {
  assertInternalRead(actor);
  const tid = Number(threadId);
  const cleanName = customName ? String(customName).trim().slice(0, 120) : null;
  return withTransaction(async (tx) => {
    const row = await assertThreadParticipant(actor, tid, tx);
    const isSideA = String(row.admin_user_id).toLowerCase() === actor.userId.toLowerCase();
    const col = isSideA ? "participant_a_custom_name" : "participant_b_custom_name";
    await newRequest(tx)
      .input("tid", sqlObj.BigInt, tid)
      .input("cname", sqlObj.NVarChar(255), cleanName || null)
      .query(`UPDATE dbo.chat_internal_threads SET ${col} = @cname, updated_at = SYSUTCDATETIME() WHERE id = @tid;`);
    return { threadId: tid, customPeerName: cleanName || null };
  });
}

async function getInternalSummary(actor) {
  const threads = await listInternalThreads(actor);
  const unreadTotal = threads.reduce((sum, t) => sum + t.unreadCount, 0);
  return { unreadTotal, threadCount: threads.length };
}

module.exports = {
  listInternalContacts,
  listInternalThreads,
  openOrCreateInternalThread,
  assertThreadParticipant,
  listInternalMessages,
  sendInternalMessage,
  updateInternalReceipt,
  syncInternalDeliveredAll,
  renameInternalThread,
  getInternalSummary,
};

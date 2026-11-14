const config = require("../../configs/chat");
const { getDBPool, sqlObj } = require("../../configs/database");
const {
  actorKeyForUser,
  actorKeyForGuest,
  withTransaction,
  newRequest,
  lockAccommodationsInOrder,
  lockConversationsInOrder,
  enqueueOutbox,
  recordChatEvent,
  previewText,
} = require("./db");
const { invalidateActorAuthCache } = require("./identity");

async function insertSystemMessageInTx(tx, conversationId, content, { handoffId = null, payload = null } = {}) {
  const seqRes = await newRequest(tx)
    .input("cid", sqlObj.BigInt, conversationId)
    .query(`
      UPDATE dbo.chat_conversations
      SET
        last_sequence = last_sequence + 1,
        last_message_at = SYSUTCDATETIME(),
        last_message_preview = @preview,
        updated_at = SYSUTCDATETIME()
      OUTPUT INSERTED.last_sequence AS nextSequence
      WHERE id = @cid;
    `, undefined);
  return seqRes;
}

// Clean transaction-safe helper to insert system message properly with preview parameter
async function appendSystemMessage(tx, conversationId, content, { handoffId = null, payload = null } = {}) {
  const seqRes = await newRequest(tx)
    .input("cid", sqlObj.BigInt, conversationId)
    .input("preview", sqlObj.NVarChar(300), previewText(content))
    .query(`
      UPDATE dbo.chat_conversations
      SET
        last_sequence = last_sequence + 1,
        last_message_at = SYSUTCDATETIME(),
        last_message_preview = @preview,
        updated_at = SYSUTCDATETIME()
      OUTPUT INSERTED.last_sequence AS seq
      WHERE id = @cid;
    `);
  const seq = Number(seqRes.recordset[0].seq);

  const msgRes = await newRequest(tx)
    .input("cid", sqlObj.BigInt, conversationId)
    .input("seq", sqlObj.BigInt, seq)
    .input("content", sqlObj.NVarChar(sqlObj.MAX), content)
    .input("payloadJson", sqlObj.NVarChar(sqlObj.MAX), payload ? JSON.stringify(payload) : null)
    .input("handoffId", sqlObj.BigInt, handoffId ? Number(handoffId) : null)
    .query(`
      INSERT INTO dbo.chat_messages (
        conversation_id, sequence, sender_actor_key, sender_type,
        message_type, visibility, content, payload_json, handoff_id
      )
      OUTPUT
        INSERTED.id,
        INSERTED.conversation_id AS conversationId,
        INSERTED.sequence,
        INSERTED.sender_actor_key AS senderActorKey,
        INSERTED.sender_type AS senderType,
        INSERTED.message_type AS messageType,
        INSERTED.visibility,
        INSERTED.content,
        INSERTED.payload_json AS payloadJson,
        INSERTED.handoff_id AS handoffId,
        INSERTED.created_at AS createdAt
      VALUES (
        @cid, @seq, 'system', 'SYSTEM',
        'SYSTEM', 'PUBLIC', @content, @payloadJson, @handoffId
      );
    `);

  const msg = msgRes.recordset[0];
  return {
    ...msg,
    id: Number(msg.id),
    conversationId: Number(msg.conversationId),
    sequence: Number(msg.sequence),
    handoffId: msg.handoffId ? Number(msg.handoffId) : null,
    payload: payload || null,
    createdAt: new Date(msg.createdAt).toISOString(),
  };
}

/**
 * Called INSIDE manager_handover_service.js transactions whenever a manager is assigned, replaced, or revoked.
 */
async function syncManagerEpochInTransaction(
  tx,
  { accommodationId, newManagerUserId = null, reason = "MANAGER_HANDOVER", actorAdminId = null },
) {
  await lockAccommodationsInOrder(tx, [accommodationId]);

  // 1. Find currently active epoch(s) for this accommodation
  const activeRes = await newRequest(tx)
    .input("accomId", sqlObj.Int, accommodationId)
    .query(`
      SELECT id, user_id AS userId
      FROM dbo.chat_manager_assignment_epochs WITH (UPDLOCK, HOLDLOCK)
      WHERE accommodation_id = @accomId
        AND revoked_at_utc IS NULL;
    `);

  const oldEpochs = activeRes.recordset;

  // If active epoch already points to same manager and not revoking, nothing to rotate
  if (
    oldEpochs.length === 1 &&
    newManagerUserId &&
    String(oldEpochs[0].userId).toLowerCase() === String(newManagerUserId).toLowerCase()
  ) {
    return { rotated: false, epochId: Number(oldEpochs[0].id) };
  }

  for (const oldEpoch of oldEpochs) {
    invalidateActorAuthCache(oldEpoch.userId);

    // Revoke old epoch
    await newRequest(tx)
      .input("epochId", sqlObj.BigInt, oldEpoch.id)
      .input("reason", sqlObj.NVarChar(200), reason)
      .query(`
        UPDATE dbo.chat_manager_assignment_epochs
        SET revoked_at_utc = SYSUTCDATETIME(),
            revoked_reason = @reason
        WHERE id = @epochId AND revoked_at_utc IS NULL;
      `);

    // Revoke socket tickets & emit access:revoked for replaced manager
    await newRequest(tx)
      .input("userId", sqlObj.UniqueIdentifier, oldEpoch.userId)
      .query(`
        UPDATE dbo.chat_socket_tickets
        SET revoked_at = SYSUTCDATETIME()
        WHERE user_id = @userId AND audience = 'admin' AND revoked_at IS NULL;
      `);

    await enqueueOutbox(tx, {
      kind: "ACCESS_REVOKED",
      conversationId: null,
      eventName: "access:revoked",
      payload: {
        actorKey: actorKeyForUser(oldEpoch.userId),
        userId: String(oldEpoch.userId),
        audience: "admin",
        reason,
      },
    });

    // Archive internal threads tied to this old epoch
    await newRequest(tx)
      .input("epochId", sqlObj.BigInt, oldEpoch.id)
      .input("reason", sqlObj.NVarChar(200), reason)
      .query(`
        UPDATE dbo.chat_internal_threads
        SET is_archived = 1,
            archived_reason = @reason,
            updated_at = SYSUTCDATETIME()
        WHERE (manager_assignment_epoch_id = @epochId OR admin_assignment_epoch_id = @epochId)
          AND is_archived = 0;
      `);
  }

  // Close open human/waiting conversations belonging to this property with exactly 1 system notice & return to AI
  const openConvRes = await newRequest(tx)
    .input("accomId", sqlObj.Int, accommodationId)
    .query(`
      SELECT id
      FROM dbo.chat_conversations WITH (UPDLOCK, HOLDLOCK)
      WHERE accommodation_id = @accomId
        AND status = 'OPEN'
        AND handling_mode IN ('WAITING_HUMAN', 'HUMAN');
    `);

  for (const c of openConvRes.recordset) {
    const cid = Number(c.id);
    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("reason", sqlObj.VarChar(60), reason)
      .query(`
        UPDATE dbo.chat_handoff_sessions
        SET status = 'TRANSFERRED',
            ended_at = SYSUTCDATETIME(),
            ended_reason = @reason
        WHERE conversation_id = @cid AND status IN ('PENDING', 'CLAIMED');

        UPDATE dbo.chat_conversations
        SET handling_mode = 'AI',
            assigned_user_id = NULL,
            current_handoff_id = NULL,
            manager_assignment_epoch_id = NULL,
            manager_wait_expires_at = NULL,
            control_revision = control_revision + 1,
            updated_at = SYSUTCDATETIME()
        WHERE id = @cid;
      `);

    const sysMsg = await appendSystemMessage(
      tx,
      cid,
      "Quản lý phụ trách cơ sở vừa được bàn giao lại. Phiên trò chuyện được chuyển về Trợ lý AI VietPeace Stay để tiếp tục hỗ trợ bạn ngay.",
    );

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "message:created",
      payload: { conversationId: cid, message: sysMsg, visibility: "PUBLIC" },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "conversation:updated",
      payload: {
        conversationId: cid,
        handlingMode: "AI",
        assignedUserId: null,
        managerAssignmentEpochId: null,
      },
    });
  }

  let newEpochId = null;
  if (newManagerUserId) {
    const insRes = await newRequest(tx)
      .input("accomId", sqlObj.Int, accommodationId)
      .input("userId", sqlObj.UniqueIdentifier, newManagerUserId)
      .query(`
        INSERT INTO dbo.chat_manager_assignment_epochs (
          accommodation_id, user_id, source_assigned_at, assigned_at_utc
        )
        OUTPUT INSERTED.id
        VALUES (@accomId, @userId, SYSUTCDATETIME(), SYSUTCDATETIME());
      `);
    newEpochId = Number(insRes.recordset[0].id);
    invalidateActorAuthCache(newManagerUserId);
  }

  if (actorAdminId) {
    await recordChatEvent(tx, {
      actorKey: actorKeyForUser(actorAdminId),
      eventType: "MANAGER_EPOCH_SYNCED",
      payload: { accommodationId, newManagerUserId, newEpochId, reason },
    });
  }

  return { rotated: true, epochId: newEpochId };
}

/**
 * Physical immediate cleanup of Guest TEMPORARY conversation in strict FK order.
 * Enqueues conversation:expired with conversation_id = NULL BEFORE deleting child rows.
 */
async function hardDeleteTemporaryConversation(tx, conversationId, { ownerKey, reason, notice }) {
  const cid = Number(conversationId);

  // Emit expiration socket event with conversation_id = NULL so it is NOT deleted below and still reaches the guest socket!
  await enqueueOutbox(tx, {
    kind: "SOCKET_EVENT",
    conversationId: null,
    eventName: "conversation:expired",
    payload: {
      conversationId: cid,
      ownerKey,
      reason,
      notice,
      erased: true,
    },
  });

  await newRequest(tx)
    .input("cid", sqlObj.BigInt, cid)
    .query(`
      UPDATE dbo.chat_messages SET ai_run_id = NULL, reply_to_message_id = NULL WHERE conversation_id = @cid;
      UPDATE dbo.chat_conversations SET current_handoff_id = NULL WHERE id = @cid;
      UPDATE dbo.chat_conversations SET source_conversation_id = NULL WHERE source_conversation_id = @cid;

      DELETE FROM dbo.chat_ai_runs WHERE conversation_id = @cid;
      DELETE FROM dbo.chat_messages WHERE conversation_id = @cid;
      DELETE FROM dbo.chat_handoff_sessions WHERE conversation_id = @cid;
      DELETE FROM dbo.chat_events WHERE conversation_id = @cid;
      DELETE FROM dbo.chat_outbox WHERE conversation_id = @cid;
      DELETE FROM dbo.chat_participants WHERE conversation_id = @cid;
      DELETE FROM dbo.chat_conversations
      WHERE id = @cid
        AND retention_state = 'TEMPORARY'
        AND customer_user_id IS NULL;
    `);
}

/**
 * Background worker sweeping the 3 expiry conditions in priority order:
 * 1) WAITING_HUMAN manager_wait_expires_at <= now (5 min timeout -> report + Admin alert + cleanup)
 * 2) TEMPORARY AI idle guest_ai_close_at <= now (3 min timeout -> immediate delete)
 * 3) TEMPORARY abandoned/cancelled temporary_cleanup_at <= now (5 min safety -> immediate delete)
 */
async function processExpiryBatch() {
  const pool = getDBPool();

  // 1) 5-minute manager wait timeout (both Guest TEMPORARY and Customer PERSISTENT)
  const missedRes = await pool.request().query(`
    SELECT TOP 20 id
    FROM dbo.chat_conversations
    WHERE status = 'OPEN'
      AND handling_mode = 'WAITING_HUMAN'
      AND manager_wait_expires_at IS NOT NULL
      AND manager_wait_expires_at <= SYSUTCDATETIME()
    ORDER BY manager_wait_expires_at ASC;
  `);

  for (const row of missedRes.recordset) {
    const cid = Number(row.id);
    try {
      await withTransaction(async (tx) => {
        await lockConversationsInOrder(tx, [cid]);
        const curRes = await newRequest(tx)
          .input("cid", sqlObj.BigInt, cid)
          .query(`
            SELECT
              c.id,
              c.customer_user_id AS customerUserId,
              c.guest_session_id AS guestSessionId,
              c.accommodation_id AS accommodationId,
              c.current_handoff_id AS currentHandoffId,
              c.manager_assignment_epoch_id AS managerAssignmentEpochId,
              c.retention_state AS retentionState,
              c.handling_mode AS handlingMode,
              c.status,
              c.manager_wait_expires_at AS managerWaitExpiresAt,
              a.accommodation_name AS accommodationName,
              a.phone AS accommodationPhone,
              a.email AS accommodationEmail,
              a.website_url AS accommodationWebsite,
              a.address_line AS accommodationAddress,
              h.target_manager_user_id AS targetManagerUserId,
              h.requester_type AS requesterType,
              h.requested_at AS requestedAt,
              u.full_name AS managerName
            FROM dbo.chat_conversations AS c
            LEFT JOIN dbo.accommodations AS a ON a.id = c.accommodation_id
            LEFT JOIN dbo.chat_handoff_sessions AS h ON h.id = c.current_handoff_id
            LEFT JOIN dbo.users AS u ON u.id = h.target_manager_user_id
            WHERE c.id = @cid;
          `);

        const conv = curRes.recordset[0];
        if (
          !conv ||
          conv.status !== "OPEN" ||
          conv.handlingMode !== "WAITING_HUMAN" ||
          !conv.managerWaitExpiresAt ||
          new Date(conv.managerWaitExpiresAt).getTime() > Date.now()
        ) {
          return;
        }

        const ownerKey = conv.customerUserId
          ? actorKeyForUser(conv.customerUserId)
          : actorKeyForGuest(conv.guestSessionId);
        const targetManagerId = conv.targetManagerUserId || null;

        // Mark handoff session as MISSED
        if (conv.currentHandoffId) {
          await newRequest(tx)
            .input("hid", sqlObj.BigInt, conv.currentHandoffId)
            .query(`
              UPDATE dbo.chat_handoff_sessions
              SET status = 'MISSED',
                  ended_at = SYSUTCDATETIME(),
                  ended_reason = 'MANAGER_WAIT_TIMEOUT'
              WHERE id = @hid AND status IN ('PENDING', 'CLAIMED');
            `);
        }

        // Insert independent report for Admin (NO blocking FK)
        const reportRes = await newRequest(tx)
          .input("hid", sqlObj.BigInt, conv.currentHandoffId || null)
          .input("cid", sqlObj.BigInt, cid)
          .input("accomId", sqlObj.Int, conv.accommodationId)
          .input("accomName", sqlObj.NVarChar(255), conv.accommodationName || `Cơ sở #${conv.accommodationId}`)
          .input("mgrId", sqlObj.UniqueIdentifier, targetManagerId)
          .input("mgrName", sqlObj.NVarChar(255), conv.managerName || null)
          .input("epochId", sqlObj.BigInt, conv.managerAssignmentEpochId || null)
          .input("reqType", sqlObj.VarChar(16), conv.requesterType || (conv.customerUserId ? "CUSTOMER" : "GUEST"))
          .input("requestedAt", sqlObj.DateTime2(3), conv.requestedAt ? new Date(conv.requestedAt) : new Date())
          .input("expiredAt", sqlObj.DateTime2(3), new Date(conv.managerWaitExpiresAt))
          .input("timeoutSec", sqlObj.Int, config.claimTimeoutSeconds)
          .query(`
            INSERT INTO dbo.chat_missed_handoff_reports (
              handoff_id, conversation_id, accommodation_id, accommodation_name_snapshot,
              manager_user_id, manager_name_snapshot, manager_assignment_epoch_id,
              requester_type, requested_at, expired_at, timeout_seconds
            )
            OUTPUT INSERTED.id, INSERTED.created_at AS createdAt
            VALUES (
              @hid, @cid, @accomId, @accomName,
              @mgrId, @mgrName, @epochId,
              @reqType, @requestedAt, @expiredAt, @timeoutSec
            );
          `);

        const reportRow = reportRes.recordset[0];

        // Emit Admin alert & Manager missed notification with conversation_id = NULL so Guest delete preserves them!
        await enqueueOutbox(tx, {
          kind: "SOCKET_EVENT",
          conversationId: null,
          eventName: "admin:missed-handoff-alert",
          payload: {
            reportId: Number(reportRow.id),
            accommodationId: Number(conv.accommodationId),
            accommodationName: conv.accommodationName,
            managerUserId: targetManagerId ? String(targetManagerId) : null,
            managerName: conv.managerName || null,
            requesterType: conv.requesterType || (conv.customerUserId ? "CUSTOMER" : "GUEST"),
            requestedAt: conv.requestedAt ? new Date(conv.requestedAt).toISOString() : null,
            expiredAt: new Date(conv.managerWaitExpiresAt).toISOString(),
            timeoutSeconds: config.claimTimeoutSeconds,
            createdAt: new Date(reportRow.createdAt).toISOString(),
          },
        });

        await enqueueOutbox(tx, {
          kind: "SOCKET_EVENT",
          conversationId: null,
          eventName: "handoff:missed",
          payload: {
            conversationId: cid,
            accommodationId: Number(conv.accommodationId),
            accommodationName: conv.accommodationName,
            managerUserId: targetManagerId ? String(targetManagerId) : null,
            ownerKey,
            reason: "MANAGER_WAIT_TIMEOUT",
          },
        });

        await enqueueOutbox(tx, {
          kind: "SOCKET_EVENT",
          conversationId: null,
          eventName: "queue:updated",
          payload: {
            accommodationId: Number(conv.accommodationId),
            managerUserId: targetManagerId ? String(targetManagerId) : null,
            conversationId: cid,
            action: "MISSED",
          },
        });

        const contactLines = [
          conv.accommodationPhone ? `• SĐT: ${conv.accommodationPhone}` : null,
          conv.accommodationEmail ? `• Email: ${conv.accommodationEmail}` : null,
          conv.accommodationAddress ? `• Địa chỉ: ${conv.accommodationAddress}` : null,
        ].filter(Boolean);

        if (conv.retentionState === "TEMPORARY" && !conv.customerUserId) {
          const notice = `Rất tiếc, đã quá 5 phút nhưng Quản lý ${conv.accommodationName || "cơ sở"} chưa kịp tiếp nhận yêu cầu. Phiên chat tạm đã tự động kết thúc. Quý khách có thể liên hệ trực tiếp${contactLines.length ? `:\n${contactLines.join("\n")}` : " qua SĐT của cơ sở"} hoặc mở chat mới với Trợ lý AI.`;
          await hardDeleteTemporaryConversation(tx, cid, {
            ownerKey,
            reason: "MANAGER_WAIT_TIMEOUT",
            notice,
          });
        } else {
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

          const msgText = `Hiện đã quá 5 phút chờ nhưng Quản lý ${conv.accommodationName || "cơ sở"} chưa kịp tiếp nhận. Yêu cầu kết nối đã tự động hủy và được ghi nhận báo cáo tới Ban quản trị.\n\nTrợ lý AI VietPeace Stay vẫn tiếp tục hỗ trợ bạn tại đây, hoặc bạn có thể liên hệ trực tiếp cơ sở${contactLines.length ? `:\n${contactLines.join("\n")}` : "."}`;
          const sysMsg = await appendSystemMessage(tx, cid, msgText, {
            handoffId: conv.currentHandoffId,
          });

          await enqueueOutbox(tx, {
            kind: "SOCKET_EVENT",
            conversationId: cid,
            eventName: "message:created",
            payload: { conversationId: cid, message: sysMsg, visibility: "PUBLIC" },
          });

          await enqueueOutbox(tx, {
            kind: "SOCKET_EVENT",
            conversationId: cid,
            eventName: "conversation:updated",
            payload: {
              conversationId: cid,
              handlingMode: "AI",
              assignedUserId: null,
              currentHandoffId: null,
              managerWaitExpiresAt: null,
            },
          });
        }
      });
    } catch (err) {
      console.error("[chat.lifecycle.missedHandoff]", cid, err);
    }
  }

  // 2) Guest TEMPORARY 3-minute AI timeout & 5-minute temporary cleanup
  const guestExpRes = await pool.request().query(`
    SELECT TOP 30
      id,
      guest_session_id AS guestSessionId,
      guest_ai_close_at AS guestAiCloseAt,
      temporary_cleanup_at AS temporaryCleanupAt
    FROM dbo.chat_conversations
    WHERE status = 'OPEN'
      AND retention_state = 'TEMPORARY'
      AND customer_user_id IS NULL
      AND (
        (handling_mode = 'AI' AND guest_ai_close_at IS NOT NULL AND guest_ai_close_at <= SYSUTCDATETIME())
        OR (temporary_cleanup_at IS NOT NULL AND temporary_cleanup_at <= SYSUTCDATETIME())
      )
    ORDER BY COALESCE(guest_ai_close_at, temporary_cleanup_at) ASC;
  `);

  for (const row of guestExpRes.recordset) {
    const cid = Number(row.id);
    try {
      await withTransaction(async (tx) => {
        await lockConversationsInOrder(tx, [cid]);
        const cur = await newRequest(tx)
          .input("cid", sqlObj.BigInt, cid)
          .query(`
            SELECT id, status, retention_state AS retentionState, customer_user_id AS customerUserId,
                   guest_session_id AS guestSessionId, handling_mode AS handlingMode,
                   guest_ai_close_at AS guestAiCloseAt, temporary_cleanup_at AS temporaryCleanupAt
            FROM dbo.chat_conversations
            WHERE id = @cid;
          `);
        const conv = cur.recordset[0];
        if (!conv || conv.status !== "OPEN" || conv.retentionState !== "TEMPORARY" || conv.customerUserId) {
          return;
        }
        const nowMs = Date.now();
        const aiDue = conv.handlingMode === "AI" && conv.guestAiCloseAt && new Date(conv.guestAiCloseAt).getTime() <= nowMs;
        const tempDue = conv.temporaryCleanupAt && new Date(conv.temporaryCleanupAt).getTime() <= nowMs;
        if (!aiDue && !tempDue) return;

        const ownerKey = actorKeyForGuest(conv.guestSessionId);
        const reason = aiDue ? "GUEST_AI_TIMEOUT" : "GUEST_TEMP_EXPIRED";
        const notice = aiDue
          ? "Phiên tư vấn AI tạm thời đã tự động kết thúc sau 3 phút không có tin nhắn mới."
          : "Phiên trò chuyện tạm đã tự động kết thúc và được dọn sạch.";

        await hardDeleteTemporaryConversation(tx, cid, { ownerKey, reason, notice });
      });
    } catch (err) {
      console.error("[chat.lifecycle.guestTempExpiry]", cid, err);
    }
  }
}

async function runHousekeepingCleanup() {
  const pool = getDBPool();
  await pool.request().query(`
    DELETE FROM dbo.chat_outbox
    WHERE status IN ('SENT', 'DEAD')
      AND processed_at < DATEADD(hour, -24, SYSUTCDATETIME());

    DELETE FROM dbo.chat_socket_tickets
    WHERE expires_at < DATEADD(hour, -1, SYSUTCDATETIME());

    DELETE FROM dbo.chat_http_sessions
    WHERE expires_at < SYSUTCDATETIME();

    DELETE gs
    FROM dbo.chat_guest_sessions AS gs
    WHERE (gs.expires_at < SYSUTCDATETIME() OR gs.revoked_at < DATEADD(hour, -1, SYSUTCDATETIME()))
      AND NOT EXISTS (SELECT 1 FROM dbo.chat_conversations c WHERE c.guest_session_id = gs.id)
      AND NOT EXISTS (SELECT 1 FROM dbo.chat_participants p WHERE p.guest_session_id = gs.id)
      AND NOT EXISTS (SELECT 1 FROM dbo.chat_messages m WHERE m.sender_guest_session_id = gs.id)
      AND NOT EXISTS (SELECT 1 FROM dbo.chat_socket_tickets t WHERE t.guest_session_id = gs.id);
  `);
}

module.exports = {
  appendSystemMessage,
  syncManagerEpochInTransaction,
  hardDeleteTemporaryConversation,
  processExpiryBatch,
  runHousekeepingCleanup,
};

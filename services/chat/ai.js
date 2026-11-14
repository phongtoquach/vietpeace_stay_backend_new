const config = require("../../configs/chat");
const { getDBPool, sqlObj } = require("../../configs/database");
const {
  withTransaction,
  newRequest,
  lockConversationsInOrder,
  enqueueOutbox,
  parseJsonSafe,
  previewText,
} = require("./db");
const { TOOL_DECLARATIONS, executeTool } = require("./tools");
const provider = require("./provider");
const { todayInVietnam } = require("../room_recommendation_service");

function buildSystemPrompt({ conv, pageContext, actor, today }) {
  const ctxLines = [];
  if (pageContext?.pageType === "ACCOMMODATION_DETAIL" && pageContext.accommodationId) {
    ctxLines.push(
      `CURRENT_VIEWING_PROPERTY: Khách đang xem trang chi tiết cơ sở lưu trú ID=${pageContext.accommodationId}` +
        `${pageContext.accommodationName ? ` (${pageContext.accommodationName})` : ""}` +
        `${pageContext.locationName ? ` tại ${pageContext.locationName}` : ""}.`,
    );
  } else if (pageContext?.pageType === "LOCATION_SEARCH" && pageContext.locationId) {
    ctxLines.push(
      `CURRENT_VIEWING_LOCATION: Khách đang xem danh sách cơ sở tại điểm đến ID=${pageContext.locationId}` +
        `${pageContext.locationName ? ` (${pageContext.locationName})` : ""}. Nếu khách hỏi tìm phòng/khách sạn không nêu tên tỉnh khác, mặc định hiểu đang hỏi trong khu vực này.`,
    );
  } else if (pageContext?.pageType === "BOOKING_DETAIL" && pageContext.bookingId) {
    ctxLines.push(`CURRENT_VIEWING_BOOKING: Khách đang mở trang chi tiết đơn bookingId=${pageContext.bookingId}.`);
  } else {
    ctxLines.push(`CURRENT_VIEWING_PAGE: Khách đang ở trang ${pageContext?.pageType || "HOME"}.`);
  }

  if (conv.scopeType === "PROPERTY" && conv.accommodationId) {
    ctxLines.push(
      `CONVERSATION_PROPERTY_SCOPE: Hội thoại đang gắn chặt với cơ sở ID=${conv.accommodationId}` +
        `${conv.accommodationName ? ` (${conv.accommodationName})` : ""}. Câu hỏi ngắn như "Còn phòng không?", "Cho mang thú cưng không?", "Mấy giờ check-in?" mặc định hỏi về cơ sở này.`,
    );
  }

  if (pageContext?.checkin && pageContext?.checkout) {
    ctxLines.push(
      `URL_DATES: checkin=${pageContext.checkin}, checkout=${pageContext.checkout}` +
        `${pageContext.rooms ? `, rooms=${pageContext.rooms}` : ""}` +
        `${pageContext.adults ? `, adults=${pageContext.adults}` : ""}` +
        `${pageContext.children !== undefined ? `, children=${pageContext.children}` : ""}.`,
    );
  }

  const actorLine =
    actor.type === "CUSTOMER"
      ? `ACTOR: Khách hàng đã đăng nhập (${actor.displayName}). Có thể dùng get_my_booking / list_my_bookings.`
      : `ACTOR: Khách vãng lai (Guest chưa đăng nhập). Không tra được booking cá nhân nếu chưa đăng nhập.`;

  return `Bạn là Trợ lý ảo chính thức của VietPeace Stay — hệ thống đặt phòng lưu trú tại Việt Nam.
Ngày hiện tại (giờ Việt Nam): ${today}.

NGUYÊN TẮC CỐT LÕI (BẮT BUỘC TUÂN THỦ):
1. Xưng hô lịch sự ("Dạ", "Quý khách", "mình"), trả lời rõ ràng, ngắn gọn, có cấu trúc dễ đọc bằng tiếng Việt.
2. Chỉ sử dụng số liệu, giá tiền, chính sách, giờ nhận/trả phòng, tiện ích và tồn kho thực tế từ kết quả các tool được cung cấp. Tuyệt đối KHÔNG bịa đặt giá, khuyến mãi hay tên cơ sở.
3. Khi báo giá hoặc tư vấn phòng cho ngày cụ thể, LUÔN gọi \`get_room_recommendations\` để trả tổng tiền khớp 100% với checkout (gồm phụ thu nếu có, không tự chế mã giảm giá).
4. Tuyệt đối KHÔNG tự ý đề xuất chuyển sang Quản lý hay nhân viên trong câu trả lời của bạn. Bạn cũng KHÔNG có công cụ chuyển người.
5. Nếu câu hỏi vượt thẩm quyền tự động (vd: xin nhận phòng sớm/trả phòng muộn miễn phí, thương lượng giảm giá/phụ thu, hủy đơn hoàn tiền ngoại lệ) hoặc trường dữ liệu chưa được cập nhật trên DB: hãy gọi \`get_accommodation_info\` (nếu đã biết cơ sở), trả lời trung thực theo dữ liệu hiện có trong DB và cung cấp **thông tin liên hệ trực tiếp của cơ sở** (\`phone\`, \`email\`, \`website_url\`, \`address_line\`) để Quý khách liên hệ trực tiếp.
6. Bảo vệ dữ liệu riêng tư: Không bao giờ tiết lộ booking của người khác.

NGỮ CẢNH PHIÊN HIỆN TẠI:
${actorLine}
${ctxLines.join("\n")}`;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms (${label})`)), ms),
    ),
  ]);
}

async function isAiTurnStillValid(conversationId, expectedRevision, expectedRunId) {
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("cid", sqlObj.BigInt, conversationId)
    .input("runId", sqlObj.BigInt, expectedRunId)
    .query(`
      SELECT
        c.status,
        c.handling_mode AS handlingMode,
        c.control_revision AS controlRevision,
        r.status AS runStatus
      FROM dbo.chat_conversations AS c
      INNER JOIN dbo.chat_ai_runs AS r ON r.conversation_id = c.id AND r.id = @runId
      WHERE c.id = @cid;
    `);
  const row = res.recordset[0];
  if (!row) return false;
  return (
    row.status === "OPEN" &&
    row.handlingMode === "AI" &&
    Number(row.controlRevision) === Number(expectedRevision) &&
    row.runStatus === "RUNNING"
  );
}

/**
 * Executed by outbox/AI scheduler when `ai_due_at <= now`.
 * Respects trailing-edge debounce: if `ai_due_at > now`, reschedules instead of running prematurely.
 */
async function executeAiJob(conversationId, runtime) {
  const pool = getDBPool();
  const cid = Number(conversationId);

  // Atomically check readiness & claim active AI run
  const claimed = await withTransaction(async (tx) => {
    await lockConversationsInOrder(tx, [cid]);

    const res = await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .query(`
        SELECT TOP 1
          c.id,
          c.customer_user_id AS customerUserId,
          c.guest_session_id AS guestSessionId,
          c.scope_type AS scopeType,
          c.accommodation_id AS accommodationId,
          c.booking_id AS bookingId,
          c.status,
          c.handling_mode AS handlingMode,
          c.control_revision AS controlRevision,
          c.last_sequence AS lastSequence,
          c.ai_due_at AS aiDueAt,
          c.context_json AS contextJson,
          c.retention_state AS retentionState,
          a.accommodation_name AS accommodationName,
          u.full_name AS customerFullName,
          u.display_name AS customerDisplayName
        FROM dbo.chat_conversations AS c
        LEFT JOIN dbo.accommodations AS a ON a.id = c.accommodation_id
        LEFT JOIN dbo.users AS u ON u.id = c.customer_user_id
        WHERE c.id = @cid;
      `);

    const conv = res.recordset[0];
    if (!conv) return { action: "SKIP" };
    if (conv.status !== "OPEN" || conv.handlingMode !== "AI") return { action: "SKIP" };
    if (!conv.aiDueAt) return { action: "SKIP" };
    if (!config.aiEnabled()) return { action: "DISABLED", conv };

    const dueMs = new Date(conv.aiDueAt).getTime();
    const nowMs = Date.now();
    if (dueMs > nowMs + 25) {
      // Trailing debounce pushed deadline forward -> re-enqueue AI_SCHEDULE
      await enqueueOutbox(tx, {
        kind: "AI_SCHEDULE",
        conversationId: cid,
        eventName: "ai:schedule",
        payload: { conversationId: cid, controlRevision: Number(conv.controlRevision) },
        availableAt: new Date(dueMs),
      });
      return { action: "DEFERRED" };
    }

    // Cancel any stale QUEUED/RUNNING runs before starting fresh
    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .query(`
        UPDATE dbo.chat_ai_runs
        SET status = 'CANCELLED', completed_at = SYSUTCDATETIME()
        WHERE conversation_id = @cid AND status IN ('QUEUED', 'RUNNING');
      `);

    const runRes = await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("triggerSeq", sqlObj.BigInt, Number(conv.lastSequence))
      .input("rev", sqlObj.BigInt, Number(conv.controlRevision))
      .input("model", sqlObj.VarChar(100), config.model)
      .query(`
        INSERT INTO dbo.chat_ai_runs (
          conversation_id, trigger_sequence, control_revision, status, model, started_at
        )
        OUTPUT INSERTED.id
        VALUES (@cid, @triggerSeq, @rev, 'RUNNING', @model, SYSUTCDATETIME());

        UPDATE dbo.chat_conversations
        SET ai_due_at = NULL, updated_at = SYSUTCDATETIME()
        WHERE id = @cid;
      `);

    const runId = Number(runRes.recordset[0].id);
    return { action: "RUN", conv, runId };
  });

  if (!claimed || claimed.action === "SKIP" || claimed.action === "DEFERRED") return;

  if (claimed.action === "DISABLED") {
    runtime?.emitToConversation(cid, "ai:failed", {
      conversationId: cid,
      errorCode: "AI_DISABLED",
      message: "Trợ lý AI hiện đang tạm tắt bởi quản trị viên.",
    });
    return;
  }

  const { conv, runId } = claimed;
  const ownerKey = conv.customerUserId
    ? `user:${String(conv.customerUserId).toLowerCase()}`
    : `guest:${String(conv.guestSessionId).toLowerCase()}`;

  const actor = conv.customerUserId
    ? {
        type: "CUSTOMER",
        userId: String(conv.customerUserId),
        actorKey: ownerKey,
        displayName: conv.customerDisplayName || conv.customerFullName || "Quý khách",
      }
    : {
        type: "GUEST",
        guestSessionId: String(conv.guestSessionId),
        actorKey: ownerKey,
        displayName: "Quý khách",
      };

  const contextObj = parseJsonSafe(conv.contextJson, {}) || {};
  const pageContext = contextObj.pageContext || {};

  // Check per-accommodation/platform support settings for ai_enabled
  const settingsRes = await pool
    .request()
    .input("accomId", sqlObj.Int, conv.accommodationId || null)
    .query(`
      SELECT TOP 1 ai_enabled AS aiEnabled
      FROM dbo.chat_support_settings
      WHERE accommodation_id = @accomId OR accommodation_id IS NULL
      ORDER BY CASE WHEN accommodation_id = @accomId THEN 0 ELSE 1 END;
    `);
  if (settingsRes.recordset[0] && !settingsRes.recordset[0].aiEnabled) {
    await pool
      .request()
      .input("runId", sqlObj.BigInt, runId)
      .query(`UPDATE dbo.chat_ai_runs SET status = 'CANCELLED', completed_at = SYSUTCDATETIME() WHERE id = @runId;`);
    runtime?.emitToConversation(cid, "ai:failed", {
      conversationId: cid,
      runId,
      errorCode: "AI_DISABLED_FOR_PROPERTY",
      message: "Trợ lý AI tại cơ sở này hiện đang tạm tắt.",
    });
    return;
  }

  // Load latest 24 visible conversation messages (PUBLIC + owner's OWNER_ONLY, excluding STAFF/SYSTEM noise where appropriate)
  const histRes = await pool
    .request()
    .input("cid", sqlObj.BigInt, cid)
    .query(`
      SELECT TOP 24
        sender_type AS senderType,
        message_type AS messageType,
        visibility,
        content,
        payload_json AS payloadJson,
        sequence
      FROM dbo.chat_messages
      WHERE conversation_id = @cid
        AND visibility IN ('PUBLIC', 'OWNER_ONLY')
        AND message_type NOT IN ('INTERNAL_NOTE', 'AI_DRAFT')
      ORDER BY sequence DESC;
    `);

  const chronological = [...histRes.recordset].reverse();
  const contents = [];
  for (const m of chronological) {
    if (m.senderType === "GUEST" || m.senderType === "CUSTOMER") {
      contents.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.senderType === "AI") {
      contents.push({ role: "model", parts: [{ text: m.content }] });
    } else if (m.senderType === "SYSTEM" && m.messageType === "PROPERTY_CARD") {
      const p = parseJsonSafe(m.payloadJson, {});
      if (p?.accommodationName) {
        contents.push({
          role: "user",
          parts: [{ text: `[Ngữ cảnh đính kèm: Cơ sở ${p.accommodationName} (ID ${p.accommodationId})]` }],
        });
      }
    }
  }
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: "Xin chào" }] });
  }

  const abortController = new AbortController();
  const deadlineTimer = setTimeout(() => abortController.abort(), config.aiTimeoutMs);

  const systemPrompt = buildSystemPrompt({
    conv: {
      ...conv,
      scopeType: conv.scopeType,
      accommodationId: conv.accommodationId ? Number(conv.accommodationId) : null,
    },
    pageContext,
    actor,
    today: todayInVietnam(),
  });

  const runContext = {
    actor,
    conversationId: cid,
    cardsToEmit: [],
    hasPrivateBookingRead: false,
  };

  runtime?.emitToConversation(cid, "ai:started", { conversationId: cid, runId });

  let deltaBuffer = "";
  let flushTimer = null;
  let totalStreamedText = "";
  let totalToolCalls = 0;

  async function flushDeltas(force = false) {
    if (!deltaBuffer) return;
    const chunk = deltaBuffer;
    deltaBuffer = "";
    runtime?.emitToConversation(cid, "ai:delta", { conversationId: cid, runId, delta: chunk });
    if (force && flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  try {
    let finalAnswerText = "";
    let lastUsage = null;
    const workingContents = [...contents];

    for (let round = 0; round < 4; round++) {
      const valid = await isAiTurnStillValid(cid, conv.controlRevision, runId);
      if (!valid) {
        await abortController.abort();
        runtime?.emitToConversation(cid, "ai:cancelled", { conversationId: cid, runId });
        return;
      }

      const genRes = await provider.generate({
        contents: workingContents,
        system: systemPrompt,
        tools: TOOL_DECLARATIONS,
        signal: abortController.signal,
        onDelta: async (piece) => {
          totalStreamedText += piece;
          deltaBuffer += piece;
          if (!flushTimer) {
            flushTimer = setTimeout(() => {
              flushTimer = null;
              flushDeltas(false);
            }, 80);
          }
        },
      });

      await flushDeltas(true);
      lastUsage = genRes.usage || lastUsage;

      if (genRes.calls.length === 0) {
        finalAnswerText = genRes.text || totalStreamedText;
        break;
      }

      workingContents.push(genRes.content);

      const roundCalls = genRes.calls.slice(0, 8);
      const responseParts = [];

      for (const call of roundCalls) {
        if (totalToolCalls >= 12) break;
        totalToolCalls += 1;
        let toolOutput;
        try {
          toolOutput = await withTimeout(
            executeTool(call.name, call.args || {}, runContext),
            config.toolTimeoutMs,
            call.name,
          );
        } catch (toolErr) {
          toolOutput = { status: "TOOL_ERROR", message: toolErr?.message || "Lỗi truy vấn dữ liệu." };
        }
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { result: toolOutput },
          },
        });
      }

      workingContents.push({ role: "user", parts: responseParts });

      if (round === 3) {
        const finalGen = await provider.generate({
          contents: workingContents,
          system: systemPrompt,
          tools: [],
          signal: abortController.signal,
          onDelta: async (piece) => {
            totalStreamedText += piece;
            deltaBuffer += piece;
          },
        });
        await flushDeltas(true);
        finalAnswerText = finalGen.text || totalStreamedText;
      }
    }

    if (!finalAnswerText.trim()) {
      finalAnswerText = "Dạ, mình đã kiểm tra dữ liệu hệ thống. Quý khách cần hỗ trợ thêm thông tin nào về phòng trống hoặc chính sách cơ sở ạ?";
    }

    const visibility = runContext.hasPrivateBookingRead ? "OWNER_ONLY" : "PUBLIC";

    // Persist AI message & optional cards atomically, verifying control_revision didn't change!
    const saved = await withTransaction(async (tx) => {
      await lockConversationsInOrder(tx, [cid]);

      const checkRes = await newRequest(tx)
        .input("cid", sqlObj.BigInt, cid)
        .query(`
          SELECT status, handling_mode AS handlingMode, control_revision AS controlRevision,
                 retention_state AS retentionState, customer_user_id AS customerUserId
          FROM dbo.chat_conversations
          WHERE id = @cid;
        `);
      const latest = checkRes.recordset[0];
      if (
        !latest ||
        latest.status !== "OPEN" ||
        latest.handlingMode !== "AI" ||
        Number(latest.controlRevision) !== Number(conv.controlRevision)
      ) {
        await newRequest(tx)
          .input("runId", sqlObj.BigInt, runId)
          .query(`UPDATE dbo.chat_ai_runs SET status = 'CANCELLED', completed_at = SYSUTCDATETIME() WHERE id = @runId;`);
        return { cancelled: true };
      }

      await newRequest(tx)
        .input("runId", sqlObj.BigInt, runId)
        .input("usageJson", sqlObj.NVarChar(sqlObj.MAX), lastUsage ? JSON.stringify(lastUsage) : null)
        .query(`
          UPDATE dbo.chat_ai_runs
          SET status = 'COMPLETED', usage_json = @usageJson, completed_at = SYSUTCDATETIME()
          WHERE id = @runId;
        `);

      const createdMessages = [];

      // Insert main AI text response
      async function insertAiMsg(messageType, msgVisibility, textContent, payload = null) {
        const seqRes = await newRequest(tx)
          .input("cid", sqlObj.BigInt, cid)
          .input("preview", sqlObj.NVarChar(300), previewText(textContent))
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
        const ins = await newRequest(tx)
          .input("cid", sqlObj.BigInt, cid)
          .input("seq", sqlObj.BigInt, seq)
          .input("mtype", sqlObj.VarChar(32), messageType)
          .input("vis", sqlObj.VarChar(16), msgVisibility)
          .input("content", sqlObj.NVarChar(sqlObj.MAX), textContent)
          .input("payloadJson", sqlObj.NVarChar(sqlObj.MAX), payload ? JSON.stringify(payload) : null)
          .input("runId", sqlObj.BigInt, runId)
          .query(`
            INSERT INTO dbo.chat_messages (
              conversation_id, sequence, sender_actor_key, sender_type,
              message_type, visibility, content, payload_json, ai_run_id
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
              INSERTED.ai_run_id AS aiRunId,
              INSERTED.created_at AS createdAt
            VALUES (
              @cid, @seq, 'ai:vietpeace', 'AI',
              @mtype, @vis, @content, @payloadJson, @runId
            );
          `);
        const row = ins.recordset[0];
        return {
          ...row,
          id: Number(row.id),
          conversationId: Number(row.conversationId),
          sequence: Number(row.sequence),
          aiRunId: Number(row.aiRunId),
          payload,
          createdAt: new Date(row.createdAt).toISOString(),
        };
      }

      const mainMsg = await insertAiMsg("TEXT", visibility, finalAnswerText, null);
      createdMessages.push(mainMsg);

      for (const card of runContext.cardsToEmit) {
        const cardTitle = card.payload?.title || card.payload?.accommodation?.accommodationName || "Thông tin chi tiết";
        const cardMsg = await insertAiMsg(card.messageType, card.visibility || visibility, cardTitle, card.payload);
        createdMessages.push(cardMsg);
      }

      // Guest TEMPORARY: arm 3-minute AI inactivity close timer & clear temporary_cleanup_at
      let guestAiCloseAtIso = null;
      if (latest.retentionState === "TEMPORARY" && !latest.customerUserId && latest.handlingMode === "AI") {
        const closeRes = await newRequest(tx)
          .input("cid", sqlObj.BigInt, cid)
          .input("sec", sqlObj.Int, config.guestAiCloseSeconds)
          .query(`
            UPDATE dbo.chat_conversations
            SET guest_ai_close_at = DATEADD(second, @sec, SYSUTCDATETIME()),
                temporary_cleanup_at = NULL
            OUTPUT INSERTED.guest_ai_close_at AS closeAt
            WHERE id = @cid;
          `);
        guestAiCloseAtIso = closeRes.recordset[0]?.closeAt
          ? new Date(closeRes.recordset[0].closeAt).toISOString()
          : null;
      }

      for (const msg of createdMessages) {
        await enqueueOutbox(tx, {
          kind: "SOCKET_EVENT",
          conversationId: cid,
          eventName: "message:created",
          payload: { conversationId: cid, ownerKey, message: msg, visibility: msg.visibility },
        });
      }

      await enqueueOutbox(tx, {
        kind: "SOCKET_EVENT",
        conversationId: cid,
        eventName: "ai:completed",
        payload: {
          conversationId: cid,
          runId,
          ownerKey,
          guestAiCloseAt: guestAiCloseAtIso,
          messages: createdMessages,
        },
      });

      return { cancelled: false, guestAiCloseAtIso, createdMessages };
    });

    if (saved?.cancelled) {
      runtime?.emitToConversation(cid, "ai:cancelled", { conversationId: cid, runId });
    } else {
      runtime?.triggerOutboxDrain?.();
    }
  } catch (err) {
    if (flushTimer) clearTimeout(flushTimer);
    console.error("[chat.ai.execute]", cid, err);

    await pool
      .request()
      .input("runId", sqlObj.BigInt, runId)
      .input("errCode", sqlObj.VarChar(80), err?.errorCode || "AI_FAILED")
      .input("errMsg", sqlObj.NVarChar(500), String(err?.message || "AI execution failed").slice(0, 480))
      .query(`
        UPDATE dbo.chat_ai_runs
        SET status = 'FAILED', error_code = @errCode, error_message = @errMsg, completed_at = SYSUTCDATETIME()
        WHERE id = @runId;
      `);

    // NO auto-escalation to Manager on AI failure! Keep mode = 'AI' cleanly.
    runtime?.emitToConversation(cid, "ai:failed", {
      conversationId: cid,
      runId,
      errorCode: err?.errorCode || "AI_FAILED",
      message: "Trợ lý AI tạm thời gián đoạn phản hồi. Quý khách vui lòng gửi lại câu hỏi hoặc bấm kết nối Quản lý nếu muốn trao đổi trực tiếp.",
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
}

module.exports = {
  executeAiJob,
};

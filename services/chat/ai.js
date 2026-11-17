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

function mergeDiscussedContext(prevCtx, runContext) {
  const safePrev = prevCtx && typeof prevCtx === "object" ? prevCtx : {};
  const newProps = Array.isArray(runContext?.discussedAccommodations) ? runContext.discussedAccommodations : [];
  const lastSearchLoc = runContext?.lastSearchLocation || null;

  if (newProps.length === 0 && !lastSearchLoc) {
    return { changed: false, nextContext: safePrev };
  }

  let discussed = Array.isArray(safePrev.discussedAccommodations) ? [...safePrev.discussedAccommodations] : [];
  let activeLocation = safePrev.activeLocation || null;

  if (runContext?.hasCitySearch && lastSearchLoc?.id) {
    // Explicit location search narrows discussed list to properties in this destination
    discussed = discussed.filter((item) => Number(item.locationId) === Number(lastSearchLoc.id));
    activeLocation = { id: Number(lastSearchLoc.id), name: lastSearchLoc.name || null };
  }

  if (newProps.length > 0) {
    const seen = new Set();
    const merged = [];
    for (const item of [...newProps, ...discussed]) {
      const aid = Number(item?.accommodationId);
      if (!aid || seen.has(aid)) continue;
      seen.add(aid);
      merged.push(item);
      if (merged.length >= 5) break;
    }
    discussed = merged;
    if (newProps[0]?.locationId) {
      activeLocation = { id: Number(newProps[0].locationId), name: newProps[0].locationName || null };
    }
  } else if (lastSearchLoc?.id) {
    activeLocation = { id: Number(lastSearchLoc.id), name: lastSearchLoc.name || null };
  }

  return {
    changed: true,
    nextContext: {
      ...safePrev,
      discussedAccommodations: discussed,
      activeLocation,
    },
  };
}

// These targets come from successful database tools, never from generated prose.
function mergeNavigationLinks(previous, incoming) {
  const byUrl = new Map();
  for (const link of [...previous, ...incoming]) {
    if (typeof link?.url !== 'string') continue;
    byUrl.delete(link.url);
    byUrl.set(link.url, link);
  }
  return [...byUrl.values()].slice(-100);
}

function collectNavigationLinks(result = {}) {
  const links = [];
  const add = (url, label, kind, extra = {}) => {
    if (url && !links.some((link) => link.url === url)) links.push({ url, label, kind, ...extra });
  };
  const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
  function property(property) {
    const id = property?.accommodationId || property?.id;
    if (!positiveId(id)) return;
    const name = property.accommodationName || property.name || `#${id}`;
    add(`/accommodation-detail?accommodationId=${Number(id)}`, `Xem cơ sở ${name}`, "PROPERTY");
    const contact = property.contact || property.accommodationContact || property;
    if (typeof contact.websiteUrl === "string" && contact.websiteUrl.trim()) {
      try {
        const raw = contact.websiteUrl.trim();
        if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) throw new Error('Invalid website scheme');
        const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/\//, "")}`);
        if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
          add(url.href, `Website ${name}`, "WEBSITE");
        }
      } catch { /* No actionable link for an invalid stored website. */ }
    }
    if (typeof contact.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim())) {
      add(`mailto:${contact.email.trim()}`, contact.email.trim(), "EMAIL");
    }
    for (const label of String(contact.phone || "").split(/\s+-\s+|[;,|/]/)) {
      const number = label.replace(/[\s().-]/g, "");
      if (/^\+?\d{7,16}$/.test(number)) add(`tel:${number}`, label.trim(), "PHONE");
    }
  }
  property(result.accommodation);
  for (const item of result.items || []) property(item);
  for (const booking of [result.booking, ...(result.bookings || [])].filter(Boolean)) {
    const id = String(booking.id || "");
    if (/^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n) {
      add(`/my-account/my-bookings/booking/${id}`, `Xem đơn #${booking.bookingCode || id}`, "BOOKING", { bookingCode: booking.bookingCode });
      if (booking.checkoutInvoice?.canViewInvoice) add(`/my-account/my-bookings/booking/${id}#checkout-folio`,
        `Xem hóa đơn #${booking.bookingCode || id}`, "INVOICE", { bookingCode: booking.bookingCode });
      if (booking.status === "PENDING_PAYMENT") add(`/checkout?bookingId=${id}`, `Thanh toán đơn #${booking.bookingCode || id}`, "CHECKOUT");
    }
    property({ ...booking, id: booking.accommodationId, contact: booking.accommodationContact });
  }
  if (result.status === "READY") {
    for (const option of result.options || []) {
      const rooms = option.quote?.selectedRooms;
      if (!positiveId(result.accommodation?.id) || !rooms?.length || !result.checkinDate || !result.checkoutDate) continue;
      const quoteDraft = { accommodationId: Number(result.accommodation.id), checkinDate: result.checkinDate,
        checkoutDate: result.checkoutDate, selectedRooms: rooms.map(({ roomTypeId, adults, children }) => ({ roomTypeId, adults, children })) };
      const url = option.bookingUrl || `/accommodation-detail?accommodationId=${quoteDraft.accommodationId}&checkin=${result.checkinDate}&checkout=${result.checkoutDate}&rooms=${rooms.length}`;
      add(url, `${option.label || "Xem phòng và đặt ngay"} · ${result.accommodation.accommodationName}`, "ROOM_QUOTE", { quoteDraft });
    }
  }
  if (positiveId(result.locationId)) add(`/search-accommodations?locationId=${Number(result.locationId)}`, `Xem cơ sở tại ${result.locationName || `#${result.locationId}`}`, "LOCATION");
  return links;
}

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
7. Chỉ đưa đường dẫn do tool trả về trong navigationLinks. Sao chép nguyên URL, không tự tạo ID, tên đường dẫn hay tên miền. Dùng nhãn đi kèm URL để khách biết đúng nội dung sẽ mở. Nếu chưa có đường dẫn, gọi tool phù hợp hoặc trả lời bằng văn bản; không tạo liên kết giả. Đặt phòng theo báo giá dùng URL ROOM_QUOTE; xem đơn dùng URL BOOKING, không nhầm hai mục này.

NGỮ CẢNH PHIÊN HIỆN TẠI:
${actorLine}
${ctxLines.join("\n")}`;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms (${label})`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
async function executeAiJob(conversationId, runtime, { outboxJobId = null } = {}) {
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
    if (!conv.aiDueAt && outboxJobId) {
      // The lease can be reclaimed after a process stops mid-answer. Resume
      // only the run owned by this durable job, never a newer user turn.
      const interrupted = await newRequest(tx)
        .input("cid", sqlObj.BigInt, cid)
        .input("jobId", sqlObj.BigInt, outboxJobId)
        .query(`SELECT r.id FROM dbo.chat_ai_runs AS r
                INNER JOIN dbo.chat_outbox AS o
                  ON r.id = TRY_CAST(JSON_VALUE(o.payload_json, '$.aiRunId') AS BIGINT)
                INNER JOIN dbo.chat_conversations AS c ON c.id = r.conversation_id
                WHERE o.id = @jobId AND r.conversation_id = @cid AND r.status = 'RUNNING'
                  AND r.control_revision = c.control_revision;`);
      if (interrupted.recordset.length) conv.aiDueAt = new Date();
    }
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
    if (outboxJobId) {
      await newRequest(tx)
        .input("jobId", sqlObj.BigInt, outboxJobId)
        .input("runId", sqlObj.BigInt, runId)
        .query(`UPDATE dbo.chat_outbox SET payload_json = JSON_MODIFY(payload_json, '$.aiRunId', @runId)
                WHERE id = @jobId;`);
    }
    return { action: "RUN", conv, runId };
  });

  if (!claimed || claimed.action === "SKIP" || claimed.action === "DEFERRED") return;

  if (claimed.action === "DISABLED") {
    await runtime?.emitToConversation(cid, "ai:failed", {
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
  const abortController = new AbortController();
  const deadlineTimer = setTimeout(() => abortController.abort(), config.aiTimeoutMs);
  let deltaBuffer = "";
  let flushTimer = null;
  let totalStreamedText = "";
  let totalToolCalls = 0;
  let lastValidityCheckAt = 0;

  async function collectDelta(piece) {
    if (abortController.signal.aborted) {
      throw Object.assign(new Error("AI response timed out."), { errorCode: "AI_TIMEOUT" });
    }
    if (Date.now() - lastValidityCheckAt >= 250) {
      if (!(await isAiTurnStillValid(cid, conv.controlRevision, runId))) {
        throw Object.assign(new Error("AI turn was superseded."), { errorCode: "AI_CANCELLED" });
      }
      lastValidityCheckAt = Date.now();
    }
    totalStreamedText += piece;
    deltaBuffer += piece;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushDeltas(false).catch((err) => console.error("[chat.ai.delta]", cid, err));
      }, 80);
    }
  }

  async function flushDeltas(force = false) {
    if (force && flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!deltaBuffer) return;
    const chunk = deltaBuffer;
    deltaBuffer = "";
    await runtime?.emitToConversation(cid, "ai:delta", { conversationId: cid, runId, delta: chunk });
  }

  try {

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
      await runtime?.emitToConversation(cid, "ai:failed", {
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
      } else if (m.senderType === "MANAGER") {
        contents.push({ role: "model", parts: [{ text: `[Quản lý cơ sở đã tư vấn] ${m.content}` }] });
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
      // An answer can reuse private information from history without calling a tool again.
      hasPrivateBookingRead: chronological.some((message) => message.visibility === "OWNER_ONLY") ||
        Boolean(pageContext.pageType === 'BOOKING_DETAIL' && pageContext.bookingId),
      discussedAccommodations: [],
      lastSearchLocation: null,
      hasCitySearch: false,
      navigationLinks: [],
    };
    const contextLinks = collectNavigationLinks({ accommodation: pageContext.accommodationId
      ? { id: pageContext.accommodationId, ...pageContext } : null,
      booking: pageContext.pageType === 'BOOKING_DETAIL' && pageContext.bookingId
        ? { ...pageContext, id: pageContext.bookingId } : null });
    runContext.navigationLinks = mergeNavigationLinks(chronological.flatMap((message) => {
      const links = parseJsonSafe(message.payloadJson, {})?.navigationLinks;
      return Array.isArray(links) ? links : [];
    }), contextLinks);

    await runtime?.emitToConversation(cid, "ai:started", { conversationId: cid, runId });

    let finalAnswerText = "";
    let lastUsage = null;
    const workingContents = [...contents];

    for (let round = 0; round < 4; round++) {
      if (abortController.signal.aborted) {
        throw Object.assign(new Error("AI response timed out."), { errorCode: "AI_TIMEOUT" });
      }
      const valid = await isAiTurnStillValid(cid, conv.controlRevision, runId);
      if (!valid) {
        await abortController.abort();
        await runtime?.emitToConversation(cid, "ai:cancelled", { conversationId: cid, runId });
        return;
      }

      const genRes = await provider.generate({
        contents: workingContents,
        system: systemPrompt,
        tools: TOOL_DECLARATIONS,
        signal: abortController.signal,
        onDelta: collectDelta,
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

      for (const call of genRes.calls) {
        if (abortController.signal.aborted) {
          throw Object.assign(new Error("AI response timed out."), { errorCode: "AI_TIMEOUT" });
        }
        let toolOutput;
        if (!roundCalls.includes(call) || totalToolCalls >= 12) {
          toolOutput = { status: "TOOL_LIMIT", message: "Đã đạt giới hạn truy vấn trong lượt trả lời này." };
        } else {
          totalToolCalls += 1;
          // Discard late tool side effects after a timeout instead of mutating the live run.
          const toolContext = {
            ...runContext,
            cardsToEmit: [],
            discussedAccommodations: [...runContext.discussedAccommodations],
          };
          try {
            toolOutput = await withTimeout(
              executeTool(call.name, call.args || {}, toolContext),
              config.toolTimeoutMs,
              call.name,
            );
            runContext.cardsToEmit.push(...toolContext.cardsToEmit);
            runContext.discussedAccommodations = toolContext.discussedAccommodations;
            runContext.lastSearchLocation = toolContext.lastSearchLocation;
            runContext.hasCitySearch = toolContext.hasCitySearch;
            runContext.hasPrivateBookingRead ||= toolContext.hasPrivateBookingRead;
            const navigationLinks = collectNavigationLinks(toolOutput);
            runContext.navigationLinks = mergeNavigationLinks(runContext.navigationLinks, navigationLinks);
            toolOutput = { ...toolOutput, navigationLinks };
          } catch (toolErr) {
            toolOutput = { status: "TOOL_ERROR", message: toolErr?.message || "Lỗi truy vấn dữ liệu." };
          }
        }
        responseParts.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
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
          onDelta: collectDelta,
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
        .input("runId", sqlObj.BigInt, runId)
        .query(`
          SELECT status, handling_mode AS handlingMode, control_revision AS controlRevision,
                 retention_state AS retentionState, customer_user_id AS customerUserId,
                 context_json AS contextJson,
                 (SELECT status FROM dbo.chat_ai_runs WHERE id = @runId AND conversation_id = @cid) AS runStatus
          FROM dbo.chat_conversations
          WHERE id = @cid;
        `);
      const latest = checkRes.recordset[0];
      if (
        !latest ||
        latest.status !== "OPEN" ||
        latest.handlingMode !== "AI" ||
        latest.runStatus !== "RUNNING" ||
        abortController.signal.aborted ||
        Number(latest.controlRevision) !== Number(conv.controlRevision)
      ) {
        await newRequest(tx)
          .input("runId", sqlObj.BigInt, runId)
          .query(`UPDATE dbo.chat_ai_runs SET status = 'CANCELLED', completed_at = SYSUTCDATETIME() WHERE id = @runId AND status = 'RUNNING';`);
        return { cancelled: true };
      }

      const prevContextObj = parseJsonSafe(latest.contextJson, {}) || {};
      const mergedCtx = mergeDiscussedContext(prevContextObj, runContext);
      if (mergedCtx.changed) {
        await newRequest(tx)
          .input("cid", sqlObj.BigInt, cid)
          .input("ctxJson", sqlObj.NVarChar(sqlObj.MAX), JSON.stringify(mergedCtx.nextContext))
          .query(`UPDATE dbo.chat_conversations SET context_json = @ctxJson WHERE id = @cid;`);
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
          .input("previewVisibility", sqlObj.VarChar(16), msgVisibility)
          .query(`
            UPDATE dbo.chat_conversations
            SET
              last_sequence = last_sequence + 1,
              last_message_at = SYSUTCDATETIME(),
              last_message_preview = CASE WHEN @previewVisibility = 'PUBLIC' THEN @preview ELSE last_message_preview END,
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

      const mainMsg = await insertAiMsg("TEXT", visibility, finalAnswerText, {
        kind: "CHAT_TEXT", navigationLinks: runContext.navigationLinks.slice(-100),
      });
      createdMessages.push(mainMsg);

      for (const card of runContext.cardsToEmit) {
        const cardTitle = card.payload?.title || card.payload?.accommodation?.accommodationName || "Thông tin chi tiết";
        const cardVisibility = visibility === "OWNER_ONLY" ? "OWNER_ONLY" : card.visibility || visibility;
        const cardMsg = await insertAiMsg(card.messageType, cardVisibility, cardTitle, card.payload);
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
          visibility: "OWNER_ONLY",
          guestAiCloseAt: guestAiCloseAtIso,
          context: mergedCtx.nextContext,
          messages: createdMessages,
        },
      });

      return { cancelled: false, guestAiCloseAtIso, createdMessages };
    });

    if (saved?.cancelled) {
      await runtime?.emitToConversation(cid, "ai:cancelled", { conversationId: cid, runId });
    } else {
      runtime?.triggerOutboxDrain?.();
    }
  } catch (err) {
    const cancelled = err?.errorCode === "AI_CANCELLED" && !abortController.signal.aborted;
    if (!cancelled) console.error("[chat.ai.execute]", cid, err);

    const failedRun = await pool
      .request()
      .input("runId", sqlObj.BigInt, runId)
      .input("status", sqlObj.VarChar(16), cancelled ? "CANCELLED" : "FAILED")
      .input("errCode", sqlObj.VarChar(80), err?.errorCode || "AI_FAILED")
      .input("errMsg", sqlObj.NVarChar(500), String(err?.message || "AI execution failed").slice(0, 480))
      .query(`
        UPDATE dbo.chat_ai_runs
        SET status = @status, error_code = @errCode, error_message = @errMsg, completed_at = SYSUTCDATETIME()
        OUTPUT INSERTED.id
        WHERE id = @runId AND status = 'RUNNING';
      `);

    if (cancelled || !failedRun.recordset.length) {
      await runtime?.emitToConversation(cid, "ai:cancelled", { conversationId: cid, runId });
      return;
    }
    // NO auto-escalation to Manager on AI failure! Keep mode = 'AI' cleanly.
    await runtime?.emitToConversation(cid, "ai:failed", {
      conversationId: cid,
      runId,
      errorCode: err?.errorCode || "AI_FAILED",
      message: "Trợ lý AI tạm thời gián đoạn phản hồi. Quý khách vui lòng gửi lại câu hỏi hoặc bấm kết nối Quản lý nếu muốn trao đổi trực tiếp.",
    });
  } finally {
    clearTimeout(deadlineTimer);
    if (flushTimer) clearTimeout(flushTimer);
    abortController.abort();
  }
}

module.exports = {
  executeAiJob,
  collectNavigationLinks,
  mergeNavigationLinks,
};

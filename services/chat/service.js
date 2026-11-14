const config = require("../../configs/chat");
const { getDBPool, sqlObj } = require("../../configs/database");
const { searchAccommodationsByFilters } = require("../accommodation_daily_search_service");
const { getCustomerBookingByCodeOrId } = require("../customer_booking_read_service");
const {
  chatError,
  actorKeyForUser,
  actorKeyForGuest,
  withTransaction,
  newRequest,
  lockUsersInOrder,
  lockGuestSessionsInOrder,
  lockAccommodationsInOrder,
  lockConversationsInOrder,
  enqueueOutbox,
  recordChatEvent,
  parseJsonSafe,
  previewText,
} = require("./db");
const { appendSystemMessage, hardDeleteTemporaryConversation } = require("./lifecycle");

const POLITE_HOME_GREETING =
  "Xin chào Quý khách! Mình là Trợ lý ảo của VietPeace Stay. Rất hân hạnh được hỗ trợ Quý khách tìm điểm đến, gợi ý phòng phù hợp, báo giá và giải đáp thông tin lưu trú. Quý khách đang dự định đến thành phố hay điểm đến nào ạ? Ngoài ra, Quý khách cũng có thể nhấn Kết nối nhân viên / Quản lý bên dưới và chờ trong giây lát để trao đổi trực tiếp với nhân viên của chúng tôi nhé!";

function buildActorSelfKeys(actor, originGuestSessionId = null) {
  if (!actor) return [];
  const keys = [actor.actorKey];
  if (actor.type === "CUSTOMER" && originGuestSessionId) {
    keys.push(actorKeyForGuest(originGuestSessionId));
  }
  return [...new Set(keys.filter(Boolean))];
}

async function getFeaturedDestinations(limit = 8) {
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("limit", sqlObj.Int, limit)
    .query(`
      SELECT TOP (@limit)
        l.id,
        l.name,
        l.is_featured AS isFeatured,
        (
          SELECT COUNT(*)
          FROM dbo.accommodations AS a
          WHERE a.status = 1 AND a.deleted_at IS NULL
            AND (a.location_id = l.id OR a.location_id IN (SELECT c.id FROM dbo.locations c WHERE c.parent_id = l.id))
        ) AS accommodationCount
      FROM dbo.locations AS l
      WHERE l.is_active = 1
        AND EXISTS (
          SELECT 1 FROM dbo.accommodations AS a
          WHERE a.status = 1 AND a.deleted_at IS NULL
            AND (a.location_id = l.id OR a.location_id IN (SELECT c.id FROM dbo.locations c WHERE c.parent_id = l.id))
        )
      ORDER BY l.is_featured DESC, CASE WHEN l.parent_id IS NULL THEN 0 ELSE 1 END, l.sort_order ASC, l.id ASC;
    `);
  return res.recordset.map((r) => ({
    id: Number(r.id),
    name: r.name,
    isFeatured: Boolean(r.isFeatured),
    accommodationCount: Number(r.accommodationCount || 0),
  }));
}

async function resolveVerifiedPageContext(rawContext = {}, actor = null) {
  const pageType = ["HOME", "LOCATION_SEARCH", "ACCOMMODATION_DETAIL", "BOOKING_DETAIL"].includes(
    rawContext?.pageType,
  )
    ? rawContext.pageType
    : "HOME";

  const checkin = typeof rawContext?.checkin === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawContext.checkin)
    ? rawContext.checkin
    : null;
  const checkout = typeof rawContext?.checkout === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawContext.checkout)
    ? rawContext.checkout
    : null;
  const rooms = Number.isSafeInteger(Number(rawContext?.rooms)) && Number(rawContext.rooms) > 0
    ? Number(rawContext.rooms)
    : null;
  const adults = Number.isSafeInteger(Number(rawContext?.adults)) && Number(rawContext.adults) > 0
    ? Number(rawContext.adults)
    : null;
  const children = Number.isSafeInteger(Number(rawContext?.children)) && Number(rawContext.children) >= 0
    ? Number(rawContext.children)
    : null;

  const pool = getDBPool();

  if (pageType === "ACCOMMODATION_DETAIL" && Number(rawContext?.accommodationId) > 0) {
    const accomId = Number(rawContext.accommodationId);
    const res = await pool
      .request()
      .input("accomId", sqlObj.Int, accomId)
      .query(`
        SELECT TOP 1
          a.id,
          a.accommodation_name AS accommodationName,
          atp.name AS accommodationTypeName,
          a.star_rating AS starRating,
          a.location_id AS locationId,
          l.name AS locationName,
          a.address_line AS addressLine,
          a.phone,
          a.email,
          a.website_url AS websiteUrl,
          img.image_url AS coverImage,
          (
            SELECT MIN(rt.base_price)
            FROM dbo.room_types rt
            WHERE rt.accommodation_id = a.id AND rt.status = 1 AND rt.deleted_at IS NULL
          ) AS baseMinPrice,
          CASE WHEN EXISTS (
            SELECT 1 FROM dbo.chat_manager_assignment_epochs e
            WHERE e.accommodation_id = a.id AND e.revoked_at_utc IS NULL
          ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS hasActiveManager
        FROM dbo.accommodations AS a
        LEFT JOIN dbo.accommodation_types AS atp ON atp.id = a.accommodation_type_id
        LEFT JOIN dbo.locations AS l ON l.id = a.location_id
        OUTER APPLY (
          SELECT TOP 1 image_url FROM dbo.accommodation_images ai
          WHERE ai.accommodation_id = a.id
          ORDER BY ai.is_cover DESC, ai.sort_order ASC, ai.id ASC
        ) AS img
        WHERE a.id = @accomId AND a.status = 1 AND a.deleted_at IS NULL;
      `);
    const prop = res.recordset[0];
    if (prop) {
      let dynamicMinPrice = prop.baseMinPrice ? Number(prop.baseMinPrice) : null;
      if (checkin && checkout) {
        try {
          const searchRes = await searchAccommodationsByFilters({
            accommodationId: accomId,
            checkinDate: checkin,
            checkoutDate: checkout,
            ...(rooms ? { rooms } : {}),
            page: 1,
            pageSize: 1,
          });
          const item = searchRes?.data?.items?.[0];
          if (item && item.min_price !== null && item.min_price !== undefined) {
            dynamicMinPrice = Number(item.min_price);
          }
        } catch {
          // fallback to baseMinPrice
        }
      }

      return {
        pageType: "ACCOMMODATION_DETAIL",
        accommodationId: Number(prop.id),
        accommodationName: prop.accommodationName,
        accommodationTypeName: prop.accommodationTypeName || null,
        starRating: prop.starRating,
        locationId: prop.locationId ? Number(prop.locationId) : null,
        locationName: prop.locationName || null,
        addressLine: prop.addressLine,
        phone: prop.phone || null,
        email: prop.email || null,
        websiteUrl: prop.websiteUrl || null,
        coverImage: prop.coverImage || null,
        minPrice: dynamicMinPrice,
        hasActiveManager: Boolean(prop.hasActiveManager),
        checkin,
        checkout,
        rooms,
        adults,
        children,
        contextKey: `PROPERTY:${prop.id}:${checkin || ""}:${checkout || ""}`,
      };
    }
  }

  if (pageType === "LOCATION_SEARCH" && Number(rawContext?.locationId) > 0) {
    const locId = Number(rawContext.locationId);
    const locRes = await pool
      .request()
      .input("locId", sqlObj.Int, locId)
      .query(`SELECT TOP 1 id, name FROM dbo.locations WHERE id = @locId AND is_active = 1;`);
    const loc = locRes.recordset[0];
    if (loc) {
      let choices = [];
      try {
        const searchRes = await searchAccommodationsByFilters({
          locationId: locId,
          ...(checkin && checkout ? { checkinDate: checkin, checkoutDate: checkout } : {}),
          ...(rooms ? { rooms } : {}),
          page: 1,
          pageSize: 6,
        });
        const rawItems = searchRes?.data?.items || [];
        const accomIds = rawItems.map((x) => Number(x.id));
        const mgrSet = new Set();
        if (accomIds.length > 0) {
          const mgrRes = await pool
            .request()
            .input("idsJson", sqlObj.NVarChar(sqlObj.MAX), JSON.stringify(accomIds))
            .query(`
              SELECT DISTINCT e.accommodation_id AS id
              FROM dbo.chat_manager_assignment_epochs e
              INNER JOIN OPENJSON(@idsJson) WITH (id INT '$') j ON j.id = e.accommodation_id
              WHERE e.revoked_at_utc IS NULL;
            `);
          for (const m of mgrRes.recordset) mgrSet.add(Number(m.id));
        }

        choices = rawItems.map((a) => ({
          accommodationId: Number(a.id),
          accommodationName: a.accommodation_name,
          accommodationTypeName: a.accommodation_type_name || null,
          starRating: a.star_rating,
          locationName: a.location_name,
          addressLine: a.address_line,
          minPrice: a.min_price !== null && a.min_price !== undefined ? Number(a.min_price) : null,
          availableRooms: a.available_rooms,
          coverImage: (a.images || []).find((i) => i.is_cover)?.image_url || a.images?.[0]?.image_url || null,
          hasActiveManager: mgrSet.has(Number(a.id)),
          detailUrl: `/accommodation-detail?accommodationId=${a.id}`,
        }));
      } catch {
        choices = [];
      }

      return {
        pageType: "LOCATION_SEARCH",
        locationId: Number(loc.id),
        locationName: loc.name,
        accommodationId: null,
        choices,
        checkin,
        checkout,
        rooms,
        adults,
        children,
        contextKey: `LOCATION:${loc.id}:${checkin || ""}:${checkout || ""}`,
      };
    }
  }

  if (pageType === "BOOKING_DETAIL" && Number(rawContext?.bookingId) > 0 && actor?.type === "CUSTOMER") {
    const booking = await getCustomerBookingByCodeOrId(actor.userId, { bookingId: rawContext.bookingId });
    if (booking) {
      return {
        pageType: "BOOKING_DETAIL",
        bookingId: booking.id,
        bookingCode: booking.bookingCode,
        accommodationId: booking.accommodationId,
        accommodationName: booking.accommodationName,
        status: booking.status,
        checkInDate: booking.checkInDate,
        checkOutDate: booking.checkOutDate,
        totalAmount: booking.totalAmount,
        contextKey: `BOOKING:${booking.id}`,
      };
    }
  }

  return {
    pageType: "HOME",
    locationId: null,
    accommodationId: null,
    checkin,
    checkout,
    rooms,
    adults,
    children,
    contextKey: "HOME",
  };
}

function buildContextGreetingAndCard(verifiedCtx, featuredLocations = []) {
  if (verifiedCtx.pageType === "ACCOMMODATION_DETAIL" && verifiedCtx.accommodationId) {
    return {
      greetingText:
        `Xin chào Quý khách! Mình là Trợ lý ảo của VietPeace Stay. Mình đã đính kèm thông tin ${verifiedCtx.accommodationName} bên dưới để tiện hỗ trợ Quý khách kiểm tra phòng trống, báo giá và chính sách. Quý khách cần tư vấn gì, hoặc muốn kết nối trực tiếp với nhân viên / Quản lý của ${verifiedCtx.accommodationName} thì nhấn nút kết nối bên dưới và chờ trong giây lát nhé!`,
      cardMessage: {
        messageType: "PROPERTY_CARD",
        visibility: "PUBLIC",
        content: `Đính kèm cơ sở đang xem: ${verifiedCtx.accommodationName}`,
        payload: {
          kind: "PROPERTY_ATTACHMENT",
          accommodationId: verifiedCtx.accommodationId,
          accommodationName: verifiedCtx.accommodationName,
          accommodationTypeName: verifiedCtx.accommodationTypeName,
          starRating: verifiedCtx.starRating,
          locationName: verifiedCtx.locationName,
          addressLine: verifiedCtx.addressLine,
          coverImage: verifiedCtx.coverImage,
          minPrice: verifiedCtx.minPrice,
          phone: verifiedCtx.phone,
          email: verifiedCtx.email,
          websiteUrl: verifiedCtx.websiteUrl,
          hasActiveManager: verifiedCtx.hasActiveManager,
          checkin: verifiedCtx.checkin,
          checkout: verifiedCtx.checkout,
          rooms: verifiedCtx.rooms,
          adults: verifiedCtx.adults,
          children: verifiedCtx.children,
          detailUrl: `/accommodation-detail?accommodationId=${verifiedCtx.accommodationId}`,
        },
      },
    };
  }

  if (verifiedCtx.pageType === "LOCATION_SEARCH" && verifiedCtx.locationId) {
    return {
      greetingText:
        `Xin chào Quý khách! Mình là Trợ lý ảo của VietPeace Stay. Mình thấy Quý khách đang quan tâm khu vực ${verifiedCtx.locationName} — dưới đây là các cơ sở lưu trú phù hợp để Quý khách lựa chọn. Quý khách có thể hỏi mình về phòng, giá, chính sách hoặc chọn một cơ sở bên dưới để tư vấn chi tiết / kết nối trực tiếp với Quản lý cơ sở và chờ trong giây lát ạ!`,
      cardMessage: {
        messageType: "PROPERTY_CARD",
        visibility: "PUBLIC",
        content: `Gợi ý cơ sở lưu trú tại ${verifiedCtx.locationName}`,
        payload: {
          kind: "PROPERTY_CHOICES",
          locationId: verifiedCtx.locationId,
          locationName: verifiedCtx.locationName,
          checkin: verifiedCtx.checkin,
          checkout: verifiedCtx.checkout,
          rooms: verifiedCtx.rooms,
          adults: verifiedCtx.adults,
          children: verifiedCtx.children,
          items: verifiedCtx.choices || [],
        },
      },
    };
  }

  if (verifiedCtx.pageType === "BOOKING_DETAIL" && verifiedCtx.bookingId) {
    return {
      greetingText:
        `Xin chào Quý khách! Mình là Trợ lý ảo của VietPeace Stay. Mình đã xác thực đơn đặt phòng ${verifiedCtx.bookingCode} tại ${verifiedCtx.accommodationName} của bạn — bạn cần hỗ trợ thông tin gì cho đơn này ạ?`,
      cardMessage: {
        messageType: "PROPERTY_CARD",
        visibility: "OWNER_ONLY",
        content: `Đơn đặt phòng: ${verifiedCtx.bookingCode}`,
        payload: {
          kind: "VERIFIED_BOOKING_CONTEXT",
          bookingId: verifiedCtx.bookingId,
          bookingCode: verifiedCtx.bookingCode,
          accommodationId: verifiedCtx.accommodationId,
          accommodationName: verifiedCtx.accommodationName,
          status: verifiedCtx.status,
          checkInDate: verifiedCtx.checkInDate,
          checkOutDate: verifiedCtx.checkOutDate,
          totalAmount: verifiedCtx.totalAmount,
        },
      },
    };
  }

  // HOME default
  return {
    greetingText: POLITE_HOME_GREETING,
    cardMessage: {
      messageType: "PROPERTY_CARD",
      visibility: "PUBLIC",
      content: "Chọn nhanh điểm đến phổ biến",
      payload: {
        kind: "HOME_DESTINATIONS",
        featuredLocations,
      },
    },
  };
}

async function insertGreetingMessagesInTx(tx, conversationId, { greetingText, cardMessage, contextKey }) {
  const created = [];

  async function addBotMsg(messageType, visibility, text, payload = null) {
    const seqRes = await newRequest(tx)
      .input("cid", sqlObj.BigInt, conversationId)
      .input("preview", sqlObj.NVarChar(300), previewText(text))
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
      .input("cid", sqlObj.BigInt, conversationId)
      .input("seq", sqlObj.BigInt, seq)
      .input("mtype", sqlObj.VarChar(32), messageType)
      .input("vis", sqlObj.VarChar(16), visibility)
      .input("content", sqlObj.NVarChar(sqlObj.MAX), text)
      .input("payloadJson", sqlObj.NVarChar(sqlObj.MAX), payload ? JSON.stringify(payload) : null)
      .query(`
        INSERT INTO dbo.chat_messages (
          conversation_id, sequence, sender_actor_key, sender_type,
          message_type, visibility, content, payload_json
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
          INSERTED.created_at AS createdAt
        VALUES (
          @cid, @seq, 'ai:vietpeace', 'AI',
          @mtype, @vis, @content, @payloadJson
        );
      `);
    const row = ins.recordset[0];
    const msg = {
      ...row,
      id: Number(row.id),
      conversationId: Number(row.conversationId),
      sequence: Number(row.sequence),
      payload,
      createdAt: new Date(row.createdAt).toISOString(),
    };
    created.push(msg);
    return msg;
  }

  if (greetingText) {
    await addBotMsg("TEXT", "PUBLIC", greetingText, null);
  }
  if (cardMessage) {
    const insertedCard = await addBotMsg(
      cardMessage.messageType,
      cardMessage.visibility || "PUBLIC",
      cardMessage.content,
      cardMessage.payload,
    );
    // Store lastAttachedContextKey & lastAttachedSequence cleanly
    await newRequest(tx)
      .input("cid", sqlObj.BigInt, conversationId)
      .input("key", sqlObj.NVarChar(200), contextKey || "")
      .input("seq", sqlObj.BigInt, insertedCard.sequence)
      .query(`
        UPDATE dbo.chat_conversations
        SET context_json = JSON_MODIFY(
          JSON_MODIFY(COALESCE(context_json, N'{}'), '$.lastAttachedContextKey', @key),
          '$.lastAttachedSequence', @seq
        )
        WHERE id = @cid;
      `);
  }

  return created;
}

async function formatConversationRow(row, selfKeys = [], pool = getDBPool()) {
  const cid = Number(row.id);
  // Load counterparty (Manager) delivery/read receipts and owner unread count
  const partRes = await pool
    .request()
    .input("cid", sqlObj.BigInt, cid)
    .query(`
      SELECT
        actor_key AS actorKey,
        participant_role AS participantRole,
        last_delivered_sequence AS lastDeliveredSequence,
        last_delivered_at AS lastDeliveredAt,
        last_read_sequence AS lastReadSequence,
        last_read_at AS lastReadAt,
        visible_from_sequence AS visibleFromSequence
      FROM dbo.chat_participants
      WHERE conversation_id = @cid;
    `);

  let ownerParticipant = null;
  let managerParticipant = null;
  for (const p of partRes.recordset) {
    if (p.participantRole === "CUSTOMER" || p.participantRole === "GUEST") {
      if (selfKeys.includes(p.actorKey) || !ownerParticipant) ownerParticipant = p;
    } else if (p.participantRole === "MANAGER") {
      managerParticipant = p;
    }
  }

  const ownerReadSeq = Number(ownerParticipant?.lastReadSequence || 0);
  const unreadRes = await pool
    .request()
    .input("cid", sqlObj.BigInt, cid)
    .input("readSeq", sqlObj.BigInt, ownerReadSeq)
    .input("selfKeysJson", sqlObj.NVarChar(sqlObj.MAX), JSON.stringify(selfKeys))
    .query(`
      SELECT COUNT(*) AS cnt
      FROM dbo.chat_messages
      WHERE conversation_id = @cid
        AND sequence > @readSeq
        AND visibility IN ('PUBLIC', 'OWNER_ONLY')
        AND (sender_actor_key IS NULL OR sender_actor_key NOT IN (SELECT value FROM OPENJSON(@selfKeysJson)));
    `);

  return {
    id: cid,
    scopeType: row.scopeType,
    accommodationId: row.accommodationId ? Number(row.accommodationId) : null,
    accommodationName: row.accommodationName || null,
    accommodationCoverImage: row.accommodationCoverImage || null,
    accommodationPhone: row.accommodationPhone || null,
    accommodationEmail: row.accommodationEmail || null,
    accommodationWebsite: row.accommodationWebsite || null,
    accommodationAddress: row.accommodationAddress || null,
    hasActiveManager: Boolean(row.hasActiveManager),
    bookingId: row.bookingId ? String(row.bookingId) : null,
    status: row.status,
    handlingMode: row.handlingMode,
    retentionState: row.retentionState,
    assignedUserId: row.assignedUserId ? String(row.assignedUserId) : null,
    assignedManagerName: row.assignedManagerName || null,
    currentHandoffId: row.currentHandoffId ? Number(row.currentHandoffId) : null,
    handoffStatus: row.handoffStatus || null,
    handoffFirstHumanReplyAt: row.handoffFirstHumanReplyAt ? new Date(row.handoffFirstHumanReplyAt).toISOString() : null,
    hasRatedHandoff: Boolean(row.hasRatedHandoff),
    controlRevision: Number(row.controlRevision),
    lastSequence: Number(row.lastSequence),
    lastMessageAt: row.lastMessageAt ? new Date(row.lastMessageAt).toISOString() : null,
    lastMessagePreview: row.lastMessagePreview || "",
    guestAiCloseAt: row.guestAiCloseAt ? new Date(row.guestAiCloseAt).toISOString() : null,
    managerWaitExpiresAt: row.managerWaitExpiresAt ? new Date(row.managerWaitExpiresAt).toISOString() : null,
    temporaryCleanupAt: row.temporaryCleanupAt ? new Date(row.temporaryCleanupAt).toISOString() : null,
    context: parseJsonSafe(row.contextJson, {}),
    unreadCount: Number(unreadRes.recordset[0]?.cnt || 0),
    counterpartyDelivery: managerParticipant
      ? {
          deliveredSequence: Number(managerParticipant.lastDeliveredSequence || 0),
          deliveredAt: managerParticipant.lastDeliveredAt
            ? new Date(managerParticipant.lastDeliveredAt).toISOString()
            : null,
          readSequence: Number(managerParticipant.lastReadSequence || 0),
          readAt: managerParticipant.lastReadAt
            ? new Date(managerParticipant.lastReadAt).toISOString()
            : null,
        }
      : { deliveredSequence: 0, deliveredAt: null, readSequence: 0, readAt: null },
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

const CONV_SELECT_SQL = `
  SELECT
    c.id,
    c.customer_user_id AS customerUserId,
    c.guest_session_id AS guestSessionId,
    c.origin_guest_session_id AS originGuestSessionId,
    c.scope_type AS scopeType,
    c.accommodation_id AS accommodationId,
    a.accommodation_name AS accommodationName,
    img.image_url AS accommodationCoverImage,
    a.phone AS accommodationPhone,
    a.email AS accommodationEmail,
    a.website_url AS accommodationWebsite,
    a.address_line AS accommodationAddress,
    CASE WHEN EXISTS (
      SELECT 1 FROM dbo.chat_manager_assignment_epochs e
      WHERE e.accommodation_id = c.accommodation_id AND e.revoked_at_utc IS NULL
    ) THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS hasActiveManager,
    c.booking_id AS bookingId,
    c.status,
    c.handling_mode AS handlingMode,
    c.retention_state AS retentionState,
    c.assigned_user_id AS assignedUserId,
    u.full_name AS assignedManagerName,
    c.current_handoff_id AS currentHandoffId,
    h.status AS handoffStatus,
    h.first_human_reply_at AS handoffFirstHumanReplyAt,
    CASE WHEN r.id IS NOT NULL THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS hasRatedHandoff,
    c.manager_assignment_epoch_id AS managerAssignmentEpochId,
    c.control_revision AS controlRevision,
    c.last_sequence AS lastSequence,
    c.last_message_at AS lastMessageAt,
    c.last_message_preview AS lastMessagePreview,
    c.context_json AS contextJson,
    c.guest_ai_close_at AS guestAiCloseAt,
    c.manager_wait_expires_at AS managerWaitExpiresAt,
    c.temporary_cleanup_at AS temporaryCleanupAt,
    c.created_at AS createdAt,
    c.updated_at AS updatedAt
  FROM dbo.chat_conversations AS c
  LEFT JOIN dbo.accommodations AS a ON a.id = c.accommodation_id
  OUTER APPLY (
    SELECT TOP 1 image_url FROM dbo.accommodation_images ai
    WHERE ai.accommodation_id = a.id
    ORDER BY ai.is_cover DESC, ai.sort_order ASC, ai.id ASC
  ) AS img
  LEFT JOIN dbo.users AS u ON u.id = c.assigned_user_id
  LEFT JOIN dbo.chat_handoff_sessions AS h ON h.id = c.current_handoff_id
  LEFT JOIN dbo.chat_conversation_ratings AS r ON r.handoff_id = h.id
`;

async function assertOwnerConversation(actor, conversationId, txOrPool = getDBPool()) {
  const cid = Number(conversationId);
  if (!Number.isSafeInteger(cid) || cid < 1) {
    throw chatError(400, "INVALID_CONVERSATION_ID", "Mã hội thoại không hợp lệ.");
  }
  const req = newRequest(txOrPool)
    .input("cid", sqlObj.BigInt, cid)
    .input("uid", sqlObj.UniqueIdentifier, actor.type === "CUSTOMER" ? actor.userId : null)
    .input("gid", sqlObj.UniqueIdentifier, actor.type === "GUEST" ? actor.guestSessionId : null);

  const res = await req.query(`
    ${CONV_SELECT_SQL}
    WHERE c.id = @cid
      AND (
        (@uid IS NOT NULL AND c.customer_user_id = @uid)
        OR (@gid IS NOT NULL AND c.guest_session_id = @gid)
      );
  `);
  const row = res.recordset[0];
  if (!row) {
    throw chatError(404, "CONVERSATION_NOT_FOUND", "Không tìm thấy hội thoại hoặc phiên đã hết hạn.");
  }
  return row;
}

async function listOwnerConversations(actor) {
  if (!actor) return [];
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("uid", sqlObj.UniqueIdentifier, actor.type === "CUSTOMER" ? actor.userId : null)
    .input("gid", sqlObj.UniqueIdentifier, actor.type === "GUEST" ? actor.guestSessionId : null)
    .query(`
      ${CONV_SELECT_SQL}
      WHERE (
        (@uid IS NOT NULL AND c.customer_user_id = @uid)
        OR (@gid IS NOT NULL AND c.guest_session_id = @gid)
      )
      ORDER BY CASE WHEN c.status = 'OPEN' THEN 0 ELSE 1 END, COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC;
    `);

  const list = [];
  for (const row of res.recordset) {
    list.push(await formatConversationRow(row, buildActorSelfKeys(actor, row.originGuestSessionId), pool));
  }
  return list;
}

async function getOwnerConversationDetail(actor, conversationId) {
  const row = await assertOwnerConversation(actor, conversationId);
  return formatConversationRow(row, buildActorSelfKeys(actor, row.originGuestSessionId));
}

async function getOwnerConversationMessages(actor, conversationId, { limit = 50, beforeSequence = null } = {}) {
  await assertOwnerConversation(actor, conversationId);
  const pool = getDBPool();
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), config.historyMaxLimit);
  const res = await pool
    .request()
    .input("cid", sqlObj.BigInt, Number(conversationId))
    .input("limit", sqlObj.Int, safeLimit)
    .input("beforeSeq", sqlObj.BigInt, beforeSequence ? Number(beforeSequence) : null)
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
        ai_run_id AS aiRunId,
        handoff_id AS handoffId,
        created_at AS createdAt
      FROM dbo.chat_messages
      WHERE conversation_id = @cid
        AND visibility IN ('PUBLIC', 'OWNER_ONLY')
        AND (@beforeSeq IS NULL OR sequence < @beforeSeq)
      ORDER BY sequence DESC;
    `);

  return res.recordset
    .reverse()
    .map((m) => ({
      ...m,
      id: Number(m.id),
      conversationId: Number(m.conversationId),
      sequence: Number(m.sequence),
      aiRunId: m.aiRunId ? Number(m.aiRunId) : null,
      handoffId: m.handoffId ? Number(m.handoffId) : null,
      payload: parseJsonSafe(m.payloadJson, null),
      createdAt: new Date(m.createdAt).toISOString(),
    }));
}

async function openOrReuseConversation(actor, body = {}) {
  const scopeType = body.scopeType === "PROPERTY" ? "PROPERTY" : "PLATFORM";
  const accommodationId = scopeType === "PROPERTY" ? Number(body.accommodationId) : null;
  const bookingId = body.bookingId && /^\d+$/.test(String(body.bookingId)) ? Number(body.bookingId) : null;
  const clientRequestId = body.clientRequestId ? String(body.clientRequestId).slice(0, 100) : null;
  const rawPageContext = body.pageContext || {};

  if (scopeType === "PROPERTY" && (!Number.isSafeInteger(accommodationId) || accommodationId < 1)) {
    throw chatError(400, "INVALID_ACCOMMODATION", "Hội thoại cơ sở bắt buộc accommodationId hợp lệ.");
  }

  const verifiedPageContext = await resolveVerifiedPageContext(
    {
      ...rawPageContext,
      pageType:
        scopeType === "PROPERTY" && !rawPageContext?.pageType
          ? "ACCOMMODATION_DETAIL"
          : rawPageContext?.pageType || "HOME",
      accommodationId: accommodationId || rawPageContext?.accommodationId,
    },
    actor,
  );
  const featuredLocations =
    verifiedPageContext.pageType === "HOME" ? await getFeaturedDestinations(8) : [];

  const result = await withTransaction(async (tx) => {
    // Strict lock ordering: users -> chat_guest_sessions -> accommodations -> chat_conversations
    if (actor.type === "CUSTOMER") {
      await lockUsersInOrder(tx, [actor.userId]);
    } else {
      await lockGuestSessionsInOrder(tx, [actor.guestSessionId]);
    }
    if (accommodationId) {
      await lockAccommodationsInOrder(tx, [accommodationId]);
    }

    // Check OPEN_REQUEST_RESULT idempotency if clientRequestId passed
    if (clientRequestId) {
      const idempRes = await newRequest(tx)
        .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
        .input("clientReqId", sqlObj.VarChar(100), clientRequestId)
        .query(`
          SELECT conversation_id AS cid
          FROM dbo.chat_events
          WHERE actor_key = @actorKey
            AND event_type = 'OPEN_REQUEST_RESULT'
            AND client_request_id = @clientReqId;
        `);
      const existingCid = idempRes.recordset[0]?.cid;
      if (existingCid) {
        const checkOpen = await newRequest(tx)
          .input("cid", sqlObj.BigInt, existingCid)
          .query(`SELECT id FROM dbo.chat_conversations WHERE id = @cid AND status = 'OPEN';`);
        if (checkOpen.recordset[0]) {
          return { conversationId: Number(existingCid), created: false };
        }
      }
    }

    // Check existing OPEN conversation matching exact tuple
    const existingRes = await newRequest(tx)
      .input("uid", sqlObj.UniqueIdentifier, actor.type === "CUSTOMER" ? actor.userId : null)
      .input("gid", sqlObj.UniqueIdentifier, actor.type === "GUEST" ? actor.guestSessionId : null)
      .input("scope", sqlObj.VarChar(16), scopeType)
      .input("accomId", sqlObj.Int, accommodationId)
      .input("bookingId", sqlObj.BigInt, bookingId)
      .query(`
        SELECT TOP 1
          id,
          last_sequence AS lastSequence,
          context_json AS contextJson,
          retention_state AS retentionState
        FROM dbo.chat_conversations WITH (UPDLOCK, HOLDLOCK)
        WHERE status = 'OPEN'
          AND scope_type = @scope
          AND ((accommodation_id IS NULL AND @accomId IS NULL) OR accommodation_id = @accomId)
          AND ((booking_id IS NULL AND @bookingId IS NULL) OR booking_id = @bookingId)
          AND (
            (@uid IS NOT NULL AND customer_user_id = @uid)
            OR (@gid IS NOT NULL AND guest_session_id = @gid)
          );
      `);

    const existing = existingRes.recordset[0];
    let cid;
    let isCreated = false;
    let prevCtx = {};

    if (existing) {
      cid = Number(existing.id);
      prevCtx = parseJsonSafe(existing.contextJson, {}) || {};
    } else {
      const retentionState = actor.type === "CUSTOMER" ? "PERSISTENT" : "TEMPORARY";
      const initCtx = {
        pageContext: verifiedPageContext,
      };
      const insConv = await newRequest(tx)
        .input("uid", sqlObj.UniqueIdentifier, actor.type === "CUSTOMER" ? actor.userId : null)
        .input("gid", sqlObj.UniqueIdentifier, actor.type === "GUEST" ? actor.guestSessionId : null)
        .input("scope", sqlObj.VarChar(16), scopeType)
        .input("accomId", sqlObj.Int, accommodationId)
        .input("bookingId", sqlObj.BigInt, bookingId)
        .input("ctxJson", sqlObj.NVarChar(sqlObj.MAX), JSON.stringify(initCtx))
        .input("ret", sqlObj.VarChar(16), retentionState)
        .input("tempSec", sqlObj.Int, config.guestTempCleanupSeconds)
        .query(`
          INSERT INTO dbo.chat_conversations (
            customer_user_id, guest_session_id, scope_type, accommodation_id, booking_id,
            context_json, retention_state, temporary_cleanup_at
          )
          OUTPUT INSERTED.id
          VALUES (
            @uid, @gid, @scope, @accomId, @bookingId,
            @ctxJson, @ret,
            CASE WHEN @ret = 'TEMPORARY' THEN DATEADD(second, @tempSec, SYSUTCDATETIME()) ELSE NULL END
          );
        `);

      cid = Number(insConv.recordset[0].id);
      isCreated = true;

      await newRequest(tx)
        .input("cid", sqlObj.BigInt, cid)
        .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
        .input("uid", sqlObj.UniqueIdentifier, actor.type === "CUSTOMER" ? actor.userId : null)
        .input("gid", sqlObj.UniqueIdentifier, actor.type === "GUEST" ? actor.guestSessionId : null)
        .input("role", sqlObj.VarChar(32), actor.type === "CUSTOMER" ? "CUSTOMER" : "GUEST")
        .query(`
          INSERT INTO dbo.chat_participants (
            conversation_id, actor_key, user_id, guest_session_id, participant_role
          )
          VALUES (@cid, @actorKey, @uid, @gid, @role);
        `);
    }

    // Update pageContext & attach initial greeting or deduped Shopee/Location card if requested
    const updatedCtx = {
      ...prevCtx,
      pageContext: verifiedPageContext,
    };
    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("ctxJson", sqlObj.NVarChar(sqlObj.MAX), JSON.stringify(updatedCtx))
      .query(`
        UPDATE dbo.chat_conversations
        SET context_json = @ctxJson, updated_at = SYSUTCDATETIME()
        WHERE id = @cid;
      `);

    const attachRequested = rawPageContext?.attachContextCard !== false;
    const sameKeyAlreadyAttached =
      prevCtx?.lastAttachedContextKey &&
      prevCtx.lastAttachedContextKey === verifiedPageContext.contextKey;

    if (isCreated || (attachRequested && !sameKeyAlreadyAttached)) {
      const { greetingText, cardMessage } = buildContextGreetingAndCard(
        verifiedPageContext,
        featuredLocations,
      );
      const msgs = await insertGreetingMessagesInTx(tx, cid, {
        greetingText: isCreated ? greetingText : null,
        cardMessage,
        contextKey: verifiedPageContext.contextKey,
      });
      for (const m of msgs) {
        await enqueueOutbox(tx, {
          kind: "SOCKET_EVENT",
          conversationId: cid,
          eventName: "message:created",
          payload: { conversationId: cid, ownerKey: actor.actorKey, message: m, visibility: m.visibility },
        });
      }
    }

    if (clientRequestId) {
      await recordChatEvent(tx, {
        conversationId: cid,
        actorKey: actor.actorKey,
        eventType: "OPEN_REQUEST_RESULT",
        clientRequestId,
        payload: { scopeType, accommodationId, contextKey: verifiedPageContext.contextKey },
      }).catch(() => {});
    }

    return { conversationId: cid, created: isCreated };
  });

  const conversation = await getOwnerConversationDetail(actor, result.conversationId);
  const messages = await getOwnerConversationMessages(actor, result.conversationId, { limit: 50 });

  return {
    created: result.created,
    conversation,
    messages,
  };
}

async function updateConversationContext(actor, conversationId, rawPageContext = {}) {
  const existingRow = await assertOwnerConversation(actor, conversationId);
  if (existingRow.status !== "OPEN") {
    throw chatError(409, "CONVERSATION_RESOLVED", "Hội thoại đã kết thúc.");
  }

  const verifiedPageContext = await resolveVerifiedPageContext(rawPageContext, actor);
  const featuredLocations =
    verifiedPageContext.pageType === "HOME" ? await getFeaturedDestinations(8) : [];

  await withTransaction(async (tx) => {
    const cid = Number(conversationId);
    await lockConversationsInOrder(tx, [cid]);

    const curRes = await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .query(`SELECT context_json AS contextJson, scope_type AS scopeType, accommodation_id AS accommodationId FROM dbo.chat_conversations WHERE id = @cid;`);
    const cur = curRes.recordset[0];
    const prevCtx = parseJsonSafe(cur?.contextJson, {}) || {};

    const nextCtx = {
      ...prevCtx,
      pageContext: verifiedPageContext,
    };
    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("ctxJson", sqlObj.NVarChar(sqlObj.MAX), JSON.stringify(nextCtx))
      .query(`
        UPDATE dbo.chat_conversations
        SET context_json = @ctxJson, updated_at = SYSUTCDATETIME()
        WHERE id = @cid;
      `);

    const sameKey =
      prevCtx?.lastAttachedContextKey &&
      prevCtx.lastAttachedContextKey === verifiedPageContext.contextKey;

    if (rawPageContext.attachContextCard !== false && !sameKey && verifiedPageContext.contextKey !== "HOME") {
      const { cardMessage } = buildContextGreetingAndCard(verifiedPageContext, featuredLocations);
      if (cardMessage) {
        const msgs = await insertGreetingMessagesInTx(tx, cid, {
          greetingText: null,
          cardMessage,
          contextKey: verifiedPageContext.contextKey,
        });
        for (const m of msgs) {
          await enqueueOutbox(tx, {
            kind: "SOCKET_EVENT",
            conversationId: cid,
            eventName: "message:created",
            payload: { conversationId: cid, ownerKey: actor.actorKey, message: m, visibility: m.visibility },
          });
        }
      }
    }
  });

  return getOwnerConversationDetail(actor, conversationId);
}

async function sendOwnerMessage(actor, conversationId, { content, clientMessageId = null, replyToMessageId = null }) {
  const cleanText = String(content || "").trim();
  if (!cleanText || cleanText.length > config.messageMaxLength) {
    throw chatError(
      400,
      "INVALID_MESSAGE",
      `Nội dung tin nhắn không được trống và tối đa ${config.messageMaxLength} ký tự.`,
    );
  }
  const cleanClientId = clientMessageId ? String(clientMessageId).trim().slice(0, 100) : null;
  const cid = Number(conversationId);

  const txRes = await withTransaction(async (tx) => {
    await lockConversationsInOrder(tx, [cid]);

    const row = await assertOwnerConversation(actor, cid, tx);
    if (row.status !== "OPEN") {
      throw chatError(409, "CONVERSATION_RESOLVED", "Hội thoại đã kết thúc. Vui lòng mở lại hoặc tạo hội thoại mới.");
    }

    if (cleanClientId) {
      const dupRes = await newRequest(tx)
        .input("cid", sqlObj.BigInt, cid)
        .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
        .input("clientMsgId", sqlObj.VarChar(100), cleanClientId)
        .query(`
          SELECT TOP 1
            id, conversation_id AS conversationId, sequence, sender_actor_key AS senderActorKey,
            sender_type AS senderType, message_type AS messageType, visibility,
            content, payload_json AS payloadJson, client_message_id AS clientMessageId, created_at AS createdAt
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

    const dueAt = row.handlingMode === "AI" ? new Date(Date.now() + config.aiDebounceMs) : null;

    // Reset guest_ai_close_at on new guest message; arm temporary safety timer while AI thinks if AI mode
    const seqRes = await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("preview", sqlObj.NVarChar(300), previewText(cleanText))
      .input("dueAt", sqlObj.DateTime2(3), dueAt)
      .input("tempSec", sqlObj.Int, config.guestTempCleanupSeconds)
      .query(`
        UPDATE dbo.chat_conversations
        SET
          last_sequence = last_sequence + 1,
          last_message_at = SYSUTCDATETIME(),
          last_message_preview = @preview,
          ai_due_at = CASE WHEN handling_mode = 'AI' THEN @dueAt ELSE ai_due_at END,
          guest_ai_close_at = NULL,
          temporary_cleanup_at = CASE
            WHEN retention_state = 'TEMPORARY' AND handling_mode = 'AI' THEN DATEADD(second, @tempSec, SYSUTCDATETIME())
            ELSE temporary_cleanup_at
          END,
          updated_at = SYSUTCDATETIME()
        OUTPUT INSERTED.last_sequence AS seq
        WHERE id = @cid;
      `);

    const seq = Number(seqRes.recordset[0].seq);
    const ins = await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("seq", sqlObj.BigInt, seq)
      .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
      .input("senderType", sqlObj.VarChar(20), actor.type === "CUSTOMER" ? "CUSTOMER" : "GUEST")
      .input("uid", sqlObj.UniqueIdentifier, actor.type === "CUSTOMER" ? actor.userId : null)
      .input("gid", sqlObj.UniqueIdentifier, actor.type === "GUEST" ? actor.guestSessionId : null)
      .input("clientMsgId", sqlObj.VarChar(100), cleanClientId)
      .input("content", sqlObj.NVarChar(sqlObj.MAX), cleanText)
      .input("replyToId", sqlObj.BigInt, replyToMessageId ? Number(replyToMessageId) : null)
      .query(`
        INSERT INTO dbo.chat_messages (
          conversation_id, sequence, sender_actor_key, sender_type,
          sender_user_id, sender_guest_session_id, client_message_id,
          message_type, visibility, content, reply_to_message_id
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
          INSERTED.client_message_id AS clientMessageId,
          INSERTED.created_at AS createdAt
        VALUES (
          @cid, @seq, @actorKey, @senderType,
          @uid, @gid, @clientMsgId,
          'TEXT', 'PUBLIC', @content, @replyToId
        );
      `);

    // Cancel any previous QUEUED/RUNNING AI run since user appended a fresh turn
    if (row.handlingMode === "AI") {
      await newRequest(tx)
        .input("cid", sqlObj.BigInt, cid)
        .query(`
          UPDATE dbo.chat_ai_runs
          SET status = 'CANCELLED', completed_at = SYSUTCDATETIME()
          WHERE conversation_id = @cid AND status IN ('QUEUED', 'RUNNING');
        `);
    }

    // Owner obviously delivered & read their own message
    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("actorKey", sqlObj.VarChar(100), actor.actorKey)
      .input("seq", sqlObj.BigInt, seq)
      .query(`
        UPDATE dbo.chat_participants
        SET
          last_delivered_sequence = CASE WHEN last_delivered_sequence < @seq THEN @seq ELSE last_delivered_sequence END,
          last_delivered_at = CASE WHEN last_delivered_sequence < @seq THEN SYSUTCDATETIME() ELSE last_delivered_at END,
          last_read_sequence = CASE WHEN last_read_sequence < @seq THEN @seq ELSE last_read_sequence END,
          last_read_at = CASE WHEN last_read_sequence < @seq THEN SYSUTCDATETIME() ELSE last_read_at END
        WHERE conversation_id = @cid AND actor_key = @actorKey;
      `);

    const msgRow = ins.recordset[0];
    const message = {
      ...msgRow,
      id: Number(msgRow.id),
      conversationId: Number(msgRow.conversationId),
      sequence: Number(msgRow.sequence),
      payload: null,
      createdAt: new Date(msgRow.createdAt).toISOString(),
    };

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "message:created",
      payload: {
        conversationId: cid,
        ownerKey: actor.actorKey,
        assignedUserId: row.assignedUserId ? String(row.assignedUserId) : null,
        accommodationId: row.accommodationId ? Number(row.accommodationId) : null,
        message,
        visibility: "PUBLIC",
      },
    });

    if (row.handlingMode === "AI" && dueAt) {
      await enqueueOutbox(tx, {
        kind: "AI_SCHEDULE",
        conversationId: cid,
        eventName: "ai:schedule",
        payload: { conversationId: cid, controlRevision: Number(row.controlRevision) },
        availableAt: dueAt,
      });
    }

    return { duplicate: false, message };
  });

  return txRes;
}

/**
 * Customer/Guest explicitly requests connection to the accommodation's Manager (5-minute timeout).
 * Rejects auto-escalation from PLATFORM without picking accommodation first.
 */
async function requestHumanSupport(actor, conversationId, { reason = null } = {}) {
  const cid = Number(conversationId);
  const result = await withTransaction(async (tx) => {
    await lockConversationsInOrder(tx, [cid]);
    const row = await assertOwnerConversation(actor, cid, tx);

    if (row.status !== "OPEN") {
      throw chatError(409, "CONVERSATION_RESOLVED", "Hội thoại đã kết thúc.");
    }
    if (row.scopeType !== "PROPERTY" || !row.accommodationId) {
      throw chatError(
        400,
        "PROPERTY_SELECTION_REQUIRED",
        "Vui lòng chọn Điểm đến và Cơ sở lưu trú bạn muốn liên hệ trước khi kết nối với Quản lý.",
      );
    }
    if (row.handlingMode === "HUMAN" || row.handlingMode === "WAITING_HUMAN") {
      return {
        alreadyWaiting: true,
        supported: true,
        handoffId: row.currentHandoffId ? Number(row.currentHandoffId) : null,
      };
    }

    const accomId = Number(row.accommodationId);
    await lockAccommodationsInOrder(tx, [accomId]);

    const settingsRes = await newRequest(tx)
      .input("accomId", sqlObj.Int, accomId)
      .query(`
        SELECT TOP 1 human_handoff_enabled AS humanHandoffEnabled, claim_timeout_seconds AS claimTimeoutSeconds
        FROM dbo.chat_support_settings
        WHERE accommodation_id = @accomId OR accommodation_id IS NULL
        ORDER BY CASE WHEN accommodation_id = @accomId THEN 0 ELSE 1 END;
      `);

    const humanEnabled = settingsRes.recordset[0] ? Boolean(settingsRes.recordset[0].humanHandoffEnabled) : true;
    const claimTimeoutSec = Number(settingsRes.recordset[0]?.claimTimeoutSeconds || config.claimTimeoutSeconds);

    const mgrRes = await newRequest(tx)
      .input("accomId", sqlObj.Int, accomId)
      .query(`
        SELECT TOP 1
          e.id AS epochId,
          e.user_id AS managerUserId,
          e.assigned_at_utc AS assignedAtUtc,
          u.full_name AS managerName
        FROM dbo.chat_manager_assignment_epochs AS e
        INNER JOIN dbo.users AS u ON u.id = e.user_id
        WHERE e.accommodation_id = @accomId
          AND e.revoked_at_utc IS NULL
          AND u.status = 1
          AND u.must_change_password = 0;
      `);

    const activeMgr = mgrRes.recordset[0];
    if (!humanEnabled || !activeMgr) {
      // No active manager (or handoff disabled for property): keep AI active and provide direct contact info
      const contactLines = [
        row.accommodationPhone ? `• SĐT: ${row.accommodationPhone}` : null,
        row.accommodationEmail ? `• Email: ${row.accommodationEmail}` : null,
        row.accommodationWebsite ? `• Website: ${row.accommodationWebsite}` : null,
        row.accommodationAddress ? `• Địa chỉ: ${row.accommodationAddress}` : null,
      ].filter(Boolean);

      const fallbackText = `Hiện tại ${row.accommodationName || "cơ sở này"} chưa bật kênh trò chuyện trực tiếp với Quản lý. Quý khách có thể tiếp tục hỏi Trợ lý AI ngay tại đây hoặc liên hệ trực tiếp cơ sở${contactLines.length ? `:\n${contactLines.join("\n")}` : "."}`;
      const sysMsg = await appendSystemMessage(tx, cid, fallbackText);

      await enqueueOutbox(tx, {
        kind: "SOCKET_EVENT",
        conversationId: cid,
        eventName: "message:created",
        payload: { conversationId: cid, ownerKey: actor.actorKey, message: sysMsg, visibility: "PUBLIC" },
      });

      return {
        supported: false,
        contact: {
          phone: row.accommodationPhone,
          email: row.accommodationEmail,
          websiteUrl: row.accommodationWebsite,
          addressLine: row.accommodationAddress,
        },
        message: fallbackText,
      };
    }

    // Compute visible_from_sequence protecting messages prior to current manager's assignment epoch
    const seqEpochRes = await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("epochAssigned", sqlObj.DateTime2(3), activeMgr.assignedAtUtc)
      .query(`
        SELECT COALESCE(
          (SELECT MIN(sequence) FROM dbo.chat_messages WHERE conversation_id = @cid AND created_at >= @epochAssigned AND visibility = 'PUBLIC'),
          (SELECT last_sequence + 1 FROM dbo.chat_conversations WHERE id = @cid)
        ) AS visibleFromSeq;
      `);
    const visibleFromSeq = Number(seqEpochRes.recordset[0]?.visibleFromSeq || 1);

    const expiresAt = new Date(Date.now() + claimTimeoutSec * 1000);

    // Cancel any AI runs in flight
    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .query(`
        UPDATE dbo.chat_ai_runs
        SET status = 'CANCELLED', completed_at = SYSUTCDATETIME()
        WHERE conversation_id = @cid AND status IN ('QUEUED', 'RUNNING');
      `);

    const handoffRes = await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("accomId", sqlObj.Int, accomId)
      .input("reqActor", sqlObj.VarChar(100), actor.actorKey)
      .input("reqType", sqlObj.VarChar(16), actor.type === "CUSTOMER" ? "CUSTOMER" : "GUEST")
      .input("mgrId", sqlObj.UniqueIdentifier, activeMgr.managerUserId)
      .input("epochId", sqlObj.BigInt, Number(activeMgr.epochId))
      .input("visFrom", sqlObj.BigInt, visibleFromSeq)
      .input("reason", sqlObj.NVarChar(500), reason ? String(reason).slice(0, 480) : null)
      .input("expiresAt", sqlObj.DateTime2(3), expiresAt)
      .query(`
        INSERT INTO dbo.chat_handoff_sessions (
          conversation_id, accommodation_id, requested_by_actor_key, requester_type,
          target_manager_user_id, manager_assignment_epoch_id, status,
          visible_from_sequence, reason, expires_at
        )
        OUTPUT INSERTED.id, INSERTED.requested_at AS requestedAt
        VALUES (
          @cid, @accomId, @reqActor, @reqType,
          @mgrId, @epochId, 'PENDING',
          @visFrom, @reason, @expiresAt
        );
      `);

    const handoffId = Number(handoffRes.recordset[0].id);

    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("hid", sqlObj.BigInt, handoffId)
      .input("epochId", sqlObj.BigInt, Number(activeMgr.epochId))
      .input("expiresAt", sqlObj.DateTime2(3), expiresAt)
      .query(`
        UPDATE dbo.chat_conversations
        SET handling_mode = 'WAITING_HUMAN',
            assigned_user_id = NULL,
            current_handoff_id = @hid,
            manager_assignment_epoch_id = @epochId,
            manager_wait_expires_at = @expiresAt,
            guest_ai_close_at = NULL,
            temporary_cleanup_at = NULL,
            ai_due_at = NULL,
            control_revision = control_revision + 1,
            updated_at = SYSUTCDATETIME()
        WHERE id = @cid;
      `);

    const waitNotice = `Đã gửi yêu cầu kết nối tới Quản lý ${row.accommodationName}. Vui lòng chờ trong giây lát để Quản lý tiếp nhận (tối đa 5 phút).`;
    const sysMsg = await appendSystemMessage(tx, cid, waitNotice, { handoffId });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "message:created",
      payload: {
        conversationId: cid,
        ownerKey: actor.actorKey,
        targetManagerUserId: String(activeMgr.managerUserId),
        message: sysMsg,
        visibility: "PUBLIC",
      },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "handoff:requested",
      payload: {
        handoffId,
        conversationId: cid,
        accommodationId: accomId,
        accommodationName: row.accommodationName,
        managerUserId: String(activeMgr.managerUserId),
        requesterType: actor.type === "CUSTOMER" ? "CUSTOMER" : "GUEST",
        requesterName: actor.displayName,
        expiresAt: expiresAt.toISOString(),
        timeoutSeconds: claimTimeoutSec,
      },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "queue:updated",
      payload: {
        accommodationId: accomId,
        managerUserId: String(activeMgr.managerUserId),
        conversationId: cid,
        action: "REQUESTED",
      },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "conversation:updated",
      payload: {
        conversationId: cid,
        handlingMode: "WAITING_HUMAN",
        currentHandoffId: handoffId,
        managerWaitExpiresAt: expiresAt.toISOString(),
      },
    });

    return {
      supported: true,
      handoffId,
      expiresAt: expiresAt.toISOString(),
    };
  });

  const conversation = await getOwnerConversationDetail(actor, cid);
  return { ...result, conversation };
}

async function cancelHumanSupport(actor, conversationId) {
  const cid = Number(conversationId);
  await withTransaction(async (tx) => {
    await lockConversationsInOrder(tx, [cid]);
    const row = await assertOwnerConversation(actor, cid, tx);
    if (row.handlingMode !== "WAITING_HUMAN") return;

    await newRequest(tx)
      .input("cid", sqlObj.BigInt, cid)
      .input("hid", sqlObj.BigInt, row.currentHandoffId || 0)
      .input("tempSec", sqlObj.Int, config.guestTempCleanupSeconds)
      .query(`
        UPDATE dbo.chat_handoff_sessions
        SET status = 'CANCELLED', ended_at = SYSUTCDATETIME(), ended_reason = 'CUSTOMER_CANCELLED'
        WHERE id = @hid AND status = 'PENDING';

        UPDATE dbo.chat_conversations
        SET handling_mode = 'AI',
            assigned_user_id = NULL,
            current_handoff_id = NULL,
            manager_wait_expires_at = NULL,
            temporary_cleanup_at = CASE
              WHEN retention_state = 'TEMPORARY' AND customer_user_id IS NULL THEN DATEADD(second, @tempSec, SYSUTCDATETIME())
              ELSE temporary_cleanup_at
            END,
            control_revision = control_revision + 1,
            updated_at = SYSUTCDATETIME()
        WHERE id = @cid;
      `);

    const sysMsg = await appendSystemMessage(
      tx,
      cid,
      "Quý khách đã hủy yêu cầu chờ kết nối Quản lý. Trợ lý AI VietPeace Stay sẵn sàng tiếp tục hỗ trợ bạn ngay.",
    );

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "message:created",
      payload: { conversationId: cid, ownerKey: actor.actorKey, message: sysMsg, visibility: "PUBLIC" },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "queue:updated",
      payload: { accommodationId: row.accommodationId ? Number(row.accommodationId) : null, conversationId: cid, action: "CANCELLED" },
    });

    await enqueueOutbox(tx, {
      kind: "SOCKET_EVENT",
      conversationId: cid,
      eventName: "conversation:updated",
      payload: { conversationId: cid, handlingMode: "AI", currentHandoffId: null, managerWaitExpiresAt: null },
    });
  });

  return getOwnerConversationDetail(actor, cid);
}

async function endGuestConversation(actor, conversationId) {
  if (!actor || actor.type !== "GUEST") {
    throw chatError(403, "GUEST_ONLY", "Chỉ phiên khách vãng lai mới áp dụng kết thúc và xóa phiên tạm.");
  }
  const cid = Number(conversationId);
  await withTransaction(async (tx) => {
    await lockConversationsInOrder(tx, [cid]);
    const row = await assertOwnerConversation(actor, cid, tx);
    if (row.retentionState !== "TEMPORARY" || row.customerUserId) {
      throw chatError(409, "NOT_TEMPORARY", "Hội thoại không phải phiên tạm.");
    }
    await hardDeleteTemporaryConversation(tx, cid, {
      ownerKey: actor.actorKey,
      reason: "GUEST_ENDED",
      notice: "Phiên trò chuyện tạm đã được kết thúc và dọn sạch theo yêu cầu của Quý khách.",
    });
  });
  return { erased: true, conversationId: cid };
}

async function transferScopeOrReopen(actor, conversationId, body = {}) {
  const targetScope = body.scopeType === "PROPERTY" ? "PROPERTY" : "PLATFORM";
  const targetAccomId = targetScope === "PROPERTY" ? Number(body.accommodationId) : null;
  if (conversationId) {
    // Reopen resolved customer conversation or transfer cleanly
    const existing = await assertOwnerConversation(actor, conversationId).catch(() => null);
    if (existing && existing.status === "RESOLVED" && !body.scopeType) {
      await getDBPool()
        .request()
        .input("cid", sqlObj.BigInt, Number(conversationId))
        .query(`
          UPDATE dbo.chat_conversations
          SET status = 'OPEN', handling_mode = 'AI', resolved_at = NULL, control_revision = control_revision + 1, updated_at = SYSUTCDATETIME()
          WHERE id = @cid;
        `);
      return getOwnerConversationDetail(actor, conversationId);
    }
  }
  return openOrReuseConversation(actor, {
    scopeType: targetScope,
    accommodationId: targetAccomId,
    pageContext: body.pageContext || {
      pageType: targetScope === "PROPERTY" ? "ACCOMMODATION_DETAIL" : "HOME",
      accommodationId: targetAccomId,
    },
  });
}

/**
 * Mark PUBLIC counterparty messages delivered or read by Owner.
 * Updates chat_participants monotonically and broadcasts delivery/read updates to active manager.
 */
async function updateOwnerReceipt(actor, conversationId, sequence, { kind = "delivered" } = {}) {
  const cid = Number(conversationId);
  const seq = Number(sequence);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;

  return withTransaction(async (tx) => {
    const conv = await assertOwnerConversation(actor, cid, tx);
    const maxSeq = Math.min(seq, Number(conv.lastSequence));

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
    const payload = {
      conversationId: cid,
      ownerKey: actor.actorKey,
      assignedUserId: conv.assignedUserId ? String(conv.assignedUserId) : null,
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

async function syncOwnerDeliveredAll(actor) {
  const pool = getDBPool();
  const res = await pool
    .request()
    .input("uid", sqlObj.UniqueIdentifier, actor.type === "CUSTOMER" ? actor.userId : null)
    .input("gid", sqlObj.UniqueIdentifier, actor.type === "GUEST" ? actor.guestSessionId : null)
    .query(`
      SELECT c.id, c.last_sequence AS lastSequence
      FROM dbo.chat_conversations AS c
      INNER JOIN dbo.chat_participants AS p ON p.conversation_id = c.id AND p.actor_key = @actorKey
      WHERE c.status = 'OPEN'
        AND c.last_sequence > p.last_delivered_sequence
        AND (
          (@uid IS NOT NULL AND c.customer_user_id = @uid)
          OR (@gid IS NOT NULL AND c.guest_session_id = @gid)
        );
    `.replace("@actorKey", `'${actor.actorKey.replace(/'/g, "''")}'`));

  const updated = [];
  for (const row of res.recordset) {
    const r = await updateOwnerReceipt(actor, Number(row.id), Number(row.lastSequence), { kind: "delivered" });
    if (r) updated.push(r);
  }
  return updated;
}

async function claimGuestConversationsToCustomer(customerActor, guestSessionId) {
  if (!customerActor || customerActor.type !== "CUSTOMER" || !guestSessionId) {
    return { claimedCount: 0, mergedCount: 0 };
  }

  return withTransaction(async (tx) => {
    await lockUsersInOrder(tx, [customerActor.userId]);
    await lockGuestSessionsInOrder(tx, [guestSessionId]);

    const guestConvsRes = await newRequest(tx)
      .input("gid", sqlObj.UniqueIdentifier, guestSessionId)
      .query(`
        SELECT id, scope_type AS scopeType, accommodation_id AS accommodationId, booking_id AS bookingId
        FROM dbo.chat_conversations WITH (UPDLOCK, HOLDLOCK)
        WHERE guest_session_id = @gid AND status = 'OPEN'
        ORDER BY id ASC;
      `);

    const guestConvs = guestConvsRes.recordset;
    if (guestConvs.length === 0) {
      await newRequest(tx)
        .input("gid", sqlObj.UniqueIdentifier, guestSessionId)
        .input("uid", sqlObj.UniqueIdentifier, customerActor.userId)
        .query(`
          UPDATE dbo.chat_guest_sessions
          SET claimed_by_user_id = @uid
          WHERE id = @gid AND claimed_by_user_id IS NULL;
        `);
      return { claimedCount: 0, mergedCount: 0 };
    }

    const accomIds = guestConvs.map((c) => c.accommodationId).filter(Boolean);
    if (accomIds.length > 0) await lockAccommodationsInOrder(tx, accomIds);

    let claimedCount = 0;
    let mergedCount = 0;

    for (const gConv of guestConvs) {
      const gCid = Number(gConv.id);
      const dupRes = await newRequest(tx)
        .input("uid", sqlObj.UniqueIdentifier, customerActor.userId)
        .input("scope", sqlObj.VarChar(16), gConv.scopeType)
        .input("accomId", sqlObj.Int, gConv.accommodationId || null)
        .input("bookingId", sqlObj.BigInt, gConv.bookingId || null)
        .query(`
          SELECT TOP 1 id
          FROM dbo.chat_conversations WITH (UPDLOCK, HOLDLOCK)
          WHERE customer_user_id = @uid
            AND status = 'OPEN'
            AND scope_type = @scope
            AND ((accommodation_id IS NULL AND @accomId IS NULL) OR accommodation_id = @accomId)
            AND ((booking_id IS NULL AND @bookingId IS NULL) OR booking_id = @bookingId);
        `);

      if (dupRes.recordset[0]) {
        const targetCid = Number(dupRes.recordset[0].id);
        await lockConversationsInOrder(tx, [Math.min(gCid, targetCid), Math.max(gCid, targetCid)]);
        await hardDeleteTemporaryConversation(tx, gCid, {
          ownerKey: actorKeyForGuest(guestSessionId),
          reason: "CLAIMED_MERGED",
          notice: "Hội thoại tạm đã được đồng bộ vào tài khoản của Quý khách.",
        });
        mergedCount += 1;
      } else {
        await lockConversationsInOrder(tx, [gCid]);
        await newRequest(tx)
          .input("cid", sqlObj.BigInt, gCid)
          .input("uid", sqlObj.UniqueIdentifier, customerActor.userId)
          .input("gid", sqlObj.UniqueIdentifier, guestSessionId)
          .input("custKey", sqlObj.VarChar(100), customerActor.actorKey)
          .query(`
            UPDATE dbo.chat_conversations
            SET customer_user_id = @uid,
                guest_session_id = NULL,
                origin_guest_session_id = @gid,
                retention_state = 'PERSISTENT',
                guest_ai_close_at = NULL,
                temporary_cleanup_at = NULL,
                control_revision = control_revision + 1,
                updated_at = SYSUTCDATETIME()
            WHERE id = @cid;

            IF NOT EXISTS (SELECT 1 FROM dbo.chat_participants WHERE conversation_id = @cid AND actor_key = @custKey)
            BEGIN
              INSERT INTO dbo.chat_participants (
                conversation_id, actor_key, user_id, participant_role,
                last_delivered_sequence, last_delivered_at, last_read_sequence, last_read_at
              )
              SELECT TOP 1
                @cid, @custKey, @uid, 'CUSTOMER',
                last_delivered_sequence, last_delivered_at, last_read_sequence, last_read_at
              FROM dbo.chat_participants
              WHERE conversation_id = @cid AND guest_session_id = @gid;
            END;
          `);
        claimedCount += 1;
      }
    }

    await newRequest(tx)
      .input("gid", sqlObj.UniqueIdentifier, guestSessionId)
      .input("uid", sqlObj.UniqueIdentifier, customerActor.userId)
      .query(`
        UPDATE dbo.chat_guest_sessions
        SET claimed_by_user_id = @uid
        WHERE id = @gid AND claimed_by_user_id IS NULL;
      `);

    return { claimedCount, mergedCount };
  });
}

async function listHandoffGuideDestinations() {
  return getFeaturedDestinations(30);
}

async function listHandoffGuideAccommodations(locationId) {
  const pool = getDBPool();
  const locId = Number(locationId);
  if (!Number.isSafeInteger(locId) || locId < 1) {
    throw chatError(400, "INVALID_LOCATION_ID", "Thiếu locationId hợp lệ.");
  }

  const res = await pool
    .request()
    .input("locId", sqlObj.Int, locId)
    .query(`
      WITH LocTree AS (
        SELECT id FROM dbo.locations WHERE id = @locId AND is_active = 1
        UNION ALL
        SELECT l.id FROM dbo.locations l INNER JOIN LocTree t ON l.parent_id = t.id WHERE l.is_active = 1
      )
      SELECT
        a.id AS accommodationId,
        a.accommodation_name AS accommodationName,
        atp.name AS accommodationTypeName,
        a.star_rating AS starRating,
        a.address_line AS addressLine,
        a.phone,
        a.email,
        a.website_url AS websiteUrl,
        img.image_url AS coverImage,
        CASE WHEN e.id IS NOT NULL AND u.status = 1 AND u.must_change_password = 0
             THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS hasActiveManager,
        u.full_name AS managerName
      FROM dbo.accommodations AS a
      INNER JOIN LocTree lt ON lt.id = a.location_id
      LEFT JOIN dbo.accommodation_types AS atp ON atp.id = a.accommodation_type_id
      OUTER APPLY (
        SELECT TOP 1 image_url FROM dbo.accommodation_images ai
        WHERE ai.accommodation_id = a.id
        ORDER BY ai.is_cover DESC, ai.sort_order ASC, ai.id ASC
      ) AS img
      LEFT JOIN dbo.chat_manager_assignment_epochs AS e
        ON e.accommodation_id = a.id AND e.revoked_at_utc IS NULL
      LEFT JOIN dbo.users AS u ON u.id = e.user_id
      WHERE a.status = 1 AND a.deleted_at IS NULL
      ORDER BY hasActiveManager DESC, a.is_featured DESC, a.sort_order ASC, a.id ASC;
    `);

  return res.recordset.map((r) => ({
    ...r,
    accommodationId: Number(r.accommodationId),
    hasActiveManager: Boolean(r.hasActiveManager),
  }));
}

module.exports = {
  POLITE_HOME_GREETING,
  getFeaturedDestinations,
  resolveVerifiedPageContext,
  listOwnerConversations,
  getOwnerConversationDetail,
  getOwnerConversationMessages,
  openOrReuseConversation,
  updateConversationContext,
  sendOwnerMessage,
  requestHumanSupport,
  cancelHumanSupport,
  endGuestConversation,
  transferScopeOrReopen,
  updateOwnerReceipt,
  syncOwnerDeliveredAll,
  claimGuestConversationsToCustomer,
  listHandoffGuideDestinations,
  listHandoffGuideAccommodations,
};

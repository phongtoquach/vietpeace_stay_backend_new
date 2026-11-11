// Pipeline chính chatbot customer (T07, theo workspace/security-guard.md mục 2
// và workspace/service-dto.md). Mọi lookup/operation đều kiểm tra ownership ở đây.

const sql = require("mssql");
const db = require("../../configs/database");
const { ERROR_CODES } = require("../../constants/error_codes");
const { randomInt } = require("node:crypto");
const {
    REFUSAL_TEMPLATES, FALLBACK_REPLY, AUTH_REQUIRED_REPLY,
    CONFIRM_CANCEL_REPLY, CANCELLED_REPLY, AUDIT_ACTIONS,
} = require("../../constants/chatbot");
const { guardMessage, normalizeVietnamese } = require("./rule_guard");
const modelAdapter = require("./model_adapter");
const modelSchema = require("./model_schema");
const bookingWebService = require("../booking_web_service");

const MAX_MESSAGE_LENGTH = 2000;
const PENDING_CANCEL_TTL_MS = 15 * 60 * 1000;

// P4 confirmation hủy booking — in-memory MVP (server restart mất pending, TTL 15 phút)
const pendingCancels = new Map();

// Quota tạo ticket chống spam (T12): tối đa 5 ticket / giờ / conversation.
const TICKET_QUOTA = 5;
const TICKET_QUOTA_WINDOW_MS = 60 * 60 * 1000;
const ticketTimestamps = new Map(); // conversationId -> timestamp[]
const conversationLocks = new Map();
const ticketQuotaLocks = new Map();

async function withKeyLock(lockMap, key, operation) {
    const previous = lockMap.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    lockMap.set(key, current);
    await previous;
    try {
        return await operation();
    } finally {
        release();
        if (lockMap.get(key) === current) {
            lockMap.delete(key);
        }
    }
}

function ticketQuotaExceeded(conversationId) {
    const now = Date.now();
    const timestamps = (ticketTimestamps.get(conversationId) || [])
        .filter((ts) => now - ts < TICKET_QUOTA_WINDOW_MS);
    ticketTimestamps.set(conversationId, timestamps);
    return timestamps.length >= TICKET_QUOTA;
}

function recordTicketCreated(conversationId) {
    const timestamps = ticketTimestamps.get(conversationId) || [];
    timestamps.push(Date.now());
    ticketTimestamps.set(conversationId, timestamps);
}

class ChatbotError extends Error {
    constructor(message, statusCode = 400, errorCode = ERROR_CODES.VALIDATION_ERROR) {
        super(message);
        this.statusCode = statusCode;
        this.errorCode = errorCode;
    }
}

function badRequest(message) {
    return new ChatbotError(message, 400, ERROR_CODES.VALIDATION_ERROR);
}

// ---------- persistence ----------

async function getOrCreateConversation(pool, sessionKey, userId) {
    return withKeyLock(conversationLocks, `${sessionKey}|${userId ?? "guest"}`, async () => {
    const existing = await pool.request()
        .input("sessionKey", sql.VarChar(64), sessionKey)
        .query(`
            SELECT id, user_id, status
            FROM dbo.conversations
            WHERE session_key = @sessionKey AND status = 'ACTIVE'
            ORDER BY id DESC;
        `);

    const row = existing.recordset[0];
    if (row) {
        const sameOwner = userId
            ? row.user_id === userId
            : row.user_id === null;
        if (sameOwner) {
            return { id: row.id };
        }
        // Session key tái sử dụng nhưng owner khác -> tạo conversation mới
    }

    const inserted = await pool.request()
        .input("sessionKey", sql.VarChar(64), sessionKey)
        .input("userId", sql.UniqueIdentifier, userId ?? null)
        .query(`
            INSERT INTO dbo.conversations (session_key, user_id, status)
            OUTPUT INSERTED.id
            VALUES (@sessionKey, @userId, 'ACTIVE');
        `);

    return { id: inserted.recordset[0].id };
    });
}

async function insertMessage(pool, conversationId, senderType, senderUserId, content, isInternalNote = false) {
    await pool.request()
        .input("conversationId", sql.BigInt, conversationId)
        .input("senderType", sql.VarChar(20), senderType)
        .input("senderUserId", sql.UniqueIdentifier, senderUserId ?? null)
        .input("content", sql.NVarChar(sql.MAX), content)
        .input("isInternalNote", sql.Bit, isInternalNote ? 1 : 0)
        .query(`
            INSERT INTO dbo.messages (conversation_id, sender_type, sender_user_id, content, is_internal_note)
            VALUES (@conversationId, @senderType, @senderUserId, @content, @isInternalNote);
        `);
}

async function getRecentMessages(pool, conversationId, limit = 10) {
    const result = await pool.request()
        .input("conversationId", sql.BigInt, conversationId)
        .input("limit", sql.Int, limit)
        .query(`
            SELECT TOP (@limit) sender_type, content
            FROM dbo.messages
            WHERE conversation_id = @conversationId
            ORDER BY id DESC;
        `);

    return result.recordset.reverse();
}

async function writeAudit(pool, {
    actorType, actorUserId, action, resourceType = null, resourceId = null,
    decision, reason = null, detail = null,
}) {
    try {
        await pool.request()
            .input("actorType", sql.VarChar(30), actorType)
            .input("actorUserId", sql.UniqueIdentifier, actorUserId ?? null)
            .input("action", sql.VarChar(100), action)
            .input("resourceType", sql.VarChar(50), resourceType)
            .input("resourceId", sql.BigInt, resourceId)
            .input("decision", sql.VarChar(20), decision)
            .input("reason", sql.NVarChar(1000), reason)
            .input("detailJson", sql.NVarChar(sql.MAX), detail ? JSON.stringify(detail) : null)
            .query(`
                INSERT INTO dbo.audit_logs
                    (actor_type, actor_user_id, action, resource_type, resource_id, decision, reason, detail_json)
                VALUES
                    (@actorType, @actorUserId, @action, @resourceType, @resourceId, @decision, @reason, @detailJson);
            `);
    } catch (error) {
        // audit không được làm hỏng flow chính
        console.error("[chatbot_service] audit failed:", error.message);
    }
}

// ---------- data actions ----------

async function searchKnowledge(pool, query, limit = 3) {
    for (const term of buildSearchTerms(query)) {
        const like = `%${term}%`;
        const result = await pool.request()
            .input("like", sql.NVarChar(200), like)
            .input("limit", sql.Int, limit)
            .query(`
                SELECT TOP (@limit) title, content
                FROM dbo.knowledge_articles
                WHERE is_active = 1
                  AND (title LIKE @like OR keywords LIKE @like OR content LIKE @like)
                ORDER BY id DESC;
            `);
        if (result.recordset.length) {
            return result.recordset;
        }
    }
    return [];
}

// Stopword tiếng Việt thường gặp trong câu hỏi — bỏ khi sinh từ khóa tìm kiếm
const SEARCH_STOPWORDS = new Set([
    "tất", "cả", "các", "loại", "phòng", "khách", "sạn", "có", "là", "gì",
    "của", "tại", "và", "cho", "với", "mình", "tôi", "bạn", "giá", "bao",
    "nhiêu", "nào", "đâu", "một", "hai", "kiem", "tra",
]);

// Sinh danh sách từ khóa thử dần: câu gốc -> cụm từ dài -> từng từ riêng.
function buildSearchTerms(query) {
    const clean = String(query ?? "").replace(/[%_]/g, "").trim();
    if (!clean) {
        return [];
    }
    const words = clean.split(/\s+/).filter((word) => word.length >= 3 && !SEARCH_STOPWORDS.has(word.toLowerCase()));
    const terms = [clean];
    for (let take = Math.min(words.length, 3); take >= 1; take -= 1) {
        terms.push(words.slice(0, take).join(" "));
        if (words.length > take) {
            terms.push(words.slice(-take).join(" "));
        }
    }
    return [...new Set(terms.filter(Boolean))];
}

async function searchAccommodations(pool, query, limit = 3) {
    for (const term of buildSearchTerms(query)) {
        const found = await searchAccommodationsByPattern(pool, term, limit);
        if (found.length) {
            return found;
        }
    }
    return [];
}

async function searchAccommodationsByPattern(pool, pattern, limit = 3) {
    const like = `%${pattern}%`;
    const result = await pool.request()
        .input("like", sql.NVarChar(200), like)
        .input("limit", sql.Int, limit)
        .query(`
            SELECT TOP (@limit)
                a.id, a.accommodation_name, a.address_line, a.star_rating,
                l.name AS location_name, p.name AS province_name
            FROM dbo.accommodations a
            INNER JOIN dbo.locations l ON l.id = a.location_id
            INNER JOIN dbo.provinces p ON p.id = a.province_id
            WHERE a.deleted_at IS NULL AND a.status = 1
              AND (a.accommodation_name LIKE @like
                   OR a.short_description LIKE @like
                   OR l.name LIKE @like
                   OR p.name LIKE @like
                   OR EXISTS (
                       SELECT 1
                       FROM dbo.room_types rtq
                       WHERE rtq.accommodation_id = a.id
                         AND rtq.deleted_at IS NULL
                         AND rtq.status = 1
                         AND (rtq.name LIKE @like OR rtq.code LIKE @like)
                   ))
            ORDER BY a.is_featured DESC, a.sort_order ASC;
        `);

    const accommodations = result.recordset;
    if (!accommodations.length) {
        return [];
    }

    const ids = accommodations.map((row) => row.id);
    const roomResult = await pool.request()
        .query(`
            SELECT rt.accommodation_id, rt.name, rt.base_price, rt.max_occupancy
            FROM dbo.room_types rt
            WHERE rt.deleted_at IS NULL AND rt.status = 1
              AND rt.accommodation_id IN (${ids.join(",")})
            ORDER BY rt.base_price ASC;
        `);

    return accommodations.map((row) => ({
        ...row,
        room_types: roomResult.recordset.filter((room) => room.accommodation_id === row.id).slice(0, 3),
    }));
}

const AMENITY_ALIASES = Object.freeze({
    "ho boi": ["hồ bơi", "bể bơi", "swimming pool", "pool"],
    "be boi": ["hồ bơi", "bể bơi", "swimming pool", "pool"],
    wifi: ["wifi", "wi-fi", "internet"],
    gym: ["gym", "fitness", "phòng tập", "phong tap"],
    spa: ["spa", "massage"],
    "bai do xe": ["bãi đỗ xe", "bãi giữ xe", "parking", "car park"],
});

function buildAmenityTerms(query) {
    const clean = String(query ?? "").replace(/[%_]/g, "").trim();
    if (!clean) return [];

    const parts = clean.split(/\s+(?:và|and)\s+|[,;&]/i)
        .map((part) => part.trim())
        .filter(Boolean);
    const terms = [];
    for (const part of parts.length ? parts : [clean]) {
        const normalized = normalizeVietnamese(part);
        terms.push(part);
        terms.push(...(AMENITY_ALIASES[normalized] || []));
    }
    return [...new Set(terms.filter((term) => term.length >= 2))];
}

function inferAmenityQuery(content, topic = "") {
    const haystack = normalizeVietnamese(`${content || ""} ${topic || ""}`);
    for (const [canonical, aliases] of Object.entries(AMENITY_ALIASES)) {
        if (haystack.includes(canonical) || aliases.some((alias) => haystack.includes(normalizeVietnamese(alias)))) {
            return canonical;
        }
    }
    return "";
}

async function searchAccommodationAmenities(pool, query, locationQuery = "", limit = 10) {
    const parts = String(query ?? "").split(/\s+(?:và|and)\s+|[,;&]/i)
        .map((part) => part.trim())
        .filter(Boolean);
    const requestedParts = parts.length ? parts : [String(query ?? "").trim()];
    if (!requestedParts[0]) return [];

    const rows = [];
    const locationLike = `%${String(locationQuery || "").replace(/[%_]/g, "").trim()}%`;
    for (const requestedPart of requestedParts) {
        for (const term of buildAmenityTerms(requestedPart)) {
            const result = await pool.request()
                .input("amenityLike", sql.NVarChar(200), `%${term}%`)
                .input("locationLike", sql.NVarChar(200), locationLike)
                .input("limit", sql.Int, limit)
                .query(`
                SELECT TOP (@limit)
                    a.id, a.accommodation_name, a.address_line,
                    am.name AS amenity_name, am.code AS amenity_code,
                    am.description AS amenity_description,
                    'accommodation' AS amenity_scope
                FROM dbo.accommodation_amenities aa
                INNER JOIN dbo.accommodations a ON a.id = aa.accommodation_id
                INNER JOIN dbo.amenities am ON am.id = aa.amenity_id
                INNER JOIN dbo.locations l ON l.id = a.location_id
                INNER JOIN dbo.provinces p ON p.id = a.province_id
                WHERE a.deleted_at IS NULL AND a.status = 1
                  AND am.is_active = 1
                  AND (@locationLike = '%%' OR l.name LIKE @locationLike OR p.name LIKE @locationLike OR a.accommodation_name LIKE @locationLike)
                  AND (am.name LIKE @amenityLike
                       OR am.code LIKE @amenityLike
                       OR am.description LIKE @amenityLike)
                UNION ALL
                SELECT TOP (@limit)
                    a.id, a.accommodation_name, a.address_line,
                    am.name AS amenity_name, am.code AS amenity_code,
                    am.description AS amenity_description,
                    'room' AS amenity_scope
                FROM dbo.room_type_amenities rta
                INNER JOIN dbo.room_types rt ON rt.id = rta.room_type_id
                INNER JOIN dbo.accommodations a ON a.id = rt.accommodation_id
                INNER JOIN dbo.amenities am ON am.id = rta.amenity_id
                INNER JOIN dbo.locations l ON l.id = a.location_id
                INNER JOIN dbo.provinces p ON p.id = a.province_id
                WHERE a.deleted_at IS NULL AND a.status = 1
                  AND rt.deleted_at IS NULL AND rt.status = 1
                  AND am.is_active = 1
                  AND (@locationLike = '%%' OR l.name LIKE @locationLike OR p.name LIKE @locationLike OR a.accommodation_name LIKE @locationLike)
                  AND (am.name LIKE @amenityLike
                       OR am.code LIKE @amenityLike
                       OR am.description LIKE @amenityLike);
                `);
            rows.push(...(result.recordset || []).map((row) => ({ ...row, requested_part: requestedPart })));
        }
    }

    const grouped = new Map();
    for (const row of rows) {
        if (!grouped.has(row.id)) {
            grouped.set(row.id, {
                id: row.id,
                accommodation_name: row.accommodation_name,
                address_line: row.address_line,
                amenities: [],
                matched_parts: new Set(),
            });
        }
        const group = grouped.get(row.id);
        group.matched_parts.add(normalizeVietnamese(row.requested_part));
        const key = `${row.amenity_scope}:${row.amenity_code || row.amenity_name}`;
        if (!group.amenities.some((item) => item.key === key)) {
            group.amenities.push({
                key,
                name: row.amenity_name,
                description: row.amenity_description,
                scope: row.amenity_scope,
            });
        }
    }
    return [...grouped.values()]
        .filter((item) => item.matched_parts.size >= requestedParts.length)
        .map(({ matched_parts, ...item }) => item)
        .slice(0, limit);
}

async function listAccommodationAmenities(pool, accommodationQuery, limit = 10) {
    const result = await pool.request()
        .input("accommodationLike", sql.NVarChar(200), `%${String(accommodationQuery ?? "").trim()}%`)
        .input("limit", sql.Int, limit)
        .query(`
            SELECT TOP (@limit)
                a.id, a.accommodation_name, a.address_line,
                am.name AS amenity_name, am.code AS amenity_code,
                am.description AS amenity_description,
                'accommodation' AS amenity_scope
            FROM dbo.accommodations a
            INNER JOIN dbo.accommodation_amenities aa ON aa.accommodation_id = a.id
            INNER JOIN dbo.amenities am ON am.id = aa.amenity_id
            WHERE a.deleted_at IS NULL AND a.status = 1
              AND am.is_active = 1
              AND a.accommodation_name LIKE @accommodationLike
            UNION ALL
            SELECT TOP (@limit)
                a.id, a.accommodation_name, a.address_line,
                am.name AS amenity_name, am.code AS amenity_code,
                am.description AS amenity_description,
                'room' AS amenity_scope
            FROM dbo.accommodations a
            INNER JOIN dbo.room_types rt ON rt.accommodation_id = a.id
            INNER JOIN dbo.room_type_amenities rta ON rta.room_type_id = rt.id
            INNER JOIN dbo.amenities am ON am.id = rta.amenity_id
            WHERE a.deleted_at IS NULL AND a.status = 1
              AND rt.deleted_at IS NULL AND rt.status = 1
              AND am.is_active = 1
              AND a.accommodation_name LIKE @accommodationLike
            ORDER BY amenity_name;
        `);
    const grouped = new Map();
    for (const row of result.recordset || []) {
        if (!grouped.has(row.id)) {
            grouped.set(row.id, { id: row.id, accommodation_name: row.accommodation_name, amenities: [] });
        }
        const group = grouped.get(row.id);
        const key = `${row.amenity_scope}:${row.amenity_code || row.amenity_name}`;
        if (!group.amenities.some((item) => item.key === key)) {
            group.amenities.push({
                key,
                name: row.amenity_name,
                description: row.amenity_description,
                scope: row.amenity_scope,
            });
        }
    }
    return [...grouped.values()];
}

async function findAccommodationMentionedInMessage(pool, content) {
    const result = await pool.request()
        .input("content", sql.NVarChar(2000), String(content ?? ""))
        .query(`
            SELECT TOP 1 id, accommodation_name
            FROM dbo.accommodations
            WHERE status = 1
              AND deleted_at IS NULL
              AND @content LIKE N'%' + accommodation_name + N'%'
            ORDER BY LEN(accommodation_name) DESC, id ASC;
        `);
    return result.recordset?.[0] ?? null;
}

async function findLocationMentionedInMessage(pool, content) {
    const result = await pool.request()
        .input("content", sql.NVarChar(2000), String(content ?? ""))
        .query(`
            SELECT TOP 1 name
            FROM (
                SELECT name FROM dbo.locations WHERE name IS NOT NULL
                UNION ALL
                SELECT name FROM dbo.provinces WHERE name IS NOT NULL
            ) places
            WHERE @content LIKE N'%' + name + N'%'
            ORDER BY LEN(name) DESC;
        `);
    return result.recordset?.[0]?.name ?? "";
}

function formatAmenityReply(accommodations, query) {
    const title = query ? `có tiện nghi phù hợp với "${query}"` : "có các tiện nghi phù hợp";
    const lines = accommodations.map((accommodation, index) => {
        const amenities = accommodation.amenities
            .map((item) => `${item.name}${item.scope === "room" ? " (ở loại phòng)" : ""}`)
            .join(", ");
        return `${index + 1}. ${accommodation.accommodation_name}: ${amenities}`;
    });
    return [`Mình tìm thấy các cơ sở ${title}:`, ...lines,
        "Bạn muốn xem chi tiết cơ sở nào không ạ?"].join("\n");
}

// Tìm booking theo mã (không lọc user) — dùng để phân biệt not-found vs không thuộc quyền.
async function findBookingByCode(pool, bookingCode) {
    const result = await pool.request()
        .input("bookingCode", sql.VarChar(255), bookingCode)
        .query(`
            SELECT TOP 1 id, booking_code, user_id, accommodation_id, status, checked_in_at
            FROM dbo.bookings
            WHERE booking_code = @bookingCode;
        `);

    return result.recordset[0] ?? null;
}

async function getOwnBookingDetail(pool, userId, bookingCode) {
    const result = await pool.request()
        .input("bookingCode", sql.VarChar(255), bookingCode)
        .input("userId", sql.UniqueIdentifier, userId)
        .query(`
            SELECT TOP 1
                b.id, b.booking_code, b.accommodation_id, b.check_in_date, b.check_out_date, b.total_nights,
                b.status, b.total_amount, b.currency, b.contact_name,
                a.accommodation_name
            FROM dbo.bookings b
            INNER JOIN dbo.accommodations a ON a.id = b.accommodation_id
            WHERE b.booking_code = @bookingCode AND b.user_id = @userId;
        `);

    return result.recordset[0] ?? null;
}

async function getOwnPaymentDetail(pool, userId, bookingCode) {
    const result = await pool.request()
        .input("bookingCode", sql.VarChar(255), bookingCode)
        .input("userId", sql.UniqueIdentifier, userId)
        .query(`
            SELECT TOP 1
                pay.payment_code, pay.status, pay.payment_method, pay.amount, pay.currency, pay.paid_at,
                b.booking_code
            FROM dbo.payments pay
            INNER JOIN dbo.bookings b ON b.id = pay.booking_id
            WHERE b.booking_code = @bookingCode AND b.user_id = @userId
            ORDER BY pay.id DESC;
        `);

    return result.recordset[0] ?? null;
}

async function cancelOwnBooking(pool, userId, bookingId) {
    const result = await pool.request()
        .input("bookingId", sql.BigInt, bookingId)
        .input("userId", sql.UniqueIdentifier, userId)
        .query(`
            UPDATE dbo.bookings
            SET status = 'CANCELLED',
                cancelled_at = SYSUTCDATETIME(),
                cancellation_reason = N'Hủy qua chatbot theo yêu cầu của khách',
                updated_at = SYSUTCDATETIME()
            OUTPUT INSERTED.booking_code
            WHERE id = @bookingId AND user_id = @userId AND status = 'PENDING';
        `);

    return result.recordset[0] ?? null;
}

async function generateTicketCode(pool) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const code = `TK${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${randomInt(100000, 999999)}`;
        const existed = await pool.request()
            .input("code", sql.VarChar(50), code)
            .query("SELECT 1 FROM dbo.tickets WHERE ticket_code = @code;");
        if (!existed.recordset.length) {
            return code;
        }
    }
    throw new ChatbotError("Không sinh được mã ticket.", 500, ERROR_CODES.INTERNAL_ERROR);
}

async function insertTicket(pool, {
    ticketCode, userId, conversationId, bookingId = null, accommodationId = null,
    category, subject,
}) {
    const result = await pool.request()
        .input("ticketCode", sql.VarChar(50), ticketCode)
        .input("userId", sql.UniqueIdentifier, userId ?? null)
        .input("conversationId", sql.BigInt, conversationId)
        .input("bookingId", sql.BigInt, bookingId)
        .input("accommodationId", sql.Int, accommodationId)
        .input("category", sql.VarChar(50), category)
        .input("subject", sql.NVarChar(255), subject.slice(0, 255))
        .query(`
            INSERT INTO dbo.tickets
                (ticket_code, user_id, conversation_id, booking_id, accommodation_id, category, subject, status)
            OUTPUT INSERTED.id
            VALUES (@ticketCode, @userId, @conversationId, @bookingId, @accommodationId, @category, @subject, 'OPEN');
        `);

    return { id: result.recordset[0].id, ticket_code: ticketCode };
}

// ---------- reply composer ----------

function formatBookingReply(booking) {
    const checkIn = new Date(booking.check_in_date).toLocaleDateString("vi-VN");
    const checkOut = new Date(booking.check_out_date).toLocaleDateString("vi-VN");
    const amount = Number(booking.total_amount).toLocaleString("vi-VN");

    return [
        `Booking ${booking.booking_code} — ${booking.accommodation_name}`,
        `Nhận phòng: ${checkIn}, trả phòng: ${checkOut} (${booking.total_nights} đêm)`,
        `Trạng thái: ${booking.status}`,
        `Tổng tiền: ${amount} ${booking.currency}`,
    ].join("\n");
}

function formatPaymentReply(payment) {
    const paidAt = payment.paid_at ? new Date(payment.paid_at).toLocaleString("vi-VN") : "chưa thanh toán";
    const amount = Number(payment.amount).toLocaleString("vi-VN");

    return [
        `Thanh toán booking ${payment.booking_code}`,
        `Trạng thái: ${payment.status} — Số tiền: ${amount} ${payment.currency}`,
        `Phương thức: ${payment.payment_method} — Thời gian: ${paidAt}`,
    ].join("\n");
}

function formatAccommodationReply(accommodations) {
    const lines = accommodations.map((acc, index) => {
        const rooms = acc.room_types.length
            ? acc.room_types
                .map((room) => `${room.name} (${Number(room.base_price).toLocaleString("vi-VN")}đ/đêm)`)
                .join(", ")
            : "chưa có loại phòng công khai";
        const availability = acc.availability?.message
            ? ` Tình trạng: ${acc.availability.message}`
            : "";
        return `${index + 1}. ${acc.accommodation_name} — ${acc.location_name}, ${acc.province_name}. Phòng: ${rooms}.${availability}`;
    });

    return [
        "Mình tìm được các cơ sở lưu trú phù hợp:",
        ...lines,
        "Bạn muốn xem chi tiết cơ sở nào hoặc đặt phòng cho ngày nào ạ?",
    ].join("\n");
}

// Dữ liệu cấu trúc để web render link tới trang chi tiết (/accommodation-detail?accommodationId=)
function mapAccommodationLinks(accommodations) {
    return accommodations.map((acc) => ({ id: acc.id, name: acc.accommodation_name }));
}

async function loadDateAwareAccommodation(pool, accommodation, args, customerId) {
    if (!args.check_in_date || !args.check_out_date) {
        return null;
    }

    const preview = await bookingWebService.getBookingPreview({
        accommodationId: accommodation.id,
        checkinDate: args.check_in_date,
        checkoutDate: args.check_out_date,
        rooms: 1,
    }, customerId);

    if (!preview) {
        return null;
    }

    return {
        ...accommodation,
        room_types: (preview.allRoomTypes || []).map((room) => ({
            name: room.name,
            base_price: room.nightlyRates?.[0]?.price ?? room.basePrice,
            available_quantity: room.availableQuantity,
            nightly_rates: room.nightlyRates,
        })),
        availability: preview.availability,
    };
}

async function enrichAccommodationsForStay(pool, accommodations, args, customerId) {
    if (!args.check_in_date || !args.check_out_date) {
        return accommodations;
    }

    const enriched = [];
    for (const accommodation of accommodations) {
        const snapshot = await loadDateAwareAccommodation(pool, accommodation, args, customerId);
        if (snapshot) {
            enriched.push(snapshot);
        }
    }
    return enriched;
}

// ---------- pipeline ----------

async function postMessage({ sessionKey, content, customer }) {
    const pool = db.getDBPool();

    if (typeof sessionKey !== "string" || !sessionKey.trim() || sessionKey.length > 64) {
        throw badRequest("sessionKey không hợp lệ.");
    }
    const trimmedContent = typeof content === "string" ? content.trim() : "";
    if (!trimmedContent || trimmedContent.length > MAX_MESSAGE_LENGTH) {
        throw badRequest(`Nội dung tin nhắn phải từ 1 đến ${MAX_MESSAGE_LENGTH} ký tự.`);
    }

    const userId = customer?.id ?? null;
    const actorType = userId ? "CUSTOMER" : "GUEST";
    const senderType = userId ? "CUSTOMER" : "GUEST";
    const conversation = await getOrCreateConversation(pool, sessionKey, userId);
    await insertMessage(pool, conversation.id, senderType, userId, trimmedContent);

    // ---------- P4: xác nhận hủy booking đang chờ ----------
    const pending = pendingCancels.get(conversation.id);
    if (pending && pending.expiresAt > Date.now()) {
        const normalized = normalizeVietnamese(trimmedContent);
        if (/^(xac nhan|huy|confirm|xn)/.test(normalized)) {
            pendingCancels.delete(conversation.id);
            const cancelled = await cancelOwnBooking(pool, userId, pending.bookingId);
            const reply = cancelled
                ? CANCELLED_REPLY(pending.bookingCode)
                : `Booking ${pending.bookingCode} không còn khả dụng để hủy (có thể đã thanh toán hoặc đã được xử lý).`;
            await writeAudit(pool, {
                actorType, actorUserId: userId, action: "intent.cancel_own_booking",
                resourceType: "booking", resourceId: pending.bookingId,
                decision: cancelled ? "ALLOW" : "DENY",
                reason: cancelled ? null : "STATUS_NOT_PENDING",
            });
            await insertMessage(pool, conversation.id, "BOT", null, reply);
            return buildResponse(conversation, reply, { intent: "REQUEST_CANCEL_BOOKING", action: "cancel_own_booking" });
        }
    } else if (pending) {
        pendingCancels.delete(conversation.id);
    }

    // ---------- Pre-model rule guard (R1..R5) ----------
    const guard = guardMessage(trimmedContent);
    if (!guard.allowed) {
        if (guard.block_code !== "OUT_OF_SCOPE") {
            await writeAudit(pool, {
                actorType, actorUserId: userId, action: AUDIT_ACTIONS.GUARD_BLOCK,
                resourceType: "conversation", resourceId: conversation.id,
                decision: "DENY", reason: guard.block_code,
                detail: { rule_id: guard.rule_id, matched_text: guard.matched_text },
            });
        }
        await insertMessage(pool, conversation.id, "BOT", null, guard.reply);
        return buildResponse(conversation, guard.reply, {
            intent: guard.block_code, action: "refuse", block_code: guard.block_code,
        });
    }

    // ---------- Model CLASSIFY ----------
    const isAuthenticated = Boolean(userId);
    const recent = await getRecentMessages(pool, conversation.id);
    const history = recent.slice(0, -1).map((row) => ({
        role: ["CUSTOMER", "GUEST"].includes(row.sender_type) ? "user" : "assistant",
        content: row.content,
    }));

    const call = await modelAdapter.callModel({
        mode: "CLASSIFY",
        system: modelSchema.buildClassifySystemPrompt(isAuthenticated),
        user: `Tin nhắn của khách: "${trimmedContent}"\n(Chỉ trả JSON, không giải thích.)`,
        history,
        maxTokens: 1200,
    });

    if (!call.ok) {
        await writeAudit(pool, {
            actorType, actorUserId: userId, action: AUDIT_ACTIONS.MODEL_FALLBACK,
            resourceType: "conversation", resourceId: conversation.id,
            decision: "ESCALATE", reason: `MODEL_ERROR:${call.error}`,
        });
        await insertMessage(pool, conversation.id, "BOT", null, FALLBACK_REPLY);
        return buildResponse(conversation, FALLBACK_REPLY, { intent: "UNKNOWN", action: "none", fallback: true });
    }

    const validated = modelSchema.validateStructuredResult(call.text);
    if (!validated.ok) {
        await writeAudit(pool, {
            actorType, actorUserId: userId, action: AUDIT_ACTIONS.MODEL_FALLBACK,
            resourceType: "conversation", resourceId: conversation.id,
            decision: "ESCALATE", reason: `SCHEMA_INVALID:${validated.reason}`,
            detail: { raw: call.text.slice(0, 500) },
        });
        await insertMessage(pool, conversation.id, "BOT", null, FALLBACK_REPLY);
        return buildResponse(conversation, FALLBACK_REPLY, { intent: "UNKNOWN", action: "none", fallback: true });
    }

    const result = validated.result;

    // Model báo SUSPICIOUS -> refuse (phòng hộ khi rule guard không bắt được)
    if (result.risk === "SUSPICIOUS") {
        await writeAudit(pool, {
            actorType, actorUserId: userId, action: AUDIT_ACTIONS.GUARD_BLOCK,
            resourceType: "conversation", resourceId: conversation.id,
            decision: "DENY", reason: "MODEL_RISK_SUSPICIOUS",
        });
        await insertMessage(pool, conversation.id, "BOT", null, REFUSAL_TEMPLATES.PRIVILEGE_ESCALATION);
        return buildResponse(conversation, REFUSAL_TEMPLATES.PRIVILEGE_ESCALATION, {
            intent: result.intent, action: "refuse", block_code: "SUSPICIOUS",
        });
    }

    // action refuse — model nhận diện block case mà rule không bắt được
    if (result.action === "refuse") {
        if (modelSchema.BLOCKED_INTENTS.includes(result.intent)) {
            await writeAudit(pool, {
                actorType, actorUserId: userId, action: AUDIT_ACTIONS.GUARD_BLOCK,
                resourceType: "conversation", resourceId: conversation.id,
                decision: "DENY", reason: result.intent,
            });
        }
        const reply = REFUSAL_TEMPLATES[result.intent] ?? REFUSAL_TEMPLATES.OUT_OF_SCOPE;
        await insertMessage(pool, conversation.id, "BOT", null, reply);
        return buildResponse(conversation, reply, { intent: result.intent, action: "refuse" });
    }

    // ---------- P2: auth gate ----------
    if (result.requires_authentication && !isAuthenticated) {
        await writeAudit(pool, {
            actorType, actorUserId: userId, action: AUDIT_ACTIONS.AUTH_REQUIRED,
            resourceType: "conversation", resourceId: conversation.id,
            decision: "DENY", reason: result.intent,
        });
        await insertMessage(pool, conversation.id, "BOT", null, AUTH_REQUIRED_REPLY);
        return buildResponse(conversation, AUTH_REQUIRED_REPLY, { intent: result.intent, action: "auth_required" });
    }

    // ---------- dispatch action ----------
    const dispatch = await dispatchAction(pool, {
        conversation, result, content: trimmedContent, userId, actorType,
    });

    await insertMessage(pool, conversation.id, "BOT", null, dispatch.reply);
    return buildResponse(conversation, dispatch.reply, {
        intent: result.intent, action: result.action, ...dispatch.meta,
    });
}

function buildResponse(conversation, reply, meta) {
    return {
        conversation_id: conversation.id,
        reply,
        ...meta,
    };
}

async function dispatchAction(pool, { conversation, result, content, userId, actorType }) {
    const { intent, action, arguments: args = {} } = result;

    // ---------- CONSULT: knowledge trước, accommodation search làm fallback ----------
    if (action === "answer_from_knowledge") {
        const isAmenityListQuestion = intent === "CONSULT_AMENITY" &&
            /(?:có|co)\s+(?:những|nhung|các|cac)?\s*tiện nghi|tiện nghi\s+(?:gì|gi|nào|nao)/i.test(content);
        if (isAmenityListQuestion) {
            const mentioned = await findAccommodationMentionedInMessage(pool, content);
            const accommodationQuery = mentioned?.accommodation_name || args.topic || args.accommodation_query;
            if (accommodationQuery) {
                const listed = await listAccommodationAmenities(pool, accommodationQuery, 50);
                if (listed.length) {
                    return {
                        reply: formatAmenityReply(listed, "").replace(
                            "Mình tìm thấy các cơ sở có các tiện nghi phù hợp:",
                            `Các tiện nghi được khai báo tại ${listed[0].accommodation_name}:`,
                        ),
                        meta: { accommodations: listed.map((item) => ({ id: item.id, name: item.accommodation_name })) },
                    };
                }
            }
        }

        if (intent === "CONSULT_AMENITY") {
            const amenityQuery = args.amenity_query || inferAmenityQuery(content, args.topic);
            const locationQuery = args.location_query || await findLocationMentionedInMessage(pool, content);
            if (amenityQuery) {
                const amenities = await searchAccommodationAmenities(pool, amenityQuery, locationQuery, 10);
            if (amenities.length) {
                await writeAudit(pool, {
                    actorType, actorUserId: userId, action: "intent.answer_from_amenity",
                    resourceType: "conversation", resourceId: conversation.id, decision: "ALLOW",
                    reason: locationQuery ? `${amenityQuery}|${locationQuery}` : amenityQuery,
                });
                return {
                    reply: formatAmenityReply(amenities, amenityQuery),
                    meta: { accommodations: amenities.map((item) => ({ id: item.id, name: item.accommodation_name })) },
                };
            }
            if (locationQuery) {
                const reply = `Mình chưa tìm thấy cơ sở lưu trú nào ở ${locationQuery} có tiện nghi "${amenityQuery}".`;
                await writeAudit(pool, {
                    actorType, actorUserId: userId, action: "intent.answer_from_amenity",
                    resourceType: "conversation", resourceId: conversation.id, decision: "ALLOW",
                    reason: `${amenityQuery}|${locationQuery}|NO_MATCH`,
                });
                return { reply, meta: {} };
            }
            }
        }

        const query = args.topic || args.accommodation_query || content;
        if (intent === "CONSULT_AMENITY" && !args.amenity_query) {
            const genericTopic = /^(ti[eệ]n nghi|amenit(?:y|ies)|c[aá]c ti[eệ]n nghi)$/i.test(String(args.topic || "").trim());
            const mentioned = genericTopic || !args.topic
                ? await findAccommodationMentionedInMessage(pool, content)
                : null;
            const accommodationQuery = mentioned?.accommodation_name || args.accommodation_query || args.topic;
            const listed = await listAccommodationAmenities(pool, accommodationQuery, 50);
            if (listed.length) {
                return {
                    reply: formatAmenityReply(listed, "").replace(
                        "Mình tìm thấy các cơ sở có các tiện nghi phù hợp:",
                        `Các tiện nghi được khai báo tại ${listed[0].accommodation_name}:`,
                    ),
                    meta: { accommodations: listed.map((item) => ({ id: item.id, name: item.accommodation_name })) },
                };
            }
        }
        const articles = await searchKnowledge(pool, String(query).slice(0, 100));

        if (articles.length) {
            const article = articles[0];
            const excerpt = article.content.length > 800 ? `${article.content.slice(0, 800)}…` : article.content;
            await writeAudit(pool, {
                actorType, actorUserId: userId, action: "intent.answer_from_knowledge",
                resourceType: "conversation", resourceId: conversation.id, decision: "ALLOW",
                reason: intent,
            });
            return { reply: `${article.title}\n\n${excerpt}`, meta: {} };
        }

        const accommodations = await searchAccommodations(pool, String(query).slice(0, 100));
        if (accommodations.length) {
            await writeAudit(pool, {
                actorType, actorUserId: userId, action: "intent.answer_from_knowledge",
                resourceType: "conversation", resourceId: conversation.id, decision: "ALLOW",
                reason: `${intent} (accommodation fallback)`,
            });
            return {
                reply: formatAccommodationReply(accommodations),
                meta: { accommodations: mapAccommodationLinks(accommodations) },
            };
        }

        return {
            reply: "Mình chưa tìm thấy thông tin phù hợp. Bạn có thể hỏi theo cách khác, hoặc mô tả rõ hơn về cơ sở/phòng bạn quan tâm nhé?",
            meta: {},
        };
    }

    // ---------- BOOKING: availability / price ----------
    if (action === "check_availability" || action === "check_price") {
        const query = args.accommodation_query || args.location || args.room_type_query || args.accommodation_code || "";
        if (!query) {
            return {
                reply: "Bạn cho mình biết địa điểm hoặc tên cơ sở lưu trú bạn quan tâm nhé, mình sẽ tra giá và phòng giúp bạn!",
                meta: {},
            };
        }
        const accommodations = await searchAccommodations(pool, String(query).slice(0, 100));
        let stayAwareAccommodations;
        try {
            stayAwareAccommodations = await enrichAccommodationsForStay(
                pool, accommodations, args, userId,
            );
        } catch (error) {
            await writeAudit(pool, {
                actorType, actorUserId: userId, action: AUDIT_ACTIONS.MODEL_FALLBACK,
                resourceType: "conversation", resourceId: conversation.id,
                decision: "ESCALATE", reason: `AVAILABILITY_ERROR:${error.code || error.message}`,
            });
            return {
                reply: "Mình chưa thể kiểm tra tình trạng phòng và giá cho khoảng ngày này. Bạn thử lại sau ít phút nhé.",
                meta: {},
            };
        }
        const stayResults = stayAwareAccommodations || accommodations;
        const dates = args.check_in_date && args.check_out_date
            ? `\nKhoảng ngày bạn hỏi: ${args.check_in_date} → ${args.check_out_date}.`
            : "";
        await writeAudit(pool, {
            actorType, actorUserId: userId, action: `intent.${action}`,
            resourceType: "conversation", resourceId: conversation.id, decision: "ALLOW",
            reason: intent,
        });
        return {
            reply: stayResults.length
                ? `${formatAccommodationReply(stayResults)}${dates}`
                : `Mình chưa tìm thấy cơ sở nào khớp "${query}". Bạn thử tên khu vực khác nhé!${dates}`,
            meta: { accommodations: mapAccommodationLinks(stayResults) },
        };
    }

    // ---------- BOOKING/PAYMENT: lookup có ownership ----------
    if (action === "lookup_booking") {
        const bookingCode = String(args.booking_code ?? "").trim();
        if (!bookingCode) {
            return { reply: "Bạn cho mình mã booking (ví dụ VPST20-000001) để mình tra cứu nhé.", meta: {} };
        }
        return lookupBookingInternal(pool, { conversation, userId, actorType, bookingCode });
    }

    if (action === "lookup_payment") {
        const bookingCode = String(args.booking_code ?? "").trim();
        if (!bookingCode) {
            return { reply: "Bạn cho mình mã booking để mình kiểm tra thanh toán nhé.", meta: {} };
        }
        const payment = await getOwnPaymentDetail(pool, userId, bookingCode);
        if (payment) {
            await writeAudit(pool, {
                actorType, actorUserId: userId, action: "intent.lookup_payment",
                resourceType: "conversation", resourceId: conversation.id, decision: "ALLOW",
            });
            return { reply: formatPaymentReply(payment), meta: {} };
        }
        const exists = await findBookingByCode(pool, bookingCode);
        if (exists) {
            // booking tồn tại nhưng không thuộc user -> DENY, không tiết lộ
            await writeAudit(pool, {
                actorType, actorUserId: userId, action: AUDIT_ACTIONS.AUTHZ_DENY,
                resourceType: "booking", resourceId: exists.id,
                decision: "DENY", reason: "CROSS_CUSTOMER_LOOKUP",
            });
        }
        return { reply: `Mình không tìm thấy thanh toán cho booking ${bookingCode} trong tài khoản của bạn.`, meta: {} };
    }

    // ---------- BOOK-04: hủy booking ----------
    if (action === "cancel_own_booking") {
        const bookingCode = String(args.booking_code ?? "").trim();
        if (!bookingCode) {
            return { reply: "Bạn cho mình mã booking cần hủy nhé.", meta: {} };
        }
        const booking = await getOwnBookingDetail(pool, userId, bookingCode);
        if (!booking) {
            const exists = await findBookingByCode(pool, bookingCode);
            if (exists) {
                await writeAudit(pool, {
                    actorType, actorUserId: userId, action: AUDIT_ACTIONS.AUTHZ_DENY,
                    resourceType: "booking", resourceId: exists.id,
                    decision: "DENY", reason: "CROSS_CUSTOMER_CANCEL",
                });
            }
            return { reply: `Mình không tìm thấy booking ${bookingCode} trong tài khoản của bạn.`, meta: {} };
        }

        if (booking.checked_in_at) {
            return { reply: `Booking ${bookingCode} đã nhận phòng nên không thể hủy. Bạn cần hỗ trợ gì thêm không ạ?`, meta: {} };
        }

        if (booking.status === "PENDING") {
            pendingCancels.set(conversation.id, {
                bookingId: booking.id,
                bookingCode: booking.booking_code,
                expiresAt: Date.now() + PENDING_CANCEL_TTL_MS,
            });
            await writeAudit(pool, {
                actorType, actorUserId: userId, action: "intent.cancel_own_booking",
                resourceType: "booking", resourceId: booking.id,
                decision: "ALLOW", reason: "PENDING_CONFIRM_ASKED",
            });
            return { reply: CONFIRM_CANCEL_REPLY(booking.booking_code), meta: {} };
        }

        if (booking.status === "CONFIRMED") {
            // đã thanh toán -> hoàn tiền cần người (T05A: BOOK-04 nhánh CONFIRMED)
            return createTicketInternal(pool, {
                conversation, userId, actorType,
                category: "CANCEL_REFUND",
                subject: `Yêu cầu hủy booking đã thanh toán ${booking.booking_code}`,
                bookingId: booking.id,
                accommodationId: booking.accommodation_id ?? null,
                content,
            });
        }

        return {
            reply: `Booking ${bookingCode} đang ở trạng thái ${booking.status} nên không thể hủy trực tiếp. Bạn cần hỗ trợ thêm không ạ?`,
            meta: {},
        };
    }

    // ---------- create_ticket ----------
    if (action === "create_ticket") {
        const category = args.category;
        let bookingId = null;
        let accommodationId = null;
        const bookingCode = String(args.booking_code ?? "").trim();

        if (bookingCode) {
            const booking = await getOwnBookingDetail(pool, userId, bookingCode);
            if (booking) {
                bookingId = booking.id;
                accommodationId = booking.accommodation_id;

                // BOOK-04 phân nhánh theo trạng thái (T01/state-machine) — backend quyết,
                // model không biết payment status: PENDING -> tự hủy sau confirm; CONFIRMED -> ticket.
                if (intent === "REQUEST_CANCEL_BOOKING" && booking.status === "PENDING") {
                    pendingCancels.set(conversation.id, {
                        bookingId: booking.id,
                        bookingCode: booking.booking_code,
                        expiresAt: Date.now() + PENDING_CANCEL_TTL_MS,
                    });
                    await writeAudit(pool, {
                        actorType, actorUserId: userId, action: "intent.cancel_own_booking",
                        resourceType: "booking", resourceId: booking.id,
                        decision: "ALLOW", reason: "PENDING_CONFIRM_ASKED",
                    });
                    return { reply: CONFIRM_CANCEL_REPLY(booking.booking_code), meta: {} };
                }
            } else {
                const exists = await findBookingByCode(pool, bookingCode);
                if (exists) {
                    await writeAudit(pool, {
                        actorType, actorUserId: userId, action: AUDIT_ACTIONS.AUTHZ_DENY,
                        resourceType: "booking", resourceId: exists.id,
                        decision: "DENY", reason: "CROSS_CUSTOMER_TICKET",
                    });
                }
                // Không đủ booking context -> ticket vào admin queue (model-plan fallback)
            }
        }

        return createTicketInternal(pool, {
            conversation, userId, actorType, category,
            subject: args.subject || `${category} — ${content.slice(0, 100)}`,
            bookingId, accommodationId, content,
        });
    }

    // action none (SMALLTALK/UNKNOWN)
    return {
        reply: result.reply || REFUSAL_TEMPLATES.UNKNOWN,
        meta: {},
    };
}

async function lookupBookingInternal(pool, { conversation, userId, actorType, bookingCode }) {
    const booking = await getOwnBookingDetail(pool, userId, bookingCode);
    if (booking) {
        await writeAudit(pool, {
            actorType, actorUserId: userId, action: "intent.lookup_booking",
            resourceType: "booking", resourceId: booking.id, decision: "ALLOW",
        });
        return { reply: formatBookingReply(booking), meta: { booking: maskingBooking(booking) } };
    }

    const exists = await findBookingByCode(pool, bookingCode);
    if (exists) {
        await writeAudit(pool, {
            actorType, actorUserId: userId, action: AUDIT_ACTIONS.AUTHZ_DENY,
            resourceType: "booking", resourceId: exists.id,
            decision: "DENY", reason: "CROSS_CUSTOMER_LOOKUP",
        });
    }
    return { reply: `Mình không tìm thấy booking ${bookingCode} trong tài khoản của bạn.`, meta: {} };
}

function maskingBooking(booking) {
    return {
        booking_code: booking.booking_code,
        accommodation_name: booking.accommodation_name,
        check_in_date: booking.check_in_date,
        check_out_date: booking.check_out_date,
        status: booking.status,
        total_amount: booking.total_amount,
        currency: booking.currency,
    };
}

async function createTicketInternal(pool, {
    conversation, userId, actorType, category, subject, bookingId = null,
    accommodationId = null, content,
}) {
    return withKeyLock(ticketQuotaLocks, conversation.id, async () => {
    if (ticketQuotaExceeded(conversation.id)) {
        await writeAudit(pool, {
            actorType, actorUserId: userId, action: "ticket.quota_denied",
            resourceType: "conversation", resourceId: conversation.id,
            decision: "DENY", reason: `QUOTA_${TICKET_QUOTA}/HOUR`,
        });
        return {
            reply: "Bạn đã tạo nhiều yêu cầu hỗ trợ trong giờ qua. Vui lòng chờ nhân viên phản hồi các yêu cầu trước đó nhé.",
            meta: {},
        };
    }

    const ticketCode = await generateTicketCode(pool);

    // Subject ưu tiên từ CLASSIFY args; SUMMARIZE chỉ khi thiếu; cuối cùng fallback template
    let finalSubject = subject;
    if (finalSubject.startsWith(category)) {
        const summary = await modelAdapter.callModel({
            mode: "SUMMARIZE",
            system: "Viết một tiêu đề ngắn (tối đa 100 ký tự, tiếng Việt) cho yêu cầu hỗ trợ sau. CHỈ trả tiêu đề, không phân tích.",
            user: `Nội dung: "${content}"`,
            maxTokens: 200,
        });
        if (summary.ok && summary.text) {
            // Model hay narrate meta rồi mới tiêu đề — trích chuỗi trong dấu quote cuối cùng
            const quotes = [...summary.text.matchAll(/"([^"]{5,150})"/g)];
            if (quotes.length) {
                finalSubject = quotes[quotes.length - 1][1].trim();
            }
        }
    }

    const ticket = await insertTicket(pool, {
        ticketCode,
        userId,
        conversationId: conversation.id,
        bookingId,
        accommodationId,
        category,
        subject: finalSubject,
    });

    recordTicketCreated(conversation.id);

    await writeAudit(pool, {
        actorType, actorUserId: userId, action: AUDIT_ACTIONS.TICKET_CREATED,
        resourceType: "ticket", resourceId: ticket.id,
        decision: "ALLOW", reason: category,
        detail: { booking_id: bookingId, accommodation_id: accommodationId },
    });

    return {
        reply: `Mình đã tạo yêu cầu hỗ trợ mã ${ticket.ticket_code}. Nhân viên sẽ phản hồi bạn sớm nhất nhé!`,
        meta: { ticket_code: ticket.ticket_code },
    };
    });
}

// ---------- customer: danh sách ticket của mình ----------

async function getMyTickets(userId) {
    const pool = db.getDBPool();
    const result = await pool.request()
        .input("userId", sql.UniqueIdentifier, userId)
        .query(`
            SELECT
                t.id, t.ticket_code, t.category, t.subject, t.status,
                t.created_at, t.updated_at,
                a.accommodation_name
            FROM dbo.tickets t
            LEFT JOIN dbo.accommodations a ON a.id = t.accommodation_id
            WHERE t.user_id = @userId
            ORDER BY t.created_at DESC;
        `);

    return result.recordset;
}

module.exports = { postMessage, getMyTickets, guardMessage };

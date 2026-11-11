// Rate limit chống spam cho chatbot (T12): sliding window in-memory
// theo sessionKey + IP. Server restart reset — chấp nhận cho dev/MVP
// (khớp approach in-memory của pendingCancels trong chatbot_service).

const sql = require("mssql");
const db = require("../configs/database");

const WINDOW_MS = 60 * 1000;      // cửa sổ 1 phút
const MAX_MESSAGES = 20;          // tối đa 20 tin nhắn / phút / session+IP

// key -> timestamp[]
const hits = new Map();

function clientIp(req) {
    return (
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket?.remoteAddress ||
        "unknown"
    );
}

// Cleanup định kỳ để Map không phình vô hạn
setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits) {
        const alive = timestamps.filter((ts) => now - ts < WINDOW_MS);
        if (alive.length === 0) {
            hits.delete(key);
        } else {
            hits.set(key, alive);
        }
    }
}, 5 * 60 * 1000).unref();

async function auditRateLimit(actorType, actorUserId, sessionKey, ip) {
    try {
        await db.getDBPool().request()
            .input("actorType", sql.VarChar(30), actorType)
            .input("actorUserId", sql.UniqueIdentifier, actorUserId ?? null)
            .input("sessionKey", sql.VarChar(64), sessionKey)
            .input("ip", sql.VarChar(64), ip)
            .query(`
                INSERT INTO dbo.audit_logs
                    (actor_type, actor_user_id, action, resource_type, resource_id, decision, reason)
                VALUES
                    (@actorType, @actorUserId, 'chatbot.rate_limited', 'conversation', NULL, 'DENY',
                     N'Vượt giới hạn 20 tin nhắn/phút — session ' + @sessionKey + N' — ip ' + @ip);
            `);
    } catch (error) {
        console.error("[chatbot_rate_limit] audit failed:", error.message);
    }
}

function chatbotRateLimit(req, res, next) {
    const sessionKey = typeof req.body?.sessionKey === "string" ? req.body.sessionKey : "";
    const ip = clientIp(req);
    const key = `${sessionKey || "no-session"}|${ip}`;

    const now = Date.now();
    const timestamps = (hits.get(key) || []).filter((ts) => now - ts < WINDOW_MS);

    if (timestamps.length >= MAX_MESSAGES) {
        const actorType = req.session?.customer ? "CUSTOMER" : "GUEST";
        const actorUserId = req.session?.customer?.id ?? null;
        auditRateLimit(actorType, actorUserId, sessionKey, ip);

        return res.status(429).json({
            success: false,
            message: `Bạn gửi tin nhắn quá nhanh. Vui lòng đợi khoảng ${Math.ceil(WINDOW_MS / 1000)} giây rồi thử lại.`,
            errorCode: "RATE_LIMITED",
        });
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    next();
}

module.exports = { chatbotRateLimit, MAX_MESSAGES, WINDOW_MS };

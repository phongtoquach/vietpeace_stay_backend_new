// Hằng số nghiệp vụ chatbot: khớp workspace/state-machine.md (T02)
// và workspace/authz-matrix.md (T03). Role trong DB: ACCOMMODATION_MANAGER.

const CONVERSATION_STATUSES = Object.freeze(["ACTIVE", "CLOSED"]);

const TICKET_STATUSES = Object.freeze([
    "OPEN",
    "ASSIGNED",
    "IN_PROGRESS",
    "WAITING_CUSTOMER",
    "RESOLVED",
    "CLOSED",
    "CANCELLED",
]);

const TICKET_CATEGORIES = Object.freeze([
    "CANCEL_REFUND",
    "BOOKING_CHANGE",
    "PAYMENT_PROBLEM",
    "REFUND_REQUEST",
    "HUMAN_SUPPORT",
    "COMPLAINT",
    "FEEDBACK",
]);

const SENDER_TYPES = Object.freeze(["CUSTOMER", "GUEST", "BOT", "STAFF", "SYSTEM"]);

const ACTOR_TYPES = Object.freeze(["GUEST", "CUSTOMER", "ACCOMMODATION_MANAGER", "ADMIN", "SYSTEM"]);

// State machine T02 — bảng transition hợp lệ (from -> to[])
const ALLOWED_TRANSITIONS = Object.freeze({
    OPEN: Object.freeze(["ASSIGNED", "IN_PROGRESS", "CANCELLED"]),
    ASSIGNED: Object.freeze(["IN_PROGRESS", "CANCELLED"]),
    IN_PROGRESS: Object.freeze(["WAITING_CUSTOMER", "RESOLVED"]),
    WAITING_CUSTOMER: Object.freeze(["IN_PROGRESS", "RESOLVED"]),
    RESOLVED: Object.freeze(["CLOSED", "IN_PROGRESS"]),
    CLOSED: Object.freeze(["OPEN"]),
    CANCELLED: Object.freeze([]),
});

// Transition bắt buộc có reason (T-03, T-12, T-13)
const TRANSITIONS_REQUIRE_REASON = Object.freeze(["CANCELLED", "OPEN"]);

// Refusal template chuẩn — không tiết lộ nội bộ (T05 mục 5.2)
const REFUSAL_TEMPLATES = Object.freeze({
    OUT_OF_SCOPE: "Xin lỗi, mình chỉ hỗ trợ các câu hỏi về lưu trú, phòng và booking của VietPeace Stay.",
    SYSTEM_DISCLOSURE: "Mình không thể cung cấp thông tin cấu hình hoặc nội bộ của hệ thống.",
    SENSITIVE_DATA_REQUEST: "Mình chỉ có thể tra cứu thông tin của chính tài khoản của bạn.",
    AUTH_BYPASS: "Để xem booking/payment, vui lòng đăng nhập tài khoản đã đặt phòng.",
    PRIVILEGE_ESCALATION: "Yêu cầu này vượt quá quyền của bạn.",
    UNKNOWN: "Mình chưa hiểu rõ câu hỏi. Bạn có thể nói lại giúp mình không?",
});

const FALLBACK_REPLY = "Xin lỗi, hệ thống đang bận. Bạn vui lòng thử lại sau ít phút.";

const AUTH_REQUIRED_REPLY = "Để xem thông tin booking/payment, bạn vui lòng đăng nhập tài khoản đã đặt phòng nhé.";

const CONFIRM_CANCEL_REPLY = (bookingCode) =>
    `Booking ${bookingCode} của bạn chưa thanh toán. Bạn trả lời "XÁC NHẬN HỦY" để mình hủy giúp bạn (có hiệu lực trong 15 phút).`;

const CANCELLED_REPLY = (bookingCode) =>
    `Đã hủy booking ${bookingCode} thành công. Nếu cần đặt lại, bạn cứ nói mình hỗ trợ nhé.`;

// block_code -> audit (T05 mục 5.1)
const AUDIT_ACTIONS = Object.freeze({
    GUARD_BLOCK: "guard.block",
    MODEL_FALLBACK: "model.fallback",
    AUTH_REQUIRED: "auth.required",
    AUTHZ_DENY: "authz.deny",
    TICKET_CREATED: "ticket.created",
    TICKET_TRANSITION: "ticket.transition",
    TICKET_ASSIGNED: "ticket.assigned",
    STAFF_REPLY: "ticket.staff_reply",
});

module.exports = {
    CONVERSATION_STATUSES,
    TICKET_STATUSES,
    TICKET_CATEGORIES,
    SENDER_TYPES,
    ACTOR_TYPES,
    ALLOWED_TRANSITIONS,
    TRANSITIONS_REQUIRE_REASON,
    REFUSAL_TEMPLATES,
    FALLBACK_REPLY,
    AUTH_REQUIRED_REPLY,
    CONFIRM_CANCEL_REPLY,
    CANCELLED_REPLY,
    AUDIT_ACTIONS,
};

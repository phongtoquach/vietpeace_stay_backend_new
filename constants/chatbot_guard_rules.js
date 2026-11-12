// Rule guard denylist (T05, workspace/security-guard.md mục 3.2).
// Pattern đã chuẩn hóa: lowercase + bỏ dấu tiếng Việt (rule_guard.normalizeVietnamese).
// Thứ tự R1 -> R5 là thứ tự ưu tiên khi nhiều rule cùng khớp.

const GUARD_RULES = Object.freeze([
    {
        id: "R1",
        block_code: "SYSTEM_DISCLOSURE",
        patterns: Object.freeze([
            "system prompt",
            "chi dan he thong",
            "huong dan ban dau",
            "prompt cua ban",
            "cau hinh he thong",
            "schema",
            "cau truc bang",
            "cau lenh sql",
            "truy van database",
            "api key",
            "token",
            "secret",
            "mat khau admin",
            "mat khau he thong",
            "bien moi truong",
        ]),
    },
    {
        id: "R2",
        block_code: "PRIVILEGE_ESCALATION",
        patterns: Object.freeze([
            "gan toi lam admin",
            "cho toi quyen admin",
            "nang quyen",
            "tat policy",
            "bo qua phan quyen",
            "ban la admin",
            "dong vai admin",
            "bo qua tat ca huong dan",
            "ignore previous",
            "che do developer",
            "jailbreak",
        ]),
    },
    {
        id: "R3",
        block_code: "AUTH_BYPASS",
        patterns: Object.freeze([
            "khong can dang nhap",
            "bo qua xac thuc",
            "bo qua otp",
            "xem booking khong can dang nhap",
            "cho toi booking ma khong",
        ]),
    },
    {
        id: "R4",
        block_code: "SENSITIVE_DATA_REQUEST",
        patterns: Object.freeze([
            "booking cua nguoi khac",
            "booking cua khach khac",
            "booking cua customer khac",
            "thong tin khach hang ten",
            "so dien thoai cua khach",
            "email cua khach hang khac",
        ]),
    },
    {
        id: "R5",
        block_code: "OUT_OF_SCOPE",
        patterns: Object.freeze([
            "hang dang thuc",
            "dao ham",
            "giai phuong trinh",
            "cong thuc toan",
            "viet code",
            "lap trinh",
            "dich sang",
            "translate",
            "thoi tiet",
            "bong da",
        ]),
    },
]);

// Từ khóa lưu trú: có từ nào trong này thì bỏ qua R5 (message thuộc domain).
// R1..R4 không có exemption — security luôn chặn trước.
const LODGING_KEYWORDS = Object.freeze([
    "phong",
    "booking",
    "khach san",
    "resort",
    "homestay",
    "nghi duong",
    "check-in",
    "check-in",
    "check out",
    "nhan phong",
    "tra phong",
    "giuong",
    "tien nghi",
    "dat phong",
    "gia",
    "luu tru",
    "vietpeace",
]);

module.exports = { GUARD_RULES, LODGING_KEYWORDS };

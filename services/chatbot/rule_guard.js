// Pre-model rule guard (T05, workspace/security-guard.md mục 3).
// Chặn các mẫu chắc chắn TRƯỚC khi gọi model; không phải cơ chế phân quyền duy nhất
// — policy guard (P2/P3) vẫn kiểm tra lại sau model.

const { GUARD_RULES, LODGING_KEYWORDS } = require("../../constants/chatbot_guard_rules");
const { REFUSAL_TEMPLATES } = require("../../constants/chatbot");

// Lowercase + bỏ dấu tiếng Việt: NFC/NFD decompose rồi bỏ combining marks, đ -> d.
function normalizeVietnamese(text) {
    return String(text ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "d")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

// Trả { allowed: true } hoặc { allowed:false, block_code, rule_id, matched_text, reply }.
function guardMessage(content) {
    const normalized = normalizeVietnamese(content);

    const securityRules = GUARD_RULES.filter((rule) => rule.block_code !== "OUT_OF_SCOPE");
    for (const rule of securityRules) {
        const matched = rule.patterns.find((pattern) => normalized.includes(pattern));
        if (matched) {
            return {
                allowed: false,
                block_code: rule.block_code,
                rule_id: rule.id,
                matched_text: matched,
                reply: REFUSAL_TEMPLATES[rule.block_code],
            };
        }
    }

    // R5 chỉ chặn khi message KHÔNG chứa từ khóa lưu trú (exemption, T05 mục 3.2).
    const hasLodgingKeyword = LODGING_KEYWORDS.some((keyword) => normalized.includes(keyword));
    if (!hasLodgingKeyword) {
        const outOfScope = GUARD_RULES.find((rule) => rule.block_code === "OUT_OF_SCOPE");
        const matched = outOfScope.patterns.find((pattern) => normalized.includes(pattern));
        if (matched) {
            return {
                allowed: false,
                block_code: "OUT_OF_SCOPE",
                rule_id: outOfScope.id,
                matched_text: matched,
                reply: REFUSAL_TEMPLATES.OUT_OF_SCOPE,
            };
        }
    }

    return { allowed: true };
}

module.exports = { guardMessage, normalizeVietnamese };

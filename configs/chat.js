function readInt(name, fallback, min = 1, max = 3600000) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const val = Number(raw);
  if (!Number.isSafeInteger(val) || val < min || val > max) {
    throw new Error(`Invalid integer env ${name}=${raw}`);
  }
  return val;
}

function readFloat(name, fallback, min = 0, max = 2) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const val = Number(raw);
  if (!Number.isFinite(val) || val < min || val > max) {
    throw new Error(`Invalid float env ${name}=${raw}`);
  }
  return val;
}

function readThinkingLevel(name, fallback = "LOW") {
  const raw = process.env[name];
  const val = (raw === undefined || raw === null || raw === "" ? fallback : String(raw)).trim().toUpperCase();
  if (!val || val === "OFF" || val === "NONE") return null;
  if (!["MINIMAL", "LOW", "MEDIUM", "HIGH", "XHIGH"].includes(val)) {
    throw new Error(`Invalid thinking level env ${name}=${raw}`);
  }
  return val;
}

module.exports = {
  enabled: process.env.CHAT_ENABLED !== "false",
  aiEnabled: () => process.env.CHAT_AI_ENABLED !== "false",
  provider: process.env.CHAT_AI_PROVIDER || "google",
  model: process.env.CHAT_AI_MODEL || "gemini-3.5-flash-lite",
  aiMaxOutputTokens: readInt("CHAT_AI_MAX_OUTPUT_TOKENS", 4096, 256, 65536),
  aiTemperature: readFloat("CHAT_AI_TEMPERATURE", 0.25, 0, 2),
  aiThinkingLevel: readThinkingLevel("CHAT_AI_THINKING_LEVEL", "LOW"),
  aiTimeoutMs: readInt("CHAT_AI_TIMEOUT_MS", 35000),
  toolTimeoutMs: readInt("CHAT_TOOL_TIMEOUT_MS", 5000),
  aiDebounceMs: readInt("CHAT_AI_DEBOUNCE_MS", 350, 100, 10000),
  claimTimeoutSeconds: readInt("CHAT_CLAIM_TIMEOUT_SECONDS", 300, 30, 3600),
  guestAiCloseSeconds: readInt("CHAT_AI_CLOSE_SECONDS", 180, 30, 3600),
  guestTempCleanupSeconds: readInt("CHAT_GUEST_TEMP_SECONDS", 300, 30, 3600),
  firstReplyTimeoutSeconds: readInt("CHAT_FIRST_REPLY_TIMEOUT_SECONDS", 180, 30, 3600),
  disconnectGraceSeconds: readInt("CHAT_DISCONNECT_GRACE_SECONDS", 60, 10, 600),
  socketTicketSeconds: 60,
  guestCookieName: "vietpeace.chat.guest",
  guestSessionDays: 7,
  messageMaxLength: 4000,
  historyMaxLimit: 100,
  authCacheTtlMs: 8000,
  outboxPollMs: 1000,
  expiryPollMs: 5000,
  cleanupPollMs: 120000,
  allowedOrigins: () =>
    [
      process.env.WEB_DOMAIN,
      process.env.ADMIN_PANEL_DOMAIN,
      "http://localhost:5178",
      "http://localhost:5175",
    ].filter(Boolean),
};

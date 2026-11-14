const { GoogleGenAI, ThinkingLevel } = require("@google/genai");
const config = require("../../configs/chat");
const { chatError } = require("./db");

function resolveThinkingConfig(model, level) {
  if (!level || !/^gemini-(3|4)/i.test(model)) return undefined;
  const normalized = String(level).trim().toUpperCase();
  if (!ThinkingLevel[normalized] || normalized === "THINKING_LEVEL_UNSPECIFIED") {
    return undefined;
  }
  return { thinkingLevel: ThinkingLevel[normalized] };
}

let cachedClient = null;
let cachedKey = null;

function getClient() {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw chatError(503, "AI_UNAVAILABLE", "Chưa cấu hình GEMINI_API_KEY trên máy chủ.");
  }
  if (!cachedClient || cachedKey !== key) {
    cachedClient = new GoogleGenAI({ vertexai: false, apiKey: key });
    cachedKey = key;
  }
  return cachedClient;
}

const RETRY_DELAYS_MS = [600, 1400];

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(chatError(499, "AI_CANCELLED", "Phản hồi AI đã được hủy."));
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(chatError(499, "AI_CANCELLED", "Phản hồi AI đã được hủy."));
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function isTransientProviderError(err) {
  const status = Number(err?.status || err?.code || 0);
  if (status === 429 || status === 503 || status === 502 || status === 504) return true;
  const msg = String(err?.message || "");
  return /UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|Service Unavailable|overloaded/i.test(msg);
}

async function generate({ contents, system, tools = [], signal, onDelta = async () => {} }) {
  const ai = getClient();
  const model = config.model || "gemini-3.5-flash-lite";
  const maxOutputTokens = config.aiMaxOutputTokens || 4096;
  const temperature = config.aiTemperature ?? 0.25;
  const thinkingConfig = resolveThinkingConfig(model, config.aiThinkingLevel);

  let stream;
  let lastOpenErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (signal?.aborted) {
      throw chatError(499, "AI_CANCELLED", "Phản hồi AI đã được hủy.");
    }
    try {
      stream = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: system,
          temperature,
          maxOutputTokens,
          ...(thinkingConfig ? { thinkingConfig } : {}),
          ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools }] } : {}),
          ...(signal ? { abortSignal: signal } : {}),
        },
      });
      lastOpenErr = null;
      break;
    } catch (err) {
      lastOpenErr = err;
      if (attempt < RETRY_DELAYS_MS.length && isTransientProviderError(err) && !signal?.aborted) {
        await sleepAbortable(RETRY_DELAYS_MS[attempt], signal);
        continue;
      }
      const status = err?.status || 503;
      const code = status === 429 ? "AI_QUOTA_EXCEEDED" : "AI_PROVIDER_ERROR";
      throw chatError(503, code, `Dịch vụ AI tạm thời không khả dụng (${err?.message || "Provider Error"}).`);
    }
  }
  if (lastOpenErr) {
    throw chatError(503, "AI_PROVIDER_ERROR", `Dịch vụ AI tạm thời không khả dụng (${lastOpenErr?.message || "Provider Error"}).`);
  }

  let text = "";
  const rawParts = [];
  const functionCalls = [];
  let usage = null;

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw chatError(499, "AI_CANCELLED", "Phản hồi AI đã được hủy.");
      }

      const candidateParts = chunk?.candidates?.[0]?.content?.parts || [];
      for (const part of candidateParts) {
        rawParts.push(part);
        if (!part.thought && typeof part.text === "string" && part.text.length > 0) {
          text += part.text;
          await onDelta(part.text);
        }
        if (part.functionCall) {
          functionCalls.push(part.functionCall);
        }
      }

      if (chunk?.usageMetadata) {
        usage = chunk.usageMetadata;
      }
    }
  } catch (err) {
    if (err?.errorCode) throw err;
    throw chatError(503, "AI_STREAM_ERROR", `Luồng phản hồi AI bị gián đoạn (${err?.message || "Stream Error"}).`);
  }

  // Merge contiguous text parts while preserving functionCall & thoughtSignature parts intact for multi-turn tool calls
  const mergedParts = [];
  let pendingText = "";
  for (const part of rawParts) {
    if (!part.thought && !part.functionCall && typeof part.text === "string") {
      pendingText += part.text;
    } else {
      if (pendingText) {
        mergedParts.push({ text: pendingText });
        pendingText = "";
      }
      if (!part.thought) {
        mergedParts.push(part);
      }
    }
  }
  if (pendingText) mergedParts.push({ text: pendingText });

  if (!text && functionCalls.length === 0) {
    throw chatError(503, "AI_EMPTY_RESPONSE", "AI chưa tạo được nội dung phản hồi phù hợp.");
  }

  return {
    model,
    text,
    content: { role: "model", parts: mergedParts },
    calls: functionCalls,
    usage,
  };
}

module.exports = { generate };

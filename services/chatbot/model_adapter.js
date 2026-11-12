// Một-model provider adapter (T05A, workspace/model-adapter.md).
// Cấu hình chỉ từ env; model là reasoning model GLM trên vLLM nên bắt buộc
// chat_template_kwargs.enable_thinking=false — nếu không content sẽ null.

function getModelConfig() {
    const baseUrl = process.env.AI_BASE_URL;
    const apiKey = process.env.AI_API_KEY;
    const model = process.env.AI_MODEL;

    if (!baseUrl || !apiKey || !model) {
        throw new Error(
            "Thiếu cấu hình AI provider (AI_BASE_URL / AI_API_KEY / AI_MODEL trong .env).",
        );
    }

    return { baseUrl, apiKey, model };
}

// callModel({ mode, system, user, history, maxTokens })
//  -> { ok:true, text } | { ok:false, error:'TIMEOUT'|'HTTP'|'EMPTY_CONTENT'|... }
async function callModel({ mode, system, user, history = [], maxTokens = 800 }) {
    let config;
    try {
        config = getModelConfig();
    } catch (error) {
        console.error("[model_adapter] config:", error.message);
        return { ok: false, error: "CONFIG_MISSING" };
    }

    const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 15000);
    const temperature = Number(process.env.AI_TEMPERATURE || 0.2);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const messages = [
        { role: "system", content: `[MODE:${mode}] ${system}` },
        ...history,
        { role: "user", content: user },
    ];

    try {
        const response = await fetch(config.baseUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.apiKey}`,
            },
            signal: controller.signal,
            body: JSON.stringify({
                model: config.model,
                chat_template_kwargs: { enable_thinking: false },
                temperature,
                max_tokens: maxTokens,
                messages,
            }),
        });

        if (!response.ok) {
            console.error("[model_adapter] HTTP", response.status);
            return { ok: false, error: "HTTP" };
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;

        if (typeof content !== "string" || !content.trim()) {
            return { ok: false, error: "EMPTY_CONTENT" };
        }

        return { ok: true, text: content.trim() };
    } catch (error) {
        console.error("[model_adapter] call failed:", error.name, error.message);
        return { ok: false, error: error.name === "AbortError" ? "TIMEOUT" : "HTTP" };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { callModel, getModelConfig };

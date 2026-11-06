"use strict";
/**
 * llm.js — 任意 OpenAI 兼容端点的流式客户端。
 *
 * 默认不打任何付费服务：endpoint 默认指向本机 Ollama（http://127.0.0.1:11434/v1）。
 * 也可以填任何自建/免费额度的兼容端点，apiKey 为空就不发 Authorization 头。
 *
 * 用法：
 *   const ctl = streamChat({ ... , onDelta(t), onDone({usage}), onError(err) });
 *   ctl.abort();
 */

function buildUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("endpoint 为空");
  if (!/^https?:\/\//i.test(base)) throw new Error(`endpoint 必须是 http(s):// 开头：${base}`);
  // 允许用户直接粘贴 ".../v1/chat/completions"
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      parts.push("");
      continue;
    }
    if (part.type === "text") parts.push(part.text || "");
    else if (part.type === "image_url") parts.push("[图片]");
    else parts.push("");
  }
  return parts.join(" ");
}

/**
 * 把内部消息格式转成 OpenAI messages。
 * 内部格式：{ role, content: string | Array<{type:'text'|'image_url', ...}> }
 */
function toOpenAIMessages(messages) {
  return (messages || []).map((m) => {
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    return { role, content: m.content };
  });
}

function makeSseParser(onEvent) {
  let buffer = "";
  return (chunkText) => {
    buffer += chunkText;
    for (;;) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) return;
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          onEvent({ done: true });
          continue;
        }
        try {
          onEvent({ json: JSON.parse(data) });
        } catch {
          /* 端点偶尔会发非 JSON 心跳，忽略 */
        }
      }
    }
  };
}

/**
 * @returns {{abort: () => void, promise: Promise<string>}}
 */
function streamChat(options) {
  const {
    baseUrl,
    apiKey = "",
    model,
    messages = [],
    temperature = 0.3,
    maxTokens = 1500,
    timeoutMs = 120000,
    onDelta = () => {},
    onDone = () => {},
    onError = () => {},
    extraBody = {},
  } = options || {};

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const promise = (async () => {
    let url;
    try {
      url = buildUrl(baseUrl);
    } catch (err) {
      clearTimeout(timer);
      onError(err);
      throw err;
    }
    if (!model) {
      const err = new Error("model 为空");
      clearTimeout(timer);
      onError(err);
      throw err;
    }

    const headers = { "content-type": "application/json", accept: "text/event-stream" };
    if (apiKey && apiKey.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;

    const body = {
      model,
      messages: toOpenAIMessages(messages),
      temperature,
      max_tokens: maxTokens,
      stream: true,
      ...extraBody,
    };

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const wrapped = timedOut
        ? new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：${url}`)
        : new Error(`连接失败：${err && err.message}（${url}）`);
      onError(wrapped);
      throw wrapped;
    }

    if (!res.ok || !res.body) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 600);
      } catch {}
      clearTimeout(timer);
      const err = new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
      onError(err);
      throw err;
    }

    let full = "";
    let usage = null;
    const feed = makeSseParser(({ json, done }) => {
      if (done) return;
      if (!json) return;
      if (json.usage) usage = json.usage;
      if (json.error) {
        onError(new Error(json.error.message || JSON.stringify(json.error)));
        return;
      }
      const choice = (json.choices && json.choices[0]) || null;
      if (!choice) return;
      const delta = choice.delta || {};
      const piece = typeof delta.content === "string" ? delta.content : normalizeContent(delta.content);
      if (piece) {
        full += piece;
        onDelta(piece);
      }
      // 某些端点（Ollama 原生）用 message.content 而不是 delta
      const msgPiece =
        !piece && choice.message && typeof choice.message.content === "string"
          ? choice.message.content
          : "";
      if (msgPiece && !full.endsWith(msgPiece)) {
        full += msgPiece;
        onDelta(msgPiece);
      }
    });

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      clearTimeout(timer);
      if (timedOut) {
        const e = new Error(`流式读取超时（${Math.round(timeoutMs / 1000)}s）`);
        onError(e);
        throw e;
      }
      if (controller.signal.aborted) {
        onDone({ text: full, usage, aborted: true });
        return full;
      }
      onError(err);
      throw err;
    }

    clearTimeout(timer);
    onDone({ text: full, usage, aborted: false });
    return full;
  })();

  promise.catch(() => {});
  return { abort: () => controller.abort(), promise };
}

/** 非流式的小请求，用于测试连通性。 */
async function ping({ baseUrl, apiKey = "", model, timeoutMs = 15000 }) {
  const url = buildUrl(baseUrl);
  const headers = { "content-type": "application/json" };
  if (apiKey && apiKey.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, detail: text.slice(0, 400) };
  } finally {
    clearTimeout(timer);
  }
}

/** 列出模型（OpenAI 兼容的 /models，Ollama 也支持）。 */
async function listModels({ baseUrl, apiKey = "", timeoutMs = 8000 }) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
  const headers = {};
  if (apiKey && apiKey.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/models`, { headers, signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status, models: [] };
    const json = await res.json();
    const models = (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean);
    return { ok: true, status: res.status, models };
  } catch (err) {
    return { ok: false, status: 0, models: [], error: err && err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 语音转写（OpenAI 兼容 /audio/transcriptions，可用于本地 whisper 服务）。 */
async function transcribe({
  baseUrl,
  apiKey = "",
  model = "whisper-1",
  audio,
  mime = "audio/webm",
  language = "",
  timeoutMs = 60000,
}) {
  const base = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/audio\/transcriptions$/i, "");
  const ext = /wav/i.test(mime) ? "wav" : /mp3/i.test(mime) ? "mp3" : /m4a/i.test(mime) ? "m4a" : "webm";
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mime }), `audio.${ext}`);
  form.append("model", model);
  if (language && String(language).trim()) form.append("language", String(language).trim());
  const headers = {};
  if (apiKey && apiKey.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    try {
      const json = JSON.parse(text);
      return json.text || "";
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { streamChat, ping, listModels, transcribe, buildUrl, toOpenAIMessages, makeSseParser, normalizeContent };

"use strict";
/* fuda renderer —— 无框架，直接用 DOM，避免任何构建步骤 */

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  providers: {}, // 服务商预设，来自主进程 store.PROVIDERS
  messages: [], // { role: 'user'|'assistant', text, image?, error? }
  streamId: null,
  streaming: false,
  pendingImage: null, // dataUrl
  mode: "answer",
  info: null,
};

const MODE_HINTS = {
  answer: { label: "答题", placeholder: "粘贴面试官的问题，Enter 发送…", extra: "" },
  listen: {
    label: "听题",
    placeholder: "截屏或粘贴面试官刚说的话（Ctrl+D 截屏）…",
    extra: "当前模式：实时听题。请先判断面试官在问什么，再按答题要求输出。",
  },
  code: {
    label: "代码",
    placeholder: "粘贴代码或报错，Enter 发送…",
    extra: "当前模式：代码解读。先给结论（能不能用/哪里错），再定位到具体行，最后给最小修复 patch。",
  },
};

// 要点卡格式：面试时只有 3 秒读答案，所以先给一句话，细节折叠，最后给预测追问
const ANSWER_CARD_RULES = [
  "【输出格式（必须严格遵守，不要解释格式）】",
  "第 1 行：一句话=<不超过 60 字、可以直接念出口的结论>",
  "空一行，写展开细节：2–5 条短句，带具体数字，不要重复那句话",
  "最后一行：追问=<问题A>|<问题B>|<问题C>，写面试官最可能接着问的 3 个问题",
  "除了以上三段不要写别的标题，也不要写『以下是』之类的话。",
].join("\n");

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function toast(text, ms = 1800) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 极简 markdown：``` 代码块 / `行内代码` / **粗体** / - 列表 / 1. 列表 / 空行分段 */
function renderRich(container, text) {
  container.textContent = "";
  const segments = String(text).split(/```/);
  segments.forEach((segment, index) => {
    if (index % 2 === 1) {
      const lines = segment.replace(/^\r?\n/, "").split(/\r?\n/);
      let lang = "";
      const first = (lines[0] || "").trim();
      if (first && /^[a-zA-Z0-9_+#.-]{1,20}$/.test(first)) {
        lang = first;
        lines.shift();
      }
      const body = lines.join("\n").replace(/\s+$/, "");
      container.appendChild(buildCodeBlock(body, lang));
      return;
    }
    segment
      .split(/\r?\n/)
      .forEach((line) => {
        if (!line.trim()) return;
        const bullet = line.match(/^\s*[-*]\s+(.*)$/);
        const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (bullet || numbered) {
          const isOrdered = !!numbered;
          const last = container.lastElementChild;
          const canAppend = last && last.tagName === (isOrdered ? "OL" : "UL");
          const list = canAppend ? last : container.appendChild(document.createElement(isOrdered ? "OL" : "UL"));
          const li = document.createElement("li");
          appendInline(li, isOrdered ? numbered[2] : bullet[1]);
          list.appendChild(li);
          return;
        }
        const heading = line.match(/^#{1,6}\s+(.*)$/);
        const p = document.createElement("p");
        if (heading) {
          const strong = document.createElement("strong");
          appendInline(strong, heading[1]);
          p.appendChild(strong);
        } else {
          appendInline(p, line);
        }
        container.appendChild(p);
      });
  });
  if (!container.childElementCount && text) {
    container.textContent = text;
  }
}

function appendInline(parent, text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      const b = document.createElement("strong");
      b.textContent = part.slice(2, -2);
      parent.appendChild(b);
    } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      const c = document.createElement("code");
      c.className = "inline";
      c.textContent = part.slice(1, -1);
      parent.appendChild(c);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

// ---------------------------------------------------------------------------
// 要点卡：一句话结论 + 折叠细节 + 预测追问
//   模型不按格式回答时自动退化成普通气泡，不会把"一句话="这种标记露出来
// ---------------------------------------------------------------------------
const HEAD_MARK = /^[ \t]*(?:\*\*)?[ \t]*(?:一句话|结论|要点)[ \t]*(?:\*\*)?[ \t]*[=:：][ \t]*/;
const ASK_LINE = /^[ \t]*(?:\*\*)?[ \t]*(?:追问|可能追问|下一问)[ \t]*(?:\*\*)?[ \t]*[=:：][ \t]*(.*)$/;
const ASK_INLINE = /(?:^|\n)[ \t]*(?:\*\*)?[ \t]*(?:追问|可能追问|下一问)[ \t]*(?:\*\*)?[ \t]*[=:：][ \t]*/;

function splitAsks(line) {
  return String(line || "")
    .split(/[|｜]/)
    .map((s) => s.replace(/^\s*(?:\d+[.)、]|[-*·])\s*/, "").replace(/^["“”']|["“”']$/g, "").trim())
    .filter((s) => s.length > 1)
    .slice(0, 4);
}

function parseAnswer(raw) {
  const text = String(raw || "").replace(/\r/g, "");
  const headMatch = text.match(HEAD_MARK);
  let head = "";
  let rest = text;
  if (headMatch) {
    rest = text.slice(headMatch[0].length);
    const nl = rest.indexOf("\n");
    head = (nl === -1 ? rest : rest.slice(0, nl)).trim();
    rest = nl === -1 ? "" : rest.slice(nl + 1);
  }
  // 流式过程中可能只收到 "一句话" 半个标记：先别把标记本身显示出来
  const partial = !headMatch && /^[ \t]*(?:\*\*)?[ \t]*(?:一句话|结论|要点)[ \t]*$/.test(text.trim());

  let body = rest;
  let asks = [];
  // 首选：单独一行 "追问=…|…"，从行里拆
  const lines = body.split("\n");
  const askIdx = lines.findIndex((l) => ASK_LINE.test(l));
  if (askIdx >= 0) {
    asks = splitAsks(lines[askIdx].match(ASK_LINE)[1]);
    body = lines.slice(0, askIdx).join("\n");
  } else {
    // 退化：追问写在段落中间
    const inline = body.match(ASK_INLINE);
    if (inline) {
      const at = inline.index;
      const tail = body.slice(at + inline[0].length).split("\n")[0];
      asks = splitAsks(tail);
      body = body.slice(0, at);
    }
  }
  body = body.replace(/^\s*\n/, "").trimEnd();
  const hasCard = !!head || asks.length > 0;
  return { head, body, asks, hasCard, partial };
}

function copyText(text) {
  window.api.clipboard.write(text).then(
    () => toast("已复制这句话"),
    () => toast("复制失败")
  );
}

function askFollowUp(question) {
  const input = $("input");
  input.value = question;
  send({ text: question });
}

function renderAnswer(container, raw, { streaming = false } = {}) {
  const parsed = parseAnswer(raw);
  if (!parsed.hasCard) {
    renderRich(container, parsed.partial ? "" : raw);
    return;
  }
  const wasCollapsed = container.dataset.collapsed === "1";
  container.textContent = "";

  const card = document.createElement("div");
  card.className = "answer-card";

  if (parsed.head) {
    const head = document.createElement("div");
    head.className = "answer-head";
    head.textContent = parsed.head;
    head.title = "点一下复制这句话";
    head.addEventListener("click", () => copyText(parsed.head));
    card.appendChild(head);
  }

  if (parsed.body) {
    const bodyWrap = document.createElement("div");
    bodyWrap.className = "answer-body";
    const inner = document.createElement("div");
    inner.className = "answer-body-in";
    renderRich(inner, parsed.body);
    bodyWrap.appendChild(inner);
    card.appendChild(bodyWrap);

    // 细节太长就折叠：面试时不需要滚，点开才看
    requestAnimationFrame(() => {
      const long = inner.scrollHeight > 190;
      if (!long) {
        bodyWrap.classList.remove("is-collapsed");
        container.dataset.collapsed = "0";
        return;
      }
      const collapsed = streaming ? false : wasCollapsed !== false && container.dataset.collapsed !== "0";
      bodyWrap.classList.toggle("is-collapsed", collapsed);
      container.dataset.collapsed = collapsed ? "1" : "0";
      if (!bodyWrap.querySelector(".answer-more")) {
        const more = document.createElement("button");
        more.className = "answer-more";
        more.type = "button";
        more.textContent = collapsed ? "展开细节 ▾" : "收起 ▴";
        more.addEventListener("click", (e) => {
          e.stopPropagation();
          const next = !bodyWrap.classList.contains("is-collapsed");
          bodyWrap.classList.toggle("is-collapsed", next);
          container.dataset.collapsed = next ? "1" : "0";
          more.textContent = next ? "展开细节 ▾" : "收起 ▴";
        });
        bodyWrap.appendChild(more);
      }
    });
  }

  if (parsed.asks.length) {
    const bar = document.createElement("div");
    bar.className = "ask-next";
    const label = document.createElement("span");
    label.className = "ask-next-label";
    label.textContent = "他可能追问";
    bar.appendChild(label);
    for (const q of parsed.asks) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ask-chip";
      chip.textContent = q;
      chip.title = "点一下，直接按这个问题回答";
      chip.addEventListener("click", () => askFollowUp(q));
      bar.appendChild(chip);
    }
    card.appendChild(bar);
  }

  container.appendChild(card);
}

function buildCodeBlock(body, lang) {
  const wrap = document.createElement("div");
  wrap.className = "code-block";
  const head = document.createElement("header");
  const label = document.createElement("span");
  label.textContent = lang || "code";
  const copy = document.createElement("button");
  copy.className = "copy-btn";
  copy.textContent = "复制";
  copy.addEventListener("click", async () => {
    await window.api.clipboard.write(body);
    copy.textContent = "已复制";
    setTimeout(() => (copy.textContent = "复制"), 1200);
  });
  head.append(label, copy);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = body;
  pre.appendChild(code);
  wrap.append(head, pre);
  return wrap;
}

// 实际生效的热键表（主进程会把降级后的真实键回传过来）
let BOUND_KEYS = {};

function emptyHintText() {
  const k = (action, fallback) => BOUND_KEYS[action] || fallback;
  return (
    k("toggle", "Ctrl+E") +
    " 开关窗口 · " +
    k("capture", "Ctrl+D") +
    " 截屏提问 · " +
    k("reset", "Ctrl+Shift+R") +
    " 清空"
  );
}

function paintHotkeyHints() {
  const hint = $("emptyHint");
  if (hint) hint.textContent = emptyHintText();
  const cap = $("btnCapture");
  if (cap) cap.title = `截屏提问 (${BOUND_KEYS.capture || "Ctrl+D"})`;
  const mouse = $("btnMouse");
  if (mouse) mouse.title = `鼠标穿透 (${BOUND_KEYS.mouseThrough || "Ctrl+Shift+X"})`;
  const close = $("btnClose");
  if (close) close.title = `隐藏窗口 (${BOUND_KEYS.toggle || "Ctrl+E"} 开/关)`;
  const input = $("input");
  if (input) input.placeholder = `粘贴问题 / 截屏提问（${BOUND_KEYS.capture || "Ctrl+D"}）… Enter 发送，Shift+Enter 换行`;
  const kbd = $("mouseThroughKbd");
  if (kbd) kbd.textContent = BOUND_KEYS.mouseThrough || "Ctrl+Shift+X";
}

function configHintText() {
  const s = state.settings || {};
  const local = /127\.0\.0\.1|localhost/i.test(s.endpoint || "");
  if (s.apiKey || local) {
    const name = (state.providers[s.provider] || {}).label || s.endpoint || "";
    return `当前接口：${name}${s.model ? ` / ${s.model}` : ""}，点 ⚙ 可随时更换服务商或模型。`;
  }
  return "还没配置 AI 接口：点 ⚙ 选服务商、填 API Key 就能用（OpenAI / DeepSeek / Kimi / 硅基流动 / 本机 Ollama 都支持）。";
}

// ---------------------------------------------------------------------------
// 消息渲染
// ---------------------------------------------------------------------------
function clearMessages() {
  state.messages = [];
  $("messages").innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.id = "empty";
  empty.innerHTML =
    `<p class="empty-title" id="emptyHint">${emptyHintText()}</p>` +
    `<p class="empty-sub" id="emptySub">${configHintText()}</p>`;
  $("messages").appendChild(empty);
}

function addMessageNode(role, { image } = {}) {
  const existingEmpty = $("empty");
  if (existingEmpty) existingEmpty.remove();

  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const roleEl = document.createElement("span");
  roleEl.className = "role";
  roleEl.textContent = role === "user" ? "你" : "浮答";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (image) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = image;
    bubble.appendChild(img);
  }

  const body = document.createElement("div");
  body.className = "msg-body";
  bubble.appendChild(body);

  wrap.append(roleEl, bubble);

  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const copyBtn = document.createElement("button");
  copyBtn.textContent = "复制";
  copyBtn.addEventListener("click", async () => {
    await window.api.clipboard.write(bubble.innerText);
    toast("已复制");
  });
  actions.appendChild(copyBtn);
  wrap.appendChild(actions);

  $("messages").appendChild(wrap);
  $("messages").scrollTop = $("messages").scrollHeight;
  return { wrap, bubble, body };
}

function appendAssistantText(node, text) {
  node.text = (node.text || "") + text;
  renderRich(node.body, node.text);
  const m = $("messages");
  if (m.scrollHeight - m.scrollTop - m.clientHeight < 120) {
    m.scrollTop = m.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// 截屏
// ---------------------------------------------------------------------------
async function doCapture() {
  const res = await window.api.capture();
  if (!res || !res.ok) {
    toast(`截屏失败：${(res && res.error) || "未知错误"}`, 3200);
    return;
  }
  state.pendingImage = res.dataUrl;
  const bar = $("attachBar");
  bar.hidden = false;
  $("attachThumb").src = res.dataUrl;
  $("attachSize").textContent = `${res.width}×${res.height} · ${res.displayName || "屏幕"}`;
  $("input").focus();
  toast("已截屏，可直接发送或补充问题");
}

// ---------------------------------------------------------------------------
// 语音提问：录一段 → 交给主进程转发 /audio/transcriptions → 填进输入框
// ---------------------------------------------------------------------------
let recorder = null;
let recordTimer = null;
const MAX_RECORD_MS = 60000;

async function doMic() {
  const btn = $("btnMic");

  // 正在录 → 停止（结果在 onstop 里处理）
  if (recorder) {
    try {
      recorder.stop();
    } catch {}
    return;
  }
  if (state.streaming) {
    toast("上一轮还在回答，先等一下");
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    toast(`拿不到麦克风：${(err && err.message) || err}`, 3600);
    return;
  }

  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  const chunks = [];
  try {
    recorder = new MediaRecorder(stream, { mimeType: mime });
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    toast(`浏览器不支持录音：${(err && err.message) || err}`, 3600);
    return;
  }

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onstop = async () => {
    const current = recorder;
    recorder = null;
    clearTimeout(recordTimer);
    recordTimer = null;
    btn.classList.remove("recording");
    stream.getTracks().forEach((t) => t.stop());

    const blob = new Blob(chunks, { type: mime });
    if (!blob.size) {
      toast("没录到声音，再试一次", 2600);
      return;
    }
    toast("转写中…", 30000);
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const res = await window.api.asr.transcribe(bytes, mime);
      if (!res || !res.ok) {
        toast(`转写失败：${(res && res.error) || "未知错误"}`, 4000);
        return;
      }
      const text = String(res.text || "").trim();
      if (!text) {
        toast("转写结果为空（端点可能不支持 /audio/transcriptions）", 4000);
        return;
      }
      const input = $("input");
      input.value = input.value ? `${input.value} ${text}` : text;
      input.focus();
      autoGrow(input);
      toast("已转写，检查一下再发送", 2200);
    } catch (err) {
      toast(`转写出错：${(err && err.message) || err}`, 3600);
    } finally {
      if (current) current.stream = null;
    }
  };

  recorder.start();
  btn.classList.add("recording");
  toast("录音中… 再点一次 🎙 停止", 3000);
  recordTimer = setTimeout(() => {
    if (recorder) {
      toast("录音到 60 秒上限，自动停止", 2400);
      try {
        recorder.stop();
      } catch {}
    }
  }, MAX_RECORD_MS);
}

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------
function buildRequestMessages() {
  const sys = {
    role: "system",
    content: [
      state.settings.systemPrompt,
      MODE_HINTS[state.mode].extra,
      state.settings.answerCard === false ? "" : ANSWER_CARD_RULES,
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim(),
  };
  const history = state.messages
    .filter((m) => !m.error)
    .slice(-12)
    .map((m) => ({
      role: m.role,
      content: m.image
        ? [
            { type: "text", text: m.text || "请看这张截图" },
            { type: "image_url", image_url: { url: m.image } },
          ]
        : m.text,
    }));
  return [sys, ...history];
}

async function send(opts = {}) {
  if (state.streaming) return;
  const input = $("input");
  const text = (opts.text !== undefined ? String(opts.text) : input.value).trim();
  const chatMode = opts.mode || "answer";
  const image = state.pendingImage;
  if (!text && !image) return;

  const userMsg = { role: "user", text: text || (image ? "请看这张截图" : ""), image: image || undefined };
  state.messages.push(userMsg);

  const node = addMessageNode("user", { image: image || undefined });
  if (text) renderRich(node.body, text);
  else node.body.textContent = "（截图）";

  input.value = "";
  input.style.height = "auto";
  clearAttach();

  // 助手气泡
  const assistant = addMessageNode("assistant");
  assistant.body.classList.add("typing");
  const record = { role: "assistant", text: "" };
  state.messages.push(record);

  state.streaming = true;
  state.streamId = `s${Date.now()}`;
  $("btnSend").disabled = true;
  $("btnStop").hidden = false;

  const useVision = !!image;
  const res = await window.api.chat.start({
    id: state.streamId,
    messages: buildRequestMessages(),
    useVision,
    mode: chatMode,
  });
  if (!res || !res.ok) {
    assistant.body.classList.remove("typing");
    assistant.body.textContent = `启动失败：${(res && res.error) || "未知错误"}`;
    finishStream();
    return;
  }

  // 工作台里检索到的资料片段：显示成一行小字，让人知道这段答案是"从哪来的"
  if (res.refs && res.refs.length) {
    const refsEl = document.createElement("div");
    refsEl.className = "msg-refs";
    refsEl.textContent = "参考：" + res.refs.map((r) => r.name).join(" / ");
    refsEl.title = res.refs.map((r) => `《${r.name}》${r.snippet}`).join("\n\n");
    assistant.wrap.appendChild(refsEl);
  }
}

function finishStream() {
  state.streaming = false;
  state.streamId = null;
  $("btnSend").disabled = false;
  $("btnStop").hidden = true;
}

/**
 * 救场：答不上来时按 Ctrl+Alt+S。
 * 有输入框内容就当那是被问住的题；没有就用上一轮的题；都没有给一句通用的。
 */
async function doRescue() {
  if (state.streaming) return;
  const input = $("input");
  let q = input.value.trim();
  if (!q) {
    const last = previousUserText();
    q = last || "（面试官刚问了一个我答不上来的问题，给我一段救场话术）";
    input.value = q;
  }
  toast("救场中：承认 + 迁移 + 把球抛回去");
  await send({ mode: "rescue" });
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
function bindEvents() {
  window.api.on("chat:delta", ({ id, text }) => {
    if (id !== state.streamId) return;
    const record = state.messages[state.messages.length - 1];
    if (!record || record.role !== "assistant") return;
    record.text += text;
    const node = $("messages").lastElementChild;
    const body = node && node.querySelector(".msg-body");
    if (!body) return;
    body.classList.remove("typing");
    renderAnswer(body, record.text, { streaming: true });
    const m = $("messages");
    if (m.scrollHeight - m.scrollTop - m.clientHeight < 140) m.scrollTop = m.scrollHeight;
  });

  window.api.on("chat:done", async ({ id, text, aborted }) => {
    if (id !== state.streamId) return;
    const record = state.messages[state.messages.length - 1];
    const node = $("messages").lastElementChild;
    const body = node && node.querySelector(".msg-body");
    if (body) body.classList.remove("typing");
    if (record && record.role === "assistant") {
      if (typeof text === "string" && text && record.text !== text) {
        record.text = text;
        if (body) renderAnswer(body, text);
      }
      if (!record.text) {
        record.error = true;
        if (body) {
          body.classList.add("error-bubble");
          body.textContent = "（空响应：模型没返回内容，检查端点/模型名）";
        }
      } else {
        window.api.records.add({
          mode: state.mode,
          model: state.settings.model,
          question: previousUserText(),
          answer: record.text,
        });
      }
    }
    if (aborted) toast("已停止");
    finishStream();
  });

  window.api.on("chat:error", ({ id, message }) => {
    if (id !== state.streamId) return;
    const node = $("messages").lastElementChild;
    const body = node && node.querySelector(".msg-body");
    const record = state.messages[state.messages.length - 1];
    if (record && record.role === "assistant") record.error = true;
    if (body) {
      body.classList.remove("typing");
      body.classList.add("error-bubble");
      renderRich(body, `请求失败：${message}`);
    }
    finishStream();
  });

  window.api.on("stealth:status", (status) => renderStealth(status));
  window.api.on("ui:action", (payload) => {
    const name = payload && payload.name;
    if (name === "capture") doCapture();
    if (name === "rescue") doRescue();
    if (name === "settings") openSettings();
    if (name === "reset") {
      clearMessages();
      toast("已清空");
    }
  });
  window.api.on("ui:notice", ({ text }) => toast(text));
  window.api.on("ui:error", ({ message }) => toast(`错误：${message}`, 3000));
  window.api.on("ui:mouse-through", ({ on }) => {
    $("mouseBanner").hidden = !on;
    $("btnMouse").classList.toggle("active", on);
  });
  window.api.on("env:hotkeys", renderHotkeys);

  $("btnSend").addEventListener("click", send);
  $("btnStop").addEventListener("click", () => {
    if (state.streamId) window.api.chat.abort(state.streamId);
  });
  $("btnCapture").addEventListener("click", doCapture);
  $("btnRescue").addEventListener("click", doRescue);
  $("btnMic").addEventListener("click", doMic);
  $("btnClipboard").addEventListener("click", async () => {
    const text = await window.api.clipboard.read();
    if (!text) return toast("剪贴板是空的");
    $("input").value = text;
    $("input").focus();
    autoGrow();
  });
  $("btnMouse").addEventListener("click", () => window.api.window.mouseThrough());
  $("btnClose").addEventListener("click", () => window.api.window.hide());
  $("btnSettings").addEventListener("click", openSettings);
  $("btnSettingsClose").addEventListener("click", () => ($("settings").hidden = true));
  $("attachRemove").addEventListener("click", clearAttach);

  $("input").addEventListener("input", autoGrow);
  $("input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
    if (event.key === "Escape") window.api.window.hide();
  });

  document.querySelectorAll(".mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.mode = btn.dataset.mode;
      $("input").placeholder = MODE_HINTS[state.mode].placeholder;
    });
  });

  // 设置面板
  $("fProvider").addEventListener("change", (event) => {
    applyProviderHint(event.target.value);
    applyProviderPreset(event.target.value);
  });
  $("btnSaveSettings").addEventListener("click", saveSettings);
  $("btnTest").addEventListener("click", async () => {
    const out = $("probeOutput");
    out.hidden = false;
    out.textContent = "测试中…";
    const res = await window.api.models.ping();
    out.textContent = res.ok
      ? `连通 OK（HTTP ${res.status}）\n${res.detail || ""}`
      : `失败：${res.error || `HTTP ${res.status}`}`;
  });
  $("btnModels").addEventListener("click", async () => {
    const out = $("probeOutput");
    out.hidden = false;
    out.textContent = "查询模型列表…";
    const res = await window.api.models.list();
    out.textContent = res.ok
      ? `可用模型（${res.models.length}）：\n${res.models.map((m) => `· ${m}`).join("\n")}`
      : `查询失败：HTTP ${res.status}`;
  });
  $("btnRecords").addEventListener("click", () => window.api.openRecords());
  $("btnQuit").addEventListener("click", () => window.api.quit());
  $("btnReapply").addEventListener("click", async () => {
    const status = await window.api.stealth.apply({
      contentProtection: $("fContentProtection").checked,
      displayAffinity: $("fDisplayAffinity").checked,
      hideFromTaskbar: $("fHideTaskbar").checked,
    });
    renderStealth(status);
    const affinity = await window.api.stealth.readAffinity();
    $("affinityRead").textContent = affinity;
  });
  $("fOpacity").addEventListener("input", (event) => {
    const v = Number(event.target.value);
    $("opacityValue").textContent = `${Math.round(v * 100)}%`;
    window.api.window.setOpacity(v);
  });
}

function autoGrow() {
  const el = $("input");
  el.style.height = "auto";
  el.style.height = `${Math.min(132, el.scrollHeight)}px`;
}

function clearAttach() {
  state.pendingImage = null;
  $("attachBar").hidden = true;
  $("attachThumb").src = "";
}

function previousUserText() {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    if (state.messages[i].role === "user") return state.messages[i].text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 状态展示
// ---------------------------------------------------------------------------
function renderStealth(status) {
  if (!status) return;
  const dot = $("stealthDot");
  const badge = $("stealthBadge");
  dot.className = "dot";
  const affinity = status.affinity;
  if (affinity === "exclude") {
    dot.classList.add("on");
    badge.textContent = "隐身：录屏不可见";
  } else if (affinity === "monitor") {
    dot.classList.add("warn");
    badge.textContent = "隐身：降级（画面变黑）";
  } else if (affinity === "best-effort") {
    dot.classList.add("warn");
    badge.textContent = "隐身：尽力（macOS）";
  } else if (affinity === "disabled") {
    dot.classList.add("off");
    badge.textContent = "隐身：已关闭";
  } else {
    dot.classList.add("off");
    badge.textContent = `隐身：${affinity}`;
  }
  badge.title = `contentProtection=${status.contentProtection} affinity=${affinity} exStyle=${status.exStyle}`;
  $("affinityRead").textContent = affinity;
}

function renderHotkeys(list) {
  if (!Array.isArray(list) || !list.length) return;
  BOUND_KEYS = {};
  for (const item of list) {
    if (item && item.ok && item.accelerator) BOUND_KEYS[item.action] = item.accelerator;
  }
  paintHotkeyHints();
  const el = $("hotkeyList");
  el.textContent = "";
  const names = {
    toggle: "开关窗口",
    reset: "清空会话",
    capture: "截屏提问",
    mouseThrough: "鼠标穿透",
    moveUp: "上移",
    moveDown: "下移",
    moveLeft: "左移",
    moveRight: "右移",
    zoomIn: "放大",
    zoomOut: "缩小",
    opacityUp: "更不透明",
    opacityDown: "更透明",
    quit: "退出",
  };
  for (const item of list) {
    const line = document.createElement("div");
    const ok = item.ok ? "✓" : "✗";
    line.textContent = `${ok} ${item.accelerator || "—"}  ${names[item.action] || item.action}${
      item.ok ? "" : `（${item.reason || "未注册"}）`
    }`;
    line.style.color = item.ok ? "" : "var(--warn)";
    el.appendChild(line);
  }
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
function fillProviderSelect(current) {
  const sel = $("fProvider");
  if (!sel) return;
  const providers = state.providers || {};
  sel.innerHTML = "";
  for (const [key, p] of Object.entries(providers)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = p.label || key;
    sel.appendChild(opt);
  }
  sel.value = providers[current] ? current : "custom";
  applyProviderHint(sel.value);
}

function applyProviderHint(key) {
  const p = (state.providers || {})[key];
  const hint = $("fProviderHint");
  if (hint) hint.textContent = (p && p.hint) || "选一个就会自动填好接口地址和模型";
}

// 切换预设时把地址/模型填好；"自定义"保留用户已经填的内容
function applyProviderPreset(key) {
  const p = (state.providers || {})[key];
  if (!p || key === "custom") return;
  $("fEndpoint").value = p.endpoint || "";
  $("fModel").value = p.model || "";
  $("fVisionModel").value = p.visionModel || "";
}

function fillSettingsForm() {
  const s = state.settings;
  fillProviderSelect(s.provider);
  $("fEndpoint").value = s.endpoint;
  $("fApiKey").value = s.apiKey || "";
  $("fModel").value = s.model;
  $("fVisionModel").value = s.visionModel || "";
  $("fTemperature").value = s.temperature;
  $("fMaxTokens").value = s.maxTokens;
  $("fTimeout").value = Math.round((s.timeoutMs || 120000) / 1000);
  $("fSystemPrompt").value = s.systemPrompt;
  $("fAnswerCard").checked = s.answerCard !== false;
  $("fContentProtection").checked = !!s.stealth.contentProtection;
  $("fDisplayAffinity").checked = !!s.stealth.displayAffinity;
  $("fHideTaskbar").checked = !!s.stealth.hideFromTaskbar;
  $("fOpacity").value = s.window.opacity;
  $("opacityValue").textContent = `${Math.round(s.window.opacity * 100)}%`;
}

async function openSettings() {
  $("settings").hidden = false;
  fillSettingsForm();
  $("affinityRead").textContent = await window.api.stealth.readAffinity();
}

async function saveSettings() {
  const patch = {
    provider: $("fProvider").value,
    endpoint: $("fEndpoint").value.trim(),
    apiKey: $("fApiKey").value,
    model: $("fModel").value.trim(),
    visionModel: $("fVisionModel").value.trim(),
    temperature: Number($("fTemperature").value),
    maxTokens: Number($("fMaxTokens").value),
    timeoutMs: Number($("fTimeout").value) * 1000,
    systemPrompt: $("fSystemPrompt").value,
    answerCard: $("fAnswerCard").checked,
    stealth: {
      contentProtection: $("fContentProtection").checked,
      displayAffinity: $("fDisplayAffinity").checked,
      hideFromTaskbar: $("fHideTaskbar").checked,
    },
  };
  state.settings = await window.api.settings.save(patch);
  const status = await window.api.stealth.apply(state.settings.stealth);
  renderStealth(status);
  const sub = $("emptySub");
  if (sub) sub.textContent = configHintText();
  toast("已保存");
  $("settings").hidden = true;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function boot() {
  state.settings = await window.api.settings.get();
  state.providers = (await window.api.settings.providers()) || {};
  state.mode = state.settings.mode || "answer";
  document.querySelectorAll(".mode").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.mode)
  );
  $("input").placeholder = MODE_HINTS[state.mode].placeholder;

  bindEvents();
  fillSettingsForm();
  autoGrow();

  state.info = await window.api.info();
  renderStealth(state.info.stealth);
  $("input").focus();
}

boot();

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
    placeholder: "点 🎙 开始听系统声音，或粘贴/截屏面试官的问题…",
    extra: "当前模式：听题。输入可能来自系统声音的连续转写，先判断面试官在问什么，再按答题要求输出。",
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

// ---------------------------------------------------------------------------
// 听题：系统声音回环 → 16k 单声道 PCM → VAD 断句 → WAV 片段 → 逐段转写
// 麦克风只作为“线下面对面”的备选；默认优先抓系统输出，戴耳机也能听到面试官。
// ---------------------------------------------------------------------------
const LISTEN_MIN_MS = 500;
const LISTEN_TARGET_RATE = 16000;
const LISTEN_MAX_QUEUE = 4;
const LISTEN_VAD = {
  startRms: 0.0045,
  endRms: 0.0025,
  silenceMs: 1400,
  minSpeechMs: 1200,
  maxSegmentMs: 12000,
  preRollMs: 300,
  tailMs: 200,
};
const listen = {
  active: false,
  connecting: false,
  stream: null,
  ctx: null,
  source: null,
  processor: null,
  gain: null,
  segmenter: null,
  sampleRate: 0,
  queue: [],
  sending: false,
  runId: 0,
  token: 0,
  startedAt: 0,
  timer: null,
  rms: 0,
  lastText: "",
  buffer: "",
  errors: 0,
  dropped: 0,
  sourceKind: "",
};

function listenSetState(text) {
  const el = $("listenState");
  if (el) el.textContent = text;
}

function formatClock(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

async function openListenStream() {
  let systemError = null;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error("当前环境不支持系统声音采集");
    }
    // 视频轨道只是 getDisplayMedia 的载体，不渲染，但必须保留：
    // 停掉 video 后 Chromium 的 loopback 音频缓冲约 1.8 秒就停止回调（实测）。
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // 视频只用来维持回环会话，压到 640×360 / 1fps，避免长时间面试占显存。
      video: { frameRate: 1, width: { max: 640 }, height: { max: 360 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const audio = stream.getAudioTracks()[0];
    if (audio) return { stream, kind: "system" };
    stream.getTracks().forEach((t) => t.stop());
    systemError = new Error("没有拿到系统声音轨道");
  } catch (err) {
    systemError = err;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return { stream, kind: "mic" };
  } catch (err) {
    const a = (systemError && systemError.message) || "未知";
    const b = (err && err.message) || err;
    throw new Error(`系统声音不可用（${a}），麦克风也不可用（${b}）`);
  }
}

function downsample(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += samples[j];
      count += 1;
    }
    out[i] = count ? sum / count : 0;
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function enqueueListenChunk(samples) {
  if (!samples || !samples.length) return;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  // VAD 已经按语音边界切过；这里再兜底一次，完全静音的片段不发请求。
  if (rms < 0.0012) return;
  if (samples.length < (listen.sampleRate || LISTEN_TARGET_RATE) * (LISTEN_MIN_MS / 1000)) return;

  const pcm = downsample(samples, listen.sampleRate || LISTEN_TARGET_RATE, LISTEN_TARGET_RATE);
  const wav = encodeWav(pcm, LISTEN_TARGET_RATE);
  if (listen.queue.length >= LISTEN_MAX_QUEUE) {
    listen.queue.shift();
    listen.dropped += 1;
    if (listen.dropped === 1) toast("转写积压，已丢弃最早的一段", 3000);
  }
  listen.queue.push(wav);
  drainListenQueue(listen.runId);
}

function flushListenBuffer() {
  if (!listen.buffer) return;
  const text = listen.buffer;
  listen.buffer = "";
  const input = $("input");
  input.value = input.value.trim() ? `${input.value.replace(/\s+$/, "")} ${text}` : text;
  // 不抢焦点：面试时悬浮窗一旦 focus 会把焦点从会议页面抢走。
  input.scrollTop = input.scrollHeight;
  autoGrow(input);
}

function appendListenText(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean || clean === listen.lastText) return;
  listen.lastText = clean;
  $("listenCaption").textContent = clean;
  listen.buffer = listen.buffer ? `${listen.buffer} ${clean}` : clean;
  // 模型正在流式回答时先攒着，等回答结束再放进输入框，避免把“下一题”覆盖到当前输入里。
  if (!state.streaming) flushListenBuffer();
}

async function transcribeWithRetry(bytes, runId) {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (listen.runId !== runId) return null;
    try {
      const res = await window.api.asr.transcribe(bytes, "audio/wav");
      if (res && res.ok) return res;
      lastError = (res && res.error) || "未知错误";
    } catch (err) {
      lastError = (err && err.message) || String(err);
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error(lastError || "转写失败");
}

async function drainListenQueue(runId) {
  if (listen.sending) return;
  listen.sending = true;
  while (listen.queue.length && listen.runId === runId) {
    const bytes = listen.queue.shift();
    try {
      const res = await transcribeWithRetry(bytes, runId);
      if (listen.runId !== runId) break;
      if (res && res.ok) appendListenText(res.text);
    } catch (err) {
      if (listen.runId !== runId) break;
      listen.errors += 1;
      if (listen.errors <= 2) {
        toast(
          `听题转写失败：${(err && err.message) || err}；可在设置 → 语音转写里单独配置 ASR`,
          5200
        );
      }
    }
  }
  listen.sending = false;
  // 上一轮还在转写时用户又开始了新一轮：旧 drain 退出后要把新队列接起来。
  if (listen.queue.length) {
    drainListenQueue(listen.runId);
    return;
  }
  if (!listen.active && !listen.queue.length) {
    listenSetState("已停止");
    setTimeout(() => {
      if (!listen.active && !listen.sending) $("listenBar").hidden = true;
    }, 1500);
  }
}

function cleanupListenAudio() {
  listen.segmenter = null;
  if (listen.processor) {
    listen.processor.onaudioprocess = null;
    try {
      listen.processor.disconnect();
    } catch {}
    listen.processor = null;
  }
  if (listen.source) {
    try {
      listen.source.disconnect();
    } catch {}
    listen.source = null;
  }
  if (listen.gain) {
    try {
      listen.gain.disconnect();
    } catch {}
    listen.gain = null;
  }
  if (listen.ctx) {
    const ctx = listen.ctx;
    listen.ctx = null;
    try {
      ctx.close();
    } catch {}
  }
  if (listen.stream) {
    listen.stream.getTracks().forEach((t) => t.stop());
    listen.stream = null;
  }
  if (listen.timer) {
    clearInterval(listen.timer);
    listen.timer = null;
  }
}

async function createListenPipeline(stream) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try {
    ctx = new Ctx({ sampleRate: LISTEN_TARGET_RATE });
  } catch {
    ctx = new Ctx();
  }
  listen.ctx = ctx;
  listen.sampleRate = ctx.sampleRate || LISTEN_TARGET_RATE;
  if (!window.FudaVad || !window.FudaVad.createSegmenter) {
    throw new Error("听题组件未加载（vad.js）");
  }
  listen.segmenter = window.FudaVad.createSegmenter(
    Object.assign({ sampleRate: listen.sampleRate }, LISTEN_VAD)
  );
  listen.source = ctx.createMediaStreamSource(stream);
  listen.processor = ctx.createScriptProcessor(4096, 1, 1);
  listen.gain = ctx.createGain();
  listen.gain.gain.value = 0;
  listen.source.connect(listen.processor);
  listen.processor.connect(listen.gain);
  listen.gain.connect(ctx.destination);
  listen.processor.onaudioprocess = (event) => {
    if (!listen.active || !listen.segmenter) return;
    const input = event.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
    listen.rms = Math.sqrt(sum / input.length);
    const segments = listen.segmenter.push(new Float32Array(input));
    for (const segment of segments) enqueueListenChunk(segment);
  };
  if (ctx.state === "suspended" && ctx.resume) await ctx.resume();
}

function listenTick() {
  if (!listen.active) return;
  $("listenTime").textContent = formatClock(Date.now() - listen.startedAt);
  const level = Math.min(100, Math.round(listen.rms * 900));
  $("listenLevel").style.width = `${level}%`;
  if (listen.sending && !listen.queue.length) listenSetState("转写中…");
  else listenSetState(listen.sourceKind === "system" ? "听题中" : "麦克风听题中");
}

async function startListening() {
  if (listen.active || listen.connecting) return;
  if (state.streaming) {
    toast("上一轮还在回答，先等一下");
    return;
  }
  if (!navigator.mediaDevices) {
    toast("当前环境不支持音频采集", 3600);
    return;
  }

  listen.connecting = true;
  const token = ++listen.token;
  listen.runId += 1;
  listenSetState("连接系统声音…");
  $("listenBar").hidden = false;
  $("listenTime").textContent = "00:00";
  $("listenLevel").style.width = "0%";
  $("listenCaption").textContent = "正在连接系统声音…";

  try {
    const opened = await openListenStream();
    if (token !== listen.token) {
      opened.stream.getTracks().forEach((t) => t.stop());
      return;
    }
    listen.stream = opened.stream;
    listen.sourceKind = opened.kind;
    listen.queue = [];
    listen.segmenter = null;
    listen.lastText = "";
    listen.buffer = "";
    listen.errors = 0;
    listen.dropped = 0;
    listen.startedAt = Date.now();
    listen.active = true;
    listen.connecting = false;
    await createListenPipeline(listen.stream);
    if (token !== listen.token) {
      cleanupListenAudio();
      return;
    }
    listen.timer = setInterval(listenTick, 500);
    listenTick();
    $("listenCaption").textContent =
      opened.kind === "system" ? "正在听系统声音…" : "正在听麦克风…";
    $("btnMic").classList.add("recording");
    toast(
      opened.kind === "system" ? "听题中：正在听系统声音" : "没拿到系统声音，已切到麦克风",
      3200
    );
  } catch (err) {
    listen.connecting = false;
    listen.active = false;
    cleanupListenAudio();
    $("btnMic").classList.remove("recording");
    $("listenBar").hidden = true;
    toast(`开始听题失败：${(err && err.message) || err}`, 5000);
  }
}

function stopListening(reason = "手动停止") {
  if (!listen.active && !listen.connecting) return;
  const wasActive = listen.active;
  listen.token += 1;
  listen.active = false;
  listen.connecting = false;
  if (listen.segmenter) {
    const rest = listen.segmenter.flush();
    listen.segmenter = null;
    for (const segment of rest) enqueueListenChunk(segment);
  }
  cleanupListenAudio();
  $("btnMic").classList.remove("recording");
  if (wasActive) {
    listenSetState("已停止");
    toast(reason === "手动停止" ? "已停止听题" : reason, 1800);
  }
  setTimeout(() => {
    if (!listen.active && !listen.sending) $("listenBar").hidden = true;
  }, 2200);
  if (listen.queue.length) drainListenQueue(listen.runId);
}

function onMicClick() {
  if (state.mode !== "listen") {
    doMic();
    return;
  }
  if (listen.active || listen.connecting) stopListening("手动停止");
  else startListening();
}

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
  // 回答期间听题继续跑；结束后再把“下一题”放进输入框，期间不覆盖用户正在看的内容。
  flushListenBuffer();
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
  $("btnMic").addEventListener("click", onMicClick);
  $("btnListenStop").addEventListener("click", () => stopListening("手动停止"));
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
      $("btnMic").title =
        state.mode === "listen"
          ? "听题：点一下开始听系统声音，再点一下停止"
          : "语音提问：点一下开始录音，再点一下停止并转文字";
      if (listen.active && state.mode !== "listen") stopListening("切换模式");
      state.settings.mode = state.mode;
      window.api.settings
        .save({ mode: state.mode })
        .then((s) => {
          state.settings = s;
        })
        .catch(() => {});
    });
  });

  // 设置面板
  $("fProvider").addEventListener("change", (event) => {
    applyProviderHint(event.target.value);
    applyProviderPreset(event.target.value);
  });
  $("btnSaveSettings").addEventListener("click", saveSettings);
  $("btnAsrTest").addEventListener("click", testAsr);
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
  $("fAsrEndpoint").value = s.asrEndpoint || "";
  $("fAsrApiKey").value = s.asrApiKey || "";
  $("fAsrModel").value = s.asrModel || "whisper-1";
  $("fAsrLanguage").value = s.asrLanguage || "zh";
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

async function testAsr() {
  const btn = $("btnAsrTest");
  const stateEl = $("asrTestState");
  if (!btn || !stateEl) return;
  const endpoint = $("fAsrEndpoint").value.trim();
  if (endpoint && !/^https?:\/\//i.test(endpoint)) {
    toast("ASR 接口地址要以 http:// 或 https:// 开头", 3600);
    return;
  }
  btn.disabled = true;
  stateEl.textContent = "正在发测试音…";
  try {
    const res = await window.api.asr.test({
      endpoint,
      apiKey: $("fAsrApiKey").value,
      model: $("fAsrModel").value.trim() || "whisper-1",
      language: $("fAsrLanguage").value.trim(),
    });
    if (res && res.ok) {
      stateEl.textContent = res.text ? `成功：${res.text.slice(0, 40)}` : "成功：接口可用（返回空文本）";
      toast("ASR 接口测试通过", 2600);
    } else {
      stateEl.textContent = `失败：${(res && res.error) || "未知错误"}`;
      toast(`ASR 测试失败：${(res && res.error) || "未知错误"}`, 5200);
    }
  } catch (err) {
    stateEl.textContent = `失败：${(err && err.message) || err}`;
    toast(`ASR 测试出错：${(err && err.message) || err}`, 4200);
  } finally {
    btn.disabled = false;
  }
}

async function saveSettings() {
  const asrEndpoint = $("fAsrEndpoint").value.trim();
  if (asrEndpoint && !/^https?:\/\//i.test(asrEndpoint)) {
    toast("ASR 接口地址要以 http:// 或 https:// 开头", 3600);
    return;
  }
  const patch = {
    provider: $("fProvider").value,
    endpoint: $("fEndpoint").value.trim(),
    apiKey: $("fApiKey").value,
    model: $("fModel").value.trim(),
    visionModel: $("fVisionModel").value.trim(),
    asrEndpoint,
    asrApiKey: $("fAsrApiKey").value,
    asrModel: $("fAsrModel").value.trim() || "whisper-1",
    asrLanguage: $("fAsrLanguage").value.trim(),
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
  $("btnMic").title =
    state.mode === "listen"
      ? "听题：点一下开始听系统声音，再点一下停止"
      : "语音提问：点一下开始录音，再点一下停止并转文字";

  bindEvents();
  fillSettingsForm();
  autoGrow();

  state.info = await window.api.info();
  renderStealth(state.info.stealth);
  $("input").focus();
}

boot();

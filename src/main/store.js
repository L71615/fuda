"use strict";
/**
 * store.js — 全部状态都放在应用目录内（不走 AppData，便于整个文件夹拷走即用）。
 *   <app>/.user-data/settings.json   设置
 *   <app>/.user-data/records.jsonl   本地会话记录（一行一条）
 */

const fs = require("node:fs");
const path = require("node:path");

const APP_DIR = path.resolve(__dirname, "..", "..");
// 打包成 exe 后 __dirname 在 asar 里是只读的，主进程会把 FUDA_DATA_DIR
// 指到 exe 同级的 .user-data，保持"整个文件夹拷走即用"的便携特性。
const DATA_DIR = process.env.FUDA_DATA_DIR || path.join(APP_DIR, ".user-data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const RECORDS_FILE = path.join(DATA_DIR, "records.jsonl");

// 常用 AI 服务商预设：设置面板里选一下就把地址和模型填好，不用记 URL。
// 全部是 OpenAI 兼容接口（/chat/completions），所以换服务商只是换个地址和 key。
const PROVIDERS = {
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    visionModel: "gpt-4o-mini",
    hint: "需要 sk- 开头的 key",
  },
  deepseek: {
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    visionModel: "",
    hint: "国内直连，价格低；不支持图片",
  },
  moonshot: {
    label: "月之暗面 Kimi",
    endpoint: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    visionModel: "moonshot-v1-8k-vision-preview",
    hint: "国内可直连",
  },
  siliconflow: {
    label: "硅基流动 SiliconFlow",
    endpoint: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-72B-Instruct",
    visionModel: "Qwen/Qwen2-VL-72B-Instruct",
    hint: "有免费额度，模型名带斜杠",
  },
  ollama: {
    label: "本机 Ollama",
    endpoint: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
    visionModel: "qwen2.5vl:7b",
    hint: "完全离线，key 留空",
  },
  custom: {
    label: "自定义 / 中转",
    endpoint: "",
    model: "",
    visionModel: "",
    hint: "任何 OpenAI 兼容地址，例如公司的中转网关",
  },
};

const DEFAULT_SETTINGS = {
  provider: "openai",
  endpoint: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  visionModel: "", // 留空则沿用 model
  // 听题：默认沿用上面的 endpoint / apiKey；也可以单独指向本地 whisper 服务
  asrEndpoint: "",
  asrApiKey: "",
  asrModel: "whisper-1",
  asrLanguage: "zh",
  answerCard: true,
  temperature: 0.3,
  maxTokens: 1500,
  timeoutMs: 120000,
  systemPrompt:
    "你是面试者的实时辅助。用户会把面试官的问题（文字或截图）发给你。要求：\n" +
    "1. 先给一句可直接说出口的答案，不超过 3 句；\n" +
    "2. 再用 3-5 个要点补充，方便面试者展开；\n" +
    "3. 技术问题要给出可运行的代码或确切结论，不要含糊；\n" +
    "4. 不要复述问题，不要客套话，直接给答案。",
  mode: "answer",
  // 启动时先开工作台（配置页），而不是直接弹悬浮窗
  startInWorkspace: true,
  stealth: { contentProtection: true, displayAffinity: true, hideFromTaskbar: true },
  window: { opacity: 0.96, width: 640, height: 480, x: null, y: null, mouseThrough: false },
  hotkeys: {
    toggle: "Control+E",
    // 不用裸 Ctrl+R：globalShortcut 是系统级的，会抢掉浏览器/编辑器的刷新与重做
    reset: "Control+Shift+R",
    capture: "Control+D",
    // 救场：答不上来时的"承认 + 迁移 + 求教"话术
    rescue: "Control+Alt+S",
    mouseThrough: "Control+Shift+X",
    moveUp: "Control+Shift+Up",
    moveDown: "Control+Shift+Down",
    moveLeft: "Control+Shift+Left",
    moveRight: "Control+Shift+Right",
    zoomIn: "Control+Shift+=",
    zoomOut: "Control+Shift+-",
    opacityUp: "Control+Shift+]",
    opacityDown: "Control+Shift+[",
    quit: "Control+Alt+Q",
  },
};

function deepMerge(base, patch) {
  if (Array.isArray(base)) return Array.isArray(patch) ? patch : base;
  if (base && typeof base === "object" && patch && typeof patch === "object") {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalize(settings) {
  const s = deepMerge(DEFAULT_SETTINGS, settings || {});
  s.temperature = Math.min(2, Math.max(0, Number(s.temperature) || 0));
  s.maxTokens = Math.min(8000, Math.max(64, Number(s.maxTokens) || 1500));
  s.timeoutMs = Math.min(600000, Math.max(3000, Number(s.timeoutMs) || 120000));
  s.window.opacity = Math.min(1, Math.max(0.15, Number(s.window.opacity) || 0.96));
  s.startInWorkspace = s.startInWorkspace !== false;
  // 要点卡：一句话结论 + 折叠细节 + 预测追问（默认开）
  s.answerCard = s.answerCard !== false;
  // 老配置里没有 provider 字段：按 endpoint 反推，界面上就不会显示错的预设
  if (!s.provider || !PROVIDERS[s.provider]) {
    const matched = Object.entries(PROVIDERS).find(([, p]) => p.endpoint && p.endpoint === s.endpoint);
    s.provider = matched ? matched[0] : "custom";
  }
  return s;
}

function loadSettings() {
  try {
    ensureDir();
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8").replace(/^\uFEFF/, "");
    return normalize(JSON.parse(raw));
  } catch {
    return normalize({});
  }
}

function saveSettings(patch) {
  ensureDir();
  const next = normalize(deepMerge(loadSettings(), patch || {}));
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, SETTINGS_FILE);
  return next;
}

function addRecord(record) {
  ensureDir();
  const line = JSON.stringify({ ...record, at: new Date().toISOString() });
  fs.appendFileSync(RECORDS_FILE, `${line}\n`, "utf8");
  return true;
}

function listRecords(limit = 100) {
  try {
    const raw = fs.readFileSync(RECORDS_FILE, "utf8").replace(/^\uFEFF/, "");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-limit);
    const out = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out.reverse();
  } catch {
    return [];
  }
}

function clearRecords() {
  try {
    fs.rmSync(RECORDS_FILE, { force: true });
  } catch {}
  return true;
}

function recordsPath() {
  return RECORDS_FILE;
}

module.exports = {
  APP_DIR,
  DATA_DIR,
  PROVIDERS,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  addRecord,
  listRecords,
  clearRecords,
  recordsPath,
};

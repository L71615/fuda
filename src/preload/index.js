"use strict";
/**
 * preload — 渲染层唯一的能力边界。
 *
 * 两条约束：
 *   - 不把任何凭据交给渲染层（渲染层只负责界面）
 *   - 事件订阅走白名单，渲染层拿不到任意 channel
 */

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const EVENT_WHITELIST = new Set([
  "chat:delta",
  "chat:done",
  "chat:error",
  "stealth:status",
  "ui:action",
  "ui:notice",
  "ui:error",
  "ui:mouse-through",
  "env:hotkeys",
  "setup:maximized",
]);

function subscribe(channel, handler) {
  if (!EVENT_WHITELIST.has(channel)) throw new Error(`channel not allowed: ${channel}`);
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  // 运行时信息
  info: () => ipcRenderer.invoke("app:info"),
  quit: () => ipcRenderer.invoke("app:quit"),
  openRecords: () => ipcRenderer.invoke("app:open-records"),

  // 设置
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (patch) => ipcRenderer.invoke("settings:save", patch),
    providers: () => ipcRenderer.invoke("settings:providers"),
  },

  // 隐身（内容保护）
  stealth: {
    status: () => ipcRenderer.invoke("stealth:status"),
    apply: (opts) => ipcRenderer.invoke("stealth:apply", opts),
    readAffinity: () => ipcRenderer.invoke("stealth:read-affinity"),
  },

  // 窗口
  window: {
    action: (payload) => ipcRenderer.invoke("window:action", payload),
    hide: () => ipcRenderer.invoke("window:action", { name: "hide" }),
    toggle: () => ipcRenderer.invoke("window:action", { name: "toggle" }),
    mouseThrough: () => ipcRenderer.invoke("window:action", { name: "mouse-through" }),
    setOpacity: (value) => ipcRenderer.invoke("window:action", { name: "opacity", value }),
    zoom: (value) => ipcRenderer.invoke("window:action", { name: "zoom", value }),
    move: (x, y) => ipcRenderer.invoke("window:action", { name: "move", x, y }),
  },

  // 截屏
  capture: () => ipcRenderer.invoke("capture:screen"),

  // 剪贴板
  clipboard: {
    read: () => ipcRenderer.invoke("clipboard:read"),
    write: (text) => ipcRenderer.invoke("clipboard:write", text),
  },

  // 本地记录
  records: {
    list: (limit) => ipcRenderer.invoke("records:list", limit),
    add: (record) => ipcRenderer.invoke("records:add", record),
    clear: () => ipcRenderer.invoke("records:clear"),
  },

  // 模型
  models: {
    list: () => ipcRenderer.invoke("models:list"),
    ping: () => ipcRenderer.invoke("llm:ping"),
  },

  // 对话
  chat: {
    start: (payload) => ipcRenderer.invoke("chat:start", payload),
    abort: (id) => ipcRenderer.invoke("chat:abort", id),
  },

  // 语音转写
  asr: {
    transcribe: (audioBytes, mime) => ipcRenderer.invoke("asr:transcribe", { audio: audioBytes, mime }),
  },

  // 工作台（简历 / 岗位 / 资料库）
  profile: {
    get: () => ipcRenderer.invoke("profile:get"),
    save: (patch) => ipcRenderer.invoke("profile:save", patch),
    import: (kind) => ipcRenderer.invoke("profile:import", { kind }),
    importPaths: (paths, kind) => ipcRenderer.invoke("profile:import-paths", { paths, kind }),
    addText: (payload) => ipcRenderer.invoke("profile:add-text", payload),
    readiness: () => ipcRenderer.invoke("profile:readiness"),
  },

  // 拖进来的文件：把 File 对象换成真实路径（PDF/DOCX 必须由主进程读）
  files: {
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file) || "";
      } catch {
        return "";
      }
    },
  },

  // 工作台窗口
  setup: {
    open: () => ipcRenderer.invoke("setup:open"),
    start: (options) => ipcRenderer.invoke("setup:start", options || {}),
    close: () => ipcRenderer.invoke("setup:close"),
    window: (action) => ipcRenderer.invoke("setup:window", { action }),
  },

  // 事件
  on: subscribe,
};

contextBridge.exposeInMainWorld("api", api);

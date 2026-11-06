"use strict";
/**
 * 浮答（fuda）— 本地版面试悬浮助手。
 *
 * 主进程负责窗口与隐身、工作台、托盘、全局热键、IPC 和启动日志。
 * 渲染层只通过 preload 暴露的白名单接口与主进程通信。
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen,
  desktopCapturer,
  clipboard,
  shell,
  session,
  Tray,
  Menu,
  nativeImage,
  dialog,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// 打包后（asar 内只读）：数据写到 exe 同级 .user-data，保持绿色便携
const IS_PACKAGED = app.isPackaged;
const BASE_DIR = IS_PACKAGED ? path.dirname(process.execPath) : path.resolve(__dirname, "..", "..");
if (IS_PACKAGED) process.env.FUDA_DATA_DIR = path.join(BASE_DIR, ".user-data");

const store = require("./store");
const stealth = require("./stealth");
const llm = require("./llm");
const icon = require("./icon");
const profileStore = require("./profile");
const extract = require("./extract");

const APP_DIR = path.resolve(__dirname, "..", "..");
const RENDERER_DIR = path.join(APP_DIR, "src", "renderer");

// ---------------------------------------------------------------------------
// 启动日志：双击没反应时，先看 .user-data\startup.log
// ---------------------------------------------------------------------------
const BOOT_LOG = path.join(BASE_DIR, ".user-data", "startup.log");
function bootLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.mkdirSync(path.dirname(BOOT_LOG), { recursive: true });
    fs.appendFileSync(BOOT_LOG, line + "\n", "utf8");
  } catch {
    /* 日志写不了也不能影响启动 */
  }
  try {
    console.log(line);
  } catch {
    /* 无控制台时忽略 */
  }
  return line;
}
bootLog(
  `main.js loaded  packaged=${IS_PACKAGED} base=${BASE_DIR} electron=${process.versions.electron} node=${process.versions.node} cwd=${process.cwd()}`
);
process.on("uncaughtException", (err) => {
  bootLog(`uncaughtException: ${(err && err.stack) || err}`);
});
process.on("unhandledRejection", (err) => {
  bootLog(`unhandledRejection: ${(err && err.stack) || err}`);
});


// ---------------------------------------------------------------------------
// 可写路径全部重定向到应用目录内（沙箱/绿色版都能跑，不碰 AppData）
// ---------------------------------------------------------------------------
function redirectPath(name, relative) {
  try {
    const target = path.join(BASE_DIR, relative);
    fs.mkdirSync(target, { recursive: true });
    app.setPath(name, target);
  } catch (err) {
    console.warn(`[fuda] setPath(${name}) failed:`, err && err.message);
  }
}
app.setName("fuda");
redirectPath("userData", ".user-data");
redirectPath("sessionData", ".user-data/chromium");
redirectPath("temp", ".tmp");
redirectPath("crashDumps", ".tmp/crash");

// 以前为了透明窗口不黑底关掉了硬件加速；但"软件合成 + 录屏保护(WDA)"这个组合在
// 部分显卡/驱动上会让窗口在屏幕上完全画不出来（进程正常、截图有内容、肉眼什么都没有）。
// 现在窗口是不透明的，不需要这个 workaround，默认保留 GPU；实在花屏再设
// FUDA_SOFTWARE=1 退回软件渲染。
if (process.env.FUDA_SOFTWARE === "1") {
  app.disableHardwareAcceleration();
}

// 调试开关：--no-stealth / FUDA_NO_STEALTH=1 → 不施加录屏保护，
// 用来确认"窗口到底有没有画出来"（隐身会让录屏/截图里看不到窗口）。
const NO_STEALTH = process.argv.includes("--no-stealth") || process.env.FUDA_NO_STEALTH === "1";

let mainWindow = null;
let setupWindow = null;
// 首启（资料没填全）时先给工作台，悬浮窗先不显示出来打扰人
let deferOverlay = false;
let tray = null;
let isQuitting = false;
let settings = store.loadSettings();
let stealthStatus = { platform: process.platform, contentProtection: false, affinity: "n/a" };
const activeStreams = new Map(); // id -> { abort }

const HOTKEY_ACTIONS = {
  toggle: () => toggleWindow(),
  reset: () => send("ui:action", { name: "reset" }),
  capture: () => send("ui:action", { name: "capture" }),
  rescue: () => {
    showWindow();
    send("ui:action", { name: "rescue" });
  },
  mouseThrough: () => setMouseThrough(!settings.window.mouseThrough),
  moveUp: () => moveBy(0, -40),
  moveDown: () => moveBy(0, 40),
  moveLeft: () => moveBy(-40, 0),
  moveRight: () => moveBy(40, 0),
  zoomIn: () => zoomBy(0.1),
  zoomOut: () => zoomBy(-0.1),
  opacityUp: () => setOpacity(settings.window.opacity + 0.06),
  opacityDown: () => setOpacity(settings.window.opacity - 0.06),
  quit: () => quit(),
};

// ---------------------------------------------------------------------------
// 桌面软件外壳：把"浏览器行为"全部关掉
//   右键菜单、刷新、开发者工具、打印、另存为、链接跳转、文件拖入导航、Ctrl+滚轮缩放
// ---------------------------------------------------------------------------
const BLOCKED_CTRL_KEYS = new Set(["r", "p", "u", "f", "g", "s", "o", "j"]);
const BLOCKED_CTRL_SHIFT_KEYS = new Set(["i", "j", "c", "r", "p"]);

function hardenWindow(win) {
  try {
    win.removeMenu();
    win.setMenuBarVisibility(false);
  } catch {}

  try {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
  } catch {}

  try {
    win.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file://")) {
        event.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url);
      }
    });
  } catch {}

  try {
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  } catch {}

  try {
    win.webContents.on("context-menu", (event) => event.preventDefault());
  } catch {}

  try {
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const ctrl = input.control || input.meta;
      const key = String(input.key || "").toLowerCase();
      const blocked =
        key === "f5" ||
        key === "f7" ||
        key === "f12" ||
        (ctrl && BLOCKED_CTRL_KEYS.has(key)) ||
        (ctrl && input.shift && BLOCKED_CTRL_SHIFT_KEYS.has(key));
      if (blocked) {
        event.preventDefault();
      }
    });
  } catch (err) {
    console.warn("[fuda] hardenWindow input hook failed:", err && err.message);
  }

  // 阻止 Ctrl+滚轮 / 双指缩放把界面放大成"网页浏览"的手感（字号请用 Ctrl+Alt+=/-）
  try {
    if (typeof win.webContents.setVisualZoomLevelLimits === "function") {
      win.webContents.setVisualZoomLevelLimits(1, 1);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// 托盘：关掉窗口不退出程序，从托盘里能随时唤回（这是"软件"该有的样子）
// ---------------------------------------------------------------------------
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.showInactive();
  stealthStatus = stealth.apply(mainWindow, settings.stealth);
  send("stealth:status", stealthStatus);
}

function createTray() {
  if (tray) return tray;
  let image;
  try {
    image = nativeImage.createFromBuffer(icon.renderIcon(32));
    if (image.isEmpty()) throw new Error("nativeImage 解析失败");
  } catch (err) {
    console.warn("[fuda] tray icon failed:", err && err.message);
    return null;
  }
  try {
    tray = new Tray(image);
  } catch (err) {
    // 没有 Explorer/任务栏的会话里 Shell_NotifyIcon 会失败；此时退回纯热键操作
    console.warn("[fuda] 无法创建托盘图标（当前会话可能没有任务栏）:", err && err.message);
    tray = null;
    return null;
  }
  tray.setToolTip("浮答 — 面试悬浮助手（隐身中）");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "工作台…", click: () => openSetup() },
      { label: "显示 / 隐藏窗口", click: () => toggleWindow() },
      { label: "截屏提问", click: () => { showWindow(); send("ui:action", { name: "capture" }); } },
      { label: "清空对话", click: () => { showWindow(); send("ui:action", { name: "reset" }); } },
      { type: "separator" },
      { label: "设置…", click: () => { showWindow(); send("ui:action", { name: "settings" }); } },
      { label: "打开记录文件", click: () => shell.openPath(store.recordsPath()) },
      { type: "separator" },
      { label: "退出浮答", click: () => quit() },
    ])
  );
  // 左键单击：显示/隐藏（和热键行为一致）；双击：强制显示
  tray.on("click", () => toggleWindow());
  tray.on("double-click", () => showWindow());
  return tray;
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
  const w = settings.window;
  const bounds = { width: w.width || 640, height: w.height || 480 };
  if (Number.isFinite(w.x) && Number.isFinite(w.y)) {
    bounds.x = w.x;
    bounds.y = w.y;
  }
  // 上次位置可能落在已拔掉的显示器/屏幕外 → 用户会觉得"打不开"。把它拉回可见区域。
  // 高 DPI（200% 缩放）下 DIP 工作区可能只有 720×450，640×480 的窗口会超出屏幕，
  // 所以这里同时做尺寸夹取 + 位置夹取。
  try {
    const displays = screen.getAllDisplays();
    const hit = displays.find((d) => {
      const a = d.workArea;
      return (
        bounds.x + bounds.width > a.x &&
        bounds.x < a.x + a.width &&
        bounds.y + bounds.height > a.y &&
        bounds.y < a.y + a.height
      );
    });
    const target = (hit || screen.getPrimaryDisplay()).workArea;
    const prev = { ...bounds };

    // 留 8% 边距，别贴着屏幕边
    bounds.width = Math.min(bounds.width, Math.max(380, Math.round(target.width * 0.92)));
    bounds.height = Math.min(bounds.height, Math.max(260, Math.round(target.height * 0.92)));
    // 保证完整落在工作区内
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    bounds.x = clamp(Number.isFinite(bounds.x) ? bounds.x : target.x, target.x, target.x + target.width - bounds.width);
    bounds.y = clamp(Number.isFinite(bounds.y) ? bounds.y : target.y, target.y, target.y + target.height - bounds.height);

    if (
      prev.x !== bounds.x ||
      prev.y !== bounds.y ||
      prev.width !== bounds.width ||
      prev.height !== bounds.height
    ) {
      bootLog(
        `窗口几何修正：${prev.width}x${prev.height}@${prev.x},${prev.y} → ${bounds.width}x${bounds.height}@${bounds.x},${bounds.y}（工作区 ${target.width}x${target.height}）`
      );
    }
  } catch (err) {
    bootLog("显示信息读取失败: " + (err && err.message));
  }

  // 透明窗口（WS_EX_LAYERED + per-pixel alpha）在关掉硬件加速的机器上可能整块画不出来：
  // 进程活着、IsWindowVisible=true、CDP 截图也有内容，但屏幕上什么都没有。
  // 所以默认开"不透明窗口 + 圆角"，只有显式 --transparent 时才用透明皮肤。
  const wantTransparent = process.argv.includes("--transparent");
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 380,
    minHeight: 260,
    frame: false,
    transparent: wantTransparent,
    backgroundColor: wantTransparent ? "#00000000" : "#12141a",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    hasShadow: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    // 必须可聚焦：用户要在输入框里打字。不出现在任务栏/Alt-Tab 由 stealth 的
    // WS_EX_TOOLWINDOW 负责，而不是靠 focusable:false（那会连键盘输入一起丢掉）。
    focusable: true,
    acceptFirstMouse: true,
    roundedCorners: true,
    title: "浮答",
    webPreferences: {
      preload: path.join(APP_DIR, "src", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });

  const overlayTop = "screen-saver";
  const overlayOpts = { visibleOnFullScreen: true };
  win.setAlwaysOnTop(true, overlayTop);
  win.setVisibleOnAllWorkspaces(true, overlayOpts);
  win.setOpacity(w.opacity || 0.96);
  if (w.mouseThrough) win.setIgnoreMouseEvents(true, { forward: true });

  hardenWindow(win);
  bootLog("loading renderer: " + path.join(RENDERER_DIR, "index.html"));
  win.loadFile(path.join(RENDERER_DIR, "index.html"));

  win.webContents.on("did-finish-load", () => bootLog("renderer did-finish-load"));
  win.webContents.on("did-fail-load", (_e, code, desc, url) =>
    bootLog(`renderer did-fail-load code=${code} desc=${desc} url=${url}`)
  );
  win.webContents.on("render-process-gone", (_e, details) =>
    bootLog(`render-process-gone reason=${details && details.reason} exitCode=${details && details.exitCode}`)
  );
  win.webContents.on("preload-error", (_e, preloadPath, err) =>
    bootLog(`preload-error ${preloadPath}: ${(err && err.stack) || err}`)
  );
  app.on("child-process-gone", (_e, details) =>
    bootLog(`child-process-gone type=${details && details.type} reason=${details && details.reason}`)
  );

  win.once("ready-to-show", () => {
    bootLog("ready-to-show");
    if (deferOverlay) {
      // 首启：先让用户在工作台填资料，悬浮窗保持隐藏，等「开始面谈」再出现
      bootLog("工作台模式：悬浮窗先不显示，等用户点「开始面谈」");
      return;
    }
    win.show();
    bootLog(
      "窗口已显示 visible=" +
        win.isVisible() +
        " bounds=" +
        JSON.stringify(win.getBounds()) +
        " opacity=" +
        win.getOpacity()
    );
    // 隐身必须在窗口真正落到屏幕上（有 HWND）之后做
    if (NO_STEALTH) {
      bootLog("--no-stealth：跳过隐身层（调试用）");
      stealthStatus = { platform: process.platform, contentProtection: false, affinity: "skipped" };
    } else {
      stealthStatus = stealth.apply(win, settings.stealth);
    }
    bootLog("[fuda] stealth: " + JSON.stringify(stealthStatus));
    send("stealth:status", stealthStatus);
  });

  const persistBounds = () => {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    settings = store.saveSettings({ window: { x: b.x, y: b.y, width: b.width, height: b.height } });
  };
  win.on("moved", persistBounds);
  win.on("resized", persistBounds);
  win.on("closed", () => {
    mainWindow = null;
  });

  // 全屏切换 / 显示器变化后重新施加保护（系统会重置 affinity）
  const reapply = () => {
    if (!win || win.isDestroyed() || NO_STEALTH) return;
    stealthStatus = stealth.apply(win, settings.stealth);
    send("stealth:status", stealthStatus);
  };
  for (const evt of ["restore", "enter-full-screen", "leave-full-screen", "focus", "blur", "show"]) {
    win.on(evt, () => setTimeout(reapply, 120));
  }
  screen.on("display-added", reapply);
  screen.on("display-removed", reapply);
  screen.on("display-metrics-changed", reapply);

  mainWindow = win;
  return win;
}

// ---------------------------------------------------------------------------
// 工作台（配置页）：普通窗口 —— 有边框、进任务栏、不隐身、不置顶。
// 理由：隐身窗口在录屏/截图里是不可见的，编辑简历时看不到自己很危险；
// 而且 640×480 的悬浮窗写不了简历。所以两个窗口分工：
//   工作台 = 编辑资料（安全、可见） 悬浮窗 = 面试时隐身待命
// ---------------------------------------------------------------------------
function createSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) return setupWindow;

  const win = new BrowserWindow({
    width: 1060,
    height: 780,
    minWidth: 880,
    minHeight: 620,
    frame: false,
    transparent: false,
    backgroundColor: "#0c0e13",
    show: false,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: false,
    title: "浮答 · 工作台",
    webPreferences: {
      preload: path.join(APP_DIR, "src", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });

  win.setMenuBarVisibility(false);
  try {
    win.webContents.setVisualZoomLevelLimits(1, 1);
  } catch {}
  win.loadFile(path.join(RENDERER_DIR, "setup.html"));

  win.webContents.on("did-finish-load", () => bootLog("工作台 did-finish-load"));
  win.webContents.on("did-fail-load", (_e, code, desc, url) =>
    bootLog(`工作台 did-fail-load code=${code} desc=${desc} url=${url}`)
  );
  win.webContents.on("preload-error", (_e, p, err) => bootLog(`工作台 preload-error ${p}: ${(err && err.stack) || err}`));

  win.once("ready-to-show", () => {
    bootLog("工作台 ready-to-show");
    win.show();
    win.focus();
  });

  const pushMaxState = () => {
    try {
      win.webContents.send("setup:maximized", { maximized: win.isMaximized() });
    } catch {}
  };
  win.on("maximize", pushMaxState);
  win.on("unmaximize", pushMaxState);
  win.on("resize", pushMaxState);

  win.on("closed", () => {
    setupWindow = null;
  });

  setupWindow = win;
  return win;
}

function openSetup() {
  bootLog("打开工作台");
  const win = createSetupWindow();
  if (!win.isVisible()) win.show();
  win.focus();
  // 工作台在编辑时，悬浮窗藏在后面，别叠在配置页上
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
  return win;
}

function closeSetup() {
  if (!setupWindow || setupWindow.isDestroyed()) return false;
  setupWindow.close();
  setupWindow = null;
  // 关掉工作台后如果还没有悬浮窗，把它唤起来（总得有个能对话的窗口）
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  return true;
}

/** 工作台点「开始面谈」：收起工作台，唤起隐身悬浮窗 */
function startInterview(options) {
  const skipReady = Boolean(options && options.skipReady);
  try {
    const profile = profileStore.load();
    const check = profileStore.readiness(profile, settings);
    if (!skipReady && check.ready && !profile.readyAt) {
      profileStore.save({ readyAt: new Date().toISOString() });
    }
  } catch (err) {
    bootLog("工作台开始面谈时记录失败: " + (err && err.message));
  }

  deferOverlay = false;
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.close();
    setupWindow = null;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return { ok: true, created: true };
  }
  mainWindow.showInactive();
  stealthStatus = stealth.apply(mainWindow, settings.stealth);
  send("stealth:status", stealthStatus);
  send("ui:notice", { text: "工作台已收起，Ctrl+E 呼出悬浮窗" });
  bootLog("进入面谈：悬浮窗已显示");
  return { ok: true };
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.showInactive();
    stealthStatus = stealth.apply(mainWindow, settings.stealth);
    send("stealth:status", stealthStatus);
  }
}

function moveBy(dx, dy) {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + dx, y + dy);
}

function zoomBy(delta) {
  if (!mainWindow) return;
  const current = mainWindow.webContents.getZoomFactor();
  const next = Math.min(2.5, Math.max(0.5, Number((current + delta).toFixed(2))));
  mainWindow.webContents.setZoomFactor(next);
  send("ui:notice", { text: `缩放 ${Math.round(next * 100)}%` });
}

function setOpacity(value) {
  if (!mainWindow) return;
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  const next = Math.min(1, Math.max(0.15, Number(n.toFixed(2))));
  mainWindow.setOpacity(next);
  settings = store.saveSettings({ window: { opacity: next } });
  send("ui:notice", { text: `不透明度 ${Math.round(next * 100)}%` });
}

function setMouseThrough(on) {
  if (!mainWindow) return;
  mainWindow.setIgnoreMouseEvents(!!on, { forward: true });
  settings = store.saveSettings({ window: { mouseThrough: !!on } });
  send("ui:mouse-through", { on: !!on });
}

function quit() {
  isQuitting = true;
  try {
    globalShortcut.unregisterAll();
  } catch {}
  try {
    if (tray) {
      tray.destroy();
      tray = null;
    }
  } catch {}
  if (mainWindow && !mainWindow.isDestroyed()) stealth.restore(mainWindow);
  app.quit();
}

// ---------------------------------------------------------------------------
// 热键
// ---------------------------------------------------------------------------
// 备用键：原键被其它程序（聊天工具、截图工具等）占用时，
// 依次尝试 Control+Alt+<key>、Control+Shift+Alt+<key>，保证功能仍然可用。
function altAccelerators(accelerator) {
  const parts = String(accelerator).split("+");
  const key = parts[parts.length - 1];
  if (parts.includes("Alt")) return [];
  return ["Control+Alt+" + key, "Control+Shift+Alt+" + key];
}

function registerHotkeys() {
  const results = [];
  for (const [action, requested] of Object.entries(settings.hotkeys || {})) {
    const handler = HOTKEY_ACTIONS[action];
    if (!handler || !requested) {
      results.push({ action, accelerator: requested, requested, ok: false, fallback: false, reason: "unbound" });
      continue;
    }
    let bound = null;
    let lastError = "";
    for (const candidate of [requested, ...altAccelerators(requested)]) {
      try {
        if (globalShortcut.register(candidate, handler)) {
          bound = candidate;
          break;
        }
        lastError = "已被其它程序占用";
      } catch (err) {
        lastError = (err && err.message) || String(err);
      }
    }
    results.push({
      action,
      accelerator: bound || requested,
      requested,
      ok: Boolean(bound),
      fallback: Boolean(bound) && bound !== requested,
      reason: bound
        ? bound === requested
          ? ""
          : requested + " 被占用，已改用 " + bound
        : lastError,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 截图
// ---------------------------------------------------------------------------
async function captureScreen(displayId) {
  const displays = screen.getAllDisplays();
  const target =
    displays.find((d) => String(d.id) === String(displayId)) ||
    screen.getPrimaryDisplay();

  const scale = target.scaleFactor || 1;
  const thumbnailSize = {
    width: Math.round(target.size.width * scale),
    height: Math.round(target.size.height * scale),
  };

  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
  if (!sources.length) throw new Error("没有可用的屏幕源（desktopCapturer 返回空）");

  // 尽量选中目标显示器对应的 source
  const match =
    sources.find((s) => String(s.display_id) === String(target.id)) ||
    sources.find((s) => String(s.id).includes(String(target.id))) ||
    sources[0];

  const image = match.thumbnail;
  const size = image.getSize();
  const dataUrl = image.toDataURL(); // PNG，data:image/png;base64,...
  return {
    dataUrl,
    width: size.width,
    height: size.height,
    displayId: target.id,
    displayName: match.name,
    sources: sources.length,
  };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  // ---------------- 工作台：简历 / 岗位 / 资料库 ----------------
  const profileState = () => {
    const profile = profileStore.load();
    return { profile, readiness: profileStore.readiness(profile, settings), settings };
  };

  ipcMain.handle("profile:get", () => profileState());

  ipcMain.handle("profile:save", (_e, patch) => {
    const profile = profileStore.save(patch || {});
    return { profile, readiness: profileStore.readiness(profile, settings), settings };
  });

  ipcMain.handle("profile:readiness", () => {
    const profile = profileStore.load();
    return profileStore.readiness(profile, settings);
  });

  // 导入：pdf / docx / txt / md 都读成纯文本再入库
  const IMPORT_FILTERS = [
    { name: "简历 / 文档", extensions: ["pdf", "docx", "txt", "md", "markdown"] },
    { name: "PDF", extensions: ["pdf"] },
    { name: "Word (.docx)", extensions: ["docx"] },
    { name: "纯文本 (.txt / .md)", extensions: ["txt", "md", "markdown"] },
    { name: "全部文件", extensions: ["*"] },
  ];

  async function importFilesToProfile(filePaths, kind) {
    const profile = profileStore.load();
    const files = [];
    for (const filePath of (filePaths || []).slice(0, 10)) {
      try {
        const { name, text } = await extract.extractText(filePath);
        const label = name.replace(/\.[^.]+$/, "");
        if (kind === "resume") {
          const resume = profileStore.newResume(label, text);
          profile.resumes = [resume, ...profile.resumes].slice(0, 10);
          profile.activeResumeId = resume.id;
        } else {
          const doc = profileStore.newDoc(label, text);
          profile.docs = [doc, ...profile.docs].slice(0, 50);
        }
        files.push({ name, chars: text.length });
        bootLog("导入：" + name + " → " + text.length + " 字");
      } catch (err) {
        files.push({ name: path.basename(filePath), error: String((err && err.message) || err) });
        bootLog("导入失败：" + path.basename(filePath) + " - " + ((err && err.message) || err));
      }
    }
    const saved = profileStore.save(profile);
    return { files, profile: saved, readiness: profileStore.readiness(saved, settings), settings };
  }

  ipcMain.handle("profile:import", async (_e, payload) => {
    const kind = (payload && payload.kind) === "resume" ? "resume" : "doc";
    const parent = setupWindow && !setupWindow.isDestroyed() ? setupWindow : mainWindow;
    const picked = await dialog.showOpenDialog(parent, {
      title: kind === "resume" ? "选择简历文件" : "选择资料文件",
      properties: ["openFile", "multiSelections"],
      filters: IMPORT_FILTERS,
    });
    if (picked.canceled || !picked.filePaths.length) {
      return { files: [], ...profileState() };
    }
    return importFilesToProfile(picked.filePaths, kind);
  });

  // 拖进来的文件：渲染层用 webUtils 拿到真实路径交过来
  ipcMain.handle("profile:import-paths", async (_e, payload) => {
    const kind = (payload && payload.kind) === "resume" ? "resume" : "doc";
    const paths = Array.isArray(payload && payload.paths) ? payload.paths.filter((p) => typeof p === "string") : [];
    if (!paths.length) return { files: [], ...profileState() };
    return importFilesToProfile(paths, kind);
  });

  ipcMain.handle("profile:add-text", (_e, payload) => {
    const kind = (payload && payload.kind) === "resume" ? "resume" : "doc";
    const name = String((payload && payload.name) || (kind === "resume" ? "我的简历" : "资料")).slice(0, 120);
    const text = String((payload && payload.text) || "");
    if (!text.trim()) return { files: [], ...profileState() };
    if (text.length > 1.5 * 1024 * 1024) {
      return { files: [{ name, error: "文件超过 1.5 MB，已跳过" }], ...profileState() };
    }
    const profile = profileStore.load();
    if (kind === "resume") {
      const resume = profileStore.newResume(name, text);
      profile.resumes = [resume, ...profile.resumes].slice(0, 10);
      profile.activeResumeId = resume.id;
    } else {
      const doc = profileStore.newDoc(name, text);
      profile.docs = [doc, ...profile.docs].slice(0, 50);
    }
    const saved = profileStore.save(profile);
    return {
      files: [{ name, chars: text.length }],
      profile: saved,
      readiness: profileStore.readiness(saved, settings),
      settings,
    };
  });

  ipcMain.handle("setup:open", () => {
    openSetup();
    return { ok: true };
  });

  ipcMain.handle("setup:close", () => ({ ok: closeSetup() }));

  // 工作台的窗口按钮（最小化 / 最大化 / 还原 / 关闭）：无边框窗口没有系统标题栏，得自己实现
  ipcMain.handle("setup:window", (_e, payload) => {
    const action = (payload && payload.action) || "";
    const win = setupWindow && !setupWindow.isDestroyed() ? setupWindow : null;
    if (!win) return { ok: false, maximized: false };
    if (action === "minimize") win.minimize();
    else if (action === "maximize") win.maximize();
    else if (action === "unmaximize") win.unmaximize();
    else if (action === "toggle-max") (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === "close") closeSetup();
    return { ok: true, maximized: win.isMaximized() };
  });

  ipcMain.handle("setup:start", (_e, options) => startInterview(options));

  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    appDir: APP_DIR,
    dataDir: store.DATA_DIR,
    recordsPath: store.recordsPath(),
    stealth: stealthStatus,
  }));

  ipcMain.handle("app:quit", () => {
    quit();
    return true;
  });
  ipcMain.handle("app:open-records", () => {
    shell.showItemInFolder(store.recordsPath());
    return true;
  });

  ipcMain.handle("settings:get", () => settings);
  ipcMain.handle("settings:providers", () => store.PROVIDERS);
  ipcMain.handle("settings:save", (_e, patch) => {
    settings = store.saveSettings(patch || {});
    return settings;
  });

  ipcMain.handle("stealth:status", () => stealthStatus);
  ipcMain.handle("stealth:apply", (_e, opts) => {
    if (opts && typeof opts === "object") {
      settings = store.saveSettings({ stealth: opts });
    }
    if (mainWindow) stealthStatus = stealth.apply(mainWindow, settings.stealth);
    return stealthStatus;
  });
  ipcMain.handle("stealth:read-affinity", () => (mainWindow ? stealth.readAffinity(mainWindow) : "failed"));

  ipcMain.handle("window:action", (_e, payload) => {
    const name = (payload && payload.name) || "";
    switch (name) {
      case "hide":
        mainWindow && mainWindow.hide();
        break;
      case "toggle":
        toggleWindow();
        break;
      case "minimize":
        mainWindow && mainWindow.minimize();
        break;
      case "mouse-through":
        setMouseThrough(!settings.window.mouseThrough);
        break;
      case "opacity":
        setOpacity(Number(payload.value));
        break;
      case "zoom":
        zoomBy(Number(payload.value) || 0);
        break;
      case "move":
        moveBy(Number(payload.x) || 0, Number(payload.y) || 0);
        break;
      default:
        break;
    }
    return { ok: true, mouseThrough: settings.window.mouseThrough };
  });

  ipcMain.handle("capture:screen", async (_e, displayId) => {
    try {
      const shot = await captureScreen(displayId);
      return { ok: true, ...shot };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle("clipboard:read", () => clipboard.readText());
  ipcMain.handle("clipboard:write", (_e, text) => {
    clipboard.writeText(String(text || ""));
    return true;
  });

  ipcMain.handle("records:list", (_e, limit) => store.listRecords(limit || 100));
  ipcMain.handle("records:add", (_e, record) => store.addRecord(record || {}));
  ipcMain.handle("records:clear", () => store.clearRecords());

  ipcMain.handle("models:list", async () => {
    const res = await llm.listModels({
      baseUrl: settings.endpoint,
      apiKey: settings.apiKey,
    });
    return res;
  });

  ipcMain.handle("llm:ping", async () => {
    try {
      const res = await llm.ping({
        baseUrl: settings.endpoint,
        apiKey: settings.apiKey,
        model: settings.model,
      });
      return { ok: res.ok, status: res.status, detail: res.detail };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle("chat:start", async (event, payload) => {
    const id = String((payload && payload.id) || Date.now());
    const messages = (payload && payload.messages) || [];
    const model =
      (payload && payload.useVision && settings.visionModel) || (payload && payload.model) || settings.model;

    // 把工作台里的简历 / 岗位 / 资料片段注入 system：回答才像“你”在说，
    // 引用到的片段回传给界面显示（refs），让用户知道这段话是从哪来的。
    let outgoing = messages;
    let refs = [];
    try {
      const profile = profileStore.load();
      const lastUser = [...messages].reverse().find((m) => m && m.role === "user");
      const query = typeof (lastUser && lastUser.content) === "string" ? lastUser.content : "";
      const ctx = profileStore.buildContext(profile, settings, query);
      refs = ctx.refs || [];
      if (ctx.system) {
        const sysIdx = messages.findIndex((m) => m && m.role === "system");
        outgoing = messages.map((m) => ({ ...m }));
        if (sysIdx >= 0) {
          outgoing[sysIdx] = {
            ...outgoing[sysIdx],
            content: String(outgoing[sysIdx].content || "") + "\n\n" + ctx.system,
          };
        } else {
          outgoing.unshift({ role: "system", content: ctx.system });
        }
        bootLog(`上下文注入：refs=${refs.length} system=${ctx.system.length}字`);
      }
    } catch (err) {
      bootLog("上下文注入失败: " + (err && err.message));
    }

    // 救场模式：用户答不上来，要的不是标准答案，而是一段能顺着说下去的话
    const chatMode = String((payload && payload.mode) || "answer");
    if (chatMode === "rescue") {
      const rescueSys = [
        "【救场模式】用户现在被面试官问住了、答不上来，需要一段可以立刻说出口的救场话术。",
        "输出要求：",
        "1. 一句话= 后面直接写这段 40–80 字的口语话术，用户看一眼就能照着说。",
        "2. 展开部分给 2 个备选：A 更保守（承认没做过、讲方法论迁移）、B 更主动（把话题拉到自己做过的强项），并各注一句适用场景。",
        "3. 追问= 后面给 2 个把话题引回用户强项的反问句，让面试官顺着你说的方向接着问。",
        "4. 严禁编造用户没做过的项目或数据；基调是『没直接做过，但同类问题我是这样解的』。",
      ].join("\n");
      outgoing = outgoing.map((m) => ({ ...m }));
      const sysAt = outgoing.findIndex((m) => m && m.role === "system");
      if (sysAt >= 0) {
        outgoing[sysAt] = {
          ...outgoing[sysAt],
          content: String(outgoing[sysAt].content || "") + "\n\n" + rescueSys,
        };
      } else {
        outgoing.unshift({ role: "system", content: rescueSys });
      }
      bootLog("救场模式：已注入救场指令");
    }

    const controller = llm.streamChat({
      baseUrl: settings.endpoint,
      apiKey: settings.apiKey,
      model,
      messages: outgoing,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      timeoutMs: settings.timeoutMs,
      onDelta: (text) => send("chat:delta", { id, text }),
      onDone: (info) => {
        activeStreams.delete(id);
        send("chat:done", { id, ...info });
      },
      onError: (err) => {
        activeStreams.delete(id);
        send("chat:error", { id, message: String((err && err.message) || err) });
      },
    });

    activeStreams.set(id, controller);
    return { ok: true, id, model, refs };
  });

  ipcMain.handle("chat:abort", (_e, id) => {
    const controller = activeStreams.get(String(id));
    if (controller) {
      controller.abort();
      activeStreams.delete(String(id));
      return true;
    }
    return false;
  });

  // 语音转写：渲染层把系统声音切成 5 秒 WAV 片段，这里转发给 /audio/transcriptions。
  // ASR 可以单独配 endpoint / key（本地 whisper、专用转写服务），留空才沿用聊天配置。
  ipcMain.handle("asr:transcribe", async (_e, payload) => {
    try {
      const audio = new Uint8Array(payload.audio || []);
      if (!audio.length) return { ok: false, error: "没有音频数据" };
      if (audio.length > 25 * 1024 * 1024) return { ok: false, error: "音频片段过大" };
      const baseUrl = String(settings.asrEndpoint || "").trim() || settings.endpoint;
      const apiKey = String(settings.asrApiKey || "").trim() || settings.apiKey;
      const text = await llm.transcribe({
        baseUrl,
        apiKey,
        model: settings.asrModel || "whisper-1",
        language: settings.asrLanguage || "",
        audio,
        mime: payload.mime || "audio/wav",
      });
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  bootLog("另一个 fuda 已在运行（单实例锁），本次启动直接退出，窗口会回到已有实例");
  app.quit();
} else {
  app.on("second-instance", () => {
    bootLog("second-instance：唤回已有窗口");
    if (setupWindow && !setupWindow.isDestroyed()) {
      setupWindow.show();
      setupWindow.focus();
      return;
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.showInactive();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    bootLog("app ready");
    Menu.setApplicationMenu(null);

    // 听题要抓系统声音：Electron 在 Windows 上用 loopback 把扬声器输出作为音频轨道。
    // 视频轨道只是 getDisplayMedia 的载体，渲染层不渲染但必须保留：停掉后 loopback 音频会断。
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        if (process.platform !== "win32") {
          callback({});
          return;
        }
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
        const primaryId = String(screen.getPrimaryDisplay().id);
        const source = sources.find((s) => String(s.display_id) === primaryId) || sources[0];
        if (!source) {
          callback({});
          return;
        }
        callback({ video: source, audio: "loopback" });
      } catch (err) {
        bootLog("系统声音回环失败: " + ((err && err.message) || err));
        try {
          callback({});
        } catch {}
      }
    });

    // 只放行「麦克风录音 + 屏幕音频 + 剪贴板」这几类权限，其余一律拒绝（渲染层不联网，也不需要别的）
    const ALLOWED_PERMISSIONS = new Set([
      "media",
      "audioCapture",
      "display-capture",
      "clipboard-read",
      "clipboard-sanitized-write",
    ]);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

    registerIpc();

    // 启动流程：默认总是先显示工作台（配置页），悬浮窗建好但在后台待命，
    // 点「开始面谈 / 进入对话」才把它唤到前台。设置里可以关掉这个行为。
    deferOverlay = settings.startInWorkspace !== false;
    try {
      const profile = profileStore.load();
      const check = profileStore.readiness(profile, settings);
      const missing = check.items.filter((i) => !i.ok && !i.optional).map((i) => i.label).join("、");
      bootLog(
        "启动：" +
          (deferOverlay
            ? "先显示工作台" + (check.ready ? "（资料已就绪）" : "（仍缺 " + missing + "）")
            : "设置里关掉了「启动先开工作台」，直接进悬浮窗")
      );
    } catch (err) {
      bootLog("启动判定失败: " + (err && err.message));
    }

    createWindow();
    createTray();
    if (deferOverlay) openSetup();
    // 兜底：renderer 加载失败时 ready-to-show 永远不触发，用户会看到"双击没反应"
    setTimeout(() => {
      if (deferOverlay) {
        bootLog("工作台模式：跳过悬浮窗强制显示");
        return;
      }
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        bootLog("4s 内未收到 ready-to-show，强制显示窗口");
        mainWindow.showInactive();
      }
    }, 4000);
    const hotkeys = registerHotkeys();
    bootLog("[fuda] hotkeys: " + JSON.stringify(hotkeys));
    send("env:hotkeys", hotkeys);
    // 让渲染层拿到环境信息
    setTimeout(() => send("env:hotkeys", hotkeys), 1500);

    if (process.argv.includes("--self-test")) {
      runSelfTest().catch((err) => {
        console.error("[self-test] failed:", err);
        app.exit(1);
      });
    }
  });

// ---------------------------------------------------------------------------
// 自检：把窗口摆在固定位置，报告隐身真实状态、截屏可用性，并在退出前把自身渲染结果落盘
// ---------------------------------------------------------------------------
async function runSelfTest() {
  const win = mainWindow;
  const holdMs = Number((process.argv.find((a) => a.startsWith("--hold=")) || "").split("=")[1] || 9000);
  win.setBounds({ x: 120, y: 120, width: 560, height: 420 });
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const affinity = stealth.readAffinity(win);
  const status = stealthStatus;
  let capture = { ok: false };
  try {
    capture = { ok: true, ...(await captureScreen()) };
  } catch (err) {
    capture = { ok: false, error: String((err && err.message) || err) };
  }

  const report = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    bounds: win.getBounds(),
    visible: win.isVisible(),
    opacity: win.getOpacity(),
    alwaysOnTop: win.isAlwaysOnTop(),
    stealthStatus: status,
    affinityReadBack: affinity,
    screenCapture: capture.ok
      ? { width: capture.width, height: capture.height, display: capture.displayName, bytes: capture.dataUrl.length }
      : { error: capture.error },
    settingsEndpoint: settings.endpoint,
    settingsModel: settings.model,
  };

  const outDir = path.join(APP_DIR, "out");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "self-test.json"), JSON.stringify(report, null, 2), "utf8");
  if (capture.ok) {
    fs.writeFileSync(path.join(outDir, "self-test-screen.png"), Buffer.from(capture.dataUrl.split(",")[1], "base64"));
  }
  try {
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, "self-test-window.png"), shot.toPNG());
  } catch (err) {
    console.warn("[self-test] capturePage failed:", err && err.message);
  }

  console.log("[self-test] " + JSON.stringify(report));
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  app.exit(0);
}

  app.on("window-all-closed", () => {
    quit();
  });

  app.on("will-quit", () => {
    try {
      globalShortcut.unregisterAll();
    } catch {}
    if (mainWindow) stealth.restore(mainWindow);
  });
}

process.on("uncaughtException", (err) => {
  console.error("[fuda] uncaught:", err);
  send("ui:error", { message: String((err && err.message) || err) });
});

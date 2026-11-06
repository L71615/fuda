"use strict";
/**
 * stealth.js — 让窗口在截屏/录屏/桌面包共享里"消失"。
 *
 * 四层：
 *   1. Electron 层   win.setContentProtection(true)
 *   2. Win32 层      SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE=17)，失败退 WDA_MONITOR=1
 *   3. 扩展样式层    WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE —— 不出现在任务栏 / Alt-Tab
 *   4. 窗口层级层    由 index.js 负责（alwaysOnTop 'screen-saver' + 全工作区可见 + 不获焦）
 *
 * 关键点：每次设置后都用 GetWindowDisplayAffinity 读回真实值，
 * "调用成功" ≠ "保护生效"，所以对外只汇报读回值 none / monitor / exclude / failed。
 */

let koffi = null;
let user32 = null;

const WDA_NONE = 0;
const WDA_MONITOR = 1;
const WDA_EXCLUDEFROMCAPTURE = 17;

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;

const DEBUG = !!process.env.FUDA_DEBUG;

function log(...args) {
  if (!DEBUG) return;
  console.error("[fuda:stealth]", ...args);
}

function loadUser32() {
  if (user32) return user32;
  if (process.platform !== "win32") {
    return null;
  }
  try {
    // koffi 是 N-API 原生模块，Electron 各版本 ABI 通用
    koffi = koffi || require("koffi");
    const lib = koffi.load("user32.dll");
    user32 = {
      getDisplayAffinity: lib.func(
        "bool __stdcall GetWindowDisplayAffinity(uintptr_t hwnd, _Out_ uint32_t *affinity)"
      ),
      setDisplayAffinity: lib.func(
        "bool __stdcall SetWindowDisplayAffinity(uintptr_t hwnd, uint32_t affinity)"
      ),
      getWindowLongPtr: lib.func("int64_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)"),
      setWindowLongPtr: lib.func(
        "int64_t __stdcall SetWindowLongPtrW(uintptr_t hwnd, int index, int64_t value)"
      ),
    };
    log("user32 loaded");
    return user32;
  } catch (err) {
    console.warn("[fuda:stealth] koffi/user32 unavailable:", err && err.message);
    user32 = null;
    return null;
  }
}

/** win.getNativeWindowHandle() 在 x64 上是 8 字节 Buffer（HWND 值本身很小，Number 安全）。 */
function hwndOf(win) {
  if (!win || win.isDestroyed()) return null;
  try {
    const buf = win.getNativeWindowHandle();
    if (buf.length === 8) return Number(buf.readBigUInt64LE(0));
    if (buf.length === 4) return buf.readUInt32LE(0);
    return null;
  } catch {
    return null;
  }
}

function readAffinity(win) {
  const api = loadUser32();
  const hwnd = hwndOf(win);
  if (!api || hwnd === null) return "failed";
  try {
    const out = [0];
    if (!api.getDisplayAffinity(hwnd, out)) return "failed";
    if (out[0] === WDA_NONE) return "none";
    if (out[0] === WDA_MONITOR) return "monitor";
    if (out[0] === WDA_EXCLUDEFROMCAPTURE) return "exclude";
    return "failed";
  } catch (err) {
    log("GetWindowDisplayAffinity failed:", err && err.message);
    return "failed";
  }
}

/**
 * 应用/取消内容保护。返回读回后的真实状态。
 * allowMonitorFallback=true 时，17 失败会退到 1（画面变黑，仍不可读）。
 */
function applyDisplayAffinity(win, enabled, { allowMonitorFallback = true } = {}) {
  const api = loadUser32();
  const hwnd = hwndOf(win);
  if (!api || hwnd === null) return "failed";
  try {
    if (!enabled) {
      api.setDisplayAffinity(hwnd, WDA_NONE);
      return readAffinity(win);
    }
    if (api.setDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)) return readAffinity(win);
    const current = readAffinity(win);
    if (current === "exclude" || !allowMonitorFallback) return current;
    if (api.setDisplayAffinity(hwnd, WDA_MONITOR)) return readAffinity(win);
    return "failed";
  } catch (err) {
    log("SetWindowDisplayAffinity failed:", err && err.message);
    return "failed";
  }
}

/** 把窗口从任务栏 / Alt-Tab 里摘掉（WS_EX_TOOLWINDOW）并禁止激活（WS_EX_NOACTIVATE）。 */
function applyExStyles(win, { noActivate = false } = {}) {
  const api = loadUser32();
  const hwnd = hwndOf(win);
  if (!api || hwnd === null) return null;
  try {
    const current = api.getWindowLongPtr(hwnd, GWL_EXSTYLE);
    if (current === null || current === undefined) return null;
    let next = BigInt(current) | BigInt(WS_EX_TOOLWINDOW);
    if (noActivate) next |= BigInt(WS_EX_NOACTIVATE);
    api.setWindowLongPtr(hwnd, GWL_EXSTYLE, next);
    const applied = api.getWindowLongPtr(hwnd, GWL_EXSTYLE);
    return Number(applied);
  } catch (err) {
    log("ex-style failed:", err && err.message);
    return null;
  }
}

/**
 * 完整应用一次隐身。返回可展示给 UI 的状态。
 */
function apply(win, { contentProtection = true, displayAffinity = true, hideFromTaskbar = true }) {
  const status = { platform: process.platform, contentProtection: false, affinity: "n/a", exStyle: null };

  if (!win || win.isDestroyed()) return status;

  if (contentProtection) {
    try {
      win.setContentProtection(true);
      status.contentProtection = true;
    } catch (err) {
      log("setContentProtection failed:", err && err.message);
    }
  }

  if (displayAffinity) {
    if (process.platform === "win32") {
      status.affinity = applyDisplayAffinity(win, true);
    } else if (process.platform === "darwin") {
      // macOS 只有 Electron 的尽力而为保护，ScreenCaptureKit 仍可能抓到
      status.affinity = status.contentProtection ? "best-effort" : "failed";
    } else {
      status.affinity = "unsupported";
    }
  } else {
    status.affinity = "disabled";
  }

  if (hideFromTaskbar && process.platform === "win32") {
    status.exStyle = applyExStyles(win, { noActivate: false });
  }

  return status;
}

function restore(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(false);
  } catch {}
  if (process.platform === "win32") applyDisplayAffinity(win, false);
}

module.exports = { apply, restore, readAffinity, applyDisplayAffinity, applyExStyles, hwndOf };

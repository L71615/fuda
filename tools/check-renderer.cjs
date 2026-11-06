"use strict";
/**
 * check-renderer.cjs — 静态检查渲染层：页面里用到的 DOM id / api 方法是否真实存在。
 * 渲染层要跑在 Chromium 里才验证得了，但这类"拼错 id → 启动即崩"的问题可以静态查出来。
 *
 *   node tools/check-renderer.cjs
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const RENDERER = path.join(ROOT, "src", "renderer");
const preload = fs.readFileSync(path.join(ROOT, "src", "preload", "index.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main", "index.js"), "utf8");

// 一个页面 = 一份 html + 对应脚本
const PAGES = [
  { name: "悬浮窗", html: "index.html", js: "app.js" },
  { name: "工作台", html: "setup.html", js: "setup.js" },
];

const problems = [];

// preload 白名单只解析一次
const whitelistBlock = /EVENT_WHITELIST = new Set\(\[([\s\S]*?)\]\)/.exec(preload)[1];
const whitelisted = new Set([...whitelistBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
const subscribed = new Set();

for (const page of PAGES) {
  const htmlPath = path.join(RENDERER, page.html);
  const jsPath = path.join(RENDERER, page.js);
  if (!fs.existsSync(htmlPath)) {
    problems.push(`${page.name}: 缺少 ${page.html}`);
    continue;
  }
  if (!fs.existsSync(jsPath)) {
    problems.push(`${page.name}: 缺少 ${page.js}`);
    continue;
  }
  const html = fs.readFileSync(htmlPath, "utf8");
  const js = fs.readFileSync(jsPath, "utf8");

  // 1. HTML 里定义的 id
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  // 2. 脚本里引用的 id（getElementById / $() / doc.getElementById）
  const usedIds = new Set(
    [...js.matchAll(/getElementById\("([^"]+)"\)|\$\("([^"]+)"\)/g)].map((m) => m[1] || m[2])
  );
  const missingIds = [...usedIds].filter((id) => !htmlIds.has(id));
  if (missingIds.length) problems.push(`${page.name}: ${page.html} 缺少这些 id: ${missingIds.join(", ")}`);

  // 3. HTML 里引用的脚本/样式必须存在，且不能引用外网资源（离线要求）
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^https?:/.test(ref) || ref.startsWith("data:")) {
      problems.push(`${page.name}: 渲染层不应引用外部资源（离线要求）: ${ref}`);
      continue;
    }
    if (!fs.existsSync(path.join(RENDERER, ref))) problems.push(`${page.name}: 引用的文件不存在: src/renderer/${ref}`);
  }

  // 4. window.api.* 必须在 preload 里暴露
  const apiCalls = new Set();
  for (const m of js.matchAll(/window\.api\.([a-zA-Z]+)\.([a-zA-Z]+)/g)) apiCalls.add(`${m[1]}.${m[2]}`);
  for (const m of js.matchAll(/window\.api\.([a-zA-Z]+)\(/g)) apiCalls.add(m[1]);
  for (const call of apiCalls) {
    const [a, b] = call.split(".");
    if (!preload.includes(`${a}:`)) problems.push(`${page.name}: preload 未暴露分组 ${a}`);
    else if (b && !preload.includes(`${b}:`)) problems.push(`${page.name}: preload 未暴露方法 ${a}.${b}`);
  }

  // 5. 订阅的事件必须在白名单里
  for (const m of js.matchAll(/window\.api\.on\("([^"]+)"/g)) subscribed.add(m[1]);

  console.log(`${page.name}（${page.html}）: ${htmlIds.size} 个 id，脚本引用 ${usedIds.size} 个，api 调用 ${apiCalls.size} 个`);
}

const notAllowed = [...subscribed].filter((c) => !whitelisted.has(c));
if (notAllowed.length) problems.push(`订阅了不在白名单的事件: ${notAllowed.join(", ")}`);

// 6. 主进程发出的 IPC 通道，preload 里应有对应的 handler（ipcMain.handle）
const handlers = new Set([...mainSrc.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((m) => m[1]));
const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => m[1]));
const missingHandlers = [...invoked].filter((c) => !handlers.has(c));
if (missingHandlers.length) problems.push(`preload 调用但主进程没有 handler: ${missingHandlers.join(", ")}`);

const emitted = new Set([...mainSrc.matchAll(/send\("([^"]+)"/g)].map((m) => m[1]));
const unhandled = [...emitted].filter((c) => !subscribed.has(c));

console.log(`api 通道: preload invoke ${invoked.size} 个，主进程 handle ${handlers.size} 个`);
console.log(`订阅事件: ${[...subscribed].join(", ")}`);
console.log(`主进程发出: ${[...emitted].join(", ")}`);
if (unhandled.length) console.log(`（提示）主进程发出但渲染层未订阅: ${unhandled.join(", ")}`);

if (problems.length) {
  console.error("\n发现 %d 个问题:", problems.length);
  for (const p of problems) console.error(" - " + p);
  process.exit(1);
}
console.log("\n渲染层静态检查通过");

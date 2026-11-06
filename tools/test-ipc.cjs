"use strict";
/**
 * test-ipc.cjs — 用「假的 electron」把主进程完整加载起来，逐个跑 IPC 通道。
 *
 * 为什么需要它：本仓库所在的这台机器上，agent 会话禁止创建子进程，所以 Electron/Chromium
 * 起不来（见 README「已知限制」）。但主进程的逻辑本身是纯 JS，只要把 electron 模块换成
 * 内存里的假实现，就能验证：模块能否加载、IPC 通道是否齐全、设置/记录/截屏/剪贴板/流式对话
 * 是否端到端跑通。
 *
 *   node tools/test-ipc.cjs
 */

const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

// 测试数据放在 .tmp/test-data，别污染用户真实的 .user-data（工作台资料也在里面）
const TEST_DATA = path.join(path.resolve(__dirname, ".."), ".tmp", "test-data");
process.env.FUDA_DATA_DIR = TEST_DATA;
fs.rmSync(TEST_DATA, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA, { recursive: true });

// ---------------------------------------------------------------- 假 electron
const handlers = new Map(); // channel -> fn
const sentEvents = []; // { channel, payload }
const registeredHotkeys = [];
let browserWindowOptions = null; // 第一个窗口 = 悬浮窗
const allWindowOptions = [];
const chatBodies = []; // 每次 /v1/chat/completions 的请求体，用来验证上下文注入

function makeFakeWebContents() {
  let zoom = 1;
  const listeners = new Map();
  return {
    id: 1,
    listeners,
    send(channel, payload) {
      sentEvents.push({ channel, payload });
    },
    getZoomFactor: () => zoom,
    setZoomFactor: (v) => {
      zoom = v;
    },
    capturePage: async () => ({
      toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    }),
    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler;
    },
    setVisualZoomLevelLimits(min, max) {
      this.visualZoom = [min, max];
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
  };
}

class FakeBrowserWindow {
  constructor(options) {
    if (!browserWindowOptions) browserWindowOptions = options;
    allWindowOptions.push(options);
    this._options = options;
    this._destroyed = false;
    this._visible = false;
    this._opacity = 1;
    this._bounds = { x: options.x || 100, y: options.y || 100, width: options.width, height: options.height };
    this._alwaysOnTop = !!options.alwaysOnTop;
    this._mouseThrough = false;
    this._contentProtection = false;
    this._listeners = new Map();
    this.webContents = makeFakeWebContents();
  }
  _emit(name) {
    for (const fn of this._listeners.get(name) || []) fn();
  }
  on(name, fn) {
    if (!this._listeners.has(name)) this._listeners.set(name, []);
    this._listeners.get(name).push(fn);
  }
  once(name, fn) {
    this.on(name, fn);
  }
  isDestroyed() {
    return this._destroyed;
  }
  getBounds() {
    return { ...this._bounds };
  }
  setBounds(b) {
    this._bounds = { ...this._bounds, ...b };
  }
  getPosition() {
    return [this._bounds.x, this._bounds.y];
  }
  setPosition(x, y) {
    this._bounds.x = x;
    this._bounds.y = y;
    this._emit("moved");
  }
  setAlwaysOnTop(v) {
    this._alwaysOnTop = v;
  }
  isAlwaysOnTop() {
    return this._alwaysOnTop;
  }
  setVisibleOnAllWorkspaces() {}
  setOpacity(v) {
    this._opacity = v;
  }
  getOpacity() {
    return this._opacity;
  }
  setIgnoreMouseEvents(v) {
    this._mouseThrough = !!v;
  }
  setContentProtection(v) {
    this._contentProtection = !!v;
  }
  loadFile(file) {
    this._loadedFile = file;
  }
  setMenuBarVisibility() {}
  removeMenu() {}
  setTitle(t) {
    this._title = t;
  }
  getTitle() {
    return this._title || this._options.title || "";
  }
  close() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._visible = false;
    this._emit("closed");
  }
  show() {
    this._visible = true;
    this._emit("show");
  }
  showInactive() {
    this._visible = true;
    this._emit("show");
  }
  hide() {
    this._visible = false;
  }
  focus() {}
  minimize() {}
  isVisible() {
    return this._visible;
  }
  getNativeWindowHandle() {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(0x1234n, 0);
    return buf;
  }
}

const fakeApp = {
  _quit: false,
  setName() {},
  setPath() {},
  disableHardwareAcceleration() {},
  commandLine: { appendSwitch() {} },
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  on() {},
  quit() {
    this._quit = true;
  },
  exit() {},
  getVersion: () => "0.1.0",
  getPath: () => process.cwd(),
  isPackaged: false,
};

const fakeTrays = [];
class FakeTray {
  constructor(image) {
    this.image = image;
    this.tooltip = "";
    this.menu = null;
    this.destroyed = false;
    this.events = new Map();
    fakeTrays.push(this);
  }
  setToolTip(t) {
    this.tooltip = t;
  }
  setContextMenu(menu) {
    this.menu = menu;
  }
  on(event, fn) {
    this.events.set(event, fn);
  }
  destroy() {
    this.destroyed = true;
  }
}

const fakeNativeImage = {
  createFromBuffer(buf) {
    return { __fromBuffer: true, size: buf.length, isEmpty: () => false };
  },
  createEmpty() {
    return { isEmpty: () => true };
  },
};

const fakeElectron = {
  app: fakeApp,
  BrowserWindow: FakeBrowserWindow,
  Tray: FakeTray,
  Menu: {
    setApplicationMenu() {},
    buildFromTemplate(template) {
      return { __template: template, items: template };
    },
  },
  nativeImage: fakeNativeImage,
  dialog: {
    lastOptions: null,
    async showOpenDialog(_parent, options) {
      this.lastOptions = options;
      return { canceled: true, filePaths: [] };
    },
  },
  ipcMain: {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
  },
  globalShortcut: {
    register(accelerator) {
      registeredHotkeys.push(accelerator);
      return true;
    },
    unregisterAll() {},
  },
  screen: {
    getAllDisplays: () => [
      { id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    ],
    getPrimaryDisplay: () => ({
      id: 1,
      size: { width: 1920, height: 1080 },
      scaleFactor: 1,
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    }),
    on() {},
  },
  desktopCapturer: {
    getSources: async () => [
      {
        id: "screen:1:0",
        name: "Screen 1",
        display_id: "1",
        thumbnail: {
          getSize: () => ({ width: 1920, height: 1080 }),
          toDataURL: () => "data:image/png;base64,iVBORw0KGgo=",
        },
      },
    ],
  },
  clipboard: {
    _text: "",
    readText() {
      return this._text;
    },
    writeText(t) {
      this._text = t;
    },
  },
  shell: { showItemInFolder() {} },
  session: {
    defaultSession: {
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      setDisplayMediaRequestHandler() {},
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------- 假模型端点
function startMockModelServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake-local-model" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body);
          chatBodies.push(parsed);
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunks = ["面试官", "问：", "会什么？"];
          let i = 0;
          const timer = setInterval(() => {
            if (i < chunks.length) {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`);
              i += 1;
              return;
            }
            clearInterval(timer);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 7 } })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          }, 5);
        });
        return;
      }
      if (req.url === "/v1/audio/transcriptions") {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: "听写结果" }));
        });
        return;
      }
      res.writeHead(404);
      res.end("nope");
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`  FAIL ${name}: ${err && err.message}`);
  }
}

const invoke = (channel, payload) => {
  const fn = handlers.get(channel);
  assert.ok(fn, `通道未注册: ${channel}`);
  return fn({ sender: { id: 1 } }, payload);
};

(async () => {
  console.log("fuda ipc tests (fake electron)");
  const { server, base } = await startMockModelServer();

  // 加载主进程
  require("../src/main/index.js");
  await new Promise((r) => setTimeout(r, 100));

  await test("主进程加载后注册了全部 IPC 通道", () => {
    const expected = [
      "app:info", "app:quit", "app:open-records", "settings:get", "settings:save",
      "settings:providers",
      "profile:get", "profile:save", "profile:import", "profile:import-paths", "profile:readiness", "profile:add-text",
      "setup:open", "setup:start", "setup:close", "setup:window",
      "stealth:status", "stealth:apply", "stealth:read-affinity", "window:action",
      "capture:screen", "clipboard:read", "clipboard:write", "records:list",
      "records:add", "records:clear", "models:list", "llm:ping", "chat:start",
      "chat:abort", "asr:transcribe",
    ];
    const missing = expected.filter((c) => !handlers.has(c));
    assert.deepEqual(missing, [], `缺少通道: ${missing.join(", ")}`);
    assert.equal(handlers.size, expected.length);
  });

  await test("窗口按设计参数创建（无边框/不透明/置顶/跳过任务栏/可聚焦）", () => {
    assert.ok(browserWindowOptions, "BrowserWindow 未被创建");
    assert.equal(browserWindowOptions.frame, false);
    assert.equal(browserWindowOptions.transparent, false, "默认必须不透明：透明窗口 + 软件渲染在部分机器上整块画不出来");
    assert.equal(browserWindowOptions.backgroundColor, "#12141a");
    assert.equal(browserWindowOptions.alwaysOnTop, true);
    assert.equal(browserWindowOptions.skipTaskbar, true);
    assert.equal(browserWindowOptions.focusable, true, "要能打字，窗口必须可聚焦");
    assert.equal(browserWindowOptions.webPreferences.contextIsolation, true);
    assert.equal(browserWindowOptions.webPreferences.nodeIntegration, false);
    assert.ok(browserWindowOptions.webPreferences.preload.endsWith(path.join("src", "preload", "index.js")));
  });

  await test("热键全部注册成功（含救场 Ctrl+Alt+S）", () => {
    assert.ok(registeredHotkeys.length >= 13, `只注册了 ${registeredHotkeys.length} 个热键`);
    assert.ok(registeredHotkeys.includes("Control+E"));
    assert.ok(registeredHotkeys.includes("Control+Alt+S"), "救场热键没注册上");
  });

  await test("托盘存在，菜单里能唤回窗口 / 打开设置 / 退出", () => {
    assert.equal(fakeTrays.length, 1, "应该只创建一个托盘");
    const tray = fakeTrays[0];
    assert.ok(tray.tooltip.includes("浮答"));
    const labels = tray.menu.items.map((item) => item.label).filter(Boolean);
    assert.ok(labels.includes("显示 / 隐藏窗口"), `菜单项: ${labels.join(" | ")}`);
    assert.ok(labels.includes("设置…"));
    assert.ok(labels.includes("退出浮答"));
  });

  await test("settings:providers 返回服务商预设", async () => {
    const providers = await invoke("settings:providers");
    const keys = Object.keys(providers);
    for (const expected of ["openai", "deepseek", "moonshot", "siliconflow", "ollama", "custom"]) {
      assert.ok(keys.includes(expected), `缺少预设: ${expected}`);
    }
    assert.ok(providers.openai.endpoint.startsWith("https://api.openai.com"));
    assert.ok(providers.ollama.endpoint.includes("127.0.0.1:11434"));
  });

  await test("app:info 返回运行时信息且数据目录在应用目录内", async () => {
    const info = await invoke("app:info");
    assert.equal(info.version, "0.1.0");
    assert.match(info.recordsPath, /records\.jsonl$/);
    assert.ok(info.appDir.startsWith(path.resolve(__dirname, "..")), "appDir 不在应用目录内");
  });

  await test("settings: 读默认值 → 保存 → 再读", async () => {
    const before = await invoke("settings:get");
    assert.ok(before.hotkeys.toggle);
    const saved = await invoke("settings:save", { model: "fake-local-model", endpoint: base });
    assert.equal(saved.model, "fake-local-model");
    assert.equal(saved.endpoint, base);
    const again = await invoke("settings:get");
    assert.equal(again.model, "fake-local-model");
  });

  await test("stealth: 状态与读回值可用（假窗口上应返回字符串）", async () => {
    const status = await invoke("stealth:status");
    assert.equal(status.platform, process.platform);
    const affinity = await invoke("stealth:read-affinity");
    assert.equal(typeof affinity, "string");
    assert.ok(["none", "monitor", "exclude", "failed"].includes(affinity), `异常读回值: ${affinity}`);
  });

  await test("clipboard: 写入后能读回", async () => {
    await invoke("clipboard:write", "hello-fuda");
    assert.equal(await invoke("clipboard:read"), "hello-fuda");
  });

  await test("records: 追加 / 列出 / 清空", async () => {
    await invoke("records:clear");
    await invoke("records:add", { mode: "answer", question: "Q", answer: "A" });
    const list = await invoke("records:list", 10);
    assert.equal(list.length, 1);
    assert.equal(list[0].answer, "A");
    await invoke("records:clear");
    assert.equal((await invoke("records:list", 10)).length, 0);
  });

  await test("window:action 支持 opacity / mouse-through / zoom / move", async () => {
    const r1 = await invoke("window:action", { name: "opacity", value: 0.5 });
    assert.equal(r1.ok, true);
    const before = (await invoke("settings:get")).window.mouseThrough;
    const r2 = await invoke("window:action", { name: "mouse-through" });
    assert.equal(r2.mouseThrough, !before, "mouse-through 应当是取反，而不是固定值");
    await invoke("window:action", { name: "mouse-through" }); // 复原，保证重复跑结果一致
    await invoke("window:action", { name: "zoom", value: 0.1 });
    await invoke("window:action", { name: "move", x: 40, y: 40 });
    await invoke("window:action", { name: "toggle" });
  });

  await test("capture:screen 返回 PNG dataURL", async () => {
    const shot = await invoke("capture:screen");
    assert.equal(shot.ok, true, shot.error);
    assert.ok(shot.dataUrl.startsWith("data:image/png;base64,"));
    assert.equal(shot.width, 1920);
  });

  await test("models:list 走本地假端点", async () => {
    const res = await invoke("models:list");
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.models, ["fake-local-model"]);
  });

  await test("llm:ping 走本地假端点", async () => {
    const res = await invoke("llm:ping");
    assert.equal(res.ok, true, JSON.stringify(res));
  });

  await test("chat:start → 收到 chat:delta…chat:done 完整事件流", async () => {
    sentEvents.length = 0;
    const started = await invoke("chat:start", {
      id: "t1",
      messages: [{ role: "user", content: "你好" }],
    });
    assert.equal(started.ok, true);
    const deadline = Date.now() + 6000;
    const done = () => sentEvents.some((e) => e.channel === "chat:done");
    while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(done(), "没有收到 chat:done");
    const deltas = sentEvents.filter((e) => e.channel === "chat:delta").map((e) => e.payload.text);
    assert.equal(deltas.join(""), "面试官问：会什么？");
    const doneEvent = sentEvents.find((e) => e.channel === "chat:done");
    assert.equal(doneEvent.payload.id, "t1");
    assert.equal(doneEvent.payload.usage.total_tokens, 7);
  });

  await test("chat:abort 对不存在的流返回 false，对存在的流能中断", async () => {
    assert.equal(await invoke("chat:abort", "nope"), false);
    await invoke("chat:start", { id: "t2", messages: [{ role: "user", content: "hi" }] });
    assert.equal(await invoke("chat:abort", "t2"), true);
    await new Promise((r) => setTimeout(r, 200));
  });

  await test("asr:transcribe 返回识别文本", async () => {
    const res = await invoke("asr:transcribe", { audio: [1, 2, 3], mime: "audio/webm" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.text, "听写结果");
  });

  await test("设置写坏了的 endpoint 时错误只回给渲染层，不抛到主进程", async () => {
    await invoke("settings:save", { endpoint: "http://127.0.0.1:9/v1" });
    const res = await invoke("models:list");
    assert.equal(res.ok, false);
    assert.ok(res.error || res.detail, "应带上错误信息");
    await invoke("settings:save", { endpoint: base });
  });

  await test("工作台：全新环境里就绪检查指出缺哪些项", async () => {
    const data = await invoke("profile:get");
    assert.equal(data.readiness.ready, false, "空资料库不应该是就绪状态");
    const keys = data.readiness.items.map((i) => i.key);
    assert.deepEqual(keys, ["resume", "job", "docs", "model"]);
    // 简历 / 岗位 / 资料 都还没填（模型接口在前面用例里已经配好了）
    const missing = data.readiness.items.filter((i) => !i.ok).map((i) => i.key);
    assert.deepEqual(missing, ["resume", "job", "docs"]);
  });

  await test("工作台：填完简历 / 岗位 / 资料后变为就绪", async () => {
    const resume = {
      id: "res_1",
      name: "我的简历",
      text: "张三，后端开发，三年 Node.js 与 Go 经验，做过订单系统和限流网关，QPS 2 万。".padEnd(120, "。"),
      chars: 120,
    };
    const job = { id: "job_1", title: "后端开发实习生", company: "字节跳动", jd: "熟悉 Node.js / Go，负责高并发服务" };
    const doc = { id: "doc_1", name: "项目笔记", chunks: [{ text: "限流网关用令牌桶实现，Redis 存计数，支持 5000 QPS。" }] };
    const res = await invoke("profile:save", {
      resumes: [resume],
      activeResumeId: "res_1",
      jobs: [job],
      activeJobId: "job_1",
      docs: [doc],
    });
    assert.equal(res.readiness.ready, true, JSON.stringify(res.readiness.items));
    const again = await invoke("profile:readiness");
    assert.equal(again.ready, true);
  });

  await test("工作台：对话时把岗位 / 简历 / 资料片段注入 system，并回传 refs", async () => {
    chatBodies.length = 0;
    const started = await invoke("chat:start", {
      id: "t3",
      messages: [{ role: "user", content: "你的限流网关怎么做的？" }],
    });
    assert.equal(started.ok, true);
    assert.ok(Array.isArray(started.refs), "应回传 refs");
    assert.equal(started.refs.length, 1, "资料里有一段谈限流，应该被检索到");
    assert.equal(started.refs[0].name, "项目笔记");
    const deadline = Date.now() + 6000;
    while (!chatBodies.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const body = chatBodies[0];
    const system = body.messages.find((m) => m.role === "system");
    assert.ok(system, "应注入 system 上下文");
    assert.ok(system.content.includes("目标岗位"), "system 应包含目标岗位");
    assert.ok(system.content.includes("字节跳动"), "system 应包含公司");
    assert.ok(system.content.includes("令牌桶"), "system 应包含检索到的资料片段");
    const last = body.messages[body.messages.length - 1];
    assert.equal(last.role, "user");
  });

  await test("chat:start mode=rescue 注入救场指令，且不污染普通问答", async () => {
    chatBodies.length = 0;
    const started = await invoke("chat:start", {
      id: "t4",
      mode: "rescue",
      messages: [{ role: "user", content: "那你们的分库分表是怎么做的？" }],
    });
    assert.equal(started.ok, true);
    const deadline = Date.now() + 6000;
    while (!chatBodies.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const system = chatBodies[0].messages.find((m) => m.role === "system");
    assert.ok(system.content.includes("救场模式"), "system 应包含救场指令");
    assert.ok(system.content.includes("严禁编造"), "救场指令应禁止编造经历");

    chatBodies.length = 0;
    await invoke("chat:start", { id: "t5", messages: [{ role: "user", content: "你好" }] });
    const d2 = Date.now() + 6000;
    while (!chatBodies.length && Date.now() < d2) await new Promise((r) => setTimeout(r, 20));
    const sys2 = chatBodies[0].messages.find((m) => m.role === "system");
    assert.ok(!String(sys2.content).includes("救场模式"), "普通问答不应带救场指令");
    await new Promise((r) => setTimeout(r, 300));
  });

  await test("工作台：profile:add-text 把拖进来的文件切片入库", async () => {
    const text = "面经：三面被问到 outbox 模式，我讲了订单状态先落库再补偿投递，面试官追问了消息重复消费怎么幂等。";
    const res = await invoke("profile:add-text", { kind: "doc", name: "三面面经", text });
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].name, "三面面经");
    const docs = res.profile.docs || [];
    assert.equal(docs[0].name, "三面面经", "新资料应排在最前");
    assert.ok(docs[0].chunks.length >= 1, "应切成至少一段");
    const empty = await invoke("profile:add-text", { kind: "doc", name: "空", text: "   " });
    assert.deepEqual(empty.files, [], "空文本不应写入");
  });

  await test("工作台：profile:import 取消选择时不改动资料", async () => {
    const before = await invoke("profile:readiness");
    const res = await invoke("profile:import", { kind: "doc" });
    assert.deepEqual(res.files, []);
    assert.equal(res.readiness.ready, before.ready);
  });

  await test("工作台：profile:import-paths 读 md 入库，拒老版 .doc", async () => {
    const tmp = path.join(process.env.FUDA_DATA_DIR, "..", "import-fixtures");
    fs.mkdirSync(tmp, { recursive: true });
    const md = path.join(tmp, "面经.md");
    fs.writeFileSync(md, "# 一面\n\n问了 Redis 令牌桶和 outbox。", "utf8");
    const legacy = path.join(tmp, "老简历.doc");
    fs.writeFileSync(legacy, "not a real doc", "utf8");

    const res = await invoke("profile:import-paths", { kind: "doc", paths: [md, legacy] });
    const okFile = res.files.find((f) => f.name === "面经.md");
    assert.ok(okFile && okFile.chars > 0, "md 应该成功入库");
    const badFile = res.files.find((f) => f.name === "老简历.doc");
    assert.ok(badFile && /doc/.test(badFile.error), ".doc 应给出可读的错误");
    assert.ok((res.profile.docs || []).some((d) => d.name === "面经"), "新资料应出现在资料库里");
  });

  await test("工作台：setup:start 收起工作台并唤起悬浮窗", async () => {
    await invoke("setup:open");
    assert.equal(allWindowOptions.length, 2, "应该创建了工作台窗口");
    const setupOptions = allWindowOptions[1];
    assert.equal(setupOptions.alwaysOnTop, false, "工作台不该置顶");
    assert.equal(setupOptions.skipTaskbar, false, "工作台要进任务栏");
    assert.equal(setupOptions.backgroundColor, "#0c0e13");
    const res = await invoke("setup:start", {});
    assert.equal(res.ok, true);
    assert.equal((await invoke("settings:get")).window.opacity >= 0.15, true);
  });

  await test("启动流程：默认「先开工作台」开关是开的，且能改", async () => {
    assert.equal((await invoke("settings:get")).startInWorkspace, true, "默认应该先开工作台");
    const off = await invoke("settings:save", { startInWorkspace: false });
    assert.equal(off.startInWorkspace, false, "关掉后要能存下来");
    const on = await invoke("settings:save", { startInWorkspace: true });
    assert.equal(on.startInWorkspace, true, "恢复默认");
  });

  server.close();

  // 测试会改写真实设置文件（.user-data/settings.json），跑完删掉，保证下次启动是默认配置
  const store = require("../src/main/store");
  for (const f of ["settings.json", "records.jsonl"]) {
    try {
      fs.rmSync(path.join(store.DATA_DIR, f), { force: true });
    } catch {}
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();

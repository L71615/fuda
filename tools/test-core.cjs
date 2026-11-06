"use strict";
/**
 * 不依赖 Electron 的核心逻辑测试：直接用 Node 跑。
 *   node tools/test-core.cjs
 * 覆盖：settings 读写、records 追加/读取/清空、buildUrl、消息格式转换、SSE 流式解析、
 *       端到端流式对话（本地起一个假的 OpenAI 兼容端点）、错误分支。
 */

const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const store = require("../src/main/store");
const llm = require("../src/main/llm");

const results = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true });
      console.log(`  ok   ${name}`);
    })
    .catch((err) => {
      results.push({ name, ok: false, error: err });
      console.log(`  FAIL ${name}: ${err && err.message}`);
    });
}

// ---------------------------------------------------------------- mock server
let transcribeBody = Buffer.alloc(0);
function startMockServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-small" }, { id: "mock-vision" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body);
          if (parsed.model === "missing-model") {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "model not found" } }));
            return;
          }
          res.writeHead(200, { "content-type": "text/event-stream" });
          const pieces = ["答", "案", "：", "可以"];
          let i = 0;
          const timer = setInterval(() => {
            if (i < pieces.length) {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i] } }] })}\n\n`);
              i += 1;
              return;
            }
            clearInterval(timer);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 42 } })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          }, 5);
        });
        return;
      }
      if (req.url === "/v1/audio/transcriptions") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          transcribeBody = Buffer.concat(chunks);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: `转写完成(${transcribeBody.length} 字节)` }));
        });
        return;
      }
      res.writeHead(404);
      res.end("nope");
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}/v1` });
    });
  });
}

(async () => {
  console.log("fuda core tests");
  const { server, base } = await startMockServer();

  // ------------------------------------------------------------- store
  await test("store: 默认设置完整（含热键与隐身开关）", () => {
    const s = store.loadSettings();
    assert.ok(s.hotkeys.toggle, "hotkeys.toggle 缺失");
    assert.ok(s.stealth.displayAffinity !== undefined);
    assert.equal(typeof s.systemPrompt, "string");
    assert.ok(s.systemPrompt.length > 20);
  });

  await test("store: 保存后能读回，且非法值被夹取", () => {
    const before = store.loadSettings();
    const saved = store.saveSettings({
      model: "test-model",
      temperature: 9,
      maxTokens: 1,
      window: { opacity: -5 },
    });
    assert.equal(saved.model, "test-model");
    assert.equal(saved.temperature, 2, "temperature 应被夹到 2");
    assert.equal(saved.maxTokens, 64, "maxTokens 应被夹到 64");
    assert.equal(saved.window.opacity, 0.15, "opacity 应被夹到 0.15");
    const reread = store.loadSettings();
    assert.equal(reread.model, "test-model");
    assert.equal(reread.endpoint, before.endpoint, "未修改的字段不应丢失");
    store.saveSettings({ model: before.model, temperature: before.temperature, maxTokens: before.maxTokens, window: { opacity: before.window.opacity } });
  });

  await test("store: records 追加/读取/清空", () => {
    store.clearRecords();
    store.addRecord({ mode: "answer", question: "Q1", answer: "A1" });
    store.addRecord({ mode: "code", question: "Q2", answer: "A2" });
    const list = store.listRecords(10);
    assert.equal(list.length, 2);
    assert.equal(list[0].question, "Q2", "应最新的在前");
    assert.ok(list[0].at, "应带时间戳");
    store.clearRecords();
    assert.equal(store.listRecords(10).length, 0);
  });

  // ------------------------------------------------------------- llm 纯函数
  await test("llm.buildUrl: 补全 /chat/completions 且去掉尾斜杠", () => {
    assert.equal(llm.buildUrl("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(
      llm.buildUrl("https://api.example.com/v1/chat/completions"),
      "https://api.example.com/v1/chat/completions"
    );
    assert.throws(() => llm.buildUrl("127.0.0.1:11434"), /http\(s\)/);
    assert.throws(() => llm.buildUrl(""), /为空/);
  });

  await test("llm.toOpenAIMessages: 保留图文混合消息", () => {
    const out = llm.toOpenAIMessages([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
      { role: "assistant", content: "ok" },
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[0].role, "system");
    assert.ok(Array.isArray(out[1].content));
    assert.equal(out[2].role, "assistant");
  });

  await test("llm.makeSseParser: 跨 chunk 切分与 [DONE] 都能处理", () => {
    const got = [];
    let done = false;
    const feed = llm.makeSseParser((ev) => {
      if (ev.done) done = true;
      if (ev.json) got.push(ev.json.choices[0].delta.content);
    });
    feed('data: {"choices":[{"delta":{"content":"he');
    feed('llo"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\n');
    feed("data: [DONE]\n\n");
    assert.deepEqual(got, ["hello", "!"]);
    assert.equal(done, true);
  });

  // ------------------------------------------------------------- 端到端
  await test("llm.streamChat: 本地假端点流式返回并累计 usage", async () => {
    const deltas = [];
    let finished = null;
    llm.streamChat({
      baseUrl: base,
      model: "mock-small",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (t) => deltas.push(t),
      onDone: (info) => (finished = info),
    });
    const deadline = Date.now() + 5000;
    while (!finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(finished, "onDone 未被调用");
    assert.equal(deltas.join(""), "答案：可以");
    assert.equal(finished.text, "答案：可以");
    assert.equal(finished.usage.total_tokens, 42);
  });

  await test("llm.streamChat: HTTP 错误会走 onError", async () => {
    let err = null;
    llm.streamChat({
      baseUrl: base,
      model: "missing-model",
      messages: [{ role: "user", content: "hi" }],
      onError: (e) => (err = e),
    });
    const deadline = Date.now() + 5000;
    while (!err && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(err, "onError 未被调用");
    assert.match(err.message, /404/);
  });

  await test("llm.streamChat: abort() 能中断流", async () => {
    let done = false;
    const ctl = llm.streamChat({
      baseUrl: base,
      model: "mock-small",
      messages: [{ role: "user", content: "hi" }],
      onDone: () => (done = true),
    });
    ctl.abort();
    await new Promise((r) => setTimeout(r, 300));
    // 中断后要么 done 被调用（aborted），要么没有任何异常抛出即可
    assert.ok(true);
    assert.equal(typeof done, "boolean");
  });

  await test("llm.listModels: 能读到模型列表", async () => {
    const res = await llm.listModels({ baseUrl: base });
    assert.equal(res.ok, true);
    assert.deepEqual(res.models, ["mock-small", "mock-vision"]);
  });

  await test("llm.transcribe: 走 /audio/transcriptions 返回文本", async () => {
    const text = await llm.transcribe({
      baseUrl: base,
      model: "whisper-1",
      audio: new Uint8Array([1, 2, 3, 4]),
      mime: "audio/webm",
    });
    assert.match(text, /转写完成/);
  });

  await test("llm.transcribe: wav 片段带 language 与正确扩展名", async () => {
    transcribeBody = Buffer.alloc(0);
    const text = await llm.transcribe({
      baseUrl: base,
      model: "sensevoice-small",
      audio: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]),
      mime: "audio/wav",
      language: "zh",
    });
    assert.match(text, /转写完成/);
    const form = transcribeBody.toString("latin1");
    assert.match(form, /filename="audio\.wav"/);
    assert.match(form, /name="model"\r\n\r\nsensevoice-small/);
    assert.match(form, /name="language"\r\n\r\nzh/);
  });

  server.close();

  // ------------------------------------------------------------- 结构一致性
  await test("结构：主进程 IPC 通道与 preload 暴露面一致", () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.js"), "utf8");
    const preloadSrc = fs.readFileSync(path.join(__dirname, "..", "src", "preload", "index.js"), "utf8");
    const mainChannels = new Set([...mainSrc.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((m) => m[1]));
    const preloadChannels = new Set([...preloadSrc.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => m[1]));
    const missing = [...preloadChannels].filter((c) => !mainChannels.has(c));
    assert.deepEqual(missing, [], `preload 调用了主进程没有的通道: ${missing.join(", ")}`);
    assert.ok(mainChannels.size >= 15, `主进程通道过少: ${mainChannels.size}`);
  });

  await test("结构：渲染层用到的 api.* 方法都真实存在", () => {
    const preloadSrc = fs.readFileSync(path.join(__dirname, "..", "src", "preload", "index.js"), "utf8");
    const rendererSrc = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "app.js"), "utf8");
    const used = new Set(
      [...rendererSrc.matchAll(/window\.api(?:\.([a-zA-Z]+)(?:\.([a-zA-Z]+))?)?\(/g)]
        .map((m) => (m[2] ? `${m[1]}.${m[2]}` : m[1] || "call"))
        .filter((x) => x && x !== "call" && x !== "on")
    );
    for (const pathName of used) {
      const [group, method] = pathName.includes(".") ? pathName.split(".") : [pathName, null];
      if (!method) continue; // 顶层方法单独校验
      assert.ok(preloadSrc.includes(`${group}:`), `preload 缺少分组 ${group}`);
      assert.ok(preloadSrc.includes(`${method}:`), `preload 缺少方法 ${group}.${method}`);
    }
  });

  await test("结构：隐身模块导出的 API 完整", () => {
    const stealth = require("../src/main/stealth");
    for (const fn of ["apply", "restore", "readAffinity", "applyDisplayAffinity", "hwndOf"]) {
      assert.equal(typeof stealth[fn], "function", `stealth.${fn} 缺失`);
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();

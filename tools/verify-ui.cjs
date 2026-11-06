// 通过 CDP 验证渲染层真的渲染出来了（窗口是截图隐身的，没法靠截图看）。
// 用法: node tools\verify-ui.cjs [port]
const port = Number(process.argv[2] || 9333);

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

function call(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout: " + method)), 8000);
    const onMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(method + ": " + JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

(async () => {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === "page");
  if (!page) {
    console.log("NO_PAGE_TARGET: " + JSON.stringify(targets.map((t) => t.type)));
    process.exit(1);
  }
  console.log("target      = " + page.title + "  " + page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  await call(ws, 1, "Runtime.enable", {});

  const probe = await call(ws, 2, "Runtime.evaluate", {
    expression: `JSON.stringify({
      title: document.title,
      readyState: document.readyState,
      bodyText: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 220),
      nodes: document.querySelectorAll("*").length,
      hasApi: typeof window.api === "object",
      apiKeys: window.api ? Object.keys(window.api) : [],
      cssLoaded: [...document.styleSheets].length,
      viewport: innerWidth + "x" + innerHeight
    })`,
    returnByValue: true,
  });

  const info = JSON.parse(probe.result.value);
  console.log("viewport    = " + info.viewport);
  console.log("styleSheets = " + info.cssLoaded);
  console.log("domNodes    = " + info.nodes);
  console.log("window.api  = " + info.hasApi + "  groups: " + (info.apiKeys || []).join(","));
  console.log("text        = " + info.bodyText);

  // 抓渲染层已抛出的异常
  const errors = await call(ws, 3, "Runtime.evaluate", {
    expression: "window.__fudaErrors ? JSON.stringify(window.__fudaErrors) : '[]'",
    returnByValue: true,
  });
  console.log("errors      = " + errors.result.value);
  ws.close();
})().catch((err) => {
  console.log("FAILED: " + (err && err.message));
  process.exit(1);
});

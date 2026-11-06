// 端到端验证「配置 AI 接口」：把设置改成指向本地假 OpenAI 兼容端点，真的发一条消息，
// 看流式回复是否渲染到界面。用法: node tools\e2e-api.cjs [port] [endpoint]
const port = Number(process.argv[2] || 9333);
const endpoint = process.argv[3] || "http://127.0.0.1:8799/v1";

function call(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout: " + method)), 15000);
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

let idSeq = 1;
async function evaluate(ws, expression) {
  const res = await call(ws, idSeq++, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails.exception));
  return res.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("没有 page target: " + JSON.stringify(targets.map((t) => t.type)));

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  // 走真实 UI：打开设置 → 选「自定义」→ 填地址/Key/模型 → 保存
  await evaluate(ws, 'document.getElementById("btnSettings").click()');
  await sleep(300);
  const saved = await evaluate(
    ws,
    `(async () => {
      const sel = document.getElementById("fProvider");
      sel.value = "custom";
      sel.dispatchEvent(new Event("change"));
      document.getElementById("fEndpoint").value = ${JSON.stringify(endpoint)};
      document.getElementById("fApiKey").value = "sk-e2e-test";
      document.getElementById("fModel").value = "mock-echo";
      document.getElementById("fVisionModel").value = "";
      document.getElementById("btnSaveSettings").click();
      await new Promise(r => setTimeout(r, 600));
      const s = await window.api.settings.get();
      return { provider: s.provider, endpoint: s.endpoint, model: s.model, keySet: !!s.apiKey,
               emptySub: (document.getElementById("emptySub") || {}).textContent,
               panelHidden: document.getElementById("settings").hidden };
    })()`
  );
  console.log("settings after save = " + JSON.stringify(saved));

  const ping = await evaluate(ws, "window.api.models.ping()");
  console.log("llm:ping = " + JSON.stringify(ping));

  await evaluate(
    ws,
    `(async () => {
      const input = document.getElementById("input");
      input.value = "请用一句话自我介绍";
      input.dispatchEvent(new Event("input"));
      document.getElementById("btnSend").click();
      await new Promise(r => setTimeout(r, 10));
    })()`
  );

  const deadline = Date.now() + 20000;
  let bubbles = null;
  while (Date.now() < deadline) {
    bubbles = await evaluate(
      ws,
      `Array.from(document.querySelectorAll(".msg")).map(m => ({
        role: m.classList.contains("user") ? "user" : "assistant",
        text: (m.querySelector(".msg-body") || {}).textContent || ""
      }))`
    );
    if (bubbles.some((b) => b.role === "assistant" && b.text.trim().length > 0)) break;
    await sleep(300);
  }
  console.log("bubbles = " + JSON.stringify(bubbles, null, 2));
  ws.close();
})().catch((err) => {
  console.error("FAILED: " + (err && err.message));
  process.exit(1);
});

"use strict";

const $ = (id) => document.getElementById(id);

const TABS = ["resume", "job", "docs", "model"];
const TAB_LABEL = { resume: "简历", job: "目标岗位", docs: "资料库", model: "AI 接口" };

const state = {
  profile: null,
  settings: null,
  providers: {},
  readiness: { items: [], ready: false },
  tab: "resume",
  previewDocId: "",
  saveTimer: 0,
  dirty: false,
};

const PROVIDER_LABEL = {
  openai: "OpenAI",
  deepseek: "DeepSeek",
  moonshot: "Kimi / Moonshot",
  siliconflow: "硅基流动",
  ollama: "本机 Ollama",
  custom: "自定义 / 中转",
};

function toast(text, isError) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast" + (isError ? " err" : "");
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.hidden = true;
  }, 2400);
}

/* ---------------- 页签 ---------------- */

function setTab(name) {
  if (!TABS.includes(name)) return;
  state.tab = name;
  for (const key of TABS) {
    $("pane" + key[0].toUpperCase() + key.slice(1)).hidden = key !== name;
  }
  for (const item of document.querySelectorAll(".nav-item")) {
    item.classList.toggle("is-active", item.dataset.tab === name);
  }
  renderPane(name);
  renderPreview();
  // 页签刚显示时布局还没稳定，下一帧再量一次高度
  requestAnimationFrame(growAll);
}

/** 切到某个页签时按最新数据重画一次，避免"外部改了资料、列表还是旧的" */
function renderPane(name) {
  if (name === "resume") renderResume();
  else if (name === "job") renderJob();
  else if (name === "docs") renderDocs();
  else if (name === "model") renderModel();
}

/* ---------------- 右侧侧栏：文件全貌 ---------------- */

function activeResume() {
  const list = (state.profile && state.profile.resumes) || [];
  return list.find((r) => r.id === state.profile.activeResumeId) || list[0] || null;
}

function activeJob() {
  const list = (state.profile && state.profile.jobs) || [];
  return list.find((j) => j.id === state.profile.activeJobId) || list[0] || { company: "", title: "", jd: "" };
}

function activeDoc() {
  const docs = (state.profile && state.profile.docs) || [];
  return docs.find((d) => d.id === state.previewDocId) || docs[0] || null;
}

const countLines = (text) => (text ? text.split("\n").length : 0);

/** 把纯文本画成"带行号的文件视图"（追加，不清空；行号每个片段从 1 开始） */
function paintText(container, text) {
  const lines = String(text || "").split("\n");
  const frag = document.createDocumentFragment();
  lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "line" + (line.trim() ? "" : " ln-blank");
    const num = document.createElement("i");
    num.textContent = String(i + 1);
    const body = document.createElement("span");
    body.textContent = line || " ";
    row.append(num, body);
    frag.append(row);
  });
  container.append(frag);
}

function paintPlaceholder(container, html) {
  const box = document.createElement("div");
  box.className = "ph";
  box.innerHTML = html;
  container.append(box);
}

function renderPreview() {
  const nameEl = $("previewName");
  const metaEl = $("previewMeta");
  const body = $("previewBody");
  body.textContent = "";

  if (state.tab === "resume") {
    const resume = activeResume();
    const text = resume ? resume.text : "";
    nameEl.textContent = resume ? resume.name : "简历";
    metaEl.textContent = text ? `${text.length} 字 · ${countLines(text)} 行` : "未上传";
    if (!text.trim()) {
      paintPlaceholder(body, "还没有简历。<br />左边上传 .txt / .md，或者直接粘贴全文，这里会显示完整内容。");
      return;
    }
    paintText(body, text);
    return;
  }

  if (state.tab === "job") {
    const job = activeJob();
    nameEl.textContent = job.title ? [job.company, job.title].filter(Boolean).join(" · ") : "目标岗位";
    metaEl.textContent = job.jd ? `JD ${job.jd.length} 字` : "未填 JD";
    const text = [
      "目标岗位",
      "",
      "公司：" + (job.company || "（未填）"),
      "岗位：" + (job.title || "（未填）"),
      "",
      "—— JD 原文 ——",
      "",
      job.jd || "（未填，填了回答会更贴岗位要求）",
    ].join("\n");
    paintText(body, text);
    return;
  }

  if (state.tab === "docs") {
    const doc = activeDoc();
    if (!doc) {
      nameEl.textContent = "资料库";
      metaEl.textContent = "空";
      paintPlaceholder(body, "还没有资料。<br />上传项目文档、面经或笔记，左侧点任意一篇，这里打开全文。");
      return;
    }
    nameEl.textContent = doc.name;
    const chunks = doc.chunks || [];
    metaEl.textContent = `${doc.chars || 0} 字 · ${chunks.length} 段（每段 450 字）`;
    chunks.forEach((chunk, i) => {
      const sep = document.createElement("div");
      sep.className = "chunk-sep";
      sep.textContent = `第 ${i + 1} 段`;
      body.append(sep);
      paintText(body, chunk.text || "");
    });
    return;
  }

  // model
  const s = state.settings || {};
  nameEl.textContent = "请求预览";
  metaEl.textContent = s.model || "未配置";
  const endpoint = (s.endpoint || "https://api.openai.com/v1").replace(/\/+$/, "");
  const text = [
    "# 每次提问都会这样发出去（stream=true）",
    `POST ${endpoint}/chat/completions`,
    "Authorization: Bearer " + (s.apiKey ? "sk-••••" + String(s.apiKey).slice(-4) : "（未填 API Key）"),
    "Content-Type: application/json",
    "",
    JSON.stringify(
      {
        model: s.model || "gpt-4o-mini",
        stream: true,
        temperature: typeof s.temperature === "number" ? s.temperature : 0.3,
        messages: [
          { role: "system", content: "【目标岗位 + JD + 简历摘要 + 资料 top3 会自动拼在这里】" },
          { role: "user", content: "面试官的问题…" },
        ],
      },
      null,
      2,
    ),
  ].join("\n");
  paintText(body, text);
}

/* ---------------- 就绪检查 ---------------- */

function renderReadiness() {
  const list = $("readiness");
  list.textContent = "";
  for (const item of state.readiness.items) {
    const li = document.createElement("li");
    if (item.ok) li.className = "ok";
    else if (item.optional) li.className = "opt";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.textContent = item.ok ? "✓" : item.optional ? "·" : "!";
    const body = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = item.label;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = item.hint;
    body.append(title, sub);
    li.append(dot, body);
    list.append(li);
  }
  $("btnStart").disabled = !state.readiness.ready;
  $("btnStart").textContent = state.readiness.ready ? "开始面谈" : "先补完必填项";
}

/* ---------------- 导航状态 ---------------- */

function renderNav() {
  const resume = activeResume();
  const resumeChars = resume ? (resume.text || "").length : 0;
  $("navResumeSub").textContent = resumeChars ? `${resumeChars} 字` : "未填写";
  $("navResumeDot").className = "nav-dot" + (resumeChars >= 80 ? " ok" : "");

  const job = activeJob();
  const jobOk = !!(job && (job.title || "").trim());
  $("navJobSub").textContent = jobOk ? [job.company, job.title].filter(Boolean).join(" · ") : "未填写";
  $("navJobDot").className = "nav-dot" + (jobOk ? " ok" : "");

  const docs = (state.profile && state.profile.docs) || [];
  const chunks = docs.reduce((n, d) => n + (d.chunks ? d.chunks.length : 0), 0);
  $("navDocsSub").textContent = docs.length ? `${docs.length} 篇 · ${chunks} 段` : "0 篇（可选）";
  $("navDocsDot").className = "nav-dot" + (chunks ? " ok" : " opt");

  const s = state.settings || {};
  const modelOk = !!(s.endpoint && s.model);
  $("navModelSub").textContent = modelOk ? s.model : "未配置";
  $("navModelDot").className = "nav-dot" + (modelOk ? " ok" : "");
}

/* ---------------- 各面板 ---------------- */

function renderResume() {
  const resume = activeResume();
  const text = resume ? resume.text : "";
  $("resumeText").value = text;
  $("resumeCount").textContent = text.length + " 字";
  const ok = text.trim().length >= 80;
  $("resumeState").textContent = ok ? "已就绪" : text ? "字数偏少（至少 80 字）" : "未填写";
  $("resumeState").className = "state" + (ok ? " ok" : "");
  autoGrow($("resumeText"));
}

function renderJob() {
  const job = activeJob();
  $("jobCompany").value = job.company || "";
  $("jobTitle").value = job.title || "";
  $("jobJd").value = job.jd || "";
  const ok = !!(job.title || "").trim();
  $("jobState").textContent = ok ? [job.company, job.title].filter(Boolean).join(" · ") : "未填写";
  $("jobState").className = "state" + (ok ? " ok" : "");
  autoGrow($("jobJd"));
}

function renderDocs() {
  const docs = (state.profile && state.profile.docs) || [];
  const chunks = docs.reduce((n, d) => n + (d.chunks ? d.chunks.length : 0), 0);
  $("docCount").textContent = `${docs.length} 篇 · ${chunks} 段`;
  $("docsState").textContent = chunks ? `${chunks} 段可检索` : "0 段";
  $("docsState").className = "state" + (chunks ? " ok" : "");

  const list = $("docList");
  list.textContent = "";
  if (!docs.length) {
    const empty = document.createElement("p");
    empty.className = "doc-empty";
    empty.textContent = "还没有资料。支持 PDF / Word(.docx) / txt / md，上传后自动切片。";
    list.append(empty);
    return;
  }
  for (const doc of docs) {
    const li = document.createElement("li");
    if (doc.id === state.previewDocId || (!state.previewDocId && doc === docs[0])) li.className = "active";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = doc.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${doc.chars || 0} 字 · ${(doc.chunks || []).length} 段`;
    const del = document.createElement("button");
    del.className = "del";
    del.title = "移除";
    del.textContent = "✕";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeDoc(doc.id);
    });
    li.append(name, meta, del);
    li.addEventListener("click", () => {
      state.previewDocId = doc.id;
      renderDocs();
      renderPreview();
    });
    list.append(li);
  }
}

function renderModel() {
  const s = state.settings || {};
  const sel = $("fProvider");
  if (!sel.options.length) {
    for (const [key, preset] of Object.entries(state.providers)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = PROVIDER_LABEL[key] || preset.label || key;
      sel.append(opt);
    }
  }
  sel.value = s.provider && state.providers[s.provider] ? s.provider : "custom";
  $("fEndpoint").value = s.endpoint || "";
  $("fModel").value = s.model || "";
  $("fApiKey").value = s.apiKey || "";
  const ok = !!(s.endpoint && s.model);
  $("modelState").textContent = ok ? `${s.model}` : "未配置";
  $("modelState").className = "state" + (ok ? " ok" : "");
}

function renderAll() {
  renderResume();
  renderJob();
  renderDocs();
  renderModel();
  renderNav();
  renderReadiness();
  renderPreview();
}

/* ---------------- 保存 ---------------- */

function scheduleSave(patch) {
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => persist(patch), 450);
}

async function persist(patch) {
  state.dirty = false;
  try {
    const res = await window.api.profile.save(patch);
    state.profile = res.profile;
    state.readiness = res.readiness;
    state.settings = res.settings || state.settings;
    renderNav();
    renderReadiness();
  } catch (err) {
    toast("保存失败：" + (err && err.message ? err.message : err), true);
  }
}

/** 把界面上的简历/岗位写回 profile（做最小 diff，避免覆盖别处改动） */
function currentEdits() {
  const resumeText = $("resumeText").value;
  const existing = activeResume();
  const resumes = existing
    ? (state.profile.resumes || []).map((r) =>
        r.id === existing.id ? { ...r, text: resumeText, chars: resumeText.length, updatedAt: new Date().toISOString() } : r,
      )
    : [{ id: "res_default", name: "我的简历", text: resumeText, chars: resumeText.length, updatedAt: new Date().toISOString() }];

  const jobExisting = (state.profile.jobs || []).find((j) => j.id === state.profile.activeJobId);
  const jobPatch = { title: $("jobTitle").value.trim(), company: $("jobCompany").value.trim(), jd: $("jobJd").value };
  const jobs = jobExisting
    ? state.profile.jobs.map((j) => (j.id === jobExisting.id ? { ...j, ...jobPatch, updatedAt: new Date().toISOString() } : j))
    : [{ id: "job_default", ...jobPatch, updatedAt: new Date().toISOString() }];

  return {
    resumes,
    activeResumeId: resumes.length ? resumes[0].id : "",
    jobs,
    activeJobId: jobs.length ? jobs[0].id : "",
  };
}

/* ---------------- 上传 / 导入 ---------------- */

async function addDocs() {
  try {
    const res = await window.api.profile.import({ kind: "doc" });
    const files = (res && res.files) || [];
    if (!files.length) return;
    state.profile = res.profile;
    state.readiness = res.readiness;
    state.previewDocId = ((res.profile.docs || [])[0] || {}).id || "";
    renderDocs();
    renderNav();
    renderReadiness();
    renderPreview();
    toast(`已添加 ${files.length} 篇资料`);
  } catch (err) {
    toast("添加失败：" + (err && err.message ? err.message : err), true);
  }
}

async function importResume() {
  try {
    const res = await window.api.profile.import({ kind: "resume" });
    const files = (res && res.files) || [];
    if (!files.length) return;
    state.profile = res.profile;
    state.readiness = res.readiness;
    renderResume();
    renderNav();
    renderReadiness();
    renderPreview();
    toast(`已导入 ${files[0].name}`);
  } catch (err) {
    toast("导入失败：" + (err && err.message ? err.message : err), true);
  }
}

async function removeDoc(docId) {
  const docs = state.profile.docs.filter((d) => d.id !== docId);
  try {
    const res = await window.api.profile.save({ docs });
    state.profile = res.profile;
    state.readiness = res.readiness;
    if (state.previewDocId === docId) state.previewDocId = ((res.profile.docs || [])[0] || {}).id || "";
    renderDocs();
    renderNav();
    renderReadiness();
    renderPreview();
  } catch (err) {
    toast("删除失败：" + (err && err.message ? err.message : err), true);
  }
}

/**
 * 拖进来的文件：有真实路径就交给主进程（PDF/DOCX 必须主进程解析），
 * 拿不到路径（例如从网页拖来的纯文本）才退化成读 text。
 */
async function dropFiles(fileList, kind) {
  const all = [...(fileList || [])].slice(0, 10);
  if (!all.length) return;

  const accepted = /\.(txt|md|markdown|pdf|docx)$/i;
  const usable = all.filter((f) => accepted.test(f.name) || (f.type && f.type.startsWith("text/")));
  const skipped = all.filter((f) => !usable.includes(f));

  const withPath = [];
  const plain = [];
  for (const file of usable) {
    const p = window.api.files && window.api.files.pathFor ? window.api.files.pathFor(file) : "";
    if (p) withPath.push(p);
    else plain.push(file);
  }

  let res = null;
  try {
    if (withPath.length) {
      res = await window.api.profile.importPaths(withPath, kind);
      const bad = (res.files || []).filter((f) => f.error);
      for (const f of bad) toast(`${f.name}：${f.error}`, true);
    }
    for (const file of plain) {
      if (file.size > 1.5 * 1024 * 1024) {
        toast(`${file.name} 超过 1.5 MB，已跳过`, true);
        continue;
      }
      const text = await file.text();
      res = await window.api.profile.addText({ kind, name: file.name.replace(/\.[^.]+$/, ""), text });
    }
  } catch (err) {
    toast("读取失败：" + (err && err.message ? err.message : err), true);
  }

  if (skipped.length) toast(`不支持：${skipped.map((f) => f.name).join("、")}（支持 pdf / docx / txt / md）`, true);
  if (!res) return;

  state.profile = res.profile;
  state.readiness = res.readiness;
  if (kind === "resume") renderResume();
  else {
    state.previewDocId = ((res.profile.docs || [])[0] || {}).id || "";
    renderDocs();
  }
  renderNav();
  renderReadiness();
  renderPreview();
  const ok = (res.files || []).filter((f) => !f.error);
  if (ok.length) toast(`已添加 ${ok.length} 个文件` + (ok[0].chars ? `（${ok[0].name} · ${ok[0].chars} 字）` : ""));
}

function bindDrop(zoneId, kind) {
  const zone = $(zoneId);
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  zone.addEventListener("dragover", (e) => {
    stop(e);
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", (e) => {
    stop(e);
    zone.classList.remove("dragging");
  });
  zone.addEventListener("drop", (e) => {
    stop(e);
    zone.classList.remove("dragging");
    const dt = e.dataTransfer;
    dropFiles(dt && dt.files, kind);
  });
}

/* ---------------- AI 接口 ---------------- */

function applyPreset(key) {
  const preset = state.providers[key];
  if (!preset || key === "custom") return;
  $("fEndpoint").value = preset.endpoint || "";
  $("fModel").value = preset.model || "";
  $("fApiKey").placeholder = preset.keyHint || "sk-...";
}

async function saveModel() {
  const patch = {
    provider: $("fProvider").value,
    endpoint: $("fEndpoint").value.trim(),
    model: $("fModel").value.trim(),
    apiKey: $("fApiKey").value,
  };
  const res = await window.api.settings.save(patch);
  state.settings = res && res.settings ? res.settings : { ...state.settings, ...patch };
  state.readiness = await window.api.profile.readiness();
  renderModel();
  renderNav();
  renderReadiness();
  renderPreview();
}

async function ping() {
  $("pingState").textContent = "测试中…";
  try {
    await saveModel();
    const res = await window.api.models.ping();
    if (res && (res.ok || res.status === 200)) {
      $("pingState").textContent = "连接正常";
      $("pingState").style.color = "var(--ok)";
      toast("接口可用");
    } else {
      $("pingState").textContent = "失败：" + ((res && res.error) || (res && res.status) || "未知");
      $("pingState").style.color = "#ff9b9b";
    }
  } catch (err) {
    $("pingState").textContent = "失败：" + (err && err.message ? err.message : err);
    $("pingState").style.color = "#ff9b9b";
  }
}

/* ---------------- 进入对话 ---------------- */

async function start(skipReady) {
  if (state.dirty) await persist(currentEdits());
  await window.api.setup.start({ skipReady: !!skipReady });
}

/* ---------------- 事件 ---------------- */

/** 输入框跟着内容长高（短则小、长则大），避免"一个大空框里只有几行字" */
function autoGrow(el) {
  if (!el) return;
  const min = 220;
  const max = Math.max(300, Math.round(window.innerHeight * 0.56));
  el.style.height = "auto";
  const next = Math.max(min, Math.min(el.scrollHeight + 2, max));
  el.style.height = next + "px";
  el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

function growAll() {
  autoGrow($("resumeText"));
  autoGrow($("jobJd"));
}

function bindWindowButtons() {
  const win = window.api.setup;
  $("btnMin").addEventListener("click", () => win.window("minimize"));
  $("btnMax").addEventListener("click", () => win.window("toggle-max"));
  $("btnClose").addEventListener("click", () => win.window("close"));

  // 双击标题栏 = 最大化/还原（和系统窗口一致）
  document.querySelector(".titlebar").addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    win.window("toggle-max");
  });

  const paint = (maximized) => {
    $("btnMax").title = maximized ? "还原" : "最大化";
    $("btnMax").querySelector(".ico-max").hidden = !!maximized;
    $("btnMax").querySelector(".ico-restore").hidden = !maximized;
  };
  window.api.on("setup:maximized", (payload) => paint(payload && payload.maximized));
}

function bind() {
  bindWindowButtons();
  $("btnEnter").addEventListener("click", () => start(false));
  $("btnChatOnly").addEventListener("click", () => start(true));
  $("btnStart").addEventListener("click", () => start(false));

  for (const item of document.querySelectorAll(".nav-item")) {
    item.addEventListener("click", () => setTab(item.dataset.tab));
  }

  $("btnImportResume").addEventListener("click", importResume);
  $("btnAddDoc").addEventListener("click", addDocs);
  $("btnPing").addEventListener("click", ping);
  bindDrop("dropResume", "resume");
  bindDrop("dropDocs", "doc");

  $("btnCopyPreview").addEventListener("click", async () => {
    const text = $("previewBody").innerText;
    if (!text.trim()) return;
    try {
      await window.api.clipboard.write(text);
      toast("已复制侧栏内容");
    } catch {
      toast("复制失败", true);
    }
  });

  $("btnTogglePreview").addEventListener("click", () => {
    const shell = document.querySelector(".shell");
    shell.classList.toggle("preview-off");
    $("btnTogglePreview").textContent = shell.classList.contains("preview-off") ? "‹" : "›";
    $("btnTogglePreview").title = shell.classList.contains("preview-off") ? "展开侧栏" : "收起侧栏";
  });

  $("fProvider").addEventListener("change", () => {
    applyPreset($("fProvider").value);
    saveModel().catch(() => {});
  });

  $("chkStartInWorkspace").addEventListener("change", async (e) => {
    const patch = { startInWorkspace: e.target.checked };
    const res = await window.api.settings.save(patch);
    state.settings = res && res.settings ? res.settings : { ...state.settings, ...patch };
    toast(e.target.checked ? "下次启动会先开这个页面" : "下次启动直接进悬浮窗（托盘「工作台…」随时回来）");
  });

  const onProfileInput = () => {
    const edits = currentEdits();
    state.profile = { ...state.profile, ...edits };
    renderResume();
    renderJob();
    renderNav();
    scheduleSave(edits);
    renderPreview();
  };

  for (const id of ["resumeText", "jobCompany", "jobTitle", "jobJd"]) {
    $(id).addEventListener("input", onProfileInput);
  }

  for (const id of ["resumeText", "jobJd"]) {
    $(id).addEventListener("input", () => autoGrow($(id)));
  }
  window.addEventListener("resize", growAll);

  for (const id of ["fEndpoint", "fModel", "fApiKey"]) {
    $(id).addEventListener("change", () => saveModel().catch(() => {}));
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.api.setup.close();
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) start(false);
  });

  // 外部（脚本 / 主进程托盘）改了资料后，用这个事件让界面重新读一次
  document.addEventListener("fuda:refresh", reloadFromDisk);
}

async function reloadFromDisk() {
  try {
    const data = await window.api.profile.get();
    state.profile = data.profile;
    state.readiness = data.readiness;
    state.settings = data.settings || state.settings;
    renderAll();
    growAll();
  } catch {
    /* 静默：刷新失败不影响当前编辑 */
  }
}

async function boot() {
  try {
    const data = await window.api.profile.get();
    state.profile = data.profile;
    state.settings = data.settings;
    state.readiness = data.readiness;
    state.providers = await window.api.settings.providers();
    $("chkStartInWorkspace").checked = state.settings.startInWorkspace !== false;
    bind();
    setTab(state.readiness.ready ? "resume" : firstUnfinishedTab());
    renderAll();
    growAll();
    setTimeout(growAll, 60);
  } catch (err) {
    toast("工作台加载失败：" + (err && err.message ? err.message : err), true);
  }
}

function firstUnfinishedTab() {
  const items = state.readiness.items || [];
  if (items[0] && !items[0].ok) return "resume";
  if (items[1] && !items[1].ok) return "job";
  return "model";
}

boot();

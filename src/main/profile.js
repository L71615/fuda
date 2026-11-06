"use strict";
/**
 * 工作台数据（Profile）：简历 / 岗位 / 资料库 / 就绪检查 / 检索注入
 *
 * 全本地存储（.user-data\profile.json），不联网；检索用关键词打分，够小规模资料库用，
 * 以后要上向量库，只需要替换 rankChunks() 的实现。
 */
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = process.env.FUDA_DATA_DIR || path.join(path.resolve(__dirname, "..", ".."), ".user-data");
const PROFILE_FILE = path.join(DATA_DIR, "profile.json");

const LIMITS = {
  resumeHeader: 320, // 简历开头一定带上的字节数（姓名/联系方式/教育/技能）
  resumeChunkSize: 360, // 简历切片大小：比资料库更细，方便只挑相关的那段
  resumeTopK: 2, // 按问题额外挑几段简历
  jdContext: 1200, // 岗位 JD 上限
  chunkSize: 450, // 资料库切片大小
  maxChunks: 4000, // 单个资料文件的切片上限，防止误导入巨型文件
  topK: 3, // 每轮注入的资料片段数
  snippetContext: 1600, // 注入的资料总字数上限
};

function emptyProfile() {
  return {
    version: 1,
    resumes: [],
    activeResumeId: "",
    jobs: [],
    activeJobId: "",
    docs: [],
    readyAt: "",
    updatedAt: "",
  };
}

function normalize(raw) {
  const base = emptyProfile();
  if (!raw || typeof raw !== "object") return base;
  const take = (v, fallback) => (Array.isArray(v) ? v : fallback);
  const profile = {
    version: 1,
    resumes: take(raw.resumes, []).filter((r) => r && typeof r.text === "string"),
    jobs: take(raw.jobs, []).filter((j) => j && typeof j === "object"),
    docs: take(raw.docs, []).filter((d) => d && Array.isArray(d.chunks)),
    activeResumeId: typeof raw.activeResumeId === "string" ? raw.activeResumeId : "",
    activeJobId: typeof raw.activeJobId === "string" ? raw.activeJobId : "",
    readyAt: typeof raw.readyAt === "string" ? raw.readyAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
  if (!profile.resumes.some((r) => r.id === profile.activeResumeId)) {
    profile.activeResumeId = profile.resumes.length ? profile.resumes[0].id : "";
  }
  if (!profile.jobs.some((j) => j.id === profile.activeJobId)) {
    profile.activeJobId = profile.jobs.length ? profile.jobs[0].id : "";
  }
  return profile;
}

function load() {
  try {
    // 手改过的文件可能带 BOM（记事本 / PowerShell 常见），先剥掉再解析
    const raw = fs.readFileSync(PROFILE_FILE, "utf8").replace(/^\uFEFF/, "");
    return normalize(JSON.parse(raw));
  } catch {
    return emptyProfile();
  }
}

function save(patch) {
  const next = normalize({ ...load(), ...(patch || {}), updatedAt: new Date().toISOString() });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = PROFILE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, PROFILE_FILE);
  return next;
}

function id(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 按空行切段，再按 chunkSize 打包成片段（不跨段拼接时保留段内完整性） */
function chunkText(text, size) {
  const limit = Number(size) > 40 ? Number(size) : LIMITS.chunkSize;
  const clean = String(text || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!clean) return [];
  const blocks = clean
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const chunks = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  };
  for (const block of blocks.length ? blocks : [clean]) {
    if (block.length > limit) {
      flush();
      for (let i = 0; i < block.length; i += limit) {
        chunks.push(block.slice(i, i + limit).trim());
        if (chunks.length >= LIMITS.maxChunks) return chunks;
      }
      continue;
    }
    if ((buf + "\n\n" + block).length > limit) flush();
    buf = buf ? buf + "\n\n" + block : block;
    if (chunks.length >= LIMITS.maxChunks) return chunks;
  }
  flush();
  return chunks;
}

/** 中英文混合分词：英文按词，中文按 2-gram（比单字匹配准，又不用词典） */
function tokens(text) {
  const out = [];
  const lowered = String(text || "").toLowerCase();
  for (const word of lowered.match(/[a-z0-9_+#.]+/g) || []) {
    if (word.length > 1) out.push(word);
  }
  for (const run of lowered.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function rankChunks(docs, question, topK) {
  const items = [];
  for (const doc of docs || []) {
    for (const chunk of doc.chunks || []) {
      const text = String(chunk.text || chunk);
      if (text) items.push({ text, name: doc.name || "资料" });
    }
  }
  return rankItems(items, question, topK || LIMITS.topK);
}

/**
 * 给一组文本打分排序（简历段落、资料片段都用它）。
 * @param {{text:string,name?:string,index?:number}[]} items
 */
function rankItems(items, question, topK) {
  const qTokens = [...new Set(tokens(question))];
  if (!qTokens.length) return [];
  const scored = [];
  for (const item of items || []) {
    const hay = String(item.text || "").toLowerCase();
    if (!hay) continue;
    let score = 0;
    for (const token of qTokens) {
      let from = 0;
      let hits = 0;
      while (hits < 4) {
        const at = hay.indexOf(token, from);
        if (at === -1) break;
        hits += 1;
        from = at + token.length;
      }
      // 长 token 更值钱（"kubernetes" 比 "的" 信息量大）
      if (hits) score += hits * (1 + Math.min(token.length, 8) / 4);
    }
    if (score > 0) scored.push({ ...item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK || LIMITS.topK);
}

function activeResume(profile) {
  return (profile.resumes || []).find((r) => r.id === profile.activeResumeId) || null;
}

function activeJob(profile) {
  return (profile.jobs || []).find((j) => j.id === profile.activeJobId) || null;
}

function docChunkCount(profile) {
  return (profile.docs || []).reduce((n, d) => n + (d.chunks ? d.chunks.length : 0), 0);
}

/** 就绪检查：给界面用，也决定首启是否直接进工作台 */
function readiness(profile, settings) {
  const resume = activeResume(profile);
  const job = activeJob(profile);
  const chunks = docChunkCount(profile);
  const items = [
    {
      key: "resume",
      label: "简历",
      ok: !!(resume && (resume.text || "").trim().length >= 80),
      hint: resume && (resume.text || "").trim().length >= 80 ? `${resume.name || "简历"} · ${resume.text.length} 字` : "粘贴或导入简历",
    },
    {
      key: "job",
      label: "目标岗位",
      ok: !!(job && (job.title || "").trim()),
      hint: job && (job.title || "").trim() ? [job.company, job.title].filter(Boolean).join(" · ") : "填写岗位名称（JD 可选但强烈建议）",
    },
    {
      key: "docs",
      label: "资料库",
      ok: chunks > 0,
      optional: true,
      hint: chunks > 0 ? `${profile.docs.length} 篇 · ${chunks} 段` : "可选：项目文档 / 面经 / 笔记",
    },
    {
      key: "model",
      label: "AI 接口",
      ok: !!(settings && settings.endpoint && settings.model),
      hint: settings && settings.endpoint ? `${settings.model || "未填模型"}` : "还没配置接口",
    },
  ];
  return { items, ready: items.every((i) => i.ok || i.optional) };
}

/**
 * 组装本轮对话的上下文：岗位 JD + 简历摘要 + 检索到的资料片段。
 * refs 回传给界面，用来显示“引用了哪几段”。
 */
function buildContext(profile, settings, question) {
  const job = activeJob(profile);
  const resume = activeResume(profile);
  const parts = [];
  const refs = [];

  const jobTitle = job && job.title ? [job.company, job.title].filter(Boolean).join(" · ") : "";
  if (jobTitle) parts.push(`目标岗位：${jobTitle}`);
  if (job && job.jd) parts.push(`岗位 JD（节选）：\n${job.jd.slice(0, LIMITS.jdContext)}`);

  // 简历：不再固定取前 900 字（那样永远看不到项目二、实习经历），
  // 改成"开头基本信息 + 与当前问题最相关的段落"，长短简历都不会被截掉重点。
  if (resume && resume.text) {
    const text = resume.text;
    const head = text.slice(0, LIMITS.resumeHeader).trim();
    const chunks = chunkText(text, LIMITS.resumeChunkSize);
    let picked = [];
    if (chunks.length > 1) {
      picked = rankItems(
        chunks.map((chunk, index) => ({ text: chunk, index })),
        question,
        LIMITS.resumeTopK
      ).filter((hit) => hit.index > 0);
    }
    const blocks = [head];
    for (const hit of picked) {
      blocks.push(hit.text);
      refs.push({
        name: `${resume.name || "简历"} · 第 ${hit.index + 1} 段`,
        snippet: hit.text.slice(0, 160),
        score: Number(hit.score.toFixed(1)),
      });
    }
    const tail = chunks.length > 1 ? `（全文 ${text.length} 字，已取开头 ${head.length} 字 + 相关段落 ${picked.length} 段）` : "";
    parts.push(`我的简历${tail}：\n${blocks.join("\n……\n")}`);
  }

  const picked = rankChunks(profile.docs, question);

  let budget = LIMITS.snippetContext;
  for (const hit of picked) {
    if (budget <= 0) break;
    const text = hit.text.slice(0, Math.min(budget, LIMITS.chunkSize));
    budget -= text.length;
    refs.push({ name: hit.name, snippet: text.slice(0, 160), score: Number(hit.score.toFixed(1)) });
    parts.push(`资料《${hit.name}》：\n${text}`);
  }

  if (!parts.length) return { system: "", refs: [] };

  return {
    system:
      "以下是面试者在本地工作台里保存的背景资料，回答时优先使用它们，但不要逐字复述；" +
      "如果资料里没有相关内容，就按通用知识回答，不要编造经历。\n\n" +
      parts.join("\n\n"),
    refs,
  };
}

module.exports = {
  PROFILE_FILE,
  LIMITS,
  emptyProfile,
  load,
  save,
  chunkText,
  tokens,
  rankChunks,
  activeResume,
  activeJob,
  docChunkCount,
  readiness,
  buildContext,
  newResume: (name, text) => ({ id: id("res"), name: name || "我的简历", text: String(text || ""), chars: String(text || "").length, updatedAt: new Date().toISOString() }),
  newJob: (input) => ({
    id: id("job"),
    title: String((input && input.title) || "").trim(),
    company: String((input && input.company) || "").trim(),
    jd: String((input && input.jd) || ""),
    updatedAt: new Date().toISOString(),
  }),
  newDoc: (name, text) => {
    const chunks = chunkText(text).map((t) => ({ text: t }));
    return { id: id("doc"), name: name || "资料", chars: String(text || "").length, chunks, updatedAt: new Date().toISOString() };
  },
};

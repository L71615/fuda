"use strict";

/**
 * 从附件里取纯文本：.txt / .md / .docx / .pdf
 *
 * 只做"把文字拿出来"这一件事，版式、图片一律不保留——
 * 因为下游是喂给模型做背景，不是给人看排版。
 */

const fs = require("node:fs");
const path = require("node:path");

const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".text", ".log", ".csv", ".json", ".yml", ".yaml"]);
const SUPPORTED = [".txt", ".md", ".markdown", ".docx", ".pdf"];

function extOf(filePath) {
  return path.extname(String(filePath || "")).toLowerCase();
}

/** 把零散的空行收拾干净：连续空行合并、行尾空白去掉 */
function tidy(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readDocx(filePath) {
  const mammoth = require("mammoth");
  const res = await mammoth.extractRawText({ buffer: fs.readFileSync(filePath) });
  return res.value || "";
}

async function readPdf(filePath) {
  // 用 legacy 构建：纯 JS，不依赖 canvas / 原生模块，Electron 里也能直接跑
  const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({
    data,
    // 关掉用不到的东西，省内存；cmaps 打不开就退化成按字形取字
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    const lines = [];
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    pages.push(lines.join("\n"));
    page.cleanup();
  }
  await doc.destroy();
  return pages.join("\n\n");
}

/**
 * @param {string} filePath 绝对路径
 * @returns {Promise<{name:string, text:string, ext:string, truncated:boolean}>}
 */
async function extractText(filePath) {
  const ext = extOf(filePath);
  const name = path.basename(filePath);
  if (!fs.existsSync(filePath)) throw new Error("文件不存在：" + name);

  const stat = fs.statSync(filePath);
  if (stat.size > 25 * 1024 * 1024) throw new Error("文件超过 25 MB，先拆分一下：" + name);

  let raw;
  if (TEXT_EXT.has(ext)) {
    raw = fs.readFileSync(filePath, "utf8");
  } else if (ext === ".docx") {
    raw = await readDocx(filePath);
  } else if (ext === ".pdf") {
    raw = await readPdf(filePath);
  } else if (ext === ".doc") {
    throw new Error("老版 .doc 读不了，用 Word 另存为 .docx 或 .pdf 再传");
  } else {
    throw new Error("不支持 " + (ext || "这个") + " 格式，支持：" + SUPPORTED.join(" / "));
  }

  const text = tidy(raw);
  if (!text) throw new Error(name + " 里没读到文字（可能是扫描件/图片版 PDF，需要先 OCR）");
  return { name, text, ext, truncated: false };
}

module.exports = { extractText, tidy, SUPPORTED, TEXT_EXT };

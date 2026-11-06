"use strict";
/**
 * check-syntax.cjs — 用 node:vm 编译所有源文件，等价于批量 `node --check`
 * （不 spawn 子进程，因此在禁止创建子进程的环境里也能跑）。
 *
 *   node tools/check-syntax.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const SKIP = new Set(["node_modules", "runtime", ".cache", ".user-data", ".tmp", "out", "dist"]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(c?js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT, []);
let failed = 0;
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  try {
    new vm.Script(src, { filename: file });
  } catch (err) {
    failed += 1;
    console.error(`语法错误 ${path.relative(ROOT, file)}: ${err.message}`);
  }
}
console.log(`检查 ${files.length} 个文件，失败 ${failed}`);
process.exit(failed ? 1 : 0);

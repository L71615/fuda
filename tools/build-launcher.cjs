// 编译对外启动器 out\fuda.exe（源码 tools\launcher.cs，图标 out\icon.ico）
// 用法: node tools\build-launcher.cjs
// 说明: 用 Windows 自带的 .NET Framework csc.exe，不联网、不装任何东西。
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out", "fuda.exe");
const ICON = path.join(ROOT, "out", "icon.ico");
const SRC = path.join(ROOT, "tools", "launcher.cs");

const CSC_CANDIDATES = [
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
];

const csc = CSC_CANDIDATES.find((p) => fs.existsSync(p));
if (!csc) {
  console.error("找不到 csc.exe（需要 .NET Framework 4.x，Windows 自带）");
  process.exit(1);
}
if (!fs.existsSync(ICON)) {
  console.error("缺少 out\\icon.ico，先跑 node tools\\make-ico.cjs");
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
if (fs.existsSync(OUT)) fs.rmSync(OUT, { force: true });

const args = [
  "/nologo",
  "/target:winexe",
  "/platform:x64",
  "/optimize+",
  "/win32icon:" + ICON,
  "/out:" + OUT,
  SRC,
];
const res = spawnSync(csc, args, { encoding: "utf8" });
if (res.status !== 0) {
  console.error((res.stdout || "") + (res.stderr || ""));
  console.error("编译启动器失败");
  process.exit(1);
}
const size = fs.statSync(OUT).size;
console.log(`launcher -> ${OUT} (${(size / 1024).toFixed(1)} KB)`);

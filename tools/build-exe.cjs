// 打包成可双击运行的 fuda.exe（win32-x64）
// 用法: node tools\build-exe.cjs
// 说明: 用 @electron/packager；Electron 运行时复用 .cache 里已下载的 zip，不重复下载。
const fs = require("node:fs");
const path = require("node:path");
const { packager } = require("@electron/packager");

const ROOT = path.resolve(__dirname, "..");
const CACHE = path.join(ROOT, ".cache");
const ICON = path.join(ROOT, "out", "icon.ico");

(async () => {
  if (!fs.existsSync(ICON)) {
    throw new Error("缺少 out\\icon.ico，先跑 node tools\\make-ico.cjs");
  }
  const [appPath] = await packager({
    dir: ROOT,
    name: "fuda",
    platform: "win32",
    arch: "x64",
    out: path.join(ROOT, "dist"),
    overwrite: true,
    // tmpdir:false = 不建临时目录、直接在 out 里组装。
    // 本机把"解压出来的 electron 目录"整体 rename 一次会稳定报
    // `EPERM: operation not permitted, rename ...`（杀软/索引/沙箱都会拦目录 rename），
    // 关掉临时目录就没有这次 rename。
    tmpdir: false,
    electronVersion: "33.2.1",
    electronZipDir: CACHE,
    icon: ICON,
    asar: true,
    prune: true,
    ignore: [
      /^\/\.cache($|\/)/,
      /^\/\.tmp($|\/)/,
      /^\/\.user-data($|\/)/,
      /^\/dist($|\/)/,
      /^\/out($|\/)/,
      /^\/runtime($|\/)/,
      /^\/tools($|\/)/,
      /^\/docs($|\/)/,
      /^\/README\.md$/,
      /^\/package-lock\.json$/,
    ],
  });
  console.log("packaged -> " + appPath);

  // ---------------------------------------------------------------------------
  // 把 Electron 本体改名成 fuda-core.exe，对外入口换成启动器 fuda.exe。
  // 原因见 tools/launcher.cs：部分会话里 Chromium 沙箱起不来、以及全局
  // ELECTRON_RUN_AS_NODE 会把 exe 变成 node。启动器负责兜住这两种情况。
  // ---------------------------------------------------------------------------
  const core = path.join(appPath, "fuda-core.exe");
  const entry = path.join(appPath, "fuda.exe");
  const launcher = path.join(ROOT, "out", "fuda.exe");
  if (fs.existsSync(core)) fs.rmSync(core, { force: true });
  if (fs.existsSync(entry)) fs.renameSync(entry, core);
  if (!fs.existsSync(launcher)) {
    throw new Error("缺少 out\\fuda.exe，先跑 node tools\\build-launcher.cjs");
  }
  fs.copyFileSync(launcher, entry);
  console.log("launcher -> " + entry + "（Electron 本体: fuda-core.exe）");
})().catch((err) => {
  console.error("BUILD FAILED: " + (err && err.message));
  process.exit(1);
});

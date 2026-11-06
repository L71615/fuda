// 不依赖 @electron/packager 的打包流程。
// 原因：packager 一定会把解压出来的 electron 目录 rename 一次，而本机 rename 目录
// 会稳定失败（EPERM: operation not permitted）。这里改成"拷贝 + 自建 asar"，
// 全程只用文件拷贝和新建，不做目录 rename。
//
// 用法: node tools\build-manual.cjs
// 产物: dist\fuda-win32-x64\fuda.exe（启动器）+ fuda-core.exe（Electron）
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "dist", "fuda-win32-x64");
const STAGE = path.join(ROOT, ".tmp", "stage");

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (filter && !filter(src, entry)) continue;
    if (entry.isDirectory()) copyDir(src, dst, filter);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

(async () => {
  // ---------- 1. 找到 packager 解压好的 electron 目录 ----------
  const distDir = path.join(ROOT, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const candidates = fs
    .readdirSync(distDir)
    .filter((n) => n.startsWith("win32-x64-template-"))
    .map((n) => path.join(distDir, n))
    .filter((p) => fs.existsSync(path.join(p, "electron.exe")));

  if (fs.existsSync(OUT) && fs.existsSync(path.join(OUT, "fuda-core.exe"))) {
    console.log("复用已有 dist\\fuda-win32-x64（只替换 app.asar）");
  } else {
    if (!candidates.length) {
      throw new Error(
        "找不到已解压的 electron 目录（dist\\win32-x64-template-*）。先跑一次 packager，或手动解压 .cache 里的 zip 到该目录。"
      );
    }
    const src = candidates[0];
    console.log("从模板目录复制: " + src + " -> " + OUT);
    rm(OUT);
    copyDir(src, OUT);
    // electron.exe -> fuda-core.exe（文件级 rename，必要时退化成拷贝）
    const exe = path.join(OUT, "electron.exe");
    const core = path.join(OUT, "fuda-core.exe");
    try {
      fs.renameSync(exe, core);
    } catch {
      fs.copyFileSync(exe, core);
      fs.rmSync(exe, { force: true });
    }
  }

  // ---------- 2. 组装 app 目录并打成 asar ----------
  rm(STAGE);
  fs.mkdirSync(STAGE, { recursive: true });
  fs.writeFileSync(
  path.join(STAGE, "package.json"),
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8").replace(/^\uFEFF/, ""),
  "utf8"
);
  copyDir(path.join(ROOT, "src"), path.join(STAGE, "src"));
  // 运行时只需要 koffi（原生库），devDependencies 一律不进包。
  // 而且只留 win32_x64 的 .node：18 个平台各 1.5 MB，全打进去会让 asar 涨到 26 MB。
  const koffiSrc = path.join(ROOT, "node_modules", "koffi");
  if (!fs.existsSync(koffiSrc)) throw new Error("node_modules\\koffi 不存在，先 npm install koffi");
  copyDir(koffiSrc, path.join(STAGE, "node_modules", "koffi"), (p, e) => {
    if (e.isDirectory()) {
      if (["doc", "src", "vendor"].includes(e.name)) return false;
      if (e.name === "build") return true;
      const parent = path.basename(path.dirname(p));
      // node_modules\koffi\build\koffi\<platform> 只保留 win32_x64
      if (parent === "koffi" && path.basename(path.dirname(path.dirname(p))) === "build") {
        return e.name === "win32_x64";
      }
    }
    return true;
  });

  // 导入 PDF / DOCX 用的两个纯 JS 依赖（v6 起它们是运行时依赖，不是 devDependencies）
  const deps = ["pdfjs-dist", "mammoth"];
  for (const dep of deps) {
    const src = path.join(ROOT, "node_modules", dep);
    if (!fs.existsSync(src)) throw new Error(`node_modules\\${dep} 不存在，先 npm install ${dep}`);
    copyDir(src, path.join(STAGE, "node_modules", dep), (p, e) => {
      if (!e.isDirectory()) return true;
      // pdfjs-dist 30 MB，只留真正用到的：legacy 构建（纯 JS）+ 字体/编码表
      if (dep === "pdfjs-dist") {
        const keep = ["legacy", "cmaps", "standard_fonts"];
        const depth = path.relative(src, p).split(path.sep).length;
        if (depth === 1) return keep.includes(e.name);
        return true;
      }
      // mammoth 只跑 Node 端解析，浏览器/测试素材不需要
      if (dep === "mammoth") {
        if (["test", "test-data", "browser", "lib"].includes(e.name) && path.dirname(p) === src) {
          return e.name === "lib";
        }
      }
      return true;
    });
  }

  const resDir = path.join(OUT, "resources");
  fs.mkdirSync(resDir, { recursive: true });
  rm(path.join(resDir, "app.asar"));
  rm(path.join(resDir, "app.asar.unpacked"));
  rm(path.join(resDir, "default_app.asar"));
  // 原生 .node 必须留在 asar 外面才能被 dlopen；unpackDir 是按目录解包的唯一可靠写法
  //（unpack 的 glob 在 Windows 上匹配不到反斜杠路径）
  await asar.createPackageWithOptions(STAGE, path.join(resDir, "app.asar"), {
    unpackDir: "node_modules\\koffi",
  });
  const unpacked = path.join(resDir, "app.asar.unpacked", "node_modules", "koffi");
  if (!fs.existsSync(path.join(unpacked, "build", "koffi", "win32_x64", "koffi.node"))) {
    throw new Error("koffi.node 没有解包到 app.asar.unpacked，原生库加载会失败");
  }
  console.log("app.asar 已生成: " + path.join(resDir, "app.asar"));

  // ---------- 3. 放入启动器 ----------
  const launcher = path.join(ROOT, "out", "fuda.exe");
  if (!fs.existsSync(launcher)) throw new Error("缺少 out\\fuda.exe，先跑 node tools\\build-launcher.cjs");
  fs.copyFileSync(launcher, path.join(OUT, "fuda.exe"));

  // ---------- 4. 清理 ----------
  for (const c of candidates) rm(c);

  const asarSize = fs.statSync(path.join(resDir, "app.asar")).size;
  const coreSize = fs.statSync(path.join(OUT, "fuda-core.exe")).size;
  console.log(
    "done: " +
      OUT +
      `\n  fuda.exe        ${(fs.statSync(path.join(OUT, "fuda.exe")).size / 1024).toFixed(1)} KB（启动器）` +
      `\n  fuda-core.exe   ${(coreSize / 1024 / 1024).toFixed(1)} MB` +
      `\n  resources\\app.asar     ${(asarSize / 1024 / 1024).toFixed(2)} MB`
  );
})().catch((err) => {
  console.error("BUILD FAILED: " + (err && err.stack || err));
  process.exit(1);
});

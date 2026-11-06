// Download the Electron prebuilt zip and extract it into runtime/ (no npm postinstall needed).
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const VERSION = process.env.EV || "33.2.1";
const ZIP_URL = `https://github.com/electron/electron/releases/download/v${VERSION}/electron-v${VERSION}-win32-x64.zip`;
const OUT_DIR = path.resolve(__dirname, "..", "runtime");
const ZIP = path.join(__dirname, "..", ".cache", `electron-v${VERSION}-win32-x64.zip`);

function follow(url, depth = 0) {
  if (depth > 8) throw new Error("too many redirects");
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": "fuda/0.1" }, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        resolve(follow(new URL(res.headers.location, url).toString(), depth + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

(async () => {
  fs.mkdirSync(path.dirname(ZIP), { recursive: true });
  if (fs.existsSync(ZIP) && fs.statSync(ZIP).size > 50 * 1024 * 1024) {
    console.log(`cached zip ${(fs.statSync(ZIP).size / 1e6).toFixed(1)} MB`);
  } else {
    console.log(`downloading ${ZIP_URL}`);
    const res = await follow(ZIP_URL);
    const total = Number(res.headers["content-length"] || 0);
    let got = 0;
    let lastTick = 0;
    const out = fs.createWriteStream(ZIP);
    await new Promise((resolve, reject) => {
      res.on("data", (c) => {
        got += c.length;
        if (Date.now() - lastTick > 3000) {
          lastTick = Date.now();
          console.log(`${(got / 1e6).toFixed(1)} / ${total ? (total / 1e6).toFixed(1) : "?"} MB`);
        }
      });
      res.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
      res.on("error", reject);
    });
    console.log(`saved ${(fs.statSync(ZIP).size / 1e6).toFixed(1)} MB`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // tar.exe (bsdtar) is shipped with Windows 10+ and reads zip archives.
  execFileSync("tar.exe", ["-xf", ZIP, "-C", OUT_DIR], { stdio: "inherit" });
  console.log(`extracted to ${OUT_DIR}`);
  console.log(`electron.exe exists: ${fs.existsSync(path.join(OUT_DIR, "electron.exe"))}`);
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});


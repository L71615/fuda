// 把 icon.js 生成的 PNG 打包成 Windows .ico（ICO 容器里直接放 PNG 是 Vista+ 合法格式）
// 用法: node tools\make-ico.cjs [outfile]
const fs = require("node:fs");
const path = require("node:path");
const { renderIcon } = require("../src/main/icon");

const outFile = process.argv[2] || path.join(__dirname, "..", "out", "icon.ico");
const sizes = [16, 24, 32, 48, 64, 128, 256];

const images = sizes.map((size) => ({ size, png: renderIcon(size) }));

// ICONDIR: reserved(2) type(2)=1 count(2)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + images.length * 16;
for (const { size, png } of images) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width（0 表示 256）
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // 调色板数
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += png.length;
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, Buffer.concat([header, ...entries, ...images.map((i) => i.png)]));
console.log(`ico -> ${outFile} (${sizes.join("/")} px, ${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);

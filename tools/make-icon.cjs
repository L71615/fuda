// 生成托盘图标的 PNG 预览（开发和检查用；运行时不依赖这些文件）
const fs = require("node:fs");
const path = require("node:path");
const { renderIcon } = require(path.join(__dirname, "..", "src", "main", "icon"));

const outDir = path.join(__dirname, "..", "out");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 64]) {
  const png = renderIcon(size);
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`${size}x${size} -> ${file}  ${png.length} bytes`);
}

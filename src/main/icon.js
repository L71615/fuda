"use strict";
/**
 * 托盘图标：不依赖任何图片文件，直接生成 PNG。
 * 这样整个仓库是"源码即软件"，不用带二进制资源，托盘也不会因为路径问题变成空白方块。
 */

const zlib = require("node:zlib");

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

/**
 * 画一枚 32×32 的图标：圆角渐变方块 + 白色对勾（代表"答题"）。
 * @param {number} size
 */
function renderIcon(size = 32) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.28;
  const inset = size * 0.04;

  const set = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    // 简单的 alpha 混合，避免圆角边缘出现黑边
    const dstA = pixels[i + 3] / 255;
    const srcA = a / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;
    pixels[i] = Math.round((r * srcA + pixels[i] * dstA * (1 - srcA)) / outA);
    pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
    pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
    pixels[i + 3] = Math.round(outA * 255);
  };

  const inRoundedRect = (x, y) => {
    const left = inset;
    const top = inset;
    const right = size - inset;
    const bottom = size - inset;
    const cx = Math.min(Math.max(x, left + radius), right - radius);
    const cy = Math.min(Math.max(y, top + radius), bottom - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!inRoundedRect(x + 0.5, y + 0.5)) continue;
      const t = (x + y) / (size * 2);
      set(x, y, mix(79, 124, t), mix(140, 92, t), mix(255, 255, t), 255);
    }
  }

  // 对勾：两段粗线
  const stroke = Math.max(2, Math.round(size * 0.09));
  const p1 = [size * 0.28, size * 0.52];
  const p2 = [size * 0.44, size * 0.68];
  const p3 = [size * 0.74, size * 0.34];

  const drawLine = (a, b) => {
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2);
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const cx = a[0] + (b[0] - a[0]) * t;
      const cy = a[1] + (b[1] - a[1]) * t;
      for (let dy = -stroke; dy <= stroke; dy += 1) {
        for (let dx = -stroke; dx <= stroke; dx += 1) {
          if (dx * dx + dy * dy > stroke * stroke) continue;
          const x = Math.round(cx + dx);
          const y = Math.round(cy + dy);
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          set(x, y, 255, 255, 255, 255);
        }
      }
    }
  };

  drawLine(p1, p2);
  drawLine(p2, p3);
  return encodePng(size, size, pixels);
}

module.exports = { renderIcon, encodePng };

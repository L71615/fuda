"use strict";
/**
 * test-vad.cjs — 能量 VAD 的离线单测。
 *
 *   node tools/test-vad.cjs
 */

const assert = require("node:assert");
const { createSegmenter } = require("../src/renderer/vad.js");

const RATE = 48000;
const BLOCK = 4096;

function tone(ms, amplitude = 0.2, freq = 440) {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.sin((2 * Math.PI * freq * i) / RATE) * amplitude;
  return out;
}

function silence(ms) {
  return new Float32Array(Math.round((RATE * ms) / 1000));
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pushAll(segmenter, samples) {
  const segments = [];
  for (let offset = 0; offset < samples.length; offset += BLOCK) {
    const block = samples.subarray(offset, Math.min(offset + BLOCK, samples.length));
    segments.push(...segmenter.push(block));
  }
  return segments;
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`  FAIL ${name}: ${err && err.message}`);
  }
}

console.log("fuda vad tests");

test("2 秒语音 + 尾部静音只切出一段，且不切断尾音", () => {
  const segmenter = createSegmenter({ sampleRate: RATE });
  const segments = pushAll(segmenter, concat([silence(1000), tone(2000), silence(1800)]));
  assert.equal(segments.length, 1);
  const seconds = segments[0].length / RATE;
  assert.ok(seconds >= 1.9 && seconds <= 2.6, `片段长度异常: ${seconds}s`);
});

test("短促敲击/咳嗽不足 1.2 秒不产生片段", () => {
  const segmenter = createSegmenter({ sampleRate: RATE });
  const segments = pushAll(segmenter, concat([silence(800), tone(300), silence(1800)]));
  assert.equal(segments.length, 0);
});

test("超过 12 秒的连续说话会被强制切段", () => {
  const segmenter = createSegmenter({ sampleRate: RATE });
  const segments = pushAll(segmenter, tone(15000));
  segments.push(...segmenter.flush());
  assert.ok(segments.length >= 2, `应至少切出 2 段，实际 ${segments.length}`);
  for (const segment of segments) {
    assert.ok(segment.length / RATE <= 12.5, `单段超长: ${segment.length / RATE}s`);
  }
});

test("停止时 flush 能把最后半句交出来", () => {
  const segmenter = createSegmenter({ sampleRate: RATE });
  const segments = pushAll(segmenter, concat([silence(500), tone(2000)]));
  assert.equal(segments.length, 0);
  const rest = segmenter.flush();
  assert.equal(rest.length, 1);
  assert.ok(rest[0].length / RATE >= 1.8);
});

test("全静音不产生片段", () => {
  const segmenter = createSegmenter({ sampleRate: RATE });
  assert.equal(pushAll(segmenter, silence(4000)).length, 0);
  assert.equal(segmenter.flush().length, 0);
});

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length}/${results.length} 个测试失败`);
  process.exit(1);
}
console.log(`\n${results.length}/${results.length} 个测试通过`);

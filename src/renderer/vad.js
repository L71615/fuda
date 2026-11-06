"use strict";
/**
 * 轻量能量 VAD：把连续音频流切成“一句话”的片段。
 *
 * 不依赖浏览器 API，Node 里也能直接 require，方便单测。
 * 输入是任意长度的 Float32Array；输出是若干段更长的 Float32Array。
 *
 * 规则：
 *   - 连续 1.4 秒低于 endRms 视为说完；
 *   - 一段至少 1.2 秒有声，否则丢弃（咳嗽、敲键盘）；
 *   - 一段最长 12 秒，避免模型一直等不到结尾；
 *   - 触发说话前保留 0.3 秒预卷，避免吃掉第一个字；
 *   - 结尾保留 0.2 秒尾音，避免切断最后一个字。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FudaVad = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DEFAULTS = {
    sampleRate: 16000,
    startRms: 0.0045,
    endRms: 0.0025,
    silenceMs: 1400,
    minSpeechMs: 1200,
    maxSegmentMs: 12000,
    preRollMs: 300,
    tailMs: 200,
  };

  function rms(samples) {
    if (!samples || !samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  function concat(chunks, length) {
    const out = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      if (offset + chunk.length > length) {
        out.set(chunk.subarray(0, length - offset), offset);
        break;
      }
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function createSegmenter(options = {}) {
    const cfg = Object.assign({}, DEFAULTS, options);
    const rate = Math.max(1, Number(cfg.sampleRate) || DEFAULTS.sampleRate);
    const preRollLimit = Math.max(1, Math.round((rate * cfg.preRollMs) / 1000));
    const silenceLimit = Math.max(1, Math.round((rate * cfg.silenceMs) / 1000));
    const minSpeech = Math.max(1, Math.round((rate * cfg.minSpeechMs) / 1000));
    const maxSamples = Math.max(minSpeech, Math.round((rate * cfg.maxSegmentMs) / 1000));
    const tailKeep = Math.max(0, Math.round((rate * cfg.tailMs) / 1000));

    let speaking = false;
    let preRoll = [];
    let preRollSamples = 0;
    let buffer = [];
    let bufferSamples = 0;
    let silenceSamples = 0;
    let voicedSamples = 0;

    function reset() {
      speaking = false;
      preRoll = [];
      preRollSamples = 0;
      buffer = [];
      bufferSamples = 0;
      silenceSamples = 0;
      voicedSamples = 0;
    }

    function addPreRoll(block) {
      preRoll.push(block);
      preRollSamples += block.length;
      while (preRollSamples > preRollLimit && preRoll.length > 0) {
        const excess = preRollSamples - preRollLimit;
        const first = preRoll[0];
        if (first.length <= excess) {
          preRoll.shift();
          preRollSamples -= first.length;
        } else {
          preRoll[0] = first.subarray(excess);
          preRollSamples -= excess;
        }
      }
    }

    function emit() {
      if (!speaking) return null;
      const trim = Math.max(0, silenceSamples - tailKeep);
      const length = Math.max(0, bufferSamples - trim);
      const voicedEnough = voicedSamples >= minSpeech;
      const samples = length > 0 ? concat(buffer, length) : null;
      reset();
      return voicedEnough ? samples : null;
    }

    function begin(block, level) {
      // 预卷里已经包含当前块；直接接管，避免重复。
      buffer = preRoll.slice();
      bufferSamples = preRollSamples;
      preRoll = [];
      preRollSamples = 0;
      speaking = true;
      silenceSamples = 0;
      voicedSamples = level >= cfg.endRms ? block.length : 0;
      if (bufferSamples >= maxSamples) return emit();
      return null;
    }

    function push(samples) {
      const out = [];
      if (!samples || !samples.length) return out;
      const block = samples instanceof Float32Array ? samples : Float32Array.from(samples);

      if (!speaking) {
        addPreRoll(block);
        if (rms(block) >= cfg.startRms) {
          const seg = begin(block, rms(block));
          if (seg) out.push(seg);
        }
        return out;
      }

      buffer.push(block);
      bufferSamples += block.length;
      const level = rms(block);
      if (level >= cfg.endRms) {
        silenceSamples = 0;
        voicedSamples += block.length;
      } else {
        silenceSamples += block.length;
      }

      if (silenceSamples >= silenceLimit || bufferSamples >= maxSamples) {
        const seg = emit();
        if (seg) out.push(seg);
      }
      return out;
    }

    function flush() {
      const out = [];
      if (!speaking) return out;
      const seg = emit();
      if (seg) out.push(seg);
      return out;
    }

    return {
      push,
      flush,
      reset,
      get speaking() {
        return speaking;
      },
      get config() {
        return Object.assign({}, cfg);
      },
    };
  }

  return { DEFAULTS, createSegmenter, rms };
});

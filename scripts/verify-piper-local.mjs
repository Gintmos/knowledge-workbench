/**
 * 1.0.7 Piper 本地朗读核心链路验证（仅开发/验收使用，不随插件发布）。
 * 用与 src/speech/piperEngine.ts 相同的本地文件和相同参数，在 Node 里跑一次中文合成。
 * 验证：音素 WASM 转换、ONNX 模型加载、张量构造、推理输出音频。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const TTS = path.resolve(
  "C:/Users/wintm/WorkBuddy/2026-11-15-13-41-48/knowledge-workbench/test-vault/知识管理工作台/tts",
);
const VOICE = "zh_CN-huayan-medium";
const TEXT = "你好，这是一段离线中文语音合成测试，今天天气很好。";

const config = JSON.parse(readFileSync(path.join(TTS, `${VOICE}.onnx.json`), "utf8"));
const modelBytes = new Uint8Array(readFileSync(path.join(TTS, `${VOICE}.onnx`)));

const t0 = Date.now();
const createPiperPhonemize = require(path.join(TTS, "piper_phonemize.js"));
const phonemeIds = await new Promise((resolve, reject) => {
  let settled = false;
  createPiperPhonemize({
    print: (data) => {
      if (settled) return;
      try {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed.phoneme_ids)) {
          settled = true;
          resolve(parsed.phoneme_ids);
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    },
    printErr: (message) => {
      if (!settled) {
        settled = true;
        reject(new Error(String(message)));
      }
    },
    locateFile: (name) => {
      const local = path.join(TTS, name);
      return local;
    },
  })
    .then((mod) =>
      mod.callMain([
        "-l",
        config.espeak.voice,
        "--input",
        JSON.stringify([{ text: TEXT }]),
        "--espeak_data",
        "/espeak-ng-data",
      ]),
    )
    .catch((error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
});
console.log("phonemeIds:", phonemeIds.length, "sample:", phonemeIds.slice(0, 24).join(","));

const ort = await import("onnxruntime-web");
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = {
  "ort-wasm-simd.wasm": path.join(TTS, "ort-wasm-simd.wasm"),
  "ort-wasm-simd-threaded.wasm": path.join(TTS, "ort-wasm-simd-threaded.wasm"),
};
const session = await ort.InferenceSession.create(modelBytes, {
  executionProviders: ["wasm"],
});
console.log("session inputs:", session.inputNames.join(","), "outputs:", session.outputNames.join(","));

const feeds = {
  input: new ort.Tensor("int64", phonemeIds, [1, phonemeIds.length]),
  input_lengths: new ort.Tensor("int64", [phonemeIds.length], [1]),
  scales: new ort.Tensor("float32", [
    config.inference.noise_scale,
    config.inference.length_scale,
    config.inference.noise_w,
  ], [3]),
};
if (Object.keys(config.speaker_id_map).length) {
  feeds.sid = new ort.Tensor("int64", [0], [1]);
}
const result = await session.run(feeds);
const outName = session.outputNames[0];
const audio = result[outName].data;
const seconds = audio.length / config.audio.sample_rate;
let peak = 0;
for (const s of audio) peak = Math.max(peak, Math.abs(s));
console.log(
  `RESULT ok: ${Date.now() - t0}ms, ${audio.length} samples, ${seconds.toFixed(2)}s audio, peak=${peak.toFixed(4)}, sampleRate=${config.audio.sample_rate}`,
);

// 导出 WAV，供人工试听。
const sr = config.audio.sample_rate;
const buf = Buffer.alloc(44 + audio.length * 2);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + audio.length * 2, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sr, 24);
buf.writeUInt32LE(sr * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(audio.length * 2, 40);
for (let i = 0; i < audio.length; i += 1) {
  const s = Math.max(-1, Math.min(1, audio[i]));
  buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2);
}
const outPath = path.resolve(
  "C:/Users/wintm/WorkBuddy/2026-11-15-13-41-48/knowledge-workbench/dist/piper-local-sample.wav",
);
writeFileSync(outPath, buf);
console.log(`WAV written: ${outPath} (${buf.length} bytes)`);

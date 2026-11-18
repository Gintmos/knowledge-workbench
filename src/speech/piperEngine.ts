/**
 * Piper WASM 本地朗读引擎（1.0.7）。
 *
 * 模型、音素 WASM 与 ONNX Runtime WASM 都放在库内目录，运行时只读取本地文件，
 * 不发任何网络请求；JS 运行时通过 Blob URL 动态 import，避免把第三方大块代码
 * 打进 main.js。语音合成在主线程完成，按现有句群分块逐级播放。
 */
import type { App } from "obsidian";
import type {
  SpeakHandlers,
  SpeakOptions,
  SpeechEngine,
  SpeechVoice,
} from "./types";

interface PiperConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: {
    noise_scale: number;
    length_scale: number;
    noise_w: number;
  };
  speaker_id_map: Record<string, unknown>;
}

interface Phonemizer {
  callMain(args: string[]): Promise<number> | number;
}

type PhonemizerFactory = (options: {
  print: (data: string) => void;
  printErr: (message: string) => void;
  locateFile: (name: string) => string;
}) => Promise<Phonemizer>;

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
}

interface OrtModule {
  env: {
    wasm: {
      numThreads: number;
      wasmPaths: Record<string, string>;
    };
  };
  Tensor: new (type: string, data: ArrayLike<number>, dims: number[]) => unknown;
  InferenceSession: {
    create(
      bytes: Uint8Array,
      options: { executionProviders: string[] },
    ): Promise<OrtSession>;
  };
}

export interface PiperEngineOptions {
  hostApp: App;
  getModelDir: () => string;
  getVoiceId: () => string;
  /** 设置页选择 system 时返回 false，引擎不参与朗读。 */
  isEnabled: () => boolean;
  onReadyChange?: () => void;
}

const ONNX_WASM_FILES = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.wasm",
];

function joinPath(base: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/${name.replace(/^\/+/, "")}`;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function createPiperEngine(options: PiperEngineOptions): SpeechEngine {
  const { hostApp, getModelDir, getVoiceId, isEnabled, onReadyChange } = options;
  let ready = false;
  let initializing: Promise<void> | null = null;
  let lastError = "";
  let session: OrtSession | null = null;
  let config: PiperConfig | null = null;
  let phonemizerFactory: PhonemizerFactory | null = null;
  let ort: OrtModule | null = null;
  let wasmPaths: Record<string, string> = {};
  let phonemizerUrls: Record<string, string> = {};
  let audio: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;
  let token = 0;
  let speaking = false;
  let paused = false;
  const disposed = false;
  const cache = new Map<string, Blob>();

  const asUint8 = (data: ArrayBuffer | Uint8Array): Uint8Array =>
    data instanceof Uint8Array ? data : new Uint8Array(data);

  const blobPart = (bytes: Uint8Array): ArrayBuffer =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  const read = async (name: string): Promise<Uint8Array> => {
    const path = joinPath(getModelDir(), name);
    const data = await hostApp.vault.adapter.readBinary(path);
    return asUint8(data);
  };

  const releaseAudio = (): void => {
    if (audio) {
      audio.onplaying = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio = null;
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    speaking = false;
    paused = false;
  };

  const initialize = async (): Promise<void> => {
    if (ready) return;
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        const voice = getVoiceId();
        config = JSON.parse(new TextDecoder().decode(await read(`${voice}.onnx.json`))) as PiperConfig;
        const modelBytes = await read(`${voice}.onnx`);
        const phonemizerJs = new TextDecoder().decode(await read("piper_phonemize.js"));
        const phonemizerWasm = await read("piper_phonemize.wasm");
        const phonemizerData = await read("piper_phonemize.data");
        const ortJs = new TextDecoder().decode(await read("ort.wasm.min.mjs"));
        phonemizerUrls = {
          "piper_phonemize.wasm": URL.createObjectURL(new Blob([blobPart(phonemizerWasm)], { type: "application/wasm" })),
          "piper_phonemize.data": URL.createObjectURL(new Blob([blobPart(phonemizerData)])),
        };
        const phonemizerModule = await import(/* @vite-ignore */ URL.createObjectURL(new Blob([phonemizerJs], { type: "text/javascript" }))) as {
          default?: PhonemizerFactory;
        };
        phonemizerFactory = phonemizerModule.default ?? null;
        if (!phonemizerFactory) throw new Error("piper phonemizer 未导出 createPiperPhonemize");

        wasmPaths = {};
        for (const name of ONNX_WASM_FILES) {
          try {
            const bytes = await read(name);
            wasmPaths[name] = URL.createObjectURL(new Blob([blobPart(bytes)], { type: "application/wasm" }));
          } catch {
            // 只加载库中实际存在的文件；缺哪一个由 ORT 自己报错。
          }
        }
        const ortModule = await import(/* @vite-ignore */ URL.createObjectURL(new Blob([ortJs], { type: "text/javascript" }))) as OrtModule;
        ort = ortModule;
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.wasmPaths = wasmPaths;
        session = await ort.InferenceSession.create(modelBytes, {
          executionProviders: ["wasm"],
        });
        ready = true;
        lastError = "";
      } catch (error) {
        ready = false;
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        initializing = null;
        onReadyChange?.();
      }
    })();
    return initializing;
  };

  const synthesize = async (text: string, rate: number): Promise<Blob> => {
    await initialize();
    if (!ready || !session || !ort || !config || !phonemizerFactory) {
      throw new Error(lastError || "Piper 本地语音未就绪");
    }
    const key = `${getVoiceId()}|${rate.toFixed(2)}|${text}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const phonemeIds = await new Promise<number[]>((resolve, reject) => {
      void phonemizerFactory!({
        print: (data: string) => {
          try {
            resolve(JSON.parse(data).phoneme_ids as number[]);
          } catch (error) {
            reject(error);
          }
        },
        printErr: (message: string) => reject(new Error(message)),
        locateFile: (name: string) => phonemizerUrls[name] ?? name,
      }).then((module) =>
        module.callMain([
          "-l",
          config!.espeak.voice,
          "--input",
          JSON.stringify([{ text: text.trim() }]),
          "--espeak_data",
          "/espeak-ng-data",
        ]),
      );
    });
    if (!phonemeIds.length) throw new Error("音素转换结果为空");

    const feeds: Record<string, unknown> = {
      input: new ort.Tensor("int64", phonemeIds, [1, phonemeIds.length]),
      input_lengths: new ort.Tensor("int64", [phonemeIds.length], [1]),
      scales: new ort.Tensor("float32", [
        config.inference.noise_scale,
        config.inference.length_scale / Math.max(0.25, rate),
        config.inference.noise_w,
      ], [3]),
    };
    if (Object.keys(config.speaker_id_map).length) {
      feeds["sid"] = new ort.Tensor("int64", [0], [1]);
    }
    const result = await session.run(feeds);
    const blob = encodeWav(result.output.data, config.audio.sample_rate);
    cache.set(key, blob);
    if (cache.size > 40) cache.delete(cache.keys().next().value as string);
    return blob;
  };

  if (isEnabled()) void initialize();

  return {
    label: "Piper WASM 本地语音",
    needsKeepAlive: false,
    supported: () => ready && isEnabled(),
    prepare: () => {
      if (isEnabled()) void initialize();
    },
    getVoices: (): SpeechVoice[] =>
      ready ? [{ name: getVoiceId(), lang: "zh-CN" }] : [],
    hasVoices: () => ready,
    speak: (text: string, options: SpeakOptions, handlers: SpeakHandlers) => {
      const current = ++token;
      void synthesize(text, options.rate * (options.rateScale ?? 1))
        .then((blob) => {
          if (disposed || current !== token) return;
          releaseAudio();
          objectUrl = URL.createObjectURL(blob);
          const element = new Audio(objectUrl);
          audio = element;
          element.onplaying = () => {
            speaking = true;
            paused = false;
            if (current === token) handlers.onStart();
          };
          element.onended = () => {
            if (current !== token) return;
            releaseAudio();
            handlers.onEnd();
          };
          element.onerror = () => {
            if (current !== token) return;
            releaseAudio();
            handlers.onError("audio-playback-failed");
          };
          void element.play().catch((error: unknown) => {
            if (current !== token) return;
            handlers.onError(error instanceof Error ? error.message : String(error));
          });
        })
        .catch((error: unknown) => {
          if (disposed || current !== token) return;
          handlers.onError(error instanceof Error ? error.message : String(error));
        });
    },
    cancel: () => {
      token += 1;
      releaseAudio();
    },
    pause: () => {
      if (audio && !audio.paused) {
        audio.pause();
        paused = true;
      }
    },
    resume: () => {
      if (audio) void audio.play().catch(() => undefined);
      paused = false;
    },
    isSpeaking: () => speaking && !paused,
    isPaused: () => paused,
  };
}

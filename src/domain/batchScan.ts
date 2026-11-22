export interface ScanSignal {
  aborted: boolean;
}

export interface BatchScanOptions {
  /** 每批条目数；每批结束让出一次主线程。默认 60。 */
  batchSize?: number;
  /** 批内并发上限（仅对返回 Promise 的 worker 有意义）。默认 8。 */
  concurrency?: number;
  yieldFn?: () => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  signal?: ScanSignal;
}

export interface BatchScanResult<R> {
  items: R[];
  yields: number;
  durationMs: number;
  aborted: boolean;
}

/** 浏览器与手机端都可用的让出方式（不依赖 requestIdleCallback）。 */
export function defaultYield(): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function now(): number {
  return typeof window.performance?.now === "function"
    ? window.performance.now()
    : Date.now();
}

/**
 * 分批扫描：批内按 concurrency 并发，批间让出主线程，
 * 使万篇 md 的首次索引不阻塞 UI；signal 用于取消过期的扫描任务。
 */
export async function scanInBatches<T, R>(
  items: T[],
  worker: (item: T, index: number) => R | Promise<R>,
  options: BatchScanOptions = {},
): Promise<BatchScanResult<R>> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 60));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 8));
  const yieldFn = options.yieldFn ?? defaultYield;
  const start = now();
  const result: R[] = [];
  let yields = 0;
  let aborted = false;

  for (let offset = 0; offset < items.length; offset += batchSize) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    const batch = items.slice(offset, offset + batchSize);
    for (let cursor = 0; cursor < batch.length; cursor += concurrency) {
      if (options.signal?.aborted) {
        aborted = true;
        break;
      }
      const chunk = batch.slice(cursor, cursor + concurrency);
      const values = await Promise.all(
        chunk.map((item, pos) => worker(item, offset + cursor + pos)),
      );
      result.push(...values);
    }
    if (aborted) break;
    options.onProgress?.(Math.min(offset + batch.length, items.length), items.length);
    await yieldFn();
    yields += 1;
  }

  return {
    items: result,
    yields,
    durationMs: Math.round(now() - start),
    aborted,
  };
}

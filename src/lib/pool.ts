// 共享并发池：每项独立执行、独立失败，单项失败不拖垮整批。
// 自动重试 / 鉴权中止 / 429 降并发属于 PR4 的增强，这里保持最小行为。
export interface PoolSnapshot {
  total: number;
  done: number;
  failed: number;
  canceled: number;
  active: number;
}

export type PoolStatus = 'done' | 'failed' | 'canceled';

export interface PoolResult<T, R> {
  item: T;
  index: number;
  status: PoolStatus;
  value?: R;
  error?: unknown;
}

export interface PoolOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onUpdate?: (snapshot: PoolSnapshot) => void;
}

export async function runPool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  options: PoolOptions = {},
): Promise<PoolResult<T, R>[]> {
  const total = items.length;
  const results: PoolResult<T, R>[] = new Array(total);
  if (!total) return results;

  const requested = Math.floor(options.concurrency ?? 3);
  const concurrency = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 3, total));
  const { signal, onUpdate } = options;
  let next = 0;
  let done = 0;
  let failed = 0;
  let canceled = 0;
  let active = 0;

  const publish = () => onUpdate?.({ total, done, failed, canceled, active });

  async function runOne(index: number) {
    active += 1;
    publish();
    const item = items[index];
    let result: PoolResult<T, R>;
    try {
      const value = await worker(item, index);
      result = { item, index, status: 'done', value };
      done += 1;
    } catch (error) {
      if (signal?.aborted) {
        result = { item, index, status: 'canceled', error };
        canceled += 1;
      } else {
        result = { item, index, status: 'failed', error };
        failed += 1;
      }
    }
    results[index] = result;
    active -= 1;
    publish();
  }

  async function drain() {
    while (!signal?.aborted) {
      const index = next;
      if (index >= total) return;
      next += 1;
      await runOne(index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, drain));

  // 中止后没来得及派发的项：没有发出请求，标记为已取消。
  for (let index = next; index < total; index += 1) {
    if (results[index]) continue;
    results[index] = { item: items[index], index, status: 'canceled' };
    canceled += 1;
  }
  publish();
  return results;
}

// 共享并发池：每项独立执行、独立失败，单项失败不拖垮整批。
// 429 自动重试（最多 2 次，降低并发），401/402/403 立即停止派发剩余项。
// submission_unknown、超时、5xx 不自动重试：可能已扣费，交回页面让用户手动重试。
export interface PoolSnapshot {
  total: number;
  done: number;
  failed: number;
  canceled: number;
  notSubmitted: number;
  active: number;
}

export type PoolStatus = 'done' | 'failed' | 'canceled' | 'not_submitted';

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
  /** 两次派发之间的最小间隔，默认 300ms。 */
  staggerMs?: number;
  /** 429 的退避时间（毫秒），默认 [3000, 8000]；测试可缩短。 */
  retryDelaysMs?: [number, number];
  /** 是否对 429 自动重试，默认 true。 */
  retryRateLimit?: boolean;
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : 0;
}
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : '';
}
function isRateLimited(error: unknown) { return statusOf(error) === 429 || codeOf(error) === 'rate_limited'; }
function isFatal(error: unknown) {
  return [401, 402, 403].includes(statusOf(error)) || ['invalid_key', 'provider_auth_failed', 'provider_forbidden', 'insufficient_balance'].includes(codeOf(error));
}
function retryAfterOf(error: unknown) {
  const value = (error as { retryAfter?: unknown } | null | undefined)?.retryAfter;
  return typeof value === 'number' && value >= 0 ? value : undefined;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function runPool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  options: PoolOptions = {},
): Promise<PoolResult<T, R>[]> {
  const total = items.length;
  const results: PoolResult<T, R>[] = new Array(total);
  if (!total) return results;

  const requested = Math.floor(options.concurrency ?? 3);
  const initial = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 3, total));
  let concurrency = initial;
  const staggerMs = Math.max(0, options.staggerMs ?? 300);
  const delays: [number, number] = options.retryDelaysMs ?? [3000, 8000];
  const retryRateLimit = options.retryRateLimit !== false;
  const { signal, onUpdate } = options;

  const queue = items.map((_, index) => index);
  let active = 0;
  let done = 0;
  let failed = 0;
  let canceled = 0;
  let notSubmitted = 0;
  let fatalStop = false;
  let nextLaunchAt = 0;

  const publish = () => onUpdate?.({ total, done, failed, canceled, notSubmitted, active });
  const settle = (index: number, status: PoolStatus, value?: R, error?: unknown) => {
    results[index] = { item: items[index], index, status, value, error };
    if (status === 'done') done += 1;
    else if (status === 'failed') failed += 1;
    else if (status === 'canceled') canceled += 1;
    else notSubmitted += 1;
    publish();
  };

  async function runItem(index: number) {
    let attempt = 0;
    while (true) {
      try {
        const value = await worker(items[index], index);
        settle(index, 'done', value);
        return;
      } catch (error) {
        if (signal?.aborted) { settle(index, 'canceled', undefined, error); return; }
        if (retryRateLimit && isRateLimited(error) && attempt < 2) {
          attempt += 1;
          concurrency = Math.max(1, concurrency - 1);
          publish();
          await sleep(retryAfterOf(error) ?? delays[Math.min(attempt - 1, delays.length - 1)]);
          if (signal?.aborted) { settle(index, 'canceled', undefined, error); return; }
          continue;
        }
        if (isFatal(error)) fatalStop = true;
        settle(index, 'failed', undefined, error);
        return;
      }
    }
  }

  async function loop() {
    while (true) {
      if (signal?.aborted || fatalStop) return;
      if (!queue.length) return;
      if (active >= concurrency) { await sleep(10); continue; }
      const now = Date.now();
      if (now < nextLaunchAt) { await sleep(Math.min(nextLaunchAt - now, 10)); continue; }
      const index = queue.shift()!;
      nextLaunchAt = Date.now() + staggerMs;
      active += 1;
      publish();
      await runItem(index);
      active -= 1;
      publish();
    }
  }

  publish();
  await Promise.all(Array.from({ length: initial }, loop));

  // 中止或鉴权失败后没来得及派发的项：没有发出请求，不会扣费。
  for (const index of queue) {
    if (results[index]) continue;
    settle(index, fatalStop ? 'not_submitted' : 'canceled');
  }
  publish();
  return results;
}

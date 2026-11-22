import test from 'node:test';
import assert from 'node:assert/strict';
import { runPool, type PoolSnapshot } from '../src/lib/pool';

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('并发池同时运行的项数不超过上限', async () => {
  let active = 0;
  let peak = 0;
  const snapshots: PoolSnapshot[] = [];
  const results = await runPool([1, 2, 3, 4, 5, 6], async () => {
    active += 1;
    peak = Math.max(peak, active);
    await tick(10);
    active -= 1;
    return 'ok';
  }, { concurrency: 3, staggerMs: 0, onUpdate: snapshot => snapshots.push(snapshot) });

  assert.equal(peak, 3);
  assert.equal(results.length, 6);
  assert.ok(results.every(result => result.status === 'done' && result.value === 'ok'));
  const last = snapshots.at(-1)!;
  assert.deepEqual({ done: last.done, failed: last.failed, canceled: last.canceled, active: last.active }, { done: 6, failed: 0, canceled: 0, active: 0 });
});

test('单项失败只标红该项，不中断整批', async () => {
  const results = await runPool([0, 1, 2, 3], async item => {
    await tick(5);
    if (item === 2) throw new Error('fixture-failure');
    return item * 10;
  }, { concurrency: 2, staggerMs: 0 });

  assert.deepEqual(results.map(result => result.status), ['done', 'done', 'failed', 'done']);
  assert.equal(results[2].error instanceof Error, true);
  assert.equal((results[2].error as Error).message, 'fixture-failure');
  assert.deepEqual(results.filter(result => result.status === 'done').map(result => result.value), [0, 10, 30]);
});

test('中止后停止派发，未开始的项标记为已取消且不执行', async () => {
  const started: number[] = [];
  const controller = new AbortController();
  const results = await runPool([0, 1, 2, 3], async item => {
    started.push(item);
    controller.abort();
    throw new DOMException('aborted', 'AbortError');
  }, { concurrency: 1, staggerMs: 0, signal: controller.signal });

  assert.deepEqual(started, [0]);
  assert.deepEqual(results.map(result => result.status), ['canceled', 'canceled', 'canceled', 'canceled']);
});

test('运行中中止时已完成项保留完成状态', async () => {
  const controller = new AbortController();
  const results = await runPool([0, 1, 2], async item => {
    await tick(5);
    if (item === 0) controller.abort();
    return item;
  }, { concurrency: 1, staggerMs: 0, signal: controller.signal });

  assert.equal(results[0].status, 'done');
  assert.equal(results[1].status, 'canceled');
  assert.equal(results[2].status, 'canceled');
});

test('结果保持输入顺序，即使完成顺序不同', async () => {
  const results = await runPool([30, 5, 20], async item => {
    await tick(item);
    return item;
  }, { concurrency: 3, staggerMs: 0 });

  assert.deepEqual(results.map(result => result.index), [0, 1, 2]);
  assert.deepEqual(results.map(result => result.value), [30, 5, 20]);
});

test('空列表直接返回，不触发回调', async () => {
  let updates = 0;
  const results = await runPool([], async () => 'never', { onUpdate: () => { updates += 1; } });
  assert.equal(results.length, 0);
  assert.equal(updates, 0);
});

test('429 优先按 Retry-After 重试，降到最低并发后成功收尾', async () => {
  const attempts = new Map<number, number>();
  const results = await runPool([0, 1, 2, 3, 4, 5], async item => {
    const attempt = (attempts.get(item) ?? 0) + 1;
    attempts.set(item, attempt);
    if (item === 0 && attempt === 1) throw Object.assign(new Error('rate'), { status: 429, retryAfter: 20 });
    await tick(5);
    return item;
  }, { concurrency: 3, staggerMs: 0, retryDelaysMs: [1000, 1000] });

  assert.equal(attempts.get(0), 2);
  assert.ok(results.every(result => result.status === 'done'));
});

test('429 最多重试两次，之后标记失败', async () => {
  let attempts = 0;
  const results = await runPool([0], async () => {
    attempts += 1;
    throw Object.assign(new Error('rate'), { status: 429 });
  }, { concurrency: 1, staggerMs: 0, retryDelaysMs: [5, 5] });

  assert.equal(attempts, 3);
  assert.deepEqual(results.map(result => result.status), ['failed']);
});

test('401 立即停止派发，剩余项标记为未提交且未执行', async () => {
  const called: number[] = [];
  const results = await runPool([0, 1, 2, 3, 4], async item => {
    called.push(item);
    if (item === 0) throw Object.assign(new Error('auth'), { status: 401 });
    await tick(5);
    return item;
  }, { concurrency: 2, staggerMs: 0 });

  assert.equal(results[0].status, 'failed');
  assert.equal(called.includes(3), false);
  assert.equal(called.includes(4), false);
  assert.deepEqual(results.slice(2).map(result => result.status), ['not_submitted', 'not_submitted', 'not_submitted']);
});

test('402 / 403 同样视为致命错误并停止派发', async () => {
  for (const status of [402, 403]) {
    const results = await runPool([0, 1, 2], async item => {
      if (item === 0) throw Object.assign(new Error('fatal'), { status });
      return item;
    }, { concurrency: 1, staggerMs: 0 });
    assert.equal(results[0].status, 'failed');
    assert.deepEqual(results.slice(1).map(result => result.status), ['not_submitted', 'not_submitted']);
  }
});

test('5xx 与超时不自动重试', async () => {
  for (const status of [500, 502, 504]) {
    let attempts = 0;
    const results = await runPool([0], async () => {
      attempts += 1;
      throw Object.assign(new Error('upstream'), { status });
    }, { concurrency: 1, staggerMs: 0 });
    assert.equal(attempts, 1);
    assert.equal(results[0].status, 'failed');
  }
});

test('派发间隔不小于 staggerMs', async () => {
  const times: number[] = [];
  await runPool([0, 1, 2], async () => { times.push(Date.now()); }, { concurrency: 3, staggerMs: 40 });
  assert.ok(times[1] - times[0] >= 35, `second launch ${times[1] - times[0]}ms`);
  assert.ok(times[2] - times[1] >= 35, `third launch ${times[2] - times[1]}ms`);
});

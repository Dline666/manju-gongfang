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
  }, { concurrency: 3, onUpdate: snapshot => snapshots.push(snapshot) });

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
  }, { concurrency: 2 });

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
  }, { concurrency: 1, signal: controller.signal });

  assert.deepEqual(started, [0]);
  assert.deepEqual(results.map(result => result.status), ['canceled', 'canceled', 'canceled', 'canceled']);
});

test('运行中中止时已完成项保留完成状态', async () => {
  const controller = new AbortController();
  const results = await runPool([0, 1, 2], async item => {
    await tick(5);
    if (item === 0) controller.abort();
    return item;
  }, { concurrency: 1, signal: controller.signal });

  assert.equal(results[0].status, 'done');
  assert.equal(results[1].status, 'canceled');
  assert.equal(results[2].status, 'canceled');
});

test('结果保持输入顺序，即使完成顺序不同', async () => {
  const results = await runPool([30, 5, 20], async item => {
    await tick(item);
    return item;
  }, { concurrency: 3 });

  assert.deepEqual(results.map(result => result.index), [0, 1, 2]);
  assert.deepEqual(results.map(result => result.value), [30, 5, 20]);
});

test('空列表直接返回，不触发回调', async () => {
  let updates = 0;
  const results = await runPool([], async () => 'never', { onUpdate: () => { updates += 1; } });
  assert.equal(results.length, 0);
  assert.equal(updates, 0);
});

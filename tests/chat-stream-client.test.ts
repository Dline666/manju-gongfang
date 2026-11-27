// 前端流式解析：SSE 拼接、一次性 JSON 兜底、流内错误、取消。
import test from 'node:test';
import assert from 'node:assert/strict';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) },
  configurable: true,
});
const api = await import('../src/lib/api');
const store = await import('../src/store/studio');

/** 造一个 SSE 响应，并把每一块按帧推送，模拟真实流式。 */
function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

function stub(factory: () => Response | Promise<Response>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return factory();
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function seedKey() {
  store.setSettings(store.getStudio().settings);
  store.setKey('deepseek', 'fixture-key');
}

test('流式：多个增量块拼成累计正文，onDelta 每次拿到的是累计值', async () => {
  seedKey();
  const stubFetch = stub(() => sseResponse([
    '{"delta":"少年"}', '{"delta":"拾起断剑"}', '{"delta":"，雨还没停。"}', '{"done":true}',
  ]));
  try {
    const seen: string[] = [];
    const result = await api.callApiStream('chat', { provider: 'deepseek', key: 'k', model: 'm', prompt: 'p' }, text => seen.push(text));
    assert.equal(result.text, '少年拾起断剑，雨还没停。');
    assert.deepEqual(seen, ['少年', '少年拾起断剑', '少年拾起断剑，雨还没停。'], '必须是累计值，不是增量');
  } finally { stubFetch.restore(); }
});

test('流式：后端回一次性 JSON（Gemini 通道）也要收下', async () => {
  seedKey();
  const stubFetch = stub(() => Response.json({ ok: true, data: { text: '整段小说' } }));
  try {
    const seen: string[] = [];
    const result = await api.callApiStream('chat', { provider: 'deepseek', key: 'k', model: 'm', prompt: 'p' }, text => seen.push(text));
    assert.equal(result.text, '整段小说');
    assert.deepEqual(seen, ['整段小说']);
  } finally { stubFetch.restore(); }
});

test('流式：流内错误优先于已收到的半截内容', async () => {
  seedKey();
  const stubFetch = stub(() => sseResponse([
    '{"delta":"写到一半"}', '{"error":"insufficient_balance"}',
  ]));
  try {
    await assert.rejects(
      () => api.callApiStream('chat', { provider: 'deepseek', key: 'k', model: 'm', prompt: 'p' }, () => {}),
      (error: unknown) => error instanceof api.ApiError && error.code === 'insufficient_balance',
    );
  } finally { stubFetch.restore(); }
});

test('流式：一个字都没收到就结束，报 invalid_chat 而不是空回复', async () => {
  seedKey();
  const stubFetch = stub(() => sseResponse(['{"done":true}']));
  try {
    await assert.rejects(
      () => api.callApiStream('chat', { provider: 'deepseek', key: 'k', model: 'm', prompt: 'p' }, () => {}),
      (error: unknown) => error instanceof api.ApiError && error.code === 'invalid_chat',
    );
  } finally { stubFetch.restore(); }
});

test('流式：用户取消时归到 request_aborted，不冒充「结果未知」', async () => {
  seedKey();
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"开头"}\n\n'));
        // 永远不结束，等取消。
        signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const control = new AbortController();
    const promise = api.callApiStream('chat', { provider: 'deepseek', key: 'k', model: 'm', prompt: 'p' }, () => {}, control.signal);
    await new Promise(resolve => setTimeout(resolve, 20));
    control.abort();
    await assert.rejects(
      () => promise,
      (error: unknown) => error instanceof api.ApiError && error.code === 'request_aborted',
    );
  } finally { globalThis.fetch = original; }
});

test('流式：流内断线按「可能已计费」报，不静默当成正常结束', async () => {
  seedKey();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"delta":"开头"}\n\n'));
      controller.error(new TypeError('network error'));
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
  try {
    await assert.rejects(
      () => api.callApiStream('chat', { provider: 'deepseek', key: 'k', model: 'm', prompt: 'p' }, () => {}),
      (error: unknown) => error instanceof api.ApiError && error.code === 'submission_unknown',
    );
  } finally { globalThis.fetch = original; }
});
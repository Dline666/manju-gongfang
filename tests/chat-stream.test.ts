// 流式聊天的后端契约：SSE 解析、空闲/首块超时、流内错误、忽略 stream 的中转站。
// 与 providers.test.ts 同风格：注入 fetch 替身，绝不碰真实网络。
import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../functions/handler.ts";

mock.method(globalThis, "fetch", async () => { throw new Error("Real network disabled in provider tests"); });
after(() => mock.restoreAll());
const KEY = "fixture-not-a-real-credential";

function request(action: string, body: unknown = {}) {
  return new Request(`https://app.example/functions/v1/app?action=${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
function sse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
/** 把 handler 返回的 SSE 解析成事件数组，模拟前端读取。 */
async function events(response: Response): Promise<{ delta?: string; done?: boolean; error?: string; detail?: string }[]> {
  const text = await response.text();
  return text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5).trim()));
}
function chat(provider = "deepseek", extra: Record<string, unknown> = {}) {
  return request("chat", { provider, key: KEY, prompt: "写一段小说开头", ...extra });
}

test("chat 流式：把 OpenAI 兼容的增量拼成 delta，并以 done 收尾", async () => {
  const handle = createHandler({ fetch: async () => sse([
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"少年"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"拾起断剑"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ]) });
  const response = await handle(chat());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await events(response);
  assert.deepEqual(result.filter(item => item.delta).map(item => item.delta), ["少年", "拾起断剑"]);
  assert.deepEqual(result.at(-1), { done: true });
});

test("chat 流式：上游忽略 stream 直接回整段 JSON，也要当成一次性 delta", async () => {
  const handle = createHandler({ fetch: async () => Response.json({
    choices: [{ message: { role: "assistant", content: "整段正文" } }],
  }) });
  const result = await events(await handle(chat("openai-compatible", { baseUrl: "https://api.example.com/v1", model: "any-model" })));
  assert.deepEqual(result.filter(item => item.delta).map(item => item.delta), ["整段正文"]);
  assert.deepEqual(result.at(-1), { done: true });
});

test("chat 流式：流内夹错误对象时映射成前端认识的码，不静默当空正文", async () => {
  const handle = createHandler({ fetch: async () => sse([
    'data: {"error":{"message":"insufficient balance","code":"402"}}\n\n',
  ]) });
  const result = await events(await handle(chat()));
  assert.equal(result.at(-1)?.error, "insufficient_balance");
  assert.ok(!result.some(item => item.done), "出错时不能再发 done");
});

test("chat 流式：没有 [DONE] 但流正常结束，按完成处理", async () => {
  const handle = createHandler({ fetch: async () => sse([
    'data: {"choices":[{"delta":{"content":"半句"}}]}\n\n',
  ]) });
  const result = await events(await handle(chat()));
  assert.deepEqual(result.filter(item => item.delta).map(item => item.delta), ["半句"]);
  assert.deepEqual(result.at(-1), { done: true });
});

test("chat 流式：上游 4xx/5xx 在开流前就失败，仍然返回结构化错误而不是 200", async () => {
  const handle = createHandler({ fetch: async () => Response.json({ error: { message: "bad key" } }, { status: 401 }) });
  const response = await handle(chat());
  assert.notEqual(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.ok(!JSON.stringify(body).includes(KEY));
});

test("chat 流式：首块超时按 endpoint_timeout 报，而不是「结果未知、别重复付费」", async () => {
  // 永远不返回 body 的流：首块等不到。
  const handle = createHandler({
    timeouts: { firstByte: 5 },
    fetch: async () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  });
  const result = await events(await handle(chat()));
  assert.equal(result.at(-1)?.error, "endpoint_timeout");
});

test("chat 流式：中途停住超过空闲上限才断，写得慢但一直在写不会被砍", async () => {
  // 两块之间隔 30ms，空闲上限 15ms：确实超时。
  const encoder = new TextEncoder();
  const handle = createHandler({
    timeouts: { idle: 15, firstByte: 500 },
    fetch: async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"开头"}}]}\n\n'));
        await new Promise(resolve => setTimeout(resolve, 60));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  });
  const result = await events(await handle(chat()));
  assert.deepEqual(result.filter(item => item.delta).map(item => item.delta), ["开头"]);
  assert.equal(result.at(-1)?.error, "endpoint_timeout");
});

test("chat 流式：连续输出可以超过原来的 2 分钟总时长上限", async () => {
  // 每块 2ms，共 40 块：总耗时 80ms，但 generation 上限只有 10ms。
  // 只要「一直在写」，就不该被总时长砍掉——这正是原先把长篇写死的原因。
  const encoder = new TextEncoder();
  const handle = createHandler({
    timeouts: { generation: 10, idle: 500, firstByte: 500 },
    fetch: async () => new Response(new ReadableStream({
      async start(controller) {
        for (let i = 0; i < 40; i++) {
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"字"}}]}\n\n`));
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  });
  const result = await events(await handle(chat()));
  assert.equal(result.filter(item => item.delta).length, 40, "40 块必须全部到达");
  assert.deepEqual(result.at(-1), { done: true });
});

test("chat 流式：请求体里带上 stream:true，并沿用端点的鉴权头", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const handle = createHandler({ fetch: async (url, init) => {
    seen = { url, init };
    return sse(["data: [DONE]\n\n"]);
  } });
  await handle(chat("openai-compatible", { baseUrl: "https://api.example.com/v1", model: "any-model" }));
  const body = JSON.parse(String(seen?.init.body));
  assert.equal(body.stream, true);
  assert.equal(body.model, "any-model");
  assert.equal(seen?.url, "https://api.example.com/v1/chat/completions");
  assert.equal(new Headers(seen?.init.headers).get("authorization"), `Bearer ${KEY}`);
  assert.match(new Headers(seen?.init.headers).get("accept") ?? "", /event-stream/);
});

test("chat 流式：累计正文超过 JSON 上限就停，不无限吃内存", async () => {
  const encoder = new TextEncoder();
  const handle = createHandler({ fetch: async () => new Response(new ReadableStream({
    start(controller) {
      // LIMITS.json 是 2 MiB；这里一次塞 3 MiB 的单块，必然越界。
      controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${"字".repeat(1_100_000)}"}}]}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } }) });
  const result = await events(await handle(chat()));
  assert.equal(result.at(-1)?.error, "upstream_too_large");
});

test("chat 流式：Gemini 那条通道保持一次性返回，前端会按 JSON 收下", async () => {
  const handle = createHandler({ fetch: async () => Response.json({
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text: "小说正文" }] }],
  }) });
  const response = await handle(chat("gemini", { model: "gemini-4-hydrogen" }));
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.headers.get("content-type") ?? "", /event-stream/);
  const body = await response.json();
  assert.equal(body.data.text, "小说正文");
});
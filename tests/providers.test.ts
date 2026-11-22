// Run with Node >=24: node --test tests/providers.test.ts
// Credential-free fixtures stay outside the published functions directory.
import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, handler, LIMITS } from "../functions/handler.ts";

mock.method(globalThis, "fetch", async () => { throw new Error("Real network disabled in provider tests"); });
after(() => mock.restoreAll());
const KEY = "fixture-not-a-real-credential";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=";
const MINI_CDN = "https://video-product.cdn.minimax.io/inference_output/output.mp4?signature=fixture";
const SEED_CDN = "https://ark-content-generation-cn-beijing.tos-cn-beijing.volces.com/output.mp4?signature=fixture";
const VOICE = "Chinese (Mandarin)_Reliable_Executive";
const script = () => ({
  title: "测试剧本", characters: [{ name: "阿青", description: "身着蓝衣" }],
  scenes: [{ name: "街道", description: "  晨光下的青石街道\n屋檐投下长影。  " }],
  props: [{ name: "油纸伞", description: "旧油纸伞，伞柄刻有「青」字。" }],
  shots: Array.from({ length: 10 }, (_, i) => ({
    visual: `镜头${i + 1}`, camera: "缓慢推进", start: "晨光下的街道", action: "人物走向镜头", end: "人物抬头",
    duration: 9, dialogues: [{ speaker: "阿青", text: "你好。" }],
    characters: ["阿青"], scenes: ["街道"], props: i % 2 === 0 ? ["油纸伞"] : [],
  })),
});
const assets = () => {
  const value = script();
  return { characters: value.characters, scenes: value.scenes, props: value.props,
    shots: value.shots.map(({ characters, scenes, props }, i) => ({ number: i + 1, characters, scenes, props })),
  };
};
const ASSET_KINDS = ["characters", "scenes", "props"] as const;
const gemini = (value: unknown = script()) => ({ status: "completed", steps: [
  { type: "thought", content: [{ type: "text", text: "This is not the final JSON" }] },
  { type: "model_output", content: [{ type: "text", text: JSON.stringify(value) }] },
] });
const deepseek = (value: unknown = script()) => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } }] });
const miniSuccess = { base_resp: { status_code: 0, status_msg: "success" } };
const statusBody = (provider: string, status = "succeeded", url = provider === "minimax" ? MINI_CDN : SEED_CDN) =>
  provider === "minimax" ? { task: { id: "task-1", status, content: { url } } } : { id: "task-1", status, content: { video_url: url } };
function request(action: string, body: unknown = {}, options: RequestInit = {}) {
  return new Request(`https://app.example/functions/v1/app?action=${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...options,
  });
}
function input(provider: string, extra: Record<string, unknown> = {}) { return { provider, key: KEY, ...extra }; }
function video(provider: string, extra: Record<string, unknown> = {}) {
  return input(provider, { prompt: "固定视频模板", duration: 9, images: [], ...extra });
}
type Call = { url: string; init: RequestInit; headers: Headers; body?: Record<string, unknown> };
function fixture(responses: (unknown | Response)[], options: Parameters<typeof createHandler>[0] = {}) {
  const calls: Call[] = [];
  const handle = createHandler({
    resolveHost: async () => ["8.8.8.8", "2606:4700:4700::1111"], ...options,
    fetch: async (url, init) => {
      calls.push({ url, init, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined });
      assert.ok(responses.length > 0, "No retries or unexpected upstream calls");
      const response = responses.shift();
      return response instanceof Response ? response : Response.json(response);
    },
  });
  return { handle, calls };
}
async function error(response: Response, code: string, status: number) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.deepEqual(result, { ok: false, error: code });
  assert.ok(!JSON.stringify(result).includes(KEY));
}
async function success(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result).sort(), ["data", "ok"]);
  return result.data;
}
function streamRequest(stream: ReadableStream<Uint8Array>, signal?: AbortSignal, headers?: HeadersInit) {
  return request("image", {}, { body: stream, duplex: "half", signal, headers: headers ?? { "Content-Type": "application/json" } } as RequestInit);
}
function mp4(body: BodyInit = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])) {
  return new Response(body, { headers: { "Content-Type": "video/mp4" } });
}

// Handler boundary: query routing must survive the platform's physical-name rewrite.
test("health is GET-only, query-routed, stateless and enveloped", async () => {
  const response = await handler(new Request("https://app.example/functions/v1/physical-name?action=health"));
  assert.deepEqual(await success(response), { status: "healthy" });
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
    const denied = await handler(new Request("https://app.example/?action=health", { method }));
    assert.equal(denied.headers.get("allow"), "GET, POST");
    await error(denied, "method_not_allowed", 405);
  }
  await error(await handler(new Request("https://app.example/?action=script")), "method_not_allowed", 405);
});
test("rejects missing, duplicate, unknown and extra query fields", async () => {
  for (const query of ["", "?action=health&action=health", `?action=health&key=${KEY}`]) {
    await error(await handler(new Request(`https://app.example/${query}`)), "invalid_action", 400);
  }
  await error(await handler(request("unknown")), "unknown_action", 404);
  await error(await handler(request("__proto__")), "unknown_action", 404);
});
test("JSON media type, encoding, JSON syntax and object are mandatory", async () => {
  const { handle, calls } = fixture([]);
  for (const headers of [{ "Content-Type": "text/plain" }, { "Content-Type": "application/json", "Content-Encoding": "gzip" }] as HeadersInit[]) {
    await error(await handle(request("image", {}, { headers })), "unsupported_media_type", 415);
  }
  await error(await handle(request("image", {}, { body: "{" })), "invalid_json", 400);
  for (const body of [null, [], "string", 1]) await error(await handle(request("image", body)), "invalid_input", 400);
  assert.equal(calls.length, 0);
});
test("rejects oversized declared, chunked and multibyte bodies before any upstream call", async () => {
  const { handle, calls } = fixture([]);
  await error(await handle(request("image", {}, { headers: { "Content-Type": "application/json", "Content-Length": String(LIMITS.body + 1) } })), "request_too_large", 413);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(LIMITS.body)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  await error(await handle(streamRequest(stream)), "request_too_large", 413);
  assert.ok(cancelled);
  const multibyte = JSON.stringify(input("openai", { prompt: "汉".repeat(Math.ceil(LIMITS.body / 3)) }));
  await error(await handle(request("image", {}, { body: multibyte })), "request_too_large", 413);
  assert.equal(calls.length, 0);
});
test("request body timeout cancels slow uploads without submitting", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const { handle, calls } = fixture([], { timeouts: { body: 5 } });
  await error(await handle(streamRequest(stream)), "request_timeout", 408);
  assert.equal(calls.length, 0);
  assert.ok(cancelled);
});
test("BYOK validation, unknown parameters, provider/model mismatch never reach a provider", async () => {
  const { handle, calls } = fixture([]);
  for (const key of [undefined, "", "a\r\nInjected: true", " spaced ", "密钥", "x".repeat(4097)]) {
    await error(await handle(request("image", { provider: "openai", prompt: "test", key })), "invalid_key", 400);
  }
  for (const extra of [{ baseURL: "https://evil.example" }, { url: "https://evil.example" }, { n: 5 }, { headers: {} }]) {
    await error(await handle(request("image", input("openai", { prompt: "test", ...extra }))), "invalid_input", 400);
  }
  await error(await handle(request("image", input("deepseek", { prompt: "test" }))), "invalid_provider", 400);
  await error(await handle(request("image", input("openai", { prompt: " " }))), "invalid_prompt", 400);
  await error(await handle(request("image", input("openai", { prompt: "test", model: "https://evil.example" }))), "invalid_model", 400);
  assert.equal(calls.length, 0);
});

test("Gemini uses Interactions REST, revision header, schema and final model_output only", async () => {
  const source = gemini();
  const output = JSON.stringify(script());
  source.steps[1].content = [{ type: "text", text: output.slice(0, 80) }, { type: "text", text: output.slice(80) }];
  const { handle, calls } = fixture([source]);
  assert.deepEqual(await success(await handle(request("script", input("gemini", { prompt: "固定剧本模板" })))), script());
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(call.headers.get("x-goog-api-key"), KEY);
  assert.equal(call.headers.get("api-revision"), "2026-05-20");
  assert.equal(call.headers.get("authorization"), null);
  assert.equal(call.body?.model, "gemini-4-hydrogen");
  assert.equal(call.body?.store, false);
  assert.equal(call.body?.stream, false);
  assert.equal(call.body?.input, "固定剧本模板");
  const format = call.body?.response_format as Record<string, unknown>;
  assert.equal(format.type, "text"); assert.equal(format.mime_type, "application/json"); assert.ok(format.schema);
  assert.ok(!JSON.stringify(call.body).includes(KEY));
  assert.equal(call.init.redirect, "manual");
});
test("Gemini rejects SDK-only output_text, partial interactions and thoughts-only results", async () => {
  for (const response of [
    { status: "completed", output_text: JSON.stringify(script()) },
    { ...gemini(), status: "requires_continuation" },
    { status: "completed", steps: [{ type: "thought", content: [{ type: "text", text: JSON.stringify(script()) }] }] },
  ]) {
    const { handle, calls } = fixture([response]);
    await error(await handle(request("script", input("gemini", { prompt: "test" }))), "invalid_script", 502);
    assert.equal(calls.length, 1);
  }
});
test("DeepSeek uses chat/completions json_object and a system instruction containing json", async () => {
  const { handle, calls } = fixture([deepseek()]);
  assert.deepEqual(await success(await handle(request("script", input("deepseek", { prompt: "固定剧本模板" })))), script());
  const call = calls[0];
  assert.equal(call.url, "https://api.deepseek.com/chat/completions");
  assert.equal(call.body?.model, "deepseek-flash");
  assert.deepEqual(call.body?.response_format, { type: "json_object" });
  const messages = call.body?.messages as { role: string; content: string }[];
  assert.equal(messages[0].role, "system"); assert.match(messages[0].content, /json/);
  assert.deepEqual(messages[1], { role: "user", content: "固定剧本模板" });
  assert.equal(call.headers.get("authorization"), `Bearer ${KEY}`);
});
test("script validation rejects bad count, timing, fields, dialogue and optional character schema without retry", async () => {
  const mutations: ((value: ReturnType<typeof script>) => unknown)[] = [
    (value) => ({ ...value, shots: value.shots.slice(1) }),
    (value) => { value.shots[0].duration = 8; return value; },
    (value) => { value.shots[0].duration = 9.5; value.shots[1].duration = 8.5; return value; },
    (value) => { value.shots[0].visual = ""; return value; },
    (value) => ({ ...value, characters: [{ name: "x" }] }),
    (value) => ({ ...value, shots: value.shots.map((s) => ({ ...s, start: 0 })) }),
    (value) => ({ ...value, shots: value.shots.map((s) => ({ ...s, dialogues: [{ speaker: "x" }] })) }),
    () => null,
  ];
  for (const provider of ["gemini", "deepseek"]) for (const mutate of mutations) {
    const value = mutate(script());
    const { handle, calls } = fixture([provider === "gemini" ? gemini(value) : deepseek(value)]);
    await error(await handle(request("script", input(provider, { prompt: "test" }))), "invalid_script", 502);
    assert.equal(calls.length, 1);
  }
});
test("script rejects markdown, malformed JSON and truncated finish_reason", async () => {
  for (const raw of ["", "{broken", "```json\n" + JSON.stringify(script()) + "\n```", KEY]) {
    const { handle, calls } = fixture([{ choices: [{ finish_reason: "stop", message: { content: raw } }] }]);
    await error(await handle(request("script", input("deepseek", { prompt: "test" }))), "invalid_script", 502);
    assert.equal(calls.length, 1);
  }
  const { handle } = fixture([{ choices: [{ finish_reason: "length", message: { content: JSON.stringify(script()) } }] }]);
  await error(await handle(request("script", input("deepseek", { prompt: "test" }))), "invalid_script", 502);
});
test("valid script permits absent metadata and empty dialogues and strips unexpected upstream fields", async () => {
  const value = { shots: script().shots.map(({ characters: _characters, scenes: _scenes, props: _props, ...s }) => ({ ...s, dialogues: [], internal: KEY })), extra: KEY };
  const { handle } = fixture([deepseek(value)]);
  const result = await success(await handle(request("script", input("deepseek", { prompt: "test", model: "deepseek-custom" }))));
  assert.deepEqual(result, { shots: value.shots.map(({ internal: _internal, ...s }) => s) });
});

test("script and extraction schemas require bounded category declarations and shot references", async () => {
  for (const action of ["script", "extract-assets"]) for (const provider of ["gemini", "deepseek"]) {
    const value = action === "script" ? script() : assets();
    const { handle, calls } = fixture([provider === "gemini" ? gemini(value) : deepseek(value)]);
    assert.deepEqual(await success(await handle(request(action, input(provider, { prompt: "固定描述" })))), value);
    const body = calls[0].body!;
    const instruction = provider === "gemini" ? body.system_instruction as string : (body.messages as { content: string }[])[0].content;
    const schema = JSON.parse(instruction.split(" Schema: ")[1]);
    if (provider === "gemini") assert.deepEqual((body.response_format as { schema: unknown }).schema, schema);
    for (const kind of ASSET_KINDS) {
      assert.ok(schema.required.includes(kind));
      assert.ok(schema.properties.shots.items.required.includes(kind));
      const list = schema.properties[kind];
      assert.equal(list.type, "array"); assert.equal(list.maxItems, 30);
      assert.deepEqual(list.items.required, ["name", "description"]);
      assert.equal(list.items.properties.name.maxLength, 100);
      assert.equal(list.items.properties.description.maxLength, 4000);
      const refs = schema.properties.shots.items.properties[kind];
      assert.equal(refs.type, "array"); assert.equal(refs.maxItems, 30);
      assert.equal(refs.items.maxLength, 100); assert.equal(refs.uniqueItems, true);
    }
    assert.match(instruction, /EXACTLY/);
    if (action === "extract-assets") {
      assert.equal(schema.properties.shots.minItems, 1); assert.equal(schema.properties.shots.maxItems, 100);
      assert.deepEqual(schema.properties.shots.items.properties.number, { type: "integer", minimum: 1, maximum: 100 });
      assert.match(instruction, /Only extract visual assets/);
      assert.match(instruction, /do not rewrite shots or dialogues/);
      assert.match(instruction, /do not invent details/);
      assert.match(instruction, /empty arrays when absent/);
      assert.ok(!instruction.includes("Exactly 10 shots"));
    }
  }
});
test("script keeps independently missing metadata absent rather than inventing assets", async () => {
  for (const kind of ASSET_KINDS) for (const provider of ["gemini", "deepseek"]) {
    const value = { ...script(), [kind]: undefined, shots: script().shots.map((shot) => ({ ...shot, [kind]: undefined })) };
    const { handle } = fixture([provider === "gemini" ? gemini(value) : deepseek(value)]);
    const result = await success(await handle(request("script", input(provider, { prompt: "test" }))));
    assert.deepEqual(result, JSON.parse(JSON.stringify(value)));
    assert.ok(!Object.hasOwn(result, kind));
    assert.ok(result.shots.every((shot: Record<string, unknown>) => !Object.hasOwn(shot, kind)));
  }
});
test("script permits declared assets without shot lists and explicit empty lists without declarations", async () => {
  const values = [
    { ...script(), shots: script().shots.map(({ characters: _characters, scenes: _scenes, props: _props, ...shot }) => shot) },
    { shots: script().shots.map((shot) => ({ ...shot, characters: [], scenes: [], props: [] })) },
  ];
  for (const value of values) {
    const { handle } = fixture([deepseek(value)]);
    assert.deepEqual(await success(await handle(request("script", input("deepseek", { prompt: "test" })))), value);
  }
});
test("both actions reject malformed, duplicate, oversized and cross-category asset lists without retries", async () => {
  for (const action of ["script", "extract-assets"]) for (const provider of ["gemini", "deepseek"]) for (const kind of ASSET_KINDS) {
    const value = action === "script" ? script() : assets();
    const declared = value[kind][0];
    const otherKind = kind === "characters" ? "scenes" : "characters";
    const invalid: unknown[] = [
      ...[null, {}, "asset", [null], ["asset"], [{ name: "x" }], [{ description: "x" }],
        [{ name: "", description: "x" }], [{ name: " ", description: "x" }], [{ name: 1, description: "x" }],
        [{ name: "x".repeat(101), description: "x" }], [{ name: "x", description: null }],
        [{ name: "x", description: " " }], [{ name: "x", description: "x".repeat(4001) }],
        [declared, { ...declared, description: "不同描述，同名" }],
        Array.from({ length: 31 }, (_, i) => ({ name: String(i), description: "x" })),
      ].map((list) => ({ ...value, [kind]: list })),
      ...[null, {}, declared.name, [null], [1], [declared], [""], [" "], ["x".repeat(101)],
        ["未声明"], [value[otherKind][0].name], [declared.name, declared.name], Array(31).fill(declared.name),
      ].map((list) => ({ ...value, shots: value.shots.map((shot, i) => i === 0 ? { ...shot, [kind]: list } : shot) })),
      { ...value, [kind]: undefined },
      { ...value, [kind]: [] },
    ];
    for (const bad of invalid) {
      const { handle, calls } = fixture([provider === "gemini" ? gemini(bad) : deepseek(bad)]);
      await error(await handle(request(action, input(provider, { prompt: "test" }))), action === "script" ? "invalid_script" : "invalid_assets", 502);
      assert.equal(calls.length, 1);
    }
  }
});
test("both actions preserve fixed descriptions exactly and accept inclusive asset bounds and names shared across kinds", async () => {
  for (const action of ["script", "extract-assets"]) for (const provider of ["gemini", "deepseek"]) {
    const value = action === "script" ? script() : assets();
    for (const kind of ASSET_KINDS) {
      value[kind] = Array.from({ length: 30 }, (_, i) => ({ name: String(i).padEnd(100, "名"), description: "  固定描述\r\n「不改写」".padEnd(3998, "描") + "  " }));
      for (const shot of value.shots) shot[kind] = value[kind].map((asset) => asset.name);
    }
    const { handle, calls } = fixture([provider === "gemini" ? gemini(value) : deepseek(value)]);
    assert.deepEqual(await success(await handle(request(action, input(provider, { prompt: "test" })))), value);
    assert.equal(calls.length, 1);
  }
});
test("extract-assets uses the same official paid providers, credentials and privacy settings", async () => {
  for (const provider of ["gemini", "deepseek"]) {
    const value = assets();
    const { handle, calls } = fixture([provider === "gemini" ? gemini(value) : deepseek(value)]);
    const prompt = "仅提取已有剧本资产，保留固定描述。";
    assert.deepEqual(await success(await handle(request("extract-assets", input(provider, { prompt, model: `${provider}-custom` }), {
      headers: { "Content-Type": "application/json", Cookie: "private=cookie", Authorization: "Bearer visitor" },
    }))), value);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.init.method, "POST"); assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.credentials, "omit"); assert.equal(call.init.cache, "no-store");
    assert.equal(call.headers.get("cookie"), null);
    assert.ok(!JSON.stringify(call.body).includes(KEY));
    assert.equal(call.body?.stream, false); assert.equal(call.body?.model, `${provider}-custom`);
    if (provider === "gemini") {
      assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
      assert.equal(call.headers.get("x-goog-api-key"), KEY); assert.equal(call.headers.get("authorization"), null);
      assert.equal(call.headers.get("api-revision"), "2026-05-20");
      assert.equal(call.body?.store, false); assert.equal(call.body?.input, prompt);
      const format = call.body?.response_format as Record<string, unknown>;
      assert.equal(format.type, "text"); assert.equal(format.mime_type, "application/json");
    } else {
      assert.equal(call.url, "https://api.deepseek.com/chat/completions");
      assert.equal(call.headers.get("authorization"), `Bearer ${KEY}`); assert.equal(call.headers.get("x-goog-api-key"), null);
      assert.deepEqual(call.body?.response_format, { type: "json_object" });
      assert.deepEqual((call.body?.messages as unknown[])[1], { role: "user", content: prompt });
    }
  }
});
test("extract-assets accepts 1–100 shots with empty arrays, preserves numbering/order and strips unrelated fields", async () => {
  for (const provider of ["gemini", "deepseek"]) for (const count of [1, 100]) {
    const value = { characters: [], scenes: [], props: [], shots: Array.from({ length: count }, (_, i) => ({ number: 100 - i, characters: [], scenes: [], props: [] })) };
    const extra = { ...value, dialogues: KEY, shots: value.shots.map((shot) => ({ ...shot, visual: KEY, dialogues: KEY })) };
    const { handle } = fixture([provider === "gemini" ? gemini(extra) : deepseek(extra)]);
    assert.deepEqual(await success(await handle(request("extract-assets", input(provider, { prompt: "test" })))), value);
  }
});
test("extract-assets requires all three lists and valid unique shot numbers", async () => {
  const value = assets();
  const invalid: unknown[] = [null, [], {}, script(),
    ...[undefined, null, {}, [], Array.from({ length: 101 }, (_, i) => ({ ...value.shots[0], number: i + 1 })), [null], ["shot"]].map((shots) => ({ ...value, shots })),
    ...[undefined, null, "1", 0, 101, 1.5].map((number) => ({ ...value, shots: [{ ...value.shots[0], number }] })),
    { ...value, shots: [value.shots[0], value.shots[0]] },
    ...ASSET_KINDS.flatMap((kind) => [
      { ...value, [kind]: undefined, shots: [{ ...value.shots[0], [kind]: [] }] },
      { ...value, shots: [{ ...value.shots[0], [kind]: undefined }] },
    ]),
  ];
  for (const provider of ["gemini", "deepseek"]) for (const bad of invalid) {
    const { handle, calls } = fixture([provider === "gemini" ? gemini(bad) : deepseek(bad)]);
    await error(await handle(request("extract-assets", input(provider, { prompt: "test" }))), "invalid_assets", 502);
    assert.equal(calls.length, 1);
  }
});
test("extract-assets rejects malformed JSON and incomplete provider outputs with invalid_assets", async () => {
  for (const provider of ["gemini", "deepseek"]) {
    const responses: unknown[] = provider === "gemini"
      ? [{ status: "completed", output_text: JSON.stringify(assets()) }, { ...gemini(assets()), status: "requires_continuation" }, { status: "completed", steps: [] }]
      : [{ choices: [] }, { choices: [{ finish_reason: "length", message: { content: JSON.stringify(assets()) } }] }];
    for (const raw of ["", "{broken", "```json\n" + JSON.stringify(assets()) + "\n```", KEY]) {
      responses.push(provider === "gemini"
        ? { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: raw }] }] }
        : { choices: [{ finish_reason: "stop", message: { content: raw } }] });
    }
    for (const response of responses) {
      const { handle, calls } = fixture([response]);
      await error(await handle(request("extract-assets", input(provider, { prompt: "test" }))), "invalid_assets", 502);
      assert.equal(calls.length, 1);
    }
  }
});
test("extract-assets allows only provider/key/model/prompt and validates before submitting", async () => {
  const { handle, calls } = fixture([]);
  for (const provider of ["openai", "minimax", "seedance", undefined]) {
    await error(await handle(request("extract-assets", { provider, key: KEY, prompt: "test" })), "invalid_provider", 400);
  }
  for (const provider of ["gemini", "deepseek"]) {
    for (const extra of [{ shots: [] }, { characters: [] }, { url: "https://evil.example" }, { baseURL: "https://evil.example" }, { headers: {} }]) {
      await error(await handle(request("extract-assets", input(provider, { prompt: "test", ...extra }))), "invalid_input", 400);
    }
    for (const prompt of [undefined, "", " ", "x".repeat(32001)]) {
      await error(await handle(request("extract-assets", input(provider, { prompt }))), "invalid_prompt", 400);
    }
    await error(await handle(request("extract-assets", input(provider, { prompt: "test", key: "bad\r\nkey" }))), "invalid_key", 400);
    await error(await handle(request("extract-assets", input(provider, { prompt: "test", model: provider === "gemini" ? "deepseek-flash" : "gemini-4-hydrogen" }))), "invalid_model", 400);
  }
  assert.equal(calls.length, 0);
});

test("OpenAI returns PNG b64_json; n=1, output_format=png, no unsupported response_format", async () => {
  const { handle, calls } = fixture([{ data: [{ b64_json: PNG, revised_prompt: KEY }] }]);
  assert.deepEqual(await success(await handle(request("image", input("openai", { prompt: "固定图片模板" })))), { base64: PNG, mime: "image/png" });
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/generations");
  assert.deepEqual(calls[0].body, { model: "gpt-image-2.6-sunburst", prompt: "固定图片模板", n: 1, output_format: "png" });
});
test("Seedream uses Ark PNG base64, 2K and exact default/catalog/custom model IDs without unsupported options", async () => {
  for (const model of [undefined, "doubao-seedream-5-5-261028", "doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-flash-260915", "doubao-seedream-custom.v1_test", "ep-fixture.v1_test"]) {
    const { handle, calls } = fixture([{ data: [{ b64_json: PNG, revised_prompt: KEY }] }]);
    assert.deepEqual(await success(await handle(request("image", input("seedream", { prompt: "固定图片模板", model })))), { base64: PNG, mime: "image/png" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://ark.cn-beijing.volces.com/api/v3/images/generations");
    assert.equal(calls[0].init.method, "POST"); assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.credentials, "omit"); assert.equal(calls[0].init.cache, "no-store");
    assert.equal(calls[0].headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(calls[0].body, {
      model: model ?? "doubao-seedream-5-5-261028", prompt: "固定图片模板", size: "2K", response_format: "b64_json", output_format: "png",
    });
  }
});
test("Hugging Face uses the new router endpoint and returns raw PNG bytes", async () => {
  const pngBytes = Buffer.from(PNG, "base64");
  for (const model of [undefined, "black-forest-labs/FLUX.1-schnell", "stabilityai/stable-diffusion-xl-base-1.0"]) {
    const { handle, calls } = fixture([new Response(pngBytes, { headers: { "Content-Type": "image/png" } })]);
    assert.deepEqual(await success(await handle(request("image", input("huggingface", { prompt: "固定图片模板", model })))), { base64: PNG, mime: "image/png" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://router.huggingface.co/hf-inference/models/${model ?? "black-forest-labs/FLUX.1-schnell"}`);
    assert.equal(calls[0].headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(calls[0].body, { inputs: "固定图片模板", parameters: model === "stabilityai/stable-diffusion-xl-base-1.0"
      ? { guidance_scale: 7.5, num_inference_steps: 25 }
      : { guidance_scale: 0, num_inference_steps: 4, max_sequence_length: 256 } });
  }
});
test("Hugging Face rejects other models and non-image payloads without another fetch", async () => {
  const { handle, calls } = fixture([]);
  for (const model of ["black-forest-labs/FLUX.1-dev", "gpt-image-2.6-sunburst", "doubao-seedream-5-5-261028", "owner/model/path", "model with-space"]) {
    await error(await handle(request("image", input("huggingface", { prompt: "test", model }))), "invalid_model", 400);
  }
  assert.equal(calls.length, 0);
  const { handle: handle2, calls: calls2 } = fixture([Response.json({ error: "Model is loading" })]);
  await error(await handle2(request("image", input("huggingface", { prompt: "test" }))), "invalid_upstream_response", 502);
  assert.equal(calls2.length, 1);
});
test("image model is configurable and malformed/URL-only/non-PNG/multiple-image payloads are rejected without another fetch", async () => {
  const { handle, calls } = fixture([{ data: [{ b64_json: PNG }] }]);
  await success(await handle(request("image", input("openai", { prompt: "test", model: "gpt-image-2.6-flare" }))));
  assert.equal(calls[0].body?.model, "gpt-image-2.6-flare");
  for (const provider of ["openai", "seedream"]) for (const data of [
    undefined, null, {}, [], [null], [{ url: "https://evil.example/image" }], [{ url: "https://127.0.0.1/image" }],
    [{ b64_json: "!@#$" }], [{ b64_json: "YWJjZA==" }], [{ b64_json: PNG.slice(1) }], [{ b64_json: "data:image/png;base64," + PNG }],
    [{ b64_json: PNG }, { b64_json: PNG }],
  ]) {
    const { handle, calls } = fixture([{ data }]);
    await error(await handle(request("image", input(provider, { prompt: "test" }))), "invalid_upstream_response", 502);
    assert.equal(calls.length, 1);
  }
});
test("image channels reject wrong providers/models and unsupported parameters before any submission", async () => {
  const { handle, calls } = fixture([]);
  for (const provider of ["minimax", "seedance", "free", "seedream-international", undefined]) {
    await error(await handle(request("image", { provider, key: KEY, prompt: "test" })), "invalid_provider", 400);
  }
  for (const provider of ["openai", "seedream"]) {
    for (const model of ["", "https://evil.example", "doubao-seedance-2-5-260628", "MiniMax-H3",
      provider === "openai" ? "doubao-seedream-5-5-261028" : "gpt-image-2.6-sunburst",
      "doubao-seedream-", "ep-", "ep-fixture/path", "ep-fixture?key=x", "ep-fixture with-space", "ep-" + "x".repeat(126),
    ]) await error(await handle(request("image", input(provider, { prompt: "test", model }))), "invalid_model", 400);
    for (const prompt of [undefined, "", " ", "x".repeat(32001)]) {
      await error(await handle(request("image", input(provider, { prompt }))), "invalid_prompt", 400);
    }
    for (const extra of [{ baseURL: "https://evil.example" }, { n: 2 }, { sequential_image_generation: "auto" }, { output_format: "jpeg" }, { response_format: "url" }]) {
      await error(await handle(request("image", input(provider, { prompt: "test", ...extra }))), "invalid_input", 400);
    }
  }
  for (const action of ["script", "extract-assets", "voices", "speech", "video-create", "video-status", "video-download"]) {
    await error(await handle(request(action, input("seedream"))), "invalid_provider", 400);
  }
  assert.equal(calls.length, 0);
});
test("voices lists only real upstream system IDs and names", async () => {
  const { handle, calls } = fixture([{ ...miniSuccess, system_voice: [
    { voice_id: VOICE, voice_name: "Steady Executive", description: [KEY] },
    { voice_id: "Chinese (Mandarin)_News_Anchor", voice_name: "News Anchor (Female)" },
  ], voice_cloning: [{ voice_id: "ignored-clone" }] }]);
  assert.deepEqual(await success(await handle(request("voices", input("minimax")))), [
    { id: VOICE, name: "Steady Executive" }, { id: "Chinese (Mandarin)_News_Anchor", name: "News Anchor (Female)" },
  ]);
  assert.equal(calls[0].url, "https://api.minimax.cn/v1/get_voice");
  assert.deepEqual(calls[0].body, { voice_type: "system" });
});
function wav() {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(38, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(32000, 24); bytes.writeUInt32LE(64000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(2, 40);
  return bytes;
}
test("speech exact mapping preserves voice ID and returns hex-decoded no-store WAV", async () => {
  const bytes = wav();
  const { handle, calls } = fixture([{ ...miniSuccess, data: { audio: bytes.toString("hex"), status: 2 } }]);
  const response = await handle(request("speech", input("minimax", { text: "你好", voiceId: VOICE, speed: 1.1 })));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(calls[0].url, "https://api.minimax.cn/v1/t2a_v2");
  assert.deepEqual(calls[0].body, {
    model: "speech-2.8-hd", text: "你好", stream: false, output_format: "hex",
    voice_setting: { voice_id: VOICE, speed: 1.1 }, audio_setting: { format: "wav", sample_rate: 32000, channel: 1 }, language_boost: "Chinese",
  });
});
test("MiniMax HTTP 200 base_resp errors are never treated as success", async () => {
  for (const [code, stable, http] of [[1004, "provider_auth_failed", 401], [1008, "insufficient_balance", 402], [1002, "rate_limited", 429], [2013, "provider_rejected", 422]] as const) {
    for (const action of ["voices", "speech", "video-create", "video-status"]) {
      const { handle, calls } = fixture([{ base_resp: { status_code: code, status_msg: KEY }, data: { audio: wav().toString("hex") } }]);
      const body = action === "speech" ? input("minimax", { text: "你好", voiceId: VOICE }) : action === "video-create" ? video("minimax") : action === "video-status" ? input("minimax", { taskId: "task-1" }) : input("minimax");
      await error(await handle(request(action, body)), stable, http);
      assert.equal(calls.length, 1);
    }
  }
});
test("speech input, hex and WAV validation fail closed", async () => {
  const base = input("minimax", { text: "你好", voiceId: VOICE });
  const { handle, calls } = fixture([]);
  for (const speed of [0.49, 2.01, "1", null]) await error(await handle(request("speech", { ...base, speed })), "invalid_speed", 400);
  await error(await handle(request("speech", { ...base, voiceId: "" })), "invalid_voice", 400);
  await error(await handle(request("speech", { ...base, text: "" })), "invalid_text", 400);
  assert.equal(calls.length, 0);
  for (const audio of ["", "0", "zz", "0000", "https://evil.example/audio.wav"]) {
    const { handle } = fixture([{ ...miniSuccess, data: { audio } }]);
    await error(await handle(request("speech", base)), "invalid_upstream_response", 502);
  }
  const missingBase = fixture([{ data: { audio: wav().toString("hex") } }]);
  await error(await missingBase.handle(request("speech", base)), "invalid_upstream_response", 502);
});

test("both video providers map text/reference/first-last content, defaults, resolution and silent audio", async () => {
  for (const provider of ["seedance", "minimax"]) for (const refs of [
    [], [{ url: `data:image/png;base64,${PNG}`, role: "first_frame" }],
    [{ url: "https://images.example.org/start.png", role: "first_frame" }, { url: "https://images.example.org/end.png", role: "last_frame" }],
    Array.from({ length: 9 }, () => ({ url: `data:image/png;base64,${PNG}`, role: "reference_image" })),
  ]) {
    const { handle, calls } = fixture([provider === "seedance" ? { id: "task-1" } : { task_id: "task-1" }]);
    assert.deepEqual(await success(await handle(request("video-create", video(provider, { images: refs })))), { id: "task-1", status: "queued" });
    const call = calls[0];
    assert.equal(call.url, provider === "seedance" ? "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks" : "https://api.minimax.cn/v2/video_generation");
    assert.deepEqual(call.body, {
      model: provider === "seedance" ? "doubao-seedance-2-0-fast-260128" : "MiniMax-H3", duration: 9, generate_audio: false,
      resolution: provider === "seedance" ? "720p" : "768P",
      ratio: provider === "minimax" && refs.some((r) => r.role === "first_frame") ? "adaptive" : "9:16",
      content: [{ type: "text", text: "固定视频模板" }, ...refs.map((r) => ({ type: "image_url", image_url: { url: r.url }, role: r.role }))],
    });
    assert.equal(calls.length, 1);
  }
});
test("every selected video model is forwarded unchanged with adaptive frames only for Seedance 2.5 and MiniMax", async () => {
  for (const [provider, model] of [
    ["seedance", "doubao-seedance-2-0-fast-260128"], ["seedance", "doubao-seedance-2-5-260628"],
    ["seedance", "doubao-seedance-2-0-260128"], ["seedance", "doubao-seedance-2-0-mini-260615"], ["minimax", "MiniMax-H3"],
  ]) for (const duration of [4, 15]) for (const refs of [
    [], [{ url: `data:image/png;base64,${PNG}`, role: "reference_image" }],
    [{ url: `data:image/png;base64,${PNG}`, role: "first_frame" }],
    [{ url: `data:image/png;base64,${PNG}`, role: "first_frame" }, { url: `data:image/png;base64,${PNG}`, role: "last_frame" }],
  ]) {
    const { handle, calls } = fixture([provider === "seedance" ? { id: "task-1" } : { task_id: "task-1" }]);
    assert.deepEqual(await success(await handle(request("video-create", video(provider, { model, duration, images: refs })))), { id: "task-1", status: "queued" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, provider === "seedance" ? "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks" : "https://api.minimax.cn/v2/video_generation");
    assert.deepEqual(calls[0].body, {
      model, duration, generate_audio: false, resolution: provider === "seedance" ? "720p" : "768P",
      ratio: refs.some((r) => r.role === "first_frame") && (provider === "minimax" || model.startsWith("doubao-seedance-2-5-")) ? "adaptive" : "9:16",
      content: [{ type: "text", text: "固定视频模板" }, ...refs.map((r) => ({ type: "image_url", image_url: { url: r.url }, role: r.role }))],
    });
  }
});
test("video provider/model mismatches and MiniMax international selectors never submit", async () => {
  const { handle, calls } = fixture([]);
  for (const [provider, model] of [["seedance", "MiniMax-H3"], ["seedance", "doubao-seedream-5-5-261028"], ["minimax", "doubao-seedance-2-5-260628"]]) {
    await error(await handle(request("video-create", video(provider, { model }))), "invalid_model", 400);
  }
  for (const action of ["voices", "speech", "video-create", "video-status", "video-download"]) {
    await error(await handle(request(action, input("minimax-international"))), "invalid_provider", 400);
    for (const extra of [{ region: "international" }, { baseURL: "https://api.minimax.io" }]) {
      await error(await handle(request(action, input("minimax", extra))), "invalid_input", 400);
    }
  }
  assert.equal(calls.length, 0);
});
test("video rejects noninteger/out-of-range duration, mixed/duplicate frames, too many refs and invalid image URLs", async () => {
  const { handle, calls } = fixture([]);
  const img = (role: string, url = `data:image/png;base64,${PNG}`) => ({ role, url });
  for (const provider of ["seedance", "minimax"]) {
    for (const duration of [3, 16, 4.5, "9", null]) await error(await handle(request("video-create", video(provider, { duration }))), "invalid_duration", 400);
    for (const images of [undefined, [img("first_frame"), img("reference_image")], [img("last_frame")], [img("first_frame"), img("first_frame")], [img("bad_role")], Array.from({ length: 10 }, () => img("reference_image")),
      [img("first_frame", "data:image/svg+xml;base64,PHN2Zz4=")], [img("first_frame", "data:image/png;base64,broken")],
      ...["http://example.com/a.png", "https://127.0.0.1/a.png", "https://2130706433/a.png", "https://[::1]/a.png", "https://metadata.internal/a.png", "https://user:pass@example.com/a.png", "file:///a.png", "javascript:alert(1)"].map((url) => [img("first_frame", url)]),
    ]) await error(await handle(request("video-create", video(provider, { images }))), "invalid_images", 400);
  }
  await error(await handle(request("video-create", video("minimax", { duration: 4, model: "MiniMax-H3-Max" }))), "invalid_duration", 400);
  assert.equal(calls.length, 0);
});
test("supported video duration endpoints and configurable models reach exactly one submission", async () => {
  for (const [provider, model] of [["seedance", "ep-fixture"], ["minimax", "MiniMax-H3-Highspeed"]]) for (const duration of [4, 15]) {
    const { handle, calls } = fixture([provider === "minimax" ? { task_id: "12345" } : { id: "12345" }]);
    await success(await handle(request("video-create", video(provider, { model, duration }))));
    assert.equal(calls[0].body?.model, model);
    assert.equal(calls[0].body?.duration, duration);
  }
});
test("missing creation task ID reports unknown submission rather than silently resubmitting", async () => {
  for (const provider of ["seedance", "minimax"]) {
    const { handle, calls } = fixture([{}]);
    await error(await handle(request("video-create", video(provider))), "submission_unknown", 502);
    assert.equal(calls.length, 1);
  }
});
test("video status maps exact provider envelopes and stable Chinese failure codes", async () => {
  for (const provider of ["seedance", "minimax"]) for (const state of ["queued", "running", "succeeded", "failed", "cancelled", "expired"]) {
    const body = statusBody(provider, state);
    if (provider === "seedance" && state === "failed") Object.assign(body, { error: { code: "secret", message: KEY } });
    if (provider === "minimax" && state === "failed") Object.assign(body.task!, { error: { code: "secret", message: KEY } });
    const { handle, calls } = fixture([body]);
    const result = await success(await handle(request("video-status", input(provider, { taskId: "task-1" }))));
    const errors: Record<string, string> = { failed: "视频生成失败", cancelled: "任务已取消", expired: "任务已超时" };
    assert.deepEqual(result, state in errors ? { status: "failed", error: errors[state] } : state === "succeeded" ? { status: state, url: provider === "minimax" ? MINI_CDN : SEED_CDN } : { status: state });
    assert.equal(calls[0].url, provider === "seedance" ? "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-1" : "https://api.minimax.cn/v2/query/video_generation/task-1");
    assert.equal(calls[0].init.method, "GET"); assert.equal(calls[0].headers.get("authorization"), `Bearer ${KEY}`);
  }
});
test("taskId traversal and arbitrary download URL are rejected; unknown statuses fail closed", async () => {
  const { handle, calls } = fixture([]);
  for (const taskId of ["../secrets", "a?key=bad", "a%2fb", "", "x".repeat(129)]) {
    await error(await handle(request("video-status", input("seedance", { taskId }))), "invalid_task_id", 400);
  }
  await error(await handle(request("video-download", input("minimax", { taskId: "task-1", url: "https://evil.example/video.mp4" }))), "invalid_input", 400);
  assert.equal(calls.length, 0);
  const unknown = fixture([statusBody("seedance", "mystery")]);
  await error(await unknown.handle(request("video-status", input("seedance", { taskId: "task-1" }))), "invalid_upstream_response", 502);
});

test("video download freshly authenticates the task, streams from official CDN and never forwards key/cookies", async () => {
  for (const [provider, url] of [["minimax", MINI_CDN], ["minimax", "https://cdn.hailuoai.com/output.mp4"], ["seedance", SEED_CDN]]) {
    const { handle, calls } = fixture([statusBody(provider, "succeeded", url), mp4()]);
    const response = await handle(request("video-download", input(provider, { taskId: "task-1" }), { headers: { "Content-Type": "application/json", Cookie: "private=cookie", Authorization: "Bearer visitor" } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal((await response.arrayBuffer()).byteLength, 8);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, provider === "minimax" ? "https://api.minimax.cn/v2/query/video_generation/task-1" : "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-1");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[1].url, url);
    assert.equal(calls[0].headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(calls[1].headers.get("authorization"), null);
    assert.equal(calls[1].headers.get("x-goog-api-key"), null);
    assert.equal(calls[1].headers.get("cookie"), null);
    assert.equal(calls[1].init.credentials, "omit");
    assert.equal(calls[1].init.redirect, "manual");
  }
});
test("unknown public CDN remains a manual status URL but is never proxied", async () => {
  const url = "https://unconfirmed.example.org/video.mp4";
  const { handle, calls } = fixture([statusBody("minimax", "succeeded", url), statusBody("minimax", "succeeded", url)]);
  assert.deepEqual(await success(await handle(request("video-status", input("minimax", { taskId: "task-1" })))), { status: "succeeded", url });
  await error(await handle(request("video-download", input("minimax", { taskId: "task-1" }))), "media_unavailable", 502);
  assert.equal(calls.length, 2);
});
test("unsafe CDN URLs, cross-provider hosts and private IP literals never trigger a media fetch", async () => {
  for (const url of ["https://127.0.0.1/a.mp4", "https://[::1]/a.mp4", "http://video-product.cdn.minimax.io/a.mp4", "https://video-product.cdn.minimax.io.evil.example/a.mp4", "https://video-product.cdn.minimax.io:444/a.mp4", "https://user:pass@video-product.cdn.minimax.io/a.mp4", SEED_CDN, "javascript:alert(1)"]) {
    const { handle, calls } = fixture([statusBody("minimax", "succeeded", url)]);
    await error(await handle(request("video-download", input("minimax", { taskId: "task-1" }))), "media_unavailable", 502);
    assert.equal(calls.length, 1);
  }
});
test("CDN DNS must contain only public addresses; missing DNS support fails closed", async () => {
  for (const addresses of [[], ["127.0.0.1"], ["10.1.2.3"], ["172.16.1.1"], ["192.168.1.1"], ["169.254.169.254"], ["100.64.0.1"], ["198.18.0.1"], ["203.0.113.1"], ["8.8.8.8", "::1"], ["fc00::1"], ["fe80::1"], ["::ffff:127.0.0.1"], ["2001:db8::1"], ["2002:7f00:1::1"]]) {
    const { handle, calls } = fixture([statusBody("minimax")], { resolveHost: async () => addresses });
    await error(await handle(request("video-download", input("minimax", { taskId: "task-1" }))), "media_unavailable", 502);
    assert.equal(calls.length, 1);
  }
});
test("each redirect is revalidated and DNS-checked without forwarding credentials", async () => {
  const hosts: string[] = [];
  const { handle, calls } = fixture([
    statusBody("minimax"), new Response(null, { status: 302, headers: { Location: "https://cdn.hailuoai.com/output.mp4" } }), mp4(),
  ], { resolveHost: async (host) => { hosts.push(host); return ["8.8.8.8"]; } });
  assert.equal((await (await handle(request("video-download", input("minimax", { taskId: "task-1" })))).arrayBuffer()).byteLength, 8);
  assert.deepEqual(hosts, ["video-product.cdn.minimax.io", "cdn.hailuoai.com"]);
  assert.equal(calls[2].headers.get("authorization"), null);
  for (const location of ["https://169.254.169.254/latest/meta-data", "https://evil.example/a.mp4", "http://cdn.hailuoai.com/a.mp4", "https://cdn.hailuoai.com.evil.example/a.mp4"]) {
    const f = fixture([statusBody("minimax"), new Response(null, { status: 302, headers: { Location: location } })]);
    await error(await f.handle(request("video-download", input("minimax", { taskId: "task-1" }))), "media_unavailable", 502);
    assert.equal(f.calls.length, 2);
  }
});
test("download redirect loops are bounded", async () => {
  const { handle, calls } = fixture([statusBody("minimax"), ...Array.from({ length: 4 }, () => new Response(null, { status: 307, headers: { Location: "/loop.mp4" } }))]);
  await error(await handle(request("video-download", input("minimax", { taskId: "task-1" }))), "media_unavailable", 502);
  assert.equal(calls.length, 5);
});
test("download requires a succeeded task and a fresh successful credential check", async () => {
  const pending = fixture([statusBody("minimax", "running")]);
  await error(await pending.handle(request("video-download", input("minimax", { taskId: "task-1" }))), "media_not_ready", 409);
  assert.equal(pending.calls.length, 1);
  const denied = fixture([new Response(KEY, { status: 401 })]);
  await error(await denied.handle(request("video-download", input("minimax", { taskId: "task-1" }))), "provider_auth_failed", 401);
  assert.equal(denied.calls.length, 1);
});
test("download rejects HTML, partial/error responses and oversized content-length before streaming", async () => {
  for (const media of [
    new Response(KEY, { headers: { "Content-Type": "text/html" } }),
    new Response(KEY, { status: 403 }), new Response(KEY, { status: 206, headers: { "Content-Type": "video/mp4" } }),
    new Response("x", { headers: { "Content-Type": "video/mp4", "Content-Length": String(LIMITS.video + 1) } }),
  ]) {
    const { handle } = fixture([statusBody("minimax"), media]);
    await error(await handle(request("video-download", input("minimax", { taskId: "task-1" }))), "media_unavailable", 502);
  }
});
test("streamed video is size-bounded even without content-length and cancels on overflow", async () => {
  const chunk = new Uint8Array(16 * 1024 * 1024);
  let cancelled = false;
  const { handle } = fixture([statusBody("minimax"), mp4(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk); }, cancel() { cancelled = true; },
  }))]);
  const response = await handle(request("video-download", input("minimax", { taskId: "task-1" })));
  const reader = response.body!.getReader();
  let total = 0;
  await assert.rejects(async () => { while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; } }, /media_unavailable/);
  assert.equal(total, LIMITS.video);
  assert.ok(cancelled);
});
test("media timeout and premature EOF fail the stream instead of appending JSON", async () => {
  for (const media of [mp4(new ReadableStream<Uint8Array>()), new Response("x", { headers: { "Content-Type": "video/mp4", "Content-Length": "2" } })]) {
    const { handle } = fixture([statusBody("minimax"), media], { timeouts: { media: 10 } });
    const response = await handle(request("video-download", input("minimax", { taskId: "task-1" })));
    assert.equal(response.status, 200);
    await assert.rejects(response.arrayBuffer(), /media_unavailable/);
  }
});
test("downstream cancellation aborts and cancels CDN body", async () => {
  let cancelled = false;
  const { handle, calls } = fixture([statusBody("minimax"), mp4(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }))]);
  const response = await handle(request("video-download", input("minimax", { taskId: "task-1" })));
  await response.body!.cancel();
  assert.ok(calls[1].init.signal?.aborted);
  assert.ok(cancelled);
});

test("paid network failures are submission_unknown, with one attempt and no raw exception/credential leakage", async () => {
  for (const [action, body] of [
    ["script", input("gemini", { prompt: "test" })], ["script", input("deepseek", { prompt: "test" })],
    ["extract-assets", input("gemini", { prompt: "test" })], ["extract-assets", input("deepseek", { prompt: "test" })],
    ["image", input("openai", { prompt: "test" })], ["image", input("seedream", { prompt: "test" })],
    ["speech", input("minimax", { text: "你好", voiceId: VOICE })],
    ["video-create", video("seedance")], ["video-create", video("minimax")],
  ] as const) {
    let attempts = 0;
    const handle = createHandler({ fetch: async () => { attempts++; throw new Error(`Upstream failed: ${KEY}`); } });
    await error(await handle(request(action, body)), "submission_unknown", 504);
    assert.equal(attempts, 1);
  }
});
test("paid header and body timeouts are bounded, aborted and never retried", async () => {
  for (const phase of ["headers", "body"]) for (const [action, provider] of [["image", "openai"], ["image", "seedream"], ["extract-assets", "gemini"], ["extract-assets", "deepseek"]]) {
    let calls = 0;
    let signal: AbortSignal | null | undefined;
    const handle = createHandler({ timeouts: { generation: 5 }, fetch: async (_url, init) => {
      calls++; signal = init.signal;
      return phase === "headers" ? await new Promise<Response>(() => {}) : new Response(new ReadableStream<Uint8Array>());
    } });
    await error(await handle(request(action, input(provider, { prompt: "test" }))), "submission_unknown", 504);
    assert.equal(calls, 1); assert.ok(signal?.aborted);
  }
});
test("non-paid query timeout is distinguished from an unknown submission", async () => {
  const handle = createHandler({ timeouts: { query: 5 }, fetch: async () => await new Promise<Response>(() => {}) });
  await error(await handle(request("video-status", input("seedance", { taskId: "task-1" }))), "upstream_timeout", 504);
});
test("HTTP errors and redirects never leak upstream bodies or automatically retry paid POSTs", async () => {
  for (const [action, body] of [
    ["image", input("openai", { prompt: "test" })], ["image", input("seedream", { prompt: "test" })],
    ["speech", input("minimax", { text: "你好", voiceId: VOICE })], ["video-create", video("minimax")], ["video-create", video("seedance")],
  ] as const) for (const [status, code, http] of [[401, "provider_auth_failed", 401], [403, "provider_forbidden", 403], [402, "insufficient_balance", 402], [429, "rate_limited", 429], [500, "submission_unknown", 502], [302, "provider_rejected", 422], [400, "provider_rejected", 422]] as const) {
    const { handle, calls } = fixture([new Response(`secret ${KEY}`, { status, headers: { Location: "https://evil.example/steal" } })]);
    await error(await handle(request(action, body)), code, http);
    assert.equal(calls.length, 1); assert.equal(calls[0].init.redirect, "manual");
  }
});
test("client abort during a paid submission is submission_unknown and aborts the one upstream attempt", async () => {
  const client = new AbortController();
  let signal: AbortSignal | null | undefined;
  let attempts = 0;
  const handle = createHandler({ fetch: async (_url, init) => {
    attempts++; signal = init.signal; client.abort();
    return await new Promise<Response>(() => {});
  } });
  await error(await handle(request("video-create", video("seedance"), { signal: client.signal })), "submission_unknown", 504);
  assert.equal(attempts, 1); assert.ok(signal?.aborted);
});
test("request cancellation after download headers aborts the CDN and fails the outgoing stream", async () => {
  const client = new AbortController();
  let cancelled = false;
  const { handle, calls } = fixture([statusBody("minimax"), mp4(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }))]);
  const response = await handle(request("video-download", input("minimax", { taskId: "task-1" }), { signal: client.signal }));
  client.abort();
  await assert.rejects(response.arrayBuffer(), /media_unavailable/);
  assert.ok(cancelled); assert.ok(calls[1].init.signal?.aborted);
});
test("DNS errors and lookup stalls fail closed before any CDN fetch", async () => {
  for (const resolveHost of [async () => { throw new Error(KEY); }, async () => await new Promise<string[]>(() => {})]) {
    const { handle, calls } = fixture([statusBody("minimax")], { resolveHost, timeouts: { media: 5 } });
    await error(await handle(request("video-download", input("minimax", { taskId: "task-1" }))), "media_unavailable", 502);
    assert.equal(calls.length, 1);
  }
});
test("missing runtime DNS support returns media_unavailable, not an unrestricted proxy", async () => {
  let attempts = 0;
  const handle = createHandler({ fetch: async () => {
    attempts++;
    return Response.json(statusBody("minimax"));
  } });
  await error(await handle(request("video-download", input("minimax", { taskId: "task-1" }))), "media_unavailable", 502);
  assert.equal(attempts, 1);
});
test("existing index.ts still boots the implemented handler (entry wiring, not a Deno runtime test)", async () => {
  const runtime = globalThis as typeof globalThis & { Deno?: { serve: (callback: typeof handler) => void } };
  const previous = runtime.Deno;
  let served = false;
  runtime.Deno = { serve(callback) { assert.equal(callback, handler); served = true; } };
  try {
    const entry = "../functions/index.ts";
    await import(entry);
    assert.ok(served);
  } finally {
    if (previous === undefined) delete runtime.Deno;
    else runtime.Deno = previous;
  }
});

test("upstream JSON is bounded and malformed bodies are safely rejected", async () => {
  const oversize = fixture([new Response("{}", { headers: { "Content-Length": String(LIMITS.json + 1) } })]);
  await error(await oversize.handle(request("voices", input("minimax"))), "upstream_too_large", 502);
  const malformed = fixture([new Response(`not json ${KEY}`)]);
  await error(await malformed.handle(request("voices", input("minimax"))), "invalid_upstream_response", 502);
});

// Stateless BYOK: credentials live only in this request, never in env, logs or storage.
// No SDKs/dependencies: index.ts remains the Deno.serve entry point.
type ObjectValue = Record<string, unknown>;
type VideoProvider = "seedance" | "minimax";
type VideoResult = {
  status: "queued" | "running" | "succeeded" | "failed";
  url?: string;
  error?: string;
};
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Dependencies = {
  fetch?: Fetcher;
  resolveHost?: (host: string) => Promise<string[]>;
  timeouts?: { body?: number; generation?: number; query?: number; media?: number };
};

const MiB = 1024 * 1024;
export const LIMITS = Object.freeze({ body: 16 * MiB, json: 2 * MiB, image: 32 * MiB, audio: 24 * MiB, video: 128 * MiB });
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const ENDPOINTS = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/interactions",
  deepseek: "https://api.deepseek.com/chat/completions",
  openai: "https://api.openai.com/v1/images/generations",
  seedream: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
  siliconflow: "https://api.siliconflow.com/v1/images/generations",
  voices: "https://api.minimax.cn/v1/get_voice",
  speech: "https://api.minimax.cn/v1/t2a_v2",
  seedance: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
  minimax: "https://api.minimax.cn/v2/video_generation",
  minimaxQuery: "https://api.minimax.cn/v2/query/video_generation",
};
// Exact output hosts from the official query-task examples, not wildcard cloud buckets:
// https://docs.volcengine.com/docs/ark/get-video-generation-task-api
// https://platform.minimax.cn/docs/api-reference/video-generation-v2-query.md
const MEDIA_HOSTS: Record<VideoProvider, readonly string[]> = {
  seedance: ["ark-content-generation-cn-beijing.tos-cn-beijing.volces.com"],
  minimax: ["video-product.cdn.minimax.io", "cdn.hailuoai.com"],
};
const ACTION_FIELDS: Record<string, readonly string[]> = {
  script: ["provider", "key", "model", "prompt"],
  "extract-assets": ["provider", "key", "model", "prompt"],
  image: ["provider", "key", "model", "prompt"],
  voices: ["provider", "key"],
  speech: ["provider", "key", "model", "text", "voiceId", "speed"],
  "video-create": ["provider", "key", "model", "prompt", "duration", "images"],
  "video-status": ["provider", "key", "taskId"],
  "video-download": ["provider", "key", "taskId"],
};

class Fault extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
function requireValue(condition: unknown, code = "invalid_input", status = 400): asserts condition {
  if (!condition) throw new Fault(code, status);
}
function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown, code = "invalid_input", status = 400): ObjectValue {
  requireValue(isObject(value), code, status);
  return value;
}
function text(value: unknown, max: number, code = "invalid_input", status = 400): string {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= max, code, status);
  return value;
}
function fields(value: ObjectValue, allowed: readonly string[]): void {
  requireValue(Object.keys(value).every((name) => allowed.includes(name)));
}
function model(value: unknown, fallback: string, pattern: RegExp): string {
  const result = value === undefined ? fallback : text(value, 128, "invalid_model");
  requireValue(pattern.test(result), "invalid_model");
  return result;
}
function json(data: unknown): Response {
  return Response.json({ ok: true, data }, { headers: HEADERS });
}
function failure(error: unknown): Response {
  const fault = error instanceof Fault ? error : new Fault("internal_error", 500);
  return Response.json({ ok: false, error: fault.code }, {
    status: fault.status,
    headers: { ...HEADERS, ...(fault.status === 405 ? { Allow: "GET, POST" } : {}) },
  });
}
function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body && !body.locked) void body.cancel().catch(() => {});
}

// One deadline includes both headers and body reads. Parent aborts also cancel the fetch.
function deadline(ms: number, parent: AbortSignal, fault: Fault) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, ms);
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  return {
    signal: controller.signal,
    abort,
    async run<T>(promise: Promise<T>): Promise<T> {
      if (controller.signal.aborted) {
        void promise.catch(() => {});
        throw fault;
      }
      let onAbort: () => void = () => {};
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(fault);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try { return await Promise.race([promise, interrupted]); }
      finally { controller.signal.removeEventListener("abort", onAbort); }
    },
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}
type Deadline = ReturnType<typeof deadline>;

async function readBytes(body: ReadableStream<Uint8Array> | null, headers: Headers, max: number, scope: Deadline, overflow: Fault): Promise<Uint8Array> {
  const length = headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) {
    cancelBody(body);
    throw overflow;
  }
  requireValue(body, "invalid_json");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await scope.run(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > max) throw overflow;
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
function parseJson(bytes: Uint8Array, code: string, status: number): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Fault(code, status); }
}
function upstreamHttp(status: number, paid: boolean): Fault {
  if (status === 401) return new Fault("provider_auth_failed", 401);
  if (status === 403) return new Fault("provider_forbidden", 403);
  if (status === 402) return new Fault("insufficient_balance", 402);
  if (status === 429) return new Fault("rate_limited", 429);
  if (status === 404) return new Fault("provider_not_found", 404);
  if (status === 410) return new Fault("provider_not_found", 404);
  if (status === 408 || status >= 500) return new Fault(paid ? "submission_unknown" : "upstream_unavailable", 502);
  return new Fault("provider_rejected", 422);
}
function minimaxResult(value: ObjectValue, required: boolean): void {
  if (value.base_resp === undefined && !required) return;
  const base = object(value.base_resp, "invalid_upstream_response", 502);
  requireValue(typeof base.status_code === "number", "invalid_upstream_response", 502);
  if (base.status_code === 0) return;
  const codes: Record<number, [string, number]> = {
    1004: ["provider_auth_failed", 401], 1008: ["insufficient_balance", 402],
    1002: ["rate_limited", 429], 1026: ["provider_rejected", 422], 2013: ["provider_rejected", 422],
  };
  const [code, status] = codes[base.status_code] ?? ["provider_rejected", 422];
  throw new Fault(code, status);
}

const STRING_SCHEMA = { type: "string" };
const ASSET_KINDS = ["characters", "scenes", "props"] as const;
type AssetKind = typeof ASSET_KINDS[number];
type Assets = Partial<Record<AssetKind, { name: string; description: string }[]>>;
const ASSET_NAME_SCHEMA = { type: "string", minLength: 1, maxLength: 100 };
const ASSET_LIST_SCHEMA = { type: "array", maxItems: 30, items: {
  type: "object", properties: { name: ASSET_NAME_SCHEMA, description: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["name", "description"],
} };
const ASSET_PROPERTIES = { characters: ASSET_LIST_SCHEMA, scenes: ASSET_LIST_SCHEMA, props: ASSET_LIST_SCHEMA };
const ASSET_REFS_SCHEMA = { type: "array", maxItems: 30, uniqueItems: true, items: ASSET_NAME_SCHEMA };
const SHOT_ASSET_PROPERTIES = { characters: ASSET_REFS_SCHEMA, scenes: ASSET_REFS_SCHEMA, props: ASSET_REFS_SCHEMA };
const SCRIPT_SCHEMA = {
  type: "object",
  properties: {
    title: STRING_SCHEMA,
    ...ASSET_PROPERTIES,
    shots: { type: "array", minItems: 10, maxItems: 10, items: {
      type: "object",
      properties: {
        ...SHOT_ASSET_PROPERTIES,
        visual: STRING_SCHEMA, camera: STRING_SCHEMA, start: STRING_SCHEMA, action: STRING_SCHEMA, end: STRING_SCHEMA,
        duration: { type: "integer", minimum: 4, maximum: 15, description: "Seconds; all 10 shots must total exactly 90 seconds." },
        dialogues: { type: "array", items: {
          type: "object", properties: { speaker: STRING_SCHEMA, text: STRING_SCHEMA }, required: ["speaker", "text"],
        } },
      },
      required: ["visual", "camera", "start", "action", "end", "duration", "dialogues", ...ASSET_KINDS],
    } },
  },
  required: ["shots", ...ASSET_KINDS],
};
const ASSETS_SCHEMA = {
  type: "object",
  properties: {
    ...ASSET_PROPERTIES,
    shots: { type: "array", minItems: 1, maxItems: 100, items: {
      type: "object", properties: { number: { type: "integer", minimum: 1, maximum: 100 }, ...SHOT_ASSET_PROPERTIES },
      required: ["number", ...ASSET_KINDS],
    } },
  },
  required: [...ASSET_KINDS, "shots"],
};
const ASSET_INSTRUCTION = " Include characters, scenes and props arrays at the top level and in every shot, using empty arrays when absent. Top-level entries have name and description, with unique names per category. Shot arrays contain only declared names from the same category, without duplicates. Preserve existing asset names, fixed descriptions and phrases EXACTLY; do not paraphrase them.";
const SCRIPT_INSTRUCTION = "Return only a json object matching this schema. Exactly 10 shots totaling 90 seconds. start/end are frame descriptions, not timestamps. No markdown." + ASSET_INSTRUCTION + " Schema: " + JSON.stringify(SCRIPT_SCHEMA);
const ASSETS_INSTRUCTION = "Return only a json object matching this schema. Only extract visual assets from the supplied script; do not rewrite shots or dialogues and do not invent details. Include one association entry per source shot, preserving its original number (unique integer 1–100), shot count and order. Reuse existing names and fixed phrases. No markdown." + ASSET_INSTRUCTION + " Schema: " + JSON.stringify(ASSETS_SCHEMA);

function validateAssetLists(source: ObjectValue, required: boolean, code: string): Assets {
  const assets: Assets = {};
  for (const kind of ASSET_KINDS) {
    const list = source[kind];
    if (list === undefined && !required) continue;
    requireValue(Array.isArray(list) && list.length <= 30, code, 502);
    const names = new Set<string>();
    assets[kind] = list.map((item) => {
      const asset = object(item, code, 502);
      const name = text(asset.name, 100, code, 502);
      requireValue(!names.has(name), code, 502);
      names.add(name);
      return { name, description: text(asset.description, 4000, code, 502) };
    });
  }
  return assets;
}
function validateShotAssets(shot: ObjectValue, assets: Assets, required: boolean, code: string): Partial<Record<AssetKind, string[]>> {
  const result: Partial<Record<AssetKind, string[]>> = {};
  for (const kind of ASSET_KINDS) {
    const list = shot[kind];
    if (list === undefined && !required) continue;
    requireValue(Array.isArray(list) && list.length <= 30, code, 502);
    const declared = new Set(assets[kind]?.map((asset) => asset.name));
    const names = new Set<string>();
    result[kind] = list.map((item) => {
      const name = text(item, 100, code, 502);
      requireValue(declared.has(name) && !names.has(name), code, 502);
      names.add(name);
      return name;
    });
  }
  return result;
}

function validateScript(raw: string): ObjectValue {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Fault("invalid_script", 502); }
  const source = object(parsed, "invalid_script", 502);
  requireValue(Array.isArray(source.shots) && source.shots.length === 10, "invalid_script", 502);
  const assets = validateAssetLists(source, false, "invalid_script");
  const result: ObjectValue = { ...assets };
  if (source.title !== undefined) result.title = text(source.title, 200, "invalid_script", 502);
  let duration = 0;
  result.shots = source.shots.map((item) => {
    const shot = object(item, "invalid_script", 502);
    requireValue(typeof shot.duration === "number" && Number.isInteger(shot.duration) && shot.duration >= 4 && shot.duration <= 15, "invalid_script", 502);
    duration += shot.duration;
    requireValue(Array.isArray(shot.dialogues) && shot.dialogues.length <= 30, "invalid_script", 502);
    return {
      ...validateShotAssets(shot, assets, false, "invalid_script"),
      visual: text(shot.visual, 8000, "invalid_script", 502), camera: text(shot.camera, 8000, "invalid_script", 502),
      start: text(shot.start, 8000, "invalid_script", 502), action: text(shot.action, 8000, "invalid_script", 502), end: text(shot.end, 8000, "invalid_script", 502),
      duration: shot.duration,
      dialogues: shot.dialogues.map((item) => {
        const line = object(item, "invalid_script", 502);
        return { speaker: text(line.speaker, 100, "invalid_script", 502), text: text(line.text, 3000, "invalid_script", 502) };
      }),
    };
  });
  requireValue(duration === 90, "invalid_script", 502);
  return result;
}
function validateAssets(raw: string): ObjectValue {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Fault("invalid_assets", 502); }
  const source = object(parsed, "invalid_assets", 502);
  const assets = validateAssetLists(source, true, "invalid_assets");
  requireValue(Array.isArray(source.shots) && source.shots.length >= 1 && source.shots.length <= 100, "invalid_assets", 502);
  const numbers = new Set<number>();
  const shots = source.shots.map((item) => {
    const shot = object(item, "invalid_assets", 502);
    requireValue(typeof shot.number === "number" && Number.isInteger(shot.number) && shot.number >= 1 && shot.number <= 100 && !numbers.has(shot.number), "invalid_assets", 502);
    numbers.add(shot.number);
    return { number: shot.number, ...validateShotAssets(shot, assets, true, "invalid_assets") };
  });
  return { ...assets, shots };
}
// REST output is steps/model_output/content/text, NOT the SDK's output_text helper.
// https://aistudio.google.com/api-reference/interactions-api/create-interaction
function geminiText(value: ObjectValue, code: string): string {
  requireValue(value.status === "completed" && Array.isArray(value.steps), code, 502);
  const outputs = value.steps.filter((step) => isObject(step) && step.type === "model_output");
  requireValue(outputs.length > 0, code, 502);
  const last = object(outputs[outputs.length - 1], code, 502);
  requireValue(Array.isArray(last.content), code, 502);
  return last.content.filter((part) => isObject(part) && part.type === "text")
    .map((part) => text((part as ObjectValue).text, LIMITS.json, code, 502)).join("");
}
function base64(value: unknown, max: number, code: string, status: number): string {
  const result = text(value, max, code, status);
  requireValue(result.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(result), code, status);
  return result;
}
function publicUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 8192 || /[\s\\]/.test(value)) return;
  try {
    const url = new URL(value);
    const host = url.hostname;
    // Reject all IP literals (including URL-normalized decimal/hex IPv4) and local names.
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host)) return;
    return url;
  } catch { return; }
}
function images(value: unknown): { url: string; role: string }[] {
  requireValue(Array.isArray(value) && value.length <= 9, "invalid_images");
  const result = value.map((item) => {
    const image = object(item, "invalid_images");
    fields(image, ["url", "role"]);
    requireValue(["reference_image", "first_frame", "last_frame"].includes(String(image.role)), "invalid_images");
    const url = text(image.url, LIMITS.body, "invalid_images");
    if (url.startsWith("data:")) {
      const match = /^data:image\/(png|jpeg|jpg|webp|heic|heif);base64,/.exec(url);
      requireValue(match, "invalid_images");
      base64(url.slice(match[0].length), LIMITS.body, "invalid_images", 400);
    } else requireValue(publicUrl(url), "invalid_images");
    return { url, role: image.role as string };
  });
  const first = result.filter((image) => image.role === "first_frame").length;
  const last = result.filter((image) => image.role === "last_frame").length;
  const refs = result.filter((image) => image.role === "reference_image").length;
  requireValue(first <= 1 && last <= 1 && (!last || first === 1) && !(refs && (first || last)), "invalid_images");
  return result;
}

// Conservative public-address check; unknown/reserved forms fail closed.
function publicIp(ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const [a, b, c, d] = ip.split(".").map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return false;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Global unicast only; reject documentation, Teredo, 6to4 and embedded IPv4.
  return /^[23][0-9a-f]{3}:[0-9a-f:]+$/i.test(ip) &&
    !/^2001:(?:0{0,3}[0-9a-f]{1,2}:|0?db8:)/i.test(ip) && !/^2002:/i.test(ip) && !/^3fff:/i.test(ip);
}
async function resolveHost(host: string): Promise<string[]> {
  const runtime = (globalThis as typeof globalThis & {
    Deno?: { resolveDns: (host: string, type: "A" | "AAAA") => Promise<string[]> };
  }).Deno;
  if (!runtime?.resolveDns) return [];
  const records = await Promise.all((["A", "AAAA"] as const).map(async (type) => {
    try { return await runtime.resolveDns(host, type); }
    catch (error) {
      if (error instanceof Error && error.name === "NotFound") return [];
      throw new Fault("media_unavailable", 502);
    }
  }));
  return records.flat();
}

export function createHandler(dependencies: Dependencies = {}) {
  const fetcher: Fetcher = dependencies.fetch ?? ((url, init) => fetch(url, init));
  const dns = dependencies.resolveHost ?? resolveHost;
  const timeouts = { body: 15_000, generation: 120_000, query: 20_000, media: 90_000, ...dependencies.timeouts };

  async function upstream(request: Request, url: string, key: string, options: {
    body?: ObjectValue; paid?: boolean; gemini?: boolean; max?: number;
  } = {}): Promise<ObjectValue> {
    const paid = options.paid === true;
    const scope = deadline(paid ? timeouts.generation : timeouts.query, request.signal,
      new Fault(paid ? "submission_unknown" : "upstream_timeout", 504));
    let response: Response | undefined;
    try {
      requireValue(!request.signal.aborted, "request_aborted", 408);
      response = await scope.run(fetcher(url, {
        method: options.body ? "POST" : "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: scope.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json",
          ...(options.gemini ? { "x-goog-api-key": key, "Api-Revision": "2026-05-20" } : { Authorization: `Bearer ${key}` }) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      }));
      if (!response.ok) throw upstreamHttp(response.status, paid);
      requireValue(!response.redirected, "invalid_upstream_response", 502);
      const bytes = await readBytes(response.body, response.headers, options.max ?? LIMITS.json, scope, new Fault("upstream_too_large", 502));
      const data = object(parseJson(bytes, "invalid_upstream_response", 502), "invalid_upstream_response", 502);
      if (data.type === "error" || (data.error && !["failed", "cancelled", "expired"].includes(String(data.status)))) {
        throw new Fault("provider_rejected", 422);
      }
      return data;
    } catch (error) {
      scope.abort();
      if (error instanceof Fault) throw error;
      // A POST may already have been charged. Never retry or switch providers here.
      throw new Fault(paid ? "submission_unknown" : "upstream_unavailable", paid ? 504 : 502);
    } finally { cancelBody(response?.body ?? null); scope.dispose(); }
  }

  // SiliconFlow returns a temporary CDN URL (1h). Download it server-side so the
  // frontend keeps the same { base64, mime } contract, with SSRF-safe host checks.
  async function fetchImage(request: Request, url: string): Promise<{ base64: string; mime: string }> {
    const scope = deadline(timeouts.media, request.signal, new Fault("media_unavailable", 502));
    let response: Response | undefined;
    try {
      const target = publicUrl(url);
      requireValue(target && (target.hostname === "siliconflow.cn" || target.hostname.endsWith(".siliconflow.cn")), "media_unavailable", 502);
      requireValue(!request.signal.aborted, "request_aborted", 408);
      response = await scope.run(fetcher(target.href, {
        method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: scope.signal,
        headers: { Accept: "image/png, image/jpeg" },
      }));
      requireValue(response.status === 200 && !response.redirected && response.body, "media_unavailable", 502);
      const bytes = await readBytes(response.body, response.headers, LIMITS.image, scope, new Fault("media_unavailable", 502));
      const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      requireValue(png || jpeg, "media_unavailable", 502);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      return { base64: btoa(binary), mime: png ? "image/png" : "image/jpeg" };
    } catch (error) {
      scope.abort();
      if (error instanceof Fault) throw error;
      throw new Fault("media_unavailable", 502);
    } finally { cancelBody(response?.body ?? null); scope.dispose(); }
  }

  async function videoStatus(request: Request, provider: VideoProvider, key: string, id: string): Promise<VideoResult> {
    const url = `${provider === "seedance" ? ENDPOINTS.seedance : ENDPOINTS.minimaxQuery}/${encodeURIComponent(id)}`;
    const data = await upstream(request, url, key);
    if (provider === "minimax") minimaxResult(data, false);
    const task = provider === "seedance" ? data : object(data.task, "invalid_upstream_response", 502);
    if (task.status === "queued" || task.status === "running") return { status: task.status };
    if (task.status === "failed") return { status: "failed", error: "视频生成失败" };
    if (task.status === "cancelled") return { status: "failed", error: "任务已取消" };
    if (task.status === "expired") return { status: "failed", error: "任务已超时" };
    requireValue(task.status === "succeeded", "invalid_upstream_response", 502);
    const content = object(task.content, "invalid_upstream_response", 502);
    const result = publicUrl(provider === "seedance" ? content.video_url : content.url);
    // A public unrecognised CDN can be opened manually by the frontend, never proxied.
    return result ? { status: "succeeded", url: result.href } : { status: "succeeded", error: "视频地址不可用" };
  }

  async function download(request: Request, provider: VideoProvider, url: string): Promise<Response> {
    const unavailable = new Fault("media_unavailable", 502);
    const scope = deadline(timeouts.media, request.signal, unavailable);
    let response: Response | undefined;
    try {
      for (let hop = 0; hop <= 3; hop++) {
        const target = publicUrl(url);
        requireValue(target && MEDIA_HOSTS[provider].includes(target.hostname), "media_unavailable", 502);
        const addresses = await scope.run(dns(target.hostname));
        requireValue(addresses.length > 0 && addresses.every(publicIp), "media_unavailable", 502);
        response = await scope.run(fetcher(target.href, {
          method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: scope.signal,
          headers: { Accept: "video/mp4, application/octet-stream" },
        }));
        requireValue(!response.redirected, "media_unavailable", 502);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          cancelBody(response.body);
          requireValue(location && hop < 3, "media_unavailable", 502);
          url = new URL(location, target).href;
          continue;
        }
        requireValue(response.status === 200 && response.body, "media_unavailable", 502);
        const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        requireValue(mime === "video/mp4" || mime === "application/octet-stream", "media_unavailable", 502);
        const length = response.headers.get("content-length");
        requireValue(length === null || (/^\d+$/.test(length) && Number(length) > 0 && Number(length) <= LIMITS.video), "media_unavailable", 502);
        const reader = response.body.getReader();
        let total = 0;
        let stopped = false;
        let onAbort: () => void = () => {};
        const finish = () => {
          stopped = true;
          scope.signal.removeEventListener("abort", onAbort);
          scope.dispose();
        };
        // After headers have been sent, a timeout/overflow must fail the stream, not
        // append JSON to a partial video. The caller must discard failed downloads.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            onAbort = () => {
              if (stopped) return;
              finish();
              void reader.cancel().catch(() => {});
              controller.error(new Error("media_unavailable"));
            };
            scope.signal.addEventListener("abort", onAbort, { once: true });
          },
          async pull(controller) {
            try {
              const { done, value } = await scope.run(reader.read());
              if (stopped) return;
              if (done) {
                requireValue(total > 0 && (length === null || total === Number(length)), "media_unavailable", 502);
                finish(); reader.releaseLock(); controller.close(); return;
              }
              total += value.byteLength;
              requireValue(total <= LIMITS.video, "media_unavailable", 502);
              controller.enqueue(value);
            } catch {
              if (stopped) return;
              finish(); scope.abort(); void reader.cancel().catch(() => {});
              controller.error(new Error("media_unavailable"));
            }
          },
          cancel() { finish(); scope.abort(); void reader.cancel().catch(() => {}); },
        }, { highWaterMark: 0 });
        return new Response(stream, { headers: { ...HEADERS, "Content-Type": "video/mp4", "Content-Disposition": 'attachment; filename="video.mp4"' } });
      }
      throw unavailable;
    } catch {
      scope.abort(); scope.dispose(); cancelBody(response?.body ?? null);
      throw unavailable;
    }
  }

  return async function handle(request: Request): Promise<Response> {
    try {
      const params = new URL(request.url).searchParams;
      const action = params.get("action");
      requireValue(params.getAll("action").length === 1 && [...params.keys()].every((name) => name === "action"), "invalid_action");
      if (request.method === "GET") {
        requireValue(action === "health", "method_not_allowed", 405);
        return json({ status: "healthy" });
      }
      requireValue(request.method === "POST" && action !== "health", "method_not_allowed", 405);
      requireValue(action && Object.hasOwn(ACTION_FIELDS, action), "unknown_action", 404);
      requireValue(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json", "unsupported_media_type", 415);
      requireValue(!request.headers.has("content-encoding") || request.headers.get("content-encoding") === "identity", "unsupported_media_type", 415);
      const scope = deadline(timeouts.body, request.signal, new Fault("request_timeout", 408));
      let input: ObjectValue;
      try {
        input = object(parseJson(await readBytes(request.body, request.headers, LIMITS.body, scope, new Fault("request_too_large", 413)), "invalid_json", 400));
      } catch (error) {
        if (error instanceof Fault) throw error;
        throw new Fault(request.signal.aborted ? "request_aborted" : "invalid_json", request.signal.aborted ? 408 : 400);
      } finally { scope.dispose(); }
      fields(input, ACTION_FIELDS[action]);
      const key = text(input.key, 4096, "invalid_key");
      requireValue(/^[\x21-\x7e]+$/.test(key), "invalid_key");
      const provider = input.provider;

      if (action === "script" || action === "extract-assets") {
        requireValue(provider === "gemini" || provider === "deepseek", "invalid_provider");
        const prompt = text(input.prompt, 32_000, "invalid_prompt");
        const schema = action === "script" ? SCRIPT_SCHEMA : ASSETS_SCHEMA;
        const instruction = action === "script" ? SCRIPT_INSTRUCTION : ASSETS_INSTRUCTION;
        const validate = action === "script" ? validateScript : validateAssets;
        const code = action === "script" ? "invalid_script" : "invalid_assets";
        let generated: string;
        if (provider === "gemini") {
          const data = await upstream(request, ENDPOINTS.gemini, key, { paid: true, gemini: true, body: {
            model: model(input.model, "gemini-4-hydrogen", /^gemini-[A-Za-z0-9._-]+$/),
            input: prompt, system_instruction: instruction, store: false, stream: false,
            response_format: { type: "text", mime_type: "application/json", schema },
          } });
          generated = geminiText(data, code);
        } else {
          const data = await upstream(request, ENDPOINTS.deepseek, key, { paid: true, body: {
            model: model(input.model, "deepseek-flash", /^deepseek-[A-Za-z0-9._-]+$/), stream: false,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: instruction }, { role: "user", content: prompt }],
          } });
          requireValue(Array.isArray(data.choices) && data.choices.length === 1, code, 502);
          const choice = object(data.choices[0], code, 502);
          requireValue(choice.finish_reason === "stop", code, 502);
          generated = text(object(choice.message, code, 502).content, LIMITS.json, code, 502);
        }
        return json(validate(generated));
      }
      if (action === "image") {
        if (provider === "siliconflow") {
          const data = await upstream(request, ENDPOINTS.siliconflow, key, { paid: true, body: {
            model: model(input.model, "black-forest-labs/FLUX.1-schnell", /^black-forest-labs\/FLUX\.1-schnell$/),
            prompt: text(input.prompt, 32_000, "invalid_prompt"),
            image_size: "1024x1024", batch_size: 1, num_inference_steps: 4, output_format: "png",
          }});
          requireValue(Array.isArray(data.images) && data.images.length === 1, "invalid_upstream_response", 502);
          const image = object(data.images[0], "invalid_upstream_response", 502);
          return json(await fetchImage(request, text(image.url, 8192, "invalid_upstream_response", 502)));
        }
        requireValue(provider === "openai" || provider === "seedream", "invalid_provider");
        const data = await upstream(request, ENDPOINTS[provider], key, { paid: true, max: LIMITS.image, body: provider === "seedream" ? {
          model: model(input.model, "doubao-seedream-5-5-261028", /^(?:doubao-seedream-|ep-)[A-Za-z0-9._-]+$/),
          prompt: text(input.prompt, 32_000, "invalid_prompt"), size: "2K", response_format: "b64_json", output_format: "png",
        } : {
          model: model(input.model, "gpt-image-2.6-sunburst", /^(?:gpt-image-[A-Za-z0-9._-]+|chatgpt-image-latest)$/),
          prompt: text(input.prompt, 32_000, "invalid_prompt"), n: 1, output_format: "png",
        } });
        requireValue(Array.isArray(data.data) && data.data.length === 1, "invalid_upstream_response", 502);
        const encoded = base64(object(data.data[0], "invalid_upstream_response", 502).b64_json, LIMITS.image, "invalid_upstream_response", 502);
        requireValue(atob(encoded.slice(0, 12)).startsWith("\x89PNG\r\n\x1a\n"), "invalid_upstream_response", 502);
        return json({ base64: encoded, mime: "image/png" });
      }
      if (action === "voices") {
        requireValue(provider === "minimax", "invalid_provider");
        const data = await upstream(request, ENDPOINTS.voices, key, { body: { voice_type: "system" } });
        minimaxResult(data, true);
        requireValue(Array.isArray(data.system_voice) && data.system_voice.length <= 10_000, "invalid_upstream_response", 502);
        return json(data.system_voice.map((item) => {
          const voice = object(item, "invalid_upstream_response", 502);
          const id = text(voice.voice_id, 256, "invalid_upstream_response", 502);
          return { id, name: voice.voice_name === undefined ? id : text(voice.voice_name, 256, "invalid_upstream_response", 502) };
        }));
      }
      if (action === "speech") {
        requireValue(provider === "minimax", "invalid_provider");
        const speed = input.speed === undefined ? 1 : input.speed;
        requireValue(typeof speed === "number" && Number.isFinite(speed) && speed >= 0.5 && speed <= 2, "invalid_speed");
        const voiceId = text(input.voiceId, 256, "invalid_voice");
        requireValue(!/[\x00-\x1f\x7f]/.test(voiceId), "invalid_voice");
        const data = await upstream(request, ENDPOINTS.speech, key, { paid: true, max: LIMITS.audio * 2 + MiB, body: {
          model: model(input.model, "speech-2.8-hd", /^speech-[A-Za-z0-9._-]+$/),
          text: text(input.text, 10_000, "invalid_text"), stream: false, output_format: "hex",
          voice_setting: { voice_id: voiceId, speed }, audio_setting: { format: "wav", sample_rate: 32000, channel: 1 }, language_boost: "Chinese",
        } });
        minimaxResult(data, true);
        const hex = text(object(data.data, "invalid_upstream_response", 502).audio, LIMITS.audio * 2, "invalid_upstream_response", 502);
        requireValue(hex.length % 2 === 0 && /^[a-f0-9]+$/i.test(hex), "invalid_upstream_response", 502);
        const audio = new Uint8Array(hex.length / 2);
        for (let i = 0; i < audio.length; i++) audio[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        requireValue(audio.length >= 44 && new TextDecoder().decode(audio.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(audio.subarray(8, 12)) === "WAVE", "invalid_upstream_response", 502);
        return new Response(audio, { headers: { ...HEADERS, "Content-Type": "audio/wav", "Content-Disposition": 'attachment; filename="speech.wav"' } });
      }
      requireValue(provider === "seedance" || provider === "minimax", "invalid_provider");
      if (action === "video-create") {
        const duration = input.duration;
        requireValue(typeof duration === "number" && Number.isInteger(duration) && duration >= 4 && duration <= 15, "invalid_duration");
        const references = images(input.images);
        const selectedModel = provider === "seedance"
          ? model(input.model, "doubao-seedance-2-0-fast-260128", /^(?:doubao-seedance-|ep-)[A-Za-z0-9._-]+$/)
          : model(input.model, "MiniMax-H3", /^MiniMax-H3(?:-Highspeed|-Lite|-Max)?$/);
        requireValue(selectedModel !== "MiniMax-H3-Max" || duration >= 5, "invalid_duration");
        const content = [
          { type: "text", text: text(input.prompt, 7000, "invalid_prompt") },
          ...references.map((image) => ({ type: "image_url", image_url: { url: image.url }, role: image.role })),
        ];
        const data = await upstream(request, ENDPOINTS[provider], key, { paid: true, body: {
          model: selectedModel, content, duration, generate_audio: false,
          resolution: provider === "seedance" ? "720p" : "768P",
          ratio: references.some((image) => image.role === "first_frame") && (provider === "minimax" || selectedModel.startsWith("doubao-seedance-2-5-")) ? "adaptive" : "9:16",
        } });
        if (provider === "minimax") minimaxResult(data, false);
        const id = text(provider === "seedance" ? data.id : data.task_id, 128, "submission_unknown", 502);
        requireValue(/^[A-Za-z0-9_-]+$/.test(id), "submission_unknown", 502);
        return json({ id, status: "queued" });
      }
      const id = text(input.taskId, 128, "invalid_task_id");
      requireValue(/^[A-Za-z0-9_-]+$/.test(id), "invalid_task_id");
      const status = await videoStatus(request, provider, key, id);
      if (action === "video-status") return json(status);
      requireValue(status.status === "succeeded", "media_not_ready", 409);
      requireValue(status.url, "media_unavailable", 502);
      return await download(request, provider, status.url);
    } catch (error) { return failure(error); }
  };
}

export const handler = createHandler();

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
  siliconflow: "https://api.siliconflow.cn/v1/images/generations",
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
  contracts: ["for"],
  screenplay: ["provider", "key", "model", "prompt"],
  director: ["provider", "key", "model", "prompt"],
  "extract-characters": ["provider", "key", "model", "prompt"],
  "extract-scenes": ["provider", "key", "model", "prompt"],
  "extract-props": ["provider", "key", "model", "prompt"],
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
  retryAfter?: string;
  constructor(code: string, status = 400, retryAfter?: string) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
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
    headers: { ...HEADERS, ...(fault.status === 405 ? { Allow: "GET, POST" } : {}), ...(fault.retryAfter ? { "Retry-After": fault.retryAfter } : {}) },
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
function upstreamHttp(status: number, paid: boolean, retryAfter?: string): Fault {
  if (status === 401) return new Fault("provider_auth_failed", 401);
  if (status === 403) return new Fault("provider_forbidden", 403);
  if (status === 402) return new Fault("insufficient_balance", 402);
  if (status === 429) return new Fault("rate_limited", 429, retryAfter);
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
const ASSET_NAME_SCHEMA = { type: "string", minLength: 1, maxLength: 100 };
const ASSET_LIST_SCHEMA = { type: "array", maxItems: 30, items: {
  type: "object", properties: { name: ASSET_NAME_SCHEMA, description: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["name", "description"],
} };
const ASSET_REFS_SCHEMA = { type: "array", maxItems: 30, uniqueItems: true, items: ASSET_NAME_SCHEMA };
/**
 * 资产提取按品类分开：人物、场景、道具各自一次调用、各自一份提示词。
 * 三个 action 共用同一套 schema 工厂，只换清单的 key 与逐镜关联的 key。
 */
const EXTRACT_KINDS = ["characters", "scenes", "props"] as const;
type ExtractKind = typeof EXTRACT_KINDS[number];
const EXTRACT_KIND_SCHEMA = (key: ExtractKind) => ({
  type: "object",
  properties: {
    [key]: ASSET_LIST_SCHEMA,
    shots: { type: "array", minItems: 1, maxItems: 100, items: {
      type: "object",
      properties: { number: { type: "integer", minimum: 1, maximum: 100 }, [key]: ASSET_REFS_SCHEMA },
      required: ["number", key],
    } },
  },
  required: [key, "shots"],
});
const EXTRACT_CHARACTERS_SCHEMA = EXTRACT_KIND_SCHEMA("characters");
const EXTRACT_SCENES_SCHEMA = EXTRACT_KIND_SCHEMA("scenes");
const EXTRACT_PROPS_SCHEMA = EXTRACT_KIND_SCHEMA("props");
/**
 * 机器契约：只要求返回符合 schema 的 JSON，不含任何业务规则。
 * 业务规则由用户自己的提示词决定——后端不再注入任何默认提示词。
 */
const CONTRACT_PREFIX = "Return only a json object matching the schema below. Do not use markdown code fences. Schema: ";
const EXTRACT_CHARACTERS_INSTRUCTION = CONTRACT_PREFIX + JSON.stringify(EXTRACT_CHARACTERS_SCHEMA);
const EXTRACT_SCENES_INSTRUCTION = CONTRACT_PREFIX + JSON.stringify(EXTRACT_SCENES_SCHEMA);
const EXTRACT_PROPS_INSTRUCTION = CONTRACT_PREFIX + JSON.stringify(EXTRACT_PROPS_SCHEMA);
const SHOT_SIZES = ["远景", "全景", "中景", "近景", "特写"] as const;
const MOVEMENTS = ["固定", "推", "拉", "摇", "移", "跟", "升降", "环绕"] as const;
const ANGLES = ["平视", "俯视", "仰视"] as const;
/**
 * 景别允许单值，也允许「远景→中景」式拍内连镜（拍摄标准的节奏要求）。
 * 轻微偏差（如「中近景」）收敛到最近的合法值；完全没有合法景别才判非法。
 */
function normalizeShotSize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split("→").map(part => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > 3) return undefined;
  const resolved = parts.map(part => SHOT_SIZES.find(size => part.includes(size)));
  if (resolved.some(size => !size)) return undefined;
  return resolved.join("→");
}
const SCREENPLAY_SCHEMA = {
  type: "object",
  properties: {
    title: STRING_SCHEMA, logline: STRING_SCHEMA,
    screenplay: STRING_SCHEMA,
  },
  required: ["title", "screenplay"],
};
const DIRECTOR_SCHEMA = {
  type: "object",
  properties: {
    shots: { type: "array", minItems: 1, maxItems: 100, items: {
      type: "object",
      properties: {
        number: { type: "integer", minimum: 1, maximum: 100 },
        shotSize: { type: "string", description: "远景/全景/中景/近景/特写" },
        movement: { type: "string", enum: MOVEMENTS },
        angle: { type: "string", enum: ANGLES },
        start: STRING_SCHEMA, action: STRING_SCHEMA, end: STRING_SCHEMA,
      },
      required: ["number", "shotSize", "movement", "angle", "start", "action", "end"],
    } },
  },
  required: ["shots"],
};
const SCREENPLAY_INSTRUCTION = CONTRACT_PREFIX + JSON.stringify(SCREENPLAY_SCHEMA);
const DIRECTOR_INSTRUCTION = CONTRACT_PREFIX + JSON.stringify(DIRECTOR_SCHEMA);

function validateScreenplay(raw: string): ObjectValue {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Fault("invalid_screenplay", 502); }
  const source = object(parsed, "invalid_screenplay", 502);
  // 剧本结构由用户自己的提示词决定：后端只校验「是一份非空文本」，不再强制四部分、
  // 【镜头：类型】标记与时长区间。拆不出镜头由前端降级处理。
  const screenplay = text(source.screenplay, 60000, "invalid_screenplay", 502);
  const result: ObjectValue = { screenplay };
  if (source.title !== undefined) result.title = text(source.title, 200, "invalid_screenplay", 502);
  if (source.logline !== undefined) result.logline = text(source.logline, 2000, "invalid_screenplay", 502);
  return result;
}
function validateDirector(raw: string): ObjectValue {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Fault("invalid_director", 502); }
  const source = object(parsed, "invalid_director", 502);
  requireValue(Array.isArray(source.shots) && source.shots.length >= 1 && source.shots.length <= 100, "invalid_director", 502);
  const numbers = new Set<number>();
  const shots = source.shots.map((item) => {
    const shot = object(item, "invalid_director", 502);
    requireValue(typeof shot.number === "number" && Number.isInteger(shot.number) && shot.number >= 1 && shot.number <= 100 && !numbers.has(shot.number), "invalid_director", 502);
    numbers.add(shot.number);
    const shotSize = normalizeShotSize(shot.shotSize);
    requireValue(shotSize !== undefined, "invalid_director", 502);
    requireValue(MOVEMENTS.includes(shot.movement as typeof MOVEMENTS[number]), "invalid_director", 502);
    requireValue(ANGLES.includes(shot.angle as typeof ANGLES[number]), "invalid_director", 502);
    return {
      number: shot.number,
      shotSize,
      movement: shot.movement as typeof MOVEMENTS[number],
      angle: shot.angle as typeof ANGLES[number],
      start: text(shot.start, 8000, "invalid_director", 502),
      action: text(shot.action, 8000, "invalid_director", 502),
      end: text(shot.end, 8000, "invalid_director", 502),
    };
  });
  return { shots };
}
const textActions: Record<string, { schema: unknown; instruction: string; validate: (raw: string) => ObjectValue; code: string }> = {
  "extract-characters": { schema: EXTRACT_CHARACTERS_SCHEMA, instruction: EXTRACT_CHARACTERS_INSTRUCTION, validate: raw => validateExtractCategory(raw, "characters"), code: "invalid_assets" },
  "extract-scenes": { schema: EXTRACT_SCENES_SCHEMA, instruction: EXTRACT_SCENES_INSTRUCTION, validate: raw => validateExtractCategory(raw, "scenes"), code: "invalid_assets" },
  "extract-props": { schema: EXTRACT_PROPS_SCHEMA, instruction: EXTRACT_PROPS_INSTRUCTION, validate: raw => validateExtractCategory(raw, "props"), code: "invalid_assets" },
  screenplay: { schema: SCREENPLAY_SCHEMA, instruction: SCREENPLAY_INSTRUCTION, validate: validateScreenplay, code: "invalid_screenplay" },
  director: { schema: DIRECTOR_SCHEMA, instruction: DIRECTOR_INSTRUCTION, validate: validateDirector, code: "invalid_director" },
};
function validateExtractCategory(raw: string, key: ExtractKind): ObjectValue {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Fault("invalid_assets", 502); }
  const source = object(parsed, "invalid_assets", 502);
  const list = source[key];
  requireValue(Array.isArray(list) && list.length <= 30, "invalid_assets", 502);
  const names = new Set<string>();
  const assets = list.map(item => {
    const asset = object(item, "invalid_assets", 502);
    const name = text(asset.name, 100, "invalid_assets", 502);
    requireValue(!names.has(name), "invalid_assets", 502);
    names.add(name);
    return { name, description: text(asset.description, 4000, "invalid_assets", 502) };
  });
  // 逐镜关联是可选的：用户没在提示词里要求逐镜对应时，模型可能不返回 shots。
  const rows = source.shots === undefined ? [] : source.shots;
  requireValue(Array.isArray(rows) && rows.length <= 100, "invalid_assets", 502);
  const numbers = new Set<number>();
  const shots = rows.map((item) => {
    const shot = object(item, "invalid_assets", 502);
    requireValue(typeof shot.number === "number" && Number.isInteger(shot.number) && shot.number >= 1 && shot.number <= 100 && !numbers.has(shot.number), "invalid_assets", 502);
    numbers.add(shot.number);
    const refs = shot[key];
    requireValue(Array.isArray(refs) && refs.length <= 30, "invalid_assets", 502);
    const seen = new Set<string>();
    return { number: shot.number, [key]: refs.map(ref => {
      const name = text(ref, 100, "invalid_assets", 502);
      requireValue(names.has(name) && !seen.has(name), "invalid_assets", 502);
      seen.add(name);
      return name;
    }) };
  });
  return { [key]: assets, shots };
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
    body?: ObjectValue; paid?: boolean; gemini?: boolean; max?: number; headers?: Record<string, string>;
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
          ...(options.gemini ? { "x-goog-api-key": key, "Api-Revision": "2026-05-20" } : { Authorization: `Bearer ${key}` }), ...(options.headers ?? {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      }));
      if (!response.ok) throw upstreamHttp(response.status, paid, response.headers.get("retry-after") ?? undefined);
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
      // 只读契约：告诉前端模型会收到的固定指令与返回结构。不需要 key、不调用上游、不计费。
      if (action === "contracts") {
        const target = text(input.for, 40, "invalid_action");
        const textAction = textActions[target];
        requireValue(textAction !== undefined, "invalid_action");
        return json({ instruction: textAction.instruction, schema: textAction.schema });
      }
      const key = text(input.key, 4096, "invalid_key");
      requireValue(/^[\x21-\x7e]+$/.test(key), "invalid_key");
      const provider = input.provider;

      const textAction = textActions[action];
      if (textAction) {
        requireValue(provider === "gemini" || provider === "deepseek", "invalid_provider");
        const prompt = text(input.prompt, 32_000, "invalid_prompt");
        const { schema, instruction, validate, code } = textAction;
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
          const data = await upstream(request, ENDPOINTS.siliconflow, key, { paid: true, headers: { "X-Enable-Watermark": "0" }, body: {
            model: model(input.model, "Kwai-Kolors/Kolors", /^Kwai-Kolors\/Kolors$/),
            prompt: text(input.prompt, 32_000, "invalid_prompt"),
            negative_prompt: "水印, 文字, 签名, logo, 低质量, 模糊",
            image_size: "1024x1024", batch_size: 1, output_format: "png",
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

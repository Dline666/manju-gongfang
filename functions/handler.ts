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
  openaiEdits: "https://api.openai.com/v1/images/edits",
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
  screenplay: ["provider", "key", "model", "prompt", "baseUrl", "jsonMode"],
  director: ["provider", "key", "model", "prompt", "baseUrl", "jsonMode"],
  "extract-characters": ["provider", "key", "model", "prompt", "baseUrl", "jsonMode"],
  "extract-scenes": ["provider", "key", "model", "prompt", "baseUrl", "jsonMode"],
  "extract-props": ["provider", "key", "model", "prompt", "baseUrl", "jsonMode"],
  image: ["provider", "key", "model", "prompt", "baseUrl", "reference"],
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
  /** 服务商的错误原文：透传给界面，别把「没有可用渠道」说成「稍后再试」。 */
  detail?: string;
  constructor(code: string, status = 400, retryAfter?: string, detail?: string) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.detail = detail;
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
/**
 * 自定义端点的模型 ID：允许 org/model、gpt-4o、qwen-max 这类自由写法。
 * 缺失时直接报错——绝不能像内置平台那样套默认模型名，那会变成一次意外的付费请求。
 */
function customModel(value: unknown): string {
  const result = text(value, 128, "invalid_model");
  requireValue(/^[A-Za-z0-9._:\/-]{1,128}$/.test(result), "invalid_model");
  return result;
}
/**
 * SiliconFlow 生图模型：无参考图时维持只开放 Kolors（现有文本路径不变）；
 * 有参考图时只接受 Edit/Kontext 系列——官方 image 字段仅对这些模型生效。
 * 其它模型明确报 reference_not_supported，而不是把参考图静默丢掉。
 */
function siliconflowModel(value: unknown, withReference: boolean): string {
  if (!withReference) return model(value, "Kwai-Kolors/Kolors", /^Kwai-Kolors\/Kolors$/);
  const result = model(value, "Kwai-Kolors/Kolors", /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
  requireValue(/(?:edit|kontext)/i.test(result.slice(result.indexOf("/") + 1)), "reference_not_supported", 422);
  return result;
}
function json(data: unknown): Response {
  return Response.json({ ok: true, data }, { headers: HEADERS });
}
function failure(error: unknown): Response {
  const fault = error instanceof Fault ? error : new Fault("internal_error", 500);
  return Response.json({ ok: false, error: fault.code, ...(fault.detail ? { detail: fault.detail } : {}) }, {
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
/**
 * 服务商的错误原文：自定义端点最有用的信息往往在这里
 * （例如「No available channel for model X under group Y」——重试没用，要改分组或模型）。
 */
async function upstreamDetail(response: Response, scope: Deadline, key: string): Promise<string | undefined> {
  try {
    const bytes = await readBytes(response.body, response.headers, 4096, scope, new Fault("upstream_too_large", 502));
    const parsed = parseJson(bytes, "invalid_upstream_response", 502);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : undefined;
    const message = [nested?.message, nested?.code, record.message, record.code, record.detail]
      .find(value => typeof value === "string" && value.trim().length > 0);
    if (typeof message !== "string") return undefined;
    // 有些服务端会把凭据回显在报错里：回传前先抹掉。
    return message.trim().split(key).join("***").slice(0, 240);
  } catch { return undefined; }
}
/** 「这个模型在你的分组下没有渠道」这一类：换 Key、改分组或改模型才有意义，重试没用。 */
const NO_CHANNEL = /no available channel|no candidates|model_not_found|not a public model|no available/i;
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
/**
 * 新形态的参考图：只接受前端从 IndexedDB 读出来的本地 data URL（最多 1 张、解码后 ≤5MB）。
 * 不接收远程 URL——后端不需要为图生图再放开一条下载通道，SSRF 面保持现状。
 * 格式必须与文件头一致，避免把改了扩展名的文件转给付费接口。
 */
const REFERENCE_BYTES = 5 * MiB;
const REFERENCE_CHARS = Math.ceil(REFERENCE_BYTES * 4 / 3) + 128;
type ReferenceImage = { url: string; base64: string; mime: string; extension: string };
function referenceImage(value: unknown): ReferenceImage | undefined {
  if (value === undefined) return undefined;
  const url = text(value, REFERENCE_CHARS, "invalid_reference_image");
  const match = /^data:image\/(png|jpeg|webp);base64,/.exec(url);
  requireValue(match, "invalid_reference_image");
  const encoded = base64(url.slice(match[0].length), REFERENCE_CHARS, "invalid_reference_image", 400);
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const size = encoded.length / 4 * 3 - padding;
  requireValue(size > 0 && size <= REFERENCE_BYTES, "invalid_reference_image");
  // 只解码够判断文件头的长度：data URL 最长可达 7MB，整体解码没有意义。
  const signature = atob(encoded.slice(0, 24));
  const png = signature.startsWith("\x89PNG\r\n\x1a\n");
  const jpeg = signature.charCodeAt(0) === 0xff && signature.charCodeAt(1) === 0xd8 && signature.charCodeAt(2) === 0xff;
  const webp = signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP";
  const type = match[1];
  requireValue(type === "png" ? png : type === "jpeg" ? jpeg : webp, "invalid_reference_image");
  return { url, base64: encoded, mime: `image/${type}`, extension: type === "jpeg" ? "jpg" : type };
}
/** OpenAI Images Edits 要的是文件而不是 data URL；只按校验过的 base64 组装 Blob。 */
function referenceBlob(reference: ReferenceImage): Blob {
  const binary = atob(reference.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: reference.mime });
}
/**
 * 自定义 OpenAI 兼容端点的图片结果。
 * 端点必须按 `response_format: b64_json` 返回；只给 url 的端点不代理未知地址，
 * 而是把实际返回字段带回界面（New API 会在 response_format=b64_json 时代为转 base64）。
 * 图片格式接受 PNG / JPEG / WebP，与前端 validatesImage 的口径一致。
 */
function customImage(data: ObjectValue): { base64: string; mime: string } {
  requireValue(Array.isArray(data.data) && data.data.length === 1, "invalid_upstream_response", 502);
  const item = object(data.data[0], "invalid_upstream_response", 502);
  if (typeof item.b64_json !== "string") {
    throw new Fault("invalid_upstream_response", 502, undefined, `返回字段：${Object.keys(item).join("、") || "空"}；请让端点返回 b64_json`);
  }
  const encoded = base64(item.b64_json, LIMITS.image, "invalid_upstream_response", 502);
  const head = atob(encoded.slice(0, 24));
  const mime = head.startsWith("\x89PNG\r\n\x1a\n") ? "image/png"
    : head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8 && head.charCodeAt(2) === 0xff ? "image/jpeg"
      : head.startsWith("RIFF") && head.slice(8, 12) === "WEBP" ? "image/webp" : undefined;
  if (!mime) throw new Fault("invalid_upstream_response", 502, undefined, "返回的图片既不是 PNG、JPEG 也不是 WebP");
  return { base64: encoded, mime };
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
  // 运行时能不能做 DNS 判定：能就要求解析出的地址全是公网 IP，不能就退回字符串判定。
  const dnsAvailable = dependencies.resolveHost !== undefined ||
    Boolean((globalThis as typeof globalThis & { Deno?: { resolveDns?: unknown } }).Deno?.resolveDns);
  const timeouts = { body: 15_000, generation: 120_000, query: 20_000, media: 90_000, ...dependencies.timeouts };

  /**
   * 自定义端点的 Base URL：字符串判定 + DNS 判定，两层都过才放行。
   * 字符串层沿用 publicUrl 的口径，并额外拒绝 query（query 会让路径拼接出错）；
   * DNS 层要求解析出的地址全是公网 IP，挡住「公网域名解析到内网」这类 SSRF。
   */
  async function safeBaseUrl(value: unknown): Promise<string> {
    const raw = text(value, 2048, "invalid_base_url");
    let url: URL;
    try { url = new URL(raw); } catch { throw new Fault("invalid_base_url", 400); }
    requireValue(url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash && !url.search, "invalid_base_url", 400);
    const hostname = url.hostname;
    requireValue(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(hostname) &&
      !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(hostname) &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(hostname), "invalid_base_url", 400);
    if (dnsAvailable) {
      let addresses: string[] = [];
      try { addresses = await dns(hostname); } catch { addresses = []; }
      requireValue(addresses.length > 0 && addresses.every(publicIp), "invalid_base_url", 400);
    }
    return raw.replace(/\/+$/, "");
  }

  async function upstream(request: Request, url: string, key: string, options: {
    body?: ObjectValue; form?: FormData; paid?: boolean; gemini?: boolean; max?: number; headers?: Record<string, string>; surfaceErrors?: boolean;
  } = {}): Promise<ObjectValue> {
    const paid = options.paid === true;
    const scope = deadline(paid ? timeouts.generation : timeouts.query, request.signal,
      new Fault(options.surfaceErrors ? "endpoint_timeout" : paid ? "submission_unknown" : "upstream_timeout", 504));
    let response: Response | undefined;
    try {
      requireValue(!request.signal.aborted, "request_aborted", 408);
      response = await scope.run(fetcher(url, {
        method: options.body || options.form ? "POST" : "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: scope.signal,
        // multipart 的 boundary 必须由运行时生成；手动写 Content-Type 会毁掉整个请求。
        headers: { ...(options.form ? {} : { "Content-Type": "application/json" }), Accept: "application/json",
          ...(options.gemini ? { "x-goog-api-key": key, "Api-Revision": "2026-05-20" } : { Authorization: `Bearer ${key}` }), ...(options.headers ?? {}) },
        ...(options.form ? { body: options.form } : options.body ? { body: JSON.stringify(options.body) } : {}),
      }));
      if (!response.ok) {
        if (!options.surfaceErrors) throw upstreamHttp(response.status, paid, response.headers.get("retry-after") ?? undefined);
        // 自定义端点：把服务商原文带回去。「没有可用渠道」不能报成「提交结果未知、别重复付费」。
        const detail = await upstreamDetail(response, scope, key);
        if (detail && NO_CHANNEL.test(detail)) throw new Fault("endpoint_model_unavailable", 502, undefined, detail);
        const fault = upstreamHttp(response.status, paid, response.headers.get("retry-after") ?? undefined);
        throw new Fault(fault.code, fault.status, fault.retryAfter, detail);
      }
      requireValue(!response.redirected, "invalid_upstream_response", 502);
      const bytes = await readBytes(response.body, response.headers, options.max ?? LIMITS.json, scope, new Fault("upstream_too_large", 502));
      // 自定义端点最常见的配置错误：Base URL 少了 /v1，网关返回 SPA 的 HTML。
      // 这种情况不能只说「结果未知」，要把定位方向直接写出来。
      if (options.surfaceErrors && new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().startsWith("<")) {
        throw new Fault("invalid_upstream_response", 502, undefined, "上游返回 HTML 而不是 JSON：请检查 Base URL 是否指向 OpenAI 兼容接口（通常以 /v1 结尾）");
      }
      const data = object(parseJson(bytes, "invalid_upstream_response", 502), "invalid_upstream_response", 502);
      if (data.type === "error" || (data.error && !["failed", "cancelled", "expired"].includes(String(data.status)))) {
        throw new Fault("provider_rejected", 422);
      }
      return data;
    } catch (error) {
      // 上游挂死时，fetch 会先因 abort 抛出网络错误，抢在超时信号前面；
      // 所以要先看时限是否已到，才能把「端点没回话」和「请求失败」分开。
      const timedOut = options.surfaceErrors === true && scope.signal.aborted && !request.signal.aborted;
      scope.abort();
      if (error instanceof Fault) throw error;
      if (timedOut) throw new Fault("endpoint_timeout", 504);
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
        requireValue(provider === "gemini" || provider === "deepseek" || provider === "openai-compatible", "invalid_provider");
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
        } else if (provider === "deepseek") {
          const data = await upstream(request, ENDPOINTS.deepseek, key, { paid: true, body: {
            model: model(input.model, "deepseek-flash", /^deepseek-[A-Za-z0-9._-]+$/), stream: false,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: instruction }, { role: "user", content: prompt }],
          } });
          requireValue(Array.isArray(data.choices) && data.choices.length === 1, code, 502);
          const choice = object(data.choices[0], code, 502);
          requireValue(choice.finish_reason === "stop", code, 502);
          generated = text(object(choice.message, code, 502).content, LIMITS.json, code, 502);
        } else {
          // 自定义端点：OpenAI 兼容的 chat/completions。jsonMode=false 时不发 response_format，
          // 兼容不支持该参数的老中转站——此时只靠 system 指令约束 JSON。
          const base = await safeBaseUrl(input.baseUrl);
          const data = await upstream(request, `${base}/chat/completions`, key, { paid: true, surfaceErrors: true, body: {
            model: customModel(input.model), stream: false,
            ...(input.jsonMode === false ? {} : { response_format: { type: "json_object" } }),
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
          // SiliconFlow 的 image 字段只对 Edit/Kontext 系列模型生效；Kolors 是纯文生图。
          // 参考图存在时不静默丢掉：要么明确要求换模型，要么按官方字段发出去。
          const reference = referenceImage(input.reference);
          const selectedModel = siliconflowModel(input.model, reference !== undefined);
          const data = await upstream(request, ENDPOINTS.siliconflow, key, { paid: true, headers: { "X-Enable-Watermark": "0" }, body: {
            model: selectedModel,
            prompt: text(input.prompt, 32_000, "invalid_prompt"),
            negative_prompt: "水印, 文字, 签名, logo, 低质量, 模糊",
            image_size: "1024x1024", batch_size: 1, output_format: "png",
            ...(reference ? { image: reference.url } : {}),
          }});
          requireValue(Array.isArray(data.images) && data.images.length === 1, "invalid_upstream_response", 502);
          const image = object(data.images[0], "invalid_upstream_response", 502);
          return json(await fetchImage(request, text(image.url, 8192, "invalid_upstream_response", 502)));
        }
        if (provider === "openai-compatible") {
          // 自定义端点生图：只接受 base64，不代理任意图片 URL，避免把 SSRF 面扩大到 CDN 白名单之外。
          const base = await safeBaseUrl(input.baseUrl);
          const reference = referenceImage(input.reference);
          const prompt = text(input.prompt, 32_000, "invalid_prompt");
          if (reference) {
            // OpenAI 兼容的图生图走 Images Edits 的 multipart 契约；没有这个接口的中转站
            // 会由 surfaceErrors 把上游原文带回来，而不是假装成功。
            // New API 这类网关默认返回 data[0].url；显式要 b64_json 才会代为转 base64。
            const form = new FormData();
            form.append("model", customModel(input.model));
            form.append("prompt", prompt);
            form.append("n", "1");
            form.append("response_format", "b64_json");
            form.append("image", referenceBlob(reference), `reference.${reference.extension}`);
            const edited = await upstream(request, `${base}/images/edits`, key, { paid: true, surfaceErrors: true, max: LIMITS.image, form });
            return json(customImage(edited));
          }
          const data = await upstream(request, `${base}/images/generations`, key, { paid: true, surfaceErrors: true, max: LIMITS.image, body: {
            model: customModel(input.model),
            prompt, n: 1, response_format: "b64_json",
          } });
          return json(customImage(data));
        }
        requireValue(provider === "openai" || provider === "seedream", "invalid_provider");
        const reference = referenceImage(input.reference);
        const prompt = text(input.prompt, 32_000, "invalid_prompt");
        let data: ObjectValue;
        if (provider === "openai") {
          const selectedModel = model(input.model, "gpt-image-2.6-sunburst", /^(?:gpt-image-[A-Za-z0-9._-]+|chatgpt-image-latest)$/);
          if (reference) {
            // https://platform.openai.com/docs/api-reference/images/createEdit — multipart，图片作为文件字段。
            const form = new FormData();
            form.append("model", selectedModel);
            form.append("prompt", prompt);
            form.append("n", "1");
            form.append("output_format", "png");
            form.append("image", referenceBlob(reference), `reference.${reference.extension}`);
            data = await upstream(request, ENDPOINTS.openaiEdits, key, { paid: true, max: LIMITS.image, form });
          } else {
            data = await upstream(request, ENDPOINTS.openai, key, { paid: true, max: LIMITS.image, body: {
              model: selectedModel, prompt, n: 1, output_format: "png",
            } });
          }
        } else {
          // 火山方舟 Seedream 的 image 字段接受 base64 data URL（单图可传字符串），传了就按图生图处理。
          data = await upstream(request, ENDPOINTS.seedream, key, { paid: true, max: LIMITS.image, body: {
            model: model(input.model, "doubao-seedream-5-5-261028", /^(?:doubao-seedream-|ep-)[A-Za-z0-9._-]+$/),
            prompt, size: "2K", response_format: "b64_json", output_format: "png",
            ...(reference ? { image: reference.url } : {}),
          } });
        }
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

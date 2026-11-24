import { getStudio, setProviderStatus } from '../store/studio';
import { endpointById, modelFor } from './endpoints';
import type { Capability, ProviderStatus } from '../domain/types';
const messages: Record<string, string> = {
  invalid_key: 'API Key 无效，请到设置页检查。', missing_key: '请先在设置页填写对应的 API Key。',
  missing_endpoint: '所选端点已被删除，请到设置页重新选择。',
  invalid_base_url: 'Base URL 必须是公网 https 地址（不能带非默认端口、IP、内网域名或查询参数）。',
  provider_auth_failed: '模型平台拒绝了此 Key，请检查密钥及账号地区。', provider_forbidden: '账号尚未开通此模型权限，请在官方平台检查。',
  invalid_model: '模型 ID 不符合平台要求，请到设置页检查。', provider_not_found: '模型或任务不存在，可能已过期。',
  endpoint_model_unavailable: '该端点下没有这个模型或渠道：请检查模型 ID，以及中转站的分组/渠道是否覆盖它。',
  endpoint_timeout: '端点在两分钟内没有返回：模型可能正在排队，或这条线路暂时不通。这次请求可能已经送达，请先到平台确认是否计费，再决定要不要重试。',
  provider_rejected: '模型平台拒绝了请求，请检查内容、模型权限及参考图。', invalid_images: '参考图格式或组合无效，首尾帧不能与参考图模式混用。',
  invalid_reference_image: '参考图数据无效：只支持 5MB 以内的 PNG / JPEG / WebP 本地图片。',
  reference_not_supported: '当前生图渠道不支持参考图，本次请求没有提交：请换用支持图生图的模型或端点（OpenAI / Seedream / 自定义端点，或 SiliconFlow 的 Edit 模型）。',
  request_too_large: '请求太大，请压缩参考图或减少图片数量。', upstream_timeout: '查询超时，已有任务不会重发，请稍后查询。',
  upstream_unavailable: '模型查询暂不可用，请稍后再试。', media_not_ready: '视频尚未完成，请等待任务结束。',
  rate_limited: '服务商请求过于频繁，请稍后查询或重试。', insufficient_balance: '服务商额度不足，请检查账户余额。',
  invalid_script: '剧本结构或总时长不符合要求，请修改主题后重新确认生成。',
  invalid_screenplay: '剧本结构或时长不符合要求（需要四部分结构、每个动作与对白块都标注【镜头】和时长），请修改主题或原文后重新生成。',
  invalid_director: '导演分镜结构不完整，请检查后重试，或改用本地补全。',
  invalid_assets: '资产提取结果或逐镜关联不完整，现有剧本与资产未被修改。',
  submission_unknown: '未收到服务商明确结果，请先检查已有任务，避免重复付费。',
  media_unavailable: '暂时无法下载这段素材，请从原平台下载后重新导入。',
  invalid_input: '请求参数不符合模型要求，请检查时长、模型和参考图。',
  upstream_error: '模型服务返回异常，请检查配置后再试。', service_unavailable: '生成服务暂不可用，请稍后重试。',
  unknown_action: '接口动作不受支持，请重启本地 Function 服务后重试。',
  local_service_unavailable: '本地服务没有响应：请确认本地 Function 正在运行（npm run dev:function），再重试。',
};
// 只读提示：一句话解决办法，不改 message，也不进持久化。
const hints = {
  credential: 'Key 错了：回设置页重新粘贴，并确认平台与地区',
  forbidden: '账号没开通该模型：到官方控制台开通',
  balance: '余额不足：充值后重试',
  rate: '请求太频繁：稍等片刻，或降低并发',
  model: '模型已下线或 ID 写错：换一个模型',
  unknown: '不确定是否已扣费：先查平台任务记录，别立刻重发',
  unavailable: '服务商暂时不可用：稍后重试',
  route: '服务版本不一致：重启本地 Function 服务后再试',
};
export function hintFor(code: string, status = 0): string | undefined {
  if (code === 'unknown_action') return hints.route;
  if (status === 401 || code === 'invalid_key' || code === 'provider_auth_failed') return hints.credential;
  if (status === 403 || code === 'provider_forbidden') return hints.forbidden;
  if (status === 402 || code === 'insufficient_balance') return hints.balance;
  if (status === 429 || code === 'rate_limited') return hints.rate;
  if (status === 404 || code === 'provider_not_found') return hints.model;
  if (status === 504 || code === 'submission_unknown') return hints.unknown;
  if (status >= 500 || code === 'upstream_unavailable') return hints.unavailable;
  return undefined;
}
export class ApiError extends Error {
  readonly hint?: string;
  /** 服务商返回的原文：单独一行展示，便于判断是模型、分组还是内容的问题。 */
  readonly detail?: string;
  constructor(public code: string, public status = 0, readonly retryAfter?: number, detail?: string) {
    super(messages[code] || '服务请求未完成，请检查模型配置和网络。');
    this.detail = detail;
    this.hint = hintFor(code, status);
  }
}
/**
 * 取出某个端点的调用凭据：provider 是协议（后端只认协议），endpointId 是本地记账键。
 * 自定义端点额外带 baseUrl；模型 ID 按能力取，一个端点可以剧本与生图各用一个模型。
 */
export function credentials(endpointId: string, capability: Capability) {
  const state = getStudio();
  const endpoint = endpointById(state.settings, endpointId);
  if (!endpoint) throw new ApiError('missing_endpoint');
  const key = state.keys[endpointId];
  if (!key) throw new ApiError('missing_key');
  return {
    endpointId,
    provider: endpoint.protocol,
    key,
    model: modelFor(state.settings, endpointId, capability),
    ...(endpoint.baseUrl ? { baseUrl: endpoint.baseUrl } : {}),
  };
}
/** 生图请求：reference 是本地读取的 data URL，只在本次请求里出现，不进入项目存档。 */
export type ImageRequest = ReturnType<typeof credentials> & { prompt: string; reference?: string };
export type ImageResult = { base64: string; mime: string };
/**
 * 哪些生图渠道能在本次请求里接收参考图（与后端实现一致）。
 * 参数可以是本地端点 ID，也可以直接是端点协议：自定义端点常常长着
 * `custom-xxxx` 的 ID，但协议是 `openai-compatible`，不能按 ID 误判。
 * SiliconFlow 只有 Edit/Kontext 系列模型支持 image 字段，Kolors 会被后端明确拒绝。
 * UI 用它提前说明「这次会被拒绝」，后端仍然做最终判定。
 */
export function supportsImageReference(provider: string, model = ''): boolean {
  const protocol = endpointById(getStudio().settings, provider)?.protocol ?? provider;
  if (protocol === 'siliconflow') return /(?:edit|kontext)/i.test(model.slice(model.indexOf('/') + 1));
  return protocol === 'openai' || protocol === 'seedream' || protocol === 'openai-compatible';
}
async function request(action: string, payload: object, signal?: AbortSignal) {
  const body: Record<string, unknown> = { ...payload };
  // endpointId 只用于本地记账，不发给后端（后端按 provider 协议分派）。
  delete body.endpointId;
  if (['voices', 'video-status', 'video-download'].includes(action)) delete body.model;
  let response: Response;
  try { response = await fetch(`/functions/v1/app?action=${encodeURIComponent(action)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', signal }); }
  catch (error) { if (signal?.aborted) throw error; throw new ApiError('submission_unknown'); }
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    const header = response.headers.get('Retry-After');
    const seconds = header === null ? 0 : Number(header);
    // 后端自己的错误一定带 JSON 信封（{ok:false,error:code}）；没有信封说明请求压根没到后端
    // （本地 Function 没起、dev 代理 502、网关拦截），这时要说清是「服务没连上」，而不是让人去查模型配置。
    const code = typeof error?.error === 'string' ? error.error
      : response.status === 401 ? 'invalid_key'
        : 'local_service_unavailable';
    throw new ApiError(code, response.status, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined, typeof error?.detail === 'string' ? error.detail : undefined);
  }
  return response;
}
function providerCallStatus(action: string, payload: object) {
  const { endpointId, provider, key, model } = payload as Partial<ReturnType<typeof credentials>>;
  return (status: ProviderStatus['status'], error?: unknown) => {
    if (!endpointId || !provider || typeof key !== 'string') return;
    setProviderStatus(endpointId, key, {
      status, action,
      model: !['voices', 'video-status', 'video-download'].includes(action) && typeof model === 'string' ? model : undefined,
      ...(status === 'failed' ? { error: error instanceof ApiError ? error.message : '操作未完成，请重试。', ...(error instanceof ApiError && error.hint ? { hint: error.hint } : {}) } : {}),
    });
  };
}
export async function callApi<T>(action: string, payload: object, signal?: AbortSignal): Promise<T> {
  const recordStatus = providerCallStatus(action, payload);
  try {
    const response = await request(action, payload, signal);
    const result = await response.json().catch(() => null);
    if (!result || result.ok !== true) throw new ApiError(result?.error || 'submission_unknown');
    recordStatus('available');
    return result.data as T;
  } catch (error) { recordStatus('failed', error); throw error; }
}
export async function callBinary(action: string, payload: object, signal?: AbortSignal) {
  const recordStatus = providerCallStatus(action, payload);
  try {
    const response = await request(action, payload, signal);
    if (response.headers.get('Content-Type')?.includes('application/json')) throw new ApiError('media_unavailable');
    const blob = await response.blob();
    // Preserve blob return behavior, but do not verify empty or non-media responses.
    if (!blob.size || !/^(audio|video)\//i.test(blob.type)) recordStatus('failed', new ApiError('media_unavailable'));
    else recordStatus('available');
    return blob;
  } catch (error) { recordStatus('failed', error); throw error; }
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : '操作未完成，请重试。'; }

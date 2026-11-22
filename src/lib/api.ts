import { getStudio, setProviderStatus } from '../store/studio';
import type { Provider, ProviderStatus } from '../domain/types';
const messages: Record<string, string> = {
  invalid_key: 'API Key 无效，请到设置页检查。', missing_key: '请先在设置页填写对应的 API Key。',
  provider_auth_failed: '模型平台拒绝了此 Key，请检查密钥及账号地区。', provider_forbidden: '账号尚未开通此模型权限，请在官方平台检查。',
  invalid_model: '模型 ID 不符合平台要求，请到设置页检查。', provider_not_found: '模型或任务不存在，可能已过期。',
  provider_rejected: '模型平台拒绝了请求，请检查内容、模型权限及参考图。', invalid_images: '参考图格式或组合无效，首尾帧不能与参考图模式混用。',
  request_too_large: '请求太大，请压缩参考图或减少图片数量。', upstream_timeout: '查询超时，已有任务不会重发，请稍后查询。',
  upstream_unavailable: '模型查询暂不可用，请稍后再试。', media_not_ready: '视频尚未完成，请等待任务结束。',
  rate_limited: '服务商请求过于频繁，请稍后查询或重试。', insufficient_balance: '服务商额度不足，请检查账户余额。',
  invalid_script: '剧本结构或总时长不符合要求，请修改主题后重新确认生成。',
  invalid_assets: '资产提取结果或逐镜关联不完整，现有剧本与资产未被修改。',
  submission_unknown: '未收到服务商明确结果，请先检查已有任务，避免重复付费。',
  media_unavailable: '暂时无法下载这段素材，请从原平台下载后重新导入。',
  invalid_input: '请求参数不符合模型要求，请检查时长、模型和参考图。',
  upstream_error: '模型服务返回异常，请检查配置后再试。', service_unavailable: '生成服务暂不可用，请稍后重试。',
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
};
export function hintFor(code: string, status = 0): string | undefined {
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
  constructor(public code: string, public status = 0) { super(messages[code] || '服务请求未完成，请检查模型配置和网络。'); this.hint = hintFor(code, status); }
}
export function credentials(provider: Provider) {
  const state = getStudio(); const key = state.keys[provider];
  if (!key) throw new ApiError('missing_key');
  return { provider, key, model: state.settings.models[provider] };
}
async function request(action: string, payload: object, signal?: AbortSignal) {
  const body: Record<string, unknown> = { ...payload };
  if (['voices', 'video-status', 'video-download'].includes(action)) delete body.model;
  let response: Response;
  try { response = await fetch(`/functions/v1/app?action=${encodeURIComponent(action)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', signal }); }
  catch (error) { if (signal?.aborted) throw error; throw new ApiError('submission_unknown'); }
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new ApiError(error?.error || (response.status === 401 ? 'invalid_key' : 'service_unavailable'), response.status);
  }
  return response;
}
function providerCallStatus(action: string, payload: object) {
  const { provider, key, model } = payload as Partial<ReturnType<typeof credentials>>;
  return (status: ProviderStatus['status'], error?: unknown) => {
    if (!provider || typeof key !== 'string') return;
    setProviderStatus(provider, key, {
      status, action,
      model: !['voices', 'video-status', 'video-download'].includes(action) && typeof model === 'string' ? model : undefined,
      ...(status === 'failed' ? { error: error instanceof ApiError ? error.message : '操作未完成，请重试。' } : {}),
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

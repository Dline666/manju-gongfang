import test from 'node:test';
import assert from 'node:assert/strict';
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, configurable: true });
const api = await import('../src/lib/api');

test('unknown_action 指向服务版本问题，而不是模型 ID 写错', () => {
  const error = new api.ApiError('unknown_action', 404);
  assert.match(error.message, /接口动作不受支持/);
  assert.equal(error.hint, '服务版本不一致：重启本地 Function 服务后再试');
  assert.notEqual(error.hint, '模型已下线或 ID 写错：换一个模型');
});

test('已知错误码的文案与提示保持原有口径', () => {
  const rejected = new api.ApiError('provider_rejected', 422);
  assert.equal(rejected.message, '模型平台拒绝了请求，请检查内容、模型权限及参考图。');
  assert.equal(rejected.hint, undefined);
  assert.equal(api.hintFor('invalid_key', 401), 'Key 错了：回设置页重新粘贴，并确认平台与地区');
  assert.equal(api.hintFor('provider_not_found', 404), '模型已下线或 ID 写错：换一个模型');
});

test('资产提取失败仍归到 invalid_assets，不被路由错误覆盖', () => {
  const error = new api.ApiError('invalid_assets', 400);
  assert.equal(error.message, '资产提取结果或逐镜关联不完整，现有剧本与资产未被修改。');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCustomEndpoint, endpointsFor, migrateSettings, modelFor, removeEndpoint, removedBuiltins, restoreEndpoint,
} from '../src/lib/endpoints';
import { defaultSettings, type Settings } from '../src/domain/types';
import { savedStudioSchema } from '../src/store/schema';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, configurable: true });
const store = await import('../src/store/studio');

function withEndpoint(settings: Settings = defaultSettings) {
  const endpoint = createCustomEndpoint('中转站');
  return { endpoint, settings: { ...settings, endpoints: [...settings.endpoints, endpoint], models: { ...settings.models, [endpoint.id]: { script: 'qwen-max', image: 'flux-1' } } } };
}

test('端点清单按能力过滤：内置平台与自定义端点一视同仁', () => {
  const { endpoint, settings } = withEndpoint();
  assert.deepEqual(endpointsFor(settings, 'script').map(item => item.id), ['gemini', 'deepseek', endpoint.id]);
  assert.deepEqual(endpointsFor(settings, 'image').map(item => item.id), ['openai', 'seedream', 'siliconflow', endpoint.id]);
  assert.ok(!endpointsFor(settings, 'video').some(item => item.id === endpoint.id), '自定义端点不接管视频');
  assert.equal(modelFor(settings, endpoint.id, 'script'), 'qwen-max');
  assert.equal(modelFor(settings, endpoint.id, 'video'), '');
});

test('删除内置端点后它从清单消失，且它改过的模型 ID 保留下来', () => {
  const settings: Settings = { ...defaultSettings, models: { ...defaultSettings.models, gemini: { script: 'my-own-gemini' } } };
  const next = removeEndpoint(settings, 'gemini');
  assert.ok(!next.endpoints.some(item => item.id === 'gemini'));
  assert.deepEqual(next.models.gemini, { script: 'my-own-gemini' }, '删除端点不动 models，恢复时模型 ID 还在');
  assert.deepEqual(removedBuiltins(next).map(item => item.id), ['gemini']);
  const restored = restoreEndpoint(next, 'gemini');
  assert.ok(restored.endpoints.some(item => item.id === 'gemini'));
  assert.deepEqual(restored.models.gemini, { script: 'my-own-gemini' });
  assert.deepEqual(removedBuiltins(restored), []);
});

test('删除正在使用的端点时，同环节自动改选；同组没有端点则留空', () => {
  const only = removeEndpoint({ ...defaultSettings, scriptProvider: 'deepseek' }, 'deepseek');
  assert.equal(only.scriptProvider, 'gemini', '同环节还有别的端点就自动改选');
  const none: Settings = { ...defaultSettings, endpoints: defaultSettings.endpoints.filter(item => item.id !== 'gemini' && item.id !== 'deepseek'), scriptProvider: 'gemini' };
  const empty = removeEndpoint(none, 'gemini');
  assert.equal(empty.scriptProvider, '', '同组没有端点就留空，交由界面提示');
});

test('旧存档迁移：补齐端点目录，扁平模型按能力映射', () => {
  const migrated = migrateSettings({
    scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance',
    models: { gemini: 'my-gemini', openai: 'my-openai' }, speechModel: 'speech-2.8-hd',
  });
  assert.equal(migrated.endpoints.length, 7);
  assert.deepEqual(migrated.models.gemini, { script: 'my-gemini' });
  assert.deepEqual(migrated.models.openai, { image: 'my-openai' });
  assert.deepEqual(migrated.models.deepseek, { script: 'deepseek-flash' }, '缺失的端点补默认模型');
  assert.equal(migrated.scriptProvider, 'gemini');
});

test('旧存档里指向已删端点的选择会落回可用端点', () => {
  const migrated = migrateSettings({ scriptProvider: 'gone', imageProvider: 'openai', videoProvider: 'seedance', models: {}, speechModel: 'speech-2.8-hd' });
  assert.equal(migrated.scriptProvider, 'gemini');
});

test('credentials 把端点翻译成协议：provider 是协议，baseUrl 只给自定义端点', async () => {
  const { credentials } = await import('../src/lib/api');
  const { endpoint, settings } = withEndpoint();
  store.setSettings(settings);
  store.setKey('openai', 'fixture-key');
  store.setKey(endpoint.id, 'fixture-key');
  const builtin = credentials('openai', 'image');
  assert.equal(builtin.provider, 'openai');
  assert.equal(builtin.endpointId, 'openai');
  assert.equal(builtin.baseUrl, undefined);
  assert.equal(builtin.model, 'gpt-image-2.6-sunburst');
  const custom = credentials(endpoint.id, 'script');
  assert.equal(custom.provider, 'openai-compatible');
  assert.equal(custom.endpointId, endpoint.id);
  assert.equal(custom.baseUrl, undefined, '还没填 Base URL 时不带这个字段');
  assert.equal(custom.model, 'qwen-max');
  store.setSettings({ ...settings, endpoints: settings.endpoints.map(item => item.id === endpoint.id ? { ...item, baseUrl: 'https://api.example.com/v1' } : item) });
  const withBase = credentials(endpoint.id, 'image');
  assert.equal(withBase.baseUrl, 'https://api.example.com/v1');
  assert.equal(withBase.model, 'flux-1');
  assert.throws(() => credentials('not-existing', 'image'), /端点/);
  store.setKey(endpoint.id, '');
  assert.throws(() => credentials(endpoint.id, 'image'), /Key/);
});

test('Key 不进存档，Base URL 进存档', () => {
  const { endpoint } = withEndpoint();
  store.setSettings({ ...defaultSettings, endpoints: [...defaultSettings.endpoints, { ...endpoint, baseUrl: 'https://api.example.com/v1' }] });
  store.setKey(endpoint.id, 'fixture-secret-key');
  const raw = values.get('manju-studio-v1')!;
  assert.ok(!raw.includes('fixture-secret-key'), 'Key 绝不落盘');
  assert.ok(raw.includes('https://api.example.com/v1'), 'Base URL 属于作品配置，落盘');
});

test('存档往返：自定义端点的名称、Base URL、能力与模型 ID 都不丢', () => {
  const { endpoint } = withEndpoint();
  const settings = {
    ...defaultSettings,
    endpoints: [...defaultSettings.endpoints, { ...endpoint, baseUrl: 'https://api.example.com/v1' }],
    models: { ...defaultSettings.models, [endpoint.id]: { script: 'qwen-max', image: 'flux-1' } },
  };
  const saved = savedStudioSchema.parse({ version: 1, projects: [], activeId: null, settings });
  const parsed = saved.settings.endpoints!.find(item => item.id === endpoint.id)!;
  assert.equal(parsed.name, '中转站');
  assert.equal(parsed.protocol, 'openai-compatible');
  assert.equal(parsed.baseUrl, 'https://api.example.com/v1');
  assert.deepEqual(parsed.capabilities, ['script', 'image']);
  const migrated = migrateSettings(saved.settings);
  assert.ok(migrated.endpoints.some(item => item.id === endpoint.id), '自定义端点刷新后还在');
  assert.equal(migrated.models[endpoint.id]!.image, 'flux-1');
  assert.equal(migrated.models[endpoint.id]!.script, 'qwen-max');
  assert.equal(migrated.endpoints.find(item => item.id === 'gemini')!.use, '剧本生成 · 首选', '内置端点的说明文字也要跟着存档往返');
});

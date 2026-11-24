import test from 'node:test';
import assert from 'node:assert/strict';
import { savedStudioSchema } from '../src/store/schema';
import { migrateSettings } from '../src/lib/endpoints';
import { defaultSettings, makeShot, uid } from '../src/domain/types';
import { putMedia } from '../src/store/media';
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, configurable: true });
const store = await import('../src/store/studio');

test('keys never enter persisted state, even when projects/settings change', () => {
  store.setKey('seedance', 'private-fixture-key');
  const project = store.createProject('原作品', '断剑');
  store.setSettings({ ...defaultSettings });
  store.updateProject(project.id, { name: '新的名字' });
  const raw = values.get('manju-studio-v1')!;
  assert.ok(!raw.includes('private-fixture-key'));
  assert.equal(JSON.parse(raw).keys, undefined);
  assert.equal(store.getStudio().keys.seedance, 'private-fixture-key');
  assert.doesNotThrow(() => savedStudioSchema.parse(JSON.parse(raw)));
  store.clearKeys();
  assert.deepEqual(store.getStudio().keys, {});
});

test('duplicate remaps nested references, drops tasks and remains independent', () => {
  const project = store.createProject('有资产的作品');
  const character = uid(); const voice = uid(); const reference = uid(); const cleared = uid(); const shot = makeShot(1);
  store.updateProject(project.id, { assets: [
    { id: character, kind: 'character', name: '主角', description: '青衣', lock: '青衣', voiceAssetId: voice, imageId: 'shared-image', referenceAssetId: reference },
    { id: voice, kind: 'voice', name: '音色', description: '', lock: '', voiceId: 'fixture-voice' },
    { id: reference, kind: 'prop', name: '雨夜山门', description: '', lock: '', imageId: 'reference-image' },
    { id: cleared, kind: 'character', name: '已清空', description: '', lock: '', referenceAssetId: '' },
  ], shots: [{ ...shot, assetIds: [character], references: [{ assetId: character, role: 'reference_image' }], dialogues: [{ id: uid(), speakerId: character, text: '开始吧。' }], task: { id: 'fixture-task', provider: 'seedance', model: 'fixture', revision: 0, status: 'running', createdAt: '' } }] });
  assert.doesNotThrow(() => savedStudioSchema.parse(JSON.parse(values.get('manju-studio-v1')!)), 'referenceAssetId 必须能存档');
  const copy = store.duplicateProject(project.id)!;
  assert.notEqual(copy.id, project.id);
  assert.equal(copy.shots[0].task, undefined);
  assert.notEqual(copy.shots[0].id, shot.id);
  assert.equal(copy.shots[0].references[0].assetId, copy.assets[0].id);
  assert.equal(copy.shots[0].dialogues[0].speakerId, copy.assets[0].id);
  assert.equal(copy.assets[0].voiceAssetId, copy.assets[1].id);
  assert.equal(copy.assets[0].referenceAssetId, copy.assets[2].id, '副本的参考图必须指向副本里的资产');
  assert.equal(copy.assets[3].referenceAssetId, '', '明确清空的状态在复制时保留，不能回落到基础形态');
  store.updateProject(copy.id, p => ({ ...p, assets: p.assets.map(a => ({ ...a, lock: '副本专属' })) }), true);
  assert.equal(store.getStudio().projects.find(p => p.id === project.id)!.assets[0].lock, '青衣');
  store.deleteProject(project.id);
  assert.ok(store.getStudio().projects.some(p => p.id === copy.id));
});

test('draft values remain readable while domain validation flags unfinished edits', () => {
  const p = store.createProject('编辑中');
  store.updateProject(p.id, { shots: [{ ...makeShot(1), duration: -1 }] });
  assert.doesNotThrow(() => savedStudioSchema.parse(JSON.parse(values.get('manju-studio-v1')!)));
  const saved = JSON.parse(values.get('manju-studio-v1')!);
  saved.projects[0].shots[0].video = { origin: 'upload', name: 'bad.mp4', duration: 9, url: 'blob:ephemeral' };
  assert.equal(savedStudioSchema.safeParse(saved).success, false);
});

test('video blobs are rejected before IndexedDB access', async () => {
  await assert.rejects(putMedia(new Blob(['video'], { type: 'video/mp4' })), /当前会话/);
});

test('legacy settings gain Seedream without replacing existing models or projects', () => {
  const saved = JSON.parse(values.get('manju-studio-v1')!);
  delete saved.settings.imageProvider;
  delete saved.settings.models.seedream;
  saved.settings.models.seedance = 'ep-original-custom-model';
  const restored = savedStudioSchema.parse(saved);
  assert.deepEqual(restored.projects, saved.projects);
  assert.equal(restored.settings.imageProvider, 'openai');
  // 存档本身不改写；端点清单与模型默认值由载入时的 migrateSettings 补齐。
  const migrated = migrateSettings(restored.settings);
  assert.deepEqual(migrated.models.seedream, { image: 'doubao-seedream-5-5-261028' }, '缺失的模型按端点能力补默认');
  assert.deepEqual(migrated.models.seedance, { video: 'ep-original-custom-model' }, '旧的扁平模型按能力迁移，用户改过的值不丢');
  assert.deepEqual(migrated.models.openai, { image: 'gpt-image-2.6-sunburst' });
  assert.equal(migrated.endpoints.length, 7, '旧存档载入后补齐内置端点目录');
  assert.equal(migrated.imageProvider, 'openai');
  const partial = savedStudioSchema.parse({ ...saved, settings: { ...saved.settings, models: { seedance: 'ep-original-custom-model' } } });
  assert.deepEqual(migrateSettings(partial.settings).models.seedance, { video: 'ep-original-custom-model' });
  store.setSettings({ ...migrated, imageProvider: 'seedream', models: { ...migrated.models, seedream: { image: 'ep-selected-image-model' } } });
  const selected = savedStudioSchema.parse(JSON.parse(values.get('manju-studio-v1')!));
  assert.equal(selected.settings.imageProvider, 'seedream');
  assert.deepEqual(selected.settings.models.seedream, { image: 'ep-selected-image-model' });
});

test('provider status is memory-only and invalidated by key changes', () => {
  store.clearKeys();
  store.setKey('seedream', ' private-fixture-key ');
  assert.equal(store.getStudio().providerStatus.seedream, undefined);
  store.setProviderStatus('seedream', 'private-fixture-key', { status: 'available', action: 'image', model: 'fixture-model' });
  store.setSettings({ ...defaultSettings });
  assert.equal(store.getStudio().providerStatus.seedream?.status, 'available');
  const saved = JSON.parse(values.get('manju-studio-v1')!);
  assert.equal(saved.providerStatus, undefined);
  assert.equal(saved.keys, undefined);
  assert.ok(!values.get('manju-studio-v1')!.includes('private-fixture-key'));
  store.setKey('seedream', 'private-fixture-key');
  assert.equal(store.getStudio().providerStatus.seedream?.status, 'available');
  store.setKey('seedream', 'replacement-key');
  assert.equal(store.getStudio().providerStatus.seedream, undefined);
  store.setProviderStatus('seedream', 'private-fixture-key', { status: 'failed', action: 'image' });
  assert.equal(store.getStudio().providerStatus.seedream, undefined, 'old key response must not mark replacement key');
  store.clearKeys();
  store.setProviderStatus('seedream', 'replacement-key', { status: 'available', action: 'image' });
  assert.deepEqual(store.getStudio().providerStatus, {});
});

test('API outcomes update channel status without retrying or leaking provider errors', async () => {
  const { callApi, callBinary, credentials } = await import('../src/lib/api');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  store.setKey('openai', 'fixture-key');
  store.setKey('seedream', 'unused-fallback-key');
  store.setKey('minimax', 'fixture-key');
  try {
    globalThis.fetch = async () => { calls++; return Response.json({ ok: true, data: { base64: 'fixture', mime: 'image/png' } }); };
    await callApi('image', credentials('openai', 'image'));
    assert.equal(store.getStudio().providerStatus.openai?.status, 'available');
    assert.equal(store.getStudio().providerStatus.openai?.model, defaultSettings.models.openai.image);
    globalThis.fetch = async () => { calls++; return Response.json({ error: 'provider_auth_failed', details: 'secret-upstream-message' }, { status: 401 }); };
    await assert.rejects(callApi('image', credentials('openai', 'image')), /拒绝/);
    assert.equal(calls, 2, 'failed paid requests are never retried or sent to another channel');
    assert.equal(store.getStudio().providerStatus.openai?.status, 'failed');
    assert.equal(store.getStudio().providerStatus.seedream, undefined);
    assert.ok(!JSON.stringify(store.getStudio().providerStatus).includes('secret-upstream-message'));
    globalThis.fetch = async () => { throw new Error('secret-network-message'); };
    await assert.rejects(callApi('image', credentials('openai', 'image')), /重复付费/);
    assert.ok(!JSON.stringify(store.getStudio().providerStatus).includes('secret-network-message'));
    globalThis.fetch = async () => Response.json({ ok: false, error: 'upstream_error' });
    await assert.rejects(callApi('image', credentials('openai', 'image')));
    assert.equal(store.getStudio().providerStatus.openai?.status, 'failed');
    globalThis.fetch = async () => new Response('audio-fixture', { headers: { 'Content-Type': 'audio/wav' } });
    await callBinary('speech', { ...credentials('minimax', 'speech'), model: defaultSettings.speechModel });
    assert.equal(store.getStudio().providerStatus.minimax?.status, 'available');
    assert.equal(store.getStudio().providerStatus.minimax?.model, defaultSettings.speechModel);
    globalThis.fetch = async () => new Response('', { headers: { 'Content-Type': 'audio/wav' } });
    await callBinary('speech', credentials('minimax', 'speech'));
    assert.equal(store.getStudio().providerStatus.minimax?.status, 'failed');
    globalThis.fetch = async () => Response.json({ ok: true, data: [] });
    await callApi('voices', credentials('minimax', 'speech'));
    assert.equal(store.getStudio().providerStatus.minimax?.model, undefined);
    globalThis.fetch = async () => { store.setKey('openai', 'changed-during-call'); return Response.json({ ok: true, data: {} }); };
    await callApi('image', credentials('openai', 'image'));
    assert.equal(store.getStudio().providerStatus.openai, undefined);
  } finally { globalThis.fetch = originalFetch; store.clearKeys(); }
});

test('scoped invalidation only marks listed shots; setAssetImage marks only related shots', () => {
  const p = store.createProject('范围失效');
  const a1 = uid(); const a2 = uid();
  const video = { origin: 'upload' as const, name: 'v.mp4', duration: 9 };
  const assets = [
    { id: a1, kind: 'character' as const, name: '甲', description: '', lock: '' },
    { id: a2, kind: 'scene' as const, name: '乙', description: '', lock: '' },
  ];
  store.updateProject(p.id, { assets, shots: [
    { ...makeShot(1), id: 'shot-a', assetIds: [a1], video },
    { ...makeShot(2), id: 'shot-b', assetIds: [a1], video },
    { ...makeShot(3), id: 'shot-c', assetIds: [a2], video },
  ] });
  store.updateProject(p.id, {}, { only: ['shot-b'] });
  let shots = store.getStudio().projects.find(item => item.id === p.id)!.shots;
  assert.deepEqual(shots.map(shot => !!shot.stale), [false, true, false]);

  store.setAssetImage(p.id, a1, 'image-1');
  const project = store.getStudio().projects.find(item => item.id === p.id)!;
  assert.equal(project.assets.find(asset => asset.id === a1)!.imageId, 'image-1');
  assert.deepEqual(project.shots.map(shot => !!shot.stale), [true, true, false], 'only shots using the asset are stale');
});

test('scoped invalidation writes staleReason only on affected shots', () => {
  const p = store.createProject('原因标记');
  const assetId = uid();
  const video = { origin: 'upload' as const, name: 'v.mp4', duration: 9 };
  store.updateProject(p.id, { assets: [{ id: assetId, kind: 'character' as const, name: '甲', description: '', lock: '旧布衣' }], shots: [
    { ...makeShot(1), id: 'shot-a', assetIds: [assetId], video },
    { ...makeShot(2), id: 'shot-b', video },
  ] });
  store.updateProject(p.id, {}, { only: ['shot-a'], reason: '资产「甲」已修改' });
  const shots = store.getStudio().projects.find(item => item.id === p.id)!.shots;
  assert.equal(shots[0].stale, true);
  assert.equal(shots[0].staleReason, '资产「甲」已修改');
  assert.ok(!shots[1].stale);
  assert.equal(shots[1].staleReason, undefined);
});

test('旧存档里的剧本占位人物在载入时清掉，台词保留说话人名字', () => {
  const empty = { id: 'ghost-1', kind: 'character' as const, name: '沈砚', description: '', lock: '' };
  const imported = { id: 'ghost-2', kind: 'character' as const, name: '阿青', description: '阿青，导入人物，外观待完善', lock: '阿青，导入人物，外观待完善' };
  const real = { id: 'real-1', kind: 'character' as const, name: '主角', description: '深色长衣', lock: '深色长衣' };
  const project = {
    ...store.createProject('旧作品', '断剑'),
    assets: [empty, imported, real],
    shots: [{ ...makeShot(1), assetIds: ['ghost-1', 'real-1'], dialogues: [{ id: 'd1', speakerId: 'ghost-1', text: '我回来了。' }, { id: 'd2', speakerId: 'real-1', text: '走吧。' }] }],
  };
  const next = store.dropPlaceholderCharacters(project);
  assert.deepEqual(next.assets.map(asset => asset.id), ['real-1'], '空占位与机器文案占位都清掉，真人物保留');
  assert.deepEqual(next.shots[0].assetIds, ['real-1']);
  assert.equal(next.shots[0].dialogues[0].speakerId, '');
  assert.equal(next.shots[0].dialogues[0].speaker, '沈砚', '台词保留说话人名字，等提取后再关联');
  assert.equal(next.shots[0].dialogues[1].speakerId, 'real-1');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { savedStudioSchema } from '../src/store/schema';
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
  const character = uid(); const voice = uid(); const shot = makeShot(1);
  store.updateProject(project.id, { assets: [{ id: character, kind: 'character', name: '主角', description: '青衣', lock: '青衣', voiceAssetId: voice, imageId: 'shared-image' }, { id: voice, kind: 'voice', name: '音色', description: '', lock: '', voiceId: 'fixture-voice' }], shots: [{ ...shot, assetIds: [character], references: [{ assetId: character, role: 'reference_image' }], dialogues: [{ id: uid(), speakerId: character, text: '开始吧。' }], task: { id: 'fixture-task', provider: 'seedance', model: 'fixture', revision: 0, status: 'running', createdAt: '' } }] });
  const copy = store.duplicateProject(project.id)!;
  assert.notEqual(copy.id, project.id);
  assert.equal(copy.shots[0].task, undefined);
  assert.notEqual(copy.shots[0].id, shot.id);
  assert.equal(copy.shots[0].references[0].assetId, copy.assets[0].id);
  assert.equal(copy.shots[0].dialogues[0].speakerId, copy.assets[0].id);
  assert.equal(copy.assets[0].voiceAssetId, copy.assets[1].id);
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
  assert.equal(restored.settings.models.seedream, defaultSettings.models.seedream);
  assert.equal(restored.settings.models.seedance, 'ep-original-custom-model');
  assert.equal(defaultSettings.models.seedance, 'doubao-seedance-2-0-fast-260128');
  const partial = savedStudioSchema.parse({ ...saved, settings: { ...saved.settings, models: { seedance: 'ep-original-custom-model' } } });
  assert.equal(partial.settings.models.seedance, 'ep-original-custom-model');
  assert.equal(partial.settings.models.openai, defaultSettings.models.openai);
  store.setSettings({ ...defaultSettings, imageProvider: 'seedream', models: { ...defaultSettings.models, seedream: 'ep-selected-image-model' } });
  const selected = savedStudioSchema.parse(JSON.parse(values.get('manju-studio-v1')!));
  assert.equal(selected.settings.imageProvider, 'seedream');
  assert.equal(selected.settings.models.seedream, 'ep-selected-image-model');
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
    await callApi('image', credentials('openai'));
    assert.equal(store.getStudio().providerStatus.openai?.status, 'available');
    assert.equal(store.getStudio().providerStatus.openai?.model, defaultSettings.models.openai);
    globalThis.fetch = async () => { calls++; return Response.json({ error: 'provider_auth_failed', details: 'secret-upstream-message' }, { status: 401 }); };
    await assert.rejects(callApi('image', credentials('openai')), /拒绝/);
    assert.equal(calls, 2, 'failed paid requests are never retried or sent to another channel');
    assert.equal(store.getStudio().providerStatus.openai?.status, 'failed');
    assert.equal(store.getStudio().providerStatus.seedream, undefined);
    assert.ok(!JSON.stringify(store.getStudio().providerStatus).includes('secret-upstream-message'));
    globalThis.fetch = async () => { throw new Error('secret-network-message'); };
    await assert.rejects(callApi('image', credentials('openai')), /重复付费/);
    assert.ok(!JSON.stringify(store.getStudio().providerStatus).includes('secret-network-message'));
    globalThis.fetch = async () => Response.json({ ok: false, error: 'upstream_error' });
    await assert.rejects(callApi('image', credentials('openai')));
    assert.equal(store.getStudio().providerStatus.openai?.status, 'failed');
    globalThis.fetch = async () => new Response('audio-fixture', { headers: { 'Content-Type': 'audio/wav' } });
    await callBinary('speech', { ...credentials('minimax'), model: defaultSettings.speechModel });
    assert.equal(store.getStudio().providerStatus.minimax?.status, 'available');
    assert.equal(store.getStudio().providerStatus.minimax?.model, defaultSettings.speechModel);
    globalThis.fetch = async () => new Response('', { headers: { 'Content-Type': 'audio/wav' } });
    await callBinary('speech', credentials('minimax'));
    assert.equal(store.getStudio().providerStatus.minimax?.status, 'failed');
    globalThis.fetch = async () => Response.json({ ok: true, data: [] });
    await callApi('voices', credentials('minimax'));
    assert.equal(store.getStudio().providerStatus.minimax?.model, undefined);
    globalThis.fetch = async () => { store.setKey('openai', 'changed-during-call'); return Response.json({ ok: true, data: {} }); };
    await callApi('image', credentials('openai'));
    assert.equal(store.getStudio().providerStatus.openai, undefined);
  } finally { globalThis.fetch = originalFetch; store.clearKeys(); }
});

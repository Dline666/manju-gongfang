import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSavedStudio, savedStudioSchema, savedStudioSchemaV2 } from '../src/store/schema';
import { migrateSettings } from '../src/lib/endpoints';
import { defaultSettings, makeShot, uid, type Project } from '../src/domain/types';
import { putMedia } from '../src/store/media';
import { makeSeries, makeEpisode } from '../src/domain/series';
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, configurable: true });
const store = await import('../src/store/studio');

/** 直接读存档：测试里要断言「存进去的形状」，不走 store 的中间态。 */
const saved = () => JSON.parse(values.get('manju-studio-v1')!);

test('keys never enter persisted state, even when series/settings change', () => {
  store.setKey('seedance', 'private-fixture-key');
  const series = store.createSeries('原系列', '断剑');
  store.setSettings({ ...defaultSettings });
  store.updateSeries(series.id, { name: '新的名字' });
  const raw = values.get('manju-studio-v1')!;
  assert.ok(!raw.includes('private-fixture-key'));
  assert.equal(saved().keys, undefined);
  assert.equal(saved().providerStatus, undefined);
  assert.equal(store.getStudio().keys.seedance, 'private-fixture-key');
  assert.doesNotThrow(() => savedStudioSchemaV2.parse(saved()));
  store.clearKeys();
  assert.deepEqual(store.getStudio().keys, {});
});

test('存档是 v2 形状：系列 + 当前系列/集，不再是 projects 数组', () => {
  const series = store.createSeries('形状检查');
  const episode = series.episodes[0];
  store.updateEpisode(series.id, episode.id, { name: '改了名' });
  const data = saved();
  assert.equal(data.version, 2);
  assert.equal(data.projects, undefined);
  assert.ok(Array.isArray(data.series));
  assert.equal(data.activeSeriesId, series.id);
  assert.ok(Array.isArray(data.series[0].episodes));
  assert.equal(data.series[0].episodes[0].number, 1);
});

test('新建系列自带第 1 集，新增集数集号顺延', () => {
  const series = store.createSeries('集数');
  assert.equal(series.episodes.length, 1);
  assert.equal(series.episodes[0].number, 1);
  const second = store.addEpisode(series.id)!;
  const third = store.addEpisode(series.id, '第三集标题')!;
  assert.equal(second.number, 2);
  assert.equal(third.number, 3);
  assert.equal(third.title, '第三集标题');
  const stored = store.getStudio().series.find(item => item.id === series.id)!;
  assert.deepEqual(stored.episodes.map(episode => episode.number).sort(), [1, 2, 3]);
});

test('删除集数后当前集回退到系列页，不悬空', () => {
  const series = store.createSeries('删除集');
  const second = store.addEpisode(series.id)!;
  store.selectEpisode(second.id);
  assert.equal(store.getStudio().activeEpisodeId, second.id);
  store.deleteEpisode(series.id, second.id);
  assert.equal(store.getStudio().activeEpisodeId, null);
  assert.equal(store.getStudio().series.find(item => item.id === series.id)!.episodes.length, 1);
});

test('画幅与分辨率按系列定，非法值被忽略', () => {
  const series = store.createSeries('画幅');
  assert.equal(series.aspect, '9:16');
  assert.equal(series.resolution, '720p');
  store.setSeriesAspect(series.id, '16:9');
  store.setSeriesResolution(series.id, '1080p');
  let stored = store.getStudio().series.find(item => item.id === series.id)!;
  assert.equal(stored.aspect, '16:9');
  assert.equal(stored.resolution, '1080p');
  store.setSeriesAspect(series.id, '4:3' as never);
  store.setSeriesResolution(series.id, '4k' as never);
  stored = store.getStudio().series.find(item => item.id === series.id)!;
  assert.equal(stored.aspect, '16:9', '非法画幅不写入');
  assert.equal(stored.resolution, '1080p', '非法分辨率不写入');
});

test('episode 的 scoped invalidation 只标记列出的镜头；setAssetImage 只标记相关镜头', () => {
  const series = store.createSeries('范围失效');
  const episode = series.episodes[0];
  const a1 = uid(); const a2 = uid();
  const video = { origin: 'upload' as const, name: 'v.mp4', duration: 9 };
  store.updateEpisode(series.id, episode.id, {
    assets: [
      { id: a1, kind: 'character' as const, name: '甲', description: '', lock: '' },
      { id: a2, kind: 'scene' as const, name: '乙', description: '', lock: '' },
    ],
    shots: [
      { ...makeShot(1), id: 'shot-a', assetIds: [a1], video },
      { ...makeShot(2), id: 'shot-b', assetIds: [a1], video },
      { ...makeShot(3), id: 'shot-c', assetIds: [a2], video },
    ],
  });
  store.updateEpisode(series.id, episode.id, {}, { only: ['shot-b'] });
  let shots = store.getStudio().series.find(item => item.id === series.id)!.episodes[0].shots;
  assert.deepEqual(shots.map(shot => !!shot.stale), [false, true, false]);

  store.setAssetImage(series.id, episode.id, a1, 'image-1');
  const stored = store.getStudio().series.find(item => item.id === series.id)!.episodes[0];
  assert.equal(stored.assets.find(asset => asset.id === a1)!.imageId, 'image-1');
  shots = stored.shots;
  assert.deepEqual(shots.map(shot => !!shot.stale), [true, true, false], 'only shots using the asset are stale');
});

test('scoped invalidation writes staleReason only on affected shots', () => {
  const series = store.createSeries('原因标记');
  const episode = series.episodes[0];
  const assetId = uid();
  const video = { origin: 'upload' as const, name: 'v.mp4', duration: 9 };
  store.updateEpisode(series.id, episode.id, {
    assets: [{ id: assetId, kind: 'character' as const, name: '甲', description: '', lock: '旧布衣' }],
    shots: [
      { ...makeShot(1), id: 'shot-a', assetIds: [assetId], video },
      { ...makeShot(2), id: 'shot-b', video },
    ],
  });
  store.updateEpisode(series.id, episode.id, {}, { only: ['shot-a'], reason: '资产「甲」已修改' });
  const shots = store.getStudio().series.find(item => item.id === series.id)!.episodes[0].shots;
  assert.equal(shots[0].stale, true);
  assert.equal(shots[0].staleReason, '资产「甲」已修改');
  assert.ok(!shots[1].stale);
  assert.equal(shots[1].staleReason, undefined);
});

test('旧存档里的剧本占位人物在载入时清掉，台词保留说话人名字', () => {
  const empty = { id: 'ghost-1', kind: 'character' as const, name: '沈砚', description: '', lock: '' };
  const imported = { id: 'ghost-2', kind: 'character' as const, name: '阿青', description: '阿青，导入人物，外观待完善', lock: '阿青，导入人物，外观待完善' };
  const real = { id: 'real-1', kind: 'character' as const, name: '主角', description: '深色长衣', lock: '深色长衣' };
  const episode = {
    ...store.createSeries('旧作品', '断剑').episodes[0],
    assets: [empty, imported, real],
    shots: [{ ...makeShot(1), assetIds: ['ghost-1', 'real-1'], dialogues: [{ id: 'd1', speakerId: 'ghost-1', text: '我回来了。' }, { id: 'd2', speakerId: 'real-1', text: '走吧。' }] }],
  };
  const next = store.dropPlaceholderCharacters(episode);
  assert.deepEqual(next.assets.map(asset => asset.id), ['real-1'], '空占位与机器文案占位都清掉，真人物保留');
  assert.deepEqual(next.shots[0].assetIds, ['real-1']);
  assert.equal(next.shots[0].dialogues[0].speakerId, '');
  assert.equal(next.shots[0].dialogues[0].speaker, '沈砚', '台词保留说话人名字，等提取后再关联');
  assert.equal(next.shots[0].dialogues[1].speakerId, 'real-1');
});

test('v1 存档载入后按「一个作品 = 一个单集系列」迁移，镜头与资产不丢', () => {
  const legacyProject: Project = {
    id: 'legacy-proj-1', name: '断剑归门', theme: '复仇', style: '水墨',
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', revision: 5,
    skills: ['script', 'storyboard', 'image', 'video'],
    shots: [{ ...makeShot(1), id: 'legacy-shot', duration: 11, visual: '雪夜' }],
    assets: [{ id: 'legacy-char', kind: 'character', name: '林晚', description: '青衣', lock: '青衣' }],
    source: 'ai', storyboardReady: true, screenplay: '# 旧剧本', specVersion: 'shot-spec-1',
  };
  const v1 = { version: 1, projects: [legacyProject], activeId: legacyProject.id, settings: { ...defaultSettings } };
  const parsed = parseSavedStudio(v1);
  assert.equal(parsed.version, 1, 'v1 存档先按 v1 解析，再由迁移函数转成系列');
  assert.deepEqual(parsed.data.projects[0].shots, legacyProject.shots);
  // 迁移函数本身已由 series.test.ts 覆盖；这里只验证 schema 仍能原样读入旧数据。
  assert.doesNotThrow(() => savedStudioSchema.parse(v1));
});

test('v1 存档里损坏的作品会被拒绝，而不是被静默丢掉', () => {
  const bad = { version: 1, projects: [{ id: 'x' }], activeId: null, settings: { ...defaultSettings } };
  assert.throws(() => parseSavedStudio(bad));
});

test('draft values remain readable while domain validation flags unfinished edits', () => {
  const series = store.createSeries('编辑中');
  store.updateEpisode(series.id, series.episodes[0].id, { shots: [{ ...makeShot(1), duration: -1 }] });
  assert.doesNotThrow(() => savedStudioSchemaV2.parse(saved()));
  const data = saved();
  data.series[0].episodes[0].shots[0].video = { origin: 'upload', name: 'bad.mp4', duration: 9, url: 'blob:ephemeral' };
  assert.equal(savedStudioSchemaV2.safeParse(data).success, false);
});

test('video blobs are rejected before IndexedDB access', async () => {
  await assert.rejects(putMedia(new Blob(['video'], { type: 'video/mp4' })), /当前会话/);
});

test('legacy settings gain Seedream without replacing existing models or series', () => {
  const data = saved();
  delete data.settings.imageProvider;
  delete data.settings.models.seedream;
  data.settings.models.seedance = 'ep-original-custom-model';
  const restored = savedStudioSchemaV2.parse(data);
  assert.equal(restored.series.length > 0, true);
  assert.equal(restored.settings.imageProvider, 'openai');
  const migrated = migrateSettings(restored.settings);
  assert.deepEqual(migrated.models.seedream, { image: 'doubao-seedream-5-5-261028' }, '缺失的模型按端点能力补默认');
  assert.deepEqual(migrated.models.seedance, { video: 'ep-original-custom-model' }, '旧的扁平模型按能力迁移，用户改过的值不丢');
  assert.deepEqual(migrated.models.openai, { image: 'gpt-image-2.6-sunburst' });
  assert.equal(migrated.endpoints.length, 7, '旧存档载入后补齐内置端点目录');
  assert.equal(migrated.imageProvider, 'openai');
  const partial = savedStudioSchemaV2.parse({ ...data, settings: { ...data.settings, models: { seedance: 'ep-original-custom-model' } } });
  assert.deepEqual(migrateSettings(partial.settings).models.seedance, { video: 'ep-original-custom-model' });
  store.setSettings({ ...migrated, imageProvider: 'seedream', models: { ...migrated.models, seedream: { image: 'ep-selected-image-model' } } });
  const selected = savedStudioSchemaV2.parse(saved());
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
  assert.equal(saved().providerStatus, undefined);
  assert.equal(saved().keys, undefined);
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

test('迁移成功后立刻把 v2 写回，localStorage 不再停留 v1', async () => {
  // 用独立模块实例验证载入路径：写一份合法 v1，导入 store，存档应已变成 v2。
  const backup = values.get('manju-studio-v1');
  const legacy = {
    version: 1, activeId: 'legacy-1',
    projects: [{
      id: 'legacy-1', name: '旧作品', theme: '复仇', style: '水墨',
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', revision: 3,
      skills: ['script', 'storyboard', 'image', 'video'], source: 'template', storyboardReady: true,
      assets: [{ id: 'a1', kind: 'character', name: '阿青', description: '少年', lock: '少年' }],
      shots: [{ ...makeShot(1), id: 's1', duration: 12, assetIds: ['a1'] }],
    }],
    settings: { ...defaultSettings },
  };
  values.set('manju-studio-v1', JSON.stringify(legacy));
  await import('../src/store/studio?load-v1-backfill');
  const stored = JSON.parse(values.get('manju-studio-v1')!);
  assert.equal(stored.version, 2, '迁移完必须回存 v2，否则每次刷新都要重新迁移');
  assert.equal(stored.projects, undefined);
  assert.equal(stored.series.length, 1);
  assert.equal(stored.series[0].episodes[0].shots.length, 1);
  values.set('manju-studio-v1', backup!);
});

test('迁移失败时不覆盖旧数据：store 报错并停止保存', async () => {
  // 用独立的模块实例验证载入路径：先把一份坏 v1 存档写进去，再重新导入 store。
  const backup = values.get('manju-studio-v1');
  values.set('manju-studio-v1', JSON.stringify({ version: 1, projects: [{ id: 'broken' }], activeId: null, settings: defaultSettings }));
  const fresh = await import('../src/store/studio?load-broken');
  assert.match(fresh.getStudio().storageError!, /无法读取/);
  assert.match(fresh.getStudio().storageError!, /备份/);
  assert.equal(fresh.getStudio().series.length, 0, '坏数据不会被当成空列表悄悄覆盖');
  values.set('manju-studio-v1', backup!);
});

test('applyImportedStoryboard 写入镜头资产并标记已就绪', () => {
  const series = store.createSeries('导入');
  const episode = series.episodes[0];
  const shot = { ...makeShot(1), id: 'imported-shot', duration: 12, visual: '导入画面' };
  store.applyImportedStoryboard(series.id, episode.id, {
    shots: [shot],
    assets: [{ id: 'char-a', kind: 'character', name: '林晚', description: '青衣', lock: '青衣' }],
    storyboardJson: '{"shots":[]}',
    title: '雪夜归人',
  });
  const stored = store.getStudio().series.find(item => item.id === series.id)!.episodes[0];
  assert.equal(stored.shots.length, 1);
  assert.equal(stored.assets.length, 1);
  assert.equal(stored.storyboardReady, true);
  assert.equal(stored.source, 'import');
  assert.equal(stored.storyboardJson, '{"shots":[]}');
  assert.equal(stored.title, '雪夜归人');
  assert.equal(stored.name, '雪夜归人', '集标题同步到 name，面包屑与导出文件名都用它');
});
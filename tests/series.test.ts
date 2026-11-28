import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeSeries, makeEpisode, nextEpisodeNumber, migrateProjectsToSeries, episodeFromProject,
  episodeLabel, episodeDuration, episodeStatus, seriesFromProject, findEpisode, sortedEpisodes,
  DEFAULT_ASPECT, DEFAULT_RESOLUTION, type Series,
} from '../src/domain/series';
import { makeShot, type Project } from '../src/domain/types';

function baseProject(patch: Partial<Project> = {}): Project {
  return {
    id: 'legacy-1', name: '断剑归门', theme: '复仇', style: '水墨', createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z', revision: 3, skills: ['script', 'storyboard', 'image', 'video'],
    shots: [{ ...makeShot(1), id: 'shot-1', visual: '雪夜山门', duration: 12 }],
    assets: [{ id: 'char-1', kind: 'character', name: '林晚', description: '青衣', lock: '青衣' }],
    source: 'ai', storyboardReady: true, screenplay: '# 剧本', ...patch,
  };
}

test('系列默认画幅 9:16 与 720p，且自带第 1 集', () => {
  const series = makeSeries('  断剑归门  ');
  assert.equal(series.name, '断剑归门');
  assert.equal(series.aspect, DEFAULT_ASPECT);
  assert.equal(series.resolution, DEFAULT_RESOLUTION);
  assert.equal(series.episodes.length, 1);
  assert.equal(series.episodes[0].number, 1);
  assert.equal(series.episodes[0].shots.length, 0);
});

test('集号顺延取最大值 +1，删掉中间集也不会撞号', () => {
  const series = makeSeries('测试');
  series.episodes.push(makeEpisode(2), makeEpisode(3));
  assert.equal(nextEpisodeNumber(series), 4);
  series.episodes = series.episodes.filter(episode => episode.number !== 3);
  // 中间集删掉后，最大值仍是 2，所以下一个号是 3——这不会撞号，因为 3 已经不存在了。
  assert.equal(nextEpisodeNumber(series), 3);
  // 但如果删掉的是最后一集之前的号，最大值不变：
  series.episodes.push(makeEpisode(5));
  series.episodes = series.episodes.filter(episode => episode.number !== 1);
  assert.equal(nextEpisodeNumber(series), 6, '取最大值 +1，不从空缺处回填');
  assert.equal(nextEpisodeNumber({ episodes: [] }), 1);
});

test('旧作品迁移成单集系列：镜头与资产原样带入并标记旧规格', () => {
  const project = baseProject();
  const [series] = migrateProjectsToSeries([project]);
  assert.equal(series.name, project.name);
  assert.equal(series.aspect, DEFAULT_ASPECT);
  assert.equal(series.resolution, DEFAULT_RESOLUTION);
  assert.equal(series.episodes.length, 1);
  const episode = series.episodes[0];
  assert.equal(episode.number, 1);
  assert.deepEqual(episode.shots, project.shots, '镜头原样带入');
  assert.deepEqual(episode.assets, project.assets, '资产原样带入');
  assert.equal(episode.storyboardReady, true, '已就绪标记保留');
  assert.equal(episode.screenplay, '# 剧本', '剧本正文保留');
  assert.equal(episode.legacySpec, true, '旧规格标记，不受新 4–6 镜规则约束');
  assert.equal(episode.title, project.name);
});

test('迁移失败整批抛出，不产生迁一半的数据', () => {
  assert.throws(() => migrateProjectsToSeries([baseProject(), { ...baseProject(), id: 'legacy-1' }]), /id 重复/);
  assert.throws(() => migrateProjectsToSeries([null as unknown as Project]), /缺少 id/);
});

test('迁移不丢数据：每部旧作品对应一个系列，且集数不合并', () => {
  const series = migrateProjectsToSeries([baseProject(), { ...baseProject(), id: 'legacy-2', name: '另一部' }]);
  assert.equal(series.length, 2);
  assert.deepEqual(series.map(item => item.name), ['断剑归门', '另一部']);
  assert.ok(series.every(item => item.episodes.length === 1));
  assert.notEqual(series[0].id, series[1].id, '系列 id 必须重新生成，不能复用作品 id');
});

test('集标题与时长、状态的展示口径', () => {
  assert.equal(episodeLabel({ number: 2, title: '雪夜归人' }), '第2集 雪夜归人');
  assert.equal(episodeLabel({ number: 2, title: '  ' }), '第2集');
  const episode = makeEpisode(1);
  episode.shots = [{ ...makeShot(1), duration: 12 }, { ...makeShot(2), duration: 9.5 }];
  assert.equal(episodeDuration(episode), 21.5);
  assert.equal(episodeStatus(episode), 'imported');
  assert.equal(episodeStatus(makeEpisode(1)), 'empty');
  episode.shots[0].video = { origin: 'upload', name: 'a.mp4', duration: 12 };
  assert.equal(episodeStatus(episode), 'generated');
});

test('seriesFromProject 保留时间戳，便于列表按更新时间排序', () => {
  const project = baseProject();
  const series = seriesFromProject(project);
  assert.equal(series.createdAt, project.createdAt);
  assert.equal(series.updatedAt, project.updatedAt);
  assert.notEqual(series.episodes[0].id, project.id, '集 id 与旧作品 id 分开，避免两个命名空间混淆');
  assert.notEqual(series.id, project.id, '系列 id 同样新生成');
});

test('定位与排序', () => {
  const series: Series = makeSeries('定位');
  series.episodes.push(makeEpisode(3), makeEpisode(2));
  assert.deepEqual(sortedEpisodes(series).map(episode => episode.number), [1, 2, 3]);
  const target = series.episodes.find(episode => episode.number === 2)!;
  assert.equal(findEpisode(series, target.id)?.number, 2);
  assert.equal(findEpisode(series, 'missing'), undefined);
  assert.equal(findEpisode(undefined, target.id), undefined);
});

test('episodeFromProject 直接复用旧对象字段，不抛错也不浅拷贝镜头数组', () => {
  const project = baseProject();
  const episode = episodeFromProject(project);
  assert.equal(episode.number, 1);
  assert.equal(episode.title, project.name);
  assert.equal(episode.screenplay, project.screenplay);
  assert.equal(episode.shots, project.shots, '镜头数组共享引用：避免大作品迁移时整份深拷贝');
  assert.equal(episode.legacySpec, true);
});
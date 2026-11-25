import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assetWarnings, canEnter, directorFingerprint, directorWarnings, scriptFingerprint, stageStatus, validateAssetsStage,
  validateDirectorStage, validateScriptStage, withConfirmation,
} from '../src/domain/flow';
import { defaultStyle, makeShot, type Asset, type Project } from '../src/domain/types';
import { validateProject } from '../src/domain/validation';
import { savedStudioSchema } from '../src/store/schema';
import { defaultSettings } from '../src/domain/types';

const hero: Asset = { id: 'hero', kind: 'character', name: '沈砚', description: '灰白布衣', lock: '十七岁少年，灰白旧布衣' };
const scene: Asset = { id: 'scene', kind: 'scene', name: '山门', description: '石阶', lock: '青灰石阶九十九级' };
const prop: Asset = { id: 'prop', kind: 'prop', name: '断剑', description: '断口', lock: '红绳剑柄，斜断口' };

function shots(filled: boolean): Project['shots'] {
  return Array.from({ length: 10 }, (_, index) => ({
    ...makeShot(index + 1),
    visual: `第${index + 1}镜画面`,
    scene: '外景 · 山门石阶 — 清晨',
    start: filled ? '开场' : '',
    action: filled ? '动作' : '',
    end: filled ? '终点' : '',
    camera: filled ? '中景·固定·平视' : '',
    assetIds: ['hero', 'scene', 'prop'],
  }));
}
function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project', name: '断剑归门', theme: '断剑', style: defaultStyle, createdAt: '', updatedAt: '', revision: 0,
    skills: ['script', 'storyboard', 'image', 'video'], assets: [hero, scene, prop], shots: shots(true), source: 'template',
    screenplay: '# 第一部分｜核心前提\n【核心前提】\n沈砚在山门拾起断剑。\n', storyboardReady: false, ...overrides,
  };
}

test('各步状态按新顺序推断：剧本 → 导演分镜 → 资产 → 分镜 → 视频', () => {
  const filled = project();
  assert.deepEqual(stageStatus(filled), { script: true, director: true, assets: true, storyboard: false, video: false });
  const emptyDirector = project({ shots: shots(false) });
  assert.deepEqual(stageStatus(emptyDirector), { script: true, director: false, assets: false, storyboard: false, video: false });
  const empty = project({ shots: [], assets: [], screenplay: '' });
  assert.deepEqual(stageStatus(empty), { script: false, director: false, assets: false, storyboard: false, video: false });
});

test('剧本指纹覆盖剧本文本，改剧本后下游回到待确认', () => {
  const base = project({ shots: shots(false) });
  const confirmed = withConfirmation(base, 'script');
  const confirmedProject = { ...base, confirmed };
  assert.equal(stageStatus(confirmedProject).script, true);
  const changed = { ...confirmedProject, screenplay: '# 改过的剧本正文' };
  assert.equal(stageStatus(changed).script, false);
  assert.equal(stageStatus(changed).director, false);
  assert.notEqual(scriptFingerprint(base), scriptFingerprint(changed));
  const directorOnly = { ...confirmedProject, shots: confirmedProject.shots.map(shot => ({ ...shot, camera: '远景·推·平视' })) };
  assert.equal(stageStatus(directorOnly).script, true, '导演字段不影响剧本确认');
});

test('资产指纹覆盖固定短语，改固定短语后资产回到待确认', () => {
  const base = project({ shots: shots(false) });
  const scripted = { ...base, confirmed: withConfirmation(base, 'script') };
  const directed = { ...scripted, confirmed: withConfirmation(scripted, 'director') };
  const confirmed = { ...directed, confirmed: withConfirmation(directed, 'assets') };
  assert.equal(stageStatus(confirmed).assets, true);
  const changed = { ...confirmed, assets: confirmed.assets.map(asset => asset.id === 'hero' ? { ...asset, lock: '新的固定短语' } : asset) };
  assert.equal(stageStatus(changed).assets, false);
  assert.equal(stageStatus(changed).director, true, '资产改动不影响已产出的分镜');
  const imageOnly = { ...confirmed, assets: confirmed.assets.map(asset => asset.id === 'hero' ? { ...asset, imageId: 'new-image', locked: true } : asset) };
  assert.equal(stageStatus(imageOnly).assets, true, '图片与锁定状态不影响固定短语确认');
});

test('导演确认后编辑运镜会失效，参考图与分镜状态不影响', () => {
  const base = project();
  const confirmed = { ...base, confirmed: withConfirmation(base, 'director') };
  assert.equal(stageStatus(confirmed).director, true);
  const changed = { ...confirmed, shots: confirmed.shots.map((shot, index) => index === 2 ? { ...shot, action: '改过的动作' } : shot) };
  assert.equal(stageStatus(changed).director, false);
  assert.notEqual(directorFingerprint(base), directorFingerprint(changed));
  const storyboardEdit = { ...confirmed, storyboardReady: true, shots: confirmed.shots.map(shot => ({ ...shot, references: [{ assetId: 'scene', role: 'reference_image' as const }] })) };
  assert.equal(stageStatus(storyboardEdit).director, true);
  assert.equal(stageStatus(storyboardEdit).storyboard, true);
});

test('资产步骤挂资产不推翻已确认的分镜', () => {
  const base = project();
  const directed = { ...base, confirmed: withConfirmation(base, 'director') };
  const afterAssets = { ...directed, shots: directed.shots.map((shot, index) => index === 0 ? { ...shot, assetIds: [...shot.assetIds, 'new-asset'] } : shot) };
  assert.equal(stageStatus(afterAssets).director, true, '资产关联不算改分镜');
  const afterSpeaker = { ...afterAssets, shots: afterAssets.shots.map((shot, index) => index === 0 ? { ...shot, dialogues: [{ id: 'd', speakerId: 'hero', speaker: '沈砚', text: '台词' }] } : shot) };
  assert.equal(stageStatus(afterSpeaker).director, false, '台词本身变了就算改分镜');
});

test('canEnter 按新顺序放行：进入一步只需要上一步完成', () => {
  const empty = project({ shots: [], assets: [], screenplay: '', confirmed: undefined });
  assert.equal(canEnter(empty, 'script'), true);
  assert.equal(canEnter(empty, 'director'), false, '没有剧本不能进导演分镜');
  const stale = project({ shots: shots(false), confirmed: { script: 12345 } });
  assert.equal(stageStatus(stale).script, false);
  assert.equal(canEnter(stale, 'director'), false, '剧本确认过期时导演分镜不可进入');
  const confirmedScript = { ...stale, confirmed: withConfirmation(stale, 'script') };
  assert.equal(canEnter(confirmedScript, 'director'), true);
  assert.equal(canEnter(confirmedScript, 'assets'), false, '还没有齐备的镜头时资产不可进入');
  const withShots = { ...confirmedScript, shots: shots(true) };
  assert.equal(canEnter(withShots, 'assets'), true);
});

test('阶段校验给出可定位的问题', () => {
  const noScript = project({ screenplay: '' });
  assert.ok(validateScriptStage(noScript).some(issue => issue.includes('剧本还没有正文')));
  const noAssets = project({ assets: [] });
  assert.ok(validateAssetsStage(noAssets).some(issue => issue.includes('至少需要')));
  const noDirector = project({ shots: shots(false) });
  assert.deepEqual(validateDirectorStage(project()), []);
  assert.ok(validateDirectorStage(noDirector).some(issue => issue.includes('第1镜：缺少景别与运镜')));
  assert.ok(validateDirectorStage(project({ shots: [] })).some(issue => issue.includes('还没有分镜')));
});

test('人物固定短语建议写明性别，只提示不阻断', () => {
  const base = project();
  const withoutGender = { ...base, assets: [{ id: 'a', kind: 'character' as const, name: '沈砚', description: '十七岁，清瘦，灰白旧布衣', lock: '' }, { id: 'b', kind: 'scene' as const, name: '山门', description: '石阶', lock: '石阶' }, { id: 'c', kind: 'prop' as const, name: '断剑', description: '断剑', lock: '断剑' }] };
  assert.ok(assetWarnings(withoutGender).some(tip => tip.includes('性别')), '缺性别必须被提示');
  assert.ok(!validateAssetsStage(withoutGender).some(issue => issue.includes('性别')), '提示不得阻断资产确认');
  const withGender = { ...withoutGender, assets: withoutGender.assets.map(asset => asset.kind === 'character' ? { ...asset, description: '十七岁少年，清瘦，灰白旧布衣' } : asset) };
  assert.ok(!assetWarnings(withGender).some(tip => tip.includes('性别')));
});

test('分镜警告只提示不阻断', () => {
  const warned = project({ shots: shots(false).map((shot, index) => index === 0 ? { ...shot, visual: '特写：主角抬手', dialogues: [{ id: 'd', speakerId: 'hero', text: '这是一句台词。' }], assetIds: ['hero'] } : shot) });
  const warnings = directorWarnings(warned);
  assert.ok(warnings.some(item => item.includes('镜头术语')));
  assert.deepEqual(validateDirectorStage(warned).filter(issue => issue.includes('台词') || issue.includes('镜头')), []);
});

test('confirmed / locked / staleReason 可选字段通过存档 schema', () => {
  const value = project({ confirmed: { script: 1, assets: 2, director: 3 } });
  value.assets[0].locked = true;
  value.shots[0].staleReason = '资产「沈砚」已修改';
  const saved = savedStudioSchema.parse({ version: 1, projects: [value], activeId: value.id, settings: defaultSettings });
  assert.deepEqual(saved.projects[0].confirmed, value.confirmed);
  assert.equal(saved.projects[0].assets[0].locked, true);
  assert.equal(saved.projects[0].shots[0].staleReason, '资产「沈砚」已修改');
});

test('对白按冒号切分，不再做原文比对与字数校验', () => {
  const base = project({ scriptMode: 'source', sourceText: '赵珂冷笑一声，说：“废物。”' });
  const withLine = (text: string) => ({ ...base, shots: base.shots.map((shot, index) => index === 0 ? { ...shot, dialogues: [{ id: 'd', speakerId: 'hero', text }] } : shot) });
  const long = '大佬，要不……先嗦碗面？这句话其实很长很长很长很长很长很长。';
  for (const text of ['废物。', '你算什么东西。', long]) {
    assert.deepEqual(directorWarnings(withLine(text)), [], '对白不再产生任何建议');
  }
  assert.deepEqual(validateDirectorStage(withLine(long)).filter(issue => issue.includes('台词')), [], '也不得阻断分镜确认');
});

test('冒号切出来的对白不再被当成阻断项', () => {
  const base = project();
  const broken = { ...base, shots: base.shots.map((shot, index) => index === 0 ? { ...shot, dialogues: [
    { id: 'd1', speakerId: '', speaker: '', text: '……' },
    { id: 'd2', speakerId: 'scene', text: '……' },
  ] } : shot) };
  assert.ok(!validateDirectorStage(broken).some(issue => issue.includes('台词')), '分镜步不再报台词问题');
  assert.ok(!validateProject(broken).some(error => error.includes('台词')), '整体校验也不再报台词问题');
});

test('资产步不再提醒「说话人还没关联人物资产」', () => {
  const base = project();
  const withSpeaker = { ...base, shots: base.shots.map((shot, index) => index === 0 ? { ...shot, dialogues: [{ id: 'd', speakerId: '', speaker: '冒号切出来的半句话', text: '……' }] } : shot) };
  assert.ok(!assetWarnings(withSpeaker).some(tip => tip.includes('说话人')), '说话人来自冒号切分，提醒没有参考价值');
});

test('原文模式字段可选项通过存档 schema，旧作品不受影响', () => {
  const value = project({ scriptMode: 'source', sourceText: '赵珂冷笑一声，说：“废物。”' });
  const saved = savedStudioSchema.parse({ version: 1, projects: [value], activeId: value.id, settings: defaultSettings });
  assert.equal(saved.projects[0].scriptMode, 'source');
  assert.equal(saved.projects[0].sourceText, '赵珂冷笑一声，说：“废物。”');
  const legacy = project();
  const legacySaved = savedStudioSchema.parse({ version: 1, projects: [legacy], activeId: legacy.id, settings: defaultSettings });
  assert.equal(legacySaved.projects[0].scriptMode, undefined);
  assert.equal(legacySaved.projects[0].sourceText, undefined);
});

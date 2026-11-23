import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assetWarnings, canEnter, directorFingerprint, scriptFingerprint, scriptWarnings, stageStatus, validateAssetsStage,
  validateDirectorStage, validateScriptStage, withConfirmation,
} from '../src/domain/flow';
import { defaultStyle, makeShot, type Asset, type Project } from '../src/domain/types';
import { savedStudioSchema } from '../src/store/schema';
import { defaultSettings } from '../src/domain/types';

const hero: Asset = { id: 'hero', kind: 'character', name: '沈砚', description: '灰白布衣', lock: '十七岁少年，灰白旧布衣' };
const scene: Asset = { id: 'scene', kind: 'scene', name: '山门', description: '石阶', lock: '青灰石阶九十九级' };
const prop: Asset = { id: 'prop', kind: 'prop', name: '断剑', description: '断口', lock: '红绳剑柄，斜断口' };

function shots(filled: boolean): Project['shots'] {
  return Array.from({ length: 10 }, (_, index) => ({
    ...makeShot(index + 1),
    visual: `第${index + 1}镜画面`,
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
    storyboardReady: false, ...overrides,
  };
}

test('旧作品按派生规则推断各步状态', () => {
  const filled = project();
  assert.deepEqual(stageStatus(filled), { script: true, assets: true, director: true, storyboard: false, video: false });
  const emptyDirector = project({ shots: shots(false) });
  assert.deepEqual(stageStatus(emptyDirector), { script: true, assets: true, director: false, storyboard: false, video: false });
  const empty = project({ shots: [], assets: [] });
  assert.deepEqual(stageStatus(empty), { script: false, assets: false, director: false, storyboard: false, video: false });
});

test('剧本指纹只覆盖剧本层字段，编辑后下游回到待确认', () => {
  const base = project({ shots: shots(false) });
  const confirmed = withConfirmation(base, 'script');
  const confirmedProject = { ...base, confirmed };
  assert.equal(stageStatus(confirmedProject).script, true);
  const changed = { ...confirmedProject, shots: confirmedProject.shots.map((shot, index) => index === 0 ? { ...shot, visual: '改过的画面' } : shot) };
  assert.equal(stageStatus(changed).script, false);
  assert.equal(stageStatus(changed).assets, false);
  assert.notEqual(scriptFingerprint(base), scriptFingerprint(changed));
  const directorOnly = { ...confirmedProject, shots: confirmedProject.shots.map(shot => ({ ...shot, camera: '远景·推·平视' })) };
  assert.equal(stageStatus(directorOnly).script, true, '导演字段不影响剧本确认');
});

test('资产指纹覆盖固定短语，编辑后资产与导演回到待确认', () => {
  const base = project({ shots: shots(false) });
  const scripted = { ...base, confirmed: withConfirmation(base, 'script') };
  const confirmed = { ...scripted, confirmed: withConfirmation(scripted, 'assets') };
  assert.equal(stageStatus(confirmed).assets, true);
  const changed = { ...confirmed, assets: confirmed.assets.map(asset => asset.id === 'hero' ? { ...asset, lock: '新的固定短语' } : asset) };
  assert.equal(stageStatus(changed).assets, false);
  assert.equal(stageStatus(changed).director, false);
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

test('canEnter 按顺序放行', () => {
  const empty = project({ shots: [], assets: [], confirmed: undefined });
  assert.equal(canEnter(empty, 'script'), true);
  assert.equal(canEnter(empty, 'assets'), false);
  const stale = project({ shots: shots(false), confirmed: { script: 12345 } });
  assert.equal(stageStatus(stale).script, false);
  assert.equal(canEnter(stale, 'assets'), false, '剧本确认过期时资产不可进入');
  const confirmedScript = { ...stale, confirmed: withConfirmation(stale, 'script') };
  assert.equal(canEnter(confirmedScript, 'assets'), true);
  assert.equal(canEnter(confirmedScript, 'director'), false);
});

test('阶段校验给出可定位的问题', () => {
  const noBeat = project({ shots: [] });
  assert.ok(validateScriptStage(noBeat).some(issue => issue.includes('还没有镜头')));
  const badDuration = project({ shots: shots(true).map((shot, index) => index === 0 ? { ...shot, duration: 40 } : shot) });
  assert.ok(validateScriptStage(badDuration).some(issue => issue.includes('第1镜')));
  const noAssets = project({ assets: [] });
  assert.ok(validateAssetsStage(noAssets).some(issue => issue.includes('至少需要')));
  const noDirector = project({ shots: shots(false) });
  assert.deepEqual(validateDirectorStage(project()), []);
  assert.ok(validateDirectorStage(noDirector).some(issue => issue.includes('第1镜：缺少景别与运镜')));
});

test('人物固定短语建议写明性别，只提示不阻断', () => {
  const base = project();
  const withoutGender = { ...base, assets: [{ id: 'a', kind: 'character' as const, name: '沈砚', description: '十七岁，清瘦，灰白旧布衣', lock: '' }, { id: 'b', kind: 'scene' as const, name: '山门', description: '石阶', lock: '石阶' }, { id: 'c', kind: 'prop' as const, name: '断剑', description: '断剑', lock: '断剑' }] };
  assert.ok(assetWarnings(withoutGender).some(tip => tip.includes('性别')), '缺性别必须被提示');
  assert.ok(!validateAssetsStage(withoutGender).some(issue => issue.includes('性别')), '提示不得阻断资产确认');
  const withGender = { ...withoutGender, assets: withoutGender.assets.map(asset => asset.kind === 'character' ? { ...asset, description: '十七岁少年，清瘦，灰白旧布衣' } : asset) };
  assert.ok(!assetWarnings(withGender).some(tip => tip.includes('性别')));
});

test('剧本警告只提示不阻断', () => {
  const warned = project({ shots: shots(false).map((shot, index) => index === 0 ? { ...shot, visual: '特写：主角抬手', dialogues: [{ id: 'd', speakerId: 'hero', text: '这是一句超过二十四个字的台词，需要精简一下才装得进镜头里。' }], assetIds: ['hero'] } : shot) });
  const warnings = scriptWarnings(warned);
  assert.ok(warnings.some(item => item.includes('镜头术语')));
  assert.ok(warnings.some(item => item.includes('超过 24 字')));
  assert.deepEqual(validateScriptStage(warned).filter(issue => issue.includes('台词') || issue.includes('镜头')), []);
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

test('原文模式下台词没有逐字出现在原文里时只提示不阻断', () => {
  const base = project({ scriptMode: 'source', sourceText: '赵珂冷笑一声，说：“废物。”' });
  const withLine = (text: string) => ({ ...base, shots: base.shots.map((shot, index) => index === 0 ? { ...shot, dialogues: [{ id: 'd', speakerId: 'hero', text }] } : shot) });
  assert.ok(!scriptWarnings(withLine('废物。')).some(item => item.includes('未在原文中找到')), '逐字台词不应被误报');
  assert.ok(scriptWarnings(withLine('你算什么东西。')).some(item => item.includes('未在原文中找到')), '改写过的台词必须被提示');
  assert.deepEqual(validateScriptStage(withLine('你算什么东西。')).filter(issue => issue.includes('台词')), [], '忠实度提示不得阻断剧本确认');
  assert.ok(!scriptWarnings(withLine('听说他是无命人。*基于原文背景合理补充*')).some(item => item.includes('未在原文中找到')), '标注过的合理补充不应被误报');
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

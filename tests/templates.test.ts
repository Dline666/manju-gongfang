import test from 'node:test';
import assert from 'node:assert/strict';
import { directorPrompt, directorSpec, extractCharactersPrompt, imagePrompt, scriptPrompt, scriptSpec, videoPrompt, videoSpec } from '../src/lib/prompts';
import { promptBlock, validatePromptSpec } from '../src/lib/promptSpec';
import { findUnknownVariables } from '../src/lib/promptTemplates';
import { builtinBlocks, builtinBlocksFor, dataSourcesFor, migratePromptConfig } from '../src/lib/promptBlocks';
import { effectivePlan, effectiveStyle, ownsKind, ownsStyle } from '../src/lib/promptScope';
import { savedStudioSchema } from '../src/store/schema';
import { defaultSettings, defaultStyle, makeShot, type Asset, type Project, type PromptTemplateSet } from '../src/domain/types';

const hero: Asset = { id: 'hero', kind: 'character', name: '沈砚', description: '灰白布衣', lock: '十七岁少年，灰白旧布衣，背空剑鞘', imageId: 'image-hero' };
const scene: Asset = { id: 'scene', kind: 'scene', name: '山门', description: '石阶', lock: '青灰石阶九十九级，晨雾低垂', imageId: 'image-scene' };

function makeProject(promptConfig?: Project['promptConfig']): Project {
  return {
    id: 'project', name: '断剑归门', theme: '少年拾起断剑', style: defaultStyle,
    createdAt: '', updatedAt: '', revision: 0, source: 'template', skills: ['script', 'storyboard', 'image', 'video'],
    storyboardReady: true, assets: [hero, scene],
    shots: [{ ...makeShot(1), visual: '沈砚走上石阶', start: '石阶前', action: '抬手', end: '站定', dialogues: [{ id: 'd1', speakerId: 'hero', text: '我回来了。' }] }],
    promptConfig,
  };
}

const blocks = (...texts: string[]) => texts.map((text, index) => ({ id: `b${index}`, title: `块${index}`, text }));

test('内置块目录齐全：39 条，只有标题没有默认文案', () => {
  assert.equal(builtinBlocks.length, 39);
  for (const block of builtinBlocks) {
    assert.equal(typeof block.id, 'string');
    assert.ok(block.title.length > 0, `${block.id} 必须有标题`);
    assert.equal((block as { defaultText?: unknown }).defaultText, undefined, `${block.id} 不得带默认文案`);
    assert.equal((block as { locked?: unknown }).locked, undefined, `${block.id} 不得锁定`);
  }
  assert.deepEqual(builtinBlocksFor('script').map(block => block.id).slice(0, 3), ['script.contract', 'script.structure', 'script.screenplay-format']);
  assert.deepEqual(builtinBlocksFor('extract-characters').map(block => block.id), ['extract.characters.instruction', 'extract.characters.phrase-style', 'extract.characters.forbidden']);
  assert.deepEqual(builtinBlocksFor('extract-scenes').map(block => block.group), ['场景', '场景', '场景']);
  assert.deepEqual(builtinBlocksFor('extract-props').map(block => block.group), ['道具', '道具', '道具']);
});

test('没有默认提示词：渲染只包含作品数据', () => {
  const project = makeProject();
  const script = scriptPrompt(project);
  assert.ok(!script.includes('【剧本结构】'));
  assert.ok(!script.includes('【时长可行性】'));
  assert.ok(!script.includes('【优先级】'));
  assert.ok(!imagePrompt(project, hero).includes('只输出一张角色三视图'));
  assert.ok(!videoPrompt(project, project.shots[0]).includes('动作按时间顺序描述'));
  assert.ok(!directorPrompt(project).includes('【镜头分配规则】'));
  const director = directorSpec(project);
  for (const block of director.blocks) {
    // 注入的作品数据是锁定块；用户写的块永远可编辑
    assert.equal(block.locked, block.id.startsWith('data.') ? true : false, `${block.id} 的锁定状态不对`);
  }
});

test('数据源清单按 kind 覆盖三类提取与四个步骤，且不属于模板块', () => {
  assert.deepEqual(dataSourcesFor('script').map(item => item.source), ['script.theme', 'script.source', 'script.characters', 'script.skills']);
  assert.deepEqual(dataSourcesFor('extract-characters').map(item => item.source), ['extract.characters.shots', 'extract.characters.existing']);
  assert.deepEqual(dataSourcesFor('extract-scenes').map(item => item.source), ['extract.scenes.shots', 'extract.scenes.existing']);
  assert.deepEqual(dataSourcesFor('extract-props').map(item => item.source), ['extract.props.shots', 'extract.props.existing']);
  assert.ok(dataSourcesFor('director').some(item => item.source === 'director.shots'));
  assert.ok(dataSourcesFor('image').some(item => item.source === 'image.subject'));
  assert.ok(dataSourcesFor('video').some(item => item.source === 'video.assets'));
  for (const kind of ['script', 'director', 'image', 'video'] as const) {
    assert.ok(dataSourcesFor(kind).some(item => item.source.endsWith('skills')), `${kind} 必须有 Skill 数据源`);
  }
});

test('模板默认是空的：没有用户计划就没有块，数据由系统固定注入', () => {
  const project = makeProject();
  for (const kind of ['script', 'extract-characters', 'director', 'image', 'video'] as const) {
    assert.deepEqual(effectivePlan(project, kind), [], `${kind} 的模板默认应为空`);
  }
  const script = scriptSpec(project);
  assert.ok(script.blocks.length > 0, '数据仍要注入，提示词不能空');
  assert.ok(script.blocks.every(block => block.locked === true), '注入的数据块不可编辑');
  assert.ok(script.blocks.every(block => block.id.startsWith('data.')), '注入块只来自数据源');
});

test('旧存档里的数据块从模板消失，用户写过的补充说明保留成普通块', () => {
  const project = makeProject({ v: 2, templates: { 'extract-characters': { blocks: [
    { id: 'data.extract.characters.shots', title: '本类线索', text: '', source: 'extract.characters.shots' } as never,
    { id: 'data.extract.characters.existing', title: '已有本类固定资产', text: '只认有台词的', source: 'extract.characters.existing' } as never,
    { id: 'mine', title: '我的规则', text: '按我的口径识别。' },
  ] } } });
  const migrated = migratePromptConfig(project.promptConfig)!;
  assert.equal(migrated.v, 3, '旧存档要迁到覆盖层结构');
  const upgraded = { ...project, promptConfig: migrated };
  const plan = effectivePlan(upgraded, 'extract-characters');
  assert.equal(plan.length, 2, '空的数据块被剔除，有文字的留下');
  assert.equal(plan[0].id, 'legacy.extract.characters.existing');
  assert.equal(plan[0].text, '只认有台词的');
  assert.equal(plan[0].source, undefined, '留下的块不再是数据块');
  assert.equal(plan[1].id, 'mine');
  const text = extractCharactersPrompt(upgraded);
  assert.ok(text.includes('按我的口径识别。'));
  assert.ok(text.includes('【说话人清单】'), '数据仍由系统注入');
  assert.ok(text.indexOf('按我的口径识别。') < text.indexOf('【说话人清单】'), '用户块排在数据前面');
});

test('用户块计划按顺序渲染，空块被跳过，数据固定跟在后面', () => {
  const project = makeProject({ v: 3, overrides: { templates: { script: { blocks: [
    { id: 'a', title: '甲', text: '第一条规则' },
    { id: 'b', title: '乙', text: '' },
    { id: 'c', title: '丙', text: '第三条规则' },
  ] } } } });
  const script = scriptPrompt(project);
  assert.ok(script.startsWith('第一条规则\n\n第三条规则'), '用户块按顺序排在前面');
  assert.ok(script.indexOf('第一条规则') < script.indexOf('第三条规则'));
  assert.ok(script.includes('主题：少年拾起断剑'), '作品数据仍由系统注入');
  assert.ok(script.indexOf('第三条规则') < script.indexOf('主题：少年拾起断剑'), '数据排在用户块之后');
});

test('全局模板是默认：作品没有覆盖时用全局的', () => {
  const project = makeProject();
  const global: PromptTemplateSet = { templates: { script: { blocks: blocks('全局剧本规则') } } };
  assert.deepEqual(effectivePlan(project, 'script', global).map(block => block.text), ['全局剧本规则']);
  const script = scriptPrompt(project, global);
  assert.ok(script.includes('全局剧本规则'), '全局模板必须进入剧本提示词');
  assert.ok(script.indexOf('全局剧本规则') < script.indexOf('主题：少年拾起断剑'), '用户块在前，数据在后');
  assert.ok(scriptPrompt(project).includes('主题：少年拾起断剑'));
  assert.ok(!scriptPrompt(project).includes('全局剧本规则'), '没有全局模板时不受影响');
});

test('作品覆盖优先于全局：没覆盖的步骤仍跟随全局', () => {
  const global: PromptTemplateSet = { templates: { script: { blocks: blocks('全局剧本规则') }, director: { blocks: blocks('全局导演规则') } } };
  const project = makeProject({ v: 3, overrides: { templates: { script: { blocks: blocks('本作品剧本规则') } } } });
  assert.deepEqual(effectivePlan(project, 'script', global).map(block => block.text), ['本作品剧本规则']);
  assert.deepEqual(effectivePlan(project, 'director', global).map(block => block.text), ['全局导演规则'], '没覆盖的步骤跟随全局');
  assert.ok(scriptPrompt(project, global).includes('本作品剧本规则'));
  assert.ok(!scriptPrompt(project, global).includes('全局剧本规则'), '被覆盖的步骤不再用全局内容');
  assert.ok(directorPrompt(project, global).includes('全局导演规则'));
});

test('「本作品这一步是空的」与「跟随全局」是两件事', () => {
  const global: PromptTemplateSet = { templates: { script: { blocks: blocks('全局剧本规则') } } };
  const project = makeProject({ v: 3, overrides: { templates: { script: { blocks: [] } } } });
  assert.deepEqual(effectivePlan(project, 'script', global), [], '显式空的覆盖仍然归作品管');
  assert.equal(ownsKind(project, 'script'), true);
  assert.ok(!scriptPrompt(project, global).includes('全局剧本规则'), '显式空的覆盖不跟随全局');
  const following = makeProject();
  assert.equal(ownsKind(following, 'script'), false);
  assert.deepEqual(effectivePlan(following, 'script', global).map(block => block.text), ['全局剧本规则']);
});

test('风格设定：作品覆盖优先，其次全局，最后空', () => {
  const global: PromptTemplateSet = { style: { medium: '全局介质' } };
  const project = makeProject();
  assert.equal(effectiveStyle(project, global).medium, '全局介质');
  assert.equal(ownsStyle(project), false);
  const own = makeProject({ v: 3, overrides: { style: { medium: '本作品介质' } } });
  assert.equal(effectiveStyle(own, global).medium, '本作品介质');
  assert.equal(ownsStyle(own), true);
  const empty = makeProject({ v: 3, overrides: { style: {} } });
  assert.deepEqual(effectiveStyle(empty, global), {}, '显式空的风格覆盖不跟随全局');
  assert.deepEqual(effectiveStyle(project), {}, '都没有时是空：系统不预置画风文案');
});

test('风格设定展开到图片/视频提示词，project.style 仍保留', () => {
  const project = makeProject({ v: 3, overrides: { style: { medium: '测试介质', palette: '测试配色', forbidden: ['水印', '文字'] } } });
  const image = imagePrompt(project, scene);
  assert.ok(image.includes('介质：测试介质'));
  assert.ok(image.includes('配色：测试配色'));
  const video = videoPrompt(project, project.shots[0]);
  assert.ok(video.includes('【风格块】'));
  assert.ok(video.includes('测试介质'));
  assert.equal(project.style, defaultStyle);
});

test('变量白名单：已知变量替换，未知变量被报告', () => {
  assert.deepEqual(findUnknownVariables('{{project.theme}} {{style.medium}}'), []);
  assert.deepEqual(findUnknownVariables('{{unknown.extra}} {{project.theme}} {{bad}}'), ['unknown.extra', 'bad']);
  const project = makeProject({ v: 3, overrides: { templates: { script: { blocks: [{ id: 'g', title: '题材', text: '题材：{{project.theme}}，{{unknown.extra}}' }] } } } });
  assert.ok(scriptPrompt(project).includes('题材：少年拾起断剑，{{unknown.extra}}'));
});

test('预算校验：视频提示词超过 7000 字会报告', () => {
  const project = makeProject({ v: 3, overrides: { templates: { video: { blocks: [{ id: 'long', title: '禁写', text: `禁写：${'x'.repeat(8000)}` }] } } } });
  const prompt = videoPrompt(project, project.shots[0]);
  assert.ok(prompt.length > 7000);
  const issues = validatePromptSpec(videoSpec(project, project.shots[0]));
  assert.ok(issues.some(issue => issue.includes('超过上限')), issues.join('；'));
});

test('存档迁移：v1 → v3，用户写过的步骤进覆盖层，没写过的跟随全局', () => {
  const migrated = migratePromptConfig({ v: 1, style: { medium: '宣纸' }, blocks: { 'script.drama': '只写雨夜', 'extract.characters.instruction': '只认有台词的', 'extract.instruction': '旧合并键' } });
  assert.ok(migrated);
  assert.equal(migrated!.v, 3);
  const overrides = migrated!.overrides!;
  assert.deepEqual(overrides.style, { medium: '宣纸' });
  const script = overrides.templates!.script!;
  assert.equal(script.blocks.length, 1, '只迁移用户改过的块');
  assert.equal(script.blocks[0].text, '只写雨夜');
  assert.equal(script.blocks[0].title, '剧作规范');
  assert.equal(script.blocks[0].builtin, 'script.drama');
  const characters = overrides.templates!['extract-characters']!;
  assert.equal(characters.blocks.length, 1);
  assert.equal(characters.blocks[0].text, '只认有台词的');
  assert.equal(overrides.templates!['extract-scenes'], undefined, '旧合并键不迁入其它品类');
  assert.equal(overrides.templates!.director, undefined, '没写过的步骤不进覆盖层，跟随全局');
  assert.equal(migratePromptConfig(undefined), undefined);
});

test('存档迁移：v2 的空步骤不进覆盖层，有内容的步骤进覆盖层', () => {
  const migrated = migratePromptConfig({ v: 2, templates: {
    script: { blocks: [{ id: 'a', title: '甲', text: '只写雨夜' }] },
    director: { blocks: [] },
  } });
  assert.equal(migrated!.v, 3);
  assert.equal(migrated!.overrides!.templates!.script!.blocks.length, 1);
  assert.equal(migrated!.overrides!.templates!.director, undefined, '空步骤跟随全局');
  assert.equal(migrated!.overrides!.style, undefined, '没设风格就不进覆盖层');
});

test('promptConfig 可选字段能通过存档 schema，旧作品不受影响', () => {
  const withConfig = makeProject({ v: 3, overrides: { style: { medium: '宣纸' }, templates: { script: { blocks: [{ id: 'a', title: '甲', text: '只写雨夜' }] } } } });
  const saved = savedStudioSchema.parse({ version: 1, projects: [withConfig], activeId: withConfig.id, settings: defaultSettings });
  assert.deepEqual(saved.projects[0].promptConfig, withConfig.promptConfig);
  const legacy = makeProject();
  assert.equal(savedStudioSchema.parse({ version: 1, projects: [legacy], activeId: legacy.id, settings: defaultSettings }).projects[0].promptConfig, undefined);
  const v1 = makeProject({ v: 1, blocks: { 'script.drama': '只写雨夜' } });
  assert.doesNotThrow(() => savedStudioSchema.parse({ version: 1, projects: [v1], activeId: v1.id, settings: defaultSettings }));
  const v2 = makeProject({ v: 2, templates: { script: { blocks: [{ id: 'a', title: '甲', text: '只写雨夜' }] } } });
  assert.doesNotThrow(() => savedStudioSchema.parse({ version: 1, projects: [v2], activeId: v2.id, settings: defaultSettings }));
});

test('全局提示词模板能通过存档 schema', () => {
  const settings = { ...defaultSettings, promptTemplates: { style: { medium: '宣纸' }, templates: { script: { blocks: [{ id: 'a', title: '甲', text: '只写雨夜' }] } } } };
  const saved = savedStudioSchema.parse({ version: 1, projects: [], activeId: null, settings });
  assert.deepEqual(saved.settings.promptTemplates, settings.promptTemplates);
});

test('剧本层与导演层互不串块', () => {
  const project = makeProject();
  const script = scriptSpec(project);
  assert.ok(!script.blocks.some(block => block.id.startsWith('director.')));
  const director = directorSpec(project);
  assert.ok(director.blocks.some(block => block.id === 'data.director.shots'));
  assert.ok(promptBlock(director, 'data.director.shots'));
});

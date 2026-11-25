import test from 'node:test';
import assert from 'node:assert/strict';
import { directorPrompt, directorSpec, extractCharactersPrompt, imagePrompt, scriptPrompt, scriptSpec, videoPrompt, videoSpec } from '../src/lib/prompts';
import { promptBlock, validatePromptSpec } from '../src/lib/promptSpec';
import { findUnknownVariables } from '../src/lib/promptTemplates';
import { builtinBlocks, builtinBlocksFor, dataSourcesFor, factoryBlockText, migratePromptConfig, migrateTemplateSet, skillsForKind, withFactoryDefaults } from '../src/lib/promptBlocks';
import { migrateSettings } from '../src/lib/endpoints';
import { effectivePlan, effectiveSkillId, effectiveStyle, ownsKind, ownsStyle } from '../src/lib/promptScope';
import { savedStudioSchema } from '../src/store/schema';
import { defaultPromptTemplates, defaultSettings, defaultSkillLibrary, defaultStyle, makeShot, type Asset, type Project, type PromptTemplateSet } from '../src/domain/types';

const hero: Asset = { id: 'hero', kind: 'character', name: '沈砚', description: '灰白布衣', lock: '十七岁少年，灰白旧布衣，背空剑鞘', imageId: 'image-hero' };
const scene: Asset = { id: 'scene', kind: 'scene', name: '山门', description: '石阶', lock: '青灰石阶九十九级，晨雾低垂', imageId: 'image-scene' };
const prop: Asset = { id: 'prop', kind: 'prop', name: '断剑', description: '断口有金光', lock: '红绳缠绕的剑柄，断口有微弱金色灵光', imageId: 'image-prop' };

function makeProject(promptConfig?: Project['promptConfig']): Project {
  return {
    id: 'project', name: '断剑归门', theme: '少年拾起断剑', style: defaultStyle,
    createdAt: '', updatedAt: '', revision: 0, source: 'template', skills: ['script', 'storyboard', 'image', 'video'],
    storyboardReady: true, assets: [hero, scene, prop],
    shots: [{ ...makeShot(1), visual: '沈砚走上石阶', start: '石阶前', action: '抬手', end: '站定', dialogues: [{ id: 'd1', speakerId: 'hero', text: '我回来了。' }] }],
    promptConfig,
  };
}

const blocks = (...texts: string[]) => texts.map((text, index) => ({ id: `b${index}`, title: `块${index}`, text }));

test('内置块目录齐全：46 条，只有标题没有默认文案', () => {
  assert.equal(builtinBlocks.length, 46);
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

test('设定图分人物 / 场景 / 道具三份，互不混用', () => {
  assert.deepEqual(builtinBlocksFor('image-character').map(block => block.id), ['image.character.three-view', 'image.character.forbidden', 'image.character.priority']);
  assert.deepEqual(builtinBlocksFor('image-scene').map(block => block.id), ['image.scene.composition', 'image.scene.forbidden', 'image.scene.priority']);
  assert.deepEqual(builtinBlocksFor('image-prop').map(block => block.id), ['image.prop.composition', 'image.prop.forbidden', 'image.prop.priority']);
  for (const kind of ['image-character', 'image-scene', 'image-prop'] as const) {
    assert.equal(builtinBlocksFor(kind).length, 3, `${kind} 有三块`);
    assert.ok(!builtinBlocksFor(kind).some(block => block.id.includes('character') && kind !== 'image-character'), `${kind} 不该混进别的人物块`);
  }
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
  assert.ok(dataSourcesFor('director').some(item => item.source === 'director.screenplay'));
  for (const kind of ['image-character', 'image-scene', 'image-prop'] as const) {
    assert.deepEqual(dataSourcesFor(kind).map(item => item.source), ['image.task', 'image.subject', 'image.style', 'image.skills'], `${kind} 的数据源`);
  }
  assert.ok(dataSourcesFor('video').some(item => item.source === 'video.assets'));
  for (const kind of ['script', 'director', 'image-character', 'image-scene', 'image-prop', 'video'] as const) {
    assert.ok(dataSourcesFor(kind).some(item => item.source.endsWith('skills')), `${kind} 必须有 Skill 数据源`);
  }
});

test('模板默认是空的：没有用户计划就没有块，数据由系统固定注入', () => {
  const project = makeProject();
  for (const kind of ['script', 'extract-characters', 'director', 'image-character', 'video'] as const) {
    assert.deepEqual(effectivePlan(project, kind as never), [], `${kind} 的模板默认应为空`);
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

test('设定图按品类各用各的模板，互不串', () => {
  const project = makeProject({ v: 3, overrides: { templates: {
    'image-character': { blocks: [{ id: 'c', title: '人物', text: '人物设定图：正面、侧面、背面三视图。' }] },
    'image-scene': { blocks: [{ id: 's', title: '场景', text: '场景设定图：全景空镜，无人物。' }] },
    'image-prop': { blocks: [{ id: 'p', title: '道具', text: '道具设定图：单独陈列，纯色背景。' }] },
  } } });
  const characterPrompt = imagePrompt(project, hero);
  const scenePrompt = imagePrompt(project, scene);
  assert.ok(characterPrompt.includes('人物设定图'), '人物用人物模板');
  assert.ok(!characterPrompt.includes('场景设定图'), '人物提示词里不该有场景模板');
  assert.ok(scenePrompt.includes('场景设定图'), '场景用场景模板');
  assert.ok(!scenePrompt.includes('人物设定图'), '场景提示词里不该有人物模板');
  assert.ok(!scenePrompt.includes('道具设定图'), '场景提示词里不该有道具模板');
});

test('旧的共用设定图模板按品类拆开：内置块归类，用户块只落人物那份', () => {
  const legacy = makeProject({ v: 3, overrides: { templates: { image: { blocks: [
    { id: 'image.three-view', title: '人物三视图条款', text: '只输出一张三视图。', builtin: 'image.three-view' },
    { id: 'image.scene-composition', title: '场景构图说明', text: '空镜全景。', builtin: 'image.scene-composition' },
    { id: 'mine', title: '我的规则', text: '统一打光。' },
  ] } } } });
  const migrated = migratePromptConfig(legacy.promptConfig)!;
  const templates = migrated.overrides!.templates!;
  assert.equal((templates as Record<string, unknown>).image, undefined, '旧的那份不再保留');
  assert.deepEqual(templates['image-character']!.blocks.map(block => block.text), ['只输出一张三视图。', '统一打光。']);
  assert.deepEqual(templates['image-scene']!.blocks.map(block => block.text), ['空镜全景。']);
  assert.equal(templates['image-prop'], undefined, '道具那份没有内容就不建');
  assert.equal(templates['image-character']!.blocks[0].id, 'image.character.three-view', '块 id 跟着新目录改名');
  assert.equal(templates['image-character']!.blocks[1].shared, true, '用户块标出来历：过去三类共用');
});

test('旧模板的用户块不会跑到场景与道具的提示词里', () => {
  const legacy = makeProject({ v: 3, overrides: { templates: { image: { blocks: [
    { id: 'mine', title: '角色条款', text: '只输出一张角色设定卡：正面、侧面、背面三视图。' },
  ] } } } });
  const upgraded = { ...legacy, promptConfig: migratePromptConfig(legacy.promptConfig)! };
  const characterPrompt = imagePrompt(upgraded, hero);
  const scenePrompt = imagePrompt(upgraded, scene);
  const propPrompt = imagePrompt(upgraded, prop);
  assert.ok(characterPrompt.includes('三视图'), '人物图仍用这段规则');
  assert.ok(!scenePrompt.includes('三视图'), '场景图不该带人物条款');
  assert.ok(!propPrompt.includes('三视图'), '道具图不该带人物条款');
  assert.ok(scenePrompt.includes('主体：'), '场景图仍然带作品数据');
});

test('已经被旧规则拆过的存档：三份里的同 id 副本只留人物那份', () => {
  const copy = { id: 'mine', title: '角色条款', text: '只输出一张角色设定卡：正面、侧面、背面三视图。' };
  const alreadySplit = makeProject({ v: 3, overrides: { templates: {
    'image-character': { blocks: [{ ...copy }] },
    'image-scene': { blocks: [{ ...copy }] },
    'image-prop': { blocks: [{ ...copy }] },
  } } });
  const migrated = migratePromptConfig(alreadySplit.promptConfig)!;
  const templates = migrated.overrides!.templates!;
  assert.equal(templates['image-character']!.blocks.length, 1, '人物那份留下');
  assert.deepEqual(templates['image-scene']!.blocks, [], '场景那份的副本清掉');
  assert.deepEqual(templates['image-prop']!.blocks, [], '道具那份的副本清掉');
  assert.equal(templates['image-character']!.blocks[0].shared, true, '留下来的那份标出来历');
});

test('迁移是幂等的：人物那份不会被自己的副本规则误伤', () => {
  const copy = { id: 'mine', title: '角色条款', text: '只输出一张角色设定卡。' };
  const once = migratePromptConfig(makeProject({ v: 3, overrides: { templates: {
    'image-character': { blocks: [{ ...copy }] },
    'image-scene': { blocks: [{ ...copy }] },
  } } }).promptConfig)!;
  const twice = migratePromptConfig(once)!;
  assert.deepEqual(twice.overrides!.templates!['image-character']!.blocks.map(block => block.text), [copy.text]);
  assert.deepEqual(twice.overrides!.templates!['image-scene']!.blocks, []);
});

test('全局模板里的旧共用模板同样只落人物那份', () => {
  const migrated = migrateTemplateSet({ templates: { image: { blocks: [
    { id: 'mine', title: '角色条款', text: '只输出一张角色设定卡。' },
  ] } } })!;
  const templates = migrated.templates!;
  assert.equal((templates as Record<string, unknown>).image, undefined);
  assert.equal(templates['image-character']!.blocks.length, 1);
  assert.equal(templates['image-scene'], undefined, '场景那份不建');
  assert.equal(templates['image-prop'], undefined, '道具那份不建');
});

test('剧本层与导演层互不串块', () => {
  const project = makeProject();
  const script = scriptSpec(project);
  assert.ok(!script.blocks.some(block => block.id.startsWith('director.')));
  const director = directorSpec(project);
  assert.ok(director.blocks.some(block => block.id === 'data.director.screenplay'));
  assert.ok(promptBlock(director, 'data.director.screenplay'));
});
test('出厂全局模板带三类资产提取规则与设定图出图约定', () => {
  const templates = defaultPromptTemplates.templates!;
  assert.ok(templates.script!.blocks.some(block => block.id === 'script.characters.extract'), '剧本栏要有人物提取规则');
  assert.ok(templates.script!.blocks.some(block => block.id === 'script.scenes.extract'), '剧本栏要有场景提取规则');
  assert.ok(templates.script!.blocks.some(block => block.id === 'script.props.extract'), '剧本栏要有道具提取规则');
  assert.ok(templates['image-character']!.blocks.some(block => block.id === 'image.character.three-view'), '图片栏要有人物出图约定');
  assert.ok(templates['image-scene']!.blocks.some(block => block.id === 'image.scene.composition'), '图片栏要有场景出图约定');
  assert.ok(templates['image-prop']!.blocks.some(block => block.id === 'image.prop.composition'), '图片栏要有道具出图约定');
  // 出图约定只管设定图：不能混进资产固定短语，否则会污染视频提示词。
  const characterRule = templates.script!.blocks.find(block => block.id === 'script.characters.extract')!.text;
  assert.ok(!characterRule.includes('3D风格'), '出图约定不进资产提取规则');
  assert.ok(!characterRule.includes('纯白'), '出图约定不进资产提取规则');
  assert.ok(characterRule.includes('代称'), '提取规则要约束代称');
  assert.ok(characterRule.includes('鞋子款式'), '提取规则要约束鞋子款式');
});

test('出厂模板能通过存档 schema，旧作品不受影响', () => {
  const saved = savedStudioSchema.parse({ version: 1, projects: [], activeId: null, settings: defaultSettings });
  assert.ok(saved.settings.promptTemplates, '出厂模板要能存进本机存档');
  assert.equal(saved.settings.promptTemplates!.templates!.script!.blocks.length, 4);
});

test('存档里缺某一步时，用出厂模板把这一步补上', () => {
  const filled = withFactoryDefaults({ templates: {} });
  assert.equal(filled.templates!.script!.blocks.length, 4, '空存档要拿到剧本栏的出厂块（镜数与时长 + 三条提取规则）');
  assert.equal(filled.templates!['image-character']!.blocks.length, 1, '图片栏也要有出厂的出图约定');
});

test('存档里已有的步骤不被出厂模板覆盖，主动清空的步骤保持为空', () => {
  const mine = { id: 'mine', title: '我的剧本规则', text: '只写雨夜。' };
  const filled = withFactoryDefaults({ templates: { script: { blocks: [mine] } } });
  assert.deepEqual(filled.templates!.script!.blocks, [mine], '我自己写的那一步原样保留');
  assert.equal(filled.templates!['image-scene']!.blocks.length, 1, '缺的步骤用出厂的补上');
  const emptied = withFactoryDefaults({ templates: { script: { blocks: [] } } });
  assert.equal(emptied.templates!.script!.blocks.length, 0, '主动清空的步骤保持为空');
});

test('老存档（早期版本留下的空全局模板）也能拿到出厂模板', () => {
  const settings = migrateSettings({
    scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance',
    speechModel: 'speech-2.8-hd', styles: [],
    promptTemplates: { templates: {} },
  });
  assert.equal(settings.promptTemplates!.templates!.script!.blocks.length, 4, '老存档要补上出厂的剧本块');
  assert.equal(settings.promptTemplates!.templates!['image-prop']!.blocks.length, 1);
});

test('出厂 Skill 库：每个步骤一份空槽位，正文留给用户写', () => {
  assert.equal(defaultSkillLibrary.length, 9, '九个步骤各留一个槽位');
  for (const skill of defaultSkillLibrary) assert.equal(skill.template, '', '系统不预置任何 Skill 正文');
  assert.equal(skillsForKind(defaultSkillLibrary, 'script').length, 1);
  assert.equal(skillsForKind(defaultSkillLibrary, 'script')[0].name, '小说转剧本');
  assert.equal(skillsForKind(defaultSkillLibrary, 'director')[0].name, '剧本生分镜');
});

test('Skill 库随存档走：老存档补上出厂的，用户自己清空过就不再补', () => {
  const base = { scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance', speechModel: 'speech-2.8-hd', styles: [] };
  const filled = migrateSettings({ ...base, promptTemplates: { templates: {} } });
  assert.equal(filled.promptTemplates!.skills!.length, 9, '老存档要拿到出厂的 Skill 库');
  const cleared = migrateSettings({ ...base, promptTemplates: { templates: {}, skills: [] } });
  assert.deepEqual(cleared.promptTemplates!.skills, [], '用户自己清空过就不再补');
});

test('每步选中的 Skill：作品覆盖优先，其次全局，都没有就没有', () => {
  const global: PromptTemplateSet = { templates: { script: { blocks: [], skill: 'g' } } };
  assert.equal(effectiveSkillId(makeProject(), 'script', global), 'g');
  const owned = makeProject({ v: 3, overrides: { templates: { script: { blocks: [], skill: 'p' } } } });
  assert.equal(effectiveSkillId(owned, 'script', global), 'p', '作品自己管的这一步用作品选的那份');
  const ownedNone = makeProject({ v: 3, overrides: { templates: { script: { blocks: [] } } } });
  assert.equal(effectiveSkillId(ownedNone, 'script', global), undefined, '作品管了这一步却没选，就不用全局那份');
  assert.equal(effectiveSkillId(makeProject(), 'video', global), undefined, '没管过的步骤没有 Skill');
});

test('选中的 Skill 每次都进提示词：用户块之后、作品数据之前', () => {
  const global: PromptTemplateSet = {
    skills: [{ id: 's1', name: '小说转剧本', template: '按小说原文改写成漫剧剧本。', kinds: ['script'] }],
    templates: { script: { blocks: blocks('我写的剧本规则'), skill: 's1' } },
  };
  const prompt = scriptPrompt(makeProject(), global);
  assert.ok(prompt.includes('按小说原文改写成漫剧剧本。'), '所选 Skill 的正文要进提示词');
  const spec = scriptSpec(makeProject(), global);
  const ids = spec.blocks.map(block => block.id);
  assert.ok(ids.indexOf('b0') < ids.indexOf('skill.s1'), 'Skill 排在用户写的块之后');
  assert.ok(ids.indexOf('skill.s1') < ids.indexOf('data.script.theme'), 'Skill 排在作品数据之前');
  const skillBlock = promptBlock(spec, 'skill.s1');
  assert.equal(skillBlock?.locked, true, 'Skill 是系统附带的锁定块，用户不能在模板块里改它');
});

test('空正文的 Skill 不进提示词；没选 Skill 时内置附加 Skill 照旧', () => {
  const empty: PromptTemplateSet = {
    skills: [{ id: 's1', name: '空 Skill', template: '   ', kinds: ['script'] }],
    templates: { script: { blocks: blocks('我写的剧本规则'), skill: 's1' } },
  };
  const plain = scriptPrompt(makeProject(), empty);
  assert.ok(!plain.includes('空 Skill'), '空正文不进提示词');
  assert.ok(!plain.includes('按四部分结构写出完整剧本'), '选了这一步的 Skill，就不再叠加作品级勾选的内置附加 Skill');
  const without = scriptPrompt(makeProject(), { templates: { script: { blocks: blocks('我写的剧本规则') } } });
  assert.ok(without.includes('按四部分结构写出完整剧本'), '没选 Skill 时，原来的附加 Skill 照旧');
});

test('下拉只列适用于这一步的 Skill', () => {
  const library = [
    { id: 'a', name: 'A', template: 'x', kinds: ['script'] as const },
    { id: 'b', name: 'B', template: 'y', kinds: [] as const },
  ].map(skill => ({ ...skill, kinds: [...skill.kinds] }));
  assert.deepEqual(skillsForKind(library, 'script').map(skill => skill.id), ['a', 'b']);
  assert.deepEqual(skillsForKind(library, 'video').map(skill => skill.id), ['b'], '不限步骤的才到处都能选');
});

test('Skill 相关的字段能通过存档 schema', () => {
  const saved = savedStudioSchema.parse({
    version: 1, projects: [], activeId: null,
    settings: {
      scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance', speechModel: 'x',
      promptTemplates: { skills: [{ id: 's', name: 'n', template: 't', kinds: ['script'] }], templates: { script: { blocks: [], skill: 's' } } },
    },
  });
  assert.equal(saved.settings.promptTemplates!.skills!.length, 1);
  assert.equal(saved.settings.promptTemplates!.templates!.script!.skill, 's');
});

test('出厂剧本模板带「镜数与时长（硬性）」块，并标了新增说明', () => {
  const script = defaultPromptTemplates.templates!.script!.blocks;
  const spec = script.find(block => block.id === 'script.shot-spec');
  assert.ok(spec, '出厂剧本模板要有镜数与时长的条款块');
  assert.ok(spec!.text.includes('4、5 或 6 镜'), '条款里要写明镜数范围');
  assert.ok(spec!.text.includes('10–15 秒'), '条款里要写明单镜时长');
  assert.ok(spec!.text.includes('40–90 秒'), '条款里要写明总时长');
  assert.ok(spec!.text.includes('（时长12s）'), '条款里要写明显式时长标记的格式');
  assert.ok(spec!.note?.includes('新增'), '新增的块要带说明，界面上能看到');
});

test('停用的块不进提示词，内容还留着；恢复默认能把出厂正文找回来', () => {
  const global: PromptTemplateSet = {
    templates: { script: { blocks: [
      { id: 'b0', title: '开着', text: '开着的内容' },
      { id: 'b1', title: '停用', text: '停用的内容', enabled: false },
    ] } },
  };
  const prompt = scriptPrompt(makeProject(), global);
  assert.ok(prompt.includes('开着的内容'));
  assert.ok(!prompt.includes('停用的内容'), '停用的块不进提示词');
  assert.equal(global.templates!.script!.blocks![1].text, '停用的内容', '停用不删内容');
  assert.equal(factoryBlockText('script', 'script.shot-spec'), defaultPromptTemplates.templates!.script!.blocks![0].text, '恢复默认能拿回出厂正文');
  assert.equal(factoryBlockText('script', '不存在的块'), undefined, '没有出厂文案的块就没有恢复默认');
});

test('内置 Skill 的正文可改副本：改过的用用户的，没改的用出厂的', () => {
  const overridden: PromptTemplateSet = { builtinSkills: { script: '我改过的剧本 Skill 正文。' } };
  const prompt = scriptPrompt(makeProject(), overridden);
  assert.ok(prompt.includes('我改过的剧本 Skill 正文。'), '改过的内置 Skill 正文要进提示词');
  assert.ok(!prompt.includes('按四部分结构写出完整剧本'), '改过的内置 Skill 取代出厂文案');
  const plain = scriptPrompt(makeProject(), {});
  assert.ok(plain.includes('按四部分结构写出完整剧本'), '没改过的内置 Skill 仍用出厂文案');
  assert.ok(!plain.includes('我改过的剧本 Skill 正文。'));
});

test('镜数与时长相关的字段能通过存档 schema', () => {
  const saved = savedStudioSchema.parse({
    version: 1,
    projects: [{
      id: 'p', name: 'x', theme: '', style: '', createdAt: '', updatedAt: '', revision: 0,
      skills: ['script'], shots: [], assets: [], source: 'ai', storyboardReady: false,
      screenplay: 'x', specVersion: 'shot-spec-v1',
    }],
    activeId: null,
    settings: {
      scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance', speechModel: 'x',
      promptTemplates: {
        builtinSkills: { script: '改过的正文' },
        templates: { script: { blocks: [{ id: 'b', title: 't', text: 'x', enabled: false, note: '新增' }] } },
      },
    },
  });
  assert.equal(saved.projects![0].specVersion, 'shot-spec-v1');
  assert.equal(saved.settings.promptTemplates!.builtinSkills!.script, '改过的正文');
  assert.equal(saved.settings.promptTemplates!.templates!.script!.blocks![0].enabled, false);
  assert.equal(saved.settings.promptTemplates!.templates!.script!.blocks![0].note, '新增');
});

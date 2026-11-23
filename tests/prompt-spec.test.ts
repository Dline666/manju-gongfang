import test from 'node:test';
import assert from 'node:assert/strict';
import { assetText, assetPromptGroups, extractCharactersPrompt, extractPropsPrompt, extractScenesPrompt, fullAssetText, imagePrompt, scriptPrompt, videoPrompt } from '../src/lib/prompts';
import { promptBlock, renderPrompt, validatePromptSpec } from '../src/lib/promptSpec';
import { makeShot, type Asset, type Project } from '../src/domain/types';

const hero: Asset = { id: 'hero', kind: 'character', name: '沈砚', description: '黑发少年，灰白布衣', lock: '十七岁少年，灰白旧布衣，腰束麻绳，背空剑鞘', imageId: 'image-hero', voiceAssetId: 'voice' };
const scene: Asset = { id: 'scene', kind: 'scene', name: '山门', description: '石阶与薄雾', lock: '青灰石阶九十九级，两侧古松，晨雾低垂', imageId: 'image-scene' };
const prop: Asset = { id: 'prop', kind: 'prop', name: '断剑', description: '红绳缠柄', lock: '红绳缠绕的剑柄，斜断口，断口有微弱金色灵光', imageId: 'image-prop' };
const voice: Asset = { id: 'voice', kind: 'voice', name: '沈砚音色', description: '少年音，低沉克制', lock: '少年音，低沉克制', voiceId: 'voice-fixture', speed: 0.9 };

const shot = (number: number, patch: Partial<ReturnType<typeof makeShot>> = {}) => ({ ...makeShot(number), visual: `第${number}镜画面：沈砚走上石阶`, start: '石阶前', action: '抬手', end: '站在门前', camera: '缓慢推进', ...patch });

const project: Project = {
  id: 'project-fixture', name: '断剑归门', theme: '少年在雨夜拾起一把断剑', style: '东方玄幻水墨风，冷灰 + 金色灵光',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: 0,
  source: 'template', skills: ['script', 'storyboard', 'image', 'video'], storyboardReady: true,
  assets: [hero, scene, prop, voice],
  shots: [
    shot(1, { assetIds: ['hero', 'scene', 'prop'], references: [{ assetId: 'hero', role: 'reference_image' }, { assetId: 'scene', role: 'reference_image' }, { assetId: 'prop', role: 'reference_image' }], dialogues: [{ id: 'd1', speakerId: 'hero', text: '我回来了。' }] }),
    shot(2, { assetIds: ['hero'], references: [], dialogues: [{ id: 'd2', speakerId: 'hero', text: '门为什么关着。' }] }),
    shot(3, { assetIds: ['hero', 'scene'], references: [{ assetId: 'scene', role: 'first_frame' }, { assetId: 'hero', role: 'last_frame' }], dialogues: [], audioMode: 'silent' }),
  ],
};

const withPlan = (kind: 'script' | 'video' | 'extract-characters', blocks: { id: string; title: string; text: string }[]): Project => ({
  ...project,
  promptConfig: { v: 2, templates: { [kind]: { blocks } } },
});

test('没有模板计划时只输出作品数据，没有任何默认提示词文案', async () => {
  const script = scriptPrompt(project);
  assert.ok(!script.includes('【剧本结构】'), '剧本提示词不得自带默认结构条款');
  assert.ok(!script.includes('【忠实度】'), '不得自带默认忠实度条款');
  assert.ok(!script.includes('【可拍摄性铁律】'), '不得自带默认可拍摄性条款');
  assert.ok(!script.includes('输出契约'), '不得自带默认输出契约');
  assert.ok(script.includes('主题：少年在雨夜拾起一把断剑'), '主题数据必须进入提示词');
  assert.ok(script.includes('沈砚：十七岁少年'), '已有角色名必须进入提示词');

  assert.ok(!imagePrompt(project, hero).includes('三视图'), '图片提示词不得自带三视图条款');
  assert.ok(!videoPrompt(project, project.shots[0]).includes('【运动规范】'), '视频提示词不得自带默认运动规范');
  assert.ok(!extractCharactersPrompt(project).includes('【固定短语要求】'), '提取提示词不得自带默认识别规则');
  assert.ok(!extractScenesPrompt(project).includes('【收录判断】'));
  assert.ok(!extractPropsPrompt(project).includes('【提取范围】'));
});

test('用户模板按顺序渲染，变量替换生效', async () => {
  const planned = withPlan('script', [
    { id: 'rule-a', title: '规则A', text: '第一段：{{project.theme}}' },
    { id: 'rule-b', title: '规则B', text: '第二段：{{style.medium}}' },
  ]);
  const script = scriptPrompt(planned);
  assert.ok(script.startsWith('第一段：少年在雨夜拾起一把断剑'), '用户块在最前');
  assert.ok(script.includes('第二段：'), '变量缺失时留空而不是报错');
  assert.ok(script.indexOf('第一段') < script.indexOf('第二段'), '必须按用户排的顺序发送');
});

test('数据块与用户块拼接：用户补充在前，作品数据在后', async () => {
  const planned = withPlan('extract-characters', [
    { id: 'rule', title: '规则', text: '按我的口径识别。' },
    { id: 'data.extract.characters.shots', title: '本类线索', text: '', source: 'extract.characters.shots' } as never,
  ]);
  const text = extractCharactersPrompt(planned);
  assert.ok(text.includes('按我的口径识别。'));
  assert.ok(text.includes('【说话人清单】'));
  assert.ok(text.indexOf('按我的口径识别。') < text.indexOf('【说话人清单】'), '用户补充排在数据前面');
});

test('三类资产提示词各带本类专属线索，互不混入', async () => {
  const { extractCharactersSpec, extractScenesSpec, extractPropsSpec } = await import('../src/lib/prompts');
  const characters = extractCharactersSpec(project);
  const scenes = extractScenesSpec(project);
  const props = extractPropsSpec(project);
  const characterText = characters.blocks.map(item => item.text).join('\n');
  const sceneText = scenes.blocks.map(item => item.text).join('\n');
  const propText = props.blocks.map(item => item.text).join('\n');
  assert.ok(characterText.includes('【说话人清单】') && characterText.includes('沈砚'), '人物提示词给出说话人清单');
  assert.ok(sceneText.includes('【场景清单】') && sceneText.includes('所属空间'), '场景提示词按空间归组');
  assert.ok(propText.includes('【逐镜动作摘要】'), '道具提示词只看动作摘要');
  assert.ok(!propText.includes('说话人清单') && !characterText.includes('场景清单'), '三类输入互不混入');
  assert.equal(promptBlock(characters, 'data.extract.characters.existing')?.text.includes('沈砚音色'), false, '人物提示词不列其它品类资产');
  assert.equal(promptBlock(scenes, 'data.extract.scenes.existing')?.text.includes('沈砚'), false, '场景提示词不列人物资产');
});

test('没有任何锁定块：spec 里的块全部可编辑', async () => {
  const { scriptSpec, imageSpec, videoSpec, extractCharactersSpec, extractScenesSpec, extractPropsSpec, directorSpec } = await import('../src/lib/prompts');
  const specs = [scriptSpec(project), directorSpec(project), imageSpec(project, hero), videoSpec(project, project.shots[0]), extractCharactersSpec(project), extractScenesSpec(project), extractPropsSpec(project)];
  for (const spec of specs) {
    assert.equal(new Set(spec.blocks.map(item => item.id)).size, spec.blocks.length, '块 id 必须唯一');
    for (const block of spec.blocks) assert.notEqual(block.locked, true, `${spec.kind} / ${block.id} 不应是锁定块`);
  }
  assert.equal(assetPromptGroups(project, project.shots[0]).length, 3);
});

test('validatePromptSpec 报告重复 id、空提示词与超长', async () => {
  const { scriptSpec, videoSpec } = await import('../src/lib/prompts');
  assert.deepEqual(validatePromptSpec(scriptSpec(project)), []);
  assert.deepEqual(validatePromptSpec(videoSpec(project, project.shots[0])), []);
  const duplicate = validatePromptSpec({ kind: 'extract-characters', blocks: [{ id: 'a', label: 'A', text: 'x' }, { id: 'a', label: 'B', text: 'y' }] });
  assert.ok(duplicate.some(issue => issue.includes('重复')));
  const empty = validatePromptSpec({ kind: 'video', blocks: [] });
  assert.ok(empty.some(issue => issue.includes('提示词为空')));
  const oversized = validatePromptSpec({ kind: 'video', blocks: [{ id: 'v', label: '标题', text: 'x'.repeat(7001) }] });
  assert.ok(oversized.some(issue => issue.includes('超过上限')));
});

test('原文模式把原文注入剧本提示词，主题模式不注入', async () => {
  const plain = scriptPrompt(project);
  assert.ok(!plain.includes('赵珂冷笑一声'), '主题模式不应注入原文内容');
  const withSource = scriptPrompt({ ...project, scriptMode: 'source', sourceText: '赵珂冷笑一声，说：“废物。”' });
  assert.ok(withSource.includes('赵珂冷笑一声，说：“废物。”'));
  assert.ok(withSource.includes('<原文>'), '原文数据要有明确边界');
  assert.ok(!withSource.includes('绝对忠于原文'), '忠实度条款由用户自己写，系统不预置');
});

test('固定短语在图片、视频与资产文本里逐字复用', async () => {
  assert.ok(assetText(project, project.shots[0]).includes(hero.lock));
  assert.ok(imagePrompt(project, hero).includes(hero.lock));
  assert.ok(videoPrompt(project, project.shots[0]).includes(hero.lock));
  assert.ok(fullAssetText(project, project.shots[0]).includes(hero.lock));
});

test('剧本与导演提示词都在长度预算内', async () => {
  const { scriptSpec, directorSpec } = await import('../src/lib/prompts');
  assert.deepEqual(validatePromptSpec(scriptSpec(project)), []);
  assert.deepEqual(validatePromptSpec(directorSpec(project)), []);
  assert.ok(renderPrompt(scriptSpec(project)).length > 0);
});

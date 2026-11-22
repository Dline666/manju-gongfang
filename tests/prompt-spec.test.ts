import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assetText, assetPromptGroups, extractAssetsPrompt, fullAssetText, imagePrompt, scriptPrompt, videoPrompt } from '../src/lib/prompts';
import { SCRIPT_OUTPUT_EXAMPLE, applyPromptOverrides, promptBlock, renderPrompt, validatePromptSpec } from '../src/lib/promptSpec';
import { makeShot, type Asset, type Project } from '../src/domain/types';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

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

test('结构化改造后所有提示词逐字不变（SHA-256 基线）', () => {
  const cases: [string, string, string][] = [
    ['scriptPrompt', scriptPrompt(project), '5b54a16160efbe3783ea61898cda59279704c3f3b8940d69076b0292a0bdd956'],
    ['extractAssetsPrompt', extractAssetsPrompt(project), 'ab2542d037b225215c5509c3b200fa27adb2c9cd6e2ef251e0c9d1e0707e287d'],
    ['imageCharacter', imagePrompt(project, hero), 'da627d14c4e5bddb7b394cd58f4b0f367b609813778574be7ffa866000a5807c'],
    ['imageScene', imagePrompt(project, scene), '9614baab94d55047dccf7f385c4356dee43e6f7325ec44bd32cf1a7681a91c06'],
    ['imageProp', imagePrompt(project, prop), 'ab96342cd26ebf31994aa1435a5c6e16ac0839db5667febb77347240f92ee002'],
    ['videoNoRefs', videoPrompt(project, project.shots[1]), '5a0314d182dbe55c0a631aa108dd43e088cad97ec71a039c41d7013790fd00c1'],
    ['videoRefs', videoPrompt(project, project.shots[0]), '7b3afcf95737d1eecf1737872788906a112992b13e9a10ae938f517727859476'],
    ['videoDubbing', videoPrompt(project, { ...project.shots[0], audioMode: 'dubbing' }), 'd7503f2f8f56da08f408594049028bca883126dc419961e582872fc6dab40d0d'],
    ['videoFrames', videoPrompt(project, project.shots[2]), '3302aef924636a9999d32949b6a4289a1e8acd071b2f0232ded0be8ab256f8f2'],
    ['assetText', assetText(project, project.shots[0]), '68324922a1abb53d628317aea76330b7edf00246447b2cc818dd8786f265bf20'],
    ['fullAssetText', fullAssetText(project, project.shots[0]), '118f8795aa2cd0efeecce33eba32ca338bc771880d32ae8dc8dac1ec1f130d93'],
  ];
  for (const [name, text, expected] of cases) assert.equal(hash(text), expected, name);
});

test('spec 可 JSON 往返，块 id 唯一且锁定标记符合契约', async () => {
  const { scriptSpec, imageSpec, videoSpec, extractSpec } = await import('../src/lib/prompts');
  const script = scriptSpec(project);
  assert.deepEqual(JSON.parse(JSON.stringify(script)), script);
  assert.equal(new Set(script.blocks.map(item => item.id)).size, script.blocks.length);
  assert.equal(promptBlock(script, 'script.contract')?.locked, true);
  assert.equal(promptBlock(script, 'script.spec')?.locked, true);
  assert.equal(promptBlock(script, 'script.output-shape')?.locked, true);
  assert.equal(promptBlock(script, 'script.theme')?.locked, false);
  assert.equal(promptBlock(script, 'script.skills')?.locked, false);

  assert.equal(promptBlock(imageSpec(project, hero), 'image.subject')?.locked, true);
  assert.equal(promptBlock(imageSpec(project, hero), 'image.composition')?.locked, true);
  assert.equal(promptBlock(imageSpec(project, scene), 'image.composition')?.locked, false);

  const video = videoSpec(project, project.shots[0]);
  for (const id of ['video.references', 'video.audio', 'video.fixed-assets']) assert.equal(promptBlock(video, id)?.locked, true, id);
  assert.equal(promptBlock(extractSpec(project), 'extract.instruction')?.locked, true);
  assert.equal(assetPromptGroups(project, project.shots[0]).length, 3);
});

test('覆盖只作用于可编辑块，未知 id 被忽略', async () => {
  const { scriptSpec } = await import('../src/lib/prompts');
  const spec = scriptSpec(project);
  const lockedText = promptBlock(spec, 'script.contract')!.text;
  const overridden = applyPromptOverrides(spec, { 'script.contract': '篡改契约', 'script.theme': '新的主题', 'unknown.id': '忽略' });
  assert.equal(promptBlock(overridden, 'script.contract')!.text, lockedText);
  assert.equal(promptBlock(overridden, 'script.theme')!.text, '新的主题');
  assert.equal(promptBlock(overridden, 'unknown.id'), undefined);
  assert.ok(renderPrompt(overridden).includes('新的主题'));
});

test('validatePromptSpec 报告重复 id、缺失必需块与超长', async () => {
  const { scriptSpec, videoSpec } = await import('../src/lib/prompts');
  assert.deepEqual(validatePromptSpec(scriptSpec(project)), []);
  assert.deepEqual(validatePromptSpec(videoSpec(project, project.shots[0])), []);
  const duplicate = validatePromptSpec({ kind: 'assets', blocks: [{ id: 'asset.character', label: 'A', text: 'x' }, { id: 'asset.character', label: 'B', text: 'y' }] });
  assert.ok(duplicate.some(issue => issue.includes('重复')));
  const missing = validatePromptSpec({ kind: 'video', blocks: [] });
  assert.ok(missing.some(issue => issue.includes('video.shot-heading')));
  const oversized = validatePromptSpec({ kind: 'video', blocks: [{ id: 'video.shot-heading', label: '标题', text: 'x'.repeat(7001) }] });
  assert.ok(oversized.some(issue => issue.includes('超过上限')));
});

test('剧本输出契约是合法 JSON，镜头字段与后端一致', async () => {
  const { scriptSpec } = await import('../src/lib/prompts');
  const block = promptBlock(scriptSpec(project), 'script.output-shape')!;
  const contract = JSON.parse(block.text.replace(/^输出结构：/, '')) as typeof SCRIPT_OUTPUT_EXAMPLE;
  assert.deepEqual(Object.keys(contract), ['title', 'characters', 'scenes', 'props', 'shots']);
  assert.deepEqual(Object.keys(contract.shots[0]), ['visual', 'camera', 'start', 'action', 'end', 'duration', 'characters', 'scenes', 'props', 'dialogues']);
  assert.equal(contract.shots[0].duration, 9);
  assert.deepEqual(Object.keys(contract.shots[0].dialogues[0]), ['speaker', 'text']);
});

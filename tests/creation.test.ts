import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultStyle, makeShot, type Asset, type Project } from '../src/domain/types';
import { applyAssetExtraction, extractLocalAssets, mergeDraftAssets, normalizeScript, parseScriptText, templateScript } from '../src/features/script/creation';
import { assetUsage, generatedImageBlob, removeAsset, validateImage } from '../src/features/assets/helpers';
import { fillStoryboard, updateReference } from '../src/features/storyboard/helpers';
import { validateProject } from '../src/domain/validation';
import { assetText, imagePrompt, scriptPrompt, videoPrompt } from '../src/lib/prompts';
import { buildDocuments, buildSrt } from '../src/lib/documents';
import { skills } from '../src/lib/skills';

function project(): Project {
  return { id: 'project', name: '测试作品', theme: '山门外的无名剑', style: defaultStyle, revision: 0, createdAt: '', updatedAt: '', source: 'empty', skills: ['script', 'storyboard', 'image', 'video'], assets: [], shots: [], storyboardReady: false };
}
function picture(id = 'hero'): Asset { return { id, kind: 'character', name: id, description: '普通描述', lock: '银白长发，靛青衣襟 + 三道金线；不得改写。', imageId: `image-${id}` }; }
function generated() {
  return { title: '新作品', characters: [{ name: '阿青', description: '青衣，银发' }], shots: Array.from({ length: 10 }, () => ({ visual: '阿青向前走', camera: '跟拍', start: '门外', action: '走入山门', end: '门内', duration: 9, dialogues: [{ speaker: '阿青', text: '我回来了。' }, { speaker: '长老', text: '进来吧。' }] })) };
}

test('模板仅由调用建立10x9秒草稿，明确非AI，人物映射有效', () => {
  const p = project(); assert.equal(p.shots.length, 0);
  const draft = templateScript(p.theme);
  p.assets = draft.assets; p.shots = draft.shots; p.source = 'template';
  assert.equal(draft.shots.length, 10);
  assert.equal(draft.shots.reduce((sum, s) => sum + s.duration, 0), 90);
  assert.ok(draft.shots.every(s => s.visual.includes(p.theme) && s.visual.includes('非AI')));
  assert.deepEqual(validateProject(p), []);
  assert.throws(() => templateScript(' '), /主题/);
});

test('AI规范化为每次生成分配新ID，补充返回结构里未声明的说话人物', () => {
  const first = normalizeScript(generated()); const second = normalizeScript(generated());
  assert.equal(first.assets.length, 2);
  assert.notEqual(first.assets[0].id, second.assets[0].id);
  assert.notEqual(first.shots[0].id, second.shots[0].id);
  assert.equal(first.assets[0].lock, '青衣，银发');
  for (const shot of first.shots) for (const d of shot.dialogues) {
    assert.ok(first.assets.some(a => a.id === d.speakerId)); assert.ok(shot.assetIds.includes(d.speakerId));
  }
  assert.deepEqual(validateProject({ ...project(), assets: first.assets, shots: first.shots }), []);
});

test('AI无效结构和错误时长不会被静默裁剪或强制修正', () => {
  assert.throws(() => normalizeScript({ shots: [] }), /没有有效镜头/);
  const bad = generated(); bad.shots[0].duration = 16;
  assert.throws(() => normalizeScript(bad), /4–15/);
  assert.throws(() => normalizeScript({ ...generated(), shots: generated().shots.slice(1) }), /10镜/);
  const short = generated(); short.shots[0].duration = 8;
  assert.throws(() => normalizeScript(short), /90秒/);
  const emptyVisual = generated(); emptyVisual.shots[0].visual = '';
  assert.throws(() => normalizeScript(emptyVisual), /缺少画面/);
});

test('导入按镜号解析，并保留前言、未知字段和所有非空原文行', () => {
  const source = '作品说明：不要丢弃这行\n# 第1镜（8秒）\n画面：雨中庭院\n开场：庭院门口\n动作：向前走\n终点：树下\n运镜：缓慢推进\n台词：阿青：我来了。\n未知字段：保留我\n\n## 镜头 2\n时长：12秒\n对白：\n- 长老：进来。\n额外的自由文字';
  const draft = parseScriptText(source);
  assert.equal(draft.shots.length, 2);
  assert.equal(draft.shots[0].duration, 8); assert.equal(draft.shots[1].duration, 12);
  assert.equal(draft.shots[0].start, '庭院门口'); assert.equal(draft.shots[0].end, '树下');
  assert.equal(draft.shots[0].camera, '缓慢推进');
  assert.ok(draft.shots[0].dialogues.some(d => d.text === '我来了。'));
  assert.ok(!draft.assets.some(a => a.name === '未知字段'));
  const preserved = draft.shots.map(s => s.visual).join('\n');
  for (const line of source.split('\n').filter(s => s.trim())) assert.ok(preserved.includes(line), line);
  assert.ok(draft.shots[1].dialogues.some(d => draft.assets.find(a => a.id === d.speakerId)?.name === '长老'));
});

test('无镜号导入按段落解析，不丢失未识别正文，不强制10镜', () => {
  const draft = parseScriptText('第一段。\n还有一句。\n\n第二段，没有结构。');
  assert.equal(draft.shots.length, 2);
  assert.equal(draft.shots[0].visual, '第一段。\n还有一句。');
  assert.equal(draft.shots[1].visual, '第二段，没有结构。');
  assert.equal(draft.shots[0].duration, 9);
  assert.throws(() => parseScriptText(' \n'), /输入/);
});

test('导出文档重新导入保留逐镜时长，不把前言总时长识别为第一镜时长', () => {
  const p = project(); Object.assign(p, templateScript(p.theme));
  p.shots[0].duration = 8; p.shots[1].duration = 10;
  const draft = parseScriptText(buildDocuments(p)['剧本文档.md']);
  assert.equal(draft.shots.length, 10);
  assert.deepEqual(draft.shots.map(s => s.duration), p.shots.map(s => s.duration));
  assert.equal(draft.shots[0].dialogues[0].text, p.shots[0].dialogues[0].text);
});

test('删除资产解除四类关联，同时保留台词原文', () => {
  const p = project(); const asset = picture();
  p.assets = [asset, { id: 'voice', kind: 'voice', name: '声音', description: '', lock: '' }, { ...picture('other'), voiceAssetId: 'voice' }];
  p.shots = [{ ...makeShot(1), assetIds: ['hero'], references: [{ assetId: 'hero', role: 'reference_image' }], dialogues: [{ id: 'line', speakerId: 'hero', text: '保留台词。' }] }];
  assert.deepEqual(assetUsage(p, 'hero'), ['第1镜']);
  const next = removeAsset(p, 'hero');
  assert.deepEqual(next.shots[0].assetIds, []); assert.deepEqual(next.shots[0].references, []);
  assert.equal(next.shots[0].dialogues[0].speakerId, ''); assert.equal(next.shots[0].dialogues[0].text, '保留台词。');
  assert.equal(removeAsset(next, 'voice').assets[0].voiceAssetId, undefined);
  assert.equal(p.assets.length, 3, '不得原地修改输入');
});

test('上传与生成图片校验MIME、签名和5MB上限', async () => {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0]);
  await validateImage(new Blob([signature], { type: 'image/png' }));
  await assert.rejects(validateImage(new Blob([signature], { type: 'image/jpeg' })), /不匹配/);
  await assert.rejects(validateImage(new Blob(['<svg/>'], { type: 'image/svg+xml' })), /仅支持/);
  await assert.rejects(validateImage(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' })), /5MB/);
  const blob = await generatedImageBlob({ base64: Buffer.from(signature).toString('base64'), mime: 'image/png' });
  assert.equal(blob.type, 'image/png');
  await assert.rejects(generatedImageBlob({ base64: '***', mime: 'image/png' }), /编码/);
});

test('分镜补空使用上一终点，不改写已有字段与镜头ID', () => {
  const first = { ...makeShot(1), visual: '门外', start: '我写的开场', action: '抬手', end: '手停在门环上' };
  const second = { ...makeShot(2), visual: '门开了' };
  const filled = fillStoryboard([first, second]);
  assert.deepEqual(filled[0], first);
  assert.equal(filled[1].start, first.end); assert.ok(filled[1].action.includes(first.end));
  assert.equal(filled[1].id, second.id); assert.equal(second.start, '');
  assert.ok(filled[1].end); assert.deepEqual(fillStoryboard(filled), filled);
});

test('只有真实图片可挂载，参考图与首尾帧互斥，图序可保留', () => {
  const p = project(); p.assets = [picture('a'), picture('b'), { ...picture('c'), imageId: undefined }];
  let shot = makeShot(1);
  assert.throws(() => updateReference(p, shot, 'c', 'reference_image'), /真实图片/);
  shot = updateReference(p, shot, 'a', 'reference_image');
  assert.deepEqual(shot.assetIds, ['a']);
  assert.throws(() => updateReference(p, shot, 'b', 'first_frame'), /不能混用/);
  shot = updateReference(p, shot, 'a', 'first_frame');
  assert.throws(() => updateReference(p, shot, 'b', 'first_frame'), /最多一张/);
  shot = updateReference(p, shot, 'b', 'last_frame');
  assert.deepEqual(shot.references.map(r => r.assetId), ['a', 'b']);
  assert.equal(updateReference(p, shot, 'a').references.length, 1);
});

test('视频有图强调动态，无图建立开场，固定短语原样跨图片视频复用', () => {
  const p = project(); const asset = picture(); p.assets = [asset];
  const shot = { ...makeShot(1), start: '月下门前', visual: '银发人物', action: '抬手推门', assetIds: ['hero'], dialogues: [{ id: 'd', speakerId: 'hero', text: '开门。' }] };
  const plain = videoPrompt(p, shot);
  assert.ok(plain.includes('没有挂载参考图')); assert.ok(plain.includes('开场：月下门前'));
  const pictured = videoPrompt(p, { ...shot, references: [{ assetId: 'hero', role: 'reference_image' }] });
  assert.ok(pictured.includes('图1：参考图')); assert.ok(pictured.includes('重点执行动作'));
  assert.ok(!pictured.includes('开场：月下门前'));
  for (const prompt of [assetText(p, shot), imagePrompt(p, asset), plain, pictured]) assert.ok(prompt.includes(asset.lock));
  assert.ok(videoPrompt({ ...p, assets: [{ ...asset, imageId: undefined }] }, { ...shot, references: [{ assetId: 'hero', role: 'reference_image' }] }).includes('没有挂载参考图'));
  assert.ok(videoPrompt(p, { ...shot, audioMode: 'dubbing' }).includes('不生成可辨识人声'));
});

test('角色设定只生成同卡正侧背三视图，纯色背景且固定身份服装发型', () => {
  const p = project(); const asset = picture(); const prompt = imagePrompt(p, asset);
  for (const text of ['只输出一张角色三视图', '正面、侧面、背面', '恰好三视图', '统一纯色', '无场景', '发型', '严格一致', asset.lock]) assert.ok(prompt.includes(text), text);
  assert.ok(!imagePrompt(p, { ...asset, kind: 'scene' }).includes('三视图'));
  assert.ok(!imagePrompt(p, { ...asset, kind: 'prop' }).includes('三视图'));
});

test('AI三类资产独立存入固定短语，显式镜头关联不依赖画面名称', () => {
  const input = { ...generated(), scenes: [{ name: '山门', description: '黑石阶；低雾，不改写。' }], props: [{ name: '断剑', description: '红绳剑柄，斜断口。' }], shots: generated().shots.map(s => ({ ...s, visual: '他举起它', start: '台阶上', action: '举剑', end: '站定', scenes: ['山门'], props: ['断剑'] })) };
  const draft = normalizeScript(input); const p = { ...project(), ...draft };
  for (const s of p.shots) for (const kind of ['character', 'scene', 'prop']) assert.ok(p.assets.some(a => a.kind === kind && s.assetIds.includes(a.id)));
  const scene = p.assets.find(a => a.kind === 'scene')!;
  for (const prompt of [assetText(p, p.shots[0]), videoPrompt(p, p.shots[0]), imagePrompt(p, scene)]) assert.ok(prompt.includes(scene.lock));
  assert.throws(() => normalizeScript({ ...input, shots: input.shots.map(s => ({ ...s, props: ['不存在'] })) }), /未声明/);
  const absent = normalizeScript({ ...input, shots: input.shots.map(s => ({ ...s, visual: '旁白提及断剑', props: [] })) });
  assert.ok(!absent.shots[0].assetIds.includes(absent.assets.find(a => a.kind === 'prop')!.id));
});

test('每镜始终输出三类提示词并明确缺失，不拿另一类冒充', () => {
  const p = project(); p.assets = [picture()]; p.shots = [{ ...makeShot(1), assetIds: ['hero'] }];
  const prompt = videoPrompt(p, p.shots[0]);
  for (const name of ['人物提示词', '场景提示词', '道具提示词', '缺失：未关联场景', '缺失：未关联道具']) assert.ok(prompt.includes(name));
});

test('导入清单与逐镜场景道具字段提取，不把前言全部挂在第一镜', () => {
  const draft = parseScriptText('人物设定\n阿青：黑短发青衣\n场景清单\n山门：黑石阶，薄雾\n庭院：白墙绿竹\n道具：断剑：红绳剑柄\n第1镜（9秒）\n场景：山门\n画面：阿青站定\n台词：阿青：回来了\n第2镜（9秒）\n画面：庭院里放着断剑');
  assert.equal(draft.assets.length, 4);
  const [first, second] = draft.shots;
  const names = (ids: string[]) => draft.assets.filter(a => ids.includes(a.id)).map(a => a.name);
  assert.deepEqual(names(first.assetIds), ['阿青', '山门']);
  assert.deepEqual(names(second.assetIds), ['庭院', '断剑']);
  assert.equal(draft.assets[0].lock, '黑短发青衣');
  assert.deepEqual(extractLocalAssets(draft.shots, draft.assets), draft, '重复提取不得重复建资产或改变ID');
});

test('同名场景道具合并保留已有ID、图片和固定短语并重映射关联', () => {
  const scene: Asset = { id: 'old-scene', kind: 'scene', name: '山门', description: '原始描述', lock: '用户固定短语', imageId: 'original-picture' };
  const next: Asset = { ...scene, id: 'new-scene', lock: '模型改写', imageId: undefined };
  const merged = mergeDraftAssets([scene], { assets: [next], shots: [{ ...makeShot(1), assetIds: [next.id] }] });
  assert.deepEqual(merged.assets, [scene]); assert.deepEqual(merged.shots[0].assetIds, [scene.id]);
});

test('AI提取只补资产及关联，保留剧本媒体且校验精确镜号', () => {
  const p = project(); p.shots = [makeShot(1), makeShot(2)];
  p.shots[0].video = { name: 'keep.mp4', origin: 'upload', duration: 9 };
  const result = { characters: [], scenes: [{ name: '山门', description: '黑石阶' }], props: [{ name: '断剑', description: '红绳剑柄' }], shots: [{ number: 2, characters: [], scenes: ['山门'], props: [] }, { number: 1, characters: [], scenes: ['山门'], props: ['断剑'] }] };
  const draft = applyAssetExtraction(p, result);
  assert.equal(p.assets.length, 0); assert.equal(p.shots[0].assetIds.length, 0);
  draft.shots.forEach((s, i) => assert.deepEqual({ ...s, assetIds: [] }, p.shots[i]));
  assert.equal(draft.shots[0].assetIds.length, 2); assert.equal(draft.shots[1].assetIds.length, 1);
  assert.throws(() => applyAssetExtraction(p, { ...result, shots: [result.shots[0]] }), /不完整/);
  assert.throws(() => applyAssetExtraction(p, { ...result, shots: [result.shots[0], result.shots[0]] }), /镜号/);
  assert.throws(() => applyAssetExtraction(p, { ...result, props: undefined }), /不完整/);
});

test('四个Skill结构完整，选中的模板进入剧本提示词，未选择的不加入', () => {
  const p = project(); assert.deepEqual(skills.map(s => s.id), ['script', 'storyboard', 'image', 'video']);
  const prompt = scriptPrompt(p); skills.forEach(s => assert.ok(prompt.includes(s.template)));
  assert.ok(prompt.includes(p.theme)); assert.ok(prompt.includes('总计90秒'));
  const empty = scriptPrompt({ ...p, skills: [] }); skills.forEach(s => assert.ok(!empty.includes(s.template)));
});

test('校验镜数、时长、失效人物、参考图和音频模式，但不要求已制作视频', () => {
  const p = project(); const draft = templateScript(p.theme); Object.assign(p, draft);
  assert.deepEqual(validateProject(p), []);
  p.shots[0].audio = { mediaId: 'audio', name: '暂未启用的配音', duration: 9 };
  assert.deepEqual(validateProject(p), [], '允许保留未激活配音轨，实际声音由单一audioMode决定');
  p.shots[0].duration = 16;
  p.shots[0].dialogues[0].speakerId = 'missing';
  p.shots[0].assetIds.push('missing');
  p.shots[0].references = [{ assetId: 'missing', role: 'reference_image' }];
  p.shots[0].audioMode = 'original+dubbing' as typeof p.shots[0]['audioMode'];
  const errors = validateProject(p).join('\n');
  for (const keyword of ['90秒', '4–15', '人物', '资产ID', '真实图片', '音频模式']) assert.ok(errors.includes(keyword), keyword);
  assert.ok(!errors.includes('视频'));
});

test('校验首尾帧数量、尾帧依赖和图像模式互斥', () => {
  const p = project(); p.assets = [picture('a'), picture('b')]; p.shots = [makeShot(1)];
  p.shots[0].references = [{ assetId: 'a', role: 'last_frame' }];
  assert.ok(validateProject(p).some(e => e.includes('必须同时提供首帧')));
  p.shots[0].references.push({ assetId: 'b', role: 'reference_image' });
  assert.ok(validateProject(p).some(e => e.includes('模式互斥')));
});

test('导出恰好五个中文Markdown文件，模板来源可见，字幕累计镜头时长', () => {
  const p = project(); Object.assign(p, templateScript(p.theme)); p.source = 'template';
  const docs = buildDocuments(p);
  assert.equal(Object.keys(docs).length, 5);
  for (const [name, content] of Object.entries(docs)) { assert.match(name, /^[\u4e00-\u9fa5]+\.md$/); assert.ok(content.includes('非AI生成')); }
  p.shots = [makeShot(1), { ...makeShot(2), dialogues: [{ id: 'a', speakerId: '', text: '第一句' }, { id: 'b', speakerId: '', text: '第二句' }] }];
  assert.equal(buildSrt(p), '1\n00:00:09,000 --> 00:00:13,500\n第一句\n\n2\n00:00:13,500 --> 00:00:18,000\n第二句\n');
});

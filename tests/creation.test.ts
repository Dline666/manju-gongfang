import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultStyle, makeShot, type Asset, type Project } from '../src/domain/types';
import { applyAssetExtraction, applyCategoryExtraction, extractLocalAssets, mergeDraftAssets, normalizeScreenplay, normalizeScript, parseScriptText, templateScript } from '../src/features/script/creation';
import { assetUsage, generatedImageBlob, removeAsset, validateImage } from '../src/features/assets/helpers';
import { fillStoryboard, updateReference } from '../src/features/storyboard/helpers';
import { validateProject } from '../src/domain/validation';
import { assetText, directorPrompt, imagePrompt, scriptPrompt, videoPrompt } from '../src/lib/prompts';
import { buildDocuments, buildSrt } from '../src/lib/documents';
import { skills } from '../src/lib/skills';

function project(): Project {
  return { id: 'project', name: '测试作品', theme: '山门外的无名剑', style: defaultStyle, revision: 0, createdAt: '', updatedAt: '', source: 'empty', skills: ['script', 'storyboard', 'image', 'video'], assets: [], shots: [], storyboardReady: false };
}
function picture(id = 'hero'): Asset { return { id, kind: 'character', name: id, description: '普通描述', lock: '银白长发，靛青衣襟 + 三道金线；不得改写。', imageId: `image-${id}` }; }
function generated() {
  return { title: '新作品', characters: [{ name: '阿青', description: '青衣，银发' }], shots: Array.from({ length: 10 }, () => ({ visual: '阿青向前走', camera: '跟拍', start: '门外', action: '走入山门', end: '门内', duration: 9, dialogues: [{ speaker: '阿青', text: '我回来了。' }, { speaker: '长老', text: '进来吧。' }] })) };
}
function screenplayFixture() {
  return `# 第一部分｜核心前提

【核心前提】
少年拾起断剑。

【黄金3秒钩子】
类型：反常细节
开场画面：
△ 断剑在泥里露出一截。

【三幕结构】
- **第一幕｜铺垫建立（30%）**：捡剑。
- **第二幕｜核心冲突危机（50%）**：被拦。
- **第三幕｜转折爆发与卡点（20%）**：剑醒。

【结尾卡点】
剑里封着他的神格。

# 第二部分｜场景因果节拍表

| 场次 | 场景目标 | 遭遇阻碍 | 升级行动 | 意外转折 | 不可逆新局面 |
|---|---|---|---|---|---|
| 1 | 捡剑 | 被拦 | 拔剑 | 剑回应 | 结仇 |

# 第三部分｜世界观与人物关系确认

【世界边界】
- 时代：修仙。

【人物关系】
- 沈砚：杂役。

# 第四部分｜标准漫剧剧本

## 第一章  断剑归门

### 场景1 外景 · 山门石阶 — 清晨

**剧情：**沈砚拾剑。
**人物：**沈砚

【镜头：远景】
△ 沈砚蹲在石阶下，指尖抠开泥。（时长9s）

【镜头：特写】
△ 断剑露出一截，剑身满是泥。（时长9s）

【镜头：中景】
沈砚（低声）：“我回来了。”（时长9s）
`;
}
function generatedScreenplay() {
  return { title: '断剑归门', logline: '少年拾起断剑，却不知剑里封着自己的神格。', screenplay: screenplayFixture() };
}

test('模板演练写出一份完整剧本并拆出镜头，明确非AI，人物映射有效', () => {
  const p = project(); assert.equal(p.shots.length, 0);
  const draft = templateScript(p.theme);
  p.assets = draft.assets; p.shots = draft.shots; p.source = 'template';
  assert.equal(draft.shots.length, 14);
  assert.equal(draft.shots.reduce((sum, s) => sum + s.duration, 0), 28);
  assert.ok((draft.screenplay || '').includes('# 第一部分｜核心前提'));
  assert.ok((draft.screenplay || '').includes('# 第四部分｜标准漫剧剧本'));
  assert.ok((draft.screenplay || '').includes(p.theme));
  assert.ok(draft.shots.every(s => s.cameraHint));
  assert.deepEqual(validateProject(p), []);
  assert.throws(() => templateScript(' '), /主题/);
});

test('剧本规范化为每次生成分配新ID，台词只记说话人名字不建人物资产', () => {
  const first = normalizeScreenplay(generatedScreenplay()); const second = normalizeScreenplay(generatedScreenplay());
  assert.equal(first.assets.length, 0, '剧本步骤不产出任何资产，人物等提取或手动创建');
  assert.notEqual(first.shots[0].id, second.shots[0].id);
  for (const shot of first.shots) for (const d of shot.dialogues) {
    assert.equal(d.speakerId, '', '说话人尚未关联人物资产');
    assert.ok((d.speaker || '').trim(), '说话人名字必须留在台词里');
  }
  assert.deepEqual(validateProject({ ...project(), assets: first.assets, shots: first.shots }), []);
});

test('剧本无效结构不会被静默裁剪或强制修正', () => {
  assert.throws(() => normalizeScreenplay({ screenplay: '' }), /没有剧本正文/);
  assert.throws(() => normalizeScreenplay({ screenplay: '只是散文，没有任何可拆镜的动作或台词段落。' }), /没有找到可拆镜的内容/);
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
  assert.ok(draft.shots[1].dialogues.some(d => d.speaker === '长老'), '说话人只记名字，不建人物资产');
});

test('无镜号导入按段落解析，不丢失未识别正文，不强制10镜', () => {
  const draft = parseScriptText('第一段。\n还有一句。\n\n第二段，没有结构。');
  assert.equal(draft.shots.length, 2);
  assert.equal(draft.shots[0].visual, '第一段。\n还有一句。');
  assert.equal(draft.shots[1].visual, '第二段，没有结构。');
  assert.equal(draft.shots[0].duration, 9);
  assert.throws(() => parseScriptText(' \n'), /输入/);
});

test('导出剧本文档重新导入保留逐镜时长，不把前言总时长识别为第一镜时长', () => {
  const p = project(); Object.assign(p, templateScript(p.theme));
  const document = buildDocuments(p)['剧本文档.md'];
  assert.ok(document.includes('# 第四部分｜标准漫剧剧本'), '剧本文档必须导出真实剧本');
  const draft = parseScriptText(document);
  assert.equal(draft.shots.length, 14);
  assert.deepEqual(draft.shots.map(s => s.duration), p.shots.map(s => s.duration));
  assert.equal(draft.shots[1].dialogues[0].text, p.shots[1].dialogues[0].text);
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

test('视频提示词只带作品数据：附件顺序、固定资产与音频模式', () => {
  const p = project(); const asset = picture(); p.assets = [asset];
  const shot = { ...makeShot(1), start: '月下门前', visual: '银发人物', action: '抬手推门', assetIds: ['hero'], dialogues: [{ id: 'd', speakerId: 'hero', text: '开门。' }] };
  const plain = videoPrompt(p, shot);
  assert.ok(plain.includes('本镜没有挂载附件。'), '没挂图要说清楚没有附件');
  assert.ok(plain.includes('动作：抬手推门'));
  assert.ok(plain.includes('银白长发'), '固定资产短语逐字复用');
  const pictured = videoPrompt(p, { ...shot, references: [{ assetId: 'hero', role: 'reference_image' }] });
  assert.ok(pictured.includes('图1：参考图 · hero'));
  assert.ok(!pictured.includes('本镜没有挂载附件。'));
  for (const prompt of [assetText(p, shot), imagePrompt(p, asset), plain, pictured]) assert.ok(prompt.includes(asset.lock));
  assert.ok(videoPrompt({ ...p, assets: [{ ...asset, imageId: undefined }] }, { ...shot, references: [{ assetId: 'hero', role: 'reference_image' }] }).includes('本镜没有挂载附件。'));
  assert.ok(videoPrompt(p, { ...shot, audioMode: 'dubbing' }).includes('音频模式：后期配音'));
});

test('图片提示词不含默认规则；用户插入内置块后按用户内容发送', () => {
  const p = project(); const asset = picture();
  const bare = imagePrompt(p, asset);
  assert.ok(!bare.includes('三视图'), '系统不再预置三视图条款');
  assert.ok(bare.includes(asset.lock), '固定短语必须逐字出现');
  assert.ok(bare.includes('资产：hero'));
  const planned = { ...p, promptConfig: { v: 2 as const, templates: { image: { blocks: [{ id: 'image.three-view', title: '人物三视图条款', text: '只输出一张角色三视图设定卡。', builtin: 'image.three-view' }] } } } };
  const withRule = imagePrompt(planned, asset);
  assert.ok(withRule.includes('只输出一张角色三视图设定卡。'));
  assert.ok(!withRule.includes('正面、侧面、背面'), '只发用户写的内容');
});

test('每镜都列出三类固定资产，缺失的类明确写「未关联」', () => {
  const p = project(); p.assets = [picture()]; p.shots = [{ ...makeShot(1), assetIds: ['hero'] }];
  const prompt = videoPrompt(p, p.shots[0]);
  for (const name of ['人物「hero」', '场景：未关联', '道具：未关联']) assert.ok(prompt.includes(name), name);
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

test('提取只补本类资产及关联，保留剧本媒体', () => {
  const p = project(); p.shots = [makeShot(1), makeShot(2)];
  p.shots[0].video = { name: 'keep.mp4', origin: 'upload', duration: 9 };
  const result = { scenes: [{ name: '山门', description: '黑石阶' }], shots: [{ number: 2, scenes: ['山门'] }, { number: 1, scenes: ['山门'] }] };
  const draft = applyCategoryExtraction(p, result, 'scene');
  assert.equal(p.assets.length, 0); assert.equal(p.shots[0].assetIds.length, 0);
  assert.equal(draft.shots[0].assetIds.length, 1); assert.equal(draft.shots[1].assetIds.length, 1);
  assert.equal(draft.shots[0].video?.name, 'keep.mp4', '剧本媒体必须保留');
});

test('Skill 按阶段绑定：剧本提示词只注入剧本 Skill，其余 Skill 归各自阶段', () => {
  const p = project(); assert.deepEqual(skills.map(s => s.id), ['script', 'storyboard', 'image', 'video']);
  const prompt = scriptPrompt(p);
  assert.ok(prompt.includes(skills[0].template), '剧本 Skill 必须进入剧本提示词');
  for (const skill of skills.slice(1)) assert.ok(!prompt.includes(skill.template), `${skill.name} 不得进入剧本提示词`);
  assert.ok(prompt.includes(p.theme));
  const empty = scriptPrompt({ ...p, skills: [] }); skills.forEach(s => assert.ok(!empty.includes(s.template)));
  assert.ok(directorPrompt(p).includes(skills[1].template), '分镜 Skill 必须在导演提示词里');
});

test('剧本步骤不产出任何资产，台词只记说话人名字', () => {
  const draft = normalizeScreenplay(generatedScreenplay());
  assert.equal(draft.logline, '少年拾起断剑，却不知剑里封着自己的神格。');
  assert.equal(draft.assets.length, 0, '人物资产等用户点提取或手动创建后才出现');
  assert.equal(draft.shots.length, 3);
  assert.equal(draft.shots[0].scene, '外景 · 山门石阶 — 清晨');
  assert.equal(draft.shots[0].cameraHint, '远景');
  assert.equal(draft.shots[0].duration, 9);
  assert.equal(draft.shots[0].visual, '【外景 · 山门石阶 — 清晨】沈砚蹲在石阶下，指尖抠开泥。');
  assert.deepEqual(draft.shots[2].assetIds, [], '说话人不进资产关联');
  assert.equal(draft.shots[2].dialogues[0].speaker, '沈砚');
  assert.equal(draft.shots[2].dialogues[0].speakerId, '');
  assert.ok(draft.shots.every(shot => shot.camera === '' && shot.start === '' && shot.action === '' && shot.end === ''));
  assert.ok((draft.screenplay || '').includes('# 第四部分｜标准漫剧剧本'), '剧本正文必须留在作品里');
});

test('资产提取分品类：新建人物资产、台词按名字挂上、未声明引用跳过并提示', () => {
  const draft = normalizeScreenplay(generatedScreenplay());
  const p = { ...project(), assets: draft.assets, shots: draft.shots };
  const shots = Array.from({ length: 3 }, (_, i) => ({ number: i + 1 }));
  const extracted = applyCategoryExtraction(p, { characters: [{ name: '沈砚', description: '十七岁少年，灰白旧布衣，背空剑鞘' }], shots: shots.map(shot => ({ ...shot, characters: ['沈砚'] })) }, 'character');
  const hero = extracted.assets.find(asset => asset.name === '沈砚')!;
  assert.equal(hero.lock, '十七岁少年，灰白旧布衣，背空剑鞘');
  assert.equal(extracted.assets.filter(asset => asset.kind === 'character').length, 1, '提取时才新建人物资产');
  assert.equal(extracted.shots[2].dialogues[0].speakerId, hero.id, '台词按名字挂到新人物资产上');
  const loose = applyCategoryExtraction(p, { characters: [{ name: '沈砚', description: 'x' }], shots: shots.map((shot, i) => i === 0 ? { ...shot, characters: ['不存在'] } : shot) }, 'character');
  assert.ok(!loose.shots[0].assetIds.includes('不存在'), '未声明的名字不得写进关联');
  assert.ok(loose.warnings?.some(note => note.includes('未声明人物')), loose.warnings?.join('；'));
});

test('提取到的人物与剧本说话人对不上时不乱挂、不丢台词，也不再列说话人清单', () => {
  const draft = normalizeScreenplay(generatedScreenplay());
  const p = { ...project(), assets: draft.assets, shots: draft.shots };
  const extracted = applyCategoryExtraction(p, { characters: [{ name: '沈砚', description: '灰白旧布衣' }], shots: [] }, 'character');
  assert.ok(extracted.shots[2].dialogues[0].speakerId, '同名说话人照样挂上');
  const renamed = applyCategoryExtraction(p, { characters: [{ name: '沈砚之', description: '灰白旧布衣' }], shots: [] }, 'character');
  assert.equal(renamed.shots[2].dialogues[0].speakerId, '', '名字对不上时不乱挂');
  assert.ok(renamed.shots[2].dialogues[0].text, '台词不能被静默丢掉');
  assert.ok(!renamed.warnings?.some(note => note.includes('说话人')), '说话人是按冒号切出来的，不再列清单');
});

test('资产提取分品类：三类互不影响，各自只写自己的清单与逐镜关联', () => {
  const draft = normalizeScreenplay(generatedScreenplay());
  const p = { ...project(), assets: draft.assets, shots: draft.shots };
  const shots = Array.from({ length: 3 }, (_, i) => ({ number: i + 1 }));
  const withScenes = applyCategoryExtraction(p, { scenes: [{ name: '山门', description: '青灰石阶九十九级，晨雾低垂' }], shots: shots.map(shot => ({ ...shot, scenes: ['山门'] })) }, 'scene');
  const scene = withScenes.assets.find(asset => asset.name === '山门')!;
  assert.equal(scene.kind, 'scene');
  const withProps = applyCategoryExtraction(withScenes, { props: [{ name: '断剑', description: '红绳缠柄，断口有金色灵光' }], shots: shots.map((shot, i) => ({ ...shot, props: i === 0 ? ['断剑'] : [] })) }, 'prop');
  const sword = withProps.assets.find(asset => asset.name === '断剑')!;
  assert.equal(sword.description, '红绳缠柄，断口有金色灵光');
  assert.ok(withProps.shots[0].assetIds.includes(sword.id));
  assert.ok(withProps.shots[0].assetIds.includes(scene.id), '提取道具不会丢掉已写入的场景关联');
  assert.equal(withProps.assets.filter(asset => asset.kind === 'character').length, p.assets.filter(asset => asset.kind === 'character').length);
});

test('资产提取不覆盖已确认的固定短语', () => {
  const draft = normalizeScreenplay(generatedScreenplay());
  const locked = { id: 'hero', kind: 'character' as const, name: '沈砚', description: '已确认外观', lock: '已确认外观' };
  const p = { ...project(), assets: [locked], shots: draft.shots };
  const shots = Array.from({ length: 3 }, (_, i) => ({ number: i + 1 }));
  const extracted = applyCategoryExtraction(p, { characters: [{ name: '沈砚', description: '模型新写的另一套外观' }], shots: shots.map(shot => ({ ...shot, characters: ['沈砚'] })) }, 'character');
  assert.equal(extracted.assets[0].lock, '已确认外观', '已有固定短语必须逐字沿用');
});

test('剧本提示词只有作品数据：不含风格块、资产提取规则与默认结构条款', () => {
  const p = project(); const prompt = scriptPrompt(p);
  assert.ok(!prompt.includes('【风格块】'), '风格块只进图片与视频提示词');
  assert.ok(!prompt.includes('先从完整剧本提取人物'), '资产提取规则只进资产模板');
  assert.ok(!prompt.includes('P1 本镜动作与终点'), '优先级不得引用导演阶段字段');
  for (const absent of ['【剧本结构】', '【剧本正文规范】', '【可拍摄性铁律】', '【时长可行性】']) assert.ok(!prompt.includes(absent), absent);
});

test('没有【镜头：类型】时按段落降级拆镜并给出提示', () => {
  const loose = `### 场景1 外景 · 山门石阶 — 清晨

△ 沈砚蹲在石阶下，指尖抠开泥。

沈砚：“断剑还在。”

△ 他把断剑捧起来，泥水顺着剑脊滑落。
`;
  const draft = normalizeScreenplay({ title: '降级', screenplay: loose });
  assert.equal(draft.shots.length, 3, '每个自然段各成一镜');
  assert.equal(draft.shots[0].scene, '外景 · 山门石阶 — 清晨');
  assert.equal(draft.shots[1].dialogues[0].text, '断剑还在。', '台词段落也要成镜');
  assert.ok(draft.notes?.some(note => note.includes('降级拆镜')), draft.notes?.join('；'));
  assert.equal(draft.shots[0].cameraHint, '', '降级拆镜没有画面类型标记');
  assert.ok(draft.shots[0].duration > 0, '降级拆镜仍要估出时长');
});

test('一个场景头都没有时整篇当一个场景拆镜', () => {
  const draft = normalizeScreenplay({ screenplay: '△ 沈砚推开门。\n\n△ 屋里空无一人。' });
  assert.equal(draft.shots.length, 2);
  assert.equal(draft.shots[0].scene, '');
  assert.ok(draft.notes?.length);
});

test('既没有【镜头：类型】也没有动作台词时明确报错', () => {
  assert.throws(() => normalizeScreenplay({ screenplay: '这是一段散文说明，没有任何动作行或台词行。' }), /没有找到可拆镜的内容/);
});

test('校验镜数、时长、失效人物、参考图和音频模式，但不要求已制作视频', () => {
  const p = project(); const draft = templateScript(p.theme); Object.assign(p, draft);
  assert.deepEqual(validateProject(p), []);
  p.shots[0].audio = { mediaId: 'audio', name: '暂未启用的配音', duration: 9 };
  assert.deepEqual(validateProject(p), [], '允许保留未激活配音轨，实际声音由单一audioMode决定');
  p.shots = p.shots.map(shot => ({ ...shot, duration: 40 }));
  p.shots[1].dialogues[0].speakerId = 'missing';
  p.shots[0].assetIds.push('missing');
  p.shots[0].references = [{ assetId: 'missing', role: 'reference_image' }];
  p.shots[0].audioMode = 'original+dubbing' as typeof p.shots[0]['audioMode'];
  const errors = validateProject(p).join('\n');
  for (const keyword of ['20–400秒', '不超过30秒', '资产ID', '真实图片', '音频模式']) assert.ok(errors.includes(keyword), keyword);
  assert.ok(!errors.includes('人物'), '说话人是按冒号切出来的，失效的人物引用不再阻断');
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

test('剧本 Skill 写完整剧本，固定节拍数已取消', () => {
  const scriptSkill = skills.find(skill => skill.id === 'script')!;
  assert.ok(!scriptSkill.template.includes('恰好10'), '剧本 Skill 不得再规定固定节拍数');
  assert.ok(scriptSkill.template.includes('【镜头：类型】'), '剧本 Skill 必须要求标注画面类型');
  const directorSkill = skills.find(skill => skill.id === 'storyboard')!;
  assert.ok(directorSkill.template.includes('景别'));
});

test('剧本解析器按【镜头：】逐块拆镜，场景头、台词与时长都要落位', () => {
  const draft = normalizeScreenplay(generatedScreenplay());
  assert.equal(draft.shots.length, 3);
  assert.equal(draft.shots[0].scene, '外景 · 山门石阶 — 清晨');
  assert.equal(draft.shots[1].cameraHint, '特写');
  assert.equal(draft.shots[2].dialogues[0].text, '我回来了。');
  assert.equal(draft.shots[2].dialogues[0].speaker, '沈砚');
  assert.equal(draft.shots[2].dialogues[0].speakerId, '', '剧本阶段不关联人物资产');
  assert.equal(draft.shots[2].duration, 9);
  assert.equal(draft.shots.reduce((sum, shot) => sum + shot.duration, 0), 27);
});

test('剧本缺少【镜头：】标记时拒绝覆盖现有剧本', () => {
  assert.throws(() => normalizeScreenplay({ title: 'x', screenplay: '# 第一部分｜核心前提\n没有任何镜头标记的正文。' }), /镜头/);
  assert.throws(() => normalizeScreenplay({ title: 'x' }), /剧本正文/);
});

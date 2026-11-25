import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultStyle, makeShot, type Asset, type Project } from '../src/domain/types';
import { applyAssetExtraction, applyCategoryExtraction, extractLocalAssets, mergeDraftAssets, normalizeDirector, normalizeScreenplay, normalizeScript, parseScriptText, rehearseShots, templateScript } from '../src/features/script/creation';
import { assetUsage, generatedImageBlob, removeAsset, validateImage } from '../src/features/assets/helpers';
import { fillStoryboard, updateReference } from '../src/features/storyboard/helpers';
import { validateProject } from '../src/domain/validation';
import { validateDirectorStage } from '../src/domain/flow';
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

/** 导演步骤的产出：三镜，第三镜带一句台词。 */
function directorShots() {
  const p = { ...project(), screenplay: screenplayFixture() };
  return normalizeDirector({ shots: [
    { number: 1, scene: '外景 · 山门石阶 — 清晨', visual: '沈砚蹲在石阶下，指尖抠开泥。', duration: 9, shotSize: '远景', movement: '固定', angle: '平视', start: '石阶下', action: '抠开泥', end: '泥被抠开', dialogues: [] },
    { number: 2, scene: '外景 · 山门石阶 — 清晨', visual: '断剑露出一截，剑身满是泥。', duration: 9, shotSize: '特写', movement: '固定', angle: '平视', start: '泥里', action: '断剑露出', end: '剑身满是泥', dialogues: [] },
    { number: 3, scene: '外景 · 山门石阶 — 清晨', visual: '沈砚捧起断剑。', duration: 9, shotSize: '中景', movement: '推', angle: '平视', start: '断剑在手里', action: '抬头', end: '望向山门', dialogues: [{ speaker: '沈砚', text: '我回来了。' }] },
  ] }, p).shots;
}

test('模板演练写出一份完整剧本，不拆镜也不建资产', () => {
  const p = project(); assert.equal(p.shots.length, 0);
  const draft = templateScript(p.theme);
  assert.equal(draft.shots.length, 0, '剧本步骤不再拆镜');
  assert.equal(draft.assets.length, 0, '剧本步骤不建资产');
  assert.ok((draft.screenplay || '').includes('# 第一部分｜核心前提'));
  assert.ok((draft.screenplay || '').includes('# 第四部分｜标准漫剧剧本'));
  assert.ok((draft.screenplay || '').includes(p.theme));
  assert.throws(() => templateScript(' '), /主题/);
});

test('模板演练：按剧本结构排镜，不碰结构说明部分', () => {
  const shots = rehearseShots(screenplayFixture());
  assert.equal(shots.length, 3, '剧本里三处【镜头：】就是三镜');
  assert.deepEqual(shots.map(shot => shot.camera), ['远景·固定·平视', '特写·固定·平视', '中景·固定·平视']);
  assert.deepEqual(shots.map(shot => shot.scene), ['外景 · 山门石阶 — 清晨', '外景 · 山门石阶 — 清晨', '外景 · 山门石阶 — 清晨']);
  assert.equal(shots[0].duration, 9, '时长照抄剧本里的「（时长9s）」');
  assert.equal(shots[0].visual, '沈砚蹲在石阶下，指尖抠开泥。');
  assert.equal(shots[2].dialogues.length, 1);
  assert.equal(shots[2].dialogues[0].speaker, '沈砚');
  assert.equal(shots[2].dialogues[0].text, '我回来了。');
  assert.ok(!shots.some(shot => shot.visual.includes('断剑在泥里露出一截')), '开场钩子属于结构说明，不进镜头');
});

test('模板演练：没有场景头也没有镜头标记时按空行分段', () => {
  const shots = rehearseShots('雨落在屋檐上。\n风把灯吹灭了。\n\n老人推开门。\n\n他回来了。');
  assert.equal(shots.length, 3);
  assert.equal(shots[0].scene, '未标注场景');
  assert.equal(shots[0].visual, '雨落在屋檐上。\n风把灯吹灭了。');
  assert.equal(shots[0].duration, 3, '没有时长标记就按一段至少 3 秒估');
  assert.deepEqual(rehearseShots('   '), [], '空剧本排不出镜头');
});

test('模板演练：完整模板剧本排出的镜头能通过导演步骤校验', () => {
  const draft = templateScript('山门外的无名剑');
  const shots = rehearseShots(draft.screenplay || '');
  assert.equal(shots.length, 14);
  const total = shots.reduce((sum, shot) => sum + shot.duration, 0);
  assert.ok(total >= 20 && total <= 400, `总时长要在 20–400 秒之间，当前 ${total}`);
  const p = { ...project(), screenplay: draft.screenplay || '', shots };
  assert.deepEqual(validateDirectorStage(p), [], '演练排出的镜头直接就是可确认的正式分镜');
});

test('剧本规范化只产出剧本文本，不拆镜；模型没给资产就不建资产', () => {
  const first = normalizeScreenplay(generatedScreenplay()); const second = normalizeScreenplay(generatedScreenplay());
  assert.equal(first.assets.length, 0, '模型没返回资产清单时不建资产');
  assert.equal(first.shots.length, 0, '剧本步骤不拆镜，镜头由导演步骤产出');
  assert.equal(second.shots.length, 0);
  assert.equal(first.title, '断剑归门');
  assert.equal(first.logline, '少年拾起断剑，却不知剑里封着自己的神格。');
  assert.equal(first.screenplay, screenplayFixture().trim(), '剧本文本原样保留');
});

test('剧本顺带产出的三类资产落地成资产：id 稳定、代称拆开、坏条目跳过', () => {
  const draft = normalizeScreenplay({
    title: '断剑归门', screenplay: screenplayFixture(),
    assets: {
      characters: [
        { id: 'c1', name: '沈砚', aliases: '小砚，砚儿', description: '沉默寡言', lock: '十七岁少年，灰白旧布衣，背空剑鞘' },
        { id: 'c1', name: '重复 id 的人', lock: '重复 id 必须被换成新 id' },
        { name: '缺固定短语', lock: '' },
      ],
      scenes: [{ id: 's1', name: '山门', lock: '青灰石阶九十九级，晨雾低垂' }],
      props: [{ id: 'p1', name: '断剑', lock: '红绳缠绕的剑柄，断口有微弱金色灵光' }],
    },
  });
  assert.equal(draft.assets.length, 4, '缺固定短语的条目被跳过，其余留下');
  const character = draft.assets.find(asset => asset.name === '沈砚')!;
  assert.equal(character.id, 'c1', '模型给的 id 直接沿用，分镜步骤要按它引用');
  assert.deepEqual(character.aliases, ['小砚', '砚儿'], '代称按逗号拆开');
  assert.equal(character.lock, '十七岁少年，灰白旧布衣，背空剑鞘', '固定短语逐字保留');
  assert.equal(character.description, '沉默寡言');
  assert.equal(draft.assets.filter(asset => asset.kind === 'scene').length, 1);
  assert.equal(draft.assets.filter(asset => asset.kind === 'prop').length, 1);
  const ids = draft.assets.map(asset => asset.id);
  assert.equal(new Set(ids).size, ids.length, '重复的 id 必须被换成新的');
  assert.notEqual(draft.assets[1].id, 'c1');
});

test('剧本资产并入作品时，同名资产保留自己的固定短语', () => {
  const existing: Asset = { id: 'old-hero', kind: 'character', name: '沈砚', description: '用户改过的描述', lock: '用户手改的固定短语' };
  const draft = normalizeScreenplay({
    title: '断剑归门', screenplay: screenplayFixture(),
    assets: { characters: [{ id: 'c1', name: '沈砚', lock: '模型给的固定短语' }] },
  });
  const merged = mergeDraftAssets([existing], draft);
  assert.equal(merged.assets.length, 1, '同名同类不重复建');
  assert.equal(merged.assets[0].lock, '用户手改的固定短语', '模型不能覆盖用户改过的固定短语');
  assert.equal(merged.assets[0].id, 'old-hero');
});

test('剧本正文为空时报错，其它内容一律原样保留', () => {
  assert.throws(() => normalizeScreenplay({ screenplay: '' }), /没有剧本正文/);
  assert.throws(() => normalizeScreenplay({}), /没有剧本正文/);
  const loose = normalizeScreenplay({ screenplay: '只是一段散文说明。' });
  assert.equal(loose.shots.length, 0, '剧本格式自由，不在前端拆镜');
  assert.equal(loose.screenplay, '只是一段散文说明。');
});

test('导入剧本：原文逐字保留，不在这里拆镜', () => {
  const source = '作品说明：不要丢弃这行\n# 第1镜（8秒）\n画面：雨中庭院\n开场：庭院门口\n动作：向前走\n终点：树下\n运镜：缓慢推进\n台词：阿青：我来了。\n未知字段：保留我\n\n## 镜头 2\n时长：12秒\n对白：\n- 长老：进来。\n额外的自由文字';
  const draft = parseScriptText(source);
  assert.equal(draft.shots.length, 0, '导入不拆镜');
  assert.equal(draft.assets.length, 0, '导入不建资产，资产由资产步骤从镜头里提取');
  assert.equal(draft.screenplay, source, '原文逐字保留');
  assert.throws(() => parseScriptText(' \n'), /输入/);
});

test('导出剧本文档重新导入仍是同一份剧本文本', () => {
  const p = project(); Object.assign(p, templateScript(p.theme));
  const document = buildDocuments(p)['剧本文档.md'];
  assert.ok(document.includes('# 第四部分｜标准漫剧剧本'), '剧本文档必须导出真实剧本');
  const draft = parseScriptText(document);
  assert.equal(draft.shots.length, 0, '导入不再拆镜');
  assert.ok((draft.screenplay || '').includes('# 第四部分｜标准漫剧剧本'));
  assert.ok((draft.screenplay || '').includes('主角'), '剧本内容不能丢');
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
  const planned = { ...p, promptConfig: { v: 3 as const, overrides: { templates: { 'image-character': { blocks: [{ id: 'image.character.three-view', title: '人物三视图条款', text: '只输出一张角色三视图设定卡。', builtin: 'image.character.three-view' }] } } } } };
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
  const shots = [
    { ...makeShot(1), visual: '人物设定\n阿青：黑短发青衣\n场景清单\n山门：黑石阶，薄雾\n庭院：白墙绿竹\n道具：断剑：红绳剑柄\n第1镜（9秒）\n场景：山门\n画面：阿青站定\n台词：阿青：回来了' },
    { ...makeShot(2), visual: '第2镜（9秒）\n画面：庭院里放着断剑' },
  ];
  const draft = extractLocalAssets(shots, []);
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

test('剧本步骤只产出剧本文本；镜头与对白由导演步骤产出', () => {
  const draft = normalizeScreenplay(generatedScreenplay());
  assert.equal(draft.logline, '少年拾起断剑，却不知剑里封着自己的神格。');
  assert.equal(draft.assets.length, 0, '人物资产等用户点提取或手动创建后才出现');
  assert.equal(draft.shots.length, 0, '剧本步骤不拆镜');
  assert.ok((draft.screenplay || '').includes('# 第四部分｜标准漫剧剧本'), '剧本正文必须留在作品里');
});

test('导演步骤把剧本结构化成镜头：对白以剧本原文为准', () => {
  const p = { ...project(), screenplay: screenplayFixture() };
  const result = normalizeDirector({ shots: [
    { number: 1, scene: '外景 · 山门石阶 — 清晨', visual: '沈砚蹲在石阶下，指尖抠开泥。', duration: 9, shotSize: '远景', movement: '固定', angle: '平视', start: '石阶下', action: '抠开泥', end: '泥被抠开', dialogues: [] },
    { number: 2, scene: '外景 · 山门石阶 — 清晨', visual: '断剑露出一截，剑身满是泥。', duration: 9, shotSize: '特写', movement: '固定', angle: '平视', start: '泥里', action: '断剑露出', end: '剑身满是泥', dialogues: [] },
    { number: 3, scene: '外景 · 山门石阶 — 清晨', visual: '沈砚捧起断剑。', duration: 9, shotSize: '中景', movement: '推', angle: '平视', start: '断剑在手里', action: '抬头', end: '望向山门', dialogues: [{ speaker: '沈砚', text: '我回来了' }] },
  ] }, p);
  assert.equal(result.shots.length, 3);
  assert.equal(result.shots[0].scene, '外景 · 山门石阶 — 清晨');
  assert.equal(result.shots[0].camera, '远景·固定·平视');
  assert.equal(result.shots[0].duration, 9);
  assert.equal(result.shots[2].dialogues[0].text, '我回来了。', '对白以剧本原文为准');
  assert.equal(result.shots[2].dialogues[0].speaker, '沈砚');
  assert.equal(result.shots[2].dialogues[0].speakerId, '', '没有人物资产时不硬挂说话人');
  assert.equal(result.mismatches, 0);
  assert.ok(result.shots.every(shot => shot.assetIds.length === 0 && shot.references.length === 0), '模型没引用资产时不挂任何资产');
});

test('分镜按资产 id 引用：主体单独标出，不存在的 id 丢掉并计数', () => {
  const assets: Asset[] = [
    { id: 'c1', kind: 'character', name: '沈砚', description: '', lock: '十七岁少年，灰白旧布衣' },
    { id: 's1', kind: 'scene', name: '山门', description: '', lock: '青灰石阶九十九级' },
    { id: 'p1', kind: 'prop', name: '断剑', description: '', lock: '红绳缠绕的剑柄' },
  ];
  const p = { ...project(), screenplay: screenplayFixture(), assets };
  const result = normalizeDirector({ shots: [
    { number: 1, scene: '外景 · 山门石阶 — 清晨', sceneId: 's1', visual: '沈砚蹲在石阶下。', duration: 9, shotSize: '远景', movement: '固定', angle: '平视', start: '石阶下', action: '抠开泥', end: '泥被抠开', dialogues: [], assets: [
      { assetId: 'c1', role: 'subject' }, { assetId: 'p1', role: 'prop' }, { assetId: 'nope', role: 'prop' },
    ] },
  ] }, p);
  assert.deepEqual(result.shots[0].assetIds, ['c1', 'p1', 's1'], '按 id 挂上，场景资产也算在场');
  assert.deepEqual(result.shots[0].subjects, ['c1'], '主体单独标出');
  assert.equal(result.unknownAssets, 1, '引用了不存在的 id 要计数');
});

test('说话人按名字或代称挂到人物资产上', () => {
  const assets: Asset[] = [{ id: 'c1', kind: 'character', name: '沈砚', description: '', lock: '灰白旧布衣', aliases: ['小砚'] }];
  const p = { ...project(), screenplay: screenplayFixture(), assets };
  const result = normalizeDirector({ shots: [
    { number: 1, scene: '外景 · 山门石阶 — 清晨', visual: '沈砚回头。', duration: 9, shotSize: '中景', movement: '固定', angle: '平视', start: '起', action: '动', end: '止', dialogues: [{ speaker: '小砚', text: '我不回来了。' }] },
  ] }, p);
  assert.equal(result.shots[0].dialogues[0].speakerId, 'c1', '代称也要能认到人物资产');
  assert.equal(result.shots[0].dialogues[0].speaker, '小砚');
});

test('镜数由模型决定，与既有镜头无关；镜号重排为连续序号', () => {
  const p = { ...project(), screenplay: screenplayFixture(), shots: [makeShot(1), makeShot(2)] };
  const rows = Array.from({ length: 5 }, (_, index) => ({
    number: index + 1, scene: '外景 · 山门石阶 — 清晨', visual: `画面${index + 1}`, duration: 3,
    shotSize: '中景', movement: '固定', angle: '平视', start: '起', action: '动', end: '止', dialogues: [],
  }));
  const result = normalizeDirector({ shots: rows }, p);
  assert.equal(result.shots.length, 5, '镜数由模型给出');
  assert.deepEqual(result.shots.map(shot => shot.number), [1, 2, 3, 4, 5], '镜号重排为连续序号');
  assert.ok(result.shots.every(shot => shot.id), '每镜都有独立 id');
});

test('模型没给出镜头时明确报错，不覆盖现有内容', () => {
  assert.throws(() => normalizeDirector({ shots: [] }, project()), /没有返回任何镜头/);
});

test('对白与剧本对不上时保留模型文本并计数', () => {
  const p = { ...project(), screenplay: screenplayFixture() };
  const result = normalizeDirector({ shots: [
    { number: 1, scene: '外景 · 山门石阶 — 清晨', visual: '沈砚捧起断剑。', duration: 9, shotSize: '中景', movement: '推', angle: '平视', start: '起', action: '动', end: '止', dialogues: [{ speaker: '沈砚', text: '我再也回不去了' }] },
  ] }, p);
  assert.equal(result.mismatches, 1, '对不上的对白要计数');
  assert.equal(result.shots[0].dialogues[0].text, '我再也回不去了');
});

test('资产提取分品类：新建人物资产、台词按名字挂上、未声明引用跳过并提示', () => {
  const p = { ...project(), shots: directorShots() };
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
  const p = { ...project(), shots: directorShots() };
  const extracted = applyCategoryExtraction(p, { characters: [{ name: '沈砚', description: '灰白旧布衣' }], shots: [] }, 'character');
  assert.ok(extracted.shots[2].dialogues[0].speakerId, '同名说话人照样挂上');
  const renamed = applyCategoryExtraction(p, { characters: [{ name: '沈砚之', description: '灰白旧布衣' }], shots: [] }, 'character');
  assert.equal(renamed.shots[2].dialogues[0].speakerId, '', '名字对不上时不乱挂');
  assert.ok(renamed.shots[2].dialogues[0].text, '台词不能被静默丢掉');
  assert.ok(!renamed.warnings?.some(note => note.includes('说话人')), '说话人是按冒号切出来的，不再列清单');
});

test('资产提取分品类：三类互不影响，各自只写自己的清单与逐镜关联', () => {
  const p = { ...project(), shots: directorShots() };
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
  const locked = { id: 'hero', kind: 'character' as const, name: '沈砚', description: '已确认外观', lock: '已确认外观' };
  const p = { ...project(), assets: [locked], shots: directorShots() };
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

test('剧本里没有【镜头：类型】也不影响：剧本原样留下，镜头由模型按内容定', () => {
  const loose = `### 场景1 外景 · 山门石阶 — 清晨

△ 沈砚蹲在石阶下，指尖抠开泥。

沈砚：“断剑还在。”

△ 他把断剑捧起来，泥水顺着剑脊滑落。
`;
  const draft = normalizeScreenplay({ title: '降级', screenplay: loose });
  assert.equal(draft.shots.length, 0, '剧本步骤不再拆镜');
  assert.equal(draft.screenplay, loose.trim(), '剧本内容原样保留');
});

test('校验镜数、时长、失效人物、参考图和音频模式，但不要求已制作视频', () => {
  const p = project(); p.shots = directorShots();
  assert.deepEqual(validateProject(p), []);
  p.shots[0].audio = { mediaId: 'audio', name: '暂未启用的配音', duration: 9 };
  assert.deepEqual(validateProject(p), [], '允许保留未激活配音轨，实际声音由单一audioMode决定');
  p.shots = p.shots.map(shot => ({ ...shot, duration: 200 }));
  p.shots[2].dialogues[0].speakerId = 'missing';
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

test('剧本正文为空时不覆盖现有剧本', () => {
  assert.throws(() => normalizeScreenplay({ title: 'x' }), /剧本正文/);
});
test('导演提示词带本片资产清单：id、品类、名称与固定短语都在里面', () => {
  const p = { ...project(), screenplay: screenplayFixture(), assets: [
    { id: 'c1', kind: 'character' as const, name: '沈砚', description: '', lock: '十七岁少年，灰白旧布衣' },
    { id: 's1', kind: 'scene' as const, name: '山门', description: '', lock: '青灰石阶九十九级' },
  ] };
  const prompt = directorPrompt(p);
  assert.ok(prompt.includes('c1'), '资产 id 要在提示词里，分镜按它引用');
  assert.ok(prompt.includes('沈砚'));
  assert.ok(prompt.includes('十七岁少年，灰白旧布衣'), '固定短语逐字进提示词');
  assert.ok(prompt.includes('s1'));
  assert.ok(prompt.includes('青灰石阶九十九级'));
});

test('视频提示词带画面与开场，主体资产单独标出来', () => {
  const p = { ...project(), assets: [
    { id: 'c1', kind: 'character' as const, name: '沈砚', description: '', lock: '十七岁少年，灰白旧布衣' },
    { id: 's1', kind: 'scene' as const, name: '山门', description: '', lock: '青灰石阶九十九级' },
  ] };
  const shot = { ...makeShot(1), visual: '沈砚蹲在石阶下抠开泥。', start: '石阶下', action: '抠开泥', end: '泥被抠开', camera: '远景·固定·平视', assetIds: ['c1', 's1'], subjects: ['c1'] };
  const prompt = videoPrompt(p, shot);
  assert.ok(prompt.includes('画面：沈砚蹲在石阶下抠开泥。'), '画面描述必须进视频提示词');
  assert.ok(prompt.includes('开场：石阶下'), '开场状态必须进视频提示词');
  assert.ok(prompt.includes('「沈砚」（主体）'), '主体要标出来，模型才知道谁是画面重心');
  assert.ok(prompt.includes('十七岁少年，灰白旧布衣'), '固定短语逐字进视频提示词');
});

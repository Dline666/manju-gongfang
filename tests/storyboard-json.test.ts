import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStoryboardJsonText, validateStoryboardJson, previewImport,
  SHOT_SIZES_ENUM, MOVEMENTS_ENUM, ANGLES_ENUM, MIN_SHOTS, MAX_SHOTS,
  MIN_DURATION, MAX_DURATION,
} from '../src/lib/storyboardJson';

/** 一份合规的分镜 JSON：4 镜、每镜 12 秒、上一镜 end 等于下一镜 start。 */
function valid(): Record<string, unknown> {
  return {
    title: '第1集 雪夜归人',
    assets: [
      { assetId: 'char-linwan', kind: 'character', name: '林晚', description: '二十岁出头，深青色长衣，长发束起，眉眼清冷' },
      { assetId: 'scene-gate', kind: 'scene', name: '雪夜山门', description: '积雪的石阶与断裂的牌坊，寒风卷雪' },
      { assetId: 'prop-sword', kind: 'prop', name: '断剑', description: '剑身中段断裂，断口发黑，剑柄缠旧布' },
    ],
    shots: Array.from({ length: MIN_SHOTS }, (_, index) => ({
      number: index + 1,
      title: `第${index + 1}镜标题`,
      scene: '雪夜山门',
      sceneId: 'scene-gate',
      visual: `第${index + 1}镜画面描述`,
      duration: 12,
      shotSize: '中景',
      movement: '固定',
      angle: '平视',
      start: `第${index + 1}镜开场`,
      action: `第${index + 1}镜动作`,
      // 连续性：本镜 end 与下一镜 start 相同
      end: index === MIN_SHOTS - 1 ? '收尾状态' : `第${index + 2}镜开场`,
      assets: [{ assetId: 'char-linwan', role: 'subject' }],
      dialogues: [{ speaker: '林晚', text: '我回来了。', emotion: '平静' }],
      endState: { space: '山门前', positions: '林晚居中', light: '冷月', props: '断剑在手', emotion: '压抑' },
    })),
  };
}

test('合规 JSON 通过校验并转出镜头与资产', () => {
  const outcome = validateStoryboardJson(valid());
  assert.ok(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.issues));
  const { result } = outcome;
  assert.equal(result.shots.length, MIN_SHOTS);
  assert.equal(result.assets.length, 3);
  assert.equal(result.dialogueMismatches, 0);
  assert.equal(result.title, '第1集 雪夜归人');
  assert.equal(result.shots[0].number, 1);
  assert.equal(result.shots[0].camera, '中景·固定·平视');
  assert.equal(result.shots[0].assetIds.includes('char-linwan'), true);
  assert.equal(result.shots[0].assetIds.includes('scene-gate'), true, 'sceneId 要算进本镜在场资产');
  assert.deepEqual(result.shots[0].subjects, ['char-linwan']);
  assert.equal(result.shots[0].continuity, '空间：山门前；位置：林晚居中；光线：冷月；道具：断剑在手；情绪：压抑');
  assert.equal(result.shots[0].dialogues[0].text, '我回来了。');
  assert.equal(result.shots[0].dialogues[0].speakerId, 'char-linwan', '说话人按名字挂到人物资产');
});

test('拒绝 Markdown 围栏', () => {
  const bad = parseStoryboardJsonText('```json\n{"shots":[]}\n```');
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.issue.message, /代码围栏/);
});

test('拒绝前后解释文字', () => {
  const bad = parseStoryboardJsonText('好的，这是分镜：\n{"shots":[]}');
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.issue.message, /纯 JSON/);
});

test('拒绝空内容与坏 JSON，并说清原因', () => {
  assert.equal(parseStoryboardJsonText('   ').ok, false);
  const broken = parseStoryboardJsonText('{"shots": [,]}');
  assert.equal(broken.ok, false);
  assert.match(broken.ok ? '' : broken.issue.message, /JSON 解析失败/);
});

test('镜数不足与超出都报错，并指出实际镜数', () => {
  const few = valid();
  few.shots = (few.shots as unknown[]).slice(0, MIN_SHOTS - 1);
  const a = validateStoryboardJson(few);
  assert.equal(a.ok, false);
  assert.match(JSON.stringify(a.ok ? [] : a.issues), new RegExp(`${MIN_SHOTS}–${MAX_SHOTS} 镜`));

  const many = valid();
  many.shots = [...(many.shots as unknown[]), ...(many.shots as unknown[]).slice(0, MAX_SHOTS)];
  const b = validateStoryboardJson(many);
  assert.equal(b.ok, false);
});

test('缺必填字段时一次性列出全部问题，指出第几镜', () => {
  const broken = valid();
  const shots = broken.shots as Record<string, unknown>[];
  delete shots[1].visual;
  delete shots[2].action;
  delete shots[3].end;
  const outcome = validateStoryboardJson(broken);
  assert.equal(outcome.ok, false);
  const issues = outcome.ok ? [] : outcome.issues;
  const fields = issues.map(issue => `${issue.shot}:${issue.field}`);
  assert.ok(fields.includes('2:visual'), JSON.stringify(fields));
  assert.ok(fields.includes('3:action'), JSON.stringify(fields));
  assert.ok(fields.includes('4:end'), JSON.stringify(fields));
  assert.ok(issues.every(issue => issue.message.includes(`第${issue.shot}镜`)), '报错必须指出第几镜');
});

test('枚举外的景别/运镜/机位被拒绝，并列出合法值', () => {
  const broken = valid();
  const shots = broken.shots as Record<string, unknown>[];
  shots[0].shotSize = '大远景';
  shots[1].movement = '推拉';
  shots[2].angle = '斜视';
  const outcome = validateStoryboardJson(broken);
  assert.equal(outcome.ok, false);
  const text = JSON.stringify(outcome.ok ? [] : outcome.issues);
  assert.ok(text.includes('大远景'));
  assert.ok(MOVEMENTS_ENUM.some(value => text.includes(value)));
  assert.ok(text.includes('斜视'));
  assert.ok(SHOT_SIZES_ENUM.every(value => text.includes(value)), '合法景别要列全，用户才知道能改成什么');
  assert.ok(ANGLES_ENUM.every(value => text.includes(value)));
});

test('duration 超出 0.5–30 秒被拒绝', () => {
  for (const duration of [0, 0.4, 31, 99]) {
    const broken = valid();
    (broken.shots as Record<string, unknown>[])[0].duration = duration;
    const outcome = validateStoryboardJson(broken);
    assert.equal(outcome.ok, false, `${duration} 秒应当被拒`);
    assert.match(JSON.stringify(outcome.ok ? [] : outcome.issues), new RegExp(`${MIN_DURATION}–${MAX_DURATION}`));
  }
  // 边界值放行：0.5 秒装不下那句台词，所以只验时长本身，不给台词。
  for (const duration of [MIN_DURATION, MAX_DURATION]) {
    const ok = valid();
    const shot = (ok.shots as Record<string, unknown>[])[0];
    shot.duration = duration;
    if (duration === MIN_DURATION) shot.dialogues = [];
    assert.equal(validateStoryboardJson(ok).ok, true, `${duration} 秒应当放行`);
  }
});

test('duration 不是数字被拒绝', () => {
  const broken = valid();
  (broken.shots as Record<string, unknown>[])[0].duration = '十二秒';
  const outcome = validateStoryboardJson(broken);
  assert.equal(outcome.ok, false);
  assert.match(JSON.stringify(outcome.ok ? [] : outcome.issues), /不是数字/);
});

test('连续性：下一镜 start 必须等于上一镜 end，报错指出两镜', () => {
  const broken = valid();
  const shots = broken.shots as Record<string, unknown>[];
  shots[1].start = '完全不同的开场';
  const outcome = validateStoryboardJson(broken);
  assert.equal(outcome.ok, false);
  const issues = outcome.ok ? [] : outcome.issues;
  const hit = issues.find(issue => issue.shot === 2 && issue.field === 'start');
  assert.ok(hit, JSON.stringify(issues));
  assert.match(hit!.message, /第1镜/);
  assert.match(hit!.message, /第2镜/);
  assert.match(hit!.message, /完全不同的开场/);
});

test('台词必须在镜头结束前 0.3 秒说完', () => {
  const broken = valid();
  // 这一镜 2 秒，却塞了一句 35+ 字（约 5 秒）的台词
  const shot = (broken.shots as Record<string, unknown>[])[0];
  shot.duration = 2;
  shot.dialogues = [{ speaker: '林晚', text: '这是一句非常长的台词'.repeat(4), emotion: '激动' }];
  const outcome = validateStoryboardJson(broken);
  assert.equal(outcome.ok, false);
  assert.match(JSON.stringify(outcome.ok ? [] : outcome.issues), /余量/);
});

test('台词说话人或正文为空被拒绝', () => {
  const broken = valid();
  (broken.shots as Record<string, unknown>[])[0].dialogues = [{ speaker: '', text: '有正文' }, { speaker: '林晚', text: '' }];
  const outcome = validateStoryboardJson(broken);
  assert.equal(outcome.ok, false);
  const fields = (outcome.ok ? [] : outcome.issues).map(issue => issue.field);
  assert.ok(fields.some(field => field.includes('speaker')));
  assert.ok(fields.some(field => field.includes('text')));
});

test('模型漏写顶层 assets 时从镜头引用补齐，并标明补齐项', () => {
  const payload = valid();
  delete payload.assets;
  const outcome = validateStoryboardJson(payload);
  assert.ok(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.issues));
  const { result } = outcome;
  assert.ok(result.filledAssets.includes('char-linwan'), JSON.stringify(result.filledAssets));
  assert.ok(result.unknownAssetIds.includes('char-linwan'));
  assert.ok(result.filledAssets.includes('scene-gate'), 'sceneId 也要补成场景资产');
  const character = result.assets.find(asset => asset.id === 'char-linwan')!;
  assert.equal(character.kind, 'character');
  // 补出来的资产描述留空交给用户补写，不能凭空编造长相
  assert.equal(character.description, '');
  const scene = result.assets.find(asset => asset.id === 'scene-gate')!;
  assert.equal(scene.kind, 'scene');
  assert.equal(scene.name, '雪夜山门');
});

test('镜头用 assetIds 简写时同样认下引用，资产不会静默丢失', () => {
  const payload = valid();
  delete payload.assets;
  const shots = payload.shots as Record<string, unknown>[];
  for (const shot of shots) {
    const refs = shot.assets as { assetId: string; role?: string }[];
    shot.assetIds = refs.map(ref => ref.assetId);
    delete shot.assets;
  }
  const outcome = validateStoryboardJson(payload);
  assert.ok(outcome.ok, outcome.ok ? '' : JSON.stringify(outcome.issues));
  const { result } = outcome;
  assert.ok(result.assets.some(asset => asset.id === 'char-linwan'), JSON.stringify(result.assets.map(asset => asset.id)));
  assert.ok(result.shots[0].assetIds.includes('char-linwan'));
  assert.ok(result.shots[0].assetIds.includes('scene-gate'));
});

test('顶层 assets 去重：同 id 只保留第一条固定描述', () => {
  const payload = valid();
  (payload.assets as unknown[]).push({ assetId: 'char-linwan', kind: 'character', name: '林晚', description: '另一段会漂的描述' });
  const outcome = validateStoryboardJson(payload);
  assert.ok(outcome.ok);
  const characters = outcome.ok ? outcome.result.assets.filter(asset => asset.id === 'char-linwan') : [];
  assert.equal(characters.length, 1);
  assert.match(characters[0].description, /深青色长衣/, '固定描述取先出现的那条，之后 verbatim 复用');
});

test('给了剧本时台词逐字回填剧本原文', () => {
  const payload = valid();
  (payload.shots as Record<string, unknown>[])[0].dialogues = [{ speaker: '林晚', text: '我，回来了' }];
  // 其余三镜的台词必须也能在剧本里找到，否则会被算作对不上。
  for (const shot of (payload.shots as Record<string, unknown>[]).slice(1)) shot.dialogues = [{ speaker: '林晚', text: '我回来了。' }];
  const screenplay = ['林晚：我回来了。', '沈砚：走，天要亮了。'].join('\n');
  const outcome = validateStoryboardJson(payload, { screenplay });
  assert.ok(outcome.ok);
  assert.equal((outcome.ok ? outcome.result.shots[0].dialogues[0].text : ''), '我回来了。');
  assert.equal(outcome.ok ? outcome.result.dialogueMismatches : -1, 0);
});

test('台词与剧本对不上时计数，但不算失败', () => {
  const payload = valid();
  const shots = payload.shots as Record<string, unknown>[];
  shots[0].dialogues = [{ speaker: '林晚', text: '剧本里没有这句。' }];
  for (const shot of shots.slice(1)) shot.dialogues = [{ speaker: '林晚', text: '我回来了。' }];
  const outcome = validateStoryboardJson(payload, { screenplay: '林晚：我回来了。' });
  assert.ok(outcome.ok, '对不上只计数，交给用户核对，不阻断导入');
  assert.equal(outcome.ok ? outcome.result.dialogueMismatches : -1, 1);
});

test('解析结果表：资产分类计数、每镜概览、总时长、补齐项', () => {
  const payload = valid();
  delete payload.assets;
  const outcome = validateStoryboardJson(payload);
  assert.ok(outcome.ok);
  const preview = previewImport(outcome.ok ? outcome.result : { assets: [], shots: [], filledAssets: [], unknownAssetIds: [], dialogueMismatches: 0 });
  assert.equal(preview.assetsByKind.character, 1);
  assert.equal(preview.assetsByKind.scene, 1);
  assert.equal(preview.shots.length, MIN_SHOTS);
  assert.equal(preview.totalDuration, MIN_SHOTS * 12);
  assert.equal(preview.shots[0].dialogues, 1);
  assert.ok(preview.filledAssets.length > 0);
});

test('shots 缺失或为空直接返回单条整份层面的问题', () => {
  for (const payload of [{}, { shots: [] }, { shots: 'nope' }]) {
    const outcome = validateStoryboardJson(payload);
    assert.equal(outcome.ok, false);
    assert.equal((outcome.ok ? [] : outcome.issues).length, 1);
    assert.equal((outcome.ok ? [] : outcome.issues)[0].shot, 0);
  }
});
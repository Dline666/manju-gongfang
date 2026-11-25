import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRetryPrompt, parseScreenplayShots, SHOT_SPEC_VERSION, validateScreenplayShots } from '../src/lib/screenplay';
import { templateScript } from '../src/features/script/creation';
import { durationRows } from '../src/features/script/DurationStrip';
import { scriptWarnings, validateScriptStage } from '../src/domain/flow';
import { defaultStyle, makeShot, type Project } from '../src/domain/types';

/** 造一份剧本：每个镜头一行标记 + 一行动作 + 一行台词。 */
function screenplay(durations: (number | undefined)[], extra = ''): string {
  const lines: string[] = ['# 第四部分｜标准漫剧剧本', '', '### 场景1 外景 · 山门 — 清晨', ''];
  durations.forEach((duration, index) => {
    lines.push(duration === undefined ? `【镜头${index + 1}：远景】` : `【镜头${index + 1}：远景】（时长${duration}s）`);
    lines.push('△ 主角站在石阶上，没有再往前。');
    lines.push('主角（平静）：“那我拿别的换。”');
    lines.push('');
  });
  if (extra) lines.push(extra);
  return lines.join('\n');
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p', name: '断剑归门', theme: '少年拾起断剑', style: defaultStyle,
    createdAt: '', updatedAt: '', revision: 0, source: 'ai', skills: ['script'], shots: [], assets: [],
    storyboardReady: false, ...overrides,
  };
}

test('解析出镜头：镜号、景别、显式时长', () => {
  const shots = parseScreenplayShots(screenplay([12, 12, 12, 12, 12]));
  assert.equal(shots.length, 5);
  assert.equal(shots[0].number, 1);
  assert.equal(shots[0].camera, '远景');
  assert.equal(shots[0].duration, 12);
  assert.equal(shots[4].index, 5);
  assert.equal(shots[4].duration, 12);
});

test('旧写法【镜头：远景】也认，时长写在正文行上也认', () => {
  const shots = parseScreenplayShots('【镜头：中景】\n△ 动作。（时长11s）');
  assert.equal(shots.length, 1);
  assert.equal(shots[0].camera, '中景');
  assert.equal(shots[0].duration, 11);
  assert.equal(shots[0].markedOnHeader, false);
});

test('没写时长标记就是未声明，不拿台词字数兜底', () => {
  const result = validateScreenplayShots(screenplay([undefined, 12, 12, 12, 12]));
  assert.ok(result.issues.some(issue => issue.includes('第1镜没有写时长标记')), result.issues.join('；'));
  assert.equal(result.shots[0].duration, undefined);
});

test('镜数越界：镜少了要补，镜多了要合并', () => {
  const few = validateScreenplayShots(screenplay([12, 12, 12]));
  assert.ok(few.issues.some(issue => issue.includes('共 3 镜') && issue.includes('需补到 4–6 镜')), few.issues.join('；'));
  const many = validateScreenplayShots(screenplay([12, 12, 12, 12, 12, 12, 12]));
  assert.ok(many.issues.some(issue => issue.includes('共 7 镜') && issue.includes('需合并为 6 镜')), many.issues.join('；'));
});

test('单镜超范围逐镜指出差多少秒', () => {
  const short = validateScreenplayShots(screenplay([7, 12, 12, 12, 12]));
  assert.ok(short.issues.some(issue => issue.includes('第1镜只有 7 秒') && issue.includes('10–15 秒')), short.issues.join('；'));
  const long = validateScreenplayShots(screenplay([18, 12, 12, 12, 12]));
  assert.ok(long.issues.some(issue => issue.includes('第1镜有 18 秒') && issue.includes('超出 10–15 秒')), long.issues.join('；'));
});

test('总时长按各镜之和算，镜数不足时总时长也超界', () => {
  const result = validateScreenplayShots(screenplay([12, 12, 12]));
  assert.ok(result.issues.some(issue => issue.includes('总时长 36 秒')), result.issues.join('；'));
});

test('符合规格的剧本没有硬违规，总时长是各镜之和', () => {
  const five = validateScreenplayShots(screenplay([12, 12, 12, 12, 12]));
  assert.deepEqual(five.issues, []);
  assert.equal(five.total, 60);
  const min = validateScreenplayShots(screenplay([10, 10, 10, 10]));
  assert.deepEqual(min.issues, []);
  assert.equal(min.total, 40);
  const max = validateScreenplayShots(screenplay([15, 15, 15, 15, 15, 15]));
  assert.deepEqual(max.issues, []);
  assert.equal(max.total, 90);
});

test('自检行与各镜之和对不上要提示', () => {
  const result = validateScreenplayShots(screenplay([12, 12, 12, 12, 12], '【时长自检】合计 99 秒'));
  assert.deepEqual(result.issues, []);
  assert.ok(result.warnings.some(warning => warning.includes('自检行写的合计 99 秒')), result.warnings.join('；'));
});

test('内容偏少只提示不阻断', () => {
  const source = [
    '【镜头1：远景】（时长12s）', '△ 主角站着。', '',
    '【镜头2：远景】（时长12s）', '△ 主角站着。', '',
    '【镜头3：远景】（时长12s）', '△ 主角站着。', '',
    '【镜头4：远景】（时长12s）', '△ 主角站着。', '',
    '【镜头5：远景】（时长12s）', '△ 主角站着。', '',
  ].join('\n');
  const result = validateScreenplayShots(source);
  assert.deepEqual(result.issues, []);
  assert.ok(result.warnings.some(warning => warning.includes('内容偏少')), result.warnings.join('；'));
});

test('镜号不连续只提示不阻断', () => {
  const source = screenplay([12, 12, 12, 12, 12]).replace('【镜头3：', '【镜头9：');
  const result = validateScreenplayShots(source);
  assert.deepEqual(result.issues, []);
  assert.ok(result.warnings.some(warning => warning.includes('镜号不连续')), result.warnings.join('；'));
});

test('重试提示词只贴违规清单，不重发整套模板', () => {
  const result = validateScreenplayShots(screenplay([7, 12, 12, 12, 12]));
  const prompt = buildRetryPrompt(result, '上一版剧本正文');
  assert.ok(prompt.includes('第1镜只有 7 秒'), prompt);
  assert.ok(prompt.includes('上一版剧本正文'), prompt);
  assert.ok(!prompt.includes('统一风格'), '重试提示词不该重发模板的数据块');
  assert.ok(!prompt.includes('主题与风格'), '重试提示词不该重发模板的数据块');
});

test('模板演练的剧本符合新规格', () => {
  const draft = templateScript('少年拾起断剑');
  const result = validateScreenplayShots(draft.screenplay || '');
  assert.deepEqual(result.issues, [], result.issues.join('；'));
  assert.equal(result.shots.length, 5);
  assert.equal(result.total, 60);
});

test('门禁只对新规格作品生效，旧作品不被新规则误伤', () => {
  const legacy = project({ screenplay: screenplay([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]) });
  assert.deepEqual(validateScriptStage(legacy), [], '旧的 10 镜 90 秒作品不该被拦住');
  assert.ok(scriptWarnings(legacy).some(warning => warning.includes('旧规格')));

  const spec = project({ screenplay: legacy.screenplay, specVersion: SHOT_SPEC_VERSION });
  const issues = validateScriptStage(spec);
  assert.ok(issues.some(issue => issue.includes('共 10 镜')), issues.join('；'));
  assert.ok(issues.some(issue => issue.includes('第1镜只有 9 秒')), issues.join('；'));
});

test('时长表：新规格按 10–15 秒标红，旧作品仍按 0.5–30 秒', () => {
  const shot = { ...makeShot(1), duration: 9 };
  const legacy = project({ shots: [shot] });
  assert.equal(durationRows(legacy)[0].invalid, false);
  const spec = project({ shots: [shot], specVersion: SHOT_SPEC_VERSION });
  assert.equal(durationRows(spec)[0].invalid, true);
});

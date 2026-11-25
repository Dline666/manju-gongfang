// 符合新规格的剧本正文：4–6 镜、每镜 10–15 秒整数、总时长 40–90 秒。
// 浏览器回归共用：模型返回的剧本要先过「镜数与时长」校验，否则生成会被拦住、不会覆盖作品。
export function makeScreenplay({
  premise = '少年在雨夜山门拾起一把断剑。',
  character = '阿青',
  scene = '外景 · 山门 — 清晨',
  shots = 4,
  seconds = 12,
} = {}) {
  const parts = [
    '# 第一部分｜核心前提',
    '',
    '【核心前提】',
    premise,
    '',
    '【黄金3秒钩子】',
    '类型：反常细节',
    '△ 门缝里的光一寸一寸暗下去。',
    '',
    '# 第二部分｜场景因果节拍表',
    '',
    '| 场次 | 场景目标 | 遭遇阻碍 |',
    '|---|---|---|',
    '| 1 | 拾剑 | 山门无人 |',
    '',
    '# 第三部分｜世界观与人物关系确认',
    '',
    '【世界边界】',
    '- 时代：架空。',
    '',
    '# 第四部分｜标准漫剧剧本',
    '',
    '## 第一章  断剑归门',
    '',
    `### 场景1 ${scene}`,
    '',
    '**剧情：**少年在雨夜山门拾起一把断剑。',
    `**人物：**${character}`,
    '',
  ];
  for (let index = 0; index < shots; index += 1) {
    parts.push(`【镜头${index + 1}：远景】（时长${seconds}s）`);
    parts.push(`△ 少年在雨夜山门拾起一把断剑，石阶上的雨点砸出第${index + 1}圈水花。`);
    parts.push(`△ 剑柄上的红绳被雨水浸透，颜色一点点沉下去。`);
    parts.push(`${character}（平静）：“我来拿回我的剑（第${index + 1}句）。”`);
    parts.push('');
  }
  parts.push(`【时长自检】${Array.from({ length: shots }, (_, index) => `第${index + 1}镜${seconds}秒`).join('｜')}｜合计${shots * seconds}秒`);
  return parts.join('\n');
}

/** 不合规的样例：镜数太少、单镜太短，用来验证拦住与重试。 */
export function makeOffSpecScreenplay({ shots = 3, seconds = 7 } = {}) {
  const parts = ['# 第四部分｜标准漫剧剧本', '', '### 场景1 外景 · 山门 — 清晨', ''];
  for (let index = 0; index < shots; index += 1) {
    parts.push(`【镜头${index + 1}：远景】（时长${seconds}s）`);
    parts.push('△ 少年在雨夜山门拾起一把断剑。');
    parts.push('');
  }
  return parts.join('\n');
}

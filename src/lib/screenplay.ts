// 剧本正文的读取，以及「镜数与时长」规格的解析与校验。
//
// 这里放在 lib 而不是 features：剧本步骤、导演步骤、流程门禁都要用同一套解析与规则，
// 规格只认剧本里显式写出来的时长标记，不做估算兜底——
// 估出来的时间不是模型报出来的时间，行数一变时长就跟着变，规格就漂了。
//
// 规格本身写在用户自己的模板里（出厂块「镜数与时长（硬性）」），
// 这里只负责把不合规的结果拦住，并把差多少秒说清楚。
import { parseSceneHead } from './promptBlocks';

const DIALOGUE_LINE = /^\s*([^\s（(【△][^（(【△：:]{0,24}?)\s*(?:（([^）]{0,24})）)?\s*[：:]\s*(.+)$/;
const SKIP_LINE = /^\s*(?:#{1,6}\s|\*\*|---+\s*$|>\s)/;
const QUOTES = /^[“"「『](.*)[”"」』]\s*$/;
/** 剧本里的时长标记（「（时长12s）」）。 */
export const DURATION_MARK = /（\s*时长\s*([\d.]+)\s*s?\s*）/;
/**
 * 镜头标记：「【镜头1：远景】」。
 * 镜号可省（「【镜头：远景】」是旧写法），景别也可省；标记行后面可以跟显式时长。
 */
export const SHOT_MARK = /^\s*【\s*镜头\s*(\d+)?\s*[：:]?\s*(.*?)\s*】\s*(.*)$/;
/** 旧的「【镜头：类型】」写法，演练排镜时用同一套标记解析。 */
export const CAMERA_MARK = SHOT_MARK;
const SCENE_HEAD = /^\s*#{2,4}\s*场景\s*\d+\s*(.*)$/;
/** 动作行前缀「△」。 */
export const ACTION_LINE = /^\s*△\s*(.+)$/;
export const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写'];

/** 单句台词时长估算：按漫剧语速表（1–5字→1秒 … 21–35字→3.5–5秒）折算。 */
export function estimateDialogueSeconds(text: string): number {
  const length = text.replace(/[，。！？、；：""''「」…—·]/g, '').length;
  if (length <= 0) return 0;
  if (length <= 5) return 1;
  if (length <= 12) return 1.5;
  if (length <= 20) return 2.5;
  if (length <= 35) return 3.5;
  return 5;
}

/** 场景头拆成内外景 / 地点 / 时间三段；资产提取按空间归组时复用。 */
export { parseSceneHead };

/** 剧本里的一句对白。 */
export interface ScreenplayLine { speaker: string; text: string }

/** 归一化：去掉空白与标点，用来比对同一句话的不同写法。 */
export function normalizeDialogue(value: string): string {
  return value.replace(/[\s，。！？、；：,.!?;:"'“”「」『』…—·（）()【】]/g, '');
}

/**
 * 从一行里读出说话人与台词；不是对白就返回 undefined。
 * 先剥「（时长12s）」这类标记，再剥引号——顺序反了会把标记留在台词里。
 */
export function parseDialogueLine(line: string): ScreenplayLine | undefined {
  if (SKIP_LINE.test(line)) return undefined;
  const match = line.match(DIALOGUE_LINE);
  if (!match) return undefined;
  const body = match[3].replace(DURATION_MARK, '').trim();
  const quoted = body.match(QUOTES);
  const spoken = (quoted ? quoted[1] : body).trim();
  if (!spoken) return undefined;
  return { speaker: match[1].trim(), text: spoken };
}

/**
 * 扫出剧本里的全部对白。
 * 导演步骤由模型结构化分镜，模型复述的对白可能有出入，
 * 拿这份池子核对，命中就用剧本原文。
 */
export function screenplayDialoguePool(source: string): ScreenplayLine[] {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const pool: ScreenplayLine[] = [];
  for (const line of lines) {
    if (/^\s*\*\*(剧情|人物)[：:]/.test(line)) continue;
    const parsed = parseDialogueLine(line);
    if (parsed) pool.push(parsed);
  }
  return pool;
}

/** 场景头（「### 场景1 外景 · 山门 — 清晨」）里的场景名。 */
export function screenplaySceneName(line: string): string | undefined {
  const match = line.match(SCENE_HEAD);
  return match ? (match[1].trim() || '未标注场景') : undefined;
}

/** 去掉一行里的时长标记与动作前缀，只留正文。 */
export function cleanScreenplayLine(line: string): string {
  return line.replace(DURATION_MARK, '').replace(/^\s*△\s*/, '').trim();
}

/** 剧本里有多少个场景（「### 场景N」）。 */
export function screenplaySceneCount(source: string): number {
  return source.replace(/\r\n?/g, '\n').split('\n').filter(line => SCENE_HEAD.test(line)).length;
}

/** 从剧本里取章节名与核心前提，作为 title / logline 的兜底。 */
export function readScreenplayMeta(source: string): { title: string; logline: string } {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const chapter = text.match(/^\s*#{1,4}\s*(第[一二三四五六七八九十百零〇\d]+\s*章[^\n]*)$/m);
  const premise = text.match(/【核心前提】\s*\n?\s*(.+)/);
  return { title: chapter ? chapter[1].trim() : '', logline: premise ? premise[1].trim() : '' };
}

// ── 镜数与时长规格 ─────────────────────────────────────────────

/**
 * 新规格的版本号。
 * 作品带上它，说明这份剧本是按新规格校验过的（生成、导入或保存时通过）；
 * 没带的都是新规格之前存下来的旧作品——只提示，不阻断。
 */
export const SHOT_SPEC_VERSION = 'shot-spec-v1';

/** 镜数：4–6 镜。 */
export const SHOT_COUNT_RANGE = { min: 4, max: 6 } as const;
/** 单镜时长：10–15 秒，必须是整数。 */
export const SHOT_DURATION_RANGE = { min: 10, max: 15 } as const;
/** 总时长：40–90 秒。 */
export const TOTAL_DURATION_RANGE = { min: 40, max: 90 } as const;

/** 一个动作点约 1.5 秒；台词要在本镜结束前至少 0.3 秒说完。 */
const ACTION_SECONDS = 1.5;
const DIALOGUE_GAP_SECONDS = 0.3;

/** 从一段文字里读出显式时长；没有写就是 undefined（未声明）。 */
export function readDeclaredDuration(text: string): number | undefined {
  const match = (text || '').match(DURATION_MARK);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 剧本里解析出的一镜。 */
export interface ScreenplayShot {
  /** 第几镜（按出现顺序，从 1 开始）。 */
  index: number;
  /** 标记里写出来的镜号；没写就是 undefined。 */
  number?: number;
  /** 景别：「【镜头1：远景】」里的「远景」。 */
  camera?: string;
  /** 显式声明的时长（秒）。没写标记就是 undefined——未声明，不合格。 */
  duration?: number;
  /** 时长是不是写在镜头标记那一行。 */
  markedOnHeader: boolean;
  /** 这一镜的正文行。 */
  lines: string[];
}

/**
 * 把剧本正文解析成一镜一镜。
 *
 * 镜头标记（「【镜头1：远景】」）开头就算一镜开始，一直到下一个镜头标记。
 * 标记之前的内容是结构说明（核心前提、节拍表），不属于任何一镜。
 * 时长只认显式标记：先看标记行，再看这一镜的正文行；两处都没有就是「未声明」。
 */
export function parseScreenplayShots(source: string): ScreenplayShot[] {
  const lines = (source || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const shots: ScreenplayShot[] = [];
  let current: ScreenplayShot | undefined;
  for (const line of lines) {
    const marked = line.match(SHOT_MARK);
    if (marked) {
      const trailing = (marked[3] || '').trim();
      current = {
        index: shots.length + 1,
        number: marked[1] ? Number(marked[1]) : undefined,
        camera: (marked[2] || '').trim() || undefined,
        duration: undefined,
        markedOnHeader: false,
        lines: [],
      };
      const header = readDeclaredDuration(trailing);
      if (header !== undefined) { current.duration = header; current.markedOnHeader = true; }
      if (trailing) current.lines.push(trailing);
      shots.push(current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
  }
  for (const shot of shots) {
    if (shot.duration !== undefined) continue;
    for (const line of shot.lines) {
      const duration = readDeclaredDuration(line);
      if (duration !== undefined) { shot.duration = duration; break; }
    }
  }
  return shots;
}

/** 规格校验的结果：硬违规（拦住并重试）与软提示（只提醒）。 */
export interface ShotSpecResult {
  shots: ScreenplayShot[];
  /** 各镜声明时长之和；没声明的不算进来。 */
  total: number;
  /** 硬违规：镜数、单镜时长、总时长。 */
  issues: string[];
  /** 软提示：镜号不连续、内容偏少、自检行对不上。 */
  warnings: string[];
}

/** 一镜的内容够不够：台词按语速折算，动作点按每点 1.5 秒。 */
function contentSeconds(shot: ScreenplayShot): { spoken: number; actions: number; estimate: number } {
  let spoken = 0;
  let actions = 0;
  for (const line of shot.lines) {
    const action = line.match(ACTION_LINE);
    if (action) { actions += 1; continue; }
    const dialogue = parseDialogueLine(line);
    if (dialogue) spoken += estimateDialogueSeconds(dialogue.text);
  }
  return { spoken, actions, estimate: spoken + actions * ACTION_SECONDS };
}

/**
 * 按规格校验一份剧本正文。
 *
 * 三条硬拦（issues）：
 * 1. 镜数在 4–6 之间；
 * 2. 每镜都有显式时长标记，且是 10–15 秒的整数；
 * 3. 总时长（各镜之和）在 40–90 秒。
 *
 * 没有时长标记的镜直接判不合格，不用台词字数去猜它该多长。
 */
export function validateScreenplayShots(source: string): ShotSpecResult {
  const shots = parseScreenplayShots(source);
  const issues: string[] = [];
  const warnings: string[] = [];
  if (!shots.length) {
    issues.push('剧本里没有找到镜头标记（【镜头1：远景】），无法核对镜数与时长。');
    return { shots, total: 0, issues, warnings };
  }
  if (shots.length < SHOT_COUNT_RANGE.min) issues.push(`共 ${shots.length} 镜，需补到 ${SHOT_COUNT_RANGE.min}–${SHOT_COUNT_RANGE.max} 镜`);
  else if (shots.length > SHOT_COUNT_RANGE.max) issues.push(`共 ${shots.length} 镜，需合并为 ${SHOT_COUNT_RANGE.max} 镜`);

  let total = 0;
  let declared = 0;
  for (const shot of shots) {
    const label = `第${shot.index}镜`;
    if (shot.duration === undefined) {
      issues.push(`${label}没有写时长标记（时长${SHOT_DURATION_RANGE.min}s）`);
      continue;
    }
    declared += 1;
    total += shot.duration;
    if (shot.duration < SHOT_DURATION_RANGE.min) issues.push(`${label}只有 ${shot.duration} 秒，需补到 ${SHOT_DURATION_RANGE.min}–${SHOT_DURATION_RANGE.max} 秒`);
    else if (shot.duration > SHOT_DURATION_RANGE.max) issues.push(`${label}有 ${shot.duration} 秒，超出 ${SHOT_DURATION_RANGE.min}–${SHOT_DURATION_RANGE.max} 秒`);
    else if (!Number.isInteger(shot.duration)) warnings.push(`${label}时长 ${shot.duration} 秒不是整数`);
    const content = contentSeconds(shot);
    if (shot.duration >= SHOT_DURATION_RANGE.min && content.estimate + DIALOGUE_GAP_SECONDS < shot.duration) {
      warnings.push(`${label}内容偏少：台词约 ${content.spoken.toFixed(1)} 秒 + ${content.actions} 个动作点 ≈ ${content.estimate.toFixed(1)} 秒，与标称 ${shot.duration} 秒不匹配（台词要在本镜结束前 ${DIALOGUE_GAP_SECONDS} 秒说完）。`);
    }
  }
  if (declared === shots.length) {
    if (total < TOTAL_DURATION_RANGE.min) issues.push(`总时长 ${total} 秒，需补到 ${TOTAL_DURATION_RANGE.min}–${TOTAL_DURATION_RANGE.max} 秒`);
    else if (total > TOTAL_DURATION_RANGE.max) issues.push(`总时长 ${total} 秒，需压到 ${TOTAL_DURATION_RANGE.min}–${TOTAL_DURATION_RANGE.max} 秒`);
  }
  // 镜号连续：软提示。镜号乱了不影响时长校验，但导演步骤靠它对位。
  const numbered = shots.filter(shot => shot.number !== undefined);
  if (numbered.length && numbered.length !== shots.length) warnings.push('有镜头没写镜号，建议每镜都写【镜头N：景别】并连续编号。');
  else if (numbered.length) {
    const numbers = numbered.map(shot => shot.number as number);
    const continuous = numbers.every((number, index) => number === index + 1);
    if (!continuous) warnings.push(`镜号不连续（${numbers.join('、')}），请按 1 到 ${numbers.length} 连续编号。`);
  }
  // 自检行：模型自己写的合计与各镜之和对不上时提醒。
  const selfCheck = (source || '').match(/合计\s*(\d+(?:\.\d+)?)\s*秒/);
  if (selfCheck && declared === shots.length && Number(selfCheck[1]) !== total) {
    warnings.push(`自检行写的合计 ${selfCheck[1]} 秒，与各镜时长之和 ${total} 秒不一致。`);
  }
  return { shots, total, issues, warnings };
}

/**
 * 重试提示词：只贴违规清单与上一版剧本，不重发整套模板。
 * 带上上一版剧本是因为模型得看见自己写的东西才知道要改哪一段。
 */
export function buildRetryPrompt(result: ShotSpecResult, screenplay: string): string {
  const lines = [
    '上一次输出的剧本没有通过「镜数与时长」校验。请只重写《标准漫剧剧本》正文部分，按下面的清单逐条修正；其余部分（核心前提、节拍表、世界观）保持原样。',
    '',
    '【需要修正的问题】',
    ...result.issues.map(issue => `- ${issue}`),
    '',
    '【修正要求】',
    `- 镜数必须是 ${SHOT_COUNT_RANGE.min}–${SHOT_COUNT_RANGE.max} 镜，镜号从 1 连续编号。`,
    `- 每镜第一行写镜头标记与显式时长，格式：【镜头1：远景】（时长12s）。单镜 ${SHOT_DURATION_RANGE.min}–${SHOT_DURATION_RANGE.max} 秒，总时长 ${TOTAL_DURATION_RANGE.min}–${TOTAL_DURATION_RANGE.max} 秒。`,
    '- 每镜的内容要写够时长：正常对白按 5–6 字/秒，一镜 10 秒至少约 50 字台词，或写 6–7 个动作点（每点约 1.5 秒）。',
    '- 台词要在本镜结束前至少 0.3 秒说完。',
    '- 末尾加一行时长自检，写明各镜时长与合计；合计必须等于各镜之和。',
    '- 只输出剧本本身，不要解释。',
    '',
    '【上一次输出的剧本】',
    screenplay.trim(),
  ];
  return lines.join('\n');
}

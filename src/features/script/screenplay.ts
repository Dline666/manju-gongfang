// 剧本正文的读取：标题 / 主线兜底、对白池、场数、台词时长估算。
// 这里不再解析镜头——分镜由导演步骤调大模型结构化产出，
// 前端不用正则去猜剧本该怎么切镜。
import { parseSceneHead } from '../../lib/prompts';

const DIALOGUE_LINE = /^\s*([^\s（(【△][^（(【△：:]{0,24}?)\s*(?:（([^）]{0,24})）)?\s*[：:]\s*(.+)$/;
const SKIP_LINE = /^\s*(?:#{1,6}\s|\*\*|---+\s*$|>\s)/;
const QUOTES = /^[“"「『](.*)[”"」』]\s*$/;
const DURATION = /（\s*时长\s*([\d.]+)\s*s?\s*）/;
/** 剧本里的时长标记（「（时长3s）」），演练排时长时按它算。 */
export const DURATION_MARK = DURATION;
const SCENE_HEAD = /^\s*#{2,4}\s*场景\s*\d+\s*(.*)$/;
/** 剧本里为某一镜指定的画面类型，如「【镜头：远景】」。 */
export const CAMERA_MARK = /^\s*【镜头\s*[：:]\s*(.+?)\s*】\s*$/;
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
 * 先剥「（时长3s）」这类标记，再剥引号——顺序反了会把标记留在台词里。
 */
export function parseDialogueLine(line: string): ScreenplayLine | undefined {
  if (SKIP_LINE.test(line)) return undefined;
  const match = line.match(DIALOGUE_LINE);
  if (!match) return undefined;
  const body = match[3].replace(DURATION, '').trim();
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
  return line.replace(DURATION, '').replace(/^\s*△\s*/, '').trim();
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

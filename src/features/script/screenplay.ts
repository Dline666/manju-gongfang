// 剧本解析：把「标准漫剧剧本」Markdown 拆成场景与镜头块。
// 纯函数，不依赖项目数据，便于单测。
import type { Shot } from '../../domain/types';
import { parseSceneHead } from '../../lib/prompts';

const CAMERA_MARK = /^\s*【镜头\s*[：:]\s*(.+?)\s*】\s*$/;
const SCENE_HEAD = /^\s*#{2,4}\s*场景\s*(\d+)\s*(.*)$/;
const DURATION = /（\s*时长\s*([\d.]+)\s*s?\s*）/;
const ACTION_LINE = /^\s*△\s*(.+)$/;
const DIALOGUE_LINE = /^\s*([^\s（(【△][^（(【△：:]{0,24}?)\s*(?:（([^）]{0,24})）)?\s*[：:]\s*(.+)$/;
const SKIP_LINE = /^\s*(?:#{1,6}\s|\*\*|---+\s*$|>\s)/;
const QUOTES = /^[“"「『](.*)[”"」』]\s*$/;

export interface ScreenplayScene {
  index: number;
  head: string;
  kind: string;
  place: string;
  time: string;
  summary: string;
  characters: string[];
}

export interface ScreenplayDialogue {
  speaker: string;
  emotion: string;
  text: string;
  seconds: number;
}

export interface ScreenplayBlock {
  cameraHint: string;
  sceneIndex: number;
  actions: string[];
  dialogues: ScreenplayDialogue[];
  seconds: number;
}

export interface ParsedScreenplay {
  title: string;
  logline: string;
  scenes: ScreenplayScene[];
  blocks: ScreenplayBlock[];
  /** 没有【镜头：类型】标记、按段落降级拆出来的。 */
  degraded: boolean;
}

/** 单块台词时长估算：按漫剧语速表（1–5字→1秒 … 21–35字→3.5–5秒）折算。 */
export function estimateDialogueSeconds(text: string): number {
  const length = text.replace(/[，。！？、；：""''「」…—·]/g, '').length;
  if (length <= 0) return 0;
  if (length <= 5) return 1;
  if (length <= 12) return 1.5;
  if (length <= 20) return 2.5;
  if (length <= 35) return 3.5;
  return 5;
}

function stripDuration(line: string): { text: string; seconds: number } {
  const match = line.match(DURATION);
  const seconds = match ? Number(match[1]) : 0;
  const text = (match ? line.slice(0, match.index) : line).trim();
  return { text, seconds };
}

/** 场景头拆成内外景 / 地点 / 时间三段；资产提取按空间归组时复用。 */
export { parseSceneHead };

/**
 * 解析剧本。场景以「### 场景N」开头，镜头以「【镜头：类型】」分块。
 * 场景之前的段落（核心前提、钩子、节拍表、世界观）不产生镜头。
 * 提示词由用户自己写，模型不一定照约定输出：没有【镜头：类型】时按段落降级拆镜。
 */
export function parseScreenplay(source: string): ParsedScreenplay {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const hasSceneHead = lines.some(line => SCENE_HEAD.test(line));
  const strict = parseStrict(lines, hasSceneHead);
  if (strict.blocks.length) return strict;
  return parseLoose(lines, hasSceneHead);
}

function makeScene(index: number, head: string): ScreenplayScene {
  const { kind, place, time } = parseSceneHead(head);
  return { index, head: head.trim(), kind, place, time, summary: '', characters: [] };
}

function parseStrict(lines: string[], hasSceneHead: boolean): ParsedScreenplay {
  const scenes: ScreenplayScene[] = [];
  const blocks: ScreenplayBlock[] = [];
  // 一个场景头都没有时，整篇当作一个场景，【镜头：】标记照样能拆出镜头。
  let current: ScreenplayScene | undefined = hasSceneHead ? undefined : makeScene(1, '');
  if (current) scenes.push(current);
  let block: ScreenplayBlock | undefined;

  const closeBlock = () => { block = undefined; };
  // 每个【镜头：】标记都是一次独立镜头：同一类型连续出现也保留切点，不合并。
  const ensureBlock = (cameraHint: string) => {
    if (!current) return undefined;
    block = { cameraHint, sceneIndex: current.index, actions: [], dialogues: [], seconds: 0 };
    blocks.push(block);
    return block;
  };

  for (const line of lines) {
    const sceneMatch = line.match(SCENE_HEAD);
    if (sceneMatch) {
      current = makeScene(Number(sceneMatch[1]), sceneMatch[2]);
      scenes.push(current);
      closeBlock();
      continue;
    }
    if (!current) continue;
    const summaryMatch = line.match(/^\s*\*\*剧情[：:]\*\*(.*)$/);
    if (summaryMatch) { current.summary = summaryMatch[1].trim(); continue; }
    const charactersMatch = line.match(/^\s*\*\*人物[：:]\*\*(.*)$/);
    if (charactersMatch) { current.characters = charactersMatch[1].split(/[、,，\/]/).map(item => item.trim()).filter(Boolean); continue; }
    if (SKIP_LINE.test(line)) continue;
    const cameraMatch = line.match(CAMERA_MARK);
    if (cameraMatch) { ensureBlock(cameraMatch[1].trim()); continue; }
    if (!block) continue;
    const actionMatch = line.match(ACTION_LINE);
    if (actionMatch) {
      const { text: body, seconds } = stripDuration(actionMatch[1]);
      if (body) block.actions.push(body);
      block.seconds += seconds || 1.5;
      continue;
    }
    const dialogueMatch = line.match(DIALOGUE_LINE);
    if (dialogueMatch) {
      const { text: body, seconds } = stripDuration(dialogueMatch[3]);
      const quoted = body.match(QUOTES);
      const spoken = (quoted ? quoted[1] : body).trim();
      if (!spoken) continue;
      block.dialogues.push({ speaker: dialogueMatch[1].trim(), emotion: (dialogueMatch[2] || '').trim(), text: spoken, seconds: seconds || estimateDialogueSeconds(spoken) });
      block.seconds += seconds || estimateDialogueSeconds(spoken);
      continue;
    }
    const { text: body, seconds } = stripDuration(line);
    if (body && /[。！？，、]/.test(body)) { block.actions.push(body); block.seconds += seconds || 1.5; }
  }
  return { title: '', logline: '', scenes, blocks, degraded: false };
}

/**
 * 降级拆镜：模型没写【镜头：类型】时，按场景分组、再按自然段切镜。
 * 只有含动作行（△）或台词行的段落才算镜头；纯说明段落不产生镜头。
 */
function parseLoose(lines: string[], hasSceneHead: boolean): ParsedScreenplay {
  const scenes: ScreenplayScene[] = [];
  const blocks: ScreenplayBlock[] = [];
  const buckets: { scene: ScreenplayScene; lines: string[] }[] = [];
  let current: ScreenplayScene | undefined;
  let pending: string[] = [];
  const flush = () => { if (current) buckets.push({ scene: current, lines: pending }); pending = []; };

  for (const line of lines) {
    const sceneMatch = line.match(SCENE_HEAD);
    if (sceneMatch) {
      flush();
      current = makeScene(Number(sceneMatch[1]), sceneMatch[2]);
      scenes.push(current);
      continue;
    }
    if (!current) {
      if (hasSceneHead) continue;          // 场景头之前的内容不产生镜头
      current = makeScene(1, '');          // 一个场景头都没有：整篇当一个场景
      scenes.push(current);
    }
    pending.push(line);
  }
  flush();

  for (const bucket of buckets) {
    for (const paragraph of splitParagraphs(bucket.lines)) {
      const entry = looseBlock(paragraph, bucket.scene.index);
      if (entry) blocks.push(entry);
    }
  }
  return { title: '', logline: '', scenes, blocks, degraded: blocks.length > 0 };
}

function splitParagraphs(lines: string[]): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (!line.trim()) { if (current.length) paragraphs.push(current); current = []; continue; }
    current.push(line);
  }
  if (current.length) paragraphs.push(current);
  return paragraphs;
}

function looseBlock(paragraph: string[], sceneIndex: number): ScreenplayBlock | undefined {
  const actions: string[] = [];
  const dialogues: ScreenplayDialogue[] = [];
  let seconds = 0;
  let hasContent = false;
  for (const line of paragraph) {
    if (SKIP_LINE.test(line)) continue;
    if (/^\s*\*\*(剧情|人物)[：:]/.test(line)) continue;
    const actionMatch = line.match(ACTION_LINE);
    if (actionMatch) {
      const { text: body, seconds: marked } = stripDuration(actionMatch[1]);
      if (body) { actions.push(body); hasContent = true; seconds += marked || 1.5; }
      continue;
    }
    const dialogueMatch = line.match(DIALOGUE_LINE);
    if (dialogueMatch) {
      const { text: body, seconds: marked } = stripDuration(dialogueMatch[3]);
      const quoted = body.match(QUOTES);
      const spoken = (quoted ? quoted[1] : body).trim();
      if (!spoken) continue;
      const spokenSeconds = marked || estimateDialogueSeconds(spoken);
      dialogues.push({ speaker: dialogueMatch[1].trim(), emotion: (dialogueMatch[2] || '').trim(), text: spoken, seconds: spokenSeconds });
      hasContent = true; seconds += spokenSeconds;
      continue;
    }
    const { text: body, seconds: marked } = stripDuration(line);
    if (body) { actions.push(body); seconds += marked || 1.5; }
  }
  if (!hasContent) return undefined;
  return { cameraHint: '', sceneIndex, actions, dialogues, seconds: seconds || 3 };
}

/** 从剧本里取章节名与核心前提，作为 title / logline 的兜底。 */
export function readScreenplayMeta(source: string): { title: string; logline: string } {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const chapter = text.match(/^\s*#{1,4}\s*(第[一二三四五六七八九十百零〇\d]+\s*章[^\n]*)$/m);
  const premise = text.match(/【核心前提】\s*\n?\s*(.+)/);
  return { title: chapter ? chapter[1].trim() : '', logline: premise ? premise[1].trim() : '' };
}

/** 镜头块 → Shot；说话人先只记名字，等提取或手动建人物后再关联资产 ID。 */
export function blocksToShots(parsed: ParsedScreenplay, resolveSpeaker: (name: string) => string, makeId: (index: number) => string = index => `shot_${index + 1}`): Shot[] {
  return parsed.blocks.map((entry, index) => {
    const scene = parsed.scenes.find(item => item.index === entry.sceneIndex);
    const dialogues = entry.dialogues.map(line => ({ id: `d${index}_${line.speaker}`, speakerId: '', speaker: resolveSpeaker(line.speaker), text: line.text }));
    const visual = entry.actions.join(' ');
    const head = scene ? scene.head : '';
    return {
      id: makeId(index),
      number: index + 1,
      duration: Math.max(0.5, Math.round(entry.seconds * 2) / 2),
      visual: head ? `【${head}】${visual}` : visual,
      camera: '', start: '', action: '', end: '',
      dialogues,
      assetIds: [],
      references: [],
      audioMode: 'original',
      title: head,
      scene: head,
      cameraHint: entry.cameraHint,
    };
  });
}

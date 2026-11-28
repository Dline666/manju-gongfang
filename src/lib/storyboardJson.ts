/**
 * 分镜 JSON：本产品唯一的落地入口。
 *
 * 聊天室负责产出 JSON，导入器负责校验并转成镜头/资产。任何其它建内容的路径都应当被删掉，
 * 所以这里的校验必须严：宁可在导入时明确报错第几镜哪个字段，也不要让半成品进到库里。
 *
 * 校验规则（对应执行提示词的第四、五节）：
 * - 纯 JSON：拒绝 Markdown 围栏与前后解释文字，并把拒绝原因说清楚；
 * - 必填字段齐全；`shots` 4–6 镜；
 * - `duration` 0.5–30 秒（提示词要求 10–15 秒，但改时长校验不在本次范围，见第八节）；
 * - 下一镜 `start` 必须等于上一镜 `end`；
 * - 台词结束时间不得晚于该镜结束前 0.3 秒；
 * - `assetId` 引用必须存在于顶层登记，缺失时从镜头引用与文本里补齐并标明「补齐项」。
 */
import { uid, type Asset, type AssetKind, type Dialogue, type Shot } from '../domain/types';

export const SHOT_SIZES_ENUM = ['远景', '全景', '中景', '近景', '特写'] as const;
export const MOVEMENTS_ENUM = ['固定', '推', '拉', '摇', '移', '跟', '升降', '环绕'] as const;
export const ANGLES_ENUM = ['平视', '俯视', '仰视'] as const;
export const ROLES_ENUM = ['subject', 'background', 'prop'] as const;
export const ASSET_KINDS: AssetKind[] = ['character', 'scene', 'prop'];

/** 单镜时长硬边界（秒）。 */
export const MIN_DURATION = 0.5;
export const MAX_DURATION = 30;
/** 提示词要求的单镜时长区间；本期只用于提示，不用于阻断（第八节）。 */
export const SUGGESTED_MIN_DURATION = 10;
export const SUGGESTED_MAX_DURATION = 15;
/** 新规则：4–6 镜。 */
export const MIN_SHOTS = 4;
export const MAX_SHOTS = 6;
/** 台词必须在镜头结束前这么久的余量说完。 */
export const DIALOGUE_TAIL = 0.3;

export type StoryboardJsonShotAsset = { assetId: string; role: 'subject' | 'background' | 'prop' };
export interface StoryboardJsonDialogue { speaker: string; text: string; emotion?: string }
export interface StoryboardJsonEndState { space?: string; positions?: string; light?: string; props?: string; emotion?: string }
export interface StoryboardJsonShot {
  number: number; title?: string; scene: string; sceneId?: string; visual: string; duration: number;
  shotSize: string; movement: string; angle: string;
  start: string; action: string; end: string;
  assets?: StoryboardJsonShotAsset[];
  dialogues?: StoryboardJsonDialogue[];
  endState?: StoryboardJsonEndState;
}
export interface StoryboardJsonAsset { assetId: string; kind: AssetKind; name: string; description: string }
export interface StoryboardJson { title?: string; assets?: StoryboardJsonAsset[]; shots: StoryboardJsonShot[] }

/** 一条校验问题。镜号 0 表示整份 JSON 层面的问题。 */
export interface ImportIssue { shot: number; field: string; message: string }

const FENCE = /^\s*(?:```|~~~)/m;
const LEADING_NOISE = /^\s*[\[{]/;

/**
 * 把模型返回的文本变成对象。
 *
 * 拒绝三种常见脏输出：Markdown 围栏、前后解释文字、以及根本不是 JSON。
 * 报错都指向「请把整段回复精简为纯 JSON」，因为用户能改的只有这一步。
 */
export function parseStoryboardJsonText(text: string): { ok: true; value: unknown } | { ok: false; issue: ImportIssue } {
  const raw = text.replace(/^\uFEFF/, '').trim();
  if (!raw) return { ok: false, issue: { shot: 0, field: 'json', message: '内容为空，没有可导入的 JSON。' } };
  if (FENCE.test(raw)) return { ok: false, issue: { shot: 0, field: 'json', message: '检测到 Markdown 代码围栏（```）。分镜 JSON 必须是纯 JSON，请去掉围栏后重新导入。' } };
  if (!LEADING_NOISE.test(raw)) return { ok: false, issue: { shot: 0, field: 'json', message: '这段内容不是以 { 或 [ 开头，前面可能还有解释文字。分镜 JSON 必须是纯 JSON，不能带任何前后说明。' } };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    return { ok: false, issue: { shot: 0, field: 'json', message: `JSON 解析失败${detail ? `：${detail}` : '。'}请检查是否缺少逗号、引号或括号。` } };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * 校验并转成镜头与资产。
 *
 * 成功后返回：可直接写入一集的 assets / shots，以及「补齐项」清单——
 * 模型漏写顶层 assets 时，从各镜引用和文本里汇总出来的条目都要如实告诉用户补齐了什么。
 */
export interface ImportResult {
  assets: Asset[];
  shots: Shot[];
  /** 模型漏写、由导入器补出来的资产 id。 */
  filledAssets: string[];
  /** 台词没在剧本对白池里逐字命中的条数（有 screenplay 时才统计）。 */
  dialogueMismatches: number;
  /** 引用了顶层登记里没有、又补不出描述的 assetId。 */
  unknownAssetIds: string[];
  title?: string;
}

export type ImportOutcome =
  | { ok: true; result: ImportResult }
  | { ok: false; issues: ImportIssue[] };

/** 允许单条导入失败：收集全部问题一起报，用户一次就能改完。 */
export function validateStoryboardJson(input: unknown, options: { screenplay?: string } = {}): ImportOutcome {
  const issues: ImportIssue[] = [];
  const data = record(input);
  const rows = data.shots;
  if (!Array.isArray(rows) || !rows.length) {
    return { ok: false, issues: [{ shot: 0, field: 'shots', message: '缺少 shots 数组，或它是空的。至少要 4 镜。' }] };
  }
  if (rows.length < MIN_SHOTS || rows.length > MAX_SHOTS) {
    issues.push({ shot: 0, field: 'shots', message: `共 ${rows.length} 镜，必须是 ${MIN_SHOTS}–${MAX_SHOTS} 镜。` });
  }

  // 顶层资产登记：按 assetId 去重，后出现的同 id 条目不覆盖先出现的固定描述。
  const registry = new Map<string, StoryboardJsonAsset>();
  const filledAssets = new Set<string>();
  for (const entry of Array.isArray(data.assets) ? data.assets : []) {
    const item = record(entry);
    const assetId = text(item.assetId).trim();
    if (!assetId) continue;
    const kind = text(item.kind).trim() as AssetKind;
    if (!ASSET_KINDS.includes(kind)) continue;
    if (registry.has(assetId)) continue;
    registry.set(assetId, { assetId, kind, name: text(item.name).trim() || assetId, description: text(item.description).trim() });
  }

  const usedIds = new Set<string>();
  const shots: Shot[] = [];
  const sceneSeen = new Set<string>();
  let dialogueMismatches = 0;
  const unknownAssetIds = new Set<string>();

  rows.forEach((value, index) => {
    const raw = record(value);
    const number = index + 1;
    const scene = text(raw.scene).trim();
    const visual = text(raw.visual).trim();
    const start = text(raw.start).trim();
    const action = text(raw.action).trim();
    const end = text(raw.end).trim();
    const shotSize = text(raw.shotSize).trim();
    const movement = text(raw.movement).trim();
    const angle = text(raw.angle).trim();

    if (!scene) issues.push({ shot: number, field: 'scene', message: `第${number}镜缺少 scene（场景名）。` });
    if (!visual) issues.push({ shot: number, field: 'visual', message: `第${number}镜缺少 visual（画面描述）。` });
    if (!start) issues.push({ shot: number, field: 'start', message: `第${number}镜缺少 start（开场状态）。` });
    if (!action) issues.push({ shot: number, field: 'action', message: `第${number}镜缺少 action（动作）。` });
    if (!end) issues.push({ shot: number, field: 'end', message: `第${number}镜缺少 end（终点状态）。` });
    if (!(SHOT_SIZES_ENUM as readonly string[]).includes(shotSize)) issues.push({ shot: number, field: 'shotSize', message: `第${number}镜的 shotSize「${shotSize || '空'}」不在枚举内（${SHOT_SIZES_ENUM.join(' / ')}）。` });
    if (!(MOVEMENTS_ENUM as readonly string[]).includes(movement)) issues.push({ shot: number, field: 'movement', message: `第${number}镜的 movement「${movement || '空'}」不在枚举内（${MOVEMENTS_ENUM.join(' / ')}）。` });
    if (!(ANGLES_ENUM as readonly string[]).includes(angle)) issues.push({ shot: number, field: 'angle', message: `第${number}镜的 angle「${angle || '空'}」不在枚举内（${ANGLES_ENUM.join(' / ')}）。` });

    const duration = typeof raw.duration === 'number' ? raw.duration : Number(text(raw.duration));
    if (!Number.isFinite(duration)) {
      issues.push({ shot: number, field: 'duration', message: `第${number}镜的 duration 不是数字。` });
    } else if (duration < MIN_DURATION || duration > MAX_DURATION) {
      issues.push({ shot: number, field: 'duration', message: `第${number}镜的 duration 为 ${duration} 秒，必须在 ${MIN_DURATION}–${MAX_DURATION} 秒之间。` });
    }

    // 连续性：下一镜 start 必须等于上一镜 end。
    if (index > 0) {
      const previous = record(rows[index - 1]);
      const previousEnd = text(previous.end).trim();
      if (previousEnd && end && previousEnd && start && previousEnd !== start) {
        issues.push({ shot: number, field: 'start', message: `第${number}镜的 start 与第${index}镜的 end 不一致。上一镜终点：「${previousEnd}」，本镜开场：「${start}」。` });
      }
    }

    // 台词：说话人必填、正文必填；时长合计 + 0.3 秒余量不得超过本镜时长。
    const dialogues: Dialogue[] = [];
    const lines = Array.isArray(raw.dialogues) ? raw.dialogues : [];
    let speechSeconds = 0;
    lines.forEach((entry, lineIndex) => {
      const line = record(entry);
      const speaker = text(line.speaker).trim();
      const body = text(line.text).trim();
      if (!speaker) issues.push({ shot: number, field: `dialogues[${lineIndex}].speaker`, message: `第${number}镜第${lineIndex + 1}条台词缺少 speaker。` });
      if (!body) issues.push({ shot: number, field: `dialogues[${lineIndex}].text`, message: `第${number}镜第${lineIndex + 1}条台词正文为空。` });
      if (body) speechSeconds += estimateSpeechSeconds(body);
      dialogues.push({ id: uid(), speakerId: '', speaker, text: body });
    });
    if (Number.isFinite(duration) && duration > 0 && speechSeconds > 0 && speechSeconds + DIALOGUE_TAIL > duration) {
      issues.push({
        shot: number, field: 'dialogues',
        message: `第${number}镜台词约需 ${speechSeconds.toFixed(1)} 秒，加 ${DIALOGUE_TAIL} 秒余量已超过本镜 ${duration} 秒。请缩短台词或加长镜头。`,
      });
    }

    // 资产引用：必须能在顶层登记里找到；找不到就登记为待补齐。
    // 正规写法是 assets:[{assetId,role}]；模型偶尔缩写成 assetIds:['id']，这里一并认下，
    // 否则整镜资产会静默丢掉（资产库空着，生成视频时才报「没写固定描述」）。
    const assetIds: string[] = [];
    const subjects: string[] = [];
    const rawRefs: unknown[] = [
      ...(Array.isArray(raw.assets) ? raw.assets : []),
      ...(Array.isArray(raw.assetIds) ? raw.assetIds.map(assetId => ({ assetId })) : []),
    ];
    for (const entry of rawRefs) {
      const item = record(entry);
      const assetId = text(item.assetId).trim();
      if (!assetId) continue;
      const role = text(item.role).trim();
      if (role && !(ROLES_ENUM as readonly string[]).includes(role)) {
        issues.push({ shot: number, field: 'assets.role', message: `第${number}镜资产 ${assetId} 的 role「${role}」不在枚举内（${ROLES_ENUM.join(' / ')}）。` });
      }
      if (!registry.has(assetId)) {
        unknownAssetIds.add(assetId);
        filledAssets.add(assetId);
        registry.set(assetId, inferAsset(assetId, raw, scene));
      }
      usedIds.add(assetId);
      if (!assetIds.includes(assetId)) assetIds.push(assetId);
      if (role === 'subject' && !subjects.includes(assetId)) subjects.push(assetId);
    }
    // 场景：给了 sceneId 就登记成场景资产，保证场景描述能进资产库。
    const sceneId = text(raw.sceneId).trim();
    if (sceneId) {
      if (!registry.has(sceneId)) {
        registry.set(sceneId, { assetId: sceneId, kind: 'scene', name: scene || sceneId, description: scene });
        filledAssets.add(sceneId);
      }
      const entry = registry.get(sceneId)!;
      if (entry.kind === 'scene' && !sceneSeen.has(sceneId)) {
        // 同名场景只登记一次；场景资产默认带上场景名作为固定描述的开头。
        if (!entry.description) entry.description = scene;
        sceneSeen.add(sceneId);
      }
      if (!assetIds.includes(sceneId)) assetIds.push(sceneId);
    }

    const endState = record(raw.endState);
    shots.push({
      id: uid(),
      number,
      duration: Number.isFinite(duration) ? Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(duration * 2) / 2)) : SUGGESTED_MIN_DURATION,
      visual,
      camera: `${shotSize}·${movement}·${angle}`,
      start, action, end,
      dialogues,
      assetIds,
      references: [],
      audioMode: 'original',
      ...(subjects.length ? { subjects } : {}),
      ...(text(raw.title).trim() ? { title: text(raw.title).trim() } : {}),
      ...(scene ? { scene } : {}),
      cameraHint: '',
      // endState 是给视频提示词用的连续性锁；存成一段结构化文本，不引入新字段。
      ...(hasEndState(endState) ? { continuity: formatEndState(endState) } : {}),
    } as Shot);
  });

  // 对白核对：剧本里逐字有的台词用剧本原文（哪怕模型改了标点）；没命中的计数交给用户核对。
  // 同一句台词可能在多镜重复出现（复读、回响），所以先用未匹配过的行，
  // 再用已匹配过的行兜底——否则第二遍出现的同一句会被误判成「对不上」。
  const pool = options.screenplay ? buildDialoguePool(options.screenplay) : [];
  if (pool.length) {
    const used = new Set<number>();
    for (const shot of shots) {
      for (const line of shot.dialogues) {
        const target = normalize(line.text);
        if (!target) continue;
        let index = pool.findIndex((entry, i) => !used.has(i) && normalize(entry.text) === target);
        if (index < 0) index = pool.findIndex(entry => normalize(entry.text) === target);
        if (index >= 0) {
          used.add(index);
          line.text = pool[index].text;
          if (pool[index].speaker) line.speaker = pool[index].speaker;
        } else {
          dialogueMismatches++;
        }
      }
    }
  }

  if (issues.length) return { ok: false, issues };

  const assets: Asset[] = [...registry.values()].map(entry => ({
    id: entry.assetId,
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
    lock: entry.description,
  }));
  // 说话人按名字挂到人物资产上，视频提示词才写得出人名。
  const byName = new Map<string, string>();
  for (const asset of assets.filter(item => item.kind === 'character')) byName.set(asset.name, asset.id);
  for (const shot of shots) for (const line of shot.dialogues) {
    if (line.speaker && byName.has(line.speaker)) line.speakerId = byName.get(line.speaker)!;
  }

  return {
    ok: true,
    result: {
      assets, shots,
      filledAssets: [...filledAssets].filter(id => usedIds.has(id) || registry.get(id)?.kind === 'scene'),
      dialogueMismatches,
      unknownAssetIds: [...unknownAssetIds],
      ...(text(data.title).trim() ? { title: text(data.title).trim() } : {}),
    },
  };
}

function hasEndState(value: Record<string, unknown>): boolean {
  return ['space', 'positions', 'light', 'props', 'emotion'].some(key => text(value[key]).trim() !== '');
}
function formatEndState(value: Record<string, unknown>): string {
  const parts: string[] = [];
  if (text(value.space).trim()) parts.push(`空间：${text(value.space).trim()}`);
  if (text(value.positions).trim()) parts.push(`位置：${text(value.positions).trim()}`);
  if (text(value.light).trim()) parts.push(`光线：${text(value.light).trim()}`);
  if (text(value.props).trim()) parts.push(`道具：${text(value.props).trim()}`);
  if (text(value.emotion).trim()) parts.push(`情绪：${text(value.emotion).trim()}`);
  return parts.join('；');
}

/**
 * 补齐一条模型漏登记的资产。
 *
 * 只推断得出品类，不编造长相：描述留空并标记「待补齐」，
 * 这样用户能立刻在剧集资产模块里补写固定描述，而不是被一段假描述锁死。
 */
function inferAsset(assetId: string, shot: Record<string, unknown>, scene: string): StoryboardJsonAsset {
  const lower = assetId.toLowerCase();
  if (lower.startsWith('char') || lower.startsWith('person') || lower.startsWith('role')) {
    return { assetId, kind: 'character', name: assetId.replace(/^char[-_]?/i, '') || assetId, description: '' };
  }
  if (lower.startsWith('scene')) return { assetId, kind: 'scene', name: scene || assetId, description: scene };
  if (lower.startsWith('prop') || lower.startsWith('item')) return { assetId, kind: 'prop', name: assetId.replace(/^prop[-_]?/i, '') || assetId, description: '' };
  return { assetId, kind: 'character', name: assetId, description: text(shot.visual).trim() };
}

/** 中文台词时长估算：与 screenplay 的语速表一致。 */
function estimateSpeechSeconds(textValue: string): number {
  const length = textValue.replace(/[，。！？、；：""''「」…—·]/g, '').length;
  if (length <= 0) return 0;
  if (length <= 5) return 1;
  if (length <= 12) return 1.5;
  if (length <= 20) return 2.5;
  if (length <= 35) return 3.5;
  return 5;
}
function normalize(value: string): string {
  return value.replace(/[\s，。！？、；：,.!?;:"'“”「」『』…—·（）()【】]/g, '');
}
function buildDialoguePool(screenplay: string): { speaker: string; text: string }[] {
  const pool: { speaker: string; text: string }[] = [];
  for (const line of screenplay.split('\n')) {
    const match = line.match(/^\s*([^\s（(【△][^（(【△：:]{0,24}?)\s*(?:（[^）]{0,24}）)?\s*[：:]\s*(.+)$/);
    if (!match) continue;
    const body = match[2].replace(/（\s*时长\s*[\d.]+\s*s?\s*）/g, '').trim();
    const quoted = body.match(/^[“"「『](.*)[”"」』]\s*$/);
    pool.push({ speaker: match[1].trim(), text: (quoted ? quoted[1] : body).trim() });
  }
  return pool;
}

/** 解析结果表用：给用户导入前确认的概览。 */
export interface ImportPreview {
  assetsByKind: Record<AssetKind, number>;
  shots: { number: number; duration: number; dialogues: number; assets: number }[];
  totalDuration: number;
  filledAssets: string[];
  unknownAssetIds: string[];
}

export function previewImport(result: ImportResult): ImportPreview {
  const assetsByKind: Record<AssetKind, number> = { character: 0, scene: 0, prop: 0, voice: 0 };
  for (const asset of result.assets) assetsByKind[asset.kind] += 1;
  return {
    assetsByKind,
    shots: result.shots.map(shot => ({ number: shot.number, duration: shot.duration, dialogues: shot.dialogues.length, assets: shot.assetIds.length })),
    totalDuration: result.shots.reduce((total, shot) => total + shot.duration, 0),
    filledAssets: result.filledAssets,
    unknownAssetIds: result.unknownAssetIds,
  };
}
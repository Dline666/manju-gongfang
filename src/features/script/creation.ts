import { uid, type Asset, type Dialogue, type Project, type Shot } from '../../domain/types';
import { cleanScreenplayLine, estimateDialogueSeconds, normalizeDialogue, parseDialogueLine, readScreenplayMeta, screenplayDialoguePool, screenplaySceneName, type ScreenplayLine } from './screenplay';
import { ACTION_LINE, CAMERA_MARK, SHOT_SIZES } from './screenplay';

const shotHeading = /^\s*(?:#{1,6}\s*)?(?:第\s*[\d一二三四五六七八九十百零〇]+\s*镜(?:头)?|(?:镜头|分镜|SHOT)\s*[\d一二三四五六七八九十百零〇]+)(?=$|[\s:：、.．（(\-—])/i;

export interface GeneratedScript {
  title?: string;
  characters?: { name: string; description: string }[];
  scenes?: { name: string; description: string }[];
  props?: { name: string; description: string }[];
  shots: { visual: string; camera: string; start: string; action: string; end: string; duration: number; dialogues: { speaker: string; text: string }[]; characters?: string[]; scenes?: string[]; props?: string[] }[];
}
export interface GeneratedScreenplay {
  title?: string;
  logline?: string;
  /** 完整剧本正文（Markdown）；镜头由它解析得到，模型不再另报一份镜头清单。 */
  screenplay: string;
}
export interface ScriptDraft { title?: string; logline?: string; screenplay?: string; assets: Asset[]; shots: Shot[] }
const text = (value: unknown) => typeof value === 'string' ? value : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};


export function mergeDraftAssets(existing: Asset[], draft: ScriptDraft): ScriptDraft {
  const assets = [...existing]; const ids = new Map<string, string>();
  for (const asset of draft.assets) {
    const found = assets.find(a => a.kind === asset.kind && a.name === asset.name);
    if (found) {
      ids.set(asset.id, found.id);
      // 同名资产保留它自己的固定短语（用户手改过的不被模型覆盖），只有空白占位才补上。
      const blank = !found.description.trim() && !found.lock.trim();
      if (blank) assets[assets.indexOf(found)] = { ...found, description: asset.description, lock: asset.lock, ...(asset.aliases?.length ? { aliases: asset.aliases } : {}) };
    } else assets.push(asset);
  }
  // 台词按名字认领人物资产：重新生成剧本后，说话人仍能挂回已建的人物。
  const byName = new Map(assets.filter(a => a.kind === 'character').map(a => [a.name, a.id]));
  return { ...draft, assets, shots: draft.shots.map(shot => ({ ...shot,
    assetIds: [...new Set(shot.assetIds.map(id => ids.get(id) || id))],
    references: shot.references.map(r => ({ ...r, assetId: ids.get(r.assetId) || r.assetId })),
    dialogues: shot.dialogues.map(d => ({ ...d, speakerId: ids.get(d.speakerId) || d.speakerId || byName.get((d.speaker || '').trim()) || '' })),
  })) };
}

export function extractLocalAssets(shots: Shot[], existing: Asset[]): ScriptDraft {
  const assets = [...existing];
  const kinds = { 人物: 'character', 角色: 'character', 场景: 'scene', 道具: 'prop' } as const;
  const add = (kind: Asset['kind'], entry: string) => {
    const value = entry.replace(/\*\*/g, '').trim();
    if (!value || /^(?:无|无道具|无人物|无场景|无关|待补充|未指定)$/.test(value)) return;
    const match = value.match(/^([^：:,，。；;]{1,40})\s*[:：,，]\s*(.+)$/);
    const name = (match?.[1] || value).trim();
    if (name.length > 40 || (!match && /[。；;]/.test(name))) return;
    if (!assets.some(a => a.kind === kind && a.name === name)) {
      const description = match?.[2] || name;
      assets.push({ id: uid(), kind, name, description, lock: description });
    }
  };
  for (const shot of shots) {
    let section: Asset['kind'] | undefined;
    for (const raw of shot.visual.split('\n')) {
      const line = raw.replace(/^\s*(?:#{1,6}\s*|[-*]\s*)?/, '').replace(/\*\*/g, '').trim();
      const group = line.match(/^(人物|角色|场景|道具)(?:清单|设定)?\s*[:：]?$/);
      if (group) { section = kinds[group[1] as keyof typeof kinds]; continue; }
      const inline = line.match(/^(人物|角色|场景|道具)(?:清单|设定)?\s*[:：]\s*(.+)$/);
      if (inline) { add(kinds[inline[1] as keyof typeof kinds], inline[2]); section = undefined; }
      else if (section && /^[^：:]{1,40}[:：]/.test(line) && !/^(画面|开场|动作|终点|运镜|台词|时长)[:：]/.test(line)) add(section, line);
      else if (line) section = undefined;
    }
  }
  return { assets, shots: shots.map(shot => {
    const lines = shot.visual.split('\n'); const start = lines.findIndex(line => shotHeading.test(line));
    const content = [(start >= 0 ? lines.slice(start).join('\n') : shot.visual), shot.start, shot.action, shot.end].join('\n');
    return { ...shot, assetIds: [...new Set([...shot.assetIds, ...assets.filter(a => a.kind !== 'voice' && (content.includes(a.name) || shot.dialogues.some(d => (d.speaker || '').trim() === a.name))).map(a => a.id)])] };
  }) };
}


/**
 * 剧本步骤顺带产出的资产：人物 / 场景 / 道具各一份。
 *
 * 模型给的 id 直接沿用 —— 分镜步骤要按 id 引用资产，id 必须跨调用稳定。
 * id 缺失或组内重复时用「品类前缀 + 序号」兜底。
 * 同名同类的已有资产保留它自己的 id 与固定短语（用户手改过的固定短语不被模型覆盖），
 * 只有仍是空白占位的才补上。
 */
const screenplayAssetKinds = { characters: 'character', scenes: 'scene', props: 'prop' } as const;
type ScreenplayAssetKind = keyof typeof screenplayAssetKinds;

export function screenplayAssets(input: unknown): { assets: Asset[]; warnings: string[] } {
  const data = record(input);
  const group = record(data.assets);
  const assets: Asset[] = [];
  const warnings: string[] = [];
  const usedIds = new Set<string>();
  for (const [key, kind] of Object.entries(screenplayAssetKinds) as [ScreenplayAssetKind, Asset['kind']][]) {
    const list = group[key];
    if (!Array.isArray(list)) continue;
    const prefix = kind === 'character' ? 'c' : kind === 'scene' ? 's' : 'p';
    let seq = 0;
    for (const value of list) {
      const item = record(value);
      const name = text(item.name).trim();
      const lock = text(item.lock).trim();
      if (!name || !lock) { warnings.push(`${kind === 'character' ? '人物' : kind === 'scene' ? '场景' : '道具'}资产缺名称或固定短语，已跳过。`); continue; }
      let id = text(item.id).trim();
      if (!id || usedIds.has(id)) { seq++; id = `${prefix}${seq}`; }
      while (usedIds.has(id)) { seq++; id = `${prefix}${seq}`; }
      usedIds.add(id);
      const aliases = text(item.aliases).split(/[，,、;；]/).map(item => item.trim()).filter(Boolean);
      const description = text(item.description).trim();
      assets.push({ id, kind, name, description: description || lock, lock, ...(aliases.length ? { aliases } : {}) });
    }
  }
  return { assets, warnings };
}

/**
 * 剧本步骤的产出：一份剧本正文 + 顺带带出的三类资产。
 * 镜头由导演步骤调大模型结构化产出，这里不拆镜。
 */
export function normalizeScreenplay(input: unknown): ScriptDraft {
  const data = record(input);
  const screenplay = text(data.screenplay).trim();
  if (!screenplay) throw new Error('生成结果没有剧本正文，未覆盖现有剧本。');
  const meta = readScreenplayMeta(screenplay);
  const { assets } = screenplayAssets(data);
  return {
    title: text(data.title).trim() || meta.title || undefined,
    logline: text(data.logline).trim() || meta.logline || undefined,
    screenplay, assets, shots: [],
  };
}

/**
 * 资产步骤的提取结果：沿用已有资产的 ID 与固定短语，只补全仍是空白的占位描述；
 * 逐镜关联只允许指向本次声明过的资产，引用不存在的名称直接报错，不静默丢弃。
 */
/**
 * 资产提取按品类分开：人物、场景、道具各自一次调用、各自一份清单。
 * 这里只处理本类的清单与本类逐镜关联，其它品类的资产与关联完全不碰。
 * 同名同类的已有资产保留原固定短语（模型描述被忽略），只有仍是空白占位的才补全。
 */
import type { ExtractCategory } from '../../lib/prompts';
export type { ExtractCategory };
const extractCategoryKeys = { character: 'characters', scene: 'scenes', prop: 'props' } as const;
const extractCategoryLabels = { character: '人物', scene: '场景', prop: '道具' } as const;

export function applyCategoryExtraction(project: Project, input: unknown, category: ExtractCategory): ScriptDraft {
  const key = extractCategoryKeys[category];
  const label = extractCategoryLabels[category];
  const data = record(input);
  const list = data[key];
  if (!Array.isArray(list)) throw new Error(`${label}提取结果不完整，未修改现有资产。`);
  const warnings: string[] = [];
  const assets: Asset[] = [...project.assets];
  const declared = new Map<string, Asset>();
  for (const value of list) {
    const item = record(value);
    const name = text(item.name).trim();
    const description = text(item.description).trim();
    if (!name || !description) throw new Error(`${label}名称或固定描述为空，未修改现有资产。`);
    const found = assets.find(asset => asset.kind === category && asset.name === name);
    if (found) {
      const blank = !found.description.trim() && !found.lock.trim();
      if (!blank) { declared.set(name, found); continue; }
      const upgraded: Asset = { ...found, description, lock: description };
      assets[assets.indexOf(found)] = upgraded;
      declared.set(name, upgraded);
    } else {
      const asset: Asset = { id: uid(), kind: category, name, description, lock: description };
      assets.push(asset);
      declared.set(name, asset);
    }
  }
  // 逐镜关联是可选的：模型没按提示词要求返回时，缺失就按无关联写入，跳过的问题条目计数提示，不整单拒绝。
  const rawRows = Array.isArray(data.shots) ? data.shots : [];
  if (!Array.isArray(data.shots)) warnings.push(`模型没有返回逐镜关联，本次只写入${label}清单。`);
  const byNumber = new Map<number, string[]>();
  let badRows = 0;
  let unknownRefs = 0;
  for (const value of rawRows) {
    const row = record(value);
    if (typeof row.number !== 'number' || !project.shots.some(shot => shot.number === row.number)) { badRows++; continue; }
    const refs = row[key];
    if (!Array.isArray(refs)) { badRows++; continue; }
    const ids: string[] = [];
    for (const raw of refs) {
      const name = text(raw).trim();
      const asset = declared.get(name);
      if (!asset) { unknownRefs++; continue; }
      ids.push(asset.id);
    }
    byNumber.set(row.number, ids);
  }
  const missing = project.shots.filter(shot => !byNumber.has(shot.number)).map(shot => shot.number);
  if (missing.length) warnings.push(`第 ${missing.join('、')} 镜没有返回${label}关联。`);
  if (badRows) warnings.push(`跳过 ${badRows} 条镜号无效或格式不对的关联。`);
  if (unknownRefs) warnings.push(`跳过 ${unknownRefs} 条引用了未声明${label}的关联。`);
  const characterIds = new Map(assets.filter(a => a.kind === 'character').map(a => [a.name, a.id]));
  const shots = project.shots.map(shot => {
    const ids = byNumber.get(shot.number) ?? [];
    // 人物提取完成后，台词按名字挂到对应的人物资产上。
    const dialogues = category === 'character'
      ? shot.dialogues.map(d => {
        const name = (d.speaker || '').trim();
        const id = d.speakerId && assets.some(a => a.id === d.speakerId) ? d.speakerId : characterIds.get(name);
        return id && id !== d.speakerId ? { ...d, speakerId: id } : d;
      })
      : shot.dialogues;
    return { ...shot, assetIds: [...new Set([...shot.assetIds, ...ids])], dialogues };
  });
  // 说明：不再提示「以下说话人还没有对应的人物资产」——剧本里的说话人是按冒号切出来的，
  // 常常不是人物名，这种清单既吵又给不出可靠的下一步。没挂上的台词保持原样，用户可以在资产页自行处理。
  return { assets, shots, ...(warnings.length ? { warnings } : {}) };
}

export interface GeneratedDirector {
  shots: {
    number: number; title?: string; scene: string; sceneId?: string; visual: string; duration: number;
    shotSize: string; movement: string; angle: string; start: string; action: string; end: string;
    dialogues?: { speaker: string; text: string; emotion?: string }[];
    assets?: { assetId: string; role?: 'subject' | 'background' | 'prop' }[];
  }[];
}

export interface DirectorResult { shots: Shot[]; mismatches: number; unknownAssets: number }

/** 在剧本对白池里找同一句话：先按说话人找，再退回只按文本找。 */
function matchDialogue(pool: ScreenplayLine[], used: Set<number>, speaker: string, body: string): { index: number; speaker: string; text: string } | undefined {
  const target = normalizeDialogue(body);
  if (!target) return undefined;
  const sameSpeaker = pool.findIndex((line, index) => !used.has(index) && normalizeDialogue(line.speaker) === normalizeDialogue(speaker) && normalizeDialogue(line.text) === target);
  if (sameSpeaker >= 0) return { index: sameSpeaker, ...pool[sameSpeaker] };
  const anySpeaker = pool.findIndex((line, index) => !used.has(index) && normalizeDialogue(line.text) === target);
  if (anySpeaker >= 0) return { index: anySpeaker, ...pool[anySpeaker] };
  return undefined;
}

/**
 * 导演步骤的产出：按模型返回的分镜脚本重建镜头列表。
 *
 * 镜数由模型按剧本内容决定，与既有镜头无关——重跑就是整体替换。
 * 对白必须逐字来自剧本：拿剧本对白池核对，命中就用剧本原文（哪怕模型改了标点），
 * 没命中的保留模型文本并计数，交给用户核对。
 * 资产由剧本步骤建好，模型按 id 引用：引用不存在的 id 丢掉并计数；
 * 说话人按名字挂到人物资产上（代称也算）。
 */
export function normalizeDirector(input: unknown, project: Project): DirectorResult {
  const data = record(input);
  const rows = data.shots;
  if (!Array.isArray(rows) || !rows.length) throw new Error('导演分镜没有返回任何镜头，未覆盖现有内容。');
  const pool = screenplayDialoguePool(project.screenplay || '');
  const used = new Set<number>();
  const knownAssets = new Map(project.assets.map(asset => [asset.id, asset]));
  // 人物按名字与代称认领：说话人挂到人物资产上，视频提示词才写得出人名。
  const characterByName = new Map<string, string>();
  for (const asset of project.assets.filter(item => item.kind === 'character')) {
    characterByName.set(asset.name, asset.id);
    for (const alias of asset.aliases ?? []) if (alias.trim()) characterByName.set(alias.trim(), asset.id);
  }
  let mismatches = 0;
  let unknownAssets = 0;
  const shots = rows.map((value, index) => {
    const raw = record(value);
    const scene = text(raw.scene).trim();
    const visual = text(raw.visual).trim();
    const start = text(raw.start).trim();
    const action = text(raw.action).trim();
    const end = text(raw.end).trim();
    const shotSize = text(raw.shotSize).trim();
    const movement = text(raw.movement).trim();
    const angle = text(raw.angle).trim();
    if (!scene || !visual) throw new Error(`第${index + 1}镜缺少场景或画面。`);
    if (!shotSize || !movement || !angle) throw new Error(`第${index + 1}镜缺少景别、运镜或机位。`);
    if (!start || !action || !end) throw new Error(`第${index + 1}镜缺少开场、动作或终点。`);
    const duration = typeof raw.duration === 'number' && Number.isFinite(raw.duration) && raw.duration > 0
      ? Math.min(30, Math.round(raw.duration * 2) / 2) : 3;
    // 本镜在场的资产：模型按资产清单里的 id 引用。引用不存在的 id 丢掉并计数，不整单拒绝。
    const assetIds: string[] = [];
    const subjects: string[] = [];
    for (const entry of Array.isArray(raw.assets) ? raw.assets : []) {
      const item = record(entry);
      const assetId = text(item.assetId).trim();
      if (!assetId || !knownAssets.has(assetId)) { unknownAssets++; continue; }
      if (!assetIds.includes(assetId)) assetIds.push(assetId);
      if (text(item.role).trim() === 'subject' && !subjects.includes(assetId)) subjects.push(assetId);
    }
    // 场景引用：给了有效的场景资产 id 就把它算进本镜在场，场景描述才和资产库对得上。
    const sceneId = text(raw.sceneId).trim();
    if (sceneId && knownAssets.has(sceneId) && !assetIds.includes(sceneId)) assetIds.push(sceneId);
    const dialogues = (Array.isArray(raw.dialogues) ? raw.dialogues : []).map(entry => {
      const line = record(entry);
      const speaker = text(line.speaker).trim() || '未指定人物';
      const body = text(line.text).trim();
      const hit = matchDialogue(pool, used, speaker, body);
      const name = hit ? hit.speaker : speaker;
      const speakerId = characterByName.get(name) ?? characterByName.get(name.trim()) ?? '';
      if (hit) { used.add(hit.index); return { id: uid(), speakerId, speaker: hit.speaker, text: hit.text }; }
      mismatches++;
      return { id: uid(), speakerId, speaker, text: body };
    });
    return {
      id: uid(), number: index + 1, duration,
      visual, camera: `${shotSize}·${movement}·${angle}`,
      start, action, end,
      dialogues, assetIds, references: [], audioMode: 'original' as const,
      ...(subjects.length ? { subjects } : {}),
      title: text(raw.title).trim() || undefined,
      scene, cameraHint: '',
    };
  });
  return { shots, mismatches, unknownAssets };
}

/**
 * 模板演练：不用模型，按剧本自己的结构排出一版镜头。
 *
 * 这不是「自动拆镜」——剧本生成后什么都不做，只有人主动点这一下才会排。
 * 排法很死：剧本里写了【镜头：类型】就一段一镜，没写就一段（空行分段）一镜；
 * 场景名取最近的一个「### 场景N」；时长取剧本里的「（时长Ns）」，没有就按台词长度估。
 * 排出来的每一镜照样能在页面上手改，改完就是正式分镜。
 */
export function rehearseShots(source: string): Shot[] {
  const raw = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const paragraphs = raw.split(/\n[ \t]*\n+/);
  const hasScene = paragraphs.some(paragraph => paragraph.split('\n').some(line => screenplaySceneName(line) !== undefined));
  const beats: { scene: string; mark: string; lines: string[] }[] = [];
  let scene = '';
  let seenScene = false;
  for (const paragraph of paragraphs) {
    const content: string[] = [];
    let mark = '';
    for (const line of paragraph.split('\n').map(item => item.trim()).filter(Boolean)) {
      const name = screenplaySceneName(line);
      if (name !== undefined) { scene = name; seenScene = true; continue; }
      // 场景之前是「核心前提 / 节拍表」这类结构说明，不是戏，排不进镜头。
      if (hasScene && !seenScene) continue;
      if (/^\s*(?:#{1,6}\s|\*\*|---+\s*$|>\s)/.test(line)) continue;
      const marked = line.match(CAMERA_MARK);
      if (marked) { mark = marked[1].trim(); continue; }
      content.push(line);
    }
    if (!content.length) continue;
    beats.push({ scene: scene || '未标注场景', mark, lines: content });
  }
  return beats.map((beat, index) => buildRehearsedShot(beat, index));
}

/** 把「【镜头：远景】」这类标记翻译成景别 / 运镜 / 机位。 */
function cameraFromMark(mark: string): { size: string; movement: string; angle: string } {
  const text = mark.trim();
  let size = '';
  for (const candidate of SHOT_SIZES) if (text.includes(candidate)) { size = candidate; break; }
  let movement = '';
  if (text.includes('跟')) movement = '跟';
  else if (text.includes('环')) movement = '环绕';
  else if (text.includes('升') || text.includes('降')) movement = '升降';
  else if (text.includes('推')) movement = '推';
  else if (text.includes('拉')) movement = '拉';
  else if (text.includes('摇')) movement = '摇';
  else if (text.includes('移')) movement = '移';
  let angle = '';
  if (text.includes('俯')) angle = '俯视';
  else if (text.includes('仰')) angle = '仰视';
  return { size: size || '中景', movement: movement || '固定', angle: angle || '平视' };
}

const clampDuration = (value: number) => Math.max(0.5, Math.min(30, Math.round(value * 2) / 2));

/** 时长：剧本写了「（时长3s）」就照抄，段落里多个就加起来；没写就按台词长度估一个。 */
function rehearseDuration(lines: string[], dialogues: Dialogue[]): number {
  let total = 0;
  for (const match of lines.join('\n').match(/（\s*时长\s*([\d.]+)\s*s?\s*）/g) || []) {
    const value = Number(match.replace(/[^\d.]/g, ''));
    if (Number.isFinite(value)) total += value;
  }
  if (total > 0) return clampDuration(total);
  const spoken = dialogues.reduce((sum, line) => sum + estimateDialogueSeconds(line.text), 0);
  return clampDuration(Math.max(3, spoken + 1));
}

function buildRehearsedShot(beat: { scene: string; mark: string; lines: string[] }, index: number): Shot {
  const actionLines: string[] = [];
  const proseLines: string[] = [];
  const dialogueLines: string[] = [];
  const body: string[] = [];
  const dialogues: Dialogue[] = [];
  for (const line of beat.lines) {
    const action = line.match(ACTION_LINE);
    const spoken = parseDialogueLine(line);
    const cleaned = cleanScreenplayLine(line);
    if (action) actionLines.push(cleaned);
    else if (spoken) {
      dialogues.push({ id: uid(), speakerId: '', speaker: spoken.speaker, text: spoken.text });
      dialogueLines.push(cleaned);
    } else proseLines.push(cleaned);
    body.push(cleaned);
  }
  const visual = (actionLines.length ? actionLines : proseLines.length ? proseLines : dialogueLines).join('\n');
  const camera = cameraFromMark(beat.mark);
  return {
    id: uid(), number: index + 1,
    duration: rehearseDuration(beat.lines, dialogues),
    visual,
    camera: `${camera.size}·${camera.movement}·${camera.angle}`,
    start: body[0] || visual,
    action: (actionLines.length ? actionLines : proseLines.length ? proseLines : body).join('\n'),
    end: body[body.length - 1] || visual,
    dialogues, assetIds: [], references: [], audioMode: 'original' as const,
    scene: beat.scene, cameraHint: beat.mark,
  };
}

export function templateScript(theme: string): ScriptDraft {
  const subject = theme.trim();
  if (!subject) throw new Error('请先输入主题，再生成模板草稿。');
  const place = '故事发生地';
  const screenplay = `# 第一部分｜核心前提

【核心前提】
主题「${subject}」：主角要拿到答案，代价是交出唯一能证明自己的东西；拿不到就失去留下来的资格。

【黄金3秒钩子】
类型：反常细节
开场画面：
△ 主角停在门口不动，门缝里的光一寸一寸暗下去。
△ 守门人手里的钥匙停在半空，没有递出。

【三幕结构】
- **第一幕｜铺垫建立（30%）**：主角拿到线索，却拿不到门。
- **第二幕｜核心冲突危机（50%）**：主角绕开正门，代价是暴露自己。
- **第三幕｜转折爆发与卡点（20%）**：门开了，门后的人却是主角自己。

【结尾卡点】
门后站着另一个主角，手里握着同一把钥匙——到底谁才是真的。

# 第二部分｜场景因果节拍表

| 场次 | 场景目标 | 遭遇阻碍 | 升级行动 | 意外转折 | 不可逆新局面 |
|---|---|---|---|---|---|
| 1 | 让主角拿到线索 | 守门人拒绝交出钥匙 | 主角用旧物换钥匙 | 钥匙背面刻着主角的名字 | 守门人开始提防主角 |
| 2 | 让主角打开门 | 门后站着另一个自己 | 主角没有后退 | 另一个主角先开口 | 主角的身份彻底动摇 |

# 第三部分｜世界观与人物关系确认

【世界边界】
- 时代：模板演练用的架空时代。
- 体系：线索靠交换获得，不靠抢夺。
- 核心禁忌：同一把钥匙不能被两个人同时持有。

【人物关系】
- 主角：唯一持有线索的人，不轻易交出旧物。
- 守门人：看门的执行者，听命于规矩，不看人情。

# 第四部分｜标准漫剧剧本

## 第一章  模板演练

### 场景1 外景 · ${place} — 清晨

**剧情：**主角求线索，守门人拿规矩挡回去。
**人物：**主角、守门人

【镜头：远景】
△ 晨光斜切过石阶，主角站在门外三步远的地方，没有再往前。（时长3s）

【镜头：中景】
守门人（冷淡）：“规矩如此，钥匙不能给你。”（时长2s）

【镜头：特写】
△ 守门人掌心里的钥匙旧得发黑，齿口磨平了一半。（时长1.5s）

【镜头：近景】
△ 主角的目光落在钥匙上，肩膀松了一寸，又绷回去。（时长1.5s）

【镜头：中景】
主角（平静）：“那我拿别的换。”（时长1.5s）

【镜头：特写】
△ 守门人抬起眼，钥匙在指间转了半圈。（时长1s）

【镜头：特写】
△ 钥匙背面刻着一个字，和主角胸口的旧牌一模一样。（时长2s）

【镜头：近景】
守门人（迟疑）：“这钥匙……你从哪来的。”（时长2s）

### 场景2 内景 · 门前石室 — 正午

**剧情：**主角换到钥匙，门后站着另一个自己。
**人物：**主角、守门人

【镜头：中景】
△ 主角把旧牌按进门侧的凹槽，石门向内滑开一道缝。（时长3s）

【镜头：跟拍】
△ 主角侧身挤进门缝，石室里的光比外面暗。（时长2s）

【镜头：远景】
△ 石室正中立着一个人，背对门口，轮廓与主角一模一样。（时长3s）

【镜头：特写】
△ 那人转过身，手里握着同一把钥匙。（时长2s）

【镜头：近景】
那人（平静）：“你来晚了。”（时长1.5s）

【镜头：俯拍】
△ 主角僵在门口，手里的旧牌掉在地上。（时长2s）

**卡点。**
`;
  // 模板演练只产出剧本：不预置人物资产，镜头由导演步骤结构化，资产由资产步骤提取。
  return normalizeScreenplay({ title: `${subject.slice(0, 24)} · 模板演练`, logline: subject, screenplay });
}

/**
 * 导入剧本：原文就是剧本正文，镜头留给导演步骤结构化。
 * 不在这里建资产——资产由资产步骤从镜头里提取，避免同一批资产出现两份。
 */
export function parseScriptText(input: string): ScriptDraft {
  const source = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!source.trim()) throw new Error('请输入或上传剧本文本。');
  const meta = readScreenplayMeta(source);
  return { title: meta.title || undefined, logline: meta.logline || undefined, screenplay: source, assets: [], shots: [] };
}

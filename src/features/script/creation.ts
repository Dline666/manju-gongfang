import { makeShot, uid, type Asset, type Project, type Shot } from '../../domain/types';
import { blocksToShots, parseScreenplay, readScreenplayMeta } from './screenplay';

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
export interface ScriptDraft { title?: string; logline?: string; screenplay?: string; assets: Asset[]; shots: Shot[]; notes?: string[] }
const text = (value: unknown) => typeof value === 'string' ? value : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};


export function mergeDraftAssets(existing: Asset[], draft: ScriptDraft): ScriptDraft {
  const assets = [...existing]; const ids = new Map<string, string>();
  for (const asset of draft.assets) {
    const found = assets.find(a => a.kind === asset.kind && a.name === asset.name);
    if (found) ids.set(asset.id, found.id);
    else assets.push(asset);
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
 * 把模型返回的剧本解析成剧本层镜头：剧本是唯一事实来源，镜头由剧本拆出来，
 * 不再让模型另外报一份镜头清单。camera/start/action/end 留给导演步骤。
 * 这一步不产出任何资产：台词只记下说话人名字，人物资产等提取或手动创建后再关联。
 */
export function normalizeScreenplay(input: unknown): ScriptDraft {
  const data = record(input);
  const screenplay = text(data.screenplay).trim();
  if (!screenplay) throw new Error('生成结果没有剧本正文，未覆盖现有剧本。');
  const parsed = parseScreenplay(screenplay);
  if (!parsed.blocks.length) throw new Error('剧本里没有找到可拆镜的内容（既没有【镜头：…】标记，也没有带动作或台词的段落）；现有剧本未被覆盖。');
  const shots = blocksToShots(parsed, name => name.trim() || '未知人物', () => uid());
  const meta = readScreenplayMeta(screenplay);
  const notes = parsed.degraded ? [`未检测到【镜头：类型】标记，已按段落降级拆镜（${shots.length} 镜）。`] : [];
  return {
    title: text(data.title).trim() || meta.title || undefined,
    logline: text(data.logline).trim() || meta.logline || undefined,
    screenplay, assets: [], shots, ...(notes.length ? { notes } : {}),
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
  shots: { number: number; shotSize: string; movement: string; angle: string; start: string; action: string; end: string }[];
}

/** 把导演输出合并回现有镜头：只改运镜与开场/动作/终点，剧情和时长不动。 */
export function normalizeDirector(input: unknown, project: Project): Shot[] {
  const data = record(input);
  if (!Array.isArray(data.shots) || data.shots.length !== project.shots.length) throw new Error('导演分镜数量与剧本镜头数不一致，未覆盖现有内容。');
  const byNumber = new Map(project.shots.map(shot => [shot.number, shot]));
  const seen = new Set<number>();
  const rows = data.shots.map(value => {
    const raw = record(value);
    const number = raw.number;
    if (typeof number !== 'number' || !Number.isInteger(number) || !byNumber.has(number) || seen.has(number)) throw new Error('导演分镜镜号无效或重复，未覆盖现有内容。');
    seen.add(number);
    const shotSize = text(raw.shotSize).trim(); const movement = text(raw.movement).trim(); const angle = text(raw.angle).trim();
    const start = text(raw.start).trim(); const action = text(raw.action).trim(); const end = text(raw.end).trim();
    if (!shotSize || !movement || !angle) throw new Error(`第${number}镜缺少景别、运镜或机位。`);
    if (!start || !action || !end) throw new Error(`第${number}镜缺少开场、动作或终点。`);
    return { ...byNumber.get(number)!, camera: `${shotSize}·${movement}·${angle}`, start, action, end };
  });
  const updated = new Map(rows.map(row => [row.number, row]));
  return project.shots.map(shot => updated.get(shot.number) ?? shot);
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
  // 模板演练只产出剧本与镜头：不预置人物资产，资产由提取或手动创建产生。
  return normalizeScreenplay({ title: `${subject.slice(0, 24)} · 模板演练`, logline: subject, screenplay });
}

export function parseScriptText(input: string): ScriptDraft {
  const source = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!source.trim()) throw new Error('请输入或上传剧本文本。');
  if (/【镜头\s*[：:]/.test(source)) {
    const parsed = parseScreenplay(source);
    if (!parsed.blocks.length) throw new Error('剧本里没有找到【镜头：…】标记，拆不出镜头。');
    const shots = blocksToShots(parsed, name => name.trim() || '未知人物', () => uid());
    const meta = readScreenplayMeta(source);
    // 剧本里显式写出的资产清单行（人物：X：描述）才建资产；说话人只留名字。
    const assets = extractLocalAssets(shots, []).assets;
    return { title: meta.title || undefined, logline: meta.logline || undefined, screenplay: source, assets, shots };
  }
  const lines = source.split('\n');
  const heading = shotHeading;
  const starts = lines.flatMap((line, i) => heading.test(line) ? [i] : []);
  const blocks = starts.length
    ? starts.map((start, i) => lines.slice(i === 0 ? 0 : start, starts[i + 1] ?? lines.length).join('\n'))
    : source.split(/\n\s*\n+/).filter(block => block.trim());
  const assets = extractLocalAssets([{ ...makeShot(1), visual: source }], []).assets;
  const getSpeaker = (name: string) => name.trim() || '旁白';
  const shots = blocks.map((block, index) => {
    const shot = makeShot(index + 1);
    // Keep every source line in visual, even unrecognised metadata and preambles.
    shot.visual = block;
    const headingLine = block.split('\n').find(line => heading.test(line));
    const duration = block.match(/^\s*(?:[-*]\s*)?(?:时长|duration)\s*[:：]\s*(-?\d+(?:\.\d+)?)/mi)
      || headingLine?.match(/(-?\d+(?:\.\d+)?)\s*(?:秒|s)(?=$|[\s）)·|])/i);
    if (duration) shot.duration = Number(duration[1]);
    const field = (labels: string) => block.match(new RegExp(`^\\s*(?:[-*]\\s*)?(?:${labels})\\s*[:：]\\s*(.*)$`, 'mi'))?.[1] ?? '';
    shot.start = field('开场|起点|开始|start'); shot.end = field('终点|结尾|结束|end');
    shot.action = field('动作|action'); shot.camera = field('运镜|镜头运动|camera') || shot.camera;
    let dialogueSection = false;
    for (const line of block.split('\n')) {
      const label = line.match(/^\s*(?:[-*]\s*)?(?:台词|对白|dialogue)\s*[:：]\s*(.*)$/i);
      if (label) dialogueSection = !label[1].trim();
      const explicit = label?.[1] || (dialogueSection ? line : '');
      const dialogue = explicit.match(/^\s*(?:[-*]\s*)?([^:：\n]{1,40})\s*[:：]\s*(.+)$/);
      const quoted = line.match(/^\s*([^:：\n]{1,30})\s*[:：]\s*[“「"](.+)[”」"]\s*$/);
      const match = dialogue || quoted;
      if (match && !/^(?:画面|开场|起点|终点|动作|运镜|时长|风格|镜头|备注|visual|start|end|action|camera|duration)$/i.test(match[1].trim())) {
        shot.dialogues.push({ id: uid(), speakerId: '', speaker: getSpeaker(match[1]), text: match[2] });
      } else if (label?.[1]?.trim() && !/^(?:无|无对白|无台词)$/.test(label[1].trim())) {
        shot.dialogues.push({ id: uid(), speakerId: '', speaker: getSpeaker('旁白'), text: label[1] });
      } else if (line.trim() && !label) dialogueSection = false;
    }
    return shot;
  });
  return extractLocalAssets(shots, assets);
}

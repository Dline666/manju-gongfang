import { makeShot, uid, type Asset, type Project, type Shot } from '../../domain/types';

const assetLists = [{ key: 'characters', kind: 'character' }, { key: 'scenes', kind: 'scene' }, { key: 'props', kind: 'prop' }] as const;
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
  characters?: { name: string; description: string }[];
  scenes?: { name: string; description: string }[];
  props?: { name: string; description: string }[];
  beats: { title: string; scene: string; characters?: string[]; summary: string; dialogues: { speaker: string; text: string }[]; seconds: number }[];
}
export interface ScriptDraft { title?: string; assets: Asset[]; shots: Shot[] }
const text = (value: unknown) => typeof value === 'string' ? value : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function readAssetLists(data: Record<string, unknown>): Asset[] {
  return assetLists.flatMap(({ key, kind }) => {
    const list = data[key];
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > 30) throw new Error(`${key}资产清单格式无效。`);
    const names = new Set<string>();
    return list.map(value => {
      const item = record(value); const name = text(item.name).trim(); const description = text(item.description);
      if (!name || names.has(name) || !description.trim()) throw new Error('资产名称或固定描述为空，或同类资产重名。');
      names.add(name);
      return { id: uid(), kind, name, description, lock: description };
    });
  });
}
function readAssetReferences(raw: Record<string, unknown>, assets: Asset[]): string[] {
  return assetLists.flatMap(({ key, kind }) => {
    const names = raw[key];
    if (names === undefined) return [];
    if (!Array.isArray(names) || names.length > 30) throw new Error(`分镜${key}关联格式无效。`);
    return names.map(name => {
      const asset = assets.find(a => a.kind === kind && a.name === text(name).trim());
      if (!asset) throw new Error(`分镜引用了未声明的${key}资产：${text(name)}`);
      return asset.id;
    });
  });
}

export function mergeDraftAssets(existing: Asset[], draft: ScriptDraft): ScriptDraft {
  const assets = [...existing]; const ids = new Map<string, string>();
  for (const asset of draft.assets) {
    const found = assets.find(a => a.kind === asset.kind && a.name === asset.name);
    if (found) ids.set(asset.id, found.id);
    else assets.push(asset);
  }
  return { ...draft, assets, shots: draft.shots.map(shot => ({ ...shot,
    assetIds: [...new Set(shot.assetIds.map(id => ids.get(id) || id))],
    references: shot.references.map(r => ({ ...r, assetId: ids.get(r.assetId) || r.assetId })),
    dialogues: shot.dialogues.map(d => ({ ...d, speakerId: ids.get(d.speakerId) || d.speakerId })),
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
    return { ...shot, assetIds: [...new Set([...shot.assetIds, ...assets.filter(a => a.kind !== 'voice' && (content.includes(a.name) || shot.dialogues.some(d => d.speakerId === a.id))).map(a => a.id)])] };
  }) };
}

export function applyAssetExtraction(project: Project, input: unknown): ScriptDraft {
  const data = record(input);
  if (!assetLists.every(({ key }) => Array.isArray(data[key])) || !Array.isArray(data.shots) || data.shots.length !== project.shots.length) throw new Error('资产提取结果不完整，未修改现有分镜。');
  const assets = readAssetLists(data); const seen = new Set<number>();
  const rows = data.shots.map(value => {
    const row = record(value);
    if (typeof row.number !== 'number' || seen.has(row.number) || !project.shots.some(s => s.number === row.number) || !assetLists.every(({ key }) => Array.isArray(row[key]))) throw new Error('资产提取镜号或三类关联无效。');
    seen.add(row.number);
    return { number: row.number, ids: readAssetReferences(row, assets) };
  });
  return mergeDraftAssets(project.assets, { assets, shots: project.shots.map(shot => ({ ...shot, assetIds: [...new Set([...shot.assetIds, ...rows.find(row => row.number === shot.number)!.ids])] })) });
}

export function normalizeScript(input: unknown): ScriptDraft {  const data = record(input);
  if (!Array.isArray(data.shots) || !data.shots.length) throw new Error('生成结果没有有效镜头，未覆盖现有剧本。');
  const assets = readAssetLists(data);
  const byName = new Map(assets.filter(a => a.kind === 'character').map(a => [a.name, a]));
  const character = (name: string, description = '') => {
    name = name.trim() || '旁白';
    let asset = byName.get(name);
    if (!asset) {
      const detail = description || `${name}，外观设定待完善`;
      asset = { id: uid(), kind: 'character', name, description: detail, lock: detail };
      byName.set(name, asset); assets.push(asset);
    }
    return asset;
  };
  const shots = data.shots.map((value, index) => {
    const raw = record(value);
    if (typeof raw.duration !== 'number' || !Number.isFinite(raw.duration) || raw.duration < 4 || raw.duration > 15) throw new Error(`第${index + 1}镜时长无效，需要4–15秒。`);
    if (!text(raw.visual).trim()) throw new Error(`第${index + 1}镜缺少画面，未覆盖现有剧本。`);
    if (raw.dialogues !== undefined && !Array.isArray(raw.dialogues)) throw new Error(`第${index + 1}镜台词结构无效。`);
    const dialogues = (Array.isArray(raw.dialogues) ? raw.dialogues : []).map(value => {
      const d = record(value);
      if (!text(d.text).trim()) throw new Error(`第${index + 1}镜包含空台词。`);
      return { id: uid(), speakerId: character(text(d.speaker)).id, text: text(d.text) };
    });
    return { ...makeShot(index + 1), duration: raw.duration, visual: text(raw.visual), camera: text(raw.camera), start: text(raw.start), action: text(raw.action), end: text(raw.end), dialogues, assetIds: readAssetReferences(raw, assets) };
  });
  if (shots.length !== 10 || Math.abs(shots.reduce((sum, shot) => sum + shot.duration, 0) - 90) > 0.001) throw new Error('生成结果必须为10镜、合计90秒；现有剧本未被覆盖。');
  shots.forEach((shot, index) => {
    const raw = record((data.shots as unknown[])[index]);
    const content = [shot.visual, shot.start, shot.action, shot.end].join('\n');
    shot.assetIds = [...new Set([...shot.assetIds, ...assets.filter(a => shot.dialogues.some(d => d.speakerId === a.id) || (raw[assetLists.find(list => list.kind === a.kind)!.key] === undefined && content.includes(a.name))).map(a => a.id)])];
  });
  return { title: text(data.title).trim() || undefined, assets, shots };
}

/** 把 10 节拍剧本规范化为剧本层镜头：camera/start/action/end 留给导演步骤。 */
export function normalizeScreenplay(input: unknown): ScriptDraft {
  const data = record(input);
  if (!Array.isArray(data.beats) || data.beats.length !== 10) throw new Error('生成结果必须为10个节拍；现有剧本未被覆盖。');
  const assets = readAssetLists(data);
  const byName = new Map(assets.filter(asset => asset.kind === 'character').map(asset => [asset.name, asset]));
  const character = (name: string) => {
    const clean = name.trim() || '旁白';
    let asset = byName.get(clean);
    if (!asset) {
      const detail = `${clean}，外观设定待完善`;
      asset = { id: uid(), kind: 'character', name: clean, description: detail, lock: detail };
      byName.set(clean, asset); assets.push(asset);
    }
    return asset;
  };
  const declared = (kind: Asset['kind'], name: string, index: number) => {
    const asset = assets.find(item => item.kind === kind && item.name === name);
    if (!asset) throw new Error(`第${index + 1}拍引用了未声明的${kind === 'scene' ? '场景' : '道具'}：${name}`);
    return asset.id;
  };
  const shots = data.beats.map((value, index) => {
    const beat = record(value);
    const seconds = beat.seconds;
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 4 || seconds > 15) throw new Error(`第${index + 1}拍时长无效，需要4–15秒的整数。`);
    const title = text(beat.title).trim();
    const summary = text(beat.summary).trim();
    if (!title) throw new Error(`第${index + 1}拍缺少标题。`);
    if (!summary) throw new Error(`第${index + 1}拍缺少可见事件摘要，未覆盖现有剧本。`);
    if (beat.dialogues !== undefined && !Array.isArray(beat.dialogues)) throw new Error(`第${index + 1}拍台词结构无效。`);
    const dialogues = (Array.isArray(beat.dialogues) ? beat.dialogues : []).map(line => {
      const item = record(line);
      if (!text(item.text).trim()) throw new Error(`第${index + 1}拍包含空台词。`);
      return { id: uid(), speakerId: character(text(item.speaker)).id, text: text(item.text) };
    });
    const names = (key: string) => Array.isArray(beat[key]) ? (beat[key] as unknown[]).map(item => text(item).trim()).filter(Boolean) : [];
    const assetIds = [
      ...names('characters').map(name => character(name).id),
      ...names('scenes').map(name => declared('scene', name, index)),
      ...names('props').map(name => declared('prop', name, index)),
    ];
    const scene = text(beat.scene).trim();
    return {
      ...makeShot(index + 1), duration: seconds,
      visual: `${scene ? `【${scene}】` : ''}${summary}`,
      camera: '', start: '', action: '', end: '',
      dialogues, assetIds: [...new Set(assetIds)],
    };
  });
  if (Math.abs(shots.reduce((sum, shot) => sum + shot.duration, 0) - 90) > 0.001) throw new Error('10个节拍必须合计90秒；现有剧本未被覆盖。');
  return { title: text(data.title).trim() || undefined, assets, shots };
}

export interface GeneratedDirector {
  shots: { number: number; shotSize: string; movement: string; angle: string; start: string; action: string; end: string }[];
}

/** 把导演输出合并回现有镜头：只改运镜与开场/动作/终点，剧情和时长不动。 */
export function normalizeDirector(input: unknown, project: Project): Shot[] {
  const data = record(input);
  if (!Array.isArray(data.shots) || data.shots.length !== project.shots.length) throw new Error('导演分镜数量与剧本拍数不一致，未覆盖现有内容。');
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
  const scene = '故事发生地';
  const beats: [string, string, string, string, string[]][] = [
    ['开端', '主角停在故事发生地的入口，观察环境，发现与主题有关的异象。', '事情似乎并不简单。', '主角', ['主角']],
    ['召唤', '守门人现身，向主角展示线索，线索落入主角掌心。', '答案就在前面。', '守门人', ['主角', '守门人']],
    ['出发', '主角握住线索，向目标迈步，守门人留在原地。', '我想亲眼看看。', '主角', ['主角']],
    ['阻碍', '主角面对阻碍，尝试穿过却被迫退后，单膝落地稳住身体。', '不能硬闯。', '主角', ['主角']],
    ['发现', '主角再次查看线索，注意到被忽略的细节，伸手指向细节。', '原来如此。', '主角', ['主角']],
    ['选择', '主角放下原有计划，改用新的方式接近目标，双手停在目标前方。', '这一次，我换条路。', '主角', ['主角']],
    ['逆转', '主角按照线索行动，阻碍逐渐松动，通路在主角面前打开。', '路开了。', '主角', ['主角']],
    ['高潮', '主角穿过通路，抓住即将消失的关键事物，将它护在身前。', '我不会再放手。', '守门人', ['主角', '守门人']],
    ['结果', '环境恢复平静，守门人走近主角，两人并肩站定。', '你找到了自己的答案。', '守门人', ['主角', '守门人']],
    ['余韵', '主角回望来路，随后面向新的方向，背影停留在远景中。', '故事，才刚开始。', '主角', ['主角']],
  ];
  return normalizeScreenplay({
    title: `${subject.slice(0, 24)} · 模板草稿`,
    logline: subject,
    characters: [{ name: '主角', description: '主角，深色长衣，轮廓清晰，外观细节待用户设定' }, { name: '守门人', description: '守门人，浅灰长衣，沉静姿态，外观细节待用户设定' }],
    scenes: [{ name: scene, description: '故事发生地，具体空间待人工补充' }],
    props: [{ name: '关键道具', description: '关键道具，轮廓与材质待人工设定' }],
    beats: beats.map(([title, summary, dialogue, speaker, characters]) => ({
      title, scene, characters,
      summary: `【模板演练，非AI生成】主题「${subject}」· ${title}。${summary}；具体场景与道具请人工补充。`,
      dialogues: [{ speaker, text: dialogue }], seconds: 9,
    })),
  });
}

export function parseScriptText(input: string): ScriptDraft {
  const source = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!source.trim()) throw new Error('请输入或上传剧本文本。');
  const lines = source.split('\n');
  const heading = shotHeading;
  const starts = lines.flatMap((line, i) => heading.test(line) ? [i] : []);
  const blocks = starts.length
    ? starts.map((start, i) => lines.slice(i === 0 ? 0 : start, starts[i + 1] ?? lines.length).join('\n'))
    : source.split(/\n\s*\n+/).filter(block => block.trim());
  const assets = extractLocalAssets([{ ...makeShot(1), visual: source }], []).assets;
  const getSpeaker = (name: string) => {
    const clean = name.trim() || '旁白';
    let asset = assets.find(a => a.kind === 'character' && a.name === clean);
    if (!asset) { asset = { id: uid(), kind: 'character', name: clean, description: `${clean}，导入人物，外观待完善`, lock: `${clean}，导入人物，外观待完善` }; assets.push(asset); }
    return asset.id;
  };
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
        shot.dialogues.push({ id: uid(), speakerId: getSpeaker(match[1]), text: match[2] });
      } else if (label?.[1]?.trim() && !/^(?:无|无对白|无台词)$/.test(label[1].trim())) {
        shot.dialogues.push({ id: uid(), speakerId: getSpeaker('旁白'), text: label[1] });
      } else if (line.trim() && !label) dialogueSection = false;
    }
    shot.assetIds = [...new Set(shot.dialogues.map(d => d.speakerId))];
    return shot;
  });
  return extractLocalAssets(shots, assets);
}

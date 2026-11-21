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

export function normalizeScript(input: unknown): ScriptDraft {
  const data = record(input);
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

export function templateScript(theme: string): ScriptDraft {
  const subject = theme.trim();
  if (!subject) throw new Error('请先输入主题，再生成模板草稿。');
  const beats = [
    ['开端', '主角停在故事发生地的入口', '主角观察环境，发现与主题有关的异象', '主角抬头望向异象', '事情似乎并不简单。'],
    ['召唤', '主角望向远方的异象', '守门人现身，向主角展示线索', '线索落入主角掌心', '答案就在前面。'],
    ['出发', '主角握住线索', '主角向目标迈步，守门人留在原地', '主角站在阻碍之前', '我想亲眼看看。'],
    ['阻碍', '主角面对阻碍', '主角尝试穿过阻碍，却被迫退后', '主角单膝落地稳住身体', '不能硬闯。'],
    ['发现', '主角稳住身体', '主角再次查看线索，注意到被忽略的细节', '主角伸手指向细节', '原来如此。'],
    ['选择', '主角望着线索中的细节', '主角放下原有计划，改用新的方式接近目标', '主角双手停在目标前方', '这一次，我换条路。'],
    ['逆转', '主角双手停在目标前方', '主角按照线索行动，阻碍逐渐松动', '通路在主角面前打开', '路开了。'],
    ['高潮', '通路刚刚打开', '主角穿过通路，抓住即将消失的关键事物', '主角将关键事物护在身前', '我不会再放手。'],
    ['结果', '主角护住关键事物', '环境逐渐恢复平静，守门人走近主角', '两人并肩站定', '你找到了自己的答案。'],
    ['余韵', '两人并肩站定', '主角回望来路，随后面向新的方向', '主角背影停留在远景中', '故事，才刚开始。'],
  ];
  const draft = normalizeScript({
    title: `${subject.slice(0, 24)} · 模板草稿`,
    characters: [{ name: '主角', description: '主角，深色长衣，轮廓清晰，外观细节待用户设定' }, { name: '守门人', description: '守门人，浅灰长衣，沉静姿态，外观细节待用户设定' }],
    shots: beats.map(([beat, start, action, end, dialogue], index) => ({ visual: `【模板演练，非AI生成】主题「${subject}」· ${beat}。${action}；具体场景与道具请人工补充。`, camera: index === 9 ? '缓慢拉远至远景' : index % 2 ? '中景，缓慢横移' : '近景，缓慢推进', start, action, end, duration: 9, dialogues: [{ speaker: index === 1 || index === 8 ? '守门人' : '主角', text: dialogue }] })),
  });
  return draft;
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

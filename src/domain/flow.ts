import type { Project } from './types';
import { speakerName } from './types';

export type FlowStage = 'script' | 'assets' | 'director' | 'storyboard' | 'video';
export const flowStages: FlowStage[] = ['script', 'assets', 'director', 'storyboard', 'video'];
export const flowLabels: Record<FlowStage, string> = { script: '剧本', assets: '资产', director: '导演分镜', storyboard: '分镜', video: '视频' };

export interface FlowStatus {
  script: boolean;
  assets: boolean;
  director: boolean;
  storyboard: boolean;
  video: boolean;
}

function fingerprint(value: unknown): number {
  const text = JSON.stringify(value);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  return hash;
}

/** 剧本层指纹：只包含剧本步骤负责的字段，导演字段与参考图不影响。 */
export function scriptFingerprint(project: Project): number {
  return fingerprint(project.shots.map(shot => ({
    id: shot.id, number: shot.number, visual: shot.visual, duration: shot.duration,
    dialogues: shot.dialogues.map(line => ({ speakerId: line.speakerId, speaker: line.speaker, text: line.text })),
    assetIds: shot.assetIds,
  })));
}
/** 资产层指纹：固定短语与音色绑定；图片与锁定状态不影响。 */
export function assetsFingerprint(project: Project): number {
  return fingerprint(project.assets.map(asset => ({
    id: asset.id, kind: asset.kind, name: asset.name, description: asset.description, lock: asset.lock,
    voiceAssetId: asset.voiceAssetId, voiceId: asset.voiceId, speed: asset.speed,
  })));
}
/** 导演层指纹：景别运镜与开场/动作/终点。 */
export function directorFingerprint(project: Project): number {
  return fingerprint(project.shots.map(shot => ({
    id: shot.id, number: shot.number, camera: shot.camera, start: shot.start, action: shot.action, end: shot.end,
  })));
}

export function stageStatus(project: Project): FlowStatus {
  const confirmed = project.confirmed;
  const script = confirmed?.script !== undefined ? confirmed.script === scriptFingerprint(project) : project.shots.length > 0;
  const assets = script && (confirmed?.assets !== undefined ? confirmed.assets === assetsFingerprint(project) : project.assets.length > 0);
  const director = assets && (confirmed?.director !== undefined
    ? confirmed.director === directorFingerprint(project)
    : project.shots.length > 0 && project.shots.every(shot => shot.camera.trim() && shot.start.trim() && shot.action.trim() && shot.end.trim()));
  const storyboard = director && project.storyboardReady;
  return { script, assets, director, storyboard, video: storyboard };
}

export function canEnter(project: Project, stage: FlowStage): boolean {
  if (stage === 'script') return true;
  return stageStatus(project)[stage];
}

export function stageRequirement(stage: FlowStage): FlowStage | undefined {
  return { script: undefined, assets: 'script', director: 'assets', storyboard: 'director', video: 'storyboard' }[stage] as FlowStage | undefined;
}

export function nextStage(stage: FlowStage): FlowStage | undefined {
  return flowStages[flowStages.indexOf(stage) + 1];
}

/** 确认时写入各阶段指纹；下游步骤只在前置步骤仍然有效时可达。 */
export function withConfirmation(project: Project, stage: Extract<FlowStage, 'script' | 'assets' | 'director'>): Project['confirmed'] {
  const confirmed = project.confirmed ?? {};
  if (stage === 'script') return { ...confirmed, script: scriptFingerprint(project) };
  if (stage === 'assets') return { ...confirmed, script: confirmed.script ?? scriptFingerprint(project), assets: assetsFingerprint(project) };
  return { ...confirmed, script: confirmed.script ?? scriptFingerprint(project), assets: confirmed.assets ?? assetsFingerprint(project), director: directorFingerprint(project) };
}

export function validateScriptStage(project: Project): string[] {
  const issues: string[] = [];
  if (!project.shots.length) issues.push('剧本还没有镜头，请先生成或导入剧本。');
  const total = project.shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (!Number.isFinite(total) || total < 20 || total > 400) issues.push(`总时长需要在 20–400 秒之间，当前 ${Number.isFinite(total) ? Number(total.toFixed(2)) : '无效'} 秒。`);
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  project.shots.forEach((shot, index) => {
    const prefix = `第${index + 1}镜：`;
    if (shot.number !== index + 1) issues.push(prefix + '镜号需要按顺序排列。');
    if (!Number.isFinite(shot.duration) || shot.duration <= 0 || shot.duration > 30) issues.push(prefix + '时长必须大于 0 且不超过 30 秒。');
    if (!shot.visual.trim()) issues.push(prefix + '缺少画面内容。');
    if (shot.dialogues.some(line => !speakerName(project, line).trim())) issues.push(prefix + '台词缺少说话人。');
    if (shot.dialogues.some(line => line.speakerId && assets.get(line.speakerId)?.kind !== 'character')) issues.push(prefix + '台词关联的人物资产无效。');
    if (shot.assetIds.some(id => !assets.has(id))) issues.push(prefix + '存在已删除或未知的资产ID。');
  });
  return issues;
}

export function validateAssetsStage(project: Project): string[] {
  const issues: string[] = [];
  for (const kind of ['character', 'scene', 'prop'] as const) {
    if (!project.assets.some(asset => asset.kind === kind)) issues.push(`至少需要一项${kind === 'character' ? '人物' : kind === 'scene' ? '场景' : '道具'}资产。`);
  }
  for (const asset of project.assets.filter(item => item.kind !== 'voice')) {
    if (!asset.name.trim()) issues.push('存在未命名的资产。');
    if (!asset.lock.trim() && !asset.description.trim()) issues.push(`资产「${asset.name || '未命名'}」缺少固定短语。`);
  }
  const byId = new Map(project.assets.map(asset => [asset.id, asset]));
  for (const asset of project.assets) {
    if (asset.voiceAssetId && (asset.kind !== 'character' || byId.get(asset.voiceAssetId)?.kind !== 'voice')) issues.push(`资产「${asset.name}」的关联音色无效。`);
  }
  return issues;
}

/** 资产层建议：只提示不阻断，避免旧存档被判为损坏。 */
export function assetWarnings(project: Project): string[] {
  const warnings: string[] = [];
  for (const asset of project.assets.filter(item => item.kind === 'character')) {
    const phrase = (asset.lock || asset.description).trim();
    if (phrase && !/[男女]/.test(phrase) && !/少年|少女/.test(phrase)) warnings.push(`人物「${asset.name}」的固定短语没有写明性别（男／女），多次出图时外观容易漂移。`);
  }
  // 剧本里的说话人还没认领到人物资产时提醒一次：资产是提取或手动创建出来的，剧本本身不再自动建人。
  const linked = new Set<string>();
  const pending = new Set<string>();
  for (const line of project.shots.flatMap(shot => shot.dialogues)) {
    const asset = line.speakerId ? project.assets.find(item => item.id === line.speakerId && item.kind === 'character') : undefined;
    if (asset) linked.add(asset.name);
    else if ((line.speaker || '').trim()) pending.add((line.speaker || '').trim());
  }
  for (const name of pending) if (!linked.has(name)) warnings.push(`说话人「${name}」还没有关联人物资产，设定图与配音会漏掉这个角色。`);
  return warnings;
}

/** 原文比对时忽略空白与标点，只看字词顺序是否与原文一致。 */
const normalizeFidelity = (value: string) => value.replace(/[\s\u3000，。！？；：、"'"“”‘’（）()《》〈〉—…·\-]/g, '');
const supplementMark = /[*＊]\s*(基于原文背景合理补充|补充)\s*[*＊]/;

export function scriptWarnings(project: Project): string[] {
  const warnings: string[] = [];
  const shotTerms = /推|拉|摇|移|特写|远景|全景|近景|中景|俯拍|仰拍|跟拍|切镜/;
  const source = project.scriptMode === 'source' ? normalizeFidelity(project.sourceText || '') : '';
  project.shots.forEach((shot, index) => {
    if (shotTerms.test(shot.visual)) warnings.push(`第${index + 1}镜：画面描述提到了镜头术语，建议改写成可见事件。`);
    shot.dialogues.forEach(line => {
      if (line.text.length > 24) warnings.push(`第${index + 1}镜：台词「${line.text.slice(0, 12)}…」超过 24 字，建议精简。`);
      if (!source || supplementMark.test(line.text)) return;
      const spoken = normalizeFidelity(line.text);
      if (spoken && !source.includes(spoken)) warnings.push(`第${index + 1}镜：台词「${line.text.slice(0, 12)}${line.text.length > 12 ? '…' : ''}」未在原文中找到，请核对是否改写了原文。`);
    });
  });
  return warnings;
}

export function validateDirectorStage(project: Project): string[] {  const issues: string[] = [];
  project.shots.forEach((shot, index) => {
    const prefix = `第${index + 1}镜：`;
    if (!shot.camera.trim()) issues.push(prefix + '缺少景别与运镜。');
    if (!shot.start.trim()) issues.push(prefix + '缺少开场。');
    if (!shot.action.trim()) issues.push(prefix + '缺少动作。');
    if (!shot.end.trim()) issues.push(prefix + '缺少终点。');
  });
  return issues;
}

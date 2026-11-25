import type { Project } from './types';

export type FlowStage = 'script' | 'director' | 'assets' | 'storyboard' | 'video';
/** 顺序即流程：剧本只出剧本 → 导演步骤调模型结构化出镜头 → 资产从镜头里提取 → 编排分镜 → 视频。 */
export const flowStages: FlowStage[] = ['script', 'director', 'assets', 'storyboard', 'video'];
export const flowLabels: Record<FlowStage, string> = { script: '剧本', director: '导演分镜', assets: '资产', storyboard: '分镜', video: '视频' };

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

/** 剧本层指纹：只包含剧本步骤负责的字段。镜头不再属于剧本步骤，改看剧本文本。 */
export function scriptFingerprint(project: Project): number {
  return fingerprint({ title: project.name, logline: project.logline || '', screenplay: project.screenplay || '' });
}
/** 资产层指纹：固定短语与音色绑定；图片与锁定状态不影响。 */
export function assetsFingerprint(project: Project): number {
  return fingerprint(project.assets.map(asset => ({
    id: asset.id, kind: asset.kind, name: asset.name, description: asset.description, lock: asset.lock,
    voiceAssetId: asset.voiceAssetId, voiceId: asset.voiceId, speed: asset.speed,
  })));
}
/**
 * 导演层指纹：镜头结构与运镜。
 * 不含 assetIds 与说话人 ID——资产步骤会挂资产、按名字连台词，那是资产层的事，
 * 不能因为走了下一步就把导演这一步判成「已改动」。
 */
export function directorFingerprint(project: Project): number {
  return fingerprint(project.shots.map(shot => ({
    id: shot.id, number: shot.number, visual: shot.visual, duration: shot.duration, scene: shot.scene || '',
    camera: shot.camera, start: shot.start, action: shot.action, end: shot.end,
    dialogues: shot.dialogues.map(line => ({ speaker: line.speaker || '', text: line.text })),
  })));
}

export function stageStatus(project: Project): FlowStatus {
  const confirmed = project.confirmed;
  const script = confirmed?.script !== undefined ? confirmed.script === scriptFingerprint(project) : (project.screenplay || '').trim().length > 0;
  const director = script && (confirmed?.director !== undefined
    ? confirmed.director === directorFingerprint(project)
    : project.shots.length > 0 && project.shots.every(shot => shot.camera.trim() && shot.start.trim() && shot.action.trim() && shot.end.trim()));
  const assets = director && (confirmed?.assets !== undefined ? confirmed.assets === assetsFingerprint(project) : project.assets.length > 0);
  const storyboard = assets && project.storyboardReady;
  return { script, director, assets, storyboard, video: storyboard };
}

/**
 * 进入某一步只需要上一步完成：
 * 剧本 → 导演分镜 → 资产 → 分镜 → 视频。
 * 下一步自己完成与否，不影响这一步能不能进。
 */
export function canEnter(project: Project, stage: FlowStage): boolean {
  const requirement = stageRequirement(stage);
  if (!requirement) return true;
  return stageStatus(project)[requirement];
}

export function stageRequirement(stage: FlowStage): FlowStage | undefined {
  return { script: undefined, director: 'script', assets: 'director', storyboard: 'assets', video: 'storyboard' }[stage] as FlowStage | undefined;
}

export function nextStage(stage: FlowStage): FlowStage | undefined {
  return flowStages[flowStages.indexOf(stage) + 1];
}

/** 确认时写入各阶段指纹；下游步骤只在前置步骤仍然有效时可达。 */
export function withConfirmation(project: Project, stage: Extract<FlowStage, 'script' | 'director' | 'assets'>): Project['confirmed'] {
  const confirmed = project.confirmed ?? {};
  if (stage === 'script') return { ...confirmed, script: scriptFingerprint(project) };
  if (stage === 'director') return { ...confirmed, script: confirmed.script ?? scriptFingerprint(project), director: directorFingerprint(project) };
  return {
    ...confirmed,
    script: confirmed.script ?? scriptFingerprint(project),
    director: confirmed.director ?? directorFingerprint(project),
    assets: assetsFingerprint(project),
  };
}

export function validateScriptStage(project: Project): string[] {
  const issues: string[] = [];
  const screenplay = (project.screenplay || '').trim();
  if (!screenplay) issues.push('剧本还没有正文，请先生成或导入剧本。');
  else if (screenplay.length < 50) issues.push(`剧本正文只有 ${screenplay.length} 字，太短了，至少要写够一段能拍的戏。`);
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
  // 说明：不再提醒「说话人还没关联人物资产」——剧本里的说话人是按冒号切出来的，
  // 大多不是可靠的人物名，这种提醒噪音大、又给不出可执行的下一步。
  return warnings;
}

/** 剧本层建议：随剧本带出的资产名在正文里没出现，多半是模型编的。 */
export function scriptWarnings(project: Project): string[] {
  const warnings: string[] = [];
  const screenplay = (project.screenplay || '').trim();
  if (!screenplay) return warnings;
  for (const asset of project.assets.filter(item => item.kind !== 'voice')) {
    const names = [asset.name, ...(asset.aliases ?? [])].map(item => item.trim()).filter(Boolean);
    if (names.some(name => screenplay.includes(name))) continue;
    warnings.push(`资产「${asset.name}」的名字在剧本正文里没出现，请确认它是不是模型编出来的。`);
  }
  return warnings;
}

/** 导演层建议：画面里混进镜头术语时提示改写成可见事件，只提示不阻断。 */
export function directorWarnings(project: Project): string[] {
  const warnings: string[] = [];
  const shotTerms = /推|拉|摇|移|特写|远景|全景|近景|中景|俯拍|仰拍|跟拍|切镜/;
  project.shots.forEach((shot, index) => {
    if (shotTerms.test(shot.visual)) warnings.push(`第${index + 1}镜：画面描述提到了镜头术语，景别与运镜已经有独立字段，这里只写看得见的东西。`);
  });
  return warnings;
}

export function validateDirectorStage(project: Project): string[] {
  const issues: string[] = [];
  if (!project.shots.length) issues.push('还没有分镜，请先用大模型把剧本结构化成镜头。');
  project.shots.forEach((shot, index) => {
    const prefix = `第${index + 1}镜：`;
    if (!shot.scene?.trim()) issues.push(prefix + '缺少场景。');
    if (!shot.visual.trim()) issues.push(prefix + '缺少画面内容。');
    if (!Number.isFinite(shot.duration) || shot.duration <= 0 || shot.duration > 30) issues.push(prefix + '时长必须大于 0 且不超过 30 秒。');
    if (!shot.camera.trim()) issues.push(prefix + '缺少景别与运镜。');
    if (!shot.start.trim()) issues.push(prefix + '缺少开场。');
    if (!shot.action.trim()) issues.push(prefix + '缺少动作。');
    if (!shot.end.trim()) issues.push(prefix + '缺少终点。');
  });
  const total = project.shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (project.shots.length && (!Number.isFinite(total) || total < 20 || total > 400)) {
    issues.push(`总时长需要在 20–400 秒之间，当前 ${Number.isFinite(total) ? Number(total.toFixed(1)) : '无效'} 秒。`);
  }
  return issues;
}

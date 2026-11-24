import type { Project } from './types';

export function validateProject(project: Project): string[] {
  const errors: string[] = [];
  if (!project.shots.length) errors.push('剧本还没有镜头。');
  const total = project.shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (!Number.isFinite(total) || total < 20 || total > 400) errors.push(`总时长需要在20–400秒之间，当前${Number.isFinite(total) ? Number(total.toFixed(2)) : '无效'}秒。`);
  const assets = new Map(project.assets.map(a => [a.id, a]));
  if (assets.size !== project.assets.length) errors.push('存在重复的资产ID。');
  if (new Set(project.shots.map(s => s.id)).size !== project.shots.length) errors.push('存在重复的镜头ID。');
  for (const asset of project.assets) {
    if (asset.voiceAssetId && (asset.kind !== 'character' || assets.get(asset.voiceAssetId)?.kind !== 'voice')) errors.push(`资产「${asset.name}」的关联音色无效。`);
  }
  project.shots.forEach((shot, index) => {
    const prefix = `第${index + 1}镜：`;
    if (shot.number !== index + 1) errors.push(prefix + '镜号需要按顺序排列。');
    if (!Number.isFinite(shot.duration) || shot.duration <= 0 || shot.duration > 30) errors.push(prefix + '时长必须大于0且不超过30秒。');
    if (shot.assetIds.some(id => !assets.has(id))) errors.push(prefix + '存在已删除或未知的资产ID。');
    if (shot.references.some(r => !assets.has(r.assetId) || !assets.get(r.assetId)?.imageId || assets.get(r.assetId)?.kind === 'voice')) errors.push(prefix + '参考图必须关联真实图片资产。');
    if (new Set(shot.references.map(r => r.assetId)).size !== shot.references.length) errors.push(prefix + '同一图片资产不能重复挂载。');
    if (shot.references.some(r => !['reference_image', 'first_frame', 'last_frame'].includes(r.role))) errors.push(prefix + '参考图角色无效。');
    const first = shot.references.filter(r => r.role === 'first_frame').length;
    const last = shot.references.filter(r => r.role === 'last_frame').length;
    if (shot.references.some(r => r.role === 'reference_image') && (first || last)) errors.push(prefix + '参考图模式与首尾帧模式互斥。');
    if (first > 1 || last > 1) errors.push(prefix + '首帧和尾帧各最多一张。');
    if (last && !first) errors.push(prefix + '使用尾帧时必须同时提供首帧。');
    if (!['original', 'dubbing', 'silent'].includes(shot.audioMode)) errors.push(prefix + '音频模式无效，只能选择原声、配音或静音之一。');
  });
  return errors;
}

import type { Project, Reference, Shot } from '../../domain/types';

export function fillStoryboard(shots: Shot[]): Shot[] {
  let previousEnd = '';
  return shots.map((shot, index) => {
    const start = shot.start.trim() ? shot.start : previousEnd || shot.visual || '开场状态待补充';
    const action = shot.action.trim() ? shot.action : `从「${start}」继续，${shot.visual || '主体完成本镜关键动作（待细化）'}`;
    const end = shot.end.trim() ? shot.end : `${shot.visual || start}；动作完成，保持位置供下一镜承接。`;
    previousEnd = end;
    return { ...shot, number: index + 1, start, action, end };
  });
}

export function updateReference(project: Project, shot: Shot, assetId: string, role?: Reference['role']): Shot {
  if (role) {
    const asset = project.assets.find(a => a.id === assetId);
    if (!asset?.imageId || asset.kind === 'voice') throw new Error('只有已保存真实图片的资产才能挂载为参考图。');
  }
  const references = shot.references.filter(r => r.assetId !== assetId);
  if (role) {
    if (role === 'reference_image' ? references.some(r => r.role !== 'reference_image') : references.some(r => r.role === 'reference_image')) throw new Error('参考图与首尾帧不能混用，请先取消另一模式的图片。');
    if (role !== 'reference_image' && references.some(r => r.role === role)) throw new Error('首帧和尾帧各最多一张，请先移除同角色的图片。');
    const previousIndex = shot.references.findIndex(r => r.assetId === assetId);
    references.splice(previousIndex < 0 ? references.length : previousIndex, 0, { assetId, role });
  }
  return { ...shot, assetIds: role ? [...new Set([...shot.assetIds, assetId])] : shot.assetIds, references };
}

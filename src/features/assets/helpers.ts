import type { Project } from '../../domain/types';

export function removeAsset(project: Project, id: string): Project {
  return {
    ...project, storyboardReady: false,
    assets: project.assets.filter(a => a.id !== id).map(a => a.voiceAssetId === id ? { ...a, voiceAssetId: undefined } : a),
    shots: project.shots.map(s => ({ ...s, assetIds: s.assetIds.filter(assetId => assetId !== id), references: s.references.filter(r => r.assetId !== id), dialogues: s.dialogues.map(d => d.speakerId === id ? { ...d, speakerId: '' } : d) })),
  };
}

export function assetUsage(project: Project, id: string): string[] {
  const usage = project.shots.filter(s => s.assetIds.includes(id) || s.references.some(r => r.assetId === id) || s.dialogues.some(d => d.speakerId === id)).map(s => `第${s.number}镜`);
  project.assets.filter(a => a.voiceAssetId === id).forEach(a => usage.push(`人物「${a.name}」的音色`));
  return usage;
}

/** 用到该资产的镜头 ID，用于锁定资产修改后的范围失效。 */
export function assetShotIds(project: Project, id: string): string[] {
  return project.shots.filter(shot => shot.assetIds.includes(id) || shot.references.some(ref => ref.assetId === id) || shot.dialogues.some(line => line.speakerId === id)).map(shot => shot.id);
}

export async function validateImage(blob: Blob): Promise<void> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error('仅支持 PNG、JPEG、WebP 图片；不支持SVG或伪装为图片的文件。');
  if (!blob.size || blob.size > 5 * 1024 * 1024) throw new Error('图片不能为空且不能超过5MB。');
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  const webp = ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (!(blob.type === 'image/png' ? png : blob.type === 'image/jpeg' ? jpeg : webp)) throw new Error('图片内容与MIME类型不匹配，请重新导出图片。');
}

export async function generatedImageBlob(result: { base64: string; mime: string }): Promise<Blob> {
  if (typeof result.base64 !== 'string' || result.base64.length > 7 * 1024 * 1024) throw new Error('生成图片数据无效或超过5MB限制。');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0)); }
  catch { throw new Error('服务商返回了无效的图片编码。'); }
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: result.mime });
  await validateImage(blob);
  return blob;
}

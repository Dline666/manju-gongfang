import type { Asset, Project } from '../../domain/types';

/**
 * 多形态沿用现有资产数据：名字写成「角色 · 形态」即归到同一角色下，基础形态就是角色名本身。
 * 点、间隔号、斜杠都接受，便于从旧清单里粘贴进来的名字直接归组。
 */
export function splitFormName(name: string) {
  const match = name.match(/^(.*?)\s*[·・/]\s*(.+)$/);
  return match ? { base: match[1].trim(), form: match[2].trim() } : { base: name.trim(), form: '' };
}

/**
 * 非基础形态对应的基础形态资产；基础形态本身、名字解析不出基础形态时返回 undefined。
 * 只认同类别、名字完全等于基础名的资产，避免「阿青 · 战损」被同名场景误认。
 */
export function formBaseAsset(asset: Asset, assets: Asset[]): Asset | undefined {
  const { base, form } = splitFormName(asset.name);
  if (!form) return undefined;
  return assets.find(item => item.id !== asset.id && item.kind === asset.kind && splitFormName(item.name).form === '' && item.name.trim() === base);
}

/**
 * 某个资产挂载的参考图来源。
 * - `referenceAssetId` 是资产 id：用它；
 * - 空字符串：用户明确清空，纯文本生成；
 * - undefined：旧数据兼容——新形态沿用基础形态的当前设定图，其它资产留空。
 * 参考图按资产动态解析，所以来源资产换了设定图，引用它的资产也会跟着用新图。
 */
export function referenceAssetFor(asset: Asset, assets: Asset[]): Asset | undefined {
  if (asset.referenceAssetId === '') return undefined;
  if (asset.referenceAssetId) return assets.find(item => item.id === asset.referenceAssetId && item.id !== asset.id);
  const base = formBaseAsset(asset, assets);
  return base?.imageId ? base : undefined;
}

/**
 * 人物资产与剧本说话人按名字对齐：新建或改名人物后，台词自动挂到这个人身上。
 * 剧本阶段不建人物，所以这一步是「资产真正产生」的时刻。
 */
export function linkSpeakersToCharacter(project: Project, character: Asset): Project {
  if (character.kind !== 'character' || !character.name.trim()) return project;
  const name = character.name.trim();
  return {
    ...project,
    shots: project.shots.map(shot => ({
      ...shot,
      dialogues: shot.dialogues.map(line => {
        const speaker = (line.speaker || '').trim();
        if (!speaker || speaker !== name) return line;
        if (line.speakerId === character.id) return line;
        return { ...line, speakerId: character.id };
      }),
    })),
  };
}

export function removeAsset(project: Project, id: string): Project {
  return {
    ...project, storyboardReady: false,
    assets: project.assets.filter(a => a.id !== id).map(a => ({
      ...a,
      ...(a.voiceAssetId === id ? { voiceAssetId: undefined } : {}),
      ...(a.referenceAssetId === id ? { referenceAssetId: '' } : {}),
    })),
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

/**
 * 图片落地前的最后一道关：服务商返回的 base64 可能不是图片，
 * 用户上传的文件也可能是改了扩展名的别的东西。两者都要按真实字节核对，
 * 而不是相信 MIME 或文件名。
 */

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * 固定描述在提交与落库之间可能被改。用内容指纹比对，才能在写回前判断
 * 「这张图是不是还对应现在这段描述」——不追求密码学强度，只要稳定。
 */
export function fixedHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return String(hash);
}

export async function validateImage(blob: Blob): Promise<void> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) {
    throw new Error('仅支持 PNG、JPEG、WebP 图片；不支持 SVG 或伪装为图片的文件。');
  }
  if (!blob.size || blob.size > MAX_BYTES) throw new Error('图片不能为空且不能超过 5MB。');
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  const webp = ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  const ok = blob.type === 'image/png' ? png : blob.type === 'image/jpeg' ? jpeg : webp;
  if (!ok) throw new Error('图片内容与 MIME 类型不匹配，请重新导出图片。');
}

/** 把服务商返回的 base64 变成校验过的 Blob。 */
export async function generatedImageBlob(result: { base64: string; mime: string }): Promise<Blob> {
  if (typeof result.base64 !== 'string' || result.base64.length > 7 * 1024 * 1024) {
    throw new Error('生成图片数据无效或超过 5MB 限制。');
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
  } catch {
    throw new Error('服务商返回了无效的图片编码。');
  }
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: result.mime });
  await validateImage(blob);
  return blob;
}
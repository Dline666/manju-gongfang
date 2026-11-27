import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedHash, generatedImageBlob, validateImage } from '../src/lib/imageFile';

// 1×1 的真 PNG（不是伪装文件），用来验证正常路径。
const PNG_1X1 = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
), char => char.charCodeAt(0));

test('固定描述指纹稳定，内容变一个字符就变', () => {
  const a = fixedHash('十七岁少年，灰白旧布衣');
  const b = fixedHash('十七岁少年，灰白旧布衣');
  const c = fixedHash('十七岁少年，灰白旧布衣。');
  assert.equal(a, b, '同一段描述必须得到同一个指纹');
  assert.notEqual(a, c, '描述改了就不能再认为还是同一张图');
  assert.equal(fixedHash(''), '5381');
});

test('真图片通过校验，伪装成图片的文件被拒', async () => {
  const good = new Blob([PNG_1X1 as Uint8Array<ArrayBuffer>], { type: 'image/png' });
  await assert.doesNotReject(() => validateImage(good));

  // 扩展名与 MIME 都说是 PNG，内容其实是文本。
  const fake = new Blob(['not an image at all'], { type: 'image/png' });
  await assert.rejects(() => validateImage(fake), /内容与 MIME 类型不匹配/);

  // SVG 一律不收：它可以内嵌脚本。
  const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/svg+xml' });
  await assert.rejects(() => validateImage(svg), /仅支持 PNG、JPEG、WebP/);

  const empty = new Blob([], { type: 'image/png' });
  await assert.rejects(() => validateImage(empty), /不能为空/);
});

test('服务商返回的 base64 走同一条校验，坏数据不会写进存档', async () => {
  const blob = await generatedImageBlob({ base64: btoa(String.fromCharCode(...PNG_1X1)), mime: 'image/png' });
  assert.equal(blob.type, 'image/png');
  assert.equal(blob.size, PNG_1X1.length);

  await assert.rejects(() => generatedImageBlob({ base64: '!!!not base64!!!', mime: 'image/png' }), /无效的图片编码/);
  await assert.rejects(() => generatedImageBlob({ base64: 'aGVsbG8=', mime: 'image/png' }), /内容与 MIME 类型不匹配/);
  await assert.rejects(() => generatedImageBlob({ base64: 'a'.repeat(8 * 1024 * 1024), mime: 'image/png' }), /超过 5MB/);
});
import { AsyncZipDeflate, Zip, ZipPassThrough } from 'fflate';
import type { Project } from '../../domain/types';
import { getMedia } from '../../store/media';
import { buildDocuments, buildSrt } from '../documents';
import { abortIfNeeded, assertReady, inspectMedia, inspectProject, requireBlob } from './inputs';
import { buildTimeline, safeFilename } from './timeline';

export interface ArchiveProgress { stage: 'preflight' | 'packing' | 'complete'; message: string; file?: string; completed?: number; total?: number }
interface ArchiveFile { path: string; blob: Blob; text?: boolean }

function extension(blob: Blob, name: string, fallback: string) {
  const mime: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
  return mime[blob.type.split(';')[0]] || (/\.(mp4|mov|webm|mkv|mp3|wav|m4a|aac|ogg|flac|png|jpe?g|webp|gif)$/i.exec(name)?.[1].toLowerCase()) || fallback;
}

async function checkImage(blob: Blob, signal?: AbortSignal) {
  abortIfNeeded(signal);
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); image.onload = image.onerror = null; error ? reject(error) : resolve(); };
      const cancel = () => finish(new DOMException('操作已取消', 'AbortError'));
      const timer = setTimeout(() => finish(new Error('参考图读取超时，请重新导入。')), 15000);
      signal?.addEventListener('abort', cancel, { once: true });
      image.onload = () => finish(image.naturalWidth ? undefined : new Error('参考图内容无效。'));
      image.onerror = () => finish(new Error('参考图无法解码，请重新导入。'));
      image.src = url;
    });
  } finally { image.src = ''; URL.revokeObjectURL(url); }
}

/** Chunked input, asynchronous text compression; already-compressed media is stored, not deflated again. */
export async function zipFiles(files: ArchiveFile[], onProgress: (progress: ArchiveProgress) => void = () => {}, signal?: AbortSignal): Promise<Blob> {
  abortIfNeeded(signal);
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(sorted.map(file => file.path)).size !== sorted.length) throw new Error('素材包文件名重复。');
  const chunks: BlobPart[] = [];
  let zip: Zip;
  const result = new Promise<Blob>((resolve, reject) => {
    const cancel = () => { zip?.terminate(); reject(new DOMException('操作已取消', 'AbortError')); };
    const clean = () => signal?.removeEventListener('abort', cancel);
    zip = new Zip((error, data, final) => {
      if (error) { clean(); reject(error); return; }
      chunks.push(new Uint8Array(data));
      if (final) { clean(); resolve(new Blob(chunks, { type: 'application/zip' })); }
    });
    signal?.addEventListener('abort', cancel, { once: true });
    void (async () => {
      try {
        for (let index = 0; index < sorted.length; index++) {
          abortIfNeeded(signal);
          const file = sorted[index];
          onProgress({ stage: 'packing', message: `正在打包 ${file.path}`, file: file.path, completed: index, total: sorted.length });
          abortIfNeeded(signal);
          const entry = file.text ? new AsyncZipDeflate(file.path, { level: 6 }) : new ZipPassThrough(file.path);
          entry.mtime = new Date(2000, 0, 1); // Stable metadata; no local file paths or credentials.
          zip.add(entry);
          // One active compressor at a time; yield on Blob reads for responsiveness.
          await new Promise<void>((done, fail) => {
            const handler = entry.ondata;
            const abort = () => fail(new DOMException('操作已取消', 'AbortError'));
            signal?.addEventListener('abort', abort, { once: true });
            entry.ondata = (error, data, final) => {
              handler(error, data, final);
              if (error || final) { signal?.removeEventListener('abort', abort); error ? fail(error) : done(); }
            };
            void (async () => {
              try {
                const size = 1024 * 1024;
                if (!file.blob.size) entry.push(new Uint8Array(), true);
                for (let offset = 0; offset < file.blob.size; offset += size) {
                  abortIfNeeded(signal);
                  entry.push(new Uint8Array(await file.blob.slice(offset, offset + size).arrayBuffer()), offset + size >= file.blob.size);
                }
              } catch (error) { signal?.removeEventListener('abort', abort); fail(error); }
            })();
          });
          if (entry instanceof AsyncZipDeflate) entry.terminate();
        }
        abortIfNeeded(signal);
        zip.end();
      } catch (error) { clean(); zip.terminate(); reject(error); }
    })();
  });
  return result;
}

export async function buildMaterialZip(project: Project, onProgress: (progress: ArchiveProgress) => void = () => {}, signal?: AbortSignal): Promise<Blob> {
  const snapshot = structuredClone(project);
  onProgress({ stage: 'preflight', message: '检查全部逐镜视频、配音与参考图；不完整时不会生成完整素材包。' });
  const report = await inspectProject(snapshot, shot => onProgress({ stage: 'preflight', message: `检查第 ${shot} 镜…` }), signal);
  assertReady(report);
  const files: ArchiveFile[] = [];
  const timeline = buildTimeline(snapshot.shots);
  const shotManifest = [];
  for (let index = 0; index < report.shots.length; index++) {
    abortIfNeeded(signal);
    const item = report.shots[index];
    const shot = item.shot;
    const prefix = `shots/${String(index + 1).padStart(2, '0')}`;
    const videoPath = `${prefix}/video.${extension(item.video!, shot.video!.name, 'bin')}`;
    files.push({ path: videoPath, blob: item.video! });
    let audioPath: string | undefined;
    // Include attached dubbing even when original/silent is currently selected.
    if (shot.audio) {
      const audio = requireBlob(item.audio ?? await getMedia(shot.audio.mediaId), `第 ${shot.number} 镜配音`);
      await inspectMedia(audio, 'audio', signal);
      audioPath = `${prefix}/dubbing.${extension(audio, shot.audio.name, 'bin')}`;
      files.push({ path: audioPath, blob: audio });
    }
    for (const reference of shot.references) {
      if (!snapshot.assets.find(asset => asset.id === reference.assetId)?.imageId) throw new Error(`第 ${shot.number} 镜参考图缺失，请在资产页重新导入；未生成完整素材包。`);
    }
    shotManifest.push({ id: shot.id, number: shot.number, startMs: timeline[index].startMs, endMs: timeline[index].endMs, duration: shot.duration, sourceDuration: item.videoDuration, audioMode: shot.audioMode, video: videoPath, dubbing: audioPath, references: shot.references.map(reference => ({ assetId: reference.assetId, role: reference.role })) });
  }
  const images = [];
  for (let index = 0; index < snapshot.assets.length; index++) {
    abortIfNeeded(signal);
    const asset = snapshot.assets[index];
    if (!asset.imageId) continue;
    const image = requireBlob(await getMedia(asset.imageId), `参考图「${asset.name}」`);
    await checkImage(image, signal);
    const path = `references/${String(index + 1).padStart(2, '0')}-${safeFilename(asset.name)}.${extension(image, '', 'bin')}`;
    files.push({ path, blob: image });
    images.push({ assetId: asset.id, name: asset.name, path });
  }
  const documents = buildDocuments(snapshot);
  if (Object.keys(documents).length !== 5) throw new Error('文档生成器未提供完整的五份文档。');
  for (const [name, text] of Object.entries(documents)) files.push({ path: `documents/${safeFilename(name)}`, blob: new Blob([text], { type: 'text/plain;charset=utf-8' }), text: true });
  files.push({ path: 'subtitles.srt', blob: new Blob([buildSrt(snapshot)], { type: 'application/x-subrip;charset=utf-8' }), text: true });
  const manifest = {
    schemaVersion: 1, complete: true,
    project: { id: snapshot.id, name: snapshot.name, revision: snapshot.revision },
    target: { width: 720, height: 1280, fps: 24, duration: 90, videoCodec: 'H.264', audioCodec: 'AAC', pixelFormat: 'yuv420p' },
    rules: { video: 'fit with black padding; trim from start or hold last frame', audio: 'original / replace with dubbing / silent; pad short audio with silence; never trim overlong dubbing', subtitles: 'estimated evenly within each shot; manually verify dialogue timing', materials: 'original source files, not normalized clips; no proprietary editor draft' },
    shots: shotManifest, images,
    files: files.map(file => ({ path: file.path, bytes: file.blob.size, type: file.blob.type })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
  files.push({ path: 'manifest.json', blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), text: true });
  const blob = await zipFiles(files, onProgress, signal);
  onProgress({ stage: 'complete', message: '完整素材包已生成。', completed: files.length, total: files.length });
  return blob;
}

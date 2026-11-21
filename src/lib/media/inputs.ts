import type { Project, Shot } from '../../domain/types';
import { getMedia, getVideo, setVideo } from '../../store/media';
import { callBinary, credentials } from '../api';
import { audioDurationIssue, projectIssues } from './timeline';

export interface LoadedShot {
  shot: Shot;
  video?: Blob;
  audio?: Blob;
  videoDuration?: number;
  audioDuration?: number;
  issues: string[];
}
export interface MediaReport { shots: LoadedShot[]; issues: string[]; ready: boolean }
export const abortIfNeeded = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError'); };

export function requireBlob(blob: Blob | undefined, label: string): Blob {
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error(`${label}缺失或为空文件，请重新导入。`);
  return blob;
}

/** Actual metadata, not the persisted duration. Object URLs and decoders are always released. */
export async function inspectMedia(blob: Blob, kind: 'video' | 'audio', signal?: AbortSignal): Promise<number> {
  requireBlob(blob, kind === 'video' ? '视频' : '配音');
  abortIfNeeded(signal);
  const url = URL.createObjectURL(blob);
  const element = document.createElement(kind);
  try {
    return await new Promise<number>((resolve, reject) => {
      const finish = (error?: Error, duration?: number) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        element.onloadedmetadata = element.onerror = null;
        if (error) reject(error); else resolve(duration!);
      };
      const cancel = () => finish(new DOMException('操作已取消', 'AbortError'));
      const timer = setTimeout(() => finish(new Error('素材读取超时，请本地重新导入 MP4/H.264 视频或 WAV/MP3 音频。')), 15000);
      signal?.addEventListener('abort', cancel, { once: true });
      element.onloadedmetadata = () => {
        const valid = Number.isFinite(element.duration) && element.duration > 0 && (kind !== 'video' || (element as HTMLVideoElement).videoWidth > 0);
        finish(valid ? undefined : new Error('素材没有有效媒体轨道或时长，请重新导入。'), element.duration);
      };
      element.onerror = () => finish(new Error('素材无法解码，请本地重新导入 MP4/H.264 视频或 WAV/MP3 音频。'));
      element.preload = 'metadata';
      element.src = url;
    });
  } finally {
    element.removeAttribute('src');
    element.load();
    URL.revokeObjectURL(url);
  }
}

export async function loadVideo(project: Project, shot: Shot, signal?: AbortSignal): Promise<Blob> {
  abortIfNeeded(signal);
  if (!shot.video) throw new Error('尚未导入或生成视频。');
  const local = getVideo(project.id, shot.id)?.blob;
  if (local) return requireBlob(local, '当前会话视频');
  let blob: Blob | undefined;
  if (shot.video.url) {
    try {
      const url = new URL(shot.video.url, window.location.href);
      if (!['https:', 'http:', 'blob:'].includes(url.protocol)) throw new Error('不支持此链接协议');
      const deadline = AbortSignal.timeout(60000);
      const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, credentials: 'omit' });
      if (!response.ok || !response.body) throw new Error('视频链接已失效');
      const maximum = 200 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > maximum) { await response.body.cancel(); throw new Error('视频超过 200 MB，请压缩后本地导入。'); }
      const reader = response.body.getReader(); const chunks: BlobPart[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > maximum) throw new Error('视频超过 200 MB，请压缩后本地导入。');
          chunks.push(new Uint8Array(value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      blob = requireBlob(new Blob(chunks, { type: response.headers.get('content-type') || 'video/mp4' }), '链接视频');
    } catch {
      abortIfNeeded(signal);
      if (shot.video.origin !== 'api' || !shot.task?.id) throw new Error('链接已过期、不可下载或被 CORS 阻止。请从原平台下载视频后在「生成」页本地重新导入；不会使用任意代理。');
    }
  }
  if (!blob && shot.video.origin === 'api' && shot.task?.id) {
    try { blob = requireBlob(await callBinary('video-download', { ...credentials(shot.task.provider), taskId: shot.task.id }, signal), 'API 视频'); }
    catch (error) {
      abortIfNeeded(signal);
      throw new Error(`${error instanceof Error ? error.message : 'API 视频下载失败。'} 请在设置检查凭据，或从原平台下载后本地重新导入。`);
    }
  }
  if (!blob) throw new Error('视频仅保存在内存，刷新后需在「生成」页重新导入。');
  await inspectMedia(blob, 'video', signal);
  abortIfNeeded(signal);
  setVideo(project.id, shot.id, blob); // Memory only. Never put video into IndexedDB/localStorage.
  return blob;
}

export async function inspectProject(project: Project, onShot?: (number: number) => void, signal?: AbortSignal): Promise<MediaReport> {
  const issues = projectIssues(project);
  const shots: LoadedShot[] = [];
  for (const shot of project.shots) {
    abortIfNeeded(signal);
    onShot?.(shot.number);
    const loaded: LoadedShot = { shot, issues: [] };
    shots.push(loaded);
    if (shot.stale || (shot.video?.origin === 'api' && shot.task && shot.task.revision !== project.revision)) loaded.issues.push('素材已过期：分镜修改后需重新生成或重新导入并确认。');
    try {
      loaded.video = await loadVideo(project, shot, signal);
      loaded.videoDuration = await inspectMedia(loaded.video, 'video', signal);
    } catch (error) { abortIfNeeded(signal); loaded.issues.push(error instanceof Error ? error.message : '视频读取失败。'); }
    if (shot.audioMode === 'dubbing') {
      try {
        loaded.audio = requireBlob(shot.audio?.mediaId ? await getMedia(shot.audio.mediaId) : undefined, '替换配音');
        loaded.audioDuration = await inspectMedia(loaded.audio, 'audio', signal);
        const issue = audioDurationIssue(loaded.audioDuration, shot.duration);
        if (issue) loaded.issues.push(issue);
      } catch (error) { abortIfNeeded(signal); loaded.issues.push(error instanceof Error ? error.message : '配音读取失败。'); }
    }
    if (shot.audioMode === 'silent' && shot.dialogues.some(line => line.text.trim())) loaded.issues.push('有台词的镜头不能按无台词静音导出，请选择原声或配音；如确实无台词，请先修改分镜。');
    if (!['silent', 'dubbing', 'original'].includes(shot.audioMode)) loaded.issues.push('请选择原声、替换配音或无台词静音。');
  }
  return { shots, issues, ready: issues.length === 0 && shots.every(shot => shot.issues.length === 0) };
}

export function assertReady(report: MediaReport) {
  if (!report.ready) throw new Error([...report.issues, ...report.shots.flatMap(item => item.issues.map(issue => `第 ${item.shot.number} 镜：${issue}`))].join('\n'));
}

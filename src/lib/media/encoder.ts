import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import workerURL from '@ffmpeg/ffmpeg/worker?worker&url';
import type { Project } from '../../domain/types';
import { inspectProject, assertReady, requireBlob } from './inputs';
import { audioDurationIssue } from './timeline';
import { concatList, shotCommand } from './commands';

export interface RenderProgress {
  stage: 'loading' | 'preflight' | 'encoding' | 'concat' | 'complete';
  message: string;
  shot?: number;
  total?: number;
  /** FFmpeg-reported output timestamp, not a model/overall progress estimate. */
  encodedSeconds?: number;
}
export type OnProgress = (progress: RenderProgress) => void;
let busy = false;

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
}

async function withEncoder<T>(onProgress: OnProgress, signal: AbortSignal | undefined, run: (ffmpeg: FFmpeg) => Promise<T>): Promise<T> {
  throwIfAborted(signal);
  if (typeof WebAssembly === 'undefined' || typeof Worker === 'undefined') throw new Error('此浏览器不支持本地视频编码，请改用最新版电脑端 Chrome 或 Edge。');
  if (((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) < 4) throw new Error('设备可用内存等级低于 4 GB，建议在电脑端合成；仍可预览或导出素材 ZIP。');
  if (busy) throw new Error('编码器正在使用，请等待当前任务完成或取消。');
  busy = true;
  const ffmpeg = new FFmpeg();
  const cancel = () => ffmpeg.terminate();
  signal?.addEventListener('abort', cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    onProgress({ stage: 'loading', message: '正在加载同源单线程 FFmpeg（首次约 32 MB）…' });
    const base = new URL(`${import.meta.env.BASE_URL}ffmpeg/`, window.location.href);
    await Promise.race([
      ffmpeg.load({ classWorkerURL: workerURL, coreURL: new URL('ffmpeg-core.js', base).href, wasmURL: new URL('ffmpeg-core.wasm', base).href }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { ffmpeg.terminate(); reject(new Error('FFmpeg 加载超时，请检查同源 /ffmpeg 静态文件与浏览器内存。')); }, 90000); }),
    ]);
    clearTimeout(timer);
    throwIfAborted(signal);
    return await run(ffmpeg);
  } catch (error) {
    throwIfAborted(signal);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    // Also releases WASM heap after success; a cancelled run always reloads a fresh worker.
    ffmpeg.terminate();
    busy = false;
  }
}

async function exec(ffmpeg: FFmpeg, args: string[]) {
  const logs: string[] = [];
  const log = ({ message }: { message: string }) => { logs.push(message); if (logs.length > 8) logs.shift(); };
  ffmpeg.on('log', log);
  try {
    const code = await ffmpeg.exec(['-hide_banner', '-threads', '1', ...args]);
    if (code !== 0) throw new Error(`FFmpeg 编码失败（${code}）。请使用本地 MP4/H.264 或 WAV/MP3 素材重试。\n${logs.join('\n')}`);
  } finally { ffmpeg.off('log', log); }
}

async function readBlob(ffmpeg: FFmpeg, path: string, type: string): Promise<Blob> {
  const data = await ffmpeg.readFile(path);
  if (!(data instanceof Uint8Array) || !data.byteLength) throw new Error('编码器未生成有效文件。');
  return new Blob([new Uint8Array(data)], { type });
}

interface ProbeResult {
  streams: { codec_type: string; duration?: string; width?: number; height?: number }[];
  format?: { duration?: string };
}
async function probe(ffmpeg: FFmpeg, path: string): Promise<ProbeResult> {
  const logs: string[] = [];
  const log = ({ message }: { message: string }) => { logs.push(message); if (logs.length > 8) logs.shift(); };
  ffmpeg.on('log', log);
  try {
    const code = await ffmpeg.ffprobe(['-v', 'error', '-show_entries', 'stream=codec_type,duration,width,height:format=duration', '-of', 'json', path, '-o', 'probe.json']);
    // core 0.12.10 leaves ret=-1 on successful ffprobe; require fresh, valid JSON below.
    if (code !== 0 && code !== -1) throw new Error(`FFmpeg 无法解析素材（${code}），请重新导入标准 MP4/H.264 或 WAV/MP3。\n${logs.join('\n')}`);
    const text = await ffmpeg.readFile('probe.json', 'utf8');
    const result = JSON.parse(String(text)) as ProbeResult;
    if (!Array.isArray(result.streams) || !result.streams.length) throw new Error('素材不包含有效媒体轨道。');
    return result;
  } finally { ffmpeg.off('log', log); await ffmpeg.deleteFile('probe.json').catch(() => {}); }
}
async function mounted<T>(ffmpeg: FFmpeg, directory: string, blobs: { name: string; data: Blob }[], run: () => Promise<T>): Promise<T> {
  if (!await ffmpeg.mount(FFFSType.WORKERFS, { blobs }, directory)) throw new Error('当前 FFmpeg core 不支持只读内存素材挂载。');
  try { return await run(); } finally { await ffmpeg.unmount(directory).catch(() => {}); }
}

/** Decode/check all tracks first, then encode exactly one shot at a time. */
export async function renderProject(project: Project, onProgress: OnProgress = () => {}, signal?: AbortSignal): Promise<Blob> {
  const snapshot = structuredClone(project);
  onProgress({ stage: 'preflight', message: '正在检查当前素材与实际时长…' });
  const report = await inspectProject(snapshot, shot => onProgress({ stage: 'preflight', shot, total: snapshot.shots.length, message: `正在读取第 ${shot} 镜素材…` }), signal);
  assertReady(report);
  if (report.shots.reduce((total, item) => total + (item.video?.size ?? 0) + (item.audio?.size ?? 0), 0) > 320 * 1024 * 1024) throw new Error('源素材超过 320 MB，浏览器合成可能内存不足；请压缩逐镜视频后重试，或导出素材包剪辑。');
  return withEncoder(onProgress, signal, async ffmpeg => {
    await ffmpeg.createDir('/input');
    await ffmpeg.createDir('/parts');
    const hasAudio: boolean[] = [];
    for (const item of report.shots) {
      throwIfAborted(signal);
      onProgress({ stage: 'preflight', shot: item.shot.number, total: report.shots.length, message: `FFmpeg 检查第 ${item.shot.number} 镜媒体轨道…` });
      const blobs = [{ name: 'input-video', data: item.video! }, ...(item.audio ? [{ name: 'input-audio', data: item.audio }] : [])];
      await mounted(ffmpeg, '/input', blobs, async () => {
        const info = await probe(ffmpeg, '/input/input-video');
        if (!info.streams.some(stream => stream.codec_type === 'video' && (stream.width ?? 0) > 0 && (stream.height ?? 0) > 0)) throw new Error(`第 ${item.shot.number} 镜没有有效视频轨道。`);
        const originalAudio = info.streams.some(stream => stream.codec_type === 'audio');
        hasAudio.push(originalAudio);
        if (item.shot.audioMode === 'original' && !originalAudio && item.shot.dialogues.some(line => line.text.trim())) throw new Error(`第 ${item.shot.number} 镜有台词但源视频没有音轨，请在生成页导入配音并选择替换配音。`);
        if (item.audio) {
          const audio = await probe(ffmpeg, '/input/input-audio');
          const stream = audio.streams.find(stream => stream.codec_type === 'audio');
          if (!stream) throw new Error(`第 ${item.shot.number} 镜配音没有音频轨道。`);
          const duration = Number(stream.duration ?? audio.format?.duration);
          const issue = audioDurationIssue(duration, item.shot.duration);
          if (issue) throw new Error(`第 ${item.shot.number} 镜：${issue}`);
        }
      });
    }
    const parts: { name: string; data: Blob }[] = [];
    for (let index = 0; index < report.shots.length; index++) {
      throwIfAborted(signal);
      const item = report.shots[index];
      const status: RenderProgress = { stage: 'encoding', shot: item.shot.number, total: report.shots.length, message: `正在编码第 ${item.shot.number} 镜（720×1280 / 24 fps）…` };
      onProgress(status);
      const progress = ({ time }: { time: number }) => onProgress({ ...status, encodedSeconds: Math.max(0, time / 1000000) });
      ffmpeg.on('progress', progress);
      try {
        await mounted(ffmpeg, '/input', [{ name: 'input-video', data: item.video! }, ...(item.audio ? [{ name: 'input-audio', data: item.audio }] : [])], async () => {
          await exec(ffmpeg, shotCommand(item.shot, hasAudio[index]));
          parts.push({ name: `part-${index}.mov`, data: await readBlob(ffmpeg, 'segment.mov', 'video/quicktime') });
        });
      } finally {
        ffmpeg.off('progress', progress);
        await ffmpeg.deleteFile('segment.mov').catch(() => {});
      }
    }
    throwIfAborted(signal);
    onProgress({ stage: 'concat', message: '正在拼接全部分镜，并统一编码 AAC 音轨（避免逐镜音频填充造成漂移）…' });
    const blob = await mounted(ffmpeg, '/parts', parts, async () => {
      await ffmpeg.writeFile('concat.txt', concatList(snapshot.shots.map(shot => shot.duration)));
      await exec(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', ...audioOptions, '-t', '90', '-map_metadata', '-1', '-movflags', '+faststart', 'final.mp4']);
      return readBlob(ffmpeg, 'final.mp4', 'video/mp4');
    });
    onProgress({ stage: 'complete', message: 'MP4 已生成，可预览和下载。' });
    return blob;
  });
}

/** Sequential audio synthesis for generation callers; never truncates dialogue. Returns WAV Blob. */
export async function composeAudio(clips: Blob[], signal?: AbortSignal): Promise<Blob> {
  if (!clips.length) throw new Error('没有可合成的配音。');
  clips.forEach((clip, index) => requireBlob(clip, `第 ${index + 1} 段配音`));
  return withEncoder(() => {}, signal, async ffmpeg => {
    await ffmpeg.createDir('/input');
    await ffmpeg.createDir('/parts');
    const parts: { name: string; data: Blob }[] = [];
    for (let index = 0; index < clips.length; index++) {
      throwIfAborted(signal);
      try {
        await mounted(ffmpeg, '/input', [{ name: 'audio', data: clips[index] }], async () => {
          await exec(ffmpeg, ['-i', '/input/audio', '-map', '0:a:0', '-vn', '-af', 'aresample=48000,asetpts=PTS-STARTPTS', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', 'audio.wav']);
          parts.push({ name: `part-${index}.wav`, data: await readBlob(ffmpeg, 'audio.wav', 'audio/wav') });
        });
      } finally { await ffmpeg.deleteFile('audio.wav').catch(() => {}); }
    }
    return mounted(ffmpeg, '/parts', parts, async () => {
      await ffmpeg.writeFile('audio-list.txt', parts.map(part => `file 'parts/${part.name}'\n`).join(''));
      await exec(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', 'audio-list.txt', '-map', '0:a:0', '-c:a', 'pcm_s16le', 'combined.wav']);
      return readBlob(ffmpeg, 'combined.wav', 'audio/wav');
    });
  });
}

const videoOptions = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '24', '-threads', '1'];
const audioOptions = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];

/** Browser-only developer smoke. No fixture video, UI entry point or persistent storage. */
export async function smokeEncode(): Promise<Blob> {
  return withEncoder(() => {}, undefined, async ffmpeg => {
    await exec(ffmpeg, [
      '-f', 'lavfi', '-i', 'color=c=0x334155:s=720x1280:r=24:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-map', '0:v:0', '-map', '1:a:0', '-t', '1', ...videoOptions, ...audioOptions,
      '-movflags', '+faststart', 'smoke.mp4',
    ]);
    return readBlob(ffmpeg, 'smoke.mp4', 'video/mp4');
  });
}

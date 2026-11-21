import type { Project, Shot } from '../../domain/types';

export const FPS = 24;
export interface TimelineEntry { shot: Shot; index: number; start: number; end: number; startMs: number; endMs: number; frames: number }

/** Round cumulative boundaries, never add individually rounded milliseconds. */
export function buildTimeline(shots: Shot[]): TimelineEntry[] {
  let seconds = 0;
  return shots.map((shot, index) => {
    if (!Number.isFinite(shot.duration) || shot.duration <= 0) throw new Error(`第 ${shot.number} 镜时长无效。`);
    const start = seconds;
    seconds += shot.duration;
    return { shot, index, start, end: seconds, startMs: Math.round(start * 1000), endMs: Math.round(seconds * 1000), frames: Math.round(shot.duration * FPS) };
  });
}

export function locateTime(timeline: TimelineEntry[], seconds: number) {
  if (!timeline.length) return undefined;
  const total = timeline[timeline.length - 1].end;
  const time = Math.max(0, Math.min(Number.isFinite(seconds) ? seconds : 0, total));
  const entry = timeline.find(item => time < item.end) ?? timeline[timeline.length - 1];
  return { ...entry, localTime: time - entry.start };
}

export function projectIssues(project: Project): string[] {
  const issues: string[] = [];
  if (project.shots.length !== 10) issues.push('需要完整的 10 镜分镜。');
  if (new Set(project.shots.map(shot => shot.id)).size !== project.shots.length) issues.push('镜头 ID 重复，请修复分镜。');
  try {
    const timeline = buildTimeline(project.shots);
    if (Math.abs((timeline.at(-1)?.end ?? 0) - 90) > 0.001) issues.push('分镜总时长必须为 90 秒（默认每镜 9 秒）。');
    for (const { shot, frames } of timeline) {
      if (!frames || Math.abs(frames / FPS - shot.duration) > 0.000001) issues.push(`第 ${shot.number} 镜时长无法对齐 24 fps，请使用整数秒或 1/24 秒的倍数。`);
    }
  } catch (error) { issues.push((error as Error).message); }
  return issues;
}

export function audioDurationIssue(actual: number, duration: number): string | undefined {
  if (!Number.isFinite(actual) || actual <= 0) return '配音文件没有有效时长，请重新导入。';
  if (actual > duration + 0.000001) return `配音实际 ${actual.toFixed(3)} 秒，超过镜头 ${duration} 秒；不会裁剪对白，请修改台词或调整语速后重新生成。`;
}

export function safeFilename(name: string): string {
  return name.replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').replace(/^\.+|\.+$/g, '').trim().slice(0, 100) || 'untitled';
}

export function formatTime(seconds: number): string {
  const ticks = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 100);
  return `${Math.floor(ticks / 6000).toString().padStart(2, '0')}:${((ticks % 6000) / 100).toFixed(2).padStart(5, '0')}`;
}

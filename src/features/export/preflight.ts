import type { Project } from '../../domain/types';
import type { MediaReport } from '../../lib/media/inputs';

export interface PreflightItem { level: 'red' | 'yellow'; message: string }
export interface PreflightResult { red: PreflightItem[]; yellow: PreflightItem[]; canExport: boolean; checked: boolean }

const list = (numbers: number[]) => numbers.join('、');

/** 基于 inspectProject 的结果分类：红色阻止导出，黄色需要人工勾选确认。 */
export function buildPreflight(project: Project, report?: MediaReport): PreflightResult {
  const red: string[] = [];
  const yellow: string[] = [];
  if (!project.shots.length) red.push(`需要完整的分镜，当前 ${project.shots.length} 镜。`);
  const total = project.shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (!Number.isFinite(total) || total < 20 || total > 400) red.push(`总时长需要在 20–400 秒之间，当前 ${Number(total.toFixed(2))} 秒。`);
  const invalidDuration = project.shots.filter(shot => !Number.isFinite(shot.duration) || shot.duration <= 0 || shot.duration > 30 || Math.abs(shot.duration * 2 - Math.round(shot.duration * 2)) > 1e-9).map(shot => shot.number);
  if (invalidDuration.length) red.push(`时长必须是 0.5 秒的整数倍且不超过 30 秒：第 ${list(invalidDuration)} 镜。`);
  const missingVideo = project.shots.filter(shot => !shot.video).map(shot => shot.number);
  if (missingVideo.length) red.push(`缺少视频：第 ${list(missingVideo)} 镜。`);
  const missingAudio = project.shots.filter(shot => shot.audioMode === 'dubbing' && shot.dialogues.some(line => line.text.trim()) && !shot.audio).map(shot => shot.number);
  if (missingAudio.length) red.push(`后期配音模式但缺少配音轨：第 ${list(missingAudio)} 镜。`);
  const overrun = (report?.shots ?? []).filter(item => typeof item.audioDuration === 'number' && item.audioDuration > item.shot.duration + 0.000001).map(item => item.shot.number);
  if (overrun.length) red.push(`配音超过镜头时长，不会裁剪对白：第 ${list(overrun)} 镜。`);
  const stale = project.shots.filter(shot => shot.stale).map(shot => shot.number);
  if (stale.length) red.push(`素材待更新，请重新生成或确认：第 ${list(stale)} 镜。`);
  const invalidMode = project.shots.filter(shot => !['silent', 'dubbing', 'original'].includes(shot.audioMode)).map(shot => shot.number);
  if (invalidMode.length) red.push(`音频模式无效：第 ${list(invalidMode)} 镜。`);
  for (const issue of report?.issues ?? []) red.push(issue);
  for (const item of report?.shots ?? []) for (const issue of item.issues) red.push(`第 ${item.shot.number} 镜：${issue}`);
  const padding = (report?.shots ?? []).filter(item => typeof item.videoDuration === 'number' && item.videoDuration < item.shot.duration).map(item => item.shot.number);
  if (padding.length) yellow.push(`源视频短于镜头时长，将用最后一帧补足：第 ${list(padding)} 镜。`);
  const cutting = (report?.shots ?? []).filter(item => typeof item.videoDuration === 'number' && item.videoDuration > item.shot.duration).map(item => item.shot.number);
  if (cutting.length) yellow.push(`源视频长于镜头时长，将从开头截取：第 ${list(cutting)} 镜。`);
  const original = project.shots.filter(shot => shot.audioMode === 'original' && shot.dialogues.some(line => line.text.trim())).map(shot => shot.number);
  if (original.length) yellow.push(`原声模式会保留视频原声，请确认与台词一致：第 ${list(original)} 镜。`);
  const unique = (items: string[]) => [...new Set(items)];
  const redItems = unique(red).map(message => ({ level: 'red' as const, message }));
  return { red: redItems, yellow: unique(yellow).map(message => ({ level: 'yellow' as const, message })), canExport: !!report && redItems.length === 0, checked: !!report };
}

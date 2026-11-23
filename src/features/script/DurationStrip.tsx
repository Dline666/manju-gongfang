import type { Project } from '../../domain/types';
import { speakerName } from '../../domain/types';
import { estimateDialogueSeconds } from './screenplay';

export const MIN_SHOT_SECONDS = 0.5;
export const MAX_SHOT_SECONDS = 30;

export interface DurationRow { shot: Project['shots'][number]; needed: number; invalid: boolean; short: boolean }
export function durationRows(project: Project): DurationRow[] {
  return project.shots.map(shot => {
    const first = shot.dialogues[0];
    const name = first ? speakerName(project, first) : '';
    const speaker = first
      ? project.assets.find(asset => asset.id === first.speakerId) || project.assets.find(asset => asset.kind === 'character' && asset.name === name)
      : undefined;
    const voice = project.assets.find(asset => asset.id === speaker?.voiceAssetId);
    const speed = voice?.speed ?? 1;
    // 按拍摄标准的字数→时长表逐句估算，语速作为快慢倍率。
    const spoken = shot.dialogues.map(line => line.text.trim()).filter(Boolean);
    const needed = spoken.length
      ? spoken.reduce((sum, text) => sum + estimateDialogueSeconds(text), 0) / speed
      : 0;
    const invalid = !Number.isFinite(shot.duration) || shot.duration < MIN_SHOT_SECONDS || shot.duration > MAX_SHOT_SECONDS;
    const short = needed > shot.duration;
    return { shot, needed, invalid, short };
  });
}

export default function DurationStrip({ project }: { project: Project }) {
  const total = project.shots.reduce((sum, shot) => sum + shot.duration, 0);
  const rows = durationRows(project);
  return <section className="duration-strip" aria-label="剧本时长表">
    <div className="duration-cells">{rows.map(({ shot, needed, invalid, short }) => <span key={shot.id} className={`duration-cell ${invalid ? 'is-invalid' : short ? 'is-short' : ''}`} title={invalid ? '时长需在 0.5–30 秒之间' : short ? `台词约需 ${needed.toFixed(1)} 秒，当前时长不够` : `台词约需 ${needed.toFixed(1)} 秒`}>{shot.number}:{shot.duration}s{short ? ' 不够' : ''}</span>)}</div>
    <span className={`small ${total < 20 || total > 400 ? 'text-[#e88b93]' : 'muted'}`}>合计 {Number(total.toFixed(1))} 秒{total < 20 || total > 400 ? '（超出 20–400 秒区间）' : ''}</span>
  </section>;
}

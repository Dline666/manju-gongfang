import type { Project } from '../../domain/types';

const SPEED = 4;

export interface DurationRow { shot: Project['shots'][number]; needed: number; invalid: boolean; short: boolean }
export function durationRows(project: Project): DurationRow[] {
  return project.shots.map(shot => {
    const text = shot.dialogues.map(line => line.text).join('');
    const speaker = project.assets.find(asset => asset.id === shot.dialogues[0]?.speakerId);
    const voice = project.assets.find(asset => asset.id === speaker?.voiceAssetId);
    const speed = voice?.speed ?? 1;
    const needed = text ? text.length / (SPEED * speed) + 1 : 0;
    const invalid = !Number.isInteger(shot.duration) || shot.duration < 4 || shot.duration > 15;
    const short = text.length > 0 && needed > shot.duration;
    return { shot, needed, invalid, short };
  });
}

export default function DurationStrip({ project }: { project: Project }) {
  const total = project.shots.reduce((sum, shot) => sum + shot.duration, 0);
  const rows = durationRows(project);
  return <section className="duration-strip" aria-label="剧本时长表">
    <div className="duration-cells">{rows.map(({ shot, needed, invalid, short }) => <span key={shot.id} className={`duration-cell ${invalid ? 'is-invalid' : short ? 'is-short' : ''}`} title={invalid ? '时长必须是 4–15 秒的整数' : short ? `台词约需 ${needed.toFixed(1)} 秒，当前时长不够` : `台词约需 ${needed.toFixed(1)} 秒`}>{shot.number}:{shot.duration}s{short ? ' 不够' : ''}</span>)}</div>
    <span className={`small ${Math.abs(total - 90) > 0.001 ? 'text-[#e88b93]' : 'muted'}`}>合计 {Number(total.toFixed(2))} / 90 秒{Math.abs(total - 90) > 0.001 ? `（差 ${Number((90 - total).toFixed(2))} 秒）` : ''}</span>
  </section>;
}

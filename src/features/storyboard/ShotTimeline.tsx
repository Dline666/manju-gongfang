import type { Project, Shot } from '../../domain/types';

const labels = { ready: '已完成', stale: '待更新', missing: '缺失', failed: '失败' } as const;
type TimelineState = keyof typeof labels;

export function timelineState(shot: Shot): TimelineState {
  if (shot.task?.status === 'failed' || shot.task?.status === 'unknown') return 'failed';
  if (shot.video && !shot.stale) return 'ready';
  if (shot.stale) return 'stale';
  return 'missing';
}

export default function ShotTimeline({ project, onLocate }: { project: Project; onLocate: (shotId: string) => void }) {
  const total = project.shots.reduce((sum, shot) => sum + shot.duration, 0);
  return <section className="shot-timeline" aria-label="分镜时间轴">
    <div className="shot-timeline-track">
      {project.shots.map(shot => {
        const state = timelineState(shot);
        return <button key={shot.id} type="button" className={`shot-timeline-block is-${state}`} style={{ flexGrow: shot.duration }} title={`第${shot.number}镜 · ${shot.duration}秒 · ${labels[state]}`} aria-label={`第${shot.number}镜 · ${shot.duration}秒 · ${labels[state]}`} onClick={() => onLocate(shot.id)}><span>{shot.number}</span></button>;
      })}
    </div>
    <span className="small muted">合计 {Number(total.toFixed(2))} 秒</span>
  </section>;
}

import type { Project } from '../../domain/types';
import { speakerName } from '../../domain/types';
import { usesShotSpec } from '../../domain/flow';
import { estimateDialogueSeconds, SHOT_COUNT_RANGE, SHOT_DURATION_RANGE, TOTAL_DURATION_RANGE, type ShotSpecResult } from '../../lib/screenplay';

export const MIN_SHOT_SECONDS = 0.5;
export const MAX_SHOT_SECONDS = 30;
/** 新规格下的单镜时长区间：10–15 秒。 */
export const SPEC_MIN_SHOT_SECONDS = SHOT_DURATION_RANGE.min;
export const SPEC_MAX_SHOT_SECONDS = SHOT_DURATION_RANGE.max;
/** 新规格下的总时长区间：40–90 秒。 */
export const SPEC_MIN_TOTAL_SECONDS = TOTAL_DURATION_RANGE.min;
export const SPEC_MAX_TOTAL_SECONDS = TOTAL_DURATION_RANGE.max;

export interface DurationRow { shot: Project['shots'][number]; needed: number; invalid: boolean; short: boolean }

export function durationRows(project: Project): DurationRow[] {
  // 新规格的作品按 10–15 秒判红；旧作品仍按原来的 0.5–30 秒，不被新规则误伤。
  const spec = usesShotSpec(project);
  const min = spec ? SPEC_MIN_SHOT_SECONDS : MIN_SHOT_SECONDS;
  const max = spec ? SPEC_MAX_SHOT_SECONDS : MAX_SHOT_SECONDS;
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
    const invalid = !Number.isFinite(shot.duration) || shot.duration < min || shot.duration > max;
    const short = needed > shot.duration;
    return { shot, needed, invalid, short };
  });
}

export default function DurationStrip({ project }: { project: Project }) {
  const spec = usesShotSpec(project);
  const minTotal = spec ? SPEC_MIN_TOTAL_SECONDS : 20;
  const maxTotal = spec ? SPEC_MAX_TOTAL_SECONDS : 400;
  const total = project.shots.reduce((sum, shot) => sum + shot.duration, 0);
  const rows = durationRows(project);
  return <section className="duration-strip" aria-label="剧本时长表">
    <div className="duration-cells">{rows.map(({ shot, needed, invalid, short }) => <span key={shot.id} className={`duration-cell ${invalid ? 'is-invalid' : short ? 'is-short' : ''}`} title={invalid ? (spec ? `单镜时长需在 ${SPEC_MIN_SHOT_SECONDS}–${SPEC_MAX_SHOT_SECONDS} 秒之间` : '时长需在 0.5–30 秒之间') : short ? `台词约需 ${needed.toFixed(1)} 秒，当前时长不够` : `台词约需 ${needed.toFixed(1)} 秒`}>{shot.number}:{shot.duration}s{short ? ' 不够' : ''}</span>)}</div>
    <span className={`small ${total < minTotal || total > maxTotal ? 'text-[#e88b93]' : 'muted'}`}>合计 {Number(total.toFixed(1))} 秒{total < minTotal || total > maxTotal ? `（超出 ${minTotal}–${maxTotal} 秒区间）` : ''}</span>
  </section>;
}

/**
 * 剧本正文的镜头时长表：还没进导演步骤时，先让用户看见剧本自己声明了几镜、每镜多少秒。
 * 按新规格标红：没写时长（未声明）或不在 10–15 秒之间的镜一眼就能看出来。
 */
export function ScreenplayDurationTable({ result }: { result: ShotSpecResult }) {
  const total = result.total;
  const outOfRange = total < TOTAL_DURATION_RANGE.min || total > TOTAL_DURATION_RANGE.max;
  return <section className="duration-strip" aria-label="剧本镜头时长表">
    <div className="duration-cells">{result.shots.map(shot => {
      const invalid = shot.duration === undefined || shot.duration < SHOT_DURATION_RANGE.min || shot.duration > SHOT_DURATION_RANGE.max;
      const label = shot.duration === undefined ? '未声明' : `${shot.duration}s`;
      return <span key={shot.index} className={`duration-cell ${invalid ? 'is-invalid' : ''}`} title={invalid ? (shot.duration === undefined ? '这一镜没有写时长标记（时长12s）' : `单镜时长需在 ${SHOT_DURATION_RANGE.min}–${SHOT_DURATION_RANGE.max} 秒之间，当前 ${shot.duration} 秒`) : `第${shot.index}镜 ${shot.duration} 秒`}>{shot.number ?? shot.index}:{label}</span>;
    })}</div>
    <span className={`small ${outOfRange ? 'text-[#e88b93]' : 'muted'}`}>
      {result.shots.length} 镜 · 合计 {total} 秒{outOfRange ? `（超出 ${TOTAL_DURATION_RANGE.min}–${TOTAL_DURATION_RANGE.max} 秒区间）` : ''}
    </span>
  </section>;
}

/** 规格说明：界面上给用户看的一句话。 */
export const SHOT_SPEC_TEXT = `${SHOT_COUNT_RANGE.min}–${SHOT_COUNT_RANGE.max} 镜 · 每镜 ${SHOT_DURATION_RANGE.min}–${SHOT_DURATION_RANGE.max} 秒 · 总时长 ${TOTAL_DURATION_RANGE.min}–${TOTAL_DURATION_RANGE.max} 秒`;

import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { Pause, Play, SkipBack } from 'lucide-react';
import { Button, HelpPopover } from '../../components/Ui';
import type { MediaReport } from '../../lib/media/inputs';
import { buildTimeline, formatTime, locateTime } from '../../lib/media/timeline';

function waitFor(media: HTMLMediaElement, event: 'loadeddata' | 'seeked', signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('已取消', 'AbortError'));
  if (event === 'loadeddata' && media.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); media.removeEventListener(event, ready); media.removeEventListener('error', error); signal.removeEventListener('abort', abort); };
    const ready = () => { clean(); resolve(); };
    const error = () => { clean(); reject(new Error('预览素材无法播放，请本地重新导入标准视频/音频。')); };
    const abort = () => { clean(); reject(new DOMException('已取消', 'AbortError')); };
    const timer = setTimeout(() => { clean(); reject(new Error('预览加载超时，请重新检查素材。')); }, 15000);
    media.addEventListener(event, ready, { once: true });
    media.addEventListener('error', error, { once: true });
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function setPosition(media: HTMLMediaElement, seconds: number, signal: AbortSignal) {
  await waitFor(media, 'loadeddata', signal);
  const target = Math.max(0, Math.min(seconds, media.duration - 0.04));
  if (Math.abs(media.currentTime - target) > 0.015) {
    const done = waitFor(media, 'seeked', signal);
    media.currentTime = target;
    await done;
  }
}

/** One shared clock for picture and separate dubbing; no autoplay before a user click. */
export default function TimelinePreview({ report }: { report: MediaReport }) {
  const timeline = useMemo(() => {
    try { return buildTimeline(report.shots.map(item => item.shot)); } catch { return []; }
  }, [report]);
  const [urls, setUrls] = useState<{ video?: string; audio?: string }[]>([]);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const running = useRef(false);
  const intent = useRef(false);
  const playhead = useRef(0);
  const anchor = useRef({ time: 0, wall: 0 });
  const frame = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const syncRef = useRef<(target: number, resume: boolean) => void>(() => {});
  const total = timeline.at(-1)?.end ?? 0;
  const location = locateTime(timeline, time);
  const canPreview = timeline.length > 0 && report.shots.every(item => item.video && (item.shot.audioMode !== 'dubbing' || item.audio));

  function pause() {
    intent.current = running.current = false;
    controller.current?.abort();
    cancelAnimationFrame(frame.current);
    video.current?.pause(); audio.current?.pause();
    setPlaying(false); setLoading(false);
  }

  useEffect(() => {
    const next = report.shots.map(item => ({ video: item.video ? URL.createObjectURL(item.video) : undefined, audio: item.audio ? URL.createObjectURL(item.audio) : undefined }));
    setUrls(next); setTime(0); playhead.current = 0; setError('');
    setPlaying(false); setLoading(false);
    return () => {
      intent.current = running.current = false;
      controller.current?.abort(); cancelAnimationFrame(frame.current);
      video.current?.pause(); audio.current?.pause();
      next.forEach(item => { if (item.video) URL.revokeObjectURL(item.video); if (item.audio) URL.revokeObjectURL(item.audio); });
    };
  }, [report]);

  function tick(now: number) {
    if (!running.current) return;
    const current = locateTime(timeline, anchor.current.time);
    if (!current) return;
    const target = anchor.current.time + (now - anchor.current.wall) / 1000;
    if (target >= current.end) {
      if (current.index === timeline.length - 1) {
        pause(); playhead.current = total; setTime(total);
      } else syncRef.current(current.end, true);
      return;
    }
    playhead.current = target;
    setTime(target);
    const local = target - current.start;
    const v = video.current;
    const a = audio.current;
    if (v) {
      if (local >= v.duration) v.pause(); // Keep the last decoded frame until this shot ends.
      else if (!v.seeking && Math.abs(v.currentTime - local) > 0.2) v.currentTime = local;
    }
    if (a && current.shot.audioMode === 'dubbing') {
      if (local >= a.duration) a.pause(); // Short dubbing leaves silence, never repeats.
      else if (!a.seeking && Math.abs(a.currentTime - local) > 0.15) a.currentTime = local;
    }
    frame.current = requestAnimationFrame(tick);
  }

  async function synchronize(target: number, resume: boolean) {
    controller.current?.abort();
    const control = new AbortController(); controller.current = control;
    running.current = false; intent.current = resume;
    cancelAnimationFrame(frame.current);
    video.current?.pause(); audio.current?.pause();
    const current = locateTime(timeline, target);
    const v = video.current; const a = audio.current;
    if (!current || !v || !a) return;
    playhead.current = Math.min(total, Math.max(0, target)); setTime(playhead.current);
    setLoading(true); setPlaying(resume); setError('');
    try {
      const source = urls[current.index];
      if (!source?.video) throw new Error(`第 ${current.shot.number} 镜缺少当前可播放的视频。`);
      if (v.src !== source.video) { v.src = source.video; v.load(); }
      v.muted = current.shot.audioMode !== 'original';
      await setPosition(v, Math.min(current.localTime, Math.max(0, current.shot.duration - 1 / 24)), control.signal);
      if (current.shot.audioMode === 'dubbing') {
        if (!source.audio) throw new Error(`第 ${current.shot.number} 镜缺少替换配音。`);
        if (a.src !== source.audio) { a.src = source.audio; a.load(); }
        await setPosition(a, current.localTime, control.signal);
      }
      if (control.signal.aborted) return;
      if (resume && target < total) {
        await Promise.all([
          current.localTime < v.duration ? v.play() : Promise.resolve(),
          current.shot.audioMode === 'dubbing' && current.localTime < a.duration ? a.play() : Promise.resolve(),
        ]);
        if (control.signal.aborted) return;
        anchor.current = { time: target, wall: performance.now() };
        running.current = true;
        frame.current = requestAnimationFrame(tick);
      } else { setPlaying(false); intent.current = false; }
    } catch (caught) {
      if (control.signal.aborted) return;
      pause();
      setError(caught instanceof Error ? caught.message : '浏览器阻止播放，请点击开始重试。');
    } finally { if (!control.signal.aborted) setLoading(false); }
  }
  syncRef.current = (target, resume) => { void synchronize(target, resume); };

  function bufferPause(event: SyntheticEvent<HTMLMediaElement>) {
    const media = event.currentTarget;
    if (!running.current || (!media.error && (media.seeking || media.readyState >= 3))) return;
    pause();
    setError('素材缓冲中，画面与配音已一起暂停；加载后请点击继续。');
  }

  return <section className="panel stack" aria-label="连续时间轴预览">
    <div className="section-title"><div className="row"><h2>连续时间轴预览</h2><HelpPopover label="连续预览说明"><p>点击开始后按镜头时长连续播放；短视频停留最后一帧，短配音结束后静音。切镜、拖动和暂停会同步独立配音。此预览不烧录字幕，以最终 MP4 预览为准。</p></HelpPopover></div><span className="tag">{formatTime(time)} / {formatTime(total)}</span></div>
    <video ref={video} playsInline preload="auto" onWaiting={bufferPause} onError={bufferPause} aria-label="镜头画面" style={{ display: 'block', width: '100%', maxHeight: 480, aspectRatio: '9 / 16', objectFit: 'contain', background: '#000' }} />
    <audio ref={audio} preload="auto" onWaiting={bufferPause} onError={bufferPause} />
    <label className="field"><span>总时间轴 · 当前第 {location?.shot.number ?? '—'} 镜</span><input aria-label="预览时间" type="range" min={0} max={total || 1} step={1 / 24} value={time} disabled={!canPreview || !urls.length} onChange={event => { void synchronize(Number(event.target.value), intent.current); }} /></label>
    <div className="toolbar">
      <Button disabled={!canPreview || !urls.length} onClick={() => { if (intent.current) pause(); else void synchronize(time >= total ? 0 : playhead.current, true); }}>{playing ? <Pause size={16} /> : <Play size={16} />}{playing ? '暂停' : time > 0 && time < total ? '继续预览' : '开始连续预览'}</Button>
      <Button variant="outline" disabled={!canPreview || !urls.length} onClick={() => { void synchronize(0, false); }}><SkipBack size={16} />回到开头</Button>
      {loading && <span className="muted" role="status">正在加载并对齐画面与配音…</span>}
    </div>
    <div className="row wrap">{timeline.map(item => <Button size="sm" variant={location?.index === item.index ? 'default' : 'outline'} key={item.shot.id} disabled={!canPreview || !urls.length} onClick={() => { void synchronize(item.start, intent.current); }}>第 {item.shot.number} 镜</Button>)}</div>
    {!canPreview && <p className="alert">补齐当前会话的视频及所选配音后，才能连续预览。</p>}
    {error && <p className="alert" role="alert">{error}</p>}
  </section>;
}

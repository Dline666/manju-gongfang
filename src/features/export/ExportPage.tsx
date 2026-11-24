import { useEffect, useRef, useState } from 'react';
import { Archive, Download, Film, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import type { PageProps } from '../../domain/types';
import { Button, Empty, Fold, HelpPopover, downloadBlob } from '../../components/Ui';
import { PageHeader } from '../../components/PageHeader';
import PreflightDialog from './PreflightDialog';
import { errorMessage } from '../../lib/api';
import { inspectProject, type MediaReport } from '../../lib/media/inputs';
import { buildMaterialZip } from '../../lib/media/archive';
import { useStudio } from '../../store/studio';
import { formatTime, safeFilename } from '../../lib/media/timeline';
import type { RenderProgress } from '../../lib/media/encoder';
import TimelinePreview from './TimelinePreview';

const audioNames = { original: '保留视频原声', dubbing: '配音完全替换原声', silent: '无台词静音' };
type Job = 'mp4' | 'zip';

export default function ExportPage({ project, navigate }: PageProps) {
  const { settings } = useStudio();
  const [report, setReport] = useState<MediaReport>();
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState('');
  const [error, setError] = useState('');
  const [job, setJob] = useState<Job>();
  const [progress, setProgress] = useState<Pick<RenderProgress, 'stage' | 'message' | 'encodedSeconds'> | { stage: string; message: string }>();
  const [mp4, setMp4] = useState<Blob>();
  const [zip, setZip] = useState<Blob>();
  const [outputUrl, setOutputUrl] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [reload, setReload] = useState(0);
  const task = useRef<AbortController | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; task.current?.abort(); }; }, []);
  useEffect(() => {
    const control = new AbortController();
    task.current?.abort(); task.current = undefined;
    setJob(undefined); setProgress(undefined); setMp4(undefined); setZip(undefined);
    setConfirm(false); setReport(undefined); setError(''); setChecking(true);
    setCheckMessage('正在读取当前会话媒体…');
    void inspectProject(project, number => { if (!control.signal.aborted) setCheckMessage(`正在检查第 ${number} 镜视频与配音…`); }, control.signal)
      .then(value => { if (!control.signal.aborted) setReport(value); })
      .catch(caught => { if (!control.signal.aborted) setError(errorMessage(caught)); })
      .finally(() => { if (!control.signal.aborted) setChecking(false); });
    return () => { control.abort(); task.current?.abort(); };
  }, [project, reload]);
  useEffect(() => {
    if (!mp4) { setOutputUrl(undefined); return; }
    const url = URL.createObjectURL(mp4); setOutputUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [mp4]);

  async function start(kind: Job) {
    if (task.current || checking || !report?.ready) return;
    const control = new AbortController(); task.current = control;
    setConfirm(false); setJob(kind); setError(''); setProgress(undefined);
    if (kind === 'mp4') setMp4(undefined); else setZip(undefined);
    try {
      if (kind === 'mp4') {
        const { renderProject } = await import('../../lib/media/encoder');
        if (control.signal.aborted) return;
        const blob = await renderProject(project, value => { if (!control.signal.aborted) setProgress(value); }, control.signal);
        if (!control.signal.aborted && alive.current) { setMp4(blob); toast.success('真实 MP4 已生成，请预览后下载。'); }
      } else {
        const blob = await buildMaterialZip(project, value => { if (!control.signal.aborted) setProgress(value); }, control.signal, settings.promptTemplates);
        if (!control.signal.aborted && alive.current) { setZip(blob); toast.success('完整素材 ZIP 已生成。'); }
      }
    } catch (caught) {
      if (control.signal.aborted) {
        if (alive.current && task.current === control) { setProgress({ stage: 'cancelled', message: kind === 'mp4' ? '已取消，已启动的编码 Worker 会被终止；下次编码重新加载。' : '已取消打包，未生成完整素材包。' }); toast.info('已取消导出'); }
      } else if (alive.current && task.current === control) { setError(errorMessage(caught)); toast.error('导出未完成，请检查下方说明。'); }
    } finally {
      if (task.current === control) { task.current = undefined; if (alive.current) setJob(undefined); }
    }
  }

  const readyCount = report?.shots.filter(item => item.issues.length === 0 && item.video?.size).length ?? 0;
  const disabled = checking || !!job;
  const shotCards = <div className="grid-2">{(report?.shots ?? project.shots.map(shot => ({ shot, issues: [] }))).map(item => <article className="panel stack" key={item.shot.id}>
    <div className="section-title"><strong>第 {item.shot.number} 镜 · {item.shot.duration} 秒</strong><span className="tag">{!report ? '检查中' : item.issues.length ? '需处理' : '素材可读'}</span></div>
    <span className="muted">{audioNames[item.shot.audioMode]} · {item.shot.video?.name || '缺少视频'}</span>
    {'videoDuration' in item && typeof item.videoDuration === 'number' && <span className="muted">源视频 {formatTime(item.videoDuration)} → 时间轴 {formatTime(item.shot.duration)}；{item.videoDuration < item.shot.duration ? '末帧补足' : item.videoDuration > item.shot.duration ? '从开头截取' : '保持时长'}</span>}
    {'audioDuration' in item && typeof item.audioDuration === 'number' && <span className="muted">实测配音 {item.audioDuration.toFixed(3)} 秒</span>}
    {item.issues.map(issue => <p key={issue} className="alert">{issue}</p>)}
  </article>)}</div>;
  const hasShotIssues = !!report?.shots.some(item => item.issues.length);
  if (!project.shots.length) return <Empty title="还没有可导出的分镜" text="先完成十镜分镜，再到生成页导入或生成视频与配音。"><Button onClick={() => navigate('storyboard')}>前往分镜</Button></Empty>;

  return <div className="stack">
    <PageHeader title="预览与导出" help={<HelpPopover label="导出说明" title="预览与导出"><p>全部分镜同一时间轴 · 720 × 1280 · 24 fps · H.264 / AAC。</p><p className="mt-2">视频仅在内存中保留，刷新后本地视频需重新导入。空文件、缺失配音、过期素材不能算就绪。</p></HelpPopover>} actions={<Button variant="outline" disabled={!!job} onClick={() => navigate('generation')}>返回生成 / 重新导入</Button>} />
    {report && <TimelinePreview report={report} />}
    <section className="panel stack">
      <div className="section-title"><div className="row"><h2>导出文件</h2><HelpPopover title="导出说明"><p>ZIP 保留原始逐镜视频、所有已关联配音与参考图、SRT、五份文档和不含密钥的 manifest.json；缺任何已关联素材均阻止完整包。不是剪映专有工程。字幕按对白均分估算，不烧录进 MP4，需手工校对。</p><p className="mt-2">MP4 生成还会由 FFmpeg 检查真实音视频轨道；“素材可读”不代表编码已成功。只显示当前实际阶段，不提供推测的总体百分比。</p><p className="mt-2">编码组件：ffmpeg.wasm wrapper（MIT）与单线程 core（GPL-2.0-or-later）。<a href={`${import.meta.env.BASE_URL}ffmpeg/SOURCE-AND-LICENSE.txt`} target="_blank" rel="noreferrer">许可证与源码获取说明</a></p></HelpPopover></div><span className="tag">{readyCount} / {project.shots.length} 镜通过素材检查</span></div>
      <details className="alert"><summary><strong>画面与音频处理规则</strong></summary><ul><li>画面等比例缩放、黑边填充，不拉伸。长视频只取前「镜头时长」秒；短视频用最后一帧补足。</li><li>原声模式保留视频原声；替换配音模式彻底移除原声，使用独立配音；无台词可选静音。短音频用静音补齐。</li><li>配音超时会阻止导出，不裁剪对白。请返回生成页修改台词或调整语速后重试。原声随视频时长截取。</li><li>逐镜处理以降低内存占用，但浏览器仍需容纳源素材、中间片段及最终文件；生成期间请勿刷新或切页。</li></ul></details>
      <div className="toolbar">
        <Button disabled={disabled || !report} onClick={() => setConfirm(true)}><Film size={16} />生成真实 MP4</Button>
        <Button variant="outline" disabled={disabled || !report?.ready} onClick={() => { void start('zip'); }}><Archive size={16} />生成完整素材 ZIP</Button>
        {job && <Button variant="outline" onClick={() => task.current?.abort()}><X size={16} />取消{job === 'mp4' ? '编码' : '打包'}</Button>}
      </div>
      {progress && <div role="status" aria-live="polite" className="panel"><strong>{progress.message}</strong>{'encodedSeconds' in progress && typeof progress.encodedSeconds === 'number' && <p className="muted">FFmpeg 报告当前镜输出时间：{progress.encodedSeconds.toFixed(2)} 秒（非整体进度）</p>}</div>}
      {error && <pre role="alert" className="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{error}</pre>}
      {zip && <div className="row"><span>完整素材包已生成 · {(zip.size / 1024 / 1024).toFixed(1)} MB</span><Button variant="outline" onClick={() => downloadBlob(zip, `${safeFilename(project.name)}-素材包.zip`)}><Download size={16} />下载 ZIP</Button></div>}
    </section>
    <section className="panel stack">
      <div className="section-title"><h2>当前媒体检查</h2><div className="row"><Button variant="outline" disabled={disabled} onClick={() => setReload(value => value + 1)}><RefreshCw size={16} />重新检查素材</Button>{checking && <span role="status">{checkMessage}</span>}</div></div>
      {report?.issues.map(issue => <p key={issue} className="alert">{issue}</p>)}
      {hasShotIssues ? shotCards : <Fold title="逐镜素材检查" meta={`${readyCount} / ${project.shots.length} 镜通过`}>{shotCards}</Fold>}
    </section>
    {mp4 && outputUrl && <section className="panel stack"><div className="section-title"><h2>最终 MP4 预览</h2><span className="tag">{(mp4.size / 1024 / 1024).toFixed(1)} MB</span></div><video src={outputUrl} controls playsInline preload="metadata" aria-label="最终 MP4 预览" style={{ width: '100%', maxHeight: 560, background: '#000', objectFit: 'contain' }} /><Button onClick={() => downloadBlob(mp4, `${safeFilename(project.name)}.mp4`)}><Download size={16} />下载 MP4</Button></section>}
    <PreflightDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void start('mp4'); }} project={project} report={report} disabled={disabled} />
  </div>;
}

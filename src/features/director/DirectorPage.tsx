import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, ChevronRight, Sparkles, WandSparkles } from 'lucide-react';
import { Button, Empty, ErrorNote, Field, Fold, HelpPopover, IssueList, Modal, ProgressPanel } from '../../components/Ui';
import DurationStrip from '../script/DurationStrip';
import { normalizeDirector, type GeneratedDirector } from '../script/creation';
import { directorPrompt } from '../../lib/prompts';
import { callApi, credentials, errorMessage } from '../../lib/api';
import { getStudio, updateProject, useStudio } from '../../store/studio';
import { finishJob, startJob, updateJob } from '../../store/jobs';
import { validateDirectorStage, withConfirmation } from '../../domain/flow';
import { fillStoryboard } from '../storyboard/helpers';
import type { PageProps, Project, Shot } from '../../domain/types';
import { speakerName } from '../../domain/types';

type Confirmation = { prompt: string; defaultPrompt: string; provider: string; model: string; project: Project };

export default function DirectorPage({ project, navigate }: PageProps) {
  const { settings } = useStudio();
  const issues = validateDirectorStage(project);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ stage: string; startedAt: number }>();
  const [failure, setFailure] = useState<unknown>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | undefined>(undefined);
  const toggleShot = (id: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allOpen = project.shots.length > 0 && project.shots.every(shot => expanded.has(shot.id));
  const toggleAll = () => setExpanded(allOpen ? new Set() : new Set(project.shots.map(shot => shot.id)));
  const edit = (id: string, patch: Partial<Shot>) => updateProject(project.id, p => ({ ...p, storyboardReady: false, shots: p.shots.map(shot => shot.id === id ? { ...shot, ...patch } : shot) }), true);
  const localFill = () => {
    updateProject(project.id, p => ({ ...p, storyboardReady: false, shots: fillStoryboard(p.shots).map(shot => ({ ...shot, camera: shot.camera.trim() || '中景·固定·平视' })) }), true);
    toast.success('已本地补全开场、动作、终点与默认运镜，请逐镜审核。');
  };
  const prepare = () => {
    try {
      const auth = credentials(settings.scriptProvider, 'script');
      const prompt = directorPrompt(project);
      setFailure(undefined);
      setConfirmation({ prompt, defaultPrompt: prompt, provider: settings.scriptProvider, model: auth.model, project: structuredClone(project) });
    } catch (error) { toast.error(errorMessage(error)); }
  };
  const generate = async () => {
    if (!confirmation || busy) return;
    const task = confirmation;
    if (!task.prompt.trim()) { toast.error('提示词不能为空：请在模板编辑器里添加内容。'); return; }
    setBusy(true); setFailure(undefined);
    const controller = new AbortController(); abortRef.current = controller;
    const jobId = startJob({ kind: 'director', label: '生成导演分镜', cancel: () => controller.abort() });
    setProgress({ stage: '提交任务', startedAt: Date.now() });
    try {
      const auth = credentials(task.provider, 'script');
      const current = getStudio().projects.find(p => p.id === project.id);
      if (!current || current.revision !== task.project.revision) throw new Error('剧本或资产已修改，请重新确认。');
      updateJob(jobId, { detail: '模型生成中' });
      setProgress(previous => previous && { ...previous, stage: '模型生成中' });
      const data = await callApi<GeneratedDirector>('director', { ...auth, prompt: task.prompt }, controller.signal);
      setProgress(previous => previous && { ...previous, stage: '校验结构' });
      const latest = getStudio().projects.find(p => p.id === project.id);
      if (!latest || latest.revision !== task.project.revision) throw new Error('作品已修改，本次结果未覆盖现有内容。');
      const shots = normalizeDirector(data, latest);
      updateProject(project.id, p => ({ ...p, shots }), true);
      finishJob(jobId, 'done');
      setProgress(undefined);
      setConfirmation(undefined);
      toast.success('导演分镜已生成，请逐镜审核。');
    } catch (error) {
      finishJob(jobId, controller.signal.aborted ? 'canceled' : 'failed');
      setFailure(controller.signal.aborted ? new Error('取消只停止等待，服务商可能已受理并计费。') : error);
      setProgress(previous => previous && { ...previous, stage: controller.signal.aborted ? '已取消' : '失败' });
    } finally { setBusy(false); abortRef.current = undefined; }
  };
  const confirm = () => {
    const problems = validateDirectorStage(project);
    if (problems.length) { toast.error(`还有 ${problems.length} 项需要完善，请先修正。`); return; }
    updateProject(project.id, p => ({ ...p, confirmed: withConfirmation(p, 'director') }), false);
    navigate('storyboard');
  };
  if (!project.shots.length) return <Empty title="先完成剧本" text="导演步骤需要剧本里拆出的全部镜头。"><Button onClick={() => navigate('script')}>去写剧本</Button></Empty>;
  return <div className="stack">
    <header className="page-heading"><div className="page-heading-title"><h1>把剧本，拆成可拍的镜头</h1><HelpPopover label="导演分镜说明" title="导演分镜"><p>按剧本指定的画面类型补齐运镜与开场、动作、终点，不改剧情、对白和时长。</p><p className="mt-2">每镜默认只显示一行摘要，点开再逐项填写；可以用「全部展开」一次看到所有镜头。</p></HelpPopover></div><div className="row wrap"><Button variant="outline" onClick={localFill}><WandSparkles size={16} />本地补全</Button><Button onClick={prepare}><Sparkles size={16} />AI 生成分镜（先确认）</Button></div></header>
    <Fold title="剧本时长表" meta={`${project.shots.length} 镜`}><DurationStrip project={project} /></Fold>
    {issues.length > 0 ? <section className="panel stack"><div className="section-title"><h3>需要完善</h3><span className="tag">{issues.length} 项</span></div><IssueList issues={issues} /></section> : <div className="notice"><Check size={20} /><div><strong>本步已完整</strong><p>可以确认并进入分镜编排。</p></div></div>}
    <div className="toolbar"><span className="small muted">每镜默认一行摘要，点开再编辑</span><Button variant="outline" onClick={toggleAll}>{allOpen ? '全部折叠' : '全部展开'}</Button></div>
    {project.shots.map(shot => { const open = expanded.has(shot.id); return <article className={`shot-card ${open ? 'stack' : 'shot-collapsed'}`} key={shot.id} id={`shot-${shot.number}`}>
      <div className="section-title"><button type="button" className="text-button shot-summary" aria-expanded={open} onClick={() => toggleShot(shot.id)}><span className="shot-summary-line"><span className="shot-number">{String(shot.number).padStart(2, '0')}</span><span className="tag">{shot.duration} 秒</span><span className="tag">{shot.camera || '未设置景别'}</span><span className="muted small truncate">{shot.action || '待补充动作'}</span></span></button><button type="button" className="icon-button" aria-label={open ? `折叠第${shot.number}镜` : `展开第${shot.number}镜`} onClick={() => toggleShot(shot.id)}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button></div>
      {open && <>
      <div className="grid-2"><Field label="景别 · 运镜 · 机位" hint={shot.cameraHint ? `剧本指定画面类型：${shot.cameraHint}，请落实为景别与运镜` : '例如：中景·推·平视'}><input value={shot.camera} placeholder="中景·固定·平视" onChange={event => edit(shot.id, { camera: event.target.value })} /></Field><Field label="开场 / 起点"><textarea rows={2} value={shot.start} onChange={event => edit(shot.id, { start: event.target.value })} /></Field></div>
      <div className="grid-2"><Field label="动作"><textarea rows={2} value={shot.action} onChange={event => edit(shot.id, { action: event.target.value })} /></Field><Field label="终点"><textarea rows={2} value={shot.end} onChange={event => edit(shot.id, { end: event.target.value })} /></Field></div>
      <p className="small muted">对白：{shot.dialogues.length ? shot.dialogues.map(line => `${speakerName(project, line) || '未指定'}：${line.text}`).join('；') : '无对白'}</p>
      </>}
    </article>; })}
    <div className="toolbar"><Button variant="outline" onClick={() => navigate('assets')}>返回资产</Button><Button onClick={confirm}>确认并进入下一步</Button></div>
    <Modal open={!!confirmation} onClose={() => { if (!busy) { setConfirmation(undefined); setFailure(undefined); setProgress(undefined); } }} title="确认导演分镜任务" description="只发送剧本镜头与资产固定短语，不修改剧情、对白和时长。确认后调用付费文本模型。">
      {confirmation && <div className="stack"><p>{confirmation.provider} · {confirmation.model} · {project.shots.length} 镜</p><Field label="即将发送的导演提示词" hint="可直接修改，只影响本次请求；模板不会被改写。"><textarea rows={12} value={confirmation.prompt} disabled={busy} onChange={e => setConfirmation(previous => previous && { ...previous, prompt: e.target.value })} /></Field><Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmation(previous => previous && { ...previous, prompt: previous.defaultPrompt })}>恢复默认提示词</Button>{progress && <ProgressPanel title="AI 生成导演分镜" stage={progress.stage} startedAt={progress.startedAt} detail="服务商不返回进度，按已用时等待" onCancel={busy ? () => abortRef.current?.abort() : undefined} cancelLabel="取消等待" />}{failure !== undefined && <ErrorNote error={failure} />}<div className="toolbar"><Button disabled={busy || !confirmation.prompt.trim()} onClick={() => void generate()}>{busy ? '生成中，请勿重复提交…' : '确认发送并生成分镜'}</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirmation(undefined)}>取消</Button></div></div>}
    </Modal>
  </div>;
}

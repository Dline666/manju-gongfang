import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, ChevronRight, Clapperboard, Sparkles, WandSparkles } from 'lucide-react';
import { Button, Empty, ErrorNote, Field, Fold, HelpPopover, IssueList, Modal, ProgressPanel } from '../../components/Ui';
import { PageHeader } from '../../components/PageHeader';
import DurationStrip from '../script/DurationStrip';
import { normalizeDirector, rehearseShots, type GeneratedDirector } from '../script/creation';
import { directorPrompt } from '../../lib/prompts';
import { callApi, credentials, errorMessage } from '../../lib/api';
import { getStudio, updateProject, useStudio } from '../../store/studio';
import { finishJob, startJob, updateJob } from '../../store/jobs';
import { directorWarnings, validateDirectorStage, withConfirmation } from '../../domain/flow';
import { fillStoryboard } from '../storyboard/helpers';
import type { PageProps, Project, Shot } from '../../domain/types';
import { speakerName } from '../../domain/types';

type Confirmation = { prompt: string; defaultPrompt: string; provider: string; model: string; project: Project };

/**
 * 导演分镜：把剧本结构化成可拍的镜头。
 * 镜头数由模型按剧本内容决定，不预设；重跑一次就是整体替换现有镜头。
 */
export default function DirectorPage({ project, navigate }: PageProps) {
  const { settings } = useStudio();
  const issues = validateDirectorStage(project);
  const warnings = directorWarnings(project);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [rehearsing, setRehearsing] = useState(false);
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
      const prompt = directorPrompt(project, settings.promptTemplates);
      setFailure(undefined);
      setConfirmation({ prompt, defaultPrompt: prompt, provider: settings.scriptProvider, model: auth.model, project: structuredClone(project) });
    } catch (error) { toast.error(errorMessage(error)); }
  };
  /** 模板演练：不调模型，按剧本自己的结构排一版镜头，没有 Key 也能走通流程。 */
  const rehearse = () => {
    try {
      const shots = rehearseShots(project.screenplay || '');
      if (!shots.length) { toast.error('剧本里没有可排的段落：先写好场景与戏，再来排镜头。'); return; }
      updateProject(project.id, p => ({ ...p, storyboardReady: false, shots }), true);
      setRehearsing(false);
      toast.success(`已按剧本结构排出 ${shots.length} 镜（本地演练，未调用模型），请逐镜审核。`);
    } catch (error) { toast.error(errorMessage(error)); }
  };
  const generate = async () => {
    if (!confirmation || busy) return;
    const task = confirmation;
    if (!task.prompt.trim()) { toast.error('提示词不能为空：请先写好剧本正文。'); return; }
    setBusy(true); setFailure(undefined);
    const controller = new AbortController(); abortRef.current = controller;
    const jobId = startJob({ kind: 'director', label: '生成导演分镜', cancel: () => controller.abort() });
    setProgress({ stage: '提交任务', startedAt: Date.now() });
    try {
      const auth = credentials(task.provider, 'script');
      const current = getStudio().projects.find(p => p.id === project.id);
      if (!current || current.revision !== task.project.revision) throw new Error('剧本已修改，请重新确认。');
      updateJob(jobId, { detail: '模型生成中' });
      setProgress(previous => previous && { ...previous, stage: '模型生成中' });
      const data = await callApi<GeneratedDirector>('director', { ...auth, prompt: task.prompt }, controller.signal);
      setProgress(previous => previous && { ...previous, stage: '校验结构' });
      const latest = getStudio().projects.find(p => p.id === project.id);
      if (!latest || latest.revision !== task.project.revision) throw new Error('作品已修改，本次结果未覆盖现有内容。');
      const result = normalizeDirector(data, latest);
      updateProject(project.id, p => ({ ...p, shots: result.shots }), true);
      finishJob(jobId, 'done');
      setProgress(undefined);
      setConfirmation(undefined);
      toast.success(`导演分镜已生成（${result.shots.length} 镜），请逐镜审核。`);
      if (result.mismatches) toast.warning(`有 ${result.mismatches} 句对白与剧本原文不一致，请核对。`);
      if (result.unknownAssets) toast.warning(`有 ${result.unknownAssets} 处引用了不在资产清单里的资产，已跳过。`);
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
    navigate('assets');
  };
  if (!(project.screenplay || '').trim()) return <Empty title="先完成剧本" text="导演步骤需要一份剧本正文，模型会按剧本内容把它结构化成可拍的镜头。"><Button onClick={() => navigate('script')}>去写剧本</Button></Empty>;
  return <div className="stack">
    <PageHeader title="把剧本，拆成可拍的镜头" help={<HelpPopover label="导演分镜说明" title="导演分镜"><p>模型读整份剧本，按内容自己决定拆几镜，给出场景、画面、时长、景别、运镜、开场、动作、终点和对白。</p><p className="mt-2">不需要预设提示词模板：模板为空也能跑。每一镜都可以在下面手动改。</p><p className="mt-2">重新生成会整体替换现有镜头，镜数也可以随之改变。</p><p className="mt-2">没有 API Key 也能用：点「模板演练（本地）」，按剧本自己的结构排一版镜头，不联网也不消耗额度。</p></HelpPopover>} actions={<><Button variant="outline" onClick={localFill} disabled={!project.shots.length}><WandSparkles size={16} />本地补全</Button><Button variant="outline" onClick={() => project.shots.length ? setRehearsing(true) : rehearse()}><Clapperboard size={16} />模板演练（本地）</Button><Button onClick={prepare}><Sparkles size={16} />AI 生成分镜（先确认）</Button></>} />
    {project.shots.length > 0 && <Fold title="剧本时长表" meta={`${project.shots.length} 镜`}><DurationStrip project={project} /></Fold>}
    {issues.length > 0 ? <section className="panel stack"><div className="section-title"><h3>需要完善</h3><span className="tag">{issues.length} 项</span></div><IssueList issues={issues} /></section> : project.shots.length > 0 ? <div className="notice"><Check size={20} /><div><strong>本步已完整</strong><p>可以确认并进入资产设定。</p></div></div> : <div className="notice"><Sparkles size={20} /><div><strong>还没有分镜</strong><p>点「AI 生成分镜」把剧本交给模型，它会按剧本内容决定拆几镜。</p></div></div>}
    {warnings.length > 0 && <section className="panel stack"><div className="section-title"><h3>建议</h3><span className="tag subtle">{warnings.length} 项</span></div><ul className="issue-list">{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></section>}
    {project.shots.length > 0 && <div className="toolbar"><span className="small muted">每镜默认一行摘要，点开再编辑</span><Button variant="outline" onClick={toggleAll}>{allOpen ? '全部折叠' : '全部展开'}</Button></div>}
    {project.shots.map(shot => { const open = expanded.has(shot.id); return <article className={`shot-card ${open ? 'stack' : 'shot-collapsed'}`} key={shot.id} id={`shot-${shot.number}`}>
      <div className="section-title"><button type="button" className="text-button shot-summary" aria-expanded={open} onClick={() => toggleShot(shot.id)}><span className="shot-summary-line"><span className="shot-number">{String(shot.number).padStart(2, '0')}</span><span className="tag">{shot.duration} 秒</span><span className="tag">{shot.camera || '未设置景别'}</span><span className="muted small truncate">{shot.scene || shot.visual || '待补充画面'}</span></span></button><button type="button" className="icon-button" aria-label={open ? `折叠第${shot.number}镜` : `展开第${shot.number}镜`} onClick={() => toggleShot(shot.id)}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button></div>
      {open && <>
      <Field label="场景"><input value={shot.scene || ''} placeholder="外景 · 山门 — 清晨" onChange={event => edit(shot.id, { scene: event.target.value })} /></Field>
      <Field label="画面"><textarea rows={2} value={shot.visual} onChange={event => edit(shot.id, { visual: event.target.value })} /></Field>
      <div className="grid-2"><Field label="景别 · 运镜 · 机位" hint={shot.cameraHint ? `剧本指定画面类型：${shot.cameraHint}` : '例如：中景·推·平视'}><input value={shot.camera} placeholder="中景·固定·平视" onChange={event => edit(shot.id, { camera: event.target.value })} /></Field><Field label="开场 / 起点"><textarea rows={2} value={shot.start} onChange={event => edit(shot.id, { start: event.target.value })} /></Field></div>
      <div className="grid-2"><Field label="动作"><textarea rows={2} value={shot.action} onChange={event => edit(shot.id, { action: event.target.value })} /></Field><Field label="终点"><textarea rows={2} value={shot.end} onChange={event => edit(shot.id, { end: event.target.value })} /></Field></div>
      <p className="small muted">对白：{shot.dialogues.length ? shot.dialogues.map(line => `${speakerName(project, line) || '未指定'}：${line.text}`).join('；') : '无对白'}</p>
      <p className="small muted">在场资产：{shot.assetIds.length ? shot.assetIds.map(id => { const asset = project.assets.find(item => item.id === id); return asset ? `${asset.name}${shot.subjects?.includes(id) ? '（主体）' : ''}` : ''; }).filter(Boolean).join('、') : '未关联'}</p>
      </>}
    </article>; })}
    <div className="toolbar"><Button variant="outline" onClick={() => navigate('script')}>返回剧本</Button><Button onClick={confirm} disabled={!project.shots.length}>确认并进入下一步</Button></div>
    <Modal open={!!confirmation} onClose={() => { if (!busy) { setConfirmation(undefined); setFailure(undefined); setProgress(undefined); } }} title="确认导演分镜任务" description="发送剧本正文，由模型结构化出完整分镜脚本。镜数由模型按剧本内容决定；重新生成会整体替换现有镜头。确认后调用付费文本模型。">
      {confirmation && <div className="stack"><p>{confirmation.provider} · {confirmation.model}{project.shots.length ? ` · 现有 ${project.shots.length} 镜将被替换` : ''}</p><Field label="即将发送的导演提示词" hint="可直接修改，只影响本次请求；模板不会被改写。"><textarea rows={12} value={confirmation.prompt} disabled={busy} onChange={e => setConfirmation(previous => previous && { ...previous, prompt: e.target.value })} /></Field><Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmation(previous => previous && { ...previous, prompt: previous.defaultPrompt })}>恢复默认提示词</Button>{progress && <ProgressPanel title="AI 生成导演分镜" stage={progress.stage} startedAt={progress.startedAt} detail="服务商不返回进度，按已用时等待" onCancel={busy ? () => abortRef.current?.abort() : undefined} cancelLabel="取消等待" />}{failure !== undefined && <ErrorNote error={failure} />}<div className="toolbar"><Button disabled={busy || !confirmation.prompt.trim()} onClick={() => void generate()}>{busy ? '生成中，请勿重复提交…' : '确认发送并生成分镜'}</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirmation(undefined)}>取消</Button></div></div>}
    </Modal>
    <Modal open={rehearsing} onClose={() => setRehearsing(false)} title="确认模板演练" description="本地排版，不联网、不消耗额度，也不是 AI 生成。">
      {rehearsing && <div className="stack"><div className="alert">将按剧本结构整体替换现有 {project.shots.length} 镜。排出来的每一镜都能在页面上手改。</div><div className="toolbar"><Button onClick={rehearse}>确认排镜</Button><Button variant="ghost" onClick={() => setRehearsing(false)}>取消</Button></div></div>}
    </Modal>
  </div>;
}

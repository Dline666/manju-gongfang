import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Sparkles, Download, FileText, Trash2 } from 'lucide-react';
import { Button, Empty, ErrorNote, Field, IssueList, Modal, ProgressPanel, copyText, downloadBlob, errorAction } from '../../components/Ui';
import TemplateEditor from '../prompts/TemplateEditor';
import { defaultStyle, makeShot, uid, type PageProps, type Project, type Shot } from '../../domain/types';
import { validateProject } from '../../domain/validation';
import { getStudio, updateProject, useStudio } from '../../store/studio';
import { averageDuration, durationSamples, finishJob, startJob, updateJob } from '../../store/jobs';
import { ApiError, callApi, credentials, errorMessage } from '../../lib/api';
import { skills } from '../../lib/skills';
import { scriptPrompt } from '../../lib/prompts';
import { buildDocuments } from '../../lib/documents';
import { mergeDraftAssets, normalizeScript, parseScriptText, templateScript, type GeneratedScript, type ScriptDraft } from './creation';

const styles = [defaultStyle, '清新日系动画，柔和色彩与自然光', '电影写实风，克制配色与戏剧光影'];
type Confirmation = { kind: 'ai' | 'template'; project: Project; prompt: string; provider: 'gemini' | 'deepseek'; model: string };
const draftUpdate = (p: Project, draft: ScriptDraft, source: Project['source']): Project => ({ ...p, ...mergeDraftAssets(p.assets.filter(a => a.kind !== 'character'), draft), name: draft.title || p.name, source, storyboardReady: false });

export default function ScriptPage(props: PageProps) { return <ScriptEditor key={props.project.id} {...props} />; }
function ScriptEditor({ project, navigate }: PageProps) {
  const { settings, keys } = useStudio();
  const [confirm, setConfirm] = useState<Confirmation>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ stage: string; startedAt: number }>();
  const [failure, setFailure] = useState<unknown>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [preview, setPreview] = useState<{ draft: ScriptDraft; revision: number }>();
  const [remove, setRemove] = useState<Shot>();
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [documentName, setDocumentName] = useState('剧本文档.md');
  const [templateOpen, setTemplateOpen] = useState(false);
  const issues = validateProject(project);
  const total = project.shots.reduce((sum, s) => sum + s.duration, 0);
  const characters = project.assets.filter(a => a.kind === 'character');
  const sourceTag = project.source === 'template' ? '模板演练 · 非AI生成' : project.source === 'ai' ? 'AI生成 · 待人工审核' : project.source === 'import' ? '用户导入' : '空白项目';
  const scriptSamples = durationSamples('script');
  const scriptAverage = averageDuration('script');
  const documents = buildDocuments(project);
  const change = (patch: Partial<Project>) => updateProject(project.id, { ...patch, storyboardReady: false }, true);
  const editShot = (id: string, patch: Partial<Shot>) => updateProject(project.id, p => ({ ...p, storyboardReady: false, shots: p.shots.map(s => s.id === id ? { ...s, ...patch } : s) }), true);
  const current = (revision: number) => {
    const p = getStudio().projects.find(p => p.id === project.id);
    if (!p || p.revision !== revision) throw new Error('项目已被修改或删除，本次结果不会覆盖新内容。请重新预览或确认。');
    return p;
  };
  const prepare = (kind: Confirmation['kind']) => {
    if (!project.theme.trim()) { toast.error('请先填写故事主题。'); return; }
    if (kind === 'ai' && !keys[settings.scriptProvider]) { toast.error('请先在设置页填写剧本服务的 API Key。'); navigate('settings'); return; }
    setConfirm({ kind, project: structuredClone(project), prompt: scriptPrompt(project), provider: settings.scriptProvider, model: settings.models[settings.scriptProvider] });
  };
  const generate = async () => {
    if (!confirm || busy) return;
    const task = confirm;
    setBusy(true); setFailure(undefined);
    const controller = new AbortController(); abortRef.current = controller;
    const jobId = task.kind === 'ai' ? startJob({ kind: 'script', label: '生成剧本', cancel: () => controller.abort() }) : undefined;
    const startedAt = Date.now();
    if (jobId) setProgress({ stage: '提交任务', startedAt });
    try {
      current(task.project.revision);
      let draft: ScriptDraft;
      if (task.kind === 'template') draft = templateScript(task.project.theme);
      else {
        const auth = credentials(task.provider);
        if (auth.model !== task.model) throw new Error('模型设置已改变，请关闭弹窗并重新确认。');
        if (jobId) updateJob(jobId, { detail: '模型生成中' });
        setProgress(previous => previous && { ...previous, stage: '模型生成中' });
        const data = await callApi<GeneratedScript>('script', { ...auth, prompt: task.prompt }, controller.signal);
        setProgress(previous => previous && { ...previous, stage: '校验结构' });
        draft = normalizeScript(data);
      }
      current(task.project.revision);
      updateProject(project.id, p => draftUpdate(p, draft, task.kind === 'ai' ? 'ai' : 'template'), true);
      if (jobId) finishJob(jobId, 'done');
      setProgress(undefined);
      setConfirm(undefined);
      toast.success(task.kind === 'ai' ? '剧本已生成，请审核人物和每镜内容。' : '模板草稿已建立（非AI生成），请继续编辑。');
    } catch (error) {
      if (jobId) finishJob(jobId, controller.signal.aborted ? 'canceled' : 'failed', error instanceof ApiError ? error.code : undefined);
      setFailure(controller.signal.aborted ? new Error('取消只停止等待，服务商可能已受理并计费。') : error);
      setProgress(previous => previous && { ...previous, stage: controller.signal.aborted ? '已取消' : '失败' });
    } finally { setBusy(false); abortRef.current = undefined; }
  };
  const readImport = async (file?: File) => {
    if (!file) return;
    try {
      if (!/\.(txt|md)$/i.test(file.name)) throw new Error('只支持 .txt 或 .md 文本。');
      if (file.size > 2 * 1024 * 1024) throw new Error('文本文件请小于2MB。');
      const revision = project.revision;
      const content = await file.text();
      current(revision);
      if (content.includes('\0')) throw new Error('文件包含二进制内容，请使用UTF-8文本。');
      setImportText(content); setPreview(undefined);
    } catch (error) { toast.error(errorMessage(error)); }
  };
  const saveImport = () => {
    if (!preview) return;
    try {
      current(preview.revision);
      updateProject(project.id, p => draftUpdate(p, preview.draft, 'import'), true);
      setPreview(undefined); setImportOpen(false); toast.success('导入已保存，原文保留在各镜画面字段中。');
    } catch (error) { toast.error(errorMessage(error)); }
  };
  return <div className="stack">
    <header className="page-heading"><div><span className="tag">01 / 故事创作</span><h1>让一个念头，成为好故事</h1><p className="muted">从主题出发，编排一部 90 秒的短篇漫剧。</p></div><Button variant="outline" onClick={() => setDocumentsOpen(true)}><Download size={16} />导出文档</Button></header>
    <div className="workbench"><div className="workbench-main stack">
    <section className="panel stack">
      <div className="section-title"><h2>故事种子</h2><span className="tag">10 镜 · 90 秒</span></div>
      <Field label="故事主题" hint="写下主角、目标与冲突，也可以只从一个灵感开始。"><textarea rows={3} placeholder="例如：一个失去灵力的少年，发现山门石阶每晚都会多出一级……" value={project.theme} onChange={e => change({ theme: e.target.value })} /></Field>
      <div className="grid-2"><Field label="视觉风格"><select value={project.style || defaultStyle} onChange={e => change({ style: e.target.value })}>{!styles.includes(project.style) && project.style && <option>{project.style}</option>}{styles.map(style => <option key={style}>{style}</option>)}</select></Field><div className="field"><span>剧本服务</span><div className="row"><span className="tag">{settings.scriptProvider === 'gemini' ? 'Gemini' : 'DeepSeek'} · {settings.models[settings.scriptProvider]}</span><Button variant="ghost" onClick={() => navigate('settings')}>更改设置</Button></div></div></div>
      <details className="panel"><summary><strong>高级：提示词与规则</strong><span className="small muted"> · 所选 Skill 会写入对应生成任务的完整提示词</span></summary><div className="grid-2" style={{ marginTop: 12 }}>{skills.map(skill => <label className="panel row skill-option" key={skill.id}><input type="checkbox" checked={project.skills.includes(skill.id)} onChange={e => change({ skills: e.target.checked ? [...project.skills, skill.id] : project.skills.filter(id => id !== skill.id) })} /><span><strong>{skill.name}</strong><small className="muted">{skill.description}</small></span></label>)}</div><div className="toolbar" style={{ marginTop: 12 }}><Button variant="outline" onClick={() => setTemplateOpen(true)}>编辑提示词模板</Button></div></details>
      {!keys[settings.scriptProvider] && <div className="alert">尚未配置剧本 API Key。可以前往设置，或主动使用不联网的「模板演练」。模板不是 AI 生成。<Button variant="ghost" onClick={() => navigate('settings')}>前往设置</Button></div>}
      <div className="toolbar"><Button disabled={busy} variant={keys[settings.scriptProvider] ? 'default' : 'outline'} onClick={() => prepare('ai')}><Sparkles size={16} />{busy ? '正在生成…' : 'AI 生成剧本'}</Button><Button variant={keys[settings.scriptProvider] ? 'secondary' : 'default'} disabled={busy} onClick={() => prepare('template')}>模板演练</Button><Button variant="outline" onClick={() => setImportOpen(true)}><FileText size={16} />导入剧本</Button></div>
    </section>
    <section className="stack">
      <div className="section-title"><div><h2>逐镜剧本</h2><p className="muted">{project.shots.length} / 10 镜 · {Number(total.toFixed(2))} / 90 秒 · 编辑自动保存</p></div><span className="tag">{sourceTag}</span></div>
      {!project.shots.length && <Empty title="故事还没有开始" text="输入主题生成、主动模板演练，或导入你已经写好的剧本。这里不会预置作品或视频。" />}
      {project.shots.map(shot => <article className="shot-card stack" key={shot.id} id={`shot-${shot.number}`}>
        <div className="section-title"><div className="row"><span className="shot-number">{String(shot.number).padStart(2, '0')}</span><h3>第 {shot.number} 镜</h3>{shot.stale && <span className="tag">下游待更新</span>}</div><Button variant="ghost" aria-label={`删除第${shot.number}镜`} onClick={() => setRemove(shot)}><Trash2 size={16} />删除</Button></div>
        <div className="grid-2"><Field label="时长（秒）" hint="每镜4–15秒，10镜合计90秒。"><input type="number" min={4} max={15} step={1} value={shot.duration} onChange={e => editShot(shot.id, { duration: e.target.value === '' ? 0 : Number(e.target.value) })} /></Field><Field label="运镜"><input value={shot.camera} onChange={e => editShot(shot.id, { camera: e.target.value })} /></Field></div>
        <Field label="画面 / 保留的导入原文"><textarea rows={3} value={shot.visual} onChange={e => editShot(shot.id, { visual: e.target.value })} /></Field>
        <div className="grid-3"><Field label="开场 / 起点"><textarea rows={2} value={shot.start} onChange={e => editShot(shot.id, { start: e.target.value })} /></Field><Field label="动作"><textarea rows={2} value={shot.action} onChange={e => editShot(shot.id, { action: e.target.value })} /></Field><Field label="终点"><textarea rows={2} value={shot.end} onChange={e => editShot(shot.id, { end: e.target.value })} /></Field></div>
        <div className="stack"><div className="section-title"><h4>对白</h4><Button variant="ghost" onClick={() => editShot(shot.id, { dialogues: [...shot.dialogues, { id: uid(), speakerId: characters[0]?.id || '', text: '' }] })}><Plus size={14} />添加台词</Button></div>
          {!characters.length && <p className="muted">请在资产页添加人物，再为台词选择说话者。<Button variant="ghost" onClick={() => navigate('assets')}>创建人物</Button></p>}
          {shot.dialogues.map(dialogue => <div className="row" key={dialogue.id}><Field label="说话者"><select value={dialogue.speakerId} onChange={e => editShot(shot.id, { dialogues: shot.dialogues.map(d => d.id === dialogue.id ? { ...d, speakerId: e.target.value } : d) })}><option value="">未指定人物</option>{characters.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select></Field><Field label="台词内容"><textarea rows={2} value={dialogue.text} onChange={e => editShot(shot.id, { dialogues: shot.dialogues.map(d => d.id === dialogue.id ? { ...d, text: e.target.value } : d) })} /></Field><Button variant="ghost" aria-label="删除台词" onClick={() => editShot(shot.id, { dialogues: shot.dialogues.filter(d => d.id !== dialogue.id) })}><Trash2 size={16} /></Button></div>)}
        </div>
      </article>)}
      <div className="toolbar"><Button variant="outline" onClick={() => updateProject(project.id, p => ({ ...p, storyboardReady: false, shots: [...p.shots, makeShot(p.shots.length + 1)] }), true)}><Plus size={16} />增加镜头</Button></div>
    </section>
    </div><aside className="workbench-aside" aria-label="剧本状态">
      <section className="panel stack"><div className="section-title"><h3>当前状态</h3><span className="tag">{sourceTag}</span></div><p className="small muted">{project.shots.length} / 10 镜 · {Number(total.toFixed(2))} / 90 秒</p><p className="small muted">{characters.length} 位人物 · {project.assets.length} 项资产 · 编辑自动保存</p></section>
      {project.shots.length > 0 && issues.length > 0 && <section className="panel stack"><div className="section-title"><h3>需要完善</h3><span className="tag">{issues.length} 项</span></div><IssueList issues={issues} /></section>}
      <section className="panel stack"><Button variant="secondary" disabled={!project.shots.length} onClick={() => navigate('assets')}>下一步：设定资产</Button><p className="small muted">每镜 4–15 秒，十镜合计 90 秒。点击上方问题可跳到对应镜头。</p></section>
    </aside></div>
    <Modal open={!!confirm} onClose={() => { if (!busy) { setConfirm(undefined); setFailure(undefined); setProgress(undefined); } }} title={confirm?.kind === 'ai' ? '确认完整剧本任务' : '确认模板演练'} description="确认后替换当前镜头和人物资产；保留场景、道具、音色。旧人物图片不会自动沿用，请先导出需要保留的文档。">
      {confirm && <div className="stack"><div className="alert">{confirm.kind === 'ai' ? `服务：${confirm.provider} / ${confirm.model}。将发送以下完整提示词，可能产生服务商费用。` : '本操作只运行本机固定模板，不联网、不消耗额度，不是AI生成。将按主题建立10镜，每镜9秒。'}</div><p>主题：{confirm.project.theme}<br />风格：{confirm.project.style}<br />规则：{skills.filter(s => confirm.project.skills.includes(s.id)).map(s => s.name).join('、') || '不启用附加 Skill'}<br />目标：10 镜 / 90 秒</p>{confirm.kind === 'ai' && <Field label="即将发送的完整提示词"><textarea readOnly rows={12} value={confirm.prompt} /></Field>}{progress && <ProgressPanel title={confirm.kind === 'ai' ? 'AI 生成剧本' : '模板演练'} stage={progress.stage} startedAt={progress.startedAt} remainingMs={scriptSamples ? scriptAverage : undefined} detail={scriptSamples ? '正在等待模型返回' : '通常 20–60 秒（经验值）'} onCancel={busy && confirm.kind === 'ai' ? () => abortRef.current?.abort() : undefined} cancelLabel="取消等待" />}{failure !== undefined && <ErrorNote error={failure} action={errorAction(failure) === 'settings' ? <Button variant="secondary" size="sm" onClick={() => { setConfirm(undefined); setFailure(undefined); setProgress(undefined); navigate('settings'); }}>去设置</Button> : errorAction(failure) === 'retry' ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void generate()}>重试</Button> : undefined} />}<div className="toolbar"><Button disabled={busy} onClick={generate}>{busy ? '生成中，请勿重复提交…' : confirm.kind === 'ai' ? '确认发送并生成' : '建立模板草稿（非AI）'}</Button><Button variant="ghost" onClick={() => { setConfirm(undefined); setTemplateOpen(true); }}>编辑模板</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirm(undefined)}>取消</Button></div></div>}
    </Modal>
    <Modal open={importOpen} onClose={() => setImportOpen(false)} title="导入剧本 · 先预览再保存" description="按镜号分段，没有镜号时按空行分段。所有原文逐段完整保留在画面字段，不会静默丢弃未识别内容。">
      <div className="stack"><Field label="上传 UTF-8 的 .txt / .md 文件（≤2MB）"><input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={e => { void readImport(e.target.files?.[0]); e.target.value = ''; }} /></Field><Field label="或粘贴原文"><textarea rows={8} value={importText} placeholder={'第1镜（9秒）\n画面：……\n开场：……\n动作：……\n终点：……\n运镜：……\n台词：人物：……'} onChange={e => { setImportText(e.target.value); setPreview(undefined); }} /></Field><Button variant="secondary" onClick={() => { try { setPreview({ draft: parseScriptText(importText), revision: project.revision }); } catch (error) { toast.error(errorMessage(error)); } }}>解析并预览</Button>
        {preview && <div className="stack"><div className="alert">识别到 {preview.draft.shots.length} 镜，共 {preview.draft.shots.reduce((sum, s) => sum + s.duration, 0)} 秒。不足或超过10镜可在保存后增删；未标注时长按9秒，未识别字段请人工完善。</div>{preview.draft.shots.map(s => <details className="panel" key={s.id}><summary>第{s.number}镜 · {s.duration}秒 · {s.dialogues.length}句台词</summary><pre>{s.visual}</pre><p>运镜：{s.camera} / 开场：{s.start || '待补充'} / 动作：{s.action || '待补充'} / 终点：{s.end || '待补充'}</p></details>)}<p className="muted">保存会替换当前镜头和人物，清除原人物的图像绑定，保留其他类别资产。</p><Button onClick={saveImport}>确认导入并替换剧本</Button></div>}
      </div>
    </Modal>
    <Modal open={!!remove} onClose={() => setRemove(undefined)} title="删除镜头？" description="将删除该镜头的台词、素材关联和制作状态，其余镜头自动重新编号。"><div className="toolbar"><Button onClick={() => { if (remove) updateProject(project.id, p => ({ ...p, storyboardReady: false, shots: p.shots.filter(s => s.id !== remove.id).map((s, i) => ({ ...s, number: i + 1 })) }), true); setRemove(undefined); }}>确认删除第 {remove?.number} 镜</Button><Button variant="ghost" onClick={() => setRemove(undefined)}>取消</Button></div></Modal>
    <Modal open={documentsOpen} onClose={() => setDocumentsOpen(false)} title="导出创作文档" description="导出的是文本文档，不包含图片和音视频文件。"><div className="stack"><Field label="选择文档"><select value={documentName} onChange={e => setDocumentName(e.target.value)}>{Object.keys(documents).map(name => <option key={name}>{name}</option>)}</select></Field><textarea aria-label="文档预览" rows={12} readOnly value={documents[documentName]} /><div className="toolbar"><Button onClick={() => downloadBlob(new Blob([documents[documentName]], { type: 'text/markdown;charset=utf-8' }), `${project.name}-${documentName}`)}>下载当前文档</Button><Button variant="secondary" onClick={() => void copyText(documents[documentName])}>复制内容</Button><Button variant="ghost" onClick={() => navigate('export')}>前往完整导出</Button></div></div></Modal>
    <TemplateEditor project={project} open={templateOpen} onClose={() => setTemplateOpen(false)} initialKind="script" />
  </div>;
}

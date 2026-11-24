import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Sparkles, Download, FileText } from 'lucide-react';
import { Button, Empty, ErrorNote, Field, Fold, HelpPopover, IssueList, Modal, ProgressPanel, copyText, downloadBlob, errorAction } from '../../components/Ui';
import TemplateEditor from '../prompts/TemplateEditor';
import { MAX_SOURCE_CHARS, defaultStyle, type PageProps, type Project } from '../../domain/types';
import { scriptWarnings, validateScriptStage, withConfirmation } from '../../domain/flow';
import { getStudio, updateProject, useStudio } from '../../store/studio';
import { averageDuration, durationSamples, finishJob, startJob, updateJob } from '../../store/jobs';
import { ApiError, callApi, credentials, errorMessage } from '../../lib/api';
import { skills } from '../../lib/skills';
import { screenplayPrompt } from '../../lib/prompts';
import { modelFor } from '../../lib/endpoints';
import { buildDocuments } from '../../lib/documents';
import { mergeDraftAssets, normalizeScreenplay, parseScriptText, templateScript, type GeneratedScreenplay, type ScriptDraft } from './creation';
import DurationStrip from './DurationStrip';

const styles = [defaultStyle, '清新日系动画，柔和色彩与自然光', '电影写实风，克制配色与戏剧光影'];
type Confirmation = { kind: 'ai' | 'template'; project: Project; prompt: string; defaultPrompt: string; provider: string; model: string };
const draftUpdate = (p: Project, draft: ScriptDraft, source: Project['source']): Project => ({ ...p, ...mergeDraftAssets(p.assets, draft), name: draft.title || p.name, logline: draft.logline || p.logline, screenplay: draft.screenplay ?? p.screenplay, source, storyboardReady: false });

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
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [documentName, setDocumentName] = useState('剧本文档.md');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [screenplayDraft, setScreenplayDraft] = useState(project.screenplay || '');
  const [screenplaySaved, setScreenplaySaved] = useState(project.screenplay || '');
  const issues = validateScriptStage(project);
  const warnings = scriptWarnings(project);
  const total = project.shots.reduce((sum, s) => sum + s.duration, 0);
  const characters = project.assets.filter(a => a.kind === 'character');
  const sceneCount = new Set(project.shots.map(shot => shot.scene).filter(Boolean)).size;
  const sourceMode = project.scriptMode === 'source';
  const sourceLength = (project.sourceText || '').trim().length;
  const sourceTag = project.source === 'template' ? '模板演练 · 非AI生成' : project.source === 'ai' ? (sourceMode ? 'AI生成 · 原文转剧本' : 'AI生成 · 待人工审核') : project.source === 'import' ? '用户导入' : '空白项目';
  const confirmScript = () => {
    const problems = validateScriptStage(project);
    if (problems.length) { toast.error(`还有 ${problems.length} 项需要完善，请先修正。`); return; }
    updateProject(project.id, p => ({ ...p, confirmed: withConfirmation(p, 'script') }), false);
    navigate('assets');
  };
  const scriptSamples = durationSamples('script');
  const scriptAverage = averageDuration('script');
  const documents = buildDocuments(project);
  const change = (patch: Partial<Project>) => updateProject(project.id, { ...patch, storyboardReady: false }, true);
  const current = (revision: number) => {
    const p = getStudio().projects.find(p => p.id === project.id);
    if (!p || p.revision !== revision) throw new Error('项目已被修改或删除，本次结果不会覆盖新内容。请重新预览或确认。');
    return p;
  };
  const prepare = (kind: Confirmation['kind']) => {
    if (kind === 'template' && sourceMode) { toast.error('模板演练只支持主题原创模式。'); return; }
    if (sourceMode) {
      if (!sourceLength) { toast.error('原文模式下请先粘贴或上传小说原文。'); return; }
      if (sourceLength > MAX_SOURCE_CHARS) { toast.error('原文过长（' + sourceLength + ' 字），请裁到 ' + MAX_SOURCE_CHARS + ' 字以内再生成。'); return; }
    } else if (!project.theme.trim()) { toast.error('请先填写故事主题。'); return; }
    if (kind === 'ai' && !keys[settings.scriptProvider]) { toast.error(settings.scriptProvider ? '请先在设置页填写剧本服务的 API Key。' : '还没有可用的剧本端点，请到设置页添加或恢复一个。'); navigate('settings'); return; }
    const prompt = screenplayPrompt(project);
    setConfirm({ kind, project: structuredClone(project), prompt, defaultPrompt: prompt, provider: settings.scriptProvider, model: modelFor(settings, settings.scriptProvider, 'script') });
  };
  const generate = async () => {
    if (!confirm || busy) return;
    const task = confirm;
    if (task.kind === 'ai' && !task.prompt.trim()) { toast.error('提示词不能为空：请在模板编辑器里添加内容。'); return; }
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
        const auth = credentials(task.provider, 'script');
        if (auth.model !== task.model) throw new Error('模型设置已改变，请关闭弹窗并重新确认。');
        if (jobId) updateJob(jobId, { detail: '模型生成中' });
        setProgress(previous => previous && { ...previous, stage: '模型生成中' });
        const data = await callApi<GeneratedScreenplay>('screenplay', { ...auth, prompt: task.prompt }, controller.signal);
        setProgress(previous => previous && { ...previous, stage: '校验结构' });
        draft = normalizeScreenplay(data);
      }
      current(task.project.revision);
      updateProject(project.id, p => draftUpdate(p, draft, task.kind === 'ai' ? 'ai' : 'template'), true);
      setScreenplayDraft(draft.screenplay || '');
      setScreenplaySaved(draft.screenplay || '');
      if (jobId) finishJob(jobId, 'done');
      setProgress(undefined);
      setConfirm(undefined);
      toast.success(task.kind === 'ai' ? `剧本已生成，已按剧本拆出 ${draft.shots.length} 个镜头，请审核剧本内容。` : '模板剧本已建立（非AI生成），请继续编辑。');
      toast.info('这一步不写资产：台词只记下说话人名字，人物要到资产页点「AI 提取人物」后才写入。');
      for (const note of draft.notes ?? []) toast.warning(note);
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
  const readSource = async (file?: File) => {
    if (!file) return;
    try {
      if (!/\.(txt|md)$/i.test(file.name)) throw new Error('只支持 .txt 或 .md 文本。');
      if (file.size > 2 * 1024 * 1024) throw new Error('文本文件请小于2MB。');
      const content = await file.text();
      if (content.includes('\0')) throw new Error('文件包含二进制内容，请使用UTF-8文本。');
      change({ sourceText: content });
      toast.success('原文已载入，请确认内容后再生成剧本。');
    } catch (error) { toast.error(errorMessage(error)); }
  };
  const saveScreenplay = () => {
    try {
      const draft = normalizeScreenplay({ title: project.name, logline: project.logline, screenplay: screenplayDraft });
      updateProject(project.id, p => draftUpdate(p, draft, p.source === 'empty' ? 'import' : p.source), true);
      setScreenplaySaved(screenplayDraft);
      toast.success(`剧本已保存，已按剧本拆出 ${draft.shots.length} 个镜头。`);
      for (const note of draft.notes ?? []) toast.warning(note);
    } catch (error) { toast.error(errorMessage(error)); }
  };
  const saveImport = () => {
    if (!preview) return;
    try {
      current(preview.revision);
      updateProject(project.id, p => draftUpdate(p, preview.draft, 'import'), true);
      setPreview(undefined); setImportOpen(false); toast.success('导入已保存，剧本与镜头已更新。');
    } catch (error) { toast.error(errorMessage(error)); }
  };
  return <div className="stack">
    <header className="page-heading"><div className="page-heading-title"><h1>让一个念头，成为好故事</h1><HelpPopover label="故事创作说明" title="故事创作"><p>从主题或小说原文出发，写出一份完整的漫剧剧本。</p><p className="mt-2">剧本按四部分结构生成，每个动作块与对白块都标【镜头：类型】和时长，保存时会自动拆成镜头。原文模式下对白逐字保留，不增删改写。</p></HelpPopover></div><Button variant="outline" onClick={() => setDocumentsOpen(true)}><Download size={16} />导出文档</Button></header>
    <div className="workbench"><div className="workbench-main stack">
    <section className="panel stack">
      <div className="section-title"><h2>故事种子</h2><span className="tag">完整剧本 · 逐镜拆解</span></div>
      <div className="row wrap"><Button variant={sourceMode ? 'outline' : 'default'} size="sm" onClick={() => updateProject(project.id, { scriptMode: 'theme' }, false)}>主题原创</Button><Button variant={sourceMode ? 'default' : 'outline'} size="sm" onClick={() => updateProject(project.id, { scriptMode: 'source' }, false)}>原文转剧本</Button></div>
      {sourceMode ? <div className="stack">
        <Field label="小说原文" hint="粘贴或上传原文。剧本必须绝对忠于原文：对白逐字保留，不增删改写；确实需要补一句时必须标注「*基于原文背景合理补充*」。"><textarea rows={10} placeholder="粘贴小说片段……" value={project.sourceText || ''} onChange={e => change({ sourceText: e.target.value })} /></Field>
        <Field label="上传 UTF-8 的 .txt / .md 原文（≤2MB）"><input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={e => { void readSource(e.target.files?.[0]); e.target.value = ''; }} /></Field>
        <p className="small muted">已输入 {sourceLength} 字（上限 {MAX_SOURCE_CHARS} 字）。原文只作为本次剧本生成的唯一事实来源发送，不会进入其他步骤。</p>
      </div> : <Field label="故事主题" hint="写下主角、目标与冲突，也可以只从一个灵感开始。"><textarea rows={3} placeholder="例如：一个失去灵力的少年，发现山门石阶每晚都会多出一级……" value={project.theme} onChange={e => change({ theme: e.target.value })} /></Field>}
      <Field label="一句话主线" hint="整部剧本都要服务这一句。AI 生成剧本时会一并给出，也可以自己写；修改主线不会让已有镜头失效。"><textarea rows={2} placeholder="例如：少年拾起断剑，却不知剑里封着自己被削去的神格。" value={project.logline || ''} onChange={e => updateProject(project.id, { logline: e.target.value }, false)} /></Field>
      <div className="grid-2"><Field label="视觉风格"><select value={project.style || defaultStyle} onChange={e => change({ style: e.target.value })}>{!styles.includes(project.style) && project.style && <option>{project.style}</option>}{styles.map(style => <option key={style}>{style}</option>)}</select></Field><div className="field"><span>剧本服务</span><div className="row"><span className="tag">{settings.endpoints.find(endpoint => endpoint.id === settings.scriptProvider)?.name ?? '未选择端点'} · {modelFor(settings, settings.scriptProvider, 'script')}</span><Button variant="ghost" onClick={() => navigate('settings')}>更改设置</Button></div></div></div>
      <details className="panel"><summary><strong>高级：提示词与规则</strong><span className="small muted"> · 所选 Skill 会写入对应生成任务的完整提示词</span></summary><div className="grid-2" style={{ marginTop: 12 }}>{skills.map(skill => <label className="panel row skill-option" key={skill.id}><input type="checkbox" checked={project.skills.includes(skill.id)} onChange={e => change({ skills: e.target.checked ? [...project.skills, skill.id] : project.skills.filter(id => id !== skill.id) })} /><span><strong>{skill.name}</strong><small className="muted">{skill.description}</small></span></label>)}</div><div className="toolbar" style={{ marginTop: 12 }}><Button variant="outline" onClick={() => setTemplateOpen(true)}>编辑提示词模板</Button></div></details>
      {!keys[settings.scriptProvider] && <div className="alert">{settings.scriptProvider ? '尚未配置剧本 API Key。' : '还没有可用的剧本端点，请到设置页添加或恢复一个。'}可以前往设置，或主动使用不联网的「模板演练」。模板不是 AI 生成。<Button variant="ghost" onClick={() => navigate('settings')}>前往设置</Button></div>}
      <div className="toolbar"><Button disabled={busy} variant={keys[settings.scriptProvider] ? 'default' : 'outline'} onClick={() => prepare('ai')}><Sparkles size={16} />{busy ? '正在生成…' : 'AI 生成剧本'}</Button><Button variant={keys[settings.scriptProvider] ? 'secondary' : 'default'} disabled={busy || sourceMode} onClick={() => prepare('template')}>模板演练</Button><Button variant="outline" onClick={() => setImportOpen(true)}><FileText size={16} />导入剧本</Button></div>
    </section>
    <div className="panel"><DurationStrip project={project} /></div>
    <section className="panel stack">
      <div className="section-title"><div><h2>剧本</h2><p className="muted">{sceneCount} 场 · {project.shots.length} 镜 · {Number(total.toFixed(1))} 秒{project.shots.length ? ' · 按剧本拆镜' : ''}</p></div><div className="row"><span className="tag">{sourceTag}</span></div></div>
      {!screenplayDraft && !project.screenplay ? <Empty title="还没有剧本" text="填写主题或粘贴原文，生成一份完整漫剧剧本；也可以导入你已经写好的剧本。这里不会预置作品或视频。" /> : <>
        <Field label="剧本全文" hint="四部分结构：核心前提与黄金3秒钩子 / 场景因果节拍表 / 世界观与人物关系 / 标准漫剧剧本。正文里每个动作块与对白块都标【镜头：类型】和时长。改完点「保存并重新拆镜」，镜头会按剧本重新拆出来。">
          <textarea rows={26} value={screenplayDraft} onChange={e => setScreenplayDraft(e.target.value)} />
        </Field>
        <div className="toolbar"><Button variant="secondary" disabled={screenplayDraft === screenplaySaved} onClick={saveScreenplay}>保存并重新拆镜</Button><Button variant="ghost" disabled={screenplayDraft === screenplaySaved} onClick={() => setScreenplayDraft(screenplaySaved)}>撤销修改</Button></div>
      </>}
    </section>
    </div><aside className="workbench-aside" aria-label="剧本状态">
      <Fold title="当前状态" meta={sourceTag}><p className="small muted">{sceneCount} 场 · {project.shots.length} 镜 · {Number(total.toFixed(1))} 秒</p><p className="small muted">{characters.length} 位人物 · {project.assets.length} 项资产 · 编辑自动保存</p></Fold>
      {project.shots.length > 0 && issues.length > 0 && <section className="panel stack"><div className="section-title"><h3>需要完善</h3><span className="tag">{issues.length} 项</span></div><IssueList issues={issues} /></section>}
      {warnings.length > 0 && <section className="panel stack"><div className="section-title"><h3>建议</h3><span className="tag subtle">{warnings.length} 项</span></div><ul className="issue-list">{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></section>}
      <section className="panel stack"><Button variant="secondary" disabled={!project.shots.length} onClick={confirmScript}>确认并进入下一步</Button><p className="small muted">镜头由剧本拆出，时长取 0.5 秒整数倍。确认后进入资产步骤，资产补全在下一步完成。</p></section>
    </aside></div>
    <Modal open={!!confirm} onClose={() => { if (!busy) { setConfirm(undefined); setFailure(undefined); setProgress(undefined); } }} title={confirm?.kind === 'ai' ? '确认完整剧本任务' : '确认模板演练'} description="确认后只替换当前镜头和台词；已有资产不会被删除，固定短语与设定图原样保留，资产补全在下一步「资产设定」完成。">
      {confirm && <div className="stack"><div className="alert">{confirm.kind === 'ai' ? `服务：${confirm.provider} / ${confirm.model}。将发送以下完整提示词，可能产生服务商费用。` : '本操作只运行本机固定模板，不联网、不消耗额度，不是AI生成。将按主题写一份完整剧本并拆出镜头。'}</div><p>主题：{confirm.project.theme}<br />{confirm.project.scriptMode === 'source' ? '原文：' + (confirm.project.sourceText || '').length + ' 字（逐字忠于原文）<br />' : ''}风格：{confirm.project.style}<br />规则：{skills.filter(s => confirm.project.skills.includes(s.id)).map(s => s.name).join('、') || '不启用附加 Skill'}<br />目标：完整漫剧剧本（60–240 秒）</p>{confirm.kind === 'ai' && <Field label="即将发送的完整提示词" hint="可直接修改，只影响本次请求；模板不会被改写。"><textarea rows={12} value={confirm.prompt} disabled={busy} onChange={e => setConfirm(previous => previous && { ...previous, prompt: e.target.value })} /></Field>}{confirm.kind === 'ai' && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(previous => previous && { ...previous, prompt: previous.defaultPrompt })}>恢复默认提示词</Button>}{progress && <ProgressPanel title={confirm.kind === 'ai' ? 'AI 生成剧本' : '模板演练'} stage={progress.stage} startedAt={progress.startedAt} remainingMs={scriptSamples ? scriptAverage : undefined} detail={scriptSamples ? '正在等待模型返回' : '通常 20–60 秒（经验值）'} onCancel={busy && confirm.kind === 'ai' ? () => abortRef.current?.abort() : undefined} cancelLabel="取消等待" />}{failure !== undefined && <ErrorNote error={failure} action={errorAction(failure) === 'settings' ? <Button variant="secondary" size="sm" onClick={() => { setConfirm(undefined); setFailure(undefined); setProgress(undefined); navigate('settings'); }}>去设置</Button> : errorAction(failure) === 'retry' ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void generate()}>重试</Button> : undefined} />}<div className="toolbar"><Button disabled={busy || (confirm.kind === 'ai' && !confirm.prompt.trim())} onClick={generate}>{busy ? '生成中，请勿重复提交…' : confirm.kind === 'ai' ? '确认发送并生成' : '建立模板草稿（非AI）'}</Button><Button variant="ghost" onClick={() => { setConfirm(undefined); setTemplateOpen(true); }}>编辑模板</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirm(undefined)}>取消</Button></div></div>}
    </Modal>
    <Modal open={importOpen} onClose={() => setImportOpen(false)} title="导入剧本 · 先预览再保存" description="标准漫剧剧本格式按【镜头：…】分块拆镜；旧版按镜号分段的剧本也仍可导入。所有原文逐段完整保留在画面字段，不会静默丢弃未识别内容。">
      <div className="stack"><Field label="上传 UTF-8 的 .txt / .md 文件（≤2MB）"><input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={e => { void readImport(e.target.files?.[0]); e.target.value = ''; }} /></Field><Field label="或粘贴原文"><textarea rows={8} value={importText} placeholder={'# 第一部分｜核心前提\n【核心前提】\n……\n\n# 第四部分｜标准漫剧剧本\n## 第一章  章名\n\n### 场景1 外景 · 地点 — 清晨\n**剧情：**……\n**人物：**角色A\n\n【镜头：远景】\n△ 动作描写。（时长3s）\n\n角色A（情绪）：“台词。”（时长2s）'} onChange={e => { setImportText(e.target.value); setPreview(undefined); }} /></Field><Button variant="secondary" onClick={() => { try { setPreview({ draft: parseScriptText(importText), revision: project.revision }); } catch (error) { toast.error(errorMessage(error)); } }}>解析并预览</Button>
        {preview && <div className="stack"><div className="alert">识别到 {preview.draft.shots.length} 镜，共 {preview.draft.shots.reduce((sum, s) => sum + s.duration, 0)} 秒。未识别字段请人工完善；保存后可继续编辑剧本正文并重新拆镜。</div>{preview.draft.shots.map(s => <details className="panel" key={s.id}><summary>第{s.number}镜 · {s.duration}秒 · {s.scene || '未标注场景'} · {s.cameraHint || '未指定画面类型'} · {s.dialogues.length}句台词</summary><pre>{s.visual}</pre></details>)}<p className="muted">保存会替换当前镜头；已有资产、设定图与固定短语不会被删除，资产补全在下一步完成。</p><Button onClick={saveImport}>确认导入并替换剧本</Button></div>}
      </div>
    </Modal>
    <Modal open={documentsOpen} onClose={() => setDocumentsOpen(false)} title="导出创作文档" description="导出的是文本文档，不包含图片和音视频文件。"><div className="stack"><Field label="选择文档"><select value={documentName} onChange={e => setDocumentName(e.target.value)}>{Object.keys(documents).map(name => <option key={name}>{name}</option>)}</select></Field><textarea aria-label="文档预览" rows={12} readOnly value={documents[documentName]} /><div className="toolbar"><Button onClick={() => downloadBlob(new Blob([documents[documentName]], { type: 'text/markdown;charset=utf-8' }), `${project.name}-${documentName}`)}>下载当前文档</Button><Button variant="secondary" onClick={() => void copyText(documents[documentName])}>复制内容</Button><Button variant="ghost" onClick={() => navigate('export')}>前往完整导出</Button></div></div></Modal>
    <TemplateEditor project={project} open={templateOpen} onClose={() => setTemplateOpen(false)} initialKind="script" />
  </div>;
}

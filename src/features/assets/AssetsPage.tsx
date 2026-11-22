import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Sparkles, Volume2, ImagePlus, Copy } from 'lucide-react';
import { Button, Empty, ErrorNote, Field, HelpPopover, Modal, ProgressPanel, StatusChip, copyText, errorAction, formatElapsed } from '../../components/Ui';
import { uid, type Asset, type AssetKind, type PageProps } from '../../domain/types';
import { getStudio, setAssetImage, setSettings, updateProject, useStudio } from '../../store/studio';
import { averageDuration, durationSamples, finishJob, startJob, updateJob } from '../../store/jobs';
import { putMedia, useMediaUrl } from '../../store/media';
import { ApiError, callApi, callBinary, credentials, errorMessage } from '../../lib/api';
import { fixedDescription, imagePrompt } from '../../lib/prompts';
import { imageConcurrency, imageModelGroups } from '../../lib/models';
import { runPool } from '../../lib/pool';
import { assetUsage, generatedImageBlob, removeAsset, validateImage } from './helpers';

const kinds: { id: AssetKind; name: string; text: string }[] = [
  { id: 'character', name: '人物', text: '固定外观、服装与配音，让每一次出场都保持一致。' },
  { id: 'scene', name: '场景', text: '保留空间、光线与氛围，建立故事的世界。' },
  { id: 'prop', name: '道具', text: '固定轮廓、材质与细节，让关键物件有迹可循。' },
  { id: 'voice', name: '音色', text: '选定音色与语速，再把声音分配给人物。' },
];
type Pending = { kind: 'image'; asset: Asset; revision: number; prompt: string; provider: 'openai' | 'seedream' | 'siliconflow'; model: string } | { kind: 'speech'; asset: Asset; revision: number; model: string; local: boolean };
type Preview = { mediaId: string; text: string };
type BatchStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled' | 'not_submitted';
type BatchItem = { id: string; name: string; status: BatchStatus; error?: unknown; startedAt?: number; finishedAt?: number };
type BatchState = { items: BatchItem[]; startedAt: number; running: boolean };

const batchLabels: Record<BatchStatus, string> = { queued: '排队中', running: '生成中', done: '已完成', failed: '失败', canceled: '已取消', not_submitted: '未提交' };
const batchTones = { queued: 'neutral', running: 'running', done: 'success', failed: 'danger', canceled: 'neutral', not_submitted: 'warning' } as const;
function fixedHash(value: string) { let hash = 5381; for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0; return String(hash); }
function Elapsed({ since }: { since?: number }) {
  const [, setTick] = useState(0);
  useEffect(() => { if (since === undefined) return; const timer = window.setInterval(() => setTick(value => value + 1), 1000); return () => window.clearInterval(timer); }, [since]);
  if (since === undefined) return null;
  return <span className="small muted">已用 {formatElapsed(Date.now() - since)}</span>;
}

function AssetImage({ asset, detail = false }: { asset: Asset; detail?: boolean }) {
  const url = useMediaUrl(asset.imageId);
  return url ? <img className={detail ? 'media-detail-media' : 'compact-media-image'} src={url} alt={`${asset.name}的设定图`} /> : <span className="compact-media-placeholder muted">{asset.imageId ? '图片加载中；若持续为空，请重新上传本地素材。' : '未添加设定图'}</span>;
}
function AudioPreview({ preview }: { preview: Preview }) {
  const url = useMediaUrl(preview.mediaId);
  return <div className="stack"><p className="muted">API 试听：{preview.text}（仅试听，不是已导出的配音轨）</p>{url ? <audio controls src={url} aria-label="音色试听" /> : <p className="muted">正在读取试听音频…</p>}</div>;
}
export default function AssetsPage(props: PageProps) { return <AssetEditor key={props.project.id} {...props} />; }
function AssetEditor({ project, navigate }: PageProps) {
  const { keys, settings } = useStudio();
  const [kind, setKind] = useState<AssetKind>('character');
  const [focusedId, setFocusedId] = useState<string>();
  const focused = project.assets.find(asset => asset.id === focusedId);
  const [editing, setEditing] = useState<{ asset: Asset; revision: number; isNew: boolean }>();
  const [deleting, setDeleting] = useState<Asset>();
  const [removingImage, setRemovingImage] = useState<Asset>();
  const [pending, setPending] = useState<Pending>();
  const [failure, setFailure] = useState<unknown>();
  const [progress, setProgress] = useState<{ stage: string; startedAt: number }>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const [batch, setBatch] = useState<BatchState>();
  const batchAbort = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [voicesBusy, setVoicesBusy] = useState(false);
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [speechText, setSpeechText] = useState('你好，很高兴与你一起开始这段故事。');
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const localSpeech = useRef<SpeechSynthesisUtterance | null>(null);
  useEffect(() => () => { if (localSpeech.current && 'speechSynthesis' in window) window.speechSynthesis.cancel(); }, []);
  const current = (revision: number, assetId?: string) => {
    const p = getStudio().projects.find(p => p.id === project.id);
    if (!p || p.revision !== revision || (assetId && !p.assets.some(a => a.id === assetId))) throw new Error('项目或资产已修改／删除，本次操作不会覆盖新内容。请重新确认。');
    return p;
  };
  const patch = (id: string, update: Partial<Asset>) => updateProject(project.id, p => ({ ...p, storyboardReady: false, assets: p.assets.map(a => a.id === id ? { ...a, ...update } : a) }), true);
  const edit = (asset?: Asset) => setEditing({ asset: asset ? { ...asset } : { id: uid(), kind, name: '', description: '', lock: '', ...(kind === 'voice' ? { speed: 1, voiceId: '' } : {}) }, revision: project.revision, isNew: !asset });
  const draftPatch = (update: Partial<Asset>) => setEditing(previous => previous ? { ...previous, asset: { ...previous.asset, ...update } } : previous);
  const save = () => {
    if (!editing) return;
    try {
      current(editing.revision, editing.isNew ? undefined : editing.asset.id);
      const a = { ...editing.asset, name: editing.asset.name.trim(), voiceId: editing.asset.voiceId?.trim() };
      if (!a.name) throw new Error('请填写资产名称。');
      if (a.kind !== 'voice' && !a.description.trim()) throw new Error('请填写描述，作为固定短语的默认来源。');
      if (!a.lock.trim()) a.lock = a.description;
      if (a.kind === 'voice' && (!Number.isFinite(a.speed ?? 1) || (a.speed ?? 1) < 0.5 || (a.speed ?? 1) > 2)) throw new Error('语速需要在0.5–2之间。');
      updateProject(project.id, p => ({ ...p, storyboardReady: false, assets: editing.isNew ? [...p.assets, a] : p.assets.map(item => item.id === a.id ? a : item) }), true);
      setEditing(undefined); toast.success('资产设定已保存，下游提示词将复用固定短语。');
    } catch (error) { toast.error(errorMessage(error)); }
  };
  const upload = async (asset: Asset, file?: File) => {
    if (!file) return;
    const revision = project.revision;
    setBusy(true);
    try {
      await validateImage(file); current(revision, asset.id);
      const imageId = await putMedia(file); current(revision, asset.id);
      patch(asset.id, { imageId }); toast.success('图片已保存在本地素材库，可在分镜页挂载。');
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const prepareImage = (asset: Asset) => {
    const provider = settings.imageProvider;
    if (!keys[provider]) { toast.error(`请先在设置页填写 ${provider === 'openai' ? 'OpenAI' : provider === 'seedream' ? 'Seedream（火山方舟）' : '硅基流动 SiliconFlow'} API Key。`); navigate('settings'); return; }
    if (!fixedDescription(asset).trim()) { toast.error('请先完善资产描述与固定短语。'); return; }
    setFailure(undefined);
    setPending({ kind: 'image', asset: { ...asset }, revision: project.revision, prompt: imagePrompt(project, asset), provider, model: settings.models[provider] });
  };
  const loadVoices = async () => {
    if (!keys.minimax) { toast.error('请先在设置页填写 MiniMax API Key。'); navigate('settings'); return; }
    setVoicesBusy(true);
    try {
      const data = await callApi<{ id: string; name: string }[]>('voices', { ...credentials('minimax') });
      if (!Array.isArray(data) || data.some(v => typeof v.id !== 'string' || typeof v.name !== 'string')) throw new Error('音色列表格式无效。');
      setVoices(data); toast.success(data.length ? `已获取${data.length}个音色。` : '服务商暂无可用音色，也可以手动填写音色ID。');
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setVoicesBusy(false); }
  };
  const prepareSpeech = (asset: Asset, local: boolean) => {
    if (!local && !keys.minimax) { toast.error('请配置 MiniMax API Key，或选择明确标注的本机试听。'); return; }
    if (!local && !asset.voiceId) { toast.error('请先编辑并保存音色ID。'); return; }
    setFailure(undefined);
    setPending({ kind: 'speech', asset: { ...asset }, revision: project.revision, model: settings.speechModel, local });
  };
  const execute = async () => {
    if (!pending || busy) return;
    const task = pending;
    setBusy(true);
    setFailure(undefined);
    const controller = new AbortController(); abortRef.current = controller;
    const jobId = startJob({ kind: task.kind, label: task.kind === 'image' ? `生成「${task.asset.name}」设定图` : `试听「${task.asset.name}」`, cancel: () => controller.abort() });
    setProgress({ stage: task.kind === 'image' ? '提交图片任务' : task.local ? '本机试听' : '提交试听', startedAt: Date.now() });
    try {
      current(task.revision, task.asset.id);
      if (task.kind === 'image') {
        const auth = credentials(task.provider);
        if (getStudio().settings.imageProvider !== task.provider || auth.model !== task.model) throw new Error('图片模型设置已改变，请重新确认。');
        updateJob(jobId, { detail: '生成图片中' });
        setProgress(previous => previous && { ...previous, stage: '生成图片中' });
        const result = await callApi<{ base64: string; mime: string }>('image', { ...auth, prompt: task.prompt }, controller.signal);
        setProgress(previous => previous && { ...previous, stage: '保存图片' });
        current(task.revision, task.asset.id);
        const blob = await generatedImageBlob(result);
        const imageId = await putMedia(blob); current(task.revision, task.asset.id);
        patch(task.asset.id, { imageId }); toast.success('生成图片已保存，现有引用会使用新图片。');
      } else {
        const text = speechText.trim();
        if (!text || text.length > 120) throw new Error('试听短句请控制在1–120字。');
        if (task.local) {
          if (!('speechSynthesis' in window)) throw new Error('当前浏览器不支持本机语音试听。');
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'zh-CN'; utterance.rate = task.asset.speed ?? 1;
          utterance.onerror = event => { if (event.error !== 'canceled' && event.error !== 'interrupted') toast.error('本机语音无法播放，请检查系统语音设置。'); };
          localSpeech.current = utterance; window.speechSynthesis.speak(utterance);
          toast.info('正在使用系统声音试听，不代表服务商音色，也不能作为导出音轨。');
        } else {
          if (getStudio().settings.speechModel !== task.model) throw new Error('语音模型已改变，请重新确认。');
          setProgress(previous => previous && { ...previous, stage: '合成语音' });
          const blob = await callBinary('speech', { ...credentials('minimax'), model: task.model, text, voiceId: task.asset.voiceId, speed: task.asset.speed ?? 1 }, controller.signal);
          if (!blob.type.startsWith('audio/') || !blob.size) throw new Error('服务商没有返回有效音频。');
          setProgress(previous => previous && { ...previous, stage: '保存音频' });
          current(task.revision, task.asset.id);
          const mediaId = await putMedia(blob); current(task.revision, task.asset.id);
          setPreviews(previous => ({ ...previous, [task.asset.id]: { mediaId, text } }));
          toast.success('试听音频已准备好，请使用播放器播放。');
        }
      }
      finishJob(jobId, 'done');
      setProgress(undefined);
      setPending(undefined);
    } catch (error) {
      finishJob(jobId, controller.signal.aborted ? 'canceled' : 'failed', error instanceof ApiError ? error.code : undefined);
      setFailure(controller.signal.aborted ? new Error('取消只停止等待，服务商可能已受理并计费。') : error);
      setProgress(previous => previous && { ...previous, stage: controller.signal.aborted ? '已取消' : '失败' });
    }
    finally { setBusy(false); abortRef.current = undefined; }
  };
  const executeBatch = async (assets: Asset[]) => {
    if (!assets.length || batch?.running) return;
    const provider = settings.imageProvider;
    if (!keys[provider]) { toast.error(`请先在设置页填写 ${provider === 'openai' ? 'OpenAI' : provider === 'seedream' ? 'Seedream（火山方舟）' : '硅基流动 SiliconFlow'} API Key。`); navigate('settings'); return; }
    const model = settings.models[provider]; const concurrency = imageConcurrency(settings);
    const prepared = assets.map(asset => ({ id: asset.id, name: asset.name, prompt: imagePrompt(project, asset), hash: fixedHash(fixedDescription(asset)) }));
    if (prepared.some(item => !item.prompt.trim())) { toast.error('请先完善资产描述与固定短语。'); return; }
    const controller = new AbortController(); batchAbort.current = controller;
    const jobId = startJob({ kind: 'image', label: `批量生成 ${prepared.length} 张设定图`, cancel: () => controller.abort() });
    setBatch({ items: prepared.map(item => ({ id: item.id, name: item.name, status: 'queued' })), startedAt: Date.now(), running: true });
    const mark = (id: string, patch: Partial<BatchItem>) => setBatch(previous => previous && { ...previous, items: previous.items.map(entry => entry.id === id ? { ...entry, ...patch } : entry) });
    try {
      const results = await runPool(prepared, async item => {
        mark(item.id, { status: 'running', startedAt: Date.now() });
        const live = getStudio().projects.find(p => p.id === project.id);
        const asset = live?.assets.find(a => a.id === item.id);
        if (!live || !asset) throw new Error('资产已删除，本次不生成。');
        if (fixedHash(fixedDescription(asset)) !== item.hash) throw new Error('固定短语已修改，请重新确认。');
        if (getStudio().settings.imageProvider !== provider || getStudio().settings.models[provider] !== model) throw new Error('图片模型设置已改变，请重新确认。');
        const result = await callApi<{ base64: string; mime: string }>('image', { ...credentials(provider), prompt: item.prompt }, controller.signal);
        const after = getStudio().projects.find(p => p.id === project.id);
        const still = after?.assets.find(a => a.id === item.id);
        if (!after || !still || fixedHash(fixedDescription(still)) !== item.hash) throw new Error('资产或固定短语已修改，本次结果未写入。');
        const blob = await generatedImageBlob(result);
        const imageId = await putMedia(blob);
        setAssetImage(project.id, item.id, imageId);
        mark(item.id, { status: 'done', finishedAt: Date.now() });
      }, { concurrency, signal: controller.signal });
      const byId = new Map(results.map(result => [result.item.id, result]));
      setBatch(previous => previous && { ...previous, running: false, items: previous.items.map(entry => { const result = byId.get(entry.id); return result ? { ...entry, status: result.status, error: result.error, finishedAt: Date.now() } : entry; }) });
      const failedCount = results.filter(result => result.status === 'failed').length;
      const doneCount = results.filter(result => result.status === 'done').length;
      finishJob(jobId, failedCount ? 'failed' : results.some(result => result.status === 'canceled' || result.status === 'not_submitted') ? 'canceled' : 'done');
      if (failedCount) toast.error(`成功 ${doneCount} 张 / 失败 ${failedCount} 张`);
      else if (doneCount) toast.success(`已生成 ${doneCount} 张设定图。`);
    } catch (error) {
      setBatch(previous => previous && { ...previous, running: false });
      finishJob(jobId, 'failed');
      toast.error(errorMessage(error));
    } finally {
      batchAbort.current = undefined;
    }
  };
  const visible = project.assets.filter(a => a.kind === kind);
  const imageSamples = durationSamples('image');
  const imageAverage = averageDuration('image');
  const imageRemaining = imageSamples >= 2 && imageAverage ? Math.max(5000, Math.round(imageAverage / 5000) * 5000) : undefined;
  const speechSamples = durationSamples('speech');
  const speechAverage = averageDuration('speech');
  const speechRemaining = speechSamples >= 2 && speechAverage ? Math.max(5000, Math.round(speechAverage / 5000) * 5000) : undefined;
  const missing = visible.filter(asset => !asset.imageId);
  const batchDone = batch?.items.filter(item => item.status === 'done').length ?? 0;
  const batchFailedCount = batch?.items.filter(item => item.status === 'failed').length ?? 0;
  const batchFailed = batch?.items.filter(item => item.status === 'failed').map(item => project.assets.find(asset => asset.id === item.id)).filter((asset): asset is Asset => !!asset) ?? [];
  return <div className="stack">
    <header className="page-heading"><div><span className="tag">02 / 资产设定</span><h1>让故事，有自己的面孔</h1><p className="muted">固定人物、场景和道具描述，再为每个角色找到声音。</p></div><Button onClick={() => edit()}><Plus size={16} />新建{kinds.find(k => k.id === kind)?.name}</Button></header>
    <div className="toolbar" role="tablist" aria-label="资产类别">{kinds.map(k => <Button key={k.id} role="tab" aria-selected={kind === k.id} variant={kind === k.id ? 'default' : 'secondary'} onClick={() => setKind(k.id)}>{k.name} <span>{project.assets.filter(a => a.kind === k.id).length}</span></Button>)}</div>
    {kind !== 'voice' && <div className="panel stack"><Field label="生图模型" hint="选择的厂商和模型会随确认任务实际提交。Seedream 需要火山方舟 Key，试用额度由服务商决定。"><select disabled={busy} value={`${settings.imageProvider}:${settings.models[settings.imageProvider]}`} onChange={e => { const [provider, model] = e.target.value.split(':') as ['openai' | 'seedream' | 'siliconflow', string]; setSettings({ ...settings, imageProvider: provider, models: { ...settings.models, [provider]: model } }); }}>{imageModelGroups.map(group => <optgroup key={group.provider} label={group.label}>{group.models.map(model => <option key={model.id} value={`${group.provider}:${model.id}`}>{model.name} · {model.description}</option>)}{!group.models.some(model => model.id === settings.models[group.provider]) && <option value={`${group.provider}:${settings.models[group.provider]}`}>自定义 · {settings.models[group.provider]}</option>}</optgroup>)}</select></Field><p className="small muted">当前生图渠道：{settings.imageProvider === 'openai' ? 'OpenAI' : settings.imageProvider === 'seedream' ? '火山引擎 / 即梦 · Seedream' : '硅基流动 SiliconFlow（免费）'} · {settings.models[settings.imageProvider]}。免费兜底暂未配置，失败不会自动切换到其他收费渠道。</p></div>}
    {kind !== 'voice' && <div className="toolbar"><Button variant="secondary" disabled={!missing.length || !!batch?.running} onClick={() => void executeBatch(missing)}><Sparkles size={16} />生成缺图（{missing.length}）</Button><span className="small muted">按设置中的并发数同时生成，单张失败不中断。</span></div>}
    <div className="panel"><div className="section-title"><h2>{kinds.find(k => k.id === kind)?.name}资产库</h2><HelpPopover title="资产库说明"><p>{kinds.find(k => k.id === kind)?.text}</p><p className="mt-2">统一锁：图片与视频提示词逐字复用「固定短语」。上传或生成图片不会自动把图片发送到视频服务，请到分镜页选择实际附件。</p></HelpPopover></div></div>
    {kind === 'voice' && <div className="panel stack"><div className="toolbar"><Button variant="secondary" disabled={voicesBusy} onClick={loadVoices}>{voicesBusy ? '正在获取…' : '获取 MiniMax 音色库'}</Button><Button variant="ghost" onClick={() => navigate('settings')}>设置语音服务</Button></div><p className="muted">{voices.length ? `已加载${voices.length}个音色，新建或编辑音色时可选择。` : '未加载在线音色。可手动填写服务商音色ID，或使用明确标注的本机试听。'} API试听会先确认短句；本机试听不会生成可导出的音频。</p><Button variant="ghost" onClick={() => { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }}>停止本机试听</Button></div>}
    {!visible.length ? <Empty title={`还没有${kinds.find(k => k.id === kind)?.name}设定`} text="从一条描述开始，或创建资产后上传自己的图片。这里没有预置作品素材。"><Button variant="secondary" onClick={() => edit()}>创建第一项资产</Button></Empty> : <div className={kind === 'voice' ? 'grid-2' : 'asset-compact-grid'}>{visible.map(asset => asset.kind !== 'voice' ? <article className="panel compact-media-card" key={asset.id}>
      <button type="button" className="compact-media-thumbnail" aria-label={`查看${asset.name}详情`} onClick={() => setFocusedId(asset.id)}><AssetImage asset={asset} /></button>
      <h3 className="compact-media-title">{asset.name}</h3><p className="compact-media-description muted">{asset.description || '尚未填写描述'}</p>
    </article> : <article className="panel stack" key={asset.id}>
      <div className="section-title"><h3>{asset.name}</h3><div className="row"><Button variant="ghost" aria-label={`编辑${asset.name}`} onClick={() => edit(asset)}><Pencil size={16} /></Button><Button variant="ghost" aria-label={`删除${asset.name}`} onClick={() => setDeleting(asset)}><Trash2 size={16} /></Button></div></div>
      <p>{asset.description || '尚未填写描述'}</p>
      <p className="muted">音色ID：{asset.voiceId || '未选择'} · 语速：{asset.speed ?? 1}×</p><div className="toolbar"><Button variant="secondary" disabled={busy} onClick={() => prepareSpeech(asset, false)}><Volume2 size={16} />API 试听（先确认）</Button><Button variant="outline" disabled={busy} onClick={() => prepareSpeech(asset, true)}>本机声音试听（非导出音轨）</Button></div>{previews[asset.id] && <AudioPreview preview={previews[asset.id]} />}
    </article>)}</div>}
    {focused && <Modal open onClose={() => setFocusedId(undefined)} title={`${focused.name} · 资产详情`} description="查看完整设定、固定短语与关联镜头，或管理设定图。"><div className="stack media-detail">
      <AssetImage asset={focused} detail />
      <div><h3>描述</h3><p className="media-detail-text">{focused.description || '尚未填写描述'}</p></div>
      <div className="panel"><h3>固定短语 · 逐字复用</h3><p className="media-detail-text">{fixedDescription(focused) || '尚未设置'}</p></div>
      <p className="muted">关联镜头：{assetUsage(project, focused.id).join('、') || '未被引用'}</p>
      {focused.kind === 'character' && <p className="muted">角色音色：{project.assets.find(a => a.id === focused.voiceAssetId)?.name || '未关联'}</p>}
      <Field label="完整图片提示词"><textarea rows={6} readOnly value={imagePrompt(project, focused)} /></Field>
      <div className="generation-actions"><Button variant="secondary" onClick={() => copyText(focused.description)}><Copy size={14} />复制描述</Button><Button variant="secondary" onClick={() => copyText(fixedDescription(focused))}><Copy size={14} />复制固定短语</Button><Button variant="secondary" onClick={() => copyText(imagePrompt(project, focused))}><Copy size={14} />复制图片提示词</Button></div>
      <Field label="上传设定图（PNG / JPEG / WebP，≤5MB）"><input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { void upload(focused, e.target.files?.[0]); e.target.value = ''; }} /></Field>
      <div className="toolbar"><Button variant="secondary" disabled={busy} onClick={() => { setFocusedId(undefined); prepareImage(focused); }}><Sparkles size={16} />生成设定图</Button>{focused.imageId && <Button variant="ghost" disabled={busy} onClick={() => { setFocusedId(undefined); setRemovingImage(focused); }}><ImagePlus size={16} />移除图片</Button>}</div>
      <div className="toolbar"><Button variant="outline" aria-label={`编辑${focused.name}`} onClick={() => { setFocusedId(undefined); edit(focused); }}><Pencil size={16} />编辑资产</Button><Button variant="ghost" aria-label={`删除${focused.name}`} onClick={() => { setFocusedId(undefined); setDeleting(focused); }}><Trash2 size={16} />删除资产</Button></div>
    </div></Modal>}
    <div className="toolbar"><Button variant="outline" onClick={() => navigate('script')}>返回剧本</Button><Button onClick={() => navigate('storyboard')}>下一步：分镜编排</Button></div>
    <Modal open={!!batch} onClose={() => { if (!batch?.running) setBatch(undefined); }} title="批量生成设定图" description="每张图独立提交，单张失败不影响其他。取消只停止等待，服务商可能已受理并计费。">
      {batch && <div className="stack">
        <ProgressPanel title={`生图并发 ${imageConcurrency(settings)}`} stage={batch.running ? '生成中' : '已结束'} startedAt={batch.startedAt} done={batchDone} total={batch.items.length} failed={batchFailedCount} detail="取消只停止等待，服务商可能已受理并计费。" onCancel={batch.running ? () => batchAbort.current?.abort() : undefined} cancelLabel="全部取消" />
        <div className="stack">{batch.items.map(item => <div className="stack" key={item.id}><div className="row between"><span>{item.name}</span><span className="row"><Elapsed since={item.status === 'running' ? item.startedAt : undefined} /><StatusChip tone={batchTones[item.status]}>{batchLabels[item.status]}</StatusChip></span></div>{item.status === 'failed' && <span className="small muted">{errorMessage(item.error)}</span>}</div>)}</div>
        <div className="toolbar">{!batch.running && batchFailed.length > 0 && <Button variant="secondary" onClick={() => void executeBatch(batchFailed)}>重试失败项（{batchFailed.length}）</Button>}<Button variant="ghost" disabled={batch.running} onClick={() => setBatch(undefined)}>关闭</Button></div>
      </div>}
    </Modal>
    <Modal open={!!editing} onClose={() => setEditing(undefined)} title={`${editing?.isNew ? '新建' : '编辑'}${kinds.find(k => k.id === editing?.asset.kind)?.name || '资产'}`} description="保存后会使相关下游制作结果标为待更新。固定短语会原样用于后续生成。">
      {editing && <div className="stack"><Field label="名称"><input value={editing.asset.name} onChange={e => draftPatch({ name: e.target.value })} /></Field><Field label="描述"><textarea rows={3} value={editing.asset.description} onChange={e => draftPatch({ description: e.target.value, ...(!editing.asset.lock || editing.asset.lock === editing.asset.description ? { lock: e.target.value } : {}) })} /></Field>
        {editing.asset.kind !== 'voice' && <><Field label="固定短语（默认使用描述）" hint="只在这里维护角色、场景、道具的一致性描述；自定义后不会随描述自动改写。"><textarea rows={3} value={editing.asset.lock} onChange={e => draftPatch({ lock: e.target.value })} /></Field><Button variant="ghost" onClick={() => draftPatch({ lock: editing.asset.description })}>使用当前描述作为固定短语</Button></>}
        {editing.asset.kind === 'character' && <Field label="角色配音音色"><select value={editing.asset.voiceAssetId || ''} onChange={e => draftPatch({ voiceAssetId: e.target.value || undefined })}><option value="">暂不关联</option>{project.assets.filter(a => a.kind === 'voice').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}
        {editing.asset.kind === 'voice' && <><div className="toolbar"><Button variant="secondary" disabled={voicesBusy} onClick={loadVoices}>{voicesBusy ? '获取中…' : '加载在线音色'}</Button></div>{voices.length > 0 && <Field label="从服务商列表选择"><select value={voices.some(v => v.id === editing.asset.voiceId) ? editing.asset.voiceId : ''} onChange={e => { if (e.target.value) draftPatch({ voiceId: e.target.value }); }}><option value="">请选择，或在下方手动填写</option>{voices.map(v => <option key={v.id} value={v.id}>{v.name} · {v.id}</option>)}</select></Field>}<Field label="音色ID" hint="保存后可试听并分配给人物；本机试听使用系统声音而非此ID。"><input value={editing.asset.voiceId || ''} onChange={e => draftPatch({ voiceId: e.target.value })} /></Field><Field label="语速（0.5–2）"><input type="number" min={0.5} max={2} step={0.1} value={editing.asset.speed ?? 1} onChange={e => draftPatch({ speed: Number(e.target.value) })} /></Field></>}
        <div className="toolbar"><Button onClick={save}>保存资产</Button><Button variant="ghost" onClick={() => setEditing(undefined)}>取消</Button></div></div>}
    </Modal>
    <Modal open={!!deleting} onClose={() => setDeleting(undefined)} title={`删除「${deleting?.name || ''}」？`} description="会解除镜头资产、参考图、台词说话者和人物音色关联。台词文字保留，但需重新选择人物。此操作不能撤销。"><div className="stack"><p>引用位置：{deleting ? assetUsage(project, deleting.id).join('、') || '未被引用' : ''}</p><div className="toolbar"><Button onClick={() => { if (deleting) updateProject(project.id, p => removeAsset(p, deleting.id), true); setDeleting(undefined); }}>确认删除并解除关联</Button><Button variant="ghost" onClick={() => setDeleting(undefined)}>取消</Button></div></div></Modal>
    <Modal open={!!removingImage} onClose={() => setRemovingImage(undefined)} title="移除图片及引用？" description="保留资产文字设定，但解除所有镜头对此图片的参考附件关联。"><div className="toolbar"><Button onClick={() => { if (removingImage) updateProject(project.id, p => ({ ...p, storyboardReady: false, assets: p.assets.map(a => a.id === removingImage.id ? { ...a, imageId: undefined } : a), shots: p.shots.map(s => ({ ...s, references: s.references.filter(r => r.assetId !== removingImage.id) })) }), true); setRemovingImage(undefined); }}>确认移除图片</Button><Button variant="ghost" onClick={() => setRemovingImage(undefined)}>取消</Button></div></Modal>
    <Modal open={!!pending} onClose={() => { if (!busy) { setPending(undefined); setFailure(undefined); setProgress(undefined); } }} title={pending?.kind === 'image' ? '确认图片生成任务' : '确认试听短句'} description={pending?.kind === 'speech' && pending.local ? '仅使用本机系统声音，不代表MiniMax音色，不会生成或保存可导出音轨。' : '确认后才会请求服务商，可能产生费用。请检查模型、内容与目标资产。'}>
      {pending && <div className="stack"><p>资产：{pending.asset.name}</p>{pending.kind === 'image' ? <><p>服务：{pending.provider === 'openai' ? 'OpenAI' : pending.provider === 'seedream' ? '火山引擎 / 即梦 · Seedream' : '硅基流动 SiliconFlow（免费）'} · {pending.model}。生成后替换当前设定图，原引用会使用新图。</p><Field label="即将发送的完整图片提示词"><textarea rows={12} readOnly value={pending.prompt} /></Field></> : <><p>{pending.local ? '本机 speechSynthesis 系统语音' : `MiniMax · ${pending.model} · 音色ID ${pending.asset.voiceId}`}<br />语速：{pending.asset.speed ?? 1}×</p><Field label="试听短句（1–120字）"><textarea rows={3} maxLength={120} value={speechText} disabled={busy} onChange={e => setSpeechText(e.target.value)} /></Field><p className="muted">{speechText.length} / 120 字。试听不创建镜头配音轨。</p></>}{progress && <ProgressPanel title={pending.kind === 'image' ? '生成设定图' : '试听'} stage={progress.stage} startedAt={progress.startedAt} remainingMs={pending.kind === 'image' ? imageRemaining : speechRemaining} detail={pending.kind === 'image' ? '服务商不返回进度，按已用时等待' : '服务商不返回进度'} onCancel={busy ? () => abortRef.current?.abort() : undefined} cancelLabel="取消等待" />}{failure !== undefined && <ErrorNote error={failure} action={errorAction(failure) === 'settings' ? <Button variant="secondary" size="sm" onClick={() => { setPending(undefined); setFailure(undefined); navigate('settings'); }}>去设置</Button> : errorAction(failure) === 'retry' ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void execute()}>重试</Button> : undefined} />}<div className="toolbar"><Button disabled={busy} onClick={execute}>{busy ? '处理中，请勿重复提交…' : pending.kind === 'image' ? '确认发送并生成图片' : pending.local ? '确认本机试听' : '确认付费 API 试听'}</Button><Button variant="ghost" disabled={busy} onClick={() => setPending(undefined)}>取消</Button></div></div>}
    </Modal>
  </div>;
}

import { Fragment, useEffect, useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { Check, ChevronLeft, ChevronRight, Download, FileText, Play, Plus, Pencil, Trash2, Sparkles, Upload, Volume2, ImagePlus, Copy, X } from 'lucide-react';
import { Button, Empty, ErrorNote, Field, Fold, HelpPopover, Modal, ProgressPanel, StatusChip, copyText, downloadBlob, errorAction, formatElapsed } from '../../components/Ui';
import { PageHeader } from '../../components/PageHeader';
import SearchSelect from '../../components/SearchSelect';
import { makeShot, uid, type Asset, type AssetKind, type PageProps, type Project, type PromptTemplateSet, type Shot } from '../../domain/types';
import { getStudio, setAssetImage, setSettings, updateProject, useStudio } from '../../store/studio';
import { averageDuration, durationSamples, finishJob, startJob, updateJob } from '../../store/jobs';
import { putMedia, getMedia, blobDataUrl, useMediaUrl } from '../../store/media';
import { ApiError, callApi, callBinary, credentials, errorMessage, supportsImageReference, type ImageRequest, type ImageResult } from '../../lib/api';
import { extractCharactersPrompt, extractPropsPrompt, extractScenesPrompt, fixedDescription, imagePrompt, type ExtractCategory } from '../../lib/prompts';
import { imageConcurrency, modelOptions } from '../../lib/models';
import { endpointsFor, modelFor } from '../../lib/endpoints';
import { effectiveStyle } from '../../lib/promptScope';
import { runPool } from '../../lib/pool';
import { assetShotIds, assetUsage, generatedImageBlob, linkSpeakersToCharacter, referenceAssetFor, removeAsset, splitFormName, validateImage } from './helpers';
import { applyCategoryExtraction, extractLocalAssets, mergeDraftAssets } from '../script/creation';
import { assetWarnings, validateAssetsStage, withConfirmation } from '../../domain/flow';

const kinds: { id: AssetKind; name: string; text: string }[] = [
  { id: 'character', name: '人物', text: '固定外观、服装与配音，让每一次出场都保持一致。' },
  { id: 'scene', name: '场景', text: '保留空间、光线与氛围，建立故事的世界。' },
  { id: 'prop', name: '道具', text: '固定轮廓、材质与细节，让关键物件有迹可循。' },
  { id: 'voice', name: '音色', text: '选定音色与语速，再把声音分配给人物。' },
];
type Pending = { kind: 'image'; asset: Asset; revision: number; prompt: string; defaultPrompt: string; provider: string; model: string; providerName: string; reference?: string; referenceName?: string; referenceWarning?: string } | { kind: 'speech'; asset: Asset; revision: number; model: string; local: boolean };
type Reference = { reference?: string; referenceName?: string; warning?: string; problem?: string };
type Preview = { mediaId: string; text: string };
type BatchStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled' | 'not_submitted';
type BatchItem = { id: string; name: string; status: BatchStatus; error?: unknown; startedAt?: number; finishedAt?: number };
type BatchState = { items: BatchItem[]; startedAt: number; running: boolean; prompts: Record<string, string> };

const batchLabels: Record<BatchStatus, string> = { queued: '排队中', running: '生成中', done: '已完成', failed: '失败', canceled: '已取消', not_submitted: '未提交' };
/** 资产提取按品类分开：三类各自一条独立流程，各自一次模型调用。 */
const extractKinds: { id: ExtractCategory; label: string }[] = [
  { id: 'character', label: '人物' },
  { id: 'scene', label: '场景' },
  { id: 'prop', label: '道具' },
];
const extractKindLabel = (kind: ExtractCategory) => extractKinds.find(item => item.id === kind)?.label ?? '资产';
const extractActionFor = (kind: ExtractCategory) => kind === 'character' ? 'extract-characters' : kind === 'scene' ? 'extract-scenes' : 'extract-props';
const extractPromptFor = (kind: ExtractCategory, project: Project, global?: PromptTemplateSet) => kind === 'character' ? extractCharactersPrompt(project, global) : kind === 'scene' ? extractScenesPrompt(project, global) : extractPropsPrompt(project, global);
const batchTones = { queued: 'neutral', running: 'running', done: 'success', failed: 'danger', canceled: 'neutral', not_submitted: 'warning' } as const;
/** 表格内拖动资产图片时携带的数据类型；只接受本页自己放进去的资产 ID。 */
const ASSET_DRAG_TYPE = 'application/x-manju-asset-id';
function fixedHash(value: string) { let hash = 5381; for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0; return String(hash); }
type AssetGroup = { key: string; base: Asset; forms: Asset[] };
function groupByForm(list: Asset[]): AssetGroup[] {
  const map = new Map<string, Asset[]>();
  for (const asset of list) {
    const base = splitFormName(asset.name).base;
    map.set(base, [...(map.get(base) ?? []), asset]);
  }
  return [...map.entries()].map(([key, group]) => {
    const sorted = [...group].sort((a, b) => (splitFormName(a.name).form ? 1 : 0) - (splitFormName(b.name).form ? 1 : 0) || a.name.localeCompare(b.name, 'zh'));
    return { key, base: sorted[0], forms: sorted.slice(1) };
  }).sort((a, b) => a.key.localeCompare(b.key, 'zh'));
}
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
/**
 * 资产表里的「参考图」格：默认留空，把其他资产的图片拖进来即挂载。
 * 挂载后显示来源资产当前的设定图；生成时会把它作为图生图参考发送。
 */
function AssetReference({ asset, source, onMount, onClear }: { asset: Asset; source?: Asset; onMount: (sourceId: string) => void; onClear: () => void }) {
  const url = useMediaUrl(source?.imageId);
  const [over, setOver] = useState(false);
  const hasReference = !!source || (asset.referenceAssetId !== undefined && asset.referenceAssetId !== '');
  const missing = hasReference && (!source || !source.imageId);
  const accepts = (event: DragEvent) => event.dataTransfer.types.includes(ASSET_DRAG_TYPE);
  return <div
    className={`asset-reference-drop ${url ? 'has-image' : 'is-empty'}${over ? ' is-over' : ''}`}
    role="group"
    aria-label={hasReference ? `${asset.name}的参考图${source ? `来自「${source.name}」` : '来源已删除'}` : `为${asset.name}挂载参考图：把其他资产的图片拖到这里`}
    title={hasReference
      ? source ? `参考图来自「${source.name}」；生成时会把这张图作为参考图发送。` : '参考图来源资产已删除，请清除后重新挂载。'
      : '把其他资产的图片拖到这里作为参考图；留空表示纯文本生成。'}
    onDragOver={event => { if (accepts(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setOver(true); } }}
    onDragLeave={event => { const related = event.relatedTarget; if (!(related instanceof Node) || !event.currentTarget.contains(related)) setOver(false); }}
    onDrop={event => {
      event.preventDefault();
      setOver(false);
      const sourceId = event.dataTransfer.getData(ASSET_DRAG_TYPE);
      if (sourceId) onMount(sourceId);
    }}
  >
    {url ? <img className="asset-reference-image" src={url} alt={`参考图：${source?.name ?? ''}`} /> : <span className="asset-reference-empty">{missing ? '参考图缺失' : source?.imageId ? '读取中' : <ImagePlus size={14} />}</span>}
    {hasReference && <button type="button" className="asset-reference-clear" aria-label={`清除${asset.name}的参考图`} onClick={event => { event.stopPropagation(); onClear(); }}><X size={12} /></button>}
  </div>;
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
  const [batchPlan, setBatchPlan] = useState<{ assets: Asset[]; prompts: Record<string, string>; defaults: Record<string, string> }>();
  const [expandedForms, setExpandedForms] = useState<Set<string>>(new Set());
  const [openDesc, setOpenDesc] = useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState<{ assets: Asset[]; added: number; reused: number }>();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadPlan, setUploadPlan] = useState<{ matched: { file: File; asset: Asset }[]; unmatched: File[] }>();
  const [styleNotice, setStyleNotice] = useState(0);

  // 风格设定改过之后，已经生成的设定图不会自动重做：回到资产页时提醒一次。
  useEffect(() => {
    const key = 'manju-style-snapshot';
    const current = JSON.stringify(effectiveStyle(project, settings.promptTemplates));
    try {
      const previous = localStorage.getItem(key);
      if (previous && previous !== current) setStyleNotice(project.assets.filter(asset => asset.kind !== 'voice' && asset.imageId).length);
      localStorage.setItem(key, current);
    } catch { /* 浏览器不让存就算了，提醒可有可无 */ }
  }, [project.id, project.assets.length, settings.promptTemplates]);
  const [assetIssues, setAssetIssues] = useState<string[]>([]);
  const assetTips = assetWarnings(project);
  const [extraction, setExtraction] = useState<{ kind: ExtractCategory; revision: number; prompt: string; defaultPrompt: string; provider: string; model: string }>();
  const [extracting, setExtracting] = useState(false);
  const [extractionDraft, setExtractionDraft] = useState<{ assets: Asset[]; shots: Shot[]; warnings?: string[] }>();
  const extractionScope = extractionDraft && extraction ? extractionDraft.assets.filter(asset => asset.kind === extraction.kind) : [];
  const [extractProgress, setExtractProgress] = useState<{ stage: string; startedAt: number }>();
  const [extractFailure, setExtractFailure] = useState<unknown>();
  const extractAbort = useRef<AbortController | undefined>(undefined);
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
      const live = current(editing.revision, editing.isNew ? undefined : editing.asset.id);
      const original = editing.isNew ? undefined : live.assets.find(asset => asset.id === editing.asset.id);
      const wasLocked = !!original?.locked;
      const a = { ...editing.asset, name: editing.asset.name.trim(), voiceId: editing.asset.voiceId?.trim(), locked: false };
      if (!a.name) throw new Error('请填写资产名称。');
      if (a.kind !== 'voice' && !a.description.trim()) throw new Error('请填写描述，作为固定短语的默认来源。');
      if (!a.lock.trim()) a.lock = a.description;
      if (a.kind === 'voice' && (!Number.isFinite(a.speed ?? 1) || (a.speed ?? 1) < 0.5 || (a.speed ?? 1) > 2)) throw new Error('语速需要在0.5–2之间。');
      if (wasLocked) {
        const shotIds = assetShotIds(live, a.id);
        updateProject(project.id, p => ({ ...p, storyboardReady: false, assets: p.assets.map(item => item.id === a.id ? a : item) }), { only: shotIds, reason: `资产「${a.name}」已修改` });
        toast.success('资产已解锁并保存；只有用到它的镜头会标记待更新。');
      } else {
        updateProject(project.id, p => linkSpeakersToCharacter({ ...p, storyboardReady: false, assets: editing.isNew ? [...p.assets, a] : p.assets.map(item => item.id === a.id ? a : item) }, a), true);
        toast.success('资产设定已保存，下游提示词将复用固定短语。');
      }
      setEditing(undefined);
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
  /**
   * 生成时读取该资产挂载的参考图来源（其他资产的当前设定图）。
   * 参考图 data URL 只存在于确认弹窗与请求体里：不写回项目存档，也不写进 IndexedDB。
   */
  const loadReference = async (asset: Asset, assets: Asset[]): Promise<Reference> => {
    const source = referenceAssetFor(asset, assets);
    if (!source) {
      if (!asset.referenceAssetId) return {};
      const reason = '参考图来源资产已删除';
      return { warning: `${reason}，本次只能按纯文本生成。请重新挂载参考图。`, problem: `${reason}，请重新挂载参考图。` };
    }
    if (!source.imageId) {
      const reason = `参考图来源「${source.name}」还没有设定图`;
      return { referenceName: source.name, warning: `${reason}，本次只能按纯文本生成。`, problem: `${reason}，请先为它生成或上传图片。` };
    }
    try {
      const blob = await getMedia(source.imageId);
      if (!blob) throw new Error('本地素材库里没有这张图');
      await validateImage(blob);
      return { reference: await blobDataUrl(blob), referenceName: source.name };
    } catch (error) {
      const reason = `参考图来源「${source.name}」的设定图读取失败：${errorMessage(error)}`;
      return { referenceName: source.name, warning: `${reason}。本次只能按纯文本生成。`, problem: reason };
    }
  };
  const prepareImage = async (asset: Asset) => {
    const provider = settings.imageProvider;
    const endpoint = settings.endpoints.find(item => item.id === provider);
    const providerName = endpoint?.name ?? '当前生图端点';
    if (!provider) { toast.error('还没有可用的生图端点，请到设置页添加或恢复一个。'); navigate('settings'); return; }
    if (!keys[provider]) { toast.error(`请先在设置页填写 ${providerName} 的 API Key。`); navigate('settings'); return; }
    if (!fixedDescription(asset).trim()) { toast.error('请先完善资产描述与固定短语。'); return; }
    setFailure(undefined);
    const prompt = imagePrompt(project, asset, settings.promptTemplates);
    // 只有挂载了参考图的资产才读取参考图；没有挂载就是纯文本请求。
    const reference = await loadReference(asset, project.assets);
    setPending({
      kind: 'image', asset: { ...asset }, revision: project.revision, prompt, defaultPrompt: prompt,
      provider, model: modelFor(settings, provider, 'image'), providerName,
      ...(reference.reference ? { reference: reference.reference } : {}),
      ...(reference.referenceName ? { referenceName: reference.referenceName } : {}),
      ...(reference.warning ? { referenceWarning: reference.warning } : {}),
    });
  };
  const loadVoices = async () => {
    if (!keys.minimax) { toast.error('请先在设置页填写 MiniMax API Key。'); navigate('settings'); return; }
    setVoicesBusy(true);
    try {
      const data = await callApi<{ id: string; name: string }[]>('voices', { ...credentials('minimax', 'speech') });
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
        if (!task.prompt.trim()) throw new Error('图片提示词不能为空：请在模板编辑器里补充内容。');
        const auth = credentials(task.provider, 'image');
        if (getStudio().settings.imageProvider !== task.provider || auth.model !== task.model) throw new Error('图片模型设置已改变，请重新确认。');
        updateJob(jobId, { detail: '生成图片中' });
        setProgress(previous => previous && { ...previous, stage: '生成图片中' });
        const payload: ImageRequest = { ...auth, prompt: task.prompt, ...(task.reference ? { reference: task.reference } : {}) };
        const result = await callApi<ImageResult>('image', payload, controller.signal);
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
          const blob = await callBinary('speech', { ...credentials('minimax', 'speech'), model: task.model, text, voiceId: task.asset.voiceId, speed: task.asset.speed ?? 1 }, controller.signal);
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
  const prepareBatch = (assets: Asset[]) => {
    if (!assets.length) return;
    const provider = settings.imageProvider;
    const providerName = settings.endpoints.find(endpoint => endpoint.id === provider)?.name ?? '当前生图端点';
    if (!provider) { toast.error('还没有可用的生图端点，请到设置页添加或恢复一个。'); navigate('settings'); return; }
    if (!keys[provider]) { toast.error(`请先在设置页填写 ${providerName} 的 API Key。`); navigate('settings'); return; }
    if (assets.some(asset => !fixedDescription(asset).trim())) { toast.error('请先完善资产描述与固定短语。'); return; }
    setFailure(undefined);
    const defaults = Object.fromEntries(assets.map(asset => [asset.id, imagePrompt(project, asset, settings.promptTemplates)]));
    setBatchPlan({ assets: assets.map(asset => ({ ...asset })), prompts: { ...defaults }, defaults });
  };
  const executeBatch = async (assets: Asset[], prompts?: Record<string, string>) => {
    if (!assets.length || batch?.running) return;
    const provider = settings.imageProvider;
    const providerName = settings.endpoints.find(endpoint => endpoint.id === provider)?.name ?? '当前生图端点';
    if (!provider) { toast.error('还没有可用的生图端点，请到设置页添加或恢复一个。'); navigate('settings'); return; }
    if (!keys[provider]) { toast.error(`请先在设置页填写 ${providerName} 的 API Key。`); navigate('settings'); return; }
    const model = modelFor(settings, provider, 'image'); const concurrency = imageConcurrency(settings);
    const prepared = assets.map(asset => ({ id: asset.id, name: asset.name, prompt: prompts?.[asset.id] ?? imagePrompt(project, asset, settings.promptTemplates), hash: fixedHash(fixedDescription(asset)) }));
    if (prepared.some(item => !item.prompt.trim())) { toast.error('提示词不能为空：请在模板编辑器里补充内容后再生成。'); return; }
    const controller = new AbortController(); batchAbort.current = controller;
    const jobId = startJob({ kind: 'image', label: `批量生成 ${prepared.length} 张设定图`, cancel: () => controller.abort() });
    setBatch({ items: prepared.map(item => ({ id: item.id, name: item.name, status: 'queued' })), startedAt: Date.now(), running: true, prompts: Object.fromEntries(prepared.map(item => [item.id, item.prompt])) });
    const mark = (id: string, patch: Partial<BatchItem>) => setBatch(previous => previous && { ...previous, items: previous.items.map(entry => entry.id === id ? { ...entry, ...patch } : entry) });
    try {
      const results = await runPool(prepared, async item => {
        mark(item.id, { status: 'running', startedAt: Date.now() });
        const live = getStudio().projects.find(p => p.id === project.id);
        const asset = live?.assets.find(a => a.id === item.id);
        if (!live || !asset) throw new Error('资产已删除，本次不生成。');
        if (fixedHash(fixedDescription(asset)) !== item.hash) throw new Error('固定短语已修改，请重新确认。');
        if (getStudio().settings.imageProvider !== provider || modelFor(getStudio().settings, provider, 'image') !== model) throw new Error('图片模型设置已改变，请重新确认。');
        // 批量里只有非基础形态带参考图；基础形态/普通资产仍是纯文本请求。
        const reference = await loadReference(asset, live.assets);
        if (reference.problem) throw new Error(reference.problem);
        const payload: ImageRequest = { ...credentials(provider, 'image'), prompt: item.prompt, ...(reference.reference ? { reference: reference.reference } : {}) };
        const result = await callApi<ImageResult>('image', payload, controller.signal);
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
  const confirmAssets = (goNext = false) => {
    const problems = validateAssetsStage(project);
    setAssetIssues(problems);
    if (problems.length) { toast.error(`还有 ${problems.length} 项资产需要完善。`); return; }
    updateProject(project.id, p => ({ ...p, assets: p.assets.map(asset => ({ ...asset, locked: true })), confirmed: withConfirmation(p, 'assets') }), false);
    toast.success('资产已确认并锁定；如需修改，请使用「解锁并编辑」。');
    if (goNext) navigate('director');
  };
  const prepareExtraction = (kind: ExtractCategory) => {
    try {
      if (!project.shots.length) { toast.error('请先完成剧本，再提取资产。'); return; }
      const auth = credentials(settings.scriptProvider, 'script');
      const prompt = extractPromptFor(kind, project, settings.promptTemplates);
      if (prompt.length > 32_000) throw new Error('剧本过长，请精简后再提取；现有资产未修改。');
      setExtraction({ kind, revision: project.revision, prompt, defaultPrompt: prompt, provider: settings.scriptProvider, model: auth.model });
      setExtractionDraft(undefined); setExtractFailure(undefined); setExtractProgress(undefined);
    } catch (error) { toast.error(errorMessage(error)); }
  };
  const runExtraction = async () => {
    if (!extraction || extracting) return;
    const task = extraction;
    if (!task.prompt.trim()) { toast.error('提示词不能为空：请在模板编辑器里添加内容。'); return; }
    setExtracting(true); setExtractFailure(undefined);
    const controller = new AbortController(); extractAbort.current = controller;
    const jobId = startJob({ kind: 'storyboard', label: `提取${extractKindLabel(task.kind)}资产`, cancel: () => controller.abort() });
    setExtractProgress({ stage: '提交任务', startedAt: Date.now() });
    try {
      const auth = credentials(task.provider, 'script');
      const live = getStudio().projects.find(p => p.id === project.id);
      if (!live || live.revision !== task.revision) throw new Error('剧本或资产已修改，请重新确认提取。');
      if (auth.model !== task.model) throw new Error('模型设置已改变，请重新确认提取。');
      updateJob(jobId, { detail: '模型生成中' });
      setExtractProgress(previous => previous && { ...previous, stage: '模型生成中' });
      const result = await callApi<unknown>(extractActionFor(task.kind), { ...auth, prompt: task.prompt }, controller.signal);
      setExtractProgress(previous => previous && { ...previous, stage: '校验结构' });
      const current = getStudio().projects.find(p => p.id === project.id);
      if (!current || current.revision !== task.revision) throw new Error('项目已修改或删除，提取结果未覆盖现有内容。');
      const draft = applyCategoryExtraction(current, result, task.kind);
      setExtractionDraft(draft);
      finishJob(jobId, 'done'); setExtractProgress(undefined);
    } catch (error) {
      finishJob(jobId, controller.signal.aborted ? 'canceled' : 'failed', error instanceof ApiError ? error.code : undefined);
      setExtractFailure(controller.signal.aborted ? new Error('取消只停止等待，服务商可能已受理并计费。') : error);
      setExtractProgress(previous => previous && { ...previous, stage: controller.signal.aborted ? '已取消' : '失败' });
    } finally { setExtracting(false); extractAbort.current = undefined; }
  };
  const saveExtraction = () => {
    if (!extractionDraft || !extraction) return;
    const live = getStudio().projects.find(p => p.id === project.id);
    if (!live || live.revision !== extraction.revision) { toast.error('剧本或资产已修改，本次提取结果未写入。'); setExtractionDraft(undefined); return; }
    updateProject(project.id, p => ({ ...p, storyboardReady: false, assets: extractionDraft.assets, shots: extractionDraft.shots }), true);
    const scope = extractionDraft.assets.filter(asset => asset.kind === extraction.kind);
    const added = scope.filter(asset => !project.assets.some(old => old.id === asset.id)).length;
    toast.success(`已写入 ${added} 项新${extractKindLabel(extraction.kind)}资产，其余沿用原有固定短语。`);
    setExtraction(undefined); setExtractionDraft(undefined);
  };
  const parseAssetImport = () => {
    const text = importText.trim();
    if (!text) { toast.error('请粘贴或上传资产清单。'); return; }
    const draft = extractLocalAssets([{ ...makeShot(1), visual: text }], project.assets);
    const merged = mergeDraftAssets(project.assets, draft);
    const added = merged.assets.filter(asset => !project.assets.some(old => old.id === asset.id)).length;
    setImportPreview({ assets: merged.assets, added, reused: merged.assets.length - added });
  };
  const saveAssetImport = () => {
    if (!importPreview) return;
    updateProject(project.id, p => {
      const next: Project = { ...p, storyboardReady: false, assets: importPreview.assets };
      return importPreview.assets.reduce<Project>((acc, asset) => linkSpeakersToCharacter(acc, asset), next);
    }, true);
    toast.success(`已写入 ${importPreview.added} 项新资产，沿用 ${importPreview.reused} 项。`);
    setImportOpen(false); setImportPreview(undefined); setImportText('');
  };
  const planUpload = (files: File[]) => {
    const matched: { file: File; asset: Asset }[] = []; const unmatched: File[] = [];
    for (const file of files) {
      const name = file.name.replace(/\.[^.]+$/, '');
      const asset = project.assets.find(item => item.kind !== 'voice' && item.name === name);
      if (asset) matched.push({ file, asset }); else unmatched.push(file);
    }
    setUploadPlan({ matched, unmatched });
  };
  const saveUploads = async () => {
    if (!uploadPlan) return;
    let saved = 0; const failed: string[] = [];
    for (const { file, asset } of uploadPlan.matched) {
      try { await validateImage(file); const imageId = await putMedia(file); patch(asset.id, { imageId }); saved += 1; }
      catch (error) { failed.push(`${asset.name}：${errorMessage(error)}`); }
    }
    setUploadOpen(false); setUploadPlan(undefined);
    if (failed.length) toast.error(`已保存 ${saved} 张；失败 ${failed.length} 项：${failed.slice(0, 2).join('；')}`);
    else toast.success(`已导入 ${saved} 张设定图。`);
  };
  const visible = project.assets.filter(a => a.kind === kind);
  const imageSamples = durationSamples('image');
  const imageAverage = averageDuration('image');
  const imageRemaining = imageSamples >= 2 && imageAverage ? Math.max(5000, Math.round(imageAverage / 5000) * 5000) : undefined;
  const speechSamples = durationSamples('speech');
  const speechAverage = averageDuration('speech');
  const speechRemaining = speechSamples >= 2 && speechAverage ? Math.max(5000, Math.round(speechAverage / 5000) * 5000) : undefined;
  const missing = visible.filter(asset => !asset.imageId);
  const kindName = kinds.find(k => k.id === kind)?.name ?? '资产';
  const assetLabel = kind === 'character' ? '角色' : kindName;
  const groups = groupByForm(visible);
  const toggleForm = (key: string) => setExpandedForms(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const toggleDesc = (id: string) => setOpenDesc(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const voiceName = (asset: Asset) => asset.kind === 'voice' ? (asset.voiceId || '未选择') : (project.assets.find(a => a.id === asset.voiceAssetId)?.name || '—');
  const addForm = (base: Asset) => {
    const baseInfo = splitFormName(base.name);
    const seed = base.description.trim();
    const prefix = seed ? (/[。！？.!?]$/.test(seed) ? seed : `${seed}。`) : '';
    setEditing({
      asset: {
        id: uid(), kind: base.kind,
        name: `${baseInfo.base} · 新形态`,
        description: `${prefix}新形态：保持五官、发型与配色一致，需要变化的部分：`,
        lock: base.lock || seed,
        imageId: base.imageId,
        voiceAssetId: base.voiceAssetId,
        referenceAssetId: base.imageId ? base.id : undefined,
      },
      revision: project.revision, isNew: true,
    });
    if (base.imageId) toast.info('新形态已继承当前设定图与固定短语，并把基础形态的当前设定图挂为参考图；可在表格「参考图」格里换成其他资产。');
  };
  const exportAssets = () => {
    const rows = groups.flatMap(group => [group.base, ...group.forms]);
    const text = rows.map(asset => `## ${asset.name}\n\n- 类型：${kinds.find(k => k.id === asset.kind)?.name}\n- 描述：${asset.description || '未填写'}\n- 固定短语：${fixedDescription(asset) || '未设置'}\n- 音色：${voiceName(asset)}\n- 图片：${asset.imageId ? '已有' : '缺失'}`).join('\n\n');
    downloadBlob(new Blob([`# ${project.name} · ${kindName}\n\n${text}\n`], { type: 'text/markdown;charset=utf-8' }), `${project.name}-${kindName}.md`);
  };
  const focusIndex = focused ? visible.findIndex(asset => asset.id === focused.id) : -1;
  const focusedReference = focused ? referenceAssetFor(focused, project.assets) : undefined;
  const moveFocus = (direction: number) => { if (focusIndex < 0 || visible.length < 2) return; setFocusedId(visible[(focusIndex + direction + visible.length) % visible.length].id); };
  useEffect(() => {
    if (!focused) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === 'ArrowLeft') moveFocus(-1);
      if (event.key === 'ArrowRight') moveFocus(1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focused?.id, visible.map(asset => asset.id).join('|')]);
  const batchDone = batch?.items.filter(item => item.status === 'done').length ?? 0;
  const batchFailedCount = batch?.items.filter(item => item.status === 'failed').length ?? 0;
  const batchFailed = batch?.items.filter(item => item.status === 'failed').map(item => project.assets.find(asset => asset.id === item.id)).filter((asset): asset is Asset => !!asset) ?? [];
  const imageChannel = settings.endpoints.find(endpoint => endpoint.id === settings.imageProvider)?.name ?? '未选择端点';
  const imageModel = modelFor(settings, settings.imageProvider, 'image');
  const renderRow = (asset: Asset, group: AssetGroup) => {
    const info = splitFormName(asset.name);
    const isBase = asset.id === group.base.id;
    const isOpen = expandedForms.has(group.key);
    const usages = assetUsage(project, asset.id);
    const descOpen = openDesc.has(asset.id);
    return <tr className={`asset-row ${isBase ? '' : 'is-form'}`.trim()} key={asset.id}>
      <td className="asset-form-cell"><div className="asset-form">
        {isBase && group.forms.length > 0 ? <button type="button" className="form-toggle" aria-expanded={isOpen} aria-label={`${isOpen ? '收起' : '展开'}${group.key}的形态`} onClick={() => toggleForm(group.key)}><ChevronRight size={14} /></button> : <span className="form-toggle-space" />}
        <span className="tag subtle">{info.form || '基础形态'}</span>
      </div></td>
      <td><div className="asset-name-cell">{asset.kind === 'voice' ? <span className="asset-name">{info.base}</span> : <button type="button" className="text-button asset-name" aria-label={`查看${asset.name}详情`} title={usages.length ? `关联镜头：${usages.join('、')}` : '未被镜头引用'} onClick={() => setFocusedId(asset.id)}>{info.base}</button>}{asset.locked && <span className="tag subtle">已锁定</span>}</div></td>
      <td><button type="button" className={`text-button form-desc ${descOpen ? 'is-open' : ''}`.trim()} aria-expanded={descOpen} title={descOpen ? '收起描述' : '展开全文'} onClick={() => toggleDesc(asset.id)}>{asset.description || '尚未填写描述'}</button></td>
      <td className="asset-cell-muted">{voiceName(asset)}</td>
      <td>{asset.kind === 'voice' ? <span className="muted">—</span> : <AssetReference
        asset={asset}
        source={referenceAssetFor(asset, project.assets)}
        onMount={sourceId => {
          const source = project.assets.find(item => item.id === sourceId);
          if (!source) return;
          if (source.id === asset.id) { toast.error('不能把这个资产自己的图片作为参考图。'); return; }
          if (!source.imageId) { toast.error(`「${source.name}」还没有设定图，不能作为参考图。`); return; }
          updateProject(project.id, p => ({ ...p, assets: p.assets.map(item => item.id === asset.id ? { ...item, referenceAssetId: source.id } : item) }), false);
          toast.success(`已把「${source.name}」的当前设定图挂为「${asset.name}」的参考图。`);
        }}
        onClear={() => {
          updateProject(project.id, p => ({ ...p, assets: p.assets.map(item => item.id === asset.id ? { ...item, referenceAssetId: '' } : item) }), false);
          toast.success('已清除参考图，之后按纯文本生成。');
        }}
      />}</td>
      <td>{asset.kind === 'voice' ? <span className="muted">—</span> : <button type="button" className="asset-table-thumb" aria-label={`查看${asset.name}图片`} draggable={!!asset.imageId} onDragStart={event => { if (!asset.imageId) { event.preventDefault(); return; } event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id); event.dataTransfer.effectAllowed = 'copy'; }} onClick={() => setFocusedId(asset.id)}><AssetImage asset={asset} /></button>}</td>
      <td><div className="asset-row-actions">
        {asset.kind === 'voice' ? <>
          <Button variant="ghost" size="sm" aria-label={`API试听${asset.name}`} disabled={busy} onClick={() => prepareSpeech(asset, false)}><Volume2 size={14} /></Button>
          <Button variant="ghost" size="sm" aria-label={`本机试听${asset.name}`} disabled={busy} onClick={() => prepareSpeech(asset, true)}><Play size={14} /></Button>
        </> : <Button variant="ghost" size="sm" aria-label={`生成${asset.name}图片`} disabled={busy} onClick={() => { void prepareImage(asset); }}><Sparkles size={14} /></Button>}
        {isBase && asset.kind !== 'voice' && <Button variant="ghost" size="sm" aria-label={`为${group.key}新增形态`} onClick={() => addForm(group.base)}><Plus size={14} /></Button>}
        <Button variant="ghost" size="sm" aria-label={`编辑${asset.name}`} onClick={() => edit(asset)}><Pencil size={14} /></Button>
        <Button variant="ghost" size="sm" aria-label={`删除${asset.name}`} onClick={() => setDeleting(asset)}><Trash2 size={14} /></Button>
      </div></td>
    </tr>;
  };
  return <div className="stack">
    <PageHeader title="让故事，有自己的面孔" help={<HelpPopover label="资产设定说明" title="资产设定"><p>固定人物、场景和道具描述，再为每个角色找到声音。</p><p className="mt-2">{kinds.map(item => `${item.name}：${item.text}`).join(' ')}</p><p className="mt-2">统一锁：图片与视频提示词逐字复用「固定短语」。上传或生成图片不会自动把图片发送到视频服务，请到分镜页选择实际附件。</p><p className="mt-2">多形态：把名字写成「角色 · 形态」（例：阿青 · 战损）就会归到同一角色下，基础形态就是角色名本身；音色类别可在线获取 MiniMax 音色库。</p><p className="mt-2">参考图：把某个资产的图片拖到另一个资产的「参考图」格子里，生成时就会把来源资产当前的设定图作为图生图参考；格子留空表示纯文本生成。新增形态会默认挂载基础形态的当前设定图，可以换成其他资产或清除。</p><p className="mt-2">从剧本提取：读取 {project.shots.length} 个镜头，三类分开识别，各用各的提示词、各自一次调用；已有资产的固定短语原样保留，提取结果先预览再写入。</p></HelpPopover>} />
    <div className="toolbar" role="tablist" aria-label="资产类别">{kinds.map(k => <Button key={k.id} role="tab" aria-selected={kind === k.id} variant={kind === k.id ? 'default' : 'secondary'} onClick={() => setKind(k.id)}>{k.name} <span>{project.assets.filter(a => a.kind === k.id).length}</span></Button>)}</div>
    <div className="asset-bulk" aria-label="资产批量操作">
      <Button onClick={() => edit()}><Plus size={16} />新增{assetLabel}</Button>
      <Button variant="secondary" onClick={() => confirmAssets(false)}><Check size={16} />保存并锁定</Button>
      {kind !== 'voice' && <Button variant="outline" onClick={() => { setUploadPlan(undefined); setUploadOpen(true); }}><Upload size={16} />按文件名匹配图片</Button>}
      {kind !== 'voice' && <Button variant="outline" disabled={!missing.length || !!batch?.running} onClick={() => prepareBatch(missing)}><Sparkles size={16} />批量生成{assetLabel}图片{missing.length ? `（${missing.length}）` : ''}</Button>}
      <Button variant="outline" onClick={() => { setImportPreview(undefined); setImportOpen(true); }}><FileText size={16} />批量导入资产</Button>
      <Button variant="outline" onClick={exportAssets}><Download size={16} />{assetLabel}导出</Button>
      {kind !== 'voice' && <Button variant="ghost" onClick={() => { location.hash = '/settings/templates?kind=image&scope=project'; }}>编辑模板</Button>}
      {kind === 'voice' && <Button variant="ghost" disabled={voicesBusy} onClick={loadVoices}>{voicesBusy ? '正在获取…' : '获取 MiniMax 音色库'}</Button>}
      {kind === 'voice' && <Button variant="ghost" onClick={() => navigate('settings')}>设置语音服务</Button>}
      {kind === 'voice' && <Button variant="ghost" onClick={() => { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }}>停止本机试听</Button>}
      {kind !== 'voice' && <SearchSelect label="生图模型" disabled={busy} value={`${settings.imageProvider}:${imageModel}`} onChange={value => { const cut = value.indexOf(':'); const provider = value.slice(0, cut); const model = value.slice(cut + 1); setSettings({ ...settings, imageProvider: provider, models: { ...settings.models, [provider]: { ...settings.models[provider], image: model } } }); }} options={endpointsFor(settings, 'image').flatMap(endpoint => modelOptions(settings, endpoint.id, 'image').map(option => ({ value: `${endpoint.id}:${option.id}`, label: option.name, hint: `${option.id} · ${option.description}`, group: endpoint.name })))} />}
      {kind !== 'voice' && <HelpPopover label="生图模型说明" title="生图模型与渠道"><p>选择的厂商和模型会随确认任务实际提交。Seedream 需要火山方舟 Key，试用额度由服务商决定。</p><p className="mt-2">当前生图渠道：{imageChannel} · {imageModel}。免费兜底暂未配置，失败不会自动切换到其他收费渠道。</p></HelpPopover>}
      {kind !== 'voice' && <div className="asset-concurrency"><span className="small muted">并发数</span><select aria-label="并发数" value={imageConcurrency(settings)} onChange={event => setSettings({ ...settings, imageConcurrency: Number(event.target.value) })}>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}</select></div>}
    </div>
    {styleNotice > 0 && <div className="alert row between wrap" role="alert"><span>风格已更新，已生成的 {styleNotice} 张图不会自动重做。</span><Button variant="secondary" size="sm" onClick={() => { setStyleNotice(0); prepareBatch(project.assets.filter(asset => asset.kind !== 'voice')); }}>重新生成全部（{styleNotice}）</Button></div>}
    {assetIssues.length > 0 && <div className="alert" role="alert"><strong>资产还需要完善：</strong><ul>{assetIssues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
    {!visible.length ? <Empty title={`还没有${kinds.find(k => k.id === kind)?.name}设定`} text="从一条描述开始，或创建资产后上传自己的图片。这里没有预置作品素材。"><Button variant="secondary" onClick={() => edit()}>创建第一项资产</Button></Empty> : <div className="asset-table-wrap"><table className="asset-table">
      <thead><tr><th className="col-form">形态</th><th>角色 / 形态</th><th>形态描述</th><th>音色</th><th>参考图</th><th>图片</th><th>操作</th></tr></thead>
      <tbody>{groups.map(group => <Fragment key={group.key}>{renderRow(group.base, group)}{expandedForms.has(group.key) && group.forms.map(form => renderRow(form, group))}</Fragment>)}</tbody>
    </table></div>}
    {kind === 'voice' && Object.entries(previews).map(([id, preview]) => <div className="panel stack" key={id}><strong>{project.assets.find(a => a.id === id)?.name ?? '音色'} · 试听</strong><AudioPreview preview={preview} /></div>)}
    {assetTips.length > 0 && <Fold tone="alert" title="建议（不阻断确认）" meta={`${assetTips.length} 项`}><ul>{assetTips.map(tip => <li key={tip}>{tip}</li>)}</ul></Fold>}
    <Fold title="从剧本提取资产" meta={project.shots.length ? `读取 ${project.shots.length} 镜 · 三类分开识别` : '请先在剧本步骤完成剧本'}>
      <div className="row wrap">{extractKinds.map(item => <Button key={item.id} variant="secondary" disabled={!project.shots.length || extracting} onClick={() => prepareExtraction(item.id)}><Sparkles size={16} />AI 提取{item.label}（先确认）</Button>)}<HelpPopover title="提取规则"><p>读取剧本的 {project.shots.length} 个镜头，提取人物、场景、道具与逐镜关联。只提取、不重写剧情、对白与时长。</p><p className="mt-2">三类分开识别，各用各的提示词、各自一次调用：人物看说话人与台词，场景按空间归组，道具只看动作摘要。已有资产的固定短语原样保留（逐字沿用）；只有仍是空白的占位人物才会被补全。提取结果必须先预览再写入。</p></HelpPopover></div>
      <p className="small muted">{project.shots.length ? `将读取 ${project.shots.length} 镜 · ${settings.scriptProvider === 'gemini' ? 'Gemini' : 'DeepSeek'} ${settings.models[settings.scriptProvider]}` : '请先在剧本步骤生成或导入剧本'}</p>
    </Fold>
    {focused && <Modal wide open onClose={() => setFocusedId(undefined)} title={`${focused.name} · 资产详情`} description="查看完整设定、固定短语与关联镜头，或管理设定图。"><div className="stack media-detail">
      <div className="row between"><span className="small muted">{focusIndex + 1} / {visible.length} · {kinds.find(k => k.id === focused.kind)?.name}</span><div className="row"><Button variant="ghost" aria-label="上一张" disabled={visible.length < 2} onClick={() => moveFocus(-1)}><ChevronLeft size={16} />上一张</Button><Button variant="ghost" aria-label="下一张" disabled={visible.length < 2} onClick={() => moveFocus(1)}>下一张<ChevronRight size={16} /></Button></div></div>
      <div className="lightbox">
        <div className="lightbox-media"><AssetImage asset={focused} detail /></div>
        <div className="stack lightbox-info">
          <div><h3>描述</h3><p className="media-detail-text">{focused.description || '尚未填写描述'}</p></div>
          <div className="panel"><h3>固定短语 · 逐字复用</h3><p className="media-detail-text">{fixedDescription(focused) || '尚未设置'}</p></div>
          <p className="muted">关联镜头：{assetUsage(project, focused.id).join('、') || '未被引用'}</p>
          <p className="muted">参考图：{focusedReference ? (focusedReference.imageId ? `来自「${focusedReference.name}」` : `来源「${focusedReference.name}」尚无设定图`) : focused.referenceAssetId ? '来源资产已删除' : '未挂载（纯文本生成）'}</p>
          {focused.kind === 'character' && <p className="muted">角色音色：{project.assets.find(a => a.id === focused.voiceAssetId)?.name || '未关联'}</p>}
          <Field label="完整图片提示词"><textarea rows={6} readOnly value={imagePrompt(project, focused, settings.promptTemplates)} /></Field>
          <div className="generation-actions"><Button variant="secondary" onClick={() => copyText(focused.description)}><Copy size={14} />复制描述</Button><Button variant="secondary" onClick={() => copyText(fixedDescription(focused))}><Copy size={14} />复制固定短语</Button><Button variant="secondary" onClick={() => copyText(imagePrompt(project, focused, settings.promptTemplates))}><Copy size={14} />复制图片提示词</Button></div>
          <Field label="上传设定图（PNG / JPEG / WebP，≤5MB）"><input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { void upload(focused, e.target.files?.[0]); e.target.value = ''; }} /></Field>
          <div className="toolbar"><Button variant="secondary" disabled={busy} onClick={() => { setFocusedId(undefined); void prepareImage(focused); }}><Sparkles size={16} />生成设定图</Button>{focused.imageId && <Button variant="ghost" disabled={busy} onClick={() => { setFocusedId(undefined); setRemovingImage(focused); }}><ImagePlus size={16} />移除图片</Button>}</div>
          <div className="toolbar"><Button variant="outline" aria-label={`${focused.locked ? '解锁并编辑' : '编辑'}${focused.name}`} onClick={() => { setFocusedId(undefined); edit(focused); }}><Pencil size={16} />{focused.locked ? '解锁并编辑' : '编辑资产'}</Button><Button variant="ghost" aria-label={`删除${focused.name}`} onClick={() => { setFocusedId(undefined); setDeleting(focused); }}><Trash2 size={16} />删除资产</Button></div>
        </div>
      </div>
    </div></Modal>}
    <div className="toolbar"><Button variant="outline" onClick={() => navigate('script')}>返回剧本</Button><Button onClick={() => confirmAssets(true)}>确认并进入下一步</Button></div>
    <Modal open={!!extraction} onClose={() => { if (!extracting) { setExtraction(undefined); setExtractionDraft(undefined); setExtractFailure(undefined); setExtractProgress(undefined); } }} title={`确认 AI 提取${extraction ? extractKindLabel(extraction.kind) : ''}资产`} description="只从现有剧本提取本类资产与逐镜关联，不重写剧情。确认后调用付费剧本模型；结果仍需预览再写入。">
      {extraction && <div className="stack"><p>{extraction.provider} · {extraction.model} · {project.shots.length} 镜</p><Field label={`即将发送的${extractKindLabel(extraction.kind)}提取提示词`} hint="可直接修改，只影响本次请求；模板不会被改写。"><textarea rows={12} value={extraction.prompt} disabled={extracting} onChange={e => setExtraction(previous => previous && { ...previous, prompt: e.target.value })} /></Field><Button variant="ghost" size="sm" disabled={extracting} onClick={() => setExtraction(previous => previous && { ...previous, prompt: previous.defaultPrompt })}>恢复默认提示词</Button>{extractProgress && <ProgressPanel title={`AI 提取${extractKindLabel(extraction.kind)}资产`} stage={extractProgress.stage} startedAt={extractProgress.startedAt} detail="服务商不返回进度，按已用时等待" onCancel={extracting ? () => extractAbort.current?.abort() : undefined} cancelLabel="取消等待" />}{extractFailure !== undefined && <ErrorNote error={extractFailure} action={errorAction(extractFailure) === 'settings' ? <Button variant="secondary" size="sm" onClick={() => { setExtraction(undefined); setExtractFailure(undefined); setExtractProgress(undefined); navigate('settings'); }}>去设置</Button> : errorAction(extractFailure) === 'retry' ? <Button variant="secondary" size="sm" disabled={extracting} onClick={() => void runExtraction()}>重试</Button> : undefined} />}{extractionDraft && <div className="panel stack"><div className="section-title"><h3>提取结果预览 · {extractKindLabel(extraction.kind)}</h3><span className="tag">{extractionScope.length} 项资产</span></div>{(extractionDraft.warnings ?? []).map(note => <p className="small" key={note}>{note}</p>)}{extractionScope.map(asset => <p key={asset.id}><strong>{kinds.find(k => k.id === asset.kind)?.name}「{asset.name}」</strong>：{asset.lock || asset.description}{project.assets.some(old => old.id === asset.id) ? '（沿用）' : '（新增）'}</p>)}<p className="small muted">写入后需要人工审核固定短语，并逐镜确认关联。本次只写入{extractKindLabel(extraction.kind)}资产，其它两类不受影响。</p><div className="toolbar"><Button onClick={saveExtraction}>确认写入资产库</Button><Button variant="ghost" onClick={() => setExtractionDraft(undefined)}>重新提取</Button></div></div>}{!extractionDraft && <div className="toolbar"><Button disabled={extracting || !extraction.prompt.trim()} onClick={() => void runExtraction()}>{extracting ? '正在提取…' : `确认发送并提取${extractKindLabel(extraction.kind)}资产`}</Button><Button variant="ghost" disabled={extracting} onClick={() => { setExtraction(undefined); setExtractProgress(undefined); }}>取消</Button></div>}</div>}
    </Modal>
    <Modal open={importOpen} onClose={() => { setImportOpen(false); setImportPreview(undefined); }} title="批量导入资产" description="每行一条：类型：名称：描述。支持人物 / 场景 / 道具，先预览再写入。">
      <div className="stack"><Field label="粘贴资产清单"><textarea rows={6} value={importText} placeholder={'人物：阿青：十六岁少年，黑短发，青色布衣\n场景：山门：黑色石阶，薄雾\n道具：断剑：红绳剑柄，斜断口'} onChange={e => { setImportText(e.target.value); setImportPreview(undefined); }} /></Field><Field label="或上传 UTF-8 的 .txt / .md（≤1MB）"><input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; try { if (file.size > 1024 * 1024) throw new Error('清单文件请小于1MB。'); setImportText(await file.text()); setImportPreview(undefined); } catch (error) { toast.error(errorMessage(error)); } }} /></Field><div className="toolbar"><Button variant="secondary" onClick={parseAssetImport}>解析并预览</Button><Button variant="ghost" onClick={() => { setImportOpen(false); setImportPreview(undefined); }}>取消</Button></div>{importPreview && <div className="stack"><p className="small muted">共 {importPreview.assets.length} 项：新增 {importPreview.added}，沿用 {importPreview.reused}。</p><div className="stack">{importPreview.assets.map(asset => <div className="row between" key={asset.id}><span>{kinds.find(k => k.id === asset.kind)?.name}「{asset.name}」</span><StatusChip tone={project.assets.some(old => old.id === asset.id) ? 'neutral' : 'success'}>{project.assets.some(old => old.id === asset.id) ? '沿用' : '新增'}</StatusChip></div>)}</div><Button onClick={saveAssetImport}>确认导入</Button></div>}</div>
    </Modal>
    <Modal open={uploadOpen} onClose={() => { setUploadOpen(false); setUploadPlan(undefined); }} title="按文件名匹配设定图" description="图片文件名需与资产名称一致（不含扩展名），按文件名匹配。先预览再写入。">
      <div className="stack" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); planUpload([...e.dataTransfer.files].filter(file => file.type.startsWith('image/'))); }}><Field label="选择多张图片（可拖入；PNG / JPEG / WebP，≤5MB）"><input type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={e => { planUpload([...(e.target.files || [])]); e.target.value = ''; }} /></Field>{uploadPlan && <div className="stack"><p className="small muted">匹配 {uploadPlan.matched.length} 张，未匹配 {uploadPlan.unmatched.length} 张。</p>{uploadPlan.matched.map(entry => <p key={entry.asset.id}>「{entry.asset.name}」← {entry.file.name}</p>)}{uploadPlan.unmatched.length > 0 && <p className="small muted">未匹配：{uploadPlan.unmatched.map(file => file.name).join('、')}</p>}{uploadPlan.matched.length > 0 && <Button onClick={() => void saveUploads()}>确认导入 {uploadPlan.matched.length} 张</Button>}</div>}</div>
    </Modal>
    <Modal wide open={!!batchPlan} onClose={() => setBatchPlan(undefined)} title="确认批量生成设定图" description="每张图独立提交，单张失败不影响其他。确认后才会调用付费 API。">
      {batchPlan && <div className="stack">
        <p>{batchPlan.assets.length} 张 · {settings.endpoints.find(endpoint => endpoint.id === settings.imageProvider)?.name ?? '未选择端点'} · {modelFor(settings, settings.imageProvider, 'image')}</p>
        <div className="alert">提示词可直接修改，只影响本次请求；模板与资产固定短语不会被改写，一致性请自行核对。</div>
        {batchPlan.assets.map(asset => {
          const source = referenceAssetFor(asset, project.assets);
          return <div key={asset.id}><Field label={`「${asset.name}」· 即将发送的图片提示词`} hint="可直接修改，只影响本次请求；模板与资产固定短语不会被改写。"><textarea rows={8} value={batchPlan.prompts[asset.id] ?? ''} onChange={e => setBatchPlan(previous => previous && { ...previous, prompts: { ...previous.prompts, [asset.id]: e.target.value } })} /></Field><Button variant="ghost" size="sm" onClick={() => setBatchPlan(previous => previous && { ...previous, prompts: { ...previous.prompts, [asset.id]: previous.defaults[asset.id] ?? '' } })}>恢复默认提示词</Button>{source ? <p className="small muted">{source.imageId ? `将附带「${source.name}」的当前设定图作为参考图。` : `参考图来源「${source.name}」还没有设定图：本次按纯文本生成。`}</p> : asset.referenceAssetId ? <p className="small muted">参考图来源资产已删除：本次按纯文本生成。</p> : null}</div>;
        })}
        <div className="toolbar"><Button disabled={batchPlan.assets.some(asset => !batchPlan.prompts[asset.id]?.trim())} onClick={() => { const plan = batchPlan; setBatchPlan(undefined); void executeBatch(plan.assets, plan.prompts); }}>确认并开始生成（{batchPlan.assets.length}）</Button><Button variant="ghost" onClick={() => setBatchPlan(undefined)}>取消</Button></div>
      </div>}
    </Modal>
    <Modal open={!!batch} onClose={() => { if (!batch?.running) setBatch(undefined); }} title="批量生成设定图" description="每张图独立提交，单张失败不影响其他。取消只停止等待，服务商可能已受理并计费。">
      {batch && <div className="stack">
        <ProgressPanel title={`生图并发 ${imageConcurrency(settings)}`} stage={batch.running ? '生成中' : '已结束'} startedAt={batch.startedAt} done={batchDone} total={batch.items.length} failed={batchFailedCount} detail="取消只停止等待，服务商可能已受理并计费。" onCancel={batch.running ? () => batchAbort.current?.abort() : undefined} cancelLabel="全部取消" />
        <div className="stack">{batch.items.map(item => <div className="stack" key={item.id}><div className="row between"><span>{item.name}</span><span className="row"><Elapsed since={item.status === 'running' ? item.startedAt : undefined} /><StatusChip tone={batchTones[item.status]}>{batchLabels[item.status]}</StatusChip></span></div>{item.status === 'failed' && <span className="small muted">{errorMessage(item.error)}</span>}</div>)}</div>
        <div className="toolbar">{!batch.running && batchFailed.length > 0 && <Button variant="secondary" onClick={() => void executeBatch(batchFailed, batch.prompts)}>重试失败项（{batchFailed.length}）</Button>}<Button variant="ghost" disabled={batch.running} onClick={() => setBatch(undefined)}>关闭</Button></div>
      </div>}
    </Modal>
    <Modal open={!!editing} onClose={() => setEditing(undefined)} title={`${editing?.isNew ? '新建' : '编辑'}${kinds.find(k => k.id === editing?.asset.kind)?.name || '资产'}`} description="保存后会使相关下游制作结果标为待更新。固定短语会原样用于后续生成。">
      {editing && <div className="stack"><Field label="名称"><input value={editing.asset.name} onChange={e => draftPatch({ name: e.target.value })} /></Field><Field label="描述"><textarea rows={3} value={editing.asset.description} onChange={e => draftPatch({ description: e.target.value, ...(!editing.asset.lock || editing.asset.lock === editing.asset.description ? { lock: e.target.value } : {}) })} /></Field>
        {editing.asset.kind !== 'voice' && <><Field label="固定短语（默认使用描述）" hint="只在这里维护角色、场景、道具的一致性描述；自定义后不会随描述自动改写。"><textarea rows={3} value={editing.asset.lock} onChange={e => draftPatch({ lock: e.target.value })} /></Field><Button variant="ghost" onClick={() => draftPatch({ lock: editing.asset.description })}>使用当前描述作为固定短语</Button>
          <Field label="参考图来源（也可在表格里拖入图片）" hint="生成时把来源资产当前的设定图作为图生图参考；留空表示纯文本生成。"><select value={referenceAssetFor(editing.asset, project.assets)?.id ?? ''} onChange={e => draftPatch({ referenceAssetId: e.target.value || '' })}><option value="">不挂载（纯文本生成）</option>{project.assets.filter(a => a.id !== editing.asset.id && a.kind !== 'voice' && (a.imageId || a.id === editing.asset.referenceAssetId)).map(a => <option key={a.id} value={a.id}>{a.imageId ? a.name : `${a.name}（尚无设定图）`}</option>)}</select></Field></>}
        {editing.asset.kind === 'character' && <Field label="角色配音音色"><select value={editing.asset.voiceAssetId || ''} onChange={e => draftPatch({ voiceAssetId: e.target.value || undefined })}><option value="">暂不关联</option>{project.assets.filter(a => a.kind === 'voice').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}
        {editing.asset.kind === 'voice' && <><div className="toolbar"><Button variant="secondary" disabled={voicesBusy} onClick={loadVoices}>{voicesBusy ? '获取中…' : '加载在线音色'}</Button></div>{voices.length > 0 && <SearchSelect label="从服务商列表选择" placeholder="请选择，或在下方手动填写" value={editing.asset.voiceId && voices.some(v => v.id === editing.asset.voiceId) ? editing.asset.voiceId : ''} onChange={voiceId => { if (voiceId) draftPatch({ voiceId }); }} options={voices.map(v => ({ value: v.id, label: v.name, hint: v.id }))} />}<Field label="音色ID" hint="保存后可试听并分配给人物；本机试听使用系统声音而非此ID。"><input value={editing.asset.voiceId || ''} onChange={e => draftPatch({ voiceId: e.target.value })} /></Field><Field label="语速（0.5–2）"><input type="number" min={0.5} max={2} step={0.1} value={editing.asset.speed ?? 1} onChange={e => draftPatch({ speed: Number(e.target.value) })} /></Field></>}
        <div className="toolbar"><Button onClick={save}>保存资产</Button><Button variant="ghost" onClick={() => setEditing(undefined)}>取消</Button></div></div>}
    </Modal>
    <Modal open={!!deleting} onClose={() => setDeleting(undefined)} title={`删除「${deleting?.name || ''}」？`} description="会解除镜头资产、参考图、台词说话者和人物音色关联。台词文字保留，但需重新选择人物。此操作不能撤销。"><div className="stack"><p>引用位置：{deleting ? assetUsage(project, deleting.id).join('、') || '未被引用' : ''}</p><div className="toolbar"><Button onClick={() => { if (deleting) updateProject(project.id, p => removeAsset(p, deleting.id), true); setDeleting(undefined); }}>确认删除并解除关联</Button><Button variant="ghost" onClick={() => setDeleting(undefined)}>取消</Button></div></div></Modal>
    <Modal open={!!removingImage} onClose={() => setRemovingImage(undefined)} title="移除图片及引用？" description="保留资产文字设定，但解除所有镜头对此图片的参考附件关联。"><div className="toolbar"><Button onClick={() => { if (removingImage) updateProject(project.id, p => ({ ...p, storyboardReady: false, assets: p.assets.map(a => a.id === removingImage.id ? { ...a, imageId: undefined } : a), shots: p.shots.map(s => ({ ...s, references: s.references.filter(r => r.assetId !== removingImage.id) })) }), true); setRemovingImage(undefined); }}>确认移除图片</Button><Button variant="ghost" onClick={() => setRemovingImage(undefined)}>取消</Button></div></Modal>
    <Modal open={!!pending} onClose={() => { if (!busy) { setPending(undefined); setFailure(undefined); setProgress(undefined); } }} title={pending?.kind === 'image' ? '确认图片生成任务' : '确认试听短句'} description={pending?.kind === 'speech' && pending.local ? '仅使用本机系统声音，不代表MiniMax音色，不会生成或保存可导出音轨。' : '确认后才会请求服务商，可能产生费用。请检查模型、内容与目标资产。'}>
      {pending && <div className="stack"><p>资产：{pending.asset.name}</p>{pending.kind === 'image' ? <><p>服务：{pending.providerName} · {pending.model}。生成后替换当前设定图，原引用会使用新图。</p>{pending.reference ? <div className="reference-preview"><img src={pending.reference} alt={`参考图来源「${pending.referenceName}」的当前设定图`} /><p className="small muted">「{pending.referenceName}」的当前设定图将作为本次生成的参考图发送。</p>{!supportsImageReference(pending.provider, pending.model) && <p className="small">当前渠道不支持参考图：提交会被拒绝，请先换用支持图生图的端点或模型。</p>}</div> : pending.referenceWarning ? <div className="alert" role="alert">{pending.referenceWarning}</div> : null}<Field label="即将发送的完整图片提示词" hint="可直接修改，只影响本次请求；模板与资产固定短语不会被改写。"><textarea rows={12} value={pending.prompt} disabled={busy} onChange={e => setPending(previous => previous && { ...previous, prompt: e.target.value })} /></Field>{pending.prompt !== pending.defaultPrompt && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPending(previous => previous && previous.kind === 'image' ? { ...previous, prompt: previous.defaultPrompt } : previous)}>恢复默认提示词</Button>}</> : <><p>{pending.local ? '本机 speechSynthesis 系统语音' : `MiniMax · ${pending.model} · 音色ID ${pending.asset.voiceId}`}<br />语速：{pending.asset.speed ?? 1}×</p><Field label="试听短句（1–120字）"><textarea rows={3} maxLength={120} value={speechText} disabled={busy} onChange={e => setSpeechText(e.target.value)} /></Field><p className="muted">{speechText.length} / 120 字。试听不创建镜头配音轨。</p></>}{progress && <ProgressPanel title={pending.kind === 'image' ? '生成设定图' : '试听'} stage={progress.stage} startedAt={progress.startedAt} remainingMs={pending.kind === 'image' ? imageRemaining : speechRemaining} detail={pending.kind === 'image' ? '服务商不返回进度，按已用时等待' : '服务商不返回进度'} onCancel={busy ? () => abortRef.current?.abort() : undefined} cancelLabel="取消等待" />}{failure !== undefined && <ErrorNote error={failure} action={errorAction(failure) === 'settings' ? <Button variant="secondary" size="sm" onClick={() => { setPending(undefined); setFailure(undefined); navigate('settings'); }}>去设置</Button> : errorAction(failure) === 'retry' ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void execute()}>重试</Button> : undefined} />}<div className="toolbar"><Button disabled={busy} onClick={execute}>{busy ? '处理中，请勿重复提交…' : pending.kind === 'image' ? '确认发送并生成图片' : pending.local ? '确认本机试听' : '确认付费 API 试听'}</Button>{pending.kind === 'image' && <Button variant="ghost" onClick={() => { setPending(undefined); location.hash = '/settings/templates?kind=image&scope=project'; }}>编辑模板</Button>}<Button variant="ghost" disabled={busy} onClick={() => setPending(undefined)}>取消</Button></div></div>}
    </Modal>
  </div>;
}

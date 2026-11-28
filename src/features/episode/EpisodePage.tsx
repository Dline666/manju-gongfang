import { useEffect, useMemo, useState, Fragment, type DragEvent } from 'react';
import {
  ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Copy, Film, Image as ImageIcon, ImagePlus, Layers, ListChecks, Maximize2,
  MoreHorizontal, Plus, Settings2, Sparkles, Trash2, Upload, Wand2, Mic, X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Asset, Shot } from '../../domain/types';
import { speakerName, uid } from '../../domain/types';
import { episodeLabel, type Episode, type Series } from '../../domain/series';
import { updateEpisode, updateSeries, useStudio } from '../../store/studio';
import { finishJob, startJob, updateJob } from '../../store/jobs';
import { useMediaUrl, useVideo } from '../../store/media';
import { modelOptions } from '../../lib/models';
import { modelFor } from '../../lib/endpoints';
import { fixedDescription } from '../../lib/promptBlocks';
import { imagePrompt } from '../../lib/prompts';
import { validateProject } from '../../domain/validation';
import { Button, Field, Modal, StatusChip, copyText, downloadBlob } from '../../components/Ui';
import StoryboardImportDialog from './StoryboardImportDialog';
import { groupAssets, referenceAssetFor, splitFormName } from './assetForms';
import { taskLabels, useEpisodeGeneration } from './generation';

/** 拖动资产图片时用的私有 MIME 类型：只在本页里认，避免接住从别处拖来的文件。 */
const ASSET_DRAG_TYPE = 'application/x-manju-asset-id';

const assetKindLabel = { character: '人物', scene: '场景', prop: '道具', voice: '音色' } as const;

function assetOf(episode: Episode, id: string) {
  return episode.assets.find(asset => asset.id === id);
}

export default function EpisodePage({ series, episode, navigate }: { series: Series; episode: Episode; navigate: (route: string) => void }) {
  const { settings } = useStudio();
  const generation = useEpisodeGeneration(series, episode);
  const [importing, setImporting] = useState(false);
  const [showDialogue, setShowDialogue] = useState(false);
  const [grid, setGrid] = useState(false);
  const [blocking, setBlocking] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [assetKind, setAssetKind] = useState<'character' | 'scene' | 'prop'>('character');
  const openAssets = (kind: 'character' | 'scene' | 'prop') => { setAssetKind(kind); setAssetsOpen(true); };
  const [modelsOpen, setModelsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string>();

  const issues = useMemo(() => validateProject(episode), [episode]);
  const shots = episode.shots;
  const totalDuration = shots.reduce((total, shot) => total + shot.duration, 0);

  function patchShot(id: string, patch: Partial<Shot>) {
    updateEpisode(series.id, episode.id, current => ({ ...current, shots: current.shots.map(shot => shot.id === id ? { ...shot, ...patch } : shot) }), { only: [id], reason: '本镜的提示词或资产已改动' });
  }
  function addAsset(asset: Asset) {
    updateEpisode(series.id, episode.id, current => ({ ...current, assets: [...current.assets, asset] }));
  }
  function patchAsset(id: string, patch: Partial<Asset>) {
    const related = currentShotIds(episode, id);
    updateEpisode(series.id, episode.id, current => ({ ...current, assets: current.assets.map(asset => asset.id === id ? { ...asset, ...patch } : asset) }), { only: related, reason: '资产设定已改动' });
  }
  function toggleSelect(id: string) {
    setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  if (!shots.length) {
    return <div className="stack episode-page">
      <EpisodeTopBar series={series} episode={episode} navigate={navigate} onImport={() => setImporting(true)} onSettings={() => setSettingsOpen(true)} onDialogue={() => setShowDialogue(true)} />
      <div className="empty episode-empty">
        <div className="empty-symbol">◇</div>
        <h3>这一集还没有分镜</h3>
        <p className="muted">分镜 JSON 是唯一的入口：到聊天室让模型把剧本转成 JSON，再导入到这里。</p>
        <div className="row">
          <Button onClick={() => setImporting(true)}><Upload size={15} /> 导入分镜 JSON</Button>
          <Button variant="outline" onClick={() => navigate('chat')}>去聊天室生成本集 JSON</Button>
        </div>
      </div>
      {importing && <StoryboardImportDialog open onClose={() => setImporting(false)} onImported={() => setImporting(false)} />}
      <SettingsDialog open={settingsOpen} series={series} onClose={() => setSettingsOpen(false)} navigate={navigate} />
      <DialogueDialog open={showDialogue} episode={episode} onClose={() => setShowDialogue(false)} />
    </div>;
  }

  return <div className="stack episode-page">
    <EpisodeTopBar series={series} episode={episode} navigate={navigate}
      onImport={() => setImporting(true)} onSettings={() => setSettingsOpen(true)}
      onDialogue={() => setShowDialogue(true)} onPreview={() => setPreviewOpen(true)}
      grid={grid} onGrid={setGrid} blocking={blocking} onBlocking={setBlocking} />

    <div className="toolbar episode-toolbar">
      <div className="row tight wrap">
        <Button variant="ghost" size="sm" onClick={() => navigate(`library/${series.id}`)}><ArrowLeft size={14} /> 返回作品</Button>
        <Button variant="ghost" size="sm" onClick={() => setStyleOpen(true)}><Wand2 size={14} /> 风格设置</Button>
        <Button variant="ghost" size="sm" onClick={() => setPromptOpen(true)}><ListChecks size={14} /> 提示词设置</Button>
        {/* 三个入口各自落到对应分类：点「场景设置」就该直接看到场景，不该再让人找一次。 */}
        <Button variant="ghost" size="sm" onClick={() => openAssets('character')}><Layers size={14} /> 角色设置</Button>
        <Button variant="ghost" size="sm" onClick={() => openAssets('scene')}><Film size={14} /> 场景设置</Button>
        <Button variant="ghost" size="sm" onClick={() => openAssets('prop')}><Layers size={14} /> 道具设置</Button>
        <Button variant="ghost" size="sm" onClick={() => setImporting(true)}><Upload size={14} /> 导入分镜</Button>
        <Button variant="ghost" size="sm" onClick={() => setModelsOpen(true)}><Settings2 size={14} /> 模型插件</Button>
        <Button variant="ghost" size="sm" onClick={() => setMoreOpen(true)}><MoreHorizontal size={14} /> 更多<ChevronDown size={12} /></Button>
      </div>
      <div className="row tight">
        <Button variant="outline" size="sm" onClick={() => generation.prepare('video', selected.size ? [...selected] : shots.map(shot => shot.id))}>
          <Sparkles size={14} /> 批量生成{selected.size ? `（已选 ${selected.size}）` : '（全本）'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}><Maximize2 size={14} /> 预览视频</Button>
      </div>
    </div>

    {issues.length > 0 && <div className="alert">{issues.slice(0, 3).join('；')}{issues.length > 3 ? `；还有 ${issues.length - 3} 项` : ''}</div>}

    <section className="panel episode-table-panel">
      <table className="shot-table">
        <caption className="sr-only">本集分镜表</caption>
        <thead><tr>
          <th scope="col" className="col-index">序号</th>
          <th scope="col" className="col-dialogue">台词</th>
          <th scope="col" className="col-assets">角色 / 场景 / 道具</th>
          <th scope="col" className="col-prompt">提示词</th>
          <th scope="col" className="col-video">视频</th>
        </tr></thead>
        <tbody>{shots.map(shot => <ShotRow key={shot.id} series={series} episode={episode} shot={shot}
          selected={selected.has(shot.id)} onSelect={() => toggleSelect(shot.id)}
          onPatch={patchShot} generation={generation} settings={settings}
          grid={grid} blocking={blocking}
          active={active === shot.id} onActive={() => setActive(active === shot.id ? undefined : shot.id)} />)}</tbody>
      </table>
      <footer className="episode-table-foot">
        <span className="small muted">共 {shots.length} 镜 · {totalDuration.toFixed(1)} 秒</span>
        <span className="small muted">人物 {episode.assets.filter(asset => asset.kind === 'character').length} · 场景 {episode.assets.filter(asset => asset.kind === 'scene').length} · 道具 {episode.assets.filter(asset => asset.kind === 'prop').length}</span>
      </footer>
    </section>

    <StoryboardImportDialog open={importing} onClose={() => setImporting(false)} onImported={() => setImporting(false)} />
    <DialogueDialog open={showDialogue} episode={episode} onClose={() => setShowDialogue(false)} />
    <StyleDialog open={styleOpen} series={series} onClose={() => setStyleOpen(false)} />
    <PromptSettingsDialog open={promptOpen} onClose={() => setPromptOpen(false)} navigate={navigate} />
    <AssetsDialog open={assetsOpen} episode={episode} initialKind={assetKind} generation={generation} navigate={navigate} series={series} onClose={() => setAssetsOpen(false)} onPatch={patchAsset} onAdd={addAsset} />
    <ModelsDialog open={modelsOpen} onClose={() => setModelsOpen(false)} navigate={navigate} />
    <SettingsDialog open={settingsOpen} series={series} onClose={() => setSettingsOpen(false)} navigate={navigate} />
    <MoreDialog open={moreOpen} onClose={() => setMoreOpen(false)} navigate={navigate} episode={episode} />
    <PreviewDialog open={previewOpen} episode={episode} onClose={() => setPreviewOpen(false)} />
    <BatchConfirm generation={generation} episode={episode} series={series} />
  </div>;
}

function currentShotIds(episode: Episode, assetId: string) {
  return episode.shots
    .filter(shot => shot.assetIds.includes(assetId) || shot.dialogues.some(line => line.speakerId === assetId))
    .map(shot => shot.id);
}

/** 关联镜头给「第N镜」，不给内部 id——id 只在代码里有意义。 */
function currentShotNumbers(episode: Episode, assetId: string) {
  return episode.shots
    .filter(shot => shot.assetIds.includes(assetId) || shot.dialogues.some(line => line.speakerId === assetId))
    .map(shot => `第${shot.number}镜`);
}

function EpisodeTopBar({ series, episode, navigate, onImport, onSettings, onDialogue, grid, onGrid, blocking, onBlocking }: {
  series: Series; episode: Episode; navigate: (route: string) => void;
  onImport: () => void; onSettings: () => void; onDialogue: () => void; onPreview?: () => void;
  grid?: boolean; onGrid?: (value: boolean) => void; blocking?: boolean; onBlocking?: (value: boolean) => void;
}) {
  return <section className="episode-topbar panel">
    <div className="row between wrap">
      <div className="row tight wrap">
        <button className="text-button breadcrumb-series" onClick={() => navigate(`library/${series.id}`)}>{series.name}</button>
        <span className="muted">/</span>
        <strong>{episodeLabel(episode)}</strong>
        <span className="tag subtle">{series.aspect}</span>
        <span className="tag subtle">{series.resolution}</span>
        {episode.legacySpec && <span className="tag warning">旧规格</span>}
      </div>
      <div className="row tight wrap">
        <label className="row small" title="开启后宫格图会按镜号拼一张联系表，供快速通读。">
          <input type="checkbox" checked={grid ?? false} onChange={event => onGrid?.(event.target.checked)} /> 开启宫格图
        </label>
        <label className="row small" title="开启后每镜会显示站位与连续性信息。">
          <input type="checkbox" checked={blocking ?? true} onChange={event => onBlocking?.(event.target.checked)} /> 开启站位图
        </label>
        <Button variant="ghost" size="sm" onClick={onSettings}>系统设置</Button>
        <Button variant="ghost" size="sm" onClick={onDialogue}>查看所有台词</Button>
        <ExportMenu series={series} episode={episode} />
        <Button variant="ghost" size="sm" onClick={() => navigate('settings')}>任务监控</Button>
        <Button variant="ghost" size="sm" onClick={() => navigate('settings')}>界面设置</Button>
        <Button variant="ghost" size="sm" onClick={() => navigate(`library/${series.id}`)}><ArrowLeft size={14} /> 上一步</Button>
      </div>
    </div>
  </section>;
}

/** 导出并入顶栏：成片与素材包都在这里，不再单开一页。
 *  合成是长任务，所以放进任务托盘：进度、取消都在那儿，弹窗关掉也不影响。 */
function ExportMenu({ series, episode }: { series: Series; episode: Episode }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { settings } = useStudio();
  async function run(kind: 'mp4' | 'zip') {
    setBusy(true);
    const controller = new AbortController();
    const jobId = startJob({
      kind: 'export',
      label: kind === 'mp4' ? `合成 ${series.name} ${episodeLabel(episode)} 成片` : `打包 ${episodeLabel(episode)} 素材`,
      // 取消只停止本地合成，不涉及任何计费。
      cancel: () => controller.abort(),
    });
    // 提交后立刻关掉弹窗：进度看任务托盘，页面其余操作不受影响。
    setOpen(false);
    try {
      if (kind === 'mp4') {
        const { renderProject } = await import('../../lib/media/encoder');
        const blob = await renderProject(episode, progress => {
          // 不编造总体百分比：只报当前阶段与第几镜，进度条由托盘按已用时长走。
          updateJob(jobId, {
            detail: progress.shot ? `${progress.message}（${progress.shot}/${episode.shots.length}）` : progress.message,
          });
        }, controller.signal);
        finishJob(jobId, 'done');
        downloadBlob(blob, `${series.name}-${episodeLabel(episode)}.mp4`);
        toast.success('MP4 已生成，请查看下载');
      } else {
        updateJob(jobId, { detail: '正在打包剧本、分镜与素材' });
        const { buildMaterialZip } = await import('../../lib/media/archive');
        const blob = await buildMaterialZip(episode, progress => updateJob(jobId, { detail: progress.message }), controller.signal, settings.promptTemplates);
        finishJob(jobId, 'done');
        downloadBlob(blob, `${series.name}-${episodeLabel(episode)}-素材.zip`);
        toast.success('素材包已生成');
      }
    } catch (error) {
      // 用户自己取消的不算失败，托盘里也不该显示成错误。
      if (controller.signal.aborted) finishJob(jobId, 'canceled');
      else { finishJob(jobId, 'failed'); toast.error(error instanceof Error ? error.message : '导出未完成'); }
    } finally {
      setBusy(false);
    }
  }
  return <>
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)}><Film size={14} /> 导出作品</Button>
    <Modal open={open} onClose={() => setOpen(false)} title="导出这一集" description="导出在当前浏览器本地完成，视频文件不会上传。合成进度在任务托盘里。">
      <div className="stack">
        <p className="small muted">当前 {episode.shots.length} 镜，共 {episode.shots.reduce((total, shot) => total + shot.duration, 0).toFixed(1)} 秒。缺素材的镜头会被跳过或留黑，导出前请先核对。</p>
        <div className="row end">
          <Button variant="secondary" disabled={busy} onClick={() => void run('zip')}>导出素材包（ZIP）</Button>
          <Button disabled={busy} onClick={() => void run('mp4')}>{busy ? '正在导出…' : '导出 MP4'}</Button>
        </div>
      </div>
    </Modal>
  </>;
}

function ShotRow({ series, episode, shot, selected, onSelect, onPatch, generation, settings, grid, blocking, active, onActive }: {
  series: Series; episode: Episode; shot: Shot; selected: boolean; onSelect: () => void;
  onPatch: (id: string, patch: Partial<Shot>) => void;
  generation: ReturnType<typeof useEpisodeGeneration>; settings: ReturnType<typeof useStudio>['settings'];
  grid: boolean; blocking: boolean; active: boolean; onActive: () => void;
}) {
  const video = useVideo(episode.id, shot.id);
  const preview = video?.url ?? shot.video?.url;
  const running = ['submitting', 'queued', 'running'].includes(shot.task?.status ?? '');
  // 存档里记着有视频、本机却取不回来：必须说清楚要人重选，不能装作还在。
  const missingLocalVideo = !!shot.video && !shot.video.url && !video?.url;
  const assets = shot.assetIds.flatMap(id => { const asset = assetOf(episode, id); return asset ? [asset] : []; });

  return <tr className={`shot-row ${selected ? 'is-selected' : ''} ${active ? 'is-active' : ''}`} id={`shot-${shot.number}`}>
    <td className="col-index">
      <div className="stack-tight">
        <label className="row tight"><input type="checkbox" checked={selected} onChange={onSelect} aria-label={`选择第${shot.number}镜`} /><strong className="shot-index">{String(shot.number).padStart(2, '0')}</strong></label>
        <span className="small muted">{shot.duration}s</span>
        {shot.stale && <span className="tag warning" title={shot.staleReason}>待更新</span>}
        {running && <StatusChip tone="running">{taskLabels[shot.task!.status]}</StatusChip>}
      </div>
    </td>

    <td className="col-dialogue">
      <div className="stack-tight dialogue-cell">
        {shot.dialogues.length === 0
          ? <span className="small muted">无台词</span>
          : shot.dialogues.map(line => <div key={line.id} className="dialogue-line">
            <span className="dialogue-speaker">{speakerName(episode, line) || '旁白'}</span>
            <input className="dialogue-text" value={line.text} aria-label={`第${shot.number}镜台词`}
              placeholder="写这一句台词"
              onChange={event => onPatch(shot.id, { dialogues: shot.dialogues.map(item => item.id === line.id ? { ...item, text: event.target.value } : item) })} />
            <button className="icon-button dialogue-delete" aria-label={`删除台词 ${line.text.slice(0, 8)}`} onClick={() => onPatch(shot.id, { dialogues: shot.dialogues.filter(item => item.id !== line.id) })}><Trash2 size={12} /></button>
          </div>)}
        <button className="dialogue-add" onClick={() => onPatch(shot.id, { dialogues: [...shot.dialogues, { id: uid(), speakerId: '', speaker: '', text: '' }] })}>+ 添加台词</button>
      </div>
    </td>

    <td className="col-assets">
      <div className="stack-tight">
        {grid && assets.length > 0 && <div className="row tight asset-mini-grid" aria-label="宫格图">{assets.slice(0, 4).map(asset => <AssetThumb key={asset.id} asset={asset} />)}</div>}
        {assets.length === 0
          ? <span className="small muted">未挂资产</span>
          : assets.map(asset => <div key={asset.id} className="asset-chip-row">
            <AssetThumb asset={asset} />
            <div className="min-w-0">
              <div className="row tight"><strong className="truncate small">{asset.name}</strong><span className="tag subtle">{assetKindLabel[asset.kind]}</span></div>
              <p className="small muted asset-chip-desc">{asset.lock || asset.description || '未填固定描述'}</p>
            </div>
          </div>)}
        <button className="dialogue-add" onClick={onActive}><Plus size={12} /> 贴图</button>
        {blocking && shot.continuity && <details className="blocking-note"><summary>站位 / 连续性</summary><p className="small muted">{shot.continuity}</p></details>}
      </div>
    </td>

    <td className="col-prompt">
      <div className="stack-tight prompt-cell">
        <div className="row between tight">
          <span className="tag subtle">{shot.camera || '未设机位'}</span>
          <button className="icon-button" aria-label={`复制第${shot.number}镜提示词`} onClick={() => void copyText(generation.defaultPrompt(shot, settings.promptTemplates))}><Copy size={13} /></button>
        </div>
        <p className="prompt-text">{shot.visual || '未填画面描述'}</p>
        {shot.action && <p className="small muted prompt-action">动作：{shot.action}</p>}
        <div className="row tight wrap prompt-actions">
          <button className="text-button small" onClick={() => replaceVisual(shot, onPatch)}>替换</button>
          <button className="text-button small" onClick={() => toast('优化指令：按当前风格重写本镜画面描述，原描述会保留。')}>优化指令</button>
          <button className="text-button small" onClick={() => replaceVisual(shot, onPatch, true)}>转 H3</button>
          <select className="prompt-model" aria-label="本镜模型" value={shot.task?.model ?? modelFor(settings, settings.videoProvider, 'video')}
            onChange={event => toast.success(`本镜改用 ${event.target.value}，下次生成时生效`)}>
            {modelOptions(settings, 'seedance', 'video').concat(modelOptions(settings, 'minimax', 'video')).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
          <span className="small muted">{series.aspect} · {shot.duration}s</span>
          <button className="icon-button" aria-label="全屏查看本镜提示词" onClick={() => void copyText(generation.defaultPrompt(shot, settings.promptTemplates))}><Maximize2 size={12} /></button>
        </div>
        <Button size="sm" className="generate-video" disabled={running} onClick={() => generation.prepare('video', [shot.id])}>
          {running ? taskLabels[shot.task!.status] : shot.video ? '重新生成视频' : '生成视频'}
        </Button>
      </div>
    </td>

    <td className="col-video">
      <div className="stack-tight video-cell">
        {preview
          ? <video src={preview} muted preload="metadata" playsInline className="shot-video-thumb"
              onLoadedMetadata={event => { event.currentTarget.currentTime = 0.001; }}
              onError={() => toast.error(`第${shot.number}镜预览不可用，请重新导入。`)} />
          : <div className="video-empty"><Film size={20} strokeWidth={1.3} /><span className="small muted">{missingLocalVideo ? '本地视频未加载，请重新选择文件' : '暂无视频'}</span></div>}
        {/* 终态也必须看得见：提交中断、生成失败都要留在这一格，不能只活在任务托盘里。 */}
        {shot.task && !running && <StatusChip tone={shot.task.status === 'failed' ? 'danger' : shot.task.status === 'unknown' ? 'warning' : 'success'}>{taskLabels[shot.task.status]}</StatusChip>}
        <div className="row tight">
          <label className="text-button small row tight"><Upload size={12} /> 视频
            <input type="file" accept="video/mp4,video/webm,video/quicktime" hidden aria-label={`上传第${shot.number}镜视频`} onChange={event => { const picked = event.target.files?.[0]; event.target.value = ''; if (picked) void generation.uploadVideo(shot, picked); }} />
          </label>
          {/* 配音也要能手动导入：生成失败或已有成片时，这是唯一补救路径。 */}
          <label className="text-button small row tight dialogue-attach"><Mic size={12} /> 配音
            <input type="file" accept="audio/wav,audio/mpeg,audio/mp3,audio/aac,audio/m4a" hidden aria-label={`上传第${shot.number}镜配音`} onChange={event => { const picked = event.target.files?.[0]; event.target.value = ''; if (picked) void generation.uploadAudio(shot, picked); }} />
          </label>
          {shot.task?.status === 'succeeded' && !video && <button className="text-button small" onClick={() => void generation.retrieve(shot)}>取回</button>}
          {shot.video && <button className="text-button small" onClick={() => generation.removeVideo(shot)}>移除</button>}
        </div>
        {shot.audio && <div className="small muted">配音：{shot.audio.name} · {shot.audio.duration.toFixed(1)}s</div>}
        <div className="video-frames small muted">首帧 · 起始帧</div>
      </div>
    </td>
  </tr>;
}

/** 替换 / 转 H3：把本镜画面描述换成用户给的文本。转 H3 同时把模型偏好记在提示里。 */
function replaceVisual(shot: Shot, onPatch: (id: string, patch: Partial<Shot>) => void, h3 = false) {
  const next = window.prompt(h3 ? `把第${shot.number}镜改写为 MiniMax H3 更容易执行的构图` : `替换第${shot.number}镜的画面描述`, shot.visual);
  if (next === null) return;
  const value = next.trim();
  if (!value) return;
  onPatch(shot.id, { visual: value });
  toast.success(h3 ? '已改写为 H3 构图' : '画面描述已替换');
}

function AssetThumb({ asset }: { asset: Asset }) {
  const url = useMediaUrl(asset.imageId);
  return <span className="asset-thumb-mini">{url ? <img src={url} alt={`${asset.name} 设定图`} /> : <span className="muted">{asset.name.slice(0, 1)}</span>}</span>;
}

/** 资产详情里的大图：没有设定图时给一块占位，别让左侧空成白洞。 */
function AssetImage({ asset }: { asset: Asset }) {
  const url = useMediaUrl(asset.imageId);
  return url
    ? <img className="asset-detail-image" src={url} alt={`${asset.name} 设定图`} />
    : <div className="asset-detail-empty"><ImageIcon size={22} /><span className="small muted">还没有设定图</span></div>;
}

/** 表格里的竖版缩略图：64×76 的格子，没有图时给首字占位。 */
function AssetTableThumb({ asset }: { asset: Asset }) {
  const url = useMediaUrl(asset.imageId);
  return url
    ? <img className="compact-media-image" src={url} alt={`${asset.name} 设定图`} />
    : <span className="asset-thumb-empty"><ImageIcon size={16} /><span>{asset.name.slice(0, 1)}</span></span>;
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
  const accepts = (event: DragEvent<HTMLDivElement>) => event.dataTransfer.types.includes(ASSET_DRAG_TYPE);
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
    {url ? <img className="asset-reference-image" src={url} alt={`参考图：${source?.name ?? ''}`} /> : <span className="asset-reference-empty">{missing ? '参考图缺失' : <ImagePlus size={14} />}</span>}
    {hasReference && <button type="button" className="asset-reference-clear" aria-label={`清除${asset.name}的参考图`} onClick={event => { event.stopPropagation(); onClear(); }}><X size={12} /></button>}
  </div>;
}

function DialogueDialog({ open, episode, onClose }: { open: boolean; episode: Episode; onClose: () => void }) {
  const lines = episode.shots.flatMap(shot => shot.dialogues.map(line => ({ shot, line })));
  return <Modal open={open} onClose={onClose} wide title="本集所有台词" description="按镜号列出。改台词请回到分镜表对应那一镜。">
    {lines.length === 0 ? <p className="muted">这一集还没有台词。</p> : <table className="shot-table compact-dialogue-table">
      <thead><tr><th scope="col">镜</th><th scope="col">说话人</th><th scope="col">台词</th></tr></thead>
      <tbody>{lines.map(({ shot, line }) => <tr key={line.id}>
        <td>{shot.number}</td><td>{speakerName(episode, line) || '旁白'}</td><td>{line.text}</td>
      </tr>)}</tbody>
    </table>}
    <div className="row end"><Button variant="secondary" onClick={() => void copyText(lines.map(({ shot, line }) => `第${shot.number}镜 ${speakerName(episode, line) || '旁白'}：${line.text}`).join('\n'))}>复制全部台词</Button></div>
  </Modal>;
}

function StyleDialog({ open, series, onClose }: { open: boolean; series: Series; onClose: () => void }) {
  const [style, setStyle] = useState(series.style ?? '');
  return <Modal open={open} onClose={onClose} title="风格设置" description="风格定义会逐字进入每一镜的提示词，不要写具体剧情。">
    <form className="stack" onSubmit={event => { event.preventDefault(); updateSeries(series.id, { style: style.trim() }); toast.success('风格已保存'); onClose(); }}>
      <Field label="风格定义"><textarea rows={5} value={style} onChange={event => setStyle(event.target.value)} placeholder="例如：东方玄幻水墨，冷青灰调，颗粒质感，克制的光" /></Field>
      <div className="row end"><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit">保存</Button></div>
    </form>
  </Modal>;
}

function PromptSettingsDialog({ open, onClose, navigate }: { open: boolean; onClose: () => void; navigate: (route: string) => void }) {
  return <Modal open={open} onClose={onClose} title="提示词设置" description="提示词模板与 Skill 库都在独立页面里，改完立刻生效。">
    <div className="stack">
      <p className="small muted">每一步的提示词由你自己写的块拼成，系统只固定附带作品数据。Skill 可以开关、编辑与恢复默认。</p>
      <div className="row end"><Button variant="secondary" onClick={onClose}>关闭</Button><Button onClick={() => { onClose(); navigate('settings/templates'); }}>打开提示词模板</Button></div>
    </div>
  </Modal>;
}

function AssetsDialog({ open, episode, onClose, onPatch, onAdd, initialKind, generation, navigate, series }: {
  open: boolean; episode: Episode; onClose: () => void; onPatch: (id: string, patch: Partial<Asset>) => void;
  onAdd: (asset: Asset) => void;
  initialKind: 'character' | 'scene' | 'prop'; generation: ReturnType<typeof useEpisodeGeneration>;
  navigate: (route: string) => void; series: Series;
}) {
  const { settings } = useStudio();
  // 工具栏的「角色/场景/道具设置」要能直接落到对应分类，否则三个按钮长得一模一样。
  // Modal 是常驻挂载的，所以每次打开都要跟一次 initialKind，不能只靠 useState 初值。
  const [kind, setKind] = useState<'character' | 'scene' | 'prop'>(initialKind);
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  // 描述默认折三行；长的固定短语折起来才看得见整张表。
  const [openDesc, setOpenDesc] = useState<Set<string>>(new Set());
  useEffect(() => { if (open) setKind(initialKind); }, [open, initialKind]);
  // 换分类或关窗时回列表：停在上一类的某张图上会让人以为点错了。
  useEffect(() => { setFocusedId(undefined); }, [kind, open]);
  const toggleDesc = (id: string) => setOpenDesc(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const assets = episode.assets.filter(asset => asset.kind !== 'voice' && asset.kind === kind);
  const focused = assets.find(asset => asset.id === focusedId);
  const focusIndex = focused ? assets.indexOf(focused) : -1;
  // 左右键翻页，但输入框里按键不该翻。
  useEffect(() => {
    if (!focused) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === 'ArrowLeft') setFocusedId(assets[(focusIndex - 1 + assets.length) % assets.length]?.id);
      if (event.key === 'ArrowRight') setFocusedId(assets[(focusIndex + 1) % assets.length]?.id);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focused?.id, kind, assets.length]);

  const moveFocus = (step: number) => setFocusedId(assets[(focusIndex + step + assets.length) % assets.length]?.id);

  // 有形态的基础资产默认展开：形态本来就是想看的部分，默认收起等于没做。
  // 只在开窗/换分类时重置，用户手动折叠后不会被下一帧弹开。
  const [expandedForms, setExpandedForms] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!open) return;
    setExpandedForms(new Set(groupAssets(episode.assets.filter(asset => asset.kind === kind)).filter(group => group.forms.length > 0).map(group => group.key)));
  }, [open, kind]);
  const toggleForm = (key: string) => setExpandedForms(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  /** 新增形态：沿用基础形态的描述与固定短语，默认挂它的当前设定图作参考。 */
  const addForm = (base: Asset) => {
    const { base: baseName } = splitFormName(base.name);
    const seed = base.description.trim();
    const prefix = seed ? (/[。！？.!?]$/.test(seed) ? seed : `${seed}。`) : '';
    onAdd({
      id: uid(), kind: base.kind,
      name: `${baseName} · 新形态`,
      description: `${prefix}新形态：保持五官、发型与配色一致，需要变化的部分：`,
      lock: base.lock || seed,
      ...(base.imageId ? { referenceAssetId: base.id } : {}),
    });
    // 刚建好的形态要当场看得见：这一组如果原本是收起的，顺手展开。
    setExpandedForms(previous => new Set(previous).add(base.id));
    toast.success(`已新增「${baseName} · 新形态」，改好名字和描述再生成设定图。`);
  };

  const renderAssetRow = (asset: Asset, role: 'base' | 'form', hasForms: boolean) => {
    const { form } = splitFormName(asset.name);
    const source = referenceAssetFor(asset, assets);
    const isForm = role === 'form';
    const canAddForm = role === 'base';
    return <tr key={asset.id} className={`asset-row ${isForm ? 'is-form' : ''}`.trim()}>
      <td className="asset-form-cell"><div className="asset-form">
        {hasForms
          ? <button type="button" className="form-toggle" aria-expanded={expandedForms.has(asset.id)} aria-label={`${expandedForms.has(asset.id) ? '收起' : '展开'}形态`} onClick={() => toggleForm(asset.id)}><ChevronRight size={14} /></button>
          : <span className="form-toggle-space" />}
        <span className="tag subtle">{form || '基础形态'}</span>
      </div></td>
      <td><div className="asset-name-cell">
        <button type="button" className="text-button asset-name" aria-label={`查看${asset.name}详情`} onClick={() => setFocusedId(asset.id)}>{splitFormName(asset.name).base}</button>
        {asset.lock.trim() ? <span className="tag subtle">已锁定</span> : <span className="tag warning">未锁定</span>}
      </div></td>
      <td><button type="button" className={`text-button form-desc ${openDesc.has(asset.id) ? 'is-open' : ''}`.trim()} aria-expanded={openDesc.has(asset.id)} title={openDesc.has(asset.id) ? '收起描述' : '展开全文'} onClick={() => toggleDesc(asset.id)}>{fixedDescription(asset) || '尚未设置固定描述'}</button></td>
      <td className="asset-cell-muted">{currentShotNumbers(episode, asset.id).join('、') || '未被引用'}</td>
      <td><AssetReference asset={asset} source={source}
        onMount={sourceId => {
          const picked = assets.find(item => item.id === sourceId);
          if (!picked) return;
          if (picked.id === asset.id) { toast.error('不能把这个资产自己的图片作为参考图。'); return; }
          if (!picked.imageId) { toast.error(`「${picked.name}」还没有设定图，不能作为参考图。`); return; }
          onPatch(asset.id, { referenceAssetId: picked.id });
          toast.success(`已把「${picked.name}」的当前设定图挂为「${asset.name}」的参考图。`);
        }}
        onClear={() => { onPatch(asset.id, { referenceAssetId: '' }); toast.success('已清除参考图，之后按纯文本生成。'); }} /></td>
      <td><button type="button" className="asset-table-thumb" aria-label={`查看${asset.name}图片`} draggable={!!asset.imageId}
        onDragStart={event => { if (!asset.imageId) { event.preventDefault(); return; } event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id); event.dataTransfer.effectAllowed = 'copy'; }}
        onClick={() => setFocusedId(asset.id)}><AssetTableThumb asset={asset} /></button></td>
      <td><div className="asset-row-actions">
        <Button variant="ghost" size="sm" aria-label={`生成${asset.name}设定图`} onClick={() => void generation.generateAssetImage(asset.id)}><Sparkles size={14} /></Button>
        {canAddForm && <Button variant="ghost" size="sm" aria-label={`为${splitFormName(asset.name).base}新增形态`} onClick={() => addForm(asset)}><Plus size={14} /></Button>}
      </div></td>
    </tr>;
  };

  return <Modal open={open} onClose={onClose} wide title="角色 / 场景 / 道具设置"
    description="资产按集存放。固定描述会逐字进入提示词，改了要让相关镜头重新生成。">
    <div className="row wrap" role="group" aria-label="资产分类">
      {(Object.keys(assetKindLabel) as Array<keyof typeof assetKindLabel>).filter(value => value !== 'voice').map(value =>
        <button key={value} className={`chip ${kind === value ? 'is-active' : ''}`} onClick={() => setKind(value)}>{assetKindLabel[value]}</button>)}
    </div>
    {assets.length === 0 ? <p className="muted">这一集还没有{assetKindLabel[kind]}资产。导入分镜时会自动建好。</p>
      : !focused ? <div className="asset-table-wrap"><table className="asset-table assets-dialog-table">
        <thead><tr>
          <th scope="col" className="col-form">形态</th><th scope="col">名称</th><th scope="col">固定描述</th>
          <th scope="col">关联镜头</th><th scope="col">参考图</th><th scope="col">图片</th><th scope="col">操作</th>
        </tr></thead>
        <tbody>{groupAssets(assets).map(group => <Fragment key={group.key}>
          {renderAssetRow(group.base, 'base', group.forms.length > 0)}
          {expandedForms.has(group.key) && group.forms.map(form => renderAssetRow(form, 'form', false))}
        </Fragment>)}</tbody>
      </table></div>
        : <div className="stack media-detail">
          <div className="row between">
            <span className="small muted">{focusIndex + 1} / {assets.length} · {assetKindLabel[focused.kind]}</span>
            <div className="row">
              <Button variant="ghost" aria-label="返回列表" onClick={() => setFocusedId(undefined)}><ChevronLeft size={16} />列表</Button>
              <Button variant="ghost" aria-label="上一张" disabled={assets.length < 2} onClick={() => moveFocus(-1)}><ChevronLeft size={16} />上一张</Button>
              <Button variant="ghost" aria-label="下一张" disabled={assets.length < 2} onClick={() => moveFocus(1)}>下一张<ChevronRight size={16} /></Button>
            </div>
          </div>
          <div className="lightbox">
            <div className="lightbox-media"><AssetImage asset={focused} /></div>
            <div className="stack lightbox-info">
              <div><h3>描述</h3><p className="media-detail-text">{focused.description || '尚未填写描述'}</p></div>
              <div className="panel"><h3>固定短语 · 逐字复用</h3><p className="media-detail-text">{fixedDescription(focused) || '尚未设置'}</p></div>
              <Field label="固定描述" hint="逐字复用，不随镜变化。改了要让相关镜头重新生成。">
                <textarea rows={3} value={focused.lock || focused.description} onChange={event => onPatch(focused.id, { lock: event.target.value, description: event.target.value })} />
              </Field>
              {!focused.lock.trim() && <span className="tag warning">未锁定 · 生成视频前必须补上</span>}
              <p className="muted">关联镜头：{currentShotNumbers(episode, focused.id).join('、') || '未被引用'}</p>
              <Field label="完整图片提示词"><textarea rows={6} readOnly value={imagePrompt(episode, focused, settings.promptTemplates)} /></Field>
              <div className="row wrap">
                <Button variant="secondary" size="sm" onClick={() => void copyText(fixedDescription(focused))}><Copy size={14} />复制固定短语</Button>
                <Button variant="secondary" size="sm" onClick={() => void copyText(imagePrompt(episode, focused, settings.promptTemplates))}><Copy size={14} />复制图片提示词</Button>
              </div>
              <Field label="上传设定图（PNG / JPEG / WebP）">
                <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`上传「${focused.name}」设定图`}
                  onChange={event => { const picked = event.target.files?.[0]; event.target.value = ''; if (picked) generation.uploadAssetImage(focused.id, picked); }} />
              </Field>
              <div className="row wrap">
                <Button variant="secondary" size="sm" onClick={() => void generation.generateAssetImage(focused.id)}><Sparkles size={14} />生成设定图</Button>
                <Button variant="secondary" size="sm" onClick={() => { onClose(); navigate(`settings/templates?kind=image&sub=${focused.kind === 'voice' ? 'character' : focused.kind}&scope=project`); }}><Wand2 size={14} />编辑模板</Button>
              </div>
            </div>
          </div>
        </div>}
    {/* 从这里直接进「生图」模板的对应品类段，省掉「设置 → 模板 → 找品类」三跳。 */}
    {!focused && <div className="row end">
      <Button variant="secondary" onClick={() => { onClose(); navigate(`settings/templates?kind=image&sub=${kind}&scope=project`); }}>编辑{assetKindLabel[kind]}模板</Button>
      <Button variant="secondary" onClick={onClose}>关闭</Button>
    </div>}
    {focused && <div className="row end"><Button variant="secondary" onClick={onClose}>关闭</Button></div>}
  </Modal>;
}

function ModelsDialog({ open, onClose, navigate }: { open: boolean; onClose: () => void; navigate: (route: string) => void }) {
  const { settings } = useStudio();
  return <Modal open={open} onClose={onClose} title="模型插件" description="模型与端点配置在设置页统一管理，这里只显示当前生效的一套。">
    <div className="stack small">
      <p>剧本：<strong>{settings.scriptProvider}</strong> · {modelFor(settings, settings.scriptProvider, 'script')}</p>
      <p>生图：<strong>{settings.imageProvider}</strong> · {modelFor(settings, settings.imageProvider, 'image')}</p>
      <p>视频：<strong>{settings.videoProvider}</strong> · {modelFor(settings, settings.videoProvider, 'video')}</p>
      <p>配音：{settings.speechModel}</p>
      <div className="row end"><Button variant="secondary" onClick={onClose}>关闭</Button><Button onClick={() => { onClose(); navigate('settings'); }}>打开模型配置</Button></div>
    </div>
  </Modal>;
}

function SettingsDialog({ open, series, onClose, navigate }: { open: boolean; series: Series; onClose: () => void; navigate: (route: string) => void }) {
  return <Modal open={open} onClose={onClose} title="系统设置" description="画幅与分辨率跟着系列走，避免同一部作品一会儿竖一会儿横。">
    <div className="stack small">
      <p>当前系列画幅 <strong>{series.aspect}</strong>，分辨率 <strong>{series.resolution}</strong>。</p>
      <p className="muted">改这两项要到系列页。改了之后已生成的视频需要重新生成才会套用新画幅。</p>
      <div className="row end"><Button variant="secondary" onClick={onClose}>关闭</Button><Button onClick={() => { onClose(); navigate(`library/${series.id}`); }}>去系列页</Button></div>
    </div>
  </Modal>;
}

function MoreDialog({ open, onClose, navigate, episode }: { open: boolean; onClose: () => void; navigate: (route: string) => void; episode: Episode }) {
  return <Modal open={open} onClose={onClose} title="更多" description="不常用但有用的操作。">
    <div className="stack">
      <Button variant="outline" onClick={() => void copyText(episode.storyboardJson ?? '')} disabled={!episode.storyboardJson}>复制本集分镜原文</Button>
      <Button variant="outline" onClick={() => void copyText(episode.screenplay ?? '')} disabled={!episode.screenplay}>复制本集剧本</Button>
      <Button variant="outline" onClick={() => { onClose(); navigate('chat'); }}>去聊天室</Button>
      <div className="row end"><Button variant="secondary" onClick={onClose}>关闭</Button></div>
    </div>
  </Modal>;
}

function PreviewDialog({ open, episode, onClose }: { open: boolean; episode: Episode; onClose: () => void }) {
  return <Modal open={open} onClose={onClose} wide title="预览本集" description="按镜号顺序播放已导入或已生成的视频。">
    <div className="preview-strip">{episode.shots.map(shot => <ShotPreview key={shot.id} episode={episode} shot={shot} />)}</div>
  </Modal>;
}

function ShotPreview({ episode, shot }: { episode: Episode; shot: Shot }) {
  const video = useVideo(episode.id, shot.id);
  const src = video?.url ?? shot.video?.url;
  return <figure className="preview-item">
    {src ? <video src={src} controls playsInline muted /> : <div className="video-placeholder"><Film size={20} /><span className="small muted">第{shot.number}镜 暂无视频</span></div>}
    <figcaption className="small muted">第{shot.number}镜 · {shot.duration}s</figcaption>
  </figure>;
}

function BatchConfirm({ generation, episode, series }: { generation: ReturnType<typeof useEpisodeGeneration>; episode: Episode; series: Series }) {
  const batch = generation.batch;
  if (!batch) return null;
  return <Modal open onClose={() => generation.setBatch(undefined)} wide title={batch.kind === 'video' ? '确认生成视频' : '确认生成配音'} description="确认后才会调用付费接口。对话框可以关掉，进度在任务托盘里。">
    <div className="stack">
      <p className="small muted">{series.name} · {episodeLabel(episode)} · 模型 {batch.model} · 共 {batch.ids.length} 镜。可直接改本镜提示词，只影响这次请求。</p>
      {batch.ids.slice(0, 3).map(id => {
        const shot = episode.shots.find(item => item.id === id)!;
        return <div key={id} className="stack-tight">
          <strong>第{shot.number}镜 · {shot.duration} 秒</strong>
          {batch.kind === 'video'
            ? <Field label="即将发送的视频提示词"><textarea rows={6} value={batch.prompts[id] ?? ''} onChange={event => generation.updatePrompt(id, event.target.value)} /></Field>
            : <pre>{batch.speech[id].map(line => `${line.voiceId} · ${line.speed}×\n${line.text}`).join('\n\n')}</pre>}
          {batch.kind === 'video' && <Button variant="ghost" size="sm" onClick={() => generation.resetPrompt(id)}>恢复默认提示词</Button>}
        </div>;
      })}
      {batch.ids.length > 3 && <p className="small muted">其余 {batch.ids.length - 3} 镜按各自默认提示词发送。</p>}
      <div className="row end"><Button variant="secondary" onClick={() => generation.setBatch(undefined)}>取消</Button><Button disabled={batch.kind === 'video' && batch.ids.some(id => !batch.prompts[id]?.trim())} onClick={() => void generation.run()}>确认并开始生成</Button></div>
    </div>
  </Modal>;
}
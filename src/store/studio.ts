import { useSyncExternalStore } from 'react';
import { parseSavedStudio } from './schema';
import { migratePromptConfig } from '../lib/promptBlocks';
import { migrateSettings } from '../lib/endpoints';
import { defaultSettings, defaultStyle, uid, type Project, type Settings, type ProviderStatus } from '../domain/types';
import {
  makeSeries, makeEpisode, nextEpisodeNumber, migrateProjectsToSeries, episodeFromProject,
  findEpisode, isAspect, isResolution,
  type Series, type Episode, type Aspect, type Resolution,
} from '../domain/series';

const STORAGE_KEY = 'manju-studio-v1';

/**
 * 旧存档里剧本阶段自动建的占位人物：既没有描述也没有固定短语，或带着「，导入人物，外观待完善」的机器文案。
 * 剧本步骤已经不建人物资产，这些占位在载入时清掉；台词保留说话人名字，等提取或手动创建后再关联。
 */
export function dropPlaceholderCharacters<T extends Project>(project: T): T {
  const placeholder = (asset: Project['assets'][number]) => {
    if (asset.kind !== 'character') return false;
    if (asset.imageId || asset.voiceAssetId) return false;
    const text = `${asset.description} ${asset.lock}`.trim();
    if (!text) return true;
    return /，导入人物，外观待完善$/.test(asset.description.trim()) || /，导入人物，外观待完善$/.test(asset.lock.trim());
  };
  const removed = project.assets.filter(placeholder);
  if (!removed.length) return project;
  const ids = new Map(removed.map(asset => [asset.id, asset.name]));
  return {
    ...project,
    assets: project.assets.filter(asset => !ids.has(asset.id)),
    shots: project.shots.map(shot => ({
      ...shot,
      assetIds: shot.assetIds.filter(id => !ids.has(id)),
      references: shot.references.filter(ref => !ids.has(ref.assetId)),
      dialogues: shot.dialogues.map(line => ids.has(line.speakerId) ? { ...line, speakerId: '', speaker: line.speaker || ids.get(line.speakerId) || '' } : line),
    })),
  };
}

/** 一集载入时的修正：提示词覆盖层迁移到最新版本、挂起中的视频任务改判为结果未知。 */
function hydrateEpisode(episode: Episode): Episode {
  const next: Episode = {
    ...episode,
    promptConfig: migratePromptConfig(episode.promptConfig),
    shots: episode.shots.map(shot => shot.task?.status === 'submitting'
      ? { ...shot, task: { ...shot.task, status: 'unknown' as const, error: '提交时页面已关闭，结果未知；请先检查模型平台，避免重复付费。' } }
      : shot),
  };
  return dropPlaceholderCharacters(next);
}

export interface StudioState {
  version: 2;
  series: Series[];
  /** 当前打开的系列；null 表示停在作品集。 */
  activeSeriesId: string | null;
  /** 当前打开的集；null 表示停在系列页。 */
  activeEpisodeId: string | null;
  settings: Settings;
  keys: Record<string, string>;
  providerStatus: Record<string, ProviderStatus>;
  storageError: string | null;
}

let state: StudioState = {
  version: 2, series: [], activeSeriesId: null, activeEpisodeId: null,
  settings: defaultSettings, keys: {}, providerStatus: {}, storageError: null,
};
let readable = true;
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = parseSavedStudio(JSON.parse(raw));
    const migrated = parsed.version === 2
      ? parsed.data.series.map(series => ({
          ...series,
          episodes: series.episodes.map(hydrateEpisode),
        }))
      // v1 → v2：每个旧作品变成一个只有第 1 集的系列。
      : migrateProjectsToSeries(parsed.data.projects).map(series => ({
          ...series,
          episodes: series.episodes.map(hydrateEpisode),
        }));
    const active = parsed.data;
    state = {
      ...state,
      series: migrated,
      activeSeriesId: 'activeSeriesId' in active ? active.activeSeriesId : null,
      activeEpisodeId: 'activeEpisodeId' in active ? active.activeEpisodeId : null,
      settings: migrateSettings(active.settings),
    };
    // 当前系列/集已经不存在（被删或迁移后 id 变了）就回退到作品集，不留悬空引用。
    if (!state.series.some(series => series.id === state.activeSeriesId)) {
      state = { ...state, activeSeriesId: null, activeEpisodeId: null };
    } else if (!findEpisode(state.series.find(series => series.id === state.activeSeriesId), state.activeEpisodeId)) {
      state = { ...state, activeEpisodeId: null };
    }
    // 迁移成功就立刻把 v2 形状写回去：否则 localStorage 里一直是 v1，
    // 每次刷新都要重新迁移一遍，而中间任何一次读取都可能看到旧结构。
    // 写失败不回滚内存状态——数据已经按 v2 读进来了，只是这轮没存上，
    // 让 emit 照常报「尚未保存」，不能因为回存失败就把刚读出的内容丢掉。
    if (parsed.version === 1) {
      try {
        const { keys: _keys, providerStatus: _providerStatus, storageError: _error, ...saved } = state;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      } catch {
        state = { ...state, storageError: '旧数据已读入，但迁移后的存档没能写回浏览器；当前修改尚未保存。请先导出作品文档。' };
      }
    }
  }
} catch (error) {
  readable = false;
  // 迁移失败不许静默丢数据：原文仍留在 localStorage 里，这里只停止覆盖保存并说明原因。
  const detail = error instanceof Error && error.message ? `（${error.message}）` : '';
  state.storageError = `本地作品数据无法读取，已停止覆盖保存。请先备份浏览器数据，不要清除缓存。${detail}`;
}

const listeners = new Set<() => void>();
function emit(persist = true) {
  if (persist && readable) {
    try {
      const { keys: _keys, providerStatus: _providerStatus, storageError: _error, ...saved } = state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      state = { ...state, storageError: null };
    } catch {
      state = { ...state, storageError: '本地空间不足或浏览器禁止存储，当前修改尚未保存。请先导出作品文档。' };
    }
  }
  listeners.forEach(fn => fn());
}
export const getStudio = () => state;
export function useStudio() {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, getStudio);
}

/** 当前系列；作品集里为 undefined。 */
export function useActiveSeries(): Series | undefined {
  const current = useStudio();
  return current.series.find(series => series.id === current.activeSeriesId);
}
/** 当前集；停在系列页时为 undefined。 */
export function useActiveEpisode(): Episode | undefined {
  const current = useStudio();
  const series = current.series.find(item => item.id === current.activeSeriesId);
  return findEpisode(series, current.activeEpisodeId);
}

function touch(series: Series, patch: Partial<Series> = {}): Series {
  return { ...series, ...patch, updatedAt: new Date().toISOString() };
}
function replaceSeries(seriesList: Series[], next: Series): Series[] {
  return seriesList.map(series => series.id === next.id ? next : series);
}

export function createSeries(name: string, style = defaultStyle): Series {
  const series = makeSeries(name, style);
  state = { ...state, series: [series, ...state.series], activeSeriesId: series.id, activeEpisodeId: null };
  emit();
  return series;
}
export function selectSeries(id: string | null) {
  state = { ...state, activeSeriesId: id, activeEpisodeId: id ? null : null };
  emit();
}
export function selectEpisode(episodeId: string | null) {
  state = { ...state, activeEpisodeId: episodeId };
  emit();
}
export function deleteSeries(id: string) {
  state = {
    ...state,
    series: state.series.filter(series => series.id !== id),
    activeSeriesId: state.activeSeriesId === id ? null : state.activeSeriesId,
    activeEpisodeId: state.activeSeriesId === id ? null : state.activeEpisodeId,
  };
  emit();
}
export function updateSeries(id: string, update: Partial<Series> | ((series: Series) => Series)) {
  state = {
    ...state,
    series: state.series.map(series => {
      if (series.id !== id) return series;
      const next = typeof update === 'function' ? update(series) : { ...series, ...update };
      return touch(next, { id });
    }),
  };
  emit();
}
export function setSeriesAspect(id: string, aspect: Aspect) {
  if (!isAspect(aspect)) return;
  updateSeries(id, { aspect });
}
export function setSeriesResolution(id: string, resolution: Resolution) {
  if (!isResolution(resolution)) return;
  updateSeries(id, { resolution });
}

/** 新增一集：集号自动顺延。返回新集，调用方可立刻跳进去。 */
export function addEpisode(seriesId: string, title = ''): Episode | undefined {
  const series = state.series.find(item => item.id === seriesId);
  if (!series) return undefined;
  const episode = makeEpisode(nextEpisodeNumber(series), title, series.style || defaultStyle);
  updateSeries(seriesId, current => ({ ...current, episodes: [...current.episodes, episode] }));
  return episode;
}
export function deleteEpisode(seriesId: string, episodeId: string) {
  updateSeries(seriesId, current => ({ ...current, episodes: current.episodes.filter(episode => episode.id !== episodeId) }));
  if (state.activeEpisodeId === episodeId) state = { ...state, activeEpisodeId: null };
  emit();
}
export function renameEpisode(seriesId: string, episodeId: string, title: string) {
  updateEpisode(seriesId, episodeId, episode => ({ ...episode, title: title.trim(), name: title.trim() || `第${episode.number}集` }));
}

/**
 * 更新一集。`invalidate` 与旧 updateProject 同义：整体升 revision 或只标记指定镜头待更新。
 */
export function updateEpisode(
  seriesId: string, episodeId: string,
  update: Partial<Episode> | ((episode: Episode) => Episode),
  invalidate: boolean | { only: string[]; reason?: string } = false,
) {
  const only = typeof invalidate === 'object' && invalidate ? new Set(invalidate.only) : undefined;
  const reason = typeof invalidate === 'object' && invalidate ? invalidate.reason : undefined;
  const active = invalidate === true || only !== undefined;
  updateSeries(seriesId, series => ({
    ...series,
    episodes: series.episodes.map(episode => {
      if (episode.id !== episodeId) return episode;
      let next = typeof update === 'function' ? update(episode) : { ...episode, ...update };
      next = { ...next, id: episodeId, updatedAt: new Date().toISOString(), revision: invalidate ? episode.revision + 1 : episode.revision };
      if (active) next.shots = next.shots.map(shot => {
        if (only && !only.has(shot.id)) return shot;
        const stale = !!(shot.video || shot.audio || shot.task);
        return { ...shot, stale, ...(stale && reason ? { staleReason: reason } : {}) };
      });
      return next;
    }),
  }));
}

/** 图片生成回写：只把用到该资产的镜头标为待更新。 */
export function setAssetImage(seriesId: string, episodeId: string, assetId: string, imageId: string) {
  const series = state.series.find(item => item.id === seriesId);
  const episode = findEpisode(series, episodeId);
  if (!series || !episode) return;
  const shotIds = episode.shots
    .filter(shot => shot.assetIds.includes(assetId) || shot.references.some(ref => ref.assetId === assetId) || shot.dialogues.some(line => line.speakerId === assetId))
    .map(shot => shot.id);
  updateEpisode(seriesId, episodeId, current => ({ ...current, assets: current.assets.map(asset => asset.id === assetId ? { ...asset, imageId } : asset) }), { only: shotIds });
}

/** 把一集写成「已导入」：资产与镜头整体替换，旧视频不再保留（新分镜本来就没有视频）。 */
export function applyImportedStoryboard(seriesId: string, episodeId: string, payload: { shots: Episode['shots']; assets: Episode['assets']; storyboardJson: string; title?: string }) {
  updateEpisode(seriesId, episodeId, episode => ({
    ...episode,
    shots: payload.shots,
    assets: payload.assets,
    storyboardJson: payload.storyboardJson,
    storyboardReady: true,
    source: 'import',
    ...(payload.title ? { title: payload.title, name: payload.title } : {}),
  }));
}

export function setSettings(settings: Settings) { state = { ...state, settings }; emit(); }
export function setKey(endpointId: string, key: string) {
  const value = key.trim();
  const providerStatus = { ...state.providerStatus };
  if (state.keys[endpointId] !== value) delete providerStatus[endpointId];
  state = { ...state, keys: { ...state.keys, [endpointId]: value }, providerStatus }; emit(false);
}
export function clearKeys() { state = { ...state, keys: {}, providerStatus: {} }; emit(false); }
export function setProviderStatus(endpointId: string, usedKey: string, result: ProviderStatus) {
  if (!state.keys[endpointId] || state.keys[endpointId] !== usedKey) return;
  state = { ...state, providerStatus: { ...state.providerStatus, [endpointId]: result } }; emit(false);
}

/** 一集的完成度：镜头数、已生成视频、资产锁定情况。 */
export function episodeProgress(episode: Episode) {
  const videos = episode.shots.filter(shot => shot.video && !shot.stale).length;
  return episode.shots.length ? Math.round(20 + (episode.assets.length ? 20 : 0) + (episode.storyboardReady ? 20 : 0) + 40 * videos / episode.shots.length) : 0;
}

/** 测试与迁移用：把一个旧 Project 直接塞成一个系列（不经过 store 的其他副作用）。 */
export { episodeFromProject, replaceSeries };
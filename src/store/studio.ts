import { useSyncExternalStore } from 'react';
import { savedStudioSchema } from './schema';
import { migratePromptConfig } from '../lib/promptBlocks';
import { migrateSettings } from '../lib/endpoints';
import { defaultSettings, defaultStyle, uid, type StudioState, type Project, type Settings, type ProviderStatus } from '../domain/types';

const STORAGE_KEY = 'manju-studio-v1';

/**
 * 旧存档里剧本阶段自动建的占位人物：既没有描述也没有固定短语，或带着「，导入人物，外观待完善」的机器文案。
 * 剧本步骤已经不建人物资产，这些占位在载入时清掉；台词保留说话人名字，等提取或手动创建后再关联。
 */
export function dropPlaceholderCharacters(project: Project): Project {
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

let state: StudioState = { version: 1, projects: [], activeId: null, settings: defaultSettings, keys: {}, providerStatus: {}, storageError: null };
let readable = true;
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const data = savedStudioSchema.parse(JSON.parse(raw));
    data.projects.forEach(p => { p.promptConfig = migratePromptConfig(p.promptConfig); p.shots.forEach(s => { if (s.task?.status === 'submitting') s.task = { ...s.task, status: 'unknown', error: '提交时页面已关闭，结果未知；请先检查模型平台，避免重复付费。' }; }); });
    const projects = data.projects.map(dropPlaceholderCharacters);
    state = { ...state, projects, activeId: data.activeId, settings: migrateSettings(data.settings) };
  }
} catch { readable = false; state.storageError = '本地作品数据无法读取，已停止覆盖保存。请先备份浏览器数据，不要清除缓存。'; }
const listeners = new Set<() => void>();
function emit(persist = true) {
  if (persist && readable) {
    try {
      const { keys: _keys, providerStatus: _providerStatus, storageError: _error, ...saved } = state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      state = { ...state, storageError: null };
    } catch { state = { ...state, storageError: '本地空间不足或浏览器禁止存储，当前修改尚未保存。请先导出作品文档。' }; }
  }
  listeners.forEach(fn => fn());
}
export const getStudio = () => state;
export function useStudio() { return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, getStudio); }
export function createProject(name: string, theme = '') {
  const date = new Date().toISOString();
  const project: Project = { id: uid(), name: name.trim() || '未命名作品', theme, style: defaultStyle, createdAt: date, updatedAt: date, revision: 0, skills: ['script', 'storyboard', 'image', 'video'], shots: [], assets: [], source: 'empty', storyboardReady: false };
  state = { ...state, activeId: project.id, projects: [project, ...state.projects] }; emit(); return project;
}
export function selectProject(id: string) { state = { ...state, activeId: id }; emit(); }
export function updateProject(id: string, update: Partial<Project> | ((project: Project) => Project), invalidate: boolean | { only: string[]; reason?: string } = false) {
  const only = typeof invalidate === 'object' && invalidate ? new Set(invalidate.only) : undefined;
  const reason = typeof invalidate === 'object' && invalidate ? invalidate.reason : undefined;
  const active = invalidate === true || only !== undefined;
  state = { ...state, projects: state.projects.map(project => {
    if (project.id !== id) return project;
    let next = typeof update === 'function' ? update(project) : { ...project, ...update };
    next = { ...next, id, updatedAt: new Date().toISOString(), revision: invalidate ? project.revision + 1 : project.revision };
    if (active) next.shots = next.shots.map(shot => {
      if (only && !only.has(shot.id)) return shot;
      const stale = !!(shot.video || shot.audio || shot.task);
      return { ...shot, stale, ...(stale && reason ? { staleReason: reason } : {}) };
    });
    return next;
  }) }; emit();
}
/** 图片生成回写：只把用到该资产的镜头标为待更新，不再让整部作品 revision 影响其他在途任务。 */
export function setAssetImage(projectId: string, assetId: string, imageId: string) {
  const project = state.projects.find(item => item.id === projectId);
  if (!project) return;
  const shotIds = project.shots.filter(shot => shot.assetIds.includes(assetId) || shot.references.some(ref => ref.assetId === assetId) || shot.dialogues.some(line => line.speakerId === assetId)).map(shot => shot.id);
  updateProject(projectId, current => ({ ...current, assets: current.assets.map(asset => asset.id === assetId ? { ...asset, imageId } : asset) }), { only: shotIds });
}
export function deleteProject(id: string) {
  state = { ...state, projects: state.projects.filter(p => p.id !== id), activeId: state.activeId === id ? null : state.activeId }; emit();
}
export function duplicateProject(id: string) {
  const source = state.projects.find(p => p.id === id); if (!source) return;
  const copy: Project = structuredClone(source); const ids = new Map<string, string>();
  copy.assets.forEach(a => ids.set(a.id, uid()));
  copy.id = uid(); copy.name += ' · 副本'; copy.createdAt = copy.updatedAt = new Date().toISOString();
  copy.assets = copy.assets.map(a => ({ ...a, id: ids.get(a.id)!, voiceAssetId: a.voiceAssetId ? ids.get(a.voiceAssetId) : undefined, referenceAssetId: a.referenceAssetId ? ids.get(a.referenceAssetId) : undefined }));
  copy.shots = copy.shots.map(s => ({ ...s, id: uid(), task: undefined, assetIds: s.assetIds.map(id => ids.get(id)!).filter(Boolean), references: s.references.map(r => ({ ...r, assetId: ids.get(r.assetId)! })), dialogues: s.dialogues.map(d => ({ ...d, id: uid(), speakerId: ids.get(d.speakerId) ?? '' })) }));
  state = { ...state, projects: [copy, ...state.projects] }; emit(); return copy;
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
export function projectProgress(project: Project) {
  const videos = project.shots.filter(s => s.video && !s.stale).length;
  return project.shots.length ? Math.round(20 + (project.assets.length ? 20 : 0) + (project.storyboardReady ? 20 : 0) + 40 * videos / project.shots.length) : 0;
}

import { useSyncExternalStore } from 'react';
import { savedStudioSchema } from './schema';
import { defaultSettings, defaultStyle, uid, type StudioState, type Project, type Settings, type Provider, type ProviderStatus } from '../domain/types';

const STORAGE_KEY = 'manju-studio-v1';
let state: StudioState = { version: 1, projects: [], activeId: null, settings: defaultSettings, keys: {}, providerStatus: {}, storageError: null };
let readable = true;
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const data = savedStudioSchema.parse(JSON.parse(raw));
    data.projects.forEach(p => p.shots.forEach(s => { if (s.task?.status === 'submitting') s.task = { ...s.task, status: 'unknown', error: '提交时页面已关闭，结果未知；请先检查模型平台，避免重复付费。' }; }));
    state = { ...state, projects: data.projects, activeId: data.activeId, settings: { ...defaultSettings, ...data.settings, models: { ...defaultSettings.models, ...data.settings?.models } } };
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
export function updateProject(id: string, update: Partial<Project> | ((project: Project) => Project), invalidate = false) {
  state = { ...state, projects: state.projects.map(project => {
    if (project.id !== id) return project;
    let next = typeof update === 'function' ? update(project) : { ...project, ...update };
    next = { ...next, id, updatedAt: new Date().toISOString(), revision: invalidate ? project.revision + 1 : project.revision };
    if (invalidate) next.shots = next.shots.map(shot => ({ ...shot, stale: !!(shot.video || shot.audio || shot.task) }));
    return next;
  }) }; emit();
}
export function deleteProject(id: string) {
  state = { ...state, projects: state.projects.filter(p => p.id !== id), activeId: state.activeId === id ? null : state.activeId }; emit();
}
export function duplicateProject(id: string) {
  const source = state.projects.find(p => p.id === id); if (!source) return;
  const copy: Project = structuredClone(source); const ids = new Map<string, string>();
  copy.assets.forEach(a => ids.set(a.id, uid()));
  copy.id = uid(); copy.name += ' · 副本'; copy.createdAt = copy.updatedAt = new Date().toISOString();
  copy.assets = copy.assets.map(a => ({ ...a, id: ids.get(a.id)!, voiceAssetId: a.voiceAssetId ? ids.get(a.voiceAssetId) : undefined }));
  copy.shots = copy.shots.map(s => ({ ...s, id: uid(), task: undefined, assetIds: s.assetIds.map(id => ids.get(id)!).filter(Boolean), references: s.references.map(r => ({ ...r, assetId: ids.get(r.assetId)! })), dialogues: s.dialogues.map(d => ({ ...d, id: uid(), speakerId: ids.get(d.speakerId) ?? '' })) }));
  state = { ...state, projects: [copy, ...state.projects] }; emit(); return copy;
}
export function setSettings(settings: Settings) { state = { ...state, settings }; emit(); }
export function setKey(provider: Provider, key: string) {
  const value = key.trim();
  const providerStatus = { ...state.providerStatus };
  if (state.keys[provider] !== value) delete providerStatus[provider];
  state = { ...state, keys: { ...state.keys, [provider]: value }, providerStatus }; emit(false);
}
export function clearKeys() { state = { ...state, keys: {}, providerStatus: {} }; emit(false); }
export function setProviderStatus(provider: Provider, usedKey: string, result: ProviderStatus) {
  if (!state.keys[provider] || state.keys[provider] !== usedKey) return;
  state = { ...state, providerStatus: { ...state.providerStatus, [provider]: result } }; emit(false);
}
export function projectProgress(project: Project) {
  const videos = project.shots.filter(s => s.video && !s.stale).length;
  return project.shots.length ? Math.round(20 + (project.assets.length ? 20 : 0) + (project.storyboardReady ? 20 : 0) + 40 * videos / project.shots.length) : 0;
}

import { useSyncExternalStore } from 'react';

// 内存态任务表：不持久化，刷新即清空。
export type JobKind = 'script' | 'director' | 'assets' | 'image' | 'video' | 'speech' | 'storyboard' | 'export';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled' | 'not_submitted';

export interface Job {
  id: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  errorCode?: string;
  detail?: string;
  cancel?: () => void;
}

export interface JobState {
  jobs: Job[];
  averages: Partial<Record<JobKind, number>>;
}

const HISTORY_LIMIT = 5;
const listeners = new Set<() => void>();
const history = new Map<JobKind, number[]>();
let state: JobState = { jobs: [], averages: {} };
let sequence = 0;

function emit() { listeners.forEach(listener => listener()); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function getJobs() { return state; }
export function useJobs() { return useSyncExternalStore(subscribe, getJobs); }

export function startJob(input: { kind: JobKind; label: string; status?: JobStatus; cancel?: () => void }): string {
  sequence += 1;
  const job: Job = { id: `job-${sequence}`, kind: input.kind, label: input.label, status: input.status ?? 'running', startedAt: Date.now(), cancel: input.cancel };
  state = { ...state, jobs: [...state.jobs, job] };
  emit();
  return job.id;
}

export function updateJob(id: string, patch: Partial<Pick<Job, 'label' | 'status' | 'detail' | 'errorCode' | 'cancel'>>) {
  if (!state.jobs.some(job => job.id === id)) return;
  state = { ...state, jobs: state.jobs.map(job => job.id === id ? { ...job, ...patch } : job) };
  emit();
}

export function finishJob(id: string, status: Exclude<JobStatus, 'queued' | 'running'> = 'done', errorCode?: string) {
  const job = state.jobs.find(item => item.id === id);
  if (!job) return;
  const finishedAt = Date.now();
  recordDuration(job.kind, Math.max(0, finishedAt - job.startedAt));
  state = { ...state, jobs: state.jobs.map(item => item.id === id ? { ...item, status, errorCode, finishedAt, cancel: undefined } : item) };
  emit();
}

export function removeJob(id: string) {
  const job = state.jobs.find(item => item.id === id);
  if (!job) return;
  if ((job.status === 'running' || job.status === 'queued') && job.cancel) job.cancel();
  state = { ...state, jobs: state.jobs.filter(item => item.id !== id) };
  emit();
}

export function clearFinishedJobs() {
  state = { ...state, jobs: state.jobs.filter(job => job.status === 'running' || job.status === 'queued') };
  emit();
}

/** 同类任务最近 5 次的平均耗时（毫秒）；样本不足时返回 undefined。 */
export function averageDuration(kind: JobKind): number | undefined { return state.averages[kind]; }
export function durationSamples(kind: JobKind): number { return history.get(kind)?.length ?? 0; }

function recordDuration(kind: JobKind, milliseconds: number) {
  const samples = [...(history.get(kind) ?? []), milliseconds].slice(-HISTORY_LIMIT);
  history.set(kind, samples);
  const average = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
  state = { ...state, averages: { ...state.averages, [kind]: average } };
}

/** 仅供测试使用：清空任务表与耗时样本。 */
export function resetJobs() {
  history.clear();
  state = { jobs: [], averages: {} };
  emit();
}

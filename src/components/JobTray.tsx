import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useJobs, removeJob, clearFinishedJobs, type Job, type JobStatus } from '../store/jobs';
import { StatusChip, formatElapsed, type StatusTone } from './Ui';

const statusLabels: Record<JobStatus, string> = { queued: '排队中', running: '进行中', done: '已完成', failed: '失败', canceled: '已取消', not_submitted: '未提交' };
const statusTones: Record<JobStatus, StatusTone> = { queued: 'neutral', running: 'running', done: 'success', failed: 'danger', canceled: 'neutral', not_submitted: 'warning' };

function JobRow({ job, now }: { job: Job; now: number }) {
  const active = job.status === 'running' || job.status === 'queued';
  const elapsed = (job.finishedAt ?? now) - job.startedAt;
  return <div className="pointer-events-none flex items-center gap-2 border-t border-[#2b2d31] py-2 text-[12px] first:border-t-0">
    <div className="min-w-0 flex-1"><span className="block truncate">{job.label}</span><span className="muted">{active ? `已用 ${formatElapsed(elapsed)}` : formatElapsed(elapsed)}</span></div>
    <StatusChip tone={statusTones[job.status]}>{statusLabels[job.status]}</StatusChip>
    {active && job.cancel && <button type="button" className="icon-button pointer-events-auto" aria-label={`取消 ${job.label}`} onClick={() => job.cancel?.()}><X size={14} /></button>}
    {!active && <button type="button" className="icon-button pointer-events-auto" aria-label={`移除 ${job.label}`} onClick={() => removeJob(job.id)}><X size={14} /></button>}
  </div>;
}

// 全局任务托盘：右下角，仅在内存中有任务时出现。
export default function JobTray() {
  const { jobs } = useJobs();
  const [now, setNow] = useState(() => Date.now());
  const active = jobs.filter(job => job.status === 'running' || job.status === 'queued');
  const finished = jobs.filter(job => job.status !== 'running' && job.status !== 'queued').slice(-3);
  const visible = [...active, ...finished];
  useEffect(() => {
    if (!active.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active.length]);
  if (!visible.length) return null;
  return <aside className="panel fixed right-6 bottom-6 z-50 flex w-80 max-w-[calc(100vw-32px)] flex-col gap-1 p-4 pointer-events-none" aria-label="任务进度">
    <div className="row between gap-2 pb-1 pointer-events-none"><strong className="text-[12px]">任务</strong>{finished.length > 0 && <button type="button" className="text-button small muted pointer-events-auto" onClick={clearFinishedJobs}>清除已完成</button>}</div>
    {visible.map(job => <JobRow key={job.id} job={job} now={now} />)}
  </aside>;
}

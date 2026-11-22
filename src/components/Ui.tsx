import { useEffect, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { CircleHelp } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '../lib/api';
export { Button };
export function Modal({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode }) {
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}><DialogContent className="studio-dialog"><DialogTitle>{title}</DialogTitle><DialogDescription>{description || '确认后保存，关闭不会提交更改。'}</DialogDescription>{children}</DialogContent></Dialog>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>; }
export function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) { return <div className="empty"><div className="empty-symbol">◇</div><h3>{title}</h3><p className="muted">{text}</p>{children}</div>; }
// 校验问题：带「第N镜：」前缀的项可点击，滚动并高亮对应镜头。
export function IssueList({ issues }: { issues: string[] }) {
  function jump(issue: string) {
    const number = issue.match(/^第(\d+)镜/)?.[1];
    const target = number ? document.getElementById(`shot-${number}`) : null;
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('shot-flash');
    window.setTimeout(() => target.classList.remove('shot-flash'), 1600);
  }
  return <ul className="issue-list">{issues.map((issue, index) => /^第\d+镜/.test(issue) ? <li key={index}><button type="button" className="text-button" onClick={() => jump(issue)}>{issue}</button></li> : <li key={index}>{issue}</li>)}</ul>;
}

// 标题旁的「?」：把说明收进气泡，不占创作区。
export function HelpPopover({ title, children, label = '查看说明' }: { title?: string; children: ReactNode; label?: string }) {
  return <Popover><PopoverTrigger asChild><button type="button" className="icon-button" aria-label={label}><CircleHelp size={16} /></button></PopoverTrigger><PopoverContent align="start" sideOffset={6} className="w-80 text-[12px] leading-relaxed">{title && <h3 className="mb-2 text-[13px] font-semibold">{title}</h3>}<div className="muted">{children}</div></PopoverContent></Popover>;
}

export type StatusTone = 'neutral' | 'running' | 'success' | 'warning' | 'danger';
const statusTones: Record<StatusTone, string> = {
  neutral: '',
  running: 'border-[#286058] bg-[#22cbb810] text-[#6fd8c8]',
  success: 'success',
  warning: 'border-[#6b5430] bg-[#bc9c6314] text-[#d8b26a]',
  danger: 'border-[#7c3a41] bg-[#dc546114] text-[#e88b93]',
};
export function StatusChip({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className={`tag ${statusTones[tone]}`.trim()}>{children}</span>;
}

// 失败提示：message 保持原文，下面补一句只读 hint，右侧放动作按钮。
export function ErrorNote({ error, message, hint, action }: { error?: unknown; message?: string; hint?: string; action?: ReactNode }) {
  const detail = hint ?? (error instanceof ApiError ? error.hint : undefined);
  return <div role="alert" className="alert flex items-start justify-between gap-3 text-[12px]"><div className="min-w-0"><p>{message ?? errorMessage(error)}</p>{detail && <small className="mt-1 block opacity-80">{detail}</small>}</div>{action && <div className="shrink-0">{action}</div>}</div>;
}
// 8c 分级动作：鉴权/权限/模型问题去设置，限流/5xx 可重试，其余不提供按钮。
export function errorAction(error: unknown): 'settings' | 'retry' | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.status === 401 || error.status === 403 || error.status === 404 || ['invalid_key', 'provider_auth_failed', 'provider_forbidden', 'provider_not_found'].includes(error.code)) return 'settings';
  if (error.status === 429 || error.code === 'rate_limited' || error.status >= 500 || error.code === 'upstream_unavailable') return 'retry';
  return undefined;
}

export function formatElapsed(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
}
// 阶段 + 已用时 + 进度 + 取消；total 未知时显示不确定进度条。
export function ProgressPanel({ title, stage, detail, startedAt, done, total, remainingMs, error, onCancel, cancelLabel = '取消等待', active, indeterminate, doneLabel = '已完成', failed }: {
  title?: string; stage?: string; detail?: string; startedAt?: number;
  done?: number; total?: number; remainingMs?: number;
  error?: ReactNode; onCancel?: () => void; cancelLabel?: string; active?: number;
  indeterminate?: boolean; doneLabel?: string; failed?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const elapsed = startedAt === undefined ? undefined : Math.max(0, now - startedAt);
  const counted = typeof total === 'number' && typeof done === 'number';
  const known = !indeterminate && counted && total > 0;
  const percent = known ? Math.min(100, Math.round(((done ?? 0) / (total ?? 1)) * 100)) : 0;
  return <div role="status" className="panel flex flex-col gap-2 text-[12px]">
    <div className="row between gap-3"><div className="min-w-0">{title && <strong className="block text-[13px]">{title}</strong>}{stage && <span className="muted">{stage}</span>}{elapsed !== undefined && <span className="muted"> · 已用 {formatElapsed(elapsed)}</span>}</div>{onCancel && <Button variant="outline" size="sm" onClick={onCancel}>{cancelLabel}</Button>}</div>
    <div className="progress-track"><span className={known ? undefined : 'animate-pulse'} style={{ width: known ? `${percent}%` : '38%' }} /></div>
    <div className="row between gap-3 muted"><span>{counted ? `${doneLabel} ${done} / ${total}${failed ? ` · 失败 ${failed}` : ''}` : detail}</span><span>{remainingMs !== undefined ? `预计剩余 ${formatElapsed(remainingMs)}` : active ? `${active} 项进行中` : ''}</span></div>
    {counted && detail && <span className="muted">{detail}</span>}
    {error}
  </div>;
}
export async function copyText(text: string) { try { await navigator.clipboard.writeText(text); toast.success('已复制，可以直接粘贴使用'); } catch { toast.error('浏览器未允许复制，请选择文本手动复制。'); } }
async function clipboardPng(blob: Blob): Promise<Blob> {
  const image = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('图片无法转换');
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片无法转换')), 'image/png'));
  } finally { image.close(); }
}
export async function copyImage(blob: Blob, name: string) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') { toast.error('当前浏览器不支持复制图片，请下载图片后上传到目标平台。'); return; }
  try {
    const png = clipboardPng(blob); void png.catch(() => {});
    // Keep the clipboard write in the click gesture while image decoding resolves.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast.success(`已复制「${name}」图片，请先粘贴到目标平台，再复制下一张。`);
  } catch { toast.error('图片复制失败或权限被拒绝，请下载图片后上传到目标平台。'); }
}
export function downloadBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name.replace(/[\\/:*?"<>|]/g, '_'); link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 10000); }

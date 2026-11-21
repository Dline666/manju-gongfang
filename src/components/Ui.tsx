import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { toast } from 'sonner';
export { Button } from '@/components/ui/button';
export function Modal({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode }) {
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}><DialogContent className="studio-dialog"><DialogTitle>{title}</DialogTitle><DialogDescription>{description || '确认后保存，关闭不会提交更改。'}</DialogDescription>{children}</DialogContent></Dialog>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>; }
export function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) { return <div className="empty"><div className="empty-symbol">◇</div><h3>{title}</h3><p className="muted">{text}</p>{children}</div>; }
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

import { useEffect, useState } from 'react';
import { Check, ShieldAlert } from 'lucide-react';
import { Button, Modal } from '../../components/Ui';
import DurationStrip from '../script/DurationStrip';
import type { MediaReport } from '../../lib/media/inputs';
import type { Project } from '../../domain/types';
import { buildPreflight } from './preflight';

const audioLabels = { original: '原声', dubbing: '后期配音', silent: '静音' } as const;

export default function PreflightDialog({ open, onClose, onConfirm, project, report, disabled }: {
  open: boolean; onClose: () => void; onConfirm: () => void; project: Project; report?: MediaReport; disabled?: boolean;
}) {
  const [accepted, setAccepted] = useState(false);
  useEffect(() => { if (open) setAccepted(false); }, [open]);
  const preflight = buildPreflight(project, report);
  return <Modal wide open={open} onClose={onClose} title="导出前成片检查" description="红色项会阻止导出；黄色项需要人工确认。导出严格使用已确认的镜头时长，不自动延长对白。">
    <div className="stack">
      <div className="panel"><DurationStrip project={project} /></div>
      {!report ? <p className="muted">正在读取当前会话媒体…</p> : <>
        <section className="panel stack"><div className="section-title"><h3>镜头与素材</h3><span className="tag">{report.shots.filter(item => item.video).length} / {project.shots.length} 镜视频可读</span></div><div className="stack">{report.shots.map(item => <div className="row between small" key={item.shot.id}><span>第 {item.shot.number} 镜 · {item.shot.duration} 秒 · {audioLabels[item.shot.audioMode]}</span><span className="muted">{item.video ? '视频可读' : '缺少视频'}{item.shot.audioMode === 'dubbing' ? (item.audio ? ' · 配音可读' : ' · 缺少配音') : ''}</span></div>)}</div></section>
        {preflight.red.length > 0
          ? <div className="alert stack" role="alert"><div className="row"><ShieldAlert size={16} /><strong>必须处理（{preflight.red.length}）</strong></div><ul>{preflight.red.map(item => <li key={item.message}>{item.message}</li>)}</ul></div>
          : <div className="notice"><Check size={20} /><div><strong>没有阻止导出的问题</strong><p>仍建议逐镜核对时长、音频模式与素材来源。</p></div></div>}
        {preflight.yellow.length > 0 && <details className="alert" open><summary><strong>需要人工确认（{preflight.yellow.length}）</strong></summary><ul>{preflight.yellow.map(item => <li key={item.message}>{item.message}</li>)}</ul></details>}
      </>}
      <details className="panel"><summary><strong>画面与音频处理规则</strong></summary><p className="small muted">长视频只取前 duration 秒，短视频以最后一帧补齐，等比例填黑边。原声随视频截取；替换配音完全移除原声。短音频补静音，超长配音会阻止编码而不是裁剪。</p></details>
      <label className="row"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />我已检查每镜时长和音频模式，并确认以上规则</label>
      <div className="toolbar"><Button disabled={!accepted || !preflight.canExport || disabled} onClick={onConfirm}>确认并开始逐镜编码</Button><Button variant="ghost" onClick={onClose}>取消</Button></div>
    </div>
  </Modal>;
}

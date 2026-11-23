import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy, ArrowUp, ArrowDown, Link2, ChevronRight, ChevronDown } from 'lucide-react';
import { Button, Empty, Field, HelpPopover, IssueList, Modal, copyText } from '../../components/Ui';
import type { Asset, PageProps, Reference, Shot } from '../../domain/types';
import { speakerName } from '../../domain/types';
import { getStudio, updateProject } from '../../store/studio';
import { useMediaUrl } from '../../store/media';
import { assetPromptGroups, assetText, fullAssetText, videoPrompt } from '../../lib/prompts';
import { errorMessage } from '../../lib/api';
import { extractLocalAssets } from '../script/creation';
import { validateProject } from '../../domain/validation';
import { fillStoryboard, updateReference } from './helpers';
import ShotTimeline, { timelineState } from './ShotTimeline';
import TemplateEditor from '../prompts/TemplateEditor';
import DurationStrip from '../script/DurationStrip';

const roleNames = { reference_image: '参考图', first_frame: '首帧', last_frame: '尾帧' };
function Thumbnail({ asset }: { asset: Asset }) {
  const url = useMediaUrl(asset.imageId);
  return url ? <img src={url} alt={asset.name} width={96} height={72} style={{ objectFit: 'contain', borderRadius: 8 }} /> : <span className="muted">{asset.imageId ? '图片不可用或读取中' : '未添加图片'}</span>;
}
export default function StoryboardPage(props: PageProps) { return <StoryboardEditor key={props.project.id} {...props} />; }
function StoryboardEditor({ project, navigate }: PageProps) {
  const [confirmation, setConfirmation] = useState<{ shots: Shot[]; assets: Asset[]; revision: number }>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [attachPreview, setAttachPreview] = useState<{ shotId: string; assetIds: string[] }[]>();
  const [templateOpen, setTemplateOpen] = useState(false);
  const previewMapping = () => {
    const draft = extractLocalAssets(project.shots, project.assets);
    setConfirmation({ ...draft, shots: fillStoryboard(draft.shots), revision: project.revision });
  };
  const [promptShotId, setPromptShotId] = useState<string>();
  const images = project.assets.filter(a => a.kind !== 'voice' && a.imageId);
  const promptShot = project.shots.find(s => s.id === promptShotId);
  const issues = validateProject(project);
  const total = project.shots.reduce((sum, shot) => sum + shot.duration, 0);
  const edit = (id: string, patch: Partial<Shot>) => updateProject(project.id, p => ({ ...p, storyboardReady: false, shots: p.shots.map(s => s.id === id ? { ...s, ...patch } : s) }), true);
  const reference = (shot: Shot, assetId: string, role?: Reference['role']) => {
    try {
      const next = updateReference(project, shot, assetId, role);
      edit(shot.id, { references: next.references, assetIds: next.assetIds });
    } catch (error) { toast.error(errorMessage(error)); }
  };
  const addReference = (shot: Shot, assetId: string) => {
    const isFrames = shot.references.some(r => r.role !== 'reference_image');
    reference(shot, assetId, !isFrames ? 'reference_image' : shot.references.some(r => r.role === 'first_frame') ? 'last_frame' : 'first_frame');
  };
  const moveReference = (shot: Shot, index: number, direction: number) => {
    const list = [...shot.references]; const next = index + direction;
    if (next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    edit(shot.id, { references: list });
  };
  const confirmMapping = () => {
    if (!confirmation) return;
    const current = getStudio().projects.find(p => p.id === project.id);
    if (!current || current.revision !== confirmation.revision) { toast.error('剧本或资产已改变，请重新预览对应关系。'); setConfirmation(undefined); return; }
    updateProject(project.id, { shots: confirmation.shots, assets: confirmation.assets, storyboardReady: true }, true);
    setConfirmation(undefined); toast.success('已确认分镜对应关系，空白开场、动作、终点已补齐。');
  };
  const toggleShot = (id: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allOpen = project.shots.length > 0 && project.shots.every(shot => expanded.has(shot.id));
  const toggleAll = () => setExpanded(allOpen ? new Set() : new Set(project.shots.map(shot => shot.id)));
  const locate = (shotId: string) => {
    const shot = project.shots.find(item => item.id === shotId);
    if (!shot) return;
    setExpanded(previous => new Set(previous).add(shotId));
    requestAnimationFrame(() => document.getElementById(`shot-${shot.number}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  const copyAllVideoPrompts = () => {
    const text = project.shots.map(shot => `====第${shot.number}镜====\n${videoPrompt(project, shot)}`).join('\n\n');
    void copyText(text);
  };
  const prepareAutoAttach = () => {
    const additions: { shotId: string; assetIds: string[] }[] = [];
    for (const shot of project.shots) {
      if (shot.references.some(ref => ref.role !== 'reference_image')) continue;
      const referenced = new Set(shot.references.map(ref => ref.assetId));
      const ids = [...new Set([...shot.assetIds, ...shot.dialogues.map(line => line.speakerId)])].filter(id => !referenced.has(id) && project.assets.some(asset => asset.id === id && asset.kind !== 'voice' && asset.imageId));
      if (ids.length) additions.push({ shotId: shot.id, assetIds: ids });
    }
    if (!additions.length) { toast('没有可自动挂载的参考图。'); return; }
    setAttachPreview(additions);
  };
  const confirmAutoAttach = () => {
    if (!attachPreview) return;
    const map = new Map(attachPreview.map(entry => [entry.shotId, entry.assetIds]));
    updateProject(project.id, p => ({ ...p, storyboardReady: false, shots: p.shots.map(shot => {
      const ids = map.get(shot.id);
      if (!ids) return shot;
      let next = shot;
      for (const assetId of ids) {
        try { const result = updateReference(p, next, assetId, 'reference_image'); next = { ...next, references: result.references, assetIds: result.assetIds }; }
        catch { /* 跳过不兼容的组合 */ }
      }
      return next;
    }) }), true);
    setAttachPreview(undefined);
    toast.success('已按镜头资产自动挂载参考图，请核对图序。');
  };
  return <div className="stack">
    <header className="page-heading"><div><span className="tag">04 / 分镜编排</span><h1>把文字，放进镜头里</h1><p className="muted">直接沿用已有镜头，不生成额外剧情。逐镜确认开场、动作、终点与参考图片。</p></div><Button disabled={!project.shots.length} onClick={previewMapping}><Check size={16} />{project.storyboardReady ? '重新确认对应关系' : '预览并确认对应关系'}</Button></header>
    <div className="workbench"><div className="workbench-main stack">
    <div className="panel"><div className="section-title"><h2>{project.shots.length} 镜 / {Number(total.toFixed(2))} 秒</h2><div className="row"><HelpPopover title="对应关系怎么确认"><p>只补空白字段：后一镜开场承接上一镜终点；已有文字保持不变。以下分镜与剧本一一对应，修改会同步回剧本并标记下游待更新。不进行额外自动衔接检查。</p><p className="mt-2">「固定资产」是文字设定，「实际图片附件」才会进入图片列表。参考图模式和首尾帧模式不能混用；尾帧需要首帧。图片编号就是提交附件顺序。</p></HelpPopover><span className="tag">{project.storyboardReady ? '对应关系已确认' : '对应关系待确认'}</span></div></div><DurationStrip project={project} /></div>
    {project.shots.length > 0 && <div className="panel stack"><ShotTimeline project={project} onLocate={locate} /><div className="toolbar"><Button variant="outline" onClick={toggleAll}>{allOpen ? '全部折叠' : '全部展开'}</Button><Button variant="outline" onClick={copyAllVideoPrompts}>复制全部视频提示词</Button><Button variant="secondary" onClick={prepareAutoAttach}>按镜头资产自动挂参考图</Button></div></div>}
    {!project.shots.length && <Empty title="先让故事有镜头" text="请在剧本页生成、导入或手动创建镜头，再确认分镜对应关系。"><Button onClick={() => navigate('script')}>前往剧本页</Button></Empty>}
    {project.shots.map(shot => { const open = expanded.has(shot.id); return <article className="shot-card shot-collapsed stack" key={shot.id} id={`shot-${shot.number}`}>
      <div className="section-title"><button type="button" className="text-button shot-summary" aria-expanded={open} onClick={() => toggleShot(shot.id)}><span className="shot-number">{String(shot.number).padStart(2, '0')}</span><h2>第 {shot.number} 镜</h2><span className="tag">{shot.duration} 秒</span><span className="tag">{shot.camera || '未设置运镜'}</span>{shot.stale && <span className="tag danger" title={shot.staleReason}>{shot.staleReason || '待更新'}</span>}<span className="muted small truncate">{shot.action || '待补充动作'}</span></button><div className="row"><span className={`timeline-dot is-${timelineState(shot)}`} title={shot.stale ? '待更新' : shot.video ? '已完成' : shot.task?.status === 'failed' ? '失败' : '缺失'} /><Button variant="outline" onClick={() => setPromptShotId(shot.id)}><Copy size={16} />视频提示词</Button><button type="button" className="icon-button" aria-label={open ? `折叠第${shot.number}镜` : `展开第${shot.number}镜`} onClick={() => toggleShot(shot.id)}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button></div></div>
      {open && <div className="stack">
      <Field label="画面"><textarea rows={3} value={shot.visual} onChange={e => edit(shot.id, { visual: e.target.value })} /></Field>
      <div className="grid-3"><Field label="开场 / 起点"><textarea rows={3} value={shot.start} placeholder="为空时，确认对应关系将参考上一镜终点补齐" onChange={e => edit(shot.id, { start: e.target.value })} /></Field><Field label="动作"><textarea rows={3} value={shot.action} onChange={e => edit(shot.id, { action: e.target.value })} /></Field><Field label="终点"><textarea rows={3} value={shot.end} onChange={e => edit(shot.id, { end: e.target.value })} /></Field></div>
      <div className="grid-2"><Field label="运镜"><input value={shot.camera} onChange={e => edit(shot.id, { camera: e.target.value })} /></Field><div className="field"><span>台词与声音</span><div>{shot.dialogues.length ? shot.dialogues.map(d => <p key={d.id}><strong>{speakerName(project, d) || '未指定人物'}：</strong>{d.text}</p>) : <p className="muted">无对白</p>}<small className="muted">{shot.audioMode === 'original' ? '原声模式' : shot.audioMode === 'dubbing' ? '后期配音模式' : '静音模式'} · {shot.audio ? '已关联配音轨' : '未关联外部配音轨'}</small><Button variant="ghost" onClick={() => navigate('script')}>编辑时长和台词</Button></div></div></div>
      <div className="grid-2"><section className="panel stack"><div className="section-title"><h3>固定资产 · 文字设定</h3><HelpPopover title="固定资产说明">台词人物和已挂图片的资产也会自动进入固定资产块；音色ID由配音流程使用。</HelpPopover></div>{!project.assets.length && <p className="muted">还没有资产，请先到资产页创建。</p>}{project.assets.map(asset => <label className="row" key={asset.id}><input type="checkbox" checked={shot.assetIds.includes(asset.id)} onChange={e => {
        if (!e.target.checked && shot.references.some(r => r.assetId === asset.id)) { toast.error('请先取消该资产的实际图片附件，再解除文字关联。'); return; }
        edit(shot.id, { assetIds: e.target.checked ? [...new Set([...shot.assetIds, asset.id])] : shot.assetIds.filter(id => id !== asset.id) });
      }} /><span>{asset.name} <small className="muted">{asset.kind === 'character' ? '人物' : asset.kind === 'scene' ? '场景' : asset.kind === 'prop' ? '道具' : '音色'}</small></span></label>)}<div className="stack">{assetPromptGroups(project, shot).map(group => <section key={group.kind} className={group.missing ? 'alert' : 'panel'}><h4>{group.label}{group.missing ? ' · 缺失待补充' : ''}</h4><pre>{group.text}</pre><Button variant="outline" onClick={() => void copyText(group.text)}>复制{group.label}</Button></section>)}</div><div className="toolbar"><Button variant="outline" onClick={() => void copyText(fullAssetText(project, shot))}>复制完整资产</Button><Button variant="ghost" onClick={() => navigate('assets')}>管理资产</Button></div></section>
      <section className="panel stack"><div className="section-title"><h3><Link2 size={16} /> 实际图片附件</h3><HelpPopover title="挂图规则">要切换首尾帧模式，请先移除其他参考图，再将保留图片的角色改为「首帧」。后续勾选图片默认作为尾帧。</HelpPopover></div>{!images.length && <p className="muted">没有真实图片可挂载。请先到资产页上传或生成设定图。</p>}{images.map(asset => <label className="row" key={asset.id}><input type="checkbox" checked={shot.references.some(r => r.assetId === asset.id)} onChange={e => e.target.checked ? addReference(shot, asset.id) : reference(shot, asset.id)} /><Thumbnail asset={asset} /><span>{asset.name}</span></label>)}</section></div>
      {shot.references.length > 0 && <section className="stack"><h3>提交图序</h3>{shot.references.map((ref, index) => {
        const asset = project.assets.find(a => a.id === ref.assetId);
        return <div className="panel row" key={ref.assetId}><span className="tag">图 {index + 1}</span>{asset && <Thumbnail asset={asset} />}<strong>{asset?.name || '已失效资产'}</strong><Field label={`图${index + 1}角色`}><select value={ref.role} onChange={e => reference(shot, ref.assetId, e.target.value as Reference['role'])}>{Object.entries(roleNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field><Button variant="ghost" disabled={index === 0} aria-label={`图${index + 1}上移`} onClick={() => moveReference(shot, index, -1)}><ArrowUp size={16} /></Button><Button variant="ghost" disabled={index === shot.references.length - 1} aria-label={`图${index + 1}下移`} onClick={() => moveReference(shot, index, 1)}><ArrowDown size={16} /></Button><Button variant="ghost" onClick={() => reference(shot, ref.assetId)}>取消挂图</Button></div>;
      })}</section>}
      <p className="muted">视频状态：{shot.stale ? '上游已变更，需要重新审核' : shot.video ? `已关联「${shot.video.name}」` : '尚未制作（不属于剧本校验错误）'}{shot.task ? ` · 任务：${shot.task.status}` : ''}</p>
      </div>}
    </article>; })}
    </div><aside className="workbench-aside" aria-label="分镜状态">
      <section className="panel stack"><div className="section-title"><h3>当前状态</h3><span className="tag">{project.storyboardReady ? '已确认' : '待确认'}</span></div><p className="small muted">{project.shots.length} 镜 · {Number(total.toFixed(2))} 秒</p><p className="small muted">{project.assets.length} 项资产 · {images.length} 张可挂图片</p></section>
      {issues.length > 0 && <section className="panel stack"><div className="section-title"><h3>需要完善</h3><span className="tag">{issues.length} 项</span></div><IssueList issues={issues} /></section>}
      <section className="panel stack"><Button disabled={!project.storyboardReady} onClick={() => navigate('generation')}>下一步：视频生成</Button>{!project.storyboardReady && <p className="small muted">请先预览并确认当前对应关系。</p>}<Button variant="outline" onClick={() => navigate('assets')}>返回资产设定</Button></section>
    </aside></div>
    <Modal open={!!attachPreview} onClose={() => setAttachPreview(undefined)} title="按镜头资产自动挂参考图" description="默认使用「参考图」模式；已有首尾帧的镜头不会改动。先预览再写入。"><div className="stack"><p>将为 {attachPreview?.length || 0} 个镜头挂载 {attachPreview?.reduce((sum, entry) => sum + entry.assetIds.length, 0) || 0} 张参考图。</p>{attachPreview?.map(entry => { const shot = project.shots.find(item => item.id === entry.shotId); return <p key={entry.shotId}>第{shot?.number ?? '?'}镜：{entry.assetIds.map(id => project.assets.find(asset => asset.id === id)?.name).join('、')}</p>; })}<div className="toolbar"><Button onClick={confirmAutoAttach}>确认挂载</Button><Button variant="ghost" onClick={() => setAttachPreview(undefined)}>取消</Button></div></div></Modal>
    <Modal open={!!confirmation} onClose={() => setConfirmation(undefined)} title="确认剧本与分镜对应关系" description="先审核三类资产和逐镜关联，保存到资产库并补空白开场、动作与终点；保留镜头ID、时长、台词、原固定短语和素材关联。">
      {confirmation && <div className="stack"><p>剧本 {confirmation.shots.length} 镜 → 分镜 {confirmation.shots.length} 镜，一一对应。请逐项审核下面的实际保存内容。</p><div className="panel"><h3>待保存资产清单</h3>{confirmation.assets.filter(a => a.kind !== 'voice').map(a => <p key={a.id}>{a.kind === 'character' ? '人物' : a.kind === 'scene' ? '场景' : '道具'}「{a.name}」：{a.lock || a.description}{project.assets.some(old => old.id === a.id) ? '（沿用）' : '（新增）'}</p>)}</div>{confirmation.shots.map(s => <details className="panel" key={s.id}><summary>剧本第{s.number}镜 → 分镜第{s.number}镜 · {s.duration}秒</summary><p>画面：{s.visual}</p><p>开场：{s.start}</p><p>动作：{s.action}</p><p>终点：{s.end}</p><p>运镜：{s.camera}</p><pre>{assetText({ ...project, assets: confirmation.assets }, s)}</pre></details>)}<div className="toolbar"><Button onClick={confirmMapping}>确认对应并保存补全</Button><Button variant="ghost" onClick={() => setConfirmation(undefined)}>取消</Button></div></div>}
    </Modal>
    <Modal open={!!promptShot} onClose={() => setPromptShotId(undefined)} title={`第${promptShot?.number || ''}镜 · 完整视频提示词`} description="有图时侧重动作、对白和运镜；无图时明确开场。文字复制不会自动上传图片，实际附件在生成页提交。">{promptShot && <div className="stack"><textarea rows={16} readOnly aria-label="视频提示词全文" value={videoPrompt(project, promptShot)} /><div className="toolbar"><Button onClick={() => void copyText(videoPrompt(project, promptShot))}>复制提示词</Button><Button variant="ghost" onClick={() => setPromptShotId(undefined)}>关闭</Button></div></div>}</Modal>
    <TemplateEditor project={project} open={templateOpen} onClose={() => setTemplateOpen(false)} initialKind="assets" />
  </div>;
}

import { useEffect, useMemo, useState } from 'react';
import { Lock, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button, ErrorNote, Field } from '../../components/Ui';
import { PROMPT_LIMITS, promptBlock, renderPrompt, validatePromptSpec } from '../../lib/promptSpec';
import {
  blockTextFor, defaultBlockText, defaultStyleSpec, findTemplateBlock, findUnknownVariables,
  promptVariables, templateFor, templates, type TemplateId,
} from '../../lib/promptTemplates';
import { directorSpec, extractSpec, imageSpec, scriptSpec, videoSpec } from '../../lib/prompts';
import { updateProject } from '../../store/studio';
import { makeShot, type Asset, type Project, type StyleSpec } from '../../domain/types';

const styleLabels: Record<'medium' | 'line' | 'palette' | 'face' | 'light', string> = {
  medium: '介质', line: '线条', palette: '配色', face: '面部渲染', light: '光线',
};

function cleanStyle(style: StyleSpec): StyleSpec {
  const result: StyleSpec = {};
  for (const key of ['medium', 'line', 'palette', 'face', 'light'] as const) {
    const value = style[key]?.trim();
    if (value) result[key] = value;
  }
  const forbidden = (style.forbidden ?? []).map(item => item.trim()).filter(Boolean);
  if (forbidden.length) result.forbidden = forbidden;
  return result;
}

function buildConfig(blocks: Record<string, string>, style: StyleSpec, baseStyle: StyleSpec): Project['promptConfig'] {
  const overrides: Record<string, string> = {};
  for (const [id, text] of Object.entries(blocks)) {
    const found = findTemplateBlock(id);
    if (!found || found.block.locked) continue;
    if (text === defaultBlockText(found.block, style)) continue;
    overrides[id] = text;
  }
  const cleaned = cleanStyle(style);
  const base = cleanStyle(baseStyle);
  const styleChanged = JSON.stringify(cleaned) !== JSON.stringify(base);
  if (!Object.keys(overrides).length && !styleChanged) return undefined;
  return { v: 1, ...(styleChanged ? { style: cleaned } : {}), ...(Object.keys(overrides).length ? { blocks: overrides } : {}) };
}

export default function TemplateEditor({ project, open, onClose, initialKind = 'script', onSaved }: {
  project: Project; open: boolean; onClose: () => void; initialKind?: TemplateId; onSaved?: (styleChanged: boolean) => void;
}) {
  const [kind, setKind] = useState<TemplateId>(initialKind);
  const [blocks, setBlocks] = useState<Record<string, string>>({});
  const [style, setStyle] = useState<StyleSpec>({});
  const [tab, setTab] = useState<'blocks' | 'style'>('blocks');

  useEffect(() => {
    if (!open) return;
    const initialStyle = cleanStyle(project.promptConfig?.style ?? defaultStyleSpec(project.style));
    const next: Record<string, string> = {};
    for (const template of templates) for (const def of template.blocks) if (!def.locked) next[def.id] = project.promptConfig?.blocks?.[def.id] ?? defaultBlockText(def, initialStyle);
    setKind(initialKind);
    setStyle(initialStyle);
    setBlocks(next);
    setTab('blocks');
  }, [open, project.id, initialKind]);

  const styleValue = useMemo(() => cleanStyle(style), [style]);
  const draftProject = useMemo<Project>(() => ({ ...project, promptConfig: buildConfig(blocks, style, defaultStyleSpec(project.style)) }), [project, blocks, style]);
  const vars = useMemo(() => promptVariables(draftProject, styleValue), [draftProject, styleValue]);
  const previewAsset = useMemo<Asset>(() => project.assets.find(asset => asset.kind !== 'voice') ?? {
    id: 'preview-asset', kind: 'character', name: '示例人物', description: '示例描述', lock: '示例固定短语：灰白旧衣，背空剑鞘', imageId: 'preview-image',
  }, [project.assets]);
  const previewShot = useMemo(() => project.shots[0] ?? { ...makeShot(1), visual: '示例画面：人物走上石阶', start: '示例开场', action: '示例动作', end: '示例终点' }, [project.shots]);
  const template = templateFor(kind);
  const previewSpec = useMemo(() => {
    if (kind === 'script') return scriptSpec(draftProject);
    if (kind === 'assets') return extractSpec(draftProject);
    if (kind === 'director') return directorSpec(draftProject);
    if (kind === 'image') return imageSpec(draftProject, previewAsset);
    return videoSpec(draftProject, previewShot);
  }, [kind, draftProject, previewAsset, previewShot]);
  const preview = renderPrompt(previewSpec);
  const limit = PROMPT_LIMITS[previewSpec.kind];
  const warningAt = kind === 'video' ? 6000 : Math.floor(limit * 0.9);
  const parseIssues = validatePromptSpec(previewSpec);
  const unknown = template.blocks.flatMap(def => def.locked ? [] : findUnknownVariables(blocks[def.id] ?? '').map(variable => `「${def.label}」使用了未知变量 {{${variable}}}`));
  const overLimit = preview.length > limit;
  const styleChanged = JSON.stringify(styleValue) !== JSON.stringify(cleanStyle(project.promptConfig?.style ?? defaultStyleSpec(project.style)));

  const updateStyle = (next: StyleSpec) => {
    setBlocks(previous => {
      const updated = { ...previous };
      for (const [id, text] of Object.entries(previous)) {
        const found = findTemplateBlock(id);
        if (!found) continue;
        if (text === defaultBlockText(found.block, style)) updated[id] = defaultBlockText(found.block, next);
      }
      return updated;
    });
    setStyle(next);
  };
  const resetAll = () => {
    setStyle(defaultStyleSpec(project.style));
    const next: Record<string, string> = {};
    for (const item of templates) for (const def of item.blocks) if (!def.locked) next[def.id] = defaultBlockText(def, defaultStyleSpec(project.style));
    setBlocks(next);
  };
  const save = () => {
    if (unknown.length || overLimit) return;
    updateProject(project.id, { promptConfig: draftProject.promptConfig }, false);
    toast.success('提示词模板已保存，对下一次生成生效。');
    onSaved?.(styleChanged);
    onClose();
  };

  return <Sheet open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <SheetContent side="right" className="w-full overflow-y-auto p-6 sm:max-w-6xl">
      <SheetHeader className="p-0"><SheetTitle>提示词模板</SheetTitle><SheetDescription>锁定块不可编辑；保存后对下一次生成立即生效，不改动已生成素材。留空可移除某一规则块。</SheetDescription></SheetHeader>
      <div className="template-editor">
        <nav className="template-tabs" aria-label="模板选择">{templates.map(item => <button key={item.id} type="button" className={kind === item.id ? 'active' : ''} onClick={() => setKind(item.id)}><strong>{item.title}</strong><small>{item.description}</small></button>)}</nav>
        <div className="template-body stack">
          <div className="toolbar"><div className="tabs-row"><button className={tab === 'blocks' ? 'active' : ''} onClick={() => setTab('blocks')}>模板块</button><button className={tab === 'style' ? 'active' : ''} onClick={() => setTab('style')}>风格设定</button></div><Button variant="ghost" onClick={resetAll}><RotateCcw size={14} />恢复全部默认</Button></div>
          {tab === 'style' && <section className="panel stack"><div className="section-title"><h3>StyleSpec · {project.style}</h3><span className="small muted">风格行仍保留在提示词第一段</span></div><div className="grid-2">{(['medium', 'line', 'palette', 'face', 'light'] as const).map(key => <Field key={key} label={styleLabels[key]}><textarea rows={2} value={style[key] ?? ''} onChange={event => updateStyle({ ...style, [key]: event.target.value })} /></Field>)}</div><Field label="禁写清单（每行一条）"><textarea rows={3} value={(style.forbidden ?? []).join('\n')} onChange={event => updateStyle({ ...style, forbidden: event.target.value.split('\n') })} /></Field></section>}
          {tab === 'blocks' && <section className="stack"><div><h3>{template.title}模板</h3><p className="small muted">{template.description}</p></div>{template.blocks.map(def => {
            const lockedText = promptBlock(previewSpec, def.id)?.text ?? blockTextFor(draftProject, def, vars, style);
            if (def.locked) return <section className="panel stack template-block locked" key={def.id}><div className="section-title"><h4><Lock size={14} />{def.label}</h4><span className="tag">锁定</span></div><p className="small muted">{def.reason}</p><textarea readOnly rows={4} value={lockedText} /></section>;
            const value = blocks[def.id] ?? defaultBlockText(def, style);
            const bad = findUnknownVariables(value);
            return <Field key={def.id} label={`${def.label}（${value.length} 字）`} hint="支持变量：{{project.theme}}、{{project.style}}、{{style.medium}} 等；未知变量会阻止保存。">
              <textarea rows={4} value={value} onChange={event => setBlocks(previous => ({ ...previous, [def.id]: event.target.value }))} />
              {bad.length > 0 && <small className="text-[#e88b93]">未知变量：{bad.map(item => `{{${item}}}`).join('、')}</small>}
              <Button variant="ghost" size="sm" onClick={() => setBlocks(previous => ({ ...previous, [def.id]: defaultBlockText(def, style) }))}><RotateCcw size={13} />恢复默认</Button>
            </Field>;
          })}</section>}
          <section className="panel stack"><div className="section-title"><h3>实时预览</h3><span className={`small ${overLimit ? 'text-[#e88b93]' : preview.length > warningAt ? 'text-[#d8b26a]' : 'muted'}`}>{preview.length} / {limit} 字{kind === 'video' && preview.length > 6000 ? ' · 接近视频上限' : ''}</span></div><textarea readOnly rows={14} aria-label="模板预览" value={preview} />{overLimit && <ErrorNote message={`提示词 ${preview.length} 字，超过上限 ${limit} 字，请精简后可保存。`} />}{!overLimit && unknown.length > 0 && <ErrorNote message={`${unknown.join('；')}。请修正未知变量后再保存。`} />}{parseIssues.filter(issue => issue.includes('缺少必需块')).map(issue => <ErrorNote key={issue} message={issue} />)}</section>
          <div className="toolbar sticky-actions"><Button onClick={save} disabled={unknown.length > 0 || overLimit}>保存模板</Button><Button variant="ghost" onClick={onClose}>取消</Button></div>
        </div>
      </div>
    </SheetContent>
  </Sheet>;
}

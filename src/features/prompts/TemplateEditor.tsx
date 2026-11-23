import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button, ErrorNote, Field } from '../../components/Ui';
import { PROMPT_LIMITS, renderPrompt, validatePromptSpec } from '../../lib/promptSpec';
import { defaultStyleSpec, findUnknownVariables } from '../../lib/promptTemplates';
import {
  PROMPT_KINDS, builtinBlocksFor, dataBlocksFor, defaultBlocksFor, planFor, renderData,
  type BuiltinBlock, type ExtractCategory,
} from '../../lib/promptBlocks';
import { directorSpec, extractCharactersSpec, extractPropsSpec, extractScenesSpec, imageSpec, scriptSpec, videoSpec } from '../../lib/prompts';
import { updateProject } from '../../store/studio';
import { makeShot, uid, type Asset, type Project, type PromptBlockPlan, type PromptKindId, type StyleSpec } from '../../domain/types';

const styleLabels: Record<'medium' | 'line' | 'palette' | 'face' | 'light', string> = {
  medium: '介质', line: '线条', palette: '配色', face: '面部渲染', light: '光线',
};

const TEMPLATE_TABS = [
  { id: 'script', title: '剧本', description: '把主题或原文写成一份完整的漫剧剧本。' },
  { id: 'assets', title: '资产', description: '人物、场景、道具分三类识别，各用各的提示词。' },
  { id: 'director', title: '导演', description: '把剧本拆成逐镜分镜脚本，不改剧情与时长。' },
  { id: 'image', title: '图片', description: '人物三视图与场景、道具设定图。' },
  { id: 'video', title: '视频', description: '按分镜生成镜头视频，固定外观与附件顺序。' },
] as const;
type TemplateTab = typeof TEMPLATE_TABS[number]['id'];

const ASSET_KINDS: { id: ExtractCategory; label: string; kind: PromptKindId }[] = [
  { id: 'character', label: '人物', kind: 'extract-characters' },
  { id: 'scene', label: '场景', kind: 'extract-scenes' },
  { id: 'prop', label: '道具', kind: 'extract-props' },
];

/** 只有文本类 action 有后端固定契约；图片与视频不发送 system_instruction。 */
const CONTRACT_TARGETS: Partial<Record<PromptKindId, string>> = {
  script: 'screenplay',
  'extract-characters': 'extract-characters',
  'extract-scenes': 'extract-scenes',
  'extract-props': 'extract-props',
  director: 'director',
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

export default function TemplateEditor({ project, open, onClose, initialKind = 'script', onSaved }: {
  project: Project; open: boolean; onClose: () => void; initialKind?: TemplateTab; onSaved?: (styleChanged: boolean) => void;
}) {
  const [tab, setTab] = useState<TemplateTab>(initialKind);
  const [assetKind, setAssetKind] = useState<ExtractCategory>('character');
  const [plans, setPlans] = useState<Partial<Record<PromptKindId, PromptBlockPlan[]>>>({});
  const [style, setStyle] = useState<StyleSpec>({});
  const [mode, setMode] = useState<'blocks' | 'style'>('blocks');
  const [builtinChoice, setBuiltinChoice] = useState('');
  const [dataChoice, setDataChoice] = useState('');
  const [contract, setContract] = useState<{ instruction: string; schema: unknown } | undefined>();

  useEffect(() => {
    if (!open) return;
    const initialStyle = cleanStyle(project.promptConfig?.style ?? defaultStyleSpec(project.style));
    const next: Partial<Record<PromptKindId, PromptBlockPlan[]>> = {};
    for (const kind of PROMPT_KINDS) next[kind] = project.promptConfig?.templates?.[kind]?.blocks ?? defaultBlocksFor(kind);
    setTab(initialKind);
    setAssetKind('character');
    setStyle(initialStyle);
    setPlans(next);
    setMode('blocks');
    setBuiltinChoice('');
    setDataChoice('');
  }, [open, project.id, initialKind]);

  const kind: PromptKindId = tab === 'assets' ? ASSET_KINDS.find(item => item.id === assetKind)!.kind : tab;
  const blocks = plans[kind] ?? planFor(project, kind);
  const styleValue = useMemo(() => cleanStyle(style), [style]);
  const draftProject = useMemo<Project>(() => {
    const templates: Partial<Record<PromptKindId, { blocks: PromptBlockPlan[] }>> = {};
    for (const item of PROMPT_KINDS) templates[item] = { blocks: plans[item] ?? [] };
    return { ...project, promptConfig: { v: 2, style: styleValue, templates } };
  }, [project, plans, styleValue]);
  const previewAsset = useMemo<Asset>(() => project.assets.find(asset => asset.kind !== 'voice') ?? {
    id: 'preview-asset', kind: 'character', name: '示例人物', description: '示例描述', lock: '示例固定短语：灰白旧衣，背空剑鞘', imageId: 'preview-image',
  }, [project.assets]);
  const previewShot = useMemo(() => project.shots[0] ?? { ...makeShot(1), visual: '示例画面：人物走上石阶', start: '示例开场', action: '示例动作', end: '示例终点' }, [project.shots]);

  const previewSpecs = useMemo(() => {
    if (tab === 'script') return [{ label: '', spec: scriptSpec(draftProject) }];
    if (tab === 'assets') return ASSET_KINDS.map(item => ({ label: item.label, spec: item.id === 'character' ? extractCharactersSpec(draftProject) : item.id === 'scene' ? extractScenesSpec(draftProject) : extractPropsSpec(draftProject) }));
    if (tab === 'director') return [{ label: '', spec: directorSpec(draftProject) }];
    if (tab === 'image') return [{ label: '', spec: imageSpec(draftProject, previewAsset) }];
    return [{ label: '', spec: videoSpec(draftProject, previewShot) }];
  }, [tab, draftProject, previewAsset, previewShot]);

  const previews = previewSpecs.map(item => {
    const text = renderPrompt(item.spec);
    const limit = PROMPT_LIMITS[item.spec.kind];
    const warningAt = item.spec.kind === 'video' ? 6000 : Math.floor(limit * 0.9);
    return { ...item, text, limit, warningAt, over: text.length > limit, issues: validatePromptSpec(item.spec) };
  });
  const overLimit = previews.some(item => item.over);
  const unknown = blocks.flatMap(block => findUnknownVariables(block.text).map(variable => `「${block.title}」使用了未知变量 {{${variable}}}`));
  const styleChanged = JSON.stringify(styleValue) !== JSON.stringify(cleanStyle(project.promptConfig?.style ?? defaultStyleSpec(project.style)));

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const target = CONTRACT_TARGETS[kind];
    if (!target) { setContract(undefined); return; }
    void fetch('/functions/v1/app?action=contracts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ for: target }) })
      .then(response => response.json())
      .then(result => { if (!cancelled) setContract(result?.ok ? result.data : undefined); })
      .catch(() => { if (!cancelled) setContract(undefined); });
    return () => { cancelled = true; };
  }, [open, kind]);

  const setKindBlocks = (next: PromptBlockPlan[]) => setPlans(previous => ({ ...previous, [kind]: next }));
  const updateBlock = (id: string, patch: Partial<PromptBlockPlan>) => setKindBlocks(blocks.map(block => block.id === id ? { ...block, ...patch } : block));
  const removeBlock = (id: string) => setKindBlocks(blocks.filter(block => block.id !== id));
  const moveBlock = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    setKindBlocks(next);
  };
  const addBlock = () => setKindBlocks([...blocks, { id: uid(), title: '新块', text: '' }]);
  const insertBuiltin = () => {
    const found = builtinBlocksFor(kind).find(item => item.id === builtinChoice);
    if (!found) return;
    if (blocks.some(block => block.id === found.id)) { toast.error(`「${found.title}」已经在模板里了。`); return; }
    setKindBlocks([...blocks, { id: found.id, title: found.title, text: '', builtin: found.id }]);
    setBuiltinChoice('');
  };
  const insertData = () => {
    const found = dataBlocksFor(kind).find(item => item.source === dataChoice);
    if (!found) return;
    const id = `data.${found.source}`;
    if (blocks.some(block => block.id === id)) { toast.error(`「${found.title}」已经在模板里了。`); return; }
    setKindBlocks([...blocks, { id, title: found.title, text: '', source: found.source }]);
    setDataChoice('');
  };
  const clearKind = () => {
    if (!window.confirm(`清空「${TEMPLATE_TABS.find(item => item.id === tab)?.title}」模板的全部块？清空后该步骤就没有任何提示词了。`)) return;
    setKindBlocks([]);
  };
  const save = () => {
    if (unknown.length || overLimit) return;
    const templates: Record<PromptKindId, { blocks: PromptBlockPlan[] }> = {} as Record<PromptKindId, { blocks: PromptBlockPlan[] }>;
    for (const item of PROMPT_KINDS) templates[item] = { blocks: plans[item] ?? [] };
    updateProject(project.id, { promptConfig: { v: 2, style: styleValue, templates } }, false);
    toast.success('提示词模板已保存，对下一次生成立效。');
    onSaved?.(styleChanged);
    onClose();
  };

  const builtinOptions = builtinBlocksFor(kind).filter(item => !blocks.some(block => block.id === item.id));
  const dataOptions = dataBlocksFor(kind).filter(item => !blocks.some(block => block.source === item.source));

  return <Sheet open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <SheetContent side="left" className="w-full overflow-y-auto p-6 sm:max-w-6xl">
      <SheetHeader className="p-0"><SheetTitle>提示词模板</SheetTitle><SheetDescription>每一块都可改、可增、可删、可调序，没有锁定块。保存后对下一次生成立效，不改动已生成素材。实时预览就是发往模型的全部内容。</SheetDescription></SheetHeader>
      <div className="template-editor">
        <nav className="template-tabs" aria-label="模板选择">{TEMPLATE_TABS.map(item => <button key={item.id} type="button" className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><strong>{item.title}</strong><small>{item.description}</small></button>)}</nav>
        <div className="template-body stack">
          <div className="toolbar"><div className="tabs-row"><button className={mode === 'blocks' ? 'active' : ''} onClick={() => setMode('blocks')}>模板块</button><button className={mode === 'style' ? 'active' : ''} onClick={() => setMode('style')}>风格设定</button></div></div>
          {mode === 'style' && <section className="panel stack"><div className="section-title"><h3>StyleSpec · {project.style}</h3><span className="small muted">风格内容由你填写；提示词里用 {'{{style.medium}}'} 这类变量引用</span></div><div className="grid-2">{(['medium', 'line', 'palette', 'face', 'light'] as const).map(key => <Field key={key} label={styleLabels[key]}><textarea rows={2} value={style[key] ?? ''} onChange={event => setStyle({ ...style, [key]: event.target.value })} /></Field>)}</div><Field label="禁写清单（每行一条）"><textarea rows={3} value={(style.forbidden ?? []).join('\n')} onChange={event => setStyle({ ...style, forbidden: event.target.value.split('\n') })} /></Field></section>}
          {mode === 'blocks' && <section className="stack">
            <div className="section-title"><h3>{TEMPLATE_TABS.find(item => item.id === tab)?.title}模板</h3><span className="small muted">{TEMPLATE_TABS.find(item => item.id === tab)?.description}</span></div>
            {tab === 'assets' && <div className="tabs-row">{ASSET_KINDS.map(item => <button key={item.id} className={assetKind === item.id ? 'active' : ''} onClick={() => setAssetKind(item.id)}>{item.label}</button>)}</div>}
            <div className="toolbar">
              <Button variant="secondary" size="sm" onClick={addBlock}><Plus size={14} />新增块</Button>
              <select aria-label="选择内置块" value={builtinChoice} onChange={event => setBuiltinChoice(event.target.value)}>
                <option value="">插入内置块…</option>
                {builtinOptions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
              <Button variant="outline" size="sm" onClick={insertBuiltin} disabled={!builtinChoice}>插入</Button>
              <select aria-label="选择数据块" value={dataChoice} onChange={event => setDataChoice(event.target.value)}>
                <option value="">插入数据块…</option>
                {dataOptions.map(item => <option key={item.source} value={item.source}>{item.title}</option>)}
              </select>
              <Button variant="outline" size="sm" onClick={insertData} disabled={!dataChoice}>插入</Button>
              <Button variant="ghost" size="sm" onClick={clearKind}>清空模板</Button>
            </div>
            {blocks.length === 0 && <p className="muted">这个模板还没有块。用「新增块」写自己的提示词，或「插入内置块」取一个空标题再填。</p>}
            {blocks.map((block, index) => {
              const data = block.source ? renderData(block.source, { project, asset: previewAsset, shot: previewShot }) : '';
              return <section className="panel stack" key={block.id}>
                <div className="section-title">
                  <input aria-label={`块标题 ${index + 1}`} value={block.title} onChange={event => updateBlock(block.id, { title: event.target.value })} />
                  <span className="small muted">{block.text.length} 字{block.source ? ' · 数据块' : ''}</span>
                  <div className="row">
                    <Button variant="ghost" size="sm" aria-label={`上移 ${block.title}`} onClick={() => moveBlock(index, -1)} disabled={index === 0}><ChevronUp size={14} /></Button>
                    <Button variant="ghost" size="sm" aria-label={`下移 ${block.title}`} onClick={() => moveBlock(index, 1)} disabled={index === blocks.length - 1}><ChevronDown size={14} /></Button>
                    <Button variant="ghost" size="sm" aria-label={`删除 ${block.title}`} onClick={() => removeBlock(block.id)}><Trash2 size={14} /></Button>
                  </div>
                </div>
                {block.source && <details className="panel"><summary>数据预览（{block.source}）</summary><pre>{data || '（当前没有数据）'}</pre></details>}
                <Field label={block.source ? '补充说明（可留空）' : '正文'} hint="支持变量：{{project.theme}}、{{project.style}}、{{style.medium}} 等；未知变量会阻止保存。">
                  <textarea rows={4} value={block.text} onChange={event => updateBlock(block.id, { text: event.target.value })} />
                </Field>
                {findUnknownVariables(block.text).length > 0 && <small className="text-[#e88b93]">未知变量：{findUnknownVariables(block.text).map(item => `{{${item}}}`).join('、')}</small>}
              </section>;
            })}
          </section>}
          {previews.map(item => <section className="panel stack" key={item.spec.kind}>
            <div className="section-title"><h3>{item.label ? `实时预览 · ${item.label}` : '实时预览'}</h3><span className={`small ${item.over ? 'text-[#e88b93]' : item.text.length > item.warningAt ? 'text-[#d8b26a]' : 'muted'}`}>{item.text.length} / {item.limit} 字</span></div>
            <textarea readOnly rows={14} aria-label={item.label ? `模板预览 · ${item.label}` : '模板预览'} value={item.text} />
            {item.over && <ErrorNote message={`提示词 ${item.text.length} 字，超过上限 ${item.limit} 字，请精简后可保存。`} />}
            {!item.over && unknown.length > 0 && <ErrorNote message={`${unknown.join('；')}。请修正未知变量后再保存。`} />}
          </section>)}
          {contract && <section className="panel stack">
            <div className="section-title"><h3>接口固定契约</h3><span className="small muted">由后端固定，不可编辑；模型会连同上面的预览一起收到</span></div>
            <pre>{contract.instruction}</pre>
            <pre>{JSON.stringify(contract.schema, null, 2)}</pre>
          </section>}
          <div className="toolbar sticky-actions"><Button onClick={save} disabled={unknown.length > 0 || overLimit}>保存模板</Button><Button variant="ghost" onClick={onClose}>取消</Button></div>
        </div>
      </div>
    </SheetContent>
  </Sheet>;
}

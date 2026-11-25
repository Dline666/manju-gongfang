import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button, ErrorNote, Field } from '../../components/Ui';
import { PROMPT_LIMITS, renderPrompt, validatePromptSpec } from '../../lib/promptSpec';
import { findUnknownVariables } from '../../lib/promptTemplates';
import { PROMPT_KINDS, builtinBlocksFor, dataSourcesFor, type ExtractCategory } from '../../lib/promptBlocks';
import { directorSpec, extractCharactersSpec, extractPropsSpec, extractScenesSpec, imageSpec, scriptSpec, videoSpec } from '../../lib/prompts';
import { overridesOf } from '../../lib/promptScope';
import { setSettings, updateProject, useStudio } from '../../store/studio';
import { makeShot, uid, defaultPromptTemplates, type Asset, type Project, type PromptBlockPlan, type PromptKindId, type PromptTemplatePlan, type PromptTemplateSet, type StyleSpec } from '../../domain/types';

const styleLabels: Record<'medium' | 'line' | 'palette' | 'face' | 'light', string> = {
  medium: '介质', line: '线条', palette: '配色', face: '面部渲染', light: '光线',
};

const TEMPLATE_TABS = [
  { id: 'script', title: '剧本', description: '把主题或原文写成一份完整的漫剧剧本。' },
  { id: 'assets', title: '资产', description: '人物、场景、道具分三类识别，各用各的提示词。' },
  { id: 'director', title: '导演', description: '把剧本拆成逐镜分镜脚本，不改剧情与时长。' },
  { id: 'image', title: '图片', description: '人物、场景、道具的设定图各用各的提示词。' },
  { id: 'video', title: '视频', description: '按分镜生成镜头视频，固定外观与附件顺序。' },
] as const;
export type TemplateTab = typeof TEMPLATE_TABS[number]['id'];
export type TemplateScope = 'global' | 'project';

/** 栏内再分三类的：资产提取与设定图，人物/场景/道具各自独立。 */
const SUB_TABS: Partial<Record<TemplateTab, { id: string; label: string; kind: PromptKindId }[]>> = {
  assets: [
    { id: 'character', label: '人物', kind: 'extract-characters' },
    { id: 'scene', label: '场景', kind: 'extract-scenes' },
    { id: 'prop', label: '道具', kind: 'extract-props' },
  ],
  image: [
    { id: 'character', label: '人物', kind: 'image-character' },
    { id: 'scene', label: '场景', kind: 'image-scene' },
    { id: 'prop', label: '道具', kind: 'image-prop' },
  ],
};

/** 只有文本类 action 有后端固定契约；图片与视频不发送 system_instruction。 */
const CONTRACT_TARGETS: Partial<Record<PromptKindId, string>> = {
  script: 'screenplay',
  'extract-characters': 'extract-characters',
  'extract-scenes': 'extract-scenes',
  'extract-props': 'extract-props',
  director: 'director',
};

/** 设定图的三份模板：人物 / 场景 / 道具，各自独立。 */
const IMAGE_TEMPLATE_KINDS: PromptKindId[] = ['image-character', 'image-scene', 'image-prop'];

/** 设定图预览用的示例资产：没有真实资产时按品类各给一个。 */
const IMAGE_SAMPLES: Record<'character' | 'scene' | 'prop', Asset> = {
  character: { id: 'preview-character', kind: 'character', name: '示例人物', description: '示例描述', lock: '示例固定短语：灰白旧衣，背空剑鞘', imageId: 'preview-image' },
  scene: { id: 'preview-scene', kind: 'scene', name: '示例场景', description: '示例描述', lock: '示例固定短语：青灰石阶九十九级，晨雾低垂', imageId: 'preview-image' },
  prop: { id: 'preview-prop', kind: 'prop', name: '示例道具', description: '示例描述', lock: '示例固定短语：红绳缠绕的剑柄，断口有微弱金色灵光', imageId: 'preview-image' },
};

function cleanStyle(style: StyleSpec | undefined): StyleSpec {
  const result: StyleSpec = {};
  for (const key of ['medium', 'line', 'palette', 'face', 'light'] as const) {
    const value = style?.[key]?.trim();
    if (value) result[key] = value;
  }
  const forbidden = (style?.forbidden ?? []).map(item => item.trim()).filter(Boolean);
  if (forbidden.length) result.forbidden = forbidden;
  return result;
}

const cloneTemplates = (templates: PromptTemplateSet['templates']): PromptTemplateSet['templates'] => {
  const result: NonNullable<PromptTemplateSet['templates']> = {};
  for (const kind of PROMPT_KINDS) {
    const plan = templates?.[kind];
    if (plan) result[kind] = { blocks: plan.blocks.map(block => ({ ...block })) };
  }
  return result;
};

/**
 * 提示词模板整页编辑器。
 *
 * 模板分两层：全局模板是默认，所有作品跟随；单部作品可以只覆盖其中某一步。
 * 作品覆盖层里「键存在」就归作品管（块可以为空），没有的键跟随全局。
 * 模板里只有用户写的块，作品数据由系统在渲染时固定附带，不在这里编辑。
 */
export default function TemplateEditorPage({ project, initialScope = 'global', initialKind = 'script', initialSub }: {
  project?: Project; initialScope?: TemplateScope; initialKind?: TemplateTab; initialSub?: string;
}) {
  const state = useStudio();
  const settings = state.settings;
  const savedGlobal = settings.promptTemplates;
  const [scope, setScope] = useState<TemplateScope>(project ? initialScope : 'global');
  const [tab, setTab] = useState<TemplateTab>(initialKind);
  const [sub, setSub] = useState<Record<string, string>>({ assets: initialSub ?? 'character', image: initialSub ?? 'character' });
  const [mode, setMode] = useState<'blocks' | 'style'>('blocks');
  const [builtinChoice, setBuiltinChoice] = useState('');
  const [contract, setContract] = useState<{ instruction: string; schema: unknown } | undefined>();
  const [globalDraft, setGlobalDraft] = useState<PromptTemplateSet>({ templates: {} });
  const [projectDraft, setProjectDraft] = useState<PromptTemplateSet>({ templates: {} });

  const draft = scope === 'global' ? globalDraft : projectDraft;
  const setDraft = scope === 'global' ? setGlobalDraft : setProjectDraft;

  // 全局草稿跟着已保存的全局模板走；作品草稿只装这部作品自己管的那几步。
  useEffect(() => {
    setGlobalDraft({ style: cleanStyle(savedGlobal?.style), templates: cloneTemplates(savedGlobal?.templates) });
  }, [savedGlobal]);
  useEffect(() => {
    if (!project) { setProjectDraft({ templates: {} }); return; }
    const overrides = overridesOf(project);
    setProjectDraft({
      style: overrides && 'style' in overrides ? cleanStyle(overrides.style) : undefined,
      templates: cloneTemplates(overrides?.templates),
    });
  }, [project?.id, project?.revision]);

  const subs = SUB_TABS[tab];
  const subId = subs ? (subs.some(item => item.id === sub[tab]) ? sub[tab] : subs[0].id) : '';
  const kind: PromptKindId = subs ? subs.find(item => item.id === subId)!.kind : (tab as PromptKindId);
  const globalBlocks = savedGlobal?.templates?.[kind]?.blocks ?? [];
  // 草稿就是这一层的真相：覆盖层里有这一步 = 归本作品管。
  const kindIsOwned = scope === 'global' || draft.templates?.[kind] !== undefined;
  const blocks: PromptBlockPlan[] = scope === 'global'
    ? (draft.templates?.[kind]?.blocks ?? [])
    : (draft.templates?.[kind]?.blocks ?? globalBlocks);
  const editable = kindIsOwned;
  const ownsStyleSpec = scope === 'global' || draft.style !== undefined;
  const styleValue = scope === 'global' ? cleanStyle(draft.style) : (ownsStyleSpec ? cleanStyle(draft.style) : cleanStyle(savedGlobal?.style));
  // 旧模板共用过的块：只留在人物那份，编辑器里说明它从哪儿来。
  const sharedBlockCount = useMemo(() => {
    if (tab !== 'image') return 0;
    let count = 0;
    for (const imageKind of IMAGE_TEMPLATE_KINDS) {
      const own = scope === 'global'
        ? globalDraft.templates?.[imageKind]?.blocks
        : (projectDraft.templates?.[imageKind]?.blocks ?? savedGlobal?.templates?.[imageKind]?.blocks ?? []);
      count += (own ?? []).filter(block => block.shared).length;
    }
    return count;
  }, [tab, scope, globalDraft, projectDraft, savedGlobal]);

  const sampleProject = useMemo<Project>(() => project ?? {
    id: 'preview-project', name: '示例作品', theme: '示例主题', style: '东方玄幻水墨风，冷灰 + 金色灵光',
    createdAt: '', updatedAt: '', revision: 0, skills: ['script'], shots: [], assets: [], source: 'empty', storyboardReady: false,
  }, [project]);
  const previewProject = useMemo<Project>(() => {
    if (scope === 'global') return { ...sampleProject, promptConfig: undefined };
    const overrides: PromptTemplateSet = { templates: cloneTemplates(projectDraft.templates) };
    if (projectDraft.style) overrides.style = projectDraft.style;
    return { ...sampleProject, promptConfig: { v: 3, overrides } };
  }, [scope, sampleProject, projectDraft]);
  const previewGlobal = scope === 'global' ? globalDraft : savedGlobal;
  const imageCategory = (tab === 'image' ? subId : 'character') as 'character' | 'scene' | 'prop';
  const imageAsset = useMemo<Asset>(() => project?.assets.find(asset => asset.kind === imageCategory) ?? IMAGE_SAMPLES[imageCategory], [project?.assets, imageCategory]);
  const previewShot = useMemo(() => project?.shots[0] ?? { ...makeShot(1), visual: '示例画面：人物走上石阶', start: '示例开场', action: '示例动作', end: '示例终点' }, [project?.shots]);

  const previewSpecs = useMemo(() => {
    // 资产三类与设定图三类各看各的：当前在看哪个板块，就只预览那一个
    if (tab === 'assets') {
      const item = subs!.find(entry => entry.id === subId)!;
      const spec = item.kind === 'extract-characters' ? extractCharactersSpec(previewProject, previewGlobal) : item.kind === 'extract-scenes' ? extractScenesSpec(previewProject, previewGlobal) : extractPropsSpec(previewProject, previewGlobal);
      return [{ label: item.label, spec }];
    }
    if (tab === 'script') return [{ label: '', spec: scriptSpec(previewProject, previewGlobal) }];
    if (tab === 'director') return [{ label: '', spec: directorSpec(previewProject, previewGlobal) }];
    if (tab === 'image') return [{ label: subs!.find(entry => entry.id === subId)!.label, spec: imageSpec(previewProject, imageAsset, previewGlobal) }];
    return [{ label: '', spec: videoSpec(previewProject, previewShot, previewGlobal) }];
  }, [tab, subId, subs, previewProject, previewGlobal, imageAsset, previewShot]);

  const previews = previewSpecs.map(item => {
    const text = renderPrompt(item.spec);
    const limit = PROMPT_LIMITS[item.spec.kind];
    const warningAt = item.spec.kind === 'video' ? 6000 : Math.floor(limit * 0.9);
    return { ...item, text, limit, warningAt, over: text.length > limit, issues: validatePromptSpec(item.spec) };
  });
  const overLimit = previews.some(item => item.over);
  const unknown = blocks.flatMap(block => findUnknownVariables(block.text).map(variable => `「${block.title}」使用了未知变量 {{${variable}}}`));

  useEffect(() => {
    let cancelled = false;
    const target = CONTRACT_TARGETS[kind];
    if (!target) { setContract(undefined); return; }
    void fetch('/functions/v1/app?action=contracts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ for: target }) })
      .then(response => response.json())
      .then(result => { if (!cancelled) setContract(result?.ok ? result.data : undefined); })
      .catch(() => { if (!cancelled) setContract(undefined); });
    return () => { cancelled = true; };
  }, [kind]);

  const setKindBlocks = (next: PromptBlockPlan[]) => setDraft(previous => ({ ...previous, templates: { ...previous.templates, [kind]: { blocks: next } } }));
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
  const clearKind = () => {
    if (!window.confirm(`清空「${TEMPLATE_TABS.find(item => item.id === tab)?.title}」模板的全部块？清空后该步骤就没有任何提示词了。`)) return;
    setKindBlocks([]);
  };
  /**
   * 出厂默认块：存档里缺这一步、或者这一步的出厂块被清掉时，一键补回来。
   * 已经有正文的老块不动，只补缺失的块、把空着的同名块填上出厂正文。
   */
  const factoryBlocks = defaultPromptTemplates.templates?.[kind]?.blocks ?? [];
  const insertFactory = () => {
    if (!factoryBlocks.length) return;
    const next = [...blocks];
    let added = 0; let filled = 0;
    for (const item of factoryBlocks) {
      const index = next.findIndex(block => block.id === item.id);
      if (index < 0) { next.push({ ...item }); added += 1; continue; }
      if (!next[index].text.trim()) { next[index] = { ...next[index], text: item.text }; filled += 1; }
    }
    if (!added && !filled) { toast.info('这一步的出厂默认块都在，没有要补的。'); return; }
    setKindBlocks(next);
    toast.success(added ? `已补入 ${added} 条出厂默认块。` : `已填好 ${filled} 条出厂默认块的正文。`);
  };

  /** 作品这一步改为独立编辑：以全局模板当前内容为起点。 */
  const makeIndependent = () => {
    setProjectDraft(previous => ({ ...previous, templates: { ...previous.templates, [kind]: { blocks: globalBlocks.map(block => ({ ...block })) } } }));
    toast.success('这一步现在由本作品独立管理，改动不再跟随全局模板。');
  };
  /** 作品这一步恢复跟随全局：删掉自己的覆盖层。 */
  const followGlobal = () => {
    setProjectDraft(previous => {
      const templates = { ...previous.templates };
      delete templates[kind];
      return { ...previous, templates };
    });
    toast.success('这一步已恢复跟随全局模板。');
  };
  const makeStyleIndependent = () => {
    setProjectDraft(previous => ({ ...previous, style: cleanStyle(savedGlobal?.style) }));
    toast.success('风格设定现在由本作品独立管理。');
  };
  const followGlobalStyle = () => {
    setProjectDraft(previous => { const next = { ...previous }; delete next.style; return next; });
    toast.success('风格设定已恢复跟随全局模板。');
  };
  /** 把这部作品自己管的模板一次性提到全局，方便从旧作品迁到新结构。 */
  const promoteToGlobal = () => {
    if (!project) return;
    const own = overridesOf(project);
    if (!own || (!own.templates && !own.style)) { toast.error('本作品还没有独立管理的模板。'); return; }
    if (!window.confirm('把本作品独立管理的模板复制为全局默认？全局改动会影响所有跟随全局的作品，本作品已有的覆盖层不受影响。')) return;
    setSettings({
      ...settings,
      promptTemplates: {
        style: own.style ?? savedGlobal?.style,
        templates: { ...(savedGlobal?.templates ?? {}), ...cloneTemplates(own.templates) },
      },
    });
    toast.success('已复制为全局默认模板。');
  };

  const save = () => {
    if (unknown.length || overLimit) return;
    if (scope === 'global') {
      setSettings({ ...settings, promptTemplates: { style: cleanStyle(draft.style), templates: cloneTemplates(draft.templates) } });
      toast.success('全局模板已保存，所有跟随全局的作品立即生效。');
      return;
    }
    if (!project) return;
    const overrides: PromptTemplateSet = { templates: cloneTemplates(draft.templates) };
    if (draft.style) overrides.style = draft.style;
    updateProject(project.id, { promptConfig: { v: 3, overrides } }, false);
    toast.success('本作品的模板覆盖已保存。');
  };

  const builtinOptions = builtinBlocksFor(kind).filter(item => !blocks.some(block => block.id === item.id));
  const injectedSources = dataSourcesFor(kind);
  const scopeLabel = scope === 'global' ? '全局模板（默认）' : `当前作品 · ${project?.name ?? '未选择作品'}`;

  return <div className="stack">
    <p className="small muted">模板里只有你写的块，可改、可增、可删、可调序。作品数据不在模板里，由系统每次自动附带。</p>
    <div className="tabs-row" role="tablist" aria-label="模板作用域">
      <button type="button" role="tab" aria-selected={scope === 'global'} className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>全局模板（默认）</button>
      <button type="button" role="tab" aria-selected={scope === 'project'} className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')} disabled={!project}>当前作品 · {project?.name ?? '未选择作品'}</button>
    </div>
    <p className="small muted">{scope === 'global'
      ? '全局模板是所有作品的默认。改动立刻影响所有跟随全局的作品；某部作品自己管的步骤不受影响。'
      : '这里只改这部作品。没单独管的步骤仍跟随全局模板，改全局时它们一起变。'}</p>
    <div className="template-editor">
      <nav className="template-tabs" aria-label="模板选择">{TEMPLATE_TABS.map(item => <button key={item.id} type="button" className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><strong>{item.title}</strong><small>{item.description}</small></button>)}</nav>
      <div className="template-body stack">
        <div className="toolbar"><div className="tabs-row"><button className={mode === 'blocks' ? 'active' : ''} onClick={() => setMode('blocks')}>模板块</button><button className={mode === 'style' ? 'active' : ''} onClick={() => setMode('style')}>风格设定</button></div></div>
        {mode === 'style' && <section className="panel stack">
          <div className="section-title"><h3>风格设定</h3><span className="small muted">风格内容由你填写；提示词里用 {'{{style.medium}}'} 这类变量引用</span></div>
          {scope === 'project' && !ownsStyleSpec && <div className="alert" role="alert">本作品的风格设定正在跟随全局。<Button variant="secondary" size="sm" onClick={makeStyleIndependent}>改为独立编辑</Button></div>}
          {scope === 'project' && ownsStyleSpec && <div className="toolbar"><span className="tag">本作品独立</span><Button variant="ghost" size="sm" onClick={followGlobalStyle}>恢复跟随全局</Button></div>}
          <div className="grid-2">{(['medium', 'line', 'palette', 'face', 'light'] as const).map(key => <Field key={key} label={styleLabels[key]}><textarea rows={2} disabled={scope === 'project' && !ownsStyleSpec} value={styleValue[key] ?? ''} onChange={event => setDraft(previous => ({ ...previous, style: { ...previous.style, [key]: event.target.value } }))} /></Field>)}</div>
          <Field label="禁写清单（每行一条）"><textarea rows={3} disabled={scope === 'project' && !ownsStyleSpec} value={(styleValue.forbidden ?? []).join('\n')} onChange={event => setDraft(previous => ({ ...previous, style: { ...previous.style, forbidden: event.target.value.split('\n') } }))} /></Field>
        </section>}
        {mode === 'blocks' && <section className="stack">
          <div className="section-title"><h3>{TEMPLATE_TABS.find(item => item.id === tab)?.title}模板</h3><span className="small muted">{TEMPLATE_TABS.find(item => item.id === tab)?.description}</span></div>
          {subs && <div className="tabs-row" role="tablist" aria-label="品类">{subs.map(item => <button key={item.id} role="tab" aria-selected={subId === item.id} className={subId === item.id ? 'active' : ''} onClick={() => setSub(previous => ({ ...previous, [tab]: item.id }))}>{item.label}</button>)}</div>}
          {tab === 'image' && sharedBlockCount > 0 && <p className="small muted">旧模板曾让人物、场景、道具共用同一段文字。拆分后这段只留在「人物」那份，场景与道具不再自动带上它；需要同样的约束时，在对应那段里新建一条照抄即可。</p>}
          {scope === 'project' && (kindIsOwned
            ? <div className="toolbar"><span className="tag">本作品独立</span><Button variant="ghost" size="sm" onClick={followGlobal}>恢复跟随全局</Button></div>
            : <div className="alert" role="alert">这一步正在跟随全局模板，下面显示的是全局的内容。<Button variant="secondary" size="sm" onClick={makeIndependent}>改为独立编辑</Button></div>)}
          <div className="toolbar">
            <Button variant="secondary" size="sm" onClick={addBlock} disabled={!editable}><Plus size={14} />新增块</Button>
            <select aria-label="选择内置块" style={{ maxWidth: 240 }} value={builtinChoice} onChange={event => setBuiltinChoice(event.target.value)} disabled={!editable}>
              <option value="">插入内置块…</option>
              {builtinOptions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
            <Button variant="outline" size="sm" onClick={insertBuiltin} disabled={!builtinChoice || !editable}>插入</Button>
            {scope === 'global' && factoryBlocks.length > 0 && <Button variant="ghost" size="sm" onClick={insertFactory}>补入出厂默认块</Button>}
            <Button variant="ghost" size="sm" onClick={clearKind} disabled={!editable}>清空模板</Button>
          </div>
          {blocks.length === 0 && <p className="muted">这个模板还没有块。用「新增块」写自己的提示词，或「插入内置块」取一个空标题再填。</p>}
          {blocks.map((block, index) => {
            return <section className="panel stack" key={block.id}>
              <div className="section-title">
                <input aria-label={`块标题 ${index + 1}`} value={block.title} disabled={!editable} onChange={event => updateBlock(block.id, { title: event.target.value })} />
                <span className="small muted">{block.text.length} 字</span>
                {block.shared && <span className="tag">旧模板</span>}
                <div className="row">
                  <Button variant="ghost" size="sm" aria-label={`上移 ${block.title}`} onClick={() => moveBlock(index, -1)} disabled={index === 0 || !editable}><ChevronUp size={14} /></Button>
                  <Button variant="ghost" size="sm" aria-label={`下移 ${block.title}`} onClick={() => moveBlock(index, 1)} disabled={index === blocks.length - 1 || !editable}><ChevronDown size={14} /></Button>
                  <Button variant="ghost" size="sm" aria-label={`删除 ${block.title}`} onClick={() => removeBlock(block.id)} disabled={!editable}><Trash2 size={14} /></Button>
                </div>
              </div>
              <Field label="正文" hint="支持变量：{{project.theme}}、{{project.style}}、{{style.medium}} 等；未知变量会阻止保存。">
                <textarea rows={4} value={block.text} disabled={!editable} onChange={event => updateBlock(block.id, { text: event.target.value })} />
              </Field>
              {findUnknownVariables(block.text).length > 0 && <small className="text-[#e88b93]">未知变量：{findUnknownVariables(block.text).map(item => `{{${item}}}`).join('、')}</small>}
            </section>;
          })}
        </section>}
        {previews.map(item => <section className="panel stack" key={item.spec.kind}>
          <div className="section-title"><h3>{item.label ? `实时预览 · ${item.label}` : '实时预览'}</h3><span className={`small ${item.over ? 'text-[#e88b93]' : item.text.length > item.warningAt ? 'text-[#d8b26a]' : 'muted'}`}>{item.text.length} / {item.limit} 字</span></div>
          {injectedSources.length > 0 && <p className="small muted">下面是你写的块，后面由系统自动附带作品数据：{injectedSources.map(source => source.title).join('、')}。数据不在模板里，不能增删调序。</p>}
          <textarea readOnly rows={14} aria-label={item.label ? `模板预览 · ${item.label}` : '模板预览'} value={item.text} />
          {item.over && <ErrorNote message={`提示词 ${item.text.length} 字，超过上限 ${item.limit} 字，请精简后可保存。`} />}
          {!item.over && unknown.length > 0 && <ErrorNote message={`${unknown.join('；')}。请修正未知变量后再保存。`} />}
        </section>)}
        {contract && <section className="panel stack">
          <div className="section-title"><h3>接口固定契约</h3><span className="small muted">由后端固定，不可编辑；模型会连同上面的预览一起收到</span></div>
          <pre>{contract.instruction}</pre>
          <pre>{JSON.stringify(contract.schema, null, 2)}</pre>
        </section>}
        <div className="toolbar sticky-actions">
          <Button onClick={save} disabled={unknown.length > 0 || overLimit || (scope === 'project' && !project)}>保存</Button>
          {scope === 'project' && <Button variant="outline" onClick={promoteToGlobal}>把本作品的模板复制为全局默认</Button>}
          <span className="small muted">{scopeLabel}</span>
        </div>
      </div>
    </div>
  </div>;
}

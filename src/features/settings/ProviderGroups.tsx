import { useState, type ReactNode } from 'react';
import { Eye, EyeOff, Plus, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button, ErrorNote, Field } from '../../components/Ui';
import SearchSelect from '../../components/SearchSelect';
import { imageConcurrency } from '../../lib/models';
import {
  createCustomEndpoint, endpointsFor, modelFor, removeEndpoint, removedBuiltins, restoreEndpoint,
} from '../../lib/endpoints';
import { setKey, setSettings } from '../../store/studio';
import type { Capability, Endpoint, Settings, StudioState } from '../../domain/types';

const letterOf = (endpoint: Endpoint) => endpoint.name.trim().slice(0, 1).toUpperCase() || 'C';
const useOf = (endpoint: Endpoint) => {
  if (endpoint.use) return endpoint.use;
  if (endpoint.protocol === 'openai-compatible') return 'OpenAI 兼容服务 · 剧本与生图';
  const parts: string[] = [];
  if (endpoint.capabilities.includes('script')) parts.push('剧本生成');
  if (endpoint.capabilities.includes('image')) parts.push('人物、场景与参考图');
  if (endpoint.capabilities.includes('video')) parts.push('视频生成');
  return parts.join(' · ') || '模型服务';
};
const isFree = (endpoint: Endpoint) => endpoint.id === 'siliconflow';

type TabKey = 'script' | 'image' | 'video' | 'speech' | 'custom';

const TABS: { key: TabKey; title: string; description: string }[] = [
  { key: 'script', title: '剧本', description: '把一个想法写成可拍摄的完整漫剧剧本。可用 Gemini、DeepSeek，或你自己的 OpenAI 兼容服务。' },
  { key: 'image', title: '生图', description: '人物、场景与道具设定图。OpenAI、Seedream 按量付费；SiliconFlow 有免费额度；也可以填自己的端点。' },
  { key: 'video', title: '视频', description: '按分镜生成镜头视频。Seedance 首选，MiniMax H3 备选。' },
  { key: 'speech', title: '配音', description: '使用 MiniMax 语音合成，与视频共用同一个 Key，不需要重复填写。' },
  { key: 'custom', title: '自定义端点', description: '接入你自己的 OpenAI 兼容服务：填 Base URL 与 API Key 即可用于剧本与生图。Key 只留在本机内存。' },
];

function providerStatus(state: StudioState, id: string) {
  if (!state.keys[id]) return { text: 'Key 缺失', tag: 'tag', ready: false };
  const status = state.providerStatus[id]?.status;
  if (status === 'available') return { text: '可用', tag: 'tag success', ready: true };
  if (status === 'failed') return { text: '调用失败', tag: 'tag danger', ready: false };
  return { text: '已填写 · 待验证', tag: 'tag', ready: false };
}
function readyCount(state: StudioState, list: Endpoint[]) { return list.filter(endpoint => providerStatus(state, endpoint.id).ready).length; }

function KeyField({ endpoint, state, visible, onToggle }: { endpoint: Endpoint; state: StudioState; visible?: string; onToggle: (id: string) => void }) {
  return <Field label="API Key"><div className="password-input"><input autoComplete="off" type={visible === endpoint.id ? 'text' : 'password'} value={state.keys[endpoint.id] || ''} onChange={e => setKey(endpoint.id, e.target.value)} placeholder="在这里粘贴你的 API Key" spellCheck={false} /><button type="button" className="icon-button" aria-label={visible === endpoint.id ? '隐藏密钥' : '显示密钥'} onClick={() => onToggle(endpoint.id)}>{visible === endpoint.id ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></Field>;
}

/**
 * 端点行：一行看清「谁、干什么、Key 状态、用哪个模型」，
 * 点「设置」才展开填 Key 与模型 ID，避免设置页被拉成一长条。
 */
function EndpointRow({ endpoint, capability, modelText, state, visible, onToggle, onDelete, onChange, open, onToggleOpen, children }: {
  endpoint: Endpoint; capability?: Capability; modelText?: string; state: StudioState; visible?: string;
  onToggle: (id: string) => void; onDelete: (endpoint: Endpoint) => void; onChange?: (endpoint: Endpoint) => void;
  open: boolean; onToggleOpen: (id: string) => void; children?: ReactNode;
}) {
  const status = providerStatus(state, endpoint.id);
  const info = state.providerStatus[endpoint.id];
  const model = capability ? modelFor(state.settings, endpoint.id, capability) : '';
  const shown = modelText ?? model;
  return <section className="panel provider-panel provider-row">
    <div className="provider-row-head">
      <span className={`provider-logo ${endpoint.protocol}`}>{letterOf(endpoint)}</span>
      <div className="provider-row-title"><h2>{endpoint.name || '未命名端点'}</h2><p className="muted small">{useOf(endpoint)}</p></div>
      <div className="provider-row-meta">
        <span className={status.tag}>{status.text}</span>
        {info?.status === 'failed' && <span className="provider-row-error">{info.hint || info.error || '操作未完成，请重试。'}</span>}
        {shown && <span className="provider-row-model">{shown}</span>}
      </div>
      <div className="row wrap">
        <Button variant="ghost" size="sm" onClick={() => onToggleOpen(endpoint.id)}>{open ? '收起' : '设置'}</Button>
        <Button variant="ghost" size="sm" onClick={() => onDelete(endpoint)}><Trash2 size={14} />删除</Button>
      </div>
    </div>
    {open && <div className="provider-row-body">
      <p className="small muted"><span className={isFree(endpoint) ? 'badge-free' : 'badge-paid'}>{isFree(endpoint) ? '免费额度' : '按量付费'}</span>{isFree(endpoint) ? ' 免费渠道有速率限制，失败可换付费端点。' : ' 费用由平台按量计收。'}</p>
      {state.keys[endpoint.id] && info && (info.status === 'failed'
        ? <ErrorNote message={`最近调用：${info.model || info.action} · ${info.error || '操作未完成，请重试。'}`} hint={info.hint} />
        : <p className="small muted">最近调用：{info.model || info.action} · {info.error || '请求成功，不代表其他模型均已开通。'}</p>)}
      {children}
    </div>}
  </section>;
}

function BuiltinRow({ endpoint, capability, state, visible, onToggle, onDelete, open, onToggleOpen }: {
  endpoint: Endpoint; capability: Capability; state: StudioState; visible?: string;
  onToggle: (id: string) => void; onDelete: (endpoint: Endpoint) => void; open: boolean; onToggleOpen: (id: string) => void;
}) {
  const model = modelFor(state.settings, endpoint.id, capability);
  return <EndpointRow endpoint={endpoint} capability={capability} state={state} visible={visible} onToggle={onToggle} onDelete={onDelete} open={open} onToggleOpen={onToggleOpen}>
    <div className="grid-2">
      <KeyField endpoint={endpoint} state={state} visible={visible} onToggle={onToggle} />
      <Field label="模型 ID" hint="需要你的账号已经开通此模型；可填写官方提供的模型 ID。"><input value={model} onChange={e => setSettings({ ...state.settings, models: { ...state.settings.models, [endpoint.id]: { ...state.settings.models[endpoint.id], [capability]: e.target.value } } })} spellCheck={false} /></Field>
    </div>
  </EndpointRow>;
}

function CustomRow({ endpoint, state, visible, onToggle, onDelete, onChange, open, onToggleOpen }: {
  endpoint: Endpoint; state: StudioState; visible?: string; onToggle: (id: string) => void;
  onDelete: (endpoint: Endpoint) => void; onChange: (endpoint: Endpoint) => void; open: boolean; onToggleOpen: (id: string) => void;
}) {
  const models = state.settings.models[endpoint.id] ?? {};
  const summary = [models.script, models.image].filter(Boolean).join(' · ');
  const patch = (part: Partial<Endpoint>) => onChange({ ...endpoint, ...part });
  const toggleCapability = (capability: Capability) => {
    const next = endpoint.capabilities.includes(capability) ? endpoint.capabilities.filter(item => item !== capability) : [...endpoint.capabilities, capability];
    if (!next.length) return;
    patch({ capabilities: next });
  };
  return <EndpointRow endpoint={endpoint} modelText={summary || '未填模型'} state={state} visible={visible} onToggle={onToggle} onDelete={onDelete} open={open} onToggleOpen={onToggleOpen}>
    <div className="grid-2">
      <Field label="端点名称" hint="只在本机显示，方便区分多个自定义端点。"><input value={endpoint.name} onChange={e => patch({ name: e.target.value })} spellCheck={false} /></Field>
      <Field label="Base URL" hint="公网 https 地址，填到 API 根即可（例：https://api.example.com/v1）。不能带 IP、内网域名、端口或查询参数。"><input value={endpoint.baseUrl || ''} onChange={e => patch({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" spellCheck={false} /></Field>
    </div>
    <div className="grid-2">
      <KeyField endpoint={endpoint} state={state} visible={visible} onToggle={onToggle} />
      <Field label="承担环节" hint="勾选后它才会出现在对应环节的模型下拉里。自定义端点目前只支持剧本与生图。">
        <div className="row wrap"><label className="row"><input type="checkbox" checked={endpoint.capabilities.includes('script')} onChange={() => toggleCapability('script')} />剧本</label><label className="row"><input type="checkbox" checked={endpoint.capabilities.includes('image')} onChange={() => toggleCapability('image')} />生图</label></div>
      </Field>
    </div>
    {endpoint.capabilities.includes('script') && <Field label="文本模型 ID" hint="剧本、资产提取与导演分镜都用它。例：qwen-max、gpt-4o、deepseek-chat。"><input value={models.script || ''} onChange={e => setSettings({ ...state.settings, models: { ...state.settings.models, [endpoint.id]: { ...models, script: e.target.value } } })} spellCheck={false} /></Field>}
    {endpoint.capabilities.includes('image') && <Field label="生图模型 ID" hint="设定图用它。例：flux-1、kolors、gpt-image-1。"><input value={models.image || ''} onChange={e => setSettings({ ...state.settings, models: { ...state.settings.models, [endpoint.id]: { ...models, image: e.target.value } } })} spellCheck={false} /></Field>}
  </EndpointRow>;
}

function EndpointSelect({ settings, capability, value, onChange, label }: { settings: Settings; capability: Capability; value: string; onChange: (id: string) => void; label: string }) {
  const options = endpointsFor(settings, capability);
  return <div className="provider-group-select"><SearchSelect label={label} value={value} onChange={onChange} disabled={!options.length} placeholder="没有可用端点" options={options.map(endpoint => ({ value: endpoint.id, label: `${endpoint.name} · ${modelFor(settings, endpoint.id, capability) || '未填模型'}` }))} /></div>;
}

/** 上次停留的页签：同一会话内离开再回到设置页时，还停在原来那一栏。 */
let lastTab: TabKey = 'script';

export default function ProviderGroups({ state }: { state: StudioState }) {
  const [visible, setVisible] = useState<string>();
  const [tab, setTab] = useState<TabKey>(lastTab);
  const [openId, setOpenId] = useState<string>();
  const switchTab = (next: TabKey) => { lastTab = next; setTab(next); };
  const settings = state.settings;
  const toggle = (id: string) => setVisible(previous => previous === id ? undefined : id);
  const toggleOpen = (id: string) => setOpenId(previous => previous === id ? undefined : id);
  const update = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch });
  const customEndpoints = settings.endpoints.filter(endpoint => !endpoint.builtin);
  const removed = removedBuiltins(settings);
  const builtins = (capability: Capability) => settings.endpoints.filter(endpoint => endpoint.builtin && endpoint.capabilities.includes(capability));
  const scriptEndpoints = endpointsFor(settings, 'script');
  const imageEndpoints = endpointsFor(settings, 'image');
  const videoEndpoints = endpointsFor(settings, 'video');
  const speechEndpoints = endpointsFor(settings, 'speech');

  const deleteEndpoint = (endpoint: Endpoint) => {
    const next = removeEndpoint(settings, endpoint.id);
    setSettings(next);
    const dropped = [next.scriptProvider !== settings.scriptProvider && '剧本', next.imageProvider !== settings.imageProvider && '生图', next.videoProvider !== settings.videoProvider && '视频'].filter(Boolean);
    if (dropped.length) toast(`已删除「${endpoint.name}」，${dropped.join('、')}环节改用了其它端点；可在页面底部恢复。`);
    else toast(`已删除「${endpoint.name}」，可在页面底部恢复。`);
  };
  const addCustom = () => {
    const endpoint = createCustomEndpoint(`自定义端点 ${customEndpoints.length + 1}`);
    setSettings({ ...settings, endpoints: [...settings.endpoints, endpoint], models: { ...settings.models, [endpoint.id]: {} } });
    switchTab('custom');
    setOpenId(endpoint.id);
  };
  const changeCustom = (next: Endpoint) => setSettings({ ...settings, endpoints: settings.endpoints.map(endpoint => endpoint.id === next.id ? next : endpoint) });

  const counts: Record<TabKey, { ready: number; total: number }> = {
    script: { ready: readyCount(state, scriptEndpoints), total: scriptEndpoints.length },
    image: { ready: readyCount(state, imageEndpoints), total: imageEndpoints.length },
    video: { ready: readyCount(state, videoEndpoints), total: videoEndpoints.length },
    speech: { ready: speechEndpoints.length ? (providerStatus(state, speechEndpoints[0].id).ready ? 1 : 0) : 0, total: 1 },
    custom: { ready: readyCount(state, customEndpoints), total: customEndpoints.length },
  };
  const minimax = speechEndpoints[0];
  const minimaxStatus = minimax ? providerStatus(state, minimax.id) : undefined;
  const active = TABS.find(item => item.key === tab)!;

  return <div className="provider-groups">
    <div className="provider-tabs" role="tablist" aria-label="模型平台分组">
      {TABS.map(item => <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className="provider-tab" onClick={() => switchTab(item.key)}>
        {item.title}<span className="provider-tab-count">{counts[item.key].ready}/{counts[item.key].total}</span>
      </button>)}
    </div>

    <section className="provider-group" role="tabpanel" aria-label={active.title}>
      <p className="small muted provider-group-note">{active.description}</p>

      {tab === 'script' && <>
        <EndpointSelect settings={settings} capability="script" value={settings.scriptProvider} onChange={id => update({ scriptProvider: id })} label="剧本默认模型平台" />
        {builtins('script').map(endpoint => <BuiltinRow key={endpoint.id} endpoint={endpoint} capability="script" state={state} visible={visible} onToggle={toggle} onDelete={deleteEndpoint} open={openId === endpoint.id} onToggleOpen={toggleOpen} />)}
      </>}
      {tab === 'image' && <>
        <div className="provider-group-select"><Field label="生图并发（1–5）" hint="同时生成几张图；免费渠道默认 2，其余默认 3。"><select disabled={false} value={imageConcurrency(settings)} onChange={e => update({ imageConcurrency: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}</select></Field></div>
        <EndpointSelect settings={settings} capability="image" value={settings.imageProvider} onChange={id => update({ imageProvider: id })} label="生图默认模型平台" />
        {builtins('image').map(endpoint => <BuiltinRow key={endpoint.id} endpoint={endpoint} capability="image" state={state} visible={visible} onToggle={toggle} onDelete={deleteEndpoint} open={openId === endpoint.id} onToggleOpen={toggleOpen} />)}
      </>}
      {tab === 'video' && <>
        <EndpointSelect settings={settings} capability="video" value={settings.videoProvider} onChange={id => update({ videoProvider: id })} label="视频默认模型平台" />
        {builtins('video').map(endpoint => <BuiltinRow key={endpoint.id} endpoint={endpoint} capability="video" state={state} visible={visible} onToggle={toggle} onDelete={deleteEndpoint} open={openId === endpoint.id} onToggleOpen={toggleOpen} />)}
      </>}
      {tab === 'speech' && <>
        <div className="provider-ref"><span className={`status-dot ${minimaxStatus?.ready ? 'ready' : minimaxStatus?.tag.includes('danger') ? 'failed' : ''}`} /><span>共用 {minimax?.name ?? 'MiniMax'} Key · {settings.speechModel} · {minimaxStatus?.text ?? 'Key 缺失'}</span></div>
        <div className="provider-group-select"><Field label="配音模型 ID"><input value={settings.speechModel} onChange={e => update({ speechModel: e.target.value })} spellCheck={false} /></Field></div>
      </>}
      {tab === 'custom' && <>
        <div className="provider-group-select"><label className="row"><input type="checkbox" checked={settings.customJsonMode !== false} onChange={e => update({ customJsonMode: e.target.checked })} />严格 JSON 模式（发送 response_format，老中转站不支持时关掉）</label></div>
        <div className="toolbar"><Button variant="secondary" size="sm" onClick={addCustom}><Plus size={14} />添加自定义端点</Button></div>
        {customEndpoints.length ? customEndpoints.map(endpoint => <CustomRow key={endpoint.id} endpoint={endpoint} state={state} visible={visible} onToggle={toggle} onDelete={deleteEndpoint} onChange={changeCustom} open={openId === endpoint.id} onToggleOpen={toggleOpen} />)
          : <p className="muted small">还没有自定义端点。点上面的按钮添加一个，填上 Base URL 与 API Key 就能用。</p>}
      </>}
    </section>

    {removed.length > 0 && <section className="provider-group" aria-labelledby="provider-group-removed">
      <header className="provider-group-head"><div><h2 id="provider-group-removed">已删除的内置平台</h2><p className="muted">删掉的平台可以随时恢复，它改过的模型 ID 也会一并回来。</p></div></header>
      <div className="provider-group-body">{removed.map(endpoint => <div className="provider-ref" key={endpoint.id}><span>{endpoint.name}</span><Button variant="ghost" size="sm" onClick={() => setSettings(restoreEndpoint(settings, endpoint.id))}><Undo2 size={14} />恢复</Button></div>)}</div>
    </section>}
  </div>;
}

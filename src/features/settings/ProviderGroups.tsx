import { useState, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { ErrorNote, Field } from '../../components/Ui';
import { setKey, setSettings } from '../../store/studio';
import type { Provider, StudioState } from '../../domain/types';

type ProviderMeta = { id: Provider; name: string; use: string; letter: string; badge: 'paid' | 'free' };

const scriptProviders: ProviderMeta[] = [
  { id: 'gemini', name: 'Google Gemini', use: '剧本生成 · 首选', letter: 'G', badge: 'paid' },
  { id: 'deepseek', name: 'DeepSeek', use: '剧本生成 · 备选', letter: 'D', badge: 'paid' },
];
const imageProviders: ProviderMeta[] = [
  { id: 'openai', name: 'OpenAI', use: '人物、场景与参考图', letter: 'O', badge: 'paid' },
  { id: 'seedream', name: '火山引擎 / 即梦 · Seedream', use: '人物、场景与参考图 · 需要火山方舟 Key', letter: 'I', badge: 'paid' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow · 免费生图', use: 'Kolors · 免费额度，国内直连', letter: 'F', badge: 'free' },
];
const videoProviders: ProviderMeta[] = [
  { id: 'seedance', name: '火山引擎 Seedance', use: '视频生成 · 首选', letter: 'S', badge: 'paid' },
  { id: 'minimax', name: 'MiniMax 国内版', use: 'H3 视频 · 中文配音 · 仅支持国内开放平台 Key', letter: 'M', badge: 'paid' },
];

function providerStatus(state: StudioState, id: Provider) {
  if (!state.keys[id]) return { text: 'Key 缺失', tag: 'tag', ready: false };
  const status = state.providerStatus[id]?.status;
  if (status === 'available') return { text: '可用', tag: 'tag success', ready: true };
  if (status === 'failed') return { text: '调用失败', tag: 'tag danger', ready: false };
  return { text: '已填写 · 待验证', tag: 'tag', ready: false };
}
function readyCount(state: StudioState, list: ProviderMeta[]) { return list.filter(meta => providerStatus(state, meta.id).ready).length; }

function ProviderPanel({ meta, state, visible, onToggle }: { meta: ProviderMeta; state: StudioState; visible?: string; onToggle: (id: Provider) => void }) {
  const status = providerStatus(state, meta.id);
  const info = state.providerStatus[meta.id];
  return <section className="panel provider-panel">
    <div className="row between">
      <div className="row"><span className={`provider-logo ${meta.id}`}>{meta.letter}</span><div><h2>{meta.name}</h2><p className="muted small">{meta.use}</p></div></div>
      <div className="row wrap"><span className={meta.badge === 'free' ? 'badge-free' : 'badge-paid'}>{meta.badge === 'free' ? '免费' : '按量付费'}</span><span className={status.tag}>{status.text}</span></div>
    </div>
    {state.keys[meta.id] && info && (info.status === 'failed'
      ? <ErrorNote message={`最近调用：${info.model || info.action} · ${info.error || '操作未完成，请重试。'}`} hint={info.hint} />
      : <p className="small muted">最近调用：{info.model || info.action} · {info.error || '请求成功，不代表其他模型均已开通。'}</p>)}
    <div className="grid-2">
      <Field label="API Key"><div className="password-input"><input autoComplete="off" type={visible === meta.id ? 'text' : 'password'} value={state.keys[meta.id] || ''} onChange={e => setKey(meta.id, e.target.value)} placeholder="在这里粘贴你的 API Key" spellCheck={false} /><button type="button" className="icon-button" aria-label={visible === meta.id ? '隐藏密钥' : '显示密钥'} onClick={() => onToggle(meta.id)}>{visible === meta.id ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></Field>
      <Field label="模型 ID" hint="需要你的账号已经开通此模型；可填写官方提供的模型 ID。"><input value={state.settings.models[meta.id]} onChange={e => setSettings({ ...state.settings, models: { ...state.settings.models, [meta.id]: e.target.value } })} spellCheck={false} /></Field>
    </div>
    {meta.id === 'minimax' && <Field label="配音模型 ID"><input value={state.settings.speechModel} onChange={e => setSettings({ ...state.settings, speechModel: e.target.value })} /></Field>}
  </section>;
}

function GroupCard({ id, title, description, badges, ready, total, children }: { id: string; title: string; description: string; badges: ('paid' | 'free')[]; ready: number; total: number; children: ReactNode }) {
  return <section className="provider-group" aria-labelledby={`provider-group-${id}`}>
    <header className="provider-group-head">
      <div><h2 id={`provider-group-${id}`}>{title}</h2><p className="muted">{description}</p></div>
      <div className="row wrap">{badges.map(badge => <span key={badge} className={badge === 'free' ? 'badge-free' : 'badge-paid'}>{badge === 'free' ? '免费' : '按量付费'}</span>)}<span className="muted small">已就绪 {ready} / {total}</span></div>
    </header>
    {children}
  </section>;
}

export default function ProviderGroups({ state }: { state: StudioState }) {
  const [visible, setVisible] = useState<string>();
  const toggle = (id: Provider) => setVisible(previous => previous === id ? undefined : id);
  const renderPanels = (list: ProviderMeta[]) => <div className="provider-group-body">{list.map(meta => <ProviderPanel key={meta.id} meta={meta} state={state} visible={visible} onToggle={toggle} />)}</div>;
  const minimax = providerStatus(state, 'minimax');
  return <div className="provider-groups">
    <GroupCard id="script" title="剧本" description="把一个想法写成可拍摄的 10 拍脚本。Gemini 首选，DeepSeek 备选。" badges={['paid']} ready={readyCount(state, scriptProviders)} total={scriptProviders.length}>
      <div className="provider-group-select"><Field label="剧本默认模型平台"><select value={state.settings.scriptProvider} onChange={e => setSettings({ ...state.settings, scriptProvider: e.target.value as 'gemini' | 'deepseek' })}><option value="gemini">Gemini · 首选</option><option value="deepseek">DeepSeek · 备选</option></select></Field></div>
      {renderPanels(scriptProviders)}
    </GroupCard>
    <GroupCard id="image" title="生图" description="人物、场景与道具设定图。OpenAI、Seedream 按量付费；SiliconFlow 有免费额度。" badges={['paid', 'free']} ready={readyCount(state, imageProviders)} total={imageProviders.length}>
      {renderPanels(imageProviders)}
    </GroupCard>
    <GroupCard id="video" title="视频" description="按分镜生成镜头视频。Seedance 首选，MiniMax H3 备选。" badges={['paid']} ready={readyCount(state, videoProviders)} total={videoProviders.length}>
      <div className="provider-group-select"><Field label="视频默认模型平台"><select value={state.settings.videoProvider} onChange={e => setSettings({ ...state.settings, videoProvider: e.target.value as 'seedance' | 'minimax' })}><option value="seedance">Seedance</option><option value="minimax">MiniMax 国内版 · H3</option></select></Field></div>
      {renderPanels(videoProviders)}
    </GroupCard>
    <GroupCard id="speech" title="配音" description="使用 MiniMax 语音合成，与视频共用同一个 Key，不需要重复填写。" badges={['paid']} ready={minimax.ready ? 1 : 0} total={1}>
      <div className="provider-ref"><span className={`status-dot ${minimax.ready ? 'ready' : minimax.tag.includes('danger') ? 'failed' : ''}`} /><span>共用 MiniMax Key · {state.settings.speechModel} · {minimax.text}</span></div>
    </GroupCard>
  </div>;
}

import { KeyRound, ShieldCheck, Trash2, ExternalLink, FileText } from 'lucide-react';
import { clearKeys, useStudio } from '../../store/studio';
import { Button } from '../../components/Ui';
import { toast } from 'sonner';
import ProviderGroups from './ProviderGroups';
import TemplateEditorPage, { type TemplateScope, type TemplateTab } from '../prompts/TemplateEditorPage';

const TEMPLATE_TAB_IDS: TemplateTab[] = ['script', 'assets', 'director', 'image', 'video'];

/**
 * 设置页的路由是 hash 制的：
 * `#/settings` 是连接模型，`#/settings/templates` 是提示词模板；
 * 模板页还能带 `?kind=script&scope=project`，供流程页直接跳到对应步骤。
 */
function readRoute(): { tab: 'connections' | 'templates'; kind: TemplateTab; scope: TemplateScope } {
  const raw = location.hash.replace('#/', '');
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query ?? '');
  const kind = params.get('kind');
  return {
    tab: path.startsWith('settings/templates') ? 'templates' : 'connections',
    kind: TEMPLATE_TAB_IDS.includes(kind as TemplateTab) ? (kind as TemplateTab) : 'script',
    scope: params.get('scope') === 'project' ? 'project' : 'global',
  };
}

export default function SettingsPage() {
  const state = useStudio();
  const project = state.projects.find(item => item.id === state.activeId);
  const route = readRoute();
  const scope = project ? route.scope : 'global';

  return <div className="stack">
    <div className="page-heading"><div><h1>{route.tab === 'templates' ? '提示词模板' : '连接你的创作能力'}</h1><p className="muted">{route.tab === 'templates' ? '模板是写给模型的规则。默认全局共用一部作品，需要时单部作品可以单独覆盖某一步。' : '填入你自己的 API Key，按需连接模型。不填也可以编辑、演练与手动制作。'}</p></div>{route.tab === 'templates' ? <FileText className="muted" size={32}/> : <KeyRound className="muted" size={32}/>}</div>
    <div className="tabs-row" role="tablist" aria-label="设置页分类">
      <button type="button" role="tab" aria-selected={route.tab !== 'templates'} className={route.tab !== 'templates' ? 'active' : ''} onClick={() => { location.hash = '/settings'; }}>连接模型</button>
      <button type="button" role="tab" aria-selected={route.tab === 'templates'} className={route.tab === 'templates' ? 'active' : ''} onClick={() => { location.hash = '/settings/templates'; }}>提示词模板</button>
    </div>
    {route.tab === 'templates'
      ? <TemplateEditorPage key={location.hash} project={project} initialScope={scope} initialKind={route.kind} />
      : <>
        <div className="notice"><ShieldCheck size={22}/><div><strong>密钥不写进作品，也不保存到磁盘</strong><p>Key 只留在当前页面内存，刷新后需要重新填写；Base URL、端点名称与模型 ID 属于作品配置，只保存在本机浏览器。</p></div></div>
        <ProviderGroups state={state} />
        <div className="panel row between wrap"><div><h3>只保存必要的创作数据</h3><p className="muted small">文字与进度保存在浏览器；图片和配音存在本机，视频仅保存链接与文件名。</p></div><Button variant="secondary" onClick={()=>{clearKeys();toast.success('所有 Key 已从当前页面清除');}}><Trash2 size={16}/>清除全部 Key</Button></div><p className="small muted row"><ExternalLink size={13}/>每次生成都会先确认任务；产生的费用由对应模型平台计收。</p>
      </>}
  </div>;
}

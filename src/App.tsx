import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react';
import { Clapperboard, FileText, FolderOpen, HardDrive, MessagesSquare, Settings2, ChevronRight } from 'lucide-react';
import { Toaster } from 'sonner';
import { SidebarProvider, Sidebar, SidebarContent, SidebarHeader, SidebarFooter, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { useStudio, selectSeries, selectEpisode } from './store/studio';
import { findEpisode } from './domain/series';
import { useJobs } from './store/jobs';
import ProjectsPage from './features/projects/ProjectsPage';
import SeriesPage from './features/projects/SeriesPage';
import ChatPage from './features/chat/ChatPage';
import EpisodePage from './features/episode/EpisodePage';
import { Button, Empty, HelpPopover } from './components/Ui';
import JobTray from './components/JobTray';

const settingsPages = {
  models: lazy(() => import('./features/settings/ModelsPage')),
  templates: lazy(() => import('./features/prompts/TemplatesPage')),
};
/** 路由只剩三处：聊天室、作品集（含系列页与剧集页）、设置。 */
const navigation = [
  { id: 'chat', title: '聊天室', icon: MessagesSquare },
  { id: 'library', title: '作品集', icon: FolderOpen },
] as const;

function readRoute(): string { return location.hash.replace('#/', ''); }

/**
 * 路由解析：`chat` / `library` / `library/<seriesId>` / `library/<seriesId>/<episodeId>` / `settings[/templates]`。
 * 未知路由落回聊天室——它就是主页。
 */
function parseRoute(route: string) {
  const [head, second, third] = route.split('?')[0].split('/');
  if (head === 'library') return { page: 'library' as const, seriesId: second || undefined, episodeId: third || undefined };
  if (head === 'settings') return { page: 'settings' as const, templates: route.startsWith('settings/templates') };
  return { page: 'chat' as const };
}

const fallback = <div role="status" className="panel muted">正在载入…</div>;

function Studio() {
  const state = useStudio();
  const [route, setRoute] = useState<string>(readRoute);
  const parsed = parseRoute(route);
  const { setOpenMobile } = useSidebar();
  const { jobs } = useJobs();

  const series = parsed.page === 'library' && parsed.seriesId
    ? state.series.find(item => item.id === parsed.seriesId)
    : undefined;
  const episode = series && parsed.episodeId ? findEpisode(series, parsed.episodeId) : undefined;

  // 深链直接打开时，把「当前系列/集」同步进 store，页面里的相对操作才有落点。
  useEffect(() => {
    if (series && state.activeSeriesId !== series.id) selectSeries(series.id);
    if (episode && state.activeEpisodeId !== episode.id) selectEpisode(episode.id);
  }, [series?.id, episode?.id, state.activeSeriesId, state.activeEpisodeId]);

  useEffect(() => { const listener = () => setRoute(readRoute()); window.addEventListener('hashchange', listener); return () => window.removeEventListener('hashchange', listener); }, []);
  useEffect(() => { const running = jobs.some(job => job.status === 'running' || job.status === 'queued'); if (!running) return; const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [jobs]);

  function go(next: string) { location.hash = `/${next}`; setRoute(next); setOpenMobile(false); window.scrollTo({ top: 0, behavior: 'instant' }); }
  const settingsPage = parsed.page === 'settings' ? (parsed.templates ? 'templates' : 'models') : null;
  const SettingsPage = settingsPage ? settingsPages[settingsPage] : null;

  const crumbs = parsed.page === 'chat' ? ['聊天室']
    : parsed.page === 'settings' ? ['设置', settingsPage === 'templates' ? '提示词模板' : '模型配置']
      : series ? [series.name, ...(episode ? [episode.title || `第${episode.number}集`] : [])] : ['作品集'];

  return <>
    <Sidebar>
      <SidebarHeader>
        <button className="brand" onClick={() => go('chat')}>
          <span className="brand-mark"><Clapperboard size={24} strokeWidth={1.7} /></span>
          <span>漫剧工坊<small>MANJU STUDIO</small></span>
        </button>
      </SidebarHeader>
      <SidebarContent>
        <div className="sidebar-section-label">创作空间</div>
        {navigation.map(item => <button key={item.id} className={`nav-item ${parsed.page === item.id ? 'active' : ''}`} onClick={() => go(item.id)}>
          <item.icon size={19} />{item.title}
          {item.id === 'library' && <span className="nav-count">{state.series.length}</span>}
        </button>)}
        {series && <div className="sidebar-episode-list">
          <div className="sidebar-section-label">当前系列</div>
          {series.episodes.map(item => <button key={item.id} className={`nav-item nav-sub ${episode?.id === item.id ? 'active' : ''}`} onClick={() => go(`library/${series.id}/${item.id}`)}>
            <span className="episode-dot" />第{item.number}集 {item.title || '未命名'}
          </button>)}
        </div>}
      </SidebarContent>
      <SidebarFooter>
        <button className={`nav-item ${settingsPage === 'models' ? 'active' : ''}`} onClick={() => go('settings')}><Settings2 size={18} />模型配置</button>
        <button className={`nav-item ${settingsPage === 'templates' ? 'active' : ''}`} onClick={() => go('settings/templates')}><FileText size={18} />提示词模板</button>
        <div className="local-status"><span className="status-dot" /><span>本地创作空间</span><span className="version-label">BETA</span></div>
      </SidebarFooter>
    </Sidebar>

    <main className="workspace">
      <header className="topbar">
        <div className="row topbar-trail">
          <SidebarTrigger className="mobile-menu" aria-label="打开导航" />
          <span className="muted small breadcrumb-root">工作空间</span>
          {crumbs.map((crumb, index) => <span key={`${crumb}-${index}`} className="row tight">
            <ChevronRight size={14} className="muted breadcrumb-root" />
            {index === crumbs.length - 1 ? <span className="small">{crumb}</span> : <button className="text-button small breadcrumb-project" onClick={() => go(index === 0 && parsed.page === 'library' ? 'library' : `library/${parsed.seriesId}`)}>{crumb}</button>}
          </span>)}
        </div>
        <div className="row topbar-actions">
          <span className="saved-label" title="作品自动保存在此浏览器中。视频文件仅供本次预览，记得及时导出。"><HardDrive size={14} />{state.storageError ? '尚未保存' : '本地自动保存'}</span>
          <HelpPopover label="使用说明" title="新流程">聊天室里写小说、生剧本、生分镜 JSON；把 JSON 导入某一集，再到分镜表里生成视频。</HelpPopover>
          <button className="avatar" onClick={() => go('settings')} aria-label="打开模型配置">创</button>
        </div>
      </header>
      <div className="workspace-content">
        {state.storageError && <div role="alert" className="alert">{state.storageError}</div>}
        {parsed.page === 'chat' && <ChatPage navigate={go} />}
        {parsed.page === 'settings' && (SettingsPage
          ? <Suspense fallback={fallback}><SettingsPage /></Suspense>
          : <Empty title="设置页不存在" text="请从左侧进入模型配置或提示词模板。" />)}
        {parsed.page === 'library' && (!parsed.seriesId
          ? <ProjectsPage navigate={go} />
          : !series
            ? <Empty title="系列不存在" text="它可能已被删除。"><Button onClick={() => go('library')}>返回作品集</Button></Empty>
            : !parsed.episodeId
              ? <SeriesPage series={series} navigate={go} />
              : !episode
                ? <Empty title="这一集不存在" text="它可能已被删除。"><Button onClick={() => go(`library/${series.id}`)}>返回系列</Button></Empty>
                : <EpisodePage key={episode.id} series={series} episode={episode} navigate={go} />)}
      </div>
    </main>
    <JobTray />
    <Toaster theme="dark" position="top-center" richColors closeButton />
  </>;
}

export default function App() {
  return <SidebarProvider style={{ '--sidebar-width': '240px' } as CSSProperties}><Studio /></SidebarProvider>;
}
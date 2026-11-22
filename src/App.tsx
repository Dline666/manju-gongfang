import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react';
import { BookOpen, Boxes, Clapperboard, Film, FolderOpen, Settings2, Sparkles, ChevronRight, Check, HardDrive, ArrowLeft } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { SidebarProvider, Sidebar, SidebarContent, SidebarHeader, SidebarFooter, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { useStudio } from './store/studio';
import { useJobs } from './store/jobs';
import ProjectsPage from './features/projects/ProjectsPage';
import SettingsPage from './features/settings/SettingsPage';
import { Button, Empty, HelpPopover } from './components/Ui';
import JobTray from './components/JobTray';
import type { Stage } from './domain/types';
const pages = {
  script: lazy(() => import('./features/script/ScriptPage')),
  assets: lazy(() => import('./features/assets/AssetsPage')),
  storyboard: lazy(() => import('./features/storyboard/StoryboardPage')),
  generation: lazy(() => import('./features/generation/GenerationPage')),
  export: lazy(() => import('./features/export/ExportPage')),
};
const navigation = [{ id: 'script', title: '写剧本', icon: BookOpen }, { id:'assets', title:'建资产',icon:Boxes },{id:'storyboard',title:'做分镜',icon:Clapperboard},{id:'generation',title:'生成视频',icon:Sparkles},{id:'export',title:'成片与导出',icon:Film}] as const;
function readStage():Stage { const route=location.hash.replace('#/','');return ['library','script','assets','storyboard','generation','export','settings'].includes(route)?route as Stage:'library'; }
function Studio() {
  const state=useStudio();const [stage,setStage]=useState<Stage>(readStage);const {setOpenMobile}=useSidebar();
  const project=state.projects.find(p=>p.id===state.activeId);
  const {jobs}=useJobs();
  useEffect(()=>{const running=jobs.some(job=>job.status==='running'||job.status==='queued');if(!running)return;const handler=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[jobs]);
  useEffect(()=>{const listener=()=>setStage(readStage());window.addEventListener('hashchange',listener);return()=>window.removeEventListener('hashchange',listener);},[]);
  function navigate(next:Stage){location.hash=`/${next}`;setStage(next);setOpenMobile(false);window.scrollTo({top:0,behavior:'instant'});}
  const working=stage!=='library'&&stage!=='settings';
  const Page = stage !== 'library' && stage !== 'settings' ? pages[stage] : null;
  const currentStep=stage==='export'?3:navigation.findIndex(n=>n.id===stage);
  const pageTitle=stage==='library'?'作品库':stage==='settings'?'模型设置':navigation.find(n=>n.id===stage)?.title;
  return <><Sidebar><SidebarHeader><button className="brand" onClick={()=>navigate('library')}><span className="brand-mark"><Clapperboard size={24} strokeWidth={1.7}/></span><span>漫剧工坊<small>MANJU STUDIO</small></span></button></SidebarHeader><SidebarContent><div className="sidebar-section-label">创作空间</div><button className={`nav-item ${stage==='library'?'active':''}`} onClick={()=>navigate('library')}><FolderOpen size={19}/>作品库<span className="nav-count">{state.projects.length}</span></button><div className="sidebar-section-label workflow-label">制作流程</div>{navigation.map((item,index)=><button key={item.id} className={`nav-item ${stage===item.id?'active':''}`} onClick={()=>{if(!project){toast('先新建或打开一个作品，再开始创作');navigate('library');}else navigate(item.id);}}><item.icon size={19}/>{item.title}<span className="nav-order">0{Math.min(index+1,4)}</span></button>)}</SidebarContent><SidebarFooter><button className={`nav-item ${stage==='settings'?'active':''}`} onClick={()=>navigate('settings')}><Settings2 size={18}/>模型与设置</button><div className="local-status"><span className="status-dot"/><span>本地创作空间</span><span className="version-label">BETA</span></div></SidebarFooter></Sidebar>
    <main className="workspace"><header className="topbar"><div className="row topbar-trail"><SidebarTrigger className="mobile-menu" aria-label="打开导航"/><span className="muted small breadcrumb-root">工作空间</span><ChevronRight size={14} className="muted breadcrumb-root"/>{working&&project&&<><button className="text-button breadcrumb-project" onClick={()=>navigate('library')}>{project.name}</button><ChevronRight size={14} className="muted"/></>}<span className="small">{pageTitle}</span></div><div className="row topbar-actions"><span className="saved-label" title="作品自动保存在此浏览器中。视频文件仅供本次预览，记得及时导出你的创作。"><HardDrive size={14}/>{state.storageError?'尚未保存':'本地自动保存'}</span><HelpPopover label="使用说明" title="使用说明">依次完成剧本、资产、分镜和视频。没有 Key 也能用模板演练，手动导入素材。</HelpPopover><button className="avatar" onClick={()=>navigate('settings')} aria-label="打开模型设置">创</button></div></header>
      <div className="workspace-content">{state.storageError&&<div role="alert" className="alert">{state.storageError}</div>}{working&&project&&<><div className="project-heading"><button className="text-button muted row" onClick={()=>navigate('library')}><ArrowLeft size={15}/>返回作品库</button><span className="tag">{project.source==='template'?'模板演练 · 非 AI 生成':'独立作品'}</span></div><nav className="step-bar" aria-label="制作步骤">{navigation.slice(0,4).map((item,index)=><button className={`step ${currentStep===index?'current':''} ${currentStep>index?'past':''}`} key={item.id} onClick={()=>navigate(item.id)} aria-current={currentStep===index?'step':undefined}><span className="step-index">{currentStep>index?<Check size={14}/>:index+1}</span><span>{item.title}</span>{index<3&&<span className="step-line"/>}</button>)}</nav></>}
      {stage==='library'?<ProjectsPage navigate={navigate}/>:stage==='settings'?<SettingsPage/>:!project?<Empty title="先选择一个作品" text="每部作品都有独立的剧本、资产、镜头和成片。"><Button onClick={()=>navigate('library')}>返回作品库</Button></Empty>:Page&&<Suspense fallback={<div role="status" className="panel muted">正在载入创作工具…</div>}><Page key={project.id} project={project} navigate={navigate}/></Suspense>}
      </div>
    </main><JobTray/><Toaster theme="dark" position="top-center" richColors closeButton/></>;
}
export default function App(){return <SidebarProvider style={{'--sidebar-width':'240px'} as CSSProperties}><Studio/></SidebarProvider>;}

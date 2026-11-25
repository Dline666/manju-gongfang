import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react';
import { BookOpen, Boxes, Clapperboard, Film, FolderOpen, Settings2, FileText, Sparkles, ChevronRight, Check, HardDrive, Video } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { SidebarProvider, Sidebar, SidebarContent, SidebarHeader, SidebarFooter, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { useStudio } from './store/studio';
import { useJobs } from './store/jobs';
import ProjectsPage from './features/projects/ProjectsPage';
import { Button, Empty, HelpPopover } from './components/Ui';
import JobTray from './components/JobTray';
import type { Stage } from './domain/types';
import { canEnter, flowLabels, stageRequirement, type FlowStage } from './domain/flow';
const pages = {
  script: lazy(() => import('./features/script/ScriptPage')),
  assets: lazy(() => import('./features/assets/AssetsPage')),
  director: lazy(() => import('./features/director/DirectorPage')),
  storyboard: lazy(() => import('./features/storyboard/StoryboardPage')),
  generation: lazy(() => import('./features/generation/GenerationPage')),
  export: lazy(() => import('./features/export/ExportPage')),
};
// 模型配置与提示词模板是两个独立页面：各自独占整页宽度、各自保存，互不混杂。
const settingsPages = {
  models: lazy(() => import('./features/settings/ModelsPage')),
  templates: lazy(() => import('./features/prompts/TemplatesPage')),
};
const navigation = [{ id: 'script', title: '写剧本', icon: BookOpen }, { id:'director',title:'导演分镜',icon:Video},{id:'assets',title:'建资产',icon:Boxes},{id:'storyboard',title:'做分镜',icon:Clapperboard},{id:'generation',title:'生成视频',icon:Sparkles},{id:'export',title:'成片与导出',icon:Film}] as const;
const flowOf: Partial<Record<Stage, FlowStage>> = { script: 'script', assets: 'assets', director: 'director', storyboard: 'storyboard', generation: 'video', export: 'video' };
const stageOf: Record<FlowStage, Stage> = { script: 'script', assets: 'assets', director: 'director', storyboard: 'storyboard', video: 'generation' };
// 路由是 hash 制的，状态里存完整路由（含 ?kind=…&scope=project 这类深链参数）：
// 只存到 stage 的话，同页更换查询参数的深链会被 React 的「值没变」优化吞掉，
// 模板页不会重新读 URL。stageOfRoute 只看路径第一段。
function readRoute():string { return location.hash.replace('#/',''); }
function stageOfRoute(route:string):Stage { const head=route.split('/')[0].split('?')[0];return ['library','script','assets','director','storyboard','generation','export','settings'].includes(head)?head as Stage:'library'; }
const fallback = <div role="status" className="panel muted">正在载入…</div>;
function Studio() {
  const state=useStudio();const [route,setRoute]=useState<string>(readRoute);const stage=stageOfRoute(route);const {setOpenMobile}=useSidebar();
  const project=state.projects.find(p=>p.id===state.activeId);
  const {jobs}=useJobs();
  useEffect(()=>{const running=jobs.some(job=>job.status==='running'||job.status==='queued');if(!running)return;const handler=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[jobs]);
  useEffect(()=>{const listener=()=>setRoute(readRoute());window.addEventListener('hashchange',listener);return()=>window.removeEventListener('hashchange',listener);},[]);
  function go(next:string){location.hash=`/${next}`;setRoute(next);setOpenMobile(false);window.scrollTo({top:0,behavior:'instant'});}
  function navigate(next:Stage){go(next);}
  const working=stage!=='library'&&stage!=='settings';
  const Page = working ? pages[stage as keyof typeof pages] : null;
  const settingsPage = stage==='settings' ? (route.startsWith('settings/templates') ? 'templates' : 'models') : null;
  const SettingsPage = settingsPage ? settingsPages[settingsPage] : null;
  const currentStep=stage==='export'?5:navigation.slice(0,5).findIndex(n=>n.id===stage);
  const allowed=(id:Stage)=>{ const flow=flowOf[id]; return !project || !flow || canEnter(project, flow); };
  const openStage=(id:Stage)=>{ if(allowed(id)){navigate(id);return;} const flow=flowOf[id]; const requirement=flow&&stageRequirement(flow); const label=requirement?flowLabels[requirement]:'上一步'; toast(`先确认：${label}`,{action:{label:'去确认',onClick:()=>navigate(requirement?stageOf[requirement]:'script')}}); };
  const pageTitle=stage==='library'?'作品库':stage==='settings'?(settingsPage==='templates'?'提示词模板':'模型配置'):navigation.find(n=>n.id===stage)?.title;
  // 步骤条：所有制作页共用同一个位置——内容区顶部、页面标题之上，随内容滚动，不吸顶。
  const stepNav=<nav className="step-inline" aria-label="制作步骤">{navigation.slice(0,5).map((item,index)=><button key={item.id} type="button" className={`step-chip ${currentStep===index?'current':''} ${currentStep>index?'past':''} ${allowed(item.id)?'':'locked'}`} onClick={()=>openStage(item.id)} aria-current={currentStep===index?'step':undefined}><span className="step-chip-index">{currentStep>index?<Check size={12}/>:index+1}</span><span className="step-chip-label">{item.title}</span></button>)}</nav>;
  return <><Sidebar><SidebarHeader><button className="brand" onClick={()=>navigate('library')}><span className="brand-mark"><Clapperboard size={24} strokeWidth={1.7}/></span><span>漫剧工坊<small>MANJU STUDIO</small></span></button></SidebarHeader><SidebarContent><div className="sidebar-section-label">创作空间</div><button className={`nav-item ${stage==='library'?'active':''}`} onClick={()=>navigate('library')}><FolderOpen size={19}/>作品库<span className="nav-count">{state.projects.length}</span></button><div className="sidebar-section-label workflow-label">制作流程</div>{navigation.map((item,index)=><button key={item.id} className={`nav-item ${stage===item.id?'active':''} ${allowed(item.id)?'':'nav-locked'}`} onClick={()=>{if(!project){toast('先新建或打开一个作品，再开始创作');navigate('library');}else openStage(item.id);}}><item.icon size={19}/>{item.title}{index<5&&<span className="nav-order">0{index+1}</span>}</button>)}</SidebarContent><SidebarFooter><button className={`nav-item ${settingsPage==='models'?'active':''}`} onClick={()=>go('settings')}><Settings2 size={18}/>模型配置</button><button className={`nav-item ${settingsPage==='templates'?'active':''}`} onClick={()=>go('settings/templates')}><FileText size={18}/>提示词模板</button><div className="local-status"><span className="status-dot"/><span>本地创作空间</span><span className="version-label">BETA</span></div></SidebarFooter></Sidebar>
    <main className="workspace"><header className="topbar"><div className="row topbar-trail"><SidebarTrigger className="mobile-menu" aria-label="打开导航"/><span className="muted small breadcrumb-root">工作空间</span><ChevronRight size={14} className="muted breadcrumb-root"/>{working&&project&&<><button className="text-button breadcrumb-project" onClick={()=>navigate('library')}>{project.name}</button><ChevronRight size={14} className="muted"/></>}<span className="small">{pageTitle}</span>{working&&project&&<span className="tag subtle source-tag">{project.source==='template'?'模板演练 · 非 AI 生成':'独立作品'}</span>}</div><div className="row topbar-actions"><span className="saved-label" title="作品自动保存在此浏览器中。视频文件仅供本次预览，记得及时导出你的创作。"><HardDrive size={14}/>{state.storageError?'尚未保存':'本地自动保存'}</span><HelpPopover label="使用说明" title="使用说明">依次完成剧本、资产、导演、分镜和视频。没有 Key 也能用模板演练，手动导入素材。</HelpPopover><button className="avatar" onClick={()=>go('settings')} aria-label="打开模型配置">创</button></div></header>
      <div className="workspace-content">{state.storageError&&<div role="alert" className="alert">{state.storageError}</div>}
      {working&&project&&<div className="stage-strip">{stepNav}</div>}
      {stage==='library'?<ProjectsPage navigate={navigate}/>:SettingsPage?<Suspense fallback={fallback}><SettingsPage/></Suspense>:!project?<Empty title="先选择一个作品" text="每部作品都有独立的剧本、资产、镜头和成片。"><Button onClick={()=>navigate('library')}>返回作品库</Button></Empty>:Page&&<Suspense fallback={fallback}><Page key={project.id} project={project} navigate={navigate}/></Suspense>}
      </div>
    </main><JobTray/><Toaster theme="dark" position="top-center" richColors closeButton/></>;
}
export default function App(){return <SidebarProvider style={{'--sidebar-width':'240px'} as CSSProperties}><Studio/></SidebarProvider>;}

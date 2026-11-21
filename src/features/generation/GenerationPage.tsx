import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Copy, Download, Film, Link2, Mic, Play, RefreshCw, Upload, WandSparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { Asset, PageProps, Project, Shot, VideoTask } from '../../domain/types';
import { getStudio, setSettings, updateProject, useStudio } from '../../store/studio';
import { blobDataUrl, getMedia, mediaDuration, putMedia, releaseVideo, setVideo, useMediaUrl, useVideo } from '../../store/media';
import { ApiError, callApi, callBinary, credentials, errorMessage } from '../../lib/api';
import { videoPrompt } from '../../lib/prompts';
import { videoModelGroups } from '../../lib/models';
import { validateProject } from '../../domain/validation';
import { joinSpeech } from '../../lib/dubbing';
import { Button, Empty, Field, Modal, copyImage, downloadBlob } from '../../components/Ui';
const labels: Record<VideoTask['status'], string> = { submitting:'提交中',queued:'排队中',running:'生成中',succeeded:'已完成',failed:'生成失败',unknown:'结果未知 · 请检查原平台' };
function patchShot(projectId: string, shotId: string, patch: Partial<Shot>) { updateProject(projectId, p => ({...p,shots:p.shots.map(s=>s.id===shotId?{...s,...patch}:s)})); }
function currentShot(projectId: string, shotId: string, revision?: number) { const p=getStudio().projects.find(p=>p.id===projectId); return p && (revision===undefined||p.revision===revision) ? p.shots.find(s=>s.id===shotId) : undefined; }
function speechLines(project: Project, shot: Shot) {
  return shot.dialogues.filter(d=>d.text.trim()).map(d=>{
    const speaker=project.assets.find(a=>a.id===d.speakerId);
    const voice=project.assets.find(a=>a.kind==='voice'&&a.id===speaker?.voiceAssetId) || (!d.speakerId?project.assets.find(a=>a.kind==='voice'):undefined);
    if(!voice?.voiceId)throw new Error(`镜头 ${shot.number} 的${speaker?.name||'旁白'}尚未绑定音色，请到资产页选择。`);
    return {text:d.text,voiceId:voice.voiceId,speed:voice.speed||1};
  });
}
function VideoThumbnail({ src, unloaded }: { src?: string; unloaded: boolean }) {
  const [failed, setFailed] = useState(false);
  return src && !failed ? <video className="compact-media-image" src={src} muted preload="metadata" playsInline tabIndex={-1} aria-hidden="true" disablePictureInPicture onLoadedMetadata={e => { e.currentTarget.currentTime = 0.001; }} onError={() => setFailed(true)} /> : <span className="compact-media-placeholder"><Film size={27} strokeWidth={1.3} /><span className="muted small">{failed ? '视频预览不可用，请重新导入' : unloaded ? '本地视频未加载，请重新选择文件' : '你的镜头将在这里出现'}</span></span>;
}
const imageKindNames = { character: '人物', scene: '场景', prop: '道具', voice: '音色' };
const imageRoleNames = { reference_image: '参考图', first_frame: '首帧', last_frame: '尾帧' };
function ShotReferenceImage({ asset, label, number }: { asset: Asset; label: string; number: number }) {
  const [media, setMedia] = useState<{ blob: Blob; url: string }>();
  const [error, setError] = useState(''); const [copying, setCopying] = useState(false);
  useEffect(() => {
    let active = true; let url: string | undefined;
    if (asset.imageId) getMedia(asset.imageId).then(blob => {
      if (!active) return;
      if (!blob) { setError('图片不在本机，请到资产页重新上传。'); return; }
      url = URL.createObjectURL(blob); setMedia({ blob, url });
    }).catch(() => { if (active) setError('图片读取失败，请到资产页重新上传。'); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [asset.imageId]);
  return <article className="panel compact-media-card" aria-label={`${asset.name}参考图片`}>
    <div className="compact-media-thumbnail">{media && !error ? <img className="compact-media-image" src={media.url} alt={`${asset.name}参考图`} onError={() => setError('图片无法显示，请到资产页重新上传。')} /> : <span className="compact-media-placeholder muted small">{error || (asset.imageId ? '正在读取图片…' : '未添加图片，请到资产页上传或生成。')}</span>}</div>
    <h3 className="compact-media-title">{imageKindNames[asset.kind]} · {asset.name}</h3><p className="muted small">{label}</p>
    <div className="generation-actions"><Button variant="secondary" aria-label={`复制${asset.name}图片`} disabled={!media || !!error || copying} onClick={async () => { if (!media) return; setCopying(true); try { await copyImage(media.blob, asset.name); } finally { setCopying(false); } }}><Copy size={14}/>{copying ? '复制中…' : '复制图片'}</Button><Button variant="outline" aria-label={`下载${asset.name}图片`} disabled={!media || !!error} onClick={() => { if (!media) return; const extension = media.blob.type === 'image/jpeg' ? 'jpg' : media.blob.type === 'image/webp' ? 'webp' : 'png'; downloadBlob(media.blob, `镜头${number}-${asset.name}.${extension}`); }}><Download size={14}/>下载图片</Button></div>
  </article>;
}
function ShotImageHandoff({ project, shot }: { project: Project; shot: Shot }) {
  const ids = [...new Set([...shot.references.map(ref => ref.assetId), ...shot.assetIds, ...shot.dialogues.map(line => line.speakerId)])];
  const assets = ids.flatMap(id => { const asset = project.assets.find(a => a.id === id && a.kind !== 'voice'); return asset ? [asset] : []; });
  const references = shot.references.length ? shot.references : assets.filter(asset => asset.imageId).map(asset => ({ assetId: asset.id, role: 'reference_image' as const }));
  const prompt = videoPrompt(project, { ...shot, references }) + (!shot.references.length && references.length ? `\n\n开场：${shot.start || shot.visual}\n画面：${shot.visual}` : '');
  async function copyPrompt() {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') { toast.error('当前浏览器不支持此复制方式，请选择下方提示词手动复制。'); return; }
    const text = (async () => {
      for (const reference of references) {
        const asset = assets.find(a => a.id === reference.assetId);
        const blob = asset?.imageId ? await getMedia(asset.imageId) : undefined;
        if (!blob) throw new Error(`「${asset?.name || '参考图'}」图片不在本机，请补图后再复制带图提示词。`);
        try { const image = await createImageBitmap(blob); image.close(); }
        catch { throw new Error(`「${asset?.name || '参考图'}」图片无法读取，请重新上传后再复制带图提示词。`); }
      }
      return new Blob([prompt], { type: 'text/plain' });
    })();
    void text.catch(() => {});
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })]);
      toast.success(references.length ? '已复制视频提示词，请先粘贴，再按图序逐张复制图片。' : '已复制视频提示词，本镜没有参考图片。');
    } catch {
      try { await text; } catch (error) { toast.error(errorMessage(error)); return; }
      toast.error('浏览器未允许复制，请选择提示词手动复制。');
    }
  }
  return <section className="stack" aria-label="本镜图片交接">
    <div><h3>本镜参考图片 · 带到其他平台</h3><p className="muted small">逐张复制并粘贴，每次复制会替换剪贴板上一张图。目标平台不支持粘贴时，请下载图片后上传。</p><p className="muted small">{shot.references.length ? '按分镜已设置的图序和用途上传；补充图不在当前提示词图序中，如需使用，请先到分镜调整挂图。' : '未设置图序，手动提示词按下方已有图片排序；不会改变 API 的挂图设置。'}</p></div>
    {assets.length ? <div className="asset-compact-grid">{assets.map(asset => <ShotReferenceImage key={`${asset.id}:${asset.imageId || ''}`} asset={asset} number={shot.number} label={references.flatMap((ref, i) => ref.assetId === asset.id ? [`图${i + 1} · ${imageRoleNames[ref.role]}`] : []).join(' / ') || (asset.imageId ? '补充图 · 未列入提示词图序' : '缺少参考图片')} />)}</div> : <p className="alert">本镜尚未关联人物、场景或道具图片，请先到资产页添加图片，再到分镜关联。</p>}
    <Field label="完整视频提示词" hint="手动平台使用；已包含人物、场景、道具的固定短语，无需另复制文字资产。"><textarea rows={6} readOnly value={prompt}/></Field>
    <div className="generation-actions"><Button variant="secondary" onClick={copyPrompt}><Copy size={14}/>复制视频提示词</Button></div>
  </section>;
}
function ShotMediaCard({ project, shot, onGenerate, onSpeech, busy }: {project:Project;shot:Shot;onGenerate:()=>void;onSpeech:()=>void;busy:boolean}) {
  const video=useVideo(project.id,shot.id);const audioUrl=useMediaUrl(shot.audio?.mediaId);
  const [link,setLink]=useState('');const [showLink,setShowLink]=useState(false);const [loading,setLoading]=useState(false);const [detailOpen,setDetailOpen]=useState(false);
  const input=useRef<HTMLInputElement>(null);const audioInput=useRef<HTMLInputElement>(null);
  const preview=video?.url||shot.video?.url;
  async function upload(file:File,kind:'video'|'audio') {
    if(file.size>(kind==='video'?200:30)*1024*1024){toast.error('文件过大，请使用较短、较低码率的镜头素材。');return;}
    if(!file.type.startsWith(`${kind}/`)){toast.error('请选择正确的媒体文件类型。');return;}
    const revision=project.revision;setLoading(true);
    try {const duration=await mediaDuration(file,kind);if(!currentShot(project.id,shot.id,revision))return;if(kind==='video'){setVideo(project.id,shot.id,file);patchShot(project.id,shot.id,{video:{name:file.name,duration,origin:'upload'},task:undefined,stale:false});}else{const mediaId=await putMedia(file);if(currentShot(project.id,shot.id,revision))patchShot(project.id,shot.id,{audio:{mediaId,name:file.name,duration},audioMode:'dubbing'});}toast.success(kind==='video'?'视频已导入，刷新后需要重新选择':'配音已保存到本机');}catch(e){toast.error(errorMessage(e));}finally{setLoading(false);}
  }
  async function attachLink() {
    let url:URL;try{url=new URL(link);if(url.protocol!=='https:'||url.username||url.password)throw new Error();}catch{toast.error('请输入 HTTPS 视频直链，不要填写普通网页地址。');return;}
    const revision=project.revision;setLoading(true);
    try {
      const duration=await new Promise<number>((resolve,reject)=>{const v=document.createElement('video');const timer=setTimeout(()=>finish(new Error('链接无法读取，请下载视频后本地导入。')),15000);function finish(error?:Error){clearTimeout(timer);v.removeAttribute('src');v.load();if(error)reject(error);}v.onloadedmetadata=()=>{const d=v.duration;finish();Number.isFinite(d)&&d>0?resolve(d):reject(new Error('视频时长无效。'));};v.onerror=()=>finish(new Error('链接无法播放，可能不是视频直链或已过期。'));v.preload='metadata';v.src=url.href;});
      if(currentShot(project.id,shot.id,revision)){releaseVideo(project.id,shot.id);patchShot(project.id,shot.id,{video:{url:url.href,name:`镜头${shot.number}.mp4`,duration,origin:'link'},task:undefined,stale:false});setShowLink(false);toast.success('链接已连接，导出仍需原站允许跨域下载');}
    }catch(e){toast.error(errorMessage(e));}finally{setLoading(false);}
  }
  async function retrieve() {if(!shot.task?.id)return;setLoading(true);try {const file=await callBinary('video-download',{...credentials(shot.task.provider),taskId:shot.task.id});const duration=await mediaDuration(file);if(currentShot(project.id,shot.id)?.task?.id===shot.task.id){setVideo(project.id,shot.id,file);patchShot(project.id,shot.id,{video:{...shot.video!,name:`镜头${shot.number}.mp4`,origin:'api',duration}});}}catch(e){toast.error(errorMessage(e));}finally{setLoading(false);}}
  return <article className="panel generation-card compact-media-card">
    <button type="button" className="compact-media-thumbnail" aria-label={`查看第${shot.number}镜视频详情`} onClick={()=>setDetailOpen(true)}><VideoThumbnail key={preview} src={preview} unloaded={shot.video?.origin==='upload'}/></button>
    <h3 className="compact-media-title">镜头 {String(shot.number).padStart(2,'0')}{shot.video?.name ? ` · ${shot.video.name}` : ''}</h3><p className="compact-media-description muted">{shot.visual || '尚未填写画面描述'}</p>
    {detailOpen&&<Modal open onClose={()=>setDetailOpen(false)} title={`第${shot.number}镜视频详情`} description="查看完整画面、关联资产与固定短语，生成或导入本镜视频和配音。"><div className="stack media-detail">
      <div className="toolbar"><span className="shot-number">镜头 {String(shot.number).padStart(2,'0')}</span><span className="tag">{shot.duration} 秒 · {shot.task?labels[shot.task.status]:shot.video?'已导入':'待制作'}</span></div>
      {preview?<video className="media-detail-media" src={preview} controls preload="metadata" playsInline aria-label={`第${shot.number}镜视频播放器`} onError={()=>toast.error(`镜头 ${shot.number} 的预览链接不可用，请重新导入。`)}/>:<div className="video-placeholder"><Film size={27} strokeWidth={1.3}/><span className="muted small">{shot.video?.origin==='upload'?'本地视频未加载，请重新选择文件':'你的镜头将在这里出现'}</span></div>}
      {shot.video&&<p className="media-detail-text">视频名称：{shot.video.name}</p>}
      <div><h3>画面描述</h3><p className="media-detail-text">{shot.visual || '尚未填写画面描述'}</p></div>{shot.stale&&<p className="alert">剧本或资产已更新，请核对本镜素材。</p>}{shot.task?.error&&<p className="alert">{shot.task.error}</p>}
      <ShotImageHandoff project={project} shot={shot}/>
      <div className="generation-actions"><Button onClick={()=>{setDetailOpen(false);onGenerate();}} disabled={busy||loading||['submitting','queued','running'].includes(shot.task?.status||'')}><WandSparkles size={14}/>API 生成</Button></div><div className="generation-actions"><Button variant="outline" onClick={()=>input.current?.click()} disabled={loading}><Upload size={14}/>导入视频</Button><Button variant="outline" onClick={()=>setShowLink(!showLink)}><Link2 size={14}/>视频链接</Button>{shot.task?.id&&shot.task.status==='succeeded'&&!video&&<Button variant="outline" onClick={retrieve} disabled={loading}><RefreshCw size={14}/>取回视频</Button>}{video&&<Button variant="ghost" aria-label={`下载第${shot.number}镜视频`} onClick={()=>downloadBlob(video.blob,shot.video?.name||`镜头${shot.number}.mp4`)}><Download size={14}/></Button>}</div>
      <input ref={input} type="file" accept="video/mp4,video/webm,video/quicktime" hidden onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void upload(file,'video');}}/>{showLink&&<div className="stack"><Field label="HTTPS 视频直链"><input type="url" value={link} onChange={e=>setLink(e.target.value)} placeholder="粘贴可以直接播放的视频地址"/></Field><Button variant="secondary" onClick={attachLink} disabled={loading}>连接并验证</Button></div>}
      <Field label="声音处理"><select value={shot.audioMode} onChange={e=>patchShot(project.id,shot.id,{audioMode:e.target.value as Shot['audioMode']})}><option value="original">保留视频原音</option><option value="dubbing">使用独立配音（替换原音）</option><option value="silent">静音镜头</option></select></Field><div className="generation-actions"><Button variant="secondary" onClick={()=>{setDetailOpen(false);onSpeech();}} disabled={busy||loading||!shot.dialogues.some(d=>d.text.trim())}><Mic size={14}/>生成配音</Button><Button variant="outline" onClick={()=>audioInput.current?.click()} disabled={loading}><Upload size={14}/>导入配音</Button></div><input ref={audioInput} type="file" hidden accept="audio/*" onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void upload(f,'audio');}}/>{audioUrl&&<audio src={audioUrl} controls/>}{shot.audio&&<p className={`small ${shot.audio.duration>shot.duration?'alert':'muted'}`}>配音 {shot.audio.duration.toFixed(1)} 秒{shot.audio.duration>shot.duration?'，超过镜头时长，请缩短台词或调整语速后重生成。':' · AI 生成或本地导入音轨'}</p>}
    </div></Modal>}
  </article>;
}
export default function GenerationPage({project,navigate}:PageProps) {
  const state=useStudio();const [tab,setTab]=useState<'api'|'manual'>('manual');
  const [confirmation,setConfirmation]=useState<{kind:'video'|'speech';ids:string[];revision:number;provider:'seedance'|'minimax';model:string;prompts:Record<string,string>;speech:Record<string,ReturnType<typeof speechLines>>}|null>(null);
  const [busy,setBusy]=useState(false);const [busyText,setBusyText]=useState('');const [queryError,setQueryError]=useState('');const stop=useRef(false);
  const pollRef=useRef(false);
  useEffect(()=>()=>{stop.current=true;},[]);
  useEffect(()=>{let active=true;let timer:ReturnType<typeof setTimeout>;
    async function poll(){if(!active)return;if(!pollRef.current){pollRef.current=true;try{
      const p=getStudio().projects.find(p=>p.id===project.id);
      for(const shot of p?.shots||[]){const task=shot.task;if(!active||!task?.id||!['queued','running'].includes(task.status)||!getStudio().keys[task.provider])continue;
        try {const result=await callApi<{status:'queued'|'running'|'succeeded'|'failed';url?:string;error?:string}>('video-status',{...credentials(task.provider),taskId:task.id});if(active)setQueryError('');const latest=currentShot(project.id,shot.id);if(!latest||latest.task?.id!==task.id)continue;patchShot(project.id,shot.id,{task:{...task,status:result.status,error:result.error},...(result.status==='succeeded'&&result.url?{video:{url:result.url,name:`镜头${shot.number}.mp4`,duration:shot.duration,origin:'api' as const},audioMode:shot.dialogues.some(d=>d.text.trim())?'dubbing' as const:'silent' as const,stale:p!.revision!==task.revision}:{})});
          if(result.status==='succeeded'){try{const blob=await callBinary('video-download',{...credentials(task.provider),taskId:task.id});const duration=await mediaDuration(blob);if(currentShot(project.id,shot.id)?.task?.id===task.id){setVideo(project.id,shot.id,blob);patchShot(project.id,shot.id,{video:{url:result.url,name:`镜头${shot.number}.mp4`,duration,origin:'api'}});}}catch{toast(`镜头 ${shot.number} 已生成，可用取回按钮下载；如失败请从原平台导入。`);}}
        }catch(e){if(active)setQueryError(errorMessage(e));}
      }
    }finally{pollRef.current=false;}}if(active)timer=setTimeout(poll,10000);}
    timer=setTimeout(poll,1500);return()=>{active=false;clearTimeout(timer);};
  },[project.id]);
  function prepare(kind:'video'|'speech',ids:string[]){try{const provider=state.settings.videoProvider;credentials(kind==='video'?provider:'minimax');if(kind==='video'){const issues=validateProject(project);if(issues.length)throw new Error(issues.join('；'));}const prompts:Record<string,string>={};const speech:Record<string,ReturnType<typeof speechLines>>={};for(const id of ids){const shot=project.shots.find(s=>s.id===id)!;if(kind==='video')prompts[id]=videoPrompt(project,{...shot,audioMode:shot.dialogues.some(d=>d.text.trim())?'dubbing':'silent'});else speech[id]=speechLines(project,shot);}setConfirmation({kind,ids,revision:project.revision,provider,model:kind==='video'?state.settings.models[provider]:state.settings.speechModel,prompts,speech});}catch(e){toast.error(errorMessage(e));}}
  async function run(){if(!confirmation)return;const batch=confirmation;setConfirmation(null);setBusy(true);stop.current=false;
    try {for(const id of batch.ids){if(stop.current)break;const p=getStudio().projects.find(p=>p.id===project.id);const shot=currentShot(project.id,id,batch.revision);if(!p||!shot){throw new Error('作品已发生变化，剩余任务未提交，请重新确认。');}setBusyText(`正在处理镜头 ${shot.number}`);
      if(batch.kind==='video'){
        const settings=getStudio().settings;
        if(settings.videoProvider!==batch.provider||settings.models[batch.provider]!==batch.model)throw new Error('视频模型设置已改变，剩余任务未提交，请重新确认。');
        if(shot.task&&['queued','running','submitting'].includes(shot.task.status))continue;
        const images=[];for(const ref of shot.references){const asset=p.assets.find(a=>a.id===ref.assetId);const image=asset?.imageId?await getMedia(asset.imageId):undefined;if(!image)throw new Error(`镜头 ${shot.number} 的参考图不在本机，请重新导入。`);images.push({url:await blobDataUrl(image),role:ref.role});}
        const task:VideoTask={provider:batch.provider,model:batch.model,status:'submitting',revision:batch.revision,createdAt:new Date().toISOString()};patchShot(p.id,id,{task});
        try{const result=await callApi<{id:string;status:'queued'}>('video-create',{...credentials(batch.provider),model:batch.model,prompt:batch.prompts[id],duration:shot.duration,images});if(currentShot(p.id,id)?.task?.createdAt===task.createdAt){patchShot(p.id,id,{task:{...task,id:result.id,status:'queued'}});}}
        catch(e){if(currentShot(p.id,id)?.task?.createdAt===task.createdAt)patchShot(p.id,id,{task:{...task,status:e instanceof ApiError&&e.code==='submission_unknown'?'unknown':'failed',error:errorMessage(e)}});throw e;}
      }else{const parts:Blob[]=[];for(const line of batch.speech[id]){parts.push(await callBinary('speech',{...credentials('minimax'),model:batch.model,...line}));}if(!parts.length)continue;const joined=await joinSpeech(parts);const mediaId=await putMedia(joined.blob);if(currentShot(p.id,id,batch.revision))patchShot(p.id,id,{audio:{mediaId,name:`镜头${shot.number}-配音.wav`,duration:joined.duration},audioMode:'dubbing'});}
    }if(stop.current)toast('已停止后续任务，先前已受理的任务仍可查询。');else toast.success(batch.kind==='video'?'已提交本批任务，正在查询生成状态':'本批配音已生成，请试听并检查时长');}
    catch(e){toast.error(errorMessage(e));}finally{setBusy(false);setBusyText('');}
  }
  if(!project.shots.length)return <Empty title="先准备好你的分镜" text="剧本和分镜完成后，就可以在这里生成或导入视频。"><Button onClick={()=>navigate('script')}>去写剧本 <ArrowRight size={16}/></Button></Empty>;
  const ready=project.shots.filter(s=>s.video&&!s.stale).length;const pending=project.shots.filter(s=>!s.video&&!['queued','running','submitting','unknown'].includes(s.task?.status||''));const spoken=project.shots.filter(s=>s.dialogues.some(d=>d.text.trim())&&!s.audio);
  return <div className="stack"><div className="page-heading"><div><div className="eyebrow">04 / BRING IT TO LIFE</div><h1>让故事动起来</h1><p className="muted">用 API 在这里生成，或导入你在其他平台制作的镜头。</p></div><Button variant="secondary" onClick={()=>navigate('export')}><Play size={16}/>预览成片 <ArrowRight size={15}/></Button></div><div className="toolbar"><div className="tabs-row"><button className={tab==='manual'?'active':''} onClick={()=>setTab('manual')}>手动导入 · 无需 Key</button><button className={tab==='api'?'active':''} onClick={()=>setTab('api')}>API 生成</button></div><span className="tag success">{ready} / {project.shots.length} 镜已准备</span></div><div className="panel"><Field label="视频模型" hint="API 生成使用此模型；确认清单后才提交，设置中的自定义模型 ID 也会原样发送。"><select disabled={busy} value={`${state.settings.videoProvider}:${state.settings.models[state.settings.videoProvider]}`} onChange={e=>{const [provider,model]=e.target.value.split(':') as ['seedance'|'minimax',string];setSettings({...state.settings,videoProvider:provider,models:{...state.settings.models,[provider]:model}});}}>{videoModelGroups.map(group=><optgroup key={group.provider} label={group.label}>{group.models.map(model=><option key={model.id} value={`${group.provider}:${model.id}`}>{model.name} · {model.description}</option>)}{!group.models.some(model=>model.id===state.settings.models[group.provider])&&<option value={`${group.provider}:${state.settings.models[group.provider]}`}>自定义 · {state.settings.models[group.provider]}</option>}</optgroup>)}</select></Field></div>{tab==='manual'?<div className="notice"><Upload size={22}/><div><strong>你的创作，不被平台绑住</strong><p>打开镜头详情，复制视频提示词，再逐张复制参考图片（或下载后上传）。在 Seedance 或海螺生成后，导入视频或粘贴直链。上传视频只保留在当前页面，刷新后需重新导入。</p></div></div>:<div className="panel stack"><div className="toolbar"><div><h2>{state.settings.videoProvider==='seedance'?'Seedance':'MiniMax H3'} · 逐镜生成</h2><p className="small muted">{state.settings.models[state.settings.videoProvider]} · 关闭模型原声，以所选角色音色配音</p></div><Button variant="outline" onClick={()=>navigate('settings')}>配置模型</Button></div><div className="row wrap"><Button disabled={busy||!pending.length} onClick={()=>prepare('video',pending.map(s=>s.id))}><WandSparkles size={16}/>生成待制作镜头（{pending.length}）</Button><Button variant="secondary" disabled={busy||!spoken.length} onClick={()=>prepare('speech',spoken.map(s=>s.id))}><Mic size={16}/>生成缺少的配音（{spoken.length}）</Button></div><p className="small muted">生成前会列出完整清单；关闭网页不会继续提交未开始的任务，已提交任务可返回此页查询。</p></div>}{queryError&&<div className="alert" role="alert">任务查询：{queryError} <button className="text-button" onClick={()=>{setQueryError('');navigate('settings');}}>检查设置</button></div>}{busy&&<div className="notice row between" role="status"><span>{busyText}</span><Button variant="secondary" onClick={()=>{stop.current=true;toast('本次调用结束后停止，不会取消服务商已受理任务');}}>停止后续任务</Button></div>}<div className="generation-grid compact-media-grid">{project.shots.map(shot=><ShotMediaCard key={shot.id} project={project} shot={shot} busy={busy} onGenerate={()=>prepare('video',[shot.id])} onSpeech={()=>prepare('speech',[shot.id])}/>)}</div>
    <Modal open={!!confirmation} onClose={()=>setConfirmation(null)} title={`确认生成 ${confirmation?.ids.length||0} 个${confirmation?.kind==='video'?'视频镜头':'镜头配音'}`} description="确认后才会调用你的付费 API。失败不会自动重复提交，请先检查任务状态。"><div className="stack"><span className="tag">{confirmation?.model}</span>{confirmation?.ids.map(id=>{const shot=project.shots.find(s=>s.id===id)!;return <div key={id}><h3>镜头 {shot.number} · {shot.duration} 秒</h3><pre>{confirmation.kind==='video'?confirmation.prompts[id]:confirmation.speech[id].map(line=>`${line.voiceId} · ${line.speed}×\n${line.text}`).join('\n\n')}</pre>{confirmation.kind==='video'&&<p className="small muted">参考图：{shot.references.length?shot.references.map((r,index)=>`图${index+1} ${project.assets.find(a=>a.id===r.assetId)?.name} (${r.role})`).join('、'):'无，按文生视频提交'}</p>}</div>;})}<Button onClick={run}>确认并开始生成</Button></div></Modal>
  </div>;
}

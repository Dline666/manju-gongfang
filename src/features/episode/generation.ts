import { useEffect, useRef, useState } from 'react';
import type { Project, Shot, VideoTask } from '../../domain/types';
import { speakerName } from '../../domain/types';
import type { Episode, Series } from '../../domain/series';
import type { PromptTemplateSet } from '../../domain/types';
import { getStudio, setAssetImage, updateEpisode } from '../../store/studio';
import { releaseVideo, setVideo } from '../../store/media';
import { ApiError, callApi, callBinary, credentials, errorMessage, type ImageResult } from '../../lib/api';
import { videoPrompt, imagePrompt, fixedDescription } from '../../lib/prompts';
import { fixedHash, generatedImageBlob, validateImage } from '../../lib/imageFile';
import { modelFor } from '../../lib/endpoints';
import { validateProject } from '../../domain/validation';
import { joinSpeech } from '../../lib/dubbing';
import { putMedia, getMedia, blobDataUrl, mediaDuration } from '../../store/media';
import { finishJob, startJob, updateJob } from '../../store/jobs';
import { runPool } from '../../lib/pool';
import { toast } from 'sonner';

/** 一集被当作 Project 用：导出、校验、提示词拼装的函数都吃 Project。 */
export function asProject(episode: Episode): Project {
  return episode;
}

export function patchShot(seriesId: string, episodeId: string, shotId: string, patch: Partial<Shot>) {
  updateEpisode(seriesId, episodeId, episode => ({
    ...episode,
    shots: episode.shots.map(shot => shot.id === shotId ? { ...shot, ...patch } : shot),
  }));
}

/** 取最新的某一镜：轮询回来时旧引用可能已经过期。 */
function currentShot(episodeId: string, shotId: string, revision?: number, seriesId?: string) {
  const series = seriesId
    ? getStudio().series.find(item => item.id === seriesId)
    : getStudio().series.find(item => item.episodes.some(episode => episode.id === episodeId));
  const episode = series?.episodes.find(item => item.id === episodeId);
  if (!episode) return undefined;
  if (revision !== undefined && episode.revision !== revision) return undefined;
  return episode.shots.find(shot => shot.id === shotId);
}

export function speechLines(episode: Project, shot: Shot) {
  return shot.dialogues.filter(line => line.text.trim()).map(line => {
    const name = speakerName(episode, line);
    const speaker = episode.assets.find(asset => asset.id === line.speakerId)
      ?? (name ? episode.assets.find(asset => asset.kind === 'character' && asset.name === name) : undefined);
    const voice = episode.assets.find(asset => asset.kind === 'voice' && asset.id === speaker?.voiceAssetId)
      ?? (!speaker ? episode.assets.find(asset => asset.kind === 'voice') : undefined);
    if (!voice?.voiceId) throw new Error(`镜头 ${shot.number} 的${speaker?.name || name || '旁白'}尚未绑定音色，请到剧集资产里选择。`);
    return { text: line.text, voiceId: voice.voiceId, speed: voice.speed || 1 };
  });
}

type Batch = {
  kind: 'video' | 'speech';
  ids: string[];
  revision: number;
  provider: string;
  model: string;
  prompts: Record<string, string>;
  speech: Record<string, ReturnType<typeof speechLines>>;
};

export const taskLabels: Record<VideoTask['status'], string> = {
  submitting: '提交中', queued: '排队中', running: '生成中', succeeded: '已完成', failed: '生成失败', unknown: '结果未知 · 请检查原平台',
};

/**
 * 一集的视频/配音生成。
 *
 * 生成必须是非阻塞的：对话框随时可关，进度只出现在 JobTray，只有正在进行的那一镜禁用重生成。
 * 轮询在页面还在时继续；页面关掉后不再续，任务本身仍留在服务商那边，可用「取回视频」。
 */
export function useEpisodeGeneration(series: Series, episode: Episode) {
  const [batch, setBatch] = useState<Batch>();
  const [busy, setBusy] = useState(false);
  const [queryError, setQueryError] = useState('');
  const stop = useRef(false);
  const pollRef = useRef(false);

  const seriesId = series.id;
  const episodeId = episode.id;
  const revision = episode.revision;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!active) return;
      if (!pollRef.current) {
        pollRef.current = true;
        try {
          const seriesNow = getStudio().series.find(item => item.id === seriesId);
          const episodeNow = seriesNow?.episodes.find(item => item.id === episodeId);
          const pendings = (episodeNow?.shots ?? []).filter(shot => {
            const task = shot.task;
            return !!task?.id && ['queued', 'running'].includes(task.status) && !!getStudio().keys[task.provider];
          });
          const generated: number[] = [];
          const lost: number[] = [];
          await runPool(pendings, async shot => {
            if (!active) return;
            const task = shot.task!;
            try {
              const result = await callApi<{ status: 'queued' | 'running' | 'succeeded' | 'failed'; url?: string; error?: string }>(
                'video-status', { ...credentials(task.provider, 'video'), taskId: task.id });
              if (active) setQueryError('');
              const latest = currentShot(episodeId, shot.id, undefined, seriesId);
              if (!latest || latest.task?.id !== task.id) return;
              patchShot(seriesId, episodeId, shot.id, {
                task: { ...task, status: result.status, ...(result.error ? { error: result.error } : {}) },
                ...(result.status === 'succeeded' && result.url ? {
                  video: { url: result.url, name: `镜头${shot.number}.mp4`, duration: shot.duration, origin: 'api' as const },
                  audioMode: shot.dialogues.some(line => line.text.trim()) ? 'dubbing' as const : 'silent' as const,
                  stale: latest.task?.revision !== undefined && latest.task.revision !== (episodeNow?.revision ?? 0),
                } : {}),
              });
              if (result.status === 'failed') lost.push(shot.number);
              if (result.status === 'succeeded') {
                generated.push(shot.number);
                try {
                  const blob = await callBinary('video-download', { ...credentials(task.provider, 'video'), taskId: task.id });
                  const duration = await mediaDuration(blob);
                  if (currentShot(episodeId, shot.id, undefined, seriesId)?.task?.id === task.id) {
                    setVideo(episodeId, shot.id, blob);
                    patchShot(seriesId, episodeId, shot.id, { video: { url: result.url, name: `镜头${shot.number}.mp4`, duration, origin: 'api' } });
                  }
                } catch {
                  toast(`镜头 ${shot.number} 已生成，可用「取回视频」下载；若失败请从原平台导入。`);
                }
              }
            } catch (error) {
              if (active) setQueryError(errorMessage(error));
            }
          }, { concurrency: 3 });
          if (active && generated.length) toast.success(`镜头 ${generated.join('、')} 已生成，可直接预览。`);
          if (active && lost.length) toast.error(`镜头 ${lost.join('、')} 生成失败：详情见分镜表。`);
        } finally {
          pollRef.current = false;
        }
      }
      if (active) timer = setTimeout(poll, 10000);
    }
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [seriesId, episodeId]);

  function defaultPrompt(shot: Shot, templates?: PromptTemplateSet) {
    return videoPrompt(episode, { ...shot, audioMode: shot.dialogues.some(line => line.text.trim()) ? 'dubbing' : 'silent' }, templates);
  }

  /** 提交前先在本地把所有会导致付费失败的原因查一遍：参考图、音色、时长、模型。 */
  function prepare(kind: 'video' | 'speech', ids: string[]) {
    if (busy) { toast.error('上一批任务还在进行，请等它结束后再提交。'); return; }
    const state = getStudio();
    try {
      const provider = state.settings.videoProvider;
      // 先查内容，再查 Key：内容问题是用户当下就能改的，
      // 「没有 Key」只说明还没配置账号，先报它会把更要紧的问题盖住。
      if (kind === 'video') {
        const issues = validateProject(episode);
        if (issues.length) throw new Error(issues.join('；'));
        // 资产未锁定就生成视频，后续改设定会让成片对不上：先拦一次。
        const unlocked = episode.assets.filter(asset => asset.kind !== 'voice' && !asset.lock.trim() && episode.shots.some(shot => shot.assetIds.includes(asset.id)));
        if (unlocked.length) throw new Error(`这些资产还没写固定描述，锁不住一致性：${unlocked.map(asset => asset.name).join('、')}。请先在剧集资产里补上。`);
      }
      credentials(kind === 'video' ? provider : 'minimax', kind === 'video' ? 'video' : 'speech');
      const prompts: Record<string, string> = {};
      const speech: Record<string, ReturnType<typeof speechLines>> = {};
      for (const id of ids) {
        const shot = episode.shots.find(item => item.id === id)!;
        if (kind === 'video') {
          const text = defaultPrompt(shot, state.settings.promptTemplates);
          if (!text.trim()) throw new Error('提示词不能为空：请在提示词设置里添加内容。');
          prompts[id] = text;
        } else {
          speech[id] = speechLines(episode, shot);
        }
      }
      setBatch({
        kind, ids, revision,
        provider,
        model: kind === 'video' ? modelFor(state.settings, provider, 'video') : state.settings.speechModel,
        prompts, speech,
      });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function run() {
    if (!batch) return;
    const current = batch;
    setBatch(undefined);
    setBusy(true);
    stop.current = false;
    const jobId = startJob({
      kind: current.kind,
      label: current.kind === 'video' ? `生成视频（${current.ids.length} 镜）` : `生成配音（${current.ids.length} 镜）`,
      cancel: () => { stop.current = true; },
    });
    try {
      for (const id of current.ids) {
        if (stop.current) break;
        const shot = currentShot(episodeId, id, current.revision, seriesId);
        if (!shot) throw new Error('本集内容已发生变化，剩余任务未提交，请重新确认。');
        updateJob(jobId, { detail: `正在处理镜头 ${shot.number}` });
        if (current.kind === 'video') {
          const settings = getStudio().settings;
          if (settings.videoProvider !== current.provider || modelFor(settings, current.provider, 'video') !== current.model) {
            throw new Error('视频模型设置已改变，剩余任务未提交，请重新确认。');
          }
          if (!current.prompts[id]?.trim()) throw new Error(`镜头 ${shot.number} 的视频提示词为空，剩余任务未提交。`);
          if (shot.task && ['queued', 'running', 'submitting'].includes(shot.task.status)) continue;
          const images: { url: string; role: 'reference_image' | 'first_frame' | 'last_frame' }[] = [];
          for (const reference of shot.references) {
            const asset = episode.assets.find(item => item.id === reference.assetId);
            const image = asset?.imageId ? await getMedia(asset.imageId) : undefined;
            if (!image) throw new Error(`镜头 ${shot.number} 的参考图不在本机，请重新导入。`);
            images.push({ url: await blobDataUrl(image), role: reference.role });
          }
          const task: VideoTask = {
            provider: current.provider === 'minimax' ? 'minimax' : 'seedance',
            model: current.model, status: 'submitting', revision: current.revision, createdAt: new Date().toISOString(),
          };
          patchShot(seriesId, episodeId, id, { task });
          try {
            const result = await callApi<{ id: string; status: 'queued' }>('video-create', {
              ...credentials(current.provider, 'video'), model: current.model, prompt: current.prompts[id], duration: shot.duration, images,
            });
            if (currentShot(episodeId, id, undefined, seriesId)?.task?.createdAt === task.createdAt) {
              patchShot(seriesId, episodeId, id, { task: { ...task, id: result.id, status: 'queued' } });
            }
          } catch (error) {
            if (currentShot(episodeId, id, undefined, seriesId)?.task?.createdAt === task.createdAt) {
              patchShot(seriesId, episodeId, id, {
                task: { ...task, status: error instanceof ApiError && error.code === 'submission_unknown' ? 'unknown' : 'failed', error: errorMessage(error) },
              });
            }
            throw error;
          }
        } else {
          const lines = current.speech[id];
          const parts: Blob[] = [];
          for (const [index, line] of lines.entries()) {
            updateJob(jobId, { detail: `镜头 ${shot.number} · 第 ${index + 1} / ${lines.length} 句` });
            parts.push(await callBinary('speech', { ...credentials('minimax', 'speech'), model: current.model, ...line }));
          }
          if (!parts.length) continue;
          const joined = await joinSpeech(parts);
          const mediaId = await putMedia(joined.blob);
          if (currentShot(episodeId, id, current.revision, seriesId)) {
            patchShot(seriesId, episodeId, id, { audio: { mediaId, name: `镜头${shot.number}-配音.wav`, duration: joined.duration }, audioMode: 'dubbing' });
          }
        }
      }
      if (stop.current) {
        finishJob(jobId, 'canceled');
        toast('已停止后续任务，先前已受理的任务仍可查询。');
      } else {
        finishJob(jobId, 'done');
        toast.success(current.kind === 'video' ? '已提交本批任务，正在查询生成状态' : '本批配音已生成，请试听并检查时长');
      }
    } catch (error) {
      finishJob(jobId, 'failed', error instanceof ApiError ? error.code : undefined);
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  /** 导入本地视频：视频本体只存在于本次会话，存档只留文件名与时长。 */
  async function uploadVideo(shot: Shot, file: File) {
    if (file.size > 200 * 1024 * 1024) { toast.error('文件过大，请使用较短、较低码率的镜头素材。'); return; }
    if (!file.type.startsWith('video/')) { toast.error('请选择正确的视频文件。'); return; }
    try {
      const duration = await mediaDuration(file, 'video');
      setVideo(episodeId, shot.id, file);
      patchShot(seriesId, episodeId, shot.id, { video: { name: file.name, duration, origin: 'upload' }, task: undefined, stale: false });
      toast.success('视频已导入，刷新后需要重新选择');
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function uploadAudio(shot: Shot, file: File) {
    if (file.size > 30 * 1024 * 1024) { toast.error('音频过大，请压缩后再导入。'); return; }
    if (!file.type.startsWith('audio/')) { toast.error('请选择正确的音频文件。'); return; }
    try {
      const duration = await mediaDuration(file, 'audio');
      const mediaId = await putMedia(file);
      patchShot(seriesId, episodeId, shot.id, { audio: { mediaId, name: file.name, duration }, audioMode: 'dubbing' });
      toast.success('配音已保存到本机');
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  /** 取回已生成但没下载到本机的视频。 */
  async function retrieve(shot: Shot) {
    if (!shot.task?.id) return;
    try {
      const file = await callBinary('video-download', { ...credentials(shot.task.provider, 'video'), taskId: shot.task.id });
      const duration = await mediaDuration(file);
      if (currentShot(episodeId, shot.id, undefined, seriesId)?.task?.id === shot.task.id) {
        setVideo(episodeId, shot.id, file);
        patchShot(seriesId, episodeId, shot.id, { video: { ...shot.video!, name: `镜头${shot.number}.mp4`, origin: 'api', duration } });
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  function removeVideo(shot: Shot) {
    releaseVideo(episodeId, shot.id);
    patchShot(seriesId, episodeId, shot.id, { video: undefined, task: undefined, stale: false });
  }

  /**
   * 给一个资产生设定图。跟视频一样先查内容再查 Key：
   * 固定描述为空时，生出来的图这一镜用不了，先说这件事。
   */
  async function generateAssetImage(assetId: string, promptText?: string) {
    const state = getStudio();
    const series = state.series.find(item => item.id === seriesId);
    const live = series?.episodes.find(item => item.id === episodeId);
    const asset = live?.assets.find(item => item.id === assetId);
    if (!asset) { toast.error('资产已不存在，本次不生成。'); return; }
    if (!(promptText ?? '').trim() && !asset.lock.trim() && !asset.description.trim()) {
      toast.error(`「${asset.name}」还没有固定描述，先生成会得到一张对不上后续镜头的图。请先补上。`);
      return;
    }
    try {
      const provider = state.settings.imageProvider;
      const auth = credentials(provider, 'image');
      const prompt = (promptText ?? '').trim() || imagePrompt(live!, asset, state.settings.promptTemplates);
      if (!prompt.trim()) throw new Error('图片提示词不能为空：请在提示词设置里补充内容。');
      // 记下提交时的模型与固定描述：中途被改掉就把结果丢掉，不能悄悄写进存档。
      const hash = fixedHash(fixedDescription(asset));
      const model = auth.model;
      const controller = new AbortController();
      const jobId = startJob({ kind: 'image', label: `生成「${asset.name}」设定图`, cancel: () => controller.abort() });
      try {
        updateJob(jobId, { detail: '生成图片中' });
        const result = await callApi<ImageResult>('image', { provider: auth.provider, key: auth.key, model: auth.model, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}), prompt }, controller.signal);
        const after = getStudio().series.find(item => item.id === seriesId)?.episodes.find(item => item.id === episodeId);
        const nowAsset = after?.assets.find(item => item.id === assetId);
        if (!nowAsset) throw new Error('资产已删除，本次结果不写入。');
        if (fixedHash(fixedDescription(nowAsset)) !== hash) throw new Error('固定描述已修改，本次结果不写入。请重新生成。');
        if (getStudio().settings.imageProvider !== provider || modelFor(getStudio().settings, provider, 'image') !== model) throw new Error('图片模型设置已改变，请重新确认。');
        const imageId = await putMedia(await generatedImageBlob(result));
        setAssetImage(seriesId, episodeId, assetId, imageId);
        finishJob(jobId, 'done');
        toast.success(`「${asset.name}」的设定图已保存。`);
      } catch (error) {
        finishJob(jobId, 'failed', error instanceof ApiError ? error.code : undefined);
        throw error;
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  function uploadAssetImage(assetId: string, file: File) {
    if (!file.type.startsWith('image/')) { toast.error('请选择图片文件。'); return; }
    void validateImage(file)
      .then(() => putMedia(file))
      .then(imageId => setAssetImage(seriesId, episodeId, assetId, imageId))
      .catch(error => toast.error(errorMessage(error)));
  }

  return {
    batch, busy, queryError,
    setBatch, prepare, run, uploadVideo, uploadAudio, retrieve, removeVideo,
    generateAssetImage, uploadAssetImage,
    updatePrompt: (id: string, value: string) => setBatch(previous => previous && previous.kind === 'video' ? { ...previous, prompts: { ...previous.prompts, [id]: value } } : previous),
    resetPrompt: (id: string) => {
      const shot = episode.shots.find(item => item.id === id);
      if (shot) setBatch(previous => previous && previous.kind === 'video' ? { ...previous, prompts: { ...previous.prompts, [id]: defaultPrompt(shot, getStudio().settings.promptTemplates) } } : previous);
    },
    defaultPrompt,
  };
}

export { setAssetImage };
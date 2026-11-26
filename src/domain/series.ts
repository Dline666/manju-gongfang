import { uid, type Project, type PromptConfig, type PromptTemplateSet } from './types';

/**
 * 系列 → 集数。
 *
 * `Episode` 刻意继承旧的 `Project` 形状：剧本、资产、镜头、提示词覆盖层这些字段
 * 与原先完全一致，所以 `prompts.ts`、`media/*`、`documents.ts` 这些按 `Project` 写的
 * 纯函数可以原样接收一集，不必为「系列」概念重写一遍。系列只是多出来的容器层。
 */
export type Aspect = '9:16' | '16:9';
export type Resolution = '720p' | '1080p';

export interface Episode extends Project {
  /** 集号，从 1 开始，系列内唯一。 */
  number: number;
  /** 集标题；空表示只有集号。 */
  title: string;
  /** 本集小说全文（生成小说的产物）。 */
  novel?: string;
  /** 本集剧本全文（小说生剧本的产物）。 */
  screenplay?: string;
  /**
   * 导入进来的分镜 JSON 原文。留着是为了「重新导入前给用户看改了什么」，
   * 以及失败时能把原文还给用户，不用重新粘贴。
   */
  storyboardJson?: string;
  /**
   * 旧规格作品（迁移来的 10 镜 / 90 秒那批）。
   * 只用于说明与提示：不受新的 4–6 镜规则约束，不做阻断。
   */
  legacySpec?: boolean;
}

export interface Series {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 画幅按系列定一次，资产图与视频都跟它走。 */
  aspect: Aspect;
  /** 分辨率按系列定一次。 */
  resolution: Resolution;
  episodes: Episode[];
  /** 系列级视觉风格（StyleSpec 的字符串形态），不填则用全局默认。 */
  style?: string;
  /**
   * 系列级提示词模板覆盖层，对应「全局与按系列两级作用域」里的系列那一级。
   * 没有的键跟随全局；不复制全局全文。
   */
  promptConfig?: PromptConfig;
  /** 系列级 Skill 库覆盖（只在需要单独给这个系列换 Skill 时才存在）。 */
  skillOverrides?: PromptTemplateSet;
}

export const DEFAULT_ASPECT: Aspect = '9:16';
export const DEFAULT_RESOLUTION: Resolution = '720p';
/** 画幅只允许这两种；其余值一律按默认处理，不做第三次扩展。 */
export const ASPECTS: Aspect[] = ['9:16', '16:9'];
export const RESOLUTIONS: Resolution[] = ['720p', '1080p'];

export function isAspect(value: unknown): value is Aspect {
  return value === '9:16' || value === '16:9';
}
export function isResolution(value: unknown): value is Resolution {
  return value === '720p' || value === '1080p';
}

/** 一集在界面上显示的名字：「第1集 雪夜归人」；没标题就只显示集号。 */
export function episodeLabel(episode: Pick<Episode, 'number' | 'title'>): string {
  const title = episode.title.trim();
  return title ? `第${episode.number}集 ${title}` : `第${episode.number}集`;
}

/** 一集的总时长（秒）：镜头时长之和，忽略未填写时长的空镜。 */
export function episodeDuration(episode: Pick<Episode, 'shots'>): number {
  return episode.shots.reduce((total, shot) => total + (Number.isFinite(shot.duration) && shot.duration > 0 ? shot.duration : 0), 0);
}

/** 一集的导入状态：未导入 / 已导入 / 已生成。 */
export type EpisodeStatus = 'empty' | 'imported' | 'generated';

export function episodeStatus(episode: Pick<Episode, 'shots' | 'storyboardReady'>): EpisodeStatus {
  if (!episode.shots.length) return 'empty';
  if (episode.shots.some(shot => shot.video || shot.task)) return 'generated';
  return 'imported';
}

export const EPISODE_STATUS_LABEL: Record<EpisodeStatus, string> = {
  empty: '未导入',
  imported: '已导入',
  generated: '已生成',
};

/** 新建一集：除了集号与标题，其余字段与旧的作品初始状态一致。 */
export function makeEpisode(number: number, title = '', style = ''): Episode {
  const date = new Date().toISOString();
  return {
    id: uid(),
    number,
    title,
    name: `第${number}集`,
    theme: '',
    style,
    createdAt: date,
    updatedAt: date,
    revision: 0,
    skills: ['script', 'storyboard', 'image', 'video'],
    shots: [],
    assets: [],
    source: 'empty',
    storyboardReady: false,
  };
}

/** 新建一个系列，附赠第 1 集：系列没有集就没有意义。 */
export function makeSeries(name: string, style = ''): Series {
  const date = new Date().toISOString();
  return {
    id: uid(),
    name: name.trim() || '未命名系列',
    createdAt: date,
    updatedAt: date,
    aspect: DEFAULT_ASPECT,
    resolution: DEFAULT_RESOLUTION,
    episodes: [makeEpisode(1, '', style)],
  };
}

/** 系列里下一个可用集号：取最大值 +1，删掉中间几集也不会撞号。 */
export function nextEpisodeNumber(series: Pick<Series, 'episodes'>): number {
  return series.episodes.reduce((max, episode) => Math.max(max, episode.number), 0) + 1;
}

/**
 * 旧作品 → 单集系列。
 *
 * 数据原样带入（镜头、资产、剧本、提示词覆盖层都不动），只补上系列与集数两层壳。
 * 集 id 重新生成：系列 id 与集 id 是两个命名空间，沿用旧作品 id 会让删除系列/定位集
 * 这类操作在两套 id 之间串味。镜头与资产内部的 id 全部保留。
 * 画幅与分辨率按约定取 9:16 + 720p。
 */
export function episodeFromProject(project: Project): Episode {
  return {
    ...project,
    id: uid(),
    number: 1,
    title: project.name,
    name: project.name,
    legacySpec: true,
  };
}

export function seriesFromProject(project: Project): Series {
  return {
    id: uid(),
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    aspect: DEFAULT_ASPECT,
    resolution: DEFAULT_RESOLUTION,
    episodes: [episodeFromProject(project)],
  };
}

/**
 * 迁移失败就整批抛出，由调用方把旧数据原样留着并让用户看到错误——
 * 不允许「迁一半」这种既没有旧数据也没有新数据的状态。
 */
export function migrateProjectsToSeries(projects: Project[]): Series[] {
  const seen = new Set<string>();
  return projects.map(project => {
    if (!project || typeof project !== 'object' || !project.id) {
      throw new Error('旧作品数据缺少 id，无法迁移。旧数据已原样保留，请先备份浏览器数据。');
    }
    if (seen.has(project.id)) {
      throw new Error(`旧作品 id 重复（${project.id}），无法安全迁移。旧数据已原样保留。`);
    }
    seen.add(project.id);
    const series = seriesFromProject(project);
    if (!series.episodes.length) throw new Error(`作品「${project.name || project.id}」迁移后没有任何集数。旧数据已原样保留。`);
    return series;
  });
}

/** 在系列里定位一集；找不到返回 undefined。 */
export function findEpisode(series: Series | undefined, episodeId: string | null): Episode | undefined {
  if (!series || !episodeId) return undefined;
  return series.episodes.find(episode => episode.id === episodeId);
}

/** 按集号排序的副本：界面上的集数列表永远按集号升序。 */
export function sortedEpisodes(series: Series): Episode[] {
  return [...series.episodes].sort((a, b) => a.number - b.number);
}
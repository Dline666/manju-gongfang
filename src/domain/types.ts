export type Provider = 'gemini' | 'deepseek' | 'openai' | 'seedream' | 'siliconflow' | 'seedance' | 'minimax';
export type Stage = 'library' | 'script' | 'assets' | 'director' | 'storyboard' | 'generation' | 'export' | 'settings';
export type AssetKind = 'character' | 'scene' | 'prop' | 'voice';
export type SkillId = 'script' | 'storyboard' | 'image' | 'video';
export interface Asset {
  id: string; kind: AssetKind; name: string; description: string; lock: string;
  imageId?: string; voiceId?: string; voiceAssetId?: string; speed?: number; locked?: boolean;
}
/** 一句台词。speaker 是剧本里写下的说话人名字；speakerId 是它关联到的人物资产（提取或手动建人物后才有）。 */
export interface Dialogue { id: string; speakerId: string; speaker?: string; text: string }
export interface Reference { assetId: string; role: 'reference_image' | 'first_frame' | 'last_frame' }
export interface VideoSource { name: string; url?: string; duration: number; origin: 'upload' | 'link' | 'api' }
export interface AudioSource { mediaId: string; name: string; duration: number }
export interface VideoTask {
  provider: 'seedance' | 'minimax'; model: string; id?: string;
  status: 'submitting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
  revision: number; error?: string; createdAt: string;
}
export interface Shot {
  id: string; number: number; duration: number; visual: string; camera: string;
  start: string; action: string; end: string; dialogues: Dialogue[];
  assetIds: string[]; references: Reference[]; video?: VideoSource; audio?: AudioSource;
  audioMode: 'original' | 'dubbing' | 'silent'; task?: VideoTask; stale?: boolean; staleReason?: string;
  title?: string; scene?: string;
  /** 剧本里为这一镜指定的画面类型（如「远景→摇镜」）；导演步骤必须落实。 */
  cameraHint?: string;
}
export interface Confirmed {
  script?: number; assets?: number; director?: number;
}
export interface StyleSpec {
  medium?: string; line?: string; palette?: string; face?: string; light?: string;
  forbidden?: string[];
}
/** 提示词模板对应的生成步骤。资产提取按品类分三个 kind，各自独立。 */
export type PromptKindId = 'script' | 'extract-characters' | 'extract-scenes' | 'extract-props' | 'director' | 'image' | 'video';
/** 数据块的数据来源：这些是作品数据，不是系统文案。 */
export type PromptDataSource =
  | 'script.theme' | 'script.source' | 'script.characters' | 'script.skills'
  | 'extract.characters.shots' | 'extract.characters.existing'
  | 'extract.scenes.shots' | 'extract.scenes.existing'
  | 'extract.props.shots' | 'extract.props.existing'
  | 'director.shots' | 'director.skills'
  | 'image.task' | 'image.subject' | 'image.style' | 'image.skills'
  | 'video.heading' | 'video.continuity' | 'video.references' | 'video.action'
  | 'video.dialogue' | 'video.audio' | 'video.assets' | 'video.style' | 'video.skills';
/** 用户在模板编辑器里排好的一块。text 是用户写的正文；source 是数据来源（数据块）。 */
export interface PromptBlockPlan { id: string; title: string; text: string; source?: PromptDataSource; builtin?: string }
/** 一个 kind 的完整块计划，顺序即发送顺序。 */
export interface PromptTemplatePlan { blocks: PromptBlockPlan[] }
export interface PromptConfig {
  v: 1 | 2;
  style?: StyleSpec;
  /** v1 旧结构：块 id → 覆盖文本。载入时迁移成 v2 的 templates。 */
  blocks?: Record<string, string>;
  /** v2：每个 kind 一份块计划。 */
  templates?: Partial<Record<PromptKindId, PromptTemplatePlan>>;
}
export interface Project {
  id: string; name: string; theme: string; style: string; createdAt: string; updatedAt: string;
  revision: number; skills: SkillId[]; shots: Shot[]; assets: Asset[]; source: 'empty' | 'template' | 'import' | 'ai';
  storyboardReady: boolean;
  promptConfig?: PromptConfig;
  confirmed?: Confirmed;
  logline?: string;
  scriptMode?: 'theme' | 'source';
  sourceText?: string;
  /** 完整剧本正文（Markdown）；镜头由它解析得到。 */
  screenplay?: string;
}
export interface Settings {
  scriptProvider: 'gemini' | 'deepseek'; imageProvider: 'openai' | 'seedream' | 'siliconflow'; videoProvider: 'seedance' | 'minimax';
  models: Record<Provider, string>; speechModel: string;
  imageConcurrency?: number;
}
export interface ProviderStatus { status: 'available' | 'failed'; action: string; model?: string; error?: string; hint?: string }
export interface StudioState {
  version: 1; projects: Project[]; activeId: string | null; settings: Settings;
  keys: Partial<Record<Provider, string>>; providerStatus: Partial<Record<Provider, ProviderStatus>>; storageError: string | null;
}
export interface PageProps { project: Project; navigate: (stage: Stage) => void }
export const uid = () => crypto.randomUUID();
/** 原文模式一次可发送的原文上限；超过会让提示词预算与模型注意力都失控。 */
export const MAX_SOURCE_CHARS = 12000;
export const defaultStyle = '东方玄幻水墨风，冷灰 + 金色灵光';
export const defaultSettings: Settings = {
  scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance',
  models: { gemini: 'gemini-4-hydrogen', deepseek: 'deepseek-flash', openai: 'gpt-image-2.6-sunburst', seedream: 'doubao-seedream-5-5-261028', siliconflow: 'Kwai-Kolors/Kolors', seedance: 'doubao-seedance-2-0-fast-260128', minimax: 'MiniMax-H3' },
  speechModel: 'speech-2.8-hd',
};
export function makeShot(number: number): Shot {
  return { id: uid(), number, duration: 9, visual: '', camera: '缓慢推进', start: '', action: '', end: '', dialogues: [], assetIds: [], references: [], audioMode: 'original' };
}
/** 说话人名字：已关联的人物资产优先，否则用剧本里记下的名字。 */
export function speakerName(project: Project, line: Dialogue): string {
  return project.assets.find(asset => asset.id === line.speakerId)?.name || line.speaker || '';
}

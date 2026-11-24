export type ProviderProtocol = 'gemini' | 'deepseek' | 'openai' | 'seedream' | 'siliconflow' | 'seedance' | 'minimax' | 'openai-compatible';
export type Stage = 'library' | 'script' | 'assets' | 'director' | 'storyboard' | 'generation' | 'export' | 'settings';
export type AssetKind = 'character' | 'scene' | 'prop' | 'voice';
export type SkillId = 'script' | 'storyboard' | 'image' | 'video';
/** 端点能承担的环节。 */
export type Capability = 'script' | 'image' | 'video' | 'speech';
/**
 * 一个模型端点。内置平台与用户自填的 OpenAI 兼容服务是同一种东西，
 * 在设置页里是同一份清单，都可删除。id 不得包含 ':'（select 用它编码取值）。
 */
export interface Endpoint {
  id: string; name: string; protocol: ProviderProtocol;
  baseUrl?: string; capabilities: Capability[]; builtin?: boolean;
  /** 端点用途说明（显示在设置页卡片上）。 */
  use?: string;
  /** 内置端点的生图并发默认值。 */
  defaultConcurrency?: number;
}
export interface Asset {
  id: string; kind: AssetKind; name: string; description: string; lock: string;
  imageId?: string; voiceId?: string; voiceAssetId?: string; speed?: number; locked?: boolean;
  /** 挂载的参考图来源：生成时把这个资产当前的设定图作为图生图参考；为空表示纯文本生成。 */
  referenceAssetId?: string;
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
/** 提示词模板对应的生成步骤。资产提取按品类分三个 kind，设定图也按人物/场景/道具分三个 kind，各自独立。 */
export type PromptKindId = 'script' | 'extract-characters' | 'extract-scenes' | 'extract-props' | 'director' | 'image-character' | 'image-scene' | 'image-prop' | 'video';
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
/**
 * 模板按 kind 存一份。
 * `image` 是旧结构：人物 / 场景 / 道具共用一份设定图模板，载入时拆成 image-character / image-scene / image-prop 三份。
 */
export type PromptTemplateMap = Partial<Record<PromptKindId, PromptTemplatePlan>> & { image?: PromptTemplatePlan };
/** 一套提示词模板：风格 + 每个 kind 一份块计划。全局默认与作品覆盖层都用这个形状。 */
export interface PromptTemplateSet {
  style?: StyleSpec;
  templates?: PromptTemplateMap;
}
/** v1 旧结构：块 id → 覆盖文本。载入时迁移成 v2 的 templates。 */
export interface PromptConfigV1 { v: 1; style?: StyleSpec; blocks?: Record<string, string> }
/** v2：每个 kind 一份块计划。 */
export interface PromptConfigV2 { v: 2; style?: StyleSpec; templates?: PromptTemplateMap }
/**
 * v3：本作品的覆盖层。
 * `overrides` 里键存在 = 这一步归本作品管（块可以为空，表示「这一步我不写任何块」）；
 * 没有的键跟随全局模板。作品只存覆盖层，不复制全局全文。
 */
export interface PromptConfigV3 {
  v: 3;
  style?: StyleSpec;
  templates?: PromptTemplateMap;
  overrides?: PromptTemplateSet;
}
export type PromptConfig = PromptConfigV1 | PromptConfigV2 | PromptConfigV3;
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
  /** 各步骤当前选中的端点 id。 */
  scriptProvider: string; imageProvider: string; videoProvider: string;
  /** 用户当前可见的端点清单：内置平台 + 自定义端点，删掉的就不在这里。 */
  endpoints: Endpoint[];
  /** 端点 id → 能力 → 模型 ID。一个端点可同时管剧本与生图，两者模型不同。 */
  models: Record<string, Partial<Record<Capability, string>>>;
  speechModel: string;
  imageConcurrency?: number;
  /** 自定义文本端点是否发送 response_format（老中转站不支持时可关）。 */
  customJsonMode?: boolean;
  /** 用户自定义的视觉风格名称，存本机，所有作品都能选用。 */
  styles?: string[];
  /** 全局默认提示词模板：所有作品跟随，被作品覆盖的那一步除外。 */
  promptTemplates?: PromptTemplateSet;
}
export interface ProviderStatus { status: 'available' | 'failed'; action: string; model?: string; error?: string; hint?: string }
export interface StudioState {
  version: 1; projects: Project[]; activeId: string | null; settings: Settings;
  keys: Record<string, string>; providerStatus: Record<string, ProviderStatus>; storageError: string | null;
}
export interface PageProps { project: Project; navigate: (stage: Stage) => void }
export const uid = () => crypto.randomUUID();
/** 原文模式一次可发送的原文上限；超过会让提示词预算与模型注意力都失控。 */
export const MAX_SOURCE_CHARS = 12000;
export const defaultStyle = '东方玄幻水墨风，冷灰 + 金色灵光';
/** 内置视觉风格：系统给的起手式，用户可在剧本页自建更多。 */
export const builtinStyles: string[] = [defaultStyle, '清新日系动画，柔和色彩与自然光', '电影写实风，克制配色与戏剧光影'];

/**
 * 内置端点目录：平台清单的唯一来源（协议、默认模型、默认并发、展示名、能力都写在这里）。
 * id 沿用旧的 provider 名，所以旧存档里的 models 与各步骤选择可以原样当端点 id 用。
 */
export function builtinEndpoints(): Endpoint[] {
  return [
    { id: 'gemini', name: 'Google Gemini', protocol: 'gemini', capabilities: ['script'], builtin: true, use: '剧本生成 · 首选' },
    { id: 'deepseek', name: 'DeepSeek', protocol: 'deepseek', capabilities: ['script'], builtin: true, use: '剧本生成 · 备选' },
    { id: 'openai', name: 'OpenAI', protocol: 'openai', capabilities: ['image'], builtin: true, use: '人物、场景与参考图' },
    { id: 'seedream', name: '火山引擎 / 即梦 · Seedream', protocol: 'seedream', capabilities: ['image'], builtin: true, use: '人物、场景与参考图 · 需要火山方舟 Key' },
    { id: 'siliconflow', name: '硅基流动 SiliconFlow（免费）', protocol: 'siliconflow', capabilities: ['image'], builtin: true, use: 'Kolors · 免费额度，国内直连', defaultConcurrency: 2 },
    { id: 'seedance', name: '火山引擎 Seedance', protocol: 'seedance', capabilities: ['video'], builtin: true, use: '视频生成 · 首选' },
    { id: 'minimax', name: 'MiniMax 国内版', protocol: 'minimax', capabilities: ['video', 'speech'], builtin: true, use: 'H3 视频 · 中文配音 · 仅支持国内开放平台 Key' },
  ];
}
/** 内置端点的默认模型 ID：端点 id → 能力 → 模型 ID。 */
export function defaultModels(): Settings['models'] {
  return {
    gemini: { script: 'gemini-4-hydrogen' },
    deepseek: { script: 'deepseek-flash' },
    openai: { image: 'gpt-image-2.6-sunburst' },
    seedream: { image: 'doubao-seedream-5-5-261028' },
    siliconflow: { image: 'Kwai-Kolors/Kolors' },
    seedance: { video: 'doubao-seedance-2-0-fast-260128' },
    minimax: { video: 'MiniMax-H3' },
  };
}
export const defaultSettings: Settings = {
  scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance',
  endpoints: builtinEndpoints(),
  models: defaultModels(),
  speechModel: 'speech-2.8-hd',
  styles: [],
};
export function makeShot(number: number): Shot {
  return { id: uid(), number, duration: 9, visual: '', camera: '缓慢推进', start: '', action: '', end: '', dialogues: [], assetIds: [], references: [], audioMode: 'original' };
}
/** 说话人名字：已关联的人物资产优先，否则用剧本里记下的名字。 */
export function speakerName(project: Project, line: Dialogue): string {
  return project.assets.find(asset => asset.id === line.speakerId)?.name || line.speaker || '';
}

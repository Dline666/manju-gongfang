export type ProviderProtocol = 'gemini' | 'deepseek' | 'openai' | 'seedream' | 'siliconflow' | 'seedance' | 'minimax' | 'openai-compatible';
export type Stage = 'library' | 'script' | 'assets' | 'director' | 'storyboard' | 'generation' | 'export' | 'settings';
export type AssetKind = 'character' | 'scene' | 'prop' | 'voice';
export type SkillId = 'script' | 'storyboard' | 'image' | 'video' | 'novel' | 'novel-to-screenplay' | 'screenplay-to-storyboard-json';
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
  /** 代称：同一个人在原文里的其它叫法（小青、青儿）。 */
  aliases?: string[];
}
/** 剧本步骤顺带产出的资产：模型给的形状，落地时转成 Asset。 */
export interface ScriptAsset {
  id: string; name: string; aliases: string[]; description: string; lock: string;
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
  /** 本镜的画面主体资产 id（其余在场的放在 assetIds 里）。视频提示词据此区分主体与背景。 */
  subjects?: string[];
  /** 剧本里为这一镜指定的画面类型（如「远景→摇镜」）；导演步骤必须落实。 */
  cameraHint?: string;
  /**
   * 导入分镜 JSON 时的连续性锁（endState）：空间、位置、光线、道具、情绪。
   * 存成结构化的一段文本，视频提示词的连续性段落直接引用它，不引入新的字段结构。
   */
  continuity?: string;
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
  | 'director.screenplay' | 'director.skills' | 'director.assets'
  | 'image.task' | 'image.subject' | 'image.style' | 'image.skills'
  | 'video.heading' | 'video.visual' | 'video.continuity' | 'video.references' | 'video.action'
  | 'video.dialogue' | 'video.audio' | 'video.assets' | 'video.style' | 'video.skills';
/**
 * 用户在模板编辑器里排好的一块。text 是用户写的正文；source 是数据来源（数据块）。
 * enabled=false 表示这一块暂时不用（内容留着，只是不进提示词）；note 是这一块的说明（新增/变更）。
 */
export interface PromptBlockPlan { id: string; title: string; text: string; source?: PromptDataSource; builtin?: string; shared?: boolean; enabled?: boolean; note?: string }
/**
 * 一份 Skill：可复用的提示词配方，正文由用户自己写。
 * 库里一份写一次，可以被多个步骤引用；正文留空等于没写（不会进提示词）。
 */
export interface SkillSpec {
  id: string;
  name: string;
  /** 正文。为空表示这份 Skill 还没写内容。 */
  template: string;
  /** 适用步骤；空数组 = 所有步骤都能选它。 */
  kinds: PromptKindId[];
}
/** 一个 kind 的完整块计划，顺序即发送顺序。skill 是这一步固定选中的 Skill（引用 Skill 库里的 id）。 */
export interface PromptTemplatePlan { blocks: PromptBlockPlan[]; skill?: string }
/**
 * 模板按 kind 存一份。
 * `image` 是旧结构：人物 / 场景 / 道具共用一份设定图模板，载入时拆成 image-character / image-scene / image-prop 三份。
 */
export type PromptTemplateMap = Partial<Record<PromptKindId, PromptTemplatePlan>> & { image?: PromptTemplatePlan };
/** 一套提示词模板：风格 + 每个 kind 一份块计划 + 全局 Skill 库。全局默认与作品覆盖层都用这个形状。 */
export interface PromptTemplateSet {
  style?: StyleSpec;
  templates?: PromptTemplateMap;
  /** Skill 库：全局唯一，所有作品共用。 */
  skills?: SkillSpec[];
  /**
   * 内置 Skill 的可改副本：内置 Skill id → 正文。
   * 用户可以在模板编辑器里改内置 Skill 的正文，改坏了能一键恢复出厂文案；
   * 没改过的内置 Skill 仍用出厂文案。
   */
  builtinSkills?: Record<string, string>;
  /**
   * 被用户主动关掉的内置 Skill id。
   * 关掉不等于删除：正文档还在，随时能再打开。这是「可开关」的落地点。
   */
  disabledBuiltinSkills?: string[];
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
  /**
   * 这份剧本按哪个镜数/时长规格校验过。
   * 有值 = 新规格（校验不通过会被拦住）；没值 = 新规格之前存下来的旧作品，只提示不阻断。
   */
  specVersion?: string;
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
/**
 * 会持久化的那一部分状态。
 *
 * 现在是「系列 → 集」两层（v2）。keys 与 providerStatus 只在内存里，不属于存档形状，
 * 但设置页会读它们，所以仍在这里声明。
 * 用 type-only 导入 Series：`domain/series` 反过来 import 本文件，运行时不产生循环依赖。
 */
export interface StudioState {
  version: 2; series: import('./series').Series[]; activeSeriesId: string | null; activeEpisodeId: string | null; settings: Settings;
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
/**
 * 出厂 Skill 库。
 *
 * 每个步骤先留一个空的槽位，正文由用户自己写——系统不预置任何 Skill 文案，
 * 空正文也不会进提示词。名字只是槽位标签，随时可以改。
 */
export const defaultSkillLibrary: SkillSpec[] = [
  { id: 'skill.novel-to-screenplay', name: '小说转剧本', template: '', kinds: ['script'] },
  { id: 'skill.screenplay-to-storyboard', name: '剧本生分镜', template: '', kinds: ['director'] },
  { id: 'skill.extract-characters', name: '人物提取', template: '', kinds: ['extract-characters'] },
  { id: 'skill.extract-scenes', name: '场景提取', template: '', kinds: ['extract-scenes'] },
  { id: 'skill.extract-props', name: '道具提取', template: '', kinds: ['extract-props'] },
  { id: 'skill.image-character', name: '人物设定图', template: '', kinds: ['image-character'] },
  { id: 'skill.image-scene', name: '场景设定图', template: '', kinds: ['image-scene'] },
  { id: 'skill.image-prop', name: '道具设定图', template: '', kinds: ['image-prop'] },
  { id: 'skill.video-shot', name: '镜头视频', template: '', kinds: ['video'] },
];

/**
 * 出厂全局模板。
 *
 * 这里的每一句都是用户自己写的（资产提取规则 + 设定图出图约定），系统不替用户编造规则。
 * 出图约定故意不放进资产提取规则里：固定短语会逐字进视频提示词，
 * 「纯白背景」「3D风格」这类只属于设定图的话进了视频提示词会误导视频模型。
 * 用户可以在模板编辑器里随时改或删。
 */
export const defaultPromptTemplates: PromptTemplateSet = {
  skills: defaultSkillLibrary,
  templates: {
    script: { blocks: [
      { id: 'script.shot-spec', title: '镜数与时长（硬性）', builtin: 'script.shot-spec', note: '2026-11-25 新增：镜数与时长的硬性要求。生成后会按它校验，不合格的会被拦住并自动重试一次。', text: [
        '镜数与时长是硬性要求，先定镜数再写内容：',
        '1. 全片只输出 4、5 或 6 镜；镜号从 1 连续到末镜，不跳号也不重号。',
        '2. 每镜第一行写镜头标记与显式时长，格式：【镜头1：远景】（时长12s）。时长必须是 10–15 秒的整数；没写时长标记视为不合格。',
        '3. 每镜的内容要写够这个时长：正常对白按 5–6 字/秒，10 秒一镜至少约 50 字台词；或写 6–7 个动作点（每点约 1.5 秒）。不能一句台词加一个动作就标 12 秒。',
        '4. 台词要在本镜结束前至少 0.3 秒说完，不要把台词压到镜头末尾。',
        '5. 剧本末尾加一行时长自检，写明各镜时长与合计；合计必须等于各镜时长之和，总时长落在 40–90 秒。',
        '6. 只输出剧本本身，不解释、不写多余段落。',
      ].join('\n') },
      { id: 'script.characters.extract', title: '人物 · 提取规则', builtin: 'script.characters.extract', text: [
        '1.1 根据我发给你的这篇文章，帮我整理出所有角色形象，需要包含人物性别、穿着、脸部特征、年龄、身高以及人物性格等。',
        '1.2 根据提供的小说原文，推导出文中出现过的人物。人物可能有多种代称，要囊括文中提到的所有人物，包括「我」。每个人物包含名字、代称（多个代称用逗号分割）、形象描述三个字段。',
        '1.3 人物形象必须包含具体年龄、性别、发色、发型、脸部特征、上身服装、下身服装、鞋子款式、身高；每个输出结果必须有不一样的着装，需要更好分辨。',
        '1.4 不要用表格输出。',
      ].join('\n') },
      { id: 'script.scenes.extract', title: '场景 · 提取规则', builtin: 'script.scenes.extract', text: [
        '请根据以下剧本内容提取场景，并为每个场景生成一个场景名和场景描述。',
        '要求：场景描述只写环境、建筑、器物、光线、氛围等空间要素，不出现任何人物、人物动作或人物对白。',
        '若多个镜头标注为同一「所属空间」，请归并为一个场景输出；若分属不同空间，则按空间分别输出。',
      ].join('\n') },
      { id: 'script.props.extract', title: '道具 · 提取规则', builtin: 'script.props.extract', text: [
        '请根据以下剧本内容提取关键道具，并为每个道具生成道具名和道具描述。',
        '要求：道具描述只写道具的形制、材质、尺寸比例、颜色、纹理、磨损或特殊标记、使用痕迹等可视特征，不出现人物、人物动作或人物对白。',
        '若同一道具在多个镜头中出现，请合并为一个道具条目；若道具仅被提及但无可见形制，可标注「需设计」并给出合理造型建议。',
      ].join('\n') },
    ] },
    'image-character': { blocks: [
      { id: 'image.character.three-view', title: '人物三视图条款', builtin: 'image.character.three-view', text: [
        '全部为正面站立全身形象图。',
        '图片风格为「3D风格」，并在提示词中加入「3D风格」这句话。',
        '图片人物背景为纯白，手中不拿武器等道具。',
      ].join('\n') },
    ] },
    'image-scene': { blocks: [
      { id: 'image.scene.composition', title: '场景构图说明', builtin: 'image.scene.composition', text: '画面为干净的空镜场景图，不出现任何人物。' },
    ] },
    'image-prop': { blocks: [
      { id: 'image.prop.composition', title: '道具构图说明', builtin: 'image.prop.composition', text: '画面为干净的单一道具展示图，背景简洁中性。' },
    ] },
  },
};

export const defaultSettings: Settings = {
  scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance',
  endpoints: builtinEndpoints(),
  models: defaultModels(),
  speechModel: 'speech-2.8-hd',
  styles: [],
  promptTemplates: defaultPromptTemplates,
};
export function makeShot(number: number): Shot {
  return { id: uid(), number, duration: 9, visual: '', camera: '缓慢推进', start: '', action: '', end: '', dialogues: [], assetIds: [], references: [], audioMode: 'original' };
}
/** 说话人名字：已关联的人物资产优先，否则用剧本里记下的名字。 */
export function speakerName(project: Project, line: Dialogue): string {
  return project.assets.find(asset => asset.id === line.speakerId)?.name || line.speaker || '';
}

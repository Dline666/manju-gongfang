import { z } from 'zod';
import { defaultSettings } from '../domain/types';
const capability = z.enum(['script', 'image', 'video', 'speech']);
const endpoint = z.object({ id: z.string(), name: z.string(), protocol: z.enum(['gemini', 'deepseek', 'openai', 'seedream', 'siliconflow', 'seedance', 'minimax', 'openai-compatible']), baseUrl: z.string().optional(), capabilities: z.array(capability).min(1), builtin: z.boolean().optional(), use: z.string().optional(), defaultConcurrency: z.number().int().min(1).max(5).optional() });
// models 的键是端点 id（不再限于内置平台），值是「能力 → 模型 ID」；
// 旧存档是扁平的 {端点id: 模型ID}，由 migrateSettings 迁移，这里先放宽到 unknown。
const models = z.record(z.string(), z.unknown()).optional();
const asset = z.object({id:z.string(),kind:z.enum(['character','scene','prop','voice']),name:z.string(),description:z.string(),lock:z.string(),imageId:z.string().optional(),voiceId:z.string().optional(),voiceAssetId:z.string().optional(),referenceAssetId:z.string().optional(),speed:z.number().finite().optional(),locked:z.boolean().optional(),aliases:z.array(z.string()).optional()});
const shot = z.object({id:z.string(),number:z.number().int(),duration:z.number().finite(),visual:z.string(),camera:z.string(),start:z.string(),action:z.string(),end:z.string(),dialogues:z.array(z.object({id:z.string(),speakerId:z.string(),speaker:z.string().optional(),text:z.string()})),assetIds:z.array(z.string()),references:z.array(z.object({assetId:z.string(),role:z.enum(['reference_image','first_frame','last_frame'])})),audioMode:z.enum(['original','dubbing','silent']),stale:z.boolean().optional(),staleReason:z.string().optional(),title:z.string().optional(),scene:z.string().optional(),cameraHint:z.string().optional(),continuity:z.string().optional(),subjects:z.array(z.string()).optional(),video:z.object({name:z.string(),url:z.string().url().refine(url=>url.startsWith('https://')).optional(),duration:z.number().finite().positive(),origin:z.enum(['upload','link','api'])}).optional(),audio:z.object({mediaId:z.string(),name:z.string(),duration:z.number().finite().positive()}).optional(),task:z.object({provider:z.enum(['seedance','minimax']),model:z.string(),id:z.string().optional(),status:z.enum(['submitting','queued','running','succeeded','failed','unknown']),revision:z.number().int(),error:z.string().optional(),createdAt:z.string()}).optional()});
const styleSpec = z.object({medium:z.string().optional(),line:z.string().optional(),palette:z.string().optional(),face:z.string().optional(),light:z.string().optional(),forbidden:z.array(z.string()).optional()});
const promptDataSource=z.enum(['script.theme','script.source','script.characters','script.skills','extract.characters.shots','extract.characters.existing','extract.scenes.shots','extract.scenes.existing','extract.props.shots','extract.props.existing','director.screenplay','director.skills','director.assets','image.task','image.subject','image.style','image.skills','video.heading','video.visual','video.continuity','video.references','video.action','video.dialogue','video.audio','video.assets','video.style','video.skills']);
const promptBlockPlan=z.object({id:z.string(),title:z.string(),text:z.string(),source:promptDataSource.optional(),builtin:z.string().optional(),shared:z.boolean().optional(),enabled:z.boolean().optional(),note:z.string().optional()});
const promptTemplatePlan=z.object({blocks:z.array(promptBlockPlan),skill:z.string().optional()});
// Skill 库：全局一份，所有作品共用。正文由用户写，留空等于没写。
const skillSpec=z.object({id:z.string(),name:z.string(),template:z.string(),kinds:z.array(z.enum(['script','extract-characters','extract-scenes','extract-props','director','image-character','image-scene','image-prop','video']))});
// 模板按 kind 存一份。`image` 是旧结构：人物/场景/道具共用一份设定图模板，
// 载入时迁移成 image-character / image-scene / image-prop 三份，所以 schema 仍然收它。
const promptTemplateMap=z.object({script:promptTemplatePlan.optional(),'extract-characters':promptTemplatePlan.optional(),'extract-scenes':promptTemplatePlan.optional(),'extract-props':promptTemplatePlan.optional(),director:promptTemplatePlan.optional(),image:promptTemplatePlan.optional(),'image-character':promptTemplatePlan.optional(),'image-scene':promptTemplatePlan.optional(),'image-prop':promptTemplatePlan.optional(),video:promptTemplatePlan.optional()});
const promptConfigV1=z.object({v:z.literal(1),style:styleSpec.optional(),blocks:z.record(z.string(),z.string()).optional()});
const promptConfigV2=z.object({v:z.literal(2),style:styleSpec.optional(),templates:promptTemplateMap.optional()});
// v3：作品覆盖层。overrides 里键存在 = 这一步归本作品管，没有的键跟随全局模板。
const promptTemplateSet=z.object({style:styleSpec.optional(),templates:promptTemplateMap.optional(),skills:z.array(skillSpec).optional(),builtinSkills:z.record(z.string(),z.string()).optional(),disabledBuiltinSkills:z.array(z.string()).optional()});
const promptConfigV3=z.object({v:z.literal(3),style:styleSpec.optional(),templates:promptTemplateMap.optional(),overrides:promptTemplateSet.optional()});
const promptConfig=z.union([promptConfigV3,promptConfigV2,promptConfigV1]);
const confirmed=z.object({script:z.number().optional(),assets:z.number().optional(),director:z.number().optional()});
const settings=z.object({scriptProvider:z.string().default('gemini'),imageProvider:z.string().default('openai'),videoProvider:z.string().default('seedance'),endpoints:z.array(endpoint).optional(),models,speechModel:z.string(),imageConcurrency:z.number().int().min(1).max(5).optional(),customJsonMode:z.boolean().optional(),styles:z.array(z.string()).optional(),promptTemplates:promptTemplateSet.optional()});

/**
 * v1 的「作品」形状。保留它是为了两件事：
 * 1. 旧存档仍然能被读进来（载入时迁移成系列的单集）；
 * 2. Episode 在这个形状上扩展，于是按 Project 写的纯函数可以原样接收一集。
 */
const project=z.object({id:z.string(),name:z.string(),theme:z.string(),style:z.string(),createdAt:z.string(),updatedAt:z.string(),revision:z.number().int(),skills:z.array(z.enum(['script','storyboard','image','video'])),shots:z.array(shot),assets:z.array(asset),source:z.enum(['empty','template','import','ai']),storyboardReady:z.boolean(),promptConfig:promptConfig.optional(),confirmed:confirmed.optional(),logline:z.string().optional(),scriptMode:z.enum(['theme','source']).optional(),sourceText:z.string().optional(),screenplay:z.string().optional(),specVersion:z.string().optional()});

/** v2 的「集」：Project 的全部字段 + 集号/集标题/小说/分镜 JSON 原文。 */
const episode=project.extend({
  number:z.number().int().min(1),
  title:z.string(),
  novel:z.string().optional(),
  // 注意：Episode 接口上的 screenplay 与 Project 上的同名同义，这里不重复声明。
  storyboardJson:z.string().optional(),
  legacySpec:z.boolean().optional(),
});

/** v2 的「系列」：画幅与分辨率按系列定一次。 */
const series=z.object({
  id:z.string(),
  name:z.string(),
  createdAt:z.string(),
  updatedAt:z.string(),
  aspect:z.enum(['9:16','16:9']),
  resolution:z.enum(['720p','1080p']),
  episodes:z.array(episode),
  style:z.string().optional(),
  promptConfig:promptConfig.optional(),
  skillOverrides:promptTemplateSet.optional(),
});

/** v1 存档：只读不写，用来把旧数据迁过来。 */
export const savedStudioSchema=z.object({version:z.literal(1),projects:z.array(project),activeId:z.string().nullable(),settings});

/**
 * v2 存档：系列列表 + 当前系列/当前集。
 *
 * 存储键仍然是 `manju-studio-v1`——换键会让旧数据在新版本里凭空消失，
 * 那是比「版本号对齐」严重得多的问题。键名保留，里面的 version 升到 2。
 */
export const savedStudioSchemaV2=z.object({
  version:z.literal(2),
  series:z.array(series),
  activeSeriesId:z.string().nullable(),
  activeEpisodeId:z.string().nullable(),
  settings,
});

/** 载入时先试 v2；不是 v2 就按 v1 走迁移。 */
export function parseSavedStudio(raw: unknown) {
  const v2 = savedStudioSchemaV2.safeParse(raw);
  if (v2.success) return { version: 2 as const, data: v2.data };
  return { version: 1 as const, data: savedStudioSchema.parse(raw) };
}

export { episode as episodeSchema, series as seriesSchema, settings as settingsSchema };
export type SavedSettings = z.infer<typeof settings>;
export { defaultSettings };
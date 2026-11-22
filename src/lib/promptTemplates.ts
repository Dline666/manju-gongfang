import type { Project, StyleSpec } from '../domain/types';
import { SCRIPT_OUTPUT_EXAMPLE } from './promptSpec';

export type TemplateId = 'script' | 'assets' | 'director' | 'image' | 'video';

export interface TemplateBlockDef {
  id: string;
  label: string;
  locked?: boolean;
  reason?: string;
  defaultText: string | ((style: StyleSpec) => string);
}

export interface TemplateDef {
  id: TemplateId;
  title: string;
  description: string;
  blocks: TemplateBlockDef[];
}

export const allowedVariables = [
  'project.theme', 'project.name', 'project.style',
  'style.medium', 'style.line', 'style.palette', 'style.face', 'style.light', 'style.forbidden',
] as const;
export type PromptVariable = typeof allowedVariables[number];

export function promptVariables(project: Project, style: StyleSpec): Record<PromptVariable, string> {
  return {
    'project.theme': project.theme || '',
    'project.name': project.name || '',
    'project.style': project.style || '',
    'style.medium': style.medium || '',
    'style.line': style.line || '',
    'style.palette': style.palette || '',
    'style.face': style.face || '',
    'style.light': style.light || '',
    'style.forbidden': (style.forbidden || []).join('、'),
  };
}

const variablePattern = /\{\{([\w.]+)\}\}/g;
export function findUnknownVariables(text: string): string[] {
  const unknown = new Set<string>();
  for (const match of text.matchAll(variablePattern)) if (!(allowedVariables as readonly string[]).includes(match[1])) unknown.add(match[1]);
  return [...unknown];
}
export function applyVariables(text: string, vars: Record<string, string>): string {
  return text.replace(variablePattern, (full, name: string) => vars[name] ?? full);
}

export function defaultStyleSpec(style: string): StyleSpec {
  if (style.includes('水墨')) return {
    medium: '宣纸质感的水墨淡彩，半写意；墨分焦、浓、重、淡、清五色；留白占画面 20–35%；可见纸纹与洇墨边缘',
    line: '中锋勾勒为主，墨线随轮廓粗细变化；人物衣纹用兰叶描；山石用披麻皴或斧劈皴；不用均匀矢量线，不用赛璐璐硬边',
    palette: '主色冷灰 #5B6168、墨黑 #1C1D1F、宣纸白 #E9E6DD；唯一强调色金色灵光 #D4AF6A，只用于灵力、断口微光、门环，面积不超过画面 8%；禁止大面积高饱和色',
    face: '东方面孔；淡墨渲染明暗；单线眉眼，眼小含神；无写实皮肤纹理，无磨皮高光，无 3D 渲染感，无美漫大眼',
    light: '柔和散射光；金色灵光是唯一点光源；云海与雾用留白表现',
    forbidden: ['水印', '署名', '字幕', '文字', '手机、塑料、拉链等现代物品', '西式盔甲', '霓虹', '3D 与 CG 质感', '照片写实', '多余肢体、畸形手指'],
  };
  if (style.includes('日系')) return {
    medium: '赛璐璐平涂的二次元动画质感，清晰线稿',
    line: '干净均匀的描线，线条粗细稳定，不糊边',
    palette: '柔和低饱和；主色浅蓝、暖白、淡粉，避免荧光色与大块纯黑',
    face: '日系五官比例，大眼睛但高光克制，肤色均匀，避免写实毛孔',
    light: '自然光与柔和逆光，室内暖光，阴影边缘清晰',
    forbidden: ['水印', '文字', '3D 渲染', '照片写实', '多余肢体、畸形手指'],
  };
  if (style.includes('写实')) return {
    medium: '电影写实摄影质感，35mm 胶片颗粒',
    line: '无描线，以光影与材质塑造轮廓',
    palette: '克制低饱和，冷灰与暖褐对比，单一强调色',
    face: '真实皮肤纹理，自然毛孔与高光，避免磨皮与塑料感',
    light: '戏剧侧光与低调环境光，主光方向明确',
    forbidden: ['水印', '文字', '卡通化', '3D 渲染', '多余肢体、畸形手指'],
  };
  return {};
}

export function styleSpecFor(project: Project): StyleSpec {
  return project.promptConfig?.style ?? defaultStyleSpec(project.style);
}

export function styleBlockText(style: StyleSpec, mode: 'full' | 'concise' = 'full'): string {
  const fields = ([['介质', style.medium], ['线条', style.line], ['配色', style.palette], ['面部', style.face], ['光线', style.light]] as const).filter(([, value]) => value?.trim());
  if (!fields.length) return '';
  if (mode === 'concise') {
    const text = fields.map(([key, value]) => `${key}：${value}`).join('；');
    return `【风格块】${text.length > 180 ? `${text.slice(0, 180)}…` : text}`;
  }
  return `【风格块】\n${fields.map(([key, value]) => `${key}：${value}`).join('\n')}`;
}

export function forbiddenBlockText(style: StyleSpec, fallback: string): string {
  const list = (style.forbidden || []).map(item => item.trim()).filter(Boolean);
  return `禁写：${list.length ? list.join('、') : fallback}`;
}

export function defaultBlockText(def: TemplateBlockDef, style: StyleSpec): string {
  return typeof def.defaultText === 'function' ? def.defaultText(style) : def.defaultText;
}

export function blockTextFor(project: Project, def: TemplateBlockDef, vars: Record<string, string>, style: StyleSpec): string {
  const fallback = defaultBlockText(def, style);
  const raw = def.locked ? fallback : project.promptConfig?.blocks?.[def.id] ?? fallback;
  return applyVariables(raw, vars);
}

const priority = '【优先级】P0 固定短语逐字 > P1 本镜动作与终点 > P2 风格块 > P3 运镜 > P4 Skill 附加建议；冲突时保 P0。';

export const templates: TemplateDef[] = [
  {
    id: 'script', title: '剧本', description: '把主题写成 10 镜 / 90 秒的可拍摄脚本。',
    blocks: [
      { id: 'script.contract', label: '输出契约', locked: true, reason: 'JSON 输出契约与后端 Schema 绑定，不可修改。', defaultText: '你是短篇漫剧编剧。只输出合法JSON，不要Markdown代码围栏。' },
      { id: 'script.spec', label: '硬性规格', locked: true, reason: '10 镜 / 90 秒是产品与校验约束。', defaultText: '硬性规格：10镜，总计90秒；每镜时长为4–15秒的数值。每镜包含画面、开场、动作、终点、运镜和台词。台词的speaker必须是characters中的人物名称，无对白时用空数组。' },
      { id: 'script.drama', label: '剧作规范', defaultText: '三幕结构：开场建立目标与冲突，中段升级对抗，结尾收束并给出可见结果。每镜只写一个可见事件（谁在哪、做了什么、情绪如何转折），镜头之间有因果。' },
      { id: 'script.forbidden', label: '禁写清单', defaultText: '不写抽象心理，改写成可见动作；不写时间戳；不写画风；每句对白不超过 18 字；不用现代词汇；人物名全篇一致。' },
      { id: 'script.genre', label: '题材补充', defaultText: '题材补充：{{project.theme}}。设定只作背景，不展开世界观说明。' },
      { id: 'script.asset-rules', label: '资产引用规则', locked: true, reason: '只允许引用资产清单内的名称。', defaultText: '先从完整剧本提取人物characters、场景scenes、道具props三类清单，再建立逐镜对应关系。每项description是可逐字复用的固定短语：人物固定外貌服装发型，场景固定空间结构光线环境，道具固定轮廓材质细节。每镜必须给出characters、scenes、props三个名称数组，只引用各自清单中出现的名称；即使近景也标明所在场景与实际出现的道具，不得只填写人物。确实没有的类别用空数组，不编造无关资产。' },
      { id: 'script.output-shape', label: 'JSON 输出结构', locked: true, reason: '输出结构必须与后端校验一致。', defaultText: `输出结构：${JSON.stringify(SCRIPT_OUTPUT_EXAMPLE)}` },
      { id: 'script.priority', label: '优先级', locked: true, reason: '冲突时固定短语优先。', defaultText: priority },
      { id: 'script.extra', label: '自由补充', defaultText: '' },
    ],
  },
  {
    id: 'assets', title: '资产', description: '只从剧本提取三类资产，不重写剧情。',
    blocks: [
      { id: 'extract.instruction', label: '提取规则', locked: true, reason: '只提取、不重写剧情，属于固定约束。', defaultText: '只从以下已有剧本提取人物、场景、道具，不重写剧情、镜号、对白或时长。先列出characters/scenes/props，每项包含name和可逐字复用的description固定短语，再逐镜列出number以及characters/scenes/props三个名称数组。相同资产只建一项，关联只用清单内名称。场景应包括特写所属空间，道具仅包含实际出现的物品。无依据的外观细节不要编造；没有某类时返回空数组，供用户补充。' },
      { id: 'extract.phrase-style', label: '固定短语写法', defaultText: '人物 = 年龄体型｜发型发色｜面部特征｜服装（款式、颜色、材质）｜随身标识，不超过 90 字，不含动作与情绪；场景 = 空间结构｜主色与材质｜光线与时间｜环境层次；道具 = 轮廓｜材质｜比例｜关键细节与磨损。' },
      { id: 'extract.forbidden', label: '禁写清单', defaultText: '不写画风词；不写「漂亮、帅气」等主观词；不写镜头；不写剧情；不编造剧本里没有的外观。' },
    ],
  },
  {
    id: 'director', title: '导演', description: '把剧本拆成逐镜分镜脚本，不改剧情与时长。',
    blocks: [
      { id: 'director.contract', label: '输出契约', locked: true, reason: 'JSON 契约与枚举由系统固定。', defaultText: '每镜输出 { number, shotSize, movement, angle, start, action, end }。shotSize 取 远景、全景、中景、近景、特写；movement 取 固定、推、拉、摇、移、跟、升降、环绕；angle 取 平视、俯视、仰视。只输出合法 JSON，不要 Markdown 代码围栏。' },
      { id: 'director.spec', label: '导演规范', defaultText: '每镜只有一个主运镜；景别随情绪递进，建置用全景或远景，冲突用近景或特写，收束回远景；同一景别连续不超过 2 镜；下一镜起点必须承接上一镜终点（人物位置、朝向、道具持握）；动作只写时长内能完成的，约每 3 秒一个动作点。' },
      { id: 'director.transition', label: '衔接与转场', defaultText: '下一镜起点承接上一镜终点；转场只在必要时使用，优先用动作或视线衔接，不用无依据的闪白或黑场。' },
      { id: 'director.forbidden', label: '禁写清单', defaultText: '不改剧情、对白、时长、镜数；不引入清单外的人物和道具；不写画风；不写「突然、瞬移」。' },
      { id: 'director.priority', label: '优先级', locked: true, reason: '冲突时固定短语优先。', defaultText: priority },
    ],
  },
  {
    id: 'image', title: '图片', description: '人物三视图与场景、道具设定图。',
    blocks: [
      { id: 'image.three-view', label: '人物三视图条款', locked: true, reason: '三视图规则由产品与测试固定。', defaultText: '只输出一张角色三视图设定卡：同一个人物的正面、侧面、背面三张全身视图，从左到右等大并排拼在同一张图内，恰好三视图，不增加其他视角、局部特写或额外人物。三张均头脚完整、自然站立、相同比例与光照，人物身份、五官、体型、服装款式与颜色、发型和随身标识严格一致，固定描述逐字遵守。背景必须为统一纯色，无场景、建筑、风景、环境道具、装饰、文字或水印；主题仅供身份理解，不得画成剧情场景。' },
      { id: 'image.scene-composition', label: '场景构图说明', defaultText: '明确空间结构、光线和环境层次，保持场景可复用。' },
      { id: 'image.prop-composition', label: '道具构图说明', defaultText: '清晰呈现道具轮廓、材质、比例与关键细节，简洁背景。' },
      { id: 'image.forbidden', label: '禁写清单', defaultText: style => forbiddenBlockText(style, '水印、署名、文字；现代物品；3D 与 CG 质感；照片写实；多余肢体、畸形手指') },
      { id: 'image.priority', label: '优先级', locked: true, reason: '固定短语优先于风格块。', defaultText: priority },
    ],
  },
  {
    id: 'video', title: '视频', description: '按分镜生成镜头视频，固定外观与附件顺序。',
    blocks: [
      { id: 'video.motion', label: '运动规范', defaultText: '动作按时间顺序描述，镜头运动平稳，避免瞬移与无依据变装；参考图已提供时重点描述动作、对白和运镜。' },
      { id: 'video.forbidden', label: '禁写清单', defaultText: style => forbiddenBlockText(style, '不出现字幕、文字、水印；不变脸变装；不新增人物；不改固定外观') },
      { id: 'video.priority', label: '优先级', locked: true, reason: '固定短语优先于风格块。', defaultText: priority },
    ],
  },
];

export function templateFor(id: TemplateId): TemplateDef {
  const found = templates.find(template => template.id === id);
  if (!found) throw new Error(`未知模板：${id}`);
  return found;
}

export function findTemplateBlock(id: string): { template: TemplateDef; block: TemplateBlockDef } | undefined {
  for (const template of templates) {
    const block = template.blocks.find(item => item.id === id);
    if (block) return { template, block };
  }
  return undefined;
}

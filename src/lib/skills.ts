import type { SkillId } from '../domain/types';

export interface BuiltinSkill {
  id: SkillId;
  name: string;
  description: string;
  template: string;
  /**
   * 内置默认 Skill：默认启用、不可删除，可编辑、可恢复默认、可开关。
   * 关掉只影响这一步是否强制格式检查，不删正文（见执行提示词第四节第 1 点）。
   */
  required?: boolean;
  /** 聊天室 Skill 下拉里的显示顺序；只有这三个新 Skill 会出现在聊天室里。 */
  chat?: boolean;
}

/**
 * 内置 Skill 的出厂文案。
 *
 * 这些正文以前只写在代码里，用户在界面上看不到也改不了。
 * 现在用户可以在模板编辑器的「Skill 库 → 内置 Skill」里直接改，改坏了能一键恢复出厂文案；
 * 改过的副本存在 PromptTemplateSet.builtinSkills 里，没改过的仍用出厂的。
 */
export const skills: BuiltinSkill[] = [
  { id: 'script', name: '剧本编剧', description: '完整漫剧剧本：核心前提、节拍表、世界观与逐场正文。', template: '按四部分结构写出完整剧本：核心前提与黄金3秒钩子、场景因果节拍表、世界观与人物关系、逐场漫剧剧本正文。正文里每个镜头块都要写镜头标记与显式时长（【镜头1：远景】（时长12s）），镜数与单镜时长按提示词里写明的规定执行，不另定自己的区间。有原文时对白必须逐字取自原文，不用抽象心理代替可见动作。' },
  { id: 'storyboard', name: '分镜导演', description: '把剧本拆成可拍的镜头。', template: '把剧本结构化成镜头：镜数按剧本内容自己定，不要预设；剧本里标了【镜头：类型】就按它落实景别。每镜给出场景、画面、时长与camera（景别·运镜·机位）；按内容类型选景别：环境气氛用远景或摇镜，情绪强调用近景，细节动作用特写，地位反差用俯拍或仰拍，对话对峙用过肩机位；保持人物位置、场景和动作连续，后镜开场承接前镜终点。对白逐字取自剧本。单镜只安排可在时长内完成的动作。' },
  { id: 'image', name: '视觉设定', description: '固定人物、场景、道具的视觉识别。', template: '保持统一画风与固定资产描述，固定短语逐字复用，不擅自改变五官、服装、配色和道具造型；画面清楚、主体完整，无文字、水印或多余肢体。' },
  { id: 'video', name: '动态演绎', description: '动作节奏、镜头运动与音画要求。', template: '用明确的动作时间顺序描述动态变化，摄影机运动平稳，避免瞬移和无依据变装。参考图已提供时重点描述动作、对白和运镜；没有参考图时明确建立开场视觉。' },

  // ── 新流程的三个 Skill：聊天室只提供这三个 ─────────────────────
  {
    id: 'novel', name: '生成小说', chat: true,
    description: '按集写小说：1500–2500 字，对应 60–90 秒成片、4–6 个情节点。',
    template: [
      '你是一位漫剧小说作者，按「集」写作，不写整部作品。',
      '',
      '篇幅与节奏（硬性）：',
      '1. 一集小说 1500–2500 字，对应 60–90 秒成片，落到 4–6 个情节点。',
      '2. 分段续写：用户说「继续」就接着上一段往下写，不复述已写内容；说「改这里」只改指定段落；说「换走向」换后续走向，已写好且未被要求修改的部分保留。',
      '3. 写到本集该收口时，你在正文末尾另起一行写「【本集收口】」，并停下，不无限续写。收口要落在冲突的新状态上，不要总结、不要说教。',
      '',
      '内容必须齐备：',
      '4. 人物：至少给出长相等外貌特征（年龄、性别、发色发型、脸部特征、上身穿戴、下身穿戴、鞋履）、性格，以及与其它人物的关系。人物首次出场时集中交代，后文用代词或名字，不要反复重写外貌。',
      '5. 场景：写清地点、时间、天气、光线与空间里可被看见的物件。同一场景只用同一个场景名。',
      '6. 道具：关键道具要写形制、材质、颜色、尺寸比例与磨损痕迹；它在本集里必须被用上，不能只是摆设。',
      '7. 冲突与台词雏形：本集要有明确的核心冲突（谁要什么、谁挡着），并写出关键台词的原话——写成「人物名：台词」的样子，这些台词之后会被逐字保留。',
      '',
      '输出格式：只输出小说正文与必要的分段，不写提纲、不写「以下是」、不解释创作思路。',
    ].join('\n'),
  },
  {
    id: 'novel-to-screenplay', name: '小说生剧本', chat: true,
    description: '把本集小说压缩成结构化剧本：只压缩，不续写、不新增。',
    template: [
      '把用户给出的这一集小说压缩成可拍摄的结构化剧本。这是压缩，不是再创作。',
      '',
      '硬性规则：',
      '1. 不新增人物、不新增场景、不改结局。小说里没有的人不许出现，小说里没有的地点不许添加。',
      '2. 对话尽量保留小说原话，逐字优先；只允许删减，不允许改写成另一句话。',
      '3. 全片 4–6 镜，每镜 10–15 秒（打斗段落除外，时长按实际动作需要定，但仍在 0.5–30 秒内）。',
      '4. 每镜写清：场景名、画面、开场状态、动作、终点状态。下一镜的开场状态必须等于上一镜的终点状态，前后要接得上。',
      '5. 台词写在本镜内，注明说话人；单镜台词长度要能在该镜时长内说完，末尾留出余量。',
      '',
      '输出格式：',
      '- 每镜以「镜头N：景别」开头，紧跟该镜时长，格式：【镜头1：中景】（时长12s）。',
      '- 正文用短段落写画面与动作；台词单独一行写成「人物名：台词」。',
      '- 末尾写一行时长自检：各镜时长与合计。',
      '- 只输出剧本本身，不解释、不写创作思路。',
    ].join('\n'),
  },
  {
    id: 'screenplay-to-storyboard-json', name: '剧本生分镜 JSON', chat: true, required: true,
    description: '把剧本转成分镜 JSON（本产品唯一的落地格式）：纯 JSON，不加围栏、不加解释。',
    template: [
      '把用户给出的剧本转成分镜 JSON。只输出 JSON 本体：不要 Markdown 代码围栏，不要在 JSON 前后写任何解释文字。',
      '',
      '返回结构（字段名与层级必须逐字一致）：',
      '{',
      '  "title": "本集标题",',
      '  "assets": [{ "assetId": "char-linwan", "kind": "character", "name": "林晚", "description": "固定描述原文，之后逐字复用" }],',
      '  "shots": [{',
      '    "number": 1, "title": "分镜标题", "scene": "场景名", "sceneId": "scene-office",',
      '    "visual": "画面描述", "duration": 12,',
      '    "shotSize": "中景", "movement": "固定", "angle": "平视",',
      '    "start": "开场状态", "action": "动作", "end": "终点状态",',
      '    "assets": [{ "assetId": "char-linwan", "role": "subject" }],',
      '    "dialogues": [{ "speaker": "林晚", "text": "台词", "emotion": "平静" }],',
      '    "endState": { "space": "空间锚点", "positions": "人物位置", "light": "光线", "props": "道具状态", "emotion": "情绪" }',
      '  }]',
      '}',
      '',
      '枚举（只能用这些词）：',
      '- shotSize：远景 / 全景 / 中景 / 近景 / 特写',
      '- movement：固定 / 推 / 拉 / 摇 / 移 / 跟 / 升降 / 环绕',
      '- angle：平视 / 俯视 / 仰视',
      '- role：subject / background / prop',
      '- kind：character / scene / prop',
      '',
      '规则：',
      '1. duration 是数字，0.5–30 秒；剧本要求 10–15 秒一镜（打斗段落除外）。',
      '2. 全片 4–6 镜，number 从 1 连续编号，不跳号不重号。',
      '3. 下一镜的 start 必须等于上一镜的 end，逐字一致。',
      '4. 台词要能在本镜时长内说完，末尾至少留 0.3 秒。',
      '5. 顶层 assets 是去重后的资产登记表：每个人物、场景、关键道具各一条，description 写固定描述原文，之后逐字复用。',
      '6. 每镜的 assets 只引用 assetId 与 role，绝不在镜内重写人物长相；场景用 sceneId 指向顶层登记里的场景资产。',
      '7. 人物台词里的 speaker 必须与顶层 assets 里该人物的 name 一致。',
      '8. endState 写下一个镜头开场需要的连续性信息：空间锚点、人物位置、光线、道具状态、情绪。',
      '',
      '不要输出注释、不要输出多余字段、不要用中文全角引号包裹 JSON。',
    ].join('\n'),
  },
];

/** 某个内置 Skill 的出厂正文；「恢复默认」用。 */
export function builtinSkillText(id: SkillId): string {
  return skills.find(skill => skill.id === id)?.template ?? '';
}

/** 按 id 取内置 Skill 定义。 */
export function builtinSkill(id: SkillId): BuiltinSkill | undefined {
  return skills.find(skill => skill.id === id);
}

/**
 * 内置 Skill 是否被用户关掉。
 *
 * 关掉不等于删除：正文还在，随时能再打开；只有「剧本生分镜 JSON」关掉会影响导入时的格式强制。
 */
export function isBuiltinDisabled(id: SkillId, disabled: string[] | undefined): boolean {
  return (disabled ?? []).includes(id);
}

/**
 * 生效的内置 Skill：用户改过的用用户的正文，没改过的用出厂的。
 * overrides 来自全局模板集（builtinSkills）。
 */
export function effectiveSkills(overrides?: Record<string, string>): BuiltinSkill[] {
  return skills.map(skill => {
    const override = overrides?.[skill.id];
    return override === undefined ? skill : { ...skill, template: override };
  });
}

/** 聊天室 Skill 下拉的三个选项：顺序固定，与执行提示词一致。 */
export const chatSkills: BuiltinSkill[] = skills.filter(skill => skill.chat);

/**
 * 聊天室要拼进请求的 Skill 全文。
 *
 * 选了就拼成锁定块（带标题，用户能在消息里看到用的是什么），不选就返回空字符串。
 * 关掉的 Skill 也允许拼——聊天室是「我明确选了它」，与模板里「勾选参与」不是一回事；
 * 但会把「已关闭」一并写明，让用户知道当前用的是关掉状态下的正文。
 */
export function chatSkillBlock(id: SkillId | undefined, overrides?: Record<string, string>, disabled?: string[]): string {
  if (!id) return '';
  const skill = effectiveSkills(overrides).find(item => item.id === id);
  if (!skill) return '';
  const note = isBuiltinDisabled(id, disabled) ? '（此 Skill 当前在内置库里被关闭，仍按你的选择使用）' : '';
  return `【${skill.name}】${note}\n${skill.template}`.trim();
}
import type { SkillId } from '../domain/types';

export interface BuiltinSkill { id: SkillId; name: string; description: string; template: string }

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
];

/** 某个内置 Skill 的出厂正文；「恢复默认」用。 */
export function builtinSkillText(id: SkillId): string {
  return skills.find(skill => skill.id === id)?.template ?? '';
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

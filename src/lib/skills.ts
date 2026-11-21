import type { SkillId } from '../domain/types';

export const skills: { id: SkillId; name: string; description: string; template: string }[] = [
  { id: 'script', name: '剧本编剧', description: '10 镜 / 90 秒，起承转合与可表演的对白。', template: '围绕用户主题建立明确目标、冲突、转折和收束。恰好10个镜头，总时长90秒，每镜4–15秒；对白简短、标明说话人物，不用抽象心理代替可见动作。' },
  { id: 'storyboard', name: '分镜导演', description: '明确开场、动作、终点与摄影机运动。', template: '为每镜填写visual、start、action、end、camera；保持人物位置、场景和动作连续，后镜开场参考前镜终点。单镜只安排可在时长内完成的动作。' },
  { id: 'image', name: '视觉设定', description: '固定人物、场景、道具的视觉识别。', template: '保持统一画风与固定资产描述，固定短语逐字复用，不擅自改变五官、服装、配色和道具造型；画面清楚、主体完整，无文字、水印或多余肢体。' },
  { id: 'video', name: '动态演绎', description: '动作节奏、镜头运动与音画要求。', template: '用明确的动作时间顺序描述动态变化，摄影机运动平稳，避免瞬移和无依据变装。参考图已提供时重点描述动作、对白和运镜；没有参考图时明确建立开场视觉。' },
];

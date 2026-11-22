import type { Asset, Project, Shot, SkillId } from '../domain/types';
import { skills } from './skills';
import { SCRIPT_OUTPUT_EXAMPLE, renderPrompt, type PromptBlock, type PromptSpec } from './promptSpec';

const kindNames = { character: '人物', scene: '场景', prop: '道具', voice: '音色' };
const roleNames = { reference_image: '参考图', first_frame: '首帧', last_frame: '尾帧' };
const selectedSkills = (project: Project, ids: SkillId[]) => skills.filter(s => project.skills.includes(s.id) && ids.includes(s.id)).map(s => `【${s.name}】${s.template}`).join('\n');
const block = (id: string, label: string, text: string, locked = false): PromptBlock => ({ id, label, text, locked });
export const fixedDescription = (asset: Asset) => asset.lock || asset.description;

export const visualKinds = ['character', 'scene', 'prop'] as const;

export function assetSpecs(project: Project, shot: Shot) {
  const ids = new Set([...shot.assetIds, ...shot.references.map(r => r.assetId), ...shot.dialogues.map(d => d.speakerId)]);
  return visualKinds.map(kind => {
    const assets = project.assets.filter(a => a.kind === kind && ids.has(a.id));
    const missing = !assets.length || assets.some(a => !fixedDescription(a).trim());
    const label = `${kindNames[kind]}提示词`;
    const content = assets.length ? assets.map(a => `${kindNames[kind]}「${a.name}」：${fixedDescription(a).trim() ? fixedDescription(a) : '【缺失：固定短语待补充】'}`).join('\n') : `【缺失：未关联${kindNames[kind]}资产，请补充；若本镜不需要，请人工确认】`;
    const text = `【${label}】\n${content}`;
    return { kind, label, missing, text, block: block(`asset.${kind}`, label, text, true) };
  });
}
export function assetPromptGroups(project: Project, shot: Shot) {
  return assetSpecs(project, shot).map(({ kind, label, missing, text }) => ({ kind, label, missing, text }));
}
export function assetText(project: Project, shot: Shot): string {
  return assetPromptGroups(project, shot).map(group => group.text).join('\n\n');
}

export function fullAssetText(project: Project, shot: Shot): string {
  const speakerIds = new Set([...shot.assetIds, ...shot.dialogues.map(d => d.speakerId)]);
  const voiceIds = new Set(project.assets.filter(a => speakerIds.has(a.id)).map(a => a.voiceAssetId));
  const voices = project.assets.filter(a => a.kind === 'voice' && (speakerIds.has(a.id) || voiceIds.has(a.id)));
  return [assetText(project, shot), ...voices.map(a => `音色「${a.name}」：${a.description}\n音色ID：${a.voiceId || '未设置'}；语速：${a.speed ?? 1}×`)].filter(Boolean).join('\n');
}

export function videoSpec(project: Project, shot: Shot): PromptSpec {
  const previous = project.shots[project.shots.findIndex(s => s.id === shot.id) - 1];
  const references = shot.references.flatMap(r => {
    const asset = project.assets.find(a => a.id === r.assetId && a.imageId && a.kind !== 'voice');
    return asset ? [{ asset, role: r.role }] : [];
  });
  const dialogue = shot.dialogues.map(d => `${project.assets.find(a => a.id === d.speakerId)?.name || '未指定人物'}：${d.text}`).join('\n');
  const audio = shot.audioMode === 'original'
    ? '音频：原声模式，按下列对白自然发声并匹配口型，不添加字幕。'
    : shot.audioMode === 'dubbing'
      ? '音频：后期配音模式，不生成可辨识人声；按对白节奏表演，配音轨另行制作。'
      : '音频：静音模式，不生成音轨；对白仅作为表演节奏参考。';
  return {
    kind: 'video',
    blocks: [
      block('video.shot-heading', '镜头开头', `第${shot.number}镜，${shot.duration}秒。风格：${project.style}。`),
      block('video.continuity', '承接上一镜', previous?.end ? `上一镜终点（承接上下文）：${previous.end}` : ''),
      block('video.references', '附件顺序', references.length
        ? `本镜已挂载${references.length}张图片，必须按以下顺序实际提交图片附件；仅复制文字不等于上传图片。\n${references.map((r, i) => `图${i + 1}：${roleNames[r.role]} · ${r.asset.name}`).join('\n')}\n以附件为视觉依据，重点执行动作、对白和摄影机运动。`
        : `本镜没有挂载参考图，请从文字建立画面，不得假设任何图片已上传。\n开场：${shot.start || shot.visual}\n画面：${shot.visual}`, true),
      block('video.action', '动作与运镜', `动作：${shot.action || '按画面设定自然表演，保持主体一致。'}\n运镜：${shot.camera}\n终点：${shot.end || '保持主体与场景稳定。'}`),
      block('video.dialogue', '对白节奏', `对白／表演节奏：\n${dialogue || '无对白'}`),
      block('video.audio', '音频模式', audio, true),
      block('video.fixed-assets', '固定资产块', `【固定资产块 · 原短语逐字复用】\n${assetText(project, shot) || '未关联固定资产，请保持本镜文字设定。'}`, true),
      block('video.skills', '附加 Skill', selectedSkills(project, ['video'])),
    ],
  };
}
export function videoPrompt(project: Project, shot: Shot): string {
  return renderPrompt(videoSpec(project, shot));
}

export function imageSpec(project: Project, asset: Asset): PromptSpec {
  const composition = asset.kind === 'character' ? '只输出一张角色三视图设定卡：同一个人物的正面、侧面、背面三张全身视图，从左到右等大并排拼在同一张图内，恰好三视图，不增加其他视角、局部特写或额外人物。三张均头脚完整、自然站立、相同比例与光照，人物身份、五官、体型、服装款式与颜色、发型和随身标识严格一致，固定描述逐字遵守。背景必须为统一纯色，无场景、建筑、风景、环境道具、装饰、文字或水印；主题仅供身份理解，不得画成剧情场景。' : asset.kind === 'scene' ? '明确空间结构、光线和环境层次，保持场景可复用。' : '清晰呈现道具轮廓、材质、比例与关键细节，简洁背景。';
  return {
    kind: 'image',
    blocks: [
      block('image.task', '任务与风格', `为漫剧制作${kindNames[asset.kind]}设定图。作品主题：${project.theme || project.name}。风格：${project.style}。`),
      block('image.subject', '固定短语', `主体：${asset.name}\n【固定资产块 · 原短语逐字复用】\n${fixedDescription(asset)}`, true),
      block('image.composition', '构图条款', composition, asset.kind === 'character'),
      block('image.skills', '附加 Skill', selectedSkills(project, ['image'])),
    ],
  };
}
export function imagePrompt(project: Project, asset: Asset): string {
  return renderPrompt(imageSpec(project, asset));
}

export function extractSpec(project: Project): PromptSpec {
  return {
    kind: 'extract',
    blocks: [
      block('extract.instruction', '提取规则', '只从以下已有剧本提取人物、场景、道具，不重写剧情、镜号、对白或时长。先列出characters/scenes/props，每项包含name和可逐字复用的description固定短语，再逐镜列出number以及characters/scenes/props三个名称数组。相同资产只建一项，关联只用清单内名称。场景应包括特写所属空间，道具仅包含实际出现的物品。无依据的外观细节不要编造；没有某类时返回空数组，供用户补充。', true),
      block('extract.existing-assets', '已有固定资产', `已有固定资产（同类同名时必须沿用名称与原短语）：\n${project.assets.filter(a => a.kind !== 'voice').map(a => `${kindNames[a.kind]}「${a.name}」：${fixedDescription(a)}`).join('\n')}`),
      block('extract.shots-input', '逐镜 JSON', JSON.stringify(project.shots.map(s => ({ number: s.number, visual: s.visual, start: s.start, action: s.action, end: s.end, dialogues: s.dialogues.map(d => ({ speaker: project.assets.find(a => a.id === d.speakerId)?.name || '', text: d.text })) }))), true),
    ],
  };
}
export function extractAssetsPrompt(project: Project): string {
  return renderPrompt(extractSpec(project));
}

export function scriptSpec(project: Project): PromptSpec {
  return {
    kind: 'script',
    blocks: [
      block('script.contract', '输出契约', '你是短篇漫剧编剧。只输出合法JSON，不要Markdown代码围栏。', true),
      block('script.theme', '主题与风格', `主题：${project.theme}\n统一风格：${project.style}`),
      block('script.spec', '硬性规格', '硬性规格：10镜，总计90秒；每镜时长为4–15秒的数值。每镜包含画面、开场、动作、终点、运镜和台词。台词的speaker必须是characters中的人物名称，无对白时用空数组。', true),
      block('script.asset-rules', '资产规则', '先从完整剧本提取人物characters、场景scenes、道具props三类清单，再建立逐镜对应关系。每项description是可逐字复用的固定短语：人物固定外貌服装发型，场景固定空间结构光线环境，道具固定轮廓材质细节。每镜必须给出characters、scenes、props三个名称数组，只引用各自清单中出现的名称；即使近景也标明所在场景与实际出现的道具，不得只填写人物。确实没有的类别用空数组，不编造无关资产。', true),
      block('script.output-shape', 'JSON 输出结构', `输出结构：${JSON.stringify(SCRIPT_OUTPUT_EXAMPLE)}`, true),
      block('script.skills', '附加 Skill', selectedSkills(project, ['script', 'storyboard', 'image', 'video'])),
      block('script.existing-assets', '已有资产', project.assets.length ? `已有资产设定（引用时保持原短语，不要编造图片已上传）：\n${project.assets.filter(a => a.kind !== 'voice').map(a => `${a.name}：${fixedDescription(a)}`).join('\n')}` : ''),
    ],
  };
}
export function scriptPrompt(project: Project): string {
  return renderPrompt(scriptSpec(project));
}

import type { Asset, Project, Shot, SkillId, StyleSpec } from '../domain/types';
import { skills } from './skills';
import { renderPrompt, type PromptBlock, type PromptSpec } from './promptSpec';
import { blockTextFor, findTemplateBlock, promptVariables, styleBlockText, styleSpecFor } from './promptTemplates';

const kindNames = { character: '人物', scene: '场景', prop: '道具', voice: '音色' };
const roleNames = { reference_image: '参考图', first_frame: '首帧', last_frame: '尾帧' };
const selectedSkills = (project: Project, ids: SkillId[]) => skills.filter(s => project.skills.includes(s.id) && ids.includes(s.id)).map(s => `【${s.name}】${s.template}`).join('\n');
const block = (id: string, label: string, text: string, locked = false, reason?: string): PromptBlock => ({ id, label, text, locked, ...(reason ? { reason } : {}) });
function ruleBlock(project: Project, id: string, vars: Record<string, string>, style: StyleSpec): PromptBlock {
  const found = findTemplateBlock(id);
  if (!found) throw new Error(`缺少模板块：${id}`);
  return { id, label: found.block.label, locked: Boolean(found.block.locked), ...(found.block.reason ? { reason: found.block.reason } : {}), text: blockTextFor(project, found.block, vars, style) };
}
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
  const style = styleSpecFor(project); const vars = promptVariables(project, style);
  return {
    kind: 'video',
    blocks: [
      block('video.shot-heading', '镜头开头', `第${shot.number}镜，${shot.duration}秒。风格：${project.style}。`),
      block('video.style', '风格块', styleBlockText(style, 'concise'), true, '在风格设定（StyleSpec）中编辑。'),
      block('video.continuity', '承接上一镜', previous?.end ? `上一镜终点（承接上下文）：${previous.end}` : ''),
      block('video.references', '附件顺序', references.length
        ? `本镜已挂载${references.length}张图片，必须按以下顺序实际提交图片附件；仅复制文字不等于上传图片。\n${references.map((r, i) => `图${i + 1}：${roleNames[r.role]} · ${r.asset.name}`).join('\n')}\n以附件为视觉依据，重点执行动作、对白和摄影机运动。`
        : `本镜没有挂载参考图，请从文字建立画面，不得假设任何图片已上传。\n开场：${shot.start || shot.visual}\n画面：${shot.visual}`, true, '附件顺序由实际挂图决定。'),
      block('video.action', '动作与运镜', `动作：${shot.action || '按画面设定自然表演，保持主体一致。'}\n运镜：${shot.camera}\n终点：${shot.end || '保持主体与场景稳定。'}`),
      block('video.dialogue', '对白节奏', `对白／表演节奏：\n${dialogue || '无对白'}`),
      ruleBlock(project, 'video.motion', vars, style),
      block('video.audio', '音频模式', audio, true, '音频模式与所选模式绑定。'),
      block('video.fixed-assets', '固定资产块', `【固定资产块 · 原短语逐字复用】\n${assetText(project, shot) || '未关联固定资产，请保持本镜文字设定。'}`, true, '固定短语必须逐字复用。'),
      ruleBlock(project, 'video.forbidden', vars, style),
      ruleBlock(project, 'video.priority', vars, style),
      block('video.skills', '附加 Skill', selectedSkills(project, ['video'])),
    ],
  };
}
export function videoPrompt(project: Project, shot: Shot): string {
  return renderPrompt(videoSpec(project, shot));
}

export function imageSpec(project: Project, asset: Asset): PromptSpec {
  const style = styleSpecFor(project); const vars = promptVariables(project, style);
  const composition = asset.kind === 'character' ? 'image.three-view' : asset.kind === 'scene' ? 'image.scene-composition' : 'image.prop-composition';
  return {
    kind: 'image',
    blocks: [
      block('image.task', '任务与风格', `为漫剧制作${kindNames[asset.kind]}设定图。作品主题：${project.theme || project.name}。风格：${project.style}。`),
      block('image.style', '风格块', styleBlockText(style), true, '在风格设定（StyleSpec）中编辑。'),
      block('image.subject', '固定短语', `主体：${asset.name}\n【固定资产块 · 原短语逐字复用】\n${fixedDescription(asset)}`, true, '固定短语必须逐字复用。'),
      ruleBlock(project, composition, vars, style),
      ruleBlock(project, 'image.forbidden', vars, style),
      ruleBlock(project, 'image.priority', vars, style),
      block('image.skills', '附加 Skill', selectedSkills(project, ['image'])),
    ],
  };
}
export function imagePrompt(project: Project, asset: Asset): string {
  return renderPrompt(imageSpec(project, asset));
}

export function extractSpec(project: Project): PromptSpec {
  const style = styleSpecFor(project); const vars = promptVariables(project, style);
  return {
    kind: 'extract',
    blocks: [
      ruleBlock(project, 'extract.instruction', vars, style),
      ruleBlock(project, 'extract.phrase-style', vars, style),
      ruleBlock(project, 'extract.forbidden', vars, style),
      block('extract.existing-assets', '已有固定资产', `已有固定资产（同类同名时必须沿用名称与原短语）：\n${project.assets.filter(a => a.kind !== 'voice').map(a => `${kindNames[a.kind]}「${a.name}」：${fixedDescription(a)}`).join('\n')}`),
      block('extract.shots-input', '逐镜 JSON', JSON.stringify(project.shots.map(s => ({ number: s.number, visual: s.visual, start: s.start, action: s.action, end: s.end, dialogues: s.dialogues.map(d => ({ speaker: project.assets.find(a => a.id === d.speakerId)?.name || '', text: d.text })) }))), true, '逐镜输入由作品数据生成。'),
    ],
  };
}
export function extractAssetsPrompt(project: Project): string {
  return renderPrompt(extractSpec(project));
}

export function scriptSpec(project: Project): PromptSpec {
  const style = styleSpecFor(project); const vars = promptVariables(project, style);
  return {
    kind: 'script',
    blocks: [
      ruleBlock(project, 'script.contract', vars, style),
      block('script.theme', '主题与风格', `主题：${project.theme}\n统一风格：${project.style}`),
      block('script.style', '风格块', styleBlockText(style), true, '在风格设定（StyleSpec）中编辑。'),
      ruleBlock(project, 'script.spec', vars, style),
      ruleBlock(project, 'script.drama', vars, style),
      ruleBlock(project, 'script.forbidden', vars, style),
      ruleBlock(project, 'script.genre', vars, style),
      ruleBlock(project, 'script.asset-rules', vars, style),
      ruleBlock(project, 'script.output-shape', vars, style),
      ruleBlock(project, 'script.priority', vars, style),
      block('script.skills', '附加 Skill', selectedSkills(project, ['script', 'storyboard', 'image', 'video'])),
      block('script.existing-assets', '已有资产', project.assets.length ? `已有资产设定（引用时保持原短语，不要编造图片已上传）：\n${project.assets.filter(a => a.kind !== 'voice').map(a => `${a.name}：${fixedDescription(a)}`).join('\n')}` : ''),
      ruleBlock(project, 'script.extra', vars, style),
    ],
  };
}
export function scriptPrompt(project: Project): string {
  return renderPrompt(scriptSpec(project));
}
export const screenplayPrompt = scriptPrompt;

/** 导演模板（PR7 接入真实生成；当前供模板编辑器预览与校验）。 */
export function directorSpec(project: Project): PromptSpec {
  const style = styleSpecFor(project); const vars = promptVariables(project, style);
  return {
    kind: 'director',
    blocks: [
      ...['director.contract', 'director.spec', 'director.transition', 'director.forbidden', 'director.priority'].map(id => ruleBlock(project, id, vars, style)),
      block('director.shots-input', '逐镜剧本', JSON.stringify(project.shots.map(shot => ({
        number: shot.number, duration: shot.duration, visual: shot.visual,
        characters: project.assets.filter(asset => shot.assetIds.includes(asset.id) && asset.kind === 'character').map(asset => asset.name),
        scenes: project.assets.filter(asset => shot.assetIds.includes(asset.id) && asset.kind === 'scene').map(asset => asset.name),
        props: project.assets.filter(asset => shot.assetIds.includes(asset.id) && asset.kind === 'prop').map(asset => asset.name),
        dialogues: shot.dialogues.map(line => ({ speaker: project.assets.find(asset => asset.id === line.speakerId)?.name || '', text: line.text })),
      }))), true, '逐镜剧本由作品数据生成，调度时不得改动。'),
    ],
  };
}
export function directorPrompt(project: Project): string {
  return renderPrompt(directorSpec(project));
}

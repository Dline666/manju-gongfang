// 各生成步骤的提示词：用户排好的块在前，作品数据由系统固定附带在后。
// 系统不插入任何规则文案——规则由用户在模板编辑器里自己写。
// 模板分两层：全局模板是默认，作品可以覆盖其中某一步；global 就是那份全局模板。
import type { Asset, Project, PromptKindId, PromptTemplateSet, Shot } from '../domain/types';
import { renderPrompt, type PromptBlock, type PromptKind, type PromptSpec } from './promptSpec';
import { applyVariables, promptVariables } from './promptTemplates';
import { dataSourcesFor, findSkill, renderData, type RenderContext } from './promptBlocks';
import { effectivePlan, effectiveSkillId, effectiveStyle } from './promptScope';

export { parseSceneHead, fixedDescription, assetSpecs, assetPromptGroups, assetText, fullAssetText, visualKinds } from './promptBlocks';
export type { ExtractCategory } from './promptBlocks';

/**
 * 按块计划拼出一个 spec：
 * 用户写的块在前；这一步选中的 Skill 紧跟其后；作品数据不是模板块，由系统固定附带，排在最后。
 */
function buildSpec(project: Project, kind: PromptKind, ctx: Omit<RenderContext, 'project'> = {}, global?: PromptTemplateSet): PromptSpec {
  const style = effectiveStyle(project, global);
  const vars = promptVariables(project, style);
  const userBlocks: PromptBlock[] = effectivePlan(project, kind, global)
    // 停用的块不进提示词，但内容还留着，用户随时能再打开。
    .filter(plan => plan.enabled !== false)
    .map(plan => ({
      id: plan.id, label: plan.title, locked: false, text: applyVariables(plan.text.trim(), vars),
    }));
  // 这一步选中的 Skill：正文由用户在 Skill 库里写，选了就每次自动带上；空正文等于没写。
  const skill = findSkill(global?.skills, effectiveSkillId(project, kind, global));
  const skillBlocks: PromptBlock[] = skill?.template.trim()
    ? [{ id: `skill.${skill.id}`, label: `Skill · ${skill.name}`, locked: true, reason: '本步选定的 Skill，由系统自动附带', text: applyVariables(skill.template.trim(), vars) }]
    : [];
  // 选了这一步的 Skill，就不再叠加作品级勾选的内置「附加 Skill」——两套配方同时发过去会互相打架。
  const dataBlocks: PromptBlock[] = dataSourcesFor(kind)
    .filter(def => !(skill && def.source.endsWith('.skills')))
    .map(def => ({
      id: `data.${def.source}`, label: def.title, locked: true, reason: '作品数据，由系统自动附带',
      text: applyVariables(renderData(def.source, { project, ...ctx, global }), vars),
    }));
  return { kind, blocks: [...userBlocks, ...skillBlocks, ...dataBlocks] };
}

export function scriptSpec(project: Project, global?: PromptTemplateSet): PromptSpec {
  return buildSpec(project, 'script', {}, global);
}
export function scriptPrompt(project: Project, global?: PromptTemplateSet): string {
  return renderPrompt(scriptSpec(project, global));
}
export const screenplayPrompt = scriptPrompt;

export function extractCharactersSpec(project: Project, global?: PromptTemplateSet): PromptSpec {
  return buildSpec(project, 'extract-characters', {}, global);
}
export function extractScenesSpec(project: Project, global?: PromptTemplateSet): PromptSpec {
  return buildSpec(project, 'extract-scenes', {}, global);
}
export function extractPropsSpec(project: Project, global?: PromptTemplateSet): PromptSpec {
  return buildSpec(project, 'extract-props', {}, global);
}
export function extractCharactersPrompt(project: Project, global?: PromptTemplateSet): string {
  return renderPrompt(extractCharactersSpec(project, global));
}
export function extractScenesPrompt(project: Project, global?: PromptTemplateSet): string {
  return renderPrompt(extractScenesSpec(project, global));
}
export function extractPropsPrompt(project: Project, global?: PromptTemplateSet): string {
  return renderPrompt(extractPropsSpec(project, global));
}

export function directorSpec(project: Project, global?: PromptTemplateSet): PromptSpec {
  return buildSpec(project, 'director', {}, global);
}
export function directorPrompt(project: Project, global?: PromptTemplateSet): string {
  return renderPrompt(directorSpec(project, global));
}

/**
 * 设定图按品类选模板：人物 / 场景 / 道具各用各的提示词，互不混用。
 * 音色不出图，落到人物那一档。
 */
export function imageKindFor(asset: Asset): PromptKindId {
  if (asset.kind === 'scene') return 'image-scene';
  if (asset.kind === 'prop') return 'image-prop';
  return 'image-character';
}

export function imageSpec(project: Project, asset: Asset, global?: PromptTemplateSet): PromptSpec {
  return buildSpec(project, imageKindFor(asset), { asset }, global);
}
export function imagePrompt(project: Project, asset: Asset, global?: PromptTemplateSet): string {
  return renderPrompt(imageSpec(project, asset, global));
}

export function videoSpec(project: Project, shot: Shot, global?: PromptTemplateSet): PromptSpec {
  return buildSpec(project, 'video', { shot }, global);
}
export function videoPrompt(project: Project, shot: Shot, global?: PromptTemplateSet): string {
  return renderPrompt(videoSpec(project, shot, global));
}

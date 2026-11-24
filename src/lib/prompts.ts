// 各生成步骤的提示词：用户排好的块在前，作品数据由系统固定附带在后。
// 系统不插入任何规则文案——规则由用户在模板编辑器里自己写。
import type { Asset, Project, Shot } from '../domain/types';
import { renderPrompt, type PromptBlock, type PromptKind, type PromptSpec } from './promptSpec';
import { applyVariables, promptVariables, styleSpecFor } from './promptTemplates';
import { dataSourcesFor, planFor, renderData, type RenderContext } from './promptBlocks';

export { parseSceneHead, fixedDescription, assetSpecs, assetPromptGroups, assetText, fullAssetText, visualKinds } from './promptBlocks';
export type { ExtractCategory } from './promptBlocks';

/**
 * 按块计划拼出一个 spec：
 * 用户写的块在前；作品数据不是模板块，由系统固定附带，排在后面。
 */
function buildSpec(project: Project, kind: PromptKind, ctx: Omit<RenderContext, 'project'> = {}): PromptSpec {
  const style = styleSpecFor(project);
  const vars = promptVariables(project, style);
  const userBlocks: PromptBlock[] = planFor(project, kind).map(plan => ({
    id: plan.id, label: plan.title, locked: false, text: applyVariables(plan.text.trim(), vars),
  }));
  const dataBlocks: PromptBlock[] = dataSourcesFor(kind).map(def => ({
    id: `data.${def.source}`, label: def.title, locked: true, reason: '作品数据，由系统自动附带',
    text: applyVariables(renderData(def.source, { project, ...ctx }), vars),
  }));
  return { kind, blocks: [...userBlocks, ...dataBlocks] };
}

export function scriptSpec(project: Project): PromptSpec {
  return buildSpec(project, 'script');
}
export function scriptPrompt(project: Project): string {
  return renderPrompt(scriptSpec(project));
}
export const screenplayPrompt = scriptPrompt;

export function extractCharactersSpec(project: Project): PromptSpec {
  return buildSpec(project, 'extract-characters');
}
export function extractScenesSpec(project: Project): PromptSpec {
  return buildSpec(project, 'extract-scenes');
}
export function extractPropsSpec(project: Project): PromptSpec {
  return buildSpec(project, 'extract-props');
}
export function extractCharactersPrompt(project: Project): string {
  return renderPrompt(extractCharactersSpec(project));
}
export function extractScenesPrompt(project: Project): string {
  return renderPrompt(extractScenesSpec(project));
}
export function extractPropsPrompt(project: Project): string {
  return renderPrompt(extractPropsSpec(project));
}

export function directorSpec(project: Project): PromptSpec {
  return buildSpec(project, 'director');
}
export function directorPrompt(project: Project): string {
  return renderPrompt(directorSpec(project));
}

export function imageSpec(project: Project, asset: Asset): PromptSpec {
  return buildSpec(project, 'image', { asset });
}
export function imagePrompt(project: Project, asset: Asset): string {
  return renderPrompt(imageSpec(project, asset));
}

export function videoSpec(project: Project, shot: Shot): PromptSpec {
  return buildSpec(project, 'video', { shot });
}
export function videoPrompt(project: Project, shot: Shot): string {
  return renderPrompt(videoSpec(project, shot));
}

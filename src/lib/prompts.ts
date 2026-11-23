// 各生成步骤的提示词：完全按用户排好的块计划拼装。
// 系统不再插入任何规则文案——规则由用户在模板编辑器里自己写。
import type { Asset, Project, Shot } from '../domain/types';
import { renderPrompt, type PromptBlock, type PromptKind, type PromptSpec } from './promptSpec';
import { applyVariables, promptVariables, styleSpecFor } from './promptTemplates';
import { planFor, renderData, type RenderContext } from './promptBlocks';

export { parseSceneHead, fixedDescription, assetSpecs, assetPromptGroups, assetText, fullAssetText, visualKinds } from './promptBlocks';
export type { ExtractCategory } from './promptBlocks';

/**
 * 按块计划拼出一个 spec：
 * 块的正文是用户写的；数据块追加作品数据；两者都走变量替换；空块渲染时跳过。
 */
function buildSpec(project: Project, kind: PromptKind, ctx: Omit<RenderContext, 'project'> = {}): PromptSpec {
  const style = styleSpecFor(project);
  const vars = promptVariables(project, style);
  const blocks: PromptBlock[] = planFor(project, kind).map(plan => {
    const data = plan.source ? renderData(plan.source, { project, ...ctx }) : '';
    const text = [plan.text.trim(), data].filter(Boolean).join('\n');
    return { id: plan.id, label: plan.title, locked: false, text: applyVariables(text, vars) };
  });
  return { kind, blocks };
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

import type { Project, StyleSpec } from '../domain/types';

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

/** 风格默认值为空：风格描述由用户在「风格设定」里自己写，系统不预置任何画风文案。 */
export function defaultStyleSpec(_style: string): StyleSpec {
  return {};
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

// 提示词的结构化表示：由用户排好的块拼出，再统一渲染成字符串。
// 没有必填块，也没有锁定块——发往模型的内容完全由用户的模板决定。
import type { PromptKindId } from '../domain/types';

export type PromptKind = PromptKindId;

export interface PromptBlock {
  id: string;
  label: string;
  text: string;
  locked?: boolean;
  reason?: string;
}

export interface PromptSpec {
  kind: PromptKind;
  blocks: PromptBlock[];
  separator?: string;
}

/** 与后端 handler 的 prompt 字段上限保持一致。设定图三类共用生图 action 的上限。 */
export const PROMPT_LIMITS: Record<PromptKind, number> = {
  script: 32000,
  'extract-characters': 32000,
  'extract-scenes': 32000,
  'extract-props': 32000,
  'image-character': 32000,
  'image-scene': 32000,
  'image-prop': 32000,
  video: 7000,
  director: 32000,
};

export function renderPrompt(spec: PromptSpec): string {
  return spec.blocks.filter(block => block.text.trim()).map(block => block.text).join(spec.separator ?? '\n\n');
}

export function promptBlock(spec: PromptSpec, id: string): PromptBlock | undefined {
  return spec.blocks.find(block => block.id === id);
}

export function validatePromptSpec(spec: PromptSpec): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const block of spec.blocks) {
    if (!block.id.trim()) issues.push('存在缺少 id 的块');
    else if (seen.has(block.id)) issues.push(`块 id 重复：${block.id}`);
    seen.add(block.id);
    if (typeof block.text !== 'string') issues.push(`块 ${block.id} 的 text 不是字符串`);
  }
  const length = renderPrompt(spec).length;
  const limit = PROMPT_LIMITS[spec.kind];
  if (length > limit) issues.push(`提示词长度 ${length} 超过上限 ${limit}`);
  if (!length) issues.push('提示词为空');
  return issues;
}

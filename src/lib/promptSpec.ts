// 提示词的结构化表示：由各构建函数拼出块，再统一渲染成字符串。
// PR6 的模板编辑器按 kind + block.id 覆盖 text；locked 块只读。
export type PromptKind = 'script' | 'extract' | 'image' | 'video' | 'assets' | 'director';

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

/** 与后端 handler 的 prompt 字段上限保持一致。 */
export const PROMPT_LIMITS: Record<PromptKind, number> = {
  script: 32000,
  extract: 32000,
  image: 32000,
  video: 7000,
  assets: 32000,
  director: 32000,
};

/** 剧本输出契约示例；键顺序与原有内联骨架一致，渲染结果逐字不变。 */
export const SCRIPT_OUTPUT_EXAMPLE = {
  title: '作品名',
  characters: [{ name: '人物名', description: '固定外观短语' }],
  scenes: [{ name: '场景名', description: '固定环境短语' }],
  props: [{ name: '道具名', description: '固定道具短语' }],
  shots: [{
    visual: '画面', camera: '运镜', start: '开场', action: '动作', end: '终点', duration: 9,
    characters: ['人物名'], scenes: ['场景名'], props: ['道具名'],
    dialogues: [{ speaker: '人物名', text: '台词' }],
  }],
};

export function renderPrompt(spec: PromptSpec): string {
  return spec.blocks.filter(block => block.text.trim()).map(block => block.text).join(spec.separator ?? '\n\n');
}

export function promptBlock(spec: PromptSpec, id: string): PromptBlock | undefined {
  return spec.blocks.find(block => block.id === id);
}

/** 只覆盖未锁定且已存在的块；未知 id 忽略。供 PR6 保存模板时使用。 */
export function applyPromptOverrides(spec: PromptSpec, overrides: Record<string, string>): PromptSpec {
  return {
    ...spec,
    blocks: spec.blocks.map(block => {
      if (block.locked) return block;
      const text = overrides[block.id];
      return text === undefined ? block : { ...block, text };
    }),
  };
}

const requiredBlocks: Record<PromptKind, string[]> = {
  script: ['script.contract', 'script.spec', 'script.asset-rules', 'script.output-shape'],
  extract: ['extract.instruction', 'extract.shots-input'],
  image: ['image.task', 'image.subject'],
  video: ['video.shot-heading', 'video.audio', 'video.fixed-assets'],
  assets: [],
  director: ['director.contract', 'director.spec'],
};

export function validatePromptSpec(spec: PromptSpec): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const block of spec.blocks) {
    if (!block.id.trim()) issues.push('存在缺少 id 的块');
    else if (seen.has(block.id)) issues.push(`块 id 重复：${block.id}`);
    seen.add(block.id);
    if (typeof block.text !== 'string') issues.push(`块 ${block.id} 的 text 不是字符串`);
  }
  for (const id of requiredBlocks[spec.kind]) {
    const block = spec.blocks.find(item => item.id === id);
    if (!block || !block.text.trim()) issues.push(`缺少必需块：${id}`);
  }
  const length = renderPrompt(spec).length;
  const limit = PROMPT_LIMITS[spec.kind];
  if (length > limit) issues.push(`提示词长度 ${length} 超过上限 ${limit}`);
  return issues;
}

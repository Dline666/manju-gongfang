// 提示词模板的作用域解析：全局模板是默认，作品可以覆盖其中某一步。
// 规则只有一条：作品覆盖层里「键存在」就归作品管（块可以是空的），
// 没有的键跟随全局模板，两边都没有就是空（只剩系统自动附带的作品数据）。
import type { PromptBlockPlan, PromptConfigV3, PromptKindId, PromptTemplateSet, Project, StyleSpec } from '../domain/types';

/** 作品自己的覆盖层（只有 v3 才有覆盖层）。 */
export function overridesOf(project: Project): PromptTemplateSet | undefined {
  const config = project.promptConfig;
  return config?.v === 3 ? config.overrides : undefined;
}

/**
 * 旧存档里保存过的数据块不再属于模板：把它从模板里剔除，
 * 但用户当年写在数据块里的补充说明保留成普通块，一个字都不丢。
 */
export function visibleBlocks(blocks: PromptBlockPlan[]): PromptBlockPlan[] {
  return blocks.flatMap(block => {
    if (!block.source) return [block];
    const text = (block.text || '').trim();
    if (!text) return [];
    const { source, ...rest } = block;
    return [{ ...rest, id: `legacy.${source}` }];
  });
}

/** 本作品在这一步是不是自己管的。 */
export function ownsKind(project: Project, kind: PromptKindId): boolean {
  return overridesOf(project)?.templates?.[kind] !== undefined;
}

/** 本作品的风格是不是自己管的。 */
export function ownsStyle(project: Project): boolean {
  const overrides = overridesOf(project);
  return !!overrides && 'style' in overrides;
}

/** 生效的块计划：作品覆盖优先，其次全局，最后空。 */
export function effectivePlan(project: Project, kind: PromptKindId, global?: PromptTemplateSet): PromptBlockPlan[] {
  const own = overridesOf(project)?.templates?.[kind];
  if (own) return visibleBlocks(own.blocks ?? []);
  const shared = global?.templates?.[kind];
  if (shared) return visibleBlocks(shared.blocks ?? []);
  return [];
}

/** 生效的风格：作品覆盖优先，其次全局，最后空（系统不预置任何画风文案）。 */
export function effectiveStyle(project: Project, global?: PromptTemplateSet): StyleSpec {
  const overrides = overridesOf(project);
  if (overrides && 'style' in overrides) return overrides.style ?? {};
  if (global?.style) return global.style;
  return {};
}

/** 整份生效的模板：作品覆盖的 kind 盖住全局，其余沿用全局。 */
export function effectiveTemplateSet(project: Project, global?: PromptTemplateSet): PromptTemplateSet {
  const overrides = overridesOf(project);
  return {
    style: effectiveStyle(project, global),
    templates: { ...(global?.templates ?? {}), ...(overrides?.templates ?? {}) },
  };
}

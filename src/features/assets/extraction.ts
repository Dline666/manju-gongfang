import { useSyncExternalStore } from 'react';
import type { Asset, Shot } from '../../domain/types';
import type { ExtractCategory } from '../../lib/prompts';

/**
 * 资产提取结果先在页面之外存一份：任务跑完时用户可能已经关掉弹窗、切到别的步骤，
 * 回到资产页还能接着审核写入。只存内存，刷新即清空。
 */
export interface ExtractionDraft {
  kind: ExtractCategory;
  revision: number;
  assets: Asset[];
  shots: Shot[];
  warnings?: string[];
}

let draft: ExtractionDraft | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const emit = () => listeners.forEach(listener => listener());

export function getExtractionDraft() { return draft; }
export function useExtractionDraft() { return useSyncExternalStore(subscribe, getExtractionDraft); }
export function setExtractionDraft(next: ExtractionDraft) { draft = next; emit(); }
export function clearExtractionDraft() { if (!draft) return; draft = undefined; emit(); }
import type { Capability, Settings } from '../domain/types';
import { endpointById, modelFor } from './endpoints';

/** 生图并发：设置优先；端点自带默认值（SiliconFlow 免费渠道 2），其余 3。 */
export function imageConcurrency(settings: Settings): number {
  if (settings.imageConcurrency) return settings.imageConcurrency;
  const endpoint = endpointById(settings, settings.imageProvider);
  return endpoint?.defaultConcurrency ?? 3;
}

export type ModelOption = { id: string; name: string; description: string };

/** 内置端点的推荐模型清单；自定义端点只有用户自己填的模型 ID。 */
export const endpointModels: Record<string, ModelOption[]> = {
  openai: [
    { id: 'gpt-image-2.6-sunburst', name: 'GPT Image 2.6 Sunburst', description: '细节与复杂提示词创作' },
    { id: 'gpt-image-2.6-flare', name: 'GPT Image 2.6 Flare', description: '快速生成与迭代' },
  ],
  seedream: [
    { id: 'doubao-seedream-5-5-261028', name: 'Seedream 5.5', description: '高质量人物与场景设定' },
    { id: 'doubao-seedream-5-0-pro-260628', name: 'Seedream 5.0 Pro', description: '精细画面创作' },
    { id: 'doubao-seedream-5-0-flash-260915', name: 'Seedream 5.0 Flash', description: '快速设定图草稿' },
  ],
  siliconflow: [
    { id: 'Kwai-Kolors/Kolors', name: 'Kolors', description: '免费 · 快手可图 · 默认' },
  ],
  seedance: [
    { id: 'doubao-seedance-2-5-260628', name: 'Doubao-Seedance-2.5', description: '质量优先，适合精细成片' },
    { id: 'doubao-seedance-2-0-260128', name: 'Doubao-Seedance-2.0', description: '兼顾画质与动作表现' },
    { id: 'doubao-seedance-2-0-fast-260128', name: 'Doubao-Seedance-2.0-fast', description: '速度优先 · 默认' },
    { id: 'doubao-seedance-2-0-mini-260615', name: 'Doubao-Seedance-2.0-mini', description: '轻量低成本，适合试稿' },
  ],
  minimax: [
    { id: 'MiniMax-H3', name: 'MiniMax H3', description: '高品质视频，支持参考图与首尾帧' },
  ],
};

/** 某端点在某环节的模型选项：内置推荐 + 用户自己填的自由文本模型。 */
export function modelOptions(settings: Settings, endpointId: string, capability: Capability): ModelOption[] {
  const list = endpointModels[endpointId] ?? [];
  const current = modelFor(settings, endpointId, capability);
  if (current && !list.some(option => option.id === current)) {
    return [...list, { id: current, name: `自定义 · ${current}`, description: '你在设置页填写的模型 ID' }];
  }
  return list;
}

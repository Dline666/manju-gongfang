import type { Settings } from '../domain/types';

type ModelOption = { id: string; name: string; description: string };

export const imageModelGroups: { provider: Settings['imageProvider']; label: string; models: ModelOption[] }[] = [
  { provider: 'openai', label: 'OpenAI', models: [
    { id: 'gpt-image-2.6-sunburst', name: 'GPT Image 2.6 Sunburst', description: '细节与复杂提示词创作' },
    { id: 'gpt-image-2.6-flare', name: 'GPT Image 2.6 Flare', description: '快速生成与迭代' },
  ] },
  { provider: 'seedream', label: '火山引擎 / 即梦（Seedream）', models: [
    { id: 'doubao-seedream-5-5-261028', name: 'Seedream 5.5', description: '高质量人物与场景设定' },
    { id: 'doubao-seedream-5-0-pro-260628', name: 'Seedream 5.0 Pro', description: '精细画面创作' },
    { id: 'doubao-seedream-5-0-flash-260915', name: 'Seedream 5.0 Flash', description: '快速设定图草稿' },
  ] },
  { provider: 'siliconflow', label: '硅基流动 SiliconFlow（免费）', models: [
    { id: 'Kwai-Kolors/Kolors', name: 'Kolors', description: '免费 · 快手可图 · 默认' },
  ] },
];

export const videoModelGroups: { provider: Settings['videoProvider']; label: string; models: ModelOption[] }[] = [
  { provider: 'seedance', label: '火山引擎 Seedance', models: [
    { id: 'doubao-seedance-2-5-260628', name: 'Doubao-Seedance-2.5', description: '质量优先，适合精细成片' },
    { id: 'doubao-seedance-2-0-260128', name: 'Doubao-Seedance-2.0', description: '兼顾画质与动作表现' },
    { id: 'doubao-seedance-2-0-fast-260128', name: 'Doubao-Seedance-2.0-fast', description: '速度优先 · 默认' },
    { id: 'doubao-seedance-2-0-mini-260615', name: 'Doubao-Seedance-2.0-mini', description: '轻量低成本，适合试稿' },
  ] },
  { provider: 'minimax', label: 'MiniMax 国内版', models: [
    { id: 'MiniMax-H3', name: 'MiniMax H3', description: '高品质视频，支持参考图与首尾帧' },
  ] },
];

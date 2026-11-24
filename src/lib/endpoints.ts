// 端点清单：内置平台与用户自填的自定义端点是同一种东西。
// 这个模块负责端点目录的查询、增删与旧存档迁移。
import {
  builtinEndpoints, defaultModels, defaultSettings, uid,
  type Capability, type Endpoint, type PromptTemplateSet, type ProviderProtocol, type Settings,
} from '../domain/types';
import { migrateTemplateSet } from './promptBlocks';

/** 每个内置端点默认承担的环节；决定旧存档的扁平 models 怎么映射到能力上。 */
const BUILTIN_CAPABILITY: Record<string, Capability> = {
  gemini: 'script', deepseek: 'script',
  openai: 'image', seedream: 'image', siliconflow: 'image',
  seedance: 'video', minimax: 'video',
};

export const CUSTOM_PROTOCOL: ProviderProtocol = 'openai-compatible';

export function endpointById(settings: Settings, id: string): Endpoint | undefined {
  return settings.endpoints.find(endpoint => endpoint.id === id);
}
/** 某环节可用的端点：内置与自定义一视同仁。 */
export function endpointsFor(settings: Settings, capability: Capability): Endpoint[] {
  return settings.endpoints.filter(endpoint => endpoint.capabilities.includes(capability));
}
export function modelFor(settings: Settings, endpointId: string, capability: Capability): string {
  return settings.models[endpointId]?.[capability] ?? '';
}
/** 端点是否配齐了某个环节的模型 ID。 */
export function hasModel(settings: Settings, endpointId: string, capability: Capability): boolean {
  return !!modelFor(settings, endpointId, capability).trim();
}

/** 新建一条自定义端点（OpenAI 兼容），默认同时承担剧本与生图。 */
export function createCustomEndpoint(name?: string): Endpoint {
  return {
    id: `custom-${uid().slice(0, 8)}`,
    name: name?.trim() || '自定义端点',
    protocol: CUSTOM_PROTOCOL,
    capabilities: ['script', 'image'],
  };
}

/**
 * 删除端点：只从可见清单里移除，**不动 models**——
 * 这样恢复时用户改过的模型 ID 还在（若顺手删掉 models[id]，
 * 下次载入时默认值合并会把它静默填回默认模型）。
 */
export function removeEndpoint(settings: Settings, id: string): Settings {
  const endpoints = settings.endpoints.filter(endpoint => endpoint.id !== id);
  const fallback = (current: string, capability: Capability) => {
    if (current !== id) return current;
    return endpoints.find(endpoint => endpoint.capabilities.includes(capability))?.id ?? '';
  };
  return {
    ...settings,
    endpoints,
    scriptProvider: fallback(settings.scriptProvider, 'script'),
    imageProvider: fallback(settings.imageProvider, 'image'),
    videoProvider: fallback(settings.videoProvider, 'video'),
  };
}

/** 恢复一个被删掉的内置端点；它改过的模型 ID 仍在 models 里，直接沿用。 */
export function restoreEndpoint(settings: Settings, id: string): Settings {
  const builtin = builtinEndpoints().find(endpoint => endpoint.id === id);
  if (!builtin || settings.endpoints.some(endpoint => endpoint.id === id)) return settings;
  const endpoints = [...settings.endpoints, builtin];
  const models = { ...settings.models };
  if (!models[id]) models[id] = defaultModels()[id] ?? {};
  return {
    ...settings,
    endpoints,
    models,
    scriptProvider: settings.scriptProvider || (builtin.capabilities.includes('script') ? id : ''),
    imageProvider: settings.imageProvider || (builtin.capabilities.includes('image') ? id : ''),
    videoProvider: settings.videoProvider || (builtin.capabilities.includes('video') ? id : ''),
  };
}

/** 内置端点里被用户删掉的那些（用于设置页的「恢复」区）。 */
export function removedBuiltins(settings: Settings): Endpoint[] {
  return builtinEndpoints().filter(builtin => !settings.endpoints.some(endpoint => endpoint.id === builtin.id));
}

/**
 * 旧存档迁移：
 * - 旧结构没有 endpoints → 补上内置端点目录；
 * - 旧结构 models 是扁平的 {端点id: 模型ID} → 按内置端点的能力映射成 {端点id: {能力: 模型ID}}；
 * - 各步骤指向的端点不存在 → 落回该环节的第一个可用端点。
 */
export function migrateSettings(saved: {
  scriptProvider?: string; imageProvider?: string; videoProvider?: string;
  endpoints?: Endpoint[]; models?: Record<string, unknown>;
  speechModel?: string; imageConcurrency?: number; customJsonMode?: boolean;
  styles?: string[];
  promptTemplates?: PromptTemplateSet;
} | undefined): Settings {
  const base = defaultSettings;
  if (!saved) return base;
  const endpoints = Array.isArray(saved.endpoints) && saved.endpoints.length ? saved.endpoints : builtinEndpoints();
  const models = migrateModels(saved.models, endpoints);
  const settings: Settings = {
    ...base,
    ...saved,
    endpoints,
    models,
    // 全局模板里可能还留着旧的共用设定图模板，一并按人物/场景/道具拆开。
    promptTemplates: migrateTemplateSet(saved.promptTemplates),
    scriptProvider: pickEndpoint(endpoints, saved.scriptProvider, 'script') ?? base.scriptProvider,
    imageProvider: pickEndpoint(endpoints, saved.imageProvider, 'image') ?? base.imageProvider,
    videoProvider: pickEndpoint(endpoints, saved.videoProvider, 'video') ?? base.videoProvider,
    speechModel: saved.speechModel ?? base.speechModel,
  };
  return settings;
}

function pickEndpoint(endpoints: Endpoint[], id: string | undefined, capability: Capability): string | undefined {
  if (id && endpoints.some(endpoint => endpoint.id === id && endpoint.capabilities.includes(capability))) return id;
  return endpoints.find(endpoint => endpoint.capabilities.includes(capability))?.id;
}

/** 旧的扁平 models 迁移到按能力分键；已经是新结构的原样保留。 */
function migrateModels(saved: Record<string, unknown> | undefined, endpoints: Endpoint[]): Settings['models'] {
  const result: Settings['models'] = {};
  const defaults = defaultModels();
  for (const endpoint of endpoints) {
    const value = saved?.[endpoint.id];
    if (value === undefined) {
      // 旧存档缺这个端点的模型时，按端点能力补上默认值（等价于旧 schema 的 transform）。
      if (defaults[endpoint.id]) result[endpoint.id] = { ...defaults[endpoint.id] };
      continue;
    }
    if (typeof value === 'string') {
      const capability = BUILTIN_CAPABILITY[endpoint.id] ?? endpoint.capabilities[0];
      if (capability) result[endpoint.id] = { [capability]: value };
    } else if (value && typeof value === 'object') {
      const picked: Partial<Record<Capability, string>> = {};
      for (const [key, model] of Object.entries(value as Record<string, unknown>)) {
        if ((['script', 'image', 'video', 'speech'] as string[]).includes(key) && typeof model === 'string') picked[key as Capability] = model;
      }
      result[endpoint.id] = picked;
    }
  }
  return result;
}

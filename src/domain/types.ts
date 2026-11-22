export type Provider = 'gemini' | 'deepseek' | 'openai' | 'seedream' | 'siliconflow' | 'seedance' | 'minimax';
export type Stage = 'library' | 'script' | 'assets' | 'storyboard' | 'generation' | 'export' | 'settings';
export type AssetKind = 'character' | 'scene' | 'prop' | 'voice';
export type SkillId = 'script' | 'storyboard' | 'image' | 'video';
export interface Asset {
  id: string; kind: AssetKind; name: string; description: string; lock: string;
  imageId?: string; voiceId?: string; voiceAssetId?: string; speed?: number;
}
export interface Dialogue { id: string; speakerId: string; text: string }
export interface Reference { assetId: string; role: 'reference_image' | 'first_frame' | 'last_frame' }
export interface VideoSource { name: string; url?: string; duration: number; origin: 'upload' | 'link' | 'api' }
export interface AudioSource { mediaId: string; name: string; duration: number }
export interface VideoTask {
  provider: 'seedance' | 'minimax'; model: string; id?: string;
  status: 'submitting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';
  revision: number; error?: string; createdAt: string;
}
export interface Shot {
  id: string; number: number; duration: number; visual: string; camera: string;
  start: string; action: string; end: string; dialogues: Dialogue[];
  assetIds: string[]; references: Reference[]; video?: VideoSource; audio?: AudioSource;
  audioMode: 'original' | 'dubbing' | 'silent'; task?: VideoTask; stale?: boolean;
}
export interface StyleSpec {
  medium?: string; line?: string; palette?: string; face?: string; light?: string;
  forbidden?: string[];
}
export interface PromptConfig {
  v: 1;
  style?: StyleSpec;
  blocks?: Record<string, string>;
}
export interface Project {
  id: string; name: string; theme: string; style: string; createdAt: string; updatedAt: string;
  revision: number; skills: SkillId[]; shots: Shot[]; assets: Asset[]; source: 'empty' | 'template' | 'import' | 'ai';
  storyboardReady: boolean;
  promptConfig?: PromptConfig;
}
export interface Settings {
  scriptProvider: 'gemini' | 'deepseek'; imageProvider: 'openai' | 'seedream' | 'siliconflow'; videoProvider: 'seedance' | 'minimax';
  models: Record<Provider, string>; speechModel: string;
  imageConcurrency?: number;
}
export interface ProviderStatus { status: 'available' | 'failed'; action: string; model?: string; error?: string; hint?: string }
export interface StudioState {
  version: 1; projects: Project[]; activeId: string | null; settings: Settings;
  keys: Partial<Record<Provider, string>>; providerStatus: Partial<Record<Provider, ProviderStatus>>; storageError: string | null;
}
export interface PageProps { project: Project; navigate: (stage: Stage) => void }
export const uid = () => crypto.randomUUID();
export const defaultStyle = '东方玄幻水墨风，冷灰 + 金色灵光';
export const defaultSettings: Settings = {
  scriptProvider: 'gemini', imageProvider: 'openai', videoProvider: 'seedance',
  models: { gemini: 'gemini-4-hydrogen', deepseek: 'deepseek-flash', openai: 'gpt-image-2.6-sunburst', seedream: 'doubao-seedream-5-5-261028', siliconflow: 'Kwai-Kolors/Kolors', seedance: 'doubao-seedance-2-0-fast-260128', minimax: 'MiniMax-H3' },
  speechModel: 'speech-2.8-hd',
};
export function makeShot(number: number): Shot {
  return { id: uid(), number, duration: 9, visual: '', camera: '缓慢推进', start: '', action: '', end: '', dialogues: [], assetIds: [], references: [], audioMode: 'original' };
}

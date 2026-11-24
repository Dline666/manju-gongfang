// 提示词块：内置块目录、固定注入的数据源、块计划读取与存档迁移。
// 设计约束：系统不提供任何默认提示词文案——模板里只有用户自己写的块；
// 作品数据不属于模板块，渲染时由系统固定附带。
// 模型的固定契约由后端持有，编辑器通过 contracts 接口原样展示。
import type {
  Asset, Project, PromptBlockPlan, PromptDataSource, PromptKindId, PromptTemplatePlan, PromptTemplateSet, Shot, SkillId, StyleSpec,
} from '../domain/types';
import { speakerName } from '../domain/types';
import { skills } from './skills';
import { styleBlockText } from './promptTemplates';
import { effectiveStyle, visibleBlocks } from './promptScope';

export const PROMPT_KINDS: readonly PromptKindId[] = ['script', 'extract-characters', 'extract-scenes', 'extract-props', 'director', 'image-character', 'image-scene', 'image-prop', 'video'];

/** 资产提取的品类：人物 / 场景 / 道具，各自独立识别、各用各的提示词。 */
export type ExtractCategory = 'character' | 'scene' | 'prop';

/** 内置块：只有 id 与标题，没有默认内容。用户插入后自己写。 */
export interface BuiltinBlock { id: string; title: string; group?: string; kinds: PromptKindId[] }

export const builtinBlocks: BuiltinBlock[] = [
  // 剧本
  { id: 'script.contract', title: '输出契约', kinds: ['script'] },
  { id: 'script.structure', title: '剧本结构', kinds: ['script'] },
  { id: 'script.screenplay-format', title: '剧本正文规范', kinds: ['script'] },
  { id: 'script.spec', title: '成片规格', kinds: ['script'] },
  { id: 'script.fidelity', title: '忠实度', kinds: ['script'] },
  { id: 'script.visualization', title: '可拍摄性铁律', kinds: ['script'] },
  { id: 'script.rhythm', title: '动作与对白交替', kinds: ['script'] },
  { id: 'script.timing', title: '时长可行性', kinds: ['script'] },
  { id: 'script.drama', title: '剧作规范', kinds: ['script'] },
  { id: 'script.forbidden', title: '禁写清单', kinds: ['script'] },
  { id: 'script.genre', title: '题材补充', kinds: ['script'] },
  { id: 'script.output-shape', title: '输出结构', kinds: ['script'] },
  { id: 'script.priority', title: '优先级', kinds: ['script'] },
  { id: 'script.extra', title: '自由补充', kinds: ['script'] },
  // 资产：人物 / 场景 / 道具各一组
  { id: 'extract.characters.instruction', title: '人物 · 识别规则', group: '人物', kinds: ['extract-characters'] },
  { id: 'extract.characters.phrase-style', title: '人物 · 固定短语写法', group: '人物', kinds: ['extract-characters'] },
  { id: 'extract.characters.forbidden', title: '人物 · 禁写清单', group: '人物', kinds: ['extract-characters'] },
  { id: 'extract.scenes.instruction', title: '场景 · 识别规则', group: '场景', kinds: ['extract-scenes'] },
  { id: 'extract.scenes.phrase-style', title: '场景 · 固定短语写法', group: '场景', kinds: ['extract-scenes'] },
  { id: 'extract.scenes.forbidden', title: '场景 · 禁写清单', group: '场景', kinds: ['extract-scenes'] },
  { id: 'extract.props.instruction', title: '道具 · 识别规则', group: '道具', kinds: ['extract-props'] },
  { id: 'extract.props.phrase-style', title: '道具 · 固定短语写法', group: '道具', kinds: ['extract-props'] },
  { id: 'extract.props.forbidden', title: '道具 · 禁写清单', group: '道具', kinds: ['extract-props'] },
  // 导演
  { id: 'director.contract', title: '输出契约', kinds: ['director'] },
  { id: 'director.shot-types', title: '镜头类型表', kinds: ['director'] },
  { id: 'director.shot-allocation', title: '镜头分配规则', kinds: ['director'] },
  { id: 'director.rhythm', title: '镜头节奏', kinds: ['director'] },
  { id: 'director.spec', title: '导演规范', kinds: ['director'] },
  { id: 'director.transition', title: '衔接与转场', kinds: ['director'] },
  { id: 'director.forbidden', title: '禁写清单', kinds: ['director'] },
  { id: 'director.priority', title: '优先级', kinds: ['director'] },
  // 图片：人物 / 场景 / 道具各一份，互不混用
  { id: 'image.character.three-view', title: '人物三视图条款', kinds: ['image-character'] },
  { id: 'image.character.forbidden', title: '人物禁写清单', kinds: ['image-character'] },
  { id: 'image.character.priority', title: '人物优先级', kinds: ['image-character'] },
  { id: 'image.scene.composition', title: '场景构图说明', kinds: ['image-scene'] },
  { id: 'image.scene.forbidden', title: '场景禁写清单', kinds: ['image-scene'] },
  { id: 'image.scene.priority', title: '场景优先级', kinds: ['image-scene'] },
  { id: 'image.prop.composition', title: '道具构图说明', kinds: ['image-prop'] },
  { id: 'image.prop.forbidden', title: '道具禁写清单', kinds: ['image-prop'] },
  { id: 'image.prop.priority', title: '道具优先级', kinds: ['image-prop'] },
  // 视频
  { id: 'video.motion', title: '运动规范', kinds: ['video'] },
  { id: 'video.forbidden', title: '禁写清单', kinds: ['video'] },
  { id: 'video.priority', title: '优先级', kinds: ['video'] },
];

export function builtinById(id: string): BuiltinBlock | undefined {
  return builtinBlocks.find(block => block.id === id);
}
export function builtinBlocksFor(kind: PromptKindId): BuiltinBlock[] {
  return builtinBlocks.filter(block => block.kinds.includes(kind));
}

/**
 * 固定注入的数据源：不属于模板，用户不能增删调序。
 * 每次渲染时由系统按 kind 带上，排在用户写的块之后。
 */
export interface DataBlockDef { source: PromptDataSource; title: string }

const DATA_SOURCES: Record<PromptKindId, DataBlockDef[]> = {
  script: [
    { source: 'script.theme', title: '主题与风格' },
    { source: 'script.source', title: '原文' },
    { source: 'script.characters', title: '已有角色名' },
    { source: 'script.skills', title: '附加 Skill' },
  ],
  'extract-characters': [
    { source: 'extract.characters.shots', title: '本类线索' },
    { source: 'extract.characters.existing', title: '已有本类固定资产' },
  ],
  'extract-scenes': [
    { source: 'extract.scenes.shots', title: '本类线索' },
    { source: 'extract.scenes.existing', title: '已有本类固定资产' },
  ],
  'extract-props': [
    { source: 'extract.props.shots', title: '本类线索' },
    { source: 'extract.props.existing', title: '已有本类固定资产' },
  ],
  director: [
    { source: 'director.shots', title: '逐镜剧本' },
    { source: 'director.skills', title: '附加 Skill' },
  ],
  // 设定图三类共用同一份作品数据，但各自的模板互不混用。
  'image-character': [
    { source: 'image.task', title: '任务与风格' },
    { source: 'image.subject', title: '固定短语' },
    { source: 'image.style', title: '风格块' },
    { source: 'image.skills', title: '附加 Skill' },
  ],
  'image-scene': [
    { source: 'image.task', title: '任务与风格' },
    { source: 'image.subject', title: '固定短语' },
    { source: 'image.style', title: '风格块' },
    { source: 'image.skills', title: '附加 Skill' },
  ],
  'image-prop': [
    { source: 'image.task', title: '任务与风格' },
    { source: 'image.subject', title: '固定短语' },
    { source: 'image.style', title: '风格块' },
    { source: 'image.skills', title: '附加 Skill' },
  ],
  video: [
    { source: 'video.heading', title: '镜头开头' },
    { source: 'video.continuity', title: '承接上一镜' },
    { source: 'video.references', title: '附件顺序' },
    { source: 'video.action', title: '动作与运镜' },
    { source: 'video.dialogue', title: '对白节奏' },
    { source: 'video.audio', title: '音频模式' },
    { source: 'video.assets', title: '固定资产块' },
    { source: 'video.style', title: '风格块' },
    { source: 'video.skills', title: '附加 Skill' },
  ],
};

export function dataSourcesFor(kind: PromptKindId): DataBlockDef[] {
  return DATA_SOURCES[kind] ?? [];
}

/**
 * 模板默认是空的：模板里只有用户自己写的块。
 * 旧存档里保存过的数据块会被剔除（数据改由系统固定注入），
 * 但用户当年写在数据块里的补充说明保留成普通块，一个字都不丢。
 */
export function legacyPlanFor(config: Project['promptConfig'], kind: PromptKindId): PromptBlockPlan[] {
  const plan = config?.v === 2 ? config.templates?.[kind] : undefined;
  if (!plan) return [];
  return visibleBlocks(plan.blocks ?? []);
}

// ── 作品数据渲染 ──────────────────────────────────────────────

/** 场景头拆成内外景 / 地点 / 时间三段。剧本解析与资产提取共用。 */
export function parseSceneHead(head: string): { kind: string; place: string; time: string } {
  const trimmed = head.trim().replace(/^·/, '').trim();
  const dash = trimmed.split(/\s*[—–]\s*/);
  const time = dash.length > 1 ? dash[dash.length - 1].trim() : '';
  const left = (dash.length > 1 ? dash.slice(0, -1).join('—') : trimmed).trim();
  const dot = left.split(/\s*[·•]\s*/);
  return { kind: dot.length > 1 ? dot[0].trim() : '', place: dot.length > 1 ? dot.slice(1).join('·').trim() : left, time };
}

export const fixedDescription = (asset: Asset) => asset.lock || asset.description;

const kindNames = { character: '人物', scene: '场景', prop: '道具', voice: '音色' };
export const visualKinds = ['character', 'scene', 'prop'] as const;

export function assetSpecs(project: Project, shot: Shot) {
  const ids = new Set([...shot.assetIds, ...shot.references.map(r => r.assetId), ...shot.dialogues.map(d => d.speakerId)]);
  return visualKinds.map(kind => {
    const assets = project.assets.filter(a => a.kind === kind && ids.has(a.id));
    const missing = !assets.length || assets.some(a => !fixedDescription(a).trim());
    const label = `${kindNames[kind]}提示词`;
    const content = assets.length ? assets.map(a => `${kindNames[kind]}「${a.name}」：${fixedDescription(a).trim() ? fixedDescription(a) : '【缺失：固定短语待补充】'}`).join('\n') : `【缺失：未关联${kindNames[kind]}资产，请补充；若本镜不需要，请人工确认】`;
    return { kind, label, missing, text: `【${label}】\n${content}` };
  });
}
export function assetPromptGroups(project: Project, shot: Shot) {
  return assetSpecs(project, shot).map(({ kind, label, missing, text }) => ({ kind, label, missing, text }));
}
export function assetText(project: Project, shot: Shot): string {
  return assetPromptGroups(project, shot).map(group => group.text).join('\n\n');
}
export function fullAssetText(project: Project, shot: Shot): string {
  const speakerIds = new Set([...shot.assetIds, ...shot.dialogues.map(d => d.speakerId)]);
  const voiceIds = new Set(project.assets.filter(a => speakerIds.has(a.id)).map(a => a.voiceAssetId));
  const voices = project.assets.filter(a => a.kind === 'voice' && (speakerIds.has(a.id) || voiceIds.has(a.id)));
  return [assetText(project, shot), ...voices.map(a => `音色「${a.name}」：${a.description}\n音色ID：${a.voiceId || '未设置'}；语速：${a.speed ?? 1}×`)].filter(Boolean).join('\n');
}

const shotVisual = (shot: Shot) => shot.visual.replace(/^【[^】]*】/, '').trim();
const sceneLabel = (head: string) => {
  if (!head.trim()) return '未标注场景';
  const { kind, place, time } = parseSceneHead(head);
  return [kind, place, time].filter(Boolean).join(' · ') || head.trim();
};
const shotRanges = (shots: Shot[]) => {
  const numbers = shots.map(shot => shot.number).sort((a, b) => a - b);
  if (!numbers.length) return '无镜头';
  const parts: string[] = [];
  let start = numbers[0]; let previous = numbers[0];
  for (const number of numbers.slice(1)) {
    if (number === previous + 1) { previous = number; continue; }
    parts.push(start === previous ? `第${start}镜` : `第${start}–${previous}镜`);
    start = previous = number;
  }
  parts.push(start === previous ? `第${start}镜` : `第${start}–${previous}镜`);
  return parts.join('、');
};

function extractCharactersInput(project: Project): string {
  const speakers: string[] = [];
  const lines = project.shots.map(shot => {
    const dialogues = shot.dialogues.map(line => {
      const name = speakerName(project, line);
      if (name && !speakers.includes(name)) speakers.push(name);
      return `${name || '未指定人物'}：“${line.text}”`;
    });
    return `第${shot.number}镜｜场景：${sceneLabel(shot.scene || '')}\n  画面：${shotVisual(shot)}\n  台词：${dialogues.length ? dialogues.join(' ') : '无'}`;
  });
  return [`【说话人清单】\n${speakers.length ? speakers.join('、') : '（本片没有台词人物）'}`, `【逐镜】\n${lines.join('\n')}`].join('\n\n');
}
function extractScenesInput(project: Project): string {
  const groups: { head: string; shots: Shot[] }[] = [];
  for (const shot of project.shots) {
    const found = groups.find(group => group.head === (shot.scene || ''));
    if (found) found.shots.push(shot); else groups.push({ head: shot.scene || '', shots: [shot] });
  }
  const index = new Map(groups.map((group, position) => [group.head, position + 1]));
  const list = groups.map((group, position) => `场景${position + 1}｜${sceneLabel(group.head)}｜出现于${shotRanges(group.shots)}`);
  const lines = project.shots.map(shot => `第${shot.number}镜｜所属空间：场景${index.get(shot.scene || '')}\n  画面：${shotVisual(shot)}`);
  return [`【场景清单】\n${list.join('\n')}`, `【逐镜】\n${lines.join('\n')}`].join('\n\n');
}
function extractPropsInput(project: Project): string {
  return `【逐镜动作摘要】\n${project.shots.map(shot => `第${shot.number}镜：${shotVisual(shot)}`).join('\n')}`;
}

const selectedSkills = (project: Project, ids: SkillId[]) => skills.filter(s => project.skills.includes(s.id) && ids.includes(s.id)).map(s => `【${s.name}】${s.template}`).join('\n');

export interface RenderContext { project: Project; asset?: Asset; shot?: Shot; global?: PromptTemplateSet }

const AUDIO_MODES = { original: '原声', dubbing: '后期配音', silent: '静音' } as const;

/** 渲染一个数据块的内容：只有作品数据，没有规则文案。 */
export function renderData(source: PromptDataSource, ctx: RenderContext): string {
  const { project, asset, shot } = ctx;
  switch (source) {
    case 'script.theme': {
      const lines = [
        project.theme.trim() ? `主题：${project.theme.trim()}` : '',
        project.style.trim() ? `统一风格：${project.style.trim()}` : '',
        project.logline?.trim() ? `主线：${project.logline.trim()}` : '',
      ];
      return lines.filter(Boolean).join('\n');
    }
    case 'script.source': {
      const text = (project.sourceText || '').trim();
      if (!text) return '';
      return `<原文>\n${text}\n</原文>`;
    }
    case 'script.characters': {
      const people = project.assets.filter(a => a.kind === 'character');
      if (!people.length) return '';
      return people.map(a => `${a.name}：${fixedDescription(a)}`).join('\n');
    }
    case 'script.skills': return selectedSkills(project, ['script']);
    case 'extract.characters.shots': return extractCharactersInput(project);
    case 'extract.characters.existing': return existingAssets(project, 'character');
    case 'extract.scenes.shots': return extractScenesInput(project);
    case 'extract.scenes.existing': return existingAssets(project, 'scene');
    case 'extract.props.shots': return extractPropsInput(project);
    case 'extract.props.existing': return existingAssets(project, 'prop');
    case 'director.shots': return JSON.stringify(project.shots.map(item => ({
      number: item.number, title: item.title || '', scene: item.scene || '', cameraHint: item.cameraHint || '', duration: item.duration, visual: item.visual,
      characters: project.assets.filter(a => item.assetIds.includes(a.id) && a.kind === 'character').map(a => a.name),
      scenes: project.assets.filter(a => item.assetIds.includes(a.id) && a.kind === 'scene').map(a => a.name),
      props: project.assets.filter(a => item.assetIds.includes(a.id) && a.kind === 'prop').map(a => a.name),
      dialogues: item.dialogues.map(line => ({ speaker: speakerName(project, line), text: line.text })),
    })));
    case 'director.skills': return selectedSkills(project, ['storyboard']);
    case 'image.task': {
      const lines = [
        asset ? `资产：${asset.name}` : '',
        (project.theme || project.name).trim() ? `作品主题：${(project.theme || project.name).trim()}` : '',
        project.style.trim() ? `风格：${project.style.trim()}` : '',
      ];
      return lines.filter(Boolean).join('\n');
    }
    case 'image.subject': return asset ? `主体：${asset.name}\n${fixedDescription(asset)}` : '';
    case 'image.style': return styleBlockText(effectiveStyle(project, ctx.global));
    case 'image.skills': return selectedSkills(project, ['image']);
    case 'video.heading': return shot ? `第${shot.number}镜，${shot.duration}秒。\n风格：${project.style}` : '';
    case 'video.continuity': {
      if (!shot) return '';
      const index = project.shots.findIndex(s => s.id === shot.id);
      const previous = project.shots[index - 1];
      return previous?.end ? `上一镜终点：${previous.end}` : '';
    }
    case 'video.references': {
      if (!shot) return '';
      const lines = shot.references.flatMap((r, i) => {
        const item = project.assets.find(a => a.id === r.assetId && a.imageId && a.kind !== 'voice');
        return item ? [`图${i + 1}：${roleNames[r.role]} · ${item.name}`] : [];
      });
      return lines.length ? lines.join('\n') : '本镜没有挂载附件。';
    }
    case 'video.action': return shot ? `动作：${shot.action}\n运镜：${shot.camera}\n终点：${shot.end}` : '';
    case 'video.dialogue': {
      if (!shot) return '';
      const lines = shot.dialogues.map(line => `${speakerName(project, line) || '未指定人物'}：${line.text}`);
      return lines.length ? lines.join('\n') : '（无对白）';
    }
    case 'video.audio': return shot ? `音频模式：${AUDIO_MODES[shot.audioMode] ?? shot.audioMode}` : '';
    case 'video.assets': return shot ? shotAssetText(project, shot) : '';
    case 'video.style': return styleBlockText(effectiveStyle(project, ctx.global), 'concise');
    case 'video.skills': return selectedSkills(project, ['video']);
    default: return '';
  }
}

const roleNames = { reference_image: '参考图', first_frame: '首帧', last_frame: '尾帧' };

function existingAssets(project: Project, kind: 'character' | 'scene' | 'prop'): string {
  const list = project.assets.filter(asset => asset.kind === kind);
  if (!list.length) return '';
  return list.map(asset => `${kindNames[kind]}「${asset.name}」：${fixedDescription(asset)}`).join('\n');
}

/** 本镜的固定资产短语（只列事实，不加规则）。 */
function shotAssetText(project: Project, shot: Shot): string {
  const ids = new Set([...shot.assetIds, ...shot.references.map(r => r.assetId), ...shot.dialogues.map(d => d.speakerId)]);
  const parts: string[] = [];
  for (const kind of visualKinds) {
    const assets = project.assets.filter(a => a.kind === kind && ids.has(a.id));
    if (!assets.length) { parts.push(`${kindNames[kind]}：未关联`); continue; }
    parts.push(assets.map(a => `${kindNames[kind]}「${a.name}」：${fixedDescription(a)}`).join('\n'));
  }
  return parts.join('\n');
}

// ── 存档迁移 ──────────────────────────────────────────────────

/**
 * 旧结构里人物 / 场景 / 道具共用一份设定图模板，拆成三份时的归类规则。
 * 带内置 id 的块按它的品类走（人物三视图条款 → 人物，场景构图 → 场景，道具构图 → 道具）；
 * 原来三类通用的禁写清单与优先级拆成三份；用户自己新建的块过去对三类都生效，复制到三份，
 * 行为一字不变——之后要各写各的，就到对应那一份里改。
 */
const IMAGE_BLOCK_ROUTES: Record<string, { kind: PromptKindId; id: string; title: string }[]> = {
  'image.three-view': [{ kind: 'image-character', id: 'image.character.three-view', title: '人物三视图条款' }],
  'image.scene-composition': [{ kind: 'image-scene', id: 'image.scene.composition', title: '场景构图说明' }],
  'image.prop-composition': [{ kind: 'image-prop', id: 'image.prop.composition', title: '道具构图说明' }],
  'image.forbidden': [
    { kind: 'image-character', id: 'image.character.forbidden', title: '人物禁写清单' },
    { kind: 'image-scene', id: 'image.scene.forbidden', title: '场景禁写清单' },
    { kind: 'image-prop', id: 'image.prop.forbidden', title: '道具禁写清单' },
  ],
  'image.priority': [
    { kind: 'image-character', id: 'image.character.priority', title: '人物优先级' },
    { kind: 'image-scene', id: 'image.scene.priority', title: '场景优先级' },
    { kind: 'image-prop', id: 'image.prop.priority', title: '道具优先级' },
  ],
};

const IMAGE_KINDS: PromptKindId[] = ['image-character', 'image-scene', 'image-prop'];

/** 把一份模板集合里的旧设定图模板拆成三份；没有旧的就原样返回。 */
export function migrateTemplateSet(set: PromptTemplateSet | undefined): PromptTemplateSet | undefined {
  if (!set) return set;
  const legacy = set.templates?.image;
  if (!legacy) return set;
  const templates: Partial<Record<PromptKindId, PromptTemplatePlan>> = { ...set.templates };
  delete (templates as Partial<Record<'image', PromptTemplatePlan>>).image;
  const append = (kind: PromptKindId, block: PromptBlockPlan) => {
    const plan = templates[kind] ?? { blocks: [] };
    templates[kind] = { blocks: [...plan.blocks, block] };
  };
  for (const block of legacy.blocks ?? []) {
    const routes = IMAGE_BLOCK_ROUTES[block.builtin ?? block.id];
    if (routes) {
      for (const route of routes) append(route.kind, { ...block, id: route.id, title: route.title, builtin: route.id });
      continue;
    }
    // 用户自己写的块：过去三类共用，复制到三份。
    for (const kind of IMAGE_KINDS) append(kind, { ...block });
  }
  return { ...set, templates };
}

/**
 * 模板存档的迁移：v1（块 id → 覆盖文本）→ v2（每个 kind 一份块计划）→ v3（作品覆盖层）。
 *
 * v3 之后模板分两层：全局模板是默认，作品只存「覆盖层」。
 * 旧作品里写过的步骤变成它自己的覆盖（内容一个字不丢），
 * 没写过的步骤不进覆盖层，跟着全局走。
 * 迁移不会带回任何默认文案——旧值只可能是用户自己改过的内容。
 */
export function migratePromptConfig(config: Project['promptConfig']): Project['promptConfig'] {
  if (!config) return undefined;
  if (config.v === 3) {
    // v3 的覆盖层里可能还留着旧的共用设定图模板，一并拆开。
    if (!config.overrides?.templates?.image) return config;
    return { ...config, overrides: migrateTemplateSet(config.overrides) };
  }
  const v2 = config.v === 1 ? migrateV1ToV2(config) : config;
  return migrateV2ToV3(v2);
}

/** v1（块 id → 覆盖文本）迁移成 v2（每个 kind 一份块计划）。 */
function migrateV1ToV2(config: Extract<NonNullable<Project['promptConfig']>, { v: 1 }>): Extract<NonNullable<Project['promptConfig']>, { v: 2 }> {
  const templates: Partial<Record<PromptKindId, PromptTemplatePlan>> = {};
  for (const [id, text] of Object.entries(config.blocks ?? {})) {
    // 旧的设定图内置块 id 已改名，按归类规则落到三个品类里。
    const routes = IMAGE_BLOCK_ROUTES[id];
    if (routes) {
      for (const route of routes) {
        const plan = templates[route.kind] ?? { blocks: [] };
        plan.blocks.push({ id: route.id, title: route.title, text, builtin: route.id });
        templates[route.kind] = plan;
      }
      continue;
    }
    const builtin = builtinById(id);
    if (!builtin) continue;
    const kind = builtin.kinds[0];
    const plan = templates[kind] ?? { blocks: [] };
    plan.blocks.push({ id, title: builtin.title, text, builtin: id });
    templates[kind] = plan;
  }
  // 按内置目录顺序排列，同一 kind 内保持目录次序。
  for (const kind of Object.keys(templates) as PromptKindId[]) {
    const plan = templates[kind]!;
    const order = new Map(builtinBlocks.filter(b => b.kinds.includes(kind)).map((b, index) => [b.id, index]));
    plan.blocks.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
  }
  return { v: 2, style: config.style, templates };
}

/**
 * v2 → v3：把作品自己的模板搬进覆盖层。
 * 块为空的步骤不进覆盖层——它本来就没有内容，让它跟随全局；
 * 块非空的步骤进覆盖层，从此这一步归这部作品管。
 */
function migrateV2ToV3(config: Extract<NonNullable<Project['promptConfig']>, { v: 2 }>): Project['promptConfig'] {
  const templates: Partial<Record<PromptKindId, PromptTemplatePlan>> = {};
  for (const kind of PROMPT_KINDS) {
    const plan = config.templates?.[kind];
    if (!plan) continue;
    const blocks = visibleBlocks(plan.blocks ?? []);
    if (blocks.length) templates[kind] = { blocks };
  }
  // 旧结构里设定图是一份（'image'），要按人物/场景/道具拆开。
  const legacyImage = config.templates?.image;
  if (legacyImage) (templates as Partial<Record<'image', PromptTemplatePlan>>).image = { blocks: visibleBlocks(legacyImage.blocks ?? []) };
  const overrides: PromptTemplateSet = { templates };
  if (hasStyleContent(config.style)) overrides.style = config.style;
  return { v: 3, overrides: migrateTemplateSet(overrides) };
}

/** 风格里有没有真东西（空对象不算「这部作品自己管风格」）。 */
function hasStyleContent(style: StyleSpec | undefined): boolean {
  if (!style) return false;
  if (style.forbidden?.length) return true;
  const fields: (keyof StyleSpec)[] = ['medium', 'line', 'palette', 'face', 'light'];
  return fields.some(key => !!(style[key] as string | undefined)?.trim());
}

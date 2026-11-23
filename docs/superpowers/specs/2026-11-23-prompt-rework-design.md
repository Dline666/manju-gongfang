# 提示词重构设计：发往模型的提示词对用户完全透明

日期：2026-11-23
状态：待用户批准（第 2 版，已按 builder check 修订）

## 一、意图与为什么

现状：发往模型的提示词由三层拼成，其中两层用户看不见也改不到。

1. **前端模板块默认文本** — `src/lib/promptTemplates.ts` 里 5 个模板共 39 个内置块，全部带默认文案，其中 15 个标了 `locked: true`（只读）。
2. **系统生成块** — `src/lib/prompts.ts` 在每次请求时用固定措辞拼出（主题块、原文块、逐镜输入块、固定资产块、附件顺序块……）。
3. **后端 `system_instruction` + schema 描述** — `functions/handler.ts` 的 `SCREENPLAY_INSTRUCTION` / `EXTRACT_*_INSTRUCTION` / `DIRECTOR_INSTRUCTION`，以及 `SCREENPLAY_SCHEMA.properties.screenplay.description` 里的四部分结构、【镜头】标注、时长规则。前端完全看不到。

用户诉求：**「将目前的所有默认提示词全部删除，所有锁定的提示词部分都解锁，我要重构提示词」**，「我要的是向模型发送的提示词对用户完全透明」。

验收线只有一条：**模型收到的提示词文本，100% 能在模板编辑器里看到、编辑；系统不再注入任何固定文案。**

## 二、目标 / 非目标 / 反目标

**目标**

- G1 三层固定文案全部清除：内置块默认文本、系统块的引导语、后端 instruction 与 schema 描述里的业务规则。
- G2 模板编辑器支持自由增删块、改标题、改内容、调顺序；没有任何锁定块。
- G3 发往模型的提示词文本 100% 可见可改（模板编辑器实时预览 = 实际发送内容）。
- G4 校验不再因"格式不符旧模板"而拒绝生成，允许新结构。
- G5 作品数据（原文、逐镜、固定资产、风格、附件顺序、Skill）继续自动进入提示词，但**可见、可改标题、可追加说明、可删除、可调序**。

**非目标**

- 不改模型返回的 JSON **形状**（schema 的 properties / required / enum）。那是接口取值域，不是提示词文案。
- 不改导出、preflight、媒体编码等本轮范围外的能力。
- 不做提示词版本管理、历史回滚、跨项目共享。

**反目标（做到就算失败）**

- 不能出现"提示词编辑器里看不到、但模型收到了"的文字。
- 不能出现"用户删掉一个块，发送内容里还在"的情况。
- 不能出现"模板为空时静默发出一份只有数据、没有规则的提示词"——必须拦下来并明确告知。

## 三、约束

- C1 后端 `validateScreenplay` 要求剧本正文 ≥200 字、含【镜头：】、≥3 个时长标记、总时长 10–900 秒；前端 `parseScreenplay`（`src/features/script/screenplay.ts`，不是 `creation.ts`）靠【镜头：类型】拆镜。**这是代码约束，不是提示词。**（本设计按用户选择放松，见 §5.6。）
- C2 导演输出的 `shotSize` / `movement` / `angle` 必须落在后端枚举内。枚举是接口取值域。
- C3 资产提取的返回形状由 `EXTRACT_KIND_SCHEMA` 固定为 `{characters|scenes|props: [...], shots: [{number, <key>: [...]}]}`。
- C4 每个项目的提示词模板随项目存（`project.promptConfig`），存在 localStorage；`savedStudioSchema` 外层 `version` 保持 1。
- C5 工作区存在他人未提交的并行改动，必须逐处精确编辑，不得 `git checkout` / `git stash` 覆盖。

## 四、方案（已与用户确认的决策）

| 决策点 | 用户选择 |
|---|---|
| 删除范围 | 三层全清 —— 「都清理，我要的是向模型发送的提示词对用户完全透明」 |
| 解锁范围 | 模板编辑器里的 15 个锁定块（全部解锁） |
| 块结构 | 内置块全删，改成可自由新增/删除块 |
| 硬校验 | 校验一起改，允许新结构 |
| 拆镜来源 | 容错拆镜：有【镜头】按它拆，没有就降级拆 |
| 作品数据块 | 默认带入，但可见可改 |

**调和说明**：解锁范围选"模板里的 15 个锁定块"，删除范围选"三层全清"。调和方式——**内置块不再是"带默认内容的模板"，而是"标题目录"**：39 个内置块保留 id 与标题（`defaultText` 字段直接删除，不是置空），在编辑器里作为「插入内置块」可选项；插入后内容为空，由用户自己写。这样"15 个锁定块全部解锁"与"内置块全删"同时成立。

## 五、架构

### 5.1 统一的块模型

新增 `src/lib/promptBlocks.ts`：

```ts
export type PromptKindId = 'script' | 'extract-characters' | 'extract-scenes' | 'extract-props'
  | 'director' | 'image' | 'video';

export type DataSourceId =
  | 'script.theme' | 'script.source' | 'script.characters' | 'script.skills'
  | 'extract.characters.shots' | 'extract.characters.existing'
  | 'extract.scenes.shots' | 'extract.scenes.existing'
  | 'extract.props.shots' | 'extract.props.existing'
  | 'director.shots' | 'director.skills'
  | 'image.task' | 'image.subject' | 'image.style' | 'image.skills'
  | 'video.heading' | 'video.continuity' | 'video.references' | 'video.action'
  | 'video.dialogue' | 'video.audio' | 'video.assets' | 'video.style' | 'video.skills';

export interface PromptBlockPlan {
  id: string;            // 稳定 id；用户新增用 uid()
  title: string;         // 用户可改
  text: string;          // 用户写的正文（数据块里是用户追加的说明）
  source?: DataSourceId; // 有值 = 数据块，渲染时拼上作品数据
  builtin?: string;      // 来源内置块 id（可追溯）
}

export interface PromptTemplatePlan { blocks: PromptBlockPlan[] }
```

`project.promptConfig` 升级到 v2（`src/domain/types.ts` 的 `PromptConfig` 改为 `v: 1 | 2`）：

```ts
promptConfig?: {
  v: 2;
  style?: StyleSpec;                                        // 保留：风格设定独立页
  templates?: Partial<Record<PromptKindId, PromptTemplatePlan>>;
};
```

### 5.2 渲染

`src/lib/prompts.ts` 的 7 个 spec（`scriptSpec` / `extractCharactersSpec` / `extractScenesSpec` / `extractPropsSpec` / `directorSpec` / `imageSpec` / `videoSpec`）全部改为**按用户块计划渲染**：

```
plan = project.promptConfig?.templates?.[kind]
blocks = plan?.blocks ?? defaultBlocksFor(kind)      // 无计划时用「默认数据块集合」
spec.blocks = blocks.map(b => ({
  id: b.id, label: b.title, locked: false,
  text: applyVariables([b.text.trim(), renderData(b.source, project)].filter(Boolean).join('\n'), vars)
}))
```

- **变量替换保留**：`{{project.theme}}`、`{{project.style}}`、`{{style.medium}}` 等 8 个变量继续可用，由 `applyVariables` 处理；未知变量在编辑器里标红并阻止保存（现状不变）。
- **数据块的引导语全部删除**：不再有"本段由作品数据生成，不得增删镜号。"这类系统文案。
- `renderPrompt` 保持"按顺序拼接非空文本"，空块自动跳过。

`src/lib/promptSpec.ts`：

- `requiredBlocks` **整体删除**（模块私有，无外部引用）。
- `validatePromptSpec` 只保留：块 id 非空且不重复、text 是字符串、渲染后长度不超 `PROMPT_LIMITS`、**整份提示词非空**。
- `applyPromptOverrides` **删除**（覆盖语义由块计划取代）。注意 `tests/prompt-spec.test.ts`、`tests/templates.test.ts` 有引用，需一并改写（见 §八）。
- `defaultBlockText` / `blockTextFor` / `forbiddenBlockText` 的**默认兜底逻辑删除**（`forbiddenBlockText(style, fallback)` 在 style 为空时会返回硬编码禁写清单，导致"默认文本非空"，必须删掉 fallback 分支）。

### 5.3 内置块目录（可插入，内容为空）

`src/lib/promptTemplates.ts`：

- 保留 39 个内置块的 **id + 标题 + 分组**（剧本 14、资产 9（人物/场景/道具各 3）、导演 8、图片 5、视频 3），**删除 `defaultText` 字段本身**、删除 `locked` 与 `reason`。
- 编辑器里点「插入内置块 ▾」→ 选一个 → 追加到当前模板末尾，**内容为空**。
- `defaultStyleSpec(style)` 改为返回空对象（水墨/日系/写实三套默认风格描述全部删除）。风格文本由用户在「风格设定」页自己写。

### 5.4 数据块清单（按 kind）

| kind | 可插入的数据块 |
|---|---|
| script | 主题与风格、原文、已有角色名、附加 Skill |
| extract-characters | 本类线索（说话人清单 + 逐镜）、已有本类固定资产 |
| extract-scenes | 本类线索（场景清单 + 逐镜）、已有本类固定资产 |
| extract-props | 本类线索（逐镜动作摘要）、已有本类固定资产 |
| director | 逐镜剧本、附加 Skill |
| image | 任务与风格、该资产固定短语、风格块、附加 Skill |
| video | 镜头开头、承接上一镜、附件顺序、动作与运镜、对白节奏、音频模式、固定资产块、风格块、附加 Skill |

（Skill 数据块必须覆盖全部 4 个用到 Skill 的 kind——现状 `prompts.ts` 里 image/video/director 都有 `*.skills` 块，漏掉会让 Skill 功能在这三步静默失效。）

数据块**默认带入**（用户不删就有），可见、可改标题、可追加说明、可删除、可调序。

### 5.5 后端契约最小化 + 可查看

`functions/handler.ts`：

**5.5.1 instruction 只留机器契约**

- 删除 `SCRIPT_INSTRUCTION`、`EXTRACT_RULES`、`EXTRACT_CHARACTERS_RULES`、`EXTRACT_SCENES_RULES`、`EXTRACT_PROPS_RULES`、`DIRECTOR_INSTRUCTION`、`ASSET_INSTRUCTION` 里的全部业务规则。
- 保留最小契约（Gemini `response_format` 与 DeepSeek `json_object` 模式都要求这句存在，且必须含 "json" 字样）：

  ```
  Return only a json object matching the schema below. Do not use markdown code fences.
  Schema: { ... }
  ```

**5.5.2 schema 描述中性化**

`SCREENPLAY_SCHEMA.properties.screenplay.description` 现在写着"四部分结构 + 【镜头：类型】 + △ + （时长Xs）"，会随 schema 一起发给模型——这是隐藏提示词，必须清掉。

- 所有 schema 的 `description` 一律删掉或精简为纯字段标签（如 `"剧本正文"`）。
- `properties` / `required` / `enum` / `minimum` / `maxItems` **不动**（取值域）。
- `DIRECTOR_SCHEMA.shotSize.description`（"or two or three of them joined by →"）同样删掉。

**5.5.3 新增只读 action `contracts`**

前端要向用户展示"模型还会收到什么"，就得能读到后端真实文本。后端是唯一真相源，所以加一个不消耗模型的只读接口：

- `POST /functions/v1/app?action=contracts`，body `{ for: 'screenplay' | 'extract-characters' | ... }`
- 返回 `{ instruction, schema }` —— 就是该 action 真正会用的两条文本。
- 与 `health` 一样**在取 key 之前返回**（不校验 key、不调上游、不计费）；`ACTION_FIELDS.contracts = ['for']`。
- 前端在模板编辑器打开时取一次并缓存，预览区以「接口固定契约（不可编辑）」折叠展示，可复制。

**5.5.4 删除死代码**

前端已无 `callApi('script')` 调用（只走 `screenplay` / `extract-*` / `director` / `image` / `video-create`），`script` action 及其独占符号可以删：

- 删：`script` action、`SCRIPT_SCHEMA`、`SCRIPT_INSTRUCTION`、`validateScript`、`ASSET_INSTRUCTION`、`ASSET_KINDS`、`ASSET_PROPERTIES`、`SHOT_ASSET_PROPERTIES`、`validateAssetLists`、`validateShotAssets`。
- **保留**：`ASSET_LIST_SCHEMA`、`ASSET_REFS_SCHEMA`（`EXTRACT_KIND_SCHEMA` 在用）。
- 影响：`tests/providers.test.ts` 里 14 处 `script` 用例需改写。

### 5.6 校验放松（前后端同时）

后端 `functions/handler.ts`：

- `validateScreenplay`：**只保留** JSON 可解析、`screenplay` 是非空字符串且 ≤60000 字。去掉 ≥200 字、必须含【镜头】、≥3 个时长、总时长 10–900 秒。
- `validateExtractCategory`：保留 name 非空唯一、description 为字符串、数量上限；`shots` 由"必须存在"改为"存在则校验，缺失则返回空数组"。
- `validateDirector`：**不动**。枚举是接口取值域（C2）。

前端：

- `src/features/script/creation.ts` `applyCategoryExtraction`（第 200 行）：
  - `data.shots.length !== project.shots.length` 的硬失败 → 改为**允许缺失**：缺失的镜头关联按空数组补齐，并在预览里提示「第 N 镜未返回关联」。
  - 「提取结果引用了未声明的${label}」（第 230 行）→ 改为**跳过并计数**，不整单拒绝；预览里提示跳过的条目。
  - 「逐镜关联格式无效」→ 同样降级为跳过 + 提示。
- `src/features/script/screenplay.ts` `parseScreenplay`：**容错拆镜**
  1. 有【镜头：类型】→ 按它拆（现状）。
  2. 没有 → 降级：按 `### 场景N` 场景头分组；**若一个场景头都没有，整篇当一个场景**（`scene` 留空），场景内每个自然段（`△ ` 开头的动作行，或「角色名（情绪）：“台词”」形式的台词行）作为一个镜头；没有时长则按字数估算（默认 3 秒/镜）。
  3. 拆不出任何内容 → 报错「剧本里没有找到可拆镜的内容，未覆盖现有剧本。」
- 降级发生时，剧本页明确提示：「未检测到【镜头：类型】标记，已按段落降级拆镜（N 镜）」。

### 5.7 空提示词守卫

各发送点（剧本 / 三类提取 / 导演 / 图片 / 视频）的确认弹窗：

- 渲染后的提示词为空 → 发送按钮禁用 + 提示「提示词不能为空：请在模板编辑器里添加内容」。
- 预览区显示的文本 **就是** 实际发送的文本（改写后按改写内容发送，行为不变）。

### 5.8 模板编辑器交互

- 页签：模板（剧本 / 资产 / 导演 / 图片 / 视频）+ 风格设定。
- 「资产」模板页保留**人物 / 场景 / 道具**三组分组，三组各自独立的一套块计划（对应三个 extract kind）。
- 工具条：`新增块`、`插入内置块 ▾`、`插入数据块 ▾`、`清空模板`（二次确认）。
- 块列表：标题（可改）+ 字数 + 数据源徽标 + 操作（删除 / 上移 / 下移）；正文 textarea。
- 数据块额外提供只读折叠预览（看数据长什么样），用户不能改数据本身，但可以在正文里追加说明。
- 预览区：最终发送文本 + 字数 + 上限 + 「接口固定契约」折叠展示（来自 `contracts` action）。
- 「恢复全部默认」按钮**删除**（已经没有默认了），替换为「清空模板」。

## 六、存档迁移

`promptConfig` v1 → v2：

- 旧 `blocks: Record<string,string>` 里每个键是内置块 id → 迁移成一个块 `{id: 旧键, title: 内置标题, text: 旧值, builtin: 旧键}`，按内置块自然顺序排列。
  旧值只可能是**用户自己改过的内容**（`buildConfig` 只在文本 ≠ 默认值时写入），迁移不会带回任何默认文案。
- 旧 `style` 原样保留。
- **不迁出空骨架**：`promptConfig` 在用户第一次保存模板之前保持 `undefined`。
  - 渲染层兜底：无计划时用「默认数据块集合」（只含数据块、无任何文案），所以老项目照样能生成。
  - 兼容 `tests/browser-prompt-edit.mjs:134` 的断言「手动改写不得写回提示词模板」→ `promptConfig === undefined`。
- `savedStudioSchema` 外层 `version` 保持 1；`promptConfig` 用 zod union 兼容 v1/v2，加载时在 `src/store/studio.ts` 做迁移。

## 七、影响面

| 文件 | 改动 |
|---|---|
| `src/lib/promptBlocks.ts` | **新增**：块计划类型、内置块目录、数据块清单与渲染、变量替换 |
| `src/lib/promptTemplates.ts` | 删 39 个内置块的 `defaultText` / `locked` / `reason`，保留 id+标题+分组；`defaultStyleSpec` 改空；删 `defaultBlockText` / `blockTextFor` / `forbiddenBlockText` 的默认兜底 |
| `src/lib/promptSpec.ts` | 删 `requiredBlocks`、`applyPromptOverrides`；`validatePromptSpec` 简化 |
| `src/lib/prompts.ts` | 7 个 spec 改为按块计划渲染；删固定措辞的系统块 |
| `src/domain/types.ts` | `PromptConfig` → `v: 1 | 2`，新增 `PromptBlockPlan` / `PromptTemplatePlan` |
| `src/store/schema.ts` | `promptConfig` v1/v2 union |
| `src/store/studio.ts` | 载入时迁移旧 `promptConfig` |
| `src/features/prompts/TemplateEditor.tsx` | 大改：增删块、插入器、空状态、契约展示、预览重做 |
| `src/features/script/screenplay.ts` | 容错拆镜（`parseScreenplay` 在这里，不在 `creation.ts`） |
| `src/features/script/creation.ts` | `applyCategoryExtraction` 放松逐镜关联校验 |
| `src/features/script/ScriptPage.tsx` | 空提示词守卫、降级提示 |
| `src/features/assets/AssetsPage.tsx` | 三类分别的空提示词守卫、缺失关联提示 |
| `src/features/director/DirectorPage.tsx` | 空提示词守卫 |
| `functions/handler.ts` | instruction 最小化、schema 描述中性化、新增 `contracts` action、校验放松、删 `script` 死代码 |

## 八、测试与验收

**需要重写的既有测试**（builder check 已定位）

- `tests/prompt-spec.test.ts`：13 段默认提示词的 SHA-256 基线全部作废；`applyPromptOverrides` 的 3 处用例改成块计划用例。
- `tests/templates.test.ts`：断言内置默认文本存在的用例（22–38、52–61、70–82、108–120 行）、`applyPromptOverrides` / `defaultBlockText` / `blockTextFor` 的引用（4、95 行）。
- `tests/providers.test.ts`：`script` action 的 14 处用例删除或改写；新增 `contracts` action 用例（无需 key、返回 instruction+schema）。
- `tests/creation.test.ts`：`applyCategoryExtraction` 的逐镜关联用例按新宽松语义改写。

**新增单元测试**

- 39 个内置块定义里不存在 `defaultText` / `locked` 字段；`defaultStyleSpec` 返回空对象。
- 渲染层：无计划时只输出数据块；计划存在时严格按计划顺序；空块被跳过；变量替换生效。
- `validatePromptSpec`：空提示词报"提示词为空"、超长报上限、无必填块概念。
- 迁移：v1 → v2 保留用户改过的块文本、没改过的内置块不出现、style 保留、迁移后 `promptConfig` 未保存时仍是 `undefined`。
- 容错拆镜：有【镜头】走原路径；无【镜头】且有场景头走降级路径；无场景头走单场景降级；完全不可拆时报错。
- 后端：`validateScreenplay` 不再因缺【镜头】/时长不足而 502；`validateExtractCategory` 缺 `shots` 不再 502。

**浏览器用例**（桌面 1440 + 手机 390）

- 模板编辑器：新增块 → 写入内容 → 预览随之变化 → 保存 → 下一次生成按新内容发送。
- 删除块 → 预览里该块消失 → 发送内容里也没有。
- 插入内置块 → 内容为空 → 用户填写。
- 空模板 → 生成按钮禁用 + 提示文案正确。
- 三类提取各自独立，块计划互不串。
- 剧本生成：无【镜头】的剧本文本 → 降级拆镜提示正确。
- 预览区能看到「接口固定契约」并可复制。

**回归**

`npm test`、`npm run build`、`deno check functions/index.ts`（本机 deno 在 npx 缓存里，需用绝对路径调用）、六条浏览器脚本（flow / recovery / models / media / assets / prompt-edit）全绿。

## 九、留给我判断的事项（用户可否决）

1. **内置块目录保留标题**：39 个内置块保留 id+标题（内容清空）作为「插入内置块」可选项，而不是彻底消失。理由：彻底消失后用户想找"禁写清单"这类常见段落无从下手。
2. **不迁出空骨架**：新项目与老项目都不预置任何块（连空的也没有）；编辑器空状态给明确引导，老项目靠「默认数据块集合」兜底。理由：保持 `promptConfig === undefined` 直到用户主动保存，避免凭空给用户塞结构。
3. **后端最小契约不交给用户编辑**：把"只输出符合 schema 的 JSON"保留在后端 instruction，但**通过 `contracts` action 在编辑器里原样展示**。理由：Gemini `response_format` 与 DeepSeek `json_object` 都要求这句存在，交给用户编辑容易让接口直接报错。
4. **schema 的 `description` 中性化**：删掉所有规则性描述，保留纯形状约束。理由：`description` 会随 schema 发给模型，留着就是隐藏提示词。
5. **删除死代码 `script` action**：前端已无入口，它的 90 秒硬编码与自由重构冲突，且留着等于留着另一套隐藏提示词。
6. **「返回结构」不算提示词**：模型必须返回的 JSON 形状由接口 schema 固定，用户改不了；用户能改的是提示词内容与规则。这是对"允许新结构"的解读：校验不再因**格式不符旧模板**而拒绝，而不是模型可以返回任意 JSON 形状。

## 十、分阶段计划

设计稿批准后写实施计划（`docs/superpowers/plans/`），分六步：

1. 块计划类型 + 内置块目录 + 存档迁移（v1→v2）+ `PromptConfig` 类型
2. 渲染层改造（7 个 spec 按计划渲染、必填块取消、变量替换保留、空提示词守卫）
3. 模板编辑器（增删块 / 插入器 / 空状态 / 预览）
4. 后端清理（instruction 最小化、schema 描述中性化、`contracts` action、校验放松、删死代码）
5. 容错拆镜 + 提取关联宽松化 + 降级提示
6. 测试重写与全量回归

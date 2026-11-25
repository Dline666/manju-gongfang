# 设定图提示词按品类拆分 · 设计稿

日期：2026-11-24
状态：已实现（代码与单测完成，浏览器回归通过）
关联需求：「现在资产图片的模板都耦合到一起了，不能单独配置提示词，我要分开人物，场景和道具的提示词模板，就在图片那栏里面分三个部分就行」
前序设计：`2026-11-24-prompt-template-page-design.md`（提示词模板整页化 + 全局/作品两级作用域）

---

## 1. 意图与背景

设定图（人物 / 场景 / 道具的「设定卡」）此前共用一份 `image` 提示词模板：

- 模板编辑器里「图片」栏只有一份模板，人物卡、场景卡、道具卡写的是同一段规则。
- 「人物要出三视图」和「道具不要出人物」这类互相冲突的约束只能塞进同一段话里互相打架。
- 资产提取那一步（`extract-characters` / `extract-scenes` / `extract-props`）早就按品类分开了，设定图这一步是唯一的例外。

用户要求：**在模板编辑器的「图片」栏里分成人物 / 场景 / 道具三个部分，各配各的提示词模板。**

设计原则沿用前序设计稿，不变：

- 系统不预置任何默认提示词文案；模板里只有用户自己写的块。
- 作品数据不属于模板，渲染时由系统固定附带。
- 全局模板为默认，单部作品可覆盖某一步。

---

## 2. 目标 / 非目标 / 反目标

### 目标

- G1 「图片」栏内部分成 **人物 / 场景 / 道具** 三段，一次只编辑一段、一次只预览一段。
- G2 三段彻底独立：各写各的块，内置块目录也按品类分开，互不串。
- G3 生图时按资产品类自动取对应那份模板（人物资产 → 人物模板，场景资产 → 场景模板，道具资产 → 道具模板）。
- G4 旧存档无损：原来那份共用的 `image` 模板在载入时自动拆成三份，行为不变。

### 非目标

- N1 设定图提示词的**变量体系**不扩展，沿用 `{{project.theme}}` / `{{style.medium}}` 等既有白名单。
- N2 不改生图 action 的后端契约（`functions/handler.ts` 一行不动）。
- N3 不做「继承 / 引用另一份模板」这类跨段引用机制。
- N4 不动视频模板（`video` 仍是一份）。

### 反目标（做了就算失败）

- A1 **不预置任何默认文案**。拆分只搬运用户自己写过的内容，系统不新增一句话。
- A2 **不静默丢块**。旧 `image` 里的每一个块，拆完后必须还在（且在它该在的段里）。
- A3 **不改生成行为之外的任何东西**。同一段模板内容拆到三段后，生成出来的提示词应与拆分前逐字一致。

---

## 3. 数据模型

### 3.1 kind 拆开

```ts
// src/domain/types.ts
export type PromptKindId =
  | 'script' | 'extract-characters' | 'extract-scenes' | 'extract-props' | 'director'
  | 'image-character' | 'image-scene' | 'image-prop'
  | 'video';
```

`PROMPT_KINDS` 从 7 项变 9 项。

### 3.2 旧 `image` 键继续被接受

```ts
export type PromptTemplateMap =
  Partial<Record<PromptKindId, PromptTemplatePlan>> & { image?: PromptTemplatePlan };
```

`image` 只作为**载入时的 legacy 键**存在：schema 接受它，`migrateTemplateSet()` 拆完就把它删掉。任何新建 / 保存的存档里都不再有 `image` 键。

`PromptConfigV1` / `PromptConfigV2` / `PromptConfigV3` 与 `PromptTemplateSet` 统一改用 `PromptTemplateMap`；`src/store/schema.ts` 抽出 `promptTemplateMap()` 共用同一份 zod 形状（legacy `image` + 三个新键）。

### 3.3 内置块按品类分开

图片内置块从 5 个变成 9 个，每类三个：

| 段 | 内置块 id | 标题 |
|---|---|---|
| 人物 | `image.character.three-view` | 人物三视图条款 |
| 人物 | `image.character.forbidden` | 人物禁写清单 |
| 人物 | `image.character.priority` | 人物优先级 |
| 场景 | `image.scene.composition` | 场景构图说明 |
| 场景 | `image.scene.forbidden` | 场景禁写清单 |
| 场景 | `image.scene.priority` | 场景优先级 |
| 道具 | `image.prop.composition` | 道具构图说明 |
| 道具 | `image.prop.forbidden` | 道具禁写清单 |
| 道具 | `image.prop.priority` | 道具优先级 |

内置块总数 39 → 43。

### 3.4 数据源：内容相同，归属分开

`DATA_SOURCES` 里的 `image` 拆成三个同源条目（`image.task` / `image.subject` / `image.style` / `image.skills`），三段注入的作品数据完全一致——差别只在**用户块那一段**。作品数据不归品类管。

---

## 4. 旧存档迁移

### 4.1 归类规则

旧结构里人物 / 场景 / 道具共用一份模板，拆成三份时按下面的规则落地：

| 旧块 | 去处 |
|---|---|
| `image.three-view` | 只进人物段（改名 `image.character.three-view`） |
| `image.scene-composition` | 只进场景段（改名 `image.scene.composition`） |
| `image.prop-composition` | 只进道具段（改名 `image.prop.composition`） |
| `image.forbidden` | 拆成三份：人物 / 场景 / 道具禁写清单 |
| `image.priority` | 拆成三份：人物 / 场景 / 道具优先级 |
| 用户自己新建的块 | **只进人物段**，并标成 `shared` |

最后一条是这轮返工的重点。原来「复制到三份」是为了保持旧行为一字不变，但那份旧行为本身就是用户要拆掉的东西：角色条款会被带进场景图和道具图的提示词，模型收到「只输出一张角色设定卡：正面、侧面、背面三视图」去画一张山门空镜，结果是三份模板依旧耦合。

改成只落人物段之后：

- 内容一个字没丢——它还在人物段里，编辑器给它挂一个「旧模板」标签。
- 场景段、道具段不再自动带上这段文字，符合「三类各写各的」。
- 用户如果发现这段规则对场景也适用，在场景段新建一条照抄即可。

代价是：旧模板里那些**本来就对三类通用**的规则（例如「不要出现任何文字」），迁移后只对人物生效。这是有意的取舍——把通用规则从一份共用模板里自动猜出来归类，只能靠猜；让用户在场景段自己补一条，比模型收到一段自相矛盾的提示词要好。编辑器里有一行说明把这个取舍讲清楚。

### 4.2 已经被拆过的存档

第一版拆分规则（复制到三份）上线后，有一批存档已经是三份结构、每份里躺着同 id 的副本。这些存档里没有 `image` 键，按 4.1 的规则不会再被迁移。

补救办法是识别副本特征：**同一个块 id 同时出现在三份里**。编辑器里新建的块 id 各不相同（`uid()`），内置块按品类各有各的 id，只有复制才会撞 id——所以同 id 必然是旧模板的副本。

`dropSharedImageCopies` 据此把场景、道具两份里的副本清掉，只留人物那份并标成 `shared`。这一步同样幂等，清完再跑不会二次误伤（人物那份不会被自己的规则当成副本删掉）。

### 4.3 实现

```ts
// src/lib/promptBlocks.ts
const IMAGE_BLOCK_ROUTES: Record<string, { kind: PromptKindId; id: string; title: string }[]> = { ... };
function dropSharedImageCopies(templates: Partial<Record<PromptKindId, PromptTemplatePlan>>): Partial<Record<PromptKindId, PromptTemplatePlan>>;
export function migrateTemplateSet(set: PromptTemplateSet | undefined): PromptTemplateSet | undefined;
```

- 触发条件：存在 `templates.image` 键 → 按 4.1 拆分；没有该键 → 直接走 4.2 的副本清理。两条路径**幂等**，再跑一次是空操作。
- `migratePromptConfig` 在 v3 分支里**无条件**调用 `migrateTemplateSet`（早期版本只在存在 `image` 键时才调，导致已被拆过的存档永远清不掉副本）。
- 走同一个函数的三条路径：
  1. 全局模板 `settings.promptTemplates`（`src/lib/endpoints.ts` 的 `migrateSettings`）；
  2. 作品覆盖层 `project.promptConfig.overrides.templates`（`migratePromptConfig` 在 v3 分支里处理）；
  3. v1 → v2 → v3 的老链路（`migrateV1ToV2` 直接按 `IMAGE_BLOCK_ROUTES` 落块；`migrateV2ToV3` 先保留 legacy `image` 再交给 `migrateTemplateSet`）。

---

## 5. 生成链路

```ts
// src/lib/prompts.ts
export function imageKindFor(asset: Asset): PromptKindId {
  if (asset.kind === 'scene') return 'image-scene';
  if (asset.kind === 'prop') return 'image-prop';
  return 'image-character';   // 人物与音色都落到人物这一档
}
export function imageSpec(project: Project, asset: Asset, global?: PromptTemplateSet): PromptSpec {
  return buildSpec(project, imageKindFor(asset), { asset }, global);
}
```

`PROMPT_LIMITS` 里 `image: 32000` 拆成 `image-character` / `image-scene` / `image-prop` 三个 32000——上限本来就一样（同一个生图 action），只是不再共用一个键。

---

## 6. 界面

### 6.1 图片栏分三段

「图片」栏内新增一个品类切换（与「资产」栏同一套机制）：

```
┌──────────────────────────────────────────────────────┐
│ 图片模板                                    人物、场景、道具的设定图各用各的提示词。 │
│  [ 人物 ] [ 场景 ] [ 道具 ]      ← 品类切换（role="tablist" aria-label="品类"）│
├──────────────────────────────────────────────────────┤
│  + 新增块   插入内置块…   插入   清空模板            │
│  ┌ 块 1 ─────────────────────────────┐               │
│  │ 标题 / 正文 / 上移 下移 删除       │               │
│  └───────────────────────────────────┘               │
│  实时预览 · 人物                  140 / 32000 字     │
│  （只预览当前品类这一段）                            │
└──────────────────────────────────────────────────────┘
```

- 段的 id / kind 映射：`character → image-character`、`scene → image-scene`、`prop → image-prop`。
- 切换品类只换 `kind`，块的归属各自独立，切回来还在。
- 内置块下拉只列当前品类的那三个。
- 来自旧模板的块挂一个「旧模板」标签；图片栏顶部有一行说明，讲清这段过去三类共用、现在只在人物那份。

### 6.2 预览按品类取资产

没有真实资产时按品类各给一个示例资产（`IMAGE_SAMPLES`），预览才不会是空的：

| 段 | 示例资产 | 预览里的主体 |
|---|---|---|
| 人物 | 示例人物 | `主体：示例人物` |
| 场景 | 示例场景 | `主体：示例场景` |
| 道具 | 示例道具 | `主体：示例道具` |

有真实资产时优先用真实资产里该品类的第一个。

### 6.3 路由与入口

- `readRoute()` 解析 `sub` 查询参数，模板页按 `tab` 记住各自的 `sub`（`{ assets: 'character', image: 'character' }`）。
- 地址形如 `#/settings/templates?kind=image&sub=scene&scope=project`。
- 资产页的「编辑模板」按钮带上当前品类：`?kind=image&sub=${kind}&scope=project`，点进去直接落在对应那一段。
- `TemplateEditorPage` 新增 `initialSub` prop。

---

## 7. 验收

### 单元（`tests/templates.test.ts` / `tests/creation.test.ts`）

- 图片内置块共 9 个、目录总数 43。
- 三份设定图模板各自独立，人物段的块不出现在场景 / 道具段。
- legacy `image` 拆分：内置块按品类归位、用户块只落人物那份并标 `shared`、拆完不再有 `image` 键、重复迁移幂等。
- 已被旧规则拆过的存档：三份里的同 id 副本被清掉，只留人物那份。
- 旧模板的用户块不会跑进场景与道具的**提示词**（不只是模板结构对）。

### 浏览器（Edge 1440 / 390，`tests/browser-image-templates.mjs`）

- 图片栏出现「人物 / 场景 / 道具」三段，一次只预览当前段。
- 人物段的内置块目录没有场景 / 道具的，反之亦然。
- 给人物段写块保存 → 切到场景段是空的；切回人物段块还在；刷新后仍在。
- 三段预览内容互不相同。
- 资产页「编辑模板」跳转带 `sub=scene` 并直接停在场景段。
- **真实生图链路**：场景资产的提示词里没有人物那段条款，道具同理。
- **旧存档**：一份共用的 `image` 模板载入后，场景与道具的提示词里同样没有人物条款。

### 命令

- `npm test`（219 条）、`npm run build`、`npx tsc --noEmit`、`deno check functions/index.ts` 全绿。
- 13 条浏览器回归脚本全绿。

---

## 8. 未验证

- 真实收费生图端到端未跑（未使用任何真实 Key）。
- 拆分后的提示词与拆分前逐字一致这条，只做了结构层面的核对，没有用真实模型比对输出。

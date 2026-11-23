# 资产分品类提取 · 设计稿

日期：2026-11-23
状态：待确认（未经批准不实现）

## 一、意图与背景

当前资产提取把人物、场景、道具三类塞进**同一个提示词、同一次模型调用**里完成。后端 `extract-assets` 是强制结构化输出（`functions/handler.ts:215` `ASSETS_SCHEMA`），要求三个数组齐全，模型每次都必须一次吐出三类；前端 `extractSpec()`（`src/lib/prompts.ts:101`）也只产出一段拼接提示词。

后果：

1. 三类的识别口径不同，却被迫共用一套规则文字（`extract.instruction`），谁都不够贴合。
2. 三类共用一份输入：逐镜 JSON 里既有说话人、又有场景头、又有动作摘要。人物靠 `dialogues[].speaker` 猜，场景靠 `scene` 字段猜，道具靠在动作摘要里捞名词——三种线索混在一起互相干扰。
3. 三类共用一份固定短语格式（`extract.phrase-style`），只能写成一套通用字段串。
4. 定义识别口径的 `extract.instruction` 在模板里是**锁定块**，用户改不了；而可改的 `phrase-style` / `forbidden` 只是描述格式。

目标：**三类分别识别，各自使用各自独立的提示词**，并让每类的识别规则、固定短语写法、禁写项都能在模板编辑器里单独编辑。

## 二、目标 / 非目标 / 反目标

**目标**

- G1 人物、场景、道具各自一次独立模型调用，各用一份独立提示词。
- G2 三类的**输入**也各自不同（各自的线索），不再共用同一段逐镜 JSON。
- G3 模板编辑器里三类规则分组呈现，各自可编辑。
- G4 资产页三个独立按钮，各自一条完整流程（确认 → 生成 → 预览 → 写入），互不干扰。
- G5 手动改写只影响本次请求，不回写模板（延续上一轮已实现的范式）。

**非目标**

- 不改生图提示词（`imagePrompt`）与视频提示词（`videoPrompt`）。
- 不改剧本、导演分镜两条链路。
- 不改后端其它 action 的契约与隐私/凭据/重试语义。
- 不引入新的依赖。

**反目标（做到就算失败）**

- 不允许"看起来分了三类、实际还是一次调用一次返回"。
- 不允许因为拆分而降低已有资产的保护强度：已有资产的固定短语仍必须逐字保留。
- 不允许出现"模型改了已有资产的描述却被静默丢弃"这种无反馈行为（现状如此，本次不修，但要在预览里说清楚）。

## 三、约束

- 后端 `handler.ts` 的 action 白名单与字段校验是硬约束；新增 action 必须走同一套 `ACTION_FIELDS` + `textActions` 校验路径，凭据只从 `provider/key/model/prompt` 取，多余字段一律 400。
- `PROMPT_LIMITS` 每个 kind 32000 字上限，与后端 `invalid_prompt` 校验一致。
- 模板里锁定块不可编辑；本次解锁的只有原本就未锁定的块。
- 旧存档 `promptConfig.blocks` 里可能残留 `extract.instruction` 等键——拆分后成为孤儿键。`applyPromptOverrides`（`src/lib/promptSpec.ts:68`）只按 spec 内的块 id 覆盖，孤儿键无害，不会报错，也不需要迁移。
- 工作区存在他人未提交的并行改动，本次改动必须逐处精确编辑。

## 四、方案（已与用户确认）

**交互形态：B —— 三个独立按钮，各自一条独立流程**
资产页三个按钮：「AI 提取人物」「AI 提取场景」「AI 提取道具」。点哪一个就只跑哪一类的完整流程：确认弹窗 → 生成 → 结果预览 → 写入资产库。跑完一类想跑另一类，再点对应按钮。

**模板组织：保留一个「资产」模板，内部按人物/场景/道具分三组块**

被否掉的方案：

- *A. 一次确认、三段提示词、三次调用、合并写入*：三段提示词能一次看全，但用户明确要求"分别识别、各自一条流程"。
- *C. A + 每类勾选框*：多一层 UI，且"勾掉某类时该类逐镜关联如何处理"要另定规则。

## 五、设计

### 5.1 提示词层

`src/lib/promptSpec.ts` 的 `PromptKind` 改为：

```
'script' | 'extract-characters' | 'extract-scenes' | 'extract-props' | 'image' | 'video' | 'director'
```

- 删除 `'extract'`（旧的合并 kind）与 `'assets'`（无 spec 构造器使用的遗留 kind）。
- `PROMPT_LIMITS` 三个新 kind 各 32000。
- `requiredBlocks`：三个新 kind 各只要求 `extract.<cat>.shots-input` 非空（系统生成、用户清不掉）。`instruction` 解锁后可能为空，不再作为必填块。

`src/lib/prompts.ts` 新增三个 spec 构造器，替换 `extractSpec`：

| 构造器 | kind | 块顺序 |
|---|---|---|
| `extractCharactersSpec(project)` | `extract-characters` | `extract.characters.instruction` → `extract.characters.phrase-style` → `extract.characters.forbidden` → `extract.characters.existing-assets` → `extract.characters.shots-input` |
| `extractScenesSpec(project)` | `extract-scenes` | 同上，`extract.scenes.*` |
| `extractPropsSpec(project)` | `extract-props` | 同上，`extract.props.*` |

前三个块走 `ruleBlock`（读模板，可被用户覆盖）；后两个块由系统生成（`existing-assets` 列同类别已有资产，`shots-input` 放本类专属线索）。

### 5.2 三类输入（各自不同）

这是本次改动的核心。`shots-input` 全部由系统生成，不可编辑。

**人物**——线索是"谁在说、谁在动"：

```
【说话人清单】
阿青、守门人

【逐镜】
第1镜｜场景：外景 · 山门 — 清晨
  画面：少年在雨夜山门拾起一把断剑
  台词：阿青：“我来拿回我的剑。”
```

说话人清单由 `project.shots[].dialogues[].speakerId → 资产名` 去重得到（与已有资产表交叉，名字以资产表为准）。

**场景**——线索是"这镜在哪"，并且要把散落的镜头**按空间归组**：

```
【场景清单】
场景1｜外景 · 山门 — 清晨｜出现于第1–5镜
场景2｜内景 · 山门石室 — 正午｜出现于第6–9镜

【逐镜】
第1镜｜所属空间：场景1
  画面：少年在雨夜山门拾起一把断剑
```

按 `shot.scene`（= 场景头原文）分组，组内镜号压成区间。场景头需要拆成内外景/地点/时间三段展示，因此从 `src/features/script/screenplay.ts` 导出已有的 `splitHead`（现为模块内私有函数），改名 `parseSceneHead` 后复用。

**道具**——线索是"这镜动了什么东西"，只给动作摘要：

```
【逐镜动作摘要】
第1镜：少年在雨夜山门拾起一把断剑
第2镜：守门人掌心里的钥匙旧得发黑，齿口磨平了一半
```

### 5.3 三类规则默认文本（模板默认值）

全部可在模板编辑器里改。以下为本次提案。

#### 人物

`extract.characters.instruction`：

```
【提取范围】只提取剧本里出现、且能被指认的人物。
【收录判断】
1. 有台词的角色一律收录；只有动作、没有台词的角色，只有当他是主角、主要对手或与主线直接相关时才收录。
2. 群演与背景路人（众人、行人、围观者等泛称）不单独建资产，除非剧本点名并且有台词。
3. 同一个人的不同称呼（阿青、少年、主角）必须合并成一项，name 取剧本里出现最多的那个称呼。
4. 只被提到名字、从未出场的人物不建资产。
5. 不建剧本里没有依据的人物。
【固定短语要求】
1. description 要能直接用于生图：性别、年龄、体型、发型发色、面部特征、服装款式颜色材质、随身标识。
2. 没有依据的外观细节不要编造；剧本没写的部分写「未明确」，但剧本给出的部分必须写全。
3. 不得写画风、渲染、光效、镜头术语、动作与情绪。
4. 同一个人物在所有镜头必须用同一段描述，逐字复用。
【逐镜关联】
每一镜都要给出 characters 数组，只列本镜真正出场的已声明人物；本镜无人出场给空数组。
```

`extract.characters.phrase-style`：

```
人物固定短语按这个顺序写，用「｜」分隔，不超过 90 字：
性别｜年龄｜体型｜发型与发色｜面部特征｜服装（款式·颜色·材质）｜随身标识
示例：女｜十六七岁｜瘦高｜黑色齐耳短发｜鹅蛋脸细长眉眼｜灰青色交领短衫·粗麻·袖口磨白｜腰系深褐布带
```

`extract.characters.forbidden`：

```
不写画风词、渲染质感、光效特效、镜头术语；不写动作、情绪与性格评价；不写「漂亮、帅气、俊美」等主观词；不编造剧本里没有的外观细节。
```

#### 场景

`extract.scenes.instruction`：

```
【提取范围】只提取剧本里出现、可以作为画面的空间。
【收录判断】
1. 以场景头「场景N 内外景 · 地点 — 时间」为准，每个独立空间建一项。
2. 同一地点在不同场次出现时：属于同一空间就合并，不同空间就分开建。
3. 特写、道具特写所属的空间必须收录，即使它没有独立场景头，按画面内容归入最接近的空间。
4. 只被台词提到、从未作为空间出现的名词不建场景资产。
5. 不建剧本里没有依据的空间。
【固定短语要求】
1. description 要能直接用于生图：空间结构、材质、主色、光线方向与时间、环境层次（前中后景）。
2. 没有依据的细节不要编造；剧本没写的部分写「未明确」。
3. 不得写画风、渲染、光效、镜头术语、人物动作与情绪。
4. 同一空间在所有镜头必须用同一段描述，逐字复用。
【逐镜关联】
每一镜都要给出 scenes 数组，只列本镜所在的已声明空间；纯黑场或无空间的过渡镜给空数组。
```

`extract.scenes.phrase-style`：

```
场景固定短语按这个顺序写，用「｜」分隔，不超过 90 字：
空间结构｜主色与材质｜光线方向与时间｜环境层次
示例：山门石阶与石门｜冷灰石质｜清晨侧逆光｜前景断剑、中景石阶、远景云海
```

`extract.scenes.forbidden`：

```
不写画风词、渲染质感、光效特效、镜头术语；不写人物动作、情绪与对白；不写「阴森、唯美」等主观氛围词；不编造剧本里没有的布景细节。
```

#### 道具

`extract.props.instruction`：

```
【提取范围】只提取剧本里实际出现、看得见或拿得在手里的物件。
【收录判断】
1. 只有在本镜动作里真实出现、并且推动剧情或需要保持外观一致的物件才建资产。
2. 同一物件的不同称呼（断剑、剑、那把断剑）必须合并成一项。
3. 场景陈设（墙上的画、桌上的碗）默认不建，除非剧本专门给它动作或特写。
4. 人物身上的衣着属于人物的固定短语，不要重复建道具。
5. 只被台词提到、从未出现的物件不建资产。
6. 不建剧本里没有依据的道具。
【固定短语要求】
1. description 要能直接用于生图：轮廓、材质、尺寸比例、颜色、关键细节与磨损痕迹。
2. 没有依据的细节不要编造。
3. 不得写画风、渲染、光效、镜头术语、人物动作与情绪。
4. 同一道具在所有镜头必须用同一段描述，逐字复用。
【逐镜关联】
每一镜都要给出 props 数组，只列本镜出现的已声明道具；本镜无道具给空数组。
```

`extract.props.phrase-style`：

```
道具固定短语按这个顺序写，用「｜」分隔，不超过 60 字：
轮廓｜材质｜比例｜颜色｜关键细节与磨损
示例：斜断口单手长剑｜黑铁｜长约三尺｜暗灰带锈｜剑柄缠褪色红绳、刃口有崩口
```

`extract.props.forbidden`：

```
不写画风词、渲染质感、光效特效、镜头术语；不写持有者、动作与情绪；不写「珍贵、古朴」等主观词；不编造剧本里没有的细节；不写商品营销式描述。
```

### 5.4 模板层

`src/lib/promptTemplates.ts`：

- `TemplateBlockDef` 增加可选 `group?: string`。
- 「资产」模板的 9 个块按 `group` 分成三组：

| group | 块 id | locked |
|---|---|---|
| 人物 | `extract.characters.instruction` | 否（**已确认解锁**） |
| 人物 | `extract.characters.phrase-style` | 否 |
| 人物 | `extract.characters.forbidden` | 否 |
| 场景 | `extract.scenes.instruction` | 否（**已确认解锁**） |
| 场景 | `extract.scenes.phrase-style` | 否 |
| 场景 | `extract.scenes.forbidden` | 否 |
| 道具 | `extract.props.instruction` | 否（**已确认解锁**） |
| 道具 | `extract.props.phrase-style` | 否 |
| 道具 | `extract.props.forbidden` | 否 |

> **已确认决策（2026-11-23）**：三个 `instruction` 块**解锁**，用户可直接改写识别口径。
>
> 风险评估：原先担心"模型不遵守只提取、不编造的底线"，实际上底线大部分由**后端结构化 Schema 强制**——
> 输出只能含本类清单（schema 固定 key）、必须逐镜一条关联（后端校验数量与镜号）、引用名字必须在清单内声明过（后端校验）。
> 唯一无法由后端保证的是"不编造外观细节"，这恰好是用户要自己掌控的部分。
> 因此解锁的实际风险可控；默认文本仍保留全部底线约束，用户不主动删就不会丢。
>
> 代价：若用户把识别规则清空，模型将失去判定依据。模板编辑器的 `requiredBlocks` 因此只要求系统生成、用户清不掉的 `shots-input`。

- 模板 id 仍是 `'assets'`，`TemplateId` 不变。

`src/features/prompts/TemplateEditor.tsx`：

- 资产模板的块按 `group` 分组渲染，组间加分组标题（人物 / 场景 / 道具）。
- 实时预览区改为三块（人物 / 场景 / 道具各一），各自显示字数与上限（各 32000），各自显示校验问题。
- 其它模板不分组，渲染行为不变。

### 5.5 后端契约

`functions/handler.ts`：

- 新增三个 action：`extract-characters`、`extract-scenes`、`extract-props`。
- `ACTION_FIELDS` 三项均为 `["provider", "key", "model", "prompt"]`。
- `textActions` 三项，各自 `code: "invalid_assets"`（沿用同一错误码，前端 `errorAction` 已有分支处理）。
- Schema 由同一工厂生成，只换 key：

```ts
const EXTRACT_KIND_SCHEMA = (key: "characters" | "scenes" | "props") => ({
  type: "object",
  properties: {
    [key]: ASSET_LIST_SCHEMA,
    shots: { type: "array", minItems: 1, maxItems: 100, items: {
      type: "object",
      properties: { number: { type: "integer", minimum: 1, maximum: 100 }, [key]: ASSET_REFS_SCHEMA },
      required: ["number", key],
    } },
  },
  required: [key, "shots"],
});
```

- 校验器 `validateExtractCategory(raw, key, code)`：只校验本类清单 + 本类逐镜关联；清单项 `name` 非空且 ≤100 字、`description` 非空且 ≤4000 字、类内不重名；`shots` 条数 1–100、`number` 唯一整数 1–100、逐镜引用的名字必须在本类清单里声明过且不重复。
- Instruction 每类一段英文，各自强调本类判定（例如人物类要求"合并同一人的不同称呼"、场景类要求"按空间归组、特写所属空间也要收录"、道具类要求"只收录真实出现且需要保持外观一致的物件"），并保留通用约束：只提取、不改写镜头对白、不编造、逐镜一条关联、沿用已有名称与固定短语。
- **删除** `extract-assets` 及其 `ASSETS_SCHEMA` / `ASSETS_INSTRUCTION` / `validateAssets`。
  - `ASSET_INSTRUCTION`（英文通用片段）被旧的 `script` action 引用，**保留**。
  - `ASSET_KINDS` / `ASSET_PROPERTIES` / `SHOT_ASSET_PROPERTIES` 被旧 `script` action 引用，**保留**。
  - `validateAssetLists` / `validateShotAssets` 被旧 `script` action 引用，**保留**。
- 旧 `script` action 保持不变（前端已不使用，但仍在白名单内，本次不动）。

### 5.6 前端流程

`src/features/script/creation.ts`：

- `applyBeatAssetExtraction` 替换为 `applyCategoryExtraction(project, input, kind: "character" | "scene" | "prop")`：
  - 只处理本类清单与本类逐镜关联；其余类别的资产与关联完全不碰。
  - 沿用现有合并语义：同名同类的已有资产，若其 `description`/`lock` 非空则**原样保留**（模型的描述被忽略）；若是空白占位则用模型描述补全。
  - 新资产 `lock = description`。
  - 逐镜关联并入 `shots[].assetIds`，与原有关联取并集。
  - 镜号必须与剧本镜头一一对应，数量不符即报错。

`src/features/assets/AssetsPage.tsx`：

- 工具区三个按钮：「AI 提取人物（先确认）」「AI 提取场景（先确认）」「AI 提取道具（先确认）」；无镜头时全部禁用。
- 状态仍用**一套** state，只是多一个 `kind` 字段——因为三类是三条独立流程（一次只跑一类，跑完写库再点下一个），不需要三套并行状态：

```ts
type ExtractKind = "character" | "scene" | "prop";
type Extraction = {
  kind: ExtractKind;
  revision: number;
  prompt: string;
  defaultPrompt: string;
  provider: "gemini" | "deepseek";
  model: string;
};
```

- `prepareExtraction(kind)`：按 kind 取对应 spec 的提示词，存进 `extraction`。
- 确认弹窗标题按类别变化（「确认 AI 提取人物 / 场景 / 道具」），提示词 textarea 可编辑 + 「恢复默认提示词」+ 空提示词禁用发送（延续上一轮已实现的范式）。
- `runExtraction()` 按 kind 调对应 action（`extract-characters` / `extract-scenes` / `extract-props`）。
- 结果预览只列本类资产，并按类别显示各自的合并提示（沿用/新增）。
- 「确认写入资产库」只写本类资产与本类逐镜关联，不影响另两类。
- 顶部不再有合并入口；`copyAllPrompts` 等现有批量功能不受影响。

### 5.7 兼容性

- 旧存档的 `promptConfig.blocks['extract.instruction'|'extract.phrase-style'|'extract.forbidden']` 变孤儿键，**不迁移、不报错、不生效**。用户如需沿用旧规则，需在新块里重填。
  - 这是一次可见的行为回退：之前改过「资产」模板规则的用户，拆模板后需要重新配一次。会在实施时于「资产」模板页加一行提示告知。
- 已有资产的固定短语保护强度不变。
- 后端 action 名单变化：只有本应用前端调用后端，不存在第三方依赖；`extract-assets` 直接删除。

### 5.8 改动文件清单

| 文件 | 改动 |
|---|---|
| `functions/handler.ts` | 新增三个 action / schema / instruction / validator；删 `extract-assets` 相关 |
| `src/lib/promptSpec.ts` | `PromptKind`、`PROMPT_LIMITS`、`requiredBlocks` 调整 |
| `src/lib/prompts.ts` | `extractSpec` → 三个新 spec 构造器 + 三类专属输入；并承接 `parseSceneHead`（`lib` 不反向依赖 `features`） |
| `src/lib/promptTemplates.ts` | 「资产」模板 9 块 + `group` 字段 |
| `src/features/prompts/TemplateEditor.tsx` | 分组渲染 + 三块预览 |
| `src/features/script/creation.ts` | `applyBeatAssetExtraction` → `applyCategoryExtraction` |
| `src/features/script/screenplay.ts` | 改用 `lib/prompts` 的 `parseSceneHead`，不再自带一份 |
| `src/features/assets/AssetsPage.tsx` | 三个按钮 + 按类别分流的流程 |
| `tests/providers.test.ts` | `extract-assets` 相关用例改为三个新 action |
| `tests/prompt-spec.test.ts` | extract spec / kind 相关断言更新 |
| `tests/templates.test.ts` | 资产模板块断言更新 |
| `tests/browser-assets.mjs` | 提取流程改为按类别 |
| `tests/browser-prompt-edit.mjs` | 提取提示词断言改为按类别 |

### 5.9 测试计划

- 单元：三个新 kind 的 spec 结构、长度上限、必填块；模板九块的可编辑/锁定状态；`applyCategoryExtraction` 的沿用/补全/新建/关联/报错路径。
- 后端契约：三个 action 各自的 schema 形状、必填字段、错误码、单次尝试不重试、凭据与隐私设置与旧 action 一致；只允许 provider/key/model/prompt。
- 浏览器：三个按钮各自跑通"编辑提示词 → 恢复默认 → 发送改写内容 → 预览 → 写入"，桌面 1440 与手机 390 两档。
- 回归：`npm test` / `npm run build` / `deno check functions/index.ts` 全绿；既有 browser-flow / browser-assets / browser-models / browser-recovery / browser-media 不回归。

## 六、风险

| 风险 | 处置 |
|---|---|
| 拆成三次调用后总费用上升 | 每次请求体更小（只带本类线索），单价不涨，涨的是次数；用户可按需只跑缺的那一类 |
| 三类分开跑导致风格漂移 | 三类的 `phrase-style` 都在同一个「资产」模板里、可以互相参照；固定短语本身要求"逐字复用"，跨类一致性靠人物/场景/道具各自的写法约束 |
| 旧模板规则失效 | 见 5.7，模板页给一次性提示 |
| 模型返回本类之外的资产 | 后端校验只读取本类 key，模型多返回的其它品类字段被丢弃，不会污染本类结果 |

## 七、我的判断（实现时的默认选择）

- 三类各一次调用，**不合并**，也不做"只跑勾选的那几类"——用户已明确要三条独立流程。
- 三个 `instruction` **解锁**（用户已确认），识别口径由用户掌控；默认文本仍保留全部底线约束。
- 固定短语仍用「｜」字段串格式，但按类定制字段（人物 7 段、场景 4 段、道具 5 段）。
- 不迁移旧模板键。

## 八、开放问题（已全部关闭）

1. **三类的 `instruction` 解锁** —— 用户已确认，由用户直接改识别口径。
2. **旧模板规则失效的提示方式** —— 只在模板页加一行文字说明，不自动迁移旧键到新块（避免把旧的合并规则误塞进人物块）。
3. **是否保留合并入口** —— 完全移除「AI 提取三类资产」，只留三个独立按钮。

## 九、批准后要做的事

1. 后端三个 action（schema / instruction / validator / 白名单）＋ 契约测试。
2. 前端提示词层（三 kind + 三类输入）＋ 模板九块 ＋ 模板编辑器分组。
3. `applyCategoryExtraction` ＋ 资产页三个按钮与分流流程。
4. 测试更新与全量回归。

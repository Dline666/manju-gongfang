# 实施计划：提示词完全透明化重构

日期：2026-11-23
设计稿：`docs/superpowers/specs/2026-11-23-prompt-rework-design.md`（已批准，第 2 版）

## 总体顺序

六个阶段，每阶段独立可跑通；阶段之间有依赖（1→2→3、4、5）。每阶段结束跑 `npm test` + `npm run build`，第 4 阶段后加跑 `deno check functions/index.ts`，第 6 阶段跑全量浏览器脚本。

**贯穿全程的红线**：任何时刻模型收到的提示词文本，都必须能在模板编辑器预览区看到。改一处发送路径，就要在预览区验证一次。

---

## 阶段 1 · 块计划类型、内置块目录、存档迁移

**1.1 `src/domain/types.ts`**

- `PromptConfig` 改为 `v: 1 | 2`；v2 形态：`{ v: 2; style?: StyleSpec; templates?: Partial<Record<PromptKindId, PromptTemplatePlan>> }`。
- 新增 `PromptBlockPlan { id; title; text; source?; builtin? }`、`PromptTemplatePlan { blocks: PromptBlockPlan[] }`。
- `PromptKindId` 定义在 `src/lib/promptBlocks.ts`，types.ts 里 `import type` 引用（避免循环依赖：promptBlocks → domain/types，domain/types → promptBlocks 的 type-only 引用，无运行时环）。

**1.2 `src/lib/promptBlocks.ts`（新增）**

- `PromptKindId`：7 个（script / extract-characters / extract-scenes / extract-props / director / image / video）。
- `DataSourceId`：25 个（见设计稿 §5.1）。
- `builtinBlocks`：39 条 `{ id, title, group? }`——从现有 `templates[]` 搬 id 与 label，**不带内容**。
- `dataBlocksFor(kind)`：每个 kind 的数据块顺序（设计稿 §5.4）。
- `defaultBlocksFor(kind)`：`dataBlocksFor(kind)` 映射成 `PromptBlockPlan`（id 用 `data.<source>`）。
- `renderData(source, project, ctx)`：把作品数据渲染成块文本。ctx 携带当前 asset / shot（image、video 需要）。
- `planFor(project, kind)`：`project.promptConfig?.templates?.[kind]` ?? `defaultBlocksFor(kind)`。

**1.3 `src/lib/promptTemplates.ts`**

- 39 个内置块定义改为 `{ id, label, group? }`，删 `defaultText` / `locked` / `reason`。
- `defaultStyleSpec(style)` → 返回 `{}`。
- 删 `defaultBlockText` / `blockTextFor` / `forbiddenBlockText`（含 fallback 分支）。`promptVariables` / `applyVariables` / `findUnknownVariables` / `allowedVariables` 保留。
- `templates` 数组保留（编辑器用它列「插入内置块」菜单）。

**1.4 `src/store/schema.ts` + `src/store/studio.ts`**

- schema：`promptConfig` 用 zod union 兼容 v1/v2。
- studio 载入时：v1 → v2 迁移（旧 `blocks` 记录 → `templates` 里对应 kind 的块计划；旧 `style` 保留；`v` 改 2）。
- 迁移函数放 `src/store/studio.ts` 或 `src/lib/promptBlocks.ts`（选后者，studio 调用）。

**1.5 验收**

- `npm test` 通过（旧测试此刻会红——允许，阶段 6 统一重写；但**不得新增**与新设计相悖的断言）。
- `npm run build` 通过。

---

## 阶段 2 · 渲染层改造

**2.1 `src/lib/promptSpec.ts`**

- 删 `requiredBlocks`、`applyPromptOverrides`。
- `validatePromptSpec`：只查块 id 非空/不重复、text 是字符串、渲染长度 ≤ `PROMPT_LIMITS`、整份提示词非空（空则报「提示词为空」）。

**2.2 `src/lib/prompts.ts`**

- 7 个 spec 改为按 `planFor(project, kind)` 渲染：块 id/title/text 来自计划；数据块拼 `renderData`；套 `applyVariables`；`locked` 一律 false。
- 删所有固定措辞的系统块（"本段由作品数据生成…"、"未关联固定资产，请保持本镜文字设定。"等）。
- 保留 `fixedDescription` / `assetSpecs` / `assetText` / `fullAssetText` / `parseSceneHead` 等既有导出（被别处引用）。

**2.3 空提示词守卫**

- `ScriptPage` / `AssetsPage`（三类）/ `DirectorPage`：确认弹窗打开时若提示词为空 → 发送按钮禁用 + 「提示词不能为空：请在模板编辑器里添加内容」。
- 图片 / 视频生成路径（`GenerationPage`）同样检查。

**2.4 验收**

- `npm run build` 通过；单元测试按阶段 6 重写。

---

## 阶段 3 · 模板编辑器

**3.1 `src/features/prompts/TemplateEditor.tsx`（大改）**

- 块列表：每块标题（可改）+ 字数 + 数据源徽标 + 删除 / 上移 / 下移；正文 textarea；数据块附只读折叠预览。
- 工具条：`新增块`、`插入内置块 ▾`（39 项，来自 `templates[]`）、`插入数据块 ▾`（按 kind）、`清空模板`（二次确认）。
- 「恢复全部默认」→ 改「清空模板」。
- 「资产」模板页保留人物 / 场景 / 道具三组；每组一套独立块计划（对应 3 个 extract kind）。
- 预览区：最终发送文本 + 字数 + 上限；新增「接口固定契约」折叠区（阶段 4 的 `contracts` action 提供数据，先留占位）。
- 保存：`promptConfig.templates[kind] = { blocks }`；`v: 2`。

**3.2 验收**

- 浏览器手动验证：新增块 → 预览变化；删除块 → 预览消失；插入内置块 → 空内容。
- `npm run build` 通过。

---

## 阶段 4 · 后端清理

**4.1 `functions/handler.ts`**

- instruction 最小化：`SCREENPLAY_INSTRUCTION` / `EXTRACT_*_INSTRUCTION` / `DIRECTOR_INSTRUCTION` 只留 `Return only a json object matching the schema below. Do not use markdown code fences. Schema: {...}`。
- 删 `EXTRACT_RULES` / `EXTRACT_CHARACTERS_RULES` / `EXTRACT_SCENES_RULES` / `EXTRACT_PROPS_RULES` / `ASSET_INSTRUCTION` / `SCRIPT_INSTRUCTION`。
- schema 描述中性化：删 `SCREENPLAY_SCHEMA.properties.screenplay.description` 与 `DIRECTOR_SCHEMA...shotSize.description`；`properties/required/enum/min/max` 不动。
- 删死代码：`script` action、`SCRIPT_SCHEMA`、`validateScript`、`ASSET_KINDS`、`ASSET_PROPERTIES`、`SHOT_ASSET_PROPERTIES`、`validateAssetLists`、`validateShotAssets`。**保留 `ASSET_LIST_SCHEMA` / `ASSET_REFS_SCHEMA`**。
- 新增 `contracts` action：`POST ?action=contracts`，body `{ for }`，返回 `{ instruction, schema }`；在取 key 之前返回（与 `health` 同层），`ACTION_FIELDS.contracts = ['for']`。
- 校验放松：`validateScreenplay` 只保留「JSON 可解析 + screenplay 非空字符串 + ≤60000」；`validateExtractCategory` 的 `shots` 改为可选。

**4.2 前端接 `contracts`**

- `src/lib/api.ts` 或 `src/lib/promptBlocks.ts` 提供 `fetchContract(kind)`；模板编辑器打开时取一次并缓存。
- 预览区展示 instruction + schema（可复制），标注「接口固定（不可编辑）」。

**4.3 验收**

- `deno check functions/index.ts` exit 0。
- `curl` 直打 `?action=contracts` 返回 instruction + schema。
- `curl` 直打三个 extract action：路由通过、走到上游（伪 key → 422）。

---

## 阶段 5 · 容错拆镜与提取宽松化

**5.1 `src/features/script/screenplay.ts`**

- `parseScreenplay`：有【镜头：类型】→ 原路径；无 → 降级（按 `### 场景N` 分组；无场景头则整篇当一个场景；场景内按 `△ ` 动作行与「角色名（情绪）：“台词”」台词行切镜；无时长按字数估算，默认 3 秒/镜）。
- `ensureBlock` 等辅助函数同步调整。
- 拆不出内容 → 抛「剧本里没有找到可拆镜的内容，未覆盖现有剧本。」

**5.2 `src/features/script/creation.ts`**

- `applyCategoryExtraction`：
  - `shots` 长度不等 → 允许缺失（补空数组 + 计数）。
  - 引用未声明名字 → 跳过 + 计数。
  - 关联格式无效 → 跳过 + 计数。
  - 返回值带上告警信息，供预览提示。

**5.3 UI 提示**

- 剧本页：降级拆镜时提示「未检测到【镜头：类型】标记，已按段落降级拆镜（N 镜）」。
- 资产页：提取预览里提示「第 N 镜未返回关联」「跳过 M 条未声明引用」。

**5.4 验收**

- 新增单测覆盖三条拆镜路径与三种提取宽松情形。

---

## 阶段 6 · 测试重写与全量回归

**6.1 单元测试**

- `tests/prompt-spec.test.ts`：删 SHA-256 基线；改写 `applyPromptOverrides` 用例为块计划用例；新增「无计划只输出数据块」「计划按顺序渲染」「变量替换生效」「空提示词报空」。
- `tests/templates.test.ts`：内置块无 `defaultText` / `locked`；`defaultStyleSpec` 返回空；删除依赖旧 API 的用例。
- `tests/providers.test.ts`：删 `script` action 用例；新增 `contracts` 用例（无需 key）。
- `tests/creation.test.ts`：`applyCategoryExtraction` 按新宽松语义改写 + 新增三例。
- `tests/api.test.ts`：不受影响（上一轮新增）。
- 新增 `tests/prompt-blocks.test.ts`：内置块目录完整（39 条、无 defaultText）、数据块清单、v1→v2 迁移。

**6.2 浏览器脚本**

- `tests/browser-prompt-edit.mjs`：改为「模板编辑器增删块 → 保存 → 生成按新内容发送 → 删除块后不再发送」。
- `tests/browser-assets.mjs`：三类提取块计划互不串。
- 其余四条不动。

**6.3 全量回归**

```
npm test
npm run build
deno check functions/index.ts     # 用本机 npx 缓存里的 deno 绝对路径
node tests/browser-flow.mjs
node tests/browser-recovery.mjs
node tests/browser-models.mjs
node tests/browser-media.mjs
node tests/browser-assets.mjs
node tests/browser-prompt-edit.mjs
```

**6.4 手工验收（桌面 1440 + 手机 390）**

- 模板编辑器：新增/删除/插入内置块/插入数据块/改标题/调序，全部生效。
- 预览区能看到「接口固定契约」。
- 空模板 → 生成按钮禁用 + 提示正确。
- 三类提取各自独立。
- 剧本生成无【镜头】→ 降级提示正确。

---

## 风险与回退

- 阶段 1 的存档迁移不可逆（v1 存档被改成 v2）。迁移只读旧字段、不删数据，出错可回退代码。
- 阶段 4 删 `script` action 是接口破坏性变更（前端已无调用方）。若外部有人用，回退该 hunk 即可。
- 阶段 2 会让「没有模板的老项目」只剩数据块——符合设计预期，但需要阶段 5 的容错拆镜兜底，阶段 2 与阶段 5 之间存在短暂窗口：此时剧本生成可能失败。**因此阶段 2 与阶段 5 必须在同一次提交里完成**，或阶段 5 先于阶段 2。

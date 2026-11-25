# 提示词模板整页编辑器 · 设计稿

日期：2026-11-24
状态：待实现（用户已拍板：方案 A + 全局为默认 / 可按作品覆盖）
关联需求：「模板提示词编辑器的放置位置」——用户对现状（左侧抽屉）不满意，选定**设置页加「提示词模板」页签 + 整页编辑器**；模板作用域选**全局为默认 + 可按作品覆盖**。

---

## 1. 意图与背景

现状：

- 模板编辑器是 `src/features/prompts/TemplateEditor.tsx`，用 `Sheet side="left"` 从左边滑出，四个流程页（剧本 / 资产 / 分镜 / 生成）各自弹一次。
- 抽屉最长 6xl 但左侧落点固定，内容被压缩成窄栏 + 长滚动；用户明确表示不满意。
- 模板存在**作品级** `project.promptConfig`，每部作品各存一份；作品之间无法复用，改一次要改 N 次。
- 模板是「写给模型看的规则」，本质是**用户配置**而不是作品内容——和自定义视觉风格（`settings.styles`）性质相同。

已确认的两个决策（用户拍板）：

1. **放置位置 = 方案 A**：设置页加「提示词模板」页签，整页编辑；流程页只留一个跳转入口。
2. **作用域 = 全局为默认 + 可按作品覆盖**。

---

## 2. 目标 / 非目标 / 反目标

### 目标

- G1 模板编辑器成为设置页的一个页签，整页布局（左侧类别导航 + 右侧编辑区），不再是抽屉。
- G2 **全局模板为默认**：所有作品默认跟随全局模板，改一次全局，全部作品生效。
- G3 **单部作品可覆盖**：作品可以只覆盖其中某一步（如只改剧本），其余步骤仍跟随全局。
- G4 旧存档无损：已有作品里的模板原样保留，不丢一个字，也不突然变成全局。
- G5 流程页保留入口：点「编辑提示词模板」直接跳到设置页的模板页签，并定位到对应步骤。

### 非目标（本轮不做）

- N1 模板版本历史、回滚、导入导出。
- N2 模板变量扩展（沿用现有 `{{project.theme}}` / `{{style.medium}}` 等白名单）。
- N3 作品之间的模板「继承链」（只有全局 → 作品两级）。
- N4 后端契约改动：本轮 `functions/handler.ts` 一行不动。

### 反目标（做了就算失败）

- A1 **不在模板里重新引入数据块**。作品数据继续由系统在渲染时固定附带（`buildSpec` 的 locked 注入段）。
- A2 **全局模板不进作品存档**。作品只存「覆盖层」，不复制全局全文；否则改全局后旧作品会被冻结。
- A3 **覆盖语义必须显式**。「作品这一步是空的」和「作品这一步跟随全局」是两件事，不能靠「空 = 跟随」这种隐式约定糊过去。
- A4 迁移不得丢内容：旧模板里用户写过的补充说明（`legacy.` 前缀块）继续保留。

---

## 3. 数据模型

### 3.1 全局模板（存在 settings）

```ts
// src/domain/types.ts
export interface PromptTemplateSet {
  style?: StyleSpec;
  templates?: Partial<Record<PromptKindId, PromptTemplatePlan>>;
}

export interface Settings {
  // …
  /** 全局默认提示词模板：所有作品跟随，被作品覆盖的部分除外。 */
  promptTemplates?: PromptTemplateSet;
}
```

全局模板**不存在作品存档里**，只在本机 settings 里。

### 3.2 作品覆盖层（存在 project）

```ts
export interface PromptConfig {
  v: 1 | 2 | 3;
  style?: StyleSpec;                    // v2 旧结构
  blocks?: Record<string, string>;      // v1 旧结构
  templates?: Partial<Record<PromptKindId, PromptTemplatePlan>>; // v2 旧结构
  /** v3：本作品的覆盖层。**没有的键 = 跟随全局**。 */
  overrides?: {
    style?: StyleSpec;
    templates?: Partial<Record<PromptKindId, PromptTemplatePlan>>;
  };
}
```

`overrides` 里**键存在 = 这一步归作品管**（块可以为空，表示「这一步我不写任何块」）；**键不存在 = 跟随全局**。这样显式表达了 A3。

### 3.3 解析规则（唯一真理来源）

```ts
// src/lib/promptScope.ts（新增）
export function effectivePlan(project: Project, kind: PromptKindId, global?: PromptTemplateSet): PromptBlockPlan[]
export function effectiveStyle(project: Project, global?: PromptTemplateSet): StyleSpec
export function effectiveTemplateSet(project: Project, global?: PromptTemplateSet): PromptTemplateSet
```

规则：

| 情况 | 生效的模板 |
| --- | --- |
| `project.promptConfig.overrides.templates[kind]` 存在 | 作品自己的（块可以为空） |
| 否则 `global.templates[kind]` 存在 | 全局的 |
| 都没有 | 空（该步骤没有任何用户块，只有系统注入的作品数据） |

风格同理：`overrides.style` 存在 → 用它；否则 `global.style`；否则 `defaultStyleSpec(project.style)`（空）。

### 3.4 旧存档迁移（v1 → v2 → v3）

`migratePromptConfig` 现有逻辑先把 v1 迁成 v2（`blocks` → `templates`）。本轮再加一步 v2 → v3：

- `overrides.templates[kind]` = v2 里**块非空**的 kind；块为空的 kind **不**进覆盖层（让它跟随全局）。
- `overrides.style` = v2 的 style（非空才建）。
- v2 里用户写在数据块里的补充说明（`legacy.` 前缀）保留成普通块，跟着它所属的 kind 一起进覆盖层。

旧作品因此变成「写过的步骤独立，其余跟随全局」——内容一个字没丢，改全局也不会打乱它。

---

## 4. 提示词构造：全局怎么传到生成链路

`buildSpec(project, kind, ctx)` 是所有提示词的唯一出口，但它只拿得到 `project`。全局模板在 settings 里，所以要显式传进去。

`src/lib/prompts.ts` 的 spec / prompt 函数统一加一个**可选尾参** `global?: PromptTemplateSet`：

```ts
export function scriptSpec(project: Project, global?: PromptTemplateSet): PromptSpec
export function scriptPrompt(project: Project, global?: PromptTemplateSet): string
// extract-* / director / image / video 同理
```

`styleSpecFor(project, global?)` 同样加尾参。

**所有组件调用点必须传 `settings.promptTemplates`**（组件里都有 `useStudio().settings`）。这是本轮最容易漏的地方，验收里用「全局模板必须出现在剧本/提取/导演/生图/视频五条链路的提示词里」来兜底。

---

## 5. 界面

### 5.1 设置页变成两个页签

- `#/settings` → 「连接模型」（现有内容，一行不改）
- `#/settings/templates` → 「提示词模板」（新增）

路由是 hash 制的，`readStage()` 需要能解析 `settings/templates`。流程页跳转用 query 定位：`#/settings/templates?kind=script&scope=project`。

### 5.2 模板页布局

```
┌────────────────────────────────────────────────────────────┐
│ 提示词模板                                                 │
│ [ 全局模板（默认） ] [ 当前作品 · 断剑归门 ]                │  ← 作用域切换
├──────────────┬─────────────────────────────────────────────┤
│ 剧本          │  【剧本模板】                    跟随全局   │  ← 状态徽标
│ 资产          │  ┌ 块 1 ────────────────────────────┐       │
│ 导演          │  │ 标题 / 正文 / 上移 下移 删除     │       │
│ 图片          │  └─────────────────────────────────┘       │
│ 视频          │  + 新增块  插入内置块…  清空模板             │
│ 风格设定      │                                              │
│              │  实时预览（只预览当前类别）                   │
│              │  接口固定契约（后端持有，原样展示）           │
└──────────────┴─────────────────────────────────────────────┘
```

- 作用域切换用现成的 `tabs-row` 样式。
- **全局作用域**：直接编辑全局模板；页面顶部说明「全局模板是所有作品的默认，改动立刻影响所有跟随全局的作品」。
- **作品作用域**：每个 kind 顶部有状态徽标 + 两个动作：
  - 「跟随全局」→ 块列表只读（显示全局内容，置灰），提供「改为独立编辑」。
  - 「本作品独立」→ 块列表可编辑，提供「恢复跟随全局」。
- 作品作用域底部提供「把本作品的模板复制为全局默认」，方便把老作品里的模板一次性提到全局。

### 5.3 流程页入口

四个流程页的「编辑提示词模板 / 编辑模板」按钮改成跳转：

- 剧本页 → `#/settings/templates?kind=script&scope=project`
- 资产页 → `?kind=image&scope=project`（资产页的模板入口是图片模板）
- 分镜页 → `?kind=assets&scope=project`
- 生成页 → `?kind=video&scope=project`

抽屉组件 `TemplateEditor.tsx`（Sheet）**删除**，编辑器主体搬进 `src/features/prompts/TemplateEditorPage.tsx`。

### 5.4 样式

复用现有的 `.template-editor` / `.template-tabs` / `.template-body` / `.sticky-actions`（`src/globals.css:89-98`），整页布局下把 `.template-tabs` 改成 `sticky top` 的左侧栏即可，桌面 1440 与手机 390 都要能用。

---

## 6. 验收

### 单元 / 契约

- `migratePromptConfig`：v1 → v3、v2 → v3、空块 kind 不进覆盖层、`legacy.` 块保留。
- `effectivePlan` / `effectiveStyle`：作品覆盖优先、其次全局、再次空；显式空覆盖与跟随全局可区分。
- `buildSpec`：全局模板的块进最终提示词，且排在系统注入的作品数据之前。

### 浏览器（Edge 1440 / 390）

- 设置页出现「提示词模板」页签；整页编辑器可用（左侧类别导航 + 右侧编辑区）。
- 全局模板写完后，**剧本 / 资产提取 / 导演 / 生图 / 视频**五条链路的提示词里都能看到它。
- 某作品覆盖剧本步骤后：剧本用作品的、其它步骤用全局的；「恢复跟随全局」后剧本也回到全局。
- 刷新页面后全局模板与作品覆盖都还在。
- 旧存档（v2）载入后内容不丢。

### 命令

- `npm test`、`npm run build`、`npx tsc --noEmit`、`deno check functions/index.ts` 全绿。
- 既有 11 条浏览器回归脚本全绿。

---

## 7. 未验证

- 真实收费 API 端到端未跑。
- 模板编辑器整页化后的实际排版细节，需要用户在 1440 / 390 两个视口实操确认。

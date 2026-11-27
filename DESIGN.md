---
name: 漫剧工坊 MANJU STUDIO
description: 本地优先的漫剧制作工作台——聊天室写小说、生剧本、生分镜 JSON，导入后按集生成视频
colors:
  canvas: "#101113"
  surface: "#1c1d20"
  surface-raised: "#17181b"
  rail: "#151618"
  topbar: "#121315"
  border: "#2b2d31"
  border-strong: "#35363b"
  text: "#ededf0"
  text-secondary: "#bbbdc4"
  text-muted: "#97999f"
  text-faint: "#737983"
  accent: "#22cbb8"
  accent-on: "#072d29"
  accent-tint: "#22cbb812"
  accent-line: "#286058"
  gold: "#d4af6a"
  gold-ink: "#c8b07a"
  gold-line: "#5c4c2f"
  danger: "#dc5461"
  danger-ink: "#e88b93"
  danger-line: "#7c3a41"
  warning: "#d8b26a"
  warning-line: "#6b5430"
  ready: "#4ea68b"
  stage: "#090a0b"
  pure-black: "#000000"
  ink-strong: "#dfe2e7"
  ink-body: "#c3c6cc"
  ink-soft: "#a8abb3"
  ink-dim: "#9aa0a8"
  ink-faint: "#8b9098"
  line-soft: "#35393e"
  line-dim: "#3a3d43"
  line-quiet: "#3b3f44"
  line-under: "#3a3e43"
  state-ready-bg: "#1d3b34"
  state-ready-ink: "#8fd9c8"
  state-ready-line: "#2e594f"
  state-ready-ring: "#2e594f66"
  state-stale-bg: "#3a3222"
  state-stale-ink: "#d8b26a"
  state-failed-bg: "#3c2528"
  state-idle-bg: "#24272b"
  gold-tint-10: "#bc9c6310"
  gold-tint-14: "#bc9c6314"
  gold-solid: "#bc9c63"
  gold-bright: "#e0c383"
  free-ink: "#7fd6c6"
  # 聊天室与分镜表新增的层级色：都从既有灰阶里取，不引入第二种强调色。
  ink-quiet: "#7d838b"
  ink-whisper: "#6d747e"
  ink-faintest: "#5b6167"
  dot-idle: "#4a5057"
  chat-bubble: "#17181b"
  chat-bubble-mine: "#1b2422"
  chat-bubble-mine-line: "#28524a"
  chat-mark-bg: "#1e2b28"
  error-bubble: "#241a1c"
  error-bubble-line: "#5c3038"
  error-bubble-ink: "#edbcb6"
  card-hover-line: "#35504a"
  generate-bg: "#b5762a"
  generate-bg-hover: "#c8853a"
  generate-line: "#c98837"
  generate-ink: "#1a1206"
typography:
  display:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.7px"
  headline:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.5
  title:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "15px"
    fontWeight: 550
    lineHeight: 1.6
  body:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.8
  micro:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.6
  caption:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "9px"
    fontWeight: 500
    lineHeight: 1.7
  micro-tight:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "8px"
    fontWeight: 400
    lineHeight: 1.6
  dense:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
  compact:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  subhead:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.5
  page-title-sm:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.5px"
  page-title-xs:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "23px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.5px"
  page-title-md:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "25px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.6px"
  chat-title:
    fontFamily: "Inter, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.45
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "6px"
  sm: "8px"
  control-sm: "7px"
  chip: "5px"
  md: "10px"
  control-lg: "11px"
  tile: "9px"
  lg: "14px"
  mark: "15px"
  well: "16px"
  inset: "12px"
  panel: "20px"
  xl: "24px"
  full: "9999px"
spacing:
  base: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  page: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-on}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-on}"
    rounded: "{rounded.md}"
  button-outline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 16px"
  button-ghost:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 16px"
  input:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "10px 13px"
  tag:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    padding: "4px 11px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "24px"
  nav-item:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    height: "46px"
    padding: "12px 15px"
  nav-item-active:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.accent}"
    rounded: "{rounded.md}"
    height: "46px"
    padding: "12px 15px"
---

# Design System: 漫剧工坊 MANJU STUDIO

## Overview

**Creative North Star: "剪辑室的暗房"**

这是一间深夜还亮着的剪辑室。四壁是哑光的，没有任何东西反光抢走注意力；所有亮度都留给正在制作的那一格画面。界面本身不表演——它把色彩预算几乎全部投给**两件事**：青色代表"系统正在为你工作"（可点的主操作、正在生成、已就绪），墨金代表"这里是一个章节的边界"（角标、分隔、阶段标记）。除此之外的一切都是灰阶，用明度而不是色相来分层。

密度上，这是一个**信息密集但克制**的工具：资产表格一行一个角色、分镜默认折成一行、说明文字全部收进标题旁的 `?`。判断标准只有一条——每一处改动先问：这是让新手更快上手，还是让老手更快出片？都不是就不做。

**Key Characteristics:**

- 单一深色主题，`color-scheme: dark` 是刻意的，不做浅色模式、不做跟随系统
- 青色 `#22cbb8` 只用于交互与状态，面积严格受限；墨金只做章节点缀
- 零阴影，靠 border（`#2b2d31`）+ 背景明度差（`#101113` / `#17181b` / `#1c1d20` / `#121315`）分层
- 所有 token 单一出处：`src/globals.css` 的 `--site-*`，再经 `@theme inline` 映射成 Tailwind 语义色
- 面板 20px 圆角，控件 10px，微小件 8px；从不混用 4px/6px 的"网页感"圆角

## Colors

一套冷灰阶 + 一个青色信号 + 一点金。没有第二强调色。

### Primary

- **Signal Cyan** (#22cbb8)：唯一的主操作色。用在：主按钮底色、`nav-item.active`、`tag.success`、`.notice` 图标、`.brand-mark` 底、进度与"生成中"状态。**它是信号，不是装饰**——不用于标题、不用于大色块、不用于渐变。
- **Signal Ink** (#072d29)：青色上的文字色，保证 4.5:1 以上对比。

### Neutral

- **Darkroom Canvas** (#101113)：页面底。也是"外面的世界"。
- **Panel Surface** (#1c1d20)：`.panel` 卡片底，比画布亮一档。
- **Raised Surface** (#17181b)：`.provider-group`、`.workflow-card`、`.asset-bulk`、表头。
- **Rail** (#151618)：输入框底、`.sidebar`（`--sidebar`）。
- **Topbar** (#121315)：顶栏，比画布**深**一档——顶栏是"框"，不是"内容"。
- **Hairline** (#2b2d31)：默认边框，几乎所有分隔都用它。
- **Hairline Strong** (#35363b)：`.tag` 边框、需要比默认线更实一点的位置。
- **Text** (#ededf0) / **Text Secondary** (#bbbdc4) / **Muted** (#97999f) / **Faint** (#737983)：四级文字层级，从正文到元信息。

### Tertiary

- **Chapter Gold** (#d4af6a)：墨金。只出现在章节点缀——`.badge-paid`、`.workflow-icon`、`.gold-dot`、`.issue-list` 文本、`.tag.subtle` 的相邻语境。**面积不超过屏幕的 2%**。
- **Gold Ink** (#c8b07a) / **Gold Line** (#5c4c2f)：金的文字与描边配对。

### Named Rules

**The Signal Budget Rule.** 青色在任一屏幕上覆盖面积 ≤ 8%。它的稀缺性就是它的意义——满了就不再指示"可以点"。

**The Gold Is A Chapter Mark Rule.** 墨金从不用于交互态、从不用于正文、从不整块铺底。它标记"一个段落结束了"，不是"这个按钮重要"。

**The No Second Accent Rule.** 需要区分第四种状态时，调明度或加描边，不引入新色相。

## Typography

**Display Font:** Inter（回退 Microsoft YaHei / PingFang SC / sans-serif）
**Body Font:** 同族，Inter 只做拉丁与数字
**Label/Mono Font:** ui-monospace（仅用于 `.provider-row-model` 这类模型 ID）

**Character:** 一个家族到底。中文交给系统黑体，所以字重必须靠 `650 / 600 / 550 / 500 / 400` 这五档拉开——不要用 700，中文字体的 700 会糊成一团黑。

### Hierarchy

- **Display** (650, 30px, 1.4, -0.7px)：`h1` 页面标题。只有一个，每页一行。
- **Headline** (600, 18px)：`h2` 卡片标题、区块标题。
- **Title** (550, 15px)：`h3`、`.shot-summary h2`、`.provider-row-title h2`。
- **Body** (400, 14px, 1.65)：正文与表单。行高刻意偏松，因为满屏中文。
- **Label** (500, 11px)：`.tag`、按钮内小字。
- **Micro** (400, 10px)：`.sidebar-section-label`、`.saved-label`、`.nav-count`、`.provider-row-model`。

### Named Rules

**The Five Weights Rule.** 只用 400 / 500 / 550 / 600 / 650。中文在 700 上失去笔画层次。

**The No Uppercase Rule.** 不做全大写标签。中文没有大小写，混排会立刻暴露"这是模板"。

## Layout

侧栏固定 240px（`SidebarProvider` 的 `--sidebar-width`），内容区 `max-width: 1420px`，`padding: 16px 32px 20px`。顶栏 48px 单行，面包屑必须一行内完成（`.breadcrumb-project` 超长省略，`max-width: 180px`）。

**没有步骤条了。** 新结构里页面层级由路由和面包屑表达：聊天室 → 作品集 → 系列 → 剧集。删掉 `.stage-strip` 与 `nav-locked`，因为再没有任何「先确认上一步」的准入拦截——每一页都可以直接进。侧栏下半是当前系列的集数列表（`.sidebar-episode-list`），它承担过去步骤条的角色：告诉你现在在哪一集。

聊天室用 `.chat-shell` 两栏（236px 会话栏 + 主区），≤1180px 折单栏且会话栏移到下方。剧集分镜表是五列固定表格（74 / 22% / 20% / 30% / 15%），≤900px 外层 `.episode-table-panel` 横向滚动、表格 `min-width: 860px`——**横向滚动只出现在表格容器内，页面本身永不横向溢出**。

内容区在宽屏用 `.workbench` 双栏：主创作区 `minmax(0,1fr)` + 右侧 `280px` 吸顶栏（放状态、校验结果、下一步）。≤1180px 折成单栏，aside 变成自适应网格；≤767px 单栏 + 底栏主操作。

断点：1500（4 列网格）/ 1180（双栏折单、聊天室折单）/ 1024（面包屑收成当前页）/ 900（lightbox 折单、分镜表横向滚动）/ 767（移动端，侧栏变抽屉）。

间距节奏走 `--site-space` 乘法：`.panel` 24px、`.stack` 24px、卡片内 12–16px、表格单元格 10–12px。

## Elevation & Depth

**这个系统没有阴影。** 深度完全由四层背景明度 + 一道 1px 描边表达。唯一的例外是 shadcn `outline` 按钮自带的 `shadow-xs`，属于组件库默认值，不要扩散。

### Named Rules

**The Flat-By-Default Rule.** 静止状态一律无阴影。需要"浮起来"时，改背景明度或加描边，不加 `box-shadow`。

## Shapes

20px 是标志性圆角——`.panel`、`.provider-group`、`.empty`、`.asset-table-wrap` 都用它，让整页读起来像"一张一张的卡片"而不是"一堆矩形"。

- **20px**：面板、容器、空状态
- **14px**：`.workflow-card`、`.notice`、`.provider-tabs`
- **12px**：`.alert`、`.asset-bulk`、`.compact-bar`、`.reference-preview`
- **10px**：输入框、`.nav-item`、`.search-select-trigger`、`button`（shadcn `rounded-md`）
- **8px**：`.tag`、缩略图、极小控件
- **圆形**：`.avatar`、`.status-dot`、`.timeline-dot`

描边一律 1px。虚线只用于"这里可以放东西"（`.empty`、`.asset-reference-drop`、`.provider-ref`、`.template-block.locked`）。

## Components

### Buttons

- **Shape:** 10px 圆角（shadcn `rounded-md` 走 `--radius-md`），高度 36px 默认 / 32px `sm` / 40px `lg`
- **Primary:** `bg-primary` = 青色，文字 `--primary-foreground` = 深墨绿。仅用于"这一步的主操作"
- **Hover / Focus:** 底色 `primary/90`；键盘焦点是 `focus-visible` 的 3px ring（`--ring` = 青色）
- **Secondary / Outline / Ghost:** 描边版用于并列操作，ghost 用于行内轻操作。`.primary-action` 是首页"开始创作"的更高一档（40px / 9px 圆角）

### Chips

- **Style:** `.tag` —— 1px `#35363b` 描边 + 透明底 + `#bbbdc4` 文字，11px
- **State:** `.tag.success` 青字青边；`.tag.danger` 红字红边；`.tag.subtle` 灰。**`.badge-paid` / `.badge-free` 是独立的角标类，不是 `.tag`**——`browser-models.mjs` 断言每个 `.provider-panel` 恰好一个 `.tag`

### Cards / Containers

- **Corner Style:** 20px
- **Background:** `.panel` = `#1c1d20`；`.provider-group` / `.workflow-card` = `#17181b`
- **Shadow Strategy:** 无，见 Elevation
- **Border:** 1px `#2b2d31`
- **Internal Padding:** 24px（`.panel`），密集区 12–16px

### Inputs / Fields

- **Style:** `#151618` 底 + 1px `#2b2d31` 边 + 10px 圆角 + `10px 13px` 内距
- **Focus:** 边框转青色 + `0 0 0 2px #22cbb811` 光晕
- **Error / Disabled:** 错误走 `.alert` + `ErrorNote`；禁用态 `opacity: .5` + `cursor: not-allowed`

### Navigation

- **Style:** `.nav-item` 46px 高、10px 圆角，图标 19px `stroke-width: 1.6`
- **默认 / 悬停 / 激活:** 文字 `#a8abb3` → `#f1f2f4` → 青色；激活底 `#22cbb812`
- **层级:** 一级只有两项——聊天室、作品集。当前系列的集数走 `.nav-item.nav-sub`（12px、`.episode-dot` 圆点标记当前集），不要因为它长得像一级项就给它一级权重
- **没有锁定态:** `.nav-locked` 与「先确认：X」已随六步流程删除。任何入口点进去都能看，缺数据的页给空态与下一步按钮
- **移动端:** `≤767px` 侧栏收起为 Sheet 抽屉，顶栏出现 `SidebarTrigger`

### Signature: 生成进度与任务托盘

`ProgressPanel` + `JobTray` 是本产品的核心差异点。规则：**不提供推测的总体百分比**。视频这类服务商不返回进度的，用不确定进度条 + 已用时；取消按钮必须写明「取消只停止等待，服务商可能已受理并计费」。

### Signature: 聊天室流式输出

聊天室是唯一按字输出的地方：正文边生成边出现在气泡里，末尾一条 2px Signal Cyan 竖线（`.chat-msg.is-streaming`）表示「还在写」，1.1s 步进闪烁。

规则：
- 流式过程中的半截正文**只在内存**（`store/chat.ts` 的 draft），不写 localStorage——逐字落盘会每帧序列化整份会话，且中途刷新会留下半句话。结束才一次性提交。
- 流中断时**保留已流出的部分**，在末尾补「（输出中断：原因）」，不要清空重来。用户看到的前 800 字比一句错误提示有用。
- 失败后原文必须回到输入框。生成失败不是用户的错，重写几百字设定是惩罚。
- 不显示 token 数、字/秒这类只有实现者关心的指标。

## Do's and Don'ts

### Do:

- **Do** 所有颜色、间距、字体走 `src/globals.css` 的 `--site-*` 与 `@theme inline` 映射；组件里出现裸十六进制视为缺陷。
- **Do** 新增次要说明时用 `.HelpPopover`（标题旁 `?`）或 `Fold`（原生 details），不要直接铺在创作区。
- **Do** 每页主操作只有一个，放 `.page-heading-actions` 或底部 `.sticky-actions`。
- **Do** 付费动作前必须有确认弹窗，且文案写明「确认后才会调用付费 API」。
- **Do** 390px 下用单栏、主操作固定底部、页面不得横向溢出。

### Don't:

- **Don't** 新增第二套变量体系，或在 `components/ui/*` 里改 shadcn 的默认色板（那会绕过 `--site-*`）。
- **Don't** 引入浅色模式、跟随系统主题、或任何 `prefers-color-scheme: light` 分支。
- **Don't** 加阴影、毛玻璃、渐变装饰、发光描边。深色界面里它们读起来像"AI 生成"。
- **Don't** 加全大写 eyebrow 标签、`01 / 02 / 03` 序号装饰、`A · B · C` 中点串、链接后跟 `→`。
- **Don't** 把 `.tag` 类用在角标上，或改变 `.provider-panel` 的 `h2` 文案（`browser-models.mjs` 精确匹配）。
- **Don't** 在 `main` 里放 `input[type=file]`（必须为 0；文件输入一律在 Modal 内）。
- **Don't** 给 `.compact-media-thumbnail` 超过 150px 的高度。
- **Don't** 把分镜表做成"每生成一镜点四下"；也不要为了好看牺牲既有测试断言的按钮文案。
- **Don't** 给分镜 JSON 开第二个入口。它是唯一入口：聊天室生 JSON、导入弹窗写进这一集，别的地方只能读。

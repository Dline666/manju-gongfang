# 前端重构用开源设计 Skill 选型

> 用途：给漫剧工坊前端改版挑一个外部设计 Skill，并用项目约束把它"适配"到这个仓库。
> 选型标准不是"能生成多漂亮的页面"，而是三条硬约束：
> 1. **能在既有代码上改**（本项目已有 6 个页面、大量 `--site-*` 变量、shadcn 组件），不接受"另起一套主题"；
> 2. **不破坏 DOM/文案契约**：`tests/browser-flow.mjs`、`browser-assets.mjs`、`browser-models.mjs`、`browser-recovery.mjs` 用选择器和精确文案定位；
> 3. **风格体系不变**：即梦工作台深色、面板 `#1C1C1F`、左导航 240px、主按钮青色 `#22cbb8`、墨金 `#D4AF6A` 只做章节点缀（见 `docs/REFACTOR-PLAN.md` 开头）。

## 候选清单

| Skill | 仓库 | 许可证 | 定位 | 对本项目的适配度 |
|---|---|---|---|---|
| **impeccable** | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Apache-2.0 | 设计词汇 + 评审 + 62 条确定性"AI 味"检测器；`critique`/`audit`/`polish`/`document`(生成 DESIGN.md)/`live` 变体模式 | ★★★★★ 明确面向**已存在的界面**迭代；原生支持 DeepSeek Harness（`.dsh/skills/impeccable`），检测器可离线跑 |
| **oil-ui** | [oil-oil/oil-ui](https://github.com/oil-oil/oil-ui) | MIT | 探索/对比 3 个真正不同的视觉方向，按真实截图收敛 | ★★★★☆ 适合"先看几个方向再定"；有官方 DSH 插件 `dsh-oil-ui`；但**改造既有项目**是 Pro 版能力，开源版偏新页面 |
| **ui-ux-pro-max** | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | MIT | 194 条行业规则 + 80 风格 + 194 配色 + 74 字体搭配的设计系统生成器（需 Python 3） | ★★★☆☆ 目录很全，但有 shadcn/ui 栈指南；偏"从零生成一套设计系统"，与本项目"守住既有 token"目标相反，需裁剪使用 |
| **frontend-design** | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | 随仓库（LICENSE.txt） | 纯指导型：美学方向、字体、反模板清单、写作规范，不含工具 | ★★★★☆ 轻量、无依赖，可直接当"改版守则"读；但它鼓励大胆换视觉方向，需用项目约束压住 |
| **design-skills** | [ihlamury/design-skills](https://github.com/ihlamury/design-skills) | MIT | 87 份从 Linear/Stripe/Figma/Spotify 等真实产品抽取的 MUST/SHOULD/NEVER 设计约束 | ★★★★☆ **当参考手册用**：`linear`、`spotify`、`raycast` 三份是深色工具型 UI，和本项目气质最接近，可对照校准间距/圆角/层级 |
| **frontend-design-audit** | [mistyhx/frontend-design-audit](https://github.com/mistyhx/frontend-design-audit) | MIT | 按 15 条可用性启发式做审计（严重度 0–4 分 + 具体修复） | ★★★☆☆ 适合改版前后各跑一次，产出一份可验收的问题清单 |
| ~~superdesign~~ | [superdesigndev/superdesign-skill](https://github.com/superdesigndev/superdesign-skill) | MIT | 画布式设计草稿 | ✗ 需要 `npm i -g @superdesign/cli` + 登录 + 云画布，不适合本地离线重构 |

## 推荐组合

- **主力：impeccable**。理由：它是这批里唯一把"在已有界面上改"当第一场景、并且自带确定性检测器的；`document` 能把本项目现有的 `--site-*` 体系沉淀成 `DESIGN.md`，之后每次改动都受它约束，正好对应本项目"风格体系不变"的要求。
- **辅助：anthropics/frontend-design**（当改版守则读）+ **ihlamury/design-skills 的 linear / spotify / raycast**（当深色工具 UI 的量化参照）。
- **可选：oil-ui**，仅当你想先看 2–3 个不同视觉方向再拍板时用；注意开源版不做既有项目翻新。

## 适配本项目：必须写进 Skill 上下文的前置约束

任何设计 Skill 默认会按"通用好品味"动手，以下 5 条不提前写清楚就会被改坏：

1. **token 只有一处**：颜色/间距/字体全部走 `src/globals.css` 里的 `--site-*` 及其 `@theme inline` 映射；禁止新增第二套变量、禁止在组件里写死十六进制。
2. **主题不做 light 模式**：`color-scheme:dark` 是刻意的；不要引入浅色主题或"跟随系统"。
3. **布局契约**：`SidebarProvider` 的 `--sidebar-width:240px`、`workspace-content` 的 max-width、`.stage-strip` ≤36px、`topbar` 单行面包屑。
4. **测试契约（改版红线）**：
   - 7 个 `.provider-panel`，每个恰好一个 `.tag`；面板 `h2` 标题文案不变（`browser-models.mjs` 精确匹配）；
   - `main input[type=file]` 必须为 0（文件输入一律在 Modal 内）；
   - `.compact-media-thumbnail` 高度 ≤150；
   - 390px 下 `.saved-label` 隐藏、`.topbar-trail > span:last-child` 高度 <30、页面无横向溢出；
   - 文案「已填写 · 待验证」「可用」「调用失败」「Key 缺失」「模型平台拒绝了此 Key，请检查密钥及账号地区。」逐字保留。
5. **文案语气**：界面中文、短句、动词开头；付费确认必须写明"确认后才会调用付费 API"；取消类文案要诚实（"取消只停止等待，服务商可能已受理并计费"）。

## 落地顺序建议

1. 装 Skill → 让它读 `src/globals.css`、`src/App.tsx`、`src/components/Ui.tsx` 和 `tests/browser-*.mjs`，先 `document` 出一份 `DESIGN.md`（把上面 5 条固化）。
2. 只挑**一个**页面做试点（建议 `features/assets/AssetsPage.tsx` 资产表格，它是信息密度最高、最需要层级重整的），改完跑 `npm run test:browser`。
3. 试点通过后再铺开到其余页面；每页改完都跑一次浏览器测试，不做"全站一次性重写"。

## 已完成：impeccable 已装并适配

### 安装

```bash
npx skills add pbakaus/impeccable --agent universal -y
# 装到 .agents/skills/impeccable，再移到 DSH 的最高优先级根：
# Move-Item .agents/skills/impeccable .dsh/skills/impeccable
```

- 落点 `.dsh/skills/impeccable`（DSH 技能根 rank 100，项目根 = 最近含 `.git` 的目录），已被 DSH 目录识别为 `impeccable`。
- 版本 4.11.1，占用 2.23 MB / 69 文件；`.dsh/` 已加入 `.gitignore`，不入库（`skills-lock.json` 记录来源与 commit，可复现）。
- **引擎二进制**：`scripts/impeccable.cmd` 首次运行会下载 `impeccable-windows-x64.exe`（23.6 MB）到 `%USERPROFILE%\.impeccable\bin\<ver>\`。本机 GitHub release 直连被重置过一次，重试后成功；若再失败，`engine-probe` 会给出明确的网络/权限原因，且 **Skill 的指导部分不依赖引擎**（见 SKILL.md 的 "Launcher unavailable" 降级路径）。

### 适配产物

- **`DESIGN.md`（仓库根）**：把现有的 `--site-*` 体系、真实字号/圆角尺度、两条 Named Rule（Signal Budget、Gold Is A Chapter Mark）和 8 条 Don't 固化成 impeccable 每次必读的上下文。**这是"适配"的核心**——没有它，任何设计 Skill 都会按通用品味改掉这套深色体系。
- 已验证：`impeccable context` 能读到 DESIGN.md 的 token、North Star、全部 Rule 与 Don't 清单。

### 基线数据（改版验收用）

`impeccable detect src --json` 在本项目的结果：

| 阶段 | 发现数 | 构成 |
|---|---|---|
| 初次扫描 | **78** | 36 字号 + 27 颜色 + 14 圆角 + 1 侧边色条 |
| 补全 DESIGN.md 尺度后 | **8** | 6 圆角 + 1 字号 + 1 侧边色条 |
| 再补 8px/12px 后 | **1** | `Side-tab accent border` |

关键结论：**78 条里有 77 条其实是"已在用但未记录"，只有 1 条是真缺陷。** 这印证了先把现有体系写进 `DESIGN.md` 的必要性——否则一次"重构"会把这 77 条合法用法当成问题全部改掉。

唯一真缺陷，也是第一个该修的：

```css
/* src/globals.css:220 —— 圆角卡片左侧一道 3px 色条，读起来像 AI 生成 */
.asset-row.is-form{border-left:3px solid #2e594f}
```

修法（任选，不动布局）：改成整圈 1px 描边 `.asset-row.is-form{box-shadow:inset 0 0 0 1px #2e594f}`，或改用背景微调 `background:#2e594f0d`，或改成行首一个「编辑中」`.tag`。

改动后复查：

```bash
.dsh/skills/impeccable/scripts/impeccable.cmd detect src --json
npm run test:browser   # 需先 npm run dev（Edge + 127.0.0.1:5173）
```

# 漫剧工坊前端 + 流程重构计划

> 状态：已确认，按本文执行。只改界面、流程和提示词，不改数据契约。每个 PR 可单独合并、单独回滚。
> 评判标准：每处改动先问一句——这是让新手更快上手，还是让老手更快出片？都不是就不做。
> 风格体系不变：即梦工作台深色、面板 #1C1C1F、左导航 240px、主按钮青色、墨金只做章节点缀。

## 决策记录

| 事项 | 结论 |
|---|---|
| 可选数据字段 | 允许新增 4 个可选字段（见第 0 节），不升 version、不改存储键 |
| 429 自动重试 | 允许，仅在 pool.ts 层，最多 2 次；submission_unknown、超时、5xx 一律不自动重试 |
| PR6（提示词模板）开工时机 | 等「JSON 结构化提示词」子目标合并后再开工，之前先做 PR0–PR5 |

## 进度记录

更新时间：2026-11-22。main 当前 `1a3160f`，PR0–PR5 已全部合并，远端对应分支已删除，远端仅剩 `main` 与 `feat/huggingface-image`。

| 交付 | 状态 | 合并提交 |
|---|---|---|
| PR0 共享件 | 已完成 | a317db7 (#2) |
| PR1 设置分组 + 失败分级 | 已完成 | f35743a (#8) |
| PR2 减负 | 已完成 | 7df2df0 (#4) |
| PR3 进度与取消 | 已完成 | fd01b2f (#5) |
| PR4 图片并发 | 已完成 | 76cce48 (#6) |
| PR5 批量与抽屉 | 已完成 | 1a3160f (#7) |
| PR6 提示词模板 | 未开工，等待「JSON 结构化提示词」子目标合并 | — |
| PR7 流程拆分 + 8a + 8b | 未开工，依赖 PR6 | — |
| PR8 导出前检查 | 未开工，依赖 8b 的 DurationStrip | — |

已核对落地情况：

- 关键文件均存在：pool.ts、jobs.ts、JobTray.tsx、ProviderGroups.tsx、ShotTimeline.tsx、ShotDrawer.tsx。
- 新增测试 pool.test.ts 存在；providers.test.ts、store.test.ts、browser-assets.mjs、browser-models.mjs 有对应补充。
- PR6/PR7 才需要的可选字段（confirmed、promptConfig、Asset.locked、Shot.staleReason）尚未加入 schema，符合预期。
- PR4 额外新增了持久化设置项 imageConcurrency（1–5，可选），与计划中「设置里可调 1–5」一致，不冲突。

## 0. 前置说明

### 0.1 与需求描述的 3 处出入（按代码修正范围）

- 资产页已是缩略图墙：AssetsPage 已有 asset-compact-grid，点缩略图已开详情 Modal。真正缺的是多选、批量生成、批量复制、批量导入、上一张/下一张，以及生成动作藏在 Modal 里。
- 生成页不是字面上的 Modal 套 Modal：它是「卡片 Modal → 关闭 → 确认 Modal」的跳转链，每生成一镜要点 4 次。要改的是这条链。
- 设置页是 7 个厂商面板，不是 6 个。browser-models.mjs 断言 .provider-panel .tag 恰好 7 个，分组时必须保持。

### 0.2 新增的可选字段（仅有的数据增量）

| 字段 | 用途 |
|---|---|
| Project.confirmed?: { script?: number; assets?: number; director?: number } | 记录各步确认时的 revision |
| Project.promptConfig?: { v: 1; style?: StyleSpec; blocks?: Record<string,string> } | 模板覆盖 |
| Asset.locked?: boolean | 资产锁定 |
| Shot.staleReason?: string | 待更新的原因 |

- 在 schema.ts 里全部写成 .optional()，旧数据原样加载，store.test.ts 的 restored.projects deepEqual saved.projects 不受影响。
- 不动 version: 1、存储键 manju-studio-v1、IndexedDB。
- 回滚时忽略这些字段即可，不需要数据迁移。

### 0.3 开工前执行者必须先通读的文件

- src/globals.css（计划作者只看到 6 个相关选择器的出现次数，没看到内容）
- tests/media.test.ts、tests/browser-media.mjs
- src/lib/media/*、src/features/export/TimelinePreview.tsx
- src/components/ui/*（确认是否已有 sheet / popover，没有就用 shadcn 生成）
- package.json 的脚本

### 0.4 PR0 共享件（不改任何页面行为）

| 新文件 | 内容 |
|---|---|
| src/lib/pool.ts | runPool(items, worker, {concurrency, signal, onUpdate})，每项独立 try/catch，单项失败不拖整批 |
| src/store/jobs.ts | 内存态任务表（不持久化）：id、kind、label、status、startedAt、finishedAt、errorCode，附同类任务耗时滚动平均 |
| src/lib/api.ts（追加） | 给 ApiError 加只读 hint，不改 message |
| src/components/Ui.tsx（追加） | HelpPopover、StatusChip、ErrorNote、ProgressPanel |
| src/components/JobTray.tsx | 全局任务托盘，挂在 App.tsx |

## 第 1 点：提示词模板化（PR6，等「JSON 结构化提示词」子目标合并后开工）

### 1.1 现状

- prompts.ts 里风格只有一行「风格：${project.style}」，没有介质、线条、配色、面部渲染，也没有禁写清单。
- 固定短语只是「逐字复用」，没有优先级条款。
- 用户改不了：skills.ts 的 4 段 template 是写死字符串。

### 1.2 目标结构

1. 新增 src/lib/promptTemplates.ts，按 5 套模板各自定义 block 列表：script（剧本）、assets（资产）、director（导演分镜）、image（图片）、video（视频）。
2. 每个 block 为 { id, label, locked, text, vars }。locked 为 true 的块不可编辑。
3. 渲染顺序：project.promptConfig.blocks[blockId] 优先，没有则用内置默认。
4. prompts.ts 的构建函数只改「取文本」的位置，函数签名与输出结构不变，不重写整个文件。
5. 风格拆成 StyleSpec：medium 介质、line 线条、palette 配色、face 面部渲染、light 光线、forbidden 禁写数组。project.style 字符串保留并作为第一行输出，StyleSpec 展开后接在其后。
6. 优先级条款写进锁定块：P0 固定短语逐字 > P1 本镜动作与终点 > P2 风格块 > P3 运镜 > P4 Skill 附加建议。冲突时保 P0。

### 1.3 锁死与可改

| 模板 | 锁死 | 可改 |
|---|---|---|
| 剧本 | JSON 输出契约；10 节拍、90 秒、每拍 4–15 秒整数；资产只引用清单内名称 | 剧作规范、禁写清单、题材补充、自由补充 |
| 资产 | 只从剧本提取、不重写剧情；JSON 契约；已有短语逐字沿用 | 固定短语写法、禁写清单 |
| 导演 | JSON 契约与枚举；不改剧情、对白、时长、镜数 | 导演规范、衔接与转场、禁写清单 |
| 图片 | 固定短语逐字块；人物三视图条款（creation.test.ts 有断言） | 风格块、禁写清单、场景与道具构图说明 |
| 视频 | 附件顺序条款；音频模式行（browser-recovery.mjs 断言含「后期配音模式」且不含「按下列对白自然发声」）；固定资产块 | 精简风格块、运动规范、禁写清单 |

### 1.4 存放与生效

- 存在 project.promptConfig，每个作品独立。改完对下一次生成立即生效，不触发 invalidate。
- 现有确认弹窗已展示「即将发送的完整提示词」，用户可直接看到改动结果。
- 改风格后提示「已生成的 N 张图不会自动重做」，并提供「重新生成全部」入口（走第 3、4 点的批量能力）。
- 校验：变量白名单（如 {{style.medium}}），未知变量标红；视频提示词上限 7000 字（handler.ts 限制），编辑器实时计数，超 6000 变黄、超 7000 变红并禁止保存；剧本提示词上限 32000；每个块有「恢复默认」。

### 1.5 界面

- 新增 features/prompts/TemplateEditor.tsx，用 Sheet 从剧本页「高级」和各确认弹窗的「编辑模板」进入。
- 左侧 5 套模板，右侧块列表：锁死块置灰并带锁标和原因提示，可改块是带字数的文本框，底部用示例镜头渲染实时预览。

### 1.6 完整示例：《断剑归门》东方玄幻水墨风

**StyleSpec**

| 字段 | 内容 |
|---|---|
| medium 介质 | 宣纸质感的水墨淡彩，半写意；墨分焦、浓、重、淡、清五色；留白占画面 20–35%；可见纸纹与洇墨边缘 |
| line 线条 | 中锋勾勒为主，墨线随轮廓粗细变化；人物衣纹用兰叶描；山石用披麻皴或斧劈皴；不用均匀矢量线，不用赛璐璐硬边 |
| palette 配色 | 主色冷灰 #5B6168、墨黑 #1C1D1F、宣纸白 #E9E6DD；唯一强调色金色灵光 #D4AF6A，只用于灵力、断口微光、门环，面积不超过画面 8%；禁止大面积高饱和色 |
| face 面部 | 东方面孔；淡墨渲染明暗；单线眉眼，眼小含神；无写实皮肤纹理，无磨皮高光，无 3D 渲染感，无美漫大眼 |
| light 光线 | 柔和散射光；金色灵光是唯一点光源；云海与雾用留白表现 |
| forbidden 禁写 | 水印、署名、字幕、文字；手机、塑料、拉链等现代物品；西式盔甲；霓虹；3D 与 CG 质感；照片写实；多余肢体、畸形手指 |

**① 剧本模板**

- 【锁】S1：只输出合法 JSON，不要围栏；10 个节拍，合计 90 秒，每拍 4–15 秒整数；结构见契约。
- 【改】S2 剧作规范：三幕，第 1–2 拍建置、第 3–7 拍对抗、第 8–10 拍高潮与收束。每拍只写一个可见事件（谁在哪、做了什么、情绪如何转折），拍与拍之间有因果。
- 【改】S3 禁写：不写景别与运镜术语（推、拉、摇、移、特写、远景、近景、俯拍、仰拍、跟拍、切）；不写抽象心理，改写成可见动作；不写时间戳；不写画风；每句对白不超过 18 字，每拍对白不超过 2 句；不用现代词汇；人物名全篇一致。
- 【改】S4 题材：东方玄幻修仙，修为体系只作背景，不展开设定。
- 【锁】S5：资产名称只引用清单内的；已有资产短语逐字沿用。
- 【改】S6 补充要求：自由文本。

**② 资产模板**

- 【锁】A1：只从剧本提取，不重写剧情；JSON 契约。
- 【改】A2 固定短语写法：人物 = 年龄体型｜发型发色｜面部特征｜服装（款式、颜色、材质）｜随身标识，不超过 90 字，不含动作与情绪；场景 = 空间结构｜主色与材质｜光线与时间｜环境层次；道具 = 轮廓｜材质｜比例｜关键细节与磨损。
- 【改】A3 禁写：不写画风词；不写「漂亮、帅气」等主观词；不写镜头；不写剧情；不编造剧本里没有的外观。
- 示例短语：
  - 阿青：十六岁少年，清瘦；黑色短发束半髻，额前碎发；眉眼清淡，左眼角一粒小痣；灰青色粗布交领短衣，袖口磨边，腰系暗红麻绳；背空剑鞘。
  - 山门：黑色石阶九十九级，两侧古松，石门楼，门环为暗金色；清晨低雾。
  - 断剑：红绳缠绕的剑柄，斜断口，剑身残长约一尺，锈蚀；断口有微弱金色灵光。

**③ 导演模板**

- 【锁】D1：每镜输出 { number, shotSize, movement, angle, start, action, end }。shotSize 取 远景、全景、中景、近景、特写；movement 取 固定、推、拉、摇、移、跟、升降、环绕；angle 取 平视、俯视、仰视。
- 【改】D2 导演规范：每镜只有一个主运镜；景别随情绪递进，建置用全景或远景，冲突用近景或特写，收束回远景；同一景别连续不超过 2 镜；下一镜起点必须承接上一镜终点（人物位置、朝向、道具持握）；动作只写时长内能完成的，约每 3 秒一个动作点。
- 【改】D3 禁写：不改剧情、对白、时长、镜数；不引入清单外的人物和道具；不写画风；不写「突然、瞬移」。

**④ 图片模板（人物）渲染示例**

```
为漫剧制作人物设定图。作品主题：玄幻修仙，少年碎灵后捡到一把断剑。
风格：东方玄幻水墨风，冷灰 + 金色灵光。
【风格块】介质：宣纸质感水墨淡彩，半写意…… 线条：中锋勾勒…… 配色：…… 面部：……
【固定资产块 · 原短语逐字复用】
十六岁少年，清瘦；黑色短发束半髻……
【优先级】固定资产描述 > 风格块；冲突时保固定描述。
只输出一张角色三视图设定卡：……（锁死条款，原文不变）
【禁写】水印、署名、文字、现代物品……
```

**⑤ 视频模板（结构）**：第 N 镜 + 时长 + 风格行 + 精简风格块（约 150 字）+ 上一镜终点 + 附件顺序【锁】+ 动作、运镜、终点 + 对白 + 音频模式行【锁】+ 固定资产块【锁】+ 视频禁写（不出现字幕、文字、水印；不变脸变装；不新增人物；不改固定外观）。

### 1.7 改动文件

- 新增：src/lib/promptTemplates.ts、src/features/prompts/TemplateEditor.tsx
- 修改：src/lib/prompts.ts、src/lib/skills.ts（template 变为默认块文本来源）、src/domain/types.ts、src/store/schema.ts、src/features/script/ScriptPage.tsx（入口）
- 新增测试：tests/templates.test.ts（锁死块不可覆盖、未知变量报错、字数预算、默认渲染与现有断言一致）

### 1.8 验证

- creation.test.ts 中全部提示词断言保持通过。
- 新增 templates.test.ts 通过。
- 手工：改风格块后打开确认弹窗，完整提示词随之变化；点「恢复默认」后还原。

## 第 2 点：流程解耦为 剧本 → 资产 → 导演分镜脚本 → 分镜 → 视频（PR7，依赖 PR6）

### 2.1 现状

- scriptPrompt 加 SCRIPT_SCHEMA 一次产出 10 镜，每镜都带 camera、start、action、end，剧本和分镜混在一起。
- 校验固定为「10 镜 + 90 秒」。
- App.tsx 只有 4 步 + 导出，Stage 里没有 director。

### 2.2 数据落点（不新增容器）

沿用 project.shots，各字段分阶段填充：

- 剧本步：写 visual（该节拍发生了什么）、duration、dialogues。camera、start、action、end 留空。
- 导演步：补 camera、start、action、end。camera 存为「景别·运镜·机位」。
- 分镜步：沿用现有页面（确认对应关系、挂参考图）。

### 2.3 各步输入、输出、校验

| 步 | 输入 | 输出 | 校验规则 |
|---|---|---|---|
| ① 剧本 | 主题、风格、模板 | { title, logline, characters[], scenes[], props[], beats:[{ title, scene, characters[], summary, dialogues[], seconds }] } | 10 拍；seconds 为 4–15 整数且合计 90；资产名必须在清单内；summary 出现镜头术语只警告不阻断；每句对白超 18 字只警告 |
| ② 资产 | 剧本里的资产清单 | 现有 assets 结构（name、description、lock、imageId） | 复用 validateProject 的资产规则；每类至少一项，缺失标出；人物固定短语非空 |
| ③ 导演 | 剧本拍点 + 资产固定短语 | { shots:[{ number, shotSize, movement, angle, start, action, end }] } | 镜数等于拍数；number 连续；枚举合法；每镜 start、action、end 非空；时长不得改动；start 与上一镜 end 由人工核对承接 |
| ④ 分镜 | 导演结果 | 现有分镜确认（storyboardReady） | 沿用 validateProject |
| ⑤ 视频 | 确认后的分镜 | 现有流程 | 沿用 |

### 2.4 后端

- 在 functions/handler.ts 新增 screenplay 与 director 两个 action：ACTION_FIELDS 各加一行，各带 schema 与 validateScreenplay、validateDirector，错误码 invalid_screenplay、invalid_director。
- 原 script、extract-assets 一字不改，既保留回滚路径，也不破坏 providers.test.ts。
- 新 action 对 seedream 等错误 provider 同样返回 invalid_provider。
- lib/api.ts 补两个新错误码的中文文案。

### 2.5 上一步没确认，下一步怎么锁

- 新增 src/domain/flow.ts：stageStatus(project) 与 canEnter(project, stage)。
- 状态取自 project.confirmed，用确认时的 revision 比对；上游被改过（revision 变大）则下游状态回到「待确认」。
- 左导航和步骤条对未解锁步骤置灰，点击提示「先确认：剧本」并带「去确认」按钮。
- 每页底部主按钮为「确认并进入下一步」。确认前先跑该步校验，未通过则列出具体项，每项可点击跳转到对应镜头或字段。

### 2.6 旧作品迁移（零数据迁移）

confirmed 为 undefined 时按派生规则推断：

- 有镜头即视为剧本已确认。
- 有资产即视为资产已确认。
- 所有镜头 camera、action、end 非空即视为导演已确认。
- storyboardReady 保持原值。
- 用户点击确认时才写入 confirmed。

### 2.7 无 Key 路径

导演页提供「本地补全」，调用现有 fillStoryboard；templateScript 改为只生成剧本层字段，再走本地补全。新手无需任何 Key 就能跑通整条流程。

### 2.8 改动文件

- 新增：src/domain/flow.ts、src/features/director/DirectorPage.tsx、tests/flow.test.ts
- 修改 src/domain/types.ts：Stage 加 director，readStage 同步。
- 修改 src/App.tsx：导航改 5 项，步骤条 slice(0,5)，currentStep 里写死的 3 要改，nav-order 的 Math.min(index+1,4) 要改。
- 修改 ScriptPage.tsx（拆分）、creation.ts（templateScript、normalizeScript 增加剧本层变体）、prompts.ts（新增 screenplayPrompt、directorPrompt）、functions/handler.ts、lib/api.ts、store/schema.ts。

### 2.9 验证

- flow.test.ts：含旧作品派生、上游修改后下游回到待确认。
- providers.test.ts 追加 screenplay、director 的契约与错误 provider 用例。
- browser-flow.mjs 更新：剧本页 .shot-card 数量、分镜前先走导演确认。
- 手工：打开一个旧作品不报错，各步状态按派生规则显示。

## 第 3 点：批量与高效操作（PR5，依赖 PR4）

### 3.1 现状

- 资产页已是缩略图墙，点缩略图开详情 Modal，但没有多选、批量生成、批量复制、批量导入，生成动作藏在 Modal 里。
- 分镜页每镜信息全部展开，页面很长，没有总览。
- 生成页「卡片 Modal → 关闭 → 确认 Modal」，每生成一镜要点 4 次。

### 3.2 资产页（AssetsPage.tsx）

- 每张缩略图加复选框；顶部批量栏：全选、「生成缺图（N）」、「复制全部提示词」（多条用 `\n\n---\n\n` 连接）、「确认全部资产」。
- 点缩略图仍打开 Modal，改为大图 Lightbox：左图右信息，`←` `→` 切换上一张、下一张。保留 aria-label「查看{name}详情」和 Modal 内「完整图片提示词」textarea（browser-assets.mjs 有断言）。
- 批量导入：Modal 内粘贴或上传「类型：名称：描述」文本，复用 extractLocalAssets 与 mergeDraftAssets，先出预览表（重名标「沿用」），确认后写入。
- 批量导图：Modal 内多文件拖入，按文件名匹配资产名，未匹配的单独列出。
- main input[type=file] 数量必须保持 0，所有文件输入都放在 Modal 里。

### 3.3 分镜页（StoryboardPage.tsx）

- 每镜默认折叠成一行：镜号 · 时长 · 景别运镜 · 动作摘要 · 状态点。点击展开，另有「全部展开/折叠」。
- 顶部新增 ShotTimeline（src/features/storyboard/ShotTimeline.tsx）：横向条，宽度按时长比例，颜色表示就绪、待更新、缺失、失败；点击滚动并展开对应镜。
- 批量：
  - 「复制全部视频提示词」，用 videoPrompt 逐镜拼接，以 `====第N镜====` 分隔。
  - 「按镜头资产自动挂参考图」，默认 reference_image 模式，先预览再写入，走 updateReference。
- 注意：browser-assets.mjs 要求「复制人物 / 场景 / 道具提示词」按钮各 10 个且 nth(9).waitFor()，折叠后这些按钮不可见，测试里需先点「全部展开」。

### 3.4 生成页（GenerationPage.tsx）

- 把 ShotMediaCard 内的 Modal 改成右侧 Drawer（ShotDrawer.tsx，基于 shadcn Sheet，仍是 role=dialog，兼容现有测试）。
- 「API 生成」的确认改为 Drawer 内的内联确认条，保留按钮文案「API 生成」「确认并开始生成」，把 4 步压到 3 步。
- 列表加状态筛选：全部 / 失败 / 待制作 / 已完成。
- 顶部批量栏：生成全部待制作、生成全部缺配音、重试失败项。

### 3.5 验证

- browser-assets.mjs 按上述调整后全绿；browser-models.mjs 全绿。
- 手工：全选资产后批量复制提示词；点时间轴块定位到对应镜；生成页从卡片到发起生成只需 3 步。

## 第 4 点：图片并发（PR4）

### 4.1 现状

AssetsPage 的 execute 一次只处理一项，图片一张一张排队。

### 4.2 并发数（起步值，需联调实测，计划作者没有真实 Key 验证过限流）

| 类型 | 并发 |
|---|---|
| 图片 | 默认 3；SiliconFlow 免费渠道默认 2；设置里可调 1–5 |
| 视频 video-create（仅提交，耗时短） | 3 |
| 配音 | 2 个镜头并行，每镜内逐句串行 |
| 剧本 / 资产提取 | 1 |

### 4.3 runPool 行为（src/lib/pool.ts）

- 起步间隔错开 300ms，避免瞬时突发。
- 每项独立结果，单项失败只标红，不中断整批。
- 鉴权类致命错误（401、402、403）：立即停止派发剩余项，剩余项标为「未提交」（没发出请求，不会扣费）。
- 429：并发数减 1（最低 1）并重新排队，最多重试 2 次，退避 3s / 8s，优先使用响应头 Retry-After。
- submission_unknown、超时、5xx：不自动重试（可能已被扣费），由用户手动重试，保持「绝不静默重试付费请求」原则。
- 自动重试只写在 pool.ts 里，callApi 保持单次调用，store.test.ts 的「calls === 2」断言不受影响。

### 4.4 必须先解决的坑：revision 守卫

AssetsPage 的 patch 使用 updateProject(..., true)，每次都会 revision 加 1，而现有 current(task.revision, ...) 守卫会判定「项目已修改」并抛错。并发时第一张图完成就会让其余图片全部失败。处理：

- 批量任务的守卫改为「资产仍存在 + 固定短语或提示词未变（用提示词哈希比较）+ 图片模型设置未变」，不再比较整体 revision。
- 回写用新函数 setAssetImage(projectId, assetId, imageId)，内部调用 updateProject，并把「标记待更新」范围限定为用到该资产的镜头；invalidate 参数扩展为 `boolean | { only: string[] }`，向后兼容。
- 为该扩展补单测，防止现有调用被影响。

### 4.5 前端状态

每张图一个状态：排队（灰）→ 生成中（青，转圈 + 已用时）→ 完成（绿勾）/ 失败（红 + 一句话提示 + 「重试此项」）/ 已取消 / 未提交。

### 4.6 后端 functions/handler.ts 只改两处

1. upstreamHttp(status, paid) 增加 retryAfter 入参，upstream() 调用处传入 response.headers.get('retry-after')；Fault 增加可选的 retryAfter；failure() 把它写进响应头 Retry-After。响应体保持 `{ok:false,error:code}`，providers.test.ts 的 deepEqual 不受影响。
2. 不加服务端队列。函数本身无状态，天然支持并发，image 分支不需要改。

### 4.7 验证

- 新增 tests/pool.test.ts：并发上限、单项失败不中断、鉴权失败中止、429 降并发。
- providers.test.ts 追加「429 带 Retry-After 头且体不变」。
- 手工：6 张图并发生成，观察同时最多 3 张生成中；用错误 Key 触发 401，剩余项显示「未提交」。

## 第 5 点：生成进度提示（PR3，依赖 PR0 的 jobs.ts）

### 5.1 现状

生成时只有 toast 和 10 秒轮询，没有阶段、没有已用时、没有进度，用户只能干等。

### 5.2 统一机制

jobs.ts 记录任务；各页内联一个 ProgressPanel，全局右下角有 JobTray（手机端在底部操作栏上方）。

| 类型 | 当前在做什么 | 已完成 | 预计剩余 | 失败 | 取消 |
|---|---|---|---|---|---|
| 剧本 / 导演 | 阶段：提交 → 模型生成中（已用 12s）→ 校验结构 → 完成 | 不适用（单请求） | 无样本时显示「通常 20–60 秒（经验值）」，有样本后用平均耗时 | 红框 + ErrorNote | 在原「生成」按钮位置，旁边是「取消等待」 |
| 资产图 | 每张自己的状态（见 4.5） | 「已完成 2 / 6」 | (剩余数 ÷ 并发) × 平均耗时，取整到 5 秒；样本少于 2 个不显示 | 单张红色 + 重试；整批汇总「成功 4 / 失败 1 / 未提交 1」 | 批量栏「全部取消」；排队项直接移除，生成中项中止 |
| 分镜（本地补全 / 资产提取） | 本地补全瞬时；提取沿用剧本类阶段 | — | — | 同上 | 同上 |
| 视频 | 提交中 → 排队中 → 生成中（已用 mm:ss）→ 已完成 / 取回 | 顶部汇总「视频 4 / 10 完成 · 2 生成中 · 1 失败」 | 不给百分比：服务商不返回进度，用不确定进度条 + 已用时，提示「通常需几分钟」 | 卡片红标 + 提示 | 沿用「停止后续任务」，文案说明不取消服务商已受理任务 |
| 配音 | 「镜头 3 · 第 2 / 3 句」 | 已完成镜数 | 同资产图 | 同上 | 沿用停止标志 |

### 5.3 其他约定

- 取消文案要诚实：「取消只停止等待，服务商可能已受理并计费。」
- 有任务运行时挂 beforeunload 提示。
- 视频轮询保持 10 秒，不改接口；仅把串行查询改为 3 并发。
- ExportPage 已有阶段文案，保持不动，保留「不提供推测的总体百分比」的原则。

### 5.4 验证

- 手工：用假 route 延迟返回，检查阶段文案、已用时、取消后状态变「已取消」并带费用提醒。
- 无样本时显示经验值范围，有样本后显示预计剩余。

## 第 6 点：主题突出，次要提示收纳（PR2）

### 6.1 现状

创作区被说明、小字、提示框挤占：资产页 3 段说明，分镜页 2 大段加多行小字，生成页 notice，导出页 4 条 muted 说明和规则列表。

### 6.2 可以删除的

- App.tsx：sidebar-tip（「让想象不止停在脑海里」）、workspace-footer、帮助按钮的 toast（换成 HelpPopover）。
- 各页英文 eyebrow（YOUR CREATIVE SPACE、MAKE IT YOURS、04 / BRING IT TO LIFE）和「创作工具 · LifeHack」标签。
- 已有作品时，ProjectsPage 的 workflow-overview 四张流程卡折叠，只在首个作品之前显示。
- library-note 改为保存状态旁的悬浮提示。

### 6.3 收进折叠 / 悬浮 / 帮助入口的

- 资产页、分镜页、生成页、导出页的说明文字：统一改为标题旁的 `?` 图标，点开 Popover；长规则用 details 折叠。
- 剧本页「创作 Skill」四张卡折叠到「高级：提示词与规则」，入口接第 1 点的模板编辑器。

### 6.4 必须保留的

- storageError 警告和「尚未保存」。
- 所有付费确认弹窗中的「确认后才会调用付费 API」。
- 「模板演练 · 非 AI 生成」标签（诚实标注）。
- 视频仅内存保留、刷新需重新导入（1 行内联，并保留卡片里的「本地视频未加载，请重新选择文件」）。
- 「试听不是导出配音轨」（1 行）。
- 「配音超时会阻止导出」。
- 待更新标签。

### 6.5 布局

- 1440px：侧栏 240px，内容约 1200px。创作页分两栏：主创作区约 860px，右侧 320px 吸顶侧栏放状态、校验结果、时长表、下一步按钮。workspace-content 的 max-width 由执行者对照 globals.css 确定。
- 390px：单栏。侧栏变抽屉。步骤条压缩成当前步标题 + 圆点。主操作按钮固定在底部栏。面包屑保持单行（browser-flow.mjs 断言 `.topbar-trail > span:last-child` 高度小于 30）；.saved-label 在 390 下保持隐藏；页面不得出现横向溢出。

### 6.6 新手上手

- 每页顶部一条 NextStepBanner：「下一步：…」，由 stageStatus 计算。
- 校验问题改为可点击跳转（validateProject 的「第N镜：」前缀可解析出镜号）。
- 无 Key 时，「模板演练（免费，不联网）」升为主按钮。

### 6.7 验证

跑 browser-flow.mjs；1440 / 390 各截图一次，确认主创作区占主要位置、无横向溢出。

## 第 7 点：模型接口分组（PR1）

### 7.1 现状

SettingsPage 把 7 个 provider-panel 平铺，看不出哪个是干嘛的。

### 7.2 改法

新增 features/settings/ProviderGroups.tsx，先按任务分四张卡，再按厂商分组：

| 任务卡 | 厂商面板 | 角标 |
|---|---|---|
| 剧本 | Gemini（首选）、DeepSeek（备选）；卡头放「剧本默认模型平台」选择 | 按量付费 |
| 生图 | OpenAI、火山引擎 / 即梦 · Seedream、硅基流动 · 免费生图 | OpenAI、Seedream：按量付费；SiliconFlow：免费（「以服务商额度为准」） |
| 视频 | 火山引擎 Seedance、MiniMax 国内版；卡头放「视频默认模型平台」 | 按量付费 |
| 配音 | 引用 MiniMax | 按量付费 |

### 7.3 状态标签

沿用现有文案（Key 缺失 / 已填写 · 待验证 / 可用 / 调用失败），颜色为灰 / 灰 / 绿 / 红。需要新增 `.tag.danger`，现在只有 `.success`。卡头汇总「已就绪 n / m」。

### 7.4 为兼容 browser-models.mjs 必须遵守

- 保持 7 个 .provider-panel，每个恰好一个 .tag。
- 角标不得使用 .tag 类，另建 .badge-free / .badge-paid。
- 面板 h2 标题文字保持不变（测试按精确标题定位）。
- MiniMax 的 Key 只有一个输入，所以只在「视频」卡里渲染一个完整 .provider-panel（含配音模型字段）。「配音」卡里放一个轻量行 .provider-ref（「共用 MiniMax Key · speech-2.8-hd · 状态点」），不用 .provider-panel，不带 .tag。

### 7.5 验证

跑 browser-models.mjs；手工改 Key 看状态标签实时变化，用错误 Key 触发失败看红色标签。

## 第 8 点：其他专业建议

### 8a 资产锁定（PR7）

- 资产页「确认全部资产」后写入 Asset.locked = true 与 project.confirmed.assets。锁定的资产卡显示锁标，编辑入口变成「解锁并编辑」。
- 解锁后保存时，用扩展后的 updateProject(..., { only: shotIdsUsingAsset }) 只把用到该资产的镜头标 stale，并写 staleReason =「资产「阿青」已修改」。
- 现状问题：updateProject 的 invalidate 会把所有带视频 / 音频 / 任务的镜头全部标 stale，这是「改一个资产，全部镜头都待更新」的根源，新逻辑修正它。
- 用到资产的镜头 = assetIds 包含、references 包含，或台词说话者是它，可直接复用 assetUsage。

### 8b 剧本时长表（PR7）

- 新增 features/script/DurationStrip.tsx，放在剧本页顶部，一行 10 个格子：`1:9s 2:9s …`，末尾「合计 90 / 90」。
- 规则：单镜不在 4–15 → 红；台词所需时间 > 时长 →「不够」（黄），所需时间 = 台词总字数 ÷ (4 × 语速) + 1 秒（4 字/秒是经验常数）；总和不等于 90 → 显示差值。
- 同一组件复用到分镜时间轴和导出前检查。

### 8c 失败分级提示（PR1）

在 ApiError 上新增只读 hint，不改 message（providers.test.ts、store.test.ts 用正则断言文案，browser-models.mjs 精确断言「模型平台拒绝了此 Key，请检查密钥及账号地区。」）。ErrorNote 显示 message + 一句 hint + 动作按钮：

| 错误码 / 状态 | 一句话解决办法 | 按钮 |
|---|---|---|
| 401、provider_auth_failed、invalid_key | Key 错了：回设置页重新粘贴，并确认平台与地区 | 去设置 |
| 403、provider_forbidden | 账号没开通该模型：到官方控制台开通 | 去设置 |
| 402、insufficient_balance | 余额不足：充值后重试 | — |
| 429、rate_limited | 请求太频繁：稍等片刻，或降低并发 | 重试 |
| 404、provider_not_found | 模型已下线或 ID 写错：换一个模型 | 去设置 |
| submission_unknown、504 | 不确定是否已扣费：先查平台任务记录，别立刻重发 | — |
| 5xx、upstream_unavailable | 服务商暂时不可用：稍后重试 | 重试 |

### 8d 导出前成片检查（PR8）

- 改 ExportPage 现有的 confirm Modal，新增 PreflightDialog.tsx，数据全部来自已有的 report（inspectProject 的结果），不碰 encoder.ts。
- 内容：10 镜是否齐、每镜时长列表、总时长 vs 90、缺视频的镜头、缺配音的镜头（有台词但无音轨，且模式为 dubbing）、stale 镜头、配音超时的镜头。
- 红色项禁用确认按钮；黄色项需勾选确认。保留原勾选文案「我已检查每镜时长和音频模式，并确认以上规则」和按钮「确认并开始逐镜编码」。

### 8e 验证

- 资产锁定：解锁并保存后，只有相关镜头出现「待更新」及原因；其余镜头不变。
- 时长表：改任一镜时长，合计与差值实时变化。
- 失败分级：分别模拟 401、402、429、404，各显示对应一句话与按钮。
- 导出前检查：人工走一遍导出；确认 encoder、archive 无 diff。

## 重构顺序与验证

### 排序原则

低风险纯界面改动在前；共享件先于所有人；提示词先于流程拆分（导演步要用到模板）；改动最大的流程拆分放在倒数第二；每步改完可独立回滚。

### 顺序表

| 顺序 | 交付 | 排在这里的原因 | 验证 |
|---|---|---|---|
| PR0 | 共享件（pool.ts、jobs.ts、ApiError.hint、Ui 组件、JobTray） | 其余各点才能彼此独立 | 构建通过；全部旧测试通过；页面无肉眼变化 |
| PR1 | 第 7 点设置分组 + 第 8c 失败分级 | 纯界面，价值明显，几乎不碰逻辑 | 跑 browser-models.mjs；人工用错误 Key 触发 401 看提示 |
| PR2 | 第 6 点减负 | 纯界面；先腾出空间，后面的批量栏和进度条才有位置 | 跑 browser-flow.mjs；1440 / 390 各截图一次 |
| PR3 | 第 5 点进度与取消 | 依赖 PR0 的 jobs.ts | 假 route 延迟返回，看阶段文案、已用时、取消 |
| PR4 | 第 4 点并发 + handler.ts 两处 | 先做并发底层，批量 UI 才有东西可挂 | pool.test.ts；providers.test.ts；人工 6 张图并发，观察 429 降级 |
| PR5 | 第 3 点批量与折叠 / 抽屉 | 依赖 PR4 才能真正批量生成 | browser-assets.mjs（按风险点一节更新）；browser-models.mjs |
| PR6 | 第 1 点提示词模板 | 须先于 PR7；等「JSON 结构化提示词」子目标合并后开工 | creation.test.ts 的提示词断言全绿；新增 templates.test.ts |
| PR7 | 第 2 点流程拆分 + 第 8a 资产锁定 + 第 8b 时长表 | 改动最大，依赖 PR6 | 新增 flow.test.ts（含旧作品派生）；providers.test.ts 新 action；browser-flow.mjs 更新；旧作品打开不报错 |
| PR8 | 第 8d 导出前检查 | 依赖 8b 的 DurationStrip | 人工走一遍导出；确认 encoder、archive 无 diff |

### 回滚

- 每个 PR 单独 git revert。
- PR7 的后端 action 是新增而非替换，回滚后旧 script 路径仍可用。
- 新增的可选字段被忽略，旧数据照常加载。
- 并行说明：PR0 合并后，PR1、PR2、PR3 互不依赖，可并行；PR4 与 PR1–PR3 也无文件冲突，但都会改 AssetsPage 附近，合并时注意顺序。

## 验收标准

每点按「打开长什么样 / 点什么有什么反应 / 空状态 / 加载态 / 报错态」逐项核对。

| 点 | 打开长什么样 | 点什么有什么反应 | 空状态 | 加载态 | 报错态 |
|---|---|---|---|---|---|
| 1 模板 | 剧本页「高级」里有「提示词模板」入口，编辑器分 5 套模板 | 编辑可改块，右侧预览即时变化；点锁死块提示不可改的原因；「恢复默认」可用 | 未自定义时全部显示默认 | 预览渲染不闪烁 | 未知变量标红；视频提示词超 7000 字显示红色计数并禁止保存 |
| 2 流程 | 导航 5 步，未解锁步骤置灰 | 点灰色步骤提示「先确认：X」并带「去确认」；每步底部「确认并进入下一步」 | 导演页无剧本时显示「先完成剧本」 | 生成中用第 5 点的进度面板 | 校验失败列出具体项，点击跳转；invalid_screenplay、invalid_director 有中文提示，现有内容不被覆盖 |
| 3 批量 | 资产为缩略图墙 + 批量栏；分镜为折叠行 + 顶部时间轴；生成页为列表 + 右侧抽屉 | 全选后可批量生成、复制；点缩略图开 Lightbox，左右键切换；点时间轴块定位到对应镜 | 无资产时有「批量导入 / 创建第一项」按钮 | 缩略图读取中有占位 | 批量导入的重名、格式错误在预览中标出 |
| 4 并发 | 批量生成时同时最多 3 张「生成中」 | 单张失败不影响其他；「重试失败项」可用 | — | 每张独立转圈与已用时 | 401 时剩余项显示「未提交」；429 时并发自动降低并提示 |
| 5 进度 | 每类生成都有阶段文案、已用时、取消按钮 | 取消后状态变「已取消」并有费用提醒 | — | 无样本时显示经验值范围，有样本后显示预计剩余 | 失败有红色状态 + 一句话提示 + 重试 |
| 6 减负 | 主创作区占主要位置，说明收进 `?` | 点 `?` 展开说明；折叠区默认关闭 | — | — | storageError 等必留警告仍可见；390 下无横向溢出 |
| 7 设置 | 四张任务卡，卡内按厂商分组，带「免费」「按量付费」角标 | 改 Key 后状态标签实时变化 | 全部为「Key 缺失」（灰） | — | 「调用失败」为红，并显示分级提示 |
| 8 其他 | 资产有锁标；剧本页顶部有时长行；导出前弹检查清单 | 解锁并保存只标记相关镜头；红色项禁用导出 | 无资产、无镜头时给出去向 | — | 超时、缺配音、缺视频逐项列出 |

## 不能动的东西

- 五步流程的大方向：本计划只是把它落成界面，不增减环节。
- 所有 callApi、callBinary 契约：请求体字段、`{ok,data}` 信封、submission_unknown 语义、绝不静默重试付费请求。handler.ts 的 ACTION_FIELDS 严格校验、SSRF 与媒体主机白名单、既有 5 个 action 的 schema 都不改。
- 本地存储：manju-studio-v1、version: 1、IndexedDB 媒体库；Key 仅内存、视频不落盘。第 0.2 节的 4 个可选字段是仅有的增量。
- 导出与 FFmpeg：encoder.ts、archive.ts、inputs.ts、timeline.ts，720×1280 / 24fps 规则；ExportPage 只改外围界面。
- 正在进行的两个子目标：JSON 结构化提示词，以及画幅 / 分辨率（video-create 里的 720p、768P、9:16 以及导出尺寸）。改 prompts.ts 与 handler.ts 前先对齐它们的分支。

## 风险点与受影响的测试

### 单元测试（node --test）

- creation.test.ts
  - 断言提示词含「没有挂载参考图」「开场：月下门前」「图1：参考图」「重点执行动作」「不生成可辨识人声」「缺失：未关联场景」，以及三视图相关短语。这些必须保留在锁死块里。
  - scriptPrompt 必须仍含「总计90秒」和各 Skill 模板。
  - templateScript 若改成只出剧本层字段，「校验通过」的断言要更新。
- providers.test.ts
  - 新增的 screenplay、director action 对 seedream 等错误 provider 也要返回 invalid_provider，否则会被「拒绝错误 provider」那组循环抓到。
  - 错误体 `deepEqual({ok:false,error})` 不能加字段，Retry-After 只能走响应头。
- store.test.ts：新增字段必须是可选；restored.projects deepEqual saved.projects 不能变；duplicateProject 要同步处理新增字段的引用。
- 需新增：pool.test.ts、templates.test.ts、flow.test.ts；providers.test.ts 追加新 action 与 Retry-After 用例；updateProject 的 invalidate 扩展单测。

### 浏览器测试（需 Edge 与 127.0.0.1:5173）

- browser-flow.mjs
  - 剧本页改成节拍后，.shot-card 数量为 10 的断言需调整。
  - 流程多了导演步，「下一步：分镜编排」之前要先走导演确认。
  - 按钮文案「模板演练」「建立模板草稿（非AI）」「AI 生成剧本」「预览并确认对应关系」「确认对应并保存补全」「下一步：视频生成」尽量保留。
  - .generation-card、「查看第10镜视频详情」、「API 生成」要保留。
  - 390 下面包屑高度（小于 30）和 .saved-label 隐藏的断言要保持。
- browser-assets.mjs
  - 分镜折叠后，「复制人物 / 场景 / 道具提示词」各 10 个按钮的 waitFor 要先展开。
  - main input[type=file] 必须为 0。
  - .compact-media-thumbnail 高度不超过 150。
  - calls.length 的计数断言：批量功能不能在单张流程里偷发请求。
  - 生成页 region「本镜图片交接」、article 数 4、「第1镜视频播放器」、外部 video[controls] 为 0，Drawer 化后要保持。
- browser-models.mjs
  - 设置页 7 个 .provider-panel .tag、面板标题精确匹配。
  - 生图、视频 combobox 的 name 与 optgroup 标签。
  - 「当前生图渠道」文本含模型名（若删「免费兜底暂未配置」则同步改断言）。
  - 状态文案「已填写 · 待验证」「可用」「调用失败」「Key 缺失」。
- browser-recovery.mjs：「结果未知 · 请检查原平台」「当前修改尚未保存」「尚未保存」「已停止覆盖保存」，以及视频提示词含「后期配音模式」的断言。
- browser-media.mjs、media.test.ts：计划作者未读到，PR2、PR8 动导出页外围时，执行者先通读再跑。

### 其他风险

- globals.css 里相关选择器的样式计划作者没看到，改版前先把它们列成清单，避免误删共用类。
- 并发与 revision 守卫的竞态：第 4 点 4.4 已给方案；updateProject 的 invalidate 参数扩展要有单测，防止现有调用被影响。
- 视频提示词 7000 字上限：风格块展开后容易超，必须有计数与截断提示。
- prompts.ts、handler.ts 与另外两个子目标的合并冲突。

# 漫剧工坊 · 接手指南

更新时间：2026-11-21。项目目录：`F:\AIGC\manju-gongfang`。目标公开仓库：`Dline666/manju-gongfang`，分支 `main`。

本轮只做 Git、交接文档、构建测试及发布材料检查，**没有改业务功能，没有发布 Qoder Sites，没有调用真实收费模型**。

Git 状态（2026-11-22）：已通过本机认证的 gh CLI 创建公开仓库 [Dline666/manju-gongfang](https://github.com/Dline666/manju-gongfang)，并成功推送 `main`，本地已跟踪 `origin/main`。初始源码交接提交为 `62ace99`；此前仓库创建受阻已解决。GitHub 源码推送不等于 Qoder Sites 发布。

详细现状及下一轮需求以 [漫剧工坊-交付文档.md](漫剧工坊-交付文档.md) 为准；原 starter README 不是本项目最新验收结论。

## 1. 本地运行（Windows CMD，两个终端）

Node 要求：`^22.13.0` 或 `>=24.0.0`。Function 使用 Deno 2.9.6；未全局安装可使用下面的 npm exec 命令。GitHub 克隆到其他位置时自行调整路径。

首次安装依赖，并为本地运行恢复 FFmpeg 文件：

```cmd
cd /d "F:\AIGC\manju-gongfang"
npm ci
copy /Y "node_modules\@ffmpeg\core\dist\esm\ffmpeg-core.js" "public\ffmpeg\ffmpeg-core.js"
copy /Y "node_modules\@ffmpeg\core\dist\esm\ffmpeg-core.wasm" "public\ffmpeg\ffmpeg-core.wasm"
```

FFmpeg 运行文件来自锁定的 `@ffmpeg/core` 0.12.10。公开仓库仅保留其许可证、来源和构建说明，不分发这两个编译运行文件；以上步骤供本地运行，**不能替代公开分发前的许可证及对应源码核查**。现有本机文件不需要重复复制。

终端一：前端 5173。

```cmd
cd /d "F:\AIGC\manju-gongfang"
npm run dev -- --port 5173 --strictPort
```

打开 `http://127.0.0.1:5173/`。

终端二：Function 8000。

```cmd
cd /d "F:\AIGC\manju-gongfang"
npm exec --yes --package=deno@2.9.6 -- deno run --allow-net dev/function-local.ts
```

全局已有 Deno 时也可用 `npm run dev:function`。Vite 将 `/functions/v1/app` 同源代理到 `127.0.0.1:8000`。

验证代理和健康接口：

```cmd
curl "http://127.0.0.1:5173/functions/v1/app?action=health"
```

应返回 `{"ok":true,"data":{"status":"healthy"}}`。健康检查不调用模型，也不证明模型 Key 有效。修改 Function 后需重启终端二，前端刷新不等于后台重启；已有端口占用时先确认进程，不直接结束未知程序。

## 2. 构建与测试

```cmd
cd /d "F:\AIGC\manju-gongfang"
npm run build
npm test
npm exec --yes --package=deno@2.9.6 -- deno check functions/index.ts
```

本次交接实测：`npm run build` 通过，`npm test` **162 项通过、0 失败、0 跳过**（2026-11-23 第三轮「真实剧本」改造后复跑）。构建包含 TypeScript 检查。Function 的 Deno 检查已通过（`deno check functions/index.ts`，EXIT=0）。

如需浏览器回归，先启动上述两个服务，再运行：

```cmd
npm run test:browser
node tests/browser-assets.mjs
node tests/browser-models.mjs
```

此前已在 Edge 的 1440px / 390px 视口通过；本轮只重跑构建和单元/契约测试。浏览器脚本使用本机 Edge 安装路径，更换机器需核对路径；测试 API 请求被拦截，不产生真实付费调用。

`npm run test:media` 是额外的真实编码专项，需要本机 `dev/test-voice.wav`。音频夹具、测试 MP4/ZIP 和截图不提交 Git；新克隆没有这些文件，不能直接声称媒体专项可运行。此前已验证 90 秒、720×1280、H.264/AAC 带中文配音成片，本轮未重跑编码专项。

## 3. 当前已经完成

- 本地作品库、剧本生成/导入/模板演练、资产、分镜、视频/配音、预览与 MP4/素材 ZIP 导出；默认空作品库。
- **剧本步骤产出的是一份完整 Markdown 剧本**（四部分结构：核心前提／黄金3秒钩子／三幕结构／结尾卡点 → 场景因果节拍表 → 世界观与人物关系 → 标准漫剧剧本正文），镜头由前端确定性解析器从剧本拆出；「10 拍 / 90 秒」硬约束已退休，镜数与总时长由剧本决定。剧本页不再有逐拍编辑卡片区，改为「剧本全文 + 保存并重新拆镜」。
- 四类资产编辑；人物三视图提示词；图片及视频紧凑卡片和详情；人物/场景/道具固定短语与逐镜三类提示词。
- 手动视频制作可复制真实参考图片、下载原图并单独复制视频提示词；保留顺序、首尾帧角色，缺失/损坏图片不冒充完整交接。
- MiniMax 已替换为国内版 `api.minimax.cn`，不留国际选项。视频 H3 V2 创建/查询/下载及配音适配已实现。
- 生图按 OpenAI、火山引擎/即梦 Seedream 分组；视频含 Seedance 2.5、2.0、2.0-fast（新配置默认）、2.0-mini、MiniMax H3。选择值实际进入请求，保留自定义模型 ID。
- 渠道状态区分 Key 缺失、待验证、可用、调用失败。Key 和状态仅存内存，换 Key 不继承旧验证结果；免费自动兜底已由用户明确暂缓，不自动切换其他收费渠道。
- 任务 ID/文字存本地；未知提交不自动重发；刷新恢复、异步版本校验、存储错误提示。视频只在会话内存，刷新后上传视频需重选。

接口契约测试不等于真实供应商账号、余额、模型权限和任务完成均已验证。

## 4. 明确未完成（用户列举的内容实际为四项）

1. **真实收费 API 未验收**：没有使用真实 Key 完成双视频供应商及配音端到端验收；必须经用户明确生成确认，不擅自收费。
2. **五份文档未按原计划拆分**：当前是剧本文档、资产设定、分镜文档、生成提示词、制作清单；图片与视频提示词尚未各自独立。详见交付文档第 3 节。
3. **FFmpeg 许可证核查未完成**：保留了现有许可证及来源材料，但与二进制匹配的完整对应源码、构建材料及应用许可兼容性尚未核查完毕。wrapper 的 MIT 不能代替 core 的 GPL 义务。详见 [来源和许可证说明](public/ffmpeg/SOURCE-AND-LICENSE.txt)。
4. **Qoder Sites 未发布**：只有本地描述符及构建产物，没有 `published: true` 验证，也没有已验收的公网入口。

## 5. 剧本层的后续方向

**五步流程已经实现**（PR7 / `8ed56ad`：剧本 → 资产 → 导演分镜 → 分镜 → 视频，各步带门禁与指纹失效）。交付文档第 10 节「尚未修改代码」是 2026-11-21 的状态，已过时。

剧本层在 2026-11-23 第三轮已改为产出真实剧本（见交付文档第三轮变更）。后续若继续动剧本层，注意：

- 剧本是**唯一事实来源**：镜头由 `src/features/script/screenplay.ts` 解析得到，不要再让模型另外报一份镜头清单。
- 剧本正文里的 `【镜头：类型】` 是编剧的画面意图，落到 `Shot.cameraHint`；导演层负责把它落实为 `shotSize`／`movement`／`angle`。两者不要合并成一个字段。
- 「10 拍 / 90 秒」已退休：镜数由剧本决定、每镜 0.5–30 秒（0.5 秒整数倍）、总时长 20–400 秒。旧的 10 镜门禁不要再加回来。
- 视频生成按镜计费，镜数由剧本决定会直接影响真实成本——任何改动都要连带评估费用变化。

仍然成立的约束：

- 先完成人物、场景、道具、音色资产，再允许生成导演分镜脚本。
- 人物继续三视图，场景/道具继续生图，固定短语逐字复用。
- 音色在资产阶段仅保留描述、语速、语气和人物绑定，不要求音频文件；不要删除现有后期配音和带声导出。
- 当前图片在 IndexedDB，并无公网地址；不能把 `imageId`、过期 `blob:` 或虚构 URL 当作永久外链，也不能擅自上传私人图片或开云存储。
- 任何改动都必须处理旧存档兼容、上游修改失效、复制/删除引用、缺失图片与直接路由的前置检查，不能只改导航名称。

不要借此重构其他业务、开启免费兜底、修改部署或消耗真实模型额度。

## 6. Git 提交范围与本地数据

提交：业务源码、starter UI/样式及来源许可、配置和构建脚本、`package.json`/`package-lock.json`、`tests/`、`dev/function-local.ts`、`functions/`、`public/ffmpeg/` 的许可证/来源文本、站点描述符、两份交接文档。

不提交：API Key、`.env*`、私钥、用户作品/导入媒体、`node_modules/`、`dist/`、测试截图/音频/视频/ZIP、FFmpeg 编译运行文件、工具缓存。使用 `.gitignore` 排除，并在首次推送前检查实际待提交内容。

用户作品位于浏览器 localStorage/IndexedDB，不随源码迁移；不要为交接导出或上传浏览器个人数据。`dist` 在本机由构建生成，不提交仓库；GitHub 是源码交接，**不是 Qoder 网站上线**。详细交付文档中指向本机测试媒体的链接，在新克隆中不会有对应文件，这是有意排除。

## 7. 回到 Qoder 后的发布步骤（本轮不执行）

本轮本地检查：

| 材料 | 状态 |
| --- | --- |
| `dist/index.html` 及静态资源 | 已通过本轮构建生成；本机有 FFmpeg JS/WASM，不等于获准公开分发 |
| `functions/index.ts` + `functions/handler.ts` | 均存在；入口引用同目录 handler，handler 无外部包导入，可独立作为 app Function |
| `.漫剧工坊.qoder.site` | 存在、JSON 有效，version 1，包含名称与设计记录；没有 publication 记录 |

**目录材料齐全不等于发布条件全部完成；FFmpeg 核查和真实接口验收仍未完成。**

回到 Qoder 原项目目录后：

1. 先解决 FFmpeg 公开分发核查等阻塞；在新克隆恢复本地 FFmpeg 文件，运行构建、测试和 Function 检查。保留现有描述符，不手写云资源/发布 ID。
2. 加载当前 Sites 发布工具流程，读取本地/云端实际绑定；复用可验证的站点身份，不因只有设计描述符就猜测已有云站点或重复创建。
3. 检查发布包没有 Key、用户数据和测试媒体。准备 `projectRoot=当前项目目录`、`webDirectory=dist`、`functionDirectory=functions`，使用独立 `app` Function；**不要用项目根目录作为 webDirectory，不上传整个根目录，不把 Git 仓库当发布包。**
4. 执行受支持的 `prepare_site`，处理真实就绪阻塞，再执行 `publish_site`；保存工具返回的同一 action，核验 `get_publish_status.published === true`。上传成功、ready 或 canPublish 不等于已经发布。
5. 检查目标访问权限，验证线上页面、刷新/路由和同源 `/functions/v1/app?action=health`；模型调用只在用户有 Key 且明确确认生成时进行。线上健康不代表付费模型验收通过。
6. Desktop 使用同一 action 的 `show_publish_confirmation` 交付；更新文档为实际发布状态和验证结果，而不是预先宣称上线。

本轮未调用 prepare/publish，不分配云资源、不改变访问权限、不上传网站发布包。

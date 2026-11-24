# 自定义模型端点与可删除的平台清单 · 设计稿

日期：2026-11-24
状态：待批准（第 2 版，已并入独立评审的 5 项阻断级修正与 11 项补充）
关联需求：「模型平台太少，要能填自定义 API Key + Base URL；平台默认的 API 可以删除」

---

## 1. 意图与背景

现状：模型平台是写死的 7 个（Gemini / DeepSeek / OpenAI / Seedream / SiliconFlow / Seedance / MiniMax）。

- 前端 `src/lib/models.ts:10,25` 硬编码生图、视频两份模型下拉清单；`src/features/settings/ProviderGroups.tsx:10-22` 硬编码三组平台卡片。
- 后端 `functions/handler.ts:20-31` 的 `ENDPOINTS` 写死 10 个 URL，按 `provider` 白名单分派（`:613` 文本、`:649` 生图、`:663`/`:674` 配音、`:692` 视频）。
- 模型 ID **在前端**可自由填（设置页输入框 + 下拉里的「自定义 · xxx」），**后端仍按平台正则白名单校验**（`handler.ts:619,626,640,651,654`），填错即 `invalid_model`。
- Key 只在内存（`src/store/studio.ts:101-111` 的 `emit(false)` + `emit()` 剥离 `keys`），刷新即失；`baseUrl` 属作品级配置，可安全落盘。

目标：让用户能接入自己的任意 OpenAI 兼容服务（中转站、代理、自建网关），并把用不上的内置平台删掉。

已确认的两个决策（用户拍板）：

1. **自定义端点覆盖「剧本 + 生图」**（OpenAI 兼容协议）；视频与配音仍走内置专用平台。
2. **内置平台变成可删除条目**：可删、可恢复；再加自定义端点条目。

---

## 2. 目标 / 非目标 / 反目标

### 目标

- G1 任何 OpenAI 兼容服务（`{base}/chat/completions`、`{base}/images/generations`）可作为剧本与生图的端点。
- G2 内置平台与自定义端点在设置页是**同一份清单**，都可删除；内置的可一键恢复。
- G3 旧存档零人工迁移：内置端点的 id 沿用现有 provider id，旧存档自动补齐端点清单。
- G4 后端对用户提供的 Base URL 做**字符串 + DNS 双层**安全校验（fail-closed）。
- G5 Key 仍然不落盘；只有 Base URL、端点名称、模型 ID、能力勾选落盘。

### 非目标（本轮不做）

- N1 视频/配音的自定义端点适配器（火山 Seedance、MiniMax 各自一套协议，没有通用标准）。
- N2 Anthropic Messages API 等非 OpenAI 协议族。
- N3 端点配置的云端同步、团队共享、密钥托管。
- N4 把内置平台实现细节改成插件化。

### 反目标（做了就算失败）

- A1 为了接自定义端点而放宽后端的 URL 安全校验。
- A2 **Key** 绝不落盘、不进作品存档、不进导出文档、不进日志。
  （澄清：**Base URL 允许进作品存档的 settings**，但不得进导出文档与日志。导出 manifest 只含 project id/name/revision、target、rules、shots、images、files（`src/lib/media/archive.ts:132-140`），本就不含 settings。）
- A3 让用户能选到一个没有 Key 的端点却照样发起付费调用。
- A4 改坏既有内置平台的调用路径（Gemini / DeepSeek / OpenAI / Seedream / SiliconFlow / Seedance / MiniMax 全部回归验证）。
- A5 自定义端点缺模型 ID 时发出带默认模型名的付费请求。

---

## 3. 方案与取舍

考虑过三条路子，用户已选定第 2 条。

### 方案 A：单条固定「自定义」端点

`Provider` union 加一个 `'custom'`，`settings` 加一个 `customBaseUrl`。改动最小，但只能有一条自定义端点；当用户把内置平台删光时无处可退，也无法同时接入两个中转站。

### 方案 B：统一「端点清单」模型（**选定**）

所有平台与自定义服务统一成 `Endpoint` 记录；`settings.endpoints` 是用户当前可见的清单；内置端点目录是代码常量，随时可恢复。代价是把 `provider` 从固定 union 变成动态 id，涉及前端十几处引用与后端协议映射。

### 方案 C：端点全插件化（协议处理器注册表）

每个协议一个处理器，后端按 `protocol` 注册分发。扩展性最好，但本轮只有一种新协议（OpenAI 兼容），写注册表是过度抽象。

### 为什么选 B

- 「可删除条目」这个诉求本身就是清单模型，A 满足不了。
- B 让内置与自定义在 UI、存档、调用链上完全同构，后续加协议只加一条端点记录。
- 迁移成本可控：内置端点 id = 现有 provider id，旧存档的 `models`、`scriptProvider` 等字段可直接映射成端点 id。

---

## 4. 数据模型

### 4.1 端点

```ts
export type ProviderProtocol =
  | 'gemini' | 'deepseek' | 'openai' | 'seedream' | 'siliconflow'
  | 'seedance' | 'minimax' | 'openai-compatible';

export type Capability = 'script' | 'image' | 'video' | 'speech';

export interface Endpoint {
  id: string;              // 稳定 id；内置端点沿用旧 provider id；自定义端点 id 不得含 ':'
  name: string;            // 显示名
  protocol: ProviderProtocol;
  baseUrl?: string;        // 仅 openai-compatible 使用
  capabilities: Capability[];
  builtin?: boolean;       // 内置端点标记（用于「恢复」分区）
  defaultConcurrency?: number; // 内置端点的生图并发默认值（见 S2）
}
```

### 4.2 内置端点目录（代码常量，单一来源）

平台清单目前散落三处（`ProviderGroups.tsx:10-22`、`models.ts:10-35`、`handler.ts:20-31`），本轮把**协议、默认模型 ID、默认并发、展示名、能力**集中到这一张目录里，其余派生。

| id | name | protocol | capabilities | 默认模型 ID |
|---|---|---|---|---|
| `gemini` | Google Gemini | gemini | script | gemini-4-hydrogen |
| `deepseek` | DeepSeek | deepseek | script | deepseek-flash |
| `openai` | OpenAI | openai | image | gpt-image-2.6-sunburst |
| `seedream` | 火山引擎 / 即梦 · Seedream | seedream | image | doubao-seedream-5-5-261028 |
| `siliconflow` | 硅基流动 SiliconFlow（免费） | siliconflow | image | Kwai-Kolors/Kolors（并发 2） |
| `seedance` | 火山引擎 Seedance | seedance | video | doubao-seedance-2-0-fast-260128 |
| `minimax` | MiniMax 国内版 | minimax | video, speech | MiniMax-H3（视频）；配音模型仍是全局 `settings.speechModel` |

### 4.3 设置

一个端点可能同时承担剧本与生图，两个模型 ID 不同，所以**模型 ID 按能力分键**：

```ts
export interface Settings {
  scriptProvider: string;      // 端点 id
  imageProvider: string;       // 端点 id
  videoProvider: string;       // 端点 id
  endpoints: Endpoint[];       // 用户当前可见的端点清单
  models: Record<string, Partial<Record<Capability, string>>>; // 端点 id → 能力 → 模型 ID
  speechModel: string;         // MiniMax 配音模型（保持不变）
  imageConcurrency?: number;
  customJsonMode?: boolean;    // 自定义文本端点是否发 response_format，默认 true
}
```

例：`models = { gemini: { script: 'gemini-4-hydrogen' }, 'custom-abc': { script: 'qwen-max', image: 'flux-1' } }`。

`StudioState.keys` 与 `providerStatus` 的键从 `Provider` 放宽为 `string`（端点 id）。

### 4.4 存档迁移

**硬约束（实测确认）**：`src/store/schema.ts:3` 现为
`z.record(z.enum([...7 个...]), z.string())`。zod v3.25.76 下，只要 `models` 里出现任何 enum 之外的键（自定义端点 id），**整份存档 parse 失败** → `studio.ts:45` 触发 → 全部作品不可读且停止保存。因此放宽键是**必须项**，不是优化。

改动清单：

- `src/store/schema.ts:3` — `models` 键放宽为 `z.string()`；值改为 `z.record(z.enum(['script','image','video','speech']), z.string()).optional()` 的部分映射。
- `src/store/schema.ts:15` — `settings.scriptProvider` / `imageProvider` / `videoProvider` 从 `z.enum([...])` 放宽为 `z.string()`（`imageProvider` 保留 `.default('openai')`）；新增 `settings.endpoints`（可选数组）；新增 `settings.customJsonMode`（可选 boolean）。
- `src/domain/types.ts:72-73` — `Settings` 的三个内联 union 放宽为 `string`，`models` 类型同步。

迁移逻辑（新增 `migrateSettings(settings)`，放在 `src/lib/endpoints.ts`，与 `migratePromptConfig` 同类先例）：

1. `endpoints` 缺失 → `builtinEndpoints()` 全量。
2. `models` 仍是旧的扁平 `{providerId: modelId}` → 按内置目录的能力映射成 `{providerId: {capability: modelId}}`（gemini→script、openai→image、seedance→video、minimax→video）；已是新结构的原样保留。
3. 各步骤选择的值若是未知端点 id → 回落到该步骤的默认内置端点。
4. `models` 里属于已删除端点的条目**保留**（见下）。

**模型 ID 不随端点删除而丢失**：`models` 与 `endpoints` 是两份独立数据。删除端点只从 `endpoints` 数组移除条目，**不动 `models[id]`**；恢复时端点回来、用户改过的模型 ID 也回来。实现时禁止在删除动作里顺手清 `models[id]`——否则下次载入时 schema 的默认值合并会把它静默填回默认值，用户改过的模型 ID 丢失。

### 4.5 默认值工厂

`defaultSettings` 里的 `endpoints` 不能是模块级共享数组常量：`studio.ts:43` 是浅拷贝 `{...defaultSettings, ...data.settings}`，任何就地 `push/filter` 会污染模块默认值并波及所有新会话。故导出工厂函数 `builtinEndpoints(): Endpoint[]`（同理 `defaultModels()`），`defaultSettings.endpoints = builtinEndpoints()` 仅作为初始值。

---

## 5. 前端改动

### 5.1 类型收窄点清单（必须一并改）

| 位置 | 现状 | 改法 |
|---|---|---|
| `src/domain/types.ts:1` | `Provider` 固定 union | 拆成 `ProviderProtocol`（协议）与 `Endpoint`（记录）；`Provider` 保留为协议 union 供后端契约使用 |
| `src/domain/types.ts:72-73` | `Settings` 三个内联 union + `models: Record<Provider,string>` | 见 §4.3 |
| `src/features/script/ScriptPage.tsx:18` | `Confirmation.provider: 'gemini'\|'deepseek'` | `provider: string`（端点 id） |
| `src/features/director/DirectorPage.tsx:16` | 同上 | 同上 |
| `src/features/assets/AssetsPage.tsx:24` | `Pending.provider: 'openai'\|'seedream'\|'siliconflow'` | `provider: string` |
| `src/features/assets/AssetsPage.tsx:83` | `extraction.provider: 'gemini'\|'deepseek'` | `provider: string` |
| `src/features/generation/GenerationPage.tsx:94` | `BatchConfirmation.provider: 'seedance'\|'minimax'` | `provider: string` |
| `src/store/schema.ts:3,15` | 四处 zod enum | 见 §4.4 |

`src/domain/validation.ts` 逐行确认**没有任何 provider 约束**（只校验镜头/资产结构、时长、引用关系）→ **无需改动**。

`src/domain/types.ts:15` 与 `src/store/schema.ts:5` 的 `task.provider: z.enum(['seedance','minimax'])` **保持不变**（视频/配音本轮不开放自定义端点，历史任务语义不变）。

### 5.2 调用链与记账闭环

```ts
export function credentials(endpointId: string) {
  const state = getStudio();
  const endpoint = state.settings.endpoints.find(e => e.id === endpointId);
  if (!endpoint) throw new ApiError('missing_endpoint');
  const key = state.keys[endpointId];
  if (!key) throw new ApiError('missing_key');
  const capability = ...; // 调用方指定
  return {
    endpointId,                       // 本地记账用，请求前删除
    provider: endpoint.protocol,      // 发给后端的协议名
    key,
    model: state.settings.models[endpointId]?.[capability],
    ...(endpoint.baseUrl ? { baseUrl: endpoint.baseUrl } : {}),
  };
}
```

**契约（避免状态写不进去或互相覆盖）**：

- 请求体里的 `provider` = 协议（后端只认协议）；`endpointId` = 端点 id（本地记账），`request()`（`src/lib/api.ts:52`）**对所有 action** `delete body.endpointId`（漏删任一 action 都会被后端 `fields()` 以 `invalid_input` 拒绝）。
- `providerCallStatus()`（`api.ts:66-76`）一律以 `endpointId` 为键调用 `setProviderStatus`。
- `state.keys` 与 `state.providerStatus` 一律以 `endpointId` 为键；`setKey` / `setProviderStatus` 入参改为 `string`。`setProviderStatus` 内比对 `state.keys[endpointId] !== usedKey` 的逻辑保持。
- 若沿用旧写法（用协议名当键），多个自定义端点会共用 `'openai-compatible'` 一个状态槽，且 `state.keys['openai-compatible']` 不存在 → 状态永远写不进去。**这是必须避免的写法。**

### 5.3 设置页（`ProviderGroups.tsx` 重写）

- 四个分组（剧本 / 生图 / 视频 / 配音）保留，面板来自「按 capability 过滤 `settings.endpoints`」动态生成。
- 每个端点卡片：名称、协议标签、状态标签、API Key 输入、模型 ID 输入；自定义端点额外有 **Base URL**、文本模型 ID、生图模型 ID、JSON 模式开关。
- 每张卡片右上角「删除」；删除带 video/speech 能力的端点时提示「删除后无法用 API 生成视频/配音，仍可手动导入素材」。
- 顶部「添加自定义端点」：新增一条 `openai-compatible` 端点（名称、Base URL、文本/生图模型 ID、能力勾选）。
- 底部折叠区「已删除的内置平台」：逐条「恢复」。
- 三个「默认平台」下拉改为按 capability 过滤的端点列表（含自定义端点）。
- 删除正在使用的端点时：自动把对应步骤改选为同组其他端点；同组无端点则该步骤留空并提示「请先添加或恢复一个端点」。
- 端点 id 一律不含 `:`（现有 select 用 `${provider}:${model}` 编码并 `split(':')` 解构，见 `AssetsPage.tsx:395`、`GenerationPage.tsx:183`）。

### 5.4 模型清单与并发

- `src/lib/models.ts` 的 `imageModelGroups` / `videoModelGroups` 写死「provider → 模型清单」，与新模型冲突：
  改为按端点的推荐模型清单（内置端点沿用现有清单，自定义端点为空数组，只有用户在设置页填的自由文本模型 ID），生图/视频下拉按「先按 capability 取端点 → 再取该端点的模型清单 + 自由文本模型 ID」渲染。
- `imageConcurrency()`（`models.ts:5`）的 `settings.imageProvider === 'siliconflow' ? 2 : 3` 改为查端点记录上的 `defaultConcurrency`。

### 5.5 硬编码 provider 文案全清单

| 位置 | 现状 |
|---|---|
| `src/features/script/ScriptPage.tsx:160` | `scriptProvider === 'gemini' ? 'Gemini' : 'DeepSeek'` |
| `src/features/script/ScriptPage.tsx:162` | 「尚未配置剧本 API Key」 |
| `src/features/assets/AssetsPage.tsx:140 / 219 / 228` | 「请先在设置页填写 OpenAI/Seedream/SiliconFlow API Key」（三处重复） |
| `src/features/assets/AssetsPage.tsx:393` | 资产提取区的平台名三元 |
| `src/features/assets/AssetsPage.tsx:395` | 生图下拉 + 「当前生图渠道：」 |
| `src/features/assets/AssetsPage.tsx:440` | 批量生图渠道文案 |
| `src/features/assets/AssetsPage.tsx:463` | 待确认弹窗的「服务：…」 |
| `src/features/assets/AssetsPage.tsx:147 / 150 / 157 / 197` | 音色相关的 `'minimax'` 硬编码 |
| `src/features/generation/GenerationPage.tsx:156 / 171` | 视频/配音分流的 `'minimax'` 硬编码 |
| `src/features/settings/ProviderGroups.tsx:10-22 / 48 / 66 / 69 / 77` | 卡片常量表、配音模型 ID 字段、三个固定下拉 |
| `src/features/settings/SettingsPage.tsx:8` | 「密钥不写进作品，也不保存到磁盘」「只保存必要的创作数据」——Base URL 落盘后需更新措辞 |
| `src/lib/models.ts:5` | 并发默认值判断 |

统一改法：查端点记录拿 `name` 与模型 ID。

**文案要分两种状态**（`ScriptPage.tsx:162`、`AssetsPage.tsx:140/219/228`）：「没有可用端点」（该步骤一个端点都没有）与「端点没填 Key」是两回事，提示不能混。

### 5.6 「设置已改变」判定

`AssetsPage.tsx:175` 的 `getStudio().settings.imageProvider !== task.provider` 改按端点 id 比较——否则两个协议相同的自定义端点会互相「顶掉」判定。

---

## 6. 后端改动（`functions/handler.ts`）

### 6.1 请求契约

- `ACTION_FIELDS`（`handler.ts:39-52`）：`screenplay` / `director` / `extract-characters` / `extract-scenes` / `extract-props` / `image` 增加允许字段 `baseUrl`。
- provider 白名单新增 `'openai-compatible'`，两处：
  - 文本 `handler.ts:613`（`provider === "gemini" || provider === "deepseek"`）；
  - 生图 `handler.ts:649`（`provider === "openai" || provider === "seedream"`，siliconflow 分支在其之前 `:638`）。
  - 同一协议名在两个 action 下行为不同：文本走 `/chat/completions`，生图走 `/images/generations`。
- 鉴权头无需改动：`handler.ts:438` 非 Gemini 一律 `Authorization: Bearer ${key}`，OpenAI 兼容协议正好符合。

### 6.2 Base URL 校验（双层，fail-closed）

**第一层：字符串判定**，复用 `publicUrl()`（`handler.ts:359-370`）口径：

- 必须 `https:`；
- 拒绝用户名/密码、hash、**非默认端口**（实测 `https://x.com:443` 因 URL 规范归一而放行，`https://x.com:8443` 被拒）；
- 主机必须是含点的域名（拒绝 IP 字面量），拒绝 `localhost` / `local` / `internal` / `lan` / `home` / `test` / `invalid` 后缀；
- **额外要求**：不含 query string（`publicUrl()` 不拦 query，而 query 会让路径拼接出错）。

**第二层：DNS 判定**（`publicUrl()` 完全没有，必须补）：

- `resolveHost(host)` 解析 A/AAAA 记录；
- 全部记录必须 `publicIp()` 为真（`handler.ts:393-405`）；
- 解析失败、无记录、任一记录非公网 → 一律判 `invalid_base_url`。

只做字符串判定挡不住「公网域名解析到 127.0.0.1 / 10.x」，也挡不住 DNS rebinding——这是兑现 A1「不放宽 URL 安全校验」的唯一动作。仓库里 `publicIp()` + `resolveHost()` 已有先例（`handler.ts:510-511` 的 `download()` 用），此处照用。

**URL 归一**：去掉尾部 `/`；base 视为 API 根，最终拼 `{base}/chat/completions` 与 `{base}/images/generations`。用字符串拼接而非 `new URL(相对路径, base)`（后者会丢弃 base 的 path）。

> 取舍：沿用现有口径意味着**带非默认端口的自建服务不被支持**。这是刻意的 fail-closed 选择。

### 6.3 文本（OpenAI 兼容）

`POST {baseUrl}/chat/completions`

```jsonc
{
  "model": "<用户填的模型 ID>",
  "stream": false,
  "response_format": { "type": "json_object" },   // 仅当 customJsonMode 为真
  "messages": [
    { "role": "system", "content": "<后端机器契约 instruction>" },
    { "role": "user",   "content": "<用户提示词>" }
  ]
}
```

- 响应按 DeepSeek 分支同款解析（`handler.ts:630-633`）：`choices.length === 1`、`finish_reason === 'stop'`、`choices[0].message.content` → 既有 `validate*` 函数校验。
- `response_format` 受 `customJsonMode`（默认开）控制：老中转站不支持时用户可关掉，只靠 system 指令约束 JSON。
- 不做自动重试（可能计费）。
- **模型 ID 规则**：`/^[A-Za-z0-9._:\/-]{1,128}$/`（允许 `org/model`、`gpt-4o`、`qwen-max` 等）。不复用任何内置平台的 pattern（`handler.ts:619,626,640,651,654` 的正则都是平台专属）。校验失败沿用 `invalid_model` 文案。
- **缺模型 ID 显式报错**：不复用带 fallback 的 `model()`（`handler.ts:82-86` 在 `model === undefined` 时会静默套默认模型名 → 变成带默认模型名的付费请求，违反 A5）。自定义分支对空模型 ID 直接报 `invalid_model`。

### 6.4 生图（OpenAI 兼容）

`POST {baseUrl}/images/generations`

```jsonc
{ "model": "<模型 ID>", "prompt": "<提示词>", "n": 1, "response_format": "b64_json" }
```

- **只接受 `b64_json`**：响应 `data[0].b64_json`，沿用现有 PNG 头校验（`handler.ts:657-659`，返回 `mime: "image/png"` 硬编码）。
  - 推论：自定义端点返回 JPEG/WebP 会被拒——文案里要说清「需要 PNG」。
  - 理由：代理下载任意 URL 会把 SSRF 面扩大到 CDN 域名白名单之外（现有 `fetchImage()` 只放行 `*.siliconflow.cn`，`handler.ts:463-464`）。
- 不发 `size` 等可选字段，保持最大兼容。
- 同样对空模型 ID 显式报错。

### 6.5 错误码

沿用 `upstreamHttp()` 映射（401 → `provider_auth_failed`、429 → `rate_limited`、5xx → `submission_unknown` 等），新增：

- `invalid_base_url`（400）：Base URL 不安全或格式不对；
- `missing_endpoint`（前端侧）：所选端点已不存在。

前端 `src/lib/api.ts` 补两条文案与提示（`missing_endpoint` → 「所选端点已被删除，请到设置页重新选择」；`invalid_base_url` → 「Base URL 必须是公网 https 地址（不能带非默认端口、IP、内网域名或查询参数）」）。

---

## 7. 安全与隐私

| 项 | 处理 |
|---|---|
| Key | 仍只在内存（`StudioState.keys`），不落盘、不进作品、不进导出文档、不进日志；`emit()` 继续剥离 `keys` / `providerStatus` |
| Base URL | 落盘（作品级 settings），但不得进导出文档与日志 |
| SSRF | 后端双层校验（字符串 + DNS）；不代理任意图片 URL；自定义端点只接受 base64 图片 |
| 请求体积 | 沿用现有限制（prompt ≤ 32000、body ≤ 16MiB、图片 ≤ 32MiB） |
| 错误信息 | 上游错误不回显 Key |

---

## 8. 测试计划

### 单元测试

**后端**（`tests/providers.test.ts` 已用 `createHandler({ fetch })` 注入桩，是天然落点）：

- `openai-compatible` 文本：URL 拼接正确（尾部斜杠归一、query 被拒）、system/user 消息正确、`response_format` 受 `customJsonMode` 控制、响应按 `choices` 解析。
- `openai-compatible` 生图：`b64_json` 正常返回；返回 URL 时报明确错误；返回 JPEG 被拒。
- Base URL 校验：`http://`、`https://127.0.0.1`、`https://[::1]`、`https://a.local`、`https://x.internal`、`https://x.com:8443`、带凭据、带 query、含 hash 全部被拒；`https://x.com` 放行。
- DNS 判定：桩 `resolveHost` 返回内网地址时拒绝、返回公网地址时放行、解析失败时拒绝。
- 自定义端点缺模型 ID → `invalid_model`（不发请求）。
- 未知字段仍被 `fields()` 拒绝（`baseUrl` 只在允许的 action 上生效）。

**前端**：

- 端点清单按 capability 过滤；删除内置端点后从清单消失、恢复后回来。
- 删除正在使用的端点时自动改选；同组无端点时留空。
- 旧存档（无 `endpoints`、扁平 `models`）载入后得到内置清单与新结构 `models`，各步骤选择保持不变。
- `credentials()` 返回 `provider` 为协议、`baseUrl` 仅自定义端点存在；缺 Key / 缺端点分别报 `missing_key` / `missing_endpoint`。
- 删除端点**保留** `models[id]`；恢复后模型 ID 仍是用户改过的值。
- Key 不进存档（既有断言继续成立）；存档**含** baseUrl、**不含** key。

### 浏览器脚本（既有断言的破坏面要同步改）

- `tests/browser-models.mjs:59` / `:159` — 断言 `.provider-panel .tag` 恰好 **7** 个且全为「Key 缺失」：面板改为动态生成后数量会变（内置 7 个 + 自定义端点卡片），需按实际清单重写。
- `tests/browser-models.mjs:116-117` — 视频 select 恰好 2 个 optgroup、5 个 option：删除内置平台后组数会变。
- `tests/browser-models.mjs:78` / `:137` — 断言 `body.provider === provider`：自定义端点下 `body.provider` 是 `'openai-compatible'`，需分场景断言。
- `tests/browser-models.mjs:154-155` — 断言 `persisted.keys/providerStatus` 为 undefined 且存档不含 key 字面量：**继续成立**；建议补一条「存档含 baseUrl、不含 key」。
- `tests/store.test.ts:74-94` — `setProviderStatus('seedream', …)` 改按 endpointId 后签名与断言要改。
- 新增：`tests/browser-models.mjs` 加一段——添加自定义端点（假 Base URL + Key），选为生图端点，断言请求体里 `provider='openai-compatible'`、`baseUrl` 原样、`model` 为用户填的值。
- 新增：`tests/browser-flow.mjs` 删掉一个内置平台后，该步骤下拉不再出现它；恢复后回来。

### 既有回归

`npm test`（全部）、`npm run build`、`deno check functions/index.ts`、六条浏览器脚本。

---

## 9. 实施顺序建议

1. 端点模型与目录（`src/lib/endpoints.ts`）+ 存档迁移（`types.ts` / `schema.ts` / `studio.ts`）。
2. `credentials()` 与记账闭环改造（`api.ts` / `studio.ts`）。
3. 后端：`openai-compatible` 分支 + Base URL 双层校验 + 契约白名单。
4. 设置页重写（动态面板、删除/恢复、自定义端点表单）。
5. 各页面文案、下拉与判定改造（§5.4–5.6）。
6. 测试补齐与全量回归。

---

## 10. 实现者可直接采用的判断

- 自定义端点的 Base URL 语义是「API 根」：填 `https://api.example.com/v1` 即拼成 `https://api.example.com/v1/chat/completions`。
- 自定义端点 id 用 `custom-<短随机串>`；名称默认「自定义端点 N」，可改；id 不得含 `:`。
- 一个自定义端点可同时勾选 script 与 image（模型 ID 分开填）；未填对应模型 ID 时前端禁用该用途，后端再兜一层。
- 删除端点不影响已生成的作品数据，也不影响 `Shot.task` 里记录的历史 provider（视频任务仍记 `seedance` / `minimax` 协议）。
- 内置端点的协议 URL 仍由后端 `ENDPOINTS` 持有，不随端点清单暴露给前端。

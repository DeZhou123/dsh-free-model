# `src/lanes/keyed/**` — 自带 key 免费渠道车道（L2 / `WM-KeyedLanes`）

> 交付时间 2026-10-25 03:00 前后。文件边界：`src/lanes/keyed/**` + `test/keyed/**`，未触碰
> `index.js` / `src/routes.js` / `src/lanes/registry.js` / `client.js` / `package.json` /
> `src/core/**` / `src/opencode/**` / `_duo/**`。

## 1. 文件清单

| 文件 | 作用 |
| --- | --- |
| `catalog.js` | **纯数据**目录：`KEYED_CHANNELS`(20) / `KEYLESS_CHANNELS`(1) / `RETIRED_CHANNELS`(1) + `laneById` / `lanesByRegion` / `staticModels` / `lanePlaceholders` / `catalogStats` |
| `adapter.js` | `createKeyedAdapter(...)` 工厂 + `KeyedAdapter` 类 + `classifyUpstreamFailure` / `parseRetryAfter` / `pickFailureDetail` / `convertRequestMessages` / `buildOpenAiBody` / `normalizeUsage` / `frameData` |
| `ready.js` | `keyedLaneState` / `resolveApiKey` / `decodeApiKey` / `normalizeSecret` / `describeMissingKey` / `laneStates` |
| `index.js` | 桶 + 接线面：`descriptors` / `mount` / `mountAll`（`keyedLaneDescriptors` = `descriptors` 别名） |
| `NOTES.md` | 本文件 |

## 2. 自己写的测试：命令 + 输出摘要（可复现）

四个文件都能**直接** `node <file>` 跑（不依赖 `--import`，文件自己先注册离线模块解析钩子）。
**合计 81 项断言，全绿，退出码 0。**

```
> cd E:\06AI\00DeeSeekHarness\dsh-free-model
> node test/keyed/catalog-shape.mjs
通过 13 项
目录：20 条自带 key + 1 条免 key + 1 条已下线；unknown 渠道 21 条、unknown 模型行 24 条
pass=13 fail=0            exit=0

> node test/keyed/ready-state.mjs
通过 25 项
pass=25 fail=0            exit=0

> node test/keyed/adapter-stream.mjs
通过 22 项
pass=22 fail=0            exit=0

> node test/keyed/adapter-errors.mjs
通过 22 项
pass=22 fail=0            exit=0
```

`node --check` 逐文件通过：

```
> node --check src/lanes/keyed/catalog.js   # exit=0
> node --check src/lanes/keyed/ready.js     # exit=0
> node --check src/lanes/keyed/adapter.js   # exit=0
> node --check src/lanes/keyed/index.js     # exit=0
```

覆盖到的**真东西**（不是形状检查）：

- **半行跨 chunk 不丢**：一帧从中间切成两段 → 文本拼回 `你好世界`（`adapter-stream.mjs`）。
- **真 socket**：`node:http` 起本地上游，分 3 次写、间隔 15ms，全局 `fetch` 直连 → 文本正确、
  `Authorization` / `stream` / 请求路径逐项核对，且证明适配器会先 `GET /models` 再 `POST /chat/completions`。
- **`[DONE]` 收尾**、**空 delta 不造块**（且最终给 `EMPTY_RESPONSE` 失败而不是静默空白）、
  **工具调用跨帧拼参数**（`{"path":"a` + `.txt"}` → 合法 JSON，`finish.kind='tool-calls'`）、
  **CRLF 分帧**、**非 JSON 帧跳过**、**usage 缓存扣减**（`prompt 1000 / cached 400` → `inputTokens 600`）。
- **错误分类两两不同**：`credential` / `quota` / `rate-limit` / `connection` 四类的
  `kind`、`code`、`advice` **三组都互不相同**，`retryable` = `[false,false,true,true]`。
  含 402+`Retry-After` → 判限流（Pollinations 语义）、429 但正文说额度 → 仍判额度、
  超时（真等到 40ms 超时）→ `TIMEOUT`、`fetch failed` → `TRANSPORT`、流内错误帧（无状态码）→ 按措辞分类。
- **就绪判定**：`ref:NAME` 解引用（且**只解一层**，环状凭据表不会递归）、空/损坏/已下线/`{ACCOUNT_ID}` 四种
  not-ready 各有不同 `reason`。

### 测试暴露并已修掉的 4 个真缺陷（留证：这是"真跑过"的证据）

1. **工具调用"丢掉"是假的**：原先在 `block-end` 阶段才丢弃无名调用，但 `BlockAssembler` 会为
   已 `block-start` 的 partial **自动合成**一个 `name:''` 的调用 —— 丢弃无效。改为**等到工具名出现
   再开块**（名字没到之前什么都不发），残缺输出连 partial 都不留。
2. **`#catalog()` 不吃调用方的取消信号**：用户取消一轮对话后，`/models` 探测仍在后台把 20 秒跑满。
   现在把 `options.signal` 接进目录探测（`#rowFor(model, signal)`）。
3. **超时 timer 被 `unref()`**：当它是一轮里唯一未 settle 的东西时，进程会直接退出而不是等到超时
   （测试里表现为 `exit=13 / unsettled top-level await`）。改为不 unref（`finally` 里必定 clearTimeout）。
4. **`RATE_WORDING` 漏声明**（运行时 `ReferenceError`，被兜底分类吞成一个无信息量的 TRANSPORT）：
   `node --check` 抓不到这类错，只有跑测试才暴露 —— 现已补上。
5. **占位符会被上游规范化成百分号编码**：`{ACCOUNT_ID}` 过一遍 `new URL()` 变成
   `%7BACCOUNT_ID%7D`，只认花括号的 ready 判定会把该车道误判成"就绪"，随后打出一个 404。
   （见 §3.5 第 3 条；`lanePlaceholders` 现在两种形态都认，适配器也据此拒发请求。）

## 3. 给上层（L1）的接线说明

### 3.1 import

```js
// 只挂路由/取描述符，用桶（推荐）：
import { descriptors, keyedLaneDescriptors, mount, mountAll } from './lanes/keyed/index.js'
// 想直接读数据：
import { KEYED_CHANNELS, KEYLESS_CHANNELS, RETIRED_CHANNELS, ALL_CHANNELS, laneById, staticModels, catalogStats } from './lanes/keyed/catalog.js'
// 想自己做就绪判定 / 解凭据：
import { keyedLaneState, resolveApiKey, decodeApiKey, laneStates } from './lanes/keyed/ready.js'
// 想自己造适配器（绕过 mount 的"未就绪就抛"）：
import { createKeyedAdapter, classifyUpstreamFailure, FAILURE_KINDS } from './lanes/keyed/adapter.js'
```

### 3.2 拿描述符（页面与 registry 共用同一个形状）

```js
const rows = await descriptors(
  { readCredential: (name) => hostCredentials.read(name) },  // ← 宿主 credentials 服务的方法，**必须注入**
  { includeRetired: false, onlyReady: false, region: undefined },
)
// row = { id, displayName, kind:'keyed'|'keyless', protocol:'openai', baseURL, apiKeyEnv, region,
//         freeTier, docsURL, signupURL, note, evidence, models[],
//         unknown, unknownFields[], retired, retiredOn?,
//         ready, reason, keyRef, keySource, mountable }
```

- `descriptors()` 是 **async**（`readCredential` 是异步的），**必须 await**。
- `mountable === ready && !retired`：**只挂 `mountable` 的行**。挂未就绪的渠道会把一列必然报错的模型
  塞进模型选择器，用户看到的是"插件坏了"。
- `rows` 默认**不含**已下线渠道（`github-models` 于 2026-07-30 下线）；要展示"这个渠道没了"时传
  `{ includeRetired: true }`。

### 3.3 挂载（**注册留在上层**，本模块不碰 `ctx`）

```js
ctx.inject(['llm', 'credentials'], (scoped) => {
  const readCredential = (name) => scoped.credentials.read(name)
  void (async () => {
    const { mounted, failed } = await mountAll({
      readCredential,
      logger,
      readImage: makeReadImage(scoped),          // 与 opencode/buddy 共用的附件桥（可选）
      readImageRequest: makeReadImageRequest(scoped),
    })
    for (const entry of mounted) {
      // entry = { lane, route, adapter, readiness }
      registerAdapterIdempotent(scoped.llm, [entry.route], entry.adapter, (m) => logger?.warn?.(m))
    }
    if (failed.length > 0) logger?.warn?.(`[free-model] keyed 车道挂载失败：${failed.map((f) => f.id).join(', ')}`)
  })()
})
```

要点：

- `mount(laneId, deps)` 的解是 `{ lane, route, adapter, readiness }`；`route` 默认 = `lane.id`
  （可用 `deps.route` 覆盖）。**`registerAdapter` 仍走 `src/core/register.js` 的
  `registerAdapterIdempotent( llm, [route], adapter, warn )`** —— 那里的幂等 + Token 记账包装是必须的
  （`Proxy` 会绑回原适配器，本模块的 `#private` 字段因此正常工作）。
- `mount()` / `mountAll()` 会**抛**；未就绪的 `reason` 文案可直接展示给用户（含"去哪拿 key"）。
  `mountAll()` 已经把失败收集成 `failed[]`，单条失败不带走其余。
- 用户填完 key 之后**不必重挂**：`adapter.setApiKey(key)` 会换 key 并作废目录/失败状态缓存。
- 适配器上可直接读的运维面：`adapter.listModels(route)`（返回数组，`rows.source === 'live'|'static'`）、
  `adapter.lastFailure()`（`{kind, code, status?, retryAfterMs?, retryable, advice, detail, at, model}`）、
  `adapter.capabilities(modelId)`（`{vision, tools, source}`）。

### 3.4 registry 侧的字段口径

- `id` = 路由前缀（短横线小写，全局唯一，`catalog-shape.mjs` 有断言）。
- `kind`：`'keyed'` 需要凭据 → `apiKeyEnv` 非空字符串；`'keyless'` 恒 `ready:true` 且 `apiKeyEnv === null`。
- `region`：`'cn'` 的渠道国内直连不需要代理（页面可提示），`'global'` 可能需要。
- `unknown` / `unknownFields`：**未确证的字段名列表**（判据见 `catalog.js` 头部注释）。

### 3.5 与**已经在仓库里**的 `src/lanes/registry.js` + `src/lanes/catalog.js` 对接（读源码后列的坑）

> 读的是 commit `f0f41a4` 里的那两个文件（只读，未改）。三件事必须对齐：

1. **`runtime.keyedReady` 需要一个 map**：`registry.js` 读 `runtime.keyedReady?.[channel.id]`
   并且只认 `{ ready, reason? }`。我这边是一次性算好的数组，映射一行即可：
   ```js
   const { rows } = await laneStates(KEYED_CHANNELS.concat(KEYLESS_CHANNELS), { readCredential })
   const keyedReady = Object.fromEntries(rows.map(({ lane, state }) => [lane.id, { ready: state.ready, reason: state.reason }]))
   ```
   （`descriptors()` 的每行也带 `ready`/`reason`/`mountable`，两种用法都行。）
2. **`layers.keyed` 喂进去的记录要过 `normalizeChannelRecord`**：它把规范字段之外的键放进
   `channel.extra`（不报错），但 `RESERVED_FIELDS`（`kind/baseURL/endpoint/capability/probe/native/startable`）
   之外、且**不在它认识的字段里**的键是否保留，取决于它内部的 `allowUnknownFields` 分支。
   我这边多出来的字段是：`evidence` / `unknown` / `unknownFields` / `supportsModelList` / `modelsURL`
   / `placeholders` / `retired` / `retiredOn`。**这四个（`unknown*` + `evidence`）正是用户要的诚实标记**，
   别在规范化时丢掉 —— 需要时传 `allowUnknownFields: true`，或直接从 `descriptors()` 取这些字段。
3. **⚠️ `cloudflare-workers-ai` 的 baseURL 带 `{ACCOUNT_ID}`，而 `cleanUrl()` 用 `new URL()` 规范化**：
   WHATWG URL 的路径编码集**包含 `{` `}`**，实测 `new URL('https://…/accounts/{ACCOUNT_ID}/ai/v1').pathname`
   → `/client/v4/accounts/%7BACCOUNT_ID%7D/ai/v1`。所以：
   - 我的 `lanePlaceholders()` 现在**同时认花括号与百分号编码两种形态**（有断言）；
   - 适配器在 `stream()` 与目录探测里都会因此**拒发请求**（不会去打 404）；
   - 建议 registry 层把这条车道视为**未就绪**（`ready:false`，reason 里已写"替换占位符"），
     而不是把它当成"有 key 就能用"。
4. **`RETIRED_CHANNELS`（`github-models`）不要喂进 `layers.keyed`**：它 2026-07-30 已下线，
   页面应当单独显示"已下线"而不是给一个可挂载的车道。要展示就单独渲染 `catalogStats().retired`。

## 4. 未确证项（`unknown: true` 的渠道与原因）

**baseURL 一条都没猜**：20 条 keyed + 1 条 keyless 全部有实测或官方文档原文作为 `evidence`
（`catalogStats().unverifiedBaseURL === 0`，有断言守着），探测表在 `catalog.js` 头部。

标了 `unknown` 的 21 条，`unknownFields` 只含两类：

- `['models']` / `['models','freeTier']`：**静态模型表是快照**。有实时 `/models` 的渠道会被运行时结果覆盖
  （`rows.source === 'live'`）；`google-ai-studio` 与 `pollinations` 没有标准 `/models`
  （前者实测 404）→ 标了 `supportsModelList:false`，永远走静态表，此时**模型 id 是最大风险点**。
- `['freeTier']`：免费额度的**具体数值**（每日次数 / token 数 / 重置时刻）没有拿到官方口径，
  只写了形态。收钱的边界由上游 402/429 自己说话，分类器会把它翻译成"额度用尽"或"限流"。

逐条清单：

| 渠道 | unknownFields | 说明 |
| --- | --- | --- |
| openrouter-free | freeTier | 免费模型 id 是**实测**（`pricing.prompt=0`）；每日次数上限未见官方数值 |
| groq / cerebras / mistral / together / nvidia-nim / sambanova / siliconflow / zhipu-bigmodel / moonshot / baidu-qianfan / volcano-ark / dashscope / stepfun / spark-xfyun / hunyuan / minimax | models(+freeTier) | 端点已实测存在；模型 id 与额度数值未实测（实时 `/models` 一到就覆盖） |
| google-ai-studio | models, freeTier | baseURL 取自官方 openai 兼容页；**无** `/models`（实测 404）；模型名取自该页代码样例 |
| cloudflare-workers-ai | freeTier | baseURL 与模型 id 取自官方页；**需要替换 `{ACCOUNT_ID}`** |
| pollinations | models | 免 key、目录实测（只有 `openai-fast` 一个）；30 秒/次的限制有官方原文 |
| github-models | — | 在 `RETIRED_CHANNELS`，`retiredOn: '2026-07-30'` |

## 5. 设计决定（上层要知道的取舍）

1. **`tools` 能力没法声明，所以在请求侧执行。** 宿主这一版 `LlmModelInfo`
   只有 `{provider,id,name,description?,inputModalities?}`（已核对 `dsh-llm/lib/typert.host.js`
   的声明），**没有**"支持工具"这个字段。所以 `vision → inputModalities`（与 `OpenCodeAdapter` 同字段名），
   而 `tools:false` 的模型：不发 `tools[]`，并把历史里的 tool 消息折成 user 文本（严格上游否则 400）。
   也**没有**声明 `toolUpdate` —— 那个字段的语义是"工具声明随 developer 消息进历史"，对无状态 OpenAI
   端点只会让请求体多出一堆 developer 消息，留空即拿宿主默认行为（每轮把完整 `tools` 交给我们）。
2. **不发 `reasoning_effort`。** 各家对它的接受度不一致（拒收就是 400），且免费档映射表各不相同。
   想要思考档位请让用户在页面里换模型 —— 这是"宁可少一个功能，不要多一类 400"。
3. **`stream_options.include_usage` 带了，但失败会自己降级。** 首次 400 且正文提到
   `stream_options`/`unknown field` → 剥掉重试一次，并**记住**（`streamUsageSupported=false`），
   此后不再发。代价是这些渠道的 usage 可能缺失（账本显示 `—`，与既有约定一致）。
4. **`stream()` 的错误一律分类后抛 `LlmError`**（含流内错误帧），并对四类给出不同 `code`：
   `INVALID_CREDENTIAL` / `QUOTA` / `RATE_LIMIT`（带 `providerRetryAfterMs`）/ `TIMEOUT` | `TRANSPORT`。
   宿主的默认重试表恰好把 `RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT` 视为可重试，与本分类一致。
5. **`listModels()` 永不抛**（宿主要在模型选择器、状态页、探测三处并发调用），失败退回静态表并标
   `rows.source='static'`；失败后 10 秒冷却，目录成功后缓存 5 分钟。
6. **403 的措辞优先于状态码**：正文说余额/额度时按 `quota` 报（等不会恢复），不说时按 `credential` 报。
   429 同理（有些上游用 429 回"余额不足"）。**402 有 `Retry-After` 时判限流**（Pollinations 的按 IP 限速语义）。
7. 目录行的 `contextWindow` / `maxTokens` **0 = 未知**（沿用本仓库既有约定），
   `resolveModel` 会退回 200k / 32k；图片预算 2MiB / 640k 像素（与 buddy 车道同值）。
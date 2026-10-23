# dsh-free-model

把三条「不花钱」的模型车道装进 DSH，用**一个页面**管起来。

| 车道 | 路由 | 能力 | 需要什么 |
|---|---|---|---|
| CodeBuddy（腾讯国内版） | `buddy/*` | 完整：工具调用、看图 | 一个账号（浏览器登录） |
| WorkBuddy（腾讯国际版） | `workbuddy/*` | 完整：工具调用、看图 | 一个账号（浏览器登录） |
| OpenCode 免费层 | `opencode/*` | **仅文本**：无工具 | 本机 `opencode serve`（插件可代起） |

> **不依赖 dsh-our-free-model。** 装了 OFM 则自动共享它的账号池与凭据（同一份
> `channel-pack/state.json`），不装则退化为本插件自带的池，读写**同一个文件**。

## 为什么需要这个插件

三件事各自都能做，但**没有一个地方能同时回答**「我到底有哪些免费模型、它们现在
能不能用、要做什么才能用」。

- OFM 2.5.8 移除了 WorkBuddy / CodeBuddy 的入口，账号与凭据还在（本插件的前身
  `dsh-ofm-workbuddy` 把它们接回来了）；
- opencode 的免费层只在「OpenCode 自己的调用方」里合法可用（直连会被拒，实测），
  而它跑的 `serve` 正好就是合法调用方；
- 这两批模型的能力**不一样**：前者能调工具、能看图，后者只能纯文本。

本插件把三者放在一页里，并且**把能力差异写在卡片上**，而不是等用户踩坑。

## 三条车道的产品定位

### 完整能力车道（buddy / workbuddy）

可以当**主模型**用：DSH 的 agent loop 需要的工具调用、图片输入都支持。

- 账号型：一个账号 = 一份凭据 + 一个有效期；
- 多账号按「N 天内到期的积分」分档选号（积分快过期的先用掉，避免浪费）；
- 免费模型跳过积分分档（消耗 0 积分，没有「烧哪个包」的问题）；
- 限流按**模型**记：`deepseek-v4.1-flash` 被限流不影响 `glm-5.3`。

### 仅文本车道（opencode）

**不要拿它当主模型。** opencode 的消息接口只接受
`tools: { [name]: boolean }` —— 那是它**内置工具**的开关表，整份 API 里没有
任何入口能把调用方自己的工具 schema 传进去（`/doc` 的 `PromptInput` 只有
text / files / agents）。

DSH 的 agent loop 靠 tool call 驱动，所以这条车道能做的事只有「一句话进、
一句话出」：会话标题、压缩摘要、翻译改写、代码解释。

页面上给这条卡常驻一枚 `仅文本` 徽章和一句说明 —— 这件事只写在 README 里
是不够的，用户一定会在 agent 会话里选它然后困惑。

### 它为什么仍然值得做

- 免费层模型走 `serve` 是**合法调用方**，直连会被拒；
- 用户一条命令都不用敲：插件自己拉起服务、自己管会话、自己清理；
- 三条车道同页对比，用户一眼看到「现在哪条能用」。

## 安装

> 仓库：<https://github.com/DeZhou123/dsh-free-model>（MIT）

```powershell
# 方式一：从 GitHub 装（跟版本走）
dsh plugin --profile web add github:DeZhou123/dsh-free-model

# 方式二：本地开发用 link 安装（改代码即时生效）
dsh plugin --profile web add link:E:\06AI\00DeeSeekHarness\dsh-free-model
```

然后在 profile 的 `dsh.profile.bundles` 末尾追加 `"dsh-free-model"`，重启宿主。

## 页面

设置 → **免费模型**（`settings.section` id `free-model`，排在 OFM 之后）。

```
┌─ 免费模型总台 ────────────────────────────────────────────┐
│  2/2 账号   38/38 模型   账号池：OFM 共享池   OpenCode·就绪  │
└──────────────────────────────────────────────────────────┘
┌─ CodeBuddy (腾讯) ─────────┐ ┌─ WorkBuddy (国际版) ───────┐
│ [完整能力] [本插件接管]      │ │ [完整能力] [本插件接管]      │
│ 账号 │ 模型                │ │ 账号 │ 模型                │
└────────────────────────────┘ └────────────────────────────┘
┌─ OpenCode 免费层 ─────────────────────────────────────────┐
│ [仅文本] [服务运行中]   12 个模型                          │
│ 不能调用工具…适合标题、摘要、翻译。                          │
│ [停止服务] [刷新目录]                                       │
└──────────────────────────────────────────────────────────┘
```

### 设计取舍（产品视角）

| 决定 | 为什么 |
|---|---|
| **不做页签**，三张卡平铺 | 只有三条车道，一屏放得下；藏进页签是拿点击换整洁，不划算 |
| **能力徽章常驻卡头** | 「能不能当主模型」是用户第一个要判断的事，不该藏进折叠区 |
| **状态药丸三分**：就绪 / 需动作 / 不可用 | 「不可用」和「能用但没配好」是两种处境，合成一个词会让用户乱试方向 |
| **空状态直接给按钮** | 「暂无数据」是开发者的语言；用户要的是「点这里」 |
| **服务卡与账号卡长得不一样** | 服务车道没有「账号」这个概念，硬套会让人去找登录入口 |
| **失败原因原样显示** | 这条链路能失败的地方有十几种（二进制不在、端口被占、限流、旧版本），藏进日志等于让用户猜 |
| **OpenCode 状态单列一行** | 「进程在跑」与「路由已挂载」是两个独立失败点，修法完全不同 |

## 实现要点

### 目录

```
index.js                 三条车道的装配（账号型 ×2 + 服务型 ×1）
src/channels.js          buddy 系通道装配（auth + adapter + 选号）
src/routes.js            /api/free-model/*（含 /opencode/status|start|stop|refresh）
src/pool.js              账号池：宿主池优先，缺席时退化实现
src/live-pool.js         账号池的晚绑定门面
src/trust.js             HTTP 面的信任围栏
src/core/                buddy 全栈（从 v2.5.7 逐行移植，注释即踩坑记录）
src/opencode/client.js   opencode serve 的 HTTP 客户端（会话复用 + 增量流式）
src/opencode/adapter.js  DSH LlmAdapter（把 parts 翻成 chunk）
src/opencode/service.js  进程生命周期（探测 / 拉起 / 端口顺延 / 清理）
client.js                浏览器半身（一个设置页）
```

### 流式是怎么做的

opencode 的 `POST /session/{id}/message` 是**阻塞到生成完成**的，拿不到增量。
但 assistant 消息在生成过程中就能被读到，所以：

1. `POST /session/{id}/prompt_async` → 204 立即返回；
2. 轮询 `GET /session/{id}/message`，按 part id 记已发长度，只发增量；
3. `info.time.completed` 出现即收尾，取 `info.tokens` 作 usage。

实测（2026-10-21，`ofm/codearts/glm-5.3`）：首块 3.3s，reasoning 293 字符 +
正文 57 字符，usage `{input:132, output:37, reasoning:60, cacheRead:1920}`。

### 三个必须挡住的坑

1. **`limit.context` 可能是 0**。上游对本地/聚合 provider 常下发
   `{ context: 0, output: 0 }`，而 0 是「未知」不是「零窗口」。不挡住会让
   `resolveModel` 返回 `contextWindow: 0`，宿主据此把请求判成超窗口
   （实测 `ofm/codearts/glm-5.3` 就是 0）。
2. **上游失败也标 completed**。错误挂在 `info.error` 上，必须原样抛出去 ——
   否则用户拿到的是空回答加一句猜的「可能限流」，而真实原因可能是
   「免费层只能在 OpenCode 内使用」「模型不存在」「协议不支持」。
3. **工具必须全关**。opencode 的 `build` agent 默认带 bash / write / edit，
   不关掉模型会真的在用户机器上执行命令，而 DSH 侧又拿不到结果（两套工具
   协议不互通）。`toolsDisabled()` 把 14 个内置工具全部置 false。

### 账号池的两种形态

| 场景 | 行为 |
|---|---|
| 装了 OFM | 用它的 `accountPool`（同一份账号、同一份限流标记、同一份黑名单） |
| 没装 OFM | 退化成 `LocalPool`，读写**同一个** `$DSH_HOME/channel-pack/state.json` |

本地实现只替换 `accounts` 里属于本插件的那几条，其余字段与条目原样保留 ——
`state.json` 是 dsh home 级共享文档，整份重写会静默丢掉别的通道的字段。

## 测试

```powershell
# 主套件：40 项协议/路由断言 + 客户端离线渲染（不需要宿主、不发网络）
npm test

# 用真实宿主包验证契约（临时 link dsh-llm / dsh-credentials，跑完删掉）
npm run test:host

# 真实端到端（需要 opencode serve 在跑）
npm run test:e2e -- 'ofm/codearts/glm-5.3'
```

三套测试各挡一类错：

| 套件 | 挡什么 |
|---|---|
| `smoke.mjs` | 协议与路由：三条车道的注册/目录/元数据/stream chunk 序列、HTTP 面每条路由、信任围栏、让位语义 |
| `render.mjs` | 白屏：用极小的 React 替身把组件树跑一遍。`node --check` 只能抓语法错，抓不到「渲染时抛 ReferenceError」——而那正是白屏最常见的原因 |
| `host-check` / `host-apply` | 契约漂移：`instanceof LlmAdapter`、`providerInfo.id === provider`、`prepareCall` 返回 stream、`LlmError` code 被宿主认得 |

`test:e2e` 依赖本机装没装 opencode、以及免费层此刻有没有被限流，故**不进** `npm test`。

## 已知边界

- **OpenCode 免费层在本机 IP 上常年限流**。`opencode/*-free` 全系列返回
  `Rate limit exceeded` 或 `free tier can only be used from within OpenCode`，
  目录能拉到、调用不通。这是上游策略，不是插件缺陷；插件做的是把真实原因
  原样显示出来。
- **OpenCode 车道不支持工具**（见上）。
- **OpenCode 车道不支持图片**：`PromptInput` 有 `files` 附件字段，但 DSH 的
  图片投影链路没有接过去，故 `inputModalities` 只声明 `text`。
- **不接 OFM 的 token 账本**：`token-ledger` 是 OFM 包内的内部模块，硬 import
  会在它下次重构时把整个插件打死。记账退化为 no-op，推理不受影响。

## 与前身的关系

`dsh-ofm-workbuddy` 只做一件事：把 OFM 2.5.8 移除的两条通道装回来。本插件
在此基础上：

1. **拆掉对 OFM 的隐含依赖**（池可退化、账本不接）；
2. **加第三条车道**（opencode 免费层）；
3. **重做信息架构**（能力徽章、三分状态、空状态给动作）。

buddy 全栈（`src/core/`）逐行保留原注释 —— 那些注释是这份代码最值钱的部分，
每一条都对应一次真实报障（限流 6004 vs 模型饱和 14003、401 刷新自锁、
免费模型被永久积分锁定误拦、`prepareCall` 的记账隐式依赖……）。

# dsh-free-model

把本机所有「不花钱」的模型渠道装进 DSH，用**一个设置项、三个页签**管起来，
并且让渠道清单**能远程更新** —— 加渠道不用等插件发版。

| 类 | 条数 | 路由 | 能力 | 需要什么 | 页内页签 |
|---|---|---|---|---|---|
| **账号渠道**（本插件自己挂） | 2 | `buddy/*`、`workbuddy/*` | 完整：工具调用、看图 | 一个账号（浏览器登录） | 账号渠道 |
| **账号渠道**（宿主 `dsh-our-free-model` 提供后端） | 11 | 各平台自己的路由 | 完整 | 各平台一个账号 | 账号渠道 |
| **服务渠道**（本机进程） | 3 | `opencode/*` | **无工具**：能看图、不能调工具 | 本机 `opencode serve`（插件可代起） | 本地与网关 |
| **自带 key / 免 key 渠道** | 21 | `<渠道 id>/*` | 取决于上游声明 | 去上游拿免费 key（免 key 渠道零配置） | 自带 key |

**它要回答的问题是**：我到底有哪些免费模型、它们现在能不能用、不能用的话下一步做什么。
所以每条渠道都带**就绪状态**（`就绪 / 需动作 / 不可用 / 未知`）与**一条能指导动作的原因**
（配哪个凭据变量、去哪拿 key、去起哪个服务），而不是等用户点下去猜。

三类渠道的「不能用」是三件不同的事，所以**必须分开**：

| 类 | 不能用时用户要做什么 |
|---|---|
| 账号渠道 | 登录 / 续期 / 领积分 / 换账号 |
| 服务渠道 | 起本地进程 / 填网关 key / 换一个本地服务 |
| 自带 key | 去上游拿 key、写进凭据条目（免 key 渠道不需要） |

合并成一句「渠道不可用」会让用户乱试方向，所以本插件宁可多写三个分支。

## 骨架：注册表 + 可远程迭代的渠道目录

```
src/lanes/registry.js     唯一事实来源：三类渠道 → 同一种记录形状 → 就绪四态投影
  ├── src/lanes.js            11 条宿主侧车道的元数据（**不重复挂载**：会撞同名 cordis Service）
  ├── src/lanes/service.js    3 条服务车道 + HTTP 探针（双 TTL 缓存，失败退避 30 秒）
  ├── src/lanes/keyed/**      21 条自带 key / 免 key 车道（目录 + 就绪判定 + OpenAI 兼容适配器）
  ├── src/lanes/catalog.js    记录校验（远程数据是**不可信输入**）+ 三层叠加（shipped/remote/local）
  └── src/lanes/remote.js     远程目录拉取（https-only、格式版本不符整份拒绝、原子缓存、失败降级）
```

**为什么渠道数据要能远程更新**：免费渠道是外部策略，不是技术事实。上游换域名、加免费模型、
收回额度，都不该逼用户等一次插件发版。所以渠道数据分三层、同形状、按 id 覆盖：
随包（离线基线）← 远程 JSON（随时可更新）← 本地覆盖文件（用户自己钉住/改对）。
远程数据只被当作**数据**读：没有 eval、没有动态 import，每条记录都要过校验器，
不合格的整条丢弃并记账 —— 一条 baseURL 写错的渠道会表现成「插件坏了」，比少一条渠道糟得多。

### ⚠️ 仓库是私有的，远程目录默认拉不到（三条路）

`raw.githubusercontent.com/<owner>/<repo>/…` 对**私有仓库一律 404**（本机 2026-10-25 实测），
而这个仓库按约定默认 private —— 所以「远程目录」这一层**默认是不可用的**：
插件会优雅降级到**随包数据**（功能一切正常，只是「加渠道不用发版」这句落不了地）。

三种让它真正生效的办法，按代价排序：

| 路 | 怎么做 | 代价 |
| --- | --- | --- |
| ① 目录放到公开位置 | 传到公开 Gist 或自己的静态站点，`catalog.url` 指过去 | 目录内容会公开（里面**没有凭据**，只有渠道元数据） |
| ② 给一个只读 token | 凭据或环境变量里放 `GITHUB_TOKEN`（或 `DSH_FREE_MODEL_CATALOG_TOKEN`）| 要建一个 token；token 只进请求头，不进 URL、不落盘、不出现在返回值里 |
| ③ 仓库转公开 | 你自己的决定，插件不代做 | —— |

失败时页面会**原样显示后端给的原因**；如果是「404 且没有 token」，原因里会点明是私有仓库这件事
（不是干说一句「拉取失败」）。页面上同一行还给出本地覆盖文件的全路径
（`$DSH_HOME/free-model/channels.local.json`）—— 不想动仓库时，那是第四条路。

## 账号渠道：13 条车道（2 条自己挂 + 11 条 OFM 侧）

上面三条是**本插件自己跑**的车道。但 OFM（`dsh-our-free-model` 的 channel-pack）里
还有 11 条账号车道是活的 —— 它们的 auth、适配器、积分与登录实现都在宿主的
channel-pack 里，账号也存在**同一份** `channel-pack/state.json`。只显示两条，
用户就得在两个面板之间来回切。现在「账号渠道」页把它们全部列出：

| 车道 | id | 登录形态 | 余额 | 签到 |
|---|---|---|---|---|
| CodeArts (华为云) | `codearts` | 浏览器回调 | ✓ | ✓ |
| LobsterAI (有道) | `lobsterai` | 浏览器回调 | ✓ | ✓ |
| Qoder | `qoder` | 设备码轮询 | ✓ | ✓ |
| Qoder (中国版) | `qodercn` | 设备码轮询 | ✓ | ✓ |
| TRAE (字节) | `trae` | 浏览器回调 | ✓ | ✓ |
| Cline | `cline` | WorkOS 设备码 | ✓ | ✓ |
| Loomy (讯飞) | `loomy` | **本机登录页**（微信扫码；另有手机号备用路径） | ✓ | ✓ |
| Raccoon (商汤) | `raccoon` | **本机登录页**（微信扫码 / 短信） | ✓ | ✓ |
| MiniMax Code | `minimax` | 设备码 + PKCE | ✓ | ✓ |
| Gemini Code Assist | `gemini` | 浏览器回调 | ✓ | **无**（上游不提供签到） |
| ZCode (智谱) | `zcode` | 官方设备授权 | ✓ | ✓ |

外加本插件自己挂的 `buddy` / `workbuddy` —— **13 条账号车道一个面板**。

### 两条后端，页面自己选（`backend`）

| backend | 谁实现 | 页面怎么操作 |
|---|---|---|
| `native` | 本插件挂载的 auth + adapter（`buddy` / `workbuddy`） | `/api/free-model/*` |
| `ofm` | 宿主 channel-pack（上面 11 条） | 直接调宿主的 `/api/channel-pack` RPC |

`GET /api/free-model/summary` 里每条车道都带 `backend` / `login` / `credits`，
页面据此渲染卡片与动作 —— 不需要认识任何具体渠道。

### 为什么不把这 11 条也自己挂一遍

两个硬理由（都是实测过的坑，不是洁癖）：

1. **cordis 同名 Service 会抛错**。OFM 侧 `new QoderAuth(ctx)` 这类实例会注册
   `ctx.qoderAuth`；本插件再 `new` 一个同名的会抛
   `service "qoderAuth" has been registered`，把整个 apply 打死；
2. **两份 auth 实例 = 两份续期定时器**。同一个 `refresh_token` 被并发消费，
   表现是「刚登录却一直认证失败」（本仓库在 CodeArts 上记录过同型事故）。

所以这 11 条只做**页面 + 管理面**：后端一律转发。转发**在浏览器里做**（页面与
OFM 面板同源、同一份会话），不在 Host 侧再包一层 —— 那等于把 12 个 RPC 方法 ×
11 条车道写成胶水，且每条车道的产品怪癖都会在转发层再漂移一次。

### 宿主没装 OFM 时（降级）

这 11 条**照样列出**（用户能看到「这台机器上有哪些免费渠道」），但每条标注
「后端未就绪」、不给任何动作按钮，卡片上写明「要先装 dsh-our-free-model」。
给出点了必然失败的按钮，用户的下一步动作会是「反复点它」，而不是「去装后端」。

```powershell
# 后端就绪与否看这一行：ofm.available
curl -s http://127.0.0.1:<web端口>/api/free-model/summary   # 需要用浏览器会话（同源 JS）
```

### 回归防线

`node test/lanes.mjs` —— 断言注册表（11 条、id 顺序、积分能力与 OFM 的 claimAll
分支一致、Loomy 的短信备用路径、RPC 常量）与「不与 native 两条重叠」。
`test/smoke.mjs` 另断言：OFM 侧车道在本插件的 HTTP 面上一律 **409 `backend-ofm`**
（走错了门要明确报出来，而不是 503 或静默改池）。

> 账号型两条车道与「不需要登录的本地车道」在**同一个设置项内分页**：前者要管账号、
> 积分、签到；后者只有一个本地进程要管。同一时刻屏幕上只有一个主题，页签上还带
> 数字（账号数 / 模型数），切换前就知道对面有没有东西。

> **不依赖 dsh-our-free-model。** 装了 OFM 则自动共享它的账号池与凭据（同一份
> `channel-pack/state.json`），不装则退化为本插件自带的池，读写**同一个文件**。

## 为什么需要这个插件

三件事各自都能做，但**没有一个地方能同时回答**「我到底有哪些免费模型、它们现在
能不能用、要做什么才能用」。

- OFM 2.5.8 移除了 WorkBuddy / CodeBuddy 的入口，账号与凭据还在（本插件的前身
  `dsh-ofm-workbuddy` 把它们接回来了）；
- opencode 的免费层只在「OpenCode 自己的调用方」里合法可用（直连会被拒，实测），
  而它跑的 `serve` 正好就是合法调用方；
- 这两批模型的能力**不一样**：前者能调工具、能看图；后者**能看图、不能调工具**
  （工具协议的缺口在 opencode 侧，不在本插件）。

本插件把三者放在一页里，并且**把能力差异写在卡片上**，而不是等用户踩坑。

## 三条车道的产品定位

### 完整能力车道（buddy / workbuddy）

可以当**主模型**用：DSH 的 agent loop 需要的工具调用、图片输入都支持。

- 账号型：一个账号 = 一份凭据 + 一个有效期；
- 多账号按「N 天内到期的积分」分档选号（积分快过期的先用掉，避免浪费）；
- 免费模型跳过积分分档（消耗 0 积分，没有「烧哪个包」的问题）；
- 限流按**模型**记：`deepseek-v4.1-flash` 被限流不影响 `glm-5.3`。

### 无工具车道（opencode）

**不要拿它当主模型。** opencode 的消息接口只接受
`tools: { [name]: boolean }` —— 那是它**内置工具**的开关表，整份 API 里没有
任何入口能把调用方自己的工具 schema 传进去（`/doc` 的 `PromptInput` 只有
text / files / agents）。

DSH 的 agent loop 靠 tool call 驱动，所以这条车道能做的事只有「一句话进、
一句话出」：会话标题、压缩摘要、翻译改写、代码解释、**识图**。

> **能看图**（2026-10-23 修正）。早先这里写着「仅文本」，那是错的：
> `/config/providers` 里 9 个 opencode 免费模型中有 4 个声明
> `capabilities.input.image = true`，图片用 `FilePartInput` 的 `data:` URL
> 发送（实测 `prompt_async` 返回 204，上游确实收到了图）。真正的缺口只有
> 工具调用。

页面上给这条卡常驻一枚 `无工具` 徽章和一句说明 —— 这件事只写在 README 里
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

## 页面（一个设置项，页内两个页签）

设置 → **免费模型**（`settings.section` id `free-model`，order 37，排在 OFM 之后）。
进去之后是页内页签（与 OFM 的页内 `ofm_tabs` 同构），当前页签记在 `localStorage`
的 `free-model:tab` 上，刷新后停在原处。

```
┌─ 免费模型 ─────────────────────────────────────────────────────────────┐
│ ( 账号渠道 2/2 ) ( OpenCode 免费层 12 )                                 │
└────────────────────────────────────────────────────────────────────────┘
```

- **账号渠道**：CodeBuddy / WorkBuddy 两条账号车道的全部内容（下方页一）；
- **OpenCode 免费层**：不需要登录的本地车道（下方页二）。

页签上的数字由各页**自己上报**（账号页报 `启用/总数`，本地页报运行中的模型数，
没跑就不显示数字）—— 外壳不重复请求一遍接口。

### 页签一：账号渠道

```
┌─ 免费模型 · 账号渠道 ──────────────────────────────────────────────────┐
│  2/2 账号   38/38 模型   剩余积分 1.2K   账号池：OFM 共享池   自动领积分·已领  │
└────────────────────────────────────────────────────────────────────────┘
┌─ 自动领积分 ───────────────────────────────────────────────────────────┐
│ ( ● ) 每日自动领积分   [今日已自动领取]  上次结果：1 个账号领取成功（+10）  │
│                                                          [立即领取]      │
└────────────────────────────────────────────────────────────────────────┘
┌─ CodeBuddy (腾讯) ─────────────────┐ ┌─ WorkBuddy (国际版) ───────────┐
│ [完整能力] [本插件接管]   2/3 账号   │ │ [完整能力] [本插件接管]  1/1 账号 │
│ 账号 2/3  模型 38/38  剩余积分 1.2K  │ │ 账号 1/1  模型 23/23  剩余 ——     │
│ [新建账号][全部续期][刷新余额][领取] │ │ [新建账号][全部续期][刷新余额]     │
│  国内号 [启用] 有效期… 今日 +10      │ │  国际号 [启用] 有效期…            │
│  剩余积分 1.2K                       │ │  剩余积分 · 未返回余额数据        │
│  [停用][续期][查积分][领积分][探测]  │ │  [停用][续期][查积分][探测]       │
│  账号 │ 模型                         │ │  账号 │ 模型                     │
└──────────────────────────────────────┘ └───────────────────────────────────┘
```

### 页签二：OpenCode 免费层

```
┌─ OpenCode 免费层 ──────────────────────────────────────────────────────┐
│ [服务运行中] [无工具] [可看图]   12 个模型                               │
│ 本机 opencode serve 提供的免费模型，不需要账号、不需要登录。              │
└────────────────────────────────────────────────────────────────────────┘
┌─ OpenCode 免费层 ──────────────────────────────────────────────────────┐
│ [无工具] [服务运行中] [流式：SSE]   12 个模型                            │
│ 不能调用工具…适合标题、摘要、翻译。                                       │
│ [停止服务] [刷新目录]                                                   │
└────────────────────────────────────────────────────────────────────────┘
```
### 设计取舍（产品视角）

| 决定 | 为什么 |
|---|---|
| **页内分页，而不是侧边栏拆两项** | 侧边栏是「系统功能」的层级，免费模型是一个功能；两条车道的切换是高频动作，页内切换比「退出设置 → 找另一项 → 再进来」少三次点击 |
| **页签上带数字** | 切换前就知道对面有没有东西；数字由各页自己上报，不重复打接口 |
| **卡片汇总行带上剩余积分** | 「现在值不值得用它」是账号页的核心问题；藏进账号行里要展开两次才看得到 |
| **领取按钮按产品能力渲染** | WorkBuddy 国际版没有签到接口：不渲染，而不是给一个点了必然 404 的灰按钮 |
| **查不到余额显示原因，不显示 0** | 「查不到」与「用完了」要做的动作完全不同（续期/重登 vs 省着用） |
| **状态药丸三分**：就绪 / 需动作 / 不可用 | 「不可用」和「能用但没配好」是两种处境，合成一个词会让用户乱试方向 |
| **空状态直接给按钮** | 「暂无数据」是开发者的语言；用户要的是「点这里」 |
| **失败原因原样显示** | 这条链路能失败的地方有十几种（二进制不在、端口被占、限流、旧版本），藏进日志等于让用户猜 |
| **OpenCode 状态单列一行** | 「进程在跑」与「路由已挂载」是两个独立失败点，修法完全不同 |

## 积分：余额 / 一键领取 / 每日自动领取

三条能力都建立在 `src/core/credits.js` 的三个腾讯计费接口上
（`get-user-resource` / `checkin-activity-status` / `daily-checkin`）。

| 能力 | 接口 | 行为 |
|---|---|---|
| 余额 | `GET /api/free-model/credits?provider=buddy`（可加 `&force=1`） | 逐账号顺序查询，服务端缓存 60 秒；`force` 绕过缓存 |
| 一键领取 | `POST /api/free-model/claim` `{provider}` | 逐账号顺序领取（并发易触发风控），单个失败不中断，返回 `summary` + `results` |
| 自动领取 | `GET`/`POST /api/free-model/auto-checkin` | 一个总开关 + 一天一次 + 上次结果；`{run:true}` 立刻跑一轮 |

**为什么余额要独立一跳**：它为每个账号打一次上游请求，而 `/accounts` 是打开页面就
会调的轻量操作。混在一起会让账号列表被网络耗时绑架，且一次查询失败会把整份列表
打空 —— 于是「页面打不开」和「查不到余额」变成同一个现象。

**自动领取的状态文件是独立的**：本插件写
`$DSH_HOME/channel-pack/free-model-auto-checkin.json`，**不碰** OFM 的
`auto-checkin.json`。两个进程同改一份文档时，后写的会把前者的 `lastDate` 抹掉，
OFM 那边随即以为「今天已经跑过」而跳过它自己的十几个渠道。代价是两边的开关各自
独立（页面上写明了这一条）。

**没领到就不记「今天已跑」**：池为空或全部失败时不写日期，下次启动会重试；
否则今天新加的账号会被推迟到明天才自动领取。
## 实现要点

### 目录

```
index.js                 三条车道的装配（账号型 ×2 + 服务型 ×1）+ 积分能力位
src/channels.js          buddy 系通道装配（auth + adapter + 选号）
src/lanes.js             账号渠道注册表：OFM 侧 11 条车道的元数据（页面/能力/登录形态）
src/lanes/registry.js    三类渠道的统一注册表 + 就绪四态投影（页面与路由的唯一事实来源）
src/lanes/catalog.js     渠道记录校验 + 三层目录叠加（shipped / remote / local）
src/lanes/remote.js      远程渠道目录：拉取 / 校验 / 原子缓存 / 失败降级
src/lanes/service.js     服务型车道（opencode / FreeLLMAPI 网关 / Ollama）+ HTTP 探针
src/lanes/update.js      插件自身的版本检查（semver 比较 + 6 小时缓存 + 失败静默）
src/lanes/keyed/catalog.js  21 条自带 key / 免 key 车道的目录（每条带 evidence 与未确证标注）
src/lanes/keyed/ready.js    就绪判定：三种凭据形态 / 环境变量优先 / ref: 解引用
src/lanes/keyed/adapter.js  OpenAI 兼容适配器（SSE + 工具调用 + 图片 + 错误分类）
src/lanes/keyed/index.js    descriptors() / mount() / mountAll()（只出描述符，注册留给上层）
scripts/build-catalog.mjs   从随包渠道生成远程目录 catalog/channels.json（生成时自校验）
src/credits-service.js   余额 / 一键领取（缓存 + 并发合并 + 顺序领取）
src/auto-checkin.js      每日自动领积分（独立状态文件 + 一天一次 + 开关）
src/routes.js            /api/free-model/*（账号面 + /channels /catalog /update /service + opencode）
src/pool.js              账号池：宿主池优先，缺席时退化实现
src/live-pool.js         账号池的晚绑定门面
src/trust.js             HTTP 面的信任围栏
src/core/                buddy 全栈（从 v2.5.7 逐行移植，注释即踩坑记录）
src/opencode/client.js   opencode serve 的 HTTP 客户端（会话复用 + 增量流式）
src/opencode/adapter.js  DSH LlmAdapter（把 parts 翻成 chunk）
src/opencode/service.js  进程生命周期（探测 / 拉起 / 端口顺延 / 清理）
client.js                浏览器半身（一个设置项 + 三个页签 + 常驻目录/版本状态条）
```

### 流式是怎么做的（2026-10-23 改为 SSE）

opencode 的 `POST /session/{id}/message` 是**阻塞到生成完成**的，拿不到增量。
早先走轮询 `GET /session/{id}/message`（按 part id 记已发长度），能work，但
粒度是「上游写库的节奏」—— 实测同一 3 秒窗口里只有 **3 次** part 更新，
用户看到的是整段整段跳。

现在走 **SSE**（`GET /event`）：

1. `POST /session/{id}/prompt_async` → 204 立即返回；
2. 订阅 `GET /event`，只收本 session 的事件；
3. `message.part.delta`（`field: 'text' | 'reasoning'`）是**真 token 增量**
   —— 实测 26 帧 / 3 秒，约 40ms 一帧；
4. `message.updated` 带 `info.tokens` 取 usage；`session.idle` 收尾；
5. `session.error` **立刻**给出真实失败原因，不必等 120 秒 idle 超时。

轮询保留为**降级路径**：老版本 serve 没有 `/event`，或 SSE 被中间层掐断时
自动回退（只在「还没发出任何内容」时降级，避免重复文本）。

实测（2026-10-23，`ofm/codearts/glm-5.3`）：首块 1.9s，26 个 delta 帧，
usage `{input:131, output:54, reasoning:18, cacheRead:1920}`。

### 模型目录从哪来（2026-10-23 修正）

早先读 `/api/model`：一次 8887 条（4.9MB），其中 752 条属于本机配置的两个
provider —— 但**只有 `/config/providers` 里出现过的才真能调用**。实测
`opencode/space-bunny-free` 在 `/api/model` 里存在，prompt 却回
`Model not found`；而 `/config/providers` 里那 9 条全部可用。

现在读 `/config/providers`（471KB，1/10 体积）：一次拿全「已配置 + 能力 +
限额」，不会再给用户列出一堆点了就报错的模型，能力（`input.image` /
`toolcall`）也直接来自上游声明而不是猜。

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
# 主套件：52 项协议/路由断言 + 客户端离线渲染（不需要宿主、不发网络）
npm test

# 用真实宿主包验证契约（临时 link dsh-llm / dsh-credentials，跑完删掉）
npm run test:host

# 真实端到端（需要 opencode serve 在跑）
npm run test:e2e -- 'ofm/codearts/glm-5.3'
```

三套测试各挡一类错：

| 套件 | 挡什么 |
|---|---|
| `smoke.mjs` | 协议与路由：三条车道的注册/目录/元数据/stream chunk 序列、HTTP 面每条路由、信任围栏、让位语义；积分与自动领取用**假的 fetch** 打（不碰腾讯计费接口），状态文件写进临时目录（不碰真实 `~/.dsh`） |
| `render.mjs` | 白屏：用极小的 React 替身把组件树跑一遍（两个设置页都要注册、卡片的三条余额分支、自动领取条的四态）。`node --check` 只能抓语法错，抓不到「渲染时抛 ReferenceError」——而那正是白屏最常见的原因 |
| `host-check` / `host-apply` | 契约漂移：`instanceof LlmAdapter`、`providerInfo.id === provider`、`prepareCall` 返回 stream、`LlmError` code 被宿主认得 |

`test:e2e` 依赖本机装没装 opencode、以及免费层此刻有没有被限流，故**不进** `npm test`。

## 已知边界

- **WorkBuddy 国际版没有签到接口**：`daily-checkin` 在它的后端不存在，故这条车道
  上不会出现「一键领取」，自动领取也会把它跳过并标成「无签到接口」。
  （余额接口 `get-user-resource` 两边都有。）
- **自动领取的开关与 OFM 的开关各自独立**：本插件写自己的状态文件，见上文理由。
  两边同时开着不会重复领取（服务端对「今天已领」会明确回报），但会有两次无谓请求。
- **余额是「查得到才算」**：合计数只累计读成功的账号；查不到的账号会单独显示原因，
  不会被当成 0（否则卡片上的合计数看起来像「额度凭空少了」）。

- **OpenCode 免费层的失败有三种，处置完全相反，别混成一句「限流了」**
  （2026-10-24 修正：早先这里只写了下面第 2 条，还把当日额度误当成它的同义词）：

  | 类别 | 上游原文特征 | 该怎么办 |
  |---|---|---|
  | **① 当日额度耗尽** | `Free usage limit reached. Subscribe to OpenCode Go to keep going` | 按天重置，**北京时间 08:00**（UTC 0:00）恢复。在此之前重试无效；换成同池的其它 `*-free` 模型通常也无效。要立刻干活就换通道（例如本机 OFM 网关的 `ofm/*`）或订阅 Go |
  | **② 调用方身份被拒** | `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode` | 这是 **build 级事实，重试永不恢复**。2026-10-23 复验：连 `opencode serve` 自己发出的请求都被同样拒绝（试过 Authorization / x-api-key / UA / x-opencode-session 五种组合，全 403）。出路是升级 opencode 的 build，或换通道 |
  | **③ 限流** | `429` / `rate limit` / `too many requests` | 等一两分钟，或换个模型 |

  插件做的是：**按类别分开报**（`adapter.describeUpstreamFailure()` 里额度分支排在限流
  分支**之前**，否则会被限流正则误伤），并在卡片上标出具体原因，别让人一直重试那件
  永远不会成功的事。
- **OpenCode 车道不支持工具**（见上）。
- **OpenCode 车道支持图片**（2026-10-23 修正）：`/config/providers` 里 4 个
  免费模型声明 `input.image`，图片经 `FilePartInput` 的 `data:` URL 发送
  （实测 204，上游确实收到）。`inputModalities` 按上游声明逐模型给出，
  不再一律 text。
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

# CHANGELOG · dsh-free-model

格式：`## [版本] · 日期` → `### 新增 / 改动 / 修复 / 证据`。
写下来的规矩：**每条都要能被验证**（命令、文件、实测输出），做不到就标 `未实测`。

## [0.6.0] · 2026-10-26

> 主题：**渠道从 21 条扩到 34 条（另加 3 条本地推理服务车道）**，每条带本轮实测证据；
> 并给每条渠道加上**跨重启的健康与冷却记账** —— 因为渠道一多，"全都绿"这个信号就失效了。
>
> 本轮还并行做了一次**自我审计**（`_overnight/research/free-model-audit.md`），
> 修掉 4 个 P0 + 4 个 P1：那些缺陷全部**被测试替身掩盖**（数组替 Map、远程目录从不放
> keyed、SSE 用例一律以 `[DONE]` 收尾），是全绿状态下真实存在的错。

### 新增

- **`src/lanes/keyed/catalog-more.js`（第二批 10 条车道）**：gitee-ai / qwen-intl /
  huggingface-router / chutes / novita / deepinfra / zai / xiaomi-mimo / kimi-coding /
  zai-coding-cn。文件头同时记下同一轮实测**否掉的 9 个候选**与理由（kluster、lambda 连不上；
  ai21 目录为空；cohere 回 HTML；sensenova 404；**lingyiwanwu 410 已停服**；puter 无兼容目录；
  openai / deepseek-official 是按量不是免费）。`catalog.js` 的 `KEYED_CHANNELS` 改为
  `[...第一批, ...第二批]` 的拼装，两批数据的实测日期与判据因此各自可读、可单独回滚。
  其中 `kimi-coding` / `zai-coding-cn` 是本插件第一次有**订阅套餐车道**（5h+7d 双层窗，
  与按量 key 不通用），`note` 里把这件事写死了。
- **`src/lanes/health.js`（健康账本）**：纯函数 `classifyFailure` + `createHealthStore`。
  判据表写在模块头：401/403 → **吊销**（永不自动恢复）；402/quota → 冷却到「下一整点 + 6h」；
  429 → 60 秒基准并尊重 `Retry-After`（封顶 30 分钟）；5xx/超时/网络 → 30 秒基准**指数退避**；
  404 → 6 小时长冷却且不参与退避；**400 / 模型名错 / 上下文超限 / 用户主动停止 → 不记**。
  半开不是第五个状态，而是 `halfOpen:true` 标记（到期只放一次探测）。
  落盘 `$DSH_HOME/free-model/health.json`，原子写（.tmp → rename），文件损坏从空状态起（warn 一次不抛）。
  记录结构里**结构上就没有凭据的位置**（只存 laneId + 分类字段；错误文本 200 字符截断 + 长串遮蔽）。
- **健康记账的两个入口**：
  ① `POST /key/probe`（用户点「测试 key」）——`no-key` / `missing-config` **不记**
  （那是本插件自己的配置问题，记成渠道故障会让"还没填 key"显示成"冷却中"）；
  ② **真实对话**（`adapter` 新增 `onOutcome` 回执）—— 全部 5 处失败抛出点收敛到 `#fail()`，
  成功在 `finish` 前回执（空响应 / 内容过滤**不**回执：那是输出选择，不是渠道健康问题；
  用户主动 abort **不**回执）。
- **`healthKindOf()`（词表翻译表，导出）**：适配器的 `FAILURE_KINDS` 到账本分类的显式映射。
  两层回答的是不同问题（一层管"这次请求怎么办"，一层管"这条渠道还要不要用"），所以做翻译而不是透传；
  `unknown-model` / `context` / `invalid-request` / `aborted` 一律 `null`（不记）。
- **HTTP 面**：`GET /health`（账本快照，每条带一句人话 `text`）、`POST /health/reset`（`{lane?}` 单条或全清）。
- **页面（自带 key 页）**：
  - 每张卡多一颗 **健康徽章**（`HealthPill`，绿/黄/红/灰四色，带剩余时间或"只放一次探测"）；
    灰 ≠ 红：灰是"还没测"，不是"坏了"。
  - 页头多**搜索框**（渠道名 / 凭据名 / 端点 / 模型样例都能命中）与**五个筛选胶囊**
    （全部 / 就绪 / 待配置 / 冷却中 / 已吊销，每个胶囊自带数字 —— 既是筛选器也是汇总行）。
  - 卡片多一行**模型样例**（前 5 个 id），让"这条渠道能调什么"不用点开就知道。
  - 「清掉健康状态」按钮：换完新 key 之后，旧 key 的 401 会把它永久钉成"已吊销"，
    没有这个按钮就得等宿主重启。
  - 底部汇总行 `共 N 条 · 就绪 x · 待配置 y · 冷却 z · 吊销 w`。
  - 被筛空时说「换个关键词」并给回全部按钮，**不复用**「暂无渠道」那句（那会让人以为渠道丢了）。
- **`registry.js` 投影多 `modelSample`（前 8 个 id）**：字段名刻意不叫 `models` ——
  后者会让人以为这是完整目录，于是拿它去渲染需要全量数据的界面。

### 修复

- **`formatDuration` 把 90 分钟说成「2 小时」**（0.6.0 开发中实测暴露）：
  四舍五入让冷却看起来比实际更长。改为「1 小时 30 分钟」（余数 < 5 分钟才省略）。
  冷却时间的任务是让人决定"还能不能等"，宁可多说一段也不要报大。
- **搜索曾经搜不到模型名**：`/channels` 投影里没有全量 `models`，前端却按 `row.models` 匹配 ——
  那条路径永远为空。改读 `modelSample`，由 `test/render.mjs` 钉住。
- **写 `package.json` 时带进了 UTF-8 BOM**，导致 `test/smoke.mjs` 的两条断言
  （`version 与 package.json 一致`、`client bundle 用包名注册`）读 JSON 直接抛
  `Unexpected token '﻿'`。已剥 BOM。

### 证据（本机实测）

| 断言 | 怎么验的 |
|---|---|
| 30 条 keyed + 1 条 keyless + 1 条已下线，统计自洽 | `node -e "import('./src/lanes/keyed/catalog.js').then(m=>console.log(m.catalogStats()))"` |
| 新增 10 条的 evidence 全部带 `GET https://…` 与本轮日期 | `node test/keyed/catalog-more.mjs` → `pass=14 fail=0` |
| 被否掉的 9 个候选没混进任何渠道表 | 同上（`ALL_CHANNELS` 全表扫描） |
| 健康分类 7 档 + 4 档不记 + 指数退避 + 半开 + 落盘 + 脱敏 | `node test/lanes-health.mjs` → `pass=29 fail=0` |
| 词表翻译表六个记账 / 四个不记 | `node --import ./test/hooks.mjs test/keyed/manage-health.mjs` → `pass=11 fail=0` |
| 健康徽章四档文案互不相同、冷却带剩余时间、筛空给对文案 | `node test/render.mjs` → `pass=51 fail=0` |
| 端点全量复查 | `node scripts/probe-endpoints.mjs` → 可达 **29/31**（10 alive-open / 19 alive-needs-auth / 2 目录已声明） |
| 远程目录重生成且与随包一致 | `node scripts/build-catalog.mjs` → 34 条 / 55,789 字节；`--check` 通过 |
| 全量回归 | `npm run check`（78 文件）→ 全过；`npm test` → 9 套 `fail=0`；`npm run test:host` → 18 项全过 |

### 补记（同一天晚些时候，审计驱动）

- **渠道再 +4 / 服务车道 +3**：fireworks、hyperbolic、upstage、reka（同轮实测 401 活着）；
  服务车道加 LM Studio（1234）/ vLLM（8000）/ llama.cpp（8080）—— 本机此刻一条都没跑，
  页面会如实说「连不上」，这比「插件不认识我的本地服务」有用。
  目录总条数 34+1+1（keyed/keyless/retired）+ 6 服务 = **41 条**，远程目录 63,831 字节。
- **P0（审计发现，全部被测试替身掩盖）**：
  1. `registry` 只认 Set/数组，而生产传的是 **Map** → buddy/workbuddy 永远显示
     「通道未挂载（见宿主日志）」。三种形状现在都认，并补了 Map 的回归断言。
  2. `buildRegistry` 把远程/本地目录里的 **keyed 渠道静默丢弃**（连 rejected 都不进）——
     「加渠道不用发版」此前对 keyed 完全不成立。现在随包 keyed 也算 shipped 层的一部分，
     远程/本地按 id 覆盖，被拒的进 rejected 并在页面上显示。
  3. **SSE 断流被判成正常结束**（没有 `[DONE]` 也没有 finish_reason）→ 半截回答无错，
     还把渠道记成健康 OK。现在判 `STREAM_CUT` 并记一次抖动冷却。
  4. 前端 `call()` **没有超时** → 后端挂住时按钮永久停在忙态。现在默认 12 秒
     （起服务 45 秒），超时给一句可读原因。
- **P1**：服务探针缓存判据写反（任一条 down 就不复用缓存 → 反复打本地端口）；
  自带重试策略（原来交宿主默认 **5 次 / 500ms**，对串行限速的 pollinations 会刷穿配额，
  现在普通渠道 1 次、串行限速渠道 0 次）；本地覆盖文件与远程目录同一把尺子
  （字节上限 + 版本闸门）；探测分出 **dns / tls** 两档（原来压成 network，
  对证书错误给的处置方向是错的）。
- **UI 补三处**：被拒的目录记录终于渲染（否则本地文件写错时页面一片平静）；
  探测结果带 `Retry-After` 的「等多久」；窄屏断点（卡片收一列）。
- **`openCatalog` 升为正式字段**：9 条实测「/models 免 key 可读」的渠道，
  由校验器 → 注册表 → 页面统一挂「通过≠有额度」的提示，名单在测试里钉死。
- **cloudflare-workers-ai 补 `supportsModelList:false`**（两轮实测 405）：
  没声明时每次打开模型选择器都先打一个必然失败的地址再等超时。

### 补记 2（同一天，审计 + 竞品横评的后续三批）

- **同渠道多 key 轮换**（审计 P0-6）：`resolveApiKeys` 认基名 + `__N` 后缀、
  也认单条目里的逗号/换行分隔，上限 5 把；适配器持游标，**credential / rate-limit / quota**
  三类失败换下一把重试一次（其余类别换 key 没意义）。踩坑记录：第一版「整体 decode 再 split」，
  而解码器会拒含控制字符的值 → `k4,k5\nk6` 被整条丢掉；改成**先切再逐段解码**。
- **余额/额度探针**（`src/lanes/keyed/balance.js`）：市场调研的结论是「现有插件只把余额做进看板，
  没有一家喂回路由」—— 本插件也不喂（宿主没有扩展点），先做到**看得见**。
  认三种形状（直接余额字段 / OpenRouter 的 充−用 / 认不出就如实说并列出字段名）；
  **金额全程字符串**（自写十进制减法，避免 `0.30000000000000004`）；端点地址**不下发**给页面。
  四条渠道带端点：openrouter-free / moonshot / siliconflow / novita。
- **读「上游已改名/下架」**（审计 P1-7）：每次拿到实时目录后与静态表比交集，**零交集**才记
  `renamed-or-retired`（部分交集不报：上游天天加模型），卡片上显眼位置给一句可执行的提示。
- **P1/P2 三件**：目录拉取并发去重 + 失败冷却 10s→60s（原来失败后 10 秒又能打，而单次超时上限 20 秒）；
  探测并发去重（`force` 只跳过结果缓存，不跳过去重）；SSE **心跳帧**与坏帧分开计数
  （网关推 `data: 0` 当心跳时，原来 5 帧后会把一条正常渠道判成「对面不是 SSE」）。
- **UI**：排序（推荐顺序 / 名称 / 模型数 / 健康）；被拒的目录记录渲染；Retry-After 倒计时；窄屏断点。
### 补记 3（同一天：试调 + 渠道开关 + B 车道的真实对话证据）

- **「试一句话」（`POST /key/try`）**：只有它能回答「我填的 key 到底能不能干活」。
  `/models` 是目录端点 —— 有的渠道免 key 可读、有的在**边缘**就被挡（B 车道实测到 Groq 的
  Cloudflare 403：**带 key 与不带 key 同一个码**），所以「目录探测通过」证明不了能调。
  实现：最小真实补全（max_tokens=4、非流式、12 秒超时），沿用同一套 kind；
  成功时回前 80 字符可见文本。**不写健康账本** —— 用户主动诊断不等于渠道在工作流里的表现，
  记了会让「我试的时候它正忙」变成一条莫名其妙进冷却的渠道。
- **渠道开关**（`POST /channels/toggle`）：30+ 条渠道里真正常用的就两三条，其余的不该
  每次都占模型选择器的位置。关掉 = ① 启动时不挂它的适配器 + ② 运行时闸门拒绝请求；
  **与「清除 key」刻意分开**（用户想的是「先别用它」而不是把配置抹掉重来）。
  状态落盘 `$DSH_HOME/free-model/disabled-lanes.json`（原子写、坏文件从空集起）。
  关的时候会尽力释放路由，但**不依赖**宿主给 disposer —— 闸门保证「关掉」这件事在任何
  宿主版本上都成立。
- **真实对话证据回灌目录**（B 车道跑出，A 车道写回）：openrouter-free **200 / 1919ms**
  （本插件第一条被真跑通的渠道，且 pricing cost=0）、pollinations 200 / 13862ms
  但**忽略 max_tokens**（要 8 个回 534 个）、groq 边缘 403。这三条都写进了各渠道的
  `evidence` / `note`。
### 未实测 / 边界

- **新渠道的真实对话未在本轮跑**：10 条新增里 8 条需要 key（本机没有），
  验证到"端点活着且已鉴权"（401/403）与"目录可读"（200）为止。
  `kimi-coding` / `zai-coding-cn` 的 `/usages`、`coding_plan/remains` 套餐窗口
  **本插件暂不消费**（要单独解析，且形态各家不同），页面上也不显示套餐剩余。
- **健康记账的"按模型分档"未做**：现在是渠道级（一把 key 挂了，它下面所有模型都挂）。
  真要按模型分，改的是账本的键，不是 `isAvailable` 的签名。
- **`/health` 不参与路由决策**：账本已经知道"这条在冷却"，但 DSH 的模型选择器仍会把它列出来
  （宿主没有"按健康过滤模型"的扩展点）。当前只做到"让用户看见"，没做到"自动摘掉"。

## [0.5.0] · 2026-10-25

> 主题：**把「宿主 channel-pack 的那 11 条账号车道」整体移出本插件**，改由独立插件
> `dsh-ofm-lanes` 提供。本插件只留自己挂载的两条腾讯车道 + 服务车道 + 自带 key 车道。

### 改动

- **移出**：`src/lanes.js`（11 条车道的元数据 + `/api/channel-pack` RPC 常量）整个文件删除；
  `src/lanes/registry.js` 的 `ofmAccountRecords()`、`hostCategoryOf()`、`backend === 'ofm'`
  就绪分支；`src/routes.js` 的 `rejectOfmLane()`、route 投影的 `'ofm'` 档、
  `/summary` 里的 `ofm: { available, rpcPath }`；`index.js` 的 `ofmBackend` / `ofmRpcPath`
  deps 与装配自证字段。`GET /api/free-model/summary` 的 `products` 从 13 条降到 2 条
  （账号车道只剩本插件自己挂的两条），装配自证里 `channels.account` 从 13 变 2。
- **页面**：`client.js` 删除 `ofmCall()` 与整段 OFM 侧读写逻辑（11 条车道的账号 / 模型 /
  余额 / 登录 / 短信备用路径）、`ProductCard` 里只服务于那一侧的分支
  （`isOfm` / `ready` / `backendNote` / `balanceNote` / `rowClaim` / 短信表单）与对应 CSS、
  中英字典里 30 余条词条。账号页现在只渲染 `buddy` / `workbuddy` 两张卡。
- **`backend` 枚举收缩**为 `native` / `gateway`：本插件的注册表里不再有「不是自己挂、
  也不是别人已挂」的记录，保留一个用不上的取值只会让校验器放过页面渲染不出来的渠道。
- **文档**：README 删掉「账号渠道：13 条车道」「两条后端，页面自己选」
  「宿主没装时（降级）」「为什么不把这 11 条也自己挂一遍」等整节，改为说明拆分去向与
  仍然成立的命名冲突 / 双 auth 实例两个理由；仓库描述与 topics 同步去掉相关表述。

### 未变

- 账号池仍然晚绑定：宿主提供 `accountPool` 就直接用它的池，缺席时退化为 `LocalPool`，
  两种形态读写**同一份** `$DSH_HOME/channel-pack/state.json`。
- `src/core/**`、`src/opencode/**`、`src/lanes/keyed/**`、`src/lanes/service.js`、
  `src/lanes/catalog.js`、`src/lanes/remote.js` 的既有行为未动。

### 证据

- `npm run check` → `OK  语法门：73 个文件 node --check 全过（产品 43 / 测试 27 / 脚本 3）`
- `npm test` → 17 个套件全绿、零 fail（`通过 24 / 12 / 9 / 16 / 13 / 25 / 41 / 22 / 22 / 52 / 44 / 11 / 15 / 29 / 22 / 17 项`）
- `grep -rn "ofm" index.js client.js src/routes.js src/lanes/registry.js` → 0 命中；
  `test/lanes.mjs` 已删除。

## [0.4.1] · 2026-10-25

> 主题：**自带 key 那一页从「只告诉你去哪拿 key」变成「能填、能测、能清」**。
> 顺带修掉一个静默 bug：插件读凭据时给宿主补了 `ref:` 前缀，而宿主只认裸名。

### 新增

- **`src/lanes/keyed/keys.js`（凭据面）**：`validateKeyInput`（非空 / 长度 / 控制字符 /
  空白）、`maskKey`（`sk-t…6789`，**永不回显原文**）、`saveLaneKey` / `clearLaneKey`
  （写宿主凭据的同名条目）、`laneKeyState`（已配置 / 来源 / 能否写 / 脱敏值）。
  一切读写都走注入的函数，**不自己读 `.credentials.yaml`** —— 宿主换 `DSH_HOME`
  时自己读会静默读错文件。
- **`src/lanes/keyed/probe.js`（这才是「测试连通性」的正确做法）**：优先 `GET {baseURL}/models`，
  声明了 `modelsURL` 的按它探，都没有的退回一次 1-token 补全。结果按
  `ok / no-key / invalid-key / forbidden / quota / rate-limited / not-found / bad-request /
  server-error / network / timeout` **十一种**分开报。
  关键区分：**401 说的是「key 不对」，429 说的是「key 是对的、等一会」，超时说的是「网络」**
  —— 合成一个「失败」就等于告诉用户「这条渠道坏了」，方向完全错。
  没有 key 时**不构造请求**；上游错误体先遮蔽疑似凭据再回显。
- **`src/lanes/keyed/manage.js`（运行时管理器）**：持有 `laneId → { adapter, handle }`，
  于是「现在填 key」能落在**当前运行态**上：已挂载的走 `adapter.setApiKey()`（不重注册，
  否则撞 `DUPLICATE_ADAPTER`），未挂载的就绪后立刻挂上。清除 key 时**路由故意保留**
  ——适配器抛 `MISSING_CREDENTIAL` 并带上「去哪拿 key」，比让模型从选择器里静默消失好。
- **HTTP 面**：`GET /key`（凭据面状态，**不含原文**）、`POST /key`（保存，回脱敏值）、
  `DELETE /key`（清除）、`POST /key/probe`（探测）、`POST /key/refresh`（重算就绪）。
  探测失败仍是 **200**：那是「探测完成、结论是不通过」，不是请求错误。
- **页面**：每张卡多三段 —— 凭据面（已填/未填 + 脱敏值 + 来源）、填 key 表单
  （`type=password`、回车即保存、显示/隐藏、清除）、探测按钮与分类结果。
  输入框在提交**前**就清空本地 state：明文不进 DOM 快照。
  页头多一颗「已配 N」的药丸。

### 修复

- **凭据读取给宿主补了 `ref:` 前缀（静默失效，2026-10-25 本机实测确认）**。
  `index.js` 原先把名字拼成 `ref:${name}` 再交给 `ctx.credentials.resolve()`。
  实测对照：

  ```text
  resolve('DEEPSEEK_API_KEY')      → { value: 'sk-e8b…', source: 'file' }
  resolve('ref:DEEPSEEK_API_KEY')  → undefined
  ```

  宿主的引用文法就是环境变量名本身（`@deepseek-ai/dsh-credentials` 的
  `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`），`ref:` 是**本插件目录里**的记号。
  后果不是报错而是**静默 undefined**：用户在 `.credentials.yaml` 里配好了 key，
  页面永远说「未配置」，日志里一个字都没有。现在 `readCredential` /
  `writeCredential` / `unsetCredential` / `describeCredential` 统一先剥前缀再传裸名，
  并由 `test/host-keyed.mjs` 的「凭据读取传的是裸名」一条钉住。
- `mountKeyedLanes` 的 `keyedFailed` 落盘时改成只记 id：原来是 `{id, reason}`，
  而 reason 里带 baseURL 与凭据名，自证文件不该有这些。

### 证据（本机实测）

| 断言 | 怎么验的 |
|---|---|
| `ref:` 前缀让 resolve 静默返回 undefined | 直接实例化 `LocalCredentialProvider` 读真实的 `~/.dsh/.credentials.yaml`，两种形态对照打印 |
| 20 条 keyed 车道里 0 条 baseURL 未确证 | `node test/keyed/catalog-shape.mjs` |
| 没 key 的车道一条都没挂上 | `node test/host-keyed.mjs`（真实宿主包跑 `apply()`） |
| 401 / 429 / 超时 / 网络各自分类 | `node --import ./test/hooks.mjs test/keyed/keys-flow.mjs` |
| 保存不泄漏原文、GET 不回显 | `node --import ./test/hooks.mjs test/routes-channels.mjs` |
| 离线全量 | `npm test`（含新增 keys-flow，18 个套件全绿） |

### 未实测 / 边界

- **真实上游探测未在本轮跑**：探针代码走的是真实 `fetch`，但离线套件全部用桩，
  `npm run test:live` 依然需要用户自己填一把真 key 才会打公网。
- 清除 key 不会撤销已挂载的路由（刻意的）：模型在选择器里仍在，选它会得到一条
  「去拿 key」的错误 —— 换到的可读性优于「模型莫名消失」。

## [0.4.0] · 2026-10-25

> 主题：从「三条车道」变成**渠道总台** —— 三类渠道一种形状、渠道清单可远程更新、
> 就绪状态问运行时而不是猜。

### 新增

- **`src/lanes/registry.js`（渠道注册表）**：账号 / 服务 / 自带 key 三类渠道收敛成
  同一种记录形状，按 `账号 → 自带 key → 服务` 稳定排序；`projectRegistryView()`
  给出就绪**四态**（`ready` / `needs-action` / `unavailable` / `unknown`）。
  四态刻意分清：合成一个词会让用户乱试方向。
- **`src/lanes/keyed/**`（21 条自带 key / 免 key 车道）**：20 条 keyed + 1 条 keyless
  （`pollinations`）。每条 baseURL 都有实测或官方文档作 `evidence`（未确证的 baseURL：**0 条**）；
  一条适配器通吃（OpenAI 兼容、SSE、工具调用、图片、错误分类 credential/quota/rate-limit/connection）。
  `github-models` 已确认 2026-07-30 下线，进 `RETIRED_CHANNELS`，**不进可挂载集合**。
- **`src/lanes/catalog.js`（目录层）**：三层叠加 `shipped ← remote ← local`，同 id 整条覆盖；
  `pinned: true` 的记录**不吃远程覆盖**（但本地仍能改 —— 否则钉住就锁死了）。
  远程数据当**不可信输入**校验：URL 不许带 query/hash、不许内嵌凭据、探针只认 GET/HEAD、
  `service` 必须有探针、`apiKeyEnv` 只认大写凭据名；不合格整条丢弃并记账。
  `keyless` 是 `keyed` 的别名，落库归一（`kind: 'keyed'` + 无 `apiKeyEnv`）。
- **`src/lanes/remote.js`（远程渠道目录）**：https-only；`catalogVersion` 不认识就**整份拒绝**
  （半份目录会让渠道莫名消失，那种错最难查）；256KB 上限；原子写缓存（临时文件 + rename）；
  失败**只降级不抛** —— 退到缓存、再退到随包数据。
- **`src/lanes/service.js`（服务车道 + 探针）**：`opencode`（可代起）/ `FreeLLMAPI 网关` /
  `Ollama`。探针 3 秒超时、三条并发（串行最坏要等 9 秒）。`401` 也算「进程活着」并单独报
  「缺凭据」——「去起服务」和「去填 key」是两件不同的事。
  探针结果的缓存**不在本文件**：状态与双 TTL 判定在 `index.js:127-128,229-243`
  （`probeServices()` 成功 30 秒内不重探，有服务不可用则按 `SERVICE_PROBE_FAILURE_TTL_MS`
  退避；这两个常量仍定义在 `service.js`）。
- **`src/lanes/update.js`（版本检查）**：读 `raw.githubusercontent.com/<repo>/main/package.json`
  而不是 GitHub Releases API（前者不收限、且不会落后于仓库）；无依赖的 semver 比较
  （`0.4.0-rc.1 < 0.4.0`）；6 小时缓存；**失败静默且信息完整**（本机直连 GitHub 常不通，
  这条路径默认就会失败，更要把失败表现得无害）。
- **`scripts/build-catalog.mjs`（远程目录生成）**：从随包渠道生成 `catalog/channels.json`，
  生成时**用插件自己的校验器过一遍**，不合格就拒绝生成并非零退出；`npm run catalog:check`
  （`--check`）不写盘，把这次生成的结果与已提交的目录**逐条**比对（`updatedAt` 是生成日期，
  不参与比较），不一致就非零退出。**CI 会跑它**：`.github/workflows/test.yml` 是三步
  —— `npm run check` → `npm test` → `npm run catalog:check` —— 「改了随包渠道、
  忘了重新生成远程目录」在 CI 就红。
- **HTTP 面新增**：`GET /channels`、`GET /catalog`、`POST /catalog/refresh`、
  `GET /update`、`POST /update/refresh`、`GET /service`、`POST /service/probe`。
  未接线时**明确报错**（`503` 或 `wired:false`），而不是回一份空的「一切正常」。
- **页面（`client.js`）**：三个页签（账号渠道 / 本地与网关 / 自带 key）+ 常驻状态条
  （目录 sha256 / 来源 / 拉取时间 / 「远程 N 条·本地 M 条」+ 检查目录 + 插件版本 + 检查更新）。
  自带 key 卡带能力徽章、四态药丸、`freeTier`、凭据名（等宽）、「去拿 key」链接。
  **刻意不做**：给没 key 的渠道渲染「测试连通性」（点了必失败会被读成「渠道坏了」）、
  代跑升级命令、编造目录版本号。

### 改动

- `index.js` 的车道清单改由注册表产出；`LANE_CREDITS` 从 `index.js` 迁到注册表
  （「哪家有签到」是产品事实，和渠道元数据放一起才不会两处分叉）。
- `/summary` 的既有契约**逐字保留**（`products` / `serviceLanes` / `ofm` 字段不变），
  新能力只走新字段与新接口 —— **新能力走新接口，老接口语义不动**，升级不该把用户的页面搞坏。
- 自家渠道（native / OFM / 服务）也过一遍**与远程数据同一套**规范化：形状一致 + 同一把尺子。

### 证据

| 命令 | 结果 |
|---|---|
| `npm run check` | 70 个文件语法全过（产品 41 / 测试 27 / 脚本 2） |
| `npm test`（16 套件） | **328 项断言全绿** —— 注册表 25 / 目录 IO 12 / 版本检查 9 / 路由 10 / keyed 13+25+22+22 / 车道表 6 / smoke 52 / 渲染 38 / opencode 全套 94（`fd77ba5` 补了字节/字符回归断言，目录 IO 10→12，原记的 326 已过期） |
| `node test/host-apply.mjs` | 用**真实** dsh-llm / dsh-credentials 跑 apply：3 条老车道全在，0 warnings |
| `node test/host-keyed.mjs` | 免 key 渠道**真被挂上**；缺 key 的 20 条一条都没挂，且原因里带凭据名（或指出待填占位符） |
| `node scripts/build-catalog.mjs` | 生成 24 条渠道的远程目录（36,621 字节），自校验 0 拒绝 |
| `npm run catalog:check` | `OK catalog/channels.json 与随包渠道一致（24 条，逐条比对）`，EXIT=0 |
| `npm run test:live` | 免 key 渠道真联网：通过 4 项，真跑通一次对话（本次实测 884ms，「OK」）；`listModels` 走静态表（`source=static`，不发网络请求）；上游不可用时记 `BLOCKED` 且仍退出 0 |

### 复核后补的修复（2026-10-25，独立复核 `_overnight/research/DOC-CODE-REVIEW.md`）

- **`src/lanes/remote.js` / `scripts/build-catalog.mjs` 的字节 vs 字符**：远程目录上限写的是
  256KB **字节**，判据却用了 `String.length`（UTF-16 码元）—— 中文渠道名一个字符占 3 字节，
  等于把上限放宽了约 3 倍，报错文案还写「字节」。现在两处都改 `Buffer.byteLength(text,'utf8')`，
  并加了回归断言（字符数未超、字节数超了必须拒绝）。
- **404 + 没有 token**：本仓库默认私有，`raw.githubusercontent.com` 对私有仓库一律 404（本机实测）。
  现在 `fetchRemoteCatalog` 接受 `token`（只进请求头，不进 URL/不落盘/不出现在返回值），
  并在「404 且无 token」时返回 `needsToken: true` + 点明原因的文案；README 补上三条可选路径。
- **`test/host-apply.mjs` 的刚性断言**（复核指出的脆弱点）：原写 `adapters.size === 3`，
  而 keyed 车道是异步装载（免 key 渠道先落地就会变 4 条）→ 换机器/慢盘可能假失败。
  改成「三条老车道必须在，多出来的只允许是 keyed 目录里的 id」。
- **新增 `scripts/probe-endpoints.mjs`（端点健康探针）**：渠道URL是会变的（换域名、下线、改路径），
  而插件把「能不能用」的责任交给了运行时 —— 目录里的 URL 错了，用户看到的是「配了 key 还是 401/404」，
  最难查。这个探针**不带凭据**地对每条渠道探 `{baseURL}/models`，按状态码分类：
  `401/403 = 端点活着且要凭据（最健康的一档）`、`200 = 免凭据`、`404/405 = 路径或方法不对`、
  `连不上 = 本机此刻不可达`。目录自己声明过的两种例外（`supportsModelList:false`、
  `placeholders:['{ACCOUNT_ID}']`）算**预期**不算可疑，只有当「声称能列模型且无占位符」的渠道
  突然 404 时才以非零退出码报警 —— 那才是真该有人去看的事。默认只打印，不往仓库写文件。
  **2026-10-25 06:50 实测（本机直连，无代理）**：`19/21 可达`
  （14 条 401/403 = 健康且要凭据、5 条 200 = 免凭据），2 条非 200 且都与目录声明一致
  （`google-ai-studio` 404 × `supportsModelList:false`、`cloudflare-workers-ai` 405 × `{ACCOUNT_ID}` 未填）。
- **CI 从来没跑过目录校验**（复核 ⑤）：`.github/workflows/test.yml` 现在是三步
  `npm run check` → `npm test` → `npm run catalog:check`；同时把 `--check` 从「只比条数」
  改成**逐条比内容**（`updatedAt` 是生成日期，不参与比较）—— 只比条数时改一条 baseURL
  照样绿，等于没校验。
- **CI 也没跑过语法门**（同一条复核线：CI 的覆盖面比发版清单窄）：`test.yml` 现在**第一步**
  就是 `npm run check`（当时是 19 个产品文件 `node --check`，只用 Node 内建、**不需要
  `npm install`**；现已扩到全仓遍历，见下一条）。
  放在套件之前是刻意的：这条是常数级耗时，语法一改坏就在第一分钟红，不必等全套测试跑完；
  以前语法错只能靠发版前手动跑，CI 全绿也说明不了代码能解析。

### 语法门覆盖到测试与脚本（2026-10-25）

- **`npm run check` 从 19 个产品文件扩到全仓 70 个 `.js` / `.mjs`**：新增
  `scripts/check-syntax.mjs`，遍历 `index.js` / `client.js` / `src/**` / `test/**` /
  `scripts/**`，逐个 `node --check`；只用 Node 内建（fs / path / child_process），
  **不引第三方、不需要 `npm install`、不联网**。`package.json` 的 `check` 改为调用它。
- **为什么是遍历，而不是继续手写 `node --check a && node --check b …`**：旧列表只写了
  19 个产品文件（17 个 `src` + `index` + `client`），`test/**` 与 `scripts/**` 从未进 CI；
  而 `npm test` 只跑 16 个离线套件，`e2e-opencode`、`host-check/apply/keyed`、`keyed-live`、
  `service-start`、`opencode-affinity`、`boot-serve` 这些「只在本机手动跑」的套件里
  写坏一处语法，CI 仍然全绿。遍历还顺手补上 22 个此前未列的产品文件（`src/core/**` 等），
  并且以后新增测试文件自动纳入闸门，不再依赖「记得同步列表」。
- **证据**：`npm run check` → `OK  语法门：70 个文件 node --check 全过（产品 41 / 测试 27 /
  脚本 2）`，EXIT=0（本机 Node 24.19，约 8.4s，CI 两个腿都实跑）。反向验证：往
  `test/e2e-opencode.mjs` 尾部追加一行 `function broken( {` → `FAIL 语法门：
  1/70 个文件解析失败` + `- test/e2e-opencode.mjs`，EXIT=1；`git checkout` 复原后
  sha256 与改前一致。`npm test` 仍 16 套件 / 328 断言全绿。

- **新增装配自证 `$DSH_HOME/free-model/apply-ok.json`**：headless/CLI 模式不打 info 日志，
  「插件装上了吗」只能靠猜；装配又是异步分片的（native 在 inject 回调、keyed 是 `void mountKeyedLanes`），
  任何一片失败只留一行 warn。现在把结果落盘：版本 / 时间 / **已挂上的路由** / OFM 后端在不在 /
  目录层计数与指纹，**不含任何凭据值**。它是**历史记录**（`appliedAt` = 上次装配时刻），不是存活标记 ——
  第一版在卸载钩子里删掉它，结果一次性 headless 会话里永远看不到（装配时写、退出时删），
  而「昨天装上了吗」恰恰是事后要问的问题。
  **真宿主进程内验证**（`_supervisor/plugin-boot-check.mjs`，用 A 的 headless profile 起真会话）：
  `version 0.4.0 / phase full / mountedRoutes [buddy, opencode, pollinations, workbuddy] /`
  **`ofmBackend: true`**（宿主 channel-pack 在同一进程里在场）/ `channels {13, 21, 3, 37}`。

## [0.3.2] · 2026-10-24

- 合并 `wip/lanes-registry-20261024`：账号渠道页补齐 OFM 侧 11 条车道（页面 + 管理面，
  后端转发给宿主 RPC，**不重复挂载**）；`package.json` 的 `check` / `test` 取并集，七套件全留。

## [0.3.1] · 2026-10-24

- OpenCode 车道：`request()` 的 180s 超时定时器在所有出口清理（离线套件不再被拖住 3 分钟）；
  CI 恢复离线套件工作流。

## [0.3.0] · 2026-10-23

- OpenCode 车道的失败按类别给徽章与说明（额度 / 身份 / 限流）；
  SSE 流式、配置驱动的目录、`system` 字段、会话亲和、图片输入。
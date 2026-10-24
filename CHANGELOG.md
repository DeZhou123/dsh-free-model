# CHANGELOG · dsh-free-model

格式：`## [版本] · 日期` → `### 新增 / 改动 / 修复 / 证据`。
写下来的规矩：**每条都要能被验证**（命令、文件、实测输出），做不到就标 `未实测`。

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
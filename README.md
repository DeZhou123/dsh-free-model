# dsh-free-model

把本机所有「不花钱」的模型渠道装进 DSH，用**一个设置项、三个页签**管起来，
并且让渠道清单**能远程更新** —— 加渠道不用等插件发版。

| 类 | 条数 | 路由 | 能力 | 需要什么 | 页内页签 |
|---|---|---|---|---|---|
| **账号渠道**（本插件自己挂） | 2 | `buddy/*`、`workbuddy/*` | 完整：工具调用、看图 | 一个账号（浏览器登录） | 账号渠道 |
| **服务渠道**（本机进程） | 6 | `opencode/*` | **无工具**：能看图、不能调工具 | 本机 `opencode serve`（插件可代起） | 本地与网关 |
| **自带 key / 免 key 渠道** | 34（+1 免 key） | `<渠道 id>/*` | 取决于上游声明 | 去上游拿免费 key（免 key 渠道零配置） | 自带 key |

**它要回答的问题是**：我到底有哪些免费模型、它们现在能不能用、不能用的话下一步做什么。
所以每条渠道都带**就绪状态**（`就绪 / 需动作 / 不可用 / 未知`）与**一条能指导动作的原因**
（配哪个凭据变量、去哪拿 key、去起哪个服务），而不是等用户点下去猜。

三类渠道的「不能用」是三件不同的事，所以**必须分开**：

| 类 | 不能用时用户要做什么 |
|---|---|
| 账号渠道 | 登录 / 续期 / 领积分 / 换账号 |
| 服务渠道 | 起本地进程 / 填网关 key / 换一个本地服务 |
| 自带 key | **在页面上把 key 填进去**（0.4.1 起）、或写进凭据条目；免 key 渠道不需要 |

合并成一句「渠道不可用」会让用户乱试方向，所以本插件宁可多写三个分支。

## 0.6.0：渠道从 21 条到 34 条，并且记住了「上次真打上游的结果」

两件事一起做，因为它们互相依赖：渠道一多，「全都绿」这个信号就失效了 —— 光看
「key 填了没」看不出哪条刚被 401 判死、哪条额度用尽要等六小时。

### ① 渠道扩容：14 条新车道（分两批），每条都带本轮实测证据

| 新增 | baseURL | 实测（2026-10-26） | 它补的是哪个短板 |
|---|---|---|---|
| `gitee-ai` | `ai.gitee.com/v1` | 200（213 条，免 key 可读目录） | 国内直连、**不要代理就能读目录** |
| `qwen-intl` | `dashscope-intl.aliyuncs.com/compatible-mode/v1` | 401 | 国际站与国内站是两份账号，之前只有国内那份 |
| `huggingface-router` | `router.huggingface.co/v1` | 200（131 条，每条带 providers[]） | 一个 id 多家上游，**自带上游明细** |
| `chutes` | `llm.chutes.ai/v1` | 200（16 条 TEE） | 机密推理；模型少但元数据最全 |
| `novita` | `api.novita.ai/v3/openai` | 200（97 条，带 context/output/模态） | 元数据最完整的一档 |
| `deepinfra` | `api.deepinfra.com/v1/openai` | 200（175 条，**不带窗口字段**） | 型号最全；窗口一律写 0（未知） |
| `zai` | `api.z.ai/api/paas/v4` | 401 | 智谱国际站（与国内站 key 不通用） |
| `xiaomi-mimo` | `api.xiaomimimo.com/v1` | 401 | 小米 MiMo 直连 |
| `kimi-coding` | `api.kimi.com/coding/v1` | 401 | **订阅套餐车道**（5h+7d 窗） |
| `zai-coding-cn` | `api.z.ai/api/coding/paas/v4` | 401 | **订阅套餐车道**（5h+7d 窗） |
| `fireworks` | `api.fireworks.ai/inference/v1` | 401 | 按量；模型 id 形如 `accounts/fireworks/models/…` |
| `hyperbolic` | `api.hyperbolic.xyz/v1` | 401 | 便宜的开源大模型托管 |
| `upstage` | `api.upstage.ai/v1` | 401 | 自家 Solar 小模型 |
| `reka` | `api.reka.ai/v1` | 401 | 多模态（看图/视频） |

同一轮实测**否掉**了 9 个候选，理由写在 `src/lanes/keyed/catalog-more.js` 文件头
（kluster / lambda 连不上、ai21 目录为空、cohere 回 HTML、sensenova 404、
**lingyiwanwu 410 已停服**、puter 无兼容目录、openai/deepseek 是按量不是免费）。
写下来是为了让下一个人不必再试一遍 —— 这一层最容易重复劳动。

### ② 渠道健康：与「就绪」分开记，并且落盘

| 问题 | 就绪（`/channels`） | 健康（`/health`） |
|---|---|---|
| key 填了，刚被 401 拒 | 就绪 | **已吊销** |
| key 填了，额度用尽 | 就绪 | **冷却中（到几点）** |
| 免 key 渠道，从没打过 | 就绪 | 未测过 |
| 用了半小时被限流 | 就绪 | 冷却中，还有 N 秒 |

判据（`src/lanes/health.js`，纯函数 `classifyFailure`，32 项单测钉住）：

| 失败 | 处置 | 为什么 |
|---|---|---|
| 401 / invalid-key | **吊销**，永不自动恢复 | 等不会让废 key 变好，只有换 key |
| 403（或 kind=forbidden） | 冷却 30 秒基准，**不判吊销** | 403 是多义的：边缘/WAF 拦截（实测 Groq 的 Cloudflare 403，带 key 与否同码，同日晚些又回到 401）或权限不足 —— 都不是「key 坏了」 |
| 402 / quota | 冷却到「下一个整点 + 6h」 | 恢复时间由上游账单周期决定，与退避无关 |
| 429 | 60 秒基准，尊重 `Retry-After`，封顶 30 分钟 | 等一会真的会好 |
| 5xx / 超时 / 网络 / 流中断 | 30 秒基准，**逐次翻倍** | 抖动要退避；连着失败说明不是抖动 |
| 404 | 6 小时长冷却，不参与退避 | 地址可能已经过期，别反复打 |
| 400 / 模型名错 / 上下文超限 / 用户按停止 | **不记** | 这是请求的问题，不是渠道的病 —— 记了会把好渠道冻住 |

记账有两个入口，都能落盘（`$DSH_HOME/free-model/health.json`，原子写）：

1. **探测**（用户点「测试 key」）——`no-key` / `missing-config` 不记（那是本插件自己的配置问题）；
2. **真实对话**（适配器回执）——`FAILURE_KINDS` 到账本分类有一张**显式翻译表**
   （`healthKindOf`），因为两层回答的是不同问题：一层管「这次请求怎么办」，一层管「这条渠道还要不要用」。

页面上的表现：每张卡多一颗健康徽章（绿 / 黄 / 红 / 灰四色，灰 ≠ 红 ——
灰是「还没测」，不是「坏了」），并带剩余时间；页头多一排筛选胶囊
（全部 / 就绪 / 待配置 / 冷却中 / 已吊销 / 已关闭，**每个胶囊自己带数字**）与一个搜索框
（渠道名、凭据名、端点、模型样例都能命中）。

## 自带 key 那一页现在有七件事可做（0.6.0）

| 动作 | 路由 | 结果按什么分类 |
|---|---|---|
| 填 / 清 / 显示 key | `POST /key`、`DELETE /key` | 脱敏值 + 来源（**永不回显原文**） |
| 测试 key | `POST /key/probe` | 13 类（含 dns / tls 两档单独分） |
| **查额度** | `POST /key/balance` | 9 类；金额**原样字符串**，认不出形状就如实说 |
| **查套餐窗口** | `POST /key/windows` | 订阅型车道（5h / 7d 两层）还剩多少；**形状未实测**，认不出时返回 `unparsed` 并列出看到的字段名（不猜数字） |
| 批量测试 | `POST /key/probe-all` | 只探**已配凭据**的，串行 + 走缓存 |
| 看健康 | `GET /health` | ok / cooldown / revoked / unknown（半开是标记，不是第五个状态） |
| 清健康 | `POST /health/reset` | 换完新 key 之后用（旧 key 的 401 会把它永久钉成「已吊销」） |

页面另外有：搜索框（渠道/凭据/端点/模型样例都能命中）、五个**带数字**的筛选胶囊
（全部 / 就绪 / 待配置 / 冷却中 / 已吊销 / 已关闭）、四档排序、模型样例行、被拒目录记录的提示。

## 自带 key 那一页：能填、能测、能清（0.4.1）

```
「去拿 key」→ 粘进输入框 → 保存（写宿主凭据，回脱敏值）→ 测试 key → 分类结论
                                     ↓ 就绪后立刻挂上路由
                            改主意了？「清除 key」删掉凭据条目
```

三条动作对应三条路由，**凭据值只进不出**（POST 收原文、只回 `sk-t…6789`；GET 永不回显原文）：

| 动作 | 路由 | 关键行为 |
|---|---|---|
| 保存 | `POST /key {lane, key}` | 先校验（空 / 空白 / 控制字符 / 超长都拒）→ 写宿主同名凭据 → **立刻挂上**（已挂载的走 `setApiKey()`，不重注册） |
| 清除 | `DELETE /key {lane}` | 删凭据条目，环境变量回退随即生效；**路由保留**（报错比静默消失可读） |
| 探测 | `POST /key/probe {lane, force}` | 打一次 `{baseURL}/models`（或声明的 `modelsURL`），结果**按 kind 分类** |

探测为什么值得单独做：**没有 key 时不构造请求**（`no-key`），有 key 时十一种结论各说各的话 ——

| kind | 用户该做什么 |
|---|---|
| `ok` | 没别的事了，顺手显示抄回来的模型数 |
| `invalid-key`（401） | key 复制错了 / 已吊销 → 换 key |
| `forbidden`（403） | **不一定是 key 的问题**：可能是这个接口 / 模型没权限，也可能是边缘/WAF 拦截 → 等一会重试或换模型 |
| `rate-limited`（429） | **key 是对的**，等一会（读 `Retry-After`） |
| `quota`（402） | 额度 / 余额不足 |
| `not-found`（404） | 目录里的 baseURL 可能过期 |
| `timeout` / `network` | 网络问题，**key 本身未必有问题** |
| `no-key` | 还没填 |

旧版页面刻意不放「测试连通性」，理由是「没 key 点测试必然失败，会被读成渠道坏了」。
那个理由只对**没 key** 成立 —— 所以现在是「没有 key 就不发请求」+「失败按 kind 分类」，
旧理由不再适用。


## 0.6.0 的六件事（自带 key 页）

| 想做什么 | 在哪 | 它回答的问题 |
|---|---|---|
| 填 / 清 key | 卡片上的输入框与按钮 | 「凭据配好了没」 |
| **测试 key** | 「测试 key」按钮 | 「key 能不能通过鉴权」（打 `/models`，最便宜） |
| **试一句话** | 「试一句话」按钮 | 「**能不能干活**」（真发一次最小补全；`/models` 通过证明不了这个） |
| **查额度** | 「查额度」按钮（只在声明了余额端点的渠道上出现） | 「还剩多少」（金额原样显示，低于 1 单位变红） |
| **看健康** | 卡片上的健康徽章（四色）+ 表格视图里的健康列 | 「上次真打上游成没成、冷却到什么时候」 |
| **关掉一条渠道** | 卡片头上的开关 | 「先别用它」（**≠ 清除凭据**；关掉之后启动不再挂它、请求也会被拦住） |

### 三个状态各有各的出口（不会把人锁在门外）

| 页面说 | 下一步该做什么 | 在哪儿做 |
|---|---|---|
| 冷却中，还有 N 分钟 | 等（或者换渠道） | 卡片自己显示剩余时间 |
| 已吊销：key 被拒 | 换一把 key —— **保存新 key 会自动清掉这条车道的健康结论** | 卡片上的输入框 |
| 已关闭 | 打开开关 | 卡片头的开关 |
| 未挂载（见宿主日志） | 保存一次 key（会立刻尝试挂上） | 卡片上的输入框 |

### 34 条渠道怎么找

搜索框（渠道名 / 凭据名 / 端点 / 模型样例都能命中）、六个**带数字**的筛选胶囊（全部 / 就绪 / 待配置 / 冷却中 / 已吊销 / 已关闭）、
四档排序（推荐顺序 / 名称 / 模型数 / 健康）、以及**表格视图**（渠道 / 就绪 / 健康 / key / 模型数 / 上次实测六列）。

### 渠道数据会腐坏：两道哨

1. **目录零交集**：某条渠道的静态模型表与上游实时目录**一个都对不上**时，卡片上会直接说明
   （「多半被改名或下架，点测试 key 刷新目录」）—— 部分对不上不报（上游天天加新模型）。
2. **端点实测**：`npm run probe:endpoints` 逐条探地址，2026-10-26 实测 **32/35 可达**。
## 骨架：注册表 + 可远程迭代的渠道目录

```
src/lanes/registry.js     唯一事实来源：三类渠道 → 同一种记录形状 → 就绪四态投影
  ├── src/lanes/service.js    6 条服务车道 + HTTP 探针（逐条 TTL：成功 30 秒、失败 30 秒）
  │     └── opencode / freellmapi / ollama / LM Studio / vLLM / llama.cpp
  ├── src/lanes/keyed/**      34 条自带 key / 1 条免 key 车道（第一批 20 + 第二批 14）
  │     ├── catalog.js         目录（每条带 evidence 与未确证标注）
  │     ├── catalog-more.js    第二批 14 条（0.6.0，含被否掉的 9 个候选与理由）
  │     ├── ready.js           就绪判定 + 三种凭据形态解码
  │     ├── adapter.js         OpenAI 兼容适配器（SSE / 工具 / 图片 / 错误分类）
  │     ├── index.js           descriptors() / mount() / mountAll()
  │     ├── keys.js            填 key / 清 key / 脱敏 / 凭据面状态（0.4.1）
  │     ├── probe.js           凭据探测 + 十一种分类（0.4.1）
  │     ├── manage.js          运行时管理器：存完 key 立刻挂上、换 key 不重注册（0.4.1）
  │     └── health.js          健康与冷却账本（0.6.0）：分类/退避/半开/落盘
  ├── src/lanes/catalog.js    记录校验（远程数据是**不可信输入**）+ 三层叠加（shipped/remote/local）
  └── src/lanes/remote.js     远程目录拉取（https-only、格式版本不符整份拒绝、原子缓存、失败降级）
```

**为什么渠道数据要能远程更新**：免费渠道是外部策略，不是技术事实。上游换域名、加免费模型、
收回额度，都不该逼用户等一次插件发版。所以渠道数据分三层、同形状、按 id 覆盖：
随包（离线基线）← 远程 JSON（随时可更新）← 本地覆盖文件（用户自己钉住/改对）。
远程数据只被当作**数据**读：没有 eval、没有动态 import，每条记录都要过校验器，
不合格的整条丢弃并记账 —— 一条 baseURL 写错的渠道会表现成「插件坏了」，比少一条渠道糟得多。


### 加一条自己的渠道（不用改代码，也不用发版）

往 `$DSH_HOME/free-model/channels.local.json` 写一条就行 —— 它是三层目录里优先级最高的一层
（随包 ← 远程 ← **本地**），同 `id` 会**整条替换**上层。最常用于：自己搭的 OpenAI 兼容网关、
公司内部的推理端点、把某条上游换域名后的免费渠道改对。

```json
{
  "catalogVersion": 1,
  "channels": [
    {
      "id": "my-gateway",
      "displayName": "我自己的网关",
      "kind": "keyed",
      "baseURL": "https://gateway.example.com/v1",
      "apiKeyEnv": "MY_GATEWAY_KEY",
      "docsURL": "https://gateway.example.com/docs",
      "signupURL": "https://gateway.example.com/keys",
      "freeTier": "自建，成本自己算",
      "region": "cn",
      "note": "公司内网，只在内网可达",
      "models": [
        { "id": "internal-llm-70b", "name": "Internal 70B", "contextWindow": 32768, "maxTokens": 4096, "vision": false, "tools": true }
      ]
    }
  ]
}
```

三条硬规则（**违反会被整条拒掉，并在页面上告诉你为什么**）：

1. `catalogVersion` 必须是 `1`（与本插件认识的格式版本一致）；远程与本地**同一把尺子**：
   字节上限 256KB、格式版本不符整份拒绝；
2. `baseURL` 走 / `http(s)`、**不许带 query/hash、不许内嵌凭据**；`keyed` 渠道必须给 `baseURL` 且
   至少 1 条 `models`；`apiKeyEnv` 只认大写字母/数字/下划线（宿主的凭据文法）；
3. 写错了不会静默：页面上会出现一行「有 N 条渠道记录没通过校验（已忽略，不影响其它渠道）」并列出原因。

写完**不用重启**：打开设置页看那张卡在不在；不在就照着页面上的拒绝原因改。
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

## 怎么确认它真的装上了

```powershell
Get-Content "$env:USERPROFILE\.dsh\free-model\apply-ok.json"
```

这个文件是**装配自证**：版本、上次装配时间、**已经挂上适配器的路由**、目录层计数与指纹。
**不含任何凭据值**（只记「挂了哪几条」）。

为什么需要它：headless / CLI 模式**不打 info 日志**，而装配是异步分片的（native 车道在 `inject`
回调里挂、自带 key 车道是 `void keyedManager.mountAllReady()`），任何一片失败都只留一行 warn ——
看不到 warn 就没法判断。它是**历史记录**（`appliedAt` 是上次装配的时刻），不是存活标记：
「现在在不在跑」看设置页能不能打开。

正常装配时它长这样（真宿主进程内实测）：

```json
{ "plugin": "dsh-free-model", "version": "0.6.0", "phase": "full",
  "mountedRoutes": ["buddy", "groq", "opencode", "openrouter-free", "pollinations", "workbuddy"],
  "channels": { "account": 2, "keyed": 34, "service": 6, "total": 41 } }
```

### 端点会变：`npm run probe:endpoints` 复查一次

渠道 URL 是会变的（换域名、下线、改路径），而插件把「能不能用」的责任交给了运行时 ——
目录里的 URL 错了，用户看到的是「配了 key 还是 401/404」，**最难查**。
所以改过渠道数据就重跑一次这个探针（它**不带凭据**、默认只打印、不写仓库文件）：

```powershell
npm run probe:endpoints          # 逐条探 {baseURL}/models，按状态码分类
npm run probe:endpoints:dry      # 只列出将探测的 URL
```

判读：**`401/403` = 端点活着且要凭据（最健康的一档）**、`200` = 免凭据、
`404/405` = 路径或方法不对、连不上 = 本机此刻不可达（**不代表目录错**）。
目录自己声明过的例外（`supportsModelList:false` / `placeholders:['{ACCOUNT_ID}']`）算**预期**；
只有当「声称能列模型且没有占位符」的渠道突然 404 时才以非零退出码报警。

> 2026-10-26 实测：**32/35 可达**（22 条 401/403、10 条 200），另 2 条与目录声明一致
> （`google-ai-studio` 的 404 与 `cloudflare-workers-ai` 的 405 都是目录里声明过的），
> 还有 1 条（`baidu-qianfan`）回 429 —— 那是**匿名限流**，加测仍能拿到 403，属健康。

## 账号渠道：2 条车道（CodeBuddy / WorkBuddy）

本插件的「账号渠道」页只管**本插件自己挂载**的两条腾讯车道：

| 车道 | id | 登录形态 | 余额 | 签到 |
|---|---|---|---|---|
| CodeBuddy (腾讯国内版) | `buddy` | 浏览器回调 | ✓ | ✓ |
| WorkBuddy (腾讯国际版) | `workbuddy` | 浏览器回调 | ✓ | **无**（上游不提供签到接口） |

### 其余免费账号车道不在这里（0.5.0 拆分）

华为云 CodeArts、有道 LobsterAI、Qoder、TRAE、Cline、Loomy、Raccoon、MiniMax、
Gemini Code Assist、ZCode 那 11 条车道，其 auth / 适配器 / 积分 / 登录实现都在
**另一个插件**里，页面也归它。它们曾在 0.4.x 被本插件借页面展示过，0.5.0 起
整体迁出，改由独立插件 `dsh-ofm-lanes` 提供（同一个设置区里另一个入口）。

为什么拆：那 11 条的执行体从来不在本插件内 —— 本插件只做「页面 + 转发」，
而转发要跟着对方的 RPC 变、登录时序要跟着对方的产品怪癖变。两件事绑在一个
插件里，任何一边发版都得同步另一边，且本插件的测试根本覆盖不到对方的实现。

**为什么本插件不能顺手把 11 条也挂一遍**（历史坑，仍然成立）：

1. **cordis 同名 Service 会抛错**。比如 `new QoderAuth(ctx)` 会注册
   `ctx.qoderAuth`；同名再注册一次直接抛 `service "qoderAuth" has been registered`，
   把整个 apply 打死；
2. **两份 auth 实例 = 两份续期定时器**。同一个 `refresh_token` 被并发消费，
   表现是「刚登录却一直认证失败」（本仓库记录过同型事故）。

### `backend` 现在只剩两档

| backend | 谁实现 | 页面怎么操作 |
|---|---|---|
| `native` | 本插件挂载的 auth + adapter（`buddy` / `workbuddy`） | `/api/free-model/*` |
| `gateway` | 别的插件已经注册了路由（本插件只观测，不重复注册） | 只读展示 |

`GET /api/free-model/summary` 里每条车道都带 `backend` / `login` / `credits`，
页面据此渲染卡片与动作 —— 不需要认识任何具体渠道。

### 回归防线

`test/lanes-registry.mjs` —— 断言账号车道**全部是 native 两条**、
注册表三类渠道齐全、未挂载时一律 `unavailable` 且原因指向下一步；
`test/routes-channels.mjs` 断言 `/summary` 里不再有「宿主侧后端就绪」那一段。

> 账号型两条车道与「不需要登录的本地车道」在**同一个设置项内分页**：前者要管账号、
> 积分、签到；后者只有一个本地进程要管。同一时刻屏幕上只有一个主题，页签上还带
> 数字（账号数 / 模型数），切换前就知道对面有没有东西。

> **账号池是共享的，但不是必需的。** 宿主若提供了 `accountPool` 服务，本插件
> 直接用它的池（同一份账号、同一份限流标记）；没有则退化为本地实现，读写**同一个**
> `$DSH_HOME/channel-pack/state.json`。两种情况下都是同一份文档，不会出现「两个池
> 各写各的」。

## 为什么需要这个插件

三件事各自都能做，但**没有一个地方能同时回答**「我到底有哪些免费模型、它们现在
能不能用、要做什么才能用」。

- 腾讯那两条车道的入口在宿主侧早已下线，但账号与凭据还在（本插件的前身
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


> **2026-10-26 本机实测（opencode 1.19.3，端口 4096）**：服务可达，`/config/providers` 报
> `opencode:9` + `ofm:706`（后者是本机另一个插件注册进来的车道，`opencode` 会把它们一并列出来），
> 目录共 **715 个模型**；**SSE 不可用 → 自动降级为轮询**（日志里一条 `SSE 不可用，降级为轮询`）；
> 真发流式请求时，`opencode/*` 那几条会以「长时间没有新内容」失败 —— 与上面「免费层只对
> OpenCode 自己的调用方合法」是同一件事。**结论：这条车道在本机可用但不可靠**，
> 适合标题/摘要这类小活；要当主模型请用账号车道或自带 key 车道。
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

设置 → **免费模型**（`settings.section` id `free-model`，order 37）。
进去之后是页内页签，当前页签记在 `localStorage` 的 `free-model:tab` 上，
刷新后停在原处。

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
│  2/2 账号   38/38 模型   剩余积分 1.2K   账号池：共享池   自动领积分·已领      │
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
`$DSH_HOME/channel-pack/free-model-auto-checkin.json`，**不碰**宿主那份
`auto-checkin.json`。两个进程同改一份文档时，后写的会把前者的 `lastDate` 抹掉，
对方随即以为「今天已经跑过」而跳过它自己的渠道。代价是两边的开关各自独立
（页面上写明了这一条）。

**没领到就不记「今天已跑」**：池为空或全部失败时不写日期，下次启动会重试；
否则今天新加的账号会被推迟到明天才自动领取。
## 实现要点

### 目录

```
index.js                 三条车道的装配（账号型 ×2 + 服务型 ×1）+ 积分能力位
src/channels.js          buddy 系通道装配（auth + adapter + 选号）
src/lanes/registry.js    三类渠道的统一注册表 + 就绪四态投影（页面与路由的唯一事实来源）
src/lanes/catalog.js     渠道记录校验 + 三层目录叠加（shipped / remote / local）
src/lanes/remote.js      远程渠道目录：拉取 / 校验 / 原子缓存 / 失败降级
src/lanes/service.js     服务型车道（opencode / FreeLLMAPI 网关 / Ollama）+ HTTP 探针
src/lanes/update.js      插件自身的版本检查（semver 比较 + 6 小时缓存 + 失败静默）
src/lanes/keyed/catalog.js  自带 key / 免 key 车道的目录（每条带 evidence 与未确证标注）
src/lanes/keyed/ready.js    就绪判定：三种凭据形态 / 环境变量优先 / ref: 解引用
src/lanes/keyed/adapter.js  OpenAI 兼容适配器（SSE + 工具调用 + 图片 + 错误分类）
src/lanes/keyed/index.js    descriptors() / mount() / mountAll()（只出描述符，注册留给上层）
src/lanes/keyed/keys.js     填 key / 清 key / 脱敏展示 / 凭据面状态（写入走宿主 credentials）
src/lanes/keyed/probe.js    凭据探测：一次 /models 或最小补全，结果按 11 种 kind 分类
src/lanes/keyed/manage.js   运行时管理器：保存后立刻挂载、换 key 走 setApiKey（不重注册）
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

实测（2026-10-23，本机配置的一条免费模型）：首块 1.9s，26 个 delta 帧，
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
   （本机实测的那条免费模型就是 0）。
2. **上游失败也标 completed**。错误挂在 `info.error` 上，必须原样抛出去 ——
   否则用户拿到的是空回答加一句猜的「可能限流」，而真实原因可能是
   「免费层只能在 OpenCode 内使用」「模型不存在」「协议不支持」。
3. **工具必须全关**。opencode 的 `build` agent 默认带 bash / write / edit，
   不关掉模型会真的在用户机器上执行命令，而 DSH 侧又拿不到结果（两套工具
   协议不互通）。`toolsDisabled()` 把 14 个内置工具全部置 false。

### 账号池的两种形态

| 场景 | 行为 |
|---|---|
| 宿主提供了 `accountPool` | 直接用它的池（同一份账号、同一份限流标记、同一份黑名单） |
| 没有这个服务 | 退化成 `LocalPool`，读写**同一个** `$DSH_HOME/channel-pack/state.json` |

本地实现只替换 `accounts` 里属于本插件的那几条，其余字段与条目原样保留 ——
`state.json` 是 dsh home 级共享文档，整份重写会静默丢掉别的通道的字段。

## 测试

```powershell
# 主套件：十余个离线套件、500+ 断言（协议/路由/健康账本/余额/渲染，不需要宿主、不发网络）
npm test

# 用真实宿主包验证契约（临时 link dsh-llm / dsh-credentials，跑完删掉）
npm run test:host

# 真实端到端（需要 opencode serve 在跑；模型 id 用你自己 opencode 里配好的那条）
npm run test:e2e -- '<provider>/<model>'
```

三套测试各挡一类错：

| 套件 | 挡什么 |
|---|---|
| `smoke.mjs` | 协议与路由：三条车道的注册/目录/元数据/stream chunk 序列、HTTP 面每条路由、信任围栏、让位语义；积分与自动领取用**假的 fetch** 打（不碰腾讯计费接口），状态文件写进临时目录（不碰真实 `~/.dsh`） |
| `render.mjs` | 白屏：用极小的 React 替身把组件树跑一遍（两个设置页都要注册、卡片的三条余额分支、自动领取条的四态）。`node --check` 只能抓语法错，抓不到「渲染时抛 ReferenceError」——而那正是白屏最常见的原因 |
| `host-check` / `host-apply` | 契约漂移：`instanceof LlmAdapter`、`providerInfo.id === provider`、`prepareCall` 返回 stream、`LlmError` code 被宿主认得 |
| `keyed/keys-flow.mjs`（0.4.1） | 凭据全流程：入参校验（空/空白/控制字符/超长）、脱敏、保存与清除、探测的十一种分类、以及**保存后立刻挂上 / 清除后路由保留**这两条运行时语义 |
| `host-keyed.mjs` | 自带 key 车道的**真实装配**：免 key 车道上、缺 key 的一条都不上、凭据名是**裸名**（不带 `ref:` 前缀——那是 0.4.1 修掉的一个静默 bug） |

`npm run check` 是另一道门：对 `index.js` / `client.js` / `src/**` / `test/**` / `scripts/**`
下全部 `.js` / `.mjs`（当前 70 个）逐个 `node --check`，只抓语法错、本机约 8 秒。所以上面
以及下面这些**不进 `npm test`** 的套件（`e2e-opencode`、`host-check/apply/keyed`、`keyed-live`、
`service-start`、`opencode-affinity`、`boot-serve`）里写坏语法，CI 也会红。

`test:e2e` 依赖本机装没装 opencode、以及免费层此刻有没有被限流，故**不进** `npm test`。

## 已知边界

- **WorkBuddy 国际版没有签到接口**：`daily-checkin` 在它的后端不存在，故这条车道
  上不会出现「一键领取」，自动领取也会把它跳过并标成「无签到接口」。
  （余额接口 `get-user-resource` 两边都有。）
- **自动领取的开关与宿主那份开关各自独立**：本插件写自己的状态文件，见上文理由。
  两边同时开着不会重复领取（服务端对「今天已领」会明确回报），但会有两次无谓请求。
- **余额是「查得到才算」**：合计数只累计读成功的账号；查不到的账号会单独显示原因，
  不会被当成 0（否则卡片上的合计数看起来像「额度凭空少了」）。

- **OpenCode 免费层的失败有三种，处置完全相反，别混成一句「限流了」**
  （2026-10-24 修正：早先这里只写了下面第 2 条，还把当日额度误当成它的同义词）：

  | 类别 | 上游原文特征 | 该怎么办 |
  |---|---|---|
  | **① 当日额度耗尽** | `Free usage limit reached. Subscribe to OpenCode Go to keep going` | 按天重置，**北京时间 08:00**（UTC 0:00）恢复。在此之前重试无效；换成同池的其它 `*-free` 模型通常也无效。要立刻干活就换通道（换到本插件里的其它渠道）或订阅 Go |
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
- **不硬接宿主的 token 账本**：`token-ledger` 是对方包内的内部模块，硬 import
  会在它下次重构时把整个插件打死。记账退化为 no-op，推理不受影响。

## 与前身的关系

`dsh-ofm-workbuddy` 只做一件事：把宿主移除的两条腾讯通道装回来。本插件
在此基础上：

1. **拆掉对宿主的隐含依赖**（池可退化、账本不接）；
2. **加第三条车道**（opencode 免费层）；
3. **重做信息架构**（能力徽章、三分状态、空状态给动作）。

buddy 全栈（`src/core/`）逐行保留原注释 —— 那些注释是这份代码最值钱的部分，
每一条都对应一次真实报障（限流 6004 vs 模型饱和 14003、401 刷新自锁、
免费模型被永久积分锁定误拦、`prepareCall` 的记账隐式依赖……）。
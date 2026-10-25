/**
 * 「自带 key 的免费渠道」声明式目录（**纯数据**，不含任何逻辑与 IO）。
 *
 * ## 这是什么
 *
 * 一批**注册即送额度 / 有免费层**的 OpenAI 兼容端点。有 key 就挂
 * `openai-completions` 适配器（见 `./adapter.js`），没 key 就由 `./ready.js`
 * 报「待配置 + 去哪拿 key」。这层的价值不是「多接几个模型」，而是把
 * **「哪条车道现在能不能用、为什么不能用、去哪个页面解决」**变成数据。
 *
 * ## 统一形状（registry 按这个读，别加必填字段）
 *
 * 渠道级：
 * - `id`            短横线小写、**全局唯一**，路由前缀就用它；
 * - `displayName`   给用户看的名字；
 * - `kind`          `'keyed' | 'keyless'`（与所在数组一致）；
 * - `protocol`      本期只有 `'openai'`；
 * - `baseURL`       **不含结尾斜杠**；适配器拼 `{baseURL}/chat/completions`、
 *                   `{baseURL}/models`。含 `{PLACEHOLDER}` 的渠道必须先替换
 *                   （`ready.js` 会因此判 not-ready，不会去打一个必然 404 的地址）；
 * - `apiKeyEnv`     读凭据用的 key 名；keyless 恒为 `null`；
 * - `docsURL` / `signupURL` 文档页与**拿 key 的页面**（页面上的「去拿 key」按钮）；
 * - `freeTier`      一句话说清免费额度形态（每日/每月/模型范围）；
 * - `region`        `'global' | 'cn'`；
 * - `note`          接入这条车道要知道的坑；
 * - `models`        静态兜底目录（**至少 1 条**）。运行时先拉实时 `/models`，
 *                   失败或该渠道没有 `/models` 时回退到这里。
 * - `evidence`      本条目的 baseURL 是**怎么被确证的**（见下）；
 * - `unknown` / `unknownFields` 未确证标记（见下）；
 * - 可选 `supportsModelList:false` + `modelsURL`：该渠道没有标准 `/models`
 *   （或目录在别的路径）；
 * - 可选 `placeholders`：baseURL 里待替换的占位符；
 * - 可选 `streamUsage:false`：该渠道不接受 `stream_options`。
 *
 * 模型级（`models[]`）：
 * `{ id, name, contextWindow, maxTokens, vision, tools, unknown?, note? }`
 * - `contextWindow` / `maxTokens` 为 **0 = 未知**（沿用本仓库既有约定：
 *   0 是「不知道」，不是「零窗口」；适配器会退回默认值）；
 * - `vision` / `tools` 是**能力声明**，适配器据此决定是否发图片、是否发 tools；
 * - `unknown:true` 表示**这个 id 本身未确证**（可能已改名/下架）。静态表只用来
 *   兜底，实时 `/models` 一回来就作废。
 *
 * ## ⚠️ unknown 的判据（不要滥用，也不要漏）
 *
 * `unknown:true` ⟺ 该条目**存在会影响可用性、而我没有实证的字段**，
 * 具体是哪些写在 `unknownFields` 里。判据只三种：
 * 1. `baseURL` —— 最多写进 unknownFields，**末尾的 20 条没有一条 baseURL 是猜的**
 *    （每条都有 `evidence`）；
 * 2. `models` —— 静态表里的 id 没见过实测（运行时会被实时目录覆盖，危害有限）；
 * 3. `freeTier` —— 免费额度的**具体数值**没见过官方口径。
 * 与可用性无关的字段（displayName、note 之类的措辞）**不进 unknown**，
 * 否则标记会烂成噪音。
 *
 * ## ⚠️ 这些 baseURL 是怎么来的（2026-10-25 01:00 前后，本机实测）
 *
 * 没有联网工具时**不许假装联网**；这次有，所以逐条探过。判据是
 * 「拿不到 key 时该端点回什么」—— 401/403/429 都证明**端点存在且已在鉴权**，
 * 只有 404/DNS 失败才是地址写错：
 *
 * | 渠道 | 探测 | 结果 |
 * | --- | --- | --- |
 * | openrouter | GET /api/v1/models | **200**（并据此抄下三条 pricing.prompt=0 的免费模型） |
 * | groq | GET /openai/v1/models | 401 `invalid_api_key` |
 * | cerebras | GET /v1/models | 403 `{"detail":"Not authenticated"}` |
 * | google-ai-studio | GET /v1beta/openai/models | **404** → 该路径没有 /models；baseURL 取自官方 openai 兼容页原文 |
 * | cloudflare-workers-ai | 官方 openai 兼容页原文 | baseURL 含 `{account_id}`，实测同形 |
 * | mistral | GET /v1/models | 401 `Invalid API Key` |
 * | together | GET /v1/models | 401 `Missing API key` |
 * | sambanova | GET /v1/models | **200**（无 key 也回目录，抄下 6 条实测 id） |
 * | nvidia-nim | GET /v1/models | **200**（抄下 80+ 条实测 id） |
 * | siliconflow | GET /v1/models | 401 `{"code":30014,...}` |
 * | modelscope | GET /v1/models | **200**（无 key 也回目录，抄下 38 条实测 id） |
 * | zhipu-bigmodel | GET /paas/v4/models | 401 中文鉴权错 |
 * | moonshot | GET /v1/models | 401 OpenAI 形状 |
 * | baidu-qianfan | GET /v2/models | 429 `OverRateLimit`（端点存在） |
 * | volcano-ark | GET /api/v3/models | 401 `AuthenticationError` |
 * | dashscope | GET /compatible-mode/v1/models | 401 OpenAI 形状 |
 * | stepfun | GET /v1/models | 401 `invalid_api_key` |
 * | spark-xfyun | GET /v1/models | 401 `Unauthorized` |
 * | hunyuan | GET /v1/models | 401 `invalid_api_key`（错误里带控制台链接） |
 * | minimax | GET /v1/models | 401 `authorized_error` |
 * | pollinations | GET /models | **200**（`tier:"anonymous"`，真·免 key） |
 *
 * ⚠️ **两条被这一轮实测否掉的**：
 * - `github-models` —— 官方文档页首页原文：**GitHub Models 已于 2026-07-30 全面退役**
 *   （playground / 模型目录 / 推理 API / BYOK 全部下线）。它**不在** `KEYED_CHANNELS`
 *   里，见 `RETIRED_CHANNELS`：挂上去只会让用户以为自己配错了。
 * - `cloudflare-workers-ai` 的 `/ai/v1` 需要账号 ID。放进 `placeholders`，
 *   由 `ready.js` 判 not-ready 并说清「去填账号 ID」，**不**让适配器打一个 404。
 *
 * @module src/lanes/keyed/catalog
 */

import { MORE_KEYED_CHANNELS } from './catalog-more.js'

/**
 * 需要凭据的渠道。**顺序 = 页面上推荐的顺序**（能用、免费层明确、坑少的排前面）。
 *
 * ⚠️ 0.6.0 起本数组只放**第一批**；第二批（gitee-ai / huggingface-router / chutes /
 * novita / deepinfra / zai / xiaomi-mimo / kimi-coding / zai-coding-cn / qwen-intl）
 * 在 `./catalog-more.js`，由文件末尾那行 spread 拼成导出的 `KEYED_CHANNELS`。
 * 拆文件的理由不是好看：两批数据的**实测日期与判据不同**，混在一个数组里会让
 * 「这条是上一轮验的、那条是这一轮验的」彻底看不出来。
 * @type {ReadonlyArray<object>}
 */
const KEYED_CHANNELS_BASE = [
  {
    id: 'openrouter-free',
    displayName: 'OpenRouter 免费模型',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    balance: { url: 'https://openrouter.ai/api/v1/credits', rowKind: 'balance' },
    docsURL: 'https://openrouter.ai/docs/api-reference/overview',
    signupURL: 'https://openrouter.ai/settings/keys',
    freeTier: 'id 带 ":free" 后缀的模型计费为 0（实测 pricing.prompt/completion = "0"）；每日次数按账户余额档限制，余额 ≥10 美元时额度更高',
    region: 'global',
    // 目录免 key 可读（实测 2026-10-26 两轮 200）：探测通过≠有额度。
    openCatalog: true,
    note: '免费型号随时上下架，静态表只是兜底（运行时以 /models 实时结果为准）；模型 id 里那个 ":free" 后缀是价格档位，忘掉它就会按付费模型计费。',
    evidence: '2026-10-25 GET https://openrouter.ai/api/v1/models → 200；free 三条取自实测 pricing.prompt=0 的行',
    unknown: true,
    unknownFields: ['freeTier'],
    models: [
      { id: 'recursive/flint-v1.0:free', name: 'Recursive: Flint (free)', contextWindow: 262144, maxTokens: 235929, vision: false, tools: true },
      { id: 'xingchen-agi/xing4.0-29b-a4b:free', name: 'XingChen: Xing4.0 29B A4B (free)', contextWindow: 262144, maxTokens: 235929, vision: false, tools: true },
      { id: 'nvidia/nemotron-3.5-super-vl:free', name: 'NVIDIA: Nemotron 3.5 Super VL (free)', contextWindow: 1000000, maxTokens: 131072, vision: true, tools: true },
    ],
  },
  {
    id: 'groq',
    displayName: 'Groq 免费层',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    docsURL: 'https://console.groq.com/docs/openai',
    signupURL: 'https://console.groq.com/keys',
    freeTier: '免费层按模型给每分钟/每天的请求数与 token 上限（RPM/RPD/TPM/TPD），不付费即可调用；超了是 429 而不是扣费',
    region: 'global',
    note: '速度是它的卖点，代价是限速很硬：免费档上并发稍高就会连续 429，等一会儿会恢复（属于限流，不是额度用尽）。'      + '⚠️ 本机 2026-10-26 实测到另一种失败：**Cloudflare 边缘 403 Forbidden**（server: cloudflare，带 key 与不带 key 完全相同，'
      + '  '/'models 与 /chat/completions 都一样）。那不是 key 的问题、也不是额度 —— 是这台机器被边缘挡在鉴权之前，'
      + '  换网络/等风控解除再试。**探测通过（401）与真实对话（403）可能不一致**，两个结果都要看。',    evidence: '2026-10-25 GET https://api.groq.com/openai/v1/models → 401 {"error":{"code":"invalid_api_key"}}（端点存在且 OpenAI 形状）。'
      + ' 2026-10-26 真实对话冒烟：POST /chat/completions（openai/gpt-oss-120b）→ 403 Forbidden / 307ms，cf-ray 落在 SIN，带 key 与否同码',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', contextWindow: 131072, maxTokens: 32768, vision: false, tools: true, unknown: true },
      { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B', contextWindow: 131072, maxTokens: 32768, vision: false, tools: true, unknown: true },
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', contextWindow: 131072, maxTokens: 32768, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'cerebras',
    displayName: 'Cerebras Inference 免费层',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    docsURL: 'https://inference-docs.cerebras.ai/resources/openai',
    signupURL: 'https://cloud.cerebras.ai/',
    freeTier: '注册即得免费层：按模型给每日 token 额度（不是无限），每日重置；官方有独立 Rate Limits 页',
    region: 'global',
    note: '头号特点是最快（wafer-scale），所以免费额度用得快；工具调用与结构化输出官方支持，图片输入在 2026 年仍是 Preview。',
    evidence: '2026-10-25 GET https://api.cerebras.ai/v1/models → 403 {"detail":"Not authenticated"}（端点存在且已鉴权）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'gpt-oss-120b', name: 'GPT-OSS 120B', contextWindow: 131072, maxTokens: 32768, vision: false, tools: true, unknown: true },
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', contextWindow: 65536, maxTokens: 8192, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'google-ai-studio',
    displayName: 'Google AI Studio (Gemini)',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    docsURL: 'https://ai.google.dev/gemini-api/docs/openai',
    signupURL: 'https://aistudio.google.com/apikey',
    freeTier: 'AI Studio 里拿到 key 即免费用（按模型给 RPM/RPD/TPM 上限）；付费档要另外绑结算',
    region: 'global',
    note: '⚠️ 这条**没有** OpenAI 的 /models 端点（实测 .../v1beta/openai/models → 404），所以目录只能用静态表，且思维档位用 reasoning_effort 映射；本轮适配器**不发** reasoning_effort（见 adapter.js 的说明）。',
    evidence: 'baseURL 取自官方「OpenAI 兼容」页原文（base_url="https://generativelanguage.googleapis.com/v1beta/openai/"）；2026-10-25 实测该路径 /models → 404，故 supportsModelList:false',
    supportsModelList: false,
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1000000, maxTokens: 65536, vision: true, tools: true },
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1000000, maxTokens: 65536, vision: true, tools: true, unknown: true },
    ],
  },
  {
    id: 'cloudflare-workers-ai',
    displayName: 'Cloudflare Workers AI',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1',
    apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
    docsURL: 'https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/',
    signupURL: 'https://dash.cloudflare.com/profile/api-tokens',
    freeTier: '每天 10,000 Neurons 的免费额度（Workers AI 定价页口径），日出重置；超了要开 Workers Paid',
    region: 'global',
    note: '⚠️ baseURL 里有 {ACCOUNT_ID}：先去 dash 首页抄账号 ID 并替换，否则这条车道会一直显示「待配置」——那是对的，不是插件坏了。',
    evidence: '官方 openai 兼容页原文：baseURL = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`；'
      + '2026-10-26 实测该路径的 /models 两轮均 405（补测假账号 ID 仍 405；/ai/models 与 /ai/models/search 返 400 Missing X-Auth-Key，'
      + '说明这两个端点不接受匿名 GET）——故本渠道**不声明**可实时列目录',
    placeholders: ['{ACCOUNT_ID}'],
    // 2026-10-26 实测补上：它的 /models 连 405 都不给正常答复，硬探只会每次白等一个超时。
    supportsModelList: false,
    unknown: true,
    unknownFields: ['freeTier'],
    models: [
      { id: '@cf/meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct', contextWindow: 0, maxTokens: 0, vision: false, tools: false },
      { id: '@cf/openai/gpt-oss-120b', name: 'GPT-OSS 120B', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
    ],
  },
  {
    id: 'mistral',
    displayName: 'Mistral (La Plateforme)',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    docsURL: 'https://docs.mistral.ai/api/',
    signupURL: 'https://console.mistral.ai/api-keys',
    freeTier: '有免费层（控制台里叫 Experiment/免费档），按模型给每秒请求数上限；具体配额以控制台当前显示为准',
    region: 'global',
    note: '免费档与付费档是**同一把 key** 上的两种套餐，改套餐后限额会变；static 模型表是长期别名（*-latest），不是快照 id。',
    evidence: '2026-10-25 GET https://api.mistral.ai/v1/models → 401 {"detail":"Invalid API Key"}（端点存在且已鉴权）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'mistral-small-latest', name: 'Mistral Small (latest)', contextWindow: 128000, maxTokens: 0, vision: false, tools: true },
      { id: 'mistral-large-latest', name: 'Mistral Large (latest)', contextWindow: 128000, maxTokens: 0, vision: false, tools: true },
    ],
  },
  {
    id: 'dashscope',
    displayName: '阿里云百炼 (DashScope 兼容模式)',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    docsURL: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    signupURL: 'https://bailian.console.aliyun.com/?apiKey=1',
    freeTier: '新用户按模型送限时免费额度（每个模型各送固定 token 数，通常 90 天内有效）；额度用完后按量计费',
    region: 'cn',
    note: '国内直连不用代理；qwen-plus / qwen-turbo / qwen-max 是**档位别名**（长期稳定），别写成带日期的快照 id。',
    evidence: '2026-10-25 GET https://dashscope.aliyuncs.com/compatible-mode/v1/models → 401 {"error":{"type":"invalid_request_error"}}（端点存在，OpenAI 形状）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'qwen-plus', name: 'Qwen Plus', contextWindow: 131072, maxTokens: 8192, vision: false, tools: true },
      { id: 'qwen-max', name: 'Qwen Max', contextWindow: 32768, maxTokens: 8192, vision: false, tools: true },
      { id: 'qwen-turbo', name: 'Qwen Turbo', contextWindow: 131072, maxTokens: 8192, vision: false, tools: true },
    ],
  },
  {
    id: 'modelscope',
    displayName: '魔搭 ModelScope 推理 API',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api-inference.modelscope.cn/v1',
    apiKeyEnv: 'MODELSCOPE_API_KEY',
    docsURL: 'https://www.modelscope.cn/docs/model-service/API-Inference/intro',
    signupURL: 'https://modelscope.cn/my/myaccesstoken',
    freeTier: '社区版按模型给免费调用额度（绑阿里云账号后额度更高，具体次数见控制台；此处数值未确证）',
    region: 'cn',
    openCatalog: true,
    note: '⚠️ 它的 /models **不用 key 就能读**（实测 200），所以「目录能拉出来」不等于「能调用」——真正能不能调由 chat/completions 的鉴权决定，别被目录骗了。',
    evidence: '2026-10-25 GET https://api-inference.modelscope.cn/v1/models → 200，抄下 38 条实测 id（本静态表取其中 4 条）',
    unknown: true,
    unknownFields: ['freeTier'],
    models: [
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
      { id: 'Qwen/Qwen3.8-27B', name: 'Qwen 3.8 27B', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
      { id: 'ZhipuAI/GLM-5.2', name: 'GLM 5.2', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
      { id: 'MiniMax/MiniMax-M3', name: 'MiniMax M3', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
    ],
  },
  {
    id: 'zhipu-bigmodel',
    displayName: '智谱 BigModel (GLM)',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'ZHIPUAI_API_KEY',
    docsURL: 'https://docs.bigmodel.cn/',
    signupURL: 'https://open.bigmodel.cn/usercenter/apikeys',
    freeTier: '带 "-flash" 的型号长期免费（限速调用），其余型号按量计费；免费型号清单会变',
    region: 'cn',
    note: '免费的是 flash 档；同一把 key 调付费型号会直接扣费，页面上的「免费」标记要跟模型 id 对齐。',
    evidence: '2026-10-25 GET https://open.bigmodel.cn/api/paas/v4/models → 401 {"error":{"code":"1001","message":"Header中未收到Authorization参数"}}（端点存在）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'glm-4.7-flash', name: 'GLM 4.7 Flash', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'moonshot',
    displayName: '月之暗面 Moonshot (Kimi)',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    balance: { url: 'https://api.moonshot.cn/v1/users/me/balance', rowKind: 'balance' },
    docsURL: 'https://platform.moonshot.cn/docs/',
    signupURL: 'https://platform.moonshot.cn/console/api-keys',
    freeTier: '新账号送一次性体验额度（不是每日免费层）；余额用完即 402，需充值',
    region: 'cn',
    note: '一次性赠送 ≠ 免费层：用完就是 402，页面要按「额度用尽」报，不要报成限流。',
    evidence: '2026-10-25 GET https://api.moonshot.cn/v1/models → 401 {"error":{"type":"incorrect_api_key_error"}}（端点存在，OpenAI 形状）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262144, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K', contextWindow: 8192, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'baidu-qianfan',
    displayName: '百度千帆 (v2 OpenAI 兼容)',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://qianfan.baidubce.com/v2',
    apiKeyEnv: 'QIANFAN_API_KEY',
    docsURL: 'https://cloud.baidu.com/doc/qianfan-api/index.html',
    signupURL: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    freeTier: '部分型号（-speed / lite 档）免费；其余按量计费，新用户另有代金券',
    region: 'cn',
    note: 'v2 才是 OpenAI 兼容面（`/v2/chat/completions`）；老的 v1 与千帆 SDK 是另一套协议，别混。Bearer 用的是控制台的「API Key」（bce-v3/... 形态）。',
    evidence: '2026-10-25 GET https://qianfan.baidubce.com/v2/models → 429 {"code":"OverRateLimit"}（端点存在并在工作；未鉴权请求被限流也算实证）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'ernie-4.5-turbo-128k', name: 'ERNIE 4.5 Turbo 128K', contextWindow: 131072, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'ernie-speed-128k', name: 'ERNIE Speed 128K', contextWindow: 131072, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'volcano-ark',
    displayName: '火山方舟 (Volcengine Ark)',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyEnv: 'ARK_API_KEY',
    docsURL: 'https://www.volcengine.com/docs/82379',
    signupURL: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    freeTier: '每个模型给固定数量的免费 token（新用户赠送、按模型分别计），用完按量计费',
    region: 'cn',
    note: 'model 字段既可以填「接入点 id」（ep-xxxxxxxx）也可以填模型 id；接入点方式需要在方舟控制台建好端点，填错会报 model not found 而不是鉴权错。',
    evidence: '2026-10-25 GET https://ark.cn-beijing.volces.com/api/v3/models → 401 {"error":{"code":"AuthenticationError"}}（端点存在）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'doubao-seed-1-6-250615', name: 'Doubao Seed 1.6', contextWindow: 0, maxTokens: 0, vision: true, tools: true, unknown: true },
      { id: 'deepseek-v3-250324', name: 'DeepSeek V3 (Ark)', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'siliconflow',
    displayName: '硅基流动 SiliconFlow',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    balance: { url: 'https://api.siliconflow.cn/v1/user/info', rowKind: 'balance' },
    docsURL: 'https://docs.siliconflow.cn/',
    signupURL: 'https://cloud.siliconflow.cn/account/ak',
    freeTier: '一批「免费」标记的模型（多为中小尺寸）零计费调用；另有新用户赠送额度，具体型号见站内标签',
    region: 'cn',
    note: '国内直连即可；免费型号清单在站内按标签滚动，静态表只兜底。国际版是 api.siliconflow.com，key 不通用。',
    evidence: '2026-10-25 GET https://api.siliconflow.cn/v1/models → 401 {"code":30014,"message":"Token is invalid."}（端点存在）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'Qwen/Qwen3-8B', name: 'Qwen3 8B', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'stepfun',
    displayName: '阶跃星辰 StepFun',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.stepfun.com/v1',
    apiKeyEnv: 'STEPFUN_API_KEY',
    docsURL: 'https://platform.stepfun.com/docs',
    signupURL: 'https://platform.stepfun.com/interface-key',
    freeTier: '新用户赠送体验额度；部分轻量型号限时免费，额度用完后按量计费',
    region: 'cn',
    note: '国内直连；赠送额度是一次性的，402 时页面要报「额度用尽」而不是限流。',
    evidence: '2026-10-25 GET https://api.stepfun.com/v1/models → 401 {"error":{"type":"invalid_api_key"}}（端点存在，OpenAI 形状）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'step-3.7-flash', name: 'Step 3.7 Flash', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'spark-xfyun',
    displayName: '讯飞星火 (OpenAI 兼容)',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://spark-api-open.xf-yun.com/v1',
    apiKeyEnv: 'SPARK_API_PASSWORD',
    docsURL: 'https://www.xfyun.cn/doc/spark/Web.html',
    signupURL: 'https://console.xfyun.cn/services/cbm',
    freeTier: '每个模型给固定 token 的免费额度（新用户赠送，按模型分别计），用完按量计费',
    region: 'cn',
    note: '⚠️ 凭据填的是控制台给的「APIPassword」（不是 APPID/APIKey/APISecret 三件套），直接当 Bearer 用，形态是 `key:secret`。填错会 401 而不是报格式错误。',
    evidence: '2026-10-25 GET https://spark-api-open.xf-yun.com/v1/models → 401 {"message":"Unauthorized"}（端点存在）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'lite', name: 'Spark Lite（免费档）', contextWindow: 0, maxTokens: 0, vision: false, tools: false, unknown: true },
    ],
  },
  {
    id: 'hunyuan',
    displayName: '腾讯混元 (Hunyuan)',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
    apiKeyEnv: 'HUNYUAN_API_KEY',
    docsURL: 'https://cloud.tencent.com/document/product/1729',
    signupURL: 'https://console.cloud.tencent.com/hunyuan/start',
    freeTier: '新用户开通后送固定数量免费 token（按模型分别计，有效期约一年）；用完按量计费',
    region: 'cn',
    note: '国内直连；赠送额度按模型独立，换模型可能又有额度。key 在腾讯云控制台的「API Key」页。',
    evidence: '2026-10-25 GET https://api.hunyuan.cloud.tencent.com/v1/models → 401（错误文案里直接带控制台链接，端点存在）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'hunyuan-turbos-latest', name: 'Hunyuan TurboS', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'hunyuan-lite', name: 'Hunyuan Lite（免费档）', contextWindow: 0, maxTokens: 0, vision: false, tools: false, unknown: true },
    ],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax (OpenAI 兼容)',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.minimaxi.com/v1',
    apiKeyEnv: 'MINIMAX_API_KEY',
    docsURL: 'https://platform.minimaxi.com/document',
    signupURL: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    freeTier: '新用户赠送一次性体验额度；部分型号长期免费（限速），其余按量计费',
    region: 'cn',
    note: '国内与国际端点是 api.minimaxi.com / api.minimax.io，**key 不通用**；本条目是国内端点。',
    evidence: '2026-10-25 GET https://api.minimaxi.com/v1/models → 401 {"error":{"type":"authorized_error","message":"login fail: ...(1004)"}}（端点存在）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'MiniMax-M3.1-Flash', name: 'MiniMax M3.1 Flash', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'nvidia-nim',
    displayName: 'NVIDIA NIM (build.nvidia.com)',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    docsURL: 'https://docs.nvidia.com/nim/',
    signupURL: 'https://build.nvidia.com/settings/api-keys',
    freeTier: '注册送固定额度（官网口径为 1000 credits，约等于该数量的调用次数），用完需申请或付费',
    region: 'global',
    openCatalog: true,
    note: '⚠️ 它的 /models **不用 key 就能读**（实测 200，80+ 条），所以目录很全但能调的只是其中一部分：页面上要按「能调通」而不是「列出来」计数。',
    evidence: '2026-10-25 GET https://integrate.api.nvidia.com/v1/models → 200（抄下实测 id，本静态表取其中 4 条）',
    unknown: true,
    unknownFields: ['freeTier'],
    models: [
      { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
      { id: 'z-ai/glm-5.3', name: 'GLM 5.3', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
      { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
      { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
    ],
  },
  {
    id: 'together',
    displayName: 'Together AI',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    docsURL: 'https://docs.together.ai/docs/openai-api-compatibility',
    signupURL: 'https://api.together.xyz/settings/api-keys',
    freeTier: '带 "-Free" 后缀的模型零计费（清单会变）；新账号另有一次性赠送额度',
    region: 'global',
    note: '免费型号 id 里带 "-Free" 后缀，跟付费版只差后缀一个词；忘掉后缀会直接扣费。',
    evidence: '2026-10-25 GET https://api.together.xyz/v1/models → 401 "Missing API key"（端点存在）',
    unknown: true,
    unknownFields: ['models', 'freeTier'],
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', name: 'Llama 3.3 70B Turbo (Free)', contextWindow: 131072, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free', name: 'DeepSeek R1 Distill Llama 70B (free)', contextWindow: 131072, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'sambanova',
    displayName: 'SambaNova Cloud',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.sambanova.ai/v1',
    apiKeyEnv: 'SAMBANOVA_API_KEY',
    docsURL: 'https://docs.sambanova.ai/cloud/docs/get-started/overview',
    signupURL: 'https://cloud.sambanova.ai/apis',
    freeTier: '免费开发者档：按模型给每日请求数与 token 上限，不需绑卡',
    region: 'global',
    openCatalog: true,
    note: '⚠️ /models **不用 key 也能读**（实测 200）；免费档限速偏紧，高并发会连续 429。',
    evidence: '2026-10-25 GET https://api.sambanova.ai/v1/models → 200（抄下实测 6 条 id，本静态表取其中 4 条）',
    unknown: true,
    unknownFields: ['freeTier'],
    models: [
      { id: 'DeepSeek-V3.1', name: 'DeepSeek V3.1', contextWindow: 131072, maxTokens: 131072, vision: false, tools: true },
      { id: 'Meta-Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B Instruct', contextWindow: 131072, maxTokens: 3072, vision: false, tools: true },
      { id: 'gpt-oss-120b', name: 'GPT-OSS 120B', contextWindow: 131072, maxTokens: 131072, vision: false, tools: true },
      { id: 'gemma-4-31B-it', name: 'Gemma 4 31B IT', contextWindow: 262144, maxTokens: 262144, vision: false, tools: true },
    ],
  },
]

/**
 * 第一批（上一轮实测）与第二批（`./catalog-more.js`，本轮实测）**拼成**页面看到的那一份。
 *
 * ⚠️ 顺序：第一批在前，因为它们的 `note` 里写着更细的坑；第二批是新面孔，排在后面
 * 反而让老用户不必重新认一遍页面。想改推荐顺序就改两个文件里的数组顺序。
 * @type {ReadonlyArray<object>}
 */
export const KEYED_CHANNELS = [...KEYED_CHANNELS_BASE, ...MORE_KEYED_CHANNELS]

/**
 * **真·不需要 key** 的直连渠道。
 *
 * 判据不是「文档说免 key」，而是实测：`GET /models` 回 200 且列出的模型带
 * `tier:"anonymous"`（匿名档），说明不注册也能调。
 * @type {ReadonlyArray<object>}
 */
export const KEYLESS_CHANNELS = [
  {
    id: 'pollinations',
    displayName: 'Pollinations (免 key 直连)',
    kind: 'keyless',
    protocol: 'openai',
    baseURL: 'https://text.pollinations.ai/v1',
    apiKeyEnv: null,
    docsURL: 'https://raw.githubusercontent.com/pollinations/pollinations/master/APIDOCS.md',
    signupURL: 'https://enter.pollinations.ai',
    freeTier: '完全免费、无需注册：文本每次请求间隔≥30 秒（同一 IP 串行），超了回 402 + Retry-After；带自己的 key 可解除按 IP 限速',
    region: 'global',
    note: '⚠️ 限速是「一次只跑一个、间隔 30 秒」，所以它只适合当兜底车道；上游**用 402 表示「等一下再来」**，与别家的「额度用尽」撞码，页面要按 Retry-After 区分。模型只有 GPT-OSS 20B 一个。⚠️ 2026-10-26 实测它**忽略 max_tokens**（要 8 个 token 回了 534 个），所以一次请求可能跑十几秒 —— 适合兜底，不适合当主模型。',
    evidence: '2026-10-25 GET https://text.pollinations.ai/models → 200，返回 [{"name":"openai-fast","tier":"anonymous","tools":true,...}]；'      + '官方 APIDOCS.md 原文确认 POST /openai（或 /v1/chat/completions）且 Free · no signup · rate-limited。'      + ' 2026-10-26 真实对话冒烟：POST /chat/completions（openai-fast）→ **200** / 13862ms / 上游回中文文本；'      + '同轮实测它**忽略 max_tokens=8**（回了 534 个 completion token）——所以它慢，且别指望用它压成本',
    supportsModelList: false,
    modelsURL: 'https://text.pollinations.ai/models',
    // 串行限速（同一 IP 间隔 ≥30 秒）：适配器据此**不做自己的重试**，只尊重 Retry-After。
    serialRateLimit: true,
    unknown: true,
    unknownFields: ['models'],
    models: [
      { id: 'openai-fast', name: 'GPT-OSS 20B (Pollinations 匿名档)', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
    ],
  },
]

/**
 * **已下线**的渠道。
 *
 * 单独一个数组，**不**混进 `KEYED_CHANNELS` —— 混进去就等于让上层有机会
 * 挂一个必然失败的路由。留在目录里是为了让页面能说一句「这个渠道 2026 年就没了」，
 * 而不是让用户照着一份过时的攻略去注册。
 * @type {ReadonlyArray<object>}
 */
export const RETIRED_CHANNELS = [
  {
    id: 'github-models',
    displayName: 'GitHub Models（已下线）',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://models.github.ai/inference',
    apiKeyEnv: 'GITHUB_TOKEN',
    docsURL: 'https://docs.github.com/en/github-models',
    signupURL: 'https://docs.github.com/en/github-models',
    freeTier: '曾经免费（按 GitHub 账号档位限速），现已不可用',
    region: 'global',
    retired: true,
    retiredOn: '2026-07-30',
    note: '不再可用：playground、模型目录、推理 API 与 BYOK 全部下线（官方文档首页原文）。要替代品用 Azure AI Foundry 或 GitHub Copilot。',
    evidence: '2026-10-25 官方文档页原文："As of July 30, 2026, GitHub Models has been fully retired."；同日实测 https://models.github.ai/inference/models → 200 但响应体只有 "OK"（边缘返回，不是模型目录）',
    unknown: false,
    unknownFields: [],
    models: [
      { id: 'openai/gpt-4o-mini', name: '（历史条目）GPT-4o mini', contextWindow: 0, maxTokens: 0, vision: true, tools: true, unknown: true },
    ],
  },
]

/** 全部渠道（含已下线），页面/统计用。 */
export const ALL_CHANNELS = [...KEYED_CHANNELS, ...KEYLESS_CHANNELS, ...RETIRED_CHANNELS]

/** 按 id 取渠道；找不到返回 `undefined`（不抛：路由前缀可能来自旧配置）。 */
export function laneById(id) {
  const key = String(id ?? '')
  return ALL_CHANNELS.find((lane) => lane.id === key)
}

/** 按地域过滤（`'cn'` 的渠道在国内直连不需要代理）。 */
export function lanesByRegion(region) {
  return ALL_CHANNELS.filter((lane) => lane.region === region)
}

/** 某渠道的静态模型行（`models` 缺失时给空数组，绝不抛）。 */
export function staticModels(lane) {
  return Array.isArray(lane?.models) ? lane.models : []
}

/**
 * 该渠道是否必须先替换 baseURL 占位符才能用。
 *
 * ⚠️ **同时认百分号编码形态**（`{ACCOUNT_ID}` 与 `%7BACCOUNT_ID%7D`）：
 * 上游的渠道目录校验会用 `new URL()` 规范化 URL，而 WHATWG URL 的路径编码集
 * **包含 `{` `}`** —— 也就是 `https://…/accounts/{ACCOUNT_ID}/ai/v1` 过一遍
 * 就变成 `…/%7BACCOUNT_ID%7D/…`。只认花括号的话，这条车道会被判成"就绪"，
 * 然后去打一个必然 404 的地址，用户看到的是"插件坏了"。
 *
 * @param {object} lane
 * @returns {string[]} 待替换的占位符名（统一成 `{NAME}` 形态，已去重）
 */
export function lanePlaceholders(lane) {
  const raw = typeof lane?.baseURL === 'string' ? lane.baseURL : ''
  const found = []
  // ① 花括号形态
  for (const match of raw.match(/\{[A-Z0-9_]+\}/g) ?? []) found.push(match)
  // ② 百分号编码形态（%7B = {、%7D = }，大小写都可能）
  for (const match of raw.match(/%7B[A-Za-z0-9_]+%7D/g) ?? []) {
    found.push('{' + match.slice(3, -3).toUpperCase() + '}')
  }
  const declared = Array.isArray(lane?.placeholders) ? lane.placeholders.filter((p) => typeof p === 'string') : []
  return [...new Set([...declared, ...found])]
}

/**
 * 目录统计（页面顶部那几个数字）。
 *
 * `unknown` 一栏是**故意显眼**的：本轮 20 条里大部分模型 id 没被实测过，
 * 页面要把「哪些是实测的、哪些是快照」讲清楚，而不是把静态表当权威。
 */
export function catalogStats() {
  const count = (lanes) => lanes.length
  const unknownModels = ALL_CHANNELS.reduce(
    (sum, lane) => sum + staticModels(lane).filter((row) => row.unknown === true).length,
    0,
  )
  return {
    keyed: count(KEYED_CHANNELS),
    keyless: count(KEYLESS_CHANNELS),
    retired: count(RETIRED_CHANNELS),
    cn: count(ALL_CHANNELS.filter((lane) => lane.region === 'cn')),
    globally: count(ALL_CHANNELS.filter((lane) => lane.region === 'global')),
    unknownLanes: count(ALL_CHANNELS.filter((lane) => lane.unknown === true)),
    unknownModels,
    // 这两个才是**真正该盯**的数字：`unknownLanes` 那 20 来条几乎全是「模型 id 是快照」，
    // 而 baseURL 一旦错，用户会以为插件坏了。所以单独把 baseURL 的未确证数拎出来 ——
    // 本轮应为 0（每条都有 evidence，见文件头的探测表）。
    unverifiedBaseURL: count(ALL_CHANNELS.filter((lane) => lane.unknownFields?.includes('baseURL'))),
    unverifiedModels: unknownModels,
    // 有 /models 端点的渠道占比 —— 它决定「静态表会不会被实时结果覆盖」。
    withLiveCatalog: count(ALL_CHANNELS.filter((lane) => lane.supportsModelList !== false && lane.retired !== true)),
  }
}
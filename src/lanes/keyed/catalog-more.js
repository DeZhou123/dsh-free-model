/**
 * 自带 key 车道的**第二批**（0.6.0）：把市场里已经做成产品的那些模型接入插件
 * 验证过的渠道，搬进本插件目录。与 ./catalog.js 的 KEYED_CHANNELS
 * **同形状**，由那里 spread 进来 —— 拆成两个文件不为好看，是为了让
 * 「本轮新增」与「上一轮已验证」各自可读、可单独回滚。
 *
 * ## 判据：这一批全部经过**本机实测**（2026-10-26 凌晨，逐条探 GET {baseURL}/models）
 *
 * | 状态 | 含义 | 结论 |
 * |---|---|---|
 * | 200 | 端点活着，且**不要凭据就能读目录** | 目录可作静态兜底（个别甚至免 key） |
 * | 401 / 403 | 端点活着，且**已经在鉴权** | 地址正确，这是最健康的一档 |
 * | 404 | 路径不对，或该平台没有标准 /models | 必须写 supportsModelList:false |
 * | 连不上 | 本机此刻不可达 | **不进这一批**（不能拿"我这网络不好"当渠道坏了） |
 *
 * ## 已被同一轮实测**否掉**的候选（写在这儿，免得下一个人再试一遍）
 *
 * | 候选 | 实测 | 结论 |
 * |---|---|---|
 * | kluster（api.kluster.ai/v1） | fetch failed，连试两次 3.4s/超时 | 本机不可达，不进目录 |
 * | lambda（api.lambdalabs.com/v1） | fetch failed（7.2s） | 同上 |
 * | ai21（api.ai21.com/studio/v1） | 200 但 {"data":[]} | 端点活着但没有可对话模型 |
 * | cohere（api.cohere.ai/compatibility/v1） | 403 + **HTML 页面** | CDN 挡的，不是 API 的 403 |
 * | sensenova（api.sensenova.cn/compatible-mode/v1） | 404 | 该路径不存在 |
 * | lingyiwanwu（api.lingyiwanwu.com/v1） | **410 model_service_closed** | 这家已停服 |
 * | puter（api.puter.com/puterai/openai/v1） | 404 | 不给 OpenAI 兼容 /models |
 * | openai / deepseek-official | 按量计费 | **不是"免费渠道"**，故意不进本目录 |
 *
 * ## 为什么 freeTier 大多标 unknown
 *
 * 「这家现在免费多少」是上游策略、会变，而且多数平台不在页面上写死数字。静态表里
 * 编一个数字出来 = 给未来埋一条「页面说能用、实际按量扣费」的雷。所以这里只写
 * **形态**（有免费层 / 只赠试用额度 / 订阅套餐 / 按量），具体数值交给运行时。
 * 同理：拿不到 /models 的渠道，模型 id 标 unknown:true —— 静态表只当兜底，
 * 运行时一拿到实时目录就覆盖它。
 *
 * @module src/lanes/keyed/catalog-more
 */

/**
 * 第二批自带 key 车道。**顺序 = 页面推荐顺序**（能少花钱、坑少、国内可直连者在前）。
 * @type {ReadonlyArray<object>}
 */
export const MORE_KEYED_CHANNELS = [
  // ── 国内可直连 ─────────────────────────────────────────────────────────────
  {
    id: 'gitee-ai',
    displayName: 'Gitee 模力方舟',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://ai.gitee.com/v1',
    apiKeyEnv: 'GITEE_AI_API_KEY',
    docsURL: 'https://ai.gitee.com/docs/openapi/v1',
    signupURL: 'https://ai.gitee.com/serverless-api',
    freeTier: '有免费体验额度（按模型/账号档给，数值随平台活动变）；用完后按量计费。国内直连，不需要代理。',
    region: 'cn',
    // 目录免 key 可读（实测 200）：探测通过≠有额度，页面据此挂提示。
    openCatalog: true,
    note: '⚠️ /models **不要 key 也能读**（实测 200，213 条）：所以"探测通过"只证明地址活着，'
      + '不证明你有额度。模型 id 里混着大量社区微调（Jev / TEE 后缀），挑主流的用。',
    evidence: '2026-10-26 GET https://ai.gitee.com/v1/models → 200，返回 213 条（含 kimi-k3.1-pro、'
      + 'GLM-5.3、DeepSeek-V4.1-Flash-1017、qwen3.8-max-0902、MiniMax-H3）',
    unknown: true,
    unknownFields: ['freeTier'],
    // 这几条 id 是 2026-10-26 从它自己的实时目录里抄下来的，所以**不标** unknown：
    // 窗口拿不到仍写 0（未知），但「这个 id 存在」这件事是实证的。
    models: [
      { id: 'DeepSeek-V4.1-Flash-1017', name: 'DeepSeek V4.1 Flash', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
      { id: 'GLM-5.3', name: 'GLM 5.3', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
      { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
      { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
      { id: 'qwen3.8-max-0902', name: 'Qwen3.8 Max', contextWindow: 0, maxTokens: 0, vision: false, tools: true },
    ],
  },
  {
    id: 'qwen-intl',
    displayName: '通义千问（国际站）',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_INTL_API_KEY',
    docsURL: 'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',
    signupURL: 'https://modelstudio.console.alibabacloud.com/',
    freeTier: '国际站每个模型给一段免费额度（按模型发，用尽转按量）。与国内站 dashscope 是**两份账号、两把 key、两套额度**。',
    region: 'global',
    note: '与 dashscope（国内站）要分开：key 不通用，额度也不共享。国际站地址在大陆常需代理。',
    evidence: '2026-10-26 GET https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models → 401 '
      + '"You didn\'t provide an API key ... Bearer auth"（端点活着且已鉴权）',
    unknown: true,
    unknownFields: ['freeTier'],
    models: [
      { id: 'qwen-plus', name: 'Qwen Plus', contextWindow: 131072, maxTokens: 8192, vision: false, tools: true },
      { id: 'qwen-max', name: 'Qwen Max', contextWindow: 32768, maxTokens: 8192, vision: false, tools: true },
      { id: 'qwen-turbo', name: 'Qwen Turbo', contextWindow: 131072, maxTokens: 8192, vision: false, tools: true },
    ],
  },

  // ── 聚合 / 推理平台（有免费层或注册赠额，用尽按量）──────────────────────────
  {
    id: 'huggingface-router',
    displayName: 'Hugging Face Inference Providers',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://router.huggingface.co/v1',
    apiKeyEnv: 'HF_TOKEN',
    docsURL: 'https://huggingface.co/docs/inference-providers/index',
    signupURL: 'https://huggingface.co/settings/tokens',
    freeTier: '免费账号每月有一笔额度（按 provider 转发，用完转 PRO 或按量）。数值随账号档变化，本插件不写死。',
    region: 'global',
    // 目录免 key 可读（实测 200，且每条带上游明细）：探测通过≠有额度。
    openCatalog: true,
    note: '⚠️ /models **不要 key 也能读**（实测 200，131 条），所以探测通过只说明地址活着。'
      + '它是**转发层**：同一个模型 id 底下挂着多家上游（novita / cerebras / deepinfra / baseten…），'
      + '调速与可用性由它选，你的 key 只是 HF 的 token。',
    evidence: '2026-10-26 GET https://router.huggingface.co/v1/models → 200，返回 131 条且每条带 '
      + 'providers[]（provider/status/context_length/pricing/supports_tools）——本批唯一带上游明细的目录',
    unknown: true,
    unknownFields: ['freeTier'],
    models: [
      // 窗口取自 2026-10-26 的实时目录（每条的 providers[].context_length 里最大的那个）；
      // 拿不到窗口的（Kimi K3）保持 0 = 未知 —— 编一个数会让宿主的压缩时机判断错。
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', name: 'DeepSeek V4.1 Flash', contextWindow: 1048576, maxTokens: 0, vision: true, tools: true },
      { id: 'Qwen/Qwen3.8-27B', name: 'Qwen3.8 27B', contextWindow: 1000000, maxTokens: 0, vision: true, tools: true },
      { id: 'zai-org/GLM-5.3-Flash', name: 'GLM 5.3 Flash', contextWindow: 1048576, maxTokens: 0, vision: true, tools: true },
      { id: 'moonshotai/Kimi-K3', name: 'Kimi K3', contextWindow: 0, maxTokens: 0, vision: true, tools: true, unknown: true },
      { id: 'google/gemma-4-31B-it', name: 'Gemma 4 31B IT', contextWindow: 262144, maxTokens: 0, vision: true, tools: true },
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'meta-llama/Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B Instruct', contextWindow: 16384, maxTokens: 0, vision: false, tools: false },
    ],
  },
  {
    id: 'chutes',
    displayName: 'Chutes',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://llm.chutes.ai/v1',
    apiKeyEnv: 'CHUTES_API_KEY',
    docsURL: 'https://docs.chutes.ai/',
    signupURL: 'https://chutes.ai/app/api',
    freeTier: '注册赠一笔试用额度，用尽转按量（它自己也卖 TAO 计价）。**不是无限免费**。',
    region: 'global',
    // 目录免 key 可读（实测 200）：探测通过≠有额度。
    openCatalog: true,
    note: '卖点是「TEE 机密推理」——模型 id 带 -TEE 后缀表示跑在可信执行环境里，'
      + '换来的是**模型清单偏少**（实测只有 16 条）与偶发排队。',
    evidence: '2026-10-26 GET https://llm.chutes.ai/v1/models → 200，返回 16 条，每条带 '
      + 'context_length / max_output_length / input_modalities / supported_features',
    unknown: true,
    unknownFields: ['freeTier'],
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Flash-0731-TEE', name: 'DeepSeek V4 Flash (TEE)', contextWindow: 1048576, maxTokens: 131072, vision: false, tools: true },
      { id: 'zai-org/GLM-5.2-TEE', name: 'GLM 5.2 (TEE)', contextWindow: 1048576, maxTokens: 65535, vision: false, tools: true },
      { id: 'moonshotai/Kimi-K3-TEE', name: 'Kimi K3 (TEE)', contextWindow: 1048576, maxTokens: 65535, vision: true, tools: true },
      { id: 'Qwen/Qwen3.8-27B-TEE', name: 'Qwen3.8 27B (TEE)', contextWindow: 262144, maxTokens: 65536, vision: true, tools: true },
      { id: 'deepseek-ai/DeepSeek-V3.2-TEE', name: 'DeepSeek V3.2 (TEE)', contextWindow: 131072, maxTokens: 65536, vision: false, tools: true },
      { id: 'google/gemma-4-31B-turbo-TEE', name: 'Gemma 4 31B Turbo (TEE)', contextWindow: 131072, maxTokens: 65536, vision: true, tools: true },
      { id: 'zai-org/GLM-5.1-TEE', name: 'GLM 5.1 (TEE)', contextWindow: 202752, maxTokens: 65535, vision: false, tools: true },
    ],
  },
  {
    id: 'novita',
    displayName: 'Novita AI',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.novita.ai/v3/openai',
    apiKeyEnv: 'NOVITA_API_KEY',
    balance: { url: 'https://api.novita.ai/v3/user/balance', rowKind: 'balance' },
    docsURL: 'https://novita.ai/docs/api-reference/introduction',
    signupURL: 'https://novita.ai/settings/key-management',
    freeTier: '新号赠小额试用额度，之后按 token 计费。',
    region: 'global',
    openCatalog: true,
    note: '目录里混着 -p 后缀的型号（推测是 premium/峰值档），挑不带后缀的先试。'
      + '⚠️ 它的 /models 路径是 /v3/openai/models（不是 /v3/models）。',
    evidence: '2026-10-26 GET https://api.novita.ai/v3/openai/models → 200，返回 97 条，每条带 '
      + 'context_size / max_output_tokens / input_modalities',
    unknown: true,
    unknownFields: ['freeTier'],
    models: [
      { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash', contextWindow: 1048576, maxTokens: 393216, vision: true, tools: true },
      { id: 'moonshotai/kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 1048576, maxTokens: 1048576, vision: true, tools: true },
      { id: 'zai-org/glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 1048576, maxTokens: 131072, vision: true, tools: true },
      { id: 'minimax/minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', contextWindow: 1000000, maxTokens: 524288, vision: true, tools: true },
      { id: 'xiaomimimo/mimo-v2.6-pro', name: 'MiMo V2.6 Pro', contextWindow: 1048576, maxTokens: 131072, vision: true, tools: true },
    ],
  },
  {
    id: 'deepinfra',
    displayName: 'DeepInfra',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
    docsURL: 'https://deepinfra.com/docs/openai_api',
    signupURL: 'https://deepinfra.com/dash/api_keys',
    freeTier: '按 token 计费；偶有标价 0 的开源模型可白用。**不是免费层渠道**，列它是因为型号极全。',
    region: 'global',
    // 目录免 key 可读（实测 200）：探测通过≠有额度。
    openCatalog: true,
    note: '⚠️ /models **不要 key 也能读**（实测 200，175 条）且**不带上下文/模态元数据** —— '
      + '所以下面的 contextWindow 只能写 0（未知），页面据此显示"未知窗口"而不是编一个数。'
      + '目录里混了图片/视频模型（veo / seedream / sdxl），选模型时看 id 前缀。',
    evidence: '2026-10-26 GET https://api.deepinfra.com/v1/openai/models → 200，返回 175 条'
      + '（Qwen3.7-Max、DeepSeek-V4-Pro-0813、Kimi-K2.6、claude-sonnet-4-6、gemini-2.5-pro…），'
      + '每行只有 id/object/created/owned_by/root/metadata，无窗口字段',
    unknown: true,
    unknownFields: ['freeTier', 'models'],
    models: [
      { id: 'Qwen/Qwen3.7-Max', name: 'Qwen3.7 Max', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'deepseek-ai/DeepSeek-V4-Pro-0813', name: 'DeepSeek V4 Pro', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'Qwen/Qwen3-VL-235B-A22B-Instruct', name: 'Qwen3 VL 235B', contextWindow: 0, maxTokens: 0, vision: true, tools: true, unknown: true },
    ],
  },

  // ── 厂商直连（订阅 / 套餐形态）────────────────────────────────────────────
  {
    id: 'zai',
    displayName: 'Z.ai（智谱国际站）',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: 'ZAI_API_KEY',
    docsURL: 'https://docs.z.ai/api-reference/llm/chat-completion',
    signupURL: 'https://z.ai/manage-apikey/apikey-list',
    freeTier: '有免费型号（GLM 的 Flash 档）；额度按账号档发放。与国内站 bigmodel 是**两份账号**。',
    region: 'global',
    note: '与 zhipu-bigmodel（国内站）**key 不通用**：同一个模型 id，两个站两把 key、两套额度。'
      + '国际站地址在大陆常需代理；国内站见那条。',
    evidence: '2026-10-26 GET https://api.z.ai/api/paas/v4/models → 401 '
      + '{"error":{"code":"1001","message":"Authentication parameter not received in Header"}}（端点活着且已鉴权）',
    unknown: true,
    unknownFields: ['freeTier'],
    models: [
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'glm-4.7-flash', name: 'GLM 4.7 Flash', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'xiaomi-mimo',
    displayName: '小米 MiMo',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.xiaomimimo.com/v1',
    apiKeyEnv: 'XIAOMI_MIMO_API_KEY',
    docsURL: 'https://platform.xiaomimimo.com/docs',
    signupURL: 'https://platform.xiaomimimo.com/',
    freeTier: '有免费档（按账号/活动发），用完后按量。具体数值平台不写死在页面上，本插件不猜。',
    region: 'cn',
    note: '国内直连。模型名同时出现在 novita / deepinfra 的中转目录里（xiaomimimo/mimo-v2.6-*），'
      + '但**直连用的是不带前缀的短 id**，前缀形态只在中转站有效 —— 别抄错。',
    evidence: '2026-10-26 GET https://api.xiaomimimo.com/v1/models → 401 '
      + '{"error":{"type":"invalid_key","message":"Invalid API Key"}}（端点活着且已鉴权）',
    unknown: true,
    unknownFields: ['freeTier'],
    models: [
      { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', contextWindow: 0, maxTokens: 0, vision: true, tools: true, unknown: true },
      { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', contextWindow: 0, maxTokens: 0, vision: true, tools: true, unknown: true },
    ],
  },
  {
    id: 'kimi-coding',
    displayName: 'Kimi 编程套餐',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.kimi.com/coding/v1',
    apiKeyEnv: 'KIMI_CODING_API_KEY',
    docsURL: 'https://platform.moonshot.cn/docs/api/chat',
    signupURL: 'https://platform.moonshot.cn/console/api-keys',
    freeTier: '**订阅套餐**：5 小时窗 + 7 天窗双层限额（不按 token 计费），超了等窗口滚动。'
      + '与 moonshot（按量）是两套计费，key 也不同。',
    region: 'cn',
    note: '⚠️ 套餐专用端点：拿按量的 moonshot key 来调它会 401。'
      + '它回答「套餐还剩多少」用的是另一个路径（`/coding/v1/usages`）—— 2026-10-26 实测该端点存在且要鉴权（401），'
      + '但本插件**暂不消费**它（套餐窗口的形状未验证，编一个解析出来会给错数）。',
    evidence: '2026-10-26 GET https://api.kimi.com/coding/v1/models → 401 '
      + '{"error":{"type":"invalid_authentication_error","message":"Invalid Authentication"}}（端点活着且已鉴权）',
    unknown: true,
    unknownFields: ['freeTier', 'models'],
    models: [
      { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 262144, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262144, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'zai-coding-cn',
    displayName: 'Z.ai 编程套餐',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    apiKeyEnv: 'ZAI_CODING_API_KEY',
    docsURL: 'https://docs.z.ai/scenario-example/develop-tools/claude',
    signupURL: 'https://z.ai/subscribe',
    freeTier: '**订阅套餐**：5 小时窗 + 7 天窗双层限额，不按 token 计费。与 zai（按量）是两把 key。',
    region: 'global',
    note: '路径里多一段 /coding —— 拿按量 key 调它会 401。这条车道在中文攻略里常被写成'
      + '"Claude Code 兼容端点"；它确实能吃 Anthropic 形态的请求，但这里按 OpenAI 兼容注册。',
    evidence: '2026-10-26 GET https://api.z.ai/api/coding/paas/v4/models → 401 '
      + '{"error":{"code":"1001","message":"Authentication parameter not received in Header"}}（端点活着且已鉴权）',
    unknown: true,
    unknownFields: ['freeTier', 'models'],
    models: [
      { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'glm-4.7', name: 'GLM 4.7', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },

  // ── 第三批（同一轮实测活着，但目录要凭据才给）──────────────────────────────
  {
    id: 'fireworks',
    displayName: 'Fireworks AI',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    docsURL: 'https://docs.fireworks.ai/api-reference/introduction',
    signupURL: 'https://fireworks.ai/account/api-keys',
    freeTier: '注册赠小额试用额度，之后按 token 计费。**不是免费层渠道**。',
    region: 'global',
    note: '按量计费；模型 id 形如 accounts/fireworks/models/<名>（很长，别手打）。',
    evidence: '2026-10-26 GET https://api.fireworks.ai/inference/v1/models → 401 “You must provide an API key”（端点活着且已鉴权）',
    unknown: true,
    unknownFields: ['freeTier', 'models'],
    models: [
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', name: 'Llama 3.3 70B Instruct', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'accounts/fireworks/models/deepseek-v3p2', name: 'DeepSeek V3.2', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'hyperbolic',
    displayName: 'Hyperbolic',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.hyperbolic.xyz/v1',
    apiKeyEnv: 'HYPERBOLIC_API_KEY',
    docsURL: 'https://docs.hyperbolic.xyz/docs/getting-started',
    signupURL: 'https://app.hyperbolic.xyz/settings',
    freeTier: '注册赠少量试用额度，之后按量。**不是免费层渠道**。',
    region: 'global',
    note: '卖点是便宜的开源大模型托管；对话端点走标准 OpenAI 兼容，不提供匿名目录。',
    evidence: '2026-10-26 GET https://api.hyperbolic.xyz/v1/models → 401 {"detail":"Not authenticated"}（端点活着且已鉴权）',
    unknown: true,
    unknownFields: ['freeTier', 'models'],
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B Instruct', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5 72B Instruct', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'upstage',
    displayName: 'Upstage Solar',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.upstage.ai/v1',
    apiKeyEnv: 'UPSTAGE_API_KEY',
    docsURL: 'https://developers.upstage.ai/docs/getting-started/chat',
    signupURL: 'https://console.upstage.ai/api-keys',
    freeTier: 'Solar 系列有免费额度（限额随账号档），用尽转按量。',
    region: 'global',
    note: '韩国团队，卖点是自家 Solar 小模型（便宜、快）；也代理别家的开源模型。',
    evidence: '2026-10-26 GET https://api.upstage.ai/v1/models → 401 “Your API key is invalid…”（端点活着且已鉴权）',
    unknown: true,
    unknownFields: ['freeTier', 'models'],
    models: [
      { id: 'solar-pro2', name: 'Solar Pro 2', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
      { id: 'solar-mini', name: 'Solar Mini', contextWindow: 0, maxTokens: 0, vision: false, tools: true, unknown: true },
    ],
  },
  {
    id: 'reka',
    displayName: 'Reka AI',
    kind: 'keyed',
    protocol: 'openai',
    baseURL: 'https://api.reka.ai/v1',
    apiKeyEnv: 'REKA_API_KEY',
    docsURL: 'https://docs.reka.ai/chat-api',
    signupURL: 'https://platform.reka.ai/apikeys',
    freeTier: '有免费试用额度（数值未确证），之后按量。',
    region: 'global',
    note: '多模态方向（看图/视频）；模型清单不在匿名 /models 里给全，页面以运行时目录为准。',
    evidence: '2026-10-26 GET https://api.reka.ai/v1/models → 401 {"error":{"code":"missing_api_key"}}（端点活着且已鉴权）',
    unknown: true,
    unknownFields: ['freeTier', 'models'],
    models: [
      { id: 'reka-flash', name: 'Reka Flash', contextWindow: 0, maxTokens: 0, vision: true, tools: true, unknown: true },
      { id: 'reka-core', name: 'Reka Core', contextWindow: 0, maxTokens: 0, vision: true, tools: true, unknown: true },
    ],
  },
]

/** 本批条数（页面/测试报数用，避免两处各数一遍）。 */
export const MORE_KEYED_COUNT = MORE_KEYED_CHANNELS.length
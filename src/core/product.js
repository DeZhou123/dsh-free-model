const WORKBUDDY_UA_INTL = "WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2";
const WORKBUDDY_UA_CN = "WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2";
const CODEBUDDY_FALLBACK_MODELS = [
  {
    id: "hy4-preview",
    name: "Hy4 preview",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 64e3
  },
  {
    id: "hy3",
    name: "Hy3",
    contextWindow: 192e3,
    supportsImages: true,
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 64e3
  },
  {
    id: "hy3-x",
    name: "Hy3",
    contextWindow: 192e3,
    supportsImages: true,
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 64e3
  },
  {
    // maxOutputTokens 实测（2026-09-19）：scoped 端点 128000、/v3/config 131072。
    // 取 **128000**（两个端点的较小者）：它是服务端真正接受的额度，131072 是
    // /v3/config 的声明值。取小者避免因端点差异被上游拒绝；远端可用时仍以
    // 远端下发值为准，本字段只在远端缺失时补位。
    id: "deepseek-v4.1-flash",
    name: "Deepseek-V4.1-Flash",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 128e3
  },
  {
    id: "deepseek-v4-pro",
    name: "Deepseek-V4-Pro",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "high", "xhigh"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 128e3
  },
  {
    // 2026-09 补录：远端 /v3/config 与 scoped 端点均返回该模型，且实测能看图
    // （纯红图问答答出「红色」）。它不在 craft/cli agent 白名单里，但可正常调用，
    // 也是适配器 DEFAULT_MODEL 的取值。
    //
    // 档位沿用适配器静态表 REASONING_EFFORTS 的既有取值 [low,high,max]（该表有
    // 实测依据：三档会显著改变返回的 reasoning_content 长度）。注意上游
    // /v3/config 声明的是 [low,high,xhigh]，与本表不一致；实测服务端对 low /
    // medium / high / xhigh / max 一律返回 200（不报非法参数），无法据此判定
    // 哪一组才真实生效，故不擅自改动既有行为，仅记录该分歧待后续验证。
    id: "deepseek-v4-flash",
    name: "Deepseek-V4-Flash",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 5e4
  },
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 64e3
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 32e3
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["high", "xhigh"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 64e3
  },
  {
    // supportsImages 为 true 有实测依据：纯红图问答答出「红色」。
    // 注意 scoped 端点（/console/enterprises/personal/models）对它返回
    // supportsImages=false，与 /v3/config、IDE 缓存、wb2api 清单三处矛盾；
    // 实测以「能看到图」为准，故保留 true（远端若下发 true 则两者一致，
    // 只有 scoped 端点先命中时才会被它的 false 覆盖，见 buddy-adapter 的
    // supportsImagesFor 修正）。
    id: "glm-5.1",
    name: "GLM-5.1",
    contextWindow: 2e5,
    supportsImages: true,
    reasoningEfforts: ["medium"],
    maxOutputTokens: 48e3
  },
  {
    id: "glm-5v-turbo",
    name: "GLM-5V-Turbo",
    contextWindow: 2e5,
    supportsImages: true,
    reasoningEfforts: ["medium"],
    maxOutputTokens: 64e3
  },
  {
    id: "kimi-k3-1",
    name: "Kimi-K3-1",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["medium"],
    maxOutputTokens: 32e3
  },
  {
    // 2026-09 补录：旧注释曾把它列为「service info not found」而排除，但实测
    // 可正常调用且能看图（纯红图问答答出「红色」），远端两端点也都在下发。
    id: "kimi-k2.8-preview",
    name: "Kimi-K2.8-Preview",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 64e3
  },
  {
    id: "kimi-k2.7",
    name: "Kimi-K2.7",
    contextWindow: 256e3,
    supportsImages: true,
    reasoningEfforts: ["medium"],
    maxOutputTokens: 32e3
  },
  {
    id: "kimi-k2.6",
    name: "Kimi-K2.6",
    contextWindow: 256e3,
    supportsImages: true,
    reasoningEfforts: ["medium"],
    maxOutputTokens: 32e3
  },
  {
    id: "minimax-m3",
    name: "MiniMax-M3",
    contextWindow: 512e3,
    supportsImages: true,
    reasoningEfforts: ["medium"],
    maxOutputTokens: 64e3
  }
];
const CODEBUDDY = {
  id: "buddy",
  platform: "ide",
  endpoint: "https://copilot.tencent.com",
  apiDomain: "copilot.tencent.com",
  displayName: "CodeBuddy (\u817E\u8BAF)",
  productCode: "codebuddy",
  userAgent: "CodeBuddyIDE/1.106.1",
  // 中国版只有一条产品线，无需按模型分档：全部模型沿用 IDE UA。
  userAgentByModelFamily: [],
  attributionName: "CodeBuddy",
  clientVersion: "1.106.1",
  cliVersion: "2.137.1",
  defaultCredentialRef: "BUDDY_ACCESS_TOKEN",
  appendSessionParams: false,
  fallbackModels: CODEBUDDY_FALLBACK_MODELS
};
const WORKBUDDY_FALLBACK_MODELS = [
  // 注：以下 maxOutputTokens 全部来自 2026-09-19 对国际版 `/v3/config` 的实测
  // （`node scripts/dump-max-output.mjs`）。该值就是用户在 IDE 里实际拿到的
  // 单次输出额度，远端不可用时由本表顶替。远端未下发的模型保持 undefined。
  { id: "default-model", name: "Auto", contextWindow: 176e3, supportsImages: true, maxOutputTokens: 24e3 },
  { id: "fast-model", name: "Fast", contextWindow: 2e5, supportsImages: true, reasoningEfforts: ["medium"], maxOutputTokens: 32e3 },
  { id: "balanced-model", name: "Balanced", contextWindow: 256e3, supportsImages: true, reasoningEfforts: ["medium"], maxOutputTokens: 32e3 },
  { id: "primary-model", name: "Primary", contextWindow: 272e3, supportsImages: true, reasoningEfforts: ["high"], maxOutputTokens: 72e3 },
  { id: "deep-model", name: "Deep", contextWindow: 176e3, supportsImages: true, maxOutputTokens: 24e3 },
  {
    id: "hy4-preview-f",
    name: "Hy4 preview",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 64e3
  },
  {
    // 2026-09 补录：/v3/config 的 cli agent 白名单里有它，但兜底表原先漏了，
    // 于是被 reconcileWithFallback 丢弃、模型选择器里看不到。实测能看图。
    id: "hy4-preview",
    name: "Hy4 preview",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 64e3
  },
  {
    id: "hy3",
    name: "Hy3",
    contextWindow: 192e3,
    supportsImages: true,
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 64e3
  },
  { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", contextWindow: 1e6, supportsImages: true, reasoningEfforts: ["high"], defaultReasoningEffort: "high", maxOutputTokens: 128e3 },
  {
    // 2026-09 补录：新加坡区的同代模型（-sg 后缀），远端下发且实测能看图。
    id: "deepseek-v4.1-flash-sg",
    name: "Deepseek-V4.1-Flash",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 128e3
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6-Astra",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 128e3
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 128e3
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6-Terra",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 128e3
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6-Luna",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 128e3
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 128e3
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 272e3,
    supportsImages: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 72e3
  },
  // gpt-5.3-codex：远端未下发 maxOutputTokens，故不填（保持 undefined，
  // 交由网关默认），不臆造数值。
  { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", contextWindow: 272e3, supportsImages: true, reasoningEfforts: ["medium"] },
  { id: "gemini-3.5-flash", name: "Gemini-3.5-Flash", contextWindow: 1e6, supportsImages: true, reasoningEfforts: ["medium"], maxOutputTokens: 65536 },
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 48e3
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["high", "xhigh"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 48e3
  },
  { id: "kimi-k3", name: "Kimi-K3", contextWindow: 1e6, supportsImages: true, reasoningEfforts: ["medium"], maxOutputTokens: 32e3 },
  {
    // 2026-09 补录：远端 /v3/config 的 cli agent 白名单里有它，兜底表原先漏了。
    id: "kimi-k2.8-preview",
    name: "Kimi-K2.8-Preview",
    contextWindow: 1e6,
    supportsImages: true,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
    maxOutputTokens: 32e3
  },
  { id: "kimi-k2.6", name: "Kimi-K2.6", contextWindow: 256e3, supportsImages: true, reasoningEfforts: ["medium"], maxOutputTokens: 32e3 }
];
const WORKBUDDY = {
  id: "workbuddy",
  platform: "workbuddy-ai",
  endpoint: "https://www.workbuddy.ai",
  apiDomain: "www.workbuddy.ai",
  displayName: "WorkBuddy (\u56FD\u9645\u7248)",
  productCode: "workbuddy",
  // 默认档：国际版产品形态（无按模型命中时使用）。
  userAgent: WORKBUDDY_UA_INTL,
  userAgentByModelFamily: [
    // 国际版独有模型线（GPT / Gemini / Claude 系）→ 国际版形态。
    { match: "gpt-", ua: WORKBUDDY_UA_INTL },
    { match: "gemini-", ua: WORKBUDDY_UA_INTL },
    { match: "claude-", ua: WORKBUDDY_UA_INTL },
    // 国内系模型（glm / hy / kimi / minimax）→ 国内客户端形态。
    { match: "glm-", ua: WORKBUDDY_UA_CN },
    { match: "hy", ua: WORKBUDDY_UA_CN },
    { match: "kimi-", ua: WORKBUDDY_UA_CN },
    { match: "minimax-", ua: WORKBUDDY_UA_CN }
  ],
  attributionName: "WorkBuddy",
  clientVersion: "5.5.2",
  cliVersion: "5.5.2",
  defaultCredentialRef: "WORKBUDDY_ACCESS_TOKEN",
  appendSessionParams: true,
  pluginVersion: "5.5.2",
  fallbackModels: WORKBUDDY_FALLBACK_MODELS
};
const ALL_PRODUCTS = [CODEBUDDY, WORKBUDDY];
function productById(id) {
  return ALL_PRODUCTS.find((product) => product.id === id);
}
function resolveUserAgent(product, model) {
  for (const rule of product.userAgentByModelFamily ?? []) {
    if (model.startsWith(rule.match)) return rule.ua;
  }
  return product.userAgent;
}
export {
  ALL_PRODUCTS,
  CODEBUDDY,
  WORKBUDDY,
  productById,
  resolveUserAgent
};

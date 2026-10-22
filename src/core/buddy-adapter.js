import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  LlmAdapter,
  LlmError,
  ReasoningEffortId
} from "@deepseek-ai/dsh-llm";
import { providerCatalogVisible } from "./pool-contract.js";
import { RemoteCatalogGate } from "./remote-catalog-gate.js";
import {
  RATE_LIMIT_FALLBACK_MS,
  isModelSaturationError,
  isQuotaExhaustedError,
  isRateLimited,
  parseRateLimitError
} from "./ratelimit.js";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import {
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE,
  credentialExpiresAtMs,
  formatCreditsRate
} from "./buddy.js";
import { CODEBUDDY, resolveUserAgent } from "./product.js";
import { normalizeHarnessMessages } from "./message-shape.js";
import { projectRequestImage } from "./image-budget.js";
import { createBlankReasoningSuppressor, createReasoningLoopDetector, hasUsableToolName, isProseTruncatedByStopString, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, reasoningLoopFailure, resolveEmptyResponseReason, resolveToolPairing, splitThinkTaggedContent, stripBareThinkCloseTagIfEnabled, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from "./sse.js";
import { registerAdapterIdempotent } from "./register.js";
import { reportLedgerAccount } from "./ledger.js";
const CHAT_API_BASE = "https://copilot.tencent.com/v2";
function isDeepSeekModel(model) {
  return /^deepseek/i.test(model.trim());
}
const PROVIDER = "buddy";
const DEFAULT_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "hy4-preview",
  "hy4-preview-x",
  "hy3",
  "hy3-x",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "kimi-k3-1",
  "kimi-k2.7",
  "kimi-k2.6",
  "minimax-m3"
];
const DEFAULT_MODEL = "deepseek-v4-flash";
const CONTEXT_WINDOWS = /* @__PURE__ */ new Map([
  ["deepseek-v4-flash", 1e6],
  ["deepseek-v4-pro", 1e6],
  ["hy4-preview", 1e6],
  ["hy4-preview-x", 1e6],
  ["hy3", 192e3],
  ["hy3-x", 192e3],
  ["glm-5.3", 1e6],
  ["glm-5.3-flash", 1e6],
  ["glm-5.2", 1e6],
  ["glm-5.1", 2e5],
  ["glm-5v-turbo", 2e5],
  ["kimi-k3-1", 1e6],
  ["kimi-k2.7", 256e3],
  ["kimi-k2.6", 256e3],
  ["minimax-m3", 512e3]
]);
const IMAGE_MODELS = /* @__PURE__ */ new Set([
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-sg",
  "deepseek-v4-pro",
  "hy4-preview",
  "hy4-preview-f",
  "hy4-preview-x",
  "hy3",
  "hy3-x",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "kimi-k3",
  "kimi-k3-1",
  "kimi-k2.8-preview",
  "kimi-k2.7",
  "kimi-k2.6",
  "minimax-m3"
]);
const REASONING_EFFORTS = /* @__PURE__ */ new Map([
  ["deepseek-v4-flash", ["low", "high", "max"]],
  ["deepseek-v4.1-flash", ["low", "high", "max"]],
  ["deepseek-v4-pro", ["low", "high", "xhigh"]],
  ["hy4-preview", ["high"]],
  ["hy4-preview-x", ["high"]],
  ["hy3", ["low", "high"]],
  ["hy3-x", ["low", "high"]],
  ["glm-5.3", ["low", "high", "max"]],
  ["glm-5.3-flash", ["low", "high", "max"]],
  ["glm-5.2", ["high", "xhigh"]]
]);
const EFFORT_NAMES = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max"
};
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => typeof block === "object" && block !== null && block.type === "text").map((block) => String(block.text)).join("");
}
const TOOL_RESULT_IMAGE_TEXT = "Attached image(s) from tool result:";
function serializeMessages(messages, imageUrls) {
  const wire = [];
  let pendingToolImages = [];
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return;
    wire.push({
      role: "user",
      content: [{ type: "text", text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages]
    });
    pendingToolImages = [];
  };
  const normalized = normalizeHarnessMessages(messages);
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized);
  for (const message of normalized) {
    if (message.role === "assistant") {
      const content2 = stripCourseLeakFromHistoryContent(
        message.role,
        Array.isArray(message.content) ? message.content : []
      );
      const toolCallBlocks = content2.filter((block) => typeof block === "object" && block !== null && block.type === "tool-call").filter((block) => keepCallIds.has(String(block.id)));
      const toolCalls = toolCallBlocks.map((block) => ({
        id: String(block.id),
        type: "function",
        function: { name: String(block.name), arguments: normalizeToolArguments(String(block.arguments)) }
      }));
      const reasoning = content2.filter((block) => typeof block === "object" && block !== null && block.type === "reasoning").map((block) => String(block.text)).join("");
      const text2 = contentToText(content2);
      if (text2.trim().length === 0 && toolCalls.length === 0) continue;
      flushToolImages();
      wire.push({
        role: "assistant",
        // 正文为空且有工具调用时 content 必须为 null（对齐 openai_chat.rs）。
        content: text2.length === 0 && toolCalls.length > 0 ? null : text2,
        reasoning_content: reasoning,
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
      });
      continue;
    }
    if (message.role === "system") {
      flushToolImages();
      wire.push({ role: "system", content: contentToText(message.content) });
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const toolResults = content.filter((block) => typeof block === "object" && block !== null && block.type === "tool-result");
    const text = contentToText(message.content);
    const regular = content.filter((block) => !(typeof block === "object" && block !== null && block.type === "tool-result"));
    const regularImageUrls = imageUrls;
    const parts = regularImageUrls === void 0 ? void 0 : userContentParts(regular, regularImageUrls);
    if (parts !== void 0) {
      flushToolImages();
      wire.push({ role: "user", content: parts });
    } else if (text.trim().length > 0) {
      flushToolImages();
      wire.push({ role: "user", content: text });
    }
    for (const result of toolResults) {
      if (!keepResultIds.has(String(result.toolCallId))) continue;
      let resultText = "(no output)";
      if (regularImageUrls !== void 0 && Array.isArray(result.content)) {
        const resultParts = userContentParts(result.content, regularImageUrls);
        if (resultParts !== void 0) {
          pendingToolImages.push(...resultParts.filter((part) => part.type !== "text"));
          const joined = resultParts.filter((part) => part.type === "text").map((part) => String(part.text)).join("");
          if (joined.length > 0) resultText = joined;
        } else {
          resultText = contentToText(result.content) || "(no output)";
        }
      } else {
        resultText = contentToText(result.content) || "(no output)";
      }
      wire.push({
        role: "tool",
        tool_call_id: String(result.toolCallId),
        content: resultText
      });
    }
  }
  flushToolImages();
  return wire;
}
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}
function isContentRejection(body) {
  if (body.length === 0) return false;
  try {
    const data = JSON.parse(body);
    if (data?.code === 11128 || data?.code === "11128") return false;
    if (data?.code === 11140 || data?.code === "11140") return true;
  } catch {
  }
  return /request illegal/i.test(body) || /安全审核|safety review/i.test(body);
}
const BUDDY_POLICY_BLOCK_COOLDOWN_MS = 30 * 6e4;
function contentRejectionError(productId, status, body, rotated) {
  const scope = rotated ? `\u5168\u90E8\u8D26\u53F7\u5747\u88AB\u670D\u52A1\u7AEF\u5B89\u5168\u7B56\u7565\u62E6\u622A\uFF08HTTP ${status}\uFF0C\u5DF2\u9010\u4E2A\u6362\u53F7\u91CD\u8BD5\uFF09` : `\u5F53\u524D\u8D26\u53F7\u88AB\u670D\u52A1\u7AEF\u5B89\u5168\u7B56\u7565\u62E6\u622A\uFF08HTTP ${status}\uFF0C\u6D41\u5185\u9519\u8BEF\u5E27\u4E0B\u53D1\uFF09`;
  return new LlmError(
    `${productId}: ${scope}\u3002\u8BE5\u62E6\u622A\u6309\u8D26\u53F7\u751F\u6548\uFF08\u540C\u4E00\u8BF7\u6C42\u5728\u5176\u4ED6\u8D26\u53F7\u53EF\u6B63\u5E38\u8FD4\u56DE\uFF09\uFF0C\u8BF7\u5728 Channel Pack \u505C\u7528\u6216\u66F4\u6362\u88AB\u62E6\u8D26\u53F7\uFF1A${errorDetail(body)}`,
    "PERMISSION_DENIED",
    { status }
  );
}
function policyBlockResetAtMs(nowMs) {
  return nowMs + BUDDY_POLICY_BLOCK_COOLDOWN_MS;
}
async function markPolicyBlockedAccount(pool, productId, accountId, modelId) {
  if (pool === void 0 || accountId.length === 0 || modelId.length === 0) return;
  try {
    await pool.updateModelRateLimit(accountId, modelId, policyBlockResetAtMs(Date.now()));
  } catch (error) {
    console.warn(`[${productId}] \u5B89\u5168\u7B56\u7565\u62E6\u622A\u7684\u51B7\u5374\u6807\u8BB0\u5199\u5165\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u672C\u6B21\u8BF7\u6C42\uFF09:`, error);
  }
}
function errorDetail(body) {
  try {
    const data = JSON.parse(body);
    const error = typeof data.error === "object" && data.error !== null ? data.error : void 0;
    const display = typeof data.displayMsg === "object" && data.displayMsg !== null ? data.displayMsg : void 0;
    const localized = typeof display?.zh === "string" ? display.zh : typeof display?.en === "string" ? display.en : void 0;
    const parts = [
      // 本地化文案最可读，排在最前。
      localized,
      typeof error?.code === "string" ? error.code : void 0,
      typeof error?.type === "string" ? error.type : void 0,
      typeof error?.message === "string" ? error.message : void 0,
      // 腾讯系用 `msg` 而非 `message`。
      typeof data.msg === "string" ? data.msg : void 0,
      typeof data.message === "string" ? data.message : void 0
    ].filter((value) => value !== void 0);
    if (parts.length > 0) return parts.join(" ");
  } catch {
  }
  return body;
}
const GATEWAY_PROMPT_TOO_LONG = /\bprompt\s+is\s+too\s+long\b[\s\S]{0,40}?\b\d[\d,]*\s+tokens?\s*>/i;
function httpErrorCode(status, body) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(body) || GATEWAY_PROMPT_TOO_LONG.test(body)) {
      return CONTEXT_WINDOW_EXCEEDED_CODE;
    }
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}
function resolveFirstTokenTimeoutMs() {
  return Number.parseInt(process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS ?? "", 10) || 12e4;
}
function resolveChunkTimeoutMs() {
  return Number.parseInt(process.env.DSH_BUDDY_SSE_CHUNK_TIMEOUT_MS ?? "", 10) || 12e4;
}
const BUDDY_SATURATION_MAX_RETRIES = 2;
const BUDDY_SATURATION_BASE_DELAY_MS = 2e3;
function buddySaturationDelayMs(attempt) {
  const raw = process.env.DSH_BUDDY_SATURATION_DELAY_MS;
  const base = raw === void 0 || raw === "" ? BUDDY_SATURATION_BASE_DELAY_MS : Number(raw);
  const resolved = Number.isFinite(base) && base >= 0 ? base : BUDDY_SATURATION_BASE_DELAY_MS;
  return resolved * (attempt + 1);
}
function sleepMs(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
function isTransportError(error) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes("terminated")) return true;
  if (error.name.startsWith("UND_ERR_")) return true;
  if (message.includes("fetch failed")) return true;
  if (message.includes("econnreset") || message.includes("epipe") || message.includes("socket hang up")) return true;
  return false;
}
function userContentParts(content, imageUrls) {
  const parts = [];
  let hasImage = false;
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw;
    if (block.type === "text") {
      const text = String(block.text ?? "");
      if (text.length > 0) parts.push({ type: "text", text });
      continue;
    }
    if (block.type === "image") {
      hasImage = true;
      const url = block.attachment?.attachmentId === void 0 ? void 0 : imageUrls.get(String(block.attachment.attachmentId));
      parts.push(url === void 0 ? { type: "text", text: "[image unavailable]" } : { type: "image_url", image_url: { url } });
      continue;
    }
    if (block.type === "tool-result" && Array.isArray(block.content)) {
      const inner = userContentParts(block.content, imageUrls);
      if (inner !== void 0) {
        hasImage = true;
        parts.push(...inner);
      } else {
        const text = contentToText(block.content);
        if (text.length > 0) parts.push({ type: "text", text });
      }
    }
  }
  return hasImage && parts.length > 0 ? parts : void 0;
}
function collectImages(content, refs) {
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw;
    if (block.type === "image" && typeof block.attachment?.attachmentId === "string") {
      refs.set(block.attachment.attachmentId, block.attachment);
      continue;
    }
    if (block.type === "tool-result" && Array.isArray(block.content)) collectImages(block.content, refs);
  }
}
class BuddyAdapter extends LlmAdapter {
  constructor(options) {
    super();
    this.options = options;
    this.product = options.product ?? CODEBUDDY;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sessionId = options.sessionId ?? crypto.randomUUID().replace(/-/g, "");
    const fallback = this.product.fallbackModels ?? [];
    this.productFallbackIndex = new Map(fallback.map((model) => [model.id, model]));
    this.productFallbackContextWindows = new Map(
      fallback.filter((model) => model.contextWindow !== void 0).map((model) => [model.id, model.contextWindow])
    );
  }
  /** 本适配器所属的产品配置（默认 CodeBuddy）。 */
  product;
  fetchImpl;
  /**
   * 前缀缓存会话标识（prompt_cache_key）。同一会话内所有请求复用同一 key，
   * 服务端据此把相同前缀的 KV 缓存跨请求复用；缺失时缓存命中恒为 0。
   */
  sessionId;
  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  remoteModels;
  /**
   * 目录加载闸门：并发去重 + 失败/空结果冷却。
   * 依据见 `src/remote-catalog-gate.ts`（首屏「加载模型巨长」的实测归因）。
   */
  catalogGate = new RemoteCatalogGate();
  /** 远端下发的模型元数据（id → 能力），listModels/resolveModel/stream 共用。 */
  remoteMeta = /* @__PURE__ */ new Map();
  /** 远端下发的模型上下文窗口（/v3/config data.models[].maxInputTokens）。 */
  remoteContextWindows = /* @__PURE__ */ new Map();
  /**
   * 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。
   * 远端缺失时补位；构造时一次性建立，只读。
   */
  productFallbackIndex;
  /** 产品级兜底上下文窗口（构造时从 fallbackModels 提取）。 */
  productFallbackContextWindows;
  /**
   * 该模型此刻是否**免费**（消耗 0 积分）。
   *
   * ## 为什么需要它
   *
   * `pickBuddyCredential`（`src/index.ts`）只问「锁没锁 + 有没有临期积分」，
   * 从不问「这个模型要不要钱」。于是免费模型也会被「锁定永久积分 + 无临期积分」
   * 这道门拦下，报出「没有可用账号……已锁定永久积分，而所有账号的『N 天内到期』
   * 积分都已用尽」，而它**一分积分都不需要** —— 用户看到的是
   * 「账号明明有余额却失败」的矛盾错误（真实报障）。
   *
   * 免费模型既不消耗临时积分也不消耗永久积分，故它与「锁定」要保护的
   * 目标（别把永久积分烧掉）无关，不该受该门约束。
   *
   * ## 判据（任一成立即免费，与展示层口径一致）
   *
   * 1. `creditsRate === 'x0'` —— 服务端 `credits: "0x"` / `"x0"`；
   * 2. `discountedCreditsRate === 'x0'` —— 促销价打到 0；
   * 3. 两者 === `'免费'` —— 促销 `factor: 0` 时 `parsePromotions` 直接写入的
   *    **中文串**（不是 `x0`，这条最容易漏，见 `src/buddy.ts` 的 `rate = '免费'`）。
   *
   * ⚠️ **只在确定免费时返回 true**：字段缺失、解析失败、未知模型一律 false。
   * 把付费模型误判成免费会绕开锁定，**真烧掉永久积分且不可撤回** ——
   * 因此这里取「保守方向」：宁可让免费模型多走一次余额门，
   * 也不放过任何无法确认的情形。
   *
   * ⚠️ 远端目录是懒加载的（`ensureRemoteModels()`），必须先 await：
   * 调用点虽在 `prepareCall` 之后（目录通常已就绪），但「直接进会话」等路径
   * 可能尚未拉取，漏掉这一步补丁会**静默失效**（退回被拦截的行为）。
   *
   * @param modelId - 模型 id。
   * @returns true 仅当能确认该模型消耗 0 积分。
   */
  async isFreeModel(modelId) {
    if (typeof modelId !== "string" || modelId.length === 0) return false;
    await this.ensureRemoteModels();
    const meta = this.remoteMeta.get(modelId);
    if (meta === void 0) return false;
    const isZeroRate = (rate) => rate === "x0" || rate === "\u514D\u8D39";
    return isZeroRate(meta.creditsRate) || isZeroRate(meta.discountedCreditsRate);
  }
  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * DSH 会强制校验 `info.id === provider` 且 `info.name` 为非空字符串；
   * 模型设置页还会用该 id 计算 `deriveKeyRef(provider)`（内部调用
   * `provider.toUpperCase()`）。因此这里对入参做防御性归一化：
   * 一旦 `provider` 不是字符串（例如上游传入了 undefined），
   * 直接回退到本适配器所属产品的 id，避免
   * `undefined.toUpperCase is not a function` 在客户端炸开。
   *
   * 展示名同样来自产品配置：CodeBuddy 为 'CodeBuddy (腾讯)'，
   * WorkBuddy 为 'WorkBuddy'。
   */
  providerInfo(provider) {
    const id = typeof provider === "string" && provider.length > 0 ? provider : this.product.id;
    return { id, name: this.product.displayName };
  }
  /**
   * 模型列表：优先使用 /v3/config 动态拉取的远端列表，否则回退静态默认。
   * 动态拉取失败时静默回退（与 Rust fetch_models 的 Vec::new() 语义一致）。
   */
  /**
   * 懒加载远端模型目录（仅拉取一次）。listModels 与 resolveModel 共用：
   * resolveModel 可能先于 listModels 被调用（如直接进入会话），此时同样
   * 触发一次远端拉取，保证 /v3/config 的 maxInputTokens 能生效。
   */
  /**
   * 按产品的像素预算派生一张图片的**请求版本**。
   *
   * 判据与回退都在共享的 `projectRequestImage` 里（raccoon 用的是同一份 ——
   * 两个适配器各写一遍正是本仓库反复出缺陷的形态）。返回 `undefined`
   * 表示本次发原图，四种正常情形见该函数的注释。
   *
   * ⚠️ 预算取 `product.imagePixelBudget`，未配置时用
   * `DEFAULT_IMAGE_PIXEL_BUDGET`（640,000 px ≈ 1,037 视觉 token）。
   */
  async projectRequestImage(ref) {
    return projectRequestImage(ref, {
      readImageRequest: this.options.readImageRequest,
      pixelBudget: this.product.imagePixelBudget
    });
  }
  async ensureRemoteModels() {
    const fetchRemote = this.options.fetchRemoteModels;
    if (this.remoteModels !== void 0 || fetchRemote === void 0) return;
    await this.catalogGate.run(async () => {
      const models = await fetchRemote();
      if (models.length === 0) return false;
      const reconciled = this.reconcileWithFallback(models);
      this.remoteModels = reconciled;
      this.remoteMeta = new Map(reconciled.map((model) => [model.id, model]));
      this.remoteContextWindows = new Map(
        reconciled.filter((model) => model.contextWindow !== void 0).map((model) => [model.id, model.contextWindow])
      );
      return true;
    });
  }
  /**
   * 用产品兜底表校正远端结果。
   *
   * 为什么需要校正：服务端按**认证上下文**决定返回哪些模型，插件的 CLI
   * token 拿到的集合可能是残缺甚至错的 —— 实测 WorkBuddy 国际版的 CLI token
   * 只拿到 13 个内部别名（含实际不可用的 `o4-mini`），而 IDE 用的是 20 个
   * （含全部 GPT 系列）。此时若直接采信远端，模型选择器会缺掉用户真正要用的模型。
   *
   * 有产品兜底表时以它为准：
   * - 只保留兜底表里声明的 id（远端多出来的别名/内部模型被丢弃）；
   * - 兜底表声明但远端缺失的模型补进来（用兜底表的元数据）；
   * - ⚠️ **例外：被 agent 引用的模型即使不在兜底表也保留**（见下）。
   *
   * ⚠️ **为什么需要那个例外**：两个端点下发的 id 集合**不同**，而兜底表是
   * 编译期快照、只覆盖其中一套。实测（2026-09-21）`hy4-preview-f`
   * —— 新用户限时免费变体 —— **只由 `/v3/config` 下发**，且被
   * `craft`/`ask`/`plan` 三个 agent 引用（即服务端声明「对话里可选」），
   * 但**不在兜底表**里。白名单重建会把它丢掉，于是用户看不到那个免费变体，
   * 而 IDE 里能看到（用户报障「hy4 preview 现在 ide 是免费我们还是 0.29」）。
   *
   * 判据用 `agentReferenced`（服务端自己的「可选」信号）而非猜测 id 后缀 ——
   * 后缀规则不统一（`-f` / `-x` / `-sg` / `-ioa` 含义各异），猜错会放进
   * 不可用的模型。未标记的内部别名（如 `default`）不会被误留。
   */
  reconcileWithFallback(models) {
    const fallback = this.product.fallbackModels;
    if (fallback === void 0 || fallback.length === 0) return [...models];
    const remoteById = new Map(models.map((model) => [model.id, model]));
    const reconciled = fallback.map((entry) => {
      const remote = remoteById.get(entry.id);
      return {
        id: entry.id,
        name: remote?.name ?? entry.name,
        ...entry.contextWindow !== void 0 || remote?.contextWindow !== void 0 ? { contextWindow: remote?.contextWindow ?? entry.contextWindow } : {},
        // 输出上限同样「远端优先、兜底补位」：远端不下发时兜底表给保守值，
        // 两边都没有则留 undefined（不编造，见 resolveModel 的说明）。
        ...entry.maxOutputTokens !== void 0 || remote?.maxOutputTokens !== void 0 ? { maxOutputTokens: remote?.maxOutputTokens ?? entry.maxOutputTokens } : {},
        ...entry.supportsImages !== void 0 || remote?.supportsImages !== void 0 ? { supportsImages: remote?.supportsImages ?? entry.supportsImages } : {},
        ...entry.reasoningEfforts !== void 0 || remote?.reasoningEfforts !== void 0 ? { reasoningEfforts: [...remote?.reasoningEfforts ?? entry.reasoningEfforts ?? []] } : {},
        ...entry.defaultReasoningEffort !== void 0 || remote?.defaultReasoningEffort !== void 0 ? { defaultReasoningEffort: remote?.defaultReasoningEffort ?? entry.defaultReasoningEffort } : {},
        // 计费倍率只可能来自远端（兜底表是编译期快照，价格会变，不写死）。
        // 注意本函数是**白名单式重建**：不在这里显式搬运的字段会被静默丢弃，
        // 新增远端字段时必须同步加一行，否则 listModels 看不到它。
        ...remote?.creditsRate !== void 0 ? { creditsRate: remote.creditsRate } : {},
        ...remote?.discountedCreditsRate !== void 0 ? { discountedCreditsRate: remote.discountedCreditsRate } : {}
      };
    });
    const known = new Set(reconciled.map((model) => model.id));
    for (const model of models) {
      if (model.agentReferenced !== true || known.has(model.id)) continue;
      known.add(model.id);
      reconciled.push({ ...model });
    }
    return reconciled;
  }
  /**
   * 远端能力字段被实测证伪、需要强制覆盖为「支持图片」的模型。
   *
   * 为什么需要它：上游两个模型端点对同一模型的能力声明会互相矛盾。
   * 实测 `glm-5.1`（2026-09）：
   * - scoped 端点 `/console/enterprises/personal/models` → `supportsImages: false`
   * - `/v3/config` → `supportsImages: true`
   * - 真实请求（纯红图 + 问颜色）→ 答出「红色」，**确实能看到图片**
   *
   * 由于 `fetchModels` 优先采用 scoped 端点，若不覆盖，`glm-5.1` 会被判成
   * 纯文本，用户贴图时直接吃 host 的 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝
   * （前端文案「当前模型不支持图片」），而图片根本到不了上游。
   *
   * 为什么用显式白名单而不是「兜底表 true 优先」这类通用规则：通用规则会让
   * 兜底表永久压过远端，一旦某模型真的下线或能力变更，用户会被放行后被上游
   * 400 拒绝 —— 错误更晚、更难懂。白名单只覆盖已实测确认的个案，新增条目
   * 必须先有真实请求证据。
   */
  static IMAGE_CAPABILITY_OVERRIDES = /* @__PURE__ */ new Set([
    // scoped 端点误报 false，实测能看图。
    "glm-5.1"
  ]);
  /**
   * 模型接受的输入模态：远端 supportsImages 优先，静态表兜底；
   * {@link IMAGE_CAPABILITY_OVERRIDES} 中的模型强制为支持图片。
   */
  inputModalitiesFor(model) {
    const supportsImages = BuddyAdapter.IMAGE_CAPABILITY_OVERRIDES.has(model) || (this.remoteMeta.get(model)?.supportsImages ?? this.productFallbackMeta.get(model)?.supportsImages ?? IMAGE_MODELS.has(model));
    return supportsImages ? ["text", "image"] : ["text"];
  }
  /** 模型可选的思考等级：远端 supportedEfforts 优先，产品兜底表次之，通用静态表最后。 */
  effortsFor(model) {
    return this.remoteMeta.get(model)?.reasoningEfforts ?? this.productFallbackMeta.get(model)?.reasoningEfforts ?? REASONING_EFFORTS.get(model) ?? [];
  }
  /**
   * 模型声明的默认思考等级（远端 `reasoning.defaultEffort` 优先，产品兜底表次之）。
   *
   * 用途：composer 未选档位时补 `reasoning_effort`（deepseek 系不带档位 = 不思考）。
   * 若声明值不在该模型的支持档内（远端数据不一致）则视为未声明，由调用方回退。
   */
  defaultEffortFor(model) {
    const declared = this.remoteMeta.get(model)?.defaultReasoningEffort ?? this.productFallbackMeta.get(model)?.defaultReasoningEffort;
    return declared !== void 0 && this.effortsFor(model).includes(declared) ? declared : void 0;
  }
  /**
   * 产品级兜底模型目录（`product.fallbackModels`）。
   *
   * 用于远端不可用或远端未覆盖到该模型时。与 `remoteMeta` 分开存放，
   * 使远端一旦可用就自动优先，而产品兜底只在缺失时补位。
   */
  get productFallbackMeta() {
    return this.productFallbackIndex;
  }
  /**
   * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率 + 同名消歧）。
   *
   * 设置页（Channel Pack「显示列表」）必须把**被关闭的**模型也渲染出来，否则用户
   * 无法重新打开；而 `listModels` 会按黑名单过滤掉它们，RPC 层只能凭黑名单的
   * key（裸 id）补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率随之丢失**
   * （用户报障：「关闭的就没有显示倍率」）。
   *
   * ⚠️ 同名消歧必须基于**未过滤**的全量集合：`displayNameFor(model, source)`
   * 而非 `listed`。用过滤后的集合会让「关掉其中一个同名模型」改变另一个的
   * 变体标记，名字随开关跳变。
   */
  listAllModels() {
    const source = this.remoteModels ?? this.staticFallbackModels();
    return source.map((model) => ({ id: model.id, name: displayNameFor(model, source) }));
  }
  async listModels(_provider) {
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return [];
    await this.ensureRemoteModels();
    const source = this.remoteModels ?? this.staticFallbackModels();
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id);
    const listed = disabled === void 0 || disabled.size === 0 ? source : source.filter((model) => !disabled.has(model.id));
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: displayNameFor(model, listed),
      inputModalities: this.inputModalitiesFor(model.id)
    }));
  }
  /**
   * 静态兜底模型目录：优先用产品自带的 `fallbackModels`，否则用通用默认表。
   *
   * 产品兜底表存在的原因：模型池由服务端按认证上下文下发，插件的 CLI
   * token 未必能取到完整集合（实测 WorkBuddy 国际版经 CLI token 只能拿到
   * 13 个别名，拿不到 GPT 系列）。产品兜底表提供该产品权威的完整清单。
   */
  staticFallbackModels() {
    const productModels = this.product.fallbackModels;
    if (productModels !== void 0 && productModels.length > 0) {
      return productModels.map((model) => ({ id: model.id, name: model.name }));
    }
    return DEFAULT_MODELS.map((id) => ({ id, name: id }));
  }
  async resolveModel(provider, model, _signal) {
    await this.ensureRemoteModels();
    const contextWindow = this.remoteContextWindows.get(model) ?? this.productFallbackContextWindows.get(model) ?? CONTEXT_WINDOWS.get(model);
    const resolved = {
      provider,
      id: model,
      name: this.remoteMeta.get(model)?.name ?? this.productFallbackIndex.get(model)?.name ?? model,
      inputModalities: this.inputModalitiesFor(model)
    };
    if (contextWindow !== void 0) resolved.context = { contextWindow };
    const maxOutputTokens = positiveMaxTokens(
      this.remoteMeta.get(model)?.maxOutputTokens ?? this.productFallbackMeta.get(model)?.maxOutputTokens
    );
    if (maxOutputTokens !== void 0) resolved.defaultMaxTokens = maxOutputTokens;
    const efforts = this.effortsFor(model);
    if (efforts.length > 0) {
      const remoteDefault = this.remoteMeta.get(model)?.defaultReasoningEffort ?? this.productFallbackIndex.get(model)?.defaultReasoningEffort;
      resolved.reasoning = {
        efforts: efforts.map((id) => ({
          id: ReasoningEffortId(id),
          name: EFFORT_NAMES[id] ?? id
        })),
        ...remoteDefault !== void 0 && efforts.includes(remoteDefault) ? { defaultEffort: ReasoningEffortId(remoteDefault) } : {}
      };
    }
    return resolved;
  }
  /**
   * 兼容 0.1.1-rc.2：新版 LlmRuntime.prepareCall() 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * （0.1.0-rc.6）的 LlmAdapter 基类尚未提供该方法，缺少时会在每轮请求
   * 开始时抛 `registration.adapter.prepareCall is not a function`。这里把
   * 模型解析与分发绑定到同一个适配器实例（与 CodeArtsAdapter 同款 shim）。
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    };
  }
  async *stream(options) {
    let credential = await this.options.resolveCredential(options.model);
    if (credential === void 0 || isCredentialExpired(credential)) {
      await this.options.refresh();
      credential = await this.options.resolveCredential(options.model);
    }
    if (credential === void 0 || credential.access_token.length === 0) {
      throw new LlmError(
        // ⚠️ 文案里**不能**再提 `/buddy-login` —— 该斜杠命令已随单凭据模式一并移除
        // （AGENTS.md「不注册任何斜杠命令」），入口在 Channel Pack 设置页。
        `${this.product.id}: no usable credential; log in from the Channel Pack panel first`,
        "MISSING_CREDENTIAL"
      );
    }
    let currentAccountId = "";
    if (this.options.accountPool && credential) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id,
          credential.access_token
        );
        if (currentAccountId === "") {
          console.warn(`[${this.product.id}] \u5F53\u524D\u51ED\u636E\u672A\u5339\u914D\u5230\u8D26\u53F7\u6C60\u6761\u76EE\uFF0C\u9650\u6D41\u8BB0\u5F55\u5C06\u88AB\u8DF3\u8FC7`);
        }
        if (currentAccountId !== "") reportLedgerAccount(this.product.id, currentAccountId);
      } catch (error) {
        console.warn(`[${this.product.id}] \u8D26\u53F7\u5339\u914D\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u672C\u6B21\u8BF7\u6C42\uFF09:`, error);
      }
    }
    await this.ensureRemoteModels();
    const imageRefs = /* @__PURE__ */ new Map();
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs);
    }
    let imageUrls;
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(options.model).includes("image")) {
        throw new LlmError(`${this.product.id}: model "${options.model}" does not accept image input.`, "UNSUPPORTED_CONTENT");
      }
      if (this.options.readImage === void 0) {
        throw new LlmError(`${this.product.id}: image input requires the attachment service.`, "UNSUPPORTED_CONTENT");
      }
      imageUrls = /* @__PURE__ */ new Map();
      for (const [id, ref] of imageRefs) {
        const projected = await this.projectRequestImage(ref);
        if (projected !== void 0) {
          imageUrls.set(id, `data:${projected.mediaType};base64,${Buffer.from(projected.data).toString("base64")}`);
          continue;
        }
        let image;
        try {
          image = await this.options.readImage(ref);
        } catch (error) {
          throw new LlmError(
            `${this.product.id}: \u8BFB\u53D6\u56FE\u7247\u9644\u4EF6\u5931\u8D25\uFF08${id}\uFF09\uFF1A${errorMessage(error)}`,
            "UNSUPPORTED_CONTENT",
            { cause: error }
          );
        }
        if (image === void 0) {
          throw new LlmError(
            `${this.product.id}: \u56FE\u7247\u9644\u4EF6\u8BFB\u53D6\u4E0D\u5230\u5185\u5BB9\uFF08${id}\uFF09\uFF1B\u9644\u4EF6\u670D\u52A1\u53EF\u80FD\u672A\u5C31\u7EEA\uFF0C\u6216\u8BE5\u5BF9\u8C61\u5DF2\u4E0D\u5B58\u5728\u3002`,
            "UNSUPPORTED_CONTENT"
          );
        }
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`);
      }
    }
    const messages = serializeMessages(options.messages, imageUrls);
    if (options.system !== void 0 && options.system.length > 0) {
      messages.unshift({ role: "system", content: options.system });
    }
    if (this.product.id === "workbuddy" && (messages.length === 0 || messages[0].role !== "system")) {
      messages.unshift({ role: "system", content: "You are a helpful assistant." });
    }
    const tools = options.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
    const bodyObj = {
      model: options.model,
      messages,
      stream: true,
      // prompt_cache_key 让服务端启用前缀缓存并在 usage 中返回缓存命中，
      // 缺少该字段时命中恒为 0（与 codearts 同款修复，见 llm-adapter.ts）。
      // 实证（2026 实测 deepseek-v4-flash，同一段 8k token 前缀）：
      //   不带该字段 → prompt_tokens=8027, prompt_cache_hit_tokens=0,    credit=0.34
      //   带该字段   → prompt_tokens=8027, prompt_cache_hit_tokens=7808, credit=0.02
      // 仅此一个字段的差异，费用差约 17 倍。同 key 重复请求稳定命中同一前缀。
      prompt_cache_key: this.sessionId
    };
    if (tools !== void 0 && tools.length > 0) bodyObj.tools = tools;
    if (options.temperature !== void 0) bodyObj.temperature = options.temperature;
    if (options.stop !== void 0 && options.stop.length > 0) bodyObj.stop = options.stop;
    const maxTokens = positiveMaxTokens(
      options.maxTokens ?? this.remoteMeta.get(options.model)?.maxOutputTokens ?? this.productFallbackMeta.get(options.model)?.maxOutputTokens
    );
    if (maxTokens !== void 0) bodyObj.max_tokens = maxTokens;
    const deepseek = isDeepSeekModel(options.model);
    if (deepseek) {
      bodyObj.thinking = { type: "enabled" };
    }
    const efforts = this.effortsFor(options.model);
    if (options.reasoningEffort !== void 0 && efforts.includes(options.reasoningEffort)) {
      bodyObj.reasoning_effort = options.reasoningEffort;
    } else if (deepseek && efforts.length > 0) {
      bodyObj.reasoning_effort = this.defaultEffortFor(options.model) ?? (efforts.includes("high") ? "high" : efforts[0]);
    }
    const body = JSON.stringify(bodyObj);
    let response = await this.send(credential, body, options);
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      const rejectedBody = await response.clone().text().catch(() => "");
      const contentRejected = isContentRejection(rejectedBody);
      if (contentRejected) {
        console.warn(
          `[${this.product.id}] \u8D26\u53F7 ${currentAccountId || "(current)"} \u88AB\u5B89\u5168\u7B56\u7565\u62E6\u622A\uFF08HTTP ${response.status}\uFF0Ccode 11140\uFF09\uFF0C\u7EE7\u7EED\u6362\u53F7\uFF1A${errorDetail(rejectedBody).slice(0, 200)}`
        );
        await markPolicyBlockedAccount(
          this.options.accountPool,
          this.product.id,
          currentAccountId,
          options.model
        );
      }
      const authStatus = response.status;
      const triedAuth = /* @__PURE__ */ new Set();
      if (currentAccountId !== "") triedAuth.add(currentAccountId);
      let refreshedCredential;
      try {
        await this.options.refresh();
        refreshedCredential = await this.options.resolveCredential(options.model);
      } catch (error) {
        console.warn(`[${this.product.id}] \u5237\u65B0\u5F53\u524D\u8D26\u53F7\u51ED\u636E\u5931\u8D25\uFF0C\u6539\u7528\u6362\u53F7\u91CD\u8BD5\uFF1A${String(error)}`);
      }
      if (refreshedCredential !== void 0 && refreshedCredential.access_token.length > 0) {
        credential = refreshedCredential;
        response = await this.send(credential, body, options);
        if (response.ok) {
          yield* this.consumeSse(response, options, currentAccountId);
          return;
        }
      }
      let rotated = false;
      let sawContentRejection = contentRejected;
      let rejectionStatus = contentRejected ? authStatus : 0;
      let rejectionBody = contentRejected ? rejectedBody : "";
      if ((response.status === 401 || response.status === 403) && this.options.accountPool !== void 0) {
        for (; ; ) {
          const next = await this.options.accountPool.getAvailableAccount(
            this.product.id,
            options.model,
            triedAuth
          );
          if (!next || triedAuth.has(next.entry.id)) break;
          triedAuth.add(next.entry.id);
          rotated = true;
          credential = next.credential;
          currentAccountId = next.entry.id;
          response = await this.send(credential, body, options);
          if (response.ok) {
            yield* this.consumeSse(response, options, currentAccountId);
            return;
          }
          const rotatedBody = await response.clone().text().catch(() => "");
          if (isContentRejection(rotatedBody)) {
            sawContentRejection = true;
            rejectionStatus = response.status;
            rejectionBody = rotatedBody;
            await markPolicyBlockedAccount(
              this.options.accountPool,
              this.product.id,
              currentAccountId,
              options.model
            );
          }
          if (response.status !== 401 && response.status !== 403) break;
        }
      }
      if (refreshedCredential === void 0 && !rotated) {
        if (sawContentRejection) {
          throw contentRejectionError(
            this.product.id,
            rejectionStatus === 0 ? authStatus : rejectionStatus,
            rejectionBody.length === 0 ? rejectedBody : rejectionBody,
            true
          );
        }
        throw new LlmError(`${this.product.id}: credential expired and refresh failed`, "AUTH", { status: authStatus });
      }
      if (response.status === 401 || response.status === 403) {
        const detail = await response.text().catch(() => "");
        if (sawContentRejection || isContentRejection(detail)) {
          throw contentRejectionError(
            this.product.id,
            rejectionStatus === 0 ? authStatus : rejectionStatus,
            rejectionBody.length === 0 ? detail : rejectionBody,
            true
          );
        }
        throw new LlmError(
          `${this.product.id}: \u6240\u6709\u8D26\u53F7\u5747\u88AB\u62D2\u7EDD\uFF08HTTP ${authStatus}${authStatus === 401 ? "\uFF0C\u8BF7\u5728 Channel Pack \u91CD\u65B0\u767B\u5F55" : ""}\uFF09\uFF1A${errorDetail(detail)}`,
          httpErrorCode(authStatus, detail),
          { status: authStatus }
        );
      }
    }
    if (!response.ok) {
      let errorText = await response.text().catch(() => "");
      if (isModelSaturationError(response.status, errorText)) {
        for (let attempt = 0; attempt < BUDDY_SATURATION_MAX_RETRIES; attempt += 1) {
          const waitMs = buddySaturationDelayMs(attempt);
          console.warn(
            `[${this.product.id}] \u6A21\u578B ${options.model} \u8BF7\u6C42\u91CF\u9971\u548C\uFF08\u4E0A\u6E38 14003 model busy\uFF09\uFF0C${waitMs}ms \u540E**\u5728\u672C\u8D26\u53F7**\u91CD\u8BD5\uFF08\u7B2C ${attempt + 1}/${BUDDY_SATURATION_MAX_RETRIES} \u6B21\uFF09\u2014\u2014 \u4E0D\u6362\u53F7\u3001\u4E0D\u5199\u9650\u6D41\u6807\u8BB0\uFF1A\u9971\u548C\u662F\u6A21\u578B\u7EA7\uFF0C\u6C60\u91CC\u5176\u5B83\u8D26\u53F7\u4F1A\u649E\u540C\u4E00\u5835\u5899`
          );
          await sleepMs(waitMs);
          response = await this.send(credential, body, options);
          if (response.ok) {
            yield* this.consumeSse(response, options, currentAccountId);
            return;
          }
          errorText = await response.text().catch(() => "");
          if (!isModelSaturationError(response.status, errorText)) break;
        }
        if (isModelSaturationError(response.status, errorText)) {
          throw new LlmError(
            `${this.product.id}: \u6A21\u578B ${options.model} \u5F53\u524D\u8BF7\u6C42\u91CF\u9971\u548C\uFF08\u4E0A\u6E38 14003 model busy\uFF0C\u62A5\u6587\u539F\u6587\uFF1A\u300C\u6A21\u578B\u7E41\u5FD9\uFF0C\u8BF7\u6362\u6A21\u578B\u6216\u7A0D\u540E\u91CD\u8BD5\u300D\uFF09\uFF0C\u5DF2\u91CD\u8BD5 ${BUDDY_SATURATION_MAX_RETRIES} \u6B21\u4ECD\u672A\u901A\u8FC7\u3002\u6B64\u4E3A\u8BE5**\u6A21\u578B**\u6574\u4F53\u7E41\u5FD9\uFF0C\u5E76\u975E\u8D26\u53F7\u989D\u5EA6\u95EE\u9898 \u2014\u2014 \u6362\u8D26\u53F7\u65E0\u6548\uFF0C\u8BF7\u6539\u7528\u5176\u5B83\u6A21\u578B\uFF0C\u6216\u7A0D\u540E\u91CD\u8BD5\uFF08\u65E0\u9700\u91CD\u65B0\u767B\u5F55\uFF09\u3002`,
            "RATE_LIMIT",
            { status: response.status }
          );
        }
      }
      // ⚠️ 额度用尽（14018）**绝不**写限流标记：见下方 isQuotaExhaustedError 分支的说明。
      if (this.options.accountPool && isRateLimited(errorText, response.status)
        && !isQuotaExhaustedError(response.status, errorText)) {
        const tried = /* @__PURE__ */ new Set();
        if (currentAccountId) tried.add(currentAccountId);
        let sawContentRejection = false;
        let contentRejectionStatus = 0;
        let contentRejectionBody = "";
        const rateLimitMarked = /* @__PURE__ */ new Set();
        for (; ; ) {
          if (currentAccountId !== "" && isRateLimited(errorText, response.status) && !rateLimitMarked.has(currentAccountId)) {
            rateLimitMarked.add(currentAccountId);
            const parsed = parseRateLimitError(errorText, options.model, response.status);
            await this.options.accountPool.updateModelRateLimit(
              currentAccountId,
              parsed?.modelId ?? options.model,
              parsed?.resetTimeMs ?? Date.now() + RATE_LIMIT_FALLBACK_MS
            );
          }
          const next = await this.options.accountPool.getAvailableAccount(
            this.product.id,
            options.model,
            tried
          );
          if (!next || tried.has(next.entry.id)) break;
          tried.add(next.entry.id);
          credential = next.credential;
          currentAccountId = next.entry.id;
          response = await this.send(credential, body, options);
          if (response.ok) {
            yield* this.consumeSse(response, options, currentAccountId);
            return;
          }
          errorText = await response.text().catch(() => "");
          if (isContentRejection(errorText)) {
            sawContentRejection = true;
            contentRejectionStatus = response.status;
            contentRejectionBody = errorText;
            console.warn(
              `[${this.product.id}] \u8D26\u53F7 ${currentAccountId || "(current)"} \u88AB\u5B89\u5168\u7B56\u7565\u62E6\u622A\uFF08HTTP ${response.status}\uFF0Ccode 11140\uFF09\uFF0C\u7EE7\u7EED\u6362\u53F7\uFF1A${errorDetail(errorText).slice(0, 200)}`
            );
            await markPolicyBlockedAccount(
              this.options.accountPool,
              this.product.id,
              currentAccountId,
              options.model
            );
            continue;
          }
          if (response.status === 401 || response.status === 403) continue;
          if (!isRateLimited(errorText, response.status)) {
            throw new LlmError(`${this.product.id}: ${errorDetail(errorText)}`, httpErrorCode(response.status, errorText), { status: response.status });
          }
        }
        if (sawContentRejection) {
          throw contentRejectionError(
            this.product.id,
            contentRejectionStatus || 403,
            contentRejectionBody,
            true
          );
        }
        // 全池轮完仍失败：必须分清「额度用尽」与「限流」，否则文案会把人带偏
        // （额度用尽没有解禁时刻，等一小时也不会好，得换号或加量）。
        if (isQuotaExhaustedError(response.status, errorText)) {
          throw new LlmError(
            `${this.product.id}: 账号额度已用尽（上游 code 14018），`
            + `模型 ${options.model} 在本产品下已无可用额度。`
            + '换用其它账号、其它模型或其它通道；等待不会恢复：上游没有给出重置时刻。'
            + '上游原话：「额度已用尽，请访问以下链接，购买加量包以获取更多额度」。',
            "QUOTA_EXCEEDED",
            { status: response.status },
          );
        }
        throw new LlmError(`${this.product.id}: 模型 ${options.model} 所有账号均受限，请稍后再试`, "QUOTA_EXCEEDED");
      }
      // 走到这里说明不是限流 / 不是全池轮询路径。额度用尽必须有**自己的**文案：
      // 早先它与 6004 共用分支，导致「额度没了」被写成「所有账号均在限流，
      // 将于 X 解禁」——X 是本地兜底算出来的，上游从未承诺（2026-10-21 实测 14018）。
      if (isQuotaExhaustedError(response.status, errorText)) {
        throw new LlmError(
          `${this.product.id}: 账号额度已用尽（上游 code 14018），`
          + `模型 ${options.model} 在 ${this.product.displayName} 下已无可用额度。`
          + '换用其它账号、其它模型或其它通道；等待不会恢复：上游没有给出重置时刻。'
          + `上游原话：${errorDetail(errorText).slice(0, 300)}`,
          "QUOTA_EXCEEDED",
          { status: response.status },
        );
      }
      throw new LlmError(`${this.product.id}: ${errorDetail(errorText)}`, httpErrorCode(response.status, errorText), { status: response.status });
    }
    yield* this.consumeSse(response, options, currentAccountId);
  }
  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  async send(credential, body, options) {
    const headers = new Headers(attributionHeaders());
    headers.set("Authorization", `Bearer ${credential.access_token}`);
    headers.set("Accept", "text/event-stream");
    headers.set("Content-Type", "application/json");
    headers.set(HTTP_HEADER_DOMAIN, this.product.apiDomain || credential.domain || "");
    headers.set(HTTP_HEADER_PRODUCT_CODE, this.product.productCode);
    headers.set("X-Agent-Purpose", "conversation");
    headers.set("X-IDE-Name", this.product.attributionName);
    headers.set("X-IDE-Type", this.product.attributionName);
    headers.set("X-IDE-Version", this.product.clientVersion);
    headers.set(HTTP_HEADER_PRODUCT, this.product.attributionName);
    headers.set("User-Agent", resolveUserAgent(this.product, options.model));
    if (this.product.id === "workbuddy") {
      headers.set("X-Conversation-ID", this.sessionId);
      headers.set("X-Conversation-Message-ID", crypto.randomUUID());
      headers.set("X-Conversation-Request-ID", crypto.randomUUID());
    }
    try {
      return await this.fetchImpl(`${this.product.endpoint}/v2/chat/completions`, {
        method: "POST",
        headers,
        body,
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (isTransportError(error)) {
        throw new LlmError(`${this.product.id}: transport error: ${errorMessage(error)}`, "TRANSPORT", { cause: error });
      }
      throw error;
    }
  }
  /**
   * 消费 SSE 响应并产出 StreamChunk。
   *
   * CodeBuddy 返回标准 OpenAI SSE：`delta.content` 为正文、
   * `delta.reasoning_content` 为思考、`delta.tool_calls` 为工具调用。
   * 流式工具调用仅首个分片携带真实 id（chatcmpl-tool-xxx），后续参数分片
   * 只有 index——按 index 缓存 id 保证同一工具的所有分片 id 一致。
   */
  async *consumeSse(response, options, policyBlockedAccountId) {
    if (!response.body) throw new LlmError(`${this.product.id}: empty model response body`, "EMPTY_RESPONSE");
    const blocks = [];
    let nextIndex = 0;
    const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : void 0;
    let loopDetected = false;
    const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : void 0;
    let proseLoopDetected = false;
    const suppressor = createBlankReasoningSuppressor();
    const proseSuppressor = createBlankReasoningSuppressor();
    const toolCalls = /* @__PURE__ */ new Map();
    const toolOrder = [];
    const toolIds = /* @__PURE__ */ new Map();
    let buffer = "";
    let streamEnded = false;
    let finishReason;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let firstTokenReceived = false;
    try {
      for (; ; ) {
        if (streamEnded) break;
        let result;
        try {
          const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs();
          const phase = firstTokenReceived ? "chunk" : "first-token";
          result = await readWithIdleTimeout(reader, timeoutMs, "buddy", options.signal, phase);
          if (!result.done) firstTokenReceived = true;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (error instanceof LlmError) throw error;
          if (isTransportError(error)) {
            throw new LlmError(`${this.product.id}: sse transport error: ${errorMessage(error)}`, "TRANSPORT", { cause: error });
          }
          throw error;
        }
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            streamEnded = true;
            break;
          }
          let data;
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          if (data.choices === void 0 && (data.code === 11128 || data.code === "11128")) {
            throw new LlmError(
              `${this.product.id}: code=11128 ${errorDetail(payload)}`,
              "INVALID_REQUEST",
              { status: response.status }
            );
          }
          if (data.choices === void 0 && isContentRejection(payload)) {
            await markPolicyBlockedAccount(
              this.options.accountPool,
              this.product.id,
              policyBlockedAccountId,
              options.model
            );
            throw contentRejectionError(this.product.id, 200, payload, false);
          }
          if (data.error !== void 0) {
            throw new LlmError(`${this.product.id}: ${data.error.message ?? "unknown error"}`, "SERVER");
          }
          const choice = data.choices?.[0];
          const delta = choice?.delta;
          if (typeof choice?.finish_reason === "string") {
            finishReason = choice.finish_reason;
          }
          const textDelta = delta?.content ? proseSuppressor.feed(delta.content) : void 0;
          if (textDelta !== void 0) {
            let block = blocks.find((candidate) => candidate.kind === "text");
            if (block === void 0) {
              block = { index: nextIndex++, kind: "text", text: "" };
              blocks.push(block);
              yield { type: "block-start", index: block.index, blockType: "text" };
            }
            if (proseLoopGuard !== void 0) {
              if (proseLoopGuard.observe(textDelta)) proseLoopDetected = true;
            }
            if (!proseLoopDetected) {
              block.text += textDelta;
              yield { type: "text-delta", index: block.index, text: textDelta };
            }
          }
          if (delta?.reasoning_content) {
            if (loopGuard !== void 0) {
              if (loopGuard.observe(delta.reasoning_content)) loopDetected = true;
            }
            if (!loopDetected) {
              const emit = suppressor.feed(delta.reasoning_content);
              if (emit !== void 0) {
                let block = blocks.find((candidate) => candidate.kind === "reasoning");
                if (block === void 0) {
                  block = { index: nextIndex++, kind: "reasoning", text: "" };
                  blocks.push(block);
                  yield { type: "block-start", index: block.index, blockType: "reasoning" };
                }
                block.text = suppressor.text();
                yield { type: "reasoning-delta", index: block.index, text: emit };
              }
            }
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0;
            if (typeof call.id === "string" && call.id.length > 0) {
              toolIds.set(wireIndex, call.id);
            }
            const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`;
            let block = toolCalls.get(wireIndex);
            if (block === void 0) {
              block = { index: nextIndex++, text: "", callId, announced: false };
              toolCalls.set(wireIndex, block);
            }
            block.callId = callId;
            if (typeof call.function?.name === "string" && call.function.name.length > 0) {
              block.name = call.function.name;
            }
            const fragment = call.function?.arguments ?? "";
            block.text += fragment;
            if (!block.announced) {
              if (!hasUsableToolName(block.name)) continue;
              block.announced = true;
              toolOrder.push(block.index);
              yield { type: "block-start", index: block.index, blockType: "tool-call" };
              yield {
                type: "tool-call-delta",
                index: block.index,
                id: ToolCallId(callId),
                name: block.name,
                argumentsDelta: block.text
              };
              continue;
            }
            yield {
              type: "tool-call-delta",
              index: block.index,
              id: ToolCallId(callId),
              ...block.name !== void 0 ? { name: block.name } : {},
              argumentsDelta: fragment
            };
          }
          if (data.usage) {
            const promptTokens = data.usage.prompt_tokens ?? 0;
            const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens ?? data.usage.prompt_cache_hit_tokens ?? 0;
            const cacheWriteTokens = data.usage.prompt_tokens_details?.cache_write_tokens;
            const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens;
            yield {
              type: "usage",
              usage: {
                // 与 codearts 一致：inputTokens 只计**未命中缓存**的部分，
                // 命中部分单列 cacheReadTokens，否则缓存命中率显示会偏大。
                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
                ...cacheWriteTokens !== void 0 && cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
                ...reasoningTokens !== void 0 && reasoningTokens > 0 ? { reasoningTokens } : {}
              }
            };
          }
        }
        if (loopDetected) {
          await reader.cancel().catch(() => {
          });
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    let blockCount = 0;
    let emittedProse = "";
    const textBlock = blocks.find((block) => block.kind === "text");
    for (const index of toolOrder) {
      const block = [...toolCalls.values()].find((candidate) => candidate.index === index);
      if (!hasUsableToolName(block.name)) continue;
      blockCount += 1;
      yield {
        type: "block-end",
        index,
        block: {
          type: "tool-call",
          id: ToolCallId(block.callId ?? ""),
          name: block.name,
          // 仅把"无参数工具下发的空分片"补成 {}；**残缺参数保持原样**，
          // 由 max-tokens 判定触发重试。切勿把残缺 JSON 也补成 {}——那会
          // 伪造出合法外观，让 harness 报 `missing required property` 而
          // 非重试，掩盖真正的分片丢失。
          arguments: isTruncatedArguments(block.text) ? block.text : normalizeToolArguments(block.text)
        }
      };
    }
    if (textBlock !== void 0) {
      let textOut = textBlock.text;
      {
        const split = splitThinkTaggedContent(textBlock.text);
        if (split !== void 0) {
          if (split.reasoning !== "") {
            const existing = blocks.find((candidate) => candidate.kind === "reasoning");
            if (existing === void 0) {
              blocks.push({ index: nextIndex++, kind: "reasoning", text: split.reasoning });
            } else {
              existing.text += split.reasoning;
            }
            suppressor.feed(split.reasoning);
          }
          textOut = split.text;
        }
      }
      textOut = stripBareThinkCloseTagIfEnabled(textOut);
      const truncated = proseLoopDetected && proseLoopGuard?.cutAt !== void 0 ? textOut.slice(0, proseLoopGuard.cutAt) : textOut;
      const cleaned = stripCourseLeakIfEnabled(truncated);
      if (cleaned.trim() !== "") {
        blockCount += 1;
        emittedProse = cleaned;
        yield { type: "block-end", index: textBlock.index, block: { type: "text", text: cleaned } };
      } else {
        yield { type: "block-end", index: textBlock.index, block: { type: "text", text: "" } };
      }
    }
    const reasoningBlock = blocks.find((block) => block.kind === "reasoning");
    if (reasoningBlock !== void 0 && reasoningBlock.text.trim() !== "") {
      const suppressedReasoning = suppressor.text();
      const reasoningText = loopDetected && loopGuard?.cutAt !== void 0 ? suppressedReasoning.slice(0, loopGuard.cutAt) : suppressedReasoning;
      const cleanedReasoning = stripCourseLeakIfEnabled(reasoningText);
      if (cleanedReasoning !== "") {
        blockCount += 1;
        yield { type: "block-end", index: reasoningBlock.index, block: { type: "reasoning", text: cleanedReasoning } };
      }
    }
    const argsTruncated = [...toolCalls.values()].some((block) => isTruncatedArguments(block.text));
    const droppedUnnamedCalls = [...toolCalls.values()].some((block) => !block.announced);
    const proseCutByStopString = finishReason === "stop" && toolOrder.length === 0 && isProseTruncatedByStopString(emittedProse);
    const reasoningLoopIsSoleOutput = loopDetected && emittedProse === "" && toolOrder.length === 0;
    const reason = reasoningLoopIsSoleOutput ? { kind: "error", failure: reasoningLoopFailure(
      loopGuard?.diagnostics,
      options.maxTokens,
      "reasoning"
    ) } : loopDetected ? { kind: "max-tokens" } : finishReason === "length" || finishReason === void 0 && toolOrder.length > 0 || argsTruncated || proseCutByStopString || droppedUnnamedCalls && toolOrder.length === 0 ? { kind: "max-tokens" } : finishReason === "tool_calls" || toolOrder.length > 0 ? { kind: "tool-calls" } : { kind: "stop" };
    yield { type: "finish", reason: resolveEmptyResponseReason(reason, blockCount) };
  }
}
function isCredentialExpired(credential) {
  const expiresAt = credentialExpiresAtMs(credential);
  return expiresAt === void 0 ? false : Date.now() >= expiresAt;
}
function displayNameFor(model, all) {
  const suffix = displaySuffix(model, all);
  return suffix.length > 0 ? `${model.name} \xB7 ${suffix}` : model.name;
}
function displaySuffix(model, all) {
  const parts = [];
  const rate = formatCreditsRate(model.creditsRate, model.discountedCreditsRate);
  if (rate !== void 0) parts.push(rate);
  const variant = variantLabelFor(model, all);
  if (variant.length > 0) parts.push(variant);
  return parts.join(" ");
}
function variantLabelFor(model, all) {
  const group = all.filter((candidate) => candidate.name === model.name);
  if (group.length <= 1) return "";
  const prefix = commonPrefix(group.map((candidate) => candidate.id));
  const variant = model.id.slice(prefix.length).replace(/^-+/, "");
  return variant.toUpperCase();
}
function commonPrefix(values) {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix;
}
function positiveMaxTokens(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
function registerBuddyLlm(ctx, options) {
  const product = options.product ?? CODEBUDDY;
  const adapter = new BuddyAdapter(options);
  // ⚠️ warn 必须传：路由被占用时（OFM ≤2.5.7 仍持有该 provider）要让位并留日志，
  // 否则用户只看到「装了插件却没反应」，日志里一句线索都没有。
  registerAdapterIdempotent(ctx.llm, [product.id], adapter, (message) => ctx.logger?.warn?.(message));
  return adapter;
}
export {
  BuddyAdapter,
  CHAT_API_BASE,
  DEFAULT_MODEL,
  PROVIDER,
  policyBlockResetAtMs,
  registerBuddyLlm
};
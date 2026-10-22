/**
 * 腾讯系（buddy / workbuddy）的限流判据。
 *
 * ## 为什么这些判定要独立成模块
 *
 * 原文住在 OFM 的 `src/llm-adapter.ts`（CodeArts 适配器）里，而 buddy 适配器
 * 反向 import 它 —— 本插件只要 buddy，不该为四个函数把整个 CodeArts 适配器
 * （含华为签名、队列、SSE 全链路）拖进来。判据本身**一个字都没改**，
 * 逐条保留原注释里踩过的坑。
 *
 * ## 三条判据为什么必须分开
 *
 * | | 额度限流 `6004` | 模型饱和 `14003` |
 * |---|---|---|
 * | 语义 | 该**账号**在该模型上额度用完 | 该**模型**此刻整体饱和 |
 * | 换号 | **有效**（别的账号有独立额度） | **无益**（所有账号撞同一堵墙） |
 * | 写限流标记 | **必须**（否则每轮重撞） | **绝对不许**（会把整池锁 1 小时） |
 */

/**
 * CodeBuddy 系（buddy / workbuddy）表示「用量超出频率限制」的业务码。
 *
 * 判据优先用结构化业务码而非文案：**它与语言无关**，且不受服务端改文案影响。
 * 国际版与国内版用的是同一个码（实测均为 6004），只有 msg 文案分中英文。
 */
const RATE_LIMIT_BUSINESS_CODE = 6004

/**
 * 限流文案的**自然语言兜底**判据。
 *
 * 为什么需要兜底：并非所有限流错误都带得上结构化 code —— SSE 流内错误、
 * 网关返回的裸文本都只有文案可判。
 *
 * ⚠️ **中英文都必须列全**。历史缺陷（仅国际版暴露）：早期只有中文词
 * （频率限制 / 使用量已超出 / 频率超出 / 重置），而国际版返回的是英文
 * `usage exceeds frequency limit ... your usage will reset at <时间> UTC+8`。
 * 结果 `isRateLimited` 恒为 false → 适配器**跳过整个账号切换分支**，
 * 直接抛出原始 6004 JSON；错误码也因 HTTP 400 退化成 INVALID_REQUEST。
 */
const RATE_LIMIT_PATTERN =
  /频率限制|频率超出|使用量已超出|重置|rate.?limit|frequency limit|usage exceeds|too many requests/i

/**
 * 「**额度已用尽**」的业务码（HTTP 429）。
 *
 * 它与上面 6004「频率限制」是**两种不同的东西**，文案与处置都不同：
 *
 * | | 6004 频率限制 | 14018 额度用尽 |
 * |---|---|---|
 * | 含义 | 请求太密，等一会儿就好 | 这个账号在该模型上的额度**真的没了** |
 * | 重置时间 | 报文里有「将在 … 重置」 | **没有**，报文只给一个加量包购买链接 |
 * | 处置 | 等解禁 / 换号 | 换号，或提升额度；等是等不出来的 |
 *
 * ⚠️ **必须与 6004 分开报**（2026-10-21 实测）：上游原话是
 * `{"code":14018,"msg":"额度已用尽，请访问以下链接，购买加量包…"}`。
 * 早先两者共用一个判据，于是「额度用尽」被写成「所有账号均在限流中，
 * 最近一个将于 X 解禁」——**完全误导**：那个时刻是本地兜底算出来的 +1 小时，
 * 上游根本没承诺过；用户会等满一小时，然后照旧失败，且不知道要买额度。
 */
export const QUOTA_EXHAUSTED_BUSINESS_CODE = 14018

/**
 * 文案兜底：额度用尽。同样必须窄 —— 只认上游原话里的「额度已用尽」，
 * 不认泛词 `quota`（它也会出现在 6004 的英文文案里）。
 */
const QUOTA_EXHAUSTED_PATTERN = /额度已用尽|购买加量包|quota\s+(?:has\s+been\s+)?exhausted/i

/**
 * 是否属于「额度已用尽」。
 *
 * @param {number | undefined} status
 * @param {string} body
 */
export function isQuotaExhaustedError(status, body) {
  if (typeof status === 'number' && status < 400) return false
  if (body.length === 0) return false
  try {
    const code = JSON.parse(body).error?.data?.code ?? JSON.parse(body).code
    if (code === QUOTA_EXHAUSTED_BUSINESS_CODE || code === String(QUOTA_EXHAUSTED_BUSINESS_CODE)) return true
  } catch {
    // 非 JSON：交给文案兜底。
  }
  return QUOTA_EXHAUSTED_PATTERN.test(body)
}

/**
 * 腾讯网关「**模型饱和**」业务码（HTTP 429）。
 *
 * 实测报文（2026-10-05，`scripts/probe-buddy-error-catalog.mjs`）：
 * ```json
 * {"code":14003,"msg":"too many requests",
 *  "displayMsg":{"zh":"模型繁忙，请换模型或稍后重试"},
 *  "actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","RETRY"]}
 * ```
 *
 * ⚠️ 它自己就说明了「这不是账号问题」（`actions` 里没有换号选项）。
 * 但 `isRateLimited` 对 **429 无条件返回 true** ⇒ 适配器会给每个账号都写上
 * 「1 小时限流」⇒ 4 个独立账号 20 秒内全部被锁 ⇒ 用户等 1 小时也不能用。
 */
export const MODEL_SATURATION_BUSINESS_CODE = 14003

/**
 * 「模型饱和」的自然语言兜底判据。
 *
 * ⚠️ **关键词必须窄**：`busy` / `saturated` 这种泛词若不加限定，模型正文里
 * 恰好讨论「服务器繁忙」就会被误判。这里只认原话里的组合，且判据本身
 * **要求 HTTP 状态码 ≥ 400**（见 {@link isModelSaturationError}）。
 */
const MODEL_SATURATION_PATTERN = /模型繁忙|请求量饱和|model\s+busy|currently\s+saturated/i

/**
 * 判断一次失败是否为**模型饱和**（上游背压），而非账号级额度限流。
 *
 * ⚠️ **必须先于 `status === 429` 的无条件判定**：14003 恰恰是 429，
 * 若先判状态码就永远走不到这里。
 *
 * @param {number | undefined} status
 * @param {string} body
 */
export function isModelSaturationError(status, body) {
  // 状态码已知且 < 400 ⇒ 这是正常响应，正文里的字样不算错误。
  if (typeof status === 'number' && status < 400) return false
  if (body.length === 0) return false
  try {
    const code = JSON.parse(body).code
    if (code === MODEL_SATURATION_BUSINESS_CODE
      || code === String(MODEL_SATURATION_BUSINESS_CODE)) return true
  } catch {
    // 非 JSON：交给文案兜底。
  }
  return MODEL_SATURATION_PATTERN.test(body)
}

/**
 * 结构化判定：响应体是可解析 JSON 且 `code` 为该业务码。
 *
 * 不采用「全文包含 6004」的写法：`requestId` 是 UUID，任意数字子串都可能
 * 偶然出现，文本匹配会产生假阳性。
 */
function hasRateLimitBusinessCode(body) {
  try {
    const code = JSON.parse(body).code
    return code === RATE_LIMIT_BUSINESS_CODE || code === String(RATE_LIMIT_BUSINESS_CODE)
  } catch {
    return false
  }
}

/**
 * 判断错误文本是否为频率限制错误。
 *
 * @param {string} body 响应体（可能为空串）
 * @param {number} [status] **手里有 Response 就必须传**：为 429 时无条件判为限流，
 *   即使响应体为空、不含任何可识别文案（CDN / 网关的空体 429 是真实存在的）。
 *
 * ⚠️ 反向约束同样重要：**非 429 绝不能因为「有状态码」就判为限流** ——
 * 404「模型不存在」这类换号无益的错误若被识别成限流，会被吞成
 * 「所有账号均受限」，用户既看不到真实原因、插件还会白试一遍全池账号。
 */
export function isRateLimited(body, status) {
  if (status === 429) return true
  return hasRateLimitBusinessCode(body) || RATE_LIMIT_PATTERN.test(body)
}

/**
 * 重置时间的两种句式（中文 / 英文），并**捕获实际时区**而非硬编码 UTC+8。
 *
 * 中文（buddy 国内版）："您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置"
 * 英文（workbuddy 国际版）："... your usage will reset at 2026-09-17 09:09:36 UTC+8, ..."
 */
const RESET_TIME_PATTERN = /(?:将在|reset at)\s+([\d-]+\s+[\d:]+)\s+(UTC[+-]\d+(?::\d+)?)/i

/**
 * 限流文案里解析不出重置时刻时的**兜底时长**（1 小时）。
 *
 * 为什么需要兜底而不是「解析不到就不记标记」：网关 / CDN 返回的 429 常常既没有
 * 重置时间、甚至**没有响应体**，而标记是 UI「限额重置」徽章与「重测 / 重置」
 * 两条人工解禁路径的**唯一**依据。
 */
export const RATE_LIMIT_FALLBACK_MS = 3_600_000

/**
 * 从限流错误中提取重置时间；体里没有时间时返回 {@link RATE_LIMIT_FALLBACK_MS} 兜底。
 *
 * @param {string} body
 * @param {string} currentModel
 * @param {number} [status]
 * @returns {{ modelId: string, resetTimeMs: number } | null}
 */
export function parseRateLimitError(body, currentModel, status) {
  const fallback = () => ({
    modelId: currentModel,
    resetTimeMs: Date.now() + RATE_LIMIT_FALLBACK_MS,
  })
  try {
    const data = JSON.parse(body)
    const msg = typeof data.msg === 'string' ? data.msg : ''
    const resetMatch = RESET_TIME_PATTERN.exec(msg)
    if (resetMatch) {
      const resetMs = Date.parse(`${resetMatch[1]} ${resetMatch[2]}`)
      if (!Number.isNaN(resetMs)) return { modelId: currentModel, resetTimeMs: resetMs }
    }
    if (isRateLimited(body, status)) return fallback()
    return null
  } catch {
    // 非 JSON（空体、纯文本、CDN 的 HTML 错误页）：只剩状态码可判。
    return status === 429 ? fallback() : null
  }
}
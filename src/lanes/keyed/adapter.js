/**
 * 通用 OpenAI 兼容适配器工厂：一条声明式车道 → 一个 DSH provider。
 *
 * ## 为什么是工厂而不是一堆类
 *
 * 20 条渠道的差异**全在数据里**（baseURL / 模型表 / 能力声明），HTTP 面完全一样：
 * `POST {baseURL}/chat/completions`（SSE）+ `GET {baseURL}/models`。所以这里只有
 * 一个类 + 一个工厂，加一条渠道 = 往 `catalog.js` 加一段数据，不动代码。
 *
 * ## 与 `OpenCodeAdapter` 同形的地方（照它写，别自创字段）
 *
 * - 类继承 `LlmAdapter`，override 的成员与它一致：
 *   `providerInfo` / `listModels` / `resolveModel` / `prepareCall` / `stream`
 *   （`providerRetryPolicy` / `imageRequestPricing` / `imageRequestTarget` 由基类与本类补全）；
 * - `listModels` 行是 `{ provider, id, name, inputModalities }`（**就是这四个**，
 *   上下文窗口走 `resolveModel` 的 `context.contextWindow`，不塞进目录行）；
 * - `inputModalities` 由能力声明派生：`vision:true → ['text','image']`，否则 `['text']`；
 * - chunk 形状：`block-start` → `text-delta`/`reasoning-delta`/`tool-call-delta` →
 *   `block-end` →（`usage`）→ `finish`。字段名与 `assistant-stream` 的
 *   `StreamChunk` 声明逐字对齐（已核对宿主 `dsh-llm/lib/typert.host.js`）。
 *
 * ## 能力声明：`vision` 有字段，`tools` 没有
 *
 * ⚠️ 宿主这一版（0.2.x）的 `LlmModelInfo` **只有** `inputModalities`，**没有**
 * 「支持工具调用」这个字段（已核对声明：`{provider,id,name,description?,inputModalities?}`）。
 * 所以：
 * - `vision` → 走 `inputModalities`（宿主据此把图片投影成占位符）；
 * - `tools` → **不发**任何字段，而是在**请求侧**执行：模型声明 `tools:false` 时
 *   不发 `tools[]`，并把历史里的工具结果折成文本（否则严格的上游会 400）。
 *   另外 `resolveModel` **不**声明 `toolUpdate`：那个字段的语义是「工具声明随
 *   developer 消息进历史」（`'in-history' | 'addition-only'`），对无状态的
 *   OpenAI 端点只会让请求体多出一堆 developer 消息 —— 留空即拿到宿主默认行为
 *   （每轮把完整 `tools` 交给我们）。自造一个 `supportsTools` 字段则会被宿主忽略，
 *   等于给用户一个假的「支持工具」标记。
 *
 * ## 错误分类：**必须区分得开**
 *
 * 免费车道的失败几乎全是「这次为什么不能用」，而且四类的处置**完全相反**：
 * 凭据错（改 key）、额度用尽（换车道）、限流（等）、连不上（查网络）。
 * `classifyUpstreamFailure` 把 HTTP 状态**加上响应体措辞**判成一个 `kind`，
 * 并给出 `retryable` 与一句可执行的 `advice`。判据里有两处刻意的先后顺序：
 * 1. **429 但正文说余额/额度** → 判 `quota`（重试永不恢复），不判 `rate-limit`；
 * 2. **402 一律 quota**（Pollinations 用 402 表示「30 秒后再来」，所以 402 的
 *    处置文案要读 `Retry-After`，见 `advice`）。
 *
 * @module src/lanes/keyed/adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { lanePlaceholders, staticModels } from './catalog.js'

/** 上游不给上下文窗口时的兜底（与 `opencode/adapter.js` 同一取法：0 是「未知」）。 */
export const FALLBACK_CONTEXT_WINDOW = 200_000
/** 上游不给输出上限时的兜底。 */
export const FALLBACK_MAX_OUTPUT = 32_000
/** 单次请求默认超时：免费层排队时上游会挂很久，没有 deadline 会永远转圈。 */
export const DEFAULT_TIMEOUT_MS = 180_000
/** 实时目录的缓存时长（同一轮里 listModels 会被选择器/状态页/探测并发送）。 */
const CATALOG_TTL_MS = 5 * 60 * 1000
/** 目录拉取失败后的冷却：10 秒，挡住并发重试，又不至于让用户改了配置还要等。 */
const CATALOG_FAILURE_TTL_MS = 10_000
/** 单张图片的请求体预算（OpenAI 兼容端点普遍按 base64 体积计费与限制）。 */
const REQUEST_IMAGE_MAX_BYTES = 2 * 1024 * 1024
/** 图片像素预算（≈1,037 视觉 token），与 buddy 车道的默认值一致。 */
const DEFAULT_IMAGE_PIXEL_BUDGET = 640_000
/** 单次请求最多内联的图片张数：再多就不是「看图」而是把整段会话喂进去。 */
const MAX_REQUEST_IMAGES = 8
/** `Retry-After` 的可用区间：太短没意义，太长不如让用户自己决定换车道。 */
const MIN_RETRY_AFTER_MS = 500
const MAX_RETRY_AFTER_MS = 600_000
/** 一次 SSE 里允许的坏帧数上限：超过说明对面根本不是 SSE（可能是 HTML 错误页）。 */
const MAX_BAD_FRAMES = 5

/** 失败类别（页面按这个渲染「为什么不能用」，**不要**按 HTTP 状态码渲染）。 */
export const FAILURE_KINDS = Object.freeze({
  CREDENTIAL: 'credential',
  QUOTA: 'quota',
  RATE_LIMIT: 'rate-limit',
  CONNECTION: 'connection',
  UNKNOWN_MODEL: 'unknown-model',
  CONTEXT: 'context',
  INVALID_REQUEST: 'invalid-request',
  SERVER: 'server',
  UPSTREAM: 'upstream',
  ABORTED: 'aborted',
})

/** 正文里出现这些词，说明 429/403 其实是**额度**问题而不是限流。 */
const QUOTA_WORDING = /insufficient|quota|balance|credit|arrears|payment|billing|余额|额度|欠费|充值|配额/i
/** 正文里出现这些词，说明是上下文窗口超限（要换模型而不是重试）。 */
const CONTEXT_WORDING = /context[\s_-]?(?:length|window)|maximum context|too (?:long|large)|超出.{0,6}(?:长度|窗口)|token limit/i
/** 正文里出现这些词，说明是模型 id 的问题（"The model `x/y` does not exist" 这类，
 *  名字与措辞之间隔着模型 id，所以不能只允许几个非字母字符）。 */
const MODEL_WORDING = /(?:model|模型)[\s\S]{0,80}?(?:not found|does not exist|doesn't exist|unknown|invalid|deprecated|decommission|不存在|不可用|已下线)|(?:not found|does not exist)[\s\S]{0,40}?(?:model|模型)/i
/** 正文里出现这些词，说明是限流（**流内错误帧**没有状态码，只能靠措辞）。 */
const RATE_WORDING = /rate[\s_-]?limit|too many requests|requests? per|限流|请求过于频繁|请求太快/i

/**
 * 解析 `Retry-After` / `x-ratelimit-reset-*` 的取值。
 *
 * 三种真实形态都要认：秒数（`30`）、HTTP-date（`Wed, 21 Oct 2026 07:28:00 GMT`）、
 * 以及 OpenAI 风格的时长串（`1s` / `120ms` / `2m`）。判不出来返回 `undefined` ——
 * `LlmError` 对 `providerRetryAfterMs` 的要求是**正的有限数**，为了塞一个值
 * 而瞎猜会让错误构造本身抛错（比没有这个字段更糟）。
 *
 * @param {unknown} value 头部原值
 * @param {number} [nowMs] 当前时间（HTTP-date 解析用）
 * @returns {number|undefined} 毫秒，已夹到 [500, 600000]
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text === '') return undefined
  const clamp = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return undefined
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(ms)))
  }
  // 纯秒数
  if (/^\d+(?:\.\d+)?$/.test(text)) return clamp(Number(text) * 1000)
  // 时长串：1s / 120ms / 2m / 1h
  const duration = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(text)
  if (duration !== null) {
    const amount = Number(duration[1])
    const unit = duration[2]
    const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000
    return clamp(amount * factor)
  }
  // HTTP-date
  const parsed = Date.parse(text)
  if (Number.isFinite(parsed)) return clamp(parsed - nowMs)
  return undefined
}

/** 从响应头里取一个值（Headers 对象或普通对象都能吃）。 */
function headerValue(headers, name) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const got = headers.get(name)
    return got === null ? undefined : got
  }
  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()]
  return direct === undefined ? undefined : String(direct)
}

/**
 * 取一个"人能读"的值（字符串直接用；数字形的 code 也要带出来 —— 硅基流动的
 * `30014`、智谱的 `1001` 在各自文档里就是鉴权码，丢了它们就只剩一句无信息量的英文）。
 */
function readableValue(value) {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * 把错误响应体压成一句人能读的原因。
 *
 * ⚠️ **不做语义判断，只做提取**：分类在 {@link classifyUpstreamFailure} 里。
 * 各家形状实测：OpenAI `{error:{message,type,code}}`、智谱 `{error:{code,message}}`、
 * 硅基流动 `{code,data,message}`、Cloudflare `{detail}`、火山 `{error:{code,message,type}}`。
 */
export function pickFailureDetail(body) {
  if (body === undefined || body === null) return ''
  const text = typeof body === 'string' ? body : String(body)
  if (text === '') return ''
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return text.slice(0, 300)
  }
  if (parsed === null || typeof parsed !== 'object') return String(parsed).slice(0, 300)
  const inner = parsed.error !== null && typeof parsed.error === 'object' ? parsed.error : undefined
  const parts = [
    readableValue(inner?.message),
    readableValue(inner?.code),
    readableValue(inner?.type),
    readableValue(typeof parsed.error === 'string' ? parsed.error : undefined),
    readableValue(parsed.message),
    readableValue(parsed.detail),
    readableValue(parsed.code),
    readableValue(parsed.msg),
  ]
  const joined = parts
    .filter((part) => part !== undefined)
    .join(' / ')
  return (joined === '' ? text : joined).slice(0, 300)
}

/**
 * 判一次失败属于哪一类。
 *
 * @param {{
 *   status?: number,
 *   body?: unknown,
 *   headers?: unknown,
 *   error?: unknown,
 *   lane?: object,
 *   timedOut?: boolean,
 *   userAborted?: boolean,
 *   nowMs?: number,
 * }} input
 * @returns {{ kind:string, code:string, retryable:boolean, status:number|undefined,
 *   retryAfterMs:number|undefined, advice:string, detail:string }}
 */
export function classifyUpstreamFailure(input = {}) {
  const status = Number.isFinite(Number(input.status)) ? Number(input.status) : undefined
  // 传输层失败没有响应体，原因就藏在 error 里 —— 也要抽出来，否则页面只剩
  // 一句"失败了"，而 `detail` 是「上游原话」那一栏的内容。
  const detail = pickFailureDetail(input.body)
    || (input.error instanceof Error ? input.error.message : input.error === undefined ? '' : String(input.error))
  const retryAfterMs = parseRetryAfter(
    input.retryAfter ?? headerValue(input.headers, 'retry-after'),
    input.nowMs ?? Date.now(),
  )
  const laneLabel = typeof input.lane?.displayName === 'string' && input.lane.displayName !== ''
    ? input.lane.displayName
    : String(input.lane?.id ?? '这条车道')
  const signup = typeof input.lane?.signupURL === 'string' ? input.lane.signupURL : '[SIGNUP_URL]'
  const env = typeof input.lane?.apiKeyEnv === 'string' && input.lane.apiKeyEnv !== '' ? input.lane.apiKeyEnv : '[API_KEY_ENV]'
  const baseURL = typeof input.lane?.baseURL === 'string' ? input.lane.baseURL : '[BASE_URL]'
  const tail = detail === '' ? '' : ' 上游原话：' + detail

  const make = (kind, code, retryable, advice) => ({
    kind,
    code,
    retryable,
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    advice,
    detail,
  })

  const quotaWording = QUOTA_WORDING.test(detail)
  const contextWording = CONTEXT_WORDING.test(detail)
  const modelWording = MODEL_WORDING.test(detail)

  // ① 没有状态码：要么是传输层失败（超时/不可达），要么是**流内错误帧**
  //    （OpenAI 兼容端点在 SSE 里报错很常见，那种没有 HTTP 状态）。两者要分开，
  //    否则一条「限流」会被报成「连不上」。
  if (status === undefined) {
    const error = input.error
    const hasTransportError = input.timedOut === true || input.userAborted === true || error !== undefined
    if (input.userAborted === true) {
      return make(FAILURE_KINDS.ABORTED, 'ABORTED', false, `${laneLabel}：本次请求被取消。`)
    }
    if (hasTransportError) {
      const name = typeof error === 'object' && error !== null ? String(error.name ?? '') : ''
      const message = error instanceof Error ? error.message : error === undefined ? '' : String(error)
      const code = typeof error === 'object' && error !== null ? String(error.code ?? '') : ''
      if (input.timedOut === true || name === 'AbortError' || code === 'ABORT_ERR' || /timed?\s*out|超时/i.test(message)) {
        return make(
          FAILURE_KINDS.CONNECTION,
          'TIMEOUT',
          true,
          `${laneLabel}：请求超时（${DEFAULT_TIMEOUT_MS}ms 内没等到上游）。免费层排队时上游会很慢，稍后重试；若每次都卡在同一时长，多半是网络到 ${baseURL} 不通。${tail}`,
        )
      }
      return make(
        FAILURE_KINDS.CONNECTION,
        'TRANSPORT',
        true,
        `${laneLabel}：连不上 ${baseURL}。国内直连渠道一般不需要代理；全球渠道在这台机器上可能需要。${tail}`,
      )
    }
    if (quotaWording) {
      return make(
        FAILURE_KINDS.QUOTA,
        'QUOTA',
        false,
        `${laneLabel}：上游在流里报了额度/余额问题 —— 按**额度**处置（等不会恢复），换车道或去 ${signup}。${tail}`,
      )
    }
    if (modelWording) {
      return make(
        FAILURE_KINDS.UNKNOWN_MODEL,
        'MODEL_NOT_FOUND',
        false,
        `${laneLabel}：上游说这个模型不可用（流内错误帧）。点「刷新目录」换一个模型。${tail}`,
      )
    }
    if (contextWording) {
      return make(
        FAILURE_KINDS.CONTEXT,
        'CONTEXT_WINDOW_EXCEEDED',
        false,
        `${laneLabel}：请求超出该模型的上下文窗口（流内错误帧）。换更大窗口的模型，或先压缩会话。${tail}`,
      )
    }
    if (RATE_WORDING.test(detail)) {
      return make(
        FAILURE_KINDS.RATE_LIMIT,
        'RATE_LIMIT',
        true,
        `${laneLabel}：上游在流里报了限流。等一两分钟再试，或换模型。${tail}`,
      )
    }
    return make(
      FAILURE_KINDS.UPSTREAM,
      'UPSTREAM_ERROR',
      false,
      `${laneLabel}：上游在流里报了错（没有 HTTP 状态码）。${tail}`,
    )
  }

  // ② 402：额度/余额。**注意 Pollinations 也用 402 表示「按 IP 限速，等一下」**，
  //    所以有 Retry-After 时按限流处置（等得了），没有时按额度用尽处置。
  if (status === 402) {
    if (retryAfterMs !== undefined) {
      return make(
        FAILURE_KINDS.RATE_LIMIT,
        'RATE_LIMIT',
        true,
        `${laneLabel}：上游要求等 ${Math.ceil(retryAfterMs / 1000)} 秒再来（HTTP 402 带 Retry-After，Pollinations 这类按 IP 串行限速的渠道就是这样）。${tail}`,
      )
    }
    return make(
      FAILURE_KINDS.QUOTA,
      'QUOTA',
      false,
      `${laneLabel}：额度或余额用尽（HTTP 402）。等待通常不恢复 —— 免费层按天或按总量重置。换一条车道，或去 ${signup} 看额度。${tail}`,
    )
  }

  // ③ 401/403：凭据。⚠️ 403 也可能是「额度/权限」措辞，那时按额度报（处置不同）。
  if (status === 401 || status === 403) {
    if (quotaWording) {
      return make(
        FAILURE_KINDS.QUOTA,
        'QUOTA',
        false,
        `${laneLabel}：这次 403 的正文说的是额度/余额（不是 key 错）：换车道或去 ${signup} 充值。${tail}`,
      )
    }
    return make(
      FAILURE_KINDS.CREDENTIAL,
      'INVALID_CREDENTIAL',
      false,
      `${laneLabel}：凭据被拒（HTTP ${status}）：key 写错/已撤销，或这把 key 没开通该模型。去 ${signup} 确认，然后更新凭据 ${env}。${tail}`,
    )
  }

  // ④ 429：先排除「其实说的是额度」——两者处置相反（等 vs 换）。
  if (status === 429) {
    if (quotaWording) {
      return make(
        FAILURE_KINDS.QUOTA,
        'QUOTA',
        false,
        `${laneLabel}：上游用 429 回的，但正文说的是额度/余额用尽 —— 按**额度**处置，等不会恢复，换车道或去 ${signup}。${tail}`,
      )
    }
    return make(
      FAILURE_KINDS.RATE_LIMIT,
      'RATE_LIMIT',
      true,
      retryAfterMs === undefined
        ? `${laneLabel}：上游限流（HTTP 429）。等一两分钟再试，或换模型 —— 这是限流，不是额度用尽。${tail}`
        : `${laneLabel}：上游限流（HTTP 429），建议等 ${Math.ceil(retryAfterMs / 1000)} 秒。${tail}`,
    )
  }

  // ⑤ 404：模型 id 与 baseURL 都可能。分开报，否则用户会去改错的那一个。
  if (status === 404) {
    if (modelWording) {
      return make(
        FAILURE_KINDS.UNKNOWN_MODEL,
        'MODEL_NOT_FOUND',
        false,
        `${laneLabel}：上游没有这个模型（404）。点「刷新目录」重拉一次；刷新后仍在就换一个模型 —— 静态表里的 id 过时了。${tail}`,
      )
    }
    return make(
      FAILURE_KINDS.UNKNOWN_MODEL,
      'MODEL_NOT_FOUND',
      false,
      `${laneLabel}：404，且正文没点名模型 —— 也可能是 baseURL/路由不对（本车道的 baseURL 是实测过的，优先怀疑模型 id，其次怀疑服务端换了路径）。${tail}`,
    )
  }

  // ⑥ 400：上下文窗口超限是「换模型」，其他 400 是「参数不被接受」。
  if (status === 400) {
    if (contextWording) {
      return make(
        FAILURE_KINDS.CONTEXT,
        'CONTEXT_WINDOW_EXCEEDED',
        false,
        `${laneLabel}：请求超出该模型的上下文窗口。换更大窗口的模型，或先压缩会话。${tail}`,
      )
    }
    return make(
      FAILURE_KINDS.INVALID_REQUEST,
      'INVALID_REQUEST',
      false,
      `${laneLabel}：上游拒绝了请求体（HTTP 400）—— 常见是它不认 tools / stream_options / system 里某一项。${tail}`,
    )
  }

  if (status === 408 || status === 504) {
    return make(
      FAILURE_KINDS.CONNECTION,
      'TIMEOUT',
      true,
      `${laneLabel}：上游超时（HTTP ${status}）。稍后重试或换模型。${tail}`,
    )
  }
  if (status >= 500) {
    return make(
      FAILURE_KINDS.SERVER,
      'SERVER',
      true,
      `${laneLabel}：上游 ${status}。换个时间重试，或换模型 —— 这不是你的配置问题。${tail}`,
    )
  }
  if (status === 409 || status === 413 || status === 422 || status === 423 || status === 424) {
    return make(
      FAILURE_KINDS.INVALID_REQUEST,
      'INVALID_REQUEST',
      false,
      `${laneLabel}：上游拒绝了这次请求（HTTP ${status}，多半是请求体太大或字段非法）。${tail}`,
    )
  }
  return make(
    FAILURE_KINDS.UPSTREAM,
    'UPSTREAM_ERROR',
    false,
    `${laneLabel}：上游错误（HTTP ${status}）。${tail}`,
  )
}

/** 分类结果 → `LlmError`（`failure` 里带上 status 与 retryAfter，宿主的调度/页面能直接用）。 */
export function failureToError(lane, classified) {
  const label = typeof lane?.id === 'string' && lane.id !== '' ? lane.id : 'keyed'
  return new LlmError(
    `${label}: ${classified.advice}`,
    classified.code,
    {
      ...(classified.status === undefined ? {} : { status: classified.status }),
      ...(classified.retryAfterMs === undefined ? {} : { providerRetryAfterMs: classified.retryAfterMs }),
    },
  )
}

/**
 * 把「单值 / 数组 / 逗号换行分隔的串」统一成 key 列表（去重、去空、上限 5）。
 *
 * 上限 5 与 `ready.js` 的 `resolveApiKeys` 同数：两处不一致会让「页面说有 5 把、
 * 适配器只认 3 把」这种偏差出现，而它只在轮换到第 4 把时才暴露。
 */
export function normalizeKeyList(apiKeys, apiKey) {
  const MAX_KEYS = 5
  const out = []
  const push = (value) => {
    if (typeof value !== 'string') return
    for (const part of value.split(/[\n,;]+/)) {
      const key = part.trim()
      if (key === '' || out.includes(key) || out.length >= MAX_KEYS) continue
      out.push(key)
    }
  }
  if (Array.isArray(apiKeys)) for (const item of apiKeys) push(item)
  else push(apiKeys)
  push(apiKey)
  return out
}

/** 正值有限数才算数（0/undefined 一律当「未知」）。 */
function positive(value) {
  return Number.isFinite(value) && value > 0 ? Number(value) : undefined
}

/**
 * 图片的请求目标（像素与字节预算）。
 *
 * 与宿主 `LlmAdapter.imageRequestTarget` 的约定一致：返回 `{width,height,maxBytes}`。
 * 维度拿不到时返回 `0/0` —— 那是「不知道」，宿主据此跳过投影（别编一个 1024×1024，
 * 那会让所有大图被无理由缩小）。
 */
export function requestImageTargetFor(
  width,
  height,
  maxPixels = DEFAULT_IMAGE_PIXEL_BUDGET,
  maxBytes = REQUEST_IMAGE_MAX_BYTES,
) {
  const w = Number(width)
  const h = Number(height)
  if (!(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0)) {
    return { width: 0, height: 0, maxBytes }
  }
  if (w * h <= maxPixels) return { width: Math.floor(w), height: Math.floor(h), maxBytes }
  const scale = Math.sqrt(maxPixels / (w * h))
  return {
    width: Math.max(1, Math.floor(w * scale)),
    height: Math.max(1, Math.floor(h * scale)),
    maxBytes,
  }
}

/** 把任意 content 压成文本（OpenAI 端点只吃 string / image_url 数组）。 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') { parts.push(block.text); continue }
    if (block.type === 'reasoning' && typeof block.text === 'string') { parts.push(''); continue }
    if (block.type === 'tool-result') { parts.push(contentToText(block.content)); continue }
    if (block.type === 'tool-call') { parts.push(''); continue }
    if (block.type === 'image') { parts.push('[图片]'); continue }
  }
  return parts.join('')
}

/** 工具参数必须是 JSON 对象；空串按「无参数」= `{}`（上游对空串的容忍度不一致）。 */
export function normalizeToolArguments(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return '{}'
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}'
    return text
  } catch {
    return '{}'
  }
}

/** 工具名可用性（空名/全空白一律丢：宿主拿它去查工具表会直接失败）。 */
function hasUsableToolName(name) {
  return typeof name === 'string' && name.trim().length > 0
}

/**
 * 把 DSH 的 `RequestMessage[]` 折成 OpenAI 的 `messages[]`。
 *
 * 与 `opencode/adapter.js` 的 `foldMessages` **完全不同**：opencode 那条是**会话式**
 * 协议（历史在服务端），所以只发最后一条 user；OpenAI 兼容端点是**无状态**的，
 * 必须把整段历史按 OpenAI 的形状发出去。所以这里：
 *
 * - `system`/`developer` 消息抽出来合并（放进 body 的 system 位，见调用方）；
 * - `tool` 角色的消息 → `{role:'tool', tool_call_id, content}`；
 * - 历史里包在 user 里的 `tool-result` 块（老形状）也转成 `tool` 消息；
 * - assistant 的 `tool-call` 块 → `tool_calls[]`；`reasoning` 块**不进历史**
 *   （OpenAI 兼容端点大多拒收或忽略，发过去只会让上游 400）；
 * - 图片走 `image_url` 的 data URL（能力声明没有 image 时降级为 `[图片]`）；
 * - 模型不支持工具时，工具结果折进 user 文本 —— 否则严格的上游会对
 *   「有 tool 消息但没有 tools 定义」直接 400。
 *
 * @returns {Promise<{ messages: object[], systems: string[], images: number, dropped: number }>}
 */
export async function convertRequestMessages(messages, ctx = {}) {
  const list = Array.isArray(messages) ? messages : []
  const supportsTools = ctx.supportsTools !== false
  const out = []
  const systems = []
  let images = 0
  let dropped = 0

  /** 一张图片 → `{type:'image_url'}` 内容块；读不出来就降级成文本（不打死整轮）。 */
  const imageBlock = async (attachment) => {
    if (ctx.visionAllowed !== true) { dropped += 1; return { type: 'text', text: '[图片]' } }
    if (images >= MAX_REQUEST_IMAGES) { dropped += 1; return { type: 'text', text: '[图片（本次请求已达内联上限）]' } }
    if (typeof ctx.readImage !== 'function') { dropped += 1; return { type: 'text', text: '[图片]' } }
    let stored
    try {
      const target = requestImageTargetFor(attachment?.width, attachment?.height)
      const projected = typeof ctx.readImageRequest === 'function'
        ? await ctx.readImageRequest(attachment, target).catch(() => undefined)
        : undefined
      stored = projected ?? await ctx.readImage(attachment)
    } catch (error) {
      ctx.logger?.warn?.('[dsh-free-model] ' + String(ctx.laneId ?? 'keyed') + ' 读取图片失败，降级为文本：'
        + (error instanceof Error ? error.message : String(error)))
      dropped += 1
      return { type: 'text', text: '[图片]' }
    }
    const data = stored?.data
    const mediaType = typeof stored?.mediaType === 'string' ? stored.mediaType : 'image/png'
    if (data === undefined || data === null) { dropped += 1; return { type: 'text', text: '[图片]' } }
    images += 1
    return { type: 'image_url', image_url: { url: 'data:' + mediaType + ';base64,' + Buffer.from(data).toString('base64') } }
  }

  for (const message of list) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role
    const blocks = Array.isArray(message.content) ? message.content : []
    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content)
      if (text !== '') systems.push(text)
      continue
    }
    if (role === 'tool') {
      const results = blocks.filter((block) => block?.type === 'tool-result')
      const rows = results.length > 0 ? results : [{ content: message.content, toolCallId: message.toolCallId }]
      for (const row of rows) {
        const id = String(row.toolCallId ?? message.toolCallId ?? '')
        const text = contentToText(row.content)
        if (supportsTools) {
          out.push({ role: 'tool', tool_call_id: id, content: text === '' ? '(空结果)' : text })
        } else {
          out.push({ role: 'user', content: '[工具结果 ' + id + '] ' + (text === '' ? '(空结果)' : text) })
        }
      }
      continue
    }
    if (role === 'assistant') {
      const text = blocks.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('')
      const calls = blocks.filter((block) => block?.type === 'tool-call' && hasUsableToolName(block.name))
      const entry = { role: 'assistant', content: text }
      if (supportsTools && calls.length > 0) {
        entry.tool_calls = calls.map((call, index) => ({
          id: String(call.id ?? ('call-' + index)),
          type: 'function',
          function: { name: call.name, arguments: normalizeToolArguments(call.arguments) },
        }))
      }
      if (entry.content === '' && entry.tool_calls === undefined) continue
      out.push(entry)
      continue
    }
    // user（以及未知角色：降级为 user，别丢内容）
    const content = []
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') { content.push({ type: 'text', text: block.text }); continue }
      if (block.type === 'image') { content.push(await imageBlock(block.attachment)); continue }
      if (block.type === 'tool-result') {
        const id = String(block.toolCallId ?? '')
        if (supportsTools) { out.push({ role: 'tool', tool_call_id: id, content: contentToText(block.content) || '(空结果)' }); continue }
        content.push({ type: 'text', text: '[工具结果 ' + id + '] ' + contentToText(block.content) })
        continue
      }
    }
    if (content.length === 0) {
      const text = contentToText(message.content)
      // 未知角色也降级成 user：丢内容比丢角色更糟。
      if (text !== '') out.push({ role: 'user', content: text })
      continue
    }
    if (content.length === 1 && content[0].type === 'text') out.push({ role: 'user', content: content[0].text })
    else out.push({ role: 'user', content })
  }
  return { messages: out, systems, images, dropped }
}

/** 一次请求体（导出**只**为了测试断言形状）。 */
export function buildOpenAiBody(options) {
  const {
    model,
    messages,
    system,
    tools,
    supportsTools,
    maxTokens,
    temperature,
    stop,
    streamUsage,
  } = options
  const body = {
    model,
    messages: system === '' || system === undefined ? messages : [{ role: 'system', content: system }, ...messages],
    stream: true,
  }
  const maxOut = positive(maxTokens)
  if (maxOut !== undefined) body.max_tokens = maxOut
  if (Number.isFinite(temperature)) body.temperature = temperature
  if (Array.isArray(stop) && stop.length > 0) body.stop = stop.slice(0, 4)
  if (supportsTools && Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
      .filter((tool) => hasUsableToolName(tool?.name))
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          parameters: tool.parameters !== null && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
        },
      }))
    if (body.tools.length > 0) body.tool_choice = 'auto'
    else delete body.tools
  }
  if (streamUsage === true) body.stream_options = { include_usage: true }
  return body
}

/** OpenAI usage → DSH `TokenUsage`（缓存命中要从 input 里扣掉，与 opencode 车道同一口径）。 */
export function normalizeUsage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const prompt = Number(raw.prompt_tokens ?? raw.input_tokens)
  const completion = Number(raw.completion_tokens ?? raw.output_tokens)
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return undefined
  const cached = Number(raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens)
  const hasCached = Number.isFinite(cached) && cached > 0
  const usage = {
    inputTokens: (Number.isFinite(prompt) ? prompt : 0) - (hasCached ? cached : 0),
    outputTokens: Number.isFinite(completion) ? completion : 0,
  }
  if (usage.inputTokens < 0) usage.inputTokens = 0
  const total = Number(raw.total_tokens)
  if (Number.isFinite(total)) usage.totalTokens = total
  if (hasCached) usage.cacheReadTokens = cached
  const reasoning = Number(raw.completion_tokens_details?.reasoning_tokens)
  if (Number.isFinite(reasoning) && reasoning > 0) usage.reasoningTokens = reasoning
  return usage
}

/** 从一帧 SSE 块里取 `data:` 负载（多行 data: 按 SSE 规范用换行拼接）。 */
export function frameData(block) {
  const lines = String(block).split('\n')
  const payload = []
  for (const line of lines) {
    if (line.startsWith('data:')) payload.push(line.slice(5).replace(/^ /, ''))
  }
  if (payload.length === 0) return undefined
  return payload.join('\n')
}

/**
 * 把一条声明式车道包成 DSH 的 provider 适配器。
 *
 * @param {{
 *   lane: object,
 *   apiKey?: string|null,
 *   fetchImpl?: Function,
 *   logger?: { warn?: Function, info?: Function },
 *   readImage?: (attachment: any) => Promise<{ data: Uint8Array, mediaType: string }>,
 *   readImageRequest?: (attachment: any, target: any) => Promise<{ data: Uint8Array, mediaType: string }>,
 *   timeoutMs?: number,
 * }} options
 * @returns {KeyedAdapter}
 */
export function createKeyedAdapter(options = {}) {
  return new KeyedAdapter(options)
}

/**
 * 通用 OpenAI 兼容适配器。
 *
 * 车道数据在构造时**冻结**（拿不到 lane 的引用就等于拿不到它的模型表）；
 * `apiKey` 可以在运行期用 `setApiKey()` 换（用户在页面里填完 key，不必重挂适配器）。
 */
export class KeyedAdapter extends LlmAdapter {
  /**
   * @param {object} options 见 {@link createKeyedAdapter}
   */
  constructor(options = {}) {
    super()
    const lane = options.lane
    if (lane === null || typeof lane !== 'object' || typeof lane.id !== 'string' || lane.id === '') {
      throw new LlmError('createKeyedAdapter 需要一条带 id 的车道（见 catalog.js）', 'INVALID_ADAPTER')
    }
    this.lane = { ...lane }
    /**
     * 这条车道的 key 列表（同渠道多账号轮换，0.6.0）。
     *
     * ## 为什么是数组而不是继续用单值
     *
     * 免费额度的单位几乎都是「每账号/每 key 每天多少」。用户手里常有两三把同渠道的 key，
     * 而旧实现只用第一把：撞上 429 / 401 就整条渠道不可用，剩下的 key 白白闲置。
     * 现在把列表带进来，失败时**换下一把再试一次**（只一次，见 stream 里的说明）。
     *
     * 兼容：仍接受 `options.apiKey`（单值），此时列表长度为 1。
     */
    this.apiKeys = normalizeKeyList(options.apiKeys, options.apiKey)
    /** 当前用的是第几把（0 起）。换 key 只改游标，不重建适配器。 */
    this.keyCursor = 0
    this.apiKey = this.apiKeys.length > 0 ? this.apiKeys[0] : null
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
    this.logger = options.logger
    this.readImage = options.readImage
    this.readImageRequest = options.readImageRequest
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
    /**
     * 真实对话的结果回执（0.6.0）。
     *
     * ## 为什么适配器要往外报，而不是让上层自己看 `lastFailure()`
     *
     * 上层不可能"守着"看：失败发生在一次 `stream()` 里面，异常直接抛给 agent loop，
     * 等上层下一次读 `lastFailure()` 时可能已经是十分钟后、甚至换了一条模型。
     * 而**健康账本要的就是这一刻**：它记录的是"这次真打上游失败了，别再拿它撞"。
     *
     * 回调是纯通知：它抛错不影响这次请求的成败（`notify` 自己吞掉异常）。
     */
    this.onOutcome = typeof options.onOutcome === 'function' ? options.onOutcome : undefined
    /**
     * 发请求**之前**的闸门（0.6.0，健康账本接进来的地方）。
     *
     * ## 为什么要在适配器里拦，而不是让用户自己看徽章
     *
     * 健康账本已经知道「这条渠道在冷却，还要等 42 分钟」。如果不在发请求前拦下来，
     * 用户（或 agent 的重试）每选一次这个模型，就真的往上游打一次 —— 打的是一个
     * 刚刚明确拒绝过我们的端点。免费渠道的限流是有记忆的：多打几次会把冷却窗口越推越远。
     *
     * 拦下来报的错**必须带上剩余时间**（「还要等 42 分钟」），否则用户只知道失败、
     * 不知道等多久 —— 于是他大概率立刻重试，把刚恢复一点点的窗口再推远。
     *
     * 与 retired / MISSING_CREDENTIAL 同一档：都是**不发请求的本地拒绝**，
     * 区别只在原因不同（渠道下线 / 没 key / 正在冷却）。
     */
    this.beforeRequest = typeof options.beforeRequest === 'function' ? options.beforeRequest : undefined
    /** 实时目录缓存。 */
    this.catalogModels = undefined
    this.catalogSource = 'static'
    this.catalogAt = 0
    this.catalogFailureAt = 0
    /** 上游是否接受 `stream_options`（400 之后记住，不再问第二次）。 */
    this.streamUsageSupported = this.lane.streamUsage !== false
    /** 最近一次分类后的失败（页面渲染「这次为什么不能用」）。 */
    this.failure = undefined
  }

  /**
   * 把一次结果通知给上层（健康账本）。**绝不抛**：这是旁路通知，不能让一次
   * 本来已成功的请求因为记账失败而变成失败。
   */
  #notify(ok, classified) {
    if (this.onOutcome === undefined) return
    try {
      this.onOutcome({
        lane: this.lane.id,
        ok,
        ...(classified === undefined ? {} : {
          kind: classified.kind,
          ...(Number.isFinite(classified.status) ? { status: classified.status } : {}),
          advice: classified.advice,
          detail: classified.detail,
        }),
      })
    } catch (error) {
      this.logger?.warn?.('dsh-free-model: 健康回执失败（' + (error instanceof Error ? error.message : String(error)) + '）')
    }
  }

  /** 记一次失败：写 `this.failure` 并向上层回执（两件事必须一起做，别再散落成 5 处）。 */
  #fail(classified, modelKey) {
    this.failure = { ...classified, at: new Date().toISOString(), model: modelKey }
    this.#notify(false, classified)
    return failureToError(this.lane, classified)
  }

  /** 运行期换 key（页面填完 key 之后可以直接换，不必重挂）。接受单值或数组。 */
  setApiKey(apiKey) {
    const list = normalizeKeyList(Array.isArray(apiKey) ? apiKey : undefined, Array.isArray(apiKey) ? undefined : apiKey)
    this.apiKeys = list
    this.keyCursor = 0
    this.apiKey = list.length > 0 ? list[0] : null
    // 换 key 后目录/失败状态都可能是旧身份的，一并作废。
    this.catalogModels = undefined
    this.catalogAt = 0
    this.failure = undefined
  }

  /** 最近一次失败的分类结果（副本；没有就返回 `undefined`）。 */
  lastFailure() {
    return this.failure === undefined ? undefined : { ...this.failure }
  }

  /** 路由展示名。`id` 必须等于 provider，`name` 非空（宿主会校验）。 */
  providerInfo(provider) {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.lane.id
    return { id, name: this.lane.displayName ?? this.lane.id }
  }

  /**
   * 本车道自己的重试策略。
   *
   * ## 为什么不再返回 undefined（0.6.0 修，审计的 P1-2）
   *
   * 返回 undefined 等于交给宿主的默认表：**maxRetries=5、初始 500ms、翻倍到 10s**。
   * 对一般渠道这没问题；对**按 IP 串行限速**的免费渠道是灾难 ——
   * pollinations 的规则是「同一 IP 两次请求间隔 ≥30 秒，快了就回 402 + Retry-After」，
   * 而宿主的退避会在 500ms→1s→2s→4s→8s 内连打 5 次，正好把配额刷穿，
   * 还让上游把这台机器的窗口推得更远。
   *
   * 两条判据：
   * 1. `lane.serialRateLimit === true`（目录里显式声明的串行限速渠道）→ **不重试**，
   *    完全交给上游的 Retry-After（宿主会优先采用我们带出的 `providerRetryAfterMs`）；
   * 2. 其余渠道 → 最多 1 次重试，起点 2 秒、上限 30 秒。
   *    「1 次」是刻意的：免费渠道重试到第三次基本都在撞同一堵墙，而用户能感觉到卡。
   *
   * 上界是**可算的**：最坏 1 次重试 + 2 秒等待，不会出现"一个请求在后台默默重试十几次"。
   */
  providerRetryPolicy() {
    if (this.lane.serialRateLimit === true) {
      return {
        mode: 'normal',
        maxRetries: 0,
        retryableCodes: [],
        backoff: { initialDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0 },
      }
    }
    return {
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      backoff: { initialDelayMs: 2_000, maxDelayMs: 30_000, jitterRatio: 0.2 },
    }
  }

  /** 本车道不上报图片计费口径（免费渠道没有可用的视觉 token 计价表）。 */
  imageRequestPricing() {
    return undefined
  }

  /** 图片请求目标：按像素预算缩小，字节上限 2MiB。 */
  imageRequestTarget(_provider, _model, image) {
    return requestImageTargetFor(image?.width, image?.height)
  }

  /** 给页面的能力摘要（**不是** DSH 字段：宿主这一版没有 tools 声明位）。 */
  capabilities(modelId) {
    const row = this.#staticRow(modelId)
    return {
      lane: this.lane.id,
      model: modelId,
      vision: row?.vision === true,
      tools: row?.tools !== false,
      source: row === undefined ? 'unknown' : 'catalog',
    }
  }

  /** 请求根地址（去掉结尾斜杠，避免 `//chat/completions`）。 */
  get baseURL() {
    return String(this.lane.baseURL ?? '').replace(/\/+$/, '')
  }

  /**
   * 模型目录。**绝不抛**：宿主会在模型选择器、状态页、探测三处并发调用，
   * 一次抛出就会让选择器空白。拉不到就退回静态表并标 `source:'static'`。
   *
   * ⚠️ `source` 挂在**返回的数组对象**上（`rows.source`）—— 目录行保持与
   * `OpenCodeAdapter` 逐字相同的四字段，不往里塞私货（宿主对行字段的容忍度未知，
   * 数组对象上的属性则完全不影响它）。
   */
  async listModels(providerId) {
    const provider = typeof providerId === 'string' && providerId !== '' ? providerId : this.lane.id
    const rows = await this.#catalog()
    // ⚠️ 行列就是 OpenCodeAdapter 的那四个字段：上下文窗口走 resolveModel 的
    // `context.contextWindow`，不塞进目录行（宿主的 LlmModelInfo 里没有它）。
    const out = rows.map((row) => ({
      provider,
      id: row.id,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
      inputModalities: row.vision === true ? ['text', 'image'] : ['text'],
    }))
    out.source = this.catalogSource
    return out
  }

  /** 单模型元数据（窗口未知时给兜底值：0 是「未知」，不是「零窗口」）。 */
  async resolveModel(provider, model, _signal) {
    const row = await this.#rowFor(model)
    const contextWindow = positive(row?.contextWindow) ?? FALLBACK_CONTEXT_WINDOW
    return {
      provider,
      id: model,
      name: typeof row?.name === 'string' && row.name !== '' ? row.name : model,
      inputModalities: row?.vision === true ? ['text', 'image'] : ['text'],
      context: { contextWindow },
      defaultMaxTokens: positive(row?.maxTokens) ?? FALLBACK_MAX_OUTPUT,
    }
  }

  /** 绑定一代：模型元数据与 stream 固定在同一份配置上（与两个既有适配器同款）。 */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * 流式产出 DSH 的 chunk。
   *
   * 里程碑顺序：`block-start` →（`*-delta`）→ `block-end` → `usage` → `finish`。
   * 块编号按**首次出现**的顺序分配（模型先给思考就先给 reasoning 编号），
   * 与 `OpenCodeAdapter` 的做法一致 —— 别按「文本一定在 0 号」写死。
   */
  async *stream(options) {
    const lane = this.lane
    const modelKey = String(options?.model ?? '')
    if (modelKey === '') throw new LlmError(`${lane.id}: 未指定模型`, 'INVALID_REQUEST')
    if (lane.retired === true) {
      throw new LlmError(
        `${lane.id}: 该渠道已下线（${String(lane.retiredOn ?? '')}），换一条车道；它不会因为重试而恢复。`,
        'INVALID_REQUEST',
      )
    }
    if (lane.kind === 'keyed' && (this.apiKey === null || this.apiKey === '')) {
      throw new LlmError(
        `${lane.id}: 没有可用凭据。去 ${String(lane.signupURL ?? '[SIGNUP_URL]')} 拿 key，`
        + `写入凭据 ${String(lane.apiKeyEnv ?? '[API_KEY_ENV]')} 后再用这条车道。`,
        'MISSING_CREDENTIAL',
      )
    }
    // ⚠️ 占位符没替换就别发请求：这里的地址必然 404，而 404 在页面上会被读成
    // "插件坏了"。宁可抛一条说得清的错误。`keyedLaneState` 同样会判 not-ready，
    // 这里是给"绕过就绪判定直接挂适配器"留的兜底。
    // 健康闸门：冷却中 / 已吊销的渠道**不发请求**。原因里必须带「还要等多久」，
    // 否则用户会立刻重试，把限流窗口越推越远（见 beforeRequest 的注释）。
    if (this.beforeRequest !== undefined) {
      let gate
      try {
        gate = this.beforeRequest(lane.id)
      } catch {
        // 闸门自己出错不能挡住请求：健康是增强，不是依赖。
        gate = undefined
      }
      if (gate !== undefined && gate !== null && gate.available === false) {
        throw new LlmError(
          lane.id + '：' + String(gate.reason ?? '这条渠道现在不可用') + '；换一条渠道，或在设置页清掉健康状态。',
          gate.state === 'revoked' ? 'MISSING_CREDENTIAL' : 'RATE_LIMIT',
        )
      }
    }
    const pending = lanePlaceholders(lane)
    if (pending.length > 0) {
      throw new LlmError(
        `${lane.id}: baseURL 里还有未替换的占位符 ${pending.join('、')}（例如 Cloudflare 的账号 ID），`
        + '替换之前这条车道的地址必然是 404。',
        'INVALID_REQUEST',
      )
    }

    // ── 超时/取消：一个 controller 管到流结束（目录探测 + 请求 + 读流），finally 里清 ──
    // ⚠️ 这个 timer **不 unref**：它如果是当时唯一还没 settle 的东西（例如上游挂在
    // 半路上），unref 会让进程直接退出而不是等到超时 —— 那时连分类错误都写不出来。
    // setTimeout 只触发一次，且 finally 一定会 clearTimeout，不会拖住任何东西。
    let timedOut = false
    const abort = new AbortController()
    const timer = setTimeout(() => { timedOut = true; abort.abort() }, this.timeoutMs)
    const outerSignal = options?.signal
    const onOuterAbort = () => abort.abort(outerSignal?.reason)
    outerSignal?.addEventListener?.('abort', onOuterAbort, { once: true })

    let response
    let reasoningIndex = -1
    let textIndex = -1
    let nextIndex = 0
    let sawReasoning = false
    let sawText = false
    let reasoningText = ''
    let text = ''
    let usage
    let finishReason
    let badFrames = 0
    /**
     * 上游是否**明确表示说完了**（收到 `[DONE]`，或收到带了 finish_reason 的帧）。
     *
     * ⚠️ 2026-10-26 修（审计发现的 P0-3）：原来只看 blockCount，于是
     * 「上游断在半句话上」被判成 `finish.kind='stop'` —— 页面显示半截回答、
     * 没有任何错误，而且 `#notify(true)` 还把这个渠道记成健康 OK。
     * 免费渠道的流被网关掐断是**常态**（尤其是长回答与大工具调用），
     * 把中断当成功会让用户以为模型就这水平。
     */
    let sawDone = false
    /** OpenAI 的 tool_calls[].index → 本适配器分配的块信息。 */
    const toolCalls = new Map()

    try {
      const row = await this.#rowFor(modelKey, abort.signal)
      const supportsTools = row?.tools !== false
      const visionAllowed = row?.vision === true
      const converted = await convertRequestMessages(options?.messages, {
        readImage: this.readImage,
        readImageRequest: this.readImageRequest,
        logger: this.logger,
        laneId: lane.id,
        supportsTools,
        visionAllowed,
      })
      const ownSystem = typeof options?.system === 'string' ? options.system.trim() : ''
      const system = [ownSystem, ...converted.systems].filter((part) => part !== '').join('\n\n')
      if (converted.messages.length === 0 && system === '') {
        throw new LlmError(`${lane.id}: 本轮没有可发送的内容`, 'INVALID_REQUEST')
      }
      const body = buildOpenAiBody({
        model: modelKey,
        messages: converted.messages,
        system,
        tools: options?.tools,
        supportsTools,
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
        stop: options?.stop,
        streamUsage: this.streamUsageSupported,
      })

      // key 只在这里拼进请求头（不落在 baseHeaders 里）：轮换时每轮都要用**当前**那把。
      const headers = { 'content-type': 'application/json', accept: 'text/event-stream' }
      const url = this.baseURL + '/chat/completions'

      const first = await this.#sendRotating(url, body, headers, abort.signal)
      if (first.status === 400 && body.stream_options !== undefined) {
        // 有些端点不认 stream_options：剥掉重试一次，并把结论记住（下次别问）。
        const detail = first.text ?? ''
        if (/stream_options|unknown (?:field|parameter)|unrecognized|extra fields/i.test(detail)) {
          this.streamUsageSupported = false
          this.logger?.warn?.(`[dsh-free-model] ${lane.id} 不接受 stream_options，已关闭（usage 将缺失）`)
          const retryBody = { ...body }
          delete retryBody.stream_options
          const second = await this.#sendRotating(url, retryBody, headers, abort.signal)
          response = second.response
          if (!second.ok) {
            const classified = second.classified
              ?? classifyUpstreamFailure({ status: second.status, body: second.text, headers: second.headers, lane })
            throw this.#fail(classified, modelKey)
          }
        }
      }
      if (response === undefined) {
        response = first.response
        if (!first.ok) {
          const classified = first.classified
            ?? classifyUpstreamFailure({ status: first.status, body: first.text, headers: first.headers, lane })
          throw this.#fail(classified, modelKey)
        }
      }
      if (response.body === null || typeof response.body?.getReader !== 'function') {
        throw new LlmError(`${lane.id}: 上游回了 ${response.status} 但没有可读的流（不是 SSE 响应）`, 'UPSTREAM_ERROR')
      }

      for await (const payload of this.#frames(response, abort.signal)) {
        if (payload === '[DONE]') { sawDone = true; break }
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          badFrames += 1
          if (badFrames === 1) this.logger?.warn?.(`[dsh-free-model] ${lane.id} 收到无法解析的 SSE 帧（已跳过）：${payload.slice(0, 160)}`)
          if (badFrames > MAX_BAD_FRAMES) {
            throw new LlmError(
              `${lane.id}: SSE 里出现 ${badFrames} 个无法解析的帧，对面多半不是 SSE（可能是 HTML 错误页或网关拦截页）。`,
              'UPSTREAM_ERROR',
            )
          }
          continue
        }
        if (chunk === null || typeof chunk !== 'object') continue
        // 错误帧：OpenAI 兼容端点在**流内**报错也常见（限流、无权限、模型下线）。
        if (chunk.error !== undefined && chunk.error !== null) {
          const classified = classifyUpstreamFailure({ body: JSON.stringify({ error: chunk.error }), lane })
          throw this.#fail(classified, modelKey)
        }
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
        const delta = choice?.delta
        if (delta !== null && typeof delta === 'object') {
          const reasoning = typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : typeof delta.reasoning === 'string' ? delta.reasoning : ''
          if (reasoning !== '') {
            if (!sawReasoning) {
              sawReasoning = true
              reasoningIndex = nextIndex
              nextIndex += 1
              yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
            }
            reasoningText += reasoning
            yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoning }
          }
          if (typeof delta.content === 'string' && delta.content !== '') {
            if (!sawText) {
              sawText = true
              textIndex = nextIndex
              nextIndex += 1
              yield { type: 'block-start', index: textIndex, blockType: 'text' }
            }
            text += delta.content
            yield { type: 'text-delta', index: textIndex, text: delta.content }
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              if (call === null || typeof call !== 'object') continue
              const toolIndex = Number.isFinite(call.index) ? Number(call.index) : 0
              const name = typeof call.function?.name === 'string' ? call.function.name : ''
              const argsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
              let slot = toolCalls.get(toolIndex)
              if (slot === undefined) {
                slot = {
                  index: -1,
                  id: typeof call.id === 'string' && call.id !== '' ? call.id : '',
                  name: '',
                  args: '',
                  announced: false,
                }
                toolCalls.set(toolIndex, slot)
              }
              if (name !== '') slot.name = name
              if (call.id !== undefined && slot.id === '' && typeof call.id === 'string') slot.id = call.id
              slot.args += argsDelta
              // ⚠️ **先等工具名**再开块：没有名字的调用宿主执行不了，而一旦这里发过
              // `block-start`，`BlockAssembler` 就会为它留下一个 partial（缺 block-end
              // 时它会自己合成一个 `name:''` 的调用）—— 那时再"丢掉"已经晚了。
              // 所以名字没到之前**什么都不发**（OpenAI 的第一片一般就带 name，正常路径
              // 立刻开块；只有输出残缺的模型才会被忍住）。
              if (!slot.announced && hasUsableToolName(slot.name)) {
                slot.announced = true
                slot.index = nextIndex
                nextIndex += 1
                if (slot.id === '') slot.id = 'call-' + slot.index
                yield { type: 'block-start', index: slot.index, blockType: 'tool-call' }
                // ⚠️ `name` 只在非空时带上：assistant-stream 把 `name:''` 明确当异常帧。
                yield { type: 'tool-call-delta', index: slot.index, id: slot.id, name: slot.name, argumentsDelta: slot.args }
                continue
              }
              if (slot.announced) {
                yield { type: 'tool-call-delta', index: slot.index, id: slot.id, argumentsDelta: argsDelta }
              }
            }
          }
        }
        if (chunk.usage !== undefined) {
          const normalized = normalizeUsage(chunk.usage)
          if (normalized !== undefined) usage = normalized
        }
        if (choice !== undefined && choice.finish_reason !== undefined && choice.finish_reason !== null) {
          finishReason = String(choice.finish_reason)
          // 带了 finish_reason 就等于上游说「这一轮我说完了」——即使没有 [DONE]。
          // 有些网关（以及部分自建代理）只发 finish_reason 不发 [DONE]。
          sawDone = true
        }
      }
    } catch (error) {
      if (outerSignal?.aborted === true && !timedOut) {
        const classified = classifyUpstreamFailure({ lane, error, userAborted: true })
        this.failure = { ...classified, at: new Date().toISOString(), model: modelKey }
        // ⚠️ 用户自己按了停止：**不**回执。把它记成渠道故障会让「我取消了」变成
        // 「这条渠道冷却 30 秒」，而用户下一步通常就是重发。
        throw error instanceof LlmError ? error : failureToError(lane, classified)
      }
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
        const classified = classifyUpstreamFailure({ lane, error, timedOut: true })
        throw this.#fail(classified, modelKey)
      }
      // 传输层失败（fetch 抛错）也要分类，页面才能说清「连不上」还是「被拒」。
      if (!(error instanceof LlmError)) {
        const classified = classifyUpstreamFailure({ lane, error })
        throw this.#fail(classified, modelKey)
      }
      throw error
    } finally {
      clearTimeout(timer)
      outerSignal?.removeEventListener?.('abort', onOuterAbort)
    }

    // ── 收尾：块按编号升序关闭（assembler 按 index 记账，顺序不影响，但升序好读）────
    const blocks = []
    if (sawReasoning) blocks.push({ index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } })
    if (sawText) blocks.push({ index: textIndex, block: { type: 'text', text } })
    let usableCalls = 0
    for (const slot of toolCalls.values()) {
      // 无名或参数不是 JSON 对象的调用**不发**：宿主拿它去查工具表会直接失败，
      // 而发一个坏调用比不发更糟（循环会停在一次注定失败的调用上）。
      // 注意：没 announced 的那些连 partial 都没留下（见上面的说明），直接跳过即可。
      if (!slot.announced || !hasUsableToolName(slot.name)) {
        this.logger?.warn?.(`[dsh-free-model] ${lane.id} 丢弃了一个没有名字的工具调用（模型输出不完整）`)
        continue
      }
      let parsed
      try {
        parsed = JSON.parse(slot.args === '' ? '{}' : slot.args)
      } catch {
        this.logger?.warn?.(`[dsh-free-model] ${lane.id} 丢弃了工具调用 ${slot.name}：参数不是合法 JSON（多半被截断）`)
        continue
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      usableCalls += 1
      blocks.push({
        index: slot.index,
        block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args === '' ? '{}' : slot.args },
      })
    }
    blocks.sort((a, b) => a.index - b.index)
    for (const entry of blocks) yield { type: 'block-end', index: entry.index, block: entry.block }

    if (usage !== undefined) yield { type: 'usage', usage }

    const blockCount = blocks.length
    let reason
    if (blockCount === 0) {
      // 收完了却什么都没有：这与「模型说了句空话」不同，宿主需要一条明确失败。
      reason = {
        kind: 'error',
        failure: { message: `${lane.id}: 上游返回了空响应（没有文本也没有工具调用）`, code: 'EMPTY_RESPONSE' },
      }
    } else if (sawDone !== true && finishReason === undefined) {
      // 断流：既没有 [DONE]，也没有 finish_reason，却已经有内容 —— 这是**上游掐断**，
      // 不是模型说完。必须当失败报（并且按抖动记一次冷却）。
      const classified = {
        kind: FAILURE_KINDS.CONNECTION,
        code: 'STREAM_CUT',
        retryable: true,
        advice: lane.id + '：上游把流掐断了（收到内容但没有结束标记）。这一般是网关/免费层超时或过载，重试一次通常能恢复。',
        detail: '收到 ' + String(blockCount) + ' 个内容块后流终止，无 [DONE] 也无 finish_reason',
      }
      this.failure = { ...classified, at: new Date().toISOString(), model: modelKey }
      this.#notify(false, classified)
      reason = {
        kind: 'error',
        failure: { message: classified.advice, code: 'STREAM_CUT' },
      }
    } else if (finishReason === 'length') {
      reason = { kind: 'max-tokens' }
    } else if (usableCalls > 0) {
      reason = { kind: 'tool-calls' }
    } else if (finishReason === 'content_filter') {
      reason = { kind: 'stop', stopReason: 'content_filter' }
    } else {
      reason = { kind: 'stop', ...(finishReason === undefined ? {} : { stopReason: finishReason }) }
    }
    // 只有「真的产出了内容」才算一次成功。空响应 / 被内容过滤 / 纯思考都不回执：
    // 前者是上游抖动（该进冷却），后两者是**模型的输出选择**，不是渠道健康问题。
    if (reason.kind !== 'error' && blockCount > 0 && finishReason !== 'content_filter') this.#notify(true)
    yield { type: 'finish', reason }
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  /** 静态表里的行（大小写不敏感的兜底匹配）。 */
  #staticRow(modelId) {
    const rows = staticModels(this.lane)
    const key = String(modelId ?? '')
    return rows.find((row) => row.id === key) ?? rows.find((row) => String(row.id).toLowerCase() === key.toLowerCase())
  }

  /** 实时目录优先、静态兜底的行。 */
  async #rowFor(modelId, signal) {
    const key = String(modelId ?? '')
    const live = await this.#catalog(signal)
    return live.find((row) => row.id === key)
      ?? live.find((row) => String(row.id).toLowerCase() === key.toLowerCase())
      ?? this.#staticRow(key)
  }

  /**
   * 目录（带 TTL 与失败冷却）。
   *
   * ⚠️ 没有任何 CDN 保证 `/models` 存在：Google 的 OpenAI 兼容面**没有**这个端点
   * （实测 404），Cloudflare 的目录不在同一路径。所以 `supportsModelList:false`
   * 的渠道直接走静态表，一次网络都不发 —— 否则每次开模型选择器都白等一次超时。
   */
  async #catalog(signal) {
    const now = Date.now()
    if (this.catalogModels !== undefined && now - this.catalogAt < CATALOG_TTL_MS) return this.catalogModels
    if (this.lane.supportsModelList === false || lanePlaceholders(this.lane).length > 0) {
      this.catalogModels = staticModels(this.lane)
      this.catalogSource = 'static'
      this.catalogAt = now
      return this.catalogModels
    }
    if (this.catalogFailureAt !== 0 && now - this.catalogFailureAt < CATALOG_FAILURE_TTL_MS) {
      return this.catalogModels ?? staticModels(this.lane)
    }
    const url = typeof this.lane.modelsURL === 'string' && this.lane.modelsURL !== ''
      ? this.lane.modelsURL
      : this.baseURL + '/models'
    try {
      const headers = { accept: 'application/json' }
      if (this.apiKey !== null && this.apiKey !== '') headers.authorization = 'Bearer ' + this.apiKey
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 20_000))
      // ⚠️ 把调用方的取消信号接进来：用户取消一轮对话时，正在跑的那次目录探测
      // 也必须一起停 —— 否则它会在后台把 20 秒跑满，下一次请求还要排在它后面。
      const onAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener?.('abort', onAbort, { once: true })
      let response
      try {
        response = await this.fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
      }
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const payload = await response.json()
      const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
      const rows = data
        .map((raw) => {
          const id = typeof raw?.id === 'string' ? raw.id : typeof raw?.name === 'string' ? raw.name : ''
          if (id === '') return undefined
          const modalities = Array.isArray(raw?.architecture?.input_modalities)
            ? raw.architecture.input_modalities
            : Array.isArray(raw?.input_modalities) ? raw.input_modalities : []
          return {
            id,
            name: typeof raw?.name === 'string' && raw.name !== '' ? raw.name : id,
            contextWindow: positive(raw?.context_window ?? raw?.context_length ?? raw?.contextWindow) ?? 0,
            maxTokens: positive(raw?.max_completion_tokens ?? raw?.max_tokens) ?? 0,
            vision: modalities.includes('image') || raw?.vision === true,
            tools: Array.isArray(raw?.supported_parameters)
              ? raw.supported_parameters.includes('tools')
              : raw?.capabilities?.toolcall === true || raw?.tools !== false,
          }
        })
        .filter((row) => row !== undefined)
      if (rows.length === 0) throw new Error('目录为空')
      this.catalogModels = rows
      this.catalogSource = 'live'
      this.catalogAt = now
      this.catalogFailureAt = 0
      return rows
    } catch (error) {
      this.catalogFailureAt = now
      // 失败只记一条（同 TTL 窗口内重复失败没有新信息，刷日志会盖住真问题）。
      this.logger?.warn?.(`[dsh-free-model] ${this.lane.id} 读取实时模型目录失败（${error instanceof Error ? error.message : String(error)}），回退静态表`)
      this.catalogSource = 'static'
      this.catalogModels = this.catalogModels ?? staticModels(this.lane)
      return this.catalogModels
    }
  }

  /**
   * 换下一把 key。没有下一把时返回 false（调用方据此决定要不要放弃）。
   *
   * 游标**不回绕**：一轮请求最多往前走一把，走完就停 —— 回绕会让「三把都是坏的」
   * 变成无限循环。下一轮请求重新从游标处继续（坏 key 会被健康账本记住、下次探测就能换掉）。
   */
  #advanceKey() {
    if (this.keyCursor + 1 >= this.apiKeys.length) return false
    this.keyCursor += 1
    this.apiKey = this.apiKeys[this.keyCursor]
    // 换 key 等于换身份：目录缓存与失败状态都可能是上一把的结论，一并作废。
    this.catalogModels = undefined
    this.catalogAt = 0
    return true
  }

  /** 这条车道一共配了几把 key（页面/诊断用）。 */
  keyCount() {
    return this.apiKeys.length
  }

  /**
   * 发请求，并在「换一把 key 可能就好」的失败上**换 key 重试一次**。
   *
   * ## 哪些失败值得换 key
   *
   * | 分类 | 换 key 有用吗 | 为什么 |
   * |---|---|---|
   * | credential（401/403） | **有用** | 一把 key 废了，另一把是另一份额度 |
   * | rate-limit（429） | **有用** | 免费额度按 key 计，换一把等于换一份配额 |
   * | quota（额度用尽） | **有用** | 同上 |
   * | invalid-request / context / unknown-model | 没用 | 换 key 解决不了请求本身的问题 |
   * | connection（超时/网络） | 没用 | 换 key 不换网络 |
   *
   * ⚠️ **最多换一次**：换到第二把还失败就如实报错。理由是「与宿主的重试相乘」——
   * 适配器再重试 × 宿主最多 1 次 = 上界可算；不设限的话三把 key 就是三倍上游流量。
   *
   * 返回值比 `#send` 多一个 `classified`（已经算过分类，调用方不必重算）。
   */
  async #sendRotating(url, body, baseHeaders, signal) {
    let switched = 0
    for (;;) {
      const headers = { ...baseHeaders }
      if (this.apiKey !== null && this.apiKey !== '') headers.authorization = 'Bearer ' + this.apiKey
      const sent = await this.#send(url, body, headers, signal)
      if (sent.ok === true) return sent
      const classified = classifyUpstreamFailure({ status: sent.status, body: sent.text, headers: sent.headers, lane: this.lane })
      const worthSwitching = classified.kind === FAILURE_KINDS.CREDENTIAL
        || classified.kind === FAILURE_KINDS.RATE_LIMIT
        || classified.kind === FAILURE_KINDS.QUOTA
      if (switched === 0 && worthSwitching && this.#advanceKey()) {
        switched += 1
        this.logger?.info?.(
          `dsh-free-model: ${this.lane.id} 换用第 ${this.keyCursor + 1}/${this.apiKeys.length} 把 key 重试（${classified.kind}）`,
        )
        continue
      }
      return { ...sent, classified }
    }
  }

  /**
   * 发一次请求，**不抛**传输层以外的错：返回 `{ok,status,headers,response,text}`。
   * 非 2xx 时顺手把正文读出来（Response 的 body 只能读一次，留给分类用）。
   */
  async #send(url, body, headers, signal) {
    // 已经取消就别发：真实 fetch 会立刻拒，但这里显式判一下，语义更清楚，
    // 也让「取消后不再产生任何上游流量」成为一条可断言的性质。
    if (signal?.aborted === true) throw signal.reason ?? new Error('aborted')
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
    if (response.ok === true) return { ok: true, status: response.status, headers: response.headers, response }
    let text = ''
    try {
      text = await response.text()
    } catch { /* 读不出来就按空正文分类 */ }
    return { ok: false, status: response.status, headers: response.headers, response, text }
  }

  /**
   * SSE 帧流：按 `\n\n` 分帧、只认 `data:` 行、跨 chunk 缓冲半行。
   *
   * 与 `src/opencode/client.js` 的解析写法**逐条对齐**（那是本仓库已实测过的
   * 分帧逻辑）：同样的 `buffer.indexOf('\n\n')` 收尾窗口、同样的 `startsWith('data:')`
   * 过滤、同样忽略没有 data 的块（注释行/keepalive）。唯一多出来的是把 `\r\n`
   * 归一成 `\n` —— SSE 规范允许 CRLF，只认 `\n\n` 会在 Windows 侧上游上丢帧。
   */
  async *#frames(response, signal) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        if (signal?.aborted === true) throw signal.reason ?? new Error('aborted')
        const next = await reader.read()
        if (next.done === true) break
        buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n?/g, '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          const data = frameData(block)
          if (data !== undefined) yield data
        }
      }
      // 收尾：上游直接关连接时最后一帧可能没有以空行结束。
      const tail = frameData(buffer)
      if (tail !== undefined) yield tail
    } finally {
      try { await reader.cancel() } catch { /* 连接已断 */ }
    }
  }
}
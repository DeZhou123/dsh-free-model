/**
 * 「这条渠道还剩多少额度」—— 自带 key 车道的**余额探针**。
 *
 * ## 为什么值得单独做（这是「总台」真正的真空地带）
 *
 * 免费额度都是**有数**的（每天多少 token、每把 key 多少美元）。用户当前的处境是：
 * 只有撞到 429 / 402 才知道「用完了」，而那时活儿已经干到一半、还得换渠道重来。
 * 余额探针把这件事提前：**在还有 5% 的时候就告诉你**。
 *
 * 市场上做这件事的插件都只做「看见」（看板/表格），没有一个把结论喂回路由 ——
 * 本插件也不喂（宿主没有「按余额过滤模型」的扩展点），但至少先做到**看得见**。
 *
 * ## 只读、且只认声明过的端点
 *
 * | 纪律 | 为什么 |
 * |---|---|
 * | 只 GET 目录里声明过的 `balance.url` | 远程目录是不可信输入，不做「拼路径」那种灵活事 |
 * | 金额**保持字符串** | 各家精度不同，浮点一转就出「0.30000000000000004」 |
 * | 混合币种不折算 | 把 CNY 与 USD 加在一起得到的数字没有意义（市场调研里的坑 #14） |
 * | 绝不在返回值里出现 key | 与探测同一纪律：出口处统一遮蔽 |
 *
 * ## 与 `probe.js` 的分工
 *
 * `probe.js` 回答「这把 key 能不能用」，它打 `/models`（最便宜、语义最干净）。
 * 这里回答「还剩多少」，打的是各家自己的余额端点 —— **形态各家不同**，
 * 所以要按 `rowKind` 认形状，认不出来就如实说「拿到了但读不懂」，
 * 而不是猜一个数字出来（猜错的余额比没有余额更糟）。
 *
 * @module src/lanes/keyed/balance
 */

import { safeErrorText } from './keys.js'

/** 默认超时：8 秒（与凭据探测同档，余额端点也是公网小接口）。 */
export const BALANCE_TIMEOUT_MS = 8_000

/** 允许的 `rowKind`：目前只做「余额」这一种，留 enum 是为了将来加「套餐窗口」。 */
export const BALANCE_ROW_KINDS = Object.freeze(['balance'])

/**
 * 从各家形态里抠出余额。
 *
 * 只认**明确的字段名**，不做「找第一个像数字的字段」这种猜测：
 * 猜错的余额会让用户以为还有钱，然后按量计费被扣。
 *
 * @param {unknown} body 响应 JSON
 * @param {string} rowKind 目录里声明的形状
 * @returns {{ found: boolean, amount?: string, currency?: string|null, detail: string }}
 */
export function parseBalance(body, rowKind = 'balance') {
  void rowKind
  if (body === null || typeof body !== 'object') return { found: false, detail: '响应不是 JSON 对象' }
  // 多数平台把数据包在 data 里；OpenRouter 的 /credits 也是 { data: {...} }
  const roots = [body, body.data, body.result].filter((item) => item !== null && typeof item === 'object')

  const pick = (names) => {
    for (const root of roots) {
      for (const name of names) {
        const value = root[name]
        if (typeof value === 'string' && value.trim() !== '') return { amount: value.trim(), currency: null }
        if (typeof value === 'number' && Number.isFinite(value)) return { amount: String(value), currency: null }
      }
    }
    return undefined
  }

  // ① 直接给余额（SiliconFlow / Novita / Moonshot / MiniMax 这一派）
  const direct = pick([
    'available_balance', 'availableBalance', 'available_balance_cny', 'availableBalanceCny',
    'balance', 'totalBalance', 'chargeBalance', 'total_balance', 'cash_balance', 'voucher_balance',
  ])
  if (direct !== undefined) {
    const currencyRoot = roots.find((root) => typeof root.currency === 'string')
    return {
      found: true,
      amount: direct.amount,
      currency: typeof currencyRoot?.currency === 'string' ? currencyRoot.currency : null,
      detail: '直接余额字段',
    }
  }

  // ② OpenRouter 那一派：给的是「充了多少 - 用了多少」，要自己算。
  //    用**字符串十进制**算，避免浮点误差（金额只用一次简单减法，别引大数库）。
  const total = pick(['total_credits', 'totalCredits'])
  const usage = pick(['total_usage', 'totalUsage'])
  if (total !== undefined && usage !== undefined) {
    const left = subtractDecimal(total.amount, usage.amount)
    return {
      found: true,
      amount: left,
      currency: 'USD',
      detail: '充值 ' + total.amount + ' − 已用 ' + usage.amount,
    }
  }

  // ③ 认不出来：**不猜**。列出看到的字段名，方便下一个人补规则。
  // 列出**所有**候选层的字段名：数据常在 `data` 里，只看顶层会只看到 `data` 一个词，
  // 对补规则的人毫无帮助（第一版就是这样，被测试当场抓住）。
  const keys = [...new Set(roots.flatMap((root) => Object.keys(root)))].slice(0, 16)
  return { found: false, detail: '拿到了响应但没有认识的余额字段（看到的字段：' + keys.join(', ') + '）' }
}

/**
 * 十进制的「A - B」，保留到输入里出现的最多小数位。
 *
 * 为什么不用 `Number(a) - Number(b)`：金额是字符串时（各家都这么给），
 * 转浮点会造出 `0.30000000000000004` 这种数字，而它会被原样显示给用户。
 */
export function subtractDecimal(a, b) {
  const decimals = Math.min(8, Math.max(countDecimals(a), countDecimals(b)))
  const scaledA = scaleToInt(a, decimals)
  const scaledB = scaleToInt(b, decimals)
  if (scaledA === undefined || scaledB === undefined) return String(a)
  const diff = scaledA - scaledB
  const sign = diff < 0 ? '-' : ''
  const digits = String(Math.abs(diff)).padStart(decimals + 1, '0')
  if (decimals === 0) return sign + digits
  return sign + digits.slice(0, digits.length - decimals) + '.' + digits.slice(digits.length - decimals)
}

function countDecimals(value) {
  const text = String(value)
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
}

function scaleToInt(value, decimals) {
  const text = String(value).trim()
  if (!/^-?\d+(\.\d+)?$/.test(text)) return undefined
  const negative = text.startsWith('-')
  const body = negative ? text.slice(1) : text
  const [intPart, fracPart = ''] = body.split('.')
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals)
  const scaled = Number(intPart + frac)
  if (!Number.isFinite(scaled)) return undefined
  return negative ? -scaled : scaled
}

/**
 * 查一条车道的余额。
 *
 * **绝不抛**：余额是附加信息，网络失败不该影响任何主流程。
 *
 * @param {object} lane 目录条目（必须有 `balance.url`）
 * @param {{ apiKey?: string|null, fetchImpl?: Function, timeoutMs?: number, logger?: object }} [deps]
 * @returns {Promise<{
 *   ok: boolean, kind: string, reason: string, amount?: string, currency?: string|null, ms: number,
 *   status?: number, url?: string,
 * }>}
 */
export async function probeLaneBalance(lane, deps = {}) {
  const startedAt = Date.now()
  const spec = lane?.balance
  if (spec === undefined || typeof spec?.url !== 'string' || spec.url === '') {
    return { ok: false, kind: 'missing-config', reason: '这条渠道没有声明余额端点（目录里没有 balance.url）', ms: 0 }
  }
  if (lane?.retired === true) {
    return { ok: false, kind: 'missing-config', reason: '该渠道已下线，查余额没有意义', ms: 0 }
  }
  const key = typeof deps.apiKey === 'string' ? deps.apiKey.trim() : ''
  if (key === '') {
    return { ok: false, kind: 'no-key', reason: '还没有填写 key：先保存一把 key 再查余额', ms: 0 }
  }
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, kind: 'network', reason: '当前运行环境没有 fetch，无法查询', ms: 0 }
  }

  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : BALANCE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = { authorization: 'Bearer ' + key, accept: 'application/json' }
  let response
  let text = ''
  try {
    response = await fetchImpl(spec.url, { method: 'GET', headers, signal: controller.signal })
    text = typeof response.text === 'function' ? (await response.text()).slice(0, 4096) : ''
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isTimeout = error?.name === 'AbortError'
    return {
      ok: false,
      kind: isTimeout ? 'timeout' : 'network',
      reason: isTimeout
        ? '查询超时（' + String(Math.round(timeoutMs / 1000)) + ' 秒）：网络慢或上游太慢；key 本身未必有问题'
        : '请求失败：' + safeErrorText(message),
      url: spec.url,
      ms: Date.now() - startedAt,
    }
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      kind: 'invalid-key',
      reason: '上游拒绝这把 key（HTTP ' + String(response.status) + '）：换一把，或确认这个端点需要的是另一种凭据',
      url: spec.url,
      status: response.status,
      ms: Date.now() - startedAt,
    }
  }
  if (response.status === 404) {
    return {
      ok: false,
      kind: 'not-found',
      reason: '余额端点 404：目录里这条 balance.url 可能已过期',
      url: spec.url,
      status: response.status,
      ms: Date.now() - startedAt,
    }
  }
  if (response.status === 429) {
    return {
      ok: false,
      kind: 'rate-limited',
      reason: '查询被限流（429）：key 是对的，等一会再查',
      url: spec.url,
      status: response.status,
      ms: Date.now() - startedAt,
    }
  }
  if (response.status >= 500) {
    return {
      ok: false,
      kind: 'server-error',
      reason: '上游故障（HTTP ' + String(response.status) + '）：与 key 无关，稍后再试',
      url: spec.url,
      status: response.status,
      ms: Date.now() - startedAt,
    }
  }
  if (response.status !== 200) {
    return {
      ok: false,
      kind: 'bad-request',
      reason: '未预期的状态码 ' + String(response.status) + (text === '' ? '' : '：' + safeErrorText(text).slice(0, 160)),
      url: spec.url,
      status: response.status,
      ms: Date.now() - startedAt,
    }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      ok: false,
      kind: 'bad-request',
      reason: '余额端点的响应不是 JSON（多半是拦页或网关页）',
      url: spec.url,
      status: response.status,
      ms: Date.now() - startedAt,
    }
  }
  const balance = parseBalance(parsed, spec.rowKind ?? 'balance')
  if (balance.found !== true) {
    return {
      ok: false,
      kind: 'unparsed',
      reason: '拿到了响应但读不出余额：' + balance.detail,
      url: spec.url,
      status: response.status,
      ms: Date.now() - startedAt,
    }
  }
  return {
    ok: true,
    kind: 'ok',
    reason: '余额 ' + (balance.currency === null || balance.currency === undefined ? '' : balance.currency + ' ') + balance.amount,
    amount: balance.amount,
    currency: balance.currency ?? null,
    url: spec.url,
    status: response.status,
    ms: Date.now() - startedAt,
  }
}
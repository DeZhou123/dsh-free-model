/**
 * 「这条套餐车道还剩多少」—— 订阅型车道（5h / 7d 双窗）的**窗口探针**。
 *
 * ## 它解决什么
 *
 * 0.6.0 把两类**订阅套餐**车道装进了目录（kimi-coding、zai-coding-cn）：它们不按 token
 * 计费，而是「**5 小时窗 + 7 天窗**」两层限额。装进来却不说还剩多少，等于把这类车道
 * 最要紧的那条信息藏起来了 —— 用户可以连撞几十次 429 而不知道自己在等哪一层窗口。
 *
 * ## ⚠️ 形态未实测：所以「读不出来」是一条**正经结果**
 *
 * 两个端点本机都实测过**活着且要鉴权**（/coding/v1/usages → 401；
 * /api/monitor/usage/quota/limit → 200 + 鉴权错），但本机**没有这两家的订阅 key**，
 * 所以返回体的形状**没有实证**。
 *
 * 于是这里的做法与 balance.js 完全一致：
 *
 * 1. **只认明确的形状**：窗口数组 + used/limit/remaining/percentage 这几类字段名，
 *    标签按 five_hour / seven_day / 5h / 7d 识别；
 * 2. 认不出来时**不猜**，返回 unparsed 并列出**看到过的字段名**（截断）—— 这既是
 *    给用户的结论（拿到了，但读不懂），也是给我们自己的取证线索：下一个人拿着真 key
 *    一跑就能把形状写进这里；
 * 3. 绝不显示任何凭据：出口处只留窗口数字与标签。
 *
 * @module src/lanes/keyed/windows
 */

/** 默认超时：8 秒（与凭据探测、余额查询同档）。 */
export const WINDOWS_TIMEOUT_MS = 8_000

/** 窗口标签的识别顺序：先 5h 再 7d，其余按原文。 */
const LABEL_RULES = [
  { test: /(five[_-]?hour|5\s*h(?:our)?s?\b|5小时)/i, label: '5 小时窗' },
  { test: /(seven[_-]?day|7\s*d(?:ay)?s?\b|weekly|7天)/i, label: '7 天窗' },
]

/** 一个窗口对象里可能出现的字段名（不同家叫法不同）。 */
const USED_KEYS = ['used', 'usage', 'used_tokens', 'usedTokens', 'consumed', 'current', 'used_percent']
const LIMIT_KEYS = ['limit', 'total', 'quota', 'max', 'limit_tokens', 'limitTokens', 'cap', 'total_tokens']
const REMAIN_KEYS = ['remaining', 'remain', 'left', 'available', 'remaining_tokens', 'left_tokens']
const PERCENT_KEYS = ['percentage', 'percent', 'used_percentage', 'usage_percent', 'ratio', 'used_ratio']
const RESET_KEYS = ['reset_at', 'resetAt', 'resets_at', 'renew_at', 'reset_time', 'next_reset_at', 'expires_at']

/** 取第一个「像数字」的字段（字符串数字也算；空串/非数字跳过）。 */
function pickNumber(source, keys) {
  if (source === null || typeof source !== 'object') return undefined
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw)
  }
  return undefined
}

/** 取第一个「像时间」的字段，规整成 ISO 字符串（认不出就 undefined）。 */
function pickTime(source, keys) {
  if (source === null || typeof source !== 'object') return undefined
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      // 秒还是毫秒：> 1e12 当毫秒，否则当秒（上游两种都见过）
      const ms = raw > 1e12 ? raw : raw * 1000
      const at = new Date(ms)
      if (!Number.isNaN(at.getTime())) return at.toISOString()
    }
    if (typeof raw === 'string' && raw.trim() !== '') {
      const at = new Date(raw)
      if (!Number.isNaN(at.getTime())) return at.toISOString()
    }
  }
  return undefined
}

/** 标签：先在对象自己的字段里找 5h/7d 的线索，找不到再用外层 key/序号兜底。 */
function labelOf(source, fallbackIndex, outerKey) {
  const hints = []
  for (const field of ['name', 'label', 'type', 'window', 'period']) {
    if (typeof source?.[field] === 'string') hints.push(source[field])
  }
  if (typeof outerKey === 'string') hints.push(outerKey)
  const text = hints.join(' ')
  for (const rule of LABEL_RULES) {
    if (rule.test.test(text)) return rule.label
  }
  return '窗口 ' + String(fallbackIndex + 1)
}

/** 从候选对象里抠出一个窗口；没有任何数字字段就返回 undefined。 */
function readWindow(source, fallbackIndex, outerKey) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined
  const used = pickNumber(source, USED_KEYS)
  const limit = pickNumber(source, LIMIT_KEYS)
  const remaining = pickNumber(source, REMAIN_KEYS)
  const percent = pickNumber(source, PERCENT_KEYS)
  if (used === undefined && limit === undefined && remaining === undefined && percent === undefined) return undefined
  const resetAt = pickTime(source, RESET_KEYS)
  return {
    label: labelOf(source, fallbackIndex, outerKey),
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(percent === undefined ? {} : { percent }),
    ...(resetAt === undefined ? {} : { resetAt }),
  }
}

/**
 * 在响应体里找「一组窗口」。
 *
 * 遍历前两层容器（body、body.data、body.result 及其常见子键），
 * 遇到数组就把每个对象读成窗口，遇到对象先看它自身是不是窗口，
 * 再看它的每个键（键名常常就是窗口名：five_hour / seven_day / limit_5h）。
 */
function collectWindows(body) {
  const found = []
  const containers = []
  const push = (value, path) => {
    if (value === null || typeof value !== 'object') return
    containers.push({ value, path })
  }
  push(body, '')
  const first = body && typeof body === 'object' ? (body.data ?? body.result ?? body.payload) : undefined
  push(first, 'data')
  if (first !== null && typeof first === 'object') {
    push(first.data ?? first.result ?? first.limits ?? first.windows ?? first.usages ?? first.quotas ?? first.quota, 'data.*')
  }
  push(body?.limits ?? body?.windows ?? body?.usages ?? body?.quotas ?? body?.quota, '')

  for (const { value, path } of containers) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const win = readWindow(item, found.length, undefined)
        if (win !== undefined) found.push({ ...win, path })
      }
      continue
    }
    const direct = readWindow(value, found.length, undefined)
    if (direct !== undefined) {
      found.push({ ...direct, path })
      continue
    }
    for (const [key, item] of Object.entries(value ?? {})) {
      const win = readWindow(item, found.length, key)
      if (win !== undefined) found.push({ ...win, path: path === '' ? key : path + '.' + key })
    }
  }
  return found
}

/** 字段名清单一律截断到 16 个，免得把一整份响应贴给用户。 */
function shapeHint(body) {
  const names = new Set()
  const visit = (value, depth) => {
    if (depth > 2 || value === null || typeof value !== 'object') return
    for (const key of Object.keys(value)) {
      names.add(key)
      visit(value[key], depth + 1)
    }
  }
  visit(body, 0)
  return [...names].slice(0, 16).join(', ')
}

/**
 * 解析响应体。**不抛**。
 *
 * @param {unknown} body 响应 JSON
 * @returns {{ found: boolean, windows: object[], detail: string }}
 */
export function parseWindows(body) {
  if (body === null || typeof body !== 'object') return { found: false, windows: [], detail: '响应不是 JSON 对象' }
  const windows = collectWindows(body)
  if (windows.length === 0) {
    return { found: false, windows: [], detail: '拿到了响应但没有认识的窗口字段（看到的字段：' + shapeHint(body) + '）' }
  }
  return { found: true, windows, detail: '识别到 ' + String(windows.length) + ' 个窗口' }
}

/** 一个窗口 → 一行中文（页面直接显示）。 */
export function describeWindow(win) {
  const parts = []
  if (typeof win?.used === 'number' && typeof win?.limit === 'number') parts.push('已用 ' + String(win.used) + '/' + String(win.limit))
  else if (typeof win?.limit === 'number') parts.push('上限 ' + String(win.limit))
  else if (typeof win?.used === 'number') parts.push('已用 ' + String(win.used))
  if (typeof win?.remaining === 'number') parts.push('剩余 ' + String(win.remaining))
  if (typeof win?.percent === 'number') parts.push(String(win.percent) + '%')
  if (typeof win?.resetAt === 'string') parts.push('重置于 ' + win.resetAt)
  return parts.length === 0 ? '（没有可读的数字）' : parts.join(' · ')
}

/**
 * 查一条车道的套餐窗口。**绝不抛**：窗口是附加信息，失败只给一句原因。
 *
 * @param {object} lane 目录条目（需要有 windows.url）
 * @param {{ apiKey?: string|null, fetchImpl?: Function, timeoutMs?: number }} [deps]
 */
export async function probeLaneWindows(lane, deps = {}) {
  const startedAt = Date.now()
  const spec = lane?.windows
  if (spec === undefined || typeof spec?.url !== 'string' || spec.url === '') {
    return { ok: false, kind: 'missing-config', reason: '这条渠道没有声明套餐窗口端点（目录里没有 windows.url）', ms: 0 }
  }
  const key = typeof deps.apiKey === 'string' ? deps.apiKey.trim() : ''
  if (key === '') {
    return { ok: false, kind: 'no-key', reason: '还没有填写 key：套餐窗口要用 key 去问', ms: 0 }
  }
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, kind: 'network', reason: '当前运行环境没有 fetch，无法查询', ms: 0 }
  }
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : WINDOWS_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  let text = ''
  try {
    response = await fetchImpl(spec.url, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      signal: controller.signal,
    })
    text = typeof response.text === 'function' ? (await response.text()).slice(0, 8192) : ''
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const aborted = error?.name === 'AbortError'
    return {
      ok: false,
      kind: aborted ? 'timeout' : 'network',
      reason: aborted
        ? '查询超时（' + String(Math.round(timeoutMs / 1000)) + ' 秒）：网络慢或上游太慢；key 本身未必有问题'
        : '请求失败：' + message.slice(0, 200),
      url: spec.url,
      ms: Date.now() - startedAt,
    }
  } finally {
    clearTimeout(timer)
  }

  const status = response.status
  if (status === 401 || status === 403) {
    return { ok: false, kind: 'invalid-key', reason: '上游拒绝这把 key（HTTP ' + String(status) + '）：套餐窗口端点要求**套餐专用 key**（拿按量 key 会 401）', url: spec.url, status, ms: Date.now() - startedAt }
  }
  if (status === 404) {
    return { ok: false, kind: 'not-found', reason: '窗口端点 404：目录里这条 windows.url 可能已过期，或该套餐不提供这个接口', url: spec.url, status, ms: Date.now() - startedAt }
  }
  if (status === 429) {
    return { ok: false, kind: 'rate-limited', reason: '查询被限流（429）：等一会再查', url: spec.url, status, ms: Date.now() - startedAt }
  }
  if (status >= 500) {
    return { ok: false, kind: 'server-error', reason: '上游故障（HTTP ' + String(status) + '）：与 key 无关，稍后再试', url: spec.url, status, ms: Date.now() - startedAt }
  }
  if (status !== 200) {
    return { ok: false, kind: 'bad-request', reason: '未预期的状态码 ' + String(status), url: spec.url, status, ms: Date.now() - startedAt }
  }

  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, kind: 'bad-request', reason: '窗口端点的响应不是 JSON（多半是拦页或网关页）', url: spec.url, status, ms: Date.now() - startedAt }
  }
  const parsed = parseWindows(body)
  if (parsed.found !== true) {
    return { ok: false, kind: 'unparsed', reason: '拿到了响应但读不出套餐窗口：' + parsed.detail, url: spec.url, status, ms: Date.now() - startedAt }
  }
  return {
    ok: true,
    kind: 'ok',
    reason: parsed.windows.map((win) => win.label + '：' + describeWindow(win)).join('；'),
    windows: parsed.windows,
    url: spec.url,
    status,
    ms: Date.now() - startedAt,
  }
}

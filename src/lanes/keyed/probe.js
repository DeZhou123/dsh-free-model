/**
 * 「这把 key 到底行不行」—— 自带 key 车道的**凭据探测**。
 *
 * ## 为什么值得单独做（页面原来刻意不放「测试连通性」）
 *
 * 旧页面（见 `client.js` 里 KeyedCard 的注释）不放测试按钮，理由成立：
 * **没有 key 的车道点下去必然失败**，而失败会被读成「这条渠道不可用」——结论完全错了。
 *
 * 但那条理由只对「没 key」成立。用户把 key 粘进来之后，最想知道的就是
 * 「我填对了没有」，而这时候页面上没有任何办法回答他 —— 只能去会话里选一个模型、
 * 发一句话、看报错。所以这里加探测，并加**三条限制**，让旧理由不再成立：
 *
 * 1. 没有 key 时**不构造请求**（`no-key`），也就不会产生「渠道坏了」的错觉；
 * 2. 结果按 `kind` 分类（401 / 403 / 429 / 网络 / 超时各自不同文案），
 *    401 说的是「key 不对」，429 说的是「限流」——**都不是「渠道不可用」**；
 * 3. 只回答「凭据能不能通过鉴权」，不回答「这条车道能不能写代码」。
 *
 * ## 探什么
 *
 * 优先 `GET {baseURL}/models`：最便宜（多数渠道免费），且 401/403 与 200 的
 * 语义最干净。渠道声明了 `supportsModelList: false`（或给了 `modelsURL`）时
 * 按它的地址探。两条都拿不到时退回一次**最小**的 `chat/completions`（1 token），
 * 那是最后一次尝试 —— 部分渠道的 `/models` 需要额外权限。
 *
 * ## 硬纪律：不泄漏 key
 *
 * 请求头里的 key 不进任何返回值/错误文案；`preview` 只保留**模型名**。
 * 上游的错误体可能回显部分 key，故只取前 200 字符并先做一次遮蔽。
 *
 * @module src/lanes/keyed/probe
 */

import { PROBE_TIMEOUT_MS } from './keys.js'
import { staticModels } from './catalog.js'

/** 网络失败的三档提示（与 `keys.js` 的 PROBE_KINDS 同一份语义）。 */
const NETWORK_HINTS = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPROTO|certificate|CERT_/i
/** DNS 解析失败：地址根本不存在（域名字写错 / 本地 DNS 挂了）。 */
const DNS_HINTS = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i
/**
 * TLS/证书失败。
 *
 * ⚠️ 2026-10-26 补（审计的 P1-6）：原来它与 DNS 一起被压成 \'network\'，
 * 给出的处置文案是「国内直连渠道一般不需要代理」—— 对证书错误是**方向错**的建议：
 * 证书错多半是企业代理做了 MITM、系统时间不对、或代理自己签发了一张链不完整的证书，
 * 这时候该查的是代理与证书链，跟'要不要代理'是两件事。
 */
const TLS_HINTS = /certificate|CERT_|self[- ]signed|UNABLE_TO_VERIFY|ERR_TLS|SSL/i

/**
 * 挑这次探测要打哪个地址。
 *
 * @param {object} lane
 * @returns {{ url: string, mode: 'models'|'chat' }}
 */
export function probeTargetFor(lane) {
  const base = String(lane?.baseURL ?? '').replace(/\/+$/, '')
  if (typeof lane?.modelsURL === 'string' && lane.modelsURL !== '') {
    return { url: lane.modelsURL, mode: 'models' }
  }
  if (lane?.supportsModelList === false) {
    // 没有标准 /models 的渠道：直接问一次最小补全。
    return { url: base + '/chat/completions', mode: 'chat' }
  }
  return { url: base + '/models', mode: 'models' }
}

/**
 * 把 HTTP 状态与错误体翻译成页面上那一句话。
 *
 * @param {{ status?: number, bodyText?: string, mode: string }} input
 * @returns {{ kind: string, ok: boolean, reason: string }}
 */
export function classifyProbe(input) {
  const status = input.status
  const detail = summarizeBody(input.bodyText)
  if (status === 200 || status === 204) {
    return { kind: 'ok', ok: true, reason: 'key 通过鉴权：上游接受了这把 key' }
  }
  if (status === 401) {
    return { kind: 'invalid-key', ok: false, reason: '上游拒绝这把 key（401）' + (detail === '' ? '' : '：' + detail) }
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      ok: false,
      reason: 'key 有效但**这个接口/模型**没权限（403）'
        + (detail === '' ? '' : '：' + detail)
        + '；常见原因：未开通该模型、区域限制、或该端点要求 Organization 头。',
    }
  }
  if (status === 402) {
    return { kind: 'quota', ok: false, reason: '上游要钱 / 额度不足（402）' + (detail === '' ? '' : '：' + detail) }
  }
  if (status === 404) {
    return {
      kind: 'not-found',
      ok: false,
      reason: input.mode === 'models'
        ? '该渠道没有 ' + '/models 端点（404）——这不代表 key 无效，换一次补全探测更能说明问题。'
        : '端点不存在（404）：目录里的 baseURL 可能已过期。',
    }
  }
  if (status === 429) {
    return { kind: 'rate-limited', ok: false, reason: '上游限流（429）：key 是对的，等一会儿再试' + (detail === '' ? '' : '：' + detail) }
  }
  if (status === 400 || status === 422) {
    return { kind: 'bad-request', ok: false, reason: '请求被拒（' + String(status) + '）：key 通常没问题，参数或模型名不对' + (detail === '' ? '' : '：' + detail) }
  }
  if (typeof status === 'number' && status >= 500) {
    return { kind: 'server-error', ok: false, reason: '上游故障（' + String(status) + '）：与 key 无关，稍后再试' + (detail === '' ? '' : '：' + detail) }
  }
  return { kind: 'server-error', ok: false, reason: '未预期的状态码 ' + String(status ?? '?') + (detail === '' ? '' : '：' + detail) }
}

/**
 * 探测一条车道的 key。
 *
 * @param {object} lane 目录条目
 * @param {{
 *   apiKey?: string|null,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   logger?: object,
 * }} deps
 * @returns {Promise<{
 *   ok: boolean, kind: string, reason: string, url?: string, mode?: string,
 *   status?: number, ms: number, models?: string[], modelSource?: string,
 *   retryAfterMs?: number,
 * }>}
 */
export async function probeLaneKey(lane, deps = {}) {
  const startedAt = Date.now()
  const key = typeof deps.apiKey === 'string' ? deps.apiKey.trim() : ''
  if (lane === null || typeof lane !== 'object') {
    return { ok: false, kind: 'missing-config', reason: '没有车道描述（lane 为空）', ms: 0 }
  }
  if (lane.retired === true) {
    return {
      ok: false,
      kind: 'missing-config',
      reason: '该渠道已下线' + (typeof lane.retiredOn === 'string' ? '（' + lane.retiredOn + '）' : '') + '：探测没有意义',
      ms: 0,
    }
  }
  if (lane.kind !== 'keyed') {
    return { ok: false, kind: 'missing-config', reason: '这条车道不需要 key（免 key 直连），无需探测', ms: 0 }
  }
  if (key === '') {
    return { ok: false, kind: 'no-key', reason: '还没有填写 key：先保存一把 key 再探测', ms: 0 }
  }
  const target = probeTargetFor(lane)
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, kind: 'network', reason: '当前运行环境没有 fetch，无法探测', ms: Date.now() - startedAt }
  }
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : PROBE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = {
    authorization: 'Bearer ' + key,
    accept: 'application/json',
  }
  let init
  if (target.mode === 'chat') {
    const model = staticModels(lane)[0]?.id ?? ''
    headers['content-type'] = 'application/json'
    init = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    }
  } else {
    init = { method: 'GET', headers, signal: controller.signal }
  }

  let response
  let bodyText = ''
  try {
    response = await fetchImpl(target.url, init)
    // 错误体只读前 4KB：足够分类，也不会把一个大 HTML 错误页读进内存。
    bodyText = typeof response.text === 'function' ? (await response.text()).slice(0, 4096) : ''
  } catch (error) {
    clearTimeout(timer)
    const signal = error?.name === 'AbortError'
    const text = error instanceof Error ? error.message : String(error)
    if (signal) {
      return {
        ok: false,
        kind: 'timeout',
        reason: '探测超时（' + String(Math.round(timeoutMs / 1000)) + ' 秒）：网络不通或上游太慢；key 本身未必有问题',
        url: target.url,
        mode: target.mode,
        ms: Date.now() - startedAt,
      }
    }
    // 三档分开报：DNS 是「这个名字不存在」、TLS 是「握手不信任」、其余是「连得上但没通」。
    // 合成一个 kind 会让用户拿着错误的下一步去折腾（见上面的 TLS_HINTS 注释）。
    const kind = DNS_HINTS.test(text) ? 'dns' : TLS_HINTS.test(text) ? 'tls' : 'network'
    const lead = kind === 'dns'
      ? '域名解析不了（DNS）：检查拼写与本机 DNS'
      : kind === 'tls'
        ? 'TLS 握手失败（证书/代理）：检查代理与证书链，不是 key 的问题'
        : (NETWORK_HINTS.test(text) ? '连不上上游' : '请求失败')
    return {
      ok: false,
      kind,
      reason: lead + '：' + text.slice(0, 200),
      url: target.url,
      mode: target.mode,
      ms: Date.now() - startedAt,
    }
  } finally {
    clearTimeout(timer)
  }

  const classified = classifyProbe({ status: response.status, bodyText, mode: target.mode })
  const out = {
    ok: classified.ok,
    kind: classified.kind,
    reason: classified.reason,
    url: target.url,
    mode: target.mode,
    status: response.status,
    ms: Date.now() - startedAt,
  }
  const retryAfter = Number(response.headers?.get?.('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) out.retryAfterMs = Math.round(retryAfter * 1000)

  // 成功时顺手把上游模型目录抄一份回来：用户填完 key 之后最该看到的就是「能调哪些」。
  if (classified.ok && target.mode === 'models') {
    const ids = parseModelIds(bodyText)
    if (ids.length > 0) {
      out.models = ids.slice(0, 60)
      out.modelSource = 'live'
    }
  }
  return out
}

/** 从 `/models` 响应里抄 id；解析失败返回空数组（探测成功与否不取决于它）。 */
function parseModelIds(text) {
  try {
    const parsed = JSON.parse(text)
    const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : Array.isArray(parsed) ? parsed : []
    const ids = []
    for (const row of rows) {
      const id = typeof row === 'string' ? row : (typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : '')
      if (id !== '' && !ids.includes(id)) ids.push(id)
    }
    return ids
  } catch {
    return []
  }
}

/**
 * 上游错误体摘要：折行压平、截断、并**先遮蔽疑似 key**。
 *
 * 上游把「你提交的 key 是 ...xyz」写进错误体是常见行为（尤其国内渠道的
 * 中文鉴权错），原样显示等于把用户凭据贴到页面上。
 */
function summarizeBody(text) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  const flattened = text.replace(/\s+/g, ' ').trim()
  // 遮蔽长 token：连续 20+ 的 base64url/十六进制片段，只留首尾。
  const masked = flattened.replace(/[A-Za-z0-9_\-]{20,}/g, (match) => match.slice(0, 4) + '…' + match.slice(-2))
  return masked.slice(0, 200)
}

/**
 * 插件 HTTP 路由的信任围栏。
 *
 * ## 为什么必须有
 *
 * 本插件注册的前缀比内核的 `/api` 长，而 webServer 的派发是
 * **最长前缀优先**（`dsh-host-webserver` 的 `register()` 把 exact 与 prefix
 * 分两张表，命中时取最长的那个）—— 于是这些路由跑在 connection 服务自己的
 * 准入检查**之前**，否则任何本机调用方都能拿到账号列表。
 *
 * 两层，按顺序试：
 *
 * 1. composition 挂载了 `connection` 服务时 —— 用**内核同一条**准入判定
 *    （信任围栏 + 浏览器鉴权 cookie），插件因此永远不会比应用本身更松；
 * 2. 没有该服务的 composition —— 结构化副本：仅回环主机、禁跨站 fetch、
 *    客户端给了 Origin/Referer 时其 authority 必须与 Host 一致，
 *    另加一条桌面端 `dsh-app://app` 中继 Referer 的窄例外。
 *
 * @module src/trust
 */

/** Hostnames a same-machine caller can legitimately use. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/**
 * 把 connection 服务包成「准入视图」。
 *
 * 组合可能在插件加载**之后**才发布 `connection`，故这里收**thunk** 而不是服务
 * 本身：一次读取会把「尚未提供」固化成永久缺失。
 *
 * ⚠️ 0.1.7 之前的宿主把同一判定发布成 `requestRejection`（返回裸状态码）。
 * 那个拼写的返回值不是 `{rejection}` 信封，必须在这里**包成信封** ——
 * 裸值传下去会被上层读成「没有拒绝」，等于把宿主的鉴权关掉。
 *
 * @param {object|(() => object|undefined)} service
 * @returns {{ admit: ((req: object) => ({rejection: number}|undefined)) | undefined }}
 */
export function connectionAdmissionView(service) {
  return {
    get admit() {
      const current = typeof service === 'function' ? service() : service
      if (current === undefined) return undefined
      if (typeof current.admit !== 'function' && typeof current.requestRejection === 'function') {
        return (req) => {
          const status = current.requestRejection(req)
          return status === undefined ? undefined : { rejection: status }
        }
      }
      return (req) => current.admit(req)
    },
  }
}

/**
 * 判定一个请求。返回要拒绝用的 HTTP 状态码，或 `undefined` 表示放行。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object|undefined} connection
 * @param {(decision: {status: number, source: string, reason: string}) => void} [onRejection]
 * @returns {number|undefined}
 */
export function rejectionFor(req, connection, onRejection) {
  let decision
  try {
    const admit = connection?.admit
    if (typeof admit === 'function') {
      const admission = admit.call(connection, req)
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined
      if (status === undefined) return undefined
      decision = { status, source: 'connection', reason: 'host-rejected' }
    } else {
      const reject = connection?.requestRejection
      if (typeof reject === 'function') {
        const status = reject.call(connection, req)
        if (status === undefined) return undefined
        decision = { status, source: 'connection', reason: 'host-rejected' }
      }
    }
  } catch {
    // 已挂载的 Host 服务出错时**绝不**绕过浏览器鉴权。
    decision = { status: 503, source: 'connection', reason: 'admission-error' }
  }
  if (decision === undefined) {
    const reason = structuralReason(req)
    if (reason === undefined) return undefined
    decision = { status: 403, source: 'structural', reason }
  }
  try {
    onRejection?.(decision)
  } catch {
    // 诊断是观测性的，不能改变 HTTP 判定。
  }
  return decision.status
}

/**
 * 结构化副本围栏：与内核对 `/api` 的 `isTrustedApiRequest` 同形 ——
 * Host 头挡 DNS rebinding、拒跨站 fetch、Origin/Referer 的 authority 必须匹配。
 */
export function structuralRejection(req) {
  return structuralReason(req) === undefined ? undefined : 403
}

/** 返回固定原因串，绝不回显调用方提供的字符串。 */
function structuralReason(req) {
  const host = authorityOf(req.headers.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 'host-not-loopback'
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 'cross-site'
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    if (header === 'referer' && isDesktopRelayReferer(raw)) {
      // 桌面端 forwardWebRequest 转发到 HTTP 回环前会剥掉两个浏览器标记，
      // 但保留这个 Referer。它不是 Origin 授权，也绝不覆盖已挂载 Host 的判定。
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) return 'desktop-relay-markers'
      continue
    }
    const authority = authorityOf(raw.trim())
    if (authority === null) return `${header}-invalid`
    // Web 服务在回环上说的是明文 http，故声称 https 的 Origin 不是本页。
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) {
      return `${header}-mismatch`
    }
  }
  return undefined
}

/** 只认自有应用页，不认任意自定义协议页。 */
function isDesktopRelayReferer(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh-app:' && url.hostname === 'app' && url.port === ''
      && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/** 把 Host/Origin/Referer 拆成 {scheme, hostname, port}（缺省端口按协议补）。 */
function authorityOf(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

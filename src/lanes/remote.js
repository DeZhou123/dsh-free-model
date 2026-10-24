/**
 * 远程渠道目录的拉取、缓存与校验。
 *
 * ## 这一层解决什么
 *
 * 「免费渠道会变」是这类插件的**核心不确定性**。上游今天多给一个免费模型、明天换掉
 * 一个域名，用户不该为此等一次插件发版。所以渠道数据要能**远程更新**。
 *
 * 但把公网数据接进运行时，最先要回答的是三个安全问题：
 *
 * 1. **来源可信吗** —— 只允许 https，且默认只认本插件仓库的 raw 地址；
 *    用户改地址可以（`catalog.url` 配置项），但改了之后页面会显示来源，责任清楚。
 * 2. **是数据还是代码** —— 严格要求 JSON **纯数据**。本模块不 eval、不 import、
 *    不把目录里的字符串当路径或命令用。目录里能影响运行时的只有「渠道元数据」本身。
 * 3. **坏了会不会拖垮插件** —— 不会。任何一步失败都退化成「用上一份缓存 / 用随包目录」，
 *    并把原因原样返回给页面。**远程目录是增强，不是依赖**。
 *
 * 缓存文件放在 `$DSH_HOME/free-model/catalog-cache.json`：它只是数据，
 * 不含凭据，故与 channel-pack 的状态文件同一层级（DSH home 根下）。
 *
 * @module src/lanes/remote
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CATALOG_FORMAT_VERSION, MAX_REMOTE_CATALOG_BYTES } from './catalog.js'

/** 默认远程目录地址（本插件仓库的 raw；改版式时这个文件同步改）。 */
export const DEFAULT_CATALOG_URL =
  'https://raw.githubusercontent.com/DeZhou123/dsh-free-model/main/catalog/channels.json'

/** 缓存有效期：6 小时。目录变化以「天」为单位，没必要每次开页面都打网络。 */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

/** 网络超时：目录是一份静态 JSON，8 秒足够；再久就是网络本身有问题。 */
const FETCH_TIMEOUT_MS = 8_000

/** 缓存文件路径（DSH home 根下，与其他插件状态文件同级）。 */
export function catalogCacheFile(dshHome) {
  return join(dshHome, 'free-model', 'catalog-cache.json')
}

/**
 * 拉取远程目录。
 *
 * 失败**不抛**：把「为什么没拿到」写进返回值，让页面有话可说。调用方永远拿得到一个对象。
 *
 * ## `token`：私有仓库的那条路
 *
 * 本插件的仓库默认是**私有**的（用户约定：自研插件默认 private），而
 * `raw.githubusercontent.com/<owner>/<repo>/…` 对私有仓库一律 **404** ——
 * 所以「远程目录」这个能力在私有仓库上**默认就是不可用的**，本机实测确认过。
 * 失败会被优雅降级（退到随包数据），所以不会坏事；但「加渠道不用发版」这句承诺就落不了地。
 *
 * 三条可行的路，按代价排序：
 *
 * | 路 | 怎么做 | 代价 |
 * |---|---|---|
 * | ① 把目录放到公开位置 | 公开 Gist / 自己的静态站点，`catalog.url` 指过去 | 目录内容会公开（里面没有凭据，只有渠道元数据） |
 * | ② 给 token（本函数的 `token`） | 凭据里放 `GITHUB_TOKEN`（只读 fine-grained token 即可） | 用户要建一个 token |
 * | ③ 仓库转公开 | 用户的决定，不由插件代做 | —— |
 *
 * token **只走请求头**，绝不写进 URL、绝不落盘、绝不出现在返回值里（返回值可能被页面显示）。
 *
 * @param {{
 *   url?: string,
 *   cacheFile?: string,
 *   ttlMs?: number,
 *   force?: boolean,
 *   fetchImpl?: typeof fetch,
 *   token?: string,
 *   now?: () => number,
 *   logger?: { warn?: (m: string) => void },
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean, from: 'network'|'cache'|'none', url: string,
 *   fetchedAt: number, catalogVersion: number|null, channels: unknown[],
 *   sha256: string|null, reason: string, needsToken: boolean,
 * }>}
 */
export async function fetchRemoteCatalog(options = {}) {
  const url = typeof options.url === 'string' && options.url.trim() !== ''
    ? options.url.trim()
    : DEFAULT_CATALOG_URL
  const now = options.now ?? (() => Date.now())
  const ttlMs = Number.isFinite(options.ttlMs) ? Number(options.ttlMs) : DEFAULT_TTL_MS
  const logger = options.logger

  // 0) 非 https 直接不拉：明文信道上的目录等于谁都能改，宁可不要这个功能。
  if (!/^https:/i.test(url)) {
    return failure('none', url, 'catalog.url 必须是 https（明文信道上的渠道目录谁都能改）')
  }

  const cached = options.cacheFile === undefined ? undefined : readCache(options.cacheFile)

  // 1) 缓存还新鲜且没被要求强制刷新 → 直接用缓存，不打扰网络。
  if (options.force !== true && cached !== undefined && now() - cached.fetchedAt < ttlMs && cached.url === url) {
    return success('cache', url, cached)
  }

  // 2) 真去拉。
  //
  // ⚠️ 用 `=== undefined` 而不是 `??`：显式传 `null` 表示「这个运行时没有 fetch」，
  // 是一个**有意的接缝**（离线/受限运行时、单测要断言无 fetch 时的降级行为）。
  // 用 `??` 会把 null 也当成「没传」，于是接缝失效、测试反而打真网络。
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl
  if (typeof fetchImpl !== 'function') {
    return cached !== undefined
      ? success('cache', url, cached, '运行时没有 fetch，改用缓存')
      : failure('none', url, '运行时没有 fetch，且没有可用缓存')
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let response
    try {
      const token = typeof options.token === 'string' ? options.token.trim() : ''
      response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'dsh-free-model-catalog',
          // token 只进请求头：URL 会进日志与返回值（页面会显示来源），头不会。
          ...(token !== '' ? { authorization: `Bearer ${token}` } : {}),
        },
      })
    } finally {
      clearTimeout(timer)
    }
    if (response?.ok !== true) {
      // 404 + 私有仓库 + 没有 token —— 这是最可能的一种组合，值得单独说清，
      // 否则用户只会看到「HTTP 404 拉取目录失败」并以为插件坏了。
      const hint = response?.status === 404 && options.token === undefined
        ? '（404 常见原因：仓库是私有的，而 raw.githubusercontent.com 对私有仓库一律 404。'
          + '三条路：把目录放到公开位置并改 catalog.url / 在凭据里放 GITHUB_TOKEN / 把仓库转公开）'
        : ''
      return fallbackOr(cached, url, `HTTP ${response?.status ?? '?'} 拉取目录失败${hint}`, response?.status === 404 && options.token === undefined)
    }
    const text = await response.text()
    const parsed = parseCatalogBody(text)
    if (!parsed.ok) return fallbackOr(cached, url, parsed.reason)
    const payload = {
      url,
      fetchedAt: now(),
      catalogVersion: parsed.catalogVersion,
      channels: parsed.channels,
      sha256: sha256(text),
    }
    if (options.cacheFile !== undefined) writeCache(options.cacheFile, payload, logger)
    return success('network', url, payload)
  } catch (error) {
    // 网络/超时/解析异常都走这里：退化成缓存，并如实报告原因。
    return fallbackOr(cached, url, `拉取目录失败：${error instanceof Error ? error.message : String(error)}`)
  }

  function fallbackOr(cacheEntry, targetUrl, reason, needsToken = false) {
    if (cacheEntry !== undefined) return success('cache', targetUrl, cacheEntry, reason)
    return failure('none', targetUrl, reason, needsToken)
  }
}

/**
 * 解析远程目录正文。
 *
 * 单独的纯函数（不碰网络、不碰磁盘），单测可以直接喂字符串断言每一条拒绝理由。
 *
 * @returns {{ ok: true, catalogVersion: number, channels: unknown[] } | { ok: false, reason: string }}
 */
export function parseCatalogBody(text) {
  if (typeof text !== 'string') return { ok: false, reason: '目录正文不是文本' }
  // ⚠️ 上限是按**字节**定的（远程拉取与落盘都按字节算），所以这里必须量 UTF-8 字节数，
  // 不能用 `text.length`（那是 UTF-16 码元数）。中文渠道名一个字符占 3 字节，
  // 用字符数比会把「已超限」的目录放进来（2026-10-25 复核发现 32,295 字符 / 36,621 字节的混淆）。
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_REMOTE_CATALOG_BYTES) {
    return { ok: false, reason: `目录正文超过 ${MAX_REMOTE_CATALOG_BYTES} 字节上限（${bytes} 字节）` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `目录不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: '目录顶层必须是对象' }
  }
  const version = parsed.catalogVersion
  if (version !== CATALOG_FORMAT_VERSION) {
    // ⚠️ 不认识的格式版本**整份拒绝**，不猜着读：半份目录会让渠道莫名消失，
    // 那种「时有时无」最难查。
    return {
      ok: false,
      reason: `目录格式版本 ${String(version)} 与本插件（${CATALOG_FORMAT_VERSION}）不一致，整份忽略`,
    }
  }
  if (!Array.isArray(parsed.channels)) return { ok: false, reason: '目录缺少 channels 数组' }
  return { ok: true, catalogVersion: version, channels: parsed.channels }
}

/** 读缓存（不存在/坏了都返回 undefined，绝不抛）。 */
export function readCache(cacheFile) {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    if (typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.channels)) return undefined
    if (parsed.catalogVersion !== CATALOG_FORMAT_VERSION) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * 原子写缓存（先写临时文件再 rename）。
 *
 * ⚠️ 不能直接覆盖：DsH 可能有两个插件实例（多窗口）同时刷新目录，
 * 直接覆盖会留下半截 JSON，下一次读到就当成「缓存坏了」。
 */
export function writeCache(cacheFile, payload, logger) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true })
    const tmp = `${cacheFile}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, cacheFile)
    return true
  } catch (error) {
    logger?.warn?.(`[dsh-free-model] 写入渠道目录缓存失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function success(from, url, payload, reason = '') {
  return {
    ok: true,
    needsToken: payload.needsToken === true,
    from,
    url,
    fetchedAt: payload.fetchedAt,
    catalogVersion: payload.catalogVersion ?? CATALOG_FORMAT_VERSION,
    channels: payload.channels,
    sha256: payload.sha256 ?? null,
    reason,
  }
}

function failure(from, url, reason, needsToken = false) {
  return { ok: false, needsToken, from, url, fetchedAt: 0, catalogVersion: null, channels: [], sha256: null, reason }
}
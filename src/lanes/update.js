/**
 * 插件自身的版本检查（「方便升级」那一半）。
 *
 * ## 两类「迭代」要分清楚
 *
 * | 想改的东西 | 走哪条路 | 用户要做什么 |
 * |---|---|---|
 * | **渠道目录**（多一个免费渠道、换个域名） | 远程目录（`src/lanes/remote.js`） | 什么都不用做，点一下「检查目录」也行 |
 * | **插件代码**（新车道类型、新能力） | 本文件：版本检查 + 升级指引 | 复制一条命令（或在 dshmarket 里点更新） |
 *
 * 把这两件事混在一起是很多插件的通病：渠道数据的小变化逼用户升级整个插件。
 * 这里刻意分开 —— 目录能撑住的就不动代码。
 *
 * ## 为什么用 raw package.json 而不是 GitHub Releases API
 *
 * - **不收限**：未鉴权的 api.github.com 是 60 次/小时/IP，一个开着设置页的用户
 *   反复点检查就会把自己打限流；raw 没有这个限制。
 * - **更准确**：`main` 分支的 `package.json` 就是「此刻仓库里的版本」，
 *   而 Releases 常常落后（不是每个提交都发 Release）。
 * - **更简单**：一个 GET 拿一个字段，不用处理 release 的各种形状。
 *
 * 代价是拿不到 release notes。所以界面上只承诺「有新版本 + 去哪看」，
 * 承诺不了「新版本改了什么」—— 宁可少说，不要编。
 *
 * ## 失败即静默：版本检查是**增强**，不是依赖
 *
 * 没有网络、GitHub 被墙、raw 超时 —— 全部返回 `ok:false` 并把原因写清，
 * 绝不抛、绝不让设置页因此打不开。本机实测 `github.com:443` 直连不通（要走代理），
 * 所以这条路径**默认就是会失败的** —— 更要把失败表现得无害。
 *
 * @module src/lanes/update
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 默认仓库（与 `package.json` 的 repository 一致）。 */
export const DEFAULT_REPO = 'DeZhou123/dsh-free-model'

/** 检查结果缓存：6 小时。版本以天为单位变化，没必要每次开页面都打网络。 */
export const UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** 超时 8 秒：网络不通时不能把设置页卡住。 */
const FETCH_TIMEOUT_MS = 8_000

/** 缓存文件（DSH home 根下，与目录缓存同级）。 */
export function updateCacheFile(dshHome) {
  return join(dshHome, 'free-model', 'update-check.json')
}

/**
 * 检查是否有新版本。
 *
 * @param {{
 *   repo?: string,
 *   currentVersion: string,
 *   fetchImpl?: typeof fetch,
 *   cacheFile?: string,
 *   ttlMs?: number,
 *   force?: boolean,
 *   now?: () => number,
 * }} options
 * @returns {Promise<{
 *   ok: boolean, current: string, latest: string|null, updateAvailable: boolean,
 *   checkedAt: number, from: 'network'|'cache'|'none', reason: string,
 *   repoUrl: string, changelogUrl: string, install: { githubSpec: string, npmSpec: string },
 * }>}
 */
export async function checkUpdate(options) {
  const repo = typeof options.repo === 'string' && options.repo.trim() !== ''
    ? options.repo.trim()
    : DEFAULT_REPO
  const current = String(options.currentVersion ?? '0.0.0')
  const now = options.now ?? (() => Date.now())
  const ttlMs = Number.isFinite(options.ttlMs) ? Number(options.ttlMs) : UPDATE_CACHE_TTL_MS
  const links = {
    repoUrl: `https://github.com/${repo}`,
    changelogUrl: `https://github.com/${repo}/blob/main/CHANGELOG.md`,
    install: {
      githubSpec: `github:${repo}`,
      npmSpec: '@deepseek-ai/dsh plugin --profile web add github:' + repo,
    },
  }

  const cached = options.cacheFile === undefined ? undefined : readUpdateCache(options.cacheFile, repo)
  if (options.force !== true && cached !== undefined && now() - cached.checkedAt < ttlMs) {
    return finish({ ...cached, from: 'cache', reason: '' }, current, links)
  }

  // 与 `remote.js` 同一条接缝约定：显式 `null` = 这个运行时没有 fetch（可测），
  // 省略 = 用运行时的 fetch。不能用 `??`，否则 null 会被当成「没传」。
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl
  if (typeof fetchImpl !== 'function') {
    return cached !== undefined
      ? finish({ ...cached, from: 'cache', reason: '运行时没有 fetch，改用缓存' }, current, links)
      : fail(current, links, '运行时没有 fetch，无法检查更新')
  }

  const url = `https://raw.githubusercontent.com/${repo}/main/package.json`
  let latest
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let response
    try {
      response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    } finally {
      clearTimeout(timer)
    }
    if (response?.ok !== true) {
      return cached !== undefined
        ? finish({ ...cached, from: 'cache', reason: `HTTP ${response?.status ?? '?'} 拉取版本失败` }, current, links)
        : fail(current, links, `HTTP ${response?.status ?? '?'} 拉取版本失败（本机访问 GitHub 常需代理）`)
    }
    const text = await response.text()
    latest = readVersionFromPackageJson(text)
    if (latest === undefined) {
      return fail(current, links, '远程 package.json 读不出 version 字段')
    }
  } catch (error) {
    const reason = `检查更新失败：${error instanceof Error ? error.message : String(error)}（本机访问 GitHub 常需代理）`
    return cached !== undefined ? finish({ ...cached, from: 'cache', reason }, current, links) : fail(current, links, reason)
  }

  const payload = { repo, latest, checkedAt: now(), from: 'network', reason: '' }
  if (options.cacheFile !== undefined) writeUpdateCache(options.cacheFile, payload)
  return finish(payload, current, links)
}

/** 从 package.json 文本里取 version（不整份 parse 成对象再挑字段——正文可能很大）。 */
export function readVersionFromPackageJson(text) {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed?.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 语义化版本比较（无依赖实现）。
 *
 * 只支持本插件会用的形态：`MAJOR.MINOR.PATCH`（可有 `-prerelease`）。
 * 预发布**小于**同号正式版（`0.4.0-rc.1 < 0.4.0`），这与 semver 一致。
 *
 * @returns {-1|0|1}
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i] ? 1 : -1
  }
  // 有预发布 < 无预发布；都有则按字符串比（够用，且不会把 0.4.0-rc.1 说成比 0.4.0 新）。
  if (left.pre !== right.pre) {
    if (left.pre === '') return 1
    if (right.pre === '') return -1
    return left.pre > right.pre ? 1 : -1
  }
  return 0
}

function parseVersion(value) {
  const raw = String(value ?? '').trim()
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.+))?$/.exec(raw)
  if (match === null) return { numbers: [0, 0, 0], pre: raw }
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? '',
  }
}

export function readUpdateCache(cacheFile, repo) {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    if (parsed.repo !== repo) return undefined
    if (typeof parsed.checkedAt !== 'number' || typeof parsed.latest !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function writeUpdateCache(cacheFile, payload) {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true })
    const tmp = `${cacheFile}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, cacheFile)
    return true
  } catch {
    return false
  }
}

function finish(payload, current, links) {
  const latest = payload.latest ?? null
  return {
    ok: true,
    current,
    latest,
    updateAvailable: latest !== null && compareVersions(latest, current) > 0,
    checkedAt: payload.checkedAt ?? 0,
    from: payload.from ?? 'network',
    reason: payload.reason ?? '',
    ...links,
  }
}

function fail(current, links, reason) {
  return {
    ok: false,
    current,
    latest: null,
    updateAvailable: false,
    checkedAt: 0,
    from: 'none',
    reason,
    ...links,
  }
}
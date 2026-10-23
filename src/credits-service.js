/**
 * 积分服务：余额查询 + 一键领取 + 结果缓存。
 *
 * ## 为什么单独一层，而不是让路由直接打上游
 *
 * 三件事需要共用同一份实现：
 * 1. 页面上的「余额」（每个账号一次网络请求，要缓存、要去重）；
 * 2. 卡片上的「一键领取」（逐账号顺序领取，避免并发触发风控）；
 * 3. 后台的「每日自动领积分」（同一套领取逻辑，不能和手动那条各写一遍）。
 *
 * 所以这里只做**取数**，路由与定时器都调它。
 *
 * ## 为什么是顺序而不是并发
 *
 * 上游对同一账号的签到接口有频率限制，且 OFM 的既有实现
 * （`collectClaimResults` / `collectCreditBalances`）同样是**顺序**执行。
 * 账号数是个位数，顺序带来的延迟远小于风控踩雷的代价。
 *
 * @module src/credits-service
 */

import { claimDailyCheckin, fetchCheckinStatus, fetchCreditBalance } from './core/credits.js'

/**
 * 余额缓存时长。
 *
 * 余额只在两件事后变化：调用模型（消耗）与领取积分（增加）。60 秒足够新，
 * 又能挡住「打开页面 → 切页签 → 再打开」造成的重复请求。
 */
const CACHE_TTL_MS = 60_000

/** 四舍五入到两位小数：与 core/credits.js 的 roundCredits 同口径。 */
function round(value) {
  return Math.round(value * 100) / 100
}

function emptySummary() {
  return { accounts: 0, claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0 }
}

/**
 * 汇总一组领取结果。
 *
 * `outcome.kind` 的取值来自 core/credits.js 的 `claimDailyCheckin`：
 * `claimed` / `already-claimed` / `inactive` / `failed`。
 */
export function summarizeClaims(results) {
  const summary = emptySummary()
  summary.accounts = results.length
  for (const row of results) {
    const kind = row?.outcome?.kind
    if (kind === 'claimed') {
      summary.claimed += 1
      summary.totalCredit = round(summary.totalCredit + (Number(row.outcome.credit) || 0))
    } else if (kind === 'already-claimed') {
      summary.alreadyClaimed += 1
    } else if (kind === 'inactive') {
      summary.inactive += 1
    } else {
      summary.failed += 1
    }
  }
  return summary
}

/**
 * 造一个积分服务。
 *
 * @param {{
 *   pool: () => any,                 // 晚绑定池门面（每次调用重新取）
 *   products: readonly any[],        // 车道清单（含 credits 能力位）
 *   logger?: any,
 *   now?: () => number,
 *   ttlMs?: number,
 *   fetcher?: typeof fetch,          // 测试接缝：离线跑路由断言时替换全局 fetch
 * }} options
 */
export function createCreditsService(options) {
  const { products, logger, fetcher } = options
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS

  /** provider → { at, value } */
  const cache = new Map()
  /** provider → Promise：同一 provider 的并发查询合并成一次。 */
  const inflight = new Map()

  const productOf = (provider) => products.find((product) => product.id === provider)

  /** 某条车道的积分能力（余额 / 签到）。未知车道一律视为不支持。 */
  function capabilityOf(provider) {
    return productOf(provider)?.credits ?? { balance: false, claim: false }
  }

  /** 解析账号凭据；失败不抛（页面要能看到「这个号读不出余额」而不是整页报错）。 */
  async function credentialOf(entry) {
    try {
      const pool = options.pool()
      const resolved = await pool?.resolveCredentialForAccount?.(entry.id)
      return resolved ?? undefined
    } catch (error) {
      logger?.warn?.(`[free-model] 账号 ${entry.id} 凭据解析失败：${String(error)}`)
      return undefined
    }
  }

  /** 读一个账号的余额（+ 签到状态，仅当该车道支持签到）。 */
  async function readRow(product, entry) {
    const capability = capabilityOf(product.id)
    const row = {
      accountId: entry.id,
      provider: product.id,
      nickname: entry.nickname ?? entry.id,
      enabled: entry.enabled !== false,
      balance: null,
      checkin: null,
    }
    const credential = await credentialOf(entry)
    if (credential === undefined) {
      // ⚠️ 「凭据读不出来」和「余额是 0」是两件事：前者要用户去续期/重登，
      // 后者说明积分真的用完了。合并显示会让人朝错误的方向修。
      row.error = '凭据不可用（可能已过期，点「续期」或重新登录）'
      return row
    }
    if (capability.balance === true) {
      try {
        row.balance = await fetchCreditBalance(credential, product, fetcher)
      } catch (error) {
        row.error = error instanceof Error ? error.message : String(error)
      }
      // core 的 fetchCreditBalance 失败时答 null（不抛），这里补一句人话。
      if (row.balance === null && row.error === undefined) row.error = '未返回余额数据（凭据失效或响应异常）'
    } else {
      row.error = '该车道没有积分接口'
    }
    if (capability.claim === true) {
      try {
        row.checkin = await fetchCheckinStatus(credential, product, fetcher)
      } catch {
        // 签到状态是锦上添花：读不到就不显示「今日 +N」，不影响余额。
        row.checkin = null
      }
    }
    return row
  }

  /**
   * 查余额（带缓存 + 并发合并）。
   *
   * @param {string} provider
   * @param {{ force?: boolean }} [flags]
   */
  async function collect(provider, flags = {}) {
    const product = productOf(provider)
    if (product === undefined) throw new Error(`unknown provider: ${provider}`)
    const force = flags.force === true
    const hit = cache.get(provider)
    if (!force && hit !== undefined && now() - hit.at < ttlMs) return { ...hit.value, cached: true }
    if (!force) {
      const running = inflight.get(provider)
      if (running !== undefined) return running
    }
    const task = (async () => {
      const entries = options.pool()?.listAccountsByProvider?.(provider) ?? []
      const rows = []
      // 顺序执行：见模块头的风控理由。
      for (const entry of entries) rows.push(await readRow(product, entry))
      const known = rows.filter((row) => Number.isFinite(row.balance?.total))
      const value = {
        provider,
        displayName: product.displayName,
        capability: capabilityOf(provider),
        at: now(),
        cached: false,
        accounts: rows,
        // 只累计**查得到**的账号：把失败当 0 会把「查不到」显示成「用完了」。
        total: round(known.reduce((sum, row) => sum + row.balance.total, 0)),
        known: known.length,
        failures: rows.length - known.length,
      }
      cache.set(provider, { at: value.at, value })
      return value
    })().finally(() => {
      inflight.delete(provider)
    })
    inflight.set(provider, task)
    return task
  }

  /**
   * 一键领取该车道全部账号的每日积分（顺序执行，单个失败不中断）。
   *
   * @param {string} provider
   */
  async function claim(provider) {
    const product = productOf(provider)
    if (product === undefined) throw new Error(`unknown provider: ${provider}`)
    if (capabilityOf(provider).claim !== true) {
      return { provider, supported: false, at: now(), summary: emptySummary(), results: [] }
    }
    const entries = options.pool()?.listAccountsByProvider?.(provider) ?? []
    const results = []
    for (const entry of entries) {
      const credential = await credentialOf(entry)
      if (credential === undefined) {
        results.push({ accountId: entry.id, nickname: entry.nickname ?? entry.id, outcome: { kind: 'failed', code: -1, message: '凭据不可用' } })
        continue
      }
      let outcome
      try {
        outcome = await claimDailyCheckin(credential, product, fetcher)
      } catch (error) {
        outcome = { kind: 'failed', code: -1, message: error instanceof Error ? error.message : String(error) }
      }
      results.push({ accountId: entry.id, nickname: entry.nickname ?? entry.id, outcome })
    }
    // 领完立刻让余额缓存失效：否则页面刷新后还是领之前的数字，看起来像「没领到」。
    cache.delete(provider)
    return { provider, supported: true, at: now(), summary: summarizeClaims(results), results }
  }

  function invalidate(provider) {
    if (provider === undefined) cache.clear()
    else cache.delete(provider)
  }

  return { collect, claim, invalidate, capabilityOf, productOf }
}

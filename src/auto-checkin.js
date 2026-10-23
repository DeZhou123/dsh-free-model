/**
 * 每日自动领积分。
 *
 * ## 与 OFM 的关系
 *
 * 界面逻辑与状态字段刻意与 OFM 的 `auto-checkin`（vendor/channel-pack 里那份）
 * 对齐：一个总开关、一天只跑一次、跑完记一条结果、状态里带 `channels` 逐渠道摘要。
 * 但**状态文件是独立的**：
 *
 * - OFM 写 `channel-pack/auto-checkin.json`（schema `dsh-codearts-auth/auto-checkin/v1`），
 *   里面还存着它自己那十几个渠道的跑批结果；
 * - 本插件写 `channel-pack/free-model-auto-checkin.json`。
 *
 * 两个进程同时改同一份文档，后写的会把前者的 `lastDate`/`channels` 抹掉 ——
 * OFM 那边就会以为「今天已经跑过」而跳过它自己的渠道。用独立文件是唯一
 * 不会互相踩的选择；代价是两边的开关各自独立（页面上写清楚是哪个插件的开关）。
 *
 * ## 不该跑的情形
 *
 * - 开关关掉；
 * - 今天（UTC+8）已经跑过一次；
 * - 池里没有可领账号（`coversToday === 0` 时不记「今天已跑」，否则一个
 *   空池会把后面新增的账号的自动领取拖到明天）。
 *
 * @module src/auto-checkin
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 状态文件名（放在 channel-pack 目录里，与账号索引同处）。 */
export const AUTO_CHECKIN_FILE = 'free-model-auto-checkin.json'

/** 文档 schema：将来结构变了要能认出来，而不是当成脏数据静默重置。 */
export const AUTO_CHECKIN_SCHEMA = 'dsh-free-model/auto-checkin/v1'

/** 默认开启：与 OFM 同一条产品判断 —— 领积分是纯收益动作，默认不拦。 */
const DEFAULT_DOC = {
  enabled: true,
  lastDate: '',
  lastResult: '',
  lastAt: 0,
  channels: [],
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** 每个渠道摘要字符串的上限：状态文件是给人看的，不是日志。 */
const MAX_CHANNEL_TEXT = 120
const MAX_CHANNEL_ENTRIES = 16

/** 启动后延迟多久跑（毫秒）。宿主刚起来时网络与凭据服务还没稳。 */
const DEFAULT_DELAY_MS = 30_000
const DELAY_ENV = 'DSH_FREE_MODEL_AUTO_CHECKIN_DELAY_MS'

export function autoCheckinDelayMs(env = process.env) {
  const raw = env[DELAY_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_DELAY_MS
  const parsed = Number(raw.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DELAY_MS
}

/**
 * 腾讯的签到周期按 **UTC+8** 切日。
 *
 * 用本机时区会让「晚上 8 点之后启动」在某些时区被算成第二天，于是同一天领两次
 * （服务端会答「今天已领」，不报错但白跑）或者跨天漏领。取 UTC+8 与 OFM 一致。
 */
export function utc8DateString(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function sanitizeChannels(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    if (typeof item.provider !== 'string' || item.provider.length === 0) continue
    if (typeof item.text !== 'string') continue
    out.push({ provider: item.provider, text: item.text.slice(0, MAX_CHANNEL_TEXT) })
    if (out.length >= MAX_CHANNEL_ENTRIES) break
  }
  return out
}

/** 读文档时做一次归一化：脏数据不能让开关状态变得含糊。 */
export function sanitizeAutoCheckin(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_DOC }
  const ms = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  return {
    // ⚠️ 只有显式 `false` 才算关闭：旧文档没有该字段时按默认（开启）处理，
    // 写成 `=== true` 会把「没这个字段」静默当成关。
    enabled: raw.enabled !== false,
    lastDate: typeof raw.lastDate === 'string' && DATE_RE.test(raw.lastDate) ? raw.lastDate : '',
    lastResult: typeof raw.lastResult === 'string' ? raw.lastResult : '',
    lastAt: ms(raw.lastAt),
    channels: sanitizeChannels(raw.channels),
  }
}

/** 内存实现（拿不到 DSH home 时的兜底：开关仍可用，只是不跨重启）。 */
class MemoryStore {
  constructor() {
    this.doc = { ...DEFAULT_DOC }
  }
  load() {
    return { ...this.doc, channels: this.doc.channels.map((entry) => ({ ...entry })) }
  }
  async save(doc) {
    this.doc = { ...doc, channels: doc.channels.map((entry) => ({ ...entry })) }
  }
}

/** 文件实现：临时文件 + rename，避免断电留下半截 JSON。 */
class FileStore {
  constructor(path, logger) {
    this.path = path
    this.logger = logger
  }
  load() {
    try {
      if (!existsSync(this.path)) return { ...DEFAULT_DOC }
      return sanitizeAutoCheckin(JSON.parse(readFileSync(this.path, 'utf-8')))
    } catch (error) {
      this.logger?.warn?.(`[free-model] 读取 ${this.path} 失败，自动领积分按默认设置（开启）处理：${String(error)}`)
      return { ...DEFAULT_DOC }
    }
  }
  async save(doc) {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify({ schema: AUTO_CHECKIN_SCHEMA, ...doc }, null, 2), 'utf-8')
      renameSync(tmp, this.path)
    } catch (error) {
      this.logger?.warn?.(`[free-model] 写入 ${this.path} 失败（开关仍在本进程生效）：${String(error)}`)
    }
  }
}

/** 造状态存储：有 DSH home 就落盘，没有就退回内存。 */
export function createAutoCheckinStore(home, logger) {
  if (typeof home !== 'string' || home.length === 0) {
    logger?.warn?.('[free-model] 无法定位 DSH home，自动领积分开关只存在于内存中')
    return new MemoryStore()
  }
  return new FileStore(join(home, 'channel-pack', AUTO_CHECKIN_FILE), logger)
}

/** 一句人话的结果摘要：与 OFM 的 `describeRun` 同口径。 */
export function describeRun(summary) {
  const parts = []
  if (summary.claimed > 0) parts.push(`${summary.claimed} 个账号领取成功（+${summary.totalCredit} 积分）`)
  if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今日已领`)
  if (summary.inactive > 0) parts.push(`${summary.inactive} 个未开启活动`)
  if (summary.failed > 0) parts.push(`${summary.failed} 个失败`)
  if (parts.length === 0) return '没有需要领取的账号'
  return parts.join('，')
}

/**
 * 造自动领积分引擎。
 *
 * @param {{
 *   store: { load: () => any, save: (doc: any) => Promise<void> },
 *   providers: readonly any[],           // 车道清单（只会领 credits.claim === true 的）
 *   claim: (provider: string) => Promise<any>,  // 逐渠道领取（credits-service.claim）
 *   logger?: any,
 *   now?: () => number,
 *   delayMs?: number,
 *   schedule?: (fn: () => void, ms: number) => { cancel: () => void },
 * }} deps
 */
export function createAutoCheckin(deps) {
  const now = deps.now ?? (() => Date.now())
  const logger = deps.logger
  let doc = deps.store.load()
  let running = false
  let inflight = null
  let pending = null

  const today = () => utc8DateString(now())

  function state() {
    return {
      enabled: doc.enabled,
      lastDate: doc.lastDate,
      ranToday: doc.lastDate !== '' && doc.lastDate === today(),
      running,
      lastResult: doc.lastResult,
      lastAt: doc.lastAt,
      channels: doc.channels.map((entry) => ({ ...entry })),
      /** 状态文件的绝对路径（拿不到 home 时为 null）—— 用户要知道这份开关存在哪。 */
      file: deps.store.path ?? null,
    }
  }

  async function performRun() {
    const totals = { providers: 0, claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, skipped: 0, coversToday: 0 }
    const channels = []
    for (const product of deps.providers) {
      const capability = product.credits ?? { balance: false, claim: false }
      if (capability.claim !== true) {
        totals.skipped += 1
        channels.push({ provider: product.id, text: '无签到接口' })
        continue
      }
      let result
      try {
        result = await deps.claim(product.id)
      } catch (error) {
        totals.failed += 1
        channels.push({ provider: product.id, text: '出错' })
        logger?.warn?.(`[free-model] 自动领积分：${product.id} 调用异常：${String(error)}`)
        continue
      }
      if (result?.supported === false) {
        totals.skipped += 1
        channels.push({ provider: product.id, text: '无签到接口' })
        continue
      }
      totals.providers += 1
      const summary = result.summary ?? { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0 }
      totals.claimed += summary.claimed
      totals.totalCredit = Math.round((totals.totalCredit + summary.totalCredit) * 100) / 100
      totals.alreadyClaimed += summary.alreadyClaimed
      totals.inactive += summary.inactive
      totals.failed += summary.failed
      totals.coversToday += summary.claimed + summary.alreadyClaimed
      channels.push({ provider: product.id, text: describeRun(summary) })
    }
    if (totals.coversToday === 0) {
      // 没领到也不算「今天跑过」：下次启动（或用户点「立即领取」）还要再试，
      // 否则一个空池会把今天新加的账号拖到明天。
      logger?.warn?.(`[free-model] 自动领积分未记入今日（下次启动会重试）：${describeRun(totals)}`)
      return { ...totals, channels: [] }
    }
    doc = {
      ...doc,
      lastDate: today(),
      lastResult: describeRun(totals),
      lastAt: now(),
      channels,
    }
    await deps.store.save(doc)
    logger?.warn?.(`[free-model] 自动领积分完成（${today()}）：${doc.lastResult}`)
    return { ...totals, channels }
  }

  function runIfDue() {
    if (inflight !== null) return inflight
    if (doc.enabled !== true) return Promise.resolve()
    if (doc.lastDate !== '' && doc.lastDate === today()) return Promise.resolve()
    running = true
    const task = performRun()
      .catch((error) => {
        logger?.warn?.(`[free-model] 自动领积分异常：${String(error)}`)
      })
      .finally(() => {
        running = false
        inflight = null
      })
    inflight = task
    return task
  }

  return {
    state,
    /** 打开时立刻尝试跑一轮（今天已跑过则由 runIfDue 内部拦住）。 */
    async setEnabled(enabled) {
      doc = { ...doc, enabled: enabled === true }
      await deps.store.save(doc)
      if (doc.enabled) void runIfDue()
      return state()
    },
    /** 手动跑一轮（忽略「今天跑过」，用于页面上的「立即领取」）。 */
    async runNow() {
      if (inflight !== null) return inflight
      running = true
      const task = performRun()
        .catch((error) => {
          logger?.warn?.(`[free-model] 手动领积分异常：${String(error)}`)
        })
        .finally(() => {
          running = false
          inflight = null
        })
      inflight = task
      await task
      return state()
    },
    runIfDue,
    start() {
      if (pending !== null) return
      const ms = deps.delayMs ?? autoCheckinDelayMs()
      if (ms <= 0) {
        void runIfDue()
        return
      }
      const fire = () => {
        pending = null
        void runIfDue()
      }
      const scheduler = deps.schedule ?? ((fn, delay) => {
        const timer = setTimeout(fn, delay)
        // 定时器不能把宿主进程钉住（宿主退出时不该等这 30 秒）。
        timer.unref?.()
        return { cancel: () => clearTimeout(timer) }
      })
      pending = scheduler(fire, ms)
    },
    stop() {
      pending?.cancel?.()
      pending = null
    },
  }
}

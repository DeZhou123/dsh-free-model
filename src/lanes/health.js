/**
 * 渠道健康与冷却状态机 —— 「这条渠道现在到底能不能用」的唯一事实来源。
 *
 * ## 为什么要有这个模块
 *
 * 免费渠道的失败**不是同一种失败**，混在一起处理必然两头都错：
 *
 * | 现象 | 想做的事 | 搞错的代价 |
 * |---|---|---|
 * | 401 / invalid-key | 判死，别再打，提示换 key | 每轮拿一个废 key 去撞，日志全是噪音 |
 * | 402 / quota | 等额度刷新那一刻再来 | 一分钟试十次，每次都白花一个请求 |
 * | 429 | 等 retry-after，60 秒起步、逐次翻倍 | 立刻重试 → 被限得更狠（免费端点几乎都这样） |
 * | 5xx / 超时 / 流中断 | 30 秒起步、逐次翻倍 | 把一个抖动当成长病（或干脆当没事） |
 * | 404 | 地址可能已过期，长冷却（6h） | 反复打一个不存在的端点 |
 * | 400 | **这不是渠道的问题**，不进冷却 | 用户参数写错，结果整条渠道被冻住 |
 *
 * 所以这里刻意分成两半：
 *
 * - `classifyFailure`：**判定**。纯函数，输入一次失败的形状，输出「该判成什么」。
 *   纯函数才能被单测逐条钉住 —— 判据一旦有歧义，「能不能用」就没有人敢信。
 * - `createHealthStore`：**记账**。指数退避、半开探测、落盘、reset。
 *
 * ## 三条刻意的设计
 *
 * 1. **状态字符串只有四个**（`HEALTH_STATES`）。半开（half-open）不是第五个状态，
 *    而是「冷却已到期、只放一次探测」在返回值上的一个 `halfOpen: true` 标记 ——
 *    调用方拿到它就知道该放一个探测请求，而不是放一池子。
 * 2. **读操作不写盘**：`get` / `isAvailable` 只做投影（到期即视为 ok + halfOpen），
 *    不因为「有人看了一眼」就产生一次磁盘写。
 * 3. **记录里绝不允许出现凭据**：只存 laneId + 分类字符串；错误文本截断 200 字符，
 *    并过一遍长串遮蔽（连续的 key 形状串只留首尾）—— 落盘的东西是会被拷走、被贴进
 *    issue 的，这一层不能靠调用方自觉。
 *
 * ## 落盘的取舍
 *
 * 内存优先：没给 `file` 或 `persist: false` 就纯内存（测试、CLI、只读场景）。
 * 给了 file 就**每次记账立即原子写**（先 .tmp 再 rename）：健康状态只有几条记录、
 * 几 KB，一次写入的代价远小于「进程被重启后把整池渠道重新撞一遍」。
 * 文件坏掉（被手工编辑、断电写半截）**忽略并从空状态起**，warn 一次，绝不抛 ——
 * 健康状态是增强，不是依赖，不能因为它把设置页打死。
 *
 * @module src/lanes/health
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 一条渠道对外只有这四种状态。半开不是状态，是标记（见 `createHealthStore`）。 */
export const HEALTH_STATES = Object.freeze(['ok', 'cooldown', 'revoked', 'unknown'])

/** 额度型冷却的默认时长：等「下一个本地整点 + 6 小时」。 */
export const DEFAULT_QUOTA_HOURS = 6

/** 退避上限：30 分钟。再久就不该由退避决定，而是人去看。 */
export const DEFAULT_MAX_COOLDOWN_MS = 30 * 60 * 1000

const HOUR_MS = 60 * 60 * 1000

/** 429 的基准：60 秒。 */
const BASE_RATE_LIMIT_MS = 60 * 1000

/** 抖动类失败（5xx / 超时 / 流中断）的基准：30 秒。 */
const BASE_TRANSIENT_MS = 30 * 1000

/** 404 的长冷却：6 小时（地址可能已经换了，别拿它当抖动重试）。 */
const LONG_COOLDOWN_MS = 6 * HOUR_MS

/** 错误文本上限。落盘的东西要能被整段贴出来。 */
const MAX_ERROR_TEXT = 200

/** 形如 key 的长串：连续 20+ 个 `[A-Za-z0-9_-]`。 */
const SECRETISH = /[A-Za-z0-9_-]{20,}/g

// ── 判定（纯函数） ───────────────────────────────────────────────────────────

/**
 * 把「一次失败的形状」判成「该记成什么」。
 *
 * @param {{ kind?: string, status?: number, retryAfterMs?: number, code?: string }} input
 * @param {{ now?: () => number, quotaHours?: number }} [options]
 *   `now` 只为算出额度冷却的**绝对时刻**（默认 `Date.now`）；`quotaHours` 默认 6。
 *   同样的入参 + 同样的时刻 → 同样的输出，所以它仍是纯函数。
 * @returns {{
 *   state: 'cooldown' | 'revoked' | 'ok',
 *   cooldownMs: number,            // Infinity = 永不自动恢复（revoked）
 *   until?: number,                // 只在「有绝对时刻」的分支给（额度）；其余由账本按 now + cooldownMs 推
 *   reason: string,
 *   retryable: boolean,
 * }}
 */
export function classifyFailure(input, options) {
  const source = input ?? {}
  const opts = options ?? {}
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now
  const at = nowFn()
  const quotaHours = Number.isFinite(opts.quotaHours) ? Number(opts.quotaHours) : DEFAULT_QUOTA_HOURS

  const status = Number.isFinite(source.status) ? Number(source.status) : undefined
  const kind = String(source.kind ?? '').toLowerCase().trim()
  const code = String(source.code ?? '').toUpperCase().trim()
  const retryAfterMs = Number.isFinite(source.retryAfterMs) && Number(source.retryAfterMs) > 0
    ? Math.floor(Number(source.retryAfterMs))
    : undefined

  // ① key 无效：判死。不会自己恢复，只有换 key 才能救。
  if (status === 401 || status === 403 || isInvalidKeyKind(kind) || isInvalidKeyCode(code)) {
    return {
      state: 'revoked',
      cooldownMs: Infinity,
      reason: 'key 被拒（401/invalid-key），换个 key',
      retryable: false,
    }
  }

  // ② 额度 / 余额：冷却到「下一个本地整点 + quotaHours」。这是**绝对时刻**，
  //    与退避无关 —— 退避解决的是「太快」，额度解决的是「没有」。
  if (status === 402 || isQuotaKind(kind) || isQuotaCode(code)) {
    const until = nextHourBoundary(at) + quotaHours * HOUR_MS
    return {
      state: 'cooldown',
      cooldownMs: Math.max(0, until - at),
      until,
      reason: '额度不足，冷却到 ' + formatLocal(until) + '（下一个整点 + ' + quotaHours + 'h）',
      // 立刻重试不会好，但**会**自动恢复（刷新额度），所以是冷却而不是吊销。
      retryable: false,
    }
  }

  // ③ 限流：retry-after 优先（服务端说了算），否则 60 秒起步，退避由账本做。
  if (status === 429 || kind.includes('rate-limit') || kind.includes('rate_limit') || code === 'RATE_LIMIT') {
    const base = retryAfterMs === undefined
      ? BASE_RATE_LIMIT_MS
      : Math.min(retryAfterMs, DEFAULT_MAX_COOLDOWN_MS)
    return {
      state: 'cooldown',
      cooldownMs: base,
      reason: retryAfterMs === undefined
        ? '触发限流（429），按退避等待'
        : '触发限流（429），服务端要求等 ' + Math.round(base / 1000) + ' 秒',
      retryable: true,
    }
  }

  // ④ 404：地址可能已经换了。长冷却，且不参与退避（退避只会让它更短）。
  if (status === 404 || kind.includes('not-found') || kind.includes('not_found')) {
    return {
      state: 'cooldown',
      cooldownMs: LONG_COOLDOWN_MS,
      reason: '端点 404，地址可能已过期，长冷却',
      retryable: false,
    }
  }

  // ⑤ 抖动：5xx / 超时 / 网络 / 流中断。基准 30 秒，指数退避交给账本。
  if ((status !== undefined && status >= 500) || isTransientKind(kind) || isTransientCode(code)) {
    return {
      state: 'cooldown',
      cooldownMs: BASE_TRANSIENT_MS,
      reason: status === undefined
        ? '渠道抖动（超时/网络/流中断），按退避等待'
        : '渠道抖动（' + status + '），按退避等待',
      retryable: true,
    }
  }

  // ⑥ 400：这是**请求本身**的问题，不是渠道的问题。不进冷却。
  if (status === 400 || kind.includes('bad-request') || kind.includes('bad_request')) {
    return {
      state: 'ok',
      cooldownMs: 0,
      reason: '请求参数有误（400），与渠道健康无关',
      retryable: false,
    }
  }

  // ⑦ 认不出来：保守地当抖动。宁可多等 30 秒，也不要拿陌生错误去打穿一个端点。
  return {
    state: 'cooldown',
    cooldownMs: BASE_TRANSIENT_MS,
    reason: status === undefined ? '未知失败，保守冷却' : '未知失败（' + status + '），保守冷却',
    retryable: true,
  }
}

function isInvalidKeyKind(kind) {
  if (kind === '') return false
  return /(^|[-_ ])(invalid[-_]?key|invalid[-_]?credential|invalid[-_]?api[-_]?key|auth|authentication|unauthorized|unauthenticated)($|[-_ ])/.test(kind)
}

function isInvalidKeyCode(code) {
  if (code === '') return false
  return [
    'AUTH',
    'INVALID_CREDENTIAL',
    'INVALID_CREDENTIALS',
    'INVALID_KEY',
    'INVALID_API_KEY',
    'UNAUTHORIZED',
    'PERMISSION_DENIED',
  ].includes(code)
}

function isQuotaKind(kind) {
  if (kind === '') return false
  return kind.includes('quota')
    || kind.includes('balance')
    || kind.includes('insufficient')
    || kind.includes('credit')
}

function isQuotaCode(code) {
  if (code === '') return false
  return code.includes('QUOTA') || code.includes('INSUFFICIENT') || code.includes('NO_BALANCE')
}

function isTransientKind(kind) {
  if (kind === '') return false
  return [
    'server-error',
    'server_error',
    'timeout',
    'timed-out',
    'network',
    'network-error',
    'stream-cut',
    'stream_cut',
    'connection-reset',
    'aborted',
    'transient',
  ].some((token) => kind.includes(token))
}

function isTransientCode(code) {
  if (code === '') return false
  return [
    'TIMEOUT',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'STREAM_CUT',
    'UND_ERR_SOCKET',
  ].includes(code)
}

/** 下一个本地整点（严格大于 at）。额度刷新几乎都挂整点。 */
function nextHourBoundary(at) {
  const date = new Date(at)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours() + 1,
    0,
    0,
    0,
  ).getTime()
}

/** 人类看得懂的时刻（本地时区，`YYYY-MM-DD HH:mm`）。 */
export function formatLocal(at) {
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  return date.getFullYear()
    + '-' + pad(date.getMonth() + 1)
    + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours())
    + ':' + pad(date.getMinutes())
}

/**
 * 把一段任意文本洗成可以落盘的形态：
 * 压空白 → 截断 200 字符 → 遮蔽形如 key 的长串（留首 4 + 尾 2）。
 *
 * ## 为什么要遮蔽，而不是「调用方保证不传 key」
 *
 * 真实世界里失败文本是 `fetch failed: Authorization Bearer sk-xxxxxxxx...`。
 * 要求每个调用点都洗干净是不现实的，而这份 JSON 会被拷进 issue、贴进聊天记录。
 * 所以出口处统一再洗一遍 —— 只洗出口，不洗入口，改动面最小。
 */
export function sanitizeErrorText(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_TEXT)
  if (raw === '') return ''
  return raw.replace(SECRETISH, (match) => match.slice(0, 4) + '…' + match.slice(-2))
}

/**
 * 一条记录的显示说明：给页面/日志用的一行中文。
 *
 * @param {object} record `createHealthStore`.get 的返回值
 * @param {number} [now]
 */
export function describeHealth(record, now) {
  const at = Number.isFinite(now) ? Number(now) : Date.now()
  const state = record?.state ?? 'unknown'

  if (state === 'unknown') return '未知（还没测过）'
  if (state === 'revoked') return '已吊销：key 被拒，换个 key'

  if (state === 'cooldown') {
    const until = Number.isFinite(record?.until) ? record.until : null
    if (until === null) return '冷却中（没有结束时刻）'
    const left = until - at
    if (left <= 0) return '冷却已到期，可以试一次'
    return '冷却中，还有 ' + formatDuration(left)
  }

  if (record?.halfOpen === true) return 'ok（冷却刚到期，只放一次探测）'
  if (Number.isFinite(record?.lastOkAt)) return 'ok（上次成功 ' + formatDuration(at - record.lastOkAt) + '前）'
  return 'ok'
}

/** 剩余时长的中文口语（秒 / 分钟 / 小时）。 */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000))
  if (seconds < 60) return seconds + ' 秒'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes + ' 分钟'
  return Math.round(minutes / 60) + ' 小时'
}

// ── 账本（一个可注入的存储接缝） ─────────────────────────────────────────────

/**
 * 创建一个健康账本。
 *
 * @param {{
 *   file?: string,                 // 给了才落盘；没给 = 纯内存
 *   now?: () => number,
 *   persist?: boolean,             // 显式 false 时不落盘（即使给了 file）
 *   logger?: { warn?: Function },
 *   quotaHours?: number,
 *   maxCooldownMs?: number,
 * }} [deps]
 */
export function createHealthStore(deps) {
  const options = deps ?? {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const quotaHours = Number.isFinite(options.quotaHours) ? Number(options.quotaHours) : DEFAULT_QUOTA_HOURS
  const maxCooldownMs = Number.isFinite(options.maxCooldownMs)
    ? Number(options.maxCooldownMs)
    : DEFAULT_MAX_COOLDOWN_MS
  const logger = options.logger ?? {}
  const file = typeof options.file === 'string' && options.file.trim() !== '' ? options.file.trim() : undefined
  const persist = file !== undefined && options.persist !== false

  /** @type {Map<string, object>} laneId → 原始记录（读的时候再投影） */
  const lanes = new Map()

  function warn(message) {
    if (typeof logger.warn !== 'function') return
    try {
      logger.warn('[free-model/health] ' + message)
    } catch {
      // 日志器自己炸了不该影响健康记账
    }
  }

  // 冷启动：能读就读；读不动就当空（warn 一次，不抛）。
  if (file !== undefined) {
    const loaded = readStateFile(file)
    if (loaded.status === 'corrupt') {
      warn('健康状态文件损坏，从空状态起（' + file + '）：' + loaded.message)
    }
    for (const [laneId, record] of loaded.lanes) lanes.set(laneId, record)
  }

  function serializeAll() {
    const payload = {
      version: 1,
      generatedAt: now(),
      lanes: Object.fromEntries(
        [...lanes.entries()].map(([laneId, record]) => [laneId, serializable(record)]),
      ),
    }
    return JSON.stringify(payload, null, 2)
  }

  /**
   * 落盘：**先读盘再合并，然后原子写**（0.6.0，审计的 P2-2）。
   *
   * ## 为什么不能直接覆盖
   *
   * 原子写（tmp → rename）只保证「不会半截」，**不保证不丢**：两个宿主实例指向同一个
   * DSH_HOME 时（同一台机器开两个窗口、或者插件被装了两份），后写的整份会覆盖前写的 ——
   * 而「前写」的那一份可能是对方刚记下的 6 小时冷却。
   *
   * 合并规则按 `decidedAt`（谁更新谁赢）逐条取，而不是整份覆盖：一条渠道的最新结论
   * 才是我们要保的东西。`decidedAt` 相同则保留**本进程**的（它就是刚写的那个结论）。
   */
  function writeStateFile(options) {
    if (!persist) return false
    // `reset()` 必须**权威**：它写的就是「没有记录」。合并会把刚清掉的记录读回来 ——
    // 那等于「清不掉」，而且只会在「盘上有旧记录」时出现（测试里就是这么暴露的）。
    const merge = options?.merge !== false
    try {
      mkdirSync(dirname(file), { recursive: true })
      for (const [laneId, onDisk] of (merge ? readStateFile(file).lanes : new Map())) {
        const mine = lanes.get(laneId)
        if (mine === undefined || (Number.isFinite(onDisk.decidedAt) && onDisk.decidedAt > (mine.decidedAt ?? 0))) {
          lanes.set(laneId, onDisk)
        }
      }
      const tmp = file + '.tmp-' + process.pid
      writeFileSync(tmp, serializeAll(), 'utf8')
      renameSync(tmp, file)
      return true
    } catch (error) {
      warn('健康状态落盘失败：' + (error instanceof Error ? error.message : String(error)))
      return false
    }
  }

  /** 到期即投影成 ok + halfOpen：读的时候算，不改历史、不写盘。 */
  function project(record, at) {
    if (record.state === 'cooldown' && Number.isFinite(record.until) && record.until <= at) {
      return {
        ...record,
        state: 'ok',
        until: null,
        halfOpen: true,
        reason: '冷却已到期，只放一次探测',
      }
    }
    return { ...record, halfOpen: false }
  }

  function get(laneId) {
    const record = lanes.get(String(laneId))
    if (record === undefined) {
      return {
        state: 'unknown',
        until: null,
        failures: 0,
        consecutive: 0,
        lastError: null,
        lastOkAt: null,
        lastFailureAt: null,
        decidedAt: null,
        halfOpen: false,
      }
    }
    return project(record, now())
  }

  function recordFailure(laneId, failure) {
    const id = String(laneId)
    const at = now()
    const classification = classifyFailure(failure, { now: () => at, quotaHours })
    const previous = lanes.get(id)
    const failures = (previous?.failures ?? 0) + 1
    const errorText = sanitizeErrorText(failure?.reason ?? failure?.message ?? classification.reason)

    // ⓪ 400 这类「不是渠道的问题」：计数照记（诊断要看），但不进冷却、不动 consecutive。
    if (classification.state === 'ok') {
      const record = {
        state: 'ok',
        until: null,
        failures,
        consecutive: 0,
        lastError: errorText,
        lastOkAt: previous?.lastOkAt ?? null,
        lastFailureAt: at,
        decidedAt: at,
      }
      lanes.set(id, record)
      writeStateFile()
      return project(record, at)
    }

    const consecutive = (previous?.consecutive ?? 0) + 1

    let cooldownMs
    if (classification.state === 'revoked') {
      // 吊销不受退避影响：退避是「等等会好」，吊销是「不会自己好」。
      cooldownMs = Infinity
    } else if (
      Number.isFinite(failure?.retryAfterMs)
      && Number(failure.retryAfterMs) > 0
      && classification.retryable
    ) {
      // 服务端说了算，但仍受上限约束（一个乱填的 retry-after 不能把渠道冻一天）。
      cooldownMs = Math.min(Math.floor(Number(failure.retryAfterMs)), maxCooldownMs)
    } else if (classification.retryable) {
      // 指数退避：连续第 n 次失败 → base * 2^(n-1)，封顶 maxCooldownMs。
      cooldownMs = Math.min(classification.cooldownMs * 2 ** (consecutive - 1), maxCooldownMs)
    } else {
      // 长冷却（404 / 额度）：本身已是「不要反复打」的判断，不该被退避缩短或拉长。
      cooldownMs = classification.cooldownMs
    }

    const until = Number.isFinite(cooldownMs) ? at + cooldownMs : null
    const record = {
      state: classification.state,
      until,
      failures,
      consecutive,
      lastError: errorText,
      lastOkAt: previous?.lastOkAt ?? null,
      lastFailureAt: at,
      decidedAt: at,
    }
    lanes.set(id, record)
    writeStateFile()
    return project(record, at)
  }

  function recordSuccess(laneId) {
    const id = String(laneId)
    const at = now()
    const previous = lanes.get(id)
    const record = {
      state: 'ok',
      until: null,
      failures: previous?.failures ?? 0,
      consecutive: 0,
      lastError: null,
      lastOkAt: at,
      lastFailureAt: previous?.lastFailureAt ?? null,
      decidedAt: at,
    }
    lanes.set(id, record)
    writeStateFile()
    return project(record, at)
  }

  /**
   * 这条渠道现在能不能用。
   *
   * `modelId` 目前是**签名占位**：健康状态是渠道级的（一个 key 挂了，它下面所有模型都挂）。
   * 真到「同渠道按模型分健康度」那天，要改的是账本的键，不是这个签名。
   */
  function isAvailable(laneId, modelId) {
    void modelId
    const at = now()
    const record = get(laneId)

    if (record.state === 'unknown') {
      // 未知**放行**：没测过不等于不可用，先让它试一次（失败会立刻被记账）。
      return {
        available: true,
        state: 'unknown',
        reason: '还没测过，先放行',
        until: null,
        halfOpen: false,
      }
    }
    if (record.state === 'revoked') {
      return {
        available: false,
        state: 'revoked',
        reason: record.lastError === null || record.lastError === ''
          ? '已吊销：key 被拒，换个 key'
          : record.lastError,
        until: null,
        halfOpen: false,
      }
    }
    if (record.state === 'cooldown') {
      const left = record.until === null ? null : Math.max(0, Math.ceil((record.until - at) / 1000))
      return {
        available: false,
        state: 'cooldown',
        reason: left === null ? '冷却中' : '冷却中，还有 ' + left + ' 秒',
        until: record.until,
        halfOpen: false,
      }
    }
    return {
      available: true,
      state: 'ok',
      reason: record.halfOpen === true ? '冷却刚到期，只放一次探测' : 'ok',
      until: null,
      halfOpen: record.halfOpen === true,
    }
  }

  function snapshot() {
    return {
      generatedAt: now(),
      lanes: Object.fromEntries([...lanes.keys()].map((laneId) => [laneId, get(laneId)])),
    }
  }

  function reset(laneId) {
    if (laneId === undefined) lanes.clear()
    else lanes.delete(String(laneId))
    // 清空是**权威动作**：不许被盘上的旧记录合并回来（见 writeStateFile 的 options.merge）。
    writeStateFile({ merge: false })
  }

  return {
    get,
    recordFailure,
    recordSuccess,
    isAvailable,
    snapshot,
    reset,
    flush: writeStateFile,
    file,
  }
}

/** 只把这几个字段写出去 —— 结构上就不给凭据留位置。 */
function serializable(record) {
  return {
    state: HEALTH_STATES.includes(record.state) ? record.state : 'unknown',
    until: Number.isFinite(record.until) ? record.until : null,
    failures: Number.isFinite(record.failures) ? record.failures : 0,
    consecutive: Number.isFinite(record.consecutive) ? record.consecutive : 0,
    lastError: typeof record.lastError === 'string' ? sanitizeErrorText(record.lastError) : null,
    lastOkAt: Number.isFinite(record.lastOkAt) ? record.lastOkAt : null,
    lastFailureAt: Number.isFinite(record.lastFailureAt) ? record.lastFailureAt : null,
    decidedAt: Number.isFinite(record.decidedAt) ? record.decidedAt : null,
  }
}

/**
 * 读状态文件。
 * - 不存在 → 空（正常冷启动，不 warn）
 * - 坏掉/形状不对 → `status: 'corrupt'`，调用方从空状态起
 */
function readStateFile(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', lanes: new Map() }
    return {
      status: 'corrupt',
      lanes: new Map(),
      message: error instanceof Error ? error.message : String(error),
    }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      status: 'corrupt',
      lanes: new Map(),
      message: error instanceof Error ? error.message : String(error),
    }
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.lanes === null || typeof parsed.lanes !== 'object') {
    return { status: 'corrupt', lanes: new Map(), message: '缺少 lanes 字段' }
  }
  const lanes = new Map()
  for (const [laneId, raw] of Object.entries(parsed.lanes)) {
    if (raw === null || typeof raw !== 'object') continue
    if (!HEALTH_STATES.includes(raw.state)) continue
    lanes.set(laneId, serializable(raw))
  }
  return { status: 'loaded', lanes }
}
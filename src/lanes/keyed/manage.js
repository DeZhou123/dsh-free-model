/**
 * 「自带 key」车道的**运行时管理器**：把「目录 → 就绪 → 挂载 → 填 key → 探测」
 * 这条链路收在一处。
 *
 * ## 为什么需要它（而不是继续用 `mountAll` 一次性挂完）
 *
 * `mountAll` 是**一次性**的：启动时把当时就绪的车道挂上，然后什么都不管了。
 * 一旦页面上允许「现在填 key」，一次性就成了硬伤：
 *
 * - 填完 key 之后那条车道**还是没挂**（启动时它没就绪），用户得重启宿主；
 * - 就算重挂，`registerAdapter` 会因为路由已存在而抛 `DUPLICATE_ADAPTER`；
 * - 换了 key 之后已经挂上的适配器仍握着**旧 key**（`KeyedAdapter` 自己的注释
 *   写着 `setApiKey()` 就是为这件事留的，但没人调它）。
 *
 * 所以这里持有 `laneId → { adapter, handle }` 一张表，三件事各自走最短路径：
 *
 * | 动作 | 已挂载 | 未挂载 |
 * |---|---|---|
 * | 保存 key | `adapter.setApiKey()`（不重注册） | 就绪就挂，挂完注册 |
 * | 清除 key | `adapter.setApiKey(null)`（路由保留，报错文案可读） | 什么都不做 |
 * | 探测 | 用**当前**凭据直接打上游 | 同样直接打上游（不需要先挂载） |
 *
 * 路由在清除 key 时**故意保留**：适配器自己会抛 `MISSING_CREDENTIAL` 并说清
 * 「去哪个页面拿 key」——把路由撤掉反而让模型选择器里那一列静静消失，用户
 * 只会觉得「插件把模型弄丢了」。
 *
 * ## 单条失败不带走其余
 *
 * 每条动作都独立 try/catch，失败进 `failed` 名单并留原因。这一层是插件里最容易
 * 炸的地方（公网端点 + 用户手填的字符串），绝不能让一条坏车道影响 13 条账号车道。
 *
 * @module src/lanes/keyed/manage
 */

import { descriptors, mount } from './index.js'
import { keyRefOf, laneKeyState, saveLaneKey, clearLaneKey, maskKey } from './keys.js'
import { probeLaneKey } from './probe.js'
import { probeLaneBalance, BALANCE_TIMEOUT_MS } from './balance.js'
import { probeLaneChat } from './probe.js'
import { laneById } from './catalog.js'
import { resolveApiKey } from './ready.js'
import { createHealthStore, describeHealth } from '../health.js'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 探测结果的缓存时长：成功 60 秒。面板切页签会重复读，别每次都打上游。 */
export const PROBE_CACHE_TTL_MS = 60_000

/** 探测失败后的退避：20 秒内不重探（上游 429/超时的时候尤其重要）。 */
export const PROBE_FAILURE_TTL_MS = 20_000

/**
 * 建一个管理器。
 *
 * @param {{
 *   readCredential?: (name:string) => unknown|Promise<unknown>,
 *   writeCredential?: (name:string, value:string) => unknown|Promise<unknown>,
 *   unsetCredential?: (name:string) => unknown|Promise<unknown>,
 *   describeCredential?: (name:string) => unknown|Promise<unknown>,
 *   register?: (route: string, adapter: object) => void,
 *   logger?: object,
 *   fetchImpl?: Function,
 *   probeTimeoutMs?: number,
 *   readImage?: Function,
 *   readImageRequest?: Function,
 *   onUpdate?: (snapshot: object) => void,
 *   health?: ReturnType<typeof createHealthStore>,   // 注入的账本（页面/测试可换一个纯内存的）
 *   healthFile?: string,
 * }} deps
 * @returns {object} 见下方各方法的 jsdoc
 */
export function createKeyedManager(deps = {}) {
  const logger = deps.logger
  /**
   * 渠道健康账本（`../health.js`）。
   *
   * ## 为什么管理器要持有它，而不是让页面自己记
   *
   * 「这条渠道现在还能不能打」必须由**打过它的那一方**记账：页面刷新就忘、
   * 宿主重启就忘，而免费渠道的冷却常常有 6 小时（额度）甚至永久（key 废了）。
   * 忘了的后果是每隔几分钟拿同一把废 key 去撞一次上游 —— 日志噪音之外，
   * 还在别人家白刷请求数。
   *
   * 注入优先：测试传一个 `persist:false` 的实例；生产由 `index.js` 给文件路径。
   */
  const health = deps.health ?? createHealthStore({
    ...(typeof deps.healthFile === 'string' && deps.healthFile !== '' ? { file: deps.healthFile } : {}),
    logger,
  })
  /** laneId → { lane, adapter, handle } */
  const mounted = new Map()
  /** laneId → { result, at, ok } */
  const probes = new Map()
  /** 最近一次 descriptors() 的结果（页面的行数据就是它）。 */
  let records = []
  /** laneId → 凭据面状态（已配置/来源/能否写/脱敏值）。 */
  let keyStates = Object.freeze({})
  /** laneId → 这条车道配了几把 key（同渠道多账号轮换，0.6.0）。 */
  const keyCounts = {}
  /**
   * 被用户**关掉**的车道（0.6.0）。
   *
   * ## 为什么需要它
   *
   * 30 多条渠道里，用户真正在用的可能就两三条 —— 其余的每次都在模型选择器里占位置。
   * 「关掉」要的是一个**明确的、可恢复的**状态，而不是把凭据删掉（删了还得重新配）。
   *
   * 关掉 = ① 启动时不挂它的适配器（模型选择器里干净）+ ② 运行时闸门拒绝它的请求
   * （已经挂上的那条，卸载路由要看宿主给不给 disposer，不能假设）。
   */
  const disabled = new Set(loadDisabled(deps.disabledFile, logger))

  /**
   * 把适配器报回来的真实对话结果记进健康账本。
   *
   * 与探测的区别：探测只证明「key 能过鉴权」，而真实对话才会撞上限流、额度、
   * 模型下线、流中断 —— 那些恰恰是**用完一条免费渠道之后**最该被记住的事。
   */
  /**
   * 适配器的失败类别 → 健康账本吃的分类。
   *
   * ## 为什么必须有一张显式的映射表
   *
   * 两层用的词表不一样，而且**不是因为谁写错了**：适配器的 `FAILURE_KINDS`
   * 面向「这次请求该怎么处置」（能不能重试、要不要换模型），健康账本的分类面向
   * 「这条渠道还要不要继续用」（冷却多久、要不要求用户换 key）。同一个失败在两边
   * 的正确答案不同，所以这里做一次**有记录的翻译**，而不是让两边互相猜：
   *
   * | 适配器 | 账本 | 理由 |
   * |---|---|---|
   * | credential | invalid-key | 凭据被拒 = 吊销，等不会恢复 |
   * | quota | quota | 额度问题，冷却到刷新点 |
   * | rate-limit | rate-limited | 限流，短冷却 |
   * | connection | network / timeout | 抖动 |
   * | server | server-error | 上游 5xx |
   * | upstream | server-error | 流内报错，也是上游的问题 |
   * | unknown-model / context / invalid-request | **null（不记）** | 这是**我们的请求**不对，渠道本身没病；记了会让好好的渠道被冻住 |
   * | aborted | **null（不记）** | 用户自己按的停止 |
   */
  const onOutcome = (event) => {
    const laneId = typeof event?.lane === 'string' ? event.lane : ''
    if (laneId === '') return
    if (event.ok === true) {
      health.recordSuccess(laneId)
      return
    }
    const kind = healthKindOf(event.kind)
    // 认不出来的失败**不记账**：宁可漏记一次（下一次请求会补上），
    // 也不要把「模型名写错了」记成「渠道坏了」—— 后者会让用户去查网络和 key。
    if (kind === null) return
    health.recordFailure(laneId, {
      kind,
      ...(Number.isFinite(event.status) ? { status: event.status } : {}),
      reason: typeof event.detail === 'string' ? event.detail : (event.advice ?? ''),
    })
  }

  const callDeps = () => ({
    readCredential: deps.readCredential,
    onOutcome,
    // 闸门与 availability 同一个实现：页面显示的「不可用」与发请求时被拒必须是同一套判据，
    // 否则会出现「卡片说冷却中、点下去却真的发出去了」这种自相矛盾。
    beforeRequest: (laneId) => health.isAvailable(laneId),
    logger,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.readImage !== undefined ? { readImage: deps.readImage } : {}),
    ...(deps.readImageRequest !== undefined ? { readImageRequest: deps.readImageRequest } : {}),
  })

  /** 重新算一遍「有哪些车道、各自就绪没有、凭据面什么状态」，并通知上层。 */
  async function refresh() {
    let rows = []
    try {
      rows = await descriptors({ readCredential: deps.readCredential })
    } catch (error) {
      logger?.warn?.(`dsh-free-model: keyed 描述符读取失败（${text(error)}）`)
    }
    records = rows
    const states = {}
    for (const row of rows) {
      const lane = laneById(row.id) ?? row
      try {
        states[row.id] = await laneKeyState(lane, {
          readCredential: deps.readCredential,
          describeCredential: deps.describeCredential,
        })
      } catch (error) {
        states[row.id] = {
          keyRef: keyRefOf(lane),
          configured: false,
          writable: false,
          source: 'error',
          masked: '',
          reason: '读取凭据状态失败：' + text(error),
        }
      }
    }
    keyStates = Object.freeze(states)
    const ready = Object.freeze(Object.fromEntries(rows.map((row) => [row.id, {
      ready: row.ready === true,
      reason: row.reason,
      ...(row.retired === true ? { retired: true } : {}),
    }])))
    // 健康状态与就绪状态**分开报**：`ready` 说「凭据配好了没」，
    // `health` 说「上一次真打上游的结果是什么」。合成一个字段的话，
    // 「key 填了但刚被 401 判死」和「还没填」会显示成同一件事。
    const snapshot = { records, ready, keyStates, keyCounts: { ...keyCounts }, disabled: [...disabled], health: health.snapshot() }
    try {
      deps.onUpdate?.(snapshot)
    } catch (error) {
      logger?.warn?.(`dsh-free-model: keyed 状态回调失败（${text(error)}）`)
    }
    return snapshot
  }

  /**
   * 保证某条就绪车道已经挂上（幂等）。
   *
   * @returns {Promise<{ mounted: boolean, reason?: string }>}
   */
  async function ensureMounted(laneId) {
    if (mounted.has(laneId)) return { mounted: true }
    let result
    try {
      result = await mount(laneId, callDeps())
    } catch (error) {
      // 未就绪 / 已下线 —— 这不是错误，是「现在还不该挂」。原因本来就要显示给用户。
      return { mounted: false, reason: text(error) }
    }
    try {
      const handle = deps.register?.(result.route, result.adapter)
      mounted.set(laneId, { lane: result.lane, adapter: result.adapter, handle })
      // 记一下这条车道配了几把 key（0.6.0）：页面上「已配 3 把」比「已配」有用得多 ——
      // 它是免费额度的实际倍数。
      keyCounts[laneId] = typeof result.adapter?.keyCount === 'function' ? result.adapter.keyCount() : 1
      logger?.info?.(`dsh-free-model: keyed 车道 ${result.route} 已挂载`)
      return { mounted: true }
    } catch (error) {
      return { mounted: false, reason: '注册失败：' + text(error) }
    }
  }

  /** 起来时把当时就绪的全部挂上（等价于旧的 `mountAll`，但留下句柄）。 */
  async function mountAllReady() {
    await refresh()
    const done = []
    const failed = []
    for (const row of records) {
      if (row.mountable !== true) continue
      // 被关掉的车道不挂：模型选择器里干净，也是「关掉」这个动作的主要意义。
      if (disabled.has(row.id)) continue
      const outcome = await ensureMounted(row.id)
      if (outcome.mounted) done.push(row.id)
      else failed.push({ id: row.id, reason: outcome.reason ?? '' })
    }
    return { mounted: done, failed, total: records.length }
  }

  /**
   * 保存一把 key。
   *
   * 顺序刻意是「**先写凭据、再动适配器**」：写失败时运行中的状态一点都不变，
   * 用户看到的还是原来那套行为（而不是「页面说保存成功了、实际请求还用旧 key」）。
   */
  async function saveKey(laneId, rawValue) {
    const lane = laneById(laneId)
    if (lane === undefined) return { ok: false, code: 'unknown-lane', reason: `未知的 keyed 车道：${String(laneId)}` }
    const saved = await saveLaneKey(lane, rawValue, {
      writeCredential: deps.writeCredential,
    })
    if (saved.ok !== true) return saved
    probes.delete(laneId)
    // 已挂载的直接换 key：`setApiKey` 会一并作废目录缓存与失败状态（见 adapter.js）。
    const live = mounted.get(laneId)
    if (live !== undefined) {
      live.adapter.setApiKey?.(String(rawValue ?? '').trim())
    }
    await refresh()
    const after = await ensureMounted(laneId)
    return {
      ok: true,
      keyRef: saved.keyRef,
      masked: saved.masked ?? maskKey(rawValue),
      mounted: after.mounted,
      ...(after.mounted === false ? { mountReason: after.reason ?? '' } : {}),
    }
  }

  /** 清除一条车道的 key（凭据删掉，环境变量回退随即重新生效）。 */
  async function clearKey(laneId) {
    const lane = laneById(laneId)
    if (lane === undefined) return { ok: false, code: 'unknown-lane', reason: `未知的 keyed 车道：${String(laneId)}` }
    const cleared = await clearLaneKey(lane, { unsetCredential: deps.unsetCredential })
    if (cleared.ok !== true) return cleared
    probes.delete(laneId)
    const live = mounted.get(laneId)
    // ⚠️ 路由保留：适配器会抛 MISSING_CREDENTIAL 并带上「去哪拿 key」，比静默消失好。
    if (live !== undefined) live.adapter.setApiKey?.(null)
    await refresh()
    return { ok: true }
  }

  /**
   * 真发一句话（0.6.0）：这条才是「我填的 key 能不能干活」的答案。
   *
   * 结果**不进**健康账本：它是用户主动发起的一次诊断，而不是渠道在正常工作流里
   * 的表现。把它记成失败会让一条好渠道因为「我试的时候它正忙」而进冷却 ——
   * 那是最难解释的一种「莫名其妙不能用了」。
   */
  async function probeChat(laneId, options = {}) {
    const lane = laneById(laneId)
    if (lane === undefined) {
      return { ok: false, kind: 'missing-config', reason: '未知的 keyed 车道：' + String(laneId), ms: 0 }
    }
    const resolved = await resolveApiKey(lane, { readCredential: deps.readCredential })
    return await probeLaneChat(lane, {
      apiKey: resolved.key ?? '',
      ...(typeof options.model === 'string' && options.model !== '' ? { model: options.model } : {}),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      logger,
    })
  }

  /** 余额查询缓存：成功 60 秒（余额变化以分钟计，没必要每点一次都打上游）。 */
  const balances = new Map()

  /**
   * 查一条车道的余额（0.6.0）。
   *
   * 与 key 探测**刻意分开**：那个回答「key 能不能用」，这个回答「还剩多少」。
   * 两个问题都可能只答得上一半（比如 key 有效但这条渠道没有余额端点），
   * 合成一次调用会让页面拿不到另一半信息。
   *
   * 失败**不抛**：余额是附加信息，任何失败只让「查额度」按钮显示一句原因。
   */
  async function probeBalance(laneId, options = {}) {
    const lane = laneById(laneId)
    if (lane === undefined) {
      return { ok: false, kind: 'missing-config', reason: '未知的 keyed 车道：' + String(laneId), ms: 0 }
    }
    const cached = balances.get(laneId)
    if (cached !== undefined && options.force !== true && Date.now() - cached.at < 60_000) {
      return { ...cached.result, cached: true }
    }
    const resolved = await resolveApiKey(lane, { readCredential: deps.readCredential })
    const result = await probeLaneBalance(lane, {
      apiKey: resolved.key ?? '',
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      timeoutMs: BALANCE_TIMEOUT_MS,
      logger,
    })
    balances.set(laneId, { result, at: Date.now() })
    return result
  }

  /**
   * 探测一条车道的 key。
   *
   * 缓存规则：成功 60 秒、失败 20 秒；`force` 跳过缓存（用户点按钮时要真打一次）。
   */
  async function probeKey(laneId, options = {}) {
    const lane = laneById(laneId)
    if (lane === undefined) {
      return { ok: false, code: 'unknown-lane', kind: 'missing-config', reason: `未知的 keyed 车道：${String(laneId)}`, ms: 0 }
    }
    const cached = probes.get(laneId)
    if (cached !== undefined && options.force !== true) {
      const ttl = cached.ok ? PROBE_CACHE_TTL_MS : PROBE_FAILURE_TTL_MS
      if (Date.now() - cached.at < ttl) return { ...cached.result, cached: true }
    }
    // ⚠️ 并发去重（0.6.0，审计的 P1-8）：前端探测一律 `force:true`，于是 60/20 秒的
    // 结果缓存被绕过；而快速连点 / 多标签页会各自发一次上游请求（每次 8 秒）。
    // `force` 只跳过**结果**缓存，不该跳过**去重** —— 这两个是不同的问题：
    // 「我想看最新结论」不等于「我要同时打五次上游」。
    const inflight = probesInflight.get(laneId)
    if (inflight !== undefined) return await inflight
    const pending = (async () => {
      const resolved = await resolveApiKey(lane, { readCredential: deps.readCredential })
      const result = await probeLaneKey(lane, {
        apiKey: resolved.key ?? '',
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(Number.isFinite(deps.probeTimeoutMs) ? { timeoutMs: deps.probeTimeoutMs } : {}),
        logger,
      })
      probes.set(laneId, { result, at: Date.now(), ok: result.ok === true })
      // 探测**就是**一次真实请求，所以它是健康账本最好的信息来源：
      // 用户点「测试 key」得到的那一次结果，直接决定这条渠道接下来 30 秒 / 6 小时 / 永久的状态。
      //
      // ⚠️ 只有「凭据真的发出去了」才记账：`no-key` / `missing-config` 说的是本插件自己的
      // 配置问题（没填 key、车道已下线），记成渠道故障会让用户在补 key 之前就看到一条
      // 「冷却中」的红字，方向完全错。
      if (result.ok === true) {
        health.recordSuccess(laneId)
      } else if (isUpstreamVerdict(result.kind)) {
        health.recordFailure(laneId, {
          kind: result.kind,
          ...(Number.isFinite(result.status) ? { status: result.status } : {}),
          ...(Number.isFinite(result.retryAfterMs) ? { retryAfterMs: result.retryAfterMs } : {}),
          reason: typeof result.reason === 'string' ? result.reason : '',
        })
      }
      return result
    })()
    probesInflight.set(laneId, pending)
    try {
      return await pending
    } finally {
      probesInflight.delete(laneId)
    }
  }

  /** 这条车道现在还能不能打（页面用它决定按钮是否灰、以及给什么下一步）。 */
  function availability(laneId) {
    if (disabled.has(String(laneId))) {
      return { available: false, state: 'disabled', reason: '这条渠道已被你在设置页里关掉（重新打开即可恢复）', until: null, halfOpen: false }
    }
    return health.isAvailable(laneId)
  }

  /**
   * 开关一条渠道：写盘 + 立刻落到运行态。
   *
   * - 关：尝试释放路由（宿主给 disposer 就释放），并把它从 mounted 里摘掉；
   *   释放失败也不报错 —— 闸门（availability）会替我们把请求挡下来，
   *   所以「关掉」这件事在任何宿主版本上都是成立的。
   * - 开：按正常路径挂上（未就绪就如实说原因）。
   */
  async function setEnabled(laneId, enabled) {
    const id = String(laneId)
    if (enabled === true) disabled.delete(id)
    else disabled.add(id)
    saveDisabled(deps.disabledFile, disabled, logger)
    if (enabled !== true) {
      const live = mounted.get(id)
      if (live !== undefined) {
        try {
          if (typeof live.handle === 'function') live.handle()
          else if (typeof live.handle?.dispose === 'function') live.handle.dispose()
        } catch (error) {
          logger?.warn?.('[dsh-free-model] 释放 ' + id + ' 的路由失败（闸门仍然生效）：' + (error instanceof Error ? error.message : String(error)))
        }
        mounted.delete(id)
      }
      return { ok: true, enabled: false, disabled: [...disabled] }
    }
    const outcome = await ensureMounted(id)
    return { ok: true, enabled: true, mounted: outcome.mounted, ...(outcome.mounted === false ? { mountReason: outcome.reason ?? '' } : {}) }
  }

  /** 当前被关掉的渠道（页面渲染开关态用）。 */
  function disabledLanes() {
    return [...disabled]
  }

  /** 健康账本快照（`GET /health` 的正文）。 */
  function healthSnapshot() {
    const snap = health.snapshot()
    const lanes = {}
    for (const [laneId, record] of Object.entries(snap.lanes ?? {})) {
      lanes[laneId] = { ...record, text: describeHealth(record) }
    }
    return { generatedAt: snap.generatedAt, lanes }
  }

  /** 清掉健康状态：不传 laneId 就全清（页面的「重新探测全部」前置动作）。 */
  function resetHealth(laneId) {
    health.reset(laneId)
    probes.clear()
    return healthSnapshot()
  }

  /**
   * 各条已挂载车道的**目录诊断**（含「静态表与上游目录一个都对不上」的怀疑标记）。
   *
   * 只问已挂载的：未挂载的车道没有适配器实例，也就没有实时目录可比较。
   */
  function catalogDiagnostics() {
    const result = {}
    for (const [laneId, entry] of mounted) {
      try {
        const diagnostics = entry.adapter?.catalogDiagnostics?.()
        if (diagnostics !== undefined) result[laneId] = diagnostics
      } catch {
        // 单条诊断失败不该影响整页
      }
    }
    return result
  }

  /** 页面渲染用的同步快照（不发网络）。 */
  function snapshot() {
    return {
      records,
      keyStates,
      keyCounts: { ...keyCounts },
      mounted: [...mounted.keys()],
      probes: Object.fromEntries([...probes].map(([id, entry]) => [id, { ...entry.result, at: entry.at }])),
    }
  }

  /**
   * 批量探测「已配置凭据」的车道。
   *
   * ## 为什么并发必须是 1（串行）
   *
   * 免费渠道的限流几乎全是**按 IP / 按账号**的，而这里探的又是同一个账号名下的多条渠道。
   * 并发探测在页面上只会表现为「一半渠道莫名其妙被限流」—— 结论是错的，而且会**真的**
   * 把额度窗口推远。30 条渠道 × 平均 1 秒 = 半分钟，用户等得起。
   *
   * ## 为什么跳过 `force`
   *
   * 批量按钮走**缓存**（成功 60 秒 / 失败 20 秒）：用户连点两次不该把上游打两轮。
   * 想强刷就逐条点探测（那条才是 `force: true`）。
   *
   * @param {{ onlyConfigured?: boolean, force?: boolean }} [options]
   * @returns {Promise<{ results: object[], probed: number, skipped: number }>}
   */
  async function probeAllKeys(options = {}) {
    const onlyConfigured = options.onlyConfigured !== false
    const force = options.force === true
    const results = []
    let skipped = 0
    for (const row of records) {
      if (row.kind !== 'keyed') continue
      if (onlyConfigured) {
        const state = keyStates[row.id]
        // 免 key 渠道（没有 keystate）照样探：它们也有端点活着/死掉的区别。
        const keyless = row.apiKeyEnv === null || row.apiKeyEnv === undefined
        if (keyless === false && state?.configured !== true) { skipped += 1; continue }
      }
      try {
        const result = await probeKey(row.id, { force })
        results.push({ lane: row.id, ...result })
      } catch (error) {
        results.push({ lane: row.id, ok: false, kind: 'network', ms: 0, reason: text(error) })
      }
    }
    return { results, probed: results.length, skipped }
  }
  return {
    refresh,
    ensureMounted,
    mountAllReady,
    saveKey,
    clearKey,
    probeKey,
    probeAllKeys,
    probeBalance,
    probeChat,
    setEnabled,
    disabledLanes,
    catalogDiagnostics,
    snapshot,
    availability,
    healthSnapshot,
    resetHealth,
  }
}

/** 读「被关掉的车道」清单（文件坏掉就当空集，warn 一次，绝不抛）。 */
function loadDisabled(file, logger) {
  if (typeof file !== 'string' || file === '' || !existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed?.disabled) ? parsed.disabled : []
    return list.filter((item) => typeof item === 'string' && item !== '')
  } catch (error) {
    logger?.warn?.('[dsh-free-model] 渠道开关文件读不出来：' + (error instanceof Error ? error.message : String(error)))
    return []
  }
}

/** 原子写「被关掉的车道」清单。失败只 warn：开关是增强，不能反过来把页面打死。 */
function saveDisabled(file, ids, logger) {
  if (typeof file !== 'string' || file === '') return
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify({ version: 1, disabled: [...ids].sort() }, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    logger?.warn?.('[dsh-free-model] 渠道开关写盘失败：' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * 适配器的失败类别 → 健康账本吃的分类。
 *
 * ## 为什么必须有一张显式的映射表
 *
 * 两层用的词表不一样，而且**不是因为谁写错了**：适配器的 `FAILURE_KINDS`
 * 面向「这次请求该怎么处置」（能不能重试、要不要换模型），健康账本的分类面向
 * 「这条渠道还要不要继续用」（冷却多久、要不要求用户换 key）。同一个失败在两边
 * 的正确答案不同，所以这里做一次**有记录的翻译**，而不是让两边互相猜：
 *
 * | 适配器 | 账本 | 理由 |
 * |---|---|---|
 * | credential | invalid-key | 凭据被拒 = 吊销，等不会恢复 |
 * | quota | quota | 额度问题，冷却到刷新点 |
 * | rate-limit | rate-limited | 限流，短冷却 |
 * | connection | network | 抖动 |
 * | server | server-error | 上游 5xx |
 * | upstream | server-error | 流内报错，也是上游的问题 |
 * | unknown-model / context / invalid-request | **null（不记）** | 这是**我们的请求**不对，渠道本身没病；记了会让好好的渠道被冻住 |
 * | aborted | **null（不记）** | 用户自己按的停止 |
 *
 * @param {string} kind 适配器的 FAILURE_KINDS 之一
 * @returns {string|null} 账本认的分类；null = 不进冷却
 */
export function healthKindOf(kind) {
  switch (String(kind ?? '')) {
    case 'credential': return 'invalid-key'
    case 'quota': return 'quota'
    case 'rate-limit': return 'rate-limited'
    case 'connection': return 'network'
    case 'server': return 'server-error'
    case 'upstream': return 'server-error'
    default: return null
  }
}

/**
 * 这次探测结果算不算「上游对这条渠道的判决」。
 *
 * 只有真把请求发出去、并拿到上游结论的那几档才算：`ok` 走成功分支，这里列失败侧。
 * `no-key` / `missing-config` 是**我们自己**的配置问题，不记；
 * `bad-request` 是参数问题，也不该让渠道进冷却（`health.classifyFailure` 会把它判成 ok）。
 */
function isUpstreamVerdict(kind) {
  return [
    'invalid-key',
    'forbidden',
    'rate-limited',
    'quota',
    'not-found',
    'server-error',
    'network',
    'timeout',
  ].includes(String(kind ?? ''))
}

/** 错误 → 一行可显示的文本（绝不回显可能的凭据）。 */
function text(error) {
  return error instanceof Error ? error.message : String(error)
}
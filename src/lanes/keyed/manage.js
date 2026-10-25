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
import { laneById } from './catalog.js'
import { resolveApiKey } from './ready.js'

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
 * }} deps
 * @returns {object} 见下方各方法的 jsdoc
 */
export function createKeyedManager(deps = {}) {
  const logger = deps.logger
  /** laneId → { lane, adapter, handle } */
  const mounted = new Map()
  /** laneId → { result, at, ok } */
  const probes = new Map()
  /** 最近一次 descriptors() 的结果（页面的行数据就是它）。 */
  let records = []
  /** laneId → 凭据面状态（已配置/来源/能否写/脱敏值）。 */
  let keyStates = Object.freeze({})

  const callDeps = () => ({
    readCredential: deps.readCredential,
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
    const snapshot = { records, ready, keyStates }
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
    const resolved = await resolveApiKey(lane, { readCredential: deps.readCredential })
    const result = await probeLaneKey(lane, {
      apiKey: resolved.key ?? '',
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      ...(Number.isFinite(deps.probeTimeoutMs) ? { timeoutMs: deps.probeTimeoutMs } : {}),
      logger,
    })
    probes.set(laneId, { result, at: Date.now(), ok: result.ok === true })
    return result
  }

  /** 页面渲染用的同步快照（不发网络）。 */
  function snapshot() {
    return {
      records,
      keyStates,
      mounted: [...mounted.keys()],
      probes: Object.fromEntries([...probes].map(([id, entry]) => [id, { ...entry.result, at: entry.at }])),
    }
  }

  return { refresh, ensureMounted, mountAllReady, saveKey, clearKey, probeKey, snapshot }
}

/** 错误 → 一行可显示的文本（绝不回显可能的凭据）。 */
function text(error) {
  return error instanceof Error ? error.message : String(error)
}

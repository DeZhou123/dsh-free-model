/**
 * `src/lanes/keyed/**` 的入口桶 + 给 registry 的接线面。
 *
 * 上层（`src/lanes/registry.js` 那一层）**只需要这两个函数**：
 *
 * ```js
 * import { descriptors, mount } from './keyed/index.js'
 *
 * // ① 拿描述符（就是"这一批车道长什么样、现在能不能用"）
 * const rows = await descriptors({ readCredential: (name) => hostCredentials.read(name) })
 * //  rows: [{ id, displayName, kind, protocol, baseURL, apiKeyEnv, region, ready, reason,
 * //            keyRef, retired, unknown, unknownFields, freeTier, docsURL, signupURL, note,
 * //            evidence, models, mountable }, …]
 *
 * // ② 就绪的车道挂适配器（未就绪的**不要挂**，挂了只会在模型选择器里留一堆必然报错的模型）
 * for (const row of rows) {
 *   if (!row.mountable) continue
 *   const mounted = await mount(row.id, { readCredential, logger, readImage, readImageRequest })
 *   scoped.llm.registerAdapter([mounted.route], mounted.adapter)   // 或用 registerAdapterIdempotent
 * }
 * ```
 *
 * ⚠️ 本模块**不做任何注册**、不碰 `ctx`：注册要留在上层，才能沿用
 * `src/core/register.js` 的幂等与记账包装（那里已经处理过 OFM 抢路由与 fiber 重启竞态）。
 *
 * @module src/lanes/keyed
 */

import { ALL_CHANNELS, KEYED_CHANNELS, KEYLESS_CHANNELS, RETIRED_CHANNELS, laneById, staticModels } from './catalog.js'
import { keyedLaneState, laneStates, resolveApiKey, resolveApiKeys } from './ready.js'
import { createKeyedAdapter } from './adapter.js'

export {
  ALL_CHANNELS,
  resolveApiKeys,
  KEYED_CHANNELS,
  KEYLESS_CHANNELS,
  RETIRED_CHANNELS,
  createKeyedAdapter,
  keyedLaneState,
  laneById,
  laneStates,
  resolveApiKey,
}

/**
 * 目录描述符：**页面与 registry 共用的唯一形状**。
 *
 * 把「数据（catalog）」+「就绪（ready）」+「适配器能不能挂（mountable）」合成一行，
 * 是为了让页面不必自己拼三次调用，也避免两处对「能不能用」给出不一致的答案。
 *
 * @param {{ readCredential?: (name:string) => unknown|Promise<unknown> }} [deps]
 * @param {{ includeRetired?: boolean, onlyReady?: boolean, region?: 'global'|'cn' }} [filter]
 * @returns {Promise<Array<object>>}
 */
export async function descriptors(deps = {}, filter = {}) {
  const includeRetired = filter.includeRetired === true
  const pool = includeRetired ? ALL_CHANNELS : [...KEYED_CHANNELS, ...KEYLESS_CHANNELS]
  const narrowed = typeof filter.region === 'string' ? pool.filter((lane) => lane.region === filter.region) : pool
  const { rows } = await laneStates(narrowed, deps)
  const out = rows.map(({ lane, state }) => ({
    id: lane.id,
    displayName: lane.displayName,
    kind: lane.kind,
    protocol: lane.protocol,
    baseURL: lane.baseURL,
    apiKeyEnv: lane.apiKeyEnv,
    region: lane.region,
    freeTier: lane.freeTier,
    docsURL: lane.docsURL,
    signupURL: lane.signupURL,
    note: lane.note,
    evidence: lane.evidence,
    models: staticModels(lane).map((row) => ({ ...row })),
    unknown: lane.unknown === true,
    unknownFields: Array.isArray(lane.unknownFields) ? [...lane.unknownFields] : [],
    retired: state.retired === true,
    ...(typeof lane.retiredOn === 'string' ? { retiredOn: lane.retiredOn } : {}),
    ready: state.ready === true,
    reason: state.reason,
    keyRef: state.keyRef ?? null,
    keySource: state.source,
    // 已下线的渠道永远不可挂 —— 挂了只会在选择器里留一列必然失败的模型。
    mountable: state.ready === true && state.retired !== true,
  }))
  return filter.onlyReady === true ? out.filter((row) => row.mountable) : out
}

/** `descriptors` 的别名（保留长名字，避免上层两种叫法各写一遍）。 */
export const keyedLaneDescriptors = descriptors

/**
 * 挂一条车道：解凭据 + 造适配器。**不注册**（见模块注释）。
 *
 * @param {string} laneId 目录 id
 * @param {{
 *   readCredential?: (name:string) => unknown|Promise<unknown>,
 *   logger?: object,
 *   fetchImpl?: Function,
 *   readImage?: Function,
 *   readImageRequest?: Function,
 *   route?: string,
 *   timeoutMs?: number,
 *   onOutcome?: (event: { lane: string, ok: boolean, kind?: string, status?: number }) => void,
 *   beforeRequest?: (laneId: string) => { available: boolean, state: string, reason: string },
 * }} deps
 * @returns {Promise<{ lane: object, route: string, adapter: object, readiness: object }>}
 * @throws 渠道不存在、已下线、或未就绪 —— 抛错文案直接可显示给用户；
 *         上层**不要**吞掉它当作"挂载失败"，因为那三种情况本来就该显示原因。
 */
export async function mount(laneId, deps = {}) {
  const lane = laneById(laneId)
  if (lane === undefined) throw new Error(`未知的 keyed 车道：${String(laneId)}`)
  const readiness = await keyedLaneState(lane, { readCredential: deps.readCredential })
  if (readiness.retired === true || readiness.ready !== true) {
    throw new Error(`${lane.id} 未就绪：${readiness.reason}`)
  }
  // 多把 key（同渠道轮换）：一次性解析成列表交给适配器，它自己管游标。
  // 单 key 时列表长度为 1，行为与旧实现逐字一致。
  const resolved = await resolveApiKeys(lane, { readCredential: deps.readCredential })
  const route = typeof deps.route === 'string' && deps.route !== '' ? deps.route : lane.id
  const adapter = createKeyedAdapter({
    lane,
    apiKey: Array.isArray(resolved.keys) ? (resolved.keys[0] ?? null) : resolved.key,
    apiKeys: Array.isArray(resolved.keys) ? resolved.keys : undefined,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
    readImage: deps.readImage,
    readImageRequest: deps.readImageRequest,
    timeoutMs: deps.timeoutMs,
    // 真实对话的结果回执（健康账本）。可选：没有注入时适配器完全不记账。
    ...(typeof deps.onOutcome === 'function' ? { onOutcome: deps.onOutcome } : {}),
    // 发请求前的健康闸门：冷却中的渠道不发请求（原因带剩余时间）。
    ...(typeof deps.beforeRequest === 'function' ? { beforeRequest: deps.beforeRequest } : {}),
  })
  return { lane, route, adapter, readiness }
}

/** 一次性挂所有就绪车道；单条失败不带走其余（返回成功与失败两张单）。 */
export async function mountAll(deps = {}) {
  const rows = await descriptors(deps, { onlyReady: true })
  const mounted = []
  const failed = []
  for (const row of rows) {
    try {
      mounted.push(await mount(row.id, deps))
    } catch (error) {
      failed.push({ id: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { mounted, failed }
}
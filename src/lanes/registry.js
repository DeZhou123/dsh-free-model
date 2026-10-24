/**
 * 渠道注册表 —— 「免费渠道总台」的唯一事实来源。
 *
 * ## 为什么要它
 *
 * 本插件此前长成两截：账号车道在 `index.js` 里手写一份清单，页面在 `client.js` 里
 * 再按 id 猜一遍每条车道的能力。渠道一多（13 条账号 + 服务型 + 自带 key），
 * 这种「两处各猜一次」的做法必然分叉 —— 而分叉的表现是**页面说能用、点下去报错**，
 * 最难查也最伤信任。
 *
 * 所以这里把三类渠道收敛成**一种记录形状**，由本模块统一产出：
 *
 * ```
 * account  账号型：buddy / workbuddy（本插件自己挂）+ 11 条（宿主 channel-pack 提供）
 * service  服务型：本机的免费入口（opencode / FreeLLMAPI 网关 / Ollama）
 * keyed    自带 key：注册即送额度的 OpenAI 兼容端点（有 key 才挂路由）
 * ```
 *
 * 记录的**能力位**（能不能调工具、能不能看图）和**积分能力**（能不能查余额、能不能签到）
 * 都在这里声明：它们都是**产品事实**，不是开关。页面对 `claim: false` 的车道
 * **不渲染**领取按钮 —— 而不是给一个点下去必然 404 的灰按钮。
 *
 * ## 目录分层（这是「不用发版就能加渠道」的实现）
 *
 * 随包记录 = shipped 层；远程 JSON = remote 层；用户本地文件 = local 层。
 * 三层同形状、按 id 覆盖，规则与理由见 `./catalog.js`。
 *
 * ## 一条刻意的分工：**不重复挂载**宿主已有的车道
 *
 * 11 条 OFM 车道的 auth / 适配器 / 路由全在宿主 `channel-pack` 里。本插件再挂一遍会撞
 * 两件硬事：① cordis 的 Service 同名注册直接抛（把整个 apply 打死）；
 * ② 两份 auth 实例并发消费同一个 refresh_token（表现为「刚登录却一直认证失败」）。
 * 所以它们的 `backend` 是 `ofm`：本插件只做**页面 + 管理面**，操作转发给宿主 RPC。
 *
 * @module src/lanes/registry
 */

import { BUDDY_PRODUCTS } from '../channels.js'
import { SERVICE_LANES } from './service.js'
import { catalogFingerprint, mergeCatalogs, normalizeChannelRecord } from './catalog.js'
import { OFM_LANES, OFM_RPC_ENDPOINT, OFM_RPC_PATH } from '../lanes.js'

export { OFM_RPC_ENDPOINT, OFM_RPC_PATH }

/** 本插件自己挂载的账号车道 id（其余账号车道在宿主侧）。 */
export const NATIVE_ACCOUNT_IDS = Object.freeze(['buddy', 'workbuddy'])

/**
 * 账号型车道的积分能力。
 *
 * ⚠️ `claim` 是**产品事实**，不是开关：CodeBuddy（国内版）有每日签到接口，
 * WorkBuddy 国际版的后端压根没有这个端点 —— 点一次返回 404 不会让它长出来。
 */
export const LANE_CREDITS = Object.freeze({
  buddy: Object.freeze({ balance: true, claim: true }),
  workbuddy: Object.freeze({ balance: true, claim: false, claimNote: 'WorkBuddy 国际版没有签到接口（其后端不提供）' }),
})

/**
 * 本插件自己挂的两条账号车道 → 目录记录。
 *
 * 这两条能当**主模型**用（agent loop 需要的工具调用与图片输入都支持），
 * 所以 `capability` 两项都是 true —— 这个判断写在这里而不是页面上。
 */
export function nativeAccountRecords() {
  return normalizeAll(BUDDY_PRODUCTS.map((product) => ({
    id: product.id,
    displayName: product.displayName,
    kind: 'account',
    backend: 'native',
    native: true,
    endpoint: product.endpoint,
    category: product.id === 'buddy' ? '腾讯' : '腾讯国际',
    login: 'browser',
    capability: { tools: true, vision: true },
    credits: LANE_CREDITS[product.id] ?? { balance: false, claim: false },
    note: '完整能力（工具调用 + 看图）：可以当主模型用。免费模型跳过积分分档。',
    models: (product.fallbackModels ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutputTokens !== undefined ? { maxTokens: model.maxOutputTokens } : {}),
      ...(model.supportsImages !== undefined ? { vision: model.supportsImages } : {}),
    })),
  })))
}

/** 宿主 channel-pack 提供的 11 条账号车道 → 目录记录（原样搬运元数据）。 */
export function ofmAccountRecords() {
  return normalizeAll(OFM_LANES.map((lane) => ({
    id: lane.id,
    displayName: lane.displayName,
    kind: 'account',
    backend: 'ofm',
    endpoint: lane.endpoint,
    category: hostCategoryOf(lane.id),
    credits: lane.credits,
    login: lane.login,
    ...(lane.smsFallback === true ? { smsFallback: true } : {}),
    ...(lane.note !== undefined ? { note: lane.note } : {}),
    models: [],
  })))
}

/** 服务型车道（本机免费入口）→ 目录记录。 */
export function serviceRecords() {
  return normalizeAll(SERVICE_LANES.map((lane) => ({ ...lane, category: lane.category ?? '本地' })))
}

/**
 * 把本插件**自己声明**的渠道也过一遍与远程目录同一套规范化。
 *
 * ## 为什么自家数据也要校验（不是多此一举）
 *
 * 1. **形状一致**：三类渠道最终要在同一个页面上渲染、进同一张注册表。若自家的
 *    记录少个 `models` 字段，页面就要为「内置的多一个分支」——分叉就是这么开始的。
 * 2. **同一套尺子**：内置数据出错时（id 写错、URL 带 query），规范化会把它挑出来，
 *    而不是让它悄悄进到运行时。远程数据要过的关，自家数据也该过。
 *
 * 唯一的代价是内置记录被冻结（`Object.freeze`），这与它们的用途一致：它们只读。
 */
function normalizeAll(records) {
  const out = []
  for (const raw of records) {
    const result = normalizeChannelRecord(raw, 'shipped')
    if (result.ok) out.push(result.channel)
  }
  return out
}

/**
 * 按 id 组装注册表。
 *
 * @param {{
 *   keyed?: unknown[],        // 自带 key / 无 key 车道（子模块产出，可为空数组）
 *   remote?: unknown[],       // 远程目录的 channels
 *   local?: unknown[],        // 用户本地覆盖的 channels
 * }} [layers]
 * @returns {{
 *   channels: object[], rejected: string[], byLayer: Record<string, number>,
 *   fingerprint: string, counts: Record<string, number>,
 * }}
 */
export function buildRegistry(layers = {}) {
  const shipped = [...nativeAccountRecords(), ...ofmAccountRecords(), ...serviceRecords()]
  const merged = mergeCatalogs([
    { layer: 'shipped', channels: shipped },
    { layer: 'remote', channels: layers.remote ?? [] },
    { layer: 'local', channels: layers.local ?? [] },
  ])

  // 自带 key 车道也走一遍同样的校验：它们的字段来自另一个模块（甚至远程目录），
  // 但**记录形状必须一致**，否则页面又要为「keyed 多一个字段」写分支。
  const keyed = []
  const keyedRejected = []
  for (const raw of Array.isArray(layers.keyed) ? layers.keyed : []) {
    const result = normalizeChannelRecord(raw, 'shipped')
    if (result.ok) keyed.push(result.channel)
    else keyedRejected.push(result.reason)
  }

  const byKind = (kind) => merged.channels.filter((channel) => channel.kind === kind)
  const channels = [
    ...byKind('account'),
    ...keyed,
    ...byKind('service'),
  ]
  const counts = {
    account: byKind('account').length,
    keyed: keyed.length,
    service: byKind('service').length,
    total: channels.length,
  }
  return {
    channels,
    rejected: [...merged.rejected, ...keyedRejected],
    byLayer: { ...merged.byLayer, shipped: merged.byLayer.shipped + keyed.length },
    fingerprint: catalogFingerprint(channels),
    counts,
  }
}

/** 按 id 取一条渠道。 */
export function channelById(channels, id) {
  return channels.find((channel) => channel.id === id)
}

/**
 * 把注册表投影成「页面能直接渲染」的行。
 *
 * ## 为什么就绪状态要在这里算，而不是页面算
 *
 * 「能不能用」这件事要问**运行时**（本插件的路由挂上了没、宿主 channel-pack 在不在、
 * 本地服务探针通不通、key 有没有）。这些信息页面都拿不到，硬让页面猜的结果是
 * 「所有渠道都显示正常，点下去一半报错」。
 *
 * 四种状态刻意分清（合成一个词会让用户乱试方向）：
 * - `ready`        现在就能用
 * - `needs-action` 能用，但要用户先做一件事（登录 / 补 key / 起服务 / 领积分）
 * - `unavailable`  现在不可用，且**用户做什么都没用**（上游拒了、额度耗尽、后端没装）
 * - `unknown`      判断不了（本插件的问题，不是用户的问题）
 *
 * @param {object[]} channels
 * @param {{
 *   nativeMounted?: Set<string> | string[],
 *   ofmReady?: boolean,
 *   serviceProbes?: Record<string, { state: string, reason: string, models?: string[] }>,
 *   keyedReady?: Record<string, { ready: boolean, reason?: string }>,
 * }} runtime
 */
export function projectRegistryView(channels, runtime = {}) {
  const mounted = runtime.nativeMounted instanceof Set
    ? runtime.nativeMounted
    : new Set(Array.isArray(runtime.nativeMounted) ? runtime.nativeMounted : [])
  return channels.map((channel) => {
    const readiness = readinessOf(channel, runtime, mounted)
    return {
      id: channel.id,
      displayName: channel.displayName,
      kind: channel.kind,
      backend: channel.backend,
      origin: channel.origin,
      ...(channel.category !== undefined ? { category: channel.category } : {}),
      ...(channel.endpoint !== undefined ? { endpoint: channel.endpoint } : {}),
      ...(channel.login !== undefined ? { login: channel.login } : {}),
      ...(channel.smsFallback === true ? { smsFallback: true } : {}),
      ...(channel.apiKeyEnv !== undefined ? { apiKeyEnv: channel.apiKeyEnv } : {}),
      capability: channel.capability,
      credits: channel.credits,
      ...(channel.note !== undefined ? { note: channel.note } : {}),
      ...(channel.freeTier !== undefined ? { freeTier: channel.freeTier } : {}),
      ...(channel.docsURL !== undefined ? { docsURL: channel.docsURL } : {}),
      ...(channel.signupURL !== undefined ? { signupURL: channel.signupURL } : {}),
      ...(channel.startable === true ? { startable: true } : {}),
      ...(channel.native === true ? { native: true } : {}),
      ...(channel.unknown === true ? { unknown: true } : {}),
      ...(channel.extra !== undefined ? { extra: channel.extra } : {}),
      modelCount: channel.models.length,
      state: readiness.state,
      reason: readiness.reason,
    }
  })
}

function readinessOf(channel, runtime, mounted) {
  if (channel.kind === 'account') {
    if (channel.backend === 'ofm') {
      return runtime.ofmReady === true
        ? { state: 'ready', reason: '由宿主 channel-pack 提供，页面用它的 RPC 操作' }
        : { state: 'unavailable', reason: '宿主 channel-pack 未就绪（没装 dsh-our-free-model 或它没跑）' }
    }
    if (!mounted.has(channel.id)) {
      return { state: 'unavailable', reason: `本插件的 ${channel.displayName} 通道未挂载（见宿主日志）` }
    }
    return { state: 'ready', reason: '本插件接管：可以登录、查积分、续期' }
  }
  if (channel.kind === 'service') {
    const probe = runtime.serviceProbes?.[channel.id]
    if (probe === undefined) return { state: 'unknown', reason: '还没探测过这条服务车道' }
    return { state: probe.state, reason: probe.reason }
  }
  // keyed / keyless
  const ready = runtime.keyedReady?.[channel.id]
  if (ready === undefined) {
    return channel.apiKeyEnv === undefined
      ? { state: 'ready', reason: '不需要 key（免登录直连）' }
      : { state: 'unknown', reason: '还没检查过凭据' }
  }
  if (ready.ready === true) return { state: 'ready', reason: ready.reason ?? '凭据已就绪' }
  return {
    state: 'needs-action',
    reason: ready.reason ?? `缺凭据 ${channel.apiKeyEnv ?? '?'}：去 ${channel.signupURL ?? '上游控制台'} 拿 key 后填进 DSH 凭据`,
  }
}

/** 宿主 channel-pack 的导航分组（页面按这个排序，与 OFM 面板同序）。 */
function hostCategoryOf(id) {
  const table = {
    codearts: '华为',
    lobsterai: '有道',
    qoder: '阿里',
    qodercn: '阿里',
    trae: '字节',
    cline: 'Cline',
    loomy: '讯飞',
    raccoon: '商汤',
    minimax: 'MiniMax',
    gemini: 'Google',
    zcode: '智谱',
  }
  return table[id] ?? '其它'
}
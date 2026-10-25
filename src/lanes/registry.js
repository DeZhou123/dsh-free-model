/**
 * 渠道注册表 —— 「免费渠道总台」的唯一事实来源。
 *
 * ## 为什么要它
 *
 * 本插件此前长成两截：账号车道在 `index.js` 里手写一份清单，页面在 `client.js` 里
 * 再按 id 猜一遍每条车道的能力。渠道一多（账号两条 + 服务型 + 自带 key），
 * 这种「两处各猜一次」的做法必然分叉 —— 而分叉的表现是**页面说能用、点下去报错**，
 * 最难查也最伤信任。
 *
 * 所以这里把三类渠道收敛成**一种记录形状**，由本模块统一产出：
 *
 * ```
 * account  账号型：buddy / workbuddy（本插件自己挂载 auth + 适配器）
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
 * ## 一条刻意的分工：账号车道只由本插件挂一次
 *
 * 每条账号车道的 auth / 适配器 / 路由都只挂一次：cordis 的 Service 同名注册会直接抛
 * （把整个 apply 打死），两份 auth 实例并发消费同一个 refresh_token 又会表现为
 * 「刚登录却一直认证失败」。所以注册表里的账号记录一律 `backend: 'native'`：
 * 页面与 HTTP 面共用同一套实现，不存在第二份后端。
 *
 * @module src/lanes/registry
 */

import { BUDDY_PRODUCTS } from '../channels.js'
import { SERVICE_LANES } from './service.js'
import { catalogFingerprint, mergeCatalogs, normalizeChannelRecord } from './catalog.js'

/** 本插件自己挂载的账号车道 id。 */
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
  // ⚠️ 随包的自带 key 车道**不是**一层，而是**随包层**的一部分。
  //
  // 2026-10-26 修（本插件的 P0-2，审计发现）：「加渠道不用发版」这句承诺原来对 keyed 不成立 ——
  // 远程/本地目录里的 keyed 渠道被吃进 merged 之后，又因为只取
  // byKind('account') / layers.keyed / byKind('service') 而被**静默丢掉**（连 rejected 都不进），
  // 于是用户按文档往 channels.local.json 里加一条 keyed 渠道，页面上一片平静。
  //
  // 现在的分层：随包的 nativeAccountRecords + serviceRecords + layers.keyed 一起当 **shipped**，
  // 再让 remote / local 按 id 覆盖它 —— 与 README 里写的三层语义终于一致了。
  const shipped = [
    ...nativeAccountRecords(),
    ...serviceRecords(),
    ...(Array.isArray(layers.keyed) ? layers.keyed : []),
  ]
  const merged = mergeCatalogs([
    { layer: 'shipped', channels: shipped },
    { layer: 'remote', channels: layers.remote ?? [] },
    { layer: 'local', channels: layers.local ?? [] },
  ])

  const byKind = (kind) => merged.channels.filter((channel) => channel.kind === kind)
  const channels = [
    ...byKind('account'),
    // keyed 是**合并后**的那一批：随包的 30 条 + 远程/本地新增或覆盖的那些。
    ...byKind('keyed'),
    ...byKind('service'),
  ]
  const counts = {
    account: byKind('account').length,
    keyed: byKind('keyed').length,
    service: byKind('service').length,
    total: channels.length,
  }
  return {
    channels,
    rejected: merged.rejected,
    byLayer: merged.byLayer,
    counts,
    fingerprint: catalogFingerprint(channels),
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
 * 「能不能用」这件事要问**运行时**（本插件的路由挂上了没、
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
 *   serviceProbes?: Record<string, { state: string, reason: string, models?: string[] }>,
 *   keyedReady?: Record<string, { ready: boolean, reason?: string }>,
 * }} runtime
 */
export function projectRegistryView(channels, runtime = {}) {
  /**
   * 「本插件自己挂了哪些路由」有三种形态，**三种都要认**。
   *
   * ⚠️ 2026-10-26 修（本插件自己的 P0，被测试替身掩盖了很久）：
   * `index.js` 传进来的是一张 **Map**（`channels: Map<route, mounted>`），
   * 而这里原来只判 `Set` 与数组 —— 两个分支都不命中，于是`mounted` 恒为空集，
   * 结果 **buddy / workbuddy 在 `/channels` 里永远是"不可用：通道未挂载"**，
   * 而它们其实挂得好好的。页面显示的是最容易被相信的那种错：一个具体的、
   * 指向别处（宿主日志）的原因。
   *
   * 教训写在这里：**"我传的形状"与"你读的形状"是两处独立事实**，
   * 只认一种形态的判据迟早会在某次重构后静默变成"什么都读不到"。
   */
  const mounted = runtime.nativeMounted instanceof Set
    ? runtime.nativeMounted
    : runtime.nativeMounted instanceof Map
      ? new Set(runtime.nativeMounted.keys())
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
      // 目录免 key 可读：页面据此在探测结果旁边挂一句「通过≠有额度」。
      ...(channel.openCatalog === true ? { openCatalog: true } : {}),
      // 这条渠道能不能查余额（0.6.0）：**只暴露布尔**，不把端点交给页面 ——
      // 页面拿不到端点就没人能拼一个「带 key 去打任意地址」的请求。
      ...(channel.balance !== undefined ? { hasBalance: true } : {}),
      // 这条渠道能不能查套餐窗口（0.6.0）：同样只暴露布尔，端点不下发到页面。
      ...(channel.windows !== undefined ? { hasWindows: true } : {}),
      ...(channel.native === true ? { native: true } : {}),
      ...(channel.unknown === true ? { unknown: true } : {}),
      ...(channel.extra !== undefined ? { extra: channel.extra } : {}),
      modelCount: channel.models.length,
      /**
       * 前 8 个模型 id（页面在卡片上摊开用）。
       *
       * ## 为什么只给 id 的前 8 条，而不是整份 `models`
       *
       * 30 条渠道 × 平均 5 条模型 = 150 行，一次 `/channels` 就要多送几十 KB，
       * 而页面上真正用得上的只有「这条渠道有没有我认识的那个模型」。
       * 需要完整清单时页面走 `/key/probe`（它会带回**实测**的上游目录，比静态表准）。
       *
       * 字段名刻意叫 `modelSample` 而不是 `models`：后者会让人以为这是完整目录，
       * 于是拿它去渲染「模型开关」那种需要全量数据的界面。
       */
      modelSample: channel.models.slice(0, 8).map((model) => model.id),
      state: readiness.state,
      reason: readiness.reason,
    }
  })
}

function readinessOf(channel, runtime, mounted) {
  if (channel.kind === 'account') {
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
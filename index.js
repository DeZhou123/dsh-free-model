/**
 * dsh-free-model —— 免费模型总台。
 *
 * ## 一句话
 *
 * 把三条「不用花钱」的模型车道装进 DSH，用一个页面管起来：
 *
 * | 车道 | 路由 | 能力 | 依赖 |
 * |---|---|---|---|
 * | CodeBuddy（腾讯国内版） | `buddy/*` | 完整（含工具、看图） | 账号 |
 * | WorkBuddy（腾讯国际版） | `workbuddy/*` | 完整（含工具、看图） | 账号 |
 * | OpenCode 免费层 | `opencode/*` | **纯文本**（无工具） | 本地 `opencode serve` |
 *
 * ## 与前身 dsh-free-model 的关系
 *
 * 前两条车道整套从那里搬来（`src/core/` 逐行保留原注释），但**拆掉了对 OFM 的
 * 隐含依赖**：
 *
 * - 账号池：有 OFM 时用它的 `accountPool`（同一份账号、同一份限流标记），
 *   没有时退化成 `LocalPool`，读写**同一个** `$DSH_HOME/channel-pack/state.json`；
 * - 凭据：走宿主 `credentials` 服务（DSH 自带），与 OFM 无关；
 * - 账本：OFM 的 `token-ledger` 是它包内的内部模块，硬 import 会在版本变动时
 *   把整个插件打死。这里**不接**，记账退化为 no-op（推理不受影响）。
 *
 * 也就是说：**只装本插件、不装 OFM，三条车道全部可用。**
 *
 * ## 第三条车道为什么是「纯文本」
 *
 * opencode 的 `serve` 只接受 `tools: { [name]: boolean }`（它内置工具的开关表），
 * 没有任何入口能传入调用方自己的工具 schema。DSH 的 agent loop 靠 tool call
 * 驱动，所以这条车道**不能当主模型**，只适合标题生成、摘要、翻译这类小请求。
 * 页面上把这件事写在卡片里，而不是等用户自己发现。
 *
 * @module index
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mountBuddyChannel, BUDDY_PRODUCTS } from './src/channels.js'
import { poolView, ensureFallbackPool, resolveDshHome } from './src/pool.js'
import { createCreditsService } from './src/credits-service.js'
import { createAutoCheckin, createAutoCheckinStore } from './src/auto-checkin.js'
import { livePool } from './src/live-pool.js'
import { createRoutes } from './src/routes.js'
import { connectionAdmissionView } from './src/trust.js'
import { registerAdapterIdempotent } from './src/core/register.js'
import { OpenCodeAdapter, OPENCODE_ROUTE } from './src/opencode/adapter.js'
import { OpenCodeService } from './src/opencode/service.js'

const PKG_DIR = dirname(fileURLToPath(import.meta.url))

/** 插件名（cordis 用它做 fiber 标签与日志前缀）。 */
export const name = 'dsh-free-model'

/** 硬依赖：没有 llm 与 credentials 就装不出任何东西。 */
export const inject = ['llm', 'credentials']

/** 版本号从 package.json 读，避免两处写死。 */
export const version = readPackageVersion()

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * 挂载。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   opencodeBinary?: string,
 *   opencodePort?: number,
 *   autoStartOpenCode?: boolean,
 *   autoCheckin?: boolean,          // 传 false 强制关闭每日自动领积分
 *   autoCheckinDelayMs?: number,    // 启动后延迟多久跑（默认 30 秒，0 = 立即）
 *   creditsFetcher?: typeof fetch,  // 测试接缝：替换积分接口的 fetch
 * }} [config]
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger

  // ── 账号池：晚绑定宿主池，缺席时退化为本地实现 ──────────────────────────────
  const view = poolView(ctx)
  const pool = livePool(view)
  let fallbackDispose = () => {}
  ctx.effect(() => () => fallbackDispose(), 'dsh-free-model: fallback pool')

  // ── 积分：余额查询与一键领取共用一套实现（页面与自动领取都调它） ─────────────
  //
  // `config.creditsFetcher` 与 `config.opencodeService` 一样是**测试接缝**：
  // 单测要断言路由与「一键领取」的结果，但不该真的打腾讯的计费接口。
  const credits = createCreditsService({
    pool: () => pool,
    products: ALL_LANES,
    logger,
    ...(config.creditsFetcher !== undefined ? { fetcher: config.creditsFetcher } : {}),
  })

  // ── 每日自动领积分：独立状态文件，不碰 OFM 那份 auto-checkin.json ──────────
  //
  // ⚠️ 领取动作走 credits.claim（与页面上的「一键领取」同一条路径）：
  // 两处各写一遍领取循环，迟早会在「哪些账号要跳过」上分叉。
  const autoCheckin = createAutoCheckin({
    store: createAutoCheckinStore(resolveDshHome(ctx), logger),
    providers: ALL_LANES,
    claim: (provider) => credits.claim(provider),
    logger,
    ...(config.autoCheckinDelayMs !== undefined ? { delayMs: config.autoCheckinDelayMs } : {}),
  })
  ctx.effect(() => () => autoCheckin.stop(), 'dsh-free-model: auto checkin')
  // 配置项可以强制关掉（`autoCheckin: false`）：默认开着是产品判断，
  // 但用户明确不要这个动作时，不该靠「装完再进页面点一下」才能关。
  if (config.autoCheckin === false) {
    void autoCheckin.setEnabled(false)
  } else {
    autoCheckin.start()
  }

  // ── OpenCode 服务：先探测，不主动起（页面上的按钮才起） ──────────────────────
  //
  // `config.opencodeService` 是**测试/嵌入接缝**：单测传一个替身即可，不必真的
  // spawn 一个 Bun 进程。生产路径永远走 `new OpenCodeService(...)`。
  const service = config.opencodeService ?? new OpenCodeService({
    binary: config.opencodeBinary,
    port: config.opencodePort,
    logger,
  })
  ctx.effect(() => () => { void service.dispose() }, 'dsh-free-model: opencode service')

  /** OpenCode 的模型缓存（目录只拉一次，页面可主动刷新）。 */
  let opencodeModels
  let opencodeModelsAt = 0
  /** 上一次记录失败日志的时刻（节流用，见 loadOpenCodeModels）。 */
  let lastOpenCodeFailureLogAt = 0
  const OPENCODE_MODEL_TTL_MS = 60_000
  /**
   * 失败也要缓存 —— 只是 TTL 短得多。
   *
   * ## 为什么（实测教训）
   *
   * 早先只在成功时更新 `opencodeModelsAt`。serve 没起时每次调用都重新探测，
   * 于是宿主在 7 秒内打了 11 次，日志刷成一片「读取 opencode 模型目录失败」。
   * 更糟的是 `listModels()` 会被模型选择器、状态页、探测三处并发调用，
   * 服务一挂就变成持续的无效 IO。
   *
   * 失败缓存 10 秒：够挡住同一轮里的并发与重试，又不至于让用户点「启动服务」
   * 之后还要等一分钟才看到模型。
   */
  const OPENCODE_FAILURE_TTL_MS = 10_000
  let opencodeFailureAt = 0
  const loadOpenCodeModels = async (force = false) => {
    const now = Date.now()
    if (!force) {
      if (opencodeModels !== undefined && now - opencodeModelsAt < OPENCODE_MODEL_TTL_MS) return opencodeModels
      if (opencodeFailureAt !== 0 && now - opencodeFailureAt < OPENCODE_FAILURE_TTL_MS) return opencodeModels ?? []
    }
    try {
      // ⚠️ 不再写死 ['opencode','ofm']：目录来自 /config/providers，用户可能自己
      // 往 opencode 里挂了别的 provider（例如另一个本地网关）。写死会让那些
      // 明明能调的模型在 DSH 里看不见。
      const groups = await service.client().providers()
      opencodeModels = await service.client().listModels({
        providers: groups.map((group) => group.id),
      })
      opencodeModelsAt = now
      opencodeFailureAt = 0
    } catch (error) {
      opencodeFailureAt = now
      // 只记一条：同一分钟内重复失败没有新增信息，刷日志反而盖住真正的问题。
      if (now - lastOpenCodeFailureLogAt > 60_000) {
        lastOpenCodeFailureLogAt = now
        logger?.warn?.(`[dsh-free-model] 读取 opencode 模型目录失败（${String(error)}）；10 秒内不再重试，点「启动服务」可立即重拉`)
      }
      if (opencodeModels === undefined) opencodeModels = []
    }
    return opencodeModels
  }

  // ── 三条车道：buddy / workbuddy 走账号池，opencode 走本地服务 ────────────────
  const channels = new Map()
  ctx.inject(['llm', 'credentials'], (scoped) => {
    const live = readLivePool(scoped)
    if (live === undefined) {
      const created = ensureFallbackPool(scoped)
      fallbackDispose = created.dispose
    }
    const bridge = {
      ...(makeReadImage(scoped) !== undefined ? { readImage: makeReadImage(scoped) } : {}),
      ...(makeReadImageRequest(scoped) !== undefined ? { readImageRequest: makeReadImageRequest(scoped) } : {}),
    }
    for (const product of BUDDY_PRODUCTS) {
      try {
        const mounted = mountBuddyChannel(scoped, pool, product, bridge)
        channels.set(product.id, mounted)
        scoped.effect(() => () => mounted.auth.stop(), `dsh-free-model: ${product.id} auth`)
        logger?.info?.(`dsh-free-model: ${product.displayName} 通道已挂载（路由 ${product.id}）`)
      } catch (error) {
        // 单个产品挂载失败不能带走另一个：用户可能只有 CodeBuddy 的账号。
        logger?.warn?.(`dsh-free-model: ${product.displayName} 挂载失败（${String(error)}）`)
      }
    }

    // ── 第三条：OpenCode ────────────────────────────────────────────────────
    try {
      const adapter = new OpenCodeAdapter({
        client: () => service.client(),
        models: () => loadOpenCodeModels(),
        resolveModel: async (id) => {
          const rows = await loadOpenCodeModels()
          return rows.find((row) => row.id === id)
        },
        // 图片：只有声明了 image 输入的模型才会走到这里（见 adapter.stream）。
        // 与 buddy 共用同一份附件桥，错误语义也一致（抛错 = 这次请求真的没法发）。
        ...(makeReadImage(scoped) !== undefined ? { readImage: makeReadImage(scoped) } : {}),
        logger,
      })
      registerAdapterIdempotent(scoped.llm, [OPENCODE_ROUTE], adapter, (message) => logger?.warn?.(message))
      channels.set(OPENCODE_ROUTE, { adapter, product: OPENCODE_LANE, service })
      logger?.info?.('dsh-free-model: OpenCode 车道已挂载（路由 opencode）')
    } catch (error) {
      logger?.warn?.(`dsh-free-model: OpenCode 车道挂载失败（${String(error)}）`)
    }
  })

  // ── HTTP 面 ────────────────────────────────────────────────────────────────
  const connection = connectionAdmissionView(() => readServiceOrUndefined(ctx, 'connection'))
  const routeHandler = createRoutes({
    llm: ctx.llm,
    channels: () => channels,
    pool: () => pool,
    products: ALL_LANES,
    connection: () => connection,
    logger,
    version,
    credits,
    autoCheckin,
    opencode: {
      service,
      models: loadOpenCodeModels,
      lane: OPENCODE_LANE,
    },
  })
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: '/api/free-model', handler: routeHandler }),
      'dsh-free-model: api routes',
    )
    logger?.info?.('dsh-free-model: 设置面已挂载到 /api/free-model')
  })
}

/**
 * OpenCode 车道的「伪产品」描述。
 *
 * 复用它而不是另起一套结构，是为了让 `routes.js` / `client.js` 里那套
 * 「按车道渲染卡片」的代码三处共用一份数据形状。`kind` 字段是唯一的分叉点：
 * `account` 车道有账号要管，`service` 车道只有一个本地进程要管。
 */
const OPENCODE_LANE = Object.freeze({
  id: OPENCODE_ROUTE,
  displayName: 'OpenCode 本地车道',
  endpoint: 'http://127.0.0.1:4096',
  kind: 'service',
  // ⚠️ 从 'text-only' 改成 'no-tools'：这条车道**能看图**（4 个免费模型声明了
  // input.image，图片走 FilePartInput 的 data: URL，实测 204 且上游确实收到）。
  // 真正缺的只有「调用方自定义工具」—— opencode 的接口只接受它自己那套
  // tools 开关表，传不进 DSH 的工具 schema。
  capability: 'no-tools',
  note: '能对话、能看图，但不能调用工具（opencode 的接口不接受外部工具定义）。适合标题、摘要、翻译、识图；别在 agent 会话里当主模型。',
  // 服务型车道没有「账号」，自然也没有积分：字段仍给出，让页面不必到处判空。
  credits: Object.freeze({ balance: false, claim: false }),
})

/**
 * 账号型车道的积分能力。
 *
 * ⚠️ `claim` 是**产品事实**，不是开关：CodeBuddy（国内版）有每日签到接口，
 * WorkBuddy 国际版的后端压根没有这个端点 —— 点一次返回 404 不会让它长出来。
 * 所以页面对 workbuddy 的「领取」必须**不渲染**，而不是渲染成灰色按钮让用户猜。
 * `balance` 两边都支持（同一个 `get-user-resource` 计费接口）。
 */
const LANE_CREDITS = Object.freeze({
  buddy: Object.freeze({ balance: true, claim: true }),
  workbuddy: Object.freeze({ balance: true, claim: false, claimNote: 'WorkBuddy 国际版没有签到接口（其后端不提供）' }),
})

const NO_CREDITS = Object.freeze({ balance: false, claim: false })

/**
 * 三条车道的完整清单（前两条是账号型，第三条是服务型）。
 *
 * 账号型车道在这里**复制一份并补上 `credits`**：`BUDDY_PRODUCTS` 是适配器的
 * 产品配置，往里塞展示字段会让「配置」和「展示」两件事逐渐混在一起。
 */
const ALL_LANES = Object.freeze([
  ...BUDDY_PRODUCTS.map((product) => ({
    ...product,
    credits: LANE_CREDITS[product.id] ?? NO_CREDITS,
  })),
  OPENCODE_LANE,
])

/** 读宿主池（不建本地池）。 */
function readLivePool(ctx) {
  const live = readServiceOrUndefined(ctx, 'accountPool')
  return live !== undefined && typeof live.getAvailableAccount === 'function' ? live : undefined
}

/** `ctx.get` 的机会式读取（缺失时答 undefined，绝不抛）。 */
function readServiceOrUndefined(ctx, serviceName) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
  } catch {
    return undefined
  }
}

/**
 * 图片读取桥接（与 OFM 的 `makeReadImage` 同一实现）。
 *
 * ⚠️ 附件服务在 apply 时**尚未提供**（浏览器半身后挂载），故这里每次请求时
 * 重新查 —— 一次读取会把「尚未提供」固化成永久缺失，图片支持静默消失。
 */
function makeReadImage(ctx) {
  return async (attachment) => {
    const attachments = readServiceOrUndefined(ctx, 'attachments')
    if (attachments?.readImage === undefined) {
      throw new Error('dsh-free-model: 附件服务（attachments）不可用，无法把图片内联进请求；请确认当前 profile 已装 @deepseek-ai/dsh-attachment-local。')
    }
    const stored = await attachments.readImage(attachment)
    return { data: stored.data, mediaType: stored.ref.mediaType }
  }
}

/**
 * 图片**请求版本**（按目标尺寸缩放后的字节）。
 *
 * ⚠️ 与 {@link makeReadImage} 的错误契约**刻意相反**：不可用时返回 `undefined`
 * 而不是抛错 —— 缩放是优化，正确行为是发原图，而不是把一次本来能成功的请求打死。
 */
function makeReadImageRequest(ctx) {
  return async (attachment, target) => {
    const attachments = readServiceOrUndefined(ctx, 'attachments')
    if (attachments?.readImageRequest === undefined) return undefined
    try {
      const projected = await attachments.readImageRequest(attachment, target)
      const mediaType = projected.mediaType ?? projected.attachment?.mediaType
      if (mediaType === undefined) return undefined
      return { data: projected.data, mediaType }
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-free-model] 图片请求版本派生失败，回退原图：${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }
}

export { OPENCODE_LANE, ALL_LANES }

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

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mountBuddyChannel, BUDDY_PRODUCTS } from './src/channels.js'
import { OFM_LANES, OFM_RPC_PATH } from './src/lanes.js'
import {
  buildRegistry,
  nativeAccountRecords,
  ofmAccountRecords,
  projectRegistryView,
} from './src/lanes/registry.js'
import { catalogCacheFile, fetchRemoteCatalog } from './src/lanes/remote.js'
import { checkUpdate, updateCacheFile } from './src/lanes/update.js'
import { SERVICE_PROBE_FAILURE_TTL_MS, decodeCredentialValue, probeAllServiceLanes } from './src/lanes/service.js'
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

  // ── 渠道注册表 + 渠道目录（「免费渠道总台」的数据面） ────────────────────────
  //
  // 三件事在这一段里定型：
  //   1. 渠道从哪来（随包 shipped / 远程 remote / 本地 local 三层叠加）；
  //   2. 页面看到的「就绪状态」怎么算（问运行时，不问页面）；
  //   3. 远程更新失败怎么退化（永远退到上一份缓存或随包数据，绝不拖垮插件）。
  //
  // ⚠️ 这里的 `remoteChannels` / `localChannels` 是**数据**：它们只影响「有哪些渠道、
  // 各自什么元数据」，不会凭空获得执行能力。远程目录能改的只有渠道描述，
  // 改不了本插件的代码路径（理由见 `src/lanes/remote.js` 开头）。
  const dshHome = resolveDshHome(ctx)
  const catalogCache = catalogCacheFile(dshHome)
  const updateCache = updateCacheFile(dshHome)
  const catalogUrl = typeof config.catalogUrl === 'string' && config.catalogUrl.trim() !== ''
    ? config.catalogUrl.trim()
    : undefined
  const repo = typeof config.repo === 'string' && config.repo.trim() !== '' ? config.repo.trim() : undefined
  const localCatalogFile = join(dshHome, 'free-model', 'channels.local.json')

  let remoteChannels = []
  let localChannels = readLocalCatalog(localCatalogFile, logger)
  let keyedRecords = []
  let keyedReady = Object.freeze({})
  /** 目录层现状（页面顶部那条「渠道目录 v? · 指纹 ?」用的就是它）。 */
  let catalogMeta = {
    url: catalogUrl ?? undefined,
    from: 'none',
    fetchedAt: 0,
    sha256: null,
    reason: '尚未拉取远程目录（首次打开页面或点「检查目录」时拉取）',
  }
  /** 服务车道探针缓存：成功 30 秒内不重探，失败按 SERVICE_PROBE_FAILURE_TTL_MS 退避。 */
  const serviceProbes = { at: 0, failedAt: 0, byId: {} }

  const readCredential = async (name) => {
    const credentials = readServiceOrUndefined(ctx, 'credentials')
    if (credentials?.resolve === undefined) return undefined
    try {
      return decodeCredentialValue(await credentials.resolve(`ref:${name}`))
    } catch {
      return undefined
    }
  }

  /** 组装注册表（纯函数，随取随算：17 条记录，代价可以忽略）。 */
  const registrySnapshot = () => buildRegistry({
    keyed: keyedRecords,
    remote: remoteChannels,
    local: localChannels,
  })

  /** 页面用的渠道视图（含就绪状态与目录元信息）。 */
  const channelsView = () => {
    const registry = registrySnapshot()
    const rows = projectRegistryView(registry.channels, {
      nativeMounted: channels,
      ofmReady: readServiceOrUndefined(ctx, 'accountPool') !== undefined,
      serviceProbes: serviceProbes.byId,
      keyedReady,
    })
    return {
      channels: rows,
      counts: registry.counts,
      fingerprint: registry.fingerprint,
      rejected: registry.rejected,
      layers: registry.byLayer,
      catalog: catalogStatus(),
    }
  }

  const catalogStatus = () => ({
    url: catalogMeta.url ?? catalogUrl ?? null,
    from: catalogMeta.from,
    fetchedAt: catalogMeta.fetchedAt,
    sha256: catalogMeta.sha256,
    reason: catalogMeta.reason,
    // 计数刻意分开报：用户点「检查目录」后要能看出**远程到底带来了什么**
    //（「0 条新增」不等于失败，可能只是远程与随包一致）。
    counts: {
      remote: remoteChannels.length,
      local: localChannels.length,
      keyed: keyedRecords.length,
    },
    localFile: localCatalogFile,
  })

  /**
   * 拉一次远程目录。
   *
   * `force=false` 时尊重缓存 TTL（6 小时）；失败**只降级不抛**，
   * 并把原因留在 `catalogStatus().reason` 里给页面显示。
   */
  const refreshCatalog = async (force = false) => {
    const result = await fetchRemoteCatalog({
      ...(catalogUrl !== undefined ? { url: catalogUrl } : {}),
      cacheFile: catalogCache,
      force,
      logger,
      ...(config.catalogFetcher !== undefined ? { fetchImpl: config.catalogFetcher } : {}),
    })
    if (result.ok) {
      remoteChannels = result.channels
      catalogMeta = {
        url: result.url,
        from: result.from,
        fetchedAt: result.fetchedAt,
        sha256: result.sha256,
        reason: result.reason,
      }
      logger?.info?.(
        `dsh-free-model: 渠道目录 ${result.from === 'network' ? '已更新' : '用缓存'}｜`
        + `${remoteChannels.length} 条远程渠道｜指纹 ${result.sha256 ?? '-'}`,
      )
    } else {
      catalogMeta = { ...catalogMeta, url: result.url, reason: result.reason }
      logger?.warn?.(`dsh-free-model: 渠道目录未更新（${result.reason}）；继续用随包 + 已有缓存`)
    }
    // 本地覆盖文件每次刷新目录时重读：用户改了它不用重启宿主。
    localChannels = readLocalCatalog(localCatalogFile, logger)
    return { ...catalogStatus(), ok: result.ok }
  }

  /**
   * 探测服务型车道（带双 TTL 缓存）。
   *
   * 为什么要缓存：设置页打开、标签切换、用户连点都会调它，而每次探测都要打本地端口。
   * 失败的退避更长（30 秒）—— 服务没起的时候不该被反复无效 IO 刷屏。
   */
  const probeServices = async (force = false) => {
    const now = Date.now()
    const fresh = now - serviceProbes.at < 30_000
    const backing = now - serviceProbes.failedAt < SERVICE_PROBE_FAILURE_TTL_MS
    if (!force && fresh && !backing) return serviceProbes.byId
    const lanes = registrySnapshot().channels.filter((channel) => channel.kind === 'service')
    const byId = await probeAllServiceLanes(lanes, {
      readCredential,
      ...(config.serviceProbeFetcher !== undefined ? { fetchImpl: config.serviceProbeFetcher } : {}),
    })
    serviceProbes.at = now
    const anyDown = Object.values(byId).some((row) => row.state !== 'ready')
    serviceProbes.failedAt = anyDown ? now : 0
    serviceProbes.byId = byId
    return byId
  }

  const checkVersion = async (force = false) => {
    const result = await checkUpdate({
      currentVersion: version,
      cacheFile: updateCache,
      force,
      ...(repo !== undefined ? { repo } : {}),
      ...(config.updateFetcher !== undefined ? { fetchImpl: config.updateFetcher } : {}),
    })
    if (result.updateAvailable) {
      logger?.info?.(`dsh-free-model: 有新版本 ${result.latest}（当前 ${result.current}）`)
    }
    return result
  }

  // 启动后异步预热远程目录：**延后 5 秒**，不跟宿主启动抢时间；失败无所谓。
  const warmTimer = setTimeout(() => { void refreshCatalog(false).catch(() => {}) }, 5_000)
  warmTimer.unref?.()
  ctx.effect(() => () => clearTimeout(warmTimer), 'dsh-free-model: catalog warmup')

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
    // 失败状态落盘：宿主重启后页面仍能说清「上次为什么不通」。
    // 内容只是失败原因文本，不放凭据，故与 channel-pack 同放在 dsh home 根下。
    stateFile: join(resolveDshHome(ctx), 'opencode-free-tier-state.json'),
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

    // ── 自带 key / 免 key 车道：模块存在才挂（这是「可插拔」的那一层） ──────────
    //
    // ⚠️ **必须容错**：`src/lanes/keyed/**` 是一个独立演进的模块（也可能因为远程
    // 目录把某条渠道标坏而抛错）。它挂不上只该让那一类渠道显示「未就绪」，
    // **绝不能让整个插件的 apply 失败** —— 那会把 13 条账号车道一起带走。
    void mountKeyedLanes(scoped, {
      logger,
      pkgDir: PKG_DIR,
      readCredential,
      onRecords: (records) => { keyedRecords = records },
      onReady: (ready) => { keyedReady = Object.freeze(ready) },
      ...(makeReadImage(scoped) !== undefined ? { readImage: makeReadImage(scoped) } : {}),
      ...(makeReadImageRequest(scoped) !== undefined ? { readImageRequest: makeReadImageRequest(scoped) } : {}),
    }).catch((error) => {
      logger?.warn?.(`dsh-free-model: 自带 key 车道装载失败（${error instanceof Error ? error.message : String(error)}）`)
    })
  })

  // ── HTTP 面 ────────────────────────────────────────────────────────────────
  const connection = connectionAdmissionView(() => readServiceOrUndefined(ctx, 'connection'))
  const routeHandler = createRoutes({
    llm: ctx.llm,
    channels: () => channels,
    pool: () => pool,
    products: ALL_LANES,
    // 宿主 channel-pack 是否在场（决定 11 条 OFM 侧车道能不能操作）。
    // 判据用 accountPool 的存在性：那正是 channel-pack 的 apply 末尾
    // `ctx.provide('accountPool', pool)` 提供的服务，没有别的来源。
    // 晚绑定：OFM 的 fiber 可能晚于本插件挂载。
    ofmBackend: () => readServiceOrUndefined(ctx, 'accountPool') !== undefined,
    ofmRpcPath: OFM_RPC_PATH,
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
    // 渠道全景（三类渠道 + 目录层）。`/summary` 保持老语义，新接口另开一条：
    // 详见 `src/routes.js` 里 `channelsOverview` 的说明。
    registry: channelsView,
    catalog: { status: catalogStatus, refresh: refreshCatalog },
    update: { check: checkVersion },
    service: { probe: probeServices },
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
 * 账号型车道的积分能力表已迁到 `src/lanes/registry.js`（`LANE_CREDITS`）——
 * 「哪家有签到」是**产品事实**，和渠道元数据放在一起才不会两处分叉。
 * 这里只保留 `OPENCODE_LANE` 这一条服务型车道。
 */

/**
 * 交给 `routes.js` 的车道清单。
 *
 * ⚠️ 它**只含账号型 + OpenCode**，与 0.3.x 的形状逐字一致 —— 这是刻意的：
 * `/summary` 的 `products` / `serviceLanes` 是既有契约（离线套件与页面都在用），
 * 三类渠道的**全景**另走 `/channels`（数据来自 `src/lanes/registry.js`，比这里更全：
 * 多出服务型 3 条与自带 key 车道，以及目录层来源与指纹）。
 * **新能力走新接口，老接口语义不动** —— 升级不该把用户的页面搞坏。
 */
const ALL_LANES = Object.freeze([
  ...nativeAccountRecords(),
  ...ofmAccountRecords(),
  OPENCODE_LANE,
])

/**
 * 读用户的本地渠道覆盖文件（`$DSH_HOME/free-model/channels.local.json`）。
 *
 * 它让用户能在**不发版、不改代码**的前提下：
 * - 把某条渠道钉住（`"pinned": true`）—— 之后远程目录再也覆盖不了它；
 * - 加一条自己公司的 OpenAI 兼容端点；
 * - 把某条上游换域名的免费渠道改对。
 *
 * 文件不存在是最常见的情况（绝大多数用户不会写它），所以**不报错也不告警**。
 * 存在但坏了则警告一次并忽略 —— 一份坏掉的本地覆盖不该让插件起不来。
 */
function readLocalCatalog(file, logger) {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const channels = Array.isArray(parsed?.channels) ? parsed.channels : []
    return channels
  } catch (error) {
    logger?.warn?.(
      `[dsh-free-model] 本地渠道覆盖文件读不出来（${file}）：`
      + `${error instanceof Error ? error.message : String(error)}；已忽略，插件继续用随包 + 远程目录`,
    )
    return []
  }
}

/**
 * 装载「自带 key / 免 key」车道模块（`src/lanes/keyed/**`）。
 *
 * ## 为什么要这么小心（这是本插件最容易炸的一处）
 *
 * 这一类渠道是最容易变、也最容易写坏的：它们的 baseURL 来自公网、适配器是新写的。
 * 而 `mountBuddyChannel` / OpenCode 那两条车道已经证明了「一个车道挂载失败不能
 * 带走另一个」的规矩。这里同样：**模块缺失 → 这一类渠道为空；模块抛错 → 只记一条警告**。
 * 绝不让它的失败影响 13 条账号车道 —— 那些才是用户每天真的在用的东西。
 *
 * ## 模块契约（逐文件独立，缺哪份就退化哪一段）
 *
 * | 文件 | 导出 | 缺了会怎样 |
 * |---|---|---|
 * | `catalog.js` | `KEYED_CHANNELS` / `KEYLESS_CHANNELS` | 没有这一类渠道（其余照常） |
 * | `ready.js` | `keyedLaneState(lane, { readCredential })` | 全部显示「未就绪·就绪模块缺失」 |
 * | `adapter.js` | `createKeyedAdapter({...})` | 只展示、不挂路由（页面会说清） |
 *
 * @returns {Promise<{ records: number, mounted: string[] }>}
 */
async function mountKeyedLanes(scoped, deps) {
  const dir = join(deps.pkgDir, 'src', 'lanes', 'keyed')
  const catalogFile = join(dir, 'catalog.js')
  if (!existsSync(catalogFile)) return { records: 0, mounted: [] }

  const catalog = await import(pathToFileURL(catalogFile).href)
  const records = [
    ...(Array.isArray(catalog.KEYED_CHANNELS) ? catalog.KEYED_CHANNELS : []),
    ...(Array.isArray(catalog.KEYLESS_CHANNELS) ? catalog.KEYLESS_CHANNELS : []),
  ]
  deps.onRecords?.(records)
  if (records.length === 0) return { records: 0, mounted: [] }

  // 就绪判定：模块在就用它的，不在就把「为什么不知道」说清楚（而不是默认 ready）。
  let stateOf
  const readyFile = join(dir, 'ready.js')
  if (existsSync(readyFile)) {
    const ready = await import(pathToFileURL(readyFile).href)
    if (typeof ready.keyedLaneState === 'function') {
      stateOf = (lane) => ready.keyedLaneState(lane, { readCredential: deps.readCredential })
    }
  }
  const readiness = {}
  for (const lane of records) {
    try {
      readiness[lane.id] = stateOf === undefined
        ? { ready: false, reason: '就绪模块（ready.js）缺失，无法判断凭据状态' }
        : await stateOf(lane)
    } catch (error) {
      readiness[lane.id] = { ready: false, reason: `就绪判定抛错：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  deps.onReady?.(readiness)

  const adapterFile = join(dir, 'adapter.js')
  if (!existsSync(adapterFile)) {
    deps.logger?.info?.('dsh-free-model: 自带 key 车道只做展示（adapter.js 缺失，未挂路由）')
    return { records: records.length, mounted: [] }
  }
  const adapterModule = await import(pathToFileURL(adapterFile).href)
  if (typeof adapterModule.createKeyedAdapter !== 'function') {
    deps.logger?.warn?.('dsh-free-model: 自带 key 模块没有导出 createKeyedAdapter，跳过挂载')
    return { records: records.length, mounted: [] }
  }

  const mounted = []
  for (const lane of records) {
    const state = readiness[lane.id]
    if (state?.ready !== true) continue
    try {
      const created = await adapterModule.createKeyedAdapter({
        lane,
        apiKey: state.apiKey,
        logger: deps.logger,
        ...(deps.readImage !== undefined ? { readImage: deps.readImage } : {}),
        ...(deps.readImageRequest !== undefined ? { readImageRequest: deps.readImageRequest } : {}),
      })
      const adapter = created?.adapter ?? created
      if (adapter === undefined || adapter === null) throw new Error('createKeyedAdapter 返回空')
      const routes = Array.isArray(created?.routes) ? created.routes : [lane.id]
      registerAdapterIdempotent(scoped.llm, routes, adapter, (message) => deps.logger?.warn?.(message))
      mounted.push(lane.id)
    } catch (error) {
      // 单条失败只影响它自己：一条渠道的 baseURL 写错不该让其它 keyed 渠道一起消失。
      deps.logger?.warn?.(
        `dsh-free-model: ${lane.displayName ?? lane.id} 车道挂载失败（${error instanceof Error ? error.message : String(error)}）`,
      )
    }
  }
  deps.logger?.info?.(
    `dsh-free-model: 自带 key 车道 ${mounted.length}/${records.length} 已挂载`
    + (mounted.length > 0 ? `（${mounted.join(', ')}）` : '（都没有 key/未就绪，仅展示）'),
  )
  return { records: records.length, mounted }
}

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

/**
 * 插件的 HTTP 面（`/api/free-model/*`）。
 *
 * ## 为什么要有它
 *
 * 原实现在 OFM 的 Channel Pack 面板里：登录按钮、账号列表、有效期、续期、
 * 探测、一键领取积分、模型开关 —— 2.5.8 把这些入口整个删了，但**后端能力一件没少**
 * （见 `src/core/` 与 `src/channels.js`）。没有入口等于没有功能，故这里补一个
 * 最小可用的 HTTP 面，由浏览器半身（`client.js`）直接消费。
 *
 * ## 每条路由都先过信任围栏
 *
 * 本前缀比内核的 `/api` 长，webServer 是**最长前缀优先**，故这些路由跑在
 * connection 服务自己的准入检查之前。围栏见 `src/trust.js`。
 *
 * ## 后端拿不到时的行为
 *
 * 账号池是晚绑定的（`poolView`），`/summary` 在池缺席时照样返回
 * `pool: 'absent'` 而不是 500 —— 页面要能说清楚「为什么列表是空的」。
 *
 * @module src/routes
 */

import { rejectionFor } from './trust.js'
import { lastRegistrationOutcome } from './core/register.js'
import { isLocalPool } from './pool.js'

/**
 * 构造路由处理器。
 *
 * @param {{
 *   llm: any,
 *   channels: () => Map<string, { auth: any, adapter: any, product: any }>,
 *   pool: () => any,
 *   products: readonly any[],
 *   connection: () => any,
 *   logger: any,
 *   version: string,
 *   credits: { collect: Function, claim: Function, invalidate: Function },
 *   autoCheckin: { state: Function, setEnabled: Function, runNow: Function },
 * }} deps
 */
export function createRoutes(deps) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/free-model/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    const rejection = rejectionFor(req, deps.connection(), (decision) => {
      // 只记固定字段：头、URL 与准入错误里可能有凭据。
      deps.logger?.warn?.(
        `[free-model] 拒绝 ${method} ${routePath}：status=${decision.status} source=${decision.source} reason=${decision.reason}`,
      )
    })
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden' }))
      return
    }

    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    const fail = (status, message) => send(status, { error: message })

    try {
      if (method === 'GET' && routePath === '/summary') {
        return send(200, buildSummary(deps))
      }
      if (method === 'GET' && routePath === '/accounts') {
        return send(200, await listAccounts(deps))
      }
      if (method === 'GET' && routePath === '/models') {
        return send(200, await listModels(deps, url.searchParams))
      }
      if (method === 'POST' && routePath === '/models') {
        return await mutateModel(deps, await readJson(req), send)
      }
      if (method === 'POST' && routePath === '/login') {
        return await startLogin(deps, await readJson(req), send)
      }
      if (method === 'POST' && routePath === '/login/poll') {
        return await pollLogin(deps, await readJson(req), send)
      }
      if (method === 'POST' && routePath === '/account') {
        return await mutateAccount(deps, await readJson(req), send)
      }
      if (method === 'POST' && routePath === '/credits') {
        return await readCredits(deps, await readJson(req), send)
      }
      if (method === 'POST' && routePath === '/checkin') {
        return await claimCheckin(deps, await readJson(req), send)
      }
      if (method === 'POST' && routePath === '/probe') {
        return await probe(deps, await readJson(req), send)
      }
      // ── 积分：余额 / 一键领取 / 自动领取开关 ────────────────────────────────
      if (method === 'GET' && routePath === '/credits') {
        return await creditsOverview(deps, url.searchParams, send)
      }
      if (method === 'POST' && routePath === '/claim') {
        return await claimAll(deps, await readJson(req), send)
      }
      if (method === 'GET' && routePath === '/auto-checkin') {
        return send(200, { autoCheckin: deps.autoCheckin.state() })
      }
      if (method === 'POST' && routePath === '/auto-checkin') {
        return await mutateAutoCheckin(deps, await readJson(req), send)
      }
      // ── OpenCode 车道：进程管理 + 目录刷新 ──────────────────────────────────
      if (method === 'GET' && routePath === '/opencode/status') {
        return send(200, await opencodeStatus(deps))
      }
      if (method === 'POST' && routePath === '/opencode/start') {
        return await opencodeStart(deps, send)
      }
      if (method === 'POST' && routePath === '/opencode/stop') {
        return send(200, deps.opencode.service.stop())
      }
      if (method === 'POST' && routePath === '/opencode/refresh') {
        const rows = await deps.opencode.models(true)
        return send(200, { ok: true, count: rows.length })
      }
      return fail(404, `unknown route ${method} ${routePath}`)
    } catch (error) {
      // 失败原因可能带凭据（错误里嵌了请求头），故只回固定摘要、全量进日志。
      deps.logger?.warn?.(`[free-model] ${method} ${routePath} 失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      return fail(500, error instanceof Error ? error.message.slice(0, 300) : 'internal error')
    }
  }
}

/** 读 JSON 请求体（上限 64 KiB：这里没有大载荷）。 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** 概览：每个产品的账号数、可用数、以及账号池来源。 */
function buildSummary(deps) {
  const pool = deps.pool()
  // ⚠️ 判 `pool` 是**门面**还是**真池**：门面在池缺席时仍会返回空列表让上层
  // 走自己的语义分支（见 live-pool.js 的说明），故不能靠「有没有方法」判定。
  // `__live.current` 是门面暴露的晚绑定视图。
  //
  // 三态必须分开报，因为对用户意味着不同的事：
  //   'host'   —— 用的是 OFM 那个真池，账号与其它通道共享
  //   'local'  —— 宿主没给池，本插件退化实现，读写同一份 state.json
  //   'absent' —— 连退化都没装上（apply 未完成 / credentials 服务缺席）
  const live = pool?.__live?.current
  const poolState = live === undefined ? 'absent' : isLocalPool(live) ? 'local' : 'host'
  const products = deps.products.filter((product) => product.kind !== 'service').map((product) => {
    let total = 0
    let enabled = 0
    let expiringSoon = 0
    try {
      const list = pool?.listAccountsByProvider?.(product.id) ?? []
      total = list.length
      const now = Date.now()
      for (const entry of list) {
        if (entry.enabled !== false) enabled += 1
        if (typeof entry.expiresAt === 'number' && entry.expiresAt > now && entry.expiresAt - now < 24 * 3600 * 1000) expiringSoon += 1
      }
    } catch {
      // 池读失败不致命：概览照样要能渲染，让用户看到「读取失败」而不是白页。
    }
    // backend 决定这条车道的登录/续期/积分/模型开关走哪个后端：
    //   'native' —— 本插件自己挂的（buddy / workbuddy），走 /api/free-model/*
    //   'ofm'    —— 宿主 channel-pack 提供的 11 条，页面直接调 /api/channel-pack
    const backend = product.backend ?? 'native'
    const ofmReady = backend === 'ofm' && deps.ofmBackend?.() === true
    return {
      id: product.id,
      displayName: product.displayName,
      endpoint: product.endpoint,
      backend,
      // 登录交互形态（页面据此决定「弹窗 + 轮询」还是「本机登录页 + 可选短信」）。
      // native 两条都是浏览器 OAuth，故 backend === 'ofm' 之外一律 'browser'。
      login: product.login ?? 'browser',
      ...(product.smsFallback === true ? { smsFallback: true } : {}),
      ...(typeof product.note === 'string' && product.note.length > 0 ? { note: product.note } : {}),
      total,
      enabled,
      expiringSoon,
      // 四种状态必须分辨得开：
      //   'registered' —— 本插件接管了路由（OFM 2.5.8 之后，或没装 OFM）
      //   'yielded'    —— 路由已被 OFM 内置 channel-pack 占着（用户还停在 2.5.7）
      //   'ofm'        —— 该车道本来就由 OFM 侧提供，且它正在跑
      //   'absent'     —— 没挂载（apply 失败 / llm 服务缺席 / OFM 没装）
      route: backend === 'ofm'
        ? (ofmReady ? 'ofm' : 'absent')
        : (lastRegistrationOutcome(deps.llm, product.id) ?? 'absent'),
      // ⚠️ mounted 对 OFM 车道**恒为 false**（本插件确实没挂它们），
      // 故页面不能用它判断「能不能操作」—— 那是 route / backend 的事。
      mounted: deps.channels().has(product.id),
      // 积分能力跟着产品走：页面据此决定渲染不渲染「领取」按钮，
      // 而不是让前端自己拿 provider id 去猜（猜错就是 404）。
      credits: product.credits ?? { balance: false, claim: false },
    }
  })
  return {
    version: deps.version,
    pool: poolState,
    poolSource: poolState === 'host' ? 'accountPool' : poolState === 'local' ? 'channel-pack/state.json' : 'none',
    // OFM 侧后端是否就绪（11 条车道的操作能力位）。页面据此把那些卡片标成
    // 「后端未就绪」并隐藏操作按钮 —— 而不是渲染出点了必然失败的动作。
    ofm: {
      available: deps.ofmBackend?.() === true,
      // 就绪时的转发目标（页面不写死路径，改路由只改这里）。
      rpcPath: deps.ofmRpcPath ?? '/api/channel-pack',
    },
    // 只有账号型车道进 products；服务型车道（opencode）单独一段，字段形状不同。
    products,
    serviceLanes: deps.products
      .filter((product) => product.kind === 'service')
      .map((product) => ({
        id: product.id,
        displayName: product.displayName,
        kind: product.kind,
        capability: product.capability,
        note: product.note,
        mounted: deps.channels().has(product.id),
        route: lastRegistrationOutcome(deps.llm, product.id) ?? 'absent',
      })),
  }
}

/**
 * 模型清单：每个产品的**全部**模型 + 当前开关状态 + 元数据。
 *
 * ## 为什么这里自己拼，而不是复用 OFM 的 `model.list`
 *
 * OFM 的 RPC 走 `channel-pack` 的内部 `modelAdapters` 表，而 2.5.8 的
 * `provider.status` / `handleMethod` 会主动跳过 `buddy` / `workbuddy`
 * （`isRetiredProvider`）。所以那两个 provider 在 OFM 的接口里**根本问不到**，
 * 只能由持有适配器实例的本插件自己回答。
 *
 * 数据源与 OFM 一致，两条：
 * 1. `adapter.listAllModels()` —— **不受黑名单影响**的全量清单。必须用它：
 *    关掉的模型也要能显示出来（否则用户没法重新打开），而 `listModels` 会过滤。
 * 2. 池的 `listDisabledModels(provider)` —— 黑名单（`modelId → true`）。
 *
 * @param {any} deps
 * @param {URLSearchParams} search
 */
async function listModels(deps, search) {
  const only = search.get('provider')
  const pool = deps.pool()
  const products = []
  for (const product of deps.products) {
    if (only !== null && only !== '' && product.id !== only) continue
    // 服务型车道（opencode）的目录走 /opencode/status，形状不同，不在这里拼。
    if (product.kind === 'service') continue
    const channel = deps.channels().get(product.id)
    if (channel === undefined) {
      // OFM 侧车道在这里**必然是空目录**（本插件没挂它们的适配器）：页面据此
      // 走宿主 RPC 的 model.list，而不是把空目录渲染成「读不到模型」。
      products.push({
        id: product.id,
        displayName: product.displayName,
        backend: product.backend ?? 'native',
        mounted: false,
        models: [],
      })
      continue
    }
    let rows = []
    try {
      // 远端目录可能还没拉到；适配器内部有冷却闸门，这里不额外等。
      // buddy/workbuddy 用 listAllModels（不受黑名单影响）；opencode 没这个方法，
      // 退回 listModels（它是纯目录，没有「关掉的模型」概念）。
      rows = channel.adapter.listAllModels?.() ?? await channel.adapter.listModels?.(product.id) ?? []
    } catch (error) {
      deps.logger?.warn?.(`[free-model] ${product.id} 模型目录读取失败: ${String(error)}`)
    }
    const disabled = pool?.listDisabledModels?.(product.id) ?? {}
    const models = []
    for (const row of rows) {
      const id = String(row?.id ?? '')
      if (id === '') continue
      let meta = {}
      try {
        // 元数据（上下文窗口 / 思考档位 / 图片能力）来自 resolveModel，
        // 与模型选择器看到的是同一份，不会两处口径分叉。
        meta = await channel.adapter.resolveModel(product.id, id)
      } catch {
        // 单模型元数据失败不影响清单：缺的字段由前端按缺省渲染。
      }
      models.push({
        id,
        name: row.name ?? meta.name ?? id,
        provider: product.id,
        disabled: disabled[id] === true,
        contextWindow: meta.context?.contextWindow ?? null,
        maxOutputTokens: meta.defaultMaxTokens ?? null,
        reasoningEfforts: (meta.reasoning?.efforts ?? []).map((effort) => effort.id),
        defaultReasoningEffort: meta.reasoning?.defaultEffort ?? null,
        inputModalities: meta.inputModalities ?? ['text'],
      })
    }
    const total = models.length
    const off = models.filter((model) => model.disabled).length
    products.push({
      id: product.id,
      displayName: product.displayName,
      endpoint: product.endpoint,
      backend: 'native',
      mounted: true,
      total,
      disabled: off,
      closed: total > 0 && off === total,
      models,
    })
  }
  return { products }
}

/**
 * 模型开关 / 批量开关。
 *
 * 语义与 OFM 的 Channel Pack 面板一致（用户已确认过的那套）：
 * - `action: 'toggle'` —— 单个模型开或关；
 * - `action: 'all'`    —— 该 provider 全部关 / 全部开；
 * - `action: 'reset'`  —— 清空黑名单（全部打开）。
 *
 * ⚠️ 关掉模型**只影响选择器是否列出它**，不影响路由：DSH 的约定是
 * 「catalog membership is advisory and never changes routing」，
 * 已保存的会话仍能调用被隐藏的模型。
 */
async function mutateModel(deps, body, send) {
  const pool = deps.pool()
  if (pool === undefined) return send(503, { error: 'account pool unavailable' })
  const product = findProduct(deps, body.provider)
  if (product === undefined) return send(400, { error: 'unknown provider' })
  // ⚠️ 服务型车道（opencode）没有账号池里的模型黑名单：它的目录由本地服务实时
  // 下发，写进池里只会产生一条永远没人读的记录。直接拒，而不是静默成功。
  if (product.kind === 'service') {
    return send(409, { error: `${product.id} 是服务型车道，模型开关由本地服务管理；请用 /opencode/refresh 刷新目录` })
  }
  if (rejectOfmLane(deps, product, send)) return
  if (!deps.channels().has(product.id)) return send(503, { error: 'channel not mounted' })
  const action = String(body.action ?? '')

  if (action === 'toggle') {
    const modelId = String(body.model ?? '')
    if (modelId === '') return send(400, { error: 'model is required' })
    await pool.setModelDisabled(product.id, modelId, body.disabled === true)
    return send(200, { ok: true })
  }
  if (action === 'all') {
    const channel = deps.channels().get(product.id)
    const ids = ((channel?.adapter?.listAllModels?.() ?? await channel?.adapter?.listModels?.(product.id) ?? [])).map((row) => String(row.id)).filter(Boolean)
    if (ids.length === 0) return send(409, { error: 'model catalog is empty; nothing to toggle' })
    await pool.setModelsDisabled(product.id, ids, body.disabled === true)
    return send(200, { ok: true, count: ids.length })
  }
  if (action === 'reset') {
    await pool.clearDisabledModels(product.id)
    return send(200, { ok: true })
  }
  return send(400, { error: `unknown action ${action}` })
}

/** 账号列表（含凭据有效期、刷新能力、限流标记）。 */
async function listAccounts(deps) {
  const pool = deps.pool()
  const out = []
  for (const product of deps.products) {
    const list = pool?.listAccountsByProvider?.(product.id) ?? []
    for (const entry of list) {
      out.push({
        id: entry.id,
        provider: entry.provider,
        displayName: product.displayName,
        nickname: entry.nickname,
        enabled: entry.enabled !== false,
        credentialRef: entry.credentialRef,
        expiresAt: entry.expiresAt ?? null,
        refreshable: entry.refreshable !== false,
        modelRateLimits: entry.modelRateLimits ?? {},
      })
    }
  }
  return { accounts: out }
}

/**
 * 发起登录：拿 authUrl 并把 `state` 交回前端。
 *
 * ## 为什么拆成两步
 *
 * 原实现是一步到底（`runBuddyLoginFlow` 内部轮询 5 分钟），HTTP 上做成一次请求
 * 会长时间挂着连接、也取消不掉。故这里只做第一步（`fetchAuthState` +
 * `decorateLoginUrl`），由前端打开浏览器，再按 `state` 轮询第二步。
 */
async function startLogin(deps, body, send) {
  const product = findProduct(deps, body.provider)
  if (product === undefined) return send(400, { error: 'unknown provider' })
  if (rejectOfmLane(deps, product, send)) return
  const { fetchAuthState, decorateLoginUrl } = await import('./core/buddy-oauth.js')
  const state = await fetchAuthState(fetch, undefined, product)
  const loginUrl = decorateLoginUrl(state.authUrl, product)
  return send(200, { state: state.state, loginUrl })
}

/**
 * 轮询登录结果：拿到 token 后写凭据、注册账号、武装续期。
 *
 * ⚠️ 写凭据用 `{PROVIDER}_ACCOUNT_{HEX}`（与 OFM 的 `account.create` 同一约定），
 * **不写**单凭据回退 ref —— 后者是「无账号池」时代的遗留，两处都写会让
 * 续期刷到另一份凭据上（OFM 踩过的自锁）。
 */
async function pollLogin(deps, body, send) {
  const product = findProduct(deps, body.provider)
  if (product === undefined) return send(400, { error: 'unknown provider' })
  const state = String(body.state ?? '')
  if (state === '') return send(400, { error: 'state is required' })
  if (rejectOfmLane(deps, product, send)) return
  const channel = deps.channels().get(product.id)
  if (channel === undefined) return send(503, { error: 'channel not mounted' })
  const refName = String(body.refName ?? `${product.id.toUpperCase()}_ACCOUNT_${randomSuffix()}`)
  const accountId = String(body.accountId ?? `${product.id}-${refName.split('_').pop().toLowerCase()}`)
  const pool = deps.pool()
  const result = await channel.auth.login({
    state,
    refName,
    accountId,
    ...(pool !== undefined ? { pool } : {}),
  })
  return send(200, {
    accountId,
    refName,
    expiresAt: result.expires || null,
    refreshable: result.refreshable,
    loginUrl: result.loginUrl,
  })
}

/** 账号开关 / 删除 / 续期。 */
async function mutateAccount(deps, body, send) {
  const pool = deps.pool()
  if (pool === undefined) return send(503, { error: 'account pool unavailable' })
  const action = String(body.action ?? '')
  const id = String(body.id ?? '')
  if (action === '' || id === '') return send(400, { error: 'action and id are required' })
  if (action === 'enable' || action === 'disable') {
    await pool.updateAccount(id, { enabled: action === 'enable' })
    return send(200, { ok: true })
  }
  if (action === 'remove') {
    // ⚠️ 只删索引、**不删凭据**：2.5.8 明确保留历史账号与凭据，
    // 让「删账号」变成不可逆会与该承诺冲突。需要彻底清除时用宿主凭据面板。
    await pool.removeAccount(id)
    return send(200, { ok: true, credentialKept: true })
  }
  if (action === 'refresh') {
    const entry = pool.findAccount?.(id) ?? pool.listAllAccounts?.().find((candidate) => candidate.id === id)
    if (entry === undefined) return send(404, { error: 'account not found' })
    const channel = deps.channels().get(entry.provider)
    if (channel === undefined) return send(503, { error: 'channel not mounted' })
    await channel.auth.refreshAccountCredential(entry.credentialRef, pool, entry.id)
    return send(200, { ok: true })
  }
  if (action === 'clearLimits') {
    if (typeof pool.clearModelRateLimits === 'function') {
      const cleared = await pool.clearModelRateLimits(id)
      return send(200, { ok: true, cleared })
    }
    return send(503, { error: 'account pool does not expose clearModelRateLimits' })
  }
  return send(400, { error: `unknown action ${action}` })
}

/** 读积分余额（`get-user-resource`）。 */
async function readCredits(deps, body, send) {
  const resolved = await resolveAccountCredential(deps, body)
  if (resolved.error !== undefined) return send(resolved.status, { error: resolved.error })
  const { fetchCreditBalance } = await import('./core/credits.js')
  const balance = await fetchCreditBalance(resolved.credential, resolved.product)
  return send(200, { balance })
}

/**
 * 领每日积分。
 *
 * ⚠️ **产品判定必须早于凭据解析**：WorkBuddy 国际版压根没有签到接口，
 * 这与「这个号有没有凭据」完全无关。先解析凭据会把一个纯粹的「不支持」
 * 报成 404「没有可用凭据」，把人引去重新登录（原实现是直接拒绝的）。
 */
async function claimCheckin(deps, body, send) {
  const product = findProduct(deps, body.provider)
  if (product === undefined) return send(400, { error: 'unknown provider' })
  if (product.id === 'workbuddy') {
    // 原实现（channel-pack-rpc.ts 的 checkin 分支）返回同一句话：
    // 「WorkBuddy 国际版不支持每日签到（其后端没有签到接口）」。
    return send(400, { error: 'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）' })
  }
  const resolved = await resolveAccountCredential(deps, body)
  if (resolved.error !== undefined) return send(resolved.status, { error: resolved.error })
  const { claimDailyCheckin } = await import('./core/credits.js')
  const outcome = await claimDailyCheckin(resolved.credential, resolved.product)
  return send(200, { outcome })
}

/**
 * 探测一条通道：用最小请求验证凭据是否真的能出字。
 *
 * 原实现（`account-probe.ts`）在这里会先拦下已退役的 provider；本插件正是
 * 把退役的那两个接回来，故只保留真正的探测语义。
 */
async function probe(deps, body, send) {
  const product = findProduct(deps, body.provider)
  if (product === undefined) return send(400, { error: 'unknown provider' })
  if (rejectOfmLane(deps, product, send)) return
  const channel = deps.channels().get(product.id)
  if (channel === undefined) return send(503, { error: 'channel not mounted' })
  const models = await channel.adapter.listModels(product.id)
  const modelId = String(body.model ?? models[0]?.id ?? '')
  if (modelId === '') return send(400, { error: 'no model available to probe' })
  const started = Date.now()
  let firstText = ''
  try {
    for await (const chunk of channel.adapter.stream({
      model: modelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      maxTokens: 16,
    })) {
      if (typeof chunk === 'object' && chunk !== null && typeof chunk.text === 'string' && chunk.text.length > 0) {
        firstText = chunk.text.slice(0, 40)
        break
      }
    }
    return send(200, { ok: true, model: modelId, ms: Date.now() - started, sample: firstText })
  } catch (error) {
    return send(200, {
      ok: false,
      model: modelId,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    })
  }
}

/** 解析出「这次操作针对的账号」的凭据。 */
async function resolveAccountCredential(deps, body) {
  const product = findProduct(deps, body.provider)
  if (product === undefined) return { status: 400, error: 'unknown provider' }
  if ((product.backend ?? 'native') !== 'native') {
    return { status: 409, error: `${product.displayName} 由 OFM 后端提供，请用宿主 RPC 查询积分` }
  }
  const pool = deps.pool()
  if (pool === undefined) return { status: 503, error: 'account pool unavailable' }
  const id = String(body.id ?? '')
  const credential = id === ''
    ? (await pool.getAvailableAccount(product.id, ''))?.credential
    : await pool.resolveCredentialForAccount(id)
  if (credential === undefined || credential === null) return { status: 404, error: 'no usable credential' }
  return { product, credential }
}

/**
 * OFM 侧车道不许走本插件的 HTTP 面。
 *
 * 那些车道的登录 / 续期 / 积分 / 模型开关全在宿主 channel-pack 里，本插件**刻意**
 * 不代理（否则要在 13 条车道与 12 个 RPC 方法之间各写一遍转发，且任何一条的产品
 * 怪癖都会在转发层再漂移一次）。页面直接调宿主 RPC，这里只负责把「走错了后端」
 * 这件事**明确报出来**，而不是给一个语焉不详的 503。
 *
 * @returns {boolean} true = 已回 409，调用方必须立即返回
 */
function rejectOfmLane(deps, product, send) {
  if ((product.backend ?? 'native') === 'native') return false
  send(409, {
    code: 'backend-ofm',
    error: `${product.displayName} 由 OFM 后端（channel-pack）提供，本插件的 HTTP 面不代理它；`
      + `页面用宿主 RPC（${deps.ofmRpcPath ?? '/api/channel-pack'}）操作这条车道。`,
  })
  return true
}

/** 按 id 找产品。 */
function findProduct(deps, rawId) {
  const id = String(rawId ?? '')
  return deps.products.find((product) => product.id === id)
}

/** 6 位十六进制后缀（与 OFM 的 `ACCOUNT_REF_RE` 要求一致：≥6 位）。 */
function randomSuffix() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
}

/**
 * OpenCode 车道的状态：进程 + 模型数 + 与 DSH 路由的挂载情况。
 *
 * ## 为什么状态要分成「进程在跑」与「路由已挂载」两件事
 *
 * 这是两个独立的失败点，用户能自己修的部分完全不同：
 * - 进程没起 → 点按钮就行（`/opencode/start`）；
 * - 路由没挂 → 说明 llm 服务或适配器注册失败，只能看日志。
 *
 * 合成一个「可用 / 不可用」会让人在两个方向之间乱试。
 */
async function opencodeStatus(deps) {
  const service = deps.opencode.service
  const lane = deps.opencode.lane
  const status = await service.status()
  let models = []
  let modelError
  if (status.running) {
    try {
      models = await deps.opencode.models(false)
    } catch (error) {
      modelError = error instanceof Error ? error.message : String(error)
    }
  }
  // 按 provider 分组：用户要能分辨「这 9 个是 opencode 免费层，那 706 个是我
  // 自己挂在 opencode 里的 OFM 网关」。混成一个数字，排错时无从下手。
  const providers = new Map()
  for (const row of models) {
    const id = String(row.providerID ?? '?')
    const bucket = providers.get(id) ?? { id, count: 0, vision: 0 }
    bucket.count += 1
    if (row.vision === true) bucket.vision += 1
    providers.set(id, bucket)
  }
  return {
    lane: {
      id: lane.id,
      displayName: lane.displayName,
      kind: lane.kind,
      capability: lane.capability,
      note: lane.note,
      mounted: deps.channels().has(lane.id),
      route: lastRegistrationOutcome(deps.llm, lane.id) ?? 'absent',
    },
    service: status,
    models: {
      count: models.length,
      // 能看图的模型数：这条车道**不是**纯文本，只是没有工具调用能力。
      vision: models.filter((row) => row.vision === true).length,
      providers: [...providers.values()].sort((a, b) => b.count - a.count),
      sample: models.slice(0, 12).map((row) => ({ id: row.id, name: row.name, vision: row.vision === true })),
      error: modelError ?? null,
    },
  }
}

/**
 * 启动 OpenCode 服务。
 *
 * 失败原因原样回给前端（含「哪个端口被占、为什么起不来」）—— 这条链路的失败
 * 方式有十几种（二进制不在、端口被占、启动太慢、被杀软拦），把原因藏进日志
 * 等于让用户自己猜。
 */
async function opencodeStart(deps, send) {
  const result = await deps.opencode.service.start()
  if (!result.running) {
    return send(503, { ok: false, error: result.error ?? '无法启动 opencode serve', port: result.port })
  }
  // 起来之后立刻拉一次目录：用户点完按钮就能看到模型，不用再点刷新。
  let count = 0
  try {
    const rows = await deps.opencode.models(true)
    count = rows.length
  } catch { /* 目录拉取失败不影响「服务已起」这件事 */ }
  return send(200, { ok: true, port: result.port, started: result.started === true, modelCount: count })
}

/**
 * 余额：逐个账号查询（顺序执行，理由见 credits-service 的模块说明）。
 *
 * ## 为什么和 /accounts 分开
 *
 * 余额要为**每个账号**打一次上游请求，而 `/accounts` 是打开页面就会调的轻量
 * 操作（只读池内存）。混在一起会让账号列表被网络耗时拖住，而且一次查询失败
 * 会把整份列表一起打空 —— 于是「页面打不开」和「查不到余额」变成同一个现象。
 *
 * 与 OFM 的 `credits.balances` 同一条路由分工。
 *
 * @param {any} deps
 * @param {URLSearchParams} search `?provider=buddy&force=1`
 * @param {(status: number, payload: any) => void} send
 */
async function creditsOverview(deps, search, send) {
  const provider = String(search.get('provider') ?? '')
  if (provider === '') return send(400, { error: 'provider is required' })
  const product = findProduct(deps, provider)
  if (product === undefined) return send(400, { error: 'unknown provider' })
  // 服务型车道没有账号，问它要积分是调用方搞错了：明确拒绝而不是回空数组
  // （空数组会被页面渲染成「余额 ——」，看起来像「查不到」）。
  if (product.kind === 'service') {
    return send(409, { error: `${product.id} 是服务型车道，没有账号与积分` })
  }
  const force = search.get('force') === '1' || search.get('force') === 'true'
  return send(200, await deps.credits.collect(provider, { force }))
}

/**
 * 一键领取：顺序领取该车道全部账号的今日积分，单个账号失败不中断。
 *
 * ⚠️ 不支持签到的车道（WorkBuddy 国际版）**返回 400 而不是空结果**：
 * 空结果会被页面显示成「今天没有可领取的积分」，那是另一件事
 * （活动没开 / 今天已领），会把用户引向等待。
 */
async function claimAll(deps, body, send) {
  const product = findProduct(deps, body.provider)
  if (product === undefined) return send(400, { error: 'unknown provider' })
  if (product.kind === 'service') return send(409, { error: `${product.id} 是服务型车道，没有积分` })
  if (rejectOfmLane(deps, product, send)) return
  const capability = product.credits ?? { balance: false, claim: false }
  if (capability.claim !== true) {
    return send(400, { error: capability.claimNote ?? `${product.displayName} 不支持每日签到` })
  }
  const result = await deps.credits.claim(product.id)
  return send(200, result)
}

/**
 * 自动领积分：读状态 / 开关 / 立刻跑一轮。
 *
 * 三种入参的语义分开（与 OFM 的 `usage.autoCheckin` 一致）：
 * - 无 `enabled`、无 `run` → 只读；
 * - `run: true`            → 立刻跑一轮（忽略「今天已跑过」那道闸门）；
 * - `enabled: boolean`      → 写开关（打开时立刻尝试跑一轮）。
 */
async function mutateAutoCheckin(deps, body, send) {
  if (body.run === true) {
    await deps.autoCheckin.runNow()
    return send(200, { autoCheckin: deps.autoCheckin.state() })
  }
  if (body.enabled === undefined) return send(200, { autoCheckin: deps.autoCheckin.state() })
  if (typeof body.enabled !== 'boolean') {
    // 非法值拒绝而不是静默回落：回落会让「设置没生效」看起来像「保存成功」。
    return send(400, { error: `enabled 必须是布尔值（收到：${JSON.stringify(body.enabled)}）` })
  }
  return send(200, { autoCheckin: await deps.autoCheckin.setEnabled(body.enabled) })
}

/**
 * 离线自测：`node --import ./test/hooks.mjs test/smoke.mjs`
 *
 * 不需要宿主、不发网络请求。覆盖：
 *
 * 1. 入口能加载、`name` / `inject` / `version` 正确；
 * 2. 两个 provider 都注册到 `ctx.llm`，路由名 = product.id；
 * 3. 模型目录与 `resolveModel` 的元数据（含思考档位与图片能力）；
 * 4. 与 OFM ≤2.5.7 共存（路由已占用）时**让位而不抛错**；
 * 5. 自己重跑（inject 重入）时仍算 `registered`，不会被误判成让位；
 * 6. HTTP 面的每一条路由 + 信任围栏；
 * 7. 积分（余额 / 一键领取）与每日自动领积分开关 —— 用假的 fetch 打，
 *    不碰腾讯的计费接口，也不写用户真实的 `~/.dsh`。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
let passed = 0
const failures = []

function check(label, run) {
  try {
    run()
    passed += 1
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

async function checkAsync(label, run) {
  try {
    await run()
    passed += 1
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

// ── 测试替身 ────────────────────────────────────────────────────────────────
function jwt(payload) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

function makeCredentials() {
  const store = new Map()
  return {
    store,
    async resolve(ref) {
      const value = store.get(String(ref))
      return value === undefined ? undefined : { value, source: 'memory' }
    },
    async set(ref, value) { store.set(String(ref), value) },
    async describe(ref) { return { configured: store.has(String(ref)), source: 'memory' } },
    async unset(ref) { store.delete(String(ref)) },
  }
}

function makePool(accounts, credentials) {
  return {
    listAccountsByProvider(provider) { return [...accounts.values()].filter((a) => a.provider === provider) },
    /**
     * 与 LocalPool 同语义：池条目只存 ref，凭据值在 credentials 服务里。
     *
     * ⚠️ 这个方法**必须有**：积分（余额 / 签到）全都要先解析出凭据。
     * 原先的替身漏了它，于是「查不到余额」被当成上游的问题 ——
     * 真正的原因是解析器拿不到 credential 对象。
     */
    async resolveCredentialForAccount(id) {
      const entry = accounts.get(id)
      if (entry === undefined) return undefined
      const resolved = await credentials.resolve(entry.credentialRef)
      if (resolved === undefined) return undefined
      try { return JSON.parse(resolved.value) } catch { return undefined }
    },
    async listAccounts(provider) { return this.listAccountsByProvider(provider) },
    listAllAccounts() { return [...accounts.values()] },
    findAccount(id) { return accounts.get(id) },
    async hasLoggedInAccount(provider) { return [...accounts.values()].some((a) => a.provider === provider && a.enabled) },
    async getAvailableAccount(provider, modelId, exclude) { return null },
    async findAccountIdByCredential() { return '' },
    async addAccount(entry) { accounts.set(entry.id, entry) },
    async updateAccount(id, patch) { accounts.set(id, { ...accounts.get(id), ...patch }) },
    async removeAccount(id) { accounts.delete(id) },
    async updateModelRateLimit() {},
    async clearModelRateLimits() { return 0 },
    permanentLocked() { return false },
    // 黑名单：与 LocalPool 同语义（键存在且为 true 才算关闭）。
    __disabled: {},
    disabledModelsFor(provider) {
      return new Set(Object.entries(this.__disabled[provider] ?? {}).filter(([, v]) => v === true).map(([id]) => id))
    },
    listDisabledModels(provider) { return { ...(this.__disabled[provider] ?? {}) } },
    async setModelDisabled(provider, modelId, disabled) {
      const map = { ...(this.__disabled[provider] ?? {}) }
      if (disabled) map[modelId] = true; else delete map[modelId]
      this.__disabled[provider] = map
    },
    async setModelsDisabled(provider, modelIds, disabled = true) {
      const map = { ...(this.__disabled[provider] ?? {}) }
      for (const id of modelIds) { if (disabled) map[id] = true; else delete map[id] }
      this.__disabled[provider] = map
    },
    async clearDisabledModels(provider) { this.__disabled[provider] = {} },
  }
}

/**
 * 造一个 cordis ctx 的最小替身。
 *
 * `registerAdapter` 的行为由 `llmBehaviour` 决定，用来模拟三种真实场景：
 * `'ok'` / `'foreign'`（OFM 2.5.7 已占位）/ `'self'`（inject 重跑）。
 */
function makeCtx({ services = {}, llmBehaviour = 'ok' } = {}) {
  const adapters = new Map()
  const routes = []
  const warnings = []
  let injections = []
  const ctx = {
    logger: { info() {}, warn: (message) => warnings.push(String(message)) },
    get: (name) => services[name],
    effect(factory) { factory(); return () => {} },
    inject(_deps, callback) { injections.push(() => callback(ctx)); return () => {} },
    credentials: services.credentials,
    llm: {
      registerAdapter(providers, adapter) {
        if (llmBehaviour === 'foreign') {
          throw new Error(`an adapter for provider "${providers[0]}" is already declared`)
        }
        adapters.set(providers[0], adapter)
        return { replace() {} }
      },
    },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  return {
    ctx,
    adapters,
    routes,
    warnings,
    runInjections() { for (const run of injections) run(); injections = [] },
  }
}

function fakeReq(method, path, bodyText, headers = {}) {
  const chunks = bodyText === undefined ? [] : [Buffer.from(bodyText)]
  return {
    method,
    url: path,
    headers: { host: '127.0.0.1:43120', ...headers },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

function fakeRes() {
  return {
    status: 0,
    payload: undefined,
    writeHead(status) { this.status = status },
    end(body) { try { this.payload = JSON.parse(body) } catch { this.payload = body } },
  }
}

async function callRoute(handler, method, path, body, headers = {}) {
  const res = fakeRes()
  await handler(fakeReq(method, path, body === undefined ? undefined : JSON.stringify(body), headers), res)
  return res
}

// ── 场景 1：正常挂载 ────────────────────────────────────────────────────────
const credentials = makeCredentials()
const token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, nickname: '测试号' })
credentials.store.set('BUDDY_ACCOUNT_AAAABBBB', JSON.stringify({ access_token: token, refresh_token: 'r'.repeat(20), domain: 'copilot.tencent.com' }))
credentials.store.set('WORKBUDDY_ACCOUNT_CCCCDDDD', JSON.stringify({ access_token: token, refresh_token: 's'.repeat(20), domain: 'www.workbuddy.ai' }))

const accounts = new Map([
  ['buddy-aaaabbbb', { id: 'buddy-aaaabbbb', provider: 'buddy', nickname: '国内号', enabled: true, credentialRef: 'BUDDY_ACCOUNT_AAAABBBB', createdAt: 1, expiresAt: Date.now() + 3600_000, refreshable: true }],
  ['workbuddy-ccccdddd', { id: 'workbuddy-ccccdddd', provider: 'workbuddy', nickname: '国际号', enabled: true, credentialRef: 'WORKBUDDY_ACCOUNT_CCCCDDDD', createdAt: 1, refreshable: true }],
])
const pool = makePool(accounts, credentials)

const entry = await import(new URL('../index.js', import.meta.url).href)
check('name', () => assert.equal(entry.name, 'dsh-free-model'))
check('inject', () => assert.deepEqual([...entry.inject].sort(), ['credentials', 'llm']))
check('version 与 package.json 一致', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(entry.version, pkg.version)
})

/**
 * OpenCode 服务替身。
 *
 * 只实现适配器与路由真正用到的那几个方法；`start()` 假装成功并把
 * `running` 翻成 true —— 用来验证「服务型车道」那一整条链路，而不必真的
 * spawn 一个 Bun 进程（那会让单测依赖本机装没装 opencode）。
 */
function makeOpenCodeService({ running = true, models = [] } = {}) {
  let isRunning = running
  const client = {
    baseUrl: 'http://127.0.0.1:4096',
    // ⚠️ 目录来自 providers()（/config/providers），listModels 只做过滤。
    // 替身必须同时给出两者，否则 index.js 的「先取 provider 列表再过滤」会空转。
    async providers() {
      return [{ id: 'opencode', name: 'OpenCode', source: 'custom', models: [] }]
    },
    async listModels() { return models },
    async health() { return isRunning ? { healthy: true, version: '1.19.3' } : { healthy: false, error: 'ECONNREFUSED' } },
    async sessionFor(key, modelKey) { return 'ses_test_' + String(key) + '_' + String(modelKey ?? '').replace(/\W/g, '_') },
    forgetSession() {},
    sseEnabled: true,
    failures() { return {} },
    noteFailure() {},
    clearFailure() {},
    async *run(_sid, options) {
      yield { kind: 'reasoning', text: '想一下' }
      yield { kind: 'text', text: '你好' }
      yield { kind: 'done', tokens: { inputTokens: 10, outputTokens: 2, reasoningTokens: 3 }, finish: 'stop' }
    },
    async dispose() {},
  }
  return {
    client: () => client,
    async status() {
      return isRunning
        ? { running: true, version: '1.19.3', port: 4096, url: 'http://127.0.0.1:4096', managed: true, binary: 'stub' }
        : { running: false, port: 4096, url: 'http://127.0.0.1:4096', managed: false, binary: 'stub', error: 'ECONNREFUSED' }
    },
    async start() { isRunning = true; return { running: true, port: 4096, started: true } },
    stop() { const was = isRunning; isRunning = false; return { stopped: was } },
    async dispose() {},
  }
}

const opencodeModels = [
  { id: 'opencode/big-pickle', providerID: 'opencode', modelID: 'big-pickle', name: 'Big Pickle', contextWindow: 200_000, maxOutputTokens: 32_000, vision: false },
  { id: 'opencode/glm-5.3-flash-free', providerID: 'opencode', modelID: 'glm-5.3-flash-free', name: 'GLM 5.3 Flash (free)', contextWindow: 200_000, maxOutputTokens: 32_000, vision: true },
]

/**
 * 腾讯计费接口的替身。
 *
 * 积分那三个端点的**响应形状**（`code` / `data.Response.Data.Accounts` /
 * `today_checked_in`）必须与真实上游一致 —— 形状写错会让 core/credits.js 的
 * 解析器静默返回 null，测试于是「通过」而线上是空的。
 */
const billingCalls = { balance: 0, status: 0, claim: 0 }
function makeBillingFetcher() {
  return async (url) => {
    const path = new URL(String(url)).pathname
    const respond = (body) => ({ status: 200, async text() { return JSON.stringify(body) } })
    if (path.endsWith('/get-user-resource')) {
      billingCalls.balance += 1
      return respond({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [{
                PackageName: '月度包',
                CapacityUnit: 'credit',
                CycleCapacityRemain: 1234,
                CycleCapacitySize: 2000,
                CycleCapacityUsed: 766,
                Status: 1,
                CycleStartTime: '',
                CycleEndTime: '',
                ExpiredTime: '',
              }],
            },
          },
        },
      })
    }
    if (path.endsWith('/checkin-activity-status')) {
      billingCalls.status += 1
      return respond({
        code: 0,
        data: {
          active: true,
          today_checked_in: false,
          streak_days: 3,
          daily_credit: 10,
          today_credit: 0,
          is_streak_day: false,
          total_credits: 30,
          checkin_dates: [],
          activity_name: '活动',
          theme_name: '主题',
          end_time: '',
        },
      })
    }
    if (path.endsWith('/daily-checkin')) {
      billingCalls.claim += 1
      return respond({ code: 0, msg: '', data: { credit: 10, streak_days: 3, is_streak_day: false } })
    }
    return { status: 404, async text() { return 'not found' } }
  }
}

// 自动领积分的状态文件写到临时目录：单测不该碰用户真实的 ~/.dsh
// （`resolveDshHome` 优先读这个环境变量）。
process.env.DSH_CHANNEL_PACK_STATE_DIR = mkdtempSync(join(tmpdir(), 'free-model-test-'))

const billing = makeBillingFetcher()
const harness = makeCtx({ services: { credentials, accountPool: pool } })
entry.apply(harness.ctx, {
  opencodeService: makeOpenCodeService({ models: opencodeModels }),
  // 测试接缝：积分走假 fetch。后台定时器用默认的 30 秒延迟（unref，不会挂住进程），
  // 故这里的断言不会被一次后台跑批打乱。
  creditsFetcher: billing,
})
harness.runInjections()

check('三条车道都已注册', () => {
  // buddy / workbuddy 是账号型；opencode 是服务型。
  assert.deepEqual([...harness.adapters.keys()].sort(), ['buddy', 'opencode', 'workbuddy'])
})
check('注册了一条 prefix 路由', () => {
  assert.equal(harness.routes.length, 1)
  assert.equal(harness.routes[0].kind, 'prefix')
  assert.equal(harness.routes[0].path, '/api/free-model')
})

const buddy = harness.adapters.get('buddy')
const workbuddy = harness.adapters.get('workbuddy')

await checkAsync('providerInfo 用产品展示名', async () => {
  assert.equal((await buddy.providerInfo('buddy')).name, 'CodeBuddy (腾讯)')
  assert.equal((await workbuddy.providerInfo('workbuddy')).name, 'WorkBuddy (国际版)')
})

await checkAsync('模型目录来自产品兜底表', async () => {
  const buddyModels = await buddy.listModels('buddy')
  const workbuddyModels = await workbuddy.listModels('workbuddy')
  assert.ok(buddyModels.length >= 16, `buddy 目录过少: ${buddyModels.length}`)
  assert.ok(workbuddyModels.length >= 23, `workbuddy 目录过少: ${workbuddyModels.length}`)
  assert.ok(buddyModels.every((model) => model.provider === 'buddy'))
  assert.ok(workbuddyModels.every((model) => model.provider === 'workbuddy'))
})

await checkAsync('resolveModel 带上下文窗口与思考档位', async () => {
  const resolved = await buddy.resolveModel('buddy', 'deepseek-v4.1-flash')
  assert.equal(resolved.context.contextWindow, 1_000_000)
  assert.equal(resolved.defaultMaxTokens, 128_000)
  assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ['low', 'high', 'max'])
  assert.equal(resolved.reasoning.defaultEffort, 'high')
  assert.ok(resolved.inputModalities.includes('image'))
})

await checkAsync('prepareCall 返回可流式入口', async () => {
  const call = await buddy.prepareCall('buddy', 'deepseek-v4.1-flash')
  assert.equal(typeof call.stream, 'function')
  assert.equal(call.model.id, 'deepseek-v4.1-flash')
})

// ── HTTP 面 ────────────────────────────────────────────────────────────────
const handler = harness.routes[0].handler

await checkAsync('summary 报 route=registered 与池状态', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/summary')
  assert.equal(res.status, 200)
  assert.equal(res.payload.pool, 'host')
  // 账号车道只剩本插件自己挂的两条：宿主侧那 11 条车道已拆成独立插件
  // `dsh-ofm-lanes`，不再出现在这里的 products 里（它们有自己的一套 HTTP 面）。
  assert.deepEqual(res.payload.products.map((product) => product.id).sort(), ['buddy', 'workbuddy'])
  const nativeLanes = res.payload.products.filter((product) => product.backend === 'native')
  assert.equal(nativeLanes.length, 2)
  for (const product of nativeLanes) {
    assert.equal(product.route, 'registered')
    // 登录形态与积分能力必须随车道发出（页面据此渲染按钮/表单）。
    assert.ok(product.login === 'browser' || product.login === 'localPage')
    assert.equal(typeof product.credits.balance, 'boolean')
    assert.equal(typeof product.credits.claim, 'boolean')
  }
  // WorkBuddy 国际版没有签到接口：能力位必须如实为 false 且带说明。
  const workbuddy = nativeLanes.find((product) => product.id === 'workbuddy')
  assert.equal(workbuddy.credits.claim, false)
  assert.ok(typeof workbuddy.credits.claimNote === 'string' && workbuddy.credits.claimNote.length > 0)
})

await checkAsync('accounts 列出两个 provider 的账号', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/accounts')
  assert.equal(res.status, 200)
  assert.equal(res.payload.accounts.length, 2)
  assert.deepEqual(res.payload.accounts.map((a) => a.provider).sort(), ['buddy', 'workbuddy'])
})

await checkAsync('停用后再读，enabled 变 false', async () => {
  const off = await callRoute(handler, 'POST', '/api/free-model/account', { action: 'disable', id: 'buddy-aaaabbbb' })
  assert.equal(off.status, 200)
  const listed = await callRoute(handler, 'GET', '/api/free-model/accounts')
  assert.equal(listed.payload.accounts.find((a) => a.id === 'buddy-aaaabbbb').enabled, false)
  await callRoute(handler, 'POST', '/api/free-model/account', { action: 'enable', id: 'buddy-aaaabbbb' })
})

await checkAsync('删除只删索引、保留凭据', async () => {
  const res = await callRoute(handler, 'POST', '/api/free-model/account', { action: 'remove', id: 'workbuddy-ccccdddd' })
  assert.equal(res.status, 200)
  assert.equal(res.payload.credentialKept, true)
  assert.equal(credentials.store.has('WORKBUDDY_ACCOUNT_CCCCDDDD'), true)
  // 还原，后续用例还要用
  accounts.set('workbuddy-ccccdddd', { id: 'workbuddy-ccccdddd', provider: 'workbuddy', nickname: '国际号', enabled: true, credentialRef: 'WORKBUDDY_ACCOUNT_CCCCDDDD', createdAt: 1, refreshable: true })
})

await checkAsync('WorkBuddy 国际版拒绝签到（与移除前的文案一致）', async () => {
  const res = await callRoute(handler, 'POST', '/api/free-model/checkin', { provider: 'workbuddy' })
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /不支持每日签到/)
})

await checkAsync('未知路由 404', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/nope')
  assert.equal(res.status, 404)
})

await checkAsync('跨站请求被围栏挡住', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/accounts', undefined, {
    origin: 'http://evil.example',
    'sec-fetch-site': 'cross-site',
  })
  assert.equal(res.status, 403)
})

await checkAsync('非回环 Host 被围栏挡住', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/accounts', undefined, { host: '10.0.0.5:43120' })
  assert.equal(res.status, 403)
})

// ── 场景 2：OFM 2.5.7 占着路由（必须让位） ─────────────────────────────────
const foreign = makeCtx({ services: { credentials, accountPool: pool }, llmBehaviour: 'foreign' })
await checkAsync('路由已被占用时 apply 不抛错并留日志', async () => {
  entry.apply(foreign.ctx, {})
  foreign.runInjections()
  assert.equal(foreign.adapters.size, 0)
  assert.ok(foreign.warnings.some((line) => line.includes('已由其它实例注册')), '缺少让位日志')
})

await checkAsync('让位时 summary 报 route=yielded', async () => {
  const res = await callRoute(foreign.routes[0].handler, 'GET', '/api/free-model/summary')
  assert.equal(res.status, 200)
  // 只有 native 两条会被让位；OFM 侧 11 条本来就是宿主提供的，与此无关。
  for (const product of res.payload.products.filter((row) => row.backend === 'native')) {
    assert.equal(product.route, 'yielded')
  }
})

// ── 场景 3：池缺席 ──────────────────────────────────────────────────────────
const orphan = makeCtx({ services: { credentials } })
await checkAsync('池缺席时退化为本地实现并明确报 pool=local', async () => {
  entry.apply(orphan.ctx, {})
  orphan.runInjections()
  const res = await callRoute(orphan.routes[0].handler, 'GET', '/api/free-model/summary')
  assert.equal(res.status, 200)
  // 退化实现会读写同一份 channel-pack/state.json —— 页面必须说清楚这份池是谁的。
  assert.equal(res.payload.pool, 'local')
  assert.equal(res.payload.poolSource, 'channel-pack/state.json')
})

// ── 模型面板：清单与开关 ──────────────────────────────────────────────────
await checkAsync('/models 列出两个 provider 的全量模型', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/models')
  assert.equal(res.status, 200)
  // native 两条有全量目录；已迁走的那 11 条车道压根不在本插件的 products 里，
  // 故下面的断言只需覆盖 native 两条。
  const nativeModels = res.payload.products.filter((product) => product.backend === 'native')
  assert.equal(nativeModels.length, 2)
  for (const product of nativeModels) {
    assert.ok(product.total > 0, `${product.id} 没有模型`)
    assert.equal(product.models.length, product.total)
    assert.equal(product.disabled, 0)
    assert.equal(product.closed, false)
  }
  // ⚠️ 原先这里断言「OFM 侧 11 条在本插件的 /models 里是空目录」。那 11 条已拆到
  // `dsh-ofm-lanes`，本插件的 /models 里压根没有它们，故断言改成「一条 ofm 都不该有」。
  assert.equal(res.payload.products.filter((product) => product.backend === 'ofm').length, 0)
})

await checkAsync('/models 带元数据（上下文 / 思考档位 / 图片）', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/models?provider=buddy')
  const model = res.payload.products[0].models.find((row) => row.id === 'deepseek-v4.1-flash')
  assert.ok(model !== undefined, 'deepseek-v4.1-flash 不在清单里')
  assert.equal(model.contextWindow, 1_000_000)
  assert.deepEqual(model.reasoningEfforts, ['low', 'high', 'max'])
  assert.ok(model.inputModalities.includes('image'))
})

await checkAsync('关掉一个模型后清单里仍在、且标记为 disabled', async () => {
  const off = await callRoute(handler, 'POST', '/api/free-model/models', { provider: 'buddy', action: 'toggle', model: 'hy3', disabled: true })
  assert.equal(off.status, 200)
  const res = await callRoute(handler, 'GET', '/api/free-model/models?provider=buddy')
  const product = res.payload.products[0]
  const row = product.models.find((model) => model.id === 'hy3')
  // 关键：关掉的模型必须**仍被列出**，否则用户没法重新打开。
  assert.ok(row !== undefined, '关掉的模型从清单里消失了')
  assert.equal(row.disabled, true)
  assert.equal(product.disabled, 1)
})

await checkAsync('黑名单与池是同一份（disabledModelsFor 能看到）', async () => {
  assert.ok(pool.disabledModelsFor('buddy').has('hy3'))
})

await checkAsync('reset 清空黑名单', async () => {
  const res = await callRoute(handler, 'POST', '/api/free-model/models', { provider: 'buddy', action: 'reset' })
  assert.equal(res.status, 200)
  assert.equal(pool.disabledModelsFor('buddy').size, 0)
})

await checkAsync('all 批量关闭再批量打开', async () => {
  const off = await callRoute(handler, 'POST', '/api/free-model/models', { provider: 'buddy', action: 'all', disabled: true })
  assert.equal(off.status, 200)
  const afterOff = await callRoute(handler, 'GET', '/api/free-model/models?provider=buddy')
  assert.equal(afterOff.payload.products[0].closed, true)
  await callRoute(handler, 'POST', '/api/free-model/models', { provider: 'buddy', action: 'all', disabled: false })
  const afterOn = await callRoute(handler, 'GET', '/api/free-model/models?provider=buddy')
  assert.equal(afterOn.payload.products[0].closed, false)
})

await checkAsync('未知 provider 被拒', async () => {
  const res = await callRoute(handler, 'POST', '/api/free-model/models', { provider: 'nope', action: 'reset' })
  assert.equal(res.status, 400)
})

// ── OpenCode 车道（服务型） ────────────────────────────────────────────────
const opencode = harness.adapters.get('opencode')

await checkAsync('opencode 目录来自本地服务', async () => {
  const rows = await opencode.listModels('opencode')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => row.id).sort(), ['opencode/big-pickle', 'opencode/glm-5.3-flash-free'])
  // ⚠️ 能力来自上游声明：能看图的模型必须声明 image 模态，纯文本的**不能**声明
  // （否则宿主会把图片投给它，上游再回一句「我看不了图」）。
  const byId = new Map(rows.map((row) => [row.id, row]))
  assert.deepEqual(byId.get('opencode/big-pickle').inputModalities, ['text'])
  assert.deepEqual(byId.get('opencode/glm-5.3-flash-free').inputModalities, ['text', 'image'])
})

await checkAsync('opencode resolveModel 带上下文与输出上限', async () => {
  const resolved = await opencode.resolveModel('opencode', 'opencode/big-pickle')
  assert.equal(resolved.context.contextWindow, 200_000)
  assert.equal(resolved.defaultMaxTokens, 32_000)
  assert.deepEqual(resolved.inputModalities, ['text'])
  // 无工具车道不该声明思考档位：opencode 的接口没有这个入参。
  assert.equal(resolved.reasoning, undefined)
})

await checkAsync('opencode stream 产出 DSH chunk 序列', async () => {
  const chunks = []
  for await (const chunk of opencode.stream({
    model: 'opencode/big-pickle',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  })) {
    chunks.push(chunk)
  }
  const types = chunks.map((chunk) => chunk.type)
  assert.ok(types.includes('block-start'), '缺少 block-start')
  assert.ok(types.includes('reasoning-delta'), '缺少 reasoning-delta')
  assert.ok(types.includes('text-delta'), '缺少 text-delta')
  assert.ok(types.includes('usage'), '缺少 usage')
  assert.equal(types[types.length - 1], 'finish', '最后一个 chunk 必须是 finish')
  const finish = chunks[chunks.length - 1]
  assert.equal(finish.reason.kind, 'stop')
  // 文本增量必须真的带内容，而不是空帧。
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert.equal(text, '你好')
  const usage = chunks.find((chunk) => chunk.type === 'usage').usage
  assert.equal(usage.inputTokens, 10)
  assert.equal(usage.outputTokens, 2)
  assert.equal(usage.reasoningTokens, 3)
})

await checkAsync('opencode 只发最后一条 user 消息（历史由 session 承载）', async () => {
  const { foldMessages } = await import(new URL('../src/opencode/adapter.js', import.meta.url).href)
  const folded = foldMessages([
    { role: 'system', content: [{ type: 'text', text: '你是助手' }] },
    { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第一轮回答' }] },
    { role: 'user', content: [{ type: 'text', text: '第二轮' }] },
  ])
  assert.equal(folded.prompt, '第二轮')
  assert.equal(folded.system, '你是助手')
  // 历史里的图片不再重发：只在 opencode 的 session 里留一份，重复发等于重复计费。
  assert.deepEqual(folded.images, [])
})

await checkAsync('foldMessages 只收本轮图片', async () => {
  const { foldMessages } = await import(new URL('../src/opencode/adapter.js', import.meta.url).href)
  const folded = foldMessages([
    { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'old' } }] },
    { role: 'assistant', content: [{ type: 'text', text: '看到了' }] },
    { role: 'user', content: [
      { type: 'text', text: '这张呢' },
      { type: 'image', attachment: { attachmentId: 'new' } },
    ] },
  ])
  assert.deepEqual(folded.images.map((item) => item.attachment.attachmentId), ['new'])
})

await checkAsync('opencode 服务未运行时给出可操作错误', async () => {
  const { OpenCodeAdapter } = await import(new URL('../src/opencode/adapter.js', import.meta.url).href)
  const bare = new OpenCodeAdapter({
    client: () => undefined,
    models: async () => [],
    resolveModel: async () => undefined,
  })
  let message = ''
  try {
    for await (const _chunk of bare.stream({ model: 'opencode/x', messages: [] })) { /* 不应产出 */ }
  } catch (error) {
    message = error.message
  }
  // 错误必须告诉用户「去点哪个按钮」，而不是只说「失败」。
  assert.match(message, /未运行/)
  assert.match(message, /启动 OpenCode|opencode serve/)
})

await checkAsync('/opencode/status 报进程与路由两件事', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/opencode/status')
  assert.equal(res.status, 200)
  assert.equal(res.payload.lane.id, 'opencode')
  assert.equal(res.payload.lane.kind, 'service')
  // 能力标签从 text-only 改成 no-tools：这条车道能看图，缺的只有工具调用。
  assert.equal(res.payload.lane.capability, 'no-tools')
  assert.equal(res.payload.lane.mounted, true)
  assert.equal(res.payload.lane.route, 'registered')
  assert.equal(res.payload.service.running, true)
  assert.equal(res.payload.models.count, 2)
})

await checkAsync('/opencode/stop 与 /opencode/start 往返', async () => {
  const stopped = await callRoute(handler, 'POST', '/api/free-model/opencode/stop', {})
  assert.equal(stopped.status, 200)
  assert.equal(stopped.payload.stopped, true)
  const down = await callRoute(handler, 'GET', '/api/free-model/opencode/status')
  assert.equal(down.payload.service.running, false)
  const started = await callRoute(handler, 'POST', '/api/free-model/opencode/start', {})
  assert.equal(started.status, 200)
  assert.equal(started.payload.ok, true)
  assert.equal(started.payload.modelCount, 2)
  const up = await callRoute(handler, 'GET', '/api/free-model/opencode/status')
  assert.equal(up.payload.service.running, true)
})

await checkAsync('summary 把服务型车道单独列出、不混进账号型 products', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/summary')
  // 账号型只剩本插件自己的两条（OFM 那 11 条在另一个插件）。
  assert.deepEqual(res.payload.products.map((product) => product.id).sort(), ['buddy', 'workbuddy'])
  assert.equal(res.payload.serviceLanes.length, 1)
  assert.equal(res.payload.serviceLanes[0].id, 'opencode')
  assert.equal(res.payload.serviceLanes[0].capability, 'no-tools')
})

await checkAsync('服务型车道拒绝模型开关（不写进账号池）', async () => {
  const res = await callRoute(handler, 'POST', '/api/free-model/models', { provider: 'opencode', action: 'reset' })
  assert.equal(res.status, 409)
  assert.match(res.payload.error, /服务型车道/)
  // 关键：池里不能出现 opencode 的黑名单条目。
  assert.equal(Object.keys(pool.listDisabledModels('opencode')).length, 0)
})

await checkAsync('/models 不返回服务型车道（形状不同）', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/models')
  assert.equal(res.payload.products.length, 2, '账号型只剩 buddy / workbuddy')
  assert.ok(res.payload.products.every((product) => product.id !== 'opencode'))
})

// ── 未知 provider：不许静默成功 ──────────────────────────────────────────────
await checkAsync('未知 provider 一律被拒（既不是本插件的车道，也不是别处转来的）', async () => {
  // ⚠️ 原「OFM 侧车道在本插件的 HTTP 面上一律 409（backend-ofm）」那条断言随拆分下线：
  // 那些车道现在是 `dsh-ofm-lanes` 的产品，本插件的 products 表里已经找不到它们，
  // 于是请求落到「未知 provider」而不是「后端不归我」这两条不同的拒绝路径上。
  // 这里只钉住仍然成立的那条：**未知 provider 不许静默成功，也不许顺手改账号池**。
  const models = await callRoute(handler, 'POST', '/api/free-model/models', { provider: 'qoder', action: 'reset' })
  assert.ok(models.status === 400 || models.status === 409, '未知 provider 必须被拒，实际 ' + models.status)
  assert.equal(Object.keys(pool.listDisabledModels('qoder')).length, 0, '被拒的请求不许改账号池')
})

// ── 积分：余额 / 一键领取 / 自动领取开关 ─────────────────────────────────
await checkAsync('summary 带上每条车道的积分能力', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/summary')
  const buddy = res.payload.products.find((product) => product.id === 'buddy')
  const workbuddy = res.payload.products.find((product) => product.id === 'workbuddy')
  // CodeBuddy 有签到接口，WorkBuddy 国际版没有 —— 这是产品事实，页面据此渲染。
  assert.deepEqual(buddy.credits, { balance: true, claim: true })
  assert.equal(workbuddy.credits.balance, true)
  assert.equal(workbuddy.credits.claim, false)
})

await checkAsync('余额：逐账号查询并汇总', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/credits?provider=buddy')
  assert.equal(res.status, 200)
  assert.equal(res.payload.accounts.length, 1)
  const row = res.payload.accounts[0]
  assert.equal(row.accountId, 'buddy-aaaabbbb')
  assert.equal(row.balance.total, 1234)
  assert.equal(row.checkin.todayCheckedIn, false)
  assert.equal(row.checkin.streakDays, 3)
  assert.equal(res.payload.total, 1234)
  assert.equal(res.payload.known, 1)
  assert.equal(res.payload.failures, 0)
})

await checkAsync('余额有 60 秒缓存，force 才重新打上游', async () => {
  const before = billingCalls.balance
  const cached = await callRoute(handler, 'GET', '/api/free-model/credits?provider=buddy')
  assert.equal(cached.payload.cached, true)
  assert.equal(billingCalls.balance, before, '缓存命中时不该再打上游')
  await callRoute(handler, 'GET', '/api/free-model/credits?provider=buddy&force=1')
  assert.equal(billingCalls.balance, before + 1)
})

await checkAsync('余额：缺 provider / 未知 provider / 服务型车道都被拒', async () => {
  assert.equal((await callRoute(handler, 'GET', '/api/free-model/credits')).status, 400)
  assert.equal((await callRoute(handler, 'GET', '/api/free-model/credits?provider=nope')).status, 400)
  const lane = await callRoute(handler, 'GET', '/api/free-model/credits?provider=opencode')
  assert.equal(lane.status, 409)
  assert.match(lane.payload.error, /服务型车道/)
})

await checkAsync('一键领取：逐账号领取并汇总', async () => {
  const res = await callRoute(handler, 'POST', '/api/free-model/claim', { provider: 'buddy' })
  assert.equal(res.status, 200)
  assert.equal(res.payload.summary.claimed, 1)
  assert.equal(res.payload.summary.totalCredit, 10)
  assert.equal(res.payload.results[0].outcome.kind, 'claimed')
})

await checkAsync('WorkBuddy 拒绝一键领取（产品事实，不是暂时失败）', async () => {
  const res = await callRoute(handler, 'POST', '/api/free-model/claim', { provider: 'workbuddy' })
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /没有签到接口/)
})

await checkAsync('自动领积分：默认开启、今日未跑', async () => {
  const res = await callRoute(handler, 'GET', '/api/free-model/auto-checkin')
  assert.equal(res.status, 200)
  assert.equal(res.payload.autoCheckin.enabled, true)
  assert.equal(res.payload.autoCheckin.ranToday, false)
  assert.deepEqual(res.payload.autoCheckin.channels, [])
})

await checkAsync('自动领积分：立刻跑一轮 → 记下今日与结果', async () => {
  const res = await callRoute(handler, 'POST', '/api/free-model/auto-checkin', { run: true })
  const state = res.payload.autoCheckin
  assert.equal(state.ranToday, true)
  assert.match(state.lastResult, /1 个账号领取成功/)
  // WorkBuddy 没有签到接口，自动跑批必须把它标成「无签到接口」而不是失败。
  const workbuddy = state.channels.find((entry) => entry.provider === 'workbuddy')
  assert.equal(workbuddy.text, '无签到接口')
})

await checkAsync('自动领积分：开关写 false 后 state 变 false', async () => {
  const res = await callRoute(handler, 'POST', '/api/free-model/auto-checkin', { enabled: false })
  assert.equal(res.payload.autoCheckin.enabled, false)
  const back = await callRoute(handler, 'POST', '/api/free-model/auto-checkin', { enabled: true })
  assert.equal(back.payload.autoCheckin.enabled, true)
})

await checkAsync('自动领积分：非布尔 enabled 被拒（不静默回落）', async () => {
  const res = await callRoute(handler, 'POST', '/api/free-model/auto-checkin', { enabled: 'yes' })
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /布尔值/)
})

// ── 场景 4：浏览器半身的注册名 ─────────────────────────────────────────────
// Client Loader 用包名当 graph row 的 id：`__ModuleLoader__.load({id})` 写的名字
// 对不上包名时，它会判定「加载了却没注册」，回退到单包 URL 再执行一次，
// 第二次撞上重复注册 → Renderer boot failed for 1 plugin(s)。
check('client bundle 用包名注册', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  let registration
  const window = { __ModuleLoader__: { load(value) { registration = value } } }
  new Function('window', readFileSync(join(ROOT, 'client.js'), 'utf8'))(window)
  assert.ok(registration !== undefined, 'client.js 没有调用 __ModuleLoader__.load')
  assert.equal(registration.id, pkg.name)
  assert.equal(typeof registration.factory, 'function')
})

// ── 样式表：只用宿主真实存在的主题变量 ──────────────────────────────────
check('样式表不使用不存在的 --dsh-* 变量', () => {
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
  // `dsh-client-ui-theme` 定义的是 --dsw-alias-*；--dsh-* 一个都没有，
  // 写了只会静默退到硬编码回退色，浅/深主题都不跟随。
  const wrong = client.match(/--dsh-[a-z][a-z0-9-]*/g) ?? []
  assert.deepEqual(wrong, [], `发现不存在的变量: ${wrong.slice(0, 5).join(', ')}`)
  assert.ok(client.includes('--dsw-alias-'), '样式表没有使用任何宿主主题变量')
})

check('UI 原语在页面之前定义（避免 TDZ）', () => {
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
  // Switch / Pill / Button 曾经被写成 const 箭头函数放在页面之后，渲染时直接
  // ReferenceError（真实踩过：整页白屏）。现在它们是 function 声明（有提升），
  // 这条断言保证「定义在页面之前」这条约定不被下一次重构丢掉。
  for (const name of ['Switch', 'Pill', 'Button']) {
    const at = client.indexOf(`function ${name}`)
    assert.ok(at > 0, `${name} 未定义`)
    for (const page of ['function ConsolePage', 'function AccountsPage', 'function OpenCodePage', 'function ProductCard']) {
      const pageAt = client.indexOf(page)
      assert.ok(pageAt > 0, `${page} 未定义`)
      assert.ok(at < pageAt, `${name} 定义在 ${page.replace('function ', '')} 之后，渲染会抛 ReferenceError`)
    }
  }
})

// ── 结果 ───────────────────────────────────────────────────────────────────
console.log(`\n通过 ${passed} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log('  ✗', failure)
  process.exitCode = 1
} else {
  console.log('全部通过')
}
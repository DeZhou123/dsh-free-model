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
 * 6. HTTP 面的每一条路由 + 信任围栏。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

function makePool(accounts) {
  return {
    listAccountsByProvider(provider) { return [...accounts.values()].filter((a) => a.provider === provider) },
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
const pool = makePool(accounts)

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
    async listModels() { return models },
    async health() { return isRunning ? { healthy: true, version: '1.19.3' } : { healthy: false, error: 'ECONNREFUSED' } },
    async sessionFor(key) { return 'ses_test_' + key.replace(/\W/g, '_') },
    forgetSession() {},
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
  { id: 'opencode/big-pickle', providerID: 'opencode', modelID: 'big-pickle', name: 'Big Pickle', contextWindow: 200_000, maxOutputTokens: 32_000 },
  { id: 'opencode/glm-5.3-flash-free', providerID: 'opencode', modelID: 'glm-5.3-flash-free', name: 'GLM 5.3 Flash (free)', contextWindow: 200_000, maxOutputTokens: 32_000 },
]

const harness = makeCtx({ services: { credentials, accountPool: pool } })
entry.apply(harness.ctx, { opencodeService: makeOpenCodeService({ models: opencodeModels }) })
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
  assert.equal(res.payload.products.length, 2)
  for (const product of res.payload.products) assert.equal(product.route, 'registered')
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
  for (const product of res.payload.products) assert.equal(product.route, 'yielded')
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
  assert.equal(res.payload.products.length, 2)
  for (const product of res.payload.products) {
    assert.ok(product.total > 0, `${product.id} 没有模型`)
    assert.equal(product.models.length, product.total)
    assert.equal(product.disabled, 0)
    assert.equal(product.closed, false)
  }
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
  // ⚠️ 纯文本车道：**不能**声明 image 模态，否则宿主会把图片投给它。
  for (const row of rows) assert.deepEqual(row.inputModalities, ['text'])
})

await checkAsync('opencode resolveModel 带上下文与输出上限', async () => {
  const resolved = await opencode.resolveModel('opencode', 'opencode/big-pickle')
  assert.equal(resolved.context.contextWindow, 200_000)
  assert.equal(resolved.defaultMaxTokens, 32_000)
  assert.deepEqual(resolved.inputModalities, ['text'])
  // 纯文本车道不该声明思考档位：opencode 的接口没有这个入参。
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
  assert.equal(res.payload.lane.capability, 'text-only')
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
  assert.equal(res.payload.products.length, 2, '账号型车道应只有两条')
  assert.equal(res.payload.serviceLanes.length, 1)
  assert.equal(res.payload.serviceLanes[0].id, 'opencode')
  assert.equal(res.payload.serviceLanes[0].capability, 'text-only')
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
  assert.equal(res.payload.products.length, 2)
  assert.ok(res.payload.products.every((product) => product.id !== 'opencode'))
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
  // Switch / Pill / Button 是 const 箭头函数，没有提升；若定义在 SettingsPage
  // 之后，渲染时会抛 ReferenceError（真实踩过：整页白屏）。
  const page = client.indexOf('function SettingsPage')
  for (const name of ['Switch', 'Pill', 'Button']) {
    const at = client.indexOf(`function ${name}`)
    assert.ok(at > 0, `${name} 未定义`)
    assert.ok(at < page, `${name} 定义在 SettingsPage 之后，渲染会抛 ReferenceError`)
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
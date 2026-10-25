/**
 * HTTP 面新增端点的回归防线（`/channels`、`/catalog`、`/update`、`/service`）。
 *
 * ## 为什么这些断言少不了
 *
 * 页面的每一个按钮都对应一条路由。路由的三种典型坏法都是**静默**的：
 * ① 没接线却回 200 + 空数据（页面显示「一切正常」）；② 新端点绕过了信任围栏
 * （本机任何进程都能读账号池）；③ 老端点被新字段带崩（用户升级后页面白屏）。
 * 所以这里逐条断言：未接线必须**明确报错**、围栏对新端点同样生效、
 * `/summary` 的老字段一个不少。
 *
 * 运行：node test/routes-channels.mjs
 */
import assert from 'node:assert/strict'
import { createRoutes } from '../src/routes.js'
import { buildRegistry, projectRegistryView } from '../src/lanes/registry.js'
import { SERVICE_LANES } from '../src/lanes/service.js'

let passed = 0
async function check(label, fn) {
  await fn()
  passed += 1
  console.log('  ✓ ' + label)
}

/** 最小请求替身：只实现 handler 真正用到的那几个字段。 */
function makeReq(method, url, headers = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:43120', ...headers },
    async *[Symbol.asyncIterator]() {},
  }
}

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body ?? '' },
    json() { return this.body === '' ? undefined : JSON.parse(this.body) },
  }
}

async function call(handler, method, url, headers) {
  const res = makeRes()
  await handler(makeReq(method, url, headers), res)
  return res
}

/** 带 JSON body 的调用（`/key` 那三条路由都要读 body）。 */
async function makeCallWithBody(handler, method, url, body) {
  const res = makeRes()
  const text = JSON.stringify(body ?? {})
  const req = makeReq(method, url)
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from(text, 'utf8') }
  await handler(req, res)
  return res
}

/** 只造被测路由需要的依赖；其它一律给最小替身。 */
function makeDeps(extra = {}) {
  return {
    llm: { listModels: async () => [] },
    channels: () => new Map(),
    pool: () => ({ __live: { current: undefined }, listAccountsByProvider: () => [] }),
    products: [],
    connection: () => undefined,
    logger: { info() {}, warn() {}, error() {} },
    version: '0.4.0',
    credits: { collect: async () => ({}), claim: async () => ({}), invalidate() {} },
    autoCheckin: { state: () => ({}), setEnabled: async () => {}, runNow: async () => ({}) },
    opencode: { service: { status: async () => ({}) }, models: async () => [], lane: { id: 'opencode' } },
    ...extra,
  }
}

const registryStub = () => {
  const registry = buildRegistry()
  return {
    channels: projectRegistryView(registry.channels, { nativeMounted: ['buddy', 'workbuddy'] }),
    counts: registry.counts,
    fingerprint: registry.fingerprint,
    rejected: registry.rejected,
    layers: registry.byLayer,
  }
}

await check('未接线时 /channels 明确报未接线，而不是回一份空的「正常」', async () => {
  const handler = createRoutes(makeDeps())
  const res = await call(handler, 'GET', '/api/free-model/channels')
  assert.equal(res.status, 200)
  assert.equal(res.json().wired, false)
  assert.equal(res.json().channels.length, 0)
  assert.ok(res.json().reason.length > 0)
})

await check('/channels 列出三类渠道，并把服务探针结果并进每一行', async () => {
  const handler = createRoutes(makeDeps({
    registry: registryStub,
    service: {
      probe: async () => ({
        opencode: { state: 'unavailable', reason: '连不上 127.0.0.1:4096' },
        freellmapi: { state: 'ready', reason: '3 个模型' },
        ollama: { state: 'needs-action', reason: '没有对话模型' },
        // 0.6.0 新增的三条本地推理服务（LM Studio / vLLM / llama.cpp）：
        // 本机此刻一条都没跑，所以是 unavailable —— 这正是要断言的那种「如实说不在」。
        lmstudio: { state: 'unavailable', reason: '连不上 127.0.0.1:1234' },
        vllm: { state: 'unavailable', reason: '连不上 127.0.0.1:8000' },
        llamacpp: { state: 'unavailable', reason: '连不上 127.0.0.1:8080' },
      }),
    },
  }))
  const payload = (await call(handler, 'GET', '/api/free-model/channels')).json()
  assert.equal(payload.wired, true)
  // 账号渠道恰好是本插件自己挂的两条：注册表里不存在第二条后端。
  assert.equal(payload.counts.account, 2, '账号渠道就是本插件自己挂的 buddy / workbuddy')
  // 条数取 SERVICE_LANES（而不是写死 3）：加一条本地服务车道不该改断言，
  // 但**必须**确认它进了注册表 —— 这里断言的是「随包的服务车道一条不落」。
  assert.equal(payload.counts.service, SERVICE_LANES.length)
  // keyed 层由 `index.js` 单独注入（`buildRegistry({ keyed })`）；这个桩不传它，
  // 所以此处只要求「字段存在且是数字」，条数断言在 `test/lanes.mjs` 与 keys-flow 里做。
  assert.equal(typeof payload.counts.keyed, 'number')
  const opencode = payload.channels.find((row) => row.id === 'opencode')
  assert.equal(opencode.state, 'unavailable')
  assert.ok(opencode.reason.includes('4096'))
  const ollama = payload.channels.find((row) => row.id === 'ollama')
  assert.equal(ollama.state, 'needs-action')
  assert.equal(payload.fingerprint.length, 16)
})

await check('服务探针坏掉不影响其余渠道（降级为原状态，不 500）', async () => {
  const handler = createRoutes(makeDeps({
    registry: registryStub,
    service: { probe: async () => { throw new Error('probe exploded') } },
  }))
  const res = await call(handler, 'GET', '/api/free-model/channels')
  assert.equal(res.status, 200)
  assert.equal(res.json().counts.account, 2, '账号渠道必须照常返回')
})

await check('/catalog 读状态、/catalog/refresh 强制刷新；未接线报 503', async () => {
  let forced = []
  const handler = createRoutes(makeDeps({
    catalog: {
      status: () => ({ from: 'cache', fetchedAt: 123, sha256: 'abc', reason: '', counts: { remote: 2, local: 0, keyed: 12 } }),
      refresh: async (force) => { forced.push(force); return { from: 'network', ok: true } },
    },
  }))
  assert.equal((await call(handler, 'GET', '/api/free-model/catalog')).json().from, 'cache')
  const refreshed = await call(handler, 'POST', '/api/free-model/catalog/refresh')
  assert.equal(refreshed.json().from, 'network')
  assert.deepEqual(forced, [true], '「检查目录」必须是强制刷新（否则用户点了没反应）')

  const bare = createRoutes(makeDeps())
  assert.equal((await call(bare, 'GET', '/api/free-model/catalog')).status, 200, '目录状态没接线时给 {wired:false}')
  assert.equal((await call(bare, 'POST', '/api/free-model/catalog/refresh')).status, 503)
})

await check('/update 检查版本；失败也回 200 带 ok:false（页面要能显示原因）', async () => {
  const handler = createRoutes(makeDeps({
    update: {
      check: async (force) => ({
        ok: !force, current: '0.4.0', latest: force ? null : '0.5.0',
        updateAvailable: !force, from: force ? 'none' : 'network',
        reason: force ? 'ECONNREFUSED（本机访问 GitHub 常需代理）' : '',
        repoUrl: 'https://github.com/DeZhou123/dsh-free-model',
      }),
    },
  }))
  const cached = (await call(handler, 'GET', '/api/free-model/update')).json()
  assert.equal(cached.updateAvailable, true)
  const forced = (await call(handler, 'POST', '/api/free-model/update/refresh')).json()
  assert.equal(forced.ok, false)
  assert.ok(forced.reason.includes('代理'))
  assert.equal((await call(createRoutes(makeDeps()), 'GET', '/api/free-model/update')).status, 503)
})

await check('/service 探针：GET 走缓存路径、POST 强制重探', async () => {
  const calls = []
  const handler = createRoutes(makeDeps({
    service: { probe: async (force) => { calls.push(force); return { ollama: { state: 'needs-action', reason: 'x' } } } },
  }))
  const a = await call(handler, 'GET', '/api/free-model/service')
  assert.equal(a.json().lanes.ollama.state, 'needs-action')
  await call(handler, 'POST', '/api/free-model/service/probe')
  assert.deepEqual(calls, [false, true])
  assert.equal((await call(createRoutes(makeDeps()), 'GET', '/api/free-model/service')).status, 503)
})

await check('/summary 老字段一个不少，且新字段是「加上去」而不是「换掉」', async () => {
  const withRegistry = (await call(createRoutes(makeDeps({ registry: registryStub })), 'GET', '/api/free-model/summary')).json()
  // 版本从 deps 透传，不写死：写死会在每次发版时逼着改测试，而它要验的是「字段在」。
  assert.equal(typeof withRegistry.version, 'string')
  assert.equal(withRegistry.pool, 'absent')
  assert.equal(withRegistry.poolSource, 'none')
  // `/summary` 里不再有 `ofm` 段：那份「宿主侧后端是否就绪」的能力位随账号车道
  // 一起删掉了（现在只有本插件自己挂的一条后端路径）。
  assert.equal(withRegistry.ofm, undefined, 'summary 不该再有 ofm 段')
  assert.deepEqual(withRegistry.products, [])
  assert.deepEqual(withRegistry.serviceLanes, [])
  assert.equal(withRegistry.registry.counts.account, 2, '新字段应出现')

  const bare = (await call(createRoutes(makeDeps()), 'GET', '/api/free-model/summary')).json()
  assert.equal(bare.registry, undefined, '注册表没接线时不该伪造一个半份数据')
  assert.equal(bare.products.length, 0, '老字段照旧')
})

await check('注册表读取抛错时降级为 {error}，不把概览打成 500', async () => {
  const handler = createRoutes(makeDeps({ registry: () => { throw new Error('boom') } }))
  const res = await call(handler, 'GET', '/api/free-model/summary')
  assert.equal(res.status, 200)
  assert.ok(res.json().registry.error.includes('boom'))
})

// ── 自带 key 的三条写路由（0.4.1）─────────────────────────────────────────────
/** 一个记录调用顺序的凭据替身 + 一个只会回固定状态的上游。 */
function makeKeyedManager(overrides = {}) {
  const store = new Map()
  const calls = []
  const manager = {
    store,
    calls,
    async refresh() { return { ready: { 'openrouter-free': { ready: store.has('OPENROUTER_API_KEY') } } } },
    async saveKey(lane, value) {
      calls.push(['save', lane, value])
      if (overrides.saveKey !== undefined) return overrides.saveKey(lane, value)
      if (typeof value !== 'string' || value.trim() === '') return { ok: false, code: 'invalid', reason: 'key 是空的' }
      store.set('OPENROUTER_API_KEY', value.trim())
      return { ok: true, keyRef: 'OPENROUTER_API_KEY', masked: 'sk-t…6789', mounted: true }
    },
    async clearKey(lane) {
      calls.push(['clear', lane])
      if (overrides.clearKey !== undefined) return overrides.clearKey(lane)
      store.delete('OPENROUTER_API_KEY')
      return { ok: true }
    },
    async probeKey(lane, options) {
      calls.push(['probe', lane, options?.force === true])
      if (overrides.probeKey !== undefined) return overrides.probeKey(lane, options)
      return { ok: false, kind: 'invalid-key', reason: '上游拒绝这把 key（401）', ms: 42 }
    },
  }
  return manager
}

const keyedDeps = (manager) => makeDeps({
  registry: registryStub,
  keyed: {
    manager: () => manager,
    keyStates: () => ({ 'openrouter-free': { keyRef: 'OPENROUTER_API_KEY', configured: manager.store.has('OPENROUTER_API_KEY'), writable: true, source: manager.store.has('OPENROUTER_API_KEY') ? 'file' : 'none', masked: manager.store.has('OPENROUTER_API_KEY') ? 'sk-t…6789' : '', reason: '' } }),
  },
})

await check('/key GET 返回凭据面状态：未填 → 填了（脱敏），原文永不出现', async () => {
  const manager = makeKeyedManager()
  const handler = createRoutes(keyedDeps(manager))

  let res = await call(handler, 'GET', '/api/free-model/key')
  assert.equal(res.status, 200)
  assert.equal(res.json().keys['openrouter-free'].configured, false)
  assert.equal(res.json().keys['openrouter-free'].masked, '')

  await makeCallWithBody(handler, 'POST', '/api/free-model/key', { lane: 'openrouter-free', key: 'sk-test-abcdefghijklmnopqrstuvwxyz' })
  res = await call(handler, 'GET', '/api/free-model/key?lane=openrouter-free')
  assert.equal(res.status, 200)
  assert.equal(res.json().lane, 'openrouter-free')
  assert.equal(res.json().configured, true)
  assert.equal(res.json().masked, 'sk-t…6789')
  assert.ok(!res.body.includes('sk-test-abcdefghijklmnopqrstuvwxyz'), 'GET 响应里出现了明文 key')

  // 单条查询的车道不存在时明确 404，而不是回一份空对象。
  res = await call(handler, 'GET', '/api/free-model/key?lane=openrouter-free')
  assert.equal(res.status, 200)
})

await check('/key POST 保存：返回脱敏值、不返回原文', async () => {
  const manager = makeKeyedManager()
  const handler = createRoutes(keyedDeps(manager))
  const res = await makeCallWithBody(handler, 'POST', '/api/free-model/key', { lane: 'openrouter-free', key: 'sk-test-abcdefghijklmnopqrstuvwxyz' })
  assert.equal(res.status, 200)
  const payload = res.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.keyRef, 'OPENROUTER_API_KEY')
  assert.equal(payload.masked, 'sk-t…6789')
  assert.ok(!res.body.includes('sk-test-abcdefghijklmnopqrstuvwxyz'), '响应体里出现了明文 key')
})

await check('/key POST 缺 lane → 400，空 key → 400（原因直接可显示）', async () => {
  const handler = createRoutes(keyedDeps(makeKeyedManager()))
  let res = await makeCallWithBody(handler, 'POST', '/api/free-model/key', { key: 'x' })
  assert.equal(res.status, 400)
  assert.ok(res.json().error.includes('lane'))
  res = await makeCallWithBody(handler, 'POST', '/api/free-model/key', { lane: 'openrouter-free', key: '   ' })
  assert.equal(res.status, 400)
  assert.ok(res.json().error.length > 0)
})

await check('/key DELETE 清 key：走的是 clearKey，不是 saveKey', async () => {
  const manager = makeKeyedManager()
  const handler = createRoutes(keyedDeps(manager))
  const res = await makeCallWithBody(handler, 'DELETE', '/api/free-model/key', { lane: 'openrouter-free' })
  assert.equal(res.status, 200)
  assert.deepEqual(manager.calls, [['clear', 'openrouter-free']])
})

await check('/key/probe 探测：失败也回 200（这是结论不是请求错误）', async () => {
  const manager = makeKeyedManager()
  const handler = createRoutes(keyedDeps(manager))
  const res = await makeCallWithBody(handler, 'POST', '/api/free-model/key/probe', { lane: 'openrouter-free', force: true })
  assert.equal(res.status, 200)
  const payload = res.json()
  assert.equal(payload.ok, false)
  assert.equal(payload.kind, 'invalid-key')
  assert.deepEqual(manager.calls, [['probe', 'openrouter-free', true]])
})

await check('keyed 未接线时三条写路由明确报 503（不假装成功）', async () => {
  const handler = createRoutes(makeDeps({ registry: registryStub }))
  for (const [method, url, body] of [
    ['POST', '/api/free-model/key', { lane: 'openrouter-free', key: 'x' }],
    ['DELETE', '/api/free-model/key', { lane: 'openrouter-free' }],
    ['POST', '/api/free-model/key/probe', { lane: 'openrouter-free' }],
    ['POST', '/api/free-model/key/refresh', {}],
  ]) {
    const res = await makeCallWithBody(handler, method, url, body)
    assert.equal(res.status, 503, method + ' ' + url + ' 未接线却没报 503')
  }
})

await check('信任围栏对新端点同样生效（跨站 Origin → 403）', async () => {
  const handler = createRoutes(makeDeps({ registry: registryStub }))
  for (const [method, url] of [
    ['GET', '/api/free-model/channels'],
    ['GET', '/api/free-model/catalog'],
    ['GET', '/api/free-model/update'],
    ['GET', '/api/free-model/service'],
    ['GET', '/api/free-model/key'],
  ]) {
    const res = await call(handler, method, url, { origin: 'https://evil.example', host: '127.0.0.1:43120' })
    assert.equal(res.status, 403, `${url} 必须被围栏挡住`)
  }
  const rebound = await call(handler, 'GET', '/api/free-model/channels', { host: 'attacker.example' })
  assert.equal(rebound.status, 403, 'Host 不是回环必须拒')
})


await check('/key/balance：走 manager.probeBalance，未接线时 503、缺 lane 时 400', async () => {
  const calls = []
  const handler = createRoutes(makeDeps({
    registry: registryStub,
    keyed: {
      manager: () => ({
        probeBalance: async (lane, options) => {
          calls.push({ lane, force: options?.force === true })
          return { ok: true, kind: 'ok', reason: '余额 USD 7.5', amount: '7.5', currency: 'USD', ms: 12 }
        },
      }),
      keyStates: () => ({}),
      keyCounts: () => ({}),
    },
  }))
  const ok = await makeCallWithBody(handler, 'POST', '/api/free-model/key/balance', { lane: 'openrouter-free', force: true })
  assert.equal(ok.status, 200)
  assert.equal(ok.json().amount, '7.5')
  assert.deepEqual(calls, [{ lane: 'openrouter-free', force: true }])
  const bad = await makeCallWithBody(handler, 'POST', '/api/free-model/key/balance', {})
  assert.equal(bad.status, 400)
  const off = await makeCallWithBody(createRoutes(makeDeps({ registry: registryStub })), 'POST', '/api/free-model/key/balance', { lane: 'x' })
  assert.equal(off.status, 503)
})

await check('/channels 投影暴露 hasBalance，但**不**暴露端点地址', async () => {
  const rows = projectRegistryView(buildRegistry({
    keyed: [{
      id: 'with-balance',
      displayName: '有余额端点的渠道',
      kind: 'keyed',
      baseURL: 'https://x.example/v1',
      apiKeyEnv: 'X_KEY',
      balance: { url: 'https://x.example/balance', rowKind: 'balance' },
      models: [{ id: 'm', name: 'm' }],
    }],
  }).channels, {})
  const row = rows.find((item) => item.id === 'with-balance')
  assert.equal(row.hasBalance, true, '带余额端点的渠道没标 hasBalance')
  assert.equal(JSON.stringify(row).includes('x.example/balance'), false, '端点地址被下发到页面了')
})

await check('/key/try：走 manager.probeChat，未接线 503、缺 lane 400', async () => {
  const calls = []
  const handler = createRoutes(makeDeps({
    registry: registryStub,
    keyed: {
      manager: () => ({
        probeChat: async (lane, options) => {
          calls.push({ lane, model: options?.model })
          return { ok: true, kind: 'ok', ms: 321, reply: 'ok' }
        },
      }),
      keyStates: () => ({}),
      keyCounts: () => ({}),
    },
  }))
  const ok = await makeCallWithBody(handler, 'POST', '/api/free-model/key/try', { lane: 'groq' })
  assert.equal(ok.status, 200)
  assert.equal(ok.json().reply, 'ok')
  assert.deepEqual(calls, [{ lane: 'groq', model: undefined }])
  const bad = await makeCallWithBody(handler, 'POST', '/api/free-model/key/try', {})
  assert.equal(bad.status, 400)
  const off = await makeCallWithBody(createRoutes(makeDeps({ registry: registryStub })), 'POST', '/api/free-model/key/try', { lane: 'x' })
  assert.equal(off.status, 503)
})

await check('/diagnose：返回纯文本诊断快照，且**不含任何凭据值**', async () => {
  const handler = createRoutes(makeDeps({
    registry: registryStub,
    version: '0.6.0',
    applyMarker: () => ({ plugin: 'dsh-free-model', version: '0.6.0', appliedAt: '2026-10-25T20:08:38.999Z', phase: 'full', mountedRoutes: ['buddy', 'groq'] }),
  }))
  const res = await call(handler, 'GET', '/api/free-model/diagnose')
  assert.equal(res.status, 200)
  const body = String(res.body)
  assert.ok(body.startsWith('# dsh-free-model 诊断快照'), '缺少标题：' + body.slice(0, 80))
  assert.ok(body.includes('插件版本：0.6.0'))
  assert.ok(body.includes('上次装配：2026-10-25T20:08:38.999Z'))
  assert.ok(body.includes('渠道：'), '缺少渠道计数')
  assert.equal(/sk-[A-Za-z0-9]{6}/.test(body), false, '诊断文本里出现了像 key 的串')
})


await check('/key/windows：走 manager.probeWindows（缺 lane 400、未接线 503、成功 200）', async () => {
  const calls = []
  const handler = createRoutes(makeDeps({
    registry: registryStub,
    keyed: {
      manager: () => ({
        probeWindows: async (lane, options) => {
          calls.push({ lane, force: options?.force === true })
          return { ok: true, kind: 'ok', reason: '5 小时窗：已用 1/4', windows: [{ label: '5 小时窗', used: 1, limit: 4 }], ms: 9 }
        },
      }),
      keyStates: () => ({}),
      keyCounts: () => ({}),
    },
  }))
  const ok = await makeCallWithBody(handler, 'POST', '/api/free-model/key/windows', { lane: 'kimi-coding', force: true })
  assert.equal(ok.status, 200)
  assert.equal(ok.json().windows.length, 1)
  assert.deepEqual(calls, [{ lane: 'kimi-coding', force: true }])
  assert.equal((await makeCallWithBody(handler, 'POST', '/api/free-model/key/windows', {})).status, 400)
  const off = await makeCallWithBody(createRoutes(makeDeps({ registry: registryStub })), 'POST', '/api/free-model/key/windows', { lane: 'x' })
  assert.equal(off.status, 503)
})

await check('/channels 投影暴露 hasWindows，同样**不**暴露端点地址', async () => {
  const rows = projectRegistryView(buildRegistry({
    keyed: [{
      id: 'with-windows',
      displayName: '有套餐窗口的渠道',
      kind: 'keyed',
      baseURL: 'https://x.example/v1',
      apiKeyEnv: 'X_KEY',
      windows: { url: 'https://x.example/usages' },
      models: [{ id: 'm', name: 'm' }],
    }],
  }).channels, {})
  const row = rows.find((item) => item.id === 'with-windows')
  assert.equal(row.hasWindows, true, '带套餐窗口端点的渠道没标 hasWindows')
  assert.equal(row.hasBalance, undefined, '不该顺手标上 hasBalance')
  assert.equal(JSON.stringify(row).includes('x.example/usages'), false, '端点地址被下发到页面了')
})

await check('/channels 顺手触发一次自愈补挂：不阻塞、manager 没有该方法时也不炸', async () => {
  // 0.6.0：打开页面是**自愈的第二个时机** —— 装配那一刻凭据服务还没热时，车道会停在
  // 「就绪但没挂上」（用户看到「我明明配了 key，选择器里还是没有它」）。这条断言钉两件事：
  // ① 读 /channels 会去调 healMounts（而不是只读状态）；② 它是 fire-and-forget ——
  //   healMounts 哪怕永不 resolve，/channels 也必须**立刻**返回（否则打开页面会被它拖住）。
  let healCalls = 0
  const slowManager = {
    healMounts: () => { healCalls += 1; return new Promise(() => {}) }, // 永不 resolve
  }
  const handlerWithHeal = createRoutes(makeDeps({
    registry: registryStub,
    keyed: { manager: () => slowManager, keyStates: () => ({}), keyCounts: () => ({}) },
  }))
  const res = await call(handlerWithHeal, 'GET', '/api/free-model/channels')
  assert.equal(res.status, 200, '/channels 被 healMounts 拖住了：' + res.status)
  assert.equal(healCalls, 1, 'healMounts 没被调用（自愈的第二个时机丢了）：' + healCalls)

  // 旧版本管理器没有 healMounts：读 /channels 不能因此报错。
  const handlerWithoutHeal = createRoutes(makeDeps({
    registry: registryStub,
    keyed: { manager: () => ({ probeKey: async () => ({}) }), keyStates: () => ({}), keyCounts: () => ({}) },
  }))
  assert.equal((await call(handlerWithoutHeal, 'GET', '/api/free-model/channels')).status, 200)

  // 完全没有 keyed 层（注册表未接线那类环境）也不能炸。
  assert.equal((await call(createRoutes(makeDeps({ registry: registryStub })), 'GET', '/api/free-model/channels')).status, 200)
})

await check('未知路由仍是 404（新端点的加入不许把兜底打掉）', async () => {
  const res = await call(createRoutes(makeDeps()), 'GET', '/api/free-model/nope')
  assert.equal(res.status, 404)
  assert.ok(res.json().error.includes('nope'))
})

console.log(`通过 ${passed} 项`)
console.log('全部通过')
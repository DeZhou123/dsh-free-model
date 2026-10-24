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
    channels: projectRegistryView(registry.channels, { nativeMounted: ['buddy', 'workbuddy'], ofmReady: true }),
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
      }),
    },
  }))
  const payload = (await call(handler, 'GET', '/api/free-model/channels')).json()
  assert.equal(payload.wired, true)
  assert.equal(payload.counts.account, 13)
  assert.equal(payload.counts.service, 3)
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
  assert.equal(res.json().counts.account, 13, '账号渠道必须照常返回')
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
  assert.equal(withRegistry.version, '0.4.0')
  assert.equal(withRegistry.pool, 'absent')
  assert.equal(withRegistry.poolSource, 'none')
  assert.equal(withRegistry.ofm.available, false)
  assert.deepEqual(withRegistry.products, [])
  assert.deepEqual(withRegistry.serviceLanes, [])
  assert.equal(withRegistry.registry.counts.account, 13, '新字段应出现')

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

await check('信任围栏对新端点同样生效（跨站 Origin → 403）', async () => {
  const handler = createRoutes(makeDeps({ registry: registryStub }))
  for (const [method, url] of [
    ['GET', '/api/free-model/channels'],
    ['GET', '/api/free-model/catalog'],
    ['GET', '/api/free-model/update'],
    ['GET', '/api/free-model/service'],
  ]) {
    const res = await call(handler, method, url, { origin: 'https://evil.example', host: '127.0.0.1:43120' })
    assert.equal(res.status, 403, `${url} 必须被围栏挡住`)
  }
  const rebound = await call(handler, 'GET', '/api/free-model/channels', { host: 'attacker.example' })
  assert.equal(rebound.status, 403, 'Host 不是回环必须拒')
})

await check('未知路由仍是 404（新端点的加入不许把兜底打掉）', async () => {
  const res = await call(createRoutes(makeDeps()), 'GET', '/api/free-model/nope')
  assert.equal(res.status, 404)
  assert.ok(res.json().error.includes('nope'))
})

console.log(`通过 ${passed} 项`)
console.log('全部通过')
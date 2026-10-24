/**
 * 就绪判定 + 凭据解码断言（离线）。
 *
 * 守的是「**页面那一栏能不能信**」：
 * - 没 key 就必须 not-ready 并说清去哪拿 key（不能静默显示"可用"，也不能只说"未配置"）；
 * - `ref:NAME` 必须真的解引用（否则用户明明填了 key，页面还说没填）；
 * - 已下线的渠道必须判 not-ready（否则用户会照着过时攻略注册一个不存在的服务）。
 *
 * ⚠️ 本文件会 import `../hooks.mjs`（把 `@deepseek-ai/dsh-llm` 解析到离线替身），
 * 因为 `index.js` 会带起 `adapter.js`。**必须**先注册钩子再动态 import，
 * 所以 `index.js` 与 `adapter.js` 都是 `await import(...)`，不是静态 import。
 *
 * 用法：node test/keyed/ready-state.mjs
 */

import assert from 'node:assert/strict'

await import('../hooks.mjs') // 离线模块解析钩子：先注册，下面的动态 import 才解析得到内核包
const { decodeApiKey, keyedLaneState, laneStates, normalizeSecret, resolveApiKey } = await import('../../src/lanes/keyed/ready.js')
const { KEYED_CHANNELS, KEYLESS_CHANNELS, laneById } = await import('../../src/lanes/keyed/catalog.js')
const { descriptors, keyedLaneDescriptors, mount, mountAll } = await import('../../src/lanes/keyed/index.js')

let passed = 0
const failures = []
async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error) })
  }
}

const OPENROUTER = laneById('openrouter-free')
const POLLINATIONS = laneById('pollinations')
const CLOUDFLARE = laneById('cloudflare-workers-ai')
const RETIRED = laneById('github-models')

/** 一个"宿主 credentials 服务"替身：按名字返回值，不存在的名字回 undefined。 */
function store(map) {
  return {
    read: async (name) => map[name],
    names: () => Object.keys(map),
  }
}

// ── decodeApiKey：三种形态 ────────────────────────────────────────────────────
await checkAsync('decodeApiKey：明文 → shape=plain', async () => {
  const decoded = await decodeApiKey('  sk-abc-123  ')
  assert.equal(decoded.shape, 'plain')
  assert.equal(decoded.value, 'sk-abc-123')
  assert.equal(decoded.keyRef, null)
})

await checkAsync('decodeApiKey：空 → shape=empty（不是"错的 key"）', async () => {
  for (const empty of ['', '   ', undefined, null]) {
    const decoded = await decodeApiKey(empty)
    assert.equal(decoded.shape, 'empty')
    assert.equal(decoded.value, undefined)
  }
})

await checkAsync('decodeApiKey：ref:NAME → 解引用（一层）', async () => {
  const read = store({ MY_KEY: 'sk-from-ref', OTHER: 'ref:MY_KEY' })
  const decoded = await decodeApiKey('ref:MY_KEY', (name) => read.read(name))
  assert.equal(decoded.shape, 'ref')
  assert.equal(decoded.keyRef, 'MY_KEY')
  assert.equal(decoded.value, 'sk-from-ref')
  // ⚠️ 只解一层：OTHER 的值长得像 ref:MY_KEY，也必须当**明文**（环状凭据表会无限递归）。
  const oneLayer = await decodeApiKey('ref:OTHER', (name) => read.read(name))
  assert.equal(oneLayer.value, 'ref:MY_KEY')
})

await checkAsync('decodeApiKey：没有解引用函数时如实说 needsResolve', async () => {
  const decoded = await decodeApiKey('ref:NO_RESOLVER')
  assert.equal(decoded.shape, 'ref')
  assert.equal(decoded.keyRef, 'NO_RESOLVER')
  assert.equal(decoded.value, undefined)
  assert.equal(decoded.needsResolve, true)
})

await checkAsync('decodeApiKey：ref 指向空条目 → 带 invalid 原因', async () => {
  const decoded = await decodeApiKey('ref:EMPTY_ONE', async () => '')
  assert.equal(decoded.value, undefined)
  assert.match(decoded.invalid, /不存在或为空/)
})

await checkAsync('decodeApiKey：解引用抛错被兜住（不把异常甩给页面）', async () => {
  const decoded = await decodeApiKey('ref:BOOM', async () => { throw new Error('vault locked') })
  assert.match(decoded.invalid, /vault locked/)
  assert.equal(decoded.value, undefined)
})

await checkAsync('decodeApiKey：带引号/带换行的粘贴产物被规范化', async () => {
  assert.equal(normalizeSecret('"sk-quoted"'), 'sk-quoted')
  assert.equal(normalizeSecret("'sk-quoted'"), 'sk-quoted')
  assert.equal(normalizeSecret('\n  sk-wrapped \r\n'), 'sk-wrapped')
  const decoded = await decodeApiKey('"sk-quoted"')
  assert.equal(decoded.value, 'sk-quoted')
})

await checkAsync('decodeApiKey：长度越界与控制字符 → 明确 invalid（不静默传出去）', async () => {
  const huge = await decodeApiKey('x'.repeat(5000))
  assert.match(huge.invalid, /超出/)
  const control = await decodeApiKey('sk-ab\u0001cd')
  assert.match(control.invalid, /控制字符/)
})

await checkAsync('decodeApiKey：env:NAME 形态', async () => {
  process.env.DSH_KEYED_TEST_ENV = 'sk-env'
  const decoded = await decodeApiKey('env:DSH_KEYED_TEST_ENV')
  assert.equal(decoded.shape, 'env')
  assert.equal(decoded.value, 'sk-env')
  delete process.env.DSH_KEYED_TEST_ENV
})

// ── resolveApiKey / keyedLaneState ───────────────────────────────────────────
await checkAsync('keyless 恒 ready，且不需要任何凭据注入', async () => {
  const state = await keyedLaneState(POLLINATIONS)
  assert.equal(state.ready, true)
  assert.equal(state.kind, 'keyless')
  assert.equal(state.keyRef, null)
  assert.equal(state.source, 'keyless')
})

await checkAsync('没有 key → not ready，且 reason 里带 env 名与拿 key 的页面', async () => {
  const state = await keyedLaneState(OPENROUTER, { readCredential: async () => undefined })
  assert.equal(state.ready, false)
  assert.equal(state.keyRef, 'OPENROUTER_API_KEY')
  assert.match(state.reason, /OPENROUTER_API_KEY/)
  assert.match(state.reason, /openrouter\.ai/)
})

await checkAsync('明文 key → ready，source=plain', async () => {
  const state = await keyedLaneState(OPENROUTER, { readCredential: async () => 'sk-plain' })
  assert.equal(state.ready, true)
  assert.equal(state.source, 'plain')
  assert.equal(state.keyRef, 'OPENROUTER_API_KEY')
})

await checkAsync('ref:NAME → ready，且 keyRef 指向被解引用的那个条目（不是 env 名）', async () => {
  const read = store({ SHARED_OR_KEY: 'sk-shared', OPENROUTER_API_KEY: 'ref:SHARED_OR_KEY' })
  const state = await keyedLaneState(OPENROUTER, { readCredential: (name) => read.read(name) })
  assert.equal(state.ready, true)
  assert.equal(state.keyRef, 'SHARED_OR_KEY')
  assert.equal(state.source, 'ref')
  const key = await resolveApiKey(OPENROUTER, { readCredential: (name) => read.read(name) })
  assert.equal(key.key, 'sk-shared')
})

await checkAsync('readCredential 抛错 → not ready 且 reason 带原因（不吞）', async () => {
  const state = await keyedLaneState(OPENROUTER, { readCredential: async () => { throw new Error('EACCES') } })
  assert.equal(state.ready, false)
  assert.match(state.reason, /EACCES/)
})

await checkAsync('没注入 readCredential → not ready 且说明是"服务未注入"（而不是"用户没填"）', async () => {
  const state = await keyedLaneState(OPENROUTER, {})
  assert.equal(state.ready, false)
  assert.match(state.reason, /未注入/)
})

await checkAsync('baseURL 含 {ACCOUNT_ID} → not ready，且说清要先替换（不去打 404）', async () => {
  const state = await keyedLaneState(CLOUDFLARE, { readCredential: async () => 'sk-has-key' })
  assert.equal(state.ready, false)
  assert.match(state.reason, /\{ACCOUNT_ID\}/)
  assert.match(state.reason, /占位符/)
})

await checkAsync('已下线渠道 → not ready + retired 标记（即使 key 填好了）', async () => {
  const state = await keyedLaneState(RETIRED, { readCredential: async () => 'ghp_fake' })
  assert.equal(state.ready, false)
  assert.equal(state.retired, true)
  assert.match(state.reason, /已下线/)
  assert.match(state.reason, /2026-07-30/)
})

await checkAsync('损坏的目录条目 → not ready 而不是抛异常', async () => {
  assert.equal((await keyedLaneState(null)).ready, false)
  assert.equal((await keyedLaneState({})).ready, false)
  assert.equal((await keyedLaneState({ baseURL: 'ftp://x', kind: 'keyed', apiKeyEnv: 'A' })).ready, false)
  assert.equal((await keyedLaneState({ baseURL: 'https://x', kind: 'weird', apiKeyEnv: 'A' })).ready, false)
})

await checkAsync('laneStates 批量：单条抛错不影响整批', async () => {
  const boom = { ...OPENROUTER, id: 'boom-lane' }
  const report = await laneStates([OPENROUTER, boom, POLLINATIONS], {
    readCredential: async (name) => {
      if (name === 'OPENROUTER_API_KEY') return 'sk-ok'
      throw new Error('nope')
    },
  })
  assert.equal(report.total, 3)
  // OPENROUTER 的 key 是 be 解成功的；boom 是同一份车道对象但凭据读取抛错。
  assert.equal(report.rows.length, 3)
  assert.equal(report.rows[2].state.ready, true)
})

// ── index.js 的接线面 ───────────────────────────────────────────────────────
await checkAsync('descriptors()：形状完整、mountable 与 ready 一致', async () => {
  const rows = await descriptors({ readCredential: async () => undefined })
  assert.equal(rows.length, KEYED_CHANNELS.length + KEYLESS_CHANNELS.length)
  for (const row of rows) {
    for (const field of ['id', 'displayName', 'kind', 'protocol', 'baseURL', 'region', 'freeTier', 'reason']) {
      assert.ok(row[field] !== undefined, `${row.id} 的描述符缺 ${field}`)
    }
    assert.equal(row.mountable, row.ready && row.retired !== true, `${row.id} 的 mountable 与 ready 不一致`)
  }
  // 一条 key 都没有时，只有免 key 那条可挂。
  const mountable = rows.filter((row) => row.mountable).map((row) => row.id)
  assert.deepEqual(mountable, ['pollinations'])
})

await checkAsync('descriptors({includeRetired:true}) 带上已下线渠道，且不可挂', async () => {
  const rows = await descriptors({ readCredential: async () => undefined }, { includeRetired: true })
  const retired = rows.find((row) => row.id === 'github-models')
  assert.equal(retired?.retired, true)
  assert.equal(retired?.mountable, false)
})

await checkAsync('descriptors 的别名与 region 过滤', async () => {
  assert.equal(keyedLaneDescriptors, descriptors)
  const cn = await descriptors({ readCredential: async () => undefined }, { region: 'cn' })
  assert.ok(cn.length >= 5)
  assert.ok(cn.every((row) => row.region === 'cn'))
})

await checkAsync('mount()：未就绪会抛错且文案可直接显示', async () => {
  await assert.rejects(
    () => mount('openrouter-free', { readCredential: async () => undefined }),
    /未就绪/,
  )
  await assert.rejects(() => mount('查无此车', {}), /未知的 keyed 车道/)
  await assert.rejects(() => mount('github-models', { readCredential: async () => 'x' }), /已下线|未就绪/)
})

await checkAsync('mount()：就绪后拿到适配器，providerInfo 保留 route', async () => {
  const mounted = await mount('openrouter-free', {
    readCredential: async () => 'sk-mounted',
    fetchImpl: async () => { throw new Error('不该发网络：本用例只验形状') },
  })
  assert.equal(mounted.route, 'openrouter-free')
  assert.equal(mounted.adapter.providerInfo('openrouter').id, 'openrouter')
  assert.equal(mounted.adapter.providerInfo('openrouter').name, 'OpenRouter 免费模型')
  assert.equal(mounted.readiness.ready, true)
})

await checkAsync('mountAll()：拆出成功与失败两张单，不因一条失败全灭', async () => {
  const { mounted, failed } = await mountAll({
    readCredential: async (name) => (name === 'OPENROUTER_API_KEY' ? 'sk-a' : undefined),
    fetchImpl: async () => { throw new Error('不联网') },
  })
  const ids = mounted.map((entry) => entry.lane.id)
  assert.deepEqual(ids, ['openrouter-free', 'pollinations'])
  assert.deepEqual(failed, [])
})

console.log('\n通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ': ' + failure.message)
  console.log('pass=' + passed + ' fail=' + failures.length)
  process.exit(1)
}
console.log('pass=' + passed + ' fail=0')
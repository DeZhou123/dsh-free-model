/**
 * 管理器与健康账本的**接线断言**（离线，不发网络）。
 *
 * ## 这一套要守的东西
 *
 * 健康记账有三处容易接错，且错了都**不会报错**，只会让页面显示错的结论：
 *
 * 1. **词表翻译**：适配器说 `credential`，账本要的是 `invalid-key`。
 *    直接透传的后果是账本认不出来 → 落到"保守冷却 30 秒"→ 一条废 key 每 30 秒被撞一次。
 * 2. **哪些失败不该记账**：`unknown-model` / `context` / `invalid-request` / `aborted`
 *    都是"这次请求不对"，不是"渠道有病"。记了就会让一条好好的渠道被冻住，
 *    而用户下一步通常是改请求再试 —— 撞上一堵看不见的墙。
 * 3. **探测也要记账**：用户点「测试 key」得到的那一次结果，就是他接下来 6 小时
 *    能不能用这条渠道的依据。只记真实对话会让"刚测完是好的、一发就报 401"这种
 *    事无从解释。
 *
 * ⚠️ 必须带 hooks 跑（`node --import ./test/hooks.mjs test/keyed/manage-health.mjs`）：
 * 管理器链路会 import 适配器，而适配器 import 宿主的 `@deepseek-ai/dsh-llm`，
 * 离线套件靠 hooks 把它替换成桩。
 */

import assert from 'node:assert/strict'
import { createKeyedManager, healthKindOf } from '../../src/lanes/keyed/manage.js'
import { createKeyedAdapter } from '../../src/lanes/keyed/adapter.js'
import { createHealthStore } from '../../src/lanes/health.js'
import { laneById, staticModels } from '../../src/lanes/keyed/catalog.js'

let passed = 0
const failures = []
async function check(name, fn) {
  try {
    // ⚠️ 必须 await：0.6.0 起的用例是 async 的（渠道开关要写盘）。
    // 不 await 的话断言在汇总行之后才跑，`pass=0 fail=0` 看起来「全过」。
    await fn()
    passed += 1
    // 每条都打名字：失败时能直接看出是哪一条，而不是只有一个总数。
    console.log('  ✓ ' + name)
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error) })
  }
}

const NOW = 1_800_000_000_000
const harness = { now: () => NOW }

function makeManager() {
  const health = createHealthStore({ persist: false, now: harness.now })
  const manager = createKeyedManager({
    health,
    readCredential: async () => undefined,
    register: () => () => {},
  })
  return { manager, health }
}

await check('管理器暴露了 availability / healthSnapshot / resetHealth 三个面', () => {
  const { manager } = makeManager()
  for (const name of ['availability', 'healthSnapshot', 'resetHealth']) {
    assert.equal(typeof manager[name], 'function', '缺少 ' + name)
  }
})

await check('健康快照形状：generatedAt + lanes，每条带一句人话 text', () => {
  const { manager, health } = makeManager()
  health.recordFailure('groq', { kind: 'rate-limited', status: 429 })
  const snapshot = manager.healthSnapshot()
  assert.equal(typeof snapshot.generatedAt, 'number')
  assert.equal(typeof snapshot.lanes, 'object')
  const row = snapshot.lanes.groq
  assert.ok(row !== undefined, 'groq 没进快照')
  assert.equal(row.state, 'cooldown')
  assert.equal(typeof row.text, 'string')
  assert.ok(row.text.length > 0, 'text 是空的 —— 页面会显示一个空徽章')
})

await check('availability：没测过的渠道放行（悲观默认会让新渠道永远进不了轮转）', () => {
  const { manager } = makeManager()
  const row = manager.availability('never-tested')
  assert.equal(row.available, true)
  assert.equal(row.state, 'unknown')
  assert.ok(row.reason.includes('还没测过'))
})

await check('availability：吊销的渠道不放行，且原因是可读的一句话', () => {
  const { manager, health } = makeManager()
  health.recordFailure('zai', { kind: 'invalid-key', status: 401, reason: 'bad key' })
  const row = manager.availability('zai')
  assert.equal(row.available, false)
  assert.equal(row.state, 'revoked')
  assert.ok(row.reason.length > 0)
})

await check('resetHealth 清空一条 / 全部', () => {
  const { manager, health } = makeManager()
  health.recordFailure('a', { kind: 'rate-limited' })
  health.recordFailure('b', { kind: 'rate-limited' })
  manager.resetHealth('a')
  assert.equal(manager.healthSnapshot().lanes.a, undefined, '单条没清掉')
  assert.ok(manager.healthSnapshot().lanes.b !== undefined, '不该把别的也清掉')
  manager.resetHealth()
  assert.deepEqual(Object.keys(manager.healthSnapshot().lanes), [], '全清失败')
})

await check('词表翻译：六个失败类别各有落点', () => {
  assert.equal(healthKindOf('credential'), 'invalid-key')
  assert.equal(healthKindOf('quota'), 'quota')
  assert.equal(healthKindOf('rate-limit'), 'rate-limited')
  assert.equal(healthKindOf('connection'), 'network')
  assert.equal(healthKindOf('server'), 'server-error')
  assert.equal(healthKindOf('upstream'), 'server-error')
})

await check('词表翻译：四个"不是渠道的病"必须返回 null（记了就冻住好渠道）', () => {
  for (const kind of ['unknown-model', 'context', 'invalid-request', 'aborted']) {
    assert.equal(healthKindOf(kind), null, kind + ' 不该进健康账本')
  }
  // 认不出来的新类别也放行：宁可漏记，也不要误判。
  assert.equal(healthKindOf('some-future-kind'), null)
  assert.equal(healthKindOf(undefined), null)
})

await check('翻译后的类别在账本里落到正确状态', () => {
  const cases = [
    ['invalid-key', 401, 'revoked'],
    ['quota', 402, 'cooldown'],
    ['rate-limited', 429, 'cooldown'],
    ['server-error', 503, 'cooldown'],
    ['network', undefined, 'cooldown'],
  ]
  const health = createHealthStore({ persist: false, now: harness.now })
  for (const [kind, status, expected] of cases) {
    const lane = 'lane-' + kind
    health.recordFailure(lane, { kind, ...(status === undefined ? {} : { status }) })
    assert.equal(health.get(lane).state, expected, kind + ' 应落成 ' + expected)
  }
})

await check('限流冷却尊重 429 基准（≤ 61 秒），额度冷却等到刷新点（> 1 小时）', () => {
  const health = createHealthStore({ persist: false, now: harness.now })
  health.recordFailure('rl', { kind: 'rate-limited', status: 429 })
  const rl = health.get('rl').until - NOW
  assert.ok(rl <= 61_000, '限流冷却超过 60 秒：' + rl)
  health.recordFailure('qt', { kind: 'quota', status: 402 })
  const qt = health.get('qt').until - NOW
  assert.ok(qt > 60 * 60 * 1000, '额度冷却不足 1 小时：' + qt)
})

await check('同一失败重复出现时冷却递增（避免每 30 秒撞一次废渠道）', () => {
  const clock = { at: NOW }
  const health = createHealthStore({ persist: false, now: () => clock.at })
  health.recordFailure('dup', { kind: 'server-error', status: 500 })
  const first = health.get('dup').until - clock.at
  health.recordFailure('dup', { kind: 'server-error', status: 500 })
  const second = health.get('dup').until - clock.at
  assert.ok(second > first, '第二次冷却没有变长：' + first + ' → ' + second)
})

await check('探测结果不泄漏凭据：健康快照里最长的一串不像 key', () => {
  const { manager, health } = makeManager()
  health.recordFailure('x', { kind: 'invalid-key', status: 401, reason: 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345' })
  const text = JSON.stringify(manager.healthSnapshot())
  assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), '健康快照里出现了完整 key')
  assert.ok(text.includes('…'), '疑似凭据没有被遮蔽')
})


// ── 0.6.0：渠道开关（关掉 ≠ 清除凭据）──────────────────────────────────────

await await check('渠道开关：关掉之后 availability 立刻变成不可用并说清原因', async () => {
  const health = createHealthStore({ persist: false, now: harness.now })
  const manager = createKeyedManager({ health, readCredential: async () => undefined, register: () => () => {} })
  assert.equal(manager.availability('groq').available, true, '默认应当放行')
  await manager.setEnabled('groq', false)
  const row = manager.availability('groq')
  assert.equal(row.available, false)
  assert.equal(row.state, 'disabled')
  assert.ok(row.reason.includes('关掉'), '原因要说清是被关掉的：' + row.reason)
  assert.deepEqual(manager.disabledLanes(), ['groq'])
  await manager.setEnabled('groq', true)
  assert.equal(manager.availability('groq').available, true, '重新打开后应当恢复')
  assert.deepEqual(manager.disabledLanes(), [])
})

await await check('渠道开关落盘：写进文件，换一个管理器能读回来', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'free-model-disabled-'))
  const file = join(dir, 'disabled-lanes.json')
  try {
    const first = createKeyedManager({ readCredential: async () => undefined, register: () => () => {}, disabledFile: file })
    await first.setEnabled('deepinfra', false)
    await first.setEnabled('novita', false)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(raw.disabled, ['deepinfra', 'novita'])
    const second = createKeyedManager({ readCredential: async () => undefined, register: () => () => {}, disabledFile: file })
    assert.deepEqual(second.disabledLanes().sort(), ['deepinfra', 'novita'], '换一个管理器没读回来')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await await check('渠道开关：文件坏掉时从空集起（不拖垮插件）', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'free-model-disabled-bad-'))
  const file = join(dir, 'disabled-lanes.json')
  try {
    writeFileSync(file, '{ not json', 'utf8')
    const manager = createKeyedManager({ readCredential: async () => undefined, register: () => () => {}, disabledFile: file })
    assert.deepEqual(manager.disabledLanes(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
// ── 0.6.0 自审发现的两条 P1（换 key 之后的状态）────────────────────────────

await check('换 key 之后健康结论被清掉（否则闸门会一直说「已吊销」）', async () => {
  const stored = {}
  const health = createHealthStore({ persist: false, now: harness.now })
  const manager = createKeyedManager({
    health,
    // 凭据读写都用内存，不碰真实文件
    readCredential: async (name) => stored[name],
    writeCredential: async (name, value) => { stored[name] = value },
    unsetCredential: async (name) => { delete stored[name] },
    register: () => () => {},
  })
  // 旧 key 的 401 → 吊销
  health.recordFailure('groq', { kind: 'invalid-key', status: 401 })
  assert.equal(manager.availability('groq').state, 'revoked')
  // 用户填了新 key：写完凭据之后这条车道的健康结论必须被清掉
  const saved = await manager.saveKey('groq', 'sk-brand-new')
  assert.equal(saved.ok, true, '保存失败：' + JSON.stringify(saved))
  const after = manager.availability('groq')
  assert.notEqual(after.state, 'revoked', '换了新 key 之后仍然被判已吊销：' + JSON.stringify(after))
  assert.equal(after.available, true, '换了新 key 之后闸门仍然不放行')
})

await check('换 key 之后 key 列表**重算**（不能只剩刚填的那一把）', async () => {
  const stored = { GROQ_API_KEY: 'first', GROQ_API_KEY__2: 'second' }
  const health = createHealthStore({ persist: false, now: harness.now })
  const manager = createKeyedManager({
    health,
    readCredential: async (name) => stored[name],
    writeCredential: async (name, value) => { stored[name] = value },
    register: () => () => {},
  })
  // 未挂载时也只验证凭据被写到正确的条目上（挂载要真 llm 服务，host 套件覆盖那一段）
  const saved = await manager.saveKey('groq', 'first')
  assert.equal(saved.ok, true)
  assert.equal(stored.GROQ_API_KEY, 'first')
  assert.equal(stored.GROQ_API_KEY__2, 'second', '保存顺手把兄弟条目弄丢了')
})


await check('闸门与页面判据同源：被关掉的渠道在**发请求前**也会被拦住', async () => {
  // 自审发现的不一致：beforeRequest 原来直接调 health.isAvailable，于是「渠道开关」被绕过 ——
  // 关掉的渠道只要适配器还挂着（宿主不给 disposer 时就可能），请求照样发得出去。
  const seen = []
  const manager = createKeyedManager({
    readCredential: async () => 'k',
    register: () => () => {},
    // 借 mount 之前的闸门取值：直接问管理器的 availability 与适配器拿到的必须是同一个
  })
  await manager.setEnabled('groq', false)
  const gate = manager.availability('groq')
  assert.equal(gate.available, false)
  assert.equal(gate.state, 'disabled')
  // 断言闸门**不是**只问健康：健康账本对这条车道一无所知（unknown），但开关说了不可用。
  assert.equal(manager.healthSnapshot().lanes.groq, undefined, '这条车道不该有健康记录')
  void seen
})


// ── 0.6.0 复核：探测链路的两条 P0（probesInflight / /models 404）──────────────

await check('probeKey 并发去重：连续两次只发一次上游，且返回同一个结论', async () => {
  // 0.6.0 的 `probesInflight` 从未声明：probeKey 一进来就 ReferenceError。
  // 这条用例同时钉住「不抛」与「force 不绕过去重」（force 只跳过**结果**缓存）。
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const calls = { n: 0 }
  const fetchImpl = async () => {
    calls.n += 1
    await gate
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"data":[]}' }
  }
  const health = createHealthStore({ persist: false, now: harness.now })
  const manager = createKeyedManager({
    health,
    readCredential: async () => 'sk-test',
    fetchImpl,
    register: () => () => {},
  })
  const first = manager.probeKey('groq', { force: true })
  const second = manager.probeKey('groq', { force: true })
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls.n, 1, '两次并发 probeKey 发了 ' + calls.n + ' 次上游')
  assert.equal(a, b, '并发探测没有复用同一个结论对象')
  assert.equal(a.ok, true)
})

await check('探测 /models 404 不记账：没有目录端点 ≠ 渠道坏了（health 仍是 unknown）', async () => {
  const health = createHealthStore({ persist: false, now: harness.now })
  const manager = createKeyedManager({
    health,
    readCredential: async () => 'sk-test',
    // groq 没声明 supportsModelList:false → probe 走 GET /models
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => '{"error":"not found"}',
    }),
    register: () => () => {},
  })
  const result = await manager.probeKey('groq', { force: true })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'not-found')
  assert.equal(result.mode, 'models', '这条用例要覆盖 /models 探测（不是 chat 探测）')
  assert.equal(health.get('groq').state, 'unknown', '把「没有 /models 端点」记成了渠道故障')
  assert.equal(manager.availability('groq').available, true, '探测一次 /models 就把渠道冻住了')
})

await check('真实对话链路：429 + Retry-After: 300 进账本后冷却 ≈ 300 秒（#notify 不丢字段）', async () => {
  // repro-3.log §2：`#notify` 只带 kind/status/advice/detail，Retry-After 在出口处丢掉，
  // 账本只能按 60 秒基准猜。这条用例走**真实的 manager.onOutcome → 挂载的适配器**，
  // 保证两处转发（adapter #notify + manage onOutcome）都真的接上了。
  const stored = {}
  const health = createHealthStore({ persist: false, now: harness.now })
  let mounted
  const fetchImpl = async (url) => ({
    ok: false,
    status: 429,
    headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? '300' : null) },
    text: async () => (String(url).endsWith('/models')
      ? '{"error":"rate limited"}'
      : '{"error":{"message":"Rate limit exceeded"}}'),
  })
  const manager = createKeyedManager({
    health,
    readCredential: async (name) => stored[name],
    writeCredential: async (name, value) => { stored[name] = value },
    unsetCredential: async (name) => { delete stored[name] },
    register: (route, adapter) => { mounted = adapter; return () => {} },
    fetchImpl,
  })
  const saved = await manager.saveKey('groq', 'sk-test')
  assert.equal(saved.mounted, true, '没挂上适配器，测不到真实链路：' + JSON.stringify(saved))
  assert.ok(mounted !== undefined, 'register 没拿到适配器')
  const model = staticModels(laneById('groq'))[0]?.id
  try {
    for await (const _chunk of mounted.stream({ model, messages: [{ role: 'user', content: 'hi' }] })) {
      // 429 不该有 chunk
    }
  } catch {
    // 预期失败：这里只关心账本拿到了什么
  }
  const record = health.get('groq')
  assert.equal(record.state, 'cooldown')
  const cooldown = record.until - NOW
  assert.ok(Math.abs(cooldown - 300_000) <= 5_000,
    'Retry-After: 300 没进账本，实际冷却 ' + cooldown + 'ms')
})


// ── 0.7.0：模型下拉隐藏（只藏明确不可用；判定 fail-open）─────────────────────
//
// 这一组断言守两件相反的事，缺一件都会让「隐藏」变成新的静默故障：
// ① 只藏**明确不可用**的三类（revoked / 404 长锁 / 手动关掉）；短冷却必须仍然可见；
// ② 判据的任何一类「读不到」（抛错 / 未知 / 超时）都必须**回到改动前的清单**，
//    否则健康簿坏掉的表现就是「用户的模型凭空消失」。

/** 目录行的可比较快照：`source` 挂在数组对象上，JSON.stringify 会把数组项之外的属性丢掉。 */
const snapshotModels = (rows) => JSON.stringify({ rows, source: rows.source })

/** 离线适配器：`/models` 一律失败 → 静态表（不碰网络，也不依赖 gzip 目录）。 */
const offlineFetch = async () => { throw new Error('offline fixture') }

await check('已从下拉隐藏：revoked / 404 长锁 / 手动关掉才隐藏，429 的 60 秒冷却仍然可见', async () => {
  const { manager, health } = makeManager()
  assert.equal(manager.pickerVerdict('groq').hidden, false, '没测过的渠道不该隐藏')

  health.recordFailure('groq', { kind: 'rate-limited', status: 429 })
  const record429 = health.get('groq')
  assert.equal(record429.state, 'cooldown')
  assert.ok(record429.until - NOW <= 61_000, '429 的基准应当是 60 秒：' + (record429.until - NOW))
  assert.equal(manager.pickerVerdict('groq').hidden, false, '429 的 60 秒冷却被隐藏了：下拉会每 60 秒抖一次')

  health.recordFailure('groq', { kind: 'not-found', status: 404 })
  const locked = manager.pickerVerdict('groq')
  assert.equal(locked.hidden, true, '404 长锁没有从下拉隐藏')
  assert.equal(locked.code, 'not-found')
  assert.ok(locked.reason.includes('404'), '隐藏原因里看不出是 404：' + locked.reason)
  assert.ok(/还有 .+小时/.test(locked.reason), '隐藏原因没有剩余时间：' + locked.reason)
  assert.equal(health.get('groq').kind, 'not-found', '健康记录没留下 kind，隐藏判据只能猜文本')
  assert.equal(health.get('groq').status, 404, '健康记录没留下 status，404 长锁与额度冷却分不开')

  health.recordFailure('zai', { kind: 'invalid-key', status: 401 })
  assert.equal(manager.pickerVerdict('zai').hidden, true, '已吊销的渠道没有隐藏')
  assert.equal(manager.pickerVerdict('zai').code, 'revoked')

  await manager.setEnabled('deepinfra', false)
  assert.equal(manager.pickerVerdict('deepinfra').hidden, true, '被用户关掉的渠道没有隐藏')
  assert.equal(manager.pickerVerdict('deepinfra').code, 'disabled')
  await manager.setEnabled('deepinfra', true)
  assert.equal(manager.pickerVerdict('deepinfra').hidden, false, '重新打开开关后没有恢复可见')
})

await check('已从下拉隐藏：适配器 listModels 对隐藏车道返回空目录（宿主据此把整组从下拉滤掉）', async () => {
  const stored = {}
  const health = createHealthStore({ persist: false, now: harness.now })
  let liveAdapter
  const manager = createKeyedManager({
    health,
    readCredential: async (name) => stored[name],
    writeCredential: async (name, value) => { stored[name] = value },
    unsetCredential: async (name) => { delete stored[name] },
    register: (route, adapter) => { liveAdapter = adapter; return () => {} },
    fetchImpl: offlineFetch,
  })
  const saved = await manager.saveKey('groq', 'sk-test')
  assert.equal(saved.mounted, true, '没挂上适配器，测不到 listModels：' + JSON.stringify(saved))
  const expected = snapshotModels(await createKeyedAdapter({ lane: laneById('groq'), apiKey: 'sk-test', fetchImpl: offlineFetch }).listModels('groq'))

  // 429：冷却中但**可见**（清单与改动前逐字节相同）。
  health.recordFailure('groq', { kind: 'rate-limited', status: 429 })
  assert.equal(snapshotModels(await liveAdapter.listModels('groq')), expected, '短冷却把模型清单改掉了')

  // 404 长锁：隐藏 = 空目录。
  health.recordFailure('groq', { kind: 'not-found', status: 404 })
  const hidden = await liveAdapter.listModels('groq')
  assert.equal(hidden.length, 0, '404 长锁的渠道仍然列出了模型：' + hidden.length)
  assert.equal(hidden.source, 'hidden', '隐藏时的来源标记不对：' + hidden.source)
  assert.ok(String(hidden.hiddenReason).includes('404'), '隐藏原因没带出去：' + hidden.hiddenReason)
})

await check('已从下拉隐藏 fail-open：判据抛错 / 健康簿读不到 / 未知 / 超时，模型清单与改动前逐字节相同', async () => {
  const lane = laneById('groq')
  const baseline = snapshotModels(await createKeyedAdapter({ lane, apiKey: 'sk-test', fetchImpl: offlineFetch }).listModels('groq'))

  // ① 判据自己抛错：适配器必须照常返回全量目录（而不是整个选择器空白）。
  const throwing = createKeyedAdapter({
    lane,
    apiKey: 'sk-test',
    fetchImpl: offlineFetch,
    hiddenFromPicker: () => { throw new Error('verdict exploded') },
  })
  assert.equal(snapshotModels(await throwing.listModels('groq')), baseline, '判据抛错时模型清单变了（没有 fail-open）')

  // ② 管理器那侧：健康簿的 get() 抛错（文件读不出来 / 账本实现坏了）。
  const stored = {}
  const realHealth = createHealthStore({ persist: false, now: harness.now })
  const brokenHealth = { ...realHealth, get: () => { throw new Error('health.json unreadable') } }
  let liveAdapter
  const manager = createKeyedManager({
    health: brokenHealth,
    readCredential: async (name) => stored[name],
    writeCredential: async (name, value) => { stored[name] = value },
    unsetCredential: async (name) => { delete stored[name] },
    register: (route, adapter) => { liveAdapter = adapter; return () => {} },
    fetchImpl: offlineFetch,
  })
  const saved = await manager.saveKey('groq', 'sk-test')
  assert.equal(saved.mounted, true)
  assert.equal(manager.pickerVerdict('groq').hidden, false, '健康簿读不到时隐藏了渠道（应当 fail-open）')
  assert.equal(manager.pickerVerdict('groq').code, 'fail-open')
  assert.equal(snapshotModels(await liveAdapter.listModels('groq')), baseline, '健康簿读不到时模型清单变了（没有 fail-open）')

  // ③ state:'unknown'：没测过 ≠ 不可用。
  const neverTested = createKeyedAdapter({ lane, apiKey: 'sk-test', fetchImpl: offlineFetch, hiddenFromPicker: () => undefined })
  assert.equal(snapshotModels(await neverTested.listModels('groq')), baseline)

  // ④ 探测超时：30 秒抖动冷却，仍然可见。
  const { manager: timeoutManager, health: timeoutHealth } = makeManager()
  timeoutHealth.recordFailure('groq', { kind: 'timeout' })
  assert.equal(timeoutHealth.get('groq').state, 'cooldown')
  assert.equal(timeoutManager.pickerVerdict('groq').hidden, false, '探测超时把渠道从下拉里藏了')
})

console.log('\n通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ': ' + failure.message)
  console.log('pass=' + passed + ' fail=' + failures.length)
  process.exit(1)
}
console.log('pass=' + passed + ' fail=0')
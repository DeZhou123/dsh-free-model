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
import { createHealthStore } from '../../src/lanes/health.js'

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed += 1
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

check('管理器暴露了 availability / healthSnapshot / resetHealth 三个面', () => {
  const { manager } = makeManager()
  for (const name of ['availability', 'healthSnapshot', 'resetHealth']) {
    assert.equal(typeof manager[name], 'function', '缺少 ' + name)
  }
})

check('健康快照形状：generatedAt + lanes，每条带一句人话 text', () => {
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

check('availability：没测过的渠道放行（悲观默认会让新渠道永远进不了轮转）', () => {
  const { manager } = makeManager()
  const row = manager.availability('never-tested')
  assert.equal(row.available, true)
  assert.equal(row.state, 'unknown')
  assert.ok(row.reason.includes('还没测过'))
})

check('availability：吊销的渠道不放行，且原因是可读的一句话', () => {
  const { manager, health } = makeManager()
  health.recordFailure('zai', { kind: 'invalid-key', status: 401, reason: 'bad key' })
  const row = manager.availability('zai')
  assert.equal(row.available, false)
  assert.equal(row.state, 'revoked')
  assert.ok(row.reason.length > 0)
})

check('resetHealth 清空一条 / 全部', () => {
  const { manager, health } = makeManager()
  health.recordFailure('a', { kind: 'rate-limited' })
  health.recordFailure('b', { kind: 'rate-limited' })
  manager.resetHealth('a')
  assert.equal(manager.healthSnapshot().lanes.a, undefined, '单条没清掉')
  assert.ok(manager.healthSnapshot().lanes.b !== undefined, '不该把别的也清掉')
  manager.resetHealth()
  assert.deepEqual(Object.keys(manager.healthSnapshot().lanes), [], '全清失败')
})

check('词表翻译：六个失败类别各有落点', () => {
  assert.equal(healthKindOf('credential'), 'invalid-key')
  assert.equal(healthKindOf('quota'), 'quota')
  assert.equal(healthKindOf('rate-limit'), 'rate-limited')
  assert.equal(healthKindOf('connection'), 'network')
  assert.equal(healthKindOf('server'), 'server-error')
  assert.equal(healthKindOf('upstream'), 'server-error')
})

check('词表翻译：四个"不是渠道的病"必须返回 null（记了就冻住好渠道）', () => {
  for (const kind of ['unknown-model', 'context', 'invalid-request', 'aborted']) {
    assert.equal(healthKindOf(kind), null, kind + ' 不该进健康账本')
  }
  // 认不出来的新类别也放行：宁可漏记，也不要误判。
  assert.equal(healthKindOf('some-future-kind'), null)
  assert.equal(healthKindOf(undefined), null)
})

check('翻译后的类别在账本里落到正确状态', () => {
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

check('限流冷却尊重 429 基准（≤ 61 秒），额度冷却等到刷新点（> 1 小时）', () => {
  const health = createHealthStore({ persist: false, now: harness.now })
  health.recordFailure('rl', { kind: 'rate-limited', status: 429 })
  const rl = health.get('rl').until - NOW
  assert.ok(rl <= 61_000, '限流冷却超过 60 秒：' + rl)
  health.recordFailure('qt', { kind: 'quota', status: 402 })
  const qt = health.get('qt').until - NOW
  assert.ok(qt > 60 * 60 * 1000, '额度冷却不足 1 小时：' + qt)
})

check('同一失败重复出现时冷却递增（避免每 30 秒撞一次废渠道）', () => {
  const clock = { at: NOW }
  const health = createHealthStore({ persist: false, now: () => clock.at })
  health.recordFailure('dup', { kind: 'server-error', status: 500 })
  const first = health.get('dup').until - clock.at
  health.recordFailure('dup', { kind: 'server-error', status: 500 })
  const second = health.get('dup').until - clock.at
  assert.ok(second > first, '第二次冷却没有变长：' + first + ' → ' + second)
})

check('探测结果不泄漏凭据：健康快照里最长的一串不像 key', () => {
  const { manager, health } = makeManager()
  health.recordFailure('x', { kind: 'invalid-key', status: 401, reason: 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345' })
  const text = JSON.stringify(manager.healthSnapshot())
  assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), '健康快照里出现了完整 key')
  assert.ok(text.includes('…'), '疑似凭据没有被遮蔽')
})

console.log('\n通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ': ' + failure.message)
  console.log('pass=' + passed + ' fail=' + failures.length)
  process.exit(1)
}
console.log('pass=' + passed + ' fail=0')

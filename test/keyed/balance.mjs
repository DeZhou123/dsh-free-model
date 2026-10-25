/**
 * 余额探针断言（离线，喂假响应）。
 *
 * 守的是三件事，每一件错了都会让用户**按错的金额做决定**：
 *
 * 1. 形状认得对：各家给余额的字段名不同（直接给 / 充−用），认错就是报错数；
 * 2. 认不出来时**不猜**：宁可说「读不懂」，也不要显示一个编出来的数字；
 * 3. 金额**不经过浮点**：`0.3 - 0.1` 在浮点里是 `0.19999999999999998`，
 *    而它会被原样显示给用户（市场调研里明确点出的一条坑）。
 *
 * 用法：node test/keyed/balance.mjs
 */

import assert from 'node:assert/strict'
import { parseBalance, probeLaneBalance, subtractDecimal } from '../../src/lanes/keyed/balance.js'
import { laneById } from '../../src/lanes/keyed/catalog.js'

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

const GROQ = laneById('groq')

/** 造一个假的 fetch，回给定状态与正文。 */
function stub(status, body, headers = {}) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

const LANE = { ...GROQ, balance: { url: 'https://example.test/balance', rowKind: 'balance' } }

// ── 形状解析 ────────────────────────────────────────────────────────────────
await checkAsync('直接余额字段：availableBalance / balance / totalBalance 都认', () => {
  assert.equal(parseBalance({ availableBalance: 12.5 }).amount, '12.5')
  assert.equal(parseBalance({ data: { available_balance: '8.00' } }).amount, '8.00')
  assert.equal(parseBalance({ data: { totalBalance: 3 } }).amount, '3')
  assert.equal(parseBalance({ data: { balance: '0' } }).found, true, '0 也是有效余额（不是"没有"）')
})

await checkAsync('OpenRouter 那一派：total_credits − total_usage，且带币种', () => {
  const parsed = parseBalance({ data: { total_credits: 10, total_usage: 2.5 } })
  assert.equal(parsed.found, true)
  assert.equal(parsed.amount, '7.5')
  assert.equal(parsed.currency, 'USD')
  assert.ok(parsed.detail.includes('充值'))
})

await checkAsync('认不出来时不猜：found=false 并列出看到的字段名', () => {
  const parsed = parseBalance({ data: { foo: 1, bar: 'x' } })
  assert.equal(parsed.found, false)
  assert.ok(parsed.detail.includes('foo'), '没列出看到的字段名（下一个人无从补规则）')
})

await checkAsync('非对象 / null 不抛', () => {
  assert.equal(parseBalance(null).found, false)
  assert.equal(parseBalance('x').found, false)
  assert.equal(parseBalance([]).found, false)
})

// ── 十进制减法 ──────────────────────────────────────────────────────────────
await checkAsync('subtractDecimal：不经过浮点（0.3 − 0.1 === 0.2，不是 0.19999…）', () => {
  assert.equal(subtractDecimal('0.3', '0.1'), '0.2')
  assert.equal(subtractDecimal('10', '2.5'), '7.5')
  assert.equal(subtractDecimal('1', '3'), '-2')
  assert.equal(subtractDecimal('0.001', '0.0004'), '0.0006')
  assert.equal(subtractDecimal('5', '5'), '0')
  // 非数字（上游给了个句子）就原样返回，不要造 NaN
  assert.equal(subtractDecimal('很多', '1'), '很多')
})

// ── 探针 ────────────────────────────────────────────────────────────────────
await checkAsync('没有声明 balance.url → missing-config（不是"失败"）', async () => {
  const result = await probeLaneBalance(laneById('deepinfra'), { apiKey: 'k' })
  assert.equal(result.kind, 'missing-config')
  assert.ok(result.reason.includes('balance.url'))
})

await checkAsync('没有 key → no-key，且**不发请求**', async () => {
  let called = 0
  const result = await probeLaneBalance(LANE, { apiKey: '', fetchImpl: async () => { called += 1 } })
  assert.equal(result.kind, 'no-key')
  assert.equal(called, 0)
})

await checkAsync('401 → invalid-key（换 key 才是下一步）', async () => {
  const result = await probeLaneBalance(LANE, { apiKey: 'k', fetchImpl: stub(401, '{"error":"bad key"}') })
  assert.equal(result.kind, 'invalid-key')
  assert.equal(result.status, 401)
})

await checkAsync('404 → not-found（提示目录里的 url 可能过期）', async () => {
  const result = await probeLaneBalance(LANE, { apiKey: 'k', fetchImpl: stub(404, '{}') })
  assert.equal(result.kind, 'not-found')
  assert.ok(result.reason.includes('过期'))
})

await checkAsync('429 → rate-limited（key 是对的，等一会）', async () => {
  const result = await probeLaneBalance(LANE, { apiKey: 'k', fetchImpl: stub(429, '{}') })
  assert.equal(result.kind, 'rate-limited')
})

await checkAsync('5xx → server-error（与 key 无关）', async () => {
  const result = await probeLaneBalance(LANE, { apiKey: 'k', fetchImpl: stub(503, 'no') })
  assert.equal(result.kind, 'server-error')
})

await checkAsync('超时 → timeout，且文案说明「key 未必有问题」', async () => {
  const result = await probeLaneBalance(LANE, {
    apiKey: 'k',
    timeoutMs: 5,
    fetchImpl: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error },
  })
  assert.equal(result.kind, 'timeout')
  assert.ok(result.reason.includes('未必'))
})

await checkAsync('连通但形状不认识 → unparsed（不是 ok）', async () => {
  const result = await probeLaneBalance(LANE, { apiKey: 'k', fetchImpl: stub(200, { whatever: true }) })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'unparsed')
})

await checkAsync('成功路径：金额与原因是可读的，且不含 key', async () => {
  const result = await probeLaneBalance(LANE, { apiKey: 'sk-secret-abcdefghijklmnop', fetchImpl: stub(200, { data: { available_balance: '9.75' } }) })
  assert.equal(result.ok, true)
  assert.equal(result.amount, '9.75')
  assert.ok(result.reason.includes('9.75'))
  assert.ok(!JSON.stringify(result).includes('sk-secret'), '返回值里出现了 key')
})

await checkAsync('非 JSON 正文 → bad-request（拦住的是网关页，不是编个余额）', async () => {
  const result = await probeLaneBalance(LANE, { apiKey: 'k', fetchImpl: stub(200, '<html>login</html>') })
  assert.equal(result.kind, 'bad-request')
})

console.log('\n通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ': ' + failure.message)
  console.log('pass=' + passed + ' fail=' + failures.length)
  process.exit(1)
}
console.log('pass=' + passed + ' fail=0')

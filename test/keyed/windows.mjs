/**
 * 套餐窗口探针断言（离线，喂假响应）。
 *
 * 这块的形态**没有实证**（本机没有订阅 key），所以测试的重点不是「解析得多准」，
 * 而是**三条纪律**：
 *
 * 1. 认得出就给数字（两种最常见的形状各钉一遍）；
 * 2. 认不出**绝不猜**，返回 unparsed 并把看到的字段名列出来（这是取证线索）；
 * 3. 失败分档与余额/探测同一套词表（no-key / invalid-key / 404 / 429 / 5xx / 超时）。
 *
 * 用法：node test/keyed/windows.mjs
 */

import assert from 'node:assert/strict'
import { parseWindows, describeWindow, probeLaneWindows } from '../../src/lanes/keyed/windows.js'
import { laneById } from '../../src/lanes/keyed/catalog.js'

let passed = 0
const failures = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error) })
  }
}

/** 造一个假 fetch。 */
function stub(status, body) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

const LANE = { ...laneById('kimi-coding'), windows: { url: 'https://example.test/usages' } }

// ── 形状识别 ───────────────────────────────────────────────────────────────
await check('形状 A：data.limits[] + type 里带 5H/7D', () => {
  const parsed = parseWindows({
    data: {
      limits: [
        { type: 'TIME_LIMIT_5H', used: 3, limit: 10, reset_at: '2026-10-26T12:00:00Z' },
        { type: 'TIME_LIMIT_7D', used: 90, limit: 200 },
      ],
    },
  })
  assert.equal(parsed.found, true)
  assert.equal(parsed.windows.length, 2)
  assert.equal(parsed.windows[0].label, '5 小时窗')
  assert.equal(parsed.windows[0].used, 3)
  assert.equal(parsed.windows[0].limit, 10)
  assert.equal(parsed.windows[1].label, '7 天窗')
  assert.equal(parsed.windows[0].resetAt, '2026-10-26T12:00:00.000Z')
})

await check('形状 B：顶层键名就是窗口名（five_hour / seven_day）', () => {
  const parsed = parseWindows({ five_hour: { used: 1, limit: 5 }, seven_day: { used: 2, limit: 10 } })
  assert.equal(parsed.found, true)
  assert.deepEqual(parsed.windows.map((w) => w.label), ['5 小时窗', '7 天窗'])
})

await check('形状 C：只剩 remaining / percentage 也能读出来（不同家字段不同）', () => {
  const parsed = parseWindows({ limits: [{ name: '5h', remaining: 7 }, { name: 'weekly', percentage: 42 }] })
  assert.equal(parsed.found, true)
  assert.equal(parsed.windows[0].remaining, 7)
  assert.equal(parsed.windows[1].percent, 42)
})

await check('认不出时不猜：found=false 且列出看到的字段名', () => {
  const parsed = parseWindows({ hello: 'world', nested: { a: 1 } })
  assert.equal(parsed.found, false)
  assert.ok(parsed.detail.includes('hello'), '没列出字段名：' + parsed.detail)
})

await check('非对象输入不抛（null / 字符串 / 数组）', () => {
  assert.equal(parseWindows(null).found, false)
  assert.equal(parseWindows('x').found, false)
  assert.equal(parseWindows([]).found, false)
})

await check('describeWindow：人话，缺字段也能显示', () => {
  assert.equal(describeWindow({ used: 3, limit: 10 }), '已用 3/10')
  assert.equal(describeWindow({ limit: 10 }), '上限 10')
  assert.equal(describeWindow({ used: 4 }), '已用 4')
  assert.ok(describeWindow({ used: 1, limit: 2, percent: 50, resetAt: '2026-10-26T12:00:00Z' }).includes('重置于'))
  assert.equal(describeWindow({}), '（没有可读的数字）')
})

// ── 探针 ───────────────────────────────────────────────────────────────────
await check('没有声明 windows.url → missing-config（不是失败）', async () => {
  const result = await probeLaneWindows(laneById('groq'), { apiKey: 'k' })
  assert.equal(result.kind, 'missing-config')
  assert.ok(result.reason.includes('windows.url'))
})

await check('没有 key → no-key 且不发请求', async () => {
  let called = 0
  const result = await probeLaneWindows(LANE, { apiKey: '', fetchImpl: async () => { called += 1 } })
  assert.equal(result.kind, 'no-key')
  assert.equal(called, 0)
})

await check('401 → invalid-key，且提示「套餐端点要套餐专用 key」', async () => {
  const result = await probeLaneWindows(LANE, { apiKey: 'k', fetchImpl: stub(401, { error: 'no' }) })
  assert.equal(result.kind, 'invalid-key')
  assert.ok(result.reason.includes('套餐专用'), '缺少可执行提示：' + result.reason)
})

await check('404 / 429 / 5xx / 超时 / 非 JSON 各自分档', async () => {
  assert.equal((await probeLaneWindows(LANE, { apiKey: 'k', fetchImpl: stub(404, {}) })).kind, 'not-found')
  assert.equal((await probeLaneWindows(LANE, { apiKey: 'k', fetchImpl: stub(429, {}) })).kind, 'rate-limited')
  assert.equal((await probeLaneWindows(LANE, { apiKey: 'k', fetchImpl: stub(503, 'no') })).kind, 'server-error')
  assert.equal((await probeLaneWindows(LANE, { apiKey: 'k', fetchImpl: stub(200, '<html>login</html>') })).kind, 'bad-request')
  const timedOut = await probeLaneWindows(LANE, {
    apiKey: 'k',
    timeoutMs: 5,
    fetchImpl: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error },
  })
  assert.equal(timedOut.kind, 'timeout')
})

await check('连通但形状不认识 → unparsed（不是 ok，也不是失败）', async () => {
  const result = await probeLaneWindows(LANE, { apiKey: 'k', fetchImpl: stub(200, { whatever: true }) })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'unparsed')
  assert.ok(result.reason.includes('whatever'), 'unparsed 要带上看到的字段名：' + result.reason)
})

await check('成功路径：reason 是人话，且不含 key', async () => {
  const result = await probeLaneWindows(LANE, {
    apiKey: 'sk-secret-abcdefghijklmnop',
    fetchImpl: stub(200, { data: { limits: [{ type: 'TIME_LIMIT_5H', used: 1, limit: 4 }] } }),
  })
  assert.equal(result.ok, true)
  assert.ok(result.reason.includes('5 小时窗'), '缺少窗口标签：' + result.reason)
  assert.ok(result.reason.includes('已用 1/4'))
  assert.ok(!JSON.stringify(result).includes('sk-secret'), '返回值里出现了 key')
})

console.log('\n通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ': ' + failure.message)
  console.log('pass=' + passed + ' fail=' + failures.length)
  process.exit(1)
}
console.log('pass=' + passed + ' fail=0')

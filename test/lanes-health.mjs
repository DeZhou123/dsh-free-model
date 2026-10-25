/**
 * 渠道健康与冷却状态机的回归防线（`src/lanes/health.js`）。
 *
 * ## 为什么这套判据必须逐条钉住
 *
 * 健康状态一旦判错，表现全是**静默的**：
 * - 400（用户参数写错）被当成渠道故障 → 整条渠道被冻住，页面显示「不可用」，没人看得出原因；
 * - 429 不遵守 retry-after → 越重试越被限得狠，最后整池渠道一起 429；
 * - 401 只记 cooldown → 每分钟拿一个废 key 再撞一次，日志被噪音塞满；
 * - 退避不封顶 → 一次小抖动让渠道冷却几小时。
 *
 * 这些都是「看起来在跑、其实就是不动」，没有断言钉住就必然复发。
 *
 * ## 另一半同样重要：落盘的文件是会被拷走的
 *
 * 健康记录会进 JSON、被贴进 issue、被拷到别的机器。所以这里有一条硬断言：
 * 落盘内容里**不许出现任何 key 形状的长串**，也不许出现任何凭据字段。
 *
 * 运行：node test/lanes-health.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HEALTH_STATES,
  classifyFailure,
  createHealthStore,
  describeHealth,
  formatDuration,
  sanitizeErrorText,
} from '../src/lanes/health.js'

let passed = 0
const failures = []

/** 与仓库既有风格一致：一项一个 label，失败不中断后续项。 */
async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✓ ' + label)
  } catch (error) {
    failures.push({ label, message: error instanceof Error ? error.message : String(error) })
    console.log('  ✗ ' + label)
  }
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** 可控时钟：健康状态的每条判据都和时间有关，用真实 Date.now 会 flaky。 */
function clock(start) {
  let current = start
  return {
    now: () => current,
    advance: (ms) => { current += ms; return current },
    set: (value) => { current = value; return current },
  }
}

const root = mkdtempSync(join(tmpdir(), 'fm-health-'))

// ── classifyFailure：七条判据逐条钉 ──────────────────────────────────────────

await check('HEALTH_STATES 只有四个状态，且冻结', () => {
  assert.deepEqual([...HEALTH_STATES], ['ok', 'cooldown', 'revoked', 'unknown'])
  assert.equal(Object.isFrozen(HEALTH_STATES), true)
})

await check('401 → revoked，cooldownMs=Infinity，不可重试', () => {
  const result = classifyFailure({ status: 401 })
  assert.equal(result.state, 'revoked')
  assert.equal(result.cooldownMs, Infinity)
  assert.equal(result.retryable, false)
  assert.ok(result.reason.length > 0)
})

await check('invalid-key / INVALID_CREDENTIAL（没有 status）也判 revoked', () => {
  assert.equal(classifyFailure({ kind: 'invalid-key' }).state, 'revoked')
  assert.equal(classifyFailure({ kind: 'invalid-api-key' }).state, 'revoked')
  assert.equal(classifyFailure({ code: 'INVALID_CREDENTIAL' }).state, 'revoked')
  assert.equal(classifyFailure({ code: 'AUTH' }).state, 'revoked')
  assert.equal(classifyFailure({ kind: 'auth' }).state, 'revoked')
})

await check('402 → cooldown 到「下一个本地整点 + 6h」，给出绝对 until', () => {
  // 用固定时刻：2026-01-01 10:20:30 本地 → 下一个整点 11:00:00 + 6h = 17:00:00
  const at = new Date(2026, 0, 1, 10, 20, 30, 0).getTime()
  const expected = new Date(2026, 0, 1, 17, 0, 0, 0).getTime()
  const result = classifyFailure({ status: 402 }, { now: () => at })
  assert.equal(result.state, 'cooldown')
  assert.equal(result.until, expected)
  assert.equal(result.cooldownMs, expected - at)
  assert.equal(result.retryable, false)
})

await check('额度类 kind / code 与 quotaHours 可配', () => {
  const at = new Date(2026, 0, 1, 10, 20, 30, 0).getTime()
  for (const input of [{ kind: 'quota' }, { code: 'QUOTA_EXCEEDED' }, { kind: 'insufficient-balance' }]) {
    const result = classifyFailure(input, { now: () => at })
    assert.equal(result.state, 'cooldown', JSON.stringify(input))
    assert.equal(result.until, new Date(2026, 0, 1, 17, 0, 0, 0).getTime())
  }
  const short = classifyFailure({ status: 402 }, { now: () => at, quotaHours: 1 })
  assert.equal(short.until, new Date(2026, 0, 1, 12, 0, 0, 0).getTime(), 'quotaHours=1 → 整点 + 1h')
})

await check('429 无 retryAfterMs → 基准 60s，可重试', () => {
  const result = classifyFailure({ status: 429 })
  assert.equal(result.state, 'cooldown')
  assert.equal(result.cooldownMs, 60 * SECOND)
  assert.equal(result.retryable, true)
  // kind 形态也认
  assert.equal(classifyFailure({ kind: 'rate-limited' }).cooldownMs, 60 * SECOND)
  assert.equal(classifyFailure({ kind: 'rate_limit' }).cooldownMs, 60 * SECOND)
})

await check('429 带 retryAfterMs → 用服务端的值，且被上限截断', () => {
  const honor = classifyFailure({ status: 429, retryAfterMs: 5 * SECOND })
  assert.equal(honor.cooldownMs, 5 * SECOND)
  assert.equal(honor.retryable, true)
  const clamp = classifyFailure({ status: 429, retryAfterMs: 24 * HOUR })
  assert.equal(clamp.cooldownMs, 30 * MINUTE, 'retry-after 不能超过 30 分钟上限')
})

await check('402 + 限流 kind（Pollinations 的「等 30 秒」）→ 按限流而不是额度', () => {
  // 上游语义是「等 30 秒」，适配器已翻译成 rate-limited（adapter.js 的 402 分支）。
  // 账本若先看状态码，会锁到「下一个整点 + 6h」—— 这是 repro-3.log §1 的 6 小时。
  const result = classifyFailure({ kind: 'rate-limited', status: 402, retryAfterMs: 30 * SECOND })
  assert.equal(result.state, 'cooldown')
  assert.equal(result.retryable, true, '限流应该可重试，不是额度耗尽')
  assert.ok(result.cooldownMs <= 60 * SECOND, '402 带 Retry-After 却冷却了 ' + result.cooldownMs + 'ms')
  assert.equal(result.cooldownMs, 30 * SECOND, '应当尊重上游的 30 秒')
  // 纯 402（没有限流 kind）仍然按额度处理 —— 不能把额度问题误判成限流。
  const quota = classifyFailure({ status: 402 })
  assert.equal(quota.retryable, false)
  assert.ok(quota.cooldownMs > HOUR, '纯 402 仍应冷却到整点 + 6h')
})

await check('429 + retryAfterMs=300s → 300_000ms（服务端说了算）', () => {
  const result = classifyFailure({ kind: 'rate-limited', status: 429, retryAfterMs: 300 * SECOND })
  assert.equal(result.state, 'cooldown')
  assert.ok(Math.abs(result.cooldownMs - 300 * SECOND) <= SECOND,
    '300 秒的 Retry-After 没被尊重：' + result.cooldownMs)
})

await check('429 + 额度 kind（正文说额度）仍按额度，不被状态码抢回限流', () => {
  // 适配器专门把「429 但正文说额度/余额」翻成 quota（adapter.js 的 429 分支），
  // 账本不能因为 status===429 就把它当成「等一会」——那会白等 60 秒而不是换车道。
  const result = classifyFailure({ kind: 'quota', status: 429 })
  assert.equal(result.state, 'cooldown')
  assert.equal(result.retryable, false, '额度问题不该被当成限流重试')
  assert.ok(result.cooldownMs > HOUR, '额度冷却应到整点 + 6h，实际 ' + result.cooldownMs)
})

await check('5xx / timeout / network / stream-cut → cooldown 30s', () => {
  for (const input of [
    { status: 500 },
    { status: 503 },
    { kind: 'server-error' },
    { kind: 'timeout' },
    { kind: 'network' },
    { kind: 'stream-cut' },
    { code: 'ETIMEDOUT' },
  ]) {
    const result = classifyFailure(input)
    assert.equal(result.state, 'cooldown', JSON.stringify(input))
    assert.equal(result.cooldownMs, 30 * SECOND, JSON.stringify(input))
    assert.equal(result.retryable, true, JSON.stringify(input))
  }
})

await check('404 → cooldown 6h 且不可重试（地址可能已过期）', () => {
  const result = classifyFailure({ status: 404 })
  assert.equal(result.state, 'cooldown')
  assert.equal(result.cooldownMs, 6 * HOUR)
  assert.equal(result.retryable, false)
})

await check('400 → state ok（不是渠道的问题，不进冷却）', () => {
  const result = classifyFailure({ status: 400 })
  assert.equal(result.state, 'ok')
  assert.equal(result.cooldownMs, 0)
  assert.equal(result.retryable, false)
  assert.equal(classifyFailure({ kind: 'bad-request' }).state, 'ok')
})

await check('未知失败 → cooldown 30s（保守），空入参也不抛', () => {
  const result = classifyFailure({ status: 599 })
  assert.equal(result.state, 'cooldown')
  assert.equal(result.cooldownMs, 30 * SECOND)
  const empty = classifyFailure()
  assert.equal(empty.state, 'cooldown')
  assert.equal(empty.cooldownMs, 30 * SECOND)
})

// ── 账本：退避、半开、吊销 ───────────────────────────────────────────────────

await check('未知 lane → state=unknown，计数为 0', () => {
  const store = createHealthStore()
  const record = store.get('nope')
  assert.equal(record.state, 'unknown')
  assert.equal(record.failures, 0)
  assert.equal(record.consecutive, 0)
})

await check('连续 3 次 5xx：cooldownMs 递增 30/60/120 秒', () => {
  const c = clock(1_000_000)
  const store = createHealthStore({ now: c.now })
  const first = store.recordFailure('lane-a', { status: 500 })
  assert.equal(first.consecutive, 1)
  assert.equal(first.until - c.now(), 30 * SECOND)
  c.advance(1 * SECOND)
  const second = store.recordFailure('lane-a', { status: 500 })
  assert.equal(second.consecutive, 2)
  assert.equal(second.until - c.now(), 60 * SECOND)
  c.advance(1 * SECOND)
  const third = store.recordFailure('lane-a', { status: 500 })
  assert.equal(third.consecutive, 3)
  assert.equal(third.until - c.now(), 120 * SECOND)
  assert.equal(third.failures, 3, 'failures 是累计数，不清零')
})

await check('指数退避封顶 maxCooldownMs（默认 30 分钟）', () => {
  const c = clock(2_000_000)
  const store = createHealthStore({ now: c.now })
  let record
  for (let i = 0; i < 12; i += 1) record = store.recordFailure('lane-b', { status: 500 })
  assert.equal(record.consecutive, 12)
  assert.equal(record.until - c.now(), 30 * MINUTE, '12 次退避必须封在 30 分钟')
  // 自定义上限也要生效
  const tight = createHealthStore({ now: c.now, maxCooldownMs: 5 * SECOND })
  tight.recordFailure('lane-c', { status: 500 })
  const second = tight.recordFailure('lane-c', { status: 500 })
  assert.equal(second.until - c.now(), 5 * SECOND)
})

await check('retryAfterMs 优先于基准值，且受 maxCooldownMs 截断', () => {
  const c = clock(3_000_000)
  const store = createHealthStore({ now: c.now })
  const honored = store.recordFailure('lane-d', { status: 429, retryAfterMs: 7 * SECOND })
  assert.equal(honored.until - c.now(), 7 * SECOND, 'retry-after 优先于 60s 基准')
  const clamped = store.recordFailure('lane-e', { status: 429, retryAfterMs: 12 * HOUR })
  assert.equal(clamped.until - c.now(), 30 * MINUTE)
})

await check('recordSuccess 清零 consecutive 并记 lastOkAt', () => {
  const c = clock(4_000_000)
  const store = createHealthStore({ now: c.now })
  store.recordFailure('lane-f', { status: 500 })
  store.recordFailure('lane-f', { status: 500 })
  assert.equal(store.get('lane-f').consecutive, 2)
  c.advance(5 * SECOND)
  const ok = store.recordSuccess('lane-f')
  assert.equal(ok.state, 'ok')
  assert.equal(ok.consecutive, 0)
  assert.equal(ok.lastOkAt, c.now())
  assert.equal(ok.until, null)
  assert.equal(ok.failures, 2, '累计 failures 保留（诊断要看历史）')
})

await check('冷却未到期：isAvailable=false 且 reason 含剩余秒数', () => {
  const c = clock(5_000_000)
  const store = createHealthStore({ now: c.now })
  store.recordFailure('lane-g', { status: 500 }) // 30 秒
  c.advance(10 * SECOND)
  const verdict = store.isAvailable('lane-g')
  assert.equal(verdict.available, false)
  assert.equal(verdict.state, 'cooldown')
  assert.match(verdict.reason, /20 秒/, 'reason 要说出还剩多少秒')
  assert.equal(verdict.until, 5_000_000 + 30 * SECOND)
})

await check('冷却到期：isAvailable=true 且带 halfOpen 标记（不是第五个状态）', () => {
  const c = clock(6_000_000)
  const store = createHealthStore({ now: c.now })
  store.recordFailure('lane-h', { status: 500 })
  c.advance(31 * SECOND)
  const verdict = store.isAvailable('lane-h')
  assert.equal(verdict.available, true)
  assert.equal(verdict.halfOpen, true, '到期只放一个探测请求')
  assert.equal(verdict.state, 'ok')
  assert.equal(HEALTH_STATES.includes('half-open'), false, '半开不许变成状态字符串')
  // get 上也看得到到期后的 halfOpen
  assert.equal(store.get('lane-h').halfOpen, true)
})

await check('revoked 永远不可用，until 为 null（不用 Infinity 落盘）', () => {
  const c = clock(7_000_000)
  const store = createHealthStore({ now: c.now })
  const record = store.recordFailure('lane-i', { status: 401 })
  assert.equal(record.state, 'revoked')
  assert.equal(record.until, null)
  c.advance(365 * 24 * HOUR)
  const verdict = store.isAvailable('lane-i')
  assert.equal(verdict.available, false)
  assert.equal(verdict.state, 'revoked')
  assert.equal(verdict.until, null)
})

await check('400 记账不制造冷却（state 仍是 ok，可继续使用）', () => {
  const c = clock(8_000_000)
  const store = createHealthStore({ now: c.now })
  const record = store.recordFailure('lane-j', { status: 400, reason: 'messages[0].content 缺失' })
  assert.equal(record.state, 'ok')
  assert.equal(record.consecutive, 0)
  assert.equal(record.failures, 1)
  assert.equal(store.isAvailable('lane-j').available, true)
  assert.match(store.get('lane-j').lastError, /content 缺失/)
})

// ── 落盘：原子写、无凭据、重载、损坏兜底 ─────────────────────────────────────

const stateFile = join(root, 'health.json')
const secret = 'sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789'

await check('落盘：文件存在、JSON 可解析、且不含任何 key 形状的长串', () => {
  const c = clock(9_000_000)
  const store = createHealthStore({ file: stateFile, now: c.now })
  store.recordSuccess('lane-k')
  store.recordFailure('lane-l', { status: 500, reason: 'fetch failed: Authorization: Bearer ' + secret })
  assert.equal(existsSync(stateFile), true, '必须真的写出来')
  const text = readFileSync(stateFile, 'utf8')
  const parsed = JSON.parse(text)
  assert.equal(typeof parsed.generatedAt, 'number')
  assert.equal(parsed.lanes['lane-l'].state, 'cooldown')
  assert.equal(parsed.lanes['lane-k'].state, 'ok')
  assert.equal(text.includes(secret), false, '完整 key 不许落盘')
  assert.equal(/[A-Za-z0-9_-]{20,}/.test(text.replace(/"(lane-[a-z])"/g, '')),
    false,
    '落盘内容里不许出现任何 20+ 连续长串')
  assert.equal(text.includes('Bearer'), true, '保留了可诊断的上下文')
})

await check('sanitizeErrorText：截断 200 字符并遮蔽长串首尾', () => {
  // 截断用「有空格的自然文本」测（单个 500 长串会先被遮蔽成 7 字，量不出截断）
  const long = 'upstream said bad thing '.repeat(40)
  assert.equal(sanitizeErrorText(long).length, 200, '必须截断到 200 字符')
  assert.equal(sanitizeErrorText('  多   空白  '), '多 空白', '压空白')
  const masked = sanitizeErrorText(secret)
  assert.equal(masked.includes(secret), false)
  assert.ok(masked.startsWith('sk-a'), '保留首 4 位便于对号')
  assert.ok(masked.endsWith('89'), '保留末 2 位便于对号')
  assert.equal(sanitizeErrorText(undefined), '')
})

await check('新 store 能从文件恢复（状态跨进程存活）', () => {
  const reloaded = createHealthStore({ file: stateFile, now: () => 9_000_000 })
  assert.equal(reloaded.get('lane-l').state, 'cooldown')
  assert.equal(reloaded.get('lane-k').state, 'ok')
  assert.equal(reloaded.get('lane-l').consecutive, 1)
})

await check('reset() 后文件回到空状态', () => {
  const c = clock(10_000_000)
  const store = createHealthStore({ file: stateFile, now: c.now })
  assert.deepEqual(Object.keys(store.snapshot().lanes).sort(), ['lane-k', 'lane-l'])
  store.reset()
  const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.deepEqual(parsed.lanes, {}, 'reset() 必须把落盘也清干净')
  assert.equal(store.get('lane-k').state, 'unknown')
  // 单条 reset
  store.recordFailure('lane-m', { status: 500 })
  store.reset('lane-m')
  assert.equal(store.get('lane-m').state, 'unknown')
})

await check('文件损坏（not json{{{）→ 不抛、warn 一次、从空状态起', () => {
  const brokenFile = join(root, 'broken.json')
  writeFileSync(brokenFile, 'not json{{{', 'utf8')
  const warnings = []
  let store
  assert.doesNotThrow(() => {
    store = createHealthStore({ file: brokenFile, logger: { warn: (msg) => warnings.push(msg) } })
  })
  assert.equal(store.get('anything').state, 'unknown')
  assert.equal(warnings.length, 1, '只 warn 一次，不是每次读都刷屏')
  // 坏文件不妨碍后续记账把它覆盖成好文件
  store.recordSuccess('lane-n')
  assert.equal(JSON.parse(readFileSync(brokenFile, 'utf8')).lanes['lane-n'].state, 'ok')
})

await check('persist:false 时给了 file 也不写盘', () => {
  const noWrite = join(root, 'never.json')
  const store = createHealthStore({ file: noWrite, persist: false })
  store.recordFailure('lane-o', { status: 500 })
  assert.equal(existsSync(noWrite), false, 'persist:false 必须完全不落盘')
  assert.equal(store.get('lane-o').state, 'cooldown', '内存里照常记账')
  assert.equal(store.flush(), false)
})

await check('snapshot() 带 generatedAt，且只含已记账的 lane', () => {
  const c = clock(11_000_000)
  const store = createHealthStore({ now: c.now })
  store.recordFailure('lane-p', { status: 429 })
  const snap = store.snapshot()
  assert.equal(snap.generatedAt, 11_000_000)
  assert.deepEqual(Object.keys(snap.lanes), ['lane-p'])
  assert.equal(snap.lanes['lane-p'].state, 'cooldown')
})

// ── describeHealth：四种状态都要说人话 ───────────────────────────────────────

await check('describeHealth 四种状态各返回非空中文', () => {
  const c = clock(12_000_000)
  const store = createHealthStore({ now: c.now })

  const unknown = describeHealth(store.get('x'), c.now())
  assert.ok(unknown.length > 0)
  assert.match(unknown, /未知/)

  store.recordFailure('cooldown-lane', { status: 500 })
  c.advance(10 * SECOND)
  const cooling = describeHealth(store.get('cooldown-lane'), c.now())
  assert.ok(cooling.length > 0)
  assert.match(cooling, /冷却中/)
  assert.match(cooling, /秒/)

  store.recordFailure('revoked-lane', { status: 401 })
  const revoked = describeHealth(store.get('revoked-lane'), c.now())
  assert.ok(revoked.length > 0)
  assert.match(revoked, /吊销/)
  assert.match(revoked, /换/)

  c.advance(3 * MINUTE)
  store.recordSuccess('ok-lane')
  c.advance(0)
  const ok = describeHealth(store.get('ok-lane'), c.now())
  assert.ok(ok.length > 0)
  assert.match(ok, /ok/)
})

await check('formatDuration 说人话（秒 / 分钟 / 小时）', () => {
  assert.equal(formatDuration(42 * SECOND), '42 秒')
  assert.equal(formatDuration(3 * MINUTE), '3 分钟')
  assert.equal(formatDuration(2 * HOUR), '2 小时')
  assert.equal(formatDuration(-5), '0 秒')
})


// ── 0.6.0：多实例落盘不互相覆盖（审计 P2-2）────────────────────────────────
await check('落盘是「读-合并-写」：对方更新的记录不会被本进程覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-merge-'))
  const file = join(dir, 'health.json')
  try {
    let clock = 1_000_000
    const mine = createHealthStore({ file, now: () => clock })
    mine.recordFailure('dup', { kind: 'rate-limited' })
    // 另一个实例（更晚的时刻）把同一条渠道写成 revoked 并落盘
    const other = createHealthStore({ file, now: () => clock + 60_000 })
    other.recordFailure('dup', { kind: 'invalid-key', status: 401 })
    // 本进程再动一次盘：它不该把对方那条更严重的结论盖掉
    clock = 1_000_000 + 120_000
    mine.recordFailure('other-lane', { kind: 'server-error', status: 500 })
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.lanes.dup.state, 'revoked', '对方的吊销结论被本进程的旧结论覆盖了')
    assert.ok(onDisk.lanes['other-lane'] !== undefined, '本进程自己那条没写进去')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('reset 是权威动作：清空之后不许被盘上的旧记录合并回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-reset-'))
  const file = join(dir, 'health.json')
  try {
    const store = createHealthStore({ file, now: () => 2_000_000 })
    store.recordFailure('x', { kind: 'invalid-key', status: 401 })
    store.reset()
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(onDisk.lanes), [], 'reset 之后盘上还有记录：' + JSON.stringify(onDisk.lanes))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('单条 reset 只权威于那一条：其它窗口记下的渠道仍在盘上（repro-4）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-reset-one-'))
  const file = join(dir, 'health.json')
  try {
    // 窗口 A 先记下自己要 reset 的那条（盘上有 lane-a）
    const a = createHealthStore({ file, now: () => 3_000_000 })
    a.recordFailure('lane-a', { kind: 'server-error', status: 500 })
    // 窗口 B 在 A 启动之后记下两条：一条永久吊销 + 一条 6h 冷却
    const b = createHealthStore({ file, now: () => 3_000_001 })
    b.recordFailure('lane-b', { kind: 'invalid-key', status: 401 })
    b.recordFailure('lane-c', { kind: 'quota', status: 402 })
    // 用户在 A 里保存 key → manage.js 的 health.reset(laneId)
    a.reset('lane-a')
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(onDisk.lanes).sort(), ['lane-b', 'lane-c'],
      '单条 reset 把别的窗口的记录删掉了：' + JSON.stringify(Object.keys(onDisk.lanes)))
    assert.equal(onDisk.lanes['lane-b'].state, 'revoked', 'B 的吊销结论变了')
    assert.equal(onDisk.lanes['lane-c'].state, 'cooldown', 'B 的冷却结论变了')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 0.6.0：403 不是「key 坏了」（B 车道实测 Groq 的 Cloudflare 403）────────────
await check('403 判冷却而不是永久吊销：它可能是边缘拦截或权限问题，与 key 无关', () => {
  const byStatus = classifyFailure({ status: 403, kind: 'forbidden' })
  assert.equal(byStatus.state, 'cooldown', '403 被永久吊销了：' + JSON.stringify(byStatus))
  assert.ok(Number.isFinite(byStatus.cooldownMs), '403 的冷却时长应当是有限的')
  assert.ok(byStatus.reason.includes('不一定'), '原因要说清「不一定是 key 的问题」：' + byStatus.reason)
  // 401 仍然是永久吊销 —— 那条证据是确定的。
  assert.equal(classifyFailure({ status: 401, kind: 'invalid-key' }).state, 'revoked')
  // 带 invalid-key 字样的 403 仍按 key 处理（上游自己说了凭据无效）。
  assert.equal(classifyFailure({ status: 403, kind: 'invalid-key' }).state, 'revoked')
})

await check('describeHealth 带上失败原因（只有「还有 6 小时」不够，用户要知道为什么）', () => {
  const store = createHealthStore({ persist: false, now: () => 1_700_000_000_000 })
  store.recordFailure('lane', { kind: 'rate-limited', status: 429, reason: 'too many requests' })
  const text = describeHealth(store.get('lane'), 1_700_000_000_000)
  assert.ok(text.includes('冷却中'), '缺少冷却状态：' + text)
  assert.ok(text.includes('too many requests'), '缺少失败原因：' + text)
  // 没有原因时不要凭空加一对空括号
  store.recordFailure('lane2', { kind: 'server-error', status: 500 })
  const noWhy = describeHealth(store.get('lane2'), 1_700_000_000_000)
  assert.equal(noWhy.includes('（）'), false, '空原因不该渲染成一对空括号：' + noWhy)
})
rmSync(root, { recursive: true, force: true })

console.log('pass=' + passed + ' fail=' + failures.length)
if (failures.length > 0) {
  for (const failure of failures) console.log('  FAIL ' + failure.label + ' → ' + failure.message)
  process.exit(1)
}
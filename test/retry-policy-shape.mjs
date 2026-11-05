
/**
 * 重试策略的**形状**闸门（2026-11-05）。
 *
 * ## 为什么单独一个套件
 *
 * 宿主对适配器的 \`providerRetryPolicy()\` 返回值**不做解析、逐字保存**
 * （\`@deepseek-ai/dsh-llm\` 类型层：\`adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(undefined, …)\`），
 * 而退避调度器读的是**顶层** \`initialDelayMs\` / \`maxDelayMs\` / \`jitterRatio\`
 * （\`@deepseek-ai/dsh-llm-retry\` 的 \`localDelay\`）。
 *
 * 把这三个字段写成 \`backoff: { … }\`（那是**配置文件**的形状）会让它们变成 \`undefined\` ⇒ \`NaN\`，
 * 而 \`setTimeout(fn, NaN)\` 按 Node 语义视为 **0ms** —— 策略看着写得挺细，实际**一次都没生效**。
 * 实测：keyed 适配器就是这样（第一次重试延迟 NaN），直到 2026-11-05 才发现。
 *
 * 所以这里断言三件事，对**每一条**车道适配器都成立：
 *   1. 顶层三个字段存在且是有限数；
 *   2. 没有 \`backoff\` 这种配置形状的残留（出现了就说明又被写回去了）；
 *   3. 用宿主同一条公式算出来的延迟是**有限正数**——这是「策略真的生效」的判据，
 *      不是「字段看起来对」的判据。
 */
import assert from 'node:assert/strict'
import { BuddyAdapter } from '../src/core/buddy-adapter.js'
import { createKeyedAdapter } from '../src/lanes/keyed/adapter.js'
import { laneById } from '../src/lanes/keyed/catalog.js'

let pass = 0
const failed = []
function check(label, fn) {
  try {
    fn()
    pass += 1
    console.log('  ok    ' + label)
  } catch (error) {
    failed.push(label + ': ' + (error?.message ?? error))
    console.log('  FAIL  ' + label + ' (' + (error?.message ?? error) + ')')
  }
}

/** 逐字复刻 \`@deepseek-ai/dsh-llm-retry\` 的 \`localDelay\`（lib/index.js:44-49）。 */
function localDelay(config, retry, random = () => 0.5) {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
  return Math.min(exponential * jitter, config.maxDelayMs)
}

function assertShape(label, policy) {
  assert.ok(policy !== undefined && policy !== null, label + '：没有声明策略（会吃宿主默认 maxRetries=5）')
  assert.equal(policy.mode, 'normal', label + '：mode 缺失')
  assert.ok(Number.isInteger(policy.maxRetries) && policy.maxRetries >= 0, label + '：maxRetries 不是非负整数')
  assert.ok(Array.isArray(policy.retryableCodes), label + '：retryableCodes 不是数组')
  assert.equal(policy.backoff, undefined, label + '：出现了 backoff（配置形状），调度器读的是顶层字段')
  assert.ok(Number.isFinite(policy.initialDelayMs), label + '：顶层 initialDelayMs 不是有限数：' + policy.initialDelayMs)
  assert.ok(Number.isFinite(policy.maxDelayMs), label + '：顶层 maxDelayMs 不是有限数：' + policy.maxDelayMs)
  assert.ok(Number.isFinite(policy.jitterRatio), label + '：顶层 jitterRatio 不是有限数：' + policy.jitterRatio)
  assert.ok(policy.initialDelayMs > 0 && policy.initialDelayMs <= policy.maxDelayMs, label + '：退避区间不合法')
  if (policy.maxRetries > 0) {
    const delay = localDelay(policy, 1)
    assert.ok(Number.isFinite(delay) && delay > 0, label + '：第一次重试的延迟不是有限正数：' + delay)
  }
}

console.log('\n[1] buddy / workbuddy 家族（此前完全没有声明，吃宿主默认 5 次）')
{
  const buddy = new BuddyAdapter({})
  check('形状闸门：BuddyAdapter 的策略是扁平且延迟可算', () => assertShape('BuddyAdapter', buddy.providerRetryPolicy()))
  const policy = buddy.providerRetryPolicy()
  check('buddy 家族最多重试 1 次（默认 5 次会刷穿账号额度）', () => assert.equal(policy.maxRetries, 1))
  check('buddy 家族的 RATE_LIMIT 不在可重试码里（本家 429 是账号级额度，等待不会变好）', () => {
    assert.ok(!policy.retryableCodes.includes('RATE_LIMIT'), JSON.stringify(policy.retryableCodes))
  })
  check('瞬时类故障仍然可重试', () => {
    for (const code of ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
      assert.ok(policy.retryableCodes.includes(code), code + ' 丢失了')
    }
  })
}

console.log('\n[2] keyed 车道（原来写成嵌套 backoff ⇒ 延迟 NaN ⇒ 0ms）')
{
  const lane = laneById('groq')
  check('形状闸门：keyed/普通 的策略是扁平且延迟可算',
    () => assertShape('keyed/普通', createKeyedAdapter({ lane: { ...lane, id: 'groq' }, apiKey: 'k' }).providerRetryPolicy()))
  const serialLane = { ...laneById('pollinations'), serialRateLimit: true }
  check('形状闸门：keyed/串行限速 的策略是扁平且延迟可算',
    () => assertShape('keyed/串行限速', createKeyedAdapter({ lane: serialLane, apiKey: null }).providerRetryPolicy()))
  check('串行限速车道不自己重试', () => {
    const p = createKeyedAdapter({ lane: serialLane, apiKey: null }).providerRetryPolicy()
    assert.equal(p.maxRetries, 0)
    assert.deepEqual(p.retryableCodes, [])
  })
}

console.log('\n' + (failed.length === 0 ? 'PASS' : 'FAIL') + ' — ' + pass + ' 项')
if (failed.length > 0) {
  for (const line of failed) console.log('  ✗ ' + line)
  process.exitCode = 1
}

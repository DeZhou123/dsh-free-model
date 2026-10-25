/**
 * 错误分类断言（离线，喂假响应）。
 *
 * 这一层守的是「**页面能不能说清为什么不能用**」。免费渠道的失败几乎全是
 * 四类之一，而处置**完全相反**：
 * - 凭据错 → 去改 key（重试无用）；
 * - 额度用尽 → 换车道（等无用）；
 * - 限流 → 等一会儿（换车道是浪费）；
 * - 连不上 → 查网络/代理。
 * 把其中任意两类混成一句"失败了"，用户就会一直重试一件永远不会成功的事。
 *
 * ⚠️ 先注册 `../hooks.mjs`，再动态 import 适配器。
 *
 * 用法：node test/keyed/adapter-errors.mjs
 */

import assert from 'node:assert/strict'

await import('../hooks.mjs')
const {
  FAILURE_KINDS,
  classifyUpstreamFailure,
  frameData,
  parseRetryAfter,
  pickFailureDetail,
} = await import('../../src/lanes/keyed/adapter.js')
const { createKeyedAdapter } = await import('../../src/lanes/keyed/adapter.js')
const { laneById } = await import('../../src/lanes/keyed/catalog.js')

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

const LANE = laneById('openrouter-free')
const POLL = laneById('pollinations')

/**
 * 取 LlmError 上承载的 provider 事实。
 *
 * ⚠️ 离线跑时 `@deepseek-ai/dsh-llm` 是 `test/fixtures/kernel-stubs.mjs` 的替身，
 * 它的 LlmError **没有 `.failure` 字段**（真实内核有：`error.failure.status`）。
 * 这个 helper 同时认两种形状，断言只依赖"事实确实被带出来了"，不依赖承载方式。
 */
function failureOf(error) {
  return error?.failure ?? error ?? {}
}

/** 一个只回给定状态的 fetch 替身（非 2xx 时正文照读）。 */
function statusFetch(status, body, headers = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body) },
    async json() { return typeof body === 'string' ? JSON.parse(body) : body },
    body: null,
  })
}

/** 跑一次 stream 并返回分类后的错误（断言 code / failure 字段）。 */
async function errorFrom(status, body, { headers = {}, lane = LANE, timeoutMs } = {}) {
  const adapter = createKeyedAdapter({ lane, apiKey: 'sk-test', fetchImpl: statusFetch(status, body, headers), timeoutMs })
  try {
    for await (const _piece of adapter.stream({ model: 'recursive/flint-v1.0:free', messages: [{ role: 'user', content: 'x' }] })) { /* 不该有 chunk */ }
  } catch (error) {
    return { error, adapter }
  }
  throw new Error('居然没有抛错')
}

// ── 状态码 → 分类 ──────────────────────────────────────────────────────────
await checkAsync('401 → 凭据问题（不是限流、不是额度）', async () => {
  const { error, adapter } = await errorFrom(401, { error: { message: 'Invalid API key', type: 'invalid_request_error' } })
  assert.equal(error.code, 'INVALID_CREDENTIAL')
  assert.equal(failureOf(error).status, 401)
  assert.equal(adapter.lastFailure().kind, FAILURE_KINDS.CREDENTIAL)
  assert.equal(adapter.lastFailure().retryable, false)
  assert.match(adapter.lastFailure().advice, /key/)
})

await checkAsync('403 但正文说的是额度 → 按额度报（措辞优先于状态码）', async () => {
  const { error } = await errorFrom(403, { error: { message: 'Your account has insufficient balance, please recharge.' } })
  assert.equal(error.code, 'QUOTA')
  assert.match(error.message, /额度|余额/)
})

await checkAsync('402 → 额度用尽（等不会恢复：retryable=false）', async () => {
  const { error, adapter } = await errorFrom(402, { error: { message: 'Insufficient credits' } })
  assert.equal(error.code, 'QUOTA')
  assert.equal(adapter.lastFailure().kind, FAILURE_KINDS.QUOTA)
  assert.equal(adapter.lastFailure().retryable, false)
  assert.match(adapter.lastFailure().advice, /换一条车道|充值/)
})

await checkAsync('402 + Retry-After（Pollinations 的按 IP 限速）→ 判限流，不判额度', async () => {
  const { error, adapter } = await errorFrom(402, '{"error":"rate limited"}', { headers: { 'retry-after': '30' }, lane: POLL })
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(adapter.lastFailure().kind, FAILURE_KINDS.RATE_LIMIT)
  assert.equal(adapter.lastFailure().retryable, true)
  assert.equal(failureOf(error).providerRetryAfterMs, 30_000)
})

await checkAsync('429 + Retry-After: 30 → 限流，带 providerRetryAfterMs', async () => {
  const { error, adapter } = await errorFrom(429, { error: { message: 'Rate limit exceeded' } }, { headers: { 'retry-after': '30' } })
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(failureOf(error).status, 429)
  assert.equal(failureOf(error).providerRetryAfterMs, 30_000)
  assert.equal(adapter.lastFailure().retryable, true)
  assert.match(adapter.lastFailure().advice, /30 秒/)
})

await checkAsync('429 但正文说额度 → 仍判额度（重试永不恢复，不许并进限流）', async () => {
  const { error, adapter } = await errorFrom(429, '{"message":"You exceeded your current quota, please check your plan and billing details"}')
  assert.equal(error.code, 'QUOTA')
  assert.equal(adapter.lastFailure().kind, FAILURE_KINDS.QUOTA)
  assert.equal(adapter.lastFailure().retryable, false)
})

await checkAsync('429 无 Retry-After → 限流且不编造等待时间', async () => {
  const { error, adapter } = await errorFrom(429, { error: { message: 'too many requests' } })
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(failureOf(error).providerRetryAfterMs, undefined)
  assert.equal(adapter.lastFailure().retryAfterMs, undefined)
})

await checkAsync('404 + 点名模型 → 模型不存在（提示刷新目录）', async () => {
  const { error, adapter } = await errorFrom(404, { error: { message: 'The model `x/y:free` does not exist' } })
  assert.equal(error.code, 'MODEL_NOT_FOUND')
  assert.equal(adapter.lastFailure().kind, FAILURE_KINDS.UNKNOWN_MODEL)
  assert.match(adapter.lastFailure().advice, /刷新目录/)
})

await checkAsync('404 不点名模型 → 仍归模型类，但文案要点出"也可能是路由"', async () => {
  const { adapter } = await errorFrom(404, '<html>404 Not Found</html>')
  assert.equal(adapter.lastFailure().kind, FAILURE_KINDS.UNKNOWN_MODEL)
  assert.match(adapter.lastFailure().advice, /baseURL\/路由/)
})

await checkAsync('400 + 上下文措辞 → CONTEXT_WINDOW_EXCEEDED（换模型，不是重试）', async () => {
  const { error, adapter } = await errorFrom(400, { error: { message: "This model's maximum context length is 8192 tokens. Your messages resulted in 9000 tokens" } })
  assert.equal(error.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(adapter.lastFailure().kind, FAILURE_KINDS.CONTEXT)
  assert.match(adapter.lastFailure().advice, /压缩|换更大窗口/)
})

await checkAsync('400 其他措辞 → INVALID_REQUEST（参数不被接受）', async () => {
  const { error, adapter } = await errorFrom(400, { error: { message: 'unknown field tools' } })
  assert.equal(error.code, 'INVALID_REQUEST')
  assert.equal(adapter.lastFailure().kind, FAILURE_KINDS.INVALID_REQUEST)
})

await checkAsync('5xx → SERVER（可重试，且明说不是用户的配置问题）', async () => {
  const { error, adapter } = await errorFrom(503, { error: { message: 'upstream overloaded' } })
  assert.equal(error.code, 'SERVER')
  assert.equal(adapter.lastFailure().retryable, true)
  assert.match(adapter.lastFailure().advice, /不是你的配置问题/)
})

await checkAsync('超时（真的等不到）→ connection/TIMEOUT，可重试', async () => {
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    timeoutMs: 40,
    fetchImpl: (url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
      }, { once: true })
    }),
  })
  let caught
  try {
    for await (const _piece of adapter.stream({ model: 'recursive/flint-v1.0:free', messages: [{ role: 'user', content: 'x' }] })) { /* 空 */ }
  } catch (error) { caught = error }
  assert.equal(caught?.code, 'TIMEOUT')
  const failure = adapter.lastFailure()
  assert.equal(failure.kind, FAILURE_KINDS.CONNECTION)
  assert.equal(failure.retryable, true)
  assert.match(failure.advice, /超时/)
})

await checkAsync('网络不可达（fetch failed）→ connection/TRANSPORT，可重试', async () => {
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: async () => { throw new TypeError('fetch failed') },
  })
  let caught
  try {
    for await (const _piece of adapter.stream({ model: 'recursive/flint-v1.0:free', messages: [{ role: 'user', content: 'x' }] })) { /* 空 */ }
  } catch (error) { caught = error }
  assert.equal(caught?.code, 'TRANSPORT')
  assert.equal(adapter.lastFailure().kind, FAILURE_KINDS.CONNECTION)
  assert.match(adapter.lastFailure().advice, /连不上/)
})

await checkAsync('外层取消 → ABORTED（不是"上游失败"）', async () => {
  const controller = new AbortController()
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    timeoutMs: 5000,
    // 上游挂在半路：只对 signal 做出反应。外层取消 → 我们的 controller 也 abort →
    // 这里 reject，分类必须是 ABORTED 而不是"上游报了错"。
    fetchImpl: (url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted by caller'), { name: 'AbortError' }))
      }, { once: true })
    }),
  })
  const pending = (async () => {
    for await (const _piece of adapter.stream({ model: 'recursive/flint-v1.0:free', messages: [{ role: 'user', content: 'x' }], signal: controller.signal })) { /* 空 */ }
  })()
  setTimeout(() => controller.abort(), 20)
  let caught
  try { await pending } catch (error) { caught = error }
  assert.equal(adapter.lastFailure().kind, FAILURE_KINDS.ABORTED)
  assert.equal(caught?.code, 'ABORTED', 'code=' + caught?.code)
})

// ── 流内错误帧（没有 HTTP 状态码） ─────────────────────────────────────────
await checkAsync('流内错误帧：额度措辞 → QUOTA（不是"连不上"）', async () => {
  const encoder = new TextEncoder()
  const frame = 'data: ' + JSON.stringify({ error: { message: 'You are out of credits', type: 'insufficient_quota' } }) + '\n\n'
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: async () => ({
      ok: true, status: 200, headers: {},
      body: { getReader: () => ({ read: (() => { let sent = false; return async () => (sent ? { done: true } : (sent = true, { done: false, value: encoder.encode(frame) })) })(), async cancel() {} }) },
    }),
  })
  let caught
  try {
    for await (const _piece of adapter.stream({ model: 'recursive/flint-v1.0:free', messages: [{ role: 'user', content: 'x' }] })) { /* 空 */ }
  } catch (error) { caught = error }
  assert.equal(caught?.code, 'QUOTA')
  assert.equal(adapter.lastFailure().kind, FAILURE_KINDS.QUOTA)
  assert.equal(adapter.lastFailure().status, undefined, '流内错误帧没有 HTTP 状态')
})

await checkAsync('流内错误帧：限流措辞 → RATE_LIMIT，可重试', async () => {
  const encoder = new TextEncoder()
  const frame = 'data: ' + JSON.stringify({ error: { message: 'rate limit exceeded, please retry' } }) + '\n\n'
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: async () => ({
      ok: true, status: 200, headers: {},
      body: { getReader: () => ({ read: (() => { let sent = false; return async () => (sent ? { done: true } : (sent = true, { done: false, value: encoder.encode(frame) })) })(), async cancel() {} }) },
    }),
  })
  let caught
  try {
    for await (const _piece of adapter.stream({ model: 'recursive/flint-v1.0:free', messages: [{ role: 'user', content: 'x' }] })) { /* 空 */ }
  } catch (error) { caught = error }
  assert.equal(caught?.code, 'RATE_LIMIT')
  assert.equal(adapter.lastFailure().retryable, true)
})

// ── 分类之间必须"区分得开" ────────────────────────────────────────────────
await checkAsync('四类失败的 kind / code / retryable / advice 两两不同', async () => {
  const cases = [
    { name: '凭据', result: classifyUpstreamFailure({ status: 401, body: '{"error":{"message":"Invalid API key"}}', lane: LANE }) },
    { name: '额度', result: classifyUpstreamFailure({ status: 402, body: '{"error":{"message":"Insufficient credits"}}', lane: LANE }) },
    { name: '限流', result: classifyUpstreamFailure({ status: 429, body: '{"error":{"message":"Rate limit exceeded"}}', headers: { 'retry-after': '12' }, lane: LANE }) },
    { name: '连接', result: classifyUpstreamFailure({ lane: LANE, error: new TypeError('fetch failed') }) },
  ]
  const kinds = new Set(cases.map((entry) => entry.result.kind))
  const codes = new Set(cases.map((entry) => entry.result.code))
  const advices = new Set(cases.map((entry) => entry.result.advice))
  assert.equal(kinds.size, 4, 'kind 有重合：' + JSON.stringify(cases.map((entry) => [entry.name, entry.result.kind])))
  assert.equal(codes.size, 4, 'code 有重合：' + JSON.stringify(cases.map((entry) => [entry.name, entry.result.code])))
  assert.equal(advices.size, 4, 'advice 有重合（用户看到的就是它）')
  assert.deepEqual(cases.map((entry) => entry.result.retryable), [false, false, true, true])
  for (const entry of cases) assert.equal(entry.result.detail.length > 0, true, entry.name + ' 丢了上游原话')
})

// ── 工具函数 ───────────────────────────────────────────────────────────────
await checkAsync('parseRetryAfter：秒数/时长串/HTTP-date/越界/垃圾', () => {
  assert.equal(parseRetryAfter('30'), 30_000)
  assert.equal(parseRetryAfter('1s'), 1000)
  assert.equal(parseRetryAfter('120ms'), 500, '太短要夹到 500ms（否则等于没等）')
  assert.equal(parseRetryAfter('2m'), 120_000)
  assert.equal(parseRetryAfter('3600'), 600_000, '太长要夹到 10 分钟（否则等于卡死）')
  assert.equal(parseRetryAfter('0'), undefined)
  assert.equal(parseRetryAfter('随便什么'), undefined)
  assert.equal(parseRetryAfter(undefined), undefined)
  const now = Date.parse('2026-10-25T01:00:00Z')
  assert.equal(parseRetryAfter('Sat, 25 Oct 2026 01:00:20 GMT', now), 20_000)
  assert.equal(parseRetryAfter(new Date(now - 5000).toISOString(), now), undefined, '过去的 HTTP-date 不该变成负数')
})

await checkAsync('pickFailureDetail：四家的错误体形状都能抽出人话', () => {
  assert.equal(pickFailureDetail('{"error":{"message":"Invalid API key","type":"invalid_request_error"}}'), 'Invalid API key / invalid_request_error')
  assert.equal(pickFailureDetail('{"error":{"code":"1001","message":"Header中未收到Authorization参数"}}'), 'Header中未收到Authorization参数 / 1001')
  assert.equal(pickFailureDetail('{"code":30014,"data":null,"message":"Token is invalid."}'), 'Token is invalid. / 30014')
  assert.equal(pickFailureDetail('{"detail":"Not authenticated"}'), 'Not authenticated')
  assert.equal(pickFailureDetail('<html>502 Bad Gateway</html>'), '<html>502 Bad Gateway</html>')
  assert.equal(pickFailureDetail(''), '')
  assert.equal(pickFailureDetail(null), '')
})

await checkAsync('classifyUpstreamFailure：缺车道信息也不崩', () => {
  const bare = classifyUpstreamFailure({ status: 500 })
  assert.equal(bare.kind, FAILURE_KINDS.SERVER)
  assert.equal(bare.detail, '')
  assert.equal(typeof bare.advice, 'string')
})

await checkAsync('frameData 不在分类层里被破坏（回归：SSE 负载原样）', () => {
  assert.equal(frameData('data: {"error":{"message":"x"}}'), '{"error":{"message":"x"}}')
})

// ── 0.6.0：健康闸门与结果回执 ───────────────────────────────────────────────

/**
 * 造一个假 fetch：`/models` 照常回一份最小目录，其余走给定的状态。
 *
 * ⚠️ 必须区分 URL：适配器**先读目录再发对话**，如果桩对两次调用回同一个 401，
 * 那么失败发生在"读目录"那一步，测的就不是"对话被拒"（第一版就是这么写错的，
 * 断言报的是 `回执次数 0`，而真因是根本没走到发请求）。
 */
function stubFetch(status, body, headers = {}) {
  const modelsBody = JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b' }] })
  return async (url) => {
    if (String(url).endsWith('/models')) {
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => modelsBody,
        body: null,
      }
    }
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      text: async () => body,
      body: null,
    }
  }
}

function makeAdapter(overrides) {
  const lane = { ...laneById('groq'), id: 'groq' }
  return createKeyedAdapter({ lane, apiKey: 'k-1', ...overrides })
}

await checkAsync('闸门：冷却中的渠道**不发请求**，且原因带剩余时间', async () => {
  let called = 0
  const adapter = makeAdapter({
    fetchImpl: async () => { called += 1; return stubFetch(200, '')() },
    beforeRequest: () => ({ available: false, state: 'cooldown', reason: '冷却中，还有 42 分钟' }),
  })
  let caught
  try {
    for await (const _ of adapter.stream({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] })) { void _ }
  } catch (error) { caught = error }
  assert.equal(called, 0, '冷却中还是把请求发出去了')
  assert.ok(caught !== undefined, '冷却中却没有抛错')
  assert.ok(String(caught.message).includes('42 分钟'), '错误里没带剩余时间：' + caught.message)
  assert.equal(caught.code, 'RATE_LIMIT', '冷却应归到可重试档，实际 code=' + caught.code)
})

await checkAsync('闸门：吊销的渠道报 MISSING_CREDENTIAL（换 key 才是下一步）', async () => {
  const adapter = makeAdapter({
    fetchImpl: async () => { throw new Error('不该被调用') },
    beforeRequest: () => ({ available: false, state: 'revoked', reason: '已吊销：key 被拒，换个 key' }),
  })
  let caught
  try {
    for await (const _ of adapter.stream({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] })) { void _ }
  } catch (error) { caught = error }
  assert.equal(caught?.code, 'MISSING_CREDENTIAL')
  assert.ok(String(caught.message).includes('key'), '错误里没说 key 有问题')
})

await checkAsync('闸门：放行的渠道照常发出请求', async () => {
  let called = 0
  const adapter = makeAdapter({
    fetchImpl: async () => { called += 1; throw Object.assign(new Error('boom'), { name: 'TypeError' }) },
    beforeRequest: () => ({ available: true, state: 'ok', reason: 'ok' }),
  })
  try {
    for await (const _ of adapter.stream({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] })) { void _ }
  } catch { /* 传输失败是预期 */ }
  // ⚠️ 两条调用：先 GET /models（目录），再 POST /chat/completions。
  // 断言 `1` 会漏掉「目录那次」，而目录请求**也要**受闸门管 —— 这里数的是总次数。
  assert.equal(called, 2, '放行时请求次数不对（应为目录 + 对话各一次）：' + called)
})

await checkAsync('闸门：闸门自己抛错时不影响请求（健康是增强不是依赖）', async () => {
  let called = 0
  const adapter = makeAdapter({
    fetchImpl: async () => { called += 1; throw Object.assign(new Error('boom'), { name: 'TypeError' }) },
    beforeRequest: () => { throw new Error('账本文件坏了') },
  })
  try {
    for await (const _ of adapter.stream({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] })) { void _ }
  } catch { /* 预期 */ }
  assert.equal(called, 2, '闸门抛错把请求一起挡住了：' + called)
})

await checkAsync('回执：上游 401 时会通知一次失败（kind=credential）', async () => {
  const seen = []
  const adapter = makeAdapter({
    fetchImpl: stubFetch(401, '{"error":{"message":"Invalid API key"}}'),
    onOutcome: (event) => seen.push(event),
  })
  try {
    for await (const _ of adapter.stream({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] })) { void _ }
  } catch { /* 预期 */ }
  assert.equal(seen.length, 1, '回执次数不对：' + seen.length)
  assert.equal(seen[0].ok, false)
  assert.equal(seen[0].kind, FAILURE_KINDS.CREDENTIAL)
  assert.equal(seen[0].status, 401)
})

await checkAsync('回执：回执回调自己抛错不会把失败请求变成另一种错', async () => {
  const adapter = makeAdapter({
    fetchImpl: stubFetch(401, '{"error":{"message":"x"}}'),
    onOutcome: () => { throw new Error('账本写炸了') },
  })
  let caught
  try {
    for await (const _ of adapter.stream({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] })) { void _ }
  } catch (error) { caught = error }
  // 401 的分类码是 INVALID_CREDENTIAL（见 classifyUpstreamFailure）：
  // 这里要断言的是「回执抛错没有改变原来那个码」，具体码值由分类层负责。
  assert.equal(caught?.code, 'INVALID_CREDENTIAL', '原始失败码被回执的异常替换了：' + caught?.code)
})
await checkAsync('重试策略：串行限速渠道不自己重试，其余最多 1 次（上界可算）', () => {
  const { createKeyedAdapter: mk } = { createKeyedAdapter }
  const normal = mk({ lane: { ...laneById('groq'), id: 'groq' }, apiKey: 'k' })
  const policy = normal.providerRetryPolicy()
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 1, '普通渠道的重试上限必须是 1（默认 5 次会刷穿免费额度）')
  assert.ok(policy.backoff.initialDelayMs >= 1_000, '退避起点太短')
  assert.ok(policy.backoff.maxDelayMs <= 30_000)
  assert.ok(Array.isArray(policy.retryableCodes) && policy.retryableCodes.includes('RATE_LIMIT'))
  // pollinations 是「同一 IP 间隔 ≥30 秒」的串行限速渠道：重试只会把窗口推远。
  const serial = mk({ lane: { ...laneById('pollinations'), serialRateLimit: true }, apiKey: null })
  const serialPolicy = serial.providerRetryPolicy()
  assert.equal(serialPolicy.maxRetries, 0, '串行限速渠道不该自己重试')
  assert.deepEqual(serialPolicy.retryableCodes, [])
})
console.log('\n通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ': ' + failure.message)
  console.log('pass=' + passed + ' fail=' + failures.length)
  process.exit(1)
}
console.log('pass=' + passed + ' fail=0')
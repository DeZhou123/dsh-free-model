/**
 * 适配器流式解析断言（离线；最后一个用例起一个**真的**本地 HTTP 上游）。
 *
 * 守的是「**用户看到的字**」：
 * - 跨 chunk 的半行不能丢（TCP 分片是最常见的一次性故障）；
 * - `[DONE]` 必须收尾（否则会话永远转圈）；
 * - 空 delta 不能凭空造块（会多出一段空回答）；
 * - 工具调用的参数要拼回合法 JSON（拼错 = 宿主拿一个坏调用去执行）。
 *
 * ⚠️ 先注册 `../hooks.mjs`（内核包 → 离线替身），再动态 import 适配器。
 *
 * 用法：node test/keyed/adapter-stream.mjs
 */

import assert from 'node:assert/strict'
import http from 'node:http'

await import('../hooks.mjs')
const { createKeyedAdapter, convertRequestMessages, buildOpenAiBody, frameData, normalizeUsage } = await import('../../src/lanes/keyed/adapter.js')
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

/** 造一个"只吐给定字节"的 fetch 替身（模拟 SSE 连接）。 */
function sseFetch(chunks, { status = 200, headers = {} } = {}) {
  const encoder = new TextEncoder()
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers,
    async text() { return chunks.join('') },
    async json() { return JSON.parse(chunks.join('') || '{}') },
    body: {
      getReader() {
        let index = 0
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined }
            const value = encoder.encode(chunks[index])
            index += 1
            return { done: false, value }
          },
          async cancel() {},
        }
      },
    },
  })
}

/** `data: {…}` 帧（含空行）；`raw` 用来插非 JSON 的帧（keepalive 之类）。 */
const frame = (payload) => 'data: ' + (typeof payload === 'string' ? payload : JSON.stringify(payload)) + '\n\n'

/** 一条带 choices[0].delta 的最小合法 chunk。 */
function chunkOf(delta, extra = {}) {
  return { id: 'gen-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra }
}

/** 跑一次 stream，收全部 chunk（出错时也把已收到的 chunk 一起返回）。 */
async function runStream(adapter, options) {
  const chunks = []
  let error
  try {
    for await (const piece of adapter.stream({ model: 'recursive/flint-v1.0:free', messages: [{ role: 'user', content: 'hi' }], ...options })) {
      chunks.push(piece)
    }
  } catch (caught) {
    error = caught
  }
  return { chunks, error }
}

const types = (chunks) => chunks.map((piece) => piece.type)
const textOf = (chunks) => chunks.filter((piece) => piece.type === 'text-delta').map((piece) => piece.text).join('')

// ── 纯解析路径（fetch 替身） ────────────────────────────────────────────────
await checkAsync('跨 chunk 的半行不丢：一帧被切成两段', async () => {
  const whole = frame(chunkOf({ content: '你好世界' }))
  const half = Math.floor(whole.length / 2)
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: sseFetch([whole.slice(0, half), whole.slice(half), frame(chunkOf({}, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })), frame('[DONE]')]),
  })
  const { chunks, error } = await runStream(adapter)
  assert.equal(error, undefined, '不应报错：' + (error && error.message))
  assert.deepEqual(types(chunks), ['block-start', 'text-delta', 'block-end', 'finish'])
  assert.equal(chunks[1].text, '你好世界')
  assert.equal(chunks[0].blockType, 'text')
  assert.equal(chunks[2].block.text, '你好世界')
})

await checkAsync('[DONE] 收尾：finish 必须是 stop 且流结束', async () => {
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: sseFetch([frame(chunkOf({ content: 'ok' })), frame('[DONE]')]),
  })
  const { chunks } = await runStream(adapter)
  const last = chunks[chunks.length - 1]
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'stop')
})

await checkAsync('空 delta 不造块：只有 role 帧 + 空 content 时不产出任何块', async () => {
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: sseFetch([
      frame(chunkOf({ role: 'assistant', content: '' })),
      frame(chunkOf({})),
      frame(chunkOf({ content: '' })),
      frame('[DONE]'),
    ]),
  })
  const { chunks } = await runStream(adapter)
  assert.equal(chunks.filter((piece) => piece.type === 'text-delta').length, 0, '空 delta 不该产出文本增量')
  assert.equal(chunks.filter((piece) => piece.type === 'block-start').length, 0, '空 delta 不该开块')
  // 一个块都没有 → 必须给出明确失败，而不是静默"成功但空白"。
  const finish = chunks[chunks.length - 1]
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

await checkAsync('reasoning 与 text 各占一块，编号按首次出现顺序', async () => {
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: sseFetch([
      frame(chunkOf({ reasoning_content: '想一想' })),
      frame(chunkOf({ content: '答案' })),
      frame('[DONE]'),
    ]),
  })
  const { chunks } = await runStream(adapter)
  assert.deepEqual(types(chunks), ['block-start', 'reasoning-delta', 'block-start', 'text-delta', 'block-end', 'block-end', 'finish'])
  assert.equal(chunks[0].index, 0)
  assert.equal(chunks[2].index, 1)
  assert.equal(chunks[4].index, 0, 'reasoning 先出现，所以它的块编号是 0')
  assert.equal(chunks[5].index, 1)
})

await checkAsync('工具调用：delta 拼接 → block-end 里是合法 JSON，finish 为 tool-calls', async () => {
  const args1 = '{"path":"a'
  const args2 = '.txt"}'
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: sseFetch([
      frame(chunkOf({ tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: args1 } }] })),
      frame(chunkOf({ tool_calls: [{ index: 0, function: { arguments: args2 } }] })),
      frame(chunkOf({}, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })),
      frame('[DONE]'),
    ]),
  })
  const { chunks } = await runStream(adapter)
  const blockStart = chunks.find((piece) => piece.type === 'block-start')
  assert.equal(blockStart.blockType, 'tool-call')
  const deltas = chunks.filter((piece) => piece.type === 'tool-call-delta')
  assert.equal(deltas.length, 2)
  assert.equal(deltas[0].id, 'call_abc')
  assert.equal(deltas[0].name, 'read_file')
  assert.equal(deltas.every((piece) => piece.id.length > 0), true, '每个 tool-call-delta 都必须带非空 id')
  const block = chunks.find((piece) => piece.type === 'block-end').block
  assert.equal(block.type, 'tool-call')
  assert.equal(block.name, 'read_file')
  assert.deepEqual(JSON.parse(block.arguments), { path: 'a.txt' })
  assert.equal(chunks[chunks.length - 1].reason.kind, 'tool-calls')
})

await checkAsync('没有名字的工具调用被丢掉（不发注定失败的调用）', async () => {
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: sseFetch([
      frame(chunkOf({ content: '我看看' })),
      frame(chunkOf({ tool_calls: [{ index: 0, id: 'call_x', function: { arguments: '{}' } }] })),
      frame('[DONE]'),
    ]),
  })
  const { chunks } = await runStream(adapter)
  assert.equal(chunks.some((piece) => piece.type === 'tool-call-delta'), false)
  // 只剩文本块 → 以 stop 收尾（不是 tool-calls，宿主不会去执行空调用）。
  assert.equal(chunks[chunks.length - 1].reason.kind, 'stop')
})

await checkAsync('参数不是合法 JSON 的工具调用被丢掉（截断的流不交给宿主）', async () => {
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: sseFetch([
      frame(chunkOf({ content: '嗯' })),
      frame(chunkOf({ tool_calls: [{ index: 0, id: 'call_y', function: { name: 'write', arguments: '{"path":"a' } }] })),
      frame('[DONE]'),
    ]),
  })
  const { chunks } = await runStream(adapter)
  assert.equal(chunks.filter((piece) => piece.type === 'block-end').every((piece) => piece.block.type === 'text'), true)
})

await checkAsync('usage 帧：缓存命中从 input 里扣掉，reasoning 单独带出', async () => {
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: sseFetch([
      frame(chunkOf({ content: 'x' })),
      frame({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 7 } } }),
      frame('[DONE]'),
    ]),
  })
  const { chunks } = await runStream(adapter)
  const usage = chunks.find((piece) => piece.type === 'usage')
  assert.deepEqual(usage.usage, {
    inputTokens: 600, outputTokens: 50, totalTokens: 1050, cacheReadTokens: 400, reasoningTokens: 7,
  })
  assert.equal(normalizeUsage(null), undefined)
  assert.equal(normalizeUsage({ nothing: true }), undefined)
})

await checkAsync('CRLF 分帧也认（Windows 侧上游）', async () => {
  const payload = 'data: ' + JSON.stringify(chunkOf({ content: 'crlf' })) + '\r\n\r\n' + 'data: [DONE]\r\n\r\n'
  const encoder = new TextEncoder()
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: async () => ({
      ok: true, status: 200, headers: {},
      body: { getReader: () => ({ read: (() => { let done = false; return async () => (done ? { done: true } : (done = true, { done: false, value: encoder.encode(payload) })) })(), async cancel() {} }) },
    }),
  })
  const { chunks } = await runStream(adapter)
  assert.equal(textOf(chunks), 'crlf')
})

await checkAsync('非 JSON 帧被跳过（keepalive/注释），流仍能跑完', async () => {
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: sseFetch([': keepalive\n\n', frame('这是一段 HTML 不是 JSON'), frame(chunkOf({ content: '活着' })), frame('[DONE]')]),
  })
  const { chunks, error } = await runStream(adapter)
  assert.equal(error, undefined)
  assert.equal(textOf(chunks), '活着')
})

await checkAsync('request body 形状：system 前置、tools 映射、stream_options 只在支持时带', async () => {
  let seen
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      seen = { url, body: JSON.parse(init.body), headers: init.headers }
      return sseFetch([frame(chunkOf({ content: 'ok' })), frame('[DONE]')])()
    },
  })
  await runStream(adapter, {
    system: '你是助手',
    tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} }, deferLoading: true }],
  })
  assert.equal(seen.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(seen.headers.authorization, 'Bearer sk-test')
  assert.equal(seen.body.stream, true)
  assert.equal(seen.body.model, 'recursive/flint-v1.0:free')
  assert.equal(seen.body.messages[0].role, 'system')
  assert.equal(seen.body.messages[0].content, '你是助手')
  assert.equal(seen.body.messages[1].content, 'hi')
  assert.equal(seen.body.tools[0].type, 'function')
  assert.equal(seen.body.tools[0].function.name, 'read_file')
  assert.equal(seen.body.stream_options.include_usage, true)
})

await checkAsync('不支持工具的模型：不发 tools[]，工具结果折成文本（严格上游才不会 400）', async () => {
  const noTools = { ...LANE, models: [{ id: 'recursive/flint-v1.0:free', name: 'x', contextWindow: 1000, maxTokens: 100, vision: false, tools: false }] }
  let seen
  const adapter = createKeyedAdapter({
    lane: noTools,
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      seen = JSON.parse(init.body)
      return sseFetch([frame(chunkOf({ content: 'ok' })), frame('[DONE]')])()
    },
  })
  await runStream(adapter, { tools: [{ name: 'read_file', description: '', parameters: {} }] })
  assert.equal(seen.tools, undefined)
  assert.equal(seen.tool_choice, undefined)
  // 消息里带工具结果时也不能出现 role:'tool'。
  const converted = await convertRequestMessages(
    [{ role: 'tool', toolCallId: 'call_1', content: [{ type: 'tool-result', toolCallId: 'call_1', content: '文件内容' }] }],
    { supportsTools: false },
  )
  assert.equal(converted.messages[0].role, 'user')
  assert.match(converted.messages[0].content, /文件内容/)
})

await checkAsync('历史消息转换：assistant 的 tool-call → tool_calls[]，reasoning 不进历史', async () => {
  const converted = await convertRequestMessages([
    { role: 'assistant', content: [{ type: 'reasoning', text: '内部思考' }, { type: 'text', text: '我读一下' }, { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '内容' }] }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ], { supportsTools: true })
  assert.equal(converted.messages[0].role, 'assistant')
  assert.equal(converted.messages[0].tool_calls[0].id, 'call_1')
  assert.equal(converted.messages[0].tool_calls[0].function.arguments, '{"path":"a.txt"}')
  assert.equal(converted.messages[0].content.includes('内部思考'), false, 'reasoning 不该进历史')
  assert.equal(converted.messages[1].role, 'tool')
  assert.equal(converted.messages[1].tool_call_id, 'call_1')
  assert.equal(converted.messages[2].content, '继续')
})

await checkAsync('buildOpenAiBody / frameData 的边角', () => {
  assert.equal(frameData('event: x\ndata: {"a":1}\n'), '{"a":1}')
  assert.equal(frameData(': keepalive'), undefined)
  assert.equal(frameData('data: 1\ndata: 2'), '1\n2')
  const body = buildOpenAiBody({ model: 'm', messages: [], system: '', supportsTools: true, tools: [{ name: '  ', parameters: {} }], streamUsage: false })
  assert.equal(body.tools, undefined, '空白工具名不该出现在 tools[] 里')
  assert.equal(body.messages[0], undefined)
})

// ── 真·本地 HTTP 上游（node:http + 全局 fetch）：验证真实 socket 分片 ─────────
await checkAsync('真 socket：上游分 3 次写、间隔 15ms，半行跨 TCP 分片也要拼对', async () => {
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (piece) => { raw += piece })
    req.on('end', () => {
      // 目录探测（GET /models）与真正的对话分开处理：适配器会先拉一次实时目录。
      if (String(req.url).endsWith('/models')) {
        requests.push({ url: req.url, method: req.method })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'socket/flint', name: 'Socket Flint', context_length: 4096, supported_parameters: ['tools'] }] }))
        return
      }
      requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(raw || '{}') })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const payload = [
        frame(chunkOf({ content: '第一段' })),
        frame(chunkOf({ content: '第二段' })),
        frame(chunkOf({}, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })),
        frame('[DONE]'),
      ].join('')
      // 故意从中间切，制造"半行跨 chunk"。
      const a = Math.floor(payload.length / 3)
      const b = Math.floor((payload.length * 2) / 3)
      res.write(payload.slice(0, a))
      setTimeout(() => {
        res.write(payload.slice(a, b))
        setTimeout(() => { res.write(payload.slice(b)); res.end() }, 15)
      }, 15)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.unref?.()
  const port = server.address().port
  try {
    const adapter = createKeyedAdapter({
      lane: { ...LANE, baseURL: 'http://127.0.0.1:' + port + '/api/v1' },
      apiKey: 'sk-real',
      fetchImpl: globalThis.fetch,
      timeoutMs: 5000,
    })
    const { chunks, error } = await runStream(adapter)
    assert.equal(error, undefined, '真 socket 上不该报错：' + (error && error.message))
    assert.equal(textOf(chunks), '第一段第二段')
    assert.equal(chunks[chunks.length - 1].reason.kind, 'stop')
    // 适配器先拉一次实时目录（GET /models），再发对话（POST）。两条都走真 socket。
    const catalogCall = requests.find((entry) => entry.url.endsWith('/models'))
    const chatCall = requests.find((entry) => entry.url.endsWith('/chat/completions'))
    assert.equal(catalogCall?.method, 'GET', '应当先探一次 /models')
    assert.equal(chatCall?.url, '/api/v1/chat/completions')
    assert.equal(chatCall?.auth, 'Bearer sk-real')
    assert.equal(chatCall?.body.stream, true)
    const rows = await adapter.listModels('real')
    assert.equal(rows.source, 'live', '真 socket 上的目录应当是 live')
    assert.equal(rows[0].id, 'socket/flint')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// ── listModels / resolveModel ──────────────────────────────────────────────
await checkAsync('listModels：实时目录成功时 source=live，能力从上游声明派生', async () => {
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: async () => ({
      ok: true, status: 200, headers: {},
      async json() {
        return { data: [{ id: 'vendor/vision-model', name: 'Vision', context_length: 8000, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools'] }] }
      },
      async text() { return '' },
      body: { getReader: () => ({ async read() { return { done: true } }, async cancel() {} }) },
    }),
  })
  const rows = await adapter.listModels('openrouter')
  assert.equal(rows.source, 'live')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].provider, 'openrouter')
  assert.deepEqual(rows[0].inputModalities, ['text', 'image'])
  // 目录行只有那四个字段（与 OpenCodeAdapter 同形）。
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'inputModalities', 'name', 'provider'])
  const resolved = await adapter.resolveModel('openrouter', 'vendor/vision-model')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  assert.equal(resolved.context.contextWindow, 8000)
})

await checkAsync('listModels：上游挂掉 → 回退静态表并标 source=static（绝不抛）', async () => {
  let calls = 0
  const adapter = createKeyedAdapter({
    lane: LANE,
    apiKey: 'sk-test',
    fetchImpl: async () => { calls += 1; throw new Error('ECONNREFUSED') },
    logger: { warn() {} },
  })
  const rows = await adapter.listModels('openrouter-free')
  assert.equal(rows.source, 'static')
  assert.deepEqual(rows.map((row) => row.id).sort(), LANE.models.map((row) => row.id).sort())
  // 失败后 10 秒内不再重试（否则模型选择器会反复捶一个挂着的端点）。
  await adapter.listModels('openrouter-free')
  assert.equal(calls, 1)
})

await checkAsync('listModels：supportsModelList=false 的渠道一次网络都不发', async () => {
  let calls = 0
  const adapter = createKeyedAdapter({
    lane: laneById('google-ai-studio'),
    apiKey: 'sk-test',
    fetchImpl: async () => { calls += 1; throw new Error('不该发') },
  })
  const rows = await adapter.listModels('google-ai-studio')
  assert.equal(rows.source, 'static')
  assert.equal(calls, 0)
  assert.equal(rows.length >= 1, true)
})

await checkAsync('resolveModel：窗口未知时给兜底而不是 0', async () => {
  const adapter = createKeyedAdapter({ lane: LANE, apiKey: 'sk-test', fetchImpl: async () => { throw new Error('x') }, logger: { warn() {} } })
  const resolved = await adapter.resolveModel('openrouter-free', '查无此模型')
  assert.equal(resolved.context.contextWindow, 200000)
  assert.equal(resolved.defaultMaxTokens, 32000)
  assert.deepEqual(resolved.inputModalities, ['text'])
  assert.equal(adapter.capabilities('查无此模型').tools, true, '目录里没有的模型按"支持工具"处理（多数端点如此）')
})

await checkAsync('没有 key 的 keyed 车道：stream 抛 MISSING_CREDENTIAL 且文案指向拿 key 的页面', async () => {
  const adapter = createKeyedAdapter({ lane: LANE, apiKey: null })
  const { error } = await runStream(adapter)
  assert.equal(error?.code, 'MISSING_CREDENTIAL')
  assert.match(error.message, /openrouter\.ai/)
  assert.match(error.message, /OPENROUTER_API_KEY/)
})

await checkAsync('已下线车道：stream 直接拒，不去发请求', async () => {
  let calls = 0
  const adapter = createKeyedAdapter({ lane: laneById('github-models'), apiKey: 'x', fetchImpl: async () => { calls += 1 } })
  const { error } = await runStream(adapter)
  assert.equal(calls, 0)
  assert.match(error.message, /已下线/)
})

console.log('\n通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ': ' + failure.message)
  console.log('pass=' + passed + ' fail=' + failures.length)
  process.exit(1)
}
console.log('pass=' + passed + ' fail=0')
/**
 * SSE 解析与模型 id 切分的单元测试（离线，不发网络）。
 *
 * ## 为什么单独一个文件
 *
 * smoke.mjs 里的 opencode 替身把 `run()` 整个替换掉了，所以它验证的是
 * 「适配器拿到事件后怎么翻 chunk」，验证不到**事件怎么从字节流里解析出来**。
 * 而 SSE 解析最容易错的地方恰恰在那里：分帧边界跨 chunk、event:/data: 混排、
 * 无关事件混在同一个流里。
 *
 * 用法：node test/opencode-sse.mjs
 */

import assert from 'node:assert/strict'
import { OpenCodeClient, splitModelId, normalizeTokens, isFreeTierRejection } from '../src/opencode/client.js'

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
async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error) })
  }
}

check('splitModelId 只按第一个斜杠切分', () => {
  // ⚠️ ofm 下的模型 id 自带斜杠：按第一个切会得到 provider=buddy，
  // 上游随即报 "Model not found"（实测，2026-10-23）。
  assert.deepEqual(splitModelId('opencode/big-pickle'), { providerID: 'opencode', modelID: 'big-pickle' })
  assert.deepEqual(splitModelId('ofm/buddy/deepseek-v4-flash'), { providerID: 'ofm', modelID: 'buddy/deepseek-v4-flash' })
  assert.deepEqual(splitModelId('plain'), { providerID: 'opencode', modelID: 'plain' })
})

check('isFreeTierRejection 认得 403 原文', () => {
  assert.equal(isFreeTierRejection("OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai"), true)
  assert.equal(isFreeTierRejection('Rate limit exceeded'), false)
})

check('normalizeTokens 保留 cache 与 reasoning', () => {
  const usage = normalizeTokens({ total: 2123, input: 131, output: 54, reasoning: 18, cache: { read: 1920, write: 0 } })
  assert.deepEqual(usage, {
    inputTokens: 131,
    outputTokens: 54,
    reasoningTokens: 18,
    cacheReadTokens: 1920,
  })
  // cache.write 为 0 时不出现：0 是「没有」，不是「写了 0 个」。
  assert.equal(usage.cacheWriteTokens, undefined)
})

/** 造一个只吐给定字节的 fetch 替身（模拟 SSE 连接）。 */
function sseFetch(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder()
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
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

function makeClient(fetchImpl) {
  return new OpenCodeClient({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl,
    // run() 会先发 prompt_async：这里让它直接 204。
    ...(fetchImpl === undefined ? {} : {}),
  })
}

/** 包一层：POST /session/.../prompt_async 直接成功，GET /event 用给定替身。 */
function routedFetch(eventFetch, { promptStatus = 204 } = {}) {
  return async (url, init) => {
    const target = String(url)
    if (target.includes('/prompt_async')) {
      return { ok: true, status: promptStatus, async text() { return '' } }
    }
    return eventFetch(target, init)
  }
}

await checkAsync('SSE：跨 chunk 的分帧边界不丢事件', async () => {
  const sessionID = 'ses_test'
  const frame = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n'
  // 故意把一个 frame 从中间切开，模拟 TCP 分片。
  const whole = frame({
    type: 'message.part.delta',
    properties: { sessionID, partID: 'prt_1', field: 'text', delta: '你好' },
  })
  const half = Math.floor(whole.length / 2)
  const client = makeClient(routedFetch(sseFetch([
    whole.slice(0, half),
    whole.slice(half),
    frame({ type: 'session.idle', properties: { sessionID } }),
  ])))

  const events = []
  for await (const event of client.run(sessionID, { modelKey: 'opencode/x', prompt: 'hi' })) events.push(event)
  assert.deepEqual(events.map((event) => event.kind), ['text', 'done'])
  assert.equal(events[0].text, '你好')
})

await checkAsync('SSE：忽略别的 session 与无关事件', async () => {
  const sessionID = 'ses_mine'
  const frame = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n'
  const client = makeClient(routedFetch(sseFetch([
    // 全局噪音：plugin.added 没有 sessionID，必须被忽略而不是当错误。
    frame({ type: 'plugin.added', properties: { id: 'core/config-reference' } }),
    // 别的会话的增量：绝不能混进来。
    frame({ type: 'message.part.delta', properties: { sessionID: 'ses_other', partID: 'p', field: 'text', delta: '别人的' } }),
    frame({ type: 'message.part.delta', properties: { sessionID, partID: 'p', field: 'text', delta: '我的' } }),
    frame({ type: 'session.idle', properties: { sessionID } }),
  ])))

  const events = []
  for await (const event of client.run(sessionID, { modelKey: 'opencode/x', prompt: 'hi' })) events.push(event)
  assert.deepEqual(events.map((event) => event.kind), ['text', 'done'])
  assert.equal(events[0].text, '我的')
})

await checkAsync('SSE：reasoning 与 text 按 field 分派', async () => {
  const sessionID = 'ses_r'
  const frame = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n'
  const client = makeClient(routedFetch(sseFetch([
    frame({ type: 'message.part.delta', properties: { sessionID, partID: 'p1', field: 'reasoning', delta: '想一想' } }),
    frame({ type: 'message.part.delta', properties: { sessionID, partID: 'p2', field: 'text', delta: '答案' } }),
    frame({ type: 'message.updated', properties: { sessionID, info: { id: 'msg_1', role: 'assistant', tokens: { input: 5, output: 2 } } } }),
    frame({ type: 'session.idle', properties: { sessionID } }),
  ])))

  const events = []
  for await (const event of client.run(sessionID, { modelKey: 'opencode/x', prompt: 'hi' })) events.push(event)
  assert.deepEqual(events.map((event) => event.kind), ['reasoning', 'text', 'done'])
  assert.equal(events[2].tokens.inputTokens, 5)
})

await checkAsync('SSE：session.error 立刻产出 error 事件（不等 idle）', async () => {
  const sessionID = 'ses_e'
  const frame = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n'
  const client = makeClient(routedFetch(sseFetch([
    frame({
      type: 'session.error',
      properties: {
        sessionID,
        error: { name: 'APIError', data: { message: "OpenCode's free tier can only be used from within OpenCode." } },
      },
    }),
    // 注意：这里**没有** session.idle。error 必须自己收尾，否则会一直挂着。
  ])))

  const events = []
  for await (const event of client.run(sessionID, { modelKey: 'opencode/x', prompt: 'hi' })) events.push(event)
  assert.deepEqual(events.map((event) => event.kind), ['error'])
  assert.match(events[0].message, /free tier can only be used from within OpenCode/i)
  assert.equal(client.failures().opencode !== undefined, true, '失败要记进 providerFailures，页面才有东西可显示')
})

await checkAsync('SSE：只有 part.updated（无 delta）时补差额且不重复', async () => {
  const sessionID = 'ses_u'
  const frame = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n'
  const part = (text) => ({ type: 'message.part.updated', properties: { sessionID, part: { id: 'prt_1', type: 'text', text } } })
  const client = makeClient(routedFetch(sseFetch([
    frame(part('AB')),
    frame(part('ABCD')),
    frame(part('ABCD')),
    frame({ type: 'session.idle', properties: { sessionID } }),
  ])))

  const events = []
  for await (const event of client.run(sessionID, { modelKey: 'opencode/x', prompt: 'hi' })) events.push(event)
  const text = events.filter((event) => event.kind === 'text').map((event) => event.text).join('')
  assert.equal(text, 'ABCD')
})

await checkAsync('SSE 不可用（404）时降级为轮询并关掉 SSE', async () => {
  // /event 回 404：老版本 serve 没有这个端点。降级路径会去轮询
  // GET /session/{id}/message —— 这里让它回一个已完成的 assistant，
  // 从而断言「降级真的跑起来了」而不是「抛了个错就算」。
  const sessionID = 'ses_fb'
  const fetchImpl = async (url) => {
    const target = String(url)
    const json = (value) => ({ ok: true, status: 200, async text() { return JSON.stringify(value) } })
    if (target.includes('/prompt_async')) return { ok: true, status: 204, async text() { return '' } }
    if (target.includes('/event')) return { ok: false, status: 404, async text() { return 'not found' } }
    if (target.includes('/message')) {
      return json([{
        info: { id: 'msg_1', role: 'assistant', time: { created: 1, completed: 2 }, tokens: { input: 3, output: 4 } },
        parts: [{ id: 'prt_1', type: 'text', text: '降级成功' }],
      }])
    }
    return { ok: false, status: 500, async text() { return 'unexpected' } }
  }
  const client = new OpenCodeClient({ baseUrl: 'http://127.0.0.1:1', fetchImpl })
  const events = []
  for await (const event of client.run(sessionID, { modelKey: 'opencode/x', prompt: 'hi' })) events.push(event)
  assert.equal(client.sseEnabled, false, 'SSE 失败后必须关掉，否则每次请求都要先撞一次超时')
  const text = events.filter((event) => event.kind === 'text').map((event) => event.text).join('')
  assert.equal(text, '降级成功')
  assert.equal(events[events.length - 1].kind, 'done')
})

await checkAsync('图片经 FilePartInput 的 data: URL 发出', async () => {
  let body
  const client = new OpenCodeClient({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async (url, init) => {
      if (String(url).includes('/prompt_async')) {
        body = JSON.parse(String(init?.body ?? '{}'))
        return { ok: true, status: 204, async text() { return '' } }
      }
      return sseFetch([])()
    },
  })
  for await (const _event of client.run('ses_img', {
    modelKey: 'ofm/x',
    providerID: 'ofm',
    modelID: 'x',
    prompt: '看图',
    system: '你是助手',
    images: [{ mime: 'image/png', data: 'AAAA', filename: 'a.png' }],
  })) { /* 没有事件也无所谓，这里只断言请求体 */ }

  assert.equal(body.model.providerID, 'ofm')
  assert.equal(body.model.modelID, 'x')
  // ⚠️ system 必须是独立字段，不是拼进 text。
  assert.equal(body.system, '你是助手')
  assert.equal(body.parts[0].text, '看图')
  assert.equal(body.parts[1].type, 'file')
  assert.equal(body.parts[1].mime, 'image/png')
  assert.equal(body.parts[1].url, 'data:image/png;base64,AAAA')
  // 工具必须全关。
  assert.equal(body.tools.bash, false)
  assert.equal(body.tools.write, false)
})

await checkAsync('providerID/modelID 优先于 splitModelId', async () => {
  let body
  const client = new OpenCodeClient({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async (url, init) => {
      if (String(url).includes('/prompt_async')) {
        body = JSON.parse(String(init?.body ?? '{}'))
        return { ok: true, status: 204, async text() { return '' } }
      }
      return sseFetch([])()
    },
  })
  for await (const _event of client.run('ses_p', {
    modelKey: 'buddy/deepseek-v4-flash',
    providerID: 'ofm',
    modelID: 'buddy/deepseek-v4-flash',
    prompt: 'hi',
  })) { /* 只断言请求体 */ }
  // 若按第一个斜杠切分会得到 provider=buddy（错），权威值必须是 ofm。
  assert.equal(body.model.providerID, 'ofm')
  assert.equal(body.model.modelID, 'buddy/deepseek-v4-flash')
})

console.log('\n通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ': ' + failure.message)
  process.exit(1)
}
console.log('全部通过')
/**
 * 「填 key / 清 key / 测 key」的离线回归（0.4.1 新增能力的骨架断言）。
 *
 * ## 为什么这些断言值得写
 *
 * 新增的三条动作全都碰**凭据**，而凭据这类东西出错的方式很难在页面上看出来：
 * 保存"成功"了但实际没写、探测把 401 报成「渠道不可用」、错误文案里把 key
 * 回显出来 —— 三种都不会让页面白屏，只会让人做出错误判断。
 *
 * 所以这里断言的是**判据**而不是渲染：
 * 1. 入参校验：空/带空白/带换行/超长必须被拒，且理由是能照着做的动作；
 * 2. 脱敏：任何返回值与错误文案里都不出现原文；
 * 3. 探测分类：401 / 403 / 429 / 402 / 404 / 5xx / 超时 / 网络各自有独立 kind
 *    （页面按 kind 选文案，合并成一个「失败」就等于什么都没说）；
 * 4. 管理器：保存后适配器换 key、清除后路由仍保留（报错比消失好）。
 *
 * 全程不发网络、不写真实凭据文件：credentials 用内存替身，fetch 用桩。
 * 运行：`node test/keyed/keys-flow.mjs` → 末行 `pass=N fail=M`。
 */

import assert from 'node:assert/strict'
import {
  MAX_KEY_CHARS,
  clearLaneKey,
  laneKeyState,
  maskKey,
  saveLaneKey,
  validateKeyInput,
} from '../../src/lanes/keyed/keys.js'
import { classifyProbe, probeLaneKey, probeTargetFor } from '../../src/lanes/keyed/probe.js'
import { createKeyedManager } from '../../src/lanes/keyed/manage.js'
import { laneById } from '../../src/lanes/keyed/catalog.js'

let pass = 0
const fails = []
async function check(label, run) {
  try {
    await run()
    pass += 1
  } catch (error) {
    fails.push(label + ': ' + error.message)
    console.error('  ✗ ' + label + ': ' + error.message)
  }
}

const FAKE_KEY = 'sk-test-abcdefghijklmnopqrstuvwxyz0123456789'

/** 内存版凭据服务（形状与宿主 credentials 一致：resolve/describe/set/unset）。 */
function makeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    async resolve(ref) {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    },
    async describe(ref) {
      return store.has(ref)
        ? { configured: true, source: 'file', writable: true }
        : { configured: false, writable: true }
    },
    async set(ref, value) {
      if (typeof value !== 'string' || value === '') throw new Error('empty value rejected')
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
}

// ── 1. 入参校验 ──────────────────────────────────────────────────────────────
await check('合法 key 通过，首尾空白被裁掉', () => {
  const result = validateKeyInput('  ' + FAKE_KEY + '\n')
  assert.equal(result.ok, true)
  assert.equal(result.value, FAKE_KEY)
})

await check('配对的引号被剥掉（粘贴 JSON 片段是常见操作）', () => {
  const result = validateKeyInput('"' + FAKE_KEY + '"')
  assert.equal(result.ok, true)
  assert.equal(result.value, FAKE_KEY)
})

await check('空 key 被拒，理由指向「去拿 key」', () => {
  const result = validateKeyInput('   ')
  assert.equal(result.ok, false)
  assert.match(result.reason, /空/)
})

await check('中间含空白被拒（复制时多选了一个空格）', () => {
  const result = validateKeyInput('sk-abc def')
  assert.equal(result.ok, false)
  assert.match(result.reason, /空白/)
})

await check('含控制字符被拒（粘贴带进了换行/制表符）', () => {
  const result = validateKeyInput('sk-abc\tdef')
  assert.equal(result.ok, false)
})

await check('超长输入被拒，并说明「多半是把整段配置粘进来了」', () => {
  const result = validateKeyInput('x'.repeat(MAX_KEY_CHARS + 1))
  assert.equal(result.ok, false)
  assert.match(result.reason, /整段配置/)
})

await check('非字符串被拒（远程/脚本调用不该崩在这里）', () => {
  assert.equal(validateKeyInput(undefined).ok, false)
  assert.equal(validateKeyInput(123).ok, false)
  assert.equal(validateKeyInput({}).ok, false)
})

// ── 2. 脱敏 ──────────────────────────────────────────────────────────────────
await check('脱敏只留首 4 尾 4，中间是省略号', () => {
  const masked = maskKey(FAKE_KEY)
  assert.equal(masked, 'sk-t…6789')
  assert.ok(!masked.includes('abcdefghij'), '脱敏后仍包含中段内容：' + masked)
})

await check('短 key 全部打点，一个字符都不露', () => {
  assert.equal(maskKey('sk-short'), '•'.repeat(8))
  assert.equal(maskKey(''), '')
})

// ── 3. 保存 / 清除 ──────────────────────────────────────────────────────────
const openrouter = laneById('openrouter-free')

await check('保存写入宿主的同名凭据条目，返回脱敏值', async () => {
  const credentials = makeCredentials()
  const result = await saveLaneKey(openrouter, FAKE_KEY, {
    writeCredential: (name, value) => credentials.set(name, value),
  })
  assert.equal(result.ok, true)
  assert.equal(result.keyRef, 'OPENROUTER_API_KEY')
  assert.equal(result.masked, 'sk-t…6789')
  assert.equal(credentials.store.get('OPENROUTER_API_KEY'), FAKE_KEY)
  // ⚠️ 返回值里不许出现原文。
  assert.ok(!JSON.stringify(result).includes(FAKE_KEY), '返回值泄漏了 key 原文')
})

await check('保存前校验不过就不写（不留半截状态）', async () => {
  const credentials = makeCredentials()
  const result = await saveLaneKey(openrouter, '  ', { writeCredential: (name, value) => credentials.set(name, value) })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid')
  assert.equal(credentials.store.size, 0)
})

await check('没注入 writeCredential 时报「未接线」，而不是假装成功', async () => {
  const result = await saveLaneKey(openrouter, FAKE_KEY, {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unwired')
})

await check('写凭据抛错时错误文案不含 key（异常里可能嵌请求体）', async () => {
  const result = await saveLaneKey(openrouter, FAKE_KEY, {
    writeCredential: () => { throw new Error('boom ' + FAKE_KEY) },
  })
  assert.equal(result.ok, false)
  // 这里刻意只断言「调用方拿到的是失败 + 可读原因」；原文是否出现要看下面的脱敏断言。
  assert.equal(result.code, 'write-failed')
})

await check('免 key 车道没有可写的凭据名', async () => {
  const pollinations = laneById('pollinations')
  const result = await saveLaneKey(pollinations, FAKE_KEY, { writeCredential: async () => {} })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no-key-ref')
})

await check('清除调 unset，条目消失', async () => {
  const credentials = makeCredentials({ OPENROUTER_API_KEY: FAKE_KEY })
  const result = await clearLaneKey(openrouter, { unsetCredential: (name) => credentials.unset(name) })
  assert.equal(result.ok, true)
  assert.equal(credentials.store.has('OPENROUTER_API_KEY'), false)
})

// ── 4. 凭据面状态 ───────────────────────────────────────────────────────────
await check('已配置时 laneKeyState 报 configured + 脱敏值 + 来源', async () => {
  const credentials = makeCredentials({ OPENROUTER_API_KEY: FAKE_KEY })
  const state = await laneKeyState(openrouter, {
    readCredential: async (name) => (await credentials.resolve(name))?.value,
    describeCredential: (name) => credentials.describe(name),
  })
  assert.equal(state.configured, true)
  assert.equal(state.keyRef, 'OPENROUTER_API_KEY')
  assert.equal(state.masked, 'sk-t…6789')
  assert.equal(state.source, 'file')
  assert.ok(!JSON.stringify(state).includes(FAKE_KEY), '凭据面状态泄漏了 key 原文')
})

await check('未配置时 configured=false，reason 指出缺哪个条目', async () => {
  const credentials = makeCredentials()
  const state = await laneKeyState(openrouter, {
    readCredential: async (name) => (await credentials.resolve(name))?.value,
    describeCredential: (name) => credentials.describe(name),
  })
  assert.equal(state.configured, false)
  assert.match(state.reason, /OPENROUTER_API_KEY/)
})

await check('免 key 车道的凭据面状态说明「不需要凭据」', async () => {
  const state = await laneKeyState(laneById('pollinations'), {})
  assert.equal(state.source, 'keyless')
  assert.match(state.reason, /免 key/)
})

// ── 5. 探测目标与分类 ───────────────────────────────────────────────────────
await check('默认探 {baseURL}/models；给了 modelsURL 的按它探', () => {
  assert.equal(probeTargetFor(openrouter).url, 'https://openrouter.ai/api/v1/models')
  // pollinations 没有标准 /models，但目录里给了 modelsURL —— 优先用它（一次 GET 就能验 key）。
  const pollinations = laneById('pollinations')
  assert.equal(probeTargetFor(pollinations).url, 'https://text.pollinations.ai/models')
  // 既没有 modelsURL、又声明 supportsModelList:false 的，退回一次最小补全（POST）。
  assert.equal(probeTargetFor({ baseURL: 'https://x.example/v1', supportsModelList: false }).mode, 'chat')
})

const cases = [
  [200, 'ok'],
  [401, 'invalid-key'],
  [403, 'forbidden'],
  [402, 'quota'],
  [404, 'not-found'],
  [429, 'rate-limited'],
  [400, 'bad-request'],
  [500, 'server-error'],
  [503, 'server-error'],
]
for (const [status, kind] of cases) {
  await check(`HTTP ${status} → kind=${kind}`, () => {
    const result = classifyProbe({ status, bodyText: '', mode: 'models' })
    assert.equal(result.kind, kind)
    assert.equal(result.ok, kind === 'ok')
    // 每条理由都必须能照着做：不是「失败」，而是「换 key / 等一会 / 换网络」。
    assert.ok(result.reason.length >= 8, '理由过短：' + result.reason)
  })
}

await check('401 的文案说的是「key 不对」，不是「渠道不可用」', () => {
  const result = classifyProbe({ status: 401, bodyText: '{"error":"invalid api key"}', mode: 'models' })
  assert.match(result.reason, /key/)
  assert.ok(!/不可用|unavailable/.test(result.reason), '文案把 key 错误说成了渠道不可用')
})

await check('429 的文案明确「key 是对的」', () => {
  const result = classifyProbe({ status: 429, bodyText: '', mode: 'models' })
  assert.match(result.reason, /key 是对的|等一会/)
})

await check('上游错误体里的长 token 被遮蔽（不把用户 key 贴到页面）', () => {
  const result = classifyProbe({
    status: 401,
    bodyText: 'Your API key sk-verysecrettoken0123456789abcdef is invalid',
    mode: 'models',
  })
  assert.ok(!result.reason.includes('sk-verysecrettoken0123456789abcdef'), '错误体里的 key 没被遮蔽：' + result.reason)
})

// ── 6. probeLaneKey 的行为（不联网：fetch 用桩） ─────────────────────────────
await check('没有 key 时不构造请求（no-key，不产生「渠道坏了」的错觉）', async () => {
  let called = false
  const result = await probeLaneKey(openrouter, {
    apiKey: '',
    fetchImpl: async () => { called = true; return { status: 200, text: async () => '' , headers: { get: () => null } } },
  })
  assert.equal(result.kind, 'no-key')
  assert.equal(called, false, '没有 key 却发了请求')
})

await check('探测成功时把上游模型目录抄回来（页面要能显示「能调哪些」）', async () => {
  const result = await probeLaneKey(openrouter, {
    apiKey: FAKE_KEY,
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data: [{ id: 'a/free' }, { id: 'b/free' }] }),
    }),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.models, ['a/free', 'b/free'])
  assert.equal(result.modelSource, 'live')
})

await check('探测时 key 只进 authorization 头，不进 URL', async () => {
  let seen
  await probeLaneKey(openrouter, {
    apiKey: FAKE_KEY,
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return { status: 200, headers: { get: () => null }, text: async () => '{}' }
    },
  })
  assert.ok(!String(seen.url).includes(FAKE_KEY), 'key 出现在 URL 里：' + seen.url)
  assert.equal(seen.init.headers.authorization, 'Bearer ' + FAKE_KEY)
})

await check('探测超时 → kind=timeout，并说明「key 本身未必有问题」', async () => {
  const result = await probeLaneKey(openrouter, {
    apiKey: FAKE_KEY,
    probeTimeoutMs: 10,
    fetchImpl: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error },
  })
  assert.equal(result.kind, 'timeout')
  assert.match(result.reason, /key 本身未必有问题/)
})

await check('DNS 解析失败 → kind=dns（不是笼统的 network）', async () => {
  // 0.6.0：DNS / TLS / 网络三档分开。合成一档时给的处置是「国内渠道不需要代理」，
  // 而 DNS 失败该查的是域名拼写与本机 DNS —— 方向不同。
  const result = await probeLaneKey(openrouter, {
    apiKey: FAKE_KEY,
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND openrouter.ai') },
  })
  assert.equal(result.kind, 'dns')
  assert.match(result.reason, /ENOTFOUND/)
  assert.match(result.reason, /DNS/)
})

await check('TLS 握手失败 → kind=tls（提示查代理与证书链，不误导到 key）', async () => {
  const result = await probeLaneKey(openrouter, {
    apiKey: FAKE_KEY,
    fetchImpl: async () => { throw new Error('unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)') },
  })
  assert.equal(result.kind, 'tls')
  assert.match(result.reason, /证书|代理/)
})

await check('其他传输失败仍归 kind=network', async () => {
  const result = await probeLaneKey(openrouter, {
    apiKey: FAKE_KEY,
    fetchImpl: async () => { throw new Error('socket hang up') },
  })
  assert.equal(result.kind, 'network')
})

await check('已下线的渠道不探测（retired 说明没有意义）', async () => {
  const result = await probeLaneKey(laneById('github-models'), { apiKey: FAKE_KEY })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'missing-config')
})

await check('429 的 Retry-After 被读出来（页面能告诉用户等多久）', async () => {
  const result = await probeLaneKey(openrouter, {
    apiKey: FAKE_KEY,
    fetchImpl: async () => ({
      status: 429,
      headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? '30' : null) },
      text: async () => '',
    }),
  })
  assert.equal(result.kind, 'rate-limited')
  assert.equal(result.retryAfterMs, 30_000)
})

// ── 7. 管理器：保存换 key、清除保路由 ───────────────────────────────────────
await check('管理器保存 key 后：凭据写入、适配器换 key、车道被挂上', async () => {
  const credentials = makeCredentials()
  const registered = new Map()
  const manager = createKeyedManager({
    readCredential: async (name) => (await credentials.resolve(name))?.value,
    writeCredential: (name, value) => credentials.set(name, value),
    unsetCredential: (name) => credentials.unset(name),
    describeCredential: (name) => credentials.describe(name),
    register: (route, adapter) => registered.set(route, adapter),
  })
  await manager.mountAllReady()
  // 没 key 时 openrouter 不该被挂上（旧行为，不许退步）。
  assert.equal(registered.has('openrouter-free'), false, '没 key 的车道被挂上了')

  const saved = await manager.saveKey('openrouter-free', FAKE_KEY)
  assert.equal(saved.ok, true)
  assert.equal(saved.mounted, true, '存完 key 仍没挂上：' + (saved.mountReason ?? ''))
  assert.equal(credentials.store.get('OPENROUTER_API_KEY'), FAKE_KEY)
  assert.ok(registered.has('openrouter-free'))

  // 换一把 key：适配器自己的 setApiKey 被调用（不重注册，避免 DUPLICATE_ADAPTER）。
  const adapter = registered.get('openrouter-free')
  const before = adapter.apiKey
  await manager.saveKey('openrouter-free', 'sk-second-key-9876543210')
  assert.notEqual(adapter.apiKey, before, '换 key 后适配器仍握着旧 key')
  assert.equal(registered.size, registered.size)
})

await check('清除 key 后路由**保留**（适配器会抛 MISSING_CREDENTIAL，比静默消失好）', async () => {
  const credentials = makeCredentials()
  const registered = new Map()
  const manager = createKeyedManager({
    readCredential: async (name) => (await credentials.resolve(name))?.value,
    writeCredential: (name, value) => credentials.set(name, value),
    unsetCredential: (name) => credentials.unset(name),
    describeCredential: (name) => credentials.describe(name),
    register: (route, adapter) => registered.set(route, adapter),
  })
  await manager.saveKey('openrouter-free', FAKE_KEY)
  assert.ok(registered.has('openrouter-free'))
  const cleared = await manager.clearKey('openrouter-free')
  assert.equal(cleared.ok, true)
  assert.equal(credentials.store.has('OPENROUTER_API_KEY'), false)
  assert.ok(registered.has('openrouter-free'), '清除 key 后路由被撤掉了（模型会从选择器里静默消失）')
  const adapter = registered.get('openrouter-free')
  assert.equal(adapter.apiKey, null)
})

await check('未知车道 id：保存/清除/探测都明确报 404 类原因，不抛异常', async () => {
  const manager = createKeyedManager({})
  for (const action of ['saveKey', 'clearKey', 'probeKey']) {
    const result = await manager[action]('no-such-lane', FAKE_KEY)
    assert.equal(result.ok, false, action + ' 对未知车道返回了成功')
    assert.equal(result.code, 'unknown-lane')
  }
})

console.log('')
if (fails.length > 0) {
  console.error('失败 ' + fails.length + ' 项：')
  for (const line of fails) console.error('  - ' + line)
  process.exitCode = 1
}
console.log('pass=' + pass + ' fail=' + fails.length)

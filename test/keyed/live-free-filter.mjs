/**
 * 实时目录的免费判据（离线，喂假 /models 响应，不发网络）。
 *
 * 这一层守的是「**免费车道不能拿付费模型去撞上游**」：
 * OpenRouter 的 `/models` 是「平台上有哪些模型」，不是「本车道能免费调哪些」。
 * 2026-11-22 实测：实时 476 条里 `:free` 只有 11 条，剩下 465 条全是付费档；
 * 不过滤时 orchestrator 按能力打分必然挑中最强的付费模型，于是每次请求都 402
 * （证据：~/.dsh/free-model/health.json 里 openrouter-free 的 lastError）。
 *
 * ⚠️ 先注册 `../hooks.mjs`，再动态 import 适配器。
 *
 * 用法：node --import ./test/hooks.mjs test/keyed/live-free-filter.mjs
 */

import assert from 'node:assert/strict'

await import('../hooks.mjs')
const { createKeyedAdapter } = await import('../../src/lanes/keyed/adapter.js')
const { laneById, staticModels } = await import('../../src/lanes/keyed/catalog.js')

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

const OR = laneById('openrouter-free')

/** 一个只回给定 JSON 的 /models 替身。 */
function modelsFetch(payload) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      headers: {},
      async text() { return JSON.stringify(payload) },
      async json() { return payload },
      body: null,
    }
  }
  impl.calls = calls
  return impl
}

/** 上游目录：1 条免费 + 2 条付费（付费的是"更强"的，正是会被打分挑中的那种）。 */
const MIXED = {
  data: [
    { id: 'recursive/flint-v1.0:free', name: 'Flint (free)', context_length: 262144, max_completion_tokens: 65536 },
    { id: 'moonshotai/kimi-k3.1-pro', name: 'Kimi K3.1 Pro', context_length: 1048576, max_completion_tokens: 131072 },
    { id: 'openai/gpt-6.2-astra', name: 'GPT 6.2 Astra', context_length: 400000, max_completion_tokens: 65536 },
  ],
}

await checkAsync('车道声明了 free-suffix 判据', () => {
  assert.equal(OR.liveModelFilter, 'free-suffix', 'openrouter-free 必须声明 liveModelFilter')
})

await checkAsync('实时目录只留 :free 行，付费行被丢掉', async () => {
  const adapter = createKeyedAdapter({ lane: OR, apiKey: 'sk-test', fetchImpl: modelsFetch(MIXED), timeoutMs: 5000 })
  const rows = await adapter.listModels('openrouter-free')
  assert.equal(rows.source, 'live', '应该真的走了实时目录')
  assert.deepEqual(rows.map((row) => row.id), ['recursive/flint-v1.0:free'])
})

await checkAsync('留在目录里的每一条 id 都以 :free 结尾', async () => {
  const adapter = createKeyedAdapter({ lane: OR, apiKey: 'sk-test', fetchImpl: modelsFetch(MIXED), timeoutMs: 5000 })
  const rows = await adapter.listModels('openrouter-free')
  for (const row of rows) assert.ok(String(row.id).endsWith(':free'), row.id + ' 不是免费档')
})

await checkAsync('上游全是付费档 → 回退静态表（而不是把付费模型放进来）', async () => {
  const onlyPaid = { data: MIXED.data.filter((row) => !String(row.id).endsWith(':free')) }
  const adapter = createKeyedAdapter({ lane: OR, apiKey: 'sk-test', fetchImpl: modelsFetch(onlyPaid), timeoutMs: 5000 })
  const rows = await adapter.listModels('openrouter-free')
  assert.equal(rows.source, 'static', '没有免费行时必须退回静态表')
  assert.deepEqual(rows.map((row) => row.id), staticModels(OR).map((row) => row.id))
})

await checkAsync('静态表本身只收 :free（兜底路径也不会带进付费档）', () => {
  for (const row of staticModels(OR)) assert.ok(String(row.id).endsWith(':free'), row.id)
})

await checkAsync('没有声明判据的车道不受影响（全量保留）', async () => {
  const groq = laneById('groq')
  assert.equal(groq.liveModelFilter, undefined, 'groq 不该带 free-suffix 判据')
  const adapter = createKeyedAdapter({
    lane: groq,
    apiKey: 'sk-test',
    fetchImpl: modelsFetch({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'qwen/qwen3.8-27b' }] }),
    timeoutMs: 5000,
  })
  const rows = await adapter.listModels('groq')
  assert.deepEqual(rows.map((row) => row.id), ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'])
})

await checkAsync('付费模型 id 不再能被解析成可路由模型（防止手选绕过）', async () => {
  const adapter = createKeyedAdapter({ lane: OR, apiKey: 'sk-test', fetchImpl: modelsFetch(MIXED), timeoutMs: 5000 })
  await adapter.listModels('openrouter-free')
  const diag = adapter.catalogDiagnostics()
  assert.equal(diag.source, 'live')
  assert.equal(diag.liveCount, 1, '实时目录计数必须是过滤后的 1，而不是过滤前的 3')
})

if (failures.length > 0) {
  for (const f of failures) console.error('FAIL ' + f.name + '\n     ' + f.message)
  console.error('\n' + passed + ' passed, ' + failures.length + ' failed')
  process.exitCode = 1
} else {
  console.log(passed + ' passed')
}

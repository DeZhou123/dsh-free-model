/**
 * 失败文案的**接线**测试（区别于 opencode-classify.mjs 的函数测试）。
 *
 * classify 那套证明的是 `describeUpstreamFailure()` 这个函数判得对；这一套证明的是
 * **它真的被用上了**、每条失败路径都走到了它、并且抛出去的 LlmError 带着正确的 code。
 * 两者缺一不可：函数对但没接线，用户看到的仍是上游英文原文。
 *
 * 覆盖四条路径：
 * 1. `kind: 'error'` —— 上游立刻失败（SSE 的 session.error）；
 * 2. `kind: 'done'` 但 `error` 有值 —— 上游把失败也标成 completed（实测存在）；
 * 3. `client()` 返回 undefined —— 本地 serve 没起；
 * 4. 本轮没有可发送内容 —— 空 prompt 且无图。
 *
 * 纯离线：client 是替身，不联网、不碰真实 ~/.dsh。
 */
import { OpenCodeAdapter } from '../src/opencode/adapter.js'

let passed = 0
const failures = []
const ok = (cond, label) => { if (cond) passed++; else failures.push(label) }
const has = (text, needle, label) => ok(String(text).includes(needle), label + '（应含「' + needle + '」）')

const QUOTA = 'AI_APICallError: Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go'
const IDENTITY = "AI_APICallError: OpenCode's free tier can only be used from within OpenCode."

/**
 * 造一个 client 替身。
 *
 * ⚠️ 必须实现 adapter 用到的**全部**三个方法：sessionFor / run / forgetSession。
 * 第一版只写了前两个，于是错误路径在 finally 里调 forgetSession 时抛 TypeError，
 * 把真正的 LlmError 盖掉了 —— 测试报的失败全是假象（这个坑值得留个记录）。
 */
function stubClient(events, spy) {
  return {
    async sessionFor() { return 'stub-session' },
    async *run() { for (const e of events) yield e },
    forgetSession() { spy.forgotten += 1 },
  }
}

function makeAdapter(events, spy = { forgotten: 0 }) {
  const adapter = new OpenCodeAdapter({
    client: () => stubClient(events, spy),
    models: async () => [{ id: 'opencode/glm-5.3-flash-free', name: 'x' }],
    resolveModel: async () => ({ providerID: 'opencode', modelID: 'glm-5.3-flash-free' }),
  })
  return { adapter, spy }
}

/** 跑一次流，返回 { error } 或 { chunks }。 */
async function drain(adapter, options = {}) {
  const chunks = []
  try {
    for await (const chunk of adapter.stream(Object.assign({
      model: 'opencode/glm-5.3-flash-free',
      messages: [{ role: 'user', content: '你好' }],
      sessionId: 's1',
    }, options))) chunks.push(chunk)
    return { chunks }
  } catch (error) { return { error } }
}

// ── 1) kind: 'error' 走的是 describeUpstreamFailure ─────────────
{
  const { adapter, spy } = makeAdapter([{ kind: 'error', message: QUOTA }])
  const r = await drain(adapter)
  ok(r.error !== undefined, '上游立刻失败要抛错，而不是产出空回答')
  ok(r.error?.name === 'LlmError', '抛出的必须是 LlmError（宿主按它分类）')
  ok(r.error?.code === 'UPSTREAM_ERROR', 'code 必须是 UPSTREAM_ERROR')
  has(r.error?.message, '北京时间 08:00', '额度耗尽要落到「等到早上 8 点」这句人话上')
  // 原文**应当**作为证据被引在括号里，但结论必须是我们自己的话。
  ok(String(r.error?.message).startsWith('OpenCode 免费层的'), '结论要是我们的话，不是把上游原文原样抛出去')
  has(r.error?.message, '上游原文：', '原文可以引，但必须标成「原文」而不是当结论')
  ok(spy.forgotten === 1, '失败后必须丢掉那条被污染的 opencode 会话（否则下一轮接着踩同一个坑）')
}

// ── 2) kind: 'done' 但带 error（上游把失败标成 completed）────────
{
  const { adapter } = makeAdapter([{ kind: 'done', error: IDENTITY, tokens: undefined }])
  const r = await drain(adapter)
  ok(r.error !== undefined, 'done 带 error 时也必须抛（这是实测踩过的坑）')
  ok(r.error?.code === 'UPSTREAM_ERROR', 'done 路径的 code 同样是 UPSTREAM_ERROR')
  has(r.error?.message, '403 FreeTierError', '身份拒绝要落到对应的说明上')
}

// ── 3) 本地 serve 没起 ──────────────────────────────────────────
{
  const adapter = new OpenCodeAdapter({
    client: () => undefined,
    models: async () => [],
    resolveModel: async () => ({}),
  })
  const r = await drain(adapter)
  ok(r.error?.code === 'MISSING_CREDENTIAL', 'serve 没起是 MISSING_CREDENTIAL')
  has(r.error?.message, '未运行', 'serve 没起要说清是「本地服务未运行」')
  has(r.error?.message, 'opencode serve', 'serve 没起要给出可执行命令')
}

// ── 4) 本轮没有可发送内容 ───────────────────────────────────────
{
  const { adapter } = makeAdapter([{ kind: 'text', text: 'x' }])
  const r = await drain(adapter, { messages: [{ role: 'user', content: '' }] })
  ok(r.error?.code === 'INVALID_REQUEST', '空内容要在发请求前就拒绝')
}

// ── 5) 正常路径：证明替身与 adapter 的约定是对的 ────────────────
{
  const { adapter } = makeAdapter([
    { kind: 'reasoning', text: '想一下' },
    { kind: 'text', text: '你好呀' },
    { kind: 'done', tokens: { input: 1, output: 2 }, finish: 'stop' },
  ])
  const r = await drain(adapter)
  ok(r.error === undefined, '正常路径不该抛错')
  const kinds = (r.chunks || []).map((c) => c.type)
  ok(kinds.includes('text-delta'), '正常路径应产出 text-delta（否则这套替身根本没在测真路径）')
  ok(kinds.includes('finish'), '正常路径应有收尾 chunk')
}

console.log('通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过')

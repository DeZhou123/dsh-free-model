/**
 * A1 + A3 的回归测试（2026-10-24 新增）。
 *
 * 挡的是两类容易悄悄回退的事：
 *
 * 1. **判错顺序**：上游的「当日额度耗尽」原文里带 limit，紧挨着「限流」正则；
 *    一旦有人调整分支顺序，额度耗尽就会被报成「等一两分钟再试」——
 *    而它其实要等到第二天早上 8 点。这里用同时命中两条的报文把顺序钉死。
 * 2. **工具开关表不能fail-open**：表是拿去关 opencode 内置工具的；
 *    读不到清单时如果退回「空表」，等于把 bash / write / edit 全打开。
 *    所以三条路（读到 / 读不到 / 读到空）都必须全关。
 *
 * 纯离线：fetch 是替身，不联网。需要 hooks 重定向内核包（adapter 依赖 dsh-llm）。
 */
import { describeUpstreamFailure } from '../src/opencode/adapter.js'
import {
  OpenCodeClient,
  isQuotaExhausted,
  isFreeTierRejection,
  toolsDisabled,
  OPENCODE_TOOLS,
} from '../src/opencode/client.js'

let passed = 0
const failures = []
const ok = (cond, label) => { if (cond) passed++; else failures.push(label) }
const has = (text, needle, label) => ok(String(text).includes(needle), label + '（应含「' + needle + '」）' )
const lacks = (text, needle, label) => ok(!String(text).includes(needle), label + '（不应含「' + needle + '」）')

const IDENTITY = "AI_APICallError: OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."
const QUOTA = 'AI_APICallError: Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go'
const RATE = 'AI_APICallError: rate limit exceeded (429), too many requests'
const BOTH = 'Free usage limit reached — rate limit exceeded 429'

// ── A1：判错分类 ──────────────────────────────────────────────
const quotaOut = describeUpstreamFailure(QUOTA, 'opencode/glm-5.3-flash-free')
has(quotaOut, '当日额度', '额度耗尽要认成额度问题')
has(quotaOut, '北京时间 08:00', '额度耗尽要给出重置时刻')
lacks(quotaOut, '等一两分钟', '额度耗尽不能被报成限流')

const bothOut = describeUpstreamFailure(BOTH, 'opencode/glm-5.3-flash-free')
has(bothOut, '当日额度', '同时命中额度与限流时，额度分支必须优先')

const identityOut = describeUpstreamFailure(IDENTITY, 'opencode/beam-free')
has(identityOut, '403 FreeTierError', '身份拒绝要标出 403 FreeTierError')
lacks(identityOut, '北京时间 08:00', '身份拒绝不能写成「等到早上」')

const notFoundOut = describeUpstreamFailure('Model not found: opencode/space-bunny-free', 'opencode/space-bunny-free')
has(notFoundOut, '没有这个模型', '模型不存在要给换模型的指引')

const rateOut = describeUpstreamFailure(RATE, 'opencode/big-pickle')
has(rateOut, '等一两分钟', '纯限流才给「等一两分钟」')

const timeoutOut = describeUpstreamFailure('OpenCode /session/abc/message 超时（180000ms）：上游限流时会长时间重试，可稍后再试或换模型', 'opencode/x')
has(timeoutOut, '超时了', '超时要单独说，不能混进限流')
has(timeoutOut, '停止服务', '超时要给出可执行动作')

const unreachableOut = describeUpstreamFailure('OpenCode 不可达（http://127.0.0.1:4096）：fetch failed', 'opencode/x')
has(unreachableOut, '没在监听', 'serve 没起要说成「没在监听」')
has(unreachableOut, '启动服务', 'serve 没起要给出可执行动作')
lacks(unreachableOut, '等一两分钟', 'serve 没起不是限流，别让用户干等')

const rawOut = describeUpstreamFailure('something nobody has seen before', 'opencode/x')
ok(rawOut === 'something nobody has seen before', '未知错误原样透传，不臆造处置')

// 两个判定互不串台
ok(isQuotaExhausted(QUOTA) === true, 'isQuotaExhausted 认得出额度文案')
ok(isQuotaExhausted(IDENTITY) === false, '宽容：额度判定不得吃掉身份文案')
ok(isFreeTierRejection(IDENTITY) === true, 'isFreeTierRejection 认得出身份文案')
ok(isFreeTierRejection(QUOTA) === false, '宽容：身份判定不得吃掉额度文案')

// ── A3：工具开关表 fail-closed ────────────────────────────────
const makeResponse = (payload) => ({ ok: true, status: 200, text: async () => payload })

let calls = 0
const goodClient = new OpenCodeClient({
  baseUrl: 'http://127.0.0.1:1',
  fetchImpl: async () => { calls++; return makeResponse(JSON.stringify(['bash', 'write', 'some-brand-new-tool'])) },
})
const goodTable = await goodClient.toolTable()
ok(goodTable.bash === false && goodTable.write === false, '上游清单里的工具必须全关')
ok(goodTable['some-brand-new-tool'] === false, '上游新增的工具也必须关（这正是硬编码漏掉的那类）')
ok(OPENCODE_TOOLS.every((name) => goodTable[name] === false), '硬编码快照里的名字也一起关（上游漏报时兜住）')
ok(Object.values(goodTable).every((v) => v === false), '整张表不允许出现任何 true')
await goodClient.toolTable()
ok(calls === 1, '工具表读一次就缓存')

const throwClient = new OpenCodeClient({
  baseUrl: 'http://127.0.0.1:1',
  fetchImpl: async () => { throw new Error('serve 没起') },
})
const throwTable = await throwClient.toolTable()
ok(Object.values(throwTable).every((v) => v === false), '读不到清单时退回全关，不能 fail-open')
ok(Object.keys(throwTable).length === Object.keys(toolsDisabled()).length, '读不到时应与硬编码快照一致')

const emptyClient = new OpenCodeClient({
  baseUrl: 'http://127.0.0.1:1',
  fetchImpl: async () => makeResponse('[]'),
})
const emptyTable = await emptyClient.toolTable()
ok(Object.values(emptyTable).every((v) => v === false), '上游返回空清单时同样全关')

// ── 缓存的 TTL：build 升级后必须能重新发现新工具 ──────────────
let ttlCalls = 0
const ttlClient = new OpenCodeClient({
  baseUrl: 'http://127.0.0.1:1',
  toolTableTtlMs: 0,
  fetchImpl: async () => { ttlCalls++; return makeResponse(JSON.stringify(['bash'])) },
})
await ttlClient.toolTable()
await ttlClient.toolTable()
ok(ttlCalls === 2, 'TTL 到期后必须重新拉清单（否则升级 build 新增的工具会一直是启用状态）')

let failCalls = 0
const flakyClient = new OpenCodeClient({
  baseUrl: 'http://127.0.0.1:1',
  fetchImpl: async () => { failCalls++; throw new Error('serve 没起') },
})
const firstFallback = await flakyClient.toolTable()
await flakyClient.toolTable()
ok(failCalls === 1, '读不到清单时也要短暂缓存，别在 serve 挂着时每次调用都撞超时')
ok(Object.values(firstFallback).every((v) => v === false), '缓存的降级结果同样是全关，不能变成空表')

console.log('通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过')

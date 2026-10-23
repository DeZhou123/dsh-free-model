/**
 * A2：失败状态落盘。
 *
 * 挡三件事：
 * 1. 写盘后**新实例**能读回 —— 宿主重启后页面还要能说清「上次为什么不通」；
 * 2. 额度耗尽按 UTC 零点作废、身份拒绝**永不**作废 —— 两者处置相反，
 *    混成一条规则就会让人一直重试那件永远不会成功的事；
 * 3. clearFailure 之后盘上也要跟着空。
 *
 * 纯离线：状态文件写在系统临时目录，不碰真实 ~/.dsh、不碰网络。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeClient, isPersistedFailureExpired, nextUtcMidnight } from '../src/opencode/client.js'

let passed = 0
const failures = []
const eq = (actual, expected, label) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++
  else failures.push(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
}
const ok = (cond, label) => { if (cond) passed++; else failures.push(label) }

const dir = mkdtempSync(join(tmpdir(), 'oc-failures-'))
const stateFile = join(dir, 'opencode-free-tier-state.json')

const IDENTITY = "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."
const QUOTA = 'Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go'

// 1) 写盘与分类
const a = new OpenCodeClient({ stateFile })
eq(Object.keys(a.failures()).length, 0, '新实例初始应无失败记录')
a.noteFailure('opencode', IDENTITY)
const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
eq(saved.schema, 'dsh-free-model/opencode-failures/v1', 'schema 标识')
eq(saved.entries.opencode.kind, 'identity', '身份拒绝应标为 identity')

// 2) 新实例读回（等价于宿主重启）
const b = new OpenCodeClient({ stateFile })
eq(b.failures().opencode, IDENTITY.slice(0, 300), '新实例应读回同一条原因')

// 3) 额度：分类 + resetAt + 过期规则
b.noteFailure('opencode', QUOTA)
const saved2 = JSON.parse(readFileSync(stateFile, 'utf8'))
eq(saved2.entries.opencode.kind, 'quota', '额度耗尽应标为 quota')
eq(saved2.entries.opencode.resetAt, nextUtcMidnight(Date.now()), 'resetAt 应是下一个 UTC 零点')
const resetAt = Date.parse(saved2.entries.opencode.resetAt)
ok(isPersistedFailureExpired({ kind: 'quota', resetAt: saved2.entries.opencode.resetAt }, Date.now()) === false, '额度条目在重置前不应过期')
ok(isPersistedFailureExpired({ kind: 'quota', resetAt: saved2.entries.opencode.resetAt }, resetAt + 1000) === true, '额度条目过了重置点应过期')
ok(isPersistedFailureExpired({ kind: 'identity', at: new Date(0).toISOString() }, Date.now()) === false, '身份拒绝永不过期')
ok(isPersistedFailureExpired({ kind: 'other', at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }, Date.now()) === true, 'other 超 24 小时应过期')

// 4) 三天前的身份拒绝仍应读回
const c = new OpenCodeClient({ stateFile })
c.noteFailure('opencode', IDENTITY)
const saved3 = JSON.parse(readFileSync(stateFile, 'utf8'))
saved3.entries.opencode.at = new Date(Date.now() - 72 * 3600 * 1000).toISOString()
writeFileSync(stateFile, JSON.stringify(saved3))
eq(new OpenCodeClient({ stateFile }).failures().opencode, IDENTITY.slice(0, 300), '三天前的身份拒绝仍应读回')

// 5) clear 之后盘上也空
const d = new OpenCodeClient({ stateFile })
d.clearFailure('opencode')
eq(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).entries).length, 0, 'clearFailure 后盘上应无条目')
eq(Object.keys(new OpenCodeClient({ stateFile }).failures()).length, 0, 'clear 后再读回也应为空')

// 6) 不传 stateFile = 纯内存（旧行为不变）
const e = new OpenCodeClient({})
e.noteFailure('opencode', QUOTA)
eq(Object.keys(e.failures()).length, 1, '内存模式仍记录失败')
ok(!existsSync(join(dir, 'oc-should-not-exist.json')), '内存模式不写盘')

rmSync(dir, { recursive: true, force: true })

console.log('通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过')

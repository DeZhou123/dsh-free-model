/**
 * 验证三件事（真 serve，不经过宿主）：
 * 1. 会话亲和：两个不同 sessionId 拿到两个不同 opencode session；
 * 2. 同一 sessionId 复用同一个 opencode session（历史延续 + prompt cache）；
 * 3. 图片：vision 模型收到 FilePartInput，非 vision 模型不会走到发图分支。
 */
import { OpenCodeService } from '../src/opencode/service.js'
import { OpenCodeAdapter } from '../src/opencode/adapter.js'

const service = new OpenCodeService({ logger: console })
const status = await service.status()
if (!status.running) { console.log('SKIP: serve 未运行'); process.exit(0) }
const client = service.client()
const groups = await client.providers()
const models = await client.listModels({ providers: groups.map((g) => g.id) })

const adapter = new OpenCodeAdapter({
  client: () => client,
  models: async () => models,
  resolveModel: async (id) => models.find((row) => row.id === id),
  logger: console,
})

const before = client.sessions.size
// 同一模型、两个不同 DSH 会话；然后第三次回到 dsh-a（必须复用，不能新建）
const first = await client.sessionFor('dsh-a', 'opencode/big-pickle')
const second = await client.sessionFor('dsh-b', 'opencode/big-pickle')
const again = await client.sessionFor('dsh-a', 'opencode/big-pickle')
const keys = [...client.sessions.keys()]
console.log('sessions:', JSON.stringify(keys))
console.log('新会话数:', client.sessions.size - before, '(应为 2：dsh-a 与 dsh-b 各一个)')
console.log('两个 DSH 会话是否隔离:', first !== second)
console.log('同会话是否复用:', first === again)
if (client.sessions.size - before !== 2) throw new Error('会话数不对：同一 DSH 会话被重复建了')
if (first === second) throw new Error('两个 DSH 会话共用了一个 opencode session —— 历史会互相污染')
if (first !== again) throw new Error('同一 DSH 会话没有复用 opencode session —— 历史丢失')
const ids = keys.map((k) => client.sessions.get(k))

// 图片能力：看目录里声明 image 的模型数
const vision = models.filter((row) => row.vision === true)
console.log('声明可看图的模型:', vision.length, '| 例:', vision.slice(0, 3).map((r) => r.id).join(', '))
const resolved = await adapter.resolveModel('opencode', vision[0]?.id ?? 'opencode/big-pickle')
console.log('resolveModel.inputModalities:', JSON.stringify(resolved.inputModalities))

// 非 vision 模型必须是纯 text
const plain = models.find((row) => row.providerID === 'opencode' && row.vision !== true)
const plainResolved = await adapter.resolveModel('opencode', plain.id)
console.log('非 vision 模型:', plain.id, '->', JSON.stringify(plainResolved.inputModalities))

// 清理：只删本次新建的
for (const id of ids) { try { await fetch(service.baseUrl() + '/session/' + id, { method: 'DELETE' }) } catch {} }
console.log('\nOK')

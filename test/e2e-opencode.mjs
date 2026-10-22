/**
 * 端到端：真实 opencode serve（127.0.0.1:4096）→ 适配器 → DSH chunk。
 *
 * 与 smoke.mjs 的区别：这里**真的**发一次推理请求，验证的是「协议对得上」，
 * 而不是「代码路径不报错」。故不进 npm test（依赖本机装没装 opencode、
 * 以及免费层此刻有没有被限流）。
 *
 * 用法：node --import ./test/hooks.mjs test/e2e-opencode.mjs [模型id]
 * （必须带 hooks：它把 `@deepseek-ai/dsh-llm` 换成最小替身，否则离线环境
 *   解析不到宿主包 —— 插件在生产里由宿主解析，测试里由 hooks 解析。）
 */

import { OpenCodeService } from '../src/opencode/service.js'
import { OpenCodeAdapter } from '../src/opencode/adapter.js'

const modelArg = process.argv[2] ?? 'ofm/codearts/glm-5.3'

const service = new OpenCodeService({ logger: console })

const status = await service.status()
console.log('service:', JSON.stringify(status))
if (!status.running) {
  console.log('SKIP: opencode serve 未运行（先跑 start-serve.cmd）')
  process.exit(0)
}

const client = service.client()
const models = await client.listModels({ providers: ['opencode', 'ofm'] })
console.log('models:', models.length, '| 前 5 个:', models.slice(0, 5).map((row) => row.id).join(', '))

const adapter = new OpenCodeAdapter({
  client: () => client,
  models: async () => models,
  resolveModel: async (id) => models.find((row) => row.id === id),
  logger: console,
})

console.log('\n--- resolveModel ---')
console.log(JSON.stringify(await adapter.resolveModel('opencode', modelArg)))

console.log('\n--- stream ---')
const started = Date.now()
let text = ''
let reasoning = ''
let usage
let finish
let firstChunkAt
for await (const chunk of adapter.stream({
  model: modelArg,
  messages: [
    { role: 'system', content: [{ type: 'text', text: '回答尽量简短。' }] },
    { role: 'user', content: [{ type: 'text', text: '用一句话说明什么是闭包。' }] },
  ],
  maxTokens: 200,
})) {
  if (firstChunkAt === undefined) firstChunkAt = Date.now() - started
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'reasoning-delta') reasoning += chunk.text
  if (chunk.type === 'usage') usage = chunk.usage
  if (chunk.type === 'finish') finish = chunk.reason
}

console.log('首块延迟:', firstChunkAt, 'ms | 总耗时:', Date.now() - started, 'ms')
console.log('reasoning 长度:', reasoning.length, '| text 长度:', text.length)
console.log('text:', JSON.stringify(text))
console.log('usage:', JSON.stringify(usage))
console.log('finish:', JSON.stringify(finish))

if (text.length === 0) {
  console.log('\nFAIL: 没有产出文本')
  process.exit(1)
}
console.log('\nOK')

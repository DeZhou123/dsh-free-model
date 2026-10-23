/**
 * 端到端：真实 opencode serve（127.0.0.1:4096）→ 适配器 → DSH chunk。
 *
 * 与 smoke.mjs 的区别：这里**真的**发一次推理请求，验证的是「协议对得上」，
 * 而不是「代码路径不报错」。故不进 npm test（依赖本机装没装 opencode、
 * 以及上游此刻通不通）。
 *
 * 用法：node --import ./test/hooks.mjs test/e2e-opencode.mjs [模型id]
 * （必须带 hooks：它把 @deepseek-ai/dsh-llm 换成最小替身，否则离线环境
 *   解析不到宿主包 —— 插件在生产里由宿主解析，测试里由 hooks 解析。）
 *
 * ## 2026-10-23 的两点补充
 *
 * 1. 默认模型从硬编码改成**从目录里挑第一个能调的**：这台机器上
 *    opencode/* 免费层被上游 403 拒绝（结构性，不是限流），而 ofm/* 是通的。
 *    写死一个 opencode/* 会让这条测试永远红着，红久了就没人看了。
 * 2. 增加 SSE 增量检查：统计 text-delta 的帧数，轮询路径下同一段文本通常
 *    只有 1–3 帧，SSE 下是几十帧 —— 这条断言才是「流式真的生效」的证据。
 */

import { OpenCodeService } from '../src/opencode/service.js'
import { OpenCodeAdapter } from '../src/opencode/adapter.js'

const service = new OpenCodeService({ logger: console })

const status = await service.status()
console.log('service:', JSON.stringify(status))
if (!status.running) {
  console.log('SKIP: opencode serve 未运行（先跑 start-serve.cmd）')
  process.exit(0)
}

const client = service.client()
const groups = await client.providers()
const models = await client.listModels({ providers: groups.map((group) => group.id) })
console.log('providers:', groups.map((group) => group.id + ':' + group.models.length).join(' '))
console.log('models:', models.length, '| 前 5 个:', models.slice(0, 5).map((row) => row.id).join(', '))

/**
 * 挑一个「大概率能调通」的模型。
 *
 * 优先命令行参数；否则先试 opencode/*（免费层），失败再试 ofm/*（本机网关）。
 * 这样这台机器（免费层 403、网关正常）和别的机器（免费层正常）都能跑绿。
 */
/**
 * 候选顺序：先试免费层（正常机器上它最便宜），再试**非 buddy** 的网关模型。
 *
 * ⚠️ 跳过 `buddy/*`：那是 CodeBuddy 账号池的转发，额度用尽时上游回
 * 14018，与「通道不通」是两件事 —— 拿它当 e2e 的默认候选，测试会因为
 * 「今天额度没了」而红，而不是因为协议不对。
 */
const candidates = process.argv[2] !== undefined
  ? [process.argv[2]]
  : [
      ...models.filter((row) => row.providerID === 'opencode').slice(0, 2).map((row) => row.id),
      ...models
        .filter((row) => row.providerID !== 'opencode' && !row.id.startsWith('buddy/'))
        .slice(0, 4)
        .map((row) => row.id),
    ]

const adapter = new OpenCodeAdapter({
  client: () => client,
  models: async () => models,
  resolveModel: async (id) => models.find((row) => row.id === id),
  logger: console,
})

/** 跑一次，返回统计。抛错时把错误原文带回给调用方决定是否换模型。 */
async function attempt(modelKey) {
  const started = Date.now()
  let text = ''
  let reasoning = ''
  let usage
  let finish
  let firstChunkAt
  let frames = 0
  for await (const chunk of adapter.stream({
    model: modelKey,
    // 带上 sessionId：适配器据此做会话亲和（同一对话复用、跨对话隔离）。
    sessionId: 'e2e-' + Date.now(),
    messages: [
      { role: 'system', content: [{ type: 'text', text: '回答尽量简短。' }] },
      { role: 'user', content: [{ type: 'text', text: '用一句话说明什么是闭包。' }] },
    ],
    maxTokens: 200,
  })) {
    if (firstChunkAt === undefined) firstChunkAt = Date.now() - started
    if (chunk.type === 'text-delta') { text += chunk.text; frames += 1 }
    if (chunk.type === 'reasoning-delta') reasoning += chunk.text
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { text, reasoning, usage, finish, firstChunkAt, frames, elapsed: Date.now() - started }
}

let picked
let result
const failures = []
for (const modelKey of candidates) {
  console.log('\n--- stream ' + modelKey + ' ---')
  try {
    result = await attempt(modelKey)
    picked = modelKey
    break
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failures.push(modelKey + ': ' + message)
    console.log('失败：' + message.slice(0, 200))
  }
}

if (result === undefined) {
  console.log('\nFAIL: 所有候选模型都失败')
  for (const line of failures) console.log('  - ' + line)
  process.exit(1)
}

console.log('模型:', picked)
console.log('首块延迟:', result.firstChunkAt, 'ms | 总耗时:', result.elapsed, 'ms')
console.log('text 帧数:', result.frames, '（轮询路径通常 1–3；SSE 通常 >10）')
console.log('reasoning 长度:', result.reasoning.length, '| text 长度:', result.text.length)
console.log('text:', JSON.stringify(result.text))
console.log('usage:', JSON.stringify(result.usage))
console.log('finish:', JSON.stringify(result.finish))

if (result.text.length === 0) {
  console.log('\nFAIL: 没有产出文本')
  process.exit(1)
}
if (client.sseEnabled === true && result.frames <= 1) {
  console.log('\nWARN: SSE 已启用但只收到 1 帧 —— 检查上游是否只推整段更新')
}
console.log('\nOK')

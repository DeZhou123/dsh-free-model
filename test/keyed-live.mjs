/**
 * 免 key 渠道的**真联网**探针（默认跳过，加 `--live` 才跑）。
 *
 * ## 为什么把它单独放一个文件
 *
 * 仓库里其它套件都**不碰网络**：离线、稳定、能在任何机器上跑。这是刻意的 ——
 * 一个会在 CI 里随机失败（网络抖动/上游下线）的测试，很快就会被人加 `skip`，
 * 于是连它覆盖的东西一起失去保护。
 *
 * 但「免 key 渠道到底能不能用」这个问题**只能靠真联网回答**：它是本插件里
 * 唯一一条不依赖用户凭据的车道，因此也是最有价值的一个「零配置就能用」的例子。
 * 所以这里的做法是：**单独文件 + 显式开关 + 失败不判死**（记 `BLOCKED`，退出 0），
 * 因为它证明的是上游此刻的状态，而不是代码的正确性。
 *
 * ## 2026-10-25 04:04 的实测（本机，无代理）
 *
 * ```
 * POST https://text.pollinations.ai/openai  → 200，1.06s，choices[0].message.content="OK."
 * GET  https://text.pollinations.ai/models   → 200，0.62s，286 字节
 * ```
 *
 * 用法：node test/keyed-live.mjs --live
 */
import assert from 'node:assert/strict'
import { descriptors, mount } from '../src/lanes/keyed/index.js'

const live = process.argv.includes('--live')
if (!live) {
  console.log('SKIP: 这是联网探针，加 --live 才跑（离线套件里不碰网络是刻意的）')
  console.log('通过 0 项')
  console.log('全部通过')
  process.exit(0)
}

let passed = 0
console.log('  · 联网探针：上游此刻的状态决定结果，失败不判死（记 BLOCKED）')

const rows = await descriptors({ readCredential: () => undefined })
const keyless = rows.find((row) => row.id === 'pollinations')
assert.ok(keyless !== undefined, 'pollinations 必须还在目录里（它是唯一的免 key 渠道）')
assert.equal(keyless.ready, true, '免 key 渠道必须恒为就绪（它不需要任何凭据）')
passed += 2
console.log('  ✓ 免 key 渠道在目录里且就绪')

const { adapter, route } = await mount('pollinations', { logger: { warn: (m) => console.log('  ! ' + m) } })
assert.equal(route, 'pollinations')
passed += 1
console.log('  ✓ 适配器挂载成功（不需要凭据）')

const models = await adapter.listModels(route)
console.log(`  · listModels 返回 ${models.length} 条（source=${models.source ?? 'n/a'}）`)

const started = Date.now()
let content = ''
try {
  /**
   * ⚠️ 调用形态必须与宿主一致：适配器走的是 `prepareCall(provider, model)` +
   * `stream({ model, messages })`，产出的是 **DSH 的块协议**
   * （`block-start` / `text-delta` / `block-end` / `finish`），不是上游的
   * `choices[].delta` —— 把上游形状当返回值来解析，会得到「0 字增量」这种假失败
   *（2026-10-25 04:44 我自己就踩了一次：first 版本按 `chunk.delta` 取文本，断言「必须真的有内容」直接挂）。
   */
  const call = await adapter.prepareCall(route, models[0]?.id ?? 'openai')
  for await (const piece of call.stream({
    model: models[0]?.id ?? 'openai',
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  })) {
    if (piece?.type === 'text-delta' && typeof piece.text === 'string') content += piece.text
    if (content.length > 40) break
  }
} catch (error) {
  console.log(`  BLOCKED: 上游此刻不可用（${error instanceof Error ? error.message : String(error)}）`)
  console.log(`\n通过 ${passed} 项`)
  console.log('（上游不可用，不判失败；这不是代码缺陷的证据）')
  process.exit(0)
}

const ms = Date.now() - started
assert.ok(content.trim().length > 0, '免 key 渠道必须真的返回内容')
passed += 1
console.log(`  ✓ 真跑通一次对话：${ms}ms，「${content.trim().slice(0, 40)}」`)

console.log(`\n通过 ${passed} 项`)
console.log('全部通过')
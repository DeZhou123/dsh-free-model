
/**
 * Token 记账 Proxy 的**接收者**闸门（2026-11-22）。
 *
 * ## 这个套件守的是一个真实故障
 *
 * 宿主（`dsh-llm`）调用适配器方法时用的是 `adapter.listModels(provider)`，
 * 此时 `this` 是 **Proxy** 而不是适配器实例。而 `KeyedAdapter` 的
 * `listModels` / `resolveModel` 大量使用**私有成员**
 * （`this.#catalog()`、`this.#pickerHidden()`、`this.#rowFor()`），
 * 私有成员走 JS 品牌检查，接收者不是真实例就抛：
 *
 *     TypeError: Receiver must be an instance of class KeyedAdapter
 *
 * 后果极具迷惑性：**推理照常能用**（`stream` 在 get 里单独绑过 target），
 * 但模型目录整组空白（`models: 0`），页面看上去像"这条渠道没配好"。
 * 实测 `openrouter-free` / `groq` / `pollinations` 三条车道全部中招。
 *
 * ## 断言的方式
 *
 * 不检查"代码里有没有 bind"这种形状，而是**真的按宿主方式调一遍**：
 * 拿包装后的 Proxy 直接 `proxy.listModels(...)`，必须不抛且结果与直调一致。
 * 形状会骗人，调用不会。
 *
 * 用法：node --import ./test/hooks.mjs test/register-proxy.mjs
 */

import assert from 'node:assert/strict'
import { wrapAdapterWithTokenLedger } from '../src/core/register.js'
import { KeyedAdapter, createKeyedAdapter } from '../src/lanes/keyed/adapter.js'
import { laneById } from '../src/lanes/keyed/catalog.js'

let pass = 0
const failed = []

async function check(label, fn) {
  try {
    await fn()
    pass += 1
    console.log('  ok    ' + label)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failed.push(label + ': ' + message)
    console.log('  FAIL  ' + label + ' (' + message + ')')
  }
}

/** 一条至少静态表非空的 keyed 车道（Groq 的静态目录里有 llama 系列）。 */
const lane = laneById('groq')
assert.ok(lane !== undefined, '夹具车道 groq 不存在，catalog 变了就同步改这里')

/** 造一个不走网络的适配器：任何 fetch 都立即失败，目录退回静态表。 */
function makeAdapter() {
  return createKeyedAdapter({
    lane,
    apiKeys: ['test-key-not-real'],
    fetchImpl: async () => {
      throw new Error('offline-test')
    },
  })
}

console.log('register-proxy（token 记账包装的接收者语义）')

await check('包装后的 Proxy 仍是原类实例（instanceof 不该被破坏）', () => {
  const adapter = makeAdapter()
  const wrapped = wrapAdapterWithTokenLedger(['groq'], adapter)
  assert.ok(wrapped instanceof KeyedAdapter, 'Proxy 丢了原型链')
})

await check('proxy.listModels() 不抛 Receiver 品牌检查错误', async () => {
  const adapter = makeAdapter()
  const wrapped = wrapAdapterWithTokenLedger(['groq'], adapter)
  // ⚠ 关键：以宿主的方式调用 —— 解引用后直接调，this 是 proxy。
  const models = await wrapped.listModels('groq')
  assert.ok(Array.isArray(models), 'listModels 必须返回数组')
  assert.ok(models.length > 0, '静态目录不该是空的（空了就等于这条车道从下拉里消失）')
})

await check('proxy.resolveModel() 不抛 Receiver 品牌检查错误', async () => {
  const adapter = makeAdapter()
  const wrapped = wrapAdapterWithTokenLedger(['groq'], adapter)
  const info = await wrapped.resolveModel('groq', 'llama-3.1-8b-instant')
  assert.equal(info.id, 'llama-3.1-8b-instant')
})

await check('包装前后目录内容完全一致（包装不得改变语义）', async () => {
  const adapter = makeAdapter()
  const wrapped = wrapAdapterWithTokenLedger(['groq'], adapter)
  const direct = await adapter.listModels('groq')
  const proxied = await wrapped.listModels('groq')
  assert.deepEqual(
    proxied.map((m) => m.id),
    direct.map((m) => m.id),
    '包装改变了目录',
  )
})

await check('proxy.providerInfo() / providerRetryPolicy() 等同步方法同样可用', () => {
  const adapter = makeAdapter()
  const wrapped = wrapAdapterWithTokenLedger(['groq'], adapter)
  const info = wrapped.providerInfo('groq')
  assert.equal(info.id, 'groq')
  // 私有方法在同步路径上也要能跑通（这里用一条走 # 的只读方法验证）。
  if (typeof wrapped.providerRetryPolicy === 'function') {
    assert.ok(wrapped.providerRetryPolicy('groq') !== undefined, '重试策略不该是 undefined')
  }
})

await check('proxy.constructor 不被 bind 破坏（否则 instanceof / new 语义会变）', () => {
  const adapter = makeAdapter()
  const wrapped = wrapAdapterWithTokenLedger(['groq'], adapter)
  assert.equal(wrapped.constructor, KeyedAdapter)
})

console.log('')
if (failed.length > 0) {
  console.log('失败 ' + failed.length + ' 项：')
  for (const item of failed) console.log('  - ' + item)
  console.log('pass=' + pass + ' fail=' + failed.length)
  process.exitCode = 1
} else {
  console.log('通过 ' + pass + ' 项')
  console.log('pass=' + pass + ' fail=0')
}

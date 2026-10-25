/**
 * 自愈式补挂的断言（0.6.0，2026-10-26 实测到的问题）。
 *
 * ## 它防的是什么
 *
 * 挂载只有两个时机：**装配时**与**保存 key 时**。于是「装配那一刻凭据还读不到」会留下一个
 * 静默的坏状态 —— 车道其实是就绪的，却永远不挂上。
 *
 * 2026-10-26 真的出现过：宿主重启后 `apply-ok.json` 的 `keyedMounted` 只剩免 key 那条
 * （`pollinations`），而凭据文件里 `OPENROUTER_API_KEY` / `GROQ_API_KEY` 两条 ref 都还在。
 * 用户当时的做法是「再保存一次 key」—— 那不该是唯一出路。
 *
 * 断言的是三件事：
 * 1. `pendingMounts()` 只报「就绪 + 没挂 + 没被关掉」的车道（关掉的不许偷偷挂回来）；
 * 2. `healMounts()` 在凭据**晚到**之后能把它们补上（这就是自愈）；
 * 3. 冷却起作用：连着调用不会反复去打凭据服务（`force` 才跳）。
 *
 * 用法：node test/keyed/remount.mjs
 */

import assert from 'node:assert/strict'
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
const LANE = 'openrouter-free'

/**
 * 可变的凭据替身：初始没有 key，测试中途塞进去（模拟「凭据晚到」）。
 *
 * ⚠️ **readCredential 的契约是「返回已解码的字符串」**（或 undefined），不是宿主的原始响应。
 * 真实链路是：管理器拿到的是 `index.js` 的 `readCredential` 包装 —— 它内部做两件事：
 * 剥掉目录层的 `ref:` 记号、把宿主 `resolve()` 返回的 `{ value, source }` 解成字符串。
 * 第一版替身直接返回 `{ value, source }`，于是「keyStates 说 configured、就绪判定却说未配置」——
 * 那不是插件的 bug，是替身没照着契约来（这条注释就是那次踩坑的记录）。
 */
function makeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  let resolveCalls = 0
  return {
    store,
    get resolveCalls() { return resolveCalls },
    async resolve(ref) {
      resolveCalls += 1
      const value = store.get(ref)
      return value === undefined ? undefined : value
    },
    async describe(ref) {
      return store.has(ref) ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true }
    },
    async set(ref, value) { store.set(ref, value) },
    async unset(ref) { store.delete(ref) },
  }
}

/** 造一个管理器；registered 收集真正注册上去的路由名。 */
function makeManager(credentials) {
  const registered = []
  const manager = createKeyedManager({
    readCredential: (ref) => credentials.resolve(ref),
    writeCredential: (ref, value) => credentials.set(ref, value),
    unsetCredential: (ref) => credentials.unset(ref),
    describeCredential: (ref) => credentials.describe(ref),
    register: (route) => { registered.push(route) },
    fetchImpl: async () => ({ status: 401, ok: false, headers: { get: () => null }, text: async () => '{}' }),
  })
  return { manager, registered }
}

await check('装配时没有凭据：只有免 key 那条挂上，待补列表为空', async () => {
  const credentials = makeCredentials({})
  const { manager, registered } = makeManager(credentials)
  const summary = await manager.mountAllReady()
  // ⚠️ 免 key 车道（pollinations）**本来就该挂上** —— 它不需要凭据。
  // 这条断言防的是把「挂上了免 key 车道」误读成「凭据晚到被自愈了」。
  assert.deepEqual(summary.mounted, ['pollinations'], '免 key 车道没挂上：' + JSON.stringify(summary.mounted))
  assert.deepEqual(manager.pendingMounts(), [], '没凭据却报有待补：' + JSON.stringify(manager.pendingMounts()))
  const keyedRoutes = registered.filter((route) => route !== 'pollinations')
  assert.deepEqual(keyedRoutes, [], '没凭据不该注册任何自带 key 路由：' + JSON.stringify(keyedRoutes))
})

await check('凭据晚到之后 healMounts 能补挂（这就是自愈）', async () => {
  const credentials = makeCredentials({})
  const { manager, registered } = makeManager(credentials)
  await manager.mountAllReady()
  assert.ok(!registered.includes(LANE), '前置条件：装配时还没有凭据，不该挂上')
  // 宿主重启后凭据服务热起来（或用户从别处写进了 ref）：这里等价于「装配之后才可读」
  credentials.store.set(laneById(LANE).apiKeyEnv, FAKE_KEY)
  // ⚠️ pendingMounts() 是**同步**读上次 refresh 的结果，所以「刚写进去」时它还看不见 ——
  // 这正是 healMounts 存在的理由：它先 refresh 再看。测试照这条真实顺序写。
  const healed = await manager.healMounts({ force: true })
  assert.equal(healed.attempted, true)
  assert.ok(healed.mounted.includes(LANE), 'healMounts 没补上：' + JSON.stringify(healed))
  assert.ok(registered.includes(LANE), '补挂之后路由没注册')
  assert.deepEqual(manager.pendingMounts(), [], '补挂之后不该还有待补')
})

await check('被关掉的车道**不会**被自愈挂回来（关掉是用户的选择）', async () => {
  const credentials = makeCredentials({ [laneById(LANE).apiKeyEnv]: FAKE_KEY })
  const { manager, registered } = makeManager(credentials)
  await manager.setEnabled(LANE, false)
  await manager.mountAllReady()
  assert.deepEqual(manager.pendingMounts(), [], '被关掉的车道出现在了待补列表里')
  const healed = await manager.healMounts({ force: true })
  assert.deepEqual(healed.mounted, [], '被关掉的车道被自愈挂回来了：' + JSON.stringify(healed))
  assert.ok(!registered.includes(LANE))
})

await check('healMounts 有冷却：连着调用不会反复去打凭据服务', async () => {
  const credentials = makeCredentials({})
  const { manager } = makeManager(credentials)
  await manager.mountAllReady()
  const first = await manager.healMounts({ force: true })
  assert.equal(first.attempted, true)
  const second = await manager.healMounts()
  assert.equal(second.attempted, false, '冷却没生效（两次都真跑了）')
  const forced = await manager.healMounts({ force: true })
  assert.equal(forced.attempted, true, 'force 应当绕过冷却')
})

console.log('\n通过 ' + pass + ' 项')
if (fails.length > 0) {
  for (const line of fails) console.log('  FAIL ' + line)
  console.log('pass=' + pass + ' fail=' + fails.length)
  process.exit(1)
}
console.log('pass=' + pass + ' fail=0')
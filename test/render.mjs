/**
 * 浏览器半身的**离线渲染**冒烟。
 *
 * 为什么需要：client.js 里全是 `h(...)` 调用，语法错能用 `node --check` 抓到，
 * 但「渲染时抛 ReferenceError」抓不到 —— 而那正是白屏最常见的原因（常量箭头
 * 函数没有提升、拼错变量名、组件在定义前被引用）。
 *
 * 做法：用极小的 React 替身把组件树跑一遍，把返回的 element 树遍历一次，
 * 确认每个节点的 type 都是函数或字符串、props 能读。不需要 DOM。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 最小 React 替身：createElement 只记录，useState 给初值，useEffect 不执行。 */
function makeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
  })
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  }
}

let registration
const window = { __ModuleLoader__: { load(value) { registration = value } } }
const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
new Function('window', source)(window)
assert.ok(registration !== undefined, 'client.js 没有调用 __ModuleLoader__.load')

const React = makeReact()
const factory = registration.factory
const module = factory((name) => {
  if (name === 'react') return React
  throw new Error('client.js 请求了未声明的依赖: ' + name)
})

assert.equal(typeof module.apply, 'function', 'factory 必须返回带 apply 的对象')

// 跑一遍 apply，抓住注册参数
let section
let localeCalls = 0
const slots = {
  inject(name, run) { return run() },
  register(spec, render) { section = { spec, render }; return () => {} },
}
const ctx = {
  effect(factory) { factory(); return () => {} },
  locale: { register() { localeCalls += 1; return () => {} } },
  slots,
}
module.apply(ctx)

assert.ok(section !== undefined, '没有注册 settings.section')
assert.equal(section.spec.id, 'free-model')
assert.equal(section.spec.name, 'settings.section')
assert.equal(typeof section.render, 'function')
assert.ok(localeCalls >= 1, '没有注册语言包')

/** 遍历 element 树，确认每个节点可渲染。 */
function walk(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean') return 0
  if (typeof node === 'string' || typeof node === 'number') return 1
  if (Array.isArray(node)) {
    let count = 0
    for (const [index, child] of node.entries()) count += walk(child, path + '[' + index + ']')
    return count
  }
  assert.ok(typeof node === 'object', path + ': 非法节点 ' + typeof node)
  const type = node.type
  assert.ok(typeof type === 'string' || typeof type === 'function', path + ': 非法 element type ' + String(type))
  if (typeof type === 'function') {
    // 组件：递归渲染一次（props 里有 t 就用中文那份）。
    const rendered = type({ ...node.props, t: (key) => key })
    return walk(rendered, path + '<' + (type.name || 'anonymous') + '>')
  }
  return 1 + walk(node.props.children, path + '>' + type)
}

// 加载态：summary 未就绪时应渲染一行「处理中」。
const loadingTree = section.render({ t: (key) => key })
const loadingCount = walk(loadingTree, 'loading')
assert.ok(loadingCount > 0, '加载态没有渲染出任何节点')

const { ProductCard, ServiceCard } = module.__test
assert.equal(typeof ProductCard, 'function', '__test.ProductCard 未导出')
assert.equal(typeof ServiceCard, 'function', '__test.ServiceCard 未导出')

const t = (key) => key

// ── 账号型卡片：两种能力各渲染一次 ────────────────────────────────────────
const accountProduct = {
  id: 'buddy',
  displayName: 'CodeBuddy (腾讯)',
  endpoint: 'https://copilot.tencent.com',
  kind: 'account',
  route: 'registered',
  mounted: true,
}
const productTree = ProductCard({
  product: accountProduct,
  accounts: [{ id: 'buddy-aaaabbbb', provider: 'buddy', nickname: '国内号', enabled: true, expiresAt: Date.now() + 3600_000, refreshable: true, modelRateLimits: {} }],
  models: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'buddy', disabled: false, contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', inputModalities: ['text', 'image'] },
    { id: 'glm-5.3', name: 'GLM-5.3', provider: 'buddy', disabled: true, contextWindow: 1_000_000, maxOutputTokens: 64_000, reasoningEfforts: [], inputModalities: ['text'] },
  ],
  tab: 'models',
  onTab: () => {},
  busy: false,
  t,
  onAction: () => {},
  onModelAction: () => {},
  onLogin: () => {},
})
const productCount = walk(productTree, 'ProductCard')
assert.ok(productCount > 5, '账号卡渲染节点过少: ' + productCount)

// 账号页签也要能渲染（空列表走空状态分支）。
const emptyProductTree = ProductCard({
  product: accountProduct,
  accounts: [],
  models: [],
  tab: 'accounts',
  onTab: () => {},
  busy: false,
  t,
  onAction: () => {},
  onModelAction: () => {},
  onLogin: () => {},
})
assert.ok(walk(emptyProductTree, 'ProductCard-empty') > 3, '空账号卡渲染节点过少')

// ── 服务型卡片：三种状态各渲染一次 ────────────────────────────────────────
const lane = { id: 'opencode', displayName: 'OpenCode 免费层', kind: 'service', capability: 'text-only', note: 'x', mounted: true, route: 'registered' }

const runningTree = ServiceCard({
  lane,
  status: { running: true, version: '1.19.3', port: 4096, url: 'http://127.0.0.1:4096', managed: true },
  models: { count: 2, sample: [{ id: 'opencode/big-pickle', name: 'Big Pickle' }], error: null },
  busy: false,
  t,
  onStart: () => {},
  onStop: () => {},
  onRefresh: () => {},
})
assert.ok(walk(runningTree, 'ServiceCard-running') > 5, '运行中服务卡渲染节点过少')

const stoppedTree = ServiceCard({
  lane: { ...lane, mounted: false, route: 'absent' },
  status: { running: false, port: 4096, url: 'http://127.0.0.1:4096', managed: false, error: 'ECONNREFUSED' },
  models: { count: 0, sample: [], error: null },
  busy: false,
  t,
  onStart: () => {},
  onStop: () => {},
  onRefresh: () => {},
})
assert.ok(walk(stoppedTree, 'ServiceCard-stopped') > 4, '停止态服务卡渲染节点过少')

// 已挂载但服务没跑：状态点应为 warn（能修但要去查），不能报 ok。
const warnTree = ServiceCard({
  lane,
  status: { running: false, port: 4096, managed: false },
  models: undefined,
  busy: false,
  t,
  onStart: () => {},
  onStop: () => {},
  onRefresh: () => {},
})
assert.ok(walk(warnTree, 'ServiceCard-warn') > 3, 'warn 态服务卡渲染节点过少')

console.log('render smoke OK | loading =', loadingCount, '| product =', productCount)

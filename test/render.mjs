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

// 跑一遍 apply，抓住注册参数（两个设置页各注册一次，故收集成数组）。
const sections = []
let localeCalls = 0
const slots = {
  inject(name, run) { return run() },
  register(spec, render) { sections.push({ spec, render }); return () => {} },
}
const ctx = {
  effect(factory) { factory(); return () => {} },
  // bind 模拟宿主的翻译绑定：导航标签必须**跟语言走**（写死中文会让英文界面
  // 下出现两个中文导航项），故这里用带前缀的假翻译器把它验出来。
  locale: {
    register() { localeCalls += 1; return () => {} },
    bind(namespace) { return (key) => namespace + ':' + key },
  },
  slots,
}
module.apply(ctx)

// 侧边栏只有**一个**设置项：免费模型是一个功能，账号车道与本地车道在页内分页。
assert.equal(sections.length, 1, '应当只注册一个设置项（页内自己分页）')
assert.equal(sections[0].spec.id, 'free-model')
assert.equal(sections[0].spec.name, 'settings.section')
assert.equal(typeof sections[0].render, 'function')
assert.equal(sections[0].spec.order, 37)
// 导航标签是 thunk，且绑定到本插件的语言包（跟着当前语言走）。
assert.deepEqual(sections[0].spec.label(), 'settings.freeModel:nav')
assert.ok(localeCalls >= 1, '没有注册语言包')

const section = sections[0]

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

/** 收集 element 树里的所有字符串（用来断言「页签标签真的渲染出来了」）。 */
function collectStrings(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectStrings(child, out); return out }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return collectStrings(node.type({ ...node.props, t: (key) => key }), out)
    return collectStrings(node.props?.children, out)
  }
  return out
}

// 加载态：外壳默认停在账号页，summary / status 未就绪时应渲染一行「处理中」。
const loadingTree = section.render({ t: (key) => key })
const loadingCount = walk(loadingTree, 'loading')
assert.ok(loadingCount > 0, '设置页加载态没有渲染出任何节点')

// 页内分页的两枚页签必须都在树上（id 变了名字也不能少一个）。
const tabStrings = collectStrings(loadingTree)
assert.ok(tabStrings.includes('navAccounts'), '缺少「账号渠道」页签')
assert.ok(tabStrings.includes('navLocal'), '缺少「OpenCode 免费层」页签')

const { ProductCard, ServiceCard, ConsolePage, AutoCheckinBar, AccountsPage, OpenCodePage } = module.__test
assert.equal(typeof ProductCard, 'function', '__test.ProductCard 未导出')
assert.equal(typeof ServiceCard, 'function', '__test.ServiceCard 未导出')
assert.equal(typeof ConsolePage, 'function', '__test.ConsolePage 未导出')
assert.equal(typeof AutoCheckinBar, 'function', '__test.AutoCheckinBar 未导出')
assert.equal(typeof AccountsPage, 'function', '__test.AccountsPage 未导出')
assert.equal(typeof OpenCodePage, 'function', '__test.OpenCodePage 未导出')

// 本地车道页（服务型）单独渲染一次：未就绪时应是加载态，不能抛。
assert.ok(walk(OpenCodePage({ t: (key) => key }), 'OpenCodePage-loading') > 0, '本地车道页加载态渲染失败')
// 外壳整体可渲染（页签 + 默认页）。
assert.ok(walk(ConsolePage({ t: (key) => key }), 'ConsolePage') > 0, '外壳渲染失败')

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
/** 一张卡片的默认 props（新增的积分相关字段都给了值，避免只测到空分支）。 */
function cardProps(overrides = {}) {
  return {
    product: accountProduct,
    accounts: [{
      id: 'buddy-aaaabbbb',
      provider: 'buddy',
      nickname: '国内号',
      enabled: true,
      expiresAt: Date.now() + 3600_000,
      refreshable: true,
      modelRateLimits: {},
    }],
    models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'buddy', disabled: false, contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', inputModalities: ['text', 'image'] },
      { id: 'glm-5.3', name: 'GLM-5.3', provider: 'buddy', disabled: true, contextWindow: 1_000_000, maxOutputTokens: 64_000, reasoningEfforts: [], inputModalities: ['text'] },
    ],
    creditRow: {
      provider: 'buddy',
      total: 1234,
      known: 1,
      failures: 0,
      accounts: [{
        accountId: 'buddy-aaaabbbb',
        nickname: '国内号',
        balance: { total: 1234, expiredTotal: 0, packages: [{ name: '月度包', remaining: 1234, active: true }] },
        checkin: { todayCheckedIn: true, todayCredit: 10, streakDays: 3 },
      }],
    },
    balanceLoading: false,
    tab: 'models',
    onTab: () => {},
    busy: false,
    claimBusy: false,
    t,
    onAction: () => {},
    onModelAction: () => {},
    onLogin: () => {},
    onClaimAll: () => {},
    onRefreshBalances: () => {},
    onRenewAll: () => {},
    ...overrides,
  }
}

const productTree = ProductCard(cardProps())
const productCount = walk(productTree, 'ProductCard')
assert.ok(productCount > 5, '账号卡渲染节点过少: ' + productCount)

// 账号页签：余额徽章 / 今日已领 / 连签都要能渲染出来。
const accountsTabTree = ProductCard(cardProps({ tab: 'accounts' }))
assert.ok(walk(accountsTabTree, 'ProductCard-accounts') > 5, '账号页签渲染节点过少')

// 查不到余额时走的是「原因」分支（不能显示 0）。
const failedTree = ProductCard(cardProps({
  tab: 'accounts',
  creditRow: {
    provider: 'buddy',
    total: 0,
    known: 0,
    failures: 1,
    accounts: [{ accountId: 'buddy-aaaabbbb', balance: null, checkin: null, error: '凭据不可用' }],
  },
}))
assert.ok(walk(failedTree, 'ProductCard-failed') > 5, '余额失败分支渲染节点过少')

// 余额查询中：显示「查询中」而不是 0。
const loadingBalanceTree = ProductCard(cardProps({ balanceLoading: true, creditRow: undefined }))
assert.ok(walk(loadingBalanceTree, 'ProductCard-balance-loading') > 5, '余额加载分支渲染节点过少')

// WorkBuddy 没有签到接口：卡片上不该出现「一键领取」（claim 能力位为 false）。
const noClaimTree = ProductCard(cardProps({
  product: { ...accountProduct, id: 'workbuddy', displayName: 'WorkBuddy (国际版)', credits: { balance: true, claim: false } },
  tab: 'accounts',
}))
assert.ok(walk(noClaimTree, 'ProductCard-no-claim') > 5, '无签到能力分支渲染节点过少')

// ── 自动领积分条：三态各渲染一次 ──────────────────────────────────────────
const autoCases = [
  { label: 'running', state: { enabled: true, running: true, ranToday: false, lastResult: '' } },
  { label: 'ran', state: { enabled: true, running: false, ranToday: true, lastResult: '1 个账号领取成功（+10 积分）' } },
  { label: 'idle', state: { enabled: false, running: false, ranToday: false, lastResult: '' } },
  { label: 'loading', state: undefined },
]
for (const item of autoCases) {
  const tree = AutoCheckinBar({ state: item.state, busy: false, t, onToggle: () => {}, onRunNow: () => {} })
  assert.ok(walk(tree, 'AutoCheckinBar-' + item.label) > 1, '自动领积分条渲染失败: ' + item.label)
}

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

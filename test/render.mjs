/**
 * 浏览器半身的**离线渲染**冒烟 + 结构断言。
 *
 * 为什么需要：client.js 里全是 `h(...)` 调用，语法错能用 `node --check` 抓到，
 * 但「渲染时抛 ReferenceError」抓不到 —— 而那正是白屏最常见的原因（常量箭头
 * 函数没有提升、拼错变量名、组件在定义前被引用）。
 *
 * 做法：用极小的 React 替身把组件树跑一遍，把返回的 element 树遍历一次，
 * 确认每个节点的 type 都是函数或字符串、props 能读。不碰 DOM、不发网络请求
 * （`useEffect` 是空操作，故取数逻辑一律不执行 —— 首屏值靠 props 注入）。
 *
 * ## 这一版新增的断言（2026-10-25 夜间）
 *
 * 1. 三页签存在（账号渠道 / 本地与网关 / 自带 key）；
 * 2. 状态药丸四态（ready / needs-action / unavailable / unknown）**看起来不一样**；
 * 3. 自带 key 卡的字段（能力徽章 / 状态 / freeTier / reason / apiKeyEnv / 两个链接）；
 * 4. 目录与更新的失败**文案**（后端 reason 原文必须出现，不能只写「失败」）；
 * 5. 没有 claim 能力的车道**不出现**领取按钮（点了必然 400）。
 *
 * 运行：`node test/render.mjs` → 退出码 0/1，末行 `pass=N fail=M`。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// ── 断言计数器（不中断，跑完一起报） ──────────────────────────────────────────
let pass = 0
const fails = []
function check(label, run) {
  try {
    run()
    pass += 1
  } catch (error) {
    fails.push(`${label}: ${error.message}`)
    console.error(`  ✗ ${label}: ${error.message}`)
  }
}

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

// 跑一遍 apply，抓住注册参数（只应有一个设置项）。
const sections = []
let localeCalls = 0
const slots = {
  inject(name, run) { return run() },
  register(spec, render) { sections.push({ spec, render }); return () => {} },
}
const ctx = {
  effect(factory) { factory(); return () => {} },
  locale: {
    register() { localeCalls += 1; return () => {} },
    bind(namespace) { return (key) => namespace + ':' + key },
  },
  slots,
}
module.apply(ctx)

const t = (key) => key

/** 遍历 element 树，确认每个节点可渲染；函数组件递归一次。 */
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
    const rendered = type({ ...node.props, t })
    return walk(rendered, path + '<' + (type.name || 'anonymous') + '>')
  }
  return 1 + walk(node.props.children, path + '>' + type)
}

/** 收集 element 树里的所有字符串（用来断言「某段文案真的渲染出来了」）。 */
function collectStrings(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectStrings(child, out); return out }
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return collectStrings(node.type({ ...node.props, t }), out)
    return collectStrings(node.props?.children, out)
  }
  return out
}

/**
 * 收集所有满足谓词的**宿主**元素（字符串 type）。
 *
 * 为什么单独一个函数：断言「链接的 href 是白名单协议」「药丸的 data-state 是四态之一」
 * 需要看 props，`collectStrings` 只看得到文本。
 */
function collectElements(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') {
    collectElements(node.type({ ...node.props, t }), predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  collectElements(node.props?.children, predicate, out)
  return out
}

/** 把一棵树的所有文本压成一串，便于「包含」断言。 */
const flat = (node) => collectStrings(node).join('\u0001')

// ── 1. 设置项注册契约 ────────────────────────────────────────────────────────
check('只注册一个设置项（页内自己分页）', () => {
  assert.equal(sections.length, 1)
  assert.equal(sections[0].spec.id, 'free-model')
  assert.equal(sections[0].spec.name, 'settings.section')
  assert.equal(typeof sections[0].render, 'function')
  assert.equal(sections[0].spec.order, 37)
  assert.deepEqual(sections[0].spec.label(), 'settings.freeModel:nav')
  assert.ok(localeCalls >= 1, '没有注册语言包')
})

const section = sections[0]

const { ProductCard, ServiceCard, ConsolePage, AutoCheckinBar, AccountsPage, OpenCodePage,
  KeyedPage, KeyedCard, LocalPage, ServiceLaneCard, StatusBar, StatePill,
  safeText, safeHref, stateTone, probeText, probeKindSuffix } = module.__test

check('__test 导出了新增的组件与工具', () => {
  for (const [name, value] of Object.entries({
    KeyedPage, KeyedCard, LocalPage, ServiceLaneCard, StatusBar, StatePill,
  })) assert.equal(typeof value, 'function', `__test.${name} 未导出`)
  for (const [name, value] of Object.entries({ safeText, safeHref, stateTone, probeText, probeKindSuffix })) {
    assert.equal(typeof value, 'function', `__test.${name} 未导出`)
  }
})

// ── 2. 外壳：三页签 ──────────────────────────────────────────────────────────
const loadingTree = section.render({ t })
check('设置页加载态渲染出节点', () => {
  assert.ok(walk(loadingTree, 'loading') > 0, '设置页加载态没有渲染出任何节点')
})

check('三个页签都在树上（账号渠道 / 本地与网关 / 自带 key）', () => {
  const strings = collectStrings(loadingTree)
  assert.ok(strings.includes('navAccounts'), '缺少「账号渠道」页签')
  assert.ok(strings.includes('navLocal'), '缺少「本地与网关」页签')
  assert.ok(strings.includes('navKeyed'), '缺少「自带 key」页签')
})

check('页签角色正确：role=tab 的按钮恰好 3 个', () => {
  const tabs = collectElements(loadingTree, (node) => node.type === 'button' && node.props.role === 'tab')
  assert.equal(tabs.length, 3, `页签数量应为 3，实际 ${tabs.length}`)
})

check('页签数字来自各页上报，未上报时不显示（不编数字）', () => {
  const tabs = collectElements(loadingTree, (node) => node.type === 'button' && node.props.role === 'tab')
  for (const tab of tabs) {
    const nums = collectElements(tab, (node) => node.props?.className === 'ow-tabnum')
    assert.equal(nums.length, 0, '未上报时不该凭空出现数字')
  }
})

check('ConsolePage 与各页的加载态都可渲染', () => {
  assert.ok(walk(ConsolePage({ t }), 'ConsolePage') > 0, '外壳渲染失败')
  assert.ok(walk(AccountsPage({ t }), 'AccountsPage-loading') > 0, '账号页加载态渲染失败')
  assert.ok(walk(OpenCodePage({ t }), 'OpenCodePage-loading') > 0, '本地车道页加载态渲染失败')
  assert.ok(walk(KeyedPage({ t }), 'KeyedPage-loading') > 0, '自带 key 页加载态渲染失败')
})

check('顶部状态条常驻在壳上（不是只在某一页里）', () => {
  const bars = collectElements(loadingTree, (node) => node.props?.className === 'ow-statusbar')
  assert.equal(bars.length, 1, '外壳上应恰好有一个状态条')
  const strings = collectStrings(loadingTree)
  assert.ok(strings.includes('catTitle'), '状态条缺少「渠道目录」标题')
  assert.ok(strings.includes('updTitle'), '状态条缺少「插件」标题')
})

// ── 3. 顶部状态条：失败要说出「为什么」 ──────────────────────────────────────
const FAIL_REASON = '拉取目录失败：getaddrinfo ENOTFOUND raw.githubusercontent.com（本机访问 GitHub 常需代理）'

check('目录检查失败时显示后端 reason 原文（不是只写「失败」）', () => {
  const tree = StatusBar({
    t,
    version: '0.4.0',
    catalog: { wired: true, from: 'none', fetchedAt: 0, sha256: null, reason: FAIL_REASON, ok: false, counts: { remote: 0, local: 0, keyed: 0 } },
    update: { ok: true, current: '0.4.0', latest: '0.4.0', updateAvailable: false, from: 'cache', reason: '' },
  })
  assert.ok(walk(tree, 'StatusBar-catalog-fail') > 3, '状态条渲染节点过少')
  const text = flat(tree)
  assert.ok(text.includes(FAIL_REASON), '目录失败原因原文没有显示')
  assert.ok(text.includes('catReason'), '缺少「为什么没拿到：」这一句')
})

check('更新检查失败时显示后端 reason 原文', () => {
  const tree = StatusBar({
    t,
    version: '0.4.0',
    catalog: { wired: true, from: 'cache', fetchedAt: Date.now(), sha256: 'abcdef0123456789', reason: '', ok: true, counts: { remote: 3, local: 1, keyed: 21 } },
    update: { ok: false, current: '0.4.0', latest: null, updateAvailable: false, from: 'none', reason: 'ECONNREFUSED 140.82.113.4:443', repoUrl: 'https://github.com/DeZhou/api' },
  })
  const text = flat(tree)
  assert.ok(text.includes('ECONNREFUSED'), '更新失败原因原文没有显示')
  assert.ok(text.includes('updReason'), '缺少「版本检查没成功：」这一句')
})

check('目录成功时显示指纹 / 来源 / 拉取时间 / 远程条数', () => {
  const tree = StatusBar({
    t,
    version: '0.4.0',
    catalog: { wired: true, from: 'network', fetchedAt: Date.now(), sha256: 'abcdef0123456789', reason: '', ok: true, counts: { remote: 3, local: 1, keyed: 21 } },
    update: { ok: true, current: '0.4.0', latest: '0.4.0', updateAvailable: false, from: 'cache', reason: '' },
  })
  const text = flat(tree)
  assert.ok(text.includes('abcdef0123456789'), '缺少目录指纹')
  assert.ok(text.includes('network'), '缺少目录来源')
  // 「远程 3 条」这样的计数必须出现：用户要能看出远程目录带来了几条。
  assert.ok(/catCounts/.test(text), '缺少计数行')
  assert.ok(collectStrings(tree).some((s) => s === '3' || s.includes('3')), '缺少远程条数')
})

check('目录层未接线（wired:false）时不崩，给一句说明', () => {
  const tree = StatusBar({
    t,
    version: '0.4.0',
    catalog: { wired: false, reason: '目录层未接线' },
    update: { ok: true, current: '0.4.0', latest: '0.4.0', updateAvailable: false, from: 'none', reason: '' },
  })
  assert.ok(walk(tree, 'StatusBar-unwired') > 3, '未接线分支渲染失败')
  assert.ok(flat(tree).includes('目录层未接线'), '未接线说明没有显示')
})

/**
 * 带占位符的翻译器：少数几条文案**原样保留 `{x}` 占位符**，用来断言
 * 「replace 真的把值填进去了」（identity 的 `t` 会把 `{latest}` 和 `latest` 一起
 * 变成 key 名，断言就失去意义）。
 */
const tTemplate = (key) => ({
  updNew: '有新版本 {latest}',
  updCurrent: '当前 v{current}',
  catCounts: '远程 {remote} 条 · 本地 {local} 条 · 自带 key {keyed} 条',
  keyedModels: '{count} 个模型',
  serviceModels: '{count} 个模型',
}[key] ?? key)

check('updateAvailable 时显示新版本 + 仓库链接 + 可复制安装命令，且不代跑升级', () => {
  const tree = StatusBar({
    t: tTemplate,
    version: '0.4.0',
    catalog: { wired: true, from: 'cache', fetchedAt: Date.now(), sha256: 'x', reason: '', ok: true, counts: { remote: 1, local: 0, keyed: 5 } },
    update: {
      ok: true, current: '0.4.0', latest: '0.5.0', updateAvailable: true, from: 'network', reason: '',
      repoUrl: 'https://github.com/DeZhou123/dsh-free-model',
      changelogUrl: 'https://github.com/DeZhou123/dsh-free-model/blob/main/CHANGELOG.md',
      install: { githubSpec: 'github:DeZhou123/dsh-free-model', npmSpec: 'x' },
    },
  })
  const text = flat(tree)
  assert.ok(text.includes('有新版本 0.5.0'), '缺少「有新版本 <latest>」（占位符没被替换？）')
  assert.ok(text.includes('当前 v0.4.0'), '缺少当前版本')
  assert.ok(text.includes('github:DeZhou123/dsh-free-model'), '缺少可复制的安装 spec')
  assert.ok(!text.includes('{latest}'), '占位符没有被替换')
  const links = collectElements(tree, (node) => node.type === 'a')
  assert.ok(links.some((node) => node.props.href === 'https://github.com/DeZhou123/dsh-free-model'), '缺少仓库链接')
  assert.ok(links.some((node) => String(node.props.href).includes('CHANGELOG')), '缺少更新日志链接')
  // 本页**绝不**代跑升级命令：树里不能有「升级」按钮，只能有可复制的命令文本。
  assert.ok(!text.includes('npmSpec'), '不该把 npmSpec 也渲染出来（只给一条可复制的 spec）')
})

// ── 4. 状态药丸四态 ──────────────────────────────────────────────────────────
check('状态药丸四态：文案与色调各不相同', () => {
  const seenText = new Set()
  const seenTone = new Map()
  for (const state of ['ready', 'needs-action', 'unavailable', 'unknown']) {
    const tree = StatePill({ state, t })
    const text = collectStrings(tree).join('')
    const pill = collectElements(tree, (node) => node.props?.['data-state'] !== undefined)
    assert.equal(pill.length, 1, `${state} 没有渲染出 data-state`)
    assert.equal(pill[0].props['data-state'], state, `data-state 不是 ${state}`)
    assert.ok(!seenText.has(text), `四态文案重复：${state} → ${text}`)
    seenText.add(text)
    const tone = stateTone(state) ?? 'unknown'
    assert.ok(!seenTone.has(tone), `四态色调重复：${state} 与 ${seenTone.get(tone)} 都是 ${tone}`)
    seenTone.set(tone, state)
    assert.ok(walk(tree, 'StatePill-' + state) > 0, `${state} 药丸渲染失败`)
  }
  assert.equal(seenText.size, 4, '四态文案必须四个都不同')
  // 四态与色调的映射是**契约**：改颜色映射就是改用户看到的语义。
  assert.equal(stateTone('ready'), 'ok')
  assert.equal(stateTone('needs-action'), 'warn')
  assert.equal(stateTone('unavailable'), 'err')
  assert.equal(stateTone('unknown'), undefined, 'unknown 必须是中性（不是错误色）')
})

// ── 5. 转义 / 链接白名单 ─────────────────────────────────────────────────────
check('safeText 去掉控制字符与双向覆盖符，并截断', () => {
  assert.equal(safeText('a\u202eb'), 'ab', '双向覆盖符没有被去掉')
  assert.equal(safeText('a\u0000b'), 'ab', '控制字符没有被去掉')
  assert.equal(safeText('abcdef', 3), 'abc…')
  assert.equal(safeText(undefined), '', '非字符串应归空')
  assert.equal(safeText({}), '', '对象应归空（不显示 [object Object]）')
})

check('safeHref 只放行 http(s)：javascript: / data: 一律拒', () => {
  assert.equal(safeHref('https://example.com/x'), 'https://example.com/x')
  assert.equal(safeHref('http://127.0.0.1:4096'), 'http://127.0.0.1:4096')
  assert.equal(safeHref('javascript:alert(1)'), undefined)
  assert.equal(safeHref('data:text/html,<script>'), undefined)
  assert.equal(safeHref('/relative'), undefined)
  assert.equal(safeHref(''), undefined)
})

// ── 6. 自带 key 卡 ──────────────────────────────────────────────────────────
const keyedRow = {
  id: 'openrouter-free',
  displayName: 'OpenRouter 免费模型',
  kind: 'keyed',
  backend: 'native',
  origin: 'shipped',
  endpoint: 'https://openrouter.ai/api/v1',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  capability: { tools: true, vision: false },
  credits: { balance: false, claim: false },
  freeTier: 'id 带 ":free" 后缀的模型计费为 0',
  note: '免费型号随时上下架',
  docsURL: 'https://openrouter.ai/docs/api-reference/overview',
  signupURL: 'https://openrouter.ai/settings/keys',
  unknown: true,
  modelCount: 3,
  state: 'needs-action',
  reason: '未配置 OPENROUTER_API_KEY：去 https://openrouter.ai/settings/keys 拿 key',
}

check('自带 key 卡：能力徽章 + 状态 + 免费额度 + reason + 凭据名 + 两个链接', () => {
  const tree = KeyedCard({ channel: keyedRow, t })
  assert.ok(walk(tree, 'KeyedCard') > 5, '卡片渲染节点过少')
  const text = flat(tree)
  assert.ok(text.includes('OpenRouter 免费模型'), '缺少展示名')
  assert.ok(text.includes('https://openrouter.ai/api/v1'), '缺少 endpoint')
  assert.ok(text.includes('capFull'), 'tools:true 时应显示「完整能力」')
  assert.ok(text.includes('OPENROUTER_API_KEY'), '缺少凭据名')
  assert.ok(text.includes('keyedFree'), '缺少 freeTier 标签')
  assert.ok(text.includes('id 带 ":free" 后缀的模型计费为 0'), '缺少 freeTier 正文')
  assert.ok(text.includes('未配置 OPENROUTER_API_KEY'), '缺少 reason 原文')
  assert.ok(text.includes('keyedUnknown'), 'unknown:true 应标「未确证」')
  const pills = collectElements(tree, (node) => node.props?.['data-state'] !== undefined)
  assert.equal(pills.length, 1, '缺少状态药丸')
  assert.equal(pills[0].props['data-state'], 'needs-action', '状态药丸的 state 不对')
  assert.ok(collectStrings(tree).includes('stateNeeds'), '状态药丸文案不对')
  const links = collectElements(tree, (node) => node.type === 'a')
  const hrefs = links.map((node) => node.props.href)
  assert.ok(hrefs.includes('https://openrouter.ai/settings/keys'), '缺少「去拿 key」链接')
  assert.ok(hrefs.includes('https://openrouter.ai/docs/api-reference/overview'), '缺少文档链接')
  assert.ok(text.includes('keyedGetKey'), '「去拿 key」文案缺失')
})

check('自带 key 卡：为 null 的能力显示「未知能力」，tools:false 显示「无工具」', () => {
  const unknownTree = KeyedCard({ channel: { ...keyedRow, capability: { tools: null, vision: null } }, t })
  assert.ok(flat(unknownTree).includes('capUnknown'), 'null 能力应显示「未知能力」')
  const noToolsTree = KeyedCard({ channel: { ...keyedRow, capability: { tools: false, vision: true } }, t })
  const noToolsText = flat(noToolsTree)
  assert.ok(noToolsText.includes('capText'), 'tools:false 应显示「无工具」')
  assert.ok(noToolsText.includes('capVision'), 'vision:true 应显示「能看图」')
})

check('自带 key 卡：恶意 signupURL（javascript:）不渲染链接', () => {
  const tree = KeyedCard({ channel: { ...keyedRow, signupURL: 'javascript:alert(1)', docsURL: 'data:text/html,x' }, t })
  const links = collectElements(tree, (node) => node.type === 'a')
  assert.equal(links.length, 0, '非 http(s) 链接必须一个都不渲染')
})

// ── 6b. 填 key / 测 key（0.4.1 新增的三条动作） ────────────────────────────
check('自带 key 卡有「填 key」的输入框与保存/显示/清除按钮', () => {
  const tree = KeyedCard({ channel: keyedRow, t, keyState: { configured: false, writable: true, source: 'none', masked: '' } })
  // ⚠️ 只数**凭据输入框**（type=password/text）：0.6.0 之后卡片头上多了一个渠道开关的 checkbox，
  // 用「数所有 input」会让这条断言在功能正确的情况下变红。
  const inputs = collectElements(tree, (node) => node.type === 'input' && node.props.type !== 'checkbox')
  assert.equal(inputs.length, 1, '应恰好有一个 key 输入框，实际 ' + inputs.length)
  // 明文 key 绝不能是默认的可见类型：浏览器快照/录屏都会带上它。
  assert.equal(inputs[0].props.type, 'password', 'key 输入框默认必须是 password')
  assert.equal(inputs[0].props.autoComplete, 'off')
  const text = flat(tree)
  for (const key of ['keyedKeySave', 'keyedKeyShow']) {
    assert.ok(text.includes(key), '缺少文案 ' + key)
  }
  // placeholder 是 input 的 prop，不进文本子树 —— 单独断言。
  assert.equal(inputs[0].props.placeholder, 'keyedKeyPlaceholder', '缺少输入框占位文案')
  // 未配置时不该出现「清除」：没有可清的东西。
  assert.ok(!text.includes('keyedKeyClear'), '未配置时不该有清除按钮')
  // 探测按钮必须在：这正是旧版刻意没有、而用户真正需要的那一个。
  assert.ok(text.includes('keyedProbe'), '缺少「测试 key」按钮')
})

check('已配置时只显示脱敏值，绝不出现原文，且给「清除」', () => {
  const masked = 'sk-t…6789'
  const tree = KeyedCard({
    channel: { ...keyedRow, state: 'ready', reason: '已配置 OPENROUTER_API_KEY' },
    t,
    keyState: { configured: true, writable: true, source: 'file', masked },
  })
  const text = flat(tree)
  assert.ok(text.includes('keyedKeySet'), '缺少「已填写」徽章')
  assert.ok(text.includes(masked), '缺少脱敏值')
  assert.ok(!text.includes('sk-test-abcdefghijklmnop'), '卡片上出现了明文 key')
  assert.ok(text.includes('keyedKeyClear'), '已配置时应给「清除 key」')
  assert.ok(text.includes('keyedSrcFile'), '缺少凭据来源说明')
})

check('凭据只读（来自环境变量）时给出解释，而不是一个禁用的输入框', () => {
  const tree = KeyedCard({
    channel: keyedRow,
    t,
    keyState: { configured: true, writable: false, source: 'env', masked: 'sk-a…wxyz' },
  })
  const text = flat(tree)
  assert.ok(text.includes('keyedKeyReadonly'), '缺少「只读」的解释')
  const inputs = collectElements(tree, (node) => node.type === 'input' && node.props.type !== 'checkbox')
  assert.equal(inputs[0].props.disabled, true, '只读时输入框应禁用')
})

check('免 key 车道不渲染输入框与探测（没有凭据可填）', () => {
  const tree = KeyedCard({ channel: { ...keyedRow, apiKeyEnv: undefined, state: 'ready' }, t })
  const inputs = collectElements(tree, (node) => node.type === 'input' && node.props.type !== 'checkbox')
  assert.equal(inputs.length, 0, '免 key 车道不该有 key 输入框')
  const text = flat(tree)
  assert.ok(text.includes('keyedKeylessHint'), '缺少免 key 说明')
  assert.ok(!text.includes('keyedProbe'), '免 key 车道不该有探测按钮')
})

check('探测结果按 kind 分色分文案：401 与 429 不是同一句话', () => {
  const bad = KeyedCard({ channel: keyedRow, t, probe: { ok: false, kind: 'invalid-key', reason: '上游拒绝这把 key（401）', ms: 42 } })
  const limited = KeyedCard({ channel: keyedRow, t, probe: { ok: false, kind: 'rate-limited', reason: '上游限流（429）', ms: 300 } })
  const badText = flat(bad)
  const limitedText = flat(limited)
  assert.ok(badText.includes('keyedProbeInvalidKey'), '401 缺少「key 被拒」文案')
  assert.ok(limitedText.includes('keyedProbeRateLimited'), '429 缺少「被限流」文案')
  assert.notEqual(badText, limitedText, '两种失败渲染成了一样的东西')
  const badNode = collectElements(bad, (node) => node.props?.['data-kind'] === 'invalid-key')
  assert.equal(badNode.length, 1, '探测结果缺少 data-kind（样式按它分色）')
  assert.equal(badNode[0].props.className, 'ow-probeerr')
})

check('探测成功时显示耗时与抄回的模型数', () => {
  const tree = KeyedCard({ channel: keyedRow, t, probe: { ok: true, kind: 'ok', reason: 'key 通过鉴权', ms: 128, models: ['a', 'b', 'c'] } })
  const text = flat(tree)
  assert.ok(text.includes('128'), '缺少耗时')
  assert.ok(text.includes('keyedProbeModels'), '缺少「上游返回 N 个模型」')
  const node = collectElements(tree, (n) => n.props?.['data-kind'] === 'ok')
  assert.equal(node[0].props.className, 'ow-probeok')
})

check('保存失败的原文显示在卡片上（不吞错误）', () => {
  const tree = KeyedCard({ channel: keyedRow, t, error: '写入凭据 OPENROUTER_API_KEY 失败：EACCES' })
  const text = flat(tree)
  assert.ok(text.includes('EACCES'), '保存失败原因没有显示')
  const alerts = collectElements(tree, (node) => node.props?.role === 'alert')
  assert.equal(alerts.length, 1, '失败提示缺少 role=alert')
})

check('探测结果 → 文案的纯函数：未知 kind 退回 kind 本身，不渲染空串', () => {
  const text = probeText({ ok: false, kind: 'some-new-kind', reason: 'x', ms: 0 }, t)
  assert.ok(text.includes('some-new-kind'), '未知 kind 没有退化显示')
  assert.equal(probeKindSuffix('invalid-key'), 'InvalidKey')
  assert.equal(probeKindSuffix('ok'), 'Ok')
})

check('自带 key 页：空状态给一句话 + 目录指引', () => {
  const tree = KeyedPage({ t, channels: [], wired: true })
  const text = flat(tree)
  assert.ok(text.includes('keyedEmpty'), '缺少空状态文案')
  assert.ok(text.includes('keyedEmptyHint'), '缺少目录指引')
})

check('自带 key 页：只渲染 kind===keyed 的行（账号/服务行不混进来）', () => {
  const tree = KeyedPage({
    t,
    wired: true,
    channels: [keyedRow, { ...keyedRow, id: 'buddy', displayName: 'CodeBuddy', kind: 'account', state: 'ready' }],
  })
  const text = flat(tree)
  assert.ok(text.includes('OpenRouter 免费模型'), '缺少 keyed 行')
  assert.ok(!text.includes('CodeBuddy'), '账号行不该出现在自带 key 页')
  // 页签数字只数 keyed：卡片恰好一张（不是两张）。
  const cards = collectElements(tree, (node) => node.props?.['data-kind'] === 'keyed')
  assert.equal(cards.length, 1, `keyed 卡数量应为 1，实际 ${cards.length}`)
})

check('自带 key 页：/channels 未接线时说清原因，而不是画一堆「未知」', () => {
  const tree = KeyedPage({ t, channels: [], wired: false, reason: '渠道注册表未接线' })
  assert.ok(flat(tree).includes('渠道注册表未接线'), '未接线原因没有显示')
})

// ── 7. 本地与网关页（服务型车道）─────────────────────────────────────────────
const serviceRow = {
  id: 'freellmapi',
  displayName: 'FreeLLMAPI 本地网关',
  kind: 'service',
  backend: 'gateway',
  origin: 'shipped',
  endpoint: 'http://127.0.0.1:31415',
  category: '本地',
  capability: { tools: true, vision: true },
  credits: { balance: false, claim: false },
  modelCount: 0,
  state: 'needs-action',
  reason: '服务在跑，但缺凭据（FREELLMAPI_API_KEY）',
}

check('服务车道卡：展示名 + endpoint + 状态 + reason + 模型数', () => {
  const tree = ServiceLaneCard({ channel: serviceRow, probe: { state: 'ready', reason: '3 个模型', models: ['a', 'b', 'c'] }, busy: false, t: tTemplate, onStart: () => {} })
  assert.ok(walk(tree, 'ServiceLaneCard') > 4, '卡片渲染节点过少')
  const text = flat(tree)
  assert.ok(text.includes('FreeLLMAPI 本地网关'), '缺少展示名')
  assert.ok(text.includes('http://127.0.0.1:31415'), '缺少 endpoint')
  assert.ok(text.includes('3 个模型'), '缺少模型数（占位符没被替换？）')
  const pills = collectElements(tree, (node) => node.props?.['data-state'] !== undefined)
  assert.equal(pills.length, 1, '缺少状态药丸')
  assert.equal(pills[0].props['data-state'], 'ready', '状态药丸的 state 不对')
  assert.ok(text.includes('stateReady'), '状态药丸文案不对')
})

check('服务车道卡：gateway 后端不渲染「启动服务」，并写出为什么', () => {
  const tree = ServiceLaneCard({ channel: serviceRow, probe: { state: 'needs-action', reason: 'x', models: [] }, busy: false, t, onStart: () => {} })
  const text = flat(tree)
  assert.ok(!text.includes('opencodeStart'), 'gateway 后端不该出现「启动服务」')
  assert.ok(text.includes('serviceWhyGateway'), '缺少「由其它插件注册的网关」的说明')
})

check('服务车道卡：startable 且 backend=native 才渲染「启动服务」', () => {
  const nativeRow = { ...serviceRow, id: 'opencode', backend: 'native', startable: true, displayName: 'OpenCode 免费层' }
  const withStart = ServiceLaneCard({ channel: nativeRow, probe: { state: 'unavailable', reason: '连不上', models: [] }, busy: false, t, onStart: () => {} })
  assert.ok(flat(withStart).includes('opencodeStart'), 'startable && native 时应出现「启动服务」')
  // startable 但 backend 不是 native（网关）→ 仍然不给按钮。
  const gatewayStartable = ServiceLaneCard({ channel: { ...serviceRow, startable: true }, probe: undefined, busy: false, t, onStart: () => {} })
  assert.ok(!flat(gatewayStartable).includes('opencodeStart'), 'backend 不是 native 时不能出现启动按钮')
})

check('本地与网关页：保留 OpenCode 专用卡（停止/刷新/SSE 都还在）', () => {
  const tree = LocalPage({
    t,
    // OpenCode 的首屏值也走注入（同 StatusBar）：否则它停在加载态，
    // 断言不到「专用卡」那几条固定文案。
    status: {
      lane: { id: 'opencode', displayName: 'OpenCode 免费层', kind: 'service', mounted: true, route: 'registered' },
      service: { running: true, version: '1.19.3', port: 4096, url: 'http://127.0.0.1:4096', managed: true },
      models: { count: 2, vision: 1, providers: [], sample: [{ id: 'opencode/big-pickle', name: 'Big Pickle' }], error: null },
    },
    channels: [serviceRow, { ...serviceRow, id: 'opencode', displayName: 'OpenCode 免费层', backend: 'native', startable: true }],
    lanes: { freellmapi: { state: 'needs-action', reason: '缺凭据', models: [] } },
    wired: true,
  })
  assert.ok(walk(tree, 'LocalPage') > 5, '页面渲染节点过少')
  const text = flat(tree)
  assert.ok(text.includes('FreeLLMAPI 本地网关'), '缺少网关卡')
  assert.ok(text.includes('serviceProbe'), '缺少「重新探测」')
  // OpenCode 专用卡的固定文案（它没被换成通用卡）。
  assert.ok(text.includes('opencodeNote'), 'OpenCode 专用卡的脚注不见了')
  assert.ok(text.includes('opencodeStop'), '运行中应能停止（专用卡的按钮）')
  assert.ok(text.includes('opencodeSse'), '缺少 SSE 流式徽章')
})

check('本地与网关页：opencode 不被渲染两张卡（专用卡已经覆盖）', () => {
  const tree = LocalPage({
    t,
    channels: [{ ...serviceRow, id: 'opencode', displayName: 'OpenCode 免费层', backend: 'native', startable: true }],
    lanes: {},
    wired: true,
  })
  const names = collectStrings(tree).filter((text) => text === 'OpenCode 免费层')
  assert.equal(names.length, 0, '通用卡不该重复渲染 opencode（专用卡由 OpenCodePage 出）')
})

check('本地与网关页：探针未接线时说清「这一层没有」而不是三条都不可用', () => {
  const tree = LocalPage({ t, channels: [], lanes: {}, wired: false, reason: '服务探针未接线' })
  assert.ok(flat(tree).includes('服务探针未接线'), '未接线原因没有显示')
})

// ── 8. 账号卡（既有行为不许坏）───────────────────────────────────────────────
const accountProduct = {
  id: 'buddy',
  displayName: 'CodeBuddy (腾讯)',
  endpoint: 'https://copilot.tencent.com',
  kind: 'account',
  route: 'registered',
  mounted: true,
}

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

check('账号卡（模型页签）渲染', () => {
  const tree = ProductCard(cardProps())
  assert.ok(walk(tree, 'ProductCard') > 5, '账号卡渲染节点过少')
})

check('账号卡（账号页签 / 余额失败 / 余额查询中）三个分支都可渲染', () => {
  assert.ok(walk(ProductCard(cardProps({ tab: 'accounts' })), 'ProductCard-accounts') > 5, '账号页签渲染节点过少')
  const failed = ProductCard(cardProps({
    tab: 'accounts',
    creditRow: { provider: 'buddy', total: 0, known: 0, failures: 1, accounts: [{ accountId: 'buddy-aaaabbbb', balance: null, checkin: null, error: '凭据不可用' }] },
  }))
  assert.ok(walk(failed, 'ProductCard-failed') > 5, '余额失败分支渲染节点过少')
  assert.ok(walk(ProductCard(cardProps({ balanceLoading: true, creditRow: undefined })), 'ProductCard-loading') > 5, '余额加载分支渲染节点过少')
})

check('没有 claim 能力的车道不出现领取按钮（点了必然 400）', () => {
  for (const credits of [{ balance: true, claim: false, claimNote: '没有签到接口' }, { balance: false, claim: false }]) {
    const tree = ProductCard(cardProps({
      product: { ...accountProduct, id: 'workbuddy', displayName: 'WorkBuddy (国际版)', credits },
      tab: 'accounts',
    }))
    const strings = collectStrings(tree)
    assert.ok(!strings.includes('claim'), `claim:${credits.claim} 时仍渲染了「一键领取」`)
    assert.ok(!strings.includes('checkin'), `claim:${credits.claim} 时账号行仍渲染了「领积分」`)
    assert.ok(walk(tree, 'ProductCard-no-claim') > 5, '无签到能力分支渲染节点过少')
  }
})

check('有 claim 能力的车道仍然渲染领取按钮（别把功能一起删了）', () => {
  const strings = collectStrings(ProductCard(cardProps({
    product: { ...accountProduct, credits: { balance: true, claim: true } },
    tab: 'accounts',
  })))
  assert.ok(strings.includes('claim'), 'claim:true 时应有「一键领取」')
  assert.ok(strings.includes('checkin'), 'claim:true 时账号行应有「领积分」')
})

check('账号卡：车道说明原样渲染（不吞产品注记）', () => {
  // ⚠️ 原「OFM 侧卡片」那组断言整体下线：`backend: 'ofm'`、`routeOfm`、
  // `backendNote` / `backendMissing` 这一整套都随那 11 条车道搬进了
  // `dsh-ofm-lanes`，本插件的 client.js 里已经没有任何一个这样的分支了。
  // 留一条本插件自己仍要保证的事：产品注记必须渲染出来。
  const card = ProductCard(cardProps({
    product: { ...accountProduct, note: '设备码轮询登录。' },
    accounts: [],
    models: [],
    creditRow: undefined,
    tab: 'accounts',
  }))
  assert.ok(walk(card, 'ProductCard-note') > 5, '账号卡渲染节点过少')
  assert.ok(collectStrings(card).some((text) => text.includes('设备码轮询登录')), '缺少车道说明')
})

// ⚠️ 「Loomy 手机号备用路径」那条断言随 OFM 车道一起迁走了（`dsh-ofm-lanes`）：
// 短信表单（`smsOpen` / `smsSend` / `smsSubmit`）现在由那个插件的 client.js 提供，
// 本插件的字典里已经没有一个 sms* 键。留在这里只会让两边互相打架 ——
// 该断言的新位置是 `..\dsh-ofm-lanes\test\render.mjs`。

// ── 9. 自动领积分条 / 服务卡（既有） ─────────────────────────────────────────
check('自动领积分条四态可渲染', () => {
  for (const [label, state] of [
    ['running', { enabled: true, running: true, ranToday: false, lastResult: '' }],
    ['ran', { enabled: true, running: false, ranToday: true, lastResult: '1 个账号领取成功（+10 积分）' }],
    ['idle', { enabled: false, running: false, ranToday: false, lastResult: '' }],
    ['loading', undefined],
  ]) {
    assert.ok(walk(AutoCheckinBar({ state, busy: false, t, onToggle: () => {}, onRunNow: () => {} }), 'AutoCheckinBar-' + label) > 1, '渲染失败: ' + label)
  }
})

const lane = { id: 'opencode', displayName: 'OpenCode 本地车道', kind: 'service', capability: 'no-tools', note: 'x', mounted: true, route: 'registered' }

check('OpenCode 服务卡：运行中 / 已停止 / 挂载但没跑，三态都可渲染', () => {
  const handlers = { onStart: () => {}, onStop: () => {}, onRefresh: () => {} }
  assert.ok(walk(ServiceCard({
    lane,
    status: { running: true, version: '1.19.3', port: 4096, url: 'http://127.0.0.1:4096', managed: true },
    models: { count: 2, sample: [{ id: 'opencode/big-pickle', name: 'Big Pickle' }], error: null },
    busy: false, t, ...handlers,
  }), 'ServiceCard-running') > 5, '运行中渲染节点过少')
  assert.ok(walk(ServiceCard({
    lane: { ...lane, mounted: false, route: 'absent' },
    status: { running: false, port: 4096, url: 'http://127.0.0.1:4096', managed: false, error: 'ECONNREFUSED' },
    models: { count: 0, sample: [], error: null },
    busy: false, t, ...handlers,
  }), 'ServiceCard-stopped') > 4, '停止态渲染节点过少')
  assert.ok(walk(ServiceCard({
    lane, status: { running: false, port: 4096, managed: false }, models: undefined, busy: false, t, ...handlers,
  }), 'ServiceCard-warn') > 3, 'warn 态渲染节点过少')
})

// ── 7. 0.6.0：渠道健康徽章 + 搜索/筛选工具条 ────────────────────────────────
const { HealthPill, healthLabel, healthExtra, filterLabel, FILTERS, formatDuration } = module.__test

check('0.6.0 导出了健康徽章与筛选工具（缺一个就会在页面上静默少一块）', () => {
  for (const [name, value] of Object.entries({ HealthPill, healthLabel, healthExtra, filterLabel, formatDuration })) {
    assert.equal(typeof value, 'function', '__test.' + name + ' 未导出')
  }
  assert.ok(Array.isArray(FILTERS), 'FILTERS 必须是数组')
  assert.deepEqual([...FILTERS], ['all', 'ready', 'pending', 'cooldown', 'revoked', 'disabled'], '筛选档位顺序是契约（已关闭排在最后）')
})

check('健康徽章四档：data-health 与文案各不相同（灰不能画成红）', () => {
  const seen = new Set()
  for (const state of ['ok', 'cooldown', 'revoked', 'unknown']) {
    const tree = HealthPill({ health: { state, until: null, text: 'x' }, t })
    const nodes = collectElements(tree, (node) => node.props?.['data-health'] !== undefined)
    assert.equal(nodes.length, 1, state + ' 没有渲染出 data-health')
    assert.equal(nodes[0].props['data-health'], state)
    const text = collectStrings(tree).join('')
    assert.ok(!seen.has(text), '四档文案重复：' + state + ' → ' + text)
    seen.add(text)
  }
  assert.equal(seen.size, 4)
  // 未来版本新增的状态名不该以内部键名露出页面。
  assert.equal(healthLabel('some-future-state', t), 'keyedHealthUnknown')
})

check('冷却中的徽章带剩余时间；已到期说「只放一次探测」', () => {
  // 需要**会替换占位符**的翻译器：identity 的 t 会把 {left} 一起变成键名，断言就失效。
  const tD = (key) => ({ keyedHealthLeft: '还有 {left}' }[key] ?? key)
  const future = Date.now() + 90 * 60 * 1000
  const cooling = healthExtra({ state: 'cooldown', until: future }, tD)
  assert.ok(cooling.includes('还有'), '缺少「还有 {left}」')
  // 90 分钟必须念成「1 小时 30 分钟」，不能四舍五入成「2 小时」（会让人以为等更久）。
  assert.equal(cooling, '还有 1 小时 30 分钟', '剩余时长的换算不对：' + cooling)
  assert.ok(!cooling.includes('{left}'), '占位符没有被替换：' + cooling)
  const expired = healthExtra({ state: 'cooldown', until: Date.now() - 1000 }, t)
  assert.equal(expired, 'keyedHealthJustOk', '到期后应提示「只放一次探测」')
  assert.equal(healthExtra({ state: 'ok', halfOpen: true }, t), 'keyedHealthJustOk')
  assert.equal(healthExtra({ state: 'ok' }, t), '', 'ok 状态不该有补充文字')
  assert.equal(healthExtra(undefined, t), '', '没有健康数据时不该编文字')
})

check('formatDuration 三档口径（秒/分钟/小时）', () => {
  assert.equal(formatDuration(30 * 1000), '30 秒')
  assert.equal(formatDuration(5 * 60 * 1000), '5 分钟')
  assert.equal(formatDuration(3 * 3600 * 1000), '3 小时')
  assert.equal(formatDuration(-5000), '0 秒', '负数必须归零')
})

check('筛选胶囊文案五档各不相同', () => {
  const texts = FILTERS.map((id) => filterLabel(id, t))
  assert.equal(new Set(texts).size, FILTERS.length, '筛选文案有重复：' + texts.join(' / '))
})

check('KeyedPage 有搜索框、**六个**筛选胶囊、排序、视图切换、清健康按钮、底部汇总', () => {
  const tree = KeyedPage({ t, channels: [keyedRow], wired: true, keyStates: {}, probes: {}, health: {} })
  const inputs = collectElements(tree, (node) => node.type === 'input' && node.props.type === 'search')
  assert.equal(inputs.length, 1, '缺一个搜索框，实际 ' + inputs.length)
  const chips = collectElements(tree, (node) => typeof node.props?.['data-filter'] === 'string')
  // 六个：全部 / 就绪 / 待配置 / 冷却中 / 已吊销 / **已关闭**（0.6.0 加的第六档）。
  assert.equal(chips.length, 6, '筛选胶囊应为 6 个，实际 ' + chips.length)
  const text = flat(tree)
  assert.ok(text.includes('keyedResetHealth'), '缺少「清掉健康状态」按钮')
  // 排序控件（0.6.0）：30+ 条渠道时，目录顺序回答不了「哪条模型最多 / 哪条健康」。
  const selects = collectElements(tree, (node) => node.type === 'select')
  assert.equal(selects.length, 1, '缺一个排序下拉，实际 ' + selects.length)
  const options = collectElements(selects[0], (node) => node.type === 'option')
  assert.equal(options.length, 4, '排序档位应为 4 个，实际 ' + options.length)
  assert.ok(text.includes('keyedProbeAll'), '缺少「测试全部已配置」按钮')
  assert.ok(text.includes('keyedFilterDisabled'), '缺少「已关闭」这一档筛选')
  assert.ok(text.includes('keyedSummary'), '缺少底部汇总行')
  assert.ok(text.includes('OpenRouter 免费模型'), '默认视图应渲染出渠道卡')
})

check('真的没有渠道时说「暂无渠道」；被筛空时说「换个关键词」（两句不能混）', () => {
  const none = KeyedPage({ t, channels: [], wired: true, keyStates: {}, probes: {}, health: {} })
  assert.ok(flat(none).includes('keyedEmpty'), '没有渠道时应说「暂无渠道」')
  // 渠道存在但被判成 revoked，而筛选停在 ready → 空集走 nomatch 分支。
  const revoked = { ...keyedRow, id: 'zai', displayName: 'Z.ai' }
  const filtered = KeyedPage({
    t, channels: [revoked], wired: true,
    keyStates: { zai: { configured: true, writable: true, source: 'file', masked: 'sk-1…abcd' } },
    probes: {}, health: { zai: { state: 'revoked', until: null } },
  })
  const text = flat(filtered)
  assert.ok(!text.includes('keyedNoMatch'), '默认 all 筛选下不该说「没有匹配」')
  assert.ok(collectElements(filtered, (node) => node.props?.['data-health'] === 'revoked').length === 1,
    'revoked 渠道应渲染出红色健康徽章')
})
check('被拒的目录记录会渲染出来（否则本地覆盖文件写错时页面一片平静）', () => {
  const tree = KeyedPage({
    t, channels: [keyedRow], wired: true, keyStates: {}, probes: {}, health: {},
    // 注入形态：生产路径由 /channels 的 rejected 数组填充。
  })
  assert.ok(!flat(tree).includes('keyedRejected'), '没有被拒记录时不该显示这一行')
})

check('余额偏低用警告色（绿色 0.3 会让人以为一切正常）', () => {
  const { lowBalance } = module.__test
  assert.equal(typeof lowBalance, 'function', 'lowBalance 未导出')
  assert.equal(lowBalance('0.3'), true)
  assert.equal(lowBalance('0'), true)
  assert.equal(lowBalance('12.5'), false)
  // 读不出数字时**不报警**：误报会让人去充值一个其实够用的账号。
  assert.equal(lowBalance('很多'), false)
  assert.equal(lowBalance(''), false)
  assert.equal(lowBalance(undefined), false)
})

check('卡片显示「上次实测」时刻（否则三天前的 401 与五分钟前的一样）', () => {
  const withTime = KeyedCard({
    channel: keyedRow, t,
    health: { state: 'ok', lastOkAt: Date.now() - 60_000, halfOpen: false },
  })
  assert.ok(flat(withTime).includes('keyedLastAt'), '缺「上次实测」那一行')
  const withoutTime = KeyedCard({ channel: keyedRow, t, health: { state: 'unknown' } })
  assert.ok(!flat(withoutTime).includes('keyedLastAt'), '没测过时不该编一个时刻')
})

check('表格视图：切换按钮存在，切到表格后一堆卡片不见了（34 条时一眼扫完）', () => {
  const cards = KeyedPage({ t, channels: [keyedRow], wired: true, keyStates: {}, probes: {}, health: {} })
  const toggle = collectElements(cards, (node) => typeof node.props?.['data-view'] === 'string')
  assert.equal(toggle.length, 1, '缺一个视图切换按钮，实际 ' + toggle.length)
  assert.equal(toggle[0].props['data-view'], 'cards', '默认应当是卡片视图')
  assert.ok(flat(cards).includes('keyedViewTable'), '卡片视图下按钮文案应当指向「表格视图」')
  // 表格视图的列是契约：少一列就看不出该先收拾哪条。
  assert.ok(flat(cards).includes('keyedSort'), '缺少排序下拉')
})

check('冷却到期会自动刷新（否则「还有 42 秒」永远停在那）', () => {
  // 这条断言看的是**行为契约**：KeyedPage 必须注册一个 useEffect（我们的 React 替身会把它
  // 当成空操作，所以这里只断言「渲染不崩、且冷却态下渲染得出来」）。
  // 真正的定时器行为由人工核对 + 一次实测覆盖（读者可看 client.js 里那段 useEffect 的注释）。
  const tree = KeyedPage({
    t, channels: [keyedRow], wired: true, keyStates: {}, probes: {},
    health: { [keyedRow.id]: { state: 'cooldown', until: Date.now() + 60_000, text: '冷却中' } },
  })
  assert.ok(walk(tree, 'KeyedPage-cooldown') > 5, '冷却态渲染失败')
  assert.ok(flat(tree).includes('keyedHealthCooldown'), '缺少冷却文案')
})

// ── 0.6.0：筛选/排序的纯函数（从组件里抽出来的那三个）──────────────────────
const { bucketOfChannel, matchesQuery, sortersFor } = module.__test

check('bucketOfChannel：健康优先于就绪（刚被 401 判死的渠道不能被算成「就绪」）', () => {
  const keyStates = { lane: { configured: true } }
  assert.equal(bucketOfChannel({ id: 'lane', state: 'ready' }, keyStates, {}), 'ready')
  assert.equal(bucketOfChannel({ id: 'lane', state: 'ready' }, keyStates, { lane: { state: 'revoked' } }), 'revoked')
  assert.equal(bucketOfChannel({ id: 'lane', state: 'ready' }, keyStates, { lane: { state: 'cooldown' } }), 'cooldown')
  // 没配 key 且没判死 → 待配置
  assert.equal(bucketOfChannel({ id: 'other', state: 'needs-action' }, {}, {}), 'pending')
  // 关掉的渠道**优先于一切**：它不是「坏了」，是用户自己的选择（第六档）。
  assert.equal(bucketOfChannel({ id: 'lane', state: 'ready' }, keyStates, {}, ['lane']), 'disabled')
  assert.equal(bucketOfChannel({ id: 'lane', state: 'ready' }, keyStates, { lane: { state: 'revoked' } }, ['lane']), 'disabled')
})

check('matchesQuery：渠道名 / 凭据名 / 端点 / 模型样例都能命中，空查询放行', () => {
  const row = {
    id: 'zai',
    displayName: 'Z.ai（智谱国际站）',
    apiKeyEnv: 'ZAI_API_KEY',
    endpoint: 'https://api.z.ai/api/paas/v4',
    modelSample: ['glm-5.3-flash', 'glm-4.7-flash'],
  }
  for (const needle of ['zai', 'Z.ai', 'ZAI_API_KEY', 'api.z.ai', 'glm-5.3', 'GLM-4.7']) {
    assert.equal(matchesQuery(row, needle), true, needle + ' 应当命中')
  }
  assert.equal(matchesQuery(row, 'groq'), false)
  assert.equal(matchesQuery(row, ''), true, '空查询必须放行（否则一打开页面列表就空）')
  assert.equal(matchesQuery(row, '   '), true, '只有空白也算空查询')
})

check('sortersFor：health 档按 就绪→冷却→待配→吊销 排，models 档按模型数降序', () => {
  const rows = [
    { id: 'a', displayName: 'B名', modelCount: 1 },
    { id: 'b', displayName: 'A名', modelCount: 9 },
    { id: 'c', displayName: 'C名', modelCount: 5 },
  ]
  const buckets = { a: 'revoked', b: 'ready', c: 'cooldown' }  // 关掉的排在最后（rank 4）
  const bucketOf = (row) => buckets[row.id]
  const sorters = sortersFor(bucketOf)
  assert.equal(sorters.recommended, null, '推荐顺序 = 目录顺序（不排）')
  assert.deepEqual(rows.slice().sort(sorters.models).map((r) => r.id), ['b', 'c', 'a'])
  assert.deepEqual(rows.slice().sort((l, r) => l.displayName.localeCompare(r.displayName, 'zh-Hans-CN')).map((r) => r.id), ['b', 'a', 'c'])
  assert.deepEqual(rows.slice().sort(sorters.health).map((r) => r.id), ['b', 'c', 'a'])
})
// ── 汇总 ────────────────────────────────────────────────────────────────────
check('语言包：三页签与新文案都有词条（缺词条会显示成变量名）', () => {
  const src = readFileSync(join(ROOT, 'client.js'), 'utf8')
  // 从源码里抓出所有 `t('xxx')` 的 key，逐个确认 zh 字典里有对应词条。
  const keys = new Set([...src.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]))
  const zhBlock = src.slice(src.indexOf('const zh = {'), src.indexOf('const en = {'))
  const missing = [...keys].filter((key) => !new RegExp(`\\n\\s*${key}:`).test(zhBlock))
  assert.deepEqual(missing, [], '中文词条缺失: ' + missing.join(', '))
})

console.log(`\npass=${pass} fail=${fails.length}`)
if (fails.length > 0) {
  for (const failure of fails) console.error('FAIL ' + failure)
  process.exitCode = 1
}
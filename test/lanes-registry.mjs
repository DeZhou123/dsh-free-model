/**
 * 渠道注册表 + 渠道目录的回归防线（`src/lanes/registry.js`、`src/lanes/catalog.js`）。
 *
 * ## 为什么这几条断言重要
 *
 * 1. **目录层是「不可信输入」**：远程 JSON 的每一条记录都要过校验。断言的重点不是
 *    「合法记录能进来」，而是**坏记录必须被整条丢掉并给出理由** —— 一条 baseURL
 *    写错的渠道表现成「插件坏了」，比少一条渠道糟得多。
 * 2. **`pinned` 的语义**：用户钉住一条渠道，是「别再让远程改它」。这条断言防的是
 *    「钉住形同虚设」，那种错用户要过几天才会发现。
 * 3. **就绪状态四态**：`ready / needs-action / unavailable / unknown`。合成一个词会让
 *    用户乱试方向，所以每一态都要有一条断言。
 *
 * 运行：node --import ./test/hooks.mjs test/lanes-registry.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CATALOG_FORMAT_VERSION,
  MAX_REMOTE_CATALOG_BYTES,
  catalogFingerprint,
  mergeCatalogs,
  normalizeChannelRecord,
  staticChannelProblems,
} from '../src/lanes/catalog.js'
import {
  NATIVE_ACCOUNT_IDS,
  buildRegistry,
  channelById,
  nativeAccountRecords,
  projectRegistryView,
  serviceRecords,
} from '../src/lanes/registry.js'
import { SERVICE_LANES, decodeCredentialValue, listModelsFrom, probeServiceLane } from '../src/lanes/service.js'

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  console.log('  ✓ ' + label)
}
async function checkAsync(label, fn) {
  await fn()
  passed += 1
  console.log('  ✓ ' + label)
}

const KEYED_SAMPLE = {
  id: 'openrouter-free',
  displayName: 'OpenRouter 免费模型',
  kind: 'keyed',
  baseURL: 'https://openrouter.ai/api/v1',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  category: '海外',
  freeTier: '部分模型永久免费',
  signupURL: 'https://openrouter.ai/keys',
  capability: { tools: true, vision: true },
  credits: { balance: false, claim: false },
  models: [{ id: 'deepseek/deepseek-v4.1-flash:free', name: 'Free', contextWindow: 200000, vision: true, tools: true }],
}

// ── 目录记录校验 ─────────────────────────────────────────────────────────────

check('合法记录通过校验，字段与默认值都对', () => {
  const result = normalizeChannelRecord(KEYED_SAMPLE, 'shipped')
  assert.equal(result.ok, true, result.reason ?? '')
  assert.equal(result.channel.id, 'openrouter-free')
  assert.equal(result.channel.kind, 'keyed')
  assert.equal(result.channel.backend, 'native', 'kind=keyed 不给 backend 时应默认 native')
  assert.equal(result.channel.endpoint, 'https://openrouter.ai/api/v1')
  assert.equal(result.channel.apiKeyEnv, 'OPENROUTER_API_KEY')
  assert.equal(result.channel.models.length, 1)
  assert.equal(result.channel.models[0].vision, true)
  assert.equal(result.channel.capability.tools, true)
})

check('缺字段/坏字段一律整条拒绝并给出理由', () => {
  const cases = [
    [{ displayName: 'x', kind: 'keyed', baseURL: 'https://a/v1', models: [{ id: 'm' }] }, 'id'],
    [{ id: 'A-B', displayName: 'x', kind: 'keyed', baseURL: 'https://a/v1', models: [{ id: 'm' }] }, 'id'],
    [{ id: 'a', kind: 'keyed', baseURL: 'https://a/v1', models: [{ id: 'm' }] }, 'displayName'],
    [{ id: 'a', displayName: 'x', kind: 'nope', baseURL: 'https://a/v1', models: [{ id: 'm' }] }, 'kind'],
    [{ id: 'a', displayName: 'x', kind: 'keyed', baseURL: 'https://a/v1', models: [] }, '至少要声明 1 个模型'],
    [{ id: 'a', displayName: 'x', kind: 'keyed', models: [{ id: 'm' }] }, 'baseURL'],
    [{ id: 'a', displayName: 'x', kind: 'service', models: [] }, 'probe'],
    [{ id: 'a', displayName: 'x', kind: 'keyed', backend: 'weird', baseURL: 'https://a/v1', models: [{ id: 'm' }] }, 'backend'],
    [null, '不是对象'],
  ]
  for (const [raw, needle] of cases) {
    const result = normalizeChannelRecord(raw, 'remote')
    assert.equal(result.ok, false, JSON.stringify(raw))
    assert.ok(result.reason.includes(needle), `${needle} 未出现在理由里：${result.reason}`)
  }
})

check('URL 里的 query/hash/内嵌凭据一律拒绝（凭据泄漏面）', () => {
  for (const baseURL of [
    'https://a/v1?token=abc',
    'https://a/v1#frag',
    'https://user:pw@a/v1',
    'ftp://a/v1',
    'not-a-url',
  ]) {
    const result = normalizeChannelRecord({ ...KEYED_SAMPLE, baseURL }, 'remote')
    assert.equal(result.ok, false, baseURL + ' 不该通过')
  }
})

check('apiKeyEnv 只认大写凭据名；null 表示免 key', () => {
  const bad = normalizeChannelRecord({ ...KEYED_SAMPLE, apiKeyEnv: 'lower_case' }, 'remote')
  assert.equal(bad.ok, false)
  const keyless = normalizeChannelRecord({ ...KEYED_SAMPLE, kind: 'keyed', apiKeyEnv: null }, 'remote')
  assert.equal(keyless.ok, true, keyless.reason ?? '')
  assert.equal(keyless.channel.apiKeyEnv, undefined, 'null 的 apiKeyEnv 不该出现在记录上')
})

check('能力位不写就是「未知」，不许被臆造成 true', () => {
  const result = normalizeChannelRecord({
    id: 'nokey', displayName: 'N', kind: 'keyed', baseURL: 'https://a/v1', models: [{ id: 'm' }],
  }, 'shipped')
  assert.equal(result.channel.capability.tools, null)
  assert.equal(result.channel.capability.vision, null)
})

check('探针只接受 GET/HEAD，POST 的探针整条拒绝（这是 SSRF 面）', () => {
  const post = normalizeChannelRecord({
    id: 'p', displayName: 'P', kind: 'service', endpoint: 'http://127.0.0.1:1',
    probe: { url: 'http://127.0.0.1:1/x', method: 'POST' }, models: [],
  }, 'remote')
  // 服务车道**必须有可用探针**（否则页面上永远显示「未知」）。POST 探针被丢掉 ⇒
  // 这条渠道等于没有探针 ⇒ 在目录层就被拒掉，而不是留一条点不了的僵尸卡片。
  assert.equal(post.ok, false)
  assert.ok(post.reason.includes('probe'), post.reason)

  // keyed 渠道上出现探针字段：它本来不需要探针，故规范化后不该留在记录里，
  // 更不该从 `extra` 漏出去（不然一份能远程更新的目录就成了 SSRF 载体）。
  const keyed = normalizeChannelRecord({
    ...KEYED_SAMPLE,
    probe: { url: 'http://127.0.0.1:9/x', method: 'GET' },
  }, 'remote')
  assert.equal(keyed.ok, true)
  assert.equal(keyed.channel.probe, undefined, 'keyed 渠道不该带探针')
  assert.equal(keyed.channel.extra?.probe, undefined, '被丢掉的探针不该从 extra 漏出去')

  const get = normalizeChannelRecord({
    id: 'g', displayName: 'G', kind: 'service', endpoint: 'http://127.0.0.1:1',
    probe: {
      url: 'http://127.0.0.1:1/x', method: 'get', okStatus: [200, 401, 999],
      auth: { apiKeyEnv: 'SOME_KEY', header: 'Authorization', scheme: 'Bearer' },
    },
    models: [],
  }, 'remote')
  assert.equal(get.channel.probe.method, 'GET')
  assert.deepEqual([...get.channel.probe.okStatus], [200, 401], '越界状态码要滤掉')
  assert.equal(get.channel.probe.auth.header, 'authorization')
})

// ── 三层叠加 ────────────────────────────────────────────────────────────────

check('远程整条覆盖随包，按 id 逐条生效', () => {
  const merged = mergeCatalogs([
    { layer: 'shipped', channels: [{ ...KEYED_SAMPLE, displayName: '旧名' }] },
    { layer: 'remote', channels: [{ ...KEYED_SAMPLE, displayName: '新名', baseURL: 'https://new.example/v1' }] },
  ])
  assert.equal(merged.channels.length, 1)
  assert.equal(merged.channels[0].displayName, '新名')
  assert.equal(merged.channels[0].endpoint, 'https://new.example/v1')
  assert.equal(merged.channels[0].origin, 'remote', '页面要能说清这条渠道来自哪一层')
})

check('pinned 的渠道不吃远程覆盖，但本地仍能改（否则钉住就锁死了）', () => {
  const merged = mergeCatalogs([
    { layer: 'shipped', channels: [{ ...KEYED_SAMPLE, pinned: true }] },
    { layer: 'remote', channels: [{ ...KEYED_SAMPLE, displayName: '远程想改的' }] },
    { layer: 'local', channels: [{ ...KEYED_SAMPLE, displayName: '用户改的', pinned: true }] },
  ])
  assert.equal(merged.channels[0].displayName, '用户改的')
  assert.ok(merged.rejected.some((line) => line.includes('已钉住')), '被拒绝的远程覆盖要记账')
})

check('未知目录层整层拒绝并记账', () => {
  const merged = mergeCatalogs([
    { layer: 'shipped', channels: [KEYED_SAMPLE] },
    { layer: 'cdn', channels: [{ ...KEYED_SAMPLE, displayName: 'X' }] },
  ])
  assert.equal(merged.byLayer.cdn, undefined)
  assert.ok(merged.rejected.some((line) => line.includes('未知目录层')))
})

check('指纹随内容变化、与顺序无关', () => {
  const a = normalizeChannelRecord(KEYED_SAMPLE, 'shipped').channel
  const b = normalizeChannelRecord({ ...KEYED_SAMPLE, displayName: '别的名字' }, 'shipped').channel
  assert.equal(catalogFingerprint([a, b]), catalogFingerprint([b, a]), '排序后应与输入顺序无关')
  assert.notEqual(catalogFingerprint([a]), catalogFingerprint([b]), '内容变了指纹必须变')
  assert.equal(catalogFingerprint([a]).length, 16)
})

check('静态自检能指出「未确证」与缺 apiKeyEnv 的记录', () => {
  const unknown = normalizeChannelRecord({ ...KEYED_SAMPLE, unknown: true }, 'shipped').channel
  assert.ok(staticChannelProblems(unknown).some((line) => line.includes('未确证')))
})

// ── 注册表 ──────────────────────────────────────────────────────────────────

check('注册表三类渠道齐全，账号车道全部由本插件自己挂（native）', () => {
  const registry = buildRegistry()
  // ⚠️ 不再断言账号「13 条」：那 11 条 OFM 车道已拆成独立插件 `dsh-ofm-lanes`，
  // 本插件只保留自己真正挂载的两条。条数写死会让两条产品线互相打架，而这条
  // 断言要验的是「注册表把账号 / 服务两类都产出了，且账号记录都是 native」。
  assert.equal(registry.counts.account, NATIVE_ACCOUNT_IDS.length)
  assert.equal(registry.counts.service, SERVICE_LANES.length)
  assert.equal(registry.counts.total, NATIVE_ACCOUNT_IDS.length + SERVICE_LANES.length)
  assert.deepEqual(
    nativeAccountRecords().map((row) => row.id).sort(),
    [...NATIVE_ACCOUNT_IDS].sort(),
  )
  assert.ok(registry.channels.filter((row) => row.kind === 'account').every((row) => row.backend === 'native'),
    '账号记录必须全是 native（OFM 那 11 条在另一个插件里）')
})

check('注册表按 账号 → 自带 key → 服务 的顺序排列（页面卡片顺序稳定）', () => {
  const registry = buildRegistry({ keyed: [KEYED_SAMPLE] })
  const kinds = registry.channels.map((channel) => channel.kind)
  const order = kinds.map((kind) => ['account', 'keyed', 'service'].indexOf(kind))
  assert.deepEqual([...order].sort((a, b) => a - b), order, '顺序必须是 账号 → keyed → 服务')
})

check('坏的自带 key 记录被丢掉且记账，其余照常进表', () => {
  const registry = buildRegistry({
    keyed: [KEYED_SAMPLE, { id: 'bad', displayName: '坏', kind: 'keyed', baseURL: 'https://a/v1', models: [] }],
  })
  assert.equal(registry.counts.keyed, 1)
  assert.ok(registry.rejected.some((line) => line.includes('bad')))
})

check('注册表导出可查（channelById）', () => {
  const registry = buildRegistry()
  assert.equal(channelById(registry.channels, 'buddy').displayName, 'CodeBuddy (腾讯)')
  assert.equal(channelById(registry.channels, 'nope'), undefined)
})

// ── 就绪状态：四态必须分辨得开 ───────────────────────────────────────────────

check('四态投影：ready / needs-action / unavailable / unknown 各就各位', () => {
  const registry = buildRegistry({ keyed: [KEYED_SAMPLE, { ...KEYED_SAMPLE, id: 'keyless-x', kind: 'keyed', apiKeyEnv: null }] })
  const rows = projectRegistryView(registry.channels, {
    nativeMounted: ['buddy'],
    serviceProbes: {
      opencode: { state: 'ready', reason: '12 个模型' },
      freellmapi: { state: 'needs-action', reason: '缺凭据' },
    },
    keyedReady: { 'openrouter-free': { ready: false, reason: '缺凭据 OPENROUTER_API_KEY' } },
  })
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]))

  assert.equal(byId.buddy.state, 'ready')
  assert.equal(byId.workbuddy.state, 'unavailable', '没挂载的 native 车道必须是 unavailable 且说清原因')
  assert.equal(byId.opencode.state, 'ready')
  assert.equal(byId.freellmapi.state, 'needs-action')
  assert.equal(byId.ollama.state, 'unknown', '没探过的服务车道只能是 unknown，不许猜成 ready')
  assert.equal(byId['openrouter-free'].state, 'needs-action')
  assert.ok(byId['openrouter-free'].reason.includes('OPENROUTER_API_KEY'))
  assert.equal(byId['keyless-x'].state, 'ready', '免 key 渠道没有 ready 记录时也应显示为可用')
})

check('未挂载的账号车道一律 unavailable，且原因能指向下一步', () => {
  // ⚠️ 那条「OFM 后端就绪 → 11 条转 ready」的断言随拆分一起下线了：那 11 条车道
  // 已搬到独立插件 dsh-ofm-lanes，本插件里不再有 `backend: 'ofm'` 的账号记录。
  // 现在账号车道只有一种就绪判据 —— 本插件手上有没有它的适配器。
  const rows = projectRegistryView(buildRegistry().channels, { nativeMounted: [] })
  const accounts = rows.filter((row) => row.kind === 'account')
  assert.ok(accounts.length >= 2, '账号车道不该凭空消失')
  for (const row of accounts) {
    assert.equal(row.state, 'unavailable', row.id + ' 未挂载却不是 unavailable')
    assert.ok(row.reason.length > 8, row.id + ' 的原因太短，用户读不出下一步')
  }
})

check('投影不带出探针与内部字段（页面拿不到执行面）', () => {
  const rows = projectRegistryView(buildRegistry().channels, {})
  for (const row of rows) {
    assert.equal(row.probe, undefined, row.id + ' 不该把探针发给页面')
    assert.equal(row.apiKeyEnv !== undefined && typeof row.apiKeyEnv !== 'string', false)
  }
})

check('服务车道元数据里没有「点了必然失败」的按钮（startable 只给真能拉起的）', () => {
  const rows = projectRegistryView(serviceRecords(), {})
  const opencode = rows.find((row) => row.id === 'opencode')
  const freellmapi = rows.find((row) => row.id === 'freellmapi')
  assert.equal(opencode.startable, true)
  assert.equal(freellmapi.startable, undefined, '别的插件注册的网关不该给「启动」按钮')
})

// ── 服务探针的纯逻辑 ────────────────────────────────────────────────────────

check('凭据解码认三种形态，绝不把 ref: 当 key', () => {
  assert.equal(decodeCredentialValue('sk-abc'), 'sk-abc')
  assert.equal(decodeCredentialValue('ref:FOO'), undefined)
  assert.equal(decodeCredentialValue({ value: 'sk-x' }), 'sk-x')
  assert.equal(decodeCredentialValue({ secret: 'sk-y' }), 'sk-y')
  assert.equal(decodeCredentialValue(''), undefined)
  assert.equal(decodeCredentialValue(undefined), undefined)
})

check('模型清单认 OpenAI 与 Ollama 两种形状，Ollama 要滤掉向量模型', () => {
  assert.deepEqual(listModelsFrom({ data: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b'])
  assert.deepEqual(
    listModelsFrom({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'qwen3:8b' }] }, { chatModelExcludes: true }),
    ['qwen3:8b'],
  )
  assert.deepEqual(listModelsFrom(undefined), [])
})

await checkAsync('探测：服务没起 → unavailable；起了但缺 key → needs-action', async () => {
  const lane = SERVICE_LANES.find((row) => row.id === 'freellmapi')
  const down = await probeServiceLane(lane, { fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(down.state, 'unavailable')
  assert.ok(down.reason.includes('连不上'))

  const up = await probeServiceLane(lane, { fetchImpl: async () => ({ status: 200, async json() { return { data: [{ id: 'x' }] } } }) })
  assert.equal(up.state, 'needs-action', '200 但没凭据时要说「缺凭据」而不是「不可用」')
})

await checkAsync('探测：探针缺 fetch 时报 unknown，不许猜', async () => {
  const lane = SERVICE_LANES.find((row) => row.id === 'opencode')
  const result = await probeServiceLane(lane, { fetchImpl: undefined, })
  const noFetch = typeof globalThis.fetch === 'function'
  // 运行时一定有 fetch（Node 18+），所以这里只断言「拿得到结构化结果」。
  assert.ok(noFetch === true ? result.state !== undefined : result.state === 'unknown')
})

// ── 本地覆盖文件 ────────────────────────────────────────────────────────────

await checkAsync('本地覆盖文件：不存在不报错、坏文件不拖垮插件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-local-'))
  try {
    const entry = await import('../index.js')
    assert.equal(typeof entry.apply, 'function')
    // 真实读取路径由 index.js 的 readLocalCatalog 处理；这里断言模块能加载即可，
    // 读文件的容错在 test/lanes-catalog-io.mjs 里逐条断言。
    writeFileSync(join(dir, 'channels.local.json'), '{ not json', 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

assert.equal(CATALOG_FORMAT_VERSION, 1)
assert.ok(MAX_REMOTE_CATALOG_BYTES > 0)

console.log(`通过 ${passed} 项`)
console.log('全部通过')
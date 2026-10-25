/**
 * 目录形状断言（离线，纯数据，不发任何网络）。
 *
 * 这一层守的是「**错一条数据 = 用户以为插件坏了**」：baseURL 写错、id 撞车、
 * keyless 却要求 key，都会在页面上表现成"插件有问题"，而不是"这条渠道配错了"。
 *
 * 用法：node test/keyed/catalog-shape.mjs
 */

import assert from 'node:assert/strict'
import {
  ALL_CHANNELS,
  KEYED_CHANNELS,
  KEYLESS_CHANNELS,
  RETIRED_CHANNELS,
  catalogStats,
  laneById,
  lanePlaceholders,
  lanesByRegion,
  staticModels,
} from '../../src/lanes/keyed/catalog.js'

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error) })
  }
}

/** 所有渠道级字段都必须存在且类型正确。 */
const CHANNEL_FIELDS = {
  id: 'string',
  displayName: 'string',
  kind: 'string',
  protocol: 'string',
  baseURL: 'string',
  docsURL: 'string',
  signupURL: 'string',
  freeTier: 'string',
  region: 'string',
  note: 'string',
  evidence: 'string',
}
/** 允许出现在 `unknownFields` 里的字段名（写别的说明标记跑偏了）。 */
const ALLOWED_UNKNOWN = new Set(['baseURL', 'models', 'freeTier', 'apiKeyEnv'])

check('KEYED_CHANNELS 至少 12 条', () => {
  assert.ok(KEYED_CHANNELS.length >= 12, `只有 ${KEYED_CHANNELS.length} 条自带 key 渠道`)
})

check('KEYLESS_CHANNELS 至少 1 条真正免 key 的', () => {
  assert.ok(KEYLESS_CHANNELS.length >= 1, '至少要有一条免 key 直连渠道')
  for (const lane of KEYLESS_CHANNELS) {
    assert.equal(lane.apiKeyEnv, null, `${lane.id} 号称免 key，却声明了 apiKeyEnv=${lane.apiKeyEnv}`)
    assert.equal(lane.kind, 'keyless')
  }
})

check('id 全局唯一（keyed/keyless/retired 三张表一起查）', () => {
  const seen = new Map()
  for (const lane of ALL_CHANNELS) {
    assert.equal(seen.has(lane.id), false, `id 撞车：${lane.id}（已有 ${seen.get(lane.id)}）`)
    seen.set(lane.id, lane.displayName)
  }
})

check('id 形态：短横线小写、可作路由前缀', () => {
  for (const lane of ALL_CHANNELS) {
    assert.match(lane.id, /^[a-z0-9][a-z0-9-]*$/, `${lane.id} 不是短横线小写`)
  }
})

check('渠道级字段齐备且类型正确', () => {
  for (const lane of ALL_CHANNELS) {
    for (const [field, type] of Object.entries(CHANNEL_FIELDS)) {
      assert.equal(typeof lane[field], type, `${lane.id} 的 ${field} 应为 ${type}，实际 ${typeof lane[field]}`)
      if (type === 'string') assert.ok(lane[field].length > 0, `${lane.id} 的 ${field} 是空串`)
    }
    assert.ok(Array.isArray(lane.models) && lane.models.length >= 1, `${lane.id} 至少要有一条静态模型`)
    assert.ok(['global', 'cn'].includes(lane.region), `${lane.id} 的 region=${lane.region} 非法`)
    assert.equal(lane.protocol, 'openai', `${lane.id} 的 protocol=${lane.protocol} 本期不支持`)
    assert.equal(lane.baseURL.startsWith('https://'), true, `${lane.id} 的 baseURL 必须是 https`)
    assert.equal(/\/$/.test(lane.baseURL), false, `${lane.id} 的 baseURL 不该有结尾斜杠（拼 URL 会出 //）`)
  }
})

check('kind 与所在数组一致；keyless 恒 ready、恒无 apiKeyEnv', () => {
  for (const lane of KEYED_CHANNELS) assert.equal(lane.kind, 'keyed', `${lane.id} 在 KEYED_CHANNELS 里但 kind=${lane.kind}`)
  for (const lane of RETIRED_CHANNELS) assert.equal(lane.retired, true, `${lane.id} 在 RETIRED_CHANNELS 里但没有 retired:true`)
  for (const lane of KEYED_CHANNELS) {
    assert.equal(typeof lane.apiKeyEnv, 'string', `${lane.id} 是 keyed 却没有 apiKeyEnv`)
    assert.ok(lane.apiKeyEnv.length > 0, `${lane.id} 的 apiKeyEnv 是空串`)
  }
  // 已下线的渠道**不许**混进 KEYED_CHANNELS：那等于给上层留一条必然失败的路由。
  for (const lane of KEYED_CHANNELS) assert.notEqual(lane.retired, true, `${lane.id} 已下线却仍在 KEYED_CHANNELS 里`)
})

check('模型行形状：id/name/contextWindow/maxTokens/vision/tools', () => {
  for (const lane of ALL_CHANNELS) {
    const ids = new Set()
    for (const row of staticModels(lane)) {
      assert.equal(typeof row.id, 'string', `${lane.id} 有模型行缺 id`)
      assert.ok(row.id.length > 0, `${lane.id} 有空的模型 id`)
      assert.equal(ids.has(row.id), false, `${lane.id} 里模型 id 重复：${row.id}`)
      ids.add(row.id)
      assert.equal(typeof row.name, 'string', `${lane.id}/${row.id} 缺 name`)
      assert.equal(Number.isFinite(row.contextWindow) && row.contextWindow >= 0, true, `${lane.id}/${row.id} 的 contextWindow 非法（0 = 未知）`)
      assert.equal(Number.isFinite(row.maxTokens) && row.maxTokens >= 0, true, `${lane.id}/${row.id} 的 maxTokens 非法（0 = 未知）`)
      assert.equal(typeof row.vision, 'boolean', `${lane.id}/${row.id} 的 vision 必须是布尔（能力声明靠它）`)
      assert.equal(typeof row.tools, 'boolean', `${lane.id}/${row.id} 的 tools 必须是布尔（它决定发不发 tools[]）`)
    }
  }
})

check('unknown 标记与 unknownFields 一一对应（不许滥用，也不许漏）', () => {
  for (const lane of ALL_CHANNELS) {
    const fields = Array.isArray(lane.unknownFields) ? lane.unknownFields : []
    assert.equal(lane.unknown, fields.length > 0, `${lane.id}：unknown=${lane.unknown} 但 unknownFields=${JSON.stringify(fields)}`)
    for (const field of fields) {
      assert.equal(ALLOWED_UNKNOWN.has(field), true, `${lane.id} 的 unknownFields 里有不认识的字段名：${field}`)
    }
    // 判据：baseURL 从未猜过（每条都有 evidence），模型 id 与额度数值才可能未确证。
    if (fields.includes('baseURL')) {
      assert.ok(typeof lane.evidence === 'string' && lane.evidence.length > 0, `${lane.id} 标了 baseURL 未确证，却又没有 evidence`)
    }
  }
})

check('每条渠道都写了 evidence（这一轮的真凭据）', () => {
  for (const lane of ALL_CHANNELS) {
    assert.ok(lane.evidence.length >= 12, `${lane.id} 的 evidence 太短，等于没写`)
  }
})

check('带占位符的渠道必须声明 placeholders（ready 层据此判 not-ready）', () => {
  const cloudflare = laneById('cloudflare-workers-ai')
  assert.deepEqual(lanePlaceholders(cloudflare), ['{ACCOUNT_ID}'])
  for (const lane of ALL_CHANNELS) {
    const found = lanePlaceholders(lane)
    if (found.length === 0) continue
    assert.ok(Array.isArray(lane.placeholders), `${lane.id} 的 baseURL 里有 ${found.join('、')} 但没声明 placeholders`)
  }
  // ⚠️ 上游目录校验会用 new URL() 规范化：WHATWG URL 的路径编码集**包含 `{` `}`**，
  // 于是 `{ACCOUNT_ID}` 会变成 `%7BACCOUNT_ID%7D`。只认花括号的实现会在规范化之后
  // 把这条车道判成"就绪"，然后去打一个必然 404 的地址 —— 用户看到的是"插件坏了"。
  assert.deepEqual(lanePlaceholders({ baseURL: 'https://x/%7Baccount_id%7D/ai/v1' }), ['{ACCOUNT_ID}'])
  assert.deepEqual(lanePlaceholders({ baseURL: 'https://x/plain/v1' }), [])
})

check('辅助函数：laneById / lanesByRegion / catalogStats', () => {
  assert.equal(laneById('openrouter-free')?.displayName, 'OpenRouter 免费模型')
  assert.equal(laneById('查无此车'), undefined)
  assert.ok(lanesByRegion('cn').length >= 5, '国内直连车道偏少')
  assert.ok(lanesByRegion('cn').every((lane) => lane.region === 'cn'))
  const stats = catalogStats()
  assert.equal(stats.keyed, KEYED_CHANNELS.length)
  assert.equal(stats.keyless, KEYLESS_CHANNELS.length)
  assert.equal(stats.retired, RETIRED_CHANNELS.length)
  assert.equal(stats.keyed + stats.keyless + stats.retired, ALL_CHANNELS.length)
  assert.ok(stats.withLiveCatalog >= 10, '有实时 /models 的渠道太少（静态表会长期当权威）')
  assert.ok(stats.unknownLanes >= 1, '至少要有渠道带未确证标记（诚实标注应存在）')
  assert.equal(stats.unverifiedBaseURL, 0, '有渠道的 baseURL 未确证 —— 那是唯一会让用户以为插件坏了的字段')
})

check('openCatalog 标记：恰好这 9 条 /models 可匿名读（2026-10-26 两轮实测）', () => {
  // 这一条是**把实测结论钉进代码**：哪天有人加了一条"目录也免 key"的渠道却没标，
  // 页面就不会给它挂「探测通过≠有额度」的提示，用户会拿一把废 key 反复试。
  const expected = [
    'openrouter-free', 'modelscope', 'nvidia-nim', 'sambanova',
    'gitee-ai', 'huggingface-router', 'chutes', 'novita', 'deepinfra',
  ]
  const marked = ALL_CHANNELS.filter((lane) => lane.openCatalog === true).map((lane) => lane.id).sort()
  assert.deepEqual(marked, [...expected].sort(), 'openCatalog 名单与实测不一致：' + marked.join(','))
  // 标记只能落在 keyed 渠道上：keyless 本来就不需要凭据，标了是重复信息。
  for (const lane of ALL_CHANNELS) {
    if (lane.openCatalog !== true) continue
    assert.equal(lane.kind, 'keyed', lane.id + ' 是 ' + lane.kind + '，不该标 openCatalog')
  }
})

check('带占位符的渠道必须声明 supportsModelList:false（它的 /models 地址本来就是假的）', () => {
  // 2026-10-26 实测补的纪律：cloudflare-workers-ai 的 baseURL 里有 {ACCOUNT_ID}，
  // 而它的 /models 连匿名 GET 都不接受（两轮 405）。没声明时，每次打开模型选择器
  // 都会先打一个必然失败的地址，再等超时 —— 用户只觉得"卡"。
  for (const lane of ALL_CHANNELS) {
    const found = lanePlaceholders(lane)
    if (found.length === 0) continue
    assert.equal(lane.supportsModelList, false,
      lane.id + ' 带占位符 ' + found.join('、') + ' 却没声明 supportsModelList:false')
  }
})

check('没有把 /models 实测 404 的渠道标成有实时目录', () => {
  // 2026-10-25 实测 .../v1beta/openai/models → 404。标错的后果是每次开模型
  // 选择器都白等一次超时，然后回退 —— 用户只觉得"卡"。
  assert.equal(laneById('google-ai-studio')?.supportsModelList, false)
  assert.equal(laneById('pollinations')?.supportsModelList, false)
  assert.equal(laneById('pollinations')?.modelsURL, 'https://text.pollinations.ai/models')
})

check('github-models 在 RETIRED 里（2026-07-30 官方下线），不在可挂载集合里', () => {
  const retired = laneById('github-models')
  assert.equal(retired?.retired, true)
  assert.equal(retired?.retiredOn, '2026-07-30')
  assert.equal(KEYED_CHANNELS.some((lane) => lane.id === 'github-models'), false)
})

console.log('\n通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ': ' + failure.message)
  console.log('pass=' + passed + ' fail=' + failures.length)
  process.exit(1)
}
console.log('目录：' + KEYED_CHANNELS.length + ' 条自带 key + ' + KEYLESS_CHANNELS.length + ' 条免 key + '
  + RETIRED_CHANNELS.length + ' 条已下线；unknown 渠道 ' + catalogStats().unknownLanes + ' 条、unknown 模型行 '
  + catalogStats().unknownModels + ' 条')
console.log('pass=' + passed + ' fail=0')
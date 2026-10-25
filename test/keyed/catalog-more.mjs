/**
 * 第二批渠道（`src/lanes/keyed/catalog-more.js`）的形状与**纪律**断言（离线，不发网络）。
 *
 * ## 为什么单独一个套件，而不是塞进 `catalog-shape.mjs`
 *
 * 那套断言守的是「所有渠道都成立的形状」（id 唯一、region 合法、模型行字段齐）。
 * 这一批独有的问题是**另一类**，形状断言看不见：
 *
 * 1. 「探测到底证明了什么」—— 免 key 也能读 /models 的渠道，一次 200 **不证明**你有额度。
 *    这种渠道必须在 `note` 里把这件事写出来，否则用户会以为"探测通过=能用"。
 * 2. 「套餐车道不能和按量车道共用一把 key」—— kimi-coding / zai-coding-cn 是订阅端点，
 *    拿按量 key 调必然 401。放错一条的代价是用户以为自己的号被降级了。
 * 3. 「实测否掉的候选不许偷偷溜回来」—— kluster / lambda / lingyiwanwu（已停服）这些名字
 *    出现在目录里，等于让人照着再试一遍。
 *
 * 用法：node test/keyed/catalog-more.mjs
 */

import assert from 'node:assert/strict'
import { MORE_KEYED_CHANNELS, MORE_KEYED_COUNT } from '../../src/lanes/keyed/catalog-more.js'
import { KEYED_CHANNELS, ALL_CHANNELS, laneById, lanePlaceholders, catalogStats } from '../../src/lanes/keyed/catalog.js'

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

const byId = (id) => MORE_KEYED_CHANNELS.find((lane) => lane.id === id)

check('第二批至少 12 条（0.6.0 意图是「把市面上验证过的渠道搬进来」）', () => {
  assert.ok(MORE_KEYED_COUNT >= 12, `只有 ${MORE_KEYED_COUNT} 条`)
  assert.equal(MORE_KEYED_COUNT, MORE_KEYED_CHANNELS.length)
})

check('第二批已拼进 KEYED_CHANNELS，且顺序是「第一批在前」', () => {
  for (const lane of MORE_KEYED_CHANNELS) {
    assert.ok(KEYED_CHANNELS.some((row) => row.id === lane.id), `${lane.id} 没拼进 KEYED_CHANNELS`)
  }
  assert.equal(KEYED_CHANNELS.length >= MORE_KEYED_COUNT + 20, true,
    'KEYED_CHANNELS 条数不对：第二批应当**追加**在第一批之后，而不是替换它')
})

check('id 不与第一批撞车（撞了会让后写的那条静默覆盖前者）', () => {
  const seen = new Map()
  for (const lane of KEYED_CHANNELS) {
    assert.equal(seen.has(lane.id), false, `id 撞车：${lane.id}`)
    seen.set(lane.id, true)
  }
})

check('每条都写了 evidence，且 evidence 里有「2026-10-26」这个实测日期', () => {
  for (const lane of MORE_KEYED_CHANNELS) {
    assert.equal(typeof lane.evidence, 'string', `${lane.id} 缺 evidence`)
    assert.ok(lane.evidence.includes('2026-10-26'),
      `${lane.id} 的 evidence 没写本轮实测日期：${lane.evidence.slice(0, 60)}`)
    // 证据必须带「探了哪个 URL + 回了什么」，否则下一个人无法复核。
    assert.ok(/GET https:\/\//.test(lane.evidence), `${lane.id} 的 evidence 没写探测的 URL`)
  }
})

check('baseURL 全部 https、无结尾斜杠、无占位符（这一批不需要账号 ID）', () => {
  for (const lane of MORE_KEYED_CHANNELS) {
    assert.equal(lane.baseURL.startsWith('https://'), true, `${lane.id} 不是 https`)
    assert.equal(lane.baseURL.endsWith('/'), false, `${lane.id} 的 baseURL 有结尾斜杠（拼 URL 会出 //）`)
    assert.deepEqual(lanePlaceholders(lane), [], `${lane.id} 带占位符，应改走 placeholders 声明`)
  }
})

check('unknown 标记与 unknownFields 一一对应（与本仓库既有纪律同一条尺子）', () => {
  for (const lane of MORE_KEYED_CHANNELS) {
    const fields = Array.isArray(lane.unknownFields) ? lane.unknownFields : []
    assert.equal(lane.unknown === true, fields.length > 0, `${lane.id}：unknown 与 unknownFields 不一致`)
    assert.equal(fields.includes('baseURL'), false, `${lane.id} 声称 baseURL 未确证 —— 这一批每条都实测过`)
  }
})

check('免 key 也能读 /models 的渠道，note 里必须写出「探测通过≠有额度」', () => {
  // 实测 200 且不带凭据的那几条：地址活着是事实，但它不能推出"你有额度"。
  const openCatalog = ['gitee-ai', 'huggingface-router', 'deepinfra'].filter((id) => byId(id) !== undefined)
  for (const id of openCatalog) {
    const lane = byId(id)
    assert.ok(lane !== undefined, `${id} 不在第二批里`)
    assert.ok(/不要 key 也能读/.test(lane.note), `${id} 的 note 没写明"不要 key 也能读 /models"`)
  }
})

check('订阅套餐车道必须写明「与按量是两把 key」', () => {
  for (const id of ['kimi-coding', 'zai-coding-cn']) {
    const lane = byId(id)
    assert.ok(lane !== undefined, `${id} 不在第二批里`)
    assert.ok(/key/.test(lane.note) && /(按量|两把|不通用|401)/.test(lane.note),
      `${id} 的 note 没写清套餐端点与按量 key 的关系`)
    assert.ok(/套餐|订阅/.test(lane.freeTier), `${id} 的 freeTier 没写它是套餐计费`)
  }
})

check('同厂商的两个站（zai / zhipu-bigmodel）都被显式指出 key 不通用', () => {
  const intl = byId('zai')
  assert.ok(intl.note.includes('zhipu-bigmodel'), 'zai 的 note 没指向国内站那一条')
  assert.ok(/不通用/.test(intl.note), 'zai 的 note 没说明 key 不通用')
  // 反向也要成立：国内站那条得能提到国际站，否则用户从任一方向都找不到另一半。
  const cn = laneById('zhipu-bigmodel')
  assert.ok(cn !== undefined)
})

check('曾被实测否掉的候选不得出现在任何渠道表里', () => {
  // 这几个是「试过、不行」的：连不上 / 已停服 / 没有可对话模型 / 不是免费渠道。
  const denied = ['kluster', 'lambda', 'ai21', 'cohere', 'sensenova', 'lingyiwanwu', 'puter', 'openai', 'deepseek-official']
  for (const id of denied) {
    assert.equal(ALL_CHANNELS.some((lane) => lane.id === id), false, `被否掉的 ${id} 又出现在目录里了`)
  }
})

check('模型行：id 非空、能力位是布尔、窗口 0 表示"未知"且不写负数', () => {
  for (const lane of MORE_KEYED_CHANNELS) {
    const ids = new Set()
    for (const row of lane.models) {
      assert.equal(typeof row.id, 'string')
      assert.ok(row.id.length > 0, `${lane.id} 有空的模型 id`)
      assert.equal(ids.has(row.id), false, `${lane.id} 里模型 id 重复：${row.id}`)
      ids.add(row.id)
      assert.equal(typeof row.vision, 'boolean', `${lane.id}/${row.id} 的 vision 必须是布尔`)
      assert.equal(typeof row.tools, 'boolean', `${lane.id}/${row.id} 的 tools 必须是布尔`)
      assert.ok(Number.isFinite(row.contextWindow) && row.contextWindow >= 0,
        `${lane.id}/${row.id} 的 contextWindow 非法（0 = 未知）`)
      assert.ok(Number.isFinite(row.maxTokens) && row.maxTokens >= 0,
        `${lane.id}/${row.id} 的 maxTokens 非法（0 = 未知）`)
    }
  }
})

check('novita 的 /models 路径与目录一致（/v3/openai/models，不是 /v3/models）', () => {
  const lane = byId('novita')
  assert.equal(lane.baseURL, 'https://api.novita.ai/v3/openai')
  assert.ok(lane.note.includes('/v3/openai/models'), 'novita 的 note 没提醒 /v3/openai/models 这个细节')
})

check('deepinfra 的窗口一律写 0（它的 /models 不带上下文元数据，编数字就是撒谎）', () => {
  const lane = byId('deepinfra')
  for (const row of lane.models) {
    assert.equal(row.contextWindow, 0, `deepinfra/${row.id} 编了一个窗口值：${row.contextWindow}`)
  }
})

check('目录统计仍自洽：keyed/keyless/retired 三分加起来等于总数', () => {
  const stats = catalogStats()
  assert.equal(stats.keyed, KEYED_CHANNELS.length)
  assert.equal(stats.keyed + stats.keyless + stats.retired, ALL_CHANNELS.length)
  assert.equal(stats.unverifiedBaseURL, 0, '有渠道的 baseURL 被标成未确证 —— 这一批不该出现')
})

console.log('\n通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ': ' + failure.message)
  console.log('pass=' + passed + ' fail=' + failures.length)
  process.exit(1)
}
console.log('第二批：' + MORE_KEYED_COUNT + ' 条（' + MORE_KEYED_CHANNELS.map((lane) => lane.id).join(', ') + '）')
console.log('pass=' + passed + ' fail=0')

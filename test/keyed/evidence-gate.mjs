/**
 * evidence 标记门禁（离线，纯数据，不发网络）。
 *
 *   node test/keyed/evidence-gate.mjs
 *
 * ## 这道门禁防的是什么（2026-10-26 的事故形状）
 *
 * 目录里的 `evidence` / `note` 是**给下一个人复核用的实测记录**。它被写坏过一次，
 * 方式很隐蔽：字符串拼接时用了 `+ '/' + `，语法合法、`node --check` 过、全部测试也过，
 * 但运行时 `'str' / 'str'` 是**除法**，结果是 `NaN`，而且把后半段整句吞掉。
 * 页面把 `NaN` 直接渲染给用户。
 *
 * 后来补过一次回灌（`c8292c8`），但**只补了一半**：groq 与 pollinations 写了，而那一轮
 * 唯一被真跑通的 openrouter-free 反而没写。所以门禁不能只查「有没有 evidence 字段」——
 * 必须查**标记的具体内容**，否则「写了一半」和「写完了」在断言里长得一样。
 *
 * ## 三条断言
 *
 *   ① 三条实测渠道（`openrouter-free` / `pollinations` / `groq`）的 `evidence` 必须带
 *      **本轮实测标记**：状态码 + 耗时（ms）+ key 判定（或明确的「未判定」），缺一项就指名。
 *   ② 任何渠道的 `note` / `evidence` / `freeTier` 值里都不许出现 `NaN` / `undefined` /
 *      `[object Object]`（与 catalog-shape 那条同源，但这里覆盖三个字段、逐条点名）。
 *   ③ **否定断言**：把某条渠道的 evidence 删掉「key 有效性未判定」这一句后，本门禁必须变红
 *      —— 断言自己也是可被证伪的（否则「恒绿的门禁」等于没有门禁）。
 *
 * ③ 用一份内存里的副本做（`stripMarker`），不动真实目录。
 */
import assert from 'node:assert/strict'
import { ALL_CHANNELS, laneById } from '../../src/lanes/keyed/catalog.js'

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('OK   ' + name)
  } catch (error) {
    failures.push({ name, message: error instanceof Error ? error.message : String(error) })
    console.log('FAIL ' + name + ': ' + (error instanceof Error ? error.message : String(error)))
  }
}

/** 必须有实测标记的渠道（判据点名的那三条）。 */
const REQUIRED = ['openrouter-free', 'pollinations', 'groq']

/** 一条 evidence 里必须出现的三类标记（正则宽松：允许中文写法与不同分隔）。 */
const MARKERS = [
  { key: '状态码', re: /\b(200|401|403|404|429|5\d\d)\b/, hint: '要写上游回的状态码' },
  { key: '耗时', re: /\b\d{2,6}\s?ms\b/i, hint: '要写实测耗时（ms）' },
  { key: 'key 判定', re: /(key[^。；;]{0,12}(有效|未判定|无效|缺失|可读|不带\s*key|带\s*key))|(匿名|无需\s*key|免\s*key)/i, hint: '要写 key 是否有效/是否需要（或明确「未判定」）' },
]

/** 找出一条渠道 evidence 里缺哪些标记。 */
export function missingMarkers(evidence) {
  const text = String(evidence || '')
  return MARKERS.filter((m) => !m.re.test(text)).map((m) => m.key)
}

/** 把「key 有效性未判定」这类句子删掉，用来证明断言③真的会红。 */
export function stripMarker(evidence) {
  return String(evidence || '')
    .replace(/key[^。；;]{0,12}未判定/g, '')
    .replace(/key[^。；;]{0,12}(有效|无效|缺失|可读)/g, '')
    .replace(/(匿名|无需\s*key|免\s*key)/g, '')
}

// ── ① 三条渠道必须带实测标记 ─────────────────────────────────────────────
check('① 三条实测渠道的 evidence 带「状态码 + 耗时 + key 判定」', () => {
  for (const id of REQUIRED) {
    const lane = laneById(id)
    assert.ok(lane, '目录里没有渠道 ' + id)
    const missing = missingMarkers(lane.evidence)
    assert.deepEqual(missing, [], id + ' 的 evidence 缺：' + missing.join('、') + '（' + (lane.evidence || '').slice(0, 80) + '…）')
  }
})

check('①b 每条的 evidence 都写了探测的 URL（下一个人要能复核）', () => {
  for (const id of REQUIRED) {
    const lane = laneById(id)
    assert.ok(/https:\/\//.test(lane.evidence || ''), id + ' 的 evidence 没写 URL')
  }
})

// ── ② 三个文本字段里不许有 NaN / undefined / [object Object] ─────────────
check('② 任何渠道的 note / evidence / freeTier 都不含 NaN / undefined / [object Object]', () => {
  const bad = []
  for (const lane of ALL_CHANNELS) {
    for (const field of ['note', 'evidence', 'freeTier']) {
      const value = lane[field]
      if (typeof value !== 'string') { bad.push(lane.id + '.' + field + ' 不是字符串（' + typeof value + '）'); continue }
      const m = /\bNaN\b|\bundefined\b|\[object Object\]/.exec(value)
      if (m) bad.push(lane.id + '.' + field + ' 里有 ' + m[0])
    }
  }
  assert.deepEqual(bad, [], '有渠道的文本字段被写坏：' + bad.join('; '))
})

check('②b 三个字段都不是空串（空串等于「写了但没内容」）', () => {
  const bad = []
  for (const lane of ALL_CHANNELS) {
    for (const field of ['note', 'evidence', 'freeTier']) {
      const value = lane[field]
      if (typeof value === 'string' && value.trim() === '') bad.push(lane.id + '.' + field)
    }
  }
  assert.deepEqual(bad, [], '空字符串字段：' + bad.join(', '))
})

// ── ③ 否定断言：把标记删掉，门禁必须变红 ─────────────────────────────────
check('③ 否定断言：删掉「key 判定」后 missingMarkers 必须非空（证明门禁可被证伪）', () => {
  for (const id of REQUIRED) {
    const lane = laneById(id)
    const stripped = stripMarker(lane.evidence)
    const missing = missingMarkers(stripped)
    assert.ok(missing.includes('key 判定'),
      id + '：把 key 判定删掉后本门禁仍然认为齐全 —— 这条断言失去意义。原文：' + (lane.evidence || '').slice(0, 100))
  }
})

check('③b 否定断言：用真实拼接复现出 NaN，② 的检测必须抓到', () => {
  // 事故现场那种写法：'str' / 'str' 是**除法**，运行时得 NaN（不是抛错）。
  // 注意不能写 String(1 / 1) —— 那是 "1"，第一版就这么写错了，断言自己没红。
  const broken = '拼接坏了 ' + String('abc' / 'def') + ' 尾部被吞'
  assert.match(broken, /NaN/, '复现失败：这个写法应当产生 NaN')
  const hit = /\bNaN\b|\bundefined\b|\[object Object\]/.exec(broken)
  assert.ok(hit, 'NaN 检测正则本身坏了（这条断言防的是门禁自己写错）')
})

console.log('')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const f of failures) console.log('  ✗ ' + f.name + ': ' + f.message)
  console.log('pass=' + passed + ' fail=' + failures.length)
  process.exit(1)
}
console.log('pass=' + passed + ' fail=0')

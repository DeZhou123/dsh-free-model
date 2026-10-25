/**
 * 文档与代码的一致性断言 —— 「README 里的数字还对不对」。
 *
 * ## 为什么值得进 CI
 *
 * 这一夜 README 漂了**两次**：渠道从 21 涨到 34，而骨架图还写着 30；第二批从 10 条涨到 14 条；
 * 筛选胶囊从 5 个涨到 6 个；更有一次是**判据本身**漂了 —— README 写着「401/403 → 吊销永不恢复」，
 * 而代码里 403 早已改成冷却（因为实测到 Groq 的 Cloudflare 403 带 key 与否同码）。
 * 那条漂移会直接把用户引到「去换 key」这条错路上。
 *
 * 数字漂移没有功能影响，但它让「README 可信」变成需要人工记忆的事 —— 而人工记忆一定会失败。
 * 所以这里把 README 里**能被代码验证**的几个数字挑出来自动比对：对不上就红。
 *
 * 只做**能确定**的断言：需要解释、可能合理变化的表述一律不碰（宁可少一条，不要一条会误报的）。
 *
 * 用法：node test/docs-consistency.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const { catalogStats, KEYED_CHANNELS, KEYLESS_CHANNELS } = await import('../src/lanes/keyed/catalog.js')
const { SERVICE_LANES } = await import('../src/lanes/service.js')
const clientSource = readFileSync(join(ROOT, 'client.js'), 'utf8')

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

const stats = catalogStats()

check('README 首表的「自带 key / 免 key 渠道」条数与目录一致', () => {
  const expected = `| **自带 key / 免 key 渠道** | ${KEYED_CHANNELS.length}（+${KEYLESS_CHANNELS.length} 免 key） |`
  assert.ok(readme.includes(expected), 'README 里找不到 ' + expected + '（实际目录：keyed ' + KEYED_CHANNELS.length + ' / keyless ' + KEYLESS_CHANNELS.length + '）')
})

check('README 首表的「服务渠道」条数与 service.js 一致', () => {
  const expected = `| **服务渠道**（本机进程） | ${SERVICE_LANES.length} |`
  assert.ok(readme.includes(expected), 'README 里找不到 ' + expected + '（实际 ' + SERVICE_LANES.length + ' 条）')
})

check('README 骨架图里的 keyed 条数与 service 条数与代码一致', () => {
  assert.ok(
    readme.includes(`${KEYED_CHANNELS.length} 条自带 key / ${KEYLESS_CHANNELS.length} 条免 key 车道`),
    '骨架图的 keyed 行与目录不一致',
  )
  assert.ok(
    readme.includes(`${SERVICE_LANES.length} 条服务车道`),
    '骨架图的服务车道行与 service.js 不一致',
  )
})

check('README 里「第二批 N 条」与实际一致', () => {
  const more = readFileSync(join(ROOT, 'src', 'lanes', 'keyed', 'catalog-more.js'), 'utf8')
  const match = /MORE_KEYED_CHANNELS = \[/.exec(more)
  assert.ok(match !== null, '找不到 MORE_KEYED_CHANNELS')
  const count = (more.match(/^\s{2}\{\s*$/gm) ?? []).length
  assert.ok(readme.includes(`第二批 ${count} 条`), 'README 的「第二批 N 条」与实际（' + count + '）不一致')
})

check('README 里的筛选胶囊个数与 client.js 的 FILTERS 一致', () => {
  const filters = /const FILTERS = \[([^\]]+)\]/.exec(clientSource)
  assert.ok(filters !== null, 'client.js 里找不到 FILTERS')
  const count = filters[1].split(',').map((item) => item.trim()).filter((item) => item !== '').length
  const zh = { 3: '三', 4: '四', 5: '五', 6: '六', 7: '七' }[count] ?? String(count)
  assert.ok(readme.includes(`${zh}个**带数字**的筛选胶囊`), 'README 说「' + zh + '个带数字的筛选胶囊」但 FILTERS 有 ' + count + ' 档')
})

check('README 里「N 个套件」的说法不再写死具体数字（写死必漂）', () => {
  assert.equal(/npm test.*?→.*?\d+ 个套件/.test(readme), false, 'README 里把套件数写死了，改成「十余个」这类不漂的说法')
})

check('README 里的续期/探测超时数字与 keys.js 一致（写死的超时最容易漂）', () => {
  const keys = readFileSync(join(ROOT, 'src', 'lanes', 'keyed', 'keys.js'), 'utf8')
  const timeout = /PROBE_TIMEOUT_MS = ([\d_]+)/.exec(keys)
  assert.ok(timeout !== null, '找不到 PROBE_TIMEOUT_MS')
  const seconds = Number(timeout[1].replace(/_/g, '')) / 1000
  // README 若提到探测超时，数字必须对上；不提就不算错。
  const mention = /探测[^。]{0,20}?(\d+) 秒/.exec(readme)
  if (mention !== null) {
    assert.equal(Number(mention[1]), seconds, 'README 说探测超时 ' + mention[1] + ' 秒，实际 ' + seconds + ' 秒')
  }
})


check('代码里的每一条路由都出现在 README（「有功能但没人知道在哪」= 没有这个功能）', () => {
  const routesSource = readFileSync(join(ROOT, 'src', 'routes.js'), 'utf8')
  const paths = [...new Set([...routesSource.matchAll(/routePath === '([^']+)'/g)].map((m) => m[1]))]
  assert.ok(paths.length >= 30, 'routePath 抽出来只有 ' + paths.length + ' 条，抽取规则可能过期了')
  const missing = paths.filter((path) => !readme.includes(path))
  assert.deepEqual(missing, [], '这些路由没写进 README：' + missing.join(', '))
})

check('「九件事」的个数与那张表的行数一致（数字写死就会漂）', () => {
  const heading = /## 自带 key 那一页现在有(\S+)件事可做/.exec(readme)
  assert.ok(heading !== null, '找不到「N 件事」标题')
  const zh = { 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 }
  const declared = zh[heading[1]] ?? Number(heading[1])
  assert.ok(Number.isFinite(declared), '标题里的数字读不出来：' + heading[1])
  // 只数该小节到下一个二级标题之间的**表格数据行**：
  // ⚠️ 不能只按「以 | 开头」数 —— 那样会把表头一起算进来（第一版就是这么错的：9 行表数出 10）。
  // 判据改成「分隔行（|---|）之后的行」，表头自然被排除。
  const section = readme.slice(heading.index)
  const sectionEnd = section.indexOf('\n## ', 1)
  const body = sectionEnd === -1 ? section : section.slice(0, sectionEnd)
  let seenSeparator = false
  let rows = 0
  for (const line of body.split('\n')) {
    if (!line.startsWith('|')) continue
    if (/^\|\s*:?-{2,}/.test(line)) { seenSeparator = true; continue }
    if (seenSeparator) rows += 1
  }
  assert.equal(rows, declared, '标题说「' + declared + ' 件事」，表里却有 ' + rows + ' 行')
})
console.log('\n通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ': ' + failure.message)
  console.log('pass=' + passed + ' fail=' + failures.length)
  process.exit(1)
}
console.log('目录 keyed ' + KEYED_CHANNELS.length + ' / keyless ' + KEYLESS_CHANNELS.length + ' / service ' + SERVICE_LANES.length)
console.log('pass=' + passed + ' fail=0')
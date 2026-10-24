/**
 * 自带 key 渠道的**端点健康探针**（无凭据，只判「地址还活着吗、路径对吗」）。
 *
 * ## 为什么它属于插件仓库，而不是某个人的临时脚本
 *
 * `src/lanes/keyed/catalog.js` 里每条渠道的 `baseURL` 都带 `evidence`（写目录那一刻的实测/官方文档）。
 * 但渠道会变：换域名、下线、改路径。而插件已经把「能不能用」的责任交给了运行时 ——
 * 目录里的 URL 错了，用户看到的是「配了 key 还是 401/404」，那是**最难查的一类错**。
 *
 * 所以这份探针要能反复跑：**渠道数据一改就重跑一次**，把「写目录时的事实」更新成「今天的事实」。
 *
 * ## 判读表（把它当契约看）
 *
 * | 状态 | 含义 | 该做什么 |
 * |---|---|---|
 * | 401 / 403 | 端点活着，且**要凭据** —— 路径正确，这是最健康的一档 | 无 |
 * | 200 | 端点活着且**不需要凭据**就能列模型（免 key 渠道就该这样） | 无 |
 * | 404 | 端点活着但**路径不对**（或该平台没有 `/models`） | 改 baseURL，或在该渠道标 `supportsModelList:false` |
 * | 405 | 方法不对（某些端点的 `/models` 只收 POST） | 在该渠道标 `supportsModelList:false`，别改 baseURL |
 * | 3xx | 重定向（可能被地域/CDN 拦） | 记下来人工看 |
 * | 连不上 / 超时 | 本机此刻不可达（网络、被墙、上游挂了） | 记下来，**不代表目录错** |
 *
 * ⚠️ 本探针**不判「渠道免费与否」** —— 那是上游策略、会变；它只判地址是否还活着。
 * ⚠️ 默认**只打印**，不往仓库里写文件（跑一次就弄脏工作树的东西没人会跑第二次）。
 *
 * 用法：
 *   node scripts/probe-endpoints.mjs                 # 全部探一遍，结果打到 stdout
 *   node scripts/probe-endpoints.mjs --only groq     # 只探一条
 *   node scripts/probe-endpoints.mjs --dry           # 只列出将探测的 URL
 *   node scripts/probe-endpoints.mjs --out probe.md  # 另存一份 markdown
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const catalogFile = join(ROOT, 'src', 'lanes', 'keyed', 'catalog.js')

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const onlyIndex = args.indexOf('--only')
const only = onlyIndex !== -1 ? args[onlyIndex + 1] : undefined
const outIndex = args.indexOf('--out')
const outFile = outIndex !== -1 ? args[outIndex + 1] : undefined

const mod = await import(pathToFileURL(catalogFile).href)
const lanes = [...(mod.KEYED_CHANNELS ?? []), ...(mod.KEYLESS_CHANNELS ?? [])]
  .filter((lane) => only === undefined || lane.id === only)
if (lanes.length === 0) {
  console.error('没有可探测的渠道（--only 拼错了？）')
  process.exit(2)
}

/** 探测路径：绝大多数 OpenAI 兼容端点用 `/models`。 */
const probeUrl = (baseURL) => String(baseURL).replace(/\/+$/, '') + '/models'

if (dry) {
  console.log(`将探测 ${lanes.length} 条（不带凭据）：`)
  for (const lane of lanes) console.log('  · ' + lane.id.padEnd(24) + probeUrl(lane.baseURL))
  process.exit(0)
}

const TIMEOUT_MS = 12_000

function classify(status, error) {
  if (typeof status === 'number') {
    if (status === 200) return 'alive-open'
    if (status === 401 || status === 403) return 'alive-needs-auth'
    if (status === 404) return 'path-wrong'
    if (status === 405) return 'method-not-allowed'
    if (status >= 300 && status < 400) return 'redirect'
    if (status >= 500) return 'upstream-error'
    return 'other-' + status
  }
  const message = String(error ?? '')
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return 'dns-fail'
  if (/certificate|TLS|SSL/i.test(message)) return 'tls-fail'
  if (/abort|timeout/i.test(message)) return 'timeout'
  return 'unreachable'
}

/**
 * 目录自己声明过「这条渠道本来就不会好好回答」时，非 200 是**预期**，不是可疑。
 *
 * 两种声明：
 * 1. `supportsModelList:false` —— 该平台没有标准 `/models`（模型表在目录里，是快照）；
 * 2. `placeholders:['{ACCOUNT_ID}']` —— baseURL 里还有没填的占位符，探测用的地址**本来就是假的**
 *    （`cloudflare-workers-ai` 就是这样，回 405 完全正常）。
 *
 * 这条判据让工具的信号更值钱：**声称自己能列模型、且没有占位符**的渠道突然 404，
 * 才会让退出码变 1 —— 那才是真该有人去看的事（上游改了路径）。
 */
function isExpectedNonOk(lane, kind) {
  if (Array.isArray(lane.placeholders) && lane.placeholders.length > 0) return true
  return lane.supportsModelList === false && (kind === 'path-wrong' || kind === 'method-not-allowed')
}

const rows = []
for (const lane of lanes) {
  const url = probeUrl(lane.baseURL)
  const started = Date.now()
  let status
  let error
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': 'dsh-free-model-endpoint-probe' },
    })
    status = response.status
    try { await response.text() } catch { /* 正文只用于人工看，读不到不影响分类 */ }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const kind = classify(status, error)
  const ms = Date.now() - started
  const expected = isExpectedNonOk(lane, kind)
  const mark = kind === 'alive-needs-auth' || kind === 'alive-open' ? 'OK  ' : expected ? '·   ' : '⚠   '
  console.log(`${mark}${lane.id.padEnd(24)} ${(kind + (expected ? '（目录已声明·预期）' : '')).padEnd(18)} ${String(ms).padStart(5)}ms  ${String(status ?? error ?? '').slice(0, 70)}`)
  rows.push({
    id: lane.id,
    kind: lane.kind,
    baseURL: lane.baseURL,
    probeUrl: url,
    status: status ?? null,
    error: error ?? null,
    classify: kind,
    expectedNoCatalog: expected,
    ms,
    apiKeyEnv: lane.apiKeyEnv ?? null,
    unknown: lane.unknown === true,
  })
}

const tally = rows.reduce((acc, row) => { acc[row.classify] = (acc[row.classify] ?? 0) + 1; return acc }, {})
const healthy = rows.filter((r) => r.classify === 'alive-needs-auth' || r.classify === 'alive-open').length
// 「可疑」只算**目录没说过的** 404/405：声明了自己没有 /models 的渠道不算。
const suspicious = rows.filter((r) => !r.expectedNoCatalog && (r.classify === 'path-wrong' || r.classify === 'method-not-allowed'))
const unreachable = rows.filter((r) => ['dns-fail', 'timeout', 'unreachable', 'tls-fail'].includes(r.classify))

console.log('')
console.log('汇总：' + JSON.stringify(tally))
console.log(`可达（含需要凭据的 401/403）：${healthy}/${rows.length}`)
if (suspicious.length > 0) {
  console.log('需要处理的（路径/方法可疑）：')
  for (const row of suspicious) console.log(`  · ${row.id}：${row.probeUrl} → ${row.status}`)
}
if (unreachable.length > 0) {
  console.log('本机此刻不可达（不代表目录错）：')
  for (const row of unreachable) console.log(`  · ${row.id}：${row.classify} ${row.error ?? ''}`)
}

if (outFile !== undefined) {
  const md = [
    '# 自带 key 渠道端点探针（无凭据）',
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 对象：\`src/lanes/keyed/catalog.js\` 的 ${rows.length} 条渠道，各探 \`{baseURL}/models\``,
    '- 判读：**401/403 = 端点活着且要凭据（最健康的一档）**；200 = 免凭据；404 = 路径不对；405 = 方法不对；连不上 = 本机此刻不可达',
    '- 本探针**不判「渠道免费与否」**（上游策略，会变），只判地址是否还活着',
    '',
    '| 渠道 | 分类 | 状态 | 耗时 | 凭据名 |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| \`${r.id}\` | ${r.classify} | ${r.status ?? '—'} | ${r.ms}ms | ${r.apiKeyEnv ?? '（免 key）'} |`),
    '',
    `**可达 ${healthy}/${rows.length}**。`,
    '',
  ].join('\n')
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, md, 'utf8')
  console.log(`\n已写入 ${outFile}（这个文件是**运行产物**，别提交进仓库）`)
}

process.exit(suspicious.length === 0 ? 0 : 1)
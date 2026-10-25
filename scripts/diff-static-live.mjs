/**
 * 静态表 vs 上游实时目录 —— 「我的快照过期了吗」。
 *
 * ## 与 probe-endpoints 的分工
 *
 * | 脚本 | 问的问题 | 判据 |
 * |---|---|---|
 * | `probe-endpoints.mjs` | 这个**地址**还活着吗 | 401/403 = 活着；404 = 路径不对 |
 * | 本脚本 | 我表里的**模型 id** 还在上游吗 | 交集为 0 且上游有目录 = 快照已过期 |
 *
 * 两者都必要：地址活着不等于型号没变（上游改名是最常见的一种腐坏）。
 *
 * ## 为什么值得进仓库
 *
 * catalog 里的模型 id 是**快照**。上游改名/下架之后，静态表一天天变旧，而插件在
 * 拿不到实时目录时（没 key、网络不通、目录端点被挡）仍然照它列模型 —— 用户照着选，
 * 一个个 404，读起来像「插件坏了」。
 *
 * ## 判据（照抄到 CI 也成立）
 *
 * - **零交集**（上游有目录、静态表非空、交集为 0）→ 退 1，这是真该改表的信号；
 * - 部分交集 → 正常（上游天天加新模型，静态表只是兜底，不必跟着涨）；
 * - 401/403 → **跳过**：拿不到目录，什么都证明不了（不是失败）。
 *
 * 用法：
 *   node scripts/diff-static-live.mjs            # 全部探一遍
 *   node scripts/diff-static-live.mjs --json     # 只输出 JSON（喂给别的脚本）
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const jsonOnly = process.argv.includes('--json')
const TIMEOUT_MS = 15_000

const mod = await import(pathToFileURL(join(ROOT, 'src', 'lanes', 'keyed', 'catalog.js')).href)
const lanes = [...(mod.KEYED_CHANNELS ?? []), ...(mod.KEYLESS_CHANNELS ?? [])]

/**
 * 本机哪些凭据条目存在（**只读 refs 的键名**）。
 *
 * 刻意不解析 `records`、不读任何值：这个脚本只需要知道「这条渠道我有没有 key」，
 * 因为它决定了「拿不到目录」是「本来就要凭据」还是「我的 key 有问题」。
 */
function credentialRefNames() {
  const file = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(file)) return new Set()
  const names = new Set()
  let inRefs = false
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (inRefs && /^\S/.test(line)) inRefs = false
    if (!inRefs) continue
    const match = /^\s{2,}([A-Za-z0-9_]+):/.exec(line)
    if (match) names.add(match[1])
  }
  return names
}

const refs = credentialRefNames()
const rows = []

for (const lane of lanes) {
  if (lane.retired === true) continue
  if (lane.supportsModelList === false || (lane.placeholders ?? []).length > 0) {
    rows.push({ id: lane.id, outcome: 'skip-declared' })
    continue
  }
  const url = typeof lane.modelsURL === 'string' && lane.modelsURL !== ''
    ? lane.modelsURL
    : lane.baseURL.replace(/\/+$/, '') + '/models'
  const hasKey = lane.apiKeyEnv != null && refs.has(lane.apiKeyEnv)
  let status
  let text = ''
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
    status = response.status
    text = await response.text()
  } catch (error) {
    rows.push({ id: lane.id, hasKey, outcome: 'unreachable', error: (error instanceof Error ? error.message : String(error)).slice(0, 60) })
    continue
  }
  if (status === 401 || status === 403) {
    rows.push({ id: lane.id, hasKey, status, outcome: 'needs-auth' })
    continue
  }
  if (status !== 200) {
    rows.push({ id: lane.id, hasKey, status, outcome: 'http-' + String(status) })
    continue
  }
  let live = []
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : []
    live = list.map((item) => (typeof item === 'string' ? item : (item?.id ?? item?.name ?? ''))).filter((id) => id !== '')
  } catch {
    rows.push({ id: lane.id, hasKey, status, outcome: 'not-json' })
    continue
  }
  const statics = lane.models.map((model) => model.id)
  const lower = new Set(live.map((id) => String(id).toLowerCase()))
  const hits = statics.filter((id) => lower.has(String(id).toLowerCase()))
  rows.push({
    id: lane.id,
    hasKey,
    status,
    liveCount: live.length,
    staticCount: statics.length,
    hitCount: hits.length,
    outcome: live.length === 0 ? 'empty-catalog' : hits.length === 0 ? 'stale' : 'fresh',
    ...(hits.length === 0 && live.length > 0 ? { staticSample: statics.slice(0, 3) } : {}),
  })
  await new Promise((resolve) => setTimeout(resolve, 400))
}

if (jsonOnly) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  console.log('渠道'.padEnd(22) + 'key  HTTP  实时  静态  交集  结论')
  for (const row of rows) {
    if (row.outcome === 'skip-declared') { console.log(row.id.padEnd(22) + '—   ——    （目录已声明不可读或带占位符）'); continue }
    if (row.outcome === 'unreachable') { console.log(row.id.padEnd(22) + (row.hasKey ? 'Y' : 'n') + '   ERR   ' + row.error); continue }
    if (row.outcome === 'needs-auth') { console.log(row.id.padEnd(22) + (row.hasKey ? 'Y' : 'n') + '   ' + String(row.status).padStart(4) + '   （需要凭据，拿不到目录）'); continue }
    if (typeof row.liveCount !== 'number') { console.log(row.id.padEnd(22) + (row.hasKey ? 'Y' : 'n') + '   ' + String(row.status).padStart(4) + '   ' + row.outcome); continue }
    console.log(row.id.padEnd(22) + (row.hasKey ? 'Y' : 'n') + '   ' + String(row.status).padStart(4) + String(row.liveCount).padStart(6) + String(row.staticCount).padStart(6) + String(row.hitCount).padStart(6) + '  ' + row.outcome)
  }
  const stale = rows.filter((row) => row.outcome === 'stale')
  const fresh = rows.filter((row) => row.outcome === 'fresh')
  console.log('')
  console.log('可比对 ' + (stale.length + fresh.length) + ' 条：' + (stale.length === 0 ? '全部新鲜（静态表与上游有交集）' : '过期 ' + stale.length + ' 条 → ' + stale.map((row) => row.id).join(', ')))
  for (const row of stale) console.log('  · ' + row.id + '：静态表里的 ' + row.staticSample.join('、') + ' 在上游目录里已经找不到')
  console.log('其余：' + rows.filter((row) => row.outcome === 'needs-auth').length + ' 条需要凭据、'
    + rows.filter((row) => row.outcome === 'skip-declared').length + ' 条目录已声明不可读、'
    + rows.filter((row) => row.outcome === 'unreachable').length + ' 条本机不可达')
}

process.exit(rows.some((row) => row.outcome === 'stale') ? 1 : 0)

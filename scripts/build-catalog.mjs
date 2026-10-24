/**
 * 生成**远程渠道目录** `catalog/channels.json`（发版时跑一次）。
 *
 * ## 为什么要有这个脚本，而不是手写那份 JSON
 *
 * 渠道数据在仓库里有两份，它们的角色不同：
 *
 * | 文件 | 角色 | 谁读它 |
 * |---|---|---|
 * | `src/lanes/keyed/catalog.js` + `src/lanes/service.js` | **随包**（离线基线） | 插件运行时直接 import |
 * | `catalog/channels.json` | **远程**（随时可更新，不用发版） | 插件通过 raw 拉取 |
 *
 * 两份必须同形状但不该手工同步 —— 手抄必然漂移。所以远程那份**由脚本从随包那份生成**，
 * 并且生成时**用插件自己那套校验器过一遍**（`normalizeChannelRecord`）：
 * 校验不通过就不写文件、直接非零退出。
 *
 * 这条「自校验」是关键：它保证远程目录里的每一条，都是插件**能读懂**的记录。
 * 否则用户点了「检查目录」，得到的是一批被拒记录 —— 看起来像目录坏了。
 *
 * 用法：
 *   node scripts/build-catalog.mjs            # 写 catalog/channels.json
 *   node scripts/build-catalog.mjs --check    # 只校验、不写盘（CI 的第二步，见 test.yml）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CATALOG_FORMAT_VERSION, normalizeChannelRecord } from '../src/lanes/catalog.js'

// ⚠️ 不要在这里再套一层 dirname：`new URL('..', import.meta.url)` 已经是**包根**
//（scripts/ 的上一级）。多套一层会指到包的父目录，于是 import 全是 404 ——
// 2026-10-25 03:24 就是这个错（ERR_MODULE_NOT_FOUND: …\src\lanes\service.js）。
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const OUT = join(ROOT, 'catalog', 'channels.json')
const checkOnly = process.argv.includes('--check')

/** 随包的渠道来源：keyed/keyless 模块（可能还没装）+ 服务车道。 */
async function shippedChannels() {
  const rows = []
  const sources = []

  const keyedDir = join(ROOT, 'src', 'lanes', 'keyed')
  const keyedCatalog = join(keyedDir, 'catalog.js')
  if (existsSync(keyedCatalog)) {
    const mod = await import(pathToFileURL(keyedCatalog).href)
    for (const raw of [
      ...(Array.isArray(mod.KEYED_CHANNELS) ? mod.KEYED_CHANNELS : []),
      ...(Array.isArray(mod.KEYLESS_CHANNELS) ? mod.KEYLESS_CHANNELS : []),
    ]) rows.push(raw)
    sources.push(`src/lanes/keyed/catalog.js (${rows.length} 条)`)
  }

  const serviceFile = join(ROOT, 'src', 'lanes', 'service.js')
  const service = await import(pathToFileURL(serviceFile).href)
  const before = rows.length
  for (const lane of service.SERVICE_LANES ?? []) rows.push({ ...lane, category: lane.category ?? '本地' })
  sources.push(`src/lanes/service.js (${rows.length - before} 条)`)
  return { rows, sources }
}

const { rows, sources } = await shippedChannels()

/** 逐条过插件自己的校验器；不合格的**不写进远程目录**（宁可少一条，不要一条读不懂的）。 */
const accepted = []
const rejected = []
for (const raw of rows) {
  const result = normalizeChannelRecord(raw, 'shipped')
  if (result.ok) {
    // 落盘时去掉 origin（那是运行时算的），其余字段原样保留 ——
    // 远程目录要能被同一套校验器读出来，所以尽量贴近记录本身。
    const { origin, ...rest } = result.channel
    void origin
    accepted.push(rest)
  } else {
    rejected.push(result.reason)
  }
}

if (rejected.length > 0) {
  console.error('✗ 有记录过不了插件自己的校验，拒绝生成远程目录：')
  for (const line of rejected) console.error('  · ' + line)
  process.exit(1)
}

const payload = {
  catalogVersion: CATALOG_FORMAT_VERSION,
  updatedAt: new Date().toISOString().slice(0, 10),
  // 生成来源写进数据里：远程目录被读到时，能一眼看出它是从哪份随包数据生成的。
  generatedBy: 'scripts/build-catalog.mjs',
  note: '远程渠道目录。它只改「有哪些渠道、各自什么元数据」，不含任何可执行内容；'
    + '插件会逐条校验后才采用（见 src/lanes/catalog.js）。',
  channels: accepted,
}
const text = JSON.stringify(payload, null, 2) + '\n'
// 远程拉取上限按**字节**算，所以这里也必须报字节；`text.length` 是字符数，
// 中文渠道名一个字占 3 字节，混用会把 36,621 字节的目录说成 32,295（2026-10-25 修）。
const bytes = Buffer.byteLength(text, 'utf8')

if (checkOnly) {
  if (!existsSync(OUT)) {
    console.error('✗ catalog/channels.json 不存在（--check 模式不会创建它）')
    process.exit(1)
  }
  let existing
  try {
    existing = JSON.parse(readFileSync(OUT, 'utf8'))
  } catch (err) {
    console.error('✗ catalog/channels.json 不是合法 JSON：' + err.message)
    process.exit(1)
  }
  // 逐条比内容，不只比条数：只比条数时「改了一条 baseURL」「删一条又加一条」
  // 都能悄悄过关 —— 而远程目录真正会出的错就是这种漂移。
  // `updatedAt` 是生成日期，每天都会变，不参与比较。
  const actual = JSON.stringify({ version: existing.catalogVersion, channels: existing.channels })
  const expected = JSON.stringify({ version: payload.catalogVersion, channels: accepted })
  if (actual !== expected) {
    console.error('✗ catalog/channels.json 与随包渠道不一致：文件 '
      + `${existing.channels?.length ?? 0} 条，随包 ${accepted.length} 条。跑一次 node scripts/build-catalog.mjs`)
    process.exit(1)
  }
  console.log(`OK  catalog/channels.json 与随包渠道一致（${accepted.length} 条，逐条比对）`)
  process.exit(0)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, text, 'utf8')
console.log(`OK  写入 ${OUT}`)
console.log(`    来源：${sources.join('；')}`)
console.log(`    渠道：${accepted.length} 条（${accepted.map((row) => row.id).join(', ')}）`)
console.log(`    字节：${bytes}`)
if (bytes > 200 * 1024) {
  console.warn('    ⚠ 目录超过 200KB，接近远程拉取上限（256KB）；考虑精简字段')
}
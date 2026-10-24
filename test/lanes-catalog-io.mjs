/**
 * 远程渠道目录的回归防线（`src/lanes/remote.js`）。
 *
 * ## 这里断言的是「坏网络/坏数据时插件怎么办」
 *
 * 远程目录是**唯一的公网输入**。它必须做到三件事，否则不如不做：
 * 1. 只认 https（明文信道上的渠道目录谁都能改）；
 * 2. 格式版本不认识就**整份拒绝**（半份目录会让渠道莫名消失，那种错最难查）；
 * 3. 拿不到就用缓存、没有缓存就用随包数据 —— **永远不抛异常**。
 *
 * 运行：node test/lanes-catalog-io.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CATALOG_URL,
  catalogCacheFile,
  fetchRemoteCatalog,
  parseCatalogBody,
  readCache,
  writeCache,
} from '../src/lanes/remote.js'
import { MAX_REMOTE_CATALOG_BYTES } from '../src/lanes/catalog.js'

let passed = 0
async function check(label, fn) {
  await fn()
  passed += 1
  console.log('  ✓ ' + label)
}

const GOOD = JSON.stringify({
  catalogVersion: 1,
  updatedAt: '2026-10-25',
  channels: [{ id: 'pollinations', displayName: 'P', kind: 'keyed', baseURL: 'https://text.pollinations.ai/openai', apiKeyEnv: null, models: [{ id: 'openai' }] }],
})

function fakeResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return body } }
}

const dir = mkdtempSync(join(tmpdir(), 'fm-catalog-'))
const cacheFile = catalogCacheFile(dir)
assert.ok(cacheFile.endsWith(join('free-model', 'catalog-cache.json')), '缓存要落在 DSH home 的 free-model 子目录')

await check('正文解析：合法目录通过，坏目录逐条给出理由', async () => {
  const ok = parseCatalogBody(GOOD)
  assert.equal(ok.ok, true)
  assert.equal(ok.channels.length, 1)

  const wrongVersion = parseCatalogBody(JSON.stringify({ catalogVersion: 99, channels: [] }))
  assert.equal(wrongVersion.ok, false)
  assert.ok(wrongVersion.reason.includes('99'), wrongVersion.reason)

  assert.equal(parseCatalogBody('{oops').ok, false)
  assert.equal(parseCatalogBody('[]').ok, false)
  assert.equal(parseCatalogBody(JSON.stringify({ catalogVersion: 1 })).ok, false)
  const huge = parseCatalogBody('x'.repeat(MAX_REMOTE_CATALOG_BYTES + 1))
  assert.equal(huge.ok, false)
  assert.ok(huge.reason.includes('上限'))
  // 上限按**字节**算：多字节正文即使字符数没超，字节数超了也必须拒绝。
  // （回归 2026-10-25 的字符/字节混淆：32,295 字符其实是 36,621 字节。）
  const multibyte = parseCatalogBody('中'.repeat(Math.floor(MAX_REMOTE_CATALOG_BYTES / 3) + 1))
  assert.equal(multibyte.ok, false, '字符数未超但 UTF-8 字节数超限的正文必须拒绝')
  assert.ok(multibyte.reason.includes('字节'), multibyte.reason)
})

await check('明文 http 的目录地址直接拒绝，不打网络', async () => {
  let called = 0
  const result = await fetchRemoteCatalog({
    url: 'http://example.com/channels.json',
    fetchImpl: async () => { called += 1; return fakeResponse(GOOD) },
  })
  assert.equal(result.ok, false)
  assert.equal(called, 0, '非 https 时不该发请求')
  assert.ok(result.reason.includes('https'))
})

await check('首次拉取成功 → 写缓存、给出 sha256 与来源', async () => {
  const result = await fetchRemoteCatalog({
    url: DEFAULT_CATALOG_URL,
    cacheFile,
    fetchImpl: async () => fakeResponse(GOOD),
  })
  assert.equal(result.ok, true)
  assert.equal(result.from, 'network')
  assert.equal(result.channels.length, 1)
  assert.equal(typeof result.sha256, 'string')
  assert.equal(result.sha256.length, 16, 'sha256 取前 16 位即可（它只用于「内容变了吗」）')
  const cached = readCache(cacheFile)
  assert.equal(cached.channels.length, 1)
})

await check('TTL 内直接用缓存，不打网络', async () => {
  let called = 0
  const result = await fetchRemoteCatalog({
    url: DEFAULT_CATALOG_URL,
    cacheFile,
    fetchImpl: async () => { called += 1; return fakeResponse(GOOD) },
  })
  assert.equal(result.from, 'cache')
  assert.equal(called, 0)
})

await check('force 绕过缓存；网络失败时退回缓存并把原因带上', async () => {
  let called = 0
  const failing = async () => { called += 1; throw new Error('ENOTFOUND raw.githubusercontent.com') }
  const result = await fetchRemoteCatalog({ url: DEFAULT_CATALOG_URL, cacheFile, force: true, fetchImpl: failing })
  assert.equal(called, 1)
  assert.equal(result.ok, true, '有缓存时必须成功（降级）')
  assert.equal(result.from, 'cache')
  assert.ok(result.reason.includes('ENOTFOUND'), '原因要如实带出，页面要显示它')
})

await check('HTTP 4xx/5xx 也走缓存降级', async () => {
  const result = await fetchRemoteCatalog({
    url: DEFAULT_CATALOG_URL,
    cacheFile,
    force: true,
    fetchImpl: async () => fakeResponse('nope', 404),
  })
  assert.equal(result.ok, true)
  assert.equal(result.from, 'cache')
  assert.ok(result.reason.includes('404'))
})

await check('没有缓存且网络失败 → 明确失败，绝不抛异常', async () => {
  const fresh = join(dir, 'free-model', 'none-cache.json')
  const result = await fetchRemoteCatalog({
    url: DEFAULT_CATALOG_URL,
    cacheFile: fresh,
    fetchImpl: async () => { throw new Error('timeout') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.from, 'none')
  assert.deepEqual(result.channels, [])
  assert.ok(result.reason.includes('timeout'))
})

await check('运行时没有 fetch → 有缓存用缓存，没缓存报明原因', async () => {
  const withCache = await fetchRemoteCatalog({ url: DEFAULT_CATALOG_URL, cacheFile, force: true, fetchImpl: undefined })
  assert.equal(withCache.ok, true)
  const noCache = await fetchRemoteCatalog({
    url: DEFAULT_CATALOG_URL,
    cacheFile: join(dir, 'free-model', 'nope.json'),
    fetchImpl: null,
  })
  assert.equal(noCache.ok, false)
  assert.ok(noCache.reason.includes('fetch'))
})

await check('缓存写坏/版本不符时读不出来（当没有缓存处理，而不是崩）', async () => {
  const broken = join(dir, 'free-model', 'broken.json')
  writeCache(broken, { url: DEFAULT_CATALOG_URL, fetchedAt: Date.now(), catalogVersion: 99, channels: [] })
  assert.equal(readCache(broken), undefined, '格式版本不符的缓存必须被忽略')
  writeFileSync(broken, '{not json', 'utf8')
  assert.equal(readCache(broken), undefined)
  assert.equal(readCache(join(dir, 'free-model', 'missing.json')), undefined)
})

await check('写缓存是原子的：不留半截 JSON', async () => {
  const target = join(dir, 'free-model', 'atomic.json')
  writeCache(target, { url: DEFAULT_CATALOG_URL, fetchedAt: 1, catalogVersion: 1, channels: [] })
  JSON.parse(readFileSync(target, 'utf8')) // 能被解析 = 不是半截
  assert.ok(!existsSync(`${target}.tmp-${process.pid}`), '临时文件必须已被 rename 掉')
})

rmSync(dir, { recursive: true, force: true })
console.log(`通过 ${passed} 项`)
console.log('全部通过')
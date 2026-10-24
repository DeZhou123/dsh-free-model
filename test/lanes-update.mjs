/**
 * 版本检查的回归防线（`src/lanes/update.js`）。
 *
 * ## 为什么版本比较要单测
 *
 * 比较写错的后果是**静默的**：要么「永远提示有新版本」（用户被噪音训练到无视它），
 * 要么「明明有新版却说没有」（用户永远停在旧版）。这类功能只错一次就没人再信。
 * 预发布版是经典的坑：`0.4.0-rc.1` 必须**小于** `0.4.0`。
 *
 * ## 另一条同样重要：失败要静默且信息完整
 *
 * 本机实测 `github.com:443` 直连不通（要走代理），所以这条路径**默认就是会失败的**。
 * 失败时必须返回结构化对象（`ok:false` + reason），而不是抛异常把设置页打死。
 *
 * 运行：node test/lanes-update.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_REPO,
  checkUpdate,
  compareVersions,
  readVersionFromPackageJson,
  updateCacheFile,
  writeUpdateCache,
} from '../src/lanes/update.js'

let passed = 0
async function check(label, fn) {
  await fn()
  passed += 1
  console.log('  ✓ ' + label)
}

const dir = mkdtempSync(join(tmpdir(), 'fm-update-'))
const cacheFile = updateCacheFile(dir)

await check('版本比较：正式版、跨段位、预发布都按 semver', async () => {
  assert.equal(compareVersions('0.4.0', '0.3.2'), 1)
  assert.equal(compareVersions('0.3.2', '0.4.0'), -1)
  assert.equal(compareVersions('0.4.0', '0.4.0'), 0)
  assert.equal(compareVersions('0.4.10', '0.4.9'), 1, '数字段要按数值比，不能按字符串')
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('0.4.0-rc.1', '0.4.0'), -1, '预发布小于同号正式版')
  assert.equal(compareVersions('0.4.0', '0.4.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  // 认不出来的形态：当 0.0.0 + 预发布处理，绝不抛；任何真实版本都比它新
  assert.equal(compareVersions('not-a-version', '0.0.1'), -1)
})

await check('从 package.json 文本取 version（不整份 parse 后挑字段）', async () => {
  assert.equal(readVersionFromPackageJson('{"version":"1.2.3"}'), '1.2.3')
  assert.equal(readVersionFromPackageJson('{"version":42}'), undefined)
  assert.equal(readVersionFromPackageJson('{oops'), undefined)
})

await check('有新版本时 updateAvailable=true 并给出安装命令与链接', async () => {
  const result = await checkUpdate({
    currentVersion: '0.3.2',
    cacheFile: join(dir, 'free-model', 'u1.json'),
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '{"version":"0.4.0"}' } }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.latest, '0.4.0')
  assert.equal(result.updateAvailable, true)
  assert.equal(result.from, 'network')
  assert.equal(result.repoUrl, `https://github.com/${DEFAULT_REPO}`)
  assert.ok(result.changelogUrl.endsWith('CHANGELOG.md'))
  assert.ok(result.install.githubSpec.startsWith('github:'))
})

await check('当前已是最新时不提示；远端更旧时也不提示', async () => {
  const same = await checkUpdate({
    currentVersion: '0.4.0',
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '{"version":"0.4.0"}' } }),
  })
  assert.equal(same.updateAvailable, false)
  const older = await checkUpdate({
    currentVersion: '0.5.0',
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '{"version":"0.4.9"}' } }),
  })
  assert.equal(older.updateAvailable, false)
})

await check('TTL 内用缓存；force 重新打网络', async () => {
  const file = join(dir, 'free-model', 'u2.json')
  let called = 0
  const fetchImpl = async () => { called += 1; return { ok: true, status: 200, async text() { return '{"version":"0.9.9"}' } } }
  const first = await checkUpdate({ currentVersion: '0.4.0', cacheFile: file, fetchImpl })
  assert.equal(first.updateAvailable, true)
  const second = await checkUpdate({ currentVersion: '0.4.0', cacheFile: file, fetchImpl })
  assert.equal(called, 1, 'TTL 内不该再打网络')
  assert.equal(second.from, 'cache')
  await checkUpdate({ currentVersion: '0.4.0', cacheFile: file, force: true, fetchImpl })
  assert.equal(called, 2)
})

await check('网络失败且无缓存 → 结构化失败，不抛异常', async () => {
  const result = await checkUpdate({
    currentVersion: '0.4.0',
    cacheFile: join(dir, 'free-model', 'u3.json'),
    fetchImpl: async () => { throw new Error('ECONNREFUSED 140.82.114.4:443') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.latest, null)
  assert.equal(result.updateAvailable, false)
  assert.ok(result.reason.includes('ECONNREFUSED'))
  assert.ok(result.reason.includes('代理'), '要提示「本机访问 GitHub 常需代理」，否则用户以为插件坏了')
  // 失败时也要给出链接与命令：用户手动升级的路不能被失败堵死。
  assert.ok(result.repoUrl.includes('github.com'))
})

await check('网络失败但有缓存 → 用缓存并如实说明原因', async () => {
  const file = join(dir, 'free-model', 'u4.json')
  writeUpdateCache(file, { repo: DEFAULT_REPO, latest: '0.6.0', checkedAt: Date.now() - 10 * 3600 * 1000, from: 'network', reason: '' })
  const result = await checkUpdate({
    currentVersion: '0.4.0',
    cacheFile: file,
    fetchImpl: async () => { throw new Error('timeout') },
  })
  assert.equal(result.ok, true)
  assert.equal(result.from, 'cache')
  assert.equal(result.latest, '0.6.0')
  assert.equal(result.updateAvailable, true)
})

await check('缓存是别的仓库/版本格式不对 → 当没有缓存', async () => {
  const file = join(dir, 'free-model', 'u5.json')
  writeUpdateCache(file, { repo: 'someone/else', latest: '9.9.9', checkedAt: Date.now() })
  const result = await checkUpdate({
    currentVersion: '0.4.0',
    cacheFile: file,
    fetchImpl: async () => { throw new Error('down') },
  })
  assert.equal(result.ok, false, '别的仓库的缓存不许被当成自己的版本')
})

await check('远端 package.json 坏掉 → 明确失败而不是误报「已是最新」', async () => {
  const result = await checkUpdate({
    currentVersion: '0.4.0',
    cacheFile: join(dir, 'free-model', 'u6.json'),
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '<html>404 not found</html>' } }),
  })
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes('version'))
})

rmSync(dir, { recursive: true, force: true })
console.log(`通过 ${passed} 项`)
console.log('全部通过')
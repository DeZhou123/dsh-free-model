#!/usr/bin/env node
/**
 * run-tests.mjs —— `npm test` 的唯一入口，负责在**三种布局**下给出明确定义的行为。
 *
 * ## 它替代了什么（2026-10-28 01:55 实测）
 *
 * 原来 `scripts.test` 是 24 个 `node test/xxx.mjs && …` 串起来的巨长命令。
 * 而 `package.json` 的 `files` 白名单**不含 `test`** —— 发布包里没有测试文件。
 * 于是装了这个包的人跑 `npm test` 得到的是：
 *
 *   Error: Cannot find module '.../test/lanes-registry.mjs'
 *
 * 这个报错说的是「文件找不到」，读的人第一反应是"包坏了 / 装错了"，
 * 而真相是**这里本来就不该跑测试**。
 *
 * ## 为什么不用 `pretest` 钩子
 *
 * npm 的 `pretest` 只决定"要不要开始"，**不会**在它 exit 0 之后跳过 `test`。
 * 试过：pretest 打印"跳过测试"并 exit 0，npm 接着照跑 test，照样 Cannot find module。
 * 所以必须在 **test 自己的入口**里判断。
 *
 * ## 三种布局
 *
 * | 布局 | test/ 在？ | .git 在？ | 行为 |
 * | --- | --- | --- | --- |
 * | 源码仓库 | 是 | — | 跑全部套件 |
 * | 安装副本（发布包） | 否 | 否 | **exit 0**，说明这是安装副本、自测请克隆仓库 |
 * | 仓库但 test/ 被误删 | 否 | 是 | **exit 1**，明确说「包结构坏了」 |
 *
 * 第三行是关键的**负对照**：不能把所有"没有 test/"都当成"安装副本"，
 * 否则某天仓库里 test/ 被误删，`npm test` 会静默通过 —— 那比报错更糟。
 *
 * ## 套件清单从哪来
 *
 * 不再手写 24 条 `&&`：扫 `test/` 目录自动发现 `*.mjs`（跳过 `hooks.mjs` 与 `fixtures/`），
 * 按文件名排序依次跑。这样**新加测试文件自动进 CI**，不会因为"忘了改 package.json"而漏跑。
 *
 * @module scripts/run-tests
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const testDir = join(ROOT, 'test')
const hasTest = existsSync(testDir)
const isRepo = existsSync(join(ROOT, '.git'))

if (!hasTest) {
  if (isRepo) {
    console.error('[run-tests] 这是一个 git 仓库，但没有 test/ 目录 —— 包结构坏了。')
    console.error('[run-tests] 预期：' + testDir + ' 存在。请检查是否误删。')
    process.exit(1)
  }
  console.log('[run-tests] 这是**安装副本**（没有 test/，也没有 .git），没有测试可跑。')
  console.log('[run-tests] 要跑测试请克隆源码仓库：')
  console.log('             git clone https://github.com/DeZhou123/dsh-free-model.git')
  console.log('             cd dsh-free-model && npm test')
  process.exit(0)
}

/**
 * 默认**不跑**的套件（需要外部依赖，各有独立入口）。
 *
 * ## 为什么必须有这个名单（2026-10-28 02:05 实测）
 *
 * 自动发现第一版把 test/ 下 32 个 *.mjs 全跑了，结果 e2e-opencode.mjs 失败：
 * 它要连真实 OpenCode 服务（`http://127.0.0.1:4096`），而这不是"单元测试该有的前提"。
 * 原来的 package.json 里它就在 `test:e2e` 这条独立命令里，从来不在 `npm test` 里 ——
 * 自动发现把这条**人工划定的边界**弄丢了。
 *
 * 判据：需要外部进程 / 网络 / 真实 key 的套件必须显式列出，默认跳过。
 * 加新套件时如果它需要外部依赖，**记得加到这张表**（不加就会让 `npm test` 在别人机器上红）。
 */
const OPT_IN = new Set([
  'e2e-opencode.mjs',      // npm run test:e2e      需要真实 OpenCode 服务
  'opencode-affinity.mjs', // npm run test:affinity 同上
  'keyed-live.mjs',        // npm run test:live     需要真实 key，会花额度
  'service-start.mjs',     // npm run test:service  会起真实服务进程
  'boot-serve.mjs',        // 需要起 boot 服务
])

/** 收集套件：test/ 下（含子目录）的 *.mjs，跳过 hooks.mjs、fixtures/ 与 OPT_IN 名单。 */
function collect(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'fixtures' || entry.name === 'node_modules') continue
      collect(abs, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.mjs')) continue
    if (entry.name === 'hooks.mjs') continue
    if (OPT_IN.has(entry.name)) continue
    out.push(abs)
  }
  return out
}

const suites = collect(testDir)
if (suites.length === 0) {
  console.error('[run-tests] test/ 里没找到任何 *.mjs —— 这不正常，按失败处理。')
  process.exit(1)
}

/**
 * 每个套件独立起一个 node 进程：一个崩了不影响后面的，
 * 而且能看到「哪个套件崩了」而不是整串 `&&` 在第 7 个就停。
 */
let passed = 0
let failed = 0
const failedNames = []
for (const file of suites) {
  const rel = file.slice(ROOT.length).replace(/\\/g, '/')
  /**
   * `--import` 后面必须是 **URL**，不是 Windows 绝对路径 ——
   * 传 `E:\...\hooks.mjs` 会得到 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（把 `E:` 当成协议名）。
   * 第一版就是这么错的：32 个套件全部 fail，报错一模一样。
   */
  const hooksUrl = pathToFileURL(join(testDir, 'hooks.mjs')).href
  const r = spawnSync(process.execPath, ['--import', hooksUrl, file], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true,
  })
  const ok = r.status === 0
  if (ok) passed += 1
  else {
    failed += 1
    failedNames.push(rel)
    // 只把失败套件的输出打出来：全绿时不刷屏
    console.log('\n--- FAIL ' + rel + ' (exit ' + r.status + ') ---')
    console.log(String(r.stdout || '').trim().slice(-2000))
    console.log(String(r.stderr || '').trim().slice(-2000))
  }
}

console.log('\n[run-tests] 套件 ' + suites.length + ' 个：pass=' + passed + ' fail=' + failed)
if (failed > 0) {
  console.log('[run-tests] 失败：' + failedNames.join(', '))
  process.exit(1)
}
process.exit(0)

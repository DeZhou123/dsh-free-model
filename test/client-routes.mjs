/**
 * 「前端调的每条路由，后端都真的有」—— 静态一致性断言。
 *
 * ## 为什么值得单独一个套件
 *
 * 前端拼错一个路径、后端改个名字，**两边各自的测试都不会红**：client.js 的离线渲染测试
 * 不执行 `useEffect`（所以不发请求），后端的路由测试只测它自己那张表。
 * 结果是"打开页面点一下 → 404 → 页面显示一句看不懂的错误"，而这类错在 34 条渠道、
 * 十几个动作的页面上**很难靠手点发现**。
 *
 * 做法：从 client.js 里把所有 `call('<path>'…)` 抠出来（含模板串的静态前缀），
 * 与 routes.js 里显式比较的 path 集合对照。**只做静态比对**：不跑前端、不发网络。
 *
 * 用法：node test/client-routes.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
const routes = readFileSync(join(ROOT, 'src', 'routes.js'), 'utf8')

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

/** 前端调用的路径（只取字面量第一段，忽略任何变量拼接的尾部）。 */
function clientPaths() {
  const found = new Set()
  for (const match of client.matchAll(/call\('([^']+)'/g)) {
    const raw = match[1]
    if (!raw.startsWith('/')) continue
    found.add(raw)
  }
  return found
}

/** 后端显式比较过的路径（`routePath === '/x'` 与 `routePath === '/x'` 之外的等值判断）。 */
function serverPaths() {
  const found = new Set()
  for (const match of routes.matchAll(/routePath === '([^']+)'/g)) found.add(match[1])
  return found
}

const clientPathList = [...clientPaths()].sort()
const serverPathList = [...serverPaths()].sort()

check('前端调用的每条路径，后端都有一条等值判断（拼错就是 404）', () => {
  const server = new Set(serverPathList)
  const missing = clientPathList.filter((path) => !server.has(path))
  assert.deepEqual(missing, [], '前端在调后端没有的路径：' + missing.join(', '))
})

check('后端每条路径都有前端在调（有死路由时要么删掉、要么补前端入口）', () => {
  const used = new Set(clientPathList)
  const orphan = serverPathList.filter((path) => !used.has(path))
  // 少数路径是**只给别的插件/脚本用**的，允许白名单列出，但必须写清理由。
  const allowed = new Set([
    // 只给脚本/别的插件用的：登录轮询由页面在打开登录后按 state 调（这里走的是另一条入口），
    // /opencode/stop 与 /key/refresh 是「手动/脚本」入口 —— 页面没放按钮，但后台与排障脚本要能调。
    '/login/poll', '/opencode/stop', '/key/refresh',
  ])
  const unexpected = orphan.filter((path) => !allowed.has(path))
  assert.deepEqual(unexpected, [], '后端有前端从不调的路径：' + unexpected.join(', '))
})

check('路径风格统一：都以 / 开头、没有结尾斜杠、没有 query', () => {
  for (const path of [...clientPathList, ...serverPathList]) {
    assert.ok(path.startsWith('/'), path + ' 不是绝对路径')
    assert.equal(path.length > 1 && path.endsWith('/'), false, path + ' 有结尾斜杠')
    assert.equal(path.includes('?'), false, path + ' 把 query 拼进了路径（应当走 URLSearchParams）')
  }
})

check('新增的关键路由确实在两边都出现（0.6.0 的六个动作）', () => {
  for (const path of ['/health', '/health/reset', '/key/balance', '/key/try', '/key/probe-all', '/channels/toggle']) {
    assert.ok(serverPathList.includes(path), '后端缺 ' + path)
    assert.ok(clientPathList.includes(path), '前端没调 ' + path)
  }
})

console.log('\n通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ': ' + failure.message)
  console.log('pass=' + passed + ' fail=' + failures.length)
  process.exit(1)
}
console.log('前端调用 ' + clientPathList.length + ' 条路径 · 后端判断 ' + serverPathList.length + ' 条')
console.log('pass=' + passed + ' fail=0')
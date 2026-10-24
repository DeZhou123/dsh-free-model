/**
 * 自带 key / 免 key 车道的**真实装配**验证（用真实宿主包跑 `apply()`）。
 *
 * ## 为什么不能只靠离线断言
 *
 * `test/keyed/*.mjs` 断言的是模块**自己**的行为（目录形状、就绪判定、流式解析）。
 * 但「模块对了」不等于「插件真的会把它挂上去」—— 中间那段接线（`index.js` 的
 * `mountKeyedLanes`：`descriptors` → `mountAll` → `registerAdapterIdempotent`）
 * 只有真跑一遍 apply 才能证明。这一层出错的表现是：页面显示 21 条渠道、
 * 一条都调不通，而所有单测全绿。
 *
 * ## 断言两个方向
 *
 * 1. **免 key 渠道必须真被挂上**（`pollinations` 不需要凭据）—— 这是「自带 key」那一页
 *    唯一的可离线验证样本。
 * 2. **缺 key 的渠道一条都不许挂**，并且**必须**给出带凭据名的原因。
 *    随手把没 key 的车道挂上，会在模型选择器里留一列点了必然报错的模型 ——
 *    比不显示更糟（用户以为能用）。
 *
 * 用法：node test/host-keyed.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function hostModules() {
  const explicit = process.env.DSH_APP_MODULES
  if (explicit) return explicit
  const local = process.env.LOCALAPPDATA
  if (local) return join(local, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules')
  return join(homedir(), 'AppData', 'Local', 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules')
}

const APP = hostModules()
if (!existsSync(join(APP, '@deepseek-ai/dsh-llm'))) {
  console.log('SKIP: 找不到宿主包')
  process.exit(0)
}

const scope = join(ROOT, 'node_modules', '@deepseek-ai')
mkdirSync(scope, { recursive: true })
const created = []
for (const name of ['dsh-llm', 'dsh-credentials']) {
  const target = join(scope, name)
  if (existsSync(target)) continue
  symlinkSync(join(APP, '@deepseek-ai', name), target, 'junction')
  created.push(target)
}

let passed = 0
function check(label, ok, detail = '') {
  if (!ok) {
    console.error('  ✗ ' + label + (detail ? ' — ' + detail : ''))
    process.exitCode = 1
    return
  }
  passed += 1
  console.log('  ✓ ' + label)
}

try {
  const entry = await import('../index.js')
  const keyedEntry = await import('../src/lanes/keyed/index.js')

  /** 宿主 credentials 的替身：**故意什么都没有**，模拟「用户还没填任何 key」。 */
  const credentials = {
    async resolve() { return undefined },
    async set() {},
    async describe() { return { configured: false } },
    async unset() {},
    async read() { return undefined },
  }

  const adapters = new Map()
  const warnings = []
  const routes = []
  const ctx = {
    logger: { info() {}, warn: (m) => warnings.push(String(m)), error() {} },
    get: () => undefined,
    effect(factory) { factory(); return () => {} },
    inject(_deps, callback) { callback(ctx); return () => {} },
    credentials,
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) adapters.set(provider, adapter)
        return { replace() {} }
      },
    },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }

  entry.apply(ctx, {
    opencodeService: {
      client: () => undefined,
      async status() { return { running: false, port: 4096 } },
      async start() { return { running: false, error: 'stub' } },
      stop() { return { stopped: false } },
      async dispose() {},
    },
    catalogFetcher: null,   // 不联网（null = 这个运行时没有 fetch，见 remote.js 的接缝约定）
    updateFetcher: null,
    serviceProbeFetcher: null,
    autoCheckin: false,
  })

  // keyed 装载是异步的（`void mountKeyedLanes(...)`）：等它落地。
  // 轮询而不是固定 sleep：桩环境里它通常 50ms 内完成，固定等待会白等。
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (adapters.has('pollinations')) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  const rows = await keyedEntry.descriptors({ readCredential: () => undefined })
  const keyless = rows.filter((row) => row.apiKeyEnv === null || row.apiKeyEnv === undefined)
  const keyed = rows.filter((row) => typeof row.apiKeyEnv === 'string')

  check(`目录里有 ${rows.length} 条自带 key 车道（keyed ${keyed.length} / 免 key ${keyless.length}）`, rows.length >= 20)
  check('免 key 渠道（pollinations）真被挂上了适配器', adapters.has('pollinations'),
    'adapters=' + [...adapters.keys()].join(','))

  const notReady = keyed.filter((row) => row.ready === false)
  check('缺 key 的车道全部报未就绪', notReady.length === keyed.length,
    `未就绪 ${notReady.length}/${keyed.length}`)
  check('未就绪的原因必须能指导动作（带凭据名，或明确指出待填的占位符）',
    notReady.every((row) => {
      const reason = String(row.reason)
      // 两种合格的「可执行原因」：
      //   ① 提到要配的凭据名（用户的动作 = 去配这个变量）；
      //   ② 指出 baseURL 里还有 `{ACCOUNT_ID}` 这类占位符没填
      //      （cloudflare-workers-ai 就是这样一条 —— 它的凭据没问题，端点本身不可用）。
      // 只写「未就绪」三个字是**不合格**的：用户不知道下一步做什么。
      return reason.includes(row.apiKeyEnv) || /\{[A-Z_]+\}/.test(reason)
    }),
    notReady.filter((row) => {
      const reason = String(row.reason)
      return !(reason.includes(row.apiKeyEnv) || /\{[A-Z_]+\}/.test(reason))
    }).map((row) => `${row.id}:${row.reason}`).join(' | '))
  check('未就绪原因不是空话（每条至少 12 个字）',
    notReady.every((row) => String(row.reason).length >= 12),
    notReady.filter((row) => String(row.reason).length < 12).map((row) => row.id).join(','))
  check('缺 key 的车道一条都没挂上（不然模型选择器里会有一列必然报错的模型）',
    keyed.every((row) => !adapters.has(row.id)),
    [...adapters.keys()].join(','))

  // 三条老车道必须还在（这一轮改造不许把它们弄丢）。
  for (const id of ['buddy', 'workbuddy', 'opencode']) {
    check(`老车道 ${id} 仍在`, adapters.has(id))
  }
  check('HTTP 面已挂载', routes.some((route) => route.path === '/api/free-model'))

  // 一条 keyed 车道的**凭据名**必须出现在描述符里：页面靠它告诉用户去配哪个变量。
  const openrouter = rows.find((row) => row.id === 'openrouter-free')
  check('openrouter-free 报出凭据名 OPENROUTER_API_KEY', openrouter?.apiKeyEnv === 'OPENROUTER_API_KEY')
  check('每条 keyed 车道都给了 signupURL 与 docsURL（否则用户不知道去哪拿 key）',
    keyed.every((row) => typeof row.signupURL === 'string' && row.signupURL !== '')
      && keyed.every((row) => typeof row.docsURL === 'string' && row.docsURL !== ''))
  check('已下线的渠道没有进可挂载集合（github-models）',
    rows.every((row) => row.id !== 'github-models'), 'github-models 不该出现在描述符里')

  /**
   * 装配自证（`$DSH_HOME/free-model/apply-ok.json`）。
   *
   * 为什么值得断言：它是「插件到底装上了什么」**唯一**的落盘证据 ——
   * headless/CLI 模式不打 info 日志，事后问「昨天装上了吗」只能看它。
   * 而一条真实的教训是：第一版在卸载时删掉它，于是**一次性会话里永远看不到**。
   */
  const markerFile = join(homedir(), '.dsh', 'free-model', 'apply-ok.json')
  const marker = existsSync(markerFile) ? JSON.parse(readFileSync(markerFile, 'utf8')) : undefined
  check('装配自证被写出来（含版本与已挂路由）', marker !== undefined && marker.plugin === 'dsh-free-model',
    '没找到 ' + markerFile)
  if (marker !== undefined) {
    check('自证里的版本与 package.json 一致', marker.version === entry.version, `${marker.version} vs ${entry.version}`)
    check('自证记下了三条老车道 + 免 key 渠道',
      ['buddy', 'workbuddy', 'opencode', 'pollinations'].every((id) => marker.mountedRoutes.includes(id)),
      marker.mountedRoutes.join(','))
    // 「不含凭据」要按**值**判，不能按字段名判：自证里本来就有 `keyedMounted` / `keyedFailed`
// 这类字段名（含 "key" 三个字母），拿名字去匹配只会得到一个假的警报。
    check('自证里没有任何凭据**值**（只有路由名与计数）',
      !/(sk-[A-Za-z0-9]{6}|ghp_[A-Za-z0-9]{6}|eyJ[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9])/.test(JSON.stringify(marker)),
      JSON.stringify(marker).slice(0, 160))
  }

  console.log(`\n通过 ${passed} 项`)
  if (process.exitCode === undefined) console.log('全部通过')
} finally {
  for (const path of created) { try { rmSync(path, { recursive: true, force: true }) } catch {} }
  try { rmSync(join(ROOT, 'node_modules'), { recursive: true, force: true }) } catch {}
}
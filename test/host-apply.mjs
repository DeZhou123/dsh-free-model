/**
 * 用**真实宿主包**把 index.js 整个跑一遍 apply()。
 *
 * smoke.mjs 用的是 cordis 替身，抓不到「真实服务契约不匹配」这类错
 * （例如 LlmAdapter 基类方法签名、credentials.resolve 的返回形状）。
 * 这里用真实的 dsh-llm / dsh-credentials + 最小 ctx，确认插件能被宿主装起来。
 *
 * 用法：node test/host-apply.mjs
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

/**
 * 宿主包目录。优先读环境变量，其次按平台推断，最后退回本机默认安装位置。
 * 这样同一份测试在别人机器上也能跑（找不到就 SKIP，不算失败）。
 */
function hostModules() {
  const explicit = process.env.DSH_APP_MODULES
  if (explicit) return explicit
  const local = process.env.LOCALAPPDATA
  if (local) return join(local, "Programs", "DSH Desktop", "resources", "app", "node_modules")
  return join(homedir(), "AppData", "Local", "Programs", "DSH Desktop", "resources", "app", "node_modules")
}

const APP = hostModules()
if (!existsSync(join(APP, "@deepseek-ai/dsh-llm"))) {
  console.log("SKIP: 找不到宿主包")
  process.exit(0)
}

const scope = join(ROOT, "node_modules", "@deepseek-ai")
mkdirSync(scope, { recursive: true })
const created = []
for (const name of ["dsh-llm", "dsh-credentials"]) {
  const target = join(scope, name)
  if (existsSync(target)) continue
  symlinkSync(join(APP, "@deepseek-ai", name), target, "junction")
  created.push(target)
}

try {
  const entry = await import("../index.js")
  console.log("name:", entry.name, "| version:", entry.version)
  console.log("inject:", entry.inject.join(","))

  // 最小 cordis ctx：只实现插件真正调用的那几个方法。
  const adapters = new Map()
  const routes = []
  const warnings = []
  const effects = []
  let injections = []
  const credentials = {
    async resolve() { return undefined },
    async set() {},
    async describe() { return { configured: false } },
    async unset() {},
  }
  const ctx = {
    logger: { info() {}, warn: (m) => warnings.push(String(m)), error() {} },
    get: () => undefined,
    // cordis 的 effect 会**立即执行** factory 并把返回值当 dispose；
    // 这里照做，否则 webServer.register 永远不会被调用（路由为空）。
    effect(factory) { effects.push(factory); factory(); return () => {} },
    inject(_deps, callback) { injections.push(() => callback(ctx)); return () => {} },
    credentials,
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) adapters.set(provider, adapter)
        return { replace() {} }
      },
    },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }

  entry.apply(ctx, { opencodeService: {
    client: () => undefined,
    async status() { return { running: false, port: 4096 } },
    async start() { return { running: false, error: "stub" } },
    stop() { return { stopped: false } },
    async dispose() {},
  } })
  console.log("injections queued:", injections.length)
  for (const run of injections) {
    try {
      run()
    } catch (error) {
      console.log("  ! inject failed:", error.message)
      throw error
    }
  }

  console.log("adapters:", [...adapters.keys()].sort().join(","))
  console.log("routes:", routes.map((r) => r.path).join(","))
  console.log("warnings:", warnings.length)
  for (const line of warnings) console.log("  !", line.slice(0, 160))

  /**
 * ⚠️ 这里**故意**不写 `adapters.size === 3`（2026-10-25 独立复核指出的脆弱点）。
 *
 * `src/lanes/keyed/**` 的装载是 `void mountKeyedLanes(...)`（异步）：
 * 免 key 渠道（pollinations）不需要凭据，只要它在微任务队列里先落地，
 * 这里就会看到 **4** 条而不是 3 条。断言写死 3 会让这条测试**换台机器/慢盘就假失败**，
 * 而它要证明的其实是「三条老车道都在、且没多出不该有的东西」。
 *
 * 所以判据改成：三条老车道必须全部在（这才是契约），多出来的只允许是 keyed 目录里的 id。
 */
const REQUIRED_LANES = ['buddy', 'workbuddy', 'opencode']
for (const id of REQUIRED_LANES) {
  if (!adapters.has(id)) throw new Error("缺少车道 " + id + "（现有：" + [...adapters.keys()].sort().join(",") + "）")
}
const { KEYED_CHANNELS, KEYLESS_CHANNELS } = await import('../src/lanes/keyed/index.js')
const keyedIds = new Set([...KEYED_CHANNELS, ...KEYLESS_CHANNELS].map((lane) => lane.id))
for (const id of adapters.keys()) {
  if (REQUIRED_LANES.includes(id)) continue
  if (!keyedIds.has(id)) throw new Error("多出一条既不是老车道、也不在 keyed 目录里的适配器：" + id)
}
  if (routes.length !== 1) throw new Error("应注册 1 条路由")
  if (routes[0].path !== "/api/free-model") throw new Error("路由前缀不对: " + routes[0].path)

  // 三条车道都要能被宿主 llm 认出来（providerInfo 契约）。
  for (const [provider, adapter] of adapters) {
    const info = adapter.providerInfo(provider)
    if (info.id !== provider) throw new Error(provider + " 的 providerInfo.id 不匹配")
    console.log("  " + provider + " → " + info.name)
  }

  console.log("\nhost-apply OK")
} finally {
  for (const path of created) { try { rmSync(path, { recursive: true, force: true }) } catch {} }
  try { rmSync(join(ROOT, "node_modules"), { recursive: true, force: true }) } catch {}
}
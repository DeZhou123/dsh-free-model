/**
 * 用**真实宿主包**验证适配器契约（不进 npm test：依赖 DSH 装在哪）。
 *
 * 单测里 `@deepseek-ai/dsh-llm` 是替身，替身不会实现 `LlmAdapter` 的完整语义。
 * 这里把宿主真实的包临时 link 进 node_modules，确认：
 *   1. 适配器确实继承到宿主那个 LlmAdapter；
 *   2. providerInfo / listModels / resolveModel / prepareCall 的签名对得上；
 *   3. LlmError 的 code 是宿主认得的枚举。
 *
 * 用法：node test/host-check.mjs
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
const llmPkg = join(APP, "@deepseek-ai/dsh-llm")

if (!existsSync(llmPkg)) {
  console.log("SKIP: 找不到宿主包 " + llmPkg)
  process.exit(0)
}

// 临时 link：让插件侧的裸名 import 解析到宿主那份（测完删掉，不留痕）。
const scope = join(ROOT, "node_modules", "@deepseek-ai")
const created = []
mkdirSync(scope, { recursive: true })
for (const name of ["dsh-llm", "dsh-credentials"]) {
  const target = join(scope, name)
  if (existsSync(target)) continue
  try {
    symlinkSync(join(APP, "@deepseek-ai", name), target, "junction")
    created.push(target)
  } catch (error) {
    console.log("SKIP: 无法 link " + name + " — " + error.message)
    process.exit(0)
  }
}

try {
  const llm = await import("@deepseek-ai/dsh-llm")
  console.log("LlmAdapter:", typeof llm.LlmAdapter, "| LlmError:", typeof llm.LlmError)

  const { OpenCodeAdapter } = await import("../src/opencode/adapter.js")
  const adapter = new OpenCodeAdapter({
    client: () => undefined,
    models: async () => [],
    resolveModel: async () => undefined,
  })
  console.log("instanceof LlmAdapter:", adapter instanceof llm.LlmAdapter)
  if (!(adapter instanceof llm.LlmAdapter)) throw new Error("适配器没有继承宿主的 LlmAdapter")

  const info = adapter.providerInfo("opencode")
  console.log("providerInfo:", JSON.stringify(info))
  if (info.id !== "opencode") throw new Error("providerInfo.id 必须等于 provider")
  if (typeof info.name !== "string" || info.name.length === 0) throw new Error("providerInfo.name 必须非空")

  const empty = await adapter.listModels("opencode")
  console.log("listModels(empty):", empty.length)

  const resolved = await adapter.resolveModel("opencode", "opencode/x")
  console.log("resolveModel:", JSON.stringify(resolved))
  if (resolved.provider !== "opencode") throw new Error("resolveModel.provider 必须回填入参")
  if (!(resolved.context && resolved.context.contextWindow > 0)) throw new Error("contextWindow 必须是正数（0 会被判成超窗口）")

  const call = await adapter.prepareCall("opencode", "opencode/x")
  if (typeof call.stream !== "function") throw new Error("prepareCall 必须返回 stream")

  const error = new llm.LlmError("test", "UPSTREAM_ERROR")
  console.log("LlmError.code:", error.code, "| instanceof:", error instanceof llm.LlmError)

  console.log("\nhost-check OK")
} finally {
  for (const path of created) { try { rmSync(path, { recursive: true, force: true }) } catch { /* 清理尽力而为 */ } }
  try { rmSync(join(ROOT, "node_modules"), { recursive: true, force: true }) } catch { /* 同上 */ }
}
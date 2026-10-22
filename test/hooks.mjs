/**
 * 离线测试用的模块解析钩子：把两个内核包重定向到 `test/fixtures/`。
 *
 * 用法：
 *
 *     node --import ./test/hooks.mjs test/smoke.mjs
 *
 * ⚠️ 只在离线测试里注册。宿主运行时用的是它自己的 resolve 钩子
 * （DSH Desktop 的 `module-resolution`），两者互不干扰 ——
 * 本文件不会被插件入口 import，故不会进入运行路径。
 *
 * ⚠️ 钩子代码是 `data:` URL 模块，里面的 `import.meta.url` **不是** file: URL，
 * 相对路径解析会在 `new URL('.\/fixtures/x.mjs', import.meta.url)` 上抛
 * `ERR_INVALID_URL`。故地图在这里（file: 环境下）算好绝对 file: URL 再注入。
 */

import { register } from 'node:module'

const KERNEL_STUBS = new URL('./fixtures/kernel-stubs.mjs', import.meta.url).href
const CREDENTIALS_STUB = new URL('./fixtures/credentials-stub.mjs', import.meta.url).href

const hookSource = `
const MAP = {
  '@deepseek-ai/dsh-llm': '${KERNEL_STUBS}',
  '@deepseek-ai/dsh-credentials': '${CREDENTIALS_STUB}',
}
export async function resolve(specifier, context, nextResolve) {
  const mapped = MAP[specifier]
  if (mapped !== undefined) return { url: mapped, shortCircuit: true }
  return nextResolve(specifier, context)
}
`

register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url)

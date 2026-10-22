/**
 * 内核模块的**离线替身**（只给离线自测用，运行时永远用宿主真实的包）。
 *
 * ## 为什么需要
 *
 * 插件的两个 import 来自宿主：`@deepseek-ai/dsh-llm` 与
 * `@deepseek-ai/dsh-credentials`。宿主用 `module.register()` 的 resolve 钩子
 * 把它们映射到 DSH Desktop 的 node_modules；离线跑 `node test/smoke.mjs` 时
 * 没有那个钩子，这两个 specifier 就解析不到。
 *
 * ## 为什么不装到 workspace 根的 node_modules
 *
 * 那会把替身放进插件**真实**的模块查找路径（`dsh-free-model` 的上一级），
 * 一旦宿主那次解析回退到 Node 默认解析，就会加载到替身而不是内核 ——
 * `LlmAdapter` 是假类、`LlmError` 是假错误，症状会非常难查。
 *
 * 所以替身住在 `test/fixtures/` 里，由 `test/hooks.mjs` 的 resolve 钩子
 * **只在离线测试时**重定向过去。
 *
 * @module test/fixtures/kernel-stubs
 */

export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

/** 品牌函数：真实实现只做校验与标记，这里保留校验语义。 */
export const ReasoningEffortId = (id) => id
export const ToolCallId = (id) => id

/** 出站身份头（真实实现返回一包框架 UA）。 */
export const attributionHeaders = () => ({})

export function isContextWindowExceededError(detail) {
  return /context window|token limit/i.test(String(detail))
}

/** 适配器基类：只声明本插件真正 override 的那几个方法。 */
export class LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  imageRequestPricing() {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  listModels() {
    return Promise.resolve([])
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) }
  }
}

/** 错误类：形状与内核一致（`code` 是第一个位置参数）。 */
export class LlmError extends Error {
  constructor(message, code, extra) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    if (extra !== undefined && extra !== null) Object.assign(this, extra)
  }
}

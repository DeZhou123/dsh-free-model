/**
 * `ctx.llm.registerAdapter` 的**重启幂等**包装 + Token 记账包装。
 *
 * ## 为什么必须幂等
 *
 * cordis 会在配置 / patch 应用时序里**重启插件 fiber**：新 fiber 的同步 apply
 * 与旧 fiber 的异步 dispose 交错执行，两个调用方在 `directory` 这个 Map 上赛跑，
 * 稳定撞出：
 *
 * ```
 * LlmError: configurable provider "minimax" is already declared
 *   at registerConfigurableProviders (…/dsh-llm/lib/index.js)
 * ```
 *
 * 在重启场景下「同名注册已存在」意味着**上一轮同一个插件的注册**（同一代码），
 * 保留它、跳过本次提交是**语义等价**的。
 *
 * ⚠️ 这**不是**吞错误：非重复类失败照常抛出（配置错必须暴露）。
 * 也没有用「先查 directory 再注册」——查与注册之间存在同样的竞态窗口，
 * 只有 try/catch 能把检查与提交做成原子。
 *
 * ## ⚠️ 装两遍时必须让位
 *
 * 本插件与 OFM 的 channel-pack 会**同时**尝试注册 `buddy` / `workbuddy` 路由
 * （用户可能正在 OFM 2.5.7 上，那两个 provider 仍然活着）。后者先注册时，
 * 这里走重复分支让位 —— 不能反过来把 OFM 的路由顶掉，否则 OFM 的账号池、
 * 余额排名、网关转发全部失去后端。
 */

import { peekLedgerAccount, recordTokenUsage } from './ledger.js'

/** dsh-llm 对「configurable provider 已存在」抛的 code。**当前仅作防御**。 */
const DUPLICATE_DIRECTORY = 'DUPLICATE_DIRECTORY'

/**
 * 最近一次注册尝试的结果：provider → `'registered'` | `'yielded'`。
 *
 * ## 为什么需要它
 *
 * 用户可能还停在 OFM 2.5.7 上 —— 那时 `buddy` / `workbuddy` 两条路由**还是活的**，
 * 本插件必须让位（见 {@link registerAdapterIdempotent}）。但「让位」不等于
 * 「插件不该存在」：页面要能明确告诉用户**现在是 OFM 内置通道在跑**，
 * 否则用户会以为本插件坏了。
 *
 * 反过来，升级到 2.5.8 之后本插件才真正接管 —— 页面同一个位置要改口。
 * 这两种状态**必须能分辨**，所以把结果记下来。
 */
const registrationOutcome = new WeakMap()

/**
 * 本进程内**由本插件自己**注册成功的 provider。
 *
 * ## 为什么必须区分「自己」和「别人」
 *
 * cordis 的 `ctx.inject` 回调在依赖服务被替换时会**重跑**（例如 OFM 的
 * channel-pack 重启它的 fiber，`llm` 被重新发布）。重跑时我们的路由已经在了，
 * 于是 `registerAdapter` 抛重复错 —— 那一次的重复指的是**上一轮的自己**，
 * 语义完全等价（同一份代码），必须仍然算 `registered`。
 *
 * 不区分的话，页面会在第一次重跑后改口成「由 OFM 内置通道接管」，
 * 而实际上跑的还是本插件。
 */
const selfRegistered = new WeakMap()

/** 取某 provider 最近一次注册结果；没尝试过返回 `undefined`。 */
export function lastRegistrationOutcome(llm, provider) {
  return registrationOutcome.get(llm)?.get(provider)
}

/** 记一次结果（按 llm 实例分域）。 */
function markOutcome(llm, provider, outcome) {
  let bucket = registrationOutcome.get(llm)
  if (bucket === undefined) {
    bucket = new Map()
    registrationOutcome.set(llm, bucket)
  }
  bucket.set(provider, outcome)
}

/** 读/建「本插件注册成功过」的集合（按 llm 实例分域）。 */
function selfBucket(llm) {
  let bucket = selfRegistered.get(llm)
  if (bucket === undefined) {
    bucket = new Set()
    selfRegistered.set(llm, bucket)
  }
  return bucket
}

/**
 * 判断一个 LlmError 是否为「同名注册已存在」。
 *
 * ⚠ 判据**必须**含错误码 **或** 文案：dsh-llm 对 adapter 重复的抛错
 * （`an adapter for provider "x" is already declared`）用的不是
 * DUPLICATE_DIRECTORY 码，且不同 dsh 版本的码可能微调 —— 文案兜底保证
 * 跨版本行为一致。⚠ 只匹配精确语义，不碰泛词（否则会把真实配置错误吞掉）。
 */
export function isDuplicateRegistrationError(error) {
  if (typeof error !== 'object' || error === null) return false
  if (error.code === DUPLICATE_DIRECTORY) return true
  const message = error.message
  if (typeof message !== 'string') return false
  return /already declared|already registered|is already (?:a|an) adapter/.test(message)
}

/**
 * 把适配器包上 **Token 记账**。
 *
 * 包装只做三件事：
 * 1. 透传 `stream()` 产出的**每一个** chunk（逐帧 yield，不改内容、不改顺序）；
 * 2. 捕获 `type:'usage'` 的 chunk 写账本；
 * 3. 捕获抛错写账本，然后**原样再抛** —— 记账绝不吞错、也绝不反噬推理。
 *
 * ## ⚠️ 为什么用 Proxy 而不是 `{ ...adapter }` 展开
 *
 * 适配器是 **class 实例**，`providerInfo` / `listModels` / `resolveModel` 等
 * 方法都在**原型**上。对象展开只拷贝自有可枚举属性 —— 全部原型方法会被丢掉，
 * 于是 `listModels()` 变成 "not a function"，模型目录整体失效。
 */
export function wrapAdapterWithTokenLedger(providers, adapter) {
  const provider = providers[0] ?? ''
  const accountingStream = (options, open) => {
    const model = String(options?.model ?? '').slice(0, 160)
    return recordThroughStream(open, { channel: 'direct', provider, model, startedAt: Date.now() })
  }
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'stream') {
        // ⚠️ `this` 必须绑回**原适配器**（target 而不是 proxy）：真实适配器的
        // 私有字段（`#field`）对 proxy 的 this 不可见，绑 proxy 会抛 TypeError。
        return (options) => accountingStream(
          options,
          () => target.stream.call(target, options),
        )
      }
      /**
       * ⚠️⚠️ **必须同时包装 `prepareCall` 返回的 `call.stream`**。
       *
       * **生产路径只走这里**：dsh-llm 的 `adapterStream` 用
       * `adapter.prepareCall(...)` 拿到的 `adapterCall.stream(options)` 派发，
       * **从不直接调用顶层 `adapter.stream`**。
       *
       * 早先只拦顶层 `stream` 时，记账之所以「碰巧」生效，全靠各适配器的
       * `prepareCall` 恰好写成转发形式 `stream: (o) => this.stream(o)` ——
       * 一条**隐式依赖**：任何适配器改成持有闭包引用就会**静默失效**
       * （请求照常、账本永远为空）。已实测：闭包式 prepareCall 下记账 = 0 条。
       */
      if (prop === 'prepareCall') {
        const original = Reflect.get(target, prop, target)
        if (typeof original !== 'function') return original
        return async (...args) => {
          const call = await original.apply(target, args)
          if (call === null || typeof call !== 'object') return call
          const inner = call.stream
          if (typeof inner !== 'function') return call
          return {
            ...call,
            // ⚠️ 只包 `stream` 这一个字段，其余（modelInfo 等）原样透传。
            stream: (options) => accountingStream(
              options,
              () => inner.call(target, options),
            ),
          }
        }
      }
      return Reflect.get(target, prop, target)
    },
  })
}

/**
 * 包住一次流式调用的**记账骨架**。
 *
 * 语义：
 * - 正常结束且没等到 usage ⇒ 记 `usageReported: false`（显示 `—` 不显示 0）；
 * - 流内出现过 usage（哪怕 0 token）⇒ 记 `usageReported: true`；
 * - 抛错 ⇒ 记失败行后**原样再抛**；
 * - `finally` 兜底记 `durationMs`（cancel / 提前 return 也算一笔）。
 */
async function* recordThroughStream(openStream, meta) {
  let usageReported = false
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens
  let cacheWriteTokens
  let reasoningTokens
  /** 首个内容块耗时（0 = 还没有任何块）。 */
  let ttftMs = 0
  let accountId = ''
  let failure
  try {
    for await (const chunk of openStream()) {
      // ⚠️ 必须在具体类型判断**之前**：漏块会让「只有思考增量的慢启动」被记成 0。
      if (ttftMs === 0) ttftMs = Date.now() - meta.startedAt
      if (typeof chunk === 'object' && chunk !== null && chunk.type === 'usage') {
        const usage = chunk.usage
        if (typeof usage === 'object' && usage !== null) {
          usageReported = true
          inputTokens = Number(usage.inputTokens)
          outputTokens = Number(usage.outputTokens)
          if (Number(usage.cacheReadTokens) > 0) cacheReadTokens = Number(usage.cacheReadTokens)
          if (Number(usage.cacheWriteTokens) > 0) cacheWriteTokens = Number(usage.cacheWriteTokens)
          if (Number(usage.reasoningTokens) > 0) reasoningTokens = Number(usage.reasoningTokens)
          if (accountId === '') accountId = peekAccount(meta.provider)
        }
      }
      yield chunk
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    if (accountId === '') accountId = peekAccount(meta.provider)
    recordUsage({
      channel: meta.channel,
      provider: meta.provider,
      model: meta.model,
      ...(accountId.length > 0 ? { accountId } : {}),
      usageReported,
      inputTokens,
      outputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      ...(ttftMs > 0 ? { ttftMs } : {}),
      durationMs: Date.now() - meta.startedAt,
      ...(failure !== undefined ? { error: failure } : {}),
    })
  }
}

function peekAccount(provider) {
  return peekLedgerAccount(provider)
}

function recordUsage(entry) {
  recordTokenUsage(entry)
}

/**
 * 幂等版的 `ctx.llm.registerAdapter`。
 *
 * ⚠ 重复场景下的行为：保留现有 adapter 路由（重启竞态 / OFM 已注册）。
 * ⚠ 返回 dsh-llm 的 handle（含 `.replace()`）—— 重复分支没有 handle 可还，
 * 返回 `undefined`。
 */
export function registerAdapterIdempotent(llm, providers, adapter, warn) {
  const wrapped = typeof adapter === 'object' && adapter !== null
    ? wrapAdapterWithTokenLedger(providers, adapter)
    : adapter
  try {
    const handle = llm.registerAdapter(providers, wrapped)
    for (const provider of providers) {
      selfBucket(llm).add(provider)
      markOutcome(llm, provider, 'registered')
    }
    return handle
  } catch (error) {
    if (!isDuplicateRegistrationError(error)) throw error
    for (const provider of providers) {
      // 自己上一轮注册的：语义等价，仍算 registered（见 selfRegistered 的说明）。
      markOutcome(llm, provider, selfBucket(llm).has(provider) ? 'registered' : 'yielded')
    }
    warn?.(
      `[free-model] adapter for ${providers.map((p) => `"${p}"`).join(', ')} `
      + '已由其它实例注册（OFM 内置 channel-pack 或 fiber 重启竞态），保留现有路由并跳过本次注册',
    )
    return undefined
  }
}
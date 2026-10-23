/**
 * 把 OpenCode 的本地服务装成 DSH 的一个 provider。
 *
 * ## 定位：**无工具车道**，不是主模型
 *
 * opencode 的消息接口只接受 `tools: { [name]: boolean }` —— 那是它**内置工具**
 * 的开关表，不是 OpenAI 那种函数定义数组。整份 API 里没有任何入口能把调用方
 * 自己的工具 schema 传进去（`/doc` 实测：`PromptInput` 只有 text / files / agents）。
 *
 * 结论：这条车道**不能参与 DSH 的 agent loop**（loop 靠 tool call 工作）。
 * 它的正当用途是那些「一句话进、一句话出」的小请求：会话标题、压缩摘要、
 * 翻译、改写、代码解释。UI 上必须把这件事说清楚，否则用户会拿它当主模型，
 * 然后困惑于「为什么它不会读文件」。
 *
 * ## 为什么仍然值得做
 *
 * - 免费层模型（`opencode/*-free`）在本机是**合法调用方**才能用 —— 走 serve
 *   正好合法，直连会被拒（实测连 serve 自己都会收到 403，见
 *   {@link describeUpstreamFailure}）；
 * - 一条命令都不用用户敲：插件自己拉起 serve、自己管会话；
 * - 与 buddy 通道同页展示，用户一眼看到「哪条车道现在能用」。
 *
 * ## 2026-10-23 的四处修正（都有实测依据）
 *
 * 1. **system 走独立字段**，不再拼进 prompt。OpenAPI 里 `prompt_async` 的 body
 *    有 `system: string`，实测生效（让它只回 BANANA 就真的只回 BANANA）。
 * 2. **按 DSH 会话做亲和**。会话 key 从「模型」改成「DSH 会话 × 模型」：早先两个
 *    对话共用同一个 opencode session，而本适配器只发最后一条 user 消息，历史
 *    全靠 session 承载 —— 于是 B 对话会静默地带着 A 的历史。
 * 3. **能力来自上游声明**，不再硬编码 `['text']`。`/config/providers` 里
 *    9 个免费模型中有 4 个 `input.image: true`；图片用 `FilePartInput` 的
 *    `data:` URL 传（实测 204，上游确实收到了图）。
 * 4. **上游失败原样透传**。免费层 403 与「模型不存在」是两类完全不同的故障，
 *    早先都折成一句「免费层可能限流了」，用户只能反复重试。
 *
 * @module src/opencode/adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { OpenCodeClient, splitModelId, isFreeTierRejection, isQuotaExhausted } from './client.js'

/** 路由名：模型选择器里显示为 `opencode/*`。 */
export const OPENCODE_ROUTE = 'opencode'

/** 兜底上下文（模型自己会报真实上限，这里只防 undefined）。 */
const FALLBACK_CONTEXT = 200_000
const FALLBACK_MAX_OUTPUT = 32_000

/**
 * 把 DSH 的 messages 折成一段文本 + 本轮图片。
 *
 * opencode 的 `PromptInput` 只有一个 `text` 字段（外加文件/agent 附件），没有
 * 多轮结构 —— 会话历史由 opencode 自己的 session 保存。所以这里**只发本轮
 * 新增的那一句**，历史靠 session 复用自然延续。
 *
 * ⚠️ 但 DSH 的 loop 会在同一 session 里反复发「完整历史」。若把整段历史都塞进
 * text，opencode 侧就会看到「历史 + 它自己已保存的历史」= 重复。
 *
 * 图片附件单独收集：opencode 的 `FilePartInput` 接受 `data:` URL，所以图片
 * 不必降级成 `[图片]` 占位符 —— 只要该模型声明了 `input.image`。
 *
 * @param {readonly any[]} messages
 * @returns {{ prompt: string, system?: string, images: Array<{ attachment: any }> }}
 */
export function foldMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  const systems = []
  let prompt = ''
  let images = []
  for (const message of list) {
    if (message === null || typeof message !== 'object') continue
    const text = contentToText(message.content)
    if (message.role === 'system') {
      if (text !== '') systems.push(text)
      continue
    }
    if (message.role === 'user') {
      prompt = text
      // 只取**本轮**（最后一条 user）里的图片：历史里的图片已经在 opencode 的
      // session 里了，再发一次等于重复计费。
      images = collectImages(message.content)
    }
  }
  const result = { prompt, images }
  if (systems.length > 0) result.system = systems.join('\n\n')
  return result
}

/** 从一段 content 里挑出图片块（tool-result 内部递归）。 */
function collectImages(content) {
  const found = []
  if (!Array.isArray(content)) return found
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'image' && typeof block.attachment?.attachmentId === 'string') {
      found.push({ attachment: block.attachment })
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) found.push(...collectImages(block.content))
  }
  return found
}

/** 把任意 content 形状压成纯文本（tool-result / image 一律降级为占位）。 */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') { parts.push(block.text); continue }
    if (block.type === 'tool-result') { parts.push('[工具结果 ' + (block.toolCallId ?? '') + ']'); continue }
    if (block.type === 'image') { parts.push('[图片]'); continue }
  }
  return parts.join('\n')
}

/**
 * 把上游失败翻译成「用户能照着做」的一句话。
 *
 * ## 为什么不能笼统报「限流」
 *
 * 实测这台机器上，免费层是**结构性不通**的：
 *
 * ~~~
 * 403 FreeTierError: OpenCode's free tier can only be used from within
 *     OpenCode. Download it at https://opencode.ai and keep building.
 * ~~~
 *
 * 连 `opencode serve` 自己发出的请求都会被拒（试过 5 种 header 组合，全 403）。
 * 而 `ofm` provider 下那些模型（本地 OFM 网关）是通的。
 *
 * 把这两件事混成一句「免费层可能限流了」，用户会一直重试一件永远不会成功的事。
 * 所以这里按**故障类别**分开说，并给出该走哪条路。
 *
 * @param {string} message 上游原文
 * @param {string} modelKey 完整模型 id（用于提示换模型）
 */
export function describeUpstreamFailure(message, modelKey) {
  const text = String(message ?? '')
  if (isFreeTierRejection(text)) {
    return 'OpenCode 免费层拒绝了本次调用（403 FreeTierError）：这个上游只接受 OpenCode 客户端自身的请求，'
      + '而本机 opencode serve 也被同样拒绝 —— 说明该 build 的免费层通道已关闭，重试不会恢复。'
      + '可以改用 opencode 里已配置的其它 provider（例如本机 OFM 网关的 ofm/* 模型），'
      + '或把 opencode 更新到新的 build 后再试。'
  }
  if (/model not found/i.test(text)) {
    return 'OpenCode 里没有这个模型（' + modelKey + '）：它可能已被下架，或该 provider 未在本机配置。'
      + '点「刷新目录」重新读取，然后在模型选择器里换一个。'
  }
  // ⚠️ 「额度已用尽」必须排在「限流」**之前**：上游把 14018 的原文里带
  // "额度已用尽…等待不会恢复"，而它同时会被下面的 rate-limit 正则误伤。
  // 两者的处置完全相反：限流等一会儿会好，额度用尽等到天亮也不会好。
  if (/14018|额度已用尽|no available quota|quota exhausted/i.test(text)) {
    return '这条通道的账号额度已用尽（上游 code 14018，不是限流）：等待不会恢复，'
      + '需要换账号、换模型或换通道。上游原话：' + text.slice(0, 200)
  }
  // ⚠️ 「当日额度耗尽」必须排在「限流」**之前**，而且要和「身份拒绝」分开报：
  // 身份拒绝重试永不恢复；额度耗尽按天重置（UTC 0:00 = 北京 08:00）；限流等一两分钟。
  // 三种处置完全不同，混成一句「免费层可能限流了」会让用户一直重试错的那件事。
  if (isQuotaExhausted(text)) {
    return 'OpenCode 免费层的**当日额度**用完了（上游原文：' + text.slice(0, 140) + '）。'
      + '这不是身份问题，也不是限流：额度按天重置，**北京时间 08:00**（UTC 00:00）恢复。'
      + '在此之前重试不会成功，换同池的其它 *-free 模型通常也无效。'
      + '今天要继续就用 opencode 里已配置的其它 provider（例如本机 OFM 网关的 ofm/* 模型），或订阅 Go。'
  }
  // serve 自身的问题（超时 / 根本没在监听）：这两条是**本机**故障，不是上游拒绝，
  // 混进「限流」会让用户去等一个不会自己好的东西。
  if (/超时（\d+ms）|timed out/i.test(text)) {
    return '这次请求等超时了（原文：' + text.slice(0, 140) + '）。'
      + 'opencode 在上游限流时会长时间内部重试，所以超时既可能是上游慢，也可能是 serve 卡住。'
      + '先等一两分钟重试一次；如果每次都在同一时长上超时，去页面点「停止服务」再「启动服务」。'
  }
  if (/不可达|ECONNREFUSED|fetch failed/i.test(text)) {
    return '本机 opencode serve 没在监听（原文：' + text.slice(0, 140) + '）。'
      + '去设置页的 OpenCode 免费层面板点「启动服务」；若提示端口被占，插件会自动顺延端口，刷新目录即可。'
  }
  if (/rate limit|429|too many requests/i.test(text)) {
    return 'OpenCode 上游限流（' + text.slice(0, 160) + '）。等一两分钟再试，或换一个模型。'
  }
  return text === '' ? 'OpenCode 上游返回了空响应' : text
}

/**
 * OpenCode 车道适配器。
 *
 * 生命周期由 `index.js` 持有：服务在 apply 时探测一次，之后每次请求都重新读
 * —— serve 可能是插件启动之后才被用户拉起来的。
 */
export class OpenCodeAdapter extends LlmAdapter {
  /**
   * @param {{
   *   client: () => OpenCodeClient | undefined,
   *   models: () => Promise<Array<any>>,
   *   resolveModel: (id: string) => Promise<any>,
   *   readImage?: (attachment: any) => Promise<{ data: Uint8Array, mediaType: string }>,
   *   logger?: any,
   * }} options
   */
  constructor(options) {
    super()
    this.options = options
  }

  /** 路由展示名。id 必须等于 provider（DSH 会校验）。 */
  providerInfo(provider) {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : OPENCODE_ROUTE
    return { id, name: 'OpenCode 本地车道' }
  }

  /** 目录：只有 opencode 本地可调用的那批模型。 */
  async listModels(_provider) {
    const rows = await this.options.models()
    return rows.map((row) => ({
      provider: OPENCODE_ROUTE,
      id: row.id,
      name: row.name,
      // ⚠️ 能力来自上游声明（见 client.listModels）：硬编码 ['text'] 会把
      // 4 个能看图的免费模型说成"仅文本"，宿主于是把图片投影成 [图片] 占位。
      inputModalities: row.vision === true ? ['text', 'image'] : ['text'],
    }))
  }

  /** 单模型元数据。 */
  async resolveModel(provider, model, _signal) {
    const resolved = await this.options.resolveModel(model)
    const out = {
      provider,
      id: model,
      name: resolved?.name ?? model,
      inputModalities: resolved?.vision === true ? ['text', 'image'] : ['text'],
    }
    // 同上：0 是"未知"，不是"零窗口"。
    const contextWindow = Number.isFinite(resolved?.contextWindow) && resolved.contextWindow > 0
      ? resolved.contextWindow
      : FALLBACK_CONTEXT
    out.context = { contextWindow }
    out.defaultMaxTokens = Number.isFinite(resolved?.maxOutputTokens) && resolved.maxOutputTokens > 0
      ? resolved.maxOutputTokens
      : FALLBACK_MAX_OUTPUT
    return out
  }

  /** 绑定一代：把 model 元数据与 stream 固定在同一份配置上。 */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * 流式产出 DSH 的 chunk。
   *
   * chunk 形状与 buddy 适配器保持一致（block-start / text-delta /
   * reasoning-delta / block-end / usage / finish），这样 UI 侧的渲染、
   * 账本包装、终止判定全部沿用同一套代码。
   */
  async *stream(options) {
    const client = this.options.client()
    if (client === undefined) {
      throw new LlmError(
        'opencode: 本地服务未运行。请在「免费模型」页点「启动 OpenCode」，'
        + '或手动执行 opencode serve --port 4096。',
        'MISSING_CREDENTIAL',
      )
    }
    const modelKey = String(options?.model ?? '')
    if (modelKey === '') throw new LlmError('opencode: 未指定模型', 'INVALID_REQUEST')

    const { prompt, system, images } = foldMessages(options?.messages)
    if (prompt.trim() === '' && images.length === 0) {
      throw new LlmError('opencode: 本轮没有可发送的内容', 'INVALID_REQUEST')
    }

    // 图片：只在该模型真的声明了 image 输入时才发。否则宿主已经把图片投影成
    // 占位符（inputModalities 里没有 image），这里也就不会有 images。
    const encoded = []
    for (const item of images) {
      if (this.options.readImage === undefined) break
      try {
        const stored = await this.options.readImage(item.attachment)
        encoded.push({
          mime: stored.mediaType,
          data: Buffer.from(stored.data).toString('base64'),
          filename: item.attachment?.name ?? 'image',
        })
      } catch (error) {
        // 读不到图片不该打死整次请求：降级为文本提示。
        this.options.logger?.warn?.('[dsh-free-model] opencode 图片读取失败，降级为文本：'
          + (error instanceof Error ? error.message : String(error)))
      }
    }

    // ⚠️ providerID / modelID 取**目录行的权威值**，不靠切字符串：
    // ofm 下的模型 id 自带斜杠（buddy/deepseek-v4-flash），按第一个斜杠切会
    // 得到 provider=buddy，上游随即报 "Model not found"（实测）。
    const row = await this.options.resolveModel(modelKey)
    const providerID = typeof row?.providerID === 'string' ? row.providerID : undefined
    const modelID = typeof row?.modelID === 'string' ? row.modelID : undefined

    // ⚠️ 会话按「DSH 会话 × 模型」分域：见 client.sessionFor 的说明。
    const dshSession = typeof options?.sessionId === 'string' ? options.sessionId : ''
    const sessionID = await client.sessionFor(dshSession, modelKey)
    let index = 0
    let sawText = false
    let sawReasoning = false
    let usage
    let finishReason

    try {
      for await (const event of client.run(sessionID, {
        modelKey,
        ...(providerID !== undefined ? { providerID } : {}),
        ...(modelID !== undefined ? { modelID } : {}),
        prompt: prompt === '' ? '（见附图）' : prompt,
        ...(system !== undefined ? { system } : {}),
        ...(encoded.length > 0 ? { images: encoded } : {}),
        signal: options?.signal,
      })) {
        if (event.kind === 'error') {
          // 上游立刻失败：不再等 idle 超时，直接把可执行的结论抛出去。
          throw new LlmError(describeUpstreamFailure(event.message, modelKey), 'UPSTREAM_ERROR')
        }
        if (event.kind === 'done') {
          usage = event.tokens
          finishReason = event.finish
          // 上游把失败也标成 completed：这里必须抛，否则用户拿到的是一个
          // 空回答 + 一句"免费层可能限流"，而真实原因（免费层 403 / 模型不存在）
          // 全被吞掉。
          if (event.error !== undefined) {
            throw new LlmError(describeUpstreamFailure(event.error, modelKey), 'UPSTREAM_ERROR')
          }
          break
        }
        if (event.kind === 'reasoning') {
          if (!sawReasoning) {
            sawReasoning = true
            yield { type: 'block-start', index, blockType: 'reasoning' }
          }
          yield { type: 'reasoning-delta', index, text: event.text }
          continue
        }
        if (event.kind === 'text') {
          if (!sawText) {
            if (sawReasoning) index += 1
            sawText = true
            yield { type: 'block-start', index, blockType: 'text' }
          }
          yield { type: 'text-delta', index, text: event.text }
        }
      }
    } catch (error) {
      // 会话一旦出错就丢掉：下次请求重新建，避免带着坏历史继续。
      client.forgetSession(dshSession, modelKey)
      throw error instanceof LlmError
        ? error
        : new LlmError('opencode: ' + (error instanceof Error ? error.message : String(error)), 'UPSTREAM_ERROR', { cause: error })
    }

    if (usage !== undefined) yield { type: 'usage', usage }

    if (sawReasoning) {
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } }
    }
    if (sawText) {
      const textIndex = sawReasoning ? 1 : 0
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: '' } }
    }
    const blockCount = (sawReasoning ? 1 : 0) + (sawText ? 1 : 0)
    yield {
      type: 'finish',
      reason: blockCount > 0
        ? { kind: 'stop', ...(finishReason !== undefined ? { stopReason: finishReason } : {}) }
        : { kind: 'error', failure: { message: 'opencode 返回了空响应', code: 'EMPTY_RESPONSE' } },
    }
  }
}

export { splitModelId }

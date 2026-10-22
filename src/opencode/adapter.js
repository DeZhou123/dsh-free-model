/**
 * 把 OpenCode 的本地服务装成 DSH 的一个 provider。
 *
 * ## 定位：**纯文本车道**，不是主模型
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
 *   正好合法，直连会被拒（`OpenCode's free tier can only be used from within
 *   OpenCode`，实测）；
 * - 一条命令都不用用户敲：插件自己拉起 serve、自己管会话；
 * - 与 buddy 通道同页展示，用户一眼看到「哪条车道现在能用」。
 *
 * @module src/opencode/adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { OpenCodeClient, splitModelId } from './client.js'

/** 路由名：模型选择器里显示为 `opencode/*`。 */
export const OPENCODE_ROUTE = 'opencode'

/** 纯文本车道的兜底上下文（模型自己会报真实上限，这里只防 undefined）。 */
const FALLBACK_CONTEXT = 200_000
const FALLBACK_MAX_OUTPUT = 32_000

/**
 * 把 DSH 的 messages 折成一段文本。
 *
 * opencode 的 `PromptInput` 只有一个 `text` 字段（外加文件/agent 附件），没有
 * 多轮结构 —— 会话历史由 opencode 自己的 session 保存。所以这里**只发本轮
 * 新增的那一句**，历史靠 session 复用自然延续。
 *
 * ⚠️ 但 DSH 的 loop 会在同一 session 里反复发「完整历史」。若把整段历史都塞进
 * text，opencode 侧就会看到「历史 + 它自己已保存的历史」= 重复。因此取
 * **最后一条 user 消息**作为本轮输入，system 单独下发（opencode 支持 system 字段）。
 *
 * @param {readonly any[]} messages
 * @returns {{ prompt: string, system?: string }}
 */
export function foldMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  const systems = []
  let prompt = ''
  for (const message of list) {
    if (message === null || typeof message !== 'object') continue
    const text = contentToText(message.content)
    if (message.role === 'system') {
      if (text !== '') systems.push(text)
      continue
    }
    if (message.role === 'user') prompt = text
  }
  const result = { prompt }
  if (systems.length > 0) result.system = systems.join('\n\n')
  return result
}

/** 把任意 content 形状压成纯文本（tool-result / image 一律降级为占位）。 */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') { parts.push(block.text); continue }
    if (block.type === 'tool-result') { parts.push(`[工具结果 ${block.toolCallId ?? ''}]`); continue }
    if (block.type === 'image') { parts.push('[图片]'); continue }
  }
  return parts.join('\n')
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
    return { id, name: 'OpenCode 免费层（纯文本）' }
  }

  /** 目录：只有 opencode 本地可调用的那批模型。 */
  async listModels(_provider) {
    const rows = await this.options.models()
    return rows.map((row) => ({
      provider: OPENCODE_ROUTE,
      id: row.id,
      name: row.name,
      inputModalities: ['text'],
    }))
  }

  /** 单模型元数据。 */
  async resolveModel(provider, model, _signal) {
    const resolved = await this.options.resolveModel(model)
    const out = {
      provider,
      id: model,
      name: resolved?.name ?? model,
      inputModalities: ['text'],
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
   * chunk 形状与 buddy 适配器保持一致（`block-start` / `text-delta` /
   * `reasoning-delta` / `block-end` / `usage` / `finish`），这样 UI 侧
   * 的渲染、账本包装、终止判定全部沿用同一套代码。
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

    const { prompt, system } = foldMessages(options?.messages)
    if (prompt.trim() === '') throw new LlmError('opencode: 本轮没有可发送的文本内容', 'INVALID_REQUEST')

    const sessionID = await client.sessionFor(modelKey)
    let index = 0
    let sawText = false
    let sawReasoning = false
    let opened = false
    let usage

    try {
      // system 不能走 prompt_async 的 parts：它属于 message body 的字段，
      // 但 prompt_async 的 schema 没有 system —— 故把 system 前置进 text。
      // （实测 `POST /session/{id}/message` 支持 system 字段，但那条路径阻塞到
      // 生成完成，拿不到增量。折中：system 拼进 prompt 首部，语义等价。）
      const body = system !== undefined && system.trim() !== ''
        ? `${system.trim()}\n\n---\n\n${prompt}`
        : prompt
      for await (const event of client.run(sessionID, {
        modelKey,
        prompt: body,
        signal: options?.signal,
      })) {
        if (event.kind === 'done') {
          usage = event.tokens
          // 上游把失败也标成 completed：这里必须抛，否则用户拿到的是一个
          // 空回答 + 一句"免费层可能限流"，而真实原因（模型不存在 / 协议不支持 /
          // 账号未登录）全被吞掉。
          if (event.error !== undefined) {
            throw new LlmError(`opencode: ${event.error}`, 'UPSTREAM_ERROR')
          }
          break
        }
        if (event.kind === 'reasoning') {
          if (!opened) { opened = true }
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
      client.forgetSession(modelKey)
      throw error instanceof LlmError
        ? error
        : new LlmError(`opencode: ${error instanceof Error ? error.message : String(error)}`, 'UPSTREAM_ERROR', { cause: error })
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
        ? { kind: 'stop' }
        : { kind: 'error', failure: { message: 'opencode 返回了空响应（免费层可能已限流）', code: 'EMPTY_RESPONSE' } },
    }
  }
}

export { splitModelId }

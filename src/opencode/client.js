/**
 * OpenCode 本地服务的 HTTP 客户端。
 *
 * ## 为什么要这一层
 *
 * opencode 的 `serve` 暴露的是一套**会话式** API（建 session → 发 message →
 * 读回 assistant 消息），而不是 OpenAI 那种一次请求一次响应。要把它接成
 * DSH 的一个 provider，必须把「会话生命周期」这件事管起来：
 *
 * - 同一轮对话反复新建 session 会让服务端无限增长（每次 listModels 都建一个）；
 * - 会话 ID 一旦复用错，两路并发请求会互相污染历史；
 * - 免费层限流时 `POST /message` 会**内部重试很久**，没有 deadline 就永远不返回。
 *
 * ## 流式怎么来的
 *
 * opencode 的 `POST /session/{id}/message` 是**阻塞到生成完成**的。但它的
 * assistant 消息在生成过程中就能被 `GET /session/{id}/message` 读到
 * （parts 逐步增长、`info.time.completed` 尚未置位）。所以真正的流式做法是：
 *
 * 1. `POST /session/{id}/prompt_async`（204 立即返回）；
 * 2. 轮询 `GET /session/{id}/message`，按 part id 记住已发出的长度，只发增量；
 * 3. `info.time.completed` 出现即收尾，取 `info.tokens` 作 usage。
 *
 * 这条路径实测可用（2026-10-21）：prompt_async 返回 204，2 秒后能读到
 * reasoning part 已挂上、completed 仍为 false。
 *
 * @module src/opencode/client
 */

/** 单次 HTTP 的默认超时：免费层会内部重试，没有 deadline 会挂死。 */
const DEFAULT_TIMEOUT_MS = 180_000

/** 轮询间隔：opencode 自己按 token 增量写库，200ms 足够顺滑且不烧 CPU。 */
const POLL_INTERVAL_MS = 200

/** 连续多久没有新内容就判定上游卡死（不是错误，是给用户一个明确的失败）。 */
const IDLE_TIMEOUT_MS = 120_000

/** opencode 内置工具名（`/experimental/tool/ids` 实测值）。 */
export const OPENCODE_TOOLS = Object.freeze([
  'invalid', 'question', 'bash', 'read', 'glob', 'grep', 'edit', 'write',
  'task', 'webfetch', 'todowrite', 'websearch', 'skill', 'apply_patch',
])

/** 全部关掉的工具开关表：本通道只做纯文本，绝不让 opencode 动用户的文件。 */
export function toolsDisabled() {
  const table = {}
  for (const name of OPENCODE_TOOLS) table[name] = false
  return table
}

/**
 * 一个 `{providerID, modelID}` 对：opencode 的模型 id 形如 `opencode/big-pickle`。
 *
 * @param {string} raw 完整 id（含斜杠）
 * @param {string} [fallbackProvider] 没有斜杠时的默认 provider
 */
export function splitModelId(raw, fallbackProvider = 'opencode') {
  const text = String(raw ?? '')
  const slash = text.indexOf('/')
  if (slash <= 0 || slash === text.length - 1) {
    return { providerID: fallbackProvider, modelID: text }
  }
  return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) }
}

/** 只接受**正**的有限数；0 与 undefined 一律当"未知"。 */
function positiveNumber(value) {
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** 拼接 base URL 与路径（避免双斜杠）。 */
function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`
}

/**
 * OpenCode 服务客户端。
 *
 * 每个实例持有一个 base URL 与一组按模型分域的空闲会话；`dispose()` 时把
 * 自己建的会话全部删掉 —— 不给服务端留垃圾。
 */
export class OpenCodeClient {
  /**
   * @param {{ baseUrl: string, timeoutMs?: number, fetchImpl?: Function, logger?: any }} options
   */
  constructor(options) {
    this.baseUrl = String(options.baseUrl ?? 'http://127.0.0.1:4096').replace(/\/+$/, '')
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.logger = options.logger
    /** modelKey -> sessionID（按模型复用，避免每轮新建会话） */
    this.sessions = new Map()
    /** 本实例创建过的全部会话（dispose 时清理） */
    this.created = new Set()
  }

  /** 低层请求：统一超时 + 统一错误文案（错误里带路径，方便用户自查）。 */
  async request(path, init = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response
    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, path), { ...init, signal: controller.signal })
    } catch (error) {
      clearTimeout(timer)
      if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
        throw new Error(`OpenCode ${path} 超时（${this.timeoutMs}ms）：免费层限流时会长时间重试，可稍后再试或换模型`)
      }
      throw new Error(`OpenCode 不可达（${this.baseUrl}）：${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    clearTimeout(timer)
    if (!response.ok) {
      let detail = text
      try {
        const parsed = JSON.parse(text)
        detail = parsed?.data?.message ?? parsed?.message ?? text
      } catch { /* 非 JSON 错误体：原样截断 */ }
      throw new Error(`OpenCode ${path} → HTTP ${response.status}：${String(detail).slice(0, 300)}`)
    }
    if (text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /** 健康检查：`{ healthy, version }`；不可达时返回 `{ healthy: false, error }`。 */
  async health() {
    try {
      const payload = await this.request('/global/health', { method: 'GET' })
      return {
        healthy: payload?.healthy === true,
        version: typeof payload?.version === 'string' ? payload.version : undefined,
      }
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 模型清单。
   *
   * `/api/model` 一次返回 9000+ 条（含全部云端 provider），对本插件毫无用处；
   * 只保留**本地可调用**的那一档：`providerID` 属于 opencode 自带的免费层
   * （`opencode`），或调用方显式加入的 provider（例如把 OFM 网关挂进 opencode 后
   * 出现的 `ofm`）。判断依据是 `api.type === 'aisdk'` 且 `cost` 全 0 或 providerID
   * 在允许表里。
   *
   * @param {{ providers?: string[] }} [filter]
   */
  async listModels(filter = {}) {
    const payload = await this.request('/api/model', { method: 'GET' })
    const rows = Array.isArray(payload?.data) ? payload.data : []
    const allowed = new Set(filter.providers ?? ['opencode'])
    const seen = new Set()
    const models = []
    for (const row of rows) {
      const providerID = typeof row?.providerID === 'string' ? row.providerID : ''
      const id = typeof row?.id === 'string' ? row.id : ''
      if (providerID === '' || id === '') continue
      if (!allowed.has(providerID)) continue
      if (row.enabled === false) continue
      const key = `${providerID}/${id}`
      if (seen.has(key)) continue
      seen.add(key)
      models.push({
        id: key,
        providerID,
        modelID: id,
        name: typeof row.name === 'string' && row.name.length > 0 ? row.name : key,
        // ⚠️ 上游对本地/聚合 provider 常下发 `limit: { context: 0, output: 0 }`，
        // 而 0 是"未知"不是"零窗口"。不挡住会让 resolveModel 返回 contextWindow: 0，
        // 宿主据此把请求判成超上下文窗口（实测：`ofm/codearts/glm-5.3` 就是 0）。
        contextWindow: positiveNumber(row?.limit?.context),
        maxOutputTokens: positiveNumber(row?.limit?.output),
        vision: Array.isArray(row?.capabilities?.input) && row.capabilities.input.includes('image'),
      })
    }
    models.sort((a, b) => a.id.localeCompare(b.id))
    return models
  }

  /** 取（或建）某模型专属的会话。 */
  async sessionFor(modelKey, title) {
    const cached = this.sessions.get(modelKey)
    if (cached !== undefined) return cached
    const created = await this.request('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: title ?? `dsh-free-model ${modelKey}` }),
    })
    const id = typeof created?.id === 'string' ? created.id : ''
    if (id === '') throw new Error('OpenCode 建会话失败：响应里没有 session id')
    this.sessions.set(modelKey, id)
    this.created.add(id)
    return id
  }

  /** 丢弃某模型的会话（下次请求重新建）。 */
  forgetSession(modelKey) {
    this.sessions.delete(modelKey)
  }

  /** 读某会话的全部消息（`[{ info, parts }]`）。 */
  async messages(sessionID) {
    const payload = await this.request(`/session/${encodeURIComponent(sessionID)}/message`, { method: 'GET' })
    return Array.isArray(payload) ? payload : []
  }

  /** 异步投递一条提示（204，立即返回）。 */
  async promptAsync(sessionID, body) {
    await this.request(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** 中断会话（用户取消时调用）。 */
  async abort(sessionID) {
    try {
      await this.request(`/session/${encodeURIComponent(sessionID)}/abort`, { method: 'POST' })
    } catch { /* 中断是尽力而为：会话可能已经结束 */ }
  }

  /**
   * 跑一次完整生成，按增量产出事件。
   *
   * 事件形状（与 DSH 的 chunk 解耦，由适配器负责翻译）：
   * - `{ kind: 'reasoning', text }`
   * - `{ kind: 'text', text }`
   * - `{ kind: 'done', tokens, finish }`
   *
   * @param {string} sessionID
   * @param {{ modelKey: string, prompt: string, signal?: AbortSignal }} options
   */
  async *run(sessionID, options) {
    const { providerID, modelID } = splitModelId(options.modelKey)
    await this.promptAsync(sessionID, {
      model: { providerID, modelID },
      parts: [{ type: 'text', text: options.prompt }],
      // ⚠️ 工具全关：本通道是纯文本模型。opencode 的 `build` agent 默认带
      // bash / write / edit，一旦放开，模型会真的在用户机器上执行命令 ——
      // 而 DSH 侧的 tool call 又拿不到它的结果（两套工具协议不互通）。
      tools: toolsDisabled(),
    })

    /** partID -> 已发出的字符数（只发增量） */
    const emitted = new Map()
    const startedAt = Date.now()
    let lastGrowthAt = Date.now()
    let assistantID = ''

    while (true) {
      if (options.signal?.aborted) {
        await this.abort(sessionID)
        throw options.signal.reason ?? new Error('aborted')
      }
      const list = await this.messages(sessionID)
      // 只认本轮的那条 assistant 消息：prompt 发出后出现的最新 assistant。
      let target
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const message = list[index]
        if (message?.info?.role === 'assistant') { target = message; break }
      }
      if (target === undefined) {
        if (Date.now() - startedAt > IDLE_TIMEOUT_MS) throw new Error('OpenCode 迟迟没有开始响应（可能是免费层限流）')
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        continue
      }
      const messageID = String(target.info?.id ?? '')
      if (assistantID === '') assistantID = messageID
      if (messageID !== assistantID) {
        // 出现了新的 assistant 消息：说明上一轮被服务端另起了一条，跟着新的走。
        assistantID = messageID
        emitted.clear()
      }

      let grew = false
      for (const part of Array.isArray(target.parts) ? target.parts : []) {
        const partID = String(part?.id ?? '')
        if (partID === '') continue
        const type = part?.type
        if (type !== 'text' && type !== 'reasoning') continue
        const full = typeof part.text === 'string' ? part.text : ''
        const sent = emitted.get(partID) ?? 0
        if (full.length <= sent) continue
        emitted.set(partID, full.length)
        grew = true
        yield { kind: type, text: full.slice(sent) }
      }
      if (grew) lastGrowthAt = Date.now()

      const completed = target?.info?.time?.completed !== undefined
      if (completed) {
        yield {
          kind: 'done',
          tokens: normalizeTokens(target.info?.tokens),
          finish: target.info?.finish,
          // ⚠️ 上游失败时 opencode 仍然把这条消息标成 completed，错误挂在
          // `info.error` 上（实测：免费层限流是 `AI_APICallError: Rate limit
          // exceeded`）。不带出来就只能对用户猜「可能限流了」—— 而真实原因
          // 可能是模型不存在、协议不支持、账号没登录。原样透传才是可诊断的。
          error: upstreamError(target.info?.error),
        }
        return
      }
      if (Date.now() - lastGrowthAt > IDLE_TIMEOUT_MS) {
        await this.abort(sessionID)
        throw new Error('OpenCode 生成中断：长时间没有新内容')
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }

  /** 删掉本实例建过的全部会话。 */
  async dispose() {
    for (const id of this.created) {
      try {
        await this.request(`/session/${encodeURIComponent(id)}`, { method: 'DELETE' })
      } catch { /* 服务端可能已经没了：清理是尽力而为 */ }
    }
    this.created.clear()
    this.sessions.clear()
  }
}

/**
 * 从 opencode 的 `info.error` 里抽一条人能读的原因。
 *
 * 形状实测有两种：字符串（`"AI_APICallError: Rate limit exceeded..."`），
 * 或对象（`{ name, data: { message } }`）。抽不出来就返回 undefined。
 */
function upstreamError(error) {
  if (error === undefined || error === null) return undefined
  if (typeof error === 'string') return error.slice(0, 400)
  if (typeof error === 'object') {
    const message = error?.data?.message ?? error?.message ?? error?.name
    if (typeof message === 'string' && message.length > 0) return message.slice(0, 400)
  }
  return undefined
}

/**
 * 把 opencode 的 tokens 形状归一成 DSH 的 usage。
 *
 * opencode: `{ total, input, output, reasoning, cache: { read, write } }`
 * DSH: `{ inputTokens, outputTokens, reasoningTokens?, cacheReadTokens?, cacheWriteTokens? }`
 *
 * ⚠️ `input` 在 opencode 里**已扣除缓存命中**（实测：input 5217 + cache.read 2368
 * = 7585 ≈ total 7635），与 DSH 的 `inputTokens` 语义一致，直接透传即可。
 */
export function normalizeTokens(tokens) {
  if (tokens === null || typeof tokens !== 'object') return undefined
  const usage = {
    inputTokens: Number.isFinite(tokens.input) ? tokens.input : 0,
    outputTokens: Number.isFinite(tokens.output) ? tokens.output : 0,
  }
  if (Number.isFinite(tokens.reasoning) && tokens.reasoning > 0) usage.reasoningTokens = tokens.reasoning
  const read = tokens.cache?.read
  if (Number.isFinite(read) && read > 0) usage.cacheReadTokens = read
  const write = tokens.cache?.write
  if (Number.isFinite(write) && write > 0) usage.cacheWriteTokens = write
  return usage
}

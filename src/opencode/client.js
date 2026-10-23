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
 * - 免费层限流时上游会**内部重试很久**，没有 deadline 就永远不返回。
 *
 * ## 流式怎么来的（2026-10-23 重写）
 *
 * 早先的实现是**轮询** `GET /session/{id}/message`：按 part id 记住已发出的
 * 长度，只发增量。能work，但粒度是「上游写库的节奏」，实测同一 3 秒窗口里只有
 * 3 次 part 更新 —— 用户看到的是整段整段跳。
 *
 * 现在走 **SSE**（`GET /event`，与市场里 18 个插件同一做法）：
 *
 * - `message.part.delta` 是**真 token 增量**（实测 26 帧 / 3 秒，约 40ms 一帧）；
 * - `message.updated` 带 `info.tokens`，收尾时取 usage；
 * - `session.error` **立刻**给出真实失败原因（免费层 403、模型不存在），
 *   不必等 120 秒 idle 超时才报「可能限流了」；
 * - `session.idle` 是可靠的收尾信号（比轮询 `time.completed` 早）。
 *
 * 轮询保留为**降级路径**：老版本 serve 没有 /event，或 SSE 连接被中间层掐断时，
 * 自动回退，不让一次升级把整条车道打死。
 *
 * ## 模型目录从哪来（2026-10-23 修正）
 *
 * `/api/model` 一次返回 8887 条（全部云端 provider），其中 752 条属于本机
 * 配置的两个 provider —— 但**只有 /config/providers 里出现过的才真能调用**。
 * 实测：`opencode/space-bunny-free` 在 /api/model 里存在，prompt 却回
 * `Model not found`；而 /config/providers 里那 9 条全部可用。
 *
 * 所以目录改读 `/config/providers`：一次拿全「已配置 + 能力 + 限额」，
 * 体积 471KB（/api/model 的 1/10），且不会给用户列出一堆点了就报错的模型。
 *
 * @module src/opencode/client
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 单次 HTTP 的默认超时：上游会内部重试，没有 deadline 会挂死。 */
const DEFAULT_TIMEOUT_MS = 180_000

/** 失败状态落盘的 schema 标识（改结构时记得一起改）。 */
const FAILURE_SCHEMA = 'dsh-free-model/opencode-failures/v1'

/** 「other」类失败的保留时长：一天，够用户第二天回来还能看见，又不会变成陈年旧账。 */
const FAILURE_OTHER_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 下一个 UTC 零点（= 北京时间 08:00）。
 *
 * opencode 免费层的**当日额度**按这个时刻重置（实测 retry-after 正好指向 UTC 午夜），
 * 所以落盘时把 resetAt 记下来，页面才能说「今天没戏了，早上 8 点后自动恢复」。
 */
export function nextUtcMidnight(nowMs = Date.now()) {
  const d = new Date(nowMs)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0)).toISOString()
}

/** 轮询降级路径的间隔：200ms 足够顺滑且不烧 CPU。 */
const POLL_INTERVAL_MS = 200

/** 连续多久没有新内容就判定上游卡死（不是错误，是给用户一个明确的失败）。 */
const IDLE_TIMEOUT_MS = 120_000

/** opencode 内置工具名（`/experimental/tool/ids` 实测值，1.19.3）。 */
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
 * 一个 provider/model 对：opencode 的模型 id 形如 `opencode/big-pickle`。
 *
 * ⚠️ `ofm` provider 下的模型 id **自带斜杠**（`buddy/deepseek-v4.1-flash`），
 * 所以这里只按**第一个**斜杠切分 —— 后面的一律算 modelID。
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
  return String(base).replace(/\/+$/, '') + path
}

/**
 * 免费层被上游拒绝的固定特征。
 *
 * 实测原文：`OpenCode's free tier can only be used from within OpenCode`。
 * 这不是「限流」，是**调用方身份**问题 —— serve 自己的请求也被拒，说明这条通道
 * 在当前 build 上根本不通。必须与限流分开报，否则用户会一直重试。
 */
const FREE_TIER_MARK = /free tier can only be used from within opencode/i

/**
 * OpenCode 服务客户端。
 *
 * 每个实例持有一个 base URL 与一组按 (DSH 会话, 模型) 分域的会话；
 * `dispose()` 时把自己建的会话全部删掉 —— 不给服务端留垃圾。
 */
export class OpenCodeClient {
  /**
   * @param {{
   *   baseUrl: string,
   *   timeoutMs?: number,
   *   fetchImpl?: Function,
   *   logger?: any,
   *   sse?: boolean,
   * }} options
   */
  constructor(options) {
    this.baseUrl = String(options.baseUrl ?? 'http://127.0.0.1:4096').replace(/\/+$/, '')
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.logger = options.logger
    /** 是否尝试 SSE（默认开；探测失败自动关掉，见 markSseUnavailable）。 */
    this.sseEnabled = options.sse !== false
    /** sessionKey（DSH 会话 + 模型）→ opencode sessionID。 */
    this.sessions = new Map()
    /** 本实例创建过的全部会话（dispose 时清理）。 */
    this.created = new Set()
    /** 运行时读到的工具开关表（读一次就缓存；读不到时保持 undefined）。 */
    this.toolTableCache = undefined
    /**
     * 按 provider 记录「上游为什么调不通」。
     *
     * 页面要能说清「免费层在这台机器上被拒」而不是笼统的「失败」——
     * 否则用户会一直点重试。key 是 providerID，value 是最近一次原因。
     */
    this.providerFailures = new Map()
    /**
     * 失败状态落盘位置（可选）。
     *
     * 不传就是纯内存 —— 与旧行为完全一致，测试里的替身因此不需要动。
     */
    this.stateFile = typeof options.stateFile === 'string' && options.stateFile !== '' ? options.stateFile : undefined
    this.loadFailures()
  }

  /**
   * 失败状态读回（2026-10-24 新增）。
   *
   * ## 为什么必须落盘
   *
   * 上游的两种拒绝里，**「调用方身份被拒」是结构性的**：重试永远不会好，只能换通道
   * 或升级 build。可这份结论原先只活在内存 Map 里 —— 宿主一重启，页面又重新显示
   * 「可点」，用户就会再试一遍永远不会成功的事。额度耗尽同理：它按天重置，页面该说
   * 的是「今天没戏了」，而不是「刚刚失败了一下」。
   *
   * ## 过期规则
   *
   * - `quota`（当日额度用尽）：到 `resetAt` 自动作废（UTC 0:00 = 北京 08:00）；
   * - `identity`（身份被拒）：**不作废** —— 它是 build 级事实；
   * - `other`：24 小时后作废。
   */
  loadFailures() {
    if (this.stateFile === undefined) return
    let raw
    try {
      raw = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch {
      return
    }
    const entries = raw?.entries
    if (entries === null || typeof entries !== 'object') return
    const now = Date.now()
    for (const [providerID, entry] of Object.entries(entries)) {
      if (entry === null || typeof entry !== 'object') continue
      if (isPersistedFailureExpired(entry, now)) continue
      if (typeof entry.message === 'string' && entry.message !== '') {
        this.providerFailures.set(providerID, entry.message)
      }
    }
  }

  /** 把当前失败表写盘：原子（先写 .tmp 再 rename），任何 IO 失败都不影响推理。 */
  persistFailures() {
    if (this.stateFile === undefined) return
    const now = Date.now()
    const entries = {}
    for (const [providerID, message] of this.providerFailures) {
      const text = String(message ?? '')
      const kind = isQuotaExhausted(text) ? 'quota' : isFreeTierRejection(text) ? 'identity' : 'other'
      const entry = { message: text, kind, at: new Date(now).toISOString() }
      if (kind === 'quota') entry.resetAt = nextUtcMidnight(now)
      entries[providerID] = entry
    }
    const payload = { schema: FAILURE_SCHEMA, savedAt: new Date(now).toISOString(), entries }
    const tmp = this.stateFile + '.tmp'
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(tmp, JSON.stringify(payload, null, 2))
      renameSync(tmp, this.stateFile)
    } catch (error) {
      this.logger?.warn?.('opencode 失败状态写盘失败：' + (error instanceof Error ? error.message : String(error)))
    }
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
        throw new Error('OpenCode ' + path + ' 超时（' + this.timeoutMs + 'ms）：上游限流时会长时间重试，可稍后再试或换模型')
      }
      throw new Error('OpenCode 不可达（' + this.baseUrl + '）：' + (error instanceof Error ? error.message : String(error)))
    }
    const text = await response.text()
    clearTimeout(timer)
    if (!response.ok) {
      let detail = text
      try {
        const parsed = JSON.parse(text)
        detail = parsed?.data?.message ?? parsed?.message ?? parsed?.error?.message ?? text
      } catch { /* 非 JSON 错误体：原样截断 */ }
      throw new Error('OpenCode ' + path + ' → HTTP ' + response.status + '：' + String(detail).slice(0, 300))
    }
    if (text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /** 健康检查：healthy / version；不可达时返回 healthy:false 与原因。 */
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
   * 已配置的 provider 及其模型（/config/providers）。
   *
   * 返回的每个模型都带 capabilities（toolcall / input.image）与 limit，
   * 这是本插件**唯一**可信的目录来源 —— /api/model 里那些没被配置的模型调不动。
   */
  async providers() {
    const payload = await this.request('/config/providers', { method: 'GET' })
    const rows = Array.isArray(payload?.providers) ? payload.providers : []
    return rows.map((provider) => {
      const models = provider?.models !== null && typeof provider?.models === 'object'
        ? Object.values(provider.models)
        : []
      return {
        id: typeof provider?.id === 'string' ? provider.id : '',
        name: typeof provider?.name === 'string' ? provider.name : String(provider?.id ?? ''),
        source: typeof provider?.source === 'string' ? provider.source : undefined,
        models,
      }
    }).filter((provider) => provider.id !== '')
  }

  /**
   * 模型清单（只含**已配置、可调用**的那些）。
   *
   * @param {{ providers?: string[] }} [filter] 允许的 providerID；缺省 ['opencode']
   */
  async listModels(filter = {}) {
    const allowed = new Set(filter.providers ?? ['opencode'])
    const groups = await this.providers()
    const models = []
    const seen = new Set()
    for (const group of groups) {
      if (!allowed.has(group.id)) continue
      for (const row of group.models) {
        const id = typeof row?.id === 'string' ? row.id : ''
        if (id === '') continue
        // ⚠️ ofm 下的模型 id 自带斜杠，不能再拼 providerID 前缀，
        // 否则会得到 ofm/ofm/buddy/x 这种不可解析的串。
        const key = id.includes('/') && group.id === 'ofm' ? id : group.id + '/' + id
        if (seen.has(key)) continue
        seen.add(key)
        models.push({
          id: key,
          providerID: group.id,
          modelID: id,
          name: typeof row?.name === 'string' && row.name.length > 0 ? row.name : key,
          // 上游对聚合 provider 常下发 limit.context = 0，0 是"未知"不是"零窗口"。
          contextWindow: positiveNumber(row?.limit?.context),
          maxOutputTokens: positiveNumber(row?.limit?.output),
          // 能力来自上游声明，不再由本插件猜：早先硬编码 ['text'] 把 7 个能看图的
          // 免费模型全说成了"仅文本"。
          vision: row?.capabilities?.input?.image === true
            || (Array.isArray(row?.capabilities?.input) && row.capabilities.input.includes('image')),
          toolcall: row?.capabilities?.toolcall === true
            || row?.capabilities?.tools === true,
          cost: Array.isArray(row?.cost) ? row.cost[0] : row?.cost,
        })
      }
    }
    models.sort((a, b) => a.id.localeCompare(b.id))
    return models
  }

  /**
   * 取（或建）某「DSH 会话 × 模型」专属的会话。
   *
   * ## 为什么要带上 DSH 会话 id（2026-10-23 修正）
   *
   * 早先只按 model 复用：用户在 A 对话里问完，去 B 对话问另一件事，opencode 侧
   * 看到的是**同一个 session**，于是 B 的提问带着 A 的历史 —— 而本适配器只发
   * 「最后一条 user 消息」，历史完全靠 session 承载，污染就是静默的错答案。
   *
   * 现在 key = dshSessionId + '|' + modelKey：同一对话内自然延续（省 token、
   * 保 prompt cache），跨对话互不可见。拿不到 DSH 会话 id 时退化为 '-'，
   * 行为与旧版一致（不因缺 id 而每次新建）。
   */
  async sessionFor(sessionKey, modelKey, title) {
    // 兼容旧签名 sessionFor(modelKey)：第二参数缺失时把它当成 modelKey。
    const key = modelKey === undefined
      ? String(sessionKey ?? '')
      : String(sessionKey ?? '') + '|' + String(modelKey)
    const model = modelKey === undefined ? String(sessionKey ?? '') : String(modelKey)
    const cached = this.sessions.get(key)
    if (cached !== undefined) return cached
    const created = await this.request('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: title ?? ('dsh-free-model ' + model) }),
    })
    const id = typeof created?.id === 'string' ? created.id : ''
    if (id === '') throw new Error('OpenCode 建会话失败：响应里没有 session id')
    this.sessions.set(key, id)
    this.created.add(id)
    return id
  }

  /** 丢弃某会话（下次请求重新建）。两个参数缺一即按旧签名处理。 */
  forgetSession(sessionKey, modelKey) {
    if (modelKey === undefined) {
      this.sessions.delete(String(sessionKey ?? ''))
      return
    }
    this.sessions.delete(String(sessionKey ?? '') + '|' + String(modelKey))
  }

  /** 读某会话的全部消息（[{ info, parts }]）。 */
  async messages(sessionID) {
    const payload = await this.request('/session/' + encodeURIComponent(sessionID) + '/message', { method: 'GET' })
    return Array.isArray(payload) ? payload : []
  }

  /** 异步投递一条提示（204，立即返回）。 */
  async promptAsync(sessionID, body) {
    await this.request('/session/' + encodeURIComponent(sessionID) + '/prompt_async', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /**
   * 中断会话（用户取消时调用）。
   *
   * 优先用 v2 的 /api/session/{id}/interrupt（语义更准：只停执行，不碰会话），
   * 失败再退回老接口 —— 两个都在 1.19.3 里，但老接口在部分 build 上会把
   * session 标成 aborted 后不再接受新 prompt。
   */
  async abort(sessionID) {
    const encoded = encodeURIComponent(sessionID)
    try {
      await this.request('/api/session/' + encoded + '/interrupt', { method: 'POST' })
      return
    } catch { /* 老版本没有 v2 接口：退回下面那条 */ }
    try {
      await this.request('/session/' + encoded + '/abort', { method: 'POST' })
    } catch { /* 中断是尽力而为：会话可能已经结束 */ }
  }

  /**
   * 工具开关表：**运行时**取自上游，读不到才退回硬编码快照。
   *
   * ## 为什么不能写死（2026-10-24 修正）
   *
   * `toolsDisabled()` 只关 `OPENCODE_TOOLS` 里那 14 个名字 —— 那是 1.19.3 的
   * 快照。opencode 升级新增内置工具时，新名字不在表里就是**默认启用**，而这条
   * 车道的定位是「不许它动用户的文件」。于是硬编码清单不只是维护负担，它是个
   * 安全洞：上游漏掉一个名字，就等于在这台机器上开了 bash / write / edit。
   *
   * `/experimental/tool/ids` 给出该 build 的真实清单；取到就把每一个都置 false，
   * 并把硬编码快照里的名字**也一起关**（上游列表有遗漏时兜住）。取不到（老版本
   * 没有这个接口）退回快照并记一次日志 —— 两条路的语义都是「全关」，绝不会
   * 因为读不到就放开。
   */
  async toolTable() {
    if (this.toolTableCache !== undefined) return this.toolTableCache
    try {
      const response = await this.request('/experimental/tool/ids', { method: 'GET' })
      const ids = Array.isArray(response) ? response : []
      const names = ids.filter((name) => typeof name === 'string' && name !== '')
      if (names.length === 0) throw new Error('empty tool id list')
      const table = {}
      for (const name of names) table[name] = false
      for (const name of OPENCODE_TOOLS) table[name] = false
      this.toolTableCache = table
      return table
    } catch (error) {
      this.logger?.warn?.('opencode tool ids 读取失败，退回硬编码清单：' + (error instanceof Error ? error.message : String(error)))
      return toolsDisabled()
    }
  }

  /** 记一次 provider 级失败（供状态页显示）。 */
  noteFailure(providerID, message) {
    if (typeof providerID !== 'string' || providerID === '') return
    this.providerFailures.set(providerID, String(message).slice(0, 300))
    this.persistFailures()
  }

  /** 清掉某 provider 的失败记录（成功一次就够）。 */
  clearFailure(providerID) {
    this.providerFailures.delete(providerID)
    this.persistFailures()
  }

  /** 当前已知的 provider 失败表。 */
  failures() {
    return Object.fromEntries(this.providerFailures)
  }

  /**
   * 跑一次完整生成，按增量产出事件。
   *
   * 事件形状（与 DSH 的 chunk 解耦，由适配器负责翻译）：
   * - { kind: 'reasoning', text }
   * - { kind: 'text', text }
   * - { kind: 'error', message }   上游立刻失败（不等 idle 超时）
   * - { kind: 'done', tokens, finish, error }
   */
  async *run(sessionID, options) {
    // ⚠️ providerID/modelID 优先由调用方给出（适配器从目录行里取，那里是权威值）。
    // 只有拿不到时才退回 splitModelId —— 它按第一个斜杠切分，对
    // `ofm` 下那种自带斜杠的 id（buddy/deepseek-v4-flash）会切错：
    // 会得到 provider=buddy、model=deepseek-v4-flash，上游随即报
    // "Model not found: buddy/deepseek-v4-flash"（实测）。
    const split = options.providerID !== undefined && options.modelID !== undefined
      ? { providerID: options.providerID, modelID: options.modelID }
      : splitModelId(options.modelKey)
    const providerID = split.providerID
    const modelID = split.modelID
    const parts = [{ type: 'text', text: options.prompt }]
    for (const image of options.images ?? []) {
      parts.push({
        type: 'file',
        mime: image.mime,
        filename: image.filename ?? 'image',
        url: 'data:' + image.mime + ';base64,' + image.data,
      })
    }
    await this.promptAsync(sessionID, {
      model: { providerID, modelID },
      parts,
      // ⚠️ system 是 message body 的**独立字段**（OpenAPI 实测存在且生效：
      // 让它只回 BANANA 就真的只回 BANANA）。早先把它拼进 prompt 首部再加 ---
      // 分隔线，既污染用户输入，又让上游把它当用户内容而非系统指令。
      ...(typeof options.system === 'string' && options.system.trim() !== ''
        ? { system: options.system }
        : {}),
      // ⚠️ 工具全关：本通道是纯文本模型。opencode 的 build agent 默认带
      // bash / write / edit，一旦放开，模型会真的在用户机器上执行命令 ——
      // 而 DSH 侧的 tool call 又拿不到它的结果（两套工具协议不互通）。
      tools: await this.toolTable(),
    })

    // SSE 优先：真 token 增量 + 立刻拿到 session.error。
    if (this.sseEnabled) {
      let delivered = false
      try {
        for await (const event of this.runViaSse(sessionID, options)) {
          delivered = true
          if (event.kind === 'error') this.noteFailure(providerID, event.message)
          if (event.kind === 'done' && event.error === undefined) this.clearFailure(providerID)
          yield event
        }
        return
      } catch (error) {
        if (options.signal?.aborted) throw error
        // 上游卡住（idle 超时）：这是「这次请求的问题」，不是「SSE 这条路径的问题」。
        // 既不该降级（再等 120 秒毫无意义），也不该把 SSE 永久关掉。
        if (error !== null && typeof error === 'object' && error.sseStalled === true) throw error
        // SSE 不可用（老版本 / 代理掐流）：降级轮询，但只在**还没发出任何内容**时降级，
        // 否则用户会看到重复文本。
        if (delivered) throw error
        this.logger?.warn?.('[dsh-free-model] SSE 不可用，降级为轮询：' + (error instanceof Error ? error.message : String(error)))
        this.markSseUnavailable()
      }
    }

    yield* this.runViaPolling(sessionID, options, providerID)
  }

  /** 关掉 SSE（本实例内），避免每次请求都先撞一次超时。 */
  markSseUnavailable() {
    this.sseEnabled = false
  }

  /**
   * SSE 路径：订阅 GET /event，只收本会话的事件。
   *
   * 事件按 opencode 的 envelope 解包（{ type, properties }）。无法识别的类型
   * 直接忽略 —— 上游会持续推 plugin.added / catalog.updated 之类的全局事件，
   * 把它们当错误处理会让每次调用都失败。
   */
  async *runViaSse(sessionID, options) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const idleTimer = { at: Date.now() }
    let timedOut = false
    const watchdog = setInterval(() => {
      if (Date.now() - idleTimer.at > IDLE_TIMEOUT_MS) {
        timedOut = true
        controller.abort()
      }
    }, 1000)
    watchdog.unref?.()

    let response
    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, '/event'), {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      })
    } catch (error) {
      clearInterval(watchdog)
      options.signal?.removeEventListener?.('abort', onAbort)
      throw error
    }
    if (!response.ok || response.body === null || typeof response.body?.getReader !== 'function') {
      clearInterval(watchdog)
      options.signal?.removeEventListener?.('abort', onAbort)
      throw new Error('SSE /event 不可用（HTTP ' + response.status + '）')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let assistantID = ''
    let sawAny = false
    let tokens
    let finish
    let error
    let emittedText = ''
    let emittedReasoning = ''

    try {
      while (true) {
        if (options.signal?.aborted) {
          await this.abort(sessionID)
          throw options.signal.reason ?? new Error('aborted')
        }
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          const data = block.split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n')
          if (data === '') continue
          let event
          try {
            event = JSON.parse(data)
          } catch { continue }
          if (event?.properties?.sessionID !== sessionID) continue
          const type = typeof event?.type === 'string' ? event.type : ''

          if (type === 'message.part.delta') {
            const field = event.properties?.field
            const delta = typeof event.properties?.delta === 'string' ? event.properties.delta : ''
            if (delta === '') continue
            sawAny = true
            idleTimer.at = Date.now()
            // 第一帧可能是 reasoning 也可能是 text：按 field 分派，别按到达顺序猜。
            if (field === 'text') { emittedText += delta; yield { kind: 'text', text: delta } }
            else if (field === 'reasoning') { emittedReasoning += delta; yield { kind: 'reasoning', text: delta } }
            continue
          }
          if (type === 'message.part.updated') {
            // 有些 build 只推整段更新（无 delta）：按「已发出多少」补差额，保证不重复。
            const part = event.properties?.part
            if (part?.type !== 'text' && part?.type !== 'reasoning') continue
            const full = typeof part.text === 'string' ? part.text : ''
            const already = part.type === 'text' ? emittedText : emittedReasoning
            if (full.length <= already.length) continue
            const delta = full.slice(already.length)
            sawAny = true
            idleTimer.at = Date.now()
            if (part.type === 'text') { emittedText = full; yield { kind: 'text', text: delta } }
            else { emittedReasoning = full; yield { kind: 'reasoning', text: delta } }
            continue
          }
          if (type === 'message.updated') {
            const info = event.properties?.info
            if (info?.role !== 'assistant') continue
            if (assistantID === '') assistantID = String(info.id ?? '')
            if (info.tokens !== undefined) tokens = info.tokens
            if (info.finish !== undefined) finish = info.finish
            // ⚠️ 上游失败时仍然推 completed 的消息，错误挂在 info.error 上。
            const upstream = upstreamError(info.error)
            if (upstream !== undefined) error = upstream
            continue
          }
          if (type === 'session.error') {
            const upstream = upstreamError(event.properties?.error)
            error = upstream ?? 'OpenCode 报告了未知错误'
            idleTimer.at = Date.now()
            // 立刻抛出：等 idle 要 120 秒，而这时已经确定不会有内容了。
            yield { kind: 'error', message: error }
            return
          }
          if (type === 'session.idle') {
            if (sawAny || tokens !== undefined || error !== undefined) {
              yield { kind: 'done', tokens: normalizeTokens(tokens), finish, error }
              return
            }
            // idle 但什么都没产出：可能是上一轮的残留 idle 事件，继续等。
            continue
          }
        }
      }
    } finally {
      clearInterval(watchdog)
      options.signal?.removeEventListener?.('abort', onAbort)
      try { await reader.cancel() } catch { /* 连接已断 */ }
    }

    if (timedOut) {
      await this.abort(sessionID)
      // ⚠️ 打标记：这是「上游卡住」，不是「SSE 不可用」。run() 据此**不能**降级，
      // 也不能永久关掉 SSE —— 否则一次上游卡顿会让整个进程以后都走轮询。
      const stalled = new Error('OpenCode 生成中断：长时间没有新内容')
      stalled.sseStalled = true
      throw stalled
    }
    // 流自然结束（连接被对端关闭）也要给出收尾，否则适配器拿不到 finish。
    yield { kind: 'done', tokens: normalizeTokens(tokens), finish, error }
  }

  /** 轮询降级路径（老版本 serve / SSE 被掐）。语义与旧实现一致。 */
  async *runViaPolling(sessionID, options, providerID) {
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
        if (Date.now() - startedAt > IDLE_TIMEOUT_MS) throw new Error('OpenCode 迟迟没有开始响应（可能上游限流）')
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
        const upstream = upstreamError(target.info?.error)
        if (upstream !== undefined) this.noteFailure(providerID, upstream)
        yield {
          kind: 'done',
          tokens: normalizeTokens(target.info?.tokens),
          finish: target.info?.finish,
          error: upstream,
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
        await this.request('/session/' + encodeURIComponent(id), { method: 'DELETE' })
      } catch { /* 服务端可能已经没了：清理是尽力而为 */ }
    }
    this.created.clear()
    this.sessions.clear()
  }
}

/**
 * 从 opencode 的 info.error 里抽一条人能读的原因。
 *
 * 形状实测有三种：字符串（"AI_APICallError: Rate limit exceeded..."）、
 * 对象（{ name, data: { message } }），或 v2 事件里的
 * { name: 'UnknownError', data: { message } }。抽不出来就返回 undefined。
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

/** 免费层被拒的判定（供状态页与适配器共用）。 */
export function isFreeTierRejection(message) {
  return FREE_TIER_MARK.test(String(message ?? ''))
}

/**
 * 当日免费额度耗尽的固定特征。
 *
 * 实测原文：`Free usage limit reached. Subscribe to OpenCode Go to keep going`。
 *
 * ⚠️ 这与「调用方身份被拒」（上面那条）是**两件不同的事**，处置完全相反：
 * 身份拒绝重试永远不会好；额度耗尽是**按天重置**的（UTC 0:00 = 北京 08:00）。
 * 2026-10-24 之前这里没有这条分支，于是额度耗尽会漏到 `describeUpstreamFailure`
 * 的兜底分支，用户看到的是上游英文原文 —— 分不清该等到早上还是该换通道。
 */
const FREE_QUOTA_MARK = /free usage limit|freeusagelimiterror|usage limit reached|subscribe to opencode go/i

export function isQuotaExhausted(message) {
  return FREE_QUOTA_MARK.test(String(message ?? ''))
}

/** 落盘条目是否已过期（规则见 OpenCodeClient#loadFailures 的注释）。 */
export function isPersistedFailureExpired(entry, nowMs = Date.now()) {
  if (entry.kind === 'identity') return false
  if (entry.kind === 'quota') {
    const resetAt = typeof entry.resetAt === 'string' ? Date.parse(entry.resetAt) : Number.NaN
    return !Number.isFinite(resetAt) || nowMs >= resetAt
  }
  const at = typeof entry.at === 'string' ? Date.parse(entry.at) : Number.NaN
  return !Number.isFinite(at) || nowMs - at >= FAILURE_OTHER_TTL_MS
}

/**
 * 把 opencode 的 tokens 形状归一成 DSH 的 usage。
 *
 * opencode: { total, input, output, reasoning, cache: { read, write } }
 * DSH: { inputTokens, outputTokens, reasoningTokens?, cacheReadTokens?, cacheWriteTokens? }
 *
 * ⚠️ input 在 opencode 里**已扣除缓存命中**（实测：input 5217 + cache.read 2368
 * = 7585 ≈ total 7635），与 DSH 的 inputTokens 语义一致，直接透传即可。
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

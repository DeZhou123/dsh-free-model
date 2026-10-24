/**
 * 服务型车道：跑在**本机**的免费推理入口。
 *
 * ## 与账号车道的差别
 *
 * 账号车道要管「账号」：登录、续期、积分、到期。服务车道只有一个问题：
 * **那个本地进程在不在、能不能用**。所以这里不给它复用账号那套形状，
 * 而是「一条 descriptor + 一个 HTTP 探针」。
 *
 * ## 两条必须守住的规矩
 *
 * 1. **不重复注册路由**。`freellmapi` 这条本地网关的 LLM 路由已经由
 *    `dsh-llm-pi-ai`（A 的 profile 里那个插件）注册了；本插件再注册一次会撞
 *    「adapter 已存在」。所以它的 `backend` 是 `gateway` —— 本插件只**观测**它，
 *    不挂路由。这条区分就靠 `backend` 一个字段，页面上的按钮也因此不同。
 * 2. **探针要短**。探针是打开设置页就会跑的，超时 3 秒、失败 30 秒内不重试
 *    （否则本地服务没起时会变成持续的无效 IO，这正是 opencode 那条车道踩过的坑）。
 *
 * ## 为什么目录里要有「注定不可用」的渠道
 *
 * `ollama` 在本机只有 embedding 模型（`nomic-embed-text`）—— 它**现在**不是一条对话车道。
 * 但它仍列在这里，因为「本机有没有本地推理能力」是用户会问的问题，而答案是
 * 「装了 Ollama、但没有对话模型」。让页面如实说出这句话，比让用户自己去翻进程列表好。
 *
 * @module src/lanes/service
 */

/** 探针超时：3 秒。本地环回不该更慢；超了就说明服务没起或卡死。 */
export const SERVICE_PROBE_TIMEOUT_MS = 3_000

/** 探针结果的失败缓存时长：30 秒。挡住同一轮并发与重试，又不至于让用户等太久。 */
export const SERVICE_PROBE_FAILURE_TTL_MS = 30_000

/**
 * 服务型车道的静态描述。
 *
 * ⚠️ 每条必须给出 `probe.url`：没有探针的服务车道在页面上只能显示「未知」，
 * 而「未知」对用户没有任何指导意义 —— 要么能探测，要么别列。
 *
 * @type {ReadonlyArray<object>}
 */
export const SERVICE_LANES = Object.freeze([
  Object.freeze({
    id: 'opencode',
    displayName: 'OpenCode 免费层',
    kind: 'service',
    backend: 'native',
    endpoint: 'http://127.0.0.1:4096',
    category: '本地',
    capability: Object.freeze({ tools: false, vision: true }),
    credits: Object.freeze({ balance: false, claim: false }),
    note: '不需要账号。能对话、能看图，但不能调用工具（opencode 接口不接受外部工具定义）。'
      + '适合标题、摘要、翻译、识图；别在 agent 会话里当主模型。',
    probe: Object.freeze({
      url: 'http://127.0.0.1:4096/config/providers',
      method: 'GET',
      // 探针成功 = HTTP 2xx。opencode 的 providers 接口在服务没起时是连接拒绝。
      okStatus: [200],
    }),
    startable: true,
  }),
  Object.freeze({
    id: 'freellmapi',
    displayName: 'FreeLLMAPI 本地网关',
    kind: 'service',
    backend: 'gateway',
    endpoint: 'http://127.0.0.1:31415',
    category: '本地',
    capability: Object.freeze({ tools: true, vision: true }),
    credits: Object.freeze({ balance: false, claim: false }),
    note: '免费额度聚合器（一把 key 聚合多家上游）。它的 LLM 路由由 dsh-llm-pi-ai 注册，'
      + '本插件只观测、不重复注册；这里显示的是「网关进程 + 凭据是否就绪」。',
    probe: Object.freeze({
      url: 'http://127.0.0.1:31415/v1/models',
      method: 'GET',
      okStatus: [200, 401, 403],
      // 401 也算「进程活着」：能返回 401 说明网关在跑，只是缺/错 key。
      // 这两个状态在页面上要分开说 —— 一个是「去起服务」，一个是「去填 key」。
      auth: Object.freeze({ apiKeyEnv: 'FREELLMAPI_API_KEY', header: 'authorization', scheme: 'Bearer' }),
    }),
    startable: false,
  }),
  Object.freeze({
    id: 'ollama',
    displayName: 'Ollama 本机推理',
    kind: 'service',
    backend: 'gateway',
    endpoint: 'http://127.0.0.1:11434',
    category: '本地',
    capability: Object.freeze({ tools: null, vision: null }),
    credits: Object.freeze({ balance: false, claim: false }),
    note: '本机 Ollama。注意：它当前只装了向量模型（nomic-embed-text），'
      + '**没有对话模型** —— 故不是一条可用的对话车道，列出来是为了让这件事一眼可见。',
    probe: Object.freeze({
      url: 'http://127.0.0.1:11434/api/tags',
      method: 'GET',
      okStatus: [200],
      // 判定「有没有对话模型」：名字里带 embed / nomic / bge 的一律不算。
      modelListPath: 'models',
      chatModelExcludes: true,
    }),
    startable: false,
  }),
])

/**
 * 探测一条服务车道。
 *
 * 返回值里的 `state` 是页面直接用的三态 + 一档：
 * - `ready`        探针 200，且（如果要求）拿到了模型
 * - `needs-action` 进程在，但缺凭据 / 缺模型 → 用户有明确动作可做
 * - `unavailable`  连不上，或者上游明确拒绝
 * - `unknown`      探针本身没跑成（没有 fetch、URL 参数缺失）
 *
 * @param {object} lane
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   readCredential?: (name: string) => Promise<unknown>,
 *   timeoutMs?: number,
 * }} [deps]
 */
export async function probeServiceLane(lane, deps = {}) {
  const probe = lane.probe
  if (probe === undefined || typeof probe.url !== 'string') {
    return { lane: lane.id, state: 'unknown', reason: '这条服务车道没有配探针，无法判断状态', models: [] }
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { lane: lane.id, state: 'unknown', reason: '运行时没有 fetch，无法探测', models: [] }
  }

  const headers = {}
  let credential = undefined
  if (probe.auth !== undefined) {
    credential = await readApiKey(probe.auth.apiKeyEnv, deps).catch(() => undefined)
    if (typeof credential === 'string' && credential !== '') {
      headers[probe.auth.header] = `${probe.auth.scheme ?? 'Bearer'} ${credential}`
    }
  }

  const timeoutMs = Number.isFinite(deps.timeoutMs) ? Number(deps.timeoutMs) : SERVICE_PROBE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(),
    timeoutMs)
  let response
  try {
    response = await fetchImpl(probe.url, { method: probe.method ?? 'GET', headers, signal: controller.signal })
  } catch (error) {
    return {
      lane: lane.id,
      state: 'unavailable',
      reason: `连不上 ${probe.url}（${error instanceof Error ? error.message : String(error)}）`,
      models: [],
    }
  } finally {
    clearTimeout(timer)
  }

  const body = await safeJson(response)
  const okStatuses = Array.isArray(probe.okStatus) ? probe.okStatus : [200]
  const reachable = okStatuses.includes(response.status)

  if (!reachable) {
    return {
      lane: lane.id,
      state: 'unavailable',
      reason: `HTTP ${response.status}：${describeBody(body)}`,
      models: [],
    }
  }

  // 200 但缺凭据 → 「要动作」而不是「不可用」：这是两件不同的修法。
  if (probe.auth !== undefined && (credential === undefined || credential === '')) {
    return {
      lane: lane.id,
      state: 'needs-action',
      reason: `服务在跑，但缺凭据（${probe.auth.apiKeyEnv}）：请把 key 放进 DSH 凭据或环境变量`,
      models: [],
    }
  }
  if (response.status === 401 || response.status === 403) {
    return { lane: lane.id, state: 'needs-action', reason: `服务在跑，但凭据被拒（HTTP ${response.status}）`, models: [] }
  }

  const models = listModelsFrom(body, probe)
  if (probe.chatModelExcludes === true && models.length === 0) {
    return {
      lane: lane.id,
      state: 'needs-action',
      reason: '服务在跑，但本机没有对话模型（只装了向量模型）；不是一条可用的对话车道',
      models: [],
    }
  }
  return {
    lane: lane.id,
    state: 'ready',
    reason: models.length > 0 ? `${models.length} 个模型` : '服务在跑',
    models,
  }
}

/**
 * 一次性探测全部服务车道（并发，但每条各自超时）。
 *
 * ⚠️ 并发不是省事，是**必须**：串行三条、每条最多 3 秒，页面最坏要等 9 秒才显示状态。
 */
export async function probeAllServiceLanes(lanes, deps = {}) {
  const results = await Promise.all(lanes.map((lane) => probeServiceLane(lane, deps)))
  const byId = {}
  for (const row of results) byId[row.lane] = row
  return byId
}

// ── 内部小工具 ──────────────────────────────────────────────────────────────

async function readApiKey(name, deps) {
  if (typeof name !== 'string' || name === '') return undefined
  // 环境变量优先：跨实例（A/B）时凭据存储可能不在场，环境变量是唯一稳定来源。
  const fromEnv = typeof process !== 'undefined' ? process.env?.[name] : undefined
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  if (typeof deps.readCredential !== 'function') return undefined
  const raw = await deps.readCredential(name)
  return decodeCredentialValue(raw)
}

/**
 * 凭据值可能是明文，也可能是 DSH 的引用形态（`ref:NAME` / `{ref}`）。三种都要认。
 */
export function decodeCredentialValue(raw) {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return undefined
    if (trimmed.startsWith('ref:')) return undefined // 引用没被解析 = 真的没拿到
    return trimmed
  }
  if (typeof raw === 'object') {
    if (typeof raw.value === 'string') return raw.value.trim() || undefined
    if (typeof raw.secret === 'string') return raw.secret.trim() || undefined
    if (typeof raw.token === 'string') return raw.token.trim() || undefined
  }
  return undefined
}

async function safeJson(response) {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function describeBody(body) {
  if (body === undefined) return '（响应不是 JSON）'
  try {
    const text = JSON.stringify(body)
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  } catch {
    return '（无法序列化响应）'
  }
}

/**
 * 从响应体里数出模型清单。
 *
 * 两个已知形状：OpenAI 的 `{data:[{id}]}`（freellmapi/opencode 网关）与
 * Ollama 的 `{models:[{name}]}`。认不出就返回空数组 —— 空数组表示「没数到」，
 * 页面据此说「服务在跑但读不到模型目录」，而不是假装它有 0 个模型。
 */
export function listModelsFrom(body, probe = {}) {
  if (body === null || typeof body !== 'object') return []
  const rows = Array.isArray(body[probe.modelListPath ?? 'data'])
    ? body[probe.modelListPath ?? 'data']
    : Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
  const names = []
  for (const row of rows) {
    const name = typeof row === 'string' ? row : row?.id ?? row?.name ?? row?.model
    if (typeof name !== 'string' || name.trim() === '') continue
    names.push(name.trim())
  }
  if (probe.chatModelExcludes === true) {
    return names.filter((name) => !/(embed|nomic|bge|gte|rerank|whisper|clip)/i.test(name))
  }
  return names
}
/**
 * 渠道目录 —— 「免费渠道总台」唯一的数据层。
 *
 * ## 为什么要有「目录」这一层
 *
 * 免费渠道是会**变**的：上游换域名、加免费模型、改限额、下线一条免费线。
 * 如果每条渠道都硬编码在插件源码里，那么每次变化都要用户等一次插件发版 ——
 * 而这类插件的价值恰恰在于「今天能白嫖的东西今天就能用」。
 *
 * 所以渠道数据分成三层，**同一形状**，按优先级叠加：
 *
 * | 层 | 位置 | 谁写 | 什么时候变 |
 * |---|---|---|---|
 * | shipped | 插件包内（`src/lanes/keyed/catalog.js` + 本模块内置） | 开发者 | 发版 |
 * | remote  | 远程 JSON（默认本插件仓库的 raw 地址） | 开发者 | **随时，不用发版** |
 * | local   | `$DSH_HOME/free-model/channels.local.json` | 用户 | 随时（本地覆盖） |
 *
 * 叠加规则：`id` 相同则**后者整条替换前者**（不做字段级深合并 —— 深合并会造出
 * 两份数据都不成立的中间态，例如拿到旧的 models 配新的 baseURL）；但被标了
 * `pinned: true` 的记录例外：它**永远不被远程层覆盖**，只受本地层影响。
 * 用户把一条渠道钉住，意思就是「这条我改过，别让远程数据把它改回去」。
 *
 * ## 远程数据是「不可信输入」，这一层必须自己站得住
 *
 * 远程 JSON 从公网来，任何一条记录都可能是错的、恶意的、或者只是旧格式。
 * 因此这里**只做数据、绝不执行**：没有 eval、没有动态 import、没有 URL 拼接执行。
 * 每条记录都要过 {@link normalizeChannelRecord} 的字段校验，不合格的**整条丢弃并记账**
 * （`rejected` 数组带上原因），绝不半信半疑地放进注册表 ——
 * 一条 baseURL 被写错的渠道会表现成「插件坏了」，比少一条渠道糟得多。
 *
 * @module src/lanes/catalog
 */

import { createHash } from 'node:crypto'

/** 渠道类型。三类渠道的**管理面**完全不同，页面也按这个分页。 */
export const CHANNEL_KINDS = Object.freeze(['account', 'service', 'keyed'])

/**
 * 作者可以写、但落库时会被**归一**的类型别名。
 *
 * `keyless`（免 key 直连）不是第四类渠道，而是 `keyed` 的一个特例：它同样注册
 * OpenAI 兼容适配器，只是不需要凭据。若不归一，页面就得为「同一件事」写两套分支
 * （`kind === 'keyed' || kind === 'keyless'`），而分叉正是本模块存在的理由。
 *
 * 归一规则：`kind: 'keyless'` ⇒ `kind: 'keyed'` 且**没有** `apiKeyEnv`
 *（后者即使写了也忽略 —— 免 key 渠道带着一个凭据名，只会让页面渲染出
 * 「缺凭据 XXX」这种自相矛盾的状态）。
 */
const KIND_ALIASES = Object.freeze({ keyless: 'keyed' })

/** 归一化后的类型能取哪些值（含别名的全集）。 */
const ACCEPTED_KINDS = Object.freeze([...CHANNEL_KINDS, ...Object.keys(KIND_ALIASES)])

/**
 * 渠道记录里允许出现的 `backend`。
 *
 * - `native`   本插件自己挂适配器（有账号/服务在本插件手里）
 * - `gateway`  别的插件已经注册了路由（本插件只观测，**不重复注册**）
 *
 * ⚠️ 0.5.0 起删掉过一档「由另一个插件的 RPC 代理」：那些账号车道已经整体
 * 搬到独立插件里，本插件的注册表里不再有「不是自己挂、也不是别人已挂」的记录。
 * 保留一个用不上的枚举值，只会让校验器放过一条页面根本渲染不出来的记录。
 */
export const CHANNEL_BACKENDS = Object.freeze(['native', 'gateway'])

/** 目录层名（页面要能说清「这条是随包来的还是刚更新的」）。 */
export const CATALOG_LAYERS = Object.freeze(['shipped', 'remote', 'local'])

/**
 * 目录的版本号：**格式版本**，不是内容版本。
 *
 * 远程目录写一个本插件不认识的 `catalogVersion` 时，说明它是给未来版本插件用的，
 * 此时整份拒绝（而不是猜着读）—— 读到半份数据的后果是渠道莫名消失。
 */
export const CATALOG_FORMAT_VERSION = 1

/** 远程目录的大小上限（256KB）。目录是数据，不可能这么大；超了就是投毒或搞错文件。 */
export const MAX_REMOTE_CATALOG_BYTES = 256 * 1024

/**
 * 归一化并校验一条渠道记录。
 *
 * @param {unknown} raw 待校验的原始记录（可能来自远程 JSON）
 * @param {string} origin 来源层名，用于记账
 * @param {{ allowUnknownFields?: boolean }} [options]
 * @returns {{ ok: true, channel: object } | { ok: false, reason: string }}
 */
export function normalizeChannelRecord(raw, origin, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return reject('不是对象')
  }
  const id = cleanId(raw.id)
  if (id === undefined) return reject('id 缺失或不合规（只允许小写字母/数字/连字符，且不超过 48 字符）')

  const displayName = cleanText(raw.displayName, 80)
  if (displayName === undefined) return reject('displayName 缺失或过长')

  const kindRaw = cleanText(raw.kind, 16)
  if (kindRaw === undefined || !ACCEPTED_KINDS.includes(kindRaw)) {
    return reject(`kind 必须是 ${ACCEPTED_KINDS.join(' / ')} 之一`)
  }
  const kind = KIND_ALIASES[kindRaw] ?? kindRaw

  const backend = raw.backend === undefined ? defaultBackendFor(kind) : cleanText(raw.backend, 16)
  if (backend === undefined || !CHANNEL_BACKENDS.includes(backend)) {
    return reject(`backend 必须是 ${CHANNEL_BACKENDS.join(' / ')} 之一`)
  }

  // baseURL / endpoint：keyed 渠道必须有；其余可选。只允许 http(s)，
  // 且**必须是纯 origin+path**（不许 query/hash —— 那是把 token 塞进 URL 的常见写法，
  // 一旦写进目录就会随目录被同步到远程，属于凭据泄漏面）。
  const endpoint = cleanUrl(raw.baseURL ?? raw.endpoint)
  if (endpoint.err !== undefined) return reject(endpoint.err)
  if (kind === 'keyed' && endpoint.value === undefined) return reject('keyed 渠道必须给 baseURL')

  const models = normalizeModels(raw.models)
  if (models === undefined) return reject('models 必须是数组（可为空）')
  if (kind === 'keyed' && models.length === 0) return reject('keyed 渠道至少要声明 1 个模型')

  const apiKeyEnv = (kindRaw === 'keyless' || raw.apiKeyEnv === null || raw.apiKeyEnv === undefined)
    ? null
    : cleanCredentialName(raw.apiKeyEnv)
  const keyedProvided = kindRaw !== 'keyless' && raw.apiKeyEnv !== null && raw.apiKeyEnv !== undefined
  if (keyedProvided && apiKeyEnv === null) {
    return reject('apiKeyEnv 不合规（只允许大写字母/数字/下划线，且不超过 64 字符）')
  }

  const capability = normalizeCapability(raw.capability ?? raw)
  const credits = normalizeCredits(raw.credits)
  const login = cleanText(raw.login, 16)
  if (login !== undefined && login !== 'browser' && login !== 'localPage') {
    return reject('login 只能是 browser / localPage')
  }

  // 服务型渠道必须有**可用的探针**：没有探针的服务车道在页面上只能永远显示「未知」，
  // 那对用户没有任何指导意义。与其留一条僵尸渠道，不如在目录层就拒掉 ——
  // 这样远程目录想加一条本地服务时，必须同时说清「怎么判断它在不在」。
  if (kind === 'service' && Object.keys(normalizeProbe(raw.probe)).length === 0) {
    return reject('service 渠道必须给 probe.url（没有探针的服务车道只能永远显示「未知」）')
  }

  const channel = {
    id,
    displayName,
    kind,
    backend,
    origin,
    ...(endpoint.value !== undefined ? { endpoint: endpoint.value } : {}),
    ...(apiKeyEnv !== null ? { apiKeyEnv } : {}),
    ...(cleanText(raw.category, 24) !== undefined ? { category: cleanText(raw.category, 24) } : {}),
    ...(cleanText(raw.protocol, 16) !== undefined ? { protocol: cleanText(raw.protocol, 16) } : {}),
    capability,
    credits,
    ...(login !== undefined ? { login } : {}),
    ...(raw.smsFallback === true ? { smsFallback: true } : {}),
    ...(raw.unknown === true ? { unknown: true } : {}),
    ...(raw.pinned === true ? { pinned: true } : {}),
    // `native`：这条渠道的适配器由本插件自己挂（区别于宿主提供的）。
    // 它影响页面能做什么（能不能在本页启停模型），所以必须随目录一起流动。
    ...(raw.native === true ? { native: true } : {}),
    // `startable`：页面上能不能出现「启动服务」按钮。只有本插件真的能拉起进程时才为 true。
    ...(raw.startable === true ? { startable: true } : {}),
    // 探针**只留给服务型车道**：它是唯一会去访问这个 URL 的地方（见 `./service.js` 的
    // `probeServiceLane`），别的类型带上它只是多一条没人用的攻击面描述。
    ...(kind === 'service' ? normalizeProbe(raw.probe) : {}),
    ...(cleanText(raw.note, 400) !== undefined ? { note: cleanText(raw.note, 400) } : {}),
    ...(cleanText(raw.freeTier, 200) !== undefined ? { freeTier: cleanText(raw.freeTier, 200) } : {}),
    ...(endpointFree(raw.docsURL) !== undefined ? { docsURL: endpointFree(raw.docsURL) } : {}),
    ...(endpointFree(raw.signupURL) !== undefined ? { signupURL: endpointFree(raw.signupURL) } : {}),
    models,
  }

  // 额外字段：默认**保留**（未来版本加的字段不该被旧插件吃掉），但集中放在
  // `extra` 里，避免和上面的规范字段混在一起导致「两个同名字段谁赢」的歧义。
  const extra = {}
  for (const [key, value] of Object.entries(raw)) {
    if (Object.hasOwn(channel, key)) continue
    if (RESERVED_FIELDS.has(key)) continue
    extra[key] = value
  }
  if (Object.keys(extra).length > 0) channel.extra = Object.freeze(extra)
  void options

  return { ok: true, channel: Object.freeze(channel) }

  function reject(reason) {
    return { ok: false, reason: `${origin}:${String(raw?.id ?? '?')} ${reason}` }
  }
}

/** 规范字段之外，仍属于「本模块认识但不下发」的名字（避免重复进 extra）。 */
const RESERVED_FIELDS = new Set(['kind', 'baseURL', 'endpoint', 'capability', 'probe', 'native', 'startable'])

/**
 * 按 id 叠加多层目录。
 *
 * @param {Array<{ layer: string, channels: unknown[] }>} layers 由低到高优先级
 * @returns {{ channels: object[], rejected: string[], byLayer: Record<string, number> }}
 */
export function mergeCatalogs(layers) {
  const merged = new Map()
  const rejected = []
  const byLayer = {}

  for (const { layer, channels } of layers) {
    if (!CATALOG_LAYERS.includes(layer)) {
      rejected.push(`未知目录层 ${String(layer)}（只认 ${CATALOG_LAYERS.join('/')}）`)
      continue
    }
    let kept = 0
    for (const raw of Array.isArray(channels) ? channels : []) {
      const result = normalizeChannelRecord(raw, layer)
      if (!result.ok) {
        rejected.push(result.reason)
        continue
      }
      const previous = merged.get(result.channel.id)
      // 钉住的记录不被远程层覆盖：用户标 pinned 的意图就是「别再改它」。
      // ⚠️ 但本地层仍然能改它 —— 否则钉住之后就再也改不动了。
      if (previous?.pinned === true && layer === 'remote') {
        rejected.push(`${layer}:${result.channel.id} 已钉住，忽略远程覆盖`)
        continue
      }
      merged.set(result.channel.id, result.channel)
      kept += 1
    }
    byLayer[layer] = kept
  }

  // 顺序稳定：先按 kind（账号 → 服务 → 自带 key），再按目录里的先后。
  const order = { account: 0, service: 1, keyed: 2 }
  const channels = [...merged.values()].sort((a, b) => {
    const kindDelta = order[a.kind] - order[b.kind]
    return kindDelta !== 0 ? kindDelta : 0
  })
  return { channels, rejected, byLayer }
}

/**
 * 目录指纹（sha256，取前 16 位十六进制）。
 *
 * 用途不是加密，而是**变更可观测**：页面上显示它，远程目录被换了内容时用户能看出来。
 */
export function catalogFingerprint(channels) {
  // 拼进指纹的字段：**用户能看见或会影响请求的那些**（id / 展示名 / 类型 / 端点 / 模型数）。
  // 展示名也算 —— 改个名字同样该让指纹变，否则「目录更新过了吗」这个问题会答错。
  const basis = channels
    .map((channel) => `${channel.id}@${channel.kind}@${channel.displayName}@${channel.endpoint ?? '-'}@${channel.models.length}`)
    .sort()
    .join('|')
  return createHash('sha256').update(basis).digest('hex').slice(0, 16)
}

/** 一条渠道「像不像能用」的静态自检（不联网），供测试与页面提示用。 */
export function staticChannelProblems(channel) {
  const problems = []
  if (channel.kind === 'keyed' && channel.apiKeyEnv == null && channel.kind !== 'keyless') {
    problems.push('keyed 渠道没有 apiKeyEnv：无法知道去读哪份凭据')
  }
  if (channel.endpoint !== undefined && !/^https?:/i.test(channel.endpoint)) {
    problems.push('endpoint 不是 http(s)')
  }
  if (channel.unknown === true) problems.push('记录声明为未确证（unknown: true）')
  return problems
}

// ── 字段清洗小工具（各自只做一件事，便于单测逐条断言） ───────────────────────

function cleanId(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(trimmed)) return undefined
  return trimmed
}

function cleanText(value, max) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) return undefined
  return trimmed
}

function cleanCredentialName(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(trimmed)) return null
  return trimmed
}

function defaultBackendFor(kind) {
  if (kind === 'account') return 'native'
  if (kind === 'service') return 'native'
  return 'native'
}

/** 端点：必须 http(s)、无 query/hash、无内嵌凭据。 */
function cleanUrl(value) {
  if (value === null || value === undefined) return { value: undefined }
  if (typeof value !== 'string') return { err: 'URL 不是字符串' }
  const trimmed = value.trim().replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return { err: `URL 无法解析：${trimmed.slice(0, 60)}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { err: `URL 协议不被允许：${parsed.protocol}` }
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { err: 'URL 不许带 query 或 hash（防止把 token 写进目录）' }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { err: 'URL 不许内嵌用户名/密码' }
  }
  return { value: parsed.toString().replace(/\/+$/, '') }
}

/** 文档/注册链接：纯展示用，宽松但仍禁止非 http(s)。 */
function endpointFree(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length > 300) return undefined
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined
}

function normalizeModels(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return undefined
  const rows = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const id = cleanText(item.id, 120)
    if (id === undefined) continue
    rows.push(Object.freeze({
      id,
      ...(cleanText(item.name, 120) !== undefined ? { name: cleanText(item.name, 120) } : {}),
      ...(Number.isFinite(item.contextWindow) && item.contextWindow > 0
        ? { contextWindow: Math.floor(item.contextWindow) }
        : {}),
      ...(Number.isFinite(item.maxTokens) && item.maxTokens > 0
        ? { maxTokens: Math.floor(item.maxTokens) }
        : {}),
      // 能力位只认 true/false/undefined —— 不写就是「未知」，不要臆造成 true。
      ...(typeof item.vision === 'boolean' ? { vision: item.vision } : {}),
      ...(typeof item.tools === 'boolean' ? { tools: item.tools } : {}),
    }))
  }
  return rows
}

function normalizeCapability(source) {
  const tools = pickBool(source?.tools ?? source?.capability_tools)
  const vision = pickBool(source?.vision ?? source?.capability_vision)
  return Object.freeze({
    tools: tools ?? null,
    vision: vision ?? null,
  })
}

function pickBool(value) {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeCredits(value) {
  const balance = value?.balance === true
  const claim = value?.claim === true
  const claimNote = cleanText(value?.claimNote, 200)
  return Object.freeze({
    balance,
    claim,
    ...(claimNote !== undefined ? { claimNote } : {}),
  })
}

/**
 * 服务车道的探针描述（只有服务型渠道需要）。
 *
 * ⚠️ 这里**只接受数据**：URL 必须过 {@link cleanUrl}（http(s)、无 query/hash、无内嵌凭据），
 * 方法只认 GET/HEAD —— 一个能被远程目录改成 `POST` 任意地址的探针，就是一台 SSRF 发射器。
 */
function normalizeProbe(value) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return {}
  const url = cleanUrl(value.url)
  if (url.value === undefined) return {}
  const method = typeof value.method === 'string' ? value.method.toUpperCase() : 'GET'
  if (method !== 'GET' && method !== 'HEAD') return {}
  const okStatus = Array.isArray(value.okStatus)
    ? value.okStatus.filter((code) => Number.isInteger(code) && code >= 100 && code <= 599).slice(0, 8)
    : []
  const auth = value.auth !== null && typeof value.auth === 'object' && !Array.isArray(value.auth)
    ? {
      apiKeyEnv: cleanCredentialName(value.auth.apiKeyEnv) ?? undefined,
      header: typeof value.auth.header === 'string' && /^[a-z0-9-]{1,32}$/i.test(value.auth.header)
        ? value.auth.header.toLowerCase()
        : undefined,
      scheme: typeof value.auth.scheme === 'string' && value.auth.scheme.length <= 16 ? value.auth.scheme : undefined,
    }
    : undefined
  return {
    probe: Object.freeze({
      url: url.value,
      method,
      okStatus: Object.freeze(okStatus.length > 0 ? okStatus : [200]),
      ...(auth?.apiKeyEnv !== undefined ? { auth: Object.freeze(auth) } : {}),
      ...(value.chatModelExcludes === true ? { chatModelExcludes: true } : {}),
      ...(typeof value.modelListPath === 'string' && value.modelListPath.length <= 32
        ? { modelListPath: value.modelListPath }
        : {}),
    }),
  }
}
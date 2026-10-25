/**
 * 「这条自带 key 的车道现在能不能用」+「凭据怎么解」。
 *
 * ## 边界：**绝不自己读凭据文件**
 *
 * `~/.dsh/.credentials.yaml` 是宿主 `credentials` 服务的地盘。插件自己去读有三个后果：
 * 1. 宿主换了存储位置（B 实例用 `DSH_HOME=E:\...`）就静默读错文件；
 * 2. 与宿主的「凭据变更」事件脱钩 —— 用户刚填好 key，页面还显示未配置；
 * 3. 绕过宿主的加密 / 权限处理。
 *
 * 所以这里**只**接受注入的 `readCredential(name)`（上层传宿主 credentials 服务的方法）。
 * 拿不到注入时返回 not-ready 并说明原因，不去猜。
 *
 * ## 三种凭据形态（`decodeApiKey`）
 *
 * - `ref:NAME` —— 宿主凭据里的条目名。**解引用**：用 `readCredential(NAME)` 取真实值；
 * - 明文 —— 直接当 key 用；
 * - 空 —— 未配置。
 *
 * 另外支持 `env:NAME`（读 `process.env`，方便宿主外自测）与「带引号/带换行」的
 * 粘贴产物（一律 trim + 去配对引号；粘贴来的 key 常带换行，这是最常见的「明明填了却 401」）。
 *
 * ⚠️ 解引用**只解一层**：`ref:A` 取回的值即便长得像 `ref:B` 也当明文——
 * 否则一个环状的凭据表会让这里无限递归。
 *
 * @module src/lanes/keyed/ready
 */

import { lanePlaceholders } from './catalog.js'

/** 明文 key 的合理长度上限：超过它不是 key，是把整段配置粘进来了。 */
const MAX_KEY_CHARS = 4096

/** 提示语里带上的「去哪拿 key」文案：页面直接显示，不用再拼一遍。 */
export function describeMissingKey(lane) {
  const env = typeof lane?.apiKeyEnv === 'string' && lane.apiKeyEnv !== '' ? lane.apiKeyEnv : '[API_KEY_ENV]'
  const where = typeof lane?.signupURL === 'string' && lane.signupURL !== '' ? lane.signupURL : '[SIGNUP_URL]'
  return `未配置 ${env}：去 ${where} 拿 key，然后把它写进凭据条目 ${env}（或写入别的条目名，再用 ref:<条目名> 引用）。`
}

/** 去掉配对引号与首尾空白。粘贴来的 key 十有八九带换行。 */
export function normalizeSecret(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      text = text.slice(1, -1).trim()
    }
  }
  return text
}

/**
 * 解一个凭据值。
 *
 * @param {unknown} raw 凭据原文（`ref:NAME` / 明文 / 空；或 `env:NAME`）
 * @param {(name: string) => unknown | Promise<unknown>} [resolveRef]
 *        `ref:NAME` 的解引用函数（通常是 `readCredential` 自己）。省略时
 *        返回 `needsResolve:true` 且 `value` 为 undefined，由调用方决定要不要解。
 * @returns {Promise<{shape:'ref'|'plain'|'env'|'empty', keyRef:string|null, value:string|undefined, needsResolve:boolean, invalid?:string}>}
 */
export async function decodeApiKey(raw, resolveRef) {
  const text = normalizeSecret(raw)
  if (text === '') {
    return { shape: 'empty', keyRef: null, value: undefined, needsResolve: false }
  }
  if (text.startsWith('ref:')) {
    const name = text.slice(4).trim()
    if (name === '') {
      return { shape: 'ref', keyRef: null, value: undefined, needsResolve: false, invalid: 'ref: 后面没有条目名' }
    }
    if (typeof resolveRef !== 'function') {
      return { shape: 'ref', keyRef: name, value: undefined, needsResolve: true }
    }
    let resolved
    try {
      resolved = await resolveRef(name)
    } catch (error) {
      return {
        shape: 'ref',
        keyRef: name,
        value: undefined,
        needsResolve: false,
        invalid: '解引用 ref:' + name + ' 失败：' + (error instanceof Error ? error.message : String(error)),
      }
    }
    // ⚠️ 只解一层：解出来的值即便又长得像 ref: 也当明文（见模块注释）。
    const value = normalizeSecret(resolved)
    if (value === '') {
      return { shape: 'ref', keyRef: name, value: undefined, needsResolve: false, invalid: 'ref:' + name + ' 指向的条目不存在或为空' }
    }
    return decodeLiteral(value, 'ref', name)
  }
  if (text.startsWith('env:')) {
    const name = text.slice(4).trim()
    if (name === '') {
      return { shape: 'env', keyRef: null, value: undefined, needsResolve: false, invalid: 'env: 后面没有变量名' }
    }
    return decodeLiteral(normalizeSecret(process.env?.[name]), 'env', name)
  }
  return decodeLiteral(text, 'plain', null)
}

/** 明文形态的统一收尾（长度上限 + 控制字符检查）。 */
function decodeLiteral(value, shape, keyRef) {
  if (typeof value !== 'string' || value === '') {
    return { shape, keyRef, value: undefined, needsResolve: false, invalid: shape === 'plain' ? undefined : '凭据为空' }
  }
  if (value.length > MAX_KEY_CHARS) {
    return { shape, keyRef, value: undefined, needsResolve: false, invalid: `凭据长度 ${value.length} 超出 ${MAX_KEY_CHARS}：多半是把整段配置粘进来了` }
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { shape, keyRef, value: undefined, needsResolve: false, invalid: '凭据里含控制字符：重新复制一次（不要带换行）' }
  }
  return { shape, keyRef, value, needsResolve: false }
}

/**
 * 解析某渠道的**可用 key**。
 *
 * @param {object} lane 目录条目
 * @param {{ readCredential?: (name:string) => unknown|Promise<unknown> }} [deps]
 * @returns {Promise<{ key:string|null, keyRef:string|null, source:string, reason?:string }>}
 */
export async function resolveApiKey(lane, deps = {}) {
  const readCredential = deps?.readCredential
  if (lane?.kind === 'keyless') {
    return { key: null, keyRef: null, source: 'keyless' }
  }
  const ref = typeof lane?.apiKeyEnv === 'string' && lane.apiKeyEnv !== '' ? lane.apiKeyEnv : null
  if (ref === null) {
    return { key: null, keyRef: null, source: 'unset', reason: '目录条目没有声明 apiKeyEnv' }
  }
  if (typeof readCredential !== 'function') {
    return { key: null, keyRef: ref, source: 'unavailable', reason: '宿主 credentials 服务未注入（readCredential 缺失）' }
  }
  let raw
  try {
    raw = await readCredential(ref)
  } catch (error) {
    return {
      key: null,
      keyRef: ref,
      source: 'error',
      reason: '读取凭据 ' + ref + ' 失败：' + (error instanceof Error ? error.message : String(error)),
    }
  }
  const decoded = await decodeApiKey(raw, (name) => readCredential(name))
  if (decoded.value === undefined || decoded.value === '') {
    return {
      key: null,
      keyRef: decoded.keyRef ?? ref,
      source: decoded.shape,
      ...(decoded.invalid !== undefined ? { reason: decoded.invalid } : {}),
    }
  }
  return { key: decoded.value, keyRef: decoded.keyRef ?? ref, source: decoded.shape }
}

/**
 * 一条车道可用的**多把 key**（同渠道多账号/多 key 轮换）。
 *
 * ## 为什么免费渠道特别需要它（0.6.0，审计的 P0-6）
 *
 * 免费额度的单位几乎都是「每个账号/每把 key 每天多少」，于是同一条渠道配三把 key
 * 是最常见、也最有效的可用性手段。而本插件此前只读一个 `apiKeyEnv` 的**一个值** ——
 * 用户手里明明有三把 Groq key，插件只用第一把，撞上 429 就整条渠道不可用。
 *
 * ## 三种「多把」的写法都要认（不猜格式，只认确定的命名约定）
 *
 * | 写法 | 例子 | 为什么认它 |
 * |---|---|---|
 * | 基名 + `__N` 后缀 | `GROQ_API_KEY`、`GROQ_API_KEY__2`、`GROQ_API_KEY__3` | 不破坏任何既有配置；用户多写一条凭据即可 |
 * | 单条目里逗号/换行分隔 | `GROQ_API_KEY=sk-a,sk-b` | 直接从别处拷一串 key 的人最常见的做法 |
 * | 只有一个值 | 老配置 | 与旧行为逐字一致 |
 *
 * ⚠️ 上限 5 把：再多的收益（额度）远小于代价（每把都要探测/记账，出错时更难归因）。
 * 顺序**稳定**（基名在前、后缀按数字升序）—— 轮换要有确定顺序才可复现。
 *
 * @param {object} lane 目录条目
 * @param {{ readCredential?: (name:string) => unknown|Promise<unknown> }} [deps]
 * @returns {Promise<{ keys: string[], refs: string[], source: string, reason?: string }>}
 */
export async function resolveApiKeys(lane, deps = {}) {
  const MAX_KEYS = 5
  if (lane?.kind === 'keyless') return { keys: [], refs: [], source: 'keyless' }
  const base = typeof lane?.apiKeyEnv === 'string' && lane.apiKeyEnv !== '' ? lane.apiKeyEnv : null
  if (base === null) return { keys: [], refs: [], source: 'unset', reason: '目录条目没有声明 apiKeyEnv' }
  const readCredential = deps?.readCredential
  if (typeof readCredential !== 'function') {
    return { keys: [], refs: [base], source: 'unavailable', reason: '宿主 credentials 服务未注入（readCredential 缺失）' }
  }

  const keys = []
  const refs = []
  /**
   * 解一个条目名，并把可能的多值（逗号/换行/分号分隔）摊平。
   *
   * ⚠️ **先按分隔符切开，再逐段解码**（不是先整体解码再切）。
   * 第一版写成「整体 decode 再 split」，而 `decodeApiKey` 会拒含控制字符的值 ——
   * 于是 `k4,k5\nk6` 这种最自然的多行写法被整条丢掉，只剩别的条目里的 key。
   * 这是实测踩到的（`test/keyed/ready-state.mjs` 的顺序断言当场报错）。
   */
  const pushFrom = async (name) => {
    let raw
    try {
      raw = await readCredential(name)
    } catch {
      return
    }
    if (raw === undefined || raw === null) return
    const text = typeof raw === 'string' ? raw : String(raw)
    // 先切：换行、逗号、分号都是用户真实会用的分隔符（从别处拷一串 key 最常见的形态）。
    for (const part of text.split(/[\n,;]+/)) {
      if (keys.length >= MAX_KEYS) return
      const candidate = normalizeSecret(part)
      if (candidate === '') continue
      // `ref:` / `env:` 这类引用仍走解码器（它负责解引用与一层限制）；
      // 明文则自己校验（长度上限 + 控制字符），因为解码器会拒掉整段多行文本。
      let key = candidate
      if (candidate.startsWith('ref:') || candidate.startsWith('env:')) {
        const decoded = await decodeApiKey(candidate, (next) => readCredential(next))
        key = typeof decoded.value === 'string' ? normalizeSecret(decoded.value) : ''
      } else if (candidate.length > 4096 || /[\u0000-\u001f\u007f]/.test(candidate)) {
        continue
      }
      if (key === '' || keys.includes(key)) continue
      keys.push(key)
      refs.push(name)
    }
  }

  await pushFrom(base)
  for (let index = 2; index <= MAX_KEYS; index += 1) {
    if (keys.length >= MAX_KEYS) break
    await pushFrom(base + '__' + index)
  }
  if (keys.length === 0) {
    const single = await resolveApiKey(lane, deps)
    return { keys: [], refs: [base], source: single.source, ...(single.reason !== undefined ? { reason: single.reason } : {}) }
  }
  return { keys, refs, source: 'resolved' }
}

/**
 * 就绪判定。**这是页面「能不能用」那一栏的唯一依据。**
 *
 * @param {object} lane 目录条目（`catalog.js` 的形状）
 * @param {{ readCredential?: (name:string) => unknown|Promise<unknown> }} [deps]
 * @returns {Promise<{ ready:boolean, reason:string, keyRef:string|null, kind:string|undefined| null, source:string, retired:boolean }>}
 *
 * ⚠️ **返回 Promise**：`readCredential` 是异步的（宿主的 credentials 服务如此），
 * 调用方要 `await keyedLaneState(lane, { readCredential })`。传同步函数也能用
 * （await 一个非 Promise 值没有额外代价）。
 */
export async function keyedLaneState(lane, deps = {}) {
  const kind = typeof lane?.kind === 'string' ? lane.kind : null
  const base = { keyRef: null, kind, source: 'none', retired: lane?.retired === true }

  if (lane === null || typeof lane !== 'object') {
    return { ...base, ready: false, reason: '没有车道描述（lane 为空）' }
  }
  if (lane.retired === true) {
    return {
      ...base,
      keyRef: typeof lane.apiKeyEnv === 'string' ? lane.apiKeyEnv : null,
      ready: false,
      reason: `该渠道已下线${typeof lane.retiredOn === 'string' ? `（${lane.retiredOn}）` : ''}：不要再按攻略去注册，换一条车道。`,
    }
  }
  if (typeof lane.baseURL !== 'string' || !/^https:\/\//.test(lane.baseURL)) {
    return { ...base, ready: false, reason: '车道描述里没有合法的 https baseURL（目录损坏）' }
  }
  const placeholders = lanePlaceholders(lane)
  if (placeholders.length > 0) {
    return {
      ...base,
      keyRef: typeof lane.apiKeyEnv === 'string' ? lane.apiKeyEnv : null,
      ready: false,
      reason: `baseURL 里还有未替换的占位符 ${placeholders.join('、')}：先把账号 ID 之类填进去再启用（填之前这条车道必然会 404）。`,
    }
  }
  if (kind === 'keyless') {
    return { ...base, ready: true, source: 'keyless', reason: '免 key 直连：无需凭据，按上游的按 IP 限速使用。' }
  }
  if (kind !== 'keyed') {
    return { ...base, ready: false, reason: `未知的车道类型 kind=${String(lane.kind)}（目录损坏）` }
  }

  const resolved = await resolveApiKey(lane, deps)
  if (resolved.key !== null && resolved.key !== undefined) {
    return {
      ...base,
      ready: true,
      keyRef: resolved.keyRef,
      source: resolved.source,
      reason: `已配置 ${lane.apiKeyEnv}（凭据来源：${describeSource(resolved.source, resolved.keyRef)}）。`,
    }
  }
  if (resolved.source === 'unavailable' || resolved.source === 'error') {
    return { ...base, keyRef: resolved.keyRef, source: resolved.source, ready: false, reason: resolved.reason ?? '凭据服务不可用' }
  }
  return {
    ...base,
    keyRef: resolved.keyRef,
    source: resolved.source,
    ready: false,
    reason: resolved.reason ?? describeMissingKey(lane),
  }
}

/** 把凭据来源讲成人话（页面上「这条车道的 key 是从哪来的」）。 */
export function describeSource(source, keyRef) {
  switch (source) {
    case 'ref': return `凭据条目 ref:${keyRef ?? '?'}`
    case 'env': return `环境变量 ${keyRef ?? '?'}`
    case 'plain': return '明文'
    case 'keyless': return '无需凭据'
    default: return String(source)
  }
}

/**
 * 批量就绪概览（页面顶部的「N 条可用 / M 条待配置」）。
 *
 * 顺序与入参一致，单条失败不影响整批（一条渠道的凭据读取抛错不该让整页白屏）。
 */
export async function laneStates(lanes, deps = {}) {
  const list = Array.isArray(lanes) ? lanes : []
  const rows = []
  for (const lane of list) {
    try {
      rows.push({ lane, state: await keyedLaneState(lane, deps) })
    } catch (error) {
      rows.push({
        lane,
        state: {
          ready: false,
          keyRef: null,
          kind: lane?.kind ?? null,
          source: 'error',
          retired: lane?.retired === true,
          reason: '就绪判定异常：' + (error instanceof Error ? error.message : String(error)),
        },
      })
    }
  }
  const ready = rows.filter((row) => row.state.ready).length
  return { rows, ready, total: rows.length, pending: rows.length - ready }
}
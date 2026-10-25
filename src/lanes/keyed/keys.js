/**
 * 自带 key 车道的「手填 key」这一半：**校验 / 保存 / 清除 / 探测**。
 *
 * ## 为什么单独一个模块
 *
 * `ready.js` 只回答「现在能不能用」，`catalog.js` 只放数据，二者都是**只读**的。
 * 而「用户在页面上把 key 填进来」这件事有三件只读层不该有的东西：
 *
 * 1. **写入** —— 要落到宿主的 `credentials` 服务（`$DSH_HOME/.credentials.yaml`），
 *    不是自己开一个文件。理由见 `ready.js` 模块注释（宿主换 `DSH_HOME`、
 *    凭据变更事件、加密与权限都在那一层）。
 * 2. **探测** —— 真的拿这把 key 打一次上游，把 401 / 403 / 429 / 网络故障
 *    分开报。**只验证 key 是否有效**，不做「这条车道能不能写代码」这种断言。
 * 3. **脱敏** —— 任何返回值、错误文案、日志里都**不出现** key 本身。
 *    这是本模块唯一的硬纪律：它拿到的是明文凭据。
 *
 * ## 边界：仍然不自己读凭据文件
 *
 * 一切读写都走注入进来的函数（上层传宿主的 `credentials` 方法）。
 * 没有注入时返回结构化的「未接线」，而不是退回自己读 yaml —— 那样在 B 实例
 * （`DSH_HOME=E:\...`）会静默读错文件。
 *
 * @module src/lanes/keyed/keys
 */

import { normalizeSecret } from './ready.js'

/** 明文 key 的长度上限（与 `ready.js` 同一个数：超过它就是把整段配置粘进来了）。 */
export const MAX_KEY_CHARS = 4096

/** 探测超时：8 秒。上游是公网，本地环回那套 3 秒标准不适用。 */
export const PROBE_TIMEOUT_MS = 8_000

/** 探测结果里 `kind` 的全集（页面按它选徽章文案与颜色）。 */
export const PROBE_KINDS = Object.freeze([
  'ok',
  'no-key',
  'missing-config',
  'invalid-key',
  'forbidden',
  'rate-limited',
  'quota',
  'not-found',
  'bad-request',
  'server-error',
  'network',
  'timeout',
  // DNS / TLS 单独两档（0.6.0）：处置与「网络不通」不同，合成一个会让用户查错方向。
  'dns',
  'tls',
])

/**
 * 校验用户交上来的 key 原文。
 *
 * 只做**能给出可执行提示**的检查，不猜格式（每家 key 长相都不同，猜错会拒掉合法 key）。
 * 三条判据：非空、长度合理、不含控制字符 —— 后者是「粘贴时带进了换行/制表符」
 * 的典型症状，也是「明明填了却 401」最常见的原因。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
export function validateKeyInput(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'key 必须是一段文本' }
  const value = normalizeSecret(raw)
  if (value === '') return { ok: false, reason: 'key 是空的：粘贴一次，或者先「去拿 key」' }
  if (value.length > MAX_KEY_CHARS) {
    return { ok: false, reason: `key 长度 ${value.length} 超过 ${MAX_KEY_CHARS}：多半是把整段配置粘进来了` }
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, reason: 'key 里含换行或控制字符：重新复制一次（只复制编码本身，别带空格/换行）' }
  }
  if (/\s/.test(value)) {
    return { ok: false, reason: 'key 里有空白字符：复制时多半多选了一个空格或换行' }
  }
  return { ok: true, value }
}

/**
 * 脱敏展示：`sk-ab…wxyz`。
 *
 * 用户填完之后页面上只显示这个，**永远不回显原文**——回显等于把明文凭据
 * 留在浏览器内存、页面快照、以及任何一次「复制整页」里。
 *
 * @param {unknown} value
 * @returns {string} 未配置时返回空串
 */
export function maskKey(value) {
  const text = normalizeSecret(typeof value === 'string' ? value : '')
  if (text === '') return ''
  if (text.length <= 10) return '•'.repeat(Math.min(text.length, 12))
  return text.slice(0, 4) + '…' + text.slice(-4)
}

/**
 * 异常 → 一行可显示的文本，**且先脱敏**。
 *
 * 为什么必须脱敏：凭据服务的异常里可能嵌着写进去的值（`set(ref, value)` 的实现
 * 若在错误里带上参数，整把 key 就会随错误文案回到页面上、进日志）。
 * 这里对「连续 20+ 的疑似凭据片段」统一只留首尾。
 */
export function safeErrorText(error) {
  const message = error instanceof Error ? error.message : String(error)
  const flattened = message.replace(/\s+/g, ' ').trim()
  return flattened.replace(/[A-Za-z0-9_\-]{20,}/g, (match) => match.slice(0, 4) + '…' + match.slice(-2)).slice(0, 200)
}

/** 凭据名必须是合法的 POSIX 标识符（宿主 `credentialRef` 的语法）。 */
export function isUsableKeyRef(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/**
 * 这条车道的凭据名（keyless 没有凭据名，返回 `null`）。
 * @param {object} lane
 * @returns {string|null}
 */
export function keyRefOf(lane) {
  const name = lane?.apiKeyEnv
  if (typeof name !== 'string' || name === '') return null
  return isUsableKeyRef(name) ? name : null
}

/**
 * 保存一把 key：写进宿主凭据那条**同名条目**。
 *
 * @param {object} lane 目录条目
 * @param {unknown} rawValue 用户输入的原文（会先过 {@link validateKeyInput}）
 * @param {{ writeCredential?: (name: string, value: string) => unknown|Promise<unknown> }} deps
 * @returns {Promise<{ ok: boolean, keyRef?: string, masked?: string, reason?: string, code?: string }>}
 */
export async function saveLaneKey(lane, rawValue, deps = {}) {
  const ref = keyRefOf(lane)
  if (ref === null) {
    return { ok: false, code: 'no-key-ref', reason: '这条车道不需要 key（免 key 直连），没有可写的凭据名' }
  }
  if (typeof deps.writeCredential !== 'function') {
    return { ok: false, code: 'unwired', reason: '宿主 credentials 服务未注入（writeCredential 缺失），无法保存' }
  }
  const checked = validateKeyInput(rawValue)
  if (checked.ok !== true) return { ok: false, code: 'invalid', reason: checked.reason }
  try {
    await deps.writeCredential(ref, checked.value)
  } catch (error) {
    // ⚠️ 异常里可能嵌着请求体，只报类型与首段（`saveLaneKey` 的调用方可能是日志）。
    return { ok: false, code: 'write-failed', reason: '写入凭据 ' + ref + ' 失败：' + safeErrorText(error) }
  }
  return { ok: true, keyRef: ref, masked: maskKey(checked.value) }
}

/**
 * 清除一条车道的 key（宿主 `unset`：环境变量回退随即重新生效）。
 *
 * @param {object} lane
 * @param {{ unsetCredential?: (name: string) => unknown|Promise<unknown> }} deps
 * @returns {Promise<{ ok: boolean, reason?: string, code?: string }>}
 */
export async function clearLaneKey(lane, deps = {}) {
  const ref = keyRefOf(lane)
  if (ref === null) return { ok: false, code: 'no-key-ref', reason: '这条车道没有可清除的凭据名' }
  if (typeof deps.unsetCredential !== 'function') {
    return { ok: false, code: 'unwired', reason: '宿主 credentials 服务未注入（unsetCredential 缺失），无法清除' }
  }
  try {
    await deps.unsetCredential(ref)
  } catch (error) {
    return { ok: false, code: 'unset-failed', reason: '清除凭据 ' + ref + ' 失败：' + safeErrorText(error) }
  }
  return { ok: true }
}

/**
 * 一条车道的凭据面状态（页面输入框旁边那一行）。
 *
 * 与 `keyedLaneState` 的分工：那个回答「能不能用」，这个回答
 * 「**凭据本身**是什么状态」—— 已配置/未配置、值从哪来、能不能删。
 *
 * @param {object} lane
 * @param {{
 *   readCredential?: (name: string) => unknown|Promise<unknown>,
 *   describeCredential?: (name: string) => { configured: boolean, source?: string, writable?: boolean }|Promise<object>|undefined,
 * }} deps
 */
export async function laneKeyState(lane, deps = {}) {
  const ref = keyRefOf(lane)
  if (lane?.kind === 'keyless') {
    return { keyRef: null, configured: false, writable: false, source: 'keyless', masked: '', reason: '免 key 直连：不需要凭据' }
  }
  if (ref === null) {
    return { keyRef: null, configured: false, writable: false, source: 'none', masked: '', reason: '目录条目没有声明合法的 apiKeyEnv' }
  }
  let info
  if (typeof deps.describeCredential === 'function') {
    try {
      info = await deps.describeCredential(ref)
    } catch {
      info = undefined
    }
  }
  let raw
  if (typeof deps.readCredential === 'function') {
    try {
      raw = await deps.readCredential(ref)
    } catch {
      raw = undefined
    }
  }
  const value = normalizeSecret(typeof raw === 'string' ? raw : '')
  const configured = value !== '' || info?.configured === true
  const source = typeof info?.source === 'string'
    ? info.source
    : (value !== '' ? 'file' : 'none')
  return {
    keyRef: ref,
    configured,
    // 宿主的 `describe` 说能不能写；没有 describe 时按「能写」处理（set 会自己报错）。
    writable: info?.writable !== false,
    source,
    masked: maskKey(value),
    reason: configured ? '' : `尚未填写 ${ref}`,
  }
}

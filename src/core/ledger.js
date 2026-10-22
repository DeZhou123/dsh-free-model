/**
 * Token 账本回报点（尽力而为，绝不影响推理）。
 *
 * ## 为什么是「软依赖」
 *
 * 账本本身由 OFM（dsh-our-free-model）维护：数据落 `~/.dsh/our-free-model/stats.json`，
 * 页面在 OFM 的「数据看板」里。本插件只为让 buddy 通道的消耗**继续记进同一本账**，
 * 不复刻账本实现。
 *
 * OFM 不在场（用户只装本插件）、或 OFM 内部结构变了时，记账失效**不能**让推理失败 ——
 * 记账是观测，不是功能。故全部调用都包在 try/catch 里，且调用方永远拿得到结果。
 *
 * ## 后端从哪来
 *
 * 后端不是「找个文件 require 进来」而是**由接线层注入**：OFM 的账本模块是它包内的
 * `src/token-ledger.js`，路径与导出名都属其内部实现，硬编码 import 会在它下次
 * 重构时静默断掉（且 ESM 里 import 失败是硬错误）。接线层用能力探测拿到
 * `recordTokenUsage` / `peekLedgerAccount` 两个函数的引用后注入这里。
 */

/** @typedef {{ reportLedgerAccount?: Function, recordTokenUsage?: Function, peekLedgerAccount?: Function }} LedgerBackend */

/** @type {LedgerBackend | undefined} */
let backend

/**
 * 安装账本后端。
 *
 * @param {LedgerBackend | undefined} next
 * @returns {() => void} 卸载函数（只卸载仍属于自己那一次注入的后端）
 */
export function attachLedger(next) {
  const previous = backend
  backend = next
  return () => {
    if (backend === next) backend = previous
  }
}

/**
 * 回报「本笔请求解析出的账号」，供账本按账号聚合。
 *
 * ⚠️ 必须在**解析出凭据之后、任何 SSE 帧之前**调用：账本在 usage 帧到达时
 * 才去读这条回报（见 OFM `token-ledger.ts` 的 `reportedAccounts` 注释），
 * 提前或延后都会读到「上一笔请求的账号」。
 *
 * @param {string} provider
 * @param {string} accountId
 */
export function reportLedgerAccount(provider, accountId) {
  try {
    backend?.reportLedgerAccount?.(provider, accountId)
  } catch {
    // 记账失败不影响推理。
  }
}

/**
 * 读「最后一次为该 provider 解析出的账号」。
 *
 * 失败请求可能没等到 usage 帧（彼时才读账号），失败行的归属退回这里 ——
 * 比留空有用（排查「哪个号挂了」）。
 *
 * @param {string} provider
 * @returns {string} 取不到时返回空串
 */
export function peekLedgerAccount(provider) {
  try {
    const value = backend?.peekLedgerAccount?.(provider)
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/**
 * 写一笔调用记录。
 *
 * 字段口径与 OFM `TokenLedgerEntry` 对齐（`channel` / `provider` / `model` /
 * `usageReported` / 四个 token 细分 / `ttftMs` / `durationMs` / `error`）。
 *
 * @param {object} entry
 */
export function recordTokenUsage(entry) {
  try {
    backend?.recordTokenUsage?.(entry)
  } catch {
    // 记账失败不影响推理。
  }
}

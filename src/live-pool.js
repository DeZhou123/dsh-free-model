/**
 * 账号池的**晚绑定门面**。
 *
 * ## 为什么不能把 `pool.current` 存下来用
 *
 * 插件加载早于 OFM 的 channel-pack fiber：apply 那一刻 `ctx.get('accountPool')`
 * 通常答 undefined（cordis 的机会式读取对「尚未提供」和「确实没有」是同一种回答）。
 * 一次读取就存下来，会把「尚未提供」固化成**永久缺席** —— 用户看到的是
 * 「通道装上了，但所有请求都报没有可用账号」，日志里一句线索都没有。
 *
 * OFM 自己在 `webServer` / `connection` / `attachments` 三处都踩过同一个坑，
 * 注释里写着「a one-shot read silently cost the whole feature」。
 *
 * 门面把每次方法调用都转发到**当前**的池：宿主池晚到、或中途被替换，
 * 后续请求立刻用上新池，不需要重启。
 *
 * @module src/live-pool
 */

/** 需要转发的池方法（与 `src/core/pool-contract.js` 的契约一致）。 */
const METHODS = [
  'getAvailableAccount',
  'listAccounts',
  'listAccountsByProvider',
  'listAllAccounts',
  'findAccount',
  'findAccountIdByCredential',
  'hasLoggedInAccount',
  'resolveCredentialForAccount',
  'addAccount',
  'updateAccount',
  'removeAccount',
  'updateModelRateLimit',
  'clearModelRateLimits',
  'permanentLocked',
  'disabledModelsFor',
  'listDisabledModels',
  'setModelDisabled',
  'setModelsDisabled',
  'clearModelsDisabled',
  'clearDisabledModels',
  'setAccountsEnabled',
  'reorderAccounts',
  'sweepExpiredRateLimits',
]

/**
 * 造一个转发到当前池的门面。
 *
 * @param {{ current: any }} view `poolView(ctx)` 的返回值
 * @returns {any}
 */
export function livePool(view) {
  /** @type {Record<string, Function>} */
  const facade = {}
  for (const method of METHODS) {
    facade[method] = (...args) => {
      const target = view.current
      if (target === undefined || target === null) {
        // 池缺席：只读访问给保守默认值，写访问抛明确的错。
        // ⚠️ 这里**不抛**「no account pool」这类错误：适配器会把任何抛出
        // 升级成 MISSING_CREDENTIAL，用户会去重新登录（方向完全错）。
        // 返回「没有账号」让上层走它自己的语义分支（含限流判定）。
        if (method === 'getAvailableAccount') return null
        if (method === 'listAccounts' || method === 'listAccountsByProvider' || method === 'listAllAccounts') return []
        if (method === 'findAccountIdByCredential') return ''
        if (method === 'findAccount') return undefined
        if (method === 'hasLoggedInAccount') return false
        if (method === 'resolveCredentialForAccount') return undefined
        if (method === 'permanentLocked') return false
        if (method === 'disabledModelsFor') return new Set()
        if (method === 'listDisabledModels') return {}
        if (method === 'sweepExpiredRateLimits') return undefined
        if (method === 'setModelDisabled' || method === 'setModelsDisabled'
          || method === 'clearModelsDisabled' || method === 'clearDisabledModels'
          || method === 'setAccountsEnabled' || method === 'reorderAccounts') return undefined
        throw new Error('free-model: 账号池不可用（宿主未提供 accountPool）')
      }
      const fn = target[method]
      if (typeof fn !== 'function') {
        if (method === 'clearModelRateLimits') return 0
        return undefined
      }
      return fn.apply(target, args)
    }
  }
  Object.defineProperty(facade, '__live', { value: view, enumerable: false })
  return facade
}
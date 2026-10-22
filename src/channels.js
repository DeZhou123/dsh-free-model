/**
 * 腾讯系两个产品（CodeBuddy / WorkBuddy）的**通道装配层**。
 *
 * 这就是 OFM 2.5.8 删掉的那一段：`vendor/channel-pack/src/index.ts` 里
 * 「Buddy (腾讯 CodeBuddy) 服务」与「WorkBuddy (腾讯 WorkBuddy) 服务」两块
 * （v2.5.7 的 index.ts:557-657）。
 *
 * ## 装进来的东西，一件没少
 *
 * | 原实现 | 这里 | 说明 |
 * |---|---|---|
 * | `new BuddyAuth(ctx)` | 同名类 | 轮询式登录 + refresh_token 静默续期 |
 * | `registerBuddyLlm(ctx, {...})` | 同函数 | LLM 适配器注册（路由名 = product.id） |
 * | `pickBuddyCredential`（按到期分档选号） | 同名函数 | 见下 |
 * | `BuddyBalanceSelector`（各自一份余额缓存） | 同名类 | 按「N 天内到期积分」排序 |
 * | `createPoolRefresh` | 同名函数 | 刷**池里实际用的那一个**账号 |
 * | `throwIfAllAccountsRateLimited` | 同名函数 | 区分「全被限流」与「真没登录」 |
 * | `pool.pruneAccountsWithForeignDomain` | **不搬** | 见下方「刻意不做的三件事」 |
 *
 * ## 刻意不做的三件事
 *
 * 1. **不清理 WorkBuddy 旧版（中国版）账号**。原实现启动时会按「凭据 domain ≠
 *    产品 apiDomain」把旧条目删掉 —— 那正是 2.5.8 明确保留的数据。本插件对历史
 *    账号只读不删；`resolveCredential` 侧用 `X-Domain` 跟随凭据自身域名发请求，
 *    旧号照常能用（不去猜它属于哪个区域）。
 * 2. **不建第二个账号池**。池由宿主注入（OFM 的 `AccountPool` 实例），
 *    账号索引 `channel-pack/state.json` 与凭据 `.credentials.yaml` 只有一份。
 * 3. **不注册同名的 cordis Service**（`ctx.buddyAuth` / `ctx.workbuddyAuth`）。
 *    宿主里 OFM 的 channel-pack 可能已经注册过，第二次注册会抛
 *    `service "buddyAuth" has been registered`，把整个 apply 打死。
 *    两个实例由本模块自己持有。
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { BuddyAuth, BUDDY_CREDENTIAL_REF, createPoolRefresh } from './core/buddy-auth.js'
import { registerBuddyLlm } from './core/buddy-adapter.js'
import { CODEBUDDY, WORKBUDDY } from './core/product.js'
import { BuddyBalanceSelector, pickBuddyAccount } from './core/buddy-balance-selector.js'
import { buddyExpiringWindowDays } from './core/buddy-balance-rank.js'
import { allAccountsRateLimitedForModel } from './core/pool-contract.js'
import { reportLedgerAccount } from './core/ledger.js'

/**
 * 按凭据 ref 解析 buddy 系凭据（CodeBuddy 与 WorkBuddy **共用这一个函数**）。
 *
 * 两站凭据同构（同一 CLI 内核、同一认证协议），差别只在 endpoint；
 * 解析这件事与 endpoint 无关，故不写两份。
 *
 * @param {{ credentials: { resolve: Function } }} ctx
 * @param {string} refName
 */
async function resolveBuddyCredentialByRef(ctx, refName) {
  const resolved = await ctx.credentials.resolve(credentialRef(refName))
  if (!resolved) return undefined
  try {
    return JSON.parse(resolved.value)
  } catch {
    return undefined
  }
}

/**
 * 在「候选为空、即将退到单凭据 ref」这一刻，先证明失败原因是不是**限流**。
 *
 * ## 它修的是什么（OFM 真实缺陷，2026-10-03）
 *
 * 用户报障：`/compact` 连续四次报「Compaction could not produce a useful summary」，
 * 会话日志里携带的真实错误却是 `buddy: no usable credential; log in from the
 * Channel Pack panel first` —— 而当时 buddy 账号**已登录、已启用**，只是被
 * `deepseek-v4.1-flash` 的模型级限流标记挡住。
 *
 * 链路：唯一的启用账号被限流 → 候选筛成空集 → 退到单凭据 ref
 * `BUDDY_ACCESS_TOKEN`，而 Channel Pack 登录只写 `BUDDY_ACCOUNT_XXX`、
 * 该 ref **根本不存在** → 适配器抛 `MISSING_CREDENTIAL`。
 *
 * 即：**凭据问题被误报成「没登录」**，用户据此去重新登录，方向完全错。
 *
 * ⚠️ 这里**只改错误语义，不改可用性**：没有账号可用就是没有，压缩该失败仍然失败。
 *
 * @param {any} pool
 * @param {{ id: string, displayName: string }} product
 * @param {string} [modelId]
 */
function throwIfAllAccountsRateLimited(pool, product, modelId) {
  const limited = allAccountsRateLimitedForModel(
    // 只统计**启用**账号：停用账号本就不参与自动选号，把它们算进来会让
    // 「有一个号被停用」的普通情况被误报成「全部限流」。
    pool.listAccountsByProvider(product.id).filter((a) => a.enabled),
    modelId ?? '',
  )
  if (limited === undefined) return
  throw new LlmError(
    `${product.displayName}：模型 ${modelId} 的可用账号均在限流中，`
    + `最近一个将于 ${new Date(limited).toLocaleString('zh-CN')} 解禁。`
    + '可改用其它 provider / 模型，或等待解禁后再试（无需重新登录）。',
    'QUOTA_EXCEEDED',
  )
}

/**
 * buddy 系的选号编排：按「enabled + 模型未受限」筛候选 → 按余额分档选号 → 取凭据。
 *
 * ⚠️ 余额分档**只在这批候选内部进行** —— 策略建立在「模型没有受限且账号没有
 * 被停用」的基础上，不能因为某个号积分多就绕开限流标记。
 *
 * ⚠️ **免费模型跳过余额分档**（`isFreeModel === true`）：免费模型消耗 0 积分，
 * 没有「该烧哪个包」的选择问题，却被「锁定永久积分」那道门一并拦下，会报出
 * 「账号有余额却没有可用账号」的矛盾错误（OFM 真实报障）。限流过滤仍然生效。
 *
 * @throws LlmError 锁定且无可用账号时**抛错，绝不回落**，否则锁定形同虚设。
 */
async function pickBuddyCredential(ctx, pool, options) {
  const { product, selector, displayName, modelId, isFreeModel } = options
  const tried = new Set()
  const resolveCredential = (refName) => resolveBuddyCredentialByRef(ctx, refName)
  const candidates = pool
    .listAccountsByProvider(product.id)
    .filter((a) => a.enabled)
    .filter((a) => {
      // 与 getAvailableAccount 的限流判据保持一致（空 modelId = 不过滤）。
      const key = modelId ?? ''
      if (key.length === 0) return true
      if (!a.modelRateLimits) return true
      const resetAt = a.modelRateLimits[key]
      return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
    })
    .map((a) => ({ id: a.id, credentialRef: a.credentialRef }))

  if (isFreeModel === true) {
    for (const candidate of candidates) {
      const credential = await resolveCredential(candidate.credentialRef)
      if (credential !== undefined) return { credential, tried }
      tried.add(candidate.id)
    }
    // 免费模型下若凭据全坏，仍落到常规路径，以复用既有错误语义
    // （凭据问题应报「凭据不可用」，而不是被误报成「额度已用尽」）。
  }

  const allowPermanent = !pool.permanentLocked(product.id)
  const picked = await pickBuddyAccount(selector, candidates, { allowPermanent, resolveCredential })
  if (picked.kind === 'account') {
    return { credential: picked.credential, tried: new Set(picked.tried) }
  }
  for (const id of picked.tried) tried.add(id)
  if (picked.kind === 'locked') {
    // ⚠️ **锁定时绝不可落到调用方的 getAvailableAccount 兜底** —— 那会绕过锁定、
    // 照样消耗永久积分，锁定形同虚设。
    const days = buddyExpiringWindowDays()
    // ⚠️ 同样要区分「真的用尽」与「查不到」：把一次网络抖动报成「额度已用尽」，
    // 用户会去解锁或白等，而号其实有钱。
    if (picked.reason?.kind === 'unknown') {
      throw new LlmError(
        `${displayName}：无法确认是否有可用账号。已锁定永久积分，而部分账号的余额查询失败`
        + `（${picked.reason.errors.slice(0, 2).join('；')}）。这些账号**可能仍有**「${days} 天内到期」`
        + '的积分 —— 请重试，或检查凭据是否失效。',
        'QUOTA_EXCEEDED',
      )
    }
    throw new LlmError(
      `${displayName}：没有可用账号。已锁定永久积分，而所有账号的「${days} 天内到期」`
      + '积分都已用尽。请解锁永久积分，或等待资源包到期后重新发放额度。',
      'QUOTA_EXCEEDED',
    )
  }
  return { tried }
}

/**
 * 装配一个产品的完整通道（auth + adapter）。
 *
 * @param {any} ctx
 * @param {any} pool 宿主注入的账号池（OFM AccountPool 实例或同形替身）
 * @param {import('./core/product.js')} product
 * @param {{ readImage?: Function, readImageRequest?: Function, warn?: (m: string) => void }} bridge
 */
export function mountBuddyChannel(ctx, pool, product, bridge) {
  const displayName = product.displayName
  const selector = new BuddyBalanceSelector({
    product,
    resolveCredential: (refName) => resolveBuddyCredentialByRef(ctx, refName),
  })
  const auth = new BuddyAuth(ctx, { product })

  const adapter = registerBuddyLlm(ctx, {
    credentialRef: credentialRef(product.defaultCredentialRef),
    resolveCredential: async (modelId) => {
      // 优先按「快到期积分」分档选号（锁定永久积分时也走这条）。
      const picked = await pickBuddyCredential(ctx, pool, {
        product,
        selector,
        displayName,
        modelId,
        // ⚠️ adapter 在此处是自引用：闭包只在注册完成后才执行，故无 TDZ 问题。
        isFreeModel: await adapter.isFreeModel(modelId),
      })
      if (picked.credential) return picked.credential
      // 回退到账号池的既有选择（凭据损坏的账号已被 tried 排除），最后才退单凭据 ref。
      // provider 实参用 product.id 而非字面量：写死字面量在改名 / 多产品场景下
      // 会静默查不到账号。
      // ⚠️ modelId 必须透传：限流按**模型**记（modelRateLimits[model]），
      // 传空串会让 getAvailableAccount 的限流过滤整体短路。
      const available = await pool.getAvailableAccount(product.id, modelId ?? '', picked.tried)
      if (available) {
        // Token 账本：回报「本笔请求解析出的账号」。
        reportLedgerAccount(product.id, available.entry.id)
        return available.credential
      }
      // 退到单凭据 ref 之前先证明失败原因：全被模型限流时报明确的限流错误，
      // 而不是让它降级成误导性的 MISSING_CREDENTIAL。
      throwIfAllAccountsRateLimited(pool, product, modelId)
      return await resolveBuddyCredentialByRef(ctx, product.defaultCredentialRef)
    },
    // 刷新**账号池里实际使用的那一个账号**，而不是默认单凭据 ref ——
    // 后者在 Channel Pack 登录路径下根本不存在，会把 401 报成「未配置凭据」并自锁。
    refresh: createPoolRefresh(pool, product.id, auth),
    fetchRemoteModels: () => auth.fetchModels(pool),
    ...(bridge.readImage !== undefined ? { readImage: bridge.readImage } : {}),
    ...(bridge.readImageRequest !== undefined ? { readImageRequest: bridge.readImageRequest } : {}),
    accountPool: pool,
    product,
  })

  // 启动时若已有可续期凭据则安排续期（与 OFM 同语义：只武装单凭据 ref 那一条，
  // 池内多账号的续期由 OFM 自己的定时器负责）。
  auth.scheduleRefresh()

  return { auth, adapter, product, selector }
}

/** 两个产品的挂载入口（顺序与 OFM 的 `ALL_PRODUCTS` 一致）。 */
export const BUDDY_PRODUCTS = [CODEBUDDY, WORKBUDDY]

/** 重导出，便于外部（RPC / 测试）按需取用。 */
export { BUDDY_CREDENTIAL_REF }
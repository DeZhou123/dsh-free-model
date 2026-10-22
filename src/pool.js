/**
 * 宿主账号池的接入：**优先复用**，缺失时退化成本地只读/受控写入实现。
 *
 * ## 两条路径
 *
 * 1. **宿主池在场**（OFM 的 channel-pack 正在跑，`ctx.provide('accountPool')`）：
 *    直接用它的实例。账号索引、凭据、限流标记、永久积分锁定全都是同一份 ——
 *    本插件与 OFM 的其它通道共享一个池，不存在「两个池各写各的」。
 * 2. **宿主池缺席**（用户没装 OFM，或 OFM ≤2.5.7 之外的新版本改了提供方式）：
 *    退化成 `LocalPool`，读写**同一个** `$DSH_HOME/channel-pack/state.json`。
 *
 * ## 本地实现为什么必须是「只改自己的条目」
 *
 * `state.json` 是 dsh home 级共享文档，OFM 的其它 11 个通道也写它。整份重写时
 * 若不认识某个字段（新版本加的）就会**静默丢掉**。所以本地实现的做法是：
 * 读原文 → 只替换 `accounts` 里 provider 属于本插件的那几条 → 其余字段与条目
 * 原样保留（未知字段照抄）。OFM 的 `ChannelPackState` 里 `loomyPermanentLocked`
 * 这类「丢了不可逆」的字段因此不会被本插件抹掉。
 *
 * @module src/pool
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 本插件负责的 provider（`retired-providers.ts` 里那两个）。 */
export const OWNED_PROVIDERS = new Set(['buddy', 'workbuddy'])

/** 解析 DSH home（与 OFM `resolveChannelPackHome` 同序）。 */
export function resolveDshHome(ctx) {
  const override = process.env.DSH_CHANNEL_PACK_STATE_DIR
  if (override !== undefined && override.trim().length > 0) return override.trim()
  const profileHome = readService(ctx, 'profileContext')?.home
  if (typeof profileHome === 'string' && profileHome.length > 0) return profileHome
  const envHome = process.env.DSH_HOME
  if (envHome !== undefined && envHome.trim().length > 0) return envHome.trim()
  return join(homedir(), '.dsh')
}

/** 读一个可能尚未提供的服务（`ctx.get` 在缺失时答 undefined 而不是抛错）。 */
export function readService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    // cordis 在部分版本里对未注册的名字会抛（strict 模式）。
    return undefined
  }
}

/**
 * 取宿主账号池的**晚绑定**视图：每次访问都重新查，故 OFM 后挂载也能拿到。
 *
 * ⚠️ 不能在 apply 时读一次就存下来：插件加载早于 channel-pack 的 fiber，
 * 一次读取会把「尚未提供」固化成永久缺席（OFM 自己在 webServer / connection /
 * attachments 三处都踩过同一个坑）。
 */
export function poolView(ctx) {
  return {
    get current() {
      const live = readService(ctx, 'accountPool')
      if (live !== undefined && typeof live.getAvailableAccount === 'function') return live
      return fallbacks.get(ctx)
    },
  }
}

/**
 * 退化实现：由 `ensureFallbackPool` 安装。
 *
 * ⚠️ 按 ctx 分域（WeakMap）而不是模块级单例：同一进程里可能有多个 composition
 * （单测各场景、将来的多 profile 宿主），全局单例会让第二个 ctx 读到第一个的池
 * —— 表现为「明明没装 OFM，却看到别人的账号」。
 */
const fallbacks = new WeakMap()

/**
 * 在没有宿主池时安装本地实现（幂等）。
 *
 * @returns {{ pool: LocalPool, dispose: () => void }}
 */
export function ensureFallbackPool(ctx) {
  const existing = fallbacks.get(ctx)
  if (existing !== undefined) return { pool: existing, dispose: () => {} }
  const created = new LocalPool(ctx)
  fallbacks.set(ctx, created)
  return {
    pool: created,
    dispose: () => {
      if (fallbacks.get(ctx) === created) fallbacks.delete(ctx)
    },
  }
}

/** 该池是不是本模块装的本地实现（供 summary 报来源）。 */
export function isLocalPool(candidate) {
  return candidate instanceof LocalPool
}

/**
 * 本地账号池：读写与 OFM 同一份 `channel-pack/state.json`。
 *
 * 只实现适配器与 UI 真正用到的那几个方法；语义逐条对齐 OFM
 * `AccountPool`（见各方法注释里的出处）。
 */
export class LocalPool {
  constructor(ctx) {
    const home = resolveDshHome(ctx)
    this.home = home
    this.statePath = join(home, 'channel-pack', 'state.json')
    this.credentials = ctx.credentials
    this.logger = ctx.logger
    this.loaded = false
    this.accounts = []
    this.extra = {}
  }

  /** 载入一次；之后的读都以内存副本为准（与 OFM 同理由：写是读-改-整体写回）。 */
  ensureLoaded() {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.statePath)) return
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf-8'))
      if (typeof parsed !== 'object' || parsed === null) return
      const list = Array.isArray(parsed.accounts) ? parsed.accounts : []
      this.accounts = list.filter((entry) => typeof entry === 'object' && entry !== null)
      // 其余字段原样保留（含本插件不认识的键）。
      const { accounts: _ignored, ...rest } = parsed
      this.extra = rest
    } catch (error) {
      this.logger?.warn?.(`[free-model] 读取 ${this.statePath} 失败，本次以空账号列表启动: ${String(error)}`)
    }
  }

  /** 原子写回：只替换本插件负责的条目，其它条目与顶层字段原样保留。 */
  persist() {
    this.ensureLoaded()
    const others = this.accounts.filter((entry) => !OWNED_PROVIDERS.has(entry.provider))
    const mine = this.accounts.filter((entry) => OWNED_PROVIDERS.has(entry.provider))
    const next = { ...this.extra, accounts: [...others, ...mine] }
    try {
      mkdirSync(join(this.home, 'channel-pack'), { recursive: true })
      const tmp = `${this.statePath}.free-model.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
      renameSync(tmp, this.statePath)
    } catch (error) {
      this.logger?.warn?.(`[free-model] 写入 ${this.statePath} 失败: ${String(error)}`)
    }
  }

  /**
   * 列出某 provider 的全部账号（含派生状态）。
   *
   * ⚠️ 与 {@link listAccountsByProvider} 的差别只在**返回类型**：OFM 的
   * `AccountPool.listAccounts` 返回 `ProviderAccountStatus[]`（条目 + 运行时状态），
   * 而 `listAccountsByProvider` 返回纯条目。本插件不需要派生状态，
   * 但 `BuddyAuth.refreshAll` 用的是前者 —— 保留同名方法让两者都能跑。
   */
  async listAccounts(provider) {
    return this.listAccountsByProvider(provider)
  }

  /** 列出某 provider 的全部账号。 */
  listAccountsByProvider(provider) {
    this.ensureLoaded()
    return this.accounts
      .filter((entry) => entry.provider === provider)
      .map((entry) => ({ ...entry, enabled: entry.enabled !== false }))
  }

  /** 列出全部账号（两个 provider）。 */
  listAllAccounts() {
    this.ensureLoaded()
    return this.accounts
      .filter((entry) => OWNED_PROVIDERS.has(entry.provider))
      .map((entry) => ({ ...entry, enabled: entry.enabled !== false }))
  }

  /** 按 id 取一条。 */
  findAccount(id) {
    this.ensureLoaded()
    return this.accounts.find((entry) => entry.id === id)
  }

  /**
   * 该 provider 是否有已登录账号（决定模型目录是否可见）。
   *
   * 判据与 OFM 一致：**有启用且 enabled 的账号**才算。
   */
  async hasLoggedInAccount(provider) {
    const list = this.listAccountsByProvider(provider).filter((entry) => entry.enabled)
    return list.length > 0
  }

  /**
   * 选一个该模型上未受限、且启用的账号。
   *
   * ⚠️ `modelId` 为空串时**不过滤限流**（与 OFM 的实现完全一致：
   * `if (modelId.length === 0) return true`），故调用方必须透传模型。
   */
  async getAvailableAccount(provider, modelId, exclude) {
    const now = Date.now()
    const candidates = this.listAccountsByProvider(provider)
      .filter((entry) => entry.enabled)
      .filter((entry) => (exclude === undefined ? true : !exclude.has(entry.id)))
      .filter((entry) => {
        const key = modelId ?? ''
        if (key.length === 0) return true
        const resetAt = entry.modelRateLimits?.[key]
        return resetAt === undefined || resetAt === 0 || now >= resetAt
      })
    const picked = candidates[0]
    if (picked === undefined) return null
    const credential = await this.resolveCredentialForAccount(picked.id)
    if (credential === undefined) return null
    return { entry: picked, credential }
  }

  /** 解析某账号的凭据（池条目只存 ref，值在 `ctx.credentials`）。 */
  async resolveCredentialForAccount(accountId) {
    const entry = this.findAccount(accountId)
    if (entry === undefined) {
      // 允许直接传 ref 名。
      try {
        const resolved = await this.credentials.resolve(accountRef(accountId))
        return resolved === undefined ? undefined : JSON.parse(resolved.value)
      } catch {
        return undefined
      }
    }
    try {
      const resolved = await this.credentials.resolve(accountRef(entry.credentialRef))
      if (resolved === undefined) return undefined
      return JSON.parse(resolved.value)
    } catch {
      return undefined
    }
  }

  /** 按凭据内容（access_token）反查账号 id。 */
  async findAccountIdByCredential(provider, identity) {
    if (typeof identity !== 'string' || identity.length === 0) return ''
    for (const entry of this.listAccountsByProvider(provider)) {
      const credential = await this.resolveCredentialForAccount(entry.id)
      if (credential !== undefined && credential.access_token === identity) return entry.id
    }
    return ''
  }

  /** 新增账号条目。 */
  async addAccount(entry) {
    this.ensureLoaded()
    this.accounts = [...this.accounts.filter((candidate) => candidate.id !== entry.id), entry]
    this.persist()
  }

  /** 局部更新账号条目。 */
  async updateAccount(id, patch) {
    this.ensureLoaded()
    this.accounts = this.accounts.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
    this.persist()
  }

  /** 删除账号条目（**只删索引，不删凭据** —— 与 OFM 同语义）。 */
  async removeAccount(id) {
    this.ensureLoaded()
    this.accounts = this.accounts.filter((entry) => entry.id !== id)
    this.persist()
  }

  /** 记一条模型级限流。 */
  async updateModelRateLimit(accountId, modelId, resetAtMs) {
    this.ensureLoaded()
    this.accounts = this.accounts.map((entry) => {
      if (entry.id !== accountId) return entry
      const limits = { ...(entry.modelRateLimits ?? {}), [modelId]: resetAtMs }
      return { ...entry, modelRateLimits: limits }
    })
    this.persist()
  }

  /** 永久积分锁定状态（本地实现恒为未锁定：锁定表由 OFM 单独存放）。 */
  permanentLocked() {
    return false
  }

  /**
   * 模型黑名单（本地实现**参与**）。
   *
   * 语义与 OFM 的 `AccountPool` 一致：**黑名单制** —— 只有键存在且为 `true`
   * 的模型被关闭，未记录的模型默认打开。数据住在同一份 `state.json` 的
   * `disabledModels` 字段里，所以本插件与 OFM 面板看到的是同一个开关。
   */
  disabledModelsFor(provider) {
    return new Set(
      Object.entries(this.listDisabledModels(provider))
        .filter(([, disabled]) => disabled === true)
        .map(([id]) => id),
    )
  }

  /** 某 provider 的黑名单原表（`modelId → true`）。 */
  listDisabledModels(provider) {
    this.ensureLoaded()
    const all = this.extra.disabledModels
    if (typeof all !== 'object' || all === null) return {}
    const row = all[provider]
    return typeof row === 'object' && row !== null ? { ...row } : {}
  }

  /** 整体写回黑名单（只改本插件负责的 provider，其余原样保留）。 */
  writeDisabledModels(provider, map) {
    this.ensureLoaded()
    const all = typeof this.extra.disabledModels === 'object' && this.extra.disabledModels !== null
      ? { ...this.extra.disabledModels }
      : {}
    all[provider] = map
    this.extra.disabledModels = all
    this.persist()
  }

  /** 关掉 / 打开一个模型。 */
  async setModelDisabled(provider, modelId, disabled) {
    const map = this.listDisabledModels(provider)
    if (disabled) map[modelId] = true
    else delete map[modelId]
    this.writeDisabledModels(provider, map)
  }

  /** 批量关掉（`disabled=true`）或批量打开。 */
  async setModelsDisabled(provider, modelIds, disabled = true) {
    const map = this.listDisabledModels(provider)
    for (const id of modelIds) {
      if (disabled) map[id] = true
      else delete map[id]
    }
    this.writeDisabledModels(provider, map)
  }

  /** 清掉指定模型的黑名单条目（= 全部打开）。 */
  async clearModelsDisabled(provider, modelIds) {
    await this.setModelsDisabled(provider, modelIds, false)
  }

  /** 清空该 provider 的黑名单（= 全部打开）。 */
  async clearDisabledModels(provider) {
    this.writeDisabledModels(provider, {})
  }

  /** 供应商级开关：启用 = 清空黑名单 + 启用全部账号（与 OFM 同语义）。 */
  async setAccountsEnabled(provider, enabled) {
    this.ensureLoaded()
    if (enabled) this.writeDisabledModels(provider, {})
    this.accounts = this.accounts.map((entry) => (
      entry.provider === provider ? { ...entry, enabled } : entry
    ))
    this.persist()
    return this.listAccountsByProvider(provider).length
  }

  /** 账号排序（池条目顺序）。 */
  async reorderAccounts(provider, orderedIds) {
    this.ensureLoaded()
    const mine = this.listAccountsByProvider(provider)
    const byId = new Map(mine.map((entry) => [entry.id, entry]))
    const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean)
    const rest = mine.filter((entry) => !orderedIds.includes(entry.id))
    const others = this.accounts.filter((entry) => entry.provider !== provider)
    this.accounts = [...others, ...reordered, ...rest]
    this.persist()
  }

  /** 清掉已过期的限流标记（定时清理；页面「重测」也会用到）。 */
  async sweepExpiredRateLimits() {
    this.ensureLoaded()
    const now = Date.now()
    let changed = false
    this.accounts = this.accounts.map((entry) => {
      const limits = entry.modelRateLimits
      if (limits === undefined) return entry
      const kept = Object.entries(limits).filter(([, at]) => typeof at === 'number' && at > now)
      if (kept.length === Object.keys(limits).length) return entry
      changed = true
      return { ...entry, modelRateLimits: Object.fromEntries(kept) }
    })
    if (changed) this.persist()
  }
}

/** 把凭据 ref 名打包成 `credentialRef` 需要的形状（品牌串）。 */
function accountRef(name) {
  return credentialRef(name)
}
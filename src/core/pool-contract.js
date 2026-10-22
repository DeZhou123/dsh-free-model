/**
 * 账号池契约（结构化子集）。
 *
 * ## 为什么是契约而不是实现
 *
 * 本插件要复用的是 **OFM（dsh-our-free-model）里已经存在的那一个账号池**：
 * v2.5.8 只是删掉了 buddy 通道的注册与入口，`channel-pack/state.json` 里那两个
 * provider 的历史账号、`.credentials.yaml` 里的凭据、余额排名规则全都还在。
 * 把 `AccountPool` 整类复制一份过来，会得到**第二个池**：两份 state.json 各写各的，
 * 用户在一个面板停用的账号在另一个面板仍然被选中 —— 那是最糟的失败形态。
 *
 * 所以这里只声明"我需要池的哪几个方法"，由宿主把真池注进来。ofm 的
 * `AccountPool` 天然满足本接口（方法名与语义逐条对齐，见各条注释）。
 *
 * ## 语义来源
 *
 * 每一条都对应 OFM `vendor/channel-pack/src/account-pool.ts` 的实现：
 * - `getAvailableAccount(provider, modelId, exclude)` —— 空 `modelId` 表示
 *   **不过滤限流**（实现里 `if (modelId.length === 0) return true`，故意短路的）。
 *   因此调用方必须把本次请求的模型透传进来，否则被标记限流的账号仍会被选中。
 * - `updateModelRateLimit(accountId, modelId, resetAtMs)` —— 按**模型**记，
 *   不是按账号。
 * - `disabledModelsFor(provider)` —— 黑名单制：只有值为 true 的模型被关闭。
 */

/** 池内账号条目（OFM `ProviderAccountEntry` 的最小可用子集）。 */
/** @typedef {{
 *   id: string,
 *   provider: string,
 *   nickname: string,
 *   enabled: boolean,
 *   credentialRef: string,
 *   createdAt: number,
 *   expiresAt?: number,
 *   refreshable?: boolean,
 *   modelRateLimits?: Record<string, number>,
 * }} PoolAccountEntry */

/** 选号结果。 */
/** @typedef {{ entry: PoolAccountEntry, credential: unknown }} AvailableAccount */

/**
 * 选出一个「该模型上未受限且已启用」的账号。
 *
 * @param {string} provider provider id（'buddy' | 'workbuddy'）
 * @param {string} modelId 本次请求的模型；传空串等于放弃限流过滤
 * @param {Set<string>} [exclude] 已试过、本次要排除的账号 id
 * @returns {Promise<AvailableAccount | null>}
 */
export async function getAvailableAccount(pool, provider, modelId, exclude) {
  if (pool === undefined || pool === null) return null
  return await pool.getAvailableAccount(provider, modelId, exclude) ?? null
}

/**
 * 模型目录是否可见（与 OFM 同一条判定）。
 *
 * 语义：`DSH_HIDE_MODELS_WITHOUT_ACCOUNT` 默认开启 —— 该 provider 没有任何
 * 已登录账号时，**返回空目录**让整个 provider 从模型选择器里消失
 * （`buildModelCatalog` 会 `.filter(g => g.models.length > 0)`）。
 *
 * ⚠️ 必须返回空数组而不是抛错：抛错会进 `failures`，界面上多出一条 provider 报错。
 *
 * @param {any} pool
 * @param {string} provider
 * @returns {Promise<boolean>}
 */
export async function providerCatalogVisible(pool, provider) {
  if (!resolveHideWithoutAccountFlag(process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT)) return true
  if (pool === undefined || pool === null) return true
  if (typeof pool.hasLoggedInAccount !== 'function') return true
  try {
    return await pool.hasLoggedInAccount(provider)
  } catch {
    return true
  }
}

/** 解析 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT`：**默认开启**，只有显式假值才关。 */
function resolveHideWithoutAccountFlag(raw) {
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}

/**
 * 全部**启用**账号都在该模型上受限时，返回最近一个解禁时刻。
 *
 * 用途：区分「真的没登录」与「被限流挡住」—— 后者若报成
 * `MISSING_CREDENTIAL`，用户会去重新登录，方向完全错。
 *
 * @param {readonly PoolAccountEntry[]} entries 只传已启用的账号
 * @param {string} modelId
 * @returns {number | undefined} 解禁时刻（毫秒）；无受限账号或未传模型时 undefined
 */
export function allAccountsRateLimitedForModel(entries, modelId) {
  if (modelId.length === 0) return undefined
  if (entries.length === 0) return undefined
  let latest
  let anyLimited = false
  const now = Date.now()
  for (const entry of entries) {
    const resetAt = entry.modelRateLimits?.[modelId]
    if (resetAt === undefined || resetAt === 0) return undefined
    if (now >= resetAt) return undefined
    anyLimited = true
    if (latest === undefined || resetAt > latest) latest = resetAt
  }
  return anyLimited ? latest : undefined
}

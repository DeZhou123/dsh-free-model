import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  credentialExpiresAtMs,
  isExpired,
  isRefreshable
} from "./buddy.js";
import {
  RefreshTokenExpiredError,
  fetchModels,
  refreshToken,
  runBuddyLoginFlow
} from "./buddy-oauth.js";
import { RefreshScheduler } from "./refresh.js";
import { CODEBUDDY } from "./product.js";
import {
  refreshAccountWithReconcile,
  syncAccountExpiry
} from "./expiry-sync.js";
const BUDDY_EXPIRY_ACCESSORS = {
  expiresAtOf: credentialExpiresAtMs,
  refreshableOf: isRefreshable,
  identityOf: (credential) => credential.access_token ?? ""
};
const BUDDY_CREDENTIAL_REF = "BUDDY_ACCESS_TOKEN";
const SERVICE_NAMES = { buddy: "buddyAuth", workbuddy: "workbuddyAuth" };
function parseCredential(value) {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && typeof parsed.access_token === "string" ? parsed : void 0;
  } catch {
    return void 0;
  }
}
class BuddyAuth {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.options = options;
    const product = options.product ?? CODEBUDDY;
    this.serviceName = options.serviceName ?? `${product.id}Auth`;
    this.product = product;
    this.credentialRefName = this.product.defaultCredentialRef;
  }
  /** 日志标识（原 cordis Service 名，仅用于日志文案）。 */
  serviceName;
  /** 本实例所属的产品配置（CodeBuddy 或 WorkBuddy）。 */
  product;
  /**
   * 本实例默认读写的凭据 ref 名称。
   * CodeBuddy 为 `BUDDY_ACCESS_TOKEN`，WorkBuddy 为 `WORKBUDDY_ACCESS_TOKEN`；
   * 两个产品各自读写自己的 ref，凭据互不可见。
   */
  credentialRefName;
  scheduler = new RefreshScheduler(
    () => this.refresh(),
    (error) => {
      if (error instanceof RefreshTokenExpiredError) {
        this.markRefreshTokenInvalid();
        return;
      }
      this.lastRefreshError = error instanceof Error ? error.message : String(error);
    }
  );
  /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
  refreshTokenInvalid = false;
  lastRefreshError;
  /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
  active = true;
  /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
  markRefreshTokenInvalid() {
    this.refreshTokenInvalid = true;
    this.lastRefreshError = "refresh_token \u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55";
  }
  /** 运行登录流程并持久化凭据。 */
  async login(flowOptions = {}) {
    this.active = true;
    const ref = flowOptions.refName ? credentialRef(flowOptions.refName) : credentialRef(this.credentialRefName);
    const flow = await runBuddyLoginFlow({
      ...this.options.fetcher !== void 0 ? { fetcher: this.options.fetcher } : {},
      ...flowOptions,
      // 产品配置决定 auth/state 的 platform 与登录 URL 附加参数：调用方显式传入优先，
      // 否则用本实例的产品（WorkBuddy 实例不会退回 CodeBuddy）。
      product: flowOptions.product ?? this.product
    });
    await this.ctx.credentials.set(ref, flow.access);
    this.refreshTokenInvalid = false;
    this.lastRefreshError = void 0;
    this.scheduleRefresh();
    const credential = parseCredential(flow.access);
    if (flowOptions.accountId && flowOptions.pool) {
      await flowOptions.pool.addAccount({
        id: flowOptions.accountId,
        provider: this.product.id,
        nickname: flowOptions.accountId,
        enabled: true,
        credentialRef: flowOptions.refName ?? this.credentialRefName,
        createdAt: Date.now(),
        expiresAt: credential ? credentialExpiresAtMs(credential) : void 0,
        refreshable: Boolean(credential) && isRefreshable(credential)
      });
    }
    return {
      access: flow.access,
      expires: flow.expires,
      ref,
      loginUrl: flow.loginUrl,
      refreshable: Boolean(credential) && isRefreshable(credential)
    };
  }
  /**
   * 保存凭据并注册到账号池（供后台登录流程使用）。
   * 账号池已预先创建占位条目时，只做凭据写入和更新。
   */
  async saveCredential(credentialJson, refName, accountId, pool) {
    this.active = true;
    const ref = credentialRef(refName);
    await this.ctx.credentials.set(ref, credentialJson);
    this.refreshTokenInvalid = false;
    this.lastRefreshError = void 0;
    this.scheduleRefresh();
    const credential = parseCredential(credentialJson);
    if (accountId && pool) {
      await pool.updateAccount(accountId, {
        nickname: credential?.nickname ?? accountId,
        expiresAt: credential ? credentialExpiresAtMs(credential) : void 0,
        refreshable: Boolean(credential) && isRefreshable(credential)
      });
    }
  }
  /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
  async status() {
    const ref = credentialRef(this.credentialRefName);
    const info = await this.ctx.credentials.describe(ref);
    if (!info.configured) return { configured: false, refreshable: false };
    let expiresAt;
    let refreshable = false;
    const resolved = await this.ctx.credentials.resolve(ref);
    if (resolved) {
      const credential = parseCredential(resolved.value);
      if (credential) {
        expiresAt = credentialExpiresAtMs(credential);
        refreshable = isRefreshable(credential) && !this.refreshTokenInvalid;
      }
    }
    return {
      configured: true,
      source: info.source,
      expiresAt,
      refreshable,
      ...this.lastRefreshError === void 0 ? {} : { refreshError: this.lastRefreshError }
    };
  }
  /** 静默续期：refresh_token 换取；无 refresh_token 时明确报错（由命令提示重新登录）。 */
  async refresh() {
    const ref = credentialRef(this.credentialRefName);
    const resolved = await this.ctx.credentials.resolve(ref);
    if (!resolved) throw new Error("\u672A\u914D\u7F6E\u51ED\u636E\uFF0C\u8BF7\u5148\u767B\u5F55");
    const credential = parseCredential(resolved.value);
    if (!credential) throw new Error("\u51ED\u636E\u89E3\u6790\u5931\u8D25");
    if (!isRefreshable(credential)) {
      throw new RefreshTokenExpiredError("\u65E0 refresh_token\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    try {
      const refreshed = await this.refreshCredential(credential);
      if (!this.active) return;
      await this.ctx.credentials.set(ref, JSON.stringify(refreshed));
      this.refreshTokenInvalid = false;
      this.lastRefreshError = void 0;
      this.scheduleRefresh();
    } catch (error) {
      if (error instanceof RefreshTokenExpiredError) this.markRefreshTokenInvalid();
      throw error;
    }
  }
  /**
   * 用给定凭据换新令牌并合并字段（不触碰存储、调度器与错误状态）。
   *
   * 抽出来供 {@link refresh} 与 {@link refreshAccountCredential} 共用，
   * 避免两处各写一遍「换 token → 合并字段」而逐渐分叉。
   */
  async refreshCredential(credential) {
    const token = await refreshToken(credential, this.fetchImpl, void 0, this.product);
    return {
      ...credential,
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_at: token.expiresAt,
      refresh_expires_at: token.refreshExpiresAt,
      token_type: token.tokenType,
      scope: token.scope,
      // 后端未返回 domain 时保留原值。
      ...token.domain.length > 0 ? { domain: token.domain } : {}
    };
  }
  /**
   * 按凭据 ref 续期**指定账号**的凭据。
   *
   * 与 {@link refresh} 的区别（这是修复既有缺陷的关键）：
   * - `refresh()` 读写的是本实例的**默认单凭据 ref**（如 `BUDDY_ACCESS_TOKEN`），
   *   而 Channel Pack 的账号卡片对应的是 `BUDDY_ACCOUNT_XXX` ——
   *   用 `refresh()` 去刷账号池里的账号，实际刷的是另一个凭据；
   * - 本方法也**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
   *   那些状态属于「单凭据路径」，被多账号操作污染会让 UI 显示错误的失效提示。
   *
   * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT）：UI 卡片读的是池值，
   * 只更新凭据会让「已过期」的红字在续期成功后依然挂着，用户无处自救。
   */
  async refreshAccountCredential(refName, pool, accountId) {
    const ref = credentialRef(refName);
    const resolved = await this.ctx.credentials.resolve(ref);
    if (!resolved) throw new Error("\u51ED\u636E\u672A\u914D\u7F6E");
    const credential = parseCredential(resolved.value);
    if (!credential) throw new Error("\u51ED\u636E\u89E3\u6790\u5931\u8D25");
    if (!isRefreshable(credential)) {
      throw new RefreshTokenExpiredError("\u65E0 refresh_token\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    const refreshed = await this.refreshCredential(credential);
    await this.ctx.credentials.set(ref, JSON.stringify(refreshed));
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential: refreshed,
      accessors: BUDDY_EXPIRY_ACCESSORS,
      accountId,
      tag: `[${this.product.id}]`,
      warn: (message) => this.ctx.logger?.warn?.(message)
    });
  }
  /**
   * 批量续期本产品的所有账号。
   *
   * **包含已停用账号**（只按 `refreshable` 过滤）。
   *
   * 为什么不能跳过停用账号（真实缺陷）：停用只应影响「账号池的自动选号」，
   * 不该让凭据烂掉。早期实现有 `if (!entry.enabled ...) continue`，于是停用
   * 一段时间后 refresh_token 过期，用户重新启用时拿到的是一个死凭据 ——
   * 表现为「账号显示凭证过期」且**无法自动恢复**，只能重新登录。
   * 更糟的是停用账号仍会出现在 Channel Pack 里并参与积分领取，于是点「一键领取」
   * 时用过期凭据打腾讯接口，服务端回 HTML 错误页 → 前端报
   * `Unexpected token '<'`。续期不该依赖「是否参与自动选号」。
   *
   * 单账号失败不影响其他账号，但失败**必须留日志**：静默的实现会让账号
   * 在 UI 上永远显示「可续期」却刷不动，用户与开发者都拿不到线索。
   *
   * ⚠️ **lead-time 过滤**（issue !IKIRTT）：距过期不足 1 小时才发续期请求，
   * 跳过的账号只做有效期对账。详见 `refreshAccountWithReconcile`。
   */
  async refreshAll(pool) {
    const accounts = await pool.listAccounts(this.product.id);
    for (const entry of accounts) {
      if (!entry.refreshable) continue;
      try {
        const ref = credentialRef(entry.credentialRef);
        const resolved = await this.ctx.credentials.resolve(ref);
        if (!resolved) {
          await pool.updateAccount(entry.id, { refreshable: false });
          continue;
        }
        const credential = parseCredential(resolved.value);
        if (!credential || !isRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false });
          continue;
        }
        await refreshAccountWithReconcile({
          pool,
          provider: this.product.id,
          tag: `[${this.product.id}]`,
          accountId: entry.id,
          credential,
          accessors: BUDDY_EXPIRY_ACCESSORS,
          current: entry,
          refresh: (c) => this.refreshCredential(c),
          save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
          warn: (message) => this.ctx.logger?.warn?.(message)
        });
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false });
          } catch {
          }
          this.ctx.logger?.warn?.(
            `[${this.product.id}] \u8D26\u53F7 ${entry.id} \u7684 refresh_token \u5DF2\u5931\u6548\uFF0C\u5DF2\u6807\u8BB0\u4E3A\u4E0D\u53EF\u7EED\u671F\uFF08\u9700\u91CD\u65B0\u767B\u5F55\uFF09`
          );
        } else {
          this.ctx.logger?.warn?.(
            `[${this.product.id}] \u8D26\u53F7 ${entry.id} \u7EED\u671F\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }
  /** 移除已存储的凭据并停止任何待处理的刷新。 */
  async logout() {
    this.active = false;
    this.scheduler.stop();
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName));
  }
  /** 停止刷新调度（不清理凭据）。 */
  stop() {
    this.active = false;
    this.scheduler.stop();
  }
  /** 启动时若已有可刷新凭据则安排续期（由 apply 调用）。 */
  scheduleRefresh() {
    void this.ctx.credentials.resolve(credentialRef(this.credentialRefName)).then((resolved) => {
      if (!resolved) return;
      const credential = parseCredential(resolved.value);
      if (!credential || !isRefreshable(credential)) return;
      const expiresAt = credentialExpiresAtMs(credential);
      if (expiresAt !== void 0) this.scheduler.arm(expiresAt);
    });
  }
  /** 从存储重载凭据，返回是否已过期（供 UI 判断是否需要提示重新登录）。 */
  async checkExpired() {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName));
    if (!resolved) return true;
    const credential = parseCredential(resolved.value);
    return credential === void 0 ? true : isExpired(credential);
  }
  /**
   * GET /v3/config → 获取远端模型列表（craft agent 的 models）。
   * 失败或未登录时返回空数组（调用方回退到内置列表）。
   *
   * 优先使用账号池中的可用账号；无账号池或池为空时回退到固定凭据 ref。
   *
   * **关键**：两处调用都必须把 `this.product` 传给 `fetchModels`，否则
   * WorkBuddy 实例（Task 7 的 `fetchRemoteModels: () => workbuddy.fetchModels(pool)`）
   * 会以 `X-Product-Code: codebuddy` + CodeBuddy 的 UA 请求 /v3/config，
   * 即携带另一个产品的身份标识。
   */
  async fetchModels(pool) {
    if (pool) {
      const available = await pool.getAvailableAccount(this.product.id, "");
      if (available) return fetchModels(available.credential, this.fetchImpl, void 0, this.product);
    }
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName));
    if (!resolved) return [];
    const credential = parseCredential(resolved.value);
    if (!credential) return [];
    return fetchModels(credential, this.fetchImpl, void 0, this.product);
  }
  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  get fetchImpl() {
    return this.options.fetcher ?? fetch;
  }
}
function createPoolRefresh(pool, productId, auth) {
  return async () => {
    const available = await pool.getAvailableAccount(productId, "");
    if (available) {
      await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id);
    } else {
      await auth.refresh();
    }
  };
}
export {
  BUDDY_CREDENTIAL_REF,
  BuddyAuth,
  SERVICE_NAMES,
  createPoolRefresh
};

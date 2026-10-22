import { fetchCreditBalance } from "./credits.js";
import {
  buddyExpiringWindowDays,
  buddyBalanceTier,
  buddyTierUsable,
  rankBuddyAccountsByBalance,
  splitBuddyCreditsByExpiry
} from "./buddy-balance-rank.js";
const BUDDY_BALANCE_CACHE_TTL_MS = 6e4;
const BUDDY_BALANCE_ERROR_CACHE_TTL_MS = 5e3;
class BuddyBalanceSelector {
  constructor(deps) {
    this.deps = deps;
  }
  cache = /* @__PURE__ */ new Map();
  /** 清空缓存（凭据变化、手动刷新余额、领取积分后调用）。 */
  invalidate(accountId) {
    if (accountId === void 0) this.cache.clear();
    else this.cache.delete(accountId);
  }
  /**
   * 当前生效的「临时积分」窗口（毫秒）。
   *
   * ⚠️ **每次调用都重新解析环境变量**，不能缓存：窗口可被用户随时改，
   * 而提示文案与选号判据必须取同一个值 —— 缓存会让两者在不同时刻分裂。
   */
  windowMs() {
    return this.deps.windowMs ?? buddyExpiringWindowDays() * 24 * 60 * 60 * 1e3;
  }
  /**
   * 查一个账号的余额分类（**缓存原料、每次现算**）。
   *
   * ⚠️ TTL 只用于抑制**网络请求**，绝不能拿来冻结分类：「临时 / 永久」是
   * **当前时刻的函数** —— 一笔距到期 15.2 天的余额，什么都没人操作，
   * 过 30 分钟就成了临时积分。所以这里缓存的是 `get-user-resource` 的原始
   * `CreditBalance`，命中缓存也重新分桶（并重新读一次窗口 env）。
   * 宿主是长期开着的，时间只会向前流动。
   *
   * ⚠️ **查询失败不抛错**：返回 `ok: false` 的条目，由分档逻辑归入最后一档 ——
   * 让「一个号查不到」不至于让整个选号失败（凭据过期是最常见的失败原因，
   * 此时应继续用别的号，而不是把错误抛给用户）。
   *
   * ⚠️ **失败结果的 TTL 短一个数量级**（与 Loomy 那份同一修复，见
   * `BUDDY_BALANCE_ERROR_CACHE_TTL_MS`）：把一次抖动缓存满 60 秒，会让
   * 「查不到」伪装成「额度用尽」整整一分钟。
   */
  async balanceOf(account) {
    const now = this.deps.now?.() ?? Date.now();
    const cached = this.cache.get(account.id);
    if (cached !== void 0) {
      const ttl = cached.source.ok ? this.deps.ttlMs ?? BUDDY_BALANCE_CACHE_TTL_MS : this.deps.errorTtlMs ?? BUDDY_BALANCE_ERROR_CACHE_TTL_MS;
      if (now - cached.at < ttl) {
        return this.classify(account.id, cached.source, now);
      }
    }
    const source = await this.fetchSource(account);
    this.cache.set(account.id, { at: now, source });
    return this.classify(account.id, source, now);
  }
  /**
   * 把原料按**当前时刻**分成两桶并定档。
   *
   * 单独成函数就是为了「原料只查一次、分类随时间重算」这件事结构上无法被绕过。
   */
  classify(id, source, now) {
    if (source.ok !== true) return failedEntry(id, source.error);
    const windowMs = this.windowMs();
    const split = splitBuddyCreditsByExpiry(source.balance, now, windowMs);
    if (split === void 0) return failedEntry(id, "\u4F59\u989D\u54CD\u5E94\u65E0\u6CD5\u89E3\u6790\u51FA\u79EF\u5206\u6C60");
    const entry = {
      id,
      ok: true,
      expiringBalance: split.expiring,
      permanentBalance: split.permanent,
      split
    };
    entry.tier = buddyBalanceTier(entry, { now, windowMs });
    return entry;
  }
  /** 发一次请求取原料（不做任何分类）。 */
  async fetchSource(account) {
    let credential;
    try {
      credential = await this.deps.resolveCredential(account.credentialRef);
    } catch (error) {
      return { ok: false, error: `\u8BFB\u53D6\u51ED\u636E\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}` };
    }
    if (credential === void 0) {
      return { ok: false, error: "\u51ED\u636E\u672A\u914D\u7F6E\u6216\u5DF2\u5931\u6548" };
    }
    let balance;
    try {
      balance = await (this.deps.fetchBalance ?? ((cred, product) => fetchCreditBalance(cred, product, this.deps.fetcher ?? fetch)))(
        credential,
        this.deps.product
      );
    } catch (error) {
      return { ok: false, error: `\u4F59\u989D\u67E5\u8BE2\u5F02\u5E38\uFF1A${error instanceof Error ? error.message : String(error)}` };
    }
    if (balance === null) {
      return { ok: false, error: "\u4F59\u989D\u67E5\u8BE2\u5931\u8D25\uFF08\u51ED\u636E\u5931\u6548\u6216\u54CD\u5E94\u5F02\u5E38\uFF09" };
    }
    return { ok: true, balance };
  }
  /**
   * 从候选账号中按「快到期优先」选一个。
   *
   * 排序规则见 `rankBuddyAccountsByBalance`：
   * 有快到期积分 → 只剩永久 → 无余额/查不到。**档内保持传入顺序**（= 手动顺序）。
   *
   * ⚠️ **锁定永久积分时（`allowPermanent: false`）**：只剩永久积分的账号落入
   * `none` 档（不可用）。若**全部候选都不可用**，返回 `ok: false` 并带上原因 ——
   * 调用方据此报明确错误，而不是硬着头皮消耗永久积分。
   *
   * ⚠️ **解锁时不改变既有行为**：所有候选余额都是 0 仍返回第一个候选，
   * 让上游去报真正的失败原因（凭据、限流、余额），错误信息更准确。
   *
   * @param candidates - 已按 `enabled` 与模型限流过滤过的候选（顺序即手动优先级）。
   * @param options - `allowPermanent` 为 false 时禁止消耗永久积分。
   */
  async select(candidates, options = {}) {
    if (candidates.length === 0) {
      return { ok: false, reason: { kind: "exhausted" } };
    }
    const balances = await Promise.all(candidates.map((c) => this.balanceOf(c)));
    const byId = new Map(candidates.map((c, i) => [c.id, { account: c, balance: balances[i] }]));
    const ranked = rankBuddyAccountsByBalance(balances, options);
    const first = ranked[0];
    if (first === void 0) {
      return { ok: false, reason: noAccountReason(balances) };
    }
    if (options.allowPermanent === false && !buddyTierUsable(buddyBalanceTier(first, options))) {
      return { ok: false, reason: noAccountReason(balances) };
    }
    const picked = byId.get(first.id);
    if (picked === void 0) return { ok: false, reason: { kind: "exhausted" } };
    return { ok: true, account: picked.account, balance: picked.balance };
  }
}
function noAccountReason(balances) {
  const errors = balances.filter((b) => !b.ok).map((b) => b.error ?? "\u672A\u77E5\u539F\u56E0");
  return errors.length > 0 ? { kind: "unknown", errors } : { kind: "exhausted" };
}
function failedEntry(id, error) {
  return { id, ok: false, error };
}
async function pickBuddyAccount(selector, candidates, options) {
  const tried = /* @__PURE__ */ new Set();
  const allowPermanent = options.allowPermanent !== false;
  let reason;
  for (let remaining = candidates; remaining.length > 0; ) {
    const picked = await selector.select(
      remaining,
      { ...options.tierOptions, allowPermanent }
    );
    if (!picked.ok) {
      reason = picked.reason;
      break;
    }
    const credential = await options.resolveCredential(picked.account.credentialRef);
    if (credential !== void 0) {
      return { kind: "account", account: picked.account, balance: picked.balance, credential, tried };
    }
    tried.add(picked.account.id);
    remaining = remaining.filter((c) => c.id !== picked.account.id);
  }
  return { kind: allowPermanent ? "exhausted" : "locked", tried, ...reason ? { reason } : {} };
}
export {
  BUDDY_BALANCE_CACHE_TTL_MS,
  BUDDY_BALANCE_ERROR_CACHE_TTL_MS,
  BuddyBalanceSelector,
  pickBuddyAccount
};

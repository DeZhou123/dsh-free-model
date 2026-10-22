const BUDDY_EXPIRING_WINDOW_DAYS = 15;
const BUDDY_EXPIRING_WINDOW_MS = BUDDY_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1e3;
const DSH_BUDDY_EXPIRING_WINDOW_DAYS = "DSH_BUDDY_EXPIRING_WINDOW_DAYS";
function buddyExpiringWindowDays(env = process.env) {
  const raw = env[DSH_BUDDY_EXPIRING_WINDOW_DAYS];
  if (typeof raw !== "string" || raw.trim().length === 0) return BUDDY_EXPIRING_WINDOW_DAYS;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return BUDDY_EXPIRING_WINDOW_DAYS;
  return parsed;
}
function buddyExpiringWindowMs(env = process.env) {
  return buddyExpiringWindowDays(env) * 24 * 60 * 60 * 1e3;
}
const BUDDY_BALANCE_TIER = Object.freeze({
  /** 有 15 天内到期的积分 —— 优先消耗（再不用就作废）。 */
  expiring: 0,
  /** 只剩永久积分（≥ 15 天后到期）。 */
  permanent: 1,
  /** 无余额 / 查询失败。 */
  none: 2
});
function splitBuddyCreditsByExpiry(balance, now = Date.now(), windowMs = BUDDY_EXPIRING_WINDOW_MS) {
  if (balance === null || balance === void 0) return void 0;
  let expiring = 0;
  let permanent = 0;
  for (const pkg of balance.packages) {
    if (pkg.active !== true) continue;
    const remaining = positiveOrZero(pkg.remaining);
    if (remaining <= 0) continue;
    const endTime = pkg.deductionEndTime;
    const known = typeof endTime === "number" && Number.isFinite(endTime) && endTime > 0;
    if (known && endTime - now < windowMs) expiring += remaining;
    else permanent += remaining;
  }
  return { expiring, permanent };
}
function buddyBalanceTier(balance, options = {}) {
  if (positiveOrZero(balance.expiringBalance) > 0) return BUDDY_BALANCE_TIER.expiring;
  if (options.allowPermanent === false) return BUDDY_BALANCE_TIER.none;
  if (positiveOrZero(balance.permanentBalance) > 0) return BUDDY_BALANCE_TIER.permanent;
  return BUDDY_BALANCE_TIER.none;
}
function buddyTierUsable(tier) {
  return tier !== BUDDY_BALANCE_TIER.none;
}
function positiveOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function rankBuddyAccountsByBalance(accounts, options = {}) {
  return accounts.map((account, index) => ({ account, index, tier: buddyBalanceTier(account, options) })).sort((a, b) => a.tier - b.tier || a.index - b.index).map((entry) => entry.account);
}
function describeBuddyCreditSplit(split, windowDays = BUDDY_EXPIRING_WINDOW_DAYS) {
  if (split === void 0) return "\u4F59\u989D\u67E5\u8BE2\u5931\u8D25";
  const expiring = roundCreditsInline(split.expiring);
  const permanent = roundCreditsInline(split.permanent);
  if (expiring <= 0 && permanent <= 0) return "\u65E0\u53EF\u7528\u79EF\u5206";
  return `${windowDays} \u5929\u5185\u5230\u671F ${expiring} \xB7 \u6C38\u4E45 ${permanent}`;
}
function roundCreditsInline(value) {
  return Math.round(value * 100) / 100;
}
export {
  BUDDY_BALANCE_TIER,
  BUDDY_EXPIRING_WINDOW_DAYS,
  BUDDY_EXPIRING_WINDOW_MS,
  DSH_BUDDY_EXPIRING_WINDOW_DAYS,
  buddyBalanceTier,
  buddyExpiringWindowDays,
  buddyExpiringWindowMs,
  buddyTierUsable,
  describeBuddyCreditSplit,
  rankBuddyAccountsByBalance,
  splitBuddyCreditsByExpiry
};

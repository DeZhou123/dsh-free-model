import { REFRESH_LEAD_MS } from "./refresh.js";
const EXPIRY_TOLERANCE_MS = 1e3;
function shouldRefreshNow(expiresAtMs, nowMs = Date.now()) {
  if (expiresAtMs === void 0 || !Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - nowMs <= REFRESH_LEAD_MS;
}
async function syncAccountExpiry(params) {
  const { pool, provider, credential, accessors, accountId, current, tag } = params;
  if (pool === void 0) return;
  try {
    let id = accountId;
    if (id === void 0 || id.length === 0) {
      id = await pool.findAccountIdByCredential(provider, accessors.identityOf(credential));
    }
    if (id === void 0 || id.length === 0) return;
    const expiresAt = accessors.expiresAtOf(credential);
    const refreshable = accessors.refreshableOf?.(credential);
    if (expiresAt === void 0 && refreshable === void 0) return;
    const expiryChanged = expiresAt !== void 0 && (current?.expiresAt === void 0 || Math.abs(current.expiresAt - expiresAt) > EXPIRY_TOLERANCE_MS);
    const refreshableChanged = refreshable !== void 0 && (current === void 0 || current.refreshable !== refreshable);
    if (!expiryChanged && !refreshableChanged) return;
    await pool.updateAccount(id, {
      ...expiresAt === void 0 ? {} : { expiresAt },
      ...refreshable === void 0 ? {} : { refreshable }
    });
  } catch (error) {
    params.warn?.(
      `${tag} \u51ED\u636E\u5904\u7406\u6210\u529F\u4F46\u56DE\u5199\u8D26\u53F7\u6C60\u7684\u6709\u6548\u671F\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u4F7F\u7528\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`
    );
  }
}
async function refreshAccountWithReconcile(params) {
  const { pool, provider, tag, accountId, credential, accessors, current, refresh, save } = params;
  const expiresAt = accessors.expiresAtOf(credential);
  if (!shouldRefreshNow(expiresAt)) {
    await syncAccountExpiry({
      pool,
      provider,
      credential,
      accessors,
      accountId,
      current,
      tag,
      warn: params.warn
    });
    return false;
  }
  const refreshed = await refresh(credential);
  if (refreshed === void 0) {
    throw new Error(`${tag} \u7EED\u671F\u54CD\u5E94\u7F3A\u5C11\u8BBF\u95EE\u4EE4\u724C\uFF0C\u51ED\u636E\u672A\u66F4\u65B0`);
  }
  await save(refreshed);
  await syncAccountExpiry({
    pool,
    provider,
    credential: refreshed,
    accessors,
    accountId,
    current,
    tag,
    warn: params.warn
  });
  params.info?.(`${tag} \u8D26\u53F7 ${accountId} \u5DF2\u7EED\u671F`);
  return true;
}
export {
  refreshAccountWithReconcile,
  shouldRefreshNow,
  syncAccountExpiry
};

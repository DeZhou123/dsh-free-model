import {
  AUTH_REFRESH_SOURCE,
  AUTH_REFRESH_PATH,
  AUTH_STATE_PATH,
  AUTH_TOKEN_PATH,
  BUDDY_DEPLOYMENT_TYPE,
  CODE_ACCOUNT_NOT_READY,
  CODE_TOKEN_NOT_READY,
  CONFIG_PATH,
  HTTP_HEADER_AUTH_REFRESH_SOURCE,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_NO_AUTHORIZATION,
  HTTP_HEADER_NO_DEPARTMENT_INFO,
  HTTP_HEADER_NO_ENTERPRISE_ID,
  HTTP_HEADER_NO_USER_ID,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE,
  HTTP_HEADER_REFRESH_TOKEN,
  LOGIN_ACCOUNT_PATH,
  LOGIN_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  STATE_REQUEST_TIMEOUT_MS,
  buildCredential,
  credentialAuthHeaders,
  credentialExpiresAtMs,
  credentialRequestHeaders,
  isRefreshable,
  parseAccountData,
  parseModelsFromConfig,
  parsePromotions,
  parseTokenData
} from "./buddy.js";
import { CODEBUDDY } from "./product.js";
function responseCode(body) {
  if (typeof body !== "object" || body === null) return 0;
  const code = body.code;
  return typeof code === "number" ? code : 0;
}
function responseMessage(body) {
  if (typeof body !== "object" || body === null) return "";
  const message = body.message;
  return typeof message === "string" ? message : "";
}
function responseData(body) {
  if (typeof body !== "object" || body === null) return void 0;
  const data = body.data;
  return data === null ? void 0 : data;
}
async function request(method, url, headers, options) {
  const signal = options.signal === void 0 ? AbortSignal.timeout(options.timeoutMs) : AbortSignal.any([AbortSignal.timeout(options.timeoutMs), options.signal]);
  let response;
  try {
    response = await options.fetcher(url, { method, headers, signal });
  } catch (error) {
    throw new Error(`CodeBuddy ${method} ${url} network error: ${String(error)}`);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}
async function fetchAuthState(fetcher = fetch, signal, product = CODEBUDDY) {
  const url = `${product.endpoint}${AUTH_STATE_PATH}?platform=${product.platform}`;
  const headers = {
    [HTTP_HEADER_DOMAIN]: product.apiDomain,
    [HTTP_HEADER_NO_AUTHORIZATION]: "true",
    [HTTP_HEADER_NO_USER_ID]: "true",
    [HTTP_HEADER_NO_ENTERPRISE_ID]: "true",
    [HTTP_HEADER_NO_DEPARTMENT_INFO]: "true",
    "User-Agent": product.userAgent
  };
  const { status, body } = await request("POST", url, headers, {
    fetcher,
    timeoutMs: STATE_REQUEST_TIMEOUT_MS,
    ...signal !== void 0 ? { signal } : {}
  });
  if (status !== 200) {
    throw new Error(`auth/state HTTP ${status}: ${responseMessage(body)}`);
  }
  const data = responseData(body);
  if (typeof data !== "object" || data === null) {
    throw new Error(`auth/state \u54CD\u5E94\u7F3A\u5C11 data \u5B57\u6BB5: ${JSON.stringify(body)}`);
  }
  const record = data;
  const state = typeof record.state === "string" ? record.state : "";
  const authUrl = typeof record.authUrl === "string" ? record.authUrl : "";
  if (state.length === 0) throw new Error("auth/state \u54CD\u5E94\u7F3A\u5C11 state \u5B57\u6BB5");
  if (authUrl.length === 0) throw new Error("auth/state \u54CD\u5E94\u7F3A\u5C11 authUrl \u5B57\u6BB5");
  return { state, authUrl };
}
async function loopGetToken(state, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const product = options.product ?? CODEBUDDY;
  const url = `${product.endpoint}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`;
  const headers = {
    [HTTP_HEADER_NO_AUTHORIZATION]: "true",
    "User-Agent": product.userAgent
  };
  const deadline = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  for (; ; ) {
    if (Date.now() >= deadline) throw new Error("\u83B7\u53D6 token \u8D85\u65F6\uFF085 \u5206\u949F\uFF09");
    if (options.signal?.aborted) throw new Error("\u767B\u5F55\u5DF2\u53D6\u6D88");
    await sleep(interval);
    let result;
    try {
      result = await request("GET", url, headers, {
        fetcher,
        timeoutMs: REQUEST_TIMEOUT_MS,
        ...options.signal !== void 0 ? { signal: options.signal } : {}
      });
    } catch {
      continue;
    }
    const { status, body } = result;
    if (status === 200) {
      const data = responseData(body);
      if (data !== void 0) return parseTokenData(data);
      continue;
    }
    const code = responseCode(body);
    if (code === CODE_TOKEN_NOT_READY) continue;
    throw new Error(`auth/token HTTP ${status} code=${code}: ${responseMessage(body)}`);
  }
}
async function getAccount(state, token, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const product = options.product ?? CODEBUDDY;
  const url = `${product.endpoint}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`;
  const headers = {
    // ⚠️ `||` 而非裸 `token.domain`：token 由 `parseTokenData` → `readStringField`
    // 产出，该函数在字段缺失/类型不符时返回**空串**（不是 `undefined`），裸用会
    // 让 X-Domain 以空值发出。这与 `buddy-adapter.ts` 的 chat 头、`buddy.ts` 的
    // `credentialRequestHeaders` 是同一形态（PR!19 修了那两处，这是第三处）。
    //
    // 兜底取 `product.apiDomain` 而非常量 `API_DOMAIN`：本请求的 URL 是
    // `` `${product.endpoint}${LOGIN_ACCOUNT_PATH}` ``，X-Domain 必须与产品端点一致。
    //
    // ⚠️ **非空时仍以服务端下发的 `token.domain` 为准**（故不写成产品优先）：
    // 这里是登录流程，该值是服务端**本次刚下发**的权威值，不是跨产品迁移后
    // 会过期的历史快照 —— 与 adapter 那处的方向差异是有意的，差异只在「兜底值
    // 取谁」，判据一致（空串必回退）。回归用例见 `tests/unit/buddy-oauth.spec.ts`
    // 的「token.domain 为空串时…」与「token.domain 非空时…」两条。
    [HTTP_HEADER_DOMAIN]: token.domain || product.apiDomain,
    Authorization: `Bearer ${token.accessToken}`,
    [HTTP_HEADER_NO_USER_ID]: "true",
    [HTTP_HEADER_NO_ENTERPRISE_ID]: "true",
    "User-Agent": (options.product ?? CODEBUDDY).userAgent
  };
  const deadline = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  for (; ; ) {
    if (Date.now() >= deadline) throw new Error("\u83B7\u53D6\u8D26\u6237\u4FE1\u606F\u8D85\u65F6\uFF085 \u5206\u949F\uFF09");
    if (options.signal?.aborted) throw new Error("\u767B\u5F55\u5DF2\u53D6\u6D88");
    await sleep(interval);
    let result;
    try {
      result = await request("GET", url, headers, {
        fetcher,
        timeoutMs: REQUEST_TIMEOUT_MS,
        ...options.signal !== void 0 ? { signal: options.signal } : {}
      });
    } catch {
      continue;
    }
    const { status, body } = result;
    if (status === 200) {
      const data = responseData(body);
      if (data !== void 0) return parseAccountData(data);
      continue;
    }
    const code = responseCode(body);
    if (code === CODE_ACCOUNT_NOT_READY) continue;
    throw new Error(`login/account HTTP ${status} code=${code}: ${responseMessage(body)}`);
  }
}
async function refreshToken(credential, fetcher = fetch, signal, product = CODEBUDDY) {
  if (!isRefreshable(credential)) {
    throw new RefreshTokenExpiredError("\u65E0 refresh_token\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
  }
  const url = `${product.endpoint}${AUTH_REFRESH_PATH}`;
  const headers = {
    ...credentialRequestHeaders(credential),
    // credentialRequestHeaders 走的是 CodeBuddy 的 UA/域名常量，这里按产品覆盖，
    // 否则 WorkBuddy 续期时会以 CodeBuddy 的身份标识发请求。
    [HTTP_HEADER_DOMAIN]: product.apiDomain,
    "User-Agent": product.userAgent,
    Authorization: `Bearer ${credential.access_token}`,
    [HTTP_HEADER_REFRESH_TOKEN]: credential.refresh_token,
    [HTTP_HEADER_AUTH_REFRESH_SOURCE]: AUTH_REFRESH_SOURCE
  };
  const { status, body } = await request("POST", url, headers, {
    fetcher,
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...signal !== void 0 ? { signal } : {}
  });
  if (status !== 200) {
    const code = responseCode(body);
    const message = responseMessage(body);
    const expired = status === 401 || status === 403 || code === 401 || code === 403 || message.includes("expired") || message.includes("invalid");
    if (expired) {
      throw new RefreshTokenExpiredError(message.length > 0 ? message : `HTTP ${status}`);
    }
    throw new Error(`\u5237\u65B0 token HTTP ${status} code=${code}: ${message}`);
  }
  const data = responseData(body);
  if (data === void 0) throw new Error("\u5237\u65B0 token \u54CD\u5E94\u7F3A\u5C11 data \u5B57\u6BB5");
  return parseTokenData(data);
}
class RefreshTokenExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "RefreshTokenExpiredError";
  }
}
async function fetchModels(credential, fetcher = fetch, signal, product = CODEBUDDY) {
  if (credential.access_token.length === 0) return [];
  const headers = {
    ...credentialAuthHeaders(credential),
    // credentialAuthHeaders 内置 CodeBuddy 的 UA/域名，这里按产品覆盖。
    [HTTP_HEADER_DOMAIN]: product.apiDomain,
    "User-Agent": product.userAgent,
    // X-Product 是**部署类型**（SaaS），CodeBuddy 与 WorkBuddy 共用同一取值，
    // 故保持常量；随产品变化的是 X-Product-Code。
    [HTTP_HEADER_PRODUCT]: BUDDY_DEPLOYMENT_TYPE,
    [HTTP_HEADER_PRODUCT_CODE]: product.productCode
  };
  const scoped = await requestScopedModels(credential, headers, fetcher, signal, product);
  if (scoped !== void 0) {
    const config = await requestConfig(headers, fetcher, signal, product);
    const merged = mergeRemoteModels(scoped, config.models);
    return config.promotions.size === 0 ? merged : applyPromotions(merged, config.promotions);
  }
  const url = `${product.endpoint}${CONFIG_PATH}`;
  try {
    const { status, body } = await request("GET", url, headers, {
      fetcher,
      timeoutMs: REQUEST_TIMEOUT_MS,
      ...signal !== void 0 ? { signal } : {}
    });
    if (status !== 200) return [];
    return parseModelsFromConfig(body);
  } catch {
    return [];
  }
}
function mergeRemoteModels(primary, extra) {
  const known = new Set(primary.map((model) => model.id));
  return [...primary, ...extra.filter((model) => !known.has(model.id))];
}
async function requestConfig(headers, fetcher, signal, product) {
  const empty = { models: [], promotions: /* @__PURE__ */ new Map() };
  try {
    const { status, body } = await request("GET", `${product.endpoint}${CONFIG_PATH}`, headers, {
      fetcher,
      timeoutMs: REQUEST_TIMEOUT_MS,
      ...signal !== void 0 ? { signal } : {}
    });
    if (status !== 200 || typeof body !== "object" || body === null) return empty;
    const data = body.data;
    if (typeof data !== "object" || data === null) return empty;
    return {
      models: parseModelsFromConfig(body),
      promotions: parsePromotions(data)
    };
  } catch {
    return empty;
  }
}
function applyPromotions(models, promotions) {
  return models.map((model) => {
    const discounted = promotions.get(model.id);
    return discounted === void 0 ? model : { ...model, discountedCreditsRate: discounted };
  });
}
const ENTERPRISE_MODELS_SCOPE = "personal";
async function requestScopedModels(credential, headers, fetcher, signal, product) {
  const url = `${product.endpoint}/console/enterprises/${ENTERPRISE_MODELS_SCOPE}/models`;
  try {
    const { status, body } = await request("GET", url, headers, {
      fetcher,
      timeoutMs: REQUEST_TIMEOUT_MS,
      ...signal !== void 0 ? { signal } : {}
    });
    if (status !== 200) return void 0;
    const models = parseModelsFromConfig(body);
    return models.length > 0 ? models : void 0;
  } catch {
    return void 0;
  }
}
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
async function defaultOpenBrowser(url) {
  const { openBrowser } = await import("./login.js");
  openBrowser(url);
}
function decorateLoginUrl(authUrl, product) {
  if (!product.appendSessionParams) return authUrl;
  try {
    const url = new URL(authUrl);
    if (product.pluginVersion !== void 0 && product.pluginVersion.length > 0) {
      url.searchParams.set("version", product.pluginVersion);
    }
    url.searchParams.set("loginSessionId", crypto.randomUUID());
    return url.toString();
  } catch {
    return authUrl;
  }
}
async function runBuddyLoginFlow(options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const open = options.openBrowser ?? defaultOpenBrowser;
  const product = options.product ?? CODEBUDDY;
  let state;
  let authUrl;
  if (options.state) {
    state = options.state;
    authUrl = "";
  } else {
    const result = await fetchAuthState(fetcher, void 0, product);
    state = result.state;
    authUrl = result.authUrl;
    const decorated = decorateLoginUrl(authUrl, product);
    await open(decorated);
    authUrl = decorated;
  }
  const pollOptions = {
    fetcher,
    ...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
    ...options.pollIntervalMs !== void 0 ? { pollIntervalMs: options.pollIntervalMs } : {},
    // 轮询 token / 账户两步同样带产品身份标识，否则 WorkBuddy 登录会以
    // CodeBuddy 的 UA 发请求。
    product
  };
  const token = await loopGetToken(state, pollOptions);
  const account = await getAccount(state, token, pollOptions);
  const credential = buildCredential(token, account);
  return {
    access: JSON.stringify(credential),
    // 对齐 Rust 的 expires_at_ms(...).unwrap_or(0)：无法解析时报告 0。
    expires: credentialExpiresAtMs(credential) ?? 0,
    loginUrl: authUrl,
    refreshable: isRefreshable(credential)
  };
}
export {
  ENTERPRISE_MODELS_SCOPE,
  RefreshTokenExpiredError,
  decorateLoginUrl,
  fetchAuthState,
  fetchModels,
  getAccount,
  loopGetToken,
  refreshToken,
  runBuddyLoginFlow
};

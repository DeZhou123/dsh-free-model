const API_ENDPOINT = "https://copilot.tencent.com";
const PREFIX_PATH = "/plugin";
const PLATFORM = "ide";
const WEBSITE_HOME = "https://www.codebuddy.cn";
const AUTH_STATE_PATH = "/v2/plugin/auth/state";
const AUTH_TOKEN_PATH = "/v2/plugin/auth/token";
const LOGIN_ACCOUNT_PATH = "/v2/plugin/login/account";
const AUTH_REFRESH_PATH = "/v2/plugin/auth/token/refresh";
const ACCOUNTS_PATH = "/v2/plugin/accounts";
const CONFIG_PATH = "/v3/config";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1e3;
const POLL_INTERVAL_MS = 1e3;
const STATE_REQUEST_TIMEOUT_MS = 1e4;
const REQUEST_TIMEOUT_MS = 6e4;
const CODE_TOKEN_NOT_READY = 11217;
const CODE_ACCOUNT_NOT_READY = 12151;
const HTTP_HEADER_DOMAIN = "X-Domain";
const HTTP_HEADER_ENTERPRISE_ID = "X-Enterprise-Id";
const HTTP_HEADER_TENANT_ID = "X-Tenant-Id";
const HTTP_HEADER_NO_AUTHORIZATION = "X-No-Authorization";
const HTTP_HEADER_NO_USER_ID = "X-No-User-Id";
const HTTP_HEADER_NO_ENTERPRISE_ID = "X-No-Enterprise-Id";
const HTTP_HEADER_NO_DEPARTMENT_INFO = "X-No-Department-Info";
const HTTP_HEADER_REFRESH_TOKEN = "X-Refresh-Token";
const HTTP_HEADER_AUTH_REFRESH_SOURCE = "X-Auth-Refresh-Source";
const HTTP_HEADER_PRODUCT = "X-Product";
const HTTP_HEADER_PRODUCT_CODE = "X-Product-Code";
const BUDDY_USER_AGENT = "CodeBuddyIDE/1.106.1";
const BUDDY_PRODUCT_CODE = "codebuddy";
const BUDDY_DEPLOYMENT_TYPE = "SaaS";
const AUTH_REFRESH_SOURCE = "ide-main";
const API_DOMAIN = "copilot.tencent.com";
function credentialExpiresAtMs(credential) {
  const raw = credential.expires_at;
  if (typeof raw === "string" && raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      return value > 1e12 ? value : value * 1e3;
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return jwtExpiresAtMs(credential.access_token);
}
function jwtExpiresAtMs(token) {
  if (typeof token !== "string" || token.length === 0) return void 0;
  const parts = token.split(".");
  if (parts.length < 2) return void 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1e3 : void 0;
  } catch {
    return void 0;
  }
}
function jwtNickname(token) {
  if (typeof token !== "string" || token.length === 0) return "";
  const parts = token.split(".");
  if (parts.length < 2) return "";
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const nickname = payload.nickname ?? payload.preferred_username ?? payload.name;
    return typeof nickname === "string" ? stripControlChars(nickname) : "";
  } catch {
    return "";
  }
}
function isExpired(credential) {
  const expiresAt = credentialExpiresAtMs(credential);
  return expiresAt === void 0 ? false : Date.now() >= expiresAt;
}
function isRefreshable(credential) {
  return credential.refresh_token.length > 0;
}
function credentialRequestHeaders(credential) {
  const headers = {
    [HTTP_HEADER_DOMAIN]: credential.domain || API_DOMAIN,
    "User-Agent": BUDDY_USER_AGENT
  };
  if (credential.enterprise_id !== void 0 && credential.enterprise_id.length > 0) {
    headers[HTTP_HEADER_ENTERPRISE_ID] = credential.enterprise_id;
    headers[HTTP_HEADER_TENANT_ID] = credential.enterprise_id;
  }
  return headers;
}
function credentialAuthHeaders(credential) {
  return {
    ...credentialRequestHeaders(credential),
    Authorization: `Bearer ${credential.access_token}`
  };
}
function readStringField(data, key) {
  const value = data[key];
  if (typeof value === "string") return stripControlChars(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
function stripControlChars(value) {
  return value.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s{2,}/g, " ").trim();
}
function readNumberField(data, key) {
  const value = data[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return void 0;
}
function absoluteExpiryMs(record, absoluteKey, relativeKey, accessToken) {
  const absolute = readStringField(record, absoluteKey);
  if (absolute.length > 0) {
    const asNumber = /^\d+$/.test(absolute) ? Number(absolute) : Date.parse(absolute);
    if (Number.isFinite(asNumber)) {
      const ms = asNumber > 1e12 ? asNumber : asNumber * 1e3;
      return String(ms);
    }
    return absolute;
  }
  const relativeSeconds = readNumberField(record, relativeKey);
  if (relativeSeconds === void 0) {
    return absoluteKey === "expiresAt" ? "" : "";
  }
  const baseMs = jwtIssuedAtMs(accessToken) ?? Date.now();
  return String(baseMs + relativeSeconds * 1e3);
}
function jwtIssuedAtMs(token) {
  if (typeof token !== "string" || token.length === 0) return void 0;
  const parts = token.split(".");
  if (parts.length < 2) return void 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.iat === "number" && Number.isFinite(payload.iat) ? payload.iat * 1e3 : void 0;
  } catch {
    return void 0;
  }
}
function parseTokenData(data) {
  const record = typeof data === "object" && data !== null ? data : {};
  const tokenType = readStringField(record, "tokenType");
  const accessToken = readStringField(record, "accessToken");
  return {
    accessToken,
    refreshToken: readStringField(record, "refreshToken"),
    expiresAt: absoluteExpiryMs(record, "expiresAt", "expiresIn", accessToken),
    refreshExpiresAt: absoluteExpiryMs(record, "refreshExpiresAt", "refreshExpiresIn", accessToken),
    tokenType: tokenType.length > 0 ? tokenType : "Bearer",
    scope: readStringField(record, "scope"),
    domain: readStringField(record, "domain")
  };
}
function parseAccountData(data) {
  const record = typeof data === "object" && data !== null ? data : {};
  const accountType = readStringField(record, "type");
  return {
    uid: readStringField(record, "uid"),
    nickname: readStringField(record, "nickname"),
    enterpriseId: readStringField(record, "enterpriseId"),
    accountType: accountType.length > 0 ? accountType : "personal"
  };
}
function buildCredential(token, account) {
  const nickname = account.nickname.length > 0 ? account.nickname : jwtNickname(token.accessToken);
  return {
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    refresh_expires_at: token.refreshExpiresAt,
    token_type: token.tokenType,
    scope: token.scope,
    domain: token.domain,
    user_id: account.uid.length > 0 ? account.uid : jwtSubject(token.accessToken),
    nickname,
    enterprise_id: account.enterpriseId,
    account_type: account.accountType
  };
}
function jwtSubject(token) {
  if (typeof token !== "string" || token.length === 0) return "";
  const parts = token.split(".");
  if (parts.length < 2) return "";
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.sub === "string" ? payload.sub : "";
  } catch {
    return "";
  }
}
const MODEL_DISPLAY_NAMES = {
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "hy4-preview": "Hy4 Preview",
  "hy4-preview-x": "Hy4 Preview X",
  "hy3": "Hy3",
  "hy3-x": "Hy3 X",
  "glm-5.3": "GLM-5.3",
  "glm-5.3-flash": "GLM-5.3 Flash",
  "glm-5.2": "GLM-5.2",
  "glm-5.1": "GLM-5.1",
  "glm-5v-turbo": "GLM-5V Turbo",
  "kimi-k3-1": "Kimi K3-1",
  "kimi-k2.7": "Kimi K2.7",
  "kimi-k2.6": "Kimi K2.6",
  "minimax-m3": "MiniMax M3"
};
function displayNameForModel(id) {
  return MODEL_DISPLAY_NAMES[id] ?? id;
}
function normalizeCreditsRate(value) {
  return normalizeRate(value, /^(?:x(\d+(?:\.\d+)?))\b/i, /^(\d+(?:\.\d+)?)x\b/i);
}
function normalizeDiscountedRate(value) {
  return normalizeRate(value, /^(?:x(\d+(?:\.\d+)?))\b/i, /^(\d+(?:\.\d+)?)x\b/i);
}
function normalizeRate(value, prefixed, suffixed) {
  if (typeof value !== "string") return void 0;
  const text = value.trim();
  const head = text.split(/\s+/)[0] ?? "";
  const match = prefixed.exec(head) ?? suffixed.exec(head);
  return match?.[1] !== void 0 ? `x${match[1]}` : void 0;
}
function parseHHMM(value) {
  if (typeof value !== "string") return void 0;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (m === null) return void 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : void 0;
}
function zonedMinutes(now, timeZone) {
  const zone = typeof timeZone === "string" && timeZone.length > 0 ? timeZone : "Asia/Shanghai";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : void 0;
  } catch {
    return void 0;
  }
}
function hasTimeWindow(schedule) {
  return Array.isArray(schedule.daily) && schedule.daily.length > 0 || schedule.validFrom !== void 0 || schedule.validUntil !== void 0;
}
function promotionActiveNow(item, now) {
  const raw = item.schedule;
  if (typeof raw !== "object" || raw === null) return true;
  const schedule = raw;
  const from = typeof schedule.validFrom === "string" ? Date.parse(schedule.validFrom) : Number.NaN;
  const until = typeof schedule.validUntil === "string" ? Date.parse(schedule.validUntil) : Number.NaN;
  if (Number.isFinite(from) && now.getTime() < from) return false;
  if (Number.isFinite(until) && now.getTime() >= until) return false;
  if (!Array.isArray(schedule.daily) || schedule.daily.length === 0) return true;
  const minutes = zonedMinutes(now, schedule.timezone);
  if (minutes === void 0) return true;
  return schedule.daily.some((slot) => {
    if (typeof slot !== "object" || slot === null) return false;
    const start = parseHHMM(slot.start);
    const end = parseHHMM(slot.end);
    if (start === void 0 || end === void 0) return false;
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  });
}
function parsePromotions(record, now = /* @__PURE__ */ new Date()) {
  const result = /* @__PURE__ */ new Map();
  const chosen = /* @__PURE__ */ new Map();
  const promotions = record.modelPromotions;
  if (!Array.isArray(promotions)) return result;
  const sorted = [...promotions].sort((a, b) => priorityOf(a) - priorityOf(b));
  for (const item of sorted) {
    if (typeof item !== "object" || item === null) continue;
    const promotion = item;
    if (promotion.enabled === false) continue;
    if (!promotionActiveNow(promotion, now)) continue;
    const discount = promotion.discount;
    if (typeof discount !== "object" || discount === null) continue;
    const detail = discount;
    const factor = typeof detail.factor === "number" ? detail.factor : void 0;
    const rawSchedule = promotion.schedule;
    const windowed = typeof rawSchedule === "object" && rawSchedule !== null && hasTimeWindow(rawSchedule);
    let rate;
    if (factor === 0) {
      if (!windowed) continue;
      rate = "\u514D\u8D39";
    } else {
      rate = normalizeDiscountedRate(detail.discountedCredits);
      if (rate === "x0") continue;
    }
    if (rate === void 0) continue;
    const modelIds = promotion.modelIds;
    if (!Array.isArray(modelIds)) continue;
    const priority = priorityOf(promotion);
    for (const id of modelIds) {
      if (typeof id !== "string" || id.length === 0) continue;
      const previous = chosen.get(id);
      if (previous !== void 0 && previous > priority) continue;
      chosen.set(id, priority);
      result.set(id, rate);
    }
  }
  return result;
}
function priorityOf(item) {
  if (typeof item !== "object" || item === null) return 0;
  const priority = item.priority;
  return typeof priority === "number" && Number.isFinite(priority) ? priority : 0;
}
function formatCreditsRate(rate, discounted) {
  if (rate === void 0) return discounted;
  return discounted !== void 0 ? `${rate}\u2192${discounted}` : rate;
}
function parseModelsFromConfig(body) {
  if (typeof body !== "object" || body === null) return [];
  const data = body.data;
  if (typeof data !== "object" || data === null) return [];
  const record = data;
  const metaById = /* @__PURE__ */ new Map();
  if (Array.isArray(record.models)) {
    for (const model of record.models) {
      if (typeof model !== "object" || model === null) continue;
      const entry = model;
      if (typeof entry.id === "string") metaById.set(entry.id, entry);
    }
  }
  const promotions = parsePromotions(record);
  const agentReferencedIds = /* @__PURE__ */ new Set();
  if (Array.isArray(record.agents)) {
    for (const agent of record.agents) {
      if (typeof agent !== "object" || agent === null) continue;
      const models = agent.models;
      if (!Array.isArray(models)) continue;
      for (const model of models) if (typeof model === "string") agentReferencedIds.add(model);
    }
  }
  const parsed = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (id) => {
    if (isAutoSelectAlias(id) || seen.has(id) || !isChatModel(id, metaById.get(id))) return;
    seen.add(id);
    const meta = metaById.get(id);
    const remoteName = typeof meta?.name === "string" && meta.name.length > 0 ? meta.name : void 0;
    const rate = normalizeCreditsRate(meta?.credits);
    const discounted = promotions.get(id);
    parsed.push({
      id,
      name: remoteName ?? displayNameForModel(id),
      ...parseModelMeta(meta),
      ...rate !== void 0 ? { creditsRate: rate } : {},
      ...discounted !== void 0 ? { discountedCreditsRate: discounted } : {},
      ...agentReferencedIds.has(id) ? { agentReferenced: true } : {}
    });
  };
  for (const agentName of PREFERRED_AGENT_NAMES) {
    let found = false;
    const agents = record.agents;
    if (!Array.isArray(agents)) break;
    for (const agent of agents) {
      if (typeof agent !== "object" || agent === null) continue;
      const agentRecord = agent;
      if (agentRecord.name !== agentName) continue;
      if (Array.isArray(agentRecord.models)) {
        for (const model of agentRecord.models) {
          if (typeof model === "string") push(model);
        }
      }
      found = true;
      break;
    }
    if (found) break;
  }
  for (const id of metaById.keys()) push(id);
  for (const id of trialModelIds(record)) {
    if (isAutoSelectAlias(id) || seen.has(id)) continue;
    seen.add(id);
    const meta = metaById.get(id);
    const rate = normalizeCreditsRate(meta?.credits);
    const discounted = promotions.get(id);
    parsed.push({
      id,
      name: displayNameForModel(id),
      ...parseModelMeta(meta),
      ...rate !== void 0 ? { creditsRate: rate } : {},
      ...discounted !== void 0 ? { discountedCreditsRate: discounted } : {},
      // 试用横幅本身就是「服务端推荐可用」的信号，与 agent 引用同义。
      agentReferenced: true
    });
  }
  return parsed;
}
const PREFERRED_AGENT_NAMES = ["cli", "craft"];
function trialModelIds(data) {
  const features = data.productFeaturesConfig;
  if (typeof features !== "object" || features === null) return [];
  const banner = features.ModelTrialBanner;
  if (typeof banner !== "object" || banner === null) return [];
  const banners = banner.banners;
  if (!Array.isArray(banners)) return [];
  const ids = [];
  for (const item of banners) {
    if (typeof item !== "object" || item === null) continue;
    const target = item.targetModelId;
    if (typeof target === "string" && target.length > 0) ids.push(target);
  }
  return ids;
}
function isAutoSelectAlias(id) {
  return id === "auto" || id === "default";
}
function isChatModel(id, meta) {
  if (id.startsWith("nes-") || id.startsWith("completion-") || id.startsWith("codewise-")) return false;
  if (meta?.supportsExtra === true) return false;
  const maxOutput = meta?.maxOutputTokens;
  if (typeof maxOutput === "number" && maxOutput > 0 && maxOutput <= 256) return false;
  const tags = meta?.tags;
  if (Array.isArray(tags) && tags.some((tag) => tag === "text-to-image")) return false;
  return true;
}
function parseModelMeta(record) {
  if (record === void 0) return {};
  const meta = {};
  const limit = record.maxInputTokens;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) meta.contextWindow = limit;
  const maxOutput = record.maxOutputTokens;
  if (typeof maxOutput === "number" && Number.isFinite(maxOutput) && maxOutput > 0) {
    meta.maxOutputTokens = maxOutput;
  }
  if (typeof record.supportsImages === "boolean") meta.supportsImages = record.supportsImages;
  const reasoning = record.reasoning;
  if (typeof reasoning === "object" && reasoning !== null) {
    const fields = reasoning;
    if (Array.isArray(fields.supportedEfforts)) {
      const efforts = fields.supportedEfforts.filter((e) => typeof e === "string" && e.length > 0);
      if (efforts.length > 0) meta.reasoningEfforts = efforts;
    }
    if (typeof fields.defaultEffort === "string" && fields.defaultEffort.length > 0) {
      meta.defaultReasoningEffort = fields.defaultEffort;
    }
  }
  return meta;
}
export {
  ACCOUNTS_PATH,
  API_DOMAIN,
  API_ENDPOINT,
  AUTH_REFRESH_PATH,
  AUTH_REFRESH_SOURCE,
  AUTH_STATE_PATH,
  AUTH_TOKEN_PATH,
  BUDDY_DEPLOYMENT_TYPE,
  BUDDY_PRODUCT_CODE,
  BUDDY_USER_AGENT,
  CODE_ACCOUNT_NOT_READY,
  CODE_TOKEN_NOT_READY,
  CONFIG_PATH,
  HTTP_HEADER_AUTH_REFRESH_SOURCE,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_ENTERPRISE_ID,
  HTTP_HEADER_NO_AUTHORIZATION,
  HTTP_HEADER_NO_DEPARTMENT_INFO,
  HTTP_HEADER_NO_ENTERPRISE_ID,
  HTTP_HEADER_NO_USER_ID,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE,
  HTTP_HEADER_REFRESH_TOKEN,
  HTTP_HEADER_TENANT_ID,
  LOGIN_ACCOUNT_PATH,
  LOGIN_TIMEOUT_MS,
  PLATFORM,
  POLL_INTERVAL_MS,
  PREFIX_PATH,
  REQUEST_TIMEOUT_MS,
  STATE_REQUEST_TIMEOUT_MS,
  WEBSITE_HOME,
  buildCredential,
  credentialAuthHeaders,
  credentialExpiresAtMs,
  credentialRequestHeaders,
  displayNameForModel,
  formatCreditsRate,
  isExpired,
  isRefreshable,
  jwtExpiresAtMs,
  jwtNickname,
  normalizeCreditsRate,
  normalizeDiscountedRate,
  parseAccountData,
  parseModelsFromConfig,
  parsePromotions,
  parseTokenData
};

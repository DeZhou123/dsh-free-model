import {
  BUDDY_DEPLOYMENT_TYPE,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE
} from "./buddy.js";
const CHECKIN_ACTIVITY_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
const DAILY_CHECKIN_PATH = "/v2/billing/meter/daily-checkin";
const USER_RESOURCE_PATH = "/v2/billing/meter/get-user-resource";
const REQUEST_TIMEOUT_MS = 3e4;
const CODE_ALREADY_CLAIMED = 10001;
const CODE_ALREADY_CLAIMED_ALT = 1001;
const CODE_NO_QUALIFICATION = 1002;
const CODE_ACTIVITY_ENDED = 1003;
function checkinHeaders(credential, product) {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${credential.access_token}`);
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  headers.set(HTTP_HEADER_DOMAIN, product.apiDomain || credential.domain || "");
  headers.set(HTTP_HEADER_PRODUCT, BUDDY_DEPLOYMENT_TYPE);
  headers.set(HTTP_HEADER_PRODUCT_CODE, product.productCode);
  if (credential.user_id !== void 0 && credential.user_id.length > 0) {
    headers.set("X-User-Id", credential.user_id);
  }
  if (credential.enterprise_id !== void 0 && credential.enterprise_id.length > 0) {
    headers.set("X-Enterprise-Id", credential.enterprise_id);
    headers.set("X-Tenant-Id", credential.enterprise_id);
  }
  headers.set("User-Agent", product.userAgent);
  return headers;
}
function readBool(source, key) {
  return source[key] === true;
}
function readNumber(source, key) {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function readString(source, key) {
  const value = source[key];
  return typeof value === "string" ? value : "";
}
function readStringArray(source, key) {
  const value = source[key];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
const UNPARSABLE_RESPONSE_MESSAGE = "\u8BF7\u6C42\u5931\u8D25\u6216\u54CD\u5E94\u65E0\u6CD5\u89E3\u6790";
async function postJson(path, credential, product, fetcher) {
  try {
    const response = await fetcher(`${product.endpoint}${path}`, {
      method: "POST",
      headers: checkinHeaders(credential, product),
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, message: describeNonJsonResponse(response.status, text) };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, message: UNPARSABLE_RESPONSE_MESSAGE };
    }
    return { ok: true, body: parsed };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
function describeNonJsonResponse(status, text) {
  if (status === 401 || status === 403) {
    return `\u51ED\u636E\u5DF2\u5931\u6548\uFF08HTTP ${status}\uFF09\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u8BE5\u8D26\u53F7`;
  }
  const snippet = text.trim().slice(0, 80).replace(/\s+/g, " ");
  return `\u670D\u52A1\u7AEF\u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94\uFF08HTTP ${status}\uFF09\uFF1A${snippet}`;
}
async function fetchCheckinStatus(credential, product, fetcher = fetch) {
  const result = await postJson(CHECKIN_ACTIVITY_STATUS_PATH, credential, product, fetcher);
  if (!result.ok) return null;
  const body = result.body;
  if (body.code !== 0) return null;
  const data = body.data;
  if (typeof data !== "object" || data === null) return null;
  const record = data;
  return {
    active: readBool(record, "active"),
    todayCheckedIn: readBool(record, "today_checked_in"),
    streakDays: readNumber(record, "streak_days"),
    dailyCredit: readNumber(record, "daily_credit"),
    todayCredit: readNumber(record, "today_credit"),
    isStreakDay: readBool(record, "is_streak_day"),
    totalCredits: readNumber(record, "total_credits"),
    checkinDates: readStringArray(record, "checkin_dates"),
    activityName: readString(record, "activity_name"),
    themeName: readString(record, "theme_name"),
    endTime: readString(record, "end_time")
  };
}
async function claimDailyCheckin(credential, product, fetcher = fetch) {
  const result = await postJson(DAILY_CHECKIN_PATH, credential, product, fetcher);
  if (!result.ok) {
    return { kind: "failed", code: -1, message: result.message };
  }
  const body = result.body;
  const code = typeof body.code === "number" ? body.code : -1;
  const message = readString(body, "msg");
  if (code === CODE_ALREADY_CLAIMED || code === CODE_ALREADY_CLAIMED_ALT) {
    return { kind: "already-claimed", message: message.length > 0 ? message : "\u4ECA\u5929\u5DF2\u7B7E\u5230" };
  }
  if (code === CODE_NO_QUALIFICATION || code === CODE_ACTIVITY_ENDED) {
    return { kind: "inactive", message: message.length > 0 ? message : "\u5F53\u524D\u65E0\u9886\u53D6\u8D44\u683C" };
  }
  if (code !== 0) {
    return { kind: "failed", code, message: message.length > 0 ? message : "\u9886\u53D6\u5931\u8D25" };
  }
  const data = body.data;
  if (typeof data !== "object" || data === null) {
    return { kind: "failed", code, message: "\u9886\u53D6\u54CD\u5E94\u7F3A\u5C11 data \u5B57\u6BB5" };
  }
  const record = data;
  const delayed = readString(record, "message");
  return {
    kind: "claimed",
    credit: readNumber(record, "credit"),
    streakDays: readNumber(record, "streak_days"),
    isStreakDay: readBool(record, "is_streak_day"),
    ...delayed.length > 0 ? { delayedMessage: delayed } : {}
  };
}
function readPreciseNumber(source, baseKey) {
  const precise = source[`${baseKey}Precise`];
  if (typeof precise === "string") {
    const parsed = Number.parseFloat(precise);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof precise === "number" && Number.isFinite(precise)) return precise;
  return readNumber(source, baseKey);
}
const PACKAGE_STATUS_EXPIRED = 3;
function parseCreditPackage(entry) {
  const name = readString(entry, "PackageName") || readString(entry, "SubProductName") || readString(entry, "PackageCode");
  const unit = readString(entry, "CapacityUnit") || readString(entry, "OriginUnit");
  const status = entry.Status;
  const expiredTime = readString(entry, "ExpiredTime");
  const deductionEndTime = readNumber(entry, "DeductionEndTime");
  const expiredAt = expiredTime.length > 0 ? Date.parse(expiredTime.replace(" ", "T")) : Number.NaN;
  const active = status !== PACKAGE_STATUS_EXPIRED && !(Number.isFinite(expiredAt) && Date.now() >= expiredAt) && !(deductionEndTime > 0 && Date.now() >= deductionEndTime);
  return {
    name,
    unit,
    remaining: readPreciseNumber(entry, "CycleCapacityRemain"),
    total: readPreciseNumber(entry, "CycleCapacitySize"),
    used: readPreciseNumber(entry, "CycleCapacityUsed"),
    active,
    cycleStartTime: readString(entry, "CycleStartTime"),
    cycleEndTime: readString(entry, "CycleEndTime"),
    expiredTime,
    ...deductionEndTime > 0 ? { deductionEndTime } : {}
  };
}
async function fetchCreditBalance(credential, product, fetcher = fetch) {
  const result = await postJson(USER_RESOURCE_PATH, credential, product, fetcher);
  if (!result.ok) return null;
  const body = result.body;
  if (body.code !== 0) return null;
  const outer = body.data;
  if (typeof outer !== "object" || outer === null) return null;
  const response = outer.Response;
  if (typeof response !== "object" || response === null) return null;
  const inner = response.Data;
  if (typeof inner !== "object" || inner === null) return null;
  const accounts = inner.Accounts;
  if (!Array.isArray(accounts)) return null;
  const packages = [];
  for (const item of accounts) {
    if (typeof item !== "object" || item === null) continue;
    packages.push(parseCreditPackage(item));
  }
  const total = roundCredits(
    packages.reduce((sum, pkg) => sum + (pkg.active ? pkg.remaining : 0), 0)
  );
  const expiredTotal = roundCredits(
    packages.reduce((sum, pkg) => sum + (pkg.active ? 0 : pkg.remaining), 0)
  );
  return { total, packages, expiredTotal };
}
function roundCredits(value) {
  return Math.round(value * 100) / 100;
}
function normalizeCreditUnit(unit) {
  return unit === "token" ? "token" : "credit";
}
function claimUnitOf(unit) {
  return normalizeCreditUnit(typeof unit === "string" ? unit : "");
}
function formatCreditAmount(value) {
  if (!Number.isFinite(value)) return "?";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
function formatTokenAmount(value) {
  if (!Number.isFinite(value)) return "?";
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return String(Math.round(value));
}
function claimUnitLabel(unit) {
  return unit === "token" ? "Token" : "\u79EF\u5206";
}
function formatUnitAmount(value, unit) {
  const text = unit === "token" ? formatTokenAmount(value) : formatCreditAmount(value);
  return `${text}${claimUnitLabel(unit)}`;
}
function formatClaimGains(totals) {
  if (totals === void 0 || totals === null || typeof totals !== "object") return null;
  const parts = [];
  for (const unit of ["token", "credit"]) {
    const value = Number(totals[unit]);
    if (!Number.isFinite(value) || value <= 0) continue;
    parts.push(`+${formatUnitAmount(value, unit)}`);
  }
  return parts.length === 0 ? null : parts.join(", ");
}
export {
  CHECKIN_ACTIVITY_STATUS_PATH,
  DAILY_CHECKIN_PATH,
  USER_RESOURCE_PATH,
  claimDailyCheckin,
  claimUnitLabel,
  claimUnitOf,
  fetchCheckinStatus,
  fetchCreditBalance,
  formatClaimGains,
  formatCreditAmount,
  formatTokenAmount,
  formatUnitAmount,
  normalizeCreditUnit,
  roundCredits
};

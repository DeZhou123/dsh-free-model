const REFRESH_LEAD_MS = 36e5;
const REFRESH_RETRY_MS = 6e5;
const REFRESH_ABNORMAL_NETWORK_RETRY_MS = 6e4;
function isAbnormalNetworkError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ENOTFOUND|ECONNREFUSED|proxy|unresolved host|getaddrinfo/i.test(message);
}
function isRefreshTokenExpired(error) {
  if (!(error instanceof Error)) return false;
  if (error.name === "RefreshTokenExpiredError") return true;
  return /refresh[_ ]?token/i.test(error.message);
}
function computeFirstRefreshDelayMs(expiresAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(expiresAtMs)) return 0;
  const leadTrigger = nowMs + REFRESH_LEAD_MS;
  if (leadTrigger >= expiresAtMs) return 0;
  const trigger = new Date(leadTrigger);
  trigger.setSeconds(Math.floor(60 * Math.random()));
  const delay = trigger.getTime() - nowMs;
  return delay > 0 ? delay : 0;
}
class RefreshScheduler {
  constructor(refresh, onError = () => {
  }) {
    this.refresh = refresh;
    this.onError = onError;
  }
  timer;
  pending = false;
  /** 调度代号：stop()/arm() 都会推进它，用于让在途 run() 放弃失败后的重试武装。 */
  generation = 0;
  /** 为在 `expiresAtMs` 过期的凭据安排下次刷新；`nowMs` 仅供测试注入。 */
  arm(expiresAtMs, nowMs = Date.now()) {
    this.generation++;
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
    const delay = computeFirstRefreshDelayMs(expiresAtMs, nowMs);
    this.timer = setTimeout(() => {
      void this.run();
    }, delay);
    this.timer.unref?.();
  }
  /** 取消任何待处理的刷新（并让在途 run() 失败后不再重试）。 */
  stop() {
    this.generation++;
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
  }
  /** 立即执行一次刷新（供启动时已处于到期窗口内的凭据使用）。 */
  async refreshOnce() {
    this.stop();
    await this.run();
  }
  async run() {
    if (this.pending) return;
    this.pending = true;
    const generation = this.generation;
    try {
      await this.refresh();
    } catch (error) {
      this.onError(error);
      if (generation !== this.generation) {
        return;
      }
      if (isRefreshTokenExpired(error)) {
        return;
      }
      if (this.timer !== void 0) {
        clearTimeout(this.timer);
      }
      const retry = isAbnormalNetworkError(error) ? REFRESH_ABNORMAL_NETWORK_RETRY_MS : REFRESH_RETRY_MS;
      this.timer = setTimeout(() => {
        void this.run();
      }, retry);
      this.timer.unref?.();
    } finally {
      this.pending = false;
    }
  }
}
export {
  REFRESH_ABNORMAL_NETWORK_RETRY_MS,
  REFRESH_LEAD_MS,
  REFRESH_RETRY_MS,
  RefreshScheduler,
  computeFirstRefreshDelayMs
};

const REMOTE_CATALOG_COOLDOWN_MS = 3e4;
class RemoteCatalogGate {
  inFlight;
  retryAt;
  cooldownMs;
  now;
  constructor(options = {}) {
    this.cooldownMs = options.cooldownMs ?? REMOTE_CATALOG_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }
  /**
   * 是否处于「上次没拿到目录」的冷却窗口内。
   *
   * ⚠ `retryAt` 是用**墙钟**算的，系统时间被回拨时 `now() < retryAt` 会
   * 把冷却**拉长**（回拨一天就是事实上的永久卡死）。故这里只认「剩余量
   * 不超过一个冷却周期」的窗口 —— 回拨造成的超长窗口一律按已到期处理。
   */
  cooling() {
    if (this.retryAt === void 0) return false;
    const now = this.now();
    return now < this.retryAt && this.retryAt - now <= this.cooldownMs;
  }
  /**
   * 至多发起一次加载。
   *
   * - 冷却中：**不调用** `run`，直接返回。
   * - 已有在飞的加载：等它，不重复调用 `run`。
   * - 否则调用 `run`；返回 `false`（或抛错）即进入冷却。
   *
   * @param run 执行实际拉取，并在成功时自行落缓存；返回是否拿到了非空目录。
   */
  async run(run) {
    if (this.inFlight !== void 0) {
      await this.inFlight;
      return;
    }
    if (this.cooling()) return;
    const task = (async () => {
      try {
        return await run();
      } catch {
        return false;
      }
    })();
    this.inFlight = task;
    try {
      const got = await task;
      this.retryAt = got ? void 0 : this.now() + this.cooldownMs;
    } finally {
      if (this.inFlight === task) this.inFlight = void 0;
    }
  }
  /** 清掉冷却窗口（例如用户显式触发刷新）。 */
  reset() {
    this.retryAt = void 0;
  }
}
export {
  REMOTE_CATALOG_COOLDOWN_MS,
  RemoteCatalogGate
};

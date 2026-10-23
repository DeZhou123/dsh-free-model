/**
 * OpenCode 本地服务的**进程生命周期**。
 *
 * ## 为什么插件要管进程
 *
 * 用户不该为了一个设置页去敲命令。但自动拉起进程有三个坑，这里逐个处理：
 *
 * 1. **不能假设 PATH 里有 `opencode`**。本机的 CLI 是手工装到
 *    `E:\06AI\08OpenCode\bin\opencode.exe`（`E:\06AI` 安装规范），
 *    桌面版则在 `%LOCALAPPDATA%\Programs\@opencodedesktop\...`。故探测顺序：
 *    显式配置 → 环境变量 → 已知安装位置 → 桌面版目录 → PATH。
 * 2. **不能重复起**。先探 `/global/health`；活着就直接用（可能是用户自己
 *    开的桌面版 sidecar）。
 * 3. **不能让它随父进程死掉**。DSH 宿主重启不该带走一个正在跑的服务；
 *    反过来，本插件卸载时也不该留下孤儿。折中：`detached` 起、记录 pid，
 *    卸载时只杀**自己起的那一个**。
 *
 * ## 端口
 *
 * 默认 4096（opencode 官方文档的默认值）。被占用时自动顺延到 4097..4110 ——
 * 与 OFM 网关「端口被占则顺延并在页面上标注实际端口」的做法一致。
 *
 * @module src/opencode/service
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeClient } from './client.js'

/** 默认端口与顺延范围。 */
const DEFAULT_PORT = 4096
const PORT_RANGE = 15

/** 已知安装位置（按优先级）。 */
const KNOWN_PATHS = [
  'E:/06AI/08OpenCode/bin/opencode.exe',
  'C:/Program Files/opencode/opencode.exe',
]

/**
 * 探测 opencode 可执行文件。
 *
 * 桌面版把二进制放在 `%LOCALAPPDATA%\Programs\@opencodedesktop\<version>\...`，
 * 版本号会变 —— 所以**逐层扫**而不是拼死一个路径。早先的实现只把那个目录
 * 本身当候选（不是 .exe），等于白写。
 *
 * @param {string} [configured] 用户显式配置的路径
 * @returns {string | undefined}
 */
export function resolveBinary(configured) {
  const candidates = []
  if (typeof configured === 'string' && configured.trim() !== '') candidates.push(configured.trim())
  const fromEnv = process.env.OPENCODE_BIN
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push(fromEnv.trim())
  for (const known of KNOWN_PATHS) candidates.push(known)
  candidates.push(...desktopBinaries())
  for (const candidate of candidates) {
    if (candidate.toLowerCase().endsWith('.exe') && existsSync(candidate)) return candidate
  }
  // PATH 兜底：交给 spawn 自己解析（不在这里做 which）。
  return 'opencode'
}

/** 桌面版目录下的一级 .exe（版本号会变，故逐层扫两层）。 */
function desktopBinaries() {
  const found = []
  const root = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', '@opencodedesktop')
  if (!existsSync(root)) return found
  const scan = (dir, depth) => {
    if (depth > 2) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) found.push(full)
      else if (entry.isDirectory()) scan(full, depth + 1)
    }
  }
  scan(root, 0)
  return found
}

/**
 * 服务管理器。
 *
 * 一个实例管一个端口；`client()` 每次返回**当前**客户端（端口可能因顺延而变）。
 */
export class OpenCodeService {
  /**
   * @param {{
   *   binary?: string,
   *   port?: number,
   *   logger?: any,
   *   spawnImpl?: Function,
   *   fetchImpl?: Function,
   * }} [options]
   */
  constructor(options = {}) {
    this.binary = resolveBinary(options.binary)
    this.requestedPort = Number.isInteger(options.port) && options.port > 0 ? options.port : DEFAULT_PORT
    this.port = this.requestedPort
    this.logger = options.logger
    this.spawnImpl = options.spawnImpl ?? spawn
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    /** 本实例起过的子进程；null 表示没起过（服务可能是用户自己开的）。 */
    this.child = null
    this.clientInstance = undefined
    /** 最近一次失败原因（给页面显示，而不是只写日志）。 */
    this.lastError = undefined
    /** `opencode --version` 的结果（进程没起时也能告诉用户「装的是哪个版本」）。 */
    this.binaryVersion = undefined
  }

  /** 当前端口对应的客户端（懒建，端口变了自动重建）。 */
  client() {
    if (this.clientInstance === undefined || this.clientInstance.baseUrl !== this.baseUrl()) {
      this.clientInstance = new OpenCodeClient({
        baseUrl: this.baseUrl(),
        fetchImpl: this.fetchImpl,
        logger: this.logger,
      })
    }
    return this.clientInstance
  }

  baseUrl() {
    return 'http://127.0.0.1:' + this.port
  }

  /**
   * 二进制自身的版本（`opencode --version`）。
   *
   * 页面要在**服务没起**时也能说清「你装的是 1.19.3，它有没有 /event 接口」——
   * 只报「进程未运行」会让用户以为装错了。
   */
  probeBinaryVersion() {
    if (this.binaryVersion !== undefined) return this.binaryVersion
    try {
      const out = execFileSync(this.binary, ['--version'], { timeout: 8000, windowsHide: true, encoding: 'utf8' })
      const version = String(out).trim().split(/\r?\n/)[0]
      if (version !== '') this.binaryVersion = version
    } catch { /* 二进制不在 PATH / 拒绝执行：保持 undefined */ }
    return this.binaryVersion
  }

  /** 服务是否在跑（含版本号）。 */
  async status() {
    const client = this.client()
    const health = await client.health()
    if (health.healthy) {
      this.lastError = undefined
      return {
        running: true,
        version: health.version,
        port: this.port,
        url: this.baseUrl(),
        managed: this.child !== null,
        binary: this.binary,
        sse: client.sseEnabled === true,
        failures: client.failures(),
      }
    }
    // 端口没答话时，试一下别的端口是否已有实例（用户可能手动起在 4097）。
    this.lastError = health.error
    return {
      running: false,
      port: this.port,
      url: this.baseUrl(),
      managed: this.child !== null,
      binary: this.binary,
      binaryVersion: this.probeBinaryVersion(),
      error: health.error,
    }
  }

  /**
   * 起服务（幂等）。已在跑时直接返回现状。
   *
   * @returns {Promise<{ running: boolean, port: number, started?: boolean, error?: string }>}
   */
  async start() {
    const current = await this.status()
    if (current.running) return { running: true, port: this.port, started: false }

    const lastError = []
    for (let offset = 0; offset < PORT_RANGE; offset += 1) {
      const port = this.requestedPort + offset
      this.port = port
      const client = this.client()
      const health = await client.health()
      if (health.healthy) {
        // 该端口已经有实例（用户自己起的）：直接用，不重复 spawn。
        return { running: true, port, started: false }
      }
      const spawned = this.spawnAt(port)
      if (spawned.error !== undefined) {
        lastError.push(port + ': ' + spawned.error)
        continue
      }
      // 等它开始监听：最多 20 秒（Bun 单文件启动约 1-2 秒，冷启动/杀软扫描更久）。
      const ready = await this.waitReady(client, 20_000)
      if (ready) {
        return { running: true, port, started: true }
      }
      lastError.push(port + ': 启动后 20 秒内没有响应')
      this.stop()
    }
    this.lastError = lastError.join('；')
    return { running: false, port: this.port, started: false, error: this.lastError }
  }

  /** 在指定端口 spawn 一次。 */
  spawnAt(port) {
    try {
      const child = this.spawnImpl(this.binary, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child?.unref?.()
      this.child = child
      this.logger?.info?.('[dsh-free-model] opencode serve 已启动（pid=' + (child?.pid ?? '?') + ' port=' + port + '）')
      return { child }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 轮询等就绪。 */
  async waitReady(client, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const health = await client.health()
      if (health.healthy) return true
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return false
  }

  /**
   * 停服务。
   *
   * ⚠️ 只杀**自己起的**子进程。用户手动开的实例（桌面版 sidecar、终端里的
   * `opencode serve`）不归我们管 —— 杀它会让用户莫名其妙地掉线。
   */
  stop() {
    if (this.child === null) return { stopped: false, reason: 'not-managed' }
    try {
      // detached 起的进程在 Windows 上没有进程组语义，用 pid 直接终止。
      this.child.kill()
      this.child = null
      return { stopped: true }
    } catch (error) {
      return { stopped: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 卸载清理：杀掉自己起的进程 + 删掉自己建的会话。 */
  async dispose() {
    try {
      await this.clientInstance?.dispose?.()
    } catch { /* 清理尽力而为 */ }
    this.stop()
  }
}

/**
 * 用平台默认打开器打开一个 URL（登录页）。**永不抛出异常**。
 *
 * ## ⚠️「永不抛出」必须靠 `'error'` 监听器兑现（OFM 真实缺陷，2026-10-03）
 *
 * `spawn` 的失败（`ENOENT` / `EACCES`）是以**异步 `'error'` 事件**上报的，
 * 外层 `try/catch` **接不住**它。而 `ChildProcess` 是 EventEmitter ——
 * `'error'` 没有监听器时会被 `throw` 成**未捕获异常**。
 *
 * POSIX 上这很容易踩：无桌面环境的 `open`（macOS）/ `xdg-open`（Linux）
 * 常常不存在 ⇒ `ENOENT` ⇒ **直接把宿主进程带走**。
 * （Windows 的 `cmd` 恒存在，所以只在 POSIX 上暴露 —— 典型的「本地测不出来」。）
 *
 * ⚠️ 用 `child.unref()` + 监听器，不能只 `unref` 就完事：前者让父进程
 * 不因它挂起，后者补上缺失的监听器，二者缺一不可。
 *
 * ## Windows 的引号陷阱
 *
 * `cmd /c start` 会把 URL 里每个 `&` 当作命令分隔符，导致参数被截断
 * （浏览器只收到 `?theme=2`）。必须把整个 URL 加引号作为单个参数传给 cmd，
 * 并用 `windowsVerbatimArguments` 关闭 Node 的二次转义。`start` 的窗口标题参数
 * 必须显式传 `'""'` —— 空字符串参数会被 Node 丢弃，`start` 会把 URL 当成标题。
 *
 * @module src/core/login
 */

import { spawn } from 'node:child_process'

/**
 * @param {string} url
 */
export function openBrowser(url) {
  const warn = (error) => {
    console.error('[free-model] 打开浏览器失败，请手动打开：', url, error)
  }
  const win = process.platform === 'win32'
  if (win) {
    const args = ['/c', 'start', '""', `"${url}"`]
    try {
      const child = spawn('cmd', args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      child.on('error', warn)
      child.unref()
      return
    } catch (error) {
      warn(error)
      return
    }
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' })
    child.on('error', warn)
    child.unref()
  } catch (error) {
    warn(error)
  }
}

/** 默认打开器（供 `runBuddyLoginFlow` 的 `openBrowser` 缺省值使用）。 */
export default openBrowser

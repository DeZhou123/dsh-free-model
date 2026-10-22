/**
 * 以 detached 方式把 opencode serve 拉起来（与插件 OpenCodeService 同款手法），
 * 让它在父进程退出后继续存活。用于手工验证。
 */
import { spawn } from 'node:child_process'

const child = spawn('E:/06AI/08OpenCode/bin/opencode.exe', ['serve', '--port', '4096', '--hostname', '127.0.0.1'], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
child.unref()
console.log('spawned pid=' + child.pid)

// 等就绪
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 400))
  try {
    const res = await fetch('http://127.0.0.1:4096/global/health')
    if (res.ok) {
      console.log('ready:', await res.text())
      process.exit(0)
    }
  } catch { /* 还没起来 */ }
}
console.log('timeout waiting for serve')
process.exit(1)

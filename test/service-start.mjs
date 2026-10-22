/**
 * 真实拉起测试：用插件的 OpenCodeService 启动 serve，验证端口顺延与就绪判定。
 *
 * 用法：node test/service-start.mjs
 */
import { OpenCodeService } from '../src/opencode/service.js'

const service = new OpenCodeService({ logger: console })
console.log('binary:', service.binary)
console.log('before:', JSON.stringify(await service.status()))

const started = await service.start()
console.log('start:', JSON.stringify(started))

const status = await service.status()
console.log('after:', JSON.stringify(status))

if (!started.running) {
  console.log('FAIL: 启动失败')
  process.exit(1)
}

const models = await service.client().listModels({ providers: ['opencode', 'ofm'] })
console.log('models:', models.length)

// 保持进程存活（detached 起的不受影响），只清理会话。
await service.client().dispose()
console.log('OK（服务保持运行，pid 由 detached 托管）')

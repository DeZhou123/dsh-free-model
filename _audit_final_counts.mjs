
import { descriptors } from './src/lanes/keyed/index.js'
import { buildRegistry } from './src/lanes/registry.js'
import fs from 'node:fs'
const rows = await descriptors({ readCredential: async () => undefined }, { includeRetired: true })
const reg = buildRegistry({ keyed: rows })
console.log('descriptors(includeRetired) 行数 =', rows.length, '| retired 行 =', rows.filter(r=>r.retired).length)
console.log('buildRegistry counts =', JSON.stringify(reg.counts))
const remote = JSON.parse(fs.readFileSync('catalog/channels.json','utf8')).channels
const remoteKeyed = remote.filter(c=>c.kind==='keyed')
console.log('远程 keyed =', remoteKeyed.length, '| 远程 total =', remote.length)
const ids = new Set(reg.channels.map(c=>c.id))
console.log('远程 keyed 里没进注册表的 =', remoteKeyed.filter(c=>!ids.has(c.id)).length)
console.log('rejected 条数 =', reg.rejected.length)

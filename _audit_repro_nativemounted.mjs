
import { buildRegistry, projectRegistryView } from './src/lanes/registry.js'
const reg = buildRegistry({})
const mounted = new Map([['buddy',{x:1}],['workbuddy',{x:1}]])
const rows = projectRegistryView(reg.channels, { nativeMounted: mounted, serviceProbes: {}, keyedReady: {} })
for (const r of rows.filter(r=>r.kind==='account')) console.log(r.id, r.state, '|', r.reason)
console.log('--- 若传数组 ---')
const rows2 = projectRegistryView(reg.channels, { nativeMounted: [...mounted.keys()], serviceProbes: {}, keyedReady: {} })
for (const r of rows2.filter(r=>r.kind==='account')) console.log(r.id, r.state, '|', r.reason)

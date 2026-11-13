
import { buildRegistry } from './src/lanes/registry.js'
// 模拟：随包 keyed 只有 groq；远程目录新增一条 keyed 渠道 remote-new
const keyed = [{ id:'groq', displayName:'Groq', kind:'keyed', baseURL:'https://api.groq.com/openai/v1', apiKeyEnv:'GROQ_API_KEY', models:[{id:'m1'}], capability:{}, credits:{} }]
const remote = [{ id:'remote-new', displayName:'Remote 新渠道', kind:'keyed', baseURL:'https://example.com/v1', apiKeyEnv:'RN_API_KEY', models:[{id:'x'}], capability:{}, credits:{} }]
const reg = buildRegistry({ keyed, remote, local: [] })
console.log('counts', JSON.stringify(reg.counts))
console.log('ids', reg.channels.map(c=>c.id+':'+c.kind).join(', '))
console.log('remote keyed 是否进表:', reg.channels.some(c=>c.id==='remote-new'))
console.log('rejected', JSON.stringify(reg.rejected))

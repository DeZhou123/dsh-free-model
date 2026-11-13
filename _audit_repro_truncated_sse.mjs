
import { createKeyedAdapter } from './src/lanes/keyed/adapter.js'
const lane = { id:'t', displayName:'T', kind:'keyed', baseURL:'https://x.example/v1', apiKeyEnv:'X_KEY', models:[{id:'m'}] }
function sseFetch(frames){
  return async () => new Response(new ReadableStream({
    start(c){ const enc=new TextEncoder(); for(const f of frames) c.enqueue(enc.encode(f)); c.close() }
  }), { status:200, headers:{'content-type':'text/event-stream'} })
}
// 只收到半个 chunk（没有 [DONE]、没有 finish_reason），然后连接正常关闭
const frames = ['data: '+JSON.stringify({choices:[{index:0,delta:{content:'半截话'}}]})+'\n\n']
const ad = createKeyedAdapter({ lane, apiKey:'k', fetchImpl: sseFetch(frames) })
const out = []
for await (const ch of ad.stream({ model:'m', messages:[{role:'user',content:[{type:'text',text:'hi'}]}] })) out.push(ch)
console.log(JSON.stringify(out.map(o=>o.type+':'+(o.type==='finish'?JSON.stringify(o.reason):''))))

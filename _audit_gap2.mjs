
import { SERVICE_LANES } from './src/lanes/service.js'
import { KEYED_CHANNELS, KEYLESS_CHANNELS } from './src/lanes/keyed/catalog.js'
const svc = SERVICE_LANES.map(l=>l.id)
console.log('service ids:', svc.join(', '))
const all = new Set([...svc, ...KEYED_CHANNELS.map(c=>c.id), ...KEYLESS_CHANNELS.map(c=>c.id)])
const asked = ['cerebras','groq','google-ai-studio','mistral','openrouter-free','github-models','cloudflare-workers-ai','huggingface-router','together','fireworks','sambanova','nvidia-nim','chutes','kluster','deepinfra','novita','hyperbolic','lambda','ollama','lmstudio','vllm','zhipu-bigmodel','moonshot','dashscope','modelscope','siliconflow','volcano-ark','baidu-qianfan','hunyuan','minimax','stepfun','spark-xfyun','pollinations','puter','ai21','cohere','upstage','reka','nous','opencode-zen','freellmapi']
const miss = asked.filter(a=>!all.has(a))
console.log('MISSING', miss.length, ':', miss.join(', '))


import { KEYED_CHANNELS, KEYLESS_CHANNELS, RETIRED_CHANNELS } from './src/lanes/keyed/catalog.js'
const ids = new Set([...KEYED_CHANNELS, ...KEYLESS_CHANNELS, ...RETIRED_CHANNELS].map(c=>c.id))
const asked = ['cerebras','groq','google-ai-studio','mistral','openrouter-free','github-models','cloudflare-workers-ai','huggingface-router','together','fireworks','sambanova','nvidia-nim','chutes','kluster','deepinfra','novita','hyperbolic','lambda','ollama','lmstudio','vllm','zhipu-bigmodel','moonshot','dashscope','modelscope','siliconflow','volcano-ark','baidu-qianfan','hunyuan','minimax','stepfun','spark-xfyun','pollinations','puter','ai21','cohere','upstage','reka','nous','opencode-zen','freellmapi']
const have = asked.filter(a=>ids.has(a))
const miss = asked.filter(a=>!ids.has(a))
console.log('asked', asked.length, 'have', have.length, 'miss', miss.length)
console.log('MISSING:', miss.join(', '))
console.log('ALL IDS:', [...ids].sort().join(', '))

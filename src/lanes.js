/**
 * 账号渠道注册表 —— 把 OFM（dsh-our-free-model 的 channel-pack）已有的账号车道
 * 补齐到本插件的「账号渠道」页。
 *
 * ## 为什么需要它
 *
 * 本插件从 dsh-ofm-workbuddy 起步时只有两条账号车道（CodeBuddy / WorkBuddy）。
 * 那两条是 OFM 2.5.8 **退役**的（retired-providers.ts），所以必须由本插件自己
 * 挂载；而 OFM 的其余 11 条车道（CodeArts、LobsterAI、Qoder、Qoder 中国版、
 * TRAE、Cline、Loomy、Raccoon、MiniMax、Gemini、ZCode）**仍然活着**，它们的
 * auth、适配器、积分与登录实现全在宿主的 channel-pack 里，账号也存在同一份
 * channel-pack/state.json。
 *
 * 于是本插件的页面此前只显示 2 条车道，用户要在两个面板之间来回切。这份注册表
 * 把 11 条补齐，让「账号渠道」页成为**唯一**的免费模型账号面板。
 *
 * ## backend 的两种取值（页面据此选后端）
 *
 * | backend  | 含义                        | 谁提供登录 / 续期 / 积分 / 模型开关 |
 * |----------|-----------------------------|-------------------------------------|
 * | native   | 本插件自己挂载 auth + adapter | 本插件的 /api/free-model/*          |
 * | ofm      | 由宿主 channel-pack 提供（11 条） | 宿主的 /api/channel-pack RPC     |
 *
 * ⚠️ **不重复挂载这 11 条车道**：宿主的 channel-pack 已经注册了它们的 LLM 路由与
 * ctx.<id>Auth 服务。本插件再挂一遍会撞上两件硬事 ——
 * ① cordis 的 Service 同名注册会抛 service "qoderAuth" has been registered，
 *    把整个 apply 打死（本插件的 src/channels.js 早有同款注释）；
 * ② 两份 auth 实例各自武装续期定时器，同一个 refresh_token 被并发消费，
 *    表现为「刚登录却一直认证失败」。故这里只做**页面 + 管理面**，后端一律转发。
 *
 * ## 降级
 *
 * 宿主没装 OFM（或它没跑）时 accountPool 服务不存在：此时这 11 条车道在页面上
 * 仍会列出（用户能看到「有哪些渠道」），但每条标注「后端未就绪」且不渲染操作
 * 按钮 —— 而不是给出点了必然失败的按钮。
 *
 * ## 数据出处（逐条对齐 OFM 2.5.8 源码，不凭记忆）
 *
 * - displayName / 端点：各 *-product.ts 与 llm-adapter.ts 里的常量；
 * - 积分能力：channel-pack-rpc.ts 的 credits.claimAll / credits.balances 分支
 *   （哪家有 claim、哪家只有 balance 是**产品事实**，不是开关）；
 * - 登录形态：account.create 的各分支（loginMode: "sms" 只出现在 Loomy 的备用
 *   路径上；Loomy / Raccoon 的主路径都是**本机登录页**，弹窗里自带二维码）。
 *
 * @module src/lanes
 */

/**
 * 一条账号车道的展示与管理元数据。
 *
 * 形状与 src/channels.js 里 buddy 系的 product 对齐（id / displayName /
 * endpoint / kind / credits），额外加三个字段：
 * backend（谁来跑）、login（登录交互形态）、note（页面上要给用户看的提醒）。
 *
 * @typedef {{
 *   id: string,
 *   displayName: string,
 *   endpoint: string,
 *   kind: 'account',
 *   backend: 'ofm',
 *   credits: { balance: boolean, claim: boolean, claimNote?: string },
 *   login: 'browser' | 'localPage',
 *   smsFallback?: boolean,
 *   note?: string,
 * }} OfmLane
 */

/** 没有签到接口的车道要写明「为什么没有」，否则用户会以为是坏了。 */
const NO_CLAIM_GEMINI = 'Gemini 免费线没有签到接口（上游不提供）'

/**
 * OFM 侧的 11 条账号车道。
 *
 * ⚠️ 顺序 = 页面上的卡片顺序，与 OFM 的 Channel Pack 导航分组同序
 * （华为 → 有道 → 阿里 ×2 → 字节 → Cline → 讯飞 → 商汤 → MiniMax → Google → 智谱）。
 *
 * @type {readonly OfmLane[]}
 */
export const OFM_LANES = Object.freeze([
  {
    id: 'codearts',
    displayName: 'CodeArts (华为云)',
    endpoint: 'https://snap-access.cn-north-4.myhuaweicloud.com',
    kind: 'account',
    backend: 'ofm',
    credits: { balance: true, claim: true },
    login: 'browser',
    note: '华为云 CodeArts 免费额度。登录走浏览器回调（本机临时回调端口）。',
  },
  {
    id: 'lobsterai',
    displayName: 'LobsterAI (有道)',
    endpoint: 'https://lobsterai-server.youdao.com',
    kind: 'account',
    backend: 'ofm',
    credits: { balance: true, claim: true },
    login: 'browser',
    note: '签到需要客户端版本号，由后端自行解析（带缓存）。',
  },
  {
    id: 'qoder',
    displayName: 'Qoder',
    endpoint: 'https://api2-v2.qoder.sh',
    kind: 'account',
    backend: 'ofm',
    credits: { balance: true, claim: true },
    login: 'browser',
    note: '设备码轮询登录（不开本机回调端口），当日额度按「账号 × 模型」记。',
  },
  {
    id: 'qodercn',
    displayName: 'Qoder (中国版)',
    endpoint: 'https://gateway.qoder.com.cn',
    kind: 'account',
    backend: 'ofm',
    credits: { balance: true, claim: true },
    login: 'browser',
    note: '与 Qoder 国际版同协议、不同域名与客户端 id；两站账号互不通用。',
  },
  {
    id: 'trae',
    displayName: 'TRAE (字节)',
    endpoint: 'https://trae-api-cn.mchost.guru',
    kind: 'account',
    backend: 'ofm',
    credits: { balance: true, claim: true },
    login: 'browser',
    note: '签到是设备维度的：同一天换设备签名会被上游拒（后端会自动轮换 generation）。',
  },
  {
    id: 'cline',
    displayName: 'Cline',
    endpoint: 'https://api.cline.bot',
    kind: 'account',
    backend: 'ofm',
    credits: { balance: true, claim: true },
    login: 'browser',
    note: 'WorkOS 设备码登录，鉴权头带不可剥的 workos: 前缀。',
  },
  {
    id: 'loomy',
    displayName: 'Loomy (讯飞)',
    endpoint: 'https://loomyad.xunfei.cn/api/v1',
    kind: 'account',
    backend: 'ofm',
    credits: { balance: true, claim: true },
    login: 'localPage',
    smsFallback: true,
    note: '弹窗是本机登录页（内含微信二维码）。手机号验证码是备用路径，本页也提供。',
  },
  {
    id: 'raccoon',
    displayName: 'Raccoon (商汤)',
    endpoint: 'https://xiaohuanxiong.com',
    kind: 'account',
    backend: 'ofm',
    credits: { balance: true, claim: true },
    login: 'localPage',
    note: '弹窗是本机登录页：可选微信扫码或短信。凭据可静默续期。',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax Code',
    endpoint: 'https://agent.minimax.cn',
    kind: 'account',
    backend: 'ofm',
    credits: { balance: true, claim: true },
    login: 'browser',
    note: 'OAuth 设备码 + PKCE。查积分读取的是签到面板，可读性由后端归一。',
  },
  {
    id: 'gemini',
    displayName: 'Gemini Code Assist',
    endpoint: 'https://cloudcode-pa.googleapis.com',
    kind: 'account',
    backend: 'ofm',
    credits: { balance: true, claim: false, claimNote: NO_CLAIM_GEMINI },
    login: 'browser',
    note: '只做 OAuth（Cloud Code 项目制）。免费线没有签到接口，故不渲染「领取」。',
  },
  {
    id: 'zcode',
    displayName: 'ZCode (智谱)',
    endpoint: 'https://api.z.ai/api/anthropic',
    kind: 'account',
    backend: 'ofm',
    credits: { balance: true, claim: true },
    login: 'browser',
    note: 'Anthropic Messages 协议 + 按需 captcha。凭据是静态的（无 refresh）。',
  },
])

/** 本插件**自己挂载**的账号车道（其余在 OFM 侧）。 */
export const NATIVE_LANE_IDS = Object.freeze(['buddy', 'workbuddy'])

/** 按 id 取一条 OFM 侧的账号车道。 */
export function ofmLaneById(id) {
  return OFM_LANES.find((lane) => lane.id === id)
}

/** 11 条车道的 id（供 /summary 与测试断言用）。 */
export function ofmLaneIds() {
  return OFM_LANES.map((lane) => lane.id)
}

/**
 * 宿主 channel-pack RPC 的路径（connection.fetch.register 注册的那一条）。
 *
 * ⚠️ 值来自 OFM 的 channel-pack-rpc.ts:CHANNEL_PACK_API_PATH；改这里必须同步改
 * 那边 —— 但**页面不硬编码它**：本插件只把车道元数据发给页面，页面用 client.js
 * 里同一个常量名（OFM_RPC）。两处不一致时表现为「登录按钮点了没反应」，
 * 故两边注释互相指向。
 */
export const OFM_RPC_PATH = '/api/channel-pack'

/** OFM RPC 信封里的通道名（channel-pack-rpc.ts:CHANNEL_PACK_ENDPOINT）。 */
export const OFM_RPC_ENDPOINT = 'channel-pack'

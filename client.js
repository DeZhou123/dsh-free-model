/**
 * dsh-free-model — 浏览器半身。
 *
 * ## 一个设置项，页内两个页签
 *
 * 侧边栏只有一行「免费模型」（`settings.section` id `free-model`，order 37）；
 * 进去之后是**页内页签**（与 OFM 的页内 `ofm_tabs` 同构）：
 *
 * | 页签 | 内容 |
 * |---|---|
 * | 账号渠道 | CodeBuddy / WorkBuddy —— **账号型**车道 |
 * | OpenCode 免费层 | 本地**服务型**车道：不登录、不要账号 |
 *
 * ### 为什么不拆成两个导航项
 *
 * 侧边栏是「系统功能」的层级，而免费模型**是一个功能**；两条车道之间的切换又是
 * 高频动作（看一眼余额 → 顺手把本地服务开起来），页内切换比「退出设置 → 找另一个
 * 导航项 → 再进来」少三次点击。页签上的数字（账号数 / 模型数）由各页**自己上报**，
 * 外壳不重复请求一遍接口。
 *
 * ### 为什么不能挤在一屏里（更早的版本）
 *
 * 「账号卡」与「本地进程卡」看起来像同一类东西，而它们要回答的问题完全不同：
 *
 * - 账号车道：**有哪些号、还剩多少积分、今天领了没、哪个要重建**；
 * - 服务车道：**本机进程在不在跑、端口多少、模型目录拉到没有**。
 *
 * 分成两个页签之后，同一时刻屏幕上只有一个主题。
 *
 * ## 账号页的信息架构（对齐 OFM 的渠道卡）
 *
 * 每张卡从上到下：渠道名 + 能力徽章 + 路由归属 + 账号计数 → 端点 →
 * **汇总行（账号 / 模型 / 剩余积分）** → 动作行（新建账号 / 全部续期 /
 * 刷新余额 / 一键领取）→ 页签（账号 / 模型）→ 内容区。
 *
 * 账号行逐条显示**有效期、限流标记、今日已领、剩余积分**；动作按钮按**产品能力**
 * 渲染 —— WorkBuddy 国际版没有签到接口，那条卡上就不会出现「领取」，
 * 而不是给一个点了就报 404 的灰按钮。
 *
 * ## 页头的「每日自动领积分」开关
 *
 * 与 OFM 的 usage.autoCheckin 同形：一个总开关、一天只跑一次、状态里带上次结果。
 * 但它写的是**本插件自己的状态文件**（见 src/auto-checkin.js 的说明）——
 * 与 OFM 共用一份会把对方的「今天已跑」标记抹掉。
 *
 * ## 写法约束（照抄 OFM 与 model-orchestrator 的既有取舍）
 *
 * - 手写 ModuleLoader bundle：无构建步骤；
 * - 只依赖 shell 已提供的 react，不 import Harness Client 包
 *   （它们的 API 会随版本移动，抛错的组件会让整个槽位变白）；
 * - 颜色全走主题变量（--dsw-alias-*），切换配色不会花；
 * - 组件一律 \`function\` 声明（有提升）：Switch/Pill/Button 曾经被写成 const
 *   箭头函数放在页面之后，渲染时直接白屏。
 *
 * @module client
 */

window.__ModuleLoader__.load({
  // 必须等于包名：Client Loader 以包名作为 graph row 的 id 来认领注册，
  // 写短名会让它认为“加载了却没注册”，于是回退到单包 URL 再执行一次，
  // 第二次执行撞上重复注册 → Renderer boot failed。
  id: 'dsh-free-model',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const NS = 'settings.freeModel'
    /** 页内页签的记忆键（与 OFM 的 `ofm:tab` 同一手法，各插件各存一份）。 */
    const TAB_KEY = 'free-model:tab'
    const API = '/api/free-model'

    const zh = {
      nav: '免费模型',
      navAccounts: '账号渠道',
      title: '免费模型总台',
      intro: '三条不花钱的车道：CodeBuddy、WorkBuddy 账号通道，加本机 OpenCode 免费层。不需要 dsh-our-free-model，装了则自动共享账号池。',
      laneReady: '就绪',
      laneNeedsAction: '需动作',
      laneDown: '不可用',
      capFull: '完整能力',
      capText: '无工具',
      capFullHint: '可调用工具、可看图，能当主模型用。',
      capTextHint: '不能调用工具（OpenCode 的接口不接受外部工具定义），但**能看图**。适合会话标题、压缩摘要、翻译改写、识图；别在 agent 会话里选它。',
      opencodeTitle: 'OpenCode 本地车道',
      opencodeIntro: '本机 opencode serve 提供的免费模型。插件可代你启动服务，也可用你自己已开的实例。',
      opencodeStart: '启动服务',
      opencodeStop: '停止服务',
      opencodeRefresh: '刷新目录',
      opencodeRunning: '服务运行中',
      opencodeStopped: '服务未运行',
      opencodeManaged: '本插件启动',
      opencodeExternal: '你已手动启动',
      opencodeModels: '个模型',
      opencodeEmpty: '服务已启动但没读到模型。目录读的是 /config/providers —— 只有在本机 opencode 里配置过的 provider 才会出现，空目录说明一个都没配。',
      opencodeNote: '首次启动约 2–5 秒；端口被占用会自动顺延。目录只列**已配置可调用**的模型。',
      opencodeVision: '{count} 个可看图',
      opencodeProviders: '按 provider',
      opencodeSse: '流式：SSE',
      opencodeSseOff: '流式：轮询（降级）',
      // ⚠️ 三种失败处置完全不同，徽章必须分开（2026-10-24 补）：
      //   身份拒绝 = build 级事实，重试永不恢复；额度耗尽 = 按天重置（北京 08:00）；
      //   限流 = 等一两分钟。原先只有一个「上游拒绝」徽章，于是额度用完会被说成
      //   「结构性拒绝、换通道或升级 build」—— 方向完全错了。
      opencodeBlocked: '上游拒绝',
      opencodeBlockedHint: '这台机器上 OpenCode 免费层被上游拒绝（403 FreeTierError：只接受 OpenCode 客户端自身的请求）。换 ofm/* 那些模型，或更新 opencode。',
      opencodeQuota: '额度用尽·08:00 恢复',
      opencodeQuotaHint: 'Opencode 免费层的**当日额度**已用完（按天重置，北京时间 08:00 / UTC 00:00 恢复）。在此之前重试与换同池其它 *-free 模型通常都无效；要立刻干活请换通道。',
      opencodeRateLimited: '限流',
      opencodeRateLimitedHint: 'OpenCode 上游限流：等一两分钟再试，或换一个模型。这条与「额度用尽」不同 —— 它是短时的。',
      opencodeStale: '（上次运行）',
      product: '渠道',
      accounts: '账号',
      addAccount: '新建账号',
      refresh: '刷新',
      enabled: '启用',
      disabled: '已停用',
      enable: '启用',
      disable: '停用',
      renew: '续期',
      remove: '删除',
      credits: '查积分',
      checkin: '领积分',
      probe: '探测',
      expiresAt: '有效期',
      noExpiry: '未知',
      expired: '已过期',
      expiringSoon: '即将过期',
      refreshable: '可续期',
      notRefreshable: '不可续期',
      rateLimited: '限流中',
      empty: '还没有账号。点「新建账号」会打开浏览器登录页。',
      poolAbsent: '账号池不可用（宿主未提供 accountPool）。',
      poolHost: '账号池：OFM 共享池',
      poolLocal: '账号池：本地退化实现',
      routeOwned: '本插件接管',
      routeYielded: 'OFM 内置通道在跑',
      routeAbsent: '未挂载',
      yieldNote: 'OFM 仍持有这两条路由（说明你还停在 2.5.7）。账号与凭据是同一份，功能不受影响；升级到 2.5.8 后由本插件接管。',
      loginPending: '已打开浏览器，请完成登录…',
      loginDone: '登录成功',
      loginFailed: '登录失败',
      probeOk: '可用',
      probeFail: '失败',
      busy: '处理中…',
      error: '出错了',
      models: '模型',
      modelsHint: '这里的开关与 OFM 的模型黑名单是同一份数据：关掉的模型不出现在模型选择器里，但已保存的会话仍能调用它。',
      modelOn: '已开',
      modelOff: '已关',
      showOff: '显示已关',
      allOff: '全部关闭',
      allOn: '全部开启',
      reset: '全部恢复',
      ctx: '上下文',
      effort: '思考档位',
      vision: '看图',
      noModels: '读不到模型目录（远端未返回，且没有兜底表）。',
      tabAccounts: '账号',
      tabModels: '模型',
      // ── 积分 ──
      balance: '剩余积分',
      balanceLoading: '余额查询中…',
      balanceNone: '查不到余额',
      balanceRefresh: '刷新余额',
      balanceFailed: '余额查询失败',
      balancePartial: '{count} 个账号没能查到余额，展开账号行看原因。',
      balanceNoApi: '该车道没有积分接口',
      claim: '一键领取',
      claimRun: '领取中…',
      claimNone: '今天没有可领取的积分',
      claimDone: '已领取 {count} 个账号，共 +{credit} 积分',
      claimAlready: '{count} 个账号今天已领过',
      claimFailed: '{count} 个账号领取失败',
      claimUnsupported: 'WorkBuddy 国际版没有签到接口（其后端不提供），这条车道不会出现「领取」。',
      todayGot: '今日 +{credit}',
      streak: '连签 {days} 天',
      noCreditsApi: '这条车道没有积分接口',

      // ── 自动领积分 ──
      autoTitle: '每日自动领积分',
      autoRunning: '领取中…',
      autoRan: '今日已自动领取',
      autoOff: '今日尚未领取',
      autoLast: '上次结果：{result}',
      autoRunNow: '立即领取',
      autoEnabled: '已开启每日自动领积分',
      autoDisabled: '已关闭每日自动领积分',
      autoDisabledShort: '已关闭',
      autoHint: '开关对账号车道生效：CodeBuddy 有签到接口，WorkBuddy 没有（自动领取时跳过它）。状态存在 channel-pack/free-model-auto-checkin.json，与 OFM 的开关互不影响。',

      // ── 车道页 ──
      // ── OFM 侧车道（11 条）与后端 ──
      backendNative: '后端：本插件',
      routeOfm: 'OFM 提供',
      backendOfm: '后端：OFM',
      backendMissing: '后端未就绪',
      backendOfmNote: '这条车道的登录、续期、积分与模型开关由宿主的 dsh-our-free-model（channel-pack）提供；本页直接调它的 RPC，账号与凭据仍是同一份。',
      backendMissingNote: '没检测到 dsh-our-free-model（channel-pack）后端：车道能看，但登录 / 续期 / 积分要先装它（本页的操作按钮此时不渲染）。',
      capUnknownHint: '这条车道由 OFM 侧提供；能力的权威说明在它的产品定义里，本页不重复断言。',
      ofmLoginOpening: '已打开登录页，请完成授权…',
      ofmLoginWaiting: '等待授权（最长 4 分钟）…',
      ofmLoginTimeout: '等待超时：授权似乎没有完成。可再点一次「新建账号」。',
      ofmLoginTitle: '登录',
      smsPhone: '手机号',
      smsCode: '验证码',
      smsOpen: '用手机号登录',
      smsSend: '发送验证码',
      smsSent: '验证码已发送',
      smsSubmit: '提交并登录',
      smsHint: '备用路径：默认是弹窗里的微信扫码；手机号验证码仅在扫码不可用时使用。',
      ofmCallFailed: 'OFM 后端调用失败',
      noteLabel: '说明',
      localWhy: '这条车道单独一页：它的失败点与账号车道完全不同（二进制在不在、端口被占、serve 版本太旧），排错时不该和「账号要不要重新登录」混在一起看。',
      renewalNote: '续期只换令牌，不动账号索引；凭据写入仍然是宿主那一份。',

      // ── 三页签 / 顶部状态条 / 自带 key / 本地与网关（2026-10-25 夜间新增）──────
      //
      // ⚠️ `navLocal` / `localTitle` / `localIntro` / `renewAll` 早先**只有引用没有词条**，
      // 缺失时页面会直接把 key 名当正文显示（`navLocal` 就是这么露出来的）。
      // 这里补齐 —— 缺词条不是「显示英文」，是「显示变量名」。
      navLocal: '本地与网关',
      navKeyed: '自带 key',
      localTitle: '本地与网关',
      localIntro: '跑在本机的免费入口：OpenCode 免费层，加上别处注册进来的本地网关。这一页只回答「进程在不在、能不能用」，不涉及登录，也不涉及积分。',
      renewAll: '全部续期',
      stateReady: '就绪',
      stateNeeds: '需动作',
      stateDown: '不可用',
      stateUnknown: '未知',
      capVision: '能看图',
      capUnknown: '未知能力',

      // 顶部常驻状态条（渠道目录 / 插件版本）
      catTitle: '渠道目录',
      catCheck: '检查目录',
      catChecking: '检查中…',
      catVersion: 'v{version}',
      catCounts: '远程 {remote} 条 · 本地 {local} 条 · 自带 key {keyed} 条',
      catReason: '为什么没拿到：',
      catLocalFile: '本地覆盖文件',
      catUnwired: '渠道目录层未接线',
      updTitle: '插件',
      updCheck: '检查更新',
      updChecking: '检查中…',
      updNew: '有新版本 {latest}',
      updCurrent: '当前 v{current}',
      updFresh: '已是最新（v{current}）',
      updReason: '版本检查没成功：',
      updInstall: '升级（复制命令自己执行，本页不代跑）',
      updRepo: '仓库',
      updChangelog: '更新日志',
      fetchedAt: '拉取于',
      reasonLabel: '原因',

      // 第三页：自带 key
      keyedTitle: '自带 key 的免费渠道',
      keyedIntro: '注册即送额度、或有免费层的 OpenAI 兼容端点。有 key 就能用；没 key 时这一页只回答「去哪拿 key」，不放点了必然失败的按钮。',
      keyedEmpty: '暂无自带 key 渠道（渠道目录里可以随时加）',
      keyedEmptyHint: '渠道目录是三层叠加的：随包 / 远程 / 本地覆盖文件。点上面的「检查目录」拉一次远程目录，或往本地覆盖文件里加一条。',
      keyedEnv: '凭据名',
      keyedGetKey: '去拿 key',
      keyedDocs: '文档',
      keyedFree: '免费额度',
      keyedUnknown: '未确证',
      keyedUnknownHint: '这条记录有字段没有实证（多半是免费额度的具体数值）；运行时以实时模型目录为准。',
      keyedNoTest: '这一页不提供「测试连通性」：没有 key 的车道点下去必然失败，只给「去哪拿 key」。',
      keyedModels: '{count} 个模型',

      // 第二页：本地与网关
      serviceProbe: '重新探测',
      serviceProbing: '探测中…',
      serviceWiredOff: '渠道注册表未接线：只显示 OpenCode 这一条内置车道。',
      serviceWhyGateway: '不在本页启动：由其它插件注册的网关（如 dsh-llm-pi-ai），路由不归本插件，这里只观测它的状态。',
      serviceWhyOther: '不在本页启动：这条车道没有可执行的启动方式，只能看状态。',
      serviceModels: '{count} 个模型',
      serviceEmpty: '没有服务型渠道。',
    }
    const en = {
      nav: 'Free models',
      navAccounts: 'Account lanes',
      title: 'Free model console',
      intro: 'Three lanes that cost nothing: CodeBuddy and WorkBuddy account lanes, plus the local OpenCode free tier. dsh-our-free-model is optional — when present, the account pool is shared.',
      laneReady: 'Ready',
      laneNeedsAction: 'Needs action',
      laneDown: 'Down',
      capFull: 'Full',
      capText: 'No tools',
      capFullHint: 'Tool calling and images work; safe as a primary model.',
      capTextHint: 'No tool calling (the OpenCode API accepts no external tool definitions), but images work. Good for titles, compaction summaries, translation, image Q&A; do not pick it inside an agent session.',
      opencodeTitle: 'OpenCode local lane',
      opencodeIntro: 'Free models served by a local opencode server. The plugin can start it for you, or reuse one you already run.',
      opencodeStart: 'Start server',
      opencodeStop: 'Stop server',
      opencodeRefresh: 'Refresh catalog',
      opencodeRunning: 'Server running',
      opencodeStopped: 'Server stopped',
      opencodeManaged: 'Started by this plugin',
      opencodeExternal: 'Started by you',
      opencodeModels: 'models',
      opencodeEmpty: 'Server is up but returned no models. The catalog is read from /config/providers, so only providers configured in the local opencode appear here; an empty list means none are configured.',
      opencodeNote: 'First start takes ~2–5s; ports shift automatically when taken. The catalog lists only configured, callable models.',
      opencodeVision: '{count} can see images',
      opencodeProviders: 'By provider',
      opencodeSse: 'Streaming: SSE',
      opencodeSseOff: 'Streaming: polling (fallback)',
      opencodeBlocked: 'Upstream refused',
      opencodeBlockedHint: 'On this machine the OpenCode free tier is refused upstream (403 FreeTierError: only OpenCode itself may call it). Switch to ofm/* models, or update opencode.',
      opencodeQuota: 'Daily quota used · resets 08:00',
      opencodeQuotaHint: 'The daily free quota is used up. It resets by day at 08:00 Beijing time (UTC 00:00). Retrying, or switching to another *-free model in the same pool, usually will not help until then — switch lanes instead.',
      opencodeRateLimited: 'Rate limited',
      opencodeRateLimitedHint: 'Upstream is rate limiting: wait a minute or two, or switch models. This is short-lived, unlike the daily quota.',
      opencodeStale: '(from last run)',
      product: 'Lane',
      accounts: 'Accounts',
      addAccount: 'New account',
      refresh: 'Refresh',
      enabled: 'Enabled',
      disabled: 'Disabled',
      enable: 'Enable',
      disable: 'Disable',
      renew: 'Renew',
      remove: 'Remove',
      credits: 'Credits',
      checkin: 'Claim',
      probe: 'Probe',
      expiresAt: 'Expires',
      noExpiry: 'unknown',
      expired: 'expired',
      expiringSoon: 'expiring soon',
      refreshable: 'renewable',
      notRefreshable: 'not renewable',
      rateLimited: 'rate limited',
      empty: 'No accounts yet. “New account” opens the browser sign-in page.',
      poolAbsent: 'Account pool unavailable (the host did not provide accountPool).',
      poolHost: 'pool: shared with OFM',
      poolLocal: 'pool: local fallback',
      routeOwned: 'served by this plugin',
      routeYielded: 'served by OFM built-in',
      routeAbsent: 'not mounted',
      yieldNote: 'OFM still owns these routes (you are on 2.5.7). Accounts and credentials are the same data, so nothing changes; after upgrading to 2.5.8 this plugin takes over.',
      loginPending: 'Browser opened — finish signing in…',
      loginDone: 'Signed in',
      loginFailed: 'Sign-in failed',
      probeOk: 'usable',
      probeFail: 'failed',
      busy: 'working…',
      error: 'Something went wrong',
      models: 'Models',
      modelsHint: 'These switches share the same blacklist as OFM: a disabled model leaves the picker, while saved sessions can still call it.',
      modelOn: 'on',
      modelOff: 'off',
      showOff: 'show off',
      allOff: 'Disable all',
      allOn: 'Enable all',
      reset: 'Reset',
      ctx: 'context',
      effort: 'effort',
      vision: 'vision',
      noModels: 'No catalog available (upstream returned nothing and there is no fallback table).',
      tabAccounts: 'Accounts',
      tabModels: 'Models',
      balance: 'Credits left',
      balanceLoading: 'Querying balance…',
      balanceNone: 'no reading',
      balanceRefresh: 'Refresh balance',
      balanceFailed: 'Balance query failed',
      balancePartial: 'Could not query {count} account(s); expand the rows to see why.',
      balanceNoApi: 'this lane has no credits API',
      claim: 'Claim all',
      claimRun: 'Claiming…',
      claimNone: 'Nothing to claim today',
      claimDone: 'Claimed for {count} account(s), +{credit} credits',
      claimAlready: '{count} account(s) already claimed today',
      claimFailed: '{count} account(s) failed to claim',
      claimUnsupported: 'WorkBuddy (intl) has no check-in endpoint, so this lane never shows “Claim”.',
      todayGot: 'today +{credit}',
      streak: '{days}-day streak',
      noCreditsApi: 'this lane has no credits API',

      autoTitle: 'Daily auto check-in',
      autoRunning: 'Check-in running…',
      autoRan: 'Checked in today',
      autoOff: 'Not checked in today',
      autoLast: 'Last result: {result}',
      autoRunNow: 'Check in now',
      autoEnabled: 'Daily auto check-in enabled',
      autoDisabled: 'Daily auto check-in disabled',
      autoDisabledShort: 'off',
      autoHint: 'Applies to the account lanes: CodeBuddy has a check-in API, WorkBuddy does not (it is skipped). State lives in channel-pack/free-model-auto-checkin.json, independent of the OFM switch.',

      backendNative: 'backend: this plugin',
      routeOfm: 'provided by OFM',
      backendOfm: 'backend: OFM',
      backendMissing: 'backend not ready',
      backendOfmNote: 'Sign-in, renewal, credits and model switches for this lane come from the host dsh-our-free-model (channel-pack). This page calls its RPC directly; the accounts and credentials are still the same copy.',
      backendMissingNote: 'No dsh-our-free-model (channel-pack) backend detected: the lane is listed, but sign-in / renewal / credits need it installed (action buttons are hidden meanwhile).',
      capUnknownHint: 'This lane is provided by OFM; its product definition is the authority on capabilities, and this page does not restate them.',
      ofmLoginOpening: 'Sign-in page opened — finish the authorization…',
      ofmLoginWaiting: 'Waiting for authorization (up to 4 minutes)…',
      ofmLoginTimeout: 'Timed out: the authorization does not look finished. Press “New account” again.',
      ofmLoginTitle: 'Sign in',
      smsPhone: 'Phone',
      smsCode: 'Code',
      smsOpen: 'Sign in with phone',
      smsSend: 'Send code',
      smsSent: 'Code sent',
      smsSubmit: 'Submit and sign in',
      smsHint: 'Fallback path: the default is the WeChat QR inside the popup; the phone code is only for when scanning is unavailable.',
      ofmCallFailed: 'OFM backend call failed',
      noteLabel: 'Note',
      localWhy: 'This lane has its own page because its failure modes are completely different (missing binary, port taken, old serve build) — debugging it should not be mixed up with “does an account need to sign in again”.',
      renewalNote: 'Renewal only swaps tokens; the account index and the credential store stay the same.',

      // ── Three tabs / status bar / keyed / local+gateway (2026-10-25) ──────────
      navLocal: 'Local & gateways',
      navKeyed: 'Own keys',
      localTitle: 'Local & gateways',
      localIntro: 'Free entry points running on this machine: the OpenCode free tier plus any local gateway registered elsewhere. This page answers only “is the process up and usable” — no sign-in, no credits.',
      renewAll: 'Renew all',
      stateReady: 'Ready',
      stateNeeds: 'Needs action',
      stateDown: 'Down',
      stateUnknown: 'Unknown',
      capVision: 'Vision',
      capUnknown: 'Unknown capability',

      catTitle: 'Channel catalog',
      catCheck: 'Check catalog',
      catChecking: 'Checking…',
      catVersion: 'v{version}',
      catCounts: 'remote {remote} · local {local} · own-key {keyed}',
      catReason: 'Why it failed: ',
      catLocalFile: 'Local override file',
      catUnwired: 'Catalog layer not wired',
      updTitle: 'Plugin',
      updCheck: 'Check update',
      updChecking: 'Checking…',
      updNew: 'New version {latest}',
      updCurrent: 'current v{current}',
      updFresh: 'Up to date (v{current})',
      updReason: 'Update check failed: ',
      updInstall: 'Upgrade (copy the command and run it yourself; this page never runs it)',
      updRepo: 'Repository',
      updChangelog: 'Changelog',
      fetchedAt: 'fetched',
      reasonLabel: 'Reason',

      keyedTitle: 'Free channels that use your own key',
      keyedIntro: 'OpenAI-compatible endpoints with signup credits or a free tier. With a key they work; without one this page only answers “where do I get the key” — no buttons that are guaranteed to fail.',
      keyedEmpty: 'No own-key channels yet (the channel catalog can add them any time)',
      keyedEmptyHint: 'The catalog stacks three layers: shipped / remote / local override file. Press “Check catalog” above to pull the remote layer, or add a record to the local file.',
      keyedEnv: 'Credential name',
      keyedGetKey: 'Get a key',
      keyedDocs: 'Docs',
      keyedFree: 'Free tier',
      keyedUnknown: 'unconfirmed',
      keyedUnknownHint: 'Some fields of this record have no evidence (usually the exact free-tier numbers); the live model catalog wins at runtime.',
      keyedNoTest: 'This page offers no “test connectivity”: a lane without a key would always fail, so it only points at “where to get the key”.',
      keyedModels: '{count} models',

      serviceProbe: 'Probe again',
      serviceProbing: 'Probing…',
      serviceWiredOff: 'Channel registry not wired: only the built-in OpenCode lane is shown.',
      serviceWhyGateway: 'Not startable here: the gateway is registered by another plugin (e.g. dsh-llm-pi-ai), its routes are not ours — this page only observes it.',
      serviceWhyOther: 'Not startable here: this lane exposes no start action, it can only be observed.',
      serviceModels: '{count} models',
      serviceEmpty: 'No service channels.',
    }

    async function call(path, body) {
      const response = await fetch(API + path, body === undefined
        ? { headers: { accept: 'application/json' } }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    /**
     * 宿主 channel-pack 的 RPC：路径、信封、拆包。
     *
     * ## 为什么页面直接调它，而不是经本插件的 Host 面转发
     *
     * 11 条 OFM 侧车道的登录 / 续期 / 积分 / 模型开关**全部**在宿主 channel-pack
     * 里（那里是它们的唯一实现）。在本插件的 Host 面再包一层转发，等于把 12 个方法
     * × 13 条车道各写一遍胶水，且每条车道的产品怪癖（device_mid、captcha、
     * 设备签名 generation…）都会在转发层再漂移一次。
     *
     * 页面本来就在同一个应用页里、拿着同一份会话：直接调它的 RPC 既短又准
     * （OFM 自己的 Channel Pack 面板就是这么调的）。
     *
     * ⚠️ 路径与通道名必须与 OFM 的 `channel-pack-rpc.ts:CHANNEL_PACK_API_PATH` /
     * `CHANNEL_PACK_ENDPOINT` 一致；本插件 Host 侧把同一对常量放在
     * `src/lanes.js`（那里的注释与这里互相指向）。不一致的表现是「点了没反应」。
     */
    const OFM_RPC = '/api/channel-pack'
    const OFM_ENDPOINT = 'channel-pack'
    let ofmRpcSeq = 0

    /**
     * 调一次宿主 RPC，返回 value；失败**抛错**（文案直接展示给用户）。
     *
     * 信封形状（OFM 侧 `connection.fetch.register` 的 handler 定义）：
     * 请求 `{type:'client-request', rpcId, method:'channel-pack', payload:{method, payload}}`，
     * 响应 `{type:'server-response', rpcId, result:{ok, value|error}}`。
     */
    async function ofmCall(method, payload) {
      ofmRpcSeq += 1
      const response = await fetch(OFM_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'free-model-' + ofmRpcSeq,
          method: OFM_ENDPOINT,
          payload: { method: method, payload: payload === undefined ? {} : payload },
        }),
      })
      const envelope = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + OFM_RPC)
      const result = envelope === undefined || envelope === null ? undefined : envelope.result
      if (result === undefined || result === null) throw new Error('channel-pack RPC 无 result: ' + method)
      if (result.ok === false) {
        const error = result.error === undefined || result.error === null ? {} : result.error
        throw new Error(typeof error.message === 'string' ? error.message : 'channel-pack RPC 失败: ' + method)
      }
      return result.value
    }

    function formatTime(ms, t) {
      if (typeof ms !== 'number' || ms <= 0) return t('noExpiry')
      const at = new Date(ms)
      const text = at.toLocaleString()
      if (ms <= Date.now()) return `${text}（${t('expired')}）`
      return text
    }

    /**
     * 一个模型行：名字 + 元数据 + 开关。
     *
     * 关掉的模型**照样列出**（只是变灰）—— 与 OFM 的 Channel Pack 面板同一条
     * 理由：不列出来用户就没法重新打开。
     */
    /**
     * 开关：与 OFM 的 `ofm_switch` 同一实现。
     *
     * 用 `<button role="switch">` + `<i>` 而不是 `<input type=checkbox>`：
     * 宿主主题给这条组合定义了完整的 on/off 视觉（含滑块位移与按压回弹），
     * 用原生 checkbox 会得到一个与整页不同世界的控件。
     */
    function Switch(props) {
      return h('button', {
        type: 'button',
        className: 'ow-switch',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        disabled: props.disabled === true,
        onClick: props.onChange,
      }, h('i'), props.label === undefined ? null : h('span', null, props.label))
    }

    /** 药丸：`tone` 给状态点着色（ok / warn / err）。 */
    function Pill(props) {
      return h('span', { className: `ow-pill${props.strong ? ' strong' : ''}` },
        props.tone === undefined ? null : h('span', { className: `ow-dot ${props.tone}` }),
        props.children)
    }

    /** 按钮：`kind` = 'primary' | 'danger'。 */
    function Button(props) {
      return h('button', {
        type: 'button',
        className: 'ow-btn' + (props.kind === undefined ? '' : ' ' + props.kind),
        disabled: props.disabled,
        onClick: props.onClick,
        title: props.title,
      }, props.children)
    }

    /**
     * 一个模型行：开关 + id + 元数据。
     *
     * 关掉的模型**照样列出**（只是变灰）—— 与 OFM 的 Channel Pack 面板同一条
     * 理由：不列出来用户就没法重新打开。
     */
    function ModelRow(props) {
      const { model, busy, onToggle, t } = props
      return h('li', { className: model.disabled ? 'ow-mrow off' : 'ow-mrow' }, [
        h('label', { key: 'l', className: 'ow-mlabel' }, [
          h(Switch, {
            key: 'c',
            checked: !model.disabled,
            disabled: busy,
            onChange: () => onToggle(!model.disabled),
          }),
          h('code', { key: 'id', className: 'ow-mid' }, model.id),
          // 展示名与 id 实质相同（如 hy3 / Hy3）时不再重复一遍，否则一行里出现两次。
          model.name.toLowerCase() !== model.id.toLowerCase()
            ? h('span', { key: 'n', className: 'ow-mname' }, model.name)
            : null,
        ]),
        h('div', { key: 'meta', className: 'ow-mmeta' }, [
          model.contextWindow !== null
            ? h('span', { key: 'ctx', className: 'ow-dim' }, `${t('ctx')} ${formatTokens(model.contextWindow)}`)
            : null,
          model.reasoningEfforts.length > 0
            ? h('span', { key: 'eff', className: 'ow-dim' }, `${t('effort')} ${model.reasoningEfforts.join('/')}`)
            : null,
          model.inputModalities.includes('image')
            ? h(Pill, { key: 'img', tone: 'ok' }, t('vision'))
            : null,
        ]),
      ])
    }

    /** 上下文窗口的可读写法：1 000 000 → 1M。 */
    function formatTokens(value) {
      if (typeof value !== 'number' || value <= 0) return '—'
      if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
      if (value >= 1000) return `${Math.round(value / 1000)}K`
      return String(value)
    }

    /** 一张渠道卡：标题 + 账号列表 + 每条的操作按钮。 */
    /**
     * 一张渠道卡：标题 + 页签 + 账号/模型两个面板。
     *
     * 布局与 OFM 的 `ChannelCard` 对齐：卡片头一行（名字、端点、状态药丸、
     * 计数），下面一条胶囊页签，再下面是内容区。所有控件都用本文件的
     * Switch / Pill / Button，不引入宿主其它组件（它们的 API 会随版本移动）。
     */
    /**
     * 余额徽章（与 OFM 的 \`ofm_creditbadge\` 同款）。
     *
     * 三种状态必须分辨得开：
     * - 正在查 → 「余额查询中…」（显示 0 会让用户以为额度用完了）；
     * - 查不到 → 显示**原因**（凭据失效 / 未返回数据），而不是 0 或 ——；
     * - 查到了 → 数值，悬浮显示资源包明细。
     */
    function BalanceBadge(props) {
      const { row, loading, t } = props
      if (loading) return h('span', { className: 'ow-dim' }, t('balanceLoading'))
      const total = row?.balance?.total
      if (!Number.isFinite(total)) {
        const reason = row?.error ?? t('balanceNone')
        return h('span', { className: 'ow-balerr', title: reason }, t('balance') + ' · ' + reason)
      }
      const packages = (row.balance.packages ?? [])
        .map((pkg) => pkg.name + ' ' + formatAmount(pkg.remaining))
        .join(' · ')
      return h('span', {
        className: 'ow-bal',
        title: packages.length > 0 ? packages : t('balance'),
      }, t('balance') + ' ' + formatAmount(total))
    }

    /**
     * 一张账号车道卡（布局与 OFM 的 ChannelCard 对齐）。
     *
     * 从上到下四段各有分工：
     * - 头行：这是谁、能干什么（能力徽章）、路由归谁、几个号；
     * - 汇总行：账号 / 模型 / **剩余积分** —— 「现在值不值得用它」一屏答完；
     * - 动作行：新建账号 / 全部续期 / 刷新余额 / 一键领取；
     * - 页签：账号（带余额与今日已领）与模型（黑名单开关）。
     *
     * 动作按钮**按产品能力渲染**：WorkBuddy 国际版没有签到接口，那张卡上不会
     * 出现「一键领取」，而不是给一个点了必然 404 的灰按钮。
     */
    function ProductCard(props) {
      const {
        product, accounts, models, creditRow, balanceLoading, tab, onTab, busy, claimBusy, t,
        onAction, onModelAction, onLogin, onClaimAll, onRefreshBalances, onRenewAll,
        // OFM 侧车道多带四个字段：
        //   ready       —— 后端是否就绪（未就绪则一个动作按钮都不渲染）
        //   backendNote —— 后端说明（页面上要能解释「为什么按钮不见 / 为什么能在这里管」）
        //   sms*        —— 只有 Loomy 有的手机号备用路径
        ready = true, backendNote, balanceNote, rowClaim = true,
        sms, onSmsOpen, onSmsChange, onSmsSend, onSmsSubmit,
      } = props
      const isOfm = product.backend === 'ofm'
      const [showOff, setShowOff] = useState(false)
      const capability = product.credits ?? { balance: false, claim: false }
      const enabledAccounts = accounts.filter((account) => account.enabled).length
      const offCount = models.filter((model) => model.disabled).length
      const onCount = models.length - offCount
      const list = showOff ? models : models.filter((model) => !model.disabled)

      // 路由归属决定状态点：本插件接管 = ok，OFM 内置在跑 = warn。
      // OFM 侧车道单列一档：它们**本来**就由宿主提供，说「未挂载」会误导；
      // 后端没跑时才是真的不可用（err）。
      const routeTone = isOfm
        ? (ready ? 'ok' : 'err')
        : product.route === 'registered' ? 'ok' : product.route === 'yielded' ? 'warn' : undefined
      const routeText = isOfm
        ? (ready ? t('routeOfm') : t('backendMissing'))
        : product.route === 'registered' ? t('routeOwned')
          : product.route === 'yielded' ? t('routeYielded') : t('routeAbsent')

      const rows = creditRow?.accounts ?? []
      const known = rows.filter((row) => Number.isFinite(row.balance?.total))
      const failures = rows.length - known.length
      const total = known.reduce((sum, row) => sum + row.balance.total, 0)

      return h('div', { className: 'ow-card' }, [
        h('div', { key: 'head', className: 'ow-cardhead' }, [
          h('strong', { key: 'n' }, product.displayName),
          h(Pill, { key: 'cap', tone: 'ok' }, t('capFull')),
          h(Pill, { key: 'r', tone: routeTone, strong: true }, routeText),
          // 后端药丸只给 OFM 侧车道：native 两条说「后端：本插件」是废话。
          isOfm
            ? h(Pill, { key: 'bk', tone: ready ? undefined : 'err', strong: true },
                ready ? t('backendOfm') : t('backendMissing'))
            : null,
          h('span', { key: 'c', className: 'ow-count' },
            enabledAccounts + '/' + accounts.length + ' ' + t('accounts')),
        ]),
        h('code', { key: 'ep', className: 'ow-ep' }, product.endpoint),
        h('p', { key: 'caphint', className: 'ow-hint' }, isOfm ? t('capUnknownHint') : t('capFullHint')),
        // 车道的产品说明（来源见 src/lanes.js 的注册表：每条都写明该渠道的坑）。
        typeof product.note === 'string' && product.note.length > 0
          ? h('p', { key: 'lnote', className: 'ow-hint' }, t('noteLabel') + '：' + product.note)
          : null,
        // 后端说明：能在这里管这条车道（ready）与为什么按钮全不见（!ready）都要说清。
        typeof backendNote === 'string' && backendNote.length > 0
          ? h('p', { key: 'bnote', className: 'ow-hint' }, backendNote)
          : null,

        h('div', { key: 'sum', className: 'ow-chanmeta' }, [
          h('span', { key: 'a' }, t('accounts') + ' ', h('b', null, enabledAccounts + '/' + accounts.length)),
          h('span', { key: 'm' }, t('models') + ' ',
            h('b', null, models.length === 0 ? '—' : onCount + '/' + models.length)),
          capability.balance === true
            ? h('span', { key: 'b', className: 'ow-sum' }, t('balance') + ' ',
                h('b', null, balanceLoading || creditRow === undefined ? '…'
                  : known.length === 0 ? '—' : formatAmount(total)))
            : null,
        ]),

        // ⚠️ 后端未就绪时**不渲染**动作行：给一个点了必然失败的按钮，
        // 用户的下一步动作是「反复点它」而不是「去装后端」。
        ready ? h('div', { key: 'acts', className: 'ow-actions' }, [
          h(Button, { key: 'add', kind: 'primary', disabled: busy, onClick: onLogin }, t('addAccount')),
          accounts.length > 0
            ? h(Button, { key: 'rn', disabled: busy, onClick: onRenewAll, title: t('renewalNote') }, t('renewAll'))
            : null,
          capability.balance === true
            ? h(Button, { key: 'rb', disabled: busy || balanceLoading, onClick: onRefreshBalances },
                balanceLoading ? t('balanceLoading') : t('balanceRefresh'))
            : null,
          capability.claim === true
            ? h(Button, { key: 'cl', disabled: busy || claimBusy, onClick: onClaimAll },
                claimBusy ? t('claimRun') : t('claim'))
            : null,
        ]) : null,

        // 手机号登录（只有 Loomy 有这条备用路径）：未展开时是一个按钮，
        // 展开后是「手机号 + 发码 + 验证码 + 提交」四件套。
        ready && product.smsFallback === true
          ? h('div', { key: 'sms', className: 'ow-sms' }, sms === undefined
            ? h(Button, { key: 'o', disabled: busy, onClick: onSmsOpen }, t('smsOpen'))
            : [
                h('span', { key: 'h', className: 'ow-hint' }, t('smsHint')),
                h('input', {
                  key: 'p', className: 'ow-input', type: 'tel', placeholder: t('smsPhone'),
                  value: sms.phone ?? '', onChange: (event) => onSmsChange({ phone: event.target.value }),
                }),
                h(Button, {
                  key: 's', disabled: busy || sms.busy === true || (sms.phone ?? '').length === 0,
                  onClick: onSmsSend,
                }, t('smsSend')),
                h('input', {
                  key: 'c', className: 'ow-input', inputMode: 'numeric', placeholder: t('smsCode'),
                  value: sms.code ?? '', onChange: (event) => onSmsChange({ code: event.target.value }),
                }),
                h(Button, {
                  key: 'b', kind: 'primary', disabled: busy || sms.busy === true || (sms.code ?? '').length === 0,
                  onClick: onSmsSubmit,
                }, t('smsSubmit')),
                typeof sms.error === 'string' && sms.error.length > 0
                  ? h('span', { key: 'e', className: 'ow-note error' }, sms.error)
                  : null,
              ])
          : null,

        // 部分账号查不到余额时**明说**：否则卡片上的合计数看起来像「余额掉了」。
        creditRow !== undefined && failures > 0
          ? h('p', { key: 'berr', className: 'ow-balerr-line', role: 'status' },
              t('balancePartial').replace('{count}', String(failures)))
          : null,
        // 车道级余额失败（OFM 侧）：把后端给的原因原样显示 —— 藏进日志等于让用户猜。
        typeof balanceNote === 'string' && balanceNote.length > 0
          ? h('p', { key: 'bnerr', className: 'ow-balerr-line', role: 'status' }, balanceNote)
          : null,

        h('div', { key: 'tabs', className: 'ow-tabs' }, [
          h('button', {
            key: 'a', type: 'button', className: tab === 'accounts' ? 'ow-tab on' : 'ow-tab',
            onClick: () => onTab('accounts'),
          }, t('tabAccounts')),
          h('button', {
            key: 'm', type: 'button', className: tab === 'models' ? 'ow-tab on' : 'ow-tab',
            onClick: () => onTab('models'),
          }, models.length > 0 ? t('tabModels') + ' ' + onCount + '/' + models.length : t('tabModels')),
        ]),

        tab === 'models'
          ? h('div', { key: 'mpane', className: 'ow-mpane' }, [
              h('p', { key: 'hint', className: 'ow-hint' }, t('modelsHint')),
              models.length === 0
                ? h('p', { key: 'none', className: 'ow-empty' }, t('noModels'))
                : h('div', { key: 'bar', className: 'ow-mbar' }, [
                    h(Button, { key: 'off', disabled: busy, onClick: () => onModelAction({ action: 'all', disabled: true }) }, t('allOff')),
                    h(Button, { key: 'on', disabled: busy, onClick: () => onModelAction({ action: 'all', disabled: false }) }, t('allOn')),
                    h(Button, { key: 'rs', disabled: busy, onClick: () => onModelAction({ action: 'reset' }) }, t('reset')),
                    offCount > 0
                      ? h('span', { key: 'sw', className: 'ow-mbar-sw' },
                          h(Switch, { checked: showOff, label: t('showOff'), onChange: () => setShowOff(!showOff) }),
                          h(Pill, null, String(offCount)))
                      : null,
                  ]),
              list.length > 0
                ? h('ul', { key: 'mlist', className: 'ow-mlist' }, list.map((model) => h(ModelRow, {
                    key: model.id,
                    model,
                    busy,
                    t,
                    onToggle: (enabled) => onModelAction({ action: 'toggle', model: model.id, disabled: !enabled }),
                  })))
                : null,
            ])
          : accounts.length === 0
            ? h('p', { key: 'empty', className: 'ow-empty' }, t('empty'))
            : h('ul', { key: 'list', className: 'ow-list' }, accounts.map((account) => {
                const row = rows.find((entry) => entry.accountId === account.id)
                const checkin = row?.checkin
                return h('li', { key: account.id, className: 'ow-row' }, [
                  h('div', { key: 'meta', className: 'ow-meta' }, [
                    h('strong', { key: 'n' }, account.nickname || account.id),
                    h(Pill, { key: 'e', tone: account.enabled ? 'ok' : undefined },
                      account.enabled ? t('enabled') : t('disabled')),
                    Object.keys(account.modelRateLimits ?? {}).length > 0
                      ? h(Pill, { key: 'l', tone: 'warn' }, t('rateLimited'))
                      : null,
                    h('span', { key: 'x', className: 'ow-dim' },
                      t('expiresAt') + ': ' + formatTime(account.expiresAt, t)),
                    account.refreshable ? null : h('span', { key: 'r', className: 'ow-dim' }, t('notRefreshable')),
                    checkin !== null && checkin !== undefined && checkin.todayCheckedIn === true
                      && Number.isFinite(checkin.todayCredit)
                      ? h(Pill, { key: 'tg', tone: 'ok' },
                          t('todayGot').replace('{credit}', formatAmount(checkin.todayCredit)))
                      : null,
                    checkin !== null && checkin !== undefined && Number.isFinite(checkin.streakDays) && checkin.streakDays > 0
                      ? h('span', { key: 'st', className: 'ow-dim' },
                          t('streak').replace('{days}', String(checkin.streakDays)))
                      : null,
                  ]),
                  h('div', { key: 'bal', className: 'ow-balrow' },
                    h(BalanceBadge, { row, loading: balanceLoading && row === undefined, t })),
                  h('div', { key: 'acts', className: 'ow-actions' }, [
                    h(Button, {
                      key: 't',
                      disabled: busy,
                      onClick: () => onAction({ action: account.enabled ? 'disable' : 'enable', id: account.id }),
                    }, account.enabled ? t('disable') : t('enable')),
                    h(Button, { key: 'r', disabled: busy, onClick: () => onAction({ action: 'refresh', id: account.id }) }, t('renew')),
                    h(Button, { key: 'c', disabled: busy, onClick: () => onAction({ action: 'credits', id: account.id }) }, t('credits')),
                    capability.claim === true && rowClaim
                      ? h(Button, { key: 'k', disabled: busy, onClick: () => onAction({ action: 'checkin', id: account.id }) }, t('checkin'))
                      : null,
                    h(Button, { key: 'p', disabled: busy, onClick: () => onAction({ action: 'probe', id: account.id }) }, t('probe')),
                    h(Button, { key: 'd', kind: 'danger', disabled: busy, onClick: () => onAction({ action: 'remove', id: account.id }) }, t('remove')),
                  ]),
                ])
              })),
      ])
    }

    /**
     * 「每日自动领积分」条。
     *
     * 与 OFM 的自动签到行同形：开关 + 状态药丸 + 上次结果 + 立即执行。
     * 状态药丸三态必须分辨得开 —— 「进行中」和「今天没领」在用户眼里是
     * 「等一下」与「去点一下」两种完全不同的动作。
     */
    function AutoCheckinBar(props) {
      const { state, busy, t, onToggle, onRunNow } = props
      const enabled = state?.enabled === true
      const tone = state?.running === true ? 'warn' : state?.ranToday === true ? 'ok' : undefined
      const text = state?.running === true ? t('autoRunning')
        : state?.ranToday === true ? t('autoRan') : t('autoOff')
      return h('div', { className: 'ow-auto' }, [
        h(Switch, { key: 'sw', checked: enabled, disabled: busy || state === undefined, label: t('autoTitle'), onChange: onToggle }),
        h(Pill, { key: 'p', tone, strong: true }, text),
        typeof state?.lastResult === 'string' && state.lastResult !== ''
          ? h('span', { key: 'l', className: 'ow-dim ow-auto-last', title: state.lastResult },
              t('autoLast').replace('{result}', state.lastResult))
          : null,
        h('span', { key: 'sp', className: 'ow-auto-sp' },
          h(Button, { disabled: busy || state === undefined, onClick: onRunNow }, t('autoRunNow'))),
      ])
    }

    /**
     * OpenCode 服务卡。
     *
     * 与账号卡**故意长得不一样**：这里没有「账号」这个概念，只有一个本地进程
     * 和它的模型目录。硬套账号卡会让用户以为要去登录什么。
     *
     * 三个状态点：
     * - 服务在跑 + 路由已挂 → ok
     * - 服务在跑但路由没挂 → warn（能修，但要去日志里看）
     * - 服务没跑 → err（点按钮即可）
     */
    function ServiceCard(props) {
      const { lane, status, models, busy, onStart, onStop, onRefresh, t } = props
      const running = status?.running === true
      const mounted = lane?.mounted === true
      const tone = !running ? 'err' : mounted ? 'ok' : 'warn'
      const stateText = !running ? t('opencodeStopped')
        : mounted ? t('opencodeRunning') : t('laneNeedsAction')
      // 失败按**类别**分：三种处置完全相反，混成一个「上游拒绝」会让用户走错方向。
      // 分类依据与 src/opencode/adapter.js 的判错链保持一致（见那边的注释）。
      const failures = status?.failures ?? {}
      const classifyFailure = (message) => {
        const text = String(message ?? '')
        if (/free usage limit|freeusagelimiterror|usage limit reached|subscribe to opencode go/i.test(text)) return 'quota'
        if (/free tier can only be used from within opencode/i.test(text)) return 'identity'
        if (/rate limit|429|too many requests/i.test(text)) return 'rateLimit'
        return 'other'
      }
      const failureKinds = new Set(Object.values(failures).map(classifyFailure))
      const blocked = failureKinds.has('identity')
      const quotaHit = failureKinds.has('quota')
      const rateLimited = failureKinds.has('rateLimit')
      // 三种都不属于时（other）仍旧把原因摆出来，只是不加判定的徽章。
      const anyFailure = Object.keys(failures).length > 0

      return h('div', { className: 'ow-card' }, [
        h('div', { key: 'head', className: 'ow-cardhead' }, [
          h('strong', { key: 'n' }, t('opencodeTitle')),
          h(Pill, { key: 'cap', tone: 'warn' }, t('capText')),
          h(Pill, { key: 's', tone, strong: true }, stateText),
          blocked ? h(Pill, { key: 'b', tone: 'err' }, t('opencodeBlocked')) : null,
          quotaHit ? h(Pill, { key: 'q', tone: 'err' }, t('opencodeQuota')) : null,
          rateLimited ? h(Pill, { key: 'r', tone: 'warn' }, t('opencodeRateLimited')) : null,
          running
            ? h('span', { key: 'c', className: 'ow-count' },
                `${models?.count ?? 0} ${t('opencodeModels')}`)
            : null,
        ]),
        h('code', { key: 'ep', className: 'ow-ep' },
          running && status?.url !== undefined ? status.url : `http://127.0.0.1:${status?.port ?? 4096}`),
        h('p', { key: 'intro', className: 'ow-hint' }, t('opencodeIntro')),
        h('p', { key: 'caphint', className: 'ow-hint' }, t('capTextHint')),

        // 运行信息：版本、端口、是插件起的还是用户自己起的、流式走的哪条路
        running
          ? h('div', { key: 'meta', className: 'ow-row' }, h('div', { className: 'ow-meta' }, [
              status?.version !== undefined ? h(Pill, { key: 'v' }, `v${status.version}`) : null,
              h(Pill, { key: 'p' }, `:${status?.port ?? ''}`),
              h('span', { key: 'm', className: 'ow-dim' },
                status?.managed === true ? t('opencodeManaged') : t('opencodeExternal')),
              // 流式路径要露出来：SSE 是真 token 增量，轮询是降级（粒度粗）。
              // 用户报「字一段一段蹦」时，这一枚就是第一现场。
              h(Pill, { key: 'sse', tone: status?.sse === true ? 'ok' : 'warn' },
                status?.sse === true ? t('opencodeSse') : t('opencodeSseOff')),
              (models?.vision ?? 0) > 0
                ? h(Pill, { key: 'vi' }, t('opencodeVision').replace('{count}', String(models.vision)))
                : null,
            ]))
          : null,

        // 失败原因按类别摆出来：每类都给「该怎么办」，原文只作为证据附在下面。
        // 这套文案与 README 的「已知边界」三分表、adapter 的判错链是同一套口径。
        anyFailure
          ? h('div', { key: 'blk', className: 'ow-note error' }, [
              blocked ? h('p', { key: 'h-id' }, t('opencodeBlockedHint')) : null,
              quotaHit ? h('p', { key: 'h-q' }, t('opencodeQuotaHint')) : null,
              rateLimited ? h('p', { key: 'h-r' }, t('opencodeRateLimitedHint')) : null,
              ...Object.entries(failures).slice(0, 3).map(([provider, message]) =>
                h('p', { key: 'f-' + provider, className: 'ow-dim' },
                  provider + ' [' + classifyFailure(message) + ']: ' + String(message).slice(0, 160))),
            ])
          : null,

        // 服务没跑时的失败原因原样显示：这条链路能失败的地方太多，藏起来等于让用户猜。
        !running && status?.error !== undefined
          ? h('p', { key: 'err', className: 'ow-note error' }, String(status.error).slice(0, 300))
          : null,

        // 模型预览：只列前 12 个，剩下的靠模型选择器去看。
        running && (models?.count ?? 0) > 0
          ? h('ul', { key: 'mlist', className: 'ow-mlist' }, (models.sample ?? []).map((row) => h('li', {
              key: row.id,
              className: 'ow-mrow',
            }, [
              h('strong', { key: 'i', className: 'ow-mid' }, row.id),
              h('span', { key: 'n', className: 'ow-dim' }, row.name),
              // 能看图的模型单独标出来：这条车道不是纯文本，用户该知道。
              row.vision === true ? h(Pill, { key: 'v', tone: 'ok' }, t('vision')) : null,
            ])))
          : null,

        // 按 provider 分组计数：opencode 免费层 vs 自己挂进来的网关，一眼分清。
        running && (models?.providers ?? []).length > 1
          ? h('p', { key: 'pgroup', className: 'ow-hint' },
              t('opencodeProviders') + '：'
              + (models.providers ?? []).map((p) => p.id + ' ' + p.count).join(' · '))
          : null,
        running && (models?.count ?? 0) === 0
          ? h('p', { key: 'none', className: 'ow-empty' }, t('opencodeEmpty'))
          : null,
        models?.error !== undefined && models?.error !== null
          ? h('p', { key: 'merr', className: 'ow-note error' }, String(models.error).slice(0, 300))
          : null,

        h('div', { key: 'foot', className: 'ow-actions' }, [
          running
            ? h(Button, { key: 'stop', disabled: busy || status?.managed !== true, onClick: onStop }, t('opencodeStop'))
            : h(Button, { key: 'start', kind: 'primary', disabled: busy, onClick: onStart }, t('opencodeStart')),
          h(Button, { key: 'rf', disabled: busy || !running, onClick: onRefresh }, t('opencodeRefresh')),
        ]),
        h('p', { key: 'note', className: 'ow-hint' }, t('opencodeNote')),
      ])
    }

    /**
     * 用户/远程可控字符串的安全正文。
     *
     * ## 为什么还需要它（React 不是已经转义了吗）
     *
     * React 把文本子节点当**文本**渲染，天然转义 `<`/`&` —— 所以这里**不做**
     * HTML 实体转义（那会让人看到字面的 `&amp;`）。真正需要挡的是另外三件事：
     *
     * 1. **控制字符与双向覆盖符**（`\u202e` 等）：渠道目录来自公网，一个 RLO 字符
     *    能把整行文案反过来显示，用户读到的就不是真实内容；
     * 2. **超长正文**：远程目录单字段上限各不相同，渲染层必须自己截断，否则一张卡能撑满整页；
     * 3. **非字符串**（远程写了数字/对象）：直接 `String()` 会得到 `[object Object]`，
     *    归空比显示垃圾好。
     *
     * @param {unknown} value
     * @param {number} [max] 最大字符数
     * @returns {string} 可以直接放进 element child 的字符串
     */
    function safeText(value, max = 200) {
      if (typeof value !== 'string') return ''
      // eslint-disable-next-line no-control-regex
      const cleaned = value.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      return cleaned.length > max ? cleaned.slice(0, max) + '…' : cleaned
    }

    /**
     * 只放行 http(s) 的链接；其它（`javascript:` / `data:` / 相对路径）返回 undefined。
     *
     * ⚠️ 这是**唯一**真正的注入面：React 会转义文本，但 `<a href>` 不做协议白名单。
     * 渠道目录里的 `signupURL` / `docsURL` / `repoUrl` 全来自公网 JSON，
     * 一条 `javascript:...` 就是一次点击即执行。不合法就**不渲染链接**，只留纯文本。
     *
     * @param {unknown} value
     * @returns {string|undefined}
     */
    function safeHref(value) {
      if (typeof value !== 'string') return undefined
      const trimmed = value.trim()
      if (trimmed === '' || trimmed.length > 500) return undefined
      return /^https?:\/\//i.test(trimmed) ? trimmed : undefined
    }

    /** 时间戳的可读写法；0/非法值一律给「—」（不显示 1970 年）。 */
    function formatStamp(ms) {
      if (typeof ms !== 'number' || ms <= 0) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return '—'
      }
    }

    /**
     * 四态 → 药丸色调。
     *
     * ⚠️ 四态**必须分得开**：`unavailable` 与 `needs-action` 的处置完全相反
     * （一个「你做什么都没用」，一个「你去做一件事就好」），染色相同会让人乱试。
     * `unknown` 刻意用中性色（没有状态点）—— 它是「本插件判断不了」，不是错误。
     */
    function stateTone(state) {
      if (state === 'ready') return 'ok'
      if (state === 'needs-action') return 'warn'
      if (state === 'unavailable') return 'err'
      return undefined
    }

    /** 四态 → 文案 key。 */
    function stateLabel(state) {
      if (state === 'ready') return 'stateReady'
      if (state === 'needs-action') return 'stateNeeds'
      if (state === 'unavailable') return 'stateDown'
      return 'stateUnknown'
    }

    /** 状态药丸（四态）：`data-state` 让离线测试能逐态断言。 */
    function StatePill(props) {
      const { state, t } = props
      return h('span', {
        className: 'ow-pill strong ow-state',
        'data-state': String(state ?? 'unknown'),
      }, h('span', { className: `ow-dot ${stateTone(state) ?? 'unknown'}` }), t(stateLabel(state)))
    }

    /**
     * 顶部常驻状态条：**渠道目录** + **插件版本**。
     *
     * ## 为什么常驻在壳上，而不是放在某一页里
     *
     * 「目录是不是最新的」「有没有新版本」是**全局**事实，与当前停在哪一页无关。
     * 放在页内会让用户在另一页看不到它，而这恰恰是他最想确认的两件事。
     *
     * ## 失败一定要说「为什么」
     *
     * 本机 `github.com:443` 直连不通（见 `src/lanes/remote.js` 的说明），所以
     * 「检查目录」在这台机器上**默认就会失败**。只显示「失败」等于什么也没说 ——
     * 必须把后端给的 `reason` 原文摆出来，用户才知道是代理没开、还是目录格式不对。
     */
    function StatusBar(props) {
      const t = props.t ?? ((key) => key)
      const [version, setVersion] = useState(props.version ?? '')
      // ⚠️ `props.catalog` / `props.update` 是**可注入的首屏值**（默认 undefined =
      // 自己去拉）。两个用途：① 离线渲染测试要断言「失败原因原文」这条分支，
      // 而它只有拿到后端返回才出现；② 以后若外壳先批量取好数据再下发给它，
      // 不必改这里的取数逻辑。
      const [catalog, setCatalog] = useState(props.catalog)
      const [update, setUpdate] = useState(props.update)
      const [busy, setBusy] = useState('')

      // 首屏只读缓存（不强制刷新）：打开设置页就打两次网络是不可接受的。
      useEffect(() => {
        if (props.version !== undefined && props.catalog !== undefined && props.update !== undefined) return
        void call('/summary')
          .then((payload) => setVersion(typeof payload?.version === 'string' ? payload.version : ''))
          .catch(() => {})
        void call('/catalog')
          .then((payload) => setCatalog(payload))
          .catch((error) => setCatalog({ wired: false, reason: error.message }))
        void call('/update')
          .then((payload) => setUpdate(payload))
          .catch((error) => setUpdate({ ok: false, from: 'none', reason: error.message, updateAvailable: false }))
      }, [props.version, props.catalog, props.update])

      const checkCatalog = useCallback(async () => {
        setBusy('catalog')
        try {
          // 返回值比 /catalog 多一个 `ok`，其余字段同形 —— 直接替换，不合并，
          // 否则上一轮的 ok:false 会黏在下一轮的「成功」上。
          setCatalog(await call('/catalog/refresh', {}))
        } catch (error) {
          setCatalog({ wired: false, reason: error.message })
        } finally {
          setBusy('')
        }
      }, [])

      const checkUpdate = useCallback(async () => {
        setBusy('update')
        try {
          setUpdate(await call('/update/refresh', {}))
        } catch (error) {
          setUpdate({ ok: false, from: 'none', reason: error.message, updateAvailable: false })
        } finally {
          setBusy('')
        }
      }, [])

      const counts = catalog?.counts ?? {}
      const catalogWired = catalog !== undefined && catalog.wired !== false
      const sha = typeof catalog?.sha256 === 'string' && catalog.sha256 !== '' ? catalog.sha256 : null
      const from = typeof catalog?.from === 'string' ? catalog.from : null
      const catalogFailed = catalog !== undefined && catalog.ok === false

      const latest = typeof update?.latest === 'string' && update.latest !== '' ? update.latest : null
      const updateFailed = update !== undefined && update.ok === false
      const installSpec = safeText(update?.install?.githubSpec, 200)

      return h('div', { className: 'ow-statusbar' }, [
        // ── 左：渠道目录 ──
        h('div', { key: 'cat', className: 'ow-statusrow' }, [
          h('span', { key: 'l', className: 'ow-statuslabel' }, t('catTitle')),
          catalog === undefined
            ? h('span', { key: 'wait', className: 'ow-dim' }, t('busy'))
            : catalogWired
              ? h('span', { key: 'v', className: 'ow-statusmeta' }, [
                  sha !== null ? h('code', { key: 'sha', className: 'ow-mono' }, sha) : null,
                  from !== null ? h('span', { key: 'from', className: 'ow-dim' }, from) : null,
                  h('span', { key: 'at', className: 'ow-dim' },
                    t('fetchedAt') + ' ' + formatStamp(catalog.fetchedAt)),
                  typeof counts.remote === 'number'
                    ? h('span', { key: 'cnt', className: 'ow-dim' },
                        t('catCounts')
                          .replace('{remote}', String(counts.remote ?? 0))
                          .replace('{local}', String(counts.local ?? 0))
                          .replace('{keyed}', String(counts.keyed ?? 0)))
                    : null,
                ])
              : h('span', { key: 'off', className: 'ow-dim' }, safeText(catalog.reason, 240) || t('catUnwired')),
          h(Button, { key: 'b', disabled: busy !== '', onClick: () => void checkCatalog() },
            busy === 'catalog' ? t('catChecking') : t('catCheck')),
        ]),
        // 目录失败/降级：**原文**摆出来（本机访问 GitHub 常失败，这是预期）。
        catalogFailed || (catalog !== undefined && catalogWired && typeof catalog.reason === 'string' && catalog.reason !== '')
          ? h('p', { key: 'cr', className: 'ow-statuserr', role: 'status' },
              t('catReason') + safeText(catalog.reason, 300))
          : null,
        catalogWired && typeof catalog?.localFile === 'string' && catalog.localFile !== ''
          ? h('p', { key: 'lf', className: 'ow-dim ow-statusfoot' },
              t('catLocalFile') + '：' + h('code', { className: 'ow-mono' }, safeText(catalog.localFile, 200)))
          : null,

        // ── 右：插件版本 + 更新 ──
        h('div', { key: 'upd', className: 'ow-statusrow' }, [
          h('span', { key: 'l', className: 'ow-statuslabel' }, t('updTitle')),
          h('span', { key: 'v', className: 'ow-mono' }, 'v' + (version === '' ? '?' : version)),
          update === undefined
            ? h('span', { key: 'wait', className: 'ow-dim' }, t('busy'))
            : update.updateAvailable === true && latest !== null
              ? h(Pill, { key: 'new', tone: 'warn', strong: true }, t('updNew').replace('{latest}', latest))
              : updateFailed
                ? h('span', { key: 'fail', className: 'ow-dim' }, t('updReason') + safeText(update.reason, 240))
                : h('span', { key: 'ok', className: 'ow-dim' },
                    t('updFresh').replace('{current}', safeText(update.current ?? version, 32))),
          h(Button, { key: 'b', disabled: busy !== '', onClick: () => void checkUpdate() },
            busy === 'update' ? t('updChecking') : t('updCheck')),
        ]),
        // 有新版本：给仓库链接 + **可复制的安装命令**。本页绝不代跑升级命令 ——
        // 升级会替换正在运行的插件代码，那是用户自己的决定。
        update?.updateAvailable === true
          ? h('div', { key: 'newline', className: 'ow-statusrow ow-statusnew' }, [
              h('span', { key: 't', className: 'ow-dim' },
                t('updCurrent').replace('{current}', safeText(update.current, 32))),
              safeHref(update.repoUrl) !== undefined
                ? h('a', { key: 'repo', className: 'ow-link', href: safeHref(update.repoUrl), target: '_blank', rel: 'noreferrer noopener' },
                    t('updRepo'))
                : null,
              safeHref(update.changelogUrl) !== undefined
                ? h('a', { key: 'cl', className: 'ow-link', href: safeHref(update.changelogUrl), target: '_blank', rel: 'noreferrer noopener' },
                    t('updChangelog'))
                : null,
              installSpec !== ''
                ? h('span', { key: 'ins', className: 'ow-install' }, [
                    h('span', { key: 'l', className: 'ow-dim' }, t('updInstall') + '：'),
                    h('code', { key: 'c', className: 'ow-mono' }, installSpec),
                  ])
                : null,
            ])
          : null,
      ])
    }

    /**
     * 一张「自带 key」渠道卡。
     *
     * ## 为什么这里**没有**「测试连通性」
     *
     * 没有 key 的车道点测试必然失败，而失败信息会被读成「这条渠道不可用」——
     * 结论完全错了（它只是还没配 key）。所以这一页只回答两件事：
     * **它要什么**（凭据名）与**去哪拿**（signupURL）。真正能测的时候（凭据就绪）
     * 用户已经在会话里选到它的模型了，那里才是验证的地方。
     */
    function KeyedCard(props) {
      const { channel, t } = props
      const capability = channel?.capability ?? { tools: null, vision: null }
      const tools = capability.tools ?? null
      const vision = capability.vision ?? null
      const capText = tools === true ? t('capFull') : tools === false ? t('capText') : t('capUnknown')
      const capTone = tools === true ? 'ok' : tools === false ? 'warn' : undefined
      const signup = safeHref(channel?.signupURL)
      const docs = safeHref(channel?.docsURL)
      const env = safeText(channel?.apiKeyEnv, 64)
      const freeTier = safeText(channel?.freeTier, 300)

      return h('div', { className: 'ow-card ow-keyed', 'data-kind': 'keyed' }, [
        h('div', { key: 'head', className: 'ow-cardhead' }, [
          h('strong', { key: 'n' }, safeText(channel?.displayName, 80)),
          h(Pill, { key: 'cap', tone: capTone }, capText),
          vision === true ? h(Pill, { key: 'vi', tone: 'ok' }, t('capVision')) : null,
          // 记录自己声明「有字段没实证」时标出来，而不是让用户以为这是确证数据。
          channel?.unknown === true ? h(Pill, { key: 'un', tone: 'warn', strong: true }, t('keyedUnknown')) : null,
          h(StatePill, { key: 'st', state: channel?.state, t }),
          typeof channel?.modelCount === 'number'
            ? h('span', { key: 'c', className: 'ow-count' }, t('keyedModels').replace('{count}', String(channel.modelCount)))
            : null,
        ]),
        channel?.endpoint !== undefined
          ? h('code', { key: 'ep', className: 'ow-ep' }, safeText(channel.endpoint, 200))
          : null,
        freeTier !== ''
          ? h('p', { key: 'ft', className: 'ow-hint' }, t('keyedFree') + '：' + freeTier)
          : null,
        // 就绪/未就绪的**原文原因**（后端算的，页面不重算）。
        typeof channel?.reason === 'string' && channel.reason !== ''
          ? h('p', { key: 'why', className: 'ow-statuserr', role: 'status' }, t('reasonLabel') + '：' + safeText(channel.reason, 300))
          : null,
        env !== ''
          ? h('p', { key: 'env', className: 'ow-keyenv' }, [
              h('span', { key: 'l', className: 'ow-dim' }, t('keyedEnv') + '：'),
              h('code', { key: 'c', className: 'ow-mono' }, env),
            ])
          : null,
        channel?.unknown === true
          ? h('p', { key: 'uh', className: 'ow-hint' }, t('keyedUnknownHint'))
          : null,
        h('div', { key: 'links', className: 'ow-actions' }, [
          signup !== undefined
            ? h('a', {
                key: 's', className: 'ow-btn', href: signup,
                target: '_blank', rel: 'noreferrer noopener',
              }, t('keyedGetKey'))
            : null,
          docs !== undefined
            ? h('a', {
                key: 'd', className: 'ow-btn', href: docs,
                target: '_blank', rel: 'noreferrer noopener',
              }, t('keyedDocs'))
            : null,
        ]),
      ])
    }

    /**
     * 第三页：自带 key 的免费渠道。
     *
     * 数据只来自 `/channels` 里 `kind === 'keyed'` 的行 —— 与账号页、服务页**同一次**
     * 全景观测，不另开一套接口（否则「渠道总数」会出现两个口径）。
     */
    function KeyedPage(props) {
      const t = props.t ?? ((key) => key)
      // `props.channels` / `props.wired` / `props.reason` 同样是**可注入的首屏值**
      // （见 StatusBar 的说明）：生产路径不传，测试用它断言空状态与非空两种渲染。
      const [channels, setChannels] = useState(props.channels)
      const [wired, setWired] = useState(props.wired === undefined ? true : props.wired)
      const [reason, setReason] = useState(props.reason ?? '')

      const reload = useCallback(async () => {
        try {
          const payload = await call('/channels')
          setChannels(Array.isArray(payload.channels) ? payload.channels : [])
          setWired(payload.wired !== false)
          setReason(typeof payload.reason === 'string' ? payload.reason : '')
        } catch (error) {
          setChannels([])
          setWired(false)
          setReason(error.message)
        }
      }, [])

      // 注入模式下不自己打网络：测试不该有 fetch。
      const injected = props.channels !== undefined
      useEffect(() => {
        if (injected) return
        void reload()
      }, [injected, reload])

      const reportMeta = props.onMeta
      useEffect(() => {
        if (channels === undefined || reportMeta === undefined) return
        reportMeta({ text: String(channels.filter((row) => row.kind === 'keyed').length) })
      }, [channels, reportMeta])

      const keyed = (channels ?? []).filter((row) => row.kind === 'keyed')

      return h('div', { className: 'ow-root' }, [
        h('header', { key: 'hero', className: 'ow-hero' }, [
          h('div', { key: 'head', className: 'ow-pagehead' }, [
            h('div', { key: 't', className: 'ow-pagetitle' }, [
              h('h2', { key: 'h' }, t('keyedTitle')),
              h('p', { key: 's', className: 'ow-pagesub' }, t('keyedIntro')),
            ]),
            h('div', { key: 'pills', className: 'ow-pills' }, [
              h(Pill, { key: 'c', strong: true }, String(keyed.length)),
              h(Pill, { key: 'n', tone: 'warn' }, t('keyedNoTest')),
            ]),
          ]),
        ]),

        channels === undefined
          ? h('p', { key: 'wait', className: 'ow-dim' }, t('busy'))
          : !wired
            ? h('p', { key: 'off', className: 'ow-statuserr', role: 'status' },
                safeText(reason, 240) || t('catUnwired'))
            : keyed.length === 0
              ? h('div', { key: 'empty', className: 'ow-empty' }, [
                  h('p', { key: 'e' }, t('keyedEmpty')),
                  h('p', { key: 'h', className: 'ow-hint' }, t('keyedEmptyHint')),
                ])
              : h('div', { key: 'cards', className: 'ow-cards' },
                  keyed.map((channel) => h(KeyedCard, { key: channel.id, channel, t }))),

        h('div', { key: 'foot', className: 'ow-foot' }, [
          h(Button, { key: 'r', onClick: () => void reload() }, t('refresh')),
        ]),
      ])
    }

    /**
     * 一条**服务型**车道的卡（第二页的通用形态）。
     *
     * 与 OpenCode 的 `ServiceCard` 分工：那张卡是 OpenCode 专用（有版本、端口、SSE、
     * 失败分类），这张是「注册表里任意一条 service」的通用形态 —— 只有
     * 状态 / 原因 / 模型数 / 能不能在本页启动。
     *
     * ## 为什么「不能启动」要写明白
     *
     * 不写的话，用户看到别的卡有「启动服务」而这张没有，第一反应是「页面坏了」。
     * 实际原因是 `backend !== 'native'`：那条网关的路由由**别的插件**注册，
     * 本插件只观测。把这句话印在卡上，比给一个点了会 404 的按钮好。
     */
    function ServiceLaneCard(props) {
      const { channel, probe, busy, onStart, t } = props
      const state = probe?.state ?? channel?.state
      const reason = typeof probe?.reason === 'string' && probe.reason !== ''
        ? probe.reason
        : (typeof channel?.reason === 'string' ? channel.reason : '')
      const models = Array.isArray(probe?.models) ? probe.models : []
      const modelCount = models.length > 0 ? models.length
        : (typeof channel?.modelCount === 'number' ? channel.modelCount : 0)
      const startable = channel?.startable === true && channel?.backend === 'native'
      const isGateway = channel?.backend === 'gateway'

      return h('div', { className: 'ow-card', 'data-kind': 'service' }, [
        h('div', { key: 'head', className: 'ow-cardhead' }, [
          h('strong', { key: 'n' }, safeText(channel?.displayName, 80)),
          h(StatePill, { key: 'st', state, t }),
          typeof channel?.category === 'string' && channel.category !== ''
            ? h(Pill, { key: 'cat' }, safeText(channel.category, 24))
            : null,
          h('span', { key: 'c', className: 'ow-count' },
            t('serviceModels').replace('{count}', String(modelCount))),
        ]),
        typeof channel?.endpoint === 'string' && channel.endpoint !== ''
          ? h('code', { key: 'ep', className: 'ow-ep' }, safeText(channel.endpoint, 200))
          : null,
        reason !== ''
          ? h('p', { key: 'why', className: 'ow-statuserr', role: 'status' }, t('reasonLabel') + '：' + safeText(reason, 300))
          : null,
        typeof channel?.note === 'string' && channel.note !== ''
          ? h('p', { key: 'note', className: 'ow-hint' }, t('noteLabel') + '：' + safeText(channel.note, 400))
          : null,
        models.length > 0
          ? h('p', { key: 'mlist', className: 'ow-dim ow-servicemodels' },
              models.slice(0, 12).map((id) => safeText(id, 80)).join(' · ')
              + (models.length > 12 ? ' …' : ''))
          : null,
        h('div', { key: 'acts', className: 'ow-actions' }, startable
          ? h(Button, { key: 's', kind: 'primary', disabled: busy, onClick: onStart }, t('opencodeStart'))
          // 不能启动时**不说空话**：把为什么写出来。
          : h('span', { key: 'no', className: 'ow-dim' },
              isGateway ? t('serviceWhyGateway') : t('serviceWhyOther'))),
      ])
    }

    /**
     * 页内分页外壳（与 OFM 的页内 `ofm_tabs` 同一套做法）。
     *
     * 设置侧边栏里**只有一项**「免费模型」；三类渠道（账号 / 本地与网关 / 自带 key）
     * 在这里用一排页签切换。理由：
     *
     * - 侧边栏是「系统功能」的层级，免费模型是一个功能，不该占三行；
     * - 页面之间的**切换是高频动作**（看一眼余额 → 顺手开本地服务 → 去拿个 key），
     *   页内切换比「退出设置页 → 找另一个导航项 → 再进来」少三次点击；
     * - 页签上的数字（启用/账号数、条数）让用户在切换前就知道对面有没有东西。
     *
     * ## 顶部状态条在这里常驻
     *
     * 渠道目录与插件版本是**全局**事实，与当前停在哪一页无关，故挂在页签下方、
     * 页面内容之上（`StatusBar`）。它自己拉 `/catalog` + `/update`，不进各页的 state。
     *
     * ⚠️ 选中项写进 localStorage，刷新后停在原页签；写失败（隐私模式）不影响功能。
     */
    function ConsolePage(props) {
      const t = props.t ?? ((key) => key)
      const [tab, setTab] = useState(readStoredTab)
      // 页签上的数字来自各页自己拉到的数据：外壳不重复请求一遍接口。
      const [meta, setMeta] = useState({})

      useEffect(() => {
        try { window.localStorage?.setItem(TAB_KEY, tab) } catch { /* 隐私模式下不可用 */ }
      }, [tab])

      const report = useCallback((id, patch) => {
        setMeta((current) => ({ ...current, [id]: patch }))
      }, [])
      // ⚠️ 每个页签的回调必须是**稳定引用**：子组件把它放进 useEffect 依赖里，
      // 每次渲染都新建一个箭头函数会让「上报 → 重渲染 → 再上报」转成死循环。
      const reportAccounts = useCallback((patch) => report('accounts', patch), [report])
      const reportLocal = useCallback((patch) => report('local', patch), [report])
      const reportKeyed = useCallback((patch) => report('keyed', patch), [report])

      const tabs = [
        ['accounts', t('navAccounts'), meta.accounts?.text],
        ['local', t('navLocal'), meta.local?.text],
        ['keyed', t('navKeyed'), meta.keyed?.text],
      ]

      return h('div', { className: 'ow-root' }, [
        h('div', { key: 'tabs', className: 'ow-tabs page', role: 'tablist', 'aria-label': t('nav') },
          tabs.map(([id, label, num]) => h('button', {
            key: id,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === id ? 'true' : 'false',
            className: tab === id ? 'ow-tab on' : 'ow-tab',
            onClick: () => setTab(id),
          }, label, num === undefined || num === null
            ? null
            : h('span', { key: 'n', className: 'ow-tabnum' }, String(num))))),
        // 常驻状态条：跨页签的全局事实（目录指纹 / 更新）。放在这里意味着
        // 切页签时它不会重挂载、也不会重复拉一次网络。
        h(StatusBar, { key: 'status', t }),
        tab === 'keyed'
          ? h(KeyedPage, { key: 'keyed', t, ...props, onMeta: reportKeyed })
          : tab === 'local'
            ? h(LocalPage, { key: 'local', t, ...props, onMeta: reportLocal })
            : h(AccountsPage, { key: 'accounts', t, ...props, onMeta: reportAccounts }),
      ])
    }

    /**
     * 读回上次选中的页签。
     *
     * 白名单而不是「记住什么都行」：`localStorage` 里的旧值可能是上一版的
     * `'opencode'`（第二页当时的 id），而那个字符串现在**不是**页签 id 了 ——
     * 直接信任它会渲染出一个空壳。认不出的值一律回落到账号页（常见起点）。
     */
    function readStoredTab() {
      const KNOWN = ['accounts', 'local', 'keyed']
      try {
        const stored = window.localStorage?.getItem(TAB_KEY)
        // 向后兼容：老值 'opencode' 映射到新的 'local'（同一页，只是 id 改了）。
        if (stored === 'opencode') return 'local'
        return KNOWN.includes(stored) ? stored : 'accounts'
      } catch {
        return 'accounts'
      }
    }

    /**
     * 账号车道页（CodeBuddy + WorkBuddy）。
     *
     * ## 数据分三跳，绝不合成一跳
     *
     * 1. \`/summary\` + \`/accounts\` + \`/models\` + \`/auto-checkin\` —— 都是读内存的
     *    轻量调用，并排发；
     * 2. \`/credits\`（**每个车道一次**）—— 每个账号一次上游请求，慢且可能失败，
     *    所以它有独立的 loading 与错误位，不许把账号列表一起拖死；
     * 3. 各个动作（领取 / 续期 / 探测）—— 做完只刷受影响的那部分。
     *
     * 第 2 步的道理与 OFM 的 \`credits.balances\` 完全一致：把余额塞进
     * \`account.list\` 会让「打开页面」被网络耗时绑架，而一次查询失败就整页空白。
     */
    function AccountsPage(props) {
      const t = props.t ?? ((key) => key)
      const [summary, setSummary] = useState(undefined)
      const [accounts, setAccounts] = useState([])
      const [modelRows, setModelRows] = useState([])
      const [credits, setCredits] = useState({})
      const [balanceLoading, setBalanceLoading] = useState(false)
      const [auto, setAuto] = useState(undefined)
      const [tabs, setTabs] = useState({})
      const [busy, setBusy] = useState(false)
      const [claimBusy, setClaimBusy] = useState('')
      const [note, setNote] = useState(undefined)
      // ── OFM 侧 11 条车道的读写状态（与 native 的两条分开存 —— 数据源、刷新节奏
      //    与失败语义都不同；混在一个 state 里会分不清「哪条坏了」）──
      const [ofmAccounts, setOfmAccounts] = useState({})
      const [ofmModels, setOfmModels] = useState({})
      const [ofmCredits, setOfmCredits] = useState({})
      const [ofmBusy, setOfmBusy] = useState('')
      /** 手机号登录（只有 Loomy 有这条备用路径）：{provider, accountId, phone, code, msgid, busy, error} */
      const [sms, setSms] = useState(undefined)

      const reload = useCallback(async () => {
        try {
          const [nextSummary, nextAccounts, nextModels, nextAuto] = await Promise.all([
            call('/summary'),
            call('/accounts'),
            call('/models'),
            // 自动领取状态单独吞掉错误：它读的是本插件的状态文件，
            // 读不到不该让整页变成错误页（账号列表本身是好的）。
            call('/auto-checkin').catch((error) => ({ error: error.message })),
          ])
          setSummary(nextSummary)
          setAccounts(nextAccounts.accounts ?? [])
          // 每个产品的模型清单拍平成一张表，卡片按 provider 过滤即可。
          setModelRows((nextModels.products ?? []).flatMap((product) => product.models ?? []))
          setAuto(nextAuto.autoCheckin ?? undefined)
        } catch (error) {
          setNote({ kind: 'error', text: t('error') + ': ' + error.message })
        }
      }, [t])

      useEffect(() => { void reload() }, [reload])

      /** 查余额：\`products\` 是要查的车道，\`force\` 绕过服务端 60 秒缓存。 */
      const loadBalances = useCallback(async (products, force) => {
        if (products.length === 0) return
        setBalanceLoading(true)
        try {
          const pairs = await Promise.all(products.map(async (product) => {
            try {
              const payload = await call('/credits?provider=' + product.id + (force ? '&force=1' : ''))
              return [product.id, payload]
            } catch (error) {
              // 单条车道查询失败只影响它自己那张卡：别把另一条的余额也清掉。
              return [product.id, { provider: product.id, error: error.message, accounts: [], failures: 0 }]
            }
          }))
          setCredits((current) => ({ ...current, ...Object.fromEntries(pairs) }))
        } finally {
          setBalanceLoading(false)
        }
      }, [])

      // 汇总到手后再查余额：车道清单来自 /summary（能力位也在那里）。
      useEffect(() => {
        const products = (summary?.products ?? []).filter((product) => (product.credits ?? {}).balance === true)
        if (products.length === 0) return
        void loadBalances(products, false)
      }, [summary, loadBalances])

      // 把「几个号在用」报给外壳的页签：数字必须跟数据走，不能写死。
      const reportMeta = props.onMeta
      useEffect(() => {
        if (summary === undefined || reportMeta === undefined) return
        const total = accounts.length
        const enabled = accounts.filter((account) => account.enabled).length
        reportMeta({ text: enabled + '/' + total })
      }, [summary, accounts, reportMeta])

      /** 余额能力可用的车道（刷新余额按钮与领完后的刷新都用它）。 */
      const balanceProducts = (summary?.products ?? []).filter((product) => (product.credits ?? {}).balance === true)

      const runAction = useCallback(async (request) => {
        setBusy(true)
        setNote(undefined)
        try {
          if (request.action === 'credits') {
            const payload = await call('/credits', { provider: request.provider, id: request.id })
            setNote({ kind: 'ok', text: describeBalance(payload.balance, t) })
            void loadBalances(balanceProducts, true)
          } else if (request.action === 'checkin') {
            const payload = await call('/checkin', { provider: request.provider, id: request.id })
            setNote({ kind: 'ok', text: describeOutcome(payload.outcome, t) })
            void loadBalances(balanceProducts, true)
          } else if (request.action === 'probe') {
            const payload = await call('/probe', { provider: request.provider, model: request.model })
            setNote({
              kind: payload.ok ? 'ok' : 'error',
              text: (payload.ok ? t('probeOk') : t('probeFail')) + ' · ' + payload.model + ' · ' + payload.ms + ' ms'
                + (payload.error !== undefined ? ' · ' + payload.error : ''),
            })
          } else {
            await call('/account', { action: request.action, id: request.id })
            await reload()
          }
        } catch (error) {
          setNote({ kind: 'error', text: t('error') + ': ' + error.message })
        } finally {
          setBusy(false)
        }
      }, [balanceProducts, loadBalances, reload, t])

      const runModelAction = useCallback(async (provider, request) => {
        setBusy(true)
        setNote(undefined)
        try {
          await call('/models', { provider, ...request })
          await reload()
        } catch (error) {
          setNote({ kind: 'error', text: t('error') + ': ' + error.message })
        } finally {
          setBusy(false)
        }
      }, [reload, t])

      /**
       * 一键领取（该车道全部账号）。
       *
       * 结果里 \`failed > 0\` 时把提示条染成错误色，但**照常把明细念出来** ——
       * 部分成功是常态（某个号的活动没开），全红会让人以为一个都没领到。
       */
      const runClaimAll = useCallback(async (provider) => {
        setClaimBusy(provider)
        setNote(undefined)
        try {
          const payload = await call('/claim', { provider })
          setNote({ kind: payload.summary?.failed > 0 ? 'error' : 'ok', text: describeClaim(payload, t) })
        } catch (error) {
          setNote({ kind: 'error', text: t('error') + ': ' + error.message })
        } finally {
          setClaimBusy('')
          void loadBalances(balanceProducts, true)
        }
      }, [balanceProducts, loadBalances, t])

      /** 全部续期：逐账号续，单个失败不中断（与 OFM 的 refreshAll 同语义）。 */
      const runRenewAll = useCallback(async (provider) => {
        setBusy(true)
        setNote(undefined)
        let failed = 0
        try {
          const mine = (summary?.products ?? []).find((product) => product.id === provider)
          const rows = accounts.filter((account) => account.provider === provider)
          for (const account of rows) {
            try {
              await call('/account', { action: 'refresh', id: account.id })
            } catch {
              failed += 1
            }
          }
          setNote({ kind: failed > 0 ? 'error' : 'ok',
            text: (mine?.displayName ?? provider) + ': ' + (rows.length - failed) + '/' + rows.length })
          await reload()
        } finally {
          setBusy(false)
        }
      }, [accounts, reload, summary, t])

      const toggleAuto = useCallback(async () => {
        setBusy(true)
        setNote(undefined)
        try {
          const next = auto?.enabled !== true
          const payload = await call('/auto-checkin', { enabled: next })
          setAuto(payload.autoCheckin ?? undefined)
          setNote({ kind: 'ok', text: next ? t('autoEnabled') : t('autoDisabled') })
        } catch (error) {
          setNote({ kind: 'error', text: t('error') + ': ' + error.message })
        } finally {
          setBusy(false)
        }
      }, [auto, t])

      const runAutoNow = useCallback(async () => {
        setBusy(true)
        setNote(undefined)
        try {
          const payload = await call('/auto-checkin', { run: true })
          setAuto(payload.autoCheckin ?? undefined)
          setNote({ kind: 'ok', text: payload.autoCheckin?.lastResult ?? t('claimNone') })
          void loadBalances(balanceProducts, true)
        } catch (error) {
          setNote({ kind: 'error', text: t('error') + ': ' + error.message })
        } finally {
          setBusy(false)
        }
      }, [balanceProducts, loadBalances, t])

      const startLogin = useCallback(async (provider) => {
        setBusy(true)
        setNote({ kind: 'info', text: t('loginPending') })
        try {
          const started = await call('/login', { provider })
          // 打开浏览器：与 OFM 的登录按钮同一手法（宿主不代理这一步）。
          try { window.open(started.loginUrl, '_blank', 'noopener') } catch { /* 弹窗被拦：URL 在上游返回里 */ }
          const done = await call('/login/poll', { provider, state: started.state })
          setNote({ kind: 'ok', text: t('loginDone') + ' · ' + done.accountId })
          await reload()
        } catch (error) {
          setNote({ kind: 'error', text: t('loginFailed') + ': ' + error.message })
        } finally {
          setBusy(false)
        }
      }, [reload, t])

      // ── OFM 侧 11 条车道（product.backend === 'ofm'）────────────────────────
      //
      // 数据全部来自宿主 channel-pack 的 RPC（ofmCall）。三条纪律：
      //
      // 1. **账号与模型目录一次拿全**：OFM 侧两者都读内存副本
      //    （pool.list* 与 modelAdapters[x].listAllModels() 都不发网络请求），
      //    11 条并发也不贵；
      // 2. **余额慢、单独走**：每车道要逐账号打上游，故并发 2、渐进填充，
      //    绝不阻塞账号列表渲染（与 native 那条第 2 跳同一理由）；
      // 3. **后端没就绪时一个请求都不发**（summary.ofm.available !== true）。
      const ofmReady = summary?.ofm?.available === true

      /** 刷新单条 OFM 车道的账号 + 模型目录（动作之后调它，不整页重载）。 */
      const refreshOfm = useCallback(async (provider) => {
        try {
          const value = await ofmCall('account.list', { provider: provider })
          const rows = Array.isArray(value?.accounts) ? value.accounts : []
          setOfmAccounts((current) => ({ ...current, [provider]: rows }))
        } catch { /* 保持旧数据：一次读失败不该把列表清空 */ }
        try {
          const value = await ofmCall('model.list', { provider: provider })
          const rows = Array.isArray(value?.models)
            ? value.models.map((model) => ({ ...model, provider: provider }))
            : []
          setOfmModels((current) => ({ ...current, [provider]: rows }))
        } catch { /* 同上 */ }
      }, [])

      const loadOfm = useCallback(async () => {
        if (!ofmReady) return undefined
        const lanes = (summary?.products ?? []).filter((product) => product.backend === 'ofm')
        if (lanes.length === 0) return undefined
        const accountsNext = {}
        const modelsNext = {}
        await Promise.all(lanes.map(async (lane) => {
          try {
            const value = await ofmCall('account.list', { provider: lane.id })
            accountsNext[lane.id] = Array.isArray(value?.accounts) ? value.accounts : []
          } catch {
            // 单条车道读失败只影响它自己：别把另外十条的列表一起打空。
            accountsNext[lane.id] = []
          }
          try {
            const value = await ofmCall('model.list', { provider: lane.id })
            modelsNext[lane.id] = Array.isArray(value?.models)
              ? value.models.map((model) => ({ ...model, provider: lane.id }))
              : []
          } catch {
            modelsNext[lane.id] = []
          }
        }))
        setOfmAccounts(accountsNext)
        setOfmModels(modelsNext)
        return accountsNext
      }, [ofmReady, summary])

      const loadOfmBalance = useCallback(async (provider) => {
        try {
          const value = await ofmCall('credits.balances', { provider: provider })
          const rows = Array.isArray(value?.accounts) ? value.accounts : []
          setOfmCredits((current) => ({ ...current, [provider]: { accounts: rows } }))
        } catch (error) {
          // 「查不到」也要落进 state：页面才有东西显示原因，而不是永远转圈。
          setOfmCredits((current) => ({ ...current, [provider]: { accounts: [], error: error.message } }))
        }
      }, [])

      /** 后台把多条车道的余额查完（并发 2：上游对同账号有频率限制）。 */
      const loadOfmBalances = useCallback(async (laneProducts) => {
        const queue = [...laneProducts]
        const worker = async () => {
          for (;;) {
            const lane = queue.shift()
            if (lane === undefined) return
            await loadOfmBalance(lane.id)
          }
        }
        await Promise.all([worker(), worker()])
      }, [loadOfmBalance])

      // 首屏：拉账号与目录 → 有账号的车道再后台查余额（渐进填充）。
      useEffect(() => {
        if (!ofmReady) return
        let cancelled = false
        void loadOfm().then((accountsNext) => {
          if (cancelled || accountsNext === undefined) return
          const withAccounts = (summary?.products ?? []).filter((product) => product.backend === 'ofm'
            && (product.credits ?? {}).balance === true
            && (accountsNext[product.id] ?? []).length > 0)
          void loadOfmBalances(withAccounts)
        })
        return () => { cancelled = true }
      }, [ofmReady, loadOfm, loadOfmBalances, summary])

      /** OFM 侧的一次账号动作（enable / disable / remove / refresh / credits / checkin / probe）。 */
      const runOfmAction = useCallback(async (product, request) => {
        setOfmBusy(product.id)
        setNote(undefined)
        try {
          if (request.action === 'enable' || request.action === 'disable') {
            await ofmCall('account.update', {
              accountId: request.id,
              patch: { enabled: request.action === 'enable' },
            })
            await refreshOfm(product.id)
          } else if (request.action === 'remove') {
            await ofmCall('account.delete', { accountId: request.id })
            await refreshOfm(product.id)
          } else if (request.action === 'refresh') {
            await ofmCall('account.refresh', { accountId: request.id })
            await refreshOfm(product.id)
            setNote({ kind: 'ok', text: t('renew') + ' · ' + request.id })
          } else if (request.action === 'credits') {
            await loadOfmBalance(product.id)
          } else if (request.action === 'checkin') {
            // ⚠️ 宿主只提供**按车道**的领取端点（credits.claimAll）——
            // 逐账号的 outcome 在返回值里，故这里领整条车道再念汇总。
            const payload = await ofmCall('credits.claimAll', { provider: product.id })
            setNote({
              kind: payload?.summary?.failed > 0 ? 'error' : 'ok',
              text: product.displayName + ' · ' + describeClaim(payload, t),
            })
            await loadOfmBalance(product.id)
          } else if (request.action === 'probe') {
            const value = await ofmCall('account.test', { accountId: request.id })
            const ok = value?.ok === true
            setNote({
              kind: ok ? 'ok' : 'error',
              text: (ok ? t('probeOk') : t('probeFail')) + ' · ' + (value?.modelId ?? '')
                + (value?.message === undefined ? '' : ' · ' + value.message),
            })
          }
        } catch (error) {
          setNote({ kind: 'error', text: t('ofmCallFailed') + ': ' + error.message })
        } finally {
          setOfmBusy('')
        }
      }, [loadOfmBalance, refreshOfm, t])

      /** OFM 侧的一次模型动作（toggle / all / reset）。 */
      const runOfmModelAction = useCallback(async (product, request) => {
        setOfmBusy(product.id)
        setNote(undefined)
        try {
          if (request.action === 'toggle') {
            await ofmCall('model.setDisabled', {
              provider: product.id,
              modelId: request.model,
              disabled: request.disabled === true,
            })
          } else if (request.action === 'all') {
            await ofmCall('model.setAllDisabled', { provider: product.id, disabled: request.disabled === true })
          } else if (request.action === 'reset') {
            // 「全部恢复」= 清空黑名单（与 native 的 reset 同语义）。
            await ofmCall('model.setAllDisabled', { provider: product.id, disabled: false })
          }
          await refreshOfm(product.id)
        } catch (error) {
          setNote({ kind: 'error', text: t('ofmCallFailed') + ': ' + error.message })
        } finally {
          setOfmBusy('')
        }
      }, [refreshOfm, t])

      const runOfmClaimAll = useCallback(async (product) => {
        setClaimBusy(product.id)
        setNote(undefined)
        try {
          const payload = await ofmCall('credits.claimAll', { provider: product.id })
          setNote({ kind: payload?.summary?.failed > 0 ? 'error' : 'ok', text: describeClaim(payload, t) })
        } catch (error) {
          setNote({ kind: 'error', text: t('ofmCallFailed') + ': ' + error.message })
        } finally {
          setClaimBusy('')
          await loadOfmBalance(product.id)
        }
      }, [loadOfmBalance, t])

      const runOfmRenewAll = useCallback(async (product) => {
        setOfmBusy(product.id)
        setNote(undefined)
        let failed = 0
        const rows = ofmAccounts[product.id] ?? []
        try {
          for (const account of rows) {
            try {
              await ofmCall('account.refresh', { accountId: account.id })
            } catch {
              failed += 1
            }
          }
          setNote({
            kind: failed > 0 ? 'error' : 'ok',
            text: product.displayName + ': ' + (rows.length - failed) + '/' + rows.length,
          })
          await refreshOfm(product.id)
        } finally {
          setOfmBusy('')
        }
      }, [ofmAccounts, refreshOfm, t])

      const ofmSleep = (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms) })

      /**
       * OFM 侧新建账号：两步式（先拿 loginUrl 立刻开窗，再轮询完成）。
       *
       * ⚠️ 与 OFM 自己的面板同一套时序 —— 登录页必须**在用户手势的窗口内**打开，
       * 等授权完成再开必被弹窗拦截（本仓库在 codearts 上踩过「主页面被跳转」）。
       */
      const startOfmLogin = useCallback(async (product) => {
        setOfmBusy(product.id)
        setNote({ kind: 'info', text: t('ofmLoginOpening') })
        try {
          const started = await ofmCall('account.create', { provider: product.id })
          const accountId = started?.accountId
          if (started?.loginMode === 'sms') {
            // 后端明说这条车道要短信：渲染表单而不是开窗（loginUrl 此时是空串）。
            setSms({ provider: product.id, accountId: accountId, phone: '', code: '', msgid: '', busy: false, error: '' })
            setNote(undefined)
            return
          }
          const loginUrl = started?.loginUrl
          if (typeof loginUrl === 'string' && loginUrl.length > 0) {
            try { window.open(loginUrl, '_blank', 'noopener') } catch { /* 被拦：地址在宿主侧日志 */ }
          }
          setNote({ kind: 'info', text: t('ofmLoginWaiting') })
          const deadline = Date.now() + 240000
          let finished = false
          while (Date.now() < deadline) {
            await ofmSleep(1500)
            const poll = await ofmCall('login.poll', { provider: product.id, accountId: accountId })
            if (poll?.done !== true) continue
            finished = true
            if (poll.success === false) {
              setNote({ kind: 'error', text: t('loginFailed') + ': ' + (poll.error ?? '') })
            } else {
              setNote({ kind: 'ok', text: t('loginDone') + ' · ' + accountId })
            }
            break
          }
          if (!finished) setNote({ kind: 'error', text: t('ofmLoginTimeout') })
          await refreshOfm(product.id)
        } catch (error) {
          setNote({ kind: 'error', text: t('loginFailed') + ': ' + error.message })
        } finally {
          setOfmBusy('')
        }
      }, [refreshOfm, t])

      /**
       * 打开手机号登录表单（只有 Loomy 有这条备用路径）。
       *
       * ⚠️ 必须先 account.create 拿到 accountId：宿主的 login.sendSms /
       * login.submitSms 都要求「池里已存在该条目」。account.create 同时会起一轮
       * 微信扫码流程，那条流程若无人扫码自然超时（无害）；短信提交成功则把凭据写进
       * **同一个** ref，不会产生两个账号。
       */
      const openSmsForm = useCallback(async (product) => {
        setOfmBusy(product.id)
        setNote(undefined)
        try {
          const started = await ofmCall('account.create', { provider: product.id })
          setSms({ provider: product.id, accountId: started?.accountId, phone: '', code: '', msgid: '', busy: false, error: '' })
        } catch (error) {
          setNote({ kind: 'error', text: t('ofmCallFailed') + ': ' + error.message })
        } finally {
          setOfmBusy('')
        }
      }, [t])

      const sendSmsCode = useCallback(async () => {
        if (sms === undefined) return
        setSms({ ...sms, busy: true, error: '' })
        try {
          const value = await ofmCall('login.sendSms', {
            provider: sms.provider,
            accountId: sms.accountId,
            phone: sms.phone,
          })
          setSms((current) => current === undefined ? current : { ...current, busy: false, msgid: value?.msgid ?? '', error: '' })
          setNote({ kind: 'ok', text: t('smsSent') })
        } catch (error) {
          setSms((current) => current === undefined ? current : { ...current, busy: false, error: error.message })
        }
      }, [sms, t])

      const submitSmsCode = useCallback(async () => {
        if (sms === undefined) return
        setSms({ ...sms, busy: true, error: '' })
        try {
          const value = await ofmCall('login.submitSms', {
            provider: sms.provider,
            accountId: sms.accountId,
            code: sms.code,
          })
          if (value?.done === true) {
            setSms(undefined)
            setNote({ kind: 'ok', text: t('loginDone') })
            await refreshOfm(sms.provider)
          } else {
            setSms((current) => current === undefined ? current : { ...current, busy: false, error: value?.error ?? '' })
          }
        } catch (error) {
          setSms((current) => current === undefined ? current : { ...current, busy: false, error: error.message })
        }
      }, [refreshOfm, sms, t])

      if (summary === undefined) {
        return h('div', { className: 'ow-root' }, h('p', { className: 'ow-dim' }, t('busy')))
      }

      const totalAccounts = accounts.length
      const enabledAccounts = accounts.filter((account) => account.enabled).length
      const allModels = modelRows.length
      const offModels = modelRows.filter((model) => model.disabled).length
      const yielded = summary.products.some((product) => product.route === 'yielded')
      const knownRows = Object.values(credits).filter((row) => Number.isFinite(row?.total))
      const creditsKnown = knownRows.length > 0
      const creditsTotal = knownRows.reduce((sum, row) => sum + row.total, 0)
      const autoText = auto === undefined ? t('busy')
        : auto.enabled !== true ? t('autoDisabledShort')
          : auto.running === true ? t('autoRunning')
            : auto.ranToday === true ? t('autoRan') : t('autoOff')
      const autoTone = auto?.running === true ? 'warn' : auto?.enabled !== true ? 'warn' : auto?.ranToday === true ? 'ok' : undefined

      return h('div', { className: 'ow-root' }, [
        // ── 顶部玻璃面板：与 OFM 的 hero 同款（标题 + 副标题 + 右侧药丸） ──
        h('header', { key: 'hero', className: 'ow-hero' }, [
          h('div', { key: 'head', className: 'ow-pagehead' }, [
            h('div', { key: 't', className: 'ow-pagetitle' }, [
              h('h2', { key: 'h' }, t('title')),
              h('p', { key: 's', className: 'ow-pagesub' }, t('intro')),
            ]),
            h('div', { key: 'pills', className: 'ow-pills' }, [
              h(Pill, {
                key: 'a', strong: true,
                tone: summary.pool === 'absent' ? 'err' : enabledAccounts > 0 ? 'ok' : 'warn',
              }, enabledAccounts + '/' + totalAccounts + ' ' + t('accounts')),
              h(Pill, { key: 'm', strong: true },
                allModels > 0 ? (allModels - offModels) + '/' + allModels + ' ' + t('models') : t('models')),
              creditsKnown
                ? h(Pill, { key: 'b', strong: true }, t('balance') + ' ' + formatAmount(creditsTotal))
                : null,
              h(Pill, {
                key: 'p',
                tone: summary.pool === 'absent' ? 'err' : undefined,
              }, summary.pool === 'host' ? t('poolHost') : summary.pool === 'local' ? t('poolLocal') : t('poolAbsent')),
              h(Pill, { key: 'q', strong: true, tone: autoTone }, t('autoTitle') + ' · ' + autoText),
            ]),
          ]),
          yielded ? h('p', { key: 'y', className: 'ow-hint' }, t('yieldNote')) : null,
        ]),

        note !== undefined ? h('p', { key: 'n', className: 'ow-note ' + note.kind }, note.text) : null,

        h(AutoCheckinBar, {
          key: 'auto',
          state: auto,
          busy,
          t,
          onToggle: () => void toggleAuto(),
          onRunNow: () => void runAutoNow(),
        }),
        h('p', { key: 'ah', className: 'ow-hint' }, t('autoHint')),

        // ── 卡片网格：13 条账号车道（2 条 native + 11 条 OFM 侧）──────────────
        //
        // ⚠️ 卡片本身不关心后端：数据与回调都**在这里**按 product.backend 分派好，
        // 于是 ProductCard 只有一处「后端未就绪」的判断，不需要知道 RPC 的存在。
        h('div', { key: 'cards', className: 'ow-cards' }, summary.products.map((product) => {
          const isOfm = product.backend === 'ofm'
          const ready = !isOfm || ofmReady
          const laneAccounts = isOfm
            ? (ofmAccounts[product.id] ?? [])
            : accounts.filter((account) => account.provider === product.id)
          const laneModels = isOfm
            ? (ofmModels[product.id] ?? [])
            : modelRows.filter((model) => model.provider === product.id)
          const creditRow = isOfm ? ofmCredits[product.id] : credits[product.id]
          return h(ProductCard, {
            key: product.id,
            product,
            ready,
            backendNote: isOfm ? (ofmReady ? t('backendOfmNote') : t('backendMissingNote')) : undefined,
            accounts: laneAccounts,
            models: laneModels,
            creditRow,
            // 车道级余额失败的原因（OFM 侧：整条车道的查询错误；native 侧走 failures）。
            balanceNote: isOfm && typeof creditRow?.error === 'string' ? creditRow.error : undefined,
            // ⚠️ OFM 侧**没有**逐账号的领取端点（宿主只有 credits.claimAll，按车道），
            // 故那一侧不渲染账号行上的「领积分」—— 否则点了会领掉整条车道，
            // 与按钮所在的「这一行」不符。车道级的「一键领取」照旧。
            rowClaim: !isOfm,
            // OFM 侧余额是**按车道**整批取的（宿主端点就是车道维度），
            // 没有「单个车道正在加载」这个状态，故恒 false。
            balanceLoading: isOfm ? false : balanceLoading,
            tab: tabs[product.id] ?? 'accounts',
            onTab: (next) => setTabs((current) => ({ ...current, [product.id]: next })),
            busy: busy || ofmBusy === product.id,
            claimBusy: claimBusy === product.id,
            t,
            sms: isOfm && sms !== undefined && sms.provider === product.id ? sms : undefined,
            onSmsOpen: () => void openSmsForm(product),
            onSmsChange: (patch) => setSms((current) => current === undefined ? current : { ...current, ...patch }),
            onSmsSend: () => void sendSmsCode(),
            onSmsSubmit: () => void submitSmsCode(),
            onAction: (request) => void (isOfm
              ? runOfmAction(product, request)
              : runAction({ ...request, provider: product.id })),
            onModelAction: (request) => void (isOfm
              ? runOfmModelAction(product, request)
              : runModelAction(product.id, request)),
            onLogin: () => void (isOfm ? startOfmLogin(product) : startLogin(product.id)),
            onClaimAll: () => void (isOfm ? runOfmClaimAll(product) : runClaimAll(product.id)),
            onRefreshBalances: () => void (isOfm ? loadOfmBalance(product.id) : loadBalances([product], true)),
            onRenewAll: () => void (isOfm ? runOfmRenewAll(product) : runRenewAll(product.id)),
          })
        })),

        h('div', { key: 'foot', className: 'ow-foot' }, [
          h(Button, {
            key: 'r',
            disabled: busy,
            onClick: () => { void reload(); void loadBalances(balanceProducts, true) },
          }, t('refresh')),
          h('span', { key: 'v', className: 'ow-dim' }, 'v' + (summary.version ?? '')),
        ]),
      ])
    }

    /**
     * OpenCode 免费层页（服务型车道）。
     *
     * 只回答三个问题：**进程在不在跑、端口多少、目录拉到没有**。
     * 这里没有「账号」这个概念，页面也不提供任何登录入口 ——
     * 这条车道本来就是「不用登录」的那一条。
     */
    function OpenCodePage(props) {
      const t = props.t ?? ((key) => key)
      // `props.status` / `props.version` 是**可注入的首屏值**（同 StatusBar 的说明）：
      // 生产路径不传，离线渲染测试用它断言「运行中 / 已停止」两种卡。
      const [status, setStatus] = useState(props.status)
      const [version, setVersion] = useState(props.version ?? '')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(undefined)

      const reload = useCallback(async () => {
        try {
          setStatus(await call('/opencode/status'))
        } catch (error) {
          setNote({ kind: 'error', text: t('error') + ': ' + error.message })
        }
      }, [t])

      const injected = props.status !== undefined
      useEffect(() => {
        if (injected) return
        void reload()
      }, [injected, reload])
      // 版本号只是一行脚注：单独拉、失败就算了，不能影响服务卡。
      useEffect(() => {
        if (props.version !== undefined) return
        void call('/summary').then((payload) => setVersion(payload.version ?? '')).catch(() => {})
      }, [props.version])

      // 页签数字：服务在跑时显示模型数，没跑就不显示（显示 0 会被读成「没有模型」）。
      const reportMeta = props.onMeta
      useEffect(() => {
        if (status === undefined || reportMeta === undefined) return
        const count = status.models?.count
        reportMeta({ text: status.service?.running === true && Number.isFinite(count) ? String(count) : null })
      }, [status, reportMeta])

      const runAction = useCallback(async (action) => {
        setBusy(true)
        setNote(undefined)
        try {
          if (action === 'start') {
            const started = await call('/opencode/start')
            setNote({
              kind: started.ok ? 'ok' : 'error',
              text: started.ok
                ? t('opencodeRunning') + ' · :' + started.port + ' · ' + started.modelCount + ' ' + t('opencodeModels')
                : String(started.error ?? ''),
            })
          } else if (action === 'stop') {
            await call('/opencode/stop')
          } else {
            const refreshed = await call('/opencode/refresh')
            setNote({ kind: 'ok', text: refreshed.count + ' ' + t('opencodeModels') })
          }
          await reload()
        } catch (error) {
          setNote({ kind: 'error', text: t('error') + ': ' + error.message })
        } finally {
          setBusy(false)
        }
      }, [reload, t])

      if (status === undefined) {
        return h('div', { className: 'ow-root' }, h('p', { className: 'ow-dim' }, t('busy')))
      }
      const running = status.service?.running === true
      const mounted = status.lane?.mounted === true

      return h('div', { className: 'ow-root' }, [
        h('header', { key: 'hero', className: 'ow-hero' }, [
          h('div', { key: 'head', className: 'ow-pagehead' }, [
            h('div', { key: 't', className: 'ow-pagetitle' }, [
              h('h2', { key: 'h' }, t('localTitle')),
              h('p', { key: 's', className: 'ow-pagesub' }, t('localIntro')),
            ]),
            h('div', { key: 'pills', className: 'ow-pills' }, [
              h(Pill, {
                key: 's', strong: true, tone: !running ? 'err' : mounted ? 'ok' : 'warn',
              }, !running ? t('opencodeStopped') : mounted ? t('opencodeRunning') : t('laneNeedsAction')),
              h(Pill, { key: 'c', tone: 'warn' }, t('capText')),
              running ? h(Pill, { key: 'm', strong: true }, (status.models?.count ?? 0) + ' ' + t('opencodeModels')) : null,
            ]),
          ]),
          h('p', { key: 'why', className: 'ow-hint' }, t('localWhy')),
        ]),

        note !== undefined ? h('p', { key: 'n', className: 'ow-note ' + note.kind }, note.text) : null,

        h('div', { key: 'cards', className: 'ow-cards' }, [h(ServiceCard, {
          key: 'opencode',
          lane: status.lane,
          status: status.service,
          models: status.models,
          busy,
          t,
          onStart: () => void runAction('start'),
          onStop: () => void runAction('stop'),
          onRefresh: () => void runAction('refresh'),
        })]),

        h('div', { key: 'foot', className: 'ow-foot' }, [
          h(Button, { key: 'r', disabled: busy, onClick: () => void reload() }, t('refresh')),
          h('span', { key: 'v', className: 'ow-dim' }, 'v' + version),
        ]),
      ])
    }

    /**
     * 第二页：**本地与网关**。
     *
     * ## 为什么不是「把 OpenCode 那张卡换掉」
     *
     * OpenCode 那条车道比其它服务车道多很多事实（版本、端口、是插件起的还是你自己起的、
     * 流式走 SSE 还是轮询、失败按 quota / identity / rateLimit 三类分）。把它压成
     * 「通用服务卡」会把这些信息全丢掉 —— 而它们正是排错时要看的第一现场。
     *
     * 所以这一页是**叠一层**：`OpenCodePage` 原样照搬（一个字没改），
     * 下面再挂注册表里其余的 `kind === 'service'` 车道（FreeLLMAPI 网关、Ollama…）。
     *
     * ## 探针的数据源
     *
     * 用 `/service`（`POST /service/probe` 强制重探），不用 `/channels`：
     * 后者会顺带把 17 条渠道全算一遍，而这一页只需要服务车道那三条的探针结果。
     * 页签数字仍然来自 `/channels` 的 counts（那是「一共几条服务车道」的唯一口径）。
     */
    function LocalPage(props) {
      const t = props.t ?? ((key) => key)
      // 同 KeyedPage：这三个 props 是**可注入的首屏值**，生产路径不传。
      const [lanes, setLanes] = useState(props.lanes)
      const [registry, setRegistry] = useState(props.channels)
      const [wired, setWired] = useState(props.wired === undefined ? true : props.wired)
      const [reason, setReason] = useState(props.reason ?? '')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(undefined)

      const loadService = useCallback(async (force) => {
        try {
          const payload = force === true
            ? await call('/service/probe', {})
            : await call('/service')
          setLanes(payload?.lanes ?? {})
        } catch (error) {
          // 探针未接线（503）时不是「三条都不可用」，而是「这一层没有」：
          // 两者在页面上必须说清，否则用户会去起一个根本没接的服务。
          setLanes({})
          setReason(error.message)
          setWired(false)
        }
      }, [])

      const loadChannels = useCallback(async () => {
        try {
          const payload = await call('/channels')
          setRegistry(Array.isArray(payload.channels) ? payload.channels : [])
          if (payload.wired === false) {
            setWired(false)
            setReason(typeof payload.reason === 'string' ? payload.reason : '')
          }
        } catch (error) {
          setRegistry([])
          setWired(false)
          setReason(error.message)
        }
      }, [])

      useEffect(() => {
        void loadService(false)
        void loadChannels()
      }, [loadService, loadChannels])

      // 页签数字：服务车道**条数**（不是模型数 —— 这一页的粒度是「几条车道」）。
      const reportMeta = props.onMeta
      const serviceCount = (registry ?? []).filter((row) => row.kind === 'service').length
      useEffect(() => {
        if (registry === undefined || reportMeta === undefined) return
        reportMeta(serviceCount > 0 ? { text: String(serviceCount) } : { text: null })
      }, [registry, serviceCount, reportMeta])

      const reprobe = useCallback(async () => {
        setBusy(true)
        setNote(undefined)
        try {
          await loadService(true)
          await loadChannels()
          setNote({ kind: 'ok', text: t('serviceProbe') })
        } finally {
          setBusy(false)
        }
      }, [loadChannels, loadService, t])

      const startService = useCallback(async (id) => {
        setBusy(true)
        setNote(undefined)
        try {
          // 只有 opencode 走这条：别的服务车道的 `startable` 都是 false，
          // 页面上根本不会出现这个按钮（见 ServiceLaneCard）。
          const started = await call('/opencode/start')
          setNote({
            kind: started.ok ? 'ok' : 'error',
            text: started.ok ? t('opencodeRunning') + ' · :' + started.port : String(started.error ?? id),
          })
          await loadService(true)
        } catch (error) {
          setNote({ kind: 'error', text: t('error') + ': ' + error.message })
        } finally {
          setBusy(false)
        }
      }, [loadService, t])

      // opencode 在注册表里也有，但它的专用卡由 OpenCodePage 渲染 —— 这里排除它，
      // 免得同一页出现两张说同一件事的卡。
      const others = (registry ?? []).filter((row) => row.kind === 'service' && row.id !== 'opencode')

      return h('div', { className: 'ow-root ow-localpage' }, [
        note !== undefined ? h('p', { key: 'n', className: 'ow-note ' + note.kind }, note.text) : null,

        // OpenCode 那一套原样保留（停止服务 / 刷新目录 / SSE 徽章 / 失败三分类）。
        h(OpenCodePage, { key: 'oc', t, ...props, onMeta: undefined }),

        h('div', { key: 'divider', className: 'ow-statusrow ow-divider' }, [
          h('span', { key: 'l', className: 'ow-statuslabel' }, t('navLocal')),
          h(Button, { key: 'p', disabled: busy, onClick: () => void reprobe() },
            busy ? t('serviceProbing') : t('serviceProbe')),
        ]),

        !wired
          ? h('p', { key: 'off', className: 'ow-statuserr', role: 'status' },
              safeText(reason, 240) || t('serviceWiredOff'))
          : null,

        lanes === undefined || registry === undefined
          ? h('p', { key: 'wait', className: 'ow-dim' }, t('busy'))
          : others.length === 0
            ? h('p', { key: 'empty', className: 'ow-empty' }, t('serviceEmpty'))
            : h('div', { key: 'cards', className: 'ow-cards' }, others.map((channel) => h(ServiceLaneCard, {
                key: channel.id,
                channel,
                probe: lanes[channel.id],
                busy,
                t,
                onStart: () => void startService(channel.id),
              }))),
      ])
    }

    /**
     * 积分的紧凑写法（与 OFM 的 kilo 同口径）。
     *
     * 积分动辄上万，逐位显示会把卡片撑歪；但**小数值不能被抹成 0** ——
     * 「还剩 3 积分」和「还剩 0 积分」对用户是两件事。
     */
    function formatAmount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const abs = Math.abs(value)
      if (abs >= 1000000) return (value / 1000000).toFixed(abs >= 10000000 ? 0 : 1) + 'M'
      if (abs >= 1000) return (value / 1000).toFixed(abs >= 10000 ? 0 : 1) + 'K'
      return Number.isInteger(value) ? String(value) : value.toFixed(2)
    }

    /** 把一次「一键领取」的返回翻成人话（部分成功要全念出来）。 */
    function describeClaim(payload, t) {
      const summary = payload?.summary ?? {}
      const parts = []
      if (summary.claimed > 0) {
        parts.push(t('claimDone').replace('{count}', String(summary.claimed)).replace('{credit}', formatAmount(summary.totalCredit)))
      }
      if (summary.alreadyClaimed > 0) parts.push(t('claimAlready').replace('{count}', String(summary.alreadyClaimed)))
      if (summary.inactive > 0) parts.push(t('claimNone'))
      if (summary.failed > 0) parts.push(t('claimFailed').replace('{count}', String(summary.failed)))
      return parts.length === 0 ? t('claimNone') : parts.join('，')
    }

    /** 单个账号的领取结果（per-account「领积分」按钮）。 */
    function describeOutcome(outcome, t) {
      if (outcome === null || outcome === undefined) return t('claimNone')
      if (outcome.kind === 'claimed') {
        return t('claimDone').replace('{count}', '1').replace('{credit}', formatAmount(outcome.credit))
      }
      if (outcome.kind === 'already-claimed') return typeof outcome.message === 'string' && outcome.message !== '' ? outcome.message : t('claimAlready').replace('{count}', '1')
      if (outcome.kind === 'inactive') return typeof outcome.message === 'string' && outcome.message !== '' ? outcome.message : t('claimNone')
      return typeof outcome.message === 'string' && outcome.message !== '' ? outcome.message : t('claimFailed').replace('{count}', '1')
    }

    /** 把一次「查积分」的返回翻成人话（单个账号）。 */
    function describeBalance(balance, t) {
      if (balance === null || balance === undefined) return t('balanceNone')
      const total = Number.isFinite(balance.total) ? formatAmount(balance.total) : '?'
      const packages = (balance.packages ?? [])
        .filter((pkg) => pkg.active !== false)
        .map((pkg) => pkg.name + ' ' + formatAmount(pkg.remaining))
      return t('balance') + ' ' + total + (packages.length > 0 ? '（' + packages.join(' · ') + '）' : '')
    }

    const STYLE_ID = 'free-model-css'

    /**
     * 样式表。
     *
     * ## 变量全部来自宿主主题
     *
     * 只用 `--dsw-alias-*`（`dsh-client-ui-theme` 真正定义的那一族）。
     * 早先写的是 `--dsh-*`，那一族**在宿主里根本不存在**，于是每条都退到
     * 硬编码回退色 —— 浅色主题下卡片发灰、强调色对不上，且换配色时整页不跟。
     *
     * ## 与 OFM 的视觉对齐
     *
     * 玻璃层 / 卡片圆角 / 内高光 / 悬停上浮 / 药丸点这些手法与 OFM 的
     * `ofm_glass` / `ofm_card` / `ofm_pill` / `ofm_switch` 同一套取值，
     * 让两页并排看是同一个产品，而不是"插件里嵌了个野页面"。
     */
    const CSS = `
.ow-root {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.55;
}

/* ── 顶部：与 OFM 的 hero 同款玻璃面板 ─────────────────────────────────── */
.ow-hero {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 22px;
  border-radius: var(--dsw-radius-xl, 20px);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 78%, transparent);
  background: linear-gradient(165deg,
    color-mix(in srgb, var(--dsw-alias-bg-layer-3) 88%, transparent),
    color-mix(in srgb, var(--dsw-alias-bg-layer-1) 82%, transparent));
  overflow: hidden;
}
.ow-hero::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(120% 80% at 88% -20%,
    color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent), transparent 62%);
}
.ow-pagehead { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; position: relative; z-index: 1; }
.ow-pagetitle { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ow-pagetitle h2 { margin: 0; font-size: 17px; font-weight: 640; letter-spacing: -.01em; }
.ow-pagesub { margin: 0; font-size: 12.5px; color: var(--dsw-alias-label-secondary); max-width: 68ch; }
.ow-pills { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }

/* ── 药丸 / 状态点 ─────────────────────────────────────────────────────── */
.ow-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 78%, transparent);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 4%);
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  transition: border-color .16s ease, color .16s ease;
}
.ow-pill.strong { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.ow-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); flex: none; }
.ow-dot.ok { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); }
.ow-dot.warn { background: var(--dsw-alias-state-warning-primary, #f0a441); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f0a441) 18%, transparent); }
.ow-dot.err { background: var(--dsw-alias-state-error-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); }

/* ── 按钮：主 / 次 / 危险 ──────────────────────────────────────────────── */
.ow-btn {
  font: inherit;
  font-size: 12px;
  font-weight: 580;
  padding: 5px 12px;
  border-radius: var(--dsw-radius-md, 9px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-3) 84%, transparent);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 5%), 0 1px 2px rgb(0 0 0 / 6%);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  transition: transform .18s cubic-bezier(.34, 1.3, .64, 1), border-color .2s ease, background .2s ease;
}
.ow-btn:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 62%, var(--dsw-alias-border-l2));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 7%, var(--dsw-alias-bg-layer-3));
  transform: translateY(-1px);
}
.ow-btn:active:not(:disabled) { transform: translateY(0); }
.ow-btn:disabled { opacity: .45; cursor: not-allowed; }
.ow-btn.primary {
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--dsw-alias-state-business-primary) 88%, #fff),
    var(--dsw-alias-state-business-primary));
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 82%, #000);
  color: var(--dsw-alias-label-on-accent, #fff);
}
.ow-btn.danger { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, var(--dsw-alias-border-l2)); }
.ow-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-layer-3));
  border-color: var(--dsw-alias-state-error-primary);
}

/* ── 开关：与 OFM 的 ofm_switch 同一组取值 ─────────────────────────────── */
.ow-switch {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
  user-select: none;
  appearance: none;
  background: transparent;
  border: 0;
  padding: 0;
  font: inherit;
  color: inherit;
}
.ow-switch i {
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 8%);
  position: relative;
  transition: background .2s ease, border-color .2s ease, box-shadow .2s ease;
  flex: none;
}
.ow-switch i::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-label-secondary);
  box-shadow: 0 1px 3px rgb(0 0 0 / 22%);
  transition: transform .26s cubic-bezier(.34, 1.3, .64, 1), background .2s ease, width .16s ease;
}
.ow-switch:hover i { filter: brightness(1.05); }
.ow-switch:active i::after { width: 17px; }
.ow-switch[aria-checked="true"] i {
  background: var(--dsw-alias-state-business-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 85%, #000);
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 12%);
}
.ow-switch[aria-checked="true"] i::after {
  transform: translateX(16px);
  background: var(--dsw-alias-label-on-accent, #fff);
}
.ow-switch[aria-checked="true"]:active i::after { transform: translateX(13px); }
.ow-switch:focus-visible i {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent);
}
.ow-switch:disabled { opacity: .45; cursor: not-allowed; }

/* ── 卡片网格 ──────────────────────────────────────────────────────────── */
.ow-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; align-items: start; }
.ow-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: var(--dsw-radius-lg, 13px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-3) 80%, transparent);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%), 0 1px 2px rgb(0 0 0 / 5%), 0 3px 10px rgb(0 0 0 / 4%);
}
.ow-cardhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ow-cardhead strong { font-size: 13.5px; font-weight: 620; }
.ow-ep { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-family-mono, ui-monospace, monospace); }
.ow-count { margin-left: auto; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }

/* ── 页签 ──────────────────────────────────────────────────────────────── */
.ow-tabs { display: flex; gap: 4px; padding: 3px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 72%, transparent); border: 1px solid var(--dsw-alias-border-l1); align-self: flex-start; }
.ow-tab {
  font: inherit;
  font-size: 11.5px;
  font-weight: 560;
  padding: 3px 12px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background .18s ease, color .18s ease, border-color .18s ease;
}
.ow-tab:hover { color: var(--dsw-alias-label-primary); }
.ow-tab.on {
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-3) 96%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 42%, var(--dsw-alias-border-l2));
  color: var(--dsw-alias-label-primary);
  font-weight: 640;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%), 0 1px 3px rgb(0 0 0 / 10%);
}

/* ── 账号行 ────────────────────────────────────────────────────────────── */
.ow-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ow-row {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 11px;
  border-radius: var(--dsw-radius-md, 9px);
  border: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 66%, transparent);
  transition: border-color .18s ease, background .18s ease;
}
.ow-row:hover { border-color: var(--dsw-alias-border-l2); background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 82%, transparent); }
.ow-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 11.5px; }
.ow-meta strong { font-size: 12.5px; font-weight: 600; }
.ow-dim { color: var(--dsw-alias-label-tertiary); }
.ow-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.ow-actions .ow-btn { padding: 3px 9px; font-size: 11.5px; font-weight: 520; }
.ow-empty { margin: 0; padding: 10px 2px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

/* ── 手机号登录（Loomy 的备用路径）──────────────────────────────────────── */
.ow-sms { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 2px 0 4px; }
.ow-sms .ow-hint { flex: 1 1 100%; margin: 0; }
.ow-input {
  flex: 0 0 auto;
  width: 132px;
  padding: 5px 8px;
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-elevated);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
}
.ow-input:focus { outline: 2px solid var(--dsw-alias-state-info-primary, var(--dsw-alias-border-l2)); outline-offset: 1px; }

/* ── 模型面板 ──────────────────────────────────────────────────────────── */
.ow-mpane { display: flex; flex-direction: column; gap: 9px; }
.ow-hint {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md, 9px);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f0a441) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f0a441) 8%, transparent);
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}
.ow-mbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ow-mbar .ow-btn { padding: 3px 9px; font-size: 11.5px; font-weight: 520; }
.ow-mbar-sw { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
.ow-mlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; max-height: 360px; overflow-y: auto; scrollbar-width: thin; }
.ow-mrow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 6px;
  border-radius: var(--dsw-radius-sm, 6px);
  transition: background .14s ease;
}
.ow-mrow:hover { background: var(--dsw-alias-interactive-bg-hover, rgb(255 255 255 / 5%)); }
.ow-mrow.off { opacity: .48; }
.ow-mlabel { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; min-width: 0; flex: 1 1 auto; }
.ow-mlabel input { accent-color: var(--dsw-alias-state-business-primary); cursor: pointer; flex: none; }
.ow-mid { font-size: 11.5px; font-family: var(--dsw-font-family-mono, ui-monospace, monospace); color: var(--dsw-alias-label-primary); }
.ow-mname { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ow-mmeta { display: flex; gap: 7px; align-items: center; font-size: 10.5px; flex: 0 0 auto; }

/* ── 提示条 ────────────────────────────────────────────────────────────── */
.ow-note {
  margin: 0;
  padding: 9px 12px;
  border-radius: var(--dsw-radius-md, 9px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 72%, transparent);
  font-size: 12px;
  word-break: break-word;
}
.ow-note.ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); }
.ow-note.error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }
.ow-note.info { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent); }

.ow-foot { display: flex; gap: 10px; align-items: center; padding-top: 2px; }

/* ── 页级页签（页内分页的外壳） ─────────────────────────────────────────── */
.ow-tabs.page {
  padding: 4px;
  border-radius: 13px;
  border-color: color-mix(in srgb, var(--dsw-alias-border-l1) 80%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 82%, transparent);
}
.ow-tabs.page .ow-tab { font-size: 12px; padding: 5px 14px; border-radius: 10px; }
.ow-tabnum {
  margin-left: 7px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}
.ow-tab.on .ow-tabnum { color: var(--dsw-alias-label-secondary); }

/* ── 自动领积分条 ──────────────────────────────────────────────────────── */
.ow-auto {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-lg, 13px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-3) 80%, transparent);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 5%);
}
.ow-auto-last {
  font-size: 11px;
  max-width: 46ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ow-auto-sp { margin-left: auto; }

/* ── 卡片汇总行与余额徽章 ──────────────────────────────────────────────── */
.ow-chanmeta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.ow-chanmeta b { color: var(--dsw-alias-label-primary); font-weight: 620; }
.ow-sum b { color: var(--dsw-alias-state-success-primary); }
.ow-balrow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ow-bal {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
}
.ow-balerr { font-size: 11px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.ow-balerr-line {
  margin: 0;
  padding: 6px 9px;
  border-radius: var(--dsw-radius-md, 9px);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}

/* ── 顶部常驻状态条（渠道目录 / 插件版本 / 更新） ────────────────────────── */
.ow-statusbar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 12px;
  border-radius: var(--dsw-radius-lg, 13px);
  border: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 62%, transparent);
  font-size: 11.5px;
}
.ow-statusrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ow-statuslabel {
  font-weight: 620;
  color: var(--dsw-alias-label-secondary);
  letter-spacing: .01em;
}
.ow-statusmeta { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ow-statusfoot { margin: 0; font-size: 10.5px; overflow-wrap: anywhere; }
.ow-statuserr {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}
.ow-statusnew { gap: 10px; }
.ow-mono {
  font-family: var(--dsw-font-family-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.ow-link {
  color: var(--dsw-alias-state-business-primary);
  text-decoration: none;
  border-bottom: 1px dashed color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent);
}
.ow-link:hover { color: var(--dsw-alias-label-primary); }
.ow-install { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ow-install code {
  padding: 2px 7px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 82%, transparent);
  user-select: all;
}
.ow-divider {
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}

/* ── 状态药丸（四态）：四色必须分得开 ─────────────────────────────────────── */
.ow-state[data-state="ready"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 52%, transparent); }
.ow-state[data-state="needs-action"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f0a441) 55%, transparent); }
.ow-state[data-state="unavailable"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }
.ow-state[data-state="unknown"] { border-style: dashed; }
/* unknown 刻意**没有**状态点：它是「判断不了」，不是「坏了」。 */
.ow-dot.unknown { background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-label-tertiary); }

/* ── 自带 key 卡 ─────────────────────────────────────────────────────────── */
.ow-keyed .ow-keyenv { margin: 0; font-size: 11.5px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ow-keyed a.ow-btn { text-decoration: none; display: inline-flex; align-items: center; }
.ow-servicemodels { margin: 0; font-size: 10.5px; overflow-wrap: anywhere; }

/* 尊重系统的减少动效偏好：与 OFM 同一条约定。 */
@media (prefers-reduced-motion: reduce) {
  .ow-btn, .ow-row, .ow-mrow, .ow-tab, .ow-pill { transition: none !important; }
  .ow-btn:hover:not(:disabled) { transform: none; }
}
`

    function ensureStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = CSS
      document.head.appendChild(element)
      return () => {
        if (element.parentNode !== null) element.parentNode.removeChild(element)
      }
    }

    return {
      /**
       * 内部组件导出。
       *
       * 只为**离线渲染测试**：`test/render.mjs` 需要单独渲染卡片，而它们
       * 定义在 factory 闭包里。生产路径完全不读这个字段。
       */
      __test: {
        ProductCard, ServiceCard, ConsolePage, AccountsPage, OpenCodePage, AutoCheckinBar,
        // 2026-10-25 夜间新增：三页签外壳的两个新页 + 顶部条 + 两张新卡
        KeyedPage, KeyedCard, LocalPage, ServiceLaneCard, StatusBar, StatePill,
        safeText, safeHref, stateTone, stateLabel,
      },
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-free-model: dictionaries')
        ctx.effect(() => ensureStyles(), 'dsh-free-model: styles')
        /**
         * 导航标签用的翻译器。
         *
         * ⚠️ 标签是**在宿主读取时**（`resolveSlotLabel`）求值的，所以它可以跟随
         * 当前语言 —— 写死中文字符串会让英文界面下出现两个中文导航项。
         * `ctx.locale.bind` 在部分宿主版本里没有（只有 register），故带兜底。
         */
        const labelOf = (key) => {
          try {
            if (typeof ctx.locale?.bind === 'function') return ctx.locale.bind(NS)(key)
          } catch { /* 绑定失败就退回内置字典 */ }
          return zh[key] ?? key
        }
        /**
         * **一个**设置项，页内自己分页（与 OFM 同构）。
         *
         * 侧边栏只占一行「免费模型」；账号车道与本地车道在页内用页签切换 ——
         * 两者都是「免费模型」这个功能的组成部分，不该在系统导航里各占一行。
         *
         * 顺序仍排在 OFM（order 35）之后：先看官方总览，再看这里的补位车道。
         */
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'free-model',
          order: 37,
          label: () => labelOf('nav'),
          locale: NS,
        }, (slotProps) => {
          const translate = slotProps.t ?? ((key) => (zh[key] ?? key))
          return h(ConsolePage, { ...slotProps, t: translate })
        }))
      },
    }
  },
})

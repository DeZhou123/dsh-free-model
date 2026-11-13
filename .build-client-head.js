/**
 * dsh-free-model — 浏览器半身。
 *
 * ## 两个设置页（不是一页三张卡）
 *
 * | 页面 | id | 车道 |
 * |---|---|---|
 * | 免费模型 | \`free-model\` | CodeBuddy / WorkBuddy —— **账号型**车道 |
 * | OpenCode 免费层 | \`free-model-opencode\` | OpenCode —— **服务型**车道，不登录、不要账号 |
 *
 * 早先三条车道挤在一页：账号卡与「本地进程」卡放在一起，读起来像同一类东西，
 * 而它们要回答的问题完全不同 ——
 *
 * - 账号车道：**我有哪些号、还剩多少积分、今天领了没、要重建哪个**；
 * - 服务车道：**本机进程在不在跑、端口多少、目录拉到没有**。
 *
 * 拆开之后每页只有一个主题，页头的状态药丸也不再互相干扰。
 *
 * ## 账号页的信息架构（对齐 OFM 的渠道卡）
 *
 * 每张卡从上到下：渠道名 + 能力徽章 + 路由归属 + 账号计数 → 端点 →
 * **汇总行（账号 / 模型 / 剩余积分）** → 动作行（新建账号 / 全部续期 /
 * 刷新余额 / 一键领取）→ 页签（账号 / 模型）→ 内容区。
 *
 * 账号行里逐条显示**有效期、限流标记、今日已领、剩余积分**，动作按钮按产品能力
 * 渲染 —— WorkBuddy 国际版没有签到接口，所以那条卡上不会出现「领取」按钮，
 * 而不是给一个点了就报 404 的灰色按钮。
 *
 * ## 页头的「每日自动领积分」开关
 *
 * 与 OFM 的 \`usage.autoCheckin\` 同形：一个总开关、一天只跑一次、状态里带上次结果。
 * 但它写的是**本插件自己的状态文件**（见 src/auto-checkin.js 的说明）——
 * 和 OFM 共用一份会把对方的「今天已跑」标记抹掉。
 *
 * ## 写法约束（照抄 OFM 与 model-orchestrator 的既有取舍）
 *
 * - 手写 ModuleLoader bundle：无构建步骤；
 * - 只依赖 shell 已提供的 \`react\`，不 import Harness Client 包
 *   （它们的 API 会随版本移动，抛错的组件会让整个槽位变白）；
 * - 颜色全走主题变量（\`--dsw-alias-*\`），切换配色不会花；
 * - 组件用 \`function\` 声明（有提升），Switch/Pill/Button 一律定义在页面组件之前
 *   —— 曾经把它们写成 const 箭头函数放在页面之后，渲染时直接白屏。
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
    const API = '/api/free-model'

    /** 账号页的字典。 */
    const zh = {
      nav: '免费模型',
      navLocal: 'OpenCode 免费层',
      title: '免费模型 · 账号渠道',
      intro: 'CodeBuddy 与 WorkBuddy 两条账号车道：完整能力（可调用工具、可看图），能当主模型用。不需要 dsh-our-free-model，装了则自动共享账号池与凭据。',
      localTitle: 'OpenCode 免费层',
      localIntro: '本机 opencode serve 提供的免费模型。**不需要账号、不需要登录**，插件可代你启动服务，也可以复用你自己已经开着的实例。',
      localWhy: '这条车道单独一页：它的失败点与账号车道完全不同（二进制在不在、端口被占、serve 版本太旧），排错时不该和「账号要不要重新登录」混在一起看。',

      laneReady: '就绪',
      laneNeedsAction: '需动作',
      laneDown: '不可用',
      capFull: '完整能力',
      capText: '仅文本',
      capFullHint: '可调用工具、可看图，能当主模型用。',
      capTextHint: '不能调用工具（OpenCode 的接口不接受外部工具定义）。适合会话标题、压缩摘要、翻译改写；别在 agent 会话里选它。',

      opencodeStart: '启动服务',
      opencodeStop: '停止服务',
      opencodeRefresh: '刷新目录',
      opencodeRunning: '服务运行中',
      opencodeStopped: '服务未运行',
      opencodeManaged: '本插件启动',
      opencodeExternal: '你已手动启动',
      opencodeModels: '个模型',
      opencodeEmpty: '服务已启动但没读到模型。免费层限流时目录仍会返回，读不到通常意味着 serve 版本过旧。',
      opencodeNote: '首次启动约 2–5 秒；端口被占用会自动顺延。',

      product: '渠道',
      accounts: '账号',
      addAccount: '新建账号',
      refresh: '刷新',
      renewAll: '全部续期',
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

      // ── 自动领积分 ──
      autoTitle: '每日自动领积分',
      autoRunning: '领取中…',
      autoRan: '今日已自动领取',
      autoOff: '今日尚未领取',
      autoLast: '上次结果：{result}',
      autoRunNow: '立即领取',
      autoHint: '开关对账号车道生效（CodeBuddy 有签到接口，WorkBuddy 没有，自动领取时会跳过它）。状态存在 channel-pack/free-model-auto-checkin.json，与 OFM 的开关互不影响。',

      // ── 模型 ──
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
    }

    const en = {
      nav: 'Free models',
      navLocal: 'OpenCode free tier',
      title: 'Free models · account lanes',
      intro: 'CodeBuddy and WorkBuddy: full capability (tools and images), safe as primary models. dsh-our-free-model is optional — when present the account pool and credentials are shared.',
      localTitle: 'OpenCode free tier',
      localIntro: 'Free models served by a local opencode server. No account and no sign-in: the plugin can start the server for you, or reuse one you already run.',
      localWhy: 'This lane has its own page because its failure modes are completely different (missing binary, port taken, old serve build) — debugging it should not be mixed up with "does an account need to sign in again".',

      laneReady: 'Ready',
      laneNeedsAction: 'Needs action',
      laneDown: 'Down',
      capFull: 'Full',
      capText: 'Text only',
      capFullHint: 'Tool calling and images work; safe as a primary model.',
      capTextHint: 'No tool calling (the OpenCode API accepts no external tool definitions). Good for titles, compaction summaries, translation; do not pick it inside an agent session.',

      opencodeStart: 'Start server',
      opencodeStop: 'Stop server',
      opencodeRefresh: 'Refresh catalog',
      opencodeRunning: 'Server running',
      opencodeStopped: 'Server stopped',
      opencodeManaged: 'Started by this plugin',
      opencodeExternal: 'Started by you',
      opencodeModels: 'models',
      opencodeEmpty: 'Server is up but returned no models. A throttled free tier still lists models, so an empty catalog usually means an old serve build.',
      opencodeNote: 'First start takes ~2–5s; ports shift automatically when taken.',

      product: 'Lane',
      accounts: 'Accounts',
      addAccount: 'New account',
      refresh: 'Refresh',
      renewAll: 'Renew all',
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

      autoTitle: 'Daily auto check-in',
      autoRunning: 'Check-in running…',
      autoRan: 'Checked in today',
      autoOff: 'Not checked in today',
      autoLast: 'Last result: {result}',
      autoRunNow: 'Check in now',
      autoHint: 'Applies to the account lanes (CodeBuddy has a check-in API, WorkBuddy does not — it is skipped). State lives in channel-pack/free-model-auto-checkin.json, independent of the OFM switch.',

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
    }

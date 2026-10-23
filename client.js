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
      localWhy: '这条车道单独一页：它的失败点与账号车道完全不同（二进制在不在、端口被占、serve 版本太旧），排错时不该和「账号要不要重新登录」混在一起看。',
      renewalNote: '续期只换令牌，不动账号索引；凭据写入仍然是宿主那一份。',
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

      localWhy: 'This lane has its own page because its failure modes are completely different (missing binary, port taken, old serve build) — debugging it should not be mixed up with “does an account need to sign in again”.',
      renewalNote: 'Renewal only swaps tokens; the account index and the credential store stay the same.',
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
      } = props
      const [showOff, setShowOff] = useState(false)
      const capability = product.credits ?? { balance: false, claim: false }
      const enabledAccounts = accounts.filter((account) => account.enabled).length
      const offCount = models.filter((model) => model.disabled).length
      const onCount = models.length - offCount
      const list = showOff ? models : models.filter((model) => !model.disabled)

      // 路由归属决定状态点：本插件接管 = ok，OFM 内置在跑 = warn。
      const routeTone = product.route === 'registered' ? 'ok' : product.route === 'yielded' ? 'warn' : undefined
      const routeText = product.route === 'registered' ? t('routeOwned')
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
          h('span', { key: 'c', className: 'ow-count' },
            enabledAccounts + '/' + accounts.length + ' ' + t('accounts')),
        ]),
        h('code', { key: 'ep', className: 'ow-ep' }, product.endpoint),
        h('p', { key: 'caphint', className: 'ow-hint' }, t('capFullHint')),

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

        h('div', { key: 'acts', className: 'ow-actions' }, [
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
        ]),

        // 部分账号查不到余额时**明说**：否则卡片上的合计数看起来像「余额掉了」。
        creditRow !== undefined && failures > 0
          ? h('p', { key: 'berr', className: 'ow-balerr-line', role: 'status' },
              t('balancePartial').replace('{count}', String(failures)))
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
                    capability.claim === true
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
     * 页内分页外壳（与 OFM 的页内 `ofm_tabs` 同一套做法）。
     *
     * 设置侧边栏里**只有一项**「免费模型」；账号车道与「不需要登录的本地车道」
     * 在这里用一排页签切换。理由：
     *
     * - 侧边栏是「系统功能」的层级，免费模型是一个功能，不该占两行；
     * - 两条车道的**切换是高频动作**（看一眼余额 → 顺手开本地服务），页内切换
     *   比「退出设置页 → 找另一个导航项 → 再进来」少三次点击；
     * - 页签上的数字（账号数 / 模型数）让用户在切换前就知道对面有没有东西。
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
      const reportLocal = useCallback((patch) => report('opencode', patch), [report])

      const tabs = [
        ['accounts', t('navAccounts'), meta.accounts?.text],
        ['opencode', t('navLocal'), meta.opencode?.text],
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
        tab === 'opencode'
          ? h(OpenCodePage, { key: 'opencode', t, ...props, onMeta: reportLocal })
          : h(AccountsPage, { key: 'accounts', t, ...props, onMeta: reportAccounts }),
      ])
    }

    /** 读回上次选中的页签；任何异常都回落到账号页（有账号才是常见起点）。 */
    function readStoredTab() {
      try {
        return window.localStorage?.getItem(TAB_KEY) === 'opencode' ? 'opencode' : 'accounts'
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

        // ── 卡片网格：两条账号车道并排 ────────────────────────────────────────
        h('div', { key: 'cards', className: 'ow-cards' }, summary.products.map((product) => h(ProductCard, {
          key: product.id,
          product,
          accounts: accounts.filter((account) => account.provider === product.id),
          models: modelRows.filter((model) => model.provider === product.id),
          creditRow: credits[product.id],
          balanceLoading,
          tab: tabs[product.id] ?? 'accounts',
          onTab: (next) => setTabs((current) => ({ ...current, [product.id]: next })),
          busy,
          claimBusy: claimBusy === product.id,
          t,
          onAction: (request) => void runAction({ ...request, provider: product.id }),
          onModelAction: (request) => void runModelAction(product.id, request),
          onLogin: () => void startLogin(product.id),
          onClaimAll: () => void runClaimAll(product.id),
          onRefreshBalances: () => void loadBalances([product], true),
          onRenewAll: () => void runRenewAll(product.id),
        }))),

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
      const [status, setStatus] = useState(undefined)
      const [version, setVersion] = useState('')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(undefined)

      const reload = useCallback(async () => {
        try {
          setStatus(await call('/opencode/status'))
        } catch (error) {
          setNote({ kind: 'error', text: t('error') + ': ' + error.message })
        }
      }, [t])

      useEffect(() => { void reload() }, [reload])
      // 版本号只是一行脚注：单独拉、失败就算了，不能影响服务卡。
      useEffect(() => {
        void call('/summary').then((payload) => setVersion(payload.version ?? '')).catch(() => {})
      }, [])

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
      __test: { ProductCard, ServiceCard, ConsolePage, AccountsPage, OpenCodePage, AutoCheckinBar },
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

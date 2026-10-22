/**
 * dsh-free-model — 浏览器半身。
 *
 * 一个设置页（`settings.section` id `free-model`）：三条免费模型车道的总台。
 *
 * ## 信息架构（产品决策）
 *
 * 用户打开这一页，要在一秒内回答三个问题：
 * 1. **哪条车道现在能用？** → 每张卡头部一个状态点（绿=就绪 / 黄=需动作 / 红=不可用）
 * 2. **它能干什么？** → 能力徽章（`完整能力` / `仅文本`），不写进折叠区
 * 3. **我要做什么才能用？** → 空状态直接给动作按钮，而不是一句「暂无数据」
 *
 * 所以页面结构是：**总览条（三条车道一句话状态）→ 卡片网格 → 底部刷新**。
 * 不做页签切换 —— 三条车道的数量少到一屏放得下，藏进页签反而增加点击。
 *
 * ## 能力差异必须在 UI 上说清
 *
 * `opencode/*` 是纯文本车道（opencode 的接口不接受外部工具定义），它**不能**
 * 当主模型用。这件事如果只写在 README 里，用户一定会在 agent 会话里选它，
 * 然后困惑于「为什么它不会读文件」。故卡片上常驻一行 `仅文本` 徽章 + 一句说明。
 *
 * ## 写法约束（照抄 OFM 与 model-orchestrator 的既有取舍）
 *
 * - 手写 ModuleLoader bundle：无构建步骤；
 * - 只依赖 shell 已提供的 `react`，不 import Harness Client 包
 *   （它们的 API 会随版本移动，抛错的组件会让整个槽位变白）；
 * - 颜色全走主题变量（`--dsw-alias-*`），切换配色不会花。
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

    const zh = {
      nav: '免费模型',
      title: '免费模型总台',
      intro: '三条不花钱的车道：CodeBuddy、WorkBuddy 账号通道，加本机 OpenCode 免费层。不需要 dsh-our-free-model，装了则自动共享账号池。',
      laneReady: '就绪',
      laneNeedsAction: '需动作',
      laneDown: '不可用',
      capFull: '完整能力',
      capText: '仅文本',
      capFullHint: '可调用工具、可看图，能当主模型用。',
      capTextHint: '不能调用工具（OpenCode 的接口不接受外部工具定义）。适合会话标题、压缩摘要、翻译改写；别在 agent 会话里选它。',
      opencodeTitle: 'OpenCode 免费层',
      opencodeIntro: '本机 opencode serve 提供的免费模型。插件可代你启动服务，也可用你自己已开的实例。',
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
    }
    const en = {
      nav: 'Free models',
      title: 'Free model console',
      intro: 'Three lanes that cost nothing: CodeBuddy and WorkBuddy account lanes, plus the local OpenCode free tier. dsh-our-free-model is optional — when present, the account pool is shared.',
      laneReady: 'Ready',
      laneNeedsAction: 'Needs action',
      laneDown: 'Down',
      capFull: 'Full',
      capText: 'Text only',
      capFullHint: 'Tool calling and images work; safe as a primary model.',
      capTextHint: 'No tool calling (the OpenCode API accepts no external tool definitions). Good for titles, compaction summaries, translation; do not pick it inside an agent session.',
      opencodeTitle: 'OpenCode free tier',
      opencodeIntro: 'Free models served by a local opencode server. The plugin can start it for you, or reuse one you already run.',
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
    function ProductCard(props) {
      const { product, accounts, models, tab, onTab, busy, onAction, onModelAction, onLogin, t } = props
      const [showOff, setShowOff] = useState(false)
      const enabledAccounts = accounts.filter((account) => account.enabled).length
      const offCount = models.filter((model) => model.disabled).length
      const onCount = models.length - offCount
      const list = showOff ? models : models.filter((model) => !model.disabled)

      // 路由归属决定这张卡的状态点：本插件接管 = ok，OFM 内置在跑 = warn。
      const routeTone = product.route === 'registered' ? 'ok' : product.route === 'yielded' ? 'warn' : undefined
      const routeText = product.route === 'registered' ? t('routeOwned')
        : product.route === 'yielded' ? t('routeYielded') : t('routeAbsent')

      return h('div', { className: 'ow-card' }, [
        h('div', { key: 'head', className: 'ow-cardhead' }, [
          h('strong', { key: 'n' }, product.displayName),
          // 能力徽章常驻：这条车道能不能当主模型，是用户最先要判断的事。
          h(Pill, { key: 'cap', tone: product.kind === 'service' ? 'warn' : 'ok' },
            product.kind === 'service' ? t('capText') : t('capFull')),
          h(Pill, { key: 'r', tone: routeTone, strong: true }, routeText),
          h('span', { key: 'c', className: 'ow-count' },
            `${enabledAccounts}/${accounts.length} ${t('accounts')}`),
        ]),
        h('code', { key: 'ep', className: 'ow-ep' }, product.endpoint),
        // 能力说明：服务型车道必须解释清楚，否则用户会拿它当主模型。
        h('p', { key: 'caphint', className: 'ow-hint' },
          product.kind === 'service' ? t('capTextHint') : t('capFullHint')),

        h('div', { key: 'tabs', className: 'ow-tabs' }, [
          h('button', {
            key: 'a',
            type: 'button',
            className: tab === 'accounts' ? 'ow-tab on' : 'ow-tab',
            onClick: () => onTab('accounts'),
          }, t('tabAccounts')),
          h('button', {
            key: 'm',
            type: 'button',
            className: tab === 'models' ? 'ow-tab on' : 'ow-tab',
            onClick: () => onTab('models'),
          }, models.length > 0 ? `${t('tabModels')} ${onCount}/${models.length}` : t('tabModels')),
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
            : h('ul', { key: 'list', className: 'ow-list' }, accounts.map((account) => h('li', {
                key: account.id,
                className: 'ow-row',
              }, [
                h('div', { key: 'meta', className: 'ow-meta' }, [
                  h('strong', { key: 'n' }, account.nickname || account.id),
                  h(Pill, { key: 'e', tone: account.enabled ? 'ok' : undefined },
                    account.enabled ? t('enabled') : t('disabled')),
                  Object.keys(account.modelRateLimits ?? {}).length > 0
                    ? h(Pill, { key: 'l', tone: 'warn' }, t('rateLimited'))
                    : null,
                  h('span', { key: 'x', className: 'ow-dim' },
                    `${t('expiresAt')}: ${formatTime(account.expiresAt, t)}`),
                  account.refreshable ? null : h('span', { key: 'r', className: 'ow-dim' }, t('notRefreshable')),
                ]),
                h('div', { key: 'acts', className: 'ow-actions' }, [
                  h(Button, {
                    key: 't',
                    disabled: busy,
                    onClick: () => onAction({ action: account.enabled ? 'disable' : 'enable', id: account.id }),
                  }, account.enabled ? t('disable') : t('enable')),
                  h(Button, { key: 'r', disabled: busy, onClick: () => onAction({ action: 'refresh', id: account.id }) }, t('renew')),
                  h(Button, { key: 'c', disabled: busy, onClick: () => onAction({ action: 'credits', id: account.id }) }, t('credits')),
                  product.id === 'buddy'
                    ? h(Button, { key: 'k', disabled: busy, onClick: () => onAction({ action: 'checkin', id: account.id }) }, t('checkin'))
                    : null,
                  h(Button, { key: 'p', disabled: busy, onClick: () => onAction({ action: 'probe', id: account.id }) }, t('probe')),
                  h(Button, { key: 'd', kind: 'danger', disabled: busy, onClick: () => onAction({ action: 'remove', id: account.id }) }, t('remove')),
                ]),
              ]))),
        // 登录入口放在卡片底部：与 OFM 的渠道卡一致（账号区最后一行是「新建账号」）。
        h('div', { key: 'foot', className: 'ow-actions' }, [
          h(Button, { key: 'add', kind: 'primary', disabled: busy, onClick: onLogin }, t('addAccount')),
        ]),
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

      return h('div', { className: 'ow-card' }, [
        h('div', { key: 'head', className: 'ow-cardhead' }, [
          h('strong', { key: 'n' }, t('opencodeTitle')),
          h(Pill, { key: 'cap', tone: 'warn' }, t('capText')),
          h(Pill, { key: 's', tone, strong: true }, stateText),
          running
            ? h('span', { key: 'c', className: 'ow-count' },
                `${models?.count ?? 0} ${t('opencodeModels')}`)
            : null,
        ]),
        h('code', { key: 'ep', className: 'ow-ep' },
          running && status?.url !== undefined ? status.url : `http://127.0.0.1:${status?.port ?? 4096}`),
        h('p', { key: 'intro', className: 'ow-hint' }, t('opencodeIntro')),
        h('p', { key: 'caphint', className: 'ow-hint' }, t('capTextHint')),

        // 运行信息：版本、端口、是插件起的还是用户自己起的
        running
          ? h('div', { key: 'meta', className: 'ow-row' }, h('div', { className: 'ow-meta' }, [
              status?.version !== undefined ? h(Pill, { key: 'v' }, `v${status.version}`) : null,
              h(Pill, { key: 'p' }, `:${status?.port ?? ''}`),
              h('span', { key: 'm', className: 'ow-dim' },
                status?.managed === true ? t('opencodeManaged') : t('opencodeExternal')),
            ]))
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
            ])))
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

    function SettingsPage(props) {
      const t = props.t ?? ((key) => key)
      const [summary, setSummary] = useState(undefined)
      const [accounts, setAccounts] = useState([])
      const [modelRows, setModelRows] = useState([])
      const [tabs, setTabs] = useState({})
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(undefined)
      // OpenCode 车道单独一份状态：它的形状与账号卡不同（没有账号，只有进程）。
      const [opencode, setOpencode] = useState(undefined)

      const reload = useCallback(async () => {
        try {
          // opencode 的状态单独拉：服务没跑时它也要能答（返回 running:false + 原因），
          // 不能因为一条车道不可用就把整页打成错误页。
          const [nextSummary, nextAccounts, nextModels, nextOpencode] = await Promise.all([
            call('/summary'), call('/accounts'), call('/models'),
            call('/opencode/status').catch((error) => ({ error: error.message })),
          ])
          setSummary(nextSummary)
          setAccounts(nextAccounts.accounts ?? [])
          // 每个产品的模型清单拍平成一张表，卡片按 provider 过滤即可。
          setModelRows((nextModels.products ?? []).flatMap((product) => product.models ?? []))
          setOpencode(nextOpencode)
        } catch (error) {
          setNote({ kind: 'error', text: `${t('error')}: ${error.message}` })
        }
      }, [t])

      useEffect(() => { void reload() }, [reload])

      const runAction = useCallback(async (request) => {
        setBusy(true)
        setNote(undefined)
        try {
          if (request.action === 'credits') {
            const payload = await call('/credits', { provider: request.provider, id: request.id })
            setNote({ kind: 'ok', text: describeBalance(payload.balance) })
          } else if (request.action === 'checkin') {
            const payload = await call('/checkin', { provider: request.provider, id: request.id })
            setNote({ kind: 'ok', text: describeCheckin(payload.outcome) })
          } else if (request.action === 'probe') {
            const payload = await call('/probe', { provider: request.provider, model: request.model })
            setNote({
              kind: payload.ok ? 'ok' : 'error',
              text: `${payload.ok ? t('probeOk') : t('probeFail')} · ${payload.model} · ${payload.ms} ms${payload.error !== undefined ? ` · ${payload.error}` : ''}`,
            })
          } else {
            await call('/account', { action: request.action, id: request.id })
            await reload()
          }
        } catch (error) {
          setNote({ kind: 'error', text: `${t('error')}: ${error.message}` })
        } finally {
          setBusy(false)
        }
      }, [reload, t])

      const runModelAction = useCallback(async (provider, request) => {
        setBusy(true)
        setNote(undefined)
        try {
          await call('/models', { provider, ...request })
          await reload()
        } catch (error) {
          setNote({ kind: 'error', text: `${t('error')}: ${error.message}` })
        } finally {
          setBusy(false)
        }
      }, [reload, t])

      /**
       * OpenCode 服务动作。
       *
       * 三个动作的失败语义各不相同，故分开处理：
       * - start 失败 → 把「哪个端口、为什么」原样显示（用户可能要去关掉占端口的进程）；
       * - stop 只对「插件起的」开放（按钮在卡片里已按 managed 禁用）；
       * - refresh 失败不致命，只是目录没更新。
       */
      const runOpencodeAction = useCallback(async (action) => {
        setBusy(true)
        setNote(undefined)
        try {
          if (action === 'start') {
            const started = await call('/opencode/start')
            setNote({
              kind: started.ok ? 'ok' : 'error',
              text: started.ok
                ? `${t('opencodeRunning')} · :${started.port} · ${started.modelCount} ${t('opencodeModels')}`
                : String(started.error ?? ''),
            })
          } else if (action === 'stop') {
            await call('/opencode/stop')
          } else {
            const refreshed = await call('/opencode/refresh')
            setNote({ kind: 'ok', text: `${refreshed.count} ${t('opencodeModels')}` })
          }
          await reload()
        } catch (error) {
          setNote({ kind: 'error', text: `${t('error')}: ${error.message}` })
        } finally {
          setBusy(false)
        }
      }, [reload, t])

      const startLogin = useCallback(async (provider) => {
        setBusy(true)
        setNote({ kind: 'info', text: t('loginPending') })
        try {
          const started = await call('/login', { provider })
          // 打开浏览器：与 OFM 的登录按钮同一手法（宿主不代理这一步）。
          try { window.open(started.loginUrl, '_blank', 'noopener') } catch { /* 弹窗被拦：URL 就在下面 */ }
          const done = await call('/login/poll', { provider, state: started.state })
          setNote({ kind: 'ok', text: `${t('loginDone')} · ${done.accountId}` })
          await reload()
        } catch (error) {
          setNote({ kind: 'error', text: `${t('loginFailed')}: ${error.message}` })
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
                key: 'a',
                strong: true,
                tone: summary.pool === 'absent' ? 'err' : enabledAccounts > 0 ? 'ok' : 'warn',
              }, `${enabledAccounts}/${totalAccounts} ${t('accounts')}`),
              h(Pill, { key: 'm', strong: true },
                allModels > 0 ? `${allModels - offModels}/${allModels} ${t('models')}` : t('models')),
              h(Pill, {
                key: 'p',
                tone: summary.pool === 'absent' ? 'err' : undefined,
              }, summary.pool === 'host' ? t('poolHost') : summary.pool === 'local' ? t('poolLocal') : t('poolAbsent')),
              // 第三条车道的一句话状态：就绪 / 需动作 / 不可用。
              h(Pill, {
                key: 'o',
                strong: true,
                tone: opencode?.service?.running !== true ? 'err'
                  : opencode?.lane?.mounted === true ? 'ok' : 'warn',
              }, `OpenCode · ${opencode?.service?.running !== true ? t('laneDown')
                : opencode?.lane?.mounted === true ? t('laneReady') : t('laneNeedsAction')}`),
            ]),
          ]),
          yielded ? h('p', { key: 'y', className: 'ow-hint' }, t('yieldNote')) : null,
        ]),

        note !== undefined ? h('p', { key: 'n', className: `ow-note ${note.kind}` }, note.text) : null,

        // ── 卡片网格：账号车道在前，服务车道在后（用户先配账号，再开免费层） ──
        h('div', { key: 'cards', className: 'ow-cards' }, [
          ...summary.products.map((product) => h(ProductCard, {
            key: product.id,
            product,
            accounts: accounts.filter((account) => account.provider === product.id),
            models: modelRows.filter((model) => model.provider === product.id),
            tab: tabs[product.id] ?? 'accounts',
            onTab: (next) => setTabs((current) => ({ ...current, [product.id]: next })),
            busy,
            t,
            onAction: (request) => void runAction({ ...request, provider: product.id }),
            onModelAction: (request) => void runModelAction(product.id, request),
            onLogin: () => void startLogin(product.id),
          })),
          ...(opencode?.lane !== undefined ? [h(ServiceCard, {
            key: 'opencode',
            lane: opencode.lane,
            status: opencode.service,
            models: opencode.models,
            busy,
            t,
            onStart: () => void runOpencodeAction('start'),
            onStop: () => void runOpencodeAction('stop'),
            onRefresh: () => void runOpencodeAction('refresh'),
          })] : []),
        ]),

        h('div', { key: 'foot', className: 'ow-foot' }, [
          h(Button, { key: 'r', disabled: busy, onClick: () => void reload() }, t('refresh')),
          h('span', { key: 'v', className: 'ow-dim' }, `v${summary.version ?? ''}`),
        ]),
      ])
    }

    function describeBalance(balance) {
      if (balance === null || balance === undefined) return '（查不到余额）'
      try {
        return JSON.stringify(balance).slice(0, 400)
      } catch {
        return '（余额格式无法展示）'
      }
    }

    function describeCheckin(outcome) {
      if (outcome === null || outcome === undefined) return '（无返回）'
      try {
        return JSON.stringify(outcome).slice(0, 400)
      } catch {
        return '（返回无法展示）'
      }
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
      __test: { ProductCard, ServiceCard, SettingsPage },
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-free-model: dictionaries')
        ctx.effect(() => ensureStyles(), 'dsh-free-model: styles')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'free-model',
          // 排在 OFM 之后（OFM 是 35）：用户先看官方总览，再看这里的补位车道。
          order: 37,
          label: () => '免费模型',
          locale: NS,
        }, (slotProps) => {
          const translate = slotProps.t ?? ((key) => (zh[key] ?? key))
          return h(SettingsPage, { ...slotProps, t: translate })
        }))
      },
    }
  },
})
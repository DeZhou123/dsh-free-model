/**
 * 账号渠道注册表的回归防线（`src/lanes.js`）。
 *
 * ## 为什么值得单测
 *
 * 那 11 条 OFM 侧车道是**页面渲染的输入**：id 写错 = 卡片对不上后端；
 * `credits.claim` 写错 = 渲染一个点了必然失败的「领取」；`login` 写错 =
 * 该开窗的车道渲染成短信表单。这些都是**静默**的（页面照样渲染），
 * 只能在注册表层面断言。
 *
 * ⚠️ 这里**不**断言 OFM 侧的实现行为（那是 OFM 自己的测试的事）；
 * 只断言「本插件声明的元数据与产品事实一致」以及「不再重复挂载」。
 *
 * 运行：node test/lanes.mjs
 */
import assert from 'node:assert/strict'
import { NATIVE_LANE_IDS, OFM_LANES, OFM_RPC_ENDPOINT, OFM_RPC_PATH, ofmLaneById, ofmLaneIds } from '../src/lanes.js'

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  console.log('  ✓ ' + label)
}

/** OFM 2.5.8 侧确实存在的 11 条账号 provider（顺序 = 页面卡片顺序）。 */
const EXPECTED = [
  'codearts', 'lobsterai', 'qoder', 'qodercn', 'trae',
  'cline', 'loomy', 'raccoon', 'minimax', 'gemini', 'zcode',
]

check('11 条车道、id 与顺序与 OFM 的产品线一致', () => {
  assert.deepEqual(ofmLaneIds(), EXPECTED)
})

check('不与本插件自己挂载的两条重叠（否则会撞 cordis 同名 Service）', () => {
  for (const id of NATIVE_LANE_IDS) {
    assert.equal(ofmLaneById(id), undefined, id + " 不应出现在 OFM 侧注册表里")
  }
  assert.deepEqual([...NATIVE_LANE_IDS], ['buddy', 'workbuddy'])
})

check('每条车道都带齐页面渲染所需的字段', () => {
  for (const lane of OFM_LANES) {
    assert.equal(lane.kind, 'account', lane.id + ' 必须是账号型车道')
    assert.equal(lane.backend, 'ofm', lane.id + ' 的 backend 必须是 ofm')
    assert.ok(typeof lane.displayName === 'string' && lane.displayName.length > 0, lane.id + ' 缺 displayName')
    assert.ok(typeof lane.endpoint === 'string' && lane.endpoint.startsWith('https://'), lane.id + ' 的 endpoint 必须是 https 端点')
    // 每条车道都要写明自己的坑：注册表是页面上唯一的「说明」来源。
    assert.ok(typeof lane.note === 'string' && lane.note.length > 8, lane.id + ' 缺 note（说明）')
    assert.ok(lane.login === 'browser' || lane.login === 'localPage', lane.id + ' 的 login 形态非法')
    assert.equal(lane.credits.balance, true, lane.id + ' 不支持余额查询？请核对 OFM 的 credits.balances 分支')
  }
})

check('积分能力与 OFM 的 claimAll 分支一致（哪家有签到是产品事实）', () => {
  // channel-pack-rpc.ts 的 credits.claimAll 里**没有** Gemini 分支：
  // 免费线没有签到接口。写成 true 会让页面渲染一个点了必然 400 的按钮。
  assert.equal(ofmLaneById('gemini').credits.claim, false)
  assert.ok(ofmLaneById('gemini').credits.claimNote.length > 0, '没有签到接口的车道必须写明原因')
  for (const lane of OFM_LANES) {
    if (lane.id === 'gemini') continue
    assert.equal(lane.credits.claim, true, lane.id + ' 应支持签到（OFM 侧有对应分支）')
  }
})

check('本机登录页的两条车道（Loomy / Raccoon）与短信备用路径标注正确', () => {
  assert.equal(ofmLaneById('loomy').login, 'localPage')
  assert.equal(ofmLaneById('raccoon').login, 'localPage')
  assert.equal(ofmLaneById('loomy').smsFallback, true, 'Loomy 有手机号备用路径')
  assert.equal(ofmLaneById('raccoon').smsFallback, undefined, 'Raccoon 的短信在它自己的登录页里，不走 login.sendSms')
  for (const lane of OFM_LANES) {
    if (lane.login !== 'localPage') assert.equal(lane.smsFallback, undefined, lane.id + ' 不该带短信表单')
  }
})

check('RPC 常量与宿主 channel-pack 的注册路径一致', () => {
  assert.equal(OFM_RPC_PATH, '/api/channel-pack')
  assert.equal(OFM_RPC_ENDPOINT, 'channel-pack')
})

console.log('通过 ' + passed + ' 项')
console.log('全部通过')

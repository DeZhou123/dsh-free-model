/**
 * 两个纯函数的回归断言：`foldMessages` 与 `splitModelId`。
 *
 * 它们不碰网络、不碰宿主，但每一条都对应一个真实会咬人的问题：
 *
 * - `foldMessages` 只发**最后一条 user**：DSH 的 loop 会在同一 session 里反复下发完整历史，
 *   而 opencode 自己已经存了历史。把整段历史都塞进 text 就等于让它读两遍同样的内容。
 * - system 为空时**不能**下发 `system: ''`：那是个空系统提示，会被上游当成真实指令。
 * - 图片只取最后一轮：历史里的图片已经在 opencode 的 session 里，再发一次等于重复计费。
 * - `splitModelId` 只按**第一个**斜杠切分：`ofm` 下的模型 id 自带斜杠
 *   （`ofm/buddy/deepseek-v4.1-flash`），按 lastIndexOf 切会把模型名撕成两半。
 *
 * 需要 hooks 重定向内核包（adapter 依赖 dsh-llm）。
 */
import { foldMessages, OPENCODE_ROUTE } from '../src/opencode/adapter.js'
import { splitModelId } from '../src/opencode/client.js'

let passed = 0
const failures = []
const eq = (actual, expected, label) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++
  else failures.push(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual))
}
const ok = (cond, label) => { if (cond) passed++; else failures.push(label) }

// ── foldMessages ────────────────────────────────────────────────
const history = [
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '第一问' },
  { role: 'assistant', content: '第一答' },
  { role: 'user', content: '第二问（本轮）' },
]
const folded = foldMessages(history)
eq(folded.prompt, '第二问（本轮）', '只发最后一条 user，不重复整段历史')
ok(folded.images.length === 0, '没有图片时 images 为空数组')

const noSystem = foldMessages([{ role: 'user', content: '只有一句' }])
ok(!('system' in noSystem), '没有 system 消息时不下发 system 字段（空字符串会被当成真实指令）')

const twoSystems = foldMessages([
  { role: 'system', content: '规则 A' },
  { role: 'system', content: '规则 B' },
  { role: 'user', content: '问题' },
])
eq(twoSystems.system, '规则 A\n\n规则 B', '多条 system 用空行合并')

const withImages = foldMessages([
  { role: 'user', content: [{ type: 'text', text: '看这张' }, { type: 'image', attachment: { attachmentId: 'old' } }] },
  { role: 'assistant', content: '好的' },
  { role: 'user', content: [{ type: 'text', text: '再看这张' }, { type: 'image', attachment: { attachmentId: 'new' } }] },
])
eq(withImages.images.length, 1, '只取本轮（最后一条 user）的图片，历史里的不重复发')
eq(withImages.images[0].attachment.attachmentId, 'new', '取到的是本轮那张图')

const nestedImage = foldMessages([{
  role: 'user',
  content: [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'image', attachment: { attachmentId: 'nested' } }] }],
}])
eq(nestedImage.images.length, 1, '工具结果里的图片要递归取出来')

const degraded = foldMessages([{ role: 'user', content: [
  { type: 'text', text: '正文' },
  { type: 'tool-result', toolCallId: 't9', content: [] },
  { type: 'image', attachment: { attachmentId: 'x' } },
]}])
eq(degraded.prompt, '正文\n[工具结果 t9]\n[图片]', '工具结果与图片在纯文本里降级成占位符')

eq(foldMessages(undefined).prompt, '', 'messages 不是数组时不抛异常')
eq(foldMessages([null, 42, { role: 'user', content: 'x' }, 'junk']).prompt, 'x', '跳过畸形条目')
eq(foldMessages([{ role: 'assistant', content: '答' }]).prompt, '', 'assistant 不会变成 prompt')
eq(foldMessages([{ role: 'user', content: '直接给字符串' }]).prompt, '直接给字符串', 'content 是字符串时直接当文本')
ok(OPENCODE_ROUTE === 'opencode', '路由 id 与 provider 名一致（宿主据此注册）')

// 把一条**有争议但刻意如此**的语义钉住：最后一条 user 若是空内容，prompt 就是空的。
// 另一个选择是沿用上一条 user 的文本，但那会把已经进过 opencode session 的历史再发一遍 ——
// 正是这个函数存在的理由要避免的事。所以宁可发空，也不重复。将来若要改，改动必须是有意的。
eq(foldMessages([{ role: 'user', content: '旧的一问' }, { role: 'user', content: [] }]).prompt, '',
  '空 content 的最后一轮 → 发空 prompt，不回退到历史（刻意如此，见注释）')

// ── splitModelId ────────────────────────────────────────────────
eq(splitModelId('opencode/big-pickle'), { providerID: 'opencode', modelID: 'big-pickle' }, '普通 provider/model')
eq(splitModelId('ofm/buddy/deepseek-v4.1-flash'), { providerID: 'ofm', modelID: 'buddy/deepseek-v4.1-flash' }, '只按第一个斜杠切分（ofm 的模型名自带斜杠）')
eq(splitModelId('noslash'), { providerID: 'opencode', modelID: 'noslash' }, '没有斜杠时用兜底 provider')
eq(splitModelId('noslash', 'ofm'), { providerID: 'ofm', modelID: 'noslash' }, '兜底 provider 可指定')
eq(splitModelId('/leading'), { providerID: 'opencode', modelID: '/leading' }, '斜杠在开头不当分隔符')
eq(splitModelId('trailing/'), { providerID: 'opencode', modelID: 'trailing/' }, '斜杠在结尾不当分隔符')
eq(splitModelId(''), { providerID: 'opencode', modelID: '' }, '空串不抛异常')
eq(splitModelId(undefined), { providerID: 'opencode', modelID: '' }, 'undefined 不抛异常')

console.log('通过 ' + passed + ' 项')
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过')

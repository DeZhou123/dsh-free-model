/**
 * 语法门：把仓库里会被加载 / 发布的 JS 全部过一遍 `node --check`。
 *
 * 为什么不继续在 package.json 里堆 `node --check a && node --check b && …`：
 *   1. 旧列表只写死了 19 个产品文件，`test/**` 与 `scripts/**` 从来没有被检查过。
 *      `npm test` 只跑 16 个离线套件，`test/e2e-opencode.mjs`、`host-check/apply/keyed`、
 *      `keyed-live`、`service-start`、`opencode-affinity`、`boot-serve` 这些不进 CI 的
 *      套件里就算写坏一处语法，CI 也照样全绿 —— 只有发版前手动跑才会发现。
 *   2. 手写列表要求新增文件时「记得」同步；漏一次就是静默少覆盖。这里改成
 *      「目录里有什么就查什么」，新测试文件自动进闸门。
 *
 * 只用 Node 内建模块（fs / path / child_process），不需要 `npm install`，不联网。
 * 覆盖：index.js、client.js、src/**、test/**、scripts/** 下的 .js / .mjs。
 * 失败时不早退：把所有解析失败的文件都列出来（CI 日志里一次能看到全部），最后以 1 退出。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSIONS = new Set(['.js', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
const ENTRIES = ['index.js', 'client.js', 'src', 'test', 'scripts'];

/** 递归收集文件；目录按名字排序，保证 CI 与本机输出顺序一致。 */
function walk(absPath, out) {
  let entries;
  try {
    entries = readdirSync(absPath, { withFileTypes: true });
  } catch (err) {
    throw new Error(`无法读取 ${absPath}: ${err.message}`);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const abs = join(absPath, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) out.push(abs);
  }
}

/**
 * ## 缺失的条目要跳过，不是抛错（2026-10-28 01:40 实测）
 *
 * `package.json` 的 `files` 白名单是
 * `index.js, client.js, src, scripts, catalog, icon.svg, cordis.patch.yml, README.md, CHANGELOG.md`
 * —— **没有 `test`**。也就是说 `npm i dsh-free-model` 之后，包里根本没有 `test/` 目录。
 *
 * 而这一段原来无条件 `statSync(abs)`，于是**在任何安装副本上**跑 `npm run check` 都是：
 *
 *   Error: ENOENT: no such file or directory, stat '...\dsh-free-model\test'
 *
 * 后果不是"检查失败"，是**检查根本跑不起来** —— 而 `npm run check` 是发布前最后一道语法闸。
 * 一个在安装副本上必崩的闸，等于没有闸。
 *
 * 判据：`existsSync` 为 false 的条目**跳过并记一行**（不静默：人要能看出"这次少查了哪一块"）。
 * 只跳过"不存在"，不跳过"读不了" —— 后者是真故障，仍该抛。
 */
const files = [];
const missing = [];
for (const entry of ENTRIES) {
  const abs = join(ROOT, entry);
  if (!existsSync(abs)) { missing.push(entry); continue; }
  if (statSync(abs).isDirectory()) {
    walk(abs, files);
  } else if (EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
    files.push(abs);
  }
}
if (missing.length > 0) {
  // 发布包里缺 test/ 是正常的；缺 src/ 或 index.js 才是坏事 —— 分开说。
  const critical = missing.filter((name) => name !== 'test');
  console.log('跳过不存在的条目：' + missing.join(', ') + '（发布包的 files 白名单不含它们时属正常）');
  if (critical.length > 0) {
    console.log('⚠ 这些**不该**缺：' + critical.join(', ') + ' —— 包可能装坏了');
  }
}

const rel = (abs) => relative(ROOT, abs).split('\\').join('/');
const bucket = (file) => {
  const path = rel(file);
  if (path.startsWith('test/')) return 'test';
  if (path.startsWith('scripts/')) return 'scripts';
  return 'product';
};

const counts = { product: 0, test: 0, scripts: 0 };
for (const file of files) counts[bucket(file)] += 1;

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) {
    console.error(`FAIL ${rel(file)}: 无法启动 node --check: ${result.error.message}`);
    failures.push(rel(file));
    continue;
  }
  if (result.status !== 0) failures.push(rel(file));
}

if (failures.length > 0) {
  console.error(`\nFAIL 语法门：${failures.length}/${files.length} 个文件解析失败`);
  for (const file of failures) console.error(`  - ${file}`);
  process.exitCode = 1;
} else {
  console.log(
    `OK  语法门：${files.length} 个文件 node --check 全过` +
      `（产品 ${counts.product} / 测试 ${counts.test} / 脚本 ${counts.scripts}）`,
  );
}
// ── 顺带把「会被解析的 JSON」也过一遍 ──────────────────────────────────────────
//
// ⚠️ 2026-10-26 的真实事故：往 package.json 的 scripts 里插了一行 `//` 注释（JSON 不允许），
// 于是 `require('./package.json')` 直接抛 Expected double-quoted property name ——
// 而**整个测试链都读它**：npm 脚本、测试钩子读版本、smoke 的两条断言全挂。
// 语法门是任何人第一件跑的事，它就该在这一层拦住这种错，而不是等到跑测试时才发现。
const JSON_FILES = ['package.json', join('catalog', 'channels.json')]
let jsonFailed = 0
for (const relPath of JSON_FILES) {
  const abs = join(ROOT, relPath)
  try {
    JSON.parse(readFileSync(abs, 'utf8'))
  } catch (error) {
    console.error(`FAIL ${relPath}: JSON 解析失败 —— ${error.message}`)
    jsonFailed += 1
  }
}
if (jsonFailed > 0) {
  console.error(`\nFAIL JSON 门：${jsonFailed}/${JSON_FILES.length} 个文件不是合法 JSON`)
  process.exitCode = 1
} else if (failures.length === 0) {
  console.log(`OK  JSON 门：${JSON_FILES.join(' / ')} 都是合法 JSON`)
}
/**
 * collectProjectFacts 的真实文件系统回归，钉住三条曾经翻过车的性质：
 *
 * 1. **不能只扫一个目录**。旧实现在 ['src/features','src/pages',...] 里挑第一个命中的就 break，
 *    本仓库因此只认出 src/features 下 5 个模块，src/entrypoints、src/plugins、src/store、
 *    public/js 全部漏掉——268 个源文件只覆盖 73 个。
 * 2. **模块不能依赖自己**。旧判定用路径前缀 startsWith 且没排除自身，模块内文件互相 import
 *    会解析回本模块，于是每个模块都得到一条 A→A 自环。
 * 3. **id 必须唯一且稳定**。模块可以嵌套（src/features 与 src/features/xxx 并存），
 *    用目录名当 id 会撞车，所以改用相对路径。
 *
 * 隔离：collect-facts 间接引用的 logger 在模块求值时定死数据目录，先设 APP_DATA_DIR 再动态 import。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-facts-data-'))
const { collectProjectFacts } = await import('./collect-facts.js')

/**
 * 造一个多根项目：
 *   src/features/alpha  —— 内部两文件互相 import（自环陷阱）
 *   src/features/beta   —— 跨模块 import alpha
 *   src/store           —— 扁平目录，旧实现完全扫不到
 *   public/js           —— 另一个根，旧实现同样扫不到
 * 每个目录都放够 3 个源文件，否则会被 MIN_MODULE_FILES 并回父模块。
 */
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-facts-proj-'))
  const w = (rel, code) => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, code)
  }
  w('src/features/alpha/index.js', "import { helper } from './helper.js'\nexport const a = () => helper()\n")
  w('src/features/alpha/helper.js', 'export const helper = () => 1\n')
  w('src/features/alpha/util.js', 'export const u = () => 2\n')
  w('src/features/beta/index.js', "import { a } from '../alpha/index.js'\nexport const b = () => a()\n")
  w('src/features/beta/calc.js', 'export const c = () => 3\n')
  w('src/features/beta/fmt.js', 'export const f = () => 4\n')
  w('src/store/db.js', 'export const db = {}\n')
  w('src/store/cache.js', 'export const cache = {}\n')
  w('src/store/index.js', 'export const s = 1\n')
  w('public/js/app.js', 'export const app = 1\n')
  w('public/js/ui.js', 'export const ui = 2\n')
  w('public/js/util.js', 'export const util = 3\n')
  return root
}

test('扫描覆盖全部源码根，不再只认第一个命中的目录', async () => {
  const facts = await collectProjectFacts(makeProject())
  const ids = facts.modules.map((m) => m.id).sort()

  assert.deepEqual(ids, ['public/js', 'src/features/alpha', 'src/features/beta', 'src/store'])
  assert.equal(facts.summary.totalFiles, 12, '12 个源文件应当全部被计入')
})

test('模块内文件互相 import 不产生自环边', async () => {
  const facts = await collectProjectFacts(makeProject())

  assert.deepEqual(facts.edges.filter((e) => e.from === e.to), [], '不该有任何 from === to 的边')

  const alpha = facts.modules.find((m) => m.id === 'src/features/alpha')
  assert.deepEqual(alpha.dependsOn, [], 'alpha 只 import 了自己内部的文件，不该"依赖自己"')
})

test('跨模块 import 被识别为依赖边，端点用模块 id', async () => {
  const facts = await collectProjectFacts(makeProject())

  assert.deepEqual(facts.edges, [{ from: 'src/features/beta', to: 'src/features/alpha', type: 'depends' }])

  const alpha = facts.modules.find((m) => m.id === 'src/features/alpha')
  const beta = facts.modules.find((m) => m.id === 'src/features/beta')
  assert.deepEqual(beta.dependsOn, ['src/features/alpha'])
  assert.deepEqual(alpha.usedBy, ['src/features/beta'])
})

test('id 唯一、等于相对路径，且 name 是目录名', async () => {
  const facts = await collectProjectFacts(makeProject())

  // validateProjectMap 把 id 列为必填、mergeSupplements 按 id 回填，缺了整条生成链路都会挂
  for (const m of facts.modules) {
    assert.ok(m.id, '每个模块都要有 id')
    assert.equal(m.id, m.path, 'id 就是相对路径')
    assert.equal(m.name, path.posix.basename(m.path), 'name 取目录名，供展示')
  }
  assert.equal(new Set(facts.modules.map((m) => m.id)).size, facts.modules.length, 'id 必须唯一')
})

test('抽取器认 async 导出与动态 import，且不把注释当代码', async () => {
  // 三条都是 project-map 自己那份正则抽取器翻过的车：漏 async（本仓库 144 处）、
  // 漏动态 import（40 处）、把注释里的 export/from 当真代码。改为复用
  // project-checkup/evidence 的实现后修复，这里钉住，防止有人再退回去自己写正则。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-extract-'))
  const w = (rel, code) => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, code)
  }
  w('src/features/svc/index.js', [
    '/**',
    " * 支持 export const / export function —— 这行是注释，不该被当成导出",
    " * 早期实现 copied from './ghost.js' —— 也不该被当成依赖",
    ' */',
    "import { helper } from './helper.js'",
    'export async function fetchAll() { return helper() }',
    'export let cursor = 0',
  ].join('\n'))
  w('src/features/svc/helper.js', 'export const helper = () => 1\n')
  w('src/features/svc/util.js', 'export const u = 1\n')
  w('src/features/lazy/index.js', 'export const a = 1\n')
  w('src/features/lazy/b.js', 'export const b = 2\n')
  w('src/features/lazy/c.js', 'export const c = 3\n')
  // 动态 import 指向另一个模块，必须产生依赖边
  w('src/features/svc/dyn.js', "export async function load() { return import('../lazy/index.js') }\n")

  const facts = await collectProjectFacts(root)
  const svc = facts.modules.find((m) => m.id === 'src/features/svc')
  assert.ok(svc, '应当识别出 svc 模块')

  assert.ok(svc.exports.includes('fetchAll'), 'export async function 必须被抽到')
  assert.ok(svc.exports.includes('cursor'), 'export let 必须被抽到')
  assert.equal(svc.exports.includes('const'), false, '注释里的 export const 不是导出')
  assert.equal(svc.exports.includes('function'), false, '注释里的 export function 不是导出')

  assert.ok(
    svc.dependsOn.includes('src/features/lazy'),
    `动态 import() 必须算作依赖，实得 ${JSON.stringify(svc.dependsOn)}`,
  )
  assert.equal(facts.externalDeps.includes('./ghost.js'), false, '注释里的 from 不是依赖')
})

test('测试文件与三方 vendor 目录不进模块地图', async () => {
  const root = makeProject()
  fs.writeFileSync(path.join(root, 'src/store/db.test.js'), 'test()\n')
  fs.mkdirSync(path.join(root, 'public/vendor'), { recursive: true })
  fs.writeFileSync(path.join(root, 'public/vendor/lib.js'), 'export const lib = 1\n')

  const facts = await collectProjectFacts(root)
  const files = facts.modules.flatMap((m) => m.files)

  assert.equal(files.some((f) => f.includes('.test.')), false, '测试文件是验证手段，不是模块能力')
  assert.equal(files.some((f) => f.includes('vendor/')), false, 'vendor 是三方代码，不是本项目模块')
})

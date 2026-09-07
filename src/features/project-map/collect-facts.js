/**
 * 确定性扫描：把项目切成模块、算出模块间依赖。零 LLM，结果可复现。
 *
 * ## 模块怎么切
 *
 * 旧实现只在 ['src/features','src/pages','src/modules','packages'] 里挑**第一个**命中的目录，
 * 命中即 break，于是本仓库只扫到 src/features 下的 5 个 feature，src/entrypoints、src/plugins、
 * src/store、public/js 全部漏掉——268 个源文件只覆盖 73 个。
 *
 * 现在按目录结构自适应下钻：目录直接含源文件就自成模块，只含子目录就继续往下；
 * 源文件少于 MIN_MODULE_FILES 的叶子并回父模块，避免图上一堆两三个文件的碎节点。
 * 这样 src/store（扁平）与 src/features/*（分子目录）都能得到符合直觉的切分。
 *
 * ## 什么算源码
 *
 * 以 git 追踪清单为准（详见 project-checkup/git-tracked.js 记录的事故）：本仓库的
 * src-tauri/resources/sidecar/ 是打包产物，含 3216 个 .js —— 手工维护跳过名单迟早漏，
 * .gitignore 一次性覆盖它和未来任何构建输出。SKIP_DIR 仍要叠加：fixtures 是被 git
 * 追踪的真实文件，只有它挡得住。非 git 仓库则降级为纯目录遍历。
 */
import { readdir, readFile } from 'fs/promises'
import crypto from 'node:crypto'
import path from 'path'
import { gitTrackedFiles } from '../project-checkup/git-tracked.js'
import { shouldSkipDir } from '../project-checkup/scan-dirs.logic.js'
// 符号/依赖抽取复用 project-checkup 的实现，不再自己维护一套。
// 原先 collect-facts.logic.js 那份实测有三处硬伤：正则漏了 async（本仓库 144 个
// `export async function` 全部抽不到）、不认动态 import()（漏 40 处依赖）、
// 不剥注释（把注释里的 `export`/`from` 当真代码）。这些在 checkup 那套里都是对的，
// 而且它多认 let/var 与 Python/Go，还顺带给出符号行号。
// 跨 feature 引用有先例：本文件已经在用它的 git-tracked 与 scan-dirs。
import { extractExports } from '../project-checkup/evidence/symbols.logic.js'
import { extractImports } from '../project-checkup/evidence/selectors-project.logic.js'

const SOURCE_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.vue', '.py']

/**
 * 在共用 SKIP_DIR 之外，模块地图额外排除的目录。
 *
 * 不去改 project-checkup 的 SKIP_DIR：那份是体检各维度共用的，注释质量、仓库卫生等
 * 维度确实该看测试代码，改它会波及无关维度。这里的取舍只对「功能模块地图」成立——
 * 地图回答「这个项目由哪些能力构成」，三方库不是本项目写的，测试是验证手段而非能力。
 */
const MAP_SKIP_DIR = new Set([
  'vendor',  // 三方库副本（本仓库 public/vendor 由 sync-vendor.mjs 同步，非自有代码）
  'test', 'tests', '__tests__', 'spec', 'e2e',
])

/** 目录下钻的最大层数；到顶后整棵子树算一个模块 */
const MAX_DEPTH = 3
/** 少于这么多源文件的叶子并回父模块 */
const MIN_MODULE_FILES = 3

/** 测试文件不进模块地图：它们是模块的验证手段，不是模块提供的能力 */
function isTestFile(name) {
  return /\.(test|spec)\./.test(name)
}

function isSourceFile(name) {
  return SOURCE_EXTENSIONS.some(ext => name.endsWith(ext)) && !isTestFile(name)
}

async function getLineCount(filePath) {
  try {
    const content = await readFile(filePath, 'utf-8')
    return content.split('\n').length
  } catch {
    return 0
  }
}

/**
 * 遍历出全部候选源文件（相对 projectPath 的正斜杠路径）。
 * tracked 非 null 时只保留 git 追踪的文件。
 */
async function walkSourceFiles(absDir, projectPath, tracked, out) {
  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    return // 目录不存在或无权限
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, { skipHidden: true })) continue
      if (MAP_SKIP_DIR.has(entry.name)) continue
      await walkSourceFiles(path.join(absDir, entry.name), projectPath, tracked, out)
      continue
    }
    if (!entry.isFile() || !isSourceFile(entry.name)) continue
    const rel = path.relative(projectPath, path.join(absDir, entry.name)).split(path.sep).join('/')
    if (tracked && !tracked.has(rel)) continue
    out.push(rel)
  }
}

/** 把扁平的文件路径列表还原成目录树 */
function buildTree(files) {
  const root = { dirs: new Map(), files: [] }
  for (const f of files) {
    const parts = f.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] })
      node = node.dirs.get(seg)
    }
    node.files.push(f)
  }
  return root
}

function collectAll(node, out = []) {
  out.push(...node.files)
  for (const child of node.dirs.values()) collectAll(child, out)
  return out
}

/**
 * 自适应切分：返回 [{ path, files }]，path 为相对目录（根为空串）。
 * 同层内子模块按目录名有序，保证同一项目每次生成的结果一致。
 */
function splitDir(node, relDir, depth) {
  const subs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  if (!subs.length || depth >= MAX_DEPTH) {
    const all = collectAll(node)
    return all.length ? [{ path: relDir, files: all.sort() }] : []
  }

  const children = []
  for (const [seg, child] of subs) {
    children.push(...splitDir(child, relDir ? `${relDir}/${seg}` : seg, depth + 1))
  }
  const big = children.filter(m => m.files.length >= MIN_MODULE_FILES)
  const small = children.filter(m => m.files.length < MIN_MODULE_FILES)

  // 碎片只在「还有子模块活下来」时才并回父模块。若整层子目录都不够大就一律保留：
  // 否则这一层的结构会被抹平，并且塌陷会逐层向上传导——小项目（比如每个模块就一个
  // index.ts）最终会被压成孤零零一个根节点，等于把地图要表达的东西全丢了。
  if (!big.length) {
    const self = node.files.length ? [{ path: relDir, files: [...node.files].sort() }] : []
    return [...self, ...children]
  }

  const own = [...node.files, ...small.flatMap(m => m.files)]
  const self = own.length ? [{ path: relDir, files: own.sort() }] : []
  return [...self, ...big]
}

/**
 * 把 import 说明符解析到具体文件。
 * 逐个补扩展名与 /index：源码里写的是 './logic.js' 或 './logic' 或 './sub'，
 * 三种都要能落到 fileSet 里的真实条目上。
 */
function resolveImport(fromFile, spec, fileSet) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec))
  if (fileSet.has(target)) return target
  for (const ext of SOURCE_EXTENSIONS) {
    if (fileSet.has(target + ext)) return target + ext
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const idx = `${target}/index${ext}`
    if (fileSet.has(idx)) return idx
  }
  return null
}

/**
 * 确定性扫描项目目录，识别模块边界和模块间依赖关系
 * @param {string} projectPath - 项目根路径
 * @returns {Promise<{modules, edges, externalDeps, summary}>}
 */
export async function collectProjectFacts(projectPath) {
  const tracked = await gitTrackedFiles(projectPath)
  const allFiles = []
  await walkSourceFiles(projectPath, projectPath, tracked, allFiles)

  if (!allFiles.length) {
    return { modules: [], edges: [], externalDeps: [], summary: { totalModules: 0, totalFiles: 0, totalLines: 0 } }
  }

  const groups = splitDir(buildTree(allFiles), '', 0)
  const projectName = path.basename(projectPath) || 'root'

  // 每个文件只读一次：导出、行数、import、指纹全在这一趟里算完。
  // 原先导出和 import 各遍历一遍全量文件，等于把整个项目读了两遍。
  const contentOf = new Map()
  const modules = []
  for (const g of groups) {
    // id 用相对路径而不是目录名：模块可以嵌套（src/features 与 src/features/project-map 同时存在），
    // 目录名会撞车；路径唯一且重扫稳定，persist.updateModule 按 id 定位才对得上。
    const id = g.path || '.'
    const exports = []
    let lines = 0
    // 指纹按「文件名 + 内容哈希」逐个累加，再整体哈希一次。
    // 不用 mtime：git checkout / clone 会刷新 mtime 但内容没变，那样每次都判定为「变了」，
    // 增量更新就退化成全量，省 token 的目的落空。
    const digest = crypto.createHash('sha1')
    for (const rel of g.files) {
      let content = null
      try {
        content = await readFile(path.join(projectPath, rel), 'utf-8')
      } catch {
        // 读不到就不进指纹也不进内容表：下轮它若可读，指纹自然变化并触发重描
        lines += await getLineCount(path.join(projectPath, rel))
        continue
      }
      contentOf.set(rel, content)
      // extractExports 返回 {name, kind, line, decl}；地图目前只展示名字，
      // line/kind 先不落盘（将来做符号级跳转时再决定怎么用，避免过早把地图撑大）
      exports.push(...extractExports(content, rel).map((e) => e.name))
      lines += content.split('\n').length
      digest.update(rel).update('\0').update(content).update('\0')
    }
    modules.push({
      id,
      name: g.path ? path.posix.basename(g.path) : projectName,
      path: id,
      files: g.files,
      exports: [...new Set(exports)],
      lines,
      // 供增量更新比对：指纹没变的模块直接沿用上一版描述，不再送进 LLM
      fingerprint: digest.digest('hex'),
      dependsOn: [],
      usedBy: [],
    })
  }

  // 文件 → 所属模块。建边靠它精确归属，不用路径前缀匹配：
  // 模块嵌套时 'src/features/project-map/x.js' 会同时匹配上 'src/features' 与
  // 'src/features/project-map' 两个前缀，谁先谁后取决于遍历顺序，结果不可靠。
  const fileOwner = new Map()
  for (const m of modules) for (const f of m.files) fileOwner.set(f, m.id)
  const fileSet = new Set(fileOwner.keys())
  const byId = new Map(modules.map(m => [m.id, m]))

  const edges = []
  const seenEdge = new Set()
  const externalDeps = new Set()

  for (const m of modules) {
    for (const rel of m.files) {
      const content = contentOf.get(rel) // 上一趟已读入，不再打一次盘
      if (content == null) continue
      // extractImports 返回 {spec, relative, target}。target 只做路径拼接、不补扩展名与
      // /index，覆盖不了 `./logic`、`./sub` 这两种写法，所以仍走下面自己的 fileSet 解析。
      for (const { spec, relative } of extractImports(content, rel)) {
        if (!relative) {
          externalDeps.add(spec)
          continue
        }
        // import 必须相对**当前文件**解析，不能相对模块目录：
        // 一个模块可以横跨子目录（深度到顶时整棵子树算一个模块），
        // 用模块目录当基准会把 '../x.js' 之类算到错误的位置上。
        const targetFile = resolveImport(rel, spec, fileSet)
        if (!targetFile) continue // 指向非源码（.json/.css）或已被排除的文件
        const owner = fileOwner.get(targetFile)
        if (!owner || owner === m.id) continue // 模块内互相 import 不算依赖，否则每个模块都自环

        const key = `${m.id}\u0000${owner}`
        if (seenEdge.has(key)) continue
        seenEdge.add(key)
        edges.push({ from: m.id, to: owner, type: 'depends' })
        m.dependsOn.push(owner)
        byId.get(owner).usedBy.push(m.id)
      }
    }
  }

  return {
    modules,
    edges,
    externalDeps: [...externalDeps].sort(),
    summary: {
      totalModules: modules.length,
      totalFiles: modules.reduce((s, m) => s + m.files.length, 0),
      totalLines: modules.reduce((s, m) => s + m.lines, 0),
    },
  }
}

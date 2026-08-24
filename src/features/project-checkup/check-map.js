/**
 * 维度①的文件系统层：遍历模块目录、比对 mtime、校验死链目标是否存在。
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractPathRefs, candidatePaths, evaluateMap } from './check-map.logic.js';

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|vue|py|go|rs|java|scss|css)$/i;
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const MIN_FILES_FOR_MODULE = 3; // 文件太少的目录不值得单独建地图

/** 递归取目录下代码文件的最新 mtime 和文件数 */
function scanDir(dir) {
  let latest = 0;
  let count = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!CODE_EXT.test(e.name)) continue;
      count += 1;
      try {
        const mt = fs.statSync(full).mtimeMs;
        if (mt > latest) latest = mt;
      } catch { /* 单个文件读不到就跳过，不影响整体体检 */ }
    }
  };
  walk(dir);
  return { latestMtime: latest, fileCount: count };
}

function findRootMap(projectDir) {
  for (const rel of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]) {
    const full = path.join(projectDir, rel);
    if (fs.existsSync(full)) return { rel: rel.replace(/\\/g, '/'), full };
  }
  return null;
}

/**
 * 建立仓库内所有文件和目录的相对路径索引（统一正斜杠）。
 *
 * 为什么需要它：地图作者习惯写相对「概念子模块」的路径而省略中间层级，
 * 比如在 chat-components 的地图里写 `keyboard-input/index.vue`，
 * 真实位置却是 `chat-components/chat-input/keyboard-input/index.vue`。
 * 逐个基准去试永远试不全，改成「这条引用是不是某个真实路径的后缀」。
 */
function buildPathIndex(projectDir) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // 注意：这里刻意不跳过点目录——地图会引用 `.claude/`，必须索引进来。
      // scanDir 里的 startsWith('.') 规则是给 mtime 统计用的，两处别混用。
      if (SKIP_DIR.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
    }
  };
  walk(projectDir, '');
  return out;
}

/** 一条引用是否能在仓库里找到落点 */
function refResolves(ref, projectDir, mapDir, pathIndex) {
  // ① 相对项目根，以及省略了 src/ 前缀的写法
  if (candidatePaths(ref).some((c) => fs.existsSync(path.join(projectDir, c)))) return true;
  // ② 相对该地图所在目录
  if (fs.existsSync(path.join(mapDir, ref))) return true;
  // ③ 后缀匹配：省略中间层级的写法
  const needle = ref.replace(/\/+$/, '');
  return pathIndex.some((p) => p === needle || p.endsWith('/' + needle));
}

export function checkMap(projectDir) {
  const rootMap = findRootMap(projectDir);
  if (!rootMap) {
    return evaluateMap({ hasRootMap: false, modules: [], deadLinks: [], rootMapLines: 0 });
  }

  // 模块 = src/ 下一级目录；没有 src/ 就退化为项目根下一级目录
  const srcDir = path.join(projectDir, 'src');
  const hasSrc = fs.existsSync(srcDir);
  const baseDir = hasSrc ? srcDir : projectDir;
  const basePrefix = hasSrc ? 'src/' : '';

  const moduleDirs = [];
  let entries = [];
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch { /* 读不到就当没有模块 */ }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
    const full = path.join(baseDir, e.name);
    const { latestMtime, fileCount } = scanDir(full);
    if (fileCount < MIN_FILES_FOR_MODULE) continue;
    moduleDirs.push({ name: e.name, rel: basePrefix + e.name, full, latestMtime });
  }

  const modules = moduleDirs.map((m) => {
    const mapFile = path.join(m.full, 'CLAUDE.md');
    if (!fs.existsSync(mapFile)) return { name: m.rel, hasMap: false, staleDays: 0 };
    const mapMtime = fs.statSync(mapFile).mtimeMs;
    const diffMs = m.latestMtime - mapMtime;
    const staleDays = diffMs > 0 ? Math.floor(diffMs / 86400000) : 0;
    return { name: m.rel, hasMap: true, staleDays };
  });

  // 收集所有地图文件（根 + 模块），用于死链扫描
  const mapFiles = [{ rel: rootMap.rel, full: rootMap.full, dir: path.dirname(rootMap.full) }];
  for (const m of moduleDirs) {
    const full = path.join(m.full, 'CLAUDE.md');
    if (fs.existsSync(full)) mapFiles.push({ rel: `${m.rel}/CLAUDE.md`, full, dir: m.full });
  }

  // 全仓路径索引只建一次，供所有地图的死链判定复用
  const pathIndex = buildPathIndex(projectDir);

  const deadLinks = [];
  for (const mf of mapFiles) {
    let raw;
    try { raw = fs.readFileSync(mf.full, 'utf8'); } catch { continue; }
    for (const { ref, line } of extractPathRefs(raw)) {
      if (refResolves(ref, projectDir, mf.dir, pathIndex)) continue;
      deadLinks.push({ file: mf.rel, line, ref });
    }
  }

  const rootMapLines = fs.readFileSync(rootMap.full, 'utf8').split('\n').length;

  return evaluateMap({ hasRootMap: true, modules, deadLinks, rootMapLines });
}

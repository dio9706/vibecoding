/**
 * Repo map 编排层：git 清单 → stat → 增量重解析 → 排序（含任务关键词加权）→ 预算内输出。
 *
 * 定位：给 agent 的「找线索」起点——**确定性、符号级、有预算**。与 project-map（LLM 生成的
 * 功能模块地图）的分工：那是按需生成给人看的文档，这是每次运行注入给模型的代码索引。
 *
 * 生命周期与纪律：
 * 1. **仅 git 仓库**（拍板）：`gitTrackedFiles` 是「什么算源码」的权威口径，.gitignore
 *    天然挡掉构建产物（src-tauri/resources 副本）与密钥文件；返回 null → 空图。
 * 2. 缓存 + 增量：per-file 记录（mtime/size/符号/import/标识符）；源文件没变只 stat 重排序，
 *    变了只重解析变化的文件（4s 预算内，超时用已解析部分）。
 * 3. fail-open：任何异常都返回空串（地图是增强不是依赖），由 getRepoMap 统一兜底。
 *
 * 复用 project-checkup 的共享件（跨 feature 引用有先例，见 project-map/collect-facts.js）：
 * 导出符号/import 抽取、目录跳过、git 清单、指纹缓存——**共享件零改动**；
 * 类方法等增强走本 feature 自有的附加抽取器（extra-symbols.logic.js），只进地图不进体检。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { gitTrackedFiles } from '../project-checkup/git-tracked.js';
import { shouldSkipDir } from '../project-checkup/scan-dirs.logic.js';
import { extractExports } from '../project-checkup/evidence/symbols.logic.js';
import { extractImports } from '../project-checkup/evidence/selectors-project.logic.js';
import { computeFingerprint } from '../project-checkup/fingerprint.logic.js';
import { getRepoMapCacheRecord, putRepoMapCacheRecord } from '../../store/repo-map-cache.js';
import { logger } from '../../shared/logger.js';
import { extractExtraSymbols } from './extra-symbols.logic.js';
import {
  DEFAULT_BUDGET_CHARS,
  MAX_FILE_BYTES,
  extractQueryTerms,
  extractTokens,
  formatRepoMap,
  rankFiles,
} from './repo-map.logic.js';

/** 冷启动/大改的解析预算：超时用已解析部分出图（多给一点信息优先于死等） */
const BUILD_DEADLINE_MS = 4000;
/**
 * 缓存记录版本：抽取器口径变化时必须 +1，旧记录整体作废（mtime/size 命中也不复用）——
 * 否则升级后老缓存会一直提供「不含新符号」的地图，直到每个文件碰巧被改动一次。
 * v2：Phase 2 附加抽取器（类方法）上线。
 */
const CACHE_VERSION = 2;
/** RepoMap 工具的默认字符预算：工具调用是按需的，给得比常驻注入（6000）宽 */
export const TOOL_BUDGET_CHARS = 12_000;
/** 与 evidence 抽取器支持的语言对齐（extractExports 对未知家族返回空） */
const SOURCE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|pyi|go|java|kt|kts|cs|scala)$/i;
/** 三方库副本（其余目录名走 checkup 的共享 SKIP_DIR + skipHidden） */
const EXTRA_SKIP_DIRS = new Set(['vendor']);

export { DEFAULT_BUDGET_CHARS };

/**
 * 对外入口（fail-open）：构建失败/非 git 仓库都返回空串，调用方无需 try/catch。
 * @param {{cwd?:string, query?:string, budgetChars?:number, refresh?:boolean}} input
 * @param {object} [deps] 测试注入点
 */
export async function getRepoMap({ cwd, query = '', budgetChars = DEFAULT_BUDGET_CHARS, refresh = false } = {}, deps = {}) {
  try {
    return await buildRepoMap({ cwd, query, budgetChars, refresh }, deps);
  } catch (e) {
    logger.warn('repo-map', '构建失败（忽略，run 照跑）', { cwd, err: e?.message || String(e) });
    return '';
  }
}

/** 合并共享抽取器与附加抽取器（类方法）的符号：同名同行去重，附加层不覆盖共享层 */
function mergeSymbols(base, extra) {
  const seen = new Set(base.map((s) => `${s.name}@${s.line}`));
  const out = [...base];
  for (const s of extra) {
    const key = `${s.name}@${s.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** 纯判定：这条相对路径是否进地图（扩展名 + 测试文件 + 跳过目录） */
export function isSourcePath(rel) {
  if (!SOURCE_EXT_RE.test(rel)) return false;
  if (/(?:^|\/)(?:tests?|__tests__|spec|e2e)\//.test(rel) || /\.(?:test|spec)\.\w+$/.test(rel)) return false;
  const segs = String(rel).split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (EXTRA_SKIP_DIRS.has(segs[i]) || shouldSkipDir(segs[i], { skipHidden: true })) return false;
  }
  return true;
}

/**
 * 构建主体（依赖注入便于测试）。
 * @returns {Promise<string>} 地图正文；无可展示内容时 ''
 */
export async function buildRepoMap({ cwd, query = '', budgetChars = DEFAULT_BUDGET_CHARS, refresh = false } = {}, deps = {}) {
  const {
    trackedFn = gitTrackedFiles,
    statFn = (p) => fs.stat(p),
    readFn = (p) => fs.readFile(p, 'utf8'),
    cacheGet = getRepoMapCacheRecord,
    cachePut = putRepoMapCacheRecord,
    now = () => Date.now(),
  } = deps;

  const root = path.resolve(cwd || '.');
  const tracked = await trackedFn(root);
  if (!tracked) return ''; // 仅 git 仓库
  const rels = [...tracked].filter(isSourcePath).sort();
  if (!rels.length) return '';

  const deadline = now() + BUILD_DEADLINE_MS;
  const stats = [];
  for (const rel of rels) {
    try {
      const st = await statFn(path.join(root, rel));
      if (st.isFile()) stats.push({ rel, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* 已删除/无权限：当作不存在 */
    }
  }
  if (!stats.length) return '';

  const fingerprint = computeFingerprint(stats.map((s) => ({ path: s.rel, mtime: s.mtimeMs, size: s.size })));
  // refresh=true（RepoMap 工具的强制重建）：不信任任何旧解析记录，全量重解析；
  // 否则只在缓存版本一致时复用 per-file 记录（版本不一致 = 抽取器口径变了，必须重解析）。
  const cached = refresh ? null : cacheGet(root);
  // 复用按**文件级** mtime/size 判定，而不是仓库级指纹：任一文件变化都会改指纹，
  // 若以指纹为准就会把「改一个文件」放大成「全仓重解析」，增量形同虚设。
  // 指纹仍写进缓存，留给后续快速路径/诊断用。
  const prev = cached && cached.version === CACHE_VERSION && cached.files && typeof cached.files === 'object' ? cached.files : {};

  const files = {};
  let reparsed = 0;
  for (const s of stats) {
    const hit = prev[s.rel];
    if (hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size) {
      files[s.rel] = hit; // 未变：直接复用解析记录（增量的大部分收益在这）
      continue;
    }
    if (now() > deadline) break; // 超时：已解析部分先出图
    if (s.size > MAX_FILE_BYTES) {
      files[s.rel] = { mtimeMs: s.mtimeMs, size: s.size, skip: true, symbols: [], imports: [], tokens: [] };
      continue;
    }
    let text = '';
    try {
      text = await readFn(path.join(root, s.rel));
    } catch {
      continue;
    }
    files[s.rel] = {
      mtimeMs: s.mtimeMs,
      size: s.size,
      symbols: mergeSymbols(extractExports(text, s.rel), extractExtraSymbols(text, s.rel)),
      imports: extractImports(text, s.rel)
        .filter((x) => x.relative)
        .map((x) => x.target),
      tokens: extractTokens(text),
    };
    reparsed += 1;
  }
  if (!Object.keys(files).length) return '';

  try {
    cachePut(root, { version: CACHE_VERSION, fingerprint, files });
  } catch (e) {
    logger.warn('repo-map', '缓存写入失败（不影响本次输出）', { err: e?.message || String(e) });
  }
  if (reparsed) logger.info('repo-map', '地图增量更新', { reparsed, total: Object.keys(files).length });

  const rows = rankFiles(files, { queryTerms: extractQueryTerms(query) });
  return formatRepoMap(rows, { budgetChars });
}

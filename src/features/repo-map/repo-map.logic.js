/**
 * Repo map 纯函数层：查询词/标识符提取、引用与入度、排序（含查询加权）、预算裁剪、格式化。
 * 零 IO（文件内容由调用方读好传入），单测主战场。
 *
 * 与 project-checkup/evidence 的分工：符号抽取（extractExports）与 import 抽取复用那边；
 * 本层补的是「增量缓存需要的原料」——每文件标识符集合（引用计数的唯一依赖）与全局聚合。
 * 引用口径沿用 evidence#buildTokenIndex：按**文件集合**计数（同一文件出现多少次只算一次），
 * 只会高估引用、不会把活跃符号报低——对「找线索」而言宁可多给。
 */
import { isTestFile } from '../project-checkup/evidence/symbols.logic.js';

export const DEFAULT_BUDGET_CHARS = 6000;
export const MAX_SYMBOLS_PER_FILE = 8;
export const DECL_MAX = 100;
export const MAX_TOKENS_PER_FILE = 800;
export const MAX_FILE_BYTES = 256 * 1024;

/** 任务关键词停用词：频率高、指向性为零，留着只会把加权变成噪声 */
const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'import', 'export', 'const',
  'function', 'return', 'class', 'async', 'await', 'true', 'false', 'null', 'undefined', 'let',
  'var', 'new', 'type', 'interface', 'extends', 'default', 'module', 'require', 'while', 'else',
  'then', 'case', 'break', 'not', 'you', 'are', 'can', 'all', 'any', 'use', 'using', 'get', 'set',
]);

/** 拆标识符：camelCase / snake_case / kebab-case → 小写词数组 */
export function splitIdentifier(s) {
  return String(s ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_$.\-/]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/**
 * 从任务 prompt 提关键词（只取 ASCII 标识符词，拆词后去重、滤停用词）。
 * 纯中文任务提不出词 → 返回空数组 → 排序退化为全局引用度（预期行为，不是缺陷）。
 */
export function extractQueryTerms(prompt, { max = 12 } = {}) {
  const out = [];
  const seen = new Set();
  for (const m of String(prompt ?? '').matchAll(/[A-Za-z][A-Za-z0-9_$-]{2,}/g)) {
    for (const part of splitIdentifier(m[0])) {
      if (part.length < 3 || QUERY_STOPWORDS.has(part) || seen.has(part)) continue;
      seen.add(part);
      out.push(part);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** 每文件标识符集合（引用计数原料）。上限防病态文件把缓存撑爆。 */
export function extractTokens(text, { max = MAX_TOKENS_PER_FILE } = {}) {
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(/[A-Za-z_$][\w$]*/g)) {
    seen.add(m[0]);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/**
 * 聚合每个符号的引用信息（refs = 引用它的文件数，不含定义文件自身）。
 * @param {Record<string, {symbols:Array, tokens:Array}>} files
 * @param {(rel:string)=>boolean} isTest 判定「只有测试引用」用
 * @returns {Record<string, Array>} rel → symbols（附 refs/refFiles/refsFromTestsOnly）
 */
export function computeRefs(files, isTest = isTestFile) {
  const index = new Map(); // token → Set(rel)
  for (const [rel, rec] of Object.entries(files)) {
    for (const t of rec.tokens || []) {
      if (!index.has(t)) index.set(t, new Set());
      index.get(t).add(rel);
    }
  }
  const out = {};
  for (const [rel, rec] of Object.entries(files)) {
    out[rel] = (rec.symbols || []).map((sym) => {
      const holders = index.get(sym.name) || new Set();
      const refFiles = [...holders].filter((r) => r !== rel);
      return {
        ...sym,
        refs: refFiles.length,
        refFiles,
        refsFromTestsOnly: refFiles.length > 0 && refFiles.every((r) => isTest(r)),
      };
    });
  }
  return out;
}

/** import 目标 → 文件 rel 的模块键（去扩展名 + 去 /index、/mod），供入度解析 */
export function moduleKeys(rel) {
  const noExt = String(rel).replace(/\.[^./]+$/, '');
  const keys = new Set([String(rel), noExt, noExt.replace(/\/(?:index|mod)$/, '')]);
  return [...keys].filter(Boolean);
}

/** 入度：多少文件 import 了它（目标解析不到的不计；同文件多次 import 只算一次） */
export function computeInDegree(files) {
  const byKey = new Map();
  for (const rel of Object.keys(files)) {
    for (const k of moduleKeys(rel)) if (!byKey.has(k)) byKey.set(k, rel);
  }
  const deg = Object.fromEntries(Object.keys(files).map((r) => [r, 0]));
  for (const [rel, rec] of Object.entries(files)) {
    const seen = new Set();
    for (const target of rec.imports || []) {
      const hit = byKey.get(String(target));
      if (hit && hit !== rel && !seen.has(hit)) {
        seen.add(hit);
        deg[hit] += 1;
      }
    }
  }
  return deg;
}

function symbolScore(s) {
  return (s.refs || 0) + (s.refsFromTestsOnly ? 0.5 : 0);
}

/** 查询加权：符号名命中 +4/个（上限 5 个）；路径段命中 +1/个（上限 3）——生效但不过度偏置 */
export function queryBoost(rel, symbols, terms) {
  if (!terms || !terms.length) return 0;
  let hits = 0;
  for (const s of symbols) {
    const name = String(s.name || '').toLowerCase();
    if (terms.some((t) => name.includes(t))) hits += 1;
  }
  const parts = new Set(String(rel).toLowerCase().split(/[/\-_.]+/).filter(Boolean));
  const pathHits = terms.filter((t) => parts.has(t)).length;
  return Math.min(hits, 5) * 4 + Math.min(pathHits, 3);
}

/**
 * 排序：文件分 = topK 符号分之和 + 入度×2 + 查询加权；稳定按路径字典序。
 * @returns {Array<{rel, score, base, boost, inDegree, totalSymbols, symbols}>}
 */
export function rankFiles(files, { queryTerms = [], maxSymbolsPerFile = MAX_SYMBOLS_PER_FILE } = {}) {
  const enriched = computeRefs(files);
  const inDeg = computeInDegree(files);
  const rows = [];
  for (const rel of Object.keys(files)) {
    const symbols = [...(enriched[rel] || [])].sort(
      (a, b) => symbolScore(b) - symbolScore(a) || (a.line || 0) - (b.line || 0),
    );
    const top = symbols.slice(0, maxSymbolsPerFile);
    const base = top.reduce((n, s) => n + symbolScore(s), 0) + (inDeg[rel] || 0) * 2;
    const boost = queryBoost(rel, symbols, queryTerms);
    rows.push({
      rel,
      score: base + boost,
      base: Number(base.toFixed(2)),
      boost,
      inDegree: inDeg[rel] || 0,
      totalSymbols: symbols.length,
      symbols: top,
    });
  }
  rows.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return rows;
}

/** 默认的测试文件判定：与 checkup 的 isTestFile 同口径（computeRefs 的默认参数） */

function clipDecl(decl) {
  const s = String(decl ?? '').trim().replace(/\s+/g, ' ');
  return s.length > DECL_MAX ? s.slice(0, DECL_MAX - 1) + '…' : s;
}

/**
 * 格式化 + 预算裁剪：按分降序装文件，装不下**整体丢弃**（地图是索引不是正文）；
 * 空符号文件跳过；预算只够装下部分符号时保留文件行与放得下的符号（避免整图空白）。
 * @returns {string} 地图正文 + 一行统计脚注；无可展示内容返回 ''
 */
export function formatRepoMap(rows, { budgetChars = DEFAULT_BUDGET_CHARS } = {}) {
  const showcase = rows.filter((r) => r.symbols.length > 0);
  if (!showcase.length) return '';
  const total = showcase.length;
  const chunks = [];
  let used = 0;
  let shown = 0;

  for (const row of showcase) {
    const symLines = row.symbols.map((s) => `│ ${clipDecl(s.decl || s.name)}`);
    if (row.totalSymbols > row.symbols.length) symLines.push('⋮');
    const head = `${row.rel}  (${Math.round(row.score)})`;
    const chunk = [head, ...symLines].join('\n');
    const cost = chunk.length + 1;

    if (used + cost > budgetChars && shown > 0) break; // 装不下的文件整体丢弃
    if (used + cost > budgetChars) {
      // 首个文件就超预算：至少给出文件行与放得下的符号
      const kept = [head];
      let c = head.length + 1;
      for (const line of symLines) {
        if (c + line.length + 1 > budgetChars) break;
        kept.push(line);
        c += line.length + 1;
      }
      chunks.push(kept.join('\n'));
      used = c;
      shown = 1;
      break;
    }
    chunks.push(chunk);
    used += cost;
    shown += 1;
  }

  const footer = `（共 ${total} 个含导出符号的源文件，展示 ${shown} 个${shown < total ? '，已按预算裁剪' : ''}）`;
  return chunks.join('\n') + '\n' + footer;
}

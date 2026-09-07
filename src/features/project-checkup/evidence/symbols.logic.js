/**
 * 导出符号与引用计数（纯函数）——`naming` 与 `deadcode` 两个维度共用的取材层。
 *
 * ## 引用计数为什么走「一次性标识符索引」而不是逐个符号全仓搜
 *
 * 逐个搜是 O(符号数 × 文件数)：本仓库约 200 个文件、300+ 导出，等于六万次全文正则，
 * 每次都要重扫一遍文件内容。改成先把所有文件的标识符抽成一张 `token -> 出现在哪些文件`
 * 的索引（O(总 token 数)，扫一遍），之后每个符号的引用查询都是 O(1)。
 *
 * 代价是精度：索引不区分「同名的局部变量」和「真的引用了这个导出」。这是刻意接受的——
 * 它只会**高估**引用数，也就是只会漏报死代码，不会把活代码误报成死的。
 * 对 deadcode 这种「误报一次就让人删掉有用代码」的维度，宁可漏报。
 */
import { familyOf } from './units.logic.js';

/** 标识符 token：够宽以覆盖 JS/Py/Go/Java 的命名习惯 */
const TOKEN_RE = /[A-Za-z_$][\w$]*/g;

/**
 * 建一张「标识符 → 出现过它的文件集合」的索引。
 *
 * 用文件集合而不是出现次数：判死代码问的是「**别的地方**用不用它」，
 * 同一文件里出现 50 次（声明处自己的递归调用、同文件内部调用）说明不了任何事。
 *
 * @param {Array<{rel:string, text:string}>} files
 * @returns {Map<string, Set<string>>}
 */
export function buildTokenIndex(files = []) {
  const index = new Map();
  for (const f of files) {
    const seen = new Set();
    for (const m of String(f.text ?? '').matchAll(TOKEN_RE)) {
      const tok = m[0];
      if (seen.has(tok)) continue;
      seen.add(tok);
      if (!index.has(tok)) index.set(tok, new Set());
      index.get(tok).add(f.rel);
    }
  }
  return index;
}

/** 看起来像测试文件——引用只来自测试时，「死代码」的结论强度不一样，要让模型知道 */
export function isTestFile(rel) {
  return /(?:^|\/)(?:tests?|__tests__|spec)\//.test(rel)
    || /\.(?:test|spec)\.\w+$/.test(rel)
    || /(?:^|\/)test_\w+\.py$/.test(rel);
}

/** JS / TS 的导出形态。逐条对应一种真实写法，漏一种就少一批符号 */
const JS_PATTERNS = [
  { kind: 'function', re: /^export\s+(?:async\s+)?function\s+\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'class', re: /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'const', re: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', re: /^export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'commonjs', re: /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/ },
];

/** `export { a, b as c }`：括号里可能有多个符号，单独处理 */
const JS_EXPORT_LIST = /^export\s*\{([^}]*)\}/;

function extractJsExports(lines, rel) {
  const out = [];
  for (const ln of lines) {
    const s = ln.raw.trim();

    const listed = JS_EXPORT_LIST.exec(s);
    if (listed) {
      for (const part of listed[1].split(',')) {
        // `a as b` 对外暴露的是 b，那才是调用方会写的名字
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name && name !== 'default') out.push({ name, kind: 'reexport', line: ln.no, decl: s });
      }
      continue;
    }

    for (const p of JS_PATTERNS) {
      const m = p.re.exec(s);
      if (m) {
        out.push({ name: m[1], kind: p.kind, line: ln.no, decl: s });
        break;
      }
    }
  }
  return out;
}

function extractPyExports(lines) {
  const out = [];
  for (const ln of lines) {
    // 只认顶层（零缩进）：类方法不是模块的对外接口
    const m = /^(def|class)\s+([A-Za-z_]\w*)/.exec(ln.raw);
    // 单下划线前缀是 Python 的「内部」约定，本就不算导出
    if (m && !m[2].startsWith('_')) {
      out.push({ name: m[2], kind: m[1] === 'def' ? 'function' : 'class', line: ln.no, decl: ln.raw.trim() });
    }
  }
  return out;
}

function extractGoExports(lines) {
  const out = [];
  for (const ln of lines) {
    const s = ln.raw.trim();
    // Go 用首字母大写表达导出，语言本身就给了判据，不必猜
    const m = /^(?:func|type|var|const)\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/.exec(s);
    if (m) out.push({ name: m[1], kind: 'go-export', line: ln.no, decl: s });
  }
  return out;
}

function extractJavaExports(lines) {
  const out = [];
  for (const ln of lines) {
    const s = ln.raw.trim();
    const type = /^public\s+(?:final\s+|abstract\s+)?(class|interface|enum|record)\s+(\w+)/.exec(s);
    if (type) { out.push({ name: type[2], kind: type[1], line: ln.no, decl: s }); continue; }
    const method = /^public\s+(?:static\s+)?(?:final\s+)?[\w<>[\],.\s]+?\s+(\w+)\s*\(/.exec(s);
    if (method) out.push({ name: method[1], kind: 'method', line: ln.no, decl: s });
  }
  return out;
}

/**
 * 抽出一个文件的导出符号。
 *
 * @param {string} text
 * @param {string} rel
 * @returns {Array<{name:string, kind:string, line:number, decl:string}>}
 */
export function extractExports(text, rel) {
  if (familyOf(rel) === 'unknown') return [];
  const lines = String(text ?? '').split(/\r?\n/).map((raw, i) => ({ no: i + 1, raw }));

  if (/\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i.test(rel)) return extractJsExports(lines, rel);
  if (/\.pyi?$/i.test(rel)) return extractPyExports(lines);
  if (/\.go$/i.test(rel)) return extractGoExports(lines);
  if (/\.(?:java|kt|kts|cs|scala)$/i.test(rel)) return extractJavaExports(lines);
  return [];
}

/**
 * 汇总全仓导出符号并附上引用信息。
 *
 * 测试文件里的导出不收：测试用例本身就没有别的引用方，全量收进来会让 deadcode 维度
 * 被几百条「测试函数没人引用」的噪声淹掉，而那是测试框架去调的，不是死代码。
 *
 * @param {Array<{rel:string, text:string}>} files
 * @returns {Array<{name, kind, line, decl, file, refs:number, refFiles:string[], refsFromTestsOnly:boolean}>}
 */
export function collectExports(files = []) {
  const index = buildTokenIndex(files);
  const out = [];

  for (const f of files) {
    if (isTestFile(f.rel)) continue;
    for (const e of extractExports(f.text, f.rel)) {
      const hits = index.get(e.name);
      const refFiles = hits ? [...hits].filter((r) => r !== f.rel) : [];
      out.push({
        ...e,
        file: f.rel,
        refs: refFiles.length,
        refFiles: refFiles.slice(0, 8),
        refsFromTestsOnly: refFiles.length > 0 && refFiles.every(isTestFile),
      });
    }
  }

  return out;
}

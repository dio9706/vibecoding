/**
 * Repo map 的附加符号抽取器（Phase 2）：类方法 / 更细粒度符号。
 *
 * 为什么不改 `project-checkup/evidence/symbols.logic.js`：那份抽取器被 naming / deadcode
 * 两个体检维度共用，改抽取规则会连带改体检结果（spec §3.2 明文纪律）。本文件是
 * repo-map 私有的增量层——抽取结果只进代码地图，与体检无关。
 *
 * 覆盖范围（刻意克制）：
 * - JS/TS：class 体内的**方法签名**（含 async/static/getter/TS 修饰符），靠轻量词法扫描
 *   跟踪花括号深度定位类体；字符串/注释/模板字面量里的花括号不参与计数（否则深度全会错）。
 * - Python：class 体内与首个方法同缩进的 def（单下划线开头视为内部约定，不收）。
 * - 其余语言：[]（Go 的方法带 receiver 已被共享抽取器覆盖；Java 的 public 方法同理）。
 *
 * 失败模式：解析是启发式的，误判只会让地图多/少几行（地图是索引不是契约），
 * 调用方按 fail-open 处理——任何异常都会让整个文件退回「只有导出符号」。
 */

/** JS/TS 类方法签名：修饰符若干 + 名字 + 参数 + 可选返回类型 + `{` 收尾 */
const JS_METHOD_RE =
  /^\s*(?:(?:public|private|protected|readonly|abstract|declare|override|async|static|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::\s*[^={]+)?\{\s*$/;

/** 会被方法正则误吞的块语句关键字（`if (x) {` 的结构与方法一模一样） */
const JS_BLOCK_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'do', 'else', 'try', 'finally',
]);

/**
 * 轻量词法扫描：把字符串/注释/模板字面量清成空白，并给出每行的花括号深度。
 * 返回 `{ code, depth, endDepth }`：code=去噪后的行文本；depth=行首深度；endDepth=行尾深度。
 * 多行模板字面量保持 template 状态跨行（它内部的 `${}` 不参与深度）。
 */
export function scanJsStructure(text) {
  const src = String(text ?? '');
  const lines = [];
  let code = '';
  let depth = 0;
  let startDepth = 0;
  let state = 'code'; // code | line | block | single | double | template

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '\n') {
      lines.push({ code, depth: startDepth, endDepth: depth });
      code = '';
      startDepth = depth;
      if (state === 'line') state = 'code'; // 行注释到行尾结束；块注释/字符串/模板跨行保持
      continue;
    }
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i++; continue; }
      if (c === '/' && next === '*') { state = 'block'; i++; continue; }
      if (c === "'") { state = 'single'; continue; }
      if (c === '"') { state = 'double'; continue; }
      if (c === '`') { state = 'template'; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      code += c;
      continue;
    }
    if (state === 'single') { if (c === '\\') i++; else if (c === "'") state = 'code'; continue; }
    if (state === 'double') { if (c === '\\') i++; else if (c === '"') state = 'code'; continue; }
    if (state === 'template') { if (c === '\\') i++; else if (c === '`') state = 'code'; continue; }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i++; }
      continue;
    }
    // state === 'line'：等换行
  }
  if (code || src.endsWith('\n')) lines.push({ code, depth: startDepth, endDepth: depth });
  return lines;
}

/** JS/TS：class 体一层深度上的方法签名 */
export function extractJsClassMethods(text) {
  const out = [];
  let inClass = false;
  let classBase = -1;
  const lines = scanJsStructure(text);
  for (let idx = 0; idx < lines.length; idx++) {
    const { code, depth } = lines[idx];
    if (inClass && depth <= classBase) inClass = false; // 已回到类外
    if (!inClass && /\bclass\b/.test(code) && code.includes('{')) {
      inClass = true;
      classBase = depth;
    }
    if (inClass && depth === classBase + 1) {
      const m = JS_METHOD_RE.exec(code);
      if (m && !JS_BLOCK_KEYWORDS.has(m[1])) {
        out.push({ name: m[1], kind: 'method', line: idx + 1, decl: code.trim() });
      }
    }
  }
  return out;
}

/** Python：class 体内、与首个方法同缩进的 def（不含 `_` 前缀的内部名） */
export function extractPyClassMethods(text) {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  let inClass = false;
  let methodIndent = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    if (indent === 0) {
      inClass = /^class\s+[A-Za-z_]\w*/.test(trimmed);
      methodIndent = -1;
      continue;
    }
    if (!inClass) continue;
    const m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (!m) continue;
    if (methodIndent === -1) methodIndent = indent;
    if (indent === methodIndent && !m[1].startsWith('_')) {
      out.push({ name: m[1], kind: 'method', line: idx + 1, decl: trimmed });
    }
  }
  return out;
}

/**
 * @param {string} text 文件正文
 * @param {string} rel 相对路径（决定走哪族抽取器）
 * @returns {Array<{name:string, kind:'method', line:number, decl:string}>}
 */
export function extractExtraSymbols(text, rel) {
  const r = String(rel || '');
  if (/\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i.test(r)) return extractJsClassMethods(text);
  if (/\.pyi?$/i.test(r)) return extractPyClassMethods(text);
  return [];
}

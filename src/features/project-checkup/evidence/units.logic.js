/**
 * 语言无关的「代码单元」切分 —— 全部召回器的公共地基。
 *
 * ## 为什么不用语法树
 *
 * 本功能要对**任意项目**跑，语言不可预知（本仓库是 JS，用户的项目可能是 Python / Go / Java）。
 * 每加一门语言就接一个 parser，等于把维度数量乘以语言数量；而召回层的职责只是
 * 「把可疑的东西捞出来交给 LLM 判」——**漏掉的代价是少报一条，多捞的代价只是多花一次判定**，
 * 精度要求远低于编译器。所以这里用「行级正则 + 括号/缩进配平」，两套策略覆盖两大语法家族：
 *
 *   - 花括号族（js/ts/java/go/c/cpp/cs/rs/kt/swift/php/scala）：靠 `{}` 配平找单元边界
 *   - 缩进族（py）：靠缩进回落找单元边界
 *
 * 其余扩展名一律返回空单元列表——不认识的语言不猜函数边界，只由调用方保留文件级度量。
 *
 * ## 纯函数约定
 *
 * 本模块不 import fs。文件内容由调用方读好后传入，因此每个函数都可直测。
 */

/** 花括号族扩展名 */
const BRACE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'java', 'go', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'rs', 'kt', 'kts', 'swift', 'php', 'scala', 'groovy', 'dart',
]);

/** 缩进族扩展名 */
const INDENT_EXT = new Set(['py', 'pyi']);

/**
 * 控制流关键字。
 *
 * 函数声明靠「标识符 + 左括号」识别，而 `if (`、`for (`、`while (` 在字面上与它完全同构。
 * 不排除掉的话，一个有 20 个 if 的文件会被报成 20 个「函数」，后面的行数与嵌套度量全部错位。
 */
const CONTROL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'catch', 'try', 'finally',
  'return', 'new', 'typeof', 'instanceof', 'await', 'throw', 'delete', 'void',
  'with', 'using', 'match', 'when', 'in', 'of', 'as', 'is', 'and', 'or', 'not',
  'require', 'import', 'print', 'assert', 'yield', 'lock', 'synchronized', 'sizeof',
]);

/**
 * 声明引导词：它们后面才是真正的函数名。
 *
 * Go 的方法 `func (s *Server) Handle(w, r)` 会让「第一个 标识符+( 」匹配到 `func (s *Server)`，
 * 于是函数名记成 `func`、参数数记成 1。名字只用于展示，但参数数会进判据，所以要跳过一层重匹配。
 */
const DECL_KEYWORDS = new Set(['func', 'function', 'fn', 'def', 'sub', 'proc', 'method']);

export function extOf(rel) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(rel || ''));
  return m ? m[1].toLowerCase() : '';
}

/** 这个文件的语法家族。unknown = 不认识，不猜函数边界 */
export function familyOf(rel) {
  const ext = extOf(rel);
  if (BRACE_EXT.has(ext)) return 'brace';
  if (INDENT_EXT.has(ext)) return 'indent';
  return 'unknown';
}

/**
 * 把源码切成行，并标注每行是否「有效代码行」。
 *
 * 有效行 = 非空、非纯注释。所有长度度量（函数行数、重复块长度）一律按有效行算：
 * 一个 80 行里 60 行是注释的函数不该被报成「过长」——本仓库的代码风格就是重注释，
 * 按物理行算会把每个精心注释过的函数全部误报，噪声压过信号。
 */
export function toLines(text) {
  const raw = String(text ?? '').split(/\r?\n/);
  let inBlock = false;
  return raw.map((line, i) => {
    const trimmed = line.trim();
    let significant = trimmed.length > 0;

    if (inBlock) {
      significant = false;
      if (trimmed.includes('*/')) inBlock = false;
    } else if (trimmed.startsWith('/*')) {
      significant = false;
      if (!trimmed.includes('*/')) inBlock = true;
    } else if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
      significant = false;
    }

    return { no: i + 1, raw: line, trimmed, significant };
  });
}

/** 去掉字符串字面量与行内注释：不做的话括号配平会被字符串里的 `{` 带偏 */
export function stripLiterals(line) {
  return String(line ?? '')
    .replace(/\\./g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\/\/.*$/, '');
}

function netBraces(line) {
  const s = stripLiterals(line);
  let n = 0;
  for (const ch of s) {
    if (ch === '{') n += 1;
    else if (ch === '}') n -= 1;
  }
  return n;
}

/**
 * 参数列表后面剩下的东西，看起来像不像「函数体即将开始」。
 *
 * `after` 为空时**必须**真的看到下一行以 `{` 开头才放行。原先无条件放行是为了支持
 * 花括号写在下一行的 Allman 风格，代价是一句没加分号的裸调用（`doThing(x)`，JS 靠 ASI 合法）
 * 也被当成函数声明起点——那个假单元不会立刻收尾，会一路把后面真正的函数整个吞进去。
 */
function looksLikeBody(after, nextLine) {
  const s = String(after).trim();
  if (s.startsWith('=>')) return true; // 箭头函数
  // 单行函数体 `foo() { return 1; }` 走 startsWith；
  // 带返回类型标注 / throws / const / override 的走 endsWith
  if (s.startsWith('{') || s.endsWith('{')) return true;
  if (s === '' && nextLine !== null && nextLine !== undefined) {
    return String(nextLine).trim().startsWith('{');
  }
  return false;
}

/**
 * 花括号族的函数声明识别。
 *
 * 覆盖四种写法，漏一种就会让 complexity 维度对某类代码风格整体失灵：
 *   1. `function foo(...) {` / `async function foo(...) {`
 *   2. 方法简写 `foo(...) {`（类成员、对象字面量）
 *   3. 箭头/lambda 赋值 `const foo = (...) => {`
 *   4. 带修饰符与返回类型 `public static List<X> foo(...) {`（Java / C# / Go / Rust）
 *
 * @param {string} line 待判定的行
 * @param {string|null} [nextLine] 下一行，仅用于判定 Allman 风格（花括号独占下一行）
 * @returns {{name:string, params:string}|null}
 */
export function matchFunctionDecl(line, nextLine = null) {
  const s = stripLiterals(line).trim();
  // 以 } ) . 开头的行是上一个块的收尾或链式调用，不可能是声明起点
  if (!s || s.startsWith('}') || s.startsWith(')') || s.startsWith('.')) return null;

  // 箭头赋值先试：它的形状最特殊（`= (...) =>`），放后面会被通用分支抢走
  const arrow = /\b(?:const|let|var|val|readonly|private|public|static)?\s*([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\s*)?\(([^)]*)\)\s*(?::[^=]*?)?=>/.exec(s);
  if (arrow) return { name: arrow[1], params: arrow[2] };

  const re = /([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  let m = re.exec(s);
  // 声明引导词后面才是真名，跳过一层再匹配
  if (m && DECL_KEYWORDS.has(m[1])) {
    const next = re.exec(s);
    if (next) m = next;
  }
  if (!m) return null;
  if (CONTROL_KEYWORDS.has(m[1])) return null;
  if (!looksLikeBody(s.slice(m.index + m[0].length), nextLine)) return null;

  return { name: m[1], params: m[2] };
}

/** Python 的 def/class 识别 */
function matchIndentDecl(line) {
  const m = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?/.exec(String(line ?? ''));
  if (!m) return null;
  return { indent: m[1].length, kind: m[2], name: m[3], params: m[4] || '' };
}

/** 顶层参数个数：括号/尖括号内的逗号不算（`Map<K,V> m` 是一个参数） */
export function countParams(params) {
  const s = String(params ?? '').trim();
  if (!s) return 0;
  let depth = 0;
  let n = 1;
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '<' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '>' || ch === '}') depth -= 1;
    else if (ch === ',' && depth <= 0) n += 1;
  }
  return n;
}

/**
 * 允许开启新单元的最大外层深度。
 *
 * 必须 > 0：Java / C# 的方法都在 class 花括号里（深度 1），C++ 还多一层 namespace（深度 2）。
 * 原先卡在「深度必须为 0」，效果是**这些语言一个方法都检测不到**，整个维度对它们静默失效。
 * 卡在 2 而不放开：更深的只会是回调与闭包，它们应当算进外层函数的行数——
 * 「一个函数里塞了三个大回调」本身就是该拆的信号，拆开统计反而让外层看起来很短。
 */
const MAX_DECL_DEPTH = 2;

function sliceBraceUnits(lines) {
  const units = [];
  let depth = 0;
  let cur = null;

  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    if (!cur && depth <= MAX_DECL_DEPTH) {
      const decl = matchFunctionDecl(ln.raw, lines[i + 1] ? lines[i + 1].raw : null);
      if (decl) {
        cur = {
          name: decl.name,
          params: countParams(decl.params),
          startLine: ln.no,
          endLine: ln.no,
          significant: 0,
          maxDepth: 0,
          baseDepth: depth,
          sawBody: false,
          rawLines: [],
        };
      }
    }

    if (cur) {
      cur.rawLines.push(ln.raw);
      if (ln.significant) cur.significant += 1;
      cur.endLine = ln.no;
    }

    const before = depth;
    depth += netBraces(ln.raw);
    if (depth < 0) depth = 0;

    if (!cur) continue;

    // 进过函数体才允许结束判定。少了这个标志，单行函数体
    // `foo() { return 1; }`（净括号为 0）会永远等不到收尾，把后面整个文件都吞进来
    if (depth > cur.baseDepth || stripLiterals(ln.raw).includes('{')) cur.sawBody = true;

    // 嵌套深度按「函数体内部的相对深度」算，函数自身那一层不计：
    // 一个完全没有分支的函数应当是 0，不是 1
    const rel = Math.max(0, Math.max(before, depth) - cur.baseDepth - 1);
    if (rel > cur.maxDepth) cur.maxDepth = rel;

    if (cur.sawBody && depth <= cur.baseDepth) {
      units.push(cur);
      cur = null;
    }
  }

  // 括号没配平（模板字符串里的 `{`、预处理宏等）→ 残留单元也交出去，截到文件末尾。
  // 丢掉它等于让每个文件的最后一个函数永远不被检查
  if (cur) units.push(cur);
  return units;
}

/** 切出缩进族（Python）的函数单元：缩进回落到声明层级即结束 */
function sliceIndentUnits(lines) {
  const units = [];
  let cur = null;

  const close = (endLine) => {
    if (!cur) return;
    cur.endLine = endLine;
    units.push(cur);
    cur = null;
  };

  for (const ln of lines) {
    const decl = matchIndentDecl(ln.raw);
    // 只认顶层与类方法（声明缩进不深于当前单元）；更深的嵌套算进外层
    if (decl && decl.kind === 'def' && (!cur || decl.indent <= cur.indent)) {
      close(ln.no - 1);
      cur = {
        name: decl.name,
        params: countParams(decl.params),
        indent: decl.indent,
        startLine: ln.no,
        endLine: ln.no,
        significant: 0,
        maxDepth: 0,
        rawLines: [],
      };
    }

    if (!cur) continue;

    const indent = /^(\s*)/.exec(ln.raw)[1].length;
    if (ln.significant && indent <= cur.indent && ln.no > cur.startLine) {
      close(ln.no - 1);
      continue;
    }

    cur.rawLines.push(ln.raw);
    if (ln.significant) {
      cur.significant += 1;
      // Python 没有花括号，只能按缩进宽度估层级；按 4 空格一层取整
      const rel = Math.max(0, Math.round((indent - cur.indent) / 4) - 1);
      if (rel > cur.maxDepth) cur.maxDepth = rel;
    }
    cur.endLine = ln.no;
  }

  close(lines.length);
  return units;
}

/**
 * 切出一个文件里的全部函数单元。
 *
 * @param {string} text 文件内容
 * @param {string} rel 相对路径（决定语法家族）
 * @returns {Array<{name:string, params:number, startLine:number, endLine:number,
 *   significant:number, maxDepth:number, rawLines:string[]}>}
 */
export function sliceUnits(text, rel) {
  const family = familyOf(rel);
  if (family === 'unknown') return [];
  const lines = toLines(text);
  return family === 'brace' ? sliceBraceUnits(lines) : sliceIndentUnits(lines);
}

/** 文件级度量：总行数与有效行数 */
export function measureFile(text) {
  const lines = toLines(text);
  return { total: lines.length, significant: lines.filter((l) => l.significant).length };
}

/**
 * 把代码块归一化成「结构指纹」的输入。
 *
 * 归一化掉什么，决定了重复检测的口径：
 *   - 标识符**不**归一：两段结构相同但操作不同变量的代码不算重复，
 *     抽取它们只会造出一个参数一大把的函数，比重复更糟。
 *   - 字符串/数字字面量归一：同一段逻辑处理不同常量，正是该抽参数的典型重复。
 *   - 空白与注释归一：复制粘贴后重排缩进、改了注释，仍然是同一份重复。
 */
export function normalizeForDuplicate(rawLines) {
  return (rawLines || [])
    .map((l) => String(l).trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('*') && !l.startsWith('/*'))
    .map((l) => stripLiterals(l)
      .replace(/''|""|``/g, 'S')
      .replace(/\b\d+(?:\.\d+)?\b/g, 'N')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n');
}

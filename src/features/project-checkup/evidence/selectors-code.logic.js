/**
 * 代码级召回器（纯函数）：从已读入的源文件里捞出「可疑但不确定」的候选，交给 LLM 判定。
 *
 * ## 召回层的唯一职责是「不漏」，不是「判对」
 *
 * 每个召回器都刻意宽松：宁可多捞几条让模型判成 acceptable，也不要因为阈值调得太严
 * 而让整类问题从不出现。这个取舍成立的前提是**判定层由 LLM 兜着**——
 * 静态维度（hygiene）没有这一层，所以那边必须做成零误报，两者的口径不同不是不一致。
 *
 * ## 统一候选形状
 *
 * 全部召回器返回 `{file, line, text, meta}`：
 *   - `file` / `line` 是**给用户看的定位**，也是审计引擎重锚定判定结果的键（见 audit-engine）
 *   - `text` 是喂给模型的证据正文，长度由各召回器自己截断
 *   - `meta` 是判定用不到但展示/修复要用的结构化数据（行数、嵌套深度、引用数……）
 *
 * 本模块不 import fs：文件内容由 `collect.js` 读好后传入。
 */
import { sliceUnits, normalizeForDuplicate, toLines, stripLiterals, familyOf } from './units.logic.js';
import { isTestFile } from './symbols.logic.js';

/* ==================== complexity ==================== */

/**
 * 复杂度阈值。
 *
 * 数字来源：《代码整洁之道》ch3 主张函数「小到一屏」；《代码大全》ch7.4 的实证结论是
 * 例程超过约 200 行后缺陷密度显著上升、100 行以内基本安全。这里取 60 **有效行**
 * （注释不计，见 units.logic.js 的 toLines），落在两者之间偏严的一侧——
 * 因为召回宽松的代价只是多一次判定，而判定由模型做，它会把「82 行的 prompt 模板」
 * 这类长但合理的函数判成 acceptable。
 *
 * 嵌套深度 > 4 与参数 > 5 是另外两个独立信号：一个 30 行但嵌套 6 层的函数比 80 行的平铺函数难读得多。
 */
const UNIT_LINES = 60;
const UNIT_DEPTH = 4;
const UNIT_PARAMS = 5;
const FILE_LINES = 600;

/** 送进模型的单元正文上限：够看清结构，不必整段喂 */
const UNIT_CLIP_LINES = 45;

function clipUnit(unit) {
  const body = unit.rawLines.slice(0, UNIT_CLIP_LINES).join('\n');
  return unit.rawLines.length > UNIT_CLIP_LINES
    ? `${body}\n… (还有 ${unit.rawLines.length - UNIT_CLIP_LINES} 行未展示)`
    : body;
}

/** 为什么这个单元进了候选 —— 写进 text 让模型知道该看哪一点 */
function complexityReasons(u) {
  const r = [];
  if (u.significant > UNIT_LINES) r.push(`有效行 ${u.significant}（阈值 ${UNIT_LINES}）`);
  if (u.maxDepth > UNIT_DEPTH) r.push(`最大嵌套 ${u.maxDepth} 层（阈值 ${UNIT_DEPTH}）`);
  if (u.params > UNIT_PARAMS) r.push(`参数 ${u.params} 个（阈值 ${UNIT_PARAMS}）`);
  return r;
}

export function recallOversizedUnits({ files = [] } = {}) {
  const out = [];

  for (const f of files) {
    for (const u of sliceUnits(f.text, f.rel)) {
      const reasons = complexityReasons(u);
      if (!reasons.length) continue;
      out.push({
        file: f.rel,
        line: u.startLine,
        text: `函数 ${u.name}（${f.rel}:${u.startLine}-${u.endLine}）超阈值：${reasons.join('、')}\n\n${clipUnit(u)}`,
        meta: {
          kind: 'unit',
          name: u.name,
          significant: u.significant,
          maxDepth: u.maxDepth,
          params: u.params,
          endLine: u.endLine,
        },
      });
    }

    // 巨型文件单独成一条候选。它与「函数过长」是两个问题：一个 800 行的文件
    // 可能每个函数都只有 20 行，问题在于职责太多（SRP），修法是拆文件而不是拆函数
    if (f.measure.significant > FILE_LINES) {
      out.push({
        file: f.rel,
        line: 1,
        text: `文件 ${f.rel} 共 ${f.measure.significant} 有效行（阈值 ${FILE_LINES}），`
          + `含 ${sliceUnits(f.text, f.rel).length} 个函数单元。`
          + `\n\n文件开头 30 行：\n${f.text.split(/\r?\n/).slice(0, 30).join('\n')}`,
        meta: { kind: 'file', significant: f.measure.significant },
      });
    }
  }

  return out;
}

/* ==================== duplication ==================== */

/** 重复块的最小规模：低于这个有效行数的雷同（getter、单行转发）是正常的，报出来只是噪声 */
const DUP_MIN_LINES = 6;

/**
 * 找出结构完全相同的函数单元组。
 *
 * 只比对**函数单元**而不是滑动窗口：滑动窗口会为同一处重复产出一堆互相重叠的候选
 * （8 行窗口在一段 20 行的重复里能命中 13 次），既刷爆候选量又让模型反复判同一件事。
 * 以函数为粒度还有个附带好处——它正好是抽取重构的单位。
 *
 * 归一化口径见 units.logic.js 的 normalizeForDuplicate（字面量归一、标识符不归一）。
 */
export function recallSimilarBlocks({ files = [] } = {}) {
  const groups = new Map(); // 归一化正文 -> [{file, line, name, endLine}]

  for (const f of files) {
    for (const u of sliceUnits(f.text, f.rel)) {
      // 指纹只取**函数体**，跳过声明行。把声明行算进去的话，函数名成了指纹的一部分，
      // 于是「复制一份再改个名字」——最典型的重复形态——永远匹配不上，整个维度形同虚设
      const key = normalizeForDuplicate(u.rawLines.slice(1));
      if (!key) continue;
      // 归一化已经滤掉空行与注释，所以行数就是有效行数
      if (key.split('\n').length < DUP_MIN_LINES) continue;
      if (!groups.has(key)) groups.set(key, { sample: u, sites: [] });
      groups.get(key).sites.push({ file: f.rel, line: u.startLine, name: u.name, endLine: u.endLine });
    }
  }

  const out = [];
  for (const { sample, sites } of groups.values()) {
    if (sites.length < 2) continue;
    const where = sites.map((s) => `${s.file}:${s.line}（${s.name}）`).join('\n  ');
    out.push({
      // 以第一处为定位锚点：issue 必须落在一个具体位置才能在 UI 里点开
      file: sites[0].file,
      line: sites[0].line,
      text: `以下 ${sites.length} 处的函数体结构完全相同（仅字面量或变量名不同）：\n  ${where}\n\n`
        + `第一处正文：\n${clipUnit(sample)}`,
      meta: { kind: 'duplicate', sites, significant: sample.significant },
    });
  }

  return out;
}

/* ==================== naming ==================== */

/**
 * 低信息量命名的召回规则。
 *
 * 这些词本身没错，错在**它们作为一个导出符号的全名**时不携带任何领域信息：
 * 一个叫 `handler` 的导出，调用方从名字里得不到任何关于「处理什么」的线索
 * （《代码整洁之道》ch2「名副其实」）。作为**前缀/后缀**出现是正常的
 * （`handleRunStart` 很清楚），所以这里只做全词匹配。
 */
const VAGUE_WHOLE_NAMES = new Set([
  'data', 'info', 'item', 'items', 'list', 'obj', 'object', 'value', 'val', 'temp', 'tmp',
  'util', 'utils', 'helper', 'helpers', 'common', 'misc', 'stuff', 'thing', 'things',
  'manager', 'handler', 'handle', 'process', 'doit', 'run2', 'foo', 'bar', 'baz',
  'result', 'res', 'ret', 'out', 'x', 'y', 'z', 'a', 'b', 'c', 'fn', 'cb', 'e',
]);

/** 无元音且够长 = 生造缩写（`mgr` `usr` `cfgSvc`）。三字母以内不算，那是公认缩写（id / db / io） */
function isVowellessAbbrev(name) {
  return name.length >= 4 && !/[aeiouAEIOU]/.test(name);
}

/** 只有数字后缀区分的同名符号（`parse` / `parse2`）—— 典型的「改不动旧的就复制一份」 */
function digitSuffixPairs(names) {
  const bare = new Map();
  for (const n of names) {
    const m = /^(.*?)(\d+)$/.exec(n.name);
    if (!m || !m[1]) continue;
    if (!bare.has(m[1])) bare.set(m[1], []);
    bare.get(m[1]).push(n);
  }
  const out = [];
  for (const [stem, group] of bare) {
    if (names.some((n) => n.name === stem)) out.push(...group);
  }
  return out;
}

export function recallVagueNames({ exports: allExports = [] } = {}) {
  const flagged = new Map(); // `${file}#${line}` -> {entry, reasons}

  const flag = (e, reason) => {
    const key = `${e.file}#${e.line}`;
    if (!flagged.has(key)) flagged.set(key, { entry: e, reasons: [] });
    flagged.get(key).reasons.push(reason);
  };

  for (const e of allExports) {
    const lower = e.name.toLowerCase();
    if (VAGUE_WHOLE_NAMES.has(lower)) flag(e, '全名是通用词，不携带领域信息');
    else if (e.name.length <= 2) flag(e, '名字过短（≤2 字符）');
    else if (isVowellessAbbrev(e.name)) flag(e, '无元音的生造缩写');
  }
  for (const e of digitSuffixPairs(allExports)) flag(e, '与同名符号仅靠数字后缀区分');

  return [...flagged.values()].map(({ entry, reasons }) => ({
    file: entry.file,
    line: entry.line,
    text: `导出符号 \`${entry.name}\`（${entry.kind}）命名可疑：${reasons.join('；')}\n\n`
      + `声明处：${entry.decl}\n仓库内被引用 ${entry.refs} 次`,
    meta: { kind: 'name', name: entry.name, refs: entry.refs, symbolKind: entry.kind },
  }));
}

/* ==================== deadcode ==================== */

/** 连续被注释掉的代码行达到这个数量才算「注释掉的代码块」，低于此多为示例或说明 */
const COMMENTED_BLOCK_MIN = 3;

/** 一行注释里剩下的内容像不像代码（而不是自然语言说明） */
function looksLikeCode(body) {
  const s = body.trim();
  if (!s || s.length < 4) return false;
  // 中文说明一律排除：本仓库注释是中文，把它们当死代码报出来会淹掉真正的信号
  if (/[一-龥]/.test(s)) return false;
  return /[;{}]\s*$/.test(s) || /^(?:const|let|var|function|class|import|export|return|if|for|while|def|public|private)\b/.test(s)
    || /^[\w.$]+\s*\(.*\)\s*;?$/.test(s) || /^[\w.$]+\s*=[^=]/.test(s);
}

export function recallDeadCode({ files = [], exports: allExports = [] } = {}) {
  const out = [];

  // ---- 零引用 / 只被自己的测试引用的导出 ----
  //
  // 「只被测试引用」也收：一个只有测试在调的导出，要么是真的没人用了（测试是唯一遗留调用方），
  // 要么是刻意导出来给测试的（本仓库 `*.logic.js` 就是这个形状）。两者外观完全相同、
  // 只有读了代码才分得出——正是该交给模型判的形状，所以两类都进候选，判据在 rubric 里给死。
  for (const e of allExports) {
    if (e.refs > 0 && !e.refsFromTestsOnly) continue;
    const testsOnly = e.refs > 0;
    out.push({
      file: e.file,
      line: e.line,
      text: testsOnly
        ? `导出符号 \`${e.name}\`（${e.kind}）只被测试文件引用，生产代码里没有任何调用方。\n\n`
          + `声明处：${e.decl}\n引用方：${e.refFiles.join('、')}`
        : `导出符号 \`${e.name}\`（${e.kind}）在整个仓库内找不到任何引用。\n\n`
          + `声明处：${e.decl}\n所在文件：${e.file}`,
      meta: {
        kind: testsOnly ? 'test-only-export' : 'unused-export',
        name: e.name,
        symbolKind: e.kind,
        refFiles: e.refFiles,
      },
    });
  }

  // ---- 被注释掉的代码块 ----
  for (const f of files) {
    if (familyOf(f.rel) === 'unknown') continue;
    const lines = f.text.split(/\r?\n/);
    let run = [];
    const flush = (endIdx) => {
      if (run.length >= COMMENTED_BLOCK_MIN) {
        out.push({
          file: f.rel,
          line: run[0].no,
          text: `${f.rel}:${run[0].no}-${run[run.length - 1].no} 连续 ${run.length} 行被注释掉的代码：\n\n`
            + run.map((r) => r.raw).join('\n'),
          meta: { kind: 'commented-code', lines: run.length, endLine: run[run.length - 1].no },
        });
      }
      run = [];
      return endIdx;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const t = lines[i].trim();
      const m = /^(?:\/\/|#)\s?(.*)$/.exec(t);
      if (m && looksLikeCode(m[1])) run.push({ no: i + 1, raw: lines[i] });
      else flush(i);
    }
    flush(lines.length);
  }

  return out;
}

/* ==================== errors ==================== */

/** 只做日志、不做任何处置的 catch —— 表面上处理了，实际把故障吞成了「一切正常」 */
const LOG_ONLY = /^(?:console\.\w+|logger?\.\w+|log\.\w+|print|printf|fmt\.Print\w*|System\.out\.print\w*)\s*\(/;

/**
 * 等价于「什么都没做」的 catch 体。
 *
 * `pass` 必须算进这一类而不是「只打日志」：Python 里 `except: pass` 是静默吞异常的
 * 标准写法，把它归成 log-only 会让 issue 的措辞（「只打日志」）与实际情况不符，
 * 而这条 issue 的全部价值就在于准确说出「异常去哪了」。
 */
const SILENT_BODY = new Set(['pass', ';', '{}', 'return', 'return;', 'null', 'None', 'continue', 'break']);

export function recallCatchBlocks({ files = [] } = {}) {
  const out = [];

  for (const f of files) {
    if (familyOf(f.rel) === 'unknown') continue;
    const lines = toLines(f.text);

    for (let i = 0; i < lines.length; i += 1) {
      const s = stripLiterals(lines[i].raw).trim();
      const isCatch = /\bcatch\s*(?:\([^)]*\))?\s*\{?\s*$/.test(s)
        || /^except\b.*:\s*$/.test(s)
        || /^rescue\b/.test(s);
      if (!isCatch) continue;

      // 收集 catch 体：花括号族到配平为止，缩进族到缩进回落为止。
      // 只取前 12 行——判「有没有处置」看开头就够，整段吞进来只是浪费 token。
      //
      // 分两份收：`body` 只含有效代码行（用于分类），`shown` 连注释一起收（用于送判）。
      // 注释必须送进去：本仓库大量写着 `catch { /* 连接已断，忽略 */ }`——**那句注释就是
      // 「为什么可以忽略」的论证**。只把空体交给模型，它看到的是一个无理由的静默吞异常，
      // 只能判成问题；把注释一起给它，它才判得出这是深思熟虑过的。
      const body = [];
      const shown = [];
      let depth = s.includes('{') ? 1 : 0;
      const baseIndent = /^(\s*)/.exec(lines[i].raw)[1].length;
      for (let j = i + 1; j < lines.length && shown.length < 12; j += 1) {
        const raw = lines[j].raw;
        const stripped = stripLiterals(raw);
        if (depth > 0) {
          for (const ch of stripped) {
            if (ch === '{') depth += 1;
            else if (ch === '}') depth -= 1;
          }
          if (depth <= 0) break;
        } else if (lines[j].significant && /^(\s*)/.exec(raw)[1].length <= baseIndent) {
          break;
        }
        if (raw.trim()) shown.push(raw.trim());
        if (lines[j].significant) body.push(raw.trim());
      }
      // 单行写法 `catch { /* 忽略 */ }` 的注释在 catch 那一行上，不在后续行里
      const inlineNote = /\/\*([^*]*)\*\/|\/\/(.*)$/.exec(lines[i].raw);
      if (inlineNote && !shown.length) shown.push((inlineNote[1] || inlineNote[2] || '').trim());

      const swallowsSilently = body.length === 0 || body.every((b) => SILENT_BODY.has(b));
      const logsOnly = !swallowsSilently && body.every((b) => LOG_ONLY.test(b));
      // 只捞可疑的：既没吞掉也不只是打日志的 catch，绝大多数是正常处理，不必花判定额度
      if (!swallowsSilently && !logsOnly) continue;

      out.push({
        file: f.rel,
        line: i + 1,
        text: `${f.rel}:${i + 1} 的异常处理${swallowsSilently ? '**没有任何处置代码**' : '**只打日志、无任何处置**'}：\n\n`
          + `${lines[i].raw.trim()}\n${shown.map((b) => `  ${b}`).join('\n')}`,
        meta: {
          kind: swallowsSilently ? 'silent-catch' : 'log-only-catch',
          bodyLines: body.length,
          hasNote: shown.length > body.length,
        },
      });
    }
  }

  return out;
}

/* ==================== security ==================== */

/**
 * 危险模式表。
 *
 * 每条都对着 OWASP Top 10 的一类：硬编码凭证(A07 认证失效)、命令/代码注入(A03)、
 * 反序列化(A08)、弱哈希(A02 加密失败)、明文传输(A02)。
 *
 * 刻意**不**用「熵值检测」找密钥：高熵字符串在源码里遍地都是（哈希常量、base64 图标、
 * 测试夹具），误报率高到会让整个维度失去可信度。这里只认「变量名点明了这是凭证 + 赋了字面量」
 * 这一种形状——它的误报几乎只有一类（测试用的假凭证），而那正好是 LLM 一眼能判的。
 */
const RISKY_PATTERNS = [
  {
    kind: 'hardcoded-credential',
    re: /\b(?:api[_-]?key|secret|password|passwd|token|credential|private[_-]?key|access[_-]?key)\w*\s*[:=]\s*['"][^'"]{8,}['"]/i,
    note: '疑似把凭证以字面量写进源码（OWASP A07）',
    // 唯一在测试文件里也要报的一类：凭证一旦提交，不会因为它在测试文件里就不进 git 历史
    keepInTests: true,
  },
  {
    kind: 'code-injection',
    // 负向前瞻挡掉方法调用形式。原先用 `\bexec\s*\(`，而 `\b` 在 `.` 与 `e` 之间成立，
    // 于是每一处 `regex.exec(str)` 都被报成命令执行——本仓库遍地都是，实测刷出 34 条假候选
    re: /(?<![.\w$])(?:eval|execSync|exec|system|popen|shell_exec)\s*\(|new\s+Function\s*\(|Runtime\.getRuntime\(\)\s*\.\s*exec\s*\(/,
    note: '动态执行代码/命令，若参数含外部输入即为注入面（OWASP A03）',
  },
  {
    kind: 'unsafe-html',
    re: /\.(?:inner|outer)HTML\s*=|insertAdjacentHTML\s*\(|dangerouslySetInnerHTML|v-html\s*=/,
    // 关键词是「**裸**写入」。只匹配 `.innerHTML =` 会把三类无风险写法一起捞进来，
    // 实测本仓库 122 条候选里绝大多数都是它们：
    //   1. `el.innerHTML = ''` —— 清空节点的惯用写法，没有任何注入面
    //   2. 纯静态模板字面量 —— 内容全部由代码写死，没有外部输入
    //   3. 已经过 escapeHtml / renderMarkdown 消毒的插值 —— 本仓库的既定消毒口径
    // 所以真正的判据是「插值了外部数据，且没走消毒函数」，光靠模式匹配表达不出来，
    // 需要这一层 refine。
    refine: (raw) => {
      const rhs = raw.slice(raw.indexOf('=') + 1);
      if (/^\s*(?:''|""|``)\s*;?\s*$/.test(rhs)) return false;
      if (/escapeHtml|escapeAttr|sanitiz|renderMarkdown|DOMPurify|textContent/i.test(raw)) return false;
      // 没有插值、也没有变量拼接 → 静态标记
      return /\$\{|\+\s*[A-Za-z_$]|^\s*[A-Za-z_$][\w$.]*\s*;?\s*$/.test(rhs);
    },
    note: '把含外部数据的 HTML 未经消毒直接写入 DOM，即 XSS 面（OWASP A03）',
  },
  {
    kind: 'unsafe-deserialize',
    re: /\b(?:pickle\.loads|yaml\.load\s*\((?![^)]*Safe)|ObjectInputStream|unserialize)\s*\(/,
    note: '不安全的反序列化（OWASP A08）',
  },
  {
    kind: 'weak-hash',
    re: /(?<![.\w$])(?:md5|sha1)\s*\(|createHash\s*\(\s*['"](?:md5|sha1)['"]/i,
    note: '弱哈希算法；若用于口令或签名即为缺陷（OWASP A02）',
  },
  {
    kind: 'cleartext-transport',
    // w3.org / schemas 是 XML 命名空间标识符，不是网络地址——每一段内联 SVG 都带
    // `xmlns="http://www.w3.org/2000/svg"`，不排除会让这一类几乎全是假候选（实测 33 条里 33 条）
    re: /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|[\w.-]*w3\.org|schemas?\.|[\w.-]*\.example\b)[\w.-]+/,
    note: '明文 HTTP 地址（OWASP A02）',
  },
];

export function recallRiskyPatterns({ files = [] } = {}) {
  const out = [];

  for (const f of files) {
    const inTest = isTestFile(f.rel);
    const lines = f.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const t = raw.trim();
      // 注释行里的危险模式绝大多数是在讲「不要这么写」——本仓库的注释就充满这种句子。
      // 不排除的话，写得越用心的项目被误报越多
      if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*')) continue;

      for (const p of RISKY_PATTERNS) {
        // 测试里的危险 API 与假地址是刻意的（要构造注入面才能测防护），送判只会淹没真问题；
        // 唯独凭证例外，见 keepInTests
        if (inTest && !p.keepInTests) continue;
        if (!p.re.test(raw)) continue;
        // refine 是「模式匹配之后的二次收窄」，只有表达不出的判据才用它（见 unsafe-html）
        if (p.refine && !p.refine(raw)) continue;
        out.push({
          file: f.rel,
          line: i + 1,
          text: `${f.rel}:${i + 1} 命中「${p.note}」\n\n`
            + `${lines.slice(Math.max(0, i - 2), i + 3).map((l, k) => `${Math.max(1, i - 1) + k}| ${l}`).join('\n')}`,
          meta: { kind: p.kind },
        });
      }
    }
  }

  return out;
}

/* ==================== config ==================== */

const HARDCODED_PATTERNS = [
  {
    kind: 'absolute-path',
    re: /['"](?:[A-Za-z]:[\\/]{1,2}[^'"]{2,}|\/(?:Users|home|root|var|opt|etc)\/[^'"]{2,})['"]/,
    note: '硬编码绝对路径，换机器即失效',
  },
  {
    kind: 'host-port',
    // 排除回环与广播地址：本项目刻意绑 127.0.0.1（根 CLAUDE.md 明写「⛔ 勿暴露公网」），
    // 把它报成「硬编码 IP」是在要求用户改掉一条安全设计
    re: /['"](?:https?:\/\/)?(?!127\.0\.0\.1|0\.0\.0\.0|255\.|localhost)(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?[^'"]*['"]/,
    note: '硬编码 IP 地址',
  },
  { kind: 'magic-port', re: /\b(?:port|PORT)\s*[:=]\s*\d{2,5}\b/, note: '硬编码端口，未走配置' },
];

/** env 读取点分散到超过这么多个文件，就值得让模型判一次「该不该收口」（12-Factor §3） */
const ENV_SCATTER_THRESHOLD = 3;

const ENV_READ = /process\.env\.\w+|process\.env\[|os\.environ(?:\.get)?\s*[[(]|System\.getenv\s*\(|os\.Getenv\s*\(/;

export function recallHardcodedConfig({ files = [] } = {}) {
  const out = [];
  const envFiles = new Map(); // rel -> 首个命中行号

  for (const f of files) {
    // 测试里的硬编码路径 / 地址是夹具数据，本来就该写死（`chat.path.test.js` 里有几十条
    // `'C:\\Users\\DELL\\file.txt'` 这样的断言输入）。实测它们占了这一类候选的绝大多数
    if (isTestFile(f.rel)) continue;

    const lines = f.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const t = raw.trim();
      if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*')) continue;

      if (ENV_READ.test(raw) && !envFiles.has(f.rel)) envFiles.set(f.rel, i + 1);

      for (const p of HARDCODED_PATTERNS) {
        if (!p.re.test(raw)) continue;
        out.push({
          file: f.rel,
          line: i + 1,
          text: `${f.rel}:${i + 1} 命中「${p.note}」\n\n${raw.trim()}`,
          meta: { kind: p.kind },
        });
      }
    }
  }

  // env 分散是**一个整体问题**，不是每个读取点各一条 issue：
  // 逐点报会产出几十条内容雷同的条目，而修法只有一个（建一个配置模块收口）
  if (envFiles.size > ENV_SCATTER_THRESHOLD) {
    const list = [...envFiles.entries()].map(([rel, line]) => `${rel}:${line}`);
    out.push({
      file: list[0].split(':')[0],
      line: 1,
      text: `环境变量读取分散在 ${envFiles.size} 个文件里，未经统一的配置模块收口（12-Factor §3）：\n  `
        + `${list.slice(0, 20).join('\n  ')}${list.length > 20 ? `\n  …还有 ${list.length - 20} 处` : ''}`,
      meta: { kind: 'env-scattered', count: envFiles.size, files: list },
    });
  }

  return out;
}

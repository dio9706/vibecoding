/**
 * 只读 SQL 校验 —— **零依赖纯函数**，自由形数据问答的第 2 层防线。
 *
 * 定位：模型可以写任意 SQL，本模块决定哪些**允许执行**。它不是「提示模型别写坏东西」，
 * 而是执行前的硬闸门。四层防线里这是唯一能看懂 SQL 语义的一层（第 1 层收窄工具面、
 * 第 3 层连接与会话加固、第 4 层身份与审计，见 spec §3）。
 *
 * ## 设计立场：白名单，不是黑名单
 *
 * 只在**明确认识的形状**上放行：单条语句、`SELECT`/`WITH` 开头、不含危险构造。
 * 看不懂就拒。拒绝的代价是模型换个写法重试；放行的代价可能是不可逆的写操作。
 * 关键字黑名单只是兜底（防 `WITH x AS (...) DELETE ...` 这类第一关放行、语义却是写的构造），
 * **绝不能当成主防线** —— 黑名单永远补不全。
 *
 * ## 为什么自己写而不用 SQL 解析器
 *
 * 完整 MySQL parser 是个大依赖，且「解析得出 AST」不等于「MySQL 会那样执行」——
 * 版本注释 `/*!…*\/` 就是典型：解析器当注释跳过，MySQL 当代码执行。
 * 与其追求解析精度，不如把可疑构造一律拒掉（见 rejectsVersionComment）。
 */

/** 允许的语句起始关键字 —— 只读查询的全部合法开头 */
const ALLOWED_HEADS = ['SELECT', 'WITH'];

/**
 * 语句类型兜底黑名单。第一关（必须 SELECT/WITH 开头）已挡住绝大多数，
 * 这条防的是「开头合法、中途转写」的构造，例如 MySQL 8 的
 * `WITH t AS (SELECT 1) DELETE FROM x WHERE id IN (SELECT * FROM t)`。
 */
const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT',
  'TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'RENAME',
  'GRANT', 'REVOKE', 'SET', 'LOCK', 'UNLOCK',
  'CALL', 'DO', 'HANDLER', 'LOAD', 'IMPORT',
  'PREPARE', 'EXECUTE', 'DEALLOCATE',
  'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
  'SHUTDOWN', 'KILL', 'FLUSH', 'RESET', 'PURGE', 'OPTIMIZE', 'REPAIR', 'ANALYZE', 'CHECK',
  'INTO', // 挡 SELECT ... INTO OUTFILE / INTO DUMPFILE / INTO @var
];

/**
 * 危险函数/构造。`LOAD_FILE` 能读服务器文件系统；`BENCHMARK`/`SLEEP` 是资源耗尽与盲注的常用手段
 *（MAX_EXECUTION_TIME 能兜住时长，但没必要放行一个除了拖时间没别的用途的函数）。
 */
const FORBIDDEN_CONSTRUCTS = [
  'LOAD_FILE', 'OUTFILE', 'DUMPFILE',
  'BENCHMARK', 'SLEEP',
  'SYS_EXEC', 'SYS_EVAL',
  'INFORMATION_SCHEMA.USER_PRIVILEGES', 'MYSQL.USER',
];

/**
 * 默认 PII 列名（**子串**匹配，大小写不敏感）。可由调用方覆盖，见 validateSql 的 policy。
 *
 * ⚠️ 已知取舍：子串匹配会误杀含这些词的**正常表名**（`email_templates`、`user_addresses`
 * 都会被挡）。这是刻意选的方向 —— 误杀的代价是用户换个写法或管理员调 policy，
 * 漏放的代价是隐私事故，不对称。若某个库误杀率高到影响使用，正确做法是**收窄这份清单**
 * 或改用 DB 侧只读视图，而不是改成精确匹配（精确匹配挡不住 `u`.`phone` 这类写法）。
 */
export const DEFAULT_PII_COLUMNS = [
  'phone', 'mobile', 'tel', 'id_card', 'idcard', 'identity_no',
  'email', 'address', 'real_name', 'realname', 'bank_card', 'bankcard',
  'passwd', 'password', 'salt', 'token', 'secret',
];

/**
 * 把字符串字面量、反引号标识符、注释替换成等长的占位符，得到「只剩语法骨架」的文本。
 *
 * 为什么要等长：后续要按位置切分语句，长度变了偏移就对不上。
 * 为什么要屏蔽字面量：`SELECT ';'` 里的分号不是语句分隔符、`SELECT 'DROP'` 里的 DROP 不是关键字，
 * 不屏蔽就会把完全合法的查询误杀（误杀比漏放代价小，但没必要）。
 *
 * @param {string} sql
 * @returns {{ skeleton: string, hasVersionComment: boolean, unterminated: boolean }}
 *   skeleton：字面量/注释被空格替换后的等长文本
 *   hasVersionComment：出现过 `/*!` 版本注释（MySQL 会执行其内容，一律拒）
 *   unterminated：有未闭合的引号或注释（残缺输入，一律拒）
 */
export function maskLiterals(sql) {
  const s = String(sql ?? '');
  const out = s.split('');
  let i = 0;
  let hasVersionComment = false;
  let unterminated = false;

  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' '; // 保留换行，行号信息对报错有用
    }
  };

  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];

    // 行注释 -- 或 #
    if ((c === '-' && next === '-') || c === '#') {
      const end = s.indexOf('\n', i);
      const stop = end < 0 ? s.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    // 块注释 /* */，含 MySQL 版本注释 /*! */
    if (c === '/' && next === '*') {
      if (s[i + 2] === '!') hasVersionComment = true;
      const end = s.indexOf('*/', i + 2);
      if (end < 0) {
        unterminated = true;
        blank(i, s.length);
        break;
      }
      blank(i, end + 2);
      i = end + 2;
      continue;
    }

    // 字符串字面量 '...' / "..." 与反引号标识符 `...`
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      let closed = false;
      while (j < s.length) {
        if (s[j] === '\\' && quote !== '`') {
          j += 2; // 反斜杠转义（反引号内不适用）
          continue;
        }
        if (s[j] === quote) {
          if (s[j + 1] === quote) {
            j += 2; // '' 或 "" 或 `` 表示一个字面量引号
            continue;
          }
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        unterminated = true;
        blank(i, s.length);
        break;
      }
      blank(i, j + 1);
      i = j + 1;
      continue;
    }

    i += 1;
  }

  return { skeleton: out.join(''), hasVersionComment, unterminated };
}

/**
 * 按语句骨架切分出非空语句段。分号在字面量/注释里的已被 maskLiterals 屏蔽掉。
 * @param {string} skeleton
 * @returns {string[]} 每段的**骨架**文本（非空）
 */
/**
 * 从骨架里切出全部 **SELECT 输出列表**（每个 SELECT 到与之配对的 FROM 之间）。
 *
 * 为什么要区分位置而不是整句判 PII（2026-09-07 维护者反馈）：
 *   `SELECT phone FROM user`                    ← 导出 PII，该拦
 *   `SELECT uid FROM user WHERE phone = '136…'` ← 拿已知手机号换内部 ID，**不该拦**
 * 后者是「按手机号查这个用户的行为轨迹」的第一步，产品运营的高频需求，
 * 而且它没有暴露任何新信息 —— 手机号本来就是提问的人自己输进去的。
 * 首版整句判 PII 把这条路彻底堵死，实测让一个常用功能完全不可用。
 *
 * 子查询与 CTE 里的 SELECT 同样要查：`WITH t AS (SELECT phone …) SELECT * FROM t`
 * 一样能把 PII 带出来，所以返回**所有**层级的输出列表。
 *
 * @param {string} skeleton 已屏蔽字面量与注释的等长骨架
 * @returns {string[]}
 */
export function selectLists(skeleton) {
  const s = String(skeleton ?? '');
  const out = [];
  const re = /\bSELECT\b/gi;
  let m;
  while ((m = re.exec(s))) {
    let depth = 0;
    let i = m.index + m[0].length;
    const start = i;
    let hitFrom = false;
    for (; i < s.length; i += 1) {
      const c = s[i];
      if (c === '(') depth += 1;
      else if (c === ')') {
        if (depth === 0) break; // 走出了本 SELECT 所在的括号
        depth -= 1;
      } else if (depth === 0 && /^\s+FROM\b/i.test(s.slice(i))) {
        hitFrom = true;
        break; // 同层的 FROM：输出列表到此为止
      }
    }
    // FROM 后面第一个非空字符是 `(` → 取自派生表/子查询。
    // 这类 `SELECT * FROM (SELECT a, b FROM t) x` 是窗口函数的常见写法，
    // 而内层的输出列表本轮也会被单独校验，外层的 `*` 拿不到任何未知列 —— 放行。
    // 反之 `SELECT * FROM user` 从**基表**取全部列，会把手机号一并带出，必须拦。
    const after = hitFrom ? s.slice(i).replace(/^\s+FROM\b/i, '').trimStart() : '';
    out.push({ list: s.slice(start, i), fromDerived: after.startsWith('(') });
  }
  return out;
}

/**
 * 输出列表里有没有「裸星号」（`SELECT *` / `SELECT u.*` / `SELECT a, *`）。
 *
 * 为什么单独拦：`SELECT * FROM user WHERE phone='x'` 的输出列表里不含 "phone" 字样，
 * 但结果集会把整行（含手机号）吐出来 —— 列名黑名单对它完全无效。
 * 要求显式列出字段，顺带让查询更可审计。
 *
 * `COUNT(*)` 放行（星号前是 `(`）；`SUM(a*b)` 的乘号不误判（星号前是标识符字符）。
 */
export function hasBareStar(selectList) {
  const s = String(selectList ?? '');
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '*') continue;
    let j = i - 1;
    while (j >= 0 && /\s/.test(s[j])) j -= 1;
    const prev = j >= 0 ? s[j] : '';
    if (prev === '' || prev === ',' || prev === '.') return true;
  }
  return false;
}

export function splitStatements(skeleton) {
  return String(skeleton ?? '')
    .split(';')
    .map((seg) => seg.trim())
    .filter(Boolean);
}

/** 某个词是否作为独立单词出现（骨架文本上判定，故不会命中字面量里的同名串） */
function hasWord(skeleton, word) {
  return new RegExp(`(?:^|[^\\w$])${word}(?:[^\\w$]|$)`, 'i').test(skeleton);
}

/**
 * 校验一条 SQL 是否允许执行。
 *
 * @param {string} sql 模型给出的原始 SQL
 * @param {{ piiColumns?: string[], deniedTables?: string[] }} [policy]
 *   piiColumns：命中即拒的敏感列名片段（默认 DEFAULT_PII_COLUMNS；传 [] 关闭该策略）
 *   deniedTables：命中即拒的表名片段（默认空）
 * @returns {{ ok: true } | { ok: false, code: string, reason: string }}
 *   code 供调用方分类回话与审计统计；reason 是给用户看的中文说明。
 */
export function validateSql(sql, policy = {}) {
  const raw = String(sql ?? '').trim();
  if (!raw) return deny('empty', '查询为空');

  const { skeleton, hasVersionComment, unterminated } = maskLiterals(raw);

  if (unterminated) {
    return deny('unterminated', '查询里有未闭合的引号或注释');
  }
  // MySQL 会执行 /*!…*\/ 里的内容，而它看起来像注释 —— 静态检查最容易在这里被绕过。
  // 正经分析查询用不到版本注释，直接拒。
  if (hasVersionComment) {
    return deny('version_comment', '查询包含 MySQL 版本注释（/*!…*/），出于安全不允许');
  }

  const statements = splitStatements(skeleton);
  if (statements.length === 0) return deny('empty', '查询为空');
  if (statements.length > 1) {
    return deny('multi_statement', `一次只能执行一条语句（检测到 ${statements.length} 条）`);
  }

  const stmt = statements[0];

  // 起始关键字：只读查询只可能以 SELECT 或 WITH 开头
  const head = (stmt.match(/^[\w$]+/) || [''])[0].toUpperCase();
  if (!ALLOWED_HEADS.includes(head)) {
    // SHOW / DESCRIBE / EXPLAIN 本身是只读的，但仍然拒 —— 白名单立场不为「看起来无害」开口子
    //（`SHOW GRANTS` / `SHOW PROCESSLIST` / `SHOW VARIABLES` 会泄露基础设施信息）。
    // 不过它们是模型最容易顺手写出来的东西，所以错误文案要直接指向替代工具，
    // 否则模型会反复重试同一类语句，把查询预算烧光还什么都没查到。
    if (['SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(head)) {
      return deny(
        'not_select',
        `不支持 ${head} 语句。看有哪些表请用 list_tables 工具，看表字段请用 describe_table 工具，取数请用 SELECT。`,
      );
    }
    return deny('not_select', `只允许 SELECT / WITH 开头的只读查询（当前是 ${head || '未知'}）`);
  }

  // 兜底：开头合法但中途转写的构造
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (hasWord(stmt, kw)) {
      return deny('forbidden_keyword', `查询包含不允许的关键字 ${kw}（本功能只读）`);
    }
  }

  for (const c of FORBIDDEN_CONSTRUCTS) {
    if (stmt.toUpperCase().includes(c)) {
      return deny('forbidden_construct', `查询包含不允许的构造 ${c}`);
    }
  }

  // PII：**只管输出，不管条件**（2026-09-07 改。首版整句判，把「按手机号查用户轨迹」
  // 这个高频需求彻底堵死了 —— 而那个用法根本没暴露新信息，手机号是提问者自己输的）。
  const piiColumns = policy.piiColumns ?? DEFAULT_PII_COLUMNS;
  const lower = stmt.toLowerCase();
  if (piiColumns.length) {
    for (const { list, fromDerived } of selectLists(skeleton)) {
      const l = list.toLowerCase();
      for (const col of piiColumns) {
        if (l.includes(String(col).toLowerCase())) {
          return deny(
            'pii_denied',
            `不能把敏感字段「${col}」放进查询结果。` +
              `用它做筛选条件是允许的 —— 例如 SELECT uid FROM user WHERE ${col} = '…'，` +
              `拿到内部 ID 后再用 ID 做后续分析。`,
          );
        }
      }
      // 基表上的裸星号会把整行（含手机号等）吐出来，而列名黑名单对 `*` 完全无效。
      // 派生表放行的理由见 selectLists 里的注释。
      if (!fromDerived && hasBareStar(list)) {
        return deny(
          'pii_denied',
          '不允许对表直接 SELECT *（会把敏感字段一并带出）。请显式列出字段名；' +
            'COUNT(*) 与 `SELECT * FROM (子查询) t` 不受此限。',
        );
      }
    }
  }

  for (const t of policy.deniedTables || []) {
    if (lower.includes(String(t).toLowerCase())) {
      return deny('table_denied', `查询涉及受限表「${t}」`);
    }
  }

  return { ok: true };
}

function deny(code, reason) {
  return { ok: false, code, reason };
}

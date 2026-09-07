/**
 * 自由形数据问答的纯函数层 —— 触发解析、提示词构造、失败归因、结果成文。
 * 全部无 IO、无副作用，便于单测覆盖到每条分支（同 logic.js 的分工）。
 */

/** 触发前缀（回归锚点：改动此值等于改变用户契约，必须同步改文档与欢迎卡文案） */
export const FREEFORM_PREFIX = '帮我查数据';

/**
 * 前缀必须在**消息开头** —— 沿用 `logic.js#parseTrackingCommand` 的铁律。
 * 历史事故：整篇接口文档被贴进来，全文命中关键词而误判意图。
 */
const CMD_RE = new RegExp(`^\\s*${FREEFORM_PREFIX}\\s*[:：]?\\s*([\\s\\S]*)$`);

/**
 * @param {unknown} text
 * @returns {{ hit: boolean, body: string }} body 为空表示只发了前缀，调用方据此追问
 */
export function parseFreeformCommand(text) {
  const t = typeof text === 'string' ? text : '';
  if (!t.trim()) return { hit: false, body: '' };
  const m = CMD_RE.exec(t);
  if (!m) return { hit: false, body: '' };
  return { hit: true, body: (m[1] || '').trim() };
}

/** 注入提示词的埋点先验条目上限 —— 给方向感即可，全量灌进去只会稀释注意力 */
const DICT_HINT_MAX = 40;

/**
 * 构造分析提示词。
 *
 * 三条刻意的取舍：
 *
 * 1. **不预先灌 schema**。表可能上百张，全量塞进提示词既贵又会淹没重点；让模型用
 *    `list_tables` / `describe_table` 自己按需探，是这套多轮方案的意义所在。
 * 2. **给埋点索引作先验，但只给类目而非全量**。埋点表的字段是 JSON，光看 schema
 *    看不出「有哪些事件」，这个先验能省掉好几轮试探；但 600+ 条全给会挤掉真正的任务描述。
 * 3. **明写「今天是哪天」**。模型没有时间概念，「最近 7 天」这类相对表述必须有锚点，
 *    否则它会用训练截止日期去推算 —— 这是同类功能最常见的静默错误。
 *
 * @param {string} question 用户的自然语言问题
 * @param {object|null} dict 埋点索引快照（可为 null，缺了不影响非埋点类查询）
 * @param {string} today 北京时区的今天 YYYY-MM-DD
 * @param {string} dbName 库名（让模型知道自己在查哪个库）
 * @returns {string}
 */
export function buildAnalysisPrompt(question, dict, today, dbName) {
  const cats = (dict?.categories || [])
    .map((c) => c.label || c.prefix)
    .filter(Boolean)
    .slice(0, DICT_HINT_MAX);

  return [
    '你是一名数据分析师，正在帮产品和运营同学查数。',
    '',
    `## 环境`,
    `- 数据库：MySQL，当前库 \`${dbName}\`（**只读**，你无法也不应尝试修改任何数据）`,
    `- 今天是 ${today}（北京时间）。用户说「最近 7 天」「上周」时以此为准，不要用你自己的时间概念。`,
    cats.length ? `- 该库含埋点数据，已知业务模块：${cats.join('、')}` : '',
    '',
    '## 你的工具',
    '- `list_tables`：看有哪些表。**先用它**，不要凭猜写表名。',
    '- `describe_table`：看某张表的字段与注释。写查询前先看清字段类型。',
    '- `run_query`：执行一条只读 SQL。每次都要写清 purpose。',
    '',
    '## 硬性约束',
    '- 只能 SELECT / WITH。任何写操作都会被拒绝，不要尝试。',
    '- 不支持 SHOW / DESCRIBE / EXPLAIN 语句，看表结构请用上面两个工具。',
    '- 涉及手机号、邮箱、身份证、住址等个人信息的字段会被安全策略拒绝。',
    '  **优先做聚合统计**（COUNT / SUM / AVG / 分组），而不是拉取原始明细。',
    '- 查询次数有限，别用穷举试探；先看清 schema 再动手。',
    '',
    '## 输出要求',
    '把结论写给**不懂 SQL 的人**看：',
    '- 先给一句话结论（具体数字），再给支撑的明细或分组。',
    '- 数据被截断、时间范围有调整、口径有假设 —— 都要**明确说出来**，不要让人误以为看到的是全貌。',
    '- 查不到就直说查不到、缺什么，不要编数字。',
    '',
    '## 用户的问题',
    question,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * 把 Agent 的产出与过程信息拼成给用户的回复。
 *
 * 过程信息（查了几次、被拒几次）刻意**放在结论之后**：用户要的是答案，
 * 不是执行报告。但被拒次数必须露出来 —— 那往往解释了「为什么结论看着不完整」。
 *
 * @param {{ text: string, queries: number, denied: string[] }} r
 * @returns {string}
 */
export function buildAnswerReply(r) {
  const body = String(r?.text || '').trim();
  if (!body) return '没能得出结论 —— 模型没有返回内容，稍后再试试～';

  const lines = [body];
  const notes = [];
  if (r.queries) notes.push(`查询 ${r.queries} 次`);

  const denied = r.denied || [];
  if (denied.length) {
    // 只报「有多少次被安全策略挡下」，不逐条列 denyCode ——
    // 那些码是给审计看的，对用户没有行动价值，只会显得报错很多。
    const pii = denied.filter((c) => c === 'pii_denied').length;
    notes.push(pii ? `${denied.length} 次被安全策略拦下（其中 ${pii} 次涉及个人信息字段）` : `${denied.length} 次被安全策略拦下`);
  }
  if (notes.length) lines.push('', `— ${notes.join('，')}`);
  return lines.join('\n');
}

/**
 * 失败归因 → 人话。
 *
 * 沿用 `logic.js#buildUnderstandFailureReply` 确立的原则：**按真实原因分开回话**。
 * 把「超时」说成「没听懂」，用户只会一遍遍改写一句本来正确的需求 —— 而改写对超时毫无作用。
 *
 * @param {'exhausted'|'timeout'|'error'|'db_connect'|'db_query'|'no_dict'|string} reason
 * @param {string} [detail]
 */
export function buildFreeformFailureReply(reason, detail) {
  switch (reason) {
    case 'exhausted':
      return '⏳ 今天的模型额度用完了，等额度恢复后原样再发一次即可 —— 需求本身没问题。';
    case 'timeout':
      return '⏱ 这个问题查得有点久，超时了。可以把范围缩小些（比如指定更短的时间段）再试。';
    case 'db_connect':
      return [
        '🔌 连不上数据库。',
        '生产库需要经 dev 环境跳板，请确认隧道已建立；',
        '管理员可运行 `node --env-file=.env scripts/check-tracking-db.mjs` 定位。',
        detail ? `（${String(detail).slice(0, 120)}）` : '',
      ]
        .filter(Boolean)
        .join('\n');
    case 'db_config':
      // 与 db_connect 分开：这是「没配置」，不是「连不上」。
      // 实测踩过 —— 打包版没加载 .env，报成连接问题会让人一路查到跳板隧道去。
      return [
        '⚙️ 数据库还没配置好（缺少 TRACKING_DB_* 环境变量）。',
        '打包版要把 .env 放到应用数据目录（%APPDATA%\\com.principal.desktop\\.env），',
        '安装目录下的 .env 读不到。改完重启应用即可。',
        detail ? `（${String(detail).slice(0, 160)}）` : '',
      ]
        .filter(Boolean)
        .join('\n');
    case 'db_query':
      return `❌ 查询执行失败：${String(detail || '').slice(0, 200)}`;
    default:
      return `❌ 分析失败：${String(detail || reason || '未知原因').slice(0, 200)}`;
  }
}

/**
 * 判断 sql_exec.py 的错误属于「没配置」「连不上」还是「查询本身错」。
 * 三者排查方向两两不同，不能混成一句（同 check-tracking-db.mjs 的分类）。
 * @param {{ error?: string, kind?: string }|null} out
 * @returns {'db_config'|'db_connect'|'db_query'}
 */
export function classifyDbError(out) {
  if (out?.kind === 'config') return 'db_config';
  if (out?.kind === 'connect') return 'db_connect';
  const msg = String(out?.error || '');
  // 文本兜底：脚本没给 kind 时（旧版本、或错误在给 kind 之前就抛了）仍要能分辨
  if (/缺少环境变量|TRACKING_DB_/i.test(msg)) return 'db_config';
  return /OperationalError|Can't connect|timed out|Access denied/i.test(msg) ? 'db_connect' : 'db_query';
}

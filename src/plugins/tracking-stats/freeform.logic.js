/**
 * 自由形数据问答的纯函数层 —— 触发解析、提示词构造、失败归因、结果成文。
 * 全部无 IO、无副作用，便于单测覆盖到每条分支（同 logic.js 的分工）。
 */

/** 主前缀（回归锚点：改动此值等于改变用户契约，必须同步改文档与欢迎卡文案） */
export const FREEFORM_PREFIX = '帮我查数据';

/**
 * 全部触发前缀 —— `帮我统计埋点` 也归本路径。
 *
 * 为什么合并（2026-09-07 维护者拍板）：老路径只有两条写死的 SQL（事件 PV/UV、页面 PV/UV），
 * 于是必须配一套「能力边界 + 越界降级」的机制去兜。实测这套机制有害 ——
 * 用户问「13652412008 这个用户的操作路径」，拿回一份标题被换成「事件与页面 PV/UV 汇总」
 * 的全站报告；两次降级报告的通用标题与默认区间都一样，看上去就像返回了上一次的结果。
 *
 * 而本路径让模型自己探表、自己写查询、自己判断用户要什么 ——「能力边界」这个概念
 * 对它不成立，那套判定与降级也就一并没有存在意义了。**一个入口，模型自己分析。**
 *
 * 两个前缀都保留：老用户的输入习惯不该被改动打断。
 */
export const TRIGGER_PREFIXES = ['帮我查数据', '帮我统计埋点'];

/**
 * 前缀必须在**消息开头** —— 沿用 `logic.js#parseTrackingCommand` 的铁律。
 * 历史事故：整篇接口文档被贴进来，全文命中关键词而误判意图。
 * 长前缀排在前面，避免短前缀先命中把后面的字吃进正文。
 */
const CMD_RE = new RegExp(
  `^\\s*(?:${[...TRIGGER_PREFIXES].sort((a, b) => b.length - a.length).join('|')})\\s*[:：]?\\s*([\\s\\S]*)$`,
);

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
 * 4. **强制把埋点 key 翻成中文**。首版没写这条，产出的报告满屏 `ruyee_dish_toggle_meal`，
 *    对产品运营等于没写（用户实测反馈）。库里 `event_mapping` 是 100% 覆盖的中文词典，
 *    但模型不会主动去 JOIN 它 —— 不明确要求就不会做。同时要求保留 key 放在括号里：
 *    研发要靠它定位代码，只给中文名等于把可追溯性也丢了。
 * 5. **默认排除内测用户与 devtools 流量**。口径与老路径 `tracking_report.py` 对齐
 *    （`fetch_internal_uids` + `EXCLUDE_DEVTOOLS`），否则同一个问题走两条路会给出两个数，
 *    而看数的人无从判断该信哪个。团队自己人天天在点，不排除会把小功能的数字显著抬高。
 *
 * @param {string} question 用户的自然语言问题
 * @param {object|null} dict 埋点索引快照（可为 null，缺了不影响非埋点类查询）
 * @param {string} today 北京时区的今天 YYYY-MM-DD
 * @param {string} dbName 库名（让模型知道自己在查哪个库）
 * @param {{hasFrontend?: boolean}} [opts] hasFrontend=已挂载前端检索工具（未挂载则相关段落不出现）
 * @returns {string}
 */
export function buildAnalysisPrompt(question, dict, today, dbName, opts = {}) {
  // 前端仓库没配置时，相关段落整段不出现 —— 与其告诉模型「有个工具但用不了」，
  // 不如让它压根不知道有这回事，省得反复试探把查询预算烧光。
  const hasFrontend = !!opts.hasFrontend;
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
    hasFrontend ? '- `search_frontend` / `read_frontend`：在前端源码仓库里查证埋点的实际作用与属性含义。' : '',
    '',
    '## 硬性约束',
    '- 只能 SELECT / WITH。任何写操作都会被拒绝，不要尝试。',
    '- 不支持 SHOW / DESCRIBE / EXPLAIN 语句，看表结构请用上面两个工具。',
    '- 个人信息字段（手机号、邮箱、身份证、住址等）**可以做筛选条件，不能放进查询结果**。',
    '  `WHERE phone = \'…\'` 允许；`SELECT phone` 会被拒。`SELECT *` 也会被拒（它会把整行带出来），',
    '  请显式列字段；`COUNT(*)` 不受此限。',
    '- 查询次数有限，别用穷举试探；先看清 schema 再动手。',
    '',
    '## 埋点标识必须翻译成中文（硬性要求）',
    '库里有一张 `event_mapping` 表，它是埋点标识的**权威中文词典**，覆盖率 100%：',
    '  `event_name`（埋点 key）· `label`（中文名）· `category`（业务分类）· `description`（说明）· `page_path`（关联页面）',
    '注意过滤 `is_deleted = 0`。',
    '',
    '**报告里不允许出现裸埋点 key。** `ruyee_dish_toggle_meal`、`$MPClick` 这类标识对产品运营是天书，',
    '一份满屏 key 的报告等于没写。凡是要展示事件或页面，一律先 JOIN `event_mapping` 取 `label`：',
    '',
    '```sql',
    '-- 推荐写法：统计与翻译一次做完，不要事后手工对照',
    'SELECT COALESCE(m.label, s.event) AS 事件, m.category AS 分类,',
    '       COUNT(*) AS 次数, COUNT(DISTINCT s.distinct_id) AS 人数',
    'FROM statistics_data s',
    'LEFT JOIN event_mapping m ON m.event_name = s.event AND m.is_deleted = 0',
    'GROUP BY 1, 2 ORDER BY 次数 DESC',
    '```',
    '',
    '- 用 `LEFT JOIN` + `COALESCE` 兜底：词典里查不到的仍显示原 key，**但要在报告里标出「未收录」**，',
    '  那通常意味着有个埋点没登记，是值得反馈给研发的信息。',
    '- **key 不要丢掉**，放在中文名后的括号里或单独一列 —— 研发要靠它定位代码。',
    '  形如：`切换餐段（ruyee_dish_toggle_meal）`。',
    '- 页面路径同理：能对上 `page_path` 的就给中文页面名，对不上再给路径。',
    '',
    '## 用户标识：认准 `login_id`，不是 `distinct_id`（实测口径，别搞混）',
    '`statistics_data` 里有两个像「用户」的字段，含义完全不同：',
    '- **`login_id`** —— 登录后的账号标识，18~19 位数字串。与 `user.uid` 匹配率 **99.87%**（实测 9014/9026）。',
    '  **「某个人」一律用它。**',
    '- `distinct_id` —— SDK 生成的匿名串（16~49 位），认设备/会话不认人；与微信 `mini_openid`、',
    '  `union_id` **零匹配**。同一人换设备会被算成两个。只有统计「设备数」时才用它。',
    '',
    '⚠️ **类型不同，关联必须显式转换**：`login_id` 是 `varchar(64)`，`user.uid` / `internal_user.uid` 是 `bigint`。',
    '直接用 `=` 比会触发隐式转换（本库还会撞 collation 报错），结果要么报错要么**悄悄膨胀**——',
    '实测 807 个内测账号用 `=` 直接关联会炸成 37682 条错误匹配。正确写法：',
    '',
    '```sql',
    '-- 字符串侧统一：CAST + COLLATE',
    'CAST(i.uid AS CHAR) COLLATE utf8mb4_unicode_ci = s.login_id',
    '-- 或数字侧统一：',
    'u.uid = CAST(s.login_id AS UNSIGNED)',
    '```',
    '',
    '## 按手机号查某个用户（高频需求，照这个套路做）',
    '手机号**可以用作筛选条件**，只是不能出现在查询结果里。两步走：',
    '',
    '```sql',
    '-- 第 1 步：手机号 → 内部 uid（phone 在 WHERE 里，不在 SELECT 里，这样是允许的）',
    "SELECT uid FROM user WHERE phone = '13652412008'",
    '',
    '-- 第 2 步：拿 uid 查这个人的行为轨迹（注意类型转换）',
    'SELECT s.time, COALESCE(m.label, s.event) AS 事件, s.event AS key值',
    'FROM statistics_data s',
    'LEFT JOIN event_mapping m ON m.event_name = s.event AND m.is_deleted = 0',
    "WHERE s.login_id = CAST(<第1步拿到的 uid> AS CHAR) COLLATE utf8mb4_unicode_ci",
    'ORDER BY s.time',
    '```',
    '',
    '第 1 步查不到就直说「库里没有这个手机号对应的用户」，不要猜、不要拿别的用户顶替。',
    '',
    '## 默认排除内部用户与开发者工具流量（除非用户明确要求包含）',
    '内测账号名单在 `internal_user`（`uid` bigint，同样要 `is_deleted = 0`）。团队自己人天天在点，',
    '不排除的话小功能的数字会被显著抬高 —— 产品拿这个数做判断会得出错的结论。',
    '',
    '```sql',
    '-- 埋点表：按 login_id 排除（不是 distinct_id！），且必须 CAST + COLLATE',
    'WHERE s.is_deleted = 0',
    "  AND JSON_UNQUOTE(JSON_EXTRACT(s.properties, '$.\"$os\"')) <> 'devtools'",
    '  AND s.login_id NOT IN (',
    '        SELECT CAST(uid AS CHAR) COLLATE utf8mb4_unicode_ci',
    '        FROM internal_user WHERE is_deleted = 0 AND uid IS NOT NULL)',
    '```',
    '',
    '- **业务表**（订单、用户表等）：`AND uid NOT IN (SELECT uid FROM internal_user WHERE is_deleted = 0)`',
    '  —— 两侧都是 bigint，这里不需要转换。',
    '- `NOT IN` 的子查询里有 NULL 会让整个条件返回空集，所以上面加了 `uid IS NOT NULL`。',
    '- **在报告里写明「已排除内测用户」**。口径不说出来，看数的人无从判断这个数字能不能跟别处对上。',
    '- 用户若明确说「包含内部用户」「算上我们自己」，就不排除，但同样要标注。',
    '',
    hasFrontend ? '## 用前端源码查证埋点的「作用」' : '',
    hasFrontend
      ? '`event_mapping` 只给了中文名和一句话描述，**属性取值的含义在库里查不到**。' +
        '前端仓库有：`docs/` 下的运营向说明文档写了属性语义（如 `tab=text2plate` 是「文生盘子」），' +
        '源码里 `trackClickApi(` 的调用点写了触发条件。'
      : '',
    hasFrontend
      ? '- 报告要解释某个埋点「是什么、什么时候触发、属性各值什么意思」时，用 `search_frontend` 搜它的 key，' +
        '再用 `read_frontend` 看上下文或文档。\n' +
        '- **查不到就说查不到**，不要凭 key 的字面拼写去猜含义 —— 猜错比不写更糟。\n' +
        '- 只在需要解释的埋点上查，别把所有 key 都搜一遍（有查询预算）。'
      : '',
    hasFrontend ? '' : '',

    '## 输出要求',
    '把结论写给**不懂 SQL 的人**看：',
    '- 先给一句话结论（具体数字），再给支撑的明细或分组。',
    '- **跨用户的分析优先给聚合**（COUNT / SUM / AVG / 分组），不要拉一长串原始行 ——',
    '  那既容易被截断，也不是产品运营要看的东西。',
    '  但**针对单个用户的轨迹查询例外**：那种场景明细本身就是答案，按时间排好给全即可。',
    '- 表头用中文；事件/页面一律中文名在前、key 在括号内。',
    '- 数据被截断、时间范围有调整、口径有假设 —— 都要**明确说出来**，不要让人误以为看到的是全貌。',
    '- 查不到就直说查不到、缺什么，不要编数字。',
    '',
    '## 同时产出一份 HTML 报告',
    '聊天里先写两三句话的结论摘要，然后**另起一个 ```html 代码块**放完整报告。',
    '这个 HTML 会作为附件发给用户，所以要求：',
    '- **自包含**：样式内联或写在 `<style>` 里，不引用任何外部 CSS/JS/字体/图片（离线打开也要正常）。',
    '- 结构：标题 + 口径说明（时间范围、是否排除内测）+ 结论 + 数据表格 + 备注。',
    '- 表格里每个埋点给出：中文名、key、**作用说明**（前端查证来的）、数值。',
    '- 中文排版，`<meta charset="utf-8">` 必须有。',
    '- 不要写 `<script>`。',
    '聊天正文里不要重复整张表 —— 那是附件的事。',
    '',
    '## 用户的问题',
    question,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** 模型产出 HTML 报告用的围栏标记 —— 用它把报告与聊天正文切开 */
export const HTML_FENCE_RE = /```html\s*([\s\S]*?)```/i;

/**
 * 从模型输出里切出 HTML 报告与聊天正文。
 *
 * 为什么用围栏而不是让模型「只输出 HTML」：飞书里要先看到一句结论，附件才是给细看的。
 * 强制只出 HTML 会让聊天窗口只剩一个附件图标，等于把最重要的一句话藏起来了。
 *
 * @param {string} text 模型原始输出
 * @returns {{ html: string|null, chat: string }}
 */
export function splitHtmlReport(text) {
  const s = String(text || '');
  const m = HTML_FENCE_RE.exec(s);
  if (!m || !m[1].trim()) return { html: null, chat: s.trim() };
  const chat = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim();
  return { html: m[1].trim(), chat };
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

/**
 * 只读 SQL Agent 骨架 —— 自由形数据问答的**第 1 层防线**（工具面收窄）。
 *
 * 与 `llm-readonly-agent.js` 的分工：那个是「多轮读**文件**」，这个是「多轮读**数据库**」。
 * 两者形状同源（三层只读防线），但工具集完全不同 —— 本模块的 Agent **看不到任何
 * 内置工具**：没有 Read、没有 Bash、没有 Write、没有 WebFetch。它只有三个 SQL 工具。
 *
 * ## 为什么用进程内 MCP 而不是给它 Bash 跑 mysql 客户端
 *
 * 给 Bash 就等于给了一切 —— 沙箱里能跑 mysql 客户端就能跑别的，SQL 校验也失去意义
 *（模型可以绕过我们的 `run_query` 直接 `mysql -e "..."`）。进程内 MCP 工具让
 * **「能执行的动作集合」在结构上等于「我们写的那三个函数」**，这是收窄工具面唯一可靠的做法。
 *
 * ## 两层只读防线
 *
 * 1. **`tools: []`** —— 禁掉全部**内置**工具（Read/Bash/Write/…），MCP 工具不受影响。
 *    SDK 文档对该字段的说明：`[] (empty array) - Disable all built-in tools`。
 * 2. **`canUseTool`** —— 运行时白名单，每次工具调用前复核工具名。
 *
 * `permissionMode` 必须是 `'default'`：`bypassPermissions` 会绕过 `canUseTool`。
 *
 * ### ⚠️ 两个用错就会静默失效的坑（2026-09-07 实测踩过，勿改回去）
 *
 * **坑一：不能用 `disallowedTools: ['*']` 收窄工具面。** 该字段的语义是
 * 「removed from the model's context and cannot be used, **even if they would otherwise
 * be allowed**」—— 通配符**连本模块自己的 MCP 工具一起删掉**。实测表现为三个工具全部
 * `Permission denied`、一条数据都取不到，而日志里只有一句含糊的权限拒绝。
 * 收窄可用工具集的正确字段是 `tools`（SDK 文档原话：`To restrict which tools are
 * available, use the tools option instead`）。
 *
 * **坑二：不能把工具名列进 `allowedTools`。** 那个字段是「auto-allowed without
 * prompting」的免审批名单，**会让 `canUseTool` 整个不被调用** —— SDK 会打印
 * `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] canUseTool will not be invoked for: …` 警告。
 * 于是第 2 层防线形同虚设，而代码看起来一切正常。要保住运行时复核，就**不要**设
 * `allowedTools`，让每次调用都落到 `canUseTool` 上。
 *
 * 本模块**不含业务语义**（不知道什么是埋点、什么是订单），符合 capabilities 层定位。
 */
import { z } from 'zod';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { claudeAuthOpts, getTokens, isPoolExhausted } from './token-rotation.js';
import { validateSql } from './sql-guard.js';
import { logger } from '../shared/logger.js';

/** MCP 服务器名 —— 工具全名是 `mcp__<server>__<tool>`，allowedTools 要用全名 */
const SERVER = 'sqlro';

export const TOOL_NAMES = {
  listTables: `mcp__${SERVER}__list_tables`,
  describeTable: `mcp__${SERVER}__describe_table`,
  runQuery: `mcp__${SERVER}__run_query`,
};

/** 单轮 Agent 的默认预算。低频功能，宁可给足也别中途截断出半个结论。 */
export const DEFAULT_MAX_QUERIES = 25;
export const DEFAULT_TIMEOUT_MS = 300_000; // 5 分钟

/** 表名/库名的保守形状：只允许标识符字符，挡住把整段 SQL 塞进 table 参数 */
const IDENT_RE = /^[A-Za-z0-9_$]{1,64}$/;

function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] };
}

/**
 * 建一个只含三个 SQL 工具的进程内 MCP 服务器。
 *
 * @param {object} deps
 * @param {(sql: string, maxRows?: number) => Promise<object>} deps.execute
 *   真正执行 SQL 的函数（注入，便于单测替身；生产实现走 sql_exec.py）。
 *   须返回 `{ columns, rows, rowCount, truncated, ms }` 或抛错。
 * @param {(entry: object) => void} [deps.onAudit] 每次 run_query 的审计回调（含被拒绝的）
 * @param {object} [deps.policy] 透传给 validateSql（piiColumns / deniedTables）
 * @param {number} [deps.maxRows]
 * @param {{ count: number }} [deps.budget] 查询次数计数器（跨工具调用共享）
 * @returns {{ server: object, tools: Record<string, object> }}
 *   server：给 `options.mcpServers` 用的配置对象
 *   tools：按名字索引的工具定义（`{ name, description, inputSchema, handler }`）。
 *          **单独暴露是为了可测** —— createSdkMcpServer 把工具埋进 `instance._registeredTools`
 *          这个私有字段，测试去够它就把用例绑死在 SDK 内部结构上，SDK 一改版就红一片。
 *          工具定义本身才是这层要守的东西（有哪些工具、每个对坏输入怎么反应）。
 */
export function buildSqlToolServer(deps) {
  const { execute, onAudit, policy = {}, maxRows = 200, budget = { count: 0 } } = deps;
  const maxQueries = deps.maxQueries ?? DEFAULT_MAX_QUERIES;
  // 调用方可以再挂几个工具（如受限的代码检索）。放在这里而不是写死：
  // 本模块属 capabilities 层、无业务语义，「该不该让它查前端仓库」是业务决定。
  const extraTools = Array.isArray(deps.extraTools) ? deps.extraTools : [];

  /** 代码写死 SQL 的两个 schema 工具：表名参数化，模型给不了自由 SQL */
  const listTables = tool(
    'list_tables',
    '列出当前数据库里的表（可用 pattern 做模糊过滤）。先用它了解有哪些表，再决定查什么。',
    { pattern: z.string().optional().describe('表名模糊匹配片段，留空列全部') },
    async ({ pattern }) => {
      const like = pattern ? `%${String(pattern).replace(/[%_\\]/g, '')}%` : '%';
      const sql =
        `SELECT table_name, table_rows, table_comment FROM information_schema.tables ` +
        `WHERE table_schema = DATABASE() AND table_name LIKE '${like}' ` +
        `ORDER BY table_name LIMIT 500`;
      try {
        return textResult(await execute(sql, 500));
      } catch (e) {
        return textResult({ error: e?.message || String(e) });
      }
    },
  );

  const describeTable = tool(
    'describe_table',
    '查看某张表的字段名、类型与注释。写查询前先看清字段，不要凭猜。',
    { table: z.string().describe('表名（不含库名）') },
    async ({ table }) => {
      const t = String(table || '').trim();
      // 参数化不了 information_schema 的库名比较，所以对表名做严格形状校验，
      // 挡住「把一整段 SQL 塞进 table 参数」这条注入路径。
      if (!IDENT_RE.test(t)) return textResult({ error: `表名不合法：${t}` });
      const sql =
        `SELECT column_name, column_type, is_nullable, column_default, column_comment ` +
        `FROM information_schema.columns ` +
        `WHERE table_schema = DATABASE() AND table_name = '${t}' ORDER BY ordinal_position LIMIT 500`;
      try {
        return textResult(await execute(sql, 500));
      } catch (e) {
        return textResult({ error: e?.message || String(e) });
      }
    },
  );

  const runQuery = tool(
    'run_query',
    '执行一条只读 SQL（SELECT / WITH）。只允许查询，任何写操作都会被拒绝。' +
      '优先返回聚合结论而不是原始明细。结果超过上限会被截断并告知。',
    {
      sql: z.string().describe('要执行的 SQL，单条语句，不要写分号分隔的多条'),
      purpose: z.string().describe('一句话说明这次查询想得到什么（会记入审计日志）'),
    },
    async ({ sql, purpose }) => {
      // 预算闸：放在校验之前 —— 超预算时不该再消耗任何 DB 资源
      if (budget.count >= maxQueries) {
        return textResult({ error: `已达单次分析的查询次数上限（${maxQueries}），请基于已有结果作答` });
      }
      budget.count += 1;

      const verdict = validateSql(sql, policy);
      if (!verdict.ok) {
        // 被拒也要审计 —— 没有身份门禁时，这是「有人在试探边界」的唯一信号
        onAudit?.({ sql, purpose, ok: false, denyCode: verdict.code, error: verdict.reason });
        logger.info('llm-sql-agent', 'SQL 被安全策略拒绝', { code: verdict.code });
        return textResult({ error: `查询被安全策略拒绝：${verdict.reason}` });
      }

      try {
        const r = await execute(sql, maxRows);
        onAudit?.({ sql, purpose, ok: true, rows: r?.rowCount ?? null, truncated: !!r?.truncated, ms: r?.ms ?? null });
        return textResult(r);
      } catch (e) {
        const msg = e?.message || String(e);
        onAudit?.({ sql, purpose, ok: false, error: msg });
        return textResult({ error: msg });
      }
    },
  );

  const defs = [listTables, describeTable, runQuery, ...extraTools];
  const server = createSdkMcpServer({
    name: SERVER,
    version: '1.0.0',
    instructions:
      '这是一个只读数据分析环境。你只能查询，不能修改任何数据。' +
      '建议顺序：先 list_tables 看有哪些表，再 describe_table 看清字段，最后 run_query 取数。',
    tools: defs,
    alwaysLoad: true, // 只有三个工具，没必要让它们藏在 tool search 后面
  });

  return { server, tools: Object.fromEntries(defs.map((d) => [d.name, d])) };
}

/**
 * 构造给 `query()` 的 options —— **抽成纯函数只为可测**。
 *
 * 文件头那两个坑（`disallowedTools:['*']` 连 MCP 工具一起删、`allowedTools` 让
 * `canUseTool` 不被调用）都是**静默失效**型的：配错了代码照样跑，只是防线没了。
 * 这种东西必须有断言守着，不能靠注释提醒下一个人。
 *
 * @param {{ server: object, allowed: Set<string>, model?: string, abort?: AbortController }} a
 */
export function buildAgentOptions({ server, allowed, model, abort }) {
  return {
    ...claudeAuthOpts(),
    ...(model ? { model } : {}),
    permissionMode: 'default', // bypassPermissions 会绕过 canUseTool，绝不能用
    mcpServers: { [SERVER]: server },
    // 第 1 层：禁掉全部内置工具（Read/Bash/Write/…）。MCP 工具不在此列，仍可用。
    // 刻意**不用** disallowedTools:['*'] —— 那会连 MCP 工具一起删（见文件头「坑一」）。
    tools: [],
    // 第 2 层：运行时复核，每次工具调用都过。
    // 刻意**不设** allowedTools —— 设了会让本回调整个不被调用（见文件头「坑二」）。
    canUseTool: async (name, input) =>
      allowed.has(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `本环境只允许只读 SQL 工具，${name} 不可用` },
    persistSession: false,
    ...(abort ? { abortController: abort } : {}),
  };
}

/**
 * 跑一轮只读 SQL 分析。
 *
 * @param {object} opts
 * @param {string} opts.prompt 完整提示词（业务语义由调用方注入，本层不关心）
 * @param {Function} opts.execute 见 buildSqlToolServer
 * @param {Function} [opts.onAudit]
 * @param {object} [opts.policy]
 * @param {string} [opts.model]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ text: string, queries: number, reason: string|null, denied: string[] }>}
 *   reason: null=正常 / 'exhausted'=额度耗尽 / 'timeout' / 'error'
 */
export async function runSqlAgent(opts) {
  const { prompt, execute, onAudit, policy, model, signal } = opts;
  const maxQueries = opts.maxQueries ?? DEFAULT_MAX_QUERIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 额度耗尽 fail-fast：不发起注定失败 / 会 stall 的调用（同 llm-classify 的处理）
  if (isPoolExhausted(getTokens())) {
    logger.warn('llm-sql-agent', 'token 池全部耗尽，跳过分析（fail-fast）');
    return { text: '', queries: 0, reason: 'exhausted', denied: [] };
  }

  const budget = { count: 0 };
  const denied = [];
  const { server, tools } = buildSqlToolServer({
    execute,
    policy,
    maxQueries,
    budget,
    extraTools: opts.extraTools,
    onAudit: (e) => {
      if (!e.ok && e.denyCode) denied.push(e.denyCode);
      onAudit?.(e);
    },
  });

  // 白名单**从实际装配的工具算出来**，不写死 TOOL_NAMES ——
  // 否则调用方传了 extraTools，canUseTool 会把它们全拒掉（而且是静默的：
  // 模型看得见工具、一调就被拒，日志里只有一句权限拒绝，极难往这里想）。
  const allowed = new Set(Object.keys(tools).map((n) => `mcp__${SERVER}__${n}`));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const onExternalAbort = () => abort.abort();
  signal?.addEventListener?.('abort', onExternalAbort);

  let out = '';
  try {
    const q = query({ prompt, options: buildAgentOptions({ server, allowed, model, abort }) });

    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) {
          if (b.type === 'text') out += b.text;
        }
      } else if (m.type === 'result' && !out && m.result) {
        out = m.result;
      }
    }
  } catch (e) {
    logger.warn('llm-sql-agent', '分析调用异常（已落兜底）', { err: e?.message || String(e) });
    return {
      text: out,
      queries: budget.count,
      reason: abort.signal.aborted ? 'timeout' : 'error',
      denied,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onExternalAbort);
  }

  return {
    text: out,
    queries: budget.count,
    reason: abort.signal.aborted ? 'timeout' : null,
    denied,
  };
}

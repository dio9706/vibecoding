/**
 * llm-sql-agent 单测 —— 只测**工具面与闸门**，不起真 Agent、不连库。
 *
 * 起真 Agent 的测试会变成「网络 + 额度 + 模型心情」三重依赖的 flaky 测试，
 * 而这里要守的东西恰恰是确定性的：工具集里有什么、每个工具对坏输入怎么反应、
 * 预算与审计有没有如实记录。直接调 buildSqlToolServer 拿到工具定义逐个验，
 * 比端到端跑一遍更可靠也更快。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSqlToolServer, buildAgentOptions, TOOL_NAMES, DEFAULT_MAX_QUERIES } from './llm-sql-agent.js';

/** 解析工具返回的 CallToolResult */
function parse(res) {
  const text = res?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function harness(over = {}) {
  const executed = [];
  const audits = [];
  const { server, tools } = buildSqlToolServer({
    execute: async (sql, maxRows) => {
      executed.push({ sql, maxRows });
      return { columns: ['c'], rows: [[1]], rowCount: 1, truncated: false, ms: 5 };
    },
    onAudit: (e) => audits.push(e),
    ...over,
  });
  return { server, tools, executed, audits };
}

describe('工具面：只有三个 SQL 工具', () => {
  it('恰好三个，名字固定', () => {
    const { tools } = harness();
    assert.deepEqual(Object.keys(tools).sort(), ['describe_table', 'list_tables', 'run_query']);
  });

  it('TOOL_NAMES 是 mcp__<server>__<tool> 全名（allowedTools 要用全名）', () => {
    for (const n of Object.values(TOOL_NAMES)) {
      assert.match(n, /^mcp__sqlro__[a-z_]+$/);
    }
  });

  it('不含任何文件/Bash 类工具', () => {
    const { tools } = harness();
    for (const forbidden of ['Read', 'Write', 'Bash', 'Edit', 'WebFetch', 'Glob', 'Grep']) {
      assert.equal(forbidden in tools, false, `工具集里不该出现 ${forbidden}`);
    }
  });
});

describe('run_query：安全闸', () => {
  it('写操作被拒且不落到 execute', async () => {
    const { tools, executed, audits } = harness();
    const r = parse(await tools.run_query.handler({ sql: 'DROP TABLE t', purpose: '搞事' }));
    assert.match(r.error, /安全策略/);
    assert.equal(executed.length, 0, '被拒的 SQL 绝不能碰数据库');
    assert.equal(audits[0].ok, false);
    assert.equal(audits[0].denyCode, 'not_select');
  });

  it('PII 查询被拒并记 denyCode', async () => {
    const { tools, audits } = harness();
    const r = parse(await tools.run_query.handler({ sql: 'SELECT phone FROM users', purpose: '要手机号' }));
    assert.match(r.error, /安全策略/);
    assert.equal(audits[0].denyCode, 'pii_denied');
  });

  it('正常聚合查询放行并审计成功', async () => {
    const { tools, executed, audits } = harness();
    const r = parse(await tools.run_query.handler({ sql: 'SELECT COUNT(*) FROM orders', purpose: '订单数' }));
    assert.equal(r.rowCount, 1);
    assert.equal(executed.length, 1);
    assert.equal(audits[0].ok, true);
    assert.equal(audits[0].purpose, '订单数');
  });

  it('execute 抛错时不炸，转成 error 文本并审计', async () => {
    const { tools, audits } = harness({
      execute: async () => {
        throw new Error('连接超时');
      },
    });
    const r = parse(await tools.run_query.handler({ sql: 'SELECT 1', purpose: 'x' }));
    assert.match(r.error, /连接超时/);
    assert.equal(audits[0].ok, false);
  });

  it('policy 可关闭 PII 限制（透传给 sql-guard）', async () => {
    const { tools, executed } = harness({ policy: { piiColumns: [] } });
    await tools.run_query.handler({ sql: 'SELECT phone FROM users', purpose: 'x' });
    assert.equal(executed.length, 1);
  });
});

describe('run_query：查询次数预算', () => {
  it('超上限后拒绝，且不再消耗 DB', async () => {
    const budget = { count: 0 };
    const { tools, executed } = harness({ maxQueries: 2, budget });
    await tools.run_query.handler({ sql: 'SELECT 1', purpose: 'a' });
    await tools.run_query.handler({ sql: 'SELECT 2', purpose: 'b' });
    const r = parse(await tools.run_query.handler({ sql: 'SELECT 3', purpose: 'c' }));
    assert.match(r.error, /次数上限/);
    assert.equal(executed.length, 2);
  });

  it('被安全策略拒绝的查询也计入预算（防无限试探）', async () => {
    const budget = { count: 0 };
    const { tools } = harness({ maxQueries: 1, budget });
    await tools.run_query.handler({ sql: 'DROP TABLE t', purpose: 'x' });
    const r = parse(await tools.run_query.handler({ sql: 'SELECT 1', purpose: 'y' }));
    assert.match(r.error, /次数上限/);
  });

  it('默认上限是个够用的数（低频功能，宁可给足）', () => {
    assert.ok(DEFAULT_MAX_QUERIES >= 10);
  });
});

describe('describe_table：表名注入防护', () => {
  it('合法表名放行', async () => {
    const { tools, executed } = harness();
    await tools.describe_table.handler({ table: 'orders' });
    assert.match(executed[0].sql, /table_name = 'orders'/);
  });

  it('把 SQL 塞进 table 参数会被形状校验挡住', async () => {
    const { tools, executed } = harness();
    for (const evil of ["x' OR '1'='1", 'a; DROP TABLE t', 'db.tbl', "x'--", '']) {
      const r = parse(await tools.describe_table.handler({ table: evil }));
      assert.match(r.error || '', /表名不合法/, `应拒绝：${evil}`);
    }
    assert.equal(executed.length, 0);
  });
});

describe('list_tables：模糊匹配不得逃逸', () => {
  it('剥掉 LIKE 通配符与转义符，避免 pattern 改变语义', async () => {
    const { tools, executed } = harness();
    await tools.list_tables.handler({ pattern: "%_\\'" });
    // 通配符被剥光后只剩安全字符
    assert.doesNotMatch(executed[0].sql.split('LIKE')[1], /[%_]\w*[%_]\w*[%_]/);
  });

  it('留空则列全部', async () => {
    const { tools, executed } = harness();
    await tools.list_tables.handler({});
    assert.match(executed[0].sql, /LIKE '%'/);
  });
});

describe('buildAgentOptions —— 守住两个静默失效的坑（2026-09-07 实测踩过）', () => {
  const allowed = new Set(Object.values(TOOL_NAMES));
  const opts = buildAgentOptions({ server: { type: 'sdk', name: 'sqlro' }, allowed });

  it('用 tools:[] 收窄工具面，**不得**用 disallowedTools', () => {
    // disallowedTools 的语义是「从模型上下文里移除，即便本来会被允许」——
    // 通配符会连自家 MCP 工具一起删，实测表现为三个工具全部 Permission denied。
    assert.deepEqual(opts.tools, [], 'tools:[] 才是禁内置工具的正确字段');
    assert.equal('disallowedTools' in opts, false, 'disallowedTools 会连 MCP 工具一起删掉');
  });

  it('**不得**设 allowedTools —— 那会让 canUseTool 整个不被调用', () => {
    // SDK 会打印 [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]；第 2 层防线形同虚设而代码看着正常
    assert.equal('allowedTools' in opts, false);
    assert.equal(typeof opts.canUseTool, 'function');
  });

  it('permissionMode 必须是 default（bypassPermissions 会绕过 canUseTool）', () => {
    assert.equal(opts.permissionMode, 'default');
  });

  it('canUseTool 放行三个 SQL 工具、拒绝其余一切', async () => {
    for (const n of allowed) {
      assert.equal((await opts.canUseTool(n, { a: 1 })).behavior, 'allow', n + ' 应放行');
    }
    for (const n of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'mcp__other__x']) {
      const r = await opts.canUseTool(n, {});
      assert.equal(r.behavior, 'deny', n + ' 应拒绝');
      assert.match(r.message, /只读 SQL/);
    }
  });

  it('canUseTool 放行时原样透传 input（吞掉入参会让工具收不到参数）', async () => {
    const input = { sql: 'SELECT 1', purpose: 'x' };
    assert.deepEqual((await opts.canUseTool(TOOL_NAMES.runQuery, input)).updatedInput, input);
  });

  it('MCP 服务器挂在约定的名字下（工具全名依赖它）', () => {
    assert.ok(opts.mcpServers.sqlro, 'server 名变了 TOOL_NAMES 就对不上');
  });
});

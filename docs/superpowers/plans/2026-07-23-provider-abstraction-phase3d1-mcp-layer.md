# Provider 抽象 · Phase 3d-1（MCP 集成层）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `src/providers/mcp.js`——连一组 stdio MCP server、聚合工具、拆成"定义（给 streamText）+ 执行（经审批后调）"，供 Phase 3d-2 的 `startOpenAiRun` 使用。自包含、离线可测。

**Architecture:** `connectMcpServers(configs, {cwd,signal})` → `{ toolDefs, executeTool, close }`。`toolDefs` = 各工具剥掉 execute（仅 `{description,inputSchema}`，模型请求但不自动执行）；`executeTool(name,input)` = 调保留的 MCP 工具 execute（审批由 agent-loop 的 `canUseTool` 在调用前完成）；`close()` 关全部 client。纯函数 `normalizeMcpResult` 把 MCP 结果转成 agent-loop 可回灌形态。失败隔离：某 server 连不上 → warn + 跳过，不阻断。

**Tech Stack:** Node.js ESM；`@ai-sdk/mcp@2.0.16`（`createMCPClient` + `@ai-sdk/mcp/mcp-stdio` 的 `Experimental_StdioMCPTransport`，已装并提交于 `ba03bc7`）；`@modelcontextprotocol/sdk`（已装，用于测试夹具起本地 MCP server）；`zod`；`node:test`。

## 已核实（spike 实测 @ai-sdk/mcp@2.0.16）
- `createMCPClient({ transport: new Experimental_StdioMCPTransport({ command, args, cwd, env }) })` → `await client.tools()` → `{ <name>: tool }`。
- tool 对象含 `description`(string) / `inputSchema`(schema 包装对象) / `execute`(function) 等。
- `await tool.execute(input, { toolCallId, messages, abortSignal? })` → `{ content: [{type:'text', text}], isError:boolean }`。
- `await client.close()`。

## 本期范围（对照 3d spec 模块 1）
MCP 集成层 + 测试。**不含** startOpenAiRun 接线/审批/capabilities（3d-2）、配置存储/API/前端（3d-3）。

## 文件结构
- Create `src/providers/mcp.js` — `connectMcpServers` + 纯 `normalizeMcpResult`。
- Create `src/providers/mcp.test.js` — 纯函数单测 + 真实 echo MCP server 集成测试。
- Create `tests/fixtures/echo-mcp-server.mjs` — 测试夹具（最小 stdio MCP server，一个 echo 工具）。

---

### Task 1: MCP 集成层 `mcp.js`

**Files:**
- Create: `src/providers/mcp.js`
- Create: `tests/fixtures/echo-mcp-server.mjs`
- Test: `src/providers/mcp.test.js`

- [ ] **Step 1: 写测试夹具** — 写入 `tests/fixtures/echo-mcp-server.mjs`：

```js
// 最小 stdio MCP server（测试夹具）：一个 echo 工具。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '0.0.1' });
server.tool('echo', 'echo back text', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: 'ECHO:' + text }],
}));
server.tool('boom', 'always errors', {}, async () => ({
  content: [{ type: 'text', text: 'kaboom' }],
  isError: true,
}));
await server.connect(new StdioServerTransport());
```

- [ ] **Step 2: 写失败测试** — 写入 `src/providers/mcp.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMcpServers, normalizeMcpResult } from './mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'echo-mcp-server.mjs');

test('normalizeMcpResult：取 text 内容；isError → {error}', () => {
  assert.equal(normalizeMcpResult({ content: [{ type: 'text', text: 'hi' }], isError: false }), 'hi');
  assert.deepEqual(normalizeMcpResult({ content: [{ type: 'text', text: 'bad' }], isError: true }), { error: 'bad' });
  assert.equal(normalizeMcpResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
});

test('connectMcpServers：连真实 echo server → toolDefs 剥 execute + executeTool 可用 + close', async () => {
  const mcp = await connectMcpServers([{ command: 'node', args: [FIXTURE] }], {});
  try {
    // toolDefs 含 echo/boom，且只有 description+inputSchema（无 execute）
    assert.ok(mcp.toolDefs.echo, '应含 echo 工具定义');
    assert.equal(typeof mcp.toolDefs.echo.description, 'string');
    assert.ok(mcp.toolDefs.echo.inputSchema, '应含 inputSchema');
    assert.equal(mcp.toolDefs.echo.execute, undefined, 'toolDefs 不应带 execute');
    // executeTool 真跑
    const out = await mcp.executeTool('echo', { text: 'hi' });
    assert.equal(out, 'ECHO:hi');
    // isError 工具 → {error}
    const err = await mcp.executeTool('boom', {});
    assert.equal(err.error, 'kaboom');
    // 未知工具抛错
    await assert.rejects(() => mcp.executeTool('nope', {}), /未知 MCP 工具/);
  } finally {
    await mcp.close();
  }
});

test('connectMcpServers：连不上的 server 被隔离，不抛（返回空工具集）', async () => {
  const mcp = await connectMcpServers([{ command: 'node', args: ['/nonexistent/xyz-does-not-exist.mjs'] }], {});
  assert.deepEqual(Object.keys(mcp.toolDefs), []);
  await mcp.close();
});
```

- [ ] **Step 3: 运行测试确认失败** — Run: `node --test "src/providers/mcp.test.js"` — Expected: FAIL（`Cannot find module './mcp.js'`）。

- [ ] **Step 4: 写最小实现** — 写入 `src/providers/mcp.js`：

```js
/**
 * MCP 集成层：连一组 stdio MCP server，聚合工具，拆成"定义 + 执行"。
 * 定义（toolDefs）给 streamText（剥掉 execute → 模型请求但不自动执行）；
 * 执行（executeTool）由 agent-loop 在 canUseTool 审批通过后调用。
 * 已核实 @ai-sdk/mcp@2.0.16：client.tools() 的工具含 description/inputSchema/execute；
 * execute(input,{toolCallId,messages}) → { content:[{type:'text',text}], isError }。
 */
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { logger } from '../shared/logger.js';

/**
 * @param {Array<{id?:string,command:string,args?:string[],cwd?:string,env?:object}>} configs
 * @param {{ cwd?:string, signal?:AbortSignal }} [ctx]
 * @returns {Promise<{ toolDefs:object, executeTool:(name:string,input:any)=>Promise<any>, close:()=>Promise<void> }>}
 */
export async function connectMcpServers(configs, ctx = {}) {
  const clients = [];
  const toolDefs = {}; // name -> { description, inputSchema }
  const executors = {}; // name -> execute
  for (const cfg of Array.isArray(configs) ? configs : []) {
    if (!cfg || !cfg.command) continue;
    try {
      const client = await createMCPClient({
        transport: new Experimental_StdioMCPTransport({
          command: cfg.command,
          ...(Array.isArray(cfg.args) ? { args: cfg.args } : {}),
          cwd: cfg.cwd || ctx.cwd,
          ...(cfg.env ? { env: cfg.env } : {}),
        }),
      });
      clients.push(client);
      const tools = await client.tools();
      for (const [name, t] of Object.entries(tools)) {
        toolDefs[name] = { description: t.description, inputSchema: t.inputSchema };
        executors[name] = t.execute; // 保留原 execute，审批后调
      }
    } catch (e) {
      logger.warn('mcp', 'MCP server 连接失败，跳过', { command: cfg.command, err: e?.message || String(e) });
    }
  }
  async function executeTool(name, input) {
    const exec = executors[name];
    if (!exec) throw new Error(`未知 MCP 工具：${name}`);
    const r = await exec(input, { toolCallId: 'mcp-' + name, messages: [], abortSignal: ctx.signal });
    return normalizeMcpResult(r);
  }
  async function close() {
    for (const c of clients) {
      try {
        await c.close();
      } catch {
        /* ignore：进程可能已随 abort 退出 */
      }
    }
  }
  return { toolDefs, executeTool, close };
}

/** 纯函数：MCP 工具结果 → agent-loop 可回灌形态（取 text 内容；isError → {error}）。 */
export function normalizeMcpResult(r) {
  const content = Array.isArray(r?.content) ? r.content : [];
  const text = content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  if (r?.isError) return { error: text || 'MCP 工具执行失败' };
  return text || content;
}
```

- [ ] **Step 5: 运行测试确认通过** — Run: `node --test "src/providers/mcp.test.js"` — Expected: PASS（3 tests：normalizeMcpResult + 真实连接 + 隔离）。真实连接用测试夹具起本地 node 进程，无需网络。若首跑因进程启动慢偶发超时，重跑一次确认。

- [ ] **Step 6: 全量 provider 回归 + 语法检查** — Run: `node --test "src/providers/*.test.js" && node --check src/providers/mcp.js` — Expected: 全绿（原 28 + mcp 3 = 31），`node --check` 无输出。

- [ ] **Step 7: 提交**
```bash
git add src/providers/mcp.js src/providers/mcp.test.js tests/fixtures/echo-mcp-server.mjs
git commit -m "feat(providers): MCP 集成层（连 stdio server + 工具定义/执行分离）"
```

## 自检
- 定义/执行分离：`toolDefs` 剥 execute（测试断言 `execute===undefined`）；`executeTool` 调保留的 execute。
- 失败隔离：连不上的 server warn+跳过（测试覆盖）。
- `normalizeMcpResult` 纯函数可测（text 拼接 / isError→error）。
- abort：`executeTool` 把 `ctx.signal` 透进 execute options；`close()` 关全部 client。
- 命名一致：`connectMcpServers`/`normalizeMcpResult`、返回 `{toolDefs,executeTool,close}`。
## 验证命令：引号 glob `node --test "src/providers/*.test.js"`；不用裸/目录形式。
## 提交纪律：只 add 列出的 3 文件，不用 `git add -A`；分支 `feat/config-import-export`。

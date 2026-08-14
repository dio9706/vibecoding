import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMcpServers, normalizeMcpResult, buildAutoAllowSet } from './mcp.js';

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
    assert.ok(mcp.toolDefs.echo, '应含 echo 工具定义');
    assert.equal(typeof mcp.toolDefs.echo.description, 'string');
    assert.ok(mcp.toolDefs.echo.inputSchema, '应含 inputSchema');
    assert.equal(mcp.toolDefs.echo.execute, undefined, 'toolDefs 不应带 execute');
    const out = await mcp.executeTool('echo', { text: 'hi' });
    assert.equal(out, 'ECHO:hi');
    const err = await mcp.executeTool('boom', {});
    assert.equal(err.error, 'kaboom');
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

test('connectMcpServers：signal 已中断 → 立即抛 AbortError，不发起连接', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => connectMcpServers([{ command: 'node', args: [FIXTURE] }], { signal: ac.signal }),
    (e) => e.name === 'AbortError',
  );
});

test('connectMcpServers：连接中途 abort → 快速抛 AbortError（不等握手超时）', async () => {
  const ac = new AbortController();
  // 该子进程能 spawn 但永远不说 MCP 协议 → createMCPClient 会挂在 initialize
  const hangCfg = { command: 'node', args: ['-e', 'setTimeout(()=>{}, 30000)'] };
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(
    () => connectMcpServers([hangCfg], { signal: ac.signal }),
    (e) => e.name === 'AbortError',
  );
  assert.ok(Date.now() - t0 < 5000, 'abort 后应快速返回，而非等满 30s 握手挂起');
});

test('buildAutoAllowSet：跨 server 并集 + 修剪空白 + 容错非法输入', () => {
  const set = buildAutoAllowSet([
    { autoAllow: ['read_file', ' list_dir ', ''] },
    { autoAllow: ['read_file', 'stat'] },
    { autoAllow: 'nope' },
    null,
  ]);
  assert.deepEqual([...set].sort(), ['list_dir', 'read_file', 'stat']);
  assert.equal(buildAutoAllowSet(undefined).size, 0);
});

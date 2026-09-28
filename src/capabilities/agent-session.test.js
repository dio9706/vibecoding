import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnOptions, AGENT_TURN_TIMEOUT_MS, parseTurnStream } from './agent-session.js';

const base = () => ({
  server: { __fake: true },
  allowed: new Set(['mcp__colleague__get_thing']),
  systemPrompt: '你是助手',
});

test('buildTurnOptions：tools 必须是空数组（禁全部内置工具）', () => {
  const o = buildTurnOptions(base());
  assert.deepEqual(o.tools, []);
});

// —— 坑一（llm-sql-agent 文件头实测）：disallowedTools:['*'] 的语义是
// 「removed from the model's context, even if they would otherwise be allowed」，
// 通配符会把我们自己的 MCP 工具一起删掉，表现是工具全部 Permission denied。
test('buildTurnOptions：绝不设 disallowedTools（通配符会连 MCP 工具一起删）', () => {
  const o = buildTurnOptions(base());
  assert.equal(o.disallowedTools, undefined);
});

// —— 坑二：allowedTools 是免审批名单，设了会让 canUseTool 整个不被调用
// （SDK 打印 [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]）。本设计的危险级判定、
// 撤销台账、限流计数全挂在 canUseTool 上，设了它等于整套审计静默失效。
test('buildTurnOptions：绝不设 allowedTools（会架空 canUseTool）', () => {
  const o = buildTurnOptions(base());
  assert.equal(o.allowedTools, undefined);
});

test('buildTurnOptions：permissionMode 必须是 default（bypassPermissions 会绕过 canUseTool）', () => {
  const o = buildTurnOptions(base());
  assert.equal(o.permissionMode, 'default');
});

test('buildTurnOptions：mcpServers 按约定的 server 名挂载', () => {
  const o = buildTurnOptions(base());
  assert.deepEqual(Object.keys(o.mcpServers), ['colleague']);
});

test('buildTurnOptions：canUseTool 放行白名单内、拒绝白名单外', async () => {
  const o = buildTurnOptions(base());
  assert.deepEqual(await o.canUseTool('mcp__colleague__get_thing', { a: 1 }), {
    behavior: 'allow',
    updatedInput: { a: 1 },
  });
  const denied = await o.canUseTool('Bash', {});
  assert.equal(denied.behavior, 'deny');
});

test('buildTurnOptions：有 sessionId 才带 resume，没有则不带该键', () => {
  assert.equal(buildTurnOptions(base()).resume, undefined);
  assert.equal(buildTurnOptions({ ...base(), sessionId: 'sess_1' }).resume, 'sess_1');
});

test('buildTurnOptions：cwd / model 有才带，没有不带空值', () => {
  const o = buildTurnOptions(base());
  assert.equal(o.cwd, undefined);
  assert.equal(o.model, undefined);
  const o2 = buildTurnOptions({ ...base(), cwd: 'D:/p', model: 'claude-haiku-4-5-20251001' });
  assert.equal(o2.cwd, 'D:/p');
  assert.equal(o2.model, 'claude-haiku-4-5-20251001');
});

test('AGENT_TURN_TIMEOUT_MS：对话场景的超时预算是 2 分钟', () => {
  assert.equal(AGENT_TURN_TIMEOUT_MS, 120_000);
});

/** 造一个假的 SDK 消息流 */
async function* fakeStream(messages) {
  for (const m of messages) yield m;
}

test('parseTurnStream：拼接 assistant 的 text block', async () => {
  const r = await parseTurnStream(fakeStream([
    { type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '，我看一下' }] } },
  ]));
  assert.equal(r.text, '你好，我看一下');
});

test('parseTurnStream：记录 tool_use 轨迹（审计用）', async () => {
  const r = await parseTurnStream(fakeStream([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'mcp__colleague__get_requirement', input: { reqId: 'r_1' } },
          { type: 'text', text: '查到了' },
        ],
      },
    },
  ]));
  assert.equal(r.text, '查到了');
  assert.deepEqual(r.toolTrace, [{ name: 'get_requirement', input: { reqId: 'r_1' } }]);
});

test('parseTurnStream：从 system/init 拿 sessionId', async () => {
  const r = await parseTurnStream(fakeStream([
    { type: 'system', subtype: 'init', session_id: 'sess_abc' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
  ]));
  assert.equal(r.sessionId, 'sess_abc');
});

test('parseTurnStream：result 上的 session_id 覆盖 init（以最终为准）', async () => {
  const r = await parseTurnStream(fakeStream([
    { type: 'system', subtype: 'init', session_id: 'sess_old' },
    { type: 'result', session_id: 'sess_new', result: '' },
  ]));
  assert.equal(r.sessionId, 'sess_new');
});

test('parseTurnStream：没有 assistant text 时退回 result.result', async () => {
  const r = await parseTurnStream(fakeStream([
    { type: 'result', session_id: 's1', result: '兜底文本' },
  ]));
  assert.equal(r.text, '兜底文本');
});

test('parseTurnStream：空流不抛，返回空文本', async () => {
  const r = await parseTurnStream(fakeStream([]));
  assert.equal(r.text, '');
  assert.equal(r.sessionId, null);
  assert.deepEqual(r.toolTrace, []);
});

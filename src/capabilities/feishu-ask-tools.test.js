/**
 * feishu-ask-tools.js 测试：工具定义形状 + 各状态的结果文案（依赖注入，不触网络）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuAskTools, FEISHU_ASK_READONLY_TOOLS } from './feishu-ask-tools.js';

const OK_ASK = { ok: true, questionId: 'fq_x', colleague: { id: 'cl_z', name: '张三', role: 'backend' } };

test('工具定义：两个工具带描述与 schema', () => {
  const { toolDefs } = createFeishuAskTools();
  assert.deepEqual(Object.keys(toolDefs).sort(), ['AskColleague', 'WaitColleagueReply']);
  for (const def of Object.values(toolDefs)) {
    assert.equal(typeof def.description, 'string');
    assert.ok(def.inputSchema);
  }
});

test('readonly 集合：只放行「等待」，提问本身走审批', () => {
  assert.ok(FEISHU_ASK_READONLY_TOOLS.has('WaitColleagueReply'));
  assert.ok(!FEISHU_ASK_READONLY_TOOLS.has('AskColleague'));
});

test('AskColleague：成功时带上问题ID与后续指引，并把运行上下文传给核心', async () => {
  const calls = [];
  const { executeTool } = createFeishuAskTools(
    { runId: 'run_1', convId: 'conv_1' },
    { ask: async (input) => { calls.push(input); return OK_ASK; } },
  );
  const out = await executeTool('AskColleague', { role: 'backend', name: '张三', question: '字段是哪个？' });
  assert.match(out, /张三/);
  assert.match(out, /fq_x/);
  assert.match(out, /WaitColleagueReply/);
  assert.equal(calls[0].runId, 'run_1');
  assert.equal(calls[0].convId, 'conv_1');
  assert.equal(calls[0].role, 'backend');
});

test('AskColleague：核心返回错误 → ⚠️ 前缀 + 原文', async () => {
  const { executeTool } = createFeishuAskTools({}, { ask: async () => ({ error: '未启用飞书机器人' }) });
  const out = await executeTool('AskColleague', { question: 'x' });
  assert.match(out, /^⚠️ 提问失败：未启用飞书机器人/);
});

test('WaitColleagueReply：concluded → 结论 + 原文 + activity 通知', async () => {
  const events = [];
  const { executeTool } = createFeishuAskTools(
    { activity: (t) => events.push(t) },
    {
      wait: async () => ({
        status: 'concluded',
        conclusion: '字段是 user_id',
        colleagueName: '张三',
        followUps: 1,
        transcript: [
          { dir: 'out', text: '字段是哪个？' },
          { dir: 'in', text: 'user_id' },
        ],
      }),
    },
  );
  const out = await executeTool('WaitColleagueReply', { question_id: 'fq_x' });
  assert.match(out, /已与「张三」沟通得出结论/);
  assert.match(out, /字段是 user_id/);
  assert.match(out, /对话原文/);
  assert.match(out, /对方：user_id/);
  assert.deepEqual(events, ['📨 已与 张三 得出结论']);
});

test('WaitColleagueReply：其余状态都有明确文案（不让模型对着空白猜）', async () => {
  const cases = [
    ['abandoned', /仍未得出结论/],
    ['expired', /已过期/],
    ['timeout', /等待超时/],
    ['aborted', /等待已停止/],
    ['busy', /已在等待中/],
    ['unknown', /未找到该提问/],
  ];
  for (const [status, re] of cases) {
    const { executeTool } = createFeishuAskTools({}, { wait: async () => ({ status, colleagueName: '张三', followUps: 2, transcript: [] }) });
    const out = await executeTool('WaitColleagueReply', { question_id: 'fq_x' });
    assert.match(out, re, `状态 ${status} 的文案`);
  }
});

test('WaitColleagueReply：timeout_seconds 换算成毫秒传给核心', async () => {
  let seen = null;
  const { executeTool } = createFeishuAskTools({}, { wait: async (qid, opts) => { seen = opts; return { status: 'timeout' }; } });
  await executeTool('WaitColleagueReply', { question_id: 'fq_x', timeout_seconds: 120 });
  assert.equal(seen.timeoutMs, 120_000);
  assert.equal(seen.signal, undefined, '未提供 signal 时不传');
});

test('未知工具名抛错（装配错误要显式暴露，不静默）', async () => {
  const { executeTool } = createFeishuAskTools();
  await assert.rejects(() => executeTool('Nope', {}), /未知的飞书询问工具/);
});

/**
 * 锚点迁移单测：旧结构（按需求分组）→ 新结构（按人分组，reqId 降为消息标签）。
 * 迁移是一次性、破坏性的，四种输入形状必须全覆盖 —— 跑错一次，同事的历史对话就散了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateColleagueMessages, migrateColleagueMessagesDetailed, isLegacyShape } from './colleague-messages.migration.js';

const msg = (id, text, at) => ({ id, dir: 'in', text, at, role: 'backend', status: 'unread' });

test('旧结构：按需求分组摊平成按人分组，每条消息补上它原来所在的 reqId', () => {
  const raw = {
    r_a: { cl_1: { messages: [msg('cm_1', 'a-1', '2026-09-01T00:00:00Z')], lastInboundAt: '2026-09-01T00:00:00Z' } },
    r_b: { cl_1: { messages: [msg('cm_2', 'b-1', '2026-09-02T00:00:00Z')], lastInboundAt: '2026-09-02T00:00:00Z' } },
  };
  const out = migrateColleagueMessages(raw);
  assert.deepEqual(Object.keys(out), ['cl_1'], '同一个人在两个需求里的对话必须合成一条线');
  assert.equal(out.cl_1.messages.length, 2);
  assert.equal(out.cl_1.messages[0].reqId, 'r_a', 'reqId 降级成消息标签，不能丢');
  assert.equal(out.cl_1.messages[1].reqId, 'r_b');
  assert.equal(out.cl_1.agentSessionId, null, '新线程的 SDK 锚点初始为 null');
});

test('旧结构：多人多需求，各自归位', () => {
  const raw = {
    r_a: {
      cl_1: { messages: [msg('cm_1', 'x', '2026-09-01T00:00:00Z')], lastInboundAt: '2026-09-01T00:00:00Z' },
      cl_2: { messages: [msg('cm_2', 'y', '2026-09-01T01:00:00Z')], lastInboundAt: '2026-09-01T01:00:00Z' },
    },
  };
  const out = migrateColleagueMessages(raw);
  assert.deepEqual(Object.keys(out).sort(), ['cl_1', 'cl_2']);
  assert.equal(out.cl_1.messages[0].text, 'x');
  assert.equal(out.cl_2.messages[0].text, 'y');
});

test('旧结构：合并后按时间排序 —— 两个需求的消息交错时，对话顺序不能乱', () => {
  const raw = {
    r_a: { cl_1: { messages: [msg('cm_1', '早', '2026-09-01T00:00:00Z'), msg('cm_3', '晚', '2026-09-03T00:00:00Z')] } },
    r_b: { cl_1: { messages: [msg('cm_2', '中', '2026-09-02T00:00:00Z')] } },
  };
  const out = migrateColleagueMessages(raw);
  assert.deepEqual(out.cl_1.messages.map((m) => m.text), ['早', '中', '晚']);
});

test('旧结构：lastInboundAt 取各需求里最晚的那个', () => {
  const raw = {
    r_a: { cl_1: { messages: [msg('cm_1', 'x', '2026-09-01T00:00:00Z')], lastInboundAt: '2026-09-01T00:00:00Z' } },
    r_b: { cl_1: { messages: [msg('cm_2', 'y', '2026-09-05T00:00:00Z')], lastInboundAt: '2026-09-05T00:00:00Z' } },
  };
  assert.equal(migrateColleagueMessages(raw).cl_1.lastInboundAt, '2026-09-05T00:00:00Z');
});

test('_pending 整节丢弃 —— 选择卡已下线，那些消息没有归属也无从补', () => {
  const raw = {
    r_a: { cl_1: { messages: [msg('cm_1', 'x', '2026-09-01T00:00:00Z')] } },
    _pending: { ou_xxx: { messages: [msg('cm_9', '丢', '2026-09-01T00:00:00Z')], askedAt: '2026-09-01T00:00:00Z' } },
  };
  const out = migrateColleagueMessages(raw);
  assert.ok(!('_pending' in out));
  assert.ok(!('ou_xxx' in out), '_pending 里的 openId 绝不能被当成 colleagueId 混进新结构');
  assert.equal(out.cl_1.messages.length, 1);
});

test('新结构：原样返回（幂等，重启多次不会反复迁移）', () => {
  const already = {
    cl_1: { agentSessionId: 'sess_x', messages: [{ ...msg('cm_1', 'x', '2026-09-01T00:00:00Z'), reqId: 'r_a' }], lastInboundAt: '2026-09-01T00:00:00Z' },
  };
  assert.deepEqual(migrateColleagueMessages(already), already);
});

test('混合结构：既有已迁移的人、又有没迁的需求 —— 两边都要保住', () => {
  const raw = {
    cl_1: { agentSessionId: 'sess_x', messages: [{ ...msg('cm_1', '已迁', '2026-09-01T00:00:00Z'), reqId: 'r_a' }] },
    r_b: { cl_2: { messages: [msg('cm_2', '未迁', '2026-09-02T00:00:00Z')] } },
  };
  const out = migrateColleagueMessages(raw);
  assert.equal(out.cl_1.messages[0].text, '已迁');
  assert.equal(out.cl_1.agentSessionId, 'sess_x', '已有的 SDK 锚点不能被抹掉');
  assert.equal(out.cl_2.messages[0].text, '未迁');
  assert.equal(out.cl_2.messages[0].reqId, 'r_b');
});

test('混合结构：同一个人既有已迁移数据、又有旧需求下的数据 → 合并且不丢 sessionId', () => {
  const raw = {
    cl_1: { agentSessionId: 'sess_x', messages: [{ ...msg('cm_1', '已迁', '2026-09-01T00:00:00Z'), reqId: 'r_a' }] },
    r_b: { cl_1: { messages: [msg('cm_2', '未迁', '2026-09-02T00:00:00Z')] } },
  };
  const out = migrateColleagueMessages(raw);
  assert.equal(out.cl_1.messages.length, 2);
  assert.equal(out.cl_1.agentSessionId, 'sess_x');
  assert.deepEqual(out.cl_1.messages.map((m) => m.text), ['已迁', '未迁']);
});

test('空 / 非法输入不炸', () => {
  assert.deepEqual(migrateColleagueMessages({}), {});
  assert.deepEqual(migrateColleagueMessages(null), {});
  assert.deepEqual(migrateColleagueMessages([]), {});
  assert.deepEqual(migrateColleagueMessages('x'), {});
});

test('isLegacyShape：靠 r_ 前缀 + 值形状判定，不靠有没有 _pending', () => {
  assert.equal(isLegacyShape({ r_a: { cl_1: { messages: [] } } }), true);
  assert.equal(isLegacyShape({ cl_1: { messages: [], agentSessionId: null } }), false);
  assert.equal(isLegacyShape({}), false);
  assert.equal(isLegacyShape({ _pending: {} }), false, '只剩 _pending 说明没有真数据，不值得触发迁移写盘');
});

test('Detailed：丢弃的 _pending 条数单独返回，绝不塞进 data（data 会被整份写回盘）', () => {
  const raw = {
    r_a: { cl_1: { messages: [msg('cm_1', 'x', '2026-09-01T00:00:00Z')] } },
    _pending: {
      ou_1: { messages: [msg('cm_8', 'p1', '2026-09-01T00:00:00Z'), msg('cm_9', 'p2', '2026-09-01T00:00:00Z')] },
    },
  };
  const r = migrateColleagueMessagesDetailed(raw);
  assert.equal(r.droppedPending, 2);
  assert.ok(!('droppedPending' in r.data));
  assert.ok(!('__droppedPending' in r.data), '内部计数绝不能进落盘数据');
  assert.equal(Object.keys(r.data).length, 1);
});

test('Detailed：新形状输入时 droppedPending 为 0（没有东西可丢）', () => {
  const r = migrateColleagueMessagesDetailed({ cl_1: { agentSessionId: null, messages: [] } });
  assert.equal(r.droppedPending, 0);
});

test('Detailed：新形状 + _pending 非空 —— _pending 仍要被剥离，droppedPending 不能恒为 0', () => {
  const raw = {
    cl_1: { agentSessionId: null, messages: [] },
    _pending: { ou_1: { messages: [msg('cm_8', 'p1', '2026-09-01T00:00:00Z')] } },
  };
  const r = migrateColleagueMessagesDetailed(raw);
  assert.ok(!('_pending' in r.data), '即便数据已是新形状，_pending 这个旧命名空间的残留也必须剥掉');
  assert.equal(r.droppedPending, 1, '新形状分支也要如实报告丢了多少条，不能因为分支不同就少算');
});

test('旧结构：messages 数组里混入非对象元素（null / 字符串 / 数字）被静默过滤，合法消息完好', () => {
  const raw = {
    r_a: {
      cl_1: {
        messages: [msg('cm_1', '合法1', '2026-09-01T00:00:00Z'), null, 'garbage', 42, msg('cm_2', '合法2', '2026-09-02T00:00:00Z')],
      },
    },
  };
  const out = migrateColleagueMessages(raw);
  assert.equal(out.cl_1.messages.length, 2, '垃圾元素被丢掉，不混进消息数组');
  assert.deepEqual(out.cl_1.messages.map((m) => m.text), ['合法1', '合法2']);
});

test('旧结构：顶层键的值是畸形数据（既不是 _pending，也不是新格式 thread，也不是 colleagueId 映射）时被静默跳过，不炸', () => {
  const raw = {
    r_a: { cl_1: { messages: [msg('cm_1', 'x', '2026-09-01T00:00:00Z')] } },
    garbage_key: 'not an object',
    another_garbage: 123,
  };
  const out = migrateColleagueMessages(raw);
  assert.deepEqual(Object.keys(out), ['cl_1'], '畸形顶层键不应产生任何输出，也不能连累合法数据');
  assert.equal(out.cl_1.messages[0].text, 'x');
});

test('缺 at 的消息排到最后，而不是排最前伪装成最早的一条', () => {
  const raw = {
    r_a: {
      cl_1: {
        messages: [
          { id: 'cm_1', dir: 'in', text: '有时间-早', at: '2026-09-01T00:00:00Z', role: 'backend', status: 'unread' },
          { id: 'cm_2', dir: 'in', text: '无时间', role: 'backend', status: 'unread' },
          { id: 'cm_3', dir: 'in', text: '有时间-晚', at: '2026-09-03T00:00:00Z', role: 'backend', status: 'unread' },
        ],
      },
    },
  };
  const out = migrateColleagueMessages(raw);
  assert.deepEqual(out.cl_1.messages.map((m) => m.text), ['有时间-早', '有时间-晚', '无时间']);
});

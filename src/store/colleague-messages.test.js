import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录：store/index.js 按 APP_DATA_DIR 定位，须在 import store 之前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsg-store-'));
const {
  normalizeEntry,
  getUnreadCounts,
  getUnreadTotals,
  markHandled,
  dropReqThreads,
  getColleagueThread,
  appendTo,
  markColleagueRead,
  getAgentSessionId,
  setAgentSessionId,
} = await import('./colleague-messages.js');

test('normalizeEntry：补齐缺省字段，status 非法归 unread', () => {
  const e = normalizeEntry({ dir: 'in', text: 'hi' });
  assert.equal(e.dir, 'in');
  assert.equal(e.status, 'unread');
  assert.equal(e.handledBy, null);
  assert.deepEqual(e.files, []);
  assert.match(e.id, /^cm_/);
  assert.ok(e.at);
  assert.equal(normalizeEntry({ dir: 'in', status: 'weird' }).status, 'unread');
  assert.equal(normalizeEntry({ dir: 'out' }).dir, 'out');
  assert.equal(normalizeEntry({ dir: 'nonsense' }).dir, 'in', 'dir 非法时 fail-safe 到 in');
});

test('appendTo → getColleagueThread 回读；in 更新 lastInboundAt，out 不更新', () => {
  appendTo('cl_a', { dir: 'in', text: '第一条', role: 'backend', reqId: 'r_1' });
  const t1 = getColleagueThread('cl_a');
  assert.equal(t1.messages.length, 1);
  assert.equal(t1.messages[0].text, '第一条');
  assert.equal(t1.messages[0].role, 'backend');
  assert.ok(t1.lastInboundAt);

  const before = getColleagueThread('cl_a').lastInboundAt;
  appendTo('cl_a', { dir: 'out', text: '我的回复', status: 'read', reqId: 'r_1' });
  const t2 = getColleagueThread('cl_a');
  assert.equal(t2.messages.length, 2);
  assert.equal(t2.lastInboundAt, before, 'out 方向不该刷新「最近来信时间」');
});

test('getColleagueThread：未知同事返回空骨架而非 undefined', () => {
  const t = getColleagueThread('cl_none');
  assert.deepEqual(t.messages, []);
  assert.equal(t.lastInboundAt, null);
});

test('getUnreadCounts：只数 in+unread；out 与已读不计', () => {
  appendTo('cl_x', { dir: 'in', text: 'a', reqId: 'r_2' });
  appendTo('cl_x', { dir: 'in', text: 'b', reqId: 'r_2' });
  appendTo('cl_x', { dir: 'out', text: 'c', reqId: 'r_2' });
  appendTo('cl_y', { dir: 'in', text: 'd', reqId: 'r_2' });
  assert.deepEqual(getUnreadCounts('r_2'), { cl_x: 2, cl_y: 1 });
  assert.deepEqual(getUnreadCounts('r_none'), {});
});

test('getUnreadTotals：按需求汇总，与逐需求调 getUnreadCounts 求和一致', () => {
  // 独立 reqId：本文件后续用例按条数断言 r_2 / r_3 的线程，往那里写会串台
  appendTo('cl_a', { dir: 'in', text: 'a', reqId: 'r_tot' });
  appendTo('cl_a', { dir: 'in', text: 'b', reqId: 'r_tot' });
  appendTo('cl_b', { dir: 'in', text: 'c', reqId: 'r_tot' });
  appendTo('cl_b', { dir: 'out', text: '去信不计', reqId: 'r_tot' });

  const totals = getUnreadTotals();
  assert.equal(totals.r_tot, 3, '跨同事求和，out 不计');
  // 与另一条口径交叉验证：两个函数各数一遍必须相等，否则侧栏红点与右栏 badge 会对不上
  const sum = Object.values(getUnreadCounts('r_tot')).reduce((n, v) => n + v, 0);
  assert.equal(totals.r_tot, sum, '总数应与逐同事求和一致');
  assert.ok(!('r_none' in totals), '无未读的需求不出现在结果里');

  markColleagueRead('cl_a', { reqId: 'r_tot' });
  assert.equal(getUnreadTotals().r_tot, 1, '标已读后总数应回落');
  markColleagueRead('cl_b', { reqId: 'r_tot' });
  assert.ok(!('r_tot' in getUnreadTotals()), '全部已读的需求应从结果里消失（前端据此不打红点）');
});

test('markColleagueRead(colleagueId, {reqId})：只清该需求下的 in+unread，其它需求不受影响', () => {
  markColleagueRead('cl_x', { reqId: 'r_2' });
  assert.deepEqual(getUnreadCounts('r_2'), { cl_y: 1 });
  assert.ok(getColleagueThread('cl_x').messages.every((m) => m.dir === 'out' || m.status === 'read'));
});

test('markColleagueRead：未知同事不炸、不写盘', () => {
  assert.doesNotThrow(() => markColleagueRead('cl_none', { reqId: 'r_none' }));
});

test('dropReqThreads：整条需求的同事会话被清空，别的需求不受影响', () => {
  appendTo('cl_a', { dir: 'in', text: '甲', reqId: 'r_drop' });
  appendTo('cl_b', { dir: 'in', text: '乙', reqId: 'r_drop' });
  appendTo('cl_a', { dir: 'in', text: '留着', reqId: 'r_keep' });

  dropReqThreads('r_drop');

  assert.deepEqual(getColleagueThread('cl_a').messages.filter((m) => m.reqId === 'r_drop'), []);
  assert.deepEqual(getColleagueThread('cl_b').messages.filter((m) => m.reqId === 'r_drop'), []);
  assert.equal(getColleagueThread('cl_a').messages.filter((m) => m.reqId === 'r_keep').length, 1, '别的需求不能被连坐');
  assert.doesNotThrow(() => dropReqThreads('r_never'), '不存在的需求应静默返回');
});

// ---- 四期：AI 自动处理落点 ----
// （四期分类器管线本身已在 P3 下线，见 colleague-dev.js 文件头；markHandled 作为通用的
// 「标记某条消息处理状态」仍被 colleague-dev 等新管线使用，回归用例留着。）

test('markHandled：只改目标条目的 handledBy/handledNote，不动 status，其余条目不变', () => {
  const a = appendTo('cl_h', { dir: 'in', text: '接口文档', role: 'backend', reqId: 'r_h' });
  const b = appendTo('cl_h', { dir: 'in', text: '另一条', role: 'backend', reqId: 'r_h' });
  assert.equal(markHandled('cl_h', a.id, { handledBy: 'ai', handledNote: '已处理 · 接入接口文档' }), true);
  const msgs = getColleagueThread('cl_h').messages;
  const ma = msgs.find((m) => m.id === a.id);
  const mb = msgs.find((m) => m.id === b.id);
  assert.equal(ma.handledBy, 'ai');
  assert.equal(ma.handledNote, '已处理 · 接入接口文档');
  assert.equal(ma.status, 'unread', 'status 是「主机看没看过」，AI 处理过主机仍该看到红点');
  assert.equal(mb.handledBy, null, '其余条目不受影响');
});

test('markHandled：未知 id / 未知会话返回 false，不写盘', () => {
  assert.equal(markHandled('cl_h', 'cm_nope', { handledBy: 'ai' }), false);
  assert.equal(markHandled('cl_none', 'cm_x', { handledBy: 'ai' }), false);
});

test('markHandled：handledBy 非法 / 缺省 → 返回 false 且条目不变（不能把已处理改回未处理还报成功）', () => {
  const a = appendTo('cl_h2', { dir: 'in', text: 'x', reqId: 'r_h2' });
  markHandled('cl_h2', a.id, { handledBy: 'manual', handledNote: '人工' });
  assert.equal(markHandled('cl_h2', a.id, { handledBy: 'robot' }), false);
  assert.equal(markHandled('cl_h2', a.id), false, '缺省 options 也拒绝');
  const m = getColleagueThread('cl_h2').messages[0];
  assert.equal(m.handledBy, 'manual');
  assert.equal(m.handledNote, '人工');
});

test('markHandled：handledNote 省略时归空串', () => {
  const a = appendTo('cl_h3', { dir: 'in', text: 'x', reqId: 'r_h3' });
  assert.equal(markHandled('cl_h3', a.id, { handledBy: 'ai' }), true);
  assert.equal(getColleagueThread('cl_h3').messages[0].handledNote, '');
});

test('markHandled：同一条二次标记是覆盖而非拒绝（失败重试时要能改写 note）', () => {
  const a = appendTo('cl_h4', { dir: 'in', text: 'x', reqId: 'r_h4' });
  markHandled('cl_h4', a.id, { handledBy: 'ai', handledNote: '处理失败 · T' });
  assert.equal(markHandled('cl_h4', a.id, { handledBy: 'ai', handledNote: '已处理 · T' }), true);
  assert.equal(getColleagueThread('cl_h4').messages[0].handledNote, '已处理 · T');
});

// ---- 2.0 锚点：按人存，reqId 降为消息标签 ----
// 新能力走新函数名；四个既有函数签名一个不改（见 Step 1 的纪律），它们的回归用例在本段末尾。

test('appendTo(colleagueId, entry)：按人落盘，reqId 作为标签存在消息上', () => {
  appendTo('cl_1', { dir: 'in', text: 'hi', role: 'backend', reqId: 'r_a' });
  const t = getColleagueThread('cl_1');
  assert.equal(t.messages.length, 1);
  assert.equal(t.messages[0].reqId, 'r_a');
  assert.equal(t.messages[0].text, 'hi');
});

test('同一个人跨需求的消息落在同一条线上（这是换锚点的全部目的）', () => {
  appendTo('cl_2', { dir: 'in', text: 'a', reqId: 'r_a' });
  appendTo('cl_2', { dir: 'in', text: 'b', reqId: 'r_b' });
  assert.equal(getColleagueThread('cl_2').messages.length, 2);
});

test('reqId 缺省（agent 还没判出归属）也能落盘，标签为 null', () => {
  appendTo('cl_3', { dir: 'in', text: '不知道属于哪个需求' });
  assert.equal(getColleagueThread('cl_3').messages[0].reqId, null);
});

test('getUnreadCounts(reqId)：按消息上的 reqId 标签过滤，对外语义不变', () => {
  appendTo('cl_4', { dir: 'in', text: 'x', reqId: 'r_x' });
  appendTo('cl_4', { dir: 'in', text: 'y', reqId: 'r_y' });
  appendTo('cl_5', { dir: 'in', text: 'z', reqId: 'r_x' });
  const c = getUnreadCounts('r_x');
  assert.equal(c.cl_4, 1, '只数带 r_x 标签的那条');
  assert.equal(c.cl_5, 1);
});

test('getUnreadCounts：无 reqId 标签的消息不计入任何需求（但仍在整条线里）', () => {
  appendTo('cl_6', { dir: 'in', text: '无归属' });
  assert.equal(getUnreadCounts('r_x').cl_6, undefined);
  assert.equal(getColleagueThread('cl_6').messages.length, 1);
});

test('markColleagueRead(colleagueId)：不带 reqId 时标记该人全部未读', () => {
  appendTo('cl_7', { dir: 'in', text: 'a', reqId: 'r_a' });
  appendTo('cl_7', { dir: 'in', text: 'b', reqId: 'r_b' });
  markColleagueRead('cl_7');
  assert.equal(getColleagueThread('cl_7').messages.every((m) => m.status === 'read'), true);
});

test('markColleagueRead(colleagueId, {reqId})：只标该需求下的，别的需求红点要留着', () => {
  appendTo('cl_8', { dir: 'in', text: 'a', reqId: 'r_a' });
  appendTo('cl_8', { dir: 'in', text: 'b', reqId: 'r_b' });
  markColleagueRead('cl_8', { reqId: 'r_a' });
  const t = getColleagueThread('cl_8');
  assert.equal(t.messages.find((m) => m.reqId === 'r_a').status, 'read');
  assert.equal(t.messages.find((m) => m.reqId === 'r_b').status, 'unread');
});

test('agentSessionId：读写往返，初始为 null', () => {
  assert.equal(getAgentSessionId('cl_9'), null);
  appendTo('cl_9', { dir: 'in', text: 'x' });
  setAgentSessionId('cl_9', 'sess_abc');
  assert.equal(getAgentSessionId('cl_9'), 'sess_abc');
});

test('setAgentSessionId：对没有任何消息的人也能写（agent 可能先起会话后落消息）', () => {
  setAgentSessionId('cl_10', 'sess_x');
  assert.equal(getAgentSessionId('cl_10'), 'sess_x');
});

test('toolTrace：出站消息可带工具轨迹，读回来形状不变', () => {
  appendTo('cl_11', { dir: 'out', text: '查过了', toolTrace: [{ name: 'get_requirement', input: { reqId: 'r_a' } }] });
  const m = getColleagueThread('cl_11').messages[0];
  assert.equal(m.toolTrace.length, 1);
  assert.equal(m.toolTrace[0].name, 'get_requirement');
});

test('toolTrace：入站消息没有轨迹，归一成 null 而非空数组（空数组会让前端误渲染出一个空轨迹区）', () => {
  appendTo('cl_12', { dir: 'in', text: 'x' });
  assert.equal(getColleagueThread('cl_12').messages[0].toolTrace, null);
});

test('dropReqThreads(reqId)：只摘掉该需求的消息，同一个人其它需求的对话必须留着', () => {
  appendTo('cl_13', { dir: 'in', text: 'a', reqId: 'r_del' });
  appendTo('cl_13', { dir: 'in', text: 'b', reqId: 'r_keep' });
  dropReqThreads('r_del');
  const t = getColleagueThread('cl_13');
  assert.equal(t.messages.length, 1);
  assert.equal(t.messages[0].reqId, 'r_keep');
});

test('_pending 全族已删除', async () => {
  const mod = await import('./colleague-messages.js');
  for (const name of ['addPending', 'getPending', 'flushPending', 'dropPending', 'applyPendingFlush']) {
    assert.equal(mod[name], undefined, `${name} 应随选择卡一起下线`);
  }
});

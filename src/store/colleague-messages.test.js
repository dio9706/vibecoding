import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录：store/index.js 按 APP_DATA_DIR 定位，须在 import store 之前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsg-store-'));
const {
  normalizeEntry,
  appendMessage,
  getThread,
  getUnreadCounts,
  markRead,
  markHandled,
  addPending,
  getPending,
  flushPending,
  dropPending,
  applyPendingFlush,
  dropReqThreads,
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

test('appendMessage → getThread 回读；in 更新 lastInboundAt，out 不更新', () => {
  appendMessage('r_1', 'cl_a', { dir: 'in', text: '第一条', role: 'backend' });
  const t1 = getThread('r_1', 'cl_a');
  assert.equal(t1.messages.length, 1);
  assert.equal(t1.messages[0].text, '第一条');
  assert.equal(t1.messages[0].role, 'backend');
  assert.ok(t1.lastInboundAt);

  const before = getThread('r_1', 'cl_a').lastInboundAt;
  appendMessage('r_1', 'cl_a', { dir: 'out', text: '我的回复', status: 'read' });
  const t2 = getThread('r_1', 'cl_a');
  assert.equal(t2.messages.length, 2);
  assert.equal(t2.lastInboundAt, before, 'out 方向不该刷新「最近来信时间」');
});

test('getThread：未知需求/未知同事返回空骨架而非 undefined', () => {
  const t = getThread('r_none', 'cl_none');
  assert.deepEqual(t.messages, []);
  assert.equal(t.lastInboundAt, null);
});

test('getUnreadCounts：只数 in+unread；out 与已读不计', () => {
  appendMessage('r_2', 'cl_x', { dir: 'in', text: 'a' });
  appendMessage('r_2', 'cl_x', { dir: 'in', text: 'b' });
  appendMessage('r_2', 'cl_x', { dir: 'out', text: 'c' });
  appendMessage('r_2', 'cl_y', { dir: 'in', text: 'd' });
  assert.deepEqual(getUnreadCounts('r_2'), { cl_x: 2, cl_y: 1 });
  assert.deepEqual(getUnreadCounts('r_none'), {});
});

test('markRead：只清该会话的 in+unread，其它会话不受影响', () => {
  markRead('r_2', 'cl_x');
  assert.deepEqual(getUnreadCounts('r_2'), { cl_y: 1 });
  assert.ok(getThread('r_2', 'cl_x').messages.every((m) => m.dir === 'out' || m.status === 'read'));
});

test('markRead：未知会话不炸、不写盘', () => {
  assert.doesNotThrow(() => markRead('r_none', 'cl_none'));
});

test('addPending / getPending：同一人多条累积在一个缓冲里', () => {
  addPending('ou_1', { dir: 'in', text: '第一条待归属' });
  addPending('ou_1', { dir: 'in', text: '第二条待归属' });
  const p = getPending('ou_1');
  assert.equal(p.messages.length, 2, '累积而非覆盖——否则同事连发两条只有最后一条被归入');
  assert.ok(p.askedAt);
  assert.equal(getPending('ou_none'), null);
});

test('flushPending：缓冲整体归入目标需求并清空', () => {
  const { count: n } = flushPending('ou_1', 'r_3', 'cl_z');
  assert.equal(n, 2);
  assert.equal(getThread('r_3', 'cl_z').messages.length, 2);
  assert.equal(getThread('r_3', 'cl_z').messages[0].text, '第一条待归属');
  assert.equal(getPending('ou_1'), null, '归入后必须清空，否则同事再点一次按钮会重复归入');
});

test('flushPending：空缓冲返回 0，不写盘', () => {
  assert.deepEqual(flushPending('ou_none', 'r_3', 'cl_z'), { count: 0, ids: [] });
});

test('_pending 不污染需求命名空间（getUnreadCounts 不把它当成需求）', () => {
  addPending('ou_2', { dir: 'in', text: 'x' });
  assert.deepEqual(getUnreadCounts('_pending'), {}, '缓冲节必须与 reqId 隔离');
});

test('applyPendingFlush：归入锁内快照里的全部 pending，不是调用方预读的那批', () => {
  // 竞态复现：flushPending 曾在锁**外** getPending 拿快照（2 条），却在锁内 delete 掉全部。
  // 若飞书进程在这个窗口里 addPending 了第 3 条，那条会被删且从未归入任何需求 —— 永久丢失。
  // 这里直接把「锁内 raw 比预读快照多一条」编码成入参：按快照算就会漏掉第 3 条。
  const raw = {
    _pending: {
      ou_race: {
        messages: [
          { id: 'cm_r1', dir: 'in', text: '预读时就有的第一条' },
          { id: 'cm_r2', dir: 'in', text: '预读时就有的第二条' },
          { id: 'cm_r3', dir: 'in', text: '竞态窗口里进来的第三条' },
        ],
        askedAt: '2026-09-16T00:00:00.000Z',
      },
    },
  };
  const { next, count } = applyPendingFlush(raw, 'ou_race', 'r_race', 'cl_race');
  assert.equal(count, 3, '锁内有几条就归入几条');
  const msgs = next.r_race.cl_race.messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[2].text, '竞态窗口里进来的第三条', '窗口内新增的那条不能被吞掉');
  assert.ok(!next._pending.ou_race, '归入后必须清空缓冲，否则再点一次按钮会重复归入');
});

test('applyPendingFlush：空缓冲返回 count=0 且 next=undefined（放弃写盘）', () => {
  const { next, count } = applyPendingFlush({}, 'ou_empty', 'r_x', 'cl_x');
  assert.equal(count, 0);
  assert.equal(next, undefined, 'updateJson 靠 undefined 表示无变更，不能白写一次盘');
});

test('dropPending：丢弃缓冲，hasPending 不再为真（防同事被永久粘住）', () => {
  addPending('ou_drop', { dir: 'in', text: 'x' });
  assert.ok(getPending('ou_drop'));
  dropPending('ou_drop');
  assert.equal(getPending('ou_drop'), null);
  assert.doesNotThrow(() => dropPending('ou_never'));
});

test('dropReqThreads：整条需求的同事会话被清空，别的需求与 _pending 不受影响', () => {
  appendMessage('r_drop', 'cl_a', { dir: 'in', text: '甲' });
  appendMessage('r_drop', 'cl_b', { dir: 'in', text: '乙' });
  appendMessage('r_keep', 'cl_a', { dir: 'in', text: '留着' });
  addPending('ou_keep', { dir: 'in', text: '缓冲' });

  dropReqThreads('r_drop');

  assert.deepEqual(getThread('r_drop', 'cl_a').messages, []);
  assert.deepEqual(getThread('r_drop', 'cl_b').messages, []);
  assert.equal(getThread('r_keep', 'cl_a').messages.length, 1, '别的需求不能被连坐');
  assert.ok(getPending('ou_keep'), '_pending 是另一命名空间，不该被波及');
  assert.doesNotThrow(() => dropReqThreads('r_never'), '不存在的需求应静默返回');
});

// ---- 四期：AI 自动处理落点 ----

test('markHandled：只改目标条目的 handledBy/handledNote，不动 status，其余条目不变', () => {
  const a = appendMessage('r_h', 'cl_h', { dir: 'in', text: '接口文档', role: 'backend' });
  const b = appendMessage('r_h', 'cl_h', { dir: 'in', text: '另一条', role: 'backend' });
  assert.equal(markHandled('r_h', 'cl_h', a.id, { handledBy: 'ai', handledNote: '已处理 · 接入接口文档' }), true);
  const msgs = getThread('r_h', 'cl_h').messages;
  const ma = msgs.find((m) => m.id === a.id);
  const mb = msgs.find((m) => m.id === b.id);
  assert.equal(ma.handledBy, 'ai');
  assert.equal(ma.handledNote, '已处理 · 接入接口文档');
  assert.equal(ma.status, 'unread', 'status 是「主机看没看过」，AI 处理过主机仍该看到红点');
  assert.equal(mb.handledBy, null, '其余条目不受影响');
});

test('markHandled：未知 id / 未知会话返回 false，不写盘', () => {
  assert.equal(markHandled('r_h', 'cl_h', 'cm_nope', { handledBy: 'ai' }), false);
  assert.equal(markHandled('r_none', 'cl_none', 'cm_x', { handledBy: 'ai' }), false);
  assert.equal(markHandled('_pending', 'cl_h', 'cm_x', { handledBy: 'ai' }), false, '缓冲节不是会话');
});

test('markHandled：handledBy 非法 / 缺省 → 返回 false 且条目不变（不能把已处理改回未处理还报成功）', () => {
  const a = appendMessage('r_h2', 'cl_h2', { dir: 'in', text: 'x' });
  markHandled('r_h2', 'cl_h2', a.id, { handledBy: 'manual', handledNote: '人工' });
  assert.equal(markHandled('r_h2', 'cl_h2', a.id, { handledBy: 'robot' }), false);
  assert.equal(markHandled('r_h2', 'cl_h2', a.id), false, '缺省 options 也拒绝');
  const m = getThread('r_h2', 'cl_h2').messages[0];
  assert.equal(m.handledBy, 'manual');
  assert.equal(m.handledNote, '人工');
});

test('markHandled：handledNote 省略时归空串', () => {
  const a = appendMessage('r_h3', 'cl_h3', { dir: 'in', text: 'x' });
  assert.equal(markHandled('r_h3', 'cl_h3', a.id, { handledBy: 'ai' }), true);
  assert.equal(getThread('r_h3', 'cl_h3').messages[0].handledNote, '');
});

test('markHandled：同一条二次标记是覆盖而非拒绝（失败重试时要能改写 note）', () => {
  const a = appendMessage('r_h4', 'cl_h4', { dir: 'in', text: 'x' });
  markHandled('r_h4', 'cl_h4', a.id, { handledBy: 'ai', handledNote: '处理失败 · T' });
  assert.equal(markHandled('r_h4', 'cl_h4', a.id, { handledBy: 'ai', handledNote: '已处理 · T' }), true);
  assert.equal(getThread('r_h4', 'cl_h4').messages[0].handledNote, '已处理 · T');
});

test('flushPending：返回 {count, ids}，ids 与归入条目一一对应', () => {
  addPending('ou_ids', { id: 'cm_i1', dir: 'in', text: '一' });
  addPending('ou_ids', { id: 'cm_i2', dir: 'in', text: '二' });
  const r = flushPending('ou_ids', 'r_ids', 'cl_ids');
  assert.equal(r.count, 2);
  assert.deepEqual(r.ids, ['cm_i1', 'cm_i2']);
  assert.deepEqual(getThread('r_ids', 'cl_ids').messages.map((m) => m.id), ['cm_i1', 'cm_i2']);
});

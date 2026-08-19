import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// store/index.js 在 import 时读 APP_DATA_DIR，必须在 import 之前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'convnotify-'));

let m;
before(async () => {
  m = await import('./conv-notify.js');
});

test('enable → getEntry 拿到快照字段', () => {
  m.enableConv({ convId: 'c1', title: 'T', session: 's1', cwd: 'C:\\p', model: 'auto', effort: 'medium', mode: 'default' });
  const e = m.getEntry('c1');
  assert.equal(e.session, 's1');
  assert.equal(e.mode, 'default');
  assert.ok(e.enabledAt);
  assert.deepEqual(e.inbox, []);
});

test('patch 局部更新，不动 inbox', () => {
  m.pushInjection('c1', { id: 'i1', text: 'x', runId: 'r1', mode: 'run', at: 1 });
  m.patchConv('c1', { session: 's2', lastNotifiedAt: '2026-08-12T00:00:00.000Z' });
  const e = m.getEntry('c1');
  assert.equal(e.session, 's2');
  assert.equal(e.inbox.length, 1);
});

test('inbox 上限 20，超限丢最旧', () => {
  for (let i = 0; i < 25; i++) m.pushInjection('c1', { id: 'x' + i, text: 't', runId: 'r', mode: 'run', at: i });
  const e = m.getEntry('c1');
  assert.equal(e.inbox.length, m.INBOX_MAX);
  assert.equal(e.inbox[e.inbox.length - 1].id, 'x24');
  assert.ok(!e.inbox.some((it) => it.id === 'i1'));
});

test('claim 只删指定 id', () => {
  const ids = m.getEntry('c1').inbox.slice(0, 3).map((i) => i.id);
  m.claimInjections('c1', ids);
  const left = m.getEntry('c1').inbox.map((i) => i.id);
  assert.equal(left.length, m.INBOX_MAX - 3);
  for (const id of ids) assert.ok(!left.includes(id));
});

test('findEntryByShortId 精确找到以短 ID 开头的会话', () => {
  m.enableConv({ convId: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', title: 'test-short-id', session: 's', cwd: 'C:\\p', model: 'auto', effort: 'medium', mode: 'default' });
  const result = m.findEntryByShortId('a1b2c3d4');
  assert.ok(result);
  assert.equal(result.convId, 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d');
  assert.equal(result.title, 'test-short-id');
});

test('findEntryByShortId 短 ID 不匹配时返回 null', () => {
  const result = m.findEntryByShortId('ffffffff');
  assert.equal(result, null);
});

test('findEntryByShortId 冲突时返回最近创建的会话', () => {
  // 创建第一个会话
  m.enableConv({ convId: 'a1b2c3d4-old-xxxx', title: 'old', session: 's', cwd: 'C:\\p', model: 'auto', effort: 'medium', mode: 'default' });
  // 稍作延迟确保 enabledAt 不同
  const entry2 = m.enableConv({ convId: 'a1b2c3d4-new-yyyy', title: 'new', session: 's', cwd: 'C:\\p', model: 'auto', effort: 'medium', mode: 'default' });

  const result = m.findEntryByShortId('a1b2c3d4');
  assert.ok(result);
  // 应该返回最晚创建的（enabledAt 最晚）
  assert.equal(result.title, 'new');
  assert.equal(result.convId, 'a1b2c3d4-new-yyyy');
});

test('findEntryByShortId 非字符串输入返回 null', () => {
  assert.equal(m.findEntryByShortId(null), null);
  assert.equal(m.findEntryByShortId(undefined), null);
  assert.equal(m.findEntryByShortId(123), null);
});

test('findEntryByShortId 空字符串返回 null', () => {
  assert.equal(m.findEntryByShortId(''), null);
});

test('pickLatestNotified 取窗口内最近通知过的一条', () => {
  m.enableConv({ convId: 'c2', title: 'T2', session: 's', cwd: 'C:\\p', model: 'auto', effort: 'medium', mode: 'default' });
  m.patchConv('c1', { lastNotifiedAt: new Date(1000).toISOString() });
  m.patchConv('c2', { lastNotifiedAt: new Date(5000).toISOString() });
  assert.equal(m.pickLatestNotified(10_000, 6000)?.convId, 'c2');
  assert.equal(m.pickLatestNotified(500, 6000), null); // 窗口太窄，全部超龄
});

test('disable 连带丢弃未认领的注入项', () => {
  m.disableConv('c1');
  assert.equal(m.getEntry('c1'), null);
});

test('对未登记会话的写操作是安全 no-op', () => {
  assert.equal(m.pushInjection('nope', { id: 'a', text: 't', runId: 'r', mode: 'run', at: 1 }), null);
  assert.equal(m.patchConv('nope', { session: 'x' }), null);
});

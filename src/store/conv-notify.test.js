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

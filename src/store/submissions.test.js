/**
 * 提交幂等认领表单测：去重、绑定回放、死认领复占、TTL、非法 key。
 * 隔离：APP_DATA_DIR 指向临时目录后再动态 import（store/index.js 在模块求值时定死数据目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'submissions-'));
const { claimSubmission, bindSubmission, peekSubmission, isValidSubmissionKey, listSubmissions, RECLAIM_MS } =
  await import('./submissions.js');

const T0 = 1_700_000_000_000;

test('claim：首次受理；未 bind 的重复命中（复占窗口内）不再受理', () => {
  const k = 'start:rq_1';
  const a = claimSubmission(k, { now: T0 });
  assert.equal(a.duplicate, false);
  assert.equal(a.entry.ref, null);

  const b = claimSubmission(k, { now: T0 + 1000 });
  assert.equal(b.duplicate, true);
  assert.equal(b.entry.at, T0, '命中既有认领不应刷新时间戳');

  const c = claimSubmission(k, { now: T0 + RECLAIM_MS - 1 });
  assert.equal(c.duplicate, true, '窗口内一律按重复拒绝（原处理可能仍在途）');
});

test('claim + bind：重复命中返回既有 ref（runId/msgId 回放）', () => {
  const k = 'start:rq_2';
  claimSubmission(k, { now: T0 });
  assert.equal(bindSubmission(k, 'run_x', { now: T0 + 10 }), true);
  const hit = claimSubmission(k, { now: T0 + 20 });
  assert.equal(hit.duplicate, true);
  assert.equal(hit.entry.ref, 'run_x');
});

test('bind：重复绑同值幂等成功；绑异值不覆盖', () => {
  const k = 'steer:rq_3';
  claimSubmission(k, { now: T0 });
  assert.equal(bindSubmission(k, 'hm_1', { now: T0 + 1 }), true);
  assert.equal(bindSubmission(k, 'hm_1', { now: T0 + 2 }), true, '同值重绑应幂等');
  assert.equal(bindSubmission(k, 'hm_other', { now: T0 + 3 }), false, '异值不得覆盖既有绑定');
  assert.equal(claimSubmission(k, { now: T0 + 4 }).entry.ref, 'hm_1');
});

test('死认领复占：未 bind 超过 RECLAIM_MS 后可重新受理', () => {
  const k = 'start:rq_4';
  claimSubmission(k, { now: T0 });
  const stale = claimSubmission(k, { now: T0 + RECLAIM_MS });
  assert.equal(stale.duplicate, false, '超过复占阈值视为死认领，允许重来');
  assert.equal(stale.entry.at, T0 + RECLAIM_MS);
  assert.equal(claimSubmission(k, { now: T0 + RECLAIM_MS + 10 }).duplicate, true, '复占后又是一条新认领');
});

test('TTL 过期：过期认领视为不存在；未认领的 bind 不补写', () => {
  const k = 'start:rq_5';
  claimSubmission(k, { ttlMs: 1000, now: T0 });
  const late = claimSubmission(k, { ttlMs: 1000, now: T0 + 1001 });
  assert.equal(late.duplicate, false, '过期后是全新受理');
  assert.equal(bindSubmission(k, 'run_late', { now: T0 + 1002 }), true);
  assert.equal(bindSubmission('start:never_claimed', 'run_y', { now: T0 }), false, '没有认领就不该凭空绑定');
});

test('非法 key：退化为不幂等，不报错', () => {
  assert.equal(isValidSubmissionKey('start:ok'), true);
  assert.equal(isValidSubmissionKey(''), false);
  assert.equal(isValidSubmissionKey(null), false);
  assert.equal(isValidSubmissionKey('a'.repeat(257)), false);
  assert.equal(isValidSubmissionKey('bad\u0000key'), false);
  assert.deepEqual(claimSubmission('', { now: T0 }), { duplicate: false, entry: null });
  assert.deepEqual(claimSubmission(null, { now: T0 }), { duplicate: false, entry: null });
  assert.equal(bindSubmission('', 'x', { now: T0 }), false);
  assert.equal(bindSubmission('start:rq_6', '', { now: T0 }), false);
});

test('落盘：认领写入 submissions.json（跨进程可见的持久去重）', () => {
  const k = 'feishu:msg:om_test_persist';
  claimSubmission(k, { now: T0 });
  const all = listSubmissions();
  assert.ok(all[k]);
  assert.equal(all[k].ref, null);
  assert.equal(all[k].exp, T0 + 24 * 60 * 60 * 1000);
});

test('peek：只读查看（不创建、不写盘），过期/非法 key 视同不存在', () => {
  // 不存在 → null，且不得因此创建任何认领
  const before = Object.keys(listSubmissions()).length;
  assert.equal(peekSubmission('start:rq_peek_missing', { now: T0 }), null);
  assert.equal(Object.keys(listSubmissions()).length, before, 'peek 不得写盘');

  const k = 'start:rq_peek';
  claimSubmission(k, { ttlMs: 1000, now: T0 });
  bindSubmission(k, 'run_peek', { now: T0 + 1 });
  assert.equal(peekSubmission(k, { now: T0 + 500 }).ref, 'run_peek');
  assert.equal(peekSubmission(k, { now: T0 + 1001 }), null, '过期条目视同不存在（与 claim 的 TTL 语义一致）');
  assert.equal(peekSubmission('', { now: T0 }), null);
  assert.equal(peekSubmission(null, { now: T0 }), null);
});

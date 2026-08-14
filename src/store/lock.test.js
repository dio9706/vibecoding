import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, releaseLock, isLockOwned, LOCK_STALE_MS, LOCK_MAX_WAIT_MS } from './lock.js';

/**
 * 背景（store/index.js 的旧锁实现）：
 *  1. LOCK_STALE_MS = 2000 且**持锁期间不续期 mtime**。持锁进程被挂起（Windows 睡眠/休眠恢复、
 *     长 GC 停顿、APP_DATA_DIR 在慢盘或网络盘）超过 2s，另一进程就会 unlink 直接接管
 *     → 两个写者同时进临界区 → 丢更新。
 *  2. releaseLock **无条件 unlink**：锁被接管后，先者释放时会删掉**后者**的锁，形成级联抢占。
 *  3. acquireLock 是无退出条件的 `for(;;)`，没有最大等待——一旦锁文件因权限问题删不掉，
 *     整个进程在同步自旋里永久卡死（Atomics.wait 连事件循环都不让出）。
 */

let dir;
const lockPath = () => path.join(dir, 'probe.json.lock');

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-lock-'));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
});

test('acquireLock：拿到锁后锁文件存在，并写入了归属标识', () => {
  const lock = lockPath();
  const token = acquireLock(lock);
  assert.ok(token, '应返回归属令牌');
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.readFileSync(lock, 'utf8').includes(token), true, '锁文件应记录持有者');
  releaseLock(lock, token);
});

test('releaseLock：正常释放后锁文件消失', () => {
  const lock = lockPath();
  const t = acquireLock(lock);
  releaseLock(lock, t);
  assert.equal(fs.existsSync(lock), false);
});

test('isLockOwned：持有期间为真；被他人接管后为假（核心：让持有者能自查是否已被抢）', () => {
  const lock = lockPath();
  const mine = acquireLock(lock);
  assert.equal(isLockOwned(lock, mine), true);
  // 模拟另一进程接管：覆盖为别人的令牌
  fs.writeFileSync(lock, 'someone-else');
  assert.equal(isLockOwned(lock, mine), false);
});

test('releaseLock：锁已被他人接管时**不得删除**（否则级联抢占）', () => {
  const lock = lockPath();
  const mine = acquireLock(lock);
  fs.writeFileSync(lock, 'someone-else'); // 他人接管
  releaseLock(lock, mine);
  assert.equal(fs.existsSync(lock), true, '删掉了别人的锁 —— 会引发级联抢占');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'someone-else');
});

test('acquireLock：陈旧锁（超过 staleMs 且 mtime 不再推进）可被接管', () => {
  const lock = lockPath();
  fs.writeFileSync(lock, 'dead-process');
  const old = Date.now() - (LOCK_STALE_MS + 5000);
  fs.utimesSync(lock, new Date(old), new Date(old));
  const t = acquireLock(lock);
  assert.ok(t);
  assert.equal(isLockOwned(lock, t), true);
  releaseLock(lock, t);
});

test('acquireLock：新鲜锁不被抢，等待超过上限时抛错而不是死循环（核心回归）', () => {
  const lock = lockPath();
  const other = acquireLock(lock); // 别人正持有且很新鲜
  const t0 = Date.now();
  assert.throws(() => acquireLock(lock, { maxWaitMs: 300 }), /锁|lock/i);
  const ms = Date.now() - t0;
  assert.ok(ms >= 250 && ms < 4000, `应在上限附近返回，实际 ${ms}ms`);
  assert.equal(isLockOwned(lock, other), true, '等待失败不应破坏他人的锁');
  releaseLock(lock, other);
});

test('LOCK_STALE_MS：必须显著大于旧的 2s —— 那个阈值在进程被挂起时太容易误判', () => {
  assert.ok(LOCK_STALE_MS > 2000, `当前 ${LOCK_STALE_MS}ms，仍然过短`);
  assert.ok(Number.isFinite(LOCK_MAX_WAIT_MS) && LOCK_MAX_WAIT_MS > 0, '必须有有限的最大等待');
});

test('acquireLock：令牌互不相同（同进程连续获取也要能区分）', () => {
  const lock = lockPath();
  const a = acquireLock(lock);
  releaseLock(lock, a);
  const b = acquireLock(lock);
  releaseLock(lock, b);
  assert.notEqual(a, b);
});

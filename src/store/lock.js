/**
 * 跨进程文件锁 —— PM2 的 claude-web 与 claude-feishu（以及 Tauri 桌面版）共享同一批 JSON，
 * 所有「读出来改一改再写回」都必须在这把锁内完成。
 *
 * 旧实现的三个缺陷：
 *  1. 陈旧阈值 2s 且**持锁期间不续期 mtime**。持锁进程被挂起（Windows 睡眠/休眠恢复、
 *     长 GC 停顿、数据目录在慢盘/网络盘）超过 2s，另一进程就 unlink 直接接管
 *     → 两个写者同时进临界区 → 丢更新。
 *  2. releaseLock **无条件 unlink**：锁被接管后，先者释放时会删掉后者的锁，形成级联抢占。
 *  3. acquireLock 是无退出条件的 `for(;;)`，且 sleep 用 Atomics.wait（同步阻塞、连事件循环
 *     都不让出）。锁文件因权限问题删不掉时，整个进程永久卡死且毫无征兆。
 *
 * 现在的做法：锁文件里写入**归属令牌**，持有者可自查是否已被抢（isLockOwned），
 * 释放时只删自己的锁；等待有上限，超时抛错而不是无声卡死。
 */
import fs from 'node:fs';

/** 陈旧阈值。取 30s：远大于任何正常的同步读-改-写（<10ms），又能在进程真崩溃后及时接管。 */
export const LOCK_STALE_MS = 30_000;
/** 最大等待。超过即抛错——宁可这次操作失败，也不要整个进程无声卡死。 */
export const LOCK_MAX_WAIT_MS = 10_000;

let _seq = 0;
function newToken() {
  _seq += 1;
  return `${process.pid}-${_seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 同步睡眠（仅锁自旋用） */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 获取锁，返回归属令牌。超过 maxWaitMs 仍拿不到则抛错。
 * @returns {string} token —— 释放与自查都要用它
 */
export function acquireLock(lock, { staleMs = LOCK_STALE_MS, maxWaitMs = LOCK_MAX_WAIT_MS } = {}) {
  const token = newToken();
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      // 'wx' = 独占创建：文件已存在即失败，这就是拿锁的原子性来源
      const fd = fs.openSync(lock, 'wx');
      try {
        fs.writeSync(fd, token); // 写入归属，供 isLockOwned / releaseLock 校验
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch {
      // 没抢到：看看是不是崩溃残留的陈旧锁
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          fs.unlinkSync(lock);
          continue; // 立刻重试抢占
        }
      } catch {
        continue; // 对方刚释放（stat 不到）→ 立即重试
      }
      if (Date.now() > deadline) {
        throw new Error(`获取文件锁超时（${maxWaitMs}ms）：${lock}。可能有进程长时间持锁或锁文件无法删除`);
      }
      sleepMs(5);
    }
  }
}

/** 锁是否仍归 token 所有。持有者在写盘前应据此确认自己没被抢。 */
export function isLockOwned(lock, token) {
  try {
    return fs.readFileSync(lock, 'utf8') === token;
  } catch {
    return false; // 锁文件已不存在 = 不再持有
  }
}

/** 释放锁。**只删自己的**——锁已被他人接管时必须留手，否则形成级联抢占。 */
export function releaseLock(lock, token) {
  try {
    if (!isLockOwned(lock, token)) return;
    fs.unlinkSync(lock);
  } catch {
    /* 竞态下已被删除等，忽略 */
  }
}

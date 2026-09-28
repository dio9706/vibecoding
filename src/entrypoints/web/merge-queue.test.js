import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMergeQueue } from './merge-queue.js';

const tick = () => new Promise((r) => setImmediate(r));

test('同一 repo 串行：第二个必须等第一个跑完才开始', async () => {
  const order = [];
  let release1;
  const q = createMergeQueue({
    isClean: async () => true,
    mergeBranch: async (repo, src) => {
      order.push('start:' + src);
      if (src === 'a') await new Promise((r) => (release1 = r));
      order.push('end:' + src);
      return { ok: true, mergeCommit: 'sha_' + src };
    },
  });
  const p1 = q.enqueue({ repo: 'D:/p', branch: 'a', baseBranch: 'main' });
  const p2 = q.enqueue({ repo: 'D:/p', branch: 'b', baseBranch: 'main' });
  await tick();
  assert.deepEqual(order, ['start:a'], 'b 不得在 a 跑完前开始');
  release1();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('不同 repo 并行：互不阻塞', async () => {
  const running = new Set();
  let maxConcurrent = 0;
  const q = createMergeQueue({
    isClean: async () => true,
    mergeBranch: async (repo) => {
      running.add(repo);
      maxConcurrent = Math.max(maxConcurrent, running.size);
      await tick();
      running.delete(repo);
      return { ok: true, mergeCommit: 'x' };
    },
  });
  await Promise.all([
    q.enqueue({ repo: 'D:/a', branch: 'x', baseBranch: 'main' }),
    q.enqueue({ repo: 'D:/b', branch: 'y', baseBranch: 'main' }),
  ]);
  assert.equal(maxConcurrent, 2, '不同 repo 应能并行');
});

// —— 这道闸防的是「主机自己没提交的改动被 add -A 卷进 agent 的合并」，
// 是 commitAll 在主工作区的已知大坑（auto-dev/revert.js:114 同款）。
test('主工作区脏 → 不合并，降级为待合并（不算失败）', async () => {
  let merged = false;
  const q = createMergeQueue({
    isClean: async () => false,
    mergeBranch: async () => { merged = true; return { ok: true, mergeCommit: 'x' }; },
  });
  const r = await q.enqueue({ repo: 'D:/p', branch: 'a', baseBranch: 'main' });
  assert.equal(merged, false, '脏工作区绝不能合并');
  assert.equal(r.ok, true, '降级不是失败');
  assert.equal(r.status, 'pending-merge');
  assert.equal(r.sha, null);
});

test('合并成功 → 返回 sha（撤销台账的锚点），读的是 mergeCommit 字段', async () => {
  const q = createMergeQueue({ isClean: async () => true, mergeBranch: async () => ({ ok: true, mergeCommit: 'abc123' }) });
  const r = await q.enqueue({ repo: 'D:/p', branch: 'a', baseBranch: 'main' });
  assert.equal(r.status, 'merged');
  assert.equal(r.sha, 'abc123');
});

// —— git.js 的 JSDoc 明写「mergeCommit 取不到时为空串而非缺失」。
// 空串必须归一成 null：撤销分派靠 null 判「还没合并，该删分支而不是 revert」。
test('mergeCommit 为空串 → sha 归一成 null，不是空串', async () => {
  const q = createMergeQueue({ isClean: async () => true, mergeBranch: async () => ({ ok: true, mergeCommit: '' }) });
  const r = await q.enqueue({ repo: 'D:/p', branch: 'a', baseBranch: 'main' });
  assert.equal(r.status, 'merged');
  assert.equal(r.sha, null);
});

test('合并失败 → status=failed 且带原因，不抛', async () => {
  const q = createMergeQueue({
    isClean: async () => true,
    mergeBranch: async () => ({ ok: false, error: '冲突' }),
  });
  const r = await q.enqueue({ repo: 'D:/p', branch: 'a', baseBranch: 'main' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /冲突/);
});

test('单个任务抛错不卡死队列，后续任务仍能跑', async () => {
  let second = false;
  const q = createMergeQueue({
    isClean: async () => true,
    mergeBranch: async (repo, src) => {
      if (src === 'a') throw new Error('炸了');
      second = true;
      return { ok: true, mergeCommit: 'x' };
    },
  });
  const r1 = await q.enqueue({ repo: 'D:/p', branch: 'a', baseBranch: 'main' });
  const r2 = await q.enqueue({ repo: 'D:/p', branch: 'b', baseBranch: 'main' });
  assert.equal(r1.ok, false);
  assert.equal(second, true, '前一个抛错不得让队列停摆');
  assert.equal(r2.ok, true);
});

test('isClean 自身抛错 → 按失败处理，不当成干净就合并', async () => {
  let merged = false;
  const q = createMergeQueue({
    isClean: async () => { throw new Error('git 不可用'); },
    mergeBranch: async () => { merged = true; return { ok: true, mergeCommit: 'x' }; },
  });
  const r = await q.enqueue({ repo: 'D:/p', branch: 'a', baseBranch: 'main' });
  assert.equal(merged, false, 'isClean 判不出时绝不能乐观合并');
  assert.equal(r.ok, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undoAgentAction } from './undo-agent-action.js';

const MERGED = { id: 'aa_1', undone: false, reqId: 'r_a1',
  undo: { kind: 'revert-merge', repo: 'D:/fe', branch: 'req/r_a1/agent-m1', baseBranch: 'feat/order', mergeSha: 'sha1' } };
const PENDING = { ...MERGED, id: 'aa_2', undo: { ...MERGED.undo, mergeSha: null } };
const APIDOC = { id: 'aa_3', undone: false, reqId: 'r_a1', undo: { kind: 'delete-apidoc', reqId: 'r_a1', name: 'order.md' } };

function deps(extra = {}) {
  return {
    getAction: (id) => ({ aa_1: MERGED, aa_2: PENDING, aa_3: APIDOC })[id] || null,
    markUndone: () => true,
    revertMergeCommit: async () => ({ ok: true }),
    deleteBranch: async () => ({ ok: true }),
    deleteApiDoc: () => ({ ok: true }),
    ...extra,
  };
}

test('撤销不存在的记录 → 明确错误', async () => {
  const r = await undoAgentAction('aa_nope', deps());
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

// —— 幂等：主机双击撤销按钮不能撤两次。两次 revert 会产生两个反向提交。
test('已撤销过的不重复撤', async () => {
  let called = false;
  const d = deps({
    getAction: () => ({ ...MERGED, undone: true }),
    revertMergeCommit: async () => { called = true; return { ok: true }; },
  });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, false);
  assert.equal(called, false, '撤过的绝不能再撤一次');
});

// —— external 档（退款脚本这类）已发生、撤不回。必须明说，不能假装成功。
test('undo=null → 明确说撤不回，不假装成功', async () => {
  const d = deps({ getAction: () => ({ id: 'aa_x', undone: false, undo: null }) });
  const r = await undoAgentAction('aa_x', d);
  assert.equal(r.ok, false);
  assert.match(r.error, /撤不回|不可撤销|无法撤销/);
});

test('revert-merge 且已合并 → 走 revertMergeCommit，参数正确', async () => {
  let seen = null;
  const d = deps({ revertMergeCommit: async (repo, opts) => { seen = { repo, opts }; return { ok: true }; } });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, true);
  assert.equal(seen.repo, 'D:/fe');
  assert.equal(seen.opts.mergeCommit, 'sha1');
  assert.equal(seen.opts.task.branch, 'req/r_a1/agent-m1');
  assert.equal(seen.opts.task.baseBranch, 'feat/order');
});

// —— 还没合并（待合并态）时没有 merge commit 可 revert，改动只在分支上，删掉即撤销。
//    对一个不存在的 mergeCommit 做 revert 会直接失败。
test('revert-merge 但 mergeSha 为 null → 走删分支而非 revert', async () => {
  let deleted = null;
  let reverted = false;
  const d = deps({
    deleteBranch: async (repo, br) => { deleted = { repo, br }; return { ok: true }; },
    revertMergeCommit: async () => { reverted = true; return { ok: true }; },
  });
  const r = await undoAgentAction('aa_2', d);
  assert.equal(r.ok, true);
  assert.equal(reverted, false, '没合并过就不该 revert');
  assert.deepEqual(deleted, { repo: 'D:/fe', br: 'req/r_a1/agent-m1' });
});

test('delete-apidoc → 调 deleteApiDoc，参数正确', async () => {
  let seen = null;
  const d = deps({ deleteApiDoc: (reqId, name) => { seen = { reqId, name }; return { ok: true }; } });
  const r = await undoAgentAction('aa_3', d);
  assert.equal(r.ok, true);
  assert.deepEqual(seen, { reqId: 'r_a1', name: 'order.md' });
});

// —— 这条是最重要的：撤销失败绝不能标记为已撤销。
//    标了之后主机再也点不了那个按钮，而改动其实还在分支上 —— 等于把问题永久藏起来。
test('撤销失败 → 不标记 undone', async () => {
  let marked = false;
  const d = deps({
    revertMergeCommit: async () => ({ ok: false, error: '冲突' }),
    markUndone: () => { marked = true; return true; },
  });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, false);
  assert.match(r.error, /冲突/);
  assert.equal(marked, false, '撤销没成功就标已撤销，等于永久藏起这个问题');
});

test('撤销执行抛错 → 按失败处理，不标记 undone，不冒泡', async () => {
  let marked = false;
  const d = deps({
    revertMergeCommit: async () => { throw new Error('git 炸了'); },
    markUndone: () => { marked = true; return true; },
  });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, false);
  assert.equal(marked, false);
});

test('撤销成功 → 标记 undone', async () => {
  let marked = false;
  const d = deps({ markUndone: () => { marked = true; return true; } });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, true);
  assert.equal(marked, true);
});

// —— P4 才会有工具产生这两种 kind。本期必须显式拒绝，
//    静默返回 ok 会让主机以为撤成功了，而什么都没发生。
test('P4 才有的 kind → 显式返回暂不支持，不静默成功', async () => {
  for (const kind of ['revert-req-change', 'discard-task']) {
    const d = deps({ getAction: () => ({ id: 'aa_x', undone: false, undo: { kind } }) });
    const r = await undoAgentAction('aa_x', d);
    assert.equal(r.ok, false, kind);
    assert.ok(r.error, kind);
  }
});

test('未知 kind → 拒绝，不静默成功', async () => {
  const d = deps({ getAction: () => ({ id: 'aa_x', undone: false, undo: { kind: '未来的某种撤销' } }) });
  const r = await undoAgentAction('aa_x', d);
  assert.equal(r.ok, false);
});

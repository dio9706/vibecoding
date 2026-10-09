/**
 * P5 启动对账 fs 级集成（run-claude.js#reconcileRuns）：
 *  - Claude 孤儿 → pending 排程（orphan_recovery，代次 +1，锚点原样带上）
 *  - 熔断（超限）→ abandoned 标记；无 session 锚点 → abandoned 标记
 *  - openai 孤儿 → 排程检查点续跑；settled 残留 → 摘除不续
 *  - 多实例守卫：他人进程条目原样保留
 *  - 升级迁移：active-runs.json 存量并入索引并清空（reconcileRuns 内自动触发）
 * 隔离：APP_DATA_DIR → 临时目录；全部动态 import（store 基座在模块求值时定死目录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'run-reconcile-'));
process.env.APP_DATA_DIR = DATA;

const { reconcileRuns, recoverPendingAndOrphans } = await import('./run-claude.js');
const { listRunIndex, upsertRun, clearRunIndex } = await import('../../store/run-index.js');
const { appendRunEvent, clearRunJournal, tailRunEvents } = await import('../../store/run-journal.js');
const { getPending, addPending, removePendingByConv } = await import('../../store/pending-resume.js');

/** 造一条「属主进程已死」的索引条目（缺 pid 的旧数据同样按孤儿处理，这里用死 pid 更贴近现实） */
const orphan = (entry) => ({
  resumeAttempt: 0,
  pid: 999999,
  startedAt: Date.now(),
  status: 'running',
  ...entry,
});

const pendingOf = (convId) => getPending().find((e) => e.convId === convId) || null;
const reset = (...convIds) => {
  clearRunIndex();
  clearRunJournal();
  for (const c of convIds) removePendingByConv(c);
};

test('Claude 孤儿 → 写 pending 排程（orphan_recovery，代次 +1，锚点原样带上），索引摘除', () => {
  reset('c_re_1');
  upsertRun(
    orphan({
      runId: 'run_re_1',
      convId: 'c_re_1',
      provider: 'claude-agent',
      session_id: 'sess_1',
      cwd: 'C:\\proj',
      model: 'sonnet',
      effort: 'medium',
      mode: 'acceptEdits',
    }),
  );
  const scheduled = [];
  reconcileRuns({ scheduleOpenAi: (entry, attempt) => scheduled.push([entry.runId, attempt]) });

  assert.deepEqual(scheduled, [], 'Claude 不走 openai 排程');
  assert.deepEqual(listRunIndex(), [], '孤儿条目已摘除');
  const e = pendingOf('c_re_1');
  assert.ok(e, '应写出 orphan_recovery 待续跑条目');
  assert.equal(e.status, 'waiting');
  assert.equal(e.reason, 'orphan_recovery');
  assert.equal(e.attempts, 1);
  assert.equal(e.session_id, 'sess_1');
  assert.equal(e.cwd, 'C:\\proj');
  assert.equal(e.model, 'sonnet');
  assert.equal(e.effort, 'medium');
  assert.equal(e.mode, 'acceptEdits');
});

test('熔断：Claude 孤儿 attempt=3 → abandoned 标记 + journal 记 abandoned，不再排程', () => {
  reset('c_re_fuse');
  upsertRun(
    orphan({ runId: 'run_re_fuse', convId: 'c_re_fuse', provider: 'claude-agent', session_id: 's', resumeAttempt: 3 }),
  );
  const scheduled = [];
  reconcileRuns({ scheduleOpenAi: (...a) => scheduled.push(a) });

  assert.deepEqual(scheduled, []);
  assert.deepEqual(listRunIndex(), []);
  const e = pendingOf('c_re_fuse');
  assert.equal(e.status, 'abandoned');
  assert.equal(e.attempts, 4);
  assert.match(e.reason, /超过上限 3/);
  const abandoned = tailRunEvents(50).filter((ev) => ev.type === 'abandoned');
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].convId, 'c_re_fuse');
  assert.equal(abandoned[0].data.attempts, 4);
});

test('Claude 无 session 锚点（有 convId）→ abandoned 提示，不再静默丢弃', () => {
  reset('c_re_nosess');
  upsertRun(orphan({ runId: 'run_re_nosess', convId: 'c_re_nosess', provider: 'claude-agent', session_id: null }));
  reconcileRuns({});
  const e = pendingOf('c_re_nosess');
  assert.equal(e.status, 'abandoned');
  assert.match(e.reason, /无 session 锚点/);
  assert.deepEqual(listRunIndex(), []);
});

test('openai 孤儿 → scheduleOpenAi 排程检查点续跑（代次 +1），不写 pending', () => {
  reset('c_re_openai');
  upsertRun(orphan({ runId: 'run_re_openai', convId: 'c_re_openai', provider: 'openai-compat', resumeAttempt: 1 }));
  const scheduled = [];
  reconcileRuns({ scheduleOpenAi: (entry, attempt) => scheduled.push([entry.runId, attempt]) });

  assert.deepEqual(scheduled, [['run_re_openai', 2]], '代次 = 原代次 + 1');
  assert.deepEqual(listRunIndex(), []);
  assert.equal(pendingOf('c_re_openai'), null, 'openai 不经过 pending 排程器');
});

test('settled 残留：journal 已有 settled → 摘除索引，不续跑不熔断（全 provider）', () => {
  reset('c_re_settled_a', 'c_re_settled_b');
  upsertRun(orphan({ runId: 'run_re_settled_a', convId: 'c_re_settled_a', provider: 'openai-compat' }));
  upsertRun(orphan({ runId: 'run_re_settled_b', convId: 'c_re_settled_b', provider: 'claude-agent', session_id: 's' }));
  appendRunEvent({
    v: 1,
    seq: 1,
    runId: 'run_re_settled_a',
    convId: 'c_re_settled_a',
    at: Date.now(),
    type: 'settled',
    data: { status: 'done' },
  });
  appendRunEvent({
    v: 1,
    seq: 1,
    runId: 'run_re_settled_b',
    convId: 'c_re_settled_b',
    at: Date.now(),
    type: 'settled',
    data: { status: 'done' },
  });
  const scheduled = [];
  reconcileRuns({ scheduleOpenAi: (...a) => scheduled.push(a) });

  assert.deepEqual(scheduled, []);
  assert.deepEqual(listRunIndex(), []);
  assert.equal(pendingOf('c_re_settled_a'), null);
  assert.equal(pendingOf('c_re_settled_b'), null);
});

test('多实例守卫：他人进程的活条目原样保留，不回收不排程', () => {
  reset('c_re_foreign');
  // 用「当前进程的父进程」模拟另一个存活实例：ppid 必然存活，startedAt 新于开机时间
  upsertRun({
    runId: 'run_re_foreign',
    convId: 'c_re_foreign',
    provider: 'claude-agent',
    session_id: 's_f',
    resumeAttempt: 0,
    pid: process.ppid,
    startedAt: Date.now(),
    status: 'running',
  });
  const scheduled = [];
  reconcileRuns({ scheduleOpenAi: (...a) => scheduled.push(a) });

  assert.ok(listRunIndex().some((e) => e.runId === 'run_re_foreign'), '他人条目不得摘除');
  assert.deepEqual(scheduled, []);
  assert.equal(pendingOf('c_re_foreign'), null);
});

test('升级迁移：active-runs.json 存量先并入索引再对账，旧表清空', () => {
  reset('c_mig');
  fs.writeFileSync(
    path.join(DATA, 'active-runs.json'),
    JSON.stringify([
      {
        runId: 'run_mig_1',
        convId: 'c_mig',
        provider: 'claude-agent',
        session_id: 's_mig',
        pid: 999999,
        startedAt: Date.now(),
        status: 'running',
        resumeAttempt: 0,
      },
    ]),
  );
  reconcileRuns({});

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'active-runs.json'), 'utf8')), [], '旧表已清空');
  const e = pendingOf('c_mig');
  assert.ok(e, '迁移进来的孤儿同样参与对账');
  assert.equal(e.reason, 'orphan_recovery');
  assert.equal(e.session_id, 's_mig');
});

test('recoverPendingAndOrphans：先对账、再重排 waiting 条目（abandoned / done 跳过）', () => {
  reset('c_resched_wait', 'c_resched_ab', 'c_resched_done');
  addPending({ convId: 'c_resched_wait', session_id: 's', resetsAt: 0 });
  addPending({ convId: 'c_resched_ab', session_id: 's', status: 'abandoned', resetsAt: 0 });
  addPending({ convId: 'c_resched_done', session_id: 's', status: 'done', resetsAt: 0 });

  const reconciled = [];
  const scheduled = [];
  recoverPendingAndOrphans({
    reconcile: () => reconciled.push(1),
    schedule: (e) => scheduled.push(e.convId),
  });

  assert.equal(reconciled.length, 1, '必须先跑对账（孤儿的 pending 条目要能被本轮重排）');
  assert.ok(scheduled.includes('c_resched_wait'), 'waiting 条目必须重排');
  assert.ok(!scheduled.includes('c_resched_ab'), 'abandoned 条目不重排');
  assert.ok(!scheduled.includes('c_resched_done'), 'done 条目不重排');
});

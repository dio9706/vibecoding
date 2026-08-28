/**
 * 异常自动重试决策单测。
 * 回归背景：重试带副作用（addPending + 定时 doResume），任一条件判错都会导致
 * 「用户点了停止，2 秒后任务自己活过来」或「无 session 锚点却登记了续跑」这类幽灵行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryEligible, runIdsToAbortOnDismiss, isResumePlanned } from './run-claude.logic.js';
import { shouldAbandonResume } from '../../store/pending-resume.js';

const base = { hasError: true, status: 'running', subtype: '', sid: 'sess-1', convId: 'conv-1' };

test('条件全满足 → 够格重试', () => {
  assert.equal(isRetryEligible(base), true);
});

test('没异常（正常收尾）→ 不够格', () => {
  assert.equal(isRetryEligible({ ...base, hasError: false }), false);
});

test('run 已被手动停止（stopRun 抢先终结）→ 不够格', () => {
  // stopRun 落的是 status='done' + subtype='stopped'，两个条件各自都要能挡住
  assert.equal(isRetryEligible({ ...base, status: 'done', subtype: 'stopped' }), false);
  assert.equal(isRetryEligible({ ...base, status: 'running', subtype: 'stopped' }), false);
  assert.equal(isRetryEligible({ ...base, status: 'done', subtype: '' }), false);
});

// 看门狗/超时走 abortRun → failRun，failRun 先把 status 改成 'error'，之后 SDK 的
// done reject 才到达 settleRun。只认 'running' 会把看门狗中断整类排除在重试之外。
test('看门狗已 failRun（status=error）→ 仍够格重试', () => {
  assert.equal(isRetryEligible({ ...base, status: 'error', subtype: 'exception' }), true);
});

test('额度阻塞（防御性）→ 不够格，那是额度分支的活', () => {
  assert.equal(isRetryEligible({ ...base, status: 'done', subtype: 'quota_blocked' }), false);
});

test('缺 session 锚点（判档窗口崩溃）→ 不够格，续接不了', () => {
  assert.equal(isRetryEligible({ ...base, sid: null }), false);
  assert.equal(isRetryEligible({ ...base, sid: '' }), false);
});

test('缺 convId → 不够格，前端无处接流', () => {
  assert.equal(isRetryEligible({ ...base, convId: null }), false);
});

// settleRun 的实际组合：够格 + 代次未超上限 → 重试；够格 + 超上限 → 熔断（落 abandoned）
test('组合判定：代次边界 3 重试、4 熔断（上限 3）', () => {
  assert.equal(isRetryEligible(base) && !shouldAbandonResume(3, 3), true);
  assert.equal(isRetryEligible(base) && !shouldAbandonResume(4, 3), false);
  assert.equal(isRetryEligible(base) && shouldAbandonResume(4, 3), true); // 走熔断分支
});

test('dismiss：只中止已起跑（resuming）且有 runId 的条目', () => {
  const out = runIdsToAbortOnDismiss([
    { status: 'resuming', runId: 'run_a' },
    { status: 'waiting', runId: null }, // 还没起跑，删条目就够了
    { status: 'resuming', runId: null }, // 异常数据，跳过
    { status: 'abandoned', runId: 'run_b' }, // 已熔断，run 早终结了
  ]);
  assert.deepEqual(out, ['run_a']);
});

test('dismiss：非数组/空输入不炸', () => {
  assert.deepEqual(runIdsToAbortOnDismiss(null), []);
  assert.deepEqual(runIdsToAbortOnDismiss([]), []);
});

/**
 * 续跑计划判据。
 * 回归背景：前端撞上「run 不存在」时会静默等待，等的就是这个判据说的那个新 run。
 * 判 true 而实际没人来 → 气泡永久转圈；判 false 而其实会续跑 → 把正在自愈的任务提前终结。
 */
const pending = [
  { convId: 'c-wait', status: 'waiting' },
  { convId: 'c-resuming', status: 'resuming', runId: 'run_x' },
  { convId: 'c-done', status: 'done' },
  { convId: 'c-abandoned', status: 'abandoned' },
];

test('有 waiting 条目 → 有续跑计划', () => {
  assert.equal(isResumePlanned(pending, 'c-wait'), true);
});

test('有 resuming 条目 → 有续跑计划（新 run 已起跑，前端该等它接流）', () => {
  assert.equal(isResumePlanned(pending, 'c-resuming'), true);
});

test('只有 done 条目 → 无计划（已完成，不会再产生新 run）', () => {
  assert.equal(isResumePlanned(pending, 'c-done'), false);
});

test('只有 abandoned 条目 → 无计划（熔断标记只等前端消费一次提示后 dismiss）', () => {
  assert.equal(isResumePlanned(pending, 'c-abandoned'), false);
});

test('该会话压根没有条目 → 无计划', () => {
  assert.equal(isResumePlanned(pending, 'c-never'), false);
});

test('空 convId / 非数组入参 → 无计划，且不抛', () => {
  assert.equal(isResumePlanned(pending, ''), false);
  assert.equal(isResumePlanned(pending, null), false);
  assert.equal(isResumePlanned(null, 'c-wait'), false);
  assert.equal(isResumePlanned(undefined, 'c-wait'), false);
});

test('条目里混入 null（落盘数据损坏）→ 跳过，不抛', () => {
  assert.equal(isResumePlanned([null, { convId: 'c-wait', status: 'waiting' }], 'c-wait'), true);
});

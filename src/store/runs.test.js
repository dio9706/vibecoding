/**
 * runs.js 交互决策（askUser/resolveDecision/setRunMode）单测。
 * 回归背景：SDK 对同一助手轮的多个并行 tool_use 会「并发」调用 canUseTool，
 * 单槽 run.pending 会被第二个 ask 覆盖 → 第一个的 resolve 永久丢失 → CLI 等权限响应挂死
 * → 看门狗 300s 误杀（2026-07-18 run_mrqh5rax2vth 事故）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, askUser, resolveDecision, finishRun, setRunMode, nextReqId, stopRun, shouldResolveWaiting, UNATTENDED_WAIT_MAX_MS, hasActiveRunForConv, findRunningRunByConv, registerRunSettleListener, blockRun } from './runs.js';

function makeAsk(reqId) {
  return {
    reqId,
    kind: 'permission',
    title: `请求 ${reqId}`,
    body: '',
    options: [
      { id: 'allow', label: '允许' },
      { id: 'deny', label: '拒绝' },
    ],
    defaultChoice: 'deny',
  };
}

test('并发两个 askUser：先后都能被决策，互不覆盖', async (t) => {
  const run = createRun();
  t.after(() => finishRun(run));

  const p1 = askUser(run, makeAsk('r1'));
  const p2 = askUser(run, makeAsk('r2'));

  // 第一个 ask 在展示位，第二个排队等待（而不是覆盖）
  assert.equal(run.pending?.reqId, 'r1');
  assert.equal(run.waiting, true);

  assert.equal(resolveDecision(run.id, 'r1', 'allow'), true);
  assert.equal(await p1, 'allow');

  // r1 决策后 r2 自动上位，仍处于等待用户状态（看门狗不得按静默计时）
  assert.equal(run.pending?.reqId, 'r2');
  assert.equal(run.waiting, true);

  assert.equal(resolveDecision(run.id, 'r2', 'deny'), true);
  assert.equal(await p2, 'deny');

  assert.equal(run.pending, null);
  assert.equal(run.waiting, false);
});

test('决策 reqId 不匹配当前展示位时返回 false', (t) => {
  const run = createRun();
  t.after(() => finishRun(run));

  askUser(run, makeAsk('r1'));
  assert.equal(resolveDecision(run.id, 'nope', 'allow'), false);
  assert.equal(run.pending?.reqId, 'r1'); // 未被误消费
  resolveDecision(run.id, 'r1', 'deny');
});

test('run 终结时未决 ask 全部按默认值兜底 resolve（不留悬空 Promise）', async () => {
  const run = createRun();
  const p1 = askUser(run, makeAsk('r1'));
  const p2 = askUser(run, makeAsk('r2'));

  finishRun(run);

  assert.equal(await p1, 'deny');
  assert.equal(await p2, 'deny');
});

// ---- setRunMode 测试 ----

// 模拟「询问」模式起跑的 run（server 的 startClaudeRun 负责设置这两个字段）
function makeDefaultModeRun() {
  const run = createRun();
  run.mode = 'default';
  run.startMode = 'default';
  return run;
}

test('setRunMode：询问起跑 + 放宽目标 → 生效并放行挂起/排队的 permission', async (t) => {
  const run = makeDefaultModeRun();
  t.after(() => stopRun(run)); // 清看门狗定时器，避免测试进程挂住
  const p1 = askUser(run, { reqId: nextReqId(run), kind: 'permission', title: 'Bash', options: [], defaultChoice: 'deny' });
  const p2 = askUser(run, { reqId: nextReqId(run), kind: 'permission', title: 'Edit', options: [], defaultChoice: 'deny' });
  assert.equal(setRunMode(run.id, 'acceptEdits'), true);
  assert.equal(run.mode, 'acceptEdits');
  assert.equal(await p1, 'allow');
  assert.equal(await p2, 'allow');
  assert.equal(run.pending, null);
  assert.equal(run.waiting, false);
});

test('setRunMode：dialog 类询问保序保留，不被自动放行', async (t) => {
  const run = makeDefaultModeRun();
  t.after(() => stopRun(run));
  const perm = askUser(run, { reqId: nextReqId(run), kind: 'permission', title: 'Bash', options: [], defaultChoice: 'deny' });
  askUser(run, { reqId: nextReqId(run), kind: 'dialog', title: '选一个', options: [], defaultChoice: '__cancel__' });
  assert.equal(setRunMode(run.id, 'bypassPermissions'), true);
  assert.equal(await perm, 'allow');
  assert.equal(run.pending.kind, 'dialog'); // dialog 上位继续等用户
});

test('setRunMode：非法目标 / 非询问起跑 / 未知 run / 已结束 → 不生效', (t) => {
  const run = makeDefaultModeRun();
  t.after(() => stopRun(run));
  assert.equal(setRunMode(run.id, 'plan'), false);
  assert.equal(setRunMode(run.id, 'default'), false);
  assert.equal(setRunMode('run_nonexistent', 'acceptEdits'), false);

  const bypassRun = createRun();
  t.after(() => stopRun(bypassRun));
  bypassRun.mode = 'bypassPermissions';
  bypassRun.startMode = 'bypassPermissions';
  assert.equal(setRunMode(bypassRun.id, 'acceptEdits'), false);

  const doneRun = makeDefaultModeRun();
  stopRun(doneRun);
  assert.equal(setRunMode(doneRun.id, 'acceptEdits'), false);
});

// ---- setRunMode 判档窗口缓冲测试 ----
// 背景：auto 判档最长 8s，此窗口内 run.startMode 尚未赋值，setRunMode 若直接判「非 default」
// 会误返回 false（前端误报切换失败）。改为缓冲到 run._pendingMode，待 startMode 赋值后补发。

test('setRunMode: 判档窗口内缓冲（run.startMode === undefined）', (t) => {
  const run = createRun();
  t.after(() => stopRun(run));
  assert(run.status === 'running');
  assert.equal(run.startMode, null);

  const applied = setRunMode(run.id, 'acceptEdits');
  assert.equal(applied, true);
  assert.equal(run._pendingMode, 'acceptEdits');
});

test('setRunMode: 判档窗口后补发缓冲的模式', (t) => {
  const run = createRun();
  t.after(() => stopRun(run));

  const r1 = setRunMode(run.id, 'acceptEdits');
  assert.equal(r1, true);

  // 判档结果为「询问」起跑（default）；startClaudeRun 补发时先取出缓冲值再调用 setRunMode
  run.startMode = 'default';
  const targetMode = run._pendingMode;
  delete run._pendingMode;

  const r2 = setRunMode(run.id, targetMode);
  assert.equal(r2, true);
  assert.equal(run.mode, 'acceptEdits');
  assert.equal(run._pendingMode, undefined);
});

test('setRunMode: 非询问起跑时缓冲的模式无法生效', (t) => {
  const run = createRun();
  t.after(() => stopRun(run));

  const r1 = setRunMode(run.id, 'acceptEdits');
  assert.equal(r1, true);

  // 判档结果非「询问」起跑（例如 acceptEdits），未装 ask 钩子
  run.startMode = 'acceptEdits';

  const r2 = setRunMode(run.id, 'bypassPermissions');
  assert.equal(r2, false);
});

// ── 终结后的 askUser（悬空 Promise 防线）─────────────────────────
// 背景：askUser 无 run 状态守卫。run 已终结（drainAsks 跑完且不会再跑）后，
// SDK 优雅关闭期间 CLI 仍可能再发一次权限请求 → 新建的 pending Promise 永不 resolve
// → 上层 await 永不返回 → mcp.close()/清理逻辑永不执行。

test('askUser：run 已终结时立即按 defaultChoice resolve，不挂起', async () => {
  const run = createRun();
  finishRun(run, 'ok');
  const t0 = Date.now();
  const choice = await Promise.race([
    askUser(run, { reqId: nextReqId(run), kind: 'permission', options: [], defaultChoice: 'deny' }),
    new Promise((r) => setTimeout(() => r('__TIMEOUT__'), 300)),
  ]);
  assert.equal(choice, 'deny', '终结后的 ask 必须立刻按默认值兜底');
  assert.ok(Date.now() - t0 < 250, '不应等待超时才返回');
});

test('askUser：run 已终结时不污染 pending/队列（否则 gc 与重连逻辑会看到幽灵 ask）', async () => {
  const run = createRun();
  finishRun(run, 'ok');
  // 必须带超时闸：修复前这个 await 会永久挂起，直接拖死整个测试进程
  const r = await Promise.race([
    askUser(run, { reqId: nextReqId(run), kind: 'permission', options: [], defaultChoice: 'deny' }),
    new Promise((res) => setTimeout(() => res('__TIMEOUT__'), 300)),
  ]);
  assert.notEqual(r, '__TIMEOUT__', '终结后的 ask 挂起了');
  assert.equal(run.pending, null);
  assert.equal(run.pendingQueue.length, 0);
  assert.equal(run.waiting, false);
});

test('askUser：run 仍在运行时行为不变（正常挂起等待用户）', async () => {
  const run = createRun();
  const reqId = nextReqId(run);
  let settled = false;
  const p = askUser(run, { reqId, kind: 'permission', options: [], defaultChoice: 'deny' }).then((v) => {
    settled = true;
    return v;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false, '运行中的 ask 不应立即 resolve');
  assert.equal(run.pending?.reqId, reqId);
  resolveDecision(run.id, reqId, 'allow');
  assert.equal(await p, 'allow');
  finishRun(run, 'ok'); // 必须终结：否则 run 的看门狗 interval 让测试进程无法退出
});

// ── 等待审批的上界（无人值守泄漏防线）───────────────────────────
// 背景：看门狗对 waiting 的兜底附加了「必须有订阅者」条件，关掉网页时挂起的审批
// **永远**不会 resolve：run 永远 running、gc 跳过、CLI 子进程常驻、
// active-runs.json 条目永不清除，重启后还会被当孤儿自动续跑并累加 resumeAttempt。
// 设计意图（无人值守不自动拒绝、等用户回来批）要保留，但必须有远端上界。

test('shouldResolveWaiting：有人观看时沿用 15min 兜底', () => {
  assert.equal(shouldResolveWaiting({ hasSubscribers: true, waitedMs: 14 * 60 * 1000 }), false);
  assert.equal(shouldResolveWaiting({ hasSubscribers: true, waitedMs: 16 * 60 * 1000 }), true);
});

test('shouldResolveWaiting：无人值守时不按 15min 兜底（保留原设计意图）', () => {
  assert.equal(shouldResolveWaiting({ hasSubscribers: false, waitedMs: 16 * 60 * 1000 }), false);
  assert.equal(shouldResolveWaiting({ hasSubscribers: false, waitedMs: 3 * 60 * 60 * 1000 }), false);
});

test('shouldResolveWaiting：无人值守也必须有远端上界，不能无限等（核心回归）', () => {
  assert.equal(shouldResolveWaiting({ hasSubscribers: false, waitedMs: 24 * 60 * 60 * 1000 }), true);
});

test('shouldResolveWaiting：上界是有限值且远大于有人观看时的窗口', () => {
  assert.ok(UNATTENDED_WAIT_MAX_MS > 15 * 60 * 1000);
  assert.ok(Number.isFinite(UNATTENDED_WAIT_MAX_MS));
});

// ── hasActiveRunForConv（需求串行闸：系统任务须等该会话空闲）──────────

test('hasActiveRunForConv：仅 running 且 convId 匹配为真', () => {
  const run = createRun();
  run.convId = 'c_req_1';
  assert.equal(hasActiveRunForConv('c_req_1'), true);
  assert.equal(hasActiveRunForConv('c_other'), false);
  finishRun(run);
  assert.equal(hasActiveRunForConv('c_req_1'), false);
  assert.equal(hasActiveRunForConv(''), false);
});

// findRunningRunByConv 与上者的区别是返回 run 本体 —— 飞书注入要拿到对象才能判断
// 走插话（holdMsg）还是新起一轮，返回布尔不够用。
test('findRunningRunByConv：返回 run 本体，非 running / 空 convId 返回 null', () => {
  const run = createRun();
  run.convId = 'c_find_1';
  assert.equal(findRunningRunByConv('c_find_1'), run); // 同一对象引用，不是拷贝
  assert.equal(findRunningRunByConv('c_other'), null);
  assert.equal(findRunningRunByConv(''), null);
  assert.equal(findRunningRunByConv(undefined), null);
  finishRun(run);
  assert.equal(findRunningRunByConv('c_find_1'), null); // 已终结的不算
});

// ── run 终结监听器（飞书通知等旁路关注方的唯一接缝）──────────────
// 监听器必须「每个 run 只收到一次」且「收到时 subtype 已置好」，
// 否则通知侧无法按 stopped/quota_blocked 过滤，用户会被手动停止的任务反复打扰。

test('终结监听器：finishRun 触发一次，带 subtype', () => {
  const seen = [];
  registerRunSettleListener((r) => seen.push({ id: r.id, subtype: r.subtype, status: r.status }));
  const run = createRun();
  run.convId = 'c_listener';
  finishRun(run);
  finishRun(run); // 幂等：status 已非 running，不得二次广播
  const mine = seen.filter((s) => s.id === run.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'done');
});

// 注意：监听器里必须**快照字段**而不是 push 活 run 对象引用 —— 后者读到的是断言时刻的
// 状态而非广播时刻的，会让「emitSettled 挪到 subtype 赋值之前」这类回归照样通过，
// 恰好放跑本任务唯一的正确性关键。
test('终结监听器：stopRun 带 subtype=stopped（供通知侧过滤）', () => {
  const seen = [];
  registerRunSettleListener((r) => seen.push({ id: r.id, subtype: r.subtype }));
  const run = createRun();
  stopRun(run, '已手动停止');
  const mine = seen.filter((s) => s.id === run.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].subtype, 'stopped');
});

test('终结监听器：blockRun 带 subtype=quota_blocked（供通知侧过滤）', () => {
  const seen = [];
  registerRunSettleListener((r) => seen.push({ id: r.id, subtype: r.subtype }));
  const run = createRun();
  blockRun(run, '额度已用尽，将于重置后自动续跑');
  const mine = seen.filter((s) => s.id === run.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].subtype, 'quota_blocked');
});

test('终结监听器：async 监听器抛错不得溢出成 unhandled rejection（会打挂 web 服务）', async () => {
  registerRunSettleListener(async () => {
    await Promise.resolve();
    throw new Error('模拟飞书推送失败');
  });
  const after = [];
  registerRunSettleListener((r) => after.push(r.id)); // 前一个失败不得阻断后续监听器
  const run = createRun();
  finishRun(run);
  await new Promise((r) => setTimeout(r, 20)); // 给 rejection 冒泡的机会：未兜住则本用例失败
  assert.equal(run.status, 'done'); // 收尾不受监听器失败影响
  assert.ok(after.includes(run.id));
});

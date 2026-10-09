import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'colleague-dev-'));
delete process.env.LARK_APP_ID;
delete process.env.LARK_APP_SECRET;

const { replyColleague, buildColleagueDevOnSettle, dispatchColleagueDev, abandonColleagueDev, buildColleagueBrief, agentBranchName, COLLEAGUE_DEV_KIND } = await import('./colleague-dev.js');
const { createRequirement, updateRequirement, getRequirement } = await import('../../store/requirements.js');
const { addColleague } = await import('../../store/colleagues.js');
const { appendTo, getColleagueThread } = await import('../../store/colleague-messages.js');
const { getRun, finishRun } = await import('../../store/runs.js');

function setupReq() {
  const c = addColleague({ name: '后端小王', role: 'backend', feishuOpenId: 'ou_wang' });
  const r = createRequirement({ title: '订单导出' });
  updateRequirement(r.id, { phase: 'dev', assignees: [c.id], convId: 'c_main' });
  return { c, r: getRequirement(r.id) };
}

/**
 * 建一个「带工程目录 + 定稿分支」的开发期需求：dispatch 的 worktree 分支准备都靠这两样。
 * dir 用真实临时目录（pickCwdAndDirs 只读路径字符串，不落盘），git 调用全部注入成假的。
 */
function setupDevReq(prefix = 'cd-cwd-') {
  const c = addColleague({ name: '后端', role: 'backend', feishuOpenId: 'ou_' + prefix });
  const r = createRequirement({ title: '主路径' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  updateRequirement(r.id, {
    phase: 'dev',
    assignees: [c.id],
    convId: 'c_main',
    projects: { frontend: { dir, dev: true }, backend: null },
    branches: [{ dir, branch: 'req/订单导出', baseBranch: 'main' }],
  });
  return { c, r: getRequirement(r.id), dir, wtDir: dir + '.req-' + r.id.slice(0, 8) };
}

/** dispatch 的假 git 依赖：单测里那几个临时目录不是 git 仓库，真调 git 必然失败 */
function fakeDispatchDeps(over = {}) {
  return {
    ensureWorktree: async (repo, reqId) => ({ ok: true, dir: repo + '.req-' + String(reqId).slice(0, 8) }),
    commitResidue: async () => ({ committed: false, dirty: false }),
    currentBranch: async () => 'main',
    runGit: async () => ({ ok: true }),
    ...over,
  };
}

/**
 * onSettle 的 gitCtx：git / 合并 / 台账三类外部副作用注入成假的，默认走「提交成功 + 合并成功」。
 * `_calls` 记录调用顺序 —— 「先回同事已处理完成、几秒后合并才失败」正是本次改造要消灭的时序问题。
 */
function fakeGitCtx(over = {}) {
  const calls = [];
  const ledger = [];
  const ctx = {
    workDir: 'D:/proj.req-r_abc',
    repo: 'D:/proj',
    branch: 'req/r_abc/agent-m1',
    baseBranch: 'req/订单导出',
    commitAll: async (dir, msg) => {
      calls.push('commit');
      ctx._commitMsg = msg;
      ctx._commitDir = dir;
      return { committed: true };
    },
    enqueueMerge: async (task) => {
      calls.push('merge');
      ctx._mergeTask = task;
      return { ok: true, status: 'merged', sha: 'sha_merge_1' };
    },
    appendAction: (e) => {
      calls.push('ledger');
      ledger.push(e);
      return e;
    },
    runGit: async () => {
      calls.push('git');
      return { ok: true };
    },
    ...over,
  };
  ctx._calls = calls;
  ctx._ledger = ledger;
  return ctx;
}

test('COLLEAGUE_DEV_KIND 常量', () => {
  assert.equal(COLLEAGUE_DEV_KIND, 'colleague-dev');
});

test('agentBranchName：逐消息一分支，撤第二条不会连带撤掉第一条', () => {
  assert.equal(agentBranchName('r_abc', 'cm_1'), 'req/r_abc/agent-cm_1');
  assert.notEqual(agentBranchName('r_abc', 'cm_1'), agentBranchName('r_abc', 'cm_2'));
});

test('buildColleagueBrief：没合并进需求分支就不能说成「已处理完成」（同事会照这句去联调）', () => {
  assert.equal(buildColleagueBrief('merged', '改了两个文件'), '已处理完成：改了两个文件');
  assert.match(buildColleagueBrief('pending-merge', '改了两个文件'), /待主机合并/);
  assert.match(buildColleagueBrief('merge-failed', '改了两个文件'), /未合并/);
  assert.equal(buildColleagueBrief('no-change', '我改好了'), buildColleagueBrief('run-failed'), '模型谎报改完与 run 失败对同事是同一件事');
  assert.equal(buildColleagueBrief('git-error', 'x'), buildColleagueBrief('run-failed'));
});

test('replyColleague：无机器人凭证时返回 false，且不落 out 消息（落了界面会显示一条其实没送达的）', async () => {
  const { c, r } = setupReq();
  const ok = await replyColleague(r.id, c.id, '测试回复');
  assert.equal(ok, false);
  assert.equal(getColleagueThread(c.id).messages.length, 0);
});

test('replyColleague：同事无 open_id 时返回 false', async () => {
  const c = addColleague({ name: '无号', role: 'backend' });
  const r = createRequirement({ title: 'x' });
  assert.equal(await replyColleague(r.id, c.id, 'hi'), false);
});

test('onSettle 成功：清 busy、回填子会话 sessionId、消息标 handledBy:ai、history 留痕', async () => {
  const { c, r } = setupReq();
  const msg = appendTo(c.id,{ dir: 'in', text: '接口文档', role: 'backend' });
  const convId = 'c1700000000000abc';
  updateRequirement(r.id, {
    sessions: [{ convId, sessionId: null, title: '接入接口文档：a.md', kind: 'sub', phase: 'dev', createdAt: 'x' }],
    busy: { kind: COLLEAGUE_DEV_KIND, runId: 'run_1', startedAt: 1, convId },
  });
  const onSettle = buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: '接入接口文档：a.md' }, convId, fakeGitCtx());
  await onSettle(true, { id: 'run_1', session_id: 'sess_9', result: '改了两个文件' });

  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.equal(after.sessions[0].sessionId, 'sess_9');
  assert.equal(after.history.at(-1).event, `系统任务 ${COLLEAGUE_DEV_KIND} 完成：接入接口文档：a.md`);
  const m = getColleagueThread(c.id).messages.find((x) => x.id === msg.id);
  assert.equal(m.handledBy, 'ai');
  assert.equal(m.handledNote, '已处理 · 接入接口文档：a.md');
});

test('onSettle 失败：handledNote 记失败，history 记失败', async () => {
  const { c, r } = setupReq();
  const msg = appendTo(c.id,{ dir: 'in', text: 'x', role: 'backend' });
  updateRequirement(r.id, { busy: { kind: COLLEAGUE_DEV_KIND, runId: 'run_2', startedAt: 1, convId: 'c_x' } });
  await buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_x', fakeGitCtx())(false, { id: 'run_2' });
  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.equal(after.history.at(-1).event, `系统任务 ${COLLEAGUE_DEV_KIND} 失败：T`);
  assert.equal(getColleagueThread(c.id).messages[0].handledNote, '处理失败 · T');
});

test('onSettle 归属校验：busy.runId 不是本 run 时不清 busy（防击穿串行闸），其余照做', async () => {
  const { c, r } = setupReq();
  const msg = appendTo(c.id,{ dir: 'in', text: 'x', role: 'backend' });
  updateRequirement(r.id, { busy: { kind: 'bug-fix', runId: 'run_other', startedAt: 1 } });
  await buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_y', fakeGitCtx())(true, { id: 'run_mine', session_id: 's' });
  assert.equal(getRequirement(r.id).busy.runId, 'run_other', 'healStaleBusy 可能已清过并派了下一个，那份 busy 不归本回调管');
  assert.equal(getColleagueThread(c.id).messages[0].handledBy, 'ai');
});

test('onSettle：需求已被删时静默返回', () => {
  assert.doesNotThrow(() => buildColleagueDevOnSettle('r_gone', { msgId: 'm', colleagueId: 'c', title: 'T' }, 'c_z', fakeGitCtx())(true, { id: 'r' }));
});

test('abandonColleagueDev：留痕 + markHandled + 回同事（无凭证时回复返 false 不抛）', async () => {
  const { c, r } = setupReq();
  const msg = appendTo(c.id,{ dir: 'in', text: 'x', role: 'backend' });
  abandonColleagueDev(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, '需求已离开开发期');
  await new Promise((res) => setImmediate(res));
  assert.equal(getRequirement(r.id).history.at(-1).event, `系统任务 ${COLLEAGUE_DEV_KIND} 作废：需求已离开开发期`);
  const m = getColleagueThread(c.id).messages[0];
  assert.equal(m.handledBy, 'ai');
  assert.equal(m.handledNote, '作废（需求已离开开发期） · T');
});

test('dispatchColleagueDev 主路径：建子会话、busy 带 convId、以无人值守策略起新上下文 run', async (t) => {
  const { c, r, wtDir } = setupDevReq('cd-main-');
  let seen = null;
  await dispatchColleagueDev(getRequirement(r.id), { msgId: 'm1', colleagueId: c.id, prompt: 'P', title: 'T' }, {
    ...fakeDispatchDeps(),
    start: (run, opts) => { seen = { run, opts }; },
  });
  // 注入的 start 是空操作，不会像真实 startClaudeRun 那样走到终结口——run 会一直挂在 running，
  // 看门狗 setInterval 未 unref，不清掉会让 node --test 进程挂起（对齐 routes-run.test.js 的 t.after 用法）
  t.after(() => finishRun(seen.run));
  const after = getRequirement(r.id);
  const sub = after.sessions.at(-1);
  assert.equal(sub.kind, 'sub');
  assert.equal(sub.phase, 'dev');
  assert.equal(sub.title, 'T');
  assert.equal(after.busy.kind, COLLEAGUE_DEV_KIND);
  assert.equal(after.busy.convId, sub.convId, 'busy.convId 指向新建的子会话，前端接流与 healStaleBusy 都靠它');
  assert.equal(after.busy.runId, seen.run.id);
  assert.equal(seen.opts.unattended, true, 'T6：无人值守策略由 startClaudeRun 按 bot.execPolicy 解析');
  assert.equal(seen.opts.mode, undefined, '不再写死 mode：策略由 execPolicy/unattended 解析（bypass 档 = 原 bypassPermissions）');
  assert.equal(seen.opts.convId, sub.convId);
  assert.equal(seen.opts.session, undefined, '新上下文，不 resume devSession');
  assert.equal(typeof seen.run.onSettle, 'function');
  assert.equal(after.history.at(-1).event, `系统任务 ${COLLEAGUE_DEV_KIND} 启动：T`);
  assert.equal(seen.opts.cwd, wtDir, 'agent 在 per-需求 worktree 里改码');
});

test('dispatchColleagueDev：cwd 是 per-需求 worktree 而非主工作区（主工作区是主机自己在用的）', async (t) => {
  const { c, r, dir, wtDir } = setupDevReq('cd-wt-');
  let seen = null;
  const gitArgs = [];
  await dispatchColleagueDev(getRequirement(r.id), { msgId: 'm_wt', colleagueId: c.id, prompt: 'P', title: 'T' }, {
    ...fakeDispatchDeps({ runGit: async (args) => { gitArgs.push(args); return { ok: true }; } }),
    start: (run, opts) => { seen = { run, opts }; },
  });
  t.after(() => finishRun(seen.run));
  assert.equal(seen.opts.cwd, wtDir);
  assert.notEqual(seen.opts.cwd, dir, '绝不能把 agent 放进主工作区');
  assert.deepEqual(
    gitArgs[0],
    ['-C', wtDir, 'checkout', '-B', `req/${r.id}/agent-m_wt`, 'req/订单导出'],
    'checkout -B 在 worktree 里执行，基线取 req.branches 里该工程的需求分支',
  );
});

test('dispatchColleagueDev：req.branches 没有该工程时，基线退到主工作区的当前分支', async (t) => {
  const { c, r, wtDir } = setupDevReq('cd-base-');
  updateRequirement(r.id, { branches: [{ dir: 'D:/别的工程', branch: 'req/别的', baseBranch: 'main' }] });
  let seen = null;
  const gitArgs = [];
  await dispatchColleagueDev(getRequirement(r.id), { msgId: 'm_b', colleagueId: c.id, prompt: 'P', title: 'T' }, {
    ...fakeDispatchDeps({ currentBranch: async () => 'feat/当前', runGit: async (args) => { gitArgs.push(args); return { ok: true }; } }),
    start: (run, opts) => { seen = { run, opts }; },
  });
  t.after(() => finishRun(seen.run));
  assert.deepEqual(gitArgs[0], ['-C', wtDir, 'checkout', '-B', `req/${r.id}/agent-m_b`, 'feat/当前']);
});

test('dispatchColleagueDev：busy 在第一个 await 之前就写盘（泵每 5 秒 tick，晚一步写就会并发派发第二个任务抢同一个 worktree）', async (t) => {
  const { c, r } = setupDevReq('cd-busy-');
  let seen = null;
  const p = dispatchColleagueDev(getRequirement(r.id), { msgId: 'm_busy', colleagueId: c.id, prompt: 'P', title: 'T' }, {
    ...fakeDispatchDeps(),
    start: (run, opts) => { seen = { run, opts }; },
  });
  assert.equal(getRequirement(r.id).busy?.kind, COLLEAGUE_DEV_KIND, '串行闸必须在同步段就关上');
  await p;
  t.after(() => finishRun(seen.run));
});

test('dispatchColleagueDev：worktree 建不起来 → 作废并告知同事，不起 run', async () => {
  const { c, r } = setupDevReq('cd-wtfail-');
  const msg = appendTo(c.id,{ dir: 'in', text: '接口文档', role: 'backend' });
  let started = false;
  await dispatchColleagueDev(getRequirement(r.id), { msgId: msg.id, colleagueId: c.id, prompt: 'P', title: 'T' }, {
    ...fakeDispatchDeps({ ensureWorktree: async () => ({ ok: false, dir: 'x', error: '目录已存在但不是本仓库的 worktree' }) }),
    start: () => { started = true; },
  });
  await new Promise((res) => setImmediate(res));
  assert.equal(started, false, 'worktree 不可用时绝不能降级回主工作区改码');
  const after = getRequirement(r.id);
  assert.equal(after.busy, null, 'busy 必须清掉，否则该需求的任务全卡死');
  assert.equal(after.sessions.some((s) => s.title === 'T'), false, '作废的子会话不该留空壳');
  assert.match(after.history.at(-1).event, /作废/);
  const m = getColleagueThread(c.id).messages.find((x) => x.id === msg.id);
  assert.equal(m.handledBy, 'ai', '不标已处理的话这条消息永远挂在未处理');
});

test('dispatchColleagueDev：worktree 残留提交不掉 → 作废，不起 run（脏区继续跑会把残留混进本次提交）', async () => {
  const { c, r } = setupDevReq('cd-residue-');
  const msg = appendTo(c.id,{ dir: 'in', text: 'x', role: 'backend' });
  let started = false;
  await dispatchColleagueDev(getRequirement(r.id), { msgId: msg.id, colleagueId: c.id, prompt: 'P', title: 'T' }, {
    ...fakeDispatchDeps({ commitResidue: async () => ({ committed: false, dirty: true, error: 'index.lock 占用' }) }),
    start: () => { started = true; },
  });
  await new Promise((res) => setImmediate(res));
  assert.equal(started, false);
  assert.equal(getRequirement(r.id).busy, null);
  assert.equal(getColleagueThread(c.id).messages.find((x) => x.id === msg.id).handledBy, 'ai');
});

test('dispatchColleagueDev：准备阶段抛错也要清 busy（泵不 await 本函数，抛出去就是 unhandled rejection）', async () => {
  const { c, r } = setupDevReq('cd-boom-');
  const msg = appendTo(c.id,{ dir: 'in', text: 'x', role: 'backend' });
  let started = false;
  await dispatchColleagueDev(getRequirement(r.id), { msgId: msg.id, colleagueId: c.id, prompt: 'P', title: 'T' }, {
    ...fakeDispatchDeps({ ensureWorktree: async () => { throw new Error('git 进程起不来'); } }),
    start: () => { started = true; },
  });
  await new Promise((res) => setImmediate(res));
  assert.equal(started, false);
  const after = getRequirement(r.id);
  assert.equal(after.busy, null, 'busy 挂着的话该需求所有系统任务排队等死');
  assert.equal(after.sessions.some((s) => s.title === 'T'), false);
  assert.equal(getColleagueThread(c.id).messages.find((x) => x.id === msg.id).handledBy, 'ai');
});

test('dispatchColleagueDev 起跑抛错：清 busy、撤掉子会话条目、run 置错、onSettle 摘掉', async () => {
  const { c, r } = setupDevReq('cd-throw-');
  let runRef = null;
  await dispatchColleagueDev(getRequirement(r.id), { msgId: 'm2', colleagueId: c.id, prompt: 'P', title: 'T2' }, {
    ...fakeDispatchDeps(),
    start: (run) => { runRef = run; throw new Error('settings 损坏'); },
  });
  await new Promise((res) => setImmediate(res)); // 让 fire-and-forget 的回复 promise 在用例内结束
  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.equal(after.sessions.some((s) => s.title === 'T2'), false, '失败的子会话不该留空壳');
  assert.match(after.history.at(-1).event, /起跑失败：settings 损坏/);
  assert.equal(runRef.onSettle, null);
  assert.equal(getRun(runRef.id)?.status, 'error');
});

test('onSettle 成功链：提交 → 脱离分支 → 入合并队列 → 写台账，台账带 revert-merge 锚点与队列返回的 sha', async () => {
  const { c, r } = setupReq();
  const msg = appendTo(c.id,{ dir: 'in', text: '改了字段', role: 'backend' });
  updateRequirement(r.id, { busy: { kind: COLLEAGUE_DEV_KIND, runId: 'run_g', startedAt: 1, convId: 'c_g' } });
  const gitCtx = fakeGitCtx();
  await buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_g', gitCtx)(true, { id: 'run_g', result: '改完了' });

  assert.deepEqual(gitCtx._calls, ['commit', 'git', 'merge', 'ledger'], '台账必须在合并之后写——sha 要等队列给');
  assert.equal(gitCtx._commitDir, gitCtx.workDir, '提交的是 worktree，不是主工作区');
  assert.match(gitCtx._commitMsg, /^feat: /, '提交信息走 commitlint 规范（type: subject）');
  assert.deepEqual(gitCtx._mergeTask, { repo: gitCtx.repo, branch: gitCtx.branch, baseBranch: gitCtx.baseBranch });
  const entry = gitCtx._ledger[0];
  assert.equal(entry.tool, 'start_dev_task');
  assert.equal(entry.reqId, r.id);
  assert.equal(entry.colleagueId, c.id);
  assert.equal(entry.msgId, msg.id);
  assert.equal(entry.undo.kind, 'revert-merge');
  assert.equal(entry.undo.repo, gitCtx.repo);
  assert.equal(entry.undo.branch, gitCtx.branch);
  assert.equal(entry.undo.baseBranch, gitCtx.baseBranch);
  assert.equal(entry.undo.mergeSha, 'sha_merge_1');
});

test('onSettle：清 busy 在同步段（串行闸立刻放开），markHandled 与简报在异步链里（合并结果先出来再措辞）', async () => {
  const { c, r } = setupReq();
  const msg = appendTo(c.id,{ dir: 'in', text: 'x', role: 'backend' });
  updateRequirement(r.id, { busy: { kind: COLLEAGUE_DEV_KIND, runId: 'run_s', startedAt: 1, convId: 'c_s' } });
  const chain = buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_s', fakeGitCtx())(true, { id: 'run_s' });
  assert.equal(getRequirement(r.id).busy, null, 'busy 晚清一步，该需求的下一个任务就要等合并排完队');
  assert.notEqual(getColleagueThread(c.id).messages[0].handledBy, 'ai', '同步段不该标已处理——合并结果还没出来');
  await chain;
  assert.equal(getColleagueThread(c.id).messages[0].handledBy, 'ai');
});

test('onSettle：commitAll 报无改动 → 不入队、不写台账（模型说改完了但一行没动，不该留假的可撤销记录）', async () => {
  const { c, r } = setupReq();
  const msg = appendTo(c.id,{ dir: 'in', text: 'x', role: 'backend' });
  const gitCtx = fakeGitCtx({ commitAll: async () => ({ committed: false, err: 'nothing to commit' }) });
  await buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_n', gitCtx)(true, { id: 'run_n', result: '我改好了' });
  assert.equal(gitCtx._calls.includes('merge'), false);
  assert.equal(gitCtx._ledger.length, 0);
  assert.match(getColleagueThread(c.id).messages[0].handledNote, /处理失败/, '简报与台账都按失败措辞');
});

test('onSettle：合并降级 pending-merge → 仍写台账，mergeSha 为 null（分支在，撤销侧据此走删分支）', async () => {
  const { c, r } = setupReq();
  const msg = appendTo(c.id,{ dir: 'in', text: 'x', role: 'backend' });
  const gitCtx = fakeGitCtx({ enqueueMerge: async () => ({ ok: true, status: 'pending-merge', sha: null }) });
  await buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_p', gitCtx)(true, { id: 'run_p' });
  assert.equal(gitCtx._ledger.length, 1);
  assert.equal(gitCtx._ledger[0].undo.mergeSha, null);
  assert.equal(gitCtx._ledger[0].undo.branch, gitCtx.branch);
  assert.match(getColleagueThread(c.id).messages[0].handledNote, /待合并/, '主机要看得出改动还没进需求分支');
});

test('onSettle：合并失败 → 台账照写（分支还在，撤得回）但 ok 记 false', async () => {
  const { c, r } = setupReq();
  const msg = appendTo(c.id,{ dir: 'in', text: 'x', role: 'backend' });
  const gitCtx = fakeGitCtx({ enqueueMerge: async () => ({ ok: false, status: 'failed', sha: null, error: '合并冲突' }) });
  await buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_f', gitCtx)(true, { id: 'run_f' });
  assert.equal(gitCtx._ledger.length, 1);
  assert.equal(gitCtx._ledger[0].ok, false);
  assert.equal(gitCtx._ledger[0].undo.mergeSha, null);
});

test('onSettle：run 失败（ok=false）→ 不提交不合并不写台账', async () => {
  const { c, r } = setupReq();
  const msg = appendTo(c.id,{ dir: 'in', text: 'x', role: 'backend' });
  const gitCtx = fakeGitCtx();
  await buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_e', gitCtx)(false, { id: 'run_e' });
  assert.deepEqual(gitCtx._calls, []);
  assert.equal(gitCtx._ledger.length, 0);
});

test('onSettle：台账写盘抛错不阻断 markHandled 与简报（否则同事一直等、消息永远挂未处理）', async () => {
  const { c, r } = setupReq();
  const msg = appendTo(c.id,{ dir: 'in', text: 'x', role: 'backend' });
  const gitCtx = fakeGitCtx({ appendAction: () => { throw new Error('agent-actions.json 损坏'); } });
  await buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_t', gitCtx)(true, { id: 'run_t' });
  assert.equal(getColleagueThread(c.id).messages[0].handledBy, 'ai');
});

test('同一 worktree 串行：上条任务的提交还没落地时，下条任务的 checkout -B 必须等着（busy 已在同步段放开）', async (t) => {
  const { c, r, wtDir } = setupDevReq('cd-serial-');
  const order = [];
  let release;
  const gate = new Promise((res) => { release = res; });
  const gitCtx = fakeGitCtx({
    workDir: wtDir,
    commitAll: async () => { order.push('commit:start'); await gate; order.push('commit:end'); return { committed: true }; },
    runGit: async () => { order.push('detach'); return { ok: true }; },
  });
  const settle = buildColleagueDevOnSettle(r.id, { msgId: 'm_a', colleagueId: c.id, title: 'A' }, 'c_a', gitCtx)(true, { id: 'run_a' });

  let seen = null;
  const disp = dispatchColleagueDev(getRequirement(r.id), { msgId: 'm_b', colleagueId: c.id, prompt: 'P', title: 'B' }, {
    ...fakeDispatchDeps({ runGit: async () => { order.push('checkout'); return { ok: true }; } }),
    start: (run, opts) => { seen = { run, opts }; },
  });
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(order, ['commit:start'], '上条还没提交完，下条的 checkout -B 会把它的改动切到别的分支上');
  release();
  await settle;
  await disp;
  t.after(() => finishRun(seen.run));
  assert.deepEqual(order, ['commit:start', 'commit:end', 'detach', 'checkout']);
});

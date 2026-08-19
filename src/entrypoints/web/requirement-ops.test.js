import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录：requirement-ops.js 顶层 import 了 store/requirements.js（读盘），
// 须在 import 本模块之前设置 APP_DATA_DIR（做法同 store/requirements.test.js）。
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'req-ops-'));
const {
  canDispatch,
  isBusyStale,
  healStaleBusy,
  reqDir,
  setBugStatus,
  buildSystemTaskOnSettle,
  combineSupplements,
  composeSupplementsForRevise,
  raceWithTimeoutFlag,
  finalizeGuard,
  resolveBaseBranch,
  hasQueuedTasks,
  queuedTasks,
  enqueueSystemTask,
  dispatch,
  finalizeRequirement,
  archiveRequirement,
  runDocgen,
} = await import('./requirement-ops.js');
const { createRequirement, updateRequirement, getRequirement } = await import('../../store/requirements.js');
const { parseFeatureTag } = await import('./req-logic.js');

test('canDispatch：busy 空且 conv 无活跃 run 才放行', () => {
  assert.equal(canDispatch({ busy: null, convId: 'c1' }, () => false), true);
  assert.equal(canDispatch({ busy: { kind: 'develop' }, convId: 'c1' }, () => false), false);
  assert.equal(canDispatch({ busy: null, convId: 'c1' }, (id) => id === 'c1'), false);
  assert.equal(canDispatch({ busy: null, convId: null }, () => true), true); // 无 conv（docgen）只看 busy
  assert.equal(canDispatch(null, () => false), false);
});

test('reqDir：惰性建目录，末段为文件名时返回完整文件路径，无 rest 时返回目录', () => {
  const r = createRequirement({ title: 'reqDir 测试' });
  const dir = reqDir(r.id);
  assert.ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory());
  const filePath = reqDir(r.id, 'dev-doc-v1.md');
  assert.equal(filePath, path.join(dir, 'dev-doc-v1.md'));
  assert.ok(fs.existsSync(path.dirname(filePath))); // 父目录已建好，文件本身无需存在
});

test('isBusyStale：run 仍在跑 → 不算泄漏', () => {
  assert.equal(
    isBusyStale(
      { busy: { kind: 'develop', runId: 'run1' }, convId: 'c1' },
      { getRunStatus: () => 'running', hasPendingResume: () => false },
    ),
    false,
  );
});

test('isBusyStale：run 不存在/已终结 且无待续跑登记 → 判定泄漏', () => {
  assert.equal(
    isBusyStale(
      { busy: { kind: 'develop', runId: 'run1' }, convId: 'c1' },
      { getRunStatus: () => null, hasPendingResume: () => false },
    ),
    true,
  );
  assert.equal(
    isBusyStale(
      { busy: { kind: 'develop', runId: 'run1' }, convId: 'c1' },
      { getRunStatus: () => 'done', hasPendingResume: () => false },
    ),
    true,
  );
});

test('isBusyStale：run 不在跑但有未终态待续跑登记 → 额度阻塞正常等待，不算泄漏', () => {
  assert.equal(
    isBusyStale(
      { busy: { kind: 'develop', runId: 'run1' }, convId: 'c1' },
      { getRunStatus: () => null, hasPendingResume: () => true },
    ),
    false,
  );
});

test('isBusyStale：busy 无 runId（docgen）→ 不参与判定，恒为 false（且不调用注入的依赖）', () => {
  assert.equal(
    isBusyStale(
      { busy: { kind: 'docgen' }, convId: null },
      {
        getRunStatus: () => { throw new Error('不该被调用'); },
        hasPendingResume: () => { throw new Error('不该被调用'); },
      },
    ),
    false,
  );
});

test('healStaleBusy：清理 bug-fix 泄漏时，该需求 status===fixing 的 bug 全部退回 failed', () => {
  const r = createRequirement({ title: 'bug-fix 泄漏测试' });
  updateRequirement(r.id, {
    busy: { kind: 'bug-fix', runId: 'run-dead-且从未存在' }, // 真实 getRun 查不到 → 视为不在跑；无 convId → 无待续跑登记
    bugs: [
      { id: 'b1', recordId: 'rec1', title: 'T1', status: 'fixing' },
      { id: 'b2', recordId: 'rec2', title: 'T2', status: 'pending' },
    ],
  });
  healStaleBusy(); // 用真实默认依赖：不 mock，run 确实不存在
  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.equal(after.bugs.find((b) => b.id === 'b1').status, 'failed'); // fixing → failed
  assert.equal(after.bugs.find((b) => b.id === 'b2').status, 'pending'); // 非 fixing 的不受影响
});

test('raceWithTimeoutFlag：timeoutPromise 先落定 → true（判超时）', async () => {
  const neverSettles = new Promise(() => {}); // 模拟 call 仍在跑，不会先赢
  assert.equal(await raceWithTimeoutFlag(neverSettles, Promise.resolve()), true);
});

test('raceWithTimeoutFlag：callPromise 先落定 → false（未超时，即便 resolve 出 undefined 也不误判）', async () => {
  const neverTimesOut = new Promise(() => {}); // 模拟远未到超时
  assert.equal(await raceWithTimeoutFlag(Promise.resolve(undefined), neverTimesOut), false);
});

test('buildSystemTaskOnSettle：busy.runId 与本次收尾的 run 不同 → 不清 busy（防止迟到回调击穿串行闸）', () => {
  const r = createRequirement({ title: '归属校验测试1' });
  // 模拟：本次任务的 run 是 run-old，但回调迟到期间泵已把 busy 换成了另一个任务 run-new
  updateRequirement(r.id, { busy: { kind: 'develop', runId: 'run-new', startedAt: Date.now() } });
  const onSettle = buildSystemTaskOnSettle(r, 'develop', {});
  onSettle(true, { id: 'run-old', session_id: 's1' });
  const after = getRequirement(r.id);
  assert.equal(after.busy?.runId, 'run-new'); // 不该被清掉
});

test('buildSystemTaskOnSettle：busy.runId 与本次收尾的 run 相同 → 正常清 busy + 回填 devSession', () => {
  const r = createRequirement({ title: '归属校验测试2' });
  updateRequirement(r.id, { busy: { kind: 'develop', runId: 'run-a', startedAt: Date.now() } });
  const onSettle = buildSystemTaskOnSettle(r, 'develop', {});
  onSettle(true, { id: 'run-a', session_id: 's2' });
  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.equal(after.devSession, 's2');
});

test('buildSystemTaskOnSettle：busy 不匹配时 bug 状态与 devSession 回填仍照常执行（不受归属校验影响）', () => {
  const r = createRequirement({ title: '归属校验测试3' });
  updateRequirement(r.id, {
    busy: { kind: 'bug-fix', runId: 'run-new', startedAt: Date.now() },
    bugs: [{ id: 'b1', recordId: 'rec1', title: 'T', status: 'fixing' }],
  });
  const onSettle = buildSystemTaskOnSettle(r, 'bug-fix', { bug: { id: 'b1' } });
  onSettle(true, { id: 'run-old', session_id: 's3' });
  const after = getRequirement(r.id);
  assert.equal(after.busy?.runId, 'run-new'); // busy 不该被清
  assert.equal(after.bugs[0].status, 'fixed'); // 但 bug 状态照常更新
  assert.equal(after.devSession, 's3'); // devSession 回填也照常
});

test('combineSupplements：无旧 payload + 有新 supplement → 单元素数组', () => {
  assert.deepEqual(combineSupplements(null, { text: 'a', files: [] }), [{ text: 'a', files: [] }]);
});

test('combineSupplements：旧 payload 是首次排队的单条 supplement → 累积成两条', () => {
  const old = { supplement: { text: 'a', files: [] } };
  assert.deepEqual(combineSupplements(old, { text: 'b', files: [] }), [
    { text: 'a', files: [] },
    { text: 'b', files: [] },
  ]);
});

test('combineSupplements：旧 payload 已是多条 supplements（上一轮合并过）→ 继续累积', () => {
  const old = { supplements: [{ text: 'a', files: [] }, { text: 'b', files: [] }] };
  assert.deepEqual(combineSupplements(old, { text: 'c', files: [] }), [
    { text: 'a', files: [] },
    { text: 'b', files: [] },
    { text: 'c', files: [] },
  ]);
});

test('combineSupplements：新 supplement 缺省 → 原样返回旧列表（不追加空位）', () => {
  const old = { supplements: [{ text: 'a', files: [] }] };
  assert.deepEqual(combineSupplements(old, undefined), [{ text: 'a', files: [] }]);
  assert.deepEqual(combineSupplements(null, undefined), []);
});

test('composeSupplementsForRevise：文本编号拼接，files 按 path 去重取并集', () => {
  const merged = composeSupplementsForRevise([
    { text: '第一条', files: [{ name: 'a.png', path: 'C:/a.png' }] },
    { text: '第二条', files: [{ name: 'a.png', path: 'C:/a.png' }, { name: 'b.png', path: 'C:/b.png' }] },
  ]);
  assert.equal(merged.text, '1. 第一条\n2. 第二条');
  assert.deepEqual(merged.files, [
    { name: 'a.png', path: 'C:/a.png' },
    { name: 'b.png', path: 'C:/b.png' },
  ]);
});

test('composeSupplementsForRevise：单条且无附件 → files 返回空数组', () => {
  const merged = composeSupplementsForRevise([{ text: '只有一条' }]);
  assert.equal(merged.text, '1. 只有一条');
  assert.deepEqual(merged.files, []);
});

test('setBugStatus：按 bugId 锁内替换状态，其余 bug 保持不变', () => {
  const r = createRequirement({ title: 'bug 状态测试' });
  updateRequirement(r.id, {
    bugs: [
      { id: 'b1', recordId: 'rec1', title: 'T1', status: 'pending' },
      { id: 'b2', recordId: 'rec2', title: 'T2', status: 'pending' },
    ],
  });
  setBugStatus(r.id, 'b1', 'fixing');
  const bugs = getRequirement(r.id).bugs;
  assert.equal(bugs.find((b) => b.id === 'b1').status, 'fixing');
  assert.equal(bugs.find((b) => b.id === 'b2').status, 'pending');
});

test('finalizeGuard：无文档/无开发工程/phase 不对拒绝；OK 返回开发工程清单', () => {
  const ok = finalizeGuard({
    phase: 'review',
    busy: null,
    devDoc: { versions: [{ v: 1 }] },
    projects: { frontend: { dir: 'D:/ui', dev: true }, backend: { dir: 'D:/s', dev: false } },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.devProjects.map((p) => p.dir), ['D:/ui']);
  assert.equal(
    finalizeGuard({
      phase: 'review',
      busy: null,
      devDoc: { versions: [] },
      projects: { frontend: { dir: 'D:/ui', dev: true }, backend: null },
    }).ok,
    false,
  );
  assert.equal(
    finalizeGuard({
      phase: 'review',
      busy: null,
      devDoc: { versions: [{ v: 1 }] },
      projects: { frontend: { dir: 'D:/ui', dev: false }, backend: null },
    }).ok,
    false,
  );
  assert.equal(
    finalizeGuard({
      phase: 'dev',
      busy: null,
      devDoc: { versions: [{ v: 1 }] },
      projects: { frontend: { dir: 'D:/ui', dev: true }, backend: null },
    }).ok,
    false,
  );
  assert.equal(
    finalizeGuard({
      phase: 'review',
      busy: { kind: 'docgen' },
      devDoc: { versions: [{ v: 1 }] },
      projects: { frontend: { dir: 'D:/ui', dev: true }, backend: null },
    }).ok,
    false,
  ); // 任务进行中不得定稿
});

test('resolveBaseBranch：有历史记录直接复用（不看当前分支）；无记录按当前分支；无记录且已在需求分支上直接复用', () => {
  // 有 prev：即便传入的 currentBranch 已经是需求分支自己（重试时的真实场景），也不采信，直接用记录值
  assert.deepEqual(
    resolveBaseBranch({ prevRecord: { baseBranch: 'main' }, currentBranch: 'req/x-y', reqBranch: 'req/x-y' }),
    { baseBranch: 'main' },
  );
  // 无 prev，正常场景：工作区在基线分支上
  assert.deepEqual(
    resolveBaseBranch({ prevRecord: null, currentBranch: 'main', reqBranch: 'req/x-y' }),
    { baseBranch: 'main' },
  );
  // 无 prev 且当前恰好已在需求分支（工作区已就绪）→ 直接以 reqBranch 自身作为 baseBranch
  assert.deepEqual(
    resolveBaseBranch({ prevRecord: null, currentBranch: 'req/x-y', reqBranch: 'req/x-y' }),
    { baseBranch: 'req/x-y' },
  );
  // 无 prev 且当前分支为空（非 git 仓库）或 'HEAD'（detached）→ 报错
  assert.deepEqual(resolveBaseBranch({ prevRecord: null, currentBranch: null, reqBranch: 'req/x-y' }), {
    error: 'not-git',
  });
  assert.deepEqual(resolveBaseBranch({ prevRecord: null, currentBranch: 'HEAD', reqBranch: 'req/x-y' }), {
    error: 'not-git',
  });
});

test('hasQueuedTasks：队列里有该 reqId 的待派发任务时为 true，否则为 false', () => {
  const reqId = 'req-hasQueuedTasks-测试';
  assert.equal(hasQueuedTasks(reqId), false);
  enqueueSystemTask(reqId, 'docgen', {});
  assert.equal(hasQueuedTasks(reqId), true);
  assert.equal(hasQueuedTasks('别的需求'), false); // 不误伤其他 reqId
});

test('enqueueSystemTask：非 docgen 同键（reqId+kind+discriminator）连续入队 → last-writer-wins，queuedTasks 只保留一条且是最新 payload', () => {
  const reqId = 'req-lww-测试';
  enqueueSystemTask(reqId, 'api-fix', { action: '新增', doc: { id: 'doc1', name: 'a.md' } });
  enqueueSystemTask(reqId, 'api-fix', { action: '更新', doc: { id: 'doc1', name: 'a.md', path: '新路径' } });
  const tasks = queuedTasks(reqId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].payload.action, '更新'); // 而不是被跳过、停留在「新增」那份旧 payload
  assert.equal(tasks[0].payload.doc.path, '新路径');
});

test('enqueueSystemTask：不同 discriminator（不同 doc.id）互不影响，两条并存', () => {
  const reqId = 'req-lww-并存测试';
  enqueueSystemTask(reqId, 'api-fix', { action: '新增', doc: { id: 'doc-a', name: 'a.md' } });
  enqueueSystemTask(reqId, 'api-fix', { action: '新增', doc: { id: 'doc-b', name: 'b.md' } });
  const tasks = queuedTasks(reqId);
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((t) => t.payload.doc.id).sort(),
    ['doc-a', 'doc-b'],
  );
});

test('queuedTasks：返回浅拷贝而非队列本体的引用（外部改动不影响内部队列）', () => {
  const reqId = 'req-queuedTasks-浅拷贝测试';
  enqueueSystemTask(reqId, 'api-fix', { action: '新增', doc: { id: 'doc-x' } });
  const tasks = queuedTasks(reqId);
  tasks.push({ kind: 'develop', payload: {} }); // 外部改动这个数组
  assert.equal(queuedTasks(reqId).length, 1); // 内部队列不受影响
});

test('dispatch：需求已离开评审期时排队中的 docgen 被作废（不推进版本），history 留痕', () => {
  const r = createRequirement({ title: 'docgen 作废测试' });
  updateRequirement(r.id, { phase: 'dev' }); // 模拟：已定稿进入开发期
  dispatch({ reqId: r.id, kind: 'docgen', payload: {} });
  const after = getRequirement(r.id);
  assert.equal(after.busy, null); // 没有真的跑 runDocgen（否则会同步写 busy）
  assert.equal(after.history.at(-1).event, 'docgen 作废：需求已离开评审期');
});

test('dispatch：需求已离开开发/测试期（如已归档）时，develop/api-fix/bug-fix 类系统任务被作废，history 留痕', () => {
  const r = createRequirement({ title: '系统任务作废测试' });
  updateRequirement(r.id, { phase: 'archived' }); // 模拟：归档 runGit 窗口内入队 / 旧标签页对已归档需求误触发
  dispatch({ reqId: r.id, kind: 'bug-fix', payload: { bug: { id: 'b1' } } });
  const after = getRequirement(r.id);
  assert.equal(after.busy, null); // 没有真的派发 dispatchSystemTask（否则会同步写 busy）
  assert.equal(after.history.at(-1).event, '系统任务 bug-fix 作废：需求已离开开发/测试期');
});

test('finalizeRequirement：队列里已有该需求待派发任务时拒绝定稿（防抢跑窗口）', async () => {
  const r = createRequirement({ title: '队列占用定稿测试' });
  updateRequirement(r.id, {
    devDoc: { versions: [{ v: 1 }] },
    projects: { frontend: { dir: 'D:/whatever-not-real', dev: true }, backend: null },
  });
  enqueueSystemTask(r.id, 'docgen', {});
  const res = await finalizeRequirement(r.id, {});
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.match(res.error, /排队/);
});

test('archiveRequirement：需求不存在 → 404', async () => {
  const res = await archiveRequirement('r_not_exist', '备注');
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
});

test('archiveRequirement：phase 不是 archiving（相邻推进不满足）→ 409', async () => {
  const r = createRequirement({ title: '归档阶段守卫测试' });
  const res = await archiveRequirement(r.id, '备注'); // 默认 review 期
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
});

test('archiveRequirement：busy 非空 → 409', async () => {
  const r = createRequirement({ title: '归档busy守卫测试' });
  updateRequirement(r.id, { phase: 'archiving', busy: { kind: 'develop', runId: 'x' } });
  const res = await archiveRequirement(r.id, '备注');
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
});

test('archiveRequirement：成功归档 —— 分支日志三态（有提交/空提交/读取失败）落档案 md，phase=archived', async () => {
  const r = createRequirement({ title: '归档成功测试' });
  updateRequirement(r.id, {
    phase: 'archiving',
    // 三条分支故意共用同一 branch 名（对齐 finalize 多工程定稿的真实产出：前后端各自仓库里建同名分支），
    // 只有 dir 不同——用来固化「按 dir 索引，不按 branch 索引」这条不变量，防止双工程档案互相覆盖回归。
    branches: [
      { dir: 'D:/fe', branch: 'req/x-shared', baseBranch: 'main' },
      { dir: 'D:/be-empty', branch: 'req/x-shared', baseBranch: 'main' },
      { dir: 'D:/be-fail', branch: 'req/x-shared', baseBranch: 'main' },
    ],
    bugs: [{ id: 'b1', recordId: 'rec1', title: 'T1', status: 'fixed' }],
  });
  const runGit = async (dir) => {
    if (dir === 'D:/fe') return { ok: true, out: 'abc1234 提交信息' };
    if (dir === 'D:/be-empty') return { ok: true, out: '' };
    return { ok: false, out: '', err: '模拟失败' };
  };
  const res = await archiveRequirement(r.id, '本次改动备注', { runGit });
  assert.equal(res.ok, true);

  const after = getRequirement(r.id);
  assert.equal(after.phase, 'archived');
  assert.ok(after.archive?.summary);
  assert.equal(after.archive.note, '本次改动备注');
  const summary = after.archive.summary;
  // 逐工程精确断言：每个 dir 的分支行后紧跟的是它自己的提交摘要，而不是被同名 branch 的另一条覆盖
  // （空输出占位串非空即真值，同真实提交一样落代码块；只有 null→失败 走无代码块的纯文案）
  assert.match(summary, /- D:\/fe 分支 req\/x-shared（基线 main）\n```\nabc1234 提交信息\n```/);
  assert.match(summary, /- D:\/be-empty 分支 req\/x-shared（基线 main）\n```\n（该分支相对基线无新提交）\n```/);
  assert.match(summary, /- D:\/be-fail 分支 req\/x-shared（基线 main）\n（无法读取提交摘要）/);

  const archivePath = reqDir(r.id, 'archive.md');
  assert.ok(fs.existsSync(archivePath));
  assert.equal(fs.readFileSync(archivePath, 'utf8'), after.archive.summary);
});

test('archiveRequirement：note 非字符串（如对象）→ fail-closed 归空串，不落盘 [object Object]', async () => {
  const r = createRequirement({ title: '归档note非法类型测试' });
  updateRequirement(r.id, { phase: 'archiving' }); // branches 留空数组，零 git 依赖
  const res = await archiveRequirement(r.id, { evil: 1 });
  assert.equal(res.ok, true);
  assert.equal(getRequirement(r.id).archive.note, '');
});

test('archiveRequirement：并发重复调用被 archiving 护栏挡住第二个（双击归档，对齐 finalizing 先例）', async () => {
  const r = createRequirement({ title: '双击归档测试' });
  updateRequirement(r.id, { phase: 'archiving', branches: [{ dir: 'D:/x', branch: 'req/x', baseBranch: 'main' }] });
  // 用受控 gate 制造异步间隙（比真实子进程调用更确定）：第一个调用的首个 await 落在 runGit 上，
  // 第二个调用在此期间同步命中 archiving.has(id)，应被立即挡回，不必等第一个跑完
  let resolveGate;
  const gate = new Promise((resolve) => { resolveGate = resolve; });
  const runGit = async () => { await gate; return { ok: true, out: '' }; };
  const p1 = archiveRequirement(r.id, '备注1', { runGit });
  const p2 = archiveRequirement(r.id, '备注2', { runGit });
  resolveGate();
  const [, res2] = await Promise.all([p1, p2]);
  assert.equal(res2.ok, false);
  assert.equal(res2.status, 409);
  assert.equal(res2.error, '归档正在进行中');
});

test('finalizeRequirement：并发重复调用被 finalizing 护栏挡住第二个（双击定稿）', async () => {
  const r = createRequirement({ title: '双击定稿测试' });
  updateRequirement(r.id, {
    devDoc: { versions: [{ v: 1 }] },
    projects: { frontend: { dir: 'D:/__not_a_real_repo__' + Date.now(), dev: true }, backend: null },
  });
  // force:true 跳过 isClean，第一个调用的首个 await 落在 currentBranch（真实子进程调用，有异步间隙）；
  // 第二个调用在这期间同步命中 finalizing.has(id)，应被立即挡回，不必等第一个跑完
  const p1 = finalizeRequirement(r.id, { force: true });
  const p2 = finalizeRequirement(r.id, { force: true });
  const [, res2] = await Promise.all([p1, p2]);
  assert.equal(res2.ok, false);
  assert.equal(res2.status, 409);
  assert.equal(res2.error, '定稿正在进行中');
});

test('dispatch：develop/api-fix 系统任务被废弃（已改为客户端会话驱动），history 留痕', () => {
  const r = createRequirement({ title: 'develop/api-fix 废弃测试' });
  updateRequirement(r.id, { phase: 'dev' });
  // 模拟旧版本残留或异常入队的 develop
  dispatch({ reqId: r.id, kind: 'develop', payload: {} });
  const after = getRequirement(r.id);
  // develop 被废弃：不写 busy，history 里留痕
  assert.equal(after.busy, null);
  assert.ok(after.history.at(-1).event.includes('废弃') || after.history.at(-1).event.includes('客户端'));
  // 同样验证 api-fix
  dispatch({ reqId: r.id, kind: 'api-fix', payload: {} });
  const after2 = getRequirement(r.id);
  assert.equal(after2.busy, null);
  assert.ok(after2.history.at(-1).event.includes('废弃') || after2.history.at(-1).event.includes('客户端'));
});

test('dispatch：develop/api-fix 即便 phase=dev 也被废弃', () => {
  const r = createRequirement({ title: 'cross-phase develop/api-fix 测试' });
  updateRequirement(r.id, { phase: 'dev' });
  // 即便在 dev phase，develop/api-fix 仍应被废弃而不派发
  dispatch({ reqId: r.id, kind: 'develop', payload: {} });
  const after = getRequirement(r.id);
  assert.equal(after.busy, null, 'develop 不应设 busy');
  assert.ok(
    after.history.at(-1).event.includes('废弃') || after.history.at(-1).event.includes('客户端'),
    'history 应记录废弃原因'
  );
});

test('parseFeatureTag：文档含§三标签时正确解析标签值', () => {
  // 标准格式：「本需求所属功能模块：标签值」
  const docWithTag = `## 一、说人话总结
本需求实现了一个用户管理模块。

## 二、详细设计
新增文件 users.js，提供用户增删改查接口。

## 三、功能模块标签
本需求所属功能模块：用户管理`;

  const parsed = parseFeatureTag(docWithTag);
  assert.equal(parsed, '用户管理', 'parseFeatureTag 应提取标签值');

  // 变体：使用「」书名号
  const docWithQuote = `## 三、功能模块标签
本需求所属功能模块：「用户管理」`;
  const parsed2 = parseFeatureTag(docWithQuote);
  assert.equal(parsed2, '用户管理', 'parseFeatureTag 应处理书名号');

  // 变体：英文冒号
  const docWithEnglishColon = `## 三、功能模块标签
本需求所属功能模块: 宝宝辅食`;
  const parsed3 = parseFeatureTag(docWithEnglishColon);
  assert.equal(parsed3, '宝宝辅食', 'parseFeatureTag 应处理英文冒号');
});

test('parseFeatureTag：文档无§三标签时返回 null', () => {
  // 完全缺少 §三 节
  const docWithoutTag = `## 一、说人话总结
补充了更多细节。

## 二、详细设计
文件调整如下...`;

  const parsed = parseFeatureTag(docWithoutTag);
  assert.equal(parsed, null, 'parseFeatureTag 应返回 null（无标签）');

  // 有 §三 但缺少「本需求所属功能模块」行
  const docMissingLine = `## 三、功能模块标签
暂无已有模块，请新建...`;

  const parsed2 = parseFeatureTag(docMissingLine);
  assert.equal(parsed2, null, 'parseFeatureTag 应返回 null（缺少关键行）');

  // 完全空文档
  const empty = '';
  const parsed3 = parseFeatureTag(empty);
  assert.equal(parsed3, null, 'parseFeatureTag 应返回 null（空文档）');
});

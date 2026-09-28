/**
 * task-actions 单测：待合并谓词 + merge/discard 编排。
 *
 * git 路径用临时目录里真建的 git 仓库跑（与 auto-dev/git.test.js 同款做法）：
 * 本模块的全部价值就是「git 结果如何映射成任务状态与文案」，把 git 桩掉等于把要验的东西验没了；
 * 而 store 只认 APP_DATA_DIR，仓库也全在 os.tmpdir() 下现建现删，不会碰到本仓的 git 状态。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'task-actions-test-'));
// store 的 DATA_DIR 在模块加载时定型，必须先于 import 设好，否则会写到本仓根目录的 tasks.json
process.env.APP_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.APP_DATA_DIR, { recursive: true });

const { isAwaitingMerge, isDiscardable, mergeTaskById, discardTaskById } = await import('./task-actions.js');
const { writeJson } = await import('../../store/index.js');
const { getTask } = await import('../../store/tasks.js');

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function sh(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** 建一个带 main 分支单提交的临时仓库 */
function makeRepo(name) {
  const repo = path.join(TMP, name);
  fs.mkdirSync(repo, { recursive: true });
  sh(['init', '-b', 'main'], repo);
  sh(['config', 'user.email', 'test@test.local'], repo);
  sh(['config', 'user.name', 'test'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'init'], repo);
  return repo;
}

/** 在 repo 的新分支上提交一个文件，然后切回 main（合并走原地 merge 路径，行为确定） */
function commitOnBranch(repo, branch, file, content) {
  sh(['checkout', '-b', branch], repo);
  fs.writeFileSync(path.join(repo, file), content);
  sh(['add', '-A'], repo);
  sh(['commit', '-m', `feat: ${file}`], repo);
  sh(['checkout', 'main'], repo);
}

let seq = 0;
/** 覆盖写入单条任务；history 必须存在（updateTask 会 push） */
function seedTask(patch = {}) {
  const now = new Date().toISOString();
  const task = {
    id: `t_test_${++seq}`,
    type: 'feature',
    title: '测试任务',
    detail: '',
    source: {},
    status: 'done',
    auto: true,
    merged: false,
    branch: 'task/x',
    baseBranch: 'main',
    createdAt: now,
    updatedAt: now,
    history: [],
    ...patch,
  };
  writeJson('tasks.json', [task]);
  return task;
}

// ---- isAwaitingMerge 谓词 ----

test('isAwaitingMerge：五要素齐全 → true', () => {
  assert.equal(
    isAwaitingMerge({ auto: true, status: 'done', merged: false, branch: 'task/x', baseBranch: 'main' }),
    true,
  );
});

test('isAwaitingMerge：任一要素缺失 / null 入参 → false', () => {
  const base = { auto: true, status: 'done', merged: false, branch: 'task/x', baseBranch: 'main' };
  assert.equal(isAwaitingMerge({ ...base, auto: false }), false, '非自动任务无分支可合');
  assert.equal(isAwaitingMerge({ ...base, status: 'developing' }), false, '未完成不能合');
  assert.equal(isAwaitingMerge({ ...base, merged: true }), false, '已合并不能重复合');
  assert.equal(isAwaitingMerge({ ...base, branch: '' }), false, '无分支');
  assert.equal(isAwaitingMerge({ ...base, baseBranch: '' }), false, '无基线分支');
  assert.equal(isAwaitingMerge(null), false, 'null 入参不得抛错');
});

test('isDiscardable：合并前后都可放弃（已合并走 revert，不是不能放弃）', () => {
  const base = { auto: true, status: 'done', merged: false, branch: 'task/x', baseBranch: 'main' };
  assert.equal(isDiscardable(base), true);
  assert.equal(isDiscardable({ ...base, baseBranch: '' }), true, '没记住合并目标不该妨碍删分支');
  assert.equal(isDiscardable({ ...base, merged: true }), true, '已合并改为走 revert，仍可放弃');
  assert.equal(isDiscardable({ ...base, branch: '' }), false, '无分支');
  assert.equal(isDiscardable({ ...base, status: 'developing' }), false, '执行中不能放弃');
  assert.equal(isDiscardable({ ...base, discarded: true }), false, '已放弃不得重复放弃');
  assert.equal(isDiscardable(null), false, 'null 入参不得抛错');
});

// ---- 校验分支（不碰 git）----

test('mergeTaskById：任务不存在 → 404', async () => {
  seedTask();
  const r = await mergeTaskById('t_no_such');
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
  assert.equal(r.error, '任务不存在');
  assert.equal(r.task, undefined);
});

test('discardTaskById：任务不存在 → 404', async () => {
  seedTask();
  const r = await discardTaskById('t_no_such');
  assert.equal(r.ok, false);
  assert.equal(r.code, 404);
  assert.equal(r.error, '任务不存在');
});

test('mergeTaskById：已合并 → 400，不触碰 git', async () => {
  const t = seedTask({ merged: true, repo: path.join(TMP, 'no-such-repo') });
  const r = await mergeTaskById(t.id);
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
  assert.equal(r.error, '任务不满足合并条件（须为自动完成且未合并）');
  assert.equal(r.task, undefined);
});

test('mergeTaskById：缺 baseBranch → 400（合并必须知道目标）', async () => {
  const t = seedTask({ baseBranch: '' });
  const r = await mergeTaskById(t.id);
  assert.equal(r.code, 400);
});

test('discardTaskById：非自动任务 → 400', async () => {
  const t = seedTask({ auto: false });
  const r = await discardTaskById(t.id);
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
  assert.equal(r.error, '任务不满足放弃条件（须为自动完成且未放弃）');
});

// ---- merge 的 git 路径 ----

test('mergeTaskById：合并成功 → 200，落 merged/mergedAt，history 记文案', async () => {
  const repo = makeRepo('merge-ok');
  commitOnBranch(repo, 'task/ok', 'b.txt', 'feature\n');
  const t = seedTask({ repo, branch: 'task/ok', baseBranch: 'main' });

  const r = await mergeTaskById(t.id);
  assert.equal(r.ok, true, `应合并成功，实际：${r.error || ''}`);
  assert.equal(r.code, 200);
  assert.equal(r.hookBypassed, false);
  assert.equal(r.task.merged, true);
  assert.ok(r.task.mergedAt, 'mergedAt 必须落值');
  assert.equal(r.task.mergeError, null);
  assert.equal(r.task.history.at(-1).event, '已合并 task/ok → main');
  assert.equal(fs.existsSync(path.join(repo, 'b.txt')), true, '合并内容应落到 main');
});

/** 造一个「两边都改了 a.txt」的真冲突仓库 */
function makeConflictRepo(name, branch) {
  const repo = makeRepo(name);
  sh(['checkout', '-b', branch], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-branch\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'fix: branch side'], repo);
  sh(['checkout', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-main\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'fix: main side'], repo);
  return repo;
}

// ⚠️ 涉及冲突的用例**必须传 resolver: null**。不传就会起一次真实 Claude 调用——
// 实测一条用例跑了 73 秒、烧了额度，还真去改了测试仓库里的文件。
test('mergeTaskById：冲突 + 关掉 AI 兜底 → 409，error 只带一层「合并冲突：」前缀且状态不变', async () => {
  const repo = makeConflictRepo('merge-conflict', 'task/c');
  const t = seedTask({ repo, branch: 'task/c', baseBranch: 'main' });

  const r = await mergeTaskById(t.id, { resolver: null });
  assert.equal(r.ok, false);
  assert.equal(r.code, 409);
  assert.match(r.error, /^合并冲突：/);
  assert.doesNotMatch(r.error, /合并失败：合并冲突/, '不得再套一层前缀');
  assert.equal(r.task.mergeError, r.error);
  assert.notEqual(r.task.merged, true);
  // history 文案就是 r.error 原文，同样不套前缀
  assert.equal(r.task.history.at(-1).event, r.error);
  assert.equal(getTask(t.id).mergeError, r.error, 'mergeError 必须落盘');
});

test('mergeTaskById：AI 解开冲突 → 200 且 caveats 提示复核，mergeError 保持 null', async () => {
  const repo = makeConflictRepo('merge-conflict-llm', 'task/cl');
  const t = seedTask({ repo, branch: 'task/cl', baseBranch: 'main' });
  const resolver = {
    resolveConflict: async ({ dir }) => {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'merged-by-ai\n');
      return { ok: true };
    },
  };

  const r = await mergeTaskById(t.id, { resolver });
  assert.equal(r.ok, true, `AI 解完应合并成功，实际：${r.error || ''}`);
  assert.equal(r.task.merged, true);
  assert.equal(r.task.mergeError, null, 'AI 救回来了就不该留失败标记');
  // 「AI 动过手」必须留痕：面板出黄字提醒而非红字失败
  assert.match(r.task.mergeWarning, /AI 解决/);
  assert.ok(r.caveats.some((c) => /建议复核/.test(c)));
  assert.match(r.task.history.at(-1).event, /已合并 task\/cl → main（.*AI 解决/);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'merged-by-ai\n');
});

test('mergeTaskById：AI 兜底失败 → 409，错误里同时保留 git 诊断与 AI 失败原因', async () => {
  const repo = makeConflictRepo('merge-conflict-llm-fail', 'task/cf');
  const t = seedTask({ repo, branch: 'task/cf', baseBranch: 'main' });
  const resolver = { resolveConflict: async () => ({ ok: false, error: '额度耗尽' }) };

  const r = await mergeTaskById(t.id, { resolver });
  assert.equal(r.ok, false);
  assert.equal(r.code, 409);
  assert.match(r.error, /^合并冲突：/, 'git 的原始诊断仍是第一信息源');
  assert.match(r.error, /AI 兜底亦失败/);
  assert.match(r.error, /额度耗尽/);
  assert.notEqual(r.task.merged, true);
});

test('mergeTaskById：干净合并不留任何警告（黄字提醒不该无中生有）', async () => {
  const repo = makeRepo('merge-no-caveat');
  commitOnBranch(repo, 'task/nc', 'nc.txt', 'x\n');
  const t = seedTask({ repo, branch: 'task/nc', baseBranch: 'main' });

  const r = await mergeTaskById(t.id, { resolver: null });
  assert.equal(r.ok, true);
  assert.equal(r.task.mergeWarning, null);
  assert.deepEqual(r.caveats, []);
});

test('mergeTaskById：本地改动未能自动恢复 → 合并算成功，但 stranded 警告必须进 mergeWarning', async () => {
  // 合并成功与「你的改动还没回来」可以同时发生，这条链路上最危险的就是把后半句吞掉。
  // 用未跟踪同名文件构造：stash -u 存下 b.txt，合并把 b.txt 建了出来，pop 无法恢复。
  const repo = makeRepo('merge-stranded');
  commitOnBranch(repo, 'task/sd', 'b.txt', 'from-branch\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'my-untracked-wip\n'); // main 上的未跟踪同名文件
  const t = seedTask({ repo, branch: 'task/sd', baseBranch: 'main' });

  const r = await mergeTaskById(t.id, { resolver: null });
  assert.equal(r.ok, true, `合并本身应成功，实际：${r.error || ''}`);
  assert.equal(r.task.merged, true);
  assert.equal(r.task.mergeError, null, '合并成功就不该报失败');
  assert.match(r.task.mergeWarning, /未能自动恢复/, '改动没回来必须让人看见');
  assert.match(r.task.history.at(-1).event, /⚠️/);
  assert.match(sh(['stash', 'list'], repo), /stash@\{0\}/, '改动必须还在 stash 里等人来取');
});

test('mergeTaskById：提交钩子拦截 → hookBypassed，history 追加钩子提示', async () => {
  const repo = makeRepo('merge-hook');
  commitOnBranch(repo, 'task/h', 'h.txt', 'x\n');
  // 无条件拒绝的 commit-msg 钩子（模拟目标仓库 husky 环境损坏）
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "husky failed"\nexit 1\n', {
    mode: 0o755,
  });
  const t = seedTask({ repo, branch: 'task/h', baseBranch: 'main' });

  const r = await mergeTaskById(t.id);
  assert.equal(r.ok, true, `钩子故障不该让合并不可用，实际：${r.error || ''}`);
  assert.equal(r.hookBypassed, true);
  assert.equal(r.task.history.at(-1).event, '已合并 task/h → main（提交钩子拦截，已跳过钩子校验完成合并）');
});

test('mergeTaskById：成功落 mergeCommit 与 autoMerged（放弃改动的锚点 + 面板文案依据）', async () => {
  const repo = makeRepo('merge-fields');
  commitOnBranch(repo, 'task/mf', 'mf.txt', 'x\n');
  const t = seedTask({ repo, branch: 'task/mf', baseBranch: 'main' });

  const r = await mergeTaskById(t.id, { auto: true });
  assert.equal(r.ok, true, `应合并成功，实际：${r.error || ''}`);
  assert.match(r.task.mergeCommit, /^[0-9a-f]{40}$/);
  assert.equal(r.task.autoMerged, true);
  assert.equal(getTask(t.id).mergeCommit, r.task.mergeCommit, 'mergeCommit 必须落盘');
});

test('mergeTaskById：人工合并 autoMerged 为 false', async () => {
  const repo = makeRepo('merge-manual');
  commitOnBranch(repo, 'task/mm', 'mm.txt', 'x\n');
  const t = seedTask({ repo, branch: 'task/mm', baseBranch: 'main' });

  const r = await mergeTaskById(t.id);
  assert.equal(r.ok, true);
  assert.equal(r.task.autoMerged, false);
});

// ---- discard 的 git 路径 ----

test('discardTaskById：删分支成功 → 200，任务置为已放弃（不要求 baseBranch）', async () => {
  const repo = makeRepo('discard-ok');
  commitOnBranch(repo, 'task/d', 'd.txt', 'x\n');
  const t = seedTask({ repo, branch: 'task/d', baseBranch: '' }); // 故意不给基线分支

  const r = await discardTaskById(t.id);
  assert.equal(r.ok, true, `应放弃成功，实际：${r.error || ''}`);
  assert.equal(r.code, 200);
  assert.equal(r.task.status, 'rejected');
  assert.equal(r.task.rejectedBy, 'owner');
  assert.equal(r.task.discarded, true);
  assert.ok(r.task.discardedAt);
  assert.equal(r.task.history.at(-1).event, '放弃改动，已删除分支 task/d');
  assert.equal(sh(['branch', '--list', 'task/d'], repo).trim(), '', '分支应已删除');
});

test('discardTaskById：删分支失败 → 409，任务状态一行不动（不留半放弃态）', async () => {
  const repo = makeRepo('discard-fail');
  // 停在任务分支上：git 拒绝删除当前 worktree 检出的分支
  sh(['checkout', '-b', 'task/f'], repo);
  const t = seedTask({ repo, branch: 'task/f' });

  const r = await discardTaskById(t.id);
  assert.equal(r.ok, false);
  assert.equal(r.code, 409);
  assert.ok(r.error, '必须原样上报 git 错误');
  assert.equal(r.task.status, 'done', '返回的仍是未改动的任务');
  const stored = getTask(t.id);
  assert.equal(stored.status, 'done', '落盘状态不得被改');
  assert.notEqual(stored.discarded, true);
  assert.notEqual(sh(['branch', '--list', 'task/f'], repo).trim(), '', '分支仍在');
});

test('discardTaskById：已合并任务走 revert，改动从基线分支撤销并落 revertedAt', async () => {
  const repo = makeRepo('discard-revert');
  commitOnBranch(repo, 'task/dr', 'dr.txt', 'x\n');
  const t = seedTask({ repo, branch: 'task/dr', baseBranch: 'main' });
  const m = await mergeTaskById(t.id, { auto: true });
  assert.equal(m.ok, true, `前置合并应成功，实际：${m.error || ''}`);
  assert.equal(fs.existsSync(path.join(repo, 'dr.txt')), true);

  const r = await discardTaskById(t.id);
  assert.equal(r.ok, true, `应撤销成功，实际：${r.error || ''}`);
  assert.equal(r.code, 200);
  assert.equal(r.task.status, 'rejected');
  assert.equal(r.task.discarded, true);
  assert.ok(r.task.revertedAt, 'revertedAt 必须落值（面板据此区分「撤销」与「删分支」文案）');
  assert.equal(r.task.revertedBy, 'git');
  assert.equal(fs.existsSync(path.join(repo, 'dr.txt')), false, '合并进来的文件应被撤销');
  assert.equal(sh(['branch', '--list', 'task/dr'], repo).trim(), '', '撤销后任务分支应一并删除');
});

test('discardTaskById：已合并但撤销失败 → 409，任务状态一行不动', async () => {
  const repo = makeRepo('discard-revert-fail');
  commitOnBranch(repo, 'task/drf', 'drf.txt', 'x\n');
  // 基线分支指向一个不存在的分支 → revertMergeCommit 在 branchExists 处确定性早退。
  // ⚠️ 刻意不用「假 sha 触发 revert 冲突」来造失败：那条路会走进真实的 LLM 兜底，
  // 在无 Claude 凭证的测试环境里要么抛错要么挂满 5 分钟超时，把单测拖垮。
  const t = seedTask({ repo, branch: 'task/drf', baseBranch: 'no-such-branch', merged: true, mergeCommit: 'a'.repeat(40) });

  const r = await discardTaskById(t.id);
  assert.equal(r.ok, false);
  assert.equal(r.code, 409);
  assert.match(r.error, /基线分支不存在/);
  const stored = getTask(t.id);
  assert.equal(stored.status, 'done', '落盘状态不得被改（绝不留「已放弃但改动还在」的半放弃态）');
  assert.notEqual(stored.discarded, true);
  assert.notEqual(sh(['branch', '--list', 'task/drf'], repo).trim(), '', '撤销没成功，分支不得被删');
});

test('discardTaskById：未合并任务仍走删分支路径（行为不变）', async () => {
  const repo = makeRepo('discard-unmerged');
  commitOnBranch(repo, 'task/du', 'du.txt', 'x\n');
  const t = seedTask({ repo, branch: 'task/du', baseBranch: 'main', merged: false });

  const r = await discardTaskById(t.id);
  assert.equal(r.ok, true, `应放弃成功，实际：${r.error || ''}`);
  assert.equal(r.task.revertedAt, undefined, '没合并过就没有「撤销」这回事');
  assert.equal(r.task.history.at(-1).event, '放弃改动，已删除分支 task/du');
});

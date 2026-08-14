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

test('isDiscardable：与合并同源但不要求 baseBranch（分支还在就删得掉）', () => {
  const base = { auto: true, status: 'done', merged: false, branch: 'task/x', baseBranch: 'main' };
  assert.equal(isDiscardable(base), true);
  assert.equal(isDiscardable({ ...base, baseBranch: '' }), true, '没记住合并目标不该妨碍放弃');
  assert.equal(isDiscardable({ ...base, branch: '' }), false, '无分支可删');
  assert.equal(isDiscardable({ ...base, merged: true }), false, '已合并不该再删分支');
  assert.equal(isDiscardable({ ...base, status: 'developing' }), false, '执行中不能删');
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
  assert.equal(r.error, '任务不满足放弃条件（须为自动完成且未合并）');
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

test('mergeTaskById：冲突 → 409，error 只带一层「合并冲突：」前缀且状态不变', async () => {
  const repo = makeRepo('merge-conflict');
  sh(['checkout', '-b', 'task/c'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-branch\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'fix: branch side'], repo);
  sh(['checkout', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-main\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'fix: main side'], repo);
  const t = seedTask({ repo, branch: 'task/c', baseBranch: 'main' });

  const r = await mergeTaskById(t.id);
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

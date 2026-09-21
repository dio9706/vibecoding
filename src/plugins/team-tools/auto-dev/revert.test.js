/**
 * revertMergeCommit 真实 git 仓库单测。
 * LLM 兜底经 opts.llmRevert 注入桩（真调 Claude 既慢又不确定），git 路径一律真跑。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { revertMergeCommit } from './revert.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-dev-revert-test-'));

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

/** 建仓 + 在任务分支上改一个文件 + 合并回 main，返回 { repo, mergeCommit } */
function makeMergedRepo(name, { file = 'b.txt', content = 'feature\n' } = {}) {
  const repo = path.join(TMP, name);
  fs.mkdirSync(repo, { recursive: true });
  sh(['init', '-b', 'main'], repo);
  sh(['config', 'user.email', 'test@test.local'], repo);
  sh(['config', 'user.name', 'test'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'init'], repo);

  sh(['checkout', '-b', 'task/x'], repo);
  fs.writeFileSync(path.join(repo, file), content);
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'feat: task change'], repo);
  sh(['checkout', 'main'], repo);
  sh(['merge', '--no-ff', 'task/x', '-m', 'chore: merge task/x into main'], repo);
  return { repo, mergeCommit: sh(['rev-parse', 'HEAD'], repo).trim() };
}

const TASK = { id: 't_1', title: '测试任务', detail: '描述', branch: 'task/x', baseBranch: 'main' };

test('revertMergeCommit：git revert 成功 → by:git，新增文件被删除，主工作区停在 main', async () => {
  const { repo, mergeCommit } = makeMergedRepo('revert-ok');
  assert.equal(fs.existsSync(path.join(repo, 'b.txt')), true);

  const r = await revertMergeCommit(repo, { task: TASK, mergeCommit });
  assert.equal(r.ok, true, `应撤销成功，实际：${r.error || ''}`);
  assert.equal(r.by, 'git');
  assert.equal(fs.existsSync(path.join(repo, 'b.txt')), false, '合并带进来的文件应被撤销');
  assert.equal(sh(['status', '--porcelain'], repo).trim(), '', '不得留半 revert 态');
});

test('revertMergeCommit：主工作区在其他分支 → 经临时 worktree 撤销，主工作区不受影响', async () => {
  const { repo, mergeCommit } = makeMergedRepo('revert-worktree');
  sh(['checkout', '-b', 'feat/other'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'wip\n'); // 主工作区脏

  const r = await revertMergeCommit(repo, { task: TASK, mergeCommit });
  assert.equal(r.ok, true, `应撤销成功，实际：${r.error || ''}`);
  assert.equal(sh(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim(), 'feat/other', '主工作区分支不得被切');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'wip\n');
  // main 上 b.txt 已被撤销
  assert.equal(sh(['ls-tree', '--name-only', 'main'], repo).includes('b.txt'), false);
});

test('revertMergeCommit：revert 冲突 → abort 后转 LLM，提交成功返回 by:llm', async () => {
  const { repo, mergeCommit } = makeMergedRepo('revert-conflict', { file: 'a.txt', content: 'from-task\n' });
  // 合并后又有新提交改了同一文件 → revert 必冲突
  fs.writeFileSync(path.join(repo, 'a.txt'), 'later-change\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'feat: later'], repo);

  let called = null;
  const r = await revertMergeCommit(repo, { task: TASK, mergeCommit }, {
    llmRevert: async ({ dir }) => {
      called = dir;
      // 模拟 AI 撤销：把文件改回合并前的内容
      fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\n');
      return { ok: true, log: 'done' };
    },
  });
  assert.equal(r.ok, true, `LLM 兜底应成功，实际：${r.error || ''}`);
  assert.equal(r.by, 'llm');
  assert.ok(called, 'llmRevert 必须被调用');
  assert.equal(sh(['status', '--porcelain'], repo).trim(), '', 'revert --abort + commitAll 后应为净态');
  assert.match(sh(['log', '-1', '--pretty=%s'], repo), /^revert: /, '兜底提交必须走 conventional 消息');
});

test('revertMergeCommit：LLM 没产生任何改动 → 失败（绝不谎报撤销成功）', async () => {
  const { repo, mergeCommit } = makeMergedRepo('revert-noop', { file: 'a.txt', content: 'from-task\n' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'later-change\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'feat: later'], repo);

  const r = await revertMergeCommit(repo, { task: TASK, mergeCommit }, {
    llmRevert: async () => ({ ok: true, log: '我看了一下，不需要改' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /未产生|无改动/);
});

test('revertMergeCommit：LLM 调用失败 → 原样上报错误', async () => {
  const { repo, mergeCommit } = makeMergedRepo('revert-llm-fail', { file: 'a.txt', content: 'from-task\n' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'later-change\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'feat: later'], repo);

  const r = await revertMergeCommit(repo, { task: TASK, mergeCommit }, {
    llmRevert: async () => ({ ok: false, error: '额度耗尽' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /额度耗尽/);
});

test('revertMergeCommit：无 mergeCommit 锚点 → 直接走 LLM 兜底', async () => {
  const { repo } = makeMergedRepo('revert-no-sha');
  let called = false;
  const r = await revertMergeCommit(repo, { task: TASK, mergeCommit: '' }, {
    llmRevert: async ({ dir }) => {
      called = true;
      fs.rmSync(path.join(dir, 'b.txt'));
      return { ok: true };
    },
  });
  assert.equal(called, true, '没有锚点时不该尝试 git revert，直接交给 AI');
  assert.equal(r.ok, true);
  assert.equal(r.by, 'llm');
});

test('revertMergeCommit：任务没记基线分支 → 400 级错误，不碰 git', async () => {
  const { repo, mergeCommit } = makeMergedRepo('revert-no-base');
  const r = await revertMergeCommit(repo, { task: { ...TASK, baseBranch: '' }, mergeCommit });
  assert.equal(r.ok, false);
  assert.match(r.error, /基线分支/);
});

test('revertMergeCommit：revert 失败且工作区脏 → 停手报错，绝不让 LLM 在脏工作区里改码', async () => {
  const { repo, mergeCommit } = makeMergedRepo('revert-dirty-guard', { file: 'a.txt', content: 'from-task\n' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'later-change\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'feat: later'], repo);
  // 用户的无关 WIP：已暂存，足以让 git revert 预检拒绝
  fs.writeFileSync(path.join(repo, 'secret-wip.txt'), 'my precious\n');
  sh(['add', 'secret-wip.txt'], repo);

  let called = false;
  const r = await revertMergeCommit(repo, { task: TASK, mergeCommit }, {
    llmRevert: async () => {
      called = true;
      return { ok: true };
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /未提交改动/);
  assert.equal(called, false, '脏工作区下绝不能起 LLM');
  // 用户的 WIP 原样还在，没被卷进任何提交
  assert.equal(fs.readFileSync(path.join(repo, 'secret-wip.txt'), 'utf8').replace(/\r\n/g, '\n'), 'my precious\n');
  assert.match(sh(['status', '--porcelain'], repo), /secret-wip\.txt/);
});

test('revertMergeCommit：脏工作区下防谎报闸不被顶开（AI 没改也不会因用户脏文件而报成功）', async () => {
  const { repo, mergeCommit } = makeMergedRepo('revert-noop-dirty', { file: 'a.txt', content: 'from-task\n' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'later-change\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'feat: later'], repo);
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'wip\n');
  sh(['add', 'unrelated.txt'], repo);

  const r = await revertMergeCommit(repo, { task: TASK, mergeCommit }, {
    llmRevert: async () => ({ ok: true, log: '我看了一下，不需要改' }),
  });
  assert.equal(r.ok, false, '绝不能因为捞到用户的无关文件就报撤销成功');
  // 撤销没成功 → 主干上那次改动必须还在
  assert.match(sh(['log', '-1', '--pretty=%s'], repo), /feat: later/, '不得产生任何 revert 提交');
});

/**
 * mergeBranch / isClean / ensureAutoWorktree / commitResidue 真实 git 仓库单测（临时目录建仓，串行执行）。
 * 覆盖：合并成功、冲突回滚（不留半合并态）、原地 merge 路径的脏工作区语义（无关脏文件放行 / 会被覆盖则拒绝）、
 *       主工作区在其他分支时经临时 worktree 合并（不触动主工作区脏文件）、
 *       分支不存在、worktree 首建/复用/归属校验/stale 重建、残留自愈净态/脏态。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mergeBranch, mergeMessage, isClean, currentBranch, ensureBranch, commitAll, autoWorktreeDir, worktreeAddArgs, checkoutNewFromBaseArgs, ensureAutoWorktree, commitResidue, deleteBranchArgs } from './git.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-dev-git-test-'));

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
  fs.mkdirSync(repo);
  sh(['init', '-b', 'main'], repo);
  sh(['config', 'user.email', 'test@test.local'], repo);
  sh(['config', 'user.name', 'test'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\n');
  sh(['add', '-A'], repo);
  sh(['commit', '-m', 'init'], repo);
  return repo;
}

test('mergeBranch：无冲突合并成功，停在目标分支', async () => {
  const repo = makeRepo('ok');
  await ensureBranch(repo, 'auto/t1');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'feature\n');
  await commitAll(repo, 'feat: b');
  await ensureBranch(repo, 'main');
  const r = await mergeBranch(repo, 'auto/t1', 'main');
  assert.equal(r.ok, true);
  assert.equal(await currentBranch(repo), 'main');
  assert.equal(fs.existsSync(path.join(repo, 'b.txt')), true);
});

test('mergeBranch：冲突 → abort 回滚，工作区干净、分支还原', async () => {
  const repo = makeRepo('conflict');
  await ensureBranch(repo, 'auto/t2');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-branch\n');
  await commitAll(repo, 'fix: branch side');
  await ensureBranch(repo, 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-main\n');
  await commitAll(repo, 'fix: main side');
  const r = await mergeBranch(repo, 'auto/t2', 'main');
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.equal(await isClean(repo), true); // 无半合并残留
  assert.equal(await currentBranch(repo), 'main');
  // autocrlf 环境下 checkout 可能重写为 CRLF，归一后比较
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'from-main\n');
});

// 路径 A 的脏工作区语义：交给 git 判定，不做 isClean 预检（见 git.js mergeBranch 注释）——
// 与合并无关的脏文件不该阻止合并（预检会误伤正常开发状态），真会被覆盖的才拒绝。
test('mergeBranch：与合并无关的脏文件不阻止合并，脏改动保持原样（路径 A）', async () => {
  const repo = makeRepo('dirty-unrelated');
  await ensureBranch(repo, 'auto/t3');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'x\n'); // 合并只带入 c.txt
  await commitAll(repo, 'feat: c');
  await ensureBranch(repo, 'main'); // 已在目标分支
  fs.writeFileSync(path.join(repo, 'a.txt'), 'uncommitted\n'); // 弄脏一个与合并无关的文件
  const r = await mergeBranch(repo, 'auto/t3', 'main');
  assert.equal(r.ok, true, `无关脏文件不应阻止合并，实际错误：${r.error || ''}`);
  assert.equal(fs.existsSync(path.join(repo, 'c.txt')), true); // 合并内容已落地
  // 脏改动既未被提交进合并，也未被 git 覆盖
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'uncommitted\n');
  assert.equal(await isClean(repo), false);
});

test('mergeBranch：脏文件会被合并覆盖时 git 拒绝，改动不丢（路径 A）', async () => {
  const repo = makeRepo('dirty-overwrite');
  await ensureBranch(repo, 'auto/t4');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-branch\n'); // 合并会改写 a.txt
  await commitAll(repo, 'feat: touch a');
  await ensureBranch(repo, 'main'); // 已在目标分支
  fs.writeFileSync(path.join(repo, 'a.txt'), 'my-wip\n'); // 恰好弄脏同一个文件
  const r = await mergeBranch(repo, 'auto/t4', 'main');
  assert.equal(r.ok, false);
  // 未提交的改动仍在，没有被合并覆盖，也没留半合并态
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'my-wip\n');
  assert.equal(await currentBranch(repo), 'main');
});

test('mergeBranch：主工作区在其他分支且有脏文件 → 临时 worktree 合并成功，主工作区不受影响（路径 B）', async () => {
  const repo = makeRepo('dirty-other-branch');
  // 建两条分支：v5.5.2 是合并目标，auto/t_feature 是源
  await ensureBranch(repo, 'v5.5.2');
  await ensureBranch(repo, 'auto/t_feature');
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'new feature\n');
  await commitAll(repo, 'feat: feature');
  // 切回 v5.5.2（合并目标），再切到另一工作分支 feat/other
  await ensureBranch(repo, 'v5.5.2');
  await ensureBranch(repo, 'feat/other');
  // 弄脏：主工作区当前在 feat/other 且有未提交改动
  fs.writeFileSync(path.join(repo, 'a.txt'), 'wip changes\n');
  assert.equal(await isClean(repo), false);

  // 执行合并：source=auto/t_feature → target=v5.5.2，主工作区在 feat/other
  const r = await mergeBranch(repo, 'auto/t_feature', 'v5.5.2');
  assert.equal(r.ok, true, `合并应成功，实际错误：${r.error || ''}`);

  // 主工作区仍在 feat/other，脏文件仍在
  assert.equal(await currentBranch(repo), 'feat/other');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'wip changes\n');
  assert.equal(await isClean(repo), false); // 脏文件未被动

  // v5.5.2 分支上已有合并结果（通过 log 验证）
  const { execFileSync: sh2 } = await import('node:child_process');
  const log = sh2('git', ['-C', repo, 'log', 'v5.5.2', '--oneline', '-3'], { encoding: 'utf8' });
  assert.match(log, /merge auto\/t_feature into v5\.5\.2/);
  assert.match(log, /feat: feature/);
});

// ---- 提交钩子（husky + commitlint）场景 ----
// 真实事故：合并消息曾是 `merge <source> into <target>`，既不符合 conventional 的 `type: subject`，
// 也不匹配 commitlint 默认放行 merge 的 `Merge branch '...'` 格式 → commit-msg 钩子拦截
// （报 subject-empty/type-empty，易被误读成「消息为空」）→ git 停在半合并态并退出非 0。
// 注：只有目标分支恰在主工作区时才触发（路径 A）；husky 的 core.hooksPath 是相对路径，
// 新建 worktree 里没有 .husky/_ 故路径 B 侥幸未暴露此 bug。

/** 装一个模拟 commitlint 的 commit-msg 钩子：只放行 conventional 格式与 git 原生 Merge 消息 */
function installConventionalHook(repo) {
  const hook = path.join(repo, '.git', 'hooks', 'commit-msg');
  fs.writeFileSync(
    hook,
    `#!/bin/sh
head=$(sed -n 1p "$1")
case "$head" in
  "Merge branch"*|"Merge remote-tracking branch"*|"Merge pull request"*) exit 0 ;;
esac
if [ \${#head} -gt 100 ]; then echo "header must not be longer than 100 [header-max-length]"; exit 1; fi
printf '%s' "$head" | grep -Eq '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert|wip)(\\([^)]*\\))?!?: .+$' && exit 0
echo "subject may not be empty [subject-empty]"
echo "type may not be empty [type-empty]"
exit 1
`,
    { mode: 0o755 },
  );
}

/** 装一个无条件拒绝的 commit-msg 钩子：模拟 pnpm/node_modules 缺失、lint 失败等环境问题 */
function installRejectAllHook(repo) {
  const hook = path.join(repo, '.git', 'hooks', 'commit-msg');
  fs.writeFileSync(hook, '#!/bin/sh\necho "husky - commit-msg script failed (code 127)"\nexit 1\n', { mode: 0o755 });
}

test('mergeMessage：符合 conventional 规范；分支名超长时截断且 subject 不空', () => {
  assert.equal(mergeMessage('auto/t_abc', 'v5.6.0'), 'chore: merge auto/t_abc into v5.6.0');
  const long = mergeMessage('auto/' + 'x'.repeat(200), 'v5.6.0');
  assert.ok(long.length <= 72, `header 应控长，实际 ${long.length}`);
  assert.match(long, /^chore: merge \S/); // 有 type 且 subject 非空
});

test('mergeBranch：仓库装了 commitlint 式 commit-msg 钩子 → 合并消息合规，不被拦截（路径 A）', async () => {
  const repo = makeRepo('hook-conventional');
  await ensureBranch(repo, 'auto/t_hook');
  fs.writeFileSync(path.join(repo, 'h.txt'), 'x\n');
  await commitAll(repo, 'feat: h');
  await ensureBranch(repo, 'main'); // 目标分支在主工作区 → 路径 A，钩子生效
  installConventionalHook(repo);

  const r = await mergeBranch(repo, 'auto/t_hook', 'main');
  assert.equal(r.ok, true, `合并应成功，实际错误：${r.error || ''}`);
  assert.notEqual(r.hookBypassed, true, '消息合规时不该绕过钩子');
  assert.equal(fs.existsSync(path.join(repo, 'h.txt')), true);
  assert.equal(await isClean(repo), true); // 无半合并残留
});

test('mergeBranch：钩子无条件拒绝（环境问题）→ --no-verify 兜底完成合并并标记 hookBypassed', async () => {
  const repo = makeRepo('hook-reject-all');
  await ensureBranch(repo, 'auto/t_reject');
  fs.writeFileSync(path.join(repo, 'r.txt'), 'x\n');
  await commitAll(repo, 'feat: r');
  await ensureBranch(repo, 'main');
  installRejectAllHook(repo);

  const r = await mergeBranch(repo, 'auto/t_reject', 'main');
  assert.equal(r.ok, true, `钩子故障不应让合并功能不可用，实际错误：${r.error || ''}`);
  assert.equal(r.hookBypassed, true);
  assert.equal(fs.existsSync(path.join(repo, 'r.txt')), true);
  assert.equal(await isClean(repo), true); // merge commit 已落地，无半合并残留
});

test('mergeBranch：真冲突时钩子兜底绝不强行提交，仍回滚并报 conflict', async () => {
  const repo = makeRepo('hook-conflict');
  await ensureBranch(repo, 'auto/t_c');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-branch\n');
  await commitAll(repo, 'fix: branch side');
  await ensureBranch(repo, 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-main\n');
  await commitAll(repo, 'fix: main side');
  installRejectAllHook(repo); // 钩子也拒绝：兜底路径与冲突路径必须严格区分

  const r = await mergeBranch(repo, 'auto/t_c', 'main');
  assert.equal(r.ok, false, '冲突不得被 --no-verify 兜底掩盖');
  assert.equal(r.conflict, true);
  assert.equal(await isClean(repo), true); // 已 abort，无半合并残留
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'from-main\n');
});

test('mergeBranch：非冲突失败（脏文件会被覆盖）不再误报 conflict', async () => {
  const repo = makeRepo('not-conflict');
  await ensureBranch(repo, 'auto/t_nc');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-branch\n');
  await commitAll(repo, 'feat: touch a');
  await ensureBranch(repo, 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'my-wip\n');
  const r = await mergeBranch(repo, 'auto/t_nc', 'main');
  assert.equal(r.ok, false);
  assert.notEqual(r.conflict, true, '被 git 预检拒绝不是内容冲突，错误分类应区分');
  assert.match(r.error, /would be overwritten|local changes/i); // 原始诊断信息可见
});

test('mergeBranch：源/目标分支不存在时报错', async () => {
  const repo = makeRepo('nobranch');
  const r1 = await mergeBranch(repo, 'auto/ghost', 'main');
  assert.equal(r1.ok, false);
  assert.match(r1.error, /auto\/ghost/);
  const r2 = await mergeBranch(repo, 'main', 'ghost-target');
  assert.equal(r2.ok, false);
  assert.match(r2.error, /ghost-target/);
});

test('isClean：干净仓库 true，改动后 false', async () => {
  const repo = makeRepo('clean');
  assert.equal(await isClean(repo), true);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
  assert.equal(await isClean(repo), false);
});

test('autoWorktreeDir：项目路径 + .auto 后缀，容忍尾部斜杠', () => {
  assert.equal(autoWorktreeDir('C:/work/my-app'), 'C:/work/my-app.auto');
  assert.equal(autoWorktreeDir('C:/work/my-app/'), 'C:/work/my-app.auto');
  assert.equal(autoWorktreeDir('C:\\work\\my-app\\'), 'C:\\work\\my-app.auto');
});

test('worktreeAddArgs / checkoutNewFromBaseArgs 参数拼装', () => {
  assert.deepEqual(worktreeAddArgs('C:/r', 'C:/r.auto'), ['-C', 'C:/r', 'worktree', 'add', '--detach', 'C:/r.auto']);
  assert.deepEqual(checkoutNewFromBaseArgs('C:/r.auto', 'auto/t1', 'main'), ['-C', 'C:/r.auto', 'checkout', '-B', 'auto/t1', 'main']);
});

// ---- ensureAutoWorktree 真实仓库用例 ----

test('ensureAutoWorktree：首次建立 created:true，目录可用', async () => {
  const repo = makeRepo('wt-create');
  const dir = autoWorktreeDir(repo);
  const r = await ensureAutoWorktree(repo);
  assert.equal(r.ok, true);
  assert.equal(r.dir, dir);
  assert.equal(r.created, true);
  // worktree 目录真实存在且为有效 git 工作区
  assert.equal(fs.existsSync(dir), true);
});

test('ensureAutoWorktree：二次调用复用（无 created 字段）', async () => {
  const repo = makeRepo('wt-reuse');
  await ensureAutoWorktree(repo); // 首建
  const r2 = await ensureAutoWorktree(repo); // 复用
  assert.equal(r2.ok, true);
  assert.equal(r2.created, undefined); // 复用路径不置 created
});

test('ensureAutoWorktree：目录预存且属于无关仓库 → ok:false，目录内文件仍在', async () => {
  const repo = makeRepo('wt-alien');
  const dir = autoWorktreeDir(repo);
  // 预建一个普通目录（内建独立 git 仓库，使 rev-parse --is-inside-work-tree 返回 ok）
  fs.mkdirSync(dir, { recursive: true });
  sh(['init', '-b', 'main'], dir);
  sh(['config', 'user.email', 'test@test.local'], dir);
  sh(['config', 'user.name', 'test'], dir);
  const sentinel = path.join(dir, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'keep me\n');
  sh(['add', '-A'], dir);
  sh(['commit', '-m', 'alien init'], dir);

  const r = await ensureAutoWorktree(repo);
  assert.equal(r.ok, false);
  assert.match(r.error, /不是本仓库的 worktree/);
  // 目录内容绝不被删除
  assert.equal(fs.existsSync(sentinel), true);
});

// ---- commitResidue 真实仓库用例 ----

test('commitResidue：净态工作区 → {committed:false, dirty:false}', async () => {
  const repo = makeRepo('residue-clean');
  const dir = autoWorktreeDir(repo);
  await ensureAutoWorktree(repo);
  const r = await commitResidue(dir);
  assert.equal(r.committed, false);
  assert.equal(r.dirty, false);
});

test('commitResidue：脏态 → {committed:true, dirty:true}，提交后 porcelain 为空', async () => {
  const repo = makeRepo('residue-dirty');
  const wt = await ensureAutoWorktree(repo);
  const dir = wt.dir;
  // 在 worktree 目录里写脏文件
  fs.writeFileSync(path.join(dir, 'residue.txt'), 'leftover\n');
  const r = await commitResidue(dir);
  assert.equal(r.dirty, true);
  assert.equal(r.committed, true);
  // 提交后工作区应为净态
  const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(status.trim(), '');
});

test('ensureAutoWorktree：stale worktree（目录手动删除后）→ prune+add 重建，返回 created:true', async () => {
  const repo = makeRepo('wt-stale');
  // 首建
  const first = await ensureAutoWorktree(repo);
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  // 模拟 stale：手动删除 .auto 目录，worktree 记录尚存（git 认为是 stale）
  fs.rmSync(first.dir, { recursive: true, force: true });
  // 重建：prune 清除 stale 记录，再 add 重建
  const second = await ensureAutoWorktree(repo);
  assert.equal(second.ok, true);
  assert.equal(second.created, true); // 重建路径，created 应为 true
  assert.equal(fs.existsSync(second.dir), true); // 目录真实重建
});

test('deleteBranchArgs：-C repo branch -D <branch>（强删，任务分支未合并也要能删）', () => {
  assert.deepEqual(deleteBranchArgs('C:\\proj', 'task/t_abc-bug'), [
    '-C', 'C:\\proj', 'branch', '-D', 'task/t_abc-bug',
  ]);
});

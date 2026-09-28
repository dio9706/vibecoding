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
import { mergeBranch, mergeMessage, isClean, currentBranch, ensureBranch, commitAll, autoWorktreeDir, worktreeAddArgs, checkoutNewFromBaseArgs, ensureAutoWorktree, commitResidue, deleteBranchArgs, withBranchWorktree, reqWorktreeDir, ensureReqWorktree } from './git.js';

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

test('mergeBranch：脏文件会被合并覆盖 → 自动 stash 后合并成功，脏改动完好回归（路径 A）', async () => {
  const repo = makeRepo('dirty-overwrite');
  // git 的合并预检是**文件级**的（碰同一文件就拒绝），而 stash pop 是 3-way merge（hunk 级）。
  // 「文件级重叠、hunk 级不重叠」因此正是 stash 能干净救回来的主力场景 —— 维护者在文件尾部
  // 写自己的活、自动开发改文件头部，这在日常开发里极常见。
  fs.writeFileSync(path.join(repo, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
  await commitAll(repo, 'chore: 多行基线');
  await ensureBranch(repo, 'auto/t4');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'BRANCH\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n'); // 分支改文件头
  await commitAll(repo, 'feat: 改第一行');
  await ensureBranch(repo, 'main'); // 已在目标分支
  fs.writeFileSync(path.join(repo, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nWIP\n'); // 维护者改文件尾，未提交

  const r = await mergeBranch(repo, 'auto/t4', 'main');

  assert.equal(r.ok, true, `应自动 stash 后合并成功，实际错误：${r.error || ''}`);
  assert.equal(r.stashed, true, '必须标记本次动用了 stash');
  assert.notEqual(r.stashStranded, true, 'hunk 不重叠时必须能干净 pop 回来');
  assert.equal(await currentBranch(repo), 'main');
  assert.match(r.mergeCommit, /^[0-9a-f]{40}$/);

  // 合并结果与维护者的 wip 同时在场
  const content = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(content, /^BRANCH\n/, '合并内容必须落地');
  assert.match(content, /WIP\n$/, '维护者未提交的改动必须原样回来');
  assert.equal(await isClean(repo), false, '用户改动必须留在工作区，不得被提交进合并');
  // 合并提交里只能有分支的改动，不能夹带维护者的 WIP
  assert.doesNotMatch(sh(['show', r.mergeCommit], repo), /\+.*WIP/);
  // stash 栈必须清空——成功回归后不该留垃圾条目
  assert.equal(sh(['stash', 'list'], repo).trim(), '');
});

test('mergeBranch：未跟踪文件会被合并覆盖 → 无法自动恢复时报 stranded，文件绝不丢', async () => {
  // stash -u 存下的未跟踪文件，pop 时若目标已被合并创建出来，git 会整体拒绝恢复且不产生
  // 冲突标记（没有 unmerged 路径，LLM 也无从下手）。此时唯一正确的行为是保住 stash 并明说。
  const repo = makeRepo('dirty-untracked');
  await ensureBranch(repo, 'auto/t_ut');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'from-branch\n'); // 合并将新建 b.txt
  await commitAll(repo, 'feat: add b');
  await ensureBranch(repo, 'main');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'my-untracked-wip\n'); // 同名未跟踪文件

  const r = await mergeBranch(repo, 'auto/t_ut', 'main');
  assert.equal(r.ok, true, '合并本身应完成');
  assert.equal(r.stashStranded, true, '没能恢复就必须报出来，不许静默');
  assert.match(sh(['stash', 'list'], repo), /stash@\{0\}/, '未跟踪文件同样是用户的代码，一个字节都不能丢');
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
  assert.match(r.mergeCommit, /^[0-9a-f]{40}$/, '路径 B 同样要回填锚点');

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

test('mergeBranch：allowStash:false 时保持旧行为——非冲突失败不误报 conflict', async () => {
  const repo = makeRepo('not-conflict');
  await ensureBranch(repo, 'auto/t_nc');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-branch\n');
  await commitAll(repo, 'feat: touch a');
  await ensureBranch(repo, 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'my-wip\n');
  const r = await mergeBranch(repo, 'auto/t_nc', 'main', { allowStash: false });
  assert.equal(r.ok, false);
  assert.notEqual(r.conflict, true, '被 git 预检拒绝不是内容冲突，错误分类应区分');
  assert.match(r.error, /would be overwritten|local changes/i); // 原始诊断信息可见
  // 关闭 stash 后绝不能私自动用户的改动
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'my-wip\n');
  assert.equal(sh(['stash', 'list'], repo).trim(), '');
});

test('mergeBranch：源分支无领先提交（改动已在基线上）→ alreadyMerged，绝不伪造锚点', async () => {
  // 维护者手工把改动带进基线分支后，任务分支就没有领先提交了。此时 git merge 会回
  // 「Already up to date」并退出 0 且**不建 commit**——headSha 拿到的是一个与本次改动
  // 毫不相干的提交，日后「放弃改动」拿它 git revert -m 1 会撤错东西。
  const repo = makeRepo('already-merged');
  await ensureBranch(repo, 'auto/t_am');
  fs.writeFileSync(path.join(repo, 'am.txt'), 'x\n');
  await commitAll(repo, 'feat: am');
  await ensureBranch(repo, 'main');
  sh(['merge', '--no-ff', 'auto/t_am', '-m', 'chore: 手工先合了'], repo);
  fs.writeFileSync(path.join(repo, 'later.txt'), 'y\n'); // 之后 main 上又有别的提交
  await commitAll(repo, 'feat: later');

  const r = await mergeBranch(repo, 'auto/t_am', 'main');
  assert.equal(r.ok, true, '改动已在基线上，不算失败');
  assert.equal(r.alreadyMerged, true);
  assert.equal(r.mergeCommit, '', '拿不到真锚点就留空，绝不拿无关提交充数');
  // 没有产生任何新提交
  assert.equal(sh(['log', '--oneline', '-1'], repo).trim().includes('feat: later'), true);
});

test('mergeBranch：源分支有领先提交时不被 alreadyMerged 短路', async () => {
  const repo = makeRepo('not-already-merged');
  await ensureBranch(repo, 'auto/t_nam');
  fs.writeFileSync(path.join(repo, 'nam.txt'), 'x\n');
  await commitAll(repo, 'feat: nam');
  await ensureBranch(repo, 'main');
  const r = await mergeBranch(repo, 'auto/t_nam', 'main');
  assert.equal(r.ok, true);
  assert.notEqual(r.alreadyMerged, true);
  assert.match(r.mergeCommit, /^[0-9a-f]{40}$/);
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

// ---- withBranchWorktree：merge / revert 共用的「在目标分支所在工作区执行」抽象 ----

test('withBranchWorktree：主工作区已在目标分支 → 原地执行，fn 收到 repo 本身', async () => {
  const repo = makeRepo('wbw-inplace');
  let got = null;
  const r = await withBranchWorktree(repo, 'main', '.probe-tmp', async (dir) => {
    got = dir;
    return { ok: true, marker: 'A' };
  });
  assert.equal(got, repo, '路径 A 必须在主工作区原地执行');
  assert.equal(r.marker, 'A', 'fn 的返回值必须原样透传');
  assert.equal(fs.existsSync(repo + '.probe-tmp'), false, '路径 A 不该建临时目录');
});

test('withBranchWorktree：主工作区在其他分支 → 临时 worktree 执行，完事即删且主工作区不受影响', async () => {
  const repo = makeRepo('wbw-worktree');
  sh(['checkout', '-b', 'feat/other'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'wip changes\n'); // 主工作区脏

  let got = null;
  const r = await withBranchWorktree(repo, 'main', '.probe-tmp', async (dir) => {
    got = dir;
    // 在临时工作区里确认检出的确实是 main
    assert.equal(await currentBranch(dir), 'main');
    return { ok: true, marker: 'B' };
  });
  assert.equal(got, repo + '.probe-tmp', '路径 B 必须在临时 worktree 执行');
  assert.equal(r.marker, 'B');
  assert.equal(fs.existsSync(got), false, '临时 worktree 必须被清理');
  assert.equal(await currentBranch(repo), 'feat/other', '主工作区分支不得被切');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'wip changes\n');
});

test('withBranchWorktree：fn 抛错时临时 worktree 仍被清理', async () => {
  const repo = makeRepo('wbw-throw');
  sh(['checkout', '-b', 'feat/other'], repo);
  const tmp = repo + '.probe-tmp';
  await assert.rejects(
    () => withBranchWorktree(repo, 'main', '.probe-tmp', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(fs.existsSync(tmp), false, 'finally 必须清理，否则下次 worktree add 会撞目录');
});

test('mergeBranch：成功时回填 mergeCommit（放弃改动要靠它精确 revert）', async () => {
  const repo = makeRepo('merge-sha');
  await ensureBranch(repo, 'auto/t_sha');
  fs.writeFileSync(path.join(repo, 's.txt'), 'x\n');
  await commitAll(repo, 'feat: s');
  await ensureBranch(repo, 'main');

  const r = await mergeBranch(repo, 'auto/t_sha', 'main');
  assert.equal(r.ok, true, `应合并成功，实际：${r.error || ''}`);
  assert.match(r.mergeCommit, /^[0-9a-f]{40}$/, 'mergeCommit 必须是完整 sha');
  // 该 sha 就是 main 的 HEAD，且确实是一个 merge commit（有两个父提交）
  assert.equal(sh(['rev-parse', 'main'], repo).trim(), r.mergeCommit);
  assert.equal(sh(['rev-list', '--parents', '-n', '1', r.mergeCommit], repo).trim().split(/\s+/).length, 3);
});

test('mergeBranch：钩子绕过路径同样回填 mergeCommit', async () => {
  const repo = makeRepo('merge-sha-hook');
  await ensureBranch(repo, 'auto/t_sha2');
  fs.writeFileSync(path.join(repo, 's2.txt'), 'x\n');
  await commitAll(repo, 'feat: s2');
  await ensureBranch(repo, 'main');
  installRejectAllHook(repo);

  const r = await mergeBranch(repo, 'auto/t_sha2', 'main');
  assert.equal(r.ok, true);
  assert.equal(r.hookBypassed, true);
  assert.match(r.mergeCommit, /^[0-9a-f]{40}$/, '绕过钩子完成的合并也必须有锚点');
});

// ---- per-需求 worktree：与 auto 工作区隔离，供 agent 改码用 ----

test('reqWorktreeDir：纯函数，去尾斜杠 + .req-<前8位>', () => {
  assert.equal(reqWorktreeDir('D:/proj', 'r_abcdefghij'), 'D:/proj.req-r_abcdef');
  assert.equal(reqWorktreeDir('D:/proj/', 'r_abcdefghij'), 'D:/proj.req-r_abcdef');
  assert.equal(reqWorktreeDir('D:/proj\\', 'r_abcdefghij'), 'D:/proj.req-r_abcdef');
});

test('reqWorktreeDir：不同需求得到不同目录，且都不等于 auto 工作区', () => {
  const a = reqWorktreeDir('D:/proj', 'r_aaaaaaaa');
  const b = reqWorktreeDir('D:/proj', 'r_bbbbbbbb');
  assert.notEqual(a, b);
  assert.notEqual(a, autoWorktreeDir('D:/proj'));
});

test('ensureReqWorktree：首次建，二次复用', async () => {
  const repo = makeRepo('req-wt-reuse');
  const r1 = await ensureReqWorktree(repo, 'r_test1234');
  assert.equal(r1.ok, true);
  assert.equal(r1.created, true);
  assert.ok(fs.existsSync(r1.dir));
  const r2 = await ensureReqWorktree(repo, 'r_test1234');
  assert.equal(r2.ok, true);
  assert.equal(r2.created, undefined, '第二次应复用而非重建');
});

test('ensureReqWorktree：与 auto 工作区互不干扰（两个 checkout 同时存在）', async () => {
  const repo = makeRepo('req-wt-coexist');
  const a = await ensureAutoWorktree(repo);
  const r = await ensureReqWorktree(repo, 'r_test1234');
  assert.equal(a.ok, true);
  assert.equal(r.ok, true);
  assert.notEqual(a.dir, r.dir);
  assert.ok(fs.existsSync(a.dir) && fs.existsSync(r.dir));
});

test('ensureReqWorktree：目录已存在但非空（非 git 工作区）→ worktree add 失败，不删目录', async () => {
  const repo = makeRepo('req-wt-alien');
  const dir = reqWorktreeDir(repo, 'r_test1234');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '用户的重要文件.txt'), '别删我');
  const r = await ensureReqWorktree(repo, 'r_test1234');
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(path.join(dir, '用户的重要文件.txt')), '绝不能自动删用户目录');
});

// ---- 自动 stash + LLM 兜底：合并失败的两条救援路径 ----
// 背景：自动开发的基线分支往往就是维护者日常待着的分支（路径 A），主工作区长期挂着几十个
// 未提交改动。git 预检拒绝与内容冲突都会让自动合并静默失败，改动堆在分支上无人处理。
// 救援分两层：确定性的 stash（绕开预检拒绝、并让 add -A 恢复安全），失败才轮到 LLM。

/**
 * 假 resolver。`conflict` / `stash` 各是一个 (ctx) => Promise<{ok, error?}> 的手写桩，
 * 桩内直接改文件来模拟模型行为——真实 LLM 的唯一可观测效果就是「文件变成什么样」。
 */
function fakeResolver({ conflict, stash } = {}) {
  const calls = { conflict: 0, stash: 0 };
  return {
    calls,
    resolveConflict: conflict ? async (ctx) => (calls.conflict++, conflict(ctx)) : undefined,
    mergeStash: stash ? async (ctx) => (calls.stash++, stash(ctx)) : undefined,
  };
}

/** 把一个文件里的冲突标记块替换成 resolved 内容（模拟模型解冲突） */
function resolveMarkers(file, resolved) {
  fs.writeFileSync(file, resolved);
}

/**
 * 构造「stash pop 必冲突」的现场：
 * 目标分支与任务分支都改了 a.txt，主工作区还在 a.txt 上压着未提交改动。
 * merge 被预检拒绝 → stash → merge 成功（a.txt 变成分支版） → pop 时 stash 的
 * 基线（line1）已不在，必然冲突。这正是维护者边写边跑自动开发的真实形态。
 */
function makePopConflictRepo(name) {
  const repo = makeRepo(name);
  sh(['checkout', '-b', 'auto/t_pop'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-branch\n');
  sh(['commit', '-am', 'feat: branch side'], repo);
  sh(['checkout', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'my-wip\n'); // 未提交
  return repo;
}

test('mergeBranch：stash pop 冲突 + 无 resolver → 合并成功但报 stashStranded，改动完整留在 stash', async () => {
  const repo = makePopConflictRepo('pop-no-resolver');
  const r = await mergeBranch(repo, 'auto/t_pop', 'main');

  assert.equal(r.ok, true, '合并本身应已完成');
  assert.equal(r.stashStranded, true, '改动没能自动回归必须让人看见');
  assert.match(r.stashWarning || '', /stash/, '提示里要给出找回改动的线索');
  // 生命线：stash 条目绝不能丢——用户的改动是无价的
  assert.match(sh(['stash', 'list'], repo), /stash@\{0\}/);
});

test('mergeBranch：stash pop 冲突 + resolver 融合成功 → drop stash，改动以未提交态回到工作区', async () => {
  const repo = makePopConflictRepo('pop-llm-ok');
  const file = path.join(repo, 'a.txt');
  const resolver = fakeResolver({
    stash: async ({ dir }) => {
      // 模型把两边融合：保留分支改动，叠上维护者的 wip
      resolveMarkers(path.join(dir, 'a.txt'), 'from-branch\nmy-wip\n');
      return { ok: true };
    },
  });

  const r = await mergeBranch(repo, 'auto/t_pop', 'main', { resolver });
  assert.equal(r.ok, true, `应合并成功，实际错误：${r.error || ''}`);
  assert.equal(r.stashLlmMerged, true);
  assert.notEqual(r.stashStranded, true);
  assert.equal(resolver.calls.stash, 1);

  assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'from-branch\nmy-wip\n');
  // 融合结果必须是「未提交改动」而非提交——那是维护者的代码，轮不到自动流程替他提交
  assert.equal(await isClean(repo), false);
  assert.equal(sh(['diff', '--cached', '--name-only'], repo).trim(), '', '暂存区必须退回，不得留半提交态');
  assert.equal(sh(['stash', 'list'], repo).trim(), '', '确认融合成功才可 drop');
});

test('mergeBranch：stash pop 冲突 + resolver 失败 → stash 绝不 drop', async () => {
  const repo = makePopConflictRepo('pop-llm-fail');
  const resolver = fakeResolver({ stash: async () => ({ ok: false, error: 'AI 融合失败' }) });

  const r = await mergeBranch(repo, 'auto/t_pop', 'main', { resolver });
  assert.equal(r.stashStranded, true);
  assert.match(r.stashWarning || '', /AI 融合失败/);
  assert.match(sh(['stash', 'list'], repo), /stash@\{0\}/, 'AI 失败时更要保住 stash');
});

test('mergeBranch：resolver 声称解完但冲突标记还在 → 判失败，stash 不 drop', async () => {
  const repo = makePopConflictRepo('pop-llm-liar');
  const resolver = fakeResolver({ stash: async () => ({ ok: true }) }); // 谎报：一个字没改

  const r = await mergeBranch(repo, 'auto/t_pop', 'main', { resolver });
  assert.equal(r.stashStranded, true, '残留冲突标记必须被识破');
  assert.match(sh(['stash', 'list'], repo), /stash@\{0\}/);
});

test('mergeBranch：真冲突 + resolver 解冲突成功 → 合并完成并标记 conflictResolvedBy', async () => {
  const repo = makeRepo('conflict-llm-ok');
  await ensureBranch(repo, 'auto/t_cf');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-branch\n');
  await commitAll(repo, 'fix: branch side');
  await ensureBranch(repo, 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-main\n');
  await commitAll(repo, 'fix: main side'); // 两边都提交了 → 真内容冲突

  const resolver = fakeResolver({
    conflict: async ({ dir }) => {
      resolveMarkers(path.join(dir, 'a.txt'), 'merged-by-ai\n');
      return { ok: true };
    },
  });
  const r = await mergeBranch(repo, 'auto/t_cf', 'main', { resolver });

  assert.equal(r.ok, true, `AI 解冲突后应完成合并，实际错误：${r.error || ''}`);
  assert.equal(r.conflictResolvedBy, 'llm');
  assert.match(r.mergeCommit, /^[0-9a-f]{40}$/);
  assert.equal(await isClean(repo), true, '解完必须提交干净，不留半合并态');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'merged-by-ai\n');
  // 必须是真正的 merge commit（两个父），否则 revert -m 1 会失效
  assert.equal(sh(['rev-list', '--parents', '-n', '1', r.mergeCommit], repo).trim().split(/\s+/).length, 3);
});

test('mergeBranch：真冲突 + resolver 失败 → abort，不留半合并态', async () => {
  const repo = makeRepo('conflict-llm-fail');
  await ensureBranch(repo, 'auto/t_cf2');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-branch\n');
  await commitAll(repo, 'fix: branch side');
  await ensureBranch(repo, 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-main\n');
  await commitAll(repo, 'fix: main side');

  const resolver = fakeResolver({ conflict: async () => ({ ok: false, error: 'AI 解冲突失败' }) });
  const r = await mergeBranch(repo, 'auto/t_cf2', 'main', { resolver });

  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.equal(await isClean(repo), true, '必须 abort 回滚');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'from-main\n');
});

test('mergeBranch：真冲突 + 无关脏文件 + resolver → 先 stash，脏文件绝不被 add -A 卷进合并提交', async () => {
  const repo = makeRepo('conflict-dirty-unrelated');
  await ensureBranch(repo, 'auto/t_cd');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-branch\n');
  await commitAll(repo, 'fix: branch side');
  await ensureBranch(repo, 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from-main\n');
  await commitAll(repo, 'fix: main side');
  // 与合并无关的脏文件：解冲突后的 add -A 会把它一起提交——这正是 revert.js 踩过的坑
  fs.writeFileSync(path.join(repo, 'secret-wip.txt'), 'my private wip\n');

  const resolver = fakeResolver({
    conflict: async ({ dir }) => {
      resolveMarkers(path.join(dir, 'a.txt'), 'merged-by-ai\n');
      return { ok: true };
    },
  });
  const r = await mergeBranch(repo, 'auto/t_cd', 'main', { resolver });

  assert.equal(r.ok, true, `应完成合并，实际错误：${r.error || ''}`);
  // 合并提交里绝不能出现那个无关文件
  const files = sh(['show', '--name-only', '--format=', r.mergeCommit], repo);
  assert.doesNotMatch(files, /secret-wip\.txt/, 'add -A 卷入无关脏文件 = 用户代码被偷偷提交');
  // 它仍是未跟踪/未提交状态，原样躺在工作区
  assert.equal(fs.readFileSync(path.join(repo, 'secret-wip.txt'), 'utf8').replace(/\r\n/g, '\n'), 'my private wip\n');
  assert.equal(await isClean(repo), false);
});

test('mergeBranch：路径 B（临时 worktree）天然干净，不动用 stash', async () => {
  const repo = makeRepo('stash-path-b');
  await ensureBranch(repo, 'v1.0');
  await ensureBranch(repo, 'auto/t_b');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n');
  await commitAll(repo, 'feat: f');
  await ensureBranch(repo, 'v1.0');
  await ensureBranch(repo, 'feat/other');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'wip\n'); // 主工作区脏，但目标分支不在这

  const r = await mergeBranch(repo, 'auto/t_b', 'v1.0');
  assert.equal(r.ok, true, `路径 B 应直接合并成功，实际错误：${r.error || ''}`);
  assert.notEqual(r.stashed, true, '临时 worktree 里不该有 stash 这回事');
  assert.equal(sh(['stash', 'list'], repo).trim(), '', '绝不能去碰主工作区的 stash 栈');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'wip\n');
});

test('ensureReqWorktree：目录是别的仓库（健康但未登记）→ 归属校验拦下，不删目录', async () => {
  const repo = makeRepo('req-wt-alien-repo');
  const dir = reqWorktreeDir(repo, 'r_test1234');
  fs.mkdirSync(dir, { recursive: true });
  // 关键：让它成为一个**健康的** git 工作区，rev-parse 会成功 ——
  // 这样才会走到归属校验那一支，而不是被 worktree add 的「目录非空」挡掉
  sh(['init', '-b', 'main'], dir);
  fs.writeFileSync(path.join(dir, '别人的文件.txt'), '别删我');

  const r = await ensureReqWorktree(repo, 'r_test1234');
  assert.equal(r.ok, false);
  assert.match(r.error, /不是本仓库的 worktree/, '必须是归属校验拦的，不是 worktree add 失败');
  assert.ok(fs.existsSync(path.join(dir, '别人的文件.txt')), '绝不能自动删用户目录');
});

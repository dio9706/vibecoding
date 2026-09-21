# 自动合并 + 放弃语义分叉 + 巡检缺图人工兜底 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⚠️ **本项目不自动 git 提交**（根 `CLAUDE.md`「协作约定」）。因此每个 Task 的收口步骤是**跑测试验证**而非 `git commit`，改动一律留在工作区，提交时机由维护者掌控。

**Goal:** 自动开发完成后自动把任务分支合并回基线分支；放弃改动改为 revert（冲突时交 AI 处理）；BUG 巡检遇到缺图片资源的新增 UI 需求时转人工。

**Architecture:** 合并复用现有 `mergeTaskById` 编排，只在 `auto-dev/runOne` 里多调一次，失败静默降级回人工态。放弃按 `task.merged` 分流：未合并删分支（现状），已合并走新增的 `revert.js`（git revert 优先，冲突转 Claude）。merge 与 revert 共用从 `mergeBranch` 抽出的 `withBranchWorktree`。巡检缺图判定扒进现有 `side-review`，并补一条无需求关联时的精简路径。

**Tech Stack:** Node LTS ≥20、ESM、`node --test` 单测（git 路径用 `os.tmpdir()` 里真建的仓库跑，不打桩）、原生 DOM（前端无框架）。

**Spec:** `docs/superpowers/specs/2026-09-19-auto-merge-discard-and-patrol-human-fallback-design.md`

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/plugins/team-tools/auto-dev/git.js` | 修改 | 抽 `withBranchWorktree`；`runMergeIn` 回填 `mergeCommit` |
| `src/plugins/team-tools/auto-dev/git.test.js` | 修改 | 新抽象与新字段的用例 |
| `src/plugins/team-tools/auto-dev/revert.logic.js` | **新建** | revert 的 prompt / commit message 纯函数 |
| `src/plugins/team-tools/auto-dev/revert.logic.test.js` | **新建** | 上者单测 |
| `src/plugins/team-tools/auto-dev/revert.js` | **新建** | `revertMergeCommit`：git revert + LLM 兜底 |
| `src/plugins/team-tools/auto-dev/revert.test.js` | **新建** | 真实 git 仓库 + LLM 注入桩 |
| `src/plugins/team-tools/task-actions.js` | 修改 | `isDiscardable` 放宽；`discardTaskById` 分流；`mergeTaskById` 写 `mergeCommit`/`autoMerged` |
| `src/plugins/team-tools/task-actions.test.js` | 修改 | 新谓词与 revert 分支用例 |
| `src/plugins/team-tools/auto-dev/index.js` | 修改 | `runOne` 插入自动合并；`replySource` 文案 |
| `src/plugins/team-tools/task-notify.logic.js` | 修改 | 已自动合并的卡片形态 |
| `src/plugins/team-tools/task-notify.logic.test.js` | 修改 | 卡片用例 |
| `src/plugins/team-tools/bug-patrol/side-review.logic.js` | 修改 | `blocked` 字段 + `buildAssetOnlyPrompt` |
| `src/plugins/team-tools/bug-patrol/side-review.logic.test.js` | 修改 | 解析与 prompt 用例 |
| `src/plugins/team-tools/bug-patrol/side-review.js` | 修改 | `assetOnly` 选项 |
| `src/store/patrol-loop.js` | 修改 | report 加 `needHuman`（**两处**） |
| `src/store/patrol-loop.test.js` | 修改 | 透传与写盘用例 |
| `src/plugins/team-tools/bug-patrol/loop.logic.js` | 修改 | `hasAnything` + 汇报新分组 |
| `src/plugins/team-tools/bug-patrol/loop.logic.test.js` | 修改 | 汇报用例 |
| `src/plugins/team-tools/bug-patrol/index.js` | 修改 | 缺图出口 + 无需求关联路径 |
| `public/js/tasks-panel.js` | 修改 | 已自动合并徽标 + 保留放弃按钮 |
| `src/plugins/CLAUDE.md` | 修改 | 模块地图同步 |

---

## Task 1: 抽 `withBranchWorktree`（merge / revert 共用执行目录）

**Files:**
- Modify: `src/plugins/team-tools/auto-dev/git.js:127-169`
- Test: `src/plugins/team-tools/auto-dev/git.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `git.test.js` 末尾：

```js
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
```

同时把第 13 行的 import 改为（追加 `withBranchWorktree`）：

```js
import { mergeBranch, mergeMessage, isClean, currentBranch, ensureBranch, commitAll, autoWorktreeDir, worktreeAddArgs, checkoutNewFromBaseArgs, ensureAutoWorktree, commitResidue, deleteBranchArgs, withBranchWorktree } from './git.js';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/auto-dev/git.test.js`
Expected: FAIL，报 `withBranchWorktree is not a function`（或 import 解析失败）

- [ ] **Step 3: 实现**

在 `git.js` 中，把 `mergeBranch`（127-169 行）整段替换为：

```js
/**
 * 在「目标分支所在的工作区」里执行 fn，两条路径对调用方透明：
 * - 主工作区已在 target：原地执行（fn 收到 repo 本身）
 * - 主工作区在其他分支：建临时 worktree 检出 target 执行，完事即删
 *   （主工作区连同其未提交改动完全不受影响）
 *
 * 抽取自 mergeBranch —— merge 与 revert 对「在哪执行」的需求完全同构，各写一套
 * 必然在临时 worktree 的残留清理上分叉（那是最容易漏、又最难排查的一段）。
 *
 * @param {string} repo 主工作区路径
 * @param {string} target 目标分支（须已存在，调用方自行校验）
 * @param {string} suffix 临时目录后缀。同一时刻可能并存的不同操作**不得复用同一后缀**
 *   （merge 用 '.merge-tmp'，revert 用 '.revert-tmp'），否则互相 remove --force 对方的工作区
 * @param {(dir:string)=>Promise<any>} fn 在 dir 里干活，返回值原样透传
 */
export async function withBranchWorktree(repo, target, suffix, fn) {
  const original = await currentBranch(repo);

  // ── 路径 A：主工作区已在目标分支，原地执行 ──
  // 注意：不做 isClean 预检，直接让 git 决定——git 只在脏文件与本次操作内容真正冲突时才拒绝，
  // 未追踪文件和不涉及的已修改文件不会造成阻碍，过早的 isClean 检查会误伤正常开发状态。
  // 提交钩子（husky）只在这条路径生效：core.hooksPath=.husky/_ 是相对路径，新建 worktree 里
  // 没有 .husky/_（gitignored、由 husky install 生成），所以路径 B 天然不跑钩子。
  if (original === target) return fn(repo);

  // ── 路径 B：主工作区在其他分支，用临时 worktree 执行，不动主工作区 ──
  const tmpDir = String(repo).replace(/[\\/]+$/, '') + suffix;
  // 清理可能的残留注册（上次异常退出留下的）
  await git(['-C', repo, 'worktree', 'prune']);
  await git(['-C', repo, 'worktree', 'remove', '--force', tmpDir]); // 幂等：目录不存在时 git 返回非 0 但无副作用

  const add = await git(['-C', repo, 'worktree', 'add', tmpDir, target]);
  if (!add.ok) {
    return { ok: false, error: `创建临时工作区失败：${(add.err || add.msg || '').slice(0, 200)}` };
  }

  try {
    return await fn(tmpDir);
  } finally {
    // 无论成功、失败还是抛错都清理，不留垃圾目录（留下会让下次 worktree add 直接失败）
    await git(['-C', repo, 'worktree', 'remove', '--force', tmpDir]);
  }
}

/**
 * 合并 source → target（--no-ff）。冲突/失败则 merge --abort，绝不留半合并状态。
 * 执行目录（原地 / 临时 worktree）由 withBranchWorktree 决定。
 *
 * @returns {{ ok: boolean, conflict?: boolean, hookBypassed?: boolean, mergeCommit?: string, error?: string }}
 */
export async function mergeBranch(repo, source, target) {
  if (!(await branchExists(repo, source))) return { ok: false, error: `分支不存在：${source}` };
  if (!(await branchExists(repo, target))) return { ok: false, error: `目标分支不存在：${target}` };
  return withBranchWorktree(repo, target, '.merge-tmp', (dir) => runMergeIn(dir, source, target));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/auto-dev/git.test.js`
Expected: PASS，且**原有 mergeBranch 的 9 个用例全部仍通过**（这是纯重构，行为不得变）

---

## Task 2: `runMergeIn` 回填 `mergeCommit`

**Files:**
- Modify: `src/plugins/team-tools/auto-dev/git.js:88-125`
- Test: `src/plugins/team-tools/auto-dev/git.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `git.test.js`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/auto-dev/git.test.js`
Expected: FAIL，`r.mergeCommit` 为 `undefined`，正则断言不通过

- [ ] **Step 3: 实现**

在 `git.js` 的 `mergeInProgress` 函数之后、`runMergeIn` 之前插入：

```js
/** 取 dir 当前 HEAD 的完整 sha（拿不到返回空串——合并已成功，只是丢了锚点，不该反过来判合并失败） */
async function headSha(dir) {
  const r = await git(['-C', dir, 'rev-parse', 'HEAD']);
  return r.ok ? (r.out || '').trim() : '';
}
```

改 `runMergeIn` 的两个成功出口：

```js
  const merge = await git(['-C', dir, 'merge', '--no-ff', source, '-m', msg]);
  if (merge.ok) return { ok: true, mergeCommit: await headSha(dir) };
```

以及钩子绕过分支：

```js
    const c = await git(['-C', dir, 'commit', '--no-verify', '-m', msg]);
    if (c.ok) {
      logger.warn('auto-dev', '提交钩子拦截合并，已 --no-verify 完成', {
        dir,
        source,
        target,
        hook: diag.slice(0, 300),
      });
      return { ok: true, hookBypassed: true, hookOutput: diag.slice(0, 300), mergeCommit: await headSha(dir) };
    }
```

同时更新 `runMergeIn` 上方 JSDoc 的 `@returns`：

```js
 * @returns {{ ok: boolean, conflict?: boolean, hookBypassed?: boolean, mergeCommit?: string, error?: string }}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/auto-dev/git.test.js`
Expected: PASS（全部用例）

---

## Task 3: `revert.logic.js` 纯函数（prompt + commit message）

**Files:**
- Create: `src/plugins/team-tools/auto-dev/revert.logic.js`
- Test: `src/plugins/team-tools/auto-dev/revert.logic.test.js`

- [ ] **Step 1: 写失败测试**

新建 `src/plugins/team-tools/auto-dev/revert.logic.test.js`：

```js
/** revert 纯函数单测：commit message 必须过 commitlint，prompt 必须交代清「保留后续提交」。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revertCommitMessage, buildRevertPrompt } from './revert.logic.js';

test('revertCommitMessage：符合 conventional 规范且控长 ≤72', () => {
  const m = revertCommitMessage({ title: '修复登录按钮错位' });
  assert.match(m, /^revert: /, '必须带 type，否则目标仓库的 commitlint 会挡下这次提交');
  assert.ok(m.length <= 72, `header 应控长，实际 ${m.length}`);
});

test('revertCommitMessage：超长标题截断后 subject 仍非空', () => {
  const m = revertCommitMessage({ title: '超长'.repeat(100) });
  assert.ok(m.length <= 72);
  assert.match(m, /^revert: \S/);
});

test('revertCommitMessage：无标题任务不产生空 subject', () => {
  assert.match(revertCommitMessage({}), /^revert: \S/);
  assert.match(revertCommitMessage(null), /^revert: \S/);
});

test('buildRevertPrompt：含 sha、任务描述，且明确要求保留后续提交、不要自行 commit', () => {
  const p = buildRevertPrompt({
    task: { title: '登录按钮错位', detail: '点了没反应' },
    mergeCommit: 'abc1234def5678',
  });
  assert.match(p, /abc1234def5678/, '必须给出锚点 sha');
  assert.match(p, /登录按钮错位/);
  assert.match(p, /点了没反应/);
  assert.match(p, /保留/, '必须交代「保留此后其他提交的改动」，否则会被整体回滚');
  assert.match(p, /不要.*commit|不要.*提交/, '提交由调用方统一做，模型自己 commit 会绕过 commitAll 的校验');
});

test('buildRevertPrompt：无 mergeCommit 时不拼出 undefined', () => {
  const p = buildRevertPrompt({ task: { title: 'x', detail: 'y' }, mergeCommit: '' });
  assert.doesNotMatch(p, /undefined|null/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/auto-dev/revert.logic.test.js`
Expected: FAIL，`Cannot find module './revert.logic.js'`

- [ ] **Step 3: 实现**

新建 `src/plugins/team-tools/auto-dev/revert.logic.js`：

```js
/**
 * 「放弃已合并改动」的纯函数层 —— commit message 与 LLM 兜底 prompt。
 *
 * 与 git.js#mergeMessage 同一套纪律：**必须符合 Conventional Commits**，因为目标仓库
 * 普遍装了 husky + commitlint，而 commitAll 走的是正常提交路径（会跑 commit-msg 钩子）。
 * `revert` 是 commitlint 默认放行的 type 之一。
 */

/** LLM 兜底的单次超时（对齐 bug-patrol/side-review.js#SIDE_TIMEOUT_MS） */
export const REVERT_TIMEOUT_MS = 5 * 60_000;

/**
 * 撤销提交的消息。控长 ≤72 以避开 header-max-length 类规则；
 * 标题缺失时用固定兜底词，绝不产生空 subject（那会被判 subject-empty 挡下）。
 */
export function revertCommitMessage(task) {
  const title = String(task?.title || '').trim() || '自动改动';
  const msg = `revert: 放弃「${title}」的自动改动`;
  return msg.length <= 72 ? msg : `${msg.slice(0, 69)}...`;
}

/**
 * git revert 冲突后交给 Claude 的 prompt。
 *
 * 两条要求是这个 prompt 存在的全部理由，少一条就会出事：
 * 1. **只撤销该次合并引入的改动** —— 合并之后基线分支上可能已经叠了别的任务的提交，
 *    整体回滚会把别人的活一起抹掉（这正是 git revert 冲突的成因）。
 * 2. **不要自己 commit** —— 提交由调用方 commitAll 统一做，那里有「无改动即失败」的校验；
 *    模型自行提交会绕过它，让「AI 其实什么都没改」看起来像成功。
 */
export function buildRevertPrompt({ task, mergeCommit } = {}) {
  const sha = String(mergeCommit || '').trim();
  const shaLine = sha
    ? `这次改动是通过合并提交 ${sha} 进入当前分支的（可用 git show ${sha} 查看它引入了什么）。\n`
    : `这次改动的合并提交记录已丢失，请用 git log 自行定位相关提交。\n`;
  return (
    `请撤销一次自动开发产生的代码改动。\n\n` +
    `原始诉求：${task?.title || '(无标题)'}\n` +
    `详细描述：${task?.detail || '(无)'}\n\n` +
    shaLine +
    `已经尝试过 git revert 但发生冲突——说明这次改动之后，又有别的提交改动了同一片代码。\n\n` +
    `要求：\n` +
    `1. 只撤销上述这次改动引入的内容，**保留此后其他提交对同一文件的修改**。\n` +
    `2. 撤销后代码必须能正常工作，不要留下半截状态或无法解析的残片。\n` +
    `3. 改完**不要自己执行 git commit**，提交由调用方统一完成。\n` +
    `4. 完成后用一段话说明你撤销了哪些文件的哪些内容、保留了什么。`
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/auto-dev/revert.logic.test.js`
Expected: PASS（5 个用例）

---

## Task 4: `revert.js` —— git revert + LLM 兜底

**Files:**
- Create: `src/plugins/team-tools/auto-dev/revert.js`
- Test: `src/plugins/team-tools/auto-dev/revert.test.js`

- [ ] **Step 1: 写失败测试**

新建 `src/plugins/team-tools/auto-dev/revert.test.js`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/auto-dev/revert.test.js`
Expected: FAIL，`Cannot find module './revert.js'`

- [ ] **Step 3: 实现**

新建 `src/plugins/team-tools/auto-dev/revert.js`：

```js
/**
 * 放弃「已合并进基线分支」的自动改动。
 *
 * 分支已经进了主干，删分支撤不回任何东西——必须在基线分支上做一次反向提交：
 *   1. git revert -m 1 <mergeCommit>：确定性操作，绝大多数情况一步到位、零额度消耗
 *   2. 冲突（合并之后又有别的提交改了同一片代码）→ revert --abort，起 Claude 判断怎么安全撤
 *
 * 执行目录走 git.js#withBranchWorktree（与 mergeBranch 同一套路径 A/B 分流）：
 * 主工作区恰在基线分支上就原地做，否则建临时 worktree，完全不动主工作区。
 */
import { runClaude } from '../../../integrations/claude.js';
import { claudeAuthOpts } from '../../../capabilities/token-rotation.js';
import { runScript } from '../../../integrations/shell.js';
import { logger } from '../../../shared/logger.js';
import { withBranchWorktree, branchExists, commitAll } from './git.js';
import { buildRevertPrompt, revertCommitMessage, REVERT_TIMEOUT_MS } from './revert.logic.js';

// shell:false —— 与 git.js 同款：参数直传 git.exe，含空格的消息不被 cmd 拆散
const git = (args) => runScript('git', args, { shell: false });

/**
 * 真实 LLM 调用：在 dir 里改码撤销（bypassPermissions —— 要动文件）。
 * 刻意不让模型自己 commit：提交由调用方 commitAll 统一做，那里有「无改动即失败」的校验。
 */
async function callLlmRevert({ dir, task, mergeCommit }) {
  let out = '';
  try {
    await runClaude(buildRevertPrompt({ task, mergeCommit }), {
      ...claudeAuthOpts(), // 跟随备用账号轮换（与 web run 同一 token 池）
      cwd: dir,
      permissionMode: 'bypassPermissions',
      persistSession: false, // 内部一次性调用不落盘 session
      onText: (t) => (out += t),
      onResult: (i) => {
        if (i.result) out = i.result;
      },
    });
    return { ok: true, log: out };
  } catch (e) {
    return { ok: false, error: `AI 撤销失败：${(e?.message || String(e)).slice(0, 200)}` };
  }
}

/** 带超时的 LLM 兜底。超时不真正中断底层调用，只是不再等它（同 side-review 的 race 兜底） */
async function llmRevertWithTimeout(fn, args, timeoutMs) {
  const TIMEOUT = Symbol('timeout');
  let timer;
  try {
    const r = await Promise.race([
      fn(args),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      }),
    ]);
    if (r === TIMEOUT) return { ok: false, error: 'AI 撤销超时' };
    return r;
  } finally {
    // 调用先赢时计时器仍会挂到 timeoutMs 后才触发，不清会拖住进程退出
    clearTimeout(timer);
  }
}

/**
 * 撤销一次已合并的自动改动。
 *
 * @param {string} repo 主工作区路径
 * @param {{ task: object, mergeCommit: string }} p task 需含 baseBranch
 * @param {{ llmRevert?: Function, timeoutMs?: number }} opts 供测试注入
 * @returns {Promise<{ ok: boolean, by?: 'git'|'llm', error?: string }>}
 */
export async function revertMergeCommit(repo, { task, mergeCommit } = {}, opts = {}) {
  const { llmRevert = callLlmRevert, timeoutMs = REVERT_TIMEOUT_MS } = opts;
  const target = task?.baseBranch;
  if (!target) return { ok: false, error: '任务未记录基线分支，无法撤销已合并的改动' };
  if (!(await branchExists(repo, target))) return { ok: false, error: `基线分支不存在：${target}` };

  return withBranchWorktree(repo, target, '.revert-tmp', async (dir) => {
    // ── 路径 1：确定性 git revert ──
    if (mergeCommit) {
      const r = await git(['-C', dir, 'revert', '-m', '1', '--no-edit', mergeCommit]);
      if (r.ok) {
        logger.info('auto-dev', '已 git revert 撤销合并', { repo, target, mergeCommit });
        return { ok: true, by: 'git' };
      }
      // 幂等：未开始 revert 时非 0 但无副作用。不 abort 会把半 revert 态留给下一步的 AI
      await git(['-C', dir, 'revert', '--abort']);
      logger.warn('auto-dev', 'git revert 冲突，转 AI 处理', {
        repo,
        target,
        mergeCommit,
        err: (r.err || r.out || '').slice(0, 200),
      });
    }

    // ── 路径 2：LLM 兜底 ──
    const llm = await llmRevertWithTimeout(llmRevert, { dir, task, mergeCommit }, timeoutMs);
    if (!llm.ok) return { ok: false, error: llm.error || 'AI 撤销失败' };

    const c = await commitAll(dir, revertCommitMessage(task));
    // AI 说完成了但一行没改 —— 绝不谎报撤销成功，否则任务被标成已放弃而改动还在主干上
    if (!c.committed) return { ok: false, error: 'AI 未产生可提交的撤销改动' };
    logger.info('auto-dev', 'AI 已完成撤销并提交', { repo, target });
    return { ok: true, by: 'llm' };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/auto-dev/revert.test.js`
Expected: PASS（7 个用例）

---

## Task 5: `task-actions.js` —— 谓词放宽 + 放弃分流 + 合并落新字段

**Files:**
- Modify: `src/plugins/team-tools/task-actions.js`
- Test: `src/plugins/team-tools/task-actions.test.js`

- [ ] **Step 1: 写失败测试**

替换 `task-actions.test.js` 第 101-109 行的 `isDiscardable` 用例为：

```js
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
```

替换第 145-151 行的 `discardTaskById：非自动任务` 用例文案断言：

```js
test('discardTaskById：非自动任务 → 400', async () => {
  const t = seedTask({ auto: false });
  const r = await discardTaskById(t.id);
  assert.equal(r.ok, false);
  assert.equal(r.code, 400);
  assert.equal(r.error, '任务不满足放弃条件（须为自动完成且未放弃）');
});
```

在 merge 的 git 路径一节追加：

```js
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
```

在 discard 的 git 路径一节追加：

```js
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
```

> 注意：`discard-revert-fail` 用例里的 `deadbeef...` 是 40 位十六进制但不存在的 sha，`git revert` 会失败并转 LLM 兜底；真实 `callLlmRevert` 在测试环境会因没有 Claude 凭证而抛错 → 返回 `ok:false`。这正是要验的降级路径。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/task-actions.test.js`
Expected: FAIL，`isDiscardable({merged:true})` 返回 false、`mergeCommit` 为 undefined

- [ ] **Step 3: 实现**

`task-actions.js` 改 import（第 15 行）：

```js
import { mergeBranch, deleteBranch } from './auto-dev/git.js';
import { revertMergeCommit } from './auto-dev/revert.js';
```

替换 `isDiscardable`（22-30 行）：

```js
/**
 * 可放弃谓词：自动完成、有分支、尚未放弃过。**合并前后都成立** ——
 * 未合并删分支即可；已合并则走 revert 撤销（见 discardTaskById），两者都是「放弃」。
 * 刻意不要求 baseBranch：分支还在就删得掉，没记住合并目标不该妨碍放弃。
 *
 * 独立导出而不是让调用方各写一遍条件：飞书卡片要据此给出「已不在可放弃态」的友好短路，
 * 与 discardTaskById 内部判据一旦分叉，就会出现「卡片说能放弃、点了却被挡回」的错位。
 */
export function isDiscardable(task) {
  return !!(task && task.auto && task.status === 'done' && task.branch && !task.discarded);
}
```

替换 `mergeTaskById`（40-72 行）的签名与成功分支：

```js
/**
 * 合并任务分支到基线分支。
 * @param {string} id 任务 id
 * @param {{auto?:boolean}} opts auto=true 表示由 auto-dev 管线自动触发（仅影响面板/卡片文案）
 * @returns {Promise<{ok:boolean, code:200|400|404|409, error?:string, task?:object, hookBypassed?:boolean}>}
 */
export async function mergeTaskById(id, opts = {}) {
  const task = getTask(id);
  if (!task) return { ok: false, code: 404, error: '任务不存在' };
  if (!isAwaitingMerge(task)) {
    return { ok: false, code: 400, error: '任务不满足合并条件（须为自动完成且未合并）' };
  }
  const repo = repoOf(task);
  const r = await mergeBranch(repo, task.branch, task.baseBranch);
  if (!r.ok) {
    // r.error 自带「合并冲突：」/「合并失败：」前缀，别再套一层前缀（曾出现「合并失败：合并冲突：…」）
    const t = updateTask(task.id, { mergeError: r.error }, r.error);
    logger.warn('task-actions', '任务合并失败', { id: task.id, err: r.error });
    return { ok: false, code: 409, error: r.error, task: t };
  }
  const t = updateTask(
    task.id,
    {
      merged: true,
      mergedAt: new Date().toISOString(),
      mergeError: null,
      // 放弃改动要靠它精确 revert；合并那一刻不记，事后无从反推
      // （基线分支上可能已叠了别的任务的合并提交）
      mergeCommit: r.mergeCommit || '',
      autoMerged: opts.auto === true,
    },
    `已合并 ${task.branch} → ${task.baseBranch}` +
      // 钩子被绕过必须让人看见：merge commit 未过目标仓库的 commit-msg/pre-merge-commit 校验
      (r.hookBypassed ? '（提交钩子拦截，已跳过钩子校验完成合并）' : ''),
  );
  logger.info('task-actions', '任务已合并', {
    id: task.id,
    branch: task.branch,
    base: task.baseBranch,
    auto: opts.auto === true,
    hookBypassed: !!r.hookBypassed,
  });
  return { ok: true, code: 200, task: t, hookBypassed: !!r.hookBypassed };
}
```

替换 `discardTaskById`（74-98 行）：

```js
/**
 * 放弃改动。按是否已合并分两条路（条件见 isDiscardable）：
 * - 未合并：删任务分支（分支从未进主干，删掉即撤销）
 * - 已合并：在基线分支上 revert 掉那次合并，成功后再删任务分支
 *
 * 任一路径失败都**不改任务状态**——绝不留「已放弃但改动还在主干上」的半放弃态。
 * @returns {Promise<{ok:boolean, code:200|400|404|409, error?:string, task?:object}>}
 */
export async function discardTaskById(id) {
  const task = getTask(id);
  if (!task) return { ok: false, code: 404, error: '任务不存在' };
  if (!isDiscardable(task)) {
    return { ok: false, code: 400, error: '任务不满足放弃条件（须为自动完成且未放弃）' };
  }
  const repo = repoOf(task);

  // ── 已合并：改动在基线分支上，删分支撤不回任何东西 ──
  if (task.merged) {
    const rv = await revertMergeCommit(repo, { task, mergeCommit: task.mergeCommit || '' });
    if (!rv.ok) {
      logger.warn('task-actions', '撤销已合并改动失败', { id: task.id, err: rv.error });
      return { ok: false, code: 409, error: rv.error, task };
    }
    // 改动已撤，任务分支再留着只会让人误以为还有东西可合；删除失败不影响结论，仅告警
    const del = await deleteBranch(repo, task.branch);
    if (!del.ok) logger.warn('task-actions', '撤销后删除任务分支失败（不影响撤销结果）', { id: task.id, err: del.error });

    const now = new Date().toISOString();
    const t = updateTask(
      task.id,
      {
        status: 'rejected',
        rejectedBy: 'owner',
        discarded: true,
        discardedAt: now,
        revertedAt: now,
        revertedBy: rv.by,
        mergeError: null,
      },
      `放弃改动，已从 ${task.baseBranch} 撤销` + (rv.by === 'llm' ? '（git revert 冲突，由 AI 完成撤销）' : ''),
    );
    logger.info('task-actions', '任务已撤销已合并改动', { id: task.id, branch: task.branch, by: rv.by });
    return { ok: true, code: 200, task: t };
  }

  // ── 未合并：删分支即可 ──
  const r = await deleteBranch(repo, task.branch);
  if (!r.ok) {
    // 删分支失败不改状态：绝不留「已放弃但分支还在」的半放弃态
    logger.warn('task-actions', '任务放弃改动失败', { id: task.id, err: r.error });
    return { ok: false, code: 409, error: r.error, task };
  }
  const t = updateTask(
    task.id,
    { status: 'rejected', rejectedBy: 'owner', discarded: true, discardedAt: new Date().toISOString(), mergeError: null },
    `放弃改动，已删除分支 ${task.branch}`,
  );
  logger.info('task-actions', '任务已放弃改动', { id: task.id, branch: task.branch });
  return { ok: true, code: 200, task: t };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/task-actions.test.js`
Expected: PASS（全部用例）

- [ ] **Step 5: 回归验证依赖方**

Run: `node --test src/plugins/team-tools/task-notify.logic.test.js`
Expected: PASS（`buildTaskDoneCard` 用 `isAwaitingMerge`，谓词没动，应不受影响）

---

## Task 6: `auto-dev/index.js` —— 插入自动合并

**Files:**
- Modify: `src/plugins/team-tools/auto-dev/index.js:147-188`

> 本任务无单测（`runOne` 依赖 Claude 调用与飞书发送，是编排层）。验证靠 Task 5 的 `mergeTaskById` 用例 + Task 14 的全量回归。

- [ ] **Step 1: 加 import**

在第 23 行 `import { notifyTaskDone } ...` 之后追加：

```js
// 自动合并复用与人工路径同一套编排（merged/mergedAt/mergeError 写法、钩子绕过留痕全部继承）。
// 依赖链 auto-dev/index → task-actions → auto-dev/git 无环：task-actions 只引 git.js，不引本文件。
import { mergeTaskById } from '../task-actions.js';
```

- [ ] **Step 2: 在 done 之后插入自动合并**

把第 147-151 行：

```js
  // developing → done：仅在改码已提交后推进，保证重启恢复不变量
  updateTask(task.id, { status: 'done' }, '自动开发完成，待确认合并');
  // 飞书私聊卡片通知（管理员本人：合并/补充/放弃）。现读盘上值传入 —— 分支/基线是上面
  // 分步写入的，卡片要靠它们判「待合并态」才给出合并按钮。fire-and-forget，失败不影响后续流程。
  notifyTaskDone(getTask(task.id), true);
```

替换为：

```js
  // developing → done：仅在改码已提交后推进，保证重启恢复不变量
  updateTask(task.id, { status: 'done' }, '自动开发完成');

  // 自动合并回基线分支（用户拍板：全部自动任务统一自动合并）。
  // 必须在 status='done' 之后调 —— mergeTaskById 的 isAwaitingMerge 谓词要求这个状态。
  // 失败（冲突 / 脏文件被覆盖）即静默降级回「待人工合并」态：任务仍是 done + mergeError、
  // merged 仍为 false，面板与飞书卡片照旧给合并按钮，不写任何新分支逻辑。
  const mg = await mergeTaskById(task.id, { auto: true });
  if (!mg.ok) logger.warn('auto-dev', '自动合并失败，退回待人工合并', { id: task.id, err: mg.error });

  // 飞书私聊卡片通知（管理员本人）。现读盘上值传入 —— 分支/基线/合并结果都是上面分步写入的，
  // 卡片要靠它们决定给「合并」还是「已自动合并」。fire-and-forget，失败不影响后续流程。
  notifyTaskDone(getTask(task.id), true);
```

- [ ] **Step 3: 把合并结果传给 replySource**

把第 165 行：

```js
  await replySource(task, true, qrUrl, null, { branch, baseBranch });
```

替换为：

```js
  await replySource(task, true, qrUrl, null, { branch, baseBranch, merged: mg.ok, mergeError: mg.error });
```

- [ ] **Step 4: 改 replySource 文案**

把第 176-181 行的 `if (ok) { ... }` 分支：

```js
    if (ok) {
      await sendText(
        chatId,
        `${at}✅ ${tag}「${task.title}」已自动完成（分支 ${branchInfo?.branch}），等待管理员确认合并到 ${branchInfo?.baseBranch}。`,
      );
      if (qrUrl) await sendImageByUrl(chatId, qrUrl);
    } else {
```

替换为：

```js
    if (ok) {
      // 自动合并成功是常态；失败时必须说清「还没进主干」，否则提交人会以为已经上线了
      const line = branchInfo?.merged
        ? `${at}✅ ${tag}「${task.title}」已自动完成并合并到 ${branchInfo?.baseBranch}（分支 ${branchInfo?.branch}）。`
        : `${at}✅ ${tag}「${task.title}」已自动完成（分支 ${branchInfo?.branch}），` +
          `但自动合并未成功${branchInfo?.mergeError ? '：' + branchInfo.mergeError : ''}，等待管理员确认合并到 ${branchInfo?.baseBranch}。`;
      await sendText(chatId, line);
      if (qrUrl) await sendImageByUrl(chatId, qrUrl);
    } else {
```

- [ ] **Step 5: 语法检查 + 回归**

Run: `node --check src/plugins/team-tools/auto-dev/index.js && node --test src/plugins/team-tools/`
Expected: 无输出（check 通过）+ 全部测试 PASS

---

## Task 7: 飞书任务卡片 —— 已自动合并形态

**Files:**
- Modify: `src/plugins/team-tools/task-notify.logic.js:39-48`
- Test: `src/plugins/team-tools/task-notify.logic.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `task-notify.logic.test.js`：

```js
test('buildTaskDoneCard：已自动合并 → 不给合并按钮，正文写明已合并，仍保留放弃', () => {
  const card = buildTaskDoneCard(
    { id: 't1', type: 'bug', title: 'x', branch: 'task/x', baseBranch: 'main', status: 'done', auto: true, merged: true, autoMerged: true },
    true,
  );
  const json = JSON.stringify(card);
  assert.doesNotMatch(json, /合并到主分支/, '已合并再给合并按钮，点了只会被挡回');
  assert.match(json, /已自动合并到 main/, '正文必须说清改动已经进主干');
  assert.match(json, /放弃改动/, '放弃按钮必须保留（改为 revert 撤销）');
});

test('buildTaskDoneCard：合并失败降级态 → 照旧给合并按钮', () => {
  const card = buildTaskDoneCard(
    { id: 't2', type: 'bug', title: 'x', branch: 'task/x', baseBranch: 'main', status: 'done', auto: true, merged: false, mergeError: '合并冲突：xxx' },
    true,
  );
  const json = JSON.stringify(card);
  assert.match(json, /合并到主分支/);
  assert.match(json, /放弃改动/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/task-notify.logic.test.js`
Expected: FAIL，已合并任务的卡片里没有「已自动合并到 main」文案

- [ ] **Step 3: 实现**

`task-notify.logic.js` 改 import（第 11 行）：

```js
import { isAwaitingMerge, isDiscardable } from './task-actions.js';
```

替换 `buildTaskDoneCard` 的 39-48 行：

```js
export function buildTaskDoneCard(task, ok) {
  const tag = task.type === 'bug' ? '[故障]' : '[需求]';
  const head = ok ? '✅ **已处理完成**' : '❌ **处理失败**';
  // 两者都有才显示：缺一个就拼出「分支：auto/x → null」这种误导性文案，不如不显示
  const branchLine = task.branch && task.baseBranch ? `\n分支：${task.branch} → ${task.baseBranch}` : '';
  // 已合并的改动已经在基线分支上了，必须说清——否则收卡片的人以为还等着自己点合并
  const mergedLine = task.merged
    ? `\n${task.autoMerged ? '已自动合并到' : '已合并到'} ${task.baseBranch || '基线分支'}`
    : '';
  const awaiting = isAwaitingMerge(task);
  const actions = [];
  if (awaiting) actions.push(btn('✅ 合并到主分支', 'primary', task.id, 'merge'));
  actions.push(btn('📝 补充', 'default', task.id, 'supplement'));
  // 放弃按钮跟着 isDiscardable 走（合并前删分支、合并后 revert），不再与合并按钮同生共死
  if (isDiscardable(task)) actions.push(btn('🗑 放弃改动', 'danger', task.id, 'discard'));
```

并把第 55 行的正文模板：

```js
          content: `${head}\n${tag}「${task.title}」${branchLine}\n\n${summarize(task.devLog)}`,
```

替换为：

```js
          content: `${head}\n${tag}「${task.title}」${branchLine}${mergedLine}\n\n${summarize(task.devLog)}`,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/task-notify.logic.test.js`
Expected: PASS（全部用例）

> 现有两个按钮用例**不应被破坏**，可据此自检改对没有：
> - 「待合并任务：三个按钮」的样本 `auto:true/status:'done'/branch 有/merged:false` → `isDiscardable` 为 true，按钮仍是 merge/supplement/discard 三个
> - 「无分支任务（轻度托管）：只给补充按钮」的样本 `auto:false` → `isDiscardable` 为 false，仍只有 supplement
>
> 若这两个转红，说明 `isDiscardable` 的条件抄错了，回头核对 Task 5。

---

## Task 8: `side-review.logic.js` —— `blocked` 字段 + 精简 prompt

**Files:**
- Modify: `src/plugins/team-tools/bug-patrol/side-review.logic.js:11-68`
- Test: `src/plugins/team-tools/bug-patrol/side-review.logic.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `side-review.logic.test.js`：

```js
test('parseSideJson：解析 blocked / blockReason', () => {
  const r = parseSideJson('{"side":"frontend","evidence":"e","advice":"","blocked":"need-assets","blockReason":"要新增空状态插画，附件里没有切图"}');
  assert.equal(r.blocked, 'need-assets');
  assert.equal(r.blockReason, '要新增空状态插画，附件里没有切图');
});

test('parseSideJson：非法 blocked 值归空（判不准不拦截，照常修）', () => {
  assert.equal(parseSideJson('{"side":"frontend","blocked":"whatever"}').blocked, '');
  assert.equal(parseSideJson('{"side":"frontend","blocked":123}').blocked, '');
  assert.equal(parseSideJson('{"side":"frontend"}').blocked, '', '缺字段视为不拦截');
});

test('parseSideJson：完全解析失败时 blocked 也有默认值，不得 undefined', () => {
  const r = parseSideJson('模型今天不讲 JSON');
  assert.equal(r.side, 'unknown');
  assert.equal(r.blocked, '');
  assert.equal(r.blockReason, '');
});

test('buildSidePrompt：包含缺图判定维度与输出字段', () => {
  const p = buildSidePrompt({ title: 't', detail: 'd' }, { frontendDir: 'C:/fe', backendDir: 'C:/be' });
  assert.match(p, /blocked/, '输出 schema 必须含 blocked');
  assert.match(p, /need-assets/);
  assert.match(p, /切图|设计稿|图片/, '必须说清什么叫「资源拿不到」');
});

test('buildAssetOnlyPrompt：只问缺图，不提前后端归属', () => {
  const p = buildAssetOnlyPrompt({ title: 't', detail: 'd' }, { frontendDir: 'C:/fe' });
  assert.match(p, /blocked/);
  assert.match(p, /need-assets/);
  assert.doesNotMatch(p, /"side"/, '精简路径不判前后端，别让模型分心也别浪费 token');
  assert.match(p, /C:\/fe/);
});
```

把该文件顶部的 import（第 3-8 行）替换为：

```js
import {
  buildSidePrompt,
  buildAssetOnlyPrompt,
  parseSideJson,
  resolveBackendAssignees,
  buildAssigneePatch,
} from './side-review.logic.js';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/bug-patrol/side-review.logic.test.js`
Expected: FAIL，`buildAssetOnlyPrompt is not a function` 且 `blocked` 为 undefined

- [ ] **Step 3: 实现**

`side-review.logic.js` 第 11-12 行之后追加白名单：

```js
/** 合法 side 白名单：模型输出任何其它值都当 unknown */
const SIDES = new Set(['frontend', 'backend', 'unknown']);

/**
 * 合法 blocked 白名单。空串 = 不拦截，照常自动修。
 * 非法值一律归空——与 side 的「判不准落 unknown」同向：这里的保守方向是**不拦截**，
 * 误拦会让一条本可自动修的 BUG 白白躺回人工队列。
 */
const BLOCKED = new Set(['', 'need-assets']);
```

`buildSidePrompt` 整段替换为：

```js
/** 缺图判据（两个 prompt 共用，改口径只改这一处） */
const ASSET_RULE =
  `另外判断一件事：这条 BUG 是否要求**新增或替换 UI 图片资源**（图标 / 插画 / banner / 背景图等），\n` +
  `而该资源**既不在记录附件里、也不存在于代码库中**——这种情况 AI 修不了（只会编造一个占位路径），\n` +
  `必须交人工。是则 blocked 填 "need-assets"，并在 blockReason 里用一句话说清缺的是什么图。\n` +
  `⚠️ 能用现有资源完成的、纯样式/布局调整的、纯逻辑修复的，一律不算，blocked 留空字符串。\n`;

/** 构造归属判定 prompt。advice 是给人看的，所以明确禁止贴代码/堆栈/空话 */
export function buildSidePrompt(record, { frontendDir, backendDir } = {}) {
  return (
    `你要判断一个 BUG 属于前端还是后端。请在代码中实际查证（只读，不修改任何文件）后作答。\n\n` +
    `前端工程：${frontendDir || '（未配置）'}\n` +
    `后端工程：${backendDir || '（未配置）'}\n\n` +
    `BUG 标题：${record?.title || ''}\n` +
    `BUG 详情：${record?.detail || ''}\n\n` +
    `判定要求：\n` +
    `1. 必须在代码里找到依据才能下结论，写进 evidence（文件/函数/逻辑链）。\n` +
    `2. 只要有一点拿不准，就填 unknown —— 误判成 backend 会去打扰真实同事，代价很高。\n` +
    `3. side=backend 时必须写 advice：给后端同事看的处理建议。要求简短、口语、**一两句话说清**，\n` +
    `   讲现象和怀疑方向即可，不要贴代码、不要贴堆栈、不要写「建议排查」这类空话。\n` +
    `   例：「接口返回的 total 和实际条数对不上，前端只是照着渲染。建议查一下分页 SQL 的 count 语句。」\n\n` +
    ASSET_RULE +
    `\n最终回复只输出一行 JSON，不要任何其他文字：\n` +
    `{"side":"frontend|backend|unknown","evidence":"代码依据","advice":"给后端的人话建议（side=backend 时必填）","blocked":"need-assets 或空字符串","blockReason":"缺什么图（blocked 非空时必填）"}`
  );
}

/**
 * 精简 prompt：**只判缺不缺图，不判前后端**。
 *
 * 用在「没关联测试期需求 / 前后端目录没配全」的巡检上——那些场景下前后端归属本就判不了
 * （只有一个工程目录可查），但缺图这件事照样要拦，否则 AI 会拿占位图硬做一版 UI。
 */
export function buildAssetOnlyPrompt(record, { frontendDir } = {}) {
  return (
    `你要判断一个 BUG 能否由 AI 自动修复。请在代码中实际查证（只读，不修改任何文件）后作答。\n\n` +
    `前端工程：${frontendDir || '（未配置）'}\n\n` +
    `BUG 标题：${record?.title || ''}\n` +
    `BUG 详情：${record?.detail || ''}\n\n` +
    ASSET_RULE +
    `\n最终回复只输出一行 JSON，不要任何其他文字：\n` +
    `{"blocked":"need-assets 或空字符串","blockReason":"缺什么图（blocked 非空时必填）"}`
  );
}
```

`parseSideJson` 的成功返回体（53-58 行）替换为：

```js
            if (j && typeof j === 'object') {
              return {
                side: SIDES.has(j.side) ? j.side : 'unknown',
                evidence: typeof j.evidence === 'string' ? j.evidence : '',
                advice: typeof j.advice === 'string' ? j.advice : '',
                blocked: BLOCKED.has(j.blocked) ? j.blocked : '',
                blockReason: typeof j.blockReason === 'string' ? j.blockReason : '',
              };
            }
```

以及兜底返回（第 67 行）：

```js
  return { side: 'unknown', evidence: '', advice: '', blocked: '', blockReason: '' };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/bug-patrol/side-review.logic.test.js`
Expected: PASS（全部用例）

---

## Task 9: `side-review.js` —— `assetOnly` 选项

**Files:**
- Modify: `src/plugins/team-tools/bug-patrol/side-review.js`

> 无独立单测（该文件全是 Claude 调用编排，纯函数已在 Task 8 覆盖）；由 Task 12 的集成路径与 Task 14 回归保证。

- [ ] **Step 1: 改 import**

第 13 行：

```js
import { buildSidePrompt, buildAssetOnlyPrompt, parseSideJson } from './side-review.logic.js';
```

- [ ] **Step 2: `callSideReview` 支持精简路径**

替换 23-39 行：

```js
async function callSideReview(record, { frontendDir, backendDir, assetOnly } = {}) {
  let out = '';
  await runClaude(
    assetOnly ? buildAssetOnlyPrompt(record, { frontendDir }) : buildSidePrompt(record, { frontendDir, backendDir }),
    {
      ...claudeAuthOpts(),
      cwd: frontendDir,
      // 注意参数名是 additionalDirectories（不是 addDirs），见 integrations/claude.js:91
      // 精简路径不判前后端，挂后端目录只会白白扩大可读范围
      additionalDirectories: !assetOnly && backendDir ? [backendDir] : undefined,
      permissionMode: 'dontAsk',
      allowedTools: ['Read', 'Grep', 'Glob'], // 只读查证
      persistSession: false, // 内部一次性调用不落盘 session
      onText: (t) => (out += t),
      onResult: (i) => {
        if (i.result) out = i.result;
      },
    },
  );
  return parseSideJson(out);
}
```

- [ ] **Step 3: `reviewSideWithTimeout` 透传 `assetOnly` 并补兜底字段**

替换 51-64 行的开头与超时分支：

```js
export async function reviewSideWithTimeout(record, dirs, opts = {}) {
  const { review = callSideReview, timeoutMs = SIDE_TIMEOUT_MS, assetOnly = false } = opts;
  const TIMEOUT = Symbol('timeout');
  let timer;
  try {
    const r = await Promise.race([
      review(record, { ...dirs, assetOnly }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      }),
    ]);
    if (r === TIMEOUT) {
      logger.warn('bug-patrol', '归属判定超时，按 unknown 处理', { title: record?.title });
      return { side: 'unknown', evidence: '归属判定超时', advice: '', blocked: '', blockReason: '' };
    }
    return r;
  } catch (e) {
    const msg = (e?.message || String(e)).slice(0, 200);
    logger.warn('bug-patrol', '归属判定失败，按 unknown 处理', { err: msg });
    return { side: 'unknown', evidence: `归属判定失败：${msg}`, advice: '', blocked: '', blockReason: '' };
  } finally {
    // 调用先赢时计时器仍会挂到 timeoutMs 后才触发，不清会拖住进程退出
    // （对齐 req-inspect.js#reviewWithTimeout 的同款纪律）
    clearTimeout(timer);
  }
}
```

并更新该函数上方 JSDoc 的 `@param`：

```js
 * @param {{review?:Function, timeoutMs?:number, assetOnly?:boolean}} opts
 *   assetOnly=true 走「只判缺图、不判前后端」的精简 prompt（无需求关联时用）；review/timeoutMs 供测试注入
```

- [ ] **Step 4: 语法检查**

Run: `node --check src/plugins/team-tools/bug-patrol/side-review.js`
Expected: 无输出

---

## Task 10: `store/patrol-loop.js` —— report 加 `needHuman`

**Files:**
- Modify: `src/store/patrol-loop.js:35, 66-71`
- Test: `src/store/patrol-loop.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `src/store/patrol-loop.test.js` 末尾（该文件现有 import 为 `import { DEFAULT_LOOP, normalizeLoop } from './patrol-loop.js';`，**无需改动**）：

```js
test('normalizeLoop：透传 needHuman（漏了会让 pushReport 写进去的每条都被静默抹掉）', () => {
  const n = normalizeLoop({ report: { needHuman: [{ title: 'x' }] } });
  assert.deepEqual(n.report.needHuman, [{ title: 'x' }]);
  assert.deepEqual(normalizeLoop({}).report.needHuman, [], '缺字段时补空数组');
});

test('DEFAULT_LOOP：report 含 needHuman（pushReport 的隐式白名单靠它）', () => {
  assert.deepEqual(DEFAULT_LOOP.report.needHuman, []);
});
```

> ⚠️ **刻意不在这里测 `pushReport` 的写盘行为**：本测试文件是纯函数测试，不设 `APP_DATA_DIR`；引入落盘调用会直接往**仓库根目录**写 `patrol-loop.json`（dev 态数据目录就是仓库根）。`pushReport` 的白名单由「`DEFAULT_LOOP.report.needHuman` 是数组」这一条间接保证，已足够。
>
> 另注意：文件首个既有用例 `assert.deepEqual(normalizeLoop(null), DEFAULT_LOOP)` 会自动充当「两处改动必须同步」的保险 —— 只改一处它就会红。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/patrol-loop.test.js`
Expected: FAIL，`n.report.needHuman` 为 undefined

- [ ] **Step 3: 实现（两处，缺一不可）**

第 35 行：

```js
  report: { fixed: [], handoff: [], failed: [], unknown: [], needHuman: [] },
```

第 66-71 行：

```js
    report: {
      fixed: arr(rep.fixed),
      handoff: arr(rep.handoff),
      failed: arr(rep.failed),
      unknown: arr(rep.unknown),
      // pushReport 靠「cur.report[kind] 已是数组」做隐式白名单 —— 这里不透传就等于永远不是数组，
      // 写进去的每一条都会被下一次 normalizeLoop 静默抹掉
      needHuman: arr(rep.needHuman),
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/patrol-loop.test.js`
Expected: PASS（全部用例）

---

## Task 11: `loop.logic.js` —— 汇报新增「待人工处理」分组

**Files:**
- Modify: `src/plugins/team-tools/bug-patrol/loop.logic.js:53-57, 94-115`
- Test: `src/plugins/team-tools/bug-patrol/loop.logic.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `loop.logic.test.js`：

```js
test('hasAnything：只有 needHuman 也算「处理过东西」（不该被空报抑制吞掉）', () => {
  assert.equal(hasAnything({ fixed: [], handoff: [], failed: [], unknown: [], needHuman: [{ title: 'x' }] }), true);
  assert.equal(hasAnything({ fixed: [], handoff: [], failed: [], unknown: [], needHuman: [] }), false);
});

test('buildRoundReport：渲染「待你人工处理」分组，含原因', () => {
  const s = buildRoundReport({
    kind: 'round',
    reqTitle: '登录改版',
    report: { fixed: [], handoff: [], failed: [], unknown: [], needHuman: [{ title: '空状态缺插画', reason: '附件里没有切图' }] },
  });
  assert.match(s, /待你人工处理（1 条）/);
  assert.match(s, /空状态缺插画/);
  assert.match(s, /附件里没有切图/);
});

test('buildRoundReport：needHuman 缺 reason 时用兜底词，不出现 undefined', () => {
  const s = buildRoundReport({
    kind: 'round',
    report: { fixed: [], handoff: [], failed: [], unknown: [], needHuman: [{ title: 'x' }] },
  });
  assert.doesNotMatch(s, /undefined/);
  assert.match(s, /缺少图片资源/);
});

test('buildRoundReport：needHuman 排在「已转后端」之后、「归属判不准」之前', () => {
  const s = buildRoundReport({
    kind: 'round',
    report: {
      fixed: [],
      handoff: [{ title: 'h', to: '', advice: 'a' }],
      failed: [],
      unknown: [{ title: 'u', branch: 'task/u' }],
      needHuman: [{ title: 'n', reason: 'r' }],
    },
  });
  assert.ok(s.indexOf('已转后端') < s.indexOf('待你人工处理'));
  assert.ok(s.indexOf('待你人工处理') < s.indexOf('归属判不准'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/bug-patrol/loop.logic.test.js`
Expected: FAIL，`hasAnything` 对只有 needHuman 的 report 返回 false

- [ ] **Step 3: 实现**

第 53-57 行：

```js
/** 本轮是否真的处理过东西（空报抑制的判据：五类全空就不打扰人） */
export function hasAnything(report) {
  if (!report || typeof report !== 'object') return false;
  return ['fixed', 'handoff', 'failed', 'unknown', 'needHuman'].some((k) => (report[k] || []).length > 0);
}
```

在 `section((n) => \`📮 已转后端（${n} 条）\`, ...)` 调用之后、`unknown` 那一节之前插入：

```js
  section(
    (n) => `🙋 待你人工处理（${n} 条）`,
    r.needHuman,
    (it) => `${it.title} —— ${it.reason || '缺少图片资源'}`,
  );
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/bug-patrol/loop.logic.test.js`
Expected: PASS（全部用例）

---

## Task 12: `bug-patrol/index.js` —— 缺图出口与全覆盖判定

**Files:**
- Modify: `src/plugins/team-tools/bug-patrol/index.js:21, 193-232`

> 无独立单测（`runPatrolRound` 依赖飞书 API + Claude）；纯函数已在 Task 8/11 覆盖，编排由 Task 14 的 `node --check` + 全量回归保证。

- [ ] **Step 1: 补 import**

第 21 行：

```js
import { getMyFeishuOpenId, getActiveBot } from '../../../store/settings.js';
```

- [ ] **Step 2: 归属判定改为全覆盖，并接缺图出口**

把 193-216 行（从 `// 归属判定：只在关联需求且前后端目录齐备时才跑` 到 `handoffToBackend` 的 `continue;`）替换为：

```js
        // 归属判定 + 缺图判定。两条路径都跑，区别只在问得多深：
        //  - 关联需求且前后端目录齐备 → 完整判定（前后端归属 + 缺图）
        //  - 否则 → 精简判定（只问缺图）。前后端归属在只有一个工程目录时本就判不了，
        //    但缺图照样要拦 —— 否则 AI 会拿占位图硬做一版 UI 出来（用户拍板：补这条路径保证全覆盖）
        let side = 'frontend';
        let advice = '';
        let blocked = '';
        let blockReason = '';
        if (canJudgeSide) {
          const sr = await reviewSideWithTimeout({ title, detail }, { frontendDir, backendDir });
          side = sr.side;
          advice = sr.advice;
          blocked = sr.blocked;
          blockReason = sr.blockReason;
        } else {
          const dir = frontendDir || getActiveBot()?.projectDir || config.feedback.frontendDir;
          const sr = await reviewSideWithTimeout({ title, detail }, { frontendDir: dir }, { assetOnly: true });
          blocked = sr.blocked;
          blockReason = sr.blockReason;
        }

        if (side === 'backend') {
          await handoffToBackend({
            appToken,
            tableId: t.tableId,
            record: rec,
            assigneeField: v.assigneeField,
            openId,
            req,
            title,
            advice,
            chatType,
          });
          markSeen(rec.record_id, { verdict: 'fix', side: 'backend' });
          continue;
        }

        // 缺图：AI 修不了（只会编占位资源）。不写表、不建任务 —— 记录保持「待处理 + 指派给我」，
        // 本轮汇报里单列一组让人自己认领。记 seen 是为了不在 12 小时里反复烧同一条的评审额度
        // （用户拍板；补完图想让它修，在面板或飞书重新发一条即可）。
        if (blocked === 'need-assets') {
          markSeen(rec.record_id, { verdict: 'fix', side, blocked: 'need-assets' });
          pushReport('needHuman', { title, reason: blockReason });
          logger.info('bug-patrol', '记录缺少图片资源，转人工', { recordId: rec.record_id, title, reason: blockReason });
          continue;
        }
```

- [ ] **Step 3: 语法检查**

Run: `node --check src/plugins/team-tools/bug-patrol/index.js`
Expected: 无输出

- [ ] **Step 4: 确认 import 图完好**

Run: `node -e "import('./src/plugins/team-tools/bug-patrol/index.js').then(()=>console.log('ok'))"`
Expected: 输出 `ok`（模块能被解析加载，无循环依赖或缺失导出）

---

## Task 13: 行为态势面板

**Files:**
- Modify: `public/js/tasks-panel.js:38-39, 239-245, 267-279, 312-341, 355-365`

> 前端无单测框架覆盖此文件（`public/**/*.test.js` 只测纯逻辑模块）；验证靠 Step 5 的手工走查。

- [ ] **Step 1: 加前端放弃谓词**

第 38-39 行之后追加：

```js
      /** 自动完成且待合并（筛选与合并按钮共用判定，与后端 merge 校验条件对齐） */
      const isAwaitingMerge = (t) => !!t.auto && t.status === 'done' && !t.merged && !!t.branch && !!t.baseBranch;
      /** 可放弃（与后端 task-actions.js#isDiscardable 同口径）：合并前删分支、合并后 revert 撤销 */
      const isDiscardable = (t) => !!t.auto && t.status === 'done' && !!t.branch && !t.discarded;
```

- [ ] **Step 2: 徽标区分自动合并与人工合并**

第 239-245 行：

```js
        if (t.auto) {
          const auto = document.createElement('span');
          auto.className = 'badge';
          auto.style.color = 'var(--accent-hi)';
          // 自动合并是常态，人工合并是降级后补的 —— 文案分开，便于一眼看出哪些是自己收的尾
          auto.textContent = t.merged ? (t.autoMerged ? '自动完成 · 已自动合并' : '自动完成 · 已合并') : '自动完成';
          top.appendChild(auto);
        }
```

- [ ] **Step 3: 分支信息行区分「撤销」与「删分支」**

第 267-279 行：

```js
        // 分支与合并信息（自动完成任务）
        if (t.auto && t.branch) {
          const br = document.createElement('div');
          br.style.cssText = 'font-size:11px;color:var(--faint);margin-top:4px';
          if (t.discarded) {
            // 已放弃：撤销过的（曾合并）与纯删分支的，事实不同，文案必须分开 ——
            // 都写「分支已删除」会让人以为主干上什么都没发生过
            br.textContent = t.revertedAt
              ? `分支 ${t.branch} 的改动已从 ${t.baseBranch || '基线分支'} 撤销（已放弃）`
              : `分支 ${t.branch} 已删除（已放弃改动）`;
          } else {
            br.textContent = `分支 ${t.branch} → ${t.baseBranch || '?'}` + (t.mergeError ? ` · 上次合并失败：${t.mergeError}` : '');
            if (t.mergeError) br.style.color = 'var(--red)';
          }
          card.appendChild(br);
        }
```

- [ ] **Step 4: 已合并任务保留放弃按钮**

第 334-339 行（`actionsFor` 的末两个分支）：

```js
        } else if (isAwaitingMerge(t)) {
          add('合并到主分支', 'primary', () => mergeTask(t));
          add('放弃修改', 'danger', () => discardTask(t));
        } else if (isDiscardable(t)) {
          // 已自动合并：没有合并按钮可点了，但改动仍可撤（revert，冲突时交 AI 处理）
          add('放弃修改', 'danger', () => discardTask(t));
        } else {
          return null; // developing/已放弃/非自动任务 无操作
        }
```

第 355-365 行的确认弹窗：

```js
      // 放弃确认：合并前后是两件不同的事，文案必须分开说清后果
      async function discardTask(t) {
        const name = t.title || t.detail || '(无标题)';
        const message = t.merged
          ? `确认放弃「${name}」的自动改动？\n将从「${t.baseBranch || '基线分支'}」撤销这次已合并的改动（自动 revert，冲突时交由 AI 处理）。`
          : `确认放弃「${name}」的自动改动？\n将删除分支「${t.branch}」，改动不可恢复。`;
        const ok = await confirmDialog({
          title: '放弃修改',
          message,
          confirmText: '确认放弃',
          danger: true,
        });
        if (!ok) return;
        taskAction(t.id, 'discard');
      }
```

- [ ] **Step 5: 语法检查 + 手工走查**

Run: `node --check public/js/tasks-panel.js`
Expected: 无输出

手工走查（前端 import 图有语法错误时症状是「卡启动页 + 窗口按钮消失」，`node --check` 能提前拦掉）：

```bash
npm start
```

然后浏览器开 `http://127.0.0.1:3000`，进「行为态势」面板确认：
1. 已自动合并的任务显示「自动完成 · 已自动合并」徽标
2. 该任务仍有 [放弃修改] 按钮、没有 [合并到主分支]
3. 点 [放弃修改] 弹出的文案是「将从「xxx」撤销这次已合并的改动」

---

## Task 14: 文档同步与全量回归

**Files:**
- Modify: `src/plugins/CLAUDE.md`

- [ ] **Step 1: 更新模块地图**

在 `src/plugins/CLAUDE.md` 的 team-tools 文件清单里，`auto-dev/index.js` 那一条之后追加：

```markdown
- `team-tools/auto-dev/revert.js`（+ `revert.logic.js`）— **放弃已合并改动**：`git revert -m 1 <mergeCommit>` 优先，冲突则 `revert --abort` 后起 Claude 撤销再 `commitAll`。执行目录走 `git.js#withBranchWorktree`（与合并同一套路径 A/B 分流）。`revert.logic.js` 存 prompt 与 commit message 纯函数（消息必须过 commitlint）。
```

并把 `task-actions.js` 那一条改为：

```markdown
- `team-tools/task-actions.js` — **共享领域模块**：任务分支 `mergeTaskById`/`discardTaskById` 及 `isAwaitingMerge`/`isDiscardable` 谓词。web 路由与飞书任务卡片共用一套编排。**放弃按 `task.merged` 分流**：未合并删分支、已合并走 `auto-dev/revert.js` 撤销（合并已自动化，「删分支」不再等于撤销）。
```

在「关键流程 B」的第 4 步末尾追加：

```markdown
   → **自动合并回基线分支**（`mergeTaskById(id, { auto:true })`，失败则静默降级回待人工合并态）
```

在「常见改动入口」追加两条：

```markdown
- **要改自动合并的时机 / 失败降级策略** → 改 `team-tools/auto-dev/index.js#runOne` 里 `status='done'` 之后那次 `mergeTaskById` 调用；改合并本身的 git 行为 → `auto-dev/git.js`。
- **要改「放弃已合并改动」的撤销策略或 AI 兜底提示词** → 改 `team-tools/auto-dev/revert.js` / `revert.logic.js`；**不要**改 `git.js#deleteBranch`（那条是未合并任务的路径）。
```

- [ ] **Step 2: 跑全量单测**

Run: `npm test`
Expected: 全部 PASS，无 skipped 失败

- [ ] **Step 3: 全量语法检查（前端 import 图）**

Run: `node --check public/js/tasks-panel.js && node --check src/plugins/team-tools/auto-dev/index.js && node --check src/plugins/team-tools/bug-patrol/index.js && node --check src/plugins/team-tools/task-actions.js`
Expected: 无输出

- [ ] **Step 4: 端到端冒烟**

Run: `npm run test:e2e`
Expected: 全部 PASS

---

## 人工验收清单（代码跑通 ≠ 功能可用）

- [ ] 起一个真实自动开发任务，确认完成后**改动已经在当前分支上**（`git log` 能看到 merge commit）
- [ ] 确认飞书回执文案是「已自动完成并合并到 xxx」
- [ ] 在面板点一次已合并任务的 [放弃修改]，确认改动被 revert 且分支被删
- [ ] 造一次 revert 冲突（合并后手动改同一文件并提交），确认走 AI 兜底并成功提交
- [ ] 跑一轮 BUG 巡检，确认缺图的 UI 需求进了「🙋 待你人工处理」而不是被自动修
- [ ] 确认缺图记录在多维表格里**仍是「待处理」且仍指派给自己**

# 同事侧对话 Agent 化 · P2 实现计划（写工具 + 可撤销闭环）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 能真的改代码和登记接口文档，且每一次改动都落在独立分支上、可一键撤销。

**Architecture:** per-需求常驻 worktree 隔离 → agent 子分支 → `commitAll` → 按 repo 串行合并回需求分支（带 `isClean` 闸，脏则降级待合并）→ 撤销台账记 `revert-merge` 锚点。两个写工具 `register_api_doc` / `start_dev_task` 注册进 P1 的工具注册表。

**Tech Stack:** 既有 `auto-dev/git.js`（worktree/commit/merge/revert 全套现成）、`requirement-ops.js#enqueueSystemTask` 串行闸、`colleague-dev.js` 子会话执行器、`store/index.js` 文件锁。

**Spec:** `docs/superpowers/specs/2026-09-22-colleague-agent-design.md`（§3.3、§3.4、§5.2、§6、§7）
**前置:** P1 已完工（工具注册表 + 对话骨架 + 5 个只读工具），3236 测试全绿。

---

## ⚠️ 本项目约定

根 `CLAUDE.md`：**不自动 `git` 提交，改动留工作区。** 每个 Task 的收尾是**跑测试验收**，不是 `git commit`。

注释与文档一律中文，解释「为什么」而非复述代码。

---

## 两条必须先读懂的现状

### A. 需求侧的改代码，现状完全不可撤销（spec §3.3）

```js
// src/entrypoints/web/requirement-ops.js:19
import { currentBranch, ensureBranch, isClean, localBranches } from '.../auto-dev/git.js';
//                                    ↑ 没有 commitAll，没有 mergeBranch
```

定稿时 `ensureBranch` 建了需求分支（`req.branches[] = {dir, branch, baseBranch}`），但开发期所有子会话都在**该分支的主工作区直接改、永不提交**。`revert.js#revertMergeCommit` 要的 `branch`/`baseBranch`/`mergeCommit` 三个字段一个都没有。

**本期就是补这个洞。**

### B. 改造 `colleague-dev.js` 而不是另写一条路

`src/entrypoints/web/colleague-dev.js` 已实现 `dispatchColleagueDev` / `buildColleagueDevOnSettle` / `replyColleague` / `abandonColleagueDev`，四期的自动处理正走它。

本期把它的 `cwd` 从主工作区换成 per-需求 worktree，并在 `onSettle` 里加提交与合并。**新工具 `start_dev_task` 复用同一条路**，不另写执行器 —— 否则两个子会话执行器迟早分叉。

副作用（刻意的）：今天在跑的四期自动处理立刻获得可撤销能力。

### C. `ensureAutoWorktree` 不能复用（spec §3.4）

```js
export function autoWorktreeDir(repo) { return repo + '.auto'; }   // 每仓库全局唯一
```

auto-dev 泵在 `<repo>.auto` 里 `checkout -B <taskBranch>`。agent 改码若复用它，会和 BUG 巡检/feedback 触发的自动开发任务抢同一目录 —— 两边各有各的串行闸（auto-dev 泵全局串行、需求 busy 闸 per-需求），**这两道闸互不知情**。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/plugins/team-tools/auto-dev/git.js` | 修改：加 `reqWorktreeDir` / `ensureReqWorktree`（复刻 `ensureAutoWorktree` 的三条纪律） |
| `src/plugins/team-tools/auto-dev/git.test.js` | 修改：加对应用例（真实 git 仓库测试，对齐既有风格） |
| `src/store/agent-actions.js` | 新建：撤销台账（append + 查询 + 标记已撤销） |
| `src/store/agent-actions.test.js` | 新建 |
| `src/entrypoints/web/merge-queue.js` | 新建：**按 repo 串行**的合并队列 + `isClean` 闸 + 降级待合并 |
| `src/entrypoints/web/merge-queue.test.js` | 新建（纯逻辑 + 注入假 git） |
| `src/entrypoints/web/colleague-dev.js` | 修改：worktree cwd + onSettle 加提交/合并/台账 |
| `src/entrypoints/web/colleague-dev.test.js` | 修改：补新行为用例 |
| `src/plugins/colleague-agent/tools/req-write.js` | 新建：`register_api_doc` + `start_dev_task` 两个 reversible 工具 |
| `src/plugins/colleague-agent/tools/req-write.test.js` | 新建 |
| `src/plugins/colleague-agent/index.js` | 修改：注册 req-write 的两个工具 |
| `src/entrypoints/web/undo-agent-action.js` | 新建：按 `undo.kind` 分派撤销 |
| `src/entrypoints/web/undo-agent-action.test.js` | 新建 |

**P2 不做**：主机飞书卡片推送与 web 监管面（归 P5）、其余 reversible 工具（归 P4）、飞书入口切换（归 P3）。

---

## Task 1: per-需求 worktree

**Files:**
- Modify: `src/plugins/team-tools/auto-dev/git.js`
- Test: `src/plugins/team-tools/auto-dev/git.test.js`

- [ ] **Step 1: 先读既有实现与测试风格**

```bash
grep -n "autoWorktreeDir\|ensureAutoWorktree" -A 30 src/plugins/team-tools/auto-dev/git.js
tail -60 src/plugins/team-tools/auto-dev/git.test.js
```

`ensureReqWorktree` 必须复刻 `ensureAutoWorktree` 的三条纪律：健康检查 → **归属校验**（必须登记在本 repo 的 `worktree list` 里）→ 直接用；缺失则 `prune` 后重建；**目录存在但属于其他仓库 → 明确失败，绝不自动删用户目录**。

- [ ] **Step 2: 写失败的测试**

在 `git.test.js` 末尾追加（`makeRepo` 等既有工具函数照现有用法复用；若名字不同，按该文件实际的建仓助手改）：

```js
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
  const repo = await makeRepo();
  const r1 = await ensureReqWorktree(repo, 'r_test1234');
  assert.equal(r1.ok, true);
  assert.equal(r1.created, true);
  assert.ok(fs.existsSync(r1.dir));
  const r2 = await ensureReqWorktree(repo, 'r_test1234');
  assert.equal(r2.ok, true);
  assert.equal(r2.created, undefined, '第二次应复用而非重建');
});

test('ensureReqWorktree：与 auto 工作区互不干扰（两个 checkout 同时存在）', async () => {
  const repo = await makeRepo();
  const a = await ensureAutoWorktree(repo);
  const r = await ensureReqWorktree(repo, 'r_test1234');
  assert.equal(a.ok, true);
  assert.equal(r.ok, true);
  assert.notEqual(a.dir, r.dir);
  assert.ok(fs.existsSync(a.dir) && fs.existsSync(r.dir));
});

test('ensureReqWorktree：目录存在但不是本仓库的 worktree → 明确失败，不删目录', async () => {
  const repo = await makeRepo();
  const dir = reqWorktreeDir(repo, 'r_test1234');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '用户的重要文件.txt'), '别删我');
  const r = await ensureReqWorktree(repo, 'r_test1234');
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(path.join(dir, '用户的重要文件.txt')), '绝不能自动删用户目录');
});
```

- [ ] **Step 3: 跑到失败**

```bash
node --test src/plugins/team-tools/auto-dev/git.test.js
```
预期：`reqWorktreeDir is not defined`

- [ ] **Step 4: 实现**

在 `git.js` 的 `autoWorktreeDir` 附近追加：

```js
/**
 * per-需求 worktree 目录（纯函数）。
 *
 * **不能复用 `<repo>.auto`**：那个目录是 auto-dev 泵的，泵按「全局串行」调度，
 * 而需求侧按「per-需求 busy 闸」调度 —— 两道闸互不知情，共用一个目录就是
 * 一方把另一方的分支 checkout 掉。
 *
 * 取 reqId 前 8 位：需求 id 形如 `r_mt8gjvxbg679`，全长做目录名太长，
 * 前 8 位（含 `r_` 前缀）在同一仓库内的活跃需求间已足够区分。
 */
export function reqWorktreeDir(repo, reqId) {
  return String(repo).replace(/[\\/]+$/, '') + '.req-' + String(reqId).slice(0, 8);
}

/**
 * 确保 per-需求 worktree 可用。三条纪律与 `ensureAutoWorktree` 完全一致：
 * 健康 → 归属校验 → 直接用；缺失 → prune 后重建；
 * **目录存在但属于其他仓库 → 明确失败，绝不自动删用户目录**。
 */
export async function ensureReqWorktree(repo, reqId) {
  return ensureWorktreeAt(repo, reqWorktreeDir(repo, reqId));
}
```

并把 `ensureAutoWorktree` 的函数体抽成共用的 `ensureWorktreeAt(repo, dir)`，`ensureAutoWorktree` 改为 `return ensureWorktreeAt(repo, autoWorktreeDir(repo))`。

**抽取纪律**：`ensureAutoWorktree` 的外部行为与返回形状一字不改（它有既有测试与生产调用方）。只是把 `dir` 从写死改成传入。

- [ ] **Step 5: 跑到通过**

```bash
node --test src/plugins/team-tools/auto-dev/git.test.js
npm test
```
两条都要绿。**特别确认 `ensureAutoWorktree` 的既有用例一条不红** —— 抽取不得改变它的行为。

---

## Task 2: 撤销台账 `store/agent-actions.js`

**Files:**
- Create: `src/store/agent-actions.js`
- Test: `src/store/agent-actions.test.js`

- [ ] **Step 1: 先读 store 层范式**

```bash
sed -n 1,40p src/store/colleague-messages.js
grep -n "export function updateJson\|export function readJson" -A 8 src/store/index.js
```

写操作一律经 `updateJson`（跨进程文件锁 + tmp+rename 原子写）。web 与 feishu 两个进程都可能写，不能有裸读写。

- [ ] **Step 2: 写失败的测试**

创建 `src/store/agent-actions.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAction, isUndoable, UNDO_KINDS } from './agent-actions.js';

// 只测纯函数：有 IO 的 append/markUndone 靠 store/index.js 的文件锁保证，
// 且本仓 store 层单测一律不碰真实数据目录（dev 态 DATA_DIR 就是仓库根）。

test('UNDO_KINDS：四种撤销方式', () => {
  assert.deepEqual([...UNDO_KINDS].sort(), ['delete-apidoc', 'discard-task', 'revert-merge', 'revert-req-change']);
});

test('normalizeAction：补齐缺失字段，不丢原值', () => {
  const a = normalizeAction({ tool: 'start_dev_task', colleagueId: 'cl_1' });
  assert.equal(a.tool, 'start_dev_task');
  assert.equal(a.colleagueId, 'cl_1');
  assert.ok(a.id, '必须补 id');
  assert.ok(a.at, '必须补时间戳');
  assert.equal(a.undone, false);
  assert.equal(a.undo, null);
});

test('normalizeAction：非法 undo.kind 归一为 null，不静默放行', () => {
  assert.equal(normalizeAction({ tool: 't', undo: { kind: 'yolo' } }).undo, null);
  assert.equal(normalizeAction({ tool: 't', undo: { kind: 'revert-merge', repo: 'D:/p' } }).undo.kind, 'revert-merge');
});

test('normalizeAction：非对象输入不抛', () => {
  assert.equal(normalizeAction(null), null);
  assert.equal(normalizeAction('x'), null);
});

test('isUndoable：有 undo 且未撤销才可撤', () => {
  assert.equal(isUndoable({ undo: { kind: 'revert-merge' }, undone: false }), true);
  assert.equal(isUndoable({ undo: { kind: 'revert-merge' }, undone: true }), false, '撤过的不能再撤');
  assert.equal(isUndoable({ undo: null, undone: false }), false, 'external 档撤不回');
  assert.equal(isUndoable(null), false);
});
```

- [ ] **Step 3: 跑到失败** → `Cannot find module './agent-actions.js'`

- [ ] **Step 4: 实现**

创建 `src/store/agent-actions.js`：

```js
/**
 * Agent 写操作的撤销台账（agent-actions.json）。
 *
 * 「乐观执行 + 可撤销」这个授权模型的落地处：agent 调 reversible 工具时不等主机确认，
 * 直接执行，但每一次都在这里留一个**能把它撤回去的锚点**。主机事后一键撤销靠它。
 *
 * 为什么独立于 colleague-messages.json：那份是对话流（给人看的），这份是审计与撤销
 * （给主机看的、按时间倒序）。混在一起会让「列出所有待撤销的 AI 改动」变成一次全表扫描。
 *
 * `undo: null` 是合法值，表示 **external 档**（如退款脚本）—— 已发生、撤不回，
 * 但仍要记录供事后审计。不要把它当成「忘了填」。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'agent-actions.json';

/** 四种撤销方式，与 spec §5.2 一致 */
export const UNDO_KINDS = new Set(['revert-merge', 'delete-apidoc', 'revert-req-change', 'discard-task']);

function genId() {
  return 'aa_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 形状归一（纯函数）。
 * **非法 `undo.kind` 归一为 `null` 而不是保留原值**：留着它会让撤销分派撞上一个
 * 认不出的 kind，那时台账已经写下去、主机以为能撤。宁可当场表现为「不可撤销」。
 */
export function normalizeAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const undo = raw.undo && UNDO_KINDS.has(raw.undo.kind) ? raw.undo : null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : genId(),
    at: typeof raw.at === 'string' && raw.at ? raw.at : new Date().toISOString(),
    colleagueId: String(raw.colleagueId ?? ''),
    role: String(raw.role ?? ''),
    msgId: String(raw.msgId ?? ''),
    reqId: String(raw.reqId ?? ''),
    tool: String(raw.tool ?? ''),
    input: raw.input && typeof raw.input === 'object' ? raw.input : {},
    ok: raw.ok !== false,
    resultBrief: String(raw.resultBrief ?? '').slice(0, 200),
    undo,
    undone: raw.undone === true,
    undoneAt: typeof raw.undoneAt === 'string' ? raw.undoneAt : null,
  };
}

/** 能不能撤（纯函数）：有锚点、且没撤过 */
export function isUndoable(action) {
  return !!action && !!action.undo && action.undone !== true;
}

/** 追加一条，返回归一后的条目 */
export function appendAction(entry) {
  const item = normalizeAction(entry);
  if (!item) throw new Error('appendAction: entry 必须是对象');
  updateJson(FILE, { actions: [] }, (cur) => {
    const actions = Array.isArray(cur?.actions) ? cur.actions : [];
    return { actions: [item, ...actions] }; // 倒序存：主机看的永远是最近的
  });
  return item;
}

/** 全部条目（已归一，最近在前） */
export function getActions() {
  const raw = readJson(FILE, { actions: [] });
  return (Array.isArray(raw?.actions) ? raw.actions : []).map(normalizeAction).filter(Boolean);
}

export function getAction(id) {
  return getActions().find((a) => a.id === id) || null;
}

/** 标记已撤销（幂等：撤过的再调不报错，返回 false 表示这次没改） */
export function markUndone(id) {
  let changed = false;
  updateJson(FILE, { actions: [] }, (cur) => {
    const actions = Array.isArray(cur?.actions) ? cur.actions : [];
    return {
      actions: actions.map((a) => {
        if (a?.id !== id || a.undone === true) return a;
        changed = true;
        return { ...a, undone: true, undoneAt: new Date().toISOString() };
      }),
    };
  });
  return changed;
}
```

- [ ] **Step 5: 跑到通过 + `npm test`**

---

## Task 3: 按 repo 串行的合并队列

**Files:**
- Create: `src/entrypoints/web/merge-queue.js`
- Test: `src/entrypoints/web/merge-queue.test.js`

合并必须排队的理由（spec §7.3）：`mergeBranch` 落在**主工作区**，而 `commitAll` 的 `add -A` 会吞掉主机未提交的改动。改码阶段有 worktree 隔离可以并行，合并不行。

- [ ] **Step 1: 写失败的测试**

创建 `src/entrypoints/web/merge-queue.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMergeQueue } from './merge-queue.js';

const tick = () => new Promise((r) => setImmediate(r));

test('同一 repo 串行：第二个必须等第一个跑完才开始', async () => {
  const order = [];
  let release1;
  const q = createMergeQueue({
    isClean: async () => true,
    mergeBranch: async (repo, src) => {
      order.push('start:' + src);
      if (src === 'a') await new Promise((r) => (release1 = r));
      order.push('end:' + src);
      return { ok: true, mergeCommit: 'sha_' + src };
    },
  });
  const p1 = q.enqueue({ repo: 'D:/p', branch: 'a', baseBranch: 'main' });
  const p2 = q.enqueue({ repo: 'D:/p', branch: 'b', baseBranch: 'main' });
  await tick();
  assert.deepEqual(order, ['start:a'], 'b 不得在 a 跑完前开始');
  release1();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('不同 repo 并行：互不阻塞', async () => {
  const running = new Set();
  let maxConcurrent = 0;
  const q = createMergeQueue({
    isClean: async () => true,
    mergeBranch: async (repo) => {
      running.add(repo);
      maxConcurrent = Math.max(maxConcurrent, running.size);
      await tick();
      running.delete(repo);
      return { ok: true, mergeCommit: 'x' };
    },
  });
  await Promise.all([
    q.enqueue({ repo: 'D:/a', branch: 'x', baseBranch: 'main' }),
    q.enqueue({ repo: 'D:/b', branch: 'y', baseBranch: 'main' }),
  ]);
  assert.equal(maxConcurrent, 2, '不同 repo 应能并行');
});

// —— 这道闸防的是「主机自己没提交的改动被 add -A 卷进 agent 的合并」，
// 是 commitAll 在主工作区的已知大坑（auto-dev/revert.js:114 同款）。
test('主工作区脏 → 不合并，降级为待合并（不算失败）', async () => {
  let merged = false;
  const q = createMergeQueue({
    isClean: async () => false,
    mergeBranch: async () => { merged = true; return { ok: true, mergeCommit: 'x' }; },
  });
  const r = await q.enqueue({ repo: 'D:/p', branch: 'a', baseBranch: 'main' });
  assert.equal(merged, false, '脏工作区绝不能合并');
  assert.equal(r.ok, true, '降级不是失败');
  assert.equal(r.status, 'pending-merge');
  assert.equal(r.sha, null);
});

test('合并成功 → 返回 mergeSha（撤销台账的锚点）', async () => {
  const q = createMergeQueue({ isClean: async () => true, mergeBranch: async () => ({ ok: true, mergeCommit: 'abc123' }) });
  const r = await q.enqueue({ repo: 'D:/p', branch: 'a', baseBranch: 'main' });
  assert.equal(r.status, 'merged');
  assert.equal(r.sha, 'abc123'); // 队列对外统一叫 sha，内部读 mergeCommit
});

test('合并失败 → status=failed 且带原因，不抛', async () => {
  const q = createMergeQueue({
    isClean: async () => true,
    mergeBranch: async () => ({ ok: false, error: '冲突' }),
  });
  const r = await q.enqueue({ repo: 'D:/p', branch: 'a', baseBranch: 'main' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /冲突/);
});

test('单个任务抛错不卡死队列，后续任务仍能跑', async () => {
  let second = false;
  const q = createMergeQueue({
    isClean: async () => true,
    mergeBranch: async (repo, src) => {
      if (src === 'a') throw new Error('炸了');
      second = true;
      return { ok: true, mergeCommit: 'x' };
    },
  });
  const r1 = await q.enqueue({ repo: 'D:/p', branch: 'a', baseBranch: 'main' });
  const r2 = await q.enqueue({ repo: 'D:/p', branch: 'b', baseBranch: 'main' });
  assert.equal(r1.ok, false);
  assert.equal(second, true, '前一个抛错不得让队列停摆');
  assert.equal(r2.ok, true);
});
```

- [ ] **Step 2: 跑到失败**

- [ ] **Step 3: 实现**

创建 `src/entrypoints/web/merge-queue.js`：

```js
/**
 * agent 改码的合并队列 —— **按 repo 串行**。
 *
 * 为什么只有合并要排队（改码不用）：worktree 隔离之后，两个 agent 任务在各自目录改码
 * 互不可见，可以并行；但 `mergeBranch` 会落到**主工作区**（git 不允许两个 worktree
 * 检出同一分支，而开发期主机人就在需求分支上），那里同一时刻只能有一个人动。
 *
 * 为什么按 repo 而不是全局：前后端是两个仓库，一个在合并没理由挡住另一个。
 *
 * `isClean` 闸防的是 `commitAll` 的 `add -A` 在主工作区吞掉主机未提交的改动 ——
 * 这是本仓已知大坑（`auto-dev/revert.js:114` 同款闸）。脏则**降级为待合并而非失败**：
 * 代码已经提交在分支上不会丢，主机清干净工作区后自己点合并即可。
 */
import { isClean as realIsClean, mergeBranch as realMergeBranch } from '../../plugins/team-tools/auto-dev/git.js';
import { logger } from '../../shared/logger.js';

/**
 * @param {{isClean?: Function, mergeBranch?: Function}} [deps] 注入便于单测
 */
export function createMergeQueue(deps = {}) {
  const isClean = deps.isClean || realIsClean;
  const mergeBranch = deps.mergeBranch || realMergeBranch;

  /** repo → 该 repo 上最后一个任务的 Promise（链式串联即串行） */
  const tails = new Map();

  async function runOne({ repo, branch, baseBranch }) {
    if (!(await isClean(repo))) {
      logger.warn('merge-queue', '主工作区不干净，降级为待合并', { repo, branch });
      return { ok: true, status: 'pending-merge', sha: null };
    }
    const r = await mergeBranch(repo, branch, baseBranch);
    if (!r?.ok) return { ok: false, status: 'failed', sha: null, error: r?.error || '合并失败' };
    // ⚠️ git.js 返回的字段叫 mergeCommit，不叫 sha；且它**取不到时是空串不是缺失**
    //（该函数 JSDoc 原话：「消费方要用 if (!mergeCommit) 而不是判字段存在」）。
    // 队列对外统一暴露 sha，空串一律归一成 null —— 撤销分派靠 null 判「还没合并」。
    return { ok: true, status: 'merged', sha: r.mergeCommit || null };
  }

  return {
    /**
     * 排队合并一个 agent 分支。
     * @returns {Promise<{ok, status:'merged'|'pending-merge'|'failed', sha, error?}>} **不抛**
     */
    enqueue(task) {
      const prev = tails.get(task.repo) || Promise.resolve();
      // 用 .then 而非 await prev：前一个任务的失败绝不能让后面的整条链断掉。
      // catch 收在 runOne 外层，保证 tails 上挂的永远是一个必定 resolve 的 Promise。
      const next = prev.then(() =>
        runOne(task).catch((e) => {
          logger.warn('merge-queue', '合并任务异常', { repo: task.repo, branch: task.branch, err: e?.message || String(e) });
          return { ok: false, status: 'failed', sha: null, error: e?.message || String(e) };
        }),
      );
      tails.set(task.repo, next.then(() => {}, () => {}));
      return next;
    },
  };
}

/** 进程内单例：合并的串行性必须全进程唯一，每次 new 一个等于没有队列 */
export const mergeQueue = createMergeQueue();
```

- [ ] **Step 4: 跑到通过 + `npm test`**

> 已核实（2026-09-23）：`mergeBranch(repo, source, target)` 返回
> `{ ok, conflict?, hookBypassed?, mergeCommit?, error? }`，**`mergeCommit` 取不到时是空串**。
> 队列内部读 `r.mergeCommit`、对外统一暴露 `sha`，空串归一成 `null`。

---

## Task 4: `colleague-dev.js` 接入 worktree + 提交 + 合并 + 台账

**Files:**
- Modify: `src/entrypoints/web/colleague-dev.js`
- Modify: `src/entrypoints/web/colleague-dev.test.js`

这是本期唯一改动在跑功能的 Task。四期的自动处理走的就是这条路，改完它立刻获得可撤销能力。

- [ ] **Step 1: 读现状**

```bash
cat src/entrypoints/web/colleague-dev.js
cat src/entrypoints/web/colleague-dev.test.js
```

现状：`dispatchColleagueDev` 取 `pickCwdAndDirs(req.projects)` 的主工作区当 cwd，`buildColleagueDevOnSettle` 清 busy / 回填 sessionId / `markHandled` / 回简报。**没有任何提交与合并。**

- [ ] **Step 2: 写失败的测试**

⚠️ **先看清这个文件的测试写法**，别照搬纯 mock 风格：

```js
// colleague-dev.test.js:7 —— 它用真实 store，靠临时数据目录隔离
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'colleague-dev-'));
const { ... } = await import('./colleague-dev.js');   // 必须在设置 env 之后动态 import
const { createRequirement, updateRequirement } = await import('../../store/requirements.js');
```

新用例照这个来：`setupReq()` 造真需求与真同事，只把 **git / 合并 / 台账** 三类外部副作用注入成假的。

⚠️ **第二件事：`buildColleagueDevOnSettle` 现在是 3 参**（`reqId, payload, convId`），文件里有 **4 条既有用例**这么调。加第 4 个 `gitCtx` 参数时：

- **把那 4 条既有用例一并改成显式传 `gitCtx`**（传一组 no-op 假依赖即可），不要依赖「缺参就跳过提交合并」的隐式回退
- 实现里缺 `gitCtx` 仍要 `logger.warn` 后跳过（防生产漏传时静默不提交），但**不能有任何测试依赖这条路径** —— 有测试依赖它，它就会从「防御」变成「被默许的正常路径」

下面的用例是行为描述，**参数形状按你实际落的实现调整**，但每一条断言的行为都不能少：

```js
test('dispatchColleagueDev：cwd 是 per-需求 worktree，不是主工作区', async () => {
  const req = { id: 'r_abc12345', phase: 'dev', projects: { frontend: { dir: 'D:/fe' } }, sessions: [], branches: [{ dir: 'D:/fe', branch: 'feat/x', baseBranch: 'main' }] };
  let seenCwd = null;
  await dispatchColleagueDev(req, { msgId: 'm1', colleagueId: 'cl_1', prompt: 'p', title: 't' }, {
    start: (_run, opts) => { seenCwd = opts.cwd; },
    ensureReqWorktree: async () => ({ ok: true, dir: 'D:/fe.req-r_abc123' }),
    commitResidue: async () => ({ committed: false, dirty: false }),
    checkoutNewFromBase: async () => ({ ok: true }),
  });
  assert.equal(seenCwd, 'D:/fe.req-r_abc123');
  assert.notEqual(seenCwd, 'D:/fe', '绝不能在主工作区改码');
});

test('dispatchColleagueDev：worktree 建不起来 → 作废并告知同事，不起 run', async () => {
  const req = { id: 'r_abc12345', phase: 'dev', projects: { frontend: { dir: 'D:/fe' } }, sessions: [], branches: [] };
  let started = false;
  await dispatchColleagueDev(req, { msgId: 'm1', colleagueId: 'cl_1', prompt: 'p', title: 't' }, {
    start: () => { started = true; },
    ensureReqWorktree: async () => ({ ok: false, error: '目录已存在但不是本仓库的 worktree' }),
  });
  assert.equal(started, false);
});

test('onSettle 成功路径：commitAll → 入合并队列 → 写撤销台账', async () => {
  const calls = { commit: 0, merge: 0, ledger: null };
  const onSettle = buildColleagueDevOnSettle('r_abc12345', { msgId: 'm1', colleagueId: 'cl_1', title: 't' }, 'c1', {
    workDir: 'D:/fe.req-r_abc123', repo: 'D:/fe', branch: 'req/r_abc12345/agent-m1', baseBranch: 'feat/x',
    commitAll: async () => { calls.commit++; return { ok: true }; },
    enqueueMerge: async () => { calls.merge++; return { ok: true, status: 'merged', sha: 'sha123' }; },
    appendAction: (a) => { calls.ledger = a; return a; },
  });
  await onSettle(true, { id: 'run1', session_id: 's1', result: '改完了' });
  assert.equal(calls.commit, 1);
  assert.equal(calls.merge, 1);
  assert.equal(calls.ledger.undo.kind, 'revert-merge');
  assert.equal(calls.ledger.undo.mergeSha, 'sha123');
  assert.equal(calls.ledger.undo.branch, 'req/r_abc12345/agent-m1');
});

// —— 「无改动即失败」是防谎报闸：模型说改完了但一行没动，不该留下一条假的可撤销记录
test('onSettle：commitAll 报无改动 → 不入合并队列、不写台账', async () => {
  const calls = { merge: 0, ledger: 0 };
  const onSettle = buildColleagueDevOnSettle('r_abc12345', { msgId: 'm1', colleagueId: 'cl_1', title: 't' }, 'c1', {
    workDir: 'D:/w', repo: 'D:/fe', branch: 'b', baseBranch: 'main',
    commitAll: async () => ({ ok: false, error: '无改动' }),
    enqueueMerge: async () => { calls.merge++; return { ok: true, status: 'merged', sha: 'x' }; },
    appendAction: () => { calls.ledger++; },
  });
  await onSettle(true, { id: 'run1', result: '' });
  assert.equal(calls.merge, 0);
  assert.equal(calls.ledger, 0);
});

test('onSettle：合并降级待合并时仍写台账（分支在，撤得回）', async () => {
  let ledger = null;
  const onSettle = buildColleagueDevOnSettle('r_abc12345', { msgId: 'm1', colleagueId: 'cl_1', title: 't' }, 'c1', {
    workDir: 'D:/w', repo: 'D:/fe', branch: 'b', baseBranch: 'main',
    commitAll: async () => ({ ok: true }),
    enqueueMerge: async () => ({ ok: true, status: 'pending-merge', sha: null }),
    appendAction: (a) => { ledger = a; return a; },
  });
  await onSettle(true, { id: 'run1', result: 'ok' });
  assert.ok(ledger, '待合并也要留痕');
  assert.equal(ledger.undo.mergeSha, null);
  assert.equal(ledger.undo.kind, 'revert-merge');
});

test('onSettle：run 失败时不提交不合并', async () => {
  const calls = { commit: 0, merge: 0 };
  const onSettle = buildColleagueDevOnSettle('r_abc12345', { msgId: 'm1', colleagueId: 'cl_1', title: 't' }, 'c1', {
    workDir: 'D:/w', repo: 'D:/fe', branch: 'b', baseBranch: 'main',
    commitAll: async () => { calls.commit++; return { ok: true }; },
    enqueueMerge: async () => { calls.merge++; return { ok: true, status: 'merged', sha: 'x' }; },
    appendAction: () => {},
  });
  await onSettle(false, { id: 'run1' });
  assert.equal(calls.commit, 0);
  assert.equal(calls.merge, 0);
});
```

- [ ] **Step 3: 跑到失败**

- [ ] **Step 4: 实现**

改造要点（保持既有导出名与外部行为，只加不删）：

1. `dispatchColleagueDev(req, payload, deps)` 增加依赖注入 `ensureReqWorktree` / `commitResidue` / `checkoutNewFromBase`，并改为 **async**：
   - `repo = pickCwdAndDirs(req.projects).cwd`（主工作区路径，仅用于定位仓库与合并目标）
   - `ensureReqWorktree(repo, req.id)` → 失败则 `abandonColleagueDev` 并 return
   - `commitResidue(dir)` 自愈上次残留
   - `branch = 'req/' + req.id + '/agent-' + payload.msgId`，`baseBranch` 取 `req.branches.find(b => b.dir === repo)?.branch`，取不到退到 `currentBranch(repo)`
   - `checkoutNewFromBase(dir, branch, baseBranch)`
   - `start(run, { prompt, cwd: dir, addDirs, mode: 'bypassPermissions', convId })`
   - 把 `{ workDir: dir, repo, branch, baseBranch }` 传给 `buildColleagueDevOnSettle`

2. `buildColleagueDevOnSettle(reqId, payload, convId, gitCtx)` 增加第四参，在**既有收尾逻辑之前**插入提交与合并：
   - `ok === false` → 跳过提交合并，走原路径
   - `commitAll(workDir, msg)` 失败（含「无改动」）→ 不合并不写台账，回同事的简报按失败处理
   - 成功 → `enqueueMerge({repo, branch, baseBranch})` → `appendAction({ tool:'start_dev_task', reqId, colleagueId, msgId, undo:{ kind:'revert-merge', repo, branch, baseBranch, mergeSha } })`

   ⚠️ **已核实（2026-09-23），这条决定了 onSettle 必须怎么写：**

   ```js
   // src/entrypoints/web/run-claude.js:357-365
   if (typeof run.onSettle === 'function') {
     try { run.onSettle(ok, run); }            // ← 同步调用，不 await
     catch (e) { logger.warn(...); }           // ← 只接同步抛错
     run.onSettle = null;
   }
   if (err) failRun(run, ...); else finishRun(run);   // ← 紧接着就终结 run
   ```

   两个后果，**都必须在实现里处理**：

   1. **`onSettle` 不能声明成 async 后就不管**。返回的 Promise 没人等，里面的 rejection 外层 `try/catch` 也接不住 → unhandled rejection。做法是：`onSettle` 保持**同步返回**，内部把提交/合并/台账串成一条 fire-and-forget 的 Promise 链，**链尾自带 `.catch`**（同 `replyColleague(...).catch(() => {})` 的既有写法）。
   2. **回同事简报必须挪进那条链里**。现在的代码在 `onSettle` 体内直接 `replyColleague(buildBrief(ok, ...))`；若不挪，同事会先收到「已处理完成」，几秒后合并才失败 —— 而他已经以为可以联调了。正确顺序是 `commitAll → enqueueMerge → appendAction → replyColleague(按合并结果措辞)`。

   `markHandled` 与清 `busy` 的时机要分开看：**清 `busy` 仍留在同步段**（串行闸必须立刻放开，否则该需求的下一个任务要等合并排完队）；`markHandled` 与简报进异步链。

   **落地形状**（让生产与测试都成立）：

   ```js
   export function buildColleagueDevOnSettle(reqId, payload, convId, gitCtx) {
     return (ok, run) => {
       // —— 同步段：清 busy + 回填 sessionId，必须立刻做完（串行闸等着放开）
       ...既有逻辑...

       // —— 异步段：提交 → 合并 → 台账 → 回同事。**返回这条链**，但链尾自带 catch。
       //    生产侧 run-claude.js:360 同步调用、忽略返回值，靠 catch 兜住 rejection；
       //    测试侧 `await onSettle(...)` 能等到全链走完再断言。两边都成立。
       return finishAsync(ok, run, gitCtx).catch((e) => {
         logger.warn('colleague-dev', '收尾链异常', { reqId, err: e?.message || String(e) });
       });
     };
   }
   ```

   **别把 `.catch` 写在 `finishAsync` 内部再 `return undefined`** —— 那样测试 `await` 到的是 undefined，断言不到链内的副作用顺序。

3. 提交信息走 commitlint 规范（参考 `auto-dev/logic.js` 的既有提交信息纯函数）。

- [ ] **Step 5: 跑到通过 + `npm test`**

---

## Task 5: `register_api_doc` 工具

**Files:**
- Create: `src/plugins/colleague-agent/tools/req-write.js`
- Test: `src/plugins/colleague-agent/tools/req-write.test.js`

- [ ] **Step 1: 读既有登记逻辑**

```bash
grep -n "export function registerApiDoc" -A 40 src/entrypoints/web/requirement-ops.js
```

它已处理：phase 守卫（仅 dev）、文件存在性、存档（`storeApiDocFile`）、同名更新 / 否则新增、history 留痕。**原样复用，不要重写。**

- [ ] **Step 2: 写失败的测试**

创建 `src/plugins/colleague-agent/tools/req-write.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReqWriteTools, REQ_WRITE_TOOL_NAMES } from './req-write.js';

const REQ_DEV = { id: 'r_a1', title: '订单改版', phase: 'dev', assignees: ['cl_1'], projects: { frontend: { dir: 'D:/fe' } }, apiDocs: [] };
const REQ_TEST = { ...REQ_DEV, id: 'r_t1', phase: 'test' };

function deps(extra = {}) {
  return {
    getRequirement: (id) => ({ r_a1: REQ_DEV, r_t1: REQ_TEST })[id] || null,
    registerApiDoc: () => ({ ok: true, doc: { id: 'd1', name: 'order.md' } }),
    enqueueSystemTask: () => ({ ok: true }),
    appendAction: (a) => a,
    ...extra,
  };
}
const pick = (tools, name) => tools.find((t) => t.name === name);

test('REQ_WRITE_TOOL_NAMES：P2 恰好两个工具，且与实际装配一致', () => {
  assert.deepEqual(REQ_WRITE_TOOL_NAMES, ['register_api_doc', 'start_dev_task']);
  assert.deepEqual(buildReqWriteTools(deps()).map((t) => t.name), REQ_WRITE_TOOL_NAMES);
});

test('两个工具都是 reversible，且都给得出 buildUndo（注册期不变式）', () => {
  for (const t of buildReqWriteTools(deps())) {
    assert.equal(t.danger, 'reversible', t.name);
    assert.equal(typeof t.buildUndo, 'function', t.name);
  }
});

test('register_api_doc：只对 backend 可见', () => {
  assert.deepEqual(pick(buildReqWriteTools(deps()), 'register_api_doc').roles, ['backend']);
});

test('register_api_doc：非参与人拒绝（fail-closed）', async () => {
  const t = pick(buildReqWriteTools(deps()), 'register_api_doc');
  const out = await t.handler({ reqId: 'r_a1', name: 'a.md', path: 'D:/a.md' }, { colleagueId: 'cl_9' });
  assert.ok(out.error);
});

test('register_api_doc：非开发期拒绝（registerApiDoc 自己也拦，这里提前给人话）', async () => {
  const t = pick(buildReqWriteTools(deps()), 'register_api_doc');
  const out = await t.handler({ reqId: 'r_t1', name: 'a.md', path: 'D:/a.md' }, { colleagueId: 'cl_1' });
  assert.match(out.error, /开发期/);
});

test('register_api_doc：成功时返回可读结果，并给出 delete-apidoc 撤销锚点', async () => {
  const t = pick(buildReqWriteTools(deps()), 'register_api_doc');
  const input = { reqId: 'r_a1', name: 'order.md', path: 'D:/order.md' };
  const out = await t.handler(input, { colleagueId: 'cl_1' });
  assert.equal(out.ok, true);
  const undo = t.buildUndo(input, out, { colleagueId: 'cl_1' });
  assert.equal(undo.kind, 'delete-apidoc');
  assert.equal(undo.reqId, 'r_a1');
  assert.equal(undo.name, 'order.md');
});

test('register_api_doc：底层失败时不返回 ok，也不产出撤销锚点', async () => {
  const d = deps({ registerApiDoc: () => ({ ok: false, error: '文件不存在' }) });
  const t = pick(buildReqWriteTools(d), 'register_api_doc');
  const out = await t.handler({ reqId: 'r_a1', name: 'a.md', path: 'D:/a.md' }, { colleagueId: 'cl_1' });
  assert.ok(out.error);
  assert.notEqual(out.ok, true);
});
```

- [ ] **Step 3: 跑到失败**

- [ ] **Step 4: 实现 `register_api_doc`**（`start_dev_task` 留到 Task 6）

创建 `src/plugins/colleague-agent/tools/req-write.js`，先只放 `register_api_doc`，形状与 `req-read.js` 一致（依赖注入 + fail-closed 可见性 + 只返回摘要）。`danger: 'reversible'`，`roles: ['backend']`，`buildUndo` 返回 `{ kind: 'delete-apidoc', reqId, name }`。

- [ ] **Step 5: 跑到通过**（`start_dev_task` 的用例此时应因缺失而失败 —— 这是预期，Task 6 补上）

---

## Task 6: `start_dev_task` 工具

**Files:**
- Modify: `src/plugins/colleague-agent/tools/req-write.js`
- Modify: `src/plugins/colleague-agent/tools/req-write.test.js`
- Modify: `src/plugins/colleague-agent/index.js`（注册这两个工具）

- [ ] **Step 1: 写失败的测试**

追加：

```js
test('start_dev_task：backend / product / qa 可见', () => {
  assert.deepEqual(pick(buildReqWriteTools(deps()), 'start_dev_task').roles.sort(), ['backend', 'product', 'qa']);
});

test('start_dev_task：非开发期拒绝', async () => {
  const t = pick(buildReqWriteTools(deps()), 'start_dev_task');
  const out = await t.handler({ reqId: 'r_t1', task: '改字段' }, { colleagueId: 'cl_1' });
  assert.match(out.error, /开发期/);
});

// —— spec §6.2：归属判错会把改动落到别的需求的分支上，让最知道答案的人当场看见
test('start_dev_task：回复必须明写目标需求标题与分支，供同事当场纠错', async () => {
  const t = pick(buildReqWriteTools(deps()), 'start_dev_task');
  const out = await t.handler({ reqId: 'r_a1', task: '把分页参数改成 pageNo' }, { colleagueId: 'cl_1', msgId: 'm1' });
  assert.equal(out.ok, true);
  assert.match(out.reply, /订单改版/, '必须带需求标题');
  assert.match(out.reply, /r_a1|分支/, '必须带需求 id 或分支名');
});

test('start_dev_task：入队参数带 msgId / colleagueId（收尾要靠它们标记消息）', async () => {
  let payload = null;
  const d = deps({ enqueueSystemTask: (_reqId, _kind, p) => { payload = p; return { ok: true }; } });
  const t = pick(buildReqWriteTools(d), 'start_dev_task');
  await t.handler({ reqId: 'r_a1', task: 'x' }, { colleagueId: 'cl_1', msgId: 'm1' });
  assert.equal(payload.msgId, 'm1');
  assert.equal(payload.colleagueId, 'cl_1');
  assert.ok(payload.prompt);
  assert.ok(payload.title);
});

// —— 真正的撤销锚点（mergeSha）要等 run 跑完才有，由 colleague-dev 的 onSettle 写台账。
// 工具这一刻只能给出「哪个需求哪条消息起的任务」，供 onSettle 关联。
test('start_dev_task：buildUndo 给出 revert-merge 骨架，mergeSha 留空待 onSettle 回填', async () => {
  const t = pick(buildReqWriteTools(deps()), 'start_dev_task');
  const input = { reqId: 'r_a1', task: 'x' };
  const out = await t.handler(input, { colleagueId: 'cl_1', msgId: 'm1' });
  const undo = t.buildUndo(input, out, { colleagueId: 'cl_1', msgId: 'm1' });
  assert.equal(undo.kind, 'revert-merge');
  assert.equal(undo.reqId, 'r_a1');
  assert.equal(undo.mergeSha, null);
});

test('start_dev_task：入队失败时如实返回错误', async () => {
  const d = deps({ enqueueSystemTask: () => ({ ok: false, error: '需求忙' }) });
  const t = pick(buildReqWriteTools(d), 'start_dev_task');
  const out = await t.handler({ reqId: 'r_a1', task: 'x' }, { colleagueId: 'cl_1', msgId: 'm1' });
  assert.ok(out.error);
});
```

- [ ] **Step 2: 跑到失败**

- [ ] **Step 3: 实现**

`start_dev_task(reqId, task)`：
- fail-closed 可见性 + phase 守卫（仅 dev）
- `enqueueSystemTask(reqId, 'colleague-dev', { msgId, colleagueId, prompt, title })`
- 返回 `{ ok: true, reply: '好，我按需求《<标题>》处理，改在分支 <branch> 上' }`
- `buildUndo` 返回 `{ kind: 'revert-merge', reqId, msgId, repo: null, branch: null, baseBranch: null, mergeSha: null }` —— 骨架，真值由 onSettle 回填

- [ ] **Step 4: 在插件里注册**

`src/plugins/colleague-agent/index.js` 追加：

```js
import { buildReqWriteTools } from './tools/req-write.js';

for (const def of [...buildReqReadTools(), ...buildReqWriteTools()]) {
  assertRoles(def);
  registerAgentTool(def);
}
```

并把 `index.test.js` 里「工具自注册」那条用例的期望扩成 read + write 两组。

- [ ] **Step 5: 验证装配**

```bash
node -e "import('./src/plugins/colleague-agent/index.js').then(async()=>{const m=await import('./src/capabilities/agent-tools.js');console.log(m.listAgentTools().map(t=>t.name+':'+t.danger));const b=m.buildAgentMcpServer('backend');console.log('backend 可见:',[...b.allowed].length);const q=m.buildAgentMcpServer('qa');console.log('qa 可见:',[...q.allowed].length);})"
```

预期：7 个工具（5 safe + 2 reversible）；backend 看得到全部 7 个，qa 看不到 `register_api_doc`（6 个）。

- [ ] **Step 6: `npm test`**

---

## Task 7: 撤销执行

**Files:**
- Create: `src/entrypoints/web/undo-agent-action.js`
- Test: `src/entrypoints/web/undo-agent-action.test.js`

- [ ] **Step 1: 写失败的测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undoAgentAction } from './undo-agent-action.js';

function deps(extra = {}) {
  return {
    getAction: (id) => ({ aa_1: { id: 'aa_1', undone: false, undo: { kind: 'revert-merge', repo: 'D:/fe', branch: 'b', baseBranch: 'main', mergeSha: 'sha1' } } })[id] || null,
    markUndone: () => true,
    revertMergeCommit: async () => ({ ok: true }),
    deleteApiDoc: () => ({ ok: true }),
    ...extra,
  };
}

test('撤销不存在的记录 → 明确错误', async () => {
  const r = await undoAgentAction('aa_nope', deps());
  assert.equal(r.ok, false);
});

test('已撤销过的不重复撤（幂等，防两次 revert）', async () => {
  const d = deps({ getAction: () => ({ id: 'aa_1', undone: true, undo: { kind: 'revert-merge' } }) });
  let called = false;
  d.revertMergeCommit = async () => { called = true; return { ok: true }; };
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, false);
  assert.equal(called, false, '撤过的绝不能再撤一次');
});

test('undo=null（external 档）→ 明确说撤不回，不假装成功', async () => {
  const d = deps({ getAction: () => ({ id: 'aa_1', undone: false, undo: null }) });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, false);
  assert.match(r.error, /撤不回|不可撤销/);
});

test('revert-merge：调 revertMergeCommit 并标记已撤销', async () => {
  let seen = null;
  const d = deps({ revertMergeCommit: async (repo, opts) => { seen = { repo, opts }; return { ok: true }; } });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, true);
  assert.equal(seen.repo, 'D:/fe');
  assert.equal(seen.opts.mergeCommit, 'sha1');
});

// —— 撤销失败绝不能标记为已撤销：标了之后主机再也点不了那个按钮，
// 而改动其实还在分支上，等于把问题永久藏起来
test('撤销失败 → 不标记 undone', async () => {
  let marked = false;
  const d = deps({ revertMergeCommit: async () => ({ ok: false, error: '冲突' }), markUndone: () => { marked = true; return true; } });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, false);
  assert.equal(marked, false);
});

test('mergeSha 为 null（待合并态）→ 走删分支而非 revert', async () => {
  let deleted = null;
  const d = deps({
    getAction: () => ({ id: 'aa_1', undone: false, undo: { kind: 'revert-merge', repo: 'D:/fe', branch: 'b', baseBranch: 'main', mergeSha: null } }),
    deleteBranch: async (repo, br) => { deleted = { repo, br }; return { ok: true }; },
  });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, true);
  assert.deepEqual(deleted, { repo: 'D:/fe', br: 'b' });
});

test('未知 kind → 拒绝，不静默成功', async () => {
  const d = deps({ getAction: () => ({ id: 'aa_1', undone: false, undo: { kind: '未来的某种撤销' } }) });
  const r = await undoAgentAction('aa_1', d);
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: 跑到失败**

- [ ] **Step 3: 实现**

`undoAgentAction(id, deps)` 按 `undo.kind` 分派：
- `revert-merge`：`mergeSha` 有 → `revertMergeCommit(repo, { task: { branch, baseBranch }, mergeCommit: mergeSha })`；`mergeSha` 为 null（还没合并）→ `deleteBranch(repo, branch)`
- `delete-apidoc`：删该需求同名 apiDoc + history 留痕
- `revert-req-change` / `discard-task`：P4 才产生这两种，**本期显式返回「暂不支持」而不是静默成功**
- 成功才 `markUndone(id)`

- [ ] **Step 4: 跑到通过 + `npm test`**

---

## P2 完成标准

- [ ] `npm test` 全绿
- [ ] `node -e` 装配验证：7 个工具，backend 7 个 / qa 6 个
- [ ] `node scripts/agent-probe.mjs --role backend --text "..."` 仍正常（P1 回归）
- [ ] 手工验收：在一个开发期需求上跑通「agent 起改码任务 → 落在 `<repo>.req-xxx` → 提交 → 合并回需求分支 → 台账有 revert-merge 锚点 → 撤销能撤回去」
- [ ] 改动全部留工作区，未提交

## 已知留到后续期的

- 主机飞书卡片推送与 web 撤销 UI → P5
- `submit_req_change` / `report_bug` / `supplement_requirement` / `run_action` / `tracking_report` → P4
- 飞书入口合并 + `colleague-messages` 迁移 + 限流 + `colleague-relay` 下线 → P3

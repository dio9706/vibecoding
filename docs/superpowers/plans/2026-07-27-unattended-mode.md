# 无人值守模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在需求/故障面板加一个默认关闭的「无人值守」胶囊开关；开启后自动串行处理存量+新到的需求/BUG，逐条回来源飞书会话，全部处理完时把无人值守分支做 DEV 编译并将二维码+标题清单发到群 `oc_24f041c3815632e4b475a5f269cac34a`。

**Architecture:** 控制器循环跑在 claude-web 进程，靠轮询共享 `tasks.json` 感知任务，串行调 `task-ops.develop` 在目标仓库（`getUiPrefs().taskProjectDir || kxmall-app-ui`）的 `unattended/<日期>` 分支上真改码并逐条 commit。飞书收集侧（claude-feishu）补存来源 chatId。编译复用 `get_qrcode.py` dev 流程（加 `--branch` 覆盖）+ OSS 二维码 URL，经 `lark.sendImageByUrl` 发群。

**Tech Stack:** Node ESM（无构建后端）、原生 ES modules 前端（无构建）、`node --test` 单测、`@larksuiteoapi/node-sdk`（已封装于 `src/integrations/lark.js`）、git CLI（经 `src/integrations/shell.js runScript`）、Python 脚本（`get_qrcode.py`）。

> 提交约定：本仓库习惯改动留工作区、由用户主动 `提交`。下列 commit 步骤保留（便于分任务回溯），执行者可按用户意愿合并或延后提交。当前分支 `v2.0.0`。

---

## 文件结构

**新建：**
- `src/store/unattended.js` — 开关/分支/本轮批次状态，落盘 `unattended.json`
- `src/plugins/team-tools/unattended/logic.js` — 纯逻辑（选下一步/分支名/提交信息/群消息/解析二维码 URL）
- `src/plugins/team-tools/unattended/logic.test.js`
- `src/plugins/team-tools/unattended/git.js` — git 封装（建/切分支、commit、push）
- `src/plugins/team-tools/unattended/git.test.js`
- `src/plugins/team-tools/unattended/compile.js` — DEV 编译适配器（push+脚本+解析 URL）
- `src/plugins/team-tools/unattended/index.js` — 控制器循环（enable/disable/pump/resumeOnBoot）

**修改：**
- `src/shared/config.js` — 加 `config.unattended`
- `src/shared/config.test.js` — 断言默认值
- `src/plugins/team-tools/feedback/index.js` — `source` 补 `chatId`
- `src/entrypoints/web/routes-ops.js` — `handleTasks` 附带 unattended 状态；新增 `handleUnattended`
- `src/entrypoints/web/server.js` — 注册 `/api/unattended` 路由 + 启动 `resumeOnBoot()` + 访问日志跳过项
- `public/index.html` — 任务面板加胶囊开关 + 信息行
- `public/js/tasks-panel.js` — 渲染开关态、绑定切换、开启态隐藏「开始开发」
- `public/app.css` — 胶囊样式
- `scripts/get_qrcode.py` — 加 `--branch` 覆盖（git-ignored 配套）
- `.gitignore` — 加 `unattended.json`

---

## Task 1: config.unattended 配置

**Files:**
- Modify: `src/shared/config.js`（在 `config` 对象内、`taskTriage` 后追加）
- Test: `src/shared/config.test.js`

- [ ] **Step 1: 写失败测试**

在 `src/shared/config.test.js` 末尾追加（沿用文件已有的 `import test from 'node:test'` / `import assert`；若无则在顶部补上）：

```js
test('config.unattended 提供默认群 ID 与编译脚本名', () => {
  assert.equal(config.unattended.groupId, 'oc_24f041c3815632e4b475a5f269cac34a');
  assert.equal(config.unattended.compileScript, 'get_qrcode.py');
  assert.equal(config.unattended.branchPrefix, 'unattended');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/shared/config.test.js`
Expected: FAIL（`Cannot read properties of undefined (reading 'groupId')`）

- [ ] **Step 3: 加配置**

在 `src/shared/config.js` 的 `config` 对象里，`taskTriage: { ... },` 之后加：

```js
  unattended: {
    // 全部处理完后二维码+标题清单要发到的群 chat_id
    groupId: process.env.UNATTENDED_GROUP_ID || 'oc_24f041c3815632e4b475a5f269cac34a',
    // DEV 编译脚本（在 config.scripts.dir 下），需支持 --env dev --branch <name>
    compileScript: process.env.UNATTENDED_COMPILE_SCRIPT || 'get_qrcode.py',
    // 无人值守分支前缀
    branchPrefix: 'unattended',
  },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/shared/config.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/config.js src/shared/config.test.js
git commit -m "feat(unattended): 新增 config.unattended 配置"
```

---

## Task 2: unattended 状态存储

**Files:**
- Create: `src/store/unattended.js`
- Test: `src/store/unattended.test.js`

- [ ] **Step 1: 写失败测试**

`src/store/unattended.test.js`（先设临时数据目录再动态 import store，避免污染仓库根 `unattended.json`；store/index.js 在加载时读 `APP_DATA_DIR`）：

```js
import test from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'unatt-'));
const store = await import('./unattended.js');

test('默认状态：关闭、空批次', () => {
  const s = store.getState();
  assert.equal(s.enabled, false);
  assert.deepEqual(s.batch, []);
});

test('setBranch/addToBatch/clearBatch 往返', () => {
  store.setEnabled(true);
  store.setBranch('/repo', 'unattended/20260727-1430');
  let s = store.getState();
  assert.equal(s.enabled, true);
  assert.equal(s.branch, 'unattended/20260727-1430');
  assert.equal(s.repo, '/repo');

  store.addToBatch({ taskId: 't1', title: '标题', type: 'bug', ok: true });
  s = store.getState();
  assert.equal(s.batch.length, 1);
  assert.equal(s.batch[0].taskId, 't1');

  store.clearBatch();
  assert.deepEqual(store.getState().batch, []);

  store.setEnabled(false);
  assert.equal(store.getState().enabled, false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/store/unattended.test.js`
Expected: FAIL（`Cannot find module './unattended.js'`）

- [ ] **Step 3: 实现 store**

`src/store/unattended.js`：

```js
/**
 * 无人值守状态存储 —— 落盘 unattended.json（跨进程写走 updateJson 锁）。
 * enabled 由 web 面板切换；repo/branch 快照自开启时；batch 累计本轮已处理，编译后清空。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'unattended.json';
const DEFAULT = {
  enabled: false,
  repo: null,
  branch: null,
  startedAt: null,
  batch: [], // [{ taskId, title, type, ok }]
  compiledAt: null,
};

export function getState() {
  return { ...DEFAULT, ...readJson(FILE, {}) };
}

export function setEnabled(enabled) {
  return updateJson(FILE, DEFAULT, (s) => ({ ...DEFAULT, ...s, enabled: !!enabled }));
}

export function setBranch(repo, branch) {
  return updateJson(FILE, DEFAULT, (s) => ({
    ...DEFAULT,
    ...s,
    repo,
    branch,
    startedAt: new Date().toISOString(),
    batch: [],
    compiledAt: null,
  }));
}

export function addToBatch(item) {
  return updateJson(FILE, DEFAULT, (s) => {
    const cur = { ...DEFAULT, ...s };
    cur.batch = [...(cur.batch || []), item];
    cur.compiledAt = null; // 新一轮开始
    return cur;
  });
}

export function clearBatch() {
  return updateJson(FILE, DEFAULT, (s) => ({ ...DEFAULT, ...s, batch: [] }));
}

export function markCompiled() {
  return updateJson(FILE, DEFAULT, (s) => ({ ...DEFAULT, ...s, compiledAt: new Date().toISOString() }));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/store/unattended.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add src/store/unattended.js src/store/unattended.test.js
git commit -m "feat(unattended): 新增状态存储 unattended.json"
```

---

## Task 3: 纯逻辑 logic.js

**Files:**
- Create: `src/plugins/team-tools/unattended/logic.js`
- Test: `src/plugins/team-tools/unattended/logic.test.js`

- [ ] **Step 1: 写失败测试**

`src/plugins/team-tools/unattended/logic.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert';
import {
  isDrained,
  pickNext,
  buildBranchName,
  buildCommitMessage,
  buildGroupMessage,
  parseQrUrl,
} from './logic.js';

const T = (over) => ({ id: 't', type: 'feature', title: 't', status: 'new', createdAt: '2026-07-27T00:00:00Z', ...over });

test('isDrained：有活跃任务=false，全终态=true', () => {
  assert.equal(isDrained([T({ status: 'analyzed' })]), false);
  assert.equal(isDrained([T({ status: 'done' }), T({ status: 'rejected' })]), true);
  assert.equal(isDrained([]), true);
});

test('pickNext：优先 develop 已分析（bug 先、旧先）', () => {
  const tasks = [
    T({ id: 'a', type: 'feature', status: 'analyzed', createdAt: '2026-07-27T01:00:00Z' }),
    T({ id: 'b', type: 'bug', status: 'analyzed', createdAt: '2026-07-27T02:00:00Z' }),
  ];
  const n = pickNext(tasks);
  assert.equal(n.action, 'develop');
  assert.equal(n.task.id, 'b'); // bug 优先
});

test('pickNext：无已分析、有 new 且无进行中 → analyze', () => {
  const n = pickNext([T({ id: 'a', status: 'new' })]);
  assert.equal(n.action, 'analyze');
  assert.equal(n.task.id, 'a');
});

test('pickNext：有 analyzing → wait', () => {
  assert.equal(pickNext([T({ status: 'analyzing' })]).action, 'wait');
});

test('pickNext：全终态 → idle', () => {
  assert.equal(pickNext([T({ status: 'done' })]).action, 'idle');
});

test('buildBranchName 固定日期', () => {
  assert.equal(buildBranchName(new Date(2026, 6, 27, 14, 30)), 'unattended/20260727-1430');
});

test('buildCommitMessage：bug=fix、feature=feat、失败带标记', () => {
  assert.equal(buildCommitMessage({ type: 'bug', title: '闪退', id: 't1' }, true), 'fix: 闪退 (task t1)');
  assert.equal(buildCommitMessage({ type: 'feature', title: '加按钮', id: 't2' }, false), 'feat: 加按钮 [failed] (task t2)');
});

test('buildGroupMessage：仅标题、图标区分', () => {
  const msg = buildGroupMessage([
    { title: '闪退', type: 'bug' },
    { title: '加按钮', type: 'feature' },
  ]);
  assert.match(msg, /已处理 2 项/);
  assert.match(msg, /🐞 闪退/);
  assert.match(msg, /✦ 加按钮/);
});

test('parseQrUrl：取最后一个图片直链（含 ?t=）', () => {
  const out = 'log\nhttps://oss.x/a/dev/qrcode.png?t=123\ntail';
  assert.equal(parseQrUrl(out), 'https://oss.x/a/dev/qrcode.png?t=123');
  assert.equal(parseQrUrl('没有链接'), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/plugins/team-tools/unattended/logic.test.js`
Expected: FAIL（`Cannot find module './logic.js'`）

- [ ] **Step 3: 实现 logic.js**

`src/plugins/team-tools/unattended/logic.js`：

```js
/** 无人值守纯逻辑（无副作用，可单测） */

const ACTIVE = new Set(['new', 'confirmed', 'analyzing', 'analyzed', 'developing']);

/** 队列是否清空（无任何进行中的任务） */
export function isDrained(tasks) {
  return !tasks.some((t) => ACTIVE.has(t.status));
}

/** bug 优先、createdAt 升序 */
function sortForDev(a, b) {
  if (a.type !== b.type) return a.type === 'bug' ? -1 : 1;
  return new Date(a.createdAt) - new Date(b.createdAt);
}

/**
 * 选下一步动作：
 *  - 有 analyzed → develop（bug 先、旧先）
 *  - 无 analyzed、无 analyzing/developing、有 new/confirmed → analyze
 *  - 有 analyzing/developing → wait（等它变 analyzed）
 *  - 否则 idle（已清空）
 */
export function pickNext(tasks) {
  const analyzed = tasks.filter((t) => t.status === 'analyzed').sort(sortForDev);
  if (analyzed.length) return { action: 'develop', task: analyzed[0] };
  const busy = tasks.some((t) => t.status === 'analyzing' || t.status === 'developing');
  if (busy) return { action: 'wait' };
  const fresh = tasks.filter((t) => t.status === 'new' || t.status === 'confirmed').sort(sortForDev);
  if (fresh.length) return { action: 'analyze', task: fresh[0] };
  return { action: 'idle' };
}

/** 分支名 unattended/YYYYMMDD-HHmm（date 为 Date 实例，本地时区） */
export function buildBranchName(date) {
  const p = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const s = `${y}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `unattended/${s}`;
}

/** git commit message */
export function buildCommitMessage(task, ok) {
  const kind = task.type === 'bug' ? 'fix' : 'feat';
  const flag = ok ? '' : ' [failed]';
  return `${kind}: ${task.title}${flag} (task ${task.id})`;
}

/** 群消息：标题头 + 仅标题逐行 */
export function buildGroupMessage(batch) {
  const lines = batch.map((b) => `${b.type === 'bug' ? '🐞' : '✦'} ${b.title}`);
  return `本轮无人值守已处理 ${batch.length} 项：\n${lines.join('\n')}`;
}

/** 从脚本 stdout 提取最后一个图片直链（png/jpg/jpeg/webp，允许 ?t= 尾参） */
export function parseQrUrl(stdout) {
  const re = /https?:\/\/\S+\.(?:png|jpg|jpeg|webp)(?:\?\S*)?/gi;
  const matches = (stdout || '').match(re);
  return matches && matches.length ? matches[matches.length - 1] : null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/plugins/team-tools/unattended/logic.test.js`
Expected: PASS（9 tests）

- [ ] **Step 5: 提交**

```bash
git add src/plugins/team-tools/unattended/logic.js src/plugins/team-tools/unattended/logic.test.js
git commit -m "feat(unattended): 新增纯逻辑 logic.js"
```

---

## Task 4: git 封装 git.js

**Files:**
- Create: `src/plugins/team-tools/unattended/git.js`
- Test: `src/plugins/team-tools/unattended/git.test.js`

- [ ] **Step 1: 写失败测试（只测纯参数拼装）**

`src/plugins/team-tools/unattended/git.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert';
import { checkoutArgs, commitArgs, pushArgs } from './git.js';

test('checkoutArgs：新建带 -b，已存在不带', () => {
  assert.deepEqual(checkoutArgs('/r', 'b1', true), ['-C', '/r', 'checkout', '-b', 'b1']);
  assert.deepEqual(checkoutArgs('/r', 'b1', false), ['-C', '/r', 'checkout', 'b1']);
});

test('commitArgs / pushArgs', () => {
  assert.deepEqual(commitArgs('/r', 'msg'), ['-C', '/r', 'commit', '-m', 'msg']);
  assert.deepEqual(pushArgs('/r', 'b1'), ['-C', '/r', 'push', '-u', 'origin', 'b1']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/plugins/team-tools/unattended/git.test.js`
Expected: FAIL（`Cannot find module './git.js'`）

- [ ] **Step 3: 实现 git.js**

`src/plugins/team-tools/unattended/git.js`：

```js
/** git 封装（经 shell.runScript，不抛异常）。参数拼装抽纯函数便于单测。 */
import { runScript } from '../../../integrations/shell.js';
import { logger } from '../../../shared/logger.js';

export function checkoutArgs(repo, branch, create) {
  return create ? ['-C', repo, 'checkout', '-b', branch] : ['-C', repo, 'checkout', branch];
}
export function commitArgs(repo, message) {
  return ['-C', repo, 'commit', '-m', message];
}
export function pushArgs(repo, branch) {
  return ['-C', repo, 'push', '-u', 'origin', branch];
}

const git = (args) => runScript('git', args);

export async function currentBranch(repo) {
  const r = await git(['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? (r.out || '').trim() : null;
}

export async function branchExists(repo, branch) {
  const r = await git(['-C', repo, 'rev-parse', '--verify', branch]);
  return r.ok;
}

/** 确保在目标分支上：已在=不动；已存在=checkout；否则=checkout -b */
export async function ensureBranch(repo, branch) {
  const cur = await currentBranch(repo);
  if (cur === branch) return { ok: true, created: false };
  const exists = await branchExists(repo, branch);
  const r = await git(checkoutArgs(repo, branch, !exists));
  if (!r.ok) logger.warn('unattended', 'ensureBranch 失败', { repo, branch, err: r.err || r.msg });
  return { ok: r.ok, created: !exists };
}

/** 暂存全部并提交；无变更时 git commit 非 0，视为无提交（不算失败） */
export async function commitAll(repo, message) {
  await git(['-C', repo, 'add', '-A']);
  const r = await git(commitArgs(repo, message));
  return { committed: r.ok, out: r.out, err: r.err };
}

export async function pushBranch(repo, branch) {
  const r = await git(pushArgs(repo, branch));
  return { ok: r.ok, out: r.out, err: r.err };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/plugins/team-tools/unattended/git.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add src/plugins/team-tools/unattended/git.js src/plugins/team-tools/unattended/git.test.js
git commit -m "feat(unattended): 新增 git 封装"
```

---

## Task 5: 编译适配器 compile.js

**Files:**
- Create: `src/plugins/team-tools/unattended/compile.js`
（无独立测试：核心解析 `parseQrUrl` 已在 logic.test.js 覆盖；push/脚本为副作用，靠 Task 12 真机验证）

- [ ] **Step 1: 实现 compile.js**

`src/plugins/team-tools/unattended/compile.js`：

```js
/**
 * DEV 编译适配器：push 分支 → 调 get_qrcode.py --env dev --branch <branch> → 解析二维码 URL。
 * 契约：compileDevQrcode({repo, branch}) -> { ok, qrUrl, log }
 */
import path from 'node:path';
import { runScript } from '../../../integrations/shell.js';
import { pushBranch } from './git.js';
import { parseQrUrl } from './logic.js';
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';

export async function compileDevQrcode({ repo, branch }) {
  const push = await pushBranch(repo, branch);
  if (!push.ok) {
    logger.warn('unattended', 'push 失败', { repo, branch, err: push.err });
    return { ok: false, qrUrl: null, log: `push 失败：${push.err || ''}` };
  }
  const scriptPath = path.join(config.scripts.dir, config.unattended.compileScript);
  const r = await runScript(config.scripts.pythonBin, [scriptPath, '--env', 'dev', '--branch', branch], {
    env: { PYTHONIOENCODING: 'utf-8' },
  });
  const stdout = r.out || '';
  const qrUrl = parseQrUrl(stdout);
  logger.info('unattended', 'compile 结束', { ok: r.ok, hasQr: !!qrUrl });
  return { ok: r.ok && !!qrUrl, qrUrl, log: r.ok ? stdout : r.err || r.msg || stdout };
}
```

- [ ] **Step 2: 语法自检**

Run: `node --check src/plugins/team-tools/unattended/compile.js`
Expected: 无输出（通过）

- [ ] **Step 3: 提交**

```bash
git add src/plugins/team-tools/unattended/compile.js
git commit -m "feat(unattended): 新增 DEV 编译适配器"
```

---

## Task 6: 控制器 index.js

**Files:**
- Create: `src/plugins/team-tools/unattended/index.js`

- [ ] **Step 1: 实现控制器**

`src/plugins/team-tools/unattended/index.js`：

```js
/**
 * 无人值守控制器：轮询 tasks.json，串行 develop，逐条回来源会话，
 * 全部处理完时 DEV 编译无人值守分支并把二维码+标题清单发群。
 * 跑在 claude-web 进程；单飞 pumping 防重入。
 */
import { getTasks, updateTask } from '../../../store/tasks.js';
import {
  getState,
  setEnabled,
  setBranch,
  addToBatch,
  clearBatch,
  markCompiled,
} from '../../../store/unattended.js';
import { analyze, develop } from '../task-ops.js';
import { pickNext, buildBranchName, buildCommitMessage, buildGroupMessage } from './logic.js';
import { ensureBranch, commitAll } from './git.js';
import { compileDevQrcode } from './compile.js';
import { sendText, sendImageByUrl } from '../../../integrations/lark.js';
import { getUiPrefs } from '../../../store/settings.js';
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';

const POLL_MS = 5000;
let pumping = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function targetRepo() {
  return getUiPrefs().taskProjectDir || config.feedback.frontendDir;
}

export function getStatus() {
  const s = getState();
  return { enabled: !!s.enabled, branch: s.branch || null, batch: s.batch || [], running: pumping };
}

export async function enable() {
  const repo = targetRepo();
  const branch = buildBranchName(new Date());
  setEnabled(true);
  setBranch(repo, branch);
  const r = await ensureBranch(repo, branch);
  logger.info('unattended', '开启', { repo, branch, created: r.created });
  pump().catch((e) => logger.error('unattended', 'pump 异常', { err: e?.message || String(e) }));
  return getStatus();
}

export function disable() {
  setEnabled(false);
  logger.info('unattended', '关闭');
  return getStatus();
}

/** claude-web 启动时若仍开启则续跑（分支已存在，切过去继续） */
export function resumeOnBoot() {
  const s = getState();
  if (!s.enabled) return;
  logger.info('unattended', '启动续跑', { branch: s.branch });
  ensureBranch(s.repo || targetRepo(), s.branch)
    .then(() => pump())
    .catch((e) => logger.error('unattended', '续跑失败', { err: e?.message || String(e) }));
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (getState().enabled) {
      const next = pickNext(getTasks());
      if (next.action === 'develop') {
        await runDevelop(next.task);
        continue;
      }
      if (next.action === 'analyze') {
        await analyze(next.task).catch((e) =>
          logger.error('unattended', 'analyze 失败', { id: next.task.id, err: e?.message || String(e) }),
        );
        continue;
      }
      if (next.action === 'wait') {
        await sleep(POLL_MS);
        continue;
      }
      // idle：队列已清空。有本轮批次就编译上报（compileAndReport 结束清空 batch，天然只报一次）
      if ((getState().batch || []).length) {
        await compileAndReport().catch((e) =>
          logger.error('unattended', '编译上报失败', { err: e?.message || String(e) }),
        );
      }
      await sleep(POLL_MS);
    }
  } finally {
    pumping = false;
  }
}

async function runDevelop(task) {
  const s = getState();
  const repo = s.repo || targetRepo();
  await ensureBranch(repo, s.branch);
  updateTask(task.id, { status: 'developing' }, '无人值守开始开发');
  let ok = true;
  let log = '';
  try {
    const r = await develop(task); // task-ops 内部置 status:done
    ok = r.ok;
    log = r.log || '';
  } catch (e) {
    ok = false;
    log = e?.message || String(e);
  }
  const c = await commitAll(repo, buildCommitMessage(task, ok));
  logger.info('unattended', '任务完成', { id: task.id, ok, committed: c.committed });
  await replySource(task, ok, log);
  addToBatch({ taskId: task.id, title: task.title, type: task.type, ok });
}

async function replySource(task, ok, log) {
  const chatId = task.source?.chatId;
  if (!chatId || task.source?.via !== 'feishu') {
    if (!chatId) logger.warn('unattended', '无来源 chatId，跳过回复', { id: task.id });
    return;
  }
  const text = ok
    ? `✅ 已处理完成：${task.title}`
    : `❌ 处理失败：${task.title}\n${(log || '').slice(-500)}`;
  try {
    await sendText(chatId, text);
  } catch (e) {
    logger.warn('unattended', '回来源会话失败', { id: task.id, err: e?.message || String(e) });
  }
}

async function compileAndReport() {
  const s = getState();
  const repo = s.repo || targetRepo();
  const groupId = config.unattended.groupId;
  const batch = s.batch || [];
  logger.info('unattended', '开始编译上报', { branch: s.branch, count: batch.length });
  const { ok, qrUrl, log } = await compileDevQrcode({ repo, branch: s.branch });
  try {
    await sendText(groupId, buildGroupMessage(batch));
    if (ok && qrUrl) await sendImageByUrl(groupId, qrUrl);
    else await sendText(groupId, `⚠️ DEV 编译未产出二维码：${(log || '').slice(-400)}`);
  } catch (e) {
    logger.error('unattended', '发群失败', { err: e?.message || String(e) });
  }
  markCompiled();
  clearBatch();
}
```

- [ ] **Step 2: 语法自检**

Run: `node --check src/plugins/team-tools/unattended/index.js`
Expected: 无输出（通过）

- [ ] **Step 3: 全量单测未回归**

Run: `node --test "src/**/*.test.js"`
Expected: 全绿（含新增 logic/git/store 测试）

- [ ] **Step 4: 提交**

```bash
git add src/plugins/team-tools/unattended/index.js
git commit -m "feat(unattended): 新增控制器循环"
```

---

## Task 7: feedback 补存来源 chatId（claude-feishu 侧）

**Files:**
- Modify: `src/plugins/team-tools/feedback/index.js:24`

- [ ] **Step 1: 改 source**

把 `src/plugins/team-tools/feedback/index.js` 第 20-25 行的 `createTask({...})` 里：

```js
      source: { openId: ctx.user.id, via: ctx.source },
```

改为：

```js
      source: { openId: ctx.user.id, via: ctx.source, chatId: ctx.meta?.chatId || ctx.sessionKey },
```

- [ ] **Step 2: 语法自检**

Run: `node --check src/plugins/team-tools/feedback/index.js`
Expected: 无输出

- [ ] **Step 3: 提交**

```bash
git add src/plugins/team-tools/feedback/index.js
git commit -m "feat(unattended): feedback 持久化来源 chatId 供完成回复"
```

---

## Task 8: web 路由（状态回显 + 切换 + 启动续跑）

**Files:**
- Modify: `src/entrypoints/web/routes-ops.js`（`handleTasks` + 新增 `handleUnattended`）
- Modify: `src/entrypoints/web/server.js`（import、路由、resumeOnBoot、访问日志跳过）

- [ ] **Step 1: routes-ops 顶部加 import**

在 `src/entrypoints/web/routes-ops.js` 现有 `import { analyze, develop } from '../../plugins/team-tools/task-ops.js';`（第 9 行）后加：

```js
import { getStatus, enable, disable } from '../../plugins/team-tools/unattended/index.js';
```

- [ ] **Step 2: handleTasks 附带 unattended 状态**

把第 35-38 行的 `handleTasks` 改为：

```js
export function handleTasks(res) {
  if (!getPluginEnabled('team-tools')) return sendJson(res, 404, { error: '团队工具插件未启用' });
  sendJson(res, 200, { tasks: getTasks(), unattended: getStatus() });
}
```

- [ ] **Step 3: 新增 handleUnattended**

在 `handleTaskAction` 函数（第 76 行结束）之后插入：

```js
/** 无人值守开关：GET 回状态；POST {enabled} 切换 */
export function handleUnattended(req, res) {
  if (!getPluginEnabled('team-tools')) return sendJson(res, 404, { error: '团队工具插件未启用' });
  if (req.method === 'GET') return sendJson(res, 200, getStatus());
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let data;
    try {
      data = JSON.parse(body || '{}');
    } catch {
      data = {};
    }
    try {
      const status = data.enabled ? await enable() : disable();
      sendJson(res, 200, status);
    } catch (e) {
      logger.error('web', '切换无人值守失败', { err: e?.message || String(e) });
      sendJson(res, 500, { error: String(e?.message || e) });
    }
  });
}
```

- [ ] **Step 4: server.js — import handleUnattended**

在 `src/entrypoints/web/server.js` 的 `routes-ops.js` 具名导入块（第 50-66 行）内，`handleTaskAction,` 后加一行 `handleUnattended,`；并加 `resumeOnBoot` 的导入——在文件顶部 import 区加：

```js
import { resumeOnBoot as resumeUnattended } from '../../plugins/team-tools/unattended/index.js';
```

- [ ] **Step 5: server.js — 注册路由**

在第 118 行 `if (url.pathname === '/api/tasks/action') return handleTaskAction(req, res);` 之后加：

```js
  if (url.pathname === '/api/unattended') return handleUnattended(req, res);
```

- [ ] **Step 6: server.js — 访问日志跳过（面板高频轮询 /api/tasks 已跳过，无需加；本步跳过）**

无需改（`/api/unattended` 仅切换时调，不刷屏）。

- [ ] **Step 7: server.js — 启动续跑**

在 `server.listen` 回调（第 152-163 行）内，`scheduleAllSwitchBacks();`（第 161 行）之后、`resolve();` 之前加：

```js
    resumeUnattended(); // 无人值守：重启后若仍开启则续跑
```

- [ ] **Step 8: 语法自检**

Run: `node --check src/entrypoints/web/routes-ops.js && node --check src/entrypoints/web/server.js`
Expected: 无输出

- [ ] **Step 9: 提交**

```bash
git add src/entrypoints/web/routes-ops.js src/entrypoints/web/server.js
git commit -m "feat(unattended): web 路由 /api/unattended + 状态回显 + 启动续跑"
```

---

## Task 9: get_qrcode.py 支持 --branch（git-ignored 配套）

**Files:**
- Modify: `scripts/get_qrcode.py`（`main` argparse + `get_dev_qrcode_url`）

> 该文件 git-ignored（含硬编码后台凭证），改动不进版本库，但功能必需。执行前先 `node -e "console.log(require('fs').existsSync('scripts/get_qrcode.py'))"` 确认存在。

- [ ] **Step 1: 给 get_dev_qrcode_url 加分支覆盖参数**

把 `scripts/get_qrcode.py:234-237`：

```python
def get_dev_qrcode_url():
    """开发版：复用有效二维码或触发编译等待生成，返回图片地址。"""
    token = login()
    branch = fetch_latest_branch(token)
```

改为：

```python
def get_dev_qrcode_url(branch_override=None):
    """开发版：复用有效二维码或触发编译等待生成，返回图片地址。"""
    token = login()
    branch = branch_override or fetch_latest_branch(token)
```

- [ ] **Step 2: main 加 --branch 参数并传入**

把 `scripts/get_qrcode.py:270-273` 的 `--env` add_argument 之后加一条：

```python
    parser.add_argument(
        "--branch", default=None,
        help="指定编译分支（无人值守用）；不传则取最新版本分支",
    )
```

把第 285 行 `url = get_dev_qrcode_url()` 改为：

```python
            url = get_dev_qrcode_url(args.branch)
```

- [ ] **Step 3: 冒烟（不触发真实编译，仅验证参数解析）**

Run: `python scripts/get_qrcode.py --env dev --branch unattended/test-parse-only` （网络/凭证具备时会真触发；仅验证 argparse 不报 `unrecognized arguments`。若不想触发编译，可 `python -c "import ast;ast.parse(open('scripts/get_qrcode.py',encoding='utf-8').read())"` 做语法校验）
Expected: 不报 `error: unrecognized arguments: --branch`

- [ ] **Step 4: 无需提交（git-ignored）**

---

## Task 10: 前端胶囊开关 UI

**Files:**
- Modify: `public/index.html:324-329`（任务面板 panel-head）
- Modify: `public/app.css`（末尾追加胶囊样式）
- Modify: `public/js/tasks-panel.js`（渲染开关态 + 绑定 + 开启态隐藏「开始开发」）

- [ ] **Step 1: index.html 加胶囊 + 信息行**

把 `public/index.html:324-330`：

```html
        <div class="panel-page" data-view="tasks" hidden>
          <div class="panel-head">
            <h3>需求 / 故障</h3>
            <button class="panel-close" title="返回对话">✕</button>
          </div>
          <div id="taskBody"></div>
        </div>
```

改为：

```html
        <div class="panel-page" data-view="tasks" hidden>
          <div class="panel-head">
            <h3>需求 / 故障</h3>
            <label class="unattended-toggle" title="无人值守：自动处理需求/BUG，完成后 DEV 编译并把二维码+清单发群">
              <span class="ua-label">无人值守</span>
              <button type="button" id="unattendedToggle" class="ua-pill" role="switch" aria-checked="false">
                <span class="ua-knob"></span>
              </button>
            </label>
            <button class="panel-close" title="返回对话">✕</button>
          </div>
          <div id="unattendedInfo" class="ua-info" hidden></div>
          <div id="taskBody"></div>
        </div>
```

- [ ] **Step 2: app.css 追加样式**

在 `public/app.css` 末尾追加：

```css
/* 无人值守胶囊开关 */
.unattended-toggle { display:flex; align-items:center; gap:6px; margin-left:auto; margin-right:10px; font-size:12px; color:var(--muted); cursor:pointer; }
.ua-pill { width:40px; height:22px; border-radius:11px; background:var(--faint,#555); border:none; padding:2px; cursor:pointer; transition:background .15s; }
.ua-pill[aria-checked="true"] { background:var(--accent-hi,#3b82f6); }
.ua-knob { display:block; width:18px; height:18px; border-radius:50%; background:#fff; transform:translateX(0); transition:transform .15s; }
.ua-pill[aria-checked="true"] .ua-knob { transform:translateX(18px); }
.ua-info { font-size:11px; color:var(--faint); padding:0 8px 6px; }
```

- [ ] **Step 3: tasks-panel.js — 顶部加模块级开关态**

在 `public/js/tasks-panel.js` 第 12 行 `let taskTimer = null;` 之后加：

```js
      let uaEnabled = false; // 无人值守开关态（渲染 actionsFor 时据此隐藏「开始开发」）
      let uaBound = false;   // 开关点击是否已绑定（首次 loadTasks 时绑定一次）
```

- [ ] **Step 4: tasks-panel.js — loadTasks 读取并渲染 unattended**

把 `loadTasks` 第 110-126 行整体替换为：

```js
      async function loadTasks() {
        const body = $('#taskBody');
        try {
          const data = await (await fetch('/api/tasks')).json();
          const tasks = data.tasks;
          renderUnattended(data.unattended);
          latestAlerts = (tasks || []).flatMap(taskAlerts);
          if (!tasks || !tasks.length) {
            body.innerHTML = '<div style="color:var(--faint);padding:8px">暂无需求 / 故障</div>';
            markAllTasksSeen();
            return;
          }
          body.innerHTML = '';
          for (const t of tasks) body.appendChild(renderTask(t));
          markAllTasksSeen();
        } catch {
          body.innerHTML = '<div style="color:var(--red);padding:8px">读取失败</div>';
        }
      }

      // 渲染无人值守开关态 + 信息行；首次绑定点击切换
      function renderUnattended(state) {
        const st = state || {};
        uaEnabled = !!st.enabled;
        const pill = $('#unattendedToggle');
        const info = $('#unattendedInfo');
        if (pill) pill.setAttribute('aria-checked', uaEnabled ? 'true' : 'false');
        if (info) {
          if (uaEnabled) {
            const done = (st.batch || []).length;
            info.hidden = false;
            info.textContent = `分支 ${st.branch || '(准备中)'} · 本轮已处理 ${done}`;
          } else {
            info.hidden = true;
            info.textContent = '';
          }
        }
        if (pill && !uaBound) {
          uaBound = true;
          pill.onclick = async () => {
            const next = pill.getAttribute('aria-checked') !== 'true';
            pill.setAttribute('aria-checked', next ? 'true' : 'false'); // 乐观
            try {
              await fetch('/api/unattended', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
              });
            } catch {
              /* 失败下轮 loadTasks 会纠回真实态 */
            }
            loadTasks();
          };
        }
      }
```

- [ ] **Step 5: tasks-panel.js — 开启态隐藏「开始开发」**

把 `actionsFor` 第 198-201 行：

```js
        if (t.status === 'analyzed') {
          add('开始开发', 'primary', () => taskAction(t.id, 'start'));
          add('补充方案', '', () => openFix(t, card));
          add('移除', 'danger', () => rejectTask(t));
```

改为：

```js
        if (t.status === 'analyzed') {
          if (!uaEnabled) add('开始开发', 'primary', () => taskAction(t.id, 'start'));
          add('补充方案', '', () => openFix(t, card));
          add('移除', 'danger', () => rejectTask(t));
```

- [ ] **Step 6: 前端冒烟（起服务后）**

先确认后端在线：`node -e "fetch('http://127.0.0.1:3000/api/tasks').then(r=>r.json()).then(d=>console.log('unattended in resp:', 'unattended' in d)).catch(e=>console.log('后端未起',e.message))"`
Expected: `unattended in resp: true`（若后端未起则先 `pm2 restart claude-web`）

- [ ] **Step 7: 提交**

```bash
git add public/index.html public/app.css public/js/tasks-panel.js
git commit -m "feat(unattended): 需求/故障面板胶囊开关 UI"
```

---

## Task 11: .gitignore 忽略状态文件

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: 追加**

在 `.gitignore` 末尾加一行：

```
unattended.json
```

- [ ] **Step 2: 确认已忽略**

Run: `git check-ignore unattended.json`
Expected: 输出 `unattended.json`

- [ ] **Step 3: 提交**

```bash
git add .gitignore
git commit -m "chore(unattended): 忽略 unattended.json 状态文件"
```

---

## Task 12: 部署与真机验证

**Files:** 无（运行验证）

- [ ] **Step 1: 全量单测**

Run: `node --test "src/**/*.test.js"`
Expected: 全绿

- [ ] **Step 2: 重启进程**

```bash
pm2 restart claude-web    # 控制器/路由/前端/config/store 生效
pm2 restart claude-feishu # feedback chatId 生效
```

- [ ] **Step 3: 开关与分支**

在 web「需求/故障」面板点开「无人值守」胶囊 → 观察：
- `GET /api/unattended` 返回 `enabled:true`；信息行显示分支名；
- 目标仓库（kxmall-app-ui）`git -C <repo> branch --show-current` = `unattended/<日期>`。
Expected: 分支已创建并切换。

- [ ] **Step 4: 自动处理 + 逐条回复**

从飞书发一条需求/BUG（或已有存量 analyzed 任务）→ 观察 `logs/app-YYYY-MM-DD.log`：
- `unattended 任务完成 {id,ok,committed:true}`；
- 目标仓库出现对应 commit（`git -C <repo> log --oneline -3`）；
- 来源飞书会话收到「✅ 已处理完成：<标题>」。
Expected: 串行逐条完成并回复。

- [ ] **Step 5: 清空 → 编译 → 发群**

等队列清空（无 new/analyzing/analyzed/developing）→ 观察：
- 日志 `unattended 开始编译上报`；
- 群 `oc_24f041c3815632e4b475a5f269cac34a` 收到「本轮无人值守已处理 N 项：」标题清单 + 二维码图片（或 ⚠️ 未产出二维码提示）。
Expected: 群消息到达。若二维码缺失，读日志核对 push 权限 / CI 是否按分支构建（决策③的真机确认点）。

- [ ] **Step 6: 关闭开关**

再点胶囊关闭 → `enabled:false`；新发的需求不再被自动处理（保留在面板待人工）。
Expected: 停止拾取新任务。

- [ ] **Step 7: 更新记忆**

用一句话把「无人值守模式已交付 + 决策③真机结论（CI 是否支持任意分支构建）」补进项目记忆 `web-console-enhancements.md`。

---

## Self-Review（作者自查，已完成）

- **Spec 覆盖**：胶囊开关(Task 10)、默认关+持久化(Task 2/10)、开启建分支(Task 6 enable)、存量+新到串行处理(Task 6 pump+logic Task 3)、逐条回来源会话(Task 6 replySource + Task 7 chatId)、全部完成 DEV 编译(Task 5/9)、二维码+仅标题清单发指定群(Task 6 compileAndReport + logic buildGroupMessage)、关闭停止(Task 6 disable + pump while 条件) —— 全部有对应任务。
- **占位符**：无 TODO/TBD；每个 code 步骤含完整代码。
- **类型/命名一致**：`getState/setEnabled/setBranch/addToBatch/clearBatch/markCompiled`（store）、`pickNext/isDrained/buildBranchName/buildCommitMessage/buildGroupMessage/parseQrUrl`（logic）、`ensureBranch/commitAll/pushBranch/checkoutArgs/commitArgs/pushArgs`（git）、`compileDevQrcode`（compile）、`enable/disable/getStatus/resumeOnBoot`（controller）—— 跨任务调用名一致。
- **已知风险（真机确认）**：决策③按分支 DEV 编译依赖 CI 支持任意分支 + push 权限（Task 12 Step 5 校验）；跨进程 triage 并发为既有限制（无人值守期间勿走飞书人工 triage）。

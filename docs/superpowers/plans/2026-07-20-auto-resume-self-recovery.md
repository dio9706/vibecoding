# 自动续跑自恢复机制 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Git 约定（用户全局指令，优先级最高）**：未经用户主动要求，**不执行任何 git commit/branch 操作**。本计划中的"验证检查点"替代常规的 commit 步骤；是否提交由用户决定。

**Goal:** 给 web 执行台的自动续跑加"续跑上限 + 失效清除 + 会话隔离"，根治 Claude 自重启触发的孤儿续跑死循环，且不影响其他会话与新开会话。

**Architecture:** 续跑代次跨进程重启持久化（`active-runs.json` 的 `resumeAttempt` → `pending-resume.json` 的 `attempts` 链式 +1），达上限即熔断为 `abandoned` 标记；前端待续跑轮询改为按会话隔离，并对"run 不存在"/`abandoned` 做失效清除。

**Tech Stack:** Node.js（无框架，原生 http）、ES Modules、`node --test`、原生 JS 前端（`public/app.js`，无构建）。

**参考 spec:** `docs/superpowers/specs/2026-07-20-auto-resume-self-recovery-design.md`

---

## 文件结构

- `src/store/pending-resume.js` — 新增纯函数 `shouldAbandonResume`、`removePendingByConv`；`addPending` 补 `attempts` 默认值。
- `src/store/pending-resume.test.js` —（新建）纯函数与 store 行为单测（`node --test`）。
- `src/store/active-runs.js` — 无结构改动，仅注释登记新字段 `resumeAttempt`。
- `src/entrypoints/web/server.js` — `startClaudeRun` 透传 `resumeAttempt`；`MAX_RESUME_ATTEMPTS` 常量 + `abandonResume` 助手；`doResume` 守卫与代次传递；孤儿恢复计次熔断 + rearm 过滤；`handleRunPending` 透出 `attempts`/`reason`；新增 `/api/run/pending/dismiss`。
- `public/app.js` — `dismissPending` 助手；`refreshPending` 会话隔离 + `abandoned` 终结提示；`attachStream` error 失效清除；`openConv` 后台会话接流补齐。

---

## Task 1: 纯函数 `shouldAbandonResume` + 单测（TDD）

**Files:**
- Modify: `src/store/pending-resume.js`
- Test: `src/store/pending-resume.test.js`（新建）

- [ ] **Step 1: 写失败测试**

新建 `src/store/pending-resume.test.js`：

```js
/**
 * 续跑熔断决策纯函数单测。
 * 背景：Claude 在 web run 内 pm2 restart 自身进程 → 孤儿续跑 → 再重启 → 死循环。
 * shouldAbandonResume 决定"本次续跑代次是否已超上限，应放弃"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAbandonResume } from './pending-resume.js';

test('shouldAbandonResume：代次 <= 上限不熔断，> 上限熔断', () => {
  assert.equal(shouldAbandonResume(0, 3), false);
  assert.equal(shouldAbandonResume(1, 3), false);
  assert.equal(shouldAbandonResume(3, 3), false); // 第 3 次续跑仍允许
  assert.equal(shouldAbandonResume(4, 3), true); // 第 4 次熔断
});

test('shouldAbandonResume：缺省/非法代次按 0 处理，不熔断', () => {
  assert.equal(shouldAbandonResume(undefined, 3), false);
  assert.equal(shouldAbandonResume(null, 3), false);
  assert.equal(shouldAbandonResume(NaN, 3), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/store/pending-resume.test.js`
Expected: FAIL —`shouldAbandonResume` 未导出（`SyntaxError`/`undefined is not a function`）。

- [ ] **Step 3: 实现纯函数**

在 `src/store/pending-resume.js` 末尾追加：

```js
/**
 * 续跑熔断决策：本次续跑代次是否已超上限（超过则应放弃自动续跑）。
 * 纯函数，便于单测。缺省/非法代次按 0（从未续跑）处理，不熔断。
 * @param {number} attempts 本次将要发起的续跑代次（首次孤儿续跑为 1）
 * @param {number} max 续跑上限（MAX_RESUME_ATTEMPTS）
 */
export function shouldAbandonResume(attempts, max) {
  const n = Number.isFinite(attempts) ? attempts : 0;
  return n > max;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/store/pending-resume.test.js`
Expected: PASS（2 tests）。

- [ ] **Step 5: 验证检查点**

Run: `node --test src/store/*.test.js`
Expected: 既有 runs/history 等测试 + 新增均 PASS。（是否 git 提交由用户决定）

---

## Task 2: store 字段（`attempts` 默认 + `removePendingByConv`）

**Files:**
- Modify: `src/store/pending-resume.js:15-29`（`addPending`）
- Modify: `src/store/pending-resume.js`（追加 `removePendingByConv`）
- Test: `src/store/pending-resume.test.js`

- [ ] **Step 1: 写失败测试**

在 `src/store/pending-resume.test.js` 追加（放文件顶部 import 之后、纯函数测试之前均可）：

```js
import { addPending } from './pending-resume.js';

test('addPending：默认 attempts=0，调用方可覆盖', () => {
  const a = addPending.__buildItem
    ? addPending.__buildItem({ convId: 'c1' })
    : null;
  // 无法免落盘直接构造时，跳过（见下方说明），此断言仅在暴露构造器时生效
  if (a) {
    assert.equal(a.attempts, 0);
    const b = addPending.__buildItem({ convId: 'c2', attempts: 5 });
    assert.equal(b.attempts, 5);
  }
});
```

> 说明：`addPending` 会写盘（`pending-resume.json` 落项目根），不适合在单测里直接调用。为可测，将"构造条目对象"抽为不落盘的内部函数并挂在 `addPending.__buildItem` 上（仅测试用）。若不希望暴露测试钩子，可删除本测试，仅靠 Task 1 纯函数测试 + Task 10 手动验证覆盖。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/store/pending-resume.test.js`
Expected: FAIL（`__buildItem` 未定义 → 测试体内 `a` 为 null 时会跳过；若坚持断言则 FAIL）。

- [ ] **Step 3: 实现字段与函数**

将 `src/store/pending-resume.js` 的 `addPending` 改为（抽出可测构造器 + 补 `attempts` 默认）：

```js
/** 构造一条待续跑条目（不落盘，供测试）；attempts 默认 0，调用方可覆盖 */
function buildPendingItem(entry) {
  return {
    id: 'pr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    status: 'waiting', // waiting → resuming → done（done 后删除）| abandoned（熔断，前端消费后 dismiss）
    runId: null,
    attempts: 0, // 已发起的续跑代次；孤儿→续跑→孤儿每轮 +1，达 MAX 熔断
    createdAt: new Date().toISOString(),
    ...entry,
  };
}

/** 登记一条待续跑（同一 convId 覆盖旧的）。返回落库后的条目 */
export function addPending(entry) {
  const item = buildPendingItem(entry);
  updateJson(FILE, [], (list) => {
    const next = list.filter((e) => e.convId !== entry.convId);
    next.push(item);
    return next;
  });
  return item;
}
addPending.__buildItem = buildPendingItem; // 测试钩子：免落盘验证默认字段
```

在文件末尾（`removePending` 之后）追加按会话删除：

```js
/** 按会话删除全部待续跑条目（前端失效清除 / 熔断 dismiss 用） */
export function removePendingByConv(convId) {
  updateJson(FILE, [], (list) => list.filter((e) => e.convId !== convId));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/store/pending-resume.test.js`
Expected: PASS。

- [ ] **Step 5: active-runs 字段注释**

在 `src/store/active-runs.js` 顶部注释块的生命周期说明后补一行（无代码逻辑改动）：

```js
 * 条目字段含 resumeAttempt（续跑代次，普通首跑为 0）：进程重启时孤儿恢复据此 +1 计次熔断。
```

- [ ] **Step 6: 验证检查点**

Run: `node --test src/store/*.test.js`
Expected: 全部 PASS。

---

## Task 3: `startClaudeRun` 透传 `resumeAttempt` 落盘

**Files:**
- Modify: `src/entrypoints/web/server.js:301`（函数签名）
- Modify: `src/entrypoints/web/server.js:311-320`（`addActiveRun` 条目）

- [ ] **Step 1: 扩展签名**

将 `src/entrypoints/web/server.js` 的：

```js
function startClaudeRun(run, { prompt, cwd, session, model, effort, mode, convId, resumePendingId, preInput }) {
```

改为：

```js
function startClaudeRun(run, { prompt, cwd, session, model, effort, mode, convId, resumePendingId, preInput, resumeAttempt = 0 }) {
```

- [ ] **Step 2: 写入落盘镜像**

将 `addActiveRun({ ... startedAt: Date.now() });` 条目中补一行 `resumeAttempt`：

```js
  addActiveRun({
    runId: run.id,
    convId: run.convId,
    session_id: session || null, // 新会话此刻还没有 session，onInit 到达后回填
    cwd,
    model,
    effort,
    mode: effectiveMode,
    resumeAttempt, // 续跑代次：重启后孤儿恢复据此 +1 计次，达 MAX_RESUME_ATTEMPTS 熔断
    startedAt: Date.now(),
  });
```

- [ ] **Step 3: 验证检查点**

Run: `node -e "import('./src/entrypoints/web/server.js').catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: 无语法错误退出（可能因端口占用而 listen 报错，忽略；只确认无 SyntaxError）。或直接 `node --check src/entrypoints/web/server.js` → 无输出即通过。

---

## Task 4: 续跑上限常量 + `abandonResume` 助手 + `doResume` 守卫与代次传递

**Files:**
- Modify: `src/entrypoints/web/server.js:423`（常量区，`resumeTimers` 附近）
- Modify: `src/entrypoints/web/server.js:472-489`（`doResume`）
- Modify: `src/entrypoints/web/server.js:42-47`（import 补 `shouldAbandonResume`、`removePendingByConv`）

- [ ] **Step 1: 补 import**

将 `pending-resume.js` 的 import 块改为：

```js
import {
  getPending,
  addPending,
  updatePending,
  removePending,
  removePendingByConv,
  shouldAbandonResume,
} from '../../store/pending-resume.js';
```

- [ ] **Step 2: 加常量与熔断助手**

在 `const resumeTimers = new Map();`（约 423 行）之后追加：

```js
// 续跑上限：允许极少数合理的意外重启自动续跑，同时对病态循环（Claude 自重启）快速熔断。
// 计次跨进程重启持久化：active-runs.resumeAttempt → pending.attempts 每轮 +1。
const MAX_RESUME_ATTEMPTS = 3;

/**
 * 续跑熔断：停止自动续跑并落 abandoned 标记（供前端消费一次终结提示后 dismiss）。
 * 有 entryId 走 updatePending（doResume 防御路径）；否则 addPending 新建标记（孤儿恢复路径）。
 */
function abandonResume({ convId, attempts, entryId, reason }) {
  logger.warn('web', '续跑熔断', { convId, attempts, reason });
  if (entryId) {
    updatePending(entryId, { status: 'abandoned', reason, attempts });
  } else {
    addPending({ convId, attempts, status: 'abandoned', reason, resetsAt: Math.floor(Date.now() / 1000) });
  }
}
```

- [ ] **Step 3: `doResume` 加守卫 + 传递代次**

将 `doResume` 改为：

```js
/** 执行一次续跑：新建 run 续接 session 并发送「继续」（超上限则熔断放弃） */
function doResume(entryId) {
  resumeTimers.delete(entryId);
  const entry = getPending().find((e) => e.id === entryId);
  if (!entry || entry.status === 'done' || entry.status === 'abandoned') return;
  // 防御性熔断（正常由孤儿恢复先拦；这里防止手改/异常状态下的失控续跑）
  if (shouldAbandonResume(entry.attempts, MAX_RESUME_ATTEMPTS)) {
    abandonResume({
      convId: entry.convId,
      attempts: entry.attempts,
      entryId: entry.id,
      reason: `续跑代次 ${entry.attempts} 超过上限 ${MAX_RESUME_ATTEMPTS}`,
    });
    return;
  }
  const run = createRun();
  run.convId = entry.convId;
  updatePending(entry.id, { status: 'resuming', runId: run.id });
  startClaudeRun(run, {
    prompt: '继续',
    cwd: entry.cwd,
    session: entry.session_id,
    model: entry.model,
    effort: entry.effort,
    mode: entry.mode,
    convId: entry.convId,
    resumePendingId: entry.id,
    resumeAttempt: entry.attempts, // 落盘镜像据此在下次重启 +1
  });
}
```

- [ ] **Step 4: 验证检查点**

Run: `node --check src/entrypoints/web/server.js`
Expected: 无输出（语法通过）。

---

## Task 5: 孤儿恢复计次熔断 + rearm 过滤 `abandoned`

**Files:**
- Modify: `src/entrypoints/web/server.js:1164-1185`（`server.listen` 回调内孤儿恢复 + rearm）

- [ ] **Step 1: 孤儿恢复按代次熔断**

将孤儿恢复循环（约 1164-1183）改为：

```js
  const orphans = listActiveRuns();
  if (orphans.length) {
    clearActiveRuns();
    for (const o of orphans) {
      if (!o.session_id || !o.convId) {
        logger.warn('web', '孤儿 run 缺 session/convId，无法续跑', { runId: o.runId, convId: o.convId || null });
        continue;
      }
      const nextAttempt = (o.resumeAttempt || 0) + 1; // 本次孤儿续跑的代次
      if (shouldAbandonResume(nextAttempt, MAX_RESUME_ATTEMPTS)) {
        // 连续自重启/续跑达上限 → 熔断，不再续跑（破环根治）
        abandonResume({
          convId: o.convId,
          attempts: nextAttempt,
          reason: `连续 ${nextAttempt - 1} 次自动续跑仍中断，超过上限 ${MAX_RESUME_ATTEMPTS}`,
        });
        continue;
      }
      logger.info('web', '恢复因进程重启中断的任务', { runId: o.runId, convId: o.convId, attempt: nextAttempt });
      addPending({
        convId: o.convId,
        session_id: o.session_id,
        cwd: o.cwd,
        model: o.model,
        effort: o.effort,
        mode: o.mode,
        attempts: nextAttempt, // 续跑代次随孤儿链 +1
        resetsAt: Math.floor(Date.now() / 1000), // 立即可续（scheduleResume 自带 +30s 缓冲）
      });
    }
  }
```

- [ ] **Step 2: rearm 跳过 abandoned**

将：

```js
  for (const e of getPending()) if (e.status !== 'done') scheduleResume(e);
```

改为：

```js
  // abandoned（熔断）与 done 均不重排：熔断条目仅供前端消费一次终结提示后 dismiss
  for (const e of getPending()) if (e.status !== 'done' && e.status !== 'abandoned') scheduleResume(e);
```

- [ ] **Step 3: 验证检查点**

Run: `node --check src/entrypoints/web/server.js`
Expected: 无输出。

---

## Task 6: `handleRunPending` 透出字段 + `/api/run/pending/dismiss` 端点

**Files:**
- Modify: `src/entrypoints/web/server.js:492-500`（`handleRunPending`）
- Modify: `src/entrypoints/web/server.js`（新增 `handleRunPendingDismiss`，放 `handleRunPending` 之后）
- Modify: `src/entrypoints/web/server.js:113`（路由注册）

- [ ] **Step 1: 透出 attempts/reason**

将 `handleRunPending` 改为：

```js
/** 待续跑列表（前端轮询：展示等待横幅 + 发现续跑已开始去接流 + 熔断终结提示） */
function handleRunPending(res) {
  const pending = getPending().map((e) => ({
    convId: e.convId,
    resetsAt: e.resetsAt,
    status: e.status,
    runId: e.runId,
    attempts: e.attempts || 0,
    reason: e.reason || null,
  }));
  sendJson(res, 200, { pending });
}

/** 前端失效清除 / 熔断消费后：按 convId 移除待续跑条目 */
function handleRunPendingDismiss(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(body || '{}');
    } catch {
      data = {};
    }
    const convId = (data.convId || '').trim();
    if (convId) removePendingByConv(convId);
    sendJson(res, 200, { ok: !!convId });
  });
}
```

- [ ] **Step 2: 注册路由**

在 `if (url.pathname === '/api/run/pending') return handleRunPending(res);`（113 行）之后加一行：

```js
  if (url.pathname === '/api/run/pending/dismiss') return handleRunPendingDismiss(req, res);
```

- [ ] **Step 3: 验证检查点**

Run: `node --check src/entrypoints/web/server.js`
Expected: 无输出。

---

## Task 7: 前端 `dismissPending` 助手 + `refreshPending` 会话隔离与熔断提示

**Files:**
- Modify: `public/app.js:2652-2653`（新增 `handledAbandoned` 集合 + `dismissPending`）
- Modify: `public/app.js:2674-2710`（`refreshPending`）

- [ ] **Step 1: 加集合与助手**

在 `const handledResumes = new Set();`（2653 行）之后追加：

```js
      const handledAbandoned = new Set(); // 已展示过终结提示的熔断会话，避免重复
      // 失效清除 / 熔断消费：请服务端按 convId 移除待续跑条目（不阻塞 UI）
      function dismissPending(convId) {
        fetch('/api/run/pending/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ convId }),
        }).catch(() => {});
      }
```

- [ ] **Step 2: 重写 `refreshPending`（隔离 + 熔断提示）**

将整个 `refreshPending` 函数体（2674-2710）替换为：

```js
      async function refreshPending() {
        let list;
        try {
          ({ pending: list } = await (await fetch('/api/run/pending')).json());
        } catch {
          return;
        }
        for (const k in pendingMap) delete pendingMap[k];
        let waiting = 0;
        for (const e of list || []) {
          pendingMap[e.convId] = { resetsAt: e.resetsAt, status: e.status, runId: e.runId };
          if (e.status === 'waiting') waiting++;
          // 熔断：连续续跑失败达上限 → 展示一次终结提示（仅当前会话）并 dismiss 移除
          if (e.status === 'abandoned') {
            if (!handledAbandoned.has(e.convId)) {
              handledAbandoned.add(e.convId);
              if (e.convId === currentConvId && !runningJobs[e.convId]) {
                const note =
                  '⚠️ 连续 ' +
                  (e.attempts || '多') +
                  ' 次自动续跑均未完成，已停止自动续跑；如需继续请手动发送消息。';
                const idx = convPushMessage(e.convId, 'assistant', note);
                if (idx >= 0) addMessage('assistant', note);
                scrollBottom();
              }
              dismissPending(e.convId);
            }
            continue;
          }
          // 续跑已开始 → 仅为「当前打开的会话」接流（隔离：不向他会话/新会话塞气泡）
          if (
            e.status === 'resuming' &&
            e.runId &&
            e.convId === currentConvId &&
            !handledResumes.has(e.runId) &&
            !runningJobs[e.convId]
          ) {
            const c = loadConvs().find((x) => x.id === e.convId);
            if (c) {
              handledResumes.add(e.runId);
              const idx = convPushMessage(e.convId, 'assistant', '');
              convSetMsgFields(e.convId, idx, { pending: true, runId: e.runId });
              addMessage('assistant', '');
              attachStream(e.convId, idx, e.runId);
              renderConvListDebounced();
            }
          }
        }
        const chip = $('#pendingChip');
        chip.hidden = waiting === 0;
        chip.textContent = waiting ? `⏳ ${waiting} 个任务待续跑` : '';
        renderPendingBanner();
      }
```

- [ ] **Step 3: 验证检查点**

Run: `node --check public/app.js`
Expected: 无输出（纯语法检查；`app.js` 为浏览器脚本但 `--check` 仅解析语法，无浏览器 API 调用于顶层即通过）。若因 IIFE/DOM 顶层引用报错，改用浏览器控制台加载确认无 SyntaxError。

---

## Task 8: `attachStream` error 失效清除

**Files:**
- Modify: `public/app.js:1278-1294`（`attachStream` 的 `error` 事件监听）

- [ ] **Step 1: run 不存在 → dismiss**

将 `es.addEventListener('error', ...)` 内 `endJob(convId, true);` 之后、`}` 之前补：

```js
            // 服务端权威判定该 run 已消失 → 清掉该会话待续跑，避免 refreshPending/openConv 反复重连
            if (m.includes('run 不存在')) {
              handledAbandoned.add(convId); // 该会话已终结，抑制后续熔断提示重复
              dismissPending(convId);
            }
```

改后该分支形如：

```js
        es.addEventListener('error', (e) => {
          if (e.data) {
            // 服务端主动报错（如 run 不存在/已过期）→ 终结
            let m = '发生错误';
            try {
              m = JSON.parse(e.data).message;
            } catch {}
            job.text = (job.text ? job.text + '\n\n' : '') + '⚠️ ' + m;
            job.err = true;
            job.shown = job.text.length;
            if (job.base > job.text.length) job.base = 0;
            convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
            convSetMsgFields(convId, job.asstIndex, { pending: false });
            endJob(convId, true);
            // 服务端权威判定该 run 已消失 → 清掉该会话待续跑，避免反复重连
            if (m.includes('run 不存在')) {
              handledAbandoned.add(convId);
              dismissPending(convId);
            }
          }
          // 无 e.data：传输层断开，EventSource 自动重连并重放，无需处理
        });
```

- [ ] **Step 2: 验证检查点**

Run: `node --check public/app.js`
Expected: 无输出。

---

## Task 9: `openConv` 后台会话接流补齐

**Files:**
- Modify: `public/app.js:466-482`（`openConv` 运行态恢复块）

- [ ] **Step 1: 打开会话时按存活续跑接流**

将 openConv 的运行态恢复块（466-482）改为：

```js
        // 恢复运行态：优先接续本地后台 job；否则按 runId 重连服务端 run（关网页后仍在跑）
        const job = runningJobs[id];
        if (job) {
          job.shown = job.text.length; // 返回时直接显示已有内容，不重新逐字
          job._paintedShown = -1;
          job._paintedStatus = '';
          paintJob(job);
          ensureTyping();
        } else {
          let attached = false;
          for (let k = c.messages.length - 1; k >= 0; k--) {
            const m = c.messages[k];
            if (m.role === 'assistant' && m.pending && m.runId) {
              attachStream(id, k, m.runId);
              attached = true;
              break;
            }
          }
          // 无本地 pending 气泡但服务端有该会话的存活续跑（后台会话已隔离、未预塞气泡）→ 新建气泡接流
          if (!attached) {
            const p = pendingMap[id];
            if (p && p.status === 'resuming' && p.runId && !handledResumes.has(p.runId)) {
              handledResumes.add(p.runId);
              const idx = convPushMessage(id, 'assistant', '');
              convSetMsgFields(id, idx, { pending: true, runId: p.runId });
              addMessage('assistant', '');
              attachStream(id, idx, p.runId);
            }
          }
        }
```

- [ ] **Step 2: 验证检查点**

Run: `node --check public/app.js`
Expected: 无输出。

---

## Task 10: 端到端手动验证

**Files:** 无（运行态验证）。前置：`pm2 restart claude-web` 使后端改动生效；浏览器打开 `http://<host>:3000`。

- [ ] **Step 1: 熔断破环（核心）**

构造孤儿续跑链，验证达上限熔断：

1. 停 `claude-web`：`pm2 stop claude-web`。
2. 编辑项目根 `active-runs.json`，放一条模拟孤儿（已达上限前一档）：
   ```json
   [{"runId":"run_test","convId":"<某真实convId>","session_id":"<某真实sessionId>","cwd":".","mode":"default","resumeAttempt":3,"startedAt":0}]
   ```
   （`resumeAttempt:3` → 孤儿恢复算 nextAttempt=4 > MAX(3) → 应熔断，不续跑。）
3. 启动：`pm2 start claude-web`（或 `pm2 restart`）。
4. Expected：`logs/app-2026-07-20.log` 出现 `续跑熔断`（含 convId、attempts:4）；**不**出现该会话的"恢复因进程重启中断的任务"；`pending-resume.json` 中该 convId 条目 `status:"abandoned"`；`active-runs.json` 已清空。
5. 前端打开该 convId → 出现一次"⚠️ 连续 … 次自动续跑均未完成…"提示，随后 `pending-resume.json` 该条目被 dismiss 移除，刷新不再复现。

- [ ] **Step 2: 正常单次续跑不受影响**

1. `active-runs.json` 放一条 `resumeAttempt:0` 的孤儿（nextAttempt=1 ≤ MAX）。
2. `pm2 restart claude-web`。
3. Expected：日志出现"恢复因进程重启中断的任务"（attempt:1）；~30s 后自动新建 run 发「继续」；前端当前会话自动接流；正常收尾后 `pending-resume.json` 该条目消失。

- [ ] **Step 3: 会话隔离**

1. 制造会话 A 的 stuck 续跑（如 Step 1 场景但用存活 session），保持浏览器停在**会话 B**。
2. Expected：会话 B 的消息列表**不**被塞入任何空气泡 / "run 不存在"气泡；顶栏徽标可反映等待数，但不改动 B 的内容。切到会话 A 才接流/显示提示。

- [ ] **Step 4: 失效清除（run 不存在自愈）**

1. 打开一个消息里带 `pending:true, runId:<不存在>` 的会话（可手动在浏览器 localStorage 里造，或用已 GC 的旧 runId）。
2. Expected：气泡定稿为"⚠️ run 不存在或已过期"后，前端自动 `POST /api/run/pending/dismiss`；再刷新/切换该会话不再反复重连、不再新增"run 不存在"气泡。

- [ ] **Step 5: 回归自检**

Run: `node --test src/store/*.test.js`
Expected: 全部 PASS。（是否 git 提交由用户决定）

---

## Self-Review 记录

- **Spec 覆盖**：模块1(续跑计数)→Task 2/3/4；模块2(熔断清除)→Task 1/4/5；模块3(前端隔离)→Task 6/7/8/9；验证要点→Task 1/10。无遗漏。
- **类型/命名一致**：`shouldAbandonResume(attempts,max)`、`abandonResume({convId,attempts,entryId,reason})`、`removePendingByConv(convId)`、`resumeAttempt`(active-run)/`attempts`(pending)、`dismissPending(convId)`、`handledAbandoned` 全计划一致。
- **无占位**：所有代码步骤含完整可粘贴代码与精确路径/行号。
- **Git**：遵循用户约定，无自动提交步骤。

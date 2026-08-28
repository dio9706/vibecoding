# 异常结束自动重试 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目特例：不执行任何 git 提交。** 所有改动留在工作区，提交时机由项目所有者掌控。计划中原本的 commit 步骤已替换为「自检」步骤。

**Goal:** 会话异常结束后延迟 2 秒自动续接 session 重试，最多 3 次后熔断标红，取代当前「异常即变红字终结」的行为。

**Architecture:** 服务端复用既有 `pending-resume` 续跑机制，给它加第三个触发源（前两个是额度撞墙、进程重启孤儿）。`settleRun` 的异常路径改为「登记 pending + 中性广播 `exception_retry` + 2 秒后 `doResume`」，`onSettle` 延后到重试真正终结时才触发。前端把红字终结改成中性提示 + 保持 spinner，新 run 靠现有 `refreshPending` 的 `resuming` 分支自动接流。

**Tech Stack:** 原生 ESM Node（无框架）、`node:test` + `node:assert/strict`、SSE(EventSource)、原生 DOM。

**Spec:** `docs/superpowers/specs/2026-08-27-exception-auto-retry-design.md`

**测试命令:** 全量 `npm test`；单文件 `node --test src/store/runs.test.js`

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/store/runs.js` | run 生命周期与 SSE 广播 | 修改：新增 `retryRun` 中性终结函数 |
| `src/store/runs.test.js` | 上者单测 | 修改：加 `retryRun` 广播契约断言 |
| `src/entrypoints/web/run-claude.logic.js` | 重试决策纯函数（无 I/O） | **新建** |
| `src/entrypoints/web/run-claude.logic.test.js` | 上者单测 | **新建** |
| `src/entrypoints/web/run-claude.js` | run 编排（启动/收尾/续跑） | 修改：`settleRun` 异常分支 + `scheduleRetry` |
| `src/entrypoints/web/conv-notify.logic.js` | 飞书通知纯函数层 | 修改：`shouldNotifySettle` 排除 `exception_retry` |
| `src/entrypoints/web/conv-notify.logic.test.js` | 上者单测 | 修改：加过滤断言 |
| `src/entrypoints/web/routes-run.js` | HTTP 路由 | 修改：dismiss 端点顺手中止 `resuming` 的 run |
| `public/js/chat.js` | 会话 UI + SSE 消费 | 修改：`done` 新分支、停止取消重试、横幅文案 |

新建 `run-claude.logic.js` 的理由：`run-claude.js` 全是 I/O 编排（SDK 调用、落盘、定时器），无法单测。把「该不该重试」这个五条件判定抽成纯函数，符合项目既有的 `*.logic.js` + `*.logic.test.js` 惯例（见 `check-map.logic.js`、`fix-plan.logic.js`）。

---

### Task 1: `retryRun` — 异常待重试的中性终结

**Files:**
- Modify: `src/store/runs.js`（在 `blockRun` 之后，约 `:500`）
- Test: `src/store/runs.test.js`

- [ ] **Step 1: 写失败测试**

在 `src/store/runs.test.js` 末尾追加（`retryRun` 需加进文件顶部 import 列表）：

```js
test('终结监听器：retryRun 带 subtype=exception_retry（供通知侧过滤）', () => {
  const seen = [];
  registerRunSettleListener((r) => seen.push({ id: r.id, subtype: r.subtype, status: r.status }));
  const run = createRun();
  retryRun(run, '⚠️ 模拟异常', 2000);
  const mine = seen.filter((s) => s.id === run.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].subtype, 'exception_retry');
  assert.equal(mine[0].status, 'done'); // 不是 'error'：任务还在跑，左栏/通知不该按失败渲染
});

test('retryRun：文本追加提示，且不覆盖 is_error 真值（状态查询要诚实）', () => {
  const run = createRun();
  run.text = '已产出的内容';
  run.is_error = true; // runResult 落的真值
  retryRun(run, '⚠️ 模拟异常', 2000);
  assert.match(run.text, /已产出的内容/);
  assert.match(run.text, /模拟异常/);
  assert.equal(run.is_error, true);
});

test('retryRun：非 running 的 run 不再广播（手动停止已抢先终结）', () => {
  const seen = [];
  registerRunSettleListener((r) => seen.push(r.id));
  const run = createRun();
  stopRun(run, '已手动停止');
  retryRun(run, '⚠️ 模拟异常', 2000);
  assert.equal(seen.filter((id) => id === run.id).length, 1); // 只有 stopRun 那一次
  assert.equal(run.subtype, 'stopped');
});
```

同时把 import 行改为（追加 `retryRun`）：

```js
import { createRun, askUser, resolveDecision, finishRun, setRunMode, nextReqId, stopRun, shouldResolveWaiting, UNATTENDED_WAIT_MAX_MS, hasActiveRunForConv, findRunningRunByConv, registerRunSettleListener, blockRun, retryRun } from './runs.js';
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/store/runs.test.js`
Expected: FAIL —— `SyntaxError: The requested module './runs.js' does not provide an export named 'retryRun'`

- [ ] **Step 3: 最小实现**

在 `src/store/runs.js` 的 `blockRun` 函数之后插入：

```js
/** 异常待重试：中性终结并附提示（不标红），任务将于 retryInMs 后由 run-claude 自动续跑。
 *  为什么 status 用 'done' 而不是 'error'：左栏、/api/run/:id、通知侧都按 'error' 渲染「已失败」，
 *  但此刻任务只是换个 run 继续跑，没结束。run.is_error 保留真值——状态查询要如实反映本轮确实异常了，
 *  通知侧靠 subtype 过滤挡住，不会拿它渲染失败卡片。 */
export function retryRun(run, note, retryInMs) {
  if (run.status !== 'running') return;
  run.status = 'done';
  run.subtype = 'exception_retry';
  run.text = run.text ? run.text + '\n\n' + note : note;
  run.updatedAt = Date.now();
  stopWatchdog(run);
  drainAsks(run);
  fanout(run, 'done', { result: run.text, is_error: false, subtype: 'exception_retry', retryInMs, ...unsentField(run) });
  closeAll(run);
  emitSettled(run);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/store/runs.test.js`
Expected: PASS（含原有全部断言）

- [ ] **Step 5: 自检（不提交）**

确认 `git diff --stat src/store/runs.js src/store/runs.test.js` 只动了这两个文件，且没有误删 `blockRun` 相邻代码。

---

### Task 2: `shouldRetryOnException` — 五条件重试决策纯函数

**Files:**
- Create: `src/entrypoints/web/run-claude.logic.js`
- Test: `src/entrypoints/web/run-claude.logic.test.js`

- [ ] **Step 1: 写失败测试**

新建 `src/entrypoints/web/run-claude.logic.test.js`：

```js
/**
 * 异常自动重试决策单测。
 * 回归背景：重试带副作用（addPending + 定时 doResume），任一条件判错都会导致
 * 「用户点了停止，2 秒后任务自己活过来」或「无 session 锚点却登记了续跑」这类幽灵行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRetryOnException } from './run-claude.logic.js';

const base = { hasError: true, status: 'running', sid: 'sess-1', convId: 'conv-1', nextAttempt: 1, max: 3 };

test('五条件全满足 → 重试', () => {
  assert.equal(shouldRetryOnException(base), true);
});

test('没异常（正常收尾）→ 不重试', () => {
  assert.equal(shouldRetryOnException({ ...base, hasError: false }), false);
});

test('run 已被手动停止抢先终结 → 不重试', () => {
  assert.equal(shouldRetryOnException({ ...base, status: 'done' }), false);
  assert.equal(shouldRetryOnException({ ...base, status: 'error' }), false);
});

test('缺 session 锚点（判档窗口崩溃）→ 不重试，续接不了', () => {
  assert.equal(shouldRetryOnException({ ...base, sid: null }), false);
  assert.equal(shouldRetryOnException({ ...base, sid: '' }), false);
});

test('缺 convId → 不重试，前端无处接流', () => {
  assert.equal(shouldRetryOnException({ ...base, convId: null }), false);
});

test('代次到达上限边界：nextAttempt=3 仍重试，4 熔断', () => {
  assert.equal(shouldRetryOnException({ ...base, nextAttempt: 3 }), true);
  assert.equal(shouldRetryOnException({ ...base, nextAttempt: 4 }), false);
});

test('非法/缺省代次按 0 处理，不熔断', () => {
  assert.equal(shouldRetryOnException({ ...base, nextAttempt: undefined }), true);
  assert.equal(shouldRetryOnException({ ...base, nextAttempt: NaN }), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/entrypoints/web/run-claude.logic.test.js`
Expected: FAIL —— `Cannot find module ... run-claude.logic.js`

- [ ] **Step 3: 最小实现**

新建 `src/entrypoints/web/run-claude.logic.js`：

```js
/** web 入口 run 编排的纯函数层（无 I/O，可单测）。run-claude.js 本体全是 SDK 调用与落盘，无法直测。 */
import { shouldAbandonResume } from '../../store/pending-resume.js';

/**
 * 异常结束后该不该自动重试。五个条件全满足才重试：
 * - hasError：确有异常（SDK 抛错 或 result.is_error）
 * - status === 'running'：手动停止（stopRun）已把 status 改 'done'。不判这条会「登记了 pending
 *   却广播不出去」→ 用户点了停止，2 秒后任务又活了
 * - sid && convId：有 session 锚点才能续接；判档窗口/首轮 onInit 前崩溃的续不了
 * - 代次未超上限：病态循环（Claude 自重启）熔断
 * @param {{hasError:boolean, status:string, sid:?string, convId:?string, nextAttempt:number, max:number}} p
 */
export function shouldRetryOnException({ hasError, status, sid, convId, nextAttempt, max }) {
  if (!hasError) return false;
  if (status !== 'running') return false;
  if (!sid || !convId) return false;
  return !shouldAbandonResume(nextAttempt, max);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/entrypoints/web/run-claude.logic.test.js`
Expected: PASS，7 个测试全绿

- [ ] **Step 5: 自检（不提交）**

确认 `shouldAbandonResume(undefined, 3)` 的既有行为（`pending-resume.js:66`「缺省/非法代次按 0 处理」）确实让最后一个测试通过 —— 若不通过，改的是测试期望而不是 `shouldAbandonResume`（那是额度/孤儿路径共用的，不能动）。

---

### Task 3: 通知过滤 —— 重试中的 run 不推飞书

**Files:**
- Modify: `src/entrypoints/web/conv-notify.logic.js:16-17`
- Test: `src/entrypoints/web/conv-notify.logic.test.js:16-19`

- [ ] **Step 1: 写失败测试**

把 `conv-notify.logic.test.js` 中「手动停止与额度阻塞不通知」那条测试改为：

```js
test('shouldNotifySettle：手动停止、额度阻塞、异常待重试都不通知', () => {
  assert.equal(shouldNotifySettle({ status: 'done', subtype: 'stopped' }), false);
  assert.equal(shouldNotifySettle({ status: 'done', subtype: 'quota_blocked' }), false);
  // 异常重试中：任务逻辑上没结束。不过滤会推一张「❌ 失败」紧接一张「✅ 完成」，属噪音误报
  assert.equal(shouldNotifySettle({ status: 'done', subtype: 'exception_retry', is_error: true }), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/entrypoints/web/conv-notify.logic.test.js`
Expected: FAIL —— 第三个断言 `Expected values to be strictly equal: true !== false`

- [ ] **Step 3: 最小实现**

`conv-notify.logic.js` 的 `shouldNotifySettle` 返回行改为：

```js
  return !['stopped', 'quota_blocked', 'exception_retry'].includes(run.subtype);
```

并在该函数的 JSDoc 排除说明里补一行：

```
 * - exception_retry：异常后会自动重试，任务逻辑上没结束（重试真终结或熔断时才推）
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/entrypoints/web/conv-notify.logic.test.js`
Expected: PASS

- [ ] **Step 5: 自检（不提交）**

`rg -n "exception_retry" src/entrypoints/web/conv-notify.js` —— 确认 `conv-notify.js:92` 那处 `ok` 判定不需要改（它只在卡片构造时用，而卡片构造已被 `shouldNotifySettle` 挡在门外）。

---

### Task 4: `settleRun` 接线 —— 异常分支 + `scheduleRetry`

**Files:**
- Modify: `src/entrypoints/web/run-claude.js`（常量区 `:218`、`settleRun` `:274` 之前、`scheduleResume` 之后）

本任务是 I/O 编排，判定逻辑已由 Task 2 单测覆盖，这里只做接线 + 手工验证。

- [ ] **Step 1: 加常量与 import**

`run-claude.js` 顶部 import 区补 `shouldRetryOnException`：

```js
import { shouldRetryOnException } from './run-claude.logic.js';
```

`store/runs.js` 的 import 列表补 `retryRun`（加在 `blockRun` 之后）。

`MAX_RESUME_ATTEMPTS` 常量之后加：

```js
// 异常结束后的重试延迟：给瞬态故障（进程崩溃/传输错误）一点恢复余地，又不让用户干等。
const RETRY_DELAY_MS = 2000;
```

- [ ] **Step 2: 加 `scheduleRetry`**

在 `scheduleResume`（`:293`）之后插入：

```js
/** 异常结束后延迟重试（与 scheduleResume 的区别：固定短延迟，不看 token 重置时刻） */
function scheduleRetry(entry, delayMs) {
  const prev = resumeTimers.get(entry.id);
  if (prev) clearTimeout(prev);
  resumeTimers.set(
    entry.id,
    setTimeout(() => doResume(entry.id), delayMs),
  );
}
```

- [ ] **Step 3: 在 `settleRun` 插入异常重试分支**

在 `if (params.resumePendingId) removePending(params.resumePendingId);`（`:274`）**之前**插入：

```js
  // ---- 异常自动重试：登记待续跑 + 2 秒后续接 session，取代「异常即标红终结」 ----
  // 与上面额度分支同构，且同样在 return 前**不触发 run.onSettle**：重试路径上任务逻辑没结束，
  // 提前回调会把需求系统任务的 busy 闸清掉、串行闸被击穿（见下方 onSettle 注释）。
  const hasError = !!err || !!run.is_error;
  const nextAttempt = (params.resumeAttempt || 0) + 1;
  const retryDecision = shouldRetryOnException({
    hasError,
    status: run.status,
    sid,
    convId: params.convId,
    nextAttempt,
    max: MAX_RESUME_ATTEMPTS,
  });
  if (retryDecision) {
    const reason = err ? `Agent SDK 执行失败：${err?.message || String(err)}` : (run.result || 'Claude 异常结束');
    const heldTexts = consumeHeldMsgs(run).map((m) => m.text); // 排队消息随重试带入，否则会被标「未发送」而丢掉
    const entry = addPending({
      convId: params.convId,
      session_id: sid,
      cwd: params.cwd,
      model: params.model,
      effort: params.effort,
      mode: params.mode,
      // 代次 +1 递增（额度分支是继承不递增）：额度撞墙是外部资源限制、等重置必然有效；
      // 异常有病态循环风险必须计次。与孤儿恢复共享同一计数器 → 交替失败也绕不过 3 次上限。
      attempts: nextAttempt,
      reason: 'exception_retry',
      prompt: heldTexts.length ? heldTexts.join('\n\n') : undefined,
      resetsAt: Math.floor(Date.now() / 1000),
    });
    logger.warn('web', '异常结束，已排程自动重试', { runId: run.id, convId: params.convId, attempt: nextAttempt, reason });
    retryRun(run, `⚠️ ${reason}\n\n🔄 ${RETRY_DELAY_MS / 1000} 秒后自动重试（第 ${nextAttempt}/${MAX_RESUME_ATTEMPTS} 次）…`, RETRY_DELAY_MS);
    scheduleRetry(entry, RETRY_DELAY_MS);
    return;
  }
  // 有异常但不重试（超上限 / 无 session 锚点 / 已被手动停止）：超上限要落 abandoned 让前端提示一次
  if (hasError && run.status === 'running' && sid && params.convId) {
    abandonResume({
      convId: params.convId,
      attempts: nextAttempt,
      entryId: params.resumePendingId,
      reason: `连续 ${nextAttempt - 1} 次自动重试仍异常，超过上限 ${MAX_RESUME_ATTEMPTS}`,
    });
  }
```

注意第二段的 `entryId: params.resumePendingId`：本次异常若发生在一个续跑 run 上，条目已存在，要 `updatePending` 改状态而不是 `addPending` 新建（`abandonResume` 内部按 `entryId` 有无分流，见 `:224`）。走到这里后代码继续往下执行原有的 `removePending` / `onSettle` / `failRun` 逻辑 —— **注意**：`abandonResume` 已把条目标 `abandoned`，而紧随其后的 `removePending(params.resumePendingId)` 会把它删掉，前端就看不到熔断提示了。所以要把原有那行改为：

```js
  if (params.resumePendingId && !hasError) removePending(params.resumePendingId); // 续跑正常收尾 → 清除登记；异常已由上面 abandonResume 落标记
```

- [ ] **Step 4: 手工验证重试链**

启动服务：`npm start`，在网页端起一个任务，然后 `taskkill` 掉底层 CLI 进程（或用一个必然报错的 cwd 触发 SDK 抛错）。

Expected（看服务端日志）:
- 出现 `异常结束，已排程自动重试 { attempt: 1 }`
- 约 2 秒后出现新 run 的启动日志
- 连续制造 3 次异常后出现 `续跑熔断`，第 4 次不再新起 run

- [ ] **Step 5: 全量回归 + 自检（不提交）**

Run: `npm test`
Expected: 全绿。特别确认 `src/store/runs.test.js`（额度/停止路径）与 `src/entrypoints/web/requirement-ops.test.js`（onSettle 相关）没有回归。

---

### Task 5: dismiss 端点顺手中止 resuming 的 run

**Files:**
- Modify: `src/entrypoints/web/routes-run.js:105+`（`handleRunPendingDismiss`）

**为什么**：前端在 2 秒等待窗口内点停止时会调 dismiss。但若用户在第 1.9 秒点击，`doResume` 可能已经起了新 run —— 删条目挡不住已经在跑的进程，会留下一个「前端看不见、还在烧额度」的孤儿 run。dismiss 时顺手中止它。

- [ ] **Step 1: 写失败测试**

`src/entrypoints/web/routes-run.test.js` 若不存在则新建，若存在则追加。本任务的纯逻辑很薄，改用纯函数抽取以便单测 —— 在 `run-claude.logic.js` 追加：

```js
/** dismiss 待续跑条目时，哪些条目对应的 run 需要一并中止（已起跑的重试/续跑，删条目挡不住进程） */
export function runIdsToAbortOnDismiss(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.status === 'resuming' && e.runId)
    .map((e) => e.runId);
}
```

在 `run-claude.logic.test.js` 追加：

```js
test('dismiss：只中止已起跑（resuming）且有 runId 的条目', () => {
  const out = runIdsToAbortOnDismiss([
    { status: 'resuming', runId: 'run_a' },
    { status: 'waiting', runId: null },      // 还没起跑，删条目就够了
    { status: 'resuming', runId: null },     // 异常数据，跳过
    { status: 'abandoned', runId: 'run_b' }, // 已熔断，run 早终结了
  ]);
  assert.deepEqual(out, ['run_a']);
});
```

并把该文件的 import 改为：

```js
import { shouldRetryOnException, runIdsToAbortOnDismiss } from './run-claude.logic.js';
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/entrypoints/web/run-claude.logic.test.js`
Expected: FAIL —— `runIdsToAbortOnDismiss is not a function`

- [ ] **Step 3: 实现**

Step 1 的纯函数写入 `run-claude.logic.js` 后，改 `routes-run.js` 的 `handleRunPendingDismiss`：在 `removePendingByConv(convId)` **之前**插入：

```js
  // 已起跑的重试/续跑 run 必须一并中止：删条目只是让前端不再接流，进程还在烧额度
  const doomed = runIdsToAbortOnDismiss(getPending().filter((e) => e.convId === convId));
  for (const id of doomed) abortRunById(id, '已手动停止');
```

`routes-run.js` 顶部 import 补：

```js
import { runIdsToAbortOnDismiss } from './run-claude.logic.js';
```

（`abortRunById`（`routes-run.js:13`）与 `getPending`（`:21`）该文件已 import，**不要重复导入**。）

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/entrypoints/web/run-claude.logic.test.js`
Expected: PASS，8 个测试全绿

- [ ] **Step 5: 自检（不提交）**

`rg -n "abortRunById|getPending" src/entrypoints/web/routes-run.js | head` 确认两者都已在 import 列表，无重复导入。

---

### Task 6: 前端 `done` 新分支 —— 不标红、不收尾

**Files:**
- Modify: `public/js/chat.js:2478-2489`（`done` 处理器）

前端为 UI 模块，无单测基建，靠 Task 8 的人工验收覆盖。

- [ ] **Step 1: 插入 `exception_retry` 分支**

在 `} else if (d.subtype === 'quota_blocked') {` 那个分支之后、`} else if (d.is_error) {` **之前**插入：

```js
          } else if (d.subtype === 'exception_retry') {
            // 异常但服务端已排程重试：不标红、不 endJob，spinner 继续转，等新 run 接流
            if (d.result) job.text = d.result; // 服务端已附「原因 + N 秒后自动重试」
            if (job.base > job.text.length) job.base = 0;
            job.shown = job.text.length;
            convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
            job.pending = true; // 复用「run 不存在静默等待」语义：refreshPending 切到新 runId 时重新接流
            // 必须显式关流：closeAll 只是 res.end()，EventSource 会自动重连去拉这个已终结的 run，
            // 撞上「已结束 run 补发 done」→ 无限循环（同 :2519 的处理）
            try {
              job.es.close();
            } catch {}
            // pending 轮询周期是 15s，不提前拉的话「2 秒重试」在用户眼里会变成「最多 17 秒才见动静」
            const retryMs = (d.retryInMs || 2000) + 800;
            setTimeout(refreshPending, retryMs);
            setTimeout(refreshPending, retryMs + 3000); // 兜底一次；15s 周期仍是最终兜底
            if (visible()) ensureTyping();
            return;
          }
```

注意 `return` 的位置：它跳过了后面的 `job.shown` 收尾、`(无输出)` 占位、`convSetMsgFields(..., {pending: false})` 和 `endJob` —— 气泡要保持 `pending: true`，刷新页面才能经 `openConv` 重连。

- [ ] **Step 2: 手工验证不标红**

`npm start` → 起任务 → 制造异常。
Expected:
- 气泡出现「⚠️ …异常… / 🔄 2 秒后自动重试（第 1/3 次）…」
- 气泡**不带红色**（DevTools 检查该气泡无 `.err` class）
- spinner/打字机状态行继续显示
- 约 2~3 秒后内容继续增长（新 run 的 `replay` 补齐全文）

- [ ] **Step 3: 手工验证刷新可恢复**

重试等待期间刷新页面。
Expected: 重开会话后气泡仍是 pending 态并接上新 run，不出现重复气泡。

- [ ] **Step 4: 自检（不提交）**

`rg -n "exception_retry" public/js/chat.js` 确认只有这一处新分支，且位置在 `d.is_error` 判断之前（否则永远走不到）。

---

### Task 7: 前端停止取消重试 + 横幅与熔断文案

**Files:**
- Modify: `public/js/chat.js:2283-2300`（`stopCurrentRun`）、`:3093-3107`（`renderPendingBanner`）、`:3125-3128`（abandoned 提示文案）

- [ ] **Step 1: `stopCurrentRun` 加 pending 分支**

在 `job.stopping = true;` 之后、`if (job.runId) {` **之前**插入：

```js
        // 等待重试/续跑期间点停止：run 早已终结，/api/run/abort 会回 {ok:false}（也就没 SSE 收尾），
        // 而服务端 2 秒后照样 doResume → 任务自己活过来。这里改为撤销待续跑登记 + 本地收尾。
        if (job.pending) {
          dismissPending(convId); // 服务端删条目（已起跑的 run 由 dismiss 端点顺手中止）
          if (!job.text.slice(job.base).includes('⏹')) {
            job.text += (job.text ? '\n\n' : '') + '⏹ 已手动停止';
            job.shown = job.text.length;
            convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
          }
          convSetMsgFields(convId, job.asstIndex, { pending: false });
          endJob(convId, false); // 中性收尾，不标红
          return;
        }
```

- [ ] **Step 2: 横幅文案加 `exception_retry` 分支**

`renderPendingBanner()` 里的 `if (p.reason === 'orphan_recovery')` 链上补一支：

```js
          if (p.reason === 'exception_retry') {
            setIconText(banner, REFRESH_ICON_SVG, '任务异常中断，正在自动重试…');
          } else if (p.reason === 'orphan_recovery') {
```

- [ ] **Step 3: 熔断提示文案改为兼容措辞**

`refreshPending()` 里 abandoned 分支的 `note` 改为：

```js
                const note =
                  '⚠️ 连续 ' +
                  (e.attempts || '多') +
                  ' 次自动重试均未完成，已停止自动重试；如需继续请手动发送消息。';
```

（原文案是「自动续跑」，现在这条提示同时服务于额度续跑、孤儿恢复和异常重试三条路径，「重试」是覆盖三者的措辞。）

- [ ] **Step 4: 手工验证停止真的停住**

`npm start` → 起任务 → 制造异常 → 在 2 秒窗口内点「停止」。
Expected:
- 气泡追加「⏹ 已手动停止」，spinner 停，不标红
- **2 秒后任务没有活过来**（服务端日志无新 run；`pending-resume.json` 该 convId 条目已消失）
- 顶部横幅不残留

- [ ] **Step 5: 自检（不提交）**

`rg -n "自动续跑均未完成" public/js/chat.js` 应无残留（已改为「自动重试均未完成」）。

---

### Task 8: 全量回归与验收

**Files:** 无改动

- [ ] **Step 1: 全量单测**

Run: `npm test`
Expected: 全绿，无跳过。

- [ ] **Step 2: 逐条走 spec §7 验收清单**

1. 异常 → 气泡显示重试提示、不变红、spinner 不停
2. 约 2~3 秒后自动接上新 run，`replay` 补齐已产出内容
3. 重试期间关闭网页 → 重开会话仍看到任务在跑
4. 连续 3 次异常 → 熔断标红 + 提示，`pending-resume.json` 该条目被 dismiss
5. 重试成功的任务在飞书只收到一条「✅ 任务已完成」，无中间失败误报
6. 自动开发任务异常 → 需求仍显示 busy，重试成功后正常推进阶段
7. 2 秒等待窗口内点「停止」→ 任务真的停住，不会活过来

- [ ] **Step 3: 回归四条既有终结路径**

手工确认没被本次改动波及：
- 正常完成 → 绿色收尾 + 成功吉祥物 + 飞书「✅」
- 手动停止 → 「⏹ 已手动停止」，不标红，无飞书推送
- 额度用尽 → 「⏳ 额度用尽…」横幅，到点自动续跑
- 进程重启（`pm2 restart` 或重启 `npm start`）→ 孤儿恢复横幅「进程重启，任务自动续接中…」

- [ ] **Step 4: 汇报（不提交）**

`git status --short` 列出全部改动文件，向项目所有者汇报实现完成 + 验收结果，由其决定提交时机。

---

## 实现顺序与依赖

```
Task 1 (retryRun) ─┐
Task 2 (决策纯函数) ─┼→ Task 4 (settleRun 接线) → Task 6 (前端 done 分支) ─┐
Task 3 (通知过滤) ──┘                              Task 5 (dismiss 中止) → Task 7 (停止/文案) → Task 8 (验收)
```

Task 1/2/3 互相独立，可并行。Task 4 依赖 1 和 2。Task 7 依赖 5 和 6。

---

## 实施记录（2026-08-27 完成）

八个任务全部实施完毕。单测 `npm test`：**1798 tests / 1796 pass / 2 fail**，两个失败是 `public/js/chat.path.test.js` 的 `.md` 文件图标断言（期望 📄、实际 📝），在 HEAD 提交 `013663a` 时就是红的（该测试文件与 `chat.js` 图标代码段均无工作区 diff），与本次改动无关。

### 与计划的两处偏离

**1. 判定函数拆成 `isRetryEligible` + `shouldAbandonResume`，且必须接纳 `status === 'error'`**

计划里的 `shouldRetryOnException` 用 `status === 'running'` 作条件，实施时发现这会把**看门狗/超时中断整类排除在重试之外** —— `runs.js` 的 `abortRun` 先调 `failRun`（status 改 `'error'`），之后 SDK 的 done reject 才到达 `settleRun`。而 spec §2 明确要求看门狗进重试范围。

修正：条件放宽为 `status ∈ {running, error}`，并新增 `subtype !== 'stopped' && subtype !== 'quota_blocked'` 作为纵深防御（手动停止落的是 `'done'`，本已被挡住）。同时判定拆成两段——`isRetryEligible`（资格）+ 现成的 `shouldAbandonResume`（代次），因为 `settleRun` 要区分「够格但超上限」（落 `abandoned`）与「压根不够格」（静默走原终结路径）；合成一个 `shouldRetryOnException` 会让生产代码无法复用资格判定，那个函数就只剩测试在用，属死代码，故删除。

**2. 前端 `is_error` 分支也调 `scheduleRetryPolls()`**

承上：看门狗路径的 `retryRun` 会因 status 闸门 no-op，前端收到的是 `failRun` 的红字 `done`，拿不到 `exception_retry` 信号。若不补轮询，新 run 要等 15s 周期才被发现。故把两次提前轮询抽成 `scheduleRetryPolls(retryInMs)`，在 `exception_retry` 与 `is_error` 两处分支复用。代价是普通异常（确实没排程重试）时多发两次 `/api/run/pending`，可忽略。

这条路径的用户体验是降级的：**红字气泡 + 稍后自动接续的新气泡**（而非 `running` 路径的「中性提示 + 原气泡继续」）。让看门狗延后终结不可行 —— `abortRun` 的注释写明 SDK abort 是优雅关闭、CLI 卡限流重试时会继续跑到自然结束，延后 `failRun` 会让前端长时间收不到任何终结信号。

### 待人工验收（需启服务，见 Task 8 Step 2）

spec §7 的 7 项，其中第 2、4、6、7 项最关键（接流时机、熔断、需求系统任务 busy 闸、停止窗口竞态）。

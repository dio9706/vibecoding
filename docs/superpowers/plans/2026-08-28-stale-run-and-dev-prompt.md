# 隔天重进入的状态判据修正 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉两处「隔天重进入会话时前端凭 localStorage / 已消失的内存状态做判断」的误判：接流撞上已死 run 后永久转圈、develop 首轮提示词被重复自动发送。

**Architecture:** 两处都把判据从「会随进程/浏览器消失的载体」搬到服务端落盘数据。缺口①让服务端在 SSE attach 失败时顺手查一次 `pending-resume.json`，把「有没有续跑计划」随 error 事件告诉前端，前端据此决定静默等待还是中性终结。缺口②在需求记录上加 `devPromptSentAt` 显式标记，前端改为「先向服务端领票、领到才发」，用文件锁挡住多窗口并发双发。

**Tech Stack:** Node 原生 `node:test` + `assert/strict`；无框架前端（原生 ES module）；`store/index.js` 的 `updateJson` 提供跨进程文件锁。

**依据 spec:** `docs/superpowers/specs/2026-08-28-stale-run-and-dev-prompt-design.md`

**提交纪律:** 本仓库规则是改动留工作区、提交时机由仓库主人掌控。每个 Task 的最后一步是「自检（不提交）」，**不要执行 git commit**。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/entrypoints/web/run-claude.logic.js` | 修改 | 新增纯函数 `isResumePlanned(pendingList, convId)`——与既有 `isRetryEligible` 同性质的编排判据 |
| `src/entrypoints/web/run-claude.logic.test.js` | 修改 | `isResumePlanned` 单测 |
| `src/entrypoints/web/routes-run.js` | 修改 | `handleRunAttach` 读 `convId`、run 不存在时回 `resumePlanned` |
| `src/entrypoints/web/routes-run.test.js` | 修改 | attach 三态集成测试 |
| `public/js/chat.js` | 修改 | `attachStream` URL 带 `convId`；SSE `error` 的「run 不存在」分支按 `resumePlanned` 三态分流 |
| `src/entrypoints/web/routes-req-v2.js` | 修改 | 新增 `POST /api/req/dev-prompt-claim` 领票端点 |
| `src/entrypoints/web/routes-req-v2.claim.test.js` | 创建 | 领票幂等 + 存量兜底测试（新建文件而非塞进 routes-requirements.test.js：那个文件已 700+ 行） |
| `public/js/req-chat.js` | 修改 | 自动发 develop 提示词的判据换成领票 |

Task 1-4 是缺口①，Task 5-6 是缺口②。两组互不依赖，可独立执行与验收。

---

### Task 1: `isResumePlanned` — 续跑计划判据纯函数

**Files:**
- Modify: `src/entrypoints/web/run-claude.logic.js`
- Test: `src/entrypoints/web/run-claude.logic.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `src/entrypoints/web/run-claude.logic.test.js` 末尾。同时把文件顶部的 import 改成：

```js
import { isRetryEligible, runIdsToAbortOnDismiss, isResumePlanned } from './run-claude.logic.js';
```

追加用例：

```js
/**
 * 续跑计划判据。
 * 回归背景：前端撞上「run 不存在」时会静默等待，等的就是这个判据说的那个新 run。
 * 判 true 而实际没人来 → 气泡永久转圈；判 false 而其实会续跑 → 把正在自愈的任务提前终结。
 */
const pending = [
  { convId: 'c-wait', status: 'waiting' },
  { convId: 'c-resuming', status: 'resuming', runId: 'run_x' },
  { convId: 'c-done', status: 'done' },
  { convId: 'c-abandoned', status: 'abandoned' },
];

test('有 waiting 条目 → 有续跑计划', () => {
  assert.equal(isResumePlanned(pending, 'c-wait'), true);
});

test('有 resuming 条目 → 有续跑计划（新 run 已起跑，前端该等它接流）', () => {
  assert.equal(isResumePlanned(pending, 'c-resuming'), true);
});

test('只有 done 条目 → 无计划（已完成，不会再产生新 run）', () => {
  assert.equal(isResumePlanned(pending, 'c-done'), false);
});

test('只有 abandoned 条目 → 无计划（熔断标记只等前端消费一次提示后 dismiss）', () => {
  assert.equal(isResumePlanned(pending, 'c-abandoned'), false);
});

test('该会话压根没有条目 → 无计划', () => {
  assert.equal(isResumePlanned(pending, 'c-never'), false);
});

test('空 convId / 非数组入参 → 无计划，且不抛', () => {
  assert.equal(isResumePlanned(pending, ''), false);
  assert.equal(isResumePlanned(pending, null), false);
  assert.equal(isResumePlanned(null, 'c-wait'), false);
  assert.equal(isResumePlanned(undefined, 'c-wait'), false);
});

test('条目里混入 null（落盘数据损坏）→ 跳过，不抛', () => {
  assert.equal(isResumePlanned([null, { convId: 'c-wait', status: 'waiting' }], 'c-wait'), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/entrypoints/web/run-claude.logic.test.js`
Expected: FAIL — `isResumePlanned is not a function`

- [ ] **Step 3: 最小实现**

追加到 `src/entrypoints/web/run-claude.logic.js` 末尾：

```js
/**
 * 该会话是否还有「会把新 run 送上来」的续跑计划。
 *
 * 供 handleRunAttach 在 run 不存在时回给前端：前端的「run 不存在 → 静默等待」分支等的就是
 * 这个新 run，判据为假时它必须改成中性终结，否则气泡永久停在「运行中…」。
 *
 * 活条目口径与 recoverPendingAndOrphans（run-claude.js）、isReqRunActive（requirement-ops.js）
 * 一致：done 已完成、abandoned 是熔断标记（只等前端消费一次提示后 dismiss），两者都不再产生新 run。
 */
export function isResumePlanned(pendingList, convId) {
  if (!convId) return false;
  return (Array.isArray(pendingList) ? pendingList : []).some(
    (e) => e && e.convId === convId && e.status !== 'done' && e.status !== 'abandoned',
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/entrypoints/web/run-claude.logic.test.js`
Expected: PASS，全部用例绿（含既有 `isRetryEligible` 用例未受影响）

- [ ] **Step 5: 自检（不提交）**

确认 `run-claude.logic.js` 仍无 I/O import（该文件的存在意义就是「无 I/O 可单测」）：

Run: `grep -n "^import" src/entrypoints/web/run-claude.logic.js`
Expected: 无输出（该文件不应有任何 import）

---

### Task 2: `handleRunAttach` 回 `resumePlanned`

**Files:**
- Modify: `src/entrypoints/web/routes-run.js`
- Test: `src/entrypoints/web/routes-run.test.js`

- [ ] **Step 1: 写失败测试**

该测试文件已有 `server` / `base` 脚手架，但它的 `createServer` **只映射了 `/start` 和 `/send`**，没有 SSE 端点。先做两处接线改动。

顶部 import 那两行改成（追加 `handleRunAttach` 与 `addPending`）：

```js
const { handleRunStart, handleRunSend, handleRunAttach } = await import('./routes-run.js');
const { createRun, getRun, finishRun } = await import('../../store/runs.js');
const { addPending } = await import('../../store/pending-resume.js');
```

`test.before` 里的路由表追加一行（注意 `handleRunAttach(url, res)` 是 `(url, res)` 两参，与另两个 handler 的 `(req, res)` 不同）：

```js
    if (url.pathname === '/api/run') return handleRunAttach(url, res);
```

然后追加用例：

```js
/**
 * attach 撞上不存在的 run 时，必须如实告诉前端「还有没有人会送新 run 上来」。
 * 前端的「run 不存在 → 静默等待」分支等的就是这个新 run；没有计划却让它等，
 * 气泡就永久停在「运行中…」（2026-08-28 事故的后半段）。
 */
test('GET /api/run 撞上不存在的 run：按 pending 条目回 resumePlanned', async () => {
  // SSE 端点会持续挂住连接，只读首个事件块即可断开
  const readFirstEvent = async (query) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/run?${query}`, { signal: ac.signal });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    ac.abort();
    return new TextDecoder().decode(value);
  };

  // 无 pending 条目 → false
  let chunk = await readFirstEvent('runId=run_ghost&convId=c_no_plan');
  assert.match(chunk, /run 不存在或已过期/);
  assert.match(chunk, /"resumePlanned":false/, '无续跑条目必须明确回 false，前端据此中性终结');

  // 有活条目 → true
  addPending({ convId: 'c_has_plan', session_id: 's1', resetsAt: Math.floor(Date.now() / 1000) });
  chunk = await readFirstEvent('runId=run_ghost&convId=c_has_plan');
  assert.match(chunk, /"resumePlanned":true/, '有 waiting 条目应让前端继续静默等待');

  // 不传 convId → null（未知），前端按现状静默等待，老前端不回归
  chunk = await readFirstEvent('runId=run_ghost');
  assert.match(chunk, /"resumePlanned":null/, '拿不到判据时不能谎报 false');
});
```

（`addPending` 的 import 已在本步开头一并加好。该文件用的是 `await import(...)` 风格——因为要先设 `process.env.APP_DATA_DIR` 再加载 store，顺序不能反。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/entrypoints/web/routes-run.test.js`
Expected: FAIL — 响应里没有 `resumePlanned` 字段

- [ ] **Step 3: 最小实现**

`src/entrypoints/web/routes-run.js` 顶部 import 补两项：

```js
import { getPending, removePendingByConv } from '../../store/pending-resume.js';
import { runIdsToAbortOnDismiss, isResumePlanned } from './run-claude.logic.js';
```

（`getPending` 已在导入列表里，只需追加 `isResumePlanned`。）

`handleRunAttach` 里的 run 不存在分支改为：

```js
  const run = getRun(runId);
  if (!run) {
    // convId 缺失（老前端/异常调用）时给 null 而不是 false：前端把 null 当「未知」按现状静默
    // 等待。拿不到判据就谎报 false 会把真会续跑的任务提前终结，代价比多转一会儿圈大。
    const convId = (url.searchParams.get('convId') || '').trim();
    const resumePlanned = convId ? isResumePlanned(getPending(), convId) : null;
    sendTo(res, 'error', { message: 'run 不存在或已过期', resumePlanned });
    return res.end();
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/entrypoints/web/routes-run.test.js`
Expected: PASS，既有用例全绿

- [ ] **Step 5: 自检（不提交）**

Run: `node --test src/entrypoints/web/routes-run.test.js src/entrypoints/web/run-claude.logic.test.js`
Expected: 两个文件全绿

---

### Task 3: `attachStream` 的 SSE URL 带上 convId

**Files:**
- Modify: `public/js/chat.js:2319`

- [ ] **Step 1: 改 URL 拼接**

`chat.js:2318` 的 `attachStream(convId, asstIndex, runId, job)` 里，把 `:2319` 那行：

```js
        const es = new EventSource('/api/run?runId=' + encodeURIComponent(runId));
```

改成：

```js
        // 带上 convId：run 已从内存注册表消失时（进程重启/已 GC），服务端无从反查它属于哪个会话
        //（settleRun 也已把它从 active-runs.json 删掉），拿不到 convId 就查不了有没有续跑计划。
        const es = new EventSource(
          '/api/run?runId=' + encodeURIComponent(runId) + '&convId=' + encodeURIComponent(convId || ''),
        );
```

`attachStream` 的四个调用点都已传 convId 作首参（`chat.js:784`、`:2585` 及 `refreshPending` 内两处），无需改调用方。

- [ ] **Step 2: 确认调用点都传了 convId**

Run: `grep -n "attachStream(" public/js/chat.js`
Expected: 每处首参都是 convId 或 `e.convId` / `id`（会话 id 变量），无 `attachStream(undefined` 之类

- [ ] **Step 3: 自检（不提交）**

Run: `node --test public/js/chat.path.test.js`
Expected: 20 条用例，**2 条失败**——`.md` 图标断言期望 📄 实得 📝。这是 HEAD `013663a` 起就存在的既有红，与本改动无关，**不要去"修"它**。其余 18 条须绿。

---

### Task 4: SSE `error` 分支按 `resumePlanned` 三态分流

**Files:**
- Modify: `public/js/chat.js:2539`（「run 不存在」分支）

- [ ] **Step 1: 改分支**

`chat.js` 的 `es.addEventListener('error', ...)` 里，把「run 不存在」分支整体替换。原代码：

```js
            if (m.includes('run 不存在') || m.includes('已过期')) {
              // 静默：保持 pending 状态，等 refreshPending 检测到 resuming 状态的新 runId 时自动接流
              // （不调 endJob，不显示错误提示，spinner 继续转，job 继续等待）
              // 进程重启丢失持有区：本 run 的排队消息标「未发送」（续跑只续 session，不带排队消息）
              // 边界：run 已正常跑完但被 GC 时也走此路径，可能把实际已消费的消息误标未发送（无真相来源，保守处理）
              const conv = loadConvs().find((x) => x.id === convId);
              if (conv) {
                conv.messages.forEach((msg, i) => {
                  if (msg.queued && msg.runId === runId) setMsgQueuedState(convId, i, 'unsent');
                });
              }
              job.pending = true; // 标记为等待状态，refreshPending 据此切换 runId 时重新接流
              es.close();
              return;
            }
```

替换为：

```js
            if (m.includes('run 不存在') || m.includes('已过期')) {
              // 进程重启丢失持有区：本 run 的排队消息标「未发送」（续跑只续 session，不带排队消息）。
              // 无论下面走哪一态都要做：持有区已经没了，这是事实。
              // 边界：run 已正常跑完但被 GC 时也走此路径，可能把实际已消费的消息误标未发送（无真相来源，保守处理）
              const conv = loadConvs().find((x) => x.id === convId);
              if (conv) {
                conv.messages.forEach((msg, i) => {
                  if (msg.queued && msg.runId === runId) setMsgQueuedState(convId, i, 'unsent');
                });
              }
              es.close();
              // 服务端明确说了「这个会话没有续跑计划」→ 再等下去没有任何人会送新 run 上来，
              // 气泡会永久停在「运行中…」（2026-08-28 事故的后半段）。中性终结，不标红：
              // 任务不是失败，是早就结束了、只有本地状态过期。
              // resumePlanned 为 null/缺失（老服务端、或没传 convId）时按未知处理，沿用静默等待。
              let planned = null;
              try {
                planned = JSON.parse(e.data).resumePlanned;
              } catch {}
              if (planned === false) {
                if (!job.text.slice(job.base).includes('⏹')) {
                  job.text += (job.text ? '\n\n' : '') + '⏹ 任务已结束（进程重启，无自动续跑）';
                }
                job.shown = job.text.length;
                if (job.base > job.text.length) job.base = 0;
                convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
                convSetMsgFields(convId, job.asstIndex, { pending: false });
                endJob(convId, false); // 中性收尾，不标红
                return;
              }
              job.pending = true; // 标记为等待状态，refreshPending 据此切换 runId 时重新接流
              return;
            }
```

注意三点：
1. `es.close()` 提到分支判断**之前**——两态都要关流，且中性终结那条尤其不能留着连接（EventSource 会自动重连去拉这个已终结的 run）
2. `planned` 用 `JSON.parse(e.data)` 重新取而不是复用上面解析 `m` 时的变量——上面那段是 `try { m = JSON.parse(e.data).message } catch {}`，只取了 `message`
3. `=== false` 而非 `!planned`——`null`（未知）和 `undefined`（老服务端）必须落到静默等待

- [ ] **Step 2: 确认引用的函数都在作用域内**

Run: `grep -n "function endJob\|function convSetMessage\|function setMsgQueuedState" public/js/chat.js; grep -n "convSetMessage\|convSetMsgFields" public/js/chat.js | head -3`
Expected: `convSetMessage` / `convSetMsgFields` 来自 `conv-store.js` 的 import（文件顶部），`endJob` 是 chat.js 内的函数——三者在 `attachStream` 里都已被其它分支用过，作用域没问题

- [ ] **Step 3: 人工验证（需启服务）**

1. 起服务，开一个会话发一句话，等它跑完
2. 手动构造过期 pending 气泡：浏览器 devtools 里改 localStorage 的 `claude_convs`，把该会话最后一条 assistant 消息加上 `"pending":true,"runId":"run_ghost"`
3. 刷新页面 → 该会话应出现「⏹ 任务已结束（进程重启，无自动续跑）」，**不再转圈**，输入框可用
4. 再验反面：`node -e` 往 `pending-resume.json` 塞一条 `{convId:'<该会话id>', status:'waiting'}`，重复步骤 2-3 → 应**保持转圈**（静默等待），证明没误伤真会续跑的场景

- [ ] **Step 4: 自检（不提交）**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 2`（仅 `chat.path.test.js` 的既有 `.md` 图标红），其余全绿

---

### Task 5: `dev-prompt-claim` 领票端点

**Files:**
- Modify: `src/entrypoints/web/routes-req-v2.js`
- Create: `src/entrypoints/web/routes-req-v2.claim.test.js`

- [ ] **Step 1: 写失败测试**

新建 `src/entrypoints/web/routes-req-v2.claim.test.js`：

```js
/**
 * develop 首轮提示词的「领票」端点。
 *
 * 为什么要有票：原判据是前端 localStorage 里「这个会话有没有消息」。服务端起的开发 run
 * 若当时没人挂着看，过程压根不落 localStorage（loadReqTranscript 的注释自己承认这点），
 * 于是下次进入被判成「从没开发过」，提示词重发一遍、开新 session、再烧一份额度
 *（2026-08-28 日志实证：02:09:01 与 02:58:56 各发了一次同一份【需求】v5.8 提示词）。
 * 而且 localStorage 不跨窗口加锁，两个窗口会同时判 false 各发一遍。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reqv2-claim-'));

const { handleReqV2Routes } = await import('./routes-req-v2.js');
const { createRequirement, updateRequirement, getRequirement } = await import('../../store/requirements.js');

let server, base;
test.before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const hit = handleReqV2Routes(req, res, url, url.pathname, req.method);
    if (!hit) res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const claim = async (id) => {
  const res = await fetch(`${base}/api/req/dev-prompt-claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('首次领票 granted:true 并落 devPromptSentAt；再领 granted:false', async () => {
  const r = createRequirement({ title: '领票需求' });
  updateRequirement(r.id, { phase: 'dev' });

  const first = await claim(r.id);
  assert.equal(first.status, 200);
  assert.equal(first.json.granted, true, '首次必须领到票，否则提示词永远发不出去');
  assert.ok(getRequirement(r.id).devPromptSentAt, '领到票就要落标记，否则下次还会重发');

  const second = await claim(r.id);
  assert.equal(second.json.granted, false, '第二次必须拒票——这正是重发 bug 的闸门');
});

test('存量数据：无 devPromptSentAt 但有 devSession → 拒票并回填标记', async () => {
  const r = createRequirement({ title: '存量需求' });
  updateRequirement(r.id, { phase: 'dev', devSession: 'sess-old' });

  const got = await claim(r.id);
  assert.equal(got.json.granted, false, '历史需求上线后首次打开不能被补发一次提示词');
  assert.ok(getRequirement(r.id).devPromptSentAt, '兜底判定也要回填，避免每次进入都重算');
});

test('两者都无 → 视为全新，放票', async () => {
  const r = createRequirement({ title: '全新需求' });
  updateRequirement(r.id, { phase: 'dev' });
  assert.equal((await claim(r.id)).json.granted, true);
});

test('id 不存在 → 400，不放票', async () => {
  const got = await claim('r_not_exist');
  assert.equal(got.status, 400);
  assert.notEqual(got.json?.granted, true);
});

test('缺 id → 400', async () => {
  const got = await claim('');
  assert.equal(got.status, 400);
});
```

（签名已核实：`createRequirement({ title })` 收对象、`getRequirement(id)`、`updateRequirement(id, patch, event)`——`src/store/requirements.js:26/18/100`。上面的测试代码可直接用。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/entrypoints/web/routes-req-v2.claim.test.js`
Expected: FAIL — 404（路由未注册）

- [ ] **Step 3: 最小实现**

`src/entrypoints/web/routes-req-v2.js` 加 handler（放在文件内其它 handler 旁，分发表之前）：

```js
/**
 * develop 首轮提示词领票：granted:true 表示「本次由你负责发」，同时落 devPromptSentAt。
 *
 * 为什么是「先领票再发」而不是「发完再标记」：前端原判据（localStorage 里会话有没有内容）
 * 在多窗口下会同时为 false，两边各发一遍。领票把并发挡在 updateJson 的文件锁里；
 * 反过来「发完再标记」挡不住——两个窗口都会先通过判断。
 */
function handleDevPromptClaim(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: '缺少 id' });
    const r = getRequirement(id);
    if (!r) return sendJson(res, 400, { error: '需求不存在' });
    if (r.devPromptSentAt) return sendJson(res, 200, { ok: true, granted: false });
    // 存量兜底：上线前进入过开发期的需求没有本字段，但 devSession 非空即说明系统任务跑过。
    // 不兜的话所有历史需求在首次打开时都会被补发一次提示词 —— 那正是本次要修的 bug。
    // 回填用当前时间：它只是「已发过」的标记位，不谎称是历史时间。
    const already = !!r.devSession;
    updateRequirement(id, { devPromptSentAt: new Date().toISOString() });
    return sendJson(res, 200, { ok: true, granted: !already });
  });
}
```

分发表追加（与同文件其它行同风格，注意 v2 的 `, true` 哨兵）：

```js
  if (pathname === '/api/req/dev-prompt-claim' && method === 'POST') return handleDevPromptClaim(req, res), true;
```

**无需补任何 import**：`getRequirement` / `updateRequirement`（`:10`）、`sendJson`（`:24`）、`withJsonBody`（`:25`）、`str`（`:26`）在该文件里都已具备。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/entrypoints/web/routes-req-v2.claim.test.js`
Expected: PASS，5 条全绿

- [ ] **Step 5: 自检（不提交）**

Run: `node --test src/entrypoints/web/routes-req-v2.claim.test.js src/entrypoints/web/routes-requirements.test.js src/entrypoints/web/requirement-ops.test.js`
Expected: 全绿（确认新字段没打乱既有需求测试）

---

### Task 6: 前端判据换成领票

**Files:**
- Modify: `public/js/req-chat.js:123-147`

- [ ] **Step 1: 替换判据**

`req-chat.js` 的 `mountReqChrome` 里，把 `:123` 起的整段自动发送逻辑替换。原代码：

```js
  // 自动发 develop 提示词：phase=dev + 会话无实质内容 + 无正在跑的任务 + 有开发文档
  // 每次打开会话时检测；已有内容（历史/已跑过）则跳过，不重复发送
  if (
    data.phase === 'dev' &&
    !data.busy?.kind &&
    data.devDoc?.versions?.length &&
    data.convId
  ) {
    const convList = loadConvs();
    const conv = convList.find((c) => c.id === data.convId);
    const hasContent = conv?.messages?.some((m) => (m.text || '').trim());
    // 三重确认，缺一不可：
    //   epoch / currentReqId —— fetch 期间用户可能切到别的需求；
    //   getCurrentConvId() === data.convId —— 关键且曾遗漏：sendMessageProgrammatically 以
    //     chat.js 的 currentConvId 为发送目标（它不收 convId 参数），用户在 mount 与本行之间
    //     点了侧栏别的会话，开发提示词就会被发进那个**无关会话**（真 bug，非防御性冗余）。
    if (
      !hasContent &&
      epoch === chromeEpoch &&
      currentReqId === reqId &&
      getCurrentConvId() === data.convId
    ) {
      sendMessageProgrammatically(buildDevPrompt(data), { mode: 'bypassPermissions' });
    }
  }
```

替换为：

```js
  // 自动发 develop 提示词：phase=dev + 无正在跑的任务 + 有开发文档 + 服务端放票
  //
  // 判据不看 localStorage：服务端起的开发 run 若当时没人挂着看，过程压根不落 localStorage
  //（见 chat.js 的 loadReqTranscript 注释），会话空空如也不等于没开发过 —— 旧判据据此重发
  // 提示词、开新 session、再烧一份额度。改成向服务端领票，标记落在需求记录上（跨窗口、跨浏览器）。
  if (
    data.phase === 'dev' &&
    !data.busy?.kind &&
    data.devDoc?.versions?.length &&
    data.convId
  ) {
    let granted = false;
    try {
      const r = await fetch('/api/req/dev-prompt-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId }),
      });
      granted = !!(await r.json())?.granted;
    } catch {
      granted = false; // 网络失败一律不发：宁可漏发（用户手打一句即可）也不重发烧额度
    }
    // 三重确认必须在 await **之后**再校验，缺一不可：
    //   epoch / currentReqId —— 往返期间用户可能切到别的需求；
    //   getCurrentConvId() === data.convId —— 关键且曾遗漏：sendMessageProgrammatically 以
    //     chat.js 的 currentConvId 为发送目标（它不收 convId 参数），用户在 mount 与本行之间
    //     点了侧栏别的会话，开发提示词就会被发进那个**无关会话**（真 bug，非防御性冗余）。
    // 领票端点在上面那次 fetch 里已经消耗掉票了，此处放弃 = 该需求这轮不再自动发。
    // 这是有意取舍：用户已经切走，说明他此刻不在等这个提示词；比发错会话轻得多。
    if (
      granted &&
      epoch === chromeEpoch &&
      currentReqId === reqId &&
      getCurrentConvId() === data.convId
    ) {
      sendMessageProgrammatically(buildDevPrompt(data), { mode: 'bypassPermissions' });
    }
  }
```

`mountReqChrome` 本身已是 `async function`（`req-chat.js:99`），可直接 `await`。

- [ ] **Step 2: 删掉不再需要的 import**

`loadConvs` 在本文件里只有 `:131` 那一处用法（即 Step 1 刚删掉的 `const convList = loadConvs()`），已核实无其它引用。删掉 `:8` 的整行：

```js
import { loadConvs } from './conv-store.js';
```

Run: `grep -n "loadConvs" public/js/req-chat.js`
Expected: 无输出

- [ ] **Step 3: 确认现有测试不受影响**

Run: `node --test public/js/req-chat.apidoc.test.js`
Expected: PASS。注意该文件第 35 行注释「留空避免触发『首轮 develop 提示词』自动发送」——它靠 `devDoc.versions` 为空来规避，与本次改的判据无关，应仍然绿。

- [ ] **Step 4: 人工验证（需启服务）**

1. 起服务，进一个 dev 期需求会话（`devDoc` 已有版本、无 busy）→ 应自动发一次 develop 提示词
2. 关页重进同一需求 → **不再重发**；查 `logs/app-<date>.log`，不应出现第二条 `resume:"no"` 的【需求】提示词
3. devtools 里清掉 localStorage 的 `claude_convs` 再重进 → 仍**不重发**（证明已脱离 localStorage）
4. 两个窗口同时进入同一需求 → 只发一次
5. 造一个已有 `devSession` 的存量需求，首次打开 → 不发

- [ ] **Step 5: 自检（不提交）**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 2`（仅 `chat.path.test.js` 既有 `.md` 图标红）

Run: `git status --short`
Expected: 只有本计划涉及的 8 个文件为 M/??，**无 commit**

---

## 验收（spec §7）

两组各自独立验收，全部需启服务：

**缺口①**

1. 跑完一个任务 → 重启服务 → 重进该会话：旧 pending 气泡中性终结，不再永久转圈
2. 任务跑一半 kill 进程再启（触发孤儿恢复）→ 重进会话：**仍然**静默等待并接上续跑的新 run（验证没误伤 `true` 态）
3. 飞书回一句补充内容、网页不开；隔一段时间打开该会话 → 用户气泡上屏一次、无转圈气泡、`conv-notify.json` 的 inbox 被清空

**缺口②**

4. 进入 dev 期需求 → 首次自动发；关页/换窗口/清 localStorage 后重进 → 不重发
5. 两窗口同时进入同一需求 → 只发一次
6. 存量 dev 期需求（已有 `devSession`）上线后首次打开 → 不发

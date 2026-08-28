# 异常结束自动重试 — 设计文档

**日期**：2026-08-27
**目标**：会话异常结束（当前表现为气泡变红 + 「⚠️ Claude 异常结束」）后，延迟 2 秒自动续接 session 重试，而不是把失败直接甩给用户。

## 1. 现状

异常终结有三条来源，最终都汇聚成同一个 `done(is_error:true)` 广播：

| 来源 | 落点 | 终结函数 |
|---|---|---|
| SDK 抛错（进程崩溃/传输错误） | `run-claude.js:288` `settleRun` 的 `err` 分支 | `failRun` |
| 看门狗静默中断 | `runs.js:472` `abortRun` → `runs.js:485` | `failRun` |
| `result.is_error`（CLI 自述失败） | `runs.js:343` `runResult` 落 `is_error` → `finishRun` | `finishRun` |

前端 `chat.js:2480` 收到 `is_error` → `job.err = true` → `endJob(convId, true)` → 气泡加 `.err` 类标红、吉祥物切 error 态、任务彻底结束。

**已有的自动续跑只覆盖两类终结**，异常是唯一没接进这套机制的路径：

- **额度撞墙**：`settleRun` 的 `rejected` 分支 → `addPending` + `blockRun` + `doResume/scheduleResume`
- **进程重启孤儿**：`recoverPendingAndOrphans` → `addPending(reason:'orphan_recovery')`

可复用的现成件：`store/pending-resume.js`（落盘登记 + `shouldAbandonResume` 熔断判定）、`doResume()`（新建 run 续接 session 发「继续」）、`MAX_RESUME_ATTEMPTS = 3`、前端 `refreshPending()` 的 `resuming` 自动接流与 `abandoned` 一次性提示。

**结论**：本需求不需要新机制，只是给这套续跑机制**加一个新的触发源**。

## 2. 拍板结论

| 决策点 | 结论 | 理由 |
|---|---|---|
| 重试落点 | **服务端**复用 `pending-resume` | 关页/切会话/刷新期间也能重试，跨进程重启持久化，天然带 3 次熔断上限；前端只需把红字改成中性提示 |
| 重试范围 | **全部异常统一重试**（SDK 抛错 + 看门狗 + `result.is_error`） | KISS：不引入靠字符串匹配的脆弱错误分类。3 次上限意味着最坏情况也只多烧 3 轮 |
| 需求系统任务 | **一并重试，`onSettle` 延后** | 自动开发/API 修正/BUG 修复这类长任务恰是最痛的崩溃场景。语义与额度分支完全一致 |
| 重试延迟 | 2 秒 | 用户指定 |

## 3. 服务端改动

### 3.1 `src/entrypoints/web/run-claude.js` — 异常重试分支

新增常量：

```js
const RETRY_DELAY_MS = 2000; // 异常结束后的重试延迟
```

在 `settleRun` 内、`if (params.resumePendingId) removePending(...)`（原 `:274`）**之前**插入重试分支。判定拆成两段：`isRetryEligible()`（资格，纯函数）+ 现成的 `shouldAbandonResume()`（代次）。拆开是因为 `settleRun` 必须区分「够格但超上限」（要落 `abandoned` 让前端提示一次熔断）和「压根不够格」（如手动停止、无 session 锚点，静默走原有终结路径）。

`isRetryEligible` 的四组条件：

| 条件 | 为什么 |
|---|---|
| `err \|\| run.is_error` | 确有异常 |
| `run.status` ∈ {`running`, `error`} | `running` 是 SDK 直接抛错/自述失败、尚未终结的常态。**`error` 是看门狗/超时路径**——`abortRun` 先调 `failRun` 把 status 改 `'error'`，之后 SDK 的 done reject 才到达 `settleRun`；只认 `'running'` 会把看门狗中断整类排除在重试之外。手动停止（`stopRun`）落的是 `'done'`，天然被这条挡住 |
| `run.subtype` 不是 `stopped`/`quota_blocked` | 纵深防御。前者是用户刚点的停止，重试等于抗命；后者归额度分支管（它已提前 return，走到这里说明状态异常） |
| `sid && params.convId` | 有 session 锚点才能续接。判档窗口/首轮 `onInit` 前崩溃的续不了 |

其中 `nextAttempt = (params.resumeAttempt || 0) + 1`，代次由 `shouldAbandonResume(nextAttempt, MAX_RESUME_ATTEMPTS)` 裁定。

动作序列（与 `rejected` 分支同构）：

1. `consumeHeldMsgs(run)` 取排队消息拼进续跑 prompt —— 不做的话这些消息会被 `unsentField` 标「未发送」而丢掉
2. `addPending({ convId, session_id, cwd, model, effort, mode, attempts: nextAttempt, reason: 'exception_retry', prompt: heldTexts, resetsAt: now })`
3. `retryRun(run, '⚠️ <原因> + 🔄 N 秒后自动重试（第 x/3 次）', RETRY_DELAY_MS)` 中性广播（见 3.2）
4. `scheduleRetry(entry, RETRY_DELAY_MS)`
5. `return` —— **不触发 `run.onSettle`**

**看门狗路径的降级**：`status === 'error'` 时 `failRun` 已经广播过红字终结并关掉了 SSE，`retryRun` 内部的 status 闸门让它自动 no-op —— 那条路径发不出中性提示。用户会看到「红字气泡 + 稍后自动接续的新气泡」，语义上仍成立（上一轮异常了，这是重试的新一轮），只是不如 `running` 路径顺滑。改成让看门狗延后终结不可行：`abortRun` 的注释写明「SDK abort 是优雅关闭，CLI 卡在限流重试上时会继续跑到自然结束」，延后 `failRun` 会让前端长时间没有任何终结信号。作为补偿，前端 `is_error` 分支也发起提前轮询（见 4.1）。

超上限时不走上面这套，改为 `abandonResume({ convId, attempts: nextAttempt, reason })`，然后**照旧**落到原来的 `failRun`/`finishRun` 标红路径，让前端 `refreshPending` 消费一次 `abandoned` 提示。

**重试代次 `+1` 递增**（额度分支是 `attempts: params.resumeAttempt || 0` 继承不递增）：额度撞墙是外部资源限制、等到重置必然有效，不该计次；异常有病态循环风险，必须计次。且异常重试与孤儿恢复**共享同一个 `attempts` 计数器** —— 「孤儿续跑 → 异常 → 重试 → 异常」交替失败也无法绕过 3 次上限。

`onSettle` 延后的代价与收益：重试路径上 `onSettle` 不触发，需求系统任务的 busy 闸继续持有，直到重试成功（`onSettle(true)`）或熔断（`onSettle(false)`）。代价是失败反馈最多延后 3 轮，期间该需求一直显示 busy；收益是瞬态故障能自愈，不用人工重跑。`settleRun` 现有注释（`:275-278`）已经写明「rejected 分支命中时已 return，那里的 run 还会经 doResume 生成新 run 续跑，任务逻辑上并未结束」—— 异常重试沿用同一条推理。

### 3.2 `src/store/runs.js` — 新增 `retryRun`

仿 `blockRun`（`:489`）写一个中性终结函数：

```js
/** 异常待重试：中性终结并附提示（不标红），任务将于 retryInMs 后自动续跑 */
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

- `status = 'done'` 而非 `'error'`：`'error'` 会让左栏、`/api/run/:id`、通知侧都按「已失败」渲染，但任务其实还在跑
- `run.is_error` 真值**保留不改**：`routes-run.js:252` 的状态查询要如实反映本轮确实异常了；通知侧由 3.3 的 subtype 过滤挡住，不会拿它渲染失败卡片
- `fanout` 的 `is_error: false`：前端据此不标红
- `retryInMs`：前端用来算提前轮询的时机（见 4.2）

### 3.3 `src/entrypoints/web/conv-notify.logic.js` — 通知过滤

`shouldNotifySettle` 的排除列表加 `'exception_retry'`：

```js
return !['stopped', 'quota_blocked', 'exception_retry'].includes(run.subtype);
```

理由与 `quota_blocked` 同：正在重试的任务逻辑上没结束，重试真终结或熔断时才推飞书。不加这条，一次异常会推一张「❌ 任务失败」卡片，紧接着重试成功再推一张「✅ 任务已完成」，属于噪音误报。

## 4. 前端改动（`public/js/chat.js`）

### 4.1 `done` 处理器新增分支

在 `subtype === 'quota_blocked'` 之后、`else if (d.is_error)` **之前**插入：

```js
} else if (d.subtype === 'exception_retry') {
  // 异常但服务端已排程重试：不标红、不 endJob，spinner 继续转
  if (d.result) job.text = d.result; // 服务端已附「原因 + 2 秒后自动重试」
  job.shown = job.text.length;
  convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
  job.pending = true;              // 等 refreshPending 切到新 runId 时重新接流
  try { job.es.close(); } catch {}  // 必须显式关流（见下）
  // 15s 轮询周期太慢，主动提前拉两次
  const d1 = (d.retryInMs || 2000) + 800;
  setTimeout(refreshPending, d1);
  setTimeout(refreshPending, d1 + 3000);
  return;
}
```

三个要点：

- **必须显式 `job.es.close()`**：服务端 `closeAll` 只是 `res.end()`，EventSource 会自动重连去拉这个已终结的 run，撞上「已结束 run 补发 done」的逻辑 → 无限循环。现有「run 不存在」分支（`:2519`）就是这么处理的
- **不调 `endJob`**：`endJob` 会关流、定稿 markdown、停打字机、切吉祥物状态。任务还在继续，不能收尾
- **`job.pending = true`**：直接复用「run 不存在静默等待」那套语义，气泡保持 `pending`，刷新页面也能经 `openConv` 重连

排队消息（`d.unsent`）不需要特殊处理：服务端已在重试分支 `consumeHeldMsgs` 把它们打包进续跑 prompt，`unsentField` 取到的是空数组，与额度分支表现一致。

两次提前轮询抽成 `scheduleRetryPolls(retryInMs)` 供两处复用：`exception_retry` 分支，以及 **`is_error` 分支**——看门狗路径拿不到 `exception_retry` 信号（见 3.1 的降级说明），只能靠这个把新 run 的接流空窗从 15s 压到 ~3s。副作用是普通异常（真的没重试）时也会多发两次 `/api/run/pending` 请求，代价可忽略。

### 4.2 新 run 接流：零新增代码

`refreshPending()`（`:3154-3164`）已有分支：`runningJobs[convId]` 存在且 `job.pending && job.runId !== e.runId` → 切 `job.runId`、清 `pending`、`attachStream`。异常重试产生的新 run 会以 `status:'resuming'` 出现在 pending 列表里，直接命中这条，`replay` 事件把服务端权威全文拉回来。

轮询周期是 `setInterval(refreshPending, 15000)`（`:3193`）。不做提前轮询的话，「2 秒后重试」在用户眼里会变成「最多 17 秒才见动静」，所以 4.1 里补了两次定时拉取（`retryInMs + 800` 与再 `+3000` 兜底），15s 周期仍作最终兜底。

> 备选方案（未采纳）：服务端先 `createRun()` 拿到 runId 再延迟 `startClaudeRun`，`done` 事件直接带 `nextRunId`，前端立刻 `attachStream`，零空窗。放弃原因是引入「已在注册表但还没进程」的中间态，看门狗与 `/api/run/:id` 都要额外判空，为省 1~2 秒不值得。

### 4.3 停止按钮必须能取消重试

因为 4.1 不调 `endJob`，`stopBtn` 在等待重试期间**仍然可见**（`updateComposerRunning` 只看 `runningJobs[convId]` 是否存在）。但此时 run 已终结，`/api/run/abort` 的 `abortRunById` 会因 `status !== 'running'` 返回 `false` —— 用户点了停止，2 秒后任务照样活过来。

所以停止路径要加前置判断：若 `job.pending` 为真（等待重试/等待续跑），改为调 `dismissPending(convId)` + `endJob(convId, false)` 并在气泡追加「⏹ 已手动停止」，不走 `/api/run/abort`。

服务端侧的常规清理是自动的：`removePendingByConv` 删掉条目后，2 秒定时器照样触发 `doResume(entryId)`，但 `doResume` 开头 `getPending().find((e) => e.id === entryId)` 找不到条目直接 `return`（`run-claude.js:307`），定时器自然失效。

**但有一个窄竞态需要额外处理**：若用户在第 1.9 秒才点停止，`doResume` 可能已经起了新 run。删条目只能让前端不再接流，挡不住已在跑的进程 —— 会留下一个「前端看不见、还在烧额度、还在写工作目录」的孤儿 run。因此 `handleRunPendingDismiss`（`routes-run.js:105`）在 `removePendingByConv` 之前要顺手中止已起跑的 run：取该 convId 下 `status === 'resuming'` 且有 `runId` 的条目，逐个 `abortRunById(runId, '已手动停止')`。判定逻辑抽成纯函数 `runIdsToAbortOnDismiss(entries)` 便于单测。

这条清理对额度续跑、孤儿恢复路径同样生效（它们的 `resuming` 条目此前 dismiss 时也留孤儿），属于顺带修掉的既有缺口。

### 4.4 `renderPendingBanner()` 文案

新增 `reason === 'exception_retry'` 分支：「任务异常中断，正在自动重试…」（复用 `REFRESH_ICON_SVG`）。`/api/run/pending` 已透传 `reason`（`routes-run.js:99`），前端 `pendingMap` 已取该字段，无需改接口。

熔断提示沿用现有 `abandoned` 分支文案，措辞微调为兼容异常场景：「⚠️ 连续 N 次自动重试均未完成，已停止自动重试；如需继续请手动发送消息。」

## 5. 边界与风险

| 场景 | 行为 |
|---|---|
| 缺 `session_id`（判档窗口崩溃） | 无法续接，维持现状标红 |
| 停止先于 SDK 收尾 | `stopRun` 已把 status 改 `done` → `settleRun` 的重试条件（`status === 'running'`）不成立，**整个分支不进、不登记 pending**。条件判断必须放在 `addPending` 之前 |
| 停止发生在 2 秒等待窗口内 | run 已终结、`/api/run/abort` 会返回 `false`，改由前端走 `dismissPending` 取消（见 4.3） |
| 等待重试期间用户插话 | `job.runId` 仍指向已终结的 run，`/api/run/msg` 会失败。这是「run 不存在静默等待」路径的既有行为，本次不扩大处理；后续可在 `job.pending` 态把发送键改为「排队待重试后发送」 |
| 连续 3 次异常 | 熔断 → 标红 + 一次性提示 + `dismissPending` |
| 多实例（PM2 web + Tauri） | 不变：`addActiveRun` 的 pid 属主标记与 `partitionActiveRuns` 已处理 |
| 异常重试与额度撞墙交替 | 各自 `addPending`，同一 convId 只保留最新一条（`addPending` 按 convId 覆盖），不会并发起两个续跑 |

## 6. 测试

按项目惯例（`*.logic.js` 纯函数 + `*.logic.test.js`）：

- **新增** `src/entrypoints/web/run-claude.logic.js` 导出两个纯函数 + 对应 `.logic.test.js`（10 条断言）：
  - `isRetryEligible({ hasError, status, subtype, sid, convId })`：真值矩阵覆盖「手动停止不重试」「看门狗 status=error 要重试」「额度阻塞不重试」「缺 session/convId 不重试」，外加与 `shouldAbandonResume` 的组合判定（代次边界 3 重试 / 4 熔断）
  - `runIdsToAbortOnDismiss(entries)`：只挑 `status==='resuming'` 且有 `runId` 的条目（见 4.3 的窄竞态），含非数组入参防御
- **`src/store/runs.test.js`**：仿 `blockRun` 那条（`:295`）加 3 条 `retryRun` 断言 —— 广播契约（`subtype='exception_retry'` + `status='done'`）、文本追加且保留 `is_error` 真值、非 running 时不重复广播
- **`src/entrypoints/web/conv-notify.logic.test.js`**：加 `shouldNotifySettle({subtype:'exception_retry'}) === false`
- **回归**：额度用尽续跑、孤儿恢复、手动停止、正常完成四条路径的现有断言全绿

## 7. 验收

1. 人工触发异常（如 kill 掉底层 CLI 进程）→ 气泡显示「⚠️ … / 🔄 2 秒后自动重试…」，**不变红**、spinner 不停
2. 约 2~3 秒后自动接上新 run 继续跑，`replay` 把已产出内容补齐
3. 重试期间关闭网页 → 重开会话仍能看到任务在跑
4. 连续 3 次异常 → 熔断标红 + 提示，`pending-resume.json` 该条目被 dismiss
5. 重试成功的任务在飞书只收到一条「✅ 任务已完成」，没有中间的失败误报
6. 自动开发任务异常 → 需求仍显示 busy，重试成功后正常推进阶段
7. 异常后 2 秒等待窗口内点「停止」→ 任务真的停住，不会在 2 秒后自己活过来

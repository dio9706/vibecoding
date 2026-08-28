# 隔天重进入的状态判据修正 — 设计文档

**日期**：2026-08-28
**目标**：修掉两处「隔天重进入会话时，前端凭 localStorage / 已消失的内存状态做判断」导致的误判：① 接流撞上已死的 run 后永久转圈；② develop 首轮提示词被重复自动发送。

**来由**：2026-08-28 排查「需求会话隔天重进入后无限自动重发最后一句、且没有响应」时发现。该 bug 的根因（`conv-notify.js` 漏 `await` 导致 `/claim` 从不发送）已单独修复，本文处理调查中暴露的两个**同源但独立**的缺口。

## 1. 现状

两处缺口的共同病灶：**判断依据放在了会随进程/浏览器消失的载体上**（内存 run 注册表、localStorage），而真相来源在服务端落盘数据里。

### 1.1 缺口① — 接流撞上已死的 run 后永久转圈

`runs.js` 的 run 注册表是纯内存的，进程重启即清空。前端却持有跨重启存活的 runId：

| 入口 | 位置 | runId 来源 |
|---|---|---|
| openConv 按持久化 pending 气泡重连 | `chat.js:783` `attachStream(id, k, m.runId)` | localStorage 里 `pending:true` 的助手气泡 |
| 系统任务 / 飞书注入项补种气泡 | `chat.js:2574` `ensureConvRunAttached` → `attachStream` | 需求 `busy.runId`、注入项 `it.runId` |

两条入口都走 `attachStream`。服务端 `handleRunAttach`（`routes-run.js:203`）对不存在的 run 回：

```js
sendTo(res, 'error', { message: 'run 不存在或已过期' });
return res.end();
```

前端 `chat.js:2530` 的 `error` 处理器在 `:2539` 命中该分支后**静默等待**：

```js
job.pending = true; // 标记为等待状态，refreshPending 据此切换 runId 时重新接流
es.close();
return;
```

这个设计假定「pending 机制会来续跑」—— `refreshPending()` 的 `resuming` 分支会在发现新 runId 时切流。假定成立于「进程重启 → 孤儿恢复」场景：`recoverPendingAndOrphans` 在 `server.listen` 回调里同步跑完，端口开始服务时 pending 条目必然已就位。

**假定不成立的场景**：run 已正常终结并被 GC、或注入项的 runId 早已随进程消失，而 `pending-resume.json` 里没有该 conv 的任何条目。此时没有任何人会来切 runId，气泡永久停在「运行中…」。

事故现场实测：conv `c1787831977832` 的注入项带 `runId: run_mtbkuelzm87v`（前一天的 run），当时 `pending-resume.json` 为 `[]` —— 转圈不会结束。

**已有的自救**：`stopCurrentRun`（`chat.js:2283`）的 `job.pending` 分支能本地中性收尾，所以不是死锁，但要用户自己发现并动手。

### 1.2 缺口② — develop 提示词被重复自动发送

`mountReqChrome`（`req-chat.js:99`）在 `:123` 判断要不要自动发首轮 develop 提示词，判据在 `:133`：

```js
const conv = convList.find((c) => c.id === data.convId);
const hasContent = conv?.messages?.some((m) => (m.text || '').trim());
```

只看 localStorage。两个问题叠加：

1. **判据本身与同文件的另一处认知自相矛盾**。`chat.js` 的 `loadReqTranscript` 注释写明：「其过程只有在『客户端当时正挂着实时流』时才落 localStorage；若当时无人观看，会话里就空空如也」。一处承认「空不代表没跑过」，另一处却把空当作「从没开发过」。
2. **判断早于转录回放**。自动发送在 `:125`，`loadReqTranscript` 在 `:153` —— 即使转录能补内容，判断也已经做完了。

真实代价（`logs/app-2026-08-28.log`，真实数据目录）：

```
02:09:01  ▶ runClaude  resume:"no"  prompt:"【需求】v5.8 小游戏 · 分支 req/mt8hntc76jjb..."
02:09:04  init  session_id: 24e1df02-1dae-427e-9c68-0aeb2b3161a0
02:58:56  ▶ runClaude  resume:"no"  prompt:"【需求】v5.8 小游戏 · 分支 req/mt8hntc76jjb..."
02:58:59  init  session_id: 8605c384-1009-4d52-b09c-db1e6c991c52
```

同一份提示词发了两次，各自开了新 session（`resume:"no"`），各自烧一份额度。

判据还有第三个漏洞：**并发**。多窗口同时进入同一需求时，两个 `hasContent` 会同时为 false，各发一遍。localStorage 不跨窗口加锁。

## 2. 拍板结论

| 缺口 | 决策 | 理由 |
|---|---|---|
| ① 终结判据 | 服务端 attach 时告知有无续跑计划 | `pending-resume.json` 是唯一真相来源，前端不该二次拼装；不增加请求数；一处改动覆盖两条入口 |
| ② 真相来源 | 需求记录加显式标记 `devPromptSentAt` | 判据显式、幂等，跨浏览器 / 跨窗口 / 清缓存一致，彻底脱离 localStorage |

被否决的选项与原因：

- **前端接流前先问 `/api/run/pending`**：不改 SSE 契约，但每次重连多一个往返，且判据仍在前端二次拼装。
- **有界等待 N 秒**：改动最小，但拿定时器猜测——慢续跑会被误杀，且没有真相来源。
- **以 `devSession` 存在为准**：零新字段，但语义是「有过开发会话」而非「发过首轮提示词」，含糊（保留为存量数据的兜底判据，见 §4.3）。
- **进入时先拉转录再判断**：最贴近真实，但每次进入多一次磁盘 IO，且仍受「localStorage 与转录两套状态不一致」影响。

## 3. 缺口① 改动

### 3.1 `src/entrypoints/web/routes-run.js` — attach 增加 convId 与 resumePlanned

SSE 端点是 `GET /api/run?runId=`（`server.js:154` → `handleRunAttach`，注意路径不是 `/api/run/attach`）。给它增加 `convId` 查询参数。

**必须由前端传**：run 已从内存注册表消失，`settleRun` 也已把它从 `active-runs.json` 删掉，服务端无从反查 convId；而前端 `attachStream(convId, idx, runId)`（`chat.js:2318`）手里一直有。

```js
const run = getRun(runId);
if (!run) {
  // convId 缺失（老前端/异常调用）时给 null 而不是 false：前端把 null 当「未知」按现状静默等待，
  // 避免因为拿不到判据就把可能真会续跑的任务提前终结。
  const convId = (url.searchParams.get('convId') || '').trim();
  const resumePlanned = convId ? isResumePlanned(getPending(), convId) : null;
  sendTo(res, 'error', { message: 'run 不存在或已过期', resumePlanned });
  return res.end();
}
```

### 3.2 `src/entrypoints/web/run-claude.logic.js` — 新增纯函数

```js
/**
 * 该会话是否还有「会把新 run 送上来」的续跑计划。
 * 活条目判定与 recoverPendingAndOrphans（run-claude.js）、isReqRunActive（requirement-ops.js）
 * 保持同一口径：done 已完成、abandoned 是熔断标记（只等前端消费一次提示后 dismiss），两者都不会再产生新 run。
 */
export function isResumePlanned(pendingList, convId) {
  if (!convId) return false;
  return (Array.isArray(pendingList) ? pendingList : []).some(
    (e) => e && e.convId === convId && e.status !== 'done' && e.status !== 'abandoned',
  );
}
```

放 `run-claude.logic.js` 而非 `pending-resume.js`：它是 web 入口的编排判据（与 `isRetryEligible` 同性质），不是存储层语义。

### 3.3 `public/js/chat.js` — attachStream 传 convId + error 分支三态

`attachStream` 拼 URL 时带上 convId（函数签名已有该参数，无需改调用方）。

`:2539` 的「run 不存在」分支按 `resumePlanned` 分三态：

| `resumePlanned` | 行为 | 理由 |
|---|---|---|
| `true` | 保持现状：`job.pending = true`、关流、静默等待 | 确有续跑计划，`refreshPending` 会切新 runId |
| `false` | 中性终结：追加 `⏹ 任务已结束（进程重启，无自动续跑）`、`pending:false`、`endJob(convId, false)` | 没人会来救，转圈只会骗用户 |
| `null` / 字段缺失 | 保持现状（同 `true`） | 判据未知时不做破坏性动作，老前端不回归 |

中性终结走 `endJob(convId, false)` 而非 `true`：这不是任务失败，是「早就结束了、只是本地状态过期」，标红会误导。文案与 `stopCurrentRun` 的 `⏹` 前缀保持一致（同为中性终结族）。

排队消息标「未发送」的既有逻辑保留在三态之外——无论哪种情况，进程重启都已丢掉服务端持有区。

## 4. 缺口② 改动

### 4.1 需求记录新增字段 `devPromptSentAt`

ISO 串，表示首轮 develop 提示词已发出的时刻；缺失即「未发或存量数据」，由 §4.3 的兜底判据处理。

**无需改动 `src/store/requirements.js`**：`updateRequirement`（`:100`）是 `{ ...list[i], ...patch }` 的开放式 patch，没有字段白名单，新字段写进去即生效。也不做数据迁移——缺失是合法状态。

### 4.2 `src/entrypoints/web/routes-req-v2.js` — 新增领票端点

`POST /api/req/dev-prompt-claim {id}` → `{ok:true, granted:boolean}`

落在 `routes-req-v2.js` 而非 `routes-requirements.js`：后者已 730+ 行、承载 30+ 条路由，v2 文件的头注释明确了「不再往那边堆」。分发表按 v2 约定写（handler 后跟 `, true` 哨兵，与 `routes-requirements.js` 的直接返回不同）：

```js
if (pathname === '/api/req/dev-prompt-claim' && method === 'POST') return handleDevPromptClaim(req, res), true;
```

```js
// 锁内读改写（store 的 updateJson 带文件锁）：多窗口同时进入同一需求时，
// 两边的 hasContent 会同时为 false 各发一遍 —— 领票把这个并发挡在文件锁里。
// 先领票再发，不是发完再标记：反过来的话并发窗口仍会双发。
```

语义：`granted:true` 表示「本次由你负责发」，同时落 `devPromptSentAt`；`granted:false` 表示已有人发过（或存量数据判定为已发）。

幂等由文件锁 + 字段存在性共同保证，连续调两次只会 `granted` 一次。

### 4.3 存量数据兜底

`devPromptSentAt` 缺失但 `devSession` 非空 → 判定为「已发过」，回填 `devPromptSentAt`（用当前时间，仅作标记，不谎称是历史时间）并回 `granted:false`。

否则所有历史进入过开发期的需求，在本次上线后第一次打开时都会被补发一次提示词——那正是本文要修的 bug。

### 4.4 `public/js/req-chat.js` — 判据替换

`:123` 分支里删掉 `hasContent` 与 `loadConvs()` 依赖，改为向服务端领票：

```js
const { granted } = await claimDevPrompt(reqId);
if (!granted) return;
```

**三重确认（`epoch === chromeEpoch` / `currentReqId === reqId` / `getCurrentConvId() === data.convId`）必须挪到 `await` 之后再校验一次。** 原代码那三条是为「fetch 期间用户切走」准备的（注释里记着这是真 bug 非防御性冗余）；领票多了一个往返，切走的窗口更宽了。

已领到票但校验失败时不发 —— 代价是该需求这一轮不再自动发（票已消耗）。可接受：用户已经切走，说明他此刻不在等这个提示词；需要时手动发一句即可。这比「把开发提示词发进无关会话」轻。

`loadConvs` 若在本文件其它地方无用则一并移除 import。

## 5. 边界与风险

| 项 | 判断 |
|---|---|
| 缺口① 误终结正在续跑的任务 | 不会。`resumePlanned` 只在明确查到「无活条目」时才为 `false`；查不到 convId 一律 `null` 走现状 |
| 缺口① 与异常重试 2 秒窗口竞态 | 不受影响。异常重试走 `done(subtype:'exception_retry')` 分支，不经「run 不存在」分支；看门狗路径靠 `scheduleRetryPolls` 提前轮询 |
| 缺口① SSE 契约向后兼容 | 新字段是增量，老前端忽略 `resumePlanned` 即退回现状 |
| 缺口② 票被消耗但没发出去 | 见 §4.4，有意取舍 |
| 缺口② 用户主动想重发 | 不受影响。手动在输入框发消息不经这条自动发送分支 |
| 缺口② 需求被打回重新开发 | 当前不存在该场景。生产代码里写 `phase:'dev'` 的只有 `requirement-ops.js:700`（定稿建分支），是 review → dev 的单向流转；`devSession` 也只在缺失时回填一次（`requirement-ops.js:343`、`routes-requirements.js:540`）。**约束记录**：将来若新增「退回开发期重跑」的流转，必须在该流转里一并清 `devPromptSentAt`，否则重开后首轮提示词不再自动发 |

## 6. 测试

| 目标 | 落点 | 用例 |
|---|---|---|
| `isResumePlanned` | `run-claude.logic.test.js` | 有 waiting/resuming 条目 → true；只有 done/abandoned → false；空列表 / 空 convId → false；非数组入参 → false |
| attach 三态 | `routes-run.test.js` | run 存在 → 正常 replay；run 不存在 + 有活条目 → `resumePlanned:true`；run 不存在 + 无条目 → `false`；不传 convId → `null` |
| 领票幂等 | `routes-req-v2` 或 `requirement-ops.test.js` | 连调两次 → 只第一次 `granted:true`；字段落盘 |
| 存量兜底 | 同上 | 无 `devPromptSentAt` + 有 `devSession` → `granted:false` 且回填字段；两者都无 → `granted:true` |

前端三态分支不写自动化测试：`chat.js` 模块顶层即查 DOM / 注册监听 / 拉会话，`chat.path.test.js` 的注释已明确「在测试里 import 等于启动半个应用」，沿用该判断，靠 §7 人工验收。

## 7. 验收

需启服务，人工过：

1. 开一个会话跑任务，跑完后重启服务，重进该会话 → 旧 pending 气泡应中性终结「⏹ 任务已结束（进程重启，无自动续跑）」，不再永久转圈
2. 任务跑到一半 kill 进程再启（触发孤儿恢复）→ 重进会话应**仍然**静默等待并接上续跑的新 run（验证没把 `true` 态误伤）
3. 飞书回一句补充内容、网页不开；隔一段时间后打开该会话 → 用户气泡上屏一次、无转圈气泡、`conv-notify.json` 的 inbox 被清空
4. 进入 dev 期需求会话 → 首次自动发 develop 提示词；关页重进 / 换窗口 / 清 localStorage 后重进 → **不再重发**，日志无第二条 `resume:"no"` 的【需求】提示词
5. 两个窗口同时进入同一 dev 期需求 → 只发一次
6. 存量 dev 期需求（已有 `devSession`）上线后首次打开 → 不发

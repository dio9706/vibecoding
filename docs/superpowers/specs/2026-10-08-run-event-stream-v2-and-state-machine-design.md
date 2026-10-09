# Run 事件流 v2 + 任务状态机（T2）· 设计

- 日期：2026-10-08
- 状态：已确认（2026-10-08 拍板）；P1 实现中，进度见 §10
- 关联：`next-tasks.md` T2；被本设计部分替代的现状设计：`2026-07-20-auto-resume-self-recovery-design.md`（孤儿恢复 + 熔断）、`2026-07-19-web-mid-run-steering-design.md`（插话持有）、`2026-08-28-stale-run-and-dev-prompt-design.md`（attach 三态依赖 pending 判定）
- 外部参考：pi-durable（durable execution：任务检查点先于展示、提交幂等、busy inbox 语义化）
- 范围：web 执行台后端（`store/runs|active-runs|pending-resume|conv-messages`、`entrypoints/web/run-claude|run-openai|routes-run|conv-notify`、`channels/feishu` 去重）＋前端 `chat.js` 的提交/排队局部

## 1. 背景与问题

### 1.1 现状机器（四件，改动前必须认清）

| # | 机器 | 落点 | 职责 | 已知痛点 |
|---|---|---|---|---|
| 1 | **内存 run 注册表** | `store/runs.js` | run 生命周期、SSE、看门狗、审批队列、五个终结口、settle 监听 | 进程重启即失忆；一切恢复只能靠「对不上的外挂镜像」 |
| 2 | **active-runs.json 镜像** | `store/active-runs.js` + `run-claude.js#recoverPendingAndOrphans` | 崩溃后孤儿判定与续跑锚点 | 与内存状态双写；孤儿判定（pid/bootTime/桌面版共用数据目录）与熔断是历次事故高发区（2026-07-20 死循环、多实例抢跑） |
| 3 | **pending-resume.json 队列** | `store/pending-resume.js` + `run-claude.js#settleRun/doResume` | 额度等待、异常重试、孤儿恢复共用一份待续跑队列 + `MAX_RESUME_ATTEMPTS=3` 熔断 | 三种语义挤一张表；条目字段是快照而非事实流，出问题只能看日志倒推 |
| 4 | **插话/排队** | `runs.js#heldMsgs/steerHold`、`routes-run` 四端点、`conv-notify` unsent 重注入、`shared/pending-supplement` | 运行中消息注入（可撤回/立即生效）、终结时未消费消息重注入 | 语义未分层：steer（进当前 run）与 follow-up（下一轮）未区分；**openai run 运行中收到补充内容会并发起第二个 run**（同会话并发写工作目录/历史）；`steerHold` 是布尔补丁而非能力模型 |

### 1.2 缺口清单（本设计要解决）

- **G1 提交不幂等**：`POST /api/run/start` 无 requestId 概念——前端双击/网络重试可起两个 run。飞书侧去重（`channels/feishu.js#seen`）只在**内存**（TTL 10min），进程重启窗口内重投会重复处理。
- **G2 半途成果不落盘**：openai 路径 `conv-messages` 仅在 run 成功结束时一次性追加（`out.messages.slice(modelMessages.length)`）；中途崩溃则本轮已产生的 assistant/tool 消息全丢，重启只能从零重来（现状决策「不做」的根因）。
- **G3 续跑无状态**：Claude 侧续跑只发提示词「继续」，中断现场（在上哪个工具、哪个审批挂起、哪些消息未消费）不落盘；openai 侧根本没有锚点（刻意不写 active-runs）。
- **G4 busy 语义散装**：steer/follow-up/reject 三种意图各自手工实现（`heldMsgs`、`injectToConv`、`withdraw`、`pending-supplement`、`unsent` 重注入），组合出的边界行为无人能完整推理（如 §1.1 第 4 条的并发 run）。

## 2. 目标与非目标

**目标**

1. **提交幂等**（G1）：所有 run 提交/插话携带 `requestId`，服务端认领去重；飞书按 `messageId` 去重且**跨进程重启持久化**。
2. **任务检查点 + `resume()`**（G2/G3）：openai 路径「模型调用/工具调用每步落盘」，进程重启后从步边界续跑而不是重发用户消息；Claude 路径以 journal 记录运行事实，对账不再依赖对不上的内存镜像。
3. **busy inbox 正式化**（G4）：明确 `steer`（进当前 run）/ `follow-up`（排队下一轮）/ `reject`（撤回）三类语义与路由规则；同会话**永不并发两个 run**。
4. **自愈机器逐步替换**：新建 run 事件流（journal）+ 运行索引（run-index），先影子双写、再切换对账读取，逐步退役 `active-runs.json`；`pending-resume.json` 收敛为「排程器」一个职责。

**非目标（本期不做）**

- 不做通用 workflow / 多 agent 编排；不改看门狗阈值（15min/2h/6h）与审批语义；
- 不做容器沙箱与 Bash 双后端（T6）；不做 benchmark（T5）；不改 `conv-messages` 200 条截断口径（T7）；
- Claude SDK 无「工具执行中途」恢复 API：Claude 侧不承诺从工具调用半程恢复（以 session JSONL 为检查点，prompt trigger 保留，见 §4.3）；
- 不改协议外部形状：前端既有 SSE 事件与 `/api/run/*` 端点语义尽量保持（新增字段为增量）。

## 3. 总体设计

### 3.1 真相来源收敛

```
现在                                    目标
─────────────────────────────          ─────────────────────────────
run 内容：Claude SDK JSONL（不动）       run 内容：Claude SDK JSONL（不动）
          openai: 结束时一次性写          openai: 每步落盘（检查点）
run 状态：内存 run + active-runs 双写    run 状态：内存 run（SSE 热路径）
          + pending-resume 快照                    + run-journal（事实流）
                                                   + run-index（可查询索引）
提交：    无                             submissions（requestId → ref，持久去重）
排队：    heldMsgs / injectToConv /       conv inbox（steer / follow-up / reject）
          unsent 重注入 / supplement
```

统一原则：**热路径（SSE/看门狗）继续用内存 run；一切跨重启可见的事实只写 journal/index/submissions 三处，不再新增第四种载体。**

### 3.2 Run 状态机（正式化）

对外契约不变（`run.status` 仍是 `running|done|error` + `subtype`），状态机以 journal 事件序列 + index 字段表达：

```
submitted ──► running ──┬──► settled/ok        (done)
                        ├──► settled/error     (error: SDK 抛错 / is_error)
                        ├──► settled/stopped   (用户停止)
                        ├──► settled/quota     (quota_blocked，等待重置后由 pending 排程续跑)
                        └──► settled/retry     (exception_retry，2s 后自动重试)
   进程死亡 ──► interrupted（对账归类，非广播终态）
                    ├──► resumed（生成新 run，attempts+1）
                    └──► abandoned（无锚点 / 熔断）
```

- 转移合法性由纯函数层校验（`run-journal.logic.js` 的 `nextAllowed`），非法转移只记日志不抛（防御历史脏数据）；
- 对账归类 `classifyInterrupted(indexEntry, journalTail)`：`resume | abandon | discard` + 理由。判定输入只有 journal 事实（最后一步是模型调用还是工具结果、有无 session 锚点、attempts 是否超限），不再看内存残留。
- 熔断语义不变：`MAX_RESUME_ATTEMPTS=3`、`shouldAbandonResume` 原样保留（衔接测试证明行为兼容）。

### 3.3 三件新基建

| 模块 | 文件 | 职责 |
|---|---|---|
| `store/submissions.js` | `submissions.json` | requestId 认领表：`claim(key)` / `bind(key, ref)` / GC；TTL 可配（run 提交 24h、飞书消息 10min） |
| `store/run-journal.js` | `run-journal.jsonl` | 追加式 run 事件流（单行近似原子，压缩走 `jsonl.js`，保留 3 天 / 5000 行）；`append(event)` / `readRun(runId)` / `tail()` |
| `store/run-index.js` | `run-index.json` | 运行中 run 的可查询索引（取代 active-runs 的角色），含 provider/requestId/lastSeq/resumeAttempt/pid/startedAt 等锚点；`upsert/patch/remove/partition` |

写路径纪律：**`runs.js` 保持纯内存**，事件经注册的 journal sink 落盘（沿用 `registerRunSettleListener` 的既有范式，测试可注入 fake sink，不污染真实数据目录）；journal/index 的写失败**吞掉**（绝不因落盘失败影响 run 收尾与 SSE，先例见 `emitSettled`）。

## 4. 模块设计

### 4.1 提交幂等（P1）

**语义**：requestId 是提交方生成的稳定标识，同一 requestId 的重复提交**至多做一次副作用**。

| 提交口 | key 命名空间 | requestId 来源 | 重复时行为 |
|---|---|---|---|
| `POST /api/run/start` | `start:<requestId>` | 前端 `send()/steer()` 生成（`crypto.randomUUID`），程序化发送在 `launchRun` 兜底生成 | 返回既有 `{ runId, duplicate:true }`（前端照常 attach——run 已完成则收 done 重放，天然幂等） |
| `POST /api/run/send` | `steer:<requestId>` | 同上 | 命中已绑定认领 → 回放既有 `{ ok:true, msgId, duplicate:true }`；命中未绑定 → `{ ok:false }`，前端降级新一轮（消息不丢） |
| 飞书渠道 | `feishu:msg:<messageId>` | 渠道报文 | 静默忽略（与现 `seen` 行为一致，只是持久化） |

**认领流程（避免并发双跑）**：`claim(key)` 在文件锁内「查无 → 写入 `{claimAt, ref:null}` → 返回 `{duplicate:false}`」；创建 run（或 hold 消息）后同步 `bind(key, ref)`。重复命中且已 bind → 走上述响应；重复命中未 bind：
- 认领年龄 < 60s（极小崩溃窗口：claim 与 bind 之间只有同步代码，只有进程恰在此间死亡才会残留）→ 按重复处理，返回 `duplicate:true, runId:null` + 提示文案，前端走既有错误路径提示重新发送；
- 年龄 ≥ 60s → 视作死认领，`claim` 复占（`claimAt` 翻新），崩溃后迟到的重投能自愈。

**兼容**：requestId 缺失 = 无幂等（老前端/老调用行为完全不变）；客户端不得用同一 requestId 提交不同内容（以首次为准，同 HTTP 幂等惯例）。

**飞书接法**：`channels/feishu.js` 的 `seenBefore(messageId)` 改为 `submissions.claim('feishu:msg:'+messageId, { ttlMs: 10min })`，内存 Map 退役。去重仍发生在渠道层（先于 dispatch），覆盖所有飞书流程（含不经 run 注册表的 `claude-exec`）。

### 4.2 Run 事件流与索引（P2）

**事件 schema（v1，行 = `{ v:1, seq, runId, convId, at, type, data }`）**：

| type | 触发点 | data 要点 |
|---|---|---|
| `submitted` | `createRun` 后（入口挂上下文时） | provider, requestId, cwd, model, effort, mode, session, source |
| `started` | provider `run()` 调用后 | pid |
| `session` | `onInit`（Claude） | sessionId |
| `step` | openai 每步（P3）；Claude 不记内容步 | kind: model\|tool, name, toolCallId, status, ms |
| `ask` / `decision` | `askUser` / `resolveDecision` | reqId, kind, title / choice |
| `steer` / `steer_consumed` / `steer_withdrawn` / `steer_unsent` | `holdMsg` / `flushHeldMsgs` / `withdrawHeldMsg` / `unsentField` | msgId, text（截断 2000 字符） |
| `follow_up` / `follow_up_cancelled` / `follow_up_started` | P4 inbox | id, text, source |
| `result` / `settled` | `runResult` / 五个终结口 | subtype, isError, tokens / status, attempts |
| `resumed` / `abandoned` | `doResume` / 熔断 | fromRunId, attempt, reason |

**索引字段**：`{ runId, convId, provider, session_id, cwd, model, effort, mode, credId, requestId, prompt(截断), resumeAttempt, pid, startedAt, updatedAt, status:'running'|'settled', subtype, lastSeq }`。

**双写过渡**：P2 起 `run-claude.js` 在现有 `addActiveRun/patchActiveRun/removeActiveRun` 旁同步写 run-index（shadow）；P5 切换读取后停写 active-runs。`partitionActiveRuns` 的 pid/bootTime 多实例守卫逻辑**原样迁移**到 `run-index.partition`（含测试用例）。

### 4.3 检查点与 resume（P3：openai 试点）

**openai 的检查点 = `conv-messages` 本身**，把「结束时一次性写」改为「每步批量写」：

- `agent-loop.js` 新增 `hooks.onMessages(batch)`：在 `convo.push(...done.responseMessages)` 后与每条 tool-result 入列后调用（batch = 本次新增消息数组）。`run-openai.js` 实现 `onMessages → appendMessages(convId, batch)` 并维护已持久化游标；结束时的兜底 append 只写游标之后的余量。
- **悬空修复**（新纯函数 `run-openai.logic.js#repairDanglingToolCalls(messages)`）：崩溃可能停在「assistant 带 tool-call、结果未落盘」处。恢复/新起 run 前扫描消息尾部：对缺结果的每个 `toolCallId` 追加一条合成 tool-result（「进程中断，该工具未执行」）。保证下一轮请求的消息序列合法（AI SDK 要求 tool-call/tool-result 配对）。
- **`resume()` 流程**：启动对账发现 `provider='openai-compat'` 的 interrupted run → 若 journal 显示至少已过 `started` 且有 convId → 新 run、载入 `conv-messages`、修复悬空、重建 system 提示词（工作目录同上，repo map 用索引里保存的原始 prompt 查）→ 历史末尾是 tool 结果则模型自然继续（**不追加任何「继续」提示词**）；历史为空或凭证已删 → 放弃并记 `abandoned`。
- 计数：openai 续跑同样走 `resumeAttempt`（index）＋ 熔断，与 Claude 共规则不共存储。
- **配额**：openai 自定义凭证无 Claude 式额度池语义，本期不做额度等待（非目标）。

**Claude 侧**：SDK session JSONL 即检查点（现状成立，不动）。journal 补上运行事实（session/ask/steer/result/settled），P5 对账改用 journal+index 判定孤儿，续跑 trigger 保留 resume(session)+「继续」；「继续」前的上下文提示（如「上次中断于工具 X」）留作 P5 可选增强，不阻塞。

### 4.4 busy inbox（P4）

**能力模型**：`run.steerHold` 布尔 → `run.capabilities = { steer: boolean, followUp: boolean }`（Claude：`steer:true`；openai：`steer:false, followUp:true`，步边界 steer 见 §6 决策）。

**语义与路由**（同 conv 有 running run 时）：

| 意图 | 语义 | 路由 |
|---|---|---|
| `steer` | 进当前 run（本轮 result 时 flush；`msg/now` = 立即 flush + interrupt） | 仅当 `capabilities.steer`；否则降级为 `follow-up` |
| `follow-up` | 排队，当前 run 终结后作为**下一轮**起新 run（不并发） | 全部 provider |
| `reject` | 撤回尚未消费的 steer / 取消排队的 follow-up | —— |

**落点**：
- `runs.js` 增加 conv 级 inbox（内存 + journal 事件；队列项含上下文快照 `{ text, source, cwd, session, model, effort, mode, provider, credId }`，取自入队时运行中的 run）；
- `conv-notify.injectToConv`：`findRunningRunByConv` 命中时**一律进 inbox**（steer 或 follow-up 由能力路由），删掉「直接起并发 run」分支；
- `routes-run` 的 `/send`、`/msg/withdraw`、`/msg/now` 内部改走 inbox，API 形状只增字段（`mode:'steer'|'follow_up'`），前端排队气泡/撤回按钮复用现有 UI；
- 排空：web 入口注册 settle 监听（新 `conv-inbox.js`），run 终结且该 conv 有 follow-up → 起下一轮（快照上下文），并记 `follow_up_started`；
- `pending-supplement`（等用户下一句话的会话态）**不替代**：它是交互等待源，命中后经 `injectToConv` 入 inbox，语义自然衔接。

### 4.5 对账替换（P5）

- `recoverPendingAndOrphans` 的孤儿部分改为 `reconcileRuns()`：读 run-index（partition 保留多实例守卫）→ 对每条 orphan 读 journal tail → `classifyInterrupted` → `resume`（Claude：写 pending 排程 / openai：直接排程 checkpoint resume）或 `abandon`（无 session 锚点、熔断）。
- `pending-resume.json` 保留为**排程器**（waiting/resuming/abandoned 与定时器语义不变），但其孤儿条目改由 reconcile 写入；额度/异常重试路径不动。
- `active-runs.js` 在 P5 停写、测试迁至 run-index 后退役；`server.js#listen` 回调的调用名保持 `recoverPendingAndOrphans`（内部换实现），减少接线 churn。

## 5. 分阶段实施（每阶段独立可发布）

| 阶段 | 内容 | 主要文件 | 测试/验收 | 风险 |
|---|---|---|---|---|
| **P1** 提交幂等 | submissions store + 双提交口 + 前端 requestId + 飞书去重持久化 | `store/submissions.js`(新)、`routes-run.js`、`channels/feishu.js`、`public/js/chat.js` | store 单测（TTL/复占/并发不双发）；routes 用例「同 requestId 两次 start 只建一 run」；渠道去重用例；前端手动双击验证 | 低 |
| **P2** journal+index 影子 | sink 注册、事件写点、index 双写 | `store/run-journal.js`、`store/run-index.js`、`runs.js`（sink 调用）、`run-claude.js` | 注入 fake sink 断言事件序列；fs 测试（追加/压缩/坏行）；index=pending/index 双写一致性 | 低（只写不读） |
| **P3** openai 检查点试点 | onMessages 步进落盘、悬空修复、resume 流程 | `providers/agent-loop.js`、`entrypoints/web/run-openai.js`、新 `run-openai.logic.js`、`run-index` 登记 | 纯函数用例（多形态悬空/合法序列）；agent-loop 钩子用例；fs 级 resume 集成；kill 进程 e2e | 中 |
| **P4** busy inbox | 能力模型、inbox 队列、conv-notify/routes 改走 inbox、排空监听 | `runs.js`、`routes-run.js`、`conv-notify.js`、新 `entrypoints/web/conv-inbox.js`、`chat.js` 适配 `mode` | inbox 语义单测（路由/顺序/撤回/排空/无并发）；conv-notify 增例（openai 运行中 → 排队）；steer-bubble e2e 回归 | 中 |
| **P5** 对账切换 | reconcile 读 journal+index；停写 active-runs；pending 收敛为排程器 | `run-claude.js`、新 `run-reconcile.logic.js`、`store/run-index.js` | 分类纯函数表驱动；启动对账 fs 集成；孤儿恢复回归（单次续跑仍工作、熔断仍生效）；多实例 partition 用例 | 中高（事故史区，全量回归门） |

依赖：P1 独立；P2 → P3；P4 独立（但受益于 P2 的事件记录）；P5 依赖 P2/P3。

## 6. 拍板记录（2026-10-08 已确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 本次会话交付范围 | spec + **P1 落地**（提交幂等）；P2~P5 按 §5 顺序推进，各自拍板点届时另行确认 |
| 2 | 幂等重复提交的响应 | 返回既有 `runId` + `duplicate:true`，前端无感照常 attach（run 已完成则收 done 重放）；未 bind 的死认领返回 `duplicate:true, runId:null` + 提示文案，前端走既有错误路径 |
| 3 | openai 检查点恢复粒度 | 步边界恢复 + 悬空 tool-call 用合成「未执行」结果修复（P3 实施） |
| 4 | openai 的 steer | 本期不做；P4 先落 follow-up 排队（闭合并发隐患），步边界 steer 留作后续增强 |

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| journal 写放大/损坏 | JSONL 单行追加（≤4KB 近似原子，先例 event-log）；压缩走 `jsonl.js`（加锁、坏行跳过）；写失败吞掉 |
| `runs.js` 加 sink 改变「纯内存」身份 | sink 可注入、默认 no-op；测试注入 fake；真实 sink 由 web 入口注册（`registerRunSettleListener` 同范式） |
| openai 步进落盘改变失败语义 | 失败 run 会在 `conv-messages` 留下半程消息 = 检查点本身；用户重发新消息时模型「接着半程继续」而非重头——这是目标语义，验收中用真实场景确认无违和 |
| 幂等误拦截 | 无 requestId = 行为与现状完全一致；同 key 不同内容以首次为准（HTTP 幂等惯例） |
| 多实例（PM2 + 桌面版共用 APP_DATA_DIR） | submissions 走文件锁；run-index 沿用 pid/bootTime partition 守卫；journal 仅追加不删改 |
| P5 切换引发生死循环事故重演 | 熔断与 partition 逻辑**原样迁移**并有专项用例；切换前 active-runs 始终双写，回滚只需回滚代码 |

## 8. 测试策略汇总

- 纯函数（`*.logic.js` + 单测）：`submissions` 判定、`run-journal.logic` 转移校验、`classifyInterrupted` 表驱动、`repairDanglingToolCalls`（用 ai@7 真实消息形状）、inbox 路由。
- store（临时 `APP_DATA_DIR` + 动态 import，仓内惯例）：submissions claim/bind/复占/TTL；journal 追加/读取/压缩/坏行；run-index partition（从 active-runs.test.js 迁移扩写）。
- 集成：routes 重复提交；conv-notify 运行中注入路由；启动对账（写 index+journal → reconcile → 断言动作/排程）。
- e2e 门禁：`panels-smoke` + `steer-bubble` 回归；P3 增 kill 进程恢复用例（真实 web 进程 + 假 openai 端点；若成本过高降级为 fs 级集成 + 手工验收，拍板时确认）。
- 全量 `npm test`（基线 3531）+ 相关 e2e 每阶段全绿后才进下一阶段。

## 9. 验收清单（全部阶段完成后）

- [ ] 同一 web 消息重复提交（双击/重放）→ 只有一个 run、一条回复；
- [ ] 飞书重投相同 messageId（含进程重启后）→ 只处理一次；
- [ ] openai 长任务中途 kill 进程 → 重启自动从步边界继续，不重发用户消息、不重跑已完成步骤；
- [ ] 同 conv 运行中从飞书发补充内容（openai run）→ 排队（follow-up），不再并发；
- [ ] 运行中 steer → 可撤回/立即生效/result 时进入任务（Claude 行为与现状一致）；
- [ ] Claude 路径 kill 进程 → 单次自动续跑仍工作；连续中断 3 次 → abandoned 熔断提示（事故回归门）；
- [ ] 全部既有测试 + 四道 e2e 门禁全绿。

## 10. 实施状态

- [x] P1 提交幂等（2026-10-08：submissions store + 双提交口 + 前端 requestId + 飞书去重持久化）
- [x] P2 journal/index 影子（2026-10-08：`store/run-journal.js` 事件流 + `store/run-index.js` 索引与 partition 迁移 + `store/runs.js` sink 发射 + `entrypoints/web/run-durability.js` 双写接线；只写不读）
- [x] P3 openai 检查点试点（2026-10-08：`agent-loop` `onMessages` 步进落盘 + 悬空修复 `run-openai.logic.js` + run-index 登记/对账 `recoverOpenAiOrphans` + `resumeOpenAiRun` 不追加「继续」；**顺带修复 ai@7 存量 bug**——system 须走 `instructions`，此前真实 openai 调用必失败；新增 `tests/e2e-openai-resume.mjs`）
- [x] P4 busy inbox（2026-10-08：`runs.js` conv 级 follow-up 队列 + `capabilities:{steer,followUp}` 能力模型（替代 steerHold）+ `conv-inbox.js` 排空监听（终结即起下一轮、并发守卫）+ `/api/run/start` 同会话并发闸 + `/api/run/send|msg/withdraw|msg/now` inbox 路由 + `/api/run/pending.followUps` 前端发现并接流；新增 `tests/e2e-follow-up-queue.mjs` 常驻门禁）
- [x] P5 对账切换（2026-10-08：`run-reconcile.logic.js#classifyInterrupted` 统一归类（resume/abandon/discard，输入＝index 锚点 + journal 事实）；`run-claude.js#reconcileRuns` 读 run-index 对账——Claude→pending 排程、openai→检查点续跑排程、熔断/无锚点→abandoned、settled 残留→摘除；`run-durability` 停写 active-runs、改单写 run-index（写失败仍吞）；`run-index#migrateLegacyActiveRuns` 升级首启并入旧表并清空；**active-runs 模块退役删除**，消费方（cleanup / status-report / memory-bank）切 run-index；`pending-resume` 收敛为纯排程器）

> 自动化证据（2026-10-08）：`npm test` **3628 全绿**、e2e **12/12**；kill 真进程与飞书真重投两项目录为手工验收，见 §9 验收清单。

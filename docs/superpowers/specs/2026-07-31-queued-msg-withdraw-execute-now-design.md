# 排队消息「撤回 / 立即生效」设计

日期：2026-07-31
状态：已批准（设计评审通过，待实施）
范围：web 执行台聊天页（public/js + src/entrypoints/web + src/integrations/claude.js）

## 背景与问题

聊天页在会话运行中支持继续发消息（插话 steering）：`steer()` → `POST /api/run/send` → SDK 流式输入队列。经核实（SDK 0.3.210 `streamInput` 急切消费），消息会被**立即透传进 CLI 进程内部队列**，在当前任务轮次结束后才被消费——即用户观察到的「等下一个 task 才带进去」。

问题：消息一旦推给 SDK 就进入 CLI 内部，我们失去控制权——无法撤回，也无法让它提前生效。

## 目标

消息尚未进入任务时，用户可以：

1. **撤回**：把排队消息作废（气泡移除）；
2. **立即生效**：打断当前任务轮次，排队消息立刻开始处理；
3. **可视区分**：排队中的消息气泡与普通消息有样式差异，进入任务后恢复正常。

## 已确认的行为决策

| 决策点 | 结论 |
|---|---|
| 立即生效的打断方式 | SDK `interrupt()` 轮内打断：当前轮中止、run 存活、排队消息作为下一轮马上执行（不杀进程、上下文无缝保留） |
| 多条排队消息点「立即生效」 | 全部按原顺序一起生效 |
| 手动「停止」时的排队消息 | 作废，气泡标记「未发送」（内容可复制手动重发），不自动重发 |

## 方案：服务端持有缓冲层

核心思路：插话消息不再直接推给 SDK，先存在服务端 `run.heldMsgs[]`。**flush 进 SDK 的时机 = 当前轮 result 到达时**，与今天 CLI 内部排队的实际生效时机完全一致——行为时序不变，但队列从「CLI 内部（不可控）」移到「我们服务端（可控）」。

否决的备选：纯前端持有（不改服务端）。硬伤：关页面排队消息丢失；消息要等整个 run 结束才生效（比现状更晚），属行为回退。

### 1. 服务端：持有缓冲

**`src/store/runs.js`**
- run 对象新增 `heldMsgs: [{ id, text }]`（内存态，随 run 生命周期，不落盘）。

**`src/entrypoints/web/routes-run.js` — `/api/run/send`**
- Claude 运行：追加到 `run.heldMsgs`，返回 `{ ok: true, msgId }`；经 SSE 广播 `queue` 事件（携带当前排队 id 列表）。
- openai-compat 运行：保持现状（无 `_input`，返回 `ok:false`，前端照旧降级 `restartAsNewRun`）。
- 附带简化（DRY）：判档窗口的 `preInput` 预启动缓冲机制被 heldMsgs 天然覆盖，移除 `handleRunStart` 中的 `run._input = { push: preInput... }` hack 及 `startClaudeRun` 的 `preInput` 参数。

**`src/entrypoints/web/run-claude.js` — flush 时机**
- `onResult` 回调内、`inputQueue.autoClose()` 之前**同步** flush：heldMsgs 按序 `run._input.push()`。输入流非空 → autoClose 不关流 → 同一 run 续到下一轮。
- flush 后广播 SSE `consumed` 事件（携带已消费 msgId 列表）。
- 例外：额度用尽（lastRate.status === 'rejected'）时不 flush；heldMsgs 文本并入待续跑条目的 prompt（替代固定的「继续」），排队消息随续跑自动带入。

**`src/integrations/claude.js` — 暴露 interrupt**
- `onInputHandle` 回调句柄从 `{ push, close }` 扩展为 `{ push, close, interrupt: () => q.interrupt() }`。

### 2. 服务端：新端点

**`POST /api/run/msg/withdraw`** `{ runId, msgId }`
- heldMsgs 中存在 → 移除，广播 `queue` 事件，返回 `{ ok: true }`。
- 已被 flush（不存在）→ `{ ok: false }`，前端 toast「已进入任务，无法撤回」并清除排队样式。

**`POST /api/run/msg/now`** `{ runId }`
- 按序 flush 全部 heldMsgs → 广播 `consumed` → 调 `run._input.interrupt()`。
- 当前轮被打断并定稿，排队消息立刻作为下一轮开跑；run 与会话上下文保留。
- run 不存在/已结束 → `{ ok: false }`。

**停止路径（abort）**
- 清空 heldMsgs；`done` 事件携带未消费 msgId 列表 `unsent: [msgId]`，前端据此标记「未发送」。

### 3. 前端：气泡状态机

**conv-store 消息字段（用户消息新增三态）**
- 排队中：`{ queued: true, msgId, runId }`
- 已进入任务：清除上述标记（恢复普通消息）
- 未发送：`{ unsent: true }`（queued 标记同时清除）

**`steer()` 改动（chat.js）**
- 发送后**不再立即定稿助手气泡**——消息尚未进任务，助手气泡继续在排队消息上方流式输出（与 CLI 排队行为一致）。
- 用户气泡以排队样式渲染，`/api/run/send` 返回后回填 `msgId`。

**`consumed` 事件处理（原 steer 内的切段逻辑移到这里）**
- 定稿当前助手气泡（`textBase` 切段机制复用）；
- 清除对应用户消息的排队标记与样式；
- 追加新助手占位气泡（append-only，「存储索引 = DOM 索引」不变量维持）；
- 空段特例（当前段无文本）沿用现有「占位气泡挪到末尾」逻辑。

**刷新 / 重连对账**
- SSE `replay` 快照新增 `held: [msgId]`；
- 前端对照 conv-store 中带 `queued` 标记的消息：在列表中 → 保留排队 UI；不在 → 清除标记（已消费）；
- 重连发现 run 不存在 → 该 run 的 queued 消息标记「未发送」兜底。

### 4. UI：样式与按钮

**排队中气泡**
- 虚线边框 + 透明度略降 + 气泡下方小字「等待进入任务」；
- 气泡左侧（现有复制按钮旁，`bubble-row` 内）两个图标按钮：**↩ 撤回**、**⚡ 立即生效**，悬停显示文字提示；
- 按钮交互：撤回成功 → 移除气泡（DOM + conv-store 同步删除，注意索引不变量：删除须重建气泡缓存或仅对末尾消息直删）；立即生效 → 调 `/api/run/msg/now`，后续由 `consumed` 事件驱动状态翻转。

**未发送气泡**
- 灰色调 + 「未发送」标注；无操作按钮；内容可复制。

**进入任务后**
- 恢复普通用户气泡样式，按钮消失。

## 边界与风险

- **撤回与 flush 竞态**：Node 单线程同步判断，窗口极小；撤回失败如实返回 `ok:false`，前端提示。
- **interrupt 后的 result**：打断轮的 result 正常触发 flush 路径，此时 heldMsgs 已空，无重复发送。
- **进程重启**：heldMsgs 内存态随进程丢失；孤儿恢复仅续 session。前端重连对账发现 run 不存在 → queued 消息标「未发送」。不做落盘持久化（YAGNI：插话消息存活窗口通常几十秒）。
- **撤回后删除气泡的索引不变量**：conv-store 消息数组与 DOM/_bubbleMap 按索引对齐，中间删除需同步收缩两侧——实施时在 conv-store 提供 `convRemoveMessage(convId, index)` 并同步 DOM 移除 + 气泡缓存重建（与 `moveMessageToEnd` 同级的存储/DOM 双侧原子操作）。
- **openai-compat**：不支持排队按钮（消息走现有降级路径，气泡不显示排队态）。

## 测试要点

- `createInputQueue` 行为不变（现有单测继续通过）；
- 新增：held → result flush → 同 run 下一轮（模拟 onResult 顺序）；
- 撤回：held 中移除 / 已 flush 返回 false；
- msg/now：flush + interrupt 调用顺序；
- 额度 rejected 路径：不 flush、prompt 并入待续跑；
- 前端手工走查：排队样式、撤回、立即生效、停止标记未发送、刷新对账。

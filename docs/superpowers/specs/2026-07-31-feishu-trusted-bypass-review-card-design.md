# 设计：可信提交人直通 + 评审否定挽回（按钮卡片）

- 日期：2026-07-31
- 分支：feat/unattended-mode（不做 git 提交，提交时机由用户掌控）
- 状态：设计已由用户确认

## 背景与问题

中度/完全托管下，需求/故障立案后要过 AI 评审门（`runReviewFlow`）。两个实际问题：

1. **本人提交被评审拒绝**。老板本人（以 guest 身份走 feedback 流程；owner 文本会被 claude-exec 全接，到不了 feedback）提交「提个需求，现在可以开始对本期需求进行全面埋点了」，被评审 `reject` 结案。本人的提交不应做合理性判断，应直接处理。
2. **「坚持修改」失效（bug）**。挽回入口 `pendingChallenged`（`feedback/index.js`）只查 `status==='challenged'`（`ask` 判决）；`reject` 判决任务直接进 `rejected` 终态，用户回「坚持修改」找不到可应答任务，消息落到意图分类归为 other，回了「没有识别到你的意图」兜底文案。

## 决策记录（用户已确认）

| 决策点 | 结论 |
|---|---|
| 本人身份配置 | 新增环境变量 `TRUSTED_OPEN_IDS`（逗号分隔），与 `OWNER_OPEN_IDS` 同模式 |
| 直通程度 | 一律直接自动开发：跳过评审门与方案生成，直接 `requestAutoDevelop`，不分托管等级 |
| 按钮卡片场景 | `ask`（质疑）与 `reject`（拒绝）都发「坚持修改 / 算了」按钮卡片 |
| 挽回生效范围 | 所有提交人（30 分钟窗口内），人工覆盖记入判例库 |
| 卡片回调架构 | 方案 B：按钮 value 携带 taskId，全局按 kind 路由（无内存态，重启后按钮仍有效） |

## 设计

### 1. 可信提交人直通

- `src/shared/config.js`：`config.lark` 增加 `trustedOpenIds`，解析 `process.env.TRUSTED_OPEN_IDS`（逗号分隔、trim、filter），与 `ownerOpenIds` 写法一致。
- `src/plugins/team-tools/feedback/index.js` handle B 段：立案（含材料吸附）之后、托管等级分流之前，判断 `config.lark.trustedOpenIds.includes(task.source.openId)`：
  - 命中 → `requestAutoDevelop(task.id, '可信提交人直通，自动开发')`，回复
    `✅ 已直接进入自动开发（独立分支，完成后通知你确认合并）`，返回（不走 light 分析分支、不走 runReviewFlow）。
  - 未命中 → 现有流程不变。
- 前置事实（已核实）：自动开发泵在 web 进程无条件常驻（`server.js` startAutoDevPump）；`requestAutoDevelop` 无托管等级/状态门槛；`develop()` 容忍无 analysis（`'(无)'`）。管线零改动。
- 即时应答（ackBug/ackFeature）、材料吸附、systemNotify 照旧执行。

### 2. 挽回窗口扩展（bug 修复）

- `pendingChallenged` 查询条件扩展（更名 `pendingReviewable`，语义对齐）：30 分钟窗口 + 同 openId + 同 chatId 内，满足其一：
  - `status === 'challenged'`（现状，ask 判决等待应答）；
  - `status === 'rejected'` 且 `['reject','ask'].includes(review?.verdict)`（评审拒绝的任务，以及「算了」放弃后反悔的任务）。
  - owner 在 triage 手动放弃的任务：若无评审否定判决则不匹配，不受影响。
- 命中「坚持修改」（YES_RE）→ `recordOverride`（判例库校准后续评审）→ `proceedAfterReview({ overridden: true })`；命中「算了」（NO_RE）→ 对 challenged 置 rejected（现状）；对已 rejected 的任务回「已经取消过了」类幂等提示。
- 查询逻辑抽纯函数 `findReviewableTask(tasks, { openId, chatId, now })` 入 `feedback/logic.js`（新文件），配单测。
- reject 判决的纯文本降级文案补一句：`如仍需处理请回复「坚持修改」`（现状 reject 文案无任何挽回指引）。

### 3. 评审否定按钮卡片

- 触发：`runReviewFlow` 中 `ask` / `reject` 判决，且 `ctx.source === 'feishu'` 时改发交互卡片；其他渠道（web/console）维持纯文本。
- 卡片结构（构造函数 `buildVerdictCard(task, verdict, reason)` 入 `feedback/logic.js`）：
  - 正文：评审结论 + 理由（lark_md）；群聊来源时首行加 `<at id=提交人openId></at>`。
  - 按钮：「✋ 坚持修改」（primary）+「🗑 算了」（danger），value 均为
    `{ kind: 'review-verdict', taskId, action: 'insist' | 'giveup' }`。
- 回调路由（方案 B，无内存态）：
  - kind 注册表放独立小模块 `src/shared/card-actions.js`（`registerCardKindHandler`/`getCardKindHandler`）：feedback 插件与 feishu 入口都要用，放入口会形成 entrypoint→features→plugins→entrypoint 循环依赖，且 web 进程 import 入口会误触发 `channel.start` 等模块级副作用。
  - `src/entrypoints/feishu/index.js` 的 `onCardAction`：先查现有 messageId Map（保留兼容，不删既有机制），未命中则按 `data.action.value.kind` 路由到注册表处理器。
  - feedback 注册 `review-verdict` 处理器：按 `taskId` 读盘取任务 →
    - 权限：`operator.open_id` ∈ {task.source.openId} ∪ trustedOpenIds ∪ ownerOpenIds，否则忽略 + 记日志（不发文本，避免群噪音）。
    - 幂等：任务已不在可挽回态（challenged / rejected+评审否定）→ `updateCard` 为当前状态提示（如「该任务已在处理中」），不重复处理。
    - `insist` → recordOverride + proceedAfterReview(overridden) → `updateCard` 终态（✅ 已转入处理）。
    - `giveup` → 任务置 rejected（challenged 场景）/ 保持 rejected → `updateCard` 终态（❌ 已取消）。
    - 更新卡片所需 `message_id` 从回调数据自取（`callbackData.message_id`）。
  - 卡片处理器内的回复走 `sendText(task.source.chatId, …)`（feedback 所在 team-tools 层已有直接 import lark 的先例，如 auto-dev）。
- `integrations/lark.js` 的 `sendCard` 补返回 `message_id`（修正现有 API 缺口：示例代码假设有返回值，实际为 undefined）。
- 插件停用一致性：kind 处理器由 feedback feature 模块加载时注册；team-tools 停用时 feedback 不加载，回调自然落空（仅日志）。

### 4. 降级与兜底

- 发卡片抛错 → 降级发现有纯文本文案（ask/reject 各自的原文案 + 挽回指引），链路不中断。
- 文本「坚持修改 / 算了」兜底完整保留（hasPending → pendingReviewable）：覆盖机器人重启前发出的旧卡片、卡片渠道异常、用户不点按钮直接打字三种情况。卡片与文本两条路都收敛到同一处理逻辑（recordOverride + proceedAfterReview / 置 rejected），不双写。

### 5. 测试

沿用项目「纯逻辑抽 logic.js + 单测」模式，新增 `feedback/logic.test.js`：

- `findReviewableTask`：challenged 命中；rejected+reject 命中；rejected+ask（算了反悔）命中；rejected 无评审判决不命中；超窗/跨会话/跨用户不命中。
- `buildVerdictCard`：按钮 value 结构（kind/taskId/action）；群聊 at 标签；ask/reject 文案差异。
- 卡片回调 value 解析 + 权限判定纯函数（提交人/白名单/owner 允许，他人拒绝）。
- config 解析：`TRUSTED_OPEN_IDS` 空值/空格/逗号分隔。

## 不做的事（YAGNI）

- 不动意图分类四层短路、claude-exec 对 owner 的接管、task-triage 流程、评审门对普通 guest 的判决语义。
- 不做 web 管理台「可信提交人」配置 UI（env 足够，需要时再加）。
- 不删既有 messageId 回调 Map 与示例插件（保留兼容，非本次范围）。
- 不给直通路径加二次确认（误触可在 web 管理台停任务；合并本就需管理员确认）。

## 已知代价（用户已知悉）

- 直通后，带「提交需求/故障」前缀的消息都会真实触发一次自动开发（Claude 额度 + 任务分支）。
- 需将本人 open_id 配入 `TRUSTED_OPEN_IDS`（可从日志获取）。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/shared/config.js` | `config.lark.trustedOpenIds` |
| `src/plugins/team-tools/feedback/index.js` | 直通分流；pendingReviewable；ask/reject 发卡片；kind 处理器注册 |
| `src/plugins/team-tools/feedback/logic.js`（新） | findReviewableTask / buildVerdictCard / 回调解析与权限纯函数 |
| `src/plugins/team-tools/feedback/logic.test.js`（新） | 上述纯函数单测 |
| `src/shared/card-actions.js`（新） | 卡片回调 kind 注册表（避免插件↔入口循环依赖） |
| `src/entrypoints/feishu/index.js` | onCardAction kind 路由（消费注册表） |
| `src/integrations/lark.js` | `sendCard` 返回 `message_id` |
| `.env.example` | 补 `TRUSTED_OPEN_IDS` 说明 |

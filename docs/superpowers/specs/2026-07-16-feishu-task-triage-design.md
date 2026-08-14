# 设计：飞书交互式待处理项处理流程（task-triage）

> 日期：2026-07-16
> 状态：设计已评审通过，待转实现计划
> 关联架构：`docs/ARCHITECTURE.md`（§5 功能模块契约、§6 任务状态机、§10 关键约定）

---

## 1. 背景与目标

现状：guest（其他人）通过飞书提交需求/故障，`feedback` feature 记为 Task 并**自动只读分析**，产出方案后置为 `analyzed`。要「开始开发 / 修正 / 放弃」目前只能在 **web 管理台**（`/api/tasks/action`）操作。

目标：让 **owner 本人**在飞书里，用一段**交互式对话**批量地 triage（分诊）这些待处理项：

1. owner 说「看一下有哪些待处理的」→ bot 回**分组后的待处理标题列表**，并询问是否开始处理；
2. owner 同意 → bot 把**已有方案的**任务**排序后逐个呈现**（含方案摘要）；
3. owner 对每一项回复「开始处理 / 补充 / 放弃 / 跳过 / 退出」；
4. 「开始处理」的任务进入**后台串行队列**执行开发（真实改码），bot **不阻塞**、立即问下一个；
5. 循环直到所有「已有方案」的待处理项都过完，输出本轮汇总。

**仅 owner 本人可触发**，其他人发消息不进入此流程。

---

## 2. 需求决策（已与用户确认）

| 维度 | 决策 |
|---|---|
| 列表展示范围 | 列**所有未完结**任务，**分组标注**「已有方案 / 分析中」 |
| 处理阶段排序 | **故障（bug）优先**，同类按**提交时间**升序 |
| 执行方式 | **决策连续、执行排队**：决策不阻塞；被选中「开始」的任务进后台**串行**队列，一个开发完再跑下一个（避免并发改同一代码库冲突） |
| 触发与指令 | **关键词进入** + 流程中**自然语言**回复（关键词优先识别，未命中用 Claude 兜底，省额度） |
| 数据来源 | 现有 `store/tasks`，不引入新数据源 |
| develop/analyze 复用 | 抽到**共享 task-ops 模块**（见 §4） |

---

## 3. 现状复用（不重造）

- `store/tasks.js`：`getTasks / getTask / updateTask` —— Task 状态机 `new → analyzing → analyzed → developing → done/rejected`。
- `feedback` 的 `analyze()` / `develop()`：只读分析 / 真实改码（本设计将其抽出为共享模块，见 §4）。
- `data-cleanup` 的 **`hasPending` 多步会话范式**：模块级 `state Map` + `dispatch` 优先把消息交给未完成会话 —— 本 feature 照此实现。
- `integrations/lark.sendText(chatId, text)`：飞书主动推送（后台完成通知用）。
- `app/intent.js` 的「关键词优先 → Claude 兜底」模式：本 feature 的流程内意图识别复用同一思路。

---

## 4. 架构与模块

### 4.1 新增 / 修改文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/features/task-triage/index.js` | 新增 | Feature 契约（`match`/`hasPending`/`handle`）+ 会话状态机 + 后台串行队列 |
| `src/features/task-triage/logic.js` | 新增 | **纯函数**：`groupPending` / `sortForTriage` / `parseAction` / `parseYesNo`（无副作用，可单测） |
| `src/features/task-triage/logic.test.js` | 新增 | `node:test` + `node:assert` 单测（零新依赖） |
| `src/features/task-ops.js` | 新增 | **跨 feature 共享领域模块**：从 feedback 抽出 `analyze(task)` / `develop(task)` |
| `src/features/feedback/index.js` | 修改 | `analyze/develop` 定义移至 `task-ops.js`；feedback 直接从其引入并调用，**不再自行定义或 re-export**（唯一定义处 = task-ops），行为不变 |
| `src/features/index.js` | 修改 | 注册 `taskTriage`，**排在 `claudeExec` 之前** |
| `src/entrypoints/web/server.js` | 修改 | `analyze/develop` 的 import 源改为 `task-ops.js`（一行） |
| `src/shared/config.js` | 修改 | 新增 `taskTriage` 段（触发词、可选单人白名单） |

### 4.2 为什么 task-ops 放在 `features/` 而非 `app/`

依赖方向为 `entrypoints → app → features → (integrations/store/shared)`，且 `app/dispatch.js` 已 import `features`（`app → features`）。若把 `task-ops` 放 `app/`，则 `feedback`（feature）需 `import app/task-ops`，形成 **`app ↔ features` 循环依赖**。

因此 `task-ops.js` 置于 `src/features/` 下，作为**共享领域模块**（非注册 feature、无 Feature 契约、不进 `features/index.js`），**只依赖下层** `integrations/store/shared`。`feedback` / `task-triage` / 未来的 `dev-task`·`doc-driven` 均可 import 它；`web/server.js`（entrypoint）import 它也符合方向。这满足 ARCHITECTURE §10「features 之间不互相 import」——协作对象是共享模块，不是另一个 feature。

### 4.3 路由接入（零改动 dispatch）

利用现有 `dispatch` 的两个机制：

```
dispatch 执行顺序（现有，不改）：
  0. hasPending 优先   ← 流程进行中，owner 的任何自然语言都被 task-triage 接管
  1. owner 兜底 match  ← task-triage 排在 claude-exec 之前；仅当「触发词命中」时 match=true
  2. 意图分类 …
```

- **进入流程**：`match(ctx) = 是 owner && 触发词命中`。命中 → 进流程；**未命中 → match 返回 false → 落到 `claude-exec`**，owner 的日常 Claude 指令完全不受影响。
- **流程中**：有会话时 `hasPending(ctx)=true`，dispatch 第 0 步接管 → owner 可用**自然语言**回复，无需每句带触发词。
- **仅 owner 本人**：`match` 内先判 `ctx.user.role === 'owner'`（或 `config.taskTriage.ownerOpenId` 命中）。guest 永不进入。

---

## 5. 会话状态机

### 5.1 会话数据（模块级 `Map: openId → session`）

```js
{
  step: 'listed' | 'reviewing' | 'awaiting_fix_note',
  chatId,               // 后台开发完成后主动推送用
  queue: [taskId, ...], // 排序后的「已有方案」待决策队列（进入 reviewing 时定格快照）
  cursor: 0,            // 当前呈现到第几个
  stats: { started: 0, rejected: 0, skipped: 0, refixed: 0 },
}
```

### 5.2 状态流转

```
[无会话]
  │  owner 发触发词「待处理」(match 命中)
  ▼
[listed]  已发分组列表，问「要开始处理已有方案的 M 项吗？」
  │  回「开始」                    │ 回「取消」→ 结束
  ▼
[reviewing]  按排序逐个呈现，等对「当前项」决策
  │
  ├─ 开始   → updateTask(developing) + 入后台串行队列 → cursor++ → 下一个
  ├─ 放弃   → updateTask(rejected)                    → cursor++ → 下一个
  ├─ 跳过   → 不改状态（仍 analyzed）                  → cursor++ → 下一个
  ├─ 补充<内容> → updateTask(fixNote, analyzing)+后台重新分析 → cursor++ → 下一个
  ├─ 只说「补充」 → [awaiting_fix_note] 追问内容 → 收到后同上 → 回 reviewing
  └─ 退出   → 结束（输出汇总）
  │
  ▼ cursor 走完队列
[结束]  输出本轮汇总 + 后台队列剩余数，清除会话
```

### 5.3 消息样例

进入（owner 发「待处理」）：
```
📋 待处理共 5 项
✅ 已有方案（3）
  1. [故障] 登录页偶发白屏
  2. [故障] 导出 Excel 乱码
  3. [需求] 列表页加筛选器
🕒 分析中（2）
  · [需求] 批量导入
  · [需求] 暗色模式
——— 要开始处理「已有方案」的 3 项吗？（开始 / 取消）
```

逐个呈现（回「开始」后，故障优先+时间排序）：
```
（1/3）[故障] 登录页偶发白屏
💡 方案：定位到 xxx 组件未做空值判断，建议在 …（方案摘要，超长截断）
——— 开始处理 / 补充<说明> / 放弃 / 跳过 / 退出
```

本轮结束：
```
✅ 本轮处理完毕：开始 2 · 放弃 1 · 跳过 0 · 重新分析 0
后台开发队列还有 2 个在排队，完成后我逐个告诉你。
```

### 5.4 两个默认（已确认）

1. **「补充」后**：置为重新分析（后台跑），**不**在本会话内自动拉回该项；重新分析完成后主动推送新方案文本，owner 下次「待处理」会看到它已重新有方案。—— 避免会话与异步分析打架。
2. **不加空闲超时定时器**：会话靠「退出/取消」结束，或下次发「待处理」直接覆盖重置（YAGNI）。

---

## 6. 后台串行队列 + 完成通知 + 意图识别

### 6.1 后台串行执行队列（`task-triage` 模块内，纯内存）

```js
const devQueue = [];       // 待开发 taskId
let devRunning = false;    // 串行闸门：同一时刻只允许一个 develop 改码
let notifyChatId = null;   // 完成后推送目标（= owner 会话 chatId）

function enqueueDevelop(taskId, chatId) {
  devQueue.push(taskId);
  notifyChatId = chatId;
  pumpQueue();             // 决策阶段连续入队，执行处串行消费
}

async function pumpQueue() {
  if (devRunning || !devQueue.length) return;
  devRunning = true;
  const task = getTask(devQueue.shift());
  try {
    await develop(task);                          // 复用 task-ops.develop（内部 developing→done + systemNotify）
    await sendText(notifyChatId, `✅ 已完成：${task.title}\n请 git diff 审查改动`);
  } catch (e) {
    await sendText(notifyChatId, `❌ 开发失败：${task.title}\n${e?.message || e}`).catch(() => {});
  } finally {
    devRunning = false;
    pumpQueue();                                  // 递归取下一个 → 严格串行
  }
}
```

- **串行是刚需**：`develop()` 的 cwd 都是同一个 `config.feedback.frontendDir`，并发会互相踩改动。`devRunning` 闸门 + `finally` 递归保证任意时刻只有一个在改码。
- **完成通知**：走 `sendText` 推到 owner 会话，配合 develop 内已有的 `systemNotify`。

### 6.2 省额度的流程内意图识别（`logic.parseAction` / `logic.parseYesNo`）

```
关键词/正则先判（零额度、即时）：
  开始|处理|好|可以|就这个|ok|1     → start
  放弃|拒绝|不做|算了              → reject
  跳过|下一个|skip                → skip
  补充|修正|重新分析|不对          → fix
  退出|结束|取消|停               → exit
未命中 → Claude(sonnet) 判 {action}，仿 intent.js 的 claudeClassify（只输出一行 JSON）
```

`listed` 步的「是否开始」用 `parseYesNo`（yes/no 关键词优先，未命中 Claude 兜底）。90% 常规回复走关键词、不花额度。

---

## 7. 排序 / 边界 / 配置

### 7.1 排序与分组（`logic.js` 纯函数）

- **未完结** = `status ∈ {new, analyzing, analyzed}`；`developing` 视为「处理中」（列表尾部只读标注，不入决策）；`done/rejected` 不显示。
- **分组**（`groupPending`）：已有方案 = `analyzed` 且 `analysis?.suggestion` 非空；分析中 = `new/analyzing`。
- **决策队列排序**（`sortForTriage`，仅 analyzed）：`type === 'bug'` 优先，同类按 `createdAt` 升序。进入 reviewing 时把 taskId **快照**进 `session.queue` 定格，避免中途列表变化导致乱序。

### 7.2 错误处理与边界

- **已有方案 0 项** → 直接告知「暂无已有方案」，不建会话。
- **呈现每一项前 `re-fetch getTask` 校验**：若已被 web 管理台改成非 `analyzed`（双端并发）→ 自动跳过并提示。
- `develop` 抛错 → `finally` 保证队列续跑；`sendText` 通知用 `.catch()` 兜底，失败不阻断队列。
- **重复发「待处理」** → 覆盖旧会话重置。
- 状态写入统一走 `updateTask()`/`develop()`，triage 不重复写，避免竞态。
- 入口层已有 `seen` 消息去重，无需重复处理。

### 7.3 配置项（`shared/config.js` 新增 `taskTriage` 段）

```js
taskTriage: {
  // 进入触发词正则（env 可覆盖）
  triggerPattern: process.env.TRIAGE_TRIGGER
    ? new RegExp(process.env.TRIAGE_TRIGGER)
    : /待处理|待办|要处理|处理一下/,
  // 可选单人白名单 open_id；空 = 沿用 lark.ownerOpenIds
  ownerOpenId: (process.env.TRIAGE_OWNER_OPEN_ID || '').trim() || null,
},
```

---

## 8. 测试策略

项目**无测试框架**（`package.json` 的 `test` 为占位）。遵循 TDD、先测后写：

- **纯逻辑抽成无副作用函数**：`groupPending` / `sortForTriage` / `parseAction` / `parseYesNo` —— 核心且可确定性测试。
- 用 Node 内置 `node:test` + `node:assert` 写 `logic.test.js`（**零新依赖**），覆盖：
  - 分组：混合状态列表 → 正确分「已有方案 / 分析中」，排除 done/rejected；
  - 排序：bug 优先 + 同类时间升序；
  - 意图解析：各关键词 → 正确 action；无关文本 → unknown（触发 Claude 兜底）；
  - yes/no 解析。
- **有副作用部分**（队列串行、飞书推送、develop）→ `node --check` 语法校验 + 飞书手动联调（符合 ARCHITECTURE §9 现有做法）。

---

## 9. 已知限制

- **队列为内存态**：node 重启会丢；重启后卡在 `developing` 的任务需在 web 管理台重触发（与现有 `runs.js` 取舍一致）。
- **串行开发**：多个「开始」的任务需依次等待，单个开发耗时较长时后续排队较久（这是为避免并发改码冲突的有意取舍）。
- **通知依赖会话 chatId**：后台完成通知发往最近一次触发流程的 `chatId`。

---

## 10. 验收标准

1. owner 发触发词 → 收到**分组**待处理列表 + 是否开始的询问；guest 发同样的话**不进入**此流程。
2. 回「开始」→ 按**故障优先 + 时间**顺序逐个呈现「已有方案」项（含方案摘要）。
3. 对当前项回「开始/放弃/跳过/补充/退出」（含自然语言变体）→ 行为正确，且**决策不被开发阻塞**。
4. 「开始」的任务在后台**串行**开发；每个完成后飞书收到完成/失败通知。
5. 全部过完 → 输出本轮汇总（开始/放弃/跳过/重新分析计数 + 队列剩余）。
6. `logic.test.js` 全绿；`node --check` 无语法错误；owner 日常 Claude 指令不受影响。

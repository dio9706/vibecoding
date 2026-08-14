# 自动续跑自恢复机制 — 设计文档

- 日期：2026-07-20
- 范围：web 执行台（`claude-web`）后端续跑链路 + 前端待续跑轮询
- 决策：续跑上限 + 失效清除；不处理"自杀式重启"footgun（另议）

## 1. 背景与问题

用户让 Claude 在 web run 内执行 `pm2 restart claude-web`（重启承载自己的进程），随后该会话进入死循环：满屏"⚠️ run 不存在或已过期"，且新开会话也被拖入、找不到 run。

### 根因链路（已核验代码）

进行中的 run 通过 `store/active-runs.js` 落盘镜像，生命周期为
`startClaudeRun`→`addActiveRun` → `onInit`→`patchActiveRun`(补 session_id) → `settleRun`→`removeActiveRun`。

1. `pm2 restart` 杀掉进程时，当前 run **从未走到 `settleRun`**，永久残留在 `active-runs.json` 成为"孤儿"。
2. 进程重启后 `server.listen` 回调的**孤儿恢复**把孤儿转成 pending → `scheduleResume`（约 +30s）→ `doResume` → 新建 run 发「继续」续接同一 session。
3. Claude 续接后上下文任务仍是"重启/排障"，很可能**再次 `pm2 restart`** → 新 run 又成孤儿 → 再续跑…… **无限循环**。
4. 每轮重启使前端 `refreshPending`（**全局轮询、非按会话隔离**）对着已死 runId 反复向会话消息列表塞空气泡并 attach → 满屏"run 不存在"。新开浏览器会话因 `handledResumes`（内存态，刷新即清）为空，同样被这条 stuck pending 污染。

### 核心缺口

`doResume` 无条件信任 pending 条目：既无"续跑失败/进程又被重启"的尝试上限，也无"引用的 run 已不存在就放弃"的失效守卫。前端 `refreshPending` 又跨会话副作用式地改写他会话消息列表。

## 2. 目标与非目标

**目标**
- 破环根治：连续自动续跑达到上限即熔断，停止再生新 run。
- 失效清除：run 不存在时干净收尾并移除对应 pending/会话残留状态。
- 会话隔离：熔断/清除某会话不得影响其他会话与新开会话。

**非目标**
- 不阻止 / 不改写 Claude 在 run 内 `pm2 restart claude-web` 的行为（自重启 footgun 另议）。
- 不改动看门狗、额度用尽续跑的既有阈值与主流程（仅在其失败达上限时熔断）。

## 3. 设计

### 模块 1：续跑计数（后端持久化，破环根治）

计数必须**跨进程重启存活**（循环正是靠重启升级的），落在两个已落盘 store 上链式传递：

- `store/active-runs.js`：条目新增 `resumeAttempt`（本 run 的续跑代次，普通首跑为 0）。
- `store/pending-resume.js`：条目新增 `attempts`（本条目已发起的续跑次数）；`addPending` 默认 `attempts: 0`。

传递链：

```
doResume(entry)  ──► startClaudeRun({ resumeAttempt: entry.attempts })
                        └► addActiveRun({ resumeAttempt })         [落盘]
进程重启 ──► 孤儿恢复读 orphan.resumeAttempt
        ──► nextAttempt = (orphan.resumeAttempt || 0) + 1
        ──► addPending({ attempts: nextAttempt })                  [落盘]
```

"孤儿→续跑→孤儿"每转一圈 `attempts` +1。**正常收尾（`settleRun`→`removePending` / `removeActiveRun`）清空条目 → 计数自然归零**，单次重启续跑一次的正常能力完整保留。

### 模块 2：熔断与清除（失效即移除）

- 常量 `MAX_RESUME_ATTEMPTS = 3`（写在 server.js，含中文注释说明取值理由）。
- **两处守卫**：
  - 孤儿恢复：计算 `nextAttempt`，若 `> MAX` → **不 `scheduleResume`**，改为写一条 `abandoned` 标记条目 `addPending({ convId, attempts: nextAttempt, status: 'abandoned', reason })`。
  - `doResume`：起跑前若 `entry.attempts > MAX` → 放弃（防御性；正常由孤儿恢复先拦），`updatePending(entry.id, { status: 'abandoned', reason })`。
- 熔断的落盘状态统一为 `status:'abandoned'`（**不立即 remove**）：条目保留供前端轮询消费一次终结提示，前端展示后调用 dismiss 才 `removePending`。`abandoned` 条目**不参与** `scheduleResume`（`server.listen` 重排时 `status !== 'done' && status !== 'abandoned'` 才排程）。同时 `logger.warn('web', '续跑熔断', { convId, attempts, reason })`。
- 决策逻辑抽成**纯函数** `shouldAbandonResume(attempts, max)`（返回布尔），加入测试（`runs.test.js` 或新增 `pending-resume.test.js`，`node --test`），对齐仓库 token-rotation 纯函数可测的既有模式。

### 模块 3：前端失效清除 + 会话隔离

- 新增 `POST /api/run/pending/dismiss`（对齐现有 `/api/tokens/dismiss`）：入参 `{ convId }`，按 convId 移除 pending 条目；返回 `{ ok }`。
- `attachStream` 的 `error` 事件处理：收到"run 不存在或已过期"时，除现有定稿气泡（已 `pending:false`）外，调用 dismiss 清掉该会话 pending → openConv / 刷新不再重连。
- `refreshPending` **会话隔离**：
  - 只为**当前打开的会话**（`e.convId === currentConvId`）物化续跑气泡并 `attachStream`。
  - 后台会话仅更新 `pendingMap`（驱动徽标/横幅），**不再向其消息列表 `convPushMessage` 塞空气泡**——这是"污染他会话/新会话"的根。
  - 后台会话的续跑改由用户真正 `openConv` 时接流：`openConv` 增补——若该会话存在 `status:'resuming'` 且 runId 存活的 pending，而消息列表无对应 pending 气泡，则新建气泡并 `attachStream`。
- `abandoned` 通知：前端轮询到后展示一次终结提示（如"连续 N 次自动续跑均未完成，已停止自动续跑；如需继续请手动发送消息"），随即调用 dismiss 移除。

## 4. 影响面

改动文件：
- `src/store/pending-resume.js`：`attempts` 字段（默认 0）。
- `src/store/active-runs.js`：`resumeAttempt` 字段。
- `src/entrypoints/web/server.js`：`startClaudeRun` 透传 `resumeAttempt`；`doResume` 守卫；孤儿恢复计次+熔断；`abandonResume` 助手；`/api/run/pending/dismiss` 路由；pending 列表透出 `attempts`/`abandoned` 状态。
- `public/app.js`：`refreshPending` 隔离与 abandoned 提示；`attachStream` error 失效清除；`openConv` 后台会话接流补齐。
- 纯函数 `shouldAbandonResume` + 测试。

**不破坏**：单次重启后自动续跑一次、额度用尽续跑、看门狗阈值、正常关网页续跑均不变；仅在连续失败达上限才熔断。

## 5. 验证要点

- 单元：`shouldAbandonResume` 边界（attempts < / = / > max）。
- 手动/构造：模拟 `active-runs.json` 残留孤儿 + `resumeAttempt` 递增，确认第 4 次进程重启不再新建续跑 run、pending 转 abandoned、前端展示一次终结提示后消失。
- 隔离：会话 A 的 stuck pending 不再向会话 B / 新开浏览器会话塞气泡；对着已死 runId 的 attach 收到 error 后自动 dismiss，不再复发。
- 回归：正常单次 `pm2 restart` 后自动续跑一次仍工作；额度用尽续跑不受影响。

## 6. 取值

- `MAX_RESUME_ATTEMPTS = 3`：允许极少数合理的意外重启自动续跑，同时对病态循环快速（≤3×~30s）熔断。可后续按实测调整。

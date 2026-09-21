# BUG 巡检循环化与需求测试期对接 · 设计

- 日期：2026-09-18
- 状态：已拍板，待实现
- 关联：`docs/superpowers/specs/2026-08-04-trusted-commands-design.md`（\10001 原始设计）、`src/entrypoints/web/req-inspect.js`（测试期表格巡检）

## 1. 背景与目标

现有 `\10001` BUG 巡检是**一次性**的：触发 → 发表格 → 扫一遍 → 汇报结束。维护者请假期间需要它能自己转起来：修完一批后待命，隔一段时间再扫，直到被叫停或超时。

同时，需求工作流进入测试期后，巡检扫出的问题不一定是前端的。当前无差别按前端自动修，会把后端问题也塞进 auto-dev 白烧额度，且真正该处理的人不知情。

本设计要达成：

1. 新增 `\10004 停止巡检`，`\10001` 触发后进入**循环巡检**：修完一批 → 待命 20 分钟 → 再扫，直到 `\10004` 或累计 12 小时。
2. 关联测试期需求时，对确认的缺陷做**前后端归属判定**；后端问题转派给后端同事并 @ 提醒，附人话建议；前端问题走现有自动修复链路。
3. 每轮真实处理过问题后 @ 维护者汇报，交由人工 review 并提交。

**非目标**：不自动合并任务分支；不改 `req-inspect.js`（web 侧测试期巡检）的既有行为。

## 2. 拍板记录

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 驳回记录重复评审的成本 | `seen` 集合记住已判过的 `recordId`，后续轮跳过 |
| 2 | @ 的生效场景 | 沿用触发会话；群聊真 @，私聊降级为纯文字姓名 |
| 3 | 后端问题的表格动作 | **不动状态字段**，把人员字段里的「我」换成后端同事 |
| 4 | 循环状态存放 | 落盘到 store，**web 进程**驱动循环 |
| 5 | 归属判定的实现 | 评审门判 `fix` 之后，再跑一次**独立**的只读归属判定 |
| 6 | 需求关联方式 | 触发时自动找 `phase==='test'` 的需求 |
| 7 | 汇报频率 | 只在本轮真实处理过问题时 @，无新增的轮次静默 |
| 8 | 转派是否加人 | 移除我 **+ 加后端同事**（真转派） |
| 9 | `\10004` 语义 | 停循环，已入队的修复继续跑完，完成后发最终汇报 |
| 10 | 归属判定 `unknown` | 当作前端处理，走现有自动修复 |
| 11 | 修复失败 | 自动重试一次，再败记账 |

> 决策 3 的价值：归属判定本就靠「人员字段包含我的 open_id」筛选（`isAssignedToMe`），把我从人员字段移除后，下一轮天然筛不到这条记录 —— **人员字段同时充当了去重游标，且语义准确**（这确实不再是我的活）。不需要额外的状态选项，也就不受表结构限制。

## 3. 架构

### 3.1 进程分工

```
飞书进程（遥控器）                    web 进程（循环主场）
──────────────────                  ──────────────────────
\10001 → 等表会话 → 收链接            startPatrolLoopPump（server.js listen 启动）
   ↓ 找 phase==='test' 需求             ↓ 每 30s tick
   ↓                                   ├─ 累计 > 12h → 终报 + 停
POST /api/patrol/start ─────────────→  ├─ scanning：本轮任务是否全终结
                                       │    └→ 结算 → 有处理才 @ → standby
\10004 ──→ POST /api/patrol/stop       └─ standby：到 nextRunAt → 跑下一轮
```

**为什么循环必须在 web 进程**：auto-dev 执行泵只在 web 进程常驻（`auto-dev/index.js:39`「仅 principal-web 进程调用」）。「所有问题修完才进待命」要读任务终态，放 feishu 进程就得跨进程轮询 `tasks.json`，多一层无谓的竞争。

**web 进程能发飞书消息**：`integrations/lark.js#sendText(chatId, text)` 属 integrations 层，`web/conv-notify.js` 已在这么用。`shared/mention.js#atPrefix` 是零依赖纯函数，拼 `<at>` 标签同样可用。

**跨进程下发**沿用 `create-session/index.js` 的既有范式：`fetch('http://127.0.0.1:${config.web.port}/...')` + `AbortSignal.timeout(3000)` + 非 JSON 响应不抛穿。

### 3.2 新增文件

| 文件 | 职责 | 依赖方向 |
|---|---|---|
| `src/store/patrol-loop.js` | 循环状态落盘（文件锁 + 原子写） | store 层，零业务依赖 |
| `src/plugins/team-tools/bug-patrol/loop.js` | 循环泵（web 进程常驻） | → store / review / auto-dev queue / lark |
| `src/plugins/team-tools/bug-patrol/loop.logic.js` | 纯函数：轮次结算、汇报文案、终结判定 | 零 IO |
| `src/plugins/team-tools/bug-patrol/side-review.js` | 前后端归属判定（独立只读 Claude 调用） | → integrations/claude |
| `src/plugins/team-tools/bug-patrol/side-review.logic.js` | 纯函数：归属 prompt 构造、输出解析、后端人选解析 | 零 IO |
| `src/plugins/team-tools/stop-patrol/` | feature `\10004`（order 15） | → config（跨进程 POST） |
| `src/entrypoints/web/routes-patrol.js` | `/api/patrol/start`、`/api/patrol/stop` | entrypoints 层 |

### 3.3 改动文件

| 文件 | 改动 |
|---|---|
| `bug-patrol/index.js` | 拿到链接后不再本地 `runPatrol`，改为找测试期需求 → 跨进程 POST 启动循环；多需求时进「选需求」等待态 |
| `bug-patrol/logic.js` | 新增 `STOP_TRIGGERS`、`parseReqChoice`（序号解析）、`filterUnseen` |
| `team-tools/index.js` | 挂 `stop-patrol` feature，order 15 |
| `web/server.js` | ROUTES 表加 `/api/patrol` 前缀；listen 回调启动 `startPatrolLoopPump` |
| `integrations/lark.js` | 无需新增 API（`updateBitableRecord` 已能写任意字段） |

**单例约束**：同时只允许一个循环。auto-dev 只有一个常驻工作区，两个循环会抢同一个分支。第二个人触发时回「已有巡检在跑（由 XXX 于 HH:MM 启动）」。

## 4. 状态结构

`src/store/patrol-loop.js` → `patrol-loop.json`

```js
{
  active: false,              // 循环是否在跑；false 时泵直接 return
  stopping: false,            // \10004 已收到，等已入队任务跑完后发终报
  openId: '',                 // 触发人（也是汇报 @ 的对象）
  chatId: '', chatType: '',   // 回发目标；chatType 决定 @ 能否生效
  appToken: '', tableId: null, url: '',
  reqId: null,                // 关联的测试期需求；null = 退回纯 \10001 行为
                              // 刻意只存 id 不存 title 快照（对齐 store/colleagues.js 的
                              // 「assignees 存 id 不存姓名快照」纪律）：汇报时实时
                              // getRequirement(reqId)?.title，需求中途改名也能显示新名
  startedAt: 0,               // 12h 判定基准
  phase: 'scanning',          // 'scanning' | 'standby'
  nextRunAt: 0,               // standby 下一轮时间
  roundNo: 0,
  seen: {},                   // { [recordId]: { verdict, side, at } } 成本护栏
  cycleTaskIds: [],           // 本轮入队的 taskId，用于判「全修完」
  retried: {},                // { [taskId]: true } 失败重试记账
  report: {                   // 本轮累积，@ 之后清空
    fixed: [],    // { title, taskId, branch }
    handoff: [],  // { title, to, advice, demoted }
    failed: [],   // { title, reason }
    unknown: [],  // { title, taskId }
  },
}
```

**常量**（模块内写死，不做配置项 —— YAGNI，需要调时改代码即可）：

```js
const TICK_MS = 30_000;          // 泵 tick 间隔
const STANDBY_MS = 20 * 60_000;  // 待命 20 分钟
const MAX_LIFETIME_MS = 12 * 3600_000;  // 12 小时上限
```

### 4.1 需求名回显（贯穿所有对外文案）

关联到测试期需求时，**所有发给用户的巡检文案都要带上需求名**，让人一眼知道这轮巡检挂在哪个需求上。取值一律 `getRequirement(reqId)?.title`（实时读，理由见上）；需求被删或读不到时降级为不显示，不报错。

**启动应答**（收到表格链接后的即时回复）：

```
关联需求：订单中心改版
🔍 已收到表格，开始巡检…（逐条评审需要几分钟，完成后在此汇报）
每 20 分钟自动复查一次，累计 12 小时后自动停止；发「\10004 停止巡检」可随时结束。
```

未关联需求时该行不出现，其余文案不变：

```
🔍 已收到表格，开始巡检…（未找到测试期需求，本次不做前后端归属判定）
```

**多需求选择**：

```
找到 3 个处于测试阶段的需求，回复序号选择：
1. 订单中心改版
2. 商品详情页重构
3. 会员体系升级
（回复「取消」退出）
```

**轮次汇报 / 最终汇报**：见 §8.3，标题行同样带需求名。

## 5. 单轮流程

```
runOneRound()
 ├ listBitableTables → 逐表 Haiku 映射 + validateFieldMapping（不变）
 ├ 服务端 filter 状态=待处理 + 客户端 isAssignedToMe（不变）
 ├ filterUnseen(records, seen)          ← 成本护栏：已判过的直接跳过
 └ 逐条串行：
    ├ reviewTask → verdict !== 'fix' → 记 seen，不动表，不汇报
    └ verdict === 'fix'：
        ├ reqId === null → 现有逻辑：写「修复中」+ createTask + requestAutoDevelop
        └ reqId !== null → sideReview(记录, req.projects)
             ├ 'frontend' | 'unknown' → 同上现有逻辑（unknown 计入 report.unknown）
             └ 'backend' → 转派（见 §6）+ 记 seen + 计入 report.handoff
```

### 成本账

seen 护栏生效后，第 2 轮起只评审表里**新增**的记录。额度消耗从「N 轮 × 全部待处理」降为「1 × 全量 + (N-1) × 增量」。

## 6. 后端转派

### 6.1 后端人选

```
优先：req.assignees（同事 id 数组）→ getColleague(id) → 过滤 role === 'backend' 且有 feishuOpenId
回退：getColleaguesByRole('backend') → 第一个有 feishuOpenId 的
兜底：拿不到 → 降级（见下）
```

### 6.2 表格写入

```js
updateBitableRecord(appToken, tableId, recordId, {
  [assigneeField]: [{ id: backendOpenId }],   // 移除我 + 加后端
});
// 状态字段刻意不动 —— 表结构不一定有「后端处理中」这类选项
```

原人员字段可能有多人。写入规则：**保留除我之外的原有成员，追加后端同事**（去重）。只把我摘出去，不替别人做决定。

### 6.3 降级

拿不到后端 `open_id` 时：**仅移除我**（人员字段去掉我，保留其余），@ 照发但写成 `@后端（名册未配 open_id）`，汇报里标 `demoted: true` 说明。不阻断整轮。

### 6.4 @ 与建议

```
群聊：<at user_id="ou_xxx"></at> + 建议
私聊：@张三（后端） + 建议     // atPrefix 对 p2p 返回空串
```

**@ 的时机：统一在轮次汇报里发，不当场单独发。** 一轮扫出 3 个后端问题就当场发 3 条消息会刷屏，且后端拿到的是没有上下文的孤立通知。放进轮次汇报后，后端在同一条消息里能看到这轮的全貌。代价是后端知情时间推迟到本轮修复跑完（可能几小时）—— 接受，因为后端问题本就不在自动修复的关键路径上。

建议文案由 `sideReview` 一并产出，要求**简短、人话、可执行**，不贴代码不贴堆栈。示例：

> 订单列表分页数据错乱 —— 接口返回的 total 和实际条数对不上，前端只是照着渲染。建议查一下分页 SQL 的 count 语句。

## 7. 归属判定（side-review）

独立于 `reviewTask` 的第二次只读调用（拍板 5：`review/index.js` 已两轮过审保持稳定，不动它）。

```js
runClaude(buildSidePrompt(record, { frontendDir, backendDir }), {
  cwd: frontendDir,
  addDirs: [backendDir],
  permissionMode: 'dontAsk',
  allowedTools: ['Read', 'Grep', 'Glob'],   // 与 reviewTask 同款只读闸
  persistSession: false,
});
```

输出契约（单行 JSON，解析复用 `review/logic.js#parseReviewJson` 的括号配平思路）：

```json
{"side":"frontend|backend|unknown","evidence":"代码依据","advice":"给后端看的人话建议（side=backend 时必填）"}
```

**超时护栏**：5 分钟（对齐 `req-inspect.js#REVIEW_TIMEOUT_MS`），超时按 `unknown` 处理，不中断整轮。

**`unknown` 按前端修**（拍板 10）：修在任务分支上等人工 review，改错了也进不了主干，代价可控。

**`backendDir` 缺失**（需求没配后端工程）：跳过归属判定，全部按前端处理，首轮汇报里说明一次。

## 8. 轮次结算与汇报

### 8.1 「全修完」判定

**关键契约**：auto-dev 失败时状态退回 `'analyzed'`（`auto-dev/index.js:70,94,102,112,121,136,142`），**没有 failed 状态**。因此：

```js
// 终态 = done（成功）| analyzed（失败退回）
// 非终态 = queued | developing
const isSettled = (t) => t.status === 'done' || t.status === 'analyzed';
```

`cycleTaskIds` 全部 `isSettled` → 本轮结束。

### 8.2 失败重试（拍板 11）

```
task.status === 'analyzed' 且 !retried[taskId]
  → retried[taskId] = true; requestAutoDevelop(taskId, 'BUG 巡检自动重试')
  → 该 taskId 继续留在 cycleTaskIds 里等下次 tick
再次 analyzed → 计入 report.failed，不再重试
```

表格状态保持「修复中」不回退，下轮不会重扫（也在 seen 里）。

### 8.3 汇报

**只在 `report` 四个数组有任一非空时发**（拍板 7）。发完清空 `report`，置 `phase='standby'`、`nextRunAt = now + STANDBY_MS`。

```
{@维护者} 【订单中心改版】本轮处理完毕，已进入待命（下次扫描 20 分钟后，累计已跑 3h20m）

🔧 已修复待你 review 并提交（3 条）
  1. 导出按钮点击无响应  → 分支 task/t_xxx
  2. ...
📮 已转后端 {@李四}（2 条）
  1. 订单列表分页数据错乱 —— 接口返回的 total 和实际条数对不上，
     前端只是照着渲染。建议查一下分页 SQL 的 count 语句。
❓ 归属判不准，已按前端修（1 条）
  1. xxx → 分支 task/t_yyy
⚠️ 修复失败（1 条，已重试一次）
  1. xxx —— 自动开发失败：开发过程无代码改动
```

**不自动合并**。分支名给出，由维护者 review 后自行提交。

### 8.4 最终汇报

`\10004` 停止或累计 12 小时到期时发，**无论 `report` 是否为空都发**（与轮次汇报的「空报抑制」相反 —— 循环结束是必须让人知道的事件）。格式同上，仅首行不同：

```
{@维护者} 【订单中心改版】巡检已停止（手动停止 / 已满 12 小时），共跑 5 轮，累计 11h42m
```

`report` 为空时首行后接一句「本轮无新增问题」，不列空标题。

## 9. 错误与边界

| 情况 | 处理 |
|---|---|
| 找到多个 `phase==='test'` 需求 | 列出编号让用户回序号选（新增「选需求」等待态，复用 10 分钟 TTL） |
| 找到 0 个 | `reqId = null`，退回纯 \10001 行为，**启动应答里**说明（§4.1） |
| 后端没配 `feishuOpenId` | 仅移除我，@ 降级为文字，汇报标注（§6.3） |
| `backendDir` 未配置 | 跳过归属判定，全按前端（§7） |
| 归属判定超时/异常 | 按 `unknown` → 前端修，不中断整轮 |
| 单条记录处理异常 | 计入 `report.failed`，继续下一条（沿用现有 try/catch 粒度） |
| 整表字段映射不过 | 跳过该表并回告原因（不变） |
| web 进程重启 | 状态落盘，泵启动时按 `startedAt` 续算剩余时长自动续跑 |
| 额度耗尽 | 循环挂起不空转，@ 维护者告警；token 恢复后续跑 |
| `\10004` | `stopping = true`；已入队任务跑完后发最终汇报，`active = false` |
| 重复 `\10001` | 已有循环在跑时拒绝并告知启动人与时间 |

## 10. 测试

**纯函数单测**（`node --test`，新增）：

- `loop.logic.js`：`filterUnseen` 去重、`isSettled` 终态判定、`shouldReport` 空报抑制、`buildRoundReport` 四类文案、`isExpired` 12h 判定
- `side-review.logic.js`：`parseSideJson` 解析（含畸形输出落 unknown）、`resolveBackendOpenId` 三级回退、`buildAssigneePatch` 保留他人 + 移除我 + 追加后端
- `logic.js` 增补：`STOP_TRIGGERS` 全等匹配、`parseReqChoice` 序号解析

**契约测试**：`routes-patrol.js` 的 start/stop 入参校验与单例拒绝。

**不做**：循环泵本体的集成测试（依赖真实 bitable + Claude 调用，与 `auto-dev` 泵同口径靠人工验收）。

## 11. 人工验收清单（实现后必做）

1. **⚠️ 人员字段写入先真机验证**：这是本设计唯一会改表格数据的新动作，且 `\10001` 原始设计里「单选值写入是否成功」的走查项至今未真机验证。**在开 12 小时无人值守之前，务必手动跑一轮确认 `[{id:'ou_xxx'}]` 格式写入成功。**
2. 把 `MAX_LIFETIME_MS` 临时改短（如 20 分钟）跑一轮完整循环，确认 scanning → standby → 再扫 → 汇报的状态机正确。
3. 群聊与私聊各触发一次，确认 @ 在群里真实生效、私聊降级文案可读。
4. 测试期需求 0 个 / 1 个 / 多个三种情况各走一次。
5. `\10004` 在 scanning 中途触发，确认已入队任务跑完后才发终报。
6. web 进程 kill 后重启，确认循环自动续跑且剩余时长正确。

## 12. 已知取舍

- **20 分钟不是真周期**：auto-dev 串行修复，一轮扫出 8 个 bug 可能跑几小时。实际周期 = 修复耗时 + 20 分钟。12 小时内可能只跑 4~5 轮，而非 36 轮。符合「修完才待命」的语义，但与「每 20 分钟」的字面预期有出入。
- **seen 护栏的代价**：在表里补充了描述让某条记录变得可修，本轮不会重评。需重新触发 `\10001` 做全量扫描。
- **不做成本熔断**：12 小时上限本身即护栏，不再叠加 token 消耗阈值（避免在无人值守时因阈值误判静默停摆）。

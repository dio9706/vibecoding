# 机器人端日志面板（替换 HTTP 访问日志展示）— 设计文档

- 日期：2026-08-26
- 范围：把「访问日志」面板从 **web 控制台 HTTP 访问记录** 改为 **机器人端业务日志**，形如
  「时间 XXX 机器人XXX 为用户XXXX 执行了XXX动作 · 结果」。新增独立日志落点、飞书用户名解析、
  两处埋点，并顺带抽出三份重复的 JSONL 存储逻辑。
- 依赖：现有 `action-log.jsonl` 写入链路、`dispatchSafely` 返回契约、`lark.js` API client。

## 0. 现状核实（写 spec 前已逐条验证）

| 事实 | 位置 |
|---|---|
| 「访问日志」面板读 `/api/logs` → `event-log.jsonl`，内容是 HTTP access（`method/path/status/ms`） | `public/js/logs-panel.js:31`、`src/entrypoints/web/routes-ops.js:23` |
| 现存 346 条 event-log **全部**是 `type:"access"`，绝大多数是前端轮询噪音（`/api/optimize/report`） | `event-log.jsonl` |
| `action-log.jsonl` 已记录动作执行（`userId/actionId/actionName/vars/ok/code`），但**全项目无任何读取方**（只写不读） | `src/store/action-log.js:78` |
| action-log **无 `botId`**；`action-configs.json` 每条动作有 `botId`，可由 `actionId` 反查 | `src/store/action-configs.js` |
| 全项目**无** openId → 姓名 能力；`lark.js` 27 个导出中无相关函数，飞书事件 sender 也只给 open_id | `src/integrations/lark.js` |
| 飞书对话落点：`dispatchSafely(ctx)` 已返回 `{ ok, notified }`，可直接用作成功判定 | `src/entrypoints/feishu/index.js:257`、`src/app/dispatch.js:30` |
| `event-log.js` 与 `action-log.js` 各有一份**逐字重复**的 `readJsonl()` + `compact()`（含「必须加锁」注释） | 两文件 |

## 1. 拍板结论

| 决策点 | 结论 |
|---|---|
| 日志范围 | **动作执行 + 飞书对话**两类（不含可信指令、需求单操作） |
| 用户名来源 | **调飞书 contact API + 缓存**，未开通权限时回退 openId 尾号 |
| 原 HTTP access 记录 | **面板完全不展示，后端继续写**（`event-log.jsonl` 照旧，排障可直接看文件） |
| 存储落点 | **新建 `bot-log.jsonl` 独立文件**（方案 A） |
| 重复的 JSONL 逻辑 | **一起抽出** `src/store/jsonl.js`，三个 store 收敛 |

### 为何不复用 `event-log.jsonl`（关键取舍）

`event-log.js` 的 `MAX = 1000`，而 `server.js:132` **每个 HTTP 请求写一条**。前端 5 秒一轮的
`/api/optimize/report` 轮询就能在几十分钟内把机器人日志全部挤出上限——放在同一个环形缓冲里
等于自动删除。3 天保留窗口在这里形同虚设。

### 为何不扩展 `action-log.jsonl`

它是**脱敏审计**用途：`maskDeep` 针对结构化 `vars` 设计，套不到对话自由文本上；文件名与内容
语义会错位；且历史 500 条全无 `botId`/`kind`，渲染要一路兼容分支。两类日志的字段需求会互相拖累。

## 2. 数据层

### 2.1 新增 `src/store/bot-log.js`

```js
{ time, botId, botName, userId, userName, kind: 'action'|'chat', detail, ok, code }
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `botName` | 写入时**快照** | 机器人改名后历史记录仍显示当时的名字，符合审计语义 |
| `userName` | 写入时解析 | 解析失败落 `null`，渲染时回退尾号 |
| `detail` | action → `actionName`；chat → **用户原话摘要**（截断 60 字，非机器人回复内容） | |
| `ok` / `code` | action → `result.ok` / `result.code`；chat → `dispatchSafely()` 的 `{ok}`，`code` 省略 | |

- **容量**：`MAX = 2000` 条，**不设时间窗**。这是业务审计日志且低频（一天几条到几十条），
  event-log 的 3 天窗是为压住每请求一条的 access 洪流，此处不存在该问题，按时间删只会白丢历史。
- **并发**：compact 必须加锁（复用 `acquireLock/releaseLock`）。`feishu` 与 `web` 是**两个进程**
  且都可能写入，`event-log.js:71-77` 已记录过这个坑：「读全量 → rename 覆盖」会吞掉对方在
  压缩窗口内追加的行。
- 追加写无锁（单行 < 4KB 近似原子，极端并发丢一行可接受），与既有两个 store 一致。

### 2.2 抽出 `src/store/jsonl.js`

```
readJsonl(file)                          -> 数组，文件序（旧→新），坏行跳过
compactJsonl(file, { max, retainMs? })   -> 加锁 + 时间窗过滤 + 条数裁剪 + 原子 rename
```

三个 store 收敛过去：`event-log.js`（`max:1000, retainMs:3天`）、`action-log.js`（`max:500`）、
`bot-log.js`（`max:2000`）。`retainMs` 省略即不做时间过滤。

这属于「改进正在动的代码」而非无关重构：不抽就是第三份复制。`event-log.test.js` 是抽取安全性的判据。

### 2.3 `lark.js` 新增 `getUserName(openId)`

```
GET /open-apis/contact/v3/users/:id?user_id_type=open_id|user_id
```

**`user_id_type` 必须按 id 前缀动态判定**：`ctx.user.id` 并非恒为 open_id——
`card-actions.js:63` 的注释写明卡片回调路径是「优先 userId（飞书内部 ID），回退 openId」，
而 `feishu/index.js:226` 走的是 `m.userId`（实测 `action-log.jsonl` 中为 `ou_` 开头的 open_id）。
故：`ou_` 前缀 → `user_id_type=open_id`，否则 → `user_id`。写死 `open_id` 会让卡片回调触发的
动作日志全部解析失败。

严格照 `getBotOpenId()`（`lark.js:51`）的四条既有范式：

1. 模块级 `Map` 正缓存（除首次外零网络开销）
2. 失败**负缓存带 TTL = 60s**（沿用 `BOT_OPEN_ID_FAIL_TTL` 同值；权限缺失时不必每条消息都打一次
   HTTP + 刷一条 warn，TTL 保证权限修好后无需重启）。负缓存按 id 粒度记录，不是全局开关——
   否则一个已离职用户查不到会连带压掉所有人的解析
3. 显式校验 `r?.code`（SDK generic request 不校验业务码，HTTP 200 + code≠0 也是失败）
4. **取不到返回 `null` 而非抛错**，调用方降级

`resetApiClient()` 中一并清缓存（换号后 openId 归属可能变）。

需飞书应用开通 `contact:user.base:readonly`。未开通时负缓存生效，一分钟最多一次无效请求，
日志正常写入、仅显示尾号。

## 3. 组装层与埋点

### 3.0 组装层 `src/shared/bot-activity.js`

埋点现场只有 id（`botId`/`userId`），而落盘需要展示用快照（`botName`/`userName`）+ 截断后的
`detail`。这段组装被两个埋点共用，收在一处（DRY）：

```
recordBotActivity({ kind, botId, userId, detail, ok, code })
  → botNameOf(botId)（查 getBots）+ getUserName(userId) + preview(detail, 60) → appendBotLog
```

放 `shared/` 而非 `store/`：解析姓名要调 `integrations/lark`、查机器人名要读 `store/settings`，
让 `store/bot-log.js` 反向依赖这两者会把存储层与业务层绑死。`detail` 截断复用既有的
`shared/logger.js` 的 `preview(text, n)`（归一空白 + 截断），不另写。

**该函数永不抛错**：埋点在用户消息处理路径上。

### 3.1 埋点位置（2 处）

**1. `src/plugins/action-runner/feature/script-runner.js:137`** — 已有 `appendActionLog` 的 try 块**之后**
调 `recordBotActivity({ kind:'action', ... })`。`botId` 由 `getConfig(actionId)?.botId` 反查
（`store/action-configs.js:27`）。`appendActionLog` 保留不动。

**2. `src/entrypoints/feishu/index.js:257`** — 接住 `dispatchSafely` 的返回值：

```js
const r = await dispatchSafely(ctx);
// 埋点放在回复已发出之后：getUserName 首次调用有网络往返，不能挡用户感知
```

异常兜底统一由 `recordBotActivity` 内部承担（见 §3.0），埋点处无需再套 try/catch——
**日志写失败绝不影响主流程**，与既有两个 log store 的原则一致。
`action-log.jsonl` 的写入**保留不动**（审计用途），bot-log 是并行的展示用途落点。

## 4. 展示层

### 4.1 后端路由（`routes-ops.js`，紧邻 `handleLogs`）

```
GET  /api/bot-logs        → { logs: [...] }   最新在前
POST /api/bot-logs/clear  → { ok: true }
```

**必须同时把这两条加入 `server.js:92` 的访问日志排除集**——否则打开面板这个动作本身就在往
`event-log.jsonl` 里刷记录（现有 `/api/logs`、`/api/logs/clear` 正是因此被排除）。

原 `/api/logs`、`/api/logs/clear` 保留不动。

### 4.2 前端 `public/js/logs-panel.js`

虚拟滚动、搜索栏、清空按钮**全部保留**，只换三处：

1. 数据源 `/api/logs` → `/api/bot-logs`；清空 → `/api/bot-logs/clear`
2. `formatLogEntry` 重写为 `formatBotLogEntry`，**导出为纯函数**以便单测（`public/js/*.test.js` 已有该范式）
3. **删除 `LOG_PATH_LABELS` 映射表与 `cleanup` 分支**——access 不再展示，8 条路径映射与历史
   `cleanup` type 成为死代码，按 YAGNI 清掉。搜索过滤中额外匹配 `g.path` 的分支一并去掉。

文案模板：

```
08-26 15:32  ✅  机器人 1 为 申孟涛 执行了「获取小程序二维码」· 成功
08-26 15:20  ❌  机器人 1 为 申孟涛 执行了「清理账号数据」· 失败(code 1)
08-26 15:18  ✅  机器人 1 回复了 申孟涛：「帮我看下登录接口报错」
```

### 4.3 固定行高约束（已具备，仅需验证）

`ROW_H = 32` 是硬编码固定行高，spacer 高度按 `总条数 × ROW_H` 计算。新文案远长于
`/api/run/start · 200 · 5ms`，一旦折行则行高与 spacer 计算错位、滚动跳动。

**核实结论：`.log-row .info` 已有 `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`**
（`public/app.css:1405-1410`），长文案会被省略号截断，固定行高的前提已经成立。
**本项无需改 CSS，实现时只做验证。**（本节初稿误写为「必须加」，已更正。）

### 4.4 三级降级

| 缺失情况 | 表现 |
|---|---|
| `userName` 为 `null`（权限未开通 / 解析失败） | `用户 …a774fd`（openId 尾 6 位） |
| `botName` 缺失（`botId` 已被删除，或历史条目） | `机器人 —` |
| `bot-log.jsonl` 不存在或为空 | 「暂无机器人日志」空态，**不是报错** |

历史 `action-log.jsonl` 的 5 条记录**不做迁移**：无 `botId`，迁过来也是一行「机器人 —」，
价值不足以引入一次性迁移代码。新日志从上线时刻开始积累。

## 5. 测试策略

| 目标 | 测试 |
|---|---|
| `src/store/jsonl.js` | 坏行跳过、compact 上限裁剪、`retainMs` 时间窗过滤（三 store 行为并集） |
| `src/store/bot-log.js` | 写入→读取倒序、超限压缩、写失败不抛 |
| `lark.getUserName` | mock client：正缓存命中不重复请求、`code≠0` 走负缓存、TTL 过期后重试、失败返回 `null` |
| `formatBotLogEntry` | 纯函数：action/chat 两种文案、失败带 code、`userName`/`botName` 缺失时回退 |
| **回归** | `event-log.test.js` 必须仍绿——`jsonl.js` 抽取是否安全的判据 |
| 补测 | `action-log.js` 现无专门测试（仅 `mask.test.js` 覆盖脱敏），抽取时补一个最小读写往返测试兜底 |

## 6. 切片

- **切片 1**：抽出 `src/store/jsonl.js`，`event-log.js` / `action-log.js` 收敛过去。
  验收：`event-log.test.js` 仍绿 + 新增 `jsonl.test.js` + `action-log` 读写往返测试。
- **切片 2**：`bot-log.js` 存储层 + `lark.getUserName`（含缓存/负缓存单测）。
- **切片 3**：两处埋点接线（script-runner + feishu/index）。
- **切片 4**：`/api/bot-logs` 路由 + 排除集 + 前端面板改造 + CSS 单行截断。

## 7. 风险

1. **contact 权限未开通** → 全部显示尾号。已由负缓存 + 降级覆盖，不阻断功能；需在上线后确认
   飞书应用是否已授权 `contact:user.base:readonly`。
2. **`jsonl.js` 抽取触及两个已稳定文件** → 回归面稍大。`event-log.test.js` 提供护栏，
   `action-log` 补测兜底。
3. **对话日志量级** 高于动作执行，若群聊活跃可能快速填满 2000 条上限。上线后按实际量级再调
   `MAX`，不预先过度设计。
4. **写入路径新增网络调用**（`getUserName`）→ 已放在回复发出之后，且首次之后全部命中缓存。

## 8. 非目标

- 不迁移历史 `action-log.jsonl` 记录。
- 不收录可信指令（`\10001`/`\10002`）与需求单操作——本轮明确排除，后续如需按同一 `kind` 机制扩展。
- 不做日志导出、不做按机器人/用户维度的筛选下拉（搜索框已够用）。
- 不停止 `event-log.jsonl` 的写入，不删除 `/api/logs` 接口。

# 可信提交人专属指令（\10001 BUG 巡检与修复 / \10002 任务清单）—— 设计

日期：2026-08-04
状态：已确认（用户 2026-08-04 批准；三项口径经问答拍板）

## 1. 背景与目标

为飞书机器人新增两个**仅限可信提交人**的指令，均通过**指定文案严格匹配**触发（纯字符串比较，零 LLM 识别成本）：

1. `\10001 开始进行BUG巡检与修复`：触发后等用户发一个多维表格，自动筛出「关于我、待处理」的 BUG，
   逐条评审确认「是当前项目的 BUG 且确实是缺陷」后，把表格记录改为「进展状态=修复中」，
   走既有需求/故障自动开发管线；修复完成后通知触发人，**表格状态不回写**（用户合并代码后自行修改）。
2. `\10002 帮我检查当前正在进行的任务`：列出当前正在执行的任务（含 web 执行台运行中的对话）
   与需求/故障处理进度，仅列标题和进度。

非目标（YAGNI）：不做卡片交互、不做定时巡检、不做表格状态回写、不做 web 端入口、不改意图识别层。

## 2. 用户拍板的口径

| 决策点 | 结论 |
|---|---|
| 严格匹配口径 | 消息去首尾空白后**全等于**完整文案；兼容带「(多维表格)」后缀的原文写法（同为全等） |
| 表格字段识别 | **Haiku 自适应映射**：字段清单交 Haiku 一次分类，映射失败明确报错中止，绝不瞎猜乱改表 |
| \10002 任务口径 | 运行中对话 + 活跃任务（评审中/分析中/排队/开发中）+ 待确认合并 三组 |

## 3. 触发与门禁（两功能共用）

- 触发文案（`logic.js` 常量，全等匹配，大小写敏感）：
  - `\10001 开始进行BUG巡检与修复`、`\10001 开始进行BUG巡检与修复(多维表格)`
  - `\10002 帮我检查当前正在进行的任务`
- 身份门禁：`resolveTrustedOpenIds(getActiveBot(), config.lark.trustedOpenIds)` 包含发送人
  或 `ctx.user.role === 'owner'` —— 与 feedback 直通判定同一套口径（`feedback/logic.js`）。
- 接入方式：复用 task-triage 范式，两个新 feature 以 `match` 抢占接入 team-tools 插件；
  order 12（bug-patrol）/ 14（status-report），必须排在内核 claude-exec(20) 之前，否则 owner 消息被全接。
  非可信人发这两句 → match 不命中 → 落常规意图流程（不暴露功能存在）。

## 4. \10001 BUG 巡检与修复（bug-patrol）

### 4.1 会话流程

内存 session（`Map<openId, {step, chatId, expiresAt}>`，TTL 10 分钟，参照 task-triage / material-pool）：

1. **触发** → 建 session（`awaiting_table`）→ 回复「请把要巡检的多维表格链接发我～」。
2. **等表**（`hasPending` 接管该用户消息）：
   - 「取消/算了/不用了/退出」→ 清 session，回复已取消；
   - 文本中解析多维表格链接：`/base/<app_token>` 直链（`?table=<table_id>` 参数可选）
     或 `/wiki/<token>` 链接（`get_node` 换 `obj_type==='bitable'` 的 `obj_token`）；
   - 解析不出 → 提示重发（session 保持）；解析成功 → 进入巡检管线（异步，先回「开始巡检…」）。
3. session 超时后消息不再被接管（`hasPending` 判 `expiresAt`），自然回落常规流程。

### 4.2 巡检管线（每步失败都有明确回告，绝不静默）

1. **定表**：URL 带 `table=` 只扫该表；否则 `appTable.list` 列出全部数据表逐个处理。
2. **字段映射（Haiku）**：`appTableField.list` 拉字段（名称/类型/选项值），`runClassifierOnce` 产出
   `{status_field, pending_value, fixing_value, assignee_field, title_field}`；
   校验映射的字段名/选项值真实存在（`logic.js` 纯函数），校验不过 → 该表跳过并在汇总里说明。
3. **筛选**：`appTableRecord.search` 过滤 `状态字段 = 待处理值`（服务端 filter），
   人员字段包含触发人 open_id 的客户端过滤（`user_id_type=open_id`）。零命中 → 回告「没有关于你的待处理 BUG」。
4. **逐条评审**（串行）：构造 `{type:'bug', title:记录标题, detail:记录字段拼接+记录链接}` 交
   `reviewTask`（只读查证项目代码）。判决 `fix` → 确认缺陷；`reject/ask` → 不动表格，只进汇总。
5. **确认缺陷的记录**：
   - `appTableRecord.update` 改「进展状态=修复中」（写表失败 → 该条按失败计入汇总，不建任务）；
   - `createTask({type:'bug', title, detail, source:{openId:触发人, chatId:触发会话, via:'feishu', chatType}})`；
   - `requestAutoDevelop(task.id, 'BUG 巡检确认，自动修复')` → 走既有自动开发管线（web 泵串行执行）。
6. **汇总回复**：`命中 X 条 → 转修复 N 条（已改「修复中」）/ 评审不通过 M 条（附一句原因）/ 失败 K 条`。
7. **完成通知**：auto-dev `replySource` 天然通知 `task.source.chatId`（即触发会话，@触发人+分支名）——零新增代码。

### 4.3 新增 bitable 基建（`src/integrations/lark.js`，遵守「全项目唯一飞书调用入口」）

| 函数 | SDK 调用 |
|---|---|
| `listBitableTables(appToken)` | `bitable.v1.appTable.list` |
| `listBitableFields(appToken, tableId)` | `bitable.v1.appTableField.list` |
| `searchBitableRecords(appToken, tableId, {filter})` | `bitable.v1.appTableRecord.search`（`user_id_type=open_id`，分页拉全） |
| `updateBitableRecord(appToken, tableId, recordId, fields)` | `bitable.v1.appTableRecord.update` |
| `resolveWikiNodeObj(token)` | 泛化版 `get_node`，返回 `{objType, objToken}`（现有 `resolveWikiNode` 改为基于它实现，行为不变） |

### 4.4 入口旁路（`src/entrypoints/feishu/index.js`）

wiki 链接会被现有云文档材料摄取拦截（`resolveWikiNode` 对 bitable 返回 null → 回「不支持」并吞掉消息）。
在文档链接摄取前加一个条件：该用户处于 bug-patrol 等表状态（插件导出 `hasPatrolPending(openId)`）
→ 跳过摄取，消息直达 dispatch 由 `hasPending` 接管。与既有 `attachImageToRecentTask` 直引插件的风格一致。

### 4.5 前置条件（用户操作项）

- 开放平台为应用开通多维表格权限（`bitable:app`，读+写记录）并**发布新版本**；
- 表格对机器人可见（加为文档协作者，或知识库/所在群可见）；
- 无权限时回告引导话术（对齐现有 docx 权限提示风格，403/1254302 等归为权限类）。

## 5. \10002 任务清单（status-report）

一次性无状态查询，纯本地读盘，零 LLM：

| 分组 | 数据源 | 进度展示 |
|---|---|---|
| ▶ 对话 | `active-runs.json`（`listActiveRuns` + `isPidAlive` 过滤孤儿） | 标题（session 历史元数据取；拿不到用 cwd+模型兜底）— 进行中 · 已运行 N 分钟 |
| ▶ 需求/故障 | `tasks.json` 状态 ∈ reviewing/analyzing/queued/developing | `[故障]/[需求] 标题 — 评审中/分析中/排队待开发/开发中` |
| ▶ 待确认合并 | `tasks.json` 状态 done 且 `merged===false` 且有 `branch` | `[故障]/[需求] 标题 — 已完成，待合并（分支 xxx）` |

- 标题解析：按 run 条目的 `cwd + session_id` 调 `listHistorySessions` 匹配（运行中条目通常 0~3 个，可接受）；
- 三组都空 → 「当前没有正在进行的任务 🎉」；
- 输出纯文本消息，仅标题+进度，不展开详情。

## 6. 工程落点与测试

| 改动 | 位置 |
|---|---|
| bitable API 封装 | `src/integrations/lark.js` |
| BUG 巡检 feature | `src/plugins/team-tools/bug-patrol/{index,logic}.js` + `logic.test.js` |
| 任务清单 feature | `src/plugins/team-tools/status-report/{index,logic}.js` + `logic.test.js` |
| 插件注册 | `src/plugins/team-tools/index.js`（order 12 / 14） |
| 入口旁路 | `src/entrypoints/feishu/index.js`（1 个条件 + 1 个 import） |

- `logic.js` 纯函数化：触发匹配、门禁判定、链接解析、字段映射校验、记录过滤、状态标签、清单/汇总格式化，全部配 node --test 单测；
- index.js 只做编排（session/回复/API 调用），风格对齐 task-triage；
- **不做 git 提交**（提交时机由用户掌控）；部署需 `pm2 restart claude-feishu`。

## 7. 风险与边界

- **误触发**：全等匹配 + 可信名单双闸，风险极低；
- **Haiku 映射错**：映射结果先经字段存在性校验；写表仅动映射出的单个状态字段，且逐条评审在前，最坏影响=某条记录状态被改「修复中」但未修（汇总里可见）；
- **巡检耗时**：逐条 reviewTask 各 ~30s+，先回「开始巡检」，全程异步不阻塞 dispatch；
- **feedback 的 hasPending 抢占**：等表状态的用户若恰有 30 分钟内被评审否定的任务且发短应答（如「算了”），
  会被 feedback 接管——「算了」同时也是本流程的取消词，语义兼容，不做特殊处理；
- **孤儿 run 误列**：`isPidAlive` 过滤；pid 复用极端场景下最多多列一条「进行中」，可接受。

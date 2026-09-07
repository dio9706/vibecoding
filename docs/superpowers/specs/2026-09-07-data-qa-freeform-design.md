# 自由形数据问答（埋点统计 v2）— 设计规范

> **日期**：2026-09-07
> **状态**：待评审（本文只定契约与安全边界，实施计划另出）
> **目标用户**：产品 / 运营 —— 让他们自己把数问出来，不用排期找研发

---

## 1. 背景

### 1.1 现状能力天花板

`tracking-stats` 今天只能回答**两种**问题，因为 Python 侧只有两条写死的 SQL 形状（`tracking_report.py:172 build_event_sql` / `:201 build_page_sql`）：

- 某几个**事件**在某时间段的 PV/UV
- 某几个**页面**在某时间段的 PV/UV

链路是 `理解(LLM) → 纯函数召回 → 精选(LLM) → 校验 → 固定 SQL → 固定 HTML 报告`。QuerySpec 是闭合结构，模型只能在「选哪几个埋点」上做决策，**不能决定怎么算**。

于是这类问题一个都答不了：

- 「上周新增用户里有多少下单了」（要跨表）
- 「按渠道分组看看这个月的留存」（要 GROUP BY 一个不在 spec 里的维度）
- 「订单表里有多少状态卡在待支付超过 3 天的」（跟埋点无关，是业务库统计）
- 「帮我看下这个库里都有些什么表」（schema 探索）

### 1.2 目标

**只读的数据统计操作都应该支持** —— 不限于埋点，业务库的汇总、分组、关联、排序、schema 探索都要能做。

### 1.3 铁律

**禁止任何写操作。** 不只是「不该写」，是**结构上写不了** —— 见 §3 的四层防线。

---

## 2. 连接前提与待确认事实

### 2.1 生产库必须经 dev 环境跳板

**这是硬前提**（维护者确认）。本机直连实测被拒：

```
pymysql.err.OperationalError: (1045, "Access denied for user 'compass_viewer'@'106.120.76.2'
  (using password: YES) to database 'compass_prod'")
```

仓库里**没有任何隧道/跳板代码** —— `tracking_report.py` 是直连 `dongying-prod-public.rwlb.rds.aliyuncs.com`。所以现有埋点统计要么依赖手工起的隧道/VPN，要么从本机从未跑通（日志被单测输出污染，分辨不出，见 §2.3）。

### 2.2 决定：应用不实现隧道

**连接层只连 `TRACKING_DB_HOST:PORT` 指向的地址，跳板是环境/运维职责，不是应用代码。**

一张表说明为什么这个选择对各种跳板形态都成立：

| 跳板形态 | 应用侧改动 | 配置 |
|---|---|---|
| SSH 本地端口转发（`ssh -L 13306:rds:3306 dev`） | **无** | `TRACKING_DB_HOST=127.0.0.1` / `PORT=13306` |
| VPN / 内网打通 | **无** | 保持现有 RDS 地址 |
| 应用部署在 dev 机器上 | **无** | 保持现有 RDS 地址 |
| dev 机器上另起只读查询服务 | 需改（换成 HTTP 客户端） | 见下方「若选这条」 |

前三种零改动覆盖。取舍理由：

- **SSH 私钥不进应用**。把 `ssh2` 拉进来意味着应用要持有能登 dev 机器的凭据 —— 那比 DB 密码敏感得多，而收益只是省掉一条 `ssh -L`。
- **隧道生命周期不由应用负责**。断线重连、keepalive、指数退避是一整类易碎逻辑，交给 autossh / systemd / 运维脚本比塞进业务进程可靠。
- **可测**。应用侧只有「连一个 host:port」，本地起个 MySQL 就能端到端测。

> **若你选「dev 机器上另起查询服务」**：那是更好的安全形态（SQL 校验与 DB 凭据都留在内网，应用侧拿不到库密码），但多一个要部署维护的服务。届时 §6 的 `mysql-readonly.js` 换成 HTTP 客户端，§3 的第 2、3 层防线整体搬到那个服务里，其余设计不变。

### 2.3 因此新增：启动自检与明确的失败文案

隧道没起时，用户不该看到一个含糊的超时。新增 `scripts/check-tracking-db.mjs`（手工跑）+ 功能内首次查询前的连通性探测：

- 连不上 → 回「数据库连不上，请确认 dev 跳板隧道是否已建立」，并在日志里记下实际尝试的 `host:port`。
- 连得上但鉴权失败 → 回「数据库拒绝连接（账号或授权问题）」。
- 两者分开 —— 混成一句会让人往错误方向排查（这是 `logic.js#buildFailureReply` 已经确立的原则）。

### 2.4 不得假定 DB 账号是只读的

`compass_viewer` 这个名字暗示只读，`docs/CONFIGURATION.md:76` 也写着「只读账号」，但**名字和文档都不是权限**。实施前必须执行一次（`check-tracking-db.mjs` 会带上这一步）：

```sql
SHOW GRANTS FOR CURRENT_USER();
```

期望形如 `GRANT SELECT ON compass_prod.* TO 'compass_viewer'@'%'`。**若出现 `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALL PRIVILEGES`，实施前必须先收窄授权** —— 应用层防线再厚，也不该建立在一个有写权限的连接上。

本设计**不依赖**该账号只读（四层防线独立成立），但那是最便宜、最可靠的一层，不该放弃。

---

## 3. 安全边界（本设计的主体）

给 LLM 自由生成 SQL 打生产库，风险等级远高于现状。四层防线，**每层都能独立挡住写操作**：

### 第 1 层 · 工具面收窄（结构性）

Agent **只有** SQL 工具，没有文件、没有 Bash、没有网络。用 SDK 的进程内 MCP 服务器实现（已验证 `createSdkMcpServer` / `tool` 在 `@anthropic-ai/claude-agent-sdk@0.3.259` 可用，`zod@4.4.3` 已是直接依赖）：

| 工具 | 入参 | 作用 |
|---|---|---|
| `list_tables` | `{ pattern?: string }` | 列可见表（走 `information_schema.tables`，代码写死 SQL） |
| `describe_table` | `{ table: string }` | 列字段与类型（代码写死 SQL，表名参数化） |
| `run_query` | `{ sql: string, purpose: string }` | **唯一**接受自由 SQL 的入口，过第 2 层 |

配置：`disallowedTools: ['*']` 移除全部内置工具 + `allowedTools` 只列这三个 + `canUseTool` 运行时白名单复核（对齐 `llm-readonly-agent.js` 的三层做法）。`permissionMode: 'default'`（`bypassPermissions` 会绕过 hooks 与 `canUseTool`）。

`purpose` 是必填的自然语言说明，只进审计日志 —— 让「模型为什么跑这条 SQL」在事后可读。

### 第 2 层 · SQL 校验（纯函数，可完整单测）

`sql-guard.js`，`run_query` 执行前必过。**白名单式**，不是黑名单式：

1. **单语句**：按分号切分（跳过字符串字面量与注释内的分号），多于一条即拒。
2. **必须以 `SELECT` 或 `WITH` 开头**（剥掉前导注释与空白后判定）。
3. **语句类型黑名单兜底**：`INSERT|UPDATE|DELETE|REPLACE|MERGE|TRUNCATE|DROP|ALTER|CREATE|RENAME|GRANT|REVOKE|SET|LOCK|CALL|HANDLER|LOAD|PREPARE|EXECUTE` 作为独立词出现即拒（第 2 条已经挡住绝大多数，这条防 `WITH x AS (...) DELETE ...` 这类构造）。
4. **文件与系统函数**：`INTO OUTFILE` / `INTO DUMPFILE` / `LOAD_FILE(` / `sys_exec` / `BENCHMARK(` / `SLEEP(` 一律拒。
5. **字面量与注释先屏蔽再判**：`SELECT ';'`、`WHERE note='DROP TABLE x'`、`` FROM `update_log` `` 都是合法查询，不屏蔽就会误杀。屏蔽用等长空格替换以保住位置信息。
6. **MySQL 版本注释 `/*!…*/` 一律拒**：解析器当注释跳过、MySQL 当代码执行，这个不对称是静态检查最经典的绕过点。正经分析查询用不到它。
7. **残缺输入拒**：未闭合的引号或块注释。

> 校验器**只在明确认识的形状上放行**。看不懂就拒 —— 拒绝的代价是模型换个写法，放行的代价可能是不可逆的。

**行数上限不靠改写 SQL。** 原设计是「顶层无 LIMIT 就自动追加」，实施时否决了：要正确识别「顶层」LIMIT 得处理 CTE、UNION、子查询里的 LIMIT，而包一层 `SELECT * FROM (…) t LIMIT n` 会在重名列和 CTE 上出错。改为**驱动层流式读取、到 `MAX_ROWS` 即停**（见第 3 层）—— 是硬保证，且零解析风险。扫描成本由 `MAX_EXECUTION_TIME` 兜住。

### 第 3 层 · 连接与会话（执行期）

**复用现有 Python + pymysql，不引入 Node 侧 MySQL 驱动**（决策见 §6.1）。实测前提（pymysql 1.4.6）：

- **多语句默认就是关的**：`pymysql.connect` 的 `client_flag` 默认 `0`，未置 `CLIENT.MULTI_STATEMENTS`(65536)。语句堆叠的驱动层防线白送，与第 2 层的单语句校验互为冗余 —— 两道都要有。
- **`SSDictCursor` 流式游标**可用：`fetchmany(MAX_ROWS + 1)` 取到 N+1 行即判定被截断，不把整个结果集拉进内存。
- `SET SESSION TRANSACTION READ ONLY` + `SET SESSION MAX_EXECUTION_TIME=<QUERY_TIMEOUT_MS>`（后者 `tracking_report.py:145` 已在用，照搬）。
- 单元格文本截断 + 整体结果字节上限（防一次 `SELECT` 把 Agent 上下文撑爆）。
- **截断必须在回复里明说** —— 静默截断会让人以为那就是全部。
- 整轮 Agent 有总时长预算与总查询次数上限。

### 第 4 层 · 审计（不设身份门禁）

**已拍板：保持 `permission:'any'` 全员可用，不加名单。** 依据是真实用量 —— 一两个人使用，1~2 周一次。为这个频次建一套名单管理（设置页表单、增删改、迁移）不划算。

但这个决定有一个**必须记住的连带后果**：

> 没有身份门禁，第 3.1 节的 PII 黑名单就从「缓解措施」变成了**唯一的隐私边界**。任何能给机器人发消息的人，能查到的就是黑名单之外的全部数据。

所以：

- **PII 黑名单默认保持开启**，且不提供「一句话关掉」的用户入口（要关只能改配置文件，让这个动作是有意识的）。
- **审计日志的重要性相应上升** —— 没有事前门禁，事后可追溯就是唯一手段。`store/sql-audit.js`（JSONL 追加写），每条记 `{ time, userId, userName, question, sql, purpose, rows, ms, ok, error }`。**每一条 SQL 都要落盘，包括被校验拒绝的**（记 `ok:false` + 拒绝原因）—— 被拒记录恰恰是发现「有人在试探边界」的信号。
- 沿用 `throttle.js` 的速率与并发保护，上限按新形态调整（多轮 Agent 比单次报告贵得多）。低频用量下限流几乎不会触发，它防的是异常情况。

> 若日后使用面扩大（比如开放给整个运营组），应重新评估这一条 —— 决策依据是「就一两个人用」，前提变了结论就要变。

### 3.1 PII

「任意只读查询」在语义上包含 `SELECT phone FROM users`。默认策略：

- **表/列黑名单**（可配）：命中即拒，默认收常见 PII 列名（`phone`/`mobile`/`id_card`/`idcard`/`email`/`address`/`real_name`/`bank_card` 等）与敏感表名。
- **提示词层**要求优先出聚合结论而非原始行。
- 黑名单**补不全**（新加个表就多个洞），所以它是缓解不是边界；真正的边界还是 §2.2 的 DB 授权 + §4 的名单。

> 这一条我按「默认从严」实现。若你希望名单内的人不受列限制，把黑名单配空即可 —— 但那时审计日志就是唯一的事后手段。

---

## 4. 交互形态

### 4.1 触发

保留现有前缀 `帮我统计埋点:`（老用户习惯不破），新增 `帮我查数据:` 走自由形。两者都进新管线；前者在提示词里额外注入埋点索引（`dict.js` 的快照）作为先验。

### 4.2 流程

```
前缀 match → 身份门禁 → throttle
  → Agent 起跑（工具集 = list_tables / describe_table / run_query）
      模型自行：探 schema → 试查 → 看结果 → 修正 → 汇总
  → 产出结构化结论 { summary, tables[], notes[] }
  → 飞书先发文字摘要；结果超过阈值再附 HTML/CSV
```

多轮探索是这套方案的价值所在 —— 模型看得到 schema 和中间结果，才能回答「上周新增用户里有多少下单了」这种需要拼表的问题。代价是比单次调用贵，靠 §3 的预算上限兜住。

### 4.3 失败要说人话

沿用 `logic.js#buildFailureReply` 的分类回话思路（那里有正例：把「超时」说成「没听懂」会把用户引进死路）。新增的失败类型至少要分：`不在名单` / `限流` / `schema 里找不到相关表` / `查询被安全策略拒绝` / `查询超时` / `额度耗尽`。

---

## 5. 与现有实现的关系

| 现有文件 | 处置 |
|---|---|
| `tracking_report.py` | **保留不动**。它渲染的 HTML 报告（折线图 + KPI + 明细表）是成品，自由形路径短期内产不出同等质量的图表 |
| `logic.js` 的召回/校验/文案纯函数 | 保留，自由形路径复用 `buildFailureReply` 与摘要文案 |
| `understand.js` 两阶段 LLM | 保留给 `帮我统计埋点:` 老路径 |
| `dict.js` 埋点索引 | 复用，作为自由形路径的先验注入提示词 |
| `throttle.js` | 复用，调参 |

**不是替换，是新增一条并行路径。** 老路径处理「标准埋点报表」这个高频场景（有精美图表），新路径处理长尾自由问题。

---

## 6. 文件结构

```
src/capabilities/
  sql-guard.js            【已完成】SQL 校验纯函数（白名单式，49 条单测）
  sql-guard.test.js       【已完成】
  llm-sql-agent.js        【新】只读 SQL Agent 骨架（工具集收窄到三个 SQL 工具）
src/plugins/tracking-stats/
  sql_exec.py             【新】单条只读查询执行器（stdin JSON → stdout JSON）
  freeform.js             【新】自由形路径编排（Agent → 成文）
  feature.js              【改】前缀分派：埋点老路径 / 自由形新路径
src/store/
  sql-audit.js            【新】SQL 审计日志（JSONL 追加写）
scripts/
  check-tracking-db.mjs   【新】连通性 + 权限自检（含 SHOW GRANTS）
```

不再需要 `src/integrations/mysql-readonly.js`（那是 `mysql2` 方案的产物）；DB 出口仍是 Python 侧，Node 经 `integrations/shell.js` 调用。
`src/shared/trusted-ids.js` 也不动（已定不加身份门禁）。

分层：`sql-guard` 是零依赖纯函数叶子；`mysql-readonly` 属 integrations（唯一 DB 出口）；`llm-sql-agent` 属 capabilities（无业务语义）；`freeform.js` 属插件（业务编排）。符合 `entrypoints → app → features/plugins → capabilities → integrations/store → shared`。

### 6.1 依赖：零新增（曾错误地要求 `mysql2`）

**结论：复用现有 Python + pymysql，不加任何依赖。**

初版 spec 要求引入 `mysql2`，理由是「Agent 一轮要跑多条查询，每条 spawn 一个 Python 进程（冷启 + 连接 ~1s）不可接受」。**这个论据在本功能的真实用量下不成立** —— 一两个人、1~2 周一次；一轮 Agent 约 5~15 条查询，进程开销共十几秒，而**单次 LLM 往返本身就 8~17 秒**（`slot-filler.js` 那次实测），量级差一个数量级。拿高频场景的性能顾虑套低频功能，是错误的取舍。

复用 Python 反而严格更优：

| | Python + pymysql | mysql2 |
|---|---|---|
| 新增依赖 | 0 | 1 |
| 多语句防线 | **默认关闭**（`client_flag=0`，实测） | 要显式设 `multipleStatements:false` |
| 行数截断 | `SSDictCursor` + `fetchmany(N+1)` | 需自己写流式 + destroy |
| 连接配置 / 跳板环境 | 复用 `tracking_report.py` 那套已跑通的 | 另起一套，跳板前提要重新验证 |
| 会话加固 | `prepare_session` 已有，照搬 | 重写 |

代价只有每条查询约 1 秒的进程冷启，在本功能的频次下不可感知。

实现：新增 `src/plugins/tracking-stats/sql_exec.py` —— 收 stdin 上的 JSON `{sql, maxRows}`，回 stdout 上的 JSON `{columns, rows, truncated, ms}`；连接与会话加固复用 `tracking_report.py` 的 `db_config()` / `prepare_session()`。Node 侧经 `integrations/shell.js#runScript` 调用（已有超时、杀进程树、UTF-8 解码兜底）。

---

## 7. 测试闸

1. **写操作一律拒**：`INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT` 各一条，含大小写混写、前导注释、`/*! */` 版本注释藏关键字、`WITH x AS (...) DELETE` 构造。
2. **语句堆叠拒**：`SELECT 1; DROP TABLE t`，以及分号藏在字符串字面量里的合法查询（`SELECT ';'`）**必须放行**（防误伤）。
3. **文件函数拒**：`INTO OUTFILE` / `LOAD_FILE(`。
4. **强制 LIMIT**：无 LIMIT 自动追加；超上限被改写；已有合规 LIMIT 不动；子查询里的 LIMIT 不误判为顶层。
5. **工具面**：Agent 配置里 `disallowedTools` 含 `'*'`，`canUseTool` 对 `Read`/`Bash`/`Write` 一律返回拒绝 —— 用替身断言，不起真 Agent。
6. **PII 黑名单**：命中列名/表名即拒，错误文案说明是策略拒绝而非查询错误。
7. **身份门禁**：不在名单的用户拿到明确拒绝，且**不泄露功能存在性之外的信息**（不回显 schema）。
8. **审计完整性**：执行成功、执行失败、校验拒绝三种情况都落盘一条。
9. **结果截断**：超 `MAX_ROWS` 截断且在回复里标明「已截断」（静默截断会让人误以为那就是全部）。
10. 全量 `npm test` 保持全绿（当前基线 2384 passed / 0 failed）。

---

## 8. 已拍板的口径

| 口径 | 取值 | 依据 |
|---|---|---|
| 身份门禁 | **不加，保持全员可用** | 一两个人用、1~2 周一次，建名单不划算（维护者拍板）。连带后果见 §3 第 4 层 |
| PII | **默认列/表黑名单，从严；无一键关闭入口** | 没有身份门禁后，它是唯一的隐私边界 |
| 自由度形态 | **只读 Agent + SQL 工具（多轮）** | 「任意只读统计」枚举不完，扩 DSL 到不了 |
| DB 驱动 | **复用 Python + pymysql，零新增依赖** | 见 §6.1（初版要求 `mysql2` 是错的） |
| 隧道 | **应用不实现，只连 `TRACKING_DB_HOST:PORT`** | 见 §2.2 |

---

## 9. 不在本次范围内

- 自由形路径的图表渲染（先出文字摘要 + 表格；`tracking_report.py` 的精美图表仍归老路径）
- 查询结果缓存 / 物化
- 跨库查询（只连 `TRACKING_DB_NAME` 那一个库）
- 写操作的任何形式（永久不在范围内）

# `src/shared` · 模块地图

## 模块定位

全项目的**共享基础设施层**：env、日志、落盘目录、飞书门面文案/卡片、门禁，以及若干零依赖纯函数。判断分层归属时要注意这里其实住着**两类**文件——

- **零依赖叶子**：`app-paths` / `load-env` / `dir-slug` / `mention` / `bot-scope` / `card-actions` / `card-confirm` / `claude-md` / `pending-supplement` / `provider-ids` / `trusted-ids`，以及只在模块内 import 的 `logger`（→`app-paths`）、`process-guard`（→`logger`）。谁都能 import，不牵扯业务层。
- **单一入口聚合层**：`config` / `messages` / `bot-activity`。它们**刻意反向 import `src/store` 与 `src/integrations`**（`config.js`→`store/settings.js`、`messages.js`→`store/settings.js`+`store/action-configs.js`、`bot-activity.js`→`store/bot-log.js`+`store/settings.js`+`integrations/lark.js`）。这不是分层倒挂的疏漏，而是为了让「读 env / 拼用户可见文案 / 埋点」各自**只有一个出口**：把这类跨层聚合塞进 store 会让存储层反被业务绑死（见 `bot-activity.js` 顶部注释）。

另外，好几个叶子文件是**从插件/入口上移到此以消除真实分层倒挂**的——`dir-slug` 曾在 web 入口里却被 `store` 依赖（store→entrypoints）、`card-actions`/`trusted-ids`/`pending-supplement` 曾住在某个插件里却被别的插件 import（插件互依）。它们的文件头注释都记着这段来历，改动前先读那段注释再动手。

## 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| `app-paths.js` | 可写目录解析（`appDataDir`/`appDataPath`/`isPackaged`），全项目唯一来源；**调用时**读 `APP_DATA_DIR` | 无 |
| `load-env.js` | 启动期 `.env` 兜底加载，必须早于任何业务模块求值；只兜底不夺权 | 无 |
| `config.js` | 集中读 env，全项目唯一 env 入口；`config` 为模块求值时固化的字面量 | →`store/settings.js` |
| `logger.js` | 统一日志（文件 + 控制台镜像），永不抛；`logSpan` 包裹异步、`preview` 截断 | →`app-paths.js` |
| `process-guard.js` | 进程级兜底 `uncaughtException`/`unhandledRejection` + 同指纹节流 | →`logger.js` |
| `bot-activity.js` | 埋点唯一入口：补全 `botName`/`userName` 后落盘，永不抛 | →`store/bot-log`,`store/settings`,`integrations/lark`,`logger` |
| `messages.js` | 飞书门面文案注册表 + welcome 文本/卡片；每次回复读盘取覆盖值 | →`store/settings`,`store/action-configs` |
| `card-actions.js` | 卡片回调 `kind`→handler 注册表（**只给机制，实现由插件注册**） | 无 |
| `card-confirm.js` | 确认/信息卡片构造 + 回调解析（`parseCardAction`）+ 确认/取消态更新 | 无 |
| `bot-scope.js` | Claude 调用注入工程边界/persona 的 system prompt 追加段（纯函数） | 无 |
| `mention.js` | 群聊 @ 前缀（纯函数，仅群聊生效，open_id 白名单校验） | 无 |
| `pending-supplement.js` | 「等待补充内容」内存瞬态（arm/peek/take）+ 文本前缀兜底 | 无（内存 Map） |
| `trusted-ids.js` | 可信提交人/操作人名单判定（`resolveTrustedOpenIds`/`isTrustedSubmitter`/`canOperateRelay`，纯函数） | 无 |
| `dir-slug.js` | 工程目录 → 稳定 slug（纯函数，供 store 按工程归属算文件名） | 无 |
| `claude-md.js` | `CLAUDE.md` 的 @ 引用行幂等挂接（**只追加不改写**） | 无（fs） |
| `provider-ids.js` | `DEFAULT_PROVIDER_ID` 常量（缺省 provider 归属，单点定义） | 无 |
| `*.test.js` | 各文件对应的 `node:test` 单测（`npm test` 覆盖） | — |

## 关键流程

### 1. 启动自举（顺序敏感）
入口顶部**先** `loadAppEnv()`（确证调用点 `src/entrypoints/console/index.js:11`；`load-env.js` 头注释要求 web/feishu 入口同样先调再用动态 import 拉业务模块）→ 内部 `process.loadEnvFile` 只兜底填空、**已存在的键不覆盖**（Tauri 注入的 `APP_DATA_DIR`/`PORT`、`--env-file`、CI 变量一律赢）→ 之后 `config.js` 在**模块求值**时读 `process.env` 固化成 `config`。所以顺序反了（config 先被求值）env 就静默丢了；这也是「入口里写一条 `loadAppEnv()` 语句来不及、必须先调再动态 import」的原因。`app-paths.js` 反之在**调用时**读 `APP_DATA_DIR`，无此顺序约束。两个入口另各自装最后兜底 `installProcessGuards()`（`server.js:15`、`feishu/index.js:25`，幂等）。

### 2. 落盘与可观测
所有落盘路径统一走 `app-paths.appDataPath()`（打包态 → `APP_DATA_DIR` 子目录，开发态 → 仓库根）。`logger.js` 的 `LOG_DIR = appDataPath('logs')` 是这条链的直接消费者。其上：`process-guard` 捕获全局异常 → `describeReason` 提指纹 → `throttleDecide` 60s 窗口节流（防某个定时器每轮抛一次把日志撑爆）→ `logger.error`；`bot-activity` 埋点失败降级为 `logger.warn`。两者都**绝不抛**——它们在用户消息处理路径上。

### 3. 卡片回调分发（跨插件注册表）
- **出卡**：`messages.buildWelcomeCard`（按钮 `value.kind='quick-action'`）/ `card-confirm.createConfirmCard` 造卡。
- **注册**：各插件在模块加载时 `registerCardKindHandler(kind, handler)`——`action-runner` 的 `quick-action`（`card-action.js:101`）、`feedback` 的 `review-verdict`（`feedback/index.js:168`）、`feishu-relay` 的会话卡（`index.js:121`）、`task-notify` 的任务卡（`task-notify.js:159`）。
- **分发**：`src/entrypoints/feishu/index.js:61` 收到回调按 `value.kind` 调 `getCardKindHandler` 找处理器；确认类卡片则用 `card-confirm.parseCardAction` 解析 confirm/cancel，再 `confirmed()/cancelled()` 更新卡片。
- 停用某插件 → 对应 kind 自然无处理器，与「停用插件不载入业务代码」一致。

### 4. 埋点
消息处理路径调 `recordBotActivity` → `getUserName`（`integrations/lark` 解析姓名）+ `botNameOf`（`store/settings` 查机器人名）补全展示快照 → `preview` 截断 detail（60 字）→ `appendBotLog`（`store/bot-log`）落盘。姓名解析失败返回 null 不阻断写入。

### 5. 补充内容瞬态（跨插件共用）
用户点卡片「补充内容」→ 插件 `armSupplement(openId, {onText})` 登记闭包（`feishu-relay/index.js:110`、`task-notify.js:110`，同 openId 单槽、后来者覆盖）→ dispatch 用 `peekSupplement` 探测是否在等（`feishu-relay/index.js:128`）→ 命中后 `takeSupplement` **一次性**取走执行（`feishu-relay/index.js:137`，取晚了下一句闲聊会被当补充）；用户若又打一遍「补充内容 xxx」由 `matchSupplementText` 剥前缀。执行器以闭包传入，故 shared 对 conv/task 一无所知——这正是它能同住内核而不引入插件互依的关键。

### 6. 门禁
`trusted-ids` 的三个纯函数被**会话域（feishu-relay）与任务域（team-tools）共用**判定「谁能提交/操作」：`resolveTrustedOpenIds` 从「我的飞书 open_id」解析出唯一可信人，`isTrustedSubmitter`/`canOperateRelay` 做命中判定，名单一律 `Array.isArray` 兜底防配置读坏时在 `.includes` 上打穿门禁。

## 常见改动入口

- 要**新增一个落盘目录**（缓存、导出文件…）就调 `app-paths.js` 的 `appDataPath('xxx')`，别再自己拼 `__dirname`——打包后必写不进去且被 try/catch 静默吞掉。
- 要**加/改环境变量**就改 `config.js`（唯一 env 入口）；注意 `config` 是模块求值时固化的字面量，需运行时才确定的项要写成函数（参考 `scriptsDirFor`）。
- 要**改 `.env` 查找优先级或启动加载行为**就改 `load-env.js` 的 `envFileCandidates`/`loadAppEnv`。
- 要**改机器人对用户说的话**（即时应答、welcome、处理中）就改 `messages.js` 的 `REGISTRY`/`buildWelcomeText`/`buildWelcomeCard`；新增可配 key 记得加进 `BOT_MESSAGE_KEYS`。
- 要**新增一种卡片按钮回调类型**：在**插件里**调 `registerCardKindHandler(kind, handler)`，**不要**写进 `card-actions.js`（它只提供机制，写实现会造成 `shared→plugins` 倒挂）。
- 要**做通用确认卡片**（危险操作二次确认等）就用 `card-confirm.js` 的 `createConfirmCard` + `parseCardAction`。
- 要**改 Claude 调用的工程边界/persona 注入**就改 `bot-scope.js`。
- 要**加/改埋点字段**就改 `bot-activity.js`（唯一入口）；对应存储结构在 `store/bot-log.js`。
- 要**改日志格式或加 span 包裹**就改 `logger.js`（`logSpan`/`preview`）；要**改全局崩溃兜底或节流窗口**就改 `process-guard.js`。
- 要**改「谁是可信提交人/谁能操作卡片」**就改 `trusted-ids.js`（纯函数，多插件共用，勿在插件里各写一份）。
- 要**加「等用户下一句话」的交互**就用 `pending-supplement.js` 的 `armSupplement`/`takeSupplement`。
- 要**改按工程归属的存储文件名规则**就改 `dir-slug.js`；要**改群聊 @ 行为**改 `mention.js`。
- 要**改默认 provider 归属**就改 `provider-ids.js` 的 `DEFAULT_PROVIDER_ID`（单点，勿散字面量；注意与 `providers/claude-agent.js` 里 provider 自身的 id 是两个概念）。
- 要**幂等挂 `CLAUDE.md` 的 @ 引用行**（记忆库/优化汇总）就用 `claude-md.js` 的 `ensureImport`。

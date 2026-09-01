# src/plugins · 模块地图

> 业务插件层。内核 `dispatch` 不再硬编码任何业务 feature；需求收集、自动开发、埋点统计等「对话功能」全部以**插件**形式挂载，由本模块动态装配进 dispatch 的 feature 列表。`settings.plugins` 可逐个启停，**停用的插件不 import**（内核进程不载入其业务代码，这是「内核更纯」的实质）。
>
> 加功能 = 在此加插件目录 + 在 `index.js` 的 `PLUGIN_MANIFEST` 登记，不改 dispatch / 入口 / store（约定见根 `CLAUDE.md`、`docs/ARCHITECTURE.md`）。

## 文件清单

### 装配层（模块根）
- `index.js` — 插件清单 `PLUGIN_MANIFEST` + 装配。`loadEnabledPluginFeatures` 逐个 `getPluginEnabled` 判断后**动态 import** 启用插件、收集其 `features` 条目；`assembleFeatures` 把 core + 插件条目按 `order` 稳定排序后摊平成 feature 数组。**本模块唯一对外入口**。
- `feishu-card-actions-example.js` — 飞书卡片交互示例代码（`confirmGitOperation` 等），不被装配引用，仅供参考。
- `index.test.js` — 装配层单测。

### team-tools/ —— 团队工具插件（一个插件 = 6 个 feature + 一组共享领域模块）
- `team-tools/index.js` — 插件装配：task-triage(10)/bug-patrol(12)/create-session(13)/status-report(14)/feedback(40)/project-qa(90) 六个 feature 按 order 挂载。
- `team-tools/feedback/index.js` — feature「需求/故障收集」（`intents:[bug,feature,material]`）：建 Task、按托管档位/身份分流到评审或直通自动开发；含「坚持修改/算了」评审否定应答（文本 + 卡片两条路径）。`logic.js` 为其纯函数（可挽回任务判定、评审否定卡片构造/解析）。
- `team-tools/review/index.js` — feedback/bug-patrol 调用的**评审门**（非 feature）：`reviewTask` 只读查证打分，`recordOverride` 记人工覆盖判例。`logic.js` 存判决矩阵 `decideVerdict`、`buildReviewPrompt` 等纯函数。
- `team-tools/auto-dev/index.js` — **自动开发管线**：`requestAutoDevelop` 置任务 `queued`（任意进程可调），泵 `startAutoDevPump` **仅 web 进程**常驻，在常驻 auto 工作区建任务分支改码、提交、置 done。配套 `git.js`（git 封装，参数拼装抽纯函数）、`logic.js`（分支名/提交信息纯函数）、`compile.js`（DEV 编译二维码适配）。
- `team-tools/task-triage/index.js` — feature「owner 待办分诊」（触发词进入，owner 专属）：交互式逐条呈现已分析任务，决策后入自动开发/后台串行开发队列。`logic.js` 分组/排序/意图解析纯函数。
- `team-tools/bug-patrol/index.js` — feature「BUG 巡检」（`\10001`，可信提交人专属）：等多维表格 → Haiku 字段映射 → 筛「我的待处理 BUG」→ 逐条评审 → 确认者写表 + 建任务进自动开发。`logic.js` 链接解析/字段校验/文案纯函数；`hasPatrolPending` 供飞书入口绕过云文档摄取。
- `team-tools/status-report/index.js` — feature「当前任务清单」（`\10002`，可信提交人专属）：纯本地读盘汇总运行中会话 + 活跃任务 + 待合并。`logic.js` 分组/状态标签/格式化纯函数。
- `team-tools/create-session/index.js` — feature「新建会话」（`\10003`，可信提交人专属）：跨进程 POST web 路由建会话，回前 8 位 shortId。`logic.js` 触发文案定义。
- `team-tools/project-qa/index.js` — feature「项目问答」（`intents:[question]`）：只读起 Claude 查代码回答，带同用户串行闸/3 分钟超时/答案截断三道保护。
- `team-tools/task-ops.js` — **共享领域模块**（非 feature）：`analyze`（只读分析）/`develop`（实际改码）/`attachMaterialToRecentTask`。供 feedback/task-triage/auto-dev/web 入口共用。
- `team-tools/task-actions.js` — **共享领域模块**：任务分支 `mergeTaskById`/`discardTaskById` 及 `isAwaitingMerge`/`isDiscardable` 谓词。web 路由与飞书任务卡片共用一套编排。
- `team-tools/task-notify.js`（+ `task-notify.logic.js`）— 任务完成 → 飞书私聊卡片（发给管理员本人），处理「合并/补充/放弃」卡片回调；`.logic.js` 为卡片构造/回调解析纯函数。
- `team-tools/material-pool.js` — 材料暂存池（先发文件后发描述的归并），内存态 + TTL 10 分钟 + 单 key 上限。
- `team-tools/trusted-trigger.js` — 可信提交人指令共用纯函数 `matchesExactTrigger`（严格全等匹配）+ 再导出内核 `isTrustedSubmitter`。
- `team-tools/**/*.test.js` — 对应单测（含 `auto-dev/git.test.js` 真实 git 仓库测试、`task-actions.test.js` 编排测试）。

### action-runner/ —— 配置驱动的通用动作执行
- `action-runner/index.js` — 插件装配（order 30）；副作用 import `card-action.js` 以注册卡片回调。
- `action-runner/feature/index.js` — feature（`intents:[action]`）：槽位填充状态机（提取变量 → 追问缺失 → 执行脚本），单用户单条 `pendingState`，含 TTL 超时与「一轮无进展即 PASS 归还」。
- `action-runner/feature/slot-filler.js` — 从消息提取动作变量、识别缺失必填项。
- `action-runner/feature/script-runner.js` — 组装脚本参数、脱敏敏感字段、执行并记日志。
- `action-runner/feature/permission.js` — `canRunAction` 逐动作权限判定纯函数。
- `action-runner/card-action.js` — `quick-action` 卡片按钮回调 → 构造虚拟 ctx 直接调 `feature/index.js#handle`（绕过意图识别）。
- `action-runner/**/*.test.js` — 对应单测。

### feishu-relay/ —— 飞书 → web 会话回控
- `feishu-relay/index.js` — feature（order 16）：把飞书侧「补充内容/结束会话」（等待态卡片 + 文本兜底 + 会话 ID 路由三条路径）跨进程 POST 注入 web 执行台会话；注册会话卡片回调。
- `feishu-relay/logic.js` — 卡片/文本解析纯函数（`parseConvCardAction`/`matchSessionText`/`isEndSessionText`/`CONV_CARD_KIND`）。

### tracking-stats/ —— 埋点统计
- `tracking-stats/index.js` — 插件装配（order 16）。
- `tracking-stats/feature.js` — feature（`帮我统计埋点:` 前缀 match）：两阶段 LLM（理解 → 精选）→ 纯函数召回/校验 → 调 Python 脚本查生产只读库 → HTML 报告 + 摘要送达。
- `tracking-stats/logic.js` — 触发解析/召回/区间收敛/QuerySpec 校验/摘要文案等纯函数集合。
- `tracking-stats/understand.js` — 两阶段 LLM 调用 `understandRequest`/`pickTargets`/`beijingNow`。
- `tracking-stats/dict.js` — 埋点索引快照加载与缓存。
- `tracking-stats/throttle.js` — 速率/并发限流（本功能无身份门禁，靠它防滥用）。
- `tracking-stats/tracking_report.py` — 查库 + 渲染 HTML 的 Python 脚本（与 Node 侧共享 QuerySpec 契约，故与 `feature.js` 同目录、不放数据目录）。
- `tracking-stats/*.test.js` — 对应单测。

## 关键流程

### A. 装配 → 路由（谁在什么时候被调）
启动时 `src/features/index.js`（本模块外）调 `index.js#loadEnabledPluginFeatures()`：按 `PLUGIN_MANIFEST` 顺序，对每个**启用**插件动态 `import()` 其 `default.features`，单个失败隔离仅告警；再 `assembleFeatures(coreEntries, pluginEntries)` 把 core（含 claude-exec，order 20）与插件条目**按 order 全局稳定排序**摊平。排序结果就是 `src/app/dispatch.js` 遍历的 `features` 列表。

每个 feature 是一个满足 **Feature 契约**的对象：`{ name, permission:'any'|'owner', intents:[], hasPending?(ctx), match?(ctx), handle(ctx, intentResult) }`。dispatch 四步顺序短路（详见 `src/app/CLAUDE.md`）：`hasPending`（可返回 `PASS` 归还消息）→ `match`（owner/触发词兜底）→ `permission + intents`（意图匹配）→ 帮助。**order 数字即优先级**——本模块几乎每个 `index.js` 文件头都在解释自己的 order 为何必须落在某区间：`< 20` 的（task-triage 10、bug-patrol 12、create-session 13、status-report 14、feishu-relay 16、tracking-stats 16）都是为了抢在内核 claude-exec(20)「owner 全接」之前接走 owner/可信人的特定消息，否则会被吞掉。

### B. 需求/故障主处理链（本模块中枢，数据流跨最多文件）
入口 `team-tools/feedback/index.js#handle`：
1. 建 `Task`（`store/tasks.js`）；即时应答刻意不 await（发送失败不该让需求静默蒸发）。
2. 分流（读 `getActiveBot().autonomy` 托管档位 + 身份）：
   - **owner / 可信提交人** → 直接 `auto-dev/index.js#requestAutoDevelop`（跳过评审）。
   - **轻度托管** → `task-ops.js#analyze`（只读分析）后补一句闭环回复，等 owner 在别处确认。
   - **中度/完全托管** → `runReviewFlow` 调 `review/index.js#reviewTask` 打分 + `logic.js#decideVerdict` 判决：`reject/ask` 发「坚持修改/算了」卡片（`feedback/logic.js` 构造）；`fix`（BUG）或用户坚持 → `requestAutoDevelop`；`plan`（需求）→ `analyze`，完全托管再 `requestAutoDevelop`。
3. `requestAutoDevelop` 只把任务置 `queued`（`store/tasks.js`，跨进程锁）。**执行泵 `startAutoDevPump` 仅在 web 进程常驻**（feishu 进程只标状态，从根上避免双进程争同一 git 工作区；状态落盘天然获得崩溃/重启续跑）。
4. 泵 `tick → runOne`：确保常驻 auto 工作区（`git.js#ensureAutoWorktree`）→ 自愈残留 → `checkout -B <taskBranch>` → `task-ops.js#develop`（在 auto 工作区 bypassPermissions 改码，`deferStatus`）→ `git.js#commitAll` 校验（无改动即失败）→ 置 `done` → `task-notify.js#notifyTaskDone` 发管理员私聊卡片 → `replySource` 回来源会话。
5. 管理员在飞书任务卡片点「合并/放弃」→ `task-notify.js#onTaskCardAction` → `task-actions.js#mergeTaskById/discardTaskById`（与 web 路由同一套编排，谓词 `isAwaitingMerge/isDiscardable` 共用，防两条入口状态机分叉）。

另有两条入口汇入同一后段：`task-triage/index.js`（owner 主动分诊，走 `task-ops`/`auto-dev`）、`bug-patrol/index.js`（多维表格 → 逐条 `reviewTask` → 建 Task → `requestAutoDevelop`）。**它们彼此不互相 import feature；跨 feature 协作一律经共享领域模块（task-ops/task-actions/auto-dev 的导出函数）与 `store`。**

### C. 卡片回调自注册 + 跨进程直送
feishu 与 web 进程都会加载插件。多个模块在**模块加载时**副作用调用 `shared/card-actions.js#registerCardKindHandler` 注册卡片回调 kind：`quick-action`（`action-runner/card-action.js`）、`review-verdict`（`feedback/index.js`）、任务卡（`task-notify.js`）、会话卡（`feishu-relay/index.js`）。**插件停用即不加载 → 回调自然缺席**，这是「停用插件不载入业务代码」的落地。

会话注入/新建会话需操作 web 进程内存里的 run 注册表，故 `feishu-relay/index.js` 与 `create-session/index.js` 都用 `fetch('http://127.0.0.1:${config.web.port}/...')` 跨进程直送（3s 超时、无 Origin 头放行），而非直接改状态。

### D. action-runner 槽位填充状态机
`feature/index.js#handle`：意图 `action`（带 `intentResult.actionId`）→ `permission.js#canRunAction` 权限闸（进槽位填充**之前**拦，避免泄露动作存在性）→ `slot-filler.js#extractVars` 提取变量、`pickMissingVars` 找缺失 → 缺则写 `pendingState` 追问（`hasPending` 令 dispatch 下一条直接劫持该用户）→ 齐则 `script-runner.js#runAction` 执行。防卡死两招：`PENDING_TTL_MS` 超时、追问一轮无进展即清态并返回 `PASS` 交还 dispatch。卡片按钮入口 `card-action.js` 构造虚拟 ctx 复用同一 `handle`。

### E. tracking-stats 两阶段
`feature.js#handle`：前缀 match → `understand.js#understandRequest`（阶段 A 理解时间/目标/检索词）→ `logic.js#recallCandidates` 纯函数召回 → `understand.js#pickTargets`（阶段 B 精选）→ `logic.js#validateSelection` 硬校验（剔除模型编造的标识）→ 写 spec 临时文件 → 跑 `tracking_report.py` 查生产库渲染 HTML → 先发摘要后发附件。无身份门禁，`throttle.js` 兜速率/并发。

## 常见改动入口

- **要新增一个业务对话功能** → 新建 `<新插件>/index.js`（default 导出 `{ id, features:[{order, feature}] }`）+ 在 `index.js` 的 `PLUGIN_MANIFEST` 登记；若属团队工具范畴，在 `team-tools/` 下加 feature 子目录并在 `team-tools/index.js` 挂 order。不改 dispatch / 入口。
- **要调某功能的路由优先级 / 让它抢在 claude-exec 之前** → 改对应插件 `index.js` 里 feature 的 `order`（认准 `< 20` 才能压过 claude-exec；改前先读该文件头对 order 的约束说明）。
- **要改需求/故障从收集到开发的分流逻辑**（托管档位、直通条件、即时应答、评审否定应答）→ 改 `team-tools/feedback/index.js`。
- **要改 AI 评审的判决口径 / 阈值** → 改 `team-tools/review/logic.js#decideVerdict`（纯判决矩阵）；改评审提示词或只读闸 → `review/index.js` + `logic.js#buildReviewPrompt`。
- **要改自动开发的工作区/分支/提交/重启恢复策略** → 改 `team-tools/auto-dev/index.js`（泵与 runOne 流程）；git 参数拼装 → `auto-dev/git.js`；分支命名/提交信息 → `auto-dev/logic.js`。
- **要改「只读分析」或「实际改码」的提示词 / 权限模式** → 改 `team-tools/task-ops.js`（`analyze`/`develop`，被多入口共用，一处改全局生效）。
- **要改合并/放弃的编排或谓词** → 改 `team-tools/task-actions.js`（web 与飞书卡片共用，勿在任一入口另写一份条件）。
- **要改可信提交人指令（\10001/\10002/\10003）的触发文案** → 改对应 feature 的 `logic.js` 里 `*_TRIGGERS`；触发匹配规则本身 → `team-tools/trusted-trigger.js`（严格全等，勿改成模糊/前缀/LLM 识别）。
- **要加/改一个飞书卡片按钮回调** → 在对应插件模块加载处 `registerCardKindHandler(kind, handler)`（参照 `task-notify.js` / `feedback/index.js`），**不要写进 `shared/`**（会造成 shared→plugins 分层倒挂，见 `action-runner/card-action.js` 文件头）。
- **要改动作执行（槽位填充/脚本/逐动作权限）** → 分别改 `action-runner/feature/` 下 `index.js`（状态机）、`slot-filler.js`、`script-runner.js`、`permission.js`。
- **要改埋点统计的理解/精选/校验/限流** → 分别改 `tracking-stats/` 下 `understand.js`（两阶段 LLM）、`logic.js`（召回/校验/文案）、`throttle.js`（限流）；改查库或报告渲染 → `tracking_report.py`（注意与 `logic.js` 的 QuerySpec 契约须同版本）。
- **要改飞书补充内容注入 web 会话的路径** → 改 `feishu-relay/index.js`（三条命中路径 + `postInject` 跨进程直送）。

# src/plugins · 模块地图

> 业务插件层。内核 `dispatch` 不再硬编码任何业务 feature；需求收集、自动开发、埋点统计等「对话功能」全部以**插件**形式挂载，由本模块动态装配进 dispatch 的 feature 列表。`settings.plugins` 可逐个启停，**停用的插件不 import**（内核进程不载入其业务代码，这是「内核更纯」的实质）。
>
> 加功能 = 在此加插件目录 + 在 `index.js` 的 `PLUGIN_MANIFEST` 登记，不改 dispatch / 入口 / store（约定见根 `CLAUDE.md`、`docs/ARCHITECTURE.md`）。

## 文件清单

### 装配层（模块根）
- `index.js` — 插件清单 `PLUGIN_MANIFEST` + 装配。`loadEnabledPluginFeatures` 逐个 `getPluginEnabled` 判断后**动态 import** 启用插件、收集其 `features` 条目；`assembleFeatures` 把 core + 插件条目按 `order` 稳定排序后摊平成 feature 数组。**本模块唯一对外入口**。
- `index.test.js` — 装配层单测。

### team-tools/ —— 团队工具插件（一个插件 = 6 个 feature + 一组共享领域模块）
- `team-tools/index.js` — 插件装配：task-triage(10)/bug-patrol(12)/create-session(13)/status-report(14)/feedback(40)/project-qa(90) 六个 feature 按 order 挂载。
- `team-tools/feedback/index.js` — feature「需求/故障收集」（`intents:[bug,feature,material]`）：建 Task、按托管档位/身份分流到评审或直通自动开发；含「坚持修改/算了」评审否定应答（文本 + 卡片两条路径）。`logic.js` 为其纯函数（可挽回任务判定、评审否定卡片构造/解析）。
- `team-tools/review/index.js` — feedback/bug-patrol 调用的**评审门**（非 feature）：`reviewTask` 只读查证打分，`recordOverride` 记人工覆盖判例。`logic.js` 存判决矩阵 `decideVerdict`、`buildReviewPrompt` 等纯函数。
- `team-tools/auto-dev/queue.js` — **入队 API 的零重依赖叶子**：`requestAutoDevelop`（置 `queued`，任意进程可调，幂等）+ `isOverrideStart`（纯谓词）。**只允许依赖 `store/tasks.js`**。要入队一律从这里引，**不要从 `index.js` 引**——那会把 git / 编译 / 飞书回发 / Claude 调用整条执行链拖进调用方，并让 `task-notify` 与执行管线成环（2026-09-04 实测检出过两个环，见该文件头）。
- `team-tools/auto-dev/index.js` — **自动开发管线（执行侧）**：泵 `startAutoDevPump` **仅 web 进程**常驻，在常驻 auto 工作区建任务分支改码、提交、置 done。配套 `git.js`（git 封装，参数拼装抽纯函数）、`logic.js`（分支名/提交信息纯函数）、`compile.js`（DEV 编译二维码适配）。
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
- `action-runner/feature/slot-filler.js` — **编排层**：本地抽 → 还缺必填才调一次 LLM → 合并归一。真正的逻辑在下面四个纯函数模块里。
- `action-runner/feature/var-presets.js` — 内置变量预置（`env` / `phone`）的**零依赖纯数据**。preset 只是默认值，变量显式声明永远赢。
- `action-runner/feature/var-contract.js` — 变量声明 → 有效契约（`resolveVariable` 展开 preset，浅覆盖不深合并）+ 保存期校验（`validateVariable` / `validateActionVariables`）。**抽取器不认识任何变量名**这条纪律由本模块承载。
- `action-runner/feature/local-extract.js` — 本地确定性抽取：词表扫描（长词优先 / **按首尾字符逐端**决定加不加 `\b` / 一律转义 / **不带外层量词**）、正则抽取、两条弃权规则（多值冲突、否定词修饰，**查整条分句、遍历全部命中**）。弃权时返回 `ABSTAIN` 哨兵与「压根没提到」区分开（见下 D-1）。零 LLM、零网络，但**会写日志**（弃权记录是排查「为什么又追问了」的唯一线索，勿删）。
- `action-runner/feature/extract-prompt.js` — 由变量声明自动生成 LLM 抽取提示词（只列本地抽不出的字段）。
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
   - **owner / 可信提交人** → 直接 `auto-dev/queue.js#requestAutoDevelop`（跳过评审）。
   - **轻度托管** → `task-ops.js#analyze`（只读分析）后补一句闭环回复，等 owner 在别处确认。
   - **中度/完全托管** → `runReviewFlow` 调 `review/index.js#reviewTask` 打分 + `logic.js#decideVerdict` 判决：`reject/ask` 发「坚持修改/算了」卡片（`feedback/logic.js` 构造）；`fix`（BUG）或用户坚持 → `requestAutoDevelop`；`plan`（需求）→ `analyze`，完全托管再 `requestAutoDevelop`。
3. `requestAutoDevelop`（`auto-dev/queue.js`）只把任务置 `queued`（`store/tasks.js`，跨进程锁）。**执行泵 `startAutoDevPump` 仅在 web 进程常驻**（feishu 进程只标状态，从根上避免双进程争同一 git 工作区；状态落盘天然获得崩溃/重启续跑）。
4. 泵 `tick → runOne`：确保常驻 auto 工作区（`git.js#ensureAutoWorktree`）→ 自愈残留 → `checkout -B <taskBranch>` → `task-ops.js#develop`（在 auto 工作区 bypassPermissions 改码，`deferStatus`）→ `git.js#commitAll` 校验（无改动即失败）→ 置 `done` → `task-notify.js#notifyTaskDone` 发管理员私聊卡片 → `replySource` 回来源会话。
5. 管理员在飞书任务卡片点「合并/放弃」→ `task-notify.js#onTaskCardAction` → `task-actions.js#mergeTaskById/discardTaskById`（与 web 路由同一套编排，谓词 `isAwaitingMerge/isDiscardable` 共用，防两条入口状态机分叉）。

另有两条入口汇入同一后段：`task-triage/index.js`（owner 主动分诊，走 `task-ops`/`auto-dev`）、`bug-patrol/index.js`（多维表格 → 逐条 `reviewTask` → 建 Task → `requestAutoDevelop`）。**它们彼此不互相 import feature；跨 feature 协作一律经共享领域模块（task-ops/task-actions/auto-dev 的导出函数）与 `store`。**

### C. 卡片回调自注册 + 跨进程直送
feishu 与 web 进程都会加载插件。多个模块在**模块加载时**副作用调用 `shared/card-actions.js#registerCardKindHandler` 注册卡片回调 kind：`quick-action`（`action-runner/card-action.js`）、`review-verdict`（`feedback/index.js`）、任务卡（`task-notify.js`）、会话卡（`feishu-relay/index.js`）。**插件停用即不加载 → 回调自然缺席**，这是「停用插件不载入业务代码」的落地。

会话注入/新建会话需操作 web 进程内存里的 run 注册表，故 `feishu-relay/index.js` 与 `create-session/index.js` 都用 `fetch('http://127.0.0.1:${config.web.port}/...')` 跨进程直送（3s 超时、无 Origin 头放行），而非直接改状态。

### D. action-runner 槽位填充状态机
`feature/index.js#handle`：意图 `action`（带 `intentResult.actionId`）→ `permission.js#canRunAction` 权限闸（进槽位填充**之前**拦，避免泄露动作存在性）→ `slot-filler.js#extractVars` 提取变量、`pickMissingVars` 找缺失 → 缺则写 `pendingState` 追问（`hasPending` 令 dispatch 下一条直接劫持该用户）→ 齐则 `script-runner.js#runAction` 执行。防卡死两招：`PENDING_TTL_MS` 超时、追问一轮无进展即清态并返回 `PASS` 交还 dispatch。卡片按钮入口 `card-action.js` 构造虚拟 ctx 复用同一 `handle`。

`pendingState` 的占位**必须写在发起抽取之前**（抽取那几秒里 `hasPending` 为 false 会让用户的抢答绕过本 feature、被判 `other` 回一张帮助卡）；窗口内的消息进 `inbox` 由 `mergeQueuedAnswers` 并入；抽取期间用户打「取消」则占位消失，恢复后必须检查并放弃执行（破坏性脚本在用户喊停后仍跑起来不可接受）。

### D-1. 变量抽取契约（2026-09-04 改造，`extractVars` 内部）
1. `local-extract.js#localExtract` 按每个变量 `resolveVariable` 后的 `kind` 分派：`enum` 走词表扫描、`pattern` 走正则、都没有则记入 `unresolved`。`unresolved` 每项带 `reason`：`'absent'`（文本里压根没这个字段的候选）/ `'abstained'`（扫到了但拿不准）。
2. **「值不值得调 LLM」与「调了问哪些字段」是两件事**（合成一件会出安全问题）：
   - 触发：必填 + 本地抽不出 + （没有持久化旧值 **或** `reason==='abstained'`）。持久值能顶掉「没提到」的字段（那正是「第二次不用再报手机号」），但**顶不掉「读不准」的** —— 否则「我的号从 138… 换成 139…」会因多值弃权被当成没提到，静默沿用旧号清错人的数据。
   - 载荷：全部必填 `unresolved`，**含被持久值顶掉的**。调用既然发生，边际成本为零，而用户这次说的新值必须有机会覆盖旧值。
   - **全部命中即直接返回，零 LLM**（现有三个动作的变量都落这条快路）。
3. 要调时先经 `opts.onLlmStart` 回调通知调用方（`feature/index.js` 据此才发「请稍等」即时应答 —— 本地命中就不发，否则紧接着「正在执行」像卡了一下），再由 `extract-prompt.js#buildExtractPrompt` 按声明生成提示词，**只列剩下的字段**（省 token，也防模型改写已确定的值）。
4. `normalizeCollected` 统一归一，归一失败的键**删除**（判缺失走追问，绝不把非法值透传给脚本的 argparse）。合并顺序 `持久化 < 本地 < LLM`；最后一道闸：`abstained` 字段若本地与 LLM 都没给出值，**丢弃持久化旧值**改为追问。

**纪律**：抽取器永远不读 `v.name`。改造前按变量名硬编码在三处（`NORMALIZERS`/`regexExtract`/`hasEnv` 分支），变量改个名整套失效而用户无从察觉。新增抽取能力一律加在变量声明上，不要加 `if (name === ...)`。

### E. tracking-stats 两阶段
`feature.js#handle`：前缀 match → `understand.js#understandRequest`（阶段 A 理解时间/目标/检索词）→ `logic.js#recallCandidates` 纯函数召回 → `understand.js#pickTargets`（阶段 B 精选）→ `logic.js#validateSelection` 硬校验（剔除模型编造的标识）→ 写 spec 临时文件 → 跑 `tracking_report.py` 查生产库渲染 HTML → 先发摘要后发附件。无身份门禁，`throttle.js` 兜速率/并发。

## 常见改动入口

- **要新增一个业务对话功能** → 新建 `<新插件>/index.js`（default 导出 `{ id, features:[{order, feature}] }`）+ 在 `index.js` 的 `PLUGIN_MANIFEST` 登记；若属团队工具范畴，在 `team-tools/` 下加 feature 子目录并在 `team-tools/index.js` 挂 order。不改 dispatch / 入口。
- **要调某功能的路由优先级 / 让它抢在 claude-exec 之前** → 改对应插件 `index.js` 里 feature 的 `order`（认准 `< 20` 才能压过 claude-exec；改前先读该文件头对 order 的约束说明）。
- **要改需求/故障从收集到开发的分流逻辑**（托管档位、直通条件、即时应答、评审否定应答）→ 改 `team-tools/feedback/index.js`。
- **要改 AI 评审的判决口径 / 阈值** → 改 `team-tools/review/logic.js#decideVerdict`（纯判决矩阵）；改评审提示词或只读闸 → `review/index.js` + `logic.js#buildReviewPrompt`。
- **要改自动开发的工作区/分支/提交/重启恢复策略** → 改 `team-tools/auto-dev/index.js`（泵与 runOne 流程）；git 参数拼装 → `auto-dev/git.js`；分支命名/提交信息 → `auto-dev/logic.js`。
- **要改入队条件 / 幂等判定 / 覆盖判定** → 改 `team-tools/auto-dev/queue.js`；往那里加东西前先读它的文件头纪律（**只许依赖 `store/tasks.js`**，破了纪律 import 环会原样回来）。
- **要改「只读分析」或「实际改码」的提示词 / 权限模式** → 改 `team-tools/task-ops.js`（`analyze`/`develop`，被多入口共用，一处改全局生效）。
- **要改合并/放弃的编排或谓词** → 改 `team-tools/task-actions.js`（web 与飞书卡片共用，勿在任一入口另写一份条件）。
- **要改可信提交人指令（\10001/\10002/\10003）的触发文案** → 改对应 feature 的 `logic.js` 里 `*_TRIGGERS`；触发匹配规则本身 → `team-tools/trusted-trigger.js`（严格全等，勿改成模糊/前缀/LLM 识别）。
- **要加/改一个飞书卡片按钮回调** → 在对应插件模块加载处 `registerCardKindHandler(kind, handler)`（参照 `task-notify.js` / `feedback/index.js`），**不要写进 `shared/`**（会造成 shared→plugins 分层倒挂，见 `action-runner/card-action.js` 文件头）。
- **要改动作执行（槽位填充/脚本/逐动作权限）** → 分别改 `action-runner/feature/` 下 `index.js`（状态机）、`slot-filler.js`（编排）、`script-runner.js`、`permission.js`。
- **要让某类变量能被本地识别**（不再每次调 LLM）→ **不改代码**：在设置页给该变量填 `合法值 + 别名` 或 `正则`。常见类型可选 `预置`（`var-presets.js` 的 `env`/`phone`）。
- **要加一个新的内置预置** → 改 `action-runner/feature/var-presets.js` 的 `PRESETS`（零依赖纯数据）。⚠️ 改动会立即影响所有引用它的变量（运行时展开，不落盘快照）。
- **要改本地抽取的扫描/弃权规则** → 改 `action-runner/feature/local-extract.js`。新增候选词前先读 `compileScanner` 上方那四条规则，特别是「不带外层量词」—— `intent.js` 的 `CHITCHAT_RE` 曾因此占死事件循环。
- **要改 LLM 抽取提示词** → 改 `action-runner/feature/extract-prompt.js`（按声明生成，**不要**再写 `if (name === 'env')` 这类分支）。
- **要加变量声明的新字段 / 新校验** → 改 `action-runner/feature/var-contract.js`（`CONTRACT_KEYS` + `validateVariable`），并同步 `public/js/actions-panel.js` 表单与 `actions-panel.logic.js#buildVarDecl`（空字段必须省略，否则会把 preset 覆盖成空）。
- **要改埋点统计的理解/精选/校验/限流** → 分别改 `tracking-stats/` 下 `understand.js`（两阶段 LLM）、`logic.js`（召回/校验/文案）、`throttle.js`（限流）；改查库或报告渲染 → `tracking_report.py`（注意与 `logic.js` 的 QuerySpec 契约须同版本）。
- **要改飞书补充内容注入 web 会话的路径** → 改 `feishu-relay/index.js`（三条命中路径 + `postInject` 跨进程直送）。

# src/plugins · 模块地图

> 业务插件层。内核 `dispatch` 不再硬编码任何业务 feature；需求收集、自动开发、埋点统计等「对话功能」全部以**插件**形式挂载，由本模块动态装配进 dispatch 的 feature 列表。`settings.plugins` 可逐个启停，**停用的插件不 import**（内核进程不载入其业务代码，这是「内核更纯」的实质）。
>
> 加功能 = 在此加插件目录 + 在 `index.js` 的 `PLUGIN_MANIFEST` 登记，不改 dispatch / 入口 / store（约定见根 `CLAUDE.md`、`docs/ARCHITECTURE.md`）。

## 文件清单

### 装配层（模块根）
- `index.js` — 插件清单 `PLUGIN_MANIFEST` + 装配。`loadEnabledPluginFeatures` 逐个 `getPluginEnabled` 判断后**动态 import** 启用插件、收集其 `features` 条目；`assembleFeatures` 把 core + 插件条目按 `order` 稳定排序后摊平成 feature 数组；`loadPluginSideEffects(ids)` 按 id 加载插件**只为触发模块级副作用**（不取 features），补的是「web 进程不走装配层」这个缺口（见下「关键流程 C」）。**本模块唯一对外入口**。
- `index.test.js` — 装配层单测。

### team-tools/ —— 团队工具插件（一个插件 = 6 个 feature + 一组共享领域模块）
- `team-tools/index.js` — 插件装配：task-triage(10)/bug-patrol(12)/create-session(13)/status-report(14)/feedback(40)/project-qa(90) 六个 feature 按 order 挂载。
- `team-tools/feedback/index.js` — feature「需求/故障收集」（`intents:[bug,feature,material]`）：建 Task、按托管档位/身份分流到评审或直通自动开发；含「坚持修改/算了」评审否定应答（文本 + 卡片两条路径）。`logic.js` 为其纯函数（可挽回任务判定、评审否定卡片构造/解析）。
- `team-tools/review/index.js` — feedback/bug-patrol 调用的**评审门**（非 feature）：`reviewTask` 只读查证打分，`recordOverride` 记人工覆盖判例。`logic.js` 存判决矩阵 `decideVerdict`、`buildReviewPrompt` 等纯函数。
- `team-tools/auto-dev/queue.js` — **入队 API 的零重依赖叶子**：`requestAutoDevelop`（置 `queued`，任意进程可调，幂等）+ `isOverrideStart`（纯谓词）。**只允许依赖 `store/tasks.js`**。要入队一律从这里引，**不要从 `index.js` 引**——那会把 git / 编译 / 飞书回发 / Claude 调用整条执行链拖进调用方，并让 `task-notify` 与执行管线成环（2026-09-04 实测检出过两个环，见该文件头）。
- `team-tools/auto-dev/index.js` — **自动开发管线（执行侧）**：泵 `startAutoDevPump` **仅 web 进程**常驻，在常驻 auto 工作区建任务分支改码 → 自检门（`verify.js`）→ 提交、置 done。配套 `git.js`（git 封装，参数拼装抽纯函数）、`logic.js`（分支名/提交信息纯函数）、`compile.js`（DEV 编译二维码适配）。
- `team-tools/auto-dev/verify.js`（+ `verify.logic.js`）— **自检门**：`developWithVerify`（先解析命令：显式配置 > `capabilities/verifier.js#resolveVerifyCommand` 自动发现 → develop → `runVerify` → 失败带输出重试 1 次 → 再验证）；纯函数层存 prompt 片段（完成标准/失败现场）、卡片行与重试上限。命令只来自 `bot.verifyScript`（owner 配置）或工程 `package.json` test 脚本（发现产物只有 `npm test` 一种形态），**任何模型输出/任务数据不得拼入**——那是绕过审批的任意命令通道。验证失败同样 `commitAll` 留痕，再退回 `analyzed` + 卡片通知。spec：`docs/superpowers/specs/2026-09-30-verify-gate-design.md`。
- `team-tools/auto-dev/revert.js`（+ `revert.logic.js`）— **放弃已合并改动**：`git revert -m 1 <mergeCommit>` 优先，冲突或无锚点则起 Claude 撤销再 `commitAll`。执行目录走 `git.js#withBranchWorktree`（与合并同一套路径 A/B 分流）。**进 LLM 兜底前有一道 `isClean` 闸**——路径 A 下执行目录就是用户主工作区，脏则停手报错：否则无关的未提交改动会被 `commitAll` 的 `add -A` 卷进撤销提交，且「无改动即失败」的防谎报闸会被脏文件顶开。`revert.logic.js` 存 prompt 与 commit message 纯函数（消息必须过 commitlint）。
- `team-tools/auto-dev/merge-llm.js`（+ `merge-llm.logic.js`）— **自动合并的 LLM 兜底**，作为 `resolver` 由 `task-actions.js#mergeTaskById` 注入给 `git.js#mergeBranch`（`git.js` 只认回调、不认识模型，否则每个想跑 `git status` 的调用方都被拖上 SDK）。两个出口性质不同、prompt 不可互换：`resolveConflict` 解两个已提交分支的内容冲突（**明令禁止整块选一边**）；`mergeStash` 融合「合并结果 vs 维护者未提交、正在写的代码」（**两边都要保留，半成品原样留着，不许替人补全或删除**）。两个 prompt 共同禁止模型自己 `git add/commit` —— 提交与防谎报闸都在 `git.js` 里。**单测调 `mergeTaskById` 涉及冲突时必须传 `resolver: null`**，否则会起一次真实模型调用（实测 73 秒 + 真改了测试仓库的文件）。
- `team-tools/task-triage/index.js` — feature「owner 待办分诊」（触发词进入，owner 专属）：交互式逐条呈现已分析任务，决策后入自动开发/后台串行开发队列。`logic.js` 分组/排序/意图解析纯函数。
- `team-tools/bug-patrol/index.js` — feature「BUG 巡检」（`\10001`，可信提交人专属）：等多维表格 → 找 `phase==='test'` 需求（多个让用户选序号）→ 跨进程 POST `/api/patrol/start` **启动循环**（不再自己跑扫描）。导出的 `runPatrolRound` 是单轮扫描体，由循环泵调用：Haiku 字段映射 → 筛「我的待处理 BUG」→ `filterUnseen` 成本护栏 → 逐条评审 → 归属判定 → 前端自动修 / 后端转派。`logic.js` 链接解析/字段校验/文案纯函数；`hasPatrolPending` 供飞书入口绕过云文档摄取。**第三条出口「缺图转人工」**：归属判定同时判 `blocked==='need-assets'`（要新增 UI 图片资源、但附件与代码库里都没有），命中则不写表不建任务、`pushReport('needHuman')` 只在汇报里单列；无需求关联时走 `assetOnly` 精简 prompt 保证全覆盖。
- `team-tools/bug-patrol/loop.js` — **巡检循环泵**（**仅 web 进程**，对齐 `startAutoDevPump`）：`scanning`（扫 + 等本轮任务全终结）→ `standby`(20min) → `scanning`，12 小时上限；出口为 `\10004` 或到期。放 web 进程是因为判「全修完」要读 auto-dev 任务终态，而那个泵只在 web 进程跑。`loop.logic.js` 存终态判定（**`isSettled` 必须认 `analyzed`** —— auto-dev 失败退回该状态，没有 failed 态，只认 `done` 会让泵永远等不到终态而卡死）、额度错误识别、汇报文案等纯函数。
- `team-tools/bug-patrol/side-review.js` — 前后端归属判定（独立于 `reviewTask` 的第二次只读 Claude 调用，超时/异常一律落 `unknown`）。只在「关联测试期需求 + 前后端目录齐备」时才跑。`side-review.logic.js` 存 prompt / 输出解析 / 后端人选解析（`resolveBackendAssignees` 返回**全部**指派后端）/ 人员字段补丁纯函数。
  - **`reject` 也要送归属判定**：评审门只查前端工程，后端 BUG 必然判 `belongs=false`，不接这一步它就被当噪音丢了（2026-09-18 实测：一条「描述主题不清晰」在前端零命中判 reject，实际是后端 `growth_foresight` 的 LLM prompt 卡 10 字上限压出的破句）。`ask` 刻意不送——它 `belongs=true`，是前端的活只是定位不了。
  - **截图必须下载给模型看**：`logic.js#collectImageAttachments` 提 `file_token` → `lark.js#downloadBitableMedia` 落盘 → `buildRecordDetail` 把路径写进 detail 并**显式要求用 Read 查看**。测试提的 BUG 描述普遍只有一句话、定位字段常空，判断依据大半在图里；实测同一条记录无图判 `unknown`、有图判对 `backend`。
- `team-tools/stop-patrol/index.js` — feature「停止巡检」（`\10004`，可信提交人专属，order 15）：跨进程 POST `/api/patrol/stop`，只置 `stopping`，已入队的修复跑完后发最终汇报。
- `team-tools/status-report/index.js` — feature「当前任务清单」（`\10002`，可信提交人专属）：纯本地读盘汇总运行中会话 + 活跃任务 + 待合并。`logic.js` 分组/状态标签/格式化纯函数。
- `team-tools/create-session/index.js` — feature「新建会话」（`\10003`，可信提交人专属）：跨进程 POST web 路由建会话，回前 8 位 shortId。`logic.js` 触发文案定义。
- `team-tools/project-qa/index.js` — feature「项目问答」（`intents:[question]`）：只读起 Claude 查代码回答，带同用户串行闸/3 分钟超时/答案截断三道保护。
- `team-tools/auto-dev/prompt.logic.js` — **develop 提示词模板**（纯函数，零 IO）：`buildDevelopPrompt({type,detail,analysis,scopeSection,scopeFix,verifyCommand,verifyFeedback})`。`task-ops.js#develop` 与内部 benchmark（`benchmarks/lib/runner.js`）**共用同一份**——「改提示词」在评测里必须可复现，A/B 才成立。
- `team-tools/task-ops.js` — **共享领域模块**（非 feature）：`analyze`（只读分析）/`develop`（实际改码）/`attachMaterialToRecentTask`。供 feedback/task-triage/auto-dev/web 入口共用。`develop` 支持 `verifyCommand`/`verifyFeedback`（自检门的 prompt 段：完成标准与上次失败现场；模板在 `auto-dev/prompt.logic.js`）。**无人值守策略（T6）**：develop 经 `capabilities/tool-policy.js#buildUnattendedClaudeOpts` 按 `bot.execPolicy` 拼权限选项（默认 bypass=与改动前一致；standard/trusted 走策略门，计次熔断时 abort 本轮）。
- `team-tools/task-actions.js` — **共享领域模块**：任务分支 `mergeTaskById`/`discardTaskById` 及 `isAwaitingMerge`/`isDiscardable` 谓词。web 路由与飞书任务卡片共用一套编排。**放弃按 `task.merged` 分流**：未合并删分支、已合并走 `auto-dev/revert.js` 撤销（合并已自动化，「删分支」不再等于撤销）；`isDiscardable` 因此**不含 `!merged`**，合并前后都可放弃。
- `team-tools/task-notify.js`（+ `task-notify.logic.js`）— 任务完成 → 飞书私聊卡片（发给管理员本人），处理「合并/补充/放弃」卡片回调；`.logic.js` 为卡片构造/回调解析纯函数。**合并结果必须上卡片正文**（`mergeLine`）：2026-09-28 实测事故——自动合并失败后卡片只写「✅ 已处理完成」配一个合并按钮，人看不出自动合并已试过并失败，会以为是自己还没点，三条任务因此积压四天。卡片与降级纯文本（`taskDoneFallbackText`）共用 `mergeStatusOf` 这一把尺子，否则两条通道口径会分叉。整条通知受 `uiPrefs.taskNotifyFeishu` 总开关管（面板上的 🔔 chip），**关着就一条都收不到**。
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
- `action-runner/feature/keyword-guard.js` — **关键词自学习的本地硬闸**（纯函数）：候选词能不能学，七条确定性规则说了算（模型只负责提词）。核心是**双向子串冲突检查** —— 给 A 动作加词可能让 B 动作原本 L2 秒出的消息变成多命中而退回 L3，这种伤害对用户和模型都不可见。已知边界：只管子串嵌套，管不到「两个互不为子串的词共现」（那是 L2 多词表共存的固有属性，退回 L3 反而是正确行为，详见该文件头）。⚠️ 只许 import `app/intent-keywords.js`（零依赖叶子），**不得** import `app/intent.js`。
- `action-runner/feature/learn-keywords.js` — 关键词自学习管线：拼提词 prompt → 调一次 haiku → 逐个过硬闸 → `store/action-configs.js#appendAutoKeyword` 原子写盘。只在「L3 兜底命中 + 脚本执行成功」时触发，fire-and-forget。
- `action-runner/card-action.js` — `quick-action` 卡片按钮回调 → 构造虚拟 ctx 直接调 `feature/index.js#handle`（绕过意图识别）。
- `action-runner/**/*.test.js` — 对应单测。

### colleague-agent/ —— 同事侧对话 Agent
- `colleague-agent/index.js` — 插件装配（order 35：action-runner 之后、feedback 之前）；**模块加载时**把 `tools/req-read.js` + `tools/req-write.js` 的工具定义逐个 `assertRoles` 校验后 `registerAgentTool`（工具自注册，与卡片回调同一范式）。
- `colleague-agent/feature.js` — **feishu 进程** dispatch feature（`intents:[bug,feature,question,material,other]`，`permission:'any'`）：只覆盖文本，调 `relay.js#relayToAgent` 判定归属；接管则不回 ACK（回复由 web 侧跑完 agent 后经 lark 直发），否则 PASS 回落 feedback。
- `colleague-agent/relay.js` — **文本与附件两条入站链路共用**的判定 + 落盘 + 跨进程触发层：`isColleagueMessage` 判「这个 open_id 在不在同事名册」，命中则 `appendTo` 落一条 `dir:'in'` 消息、`reqId` 留 null（归属交给 agent 判），再 fire-and-forget `POST /api/req/colleague-agent/turn` 触发 web 跑一轮。附件在 `entrypoints/feishu/index.js` 的 image/file 早期分支就被接走（到不了 dispatch），必须调本文件而非另写一份判定。
- `colleague-agent/session.js` — **web 进程**编排层：`handleColleagueTurn` 过限流闸 → 按角色装配 MCP server（`agent-tools.js#buildAgentMcpServer`）→ 组装 system prompt（`prompt.js`）→ `agent-session.js#runAgentTurn` → `lark.js#sendTextToUser` 直接回同事 → 落出站消息 + 回填 `agentSessionId`。任何失败（限流/超时/额度耗尽/异常）一律退化到固定 ACK 文案，绝不静默不回。
- `colleague-agent/rate-limit.js` — 两道限流闸（per-人滑动窗口 + 全局并发上限）的纯函数状态机 + 进程内单例；**必须在 web 进程用**（feishu 进程数的只是自己发出去几个 POST，拦不住实际并发）。
- `colleague-agent/prompt.js` — system prompt 组装纯函数：按角色标签 + 他参与的需求列表拼「先查证再质疑 / 不确定就问 / 不替主机做承诺 / 阶段流转不归他管」等硬约束。
- `colleague-agent/tools/req-read.js` — 5 个 `safe` 只读工具（`list_my_requirements`/`get_requirement`/`get_api_doc`/`get_dev_progress`/`read_project_code`）：fail-closed 可见性（不含 `colleagueId` 不外推）、不倒整条记录、不给落盘绝对路径。
- `colleague-agent/tools/req-write.js` — 2 个 `reversible` 写工具（`register_api_doc`/`start_dev_task`）：`buildUndo` 骨架先占注册期不变式的位，真正带 `mergeSha` 的撤销台账由 `entrypoints/web/colleague-dev.js` 跑完后覆盖式补全；handler 动态 `import()` `entrypoints/web/requirement-ops.js` 的 `registerApiDoc`/`enqueueSystemTask`（避免插件层静态反向依赖 entrypoints，见该文件头）。

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
4. 泵 `tick → runOne`：确保常驻 auto 工作区（`git.js#ensureAutoWorktree`）→ 自愈残留 → `checkout -B <taskBranch>` → `auto-dev/verify.js#developWithVerify`（`task-ops.js#develop` 在 auto 工作区改码，`deferStatus`；权限档按 `bot.execPolicy` 解析——默认 bypassPermissions，standard/trusted 走策略门；自检门：未通过带输出重试一次，再败退回 `analyzed`）→ `git.js#commitAll` 校验（无改动即失败，验证失败同样提交留痕）→ 置 `done` → **自动合并回基线分支**（`mergeTaskById(id, { auto:true })`，失败则静默降级回待人工合并态）→ `task-notify.js#notifyTaskDone` 发管理员私聊卡片 → `replySource` 回来源会话。
5. 管理员在飞书任务卡片点「合并/放弃」→ `task-notify.js#onTaskCardAction` → `task-actions.js#mergeTaskById/discardTaskById`（与 web 路由同一套编排，谓词 `isAwaitingMerge/isDiscardable` 共用，防两条入口状态机分叉）。

另有两条入口汇入同一后段：`task-triage/index.js`（owner 主动分诊，走 `task-ops`/`auto-dev`）、`bug-patrol/index.js`（多维表格 → 逐条 `reviewTask` → 建 Task → `requestAutoDevelop`）。**它们彼此不互相 import feature；跨 feature 协作一律经共享领域模块（task-ops/task-actions/auto-dev 的导出函数）与 `store`。**

### C. 卡片回调自注册 + 跨进程直送
**先认准一个事实：只有走 dispatch 的进程（feishu / console）会加载插件。** `loadEnabledPluginFeatures` 只被 `src/features/index.js` 调用，后者只被 `src/app/dispatch.js` import，而 **web 入口对 `app/` 零引用** —— web 进程走装配层的次数是零。（`routes-settings.js` 确实 import 了本模块，但只取 `PLUGIN_MANIFEST` 这份**数据**；清单里的 `load` 是惰性函数，不调就不加载。）

在会加载插件的那些进程里，多个模块在**模块加载时**副作用调用 `shared/card-actions.js#registerCardKindHandler` 注册卡片回调 kind：`quick-action`（`action-runner/card-action.js`）、`review-verdict`（`feedback/index.js`）、任务卡（`task-notify.js`）、会话卡（`feishu-relay/index.js`）。**插件停用即不加载 → 回调自然缺席**，这是「停用插件不载入业务代码」的落地。

**卡片回调在 web 进程缺席是无害的**（web 收不到飞书卡片事件），**但靠同一机制注册的 agent 工具不是** —— `colleague-agent` 的工具恰恰只在 web 进程被调用（起 run 必须在 web）。web 侧因此必须用 `index.js#loadPluginSideEffects(['colleague-agent'])` 显式加载，落点在 `entrypoints/web/server.js` 的 listen 回调。它**仍逐个过 `getPluginEnabled`**，是补装配层的缺口而不是绕开停用开关的后门。忘了加的失败形态极隐蔽：注册表为空 → `buildAgentMcpServer` 安静造出一个零工具 MCP server → 模型凭记忆作答，**回复照样通顺、日志里什么都没有**（`capabilities/agent-tools.js` 里 `picked.length === 0` 那行 warn 是最后一道哨）。

会话注入/新建会话需操作 web 进程内存里的 run 注册表，故 `feishu-relay/index.js` 与 `create-session/index.js` 都用 `fetch('http://127.0.0.1:${config.web.port}/...')` 跨进程直送（3s 超时、无 Origin 头放行），而非直接改状态。

### D. action-runner 槽位填充状态机
`feature/index.js#handle`：意图 `action`（带 `intentResult.actionId`）→ `permission.js#canRunAction` 权限闸（进槽位填充**之前**拦，避免泄露动作存在性）→ `slot-filler.js#extractVars` 提取变量、`pickMissingVars` 找缺失 → 缺则写 `pendingState` 追问（`hasPending` 令 dispatch 下一条直接劫持该用户）→ 齐则 `script-runner.js#runAction` 执行。防卡死两招：`PENDING_TTL_MS` 超时、追问一轮无进展即清态并返回 `PASS` 交还 dispatch。卡片按钮入口 `card-action.js` 构造虚拟 ctx 复用同一 `handle`。

`pendingState` 的占位**必须写在发起抽取之前**（抽取那几秒里 `hasPending` 为 false 会让用户的抢答绕过本 feature、被判 `other` 回一张帮助卡）；窗口内的消息进 `inbox` 由 `mergeQueuedAnswers` 并入；抽取期间用户打「取消」则占位消失，恢复后必须检查并放弃执行（破坏性脚本在用户喊停后仍跑起来不可接受）。

**关键词自学习**（挂在这条状态机的成功出口上）：`intent.js` 的 L3 命中给 `intentResult` 打 `via:'llm'` → `handle` 把触发原句写进 `pendingState.learnSrc`（`setPending` 负责在追问链上**继承**透传，否则走到执行时只剩最后一条补槽位的回答「test」）→ `executeAction` 的 `result.ok` 分支 `fireLearn` fire-and-forget 调 `learn-keywords.js`。三道闸缺一不学：L3 兜底认出来的、脚本真跑成功了、原句还在（TTL 超时或「一轮无进展 PASS 归还」会连 `learnSrc` 一起丢，那次就不学 —— 符合「执行成功才是用户的确认」的口径）。学到的词直接进 `keywords[]` 参与下次 L2 匹配，元数据留在 `autoKeywords[]`，人工在面板删掉即进 `rejectedKeywords[]` 永不再学。卡片按钮入口（`card-action.js`）构造的 `intentResult` 不带 `via`，天然不学。

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

### F. 同事对话 agent 的两进程分工

`colleague-agent` 的判定与执行分落两个进程，中间隔一次跨进程 POST —— 这不是绕路，是因为 `start_dev_task` 要调的 `registerApiDoc`/`enqueueSystemTask` 操作的是 **web 进程内存里**的需求泵与 busy 状态机，在 feishu 进程动态 import 它们拿到的是另一份模块实例，任务入队后永远不会被执行：

```
feishu 进程                              web 进程
─────────────────────────────────       ─────────────────────────────────
onInbound（群聊仅 @ 才放行——见下）
 ├─ 文字 → dispatch → feature.js
 └─ 附件 → 早期分支（到不了 dispatch）
      ↓ 共用 relay.js#relayToAgent()
   名册判定
   appendTo 落盘（dir:'in'）
   POST /api/req/colleague-agent/turn ──→ handleColleagueAgentTurn
   （fire-and-forget，不回 ACK）           ├─ 限流闸（per-人 + 全局并发，rate-limit.js）
                                          ├─ session.js 组装 prompt / 取 agentSessionId
                                          ├─ runAgentTurn（工具齐备，因为 server.js
                                          │   已 loadPluginSideEffects(['colleague-agent'])）
                                          ├─ lark.sendTextToUser 直接回复同事
                                          └─ appendTo(dir:'out') + 回填 sessionId/toolTrace
```

限流两道闸都放 web 进程（`rate-limit.js`），不放 feishu 侧的 `feature.js`——真正并发跑 agent 的是 web 进程，feishu 进程数的只是自己发出去了几个 POST，放错进程等于没拦。

**群聊 @ 过滤不是 `relay.js` 的逻辑**，是 `entrypoints/feishu/index.js#onInbound` 最上面的通用入口判定，对所有消息类型生效、不止同事消息。而且**只挡 `text`/`unsupported`**——`image`/`file` 分支在判定之前就已经分流走了 `relayColleagueAttachment`，压根不过这道闸（飞书图片/文件报文本就不含 `mentions`，发图时无法 @ 人）。也就是说：群里发图会直接触发 agent，不受「有没有 @」约束；只有文字消息才需要 @ 机器人。

## 常见改动入口

- **要新增一个业务对话功能** → 新建 `<新插件>/index.js`（default 导出 `{ id, features:[{order, feature}] }`）+ 在 `index.js` 的 `PLUGIN_MANIFEST` 登记；若属团队工具范畴，在 `team-tools/` 下加 feature 子目录并在 `team-tools/index.js` 挂 order。不改 dispatch / 入口。
- **要调某功能的路由优先级 / 让它抢在 claude-exec 之前** → 改对应插件 `index.js` 里 feature 的 `order`（认准 `< 20` 才能压过 claude-exec；改前先读该文件头对 order 的约束说明）。
- **要改需求/故障从收集到开发的分流逻辑**（托管档位、直通条件、即时应答、评审否定应答）→ 改 `team-tools/feedback/index.js`。
- **要改 AI 评审的判决口径 / 阈值** → 改 `team-tools/review/logic.js#decideVerdict`（纯判决矩阵）；改评审提示词或只读闸 → `review/index.js` + `logic.js#buildReviewPrompt`。
- **要改自动开发的工作区/分支/提交/重启恢复策略** → 改 `team-tools/auto-dev/index.js`（泵与 runOne 流程）；git 参数拼装 → `auto-dev/git.js`；分支命名/提交信息 → `auto-dev/logic.js`。
- **要改自检门**（重试上限/卡片文案/prompt 片段）→ `team-tools/auto-dev/verify.js` / `verify.logic.js`；命令本体（跑什么）在机器人配置 `verifyScript`（设置页）或工程 `package.json` test 脚本（未配置时自动发现）；通用验证能力（超时/fail-open 边界/命令探测/自动发现/输出截断/摘要）→ `capabilities/verifier.js` / `verifier.logic.js`。
- **要改自动合并的时机 / 失败降级策略** → 改 `team-tools/auto-dev/index.js#runOne` 里 `status='done'` 之后那次 `mergeTaskById` 调用（**必须在 done 之后**，之前调会被 `isAwaitingMerge` 谓词挡回、自动合并静默失效）；改合并本身的 git 行为 → `auto-dev/git.js`。
- **要改合并失败的救援策略** → 认准三层逐级升级、各有各的落点：① 提交钩子拦截 → `--no-verify` 重提（`git.js#attemptMerge`）；② 工作区脏 → 自动 `stash` 后重试、合完 `pop` 回来（`git.js#mergeWithStash` / `popStash`）；③ 内容冲突 → 交注入的 resolver（`auto-dev/merge-llm.js`）。改 prompt 只动 `merge-llm.logic.js`，改 git 编排只动 `git.js`。
  - **`popStash` 里每条出口都在保同一样东西：维护者未提交的代码**。`git stash drop` 只允许出现在「融合确认成功」之后，其余分支一律留着条目并把 sha 写进提示——那是改动的最后一份拷贝，没有任何地方能找回。
  - **脏工作区是两类失败的共同放大器**，所以 stash 对两者都有效：预检拒绝（脏文件与合并内容重叠，git 根本不开始合并）与内容冲突（LLM 解完要 `add -A`，无关脏文件会被一并提交，即 `revert.js` 踩过的坑）。判脏**必须在 merge 之前**——冲突态下 `status --porcelain` 恒非空，事后再判分不清「维护者的脏」和「冲突造成的脏」。
  - 合并成功但留了尾巴走 `task.mergeWarning`（面板琥珀色）而**不是** `mergeError`（面板红色「上次合并失败」）：混用会让人去排查一次根本不存在的失败。
- **要改「放弃已合并改动」的撤销策略或 AI 兜底提示词** → 改 `team-tools/auto-dev/revert.js` / `revert.logic.js`；**不要**改 `git.js#deleteBranch`（那条是未合并任务的路径）。
- **要改入队条件 / 幂等判定 / 覆盖判定** → 改 `team-tools/auto-dev/queue.js`；往那里加东西前先读它的文件头纪律（**只许依赖 `store/tasks.js`**，破了纪律 import 环会原样回来）。
- **要改「只读分析」或「实际改码」的提示词** → 改 `team-tools/task-ops.js`（`analyze`/`develop`，被多入口共用，一处改全局生效）；改**无人值守执行档位**（bypass/standard/trusted）→ `bot.execPolicy`（设置页机器人表单），规则表与判定在 `capabilities/tool-policy*.js`（T6）。
- **要改合并/放弃的编排或谓词** → 改 `team-tools/task-actions.js`（web 与飞书卡片共用，勿在任一入口另写一份条件）。
- **要改可信提交人指令（\10001/\10002/\10003/\10004）的触发文案** → 改对应 feature 的 `logic.js` 里 `*_TRIGGERS`；触发匹配规则本身 → `team-tools/trusted-trigger.js`（严格全等，勿改成模糊/前缀/LLM 识别）。
- **要改巡检循环的周期 / 12 小时上限 / 汇报文案** → 改 `team-tools/bug-patrol/loop.logic.js`（`STANDBY_MS` / `MAX_LIFETIME_MS` / `QUOTA_HOLD_MS` / `buildRoundReport`）；改状态机流转 → `loop.js`。
- **要改前后端归属判定的口径** → 改 `team-tools/bug-patrol/side-review.logic.js#buildSidePrompt`；**不要**改 `review/logic.js`（那是 feedback / task-triage 共用的判决矩阵，为巡检一条支线改它会波及全局）。
- **要改缺图判定的口径** → 改 `bug-patrol/side-review.logic.js#ASSET_RULE`（两个 prompt 共用的判据常量）；改出口行为 → `bug-patrol/index.js` 里 `blocked === 'need-assets'` 那段。
- **要加/改一个飞书卡片按钮回调** → 在对应插件模块加载处 `registerCardKindHandler(kind, handler)`（参照 `task-notify.js` / `feedback/index.js`），**不要写进 `shared/`**（会造成 shared→plugins 分层倒挂，见 `action-runner/card-action.js` 文件头）。
- **要改动作执行（槽位填充/脚本/逐动作权限）** → 分别改 `action-runner/feature/` 下 `index.js`（状态机）、`slot-filler.js`（编排）、`script-runner.js`、`permission.js`。
- **要调关键词自学习的松紧**（长度门槛 / 停用词 / 配额 / 冲突判据）→ 改 `action-runner/feature/keyword-guard.js`；改提词 prompt 或一轮学几个 → `learn-keywords.js`；改触发条件 → `feature/index.js` 的 `fireLearn` 调用点。**不要**改 `app/intent.js` 的 L2 匹配逻辑，那是全局共享资源。
- **要让某类变量能被本地识别**（不再每次调 LLM）→ **不改代码**：在设置页给该变量填 `合法值 + 别名` 或 `正则`。常见类型可选 `预置`（`var-presets.js` 的 `env`/`phone`）。
- **要加一个新的内置预置** → 改 `action-runner/feature/var-presets.js` 的 `PRESETS`（零依赖纯数据）。⚠️ 改动会立即影响所有引用它的变量（运行时展开，不落盘快照）。
- **要改本地抽取的扫描/弃权规则** → 改 `action-runner/feature/local-extract.js`。新增候选词前先读 `compileScanner` 上方那四条规则，特别是「不带外层量词」—— `intent.js` 的 `CHITCHAT_RE` 曾因此占死事件循环。
- **要改 LLM 抽取提示词** → 改 `action-runner/feature/extract-prompt.js`（按声明生成，**不要**再写 `if (name === 'env')` 这类分支）。
- **要加变量声明的新字段 / 新校验** → 改 `action-runner/feature/var-contract.js`（`CONTRACT_KEYS` + `validateVariable`），并同步 `public/js/actions-panel.js` 表单与 `actions-panel.logic.js#buildVarDecl`（空字段必须省略，否则会把 preset 覆盖成空）。
- **要改埋点统计的理解/精选/校验/限流** → 分别改 `tracking-stats/` 下 `understand.js`（两阶段 LLM）、`logic.js`（召回/校验/文案）、`throttle.js`（限流）；改查库或报告渲染 → `tracking_report.py`（注意与 `logic.js` 的 QuerySpec 契约须同版本）。
- **要改飞书补充内容注入 web 会话的路径** → 改 `feishu-relay/index.js`（三条命中路径 + `postInject` 跨进程直送）。
- **要改同事消息的归属规则** → `colleague-agent/relay.js#isColleagueMessage`（文本与附件两条入站链路共用，勿在 `entrypoints/feishu/index.js` 另写一份）。2.0 判定**不再看开发期需求** —— 只要在同事名册里就接管，需求归属改由 agent 逐条判并打 `reqId` 标签（判不准会直接问同事），不像上一代 `colleague-relay` 只认 `phase==='dev'` 的开发人员。
- **要改 agent 对话的限流 / 触发条件** → per-人频率与全局并发闸在 `colleague-agent/rate-limit.js`；真正的守门（插件开关 / 限流执行 / agent 调用）在 `entrypoints/web/routes-requirements.js` 的 `POST /api/req/colleague-agent/turn`（`handleColleagueAgentTurn` → `colleague-agent/session.js#handleColleagueTurn`）。跨进程 `postToWeb` 范式目前有 5 份复制（create-session / stop-patrol / feishu-relay / bug-patrol / colleague-agent/relay），已够抽到 `shared/`，待办。

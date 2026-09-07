# src/features · 模块地图

本目录混装**两类性质不同**的东西，读代码前先分清，否则会找错编排入口：

1. **对话 feature（走 dispatch）**：只有 `claude-exec/` 一个。它是标准 feature 对象（`match`/`handle`），由 `index.js` 装配进 `features` 数组，交给 `src/app/dispatch.js` 路由。
2. **后台 / 库子系统（不走 dispatch）**：`memory-bank/`、`project-checkup/`、`project-optimize/`。它们没有 feature 对象，主循环 / 编排入口在**模块之外**——记忆库由 `src/entrypoints/web/server.js` 的 ticker 拉起，体检 / 优化由 `src/entrypoints/web/optimize-ops.js` 调度。放在 `features/` 是因为它们属于「内核能力」，但别在本目录里找它们的主循环。

`project-checkup` / `project-optimize` 贯穿一条铁律：**每个检测器 / 修复器都拆成 `X.js`（fs / LLM / 子进程 IO 层）+ `X.logic.js`（纯函数判定层，带 `*.test.js`）**。纯逻辑单独可测、IO 层极薄——这是本目录文件成对出现的原因。

## 文件清单

### 装配
- `index.js` — 模块唯一公开导出 `features`：内核 `claude-exec`(order 20) + 启用插件的 features 按 order 合并；顺序即匹配优先级。

### claude-exec/（owner 专属对话 feature，飞书入口）
- `claude-exec/index.js` — feature 对象：`/new` 重置、首行 `cwd:` 指定目录、多轮 session 续接；调 `integrations/claude` 跑完整能力，并埋 `appendUserLog`（记忆库的数据采集点）。
- `claude-exec/logic.js` — `shouldOwnerExec`：owner 全接，但「提交需求 / 提交故障」强前缀让路给 feedback。纯函数。
- `claude-exec/reply.js` — 回复组装与分片：`buildExecReply`（把 is_error/subtype 翻成人话，失败不谎报成功）、`splitForFeishu` / `splitForMarkdownCard`（按飞书上限切分且不丢字符）。纯函数。

### memory-bank/（后台偏好提炼流水线，不走 dispatch）
- `memory-bank/index.js` — 胶水层：`runOnce` 跑一轮提炼、`startMemoryBankTicker` 定时 tick、`writeRenders` 渲染落盘并挂接 CLAUDE.md。全模块唯一的 IO 编排点。
- `memory-bank/schedule.js` — `shouldRun`：双窗口（额度重置前 30 分钟 / 凌晨保底）+ busy / cooldown / exhausted 判定。纯函数，token 语义就地复刻 token-rotation。
- `memory-bank/scan-sessions.js` — `scanForUnanalyzedSessions`：扫描 `~/.claude/projects` 下未分析或已修改的 `.jsonl` 文件，返回待处理列表。纯函数、零 LLM。
- `memory-bank/analyze.js` — Phase 1 LLM 层：`analyzeSession` 对单个会话转录提取 findings（bug/solution/pattern/preference）；返回 `null`(调用失败) / `[]`(正常无产出)。
- `memory-bank/synthesize.js` — Phase 2 LLM 层：`synthesizeMemories` 把多会话 findings 合成为 memories 写入 bank；返回 `null`(调用失败) / `[]`(正常无产出)。
- `memory-bank/render.js` — 条目 → Markdown：`selectForInjection` / `renderMarkdown`（含注入预算截断）；支持 v2 memories（自动归一化 status/inject/scope 字段），`FINDING_TYPE_LABEL` 常量供 UI 层使用。纯函数。
- `memory-bank/prefilter.js` — **v1 主链路（已不作为默认链路使用）**：`buildExtractionInput` 从 user-log 游标读取并按字节偏移组织会话输入。
- `memory-bank/extract.js` — **v1 主链路（已不作为默认链路使用）**：`extractFromSessions` 整批一次 LLM 调用提取候选条目。
- `memory-bank/promote.js` — **v1 主链路（已不作为默认链路使用）**：`mergeCandidates` 状态机晋升 + `applyDormancy` 失效。

### project-checkup/（只读检测器库，编排在 optimize-ops）

**17 个维度分两类实现**，读代码前先分清：

1. **声明式（10 个新维度）**：在 `dimensions/registry.js` 加一条声明即可，统一走 `audit-engine`。
2. **专属检测器（6 个既有维度）**：各有一对 `check-X.js` + `.logic.js`，参数经多次实测校准（模型档位、超时预算、批大小都有事故记录），**刻意不套进通用引擎**。

- `project-checkup/dimensions/registry.js` — **整个功能的唯一维度声明来源**：id / 域 / 权重 / 判据出处 / 召回器 / 判定词表 / 判分口径 / 修复策略 / 指纹范围 / 修复次序。权重表、体检占位、修复管线顺序、前端展示全部从它派生。
- `project-checkup/dimensions/rubrics-code.js` / `rubrics-project.js` — 各维度的审计准则（角色 / 判据 / few-shot / 输出要求），带权威出处（《代码整洁之道》《重构》《架构整洁之道》《Release It!》OWASP、12-Factor 等）。纯数据。
- `project-checkup/audit-engine.js` + `.logic.js` — **通用审计引擎**：召回 → 指纹缓存 → 分批调 LLM（**全局**限并发 4）→ 全有或全无校验 → 重锚定 → 判分。同构管线只此一份（抽自 `check-prompts.js` 的 450 行同构逻辑）。`mergeAugmentDim` 负责把 augment 型条目并进宿主维度。
- `project-checkup/evidence/collect.js` — 证据包收集：一次读全（git 追踪清单 + 源文件 + 导出符号 + 清单 + README + 分层约定），十个维度共用；按取材范围产出四份指纹（sources / manifest / docs / tracked）。
- `project-checkup/evidence/units.logic.js` — 语言无关的代码单元切分（花括号族 / 缩进族两套策略），全部召回器的地基。
- `project-checkup/evidence/symbols.logic.js` — 导出符号抽取 + 一次性标识符索引算引用数（只会高估不会低估，所以只漏报死代码不误报）。
- `project-checkup/evidence/selectors-code.logic.js` — 代码级召回器：复杂度 / 重复 / 命名 / 死代码 / 错误处理 / 危险用法 / 硬编码配置。
- `project-checkup/evidence/selectors-project.logic.js` — 项目级召回器：依赖图与环 / 依赖清单 / 上手文档 / 仓库卫生深化。**聚合粒度是这层的关键**（依赖问题天生是「目录对」级而非逐文件级）。
- `project-checkup/check-holistic.js` + `.logic.js` — 维度「整体智能评估」：读**其它维度的结论** + 项目结构，经只读 agent 产出优先级行动计划（topActions / contradictions / strengths）。不参与总分加权。
- `project-checkup/index.js` — `runStaticCheckup` 同步跑静态维度(map / rules)、其余按注册表留占位待异步回填；`LLM_DIM_KEYS` 由注册表取补集得出；`recomputeReport` 原地重算总分。
- `project-checkup/check-map.js` + `.logic.js` — 项目地图：遍历模块、比对 mtime 判过期、扫死链。
- `project-checkup/check-prompts.js` + `.logic.js` — 提示词质量：静态捞候选 + LLM 判分。
- `project-checkup/check-comments.js` + `.logic.js` — 注释合理性：抽样注释块 + LLM 判「是否解释为什么」。
- `project-checkup/check-rules.js` + `.logic.js` — 判 `.claude/rules/` 哪些该降级为 skill。
- `project-checkup/check-tests.js` + `.logic.js` — 测试健康度：起子进程跑测试命令 + 判大文件缺测试。导出的 `runProjectTests` 也是**修复侧测试闸**的原语。
- `project-checkup/check-hygiene.js` + `.logic.js` — 仓库卫生。刻意做成零误报（无 LLM 兜底），召回率由 `hygiene-audit` augment 条目补。
- `project-checkup/score.logic.js` — `aggregateScore` 加权总分 / 等级；`WEIGHTS` 由注册表派生（省略 weight 即不参与加权）；仅 done 维度参与、权重按比例分摊。
- `project-checkup/scan-dirs.logic.js` — 扫描维度共用的目录排除规则 `shouldSkipDir`。
- `project-checkup/fingerprint.logic.js` — LLM 维度的缓存指纹与失效判定。
- `project-checkup/frontmatter.logic.js` — 极简 YAML frontmatter 解析。
- `project-checkup/git-tracked.js` — `git ls-files`，「什么是真实源码」的权威来源。

### project-optimize/（修复器 / 生成器库，无 index.js，编排在 optimize-ops）

**五种修复策略覆盖全部 17 个维度**，由 `fix-engine` 按注册表的 `fix` 字段分派。核心规则：**没有 issue 会被静默丢掉**——任何策略都不认领的、以及被测试闸挡下的，一律进整改清单。

**测试是重构的许可证**（《修改代码的艺术》核心论点，落成硬闸）：`llm-refactor` 要求改前测试全绿、改完重跑、红了回滚**该文件**；项目没有可跑的测试命令时整个策略自动降级为只出清单。这条降级规则也定出了修复管线的顺序（`registry.js` 的 `fixOrder`）。

- `project-optimize/fix-engine.js` + `.logic.js` — **通用修复引擎**：`planEngineEntries`（备份条目，宁可多备份）、`runFixForDim`（按策略分派）、`writeHolisticPlan`；`.logic.js` 里 `partitionIssues` 决定哪条 issue 归哪个策略、`selectFixableDims` 选材（`BESPOKE_DIMS` 排除 map/rules）。
- `project-optimize/strategies/advisory.js` + `.logic.js` — 只出清单：渲染带定位 / 依据 / 改法的整改清单与整体行动计划，落到 `.claude/optimize/`（`PLAN.md` + `<维度id>.md`）。降级说明**必须在首屏**。
- `project-optimize/strategies/deterministic.js` + `.logic.js` — 机械修复（无 LLM）：`.gitignore` 追加 + `git rm --cached`、按行号删重复条目（倒序删 + 删前核对内容）。
- `project-optimize/strategies/llm-edit.js` + `.logic.js` — 三条 LLM 编辑路径：`runRefactor`（改源码，过测试闸）/ `runRewrite`（改文档，扩展名白名单是唯一闸）/ `runCreateTests`（只新建，跑不通就删掉——留红测试会堵死后续所有源码修复）。
- `project-optimize/test-gate.js` + `.logic.js` — 测试闸：`openGate` 判准入、`verifyAfterEdit` 逐次校验、`revertFile` **单文件**回滚（不能用整份还原，那会把前面成功的修复一起撤掉）。
- `project-optimize/fix-plan.logic.js` — `SUPPORTED_DIMENSIONS` 由注册表派生、生成「机器做不了」的手工待办 notes（含清单指路、降级否认、git 索引局限三条告知）。纯函数。
- `project-optimize/fix-rules.js` + `.logic.js` — rules→skill 降级（**唯一破坏性操作**：删文件 + 改写全仓引用）；`planDemote` 先算计划、`demoteOne` 五步执行带失败分级(fatal)。
- `project-optimize/fix-map.js` + `.logic.js` — 地图修复写盘：`fixDeadLinks` / `writeGeneratedMap` / `writeStaleAudit`；`planMapFix` / `selectFixableMap` 为纯逻辑选材。
- `project-optimize/gen-map.js` + `.logic.js` — 地图正文生成：走只读沙箱 agent + 质量闸，**只返回文本不写盘**（写盘归 fix-map）。
- `project-optimize/map-facts.js` + `.logic.js` — 扫盘产出「事实包」喂给 gen-map，全只读、失败吞成空串。
- `project-optimize/describe-skill.js` — 降级时生成 skill 的 `description` 字段（含 LLM 兜底 `fallbackDescription`）。
- `project-optimize/backup.js` + `.logic.js` — 破坏性操作的安全底座：`createBackup` 打快照、`recordPostState` 回填优化后哈希、`restoreBackup` 带二次修改检测的还原。
- `project-optimize/git-guard.js` + `.logic.js` — `checkWorkspace`：`git status --porcelain` 判工作区是否 dirty / 是否 git 仓库。

> 每个 `*.logic.js` / `check-*` / `fix-*` 都有配套 `*.test.js`（部分是 `*.fs.test.js`），此处不单独列。

## 关键流程

### 流程 A：owner 飞书消息 → 完整 Claude 执行
`src/app/dispatch.js` 用 `index.js` 导出的 `features` 匹配 → `claude-exec/index.js` 的 `match`(即 `logic.shouldOwnerExec`) 命中 → `handle`：
1. 解析 `/new`（清 session）与首行 `cwd:`（覆盖工作目录）；
2. `appendUserLog(...)` 把用户原话写进 user-log（**这是流程 B 记忆库的唯一数据源**；埋在此处而非入口 onInbound，是为了只收 owner 的话、不把群里同事的话当偏好）；
3. `runClaude`（`integrations/claude`，bypassPermissions + `botSystemAppend`），`onResult` 收下 is_error / subtype；
4. `reply.buildExecReply` 组装文本 → `reply.splitForMarkdownCard` 分片 → `ctx.channel.sendMarkdownText` 发出。

控制流：`dispatch → claude-exec/index → {logic, reply} + integrations/claude + store/user-log`。（注：web 入口的 owner 流式聊天不走本 feature，直连 `integrations/claude`。）

### 流程 B：记忆库后台提炼（server 启动即常驻，v2 两阶段流水线）
`server.js` 调 `startMemoryBankTicker`（`memory-bank/index.js`），每 10 分钟 tick：
1. `schedule.shouldRun`（注入 now / settings / tokens / activeRunCount）判是否进窗口，不进就 return；
2. 进窗口 → `runOnce` 跑两阶段：
   - **Phase 1（逐会话分析）**：`scan-sessions.scanForUnanalyzedSessions` 扫 `~/.claude/projects/**/*.jsonl`，找出未分析或文件已变更的会话文件 → 逐文件读取转录内容 → `analyze.analyzeSession`（LLM）提取 findings（bug / solution / pattern / preference）→ `store.addSession` / `patchSession` 把 findings 写入 bank；`analyzeSession` 返回 `null` 表示调用失败、该文件跳过不推进，返回 `[]` 表示正常无产出、推进游标；
   - **Phase 2（批量合成）**：汇总 bank 中所有 sessions 的 findings → `synthesize.synthesizeMemories`（LLM）合成为跨会话 memories → `store.addMemory` 写入 bank；返回值语义同 Phase 1；
3. `writeRenders`：`render.renderMarkdown` 渲染 → 落盘 `memory-bank.md` → `ensureImport` 挂进 CLAUDE.md。

另有手动触发路径：`src/entrypoints/web/routes-memory.js` 直接调 `runOnce`。
数据流：`~/.claude/projects/**/*.jsonl → scan-sessions → analyze(LLM, Phase 1) → store(sessions/findings) → synthesize(LLM, Phase 2) → store(memories) → render → 磁盘 memory-bank.md`，纯函数各司其职，只在 `index.js` 汇成 IO。

### 流程 C：项目体检 → 一键优化（编排在模块外）
入口在 `src/entrypoints/web/optimize-ops.js`（HTTP 侧在 `routes-optimize.js`），本目录只提供零件：
1. **体检**：`optimize-ops` 调 `checkup/index.runStaticCheckup`(同步跑 map / rules) → 异步补跑四个专属检测器（`check-prompts` / `check-comments` 走 LLM，`check-tests` / `check-hygiene` 起子进程）与十个 audit 维度（`audit-engine` 按 `registry` 声明驱动）→ `score.logic.aggregateScore` 汇总、`recomputeReport` 原地回填同一个 report 对象。
2. **优化**：`fix-plan.selectFixableRules` / `fix-map.logic.selectFixableMap` / `fix-engine.logic.selectFixableDims` 三处选材 → `backup.createBackup` 打快照（**计划先于动作**，条目含 `fix-engine.planEngineEntries` 的产出）→ `fix-rules.demoteOne`(rules→skill) / `fix-map.*`(地图) / `fix-engine.runFixForDim`(其余 15 维) 执行 → `backup.recordPostState` 回填哈希 → `fix-plan.buildFixNotes` 生成手工待办。
3. 所有 `fix-*` / `gen-*` / 策略 / 审计引擎 **从不抛异常**，靠返回值 status / fatal / ok 表达——因为上层是循环，一次抛错会把整批停在半路。

**流程 C 的实际形状（17 维）：**
- **体检**：`runStaticCheckup` 同步出 map / rules → 其余全部标 `analyzing` → 后台一次 `collectEvidence`（十维共用）→ 四个专属检测器 + 十个 audit 维度**并行**（audit 侧共用**全局**信号量限 4，否则十维各限 4 就是 40 个子进程）→ `mergeAugmentDim` 并入宿主 → **最后**跑 `checkHolistic`（它读的就是前面的结论）。
- **优化**：按 `fixOrder` 分三段插进既有的 map / rules 专用流程之间：`<30` 机械与配置层 + 补测试 → map / rules → `30~39` 文档层 → `40~89` 源码层（此时才开测试闸）+ 只出清单的维度 → 最后写 `PLAN.md`。

关键判断：**`checkup` / `optimize` 目录里没有主循环**，谁按什么顺序调它们，看 `optimize-ops.js`。

## 常见改动入口

- 要改 **owner 飞书对话的接管边界**（哪些消息让路给 feedback）→ 改 `claude-exec/logic.js` 的 `shouldOwnerExec`。
- 要改 **飞书回复的格式 / 分片上限 / 失败文案** → 改 `claude-exec/reply.js`。
- 要改 **claude-exec 的执行参数**（工作目录、bypassPermissions、session 续接、user-log 埋点）→ 改 `claude-exec/index.js` 的 `handle`。
- 要 **新增一个对话 feature** → **不在本目录**，去 `src/plugins/` 建插件并在 `src/plugins/index.js` 登记（见根 CLAUDE.md）；本目录 `index.js` 只装配内核，不加业务 feature。
- 要改 **记忆库何时跑**（窗口 / 冷却 / 额度门槛 / busy 判定）→ 改 `memory-bank/schedule.js`。
- 要改 **Phase 1 分析提示词 / findings 字段定义** → 改 `memory-bank/analyze.js`；要改 **Phase 2 合成提示词 / memories 字段定义** → 改 `memory-bank/synthesize.js`。
- 要改 **会话扫描范围 / 变更检测策略** → 改 `memory-bank/scan-sessions.js`；要改 **注入预算 / 渲染格式** → 改 `memory-bank/render.js`。
- 要改 **一轮提炼的 IO 编排 / 落盘 / 游标推进 / tick 频率** → 改 `memory-bank/index.js`。
- 要 **新增一个体检维度** → **在 `project-checkup/dimensions/registry.js` 加一条声明**（判据文案进 `rubrics-*.js`、召回器进 `evidence/selectors-*.logic.js`），再在前端 `public/js/optimize-view.logic.js` 的 `DIM_META` 加对应一行（那份手抄由 `optimize-view.logic.test.js` 的交叉校验钉住）。**不要**动 `score.logic.js`、`project-checkup/index.js`、`optimize-ops.js`——它们全部从注册表派生。
- 要 **改某个新维度的判据 / few-shot** → 改 `dimensions/rubrics-code.js` 或 `rubrics-project.js`；要改**召回什么**（阈值、正则、排除规则）→ 改对应 `evidence/selectors-*.logic.js`。
- 要 **调判分系数**（`factor` / `maxDeduct` / verdict 权重）→ 改注册表的 `scoring` 与 `verdicts`；调之前先看 `verdictLog`，那里留着每一轮的全量判定可横向对比。
- 要 **加一种修复策略** → 建 `project-optimize/strategies/<name>.js`，在 `fix-engine.logic.js` 的 `claims` 里定认领规则、在 `fix-engine.js` 的分派里加一支。
- 要 **改「什么时候敢改源码」** → 改 `project-optimize/test-gate.logic.js` 的 `decideGate`（这是全功能最重要的一道安全闸）。
- 要 **改整体行动计划的形状 / 要求** → 改 `project-checkup/check-holistic.logic.js` 的 `buildHolisticPrompt`；改它的渲染 → 改 `strategies/advisory.logic.js` 的 `renderPlan`。
- 要改 **某维度的判分标准** → 改对应 `check-*.logic.js`（纯函数，动它先看 `.test.js`）；要改 **扫描 / 取样 / 跑测试的 IO** → 改对应 `check-*.js`。
- 要改 **手工待办文案 / 告知口径** → 改 `project-optimize/fix-plan.logic.js` 的 `buildFixNotes`（它是「不说就会被误以为已处理好」那几件事的唯一出口）。
- 要改 **rules→skill 降级逻辑** → 文本变换在 `fix-rules.logic.js`、fs 执行 / 失败分级在 `fix-rules.js`。
- 要改 **地图修复 / 生成** → 写盘在 `fix-map.js`、选材 / 幂等合成在 `fix-map.logic.js`、正文生成在 `gen-map.js`、喂给模型的事实包在 `map-facts.js`。
- 要改 **备份 / 还原 / 二次修改检测** → 改 `project-optimize/backup.js`（纯逻辑在 `backup.logic.js`）。

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
- `project-checkup/index.js` — `runStaticCheckup` 同步跑静态维度(map / rules)、其余留 `analyzingDim` 占位待异步回填；`recomputeReport` 原地重算总分。
- `project-checkup/check-map.js` + `.logic.js` — 维度①项目地图：遍历模块、比对 mtime 判过期、扫死链。
- `project-checkup/check-prompts.js` + `.logic.js` — 维度②提示词质量：静态捞候选 + LLM 判分。
- `project-checkup/check-comments.js` + `.logic.js` — 维度⑤注释合理性：抽样注释块 + LLM 判「是否解释为什么」。
- `project-checkup/check-rules.js` + `.logic.js` — 维度③：判 `.claude/rules/` 哪些该降级为 skill。
- `project-checkup/check-tests.js` + `.logic.js` — 测试健康度：起子进程跑测试命令 + 判大文件缺测试。
- `project-checkup/check-hygiene.js` + `.logic.js` — 仓库卫生（原恒为 disabled 的 deadcode 槽位落地）。
- `project-checkup/score.logic.js` — `aggregateScore` 加权总分 / 等级；仅 done 维度参与、权重按比例分摊。
- `project-checkup/scan-dirs.logic.js` — 三个扫描维度共用的目录排除规则 `shouldSkipDir`。
- `project-checkup/fingerprint.logic.js` — LLM 维度的缓存指纹与失效判定。
- `project-checkup/frontmatter.logic.js` — 极简 YAML frontmatter 解析。
- `project-checkup/git-tracked.js` — `git ls-files`，「什么是真实源码」的权威来源。

### project-optimize/（修复器 / 生成器库，无 index.js，编排在 optimize-ops）
- `project-optimize/fix-plan.logic.js` — 从体检报告选可自动修的维度(`SUPPORTED_DIMENSIONS=['rules','map']`)、生成「机器做不了」的手工待办 notes。纯函数。
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
1. **体检**：`optimize-ops` 调 `checkup/index.runStaticCheckup`(同步跑 map / rules) → 由其 RUNNERS 表异步补跑 `check-prompts` / `check-comments`(LLM) 与 `check-tests` / `check-hygiene`(子进程) → 每个 `check-X.js` 调自己的 `check-X.logic.js` 判分 → `score.logic.aggregateScore` 汇总、`recomputeReport` 原地回填同一个 report 对象。
2. **优化**：`fix-plan.selectFixableRules` / `fix-map.logic.selectFixableMap` 选材 → `backup.createBackup` 打快照（**计划先于动作**）→ `fix-rules.demoteOne`(rules→skill) 或 `fix-map.*`(地图，正文由 `gen-map` + `map-facts` 只读沙箱产出) 执行 → `backup.recordPostState` 回填哈希 → `fix-plan.buildFixNotes` 生成手工待办。
3. 所有 `fix-*` / `gen-*` **从不抛异常**，靠返回值 status / fatal / ok 表达——因为上层是循环，一次抛错会把整批停在半路。

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
- 要 **新增一个体检维度** → 建 `project-checkup/check-<dim>.js` + `.logic.js`，权重进 `score.logic.js`，并到 `optimize-ops.js` 的 RUNNERS 登记（调度在模块外）。
- 要改 **某维度的判分标准** → 改对应 `check-*.logic.js`（纯函数，动它先看 `.test.js`）；要改 **扫描 / 取样 / 跑测试的 IO** → 改对应 `check-*.js`。
- 要改 **哪些维度能自动修 / 手工待办文案** → 改 `project-optimize/fix-plan.logic.js`。
- 要改 **rules→skill 降级逻辑** → 文本变换在 `fix-rules.logic.js`、fs 执行 / 失败分级在 `fix-rules.js`。
- 要改 **地图修复 / 生成** → 写盘在 `fix-map.js`、选材 / 幂等合成在 `fix-map.logic.js`、正文生成在 `gen-map.js`、喂给模型的事实包在 `map-facts.js`。
- 要改 **备份 / 还原 / 二次修改检测** → 改 `project-optimize/backup.js`（纯逻辑在 `backup.logic.js`）。

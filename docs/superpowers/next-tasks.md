# 剩余任务与交接（新会话继续开发用）

- 日期：2026-10-08（续会话后更新）
- 用途：本文件是**跨会话交接单**。新会话开工前先读根 `CLAUDE.md` + 对应目录的 `CLAUDE.md`，再看本文件认领任务。
- 当前状态：工作区累计 **72 个修改 + 2 个删除（active-runs 退役）+ 96 个新增**（含 `benchmarks/` 整套目录与七份追加特性 spec；以 `git status` 为准），`npm test` **3763 全绿**（基线 3531；T2 净增 97、T5 +21、T6 +37、T7 +9、凭证多模型 +20、输入区工具栏 +9、空输出事故 +2、无上限+收尾 +4、工具清单分叉 +4、模式修复 +2、联网/子代理四工具 +20 个用例；A8 计入既有危险命令用例扩充），**e2e 12/12（含四工具与排空档位修复批次复跑全绿）**。**T1~T7 全部完成（2026-10-08）**；另有八条用户点单的追加特性（见 §一末）。

---

## 一、已完成（了解边界用，勿重复做）

### 首会话交付（2026-09-30）

| # | 交付 | 关键文件 | spec |
|---|---|---|---|
| 1 | openai 路径内置文件/命令工具（Read/Write/Edit/Glob/Grep/Bash + 系统提示词 + 审批） | `src/providers/builtin-tools.js` | —（roadmap C） |
| 2 | 委托同事对话：AskColleague/WaitColleagueReply + 判定引擎自动追问到结论 + turn 路由截获 | `src/capabilities/feishu-ask{,.logic,-tools}.js`、`routes-requirements.js` | —（roadmap C） |
| 3 | 自动开发自检门 Phase 1：完成=验证器判定；失败带输出重试 1 次；卡片自检行 | `src/capabilities/verifier{,.logic}.js`、`src/plugins/team-tools/auto-dev/verify{,.logic}.js` | `2026-09-30-verify-gate-design.md` |
| 4 | 内置 MCP（context7/Figma 双形态）+ Superpowers skills + 开关 + 打包 | `src/capabilities/builtin-mcp.js`、`builtin-skills.js`、`scripts/superpowers-fetch.mjs`、`/api/builtins` | `2026-09-30-builtin-mcp-and-skills-design.md` |
| 5 | Repo Map Phase 1：确定性代码地图注入 openai 路径（含任务关键词加权、增量缓存） | `src/features/repo-map/`、`src/store/repo-map-cache.js` | `2026-09-30-repo-map-design.md` |
| 6 | agent-loop 加固：invalid 调用不执行/不重复结果、finishReason=error 不再吞、适配器透传 invalid | `src/providers/agent-loop.js`、`openai-compat-model.js` | —（roadmap C） |
| 7 | 顺手修复：sidecar staging 生命周期脚本剥离（postinstall 拖挂打包链）、内置能力区 UI 打磨（switch/输入框/换行） | `scripts/prepare-sidecar.mjs`、`public/js/settings-panel.js`、`public/app.css` | — |

### 续会话交付（2026-09-30，T1/T3/T4）

| # | 交付 | 关键文件 | spec |
|---|---|---|---|
| 8 | **T1 验证门 Phase 2**：设置页「自检命令」输入框；自动发现（`package.json` 真实 test 脚本 → `npm test`，剔除 npm init 占位脚本；`resolveVerifyCommand` 与 prompt/复跑同源）；任务面板展示 `verify.summary` | `src/capabilities/verifier{,.logic}.js`、`src/plugins/team-tools/auto-dev/verify.js`、`public/{index.html,js/bots-panel.js,js/tasks-panel.js}` | `2026-09-30-verify-gate-design.md` §7 |
| 9 | **T3 内置能力收尾**：chat 工具弹层合并内置 MCP/Skills（同源 toggle）；per-skill 开关（`disabledSkills` 存储 + `/api/builtins` skillId 分支 + 设置页折叠明细 + Claude 路径「启用视图」镜像物化，不牵连项目级技能）；openai Skill 机制评估稿 | `public/js/chat.js`、`src/capabilities/builtin-skills.js`、`src/{store/settings.js,entrypoints/web/routes-settings.js,shared/builtin-ids.js}` | `2026-09-30-builtin-mcp-and-skills-design.md` §7、`2026-09-30-openai-skill-mechanism-design.md` |
| 10 | **T4 Repo Map Phase 2**：类方法附加抽取器（JS/TS 词法扫描 + Python；共享件零改动）；缓存 `version`（口径升级整体作废）；`RepoMap` 工具（query 过滤 / 12000 预算 / `refresh=true` 强制重建；注入式装配）；Claude 路径注入评估备忘 | `src/features/repo-map/extra-symbols.logic.js`、`src/providers/builtin-tools.js`、`src/entrypoints/web/run-openai.js`、`src/entrypoints/web/tool-summary.js` | `2026-09-30-repo-map-design.md` §7/§8 |

### T2 · Run 事件流 v2 + 任务状态机 —— ✅ 全部完成（2026-10-08，P1~P5）

| 阶段 | 交付 | 关键文件 |
|---|---|---|
| P1 提交幂等 | `requestId` 认领去重（web 起跑/插话回放 + 飞书 messageId 持久去重，跨进程重启） | `src/store/submissions.js` |
| P2 journal + index 影子 | run 事件流（追加式事实流）＋可查询索引；先影子双写、只写不读 | `src/store/run-journal.js`、`src/store/run-index.js`、`src/entrypoints/web/run-durability.js` |
| P3 openai 检查点试点 | `onMessages` 每步落盘 + 悬空 tool-call 修复 + 检查点续跑（不追加「继续」）；**含 ai@7 `system→instructions` 存量修复** | `src/providers/agent-loop.js`、`src/entrypoints/web/run-openai*.js`、`tests/e2e-openai-resume.mjs` |
| P4 busy inbox | `capabilities:{steer,followUp}` + conv 级 follow-up 队列 + 同会话并发闸（/start、/send、飞书注入全走 inbox）+ 前端排队发现接流 | `src/store/runs.js`、`src/entrypoints/web/conv-inbox.js`、`src/entrypoints/web/routes-run.js`、`src/entrypoints/web/conv-notify.js`、`public/js/chat.js`、`tests/e2e-follow-up-queue.mjs` |
| P5 对账切换 | `classifyInterrupted` 统一归类 + `reconcileRuns` 读 journal/index 对账；停写并删除 active-runs（含升级迁移）；pending 收敛为排程器 | `src/entrypoints/web/run-reconcile*.js`、`src/entrypoints/web/run-claude.js`、`src/store/run-index.js`（`migrateLegacyActiveRuns`） |

spec：`docs/superpowers/specs/2026-10-08-run-event-stream-v2-and-state-machine-design.md`（§10 实施状态已全勾；§9 验收清单中「kill 真进程」「飞书真重投」两项留维护者手工验收）。

### T5 · 内部 Benchmark —— ✅ 完成（2026-10-08）

- **题源**：本仓历史修复回放（SWE-bench 式）——`fixRef` 工作树回退到父提交 + 植入该提交的测试作判据 + 人工改写的用户口吻输入；判据对 agent 可见（与生产一致：模型本就能跑工程测试）。
- **CLI**：`node benchmarks/run.mjs --list | --scan [--write] | --validate | --run`；`--run` 产出**通过率 / 回合数 / token 成本**三张表（`benchmarks/results/`，gitignore，只手动触发、消耗额度）。
- **基建**：`benchmarks/lib`（cases/report/runner 三层纯函数 + 单测，含真 git fs 级「worktree/植入/防篡改重置/清理」全链测试）+ `auto-dev/prompt.logic.js`（develop 提示词模板，生产与评测共用）+ SDK `num_turns` 透传（`integrations/claude.js`）。
- **题集**：**25 条**（扫描 28 候选 → 剔除 2 条「修复前即通过」假题 + 1 条超时 → 人工策展），`--validate` 25/25 全部「修复前判据失败」。
- spec：`docs/superpowers/specs/2026-10-08-internal-benchmark-design.md`；首次真跑与 baseline 存档待维护者手动执行（`node benchmarks/run.mjs --run`）。
- 提交建议：`feat(benchmark): 内部 benchmark——本仓历史修复回放 + 三张指标表`（含 prompt.logic 抽取与 numTurns 透传）。

### T6 · 工具策略引擎 + Bash 执行后端 —— ✅ 完成（2026-10-08）

- **规则表**（`capabilities/tool-policy.logic.js`，纯函数）：`档位 × 类别` 矩阵（四档 mode + 无人值守 standard/trusted）、危险命令 deny 名单（删根/毁盘/关停/fork 炸弹/全盘改权限，宁漏勿误杀）、安全命令表（单段例行命令）；`resolveUnattendedPolicy` 收 `bot.execPolicy → 档位 + SDK mode`。
- **运行时门**（`capabilities/tool-policy.js`）：无人值守 `ask→deny` 翻译 + 策略拦截计次（达 3 熔断 `onFuse` 恰一次，`stopRun` + 系统通知/会话卡片；交互路径只 deny 不熔断）；`PRETOOL_ASK_HOOK` 与 `buildUnattendedClaudeOpts`（直调 runClaude 路径）同源。
- **两条路径接入**：Claude（run-claude `canUseTool` 走门，档位实时读 `run.mode`）；openai（首次获得 mode，routes-run/chat.js 透传）；**无人值守三入口**（requirement-ops / colleague-dev / task-ops develop）从写死 bypass 改为按 `bot.execPolicy` 解析（默认 bypass=改动前一致）；`builtinApprovalDecision` 与 `READONLY_TOOLS` 退役（逻辑并入规则表）。
- **Bash 容器后端（openai 路径）**：`providers/exec-backends{,.logic}.js`（docker/podman 探测 + `settings.exec` 配置 + 工作区挂载/默认无网 + 引擎不可用 fail-closed 不退回本地）；`builtin-tools` Bash 执行核接受 `bashBackend` 注入。
- **配置与 UI**：`bot.execPolicy` 全链（store/API/设置页机器人表单下拉）；`settings.exec` 全链（store/API；设置页 UI 下期，settings.json 可配）。
- 行为变化备忘（收紧/等价）：WebFetch/WebSearch 由静默放行改为网络类审批；openai 未传 mode 时等价现状；acceptEdits 档下 Bash/网络回到「仍需审批」（SDK 语义对齐）。
- spec：`docs/superpowers/specs/2026-10-08-tool-policy-and-exec-backends-design.md`。
- 提交建议：`feat(policy): 工具策略引擎（共用规则表 + 无人值守档位/熔断）`、`feat(providers): Bash 容器执行后端（openai 路径）`。

### T7 · 上下文压缩方案定型 —— ✅ 完成（2026-10-08）

- **问题**：`conv-messages` 原先追加时硬截 200 条，切点不看角色——tool 序列被拦腰切开可能 400，且旧消息被物理丢弃。
- **交付**：`conv-compact.logic.js`（切点选 user 整轮边界 + 触发口径 + 转录格式化 + 滚动摘要 prompt）；`conv-messages.js` **v2 单文件形状**（`{messages, summary}` 同锁原子、v1 读侧兼容、`MAX_STORED=1000` 安全边界裁剪 + `covered` 同锁平移）；`run-openai.js#maybeCompactHistory`（同凭证一次性零工具调用生成滚动摘要，**fail-open**；模型视角 = system(含摘要) + 近期视图，原文保留）；`loadRepairedHistory` 追加头部孤儿 tool 结果剔除。
- **口径**：可见长度 > 200 触发；保留最近 ≥100（user 边界取整轮）；新丢 ≥20 才动手；摘要失败本轮按原文继续。
- **验证**：`npm test` 3695 全绿；`npm run test:e2e` 12/12（`e2e-openai-resume.mjs` 读盘断言已随 v2 形状适配——上线时实锤抓出该形状回归并修复）。
- spec：`docs/superpowers/specs/2026-10-08-context-compaction-design.md`。
- 提交建议：`feat(openai): 上下文压缩——滚动摘要 + 原文保留 + 边界安全截断`。

### 追加特性（2026-10-08，用户点单，非路线图内）

| # | 交付 | 关键文件 | spec |
|---|---|---|---|
| A1 | **凭证多模型发现（OpenCode 式）**：凭证=接入（key/baseURL），添加后自动拉 `/models`（失败不阻塞，可刷新）；聊天模型弹层按凭证分组展示全部模型；`credentialModels` 读侧单一事实源（legacy `model` 回落）；模型发现含 effort 元数据 | `src/entrypoints/web/provider-models{,.logic}.js`、`routes-settings.js`、`store/settings.js`、`public/js/{settings-panel,onboarding,chat}.js` | `2026-10-08-credential-multi-model-design.md` |
| A2 | **输入区工具栏 + 强度体系**：模型/强度/权限/通知全部下沉输入框底栏（发送内嵌、输入区加高）；强度**滑块化**——Claude 五档 + Ultracode 最高档（开编排强制 xhigh，选中时轨道横向流光），自定义模型用 `/models` 的 supported_levels（+关闭思考），无元数据置灰；`reasoning_effort` 全链透传（含续跑/follow-up 快照） | `public/{index.html,app.css,js/chat.js,js/effort.logic.js}`、`src/entrypoints/web/{run-openai,routes-run,conv-inbox}.js`、`src/providers/openai-compat{,-model}.js` | `2026-10-08-composer-bar-and-effort-design.md` |
| A3 | **openai run「(无输出)」事故修复**：工具循环预算 8→50（A4 起改为默认无上限）+ 用尽时 `exhausted` 提示不再静默；档位归一加固（切模型即校，杜绝 xhigh 泄漏）；`providerOptions` 弃用键改 `openaiCompat`；逐模型步/完成/失败日志 + usage 透传（journal tokens 不再恒 0） | `src/providers/{agent-loop,openai-compat-model}.js`、`src/entrypoints/web/run-openai.js`、`public/js/chat.js` | `2026-10-08-openai-run-empty-output-fix.md` |
| A4 | **工具循环默认无上限 + 强制收尾（OpenCode 式）**：`maxSteps` 默认 ∞（0/空/非法同；对齐 Claude Code/OpenCode）；基础设置「工具循环上限（自定义模型）」可配；有限上限用尽时注入收尾指令再要一轮文字总结（**收尾轮禁工具**、总结落检查点），失败 fail-open；`uiPrefs.openaiMaxSteps` 全链（store/API/设置页）+ `resolveMaxSteps` | `src/providers/{agent-loop,openai-compat-model}.js`、`src/entrypoints/web/{run-openai,run-openai.logic,routes-settings}.js`、`src/store/settings.js`、`public/{index.html,js/settings-panel.js}` | `2026-10-08-unlimited-steps-and-forced-wrapup.md` |
| A5 | **工具弹层按 provider 展示真实工具集**：自定义模型展示 openai 路径实际装配的 Read/Write/Edit/Glob/Grep/Bash/RepoMap/AskColleague/WaitColleagueReply（Claude 专属的 WebSearch/Task/Workflow/TodoWrite 不再出现）；Skills 段在 openai 下隐藏；开关经 `decideToolAction` 按名真实生效 | `public/js/{tool-list.logic.js,chat.js}` | `2026-10-08-per-provider-tool-list.md` |
| A6 | **模式链路修复（用户反馈「选了自动还是每次都询问」）**：实锤根因=**排队排空轮丢档位**（自动档首 run 0 次审批、排空轮 23 次审批）；修复：排空携带档位且**优先取排空时刻原 run 的最新值**；openai 策略门改**实时读 run.mode**（中途切档即刻生效）；`setRunMode` 支持 openai 四档中途切换（放宽顺手放行挂起审批，Claude 保持「仅放宽」）；续跑恢复 `entry.mode`；journal/日志记录真实 mode | `src/entrypoints/web/{run-openai,conv-inbox}.js`、`src/store/runs.js`、`public/js/chat.js` | A3/A4 spec 补记 |
| A7 | **自定义模型补四工具**：WebFetch（本地抓取+HTML→文本）、TodoWrite（落 run.todos 任务面板）、WebSearch（内置 API：Tavily/Brave/博查，key 进设置页「联网搜索」）、Task（只读子代理：Read/Glob/Grep/WebFetch/WebSearch/RepoMap，禁递归；审批复用主 run） | `src/capabilities/web-tools{,.logic}.js`、`subagent.logic.js`、`src/providers/builtin-tools.js`、`src/entrypoints/web/{run-openai,routes-settings}.js`、`src/store/settings.js`、`public/**` | `2026-10-08-openai-web-and-subagent-tools.md` |
| A8 | **agent `taskkill` 自灭后端事故修复**：事故=自定义模型（自动档）为清理探针服务器执行 `taskkill /f /im node.exe` 按镜像名杀光全部 node（含后端 sidecar 自身），日志戛然而止、无 WER；修复=危险命令表新增 `kill_process`（taskkill/pkill/killall/Stop-Process）与 `kill_signal`（kill -N），**全档位无条件 deny**，拒绝文案给「按 PID 精准处理/脚本自行退出」引导 | `src/capabilities/tool-policy.logic{,.test}.js` | `2026-10-08-agent-taskkill-self-kill-incident.md` |
| A9 | **强度控件三处修复（用户反馈）**：① 强度默认空 —— 凭证归属认领收敛成纯函数 `rehomeCustomCred` 并在**启动/还原会话/打开模型弹层**三处同源调用（原先只在弹层里认领，导致必须点一次模型选择才出档），`ensureCustomCreds` 取失败/非 2xx 不写坏缓存，未知态显示 `强度 · …` 并自动补拉（1.5s ×3）；② 强度面板改**点击**弹出（与模型/权限同款，删掉 hover 那套状态与监听）；③ Ultracode 流星改**斜 35° 坠落**（`rotate(215deg)`，起点改铺面板左上外侧） | `public/js/{effort.logic.js,effort.logic.test.js,chat.js}`、`public/app.css` | `2026-10-08-composer-bar-and-effort-design.md` §10 |

- 提交建议：`feat(credentials): 凭证多模型发现——添加即拉取 /models，模型选择按凭证分组`（A1）、`feat(ui): 输入区工具栏 + 强度滑块（含 Ultracode 流光与自定义模型 reasoning_effort）`（A2）、`fix(openai): 工具循环预算与可观测性——修复半途截断的「(无输出)」`（A3）、`feat(openai): 工具循环默认无上限 + 强制收尾（OpenCode 式，可配上限）`（A4）、`fix(ui): 工具弹层按 provider 展示真实工具集（自定义模型不再显示 Claude 工具）`（A5）、`fix(openai): 权限模式实时生效——策略门改读 run.mode + 续跑/排队不再丢档位`（A6）、`feat(openai): 自定义模型补四工具——WebFetch/TodoWrite/WebSearch（内置 API）/Task 只读子代理`（A7）、`fix(policy): 危险命令表新增进程击杀类——修复 agent 用 taskkill 自灭后端的事故`（A8）。

**建议提交分组**（维护者自行决定时机与拆分）：

1. `feat(providers): openai 路径内置文件工具 + 系统提示词`
2. `feat(feishu-ask): 委托同事对话（子引擎追问到结论再交回）`
3. `feat(auto-dev): 自检门 Phase 1+2（验证器判定 + 自动发现）`
4. `feat(builtin): 内置 MCP 与 Superpowers skills（开关化 + per-skill + chat 弹层）`（含 sidecar 打包修复）
5. `feat(repo-map): 代码地图 Phase 1+2（注入 + RepoMap 工具）`
6. `fix(providers): agent-loop 无效工具调用防线 + finishReason=error`
7. `docs: specs（三份 + openai skill 评估稿）+ 各模块地图同步`

**T2 建议提交分组**（接在 1~7 之后）：

8. `feat(durability): submissions 提交幂等 + run journal/index + openai 检查点续跑`（T2-P1~P3）
9. `feat(web): busy inbox——follow-up 排队与同会话并发闸`（T2-P4）
10. `refactor(run): 启动对账切换 run-index，active-runs 退役`（T2-P5）

**T5 / T6 / T7 建议提交分组**：

11. `feat(benchmark): 内部 benchmark——本仓历史修复回放 + 三张指标表`（T5）
12. `feat(policy): 工具策略引擎——共用规则表 + 无人值守档位/熔断`（T6-P1）
13. `feat(providers): Bash 容器执行后端（openai 路径）`（T6-P2）
14. `feat(openai): 上下文压缩——滚动摘要 + 原文保留 + 边界安全截断`（T7）

---

## 二、剩余任务（按推荐顺序）

**（无。90 天路线图全部条目已落地：T1 验证门、T3 内置能力、T4 Repo Map、T2 Run 事件流、T5 Benchmark、T6 策略引擎、T7 上下文压缩。）**

后续方向（未立项，视需要再评估）：容器后端扩到 Claude 路径（整体容器化 CLI）、execPolicy 无人值守默认档从 bypass 收紧、openai 步边界 steer、provider 抽象的多实例/多机器人并发在线。

---

## 三、已知边界 / 小项

- **MCP 工具输入不做 JSON Schema 类型校验**（agent-loop 加固时实测：`jsonSchema()` 形态下 `{path:123}` 直接放行；zod 形态有校验）。记录在 `src/providers/openai-compat-model.js` 注释。可后补轻量校验或依赖 MCP server 自身校验。
- **busy inbox 边界（T2-P4）**：follow-up 队列是纯内存的（进程重启即丢；journal 里有 `follow_up` 事实，但本期不做跨重启恢复）；openai 的 follow-up 不支持「立即生效」——它没有工具执行中途的注入接口，`/msg/now` 回 `ok:false,mode:'follow_up'`；步边界 steer（openai 中途纠偏）留作后续增强（spec §6 决策 4）。
- **对账切换边界（T2-P5）**：升级首启把 `active-runs.json` 存量并入 `run-index.json` 并清空旧表（此后旧文件不再被读写；损坏时保留原文件跳过迁移）；「会话尚未建立」的孤儿（判档窗口/首轮 init 前崩溃）现在会落一次 `abandoned` 提示（此前是静默丢弃），文案是通用的「已停止自动重试，如需继续请手动发送消息」。
- **打包态真机验证**：verify gate、repo map、内置 MCP/Skills 在 Tauri 打包版跑一遍（`assets/builtin/superpowers/` 已随 sidecar stage；`prepare-sidecar.mjs` 已剥离生命周期脚本）。
- **新机自动拉技能**：`npm install` 的 `postinstall --if-missing` 会拉 Superpowers（fail-open）；离线时设置页显示「未安装」，`npm run setup:superpowers` 可补。
- **`.gitignore` 已覆盖**：`assets/builtin/`、`repo-map-cache.json`、`.bench-ws/`、`benchmarks/results/`。
- **benchmark 已知边界（T5）**：判据（测试文件）对 agent 可见——测的是「明确完成标准下自主干对」，不是猜测试；题集全部来自本仓历史（业务仓案例可按同一 schema 后续补入）；真跑消耗额度，只手动触发。
- **工具策略已知边界（T6）**：① Claude `bypassPermissions` 档下 SDK 不调用 `canUseTool`，危险命令 deny 名单拦不到（用户在 UI 显式选 bypass 的已知边界；openai 路径 bypass 档仍拦）；② 容器后端只覆盖 openai 路径的自研 Bash——Claude 路径的 SDK Bash 未容器化，其安全靠策略表 + 人工合并；③ `settings.exec` 的设置页 UI 下期（settings.json / `/api/settings` 的 `exec` section 可直接配）；④ 引擎探测有 60s 缓存，装好 docker 后最多 1 分钟生效。
- **T6 行为变化备忘**（收紧/等价，均已在 spec §6 记录）：WebFetch/WebSearch 从静默放行改为网络类审批；openai 未传 mode 时等价现状（非白名单全问）；acceptEdits 档下 Bash/网络从「隐式全放行」回到「仍需审批」（与 SDK 语义对齐）。
- **上下文压缩已知边界（T7）**：触发按**消息条数**（可见长度 >200；token 估算未做）；摘要用**会话自己的 openai 凭证**（零工具一次性调用），失败 fail-open 本轮按原文继续；`MAX_STORED=1000` 的磁盘 backstop 会让被摘要覆盖的旧原文最终漂出磁盘（模型可见性早已由摘要接续）；Claude 路径不适用（SDK `autoCompactEnabled`）。

---

## 四、继续开发的流程约定（速记）

1. 大改动**先出 spec**（`docs/superpowers/specs/YYYY-MM-DD-<name>.md`）+ 拍板记录，再实现；
2. 每个 `*.logic.js` 配 `*.test.js`；文件系统相关配 `*.fs.test.js`；
3. 完成后：`npm test` 全绿（当前基线 **3695**）+ 相关 e2e（`npm run test:e2e -- panels-smoke`）；同步更新对应模块的 `CLAUDE.md` 与 `docs/superpowers/roadmap.md`；
4. 不自动 `git` 提交，改动留工作区；提交由维护者拍板。

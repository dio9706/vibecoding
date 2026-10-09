# src/providers · 模块地图

> 本目录是**模型 provider 层**：内核不认识具体模型，只经 `index.js` 拿 `get(id).run(...)` 这一个契约（返回 `{ done, abort }`）。当前两员——默认的 `claude-agent` 与 `openai-compat`——分野极大，是读这层的第一把钥匙：
>
> **`claude-agent` 是薄适配**：agent loop / 工具 / 文件读写 / 续接 / 流式 / 审批 / 限流 / 自动压缩全由 Claude Agent SDK 白送，`run()` 只把 opts 透传给 `integrations/claude.js` 的 `runClaude`，本模块不碰任何 SDK 细节。**`openai-compat` 是手搓**：OpenAI 兼容链什么都不白送，于是这层自带**手动 agent loop（`agent-loop.js`）+ 模型 adapter（`openai-compat-model.js`）+ 内置文件/命令工具（`builtin-tools.js`）+ MCP 工具接入（`mcp.js`）**四件套；工具侧以内置七件套打底（任何支持 Function Calling 的模型开箱可用），联网/清单/子代理/委托同事等扩展由入口装配（`capabilities/web-tools`、`capabilities/subagent.logic`、`capabilities/feishu-ask-tools`），MCP 是可选增强。所以本目录的代码量几乎全压在 openai-compat 一侧。provider 契约与内核落点见仓库根 `docs/ARCHITECTURE.md`。

## 一、文件清单

- `registry.js` — 纯注册表工厂 `createRegistry()`：`register/get/has/list` 收口，**无任何内置 provider**（刻意留空以便隔离单测），`get` 未注册即抛，`register` 同 id 覆盖（便于测试注入替身）。
- `index.js` — 默认注册表：`createRegistry()` 后注册 `claude-agent` + `openai-compat`，解构导出 `{ register, get, has, list }`。内核**唯一**从这里取 provider。
- `claude-agent.js` — Claude Agent provider：`run()` 透传 opts 给 `runClaude`，能力全开（`CLAUDE_CAPABILITIES`）；工厂 `createClaudeAgentProvider(runFn)` 注入 runFn 以避免单测触达 SDK/网络。
- `openai-compat.js` — OpenAI 兼容 provider：`run(input, hooks)` 惰性建 modelRun 再跑 `runAgentLoop`；能力 `resume` 自 T2-P3 起为 true（conv-messages 即检查点 + run-index 对账续跑）、`compaction` 自 T7 起为 true（编排层滚动摘要，机制在 `entrypoints/web/run-openai.js` + `store/conv-messages.js`），`rateLimitAware` 仍 false。**强度透传**：`input.effort` → `createOpenAiCompatModelRun({reasoningEffort})` → streamText `providerOptions.openaiCompat.reasoningEffort`（非弃用键；可空）。**刻意不静态 import** `openai-compat-model.js`（见流程 C）。
- `openai-compat-model.js` — 模型 adapter：把 `ai` 的 `streamText` 的 `fullStream`/result 映射成 agent-loop 期望的 `{ stream, finished }`。**唯一**封装 AI SDK 版本细节（`text-delta`/`tool-call` part、`finishReason`/`responseMessages` 取法）之处。工具调用映射会透传 `invalid`/`errorText`（实测：AI SDK 只对 zod 形态的 inputSchema 做校验；MCP 的 JSON Schema 参数类型不被校验，详见文件内注释）。**system 拆分**（2026-10-08 实锤）：ai@7 不允许 system 混在 messages 里（抛 `InvalidPromptError`），本层统一拆到 `instructions`——生产路径此前把 system 放 messages 首条，真实调用必失败，属单测 mock 漏网、T2-P3 真端点冒烟捞出的存量 bug。
- `agent-loop.js` — Provider/SDK 无关的手动 agent loop `runAgentLoop`：依赖注入（modelRun/executeTool/hooks），可离线单测；`toToolResultMessage` 组 AI SDK 期望的 tool 结果消息。**检查点钩子 `onMessages`**（T2-P3）：每步 `responseMessages` 与每条工具结果按批回调（含中断跳过的补结果——续跑不悬空），供入口逐步落盘。**无效调用防线**（2026-09-30）：AI SDK 标记 `invalid` 的 tool-call（zod 不匹配/JSON 解析失败/未知工具）不执行、不弹审批、不追加结果——AI SDK 已自动在 responseMessages 里补了 error 结果，重复追加会让下一轮请求畸形；`finishReason='error'` 当失败抛出（已产出文本先落账再抛，不假装没发生）。**预算与观测量（2026-10-08）**：`maxSteps` 默认 **∞（无上限，对齐 Claude Code/OpenCode；0/空/非法同样视为 ∞）**；设了有限上限且用尽且最后一步仍要工具 → **强制收尾**（OpenCode 式）：`modelRun(convo + system 收尾提示, {disableTools:true})` 再要一轮文字总结，收尾轮绝不执行工具、其 responseMessages 落检查点、usage 计入；失败 fail-open（`wrappedUp:false`）。每步落 `模型步完成` 日志，跨步累计 usage 随返回与 `onResult` 透出。
- `builtin-tools.js` — openai-compat 的内置文件/命令工具集（Read/Write/Edit/Glob/Grep/Bash/**TodoWrite**，对标 OpenCode 的宿主工具运行时；`RepoMap` 为注入式可选第八件）：zod 工具定义 + 真实执行器（Bash 含杀树/超时/中断；**执行后端可注入**——`bashBackend` 取 `exec-backends.js` 的解析产物，T6）+ 配套系统提示词 `buildAgentSystemPrompt`。**TodoWrite（A7）**：清单行不进活动转录，由 `run-openai` 的 `onActivity` 走 `runTodos` 落 run 快照（`normalizeTodos` 纯函数归一）；执行器只回确认文案。工具名/入参沿用 Claude Code 约定，`tool-summary.js` 与审批卡零改动复用；不 import `ai`（模型请求侧的转换归 `openai-compat-model.js`）；也不 import `features/`——`RepoMap` 由入口注入 `loadRepoMap` 才装配。**审批判决不在本文件**（原 `builtinApprovalDecision` 已退役）：统一规则表在 `capabilities/tool-policy.logic.js`。
- `exec-backends.logic.js` — Bash 执行后端纯函数（T6）：`pickEngine`（docker 优先/podman）、`buildContainerRunArgs`（挂载工作区到 `/workspace`、默认 `--network none`、Windows 路径转正斜杠）、`makeBashSpawn`（local=命令交 shell 与旧行为逐字一致；container=引擎参数数组）。容器参数是安全敏感面，离线可钉。
- `exec-backends.js` — 引擎探测（`docker/podman version`，5s 超时 + 60s 缓存）与后端解析 `resolveBashBackend`：配置 container 但引擎不可用 → `unavailable`（Bash fail-closed 明确报错，**绝不静默退回本地**）。
- `mcp.js` — MCP 集成层：`connectMcpServers`（连 stdio server、拆「定义+执行」、连接超时/可中断/防孤儿进程、失败清单上报）、`buildAutoAllowSet`（免审批工具名并集，纯函数）、`normalizeMcpResult`（工具结果归一，纯函数）。
- `*.test.js` — 与各源文件配对的 `node --test`。agent-loop / model adapter 靠依赖注入直测，mcp 用真实 echo server fixture 测，全程不触真实 AI SDK/网络。

## 二、关键流程

### A. 注册表装配（启动即定形）
`index.js` 引 `registry.js` 的 `createRegistry()` → 注册 `claude-agent.js`、`openai-compat.js` 两个默认实例 → 导出 `get` 等。内核（`entrypoints/web/run-claude.js`、`run-openai.js`）一律 `providers.get(id).run(...)`，从不直接 import 具体 provider——这是「新增 provider 只改一处」的支点。

### B. Claude 路径（薄透传）
`run-claude.js` 调 `providers.get('claude-agent').run(prompt, opts)` → `claude-agent.js` 直接 `runFn(prompt, opts)`（= `integrations/claude.js` 的 `runClaude`）→ 返回 `{ done, abort }`，`abort` 即触发 `opts.abortController.abort()`。本模块职责到此为止，agentic/工具/审批全在 SDK 侧。

### C. openai-compat 路径（手搓 agentic，跨边界装配是关键）
注意：**工具侧的装配与授权不在 provider 内组装，而在入口 `entrypoints/web/run-openai.js`**——provider 只消费装配好的 `tools`/`executeTool`/`canUseTool`：
1. 入口先 `createBuiltinTools({ cwd, signal, loadRepoMap?, bashBackend? })`（`builtin-tools.js`）拿内置七件套（**每轮恒有**；开关开启时入口注入 `loadRepoMap` → 多一件 `RepoMap`；`bashBackend` 由 `exec-backends.js#resolveBashBackend` 按 `settings.exec` 解析，T6），再建委托同事对话工具（`capabilities/feishu-ask-tools.js`，提问/等待）与联网工具（`capabilities/web-tools.js`：WebFetch/WebSearch，搜索配置读 `settings.search`）、只读子代理（`capabilities/subagent.logic.js` 的 Task，嵌套执行在入口），然后可选 `connectMcpServers(mcpConfigs)`（`mcp.js`）拿 `{ toolDefs, executeTool, close, failed }`；全部合并（MCP 同名覆盖本地）后，`canUseTool` 走**统一策略门**（`capabilities/tool-policy.js`：MCP 白名单、内置只读且在工作目录内、委托等待类放行；写/命令/网络/越界按档位 allow/ask/deny），档位**实时读 run 的 `mode`**（A6 起为函数 level，中途切档即刻生效）；同轮用 `buildAgentSystemPrompt` 注入 system 消息（**每轮重建、不落盘**）；
2. 入口 `providers.get('openai-compat').run({ messages, model, apiKey, baseURL, tools: toolDefs, executeTool, abortController }, hooks)`；
3. `openai-compat.js` `run()` **同步**返回 `{ done, abort }`（调用方拿 abort 的时机不变），把「惰性 `import('./openai-compat-model.js')` → `createOpenAiCompatModelRun`（按凭证造 `openai-compatible` 模型、`streamText` 包成 modelRun）」挪进 `done` 这条 Promise 链——因为该 adapter 会拉进 `ai` + `@ai-sdk/openai-compatible`（实测约 8.5MB heap），而本 provider 被无条件注册却非默认，只用 Claude 的用户不该为它付内存；
4. `runAgentLoop`（`agent-loop.js`）逐步跑：`modelRun(convo)` → `{ stream, finished }`；抽干 `stream`（text→`onText`，tool-call→`onActivity`）；`await finished`；`finishReason==='tool-calls'` 时对每个 call 走 `canUseTool` 审批 → 通过则 `executeTool`（内置工具直执；MCP 走 `mcp.js` 真执行 → `normalizeMcpResult`）→ `toToolResultMessage` 回灌 convo；直到非 tool-calls / 触顶 `maxSteps` / `signal` 中断。

### D. MCP「定义 + 执行」二分（人审在此嵌入）
`connectMcpServers` 把每个工具拆两半：**定义**（`toolDefs`，剥掉 `execute`）交给 `streamText`——模型只能「请求」调用、不会自动执行；**执行**（`executeTool`）由 agent-loop 在 `canUseTool` 审批通过后才调。这正是 openai-compat 侧 human-in-the-loop 审批的落点，也是它与 Claude 全托管路径的根本差异。

## 三、常见改动入口

- 要**新增一个模型 provider**，就建文件实现 `{ id, capabilities, run }` 契约 + 在 `index.js` `register` 一次；内核与调用方零改动。
- 要**改注册/查找语义**（形状校验、未知 provider 抛错、`list` 输出结构），就改 `registry.js`。
- 要**改 Claude 侧行为**，多半**不在本模块**——`claude-agent.js` 只透传，真正的 SDK 封装在 `integrations/claude.js`；只有要动 provider 契约包装（能力声明 `CLAUDE_CAPABILITIES`、`abort` 语义）才改 `claude-agent.js`。
- 要**改 openai-compat 编排**（惰性加载边界、能力声明、`maxSteps` 默认、input/hooks 结构），就改 `openai-compat.js`；注意 MCP 连接与审批集是入口 `entrypoints/web/run-openai.js` 装的，不在这里。
- 要**改手动 agent loop**（步进控制、工具调用中断语义、心跳 `onPulse`、检查点 `onMessages`、tool 结果消息格式、无效调用处置、`finishReason=error`），就改 `agent-loop.js`。
- 要**适配 AI SDK 版本变化 / 换底层流实现**（`streamText` 的 part 形状、`finishReason`/`responseMessages` 取法），就改 `openai-compat-model.js`——这是唯一碰 `ai` / `@ai-sdk/openai-compatible` 的地方。
- 要**改 MCP 接入**（连接超时/中断/防孤儿、失败上报、`autoAllow` 并集、结果归一），就改 `mcp.js`。
- 要**改内置工具集 / 放行规则 / 系统提示词**（工具清单、输出截断、目录外判定），就改 `builtin-tools.js`；合并顺序（MCP 同名覆盖内置）与装配在 `entrypoints/web/run-openai.js`。**RepoMap 工具**同理是装配件：定义/执行在 `builtin-tools.js`（`loadRepoMap` 注入），地图来源与预算在 `features/repo-map/`（`TOOL_BUDGET_CHARS`、`refresh` 语义），接线在 `run-openai.js`。

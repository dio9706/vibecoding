# 模型 Provider 抽象 — 设计文档

- 日期：2026-07-22
- 范围：内核去 Claude 化，把 `integrations/claude.js` 收敛为一个统一 Provider 接口的实现；`token-rotation.js` 泛化为按 provider 的凭证池；接入第二个 provider（OpenAI 兼容）验证抽象。
- 决策：
  - 首个非 Claude 源 = **OpenAI 兼容 API**（GPT/DeepSeek/Qwen/本地 ollama·vLLM）。
  - 非 Claude 的 agentic 能力 = **方案①**：借 Vercel AI SDK 跑 tool-calling 循环，但**工具执行与权限队列复用现有实现**（`store/runs.js` pendingQueue + Read/Write/Bash/MCP）。
  - cwd 语义：**保留工作目录，仅前端隐藏文件树**（本子项目不涉及前端，但接口需保留 cwd 传递）。
- 定位：这是"AI Coding 编辑器"转型五层解耦的**子项目 1（Provider 层）**。前置的"地基治理"（子项目 0）中，唯一与本设计强相关的是 run 编排从 `server.js` 抽出；本设计只做**最小必要**的抽取（见迁移步骤 2），不承担完整 server.js 拆分。

## 1. 背景与问题

现状全项目硬绑 `@anthropic-ai/claude-agent-sdk`：

- `src/integrations/claude.js`（215 行）是唯一的模型执行入口 `runClaude()`，直接被 `server.js`、`task-ops`、`intent`、`task-triage`、`classifyTier` 五处调用方引用。
- `src/features/token-rotation.js` 假设凭证形态为 Claude 订阅 OAuth token（`sk-ant-oat01-…`），`pickActive()`/`noteRateLimit()` 无 provider 维度。
- `src/entrypoints/web/server.js`（1471 行）里的 run 编排、续跑、看门狗、限流归因逻辑都直接调用 `runClaude()` 并假设 Claude 专属语义（`resume` 用 session_id、限流 `resetsAt`、`onRateLimit` 三档状态）。

转型目标要求"token 源不止 Claude，还支持自定义模型"。当前架构无法在不改内核的前提下接入第二个模型来源。

### 核心缺口

内核（run 编排层）与模型实现（Claude SDK）之间没有契约层：内核直接认识 Claude 的函数签名与专属语义，导致换模型 = 改内核。

## 2. 目标与非目标

**目标**
- 定义 `Provider` 契约，内核只依赖契约、不依赖任何具体模型 SDK。
- `integrations/claude.js` 平移为 `providers/claude-agent.js`，**行为逐字不变**（现有 7 大特性全回归通过）。
- `token-rotation.js` 泛化为 `credential-pool`，凭证带 `providerId`，轮换/续跑/切号对每个 provider 独立生效。
- 接入 `providers/openai-compat.js`，跑通一次**带工具的** agentic 对话，验证能力降级路径。

**非目标**
- 不改前端（会话目录 / 隐藏文件树属子项目 3）。
- 不做完整的 `server.js` 拆分（属子项目 0；本设计只抽出 run 编排的最小必要部分）。
- 不为非 Claude 源实现"上下文自动压缩"的完整方案（第一版简单截断，见风险）。
- 不改动看门狗阈值、额度续跑主流程、并发审批队列的既有行为。

## 3. 设计

### 模块 1：Provider 契约（内核与模型间唯一接口）

`src/providers/index.js` 提供注册表与能力查询；每个 provider 实现同一接口：

```
interface Provider {
  id: string                        // 'claude-agent' | 'openai-compat'
  capabilities: {
    agentic:   boolean              // 能否跑 agent loop（工具循环）
    tools:     boolean              // 能否使用工具（Read/Write/Bash/MCP）
    fileIO:    boolean              // 工具是否含本地文件读写
    resume:    boolean              // 能否续接已有 session
    stream:    boolean              // 能否 token 级流式
    permissions: boolean            // 能否交回 canUseTool 做交互审批
    rateLimitAware: boolean         // 能否上报限流（驱动额度续跑）
    compaction: boolean             // 能否自动压缩上下文
  }
  run(input, hooks): { abort(): void }
}

// input（内核构造，provider 无关）
//   { session?, prompt, model?, effort?, cwd?, permissionMode, signal }
// hooks（内核提供，全 provider 统一；provider 负责在合适时机调用）
//   { onText, onActivity, onResult, onPulse,
//     onRateLimit?, canUseTool?, onUserDialog? }
```

**关键约定**：不支持的能力在 `capabilities` 里声明为 `false`，内核据此**跳过**对应逻辑，而非假设其存在。例如某 provider `rateLimitAware=false` 时，内核不为其登记额度续跑定时器；`compaction=false` 时内核不期望上下文被自动压缩、必要时走自己的截断。

`run()` 返回带 `abort()` 的句柄，替代现在直接持有 `AbortController` 的方式，屏蔽各 provider 的中断实现差异。

### 模块 2：Claude 实现（平移，行为不变）

`src/providers/claude-agent.js` = 现 `src/integrations/claude.js` 搬家 + 适配到接口：

- `capabilities` 全 `true`。
- 把现有 `runClaude(prompt, {...callbacks})` 包成 `run(input, hooks)`；回调名一一对应（`onText/onActivity/onResult/onPulse/onRateLimit/canUseTool/onUserDialog` 现已全部存在）。
- `env` 注入（每 run 选 token）改由内核从凭证池取 `claude-agent` 的凭证后传入。
- 保留现有 `hooks.PreToolUse` 强制 `ask`、看门狗 `onPulse`、`resume` session 等全部机制（记忆中多次踩坑修好的，一行不改语义）。

`src/integrations/claude.js` 保留为**薄再导出**（`export * from '../providers/claude-agent.js'`）一个过渡期，避免一次性改动全部五处调用方；调用方逐个切到 provider 注册表后再删。

### 模块 3：凭证池泛化（token-rotation → credential-pool）

`src/features/credential-pool.js`（由 `token-rotation.js` 泛化，保留其纯函数可测风格）：

```
CredentialEntry {
  id, providerId,                   // 归属哪个 provider
  secret,                           // token / api key
  meta?,                            // 如 { baseURL, modelId }（OpenAI 兼容用）
  status,                           // healthy | warning | rejected（沿用）
  resetsAt?, prefs
}

pickActive(providerId)              // 按 provider 选当前最优可用凭证
noteRateLimit(providerId, info)     // 归因到对应 provider 的凭证
getStatus(providerId?) / recoverExpired(...) / maskSecret(...)
```

- Claude 凭证：`providerId='claude-agent'`，`pickActive('claude-agent')` 行为等价现在的 `pickActive()`。
- OpenAI 兼容凭证：`providerId='openai-compat'`，`meta={ baseURL, modelId }`。
- 现有轮换/额度续跑/自动切号逻辑**对每个 provider 独立生效**（互不串号）。
- `settings.json` 里 token 池结构升级：为旧条目回填 `providerId='claude-agent'`（迁移兼容，见影响面）。

### 模块 4：非 Claude 的 agent loop（方案①）

`src/providers/openai-compat.js` + `src/providers/agent-loop.js`：

- **模型 I/O 与循环**：用 Vercel AI SDK（`ai` 包 + provider adapter）承担多模型适配、流式、tool-calling 协议翻译。
- **工具执行与权限复用**：不使用框架自带的工具执行；工具的**实际执行**（Read/Write/Bash/MCP）与**交互审批**走 `agent-loop.js` 桥接到现有 `store/runs.js` 的 `pendingQueue`——即模型请求调用某工具 → 经内核 `canUseTool` 走同一审批队列 → 复用现有并发审批串行化（记忆中修过的竞态坑不能丢）→ 执行 → 结果回灌循环。
- **能力声明**：`agentic/tools/fileIO/stream/permissions=true`；`resume` 视首版实现（可先 `false`，靠内核维护会话历史重放）；`rateLimitAware` 视目标 API 是否透出限流（先 `false`）；`compaction=false`（见风险）。
- 工具集合与 Claude 对齐（Read/Write/Bash + 已配置的 MCP），由 `agent-loop.js` 统一提供给循环，保证换模型不丢工具能力。

### 模块 5：内核编排去 Claude 化（最小抽取）

`src/core/run-orchestrator.js`：把 `server.js` 中"起 run → 选凭证 → 调模型 → 处理回调 → 续跑/看门狗/落盘"这段编排抽出，改为面向 `Provider` 契约：

- 起 run 时：`provider = registry.get(providerId)` → `cred = pickActive(providerId)` → 构造 `input`（含 cwd、env 来源）→ `provider.run(input, hooks)`。
- 续跑/限流/审批等分支改为**先查 `provider.capabilities`** 再决定是否执行，实现能力降级。
- 本步只抽 run 编排相关代码，不动路由/SSE/其余 server.js（那属子项目 0）。

## 4. 影响面

新增：
- `src/providers/index.js`（注册表 + 能力查询）
- `src/providers/claude-agent.js`（= 现 claude.js 平移）
- `src/providers/openai-compat.js` + `src/providers/agent-loop.js`
- `src/features/credential-pool.js`（+ `.test.js`）
- `src/core/run-orchestrator.js`

改动：
- `src/integrations/claude.js` → 过渡期薄再导出，最终删除。
- `src/entrypoints/web/server.js`：run 编排调用点改走 `run-orchestrator` / provider 注册表；起跑注入凭证改走 `credential-pool.pickActive(providerId)`。
- 五处调用方（`task-ops`、`intent`、`task-triage`、`classifyTier`、web run）逐个从 `runClaude` 切到 provider 注册表。
- `src/store/settings.js`：token 池条目加 `providerId`（旧条目迁移回填 `claude-agent`）。
- 依赖：`package.json` 增 `ai`（Vercel AI SDK）+ 目标 provider adapter。

**不破坏**：现有 7 大特性（关窗续跑 / 历史检索 / 飞书 / 多账号轮换 / 自定义脚本 / 额度续跑 / 自动切号）在 Claude provider 下行为逐字不变；并发审批、看门狗、hooks 强制 ask 全部保留。

## 5. 迁移路线（绞杀者，每步 `node --check` + 7 特性手测回归）

1. **包壳**：定义 Provider 接口 + 注册表；`claude-agent.js` 包住现有 `claude.js`，`integrations/claude.js` 改薄再导出；行为零变化。
2. **抽编排**：run 编排从 `server.js` 抽入 `core/run-orchestrator.js`，改调 `provider.run()`；仍只有 Claude 一个 provider。
3. **泛化凭证池**：`token-rotation` → `credential-pool`，加 `providerId`；`settings.json` 迁移回填；轮换/续跑按 provider 独立。
4. **接第二个 provider**：实现 `openai-compat.js` + `agent-loop.js`，跑通一次带工具对话，验证 `capabilities` 降级路径（如 `resume=false`/`compaction=false` 时内核不误期望）。

## 6. 验证要点

- **回归（最重）**：切换到 provider 契约后，Claude provider 下 7 大特性逐项手测通过；并发审批（≥2 并行工具）、看门狗、额度续跑不回退。
- **契约测试**：一组 provider 无关用例（对话 / 工具调用 / 审批 / 中断），Claude 与 openai-compat 各跑一遍。
- **凭证池单测**：`credential-pool.test.js` 覆盖 `pickActive(providerId)` 按 provider 隔离、`noteRateLimit` 归因、多 provider 互不串号（沿用现有纯函数 `node --test` 风格）。
- **能力降级**：构造 `rateLimitAware=false`/`resume=false` 的 provider，确认内核不为其排续跑定时器、不尝试 session 续接而是重放历史。

## 7. 风险与开放问题

- **上下文压缩**（最大风险）：Claude 自动压缩免费，OpenAI 兼容源需自管。第一版 `compaction=false` + 简单截断（保留系统提示 + 最近 N 轮）；长会话质量下降是已知取舍，后续可加摘要式压缩。
- **工具 schema 差异**：各家 tool-calling 协议细节不同，由 Vercel AI SDK 归一；MCP 工具 → 循环工具的桥接需在 `agent-loop.js` 明确。
- **权限队列复用边界**：非 Claude 循环必须经同一 `pendingQueue`，禁止另起单槽（记忆中并发审批竞态的教训）。
- **依赖体积**：引入 `ai` 包；若后续想零依赖，可退化为方案②自建循环（接口不变，仅换 `agent-loop` 实现）。
- **凭证迁移**：`settings.json` 旧结构无 `providerId`，需一次性回填 `claude-agent`；回填逻辑要幂等、可重入。

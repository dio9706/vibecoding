# Provider 抽象 · Phase 3a（OpenAI 兼容 provider + agent-loop）— 设计文档

- 日期：2026-07-23
- 范围：后端核心。新增 `openai-compat` provider + 可复用的 `agent-loop`（手动工具循环），用测试/CLI 测试台验证。**不含** settings UI、run 路由/provider 选择、前端选择器（各留后续切片）。
- 定位：Provider 抽象子项目的 Phase 3a——第一次让**非 Claude 的自定义模型**具备可跑通的 agentic 能力。依赖 Phase 1（provider 注册表/契约）+ Phase 2a（凭证池 `providerId`）。

## 决策（已锁定，均可推翻）

1. **首个目标 = 通用 OpenAI 兼容端点**：`@ai-sdk/openai-compatible` 的 `createOpenAICompatible({ name, apiKey, baseURL })`——一套配置覆盖 DeepSeek / Qwen / Kimi / 本地 ollama·vLLM。凭证以 `providerId='openai-compat'` 存入现有凭证池，`meta={ baseURL, model }`，`secret=apiKey`。
2. **agent loop = 手动循环**（AI SDK 官方 manual-agent-loop 模式）：工具**不带 `execute`**，我们自己消费 `result.stream`（`text-delta`/`tool-call`），在 `finishReason==='tool-calls'` 时**自己执行工具**、把 `role:'tool'` 结果回灌 messages 再循环（`stopWhen: stepCountIs(N)` 兜底）。这样工具的**审批与执行都在我们手里**。
3. **工具执行来源 = MCP 工具**：非 Claude loop 的工具实现复用已配置的 MCP server（filesystem / shell 等），不自研整套工具执行器。每个 tool-call 先过现有审批队列（canUseTool / `runs.js` pendingQueue），批准后转发给 MCP client 执行。
4. **能力降级**（首版）：`resume=false`（靠内核重放历史）、`rateLimitAware=false`、`compaction=false`（简单截断：系统提示 + 最近 N 轮）。均在 `capabilities` 里如实声明，内核据此跳过对应逻辑。

## 1. 背景与依赖

- Phase 1 建立了 `Provider` 契约 + 注册表（`src/providers/`），主 run 已走 `providers.get('claude-agent').run()`。
- Phase 2a 让凭证池带 `providerId`、按 provider 独立选号（`pickActive(tokens,'openai-compat')` 已可用）。
- **关键事实（本期设计的根据）**：Claude 的工具（Read/Write/Bash…）由 Claude Agent SDK 内部执行，代码库**没有独立可复用的工具执行器**。故非 Claude 的 agentic 能力必须自带工具执行——本期选择"经 MCP 执行"。

## 2. 目标与非目标

**目标**
- 新增 `src/providers/openai-compat.js`，实现 `Provider` 契约，接通 `createOpenAICompatible` + 手动 agent loop。
- 新增 `src/providers/agent-loop.js`：可复用的手动循环，负责流式、tool-call 拦截→审批→MCP 执行→回灌、发内核回调（onText/onActivity/onResult）。
- 用**测试台**（node 脚本 / node:test + 假 transport 或可选真端点）验证：流式文本、一次带工具的往返（审批+执行）、最终 result、能力降级路径。
- 在 provider 注册表注册 `openai-compat`。

**非目标（后续切片）**
- OpenAI 凭证的 settings CRUD → Phase 3b。
- run 路由 / 会话选择 provider（当前主 run 仍硬编码 `claude-agent`）→ Phase 3b。
- 前端 provider/模型选择器 → Phase 3c（属"子项目 3 前端"）。
- 限流上报、session 续接、真·上下文压缩 → 后续。

## 3. 设计

### 模块 1：规范化 run 契约（Phase 1 延后项，本期定形）

Phase 1 的 `claude-agent` 用透传 `run(prompt, opts)`。本期由第二个 provider 倒逼出规范化形状，供 `openai-compat` 使用：

```
run(input, hooks): { done: Promise, abort(): void }

input = { messages, model, cwd?, mcp?, signal }   // messages: [{role,content}]（内核维护历史→重放，替代 resume）
hooks = { onText(t), onActivity(a), onResult(r), canUseTool(name,input)->Promise<{behavior}> }
```

- `claude-agent` 保持现有透传签名不变（主 run 仍走它）；两种 provider 并存于注册表。**完全统一 claude 到规范化契约留作后续**（避免再动 bug 敏感的主 run）。本期只要求 `openai-compat` 实现规范化 `run`。

### 模块 2：`agent-loop.js`（手动循环，核心）

```
loop(input, hooks, { model, tools, maxSteps }):
  messages = input.messages
  for step in 1..maxSteps:
    result = streamText({ model, messages, tools /* 不带 execute */ })
    for await chunk of result.stream:
      if chunk.type==='text-delta': hooks.onText(chunk.text)
      if chunk.type==='tool-call': hooks.onActivity({name:chunk.toolName,input:chunk.input})
    messages.push(...await result.responseMessages)
    if await result.finishReason !== 'tool-calls': break
    for toolCall of await result.toolCalls:
      decision = await hooks.canUseTool(toolCall.toolName, toolCall.input)   // 复用审批队列
      output = decision.behavior==='allow'
        ? await执行(toolCall)   // 经 MCP client 调对应工具
        : { error: '用户拒绝' }
      messages.push({ role:'tool', content:[{ type:'tool-result', toolCallId, toolName, output }] })
  hooks.onResult({ subtype:'success', result: 末条assistant文本, ... })
```

- **审批串行化**：`canUseTool` 必须走现有 `runs.js` 的 `pendingQueue`（记忆中并发审批竞态的教训——禁止单槽）。手动 loop 同一 step 的多个 toolCall 顺序过审批即可（天然串行）。
- **工具集来源**：从已配置 MCP server 取工具定义（AI SDK 的 MCP client，具体 API 写 plan 前核实），或首版先接一个最小 filesystem/shell MCP 验证闭环。
- **上下文压缩**：`compaction=false`，超长时简单截断（保留系统提示 + 最近 N 轮），首版可接受质量下降。

### 模块 3：`openai-compat.js`（provider 实现）

```
capabilities = { agentic:true, tools:true, fileIO:true(经MCP), resume:false,
                 stream:true, permissions:true, rateLimitAware:false, compaction:false }
run(input, hooks):
  cred = credential-pool.pickActive('openai-compat')   // {secret=apiKey, meta:{baseURL,model}}
  provider = createOpenAICompatible({ name:'openai-compat', apiKey:cred.secret, baseURL:cred.meta.baseURL })
  model = provider(input.model || cred.meta.model)
  return agent-loop.loop(input, hooks, { model, tools, maxSteps })
```

### 模块 4：注册

`src/providers/index.js` 追加 `register(openaiCompatProvider)`。注册表现含 `claude-agent` + `openai-compat`。

## 4. 影响面

新增：
- `src/providers/openai-compat.js`（+ 测试）
- `src/providers/agent-loop.js`（+ 测试）
- `src/providers/index.js`：注册 `openai-compat`（1 行）
- 依赖：`package.json` 增 `ai` + `@ai-sdk/openai-compatible`

不改：`claude-agent` 契约、主 run、凭证池（Phase 2a 已够用）、前端、settings。

## 5. 验证要点（测试台）

- **契约测试（假 transport/假 model）**：注入一个假的 streamText 结果序列，验证 loop 正确产出 onText/onActivity、在 tool-calls 时走 canUseTool、拒绝时回灌 error、finish 时发 onResult。**不依赖真端点/网络**（沿用 claude-agent 的依赖注入可测思路）。
- **审批串行**：同一 step 多个 tool-call 顺序过 canUseTool，拒绝/批准分别验证。
- **能力降级**：`capabilities` 断言；内核对 `resume=false`/`rateLimitAware=false` 不误期望。
- **（可选）真端点冒烟**：配一个真实 OpenAI 兼容端点跑一次纯对话 + 一次带 MCP 工具往返（手动，联网、需 key，不进 CI）。

## 6. 风险与开放问题（写 plan 前需核实/决策）

1. **AI SDK 的 MCP client API**：`experimental_createMCPClient` / `mcpClient.tools()` 的确切用法与工具 schema 形状——写 plan 前用 context7 核实。
2. **手动 loop 与流式的精确拦截**：`result.stream` 的 chunk 类型集合、`result.responseMessages`/`result.toolCalls`/`result.finishReason` 的确切 await 时序——已见官方 manual-agent-loop 示例，plan 前再核对 v5 具体字段。
3. **工具 schema 桥接**：MCP 工具 → streamText `tools` 定义（inputSchema/JSON schema ↔ zod）的转换。
4. **规范化契约与 claude 并存**：注册表内两个 provider 的 `run` 参数形状暂不统一（claude 透传 / openai 规范化）——本期可接受，但需在 plan 里明确内核调用方如何区分（Phase 3a 只经测试台直调 openai-compat，不碰主 run，故不冲突）。
5. **安全**：apiKey 明文存 `settings.json`（沿用现有 token 池，已 gitignore）；MCP shell/filesystem 工具的破坏性操作全程过审批队列，不得绕过。
6. **成本**：真端点测试联网计费；契约测试用假 transport 规避。

## 7. 后续切片（本期之后）

- **Phase 3b**：OpenAI 凭证 settings CRUD（`providerId='openai-compat'` + `meta.baseURL/model`）+ run 路由（会话/请求选 provider，主 run 不再硬编码 claude-agent）。
- **Phase 3c**：前端 provider/模型选择器（子项目 3 前端）。
- **清理项（Phase 2a 审查带出）**：抽 `DEFAULT_PROVIDER_ID` 常量；统一 `getStatus().active` 与 `getActiveTokenId()` 两处 active 语义。

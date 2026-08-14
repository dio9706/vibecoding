# Provider 抽象 · Phase 3d（openai-compat 接 MCP 工具 → agentic）— 设计文档

- 日期：2026-07-23
- 范围：让 openai-compat provider 从"纯对话"升级为 **agentic**——通过 MCP server 提供工具（读写文件/跑命令等），经现有审批队列执行。翻开 `capabilities.tools/agentic/fileIO/permissions`。
- 依赖：Phase 3a（agent-loop 已"工具就绪"：接受注入的 `tools` 定义 + `executeTool`）、片 A（错误/abort）、片 C（startOpenAiRun 已跑通对话）。

## 0. 已核实（AI SDK v7 MCP client）
- `createMCPClient({ transport })`（包 `@ai-sdk/mcp`；或 `ai` 的 `experimental_createMCPClient`——**写 plan 前 spike 确认安装/导出**）；`await client.tools()` → 工具集（**自带 execute，会被 streamText 自动执行**）；`await client.close()`。
- stdio transport：`new Experimental_StdioMCPTransport({ command, args, cwd, env })`（`@ai-sdk/mcp/mcp-stdio`）；也支持 http/sse transport（`{type:'http'|'sse', url, headers?}`）。

## 1. 核心设计难点与解法
**难点**：`client.tools()` 的工具带 execute → 若原样传给 streamText，SDK 会**自动执行**，绕过我们的 `canUseTool` 审批队列（记忆里反复强调的破坏性操作必须过审批）。

**解法**：**定义与执行分离**——
- 给 streamText 只传**工具定义**（`{ description, inputSchema }`，剥掉 execute）→ 模型请求工具但不自动执行 → agent-loop 收到 `tool-call`。
- agent-loop 每个 tool-call 先过 `canUseTool`（→ runs.js pendingQueue 审批），批准后由 `executeTool(name, input)` 调 **MCP 工具的 execute**（保留在 client.tools() 结果里）→ 结果回灌。
- 这正好用上 Phase 3a agent-loop 现有的两个注入点（`tools` 定义 + `executeTool` 执行），无需改 loop 契约。

## 2. 关键决策（请 review 时拍板）：MCP server 从哪来？
| 方案 | 说明 | 取舍 |
|---|---|---|
| **A. 用户可配 stdio server 列表（推荐）** | settings 存一组 `{ command, args, cwd?, env? }`；openai run 起跑时连上、取 tools、跑完 close。对齐 Claude Code 的 MCP 配置心智、契合"内置好用工具 + 多源可扩展"愿景 | 通用、可扩展；需 settings + 一点 UI（可复用凭证 tab 范式）；每 run 起进程有启动延迟 |
| B. 内置 filesystem MCP（scoped to cwd） | 首版只接官方 `@modelcontextprotocol/server-filesystem`，作用域 = run 的 cwd | 最快见效（读写文件），但功能窄、要装该 server 包 |
| C. 复用 `~/.claude` 的 MCP 配置 | 读 Claude Code 已配置的 MCP | 零配置，但耦合 Claude CLI 配置、格式需解析 |

**推荐 A**（可配 stdio 列表），并把 B（filesystem）作为文档示例/默认建议项。**首版可先接一个 server 跑通闭环，再扩为多 server。**

## 3. 目标与非目标
**目标**
- 新增 MCP 集成层：按配置连 stdio MCP server、取 tools、拆成"定义 + 执行" 两半。
- `startOpenAiRun` 起跑时：建 MCP client(s) → tools 定义传给 provider.run 的 `input.tools`、`executeTool` 走 MCP 执行；wire `canUseTool`（→ askUser 审批，复用 Claude 路径逻辑）；run 结束 close client(s)。
- `openai-compat` `capabilities`：配了 MCP 时 `tools/agentic/fileIO/permissions=true`（否则维持纯对话）。
- 工具活动经 `onActivity`→`runActivity` 显示（前端转录复用）。

**非目标**
- 不改 Claude 路径的工具/MCP（Claude 用自己的 SDK）。
- 不做 http/sse transport（首版仅 stdio 本地）；不做 MCP server 进程池（每 run 起停，后续可优化）。
- 不做工具审批的前端新 UI（复用现有"允许/拒绝"审批卡——openai canUseTool 走同一 askUser）。

## 4. 设计（模块）
### 模块 1：MCP 集成层 `src/providers/mcp.js`
```
connectMcpServers(configs, { cwd, signal }) -> { toolDefs, executeTool, close }
  // configs: [{ command, args?, cwd?, env? }]
  // 对每个 config：createMCPClient(stdio transport) → client.tools()
  // 合并所有 tools；toolDefs = 各 tool 剥离 execute（仅 description+inputSchema）
  // executeTool(name, input) = 找到对应 client 的 tool.execute(input)
  // close() = 关闭所有 client
```
- 名称冲突：后加覆盖（AI SDK 文档同款语义）；可加 server 前缀防撞（可选）。
- 失败隔离：某 server 连不上 → 记 warn、跳过其工具，不阻断 run。

### 模块 2：`startOpenAiRun` 接线（server.js）
```
const mcpConfigs = getMcpServers(); // settings
let mcp = null;
if (mcpConfigs.length) mcp = await connectMcpServers(mcpConfigs, { cwd, signal: run.abortController.signal });
providers.get('openai-compat').run(
  { messages, model, apiKey, baseURL, cwd, abortController: run.abortController,
    tools: mcp?.toolDefs, executeTool: mcp?.executeTool },
  { onText, onActivity, onResult, onPulse,
    canUseTool: mcp ? (name, input) => askUserForTool(run, name, input) : undefined }
);
handle.done.finally(() => mcp?.close());
```
- `askUserForTool` = 复用 Claude 路径的 canUseTool 审批（只读工具可自动放行、其余弹卡；但 MCP 工具的"只读"判定不像 Claude 内置那么明确 → 首版**一律弹审批**，安全优先）。
- provider.run 需把 `input.tools` 透传给 adapter（openai-compat.js 已有 `input.tools` → createOpenAiCompatModelRun 的 tools 参；确认链路通）。

### 模块 3：openai-compat capabilities 动态
- provider 静态 capabilities 仍声明 `tools:true`（能力存在）；**实际是否有工具取决于 run 时是否配了 MCP**。或保留 v1 的 false，接 MCP 后改 true。→ 决策：capabilities 表示"provider 支持工具"，故设 `tools/agentic/fileIO/permissions=true`（配了才真有工具，没配就是纯对话，行为自然降级）。

### 模块 4：MCP server 配置存储 + API（若选方案 A）
- `settings.json` 加 `mcpServers: [{ id, label, command, args, enabled }]`；store setter；`/api/mcp-servers` CRUD（或并入 settings）；前端设置页一个 MCP tab（复用凭证 tab 范式）。

## 5. 切片
- **3d-1**：MCP 集成层 `mcp.js`（connectMcpServers：连 stdio、取 tools、拆定义/执行、close）——用一个真实 MCP server（如 filesystem）spike + 单测（mock client）。
- **3d-2**：`startOpenAiRun` 接线 + canUseTool 审批 + capabilities flip + close 生命周期。
- **3d-3**：MCP server 配置存储 + API + 前端 MCP 设置 tab（方案 A 的配置面）。

## 6. 验证要点
- **spike（写 plan 前必做）**：`npm i @ai-sdk/mcp`（或确认 `ai` 导出 `experimental_createMCPClient`）；起一个真实 stdio MCP server（如 `npx -y @modelcontextprotocol/server-filesystem <dir>`），`createMCPClient`→`tools()`，打印工具对象真实形状（`description`/`inputSchema`/`execute` 签名）→ 据此定"剥离 execute"与"executeTool 调用"的确切代码。
- `mcp.js`：mock client 单测（toolDefs 剥离 execute、executeTool 路由到正确 client、close 全关、连不上隔离）。
- e2e：配一个 filesystem MCP + 一个真实 OpenAI 兼容端点 → 让模型读/写 cwd 里的文件 → 审批卡弹出 → 批准 → 工具执行 → 结果回灌 → 模型续答。**需真实端点（用户提供）**；无端点则 mock 模型 + 真 MCP 验证工具执行链。
- 回归：不配 MCP 时 openai run 仍纯对话（片 C 行为不变）；Claude 路径完全不受影响。

## 7. 风险与开放问题
1. **AI SDK MCP 包/导出**：`@ai-sdk/mcp` vs `ai` 的 `experimental_createMCPClient`——spike 确认（实验性 API 可能随版本变）。
2. **工具对象形状**：剥离 execute 保留 `description`+`inputSchema` 是否被 streamText 接受为合法 tool 定义——spike 验证；inputSchema 可能是 JSON Schema 或 zod。
3. **审批粒度**：MCP 工具无 Claude 那种 READONLY 白名单 → 首版一律弹审批（安全优先），后续可按 server/工具名配自动放行。
4. **进程生命周期**：每 run 起停 MCP server 进程（启动延迟 + 确保 close 不泄漏）；abort 时也要 close。
5. **安全**：MCP 工具可跑任意命令/写任意文件 → 全程过审批队列，且 stdio server 的 command 来自本机配置（非模型可控）。
6. **cwd 作用域**：filesystem MCP 应 scoped 到 run 的 cwd，避免越权访问。

## 8. 后续
- http/sse transport；MCP server 进程池（复用、降延迟）；按工具配自动放行白名单；工具活动的更丰富前端展示。

# Provider 抽象 · Phase 3b（凭证 CRUD + run 路由）— 设计文档

- 日期：2026-07-23
- 范围：让 openai-compat provider 在**后端真正跑起来**——OpenAI 凭证 CRUD + run 路由（主 run 按会话/请求选 provider）+ 应用自持会话消息存储 + 真实 abort/错误通道。经 API/测试台验证，**不含前端选择器（Phase 3c）**。
- 依赖：Phase 1（注册表/契约）、Phase 2a（凭证池 providerId）、Phase 3a（openai-compat provider + agent-loop）。

## 0. 核心发现（决定本期形态）

精读代码确认：**本 app 的会话历史/上下文完全是 Claude 自己的**——存于 Claude Code 的 JSONL session 文件（`~/.claude/projects/<projectId>/<sessionId>.jsonl`），靠 Agent SDK 的 `resume: sessionId` 续接；`store/history.js` 只是**读**这些文件展示侧栏。**应用层没有自己的会话消息存储**。

推论：openai-compat（`resume=false`、无 Claude session）**没有历史可重放**。因此 Phase 3b 必须为非 Claude provider 新增两样 Claude 白送的东西：
1. **应用自持的会话消息存储**（per convId 的 messages 数组）。
2. **无 session 的 run 路径**（不走 Claude 的 resume/JSONL，改用上面的 messages 重放）。

Claude 路径完全不动（继续用 JSONL/resume）。**一个会话绑定一个 provider**（v1 不支持会话中途换 provider）。

## 1. 目标与非目标

**目标**
- 存/管 OpenAI 兼容凭证（baseURL / apiKey / model），经 settings + API。
- `handleRunStart` 按 `provider` 字段路由：`claude-agent`→现有路径（一字不动）；`openai-compat`→新路径。
- 新增 `store/conv-messages.js`（app 自持会话消息），openai 路径读写它。
- openai 路径把 provider 的 hooks 接到**现有 `runs.js` 回调**（runText/runActivity/runResult）→ 复用现有 SSE/停止/关窗流式，前端零改动即可看到流式输出。
- 补齐 Phase 3a 遗留：真实 abort（`abortSignal` 穿进 `streamText`）+ 失败时 `onResult({subtype:'error'})`。

**非目标**
- 前端 provider/模型选择器 → Phase 3c（届时 UI 传 `provider` 字段）。
- 接 MCP 工具（v1 openai 仍纯对话，`capabilities.tools=false`）→ 后续（需先补工具往返端到端测试）。
- openai 会话的关窗续跑/额度续跑/看门狗自动 doResume（Claude 专属机制）——openai run 登记进 runs.js 供停止/流式，但**不参与** pending-resume/孤儿恢复（其 provider `resume/rateLimitAware=false`，内核据此跳过）。
- Claude 路径重构 / 两种 run 签名统一（保持 claude 透传，openai 规范化，**在 handleRunStart 分支**，不统一——避免动 bug 敏感的 Claude 主 run）。
- 会话中途换 provider。

## 2. 设计

### 模块 1：OpenAI 凭证存储 + CRUD（Phase 3b-1，自包含）

复用 `settings.json` 的 token 池（Phase 2a 已加 `providerId`），openai 条目扩展字段：

```
CredentialEntry {
  id, providerId:'openai-compat', label,
  token,            // = apiKey（沿用现有字段名，明文，已 gitignore）
  baseURL, model,   // openai 专属（Claude 条目无此二字段）
  status, resetsAt, ...
}
```

- `settings.js`：`addToken` 扩展为可携带 `baseURL/model`（或新增 `addCredential({providerId,label,secret,baseURL,model})`，Claude 走原路径）；`updateTokenMeta` 已支持 patch 任意字段（baseURL/model 可改）。
- API：扩展现有 `/api/tokens` 或新增 `/api/credentials`，支持按 providerId 增删改查；前端设置页（3c）据此加"自定义模型"tab。
- `getStatus(providerId)` 已可按 provider 过滤（Phase 2a 埋点），列表按 provider 分组。

### 模块 2：应用自持会话消息存储（新）

`src/store/conv-messages.js`（JSON 文件，走现有 `store/index.js` 读写锁）：

```
getMessages(convId) -> Array<ModelMessage>      // AI SDK ModelMessage 形状
appendMessages(convId, msgs)                    // 追加 user / assistant / tool 消息
clearMessages(convId)
```

- 仅 openai 路径使用；Claude 路径不碰（其历史在 JSONL）。
- openai run：起跑前 `appendMessages(convId, [{role:'user',content:prompt}])` → 取全量 messages 喂 loop → 结束后把 loop 产出的 assistant/tool 消息 `appendMessages` 回存（loop 已返回 `{messages}`，取新增部分）。
- 落盘上限（防膨胀）：保留最近 N 条（简单截断，对齐 3a 的 `compaction=false`）。

### 模块 3：run 路由（改 `handleRunStart`）

```
handleRunStart:
  const provider = (data.provider || 'claude-agent').trim();
  ...
  if (provider === 'openai-compat') return startOpenAiRun(run, { prompt, cwd, model, convId, preInput });
  startClaudeRun(run, { ... });   // 现状，未改
```

- `provider` 缺省 `claude-agent` → 现有行为完全不变（前端不传 provider 即走 Claude）。
- `auto` 判档仅对 Claude 有意义（Haiku 判档）；openai 路径跳过 auto（用凭证里的 model 或请求 model）。

### 模块 4：openai run 路径（新，`startOpenAiRun`）

```
startOpenAiRun(run, { prompt, cwd, model, convId }):
  const cred = credentialPool.pickActive('openai-compat')   // {token=apiKey, baseURL, model}
  if (!cred) return failRun(run, '未配置可用的自定义模型凭证')
  appendMessages(convId, [{ role:'user', content: prompt }])
  addActiveRun({ runId, convId, provider:'openai-compat', ... })  // 供停止/流式；不设 resume 锚点
  const messages = getMessages(convId)
  const handle = providers.get('openai-compat').run(
    { messages, model: model || cred.model, apiKey: cred.token, baseURL: cred.baseURL,
      abortController: run.abortController },
    { onText:(t)=>runText(run,t), onActivity:(a)=>runActivity(run, summarizeTool(a)),
      onResult:(r)=>{ runResult(run,r); if(!r.is_error) appendMessages(convId, 新增assistant消息) },
      onPulse:()=>runPulse(run), canUseTool: <同 Claude 的 askUser 串行审批> }
  )
  handle.done.then(()=>finishRun(run)).catch((e)=>failRun(run, e))
```

- **流式复用**：`runText/runActivity/runResult/runPulse` 就是 Claude 路径喂 SSE 的同一批回调 → 前端 attachStream 零改动即可看到 openai 流式。
- **看门狗**：`runPulse` 同样喂现有看门狗。
- **审批**：canUseTool 走现有 `runs.js` pendingQueue（v1 无工具，预留）。

### 模块 5：真实 abort + 错误通道（补 3a 遗留）

- `openai-compat.js`：`run` 接 `input.abortController`，把 `input.abortController.signal` 透传给 adapter。
- `openai-compat-model.js`：`streamTextToModelRun` / `createOpenAiCompatModelRun` 接 `abortSignal`，传给 `streamText({ abortSignal })`；`agent-loop` 步间检查 `signal.aborted` 提前退出。
- `agent-loop.js`：失败路径（modelRun 流 reject / error part）发 `onResult({subtype:'error', is_error:true, error})`，与 Claude 的终结语义对齐（`failRun` 依赖之）。adapter 消费 `fullStream` 的 `error` part 转成 reject/错误结果。

## 3. 影响面

新增：`src/store/conv-messages.js`(+test)、`startOpenAiRun`（server.js）、openai 凭证 API 端点、`agent-loop` 错误路径、`openai-compat`/`-model` 的 abort 透传。
改动：`handleRunStart`（+provider 路由分支）、`settings.js`（凭证带 baseURL/model）、`openai-compat.js`/`openai-compat-model.js`（abort/error）、`agent-loop.js`（abort 检查 + onResult 错误）。
**不改**：Claude 主 run（startClaudeRun）逻辑、pending-resume/孤儿恢复、前端。

## 4. 切片

- **3b-1**：openai 凭证存储 + CRUD API（自包含、可测、无 run 改动）。
- **3b-2**：`conv-messages` 存储 + `startOpenAiRun` + `handleRunStart` 路由 + abort/error 补齐（触碰 server.js，最大/最险）。

## 5. 验证要点

- 凭证 CRUD：单测 settings 扩展（baseURL/model 存取、按 providerId 过滤）+ API 往返。
- conv-messages：纯函数/存储单测（append/get/截断）。
- openai run 路径：测试台用**真实或 mock 端点**跑一次 `POST /api/run/start {provider:'openai-compat',...}` → 确认 SSE 收到流式文本、消息落 conv-messages、stop 生效、abort 真的中断（threaded signal）。
- 回归：不传 provider（或 provider='claude-agent'）时 Claude 路径行为逐字不变（现有 7 大特性）。
- 错误通道：openai 端点报错 → `onResult({subtype:'error'})` → `failRun` → 前端见失败气泡。

## 6. 风险与开放问题

1. **应用自持消息存储是新责任面**：openai 会话的持久化/截断/多进程并发写（web+feishu）需走 `store/index.js` 锁；跨重启不做自动续跑（openai `resume=false`）。
2. **一个会话绑定一个 provider**：混用需前端约束（3c）；v1 后端按会话首个 run 的 provider 处理，换 provider 需新会话。
3. **cwd/工具**：openai v1 无工具，`cwd` 暂无实际作用（工具接入后才需要）；先透传备用。
4. **凭证明文**：apiKey 存 settings.json（已 gitignore），与现有 token 池同等级。
5. **abort 语义统一**：openai 用 `input.abortController`（与 claude-agent 的 `opts.abortController` 对齐命名），修掉 3a 的 `input.signal.abort()` 不一致。
6. **auto 判档**：仅 Claude；openai 路径跳过（用凭证/请求 model）。

## 7. 后续

- Phase 3c：前端"自定义模型"设置 tab + 模型/provider 选择器（传 `provider` 字段）。
- 接 MCP 工具：补工具往返端到端测试后翻 openai `capabilities.tools/agentic`。
- 清理项：`DEFAULT_PROVIDER_ID` 常量、`getStatus().active` 语义统一、两种 run 签名长期是否统一。

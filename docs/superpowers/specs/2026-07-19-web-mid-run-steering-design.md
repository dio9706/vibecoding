# 设计：web 端执行中插话（steering）

日期：2026-07-19
状态：已获用户批准

## 背景

- Claude Code CLI 在执行过程中可以继续输入：消息注入正在运行的会话，Claude 在下一个决策点看到并纳入当前工作（steering），不打断执行。
- web 端目前做不到：每条消息 = 一次 `query()` 调用（字符串 prompt + `resume` 续接），run 结束前发送按钮被禁用（`public/app.js` `updateComposerRunning()` 中 `sendBtn.disabled = running`），必须等对话结束才能继续输入。
- 项目所用 `@anthropic-ai/claude-agent-sdk@0.3.210` 支持流式输入模式：`prompt` 可传 `AsyncIterable<SDKUserMessage>`，运行中可随时推入新的用户消息——这正是 CLI steering 的底层机制。

## 决策记录

- 插话语义：**引导当前任务**（用户选定）——与 CLI 一致，消息注入运行中的会话，不打断执行；停止按钮保留。不做「仅排队」，不做「打断重来」。
- 实现路线：**方案 A（run 级流式输入 + 注入端点）**（用户选定）——现有 run 注册表、SSE、审批、token 轮换、额度续跑、看门狗机制全部原样保留。不做会话级长驻 query（方案 B，改动大风险高，YAGNI）。

## 一、后端 `src/integrations/claude.js` —— 流式输入模式

- `runClaude(prompt, opts)` 签名不变，新增可选项 `opts.onInputHandle?: (handle) => void`。
- 提供该回调时，内部构造推送式异步生成器作为 `query()` 的 `prompt`：
  - 首条 yield 初始 prompt，包装为 SDK 用户消息：
    `{ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }`
    （本版本 `SDKUserMessage` 无必填 `session_id`，以 `sdk.d.ts` 实际类型为准）；
  - 之后挂起等待注入；
  - 把 `handle = { push(text), close() }` 通过回调交给调用方。
- 关闭时机：收到 `result` 消息时检查内部队列——
  - 队列无未消费消息 → 自动 `close()`，for-await 随流结束退出，行为与现状一致；
  - 恰有刚插入的消息（竞态）→ 不关闭，同一 run 内自然继续下一轮，前端无感知。
    多轮意味着 `onResult` 会触发多次；`runResult` 为覆盖式写入，settleRun 在
    runClaude promise resolve（流结束）后才执行，语义不变。
- 未传 `onInputHandle` 的调用方（判档分类 `classifyTier`、task-ops、feishu 入口）走原字符串路径，**零影响**。

## 二、后端 `src/entrypoints/web/server.js` —— 注入端点

- `startClaudeRun` 传入 `onInputHandle: (h) => { run._input = h; }`。
- 新路由 `POST /api/run/send`，body `{ runId, text }`：
  - run 存在、`status === 'running'` 且 `run._input` 可用 → `push(text)` + `runPulse(run)`（喂看门狗），返回 `{ ok: true }`；
  - 否则返回 `{ ok: false }`（run 恰好结束的竞态由前端兜底，见下）。
- `src/store/runs.js` **零改动**：settleRun、token 轮换、额度用尽自动续跑、审批全部照旧。canUseTool 阻塞等待审批期间插话的消息在 CLI 队列排队，审批 resolve 后被 Claude 看到，安全。

## 三、前端 `public/app.js` —— 解锁输入 + 气泡切分

### 发送分支

- `updateComposerRunning()`：运行中不再禁用发送按钮（停止按钮保留并存）。
- `send()` 增加插话分支——当前会话存在 running job 且 `job.runId` 已就绪时：
  1. 立即插入用户气泡并 `recordMessage`（与普通发送一致）；
  2. 把当前助手气泡**定稿**：`renderMarkdown` 收尾、`convSetMessage` 写入
     `job.text.slice(job.base)`、`convSetMsgFields({ pending: false })`；
  3. 新建一条 assistant 占位消息接后续输出：`convPushMessage` + `addMessage`，
     `job.asstIndex` 指向新气泡，`job.base = job.text.length`，随消息持久化
     `{ pending: true, runId, textBase: job.base }`；
  4. `POST /api/run/send { runId, text }`。
- `job.runId` 尚未返回（start 往返期间）时插话按钮短暂不可用（与现状 stop 补发同思路，等 runId 就绪）。

### 渲染切分

- job 增加 `base` 字段（默认 0）。所有把 run 全文写入当前气泡的位置统一改为按
  `base` 切分：
  - `paintJob`：`renderMarkdown(vb, job.text.slice(job.base, job.shown))`；
  - chunk 落库节流 `saveThrottled` / replay / done 收尾中的 `convSetMessage`：
    写 `job.text.slice(job.base)`。
- `job.shown` 语义不变（run 全文中的已显示位置）；插话切气泡时 `job.shown` 保持
  `>= job.base`，新气泡从空开始打字机。

### 重连恢复

- 刷新/重连（`openConv` → `attachStream`）时从持久化的 `textBase` 恢复 `job.base`，
  replay 的权威全文按偏移切进最后一个 pending 气泡——多段助手气泡与插话的顺序
  在重放后保持正确（此前各段已定稿在本地 conv store 中）。

### 兜底

- `/api/run/send` 返回 `{ ok: false }`（run 恰好结束）→ 自动降级为普通新一轮发送：
  复用已建好的用户气泡与 assistant 占位，走 `POST /api/run/start`（`resume` 续接
  session），消息不丢。

## 四、边界与不做的事

- 插话次数不限，每次切一个新助手气泡。
- 磁盘历史无需处理：SDK 会把注入的用户消息写进 session jsonl，历史查看自然正确。
- 多标签页不做插话实时同步（与现状一致，YAGNI）。
- 停止按钮语义不变（abort 整个 run）。
- feishu 入口不做插话（本次范围仅 web）。

## 五、测试

- 为 `claude.js` 的输入队列写单测（沿用现有 `*.test.js` / node:test 约定）：
  - push 后消息按序产出；
  - result 时队列空 → 自动关闭；
  - result 时队列非空 → 不关闭、继续产出（竞态语义）；
  - 显式 `close()` 后 push 安全无效。
- 手工验收：执行一个长任务，中途插话「顺便把 README 里的 X 也改了」，观察
  Claude 在后续决策点纳入插话；刷新页面验证气泡顺序与切分正确；run 结束瞬间
  插话验证 fallback 新开一轮。

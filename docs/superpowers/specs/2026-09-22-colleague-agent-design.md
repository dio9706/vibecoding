# 同事侧对话 Agent 化（2.0）· 设计

> 状态：已拍板，待实现 ｜ 日期：2026-09-22 ｜ 建议分支：`v2.0`
>
> 影响面：新增 `src/capabilities/agent-tools.js` / `agent-session.js`、新增插件 `src/plugins/colleague-agent/`、新增 `src/store/agent-actions.js`；改 `src/store/colleague-messages.js`（破坏性迁移）、`src/entrypoints/feishu/index.js`、`src/entrypoints/web/requirement-ops.js` / `routes-requirements.js`、`src/plugins/team-tools/auto-dev/git.js`、`src/plugins/action-runner/`、`src/plugins/tracking-stats/`、`public/js/`；下线 `src/plugins/colleague-relay/`。

## 一、背景与目标

三期把同事的飞书消息归入需求，四期加了一层单轮分类器自动处理。两期共同的形态是**分类器管线（workflow）**：一条消息进来 → 判一次 → 交给一段写死的 `if` → 结束。

这个形态有三条结构性上限，任何调参都绕不过去：

1. **没有对话主体。** `runClassifierOnce` 的名字就写明了 once。同事回的第二句话会被当成全新的独立消息重走一遍分类，模型不知道上一句是什么。「机器人指出文档有问题 → 后端说那是新版本 → 机器人接受并按新版本改」这个三轮交互，在结构上没有落点。
2. **能力是硬编码分支，不是可调用的工具。** `colleague-auto.js` 只有两个出口（是接口文档 / 需要改代码）。加第五、第六种处理 = 加第五、第六个 `if` + 第五、第六个 prompt。角色维度根本没建模（`auto-notify.js` 一句 `role !== 'backend'` 直接不发请求）。
3. **判定与执行一次性。** 分类器只能输出 `{needsAction, summary, prompt}`，没有「我不确定，先查证再说」和「我认为你这里写错了」这两种输出。

本设计把**同事侧**（不含 owner）的全部对话从分类器管线切换到 **agent 循环**：一个按角色装配工具面的对话 agent，持有长期会话，自己决定查什么、问什么、调什么工具。

目标状态：**加一个业务场景 = 在对应插件里注册一个工具**，`colleague-agent` 一个字不用改。

### 不在本设计范围内

- owner 侧（`claude-exec` 的「owner 全接」）保持原样
- BUG 巡检、task-triage、auto-dev 管线、需求评审保持原样
- 需求阶段流转（`dev-done` / `test-pass` / `archive`）保持人工

## 二、拍板记录

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 改造边界 | **所有同事侧对话**，不限阶段、不限角色。owner 侧不动 |
| 2 | 会话锚点 | **锚在「人」**（`colleagueId`），需求归属由 agent 逐条打 `reqId` 标签。`_pending` 多需求选择卡整个退役 |
| 3 | 授权模型 | **乐观执行 + 可撤销**。写操作直接跑，同时写撤销台账 + 推主机卡片。不做阻塞式审批 |
| 4 | 旧能力去留 | **包成 agent 工具**。`run_action` / `tracking_report` / `report_bug` 三个工具取代原意图识别；slot-filler / local-extract / learn-keywords / L2 关键词表在同事侧退役 |
| 5 | 模型通路 | **Claude Agent SDK + 进程内 MCP**，`resume` 维持长期 thread。不走 openai-compat |
| 6 | 触发边界 | 名册内同事私聊全进；群聊仅 `@` 进；名册外走旧 feedback 管线。配 per-人限流 + 全局并发闸 |
| 7 | 工具装配方式 | **自注册**（各插件加载时 `registerAgentTool`），不是 import。复用 `registerCardKindHandler` 范式 |
| 8 | 工具面边界 | 按**技术不可逆 vs 决策不可逆**切，不按读/写切。见 §3.4 |
| 9 | 改码的隔离与撤销 | **per-需求常驻 worktree** → agent 子分支 → `commitAll` → 合并回需求分支；撤销 = `git revert -m 1 <mergeCommit>` |
| 10 | 队列 | 三层：agent 任务间同需求串行；合并按 repo 串行 + `isClean` 闸；**与主机主会话不排队** |
| 11 | 动作脚本暴露 | `run_action` 列为 `external` 档；`agentExposed` **默认 `true`**（`canRunAction` 原闸仍在，非新增暴露面）+ policy 要求执行前向同事复述确认 |
| 12 | 分期 | P1 只读先行，把「延迟 + 额度」这个最大未知先验证掉 |

## 三、探索发现的硬约束

这六条直接决定实现落点。任何一条漏掉都会产生「看起来能用、实际某条路径静默失效」的结果。

### 3.1 `Options.tools` 塞不进自定义工具

SDK v0.3.259，`sdk.d.ts:1505`：

```ts
/** Specify the base set of available built-in tools.
 *  - `string[]` - Array of specific tool names (e.g., ['Bash', 'Read', 'Edit'])
 *  - `[]` (empty array) - Disable all built-in tools */
tools?: string[] | { type: 'preset'; preset: 'claude_code' };
```

它是**内置工具名**的白名单。自定义工具的唯一入口是 `mcpServers`，工具定义放在 `CreateSdkMcpServerOptions.tools`（`sdk.d.ts:523`，类型 `Array<SdkMcpToolDefinition>`）。

两层配置里都有个叫 `tools` 的键，一个收字符串一个收对象定义 —— 这是本项目最容易写错的一处。**`tools: []` 与 `mcpServers` 不是二选一，是两个不同的旋钮**：前者关掉 Read/Bash/Write/Edit/WebFetch，后者装上业务工具。

### 3.2 收窄工具面只能用 `tools`，且不得设 `allowedTools`

`llm-sql-agent.js` 文件头已记录的两个坑，原样适用：

- **不能用 `disallowedTools: ['*']`**。该字段语义是「removed from the model's context and cannot be used, **even if they would otherwise be allowed**」—— 通配符连自己的 MCP 工具一起删掉。实测表现是工具全部 `Permission denied`，日志只有一句含糊的权限拒绝。
- **不能把工具名列进 `allowedTools`**。那是免审批名单，会让 `canUseTool` 整个不被调用（SDK 打印 `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]`）。本设计的危险级判定、撤销台账、限流计数全挂在 `canUseTool` 上，设了它等于第二层防线连同整套审计一起失效，而代码看起来一切正常。

`permissionMode` 必须是 `'default'`：`bypassPermissions` 会绕过 `canUseTool`。

### 3.3 需求侧的改代码，**现状完全不可撤销**

```js
// src/entrypoints/web/requirement-ops.js:19
import { currentBranch, ensureBranch, isClean, localBranches } from '../../plugins/team-tools/auto-dev/git.js';
//                                                                  ↑ 没有 commitAll，没有 mergeBranch
```

需求侧的真实形态：

| 时点 | 做了什么 |
|---|---|
| 定稿 `finalizeRequirement` | `ensureBranch` 建需求分支，记 `req.branches[] = {dir, branch, baseBranch}` |
| 开发期全部子会话 | 在**该分支的主工作区直接改，永不提交** |
| `dev-done` / `archive` | 只改 `phase` 字段 |

也就是说：**需求级有分支，单次改动没有提交边界**。`revert.js#revertMergeCommit` 需要的 `task.branch` / `task.baseBranch` / `mergeCommit` 三个字段，需求侧子会话一个都没有 —— 那条撤销路径接不上。手工还原也堵死（`parallel-sessions-same-repo`：多会话并发编辑同一仓库，绝不 `git checkout` 还原文件）。

**§7 的 worktree + 提交 + 合并模型因此不是优化，是补一个洞。**

### 3.4 `ensureAutoWorktree` 是每仓库一个全局目录

```js
export function autoWorktreeDir(repo) {
  return String(repo).replace(/[\\/]+$/, '') + '.auto';   // 全局唯一
}
```

auto-dev 泵在 `<repo>.auto` 里 `checkout -B <taskBranch>` 跑任务。agent 改码**不能复用它**：auto-dev 泵是全局串行、需求 busy 闸是 per-需求串行，**两道闸互不知情**，同时用一个目录就是一方把另一方的分支 checkout 掉。

故 agent 用独立的 per-需求 worktree（§7.1）。

### 3.5 web 进程**不加载插件** —— 注册表在那里恒为空

2026-09-22 实测（Task 1 代码审查发现，已独立复验两遍）：

```
loadEnabledPluginFeatures()   只被 src/features/index.js:13 调用（顶层 await）
src/features/index.js         只被 src/app/dispatch.js:10 import
src/app/dispatch.js           web 入口零引用（grep src/entrypoints/web/ + server.js 对 app/ 无命中）
```

`routes-settings.js:31` 确实 import 了 `plugins/index.js`，但只取 `PLUGIN_MANIFEST` 这份**数据**；清单里的 `load: () => import('./xxx/index.js')` 是惰性函数，不调就不加载。web 进程另外直接 import 的只有 `plugins/team-tools/auto-dev/index.js`（server.js:19）与 `plugins/team-tools/bug-patrol/loop.js`（server.js:81）两个具体文件，从不走装配层。

**结论：**

| 进程 | `listAgentTools()` |
|---|---|
| feishu / console | 有料（走 dispatch → features → plugins） |
| **web** | **恒为 `[]`** |

而 spec §4 的编排落在 web 进程（沿用四期决策 #1：起 run 必须在 web，泵在那里）。所以：

> **web 进程必须显式 `import 'plugins/colleague-agent/index.js'` 触发工具自注册**，不能指望装配层。P2 接入 web 路由时这是必做项。

失败形态极隐蔽：注册表为空 → `buildAgentMcpServer` 安静地造出一个**零工具的 MCP server** → 模型看不到工具就凭记忆作答，回复照样通顺，日志里什么都没有。因此 `buildAgentMcpServer` 在 `picked.length === 0` 时**必须打 warn**（一行成本，见 §4.2）。

⚠️ `src/plugins/CLAUDE.md`「关键流程 C」里「feishu 与 web 进程都会加载插件」这句话与实测不符，待订正。
**（2026-09-28 已订正：模块地图 + 4 处代码注释全部改掉；同时落地 `plugins/index.js#loadPluginSideEffects`，由 `server.js` 的 listen 回调显式加载 `colleague-agent`。实证：加载前 `listAgentTools()` 为 0，加载后 7 个。）**

### 3.6 同事今天已经能触发动作脚本

```js
// src/plugins/action-runner/feature/index.js:372
permission: 'any',        // feature 级只负责让两种角色都能路由进来
// 真正的裁决在 permission.js#canRunAction（role 是 'owner'|'guest'，同事 = guest）
```

`canRunAction` 是「最低要求档位」语义，fail-closed 到 owner。所以 `permission` 为 `any`/`guest` 的动作，同事说一句含关键词的话今天就能跑。

**结论：`run_action` 默认暴露给 agent 不是新增暴露面**，`canRunAction` 原闸原样保留即可（决策 #11 的依据）。但存在一个真实语义差 —— 今天是同事**主动说出意图**才触发，agent 化后是 agent **替他判断**，补偿见 §6.3。

## 四、架构

```
飞书入口（entrypoints/feishu/index.js）
   │  ★ 文本与文件两条链路在此合并（现状：文件在 dispatch 之前就被 relayColleagueAttachment 截走）
   ▼
plugins/colleague-agent/feature.js          ← 取代 colleague-relay，order 35
   │  ① 名册判定（colleagues.js，有 feishuOpenId）→ 不在名册 PASS 回 feedback
   │  ② 群聊仅 @ 进
   │  ③ 限流闸（per-人 + 全局并发）→ 超限回 ACK_TEXT，不起 agent
   ▼
plugins/colleague-agent/session.js（编排，有 IO）
   │  组装 system prompt（prompt.js 纯函数）
   │  取/存 agentSessionId
   ▼
capabilities/agent-session.js               ← 新增：对话型 agent（llm-sql-agent 的对话变体）
   │  query({ resume, mcpServers, tools: [], permissionMode: 'default', canUseTool })
   ▼
capabilities/agent-tools.js                 ← 新增：工具注册表（本设计的核心抽象）
   │  按 role 过滤 → createSdkMcpServer 转成进程内 MCP server
   │  canUseTool：危险级判定 → 执行 → 写撤销台账 → 推主机卡片
   ▼
各插件在**模块加载时**注册自己的工具
   ├─ colleague-agent/tools/*.js   需求读写、改码、报 BUG
   ├─ action-runner/index.js       run_action
   └─ tracking-stats/index.js      tracking_report
```

**这张图是逻辑视图，不是进程视图。** 实际实现把 `feature.js`（飞书进程）与 `session.js`（web 进程）拆开了，中间隔一次跨进程 `POST /api/req/colleague-agent/turn`——写工具要调的 `registerApiDoc`/`enqueueSystemTask` 操作的是 **web 进程内存里**的需求泵与 busy 状态机，在 feishu 进程动态 import 它们拿到的是另一份模块实例，任务入队后永远不会被执行。两进程分工的完整图见 P3 计划第一部分 §0.1，落地后的模块地图见 `src/plugins/CLAUDE.md`「关键流程 F」。

### 4.1 为什么工具用「自注册」而不是 import

`colleague-agent` 需要调 action-runner 的脚本、tracking-stats 的埋点，但分层约定明写**插件之间不互相 import**（协作走 store 或事件）。

解法复用仓库已有的 `shared/card-actions.js#registerCardKindHandler` 范式 —— 插件在模块加载时把自己的能力注册进一个零业务语义的注册表：

```js
// src/plugins/action-runner/index.js 模块加载时
registerAgentTool({
  name: 'run_action',
  danger: 'external',                     // 有真实外部副作用，撤不回，见 §6.3
  roles: ['*'],                           // 真正的闸在 handler 内的 canRunAction
  schema: buildActionZodShape(),          // 由 action-configs 的变量声明动态生成
  handler: (input, ctx) => executeAction(...),
  exposedFlag: 'agentExposed',            // external 档必填：可关掉的硬开关
});
```

三个白拿的性质：

| 性质 | 为什么 |
|---|---|
| 分层不倒挂 | `plugins → capabilities` 是顺向依赖，注册表本身零业务语义 |
| **插件停用即工具自然缺席** | 与卡片回调完全同一语义，不需要额外写开关 |
| 加能力不改 agent | 新工具 = 在自己插件里注册一行 |

第三条是「灵活度」的结构来源：**加场景 = 加一个工具，不是加一个 `if`**。

### 4.2 `capabilities/agent-tools.js` 契约

```js
registerAgentTool({
  name: string,                  // 短名；MCP 全名为 mcp__colleague__<name>
  description: string,           // 直接进模型上下文，写清楚「什么时候该用」
  danger: 'safe' | 'reversible' | 'external' | 'notify',
  roles: string[],               // colleagues.js 的 ROLES id，或 ['*']
  schema: ZodRawShape,
  handler: (input, ctx) => Promise<object>,   // ctx: { colleagueId, role, msgId, reqId }
  buildUndo?: (input, result, ctx) => UndoDescriptor,   // danger:'reversible' 必填且必须返回非 null
  exposedFlag?: string,          // danger:'external' 必填：控制该工具是否暴露的配置字段名
})
```

四档危险级：

| danger | 含义 | 注册期要求 | 台账 |
|---|---|---|---|
| `safe` | 只读，无副作用 | — | 不写 |
| `reversible` | 有副作用，但能撤回 | **必须提供 `buildUndo` 且其返回值不得为 `null`** | 写，带 `undo` |
| `external` | 有真实外部副作用，撤不回（`run_action` 唯一成员） | **必须提供 `exposedFlag`** + policy 复述确认 | 写，`undo: null` |
| `notify` | 只给主机发消息 | — | 不写 |

**注册期不变式（启动即校验，不满足直接抛）**：

1. `danger === 'reversible'` 必须提供 `buildUndo`，且运行时其返回值为 `null` 时**视为工具执行失败**并回滚。否则「可撤销」会在某个工具上悄悄失效 —— 这是整个授权模型的地基，不能靠自觉。
2. `danger === 'external'` 必须提供 `exposedFlag`，否则一个撤不回的工具就没有硬开关可关。

`external` 单独立一档而不是塞进 `reversible`，是因为「能撤」和「不能撤」是两种完全不同的风险，混在一档会让 §4.2 的不变式失去意义。

`buildAgentMcpServer(role)` → 按 `roles` 过滤后 `createSdkMcpServer({ name: 'colleague', tools: [...] })`。

### 4.3 `capabilities/agent-session.js` 契约

```js
runAgentTurn({ userText, systemPrompt, server, allowed, sessionId, cwd, model, signal, timeoutMs, logTag })
  → { text, sessionId, toolTrace: [{ name, input }], reason }
     reason: null=正常 | 'exhausted' | 'timeout' | 'error'
```

`server` / `allowed` 来自 `buildAgentMcpServer(role, { ctx })`；`allowed` 是全名白名单，供 `canUseTool` 复核。

- 内部走 `query({ resume: sessionId, mcpServers, tools: [], permissionMode: 'default', canUseTool, ... })`
- 本模块**不含业务语义**（不知道什么是需求、什么是同事），符合 capabilities 层定位
- 失败语义见 §8

## 五、数据模型

### 5.1 `colleague-messages.json` 锚点迁移（破坏性）

```js
// 旧：{ "<reqId>": { "<colleagueId>": { messages, lastInboundAt } }, _pending: { "<openId>": {...} } }
// 新：
{
  "<colleagueId>": {
    agentSessionId: 'sess_xxx' | null,   // ★ Agent SDK resume 锚点，长期 thread 靠它
    messages: [{
      id: 'cm_xxx',
      dir: 'in' | 'out',
      text: '',
      files: [{ name, path, kind }],
      at: '2026-09-22T…',
      role: 'backend',                   // 发信当时的职位快照（三期既有，保留）
      reqId: 'req_xxx' | null,           // ★ agent 判定的需求归属标签
      status: 'unread' | 'read' | 'handled',
      handledBy: null | 'manual' | 'ai',
      handledNote: '',
      toolTrace: [{ name, input, brief }] | null,   // ★ 这轮 agent 调了什么，审计用
    }],
    lastInboundAt: '2026-09-22T…',
  }
}
```

两处退役：

- **`_pending` 整节删除**。锚在人之后不再需要「你同时在 3 个需求里，选一个」那张卡。三期为它写的 `addPending` / `getPending` / `flushPending`、落盘缓冲、`colleague-pick` 卡片回调全部下线。
- **`getUnreadCounts(reqId)` 改签名**为按 `reqId` 标签过滤，`/api/req/colleague-messages?reqId&colleagueId` 的对外语义不变，web 端现有「需求 → 开发人员 → 会话面板」UI 保住。

**迁移函数** `migrateColleagueMessages(raw)`（参照 `bots-migration.js`）：遍历旧结构摊平成 `{colleagueId}`，每条消息的 `reqId` 填它原来所在的那一层；`_pending` 里的消息丢弃（未归属，且选择卡已下线）并打 warn 日志。纯函数 + 单测覆盖「旧形状 / 新形状 / 混合 / 空」四种输入。

### 5.2 新建 `src/store/agent-actions.js` → `agent-actions.json`

```js
{
  actions: [{
    id: 'aa_xxx',
    at: '2026-09-22T…',
    colleagueId, role, msgId, reqId,
    tool: 'start_dev_task',
    input: {...},                  // 经 store/mask.js 脱敏
    ok: true,
    resultBrief: '',               // ≤200 字
    undo: { kind: 'revert-merge',      repo, branch, baseBranch, mergeSha }
        | { kind: 'delete-apidoc',     reqId, name }
        | { kind: 'revert-req-change', reqId, changeId }
        | { kind: 'discard-task',      taskId }
        | null,                    // safe / notify 工具不写台账
    undone: false, undoneAt: null,
  }]
}
```

写操作一律经 `store/index.js#updateJson`（跨进程文件锁）—— 飞书进程与 web 进程都可能写。

### 5.3 `requirements.json` 新增字段

```js
req.agentWorktrees = [{ dir, worktreeDir, branch }]   // 归档 / 删除时 worktree remove
```

> P3 Task 10 补齐（P2 遗漏）——P2 落地时这个字段没有跟着写，直到 P3 走查才补上。

## 六、工具清单

| 工具 | danger | 可见角色 | 包的是 | undo |
|---|---|---|---|---|
| `list_my_requirements` | safe | 全部 | `requirements` store | — |
| `get_requirement` | safe | 全部 | `handleGet` 逻辑 | — |
| `get_api_doc` / `get_ui_spec` | safe | 全部 | `req` 字段 | — |
| `get_dev_progress` | safe | 全部 | `req.history` + `sessions` | — |
| **`read_project_code`** | safe | 全部 | `capabilities/llm-readonly-agent.js` | — |
| `register_api_doc` | reversible | backend | `registerApiDoc`（从 `handleApidocPost` 抽出） | delete-apidoc |
| **`start_dev_task`** | reversible | backend, product, qa | §7 完整模型 | revert-merge |
| `submit_req_change` | reversible | product | `/api/req/change` 逻辑 | revert-req-change |
| `supplement_requirement` | reversible | product, design | `/api/req/supplement` 逻辑 | history 回滚 |
| `report_bug` | reversible | 全部 | `auto-dev/queue.js#requestAutoDevelop` | discard-task |
| `upload_design_ref` | reversible | design | req-map figma | 删引用 |
| `run_action` | **external** | `['*']`，真正的闸在 handler 内的 `canRunAction` | action-runner 注册 | 撤不回，见 §6.3 |
| `tracking_report` | safe | ops, product | tracking-stats 注册 | — |
| `notify_host` | notify | 全部 | `lark.js#sendTextToUser` 发给管理员 | — |

### 6.1 `read_project_code` 是「能反驳」的能力来源

没有它，agent 说「你这份文档和现有代码对不上」只能是瞎猜。system prompt 里要写成硬约束：

> 质疑对方给的信息之前，必须先用 `read_project_code` / `get_api_doc` 查证。拿不出依据就不要质疑，改为提问。

这条是本设计相对四期的核心增量 —— 用户原始诉求「机器人分析文档有错误，提醒后端修改，后端说没错」正是由它 + agent 循环共同支撑。

### 6.2 `start_dev_task` 必须回显目标需求

归属标签打错在大部分地方无害（改个标签的事），但 `start_dev_task` 的 `reqId` 决定了**代码改在哪个 worktree、合并进哪个分支**。判错 = 把后端说的接口改动改进了另一个需求的分支。

解法不是让 agent 更小心，是让最知道答案的人当场看见 —— **工具执行时回给同事的那句话必须明写目标**：

> 「好，我按需求《订单列表改版》处理，改在分支 `feat/req-a3f2` 上」

同事是最清楚自己在说哪个需求的人，不对会立刻纠正。台账里也记 `reqId`，主机事后可改。

### 6.3 `run_action` 是唯一的 `external` 工具

动作脚本有真实外部副作用（`scripts/refund_orders.py` 是真金白银），`git revert` 救不了。它进工具面的依据是 §3.6 —— 同事今天已经能触发，非新增暴露面 —— 而不是「它可撤销」。三条规矩：

1. **两道权限闸串联。** 注册时 `roles: ['*']`（注册表这层不做角色过滤），真正的裁决在 handler 内调 `canRunAction(actionConfig, 'guest')` 逐动作判定 —— 同事在 `permission.js` 的语义里恒为 `guest`，与 `colleagues.js` 的六个职位是**两套不同的角色概念**，不要混用。`owner` 档的动作 agent 照样调不动。
2. **`exposedFlag: 'agentExposed'`，该字段默认 `true`。** 你只需在 `refund_orders` 这类动作上关掉。设置页表单同步（`actions-panel.js` / `actions-panel.logic.js#buildVarDecl`；**空字段必须省略**，否则会把 preset 覆盖成空）。
3. **执行前必须向同事复述确认。** 写进 tool description 与 system prompt：agent 先说「我要执行 X，参数 Y，确认吗」，拿到确认才跑。

第 3 条是软约束（模型会违约），所以第 2 条那个硬开关必须存在 —— 这正是 `external` 档要求 `exposedFlag` 必填的原因。台账照常记录（`undo: null` 表示「已发生，撤不回」），供事后审计。

### 6.4 不进工具面的东西

边界按**技术不可逆 vs 决策不可逆**切，不按读/写切：

| 类型 | 判据 | 例子 | 进工具面 |
|---|---|---|---|
| 技术不可逆 | 撤不回来是因为没做隔离 | 改代码 | **进** —— 加分支就可逆（§7） |
| 决策不可逆 | 撤回来了，事已经发生在人身上 | 阶段推进、归档、对外发消息 | **不进** |

`dev-done` 技术上只是改一个 `phase` 字段，改回去易如反掌。但它会触发通知、物化会话、推进团队流程 —— 字段改回来了，测试同学已经收到「可以测了」。更根本的是：**「这个需求可以进测试了」是主机的管理决策，不是技术动作**。

agent 想做这些时只能调 `notify_host`。

## 七、`start_dev_task` 执行模型

### 7.1 per-需求常驻 worktree

```js
// git.js 新增（与 autoWorktreeDir 并列）
export function reqWorktreeDir(repo, reqId) {
  return String(repo).replace(/[\\/]+$/, '') + '.req-' + String(reqId).slice(0, 8);
}
export async function ensureReqWorktree(repo, reqId)   // 复刻 ensureAutoWorktree 的健康检查 + 归属校验
```

沿用 `ensureAutoWorktree` 的三条纪律：健康 → 归属校验（必须登记在本 repo 的 `worktree list` 里）→ 直接用；缺失则 `prune` 后重建；**目录存在但属于其他仓库 → 明确失败，绝不自动删用户目录**。

建于定稿（`finalizeRequirement` 建需求分支之后），清理于归档 / 删除。记在 `req.agentWorktrees[]`。

### 7.2 完整流程

```
start_dev_task(reqId, taskDescription)
 1. ensureReqWorktree(repo, reqId)                    → dir
 2. commitResidue(dir)                                 自愈上次异常中断的残留
 3. git -C dir checkout -B req/<reqId>/agent-<msgId> <需求分支>
       ★ 用 -B <branch> <base> 而非检出 base 本身，绕开「同一分支不能双 worktree 检出」
 4. 回复同事：「好，我按需求《X》处理，改在分支 <branch> 上」     ← §6.2
 5. sessions[].push({ convId, kind: 'sub', phase, title })       挂需求会话树，web 可见
    startClaudeRun(run, { prompt, cwd: dir, mode: 'bypassPermissions', convId })
 6. onSettle：
      a. commitAll(dir, msg)          无改动即失败（防谎报），失败则止于此并告知同事
      b. 进合并队列（§7.3）
      c. 写 agent-actions 台账 { undo: { kind:'revert-merge', repo, branch, baseBranch, mergeSha } }
      d. markHandled + 回同事简报（run.result 截 200 字）
      e. 推主机飞书卡片：已合并｜待合并 · 撤销
```

### 7.3 四层队列（P2 实施时从三层修正为四层）

worktree 隔离之后，需要排队的只剩合并 —— **这个判断在实施时被证明不完整**，见下面第 2、3 层。

| 层 | 范围 | 原因 |
|---|---|---|
| ① agent 任务之间 | 同一需求串行（`req.busy` 闸） | 共用一个 per-需求 worktree，两个 checkout 会打架 |
| ② **busy 的写入时机** | **必须在第一个 `await` 之前**（同步段） | 见下 |
| ③ **per-worktree 串行闸** | 只圈「碰工作区的那几步」 | 见下 |
| ④ 合并 | **全局按 repo 串行** + `isClean(主工作区)` 闸 | `mergeBranch` 落在主工作区；`add -A` 会吞掉主机未提交的改动 |
| — 与主机主会话 | **不排队** | 不同目录，互不可见 |

最后一行是相对四期设计的改善：原设计让 agent 任务排在主会话后面，同事收到「开始处理」后可能干等几分钟。

#### ② 为什么 busy 必须写在第一个 await 之前

泵 `POLL_MS = 5000` 每 5 秒 tick，`canDispatch`（`requirement-ops.js:94`）**只看 `req.busy`**；而 `dispatchColleagueDev` 的调用点（`requirement-ops.js:344`）是**裸调不 await**，位于同步函数 `dispatch()` 内。

所以 busy 若晚于 worktree 准备（有 await）才写盘，同需求的下一条同事消息会在准备期间被并发派发 —— 两个任务抢**同一个** `<repo>.req-xxx` 目录（worktree 按**需求**分，不按消息分），后者的 `checkout -B` 直接把前者的分支顶掉。

代价：worktree 建不起来时会 `createRun` 一个随即 `failRun` 的 run（`start` 从未调用）。这个代价必须认。

#### ③ 为什么还需要一道 per-worktree 闸

「清 busy 留在同步段」（为了立刻放开串行闸、不让下个任务等合并排队）带来的直接后果：**busy 放开时改动还没提交**。下一条任务的 `checkout -B` 可能插在上一条 `commitAll` 之前，把 agent 刚写的代码连 HEAD 一起切到新分支 —— 上一条就提交到了别人的分支上。

这道闸只圈「碰工作区的那几步」（`commitResidue` + `checkout -B` ↔ `commitAll` + `detach`），**合并排队留在锁外** —— 圈进来等于把 busy 的等待原样搬回来。

#### 另外两条实施时的决定

- **提交成功后必须 `git checkout --detach`**：否则分支被 worktree 占着，撤销侧 `deleteBranch` 会被 git 拒绝（`git.js:209` 注释明写了这条）。
- **合并 `failed` 也写台账**：提交与分支都在，一样撤得回（走 `mergeSha === null` 的删分支路径），只把 `ok` 记 false。

**`isClean` 脏时降级为「待合并」**（不阻塞、不失败），推卡片给主机手动合并。语义与 auto-dev 的「自动合并失败则静默降级回待人工合并态」一致。

### 7.4 撤销

`revertMergeCommit(repo, { task: { branch, baseBranch }, mergeCommit }, opts)` 原样复用。其 `isClean` 闸（`revert.js:114`）必须保留 —— 路径 A 下执行目录就是主工作区，脏则停手报错，否则无关的未提交改动会被 `commitAll` 的 `add -A` 卷进撤销提交。

## 八、失败语义

| 失败点 | 行为 |
|---|---|
| agent 超时 / 额度耗尽 / 流不结束 | 退化到三期 ACK（「已收到，信息会同步发送给主机！」）+ warn 留痕。**消息已落盘，不丢** |
| `canUseTool` 拒绝 | 工具返回 `{error}`，agent 自己决定怎么跟同事说 |
| 工具 handler 抛错 | 捕获成 `{error}` 喂回模型，不中断整轮 |
| `ensureReqWorktree` 失败 | `start_dev_task` 返回错误；agent 告知同事并 `notify_host` |
| `commitAll` 无改动 | 视为失败（防谎报），告知同事「没有产生改动」 |
| 合并 `isClean` 不过 | 降级「待合并」，**不算失败** |
| 限流超限 | 回 ACK，不起 agent |

**统一原则：任何失败都退化到三期行为，不会比现状更糟。** 同事手里至少有一条 ACK，主机在 web 端也能看到原消息。

### 8.1 已知缺口：对话轮次拿不到 `runClaude` 的网络抖动重试

P1 实现时发现（2026-09-22，已复验）：

```
llm-classify / llm-readonly-agent / llm-write-agent  → 走 integrations/claude.js#runClaude
llm-sql-agent / agent-session                        → 直接 import { query } from SDK
```

**根因**：`runClaude` 的 opts 不透传 `mcpServers` / `tools`，凡是要挂 MCP 工具集的骨架都走不了它。这不是本设计引入的，`llm-sql-agent` 早就如此。

代价：`runClaude` 里那套 stalled / mid-stream 自动重试（1s→2s→4s 退避，`claude.js:234`）对 agent 对话轮次**不生效**。当前用 `AGENT_TURN_TIMEOUT_MS` 超时兜底代替 —— 行为是「失败就落兜底让他重说一句」而非「自动重试」。

**暂不修的理由**：对话场景对面是活人在等，一次网络抖动重试三轮可能比直接说「没听清，再说一遍」更差。但如果 P1 实测发现抖动失败率不低，两条路可选：① 给 `runClaude` 加 `mcpServers`/`tools` 透传（惠及 sql-agent）；② 在 `agent-session` 这层自己补重试。**决策依据是 P1 的实测数据，不要提前做。**

分类/agent 调用的 warn 必须打在本层 —— `llm-classify` 对「超时后流优雅收尾」与「unparsable」两条路径是静默的，只看它的日志会把解析失败误读成模型判定。

## 九、分期

每期可独立上线、独立验证。

| 期 | 交付 | 验证目标 | 关键风险 |
|---|---|---|---|
| **P1** ✅ **已完成（2026-09-22）** | `agent-tools.js` 注册表 + `agent-session.js` + 5 个 safe 工具 + 命令行探针 | **对话手感 / 延迟 / 额度花销** | 已验证通过，见 §9.1 |
| ~~P2~~ → **P3** ✅ **已完成（2026-09-28）** | 飞书入口合并（文本 + 文件一条链路）+ `colleague-messages` 迁移 + 限流 + `colleague-relay` 下线 | 入站完整性、迁移无损 | 文件链路现在在 dispatch 之前被截走（§4） |
| ~~P3~~ → **P2** ✅ **已完成（2026-09-23）** | `ensureReqWorktree` + `register_api_doc` + `start_dev_task` + 四层队列 + `agent-actions` 台账 + 撤销执行 | 可撤销闭环真的能撤 | `isClean` 闸与主工作区（§3.3、§7.3） |

> **⚠️ P2 与 P3 已对调**（2026-09-23 拍板）。原顺序会开一个功能回退窗口：`colleague-auto.js`（四期自动处理）唯一的触发源是 `colleague-relay`，下线它等于「后端发接口文档 → 自动登记 + 起子会话改代码」停摆，要等写工具落地才恢复。
>
> 而入口切换是整个 2.0 里**最难回退的一步**（带破坏性数据迁移）。做一次、在 agent 能力齐备之后做，比先切过去再补能力安全得多。两者无硬依赖，对调是干净的。
>
> 副作用（刻意的）：P2 改造了 `colleague-dev.js` 本身而非另写并行路径，所以**今天在跑的四期自动处理立刻获得了可撤销能力** —— 顺带补上了 §3.3 那个「需求侧改代码完全不可撤销」的既有缺陷。
| **P4** | 其余 reversible 工具 + `run_action` / `tracking_report` 注册 + 同事侧槽位状态机与 L2 关键词退役 | 「加工具不改 agent」成不成立 | `action-configs` 变量声明 → zod shape 的转换 |
| **P5** | web 监管面：按人看对话、工具轨迹、一键撤销 | — | — |

**P1 先行的理由**：最大的未知不是技术可行性（`llm-sql-agent.js` 已证明这条路走得通），而是「每条消息付 ~3s SDK 冷启 + 烧订阅额度」这个体验与成本能否接受。`llm-classify.js` 实测注释记着冷启 2.7~3.7s 且砍不掉。P1 用最小代价把它试出来；不行则 P2~P5 全部作废。

### 9.1 P1 验收结果（2026-09-22 实测，各 4 样本）

| 指标 | 原定阈值 | 实测中位 | 判定 |
|---|---|---|---|
| 单轮耗时（无工具） | ≤ 6s | **6.7s** | ⚠️ 稳定超 ~0.8s |
| 单轮耗时（含 1 次工具） | ≤ 20s | **9.9s** | ✅ 余量充足 |
| resume 是否生效 | 必须 | **生效** | ✅ |

**结论：技术通路成立，决策 #5（Claude Agent SDK + 进程内 MCP）维持，P2 可开工。**

**一个反直觉的发现，直接改变了指标的读法**：模型倾向「能查就查」—— 连「你好，你能帮我做什么？」都会先调 `list_my_requirements` 探底。只有纯寒暄才真的零工具。

这说明**原定的 6s 阈值选错了对象**：真实对话里几乎每轮都带至少一次工具调用，**操作性指标是 ~10s 那个，不是 ~6.7s 那个**。6.7s 超标不构成回炉理由 —— 它测的是生产中几乎不出现的场景。

而「偏爱调工具」这个倾向本身是好事：它正是 §6.1「事实性问题一律用工具查」生效的证据，没出现凭记忆瞎答的倾向。代价是每轮延迟里几乎总含一次工具往返。

**~10s 对飞书场景可接受**：异步工作沟通，同事不会盯着输入指示器等秒回；对比四期分类器管线（也要一次 Haiku + 一次 ACK），体感差距不大，换来的是能追问、能查证、能反驳。

resume 的验证细节值得记：第 2 轮答对「蓝色」时**零工具调用且耗时更短**（5.5s vs 6.5s），证明它是靠 SDK session 记忆作答，而非重新查询凑巧对上 —— 这排除了假阳性。

## 十、测试

| 层 | 覆盖 |
|---|---|
| `agent-tools.test.js` | 注册校验（`reversible` 缺 `buildUndo` 必抛、`external` 缺 `exposedFlag` 必抛、`buildUndo` 运行时返回 `null` 视为执行失败）、按 role 过滤、MCP server 组装 |
| `agent-session.test.js` | 注入假 `query`：工具调用、拒绝、超时、解析失败四条路径 |
| `colleague-messages.migration.test.js` | 旧 / 新 / 混合 / 空 四种输入的迁移纯函数 |
| `colleague-agent/prompt.test.js` | system prompt 组装（角色、需求列表、policy 齐全） |
| `colleague-agent/feature.test.js` | 名册判定、群聊 @、限流、PASS 回落 |
| `agent-actions.test.js` | 台账写入、undo 分派、并发写 |
| `git.test.js` 增补 | `reqWorktreeDir` 纯函数、`ensureReqWorktree` 真实 git 仓库测试（对齐现有 `auto-dev/git.test.js`） |
| 队列 | 同需求串行、跨需求并行、`isClean` 脏时降级 |

`npm test` 必须全绿方可进入下一期。

## 十、五 技术债：写工具对 `entrypoints/web` 的反向依赖

P2 实施时暴露：`register_api_doc` / `start_dev_task` 要调的 `registerApiDoc` 与 `enqueueSystemTask` 都住在 `entrypoints/web/requirement-ops.js`，而 `plugins → entrypoints` 是**反向依赖**（分层是 `entrypoints → app → features/plugins → capabilities → integrations/store → shared`）。

**当前解法：动态 `import()` + 单例缓存**（`req-write.js#loadReqOps`）。三条理由：

1. 避免在插件模块顶层挂一条**静态**反向边 —— 即便当前无真实循环，它也会被将来的边界检查工具标出来。
2. `requirement-ops.js` 是重模块（内含 git / lark / claude 调用链），静态 import 会让「加载 colleague-agent 插件」这个动作意外拖出一整条执行链。
3. **插件在 feishu 进程也会被加载**（走 `PLUGIN_MANIFEST`），但工具只在 **web 进程**被调用（§3.5）。动态 import 让那条重依赖只在真正用到它的进程里加载 —— 静态 import 会让 feishu 进程白背一整条 git/claude 链。

**真正干净的解法**是把这两个函数下沉出 `entrypoints/web`（挪进 `features/` 或 `capabilities/`），让它们本来就活在 plugins 能顺向依赖的层。没做的原因：它们深度耦合 `requirement-ops.js` 的串行闸与 busy 状态机（`dispatch` / `pump` / `canDispatch`），搬家的影响面远超 P2 范围。

**触发条件**：P4 再加写工具时，若又出现第三、第四个要反向依赖的函数，就该做这次下沉了 —— 三处以上复制同一条绕路，说明层划错了而不是个案。

## 十一、遗留与后续

- **跨进程 `postToWeb` 范式目前有 5 份复制**（create-session / stop-patrol / feishu-relay / bug-patrol / auto-notify），本设计会再加一处。已够抽到 `shared/`，建议在 P2 顺手做掉。
- owner 侧是否也 agent 化：本期不做，P1 的延迟与成本数据出来后再议。
- 群聊场景只做了 `@` 触发，群内多人协作（agent 同时面对多个角色）不在本期范围。

# src/capabilities · 模块地图

**定位**：通用能力层——无业务语义、可被 `features`/`plugins` 复用的三块基础设施。按分层单向依赖，本层只向下依赖 `integrations`/`store`/`shared`，不 import 上层。三块能力是：备用账号轮换（`token-rotation`）+ 两种形态互补的 LLM 调用骨架（`llm-classify` 单轮零工具 / `llm-readonly-agent` 多轮只读）。

## 文件清单

| 文件 | 职责 |
|---|---|
| `token-rotation.js` | 备用 Token 轮换引擎：纯函数状态机（`pickActive`/`reduceRateLimit`/`recoverExpired`）+ 有状态胶水（读写 settings、switch-back 定时器、切换通知）。active token 不落库，由 `pickActive` 实时算出「偏好最高的可用号」。 |
| `token-rotation.test.js` | 纯函数状态机的单测。 |
| `llm-classify.js` | 单轮**零工具** LLM 分类骨架，各分类点共用；封装事故驱动的防卡死细节（额度 fail-fast、abort+race 双保险、禁全部工具、首个 JSON 块提取、失败归因），并统一 `DEFAULT_EFFORT='low'`（全部调用点都是浅层任务，逐点传会分叉）。 |
| `llm-classify.test.js` | `extractFirstJsonObject`/`classifyOutcome` 等的单测。 |
| `llm-readonly-agent.js` | 多轮**只读** LLM 骨架，用于必须实地读代码才能作答的任务（生成项目地图）；核心是三层只读防线。 |

## 关键流程

### 模块内的分层关系（读代码才看得出）

`token-rotation.js` 是本模块地基：另外两个骨架都 import 它的 `claudeAuthOpts`/`getTokens`/`isPoolExhausted`，而它反过来不依赖任何一个。两个 LLM 骨架是**并列**的两种调用形态（文件头明确写了分工），但并非全无关系——`llm-readonly-agent.js` 复用了 `llm-classify.js` 导出的 `extractFirstJsonObject`（JSON 抽取逻辑只此一份，不重复造）。所以模块内依赖方向是：

```
llm-readonly-agent ──┬─→ llm-classify(extractFirstJsonObject)
                     └─→ token-rotation ──→ store/settings, shared/provider-ids
llm-classify ────────────→ token-rotation
(三者)      ────────────→ integrations/claude.js(runClaude)
```

### 流程一：Token 轮换（谁在跑、撞墙后怎么切、怎么切回）

1. **起跑注入**：调用方 `runClaude(prompt, { ...claudeAuthOpts(), ... })`。`claudeAuthOpts()` → `getActiveToken()` → `pickActive(getTokens())` 算出当前该用哪个号，注入 env `CLAUDE_CODE_OAUTH_TOKEN` + 挂 `onRateLimit` 归因回调；无可用备用号则返回 `{}`（退回主账号登录）。
2. **撞墙**：SDK 报限流 → `noteRateLimit(tokenId, info)` → `mutateTokens((cur) => reduceRateLimit(...))` 在文件锁内读-改-写 settings（web/feishu 双进程都会写，不锁会互相覆盖）→ 纯函数 `reduceRateLimit` 推进该号状态机（healthy/warning/exhausted）并算出 switch 通知。
3. **排程切回**：`noteRateLimit` 末尾调 `scheduleAllSwitchBacks()`，为非 healthy 且有 `resetsAt` 的号设定时器（到点 +30s）；触发 `doRecover()` → `recoverExpired()` 把已到重置时刻的号恢复 healthy。因 active 由 `pickActive` 实时计算，主号一恢复 healthy 就自然重新成为 active——「切回原账号」是涌现出来的，无需显式记录。
4. **两种接入姿势**：绝大多数调用方走 `claudeAuthOpts()` 一把梭（见下方消费者列表）；唯有 web 主执行链 `entrypoints/web/run-claude.js` 因为要按 `run._tokenId` 逐 run 归因，手动拆用 `getActiveToken`/`noteRateLimit`。
5. **前端面板**：`entrypoints/web/routes-settings.js` 消费 `getStatus`/`consumeNotice`/`scheduleAllSwitchBacks`；`entrypoints/web/server.js` 启动时调一次 `scheduleAllSwitchBacks()` 恢复跨重启排程。

### 流程二：单轮分类（`llm-classify`）

`runClassifierOnce(opts)` 是 `runClassifierDetailed(opts).data` 的薄包装（多数调用点只关心「拿到没拿到」，只有 tracking-stats 需要失败原因才直接用 Detailed）。Detailed 的路径：`isPoolExhausted(getTokens())` 额度耗尽 fail-fast → `runClaude(..., maxTurns:1, disallowedTools:['*'])`（通配符禁全部工具，防分类模型把消息当真任务起子代理）→ `abort` 定时器 + `Promise.race` 双保险（限流时 SDK 流可能永不结束）→ 收集 `onText` → `classifyOutcome({aborted, text})`：**先** `extractFirstJsonObject`+`JSON.parse` 试解析、**再**看是否 aborted 判超时（模型常早早吐完 JSON 而流迟迟不收尾）→ 归结 `{data, reason:'exhausted'|'timeout'|'unparsable'|null}`。

### 流程三：只读多轮（`llm-readonly-agent`）

`runReadonlyAgent(...)` 同样先 `isPoolExhausted` fail-fast + 检查外部 `signal`。关键是**三层只读防线**（缺一即漏，均为事故换来）：第 1 层 `FORCE_ASK_HOOKS`（PreToolUse→'ask'，从 settings.json 的 allow 规则手里夺回裁决权）；第 2 层 `canUseTool` 运行时白名单 `READONLY_TOOLS`（无论工具被怎么捞回来，执行前都过这关，越权者记入 `denied`）；第 3 层 `disallowedTools: DENIED_TOOLS`（补不全，只为省轮次）。`permissionMode` 必须 `'default'`（`bypassPermissions` 会绕过前两层）。产出经 `extractFirstJsonObject` 抽 JSON，返回 `{data, reason, denied}`。唯一消费者是 `features/project-optimize/gen-map.js`（地图生成，超时 `READONLY_AGENT_TIMEOUT_MS`=600s，文件内注明并发压到 3）。

### 消费者速览

- **分类骨架**：`app/intent.js`、`plugins/team-tools/task-triage`、`plugins/team-tools/bug-patrol`、`plugins/action-runner/feature/slot-filler`、`plugins/tracking-stats/understand.js`（用 Detailed）、`features/project-checkup`、`features/memory-bank/extract.js`、`features/project-optimize/describe-skill.js`、`entrypoints/web/req-inspect.js`。
- **只读骨架**：`features/project-optimize/gen-map.js`。
- **`claudeAuthOpts` 直接接入**：`entrypoints/web/tier.js`、`entrypoints/web/requirement-ops.js`、`plugins/team-tools/*`（task-ops/review/project-qa）等。

## 常见改动入口

- 要**加/改一个新号的选取偏好或撞墙后的状态迁移**，就改 `token-rotation.js` 的纯函数 `pickActive` / `reduceRateLimit` / `recoverExpired`（先在 `token-rotation.test.js` 补例）。
- 要**调切回原账号的时机/定时器行为**，就改 `token-rotation.js` 的 `scheduleAllSwitchBacks` / `doRecover`。
- 要**让某个新的 `runClaude` 调用点也跟随备用账号轮换**，就在该调用点 spread `claudeAuthOpts()`（不要动本模块）；只有需要逐 run 归因时才仿照 `run-claude.js` 手动拆 `getActiveToken`/`noteRateLimit`。
- 要**改前端 token 面板展示字段/通知**，就改 `token-rotation.js` 的 `getStatus` / `consumeNotice`（消费方在 `routes-settings.js`）。
- 要**加一个新的单轮分类点或调分类的超时/防卡死策略**，就改 `llm-classify.js`（分类点各自传 `prompt`/`model`/`logTag`/`timeoutMs`，语义校验留在各自调用方）。
- 要**改「模型回复里抽 JSON」的规则**，只改 `llm-classify.js` 的 `extractFirstJsonObject`（只读骨架也复用它，改一处两处生效）。
- 要**放宽/收紧只读调用允许的工具**，就改 `llm-readonly-agent.js` 的 `READONLY_TOOLS` 白名单（第 2 层是真正的闸）；`DENIED_TOOLS` 只是减少无用尝试，别指望它兜底。
- 要**新增一种「读代码作答」的多轮只读任务**，复用 `runReadonlyAgent`（传 `cwd`/`prompt`/`signal`），把业务逻辑放到 `features`/`plugins`——本模块只提供无业务语义的骨架。

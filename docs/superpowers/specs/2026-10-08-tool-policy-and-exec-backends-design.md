# 工具策略引擎 + Bash 执行后端（T6）· 设计

- 日期：2026-10-08
- 状态：已拍板（2026-10-08，四处决策经确认）；实现中，进度见 §8
- 关联：`next-tasks.md` T6；前置：T2（run 事件流/状态机）、T5（benchmark，用于回归「标准档不断自动任务」）
- 外部参考：pi 的立场——**权限提示不是安全边界**；无人值守的正解是执行环境隔离（容器），提示只做「人在环」的交互体验

## 1. 背景与问题

### 1.1 现状（改动前必须认清）

| 路径 | 审批逻辑 | 问题 |
|---|---|---|
| Claude 交互式（web run） | `permissionMode` 四档 + default 档 PreToolUse 强制 `ask` → `canUseTool`（`READONLY_TOOLS` 放行，其余弹卡） | 只读清单含 `WebFetch/WebSearch`（网络无审批）；规则内联在 run-claude |
| openai 交互式 | `autoAllow`（MCP 白名单）＋ `builtinApprovalDecision`（只读且区内放行，其余弹卡） | **完全不支持 mode**（前端选了也不生效）；规则内联在 run-openai |
| **无人值守**（auto-dev / 需求系统任务 / colleague-dev） | **写死 `bypassPermissions`**（彻底放行） | 无人值守 = 全权；"自主分级"不存在 |

两条路径规则分散、无人值守无分级——T6 要收敛成一个**共用规则表**并给容器后端留接缝。

### 1.2 缺口

- G1 规则分散：同一件事（只读放行/越界/网络）在两处各写一份，改一处必漏另一处；
- G2 无危险命令防线：`rm -rf /` 与 `git status` 走同一条路（都弹卡），无「一律拒绝」档；
- G3 无人值守全放行：bypassPermissions 之下没有任何策略与留痕；
- G4 Bash 只有本地后端：无人值守的隔离只能靠「信任任务内容」，无法切容器。

## 2. 目标与非目标

**目标**

1. **共用规则表**（纯函数）：`档位 × 动作类别` 矩阵 + 危险命令 deny 名单 + 安全命令表；Claude 与 openai 两条路径都从它取裁决；
2. **交互路径档位复用现有四档 mode**（default / acceptEdits / plan / bypassPermissions），行为变化仅两处（网络类从"静默放行"改为审批；openai 首次获得 mode）；
3. **无人值守路径可配档位**：新增 bot 级 `execPolicy`（`bypass`(默认，兼容现状) / `standard` / `trusted`）；`standard`＝区内读写自动、安全命令放行、其余拒绝并计次；`trusted`＝除危险命令外全放行；
4. **策略拦截计次 → 熔断升级 owner**：无人值守下被策略拒绝的操作计次，累计 N=3（与 `MAX_RESUME_ATTEMPTS` 对齐）→ 停止 run + 系统通知（会话通知开启时另有卡片），不让任务对着墙烧额度；
5. **Bash 双执行后端（openai 路径）**：`local`（现状）/ `container`（docker/podman，工作区挂载、网络默认关）；容器不可用时 fail-closed（不静默退回本地）。

**非目标（本期不做）**

- Claude 路径 SDK Bash 的容器化（SDK 的 Bash 由 CLI 子进程执行，换后端＝换自研 MCP Bash 或整体容器化 CLI，另期）；
- 容器内 `Read/Write/Edit` 的挂载视图重构（文件工具仍在宿主进程按挂载路径读写，容器只承载 Bash）；
- 网络白名单/域名级代理；权限提示的「记住选择」（沿用现有逐次审批）；
- execPolicy / exec 设置页 UI 的完整打磨（本期内嵌最小选择器；配置本身全链可用）。

## 3. 拍板记录（2026-10-08 已确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 档位载体 | **共用规则表 + 复用现有四档 mode**（交互零新 UI；openai 首次获得 mode） |
| 2 | 无人值守迁移 | `bot.execPolicy` 默认 **`bypass`**（兼容现状），可切 `standard` / `trusted`；先用测试项目验证再改默认 |
| 3 | 重试升级语义 | **策略拦截计次 → 熔断升级 owner**：无人值守 ask 类按默认拒绝，累计 N=3 未完成 → 停 run + 通知 |
| 4 | 容器范围 | **只做 openai 路径 Bash**；Claude 路径记边界（政策表 + 人工合并兜底） |

## 4. 设计

### 4.1 规则表（`src/capabilities/tool-policy.logic.js`，纯函数）

**动作类别** `classifyTool(toolName)`：`read | write | execute | network | mcp | other`

- read：Read/Grep/Glob/LS/NotebookRead/TodoWrite/RepoMap + `readOnlyExtra`（如 Feishu 的 WaitColleagueReply）+ MCP `autoAllow` 命中；
- write：Write/Edit/MultiEdit/NotebookEdit；
- execute：Bash；
- network：WebFetch/WebSearch（网络类，审批）；命令级网络（curl/wget/ssh/scp/git push/npm publish/npx 下载）在 execute 内识别；
- mcp：其余 MCP 工具（无白名单 → ask）；
- other：Agent/Task 子代理与未知工具（Agent 放行——其内部改动类工具会逐个走审批，先例见 READONLY_TOOLS 注释）。

**档位矩阵**（`decideToolAction` 按其裁决；越界＝目标路径在工作目录外）：

| level | 区内读 | 区内写 | 安全命令 | 一般命令 | 网络/外发 | 越界读 | 越界写 | 危险命令 |
|---|---|---|---|---|---|---|---|---|
| default | allow | ask | ask | ask | ask | ask | ask | **deny** |
| acceptEdits | allow | allow | ask | ask | ask | ask | ask | **deny** |
| plan | allow | deny | deny | deny | deny | ask | deny | **deny** |
| bypassPermissions | allow | allow | allow | allow | allow | allow | allow | **deny\*** |
| unattended-standard | allow | allow | allow | ask→deny | ask→deny | ask→deny | ask→deny | **deny** |
| unattended-trusted | allow | allow | allow | allow | allow | allow | allow | **deny** |

\* Claude `bypassPermissions` 下 SDK 不调用 `canUseTool`（记边界）；openai 路径仍可拦。

**危险命令 deny 名单**（独立于档位；保守——只拦明确灾难性，宁漏勿误杀）：

| id | 覆盖 | 例 |
|---|---|---|
| `rm_root` | 删根/家目录 | `rm -rf /`、`rm -rf ~`、`rd /s /q C:\`、`del /f /s /q C:\` |
| `disk` | 磁盘/分区破坏 | `mkfs*`、`diskpart`、`dd … of=/dev/sd*`、`format C:` |
| `power` | 关停机器 | `shutdown*`、`reboot`、`halt`、`poweroff` |
| `fork_bomb` | fork 炸弹 | `:(){ :\|:& };:` |
| `recursive_perm` | 全盘改权限 | `chmod -R 777 /`、`chown -R … /` |

**安全命令表**（`isSafeCommand`，仅单段命令——含 `| & ; < > ` `` ` `` `$(` 即不命中）：

- `npm test`、`npm run <test|build|lint|typecheck|check|verify>`；
- `node --test …`、`npx --no-install <tsc|eslint|…>`；
- `git <status|diff|log|show|branch|rev-parse|ls-files|blame>`；
- 只读系统：`ls|dir|cat|type|head|tail|pwd|where`.

### 4.2 运行时门（`src/capabilities/tool-policy.js`）

```js
createPolicyGate({ provider, level, unattended, workspace,
                   disabledTools, autoAllow, readOnlyExtra,
                   maxBlocks = 3, onDeny, onFuse })
  → { decide(toolName, input) → {action, klass, ruleId, reason}, blocks() }
```

- `decide` 调纯函数；**无人值守下 `ask` 一律翻译为 `deny`**（reason 说明"需要人工审批，已按策略拒绝"）并计次；
- `disabledTools`（用户显式关闭）→ deny（两路径统一，openai 首次支持）；
- 计次仅无人值守：每次 deny（含危险命令）`onDeny({tool, klass, ruleId, reason, count})`；
  计数达 `maxBlocks` → 一次性 `onFuse({count, last})`；
- `stopRun(run, reason)` + `systemNotify` 由调用方在 `onFuse` 里执行（capabilities 不 import store）；交互路径只 deny 不熔断（人在看，不需要替用户做停止决定）。

### 4.3 两条路径接入

**Claude（`run-claude.js`）**
- `startClaudeRun` 新增 `policyLevel` / `unattended` 参数；`resolveUnattendedPolicy(execPolicy)` → `{sdkMode, policyLevel}`（bypass→`bypassPermissions`，standard→`default`+`unattended-standard`，trusted→`default`+`unattended-trusted`）；
- `canUseTool` 改为「gate.decide → allow/deny/ask 卡片」；`WebFetch/WebSearch` 从只读清单移出（网络类 → 审批）；
- `onDeny` → `emitRunEvent(run,'policy_block',…)`；`onFuse` → `stopRun(run, …)` + `systemNotify`。

**openai（`run-openai.js`）**
- `startOpenAiRun` 接收 `mode`（routes-run 透传；chat.js 的 openai 请求体补 `mode`），存 `run.mode`；gate level＝`run.mode`；
- `canUseTool` 改用 gate（`autoAllow`/内置只读/FEISHU 只读/disabledTools 全走表格）；`builtinApprovalDecision` 与 `toolPaths` 退役（逻辑并入规则表，测试迁到 tool-policy）；
- 未知 MCP 工具 → ask（同现状）。

**无人值守调用方**（`requirement-ops.js` / `colleague-dev.js` / `auto-dev` 的 `develop`）
- 从写死 `bypassPermissions` 改为 `resolveUnattendedPolicy(getActiveBot()?.execPolicy)`；
- `develop`（runClaude 直调路径）用 `buildClaudePolicyOpts({…})` 拼 `permissionMode + hooks + canUseTool`（bypass 档返回 `{permissionMode:'bypassPermissions'}`＝现状，零变化）。

### 4.4 配置

- **`bot.execPolicy`**：`'bypass'(默认) | 'standard' | 'trusted'`；`settings.js` 归一 + `/api/bots` 白名单 + 设置页机器人表单最小下拉；
- **`settings.exec`**：`{ backend: 'local'(默认) | 'container', image: 'node:22-bookworm', network: false }`；归一化与默认值；设置页 UI 下期（settings.json 可直接配）。

### 4.5 容器执行后端（openai Bash）

- `exec-backends.logic.js`（纯函数）：`pickEngine({docker,podman})`、`buildContainerArgs({engine,image,workspace,command,network})`、`normalizeExecSettings`；
- `exec-backends.js`：`resolveBashBackend(execSettings, {probe})` → `{kind:'local'}` / `{kind:'container', engine, image, network}` / `{kind:'unavailable', reason}`（探测 `docker version`，结果缓存）；`makeBashSpawn(backend, command)` → `{bin,args,shell}`；
- `builtin-tools.js`：`createBuiltinTools({…, bashBackend})`，Bash 执行核复用（killTree/超时/abort 不变），只是把 `spawn(command,{shell:true})` 换成 `spawn(bin,args,{shell})`；
- `run-openai.js`：按 `settings.exec` 解析 backend 传入；`unavailable` 时 Bash 返回明确错误（**不静默退回本地**）并记 activity 警告。

## 5. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1** 规则表 + 双路径接入 + 熔断 | §4.1~§4.4；`builtinApprovalDecision` 退役 | 纯函数/门/两路径 wiring 单测；全量 `npm test` 全绿；e2e 全绿 |
| **P2** 容器后端 | §4.5 | 纯函数单测 + 假探测注入测试；真 docker 手工验收（本机无则记边界） |

## 6. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 行为变化（网络类改审批 / openai 获得 mode） | 均为**收紧/等价**方向；交互 default 档 = 原语义 + 网络审批；openai 未传 mode 时 = `default`（与现状同为"非白名单全问"） |
| 无人值守切 standard 断自动任务 | 默认 `bypass`（零变化）；切换前用 T5 benchmark / 测试项目验证；切换后策略拦截有留痕与熔断通知 |
| Claude `bypassPermissions` 绕过 deny 名单 | 记录边界；无人值守不再默认 bypass 后可被 standard/trusted 覆盖（trusted 下 canUseTool 仍会走 gate？——trusted 的 sdkMode 为 default，会走 ✅） |
| 容器探测阻塞启动 | 探测带超时 + 缓存；只在 openai run 且配置 container 时探测 |
| 熔断误伤（合法重试被计数） | 只对**无人值守 + 策略明确拒绝**计次；用户点击的拒绝不计；N=3 与既有熔断同量级 |

## 7. 测试策略

- `tool-policy.logic.test.js`：矩阵表驱动（6 档 × 类别 × 区内/外）、危险命令正/反例（`rm -rf ./build` 不得误杀）、安全命令（含链式命令不命中）、`resolveUnattendedPolicy`；
- `tool-policy.test.js`：gate 裁决、disabledTools、autoAllow、unattended ask→deny 翻译、计次与 `onFuse` 恰一次、交互 deny 不熔断；
- `workspace-paths.test.js`：路径归一/越界判定（自 builtin-tools 抽出）；
- `builtin-tools.test.js`：Bash 注入后端（假 bin）行为；`builtinApprovalDecision` 用例迁移；
- `exec-backends.logic.test.js`：engine 选择、参数构造（挂载/网络/工作目录）、settings 归一；
- routes/openai：`mode` 透传落 `run.mode`；
- 全量 `npm test` + e2e 12/12。

## 8. 实施状态

- [x] spec 拍板（2026-10-08，四处决策见 §3）
- [x] **P1** 规则表 + 运行时门 + 双路径接入 + 无人值守档位 + 计次熔断（2026-10-08：`capabilities/tool-policy{,.logic}.js`、`shared/workspace-paths.js`、run-claude/run-openai 策略门、requirement-ops/colleague-dev/task-ops 无人值守接入、`bot.execPolicy` 全链 + 设置页下拉、`builtinApprovalDecision`/`READONLY_TOOLS` 退役；`policy_block` journal 事件 + `stopRun`+`systemNotify` 熔断）
- [x] **P2** Bash 容器后端（openai 路径）（2026-10-08：`providers/exec-backends{,.logic}.js`、builtin-tools `bashBackend` 注入、`settings.exec` 全链（无 UI，settings.json/API 可配）、引擎不可用 fail-closed）

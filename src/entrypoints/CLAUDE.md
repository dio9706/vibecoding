# src/entrypoints · 模块地图

> 本目录是「渠道 → 业务」之间的**组装层 / 传输层**：把不同来源（web HTTP、飞书长连接、控制台）的入站，拼成统一 `ctx` 或 `run` 再往下交。改动前先认准一个分野——
>
> **`console/` 与 `feishu/` 走 `app/dispatch`**（意图识别 → feature 路由），各自只有一个 `index.js`；**`web/` 不走 dispatch**（`server.js` 注释：web 恒为本机 owner，聊天直连 provider 流式，避免 dispatch 的流式阻抗）。这就是为什么 `web/` 目录这么重、而另两个入口各一个文件——web 把「起跑 / 收尾 / 续跑 / 审批 / SSE」这套 dispatch 不管的编排全揽在了自己身上。架构全景见仓库根 `docs/ARCHITECTURE.md`。

## 一、文件清单

### 非 web 入口（走 dispatch）
- `console/index.js` — 控制台入口：console 渠道收行 → 组装统一 `ctx` → `dispatch`，本地调试意图/feature 全链（`CONSOLE_ROLE=guest` 可模拟访客）。
- `feishu/index.js` — 飞书入口：channel 收信 → 角色判定 / 群聊 @ 过滤 / 图片文件材料池 / 云文档拉取等业务特例 → `ctx` → `dispatch`；导出 `registerCardActionHandler`（卡片回调注册）。

### web 入口：核心骨架
- `web/server.js` — web 真入口：建 HTTP server、**有序 ROUTES 路由表**、CORS、访问日志；`listen` 回调里启动各泵并做崩溃恢复；导出 `ready`（listen 完成的 Promise，供一体化入口先起 web 再挂飞书）。
- `web/route-match.js` — 路由表匹配（`matchRouteFrom`）与启动自检（`findShadowedRoutes`）；纯逻辑，不碰 req/res、不引用任何 handler（这样测试无需真起服务就能钉住分发契约）。
- `web/origin.js` — CORS 来源裁决：把 `Access-Control-Allow-Origin` 从 `*` 收窄为白名单（`isAllowedOrigin` / `checkOrigin`）。
- `web/http-util.js` — 共享 HTTP 工具：`sendJson`。
- `web/body.js` — 请求体读取收口：`readJsonBody` / `withJsonBody`（替代散落在 routes-* 的裸 `req.on('data')`）。
- `web/input.js` — HTTP 边界输入卫生：`normalizeMode`（权限模式白名单 fail-closed）/ `str` / `safeDecodeId`。

### web 入口：run 执行编排（核心）
- `web/routes-run.js` — run 相关端点 handler：起跑 / 停止 / 决策 / 插话（持有缓冲）/ 切模式 / 待续跑 / SSE 附加；含记忆库用户输入埋点（`logUserText`，只认前端 `userTyped` 标记）。
- `web/run-claude.js` — **Claude run 编排核心**：`startClaudeRun`（装 SDK 回调 / canUseTool 审批 / onUserDialog）、`settleRun`（收尾 + 额度续跑 + 异常重试）、`doResume`、`recoverPendingAndOrphans`（孤儿恢复）。`settleRun` 与 `doResume` 互相调用，**必须同文件**。
- `web/run-claude.logic.js` — run 编排纯判定层（零 IO）：`isRetryEligible` / `runIdsToAbortOnDismiss` / `isResumePlanned`（本体全是 SDK 调用与落盘，无法直测，判定抽这里）。
- `web/run-openai.js` — openai-compat run 编排：`resolveCredential`（凭证按 credId>model>兜底 定位，防多厂商串台）+ MCP 工具接入 + 每工具审批；无 Claude session，历史走 conv-messages 重放。
- `web/tier.js` — auto 档位判定：`quickTier`（关键词快判）+ `classifyTier`（Haiku 极速分类），自动选 model/effort 省额度。
- `web/tool-summary.js` — 共享纯函数：`summarizeTool`（工具调用摘要）/ `READONLY_TOOLS`（只读工具自动放行集）/ `parseDialog`（onUserDialog payload 解析）。

### web 入口：需求工作流
- `web/routes-requirements.js` — 需求工作流 HTTP 单入口 `handleRequirementRoutes`，按 pathname+method 内部分发。
- `web/routes-req-v2.js` — 需求 v2 路由：问卷 / 需求地图 / 需求变动 / UI 规范（`handleReqV2Routes`）。
- `web/requirement-ops.js` — 需求工作流编排：docgen、**系统任务串行闸泵**（`startRequirementPump`）、busy 崩溃恢复与泄漏自愈（`healStaleBusy`）；直调 `startClaudeRun` 与 `integrations/claude` 的 `runClaude`。
- `web/req-logic.js` — 需求纯逻辑（零 IO）：prompt 构造 / 文档解析 / BUG 判决映射 / 档案拼装。
- `web/req-map.logic.js` — 需求地图纯逻辑：LLM 输出解析 / 地图规范化 / 修订 prompt。
- `web/req-quiz.logic.js` — 评审期问卷纯逻辑：prompt / 解析 / 答案回注。
- `web/req-uispec.logic.js` — UI 规范纯逻辑：还原 prompt / 规范草稿 prompt。
- `web/req-inspect.js` — 测试期 bitable 巡检（复用 \10001 基建：bitable API / 字段映射 / 评审门）。
- `web/req-pitfalls.js` — 避坑清单读写：`.claude/pitfalls.md` 与 `CLAUDE.md`。

### web 入口：体检 / 优化
- `web/routes-optimize.js` — 项目优化 HTTP 接口（单入口范式，对齐 routes-memory）。
- `web/optimize-ops.js` — 体检 / 优化编排：静态维度同步出结果、两个 LLM 维度后台**并行**跑经 SSE 回填；**不复用** `store/runs` 的 run 注册表，只借它的 `sendTo` 发 SSE。

### web 入口：会话飞书通知
- `web/routes-conv-notify.js` — 会话飞书通知路由（未命中回 `false`，交回 server.js 继续匹配）。
- `web/conv-notify.js` — 在 `store/runs` 注册**终结监听器**推私聊卡片；`injectToConv` 把飞书补充内容注入回原会话。
- `web/conv-notify.logic.js` — 会话通知纯函数：`shouldNotifySettle` / `summarize` / `buildConvSettledCard`。

### web 入口：其它路由 handler
- `web/routes-settings.js` — 设置 / 导入导出 / token 轮换 / openai-compat 凭证 / MCP server / 插件启停。
- `web/routes-files.js` — 上传 / 目录浏览 / 系统选目录 / 常用目录 / 脚本上传 / 静态托管；含 `validateScriptName`、路径防穿越。
- `web/routes-ops.js` — 日志 / 任务 / 历史 / 动作配置 / 脚本列举 / 启动初始化（`initializeDefaults`）/ ping / notify。
- `web/routes-memory.js` — 记忆库 HTTP 接口（单入口范式）。

### 纯逻辑层 & 测试
- `web/*.test.js`（`body` / `origin` / `input` / `route-match` / `run-claude.logic` / `run-openai.cred` / `tool-summary` / `req-*` / `routes-*` 等）— 与同名源文件配对的 `node --test` 单测。分发层（route-match）与各 `*.logic.js` 的契约靠这批测试钉住，因为编排本体全是 SDK/落盘/`server.listen`，无法直测。

## 二、关键流程

### A. web 聊天起跑（主路径）
浏览器 `POST /api/run/start` → `web/server.js` 用 `route-match.js` 命中 ROUTES 表 → `web/routes-run.js` `handleRunStart`：读 body（`body.js`）、归一 mode（`input.js`）、`model='auto'` 时经 `tier.js` `classifyTier` 判档 → `createRun`（`store/runs`）→ 按 provider 分流：
- **Claude**：`web/run-claude.js` `startClaudeRun` → `providers/claude-agent` SDK；回调经 `store/runs` 广播 SSE，`canUseTool` 审批走 `askUser`，工具文案走 `tool-summary.js`，`onUserDialog` 走 `parseDialog`。
- **openai-compat**：`web/run-openai.js` `startOpenAiRun` → `resolveCredential` 定凭证 → 连 MCP → `providers/openai-compat`。

前端另发 `GET /api/run`（`handleRunAttach`）建 SSE 接流；**关网页只退订、不中断 run**——run 是独立于连接的服务端状态。

### B. run 收尾与自愈闭环（run-claude 的重头）
SDK `done` → `settleRun` 三条出口：
1. **额度耗尽**（rateLimit rejected）→ `addPending` 登记待续跑；有健康备用号 → `doResume` 立即续跑，否则 `scheduleResume` 等 token 重置后续跑。
2. **异常结束** → `isRetryEligible`（`run-claude.logic.js`）判定够格 → `scheduleRetry` 2 秒后 `doResume`，代次 +1、达 `MAX_RESUME_ATTEMPTS` 熔断。
3. **正常/超限** → `finishRun`/`failRun` + 触发 `run.onSettle`（需求系统任务的串行闸收尾钩子唯一汇聚点）。

进程重启后，`server.js` 的 `listen` 回调调 `recoverPendingAndOrphans`：把上次没跑完的孤儿 run 转成待续跑并重排定时器（多实例共用数据目录时只回收「属主已死」的条目）。

### C. 飞书 / 控制台入站（走 dispatch，不进 web run 编排）
channel 收信 → `feishu/index.js`（群聊只处理 @ 机器人；图片/文件归一化为材料挂近期任务或入池；云文档链接拉取存材料）或 `console/index.js` → 组装统一 `ctx`（`source/user/text/sessionKey/reply/meta`）→ `app/dispatch`。飞书裸 dispatch 换成 `dispatchSafely`，避免抛错让用户「表情贴上又取下、再无下文」。

### D. 会话飞书通知闭环
`server.js` `listen` 调 `startConvNotify` 注册终结监听器（选在 `store/runs` 而非 `settleRun`：要覆盖全 provider、全终结路径）→ run 终结 → `conv-notify.js` `onRunSettled` 推私聊卡片（卡片失败降级纯文本，仅确实送达才记 `lastNotifiedAt`）。用户飞书回「补充内容」→ `injectToConv`：有活跃且支持持有的 run 走插话缓冲，否则 `resume` 原 session 新起一轮 `startClaudeRun`。

### E. 需求工作流
HTTP `/api/req/*` → `routes-requirements.js`（单入口分发）/ `routes-req-v2.js` → `requirement-ops.js` 编排：`startRequirementPump` 单泵按串行闸出队（busy 空且该 conv 无活跃 run）→ 直调 `startClaudeRun` 或 `runClaude`；prompt 构造 / 解析等纯逻辑在 `req-*.logic.js`。busy 落盘镜像供崩溃恢复，`healStaleBusy` 兜底续跑链泄漏。

### F. 项目体检 / 优化
HTTP `/api/optimize/*` → `routes-optimize.js` → `optimize-ops.js`：静态维度同步返回，`prompts`/`comments` 两个 LLM 维度后台并行跑、经 SSE（借 `store/runs` 的 `sendTo`）回填；带串行闸防同目录并发重复烧额度。

## 三、常见改动入口

- 要**加一个 HTTP 端点**，就改 `web/server.js` 的 ROUTES 表加一行 + 把 handler 放进对应 `web/routes-*.js`（注意顺序：精确路由必须排在能覆盖它的前缀之前，`findShadowedRoutes` 会在启动时喊出遮蔽）。
- 要**改 Claude 起跑 / 收尾 / 额度续跑 / 孤儿恢复 / 工具审批**，就改 `web/run-claude.js`；只是纯判定（是否重试/是否续跑）就改 `web/run-claude.logic.js`。
- 要**改 openai-compat 的凭证选择或工具审批**，就改 `web/run-openai.js`。
- 要**改 run 端点行为**（停止 / 插话 / 决策 / 切模式 / SSE 附加 / 用户埋点），就改 `web/routes-run.js`。
- 要**改 auto 判档策略**，就改 `web/tier.js`；要改工具摘要 / 只读工具集 / dialog 解析，就改 `web/tool-summary.js`。
- 要**改 CORS 白名单**就改 `web/origin.js`；改请求体读取就改 `web/body.js`；改输入归一 / 权限模式白名单就改 `web/input.js`。
- 要**改飞书入站特例**（群聊 @ 策略 / 图片文件材料池 / 云文档拉取 / 卡片回调），就改 `feishu/index.js`；改本地调试链就改 `console/index.js`。
- 要**改会话飞书通知或补充内容注入**，就改 `web/conv-notify.js`（卡片文案 / 判定等纯逻辑在 `web/conv-notify.logic.js`）；改其 HTTP 路由就改 `web/routes-conv-notify.js`。
- 要**改需求工作流编排**（docgen / 串行闸 / 崩溃恢复 / busy 自愈），就改 `web/requirement-ops.js`；改需求 HTTP 路由就改 `web/routes-requirements.js` 或 `web/routes-req-v2.js`；改 prompt / 解析等纯逻辑就改对应 `web/req-*.logic.js`；改测试期 bitable 巡检就改 `web/req-inspect.js`；改避坑清单读写就改 `web/req-pitfalls.js`。
- 要**改体检 / 优化编排**就改 `web/optimize-ops.js`，改其 HTTP 接口就改 `web/routes-optimize.js`。
- 要**改设置 / token / 凭证 / MCP / 插件启停**就改 `web/routes-settings.js`；改上传 / 目录浏览 / 静态托管就改 `web/routes-files.js`；改日志 / 任务 / 历史 / 动作 / 脚本 / 启动初始化就改 `web/routes-ops.js`；改记忆库 HTTP 就改 `web/routes-memory.js`。
- 要**改路由分发或启动自检逻辑**（而非某条具体路由），就改 `web/route-match.js`——它是唯一不依赖真实服务即可测试的分发层。

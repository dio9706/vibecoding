# openai run「(无输出)」事故与修复 · 设计/复盘

- 日期：2026-10-08
- 状态：已定位（证据链见 §2）；修复实施中，进度见 §6
- 关联：`src/providers/agent-loop.js`、`src/providers/openai-compat-model.js`、`src/entrypoints/web/run-openai.js`、`public/js/{chat,effort.logic}.js`
- 背景：用户在已安装的桌面版（sidecar 数据目录 `%APPDATA%\com.principal.desktop`）用 DeepSeek V4.1 Flash（`deepseek-flash`）对 `claude-p-web-demo` 发了一条「把强度改回滑块条 + Ultracode 流光」的需求，最终气泡显示 **「(无输出)」**。

## 1. 现象

- 三条 openai run 全部 `settled: done`，但 journal `result` 事件 `inputTokens:0/outputTokens:0`；
- 目标会话消息历史停在**一连串成功的工具调用/结果**（Read/Grep/Bash 共 8 步），**没有收尾文本**；
- UI 侧 `chat.js` 在「本段无新增文本」时补 `(无输出)` 占位 → 用户看到的文案。

## 2. 根因（证据链）

| # | 事实 | 来源 |
|---|---|---|
| 1 | `runAgentLoop` 默认 `maxSteps = 8`，`for (step < maxSteps)` 用尽后**静默 break**，随后以 `subtype:'success', result:''` 发出 onResult | 代码 + 会话历史恰好 8 组 assistant(tool-calls)+tool 结果 |
| 2 | run 3 耗时 45s、8 次模型调用（8 条 AI SDK 弃用告警一一对应），最后停在 tool 结果后**没有第 9 次调用**来收尾 | backend.log + conv-messages |
| 3 | 前端把旧 localStorage 里的 `chatEffort='xhigh'` 直接带进 DeepSeek 请求（`reasoning_effort: "xhigh"`，DeepSeek 只认 none/low/high/max）：切到自定义模型时**没有做档位归一** | journal `effort:"xhigh"` + settings 里凭证有 efforts 元数据 |
| 4 | `providerOptions key 'openai-compat'` 已是弃用键（官方新键 `openaiCompat`），每次模型调用刷一条 DeprecationWarning | backend.log |
| 5 | 用量恒 0：adapter 的 `finished` 没带 `usage`，agent-loop 也不透传，journal 永远 0 token | 代码 |

**结论：「(无输出)」不是需求没执行，而是工具循环在第 8 步被预算截断，且截断是静默的。** 附带两个真 bug（xhigh 泄漏、弃用键）与一个观测缺口（usage/步数无痕迹）。

## 3. 修复

1. **步数预算**：**默认无上限**（对齐 Claude Code / OpenCode；`maxSteps` 缺省/0/非法 = ∞），基础设置可配正整数（「工具循环上限（自定义模型）」，0=无上限）。设了有限上限且用尽时走 **OpenCode 式强制收尾**：注入「工具已禁用、只能文字总结」再要一轮（该轮不执行任何工具），不再静默成功；返回 `steps/inputTokens/outputTokens/wrappedUp`。设计详见 `2026-10-08-unlimited-steps-and-forced-wrapup.md`。
2. **档位归一**：`ensureEffortValid()` 在 `syncModelUI` 入口执行——自定义模型值必须 ∈（none + efforts），否则回落 default/第一档；Claude 非白名单回落 medium；自定义模型强制 `chatUltracode=false`（其无 Workflow 工具）。
3. **弃用键**：`providerOptions: { openaiCompat: { reasoningEffort } }`（SDK 新键，静音告警）。
4. **观测**（本次事故留痕，后续排障）：
   - agent-loop 每步落 `logger.info('agent-loop','模型步完成',{step,finishReason,textLen,toolCalls,tokens})`；步数用尽落 warn；
   - adapter 的 `finished` 透出 `usage`，stream error part 落 warn（HTTP 细节在 err.message）；
   - run-openai：完成落 runId/steps/tokens，失败落 err；journal `result` 从此带真实 tokens。
5. **UI 迭代（用户新需求）**：强度下拉 → **滑块**（档位即该模型 options：自定义 none→…→max；Claude low→…→max→Ultracode）；Ultracode 档选中时轨道**横向流光**（meteors 风格的横向拖尾，CSS 动画）。

## 4. 非目标

- MCP `cmd.exe` 连接超时（10s）是内置 **figma-framelink**（`cmd.exe /d /s /c npx figma-developer-mcp`）握手超时（日志时间点与用户随后禁用 Figma 内置项吻合），每次启用它的 run 白等 10s；不在本次改动（属该 server 本身在本机的可用性问题）。
- DeepSeek 端点自身行为（thinking 模式产出）不做客户端兜底重试。

## 5. 测试策略

- `agent-loop.test.js`：新用例——步数用尽时 `exhausted:true` 且 onResult 仍为 success、usage 累计进返回；既有 maxSteps 用例不回归；
- `openai-compat.test.js`：providerOptions 键改为 `openaiCompat` 后断言更新；`finished` 带 usage；
- `run-openai.resume.test.js`：不回归（effort/maxSteps 透传已有断言面）；
- 前端：`effort.logic` 用例不变；滑块逻辑走现有用例 + e2e 冒烟；
- 全量 `npm test` + `npm run test:e2e`。

## 6. 实施状态

- [x] 定位（证据链 §2）
- [x] 步数预算 50 + exhausted 提示 + usage/日志透传（agent-loop/adapter/run-openai）
- [x] 弃用键修复（`providerOptions.openaiCompat`）+ adapter usage
- [x] 前端档位归一（`ensureEffortValid`，切模型即校）+ 滑块 + Ultracode 横向流光
- [x] 测试与文档（`npm test` 3726 全绿；`npm run test:e2e` 12/12）

### 后续留痕（下一个会话排障入口）

- 应用日志：`%APPDATA%\com.principal.desktop\logs\app-YYYY-MM-DD.log`（sidecar 同写 `backend.log`）
  - `[agent-loop] 模型步完成 {step, finishReason, textLen, toolCalls, tokens}`——空回合/截断一眼可辨；
  - `[web] openai run 完成/未产出文本/工具步数耗尽/失败`——run 级结论与 err；
  - `[openai-compat] 模型流错误`——HTTP 细节在消息体；
- journal `result` 事件 tokens 从此有真实值（此前恒 0 是因为 adapter 没把 usage 传上来）。

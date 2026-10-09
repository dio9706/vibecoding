# 工具循环无上限 + 强制收尾（OpenCode 式）· 设计

- 日期：2026-10-08
- 状态：已拍板（2026-10-08，用户决策见 §1）；实现中，进度见 §6
- 关联：`src/providers/agent-loop.js`、`src/providers/openai-compat-model.js`、`src/entrypoints/web/{run-openai,run-openai.logic}.js`、`src/store/settings.js`、`src/entrypoints/web/routes-settings.js`、`public/{index.html,js/settings-panel.js}`
- 背景：2026-10-08「(无输出)」事故修复把 openai 路径步数预算定为 50。对照业界：**OpenCode 默认无上限**（`steps` 可选；不设则迭代到模型自停或用户打断），**Claude Code CLI 默认无上限**（`--max-turns` 仅 print 模式可选，官方原文 "No limit by default"）。用户拍板本项目同样默认无上限，并抄 OpenCode 的**强制收尾**（达到上限时注入「工具已禁用，只能文字总结」而不是静默截断）。

## 1. 拍板记录（2026-10-08 已确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 默认预算 | **无上限**（对齐 Claude Code / OpenCode；`maxSteps` 缺省/0/非法 = ∞） |
| 2 | 上限可配 | 基础设置加「工具循环上限（自定义模型）」，`0 = 无上限`（默认）；想控成本可设正整数 |
| 3 | 强制收尾 | 设了有限上限且用尽时：注入收尾指令（工具已禁用、只能文字：说明达到上限/汇总已完成/未完成/建议下一步）再要一轮总结；**该轮不执行任何工具**；收尾调用失败则回退为警告提示（fail-open） |

## 2. 目标与非目标

**目标**

1. `runAgentLoop`：`maxSteps` 支持 ∞（默认）；有限预算用尽 → **强制收尾**（一个额外模型调用）→ 返回 `exhausted/wrappedUp`；
2. 收尾调用通过 `modelRun(messages, { disableTools: true })` **不向模型暴露工具**；收尾轮即便返回 tool-call 也一律忽略（绝不执行）；
3. 收尾轮的 `responseMessages` 照常落检查点（历史以一份总结收尾，不再停在半截 tool 结果）；其 usage 计入总用量；
4. 配置链路：`uiPrefs.openaiMaxSteps`（默认 0=∞）→ `/api/settings` ui-prefs → 基础设置输入框 → `run-openai` 解析后传给 provider。

**非目标**

- Claude 路径不变（本就无上限，SDK 自管）；
- 不做「上限临近告警」（OpenCode 也只在用尽时注入）；
- 收尾提示不进持久历史（本地注入，仅该次调用可见——历史里只落模型自己的总结）。

## 3. 设计

### 3.1 agent-loop

- `runAgentLoop({..., maxSteps = Infinity })`；`budget = 正整数 ? floor : Infinity`（0/NaN/null 视为 ∞）。
- 循环退出后：`exhausted = lastFinishReason === 'tool-calls' && steps >= budget`（∞ 时恒 false）。
- `exhausted` 时执行 `forceWrapUp()`：
  - 本地 `wrapConvo = [...convo, { role:'system', content: WRAP_UP_PROMPT }]`（adapter 会把 system 拆进 `instructions`，不污染持久历史）；
  - `modelRun(wrapConvo, { disableTools: true })`；抽干文本流（tool-call 一律忽略）、`await finished`；
  - 成功：`wrappedUp=true`，文本进 `lastText`，responseMessages 落 `onMessages`，usage 累计；失败：`wrappedUp=false` + warn（fail-open）。
- 返回 `{ result, messages, steps, exhausted, wrappedUp, inputTokens, outputTokens }`；`onResult` 同带 `exhausted/wrappedUp`。
- 耗尽日志：`工具步数上限已用尽，启动强制收尾`；收尾完成：`强制收尾完成 {finishReason, textLen}`。

### 3.2 adapter

`streamTextToModelRun` 的 modelRun 增加第二参 `opts`；`opts.disableTools` → `streamText` 不带 `tools`（历史里的 tool 消息保留为上下文）。

### 3.3 配置

- `DEFAULTS.uiPrefs.openaiMaxSteps = 0`；
- `routes-settings` ui-prefs 分支：`openaiMaxSteps` 非负数字（含数字字符串）→ `Math.floor` 写入；其他值忽略；
- 基础设置：number 输入（min 0, placeholder「0 = 无上限」），存/取各一行；
- `run-openai.logic.resolveMaxSteps(v)`：正整数 → 该值；0/空/非法 → `Infinity`。`runOpenAiSession` 读 `getUiPrefs().openaiMaxSteps` 解析后传 provider `maxSteps`。
- 完成提示（run-openai done 分支）：`exhausted && wrappedUp` → `⚠️ 已达工具步数上限（N 步），已让模型收尾总结`；`exhausted && !wrappedUp` → 「已达上限且收尾失败，任务可能未完成」；日志同步。

## 4. 边界

| 场景 | 行为 |
|---|---|
| 默认 ∞ | 循环只在模型不再要工具 / 用户中断时结束（与 Claude 路径一致） |
| 上限设 0/空 | 等同无上限（resolveMaxSteps 兜底） |
| 收尾轮 provider 报错（如不接受无 tools 的工具历史） | warn + 按警告路径结束（`wrappedUp:false`），run 不失败 |
| 收尾轮模型仍试图调工具 | 忽略，不执行（disableTools 双保险） |
| signal 中途 abort | 收尾前已 return aborted，不进入 wrap-up |

## 5. 测试策略

- `agent-loop.test.js`：① 有限上限耗尽 → 第 N+1 次调用带 `disableTools:true` 且末条为 system 收尾提示、返回 `wrappedUp:true`、结果 = 总结文本；② 无上限（不传 maxSteps）多步工具→文本自然收尾，`exhausted:false`；③ 既有 maxSteps 用例不回归（wrap-up 不执行工具，工具执行次数不变）；
- `openai-compat.test.js`：`disableTools` 下 `doStream` 收到的 tools 为 undefined（正常轮仍在）；
- `run-openai.logic.test.js`：`resolveMaxSteps` 边界（0/''/null/NaN→∞；5→5；2.9→2）；
- `settings.test.js`：uiPrefs 默认含 `openaiMaxSteps: 0`；
- 全量 `npm test` + `npm run test:e2e`。

## 6. 实施状态

- [x] 拍板（2026-10-08，见 §1）
- [x] agent-loop 无上限 + 强制收尾 + adapter disableTools
- [x] 配置链路（store/API/设置页）+ resolveMaxSteps
- [x] 测试与文档（`npm test` 3730 全绿；`npm run test:e2e` 12/12）

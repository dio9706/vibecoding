# 🔧 工具弹层按 provider 展示真实工具集 · 设计

- 日期：2026-10-08
- 状态：已拍板（2026-10-08，用户提出）；实现中，进度见 §5
- 关联：`public/js/{chat.js,tool-list.logic.js}`、`src/providers/builtin-tools.js`、`src/capabilities/feishu-ask-tools.js`、`src/capabilities/tool-policy.logic.js`
- 背景：工具弹层的「内置工具」一直写死 Claude Code 的工具清单。切到自定义模型（openai-compat）后，实际跑的是本仓自研工具集——会出现两种误导：**关了 WebSearch/Task/Workflow 什么都没发生**（openai 路径根本没有这些工具），**真正存在的 Glob/RepoMap/问同事却关不掉**（不在清单里）。

## 1. 拍板记录（2026-10-08）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 展示原则 | **按 provider 展示真实装配的工具集**（Claude 清单不动；openai 清单 = 本仓自研工具） |
| 2 | openai 清单范围 | builtin-tools 六件套（Read/Write/Edit/Glob/Grep/Bash）+ RepoMap + AskColleague/WaitColleagueReply |
| 3 | Skills 段 | 技能机制仅 Claude 路径装配；**openai 下整段隐藏**（含分隔线） |
| 4 | 开关语义 | `uiPrefs.disabledTools` 保持全局单数组，按**逻辑名**判：同名工具（Read 等）两边共享；跨 provider 独有 id 互不影响（Claude 经 run-claude 别名表归一；openai 由 `decideToolAction` 直接按名匹配） |

## 2. 工具集对照（实现即为准）

| | Claude 路径（SDK） | 自定义模型路径（本仓自研） |
|---|---|---|
| 文件 | Read / Write / Edit | Read / Write / Edit |
| 搜索 | Grep（含 Glob / LS） | **Glob 独立** + Grep |
| 命令 | Bash | Bash（可配容器后端，T6） |
| 网络 | WebSearch / WebFetch | 无（MCP 增强可补） |
| 编排 | Task / Workflow / TodoWrite | 无（Ultracode 对自定义模型置灰，与之一致） |
| 其它 | — | **RepoMap**（git+开关）、**AskColleague / WaitColleagueReply** |
| 技能 | Skills 包开关 | 不装配（隐藏） |
| MCP | 有（服务器级开关） | 有（同一段 UI） |

## 3. 设计

- 新纯数据模块 `public/js/tool-list.logic.js`：`CLAUDE_BUILTIN_TOOLS` / `OPENAI_BUILTIN_TOOLS` + `builtinToolsFor(provider)`（未知 provider 回落 Claude，与 chat.js 缺省分支一致）；配 `tool-list.logic.test.js`（互不串台、id 唯一、openai 不得含 Claude 专属项）。
- `chat.js`：删除写死的 `BUILTIN_TOOLS`，`refreshToolsSection` 改用 `builtinToolsFor(chatProvider)`（弹层每次打开时现算，切模型后自然刷新）；Skills 段在 openai 下清空并隐藏。
- 禁用闭环无需改动：`run-openai` 的 `disabledToolsSet` → `createPolicyGate` → `decideToolAction` 按工具名 deny（`tool-policy.logic.js` L224 已核）；RepoMap/Glob/问同事的开关从此真实生效。

## 4. 非目标

- 不改 Claude 清单内容（含 Grep 行合并 Glob/LS 的既有口径）；
- 不给 openai 增加跨路径的 per-tool 独立开关存储（沿用全局 disabledTools）；
- 不做 MCP 工具级的细分开关（仍按 server 开关）。

## 5. 实施状态

- [x] 拍板（2026-10-08，见 §1）
- [x] `tool-list.logic.js` + 单测
- [x] `chat.js` 接线（工具列表分叉 + Skills 隐藏；未知 provider 回落 Claude 清单）
- [x] 全量测试（`npm test` 3736 全绿；`npm run test:e2e` 12/12）

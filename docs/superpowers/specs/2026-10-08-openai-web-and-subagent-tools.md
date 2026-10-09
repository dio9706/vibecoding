# 自定义模型路径补工具：WebFetch / TodoWrite / WebSearch / Task（只读子代理）· 设计

- 日期：2026-10-08
- 状态：已拍板（2026-10-08，用户三问确认）；实现中，进度见 §7
- 关联：`capabilities/web-tools{,.logic}.js`（新）、`providers/builtin-tools.js`、`entrypoints/web/run-openai.js`、`store/settings.js`、`entrypoints/web/routes-settings.js`、`public/js/{tool-list.logic.js,settings-panel.js}`、`public/index.html`
- 背景：工具弹层按 provider 展示真实工具集后（A5），用户要求把 Claude 路径的 WebFetch / TodoWrite / WebSearch / Task 也补到自定义模型路径。策略表已预留类别：network（WebFetch/WebSearch）、read（TodoWrite）、agent（Task/Agent），无需改规则引擎。

## 1. 拍板记录（2026-10-08）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 范围 | **WebFetch / TodoWrite / WebSearch / Task（只读子代理）** 四项；Workflow 暂缓 |
| 2 | WebSearch 后端 | **内置搜索 API**（key 填设置页）：先支持 **Tavily / Brave / 博查** 三家适配（任配其一） |
| 3 | Task 权限 | **只读版**：子代理只能用 Read/Glob/Grep/WebFetch/WebSearch/RepoMap；写/执行类一律剥掉；后续需要再放开 |

## 2. WebFetch（本地实现）

- 工具：`WebFetch({ url, max_chars? })`；仅 http/https；GET，15s 超时，流式读取上限 1MB。
- HTML→文本：去 `<script>/<style>`、剥标签、解基本实体、压缩空白；输出上限 30000 字符（`max_chars` 可调，封顶 100000）。
- 返回：`URL / Status / 正文`（截断时标注）。
- 审批：名字命中策略表 `NET_TOOLS` → 网络类（default 档需确认，bypass/无人值守放行）。

## 3. TodoWrite（清单）

- 工具：`TodoWrite({ todos: [{ content, status, activeForm? }] })`，status ∈ pending|in_progress|completed；executor 归一校验后返回确认文案。
- 展示：run-openai 的 `onActivity` 里对 `TodoWrite` 走 `runTodos(run, input.todos)`（与 run-claude 同款）→ SSE `todos` 事件 → 前端任务清单面板（管线已存在）。清单行不进活动转录。

## 4. WebSearch（内置 API）

- 设置：`settings.search = { provider: 'tavily'|'brave'|'bocha'|'', apiKey: '' }`（新增 section：store 默认/归一 + `/api/settings` GET 输出 + `section:'search'` 保存）。
- 工具：`WebSearch({ query, count? })`（count 默认 5、封顶 10）；未配 key 时返回指引文案（模型可转述），不发请求。
- 适配器（纯函数生成请求 + 解析响应，运行时可注入 fetchImpl）：
  | provider | 请求 | 响应取法 |
  |---|---|---|
  | tavily | `POST https://api.tavily.com/search`，Bearer，`{query,max_results}` | `results[].{title,url,content}` |
  | brave | `GET https://api.search.brave.com/res/v1/web/search?q=&count=`，`X-Subscription-Token` | `web.results[].{title,url,description}` |
  | bocha | `POST https://api.bochaai.com/v1/web-search`，Bearer，`{query,count,summary:false}` | `data.webPages.value[].{name,url,snippet}` |
- 输出：编号列表（标题 — URL + 摘要截断）；错误人话化（401→检查 key、超时、格式不符）。
- 审批：`WebSearch` → 网络类。

## 5. Task（只读子代理）

- 工具：`Task({ description, prompt })`。
- 执行（run-openai 局部装配，同 feishuAsk 范式）：嵌套 `providers.get('openai-compat').run` + `runAgentLoop`：
  - 模型/凭证/强度与主 run 同源；`maxSteps` 同主（∞ 或配置值）；
  - **只读工具子集**：`Read/Glob/Grep/WebFetch/WebSearch/RepoMap`（从已装配 defs 中按名过滤；不含 Task → 天然禁递归）；
  - 子 system prompt：只读探查子代理说明 + cwd；
  - 子 `canUseTool` = 主 run 同一个策略门（实时档位；网络类照常弹主 run 审批卡）；
  - abort 传播（主 signal）；子活动转发为 `🔍 子代理：…`，子结果文本（截断 8000）作为工具结果返回。
- 审批：`Task` → agent 类放行（plan 档拒绝）。

## 6. 前端与测试

- `tool-list.logic.js`：OPENAI 清单 +4 项（Task 标注「只读子代理」、WebSearch 标注「需设置页配置 key」）；测试改为只排除 Workflow。
- 设置页（基础 tab）：新增「联网搜索（自定义模型）」小节：provider 下拉（不启用/Tavily/Brave/博查）+ key 输入 + 保存。
- 测试：
  - `web-tools.logic.test.js`：URL 校验、HTML→文本（script/style/实体/截断）、三家请求构造与响应解析（含坏形状）、未配 key 文案；
  - `web-tools.test.js`（注入 fetchImpl）：WebFetch 成功/超时/超限/非 2xx；WebSearch 成功/上游错误；
  - `builtin-tools.test.js`：TodoWrite 归一与非法输入；
  - `run-openai.resume.test.js`：TodoWrite → `run.todos`；Task → 嵌套子代理（父脚本 3 步：Task 调用 → 子回复 → 父收尾）；
  - `settings.test.js`：search 默认/归一；
  - 全量 `npm test` + `npm run test:e2e`。

## 7. 实施状态

- [x] 拍板（2026-10-08，见 §1）
- [x] `web-tools` 模块对（logic + 运行时）+ 测试
- [x] TodoWrite（builtin-tools + run-openai 接线 + 归一函数）
- [x] settings.search 全链 + 设置页 UI
- [x] Task 只读子代理（subagent.logic + run-openai 嵌套装配）+ 测试
- [x] 前端工具清单 + 文档 + 全量验证（`npm test` 3758 全绿；e2e 见交接单）

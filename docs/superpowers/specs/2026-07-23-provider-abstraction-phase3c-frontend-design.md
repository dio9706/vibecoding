# Provider 抽象 · Phase 3c（前端：自定义模型设置 + provider 选择器）— 设计文档

- 日期：2026-07-23
- 范围：前端（`public/index.html` + `app.js` + `app.css`）——设置页新增"自定义模型"tab（凭证 CRUD UI，对接片 B 的 `/api/credentials`）+ model-fab 增加自定义模型选择（选中后 run-start 带 `provider:'openai-compat'`）。
- 依赖：片 B（`/api/credentials` CRUD）✅、片 C（`handleRunStart` 认 `provider` 字段 + `startOpenAiRun`）✅。后端已就绪，本期纯前端接线。

## 0. 现状锚点（已核实）
- 设置页 tab 栏：`index.html` 的 `<button data-tab="...">` + 每个 `.set-tab[data-tab=...]`（basic/lark/messages/tokens/actions/desktop）。tokens tab 是"列表 `#tokenList` + 添加表单"范式（218-229）。
- model-fab：`#modelFab` → `#modelPop`（`#modelPills` 4 个 Claude 模型 + `#effortRow` + `#modePills`）+ `#modelFabBtn`/`#modelFabLabel`（`index.html` 295-319；逻辑 `app.js` ~2105-2156）。
- run-start 请求体：`app.js:1457` 送 `{ prompt, cwd, session, model: chatModel, effort: chatEffort, mode: chatMode, convId }`——**缺 `provider`**。
- 状态变量：`chatModel`/`chatEffort`/`chatMode`（模块级），`MODEL_LABELS`（模型 id→标签），会话切换经 `prefs.model` 还原、`persistPrefsToConv` 落库。

## 1. 目标与非目标
**目标**
- 设置页"自定义模型"tab：列出/新增/删除 openai-compat 凭证（label/baseURL/apiKey/model），对接 `/api/credentials`。
- model-fab 增"自定义模型"区：把已配置的凭证作为可选项；选中 → `chatProvider='openai-compat'` + `chatModel=<cred.model>`；选 Claude 模型 → `chatProvider='claude-agent'`。
- run-start 请求体加 `provider: chatProvider`（默认 `claude-agent`，不选自定义即现状不变）。
- `chatProvider` 随会话持久化（同 `chatModel`：`prefs`/`persistPrefsToConv`）。

**非目标**
- 不改后端（片 B/C 已就绪）。
- 不做工具/agentic UI（openai v1 纯对话，`capabilities.tools=false`）。
- 不做"会话中途换 provider"（一会话一 provider，v1 后端约束）；切换自定义↔Claude 建议新会话（前端可提示）。
- 不动飞书/Claude 账号既有 tab。

## 2. 设计

### 模块 1：设置页"自定义模型"tab（CRUD UI）
- `index.html`：tab 栏加 `<button data-tab="providers">自定义模型</button>`（放 Claude 账号之后）；加 `.set-tab[data-tab=providers]` 面板，含凭证列表 `#credList` + 添加表单（label / baseURL / model / apiKey 四输入 + `#credAddBtn`）。样式复用 `.set-sec`/`.token-list`/`.token-add`。
- `app.js`：
  - `loadCredentials()` → `GET /api/credentials` → 渲染 `#credList`（每行 label + model + baseURL + 掩码 apiKey + 删除按钮）。
  - `#credAddBtn` → `POST /api/credentials {label,apiKey,baseURL,model}`（校验三必填）→ 重载列表 + 刷新 model-fab 自定义区。
  - 每行删除 → `DELETE /api/credentials/:id` → 重载。
  - tab 切到 providers 时懒加载。

### 模块 2：model-fab 自定义模型选择
- `index.html`：`#modelPop` 内在 Claude `#modelPills` 之后加一个 `#customModelPills`（动态填充）+ 分隔线；标题"自定义模型"。空时隐藏或显示"去设置添加"。
- `app.js`：
  - 新增模块级 `chatProvider = 'claude-agent'`。
  - 打开 model-pop 时（或 fab 初始化 + 凭证变更后）用 `GET /api/credentials` 填充 `#customModelPills`：每个凭证一枚 `<button data-provider="openai-compat" data-m="<cred.model>" data-cred="<id>">{label}</button>`。
  - 点 Claude 模型 pill → `chatProvider='claude-agent'`，`chatModel=data-m`（现逻辑）。
  - 点自定义 pill → `chatProvider='openai-compat'`，`chatModel=data-m`；`#modelFabLabel` 显示凭证 label（Claude 走 `MODEL_LABELS`，自定义走凭证 label——`shortModel`/label 逻辑加分支）。
  - effort/mode 对自定义模型无意义 → 选自定义时灰置/隐藏 effort+mode 行（openai v1 不用）。
- run-start（`app.js:1457`）请求体加一行 `provider: chatProvider,`。
- 持久化：`chatProvider` 随会话存取（扩展 `prefs`/`persistPrefsToConv`/切换还原逻辑，与 `chatModel` 同步——避免会话 A 的自定义模型泄漏到会话 B）。

### 模块 3：一会话一 provider 的前端约束（轻量）
- 后端 v1 一会话绑定一 provider（历史分处 conv-messages vs Claude JSONL）。前端：若当前会话已有消息且用户切换 provider 类别（Claude↔自定义），弹一次轻提示"切换模型来源建议新建会话"（不强制）。v1 可先只做持久化，不做强校验（记为可选）。

## 3. 影响面
- `public/index.html`：+1 tab 按钮 + providers 面板 + `#customModelPills`。
- `public/app.js`：credentials CRUD UI 逻辑；`chatProvider` 状态 + model-fab 自定义 pill 填充/选择；run-start 加 `provider`；prefs 持久化扩展。
- `public/app.css`：复用现有 `.set-sec`/`.token-*`/`.model-pills` 样式，必要时微调。
- **不改**后端。

## 4. 切片
- **3c-1**：自定义模型设置 tab（CRUD UI）——自包含，Playwright/手测。
- **3c-2**：model-fab 自定义选择 + run-start `provider` + 持久化——接运行路径。

## 5. 验证要点
- 无构建、静态托管 → 主要靠手测 + Playwright（仓库已有 `tests/e2e-*.mjs` 用 stub fetch/EventSource 的先例）。
- 3c-1：加/删凭证 UI 往返（mock `/api/credentials`）；apiKey 不明文显示（仅掩码）。
- 3c-2：选 Claude 模型 → run-start 不带 provider 或 `claude-agent`（现状回归）；选自定义 → 带 `provider:'openai-compat'`+对应 model；会话切换 `chatProvider` 正确还原不串会话。
- 回归：不碰自定义功能时，现有模型/强度/模式选择与 Claude run 一字不变。

## 6. 风险与开放问题
- **model-fab 融合复杂度**：`#modelFabLabel`/`shortModel`/`MODEL_LABELS` 是 Claude-中心，加自定义分支需小心不破坏现有显示；effort/mode 对自定义无意义的灰置要不破坏 Claude 交互。
- **app.js 巨大（4062 行）**：改动集中在 model-fab 逻辑 + run-start + 一段新 CRUD，需精确锚点；建议 subagent 精确匹配。
- **持久化串会话**：`chatProvider` 必须与 `chatModel` 同一套 prefs 存取，否则重演记忆里"模型偏好泄漏到他会话"的坑。
- **apiKey 安全**：前端只显示掩码（片 B 的 list 已只回掩码）；添加表单的 apiKey input 用 `type=password`/`autocomplete=off`。

## 7. 后续
- 接 MCP 工具后：自定义模型 pop 里显示"支持工具"标识、effort/mode 视 provider 能力动态显隐。
- 前端"会话目录编辑器"大改版（子项目 3）是更大范围的重构，本期只做自定义模型接入，不牵动整体布局。

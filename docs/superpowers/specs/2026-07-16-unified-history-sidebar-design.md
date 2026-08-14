# 统一历史列表设计（本地会话 + 磁盘会话合并到左侧栏）

**日期**：2026-07-16
**状态**：已通过 brainstorming 评审，待写实现计划

## 背景与目标

web 执行台当前有**两处**功能重叠的历史入口：

1. **左侧栏**（`#convList` / `renderConvList`）：localStorage `claude_convs` 中的本地会话，点击 `openConv` 秒开（用缓存 messages），带 active/running 状态与删除。
2. **右上抽屉**（`#historyPanel` / `renderHistoryList`，📜 触发）：磁盘 `~/.claude/projects/<project>/*.jsonl` 会话，点击「续接」走 `resumeHistorySession`。

两者高度重叠：每条跑过的本地会话都有 `session`(sessionId) 对应一个磁盘文件；磁盘是全集（含 CLI 会话、localStorage 被清的会话）。

**目标**：合并为**唯一**历史列表，并入左侧栏；同一会话按 sessionId 去重；每条带来源标记区分「本地」与「web」。移除右上 📜 按钮与右侧抽屉。

## 数据模型（合并 + 去重）

合并键 = `sessionId`。构建统一列表 `mergedList`：

| 情形 | 结果条目 | 标记 |
|------|---------|------|
| 本地会话有 `session`，磁盘也有该 session | 合并为一条，用较新的 `updatedAt` | `local` |
| 本地会话无 `session`（新建未跑过的草稿） | 一条 | `local` |
| 磁盘会话有、无对应本地会话 | 一条 | `web` |

- 每条统一结构（渲染用）：`{ key, source: 'local'|'web', convId?, sessionId?, title, updatedAt, running }`
  - `local` 条目携带 `convId`（localStorage id），`web` 条目携带 `sessionId`。
- 排序：`updatedAt` 倒序（同现状）。

## 渲染

- 复用现有 `.conv-item` 结构（含 `active`/`running` 状态类、点击、删除按钮），在标题旁加来源徽标：
  - `local` → `●本地`（`--accent` 色）
  - `web` → `○web`（`--faint`/`--muted` 色）
- **两阶段渲染**（避免白屏 / 避免磁盘请求阻塞首屏）：
  1. 页面加载先用本地会话同步渲染（秒出）。
  2. 磁盘列表异步拉回后合并、重渲染。
  3. 磁盘拉取失败：只显示本地会话 + 一条不打扰的小提示，不阻塞。
- XSS：标题等一律 `textContent`（沿用现有约定）。

## 点击行为

- `local` 条目 → `openConv(convId)`（现状，秒开，用缓存 messages）。
- `web` 条目 → `resumeHistorySession(sessionId)`（现状：拉详情 → 落库 → 去重 → 此后该会话变为 `local`）。

## 搜索

- 左侧栏顶部新增搜索框（如 `#convSearch`）。
- **客户端过滤**已合并的内存列表（按 `title` / `sessionId` 包含匹配），不额外调用 API（磁盘列表已在内存缓存）。
- 空查询 → 显示全部。

## 删除（✕）

- **仅 `local` 条目显示 ✕**：删除 localStorage 中的该会话（沿用现有 `conv-rm` 逻辑与二次确认 `confirmDialog`）。删除后若磁盘仍有该 session，会重新以 `web` 条目出现（符合预期）。
- **`web` 条目不提供删除**：磁盘 `.jsonl` 与 Claude Code CLI 共享，删除属破坏性且越权操作（YAGNI + 安全）。本设计明确不做磁盘文件删除。

## 刷新策略

- 磁盘列表用 5s 内存缓存（复用现有 `historyCache` / `historyCacheExpire` 思路）。
- `renderConvList` 合并「本地 loadConvs() + 缓存磁盘列表」后渲染。
- 磁盘缓存刷新时机：页面加载、一次 run 结束（可能产生新 session）、`resumeHistorySession` 后失效缓存。
- 频繁调用 `renderConvList`（如 `recordMessage` 后）只用现有缓存，不重复打 API。

## 移除 / 改造 / 保留

**移除**：
- `public/index.html`：`#historyToggle`「📜 历史」按钮、`#historyPanel` 抽屉结构。
- `public/app.css`：**删除全部** `.history-*` 右抽屉专用样式（`.history-panel`/`.history-head`/`.history-search`/`.history-list`/`.history-item`/`.history-title`/`.history-meta`/`.history-resume`/`.history-empty`/`.history-loading`/`.history-error`）。因为左栏复用的是 `.conv-item` 结构而非 `.history-item`，这些类不再被引用。
- **保留** `.toast`（通用轻提示，`resumeHistorySession` 仍用）。

**新增（左栏作用域样式）**：
- `public/app.css`：来源徽标 `.conv-badge`（含 `.conv-badge.local` / `.conv-badge.web` 两种配色）、搜索框 `.conv-search`、以及左栏加载/错误/空态所需样式（新增 `.conv-loading` / `.conv-error`，`.conv-empty` 已存在可复用）。

**改造**：
- 右抽屉专用逻辑 `openHistoryPanel` / `closeHistoryPanel` / `toggleHistoryPanel` / `setupHistorySearch` / `renderHistoryList` / `renderHistoryLoading` → 移除，其职责合并进左栏的新渲染 + 搜索逻辑。
- `renderConvList` 升级为「合并本地 + 磁盘、按 sessionId 去重、带来源徽标、支持搜索过滤、两阶段渲染」。
- 新增左栏搜索处理（客户端过滤内存合并列表；in-memory 过滤即时生效，无需防抖）。

**保留复用**：
- `loadHistorySessions`（磁盘数据源，含 5s 缓存）。
- `resumeHistorySession`（web 条目点击，含去重落库）。
- 后端 `src/store/history.js` 与 `/api/history` 路由**完全不变**。

## 影响范围

- 仅前端：`public/app.js`、`public/index.html`、`public/app.css`。
- 后端零改动。

## 非目标（YAGNI）

- 不做磁盘会话删除。
- 不做分页 UI（列表可滚动；搜索用于收窄）。
- 不改后端 API 契约。

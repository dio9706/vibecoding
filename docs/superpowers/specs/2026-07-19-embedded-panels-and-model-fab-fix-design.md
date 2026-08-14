# 设计：嵌入式面板（设置/需求故障/访问日志）+ 模型/模式即时生效

日期：2026-07-19
状态：已获用户批准

## 背景

- 设置、需求/故障、访问日志目前是三个 mask 弹层（`public/index.html` 中 `settingsMask` / `taskMask` / `logMask`），观感割裂，且设置项持续增多，单列滚动不可持续。
- 右下角悬浮控件（`modelFab`）的模型/强度/问询模式改动"似乎不即时生效"。排查结论：
  1. 每条新消息确实会带上当前值（`send()` → `/api/run/start`），该路径无 bug；
  2. **运行中的任务改不了**——模式/模型在 run 启动时闭包定值（`startClaudeRun`），中途切换只影响下一条消息；
  3. **切会话被静默还原**——`openConv()` → `applySessionPrefs(c)` 会把右下角改回该会话上次记录的值，用户刚做的选择看起来"丢了"（2026-07-18 上线的会话级还原特性的副作用）。
- 用户确认：两种潜在原因都要处理（"不确定/都有可能"）。

## 决策记录

- 信息架构：**三个独立嵌入视图**（用户选定），设置视图内部带 tab；不做统一控制台、不做单层铺平。
- 嵌入实现：**视图切换层**方案（用户选定），不做 CSS 伪嵌入。
- 即时生效：**双管齐下**方案（用户选定）——写穿 + 还原可见化 + 运行中 set-mode；不做 SDK streaming 常驻进程改造（YAGNI）。

## 一、视图切换层（架构）

### DOM（`public/index.html`）

- 删除 `settingsMask`、`taskMask`、`logMask` 三个弹层。
- 在 `main.messages` 之后、composer 之前新增：

```html
<section class="panel-view" id="panelView" hidden>
  <div class="panel-page" data-view="settings">…</div>
  <div class="panel-page" data-view="tasks">…</div>
  <div class="panel-page" data-view="logs">…</div>
</section>
```

- 每个 `panel-page` = 头部（标题 + ✕ 返回按钮）+ 原弹层 body **原样迁入**。
  现有元素 ID 全部保留（`feishuState`、`larkAppId`、`larkAppSecret`、`msgList`、
  `tokenList`、`tokenLabel`、`tokenValue`、`taskBody`、`logBody` 等），
  使 `loadSettings` / 任务渲染 / `openLogModal` 的日志渲染逻辑零改动复用。
- 目录选择弹层（`dirMask`）**不在本次范围**，保持弹层形态（瞬时小交互，非页面）。

### 视图状态（`public/app.js`）

- 单一状态 `let activeView = 'chat'`（`'chat' | 'settings' | 'tasks' | 'logs'`）。
- `showView(name)`：
  - `chat`：显示 `#messages`、`#fabRow`、`#lottieFab`，隐藏 `#panelView`；
  - 其它：隐藏 `#messages`、`#fabRow`、`#lottieFab`，显示 `#panelView` 中对应
    `panel-page`（其余 page 隐藏），并调用既有数据加载函数（设置→`loadSettings`，
    任务→现有任务加载/标记已读，日志→现有日志拉取）。
- 导航规则：
  - 顶栏按钮：点击打开对应视图；再点同一按钮、点 ✕、按 Esc → 返回 `chat`；
  - 点侧栏任一会话 / 新对话 → 自动返回 `chat`；
  - composer 在面板视图下保持可用，**发送消息自动切回 `chat`** 看流式输出。
- 红点徽标（`taskBadge`/`settingsBadge`）、5s 任务轮询、桌面通知逻辑全部不动。

## 二、扁平化样式 + 设置 tab（`public/app.css` + 少量 JS）

- `panel-view` 与消息区同底色（`--bg`），无遮罩、无卡片阴影；内容列
  `max-width: 720px` 居中；节间用细分割线（沿用现有 `--line` 系变量）；
  整体贴近现代设置页而非弹窗。
- 设置视图顶部为**下划线式 tab**：`飞书凭证 | 机器人文案 | Claude 账号`。
  三个现有 `set-sec` 各归一个 tab 面板；tab 切换纯前端显隐，不重复拉数据。
- `settingsBadge` 红点逻辑同步到「Claude 账号」tab 标签（顶栏 ⚙ 红点保留）。
- 需求/故障、访问日志视图沿用现有行/卡片渲染（`task-*`、`log-row`），
  只调容器留白与宽度，不重写列表（YAGNI）。

## 三、模型/问询模式即时生效

### 前端（`public/app.js`）

1. **写穿**：FAB 改模型/强度/模式时，若有 `currentConvId`，立即把新值写入该会话
   记录（`saveConvs`），不再等下一条消息的 `recordMessage` 快照。
   根治"切走再切回被还原"。
2. **还原可见化**：`applySessionPrefs` 实际改变了值时
   toast「已还原此会话偏好：<模型标签> · <模式标签>」。
3. **运行中切模式**：当前会话存在运行中 job（有 `runId`）时，改模式 →
   `POST /api/run/set-mode {runId, mode}`：
   - 响应 `applied: true` → toast「当前任务已切换为 <模式标签>」；
   - `applied: false` → toast「当前任务无法中途切换，将从下一条消息生效」。
4. 改模型/强度且有运行中任务 → toast「模型将从下一条消息生效」（不调接口）。

### 后端（`src/entrypoints/web/server.js` + `src/store/runs.js`）

- run 对象新增运行时可变字段 `mode`（`startClaudeRun` 初始化为 `effectiveMode`）。
- `canUseTool` 改为**决策时**读 `run.mode`（原为启动时闭包定值）：
  - `default` → 只读工具放行，其余走询问弹窗；
  - `acceptEdits` / `bypassPermissions` → 放行。
- 新增 `POST /api/run/set-mode`，即时生效（`applied: true`）需同时满足：
  1. run 存在且未结束；
  2. run 以 `default`（询问）起跑——此时 PreToolUse hook 已强制所有工具过
     `canUseTool`，切换才真正可拦截；
  3. 目标 mode ∈ {`acceptEdits`, `bypassPermissions`}。
- 生效时**自动放行**当前挂起（`run.pending`）及排队（`run.pendingQueue`）中
  `kind === 'permission'` 的询问（resolve 为 `allow`）；`dialog` 类不动。
- 其余情况（非询问起跑、切向 `default`/`plan`、run 已结束）返回
  `applied: false`——架构上工具已不经过回调、无法拦截，诚实告知靠下一条消息生效。
- 访问日志 `LOG_PATH_LABELS` 增加 `/api/run/set-mode: '切换权限模式'`。

## 测试

- runs store 层加 node 单测（仿 `src/store/history.test.js`）：
  - set-mode 判定矩阵（起跑模式 × 目标模式 × run 状态 → applied 与否）；
  - 挂起/排队 permission 询问在切换后被 resolve 为 allow，dialog 不受影响。
- 视图切换、tab、扁平样式、toast 文案：手工验证。

## 不做的事（YAGNI）

- 不改造为 SDK streaming 常驻会话进程（`setPermissionMode`/`setModel` 全量即时）。
- 运行中不支持切换模型/强度（下一条消息生效 + toast 说明）。
- 目录选择弹层不嵌入。
- 需求/故障、访问日志的列表渲染不重写。

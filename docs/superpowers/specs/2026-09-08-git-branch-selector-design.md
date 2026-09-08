# Git 分支选择器设计文档

**日期**: 2026-09-08  
**状态**: 设计批准  
**功能**: 在顶栏项目文件夹选择器旁添加分支选择器，支持查看、切换、刷新项目分支

## 一、需求背景

用户在使用 Principal 时需要能快速查看和切换当前项目的 git 分支，减少来回切换到终端的频繁度。当前顶栏仅有工作目录选择器，缺少分支信息和快速切换能力。

## 二、核心功能

### 2.1 基本交互
- **初始化**：启动应用或切换目录时，自动检查是否为 git 仓库；是则显示分支选择器，否则隐藏
- **展示当前分支**：按钮上显示当前分支名（如 `main`、`dev`）
- **打开下拉菜单**：点击分支选择器按钮展开列表，展示本地和远程分支
- **切换分支**：点击列表中的分支名执行 `git checkout <branch>`，成功后关闭菜单、更新按钮标签
- **刷新分支列表**：下拉菜单底部「刷新」按钮，执行 `git fetch` 后重新列表
- **错误提示**：操作失败时 toast 显示错误信息，仅提示不做额外处理

### 2.2 分支列表组织
- **排序**：本地分支优先，各自按字母序；远程分支跟在本地分支后
- **标记**：当前所在分支用高亮背景 + ✓ 对勾符号标记
- **命名**：本地分支显示原名（如 `main`），远程分支加 `origin/` 前缀（如 `origin/main`）

## 三、架构设计

### 3.1 前端模块（`public/js/git-selector.js`）

独立模块，职责：
- 初始化：导出 `bindGitSelector({ getCwd })`，app.js 启动时调用注入当前工作目录读取器
- 状态管理：`currentBranch`（当前分支）、`isLoading`（加载状态）、`branches`（分支列表）
- UI 控制：
  - 按钮显示/隐藏（非 git 仓库时隐藏）
  - 下拉菜单打开/关闭
  - 分支列表渲染（高亮当前分支、排序、分组）
  - 刷新按钮禁用/启用
- 事件处理：
  - 点击分支 → 调 `POST /api/git/checkout`
  - 点击刷新 → 调 `GET /api/git/branches?refresh=1`
  - 菜单外点击 / Esc 关闭菜单
  - 初始化 / 切换目录后自动调 `GET /api/git/status`

### 3.2 后端模块（`src/entrypoints/web/routes-git.js`）

新增 routes handler，调用 Node.js `child_process.execFile` 执行 git 命令：

**`handleGitStatus(cwd, res)`**：
- 执行 `git rev-parse --abbrev-ref HEAD` 和 `git rev-parse --is-inside-work-tree`
- 返回 `{ isGit, currentBranch, cwd }` 或错误

**`handleGitBranches(cwd, refresh, res)`**：
- 若 `refresh=1`，先执行 `git fetch` 更新远程分支信息（超时 10s）
- 执行 `git branch -a --format=...` 列出所有分支
- 解析后按【本地优先、各自字母序】排序
- 返回 `{ local: [], remote: [], current: "..." }`

**`handleGitCheckout(cwd, branch, res)`**：
- 执行 `git checkout <branch>`（分支名须通过白名单校验：字母数字加 `/.-_`）
- 成功返回 `{ ok: true, branch }`；失败返回 `{ error: "stderr 内容" }`

### 3.3 HTTP 路由（`server.js` ROUTES 表）

```javascript
{ path: '/api/git/status', h: (req, res) => handleGitStatus(...) },
{ path: '/api/git/branches', h: (req, res, url) => handleGitBranches(...) },
{ path: '/api/git/checkout', method: 'POST', h: (req, res) => handleGitCheckout(...) },
```

## 四、API 设计

### 4.1 GET `/api/git/status`

**查询参数**：无（当前 cwd 从 app.js 传入）

**响应成功**：
```json
{
  "data": {
    "isGit": true,
    "currentBranch": "main",
    "cwd": "/path/to/repo"
  }
}
```

**响应失败（非 git 仓库）**：
```json
{
  "data": {
    "isGit": false,
    "cwd": "/some/path"
  }
}
```

---

### 4.2 GET `/api/git/branches?refresh=1`

**查询参数**：
- `refresh` (可选)：`1` 时先执行 `git fetch`

**响应成功**：
```json
{
  "data": {
    "local": ["main", "dev", "feat/api"],
    "remote": ["origin/main", "origin/dev"],
    "current": "dev"
  }
}
```

**响应失败**：
```json
{
  "data": null,
  "error": "fatal: not a git repository"
}
```

---

### 4.3 POST `/api/git/checkout`

**请求体**：
```json
{
  "branch": "dev"
}
```

**响应成功**：
```json
{
  "data": {
    "ok": true,
    "branch": "dev"
  }
}
```

**响应失败**：
```json
{
  "data": null,
  "error": "error: Your local changes to 'src/app.js' would be overwritten by checkout\nPlease commit your changes or stash them before you switch branches."
}
```

## 五、UI 和样式设计

### 5.1 HTML 结构

在 `index.html` 的 `#dirBtn` 后立即插入：

```html
<!-- 分支选择器按钮 -->
<button class="git-selector" id="gitBtn" title="选择项目分支" hidden>
  <span class="branch-icon">🌿</span>
  <span class="branch-name" id="gitLabel">main</span>
  <span class="caret">▾</span>
</button>

<!-- 分支列表浮层 -->
<div class="git-dropdown" id="gitDropdown" hidden>
  <div class="git-branches" id="gitBranches">
    <!-- 动态生成：本地分支组 + 远程分支组 -->
  </div>
  <div class="git-footer">
    <button class="git-refresh-btn" id="gitRefreshBtn" title="刷新分支列表">
      <span>🔄</span> 刷新
    </button>
  </div>
</div>
```

### 5.2 CSS（在 `app.css` 中添加）

```css
/* 分支选择器按钮：复用 dir-selector 风格 */
.git-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 280px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  font-family: inherit;
  font-size: 12.5px;
  transition: border-color 0.2s;
}

.git-selector:hover {
  border-color: var(--accent);
}

.git-selector .branch-icon {
  color: var(--accent);
}

.git-selector .branch-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.git-selector .caret {
  color: var(--muted);
}

/* 下拉菜单浮层 */
.git-dropdown {
  position: fixed;
  z-index: 999;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  min-width: 240px;
  max-width: 320px;
}

.git-branches {
  max-height: 400px;
  overflow-y: auto;
  padding: 4px 0;
}

.git-branch-item {
  padding: 8px 12px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  transition: background-color 0.15s;
}

.git-branch-item:hover {
  background: var(--hover, rgba(255, 255, 255, 0.08));
}

.git-branch-item.current {
  background: var(--accent, #4f46e5);
  color: #fff;
  font-weight: 500;
}

.git-branch-item.current::before {
  content: "✓ ";
  margin-right: 4px;
}

.git-footer {
  border-top: 1px solid var(--border);
  padding: 6px;
}

.git-refresh-btn {
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.git-refresh-btn:hover:not(:disabled) {
  background: var(--hover, rgba(255, 255, 255, 0.08));
}

.git-refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.git-branch-item.local::before {
  content: "• ";
  margin-right: 4px;
  color: var(--accent);
}

.git-branch-item.remote {
  color: var(--muted);
  font-size: 12px;
}
```

### 5.3 交互细节

- **按钮位置**：紧跟 `#dirBtn` 后，topbar 中第二个选择控件
- **浮层位置**：相对 `#gitBtn` 左对齐，下方弹出
- **滚动**：分支列表超过 15 项时启用滚动（max-height: 400px）
- **焦点管理**：打开菜单时第一个分支项获焦（可选，增强 a11y）
- **关闭触发**：
  - 点菜单外
  - 按 Esc 键
  - 成功切换分支后自动关闭

## 六、实现细节与约束

### 6.1 并发控制

- 切换分支中 → 禁用列表中其他分支的点击、禁用刷新按钮
- 刷新中 → 禁用所有分支点击、刷新按钮改为「加载中...」状态

### 6.2 超时和重试

- `git fetch` 超时：10 秒后中止，toast 提示超时
- `git checkout` 超时：5 秒后中止
- **无自动重试**：用户手动点「刷新」或重新选择

### 6.3 错误处理

- **非 git 仓库**：按钮 `hidden`，直到用户切换到 git 目录
- **切换失败**：toast 展示 stderr（用户友好化，如「有未提交改动」）
- **网络 / 权限**：后端捕获所有异常，返回结构化错误
- **分支名校验**：后端白名单 `^[a-zA-Z0-9/_.-]+$`，防注入

### 6.4 性能考虑

- **分支列表缓存**：打开菜单时若已有列表，不重新请求（除非手动刷新）
- **git fetch**：只在用户显式点「刷新」时执行，不在初始化时自动 fetch
- **防抖**：如无必要，短时间内重复打开菜单时复用上次结果

## 七、文件变动清单

**新增**：
- `public/js/git-selector.js` — 前端模块
- `src/entrypoints/web/routes-git.js` — 后端 handler
- `docs/superpowers/specs/2026-09-08-git-branch-selector-design.md` — 本文档

**修改**：
- `public/index.html` — 加 HTML 结构（`#gitBtn` + `#gitDropdown`）
- `public/app.css` — 加样式（`.git-selector` / `.git-dropdown` / `.git-branch-item` 等）
- `public/app.js` — 加初始化调用 `bindGitSelector`；导入 `git-selector.js`
- `src/entrypoints/web/server.js` — ROUTES 表加 3 条路由

## 八、测试策略

### 单元测试
- `routes-git.js` 的纯函数：分支排序 / 命名规范 / 白名单校验
- `git-selector.js` 的状态机：打开/关闭/加载/错误各态转移

### 集成测试
- 完整流程：切换目录 → 显示按钮 → 打开菜单 → 刷新 → 切换分支
- 错误路径：非 git 目录、切换失败、网络超时

### 手工测试
- 多分支仓库（含远程）切换
- 有未提交改动的情况
- 分支名特殊字符（中文、emoji）
- 菜单焦点和 Esc 关闭

## 九、后续改进空间

- 分支删除 / 创建功能（v2）
- 分支合并/基线更新（v2）
- 搜索过滤（当分支数 > 50 时）
- 快捷键绑定（如 Ctrl+B 切分支）

---

**设计评审**: ✓ 用户批准  
**设计日期**: 2026-09-08

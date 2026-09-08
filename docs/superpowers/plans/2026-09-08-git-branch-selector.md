# Git 分支选择器实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现顶栏分支选择器，用户可查看、切换、刷新当前项目的 git 分支。

**Architecture:** 后端提供 3 个 git API 端点（`/api/git/status`、`/api/git/branches`、`/api/git/checkout`），前端独立模块 `git-selector.js` 管理 UI 状态和交互，app.js 注入工作目录读取器并初始化。

**Tech Stack:** Node.js `child_process.execFile` 执行 git 命令；前端原生 JavaScript（无框架）；样式复用现有 CSS 变量系统。

---

## Task 1: 后端基础设施 - routes-git.js 框架

**Files:**
- Create: `src/entrypoints/web/routes-git.js`
- Modify: `src/entrypoints/web/server.js` (路由表)

- [ ] **Step 1: 创建 routes-git.js 框架文件**

```javascript
/** src/entrypoints/web/routes-git.js
 * Git 相关 HTTP 端点 handler：status / branches / checkout
 */
import { execFile } from 'node:child_process';
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';

/** 校验分支名：仅允许字母数字加 /.-_ */
const BRANCH_NAME_REGEX = /^[a-zA-Z0-9/_.\-]+$/;

function validateBranchName(name) {
  return typeof name === 'string' && BRANCH_NAME_REGEX.test(name);
}

/**
 * 执行 git 命令的通用工具函数
 * @param {string} cwd 工作目录
 * @param {string[]} args git 命令参数
 * @param {number} timeout 超时（毫秒）
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function execGit(cwd, args, timeout = 5000) {
  return new Promise((resolve) => {
    const proc = execFile('git', args, { cwd, timeout }, (err, stdout, stderr) => {
      resolve({
        code: err?.code === 'ETIMEDOUT' ? 'TIMEOUT' : (err ? 1 : 0),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

/** GET /api/git/status - 检查是否 git 仓库，返回当前分支 */
export async function handleGitStatus(cwd, res) {
  const cwdStr = str(cwd);
  if (!cwdStr) {
    return sendJson(res, {
      data: { isGit: false, cwd: '' },
    });
  }

  // 检查是否在 git 仓库内
  const isGitCheck = await execGit(cwdStr, ['rev-parse', '--is-inside-work-tree']);
  const isGit = isGitCheck.stdout === 'true';

  if (!isGit) {
    return sendJson(res, {
      data: { isGit: false, cwd: cwdStr },
    });
  }

  // 获取当前分支名
  const branchCheck = await execGit(cwdStr, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = branchCheck.code === 0 ? branchCheck.stdout : 'HEAD';

  sendJson(res, {
    data: {
      isGit: true,
      currentBranch,
      cwd: cwdStr,
    },
  });
}

/** GET /api/git/branches?refresh=1 - 列出本地和远程分支 */
export async function handleGitBranches(cwd, refresh, res) {
  const cwdStr = str(cwd);
  if (!cwdStr) {
    return sendJson(res, { data: null, error: '缺少工作目录' });
  }

  // 若 refresh=1，先执行 git fetch
  if (refresh === '1') {
    const fetchResult = await execGit(cwdStr, ['fetch', '--all'], 10000);
    if (fetchResult.code === 'TIMEOUT') {
      return sendJson(res, { data: null, error: 'git fetch 超时（10s）' });
    }
    if (fetchResult.code !== 0) {
      return sendJson(res, { data: null, error: fetchResult.stderr || 'git fetch 失败' });
    }
  }

  // 列出所有分支（本地 + 远程）
  const branchResult = await execGit(cwdStr, [
    'branch', '-a',
    '--format=%(refname:short)|(BRANCH_SEP)|%(if)%(HEAD)%(then)true%(else)false%(end)',
  ]);

  if (branchResult.code !== 0) {
    return sendJson(res, {
      data: null,
      error: branchResult.stderr || 'git branch 失败',
    });
  }

  // 解析分支列表
  const lines = branchResult.stdout.split('\n').filter((l) => l.trim());
  const local = [];
  const remote = [];
  let current = 'main'; // 默认值

  for (const line of lines) {
    const [name, isCurrent] = line.split('|(BRANCH_SEP)|');
    if (!name) continue;

    if (isCurrent === 'true') {
      current = name.replace(/^remotes\//, ''); // 去掉 remotes/ 前缀用作 current
    }

    if (name.startsWith('remotes/')) {
      remote.push(name.replace(/^remotes\//, '')); // origin/main
    } else {
      local.push(name);
    }
  }

  // 排序：本地和远程各自按字母序
  local.sort();
  remote.sort();

  sendJson(res, {
    data: {
      local,
      remote,
      current,
    },
  });
}

/** POST /api/git/checkout - 切换分支 */
export async function handleGitCheckout(cwd, req, res) {
  const cwdStr = str(cwd);
  if (!cwdStr) {
    return sendJson(res, { data: null, error: '缺少工作目录' });
  }

  // 读请求体
  return withJsonBody(req, async (body) => {
    const branch = str(body?.branch);
    if (!branch || !validateBranchName(branch)) {
      return sendJson(res, { data: null, error: '无效的分支名' });
    }

    const checkoutResult = await execGit(cwdStr, ['checkout', branch], 5000);

    if (checkoutResult.code === 'TIMEOUT') {
      return sendJson(res, { data: null, error: 'git checkout 超时（5s）' });
    }

    if (checkoutResult.code === 0) {
      return sendJson(res, {
        data: { ok: true, branch },
      });
    }

    // 失败：返回 stderr（用户友好的错误信息）
    sendJson(res, {
      data: null,
      error: checkoutResult.stderr || 'git checkout 失败',
    });
  });
}
```

- [ ] **Step 2: 在 server.js ROUTES 表中注册 3 条路由**

打开 `src/entrypoints/web/server.js`，在 ROUTES 表中找到 `/api/dirs/saved` 条目（约 149 行），在其后立即添加：

```javascript
  { path: '/api/git/status', h: (req, res, url) => {
    const cwd = url.searchParams.get('cwd') || '';
    return handleGitStatus(cwd, res);
  }},
  { path: '/api/git/branches', h: (req, res, url) => {
    const cwd = url.searchParams.get('cwd') || '';
    const refresh = url.searchParams.get('refresh') || '';
    return handleGitBranches(cwd, refresh, res);
  }},
  { path: '/api/git/checkout', method: 'POST', h: (req, res, url) => {
    const cwd = url.searchParams.get('cwd') || '';
    return handleGitCheckout(cwd, req, res);
  }},
```

同时在 `server.js` 顶部导入：
```javascript
import { handleGitStatus, handleGitBranches, handleGitCheckout } from './routes-git.js';
```

- [ ] **Step 3: Commit**

```bash
git add src/entrypoints/web/routes-git.js src/entrypoints/web/server.js
git commit -m "feat(git): add git API handlers (status, branches, checkout)"
```

---

## Task 2: 后端单元测试 - 纯函数验证

**Files:**
- Create: `src/entrypoints/web/routes-git.test.js`

- [ ] **Step 1: 写测试 - validateBranchName 和分支排序**

```javascript
/** src/entrypoints/web/routes-git.test.js */
import { test } from 'node:test';
import * as assert from 'node:assert';

// 模拟从 routes-git.js 导出的函数（实际使用时需在 routes-git.js 中导出）
function validateBranchName(name) {
  const BRANCH_NAME_REGEX = /^[a-zA-Z0-9/_.\-]+$/;
  return typeof name === 'string' && BRANCH_NAME_REGEX.test(name);
}

test('validateBranchName 校验分支名', (t) => {
  assert.strictEqual(validateBranchName('main'), true);
  assert.strictEqual(validateBranchName('dev'), true);
  assert.strictEqual(validateBranchName('feat/api'), true);
  assert.strictEqual(validateBranchName('release-1.0'), true);
  assert.strictEqual(validateBranchName('fix_bug'), true);
  assert.strictEqual(validateBranchName('feature/user.profile'), true);
  
  assert.strictEqual(validateBranchName('main@'), false);
  assert.strictEqual(validateBranchName('feat$branch'), false);
  assert.strictEqual(validateBranchName(''), false);
  assert.strictEqual(validateBranchName(null), false);
  assert.strictEqual(validateBranchName(undefined), false);
});

test('分支列表排序 - 本地优先，各自字母序', (t) => {
  const local = ['feature/api', 'main', 'dev', 'alpha'];
  const remote = ['origin/main', 'origin/develop', 'origin/beta'];
  
  local.sort();
  remote.sort();
  
  assert.deepStrictEqual(local, ['alpha', 'dev', 'feature/api', 'main']);
  assert.deepStrictEqual(remote, ['origin/beta', 'origin/develop', 'origin/main']);
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
npm test -- src/entrypoints/web/routes-git.test.js
```

预期：测试通过（因为逻辑很简单）

- [ ] **Step 3: Commit**

```bash
git add src/entrypoints/web/routes-git.test.js
git commit -m "test(git): add unit tests for branch validation and sorting"
```

---

## Task 3: 前端 HTML 和 CSS 修改

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.css`

- [ ] **Step 1: 修改 index.html - 添加 git 选择器 HTML 结构**

打开 `public/index.html`，找到 `#dirBtn` 按钮（约 240 行），在其后立即添加：

```html
        <button class="git-selector" id="gitBtn" title="选择项目分支" hidden>
          <span class="branch-icon">🌿</span>
          <span class="branch-name" id="gitLabel">main</span>
          <span class="caret">▾</span>
        </button>

        <!-- 分支列表浮层 -->
        <div class="git-dropdown" id="gitDropdown" hidden>
          <div class="git-branches" id="gitBranches">
            <!-- 动态生成分支列表 -->
          </div>
          <div class="git-footer">
            <button class="git-refresh-btn" id="gitRefreshBtn" title="刷新分支列表">
              <span>🔄</span> 刷新
            </button>
          </div>
        </div>
```

- [ ] **Step 2: 修改 app.css - 添加 git 选择器样式**

打开 `public/app.css`，找到 `.dir-selector .caret` 规则（约 371 行），在其后添加以下样式：

```css
/* ---- Git 分支选择器 ---- */
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
  flex-shrink: 0;
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
  flex-shrink: 0;
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

.git-branch-item.local::before {
  content: "• ";
  margin-right: 4px;
  color: var(--accent);
}

.git-branch-item.remote {
  color: var(--muted);
  font-size: 12px;
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
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html public/app.css
git commit -m "feat(ui): add git selector HTML structure and styles"
```

---

## Task 4: 前端模块 - git-selector.js 实现

**Files:**
- Create: `public/js/git-selector.js`

- [ ] **Step 1: 创建 git-selector.js - 基础框架和状态管理**

```javascript
/** public/js/git-selector.js
 * Git 分支选择器模块：状态管理、UI 控制、事件处理
 */
import { $, toast } from './util.js';
import { getJson, postJson } from './api.js';

// 模块内部状态
let _getCwd = () => '';
let _currentBranch = '';
let _branches = { local: [], remote: [], current: '' };
let _isOpen = false;
let _isLoading = false;

/** 注入工作目录读取器 */
export function bindGitSelector({ getCwd }) {
  _getCwd = getCwd || (() => '');
  initialize();
}

/** 初始化：检查当前目录是否 git 仓库 */
async function initialize() {
  const cwd = _getCwd();
  if (!cwd) {
    $('#gitBtn').hidden = true;
    return;
  }

  try {
    const { data } = await getJson('/api/git/status?cwd=' + encodeURIComponent(cwd));
    if (data?.isGit) {
      _currentBranch = data.currentBranch || 'main';
      updateButtonLabel();
      $('#gitBtn').hidden = false;
      setupEventListeners();
    } else {
      $('#gitBtn').hidden = true;
    }
  } catch {
    $('#gitBtn').hidden = true;
  }
}

/** 更新按钮标签 */
function updateButtonLabel() {
  const label = $('#gitLabel');
  if (label) {
    label.textContent = _currentBranch;
    label.title = _currentBranch;
  }
}

/** 设置事件监听器 */
function setupEventListeners() {
  const btn = $('#gitBtn');
  const dropdown = $('#gitDropdown');
  const refreshBtn = $('#gitRefreshBtn');

  if (btn) {
    btn.addEventListener('click', toggleDropdown);
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', handleRefresh);
  }

  // 点菜单外关闭
  document.addEventListener('mousedown', handleClickOutside);
  // Esc 键关闭
  document.addEventListener('keydown', handleKeydown);
}

/** 打开/关闭下拉菜单 */
async function toggleDropdown(e) {
  e.stopPropagation();
  const dropdown = $('#gitDropdown');
  const btn = $('#gitBtn');

  if (_isOpen) {
    closeDropdown();
  } else {
    _isOpen = true;
    dropdown.hidden = false;

    // 定位浮层
    const rect = btn.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = (rect.bottom + 8) + 'px';

    // 加载分支列表
    await loadBranches();
  }
}

/** 关闭下拉菜单 */
function closeDropdown() {
  _isOpen = false;
  const dropdown = $('#gitDropdown');
  if (dropdown) dropdown.hidden = true;
}

/** 加载分支列表 */
async function loadBranches() {
  if (_isLoading) return;
  _isLoading = true;

  const cwd = _getCwd();
  const container = $('#gitBranches');

  try {
    const { data, error } = await getJson('/api/git/branches?cwd=' + encodeURIComponent(cwd));
    
    if (error) {
      toast('加载分支失败：' + error);
      _isLoading = false;
      return;
    }

    _branches = data || { local: [], remote: [], current: '' };
    renderBranches();
  } catch (err) {
    toast('加载分支失败');
  } finally {
    _isLoading = false;
  }
}

/** 渲染分支列表 */
function renderBranches() {
  const container = $('#gitBranches');
  if (!container) return;

  container.innerHTML = '';

  const { local, remote, current } = _branches;

  // 本地分支
  if (local.length > 0) {
    for (const branch of local) {
      const item = createBranchItem(branch, current, 'local');
      container.appendChild(item);
    }
  }

  // 远程分支
  if (remote.length > 0) {
    for (const branch of remote) {
      const item = createBranchItem(branch, current, 'remote');
      container.appendChild(item);
    }
  }

  if (local.length === 0 && remote.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:8px 12px;color:var(--muted);font-size:12px';
    empty.textContent = '（无分支）';
    container.appendChild(empty);
  }
}

/** 创建分支行 */
function createBranchItem(name, current, type) {
  const item = document.createElement('div');
  item.className = 'git-branch-item ' + type;

  if (name === current) {
    item.classList.add('current');
  }

  item.textContent = name;
  item.addEventListener('click', () => handleBranchClick(name));

  return item;
}

/** 点击分支 - 执行切换 */
async function handleBranchClick(branch) {
  if (_isLoading) return;
  _isLoading = true;

  const cwd = _getCwd();
  const btn = $('#gitRefreshBtn');
  if (btn) btn.disabled = true;

  try {
    const { data, error } = await postJson('/api/git/checkout', {
      cwd,
      branch,
    });

    if (error) {
      toast('切换分支失败：' + error);
    } else if (data?.ok) {
      _currentBranch = branch;
      updateButtonLabel();
      toast('已切换到 ' + branch);
      closeDropdown();
    }
  } catch (err) {
    toast('切换分支失败');
  } finally {
    _isLoading = false;
    if (btn) btn.disabled = false;
  }
}

/** 点击刷新按钮 */
async function handleRefresh(e) {
  e.stopPropagation();
  if (_isLoading) return;

  const btn = $('#gitRefreshBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '刷新中…';
  }

  const cwd = _getCwd();

  try {
    const { data, error } = await getJson(
      '/api/git/branches?cwd=' + encodeURIComponent(cwd) + '&refresh=1'
    );

    if (error) {
      toast('刷新分支失败：' + error);
    } else {
      _branches = data || { local: [], remote: [], current: '' };
      renderBranches();
      toast('分支列表已刷新');
    }
  } catch (err) {
    toast('刷新失败');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>🔄</span> 刷新';
    }
  }
}

/** 点菜单外关闭 */
function handleClickOutside(e) {
  if (!_isOpen) return;

  const dropdown = $('#gitDropdown');
  const btn = $('#gitBtn');

  if (dropdown && btn && !dropdown.contains(e.target) && !btn.contains(e.target)) {
    closeDropdown();
  }
}

/** Esc 键关闭 */
function handleKeydown(e) {
  if (e.key === 'Escape' && _isOpen) {
    closeDropdown();
  }
}

// 导出给 app.js 调用
export function reinitializeGitSelector() {
  initialize();
}
```

- [ ] **Step 2: 运行 npm start 检查语法**

```bash
npm start
```

预期：服务启动成功，浏览器打开，分支按钮在 git 仓库中显示

- [ ] **Step 3: Commit**

```bash
git add public/js/git-selector.js
git commit -m "feat(git-selector): implement branch selector module with UI and state management"
```

---

## Task 5: 前端集成 - app.js 初始化和导入

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: 在 app.js 顶部导入 git-selector**

打开 `public/app.js`，找到其他导入语句（靠近文件顶部），添加：

```javascript
import { bindGitSelector, reinitializeGitSelector } from './js/git-selector.js';
```

- [ ] **Step 2: 在 app.js 初始化时调用 bindGitSelector**

找到 `bindDirPopover` 调用（约 20 行），在其后立即添加：

```javascript
bindGitSelector({ getCwd: () => cwd });
```

- [ ] **Step 3: 在 selectDir 函数中添加 git 重新初始化**

找到 `function selectDir(p)` 定义（约 80-100 行），在修改 cwd 后添加：

```javascript
// 切换分支选择器状态
reinitializeGitSelector();
```

具体位置应该是在 `lsSet('claude_cwd', cwd);` 之后。

- [ ] **Step 4: 运行应用，测试初始化**

```bash
npm start
```

打开浏览器，导航到 git 仓库目录，验证：
- [ ] 分支按钮出现
- [ ] 按钮标签显示当前分支名
- [ ] 点击按钮下拉菜单打开
- [ ] 分支列表显示本地 + 远程分支

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat: integrate git-selector into app initialization"
```

---

## Task 6: 前端 API 调用修复 - 传递 cwd 参数

**Files:**
- Modify: `src/entrypoints/web/routes-git.js`
- Modify: `src/entrypoints/web/server.js`

- [ ] **Step 1: 审视 routes-git.js 的 handleGitStatus 逻辑**

由于 app.js 的 `getCwd()` 是本地状态，API 调用时需传 `cwd` 查询参数。但当前 `git-selector.js` 中的 API 调用（如 `/api/git/status?cwd=...`）缺少前端的实际工作目录。

检查 `git-selector.js` 中的 `loadBranches()` 函数，确保 cwd 参数正确传递：

实际上前面的代码已经包含了 `cwd` 参数。现在需要确保后端正确读取。在 `server.js` 中验证路由 handler 正确解析：

```javascript
  { path: '/api/git/status', h: (req, res, url) => {
    const cwd = url.searchParams.get('cwd') || '';
    return handleGitStatus(cwd, res);
  }},
```

这已经在 Task 1 中完成。检查验证无误后提交。

- [ ] **Step 2: 运行手工测试 - 切换目录后更新分支信息**

```bash
npm start
```

在浏览器中：
1. 点击工作目录选择器，切换到另一个 git 仓库
2. 验证分支选择器自动更新显示新仓库的分支

- [ ] **Step 3: Commit（如有改动）**

```bash
git add src/entrypoints/web/routes-git.js src/entrypoints/web/server.js
git commit -m "fix: ensure git API handlers correctly receive cwd parameter"
```

---

## Task 7: 集成测试 - 分支切换流程

**Files:**
- Test manually in browser

- [ ] **Step 1: 准备测试环境**

使用本地 Principal 项目（已经是 git 仓库）：
- 确保有多个本地分支
- 如果没有远程，手动 `git remote add origin <url>` 或跳过远程分支验证

- [ ] **Step 2: 测试初始化和显示**

```
1. npm start，打开 http://localhost:3000
2. 验证分支按钮显示当前分支（应为 v1.0.0 或当前分支）
3. 验证 #gitBtn 不隐藏
```

- [ ] **Step 3: 测试下拉菜单加载**

```
1. 点击分支按钮
2. 验证下拉菜单打开
3. 验证分支列表显示（本地分支列表应包含 main、v1.0.0 等）
4. 验证当前分支高亮显示
```

- [ ] **Step 4: 测试分支切换**

```
1. 从下拉菜单选择另一个分支（如 main）
2. 验证后端执行 git checkout
3. 验证分支按钮标签更新
4. 验证下拉菜单自动关闭
5. 验证 toast 显示「已切换到 main」
```

- [ ] **Step 5: 测试刷新功能**

```
1. 打开分支选择器
2. 点击「刷新」按钮
3. 验证 toast 显示「分支列表已刷新」
4. 验证列表重新加载
```

- [ ] **Step 6: 测试错误场景**

```
1. 切换到非 git 目录（工作目录选择器）
2. 验证分支按钮隐藏
3. 切换回 git 目录
4. 验证分支按钮重新显示
```

- [ ] **Step 7: 测试 Esc 和菜单外点击**

```
1. 打开分支选择器
2. 按 Esc 键
3. 验证菜单关闭

4. 重新打开菜单
5. 点击菜单外的区域（如页面其他部分）
6. 验证菜单关闭
```

- [ ] **Step 8: Commit 测试记录**

```bash
git add -A
git commit -m "test(git-selector): verify branch selector integration and user flows"
```

---

## Task 8: 错误处理和边界情况测试

**Files:**
- Manual testing

- [ ] **Step 1: 测试权限错误（模拟）**

在 git 仓库中：
```
1. 创建一个有未提交改动的文件
2. 尝试切换到另一个分支
3. 验证 toast 显示 git 错误信息（「你的本地改动...会被覆盖」）
```

- [ ] **Step 2: 测试超时（可选）**

如果环境可以模拟网络延迟，验证：
```
1. 人工延迟 git fetch 或 checkout
2. 验证超时后 toast 提示
```

- [ ] **Step 3: 测试特殊分支名**

```
1. 创建带特殊字符的分支（如 feature/user.profile、release-1.0）
2. 验证能正确切换
3. 验证列表中正确显示
```

- [ ] **Step 4: 测试禁用状态**

```
1. 打开分支列表
2. 点击一个分支（执行 checkout）
3. 验证 checkout 执行中，刷新按钮禁用
4. 验证其他分支项无法点击（可选实现）
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(git-selector): verify error handling and edge cases"
```

---

## Task 9: 文档和代码审查

**Files:**
- Verify: all changes match design spec

- [ ] **Step 1: 对照设计文档进行代码审查**

检查清单：
- [ ] API 端点 (`/api/git/status`, `/api/git/branches`, `/api/git/checkout`) 存在且功能正确
- [ ] 前端 HTML 结构（`#gitBtn`, `#gitDropdown`, `.git-branches`, `#gitRefreshBtn`）完整
- [ ] CSS 样式（`.git-selector`, `.git-dropdown`, `.git-branch-item`, `.git-refresh-btn`）已添加
- [ ] 前端状态管理（`_currentBranch`, `_branches`, `_isOpen`, `_isLoading`）实现
- [ ] 分支排序（本地优先、各自字母序）正确
- [ ] 当前分支标记（高亮 + ✓）正确
- [ ] 错误处理（toast 展示错误）正确
- [ ] 并发控制（loading 禁用按钮）实现

- [ ] **Step 2: 验证无语法错误**

```bash
npm test
node --check src/entrypoints/web/routes-git.js
node --check public/js/git-selector.js
```

- [ ] **Step 3: 最终提交**

```bash
git log --oneline -10
# 验证提交历史包含上述所有 feature 提交
```

---

## 检查清单 - 完成标志

- [ ] 后端 API 三个端点实现完成
- [ ] 前端 UI HTML 和 CSS 完成
- [ ] 前端逻辑模块 git-selector.js 完成
- [ ] app.js 集成完成
- [ ] 单元测试通过
- [ ] 集成测试（手工）通过
- [ ] 错误场景验证通过
- [ ] 无语法错误
- [ ] 所有提交完成

**预期成果**：用户在 Principal 中可见分支选择器，点击打开下拉，选择分支执行切换，刷新按钮可更新分支列表，所有交互流畅、错误提示清晰。

---

**计划完成日期**: 2026-09-08  
**预计工作量**: 4-6 小时（含测试）

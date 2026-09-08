/** public/js/git-selector.js
 * Git 分支选择器：状态管理、UI 控制、事件处理。
 * 通过 bindGitSelector({ getCwd }) 注入工作目录读取器后自动初始化。
 */
import { $ } from './util.js';
import { toast } from './ui.js';
import { getJson, postJson } from './api.js';

// 模块级状态
let _getCwd = () => '';
let _currentBranch = '';
let _branches = { local: [], remote: [], current: '' };
let _isOpen = false;
let _isLoading = false;
let _listenerController = null;

/**
 * 注入工作目录读取器，初始化分支选择器。
 *
 * checkAndInit 延到微任务：本函数在 chat.js 模块顶部调用，而 `cwd` 在同文件
 * 更后面才 `let` 声明——同步读会撞 TDZ，且因 checkAndInit 是 async，
 * ReferenceError 会变成静默的 unhandled rejection（标签不更新、监听器不挂）。
 */
export function bindGitSelector({ getCwd }) {
  _getCwd = getCwd || (() => '');
  queueMicrotask(checkAndInit);
}

/** 切换工作目录后重新检测 git 状态 */
export function reinitializeGitSelector() {
  _currentBranch = '';
  _branches = { local: [], remote: [], current: '' };
  closeDropdown();
  checkAndInit();
}

/** 检查当前目录是否 git 仓库，决定显示/隐藏按钮 */
async function checkAndInit() {
  const cwd = _getCwd();
  const btn = $('#gitBtn');
  if (!btn) return;

  if (!cwd) {
    btn.hidden = true;
    return;
  }

  try {
    const { data } = await getJson('/api/git/status?cwd=' + encodeURIComponent(cwd));
    if (data?.isGit) {
      _currentBranch = data.currentBranch || '';
      updateButtonLabel();
      btn.hidden = false;
      attachListeners();
    } else {
      btn.hidden = true;
    }
  } catch {
    btn.hidden = true;
  }
}

/** 更新顶栏按钮标签 */
function updateButtonLabel() {
  const label = $('#gitLabel');
  if (label) {
    label.textContent = _currentBranch || '未知';
    label.title = _currentBranch;
  }
}

/** 注册全局事件监听器（AbortController 管理，支持热重载清理） */
function attachListeners() {
  if (_listenerController) return;
  _listenerController = new AbortController();
  const { signal } = _listenerController;

  const btn = $('#gitBtn');
  const refreshBtn = $('#gitRefreshBtn');

  if (btn) btn.addEventListener('click', handleToggle, { signal });
  if (refreshBtn) refreshBtn.addEventListener('click', handleRefresh, { signal });

  document.addEventListener('mousedown', handleClickOutside, { signal });
  document.addEventListener('keydown', handleKeydown, { signal });
}

/** 点击按钮：切换下拉 */
function handleToggle(e) {
  e.stopPropagation();
  if (_isOpen) {
    closeDropdown();
  } else {
    openDropdown();
  }
}

/** 打开下拉菜单，定位后加载分支列表 */
async function openDropdown() {
  const btn = $('#gitBtn');
  const dropdown = $('#gitDropdown');
  if (!btn || !dropdown) return;

  _isOpen = true;
  dropdown.hidden = false;

  // 定位浮层：左对齐 #gitBtn，紧贴下方
  const rect = btn.getBoundingClientRect();
  dropdown.style.left = rect.left + 'px';
  dropdown.style.top = (rect.bottom + 6) + 'px';

  // 若已有缓存，不重复请求
  if (_branches.local.length > 0 || _branches.remote.length > 0) {
    renderBranches();
    return;
  }

  await loadBranches(false);
}

/** 关闭下拉菜单 */
function closeDropdown() {
  _isOpen = false;
  const dropdown = $('#gitDropdown');
  if (dropdown) dropdown.hidden = true;
}

/** 加载分支列表（refresh=true 时触发 git fetch） */
async function loadBranches(refresh) {
  if (_isLoading) return;
  _isLoading = true;

  const container = $('#gitBranches');
  const refreshBtn = $('#gitRefreshBtn');

  if (refreshBtn) {
    refreshBtn.disabled = true;
    if (refresh) refreshBtn.textContent = '刷新中…';
  }

  if (container) {
    container.innerHTML = '';
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:8px 12px;color:var(--muted);font-size:12px';
    hint.textContent = refresh ? '正在 fetch 最新数据…' : '加载中…';
    container.appendChild(hint);
  }

  const cwd = _getCwd();
  const url = '/api/git/branches?cwd=' + encodeURIComponent(cwd) + (refresh ? '&refresh=1' : '');

  try {
    const { data } = await getJson(url);
    if (!data || data.error) {
      toast('加载分支失败：' + (data?.error || '响应异常'));
    } else {
      _branches = {
        local: data.local || [],
        remote: data.remote || [],
        current: data.current || '',
      };
      renderBranches();
      if (refresh) toast('分支列表已刷新');
    }
  } catch {
    toast('加载分支失败');
  } finally {
    _isLoading = false;
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '🔄 刷新';
    }
  }
}

/** 渲染分支列表到 #gitBranches */
function renderBranches() {
  const container = $('#gitBranches');
  if (!container) return;

  container.innerHTML = '';
  const { local, remote, current } = _branches;

  for (const branch of local) {
    container.appendChild(createBranchItem(branch, current, 'local'));
  }
  for (const branch of remote) {
    container.appendChild(createBranchItem(branch, current, 'remote'));
  }

  if (local.length === 0 && remote.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:8px 12px;color:var(--muted);font-size:12px';
    empty.textContent = '（无分支）';
    container.appendChild(empty);
  }
}

/** 创建单条分支行 */
function createBranchItem(name, current, type) {
  const item = document.createElement('div');
  item.className = 'git-branch-item ' + type + (name === current ? ' current' : '');
  item.textContent = (name === current ? '✓ ' : '') + name;
  item.addEventListener('click', () => handleBranchClick(name, type));
  return item;
}

/**
 * 点击分支行 → 执行 git checkout。
 *
 * 远程分支要剥掉 remote 名（`origin/dev` → `dev`）：直接 checkout `origin/dev`
 * 会进 detached HEAD，而 checkout 短名会走 git 的 DWIM——本地已有就切过去，
 * 没有就建一个跟踪该远程的本地分支，这才是点「origin/dev」时用户想要的结果。
 */
async function handleBranchClick(name, type) {
  if (_isLoading) return;
  _isLoading = true;

  const branch = type === 'remote' ? name.replace(/^[^/]+\//, '') : name;

  const refreshBtn = $('#gitRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;

  const cwd = _getCwd();
  try {
    const { data } = await postJson(
      '/api/git/checkout?cwd=' + encodeURIComponent(cwd),
      { branch },
    );
    if (!data || data.error) {
      toast('切换分支失败：' + (data?.error || '响应异常'));
    } else if (data.ok) {
      _currentBranch = branch;
      _branches = { local: [], remote: [], current: '' };
      updateButtonLabel();
      toast('已切换到 ' + branch);
      closeDropdown();
    }
  } catch {
    toast('切换分支失败');
  } finally {
    _isLoading = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

/** 点击刷新按钮 */
async function handleRefresh(e) {
  e.stopPropagation();
  await loadBranches(true);
}

/** 菜单外点击关闭 */
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
  if (e.key === 'Escape' && _isOpen) closeDropdown();
}

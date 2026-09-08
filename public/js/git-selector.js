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

/** 注入工作目录读取器，初始化分支选择器 */
export function bindGitSelector({ getCwd }) {
  _getCwd = getCwd || (() => '');
  checkAndInit();
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
    const { data, error } = await getJson(url);
    if (error) {
      toast('加载分支失败：' + error);
    } else {
      _branches = data || { local: [], remote: [], current: '' };
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
  item.addEventListener('click', () => handleBranchClick(name));
  return item;
}

/** 点击分支行 → 执行 git checkout */
async function handleBranchClick(branch) {
  if (_isLoading) return;
  _isLoading = true;

  const refreshBtn = $('#gitRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;

  const cwd = _getCwd();
  try {
    const { data, error } = await postJson(
      '/api/git/checkout?cwd=' + encodeURIComponent(cwd),
      { branch },
    );
    if (error) {
      toast('切换分支失败：' + error);
    } else if (data?.ok) {
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

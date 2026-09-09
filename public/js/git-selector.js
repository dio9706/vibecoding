/** public/js/git-selector.js
 * Git 分支选择器：状态管理、UI 控制、事件处理。
 * 通过 bindGitSelector({ getCwd }) 注入工作目录读取器后自动初始化。
 */
import { $ } from './util.js';
import { toast } from './ui.js';
import { getJson, postJson } from './api.js';

// 对号内联 SVG（内部静态资源，非用户输入）
const CHECK_SVG = '<svg viewBox="0 0 1024 1024" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M416.832 798.08C400.64 798.08 384.512 791.872 372.16 779.52L119.424 525.76C94.784 500.992 94.784 460.8 119.424 436.032 144.128 411.264 184.128 411.264 208.768 436.032L416.832 644.928 814.4 245.76C839.04 220.928 879.04 220.928 903.744 245.76 928.384 270.528 928.384 310.656 903.744 335.424L461.504 779.52C449.152 791.872 432.96 798.08 416.832 798.08Z"/></svg>';

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
  if (btn) btn.addEventListener('click', handleToggle, { signal });

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

/** 打开下拉菜单，每次重新加载分支列表 */
async function openDropdown() {
  const dropdown = $('#gitDropdown');
  if (!dropdown) return;

  _isOpen = true;
  dropdown.hidden = false;
  _branches = { local: [], remote: [], current: '' };

  await loadBranches();
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

  const container = $('#gitBranches');

  if (container) {
    container.innerHTML = '';
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:8px 12px;color:var(--muted);font-size:12px';
    hint.textContent = '加载中…';
    container.appendChild(hint);
  }

  const cwd = _getCwd();
  const url = '/api/git/branches?cwd=' + encodeURIComponent(cwd);

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
    }
  } catch {
    toast('加载分支失败');
  } finally {
    _isLoading = false;
  }
}

/**
 * 渲染分支列表到 #gitBranches。
 *
 * 合并策略：本地分支与同名远程分支（origin/<name>）合并为一条；
 * 仅存在于远程的分支单独展示。
 */
function renderBranches() {
  const container = $('#gitBranches');
  if (!container) return;

  container.innerHTML = '';
  const { local, remote, current } = _branches;

  // 本地分支短名集合，用于判断远程分支是否已被合并
  const localSet = new Set(local);

  for (const branch of local) {
    container.appendChild(createBranchItem(branch, current, 'local'));
  }

  // 仅显示本地没有对应分支的远程分支
  for (const branch of remote) {
    const shortName = branch.replace(/^[^/]+\//, '');
    if (!localSet.has(shortName)) {
      container.appendChild(createBranchItem(branch, current, 'remote'));
    }
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
  const isCurrent = type === 'remote'
    ? name.replace(/^[^/]+\//, '') === current
    : name === current;

  const item = document.createElement('div');
  item.className = 'git-branch-item ' + type + (isCurrent ? ' current' : '');

  if (isCurrent) {
    const check = document.createElement('span');
    check.className = 'branch-check';
    check.innerHTML = CHECK_SVG;
    item.appendChild(check);
  }

  const label = document.createElement('span');
  label.className = 'branch-label';
  label.textContent = name;
  item.appendChild(label);

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
  }
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

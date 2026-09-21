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
// 世代号：每次重扫自增。切项目时上一轮 /api/git/status 可能还在飞，
// 它姗姗来迟的响应会把旧项目的分支写到新项目的标签上（同 req-view.js 的 reqEpoch 思路）。
let _epoch = 0;
let _retryTimer = null;
// 探测失败的退避重试节奏。桌面版页面秒开、Node 后端要冷启动数秒，首探十有八九落空。
const RETRY_DELAYS_MS = [1000, 3000, 6000];

/**
 * 注入工作目录读取器。**只注入，不探测**。
 *
 * 本函数在 chat.js 模块顶部执行，那时后端往往还没起来（桌面版冷启动数秒）。
 * 在这里探测就会踩空，而踩空的老实现是「隐藏按钮且永不重试」——这正是
 * 「分支选择器有时候整个不见了」的主因。首探改由 chat.js 的 initChat() 发起，
 * 那里在 whenBackendReady() 闸门之后，与其它依赖后端的初始化同批。
 */
export function bindGitSelector({ getCwd }) {
  _getCwd = getCwd || (() => '');
}

/** 首次探测 / 切换工作目录后重新检测 git 状态 */
export function reinitializeGitSelector() {
  _epoch++;
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
  _currentBranch = '';
  _branches = { local: [], remote: [], current: '' };
  closeDropdown();
  // 先藏起来再探：换项目时若留着上一个项目的分支名，用户会拿它当当前分支使
  //（「分支不对、看着像 main」就是这么来的）。探到了下面再显示。
  const btn = $('#gitBtn');
  if (btn) btn.hidden = true;
  checkAndInit(_epoch);
}

/** 检查当前目录是否 git 仓库，决定显示/隐藏按钮 */
async function checkAndInit(epoch = _epoch, attempt = 0) {
  const cwd = _getCwd();
  const btn = $('#gitBtn');
  if (!btn) return;

  if (!cwd) {
    btn.hidden = true;
    return;
  }

  // 请求失败 ≠ 不是 git 仓库。后端冷启动、git 命令偶发超时都会走到这里，
  // 一律隐藏就成了「消失且永不回来」——退避重试几轮再认输。
  const retryOrGiveUp = () => {
    if (attempt < RETRY_DELAYS_MS.length) {
      _retryTimer = setTimeout(() => checkAndInit(epoch, attempt + 1), RETRY_DELAYS_MS[attempt]);
    } else {
      btn.hidden = true;
    }
  };

  let ok = false;
  let data = null;
  try {
    ({ ok, data } = await getJson('/api/git/status?cwd=' + encodeURIComponent(cwd)));
  } catch {
    if (epoch === _epoch) retryOrGiveUp();
    return;
  }
  if (epoch !== _epoch) return; // 过期响应：等待期间已换项目，丢弃
  if (!ok) return retryOrGiveUp(); // 5xx 同样是暂时性故障，不是「非 git 目录」的结论

  if (data?.isGit) {
    _currentBranch = data.currentBranch || '';
    updateButtonLabel();
    btn.hidden = false;
    attachListeners();
  } else {
    btn.hidden = true; // 后端明确答复「不是 git 仓库」：确定结论，不重试
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
  // 浮层已脱离按钮所在的布局流（fixed + 挂在 body 下），窗口尺寸一变就不再对齐按钮
  window.addEventListener('resize', positionDropdown, { signal });
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

/**
 * 把浮层从 .topbar 里挪到 <body> 下（只做一次，幂等）。
 *
 * .topbar 有 `backdrop-filter: blur(8px)`，这一条同时干了两件事：创建层叠上下文，
 * 且成为 fixed 后代的包含块。后果是浮层留在 topbar 里时，它的 z-index 只在 topbar
 * 内部排序——topbar 外任何 z-index>0 的定位元素（如 .fab-row 的 20）都会盖住它，
 * 而且改成 position:fixed 也照样被困在里面。唯一出路就是把节点挪出这个上下文。
 */
function detachDropdown() {
  const dropdown = $('#gitDropdown');
  if (dropdown && dropdown.parentElement !== document.body) {
    document.body.appendChild(dropdown);
  }
  return dropdown;
}

/** 浮层跟随按钮定位（fixed 相对视口），并夹进视口内不越界 */
function positionDropdown() {
  const dropdown = $('#gitDropdown');
  const btn = $('#gitBtn');
  if (!dropdown || !btn || dropdown.hidden) return;

  const r = btn.getBoundingClientRect();
  const w = dropdown.offsetWidth;
  const h = dropdown.offsetHeight;
  const left = Math.max(6, Math.min(r.left, window.innerWidth - w - 6));
  // 下方放不下就翻到按钮上方（分支多时列表能到 400px 高）
  const below = r.bottom + 6;
  const top = below + h > window.innerHeight ? Math.max(6, r.top - 6 - h) : below;
  dropdown.style.left = left + 'px';
  dropdown.style.top = top + 'px';
}

/** 打开下拉菜单，每次重新加载分支列表 */
async function openDropdown() {
  const dropdown = detachDropdown();
  if (!dropdown) return;

  _isOpen = true;
  dropdown.hidden = false;
  positionDropdown();
  _branches = { local: [], remote: [], current: '' };

  await loadBranches();
  positionDropdown(); // 列表渲染后高度变了，重新夹一次，避免长列表溢出视口底部
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
  let switched = false;
  try {
    const { data } = await postJson(
      '/api/git/checkout?cwd=' + encodeURIComponent(cwd),
      { branch },
    );
    if (!data || data.error) {
      toast('切换分支失败：' + (data?.error || '响应异常'));
    } else if (data.ok) {
      _currentBranch = branch; // 乐观更新，回读往返期间标签不空着
      _branches = { local: [], remote: [], current: '' };
      updateButtonLabel();
      toast('已切换到 ' + branch);
      closeDropdown();
      switched = true;
    }
  } catch {
    toast('切换分支失败');
  } finally {
    _isLoading = false;
    // 回读一次 HEAD 复核：远程短名走 git 的 DWIM，真正落地的分支名未必等于请求值，
    // 把请求值直接当结果写死，标签就会和仓库实际状态长期不一致。
    if (switched) checkAndInit();
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

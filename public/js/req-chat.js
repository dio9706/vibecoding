/** 需求聊天装饰层（Task 10）—— 开发/测试期在聊天视图上挂「顶部横幅 + 右侧固定栏」。
 *  经 chat.js 的 bindReqConvHook 在 openConv/newConversation 时挂/卸载；数据自取（GET /api/req/get）。
 *  依赖方向：req-chat → req-view（openRequirement 供阶段流转后重开）→ chat.js，单向无环；
 *  req-view 不感知本模块，chat.js 只认 hook 回调。竞态/轮询纪律对齐 req-view（世代号 + 自杀式清理）。 */
import { $, dirTail, renderMarkdown, fmtTime } from './util.js';
import { confirmDialog } from './ui.js';
import { bindReqConvHook, ensureConvRunAttached, loadReqTranscript, sendMessageProgrammatically } from './chat.js';
import { loadConvs } from './conv-store.js';
import { openRequirement, refreshReqList } from './req-view.js';

/**
 * 开发期首轮 develop 提示词（客户端侧，与 req-logic.js buildDevelopPrompt 保持等值）。
 * data 来自 /api/req/get 响应（含 projects/designGuidelines/apiDocs/devDoc/devCwd）。
 */
function buildDevPrompt(data) {
  const PROJECT_LABELS = { frontend: '前端', backend: '后端' };
  const projects = data.projects || {};
  const roleLines = Object.entries(PROJECT_LABELS)
    .map(([key, label]) => {
      const p = projects[key];
      return p ? `- ${label}工程${p.dev ? '（开发）' : '（只读）'}：${p.dir}` : null;
    })
    .filter(Boolean);
  const docPath = data.devDoc?.versions?.at(-1)?.path || '';
  const parts = [];
  if (roleLines.length) {
    parts.push(`工程角色（本次开发遵守）：\n${roleLines.join('\n')}`);
  }
  parts.push(`开发文档路径：${docPath}（请先完整 Read）`);
  if (data.designGuidelines) parts.push(`设计准则：\n${data.designGuidelines}`);
  if ((data.apiDocs || []).length) {
    parts.push(`后端 API 文档：\n${data.apiDocs.map((d) => `- ${d.name} → ${d.path}`).join('\n')}`);
  }
  parts.push('请按开发文档开始本需求当前可进行的开发；只读参考工程禁止修改。');
  return parts.join('\n\n');
}

let bannerEl = null;
let railEl = null;
let currentReqId = null; // 当前挂载的需求；null = 未挂载
let chromeEpoch = 0; // 世代号：mount/unmount 每次递增，await 之后校验，丢弃过期响应
let busyTimer = null; // busy（或测试期有未终态 bug）期间 3s 轮询
const expandedBugIds = new Set(); // 测试期 BUG 卡展开态：记 id，renderTestRail 重建（轮询整栏重画）据此还原

export function initReqChat() {
  bannerEl = $('#reqBanner');
  railEl = $('#reqRail');
  bindReqConvHook((reqId) => {
    if (reqId) mountReqChrome(reqId);
    else unmountReqChrome();
  });
}

/** 卸载：清容器 + 停轮询 + 撤销消息区让边距 */
export function unmountReqChrome() {
  chromeEpoch++;
  currentReqId = null;
  if (busyTimer) {
    clearInterval(busyTimer);
    busyTimer = null;
  }
  expandedBugIds.clear(); // 换需求：上一个需求展开的 bug id 不该带进下一个
  if (bannerEl) {
    bannerEl.hidden = true;
    bannerEl.innerHTML = '';
  }
  if (railEl) {
    railEl.hidden = true;
    railEl.innerHTML = '';
    railEl.classList.remove('floating');
  }
  document.querySelector('.app')?.classList.remove('req-rail-open');
  closeDocDrawer();
}

/** 存在未终态 bug（pending/fixing）：确认/重试入队后泵最长 5s 才真正置 busy，光等 busy 会错过这段窗口。
 *  doubt&pending（待人工确认，尚未入队）也算在内，会让单标签在无人操作时空转轮询——这是有意取舍：
 *  换来的是多标签页协同（另一标签确认/忽略后本标签 3s 内可见），收紧到只算 sure&pending 反而会
 *  破坏 e2e ⑪ 的前提（doubt 卡要靠这条轮询才能在被直改为 fixing 后自动刷出「修复中」）。 */
function hasActiveBugs(bugs) {
  return (bugs || []).some((b) => b.status === 'pending' || b.status === 'fixing');
}

/** 轮询启动/存续条件：busy 非空；测试期另加"存在未终态 bug"（覆盖泵尚未接手的排队窗口） */
function shouldPoll(data) {
  return !!data.busy || (data.phase === 'test' && hasActiveBugs(data.bugs));
}

/** 挂载/刷新：拉取需求记录后渲染横幅与右栏（同一需求重复触发 = 原地刷新） */
export async function mountReqChrome(reqId) {
  chromeEpoch++;
  const epoch = chromeEpoch;
  // 换需求（含直接从需求 A 切到需求 B、未经 unmountReqChrome）：上一个需求展开的 bug id 不该带进来
  if (reqId !== currentReqId) expandedBugIds.clear();
  currentReqId = reqId;
  let data;
  try {
    const r = await fetch('/api/req/get?id=' + encodeURIComponent(reqId));
    if (!r.ok) {
      // 失败卸载须过 epoch 闸：过期请求（用户已切到需求 B）的迟到失败不能拆 B 刚挂好的 chrome
      if (epoch === chromeEpoch) unmountReqChrome();
      return;
    }
    data = await r.json();
  } catch {
    if (epoch === chromeEpoch) unmountReqChrome();
    return;
  }
  if (epoch !== chromeEpoch) return; // 挂载期间已切走/换需求：丢弃
  // phase 守卫：装饰层只属于开发/测试期。归档后刷新页面会经 claude_last_conv 自动回到需求 conv，
  // 若不拦截会把 archiving/archived 渲染成测试期横幅（按钮点了还报「不允许流转」的无意义错误）。
  if (data.phase !== 'dev' && data.phase !== 'test') return unmountReqChrome();
  renderChrome(data);
  // 自动发 develop 提示词：phase=dev + 会话无实质内容 + 无正在跑的任务 + 有开发文档
  // 每次打开会话时检测；已有内容（历史/已跑过）则跳过，不重复发送
  if (
    data.phase === 'dev' &&
    !data.busy?.kind &&
    data.devDoc?.versions?.length &&
    data.convId
  ) {
    const convList = loadConvs();
    const conv = convList.find((c) => c.id === data.convId);
    const hasContent = conv?.messages?.some((m) => (m.text || '').trim());
    if (!hasContent && epoch === chromeEpoch && currentReqId === reqId) {
      // epoch 二次确认：fetch 期间用户可能切走，避免把消息发到已离开的会话
      sendMessageProgrammatically(buildDevPrompt(data), { mode: 'bypassPermissions' });
    }
  }
  // 系统任务（自动开发等）的 run 由服务端发起，主体聊天区默认不接流 → 只见顶部 busy 芯片、看不到进度。
  // 有进行中的 run（busy.runId）：补种气泡并接管实时流（逐字进度/工具活动/Todo 全可见，且可随时插话）。
  // 无进行中的 run 但已有开发会话：过程可能从没落 localStorage（跑时没人看），从 Claude session 转录回放，
  // 让点开「已完成」需求也能看到开发过程/结果。两者互斥（loadReqTranscript 自带「有实时流/已有内容」护栏）。
  if (data.busy?.runId) ensureConvRunAttached(data.convId, data.busy.runId);
  else if (data.devSession) loadReqTranscript(data.convId, data.devSession, data.devCwd);
  // busy（或测试期有未终态 bug）期间轮询；自杀条件与 req-view 同款
  if (busyTimer) {
    clearInterval(busyTimer);
    busyTimer = null;
  }
  if (shouldPoll(data)) {
    // 自杀分支清「本轮的局部句柄 h」而非模块级 busyTimer：后者可能已被后继需求的新一轮
    // mount 覆盖，误清会掐死别人的轮询（时序上目前安全，但不依赖这份巧合）
    const h = setInterval(async () => {
      if (epoch !== chromeEpoch || currentReqId !== reqId) {
        clearInterval(h);
        if (busyTimer === h) busyTimer = null;
        return;
      }
      try {
        const r = await fetch('/api/req/get?id=' + encodeURIComponent(reqId));
        if (!r.ok) return;
        const d = await r.json();
        if (epoch !== chromeEpoch || currentReqId !== reqId) return;
        // 测试期：fixing/fixed 等中间态需每拍跟进（confirm/retry 入队后泵最长 5s 才置 busy，
        // 光等 busy 落地才刷会让面板在这段窗口定格）；dev 期沿用旧行为，只更新 busy 芯片
        if (d.phase === 'test') renderRail(d);
        renderBusyChip(d.busy);
        // 泵派发晚于进入开发期：busy.runId 可能在 mount 之后才出现，轮询里补接一次（幂等，已接则跳过）
        if (d.busy?.runId) ensureConvRunAttached(d.convId, d.busy.runId);
        if (!shouldPoll(d)) {
          clearInterval(h);
          if (busyTimer === h) busyTimer = null;
          if (d.phase !== 'dev' && d.phase !== 'test') {
            // 与 mountReqChrome 同款 phase 守卫：多标签页场景下，另一标签已把需求流转出
            // 开发/测试期（如测试通过→归档），本标签不能继续把归档数据渲染成测试期横幅
            unmountReqChrome();
          } else if (d.phase !== 'test') {
            renderChrome(d); // dev 期：busy 结束整体刷新一次（测试期上面已按拍刷过）
          }
        }
      } catch {
        /* 瞬时网络失败：下一拍再试 */
      }
    }, 3000);
    busyTimer = h;
  }
}

// ---- 横幅 ----

function renderChrome(data) {
  renderBanner(data);
  renderRail(data);
  document.querySelector('.app')?.classList.add('req-rail-open');
}

function chip(text, cls = '') {
  const el = document.createElement('span');
  el.className = 'req-chip' + (cls ? ' ' + cls : '');
  el.textContent = text;
  return el;
}

function renderBanner(data) {
  bannerEl.innerHTML = '';
  bannerEl.hidden = false;

  const f = data.projects?.frontend;
  const b = data.projects?.backend;
  if (f?.dir) bannerEl.appendChild(chip(`🖥 ${dirTail(f.dir)} · ${f.dev ? '开发' : '只读'}`));
  if (b?.dir) bannerEl.appendChild(chip(`🗄 ${dirTail(b.dir)} · ${b.dev ? '开发' : '只读'}`));

  // 需求文档芯片：点开抽屉看开发文档（终稿），评审产物是开发期的施工蓝图
  const docChip = chip('📄 开发文档', 'clickable');
  docChip.title = '查看开发文档终稿';
  docChip.addEventListener('click', () => openDocDrawer(data.id));
  bannerEl.appendChild(docChip);

  // busy 芯片占位（renderBusyChip 按状态填充/清空）
  const busyChip = document.createElement('span');
  busyChip.className = 'req-chip busy-chip';
  busyChip.hidden = true;
  bannerEl.appendChild(busyChip);
  renderBusyChip(data.busy);

  // 窄屏下右栏收起：横幅出「📚 面板」芯片开浮层（CSS 控制其可见性）
  const railToggle = chip('📚 面板', 'clickable rail-toggle');
  railToggle.addEventListener('click', () => railEl.classList.toggle('floating'));
  bannerEl.appendChild(railToggle);

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  bannerEl.appendChild(spacer);

  // 阶段按钮：dev=完成开发 / test=测试通过（Task 12 交付 BUG 面板，按钮先行——路由已就绪）
  const btn = document.createElement('button');
  btn.className = 'req-phase-btn';
  if (data.phase === 'dev') {
    btn.textContent = '✅ 完成开发';
    btn.addEventListener('click', () =>
      phaseAction(data.id, '/api/req/dev-done', '完成开发后进入测试期，确认吗？', 'remount'));
    bannerEl.appendChild(btn);
  } else if (data.phase === 'test') {
    // 显式分支而非 else 兜底：mountReqChrome 已有 phase 守卫，这里再收紧一道，
    // 防止将来新增阶段被误渲染成「测试通过」按钮
    btn.textContent = '✅ 测试通过';
    btn.addEventListener('click', () =>
      phaseAction(data.id, '/api/req/test-pass', '测试通过后进入归档期（对话将禁用），确认吗？', 'leave'));
    bannerEl.appendChild(btn);
  }
}

const BUSY_KIND_LABELS = { develop: '自动开发', 'api-fix': 'API 对照修正', 'bug-fix': 'BUG 修复', docgen: '文档生成', bitable: '表格巡检' };

function renderBusyChip(busy) {
  const el = bannerEl?.querySelector('.busy-chip');
  if (!el) return;
  if (busy) {
    el.hidden = false;
    el.textContent = `⚙ 系统任务运行中（${BUSY_KIND_LABELS[busy.kind] || busy.kind || '…'}）`;
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}

/** @param {'remount'|'leave'} after 流转成功后的装饰层处置：remount=原地重挂（同 conv 继续聊）；leave=卸载并转文档模式 */
async function phaseAction(id, url, confirmText, after) {
  // confirmDialog 收对象（{title,message,...}），传裸字符串会被解构成全默认值、正文空白
  const ok = await confirmDialog({ title: '阶段流转', message: confirmText });
  if (!ok) return;
  const epoch = chromeEpoch; // 往返期间用户切走 → 结果作废（不把横幅挂到别的会话/不抢导航）
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const d = await r.json().catch(() => ({}));
    if (epoch !== chromeEpoch || currentReqId !== id) return; // 已切走：静默作废
    if (!r.ok) return window.toast.error(d.error || '操作失败');
    window.toast.success('已流转到下一阶段');
    // 不能依赖 openRequirement→openConv 触发钩子刷新：conv 未变时 openConv 会同会话早返回，
    // 钩子不触发，横幅会停留在旧阶段。流转后的装饰层刷新由本模块自己负责：
    // dev→test 仍在同一 conv 上聊天，原地重挂（横幅按钮/右栏随新 phase 重画）；
    // test→archiving 离开聊天模式，先卸载再交 openRequirement 进文档模式（归档表单页）。
    if (after === 'remount') {
      mountReqChrome(id);
      refreshReqList(); // 侧栏阶段徽标立即联动（否则最长等 30s 轮询才由蓝「开发」变紫「测试」）
    } else {
      unmountReqChrome();
      openRequirement(id);
    }
  } catch (e) {
    window.toast.error('网络错误：' + (e?.message || e));
  }
}

// ---- 开发文档抽屉 ----

let _drawerEsc = null; // 抽屉的 Escape 监听：随 closeDocDrawer 统一移除，反复开关不堆积
function closeDocDrawer() {
  document.getElementById('reqDocDrawer')?.remove();
  if (_drawerEsc) {
    document.removeEventListener('keydown', _drawerEsc);
    _drawerEsc = null;
  }
}

/** 点击时现取最新记录再开抽屉：mount 时刻的闭包数据在 busy 结束/refreshRail 之后会变陈旧，
 *  不能直接拿来渲染（devDocLatest 可能已经是几个版本前的旧稿）。 */
async function openDocDrawer(reqId) {
  let data;
  try {
    const r = await fetch('/api/req/get?id=' + encodeURIComponent(reqId));
    if (!r.ok) throw new Error();
    data = await r.json();
  } catch {
    window.toast.error('获取开发文档失败');
    return;
  }
  if (currentReqId !== reqId) return; // 取数期间已切走需求：静默作废，不弹旧需求的文档
  closeDocDrawer();
  const mask = document.createElement('div');
  mask.className = 'req-drawer-mask';
  mask.id = 'reqDocDrawer';
  const panel = document.createElement('div');
  panel.className = 'req-drawer';
  const head = document.createElement('div');
  head.className = 'req-drawer-head';
  const title = document.createElement('b');
  title.textContent = `开发文档（${data.title}）`;
  const close = document.createElement('button');
  close.className = 'q-btn';
  close.textContent = '✕';
  close.addEventListener('click', closeDocDrawer);
  head.append(title, close);
  const body = document.createElement('div');
  body.className = 'req-drawer-body';
  if (data.devDocLatest) renderMarkdown(body, data.devDocLatest);
  else body.textContent = '（无开发文档）';
  panel.append(head, body);
  mask.appendChild(panel);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) closeDocDrawer();
  });
  _drawerEsc = (e) => {
    if (e.key === 'Escape') closeDocDrawer();
  };
  document.addEventListener('keydown', _drawerEsc);
  document.body.appendChild(mask);
}

// ---- 右栏 ----

function renderRail(data) {
  // 草稿保护（与 req-view 补充框同类病防复发）：busy 结束的 renderChrome 会整栏重建，
  // 用户正在编辑、尚未失焦保存的设计准则不能被服务端旧值覆盖。dataset.saved 记录
  // 「最后一次已保存值」，当前值与之不同即视为草稿，重建后原样回填并还原焦点。
  const prevTa = railEl.querySelector('.req-guidelines');
  const draft = prevTa && prevTa.value !== (prevTa.dataset.saved ?? '') ? prevTa.value : null;
  const hadFocus = prevTa && document.activeElement === prevTa;
  // 测试期贴表格输入框同类保护：url 不落库、没有「已保存基线」，非空值即视为未提交草稿——
  // 轮询每 3s 整栏重画一次，不保护的话用户正粘贴到一半的链接会被反复清空
  const prevUrlInput = railEl.querySelector('.req-bitable-form input');
  const urlDraft = prevUrlInput?.value || '';
  const hadUrlFocus = prevUrlInput && document.activeElement === prevUrlInput;
  // 滚动位置同类保护：测试期每 3s 整栏重画一次，不存的话用户滚到的 BUG 列表位置会被拽回顶部
  const scrollTop = railEl.scrollTop;
  railEl.innerHTML = '';
  railEl.hidden = false;
  if (data.phase === 'dev') renderDevRail(data, { draft, hadFocus });
  else if (data.phase === 'test') renderTestRail(data, { urlDraft, hadUrlFocus });
  railEl.scrollTop = scrollTop;
}

function renderDevRail(data, { draft = null, hadFocus = false } = {}) {
  // 渲染时刻的世代号，供下面的异步 handler 判断「回来时用户是否已切走/换了需求」。
  // chromeEpoch 只在 mount/unmount 自增，重绘链路（renderChrome→renderRail→本函数）不动它，
  // 所以捕获渲染时刻的值就是正确的过期判据。
  // ⚠️ 此前 API 文档的上传/删除 handler 直接引用了未声明的 epoch：模块是严格模式，
  // 读未声明绑定会抛 ReferenceError —— 上传路径被 catch 成「上传失败」（其实文件已传完并落库，
  // 只是后续那条让 Claude 对照修正的消息没发出去，表现为「上传了但没生效」），删除路径连 toast 都不弹。
  const epoch = chromeEpoch;
  let pendingReplaceName = null;

  // —— API 文档管理 ——
  const docsSec = document.createElement('div');
  docsSec.className = 'req-rail-sec';
  const docsHead = document.createElement('div');
  docsHead.className = 'req-rail-head';
  const docsTitle = document.createElement('b');
  docsTitle.textContent = `📚 后端 API 文档（${(data.apiDocs || []).length}）`;
  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'q-btn q-btn-text'; // q-btn 是 22px 方钮（为 ✕ 图标设计），带文字会换行 → 叠加文本变体撑开
  uploadBtn.textContent = '＋上传';
  docsHead.append(docsTitle, uploadBtn);
  docsSec.appendChild(docsHead);

  const listBox = document.createElement('div');
  listBox.className = 'req-apidoc-list';
  docsSec.appendChild(listBox);
  // 按状态整行重画（前车之鉴：直改捕获节点在重渲染后失联）
  const paintDocs = (docs, uploadingName) => {
    listBox.innerHTML = '';
    for (const doc of docs) {
      const row = document.createElement('div');
      row.className = 'req-apidoc-item';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = doc.name;
      name.title = `${doc.name} · 更新于 ${fmtTime(doc.updatedAt)}`;
      const replace = document.createElement('button');
      replace.className = 'q-btn';
      replace.textContent = '🔄';
      replace.title = '替换（选择新文件上传）';
      replace.addEventListener('click', () => {
        pendingReplaceName = doc.name;
        fileInput.click();
      });
      const del = document.createElement('button');
      del.className = 'q-btn';
      del.textContent = '✕';
      del.title = '删除（将自动对照修正代码）';
      del.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: '删除 API 文档',
          message: `删除「${doc.name}」？删除后将自动对照修正相关代码。`,
          danger: true,
        });
        if (!ok) return;
        // 整段包 try：这里任何异常都会变成未捕获 rejection —— 既不弹 toast 也不刷新右栏，
        // 服务端已删掉的文档在界面上却一直挂着，用户完全无从判断发生了什么。
        try {
          const r = await fetch('/api/req/apidoc', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: data.id, docId: doc.id }),
          }).catch(() => null);
          const d = r ? await r.json().catch(() => ({})) : {};
          if (!r || !r.ok) return window.toast.error(d.error || '删除失败');
          // 需求级别事件：检查在此期间用户是否切换了需求
          if (epoch !== chromeEpoch || currentReqId !== data.id) {
            // 用户已切走，不发送消息到错误的会话
            return;
          }
          // 自动发 api-fix 消息
          const delText = `后端 API 文档「${d.doc?.name || doc.name}」已删除\n\n请对照该 API 文档变更，检查并修正本需求已实现代码中所有相关调用。`;
          // 会话没就绪时 sendMessageProgrammatically 会静默 return，消息凭空消失且无任何提示，
          // 所以先显式校验（与设计准则「确认发送」同款守卫）
          if (!data.convId) window.toast.error('会话未就绪，请重新打开需求后手动告知 Claude');
          else sendMessageProgrammatically(delText, { mode: 'bypassPermissions' });
        } catch (e) {
          window.toast.error('API 文档删除失败：' + (e?.message || e));
        }
        refreshRail(data.id);
      });
      row.append(name, replace, del);
      listBox.appendChild(row);
    }
    if (uploadingName) {
      const row = document.createElement('div');
      row.className = 'req-apidoc-item uploading';
      row.textContent = `⏳ ${uploadingName} 上传中…`;
      listBox.appendChild(row);
    }
    if (!docs.length && !uploadingName) {
      const empty = document.createElement('div');
      empty.className = 'req-rail-empty';
      empty.textContent = '（暂无，上传后自动对照修正实现）';
      listBox.appendChild(empty);
    }
  };
  paintDocs(data.apiDocs || []);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.hidden = true;
  docsSec.appendChild(fileInput);
  uploadBtn.addEventListener('click', () => {
    pendingReplaceName = null;
    fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const reqId = data.id;
    paintDocs(data.apiDocs || [], file.name);
    try {
      const up = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
      const ud = await up.json();
      if (!ud.path) throw new Error(ud.error || '上传失败');
      const r = await fetch('/api/req/apidoc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId, name: pendingReplaceName || file.name, path: ud.path }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '登记失败');
      // 需求级别事件：检查在此期间用户是否切换了需求
      if (epoch !== chromeEpoch || currentReqId !== reqId) {
        // 用户已切走，不发送消息到错误的会话
        return;
      }
      // 自动发 api-fix 消息：让 Claude 对照新文档修正代码。
      // 服务端自 2026-08-05 会话化重构后不再 enqueue api-fix 系统任务，这条消息是新文档的唯一消费入口，
      // 发不出去就等于「上传了但没人看」——所以会话未就绪时必须显式报错，不能让它静默消失。
      const apiFixText = d.action === '删除'
        ? `后端 API 文档「${d.doc?.name}」已删除\n\n请对照该 API 文档变更，检查并修正本需求已实现代码中所有相关调用。`
        : `后端 API 文档「${d.doc.name}」已${d.action}（路径 ${d.doc.path}，请先 Read）\n\n请对照该 API 文档变更，检查并修正本需求已实现代码中所有相关调用。`;
      if (!data.convId) {
        window.toast.error('文档已保存，但会话未就绪，请重新打开需求后手动告知 Claude');
      } else {
        sendMessageProgrammatically(apiFixText, { mode: 'bypassPermissions' });
        window.toast.success('已入队自动修正');
      }
    } catch (e) {
      window.toast.error('API 文档上传失败：' + (e?.message || e));
    }
    refreshRail(reqId);
    pendingReplaceName = null;
  });

  railEl.append(docsSec);
}

/** 右栏局部刷新（apidoc 增删后）：只重拉记录重画右栏与横幅 busy 芯片，不动聊天区 */
async function refreshRail(reqId) {
  const epoch = chromeEpoch;
  try {
    const r = await fetch('/api/req/get?id=' + encodeURIComponent(reqId));
    if (!r.ok) return;
    const d = await r.json();
    if (epoch !== chromeEpoch || currentReqId !== reqId) return; // 挂载已易主：丢弃
    renderRail(d);
    renderBusyChip(d.busy);
  } catch {
    /* 瞬时失败：右栏维持旧态 */
  }
}

// ---- 测试期 BUG 面板（Task 12） ----

/** pending 态按 verdict 细分文案（sure=自动排队/doubt=待人工确认），其余态与 status 一一对应 */
const BUG_STATUS_TEXT = { fixing: '修复中', fixed: '已修复', ignored: '已忽略', failed: '修复失败' };
function bugBadgeText(bug) {
  if (bug.status === 'pending') return bug.verdict === 'doubt' ? '待确认' : '待修复·排队中';
  return BUG_STATUS_TEXT[bug.status] || bug.status;
}
function bugBadgeClass(bug) {
  if (bug.status === 'pending') return bug.verdict === 'doubt' ? 'st-pending-doubt' : 'st-pending-sure';
  return 'st-' + bug.status;
}

/** confirm/ignore/retry 共用：防连点禁用涉事按钮 → POST → 校验易主 → 成功 toast + 重挂接管轮询。
 *  已知的良性竞态：本次点击与轮询的某一拍在网络上重叠时，若那一拍拿到的是操作生效前的旧数据，
 *  它的 renderRail 重建可能会让刚被禁用的按钮短暂"复活"（非禁用态）。真被误触发第二次操作，
 *  后端状态机会拒绝不合法的状态转移（409），本函数已按 !r.ok 分支处理，不会造成重复修复/脏状态。 */
async function runBugAction(reqId, bugId, url, okMsg, btns) {
  const epoch = chromeEpoch;
  btns.forEach((b) => (b.disabled = true));
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: reqId, bugId }),
    });
    const d = await r.json().catch(() => ({}));
    if (epoch !== chromeEpoch || currentReqId !== reqId) return; // 已切走：静默作废
    if (!r.ok) {
      window.toast.error(d.error || '操作失败');
      btns.forEach((b) => (b.disabled = false));
      return;
    }
    window.toast.success(okMsg);
    // confirm/retry 会入队 bug-fix（泵最长 5s 才真正置 busy）：重挂而非局部 refreshRail，
    // 让 mountReqChrome 按最新 bugs 状态重新判定 shouldPoll，确保轮询在需要时真正接管
    mountReqChrome(reqId);
  } catch (e) {
    if (epoch !== chromeEpoch || currentReqId !== reqId) return;
    window.toast.error('网络错误：' + (e?.message || e));
    btns.forEach((b) => (b.disabled = false));
  }
}

/** 单张 BUG 卡：verdict 边框色 + 状态徽标；点卡片展开/收起 detail；按 verdict/status 挂确认/忽略/重试按钮 */
function renderBugCard(reqId, bug) {
  const card = document.createElement('div');
  card.className = `req-bug-card verdict-${bug.verdict}`;

  const head = document.createElement('div');
  head.className = 'req-bug-head';
  const title = document.createElement('span');
  title.className = 'req-bug-title';
  title.textContent = bug.title;
  const badge = document.createElement('span');
  badge.className = 'req-bug-badge ' + bugBadgeClass(bug);
  badge.textContent = bugBadgeText(bug);
  head.append(title, badge);
  card.appendChild(head);

  if (bug.verdict === 'doubt' && bug.status === 'pending' && bug.reason) {
    const reason = document.createElement('div');
    reason.className = 'req-bug-reason';
    reason.textContent = bug.reason;
    card.appendChild(reason);
  }

  const detail = document.createElement('div');
  detail.className = 'req-bug-detail';
  detail.textContent = bug.detail || '';
  // 展开态记在模块级 expandedBugIds（而非局部变量）：轮询每 3s 整栏重画一次，
  // 不这样做的话用户正看着的 detail 会被反复收起
  detail.hidden = !expandedBugIds.has(bug.id);
  card.appendChild(detail);
  if (bug.detail) {
    card.classList.add('clickable'); // 无 detail 的卡片不给指针也不可展开（nit）
    card.addEventListener('click', () => {
      if (expandedBugIds.has(bug.id)) expandedBugIds.delete(bug.id);
      else expandedBugIds.add(bug.id);
      detail.hidden = !expandedBugIds.has(bug.id);
    });
  }

  // 待确认（doubt&pending）：确认修复/忽略；修复失败：重试/忽略；其余状态无按钮
  let actions = [];
  if (bug.verdict === 'doubt' && bug.status === 'pending') {
    actions = [
      ['确认修复', '/api/req/bug/confirm', '已确认，入队修复'],
      ['忽略', '/api/req/bug/ignore', '已忽略'],
    ];
  } else if (bug.status === 'failed') {
    actions = [
      ['重试', '/api/req/bug/retry', '已重试，入队修复'],
      ['忽略', '/api/req/bug/ignore', '已忽略'],
    ];
  }
  if (actions.length) {
    const bar = document.createElement('div');
    bar.className = 'req-bug-actions';
    const btns = actions.map(([label]) => {
      const btn = document.createElement('button');
      btn.className = 'btn-sm';
      btn.textContent = label;
      bar.appendChild(btn);
      return btn;
    });
    actions.forEach(([, url, okMsg], i) => {
      btns[i].addEventListener('click', (e) => {
        e.stopPropagation(); // 不冒泡到卡片的 detail 展开/收起
        runBugAction(reqId, bug.id, url, okMsg, btns);
      });
    });
    card.appendChild(bar);
  }

  return card;
}

function renderTestRail(data, { urlDraft = '', hadUrlFocus = false } = {}) {
  const bugs = data.bugs || [];
  const busy = data.busy || null;

  // —— 贴表格巡检 ——
  const patrolSec = document.createElement('div');
  patrolSec.className = 'req-rail-sec';
  const patrolHead = document.createElement('div');
  patrolHead.className = 'req-rail-head';
  const patrolTitle = document.createElement('b');
  patrolTitle.textContent = `🐞 BUG 面板（${bugs.length}）`;
  patrolHead.appendChild(patrolTitle);
  patrolSec.appendChild(patrolHead);

  const form = document.createElement('div');
  form.className = 'req-bitable-form';
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = '粘贴多维表格链接…';
  urlInput.value = urlDraft; // 回填未提交草稿（重建/轮询整栏重画不清空用户正粘贴的内容）
  const startBtn = document.createElement('button');
  startBtn.className = 'btn-sm';
  startBtn.textContent = '开始巡检';
  form.append(urlInput, startBtn);
  patrolSec.appendChild(form);
  if (hadUrlFocus) requestAnimationFrame(() => urlInput.focus());

  if (busy) {
    const label = BUSY_KIND_LABELS[busy.kind] || busy.kind || '…';
    urlInput.disabled = true;
    startBtn.disabled = true;
    urlInput.title = startBtn.title = `系统任务运行中（${label}），请稍候`;
  }

  startBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return window.toast.error('请先粘贴多维表格链接');
    const reqId = data.id;
    const epoch = chromeEpoch;
    urlInput.disabled = true;
    startBtn.disabled = true;
    try {
      const r = await fetch('/api/req/bitable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId, url }),
      });
      const d = await r.json().catch(() => ({}));
      if (epoch !== chromeEpoch || currentReqId !== reqId) return; // 已切走：静默作废
      if (!r.ok) {
        window.toast.error(d.error || '启动巡检失败');
        urlInput.disabled = false;
        startBtn.disabled = false;
        return;
      }
      window.toast.success('已开始巡检');
      // busy 芯片/轮询接管；巡检结束后 renderChrome 会自动重画本面板，此处无需再管
      mountReqChrome(reqId);
    } catch (e) {
      if (epoch !== chromeEpoch || currentReqId !== reqId) return;
      window.toast.error('网络错误：' + (e?.message || e));
      urlInput.disabled = false;
      startBtn.disabled = false;
    }
  });

  // —— BUG 列表（按 at 倒序）——
  const listSec = document.createElement('div');
  listSec.className = 'req-rail-sec';
  if (!bugs.length) {
    const empty = document.createElement('div');
    empty.className = 'req-rail-empty';
    empty.textContent = '贴入多维表格链接开始巡检，确定的 BUG 将自动修复，疑问的等你确认';
    listSec.appendChild(empty);
  } else {
    const sorted = [...bugs].sort((a, b) => new Date(b.at) - new Date(a.at));
    for (const bug of sorted) listSec.appendChild(renderBugCard(data.id, bug));
  }

  railEl.append(patrolSec, listSec);
}

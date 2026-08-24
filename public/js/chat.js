// chat.js —— 聊天体（2026-07-24 壳/体反转切分自 app.js）：状态区 / UI 偏好 / 对话历史 / 消息模型与渲染 / 打字机 / 额度 / 发送与流 / 待续跑轮询
import { toast, confirmDialog, promptDialog } from './ui.js';
import { $, debounce, renderMarkdown, lsSet } from './util.js';
import { getPromptText, clearPrompt, handleDrop, insertDroppedPaths } from './composer.js';
import {
  loadConvs, saveConvs, flushConvs,
  convPushMessage, convSetMessage, convSetSession, convSetMsgFields,
  moveMessageToEnd, removeMessageAt, bubbleReset, bubblePush, bubbleGet,
  convSetTitle, convSetMeta, convDelete,
} from './conv-store.js';
import { bindDirPopover, closeDirModal } from './dir-popover.js';
import { AnimeAnimations } from './anim.js';
import { registerDropZone } from './drag-bus.js';
bindDirPopover({ getCwd: () => cwd, selectDir }); // 惰性读 cwd 无 TDZ；selectDir 已提升
// Tauri 桌面版：文件/目录拖入直接插本地路径 chip，无需上传副本。
// 走拖拽总线而非旧的单槽位 bindTauriDrop——Markdown 查看器也要注册，单槽位会互相覆盖。
// Web 模式下总线永不触发（tauri://drag-* 不存在），HTML5 + 上传副本路线继续生效。
{
  const promptZoneEl = document.querySelector('#prompt');
  if (promptZoneEl) {
    registerDropZone({
      el: promptZoneEl,
      onDragOver: () => promptZoneEl.classList.add('dragover'),
      onDragLeave: () => promptZoneEl.classList.remove('dragover'),
      onDrop: (paths, pt) => {
        promptZoneEl.classList.remove('dragover');
        // 光标移到落点，附件插在拖放位置（与旧 HTML5 版行为保持一致）
        const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(pt.x, pt.y) : null;
        if (r && promptZoneEl.contains(r.startContainer)) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        }
        // 这是唯一一处 fire-and-forget 调用，兜在这里而不是塞进 insertDroppedPaths 内部：
        // 后者保留 rejection 语义，将来有 await 的调用方才拿得到失败原因
        insertDroppedPaths(paths).catch((err) => console.error('[Drop] 插入路径 chip 失败:', err));
      },
    });
  }
}
// 视图桥：壳注入「回聊天视图」跳转，体内 5 处原直调改经 _goChat()
let _goChat = () => {};
// 视图桥：聊天视图是否当前激活（供 refreshAskChip 判定，避免反向依赖 app.js 的 activeView）
let _isChatViewActive = () => true;
export function bindChatNav(goChat, isActiveFn) {
  _goChat = goChat;
  if (isActiveFn) _isChatViewActive = isActiveFn;
}
// 视图桥：需求会话钩子（Task 10）——切到/离开需求 conv 时通知 req-chat.js 挂/卸载横幅右栏
let _reqConvHook = null;
export function bindReqConvHook(fn) { _reqConvHook = fn; }

      // ============================================================
      // 页面逻辑
      // ============================================================

      const messagesEl = $('#messages');
      const emptyEl = $('#empty');
      const promptEl = $('#prompt');
      const sendBtn = $('#sendBtn');
      const stopBtn = $('#stopBtn');

      // ---- DOM 上限控制（防长会话卡顿）----
      const MAX_DOM_MESSAGES = 300; // 单会话保留最多 300 条「完整渲染」的气泡，更早的折叠为占位

      /**
       * 折叠一条早期气泡：清空渲染内容、保留节点本身。
       * 保留节点是刚性要求 —— 全模块靠「存储索引 = DOM 索引」定位气泡，删节点会让索引整体错位。
       * 清空内容才是真正省内存的那一步（markdown 渲染树往往比原文大一个数量级）。
       */
      function collapseBubble(el) {
        if (!el || el.classList.contains('collapsed')) return;
        const text = el.textContent || '';
        el.classList.add('collapsed');
        el.replaceChildren(); // 丢掉整棵渲染子树
        el.textContent = text.slice(0, 80) + (text.length > 80 ? '…' : '');
        el.title = '较早的消息，已折叠以节省内存';
      }

      // ---- 状态 ----
      // 一窗一项目：项目上下文来源——桌面版经 Rust initialization_script 注入全局
      // （打包版 custom protocol 下 URL query 会致新窗白屏）；web 版走 URL ?cwd=&conv=。前者优先。
      const _qs = new URLSearchParams(location.search);
      const _urlCwd = typeof window.__PROJECT_CWD__ === 'string' ? window.__PROJECT_CWD__ : _qs.get('cwd');
      const _urlConv = typeof window.__PROJECT_CONV__ === 'string' ? window.__PROJECT_CONV__ : _qs.get('conv');
      let cwd = _urlCwd != null ? _urlCwd : (localStorage.getItem('claude_cwd') || ''); // 空=服务目录
      let currentSession = null;
      const runningJobs = {}; // convId -> { es, asstIndex, text }：并行运行中的会话
      // 磁盘历史会话缓存（合并进左侧栏统一列表；读的是磁盘上所有 Claude Code 会话）
      let historyCache = null; // 缓存历史列表，避免频繁请求
      let historyCacheExpire = 0;
      // 模型 / effort / 权限模式
      let chatModel = localStorage.getItem('claude_model') || 'auto';
      let chatEffort = localStorage.getItem('claude_effort') || 'medium';
      let chatMode = localStorage.getItem('claude_mode') || 'default'; // default|acceptEdits|plan|bypassPermissions
      let chatProvider = localStorage.getItem('claude_provider') || 'claude-agent';
      let chatDisabledTools = JSON.parse(localStorage.getItem('claude_disabled_tools') || '[]');
      let chatCustomModel = localStorage.getItem('claude_custom_model') || '';
      let chatCustomLabel = localStorage.getItem('claude_custom_label') || '';
      // 选中的自定义凭证 id。**必须随请求带上**：服务端此前只收 model，凭证靠
      // pickActive 取「第一个可用的 openai-compat」，于是多厂商共存时必然串台——
      // 点智谱发出 model=glm-4，却配上 DeepSeek 的 apiKey/baseURL，请求打到
      // api.deepseek.com 要一个 glm-4，必然失败。model 相同的多条凭证也无从区分。
      let chatCustomCredId = localStorage.getItem('claude_custom_cred_id') || '';
      let chatActiveTokenLabel = ''; // 当前激活 token 的名称，由 initUiPrefs 从服务端填充

      // ---- UI 偏好持久化（服务端 settings.json，跨重启/跨浏览器） ----
      let _saveUiPrefsTimer = null;
      /** 将当前 cwd / model / effort / mode 写入服务端配置（300ms 防抖） */
      function saveUiPrefs() {
        clearTimeout(_saveUiPrefsTimer);
        _saveUiPrefsTimer = setTimeout(() => {
          fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ section: 'ui-prefs', defaultCwd: cwd, model: chatModel, effort: chatEffort, mode: chatMode, disabledTools: chatDisabledTools }),
          }).catch(() => {}); // 静默失败：localStorage 已有副本，不影响使用
        }, 300);
      }
      // 会话是否已接管 cwd/模型/强度/模式：一旦打开过会话，全局默认偏好就不得再覆盖它们。
      // 详见 initUiPrefs 里的启动竞态说明。
      let _prefsOwnedByConv = false;

      /**
       * 启动时从服务端加载 UI 偏好，并以服务端值（非默认值时）覆盖 localStorage。
       * 策略：服务端显式设过的值优先（跨重启恢复）；服务端仍是默认值时保留 localStorage（兼容升级前已有偏好）。
       */
      async function initUiPrefs() {
        // 启动竞态守卫：initChat 里 `setTimeout(() => openConv(c.id), 0)` 必然早于这次网络往返，
        // 而 openConv 会把 cwd/模型/强度/模式还原成**该会话自己的**值。
        // 后到的全局默认值若照单覆盖，表现就是「刷新回到会话 A，目录标签随后跳成 B，
        // 此后在 A 会话里发的消息实际在 B 目录执行」——数据面事故，不只是显示错乱。
        // 注意两点：① _urlCwd 只在项目窗口有值，主窗口没有这层保护；
        // ② 光比对快照不够——initChat 仅在 `c.cwd === cwd` 时才开会话，
        //    此时 cwd 没变化，快照比对会误判为「没人动过」。故用显式归属标记。
        const snap = { cwd, chatModel, chatEffort, chatMode };
        try {
          const r = await fetch('/api/settings');
          if (!r.ok) return;
          const data = await r.json();
          // 缓存当前激活 token 的名称，用于对话气泡的发送者标签
          if (data.active && data.active.label) chatActiveTokenLabel = data.active.label;
          const prefs = data.uiPrefs || {};
          let changed = false;
          // URL 定向的项目窗口不被全局默认目录覆盖（一窗一项目）
          if (_urlCwd == null && !_prefsOwnedByConv && cwd === snap.cwd && prefs.defaultCwd && prefs.defaultCwd !== cwd) {
            cwd = prefs.defaultCwd;
            lsSet('claude_cwd', cwd);
            changed = true;
          }
          if (!_prefsOwnedByConv && chatModel === snap.chatModel && prefs.model && prefs.model !== 'auto' && MODEL_LABELS[prefs.model] && prefs.model !== chatModel) {
            chatModel = prefs.model;
            lsSet('claude_model', chatModel);
            changed = true;
          }
          if (!_prefsOwnedByConv && chatEffort === snap.chatEffort && prefs.effort && prefs.effort !== 'medium' && EFFORTS.includes(prefs.effort) && prefs.effort !== chatEffort) {
            chatEffort = prefs.effort;
            lsSet('claude_effort', chatEffort);
            changed = true;
          }
          if (!_prefsOwnedByConv && chatMode === snap.chatMode && prefs.mode && prefs.mode !== 'default' && MODES.includes(prefs.mode) && prefs.mode !== chatMode) {
            chatMode = prefs.mode;
            lsSet('claude_mode', chatMode);
            changed = true;
          }
          if (changed) { refreshDirLabel(); syncModelUI(); }
          // 加载服务端持久化的禁用工具列表（覆盖 localStorage，保持跨重启一致）
          if (Array.isArray(prefs.disabledTools)) {
            chatDisabledTools = prefs.disabledTools;
            lsSet('claude_disabled_tools', JSON.stringify(chatDisabledTools));
          }
        } catch (e) {
          console.warn('[initUiPrefs] 加载失败，使用 localStorage 值:', e);
        }
      }

      // ---- 工作目录标签 ----
      function baseName(p) {
        if (!p) return '服务目录';
        const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
        return parts[parts.length - 1] || p;
      }
      function refreshDirLabel() {
        $('#dirLabel').textContent = baseName(cwd);
        $('#dirLabel').title = cwd || '(服务所在目录)';
        syncWindowTitle();
      }
      // 窗口标题 = 项目名：无边框窗口没有可见标题栏，这个标题只在任务栏/Alt-Tab 里出现，
      // 多开项目窗口时用来区分是哪个项目（非 Tauri 环境退化为改 document.title，浏览器标签同样受益）。
      function syncWindowTitle(retry = 0) {
        const name = baseName(cwd);
        document.title = name;
        const api = window.tauriApi;
        if (api?.isTauri && api.invoke) {
          api.invoke('win_set_title', { title: name }).catch((e) => {
            console.warn('[WinTitle] win_set_title 失败:', e?.message || e);
          });
          return;
        }
        // window.tauriApi 由 tauri-init 的异步 IIFE 产出（内含 CDN import，可能晚于这里），
        // 桌面环境下重试几次，否则标题会停在 Rust 给的初始值。
        // 重试时重新读 cwd，所以晚到的回调也只会写当前项目名，不会覆盖成旧值。
        if (typeof window.__TAURI_INTERNALS__ !== 'undefined' && retry < 5) {
          setTimeout(() => syncWindowTitle(retry + 1), 400);
        }
      }

      // 拉取磁盘历史会话列表（5s 内存缓存）；成功写 historyCache，失败返回 null
      async function loadHistorySessions() {
        if (historyCache && Date.now() < historyCacheExpire) return historyCache;
        try {
          // 带上当前工作目录：历史跟随目录（空 cwd = 服务目录）
          const json = await (
            await fetch('/api/history?cwd=' + encodeURIComponent(cwd))
          ).json();
          if (!json.ok) {
            console.error('读取历史会话失败:', json.error);
            return null;
          }
          const data = json.data || [];
          historyCache = data;
          historyCacheExpire = Date.now() + 5000;
          return data;
        } catch (err) {
          console.error('读取历史会话失败:', err);
          return null;
        }
      }
      // 续接一条磁盘历史会话：去重 → 拉取详情 → 新建本地上下文 → 展示+落库消息
      async function resumeHistorySession(sessionId) {
        _goChat();
        // 去重：若本地已有同 session 的会话，直接打开它，避免重复建条
        const existing = loadConvs().find((c) => c.session === sessionId);
        if (existing) {
          openConv(existing.id);
          return;
        }
        try {
          const json = await (
            await fetch(
              '/api/history/' + encodeURIComponent(sessionId) + '?cwd=' + encodeURIComponent(cwd),
            )
          ).json();
          if (!json.ok) {
            toast('加载历史会话失败：' + (json.error || '未知错误'));
            return;
          }
          const session = json.data;
          // CLI 历史：还原其模型与询问模式（CLI 模型 ID 不在 web 白名单内则忽略；无 effort 概念）
          applySessionPrefs({ model: session.model, mode: session.permissionMode });
          // 离开旧会话前清理其气泡缓存 —— openConv / newConversation 都做了，唯独这条路径漏了，
          // 结果是每次点磁盘历史会话都把上一个会话的整棵气泡树留在 _bubbleMap 里成为 detached 泄漏
          // （正是 commit 6cff831「根治内存泄漏」想修的那一类，属遗漏点）。
          if (currentConvId) bubbleReset(currentConvId);
          currentConvId = 'hist_' + Date.now().toString(36);
          markConvUsed(currentConvId); // 续接历史 = 本次使用过
          lsSet('claude_last_conv', currentConvId); // 刷新后自动回到该会话
          currentSession = sessionId; // 后续发送靠此 sessionId 走 SDK resume 续接
          messagesEl.querySelectorAll('.msg').forEach((m) => m.remove());
          const msgs = session.messages || [];
          if (msgs.length) emptyEl.style.display = 'none';
          // 同时展示 + 落库（照普通发送流程：addMessage 展示、recordMessage 落库）。
          // 注意字段名：recordMessage 形参是 text，需把 msg.content 传入；首条 user 消息会由 recordMessage 设出标题。
          for (const msg of msgs) {
            await addMessage(msg.role, msg.content);
            recordMessage(msg.role, msg.content);
          }
          // 注意：不要往 messages 里塞无 DOM 的标记消息 —— paintJob 靠「存储索引=DOM 索引」找气泡，
          // 任何只落库不上屏的消息都会让后续流式输出画到不存在的气泡上（曾致气泡永远空白）
          historyCacheExpire = 0; // 续接后失效列表缓存，下次打开重新拉取
          updateComposerRunning();
          // 这条路径不走 openConv，漏掉就会让收件箱轮询继续盯着上一个会话（放在此处才保证 currentConvId 已切）
          if (window.__convNotify) window.__convNotify.onConvOpened(currentConvId);
        } catch (err) {
          console.error('续接历史会话失败:', err);
          toast('续接历史会话失败');
        }
      }

      // ---- 对话历史（localStorage 持久化，展示于左侧栏）----


      let currentConvId = null;
      let diskLoadFailed = false; // 磁盘历史是否拉取失败（用于错误态提示）
      // 侧栏加载范围：'used' = 仅本次使用过 + 当前活跃；数字 N = 额外显示最近 N 天（0=今日，1=含昨天…）
      let historyRange = 'used';
      // 本次打开程序后「使用过」的会话 id 集合（不持久化，刷新即清空 = 本次会话语义）
      const usedConvIds = new Set();
      function markConvUsed(id) { if (id) usedConvIds.add(id); }
      // 合并本地会话(localStorage) + 磁盘会话(historyCache)，按 sessionId 去重，排序并按搜索词过滤。
      // 一窗一项目：只显示 cwd 匹配本窗目录的会话（其他项目在各自窗口，切目录=开新窗）。
      // 返回统一条目：{ source:'local'|'web', convId, sessionId, title, updatedAt, running, active }
      function buildMergedHistory() {
        const convs = loadConvs();
        const curCwd = cwd || '';
        const entries = [];
        const localSessions = new Set(); // 仅收可见本地会话的 session，用于磁盘去重
        for (const c of convs) {
          const isRunning = !!runningJobs[c.id];
          // 一窗一项目：非本窗目录的会话不显示（含运行中——本窗 runningJobs 只含本窗 cwd 的 run，天然不会误伤）
          if ((c.cwd || '') !== curCwd && !isRunning) continue;
          // 必须先登记 session，再判断是否为需求 conv 而跳过——否则需求 conv 的 session
          // 不会进 localSessions，磁盘会话去重会漏判，导致它以「磁盘历史会话」身份重新漏回普通列表。
          if (c.session) localSessions.add(c.session);
          // 需求 conv（createReqConv 产生，meta.reqId 打标）走侧栏「本次需求」列表，不进普通会话列表；
          // 其 session 已在上面登记进 localSessions——否则同 session 会以磁盘历史身份漏回本列表
          if (c.meta && c.meta.reqId) continue;
          entries.push({
            source: 'local',
            convId: c.id,
            sessionId: c.session || null,
            title: c.title || '未命名对话',
            updatedAt: c.updatedAt || 0,
            running: isRunning,
            active: c.id === currentConvId && _isChatViewActive(),
            pinned: c.pinned || false,
          });
        }
        // 磁盘会话（接口按当前目录拉取 → 恒属当前项目）：已有可见本地缓存的跳过（去重）
        for (const s of historyCache || []) {
          if (localSessions.has(s.sessionId)) continue;
          entries.push({
            source: 'web',
            convId: null,
            sessionId: s.sessionId,
            title: s.title || '未命名对话',
            updatedAt: s.updatedAt || 0,
            running: false,
            active: false,
          });
        }
        entries.sort((a, b) => b.updatedAt - a.updatedAt);
        return entries;
      }
      // ts 是否落在最近 n 天内（本地自然日边界）：n=0=今天；n=1=含昨天……
      function isWithinDays(ts, n) {
        if (!ts) return false;
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - n); // n 天前的 0 点
        return ts >= start.getTime();
      }
      // 由一条合并历史条目构造左栏行元素（三段渲染共用）
      function makeConvRow(e) {
        const row = document.createElement('div');
        row.className =
          'conv-item' +
          (e.active ? ' active' : '') +
          (e.running ? ' running' : '') +
          (e.pinned ? ' user-pinned' : '');
        row.dataset.convId = e.convId;
        row.dataset.sessionId = e.sessionId || '';
        row.dataset.pinned = e.pinned ? '1' : '';
        // 钉住图标（用户手动置顶时显示）
        if (e.pinned) {
          const pinIc = document.createElement('span');
          pinIc.className = 'conv-pin-ic';
          pinIc.title = '已钉住';
          pinIc.innerHTML = '<svg viewBox="0 0 1024 1024" width="11" height="11" fill="currentColor"><path d="M574.4 192l-64 192H320l64-64-128-192 192 64-64 64 192-64zM832 576L640 384l-128 192 128 64-192 320 64-256-64-128 192 64z"/></svg>';
          row.appendChild(pinIc);
        }
        const title = document.createElement('span');
        title.className = 'conv-title';
        // 标题文字（flex 子元素，超长截断）
        const titleText = document.createElement('span');
        titleText.className = 'title-text';
        titleText.textContent = e.title;
        title.appendChild(titleText);
        titleText.dataset.convId = e.convId; // 便于后续查找
        // running 时对 titleText 启动扫描 cursor 动画。
        // 全局 ticker 架构：重渲染时旧元素离 DOM 会被 _scanTick 自动清理，
        // 新元素注册后按全局时钟相位续扫，无需手动转移状态。
        if (e.running) {
          if (typeof AnimeAnimations !== 'undefined') {
            AnimeAnimations.startCursorLoop(titleText);
          } else {
            // 首帧渲染时 AnimeAnimations（脚本尾部定义）可能还不存在，标记待绑定
            titleText._pendingCursor = true;
          }
        }
        // onclick 挂 row（整行），与 cursor:pointer 语义一致——任何位置点击都切换会话，
        // 避免"点标题右侧空白区域无反应但光标已是手型"的视觉歧义（原挂 title 的问题）。
        row.onclick = () =>
          e.source === 'local' ? openConv(e.convId) : resumeHistorySession(e.sessionId);
        row.appendChild(title);
        // 右侧 info 图标：hover 展示时间（缺少 updatedAt 则不渲染）
        if (e.updatedAt && e.updatedAt > 0) {
          const infoWrap = document.createElement('span');
          infoWrap.className = 'conv-info';
          const infoImg = document.createElement('span');
          infoImg.className = 'conv-info-icon';
          infoImg.innerHTML = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M512 64c126.72 3.328 232.192 47.168 316.48 131.456C912.832 279.872 956.672 385.344 960 512c-3.328 126.72-47.168 232.192-131.52 316.48C744.192 912.832 638.72 956.672 512 960c-126.72-3.328-232.192-47.168-316.544-131.52C111.232 744.192 67.392 638.72 64 512c3.328-126.72 47.168-232.192 131.456-316.544C279.872 111.232 385.344 67.392 512 64z m67.008 275.008a61.44 61.44 0 0 0 43.008-15.488c11.328-10.304 17.024-24.128 17.024-41.472s-5.696-31.232-17.024-41.536a60.672 60.672 0 0 0-42.496-15.488 60.672 60.672 0 0 0-42.496 15.488c-11.328 10.304-16.96 24.192-16.96 41.536 0 17.28 5.632 31.168 16.96 41.472a60.032 60.032 0 0 0 41.984 15.488z m12.032 360c0-4.032 0.32-9.344 0.96-16 0.64-6.656 0.64-12.992 0-19.008l-52.992 60.992c-5.312 6.016-10.88 10.688-16.512 14.016-5.696 3.328-10.496 4.352-14.464 3.008-6.016-2.688-8.704-7.36-8-14.016l88-276.992c3.264-18.688 0.32-34.688-9.024-48-9.344-13.312-24.32-21.312-44.992-24-23.36 0.64-48.832 10.496-76.48 29.504-27.712 19.008-51.84 43.2-72.512 72.512v14.976c-0.64 6.72-0.64 13.056 0 19.008l52.928-60.992c5.376-5.952 10.88-10.624 16.512-14.016 5.76-3.328 10.24-4.288 13.568-2.944 6.656 3.264 8.96 8.64 6.976 16l-87.04 275.968a49.664 49.664 0 0 0 7.04 44.48c9.344 13.056 25.664 21.888 49.024 26.56 33.28-0.64 61.312-10.368 83.968-29.056a321.92 321.92 0 0 0 63.04-72z" fill="currentColor"></path></svg>';
          const infoTip = document.createElement('span');
          infoTip.className = 'conv-info-tip';
          try {
            infoTip.textContent = new Date(e.updatedAt).toLocaleString('zh-CN', { hour12: false });
          } catch {
            infoTip.textContent = '';
          }
          infoWrap.appendChild(infoImg);
          infoWrap.appendChild(infoTip);
          row.appendChild(infoWrap);
        }
        return row;
      }
      // 小节标题分隔
      function makeSectionLabel(text) {
        const d = document.createElement('div');
        d.className = 'conv-section-label';
        d.textContent = text;
        return d;
      }
      // 四段式渲染：① 用户钉住会话 ② 当前活跃会话（未钉住时） ③ 本次使用过的会话 ④ 按日期加载的历史
      function renderConvList() {
        const el = $('#convList');
        const allEntries = buildMergedHistory(); // 已按 updatedAt 倒序（buildMergedHistory 已按 cwd 过滤到本窗项目）
        el.innerHTML = '';
        const frag = document.createDocumentFragment();

        const isUsed = (e) => !!(e.convId && usedConvIds.has(e.convId));
        const activeEntry = allEntries.find((e) => e.active) || null;

        // ── 第 0 段：用户钉住的会话（始终显示在最顶部）──
        const pinnedEntries = allEntries.filter((e) => e.pinned);
        if (pinnedEntries.length) {
          for (const e of pinnedEntries) frag.appendChild(makeConvRow(e));
        }

        // 本次会话：使用过 或 运行中（运行中始终保持可见），排除钉住 / 活跃
        const usedEntries = allEntries.filter(
          (e) => !e.pinned && !e.active && (isUsed(e) || e.running),
        );
        // 按日期加载的历史：排除钉住 / 活跃 / 本次会话 / 运行中
        const dayEntries =
          historyRange === 'used'
            ? []
            : allEntries.filter(
                (e) =>
                  !e.pinned &&
                  !e.active &&
                  !isUsed(e) &&
                  !e.running &&
                  isWithinDays(e.updatedAt, historyRange),
              );

        // ── 第 1 段：当前活跃会话（未钉住时置顶）──
        if (activeEntry && !activeEntry.pinned) {
          const row = makeConvRow(activeEntry);
          row.classList.add('pinned');
          frag.appendChild(row);
        }
        // ── 第 2 段：本次使用过的会话 ──
        if (usedEntries.length) {
          frag.appendChild(makeSectionLabel('本次会话'));
          for (const e of usedEntries) frag.appendChild(makeConvRow(e));
        }
        // ── 第 3 段：按日期加载的历史 ──
        if (dayEntries.length) {
          frag.appendChild(makeSectionLabel(historyRange === 0 ? '今日会话' : '历史会话'));
          for (const e of dayEntries) frag.appendChild(makeConvRow(e));
        }

        // 空态提示
        if (!activeEntry && !pinnedEntries.length && !usedEntries.length && !dayEntries.length) {
          const empty = document.createElement('div');
          empty.className = 'conv-empty';
          empty.textContent = diskLoadFailed
            ? '本地无对话（磁盘历史加载失败）'
            : historyRange === 'used'
              ? '本次暂无会话'
              : '暂无对话';
          frag.appendChild(empty);
        }

        // 是否还有更早/未加载的会话可加载（钉住的始终显示，不计入 hasMore）
        const hasMore =
          historyRange === 'used'
            ? allEntries.some((e) => !e.pinned && !e.active && !isUsed(e) && !e.running)
            : allEntries.some(
                (e) =>
                  !e.pinned &&
                  !e.active &&
                  !isUsed(e) &&
                  !e.running &&
                  !isWithinDays(e.updatedAt, historyRange),
              );
        if (hasMore) frag.appendChild(makeHistoryLoadBtn());
        // 已展开时提供「收起」回到本次会话
        if (historyRange !== 'used') {
          const collapseBtn = document.createElement('button');
          collapseBtn.className = 'conv-load-more collapse';
          collapseBtn.textContent = '收起';
          collapseBtn.onclick = () => { historyRange = 'used'; renderConvListDebounced.flush(); };
          frag.appendChild(collapseBtn);
        }
        el.appendChild(frag);
      }
      /** 立即重渲会话列表（供 app.js 视图切换时调用），不走防抖 */
export function renderConvListNow() {
  renderConvList();
}
      /** 防抖版 renderConvList：流式输出期间合批，200ms 内多次调用只渲染最后一次 */
      const renderConvListDebounced = debounce(renderConvList, 200);
      // 加载按钮：'used'→加载今日；今日已加载后逐天向前累加
      function makeHistoryLoadBtn() {
        const btn = document.createElement('button');
        btn.className = 'conv-load-more';
        if (historyRange === 'used') {
          btn.textContent = '加载今日会话';
          btn.onclick = () => { historyRange = 0; renderConvListDebounced.flush(); };
        } else {
          const nextDay = historyRange + 1; // 即将加载「前 nextDay 天」
          btn.textContent = '加载前' + nextDay + '天会话';
          btn.onclick = () => { historyRange = historyRange + 1; renderConvListDebounced.flush(); };
        }
        return btn;
      }
      // ---- 会话右键菜单：钉住 / 重命名 / 删除 ----
      const _ctxMenu = (() => {
        const el = document.createElement('div');
        el.className = 'conv-ctx-menu';
        el.hidden = true;
        el.innerHTML =
          '<button class="ctx-item" id="ctxPin"></button>' +
          '<button class="ctx-item" id="ctxRename">重命名</button>' +
          '<button class="ctx-item ctx-danger" id="ctxDelete">删除</button>';
        document.body.appendChild(el);
        return el;
      })();
      let _ctxConvId = null; // 当前右键的 convId

      function _hideCtxMenu() {
        _ctxMenu.hidden = true;
        _ctxConvId = null;
      }

      function _showCtxMenu(x, y, convId, isPinned) {
        _ctxConvId = convId;
        _ctxMenu.querySelector('#ctxPin').textContent = isPinned ? '取消钉住' : '钉住';
        // 先显示再定位，确保能拿到尺寸
        _ctxMenu.hidden = false;
        const mw = _ctxMenu.offsetWidth;
        const mh = _ctxMenu.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        _ctxMenu.style.left = (x + mw > vw ? vw - mw - 6 : x) + 'px';
        _ctxMenu.style.top  = (y + mh > vh ? vh - mh - 6 : y) + 'px';
      }

      // 钉住 / 取消钉住
      function _convPin(convId, shouldPin) {
        const list = loadConvs();
        const c = list.find((x) => x.id === convId);
        if (!c) return;
        c.pinned = shouldPin;
        saveConvs(list);
        renderConvListDebounced.flush();
        toast(shouldPin ? '已钉住' : '已取消钉住');
      }

      // 重命名
      async function _convRename(convId) {
        const list = loadConvs();
        const c = list.find((x) => x.id === convId);
        if (!c) return;
        const newTitle = await promptDialog({
          title: '重命名对话',
          value: c.title || '',
          placeholder: '输入新名称',
          confirmText: '保存',
        });
        if (newTitle == null) return; // 取消
        const trimmed = newTitle.trim();
        if (!trimmed) return;
        c.title = trimmed;
        saveConvs(list);
        renderConvListDebounced.flush();
      }

      // 删除
      async function _convDelete(convId) {
        const ok = await confirmDialog({
          title: '删除对话',
          message: '此操作将永久删除该对话记录，无法恢复。',
          confirmText: '删除',
          danger: true,
        });
        if (!ok) return;
        const list = loadConvs();
        const idx = list.findIndex((x) => x.id === convId);
        if (idx < 0) return;
        list.splice(idx, 1);
        saveConvs(list);
        if (convId === currentConvId) {
          newConversation();
        } else {
          renderConvListDebounced.flush();
        }
        toast('已删除');
      }

      // 菜单按钮事件
      _ctxMenu.querySelector('#ctxPin').addEventListener('click', () => {
        if (!_ctxConvId) return;
        const list = loadConvs();
        const c = list.find((x) => x.id === _ctxConvId);
        _convPin(_ctxConvId, !(c && c.pinned));
        _hideCtxMenu();
      });
      _ctxMenu.querySelector('#ctxRename').addEventListener('click', () => {
        const id = _ctxConvId;
        _hideCtxMenu();
        _convRename(id);
      });
      _ctxMenu.querySelector('#ctxDelete').addEventListener('click', () => {
        const id = _ctxConvId;
        _hideCtxMenu();
        _convDelete(id);
      });

      // 点其他地方关闭
      document.addEventListener('click', (e) => {
        if (!_ctxMenu.hidden && !_ctxMenu.contains(e.target)) _hideCtxMenu();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') _hideCtxMenu();
      });

      // 拉取磁盘历史（含 5s 缓存）并刷新左栏；失败置错误态
      async function refreshDiskHistory() {
        const data = await loadHistorySessions();
        diskLoadFailed = data === null;
        renderConvListDebounced();
      }
      function recordMessage(role, text) {
        if (!currentConvId) return;
        markConvUsed(currentConvId); // 发过消息 = 本次使用过
        const list = loadConvs();
        let c = list.find((x) => x.id === currentConvId);
        if (!c) {
          c = { id: currentConvId, title: '', session: null, cwd: '', messages: [], updatedAt: 0 };
          list.push(c);
        }
        // 用首条用户消息作为标题
        if (role === 'user' && !c.messages.some((m) => m.role === 'user')) {
          c.title = text.slice(0, 30);
        }
        c.messages.push({ role, text });
        c.session = currentSession;
        c.cwd = cwd;
        c.model = chatModel;
        c.effort = chatEffort;
        c.mode = chatMode;
        c.provider = chatProvider;
        c.customModel = chatCustomModel;
        c.customLabel = chatCustomLabel;
        c.customCredId = chatCustomCredId;
        c.updatedAt = Date.now();
        saveConvs(list);
        renderConvListDebounced();
      }
      /**
       * 需求寄生会话（Task 10）：为需求创建一个不进「本次会话」列表的 conv（buildMergedHistory
       * 按 meta.reqId 过滤）。字段形状对齐 recordMessage 的建 conv 块；session 传入 devSession
       * 可跨浏览器续接同一开发会话。不调 renderConvList——本就不该出现在列表里。
       * @returns {string} convId
       */
      export function createReqConv({ reqId, cwd: reqCwd, session, title, kind = 'sub', seedPending = false, seedText = '' }) {
        const list = loadConvs();
        const c = {
          id: 'c' + String(Date.now()),
          title: title || '需求会话',
          session: session || null,
          cwd: reqCwd || '',
          messages: [],
          updatedAt: Date.now(),
          meta: { reqId, kind, seedPending, seedText },
          // 需求系统任务固定跑 Claude；显式声明可防 openai-compat 用户打开需求会话时
          // applySessionPrefs 把缺失 provider 归一成 claude-agent 并静默写穿 localStorage
          provider: 'claude-agent',
        };
        list.push(c);
        saveConvs(list);
        return c.id;
      }
      // 写穿：右下角改动立即写入当前会话记录（不等下一条消息快照），杜绝切走再切回被还原
      function persistPrefsToConv() {
        if (!currentConvId) return;
        const list = loadConvs();
        const c = list.find((x) => x.id === currentConvId);
        if (!c) return;
        c.model = chatModel;
        c.effort = chatEffort;
        c.mode = chatMode;
        c.provider = chatProvider;
        c.customModel = chatCustomModel;
        c.customLabel = chatCustomLabel;
        c.customCredId = chatCustomCredId;
        saveConvs(list); // 不动 updatedAt：纯偏好变更不改变左栏排序
      }
      export async function openConv(id) {
        _goChat();
        if (id === currentConvId) return;
        const c = loadConvs().find((x) => x.id === id);
        if (!c) return;
        if (currentConvId) bubbleReset(currentConvId); // 离开旧会话前清理其气泡缓存，避免 detached DOM 常驻
        currentConvId = id;
        markConvUsed(id); // 打开 = 本次使用过
        lsSet('claude_last_conv', id); // 刷新后自动回到该会话
        currentSession = c.session || null;
        if (typeof c.cwd === 'string') {
          cwd = c.cwd;
          lsSet('claude_cwd', cwd);
          refreshDirLabel();
        }
        applySessionPrefs(c); // 还原该会话的模型/强度/模式（缺失或不认识则保持现状）
        _prefsOwnedByConv = true; // 此后 initUiPrefs 的迟到响应不得覆盖这些值
        AnimeAnimations.resetToolState();
        AnimeAnimations.stopStreamScramble();
        messagesEl.querySelectorAll('.msg').forEach((m) => m.remove());
        bubbleReset(id); // 清旧缓存，下面 addMessage 会重建
        emptyEl.style.display = c.messages.length ? 'none' : '';
        for (const m of c.messages) await addMessage(m.role, m.text, m);
        // 恢复运行态：优先接续本地后台 job；否则按 runId 重连服务端 run（关网页后仍在跑）
        const job = runningJobs[id];
        if (job) {
          job.shown = job.text.length; // 返回时直接显示已有内容，不重新逐字
          job._paintedShown = -1;
          job._paintedStatus = '';
          paintJob(job);
          ensureTyping();
        } else {
          let attached = false;
          for (let k = c.messages.length - 1; k >= 0; k--) {
            const m = c.messages[k];
            if (m.role === 'assistant' && m.pending && m.runId) {
              attachStream(id, k, m.runId);
              attached = true;
              break;
            }
          }
          // 无本地 pending 气泡但服务端有该会话的存活续跑（后台会话已隔离、未预塞气泡）→ 新建气泡接流
          if (!attached) {
            const p = pendingMap[id];
            if (p && p.status === 'resuming' && p.runId && !handledResumes.has(p.runId)) {
              handledResumes.add(p.runId);
              const idx = convPushMessage(id, 'assistant', '');
              convSetMsgFields(id, idx, { pending: true, runId: p.runId });
              addMessage('assistant', '');
              attachStream(id, idx, p.runId);
            }
          }
        }
        updateComposerRunning();
        renderConvListDebounced.flush(); // 切换对话须立即更新高亮
        renderPendingBanner();
        _reqConvHook?.(c.meta?.reqId || null); // 需求 conv → 挂横幅/右栏；普通 conv → 卸载
        // 换会话要换收件箱轮询目标：后台会话期间收到的补充内容靠它立刻补拉一次
        if (window.__convNotify) window.__convNotify.onConvOpened(id);
      }
      function newConversation() {
        _goChat();
        window._setSidebarToolsMode?.(false); // 从工具态复位回会话列表
        const oldId = currentConvId;
        currentConvId = null;
        if (oldId) bubbleReset(oldId); // 清旧会话的气泡缓存（需在重置 currentConvId 前用局部变量保存）
        localStorage.removeItem('claude_last_conv');
        currentSession = null;
        messagesEl.querySelectorAll('.msg').forEach((m) => m.remove());
        emptyEl.style.display = '';
        AnimeAnimations.resetToolState();
        // 触发空页面 SVG 描边动画
        requestAnimationFrame(() => AnimeAnimations.playVibeAnimation());
        updateComposerRunning();
        renderConvListDebounced.flush(); // 新建对话须立即更新高亮
        renderPendingBanner();
        _reqConvHook?.(null); // 新对话必然不是需求会话 → 卸载横幅/右栏
        // 应用新会话默认值（若设置了的话）
        (async () => {
          try {
            const r = await fetch('/api/settings');
            if (!r.ok) return;
            const d = await r.json();
            const prefs = d.uiPrefs || {};
            let changed = false;
            if (prefs.defaultModel && MODEL_LABELS[prefs.defaultModel] && prefs.defaultModel !== chatModel) {
              chatModel = prefs.defaultModel; lsSet('claude_model', chatModel); changed = true;
            }
            if (prefs.defaultEffort && EFFORTS.includes(prefs.defaultEffort) && prefs.defaultEffort !== chatEffort) {
              chatEffort = prefs.defaultEffort; lsSet('claude_effort', chatEffort); changed = true;
            }
            if (prefs.defaultMode && MODES.includes(prefs.defaultMode) && prefs.defaultMode !== chatMode) {
              chatMode = prefs.defaultMode; lsSet('claude_mode', chatMode); changed = true;
            }
            if (changed) syncModelUI();
          } catch { /* 静默失败 */ }
        })();
      }

      // ---- 会话消息模型 & 运行态操作（支持后台并行会话）----
      // 当前可见消息区中第 index 条消息的气泡（优先走 Map 缓存，O(1)）
      function bubbleAt(index) {
        if (currentConvId) {
          const b = bubbleGet(currentConvId, index);
          if (b) return b;
        }
        // 降级：Map 未命中时回退线性扫描（兼容边界情况）
        const msg = messagesEl.querySelectorAll('.msg')[index];
        return msg ? msg.querySelector('.bubble') : null;
      }
      // 依据当前会话是否运行，切换发送/停止按钮；同步 Lottie 动画（任意会话运行中即播放）
      function updateComposerRunning() {
        const job = currentConvId ? runningJobs[currentConvId] : null;
        // 运行中不再禁发：拿到 runId 即可插话（steering）；仅 start 往返期间短暂禁用
        sendBtn.disabled = !!(job && !job.runId);
        sendBtn.title = job ? (job.runId ? '插话：消息将排队，可撤回或立即生效' : '正在启动，稍候可插话') : '发送';
        stopBtn.hidden = !job;
      }
      // 结束某会话运行任务（关连接 + 定稿 markdown + 停打字机 + 更新侧栏）
      function endJob(convId, isErr) {
        const job = runningJobs[convId];
        if (!job) return;
        // 清除停止中状态：取消延迟定时器 + 移除遮罩 + 恢复按钮
        if (job._stoppingTimer) clearTimeout(job._stoppingTimer);
        hideStoppingOverlay();
        stopBtn.disabled = false;
        stopBtn.textContent = '停止';
        try {
          job.es.close();
        } catch {}
        if (convId === currentConvId) {
          const vb = bubbleAt(job.asstIndex);
          if (vb) {
            AnimeAnimations.stopStreamScramble(); // 停流式 scramble，避免落定回写到已定稿内容
            renderMarkdown(vb, job.text.slice(job.base)); // 定稿：本段完整 markdown、去掉运行状态行
            if (isErr) {
              vb.classList.add('err');
              // 异常时显示异常状态吉祥物 + 面板
              AnimeAnimations.showMascotStatus('error', '任务执行异常，请查看错误信息');
              AnimeAnimations.setMascotState('error');
              // 异常不自动消失
            } else {
              // 成功完成时显示成功状态
              AnimeAnimations.showMascotStatus('success', '任务已成功完成');
              AnimeAnimations.setMascotState('success');
              // 发送系统通知（Tauri 环境）
              if (window.notifyUser) {
                window.notifyUser(
                  'Task Completed',
                  `"${loadConvs().find((c) => c.id === convId)?.title || 'Task'}" execution finished`,
                  { icon: 'success', convId }
                );
              }
              // 3秒后恢复默认状态 + 隐藏面板
              setTimeout(() => {
                if (currentConvId === convId) {
                  AnimeAnimations.setMascotState('');
                  AnimeAnimations.hideMascotStatus();
                }
              }, 3000);
            }
          }
          if (typeTimer) {
            clearInterval(typeTimer);
            typeTimer = null;
          }
        }
        delete runningJobs[convId];
        if (convId === currentConvId) updateComposerRunning();
        renderConvListDebounced();
        // Task 4：run 完成时更新侧栏运行灯
        if (window._updateReqList) {
          window._updateReqList();
        }
        refreshAskChip(); // job 结束：挂起审批随之消失，刷新徽标
      }

      // ---- 路径检测与渲染 ----
      // 只识别绝对路径。相对路径没有可靠锚点，在中文语境里跟正常文本无法区分，
      // 一律不识别（例如「是否有宠物/宝宝」的斜杠是「或」的意思，不是路径分隔符）。
      //
      // 三条规则的共同约束：
      // 1. 必须以行首或空白/引号/括号开头 —— 挡掉句子中间的斜杠（宠物/宝宝）
      // 2. 遇空白即截断 —— 带空格的路径只能识别到第一段，宁可少认不可错认
      // 3. 中文标点不算路径字符 —— 中文里逗号后不跟空格，否则「C:\a.txt，然后」会整句被吞
      const PATH_SEP_HEAD = '(^|[\\s"\'(\\[{（【])';
      // Windows 路径允许中文文件名（有 C:\ 强锚点，误判风险低），但排除中文标点
      const WIN_BODY = '[^\\s"\'<>|*?\\n，。；：！？、（）【】《》]';
      const PATH_PATTERNS = [
        // Windows 盘符绝对路径：C:\... 或 C:/...
        new RegExp(PATH_SEP_HEAD + '([A-Za-z]:[\\\\/]' + WIN_BODY + '*)', 'g'),
        // Windows UNC：\\server\share\...
        new RegExp(PATH_SEP_HEAD + '(\\\\\\\\' + WIN_BODY + '+)', 'g'),
        // Unix/Mac 绝对路径：无强锚点，故限定纯 ASCII 路径字符且至少两级（/home/user）
        new RegExp(PATH_SEP_HEAD + '((?:\\/[A-Za-z0-9._+@~%-]+){2,}\\/?)', 'g'),
      ];
      // 路径尾部粘连的标点：句号、括号、引号等都不是路径的一部分
      const TRAILING_PUNCT = /[.,;:!?、，。；：！？)）\]】》>"'`]+$/;
      const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i;

      /**
       * 剥掉路径尾部粘连的标点。
       * 注意：Windows 盘符根（C:\）剥完仍然有效，所以只在剥空时放弃。
       */
      function stripTrailingPunct(path) {
        return path.replace(TRAILING_PUNCT, '');
      }

      /**
       * 扩展名后面直接粘中文时，在扩展名处截断。
       *
       * 中文输入里「C:\x\y.png这张图」这样不打空格是常态，光靠空白和标点截不住。
       * 贪婪匹配保证取最后一个扩展名，所以中文目录名（C:\项目\说明.md）不受影响——
       * 那里的扩展名后面是结尾而非中文。
       */
      function cutAtExtension(path) {
        const m = path.match(/^(.*\.[A-Za-z0-9]{1,8})[一-鿿぀-ヿ]/);
        return m ? m[1] : path;
      }

      /**
       * 剥离标点后的兜底复检：确认它仍然是个绝对路径。
       */
      function isAbsolutePath(path) {
        if (!path || path.length < 3) return false;
        if (/^[A-Za-z]:[\\/]/.test(path)) return true;      // C:\ 或 C:/
        if (/^\\\\[^\\]/.test(path)) return true;            // UNC
        if (/^(?:\/[^/]+){2,}\/?$/.test(path)) return true;  // /a/b
        return false;
      }

      /**
       * 提取路径最后一段作为显示名
       */
      function getPathName(path) {
        const lastSeg = path.split(/[/\\]/).filter(Boolean).pop() || path;
        return lastSeg;
      }

      /**
       * 判断是否为图片扩展名
       */
      function isImagePath(path) {
        return IMAGE_EXTS.test(path);
      }

      /**
       * 判断是否为 Markdown 文件扩展名
       */
      function isMarkdownPath(path) {
        return /\.(md|markdown)$/i.test(path);
      }

      /**
       * 把本地绝对路径转成 WebView 能加载的 URL。
       *
       * convertFileSrc 在 Tauri v2 里属于 core 模块，旧代码写的 __TAURI__.path
       * 下面没有这个函数，取值恒为 undefined，于是一路退到 file:///——
       * 而 WebView 出于安全会拒载 file://，缩略图必然是破图。
       *
       * @returns {string|null} 拿不到可用的转换器时返回 null，调用方据此放弃渲染图片
       */
      function toWebviewUrl(path) {
        const convert = window.__TAURI__?.core?.convertFileSrc
          || window.__TAURI__?.tauri?.convertFileSrc;  // v1 兼容
        return convert ? convert(path) : null;
      }

      /**
       * 创建图片缩略图 DOM。
       * 加载失败时（路径不存在、格式不支持、权限不足）原地降级成文件 chip——
       * 没有 path_exists 可用，img.onerror 就是唯一的存在性信号。
       */
      function makeImageElement(path, src) {
        const img = document.createElement('img');
        img.className = 'path-img';
        img.alt = getPathName(path);
        img.dataset.path = path;
        img.title = '点击查看完整图片';
        img.src = src;

        img.onerror = () => {
          img.replaceWith(makePathChip(path, 'file'));
        };

        return img;
      }

      /**
       * 创建路径 chip（文件或目录）
       */
      function makePathChip(path, kind) {
        const chip = document.createElement('span');
        chip.className = 'path-chip';
        chip.dataset.path = path;

        const icon = document.createElement('span');
        icon.className = 'path-icon';

        const name = document.createElement('span');
        name.className = 'path-name';
        name.textContent = getPathName(path);

        if (kind === 'dir') {
          chip.classList.add('path-dir');
          icon.textContent = '📁';
          chip.title = '点击在文件夹中定位';
        } else {
          chip.classList.add('path-file');
          icon.textContent = '📄';
          chip.title = '点击在文件夹中定位';
        }

        chip.appendChild(icon);
        chip.appendChild(name);

        // Markdown 文件使用专属样式和 icon
        if (kind === 'markdown') {
          chip.classList.add('path-markdown');
          icon.textContent = '📝';
          chip.title = '点击用 Markdown 查看器打开';
        }

        // 绑定点击事件
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          handlePathChipClick(path);
        });

        return chip;
      }

      /**
       * 处理路径 chip 点击：Tauri 在文件管理器中定位，Web 复制路径。
       *
       * 文件与目录都直接 reveal 目标本身（在其父目录中被选中）。不再手工截父目录——
       * 那个写法在根目录、结尾带分隔符时会算出空串。
       */
      async function handlePathChipClick(path) {
        // Markdown 文件快速打开：直接跳查看器
        if (isMarkdownPath(path) && _openMarkdown) {
          try {
            _openMarkdown(path);
            return;
          } catch (err) {
            console.error('打开 Markdown 失败:', err);
            toast('打开 Markdown 失败：' + (err?.message || err));
          }
        }

        // 后续原有逻辑（Tauri 定位 / Web 复制）
        if (!window.tauriApi?.revealPath) {
          // Web 模式：复制路径
          try {
            await navigator.clipboard.writeText(path);
            toast('已复制路径：' + path);
          } catch {
            toast('复制失败');
          }
          return;
        }

        try {
          await window.tauriApi.revealPath(path);
        } catch (err) {
          console.error('revealPath failed:', err);
          // Tauri 命令 reject 回传的是**序列化后的字符串**（插件 Error 的 Serialize
          // 走 serialize_str），对字符串取 .message 恒为 undefined——原先写 err?.message
          // 把 scope 校验失败的真实原因吞成了「未知错误」，正是本 bug 难查的直接原因。
          const msg = typeof err === 'string' ? err : (err?.message ?? JSON.stringify(err));
          toast('打开失败：' + msg);
        }
      }

      /**
       * 判断路径类型：image / file / dir。
       *
       * 原先走 invoke('plugin:shell|path_exists' / 'path_kind')，但这两个命令在
       * src-tauri 里根本不存在（shell 插件也没提供），每次必然抛错走 catch 降级，
       * 结果 'image' 分支永远走不到——缩略图和灯箱从上线起就没生效过。
       * 与其留着一个假的异步校验，不如直接按扩展名判断，行为可预期。
       *
       * 存在性不在这里管：图片交给 img.onerror 兜底（见 makeImageElement），
       * 那才是真正能验证文件读不读得到的地方。
       */
      function classifyPath(path) {
        if (isImagePath(path)) return 'image';
        if (isMarkdownPath(path)) return 'markdown';
        // 只看最后一段，且要求扩展名前有字符——否则 C:\Users\DELL\.uploads
        // 这种点开头的目录会被当成文件
        return /[^.\\/]\.[A-Za-z0-9]{1,8}$/.test(getPathName(path)) ? 'file' : 'dir';
      }

      /**
       * 主函数：扫描文本中的路径，转换为 DOM 节点混合内容
       */
      async function renderPathsInText(text, container) {
        if (!text || !container) return;

        // 收集所有路径及其位置
        const matches = [];
        for (const pattern of PATH_PATTERNS) {
          pattern.lastIndex = 0;
          let m;
          while ((m = pattern.exec(text)) !== null) {
            // m[1] 是前置边界（空白/引号/行首），不属于路径本身，要跳过它算起点
            const start = m.index + (m[1] || '').length;
            const path = stripTrailingPunct(cutAtExtension(m[2]));
            if (!isAbsolutePath(path)) continue;
            matches.push({ path, start, end: start + path.length });
          }
          pattern.lastIndex = 0;
        }

        // 按起点排序（同起点取更长的），再丢弃相互重叠的区间。
        // 重叠是真实存在的：C:/a/b 会同时命中 Windows 和 Unix 两条规则，
        // 不去重会把同一段文本渲染两次。
        const uniqueMatches = [];
        let cursor = 0;
        for (const m of matches.sort((a, b) => a.start - b.start || b.end - a.end)) {
          if (m.start < cursor) continue;
          uniqueMatches.push(m);
          cursor = m.end;
        }

        // 如果没找到路径，直接返回文本
        if (!uniqueMatches.length) {
          container.textContent = text;
          return;
        }

        // 构建 DOM：交替组合文本和路径节点
        const fragment = document.createDocumentFragment();
        let lastEnd = 0;

        for (const match of uniqueMatches) {
          // 添加路径前的文本
          if (match.start > lastEnd) {
            fragment.appendChild(
              document.createTextNode(text.slice(lastEnd, match.start))
            );
          }

          const kind = classifyPath(match.path);
          // 浏览器里没有 convertFileSrc，本地图片根本加载不了，
          // 与其挂个破图不如老老实实退回 chip（点击复制路径）
          const imgSrc = kind === 'image' ? toWebviewUrl(match.path) : null;

          if (imgSrc) {
            // 图片：缩略图 + 灯箱
            const img = makeImageElement(match.path, imgSrc);
            img.addEventListener('click', (e) => {
              e.stopPropagation();
              showLightbox(match.path);
            });
            fragment.appendChild(img);
          } else if (kind === 'dir') {
            // 目录
            fragment.appendChild(makePathChip(match.path, 'dir'));
          } else if (kind === 'markdown') {
            // Markdown 文件
            fragment.appendChild(makePathChip(match.path, 'markdown'));
          } else {
            // 文件（默认）
            fragment.appendChild(makePathChip(match.path, 'file'));
          }

          lastEnd = match.end;
        }

        // 添加剩余文本
        if (lastEnd < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastEnd)));
        }

        container.innerHTML = '';
        container.appendChild(fragment);
      }

      // ---- 灯箱缩放与拖拽状态管理 ----
      /**
       * 灯箱初始状态常量
       * @property {number} scale - 当前缩放倍数（1.0 = 100%，范围 0.5~5）
       * @property {number} translateX - X 轴偏移，单位像素
       * @property {number} translateY - Y 轴偏移，单位像素
       * @property {boolean} isDragging - 是否正在进行拖拽操作
       * @property {number} dragStartX - 拖拽开始时的鼠标 X 坐标（视口坐标）
       * @property {number} dragStartY - 拖拽开始时的鼠标 Y 坐标（视口坐标）
       */
      const INITIAL_LIGHTBOX_STATE = {
        scale: 1,
        translateX: 0,
        translateY: 0,
        isDragging: false,
        dragStartX: 0,
        dragStartY: 0,
      };

      /**
       * 灯箱状态对象，管理图片的缩放和拖拽
       * @property {number} scale - 当前缩放倍数（1.0 = 100%，范围 0.5~5）
       * @property {number} translateX - X 轴偏移，单位像素
       * @property {number} translateY - Y 轴偏移，单位像素
       * @property {boolean} isDragging - 是否正在进行拖拽操作
       * @property {number} dragStartX - 拖拽开始时的鼠标 X 坐标（视口坐标）
       * @property {number} dragStartY - 拖拽开始时的鼠标 Y 坐标（视口坐标）
       */
      let lightboxState = { ...INITIAL_LIGHTBOX_STATE };

      /**
       * 将数值约束在指定范围内（inclusive）
       * @param {number} value - 待约束的值
       * @param {number} min - 最小值（应 <= max）
       * @param {number} max - 最大值（应 >= min）
       * @returns {number} 约束后的值
       */
      function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
      }

      // 应用当前 transform 到图片元素
      function updateLightboxTransform() {
        const lightbox = document.getElementById('imgLightbox');
        const img = lightbox?.querySelector('.lightbox-img');
        if (!img) return;

        const { scale, translateX, translateY } = lightboxState;
        img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
      }

      // 重置灯箱状态
      function resetLightboxState() {
        Object.assign(lightboxState, INITIAL_LIGHTBOX_STATE);
      }

      /**
       * 显示图片灯箱
       */
      function showLightbox(imagePath) {
        // 提前验证参数和 URL 转换
        const src = toWebviewUrl(imagePath);
        if (!src) return; // 提前返回，不修改状态

        const lightbox = document.getElementById('imgLightbox');
        const img = lightbox?.querySelector('.lightbox-img');
        if (!img) return;

        // 此时才修改状态（确保 URL 有效）
        resetLightboxState();
        updateLightboxTransform();

        img.src = src;
        img.classList.remove('zoomed', 'dragging');
        lightbox.hidden = false;
      }

      /**
       * 关闭灯箱
       */
      function closeLightbox() {
        const lightbox = document.getElementById('imgLightbox');
        if (!lightbox) return;

        resetLightboxState();

        // 清除 transform 和样式
        const img = lightbox.querySelector('.lightbox-img');
        if (img) {
          img.style.transform = '';
          img.classList.remove('zoomed', 'dragging');
        }

        lightbox.hidden = true;
      }

      // 处理图片按下（开始拖拽）
      function handleLightboxMouseDown(event) {
        if (lightboxState.scale <= 1) return; // 仅在放大时允许拖拽

        lightboxState.dragStartX = event.clientX;
        lightboxState.dragStartY = event.clientY;
        lightboxState.isDragging = false; // 等待移动超过阈值

        // 绑定全局 mousemove 和 mouseup
        document.addEventListener('mousemove', handleLightboxMouseMove);
        document.addEventListener('mouseup', handleLightboxMouseUp);
      }

      // 处理鼠标移动（拖拽中）
      function handleLightboxMouseMove(event) {
        const lightbox = document.getElementById('imgLightbox');
        const img = lightbox?.querySelector('.lightbox-img');
        const overlay = lightbox?.querySelector('.lightbox-overlay');
        if (!img || !overlay) return;

        const dx = event.clientX - lightboxState.dragStartX;
        const dy = event.clientY - lightboxState.dragStartY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // 距离超过 3px 才确认拖拽
        if (!lightboxState.isDragging && distance > 3) {
          lightboxState.isDragging = true;
          img.classList.add('dragging');
        }

        if (lightboxState.isDragging) {
          // 更新位移
          lightboxState.translateX += dx;
          lightboxState.translateY += dy;

          // 应用边界约束
          applyDragBoundary(img, overlay);

          // 应用 transform
          updateLightboxTransform();

          // 更新起始点（持续拖拽时）
          lightboxState.dragStartX = event.clientX;
          lightboxState.dragStartY = event.clientY;
        }
      }

      // 处理鼠标抬起（拖拽结束）
      function handleLightboxMouseUp(event) {
        const lightbox = document.getElementById('imgLightbox');
        const img = lightbox?.querySelector('.lightbox-img');

        if (img && lightboxState.isDragging) {
          img.classList.remove('dragging');
        }

        lightboxState.isDragging = false;

        // 清理全局事件监听
        document.removeEventListener('mousemove', handleLightboxMouseMove);
        document.removeEventListener('mouseup', handleLightboxMouseUp);
      }

      // 应用拖拽边界约束
      function applyDragBoundary(img, overlay) {
        if (!img || !overlay) return;

        const { scale, translateX, translateY } = lightboxState;
        const imgRect = img.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();

        // 获取图片的原始尺寸
        const imgWidth = img.naturalWidth || img.offsetWidth;
        const imgHeight = img.naturalHeight || img.offsetHeight;

        // 视窗尺寸（px，转换自 vw/vh）
        const viewportWidth = overlayRect.width;
        const viewportHeight = overlayRect.height;

        // 计算最大拖拽距离
        const maxTranslateX = (imgWidth * scale - viewportWidth) / 2;
        const maxTranslateY = (imgHeight * scale - viewportHeight) / 2;

        // 约束
        lightboxState.translateX = clamp(translateX, -maxTranslateX, maxTranslateX);
        lightboxState.translateY = clamp(translateY, -maxTranslateY, maxTranslateY);
      }

      // 处理滚轮缩放
      function handleLightboxWheel(event) {
        event.preventDefault();

        const lightbox = document.getElementById('imgLightbox');
        const img = lightbox?.querySelector('.lightbox-img');
        const overlay = lightbox?.querySelector('.lightbox-overlay');
        if (!img || !overlay) return;

        // 获取鼠标在 overlay 中的位置
        const rect = overlay.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;

        // 判断滚轮方向
        const isScrollUp = event.deltaY < 0;
        const scaleFactor = isScrollUp ? 1.1 : 1 / 1.1;

        // 计算新缩放
        const oldScale = lightboxState.scale;
        const newScale = clamp(oldScale * scaleFactor, 0.5, 5);

        // 调试日志：验证 scale 计算（Task 3 后可移除）
        console.log(`[wheel] oldScale=${oldScale}, scaleFactor=${scaleFactor.toFixed(2)}, newScale=${newScale.toFixed(2)}`);

        if (newScale === oldScale) {
          console.log('[wheel] 已到达缩放极限，不处理');
          return; // 已到达极限，不处理
        }

        // 保持鼠标指向处的图片像素不动：
        // 新位移 = 旧位移 * 缩放比 + 鼠标位置 * (1 - 缩放比)
        const ratio = newScale / oldScale;
        lightboxState.translateX = lightboxState.translateX * ratio + mouseX * (1 - ratio);
        lightboxState.translateY = lightboxState.translateY * ratio + mouseY * (1 - ratio);

        // 更新缩放
        lightboxState.scale = newScale;

        // 应用 transform
        updateLightboxTransform();

        // 更新样式反馈
        if (newScale > 1) {
          img.classList.add('zoomed');
        } else {
          img.classList.remove('zoomed');
        }
      }

      // 灯箱事件：点击背景关闭、Esc 关闭、关闭按钮
      document.addEventListener('DOMContentLoaded', () => {
        const lightbox = document.getElementById('imgLightbox');
        const overlay = lightbox?.querySelector('.lightbox-overlay');
        const closeBtn = lightbox?.querySelector('.lightbox-close');
        const img = lightbox?.querySelector('.lightbox-img');

        if (lightbox) {
          // 点击蒙层（背景）关闭，但点击图片或拖拽中时不关闭
          lightbox.addEventListener('click', (e) => {
            // 只在点击图片内部时不关闭
            if (e.target.closest('.lightbox-img')) return;
            // 正在拖拽 → 不关闭
            if (lightboxState.isDragging) return;
            // 其他所有情况关闭（包括点击 overlay 背景和蒙层外的黑色区域）
            closeLightbox();
          });

          // 滚轮缩放事件
          overlay?.addEventListener('wheel', handleLightboxWheel, { passive: false });

          // 关闭按钮
          closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            closeLightbox();
          });

          // 图片拖拽事件
          img?.addEventListener('mousedown', handleLightboxMouseDown);
        }

        // Esc 关闭
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') closeLightbox();
        });
      });

      // ---- 消息渲染 ----
      async function addMessage(role, text, meta) {
        emptyEl.style.display = 'none';
        const msg = document.createElement('div');
        msg.className = 'msg ' + role;
        const who = document.createElement('div');
        who.className = 'who';
        who.textContent = role === 'user' ? '你' : '◆ ' + (
          chatProvider === 'openai-compat'
            ? (chatCustomLabel || chatCustomModel || '自定义模型')
            : (chatActiveTokenLabel || 'Claude')
        );
        // 添加复制按钮
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.title = '复制文本';
        copyBtn.innerHTML = '<svg class="copy-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M938.666667 256h-170.666667V85.333333c0-25.6-17.066667-42.666667-42.666667-42.666666H85.333333c-21.333333 0-42.666667 21.333333-42.666666 42.666666v640c0 25.6 17.066667 42.666667 42.666666 42.666667h170.666667v170.666667c0 25.6 17.066667 42.666667 42.666667 42.666666h640c25.6 0 42.666667-17.066667 42.666666-42.666666V298.666667c0-21.333333-17.066667-42.666667-42.666666-42.666667zM128 682.666667V128h554.666667v128H298.666667c-21.333333 0-42.666667 21.333333-42.666667 42.666667v384H128z m768 213.333333H341.333333V341.333333h554.666667v554.666667z" fill="currentColor"></path></svg>';
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          copyMessageText(msg, text);
        });
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        if (role === 'assistant') renderMarkdown(bubble, text);
        else {
          // 用户消息：扫描路径并转为可交互样式
          await renderPathsInText(text, bubble);
        }
        // 气泡行：把复制按钮放到气泡侧边（Claude 右侧 / 用户左侧）
        const bubbleRow = document.createElement('div');
        bubbleRow.className = 'bubble-row';
        if (role === 'user') {
          // 排队操作按钮组（仅排队态显示，applyQueuedDecor 控制显隐）
          const actions = document.createElement('span');
          actions.className = 'q-actions';
          // 图标内联 SVG + fill="currentColor"：跟随 .q-btn 的 color（默认 --muted，hover 变白）
          actions.innerHTML =
            '<button class="q-btn q-withdraw" title="撤回：消息尚未进入任务，点击作废">' +
            '<svg class="q-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M396.8 200.533333l64 64L384 341.333333h298.666667c119.466667 0 213.333333 93.866667 213.333333 213.333334s-93.866667 213.333333-213.333333 213.333333H298.666667v-85.333333h384c72.533333 0 128-55.466667 128-128s-55.466667-128-128-128H170.666667l226.133333-226.133334z" fill="currentColor"></path></svg>' +
            '</button>' +
            '<button class="q-btn q-now" title="立即生效：打断当前任务轮，马上处理排队消息">' +
            '<svg class="q-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M871.04 89.770667L120.064 380.16a51.2 51.2 0 0 0-1.792 94.762667l303.36 130.56 131.072 303.957333a51.2 51.2 0 0 0 94.805333-1.877333l289.792-751.573334a51.2 51.2 0 0 0-66.261333-66.133333z m-41.130667 107.392l-231.978666 601.642666-97.962667-227.114666-3.584-7.338667a85.333333 85.333333 0 0 0-41.045333-37.248l-226.56-97.536 601.173333-232.405333z" fill="currentColor"></path></svg>' +
            '</button>';
          actions.querySelector('.q-withdraw').addEventListener('click', (e) => {
            e.stopPropagation();
            withdrawQueuedMsg(msg);
          });
          actions.querySelector('.q-now').addEventListener('click', (e) => {
            e.stopPropagation();
            effectNowQueuedMsg(msg);
          });
          bubbleRow.appendChild(actions);
          bubbleRow.appendChild(copyBtn);
          bubbleRow.appendChild(bubble);
        } else {
          bubbleRow.appendChild(bubble);
          bubbleRow.appendChild(copyBtn);
        }
        msg.appendChild(who);
        msg.appendChild(bubbleRow);
        messagesEl.appendChild(msg);
        scrollBottom();
        // 写入气泡缓存（仅当前会话）
        if (currentConvId) bubblePush(currentConvId, bubble); // 与存储 push 同步登记，保持索引对齐

        // ---- DOM 上限控制：超过 MAX_DOM_MESSAGES 时**折叠**最早的气泡（不是移除）----
        // 为什么不能 remove：
        //  ① 省不到内存 —— _bubbleMap 仍持有这些元素的引用，remove 只是把它们从「挂在 DOM 上」
        //     变成「detached 常驻」，泄漏照旧；
        //  ② 破坏「存储索引 = DOM 索引 = _bubbleMap 索引」这条全模块依赖的不变量 ——
        //     splitSegment 与 bubbleAt 的降级路径都用 querySelectorAll('.msg')[index] 定位，
        //     裁掉前 N 个之后索引整体错位，后续流式输出会画到错误的气泡上。
        //     原注释承诺的「由 bubbleGet 调用方容错」并不存在，`|| null` 只是不报错而已。
        // 折叠 = 保留节点占位（索引不动）+ 丢掉渲染出来的重子树（真正释放内存）。
        const msgElements = messagesEl.querySelectorAll('.msg:not(.collapsed)');
        if (msgElements.length > MAX_DOM_MESSAGES) {
          const excess = msgElements.length - MAX_DOM_MESSAGES;
          for (let i = 0; i < excess; i++) collapseBubble(msgElements[i]);
        }

        if (meta && meta.msgId) msg.dataset.msgId = meta.msgId;
        if (role === 'user') applyQueuedDecor(msg, meta && meta.unsent ? 'unsent' : meta && meta.queued ? 'queued' : null);
        return msg;
      }
      // 排队/未发送装饰：气泡样式 + 提示文字 + 操作按钮显隐（state: 'queued' | 'unsent' | null）
      function applyQueuedDecor(msgEl, state) {
        const bubble = msgEl.querySelector('.bubble');
        const actions = msgEl.querySelector('.q-actions');
        if (bubble) {
          bubble.classList.toggle('queued', state === 'queued');
          bubble.classList.toggle('unsent', state === 'unsent');
        }
        if (actions) actions.style.display = state === 'queued' ? '' : 'none';
        let hint = msgEl.querySelector('.q-hint');
        if (state) {
          if (!hint) {
            hint = document.createElement('div');
            hint.className = 'q-hint';
            msgEl.appendChild(hint);
          }
          hint.textContent = state === 'queued' ? '等待进入任务' : '未发送';
          hint.classList.toggle('unsent', state === 'unsent');
        } else if (hint) {
          hint.remove();
        }
      }

      // 三态切换：存储字段与可见气泡装饰一致更新（后台会话只动存储，切回时 openConv 按存储重建）
      function setMsgQueuedState(convId, index, state) {
        convSetMsgFields(convId, index, { queued: state === 'queued', unsent: state === 'unsent' });
        if (convId !== currentConvId) return;
        const b = bubbleGet(convId, index);
        const msgEl = b && b.closest ? b.closest('.msg') : null;
        if (msgEl) applyQueuedDecor(msgEl, state);
      }

      // 撤回排队消息：服务端移除成功 → 存储+DOM 同步删除；已进入任务 → 提示并清除排队态
      async function withdrawQueuedMsg(msgEl) {
        if (msgEl.dataset.qBusy) return; // 在途防抖：防连点重复请求
        msgEl.dataset.qBusy = '1';
        try {
          const convId = currentConvId;
          const msgId = msgEl.dataset.msgId;
          const conv = loadConvs().find((x) => x.id === convId);
          // await 之前的 idx/m 仅作前置校验，不跨 await 复用（存储可能已被并发 splice）
          const idx = conv && msgId ? conv.messages.findIndex((m) => m.msgId === msgId) : -1;
          const m = idx >= 0 ? conv.messages[idx] : null;
          if (!m || !m.queued) return toast('消息已进入任务，无法撤回');
          let d;
          try {
            d = await (
              await fetch('/api/run/msg/withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ runId: m.runId, msgId }),
              })
            ).json();
          } catch {
            d = { ok: false };
          }
          // await 期间存储可能已变（另一条撤回/切段搬移），按 msgId 重新定位
          const conv2 = loadConvs().find((x) => x.id === convId);
          const idx2 = conv2 ? conv2.messages.findIndex((x) => x.msgId === msgId) : -1;
          if (idx2 < 0) return; // 消息已不在（已被移除/撤回），静默返回
          if (!d.ok) {
            setMsgQueuedState(convId, idx2, null);
            return toast('已进入任务，无法撤回');
          }
          if (removeMessageAt(convId, idx2)) {
            const job = runningJobs[convId];
            if (job && idx2 < job.asstIndex) job.asstIndex -= 1; // 防御：正常流程排队消息恒在占位气泡之后
            msgEl.remove();
          }
        } finally {
          delete msgEl.dataset.qBusy;
        }
      }

      // 立即生效：flush 全部排队消息 + 打断当前轮；成功路径的状态翻转由 consumed 事件驱动
      async function effectNowQueuedMsg(msgEl) {
        if (msgEl.dataset.qBusy) return; // 在途防抖：防连点重复请求
        // msgId 由 steer() 异步 fetch 写入；极端情况下点击早于响应到达，此时找不到消息
        if (!msgEl.dataset.msgId) return toast('消息尚未就绪，请稍候再试');
        msgEl.dataset.qBusy = '1';
        try {
          const convId = currentConvId;
          const conv = loadConvs().find((x) => x.id === convId);
          const m = conv && conv.messages.find((x) => x.msgId === msgEl.dataset.msgId);
          if (!m || !m.queued) return;
          let d;
          try {
            d = await (
              await fetch('/api/run/msg/now', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ runId: m.runId }),
              })
            ).json();
          } catch {
            d = { ok: false };
          }
          if (!d.ok) toast('暂无法立即生效：任务未在运行或正在启动');
        } finally {
          delete msgEl.dataset.qBusy;
        }
      }

      // 复制消息文本
      function copyMessageText(msgEl, text) {
        const bubble = msgEl.querySelector('.bubble');
        let copyText = text;
        // Claude 消息：取正文纯文本（定稿气泡整体是 md；流式中正文在 .md-body 容器）
        const mdEl =
          bubble && (bubble.classList.contains('md') ? bubble : bubble.querySelector('.md-body'));
        if (mdEl) copyText = mdEl.innerText || text;
        navigator.clipboard.writeText(copyText).then(() => {
          const copyBtn = msgEl.querySelector('.copy-btn');
          const originalHtml = copyBtn.innerHTML;
          copyBtn.innerHTML = '✓';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.innerHTML = originalHtml;
            copyBtn.classList.remove('copied');
          }, 1500);
        }).catch(() => {
          toast('复制失败');
        });
      }
      function scrollBottom() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      // 仅当用户已在底部附近时才自动吸底，避免打断向上翻阅
      function nearBottom() {
        return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
      }

      // ---- 打字机 + 运行状态（spinner / 工具活动）----
      function shortModel(m, e) {
        const name = /opus/.test(m) ? 'Opus' : /haiku/.test(m) ? 'Haiku' : 'Sonnet';
        return e ? name + '·' + e : name;
      }
      function jobStatusText(job) {
        const tag = job.pickLabel ? job.pickLabel + ' · ' : ''; // 所选/自动判定的模型
        if (job.text.length > job.base) return tag + '生成中…'; // 本段已有产出
        return tag + '运行中…'; // 刚启动 / 等待首个 token / 调工具中
      }
      // 工具活动转录（仅展示最新1条，带 clone 过渡动画）
      function renderToolLog(activities) {
        const box = document.createElement('div');
        box.className = 'tool-log tool-log-single';
        if (!activities || !activities.length) return box;
        const latest = activities[activities.length - 1];
        // 动画由 AnimeAnimations.animateToolLine 接管，box 作为容器传入
        // 此处先填充内容（paintJob 结束后 animateToolLine 会被调用）
        const dot = document.createElement('span');
        dot.className = 'tool-dot';
        const txt = document.createElement('span');
        txt.className = 'tool-text-anim';
        txt.textContent = latest;
        box.appendChild(dot);
        box.appendChild(txt);
        box._latestText = latest; // 暂存最新文字，供 paintJob 中使用
        return box;
      }
      // 任务清单面板（TodoWrite 快照）
      function renderTodoPanel(todos) {
        const box = document.createElement('div');
        box.className = 'todo-panel';
        const head = document.createElement('div');
        head.className = 'todo-head';
        const done = todos.filter((t) => t.status === 'completed').length;
        head.textContent = `任务清单 · ${done}/${todos.length}`;
        box.appendChild(head);
        for (const t of todos) {
          const st =
            t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : 'todo';
          const mk = st === 'done' ? '✓' : st === 'doing' ? '▸' : '▫';
          const item = document.createElement('div');
          item.className = 'todo-item ' + st;
          const mkEl = document.createElement('span');
          mkEl.className = 'mk';
          mkEl.textContent = mk;
          const tx = document.createElement('span');
          tx.className = 'tx';
          tx.textContent = (st === 'doing' && t.activeForm ? t.activeForm : t.content) || '';
          item.append(mkEl, tx);
          box.appendChild(item);
        }
        return box;
      }
      // 把某 job 的当前进度画到可见气泡：markdown(已显示文本) + 工具转录 + 任务清单 + 运行状态。
      // 正文放独立 .md-body 容器每帧重渲染；工具行/状态行等附属 UI 跨帧复用，
      // 避免整泡 innerHTML 重建把动画状态（工具行过渡/spinner/状态文字）一并打断
      function paintJob(job) {
        if (!job || job.convId !== currentConvId) return;
        const vb = bubbleAt(job.asstIndex);
        if (!vb) return;
        let md = vb.querySelector('.md-body');
        if (!md) {
          vb.textContent = '';
          md = document.createElement('div');
          md.className = 'md-body';
          vb.appendChild(md);
        }
        renderMarkdown(md, job.text.slice(job.base, job.shown));
        // 固定顺序：正文 → 工具行 → 任务清单 → 状态行/提问卡片（插入位置按锚点，元素不迁移）
        if (job.activities && job.activities.length) {
          const latest = job.activities[job.activities.length - 1];
          let toolBox = vb.querySelector('.tool-log-single');
          if (!toolBox) {
            toolBox = renderToolLog(job.activities);
            md.after(toolBox); // 首次插入，无需动画
          } else if (toolBox._latestText !== latest) {
            // 复用容器，仅在内容变化时触发过渡动画
            AnimeAnimations.animateToolLine(toolBox, latest);
            toolBox._latestText = latest;
          }
        }
        if (job.todos && job.todos.length) {
          const panel = renderTodoPanel(job.todos);
          const old = vb.querySelector('.todo-panel');
          if (old) old.replaceWith(panel);
          else (vb.querySelector('.tool-log-single') || md).after(panel);
        }
        const oldAsk = vb.querySelector('.ask-card');
        if (job.ask) {
          const st = vb.querySelector('.run-status');
          if (st) st.remove(); // 等待用户决策：状态行让位给选项卡片
          if (!oldAsk || oldAsk._reqId !== job.ask.reqId) {
            if (oldAsk) oldAsk.remove();
            const card = renderAskCard(job);
            card._reqId = job.ask.reqId;
            vb.appendChild(card);
            // 更新吉祥物为问询状态
            if (currentConvId === job.convId) AnimeAnimations.setMascotState('asking');
          }
        } else {
          if (oldAsk) oldAsk.remove();
          let st = vb.querySelector('.run-status');
          if (!st) {
            st = document.createElement('div');
            st.className = 'run-status';
            st.innerHTML = '<span class="spinner"></span><span class="run-text"></span>';
            vb.appendChild(st);
          }
          const runTextEl = st.querySelector('.run-text');
          const newStatusText = jobStatusText(job);
          AnimeAnimations.animateStatusText(runTextEl, newStatusText);
          // 恢复默认状态（如果已清除 ask）
          if (currentConvId === job.convId) AnimeAnimations.setMascotState('');
        }
        if (nearBottom()) scrollBottom();
      }
      // 交互审批/提问卡片（图2 风格）
      function renderAskCard(job) {
        const ask = job.ask;
        const card = document.createElement('div');
        card.className = 'ask-card';
        const title = document.createElement('div');
        title.className = 'ask-title';
        title.textContent = ask.title || '需要你的确认';
        card.appendChild(title);
        if (ask.body) {
          const body = document.createElement('div');
          body.className = 'ask-body';
          body.textContent = ask.body;
          card.appendChild(body);
        }
        const opts = document.createElement('div');
        opts.className = 'ask-opts';
        for (const o of ask.options || []) {
          const b = document.createElement('button');
          b.className = 'ask-opt';
          const lab = document.createElement('span');
          lab.className = 'opt-label';
          lab.textContent = o.label || o.id;
          b.appendChild(lab);
          if (o.desc) {
            const d = document.createElement('span');
            d.className = 'opt-desc';
            d.textContent = o.desc;
            b.appendChild(d);
          }
          b.onclick = () => submitDecision(job, ask.reqId, o.id);
          opts.appendChild(b);
        }
        card.appendChild(opts);
        return card;
      }
      // 提交交互决策 → 服务端 resolve 续跑
      function submitDecision(job, reqId, optionId) {
        fetch('/api/run/decision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: job.runId, reqId, optionId }),
        }).catch(() => {});
        job.ask = null; // 乐观清除，等待后续事件续流
        job.rev++;
        if (job.convId === currentConvId) {
          job._paintedRev = -1;
          paintJob(job);
        }
        refreshAskChip();
      }
      /** 刷新顶栏审批徽标：仅当离开聊天视图且存在挂起审批时显示「⏳ N 待确认」
       *  触发点：ask/replay 事件回调、showView 切换视图（由壳经导出调用）、job 结束 */
      export function refreshAskChip() {
        const chip = $('#askChip');
        if (!chip) return;
        let askCount = 0;
        for (const job of Object.values(runningJobs)) {
          if (job && job.ask) askCount++;
        }
        const shouldShow = !_isChatViewActive() && askCount > 0;
        chip.hidden = !shouldShow;
        if (shouldShow) chip.textContent = `⏳ ${askCount} 待确认`;
      }
      // 点击顶栏审批徽标：回聊天视图 → 打开第一个有待确认的会话 → 滚动到该提问卡片
      $('#askChip')?.addEventListener('click', () => {
        _goChat();
        const entry = Object.entries(runningJobs).find(([, job]) => job && job.ask);
        if (entry) {
          openConv(entry[0]);
          setTimeout(() => {
            document.querySelector('.ask-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }, 100);
        }
      });
      // 打字机循环：把可见 job 的 shown 平滑推进到 text 长度，并实时刷新状态行
      let typeTimer = null;
      function ensureTyping() {
        if (!typeTimer) typeTimer = setInterval(typeTick, 33);
      }
      function typeTick() {
        const job = currentConvId ? runningJobs[currentConvId] : null;
        if (!job) {
          clearInterval(typeTimer);
          typeTimer = null;
          return;
        }
        const prevShown = job.shown;
        if (job.shown < job.text.length) {
          // 自适应步进：落后越多走越快，避免大突发长时间追不上
          const backlog = job.text.length - job.shown;
          job.shown = Math.min(job.text.length, job.shown + Math.max(2, Math.ceil(backlog / 8)));
        }
        const status = jobStatusText(job);
        if (
          job.shown !== job._paintedShown ||
          status !== job._paintedStatus ||
          job.rev !== job._paintedRev
        ) {
          job._paintedShown = job.shown;
          job._paintedStatus = status;
          job._paintedRev = job.rev;
          paintJob(job);
          // 流式输出时：对最新新增的文字片段做正文原地 scramble（正文已含新增文字，无需独立元素）
          if (job.shown > prevShown && job.shown < job.text.length + 1) {
            const newChunk = job.text.slice(prevShown, job.shown);
            if (newChunk.trim()) { // 只对有实质内容的 chunk 做 scramble
              const vb = bubbleAt(job.asstIndex);
              if (vb) AnimeAnimations.startStreamScramble(vb, newChunk.length);
            }
          }
        }
      }

      // ---- 额度状态 ----
      function renderRateLimit(d) {
        const el = $('#ratelimit');
        const map = {
          allowed: ['额度正常', 'var(--green)'],
          allowed_warning: ['接近上限', 'var(--amber)'],
          warning: ['接近上限', 'var(--amber)'],
          rejected: ['已达上限', 'var(--red)'],
        };
        const [label, color] = map[d.status] || [d.status || '未知', 'var(--muted)'];
        let tip = '';
        if (d.resetsAt) {
          const t = new Date(d.resetsAt * 1000).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          });
          const WIN_LABELS = {
            five_hour: '5 小时额度',
            seven_day: '7 天额度',
            seven_day_opus: '7 天 Opus 额度',
            seven_day_oauth: '7 天额度',
          };
          const win = WIN_LABELS[d.rateLimitType] || d.rateLimitType || '';
          tip = ` · ${win} ${t} 重置`;
        }
        el.innerHTML = `<span class="dot" style="background:${color}"></span>${label}${tip}`;
        el.hidden = false;

        // 按额度状态调整对话输入框边框：接近上限=黄橙渐变，已用完=红色
        promptEl.classList.remove('limit-warn', 'limit-full');
        if (d.status === 'rejected') promptEl.classList.add('limit-full');
        else if (d.status === 'allowed_warning' || d.status === 'warning')
          promptEl.classList.add('limit-warn');
      }

      // ---- 发送（按会话隔离，支持多任务并行）----
      async function send() {
        const text = getPromptText();
        if (!text) return;
        // 当前会话正在运行 → 插话：注入正在运行的任务（steering）
        const running = currentConvId && runningJobs[currentConvId];
        if (running) {
          _goChat(); // 面板视图下插话 → 同样切回对话看流式输出
          // userTyped：本文件唯一「字是用户在输入框敲的」的入口，服务端据此决定要不要记原始日志
          //（记忆库数据采集层，见 src/store/user-log.js）。程序化发送不带这个标记，天然不入库。
          return steer(running, text, { userTyped: true });
        }
        _goChat(); // 面板视图下发送 → 回到对话看流式输出

        if (!currentConvId) currentConvId = 'c' + String(Date.now());
        lsSet('claude_last_conv', currentConvId); // 刷新后自动回到该会话
        const convId = currentConvId; // 本次运行绑定的会话
        const sessionId = currentSession; // 续接 id 快照
        const runCwd = cwd;

        await addMessage('user', text);
        recordMessage('user', text);
        clearPrompt();

        // 助手占位：记一条空消息（标记进行中 + 待填 runId），并显示可见气泡
        const asstIndex = convPushMessage(convId, 'assistant', '');
        convSetMsgFields(convId, asstIndex, { pending: true });
        addMessage('assistant', '');

        // ★ 新增：种子前置（检查 seedPending 标记）
        let finalText = text;
        const list = loadConvs();
        const conv = list.find(c => c.id === convId);
        if (conv && conv.meta && conv.meta.seedPending && conv.meta.seedText) {
          finalText = conv.meta.seedText + '\n\n' + text;
          conv.meta.seedPending = false;  // 清除标记，后续消息不重复前置
          // 同步更新 localStorage
          saveConvs(list); // 直接用已获取的列表引用，无需重读
        }

        // 先建占位 job（es 待填），立即显示”运行中…”，避免 start 往返期间无反馈
        const job = {
          es: null,
          asstIndex,
          convId,
          text: '',
          shown: 0,
          base: 0,
          activities: [],
          todos: [],
          ask: null,
          rev: 0,
          err: false,
          runId: null,
        };
        runningJobs[convId] = job;
        updateComposerRunning();
        renderConvListDebounced();
        paintJob(job);
        ensureTyping();

        // 原有的 launchRun 调用，传 finalText 而非 text；typedText 另给用户原文（见 launchRun）
        launchRun(job, finalText, sessionId, runCwd, null, { userTyped: true, typedText: text });
      }

      // 启动一次服务端 run 并接流（send 与插话竞态兜底共用）。
      // 两步启动：先 POST /start 拿 runId（落库，关网页后可按它重连），再 attach SSE
      // opts.userTyped：见 send() 的说明；opts.typedText：种子前置时 prompt 被系统拼过料，
      // 用户原文得单独带上，否则记忆库的原始日志会混进需求种子这类系统正文。
      // 与 prompt 相同时不带，免得大段粘贴内容在 body 里翻倍撞上 1MB 上限。
      function launchRun(job, text, sessionId, runCwd, modeOverride, opts = {}) {
        const convId = job.convId;
        const effectiveMode = modeOverride || chatMode;
        const userMark = opts.userTyped
          ? { userTyped: true, ...(opts.typedText && opts.typedText !== text ? { typedText: opts.typedText } : {}) }
          : {};
        const startBody =
          chatProvider === 'openai-compat'
            ? { prompt: text, cwd: runCwd, session: sessionId, provider: 'openai-compat', model: chatCustomModel, credId: chatCustomCredId, convId, ...userMark }
            : { prompt: text, cwd: runCwd, session: sessionId, model: chatModel, effort: chatEffort, mode: effectiveMode, convId, ...userMark };
        fetch('/api/run/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(startBody),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d.runId) throw new Error(d.error || '启动失败');
            job.runId = d.runId;
            if (d.model) {
              job.pickLabel = shortModel(d.model, d.effort); // 显示实际所用模型（自动模式尤其有用）
              job._paintedStatus = '';
            }
            convSetMsgFields(convId, job.asstIndex, { runId: d.runId });
            attachStream(convId, job.asstIndex, d.runId, job);
            updateComposerRunning(); // runId 就绪 → 解锁插话
            // Task 4：run 启动时更新侧栏运行灯
            if (window._updateReqList) {
              window._updateReqList();
            }
            if (job.stopping) abortRun(d.runId); // 期间点了停止 → 拿到 runId 后补发
          })
          .catch((err) => {
            job.text = '⚠️ ' + (err && err.message ? err.message : '启动失败');
            job.err = true;
            job.shown = job.text.length;
            convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
            convSetMsgFields(convId, job.asstIndex, { pending: false });
            endJob(convId, true);
          });
      }

      // 切段：当前助手气泡定稿，新开占位气泡接后续输出（排队消息进入任务时调用）。
      // 后台会话只动存储侧（_bubbleMap/DOM 由 openConv 重建），可见会话双侧同步。
      function splitSegment(job) {
        const convId = job.convId;
        const visible = convId === currentConvId;
        if (job.text.length > job.base) {
          // 本段已有文本 → 定稿当前助手气泡：写入本段全文（按 base 切分），刷新重连后顺序保持正确
          convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
          convSetMsgFields(convId, job.asstIndex, { pending: false });
          if (visible) {
            const vb = bubbleAt(job.asstIndex);
            if (vb) {
              // 与 endJob 定稿一致：先停流式 scramble 动画，再渲染定稿内容
              AnimeAnimations.stopStreamScramble();
              renderMarkdown(vb, job.text.slice(job.base));
            }
          }
          // 新占位气泡：记录 textBase（本气泡在 run 全文中的起点），后续输出切到这里
          const asstIndex = convPushMessage(convId, 'assistant', '');
          if (visible) addMessage('assistant', '');
          job.base = job.text.length;
          if (job.shown < job.base) job.shown = job.base;
          convSetMsgFields(convId, asstIndex, { pending: true, runId: job.runId, textBase: job.base });
          job.asstIndex = asstIndex;
        } else {
          // 本段尚无文本（还在跑工具/等首个 token）→ 定稿只会留下空白气泡；
          // 改为把现有占位气泡（含工具日志）挪到排队消息之后继续接收输出。
          // 存储与 DOM 必须同步移动，维持「存储索引=DOM 索引」不变量
          const oldIndex = job.asstIndex;
          const msgEl = visible ? messagesEl.querySelectorAll('.msg')[oldIndex] : null;
          const newIndex = moveMessageToEnd(convId, oldIndex); // 存储+_bubbleMap 两侧在 conv-store 内同步搬移
          if (newIndex >= 0) {
            if (msgEl) messagesEl.appendChild(msgEl);
            job.asstIndex = newIndex;
            if (visible) scrollBottom();
          }
        }
        job._paintedShown = -1;
        if (visible) {
          paintJob(job);
          ensureTyping();
        }
      }

      // 插话：消息先在服务端排队（气泡排队态，可撤回/立即生效），本轮 result 时进入任务。
      // 助手气泡此间继续在排队消息上方流式输出；切段推迟到 consumed 事件。
      async function steer(job, text, opts = {}) {
        if (!job.runId) return toast('任务正在启动，稍候再发'); // Enter 不受按钮禁用约束，需给感知；文本留在输入框
        const convId = job.convId;
        const msgEl = await addMessage('user', text, { queued: true });
        recordMessage('user', text);
        const conv0 = loadConvs().find((x) => x.id === convId);
        const idx = conv0.messages.length - 1;
        convSetMsgFields(convId, idx, { queued: true, runId: job.runId });
        // 跨 await 不得复用旧索引：撤回 splice / consumed 切段搬移会使 idx 漂移（甚至指向被挪尾的助手占位）。
        // 按对象身份重定位（_convsCache 是活对象，splice/搬移不改变元素身份，与 withdrawQueuedMsg 范式一致）
        const msgRef = conv0.messages[idx];
        clearPrompt();
        const degrade = () => {
          // run 恰好结束 → 降级为新一轮：清排队态 + 补切段（与旧流程一致）后重启
          const conv1 = loadConvs().find((x) => x.id === convId);
          const i2 = conv1 ? conv1.messages.indexOf(msgRef) : -1;
          if (i2 >= 0) setMsgQueuedState(convId, i2, null); // 找不到（已撤回/会话已删）则跳过清态
          splitSegment(job);
          restartAsNewRun(job, text, opts); // userTyped 必须跟着降级路径走，否则用户这句话就不入库了
        };
        fetch('/api/run/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // userTyped 见 send()；服务端只在消息真被持有（ok:true）时才记，与降级路径不会重复计一条
          body: JSON.stringify({ runId: job.runId, text, ...(opts.userTyped ? { userTyped: true } : {}) }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) return degrade();
            const conv1 = loadConvs().find((x) => x.id === convId);
            const i2 = conv1 ? conv1.messages.indexOf(msgRef) : -1;
            // 存储与 DOM 两侧同进同退：只写一侧会产生「DOM 有 msgId、存储没有」的幽灵排队气泡——
            // consumed/unsent 两条对账都按存储的 msgId 匹配，届时会同时失效且无自愈出口
            if (i2 >= 0) {
              convSetMsgFields(convId, i2, { msgId: d.msgId });
              if (msgEl) msgEl.dataset.msgId = d.msgId; // 按钮回调据此定位消息
              // SSE 与 fetch 响应是两条连接，consumed 可能先到——彼时 msgId 未回填匹配不上，这里补清排队态
              if (job._consumedIds && job._consumedIds.has(d.msgId)) setMsgQueuedState(convId, i2, null);
            } else if (msgEl) {
              applyQueuedDecor(msgEl, null); // 存储侧已不可定位（会话被删等）→ 撤下排队装饰，不留无法操作的幽灵气泡
            }
          })
          .catch(degrade);
      }

      // 插话竞态兜底：run 已在注入前结束 → 把这条消息作为新一轮发出（resume 续接），复用占位气泡
      function restartAsNewRun(job, text, opts = {}) {
        const convId = job.convId;
        // 登记守卫：runningJobs 已被别的 run 占据（先前降级已重启 / 用户已另发新消息）→ 本次插话放弃降级
        if (runningJobs[convId] && runningJobs[convId] !== job) {
          toast('插话未送达，请重发');
          return;
        }
        // 先关旧流：防止旧 run 的 done 事件把新登记的 job 误终结
        try {
          if (job.es) job.es.close();
        } catch {}
        delete runningJobs[convId];
        const conv = loadConvs().find((x) => x.id === convId);
        const newJob = {
          es: null,
          asstIndex: job.asstIndex,
          convId,
          text: '',
          shown: 0,
          base: 0,
          activities: [],
          todos: [],
          ask: null,
          rev: 0,
          err: false,
          runId: null,
        };
        convSetMsgFields(convId, job.asstIndex, { pending: true, runId: null, textBase: 0 });
        runningJobs[convId] = newJob;
        refreshAskChip(); // 旧 job 的挂起审批（若有）随重启一并作废
        updateComposerRunning();
        renderConvList();
        paintJob(newJob);
        ensureTyping();
        launchRun(newJob, text, conv ? conv.session : currentSession, conv ? conv.cwd : cwd, null, opts);
      }

      // 请求服务端中断某 run（手动”停止” / start 期间补发）
      /**
       * 请求服务端中止某 run。
       * 返回值很关键：服务端对「不存在 / 已终结」的 run 直接回 {ok:false} 且**不发任何 SSE 事件**
       * （后端重启后注册表已清空、run 被 gc、网络中断都会走到这里）。
       * 此前这里 `.catch(() => {})` 完全不看响应，于是 endJob 永远不被触发
       * → 全屏遮罩永不消失、stopBtn 永久停在「中止中…」，只能刷新页面。
       */
      function abortRun(runId) {
        if (!runId) return Promise.resolve(null);
        return fetch('/api/run/abort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => (d && typeof d.ok === 'boolean' ? d.ok : null))
          .catch(() => null); // 网络失败：当作「服务端不会再来消息」，由调用方本地收尾
      }

      // ---- 停止中遮罩（延迟出现，快速完成时不闪烁）----
      let _stoppingOverlayEl = null;
      let _stoppingOverlayTimer = null;
      function showStoppingOverlay() {
        if (_stoppingOverlayEl) return;
        _stoppingOverlayEl = document.createElement('div');
        _stoppingOverlayEl.className = 'stopping-overlay';
        // 注意引号：这里原本写的是中文弯引号 ”…”，解析出的 class 值是「”stopping-box”」，
        // 与 app.css 的 .stopping-box / .stopping-spinner 全都匹配不上 —— 遮罩里既没有卡片
        // 也没有转圈，只有一行裸文字。必须用 ASCII 双引号。
        _stoppingOverlayEl.innerHTML =
          '<div class="stopping-box">' +
          '<div class="stopping-spinner"></div>' +
          '<span>会话中止中...</span>' +
          '<button type="button" class="stopping-dismiss">关闭</button>' +
          '</div>';
        // 逃生出口：点遮罩空白处或「关闭」都能撤下它。
        // 遮罩是 position:fixed;inset:0;z-index:200 的全屏元素，没有出口就等于锁死整个界面。
        _stoppingOverlayEl.addEventListener('click', hideStoppingOverlay);
        document.body.appendChild(_stoppingOverlayEl);
        // 兜底超时：即便所有信号都没来，10s 后也自行撤下，绝不把界面永久卡住
        _stoppingOverlayTimer = setTimeout(hideStoppingOverlay, 10000);
      }
      function hideStoppingOverlay() {
        if (_stoppingOverlayTimer) {
          clearTimeout(_stoppingOverlayTimer);
          _stoppingOverlayTimer = null;
        }
        if (_stoppingOverlayEl) {
          _stoppingOverlayEl.remove();
          _stoppingOverlayEl = null;
        }
        // 遮罩撤下时一并恢复按钮：否则遮罩没了、按钮还停在「中止中…」，仍然发不出消息
        stopBtn.disabled = false;
        stopBtn.textContent = '停止';
      }

      // 停止当前会话正在运行的 run（发送按钮右侧”停止”）
      function stopCurrentRun() {
        const convId = currentConvId; // 快照：响应回来时用户可能已切走会话，不能收尾错对象
        const job = convId && runningJobs[convId];
        if (!job) return;
        job.stopping = true;
        if (job.runId) {
          // 必须看返回值：服务端对不存在/已终结的 run 回 {ok:false} 且不发 SSE，
          // 不本地收尾的话 endJob 永远不会被触发，界面就被遮罩锁死了。
          abortRun(job.runId).then((ok) => {
            if (ok === false || ok === null) endJob(convId, false);
          });
        } // 无 runId 时待 start 返回后补发
        // 立即给按钮反馈，防止重复点击
        stopBtn.disabled = true;
        stopBtn.textContent = '中止中…';
        // 超过 800ms 未完成则出现全屏遮罩，快速完成时不闪烁
        job._stoppingTimer = setTimeout(showStoppingOverlay, 800);
      }

      // 附加到某服务端 run 的 SSE 流（起始发送 & 关网页后重连共用）。
      // job 可复用 send() 预建的占位；openConv 重连时不传，由本函数新建。
      function attachStream(convId, asstIndex, runId, job) {
        const es = new EventSource('/api/run?runId=' + encodeURIComponent(runId));
        if (!job) {
          const conv = loadConvs().find((x) => x.id === convId);
          const msg = conv && conv.messages[asstIndex];
          job = {
            es,
            asstIndex,
            convId,
            text: '',
            shown: 0,
            base: (msg && msg.textBase) || 0, // 插话切段后重连：从持久化偏移恢复
            activities: [],
            todos: [],
            ask: null,
            rev: 0,
            err: false,
            runId,
            pending: false, // SSE 连接状态：true 表示静默等待（run 不存在后的过渡态）
          };
          runningJobs[convId] = job;
          updateComposerRunning();
          renderConvList();
          if (convId === currentConvId) {
            paintJob(job);
            ensureTyping();
          }
        }
        // 如果已有旧 ES（run 不存在后重连），关闭它
        if (job.es && job.es !== es) {
          try {
            job.es.close();
          } catch {}
        }
        job.es = es;
        job.runId = runId;

        const visible = () => convId === currentConvId;
        const saveThrottled = () => {
          const now = Date.now();
          if (now - (job._lastSave || 0) > 400) {
            job._lastSave = now;
            convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
          }
        };

        es.addEventListener('session', (e) => {
          let data;
          try {
            data = JSON.parse(e.data);
          } catch (err) {
            console.warn('[session event] JSON 解析错误，跳过:', err);
            return;
          }

          const sid = data.session_id;
          if (!sid) return;
          convSetSession(convId, sid);
          if (visible()) currentSession = sid;
          // 服务端的通知登记表存的是 session/cwd 快照，飞书补充内容靠它 resume 回原会话；
          // session 要到这一刻才拿得到，所以在此同步（全局桥：conv-notify.js 未加载时静默跳过）
          if (window.__convNotify) window.__convNotify.sync(convId);

          // ★ 新增：若 conv 带 reqId，回填 sessionId 到后端
          const conv = loadConvs().find(c => c.id === convId);
          if (conv && conv.meta && conv.meta.reqId && data.session_id) {
            // 异步回填，不阻塞流程
            fetch('/api/req/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: conv.meta.reqId,
                convId: conv.id,
                sessionId: data.session_id
              })
            }).catch(err => console.warn('Failed to report sessionId:', err));
          }
        });
        // 重放：服务端权威全文 —— 重置（而非追加），兼容自动重连的重复重放
        es.addEventListener('replay', (e) => {
          const d = JSON.parse(e.data);
          job.text = d.text || '';
          job.shown = job.text.length;
          job.activities = Array.isArray(d.activities) ? d.activities : [];
          job.todos = Array.isArray(d.todos) ? d.todos : [];
          job.ask = d.ask || null; // 重连时恢复待答问题
          if (d.model && d.model.model) job.pickLabel = shortModel(d.model.model, d.model.effort); // auto 判档标签
          job.rev++;
          if (d.session_id) {
            convSetSession(convId, d.session_id);
            if (visible()) currentSession = d.session_id;
          }
          convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
          if (visible()) {
            job._paintedShown = -1;
            paintJob(job);
            ensureTyping();
          }
          // 排队消息对账：仍在服务端持有的保留排队态；不在的已进入任务（关页期间被消费）。
          // 仅运行中对账——已结束 run 的补发 done 会带 unsent，交给 done 处理器标「未发送」
          if (d.status === 'running') {
            const held = Array.isArray(d.held) ? d.held : [];
            const conv = loadConvs().find((x) => x.id === convId);
            if (conv) {
              conv.messages.forEach((m, i) => {
                if (m.queued && m.runId === runId && !held.includes(m.msgId)) setMsgQueuedState(convId, i, null);
              });
            }
          }
          refreshAskChip();
        });
        es.addEventListener('chunk', (e) => {
          job.text += JSON.parse(e.data).text;
          saveThrottled();
          if (visible()) ensureTyping();
        });
        es.addEventListener('activity', (e) => {
          const s = JSON.parse(e.data).summary || '';
          if (s) {
            job.activities.push(s); // 累积工具转录
            if (job.activities.length > 50) job.activities.shift();
            job.rev++;
          }
          if (visible()) ensureTyping();
        });
        es.addEventListener('todos', (e) => {
          job.todos = JSON.parse(e.data).todos || []; // TodoWrite 任务清单
          job.rev++;
          if (visible()) ensureTyping();
        });
        es.addEventListener('ask', (e) => {
          job.ask = JSON.parse(e.data); // { reqId, kind, title, body, options } 等待用户决策
          job.rev++;
          if (visible()) ensureTyping();
          refreshAskChip();
        });
        // auto 模式：判档异步于 /start 返回，实际所用模型经此事件补告
        es.addEventListener('model', (e) => {
          const d = JSON.parse(e.data);
          if (d.model) {
            job.pickLabel = shortModel(d.model, d.effort);
            job._paintedStatus = ''; // 强制状态行重绘出新标签
            if (visible()) ensureTyping();
          }
        });
        es.addEventListener('ratelimit', (e) => renderRateLimit(JSON.parse(e.data)));
        // 排队消息进入任务：切段（定稿当前助手气泡+新占位）+ 清除排队标记
        es.addEventListener('consumed', (e) => {
          const ids = JSON.parse(e.data).msgIds || [];
          // 累积已消费 id：msgId 回填（fetch 响应）可能晚于本事件，steer 回填后据此补清排队态
          if (!job._consumedIds) job._consumedIds = new Set();
          ids.forEach((x) => job._consumedIds.add(x));
          const conv = loadConvs().find((x) => x.id === convId);
          if (!conv) return; // 会话已删 → 不切段，避免产生 asstIndex=-1 的脏状态
          splitSegment(job);
          conv.messages.forEach((m, i) => {
            if (m.queued && ids.includes(m.msgId)) setMsgQueuedState(convId, i, null);
          });
        });
        es.addEventListener('done', (e) => {
          const d = JSON.parse(e.data);
          if (Array.isArray(d.unsent) && d.unsent.length) {
            // run 终结时仍未消费的排队消息 → 标「未发送」（手动停止/异常/看门狗/重连补发）
            const conv = loadConvs().find((x) => x.id === convId);
            if (conv) {
              conv.messages.forEach((m, i) => {
                if (m.msgId && d.unsent.includes(m.msgId)) setMsgQueuedState(convId, i, 'unsent');
              });
            }
          }
          if (!job.text && d.result) job.text = d.result;
          if (d.subtype === 'stopped') {
            // 只扫当前段：插话定稿的前段若恰含同款标记，不应挡掉本段追加
            if (!job.text.slice(job.base).includes('⏹')) job.text += (job.text ? '\n\n' : '') + '⏹ 已手动停止';
          } else if (d.subtype === 'quota_blocked') {
            if (d.result) job.text = d.result; // 服务端已附「额度用尽，将自动续跑」提示
          } else if (d.is_error) {
            job.err = true; // 异常结束：明确标注 subtype，区分“跑完”与“异常退出”
            if (d.result && d.result.includes('⚠️')) job.text = d.result; // 服务端已附具体原因（如看门狗），不要丢
            if (!job.text.slice(job.base).includes('⚠️')) {
              job.text +=
                (job.text ? '\n\n' : '') +
                '⚠️ Claude 异常结束' +
                (d.subtype && d.subtype !== 'success' ? `（${d.subtype}）` : '');
            }
          }
          if (job.base > job.text.length) job.base = 0; // 兜底：镜像被短错误文本替换（run 已被 GC）时归零，避免切空
          if (!job.text.slice(job.base)) job.text += '(无输出)'; // 按段判空：插话后本段无新增输出也给占位
          job.shown = job.text.length; // 收尾补完剩余字符
          convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
          convSetMsgFields(convId, job.asstIndex, { pending: false });
          endJob(convId, job.err);
          refreshDiskHistory(); // 会话完成后刷新磁盘历史，保证 sessionId 去重及时生效
        });
        es.addEventListener('error', (e) => {
          if (e.data) {
            // 服务端主动报错（如 run 不存在/已过期）
            let m = '发生错误';
            try {
              m = JSON.parse(e.data).message;
            } catch {}
            // 「run 不存在」：进程重启后 run 注册表清空，但 pending 机制会续跑。
            // 改为静默等待（不报错），让 refreshPending 的 resuming 分支自动接新 run 流
            if (m.includes('run 不存在') || m.includes('已过期')) {
              // 静默：保持 pending 状态，等 refreshPending 检测到 resuming 状态的新 runId 时自动接流
              // （不调 endJob，不显示错误提示，spinner 继续转，job 继续等待）
              // 进程重启丢失持有区：本 run 的排队消息标「未发送」（续跑只续 session，不带排队消息）
              // 边界：run 已正常跑完但被 GC 时也走此路径，可能把实际已消费的消息误标未发送（无真相来源，保守处理）
              const conv = loadConvs().find((x) => x.id === convId);
              if (conv) {
                conv.messages.forEach((msg, i) => {
                  if (msg.queued && msg.runId === runId) setMsgQueuedState(convId, i, 'unsent');
                });
              }
              job.pending = true; // 标记为等待状态，refreshPending 据此切换 runId 时重新接流
              es.close();
              return;
            }
            // 其它错误 → 正常报错并终结
            job.text = (job.text ? job.text + '\n\n' : '') + '⚠️ ' + m;
            job.err = true;
            job.shown = job.text.length;
            if (job.base > job.text.length) job.base = 0; // 兜底：镜像被短错误文本替换（run 已被 GC）时归零，避免切空
            convSetMessage(convId, job.asstIndex, job.text.slice(job.base));
            convSetMsgFields(convId, job.asstIndex, { pending: false });
            endJob(convId, true);
          }
          // 无 e.data：传输层断开，EventSource 会自动重连并重放，无需处理（spinner 继续转）
        });
      }

      /** 需求系统任务（自动开发/API 修正/BUG 修复）的 run 由服务端发起：本地既无 runningJobs、
       *  会话里也没有预塞的 pending 气泡，openConv 的三条重连路径全不命中 → 主体区只剩顶部 busy 芯片、
       *  看不到实现进度。req-chat 在 busy.runId 出现时调用本函数，补种一个 pending 助手气泡并接管该 run
       *  的流（attachStream 的 replay 会从服务端拉回已产出的权威全文），之后与普通任务完全一致：
       *  逐字进度 / 工具活动 / TodoWrite 面板都可见，且 job.runId 就绪即可插话（随时发消息纠偏）。
       *  幂等：同一 run 反复调用（3s 轮询）只接一次；系统任务前后接替（develop→api-fix，runId 变）
       *  时旧 job 已被 endJob 清除，自然补种新气泡。 */
      export function ensureConvRunAttached(convId, runId) {
        if (!convId || !runId) return;
        if (convId !== currentConvId) return; // 只为当前查看的会话接流，避免把气泡塞到别的会话
        const existing = runningJobs[convId];
        if (existing && existing.runId === runId) return; // 已接同一 run，勿重复接
        // 刷新页面后 openConv 可能已按持久化的 pending 气泡重连过：会话里已存在该 run 的 pending 气泡则不重复接
        const conv = loadConvs().find((x) => x.id === convId);
        if (conv && conv.messages.some((m) => m.pending && m.runId === runId)) return;
        const idx = convPushMessage(convId, 'assistant', '');
        convSetMsgFields(convId, idx, { pending: true, runId });
        addMessage('assistant', '');
        attachStream(convId, idx, runId);
      }

      /** 飞书补充内容上屏：服务端注入的用户消息本地没有气泡（消息不是从本浏览器发出的），
       *  这里补种「用户气泡 + 助手 pending 气泡」并接管该 run 的流，与本地发送后的形态完全一致。
       *  只处理当前会话：addMessage 只会把气泡登记进 currentConvId 的 _bubbleMap，
       *  非当前会话上屏会当场撕裂「存储=DOM=_bubbleMap 三方同序」不变量，故直接放弃（留给下次 openConv 轮询补）。
       *  幂等：ensureConvRunAttached 自带 runId 去重；用户气泡靠服务端 claim 去重（认领后不再下发）。
       *  返回已上屏的 item id 数组，调用方据此调 /claim。 */
      export async function applyInjectedItems(convId, items) {
        if (!convId || convId !== currentConvId || !Array.isArray(items) || !items.length) return [];
        const applied = [];
        for (const it of items) {
          if (!it || !it.text) continue;
          const idx = convPushMessage(convId, 'user', it.text);
          if (idx < 0) continue; // 会话已被删除：落库失败就不能上屏，否则 DOM 比存储多一条
          convSetMsgFields(convId, idx, { msgId: it.id });
          await addMessage('user', it.text);
          if (it.runId) ensureConvRunAttached(convId, it.runId);
          applied.push(it.id);
        }
        return applied;
      }

      /**
       * 绕过输入框直接发送一条消息：自动开发/api-fix/准则更新等「程序化发送」场景。
       * 若当前会话正在运行 → 插话（steer）；否则 → 新起一轮（launchRun）。
       * opts.mode：权限模式覆盖（如 'bypassPermissions'），不影响用户后续输入框发送的默认模式。
       * 前置条件：currentConvId 已就位（由调用方确保，通常在 openConv 之后）。
       */
      export async function sendMessageProgrammatically(text, opts = {}) {
        if (!text || !currentConvId) return;
        const running = runningJobs[currentConvId];
        if (running) {
          // 当前 run 进行中 → 插话排队（撤回/立即生效均可，与普通用户消息完全一致）
          return await steer(running, text);
        }
        const convId = currentConvId;
        const sessionId = currentSession;
        const runCwd = cwd;

        await addMessage('user', text);
        recordMessage('user', text);
        // 不清空输入框（clearPrompt）——这不是用户输入

        const asstIndex = convPushMessage(convId, 'assistant', '');
        convSetMsgFields(convId, asstIndex, { pending: true });
        addMessage('assistant', '');

        const job = {
          es: null,
          asstIndex,
          convId,
          text: '',
          shown: 0,
          base: 0,
          activities: [],
          todos: [],
          ask: null,
          rev: 0,
          err: false,
          runId: null,
        };
        runningJobs[convId] = job;
        updateComposerRunning();
        renderConvListDebounced();
        paintJob(job);
        ensureTyping();

        launchRun(job, text, sessionId, runCwd, opts.mode || null);
      }

      const _reqTranscriptTried = new Set(); // convId:sessionId 本会话周期已尝试回放，避免 mount 抖动重复请求
      /** 已完成的开发/系统任务：其过程只有在「客户端当时正挂着实时流」时才落 localStorage；若当时无人观看，
       *  会话里就空空如也（正是「点开已完成需求看不到运行过程」的成因）。但 Claude 的 session 转录一直在磁盘上
       *  （req.devSession）。本函数在「无实时流且会话无内容」时，按 devCwd 定位并拉取 session 转录
       *  （GET /api/history/:sid?cwd=）整体回放到聊天区。注意：history 抽取只保留文本块（助手叙述/结果），
       *  工具活动细节不在其中——与 app 既有「续接磁盘历史会话」的呈现一致。 */
      export async function loadReqTranscript(convId, sessionId, cwd) {
        if (!convId || !sessionId || convId !== currentConvId) return;
        if (runningJobs[convId]) return; // 有实时流在跑 → 交给流，别灌历史
        const conv0 = loadConvs().find((x) => x.id === convId);
        if (conv0 && conv0.messages.some((m) => (m.text || '').trim())) return; // 已有输出（实时流已落库/已灌过）
        const key = convId + ':' + sessionId;
        if (_reqTranscriptTried.has(key)) return; // 本周期只尝试一次（mount + 3s 轮询会反复调）
        _reqTranscriptTried.add(key);
        let json;
        try {
          const r = await fetch('/api/history/' + encodeURIComponent(sessionId) + '?cwd=' + encodeURIComponent(cwd || ''));
          json = await r.json();
        } catch {
          _reqTranscriptTried.delete(key); // 网络失败：允许下次重试
          return;
        }
        if (!json?.ok || convId !== currentConvId || runningJobs[convId]) return; // 往返期间切走/实时流已起 → 放弃
        const msgs = json.data?.messages || [];
        if (!msgs.length) return; // 无转录（会话未落盘/被清）——保持空态
        const list = loadConvs();
        const c = list.find((x) => x.id === convId);
        if (!c || c.messages.some((m) => (m.text || '').trim())) return; // 二次校验：往返期间已有内容
        // 重建：清 DOM + 气泡缓存 + 会话消息，按转录整体重灌（此路径必无实时流，三方同序安全）
        messagesEl.querySelectorAll('.msg').forEach((el) => el.remove());
        bubbleReset(convId);
        c.messages = [];
        saveConvs(list);
        emptyEl.style.display = 'none';
        for (const m of msgs) {
          convPushMessage(convId, m.role, m.content);
          await addMessage(m.role, m.content);
        }
      }

      /** 为目录开新项目窗口（一窗一项目）：Tauri 经 win_new（上下文由 Rust initialization_script 注入，
       *  不走 URL query——打包版 custom protocol 下 query 会致新窗白屏）；浏览器开新标签走 URL。 */
      function openProjectWindow(dir, convId) {
        const label = '已在新窗口打开：' + (baseName(dir) || '(服务目录)');
        if (window.tauriApi?.isTauri && window.tauriApi.invoke) {
          window.tauriApi
            .invoke('win_new', { cwd: dir, conv: convId || null })
            .then(() => toast(label))
            .catch((e) => toast('开新窗口失败：' + (e?.message || e)));
        } else {
          const query = '?cwd=' + encodeURIComponent(dir) + (convId ? '&conv=' + encodeURIComponent(convId) : '');
          window.open('/' + query, '_blank');
          toast(label);
        }
      }
      function selectDir(p) {
        // 一窗一项目：本窗已有项目目录且选了不同目录 → 新窗口承载新项目，本窗不动
        if (cwd && p && p !== cwd) {
          closeDirModal();
          openProjectWindow(p);
          return;
        }
        cwd = p;
        lsSet('claude_cwd', cwd);
        saveUiPrefs(); // 同步到服务端配置
        refreshDirLabel();
        closeDirModal();
        historyRange = 'used';    // 切目录后收起到本次会话
        historyCacheExpire = 0; // 目录变了，磁盘历史缓存失效
        refreshDiskHistory(); // 历史跟随新工作目录刷新左栏
      }

      // ---- 事件绑定 ----
      sendBtn.addEventListener('click', send);
      stopBtn.addEventListener('click', stopCurrentRun);

      // 模型 / 强度悬浮控件（右下角，极简）
      const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

      // 内置工具列表（与 run-claude.js TOOL_DISABLE_ALIASES 保持一致）
      const BUILTIN_TOOLS = [
        { id: 'Bash',      label: 'Bash',    desc: '执行终端命令' },
        { id: 'Write',     label: '写入',    desc: '创建/覆盖文件' },
        { id: 'Edit',      label: '编辑',    desc: '修改文件内容（含 MultiEdit）' },
        { id: 'Read',      label: '读取',    desc: '读取文件内容（含 NotebookRead）' },
        { id: 'Grep',      label: '搜索',    desc: '搜索文件（含 Glob / LS）' },
        { id: 'WebSearch', label: '网页搜索', desc: '搜索互联网' },
        { id: 'WebFetch',  label: '网页抓取', desc: '获取网页内容' },
        { id: 'Task',      label: '子代理',  desc: '启动子任务代理（含 Agent）' },
        { id: 'TodoWrite', label: '任务清单', desc: '管理待办清单' },
      ];

      /** 创建一个工具行 DOM（含 toggle switch） */
      function makeToolRow(labelText, descText, enabled, onChange) {
        const row = document.createElement('div');
        row.className = 'tool-row';
        const nameEl = document.createElement('span');
        nameEl.className = 'tool-row-name' + (enabled ? '' : ' off');
        nameEl.textContent = labelText;
        nameEl.title = descText;
        const lbl = document.createElement('label');
        lbl.className = 'tool-toggle';
        lbl.title = enabled ? '点击禁用' : '点击启用';
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.checked = enabled;
        inp.addEventListener('change', () => {
          nameEl.className = 'tool-row-name' + (inp.checked ? '' : ' off');
          lbl.title = inp.checked ? '点击禁用' : '点击启用';
          onChange(inp.checked);
        });
        const slider = document.createElement('span');
        slider.className = 'toggle-slider';
        lbl.appendChild(inp);
        lbl.appendChild(slider);
        row.appendChild(nameEl);
        row.appendChild(lbl);
        return row;
      }

      /** 渲染内置工具 + MCP 服务器 toggle 列表 */
      async function refreshToolsSection() {
        const builtinList = document.getElementById('builtinToolsList');
        const mcpList = document.getElementById('mcpToolsList');
        const mcpDivider = document.getElementById('mcpToolsDivider');
        if (!builtinList) return;

        // 内置工具
        builtinList.innerHTML = '';
        BUILTIN_TOOLS.forEach(({ id, label, desc }) => {
          const enabled = !chatDisabledTools.includes(id);
          const row = makeToolRow(label, desc, enabled, (checked) => {
            if (checked) {
              chatDisabledTools = chatDisabledTools.filter((t) => t !== id);
            } else {
              if (!chatDisabledTools.includes(id)) chatDisabledTools.push(id);
            }
            lsSet('claude_disabled_tools', JSON.stringify(chatDisabledTools));
            saveUiPrefs();
          });
          builtinList.appendChild(row);
        });

        // MCP 服务器
        if (mcpList) {
          try {
            const r = await fetch('/api/mcp-servers');
            const d = await r.json();
            const servers = (d.servers || []).filter((s) => s && s.id);
            mcpList.innerHTML = '';
            if (mcpDivider) mcpDivider.hidden = servers.length === 0;
            servers.forEach((srv) => {
              const row = makeToolRow(
                srv.label || srv.command || srv.id,
                'MCP: ' + (srv.command || srv.id),
                srv.enabled !== false,
                async (checked) => {
                  try {
                    const res = await fetch('/api/mcp-servers/' + encodeURIComponent(srv.id), {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ enabled: checked }),
                    });
                    if (!res.ok) throw new Error('server error');
                    srv.enabled = checked;
                  } catch {
                    // 回滚 UI
                    const inp = row.querySelector('input');
                    if (inp) { inp.checked = !checked; inp.dispatchEvent(new Event('change')); }
                    toast('MCP 服务器状态更新失败');
                  }
                },
              );
              mcpList.appendChild(row);
            });
          } catch {
            if (mcpDivider) mcpDivider.hidden = true;
          }
        }
      }
      const MODEL_LABELS = {
        auto: 'Auto',
        'claude-opus-5': 'Opus 5',
        'claude-sonnet-5': 'Sonnet 5',
        'claude-haiku-5': 'Haiku 5',
      };
      const MODE_LABELS = {
        default: '询问',
        acceptEdits: '接受编辑',
        plan: '计划',
        bypassPermissions: '自动',
      };
      const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
      const modelFab = $('#modelFab');
      const modelFabBtn = $('#modelFabBtn');
      const modelFabLabel = $('#modelFabLabel');
      const modelPop = $('#modelPop');
      const modelPills = $('#modelPills');
      const modePills = $('#modePills');
      const customModelPills = $('#customModelPills');
      const effortRow = $('#effortRow');
      const effortSlider = $('#effortSlider');
      if (!MODEL_LABELS[chatModel]) chatModel = 'auto';
      if (!EFFORTS.includes(chatEffort)) chatEffort = 'medium';
      if (!MODES.includes(chatMode)) chatMode = 'default';
      function syncModelUI() {
        if (chatProvider === 'openai-compat') {
          modelFabLabel.textContent = chatCustomLabel || chatCustomModel || '自定义模型';
          [...modelPills.children].forEach((b) => b.classList.remove('active'));
          // 按 cid 高亮：同 model 多条凭证时，按 model 匹配会同时点亮好几个 pill
          [...customModelPills.children].forEach((b) => b.classList.toggle('active', b.dataset.cid === chatCustomCredId));
          effortRow.classList.add('disabled'); // openai v1 无 effort
          modePills.classList.add('disabled'); // openai v1 无权限模式
          return;
        }
        modelFabLabel.textContent = MODEL_LABELS[chatModel];
        [...modelPills.children].forEach((b) => b.classList.toggle('active', b.dataset.m === chatModel));
        [...customModelPills.children].forEach((b) => b.classList.remove('active'));
        [...modePills.children].forEach((b) => b.classList.toggle('active', b.dataset.mode === chatMode));
        modePills.classList.remove('disabled');
        effortRow.classList.toggle('disabled', chatModel === 'auto'); // Auto 时强度由分类器决定
        effortSlider.value = String(Math.max(0, EFFORTS.indexOf(chatEffort)));
      }

      // 打开弹层时拉取已配置的自定义模型，动态填充 pills
      async function refreshCustomModelPills() {
        try {
          const r = await fetch('/api/credentials');
          const d = await r.json();
          const creds = d.credentials || [];
          customModelPills.innerHTML = '';
          creds.forEach((c) => {
            const b = document.createElement('button');
            b.dataset.m = c.model;
            b.dataset.cid = c.id; // 高亮与发送都认 id：同 model 的多条凭证（不同 key/厂商）才区分得开
            b.textContent = c.label || c.model;
            b.title = (c.label ? c.label + ' · ' : '') + c.model;
            b.addEventListener('click', () => {
              chatProvider = 'openai-compat';
              chatCustomModel = c.model;
              chatCustomLabel = c.label || c.model;
              chatCustomCredId = c.id;
              lsSet('claude_provider', chatProvider);
              lsSet('claude_custom_model', chatCustomModel);
              lsSet('claude_custom_label', chatCustomLabel);
              lsSet('claude_custom_cred_id', chatCustomCredId);
              syncModelUI();
              persistPrefsToConv();
              modelPop.hidden = true;
              if (currentConvId && runningJobs[currentConvId]) toast('模型将从下一条消息生效');
            });
            customModelPills.appendChild(b);
          });
          // 在用的凭证若已被删除 → 回退 Claude，避免继续发送指向已删凭证的请求。
          // 按 id 判定：同名 model 的另一条凭证还在，不代表**这一条**还在，
          // 按 model 匹配会让删除后的选择静默漂移到另一个账号上。
          // 升级路径：老用户没有 credId（此前不存），按 model 兜底认一次，
          // 认到就把 id 补上，不至于一升级就被踢回 Claude。
          if (chatProvider === 'openai-compat') {
            let cur = chatCustomCredId ? creds.find((c) => c.id === chatCustomCredId) : null;
            if (!cur && !chatCustomCredId) cur = creds.find((c) => c.model === chatCustomModel);
            if (cur) {
              if (cur.id !== chatCustomCredId) {
                chatCustomCredId = cur.id;
                lsSet('claude_custom_cred_id', chatCustomCredId);
                persistPrefsToConv();
              }
            } else {
              chatProvider = 'claude-agent';
              chatCustomCredId = '';
              lsSet('claude_provider', chatProvider);
              lsSet('claude_custom_cred_id', '');
              persistPrefsToConv();
            }
          }
          const divider = $('#customDivider');
          if (divider) divider.hidden = creds.length === 0;
          syncModelUI();
        } catch {
          /* 忽略：拉取失败不影响 Claude 选择 */
        }
      }
      syncModelUI();
      // 会话级偏好还原：仅接受白名单内的值（未知模型/模式一律忽略），实际变化才刷 UI + 提示
      function applySessionPrefs(prefs) {
        let changed = false;
        // 自定义模型（openai-compat）不在 MODEL_LABELS 白名单，单独还原；缺 provider 字段视为 Claude 会话
        const nextProvider = prefs.provider === 'openai-compat' ? 'openai-compat' : 'claude-agent';
        if (nextProvider !== chatProvider) {
          chatProvider = nextProvider;
          lsSet('claude_provider', chatProvider);
          changed = true;
        }
        if (chatProvider === 'openai-compat') {
          if (prefs.customModel && prefs.customModel !== chatCustomModel) {
            chatCustomModel = prefs.customModel;
            lsSet('claude_custom_model', chatCustomModel);
            changed = true;
          }
          if (prefs.customLabel && prefs.customLabel !== chatCustomLabel) {
            chatCustomLabel = prefs.customLabel;
            lsSet('claude_custom_label', chatCustomLabel);
          }
          // 凭证归属随会话还原。老会话没存过 customCredId：置空而非保留当前值——
          // 留着上一个会话的 id 会让这条会话拿别人的 key 发请求，比退化成
          // 服务端 pickActive 兜底更糟（后者至少是个确定行为，且会按 model 找）。
          const nextCredId = prefs.customCredId || '';
          if (nextCredId !== chatCustomCredId) {
            chatCustomCredId = nextCredId;
            lsSet('claude_custom_cred_id', chatCustomCredId);
          }
        }
        if (prefs.model && MODEL_LABELS[prefs.model] && prefs.model !== chatModel) {
          chatModel = prefs.model;
          lsSet('claude_model', chatModel);
          changed = true;
        }
        if (prefs.effort && EFFORTS.includes(prefs.effort) && prefs.effort !== chatEffort) {
          chatEffort = prefs.effort;
          lsSet('claude_effort', chatEffort);
          changed = true;
        }
        if (prefs.mode && MODES.includes(prefs.mode) && prefs.mode !== chatMode) {
          chatMode = prefs.mode;
          lsSet('claude_mode', chatMode);
          changed = true;
        }
        if (changed) {
          syncModelUI();
          const lbl =
            chatProvider === 'openai-compat'
              ? chatCustomLabel || chatCustomModel || '自定义模型'
              : MODEL_LABELS[chatModel] + ' · ' + MODE_LABELS[chatMode];
          toast('已还原此会话偏好：' + lbl);
        }
        // 飞书通知开关是会话级偏好（存 conv.meta.notifyFeishu），随其它偏好一起还原按钮态
        if (window.__convNotify) window.__convNotify.refreshBtn(prefs);
      }
      modelFabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        modelPop.hidden = !modelPop.hidden;
        if (!modelPop.hidden) {
          refreshCustomModelPills();
          refreshToolsSection();
        }
      });
      document.addEventListener('click', (e) => {
        if (!modelPop.hidden && !modelFab.contains(e.target)) modelPop.hidden = true;
      });
      [...modelPills.children].forEach((b) => {
        b.addEventListener('click', () => {
          if (b.dataset.m === chatModel && chatProvider === 'claude-agent') return; // 重复点当前：不触发
          chatModel = b.dataset.m;
          chatProvider = 'claude-agent'; // 从自定义切回 Claude
          lsSet('claude_model', chatModel);
          lsSet('claude_provider', chatProvider);
          saveUiPrefs(); // 同步到服务端配置
          syncModelUI();
          persistPrefsToConv();
          if (currentConvId && runningJobs[currentConvId]) toast('模型将从下一条消息生效');
        });
      });
      [...modePills.children].forEach((b) => {
        b.addEventListener('click', async () => {
          const mode = b.dataset.mode;
          if (mode === chatMode) return; // 重复点当前模式：不发多余请求、不弹误导提示
          chatMode = mode;
          lsSet('claude_mode', chatMode);
          saveUiPrefs(); // 同步到服务端配置
          syncModelUI();
          persistPrefsToConv();
          // 运行中任务：尝试即时切换（仅「询问」起跑可放宽为 接受编辑/自动）
          const job = currentConvId && runningJobs[currentConvId];
          if (!job || !job.runId) return;
          try {
            const r = await fetch('/api/run/set-mode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: job.runId, mode }),
            });
            const d = await r.json();
            toast(
              d.applied
                ? '当前任务已切换为「' + MODE_LABELS[mode] + '」'
                : '当前任务无法中途切换，将从下一条消息生效',
            );
          } catch {
            /* 网络失败不打扰：下一条消息仍会带上新模式 */
          }
        });
      });
      effortSlider.addEventListener('input', () => {
        chatEffort = EFFORTS[Number(effortSlider.value)] || 'medium';
        lsSet('claude_effort', chatEffort);
        persistPrefsToConv();
      });
      effortSlider.addEventListener('change', () => {
        saveUiPrefs(); // 同步到服务端配置（用户释放滑块时触发一次）
        if (currentConvId && runningJobs[currentConvId]) toast('思考强度将从下一条消息生效');
      });
      promptEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      });
      // 只有 Web 模式才绑 HTML5 拖拽。Tauri 原生拖拽接管后 dataTransfer.files 恒空，
      // 这三个监听永不触发——留着就是下一批「看着有、实际从不执行」的死代码，
      // 而本次要修的两个 bug 恰恰都是这么来的（tauri-init 那个 drag-drop 监听器同理）。
      // Tauri 模式的拖拽走 drag-bus 总线，注册在本文件顶部。
      //
      // 判据用 __TAURI_INTERNALS__ 而非 window.tauriApi?.isTauri：本段是 chat.js 的模块顶层
      // 同步代码，而 tauriApi 由 tauri-init.js 的异步 IIFE 在 `await import(vendor)` 之后才赋值
      // （app.js 先 import tauri-init 再 import chat，IIFE 早已挂起）——此刻读必然是 undefined，
      // 会被误判成 Web 模式。__TAURI_INTERNALS__ 是 Tauri v2 webview 里始终存在的同步全局量，
      // 无时序问题（tauri-init.js 自己判 isTauri 用的也是它）。
      if (typeof window.__TAURI_INTERNALS__ === 'undefined') {
        promptEl.addEventListener('dragover', (e) => {
          e.preventDefault();
          promptEl.classList.add('dragover');
        });
        promptEl.addEventListener('dragleave', (e) => {
          if (!promptEl.contains(e.relatedTarget)) promptEl.classList.remove('dragover');
        });
        promptEl.addEventListener('drop', handleDrop);
      }
      $('#sidebarNew').addEventListener('click', newConversation);

      // 会话列表右键菜单（事件委托到 convList）
      $('#convList').addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // 向上查找最近的 conv-item
        const row = e.target.closest('.conv-item');
        if (!row) return;
        const convId = row.dataset.convId;
        if (!convId) return; // 磁盘会话（web source）无 convId，暂不支持
        const isPinned = row.dataset.pinned === '1';
        _showCtxMenu(e.clientX, e.clientY, convId, isPinned);
      });

      // ---- 系统文件夹选择框（调 /api/dirs/pick，弹在本机桌面） ----
      $('#sysPickBtn').addEventListener('click', async () => {
        const btn = $('#sysPickBtn');
        const label = btn.textContent;
        btn.textContent = '选择中…';
        btn.disabled = true;
        try {
          const r = await (await fetch('/api/dirs/pick')).json();
          if (r.path) selectDir(r.path); // 选中即应用并关闭
          else if (r.error) window.toast.error(r.error);
          // r.path=null：用户点了取消，忽略
        } catch {
          window.toast.error('调用系统对话框失败');
        } finally {
          btn.textContent = label;
          btn.disabled = false;
        }
      });



      // ---- 额度用尽待续跑：轮询 + 等待横幅 + 续跑自动接流 ----
      const pendingMap = {}; // convId -> { resetsAt, status, runId }
      const handledResumes = new Set(); // 已接流的续跑 runId，避免重复
      const handledAbandoned = new Set(); // 已展示过终结提示的熔断会话，避免重复
      // 失效清除 / 熔断消费：请服务端按 convId 移除待续跑条目（不阻塞 UI）
      function dismissPending(convId) {
        if (!convId) return; // 防御：无 convId 不发请求（对齐 abortRun 模式）
        fetch('/api/run/pending/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ convId }),
        }).catch(() => {});
      }
      function fmtResetTime(sec) {
        try {
          return new Date(sec * 1000).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          });
        } catch {
          return '';
        }
      }
      function renderPendingBanner() {
        const banner = $('#pendingBanner');
        const p = currentConvId && pendingMap[currentConvId];
        if (p && p.status === 'waiting') {
          if (p.reason === 'orphan_recovery') {
            banner.textContent = `🔄 进程重启，任务自动续接中…`;
          } else {
            // quota_exhausted 或默认情况
            banner.textContent = `⏳ 额度用尽，本任务将于 ${fmtResetTime(p.resetsAt)}（token 重置）后自动继续`;
          }
          banner.hidden = false;
        } else {
          banner.hidden = true;
        }
      }
      async function refreshPending() {
        let list;
        try {
          ({ pending: list } = await (await fetch('/api/run/pending')).json());
        } catch {
          return;
        }
        for (const k in pendingMap) delete pendingMap[k];
        let waiting = 0;
        for (const e of list || []) {
          pendingMap[e.convId] = { resetsAt: e.resetsAt, status: e.status, runId: e.runId, reason: e.reason };
          if (e.status === 'waiting') waiting++;
          // 熔断：连续续跑失败达上限 → 展示一次终结提示（仅当前会话）并 dismiss 移除
          if (e.status === 'abandoned') {
            if (!handledAbandoned.has(e.convId)) {
              handledAbandoned.add(e.convId);
              if (e.convId === currentConvId && !runningJobs[e.convId]) {
                const note =
                  '⚠️ 连续 ' +
                  (e.attempts || '多') +
                  ' 次自动续跑均未完成，已停止自动续跑；如需继续请手动发送消息。';
                const idx = convPushMessage(e.convId, 'assistant', note);
                if (idx >= 0) addMessage('assistant', note);
                scrollBottom();
                renderConvListDebounced(); // 与 resuming 分支一致：终结提示后刷新左栏
              }
              dismissPending(e.convId);
            }
            continue;
          }
          // 续跑已开始 → 仅为「当前打开的会话」接流（隔离：不向他会话/新会话塞气泡）
          if (
            e.status === 'resuming' &&
            e.runId &&
            e.convId === currentConvId
          ) {
            const c = loadConvs().find((x) => x.id === e.convId);
            if (c) {
              // 如果是新 runId（前一个失败了），重新接流；如果已接过则跳过
              if (!handledResumes.has(e.runId) && !runningJobs[e.convId]) {
                handledResumes.add(e.runId);
                const idx = convPushMessage(e.convId, 'assistant', '');
                convSetMsgFields(e.convId, idx, { pending: true, runId: e.runId });
                addMessage('assistant', '');
                attachStream(e.convId, idx, e.runId);
                renderConvListDebounced();
              } else if (runningJobs[e.convId]) {
                // 已有运行中的 job，但 runId 可能因 run 不存在而需要更新
                // 检查该 job 是否是 pending 状态（run 不存在导致的静默等待）
                const job = runningJobs[e.convId];
                if (job.pending && job.runId !== e.runId) {
                  // runId 变了（新续跑），切换接流
                  job.runId = e.runId;
                  job.pending = false; // 清除等待标志，重新接流正式开始
                  handledResumes.add(e.runId);
                  attachStream(e.convId, job.asstIndex, e.runId);
                }
              }
            }
          }
        }
        const chip = $('#pendingChip');
        chip.hidden = waiting === 0;
        chip.textContent = waiting ? `⏳ ${waiting} 个任务待续跑` : '';
        renderPendingBanner();
      }

      // ---- 启动初始化（聊天相关行，迁自 app.js 启动节；顺序保持原样，由壳编排调用） ----
      export function initChat() {
      refreshDirLabel(); // 回填上次选择的工作目录（localStorage 快速渲染）
      initUiPrefs();     // 异步从服务端同步偏好（跨重启恢复；覆盖 localStorage 默认值）
      renderConvList(); // 渲染左侧对话历史
      // 刷新后自动回到上次打开的会话：运行中任务经 openConv 的 pending+runId 扫描自动重连。
      // setTimeout(0)：openConv 依赖脚本尾部才初始化的 AnimeAnimations（const TDZ），须等本轮求值结束
      {
        // URL ?conv= 优先（跨项目点击/新窗定向）；否则回上次会话——但仅限属于本窗项目的会话（一窗一项目）
        const target = _urlConv || localStorage.getItem('claude_last_conv');
        const c = target ? loadConvs().find((x) => x.id === target) : null;
        if (c && (_urlConv || (c.cwd || '') === (cwd || ''))) setTimeout(() => openConv(c.id), 0);
      }
      refreshDiskHistory(); // 拉取磁盘历史会话，合并进左栏
      refreshPending(); // 额度用尽待续跑轮询
      setInterval(refreshPending, 15000);
      }

      /** 回聊天视图时吸底：display:none 会丢滚动位置，返回时恢复到底部（由壳的视图切换 chat 分支调用） */
      export function chatOnShow() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      // AnimeAnimations 初始化完成，补救首帧渲染时被标记为待绑定的 cursor 动画
      requestAnimationFrame(() => {
        document.querySelectorAll('.title-text[data-conv-id]').forEach((titleEl) => {
          if (titleEl._pendingCursor) {
            AnimeAnimations.startCursorLoop(titleEl);
            delete titleEl._pendingCursor;
          }
        });
        if (emptyEl && emptyEl.style.display !== 'none') {
          AnimeAnimations.playVibeAnimation();
        }
      });

      // 页面关闭前强制写 localStorage，防止防抖窗口内的数据丢失
      window.addEventListener('beforeunload', flushConvs);

      // ---- 导出：侧栏会话树查询运行状态灯 ----
      export function isConvRunning(convId) {
        return runningJobs[convId] ? true : false;
      }

      /** 当前会话 id 的只读出口。conv-notify 的开关/轮询必须**实时**取它：
       *  localStorage 的 claude_last_conv 是多窗共享的，另开一个项目窗口就会被改写，
       *  拿它当当前会话会让轮询盯错会话；而缓存一次同样不行（resumeHistorySession 不走 openConv）。 */
      export function getCurrentConvId() {
        return currentConvId;
      }

      /**
       * Task 5.4：后台发送消息，启动一次 run（不产生用户气泡）。
       * @param {string} convId 会话 ID
       * @param {string} text 消息文本（提示词）
       * @returns {Promise<void>} 返回已连接 SSE 的 Promise
       */
      export async function sendMessageBackground(convId, text) {
        const list = loadConvs();
        const conv = list.find(c => c.id === convId);
        if (!conv) throw new Error(`Conv ${convId} not found`);

        // 创建 job 对象（不显示用户气泡，直接启动 run）
        const job = {
          es: null,
          asstIndex: -1,  // 后台会话：无可见气泡，留作占位
          convId: convId,
          text: '',
          shown: 0,
          base: 0,
          activities: [],
          todos: [],
          ask: null,
          rev: 0,
          err: false,
          runId: null,
        };

        // 添加助手占位气泡到存储侧（不显示）
        const asstIndex = convPushMessage(convId, 'assistant', '');
        convSetMsgFields(convId, asstIndex, { pending: true });
        job.asstIndex = asstIndex;

        // 注册为运行中的 job（防止多次重复启动）
        runningJobs[convId] = job;

        return new Promise((resolve, reject) => {
          // 启动 run（与 send() 的 launchRun 流程一致）
          const sessionId = conv.session || null;
          const runCwd = cwd || '';
          const effectiveMode = chatMode;
          const startBody =
            chatProvider === 'openai-compat'
              ? { prompt: text, cwd: runCwd, session: sessionId, provider: 'openai-compat', model: chatCustomModel, credId: chatCustomCredId, convId }
              : { prompt: text, cwd: runCwd, session: sessionId, model: chatModel, effort: chatEffort, mode: effectiveMode, convId };

          fetch('/api/run/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(startBody),
          })
            .then((r) => r.json())
            .then((d) => {
              if (!d.runId) throw new Error(d.error || '启动失败');
              job.runId = d.runId;
              if (d.model) {
                job.pickLabel = shortModel(d.model, d.effort);
              }
              convSetMsgFields(convId, job.asstIndex, { runId: d.runId });
              // 接流（后台会话不显示）
              attachStream(convId, job.asstIndex, d.runId, job);
              // resolve：SSE 已连接并开始接收
              resolve();
            })
            .catch((err) => {
              job.text = '⚠️ ' + (err && err.message ? err.message : '启动失败');
              job.err = true;
              convSetMessage(convId, job.asstIndex, job.text);
              convSetMsgFields(convId, job.asstIndex, { pending: false });
              endJob(convId, true);
              reject(err);
            });
        });
      }

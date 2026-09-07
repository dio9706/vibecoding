import './js/bootstrap.js'; // 必须最先：打包模式 fetch/EventSource 补丁
import { whenBackendReady, setOverlayHandoff } from './js/boot-gate.js'; // 须在 bootstrap 之后：依赖其 fetch 补丁
import { armNetworkGuard } from './js/net-guard.js';
import { showOfflineOverlay, hideOfflineOverlay } from './js/offline-overlay.js';
import { maybeStartOnboarding } from './js/onboarding.js';
import { bindTauriNav } from './js/tauri-init.js';
import { $ } from './js/util.js';
import { initJsonTool } from './js/json-tool.js';
import { loadLogs } from './js/logs-panel.js';
import { loadSettings, bindConfigTransfer } from './js/settings-panel.js';
import './js/actions-panel.js'; // 副作用：动作配置面板自绑定
import './js/bots-panel.js'; // 副作用：机器人面板自绑定（托管配置 tab）
import './js/sidebar.js'; // 副作用：侧边栏展开/收起自初始化
import { startTaskPolling, stopTaskPolling, requestNotifyPermission, refreshTaskBadge, bindTasksNav } from './js/tasks-panel.js';
import { initChat, chatOnShow, bindChatNav, bindMarkdownNav, refreshAskChip, openConv, renderConvListNow, applyInjectedItems, getCurrentConvId } from './js/chat.js';
import { bindConvNotify } from './js/conv-notify.js';
import { initReqView, refreshReqList, renderReqListLocal } from './js/req-view.js';
import { initReqChat } from './js/req-chat.js';
import { initMemoryPanel, refreshMemBadge } from './js/memory-view.js';
import { initOptimizePanel } from './js/optimize-view.js';
import { initProjectMapPanel, disposeProjectMapView } from './js/project-map-panel.js';
import toast from './js/toast.js';
import { hydrateIcons } from './js/icons.js';

// 初始化 Toast 组件
window.toast = toast;
toast._init();

// index.html 里的 data-icon 占位注水。放在最前面：顶栏图标在启动闸门撤罩前就已可见，
// 晚一步会先闪一个空按钮。
hydrateIcons();

// 掉线守卫接线：判定逻辑在 net-guard，展示在 offline-overlay，此处把两者接起来。
// 必须在 hydrateIcons 之后、任何业务请求之前——arm 之前的上报会被 net-guard 直接丢弃
//（那个阶段还归 boot-gate 的启动罩管）。
armNetworkGuard({ onDown: showOfflineOverlay, onUp: hideOfflineOverlay });

bindTasksNav(() => showView('behavior'), () => activeView === 'behavior'); // 视图桥：跳转 + 活跃态查询
bindChatNav(() => showView('chat'), () => activeView === 'chat'); // 视图桥：回聊天视图跳转 + 聊天视图是否激活（供顶栏审批徽标判定）
bindTauriNav({ showView, openConv }); // 视图桥：托盘菜单 show-view 跳视图 + 点桌面通知回到对应会话（showView 提升；openConv 由 chat.js 导出）
bindConvNotify({ applyInjected: applyInjectedItems, getCurrentConvId }); // 🔔 飞书开关 + 补充内容收件箱轮询（getCurrentConvId 传函数引用，模块内实时取，不缓存）
// 新用户引导：注册给 boot-gate 的撤罩钩子。必须在下方 whenBackendReady() 被调用前注册。
// 判定为老用户（已有任意模型）时 maybeStartOnboarding 返回 false，罩子照常撤，行为零变化。
setOverlayHandoff(maybeStartOnboarding);

      // ---- 嵌入式面板视图（chat=对话 | settings | tasks | logs），替代原弹层 ----
      const appEl = $('.app');
      const panelView = $('#panelView');
      let activeView = 'chat';
      function showView(name) {
        if (activeView === name) return;
        if (activeView === 'behavior') stopTaskPolling(); // 离开行为视图停轮询
        // 离开地图视图收 WebGL：面板只是 hidden，容器仍在 DOM 里，地球的 rAF 自检拦不住
        if (activeView === 'project-map') disposeProjectMapView();
        activeView = name;
        const inChat = name === 'chat';
        appEl.classList.toggle('in-panel', !inChat);
        appEl.classList.toggle('in-json-tool', name === 'json-tool'); // JSON 工具视图额外隐藏底部输入框
        // Markdown 是纯查看视图：隐藏输入框腾高度，并把滚动从 panel-view 收回到 #mdContent，
        // 否则一滚动工具栏/目录大纲/搜索框会被整体推出可视区
        appEl.classList.toggle('in-markdown', name === 'markdown');
        appEl.classList.toggle('in-req', name === 'req'); // 需求文档模式（评审/归档期）无会话语义：隐藏底部输入框，防止误发消息跳回聊天视图
        // 地图同 markdown：纯查看视图，隐藏输入框腾高度，并把滚动从 panel-view 收给画布自己
        //（否则滚轮缩放会连带整页一起滚）
        appEl.classList.toggle('in-project-map', name === 'project-map');
        panelView.hidden = inChat;
        panelView
          .querySelectorAll('.panel-page')
          .forEach((p) => (p.hidden = p.dataset.view !== name));
        if (inChat) chatOnShow(); // display:none 会丢滚动位置，返回时吸底（滚动语义在 chat.js）
        if (name === 'settings') { loadSettings(); bindConfigTransfer(); }
        else if (name === 'behavior') {
          requestNotifyPermission(); // 在用户手势内请求桌面通知授权
          startTaskPolling();
          initBehaviorTabs(); // 初始化「需求故障 / 访问日志」内部 tab
        }
        else if (name === 'json-tool') initJsonTool();
        else if (name === 'memory') initMemoryPanel();
        else if (name === 'optimize') initOptimizePanel();
        else if (name === 'project-map') initProjectMapPanel();
        refreshAskChip(); // 视图切换后重新判定顶栏审批徽标是否显示
        // 视图切换时清除对方列表的选中态
        if (name === 'chat') {
          renderReqListLocal?.();
        } else if (name === 'req') {
          renderConvListNow?.();
        }
      }
      function toggleView(name) {
        showView(activeView === name ? 'chat' : name);
      }
      panelView
        .querySelectorAll('.panel-close')
        .forEach((b) => b.addEventListener('click', () => showView('chat')));
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || activeView === 'chat') return;
        if (document.querySelector('.mask:not([hidden])')) return; // 目录/确认弹层优先消费 Esc
        showView('chat');
      });

      // ---- 入口绑定 ----
      $('#behaviorBtn').addEventListener('click', () => toggleView('behavior'));
      $('#projectMapBtn').addEventListener('click', () => toggleView('project-map'));
      $('#settingsBtn').addEventListener('click', () => toggleView('settings'));

      // ---- 行为面板内部 tab 切换（需求故障 / 访问日志） ----
      let behaviorTabInited = false;
      function initBehaviorTabs() {
        if (behaviorTabInited) return;
        behaviorTabInited = true;
        const tabs = document.querySelectorAll('#behaviorTabs [data-behavior-tab]');
        tabs.forEach((btn) => {
          btn.addEventListener('click', () => {
            // 激活点击的 tab
            tabs.forEach((b) => b.classList.toggle('active', b === btn));
            const target = btn.dataset.behaviorTab;
            // 切换面板
            document.getElementById('behaviorPane-tasks').hidden = target !== 'tasks';
            document.getElementById('behaviorPane-logs').hidden = target !== 'logs';
            // 切到「访问日志」时懒加载
            if (target === 'logs') loadLogs();
          });
        });
      }

      // ---- 侧栏「会话 / 工具」切换 ----
      (function initToolsToggle() {
        const toggle = $('#toolsToggle');
        const convList = $('#convList');
        const toolsList = $('#toolsList');
        const title = $('#sidebarTitle');
        const sidebarSwitch = $('#sidebarSwitch');
        if (!toggle) return;
        let toolsMode = false;
        function setToolsMode(on) {
          toolsMode = on;
          toggle.classList.toggle('active', on);
          if (on) {
            // 进入工具模式：隐藏 convList 和对话/需求切换 tab（工具列表独占侧边栏）
            if (convList) convList.hidden = true;
            if (toolsList) toolsList.hidden = false;
            if (title) title.textContent = '工具';
            if (sidebarSwitch) sidebarSwitch.hidden = true;
            window._setSidebarCreateVisible?.(false);
          } else {
            // 退出工具模式：恢复切换 tab，交由 initSidebarSwitch 接管
            if (toolsList) toolsList.hidden = true;
            if (sidebarSwitch) sidebarSwitch.hidden = false;
            window._restoreSidebarMode?.();
            window._setSidebarCreateVisible?.(true);
          }
          // 工具态底栏（「打开…」按钮）是工具列表的附属区，切回会话态必须一起收起，
          // 否则它会挂在会话列表底下
          window._syncToolsFooter?.();
        }
        // 供 newConversation 等复位回「会话」态
        window._setSidebarToolsMode = setToolsMode;
        toggle.addEventListener('click', () => setToolsMode(!toolsMode));
        // 工具项：JSON 美化工具 → 主区打开其工作台
        $('#toolJson')?.addEventListener('click', () => showView('json-tool'));
        // 工具项：记忆库 → 主区打开面板
        $('#toolMemory')?.addEventListener('click', () => showView('memory'));
        // 工具项：项目优化 → 主区打开体检面板
        $('#toolOptimize')?.addEventListener('click', () => showView('optimize'));
        // 工具项：Markdown 查看工具 → 主区打开面板（panelView 开关由 showView 统一管理）
        $('#toolMarkdown')?.addEventListener('click', () => showView('markdown'));
      })();

      // ---- 侧栏「对话 / 需求」切换 ----
      (function initSidebarSwitch() {
        const switchBtns = document.querySelectorAll('.switch-btn');
        const convList = document.getElementById('convList');
        const reqList = document.getElementById('reqList');
        const sidebarTitle = document.getElementById('sidebarTitle');
        const createBtn = document.getElementById('sidebarCreateBtn');

        if (!switchBtns.length || !convList || !reqList) return;

        let currentMode = localStorage.getItem('claude-sidebar-mode') || 'conv';

        function setMode(mode) {
          if (currentMode === mode) return;
          currentMode = mode;

          // 更新 Switch 按钮 active 态和 ARIA
          switchBtns.forEach(btn => {
            const isActive = btn.dataset.target === mode;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
          });

          // 切换列表显隐
          if (convList) convList.hidden = mode !== 'conv';
          if (reqList) reqList.hidden = mode !== 'req';

          // 更新标题
          if (sidebarTitle) sidebarTitle.textContent = mode === 'conv' ? '对话' : '需求';

          // 更新新建按钮文本和 title
          if (createBtn) {
            const label = mode === 'conv' ? '新建对话' : '新建需求';
            createBtn.textContent = label;
            createBtn.title = label;
          }

          // 保存用户偏好
          localStorage.setItem('claude-sidebar-mode', mode);
        }

        // Switch 按钮点击
        switchBtns.forEach(btn => {
          btn.addEventListener('click', () => setMode(btn.dataset.target));
        });

        // 新建按钮：委托给对应的隐藏代理按钮，代理按钮上已由 chat.js/req-view.js 绑定了实际逻辑
        createBtn?.addEventListener('click', () => {
          if (currentMode === 'conv') {
            document.getElementById('sidebarNew')?.click();
          } else {
            document.getElementById('sidebarNewReq')?.click();
          }
        });

        // 页面加载时初始化（临时置 null 绕过 early return，再调用 setMode）
        const initMode = currentMode;
        currentMode = null;
        setMode(initMode);

        // 供工具模式切换时联动（工具模式下隐藏新建按钮）
        window._setSidebarCreateVisible = (visible) => {
          const footer = createBtn?.closest('.sidebar-footer');
          if (footer) footer.hidden = !visible;
        };

        // 供工具模式切回时恢复 Switch 状态
        window._restoreSidebarMode = () => {
          // 重放当前模式状态（不触发 setMode 的 early return）
          const mode = currentMode;
          switchBtns.forEach(btn => {
            const isActive = btn.dataset.target === mode;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
          });
          if (convList) convList.hidden = mode !== 'conv';
          if (reqList) reqList.hidden = mode !== 'req';
          if (sidebarTitle) sidebarTitle.textContent = mode === 'conv' ? '对话' : '需求';
          if (createBtn) {
            const label = mode === 'conv' ? '新建对话' : '新建需求';
            createBtn.textContent = label;
            createBtn.title = label;
          }
        };
      })();

      // ---- 启动初始化 ----
      // 依赖后端的初始化统一等启动闸门放行：桌面版页面秒开但 Node 后端要冷启动数秒，
      // 抢跑会让会话列表/徽标/额度全部拿空数据（表现为「界面能点但没反应」）。
      // 纯 DOM 绑定（上方视图切换、入口按钮）不在此列，页面一加载就绑好，罩子负责挡点击。
      (async () => {
        await whenBackendReady();
        initChat(); // 聊天体启动编排：目录标签 / 偏好同步 / 会话列表 / 回上次会话 / 磁盘历史 / 待续跑轮询
        initReqView({ showView }); // 需求视图启动编排：侧栏「新需求」绑定 + 30s 列表轮询
        initReqChat(); // 需求聊天装饰层：经 chat.js 钩子在需求会话上挂横幅/右栏
        refreshReqList(); // 首屏立即拉一次，不等首个 30s 周期
        refreshTaskBadge(); // 未读需求/故障红点
        setInterval(refreshTaskBadge, 15000);
        refreshTokenStatus(); // token 轮换横幅
        setInterval(refreshTokenStatus, 15000);
        refreshMemBadge(); // 记忆库未读红点（新晋升/冲突）
        setInterval(refreshMemBadge, 60000);
      })();

      // token 轮换状态轮询：横幅提醒 + ⚙ 徽标（首次调用与定时器由上方启动闸门统一发起）
      async function refreshTokenStatus() {
        let d;
        try {
          d = await (await fetch('/api/tokens/status')).json();
        } catch {
          return;
        }
        const banner = $('#tokenBanner');
        // 设置按钮红点已移除，无需操作
        $('#settingsBadge').hidden = true;
        if (d.notice && d.notice.kind === 'switch') {
          const to = d.notice.to || '备用账号';
          banner.hidden = false;
          banner.innerHTML = '<span></span><span class="spacer"></span><button>知道了</button>';
          banner.querySelector('span').textContent = `已切换到账号「${to}」，建议开启新对话继续（当前会话仍可继续）`;
          banner.querySelector('button').onclick = async () => {
            banner.hidden = true;
            await fetch('/api/tokens/dismiss', { method: 'POST' }).catch(() => {});
          };
        } else {
          banner.hidden = true;
        }
      }

      // 初始化 Markdown 工具
      let markdownTool;
      document.addEventListener('DOMContentLoaded', () => {
        markdownTool = new MarkdownTool();

        // 注入 Markdown 打开逻辑（视图桥）
        bindMarkdownNav((path) => {
          showView('markdown');
          markdownTool.openFileByPath(path);
        });

        console.log('Markdown 工具已初始化');
      });

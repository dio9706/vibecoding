import './js/bootstrap.js'; // 必须最先：打包模式 fetch/EventSource 补丁
import { whenBackendReady } from './js/boot-gate.js'; // 须在 bootstrap 之后：依赖其 fetch 补丁
import { bindTauriNav } from './js/tauri-init.js';
import { $ } from './js/util.js';
import { initJsonTool } from './js/json-tool.js';
import { loadLogs } from './js/logs-panel.js';
import { loadSettings, bindConfigTransfer } from './js/settings-panel.js';
import './js/actions-panel.js'; // 副作用：动作配置面板自绑定
import './js/bots-panel.js'; // 副作用：机器人面板自绑定（托管配置 tab）
import './js/sidebar.js'; // 副作用：侧边栏展开/收起自初始化
import { startTaskPolling, stopTaskPolling, requestNotifyPermission, refreshTaskBadge, bindTasksNav } from './js/tasks-panel.js';
import { initChat, chatOnShow, bindChatNav, refreshAskChip, openConv, renderConvListNow, applyInjectedItems, getCurrentConvId } from './js/chat.js';
import { bindConvNotify } from './js/conv-notify.js';
import { initReqView, refreshReqList, renderReqListLocal } from './js/req-view.js';
import { initReqChat } from './js/req-chat.js';
import { initMemoryPanel, refreshMemBadge } from './js/memory-view.js';
import { initOptimizePanel } from './js/optimize-view.js';
import toast from './js/toast.js';

// 初始化 Toast 组件
window.toast = toast;
toast._init();

bindTasksNav(() => showView('tasks'), () => activeView === 'tasks'); // 视图桥：跳转 + 活跃态查询（showView 已提升；activeView 惰性读取无 TDZ）
bindChatNav(() => showView('chat'), () => activeView === 'chat'); // 视图桥：回聊天视图跳转 + 聊天视图是否激活（供顶栏审批徽标判定）
bindTauriNav({ showView, openConv }); // 视图桥：托盘菜单 show-view 跳视图 + 点桌面通知回到对应会话（showView 提升；openConv 由 chat.js 导出）
bindConvNotify({ applyInjected: applyInjectedItems, getCurrentConvId }); // 🔔 飞书开关 + 补充内容收件箱轮询（getCurrentConvId 传函数引用，模块内实时取，不缓存）

      // ---- 嵌入式面板视图（chat=对话 | settings | tasks | logs），替代原弹层 ----
      const appEl = $('.app');
      const panelView = $('#panelView');
      let activeView = 'chat';
      function showView(name) {
        if (activeView === name) return;
        if (activeView === 'tasks') stopTaskPolling(); // 离开任务视图停轮询
        activeView = name;
        const inChat = name === 'chat';
        appEl.classList.toggle('in-panel', !inChat);
        appEl.classList.toggle('in-json-tool', name === 'json-tool'); // JSON 工具视图额外隐藏底部输入框
        // Markdown 是纯查看视图：隐藏输入框腾高度，并把滚动从 panel-view 收回到 #mdContent，
        // 否则一滚动工具栏/目录大纲/搜索框会被整体推出可视区
        appEl.classList.toggle('in-markdown', name === 'markdown');
        appEl.classList.toggle('in-req', name === 'req'); // 需求文档模式（评审/归档期）无会话语义：隐藏底部输入框，防止误发消息跳回聊天视图
        panelView.hidden = inChat;
        panelView
          .querySelectorAll('.panel-page')
          .forEach((p) => (p.hidden = p.dataset.view !== name));
        if (inChat) chatOnShow(); // display:none 会丢滚动位置，返回时吸底（滚动语义在 chat.js）
        if (name === 'settings') { loadSettings(); bindConfigTransfer(); }
        else if (name === 'tasks') {
          requestNotifyPermission(); // 在用户手势内请求桌面通知授权
          startTaskPolling();
        } else if (name === 'logs') loadLogs();
        else if (name === 'json-tool') initJsonTool();
        else if (name === 'memory') initMemoryPanel();
        else if (name === 'optimize') initOptimizePanel();
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
      $('#taskBtn').addEventListener('click', () => toggleView('tasks'));
      $('#logBtn').addEventListener('click', () => toggleView('logs'));
      $('#settingsBtn').addEventListener('click', () => toggleView('settings'));

      // ---- 侧栏「会话 / 工具」切换 ----
      (function initToolsToggle() {
        const toggle = $('#toolsToggle');
        const convList = $('#convList');
        const toolsList = $('#toolsList');
        const title = $('#sidebarTitle');
        if (!toggle) return;
        let toolsMode = false;
        function setToolsMode(on) {
          toolsMode = on;
          toggle.classList.toggle('active', on);
          if (convList) convList.hidden = on;
          if (toolsList) toolsList.hidden = !on;
          if (title) title.textContent = on ? '工具' : '对话';
          // 「打开历史」是 Markdown 工具的附属区，切回会话态必须一起收起，
          // 否则它会挂在会话列表底下；是否真有历史由 markdown-tool 自己判定
          window._syncMdHistoryPanel?.();
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
        console.log('Markdown 工具已初始化');
      });

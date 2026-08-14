/** 侧边栏展开/收起：移动端适配 + localStorage 记忆。零依赖副作用模块（段内自执行初始化）。 */
import { lsSet } from './util.js';
      // ---- 侧边栏展开/收起功能 ----

      function initSidebar() {
        const isMobile = window.matchMedia('(max-width: 720px)').matches;
        const stored = localStorage.getItem('claude-sidebar-collapsed');

        let collapsed;
        if (stored !== null) {
          collapsed = stored === 'true';
        } else {
          collapsed = isMobile;
        }

        setSidebarCollapsed(collapsed);
      }

      function setSidebarCollapsed(collapsed) {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        const isMobile = window.matchMedia('(max-width: 720px)').matches;

        if (collapsed) {
          sidebar.classList.add('collapsed');
          overlay.classList.remove('visible');
        } else {
          sidebar.classList.remove('collapsed');
          if (isMobile) {
            overlay.classList.add('visible');
          } else {
            overlay.classList.remove('visible');
          }
        }

        lsSet('claude-sidebar-collapsed', collapsed);
      }

      function toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const isCollapsed = sidebar.classList.contains('collapsed');
        setSidebarCollapsed(!isCollapsed);
      }

      // 事件绑定
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
          initSidebar();
          bindSidebarEvents();
        });
      } else {
        // 如果脚本在 DOMContentLoaded 后加载
        initSidebar();
        bindSidebarEvents();
      }

      function bindSidebarEvents() {
        const toggleBtn = document.getElementById('sidebarToggleBtn');
        const overlay = document.getElementById('sidebarOverlay');

        // ☰ 按钮点击
        if (toggleBtn) {
          toggleBtn.addEventListener('click', function(e) {
            e.preventDefault();
            toggleSidebar();
          });
        }

        // 遮罩点击关闭侧边栏
        if (overlay) {
          overlay.addEventListener('click', function() {
            setSidebarCollapsed(true); // 将侧边栏收起（moved to collapsed state）
          });
        }

        // 窗口大小变化时调整（只在桌面端隐藏遮罩）
        window.addEventListener('resize', function() {
          if (window.innerWidth <= 480) {
            // 超窄屏自动收起侧边栏
            setSidebarCollapsed(true);
          } else {
            const overlay = document.getElementById('sidebarOverlay');
            const isMobile = window.matchMedia('(max-width: 720px)').matches;
            if (!isMobile) {
              // 大屏幕时隐藏遮罩（侧边栏展开/收起状态保留用户偏好）
              overlay.classList.remove('visible');
            }
          }
        });
      }

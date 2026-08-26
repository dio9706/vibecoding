/** 机器人日志面板：分组渲染 + 搜索过滤 + 虚拟滚动 + 清空。入口 loadLogs 由 showView('logs') 调用。 */
import { $, debounce, fmtTime } from './util.js';
import { confirmDialog } from './ui.js';
import { formatBotLogEntry } from './logs-panel.logic.js';
      export async function loadLogs() {
        const body = $('#logBody');
        body.innerHTML = '<div style="color:var(--faint);padding:8px">加载中…</div>';
        let allLogs = [];
        try {
          const { logs } = await (await fetch('/api/bot-logs')).json();
          allLogs = logs || [];
        } catch {
          body.innerHTML = '<div style="color:var(--red);padding:8px">读取失败</div>';
          return;
        }
        if (!allLogs.length) {
          body.innerHTML = '<div style="color:var(--faint);padding:8px">暂无机器人日志</div>';
          return;
        }

        const ROW_H = 32; // 每行固定高度 px（log-row 单行文本）
        const BUFFER = 5; // 可视区上下各预渲染 5 行
        let filteredLogs = allLogs;

        body.innerHTML = '';

        // 搜索栏（替代浏览器 Ctrl+F，因虚拟滚动 DOM 不全）
        const searchBar = document.createElement('div');
        searchBar.className = 'log-search-bar';
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = '过滤日志…';
        const countSpan = document.createElement('span');
        countSpan.style.cssText = 'color:var(--faint);font-size:12px;white-space:nowrap;align-self:center';
        searchBar.appendChild(searchInput);
        searchBar.appendChild(countSpan);

        // 清空日志按钮：主动清空全部机器人日志（条数上限之外的手动一键清）
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.textContent = '清空日志';
        // 用统一的 .btn.danger，替代此前 inline 手搓的红框样式
        // （那里的 fallback 色 #e5484d 与 --red 实际值也不一致）
        clearBtn.className = 'btn danger';
        clearBtn.style.marginLeft = '8px';
        clearBtn.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: '清空机器人日志',
            message: '确认清空全部机器人日志？清空后不可恢复。',
            confirmText: '确认清空',
            danger: true,
          });
          if (!ok) return;
          clearBtn.disabled = true;
          try {
            const resp = await fetch('/api/bot-logs/clear', { method: 'POST' });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || !data.ok) throw new Error('clear failed');
            loadLogs();
          } catch {
            clearBtn.disabled = false;
            window.toast.error('清空失败，请重试');
          }
        });
        searchBar.appendChild(clearBtn);

        body.appendChild(searchBar);

        // 虚拟滚动容器
        const scroller = document.createElement('div');
        scroller.style.cssText = 'position:relative;flex:1;overflow-y:auto;';
        body.appendChild(scroller);

        // 撑高用占位
        const spacer = document.createElement('div');
        spacer.className = 'log-vscroll-spacer';
        scroller.appendChild(spacer);

        // 可见行容器
        const content = document.createElement('div');
        content.className = 'log-vscroll-content';
        scroller.appendChild(content);

        let rafPending = false;
        function renderVisible() {
          const scrollTop = scroller.scrollTop;
          const clientH = scroller.clientHeight || 400;
          const total = filteredLogs.length;
          spacer.style.height = (total * ROW_H) + 'px';

          const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
          const endIdx = Math.min(total, Math.ceil((scrollTop + clientH) / ROW_H) + BUFFER);

          content.style.top = (startIdx * ROW_H) + 'px';
          const frag = document.createDocumentFragment();
          for (let i = startIdx; i < endIdx; i++) {
            const g = filteredLogs[i];
            const { ok, text } = formatBotLogEntry(g);
            const row = document.createElement('div');
            row.className = 'log-row';
            row.style.height = ROW_H + 'px';
            row.innerHTML = `<span class="st">${ok ? '✅' : '❌'}</span><span class="t"></span><span class="info"></span>`;
            row.querySelector('.t').textContent = fmtTime(g.time);
            row.querySelector('.info').textContent = text;
            frag.appendChild(row);
          }
          content.innerHTML = '';
          content.appendChild(frag);
          countSpan.textContent = filteredLogs.length + ' 条' +
            (filteredLogs.length < allLogs.length ? `（共 ${allLogs.length}）` : '');
        }

        scroller.addEventListener('scroll', () => {
          if (rafPending) return;
          rafPending = true;
          requestAnimationFrame(() => { rafPending = false; renderVisible(); });
        });

        // 搜索过滤
        const filterDebounced = debounce((q) => {
          const kw = q.trim().toLowerCase();
          filteredLogs = kw
            ? allLogs.filter((g) => formatBotLogEntry(g).text.toLowerCase().includes(kw))
            : allLogs;
          scroller.scrollTop = 0;
          renderVisible();
        }, 200);
        searchInput.addEventListener('input', (e) => filterDebounced(e.target.value));

        renderVisible(); // 首屏渲染
      }

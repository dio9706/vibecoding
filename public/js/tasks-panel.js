/** 需求/故障任务面板：卡片列表 / 操作 / 未读红点 + 桌面通知。轮询由 showView 经 start/stopTaskPolling 驱动；
 *  通知点击跳任务视图经 bindTasksNav 注入（避免反向依赖 app.js 的 showView）。 */
import { $, fmtTime, renderMarkdown, lsSet } from './util.js';
import { confirmDialog } from './ui.js';

let _openTasksView = () => {};
let _isTasksViewActive = () => false;
/** 注入视图桥：openFn=跳任务视图；isActiveFn=任务视图是否当前打开（避免反向依赖 app.js 的 showView/activeView） */
export function bindTasksNav(openFn, isActiveFn) { _openTasksView = openFn; _isTasksViewActive = isActiveFn; }

      // ---- 需求 / 故障任务 ----
      let taskTimer = null;
      let filterAuto = false; // [自动处理] 筛选：只看自动完成且未合并的任务
      // [🔔 飞书通知] 开关的本地镜像。真值在服务端 settings.json 的 uiPrefs.taskNotifyFeishu：
      // 通知是由后端进程发出的，只有服务端的值才算数；存 localStorage 会出现「这台浏览器显示开着、
      // 另一台显示关着」而实际行为只由服务端决定的假象。故每次 loadTasks 都从服务端读回。
      let taskNotifyFeishu = false;
      // 状态 → [中文标签, 颜色]（与状态机对齐：new→reviewing→challenged/analyzing→analyzed→developing→done/rejected）
      const TASK_STATUS = {
        new: ['待确认', 'var(--muted)'],
        confirmed: ['已确认', 'var(--muted)'],
        reviewing: ['评审中', 'var(--amber)'],
        challenged: ['已质疑', 'var(--amber)'],
        analyzing: ['分析中', 'var(--amber)'],
        analyzed: ['待开发', 'var(--green)'],
        queued: ['排队中', 'var(--accent-hi)'],
        developing: ['开发中', 'var(--accent-hi)'],
        done: ['已完成', 'var(--green)'],
        rejected: ['已放弃', 'var(--faint)'],
      };

      // 类型图标（内联 SVG，fill=currentColor 跟随 .task-card .type 的文字色）
      const TYPE_ICON_FEATURE =
        '<svg class="type-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M829.44 989.866667H184.32C139.946667 989.866667 102.4 947.2 102.4 896v-699.733333c0-51.2 37.546667-92.16 81.92-92.16h119.466667c13.653333 0 25.6 11.946667 25.6 25.6s-11.946667 25.6-25.6 25.6h-119.466667c-17.066667 0-30.72 18.773333-30.72 40.96v699.733333c0 22.186667 13.653333 40.96 30.72 40.96h645.12c10.24 0 22.186667-5.12 29.013333-11.946667 8.533333-8.533333 11.946667-18.773333 11.946667-29.013333v-699.733333c0-22.186667-13.653333-40.96-30.72-40.96h-124.586667c-13.653333 0-25.6-11.946667-25.6-25.6s11.946667-25.6 25.6-25.6h124.586667c46.08 0 81.92 40.96 81.92 92.16v699.733333c0 25.6-10.24 47.786667-27.306667 64.853333-17.066667 18.773333-40.96 29.013333-64.853333 29.013334z" fill="currentColor"></path><path d="M675.84 218.453333H348.16c-32.426667 0-59.733333-27.306667-59.733333-59.733333V93.866667c0-32.426667 27.306667-59.733333 59.733333-59.733334h329.386667c32.426667 0 59.733333 27.306667 59.733333 59.733334v64.853333c-1.706667 34.133333-27.306667 59.733333-61.44 59.733333zM348.16 85.333333c-5.12 0-8.533333 3.413333-8.533333 8.533334v64.853333c0 5.12 3.413333 8.533333 8.533333 8.533333h329.386667c5.12 0 8.533333-3.413333 8.533333-8.533333V93.866667c0-5.12-3.413333-8.533333-8.533333-8.533334H348.16zM774.826667 455.68H547.84c-13.653333 0-25.6-11.946667-25.6-25.6s11.946667-25.6 25.6-25.6h226.986667c13.653333 0 25.6 11.946667 25.6 25.6s-11.946667 25.6-25.6 25.6zM322.56 513.706667c-6.826667 0-13.653333-3.413333-18.773333-6.826667l-63.146667-64.853333c-10.24-10.24-10.24-25.6 0-35.84 10.24-10.24 25.6-10.24 35.84 0l44.373333 46.08 88.746667-95.573334c10.24-10.24 25.6-10.24 35.84-1.706666 10.24 10.24 10.24 25.6 1.706667 35.84L341.333333 505.173333c-5.12 5.12-11.946667 8.533333-18.773333 8.533334z" fill="currentColor"></path><path d="M774.826667 725.333333H547.84c-13.653333 0-25.6-11.946667-25.6-25.6s11.946667-25.6 25.6-25.6h226.986667c13.653333 0 25.6 11.946667 25.6 25.6s-11.946667 25.6-25.6 25.6zM322.56 783.36c-6.826667 0-13.653333-3.413333-18.773333-6.826667l-63.146667-64.853333c-10.24-10.24-10.24-25.6 0-35.84 10.24-10.24 25.6-10.24 35.84 0l44.373333 46.08 88.746667-95.573333c10.24-10.24 25.6-10.24 35.84-1.706667s10.24 25.6 1.706667 35.84L341.333333 774.826667c-5.12 5.12-11.946667 8.533333-18.773333 8.533333z" fill="currentColor"></path></svg>';
      const TYPE_ICON_BUG =
        '<svg class="type-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M940 512H792V412c76.8 0 139-62.2 139-139 0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8 0 34.8-28.2 63-63 63H232c-34.8 0-63-28.2-63-63 0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8 0 76.8 62.2 139 139 139v100H84c-4.4 0-8 3.6-8 8v56c0 4.4 3.6 8 8 8h148v96c0 6.5 0.2 13 0.7 19.3C164.1 728.6 116 796.7 116 876c0 4.4 3.6 8 8 8h56c4.4 0 8-3.6 8-8 0-44.2 23.9-82.9 59.6-103.7 6 17.2 13.6 33.6 22.7 49 24.3 41.5 59 76.2 100.5 100.5S460.5 960 512 960s99.8-13.9 141.3-38.2c41.5-24.3 76.2-59 100.5-100.5 9.1-15.5 16.7-31.9 22.7-49C812.1 793.1 836 831.8 836 876c0 4.4 3.6 8 8 8h56c4.4 0 8-3.6 8-8 0-79.3-48.1-147.4-116.7-176.7 0.4-6.4 0.7-12.8 0.7-19.3v-96h148c4.4 0 8-3.6 8-8v-56c0-4.4-3.6-8-8-8zM716 680c0 36.8-9.7 72-27.8 102.9-17.7 30.3-43 55.6-73.3 73.3-20.1 11.8-42 20-64.9 24.3V484c0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8v396.5c-22.9-4.3-44.8-12.5-64.9-24.3-30.3-17.7-55.6-43-73.3-73.3C317.7 752 308 716.8 308 680V412h408v268z" fill="currentColor"></path><path d="M304 280h56c4.4 0 8-3.6 8-8 0-28.3 5.9-53.2 17.1-73.5 10.6-19.4 26-34.8 45.4-45.4C450.9 142 475.7 136 504 136h16c28.3 0 53.2 5.9 73.5 17.1 19.4 10.6 34.8 26 45.4 45.4C650 218.9 656 243.7 656 272c0 4.4 3.6 8 8 8h56c4.4 0 8-3.6 8-8 0-40-8.8-76.7-25.9-108.1-17.2-31.5-42.5-56.8-74-74C596.7 72.8 560 64 520 64h-16c-40 0-76.7 8.8-108.1 25.9-31.5 17.2-56.8 42.5-74 74C304.8 195.3 296 232 296 272c0 4.4 3.6 8 8 8z" fill="currentColor"></path></svg>';

      /** 自动完成且待合并（筛选与合并按钮共用判定，与后端 merge 校验条件对齐） */
      const isAwaitingMerge = (t) => !!t.auto && t.status === 'done' && !t.merged && !!t.branch && !!t.baseBranch;

      // ---- 未读需求/故障：红点 + 桌面通知 ----
      // 提醒键模型：任务「出现」即一条 new 提醒；status=done 再加一条 done 提醒。
      // 已读键存 localStorage；未读 = 当前提醒键中不在已读集合里的。
      const TASKS_SEEN_KEY = 'claude_tasks_seen';
      let latestAlerts = []; // [{ key, kind, title, body }] 当前全部提醒事件
      const notifiedKeys = new Set(); // 本次会话已弹过桌面通知的键，避免重复弹
      let notifySeeded = false; // 首轮只收敛不弹，避免刚开页面就爆出历史未读

      function taskAlerts(t) {
        const name = t.title || t.detail || '(无标题)';
        const alerts = [
          { key: t.id, kind: 'new', title: t.type === 'bug' ? '新故障 🐞' : '新需求 ✦', body: name },
        ];
        if (t.status === 'done') {
          alerts.push({ key: t.id + ':done', kind: 'done', title: '开发完成 ✓', body: name });
        }
        return alerts;
      }
      function getSeenKeys() {
        try {
          return new Set(JSON.parse(localStorage.getItem(TASKS_SEEN_KEY)) || []);
        } catch {
          return new Set();
        }
      }
      function updateTaskBadge() {
        const seen = getSeenKeys();
        const unread = latestAlerts.filter((a) => {
          if (seen.has(a.key)) return false;
          // 若用户已看过该任务（base key 已在 seen 中），则不把 :done 完成通知计入未读
          // 避免：用户看过任务 → 后台 AI 完成它 → 每次进页面都亮红点的问题
          if (a.kind === 'done' && seen.has(a.key.replace(/:done$/, ''))) return false;
          return true;
        }).length;
        $('#taskBadge').hidden = unread === 0;
      }
      function markAllTasksSeen() {
        lsSet(TASKS_SEEN_KEY, JSON.stringify(latestAlerts.map((a) => a.key)));
        updateTaskBadge();
      }
      // 桌面通知授权：仅在 default 时请求一次（须在用户手势内调用，否则浏览器忽略）
      export function requestNotifyPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
          Notification.requestPermission().catch(() => {});
        }
      }
      // 发现「新出现且未通知过」的未读提醒 → 弹桌面通知（仅页面在后台时弹，前台交给红点）
      function fireDesktopNotifications() {
        const seen = getSeenKeys();
        const fresh = latestAlerts.filter((a) => !seen.has(a.key) && !notifiedKeys.has(a.key));
        if (!notifySeeded) {
          // 首轮：把当前未读全部标记为已通知，只收敛不弹
          fresh.forEach((a) => notifiedKeys.add(a.key));
          notifySeeded = true;
          return;
        }
        const canNotify = 'Notification' in window && Notification.permission === 'granted';
        for (const a of fresh) {
          notifiedKeys.add(a.key); // 无论是否真弹都标记，避免切后台后补弹旧事件
          if (canNotify && document.hidden) {
            try {
              const n = new Notification(a.title, { body: a.body, tag: a.key });
              n.onclick = () => {
                window.focus();
                _openTasksView();
                n.close();
              };
            } catch {
              /* 忽略通知失败 */
            }
          }
        }
      }
      // 抽屉关闭时的轻量轮询：探测未读 + 后台桌面通知，不标记已读
      export async function refreshTaskBadge() {
        if (_isTasksViewActive()) return; // 任务视图打开时由 loadTasks 负责
        try {
          const { tasks } = await (await fetch('/api/tasks')).json();
          latestAlerts = (tasks || []).flatMap(taskAlerts);
          updateTaskBadge();
          fireDesktopNotifications();
        } catch {
          /* 忽略轮询失败 */
        }
      }

      /** 从服务端读回 🔔 飞书通知开关。任何失败都保持上一次的值：
       *  宁可开关短暂过时，也不能因为设置接口抖一下就把任务列表整块渲染成「读取失败」。 */
      async function syncNotifyPref() {
        try {
          const d = await (await fetch('/api/settings')).json();
          taskNotifyFeishu = !!(d && d.uiPrefs && d.uiPrefs.taskNotifyFeishu);
        } catch {
          /* 忽略：沿用当前镜像值 */
        }
      }

      async function loadTasks() {
        const body = $('#taskBody');
        await syncNotifyPref(); // 须在 renderFilterBar 之前完成，否则首帧 chip 状态是错的
        try {
          const data = await (await fetch('/api/tasks')).json();
          const tasks = data.tasks || [];
          latestAlerts = tasks.flatMap(taskAlerts);
          body.innerHTML = '';
          body.appendChild(renderFilterBar(tasks));
          const shown = filterAuto ? tasks.filter(isAwaitingMerge) : tasks;
          if (!shown.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:var(--faint);padding:8px';
            empty.textContent = filterAuto ? '暂无待合并的自动完成任务' : '暂无需求 / 故障';
            body.appendChild(empty);
          } else {
            for (const t of shown) body.appendChild(renderTask(t));
          }
          markAllTasksSeen();
        } catch {
          body.innerHTML = '<div style="color:var(--red);padding:8px">读取失败</div>';
        }
      }

      // 筛选栏：[自动处理] chip（自动完成且未合并），带数量角标
      function renderFilterBar(tasks) {
        const bar = document.createElement('div');
        bar.className = 'task-filter-bar';
        const pending = tasks.filter(isAwaitingMerge).length;
        const chip = document.createElement('button');
        chip.className = 'btn task-filter-chip' + (filterAuto ? ' active' : '');
        chip.textContent = `自动处理${pending ? `（${pending} 待合并）` : ''}`;
        chip.title = '只看自动完成且未合并的任务';
        chip.onclick = () => {
          filterAuto = !filterAuto;
          loadTasks();
        };
        bar.appendChild(chip);
        // [🔔 飞书通知] 总开关：任务落 done 时后端是否推飞书私聊卡片（task-notify 的第一道守卫）
        const notifyChip = document.createElement('button');
        notifyChip.className = 'btn task-filter-chip' + (taskNotifyFeishu ? ' active' : '');
        notifyChip.textContent = '🔔 飞书通知';
        notifyChip.title = '任务处理完成后发飞书私聊卡片（可直接合并/补充/放弃）';
        notifyChip.onclick = () => toggleTaskNotify(notifyChip);
        bar.appendChild(notifyChip);
        return bar;
      }

      /** 切换 🔔 飞书通知开关：服务端写成功才动本地镜像。
       *  失败时刻意不改本地值——点亮一个实际没生效的开关，用户会以为通知已开，
       *  然后任务跑完只剩沉默（比直接报错更难排查）。 */
      async function toggleTaskNotify(chip) {
        const next = !taskNotifyFeishu;
        chip.disabled = true; // 往返期间防连点：两次相反的写并发到达，服务端最终值不可预期
        try {
          const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ section: 'ui-prefs', taskNotifyFeishu: next }),
          });
          const d = await r.json();
          // 服务端在「没填我的飞书 open_id」「没有凭证齐全的启用机器人」时回 **200 + {ok:false, error}**：
          // 这是配置缺失而非请求失败，error 本身就是一句可执行的指路，原样弹出即可（别再套「设置失败」外壳）。
          // 关键是此路径同样**不改 taskNotifyFeishu**：点亮一个实际发不出卡片的开关，
          // 用户会以为通知已开，等到任务跑完只剩沉默——比直接报错更难排查。
          if (!d || !d.ok) {
            chip.disabled = false;
            window.toast.error((d && d.error) || '设置失败，请稍后重试');
            return;
          }
          taskNotifyFeishu = next;
          window.toast.success(next ? '已开启：任务处理完成后发飞书卡片' : '已关闭任务飞书通知');
          loadTasks(); // 重渲染筛选栏；顺带再从服务端读回一次，本地镜像与盘上值对齐
        } catch (e) {
          chip.disabled = false; // 保持原状态可再试（成功路径由 loadTasks 整条替换掉这个按钮）
          window.toast.error('设置失败：' + (e?.message || e));
        }
      }

      // Markdown → HTML 渲染（marked 未加载时回退纯文本，避免出错）

      function renderTask(t) {
        const [label, color] = TASK_STATUS[t.status] || [t.status, 'var(--muted)'];
        const card = document.createElement('div');
        card.className = 'task-card';

        const top = document.createElement('div');
        top.className = 'top';
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.style.color = color;
        badge.textContent = label;
        const type = document.createElement('span');
        type.className = 'type';
        // 图标内联 SVG + fill="currentColor"：跟随 .task-card .type 的 color(--faint)，随主题走
        type.innerHTML = (t.type === 'bug' ? TYPE_ICON_BUG : TYPE_ICON_FEATURE) +
          '<span>' + (t.type === 'bug' ? '故障' : '需求') + '</span>';
        const when = document.createElement('span');
        when.className = 'when';
        when.textContent = fmtTime(t.updatedAt || t.createdAt);
        top.append(badge, type);
        if (t.auto) {
          const auto = document.createElement('span');
          auto.className = 'badge';
          auto.style.color = 'var(--accent-hi)';
          auto.textContent = t.merged ? '自动完成 · 已合并' : '自动完成';
          top.appendChild(auto);
        }
        top.appendChild(when);

        const title = document.createElement('div');
        title.className = 'title';
        // 完整展示用户发送内容：detail 是原始全文，title 仅为 40 字截断标题（feedback 收集时切的）。
        // 优先展示 detail，保证长需求/故障描述不被截断。
        title.textContent = t.detail || t.title || '(无标题)';
        card.append(top, title);

        // 评审结论（质疑/拒绝理由）
        if (t.review && t.review.reason && ['challenged', 'rejected'].includes(t.status)) {
          const rv = document.createElement('div');
          rv.className = 'analysis';
          const rvLabel = document.createElement('div');
          rvLabel.style.cssText = 'color:var(--amber);font-size:11px;margin-bottom:4px';
          rvLabel.textContent = t.status === 'rejected' ? 'AI 评审：拒绝' : 'AI 评审：存疑';
          const rvBody = document.createElement('div');
          rvBody.textContent = t.review.reason;
          rv.append(rvLabel, rvBody);
          card.appendChild(rv);
        }
        // 分支与合并信息（自动完成任务）
        if (t.auto && t.branch) {
          const br = document.createElement('div');
          br.style.cssText = 'font-size:11px;color:var(--faint);margin-top:4px';
          if (t.discarded) {
            // 已放弃改动：分支已删除，不能再显示「→ 主分支」与合并失败信息（会让人误以为还能合并）
            br.textContent = `分支 ${t.branch} 已删除（已放弃改动）`;
          } else {
            br.textContent = `分支 ${t.branch} → ${t.baseBranch || '?'}` + (t.mergeError ? ` · 上次合并失败：${t.mergeError}` : '');
            if (t.mergeError) br.style.color = 'var(--red)';
          }
          card.appendChild(br);
        }
        // Claude 分析产出
        if (t.analysis && t.analysis.suggestion) {
          const a = document.createElement('div');
          a.className = 'analysis';
          renderMarkdown(a, t.analysis.suggestion);
          if (Array.isArray(t.analysis.files) && t.analysis.files.length) {
            const f = document.createElement('div');
            f.className = 'files';
            f.textContent = '涉及：' + t.analysis.files.join('、');
            a.appendChild(f);
          }
          card.appendChild(a);
        }
        // 已补充的修正方案
        if (t.fixNote) {
          const fn = document.createElement('div');
          fn.className = 'analysis';
          const fnLabel = document.createElement('div');
          fnLabel.style.cssText = 'color:var(--faint);font-size:11px;margin-bottom:4px';
          fnLabel.textContent = '补充';
          const fnBody = document.createElement('div');
          renderMarkdown(fnBody, t.fixNote);
          fn.append(fnLabel, fnBody);
          card.appendChild(fn);
        }

        const actions = actionsFor(t, card);
        if (actions) card.appendChild(actions);
        return card;
      }

      // 按状态给出可用操作。分析中/待确认 也允许补充与移除。
      function actionsFor(t, card) {
        const wrap = document.createElement('div');
        wrap.className = 'actions';
        const add = (text, cls, fn) => {
          const b = document.createElement('button');
          b.className = 'btn' + (cls ? ' ' + cls : '');
          b.textContent = text;
          b.onclick = fn;
          wrap.appendChild(b);
        };
        if (t.status === 'analyzed') {
          add('开始开发', 'primary', () => taskAction(t.id, 'start'));
          add('补充方案', '', () => openFix(t, card));
          add('移除', 'danger', () => rejectTask(t));
        } else if (t.status === 'challenged') {
          // AI 评审存疑：owner 可强行开始（后端记人工覆盖判例）或采纳建议移除
          add('仍要开发', 'primary', () => taskAction(t.id, 'start'));
          add('补充方案', '', () => openFix(t, card));
          add('移除', 'danger', () => rejectTask(t));
        } else if (['analyzing', 'reviewing', 'new', 'confirmed'].includes(t.status)) {
          add('补充方案', '', () => openFix(t, card));
          add('移除', 'danger', () => rejectTask(t));
        } else if (isAwaitingMerge(t)) {
          add('合并到主分支', 'primary', () => mergeTask(t));
          add('放弃改动', 'danger', () => discardTask(t));
        } else {
          return null; // developing/已合并/rejected 无操作
        }
        return wrap;
      }

      // 合并确认：明示 source → target 分支名（防合错的二次提醒）
      async function mergeTask(t) {
        const ok = await confirmDialog({
          title: '合并到主分支',
          message: `确认将分支「${t.branch}」合并到「${t.baseBranch}」？\n请核对分支名无误后再继续。`,
          confirmText: '确认合并',
          danger: true,
        });
        if (!ok) return;
        taskAction(t.id, 'merge');
      }

      // 放弃改动确认：明示要删除的分支名与不可恢复（与合并同一档二次提醒）
      async function discardTask(t) {
        const ok = await confirmDialog({
          title: '放弃改动',
          message: `确认放弃「${t.title || t.detail || '(无标题)'}」的自动改动？\n将删除分支「${t.branch}」，改动不可恢复。`,
          confirmText: '确认放弃',
          danger: true,
        });
        if (!ok) return;
        taskAction(t.id, 'discard');
      }

      // 内联补充表单：提交后走 fix，重新分析
      function openFix(t, card) {
        if (card.querySelector('.task-fix')) return; // 已展开
        const box = document.createElement('div');
        box.className = 'task-fix';
        const ta = document.createElement('textarea');
        ta.placeholder = '补充说明或修正方案，提交后重新分析…';
        ta.value = t.fixNote || '';
        const row = document.createElement('div');
        row.className = 'fix-actions';
        const ok = document.createElement('button');
        ok.className = 'btn primary';
        ok.textContent = '提交并重新分析';
        ok.onclick = () => {
          const note = ta.value.trim();
          if (!note) return ta.focus();
          taskAction(t.id, 'fix', { fixNote: note });
        };
        const cancel = document.createElement('button');
        cancel.className = 'btn';
        cancel.textContent = '取消';
        cancel.onclick = () => box.remove();
        row.append(ok, cancel);
        box.append(ta, row);
        card.appendChild(box);
        ta.focus();
      }

      async function rejectTask(t) {
        const ok = await confirmDialog({
          title: '移除需求',
          message: '确认移除该需求？将标记为「已放弃」。',
          confirmText: '移除',
          danger: true,
        });
        if (!ok) return;
        taskAction(t.id, 'reject');
      }

      async function taskAction(id, action, extra = {}) {
        try {
          const r = await fetch('/api/tasks/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, action, ...extra }),
          });
          const d = await r.json();
          if (d.error) return window.toast.error(d.error);
          loadTasks();
        } catch {
          window.toast.error('操作失败');
        }
      }

      export function startTaskPolling() {
        stopTaskPolling();
        loadTasks();
        // 分析/开发在后台异步推进，轮询刷新状态；正在补充编辑时暂停，避免清空输入
        taskTimer = setInterval(() => {
          if (_isTasksViewActive() && !document.querySelector('#panelView .task-fix')) loadTasks();
        }, 4000);
      }
      export function stopTaskPolling() {
        if (taskTimer) {
          clearInterval(taskTimer);
          taskTimer = null;
        }
      }


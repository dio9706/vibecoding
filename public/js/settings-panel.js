/** 设置页面板：Claude 账号池 / 自定义模型凭证 / MCP 服务器 / 基础偏好 / 配置导入导出。
 *  机器人（凭证/角色/文案/动作）在 bots-panel.js。
 *  入口 loadSettings + bindConfigTransfer 由 showView('settings') 调用；设置按钮绑定留在 app.js。 */
import { $ } from './util.js';
import { toast, confirmDialog, promptDialog } from './ui.js';
// 厂商预设抽成独立模块：新用户引导也要用，留在本文件里第二个使用方只能复制一份
import { VENDOR_PRESETS, BASEURL_TO_VENDOR } from './vendor-presets.js';
// 导入流程同样抽出：新用户引导也要一键导入，只是不需要那句覆盖确认
import { importConfigFile } from './config-import.js';
import { iconHtml, DELETE_ICON_SVG, EDIT_ICON_SVG } from './icons.js';

// 订阅类型配置：扩展时同步更新 index.html #tokenSubscription 的 options
const SUBSCRIPTION_TYPES = [
  { value: 'claude', label: 'Claude' },
];

      // ==== 设置页（飞书凭证 + 备用 token） ====

      function fmtReset(sec) {
        if (!sec) return '';
        return '重置 ' + new Date(sec * 1000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      }

      export async function loadSettings() {
        let d;
        try {
          d = await (await fetch('/api/settings')).json();
        } catch {
          toast('读取设置失败');
          return;
        }
        const st = $('#feishuState');
        const map = { connected: ['🟢 连接正常', 'ok'], reconnecting: ['🔴 重连中', 'bad'], connecting: ['🟡 连接中', 'warn'], failed: ['⚠️ 未连接', 'warn'], idle: ['— 未启动', 'warn'] };
        const [txt, cls] = map[d.feishu?.state] || map.idle;
        st.textContent = txt;
        st.className = 'feishu-state ' + cls;
        st.title = d.feishu?.error || '';
        $('#activeToken').textContent = d.active ? '当前：' + d.active.label : '当前：默认登录';
        renderTokenList(d.tokens || []);
        loadCredentials(); // 自定义模型凭证走独立端点，随设置面板一起加载
        loadMcpServers(); // MCP 服务器同上
        loadPlugins(); // 插件启停同上
        setupVendorListener(); // 仅绑定表单事件，不依赖异步数据，可同步调用
        // 填充基础 tab
        const prefs = d.uiPrefs || {};
        const basicDefaultModel = document.getElementById('basicDefaultModel');
        if (basicDefaultModel) basicDefaultModel.value = prefs.defaultModel || '';
        const basicDefaultEffort = document.getElementById('basicDefaultEffort');
        if (basicDefaultEffort) basicDefaultEffort.value = prefs.defaultEffort || '';
        const basicDefaultMode = document.getElementById('basicDefaultMode');
        if (basicDefaultMode) basicDefaultMode.value = prefs.defaultMode || '';
        const basicMyFeishuOpenId = document.getElementById('basicMyFeishuOpenId');
        if (basicMyFeishuOpenId) basicMyFeishuOpenId.value = d.myFeishuOpenId || '';
      }

      // 导入 / 导出配置：导出走 Blob 下载；导入选文件→前端校验→确认→POST→reload
      export function bindConfigTransfer() {
        const exportBtn = document.getElementById('cfgExportBtn');
        const importBtn = document.getElementById('cfgImportBtn');
        const fileInput = document.getElementById('cfgImportFile');
        if (!exportBtn || !importBtn || !fileInput) return;
        if (exportBtn._bound) return; // 防重复绑定
        exportBtn._bound = true;

        exportBtn.addEventListener('click', async () => {
          try {
            const r = await fetch('/api/settings/export');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const date = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = 'claude-agent-config-' + date + '.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            toast('配置已导出');
          } catch (e) {
            toast('导出失败：' + (e && e.message || e));
          }
        });

        importBtn.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', async () => {
          const file = fileInput.files && fileInput.files[0];
          fileInput.value = ''; // 允许再次选同一文件
          if (!file) return;
          const r = await importConfigFile(file, {
            confirm: () =>
              confirmDialog({
                title: '导入配置',
                message: '导入将覆盖当前全部配置（机器人 / 账号池 / 托管配置 / 偏好），确认继续？覆盖后不可恢复。',
                confirmText: '确认导入',
                danger: true,
              }),
          });
          if (r.cancelled) return;
          if (!r.ok) {
            toast('导入失败：' + r.error);
            return;
          }
          // 旧版包不含托管配置，得明说；否则用户以为配齐了，回头发现动作全没了
          toast(
            r.actionConfigsImported
              ? '导入成功（含托管配置），正在重新加载…'
              : '导入成功。该文件为旧版，不含托管配置，需到设置页重新配置动作',
          );
          setTimeout(() => location.reload(), r.actionConfigsImported ? 800 : 2400);
        });
      }

      function renderTokenList(tokens) {
        const box = $('#tokenList');
        box.innerHTML = '';
        tokens.forEach((t, i) => {
          const row = document.createElement('div');
          row.className = 'token-row';
          row.draggable = true;
          row.dataset.id = t.id;
          const badgeText = { healthy: '✓健康', warning: '⚠即将耗尽', exhausted: '⛔耗尽' }[t.status] || t.status;
          const util = typeof t.utilization === 'number' ? ' ' + Math.round(t.utilization * 100) + '%' : '';
          row.innerHTML =
            '<span class="drag" title="拖拽调整优先级">⠿</span>' +
            '<span class="t-badge ' + t.status + '">' + badgeText + util + '</span>' +
            '<span class="t-label"></span>' +
            '<span class="t-mask"></span>' +
            '<span class="t-reset">' + (t.status !== 'healthy' ? fmtReset(t.resetsAt) : '') + '</span>' +
            '<span class="spacer"></span>' +
            (i === 0
              ? '<span class="t-primary" title="列表首位 = 偏好最高">★ 首选</span>'
              : '<button class="t-act make-primary" title="置顶为首选账号">设为当前</button>') +
            '<button class="t-act rename" title="改名">' + iconHtml(EDIT_ICON_SVG) + '</button>' +
            '<button class="t-act del" title="删除">' + iconHtml(DELETE_ICON_SVG) + '</button>';
          row.querySelector('.t-label').textContent = t.label;
          row.querySelector('.t-mask').textContent = t.masked;
          row.querySelector('.rename').onclick = () => renameToken(t.id, t.label);
          row.querySelector('.del').onclick = () => deleteToken(t.id, t.label);
          const mk = row.querySelector('.make-primary');
          if (mk) mk.onclick = () => makePrimary(t);
          bindDrag(row, box);
          box.appendChild(row);
        });
      }

      function bindDrag(row, box) {
        row.addEventListener('dragstart', () => row.classList.add('dragging'));
        row.addEventListener('dragend', async () => {
          row.classList.remove('dragging');
          const ids = [...box.querySelectorAll('.token-row')].map((r) => r.dataset.id);
          await postSettings({ section: 'tokens', action: 'reorder', ids });
          await loadSettings();
        });
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          const dragging = box.querySelector('.dragging');
          if (!dragging || dragging === row) return;
          const rect = row.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          box.insertBefore(dragging, after ? row.nextSibling : row);
        });
      }

      async function postSettings(payload) {
        try {
          const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const d = await r.json();
          if (!r.ok || d.error) {
            toast(d.error || '保存失败');
            return false;
          }
          return true;
        } catch {
          toast('网络错误');
          return false;
        }
      }

      async function addTokenUI() {
        const label = $('#tokenLabel').value.trim();
        const subscription = $('#tokenSubscription')?.value.trim() ?? '';
        const token = $('#tokenValue').value.trim();

        if (!subscription) return toast('请选择订阅类型');
        if (!token) return toast('请填 token');

        if (await postSettings({ section: 'tokens', action: 'add', label, subscription, token })) {
          $('#tokenLabel').value = '';
          if ($('#tokenSubscription')) $('#tokenSubscription').value = 'claude';
          $('#tokenValue').value = '';
          await loadSettings();
        }
      }

      async function renameToken(id, cur) {
        const label = await promptDialog({
          title: '重命名账号',
          message: '为该账号设置一个便于识别的名称。',
          value: cur,
          placeholder: '例如：主力号 / 备用号',
          confirmText: '保存',
        });
        if (label == null) return;
        if (await postSettings({ section: 'tokens', action: 'update', id, label: label.trim() })) await loadSettings();
      }

      async function deleteToken(id, label) {
        if (!(await confirmDialog({ title: '删除账号', message: `确认删除「${label}」？`, danger: true }))) return;
        if (await postSettings({ section: 'tokens', action: 'remove', id })) await loadSettings();
      }

      // 置顶 = 设为首选：复用 reorder，pickActive 顺序优先 → 可用则立即成为 active
      async function makePrimary(t) {
        const ids = [...$('#tokenList').querySelectorAll('.token-row')].map((r) => r.dataset.id);
        const next = [t.id, ...ids.filter((id) => id !== t.id)];
        if (await postSettings({ section: 'tokens', action: 'reorder', ids: next })) {
          if (t.status === 'exhausted') toast('该账号额度已耗尽，已设为首选，恢复后自动启用');
          await loadSettings();
        }
      }

      // ---- 厂商选择联动 ----
      function setupVendorListener() {
        const vendorSelect = $('#credVendor');
        const modelInput = $('#credModel');
        const modelList = $('#credModelList');
        const baseURLInput = $('#credBaseURL');

        if (!vendorSelect) return; // DOM 未挂载时忽略

        // 防止重复绑定
        if (vendorSelect._vendorBound) return;
        vendorSelect._vendorBound = true;

        vendorSelect.addEventListener('change', (e) => {
          const vendor = e.target.value;
          const preset = VENDOR_PRESETS[vendor];

          // 模型框恒为自由输入，切厂商只换「建议列表」与预填值。
          // 预设列表天然滞后于厂商上新（deepseek-v4-flash 这类新模型），
          // 锁成只读下拉会逼用户改走「其他（自定义）」并重填 baseURL——
          // 白丢了预设最有价值的那部分。
          modelList.innerHTML = '';
          modelInput.value = '';

          if (!vendor) {
            modelInput.disabled = true;
            modelInput.placeholder = '先选厂商';
            baseURLInput.disabled = false;
            baseURLInput.value = '';
            return;
          }
          if (!preset) return; // 未知 vendor 值，跳过，不崩溃

          modelInput.disabled = false;
          preset.models.forEach((m) => {
            const opt = document.createElement('option');
            opt.value = m;
            modelList.appendChild(opt);
          });

          if (vendor === 'custom') {
            // 其他（自定义）：无预设可依，baseURL 与模型都由用户填
            modelInput.placeholder = '模型名，如 my-model';
            baseURLInput.disabled = false;
            baseURLInput.placeholder = 'https://api.xxx.com/v1';
            baseURLInput.value = '';
          } else {
            // 预设厂商：baseURL 锁定，模型预填第一个（仍可改写成任意值）
            modelInput.placeholder = preset.models[0] || '模型名';
            modelInput.value = preset.models[0] || '';
            baseURLInput.disabled = true;
            baseURLInput.value = preset.baseURL;
          }
        });
      }

      // —— 自定义模型（openai-compat）凭证 CRUD：走专用 /api/credentials（片B），不经 settings 池 ——
      async function loadCredentials() {
        try {
          const r = await fetch('/api/credentials');
          const d = await r.json();
          renderCredList(d.credentials || []);
        } catch {
          /* 设置未打开 / 网络问题：忽略 */
        }
      }

      function renderCredList(creds) {
        const box = $('#credList');
        if (!box) return;
        box.innerHTML = '';
        if (!creds.length) {
          box.innerHTML = '<div class="cred-empty">暂无自定义模型，填下方表单添加</div>';
          return;
        }
        creds.forEach((c) => {
          const row = document.createElement('div');
          row.className = 'token-row';
          row.dataset.id = c.id;
          // 存量凭证无 vendor → 按 baseURL 反查；未知厂商 key 原样显示（不吞信息）
          const vendorKey = c.vendor || BASEURL_TO_VENDOR[c.baseURL] || '';
          const vendorLabel = vendorKey ? (VENDOR_PRESETS[vendorKey]?.label || vendorKey) : '—';
          const displayName = c.label || ('(未命名) - ' + vendorLabel + '/' + (c.model || '?'));
          row.innerHTML =
            '<span class="t-label"></span>' +
            '<span class="t-vendor"></span>' +
            '<span class="t-model"></span>' +
            '<span class="t-base"></span>' +
            '<span class="t-mask"></span>' +
            '<span class="spacer"></span>' +
            '<button class="t-act del" title="删除">' + iconHtml(DELETE_ICON_SVG) + '</button>';
          row.querySelector('.t-label').textContent = displayName;
          row.querySelector('.t-vendor').textContent = vendorLabel;
          row.querySelector('.t-model').textContent = c.model || '';
          row.querySelector('.t-base').textContent = c.baseURL || '';
          row.querySelector('.t-mask').textContent = c.masked || '';
          row.querySelector('.del').onclick = () => deleteCredential(c.id, c.label || c.model);
          box.appendChild(row);
        });
      }

      async function addCredentialUI() {
        const label = $('#credLabel').value.trim();
        const vendor = $('#credVendor').value.trim();
        const model = $('#credModel').value.trim(); // 恒为自由输入框（预设仅作 datalist 建议）
        const baseURL = $('#credBaseURL').value.trim();
        const apiKey = $('#credApiKey').value.trim();

        if (!vendor) return toast('请选择厂商');
        if (!model) return toast('请选择或填写模型');
        if (!baseURL) return toast('请填写或确认 baseURL');
        if (!apiKey) return toast('请填写 apiKey');

        try {
          const r = await fetch('/api/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label, vendor, baseURL, model, apiKey }),
          });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '添加失败');

          // 重置表单
          $('#credLabel').value = '';
          const vs = $('#credVendor');
          vs.value = '';
          vs.dispatchEvent(new Event('change'));
          $('#credModel').value = '';
          $('#credModel').disabled = true;
          $('#credModel').placeholder = '先选厂商';
          $('#credModelList').innerHTML = '';
          $('#credBaseURL').value = '';
          $('#credBaseURL').disabled = false;
          $('#credApiKey').value = '';

          toast('自定义模型已添加');
          await loadCredentials();
        } catch {
          toast('网络错误');
        }
      }

      async function deleteCredential(id, label) {
        if (!(await confirmDialog({ title: '删除自定义模型', message: `确认删除「${label}」？`, danger: true }))) return;
        try {
          const r = await fetch('/api/credentials/' + encodeURIComponent(id), { method: 'DELETE' });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '删除失败');
          await loadCredentials();
        } catch {
          toast('网络错误');
        }
      }

      // —— 插件启停（基础 tab）：/api/plugins，重启进程后生效 ——
      async function loadPlugins() {
        try {
          const r = await fetch('/api/plugins');
          const d = await r.json();
          renderPluginList(d.plugins || []);
        } catch {
          /* 设置未打开 / 网络问题：忽略 */
        }
      }

      function renderPluginList(plugins) {
        const box = $('#pluginList');
        if (!box) return;
        box.innerHTML = '';
        plugins.forEach((p) => {
          const row = document.createElement('div');
          row.className = 'token-row';
          row.innerHTML =
            '<input type="checkbox" class="pretty-check" title="启用 / 停用（重启生效）" />' +
            '<span class="t-label"></span>' +
            '<span class="t-base plugin-desc"></span>';
          row.querySelector('.t-label').textContent = p.id;
          row.querySelector('.plugin-desc').textContent = p.description || '';
          const chk = row.querySelector('.pretty-check');
          chk.checked = p.enabled;
          chk.onchange = async () => {
            try {
              const r = await fetch('/api/plugins/' + encodeURIComponent(p.id), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: chk.checked }),
              });
              const d = await r.json();
              if (!r.ok || d.error) return toast(d.error || '保存失败');
              toast('已保存，重启进程后生效');
            } catch {
              toast('网络错误');
            }
            await loadPlugins();
          };
          box.appendChild(row);
        });
      }

      // —— MCP 服务器（stdio）CRUD：走专用 /api/mcp-servers，供自定义模型的 agentic 工具 ——
      let mcpEditingId = null; // 非空 = 表单处于「编辑」模式（复用添加表单）

      async function loadMcpServers() {
        try {
          const r = await fetch('/api/mcp-servers');
          const d = await r.json();
          renderMcpList(d.servers || []);
        } catch {
          /* 设置未打开 / 网络问题：忽略 */
        }
      }

      function renderMcpList(servers) {
        const box = $('#mcpList');
        if (!box) return;
        box.innerHTML = '';
        if (!servers.length) {
          box.innerHTML = '<div class="cred-empty">暂无 MCP 服务器，填下方表单添加</div>';
          return;
        }
        servers.forEach((m) => {
          const row = document.createElement('div');
          row.className = 'token-row' + (m.enabled ? '' : ' mcp-off');
          row.dataset.id = m.id;
          row.innerHTML =
            '<input type="checkbox" class="pretty-check" title="启用 / 停用" />' +
            '<span class="t-label"></span>' +
            '<span class="t-base mcp-cmd"></span>' +
            (m.autoAllow && m.autoAllow.length
              ? '<span class="t-base" title="自动放行：' + m.autoAllow.join(', ').replace(/"/g, '&quot;') + '">放行' + m.autoAllow.length + '</span>'
              : '') +
            (m.hasEnv ? '<span class="t-base" title="含 env 配置（仅可手改 settings.json）">env</span>' : '') +
            '<span class="spacer"></span>' +
            '<button class="t-act edit" title="编辑">' + iconHtml(EDIT_ICON_SVG) + '</button>' +
            '<button class="t-act del" title="删除">' + iconHtml(DELETE_ICON_SVG) + '</button>';
          row.querySelector('.t-label').textContent = m.label || '(未命名)';
          row.querySelector('.mcp-cmd').textContent = [m.command, ...(m.args || [])].join(' ');
          const chk = row.querySelector('.pretty-check');
          chk.checked = m.enabled;
          chk.onchange = () => toggleMcpServer(m.id, chk.checked);
          row.querySelector('.edit').onclick = () => editMcpServer(m);
          row.querySelector('.del').onclick = () => deleteMcpServer(m.id, m.label || m.command);
          box.appendChild(row);
        });
      }

      function editMcpServer(m) {
        mcpEditingId = m.id;
        $('#mcpLabel').value = m.label || '';
        $('#mcpCommand').value = m.command || '';
        $('#mcpArgs').value = (m.args || []).join('\n');
        $('#mcpCwd').value = m.cwd || '';
        $('#mcpAutoAllow').value = (m.autoAllow || []).join('\n');
        $('#mcpFormTitle').textContent = '编辑「' + (m.label || m.command) + '」';
        $('#mcpAddBtn').textContent = '保存修改';
        $('#mcpCancelBtn').hidden = false;
      }

      function resetMcpForm() {
        mcpEditingId = null;
        ['mcpLabel', 'mcpCommand', 'mcpArgs', 'mcpCwd', 'mcpAutoAllow'].forEach((id) => ($('#' + id).value = ''));
        $('#mcpFormTitle').textContent = '添加服务器';
        $('#mcpAddBtn').textContent = '＋ 添加';
        $('#mcpCancelBtn').hidden = true;
      }

      async function submitMcpForm() {
        const command = $('#mcpCommand').value.trim();
        if (!command) return toast('命令必填');
        const payload = {
          label: $('#mcpLabel').value.trim(),
          command,
          args: $('#mcpArgs').value.split('\n').map((s) => s.trim()).filter(Boolean), // 每行一个参数：路径含空格不需要引号
          cwd: $('#mcpCwd').value.trim(),
          autoAllow: $('#mcpAutoAllow').value.split('\n').map((s) => s.trim()).filter(Boolean),
        };
        try {
          const url = mcpEditingId ? '/api/mcp-servers/' + encodeURIComponent(mcpEditingId) : '/api/mcp-servers';
          const r = await fetch(url, {
            method: mcpEditingId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '保存失败');
          toast(mcpEditingId ? 'MCP 服务器已更新' : 'MCP 服务器已添加');
          resetMcpForm();
          await loadMcpServers();
        } catch {
          toast('网络错误');
        }
      }

      async function toggleMcpServer(id, enabled) {
        try {
          const r = await fetch('/api/mcp-servers/' + encodeURIComponent(id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
          });
          const d = await r.json();
          if (!r.ok || d.error) toast(d.error || '切换失败');
        } catch {
          toast('网络错误');
        }
        await loadMcpServers();
      }

      async function deleteMcpServer(id, label) {
        if (!(await confirmDialog({ title: '删除 MCP 服务器', message: `确认删除「${label}」？`, danger: true }))) return;
        try {
          const r = await fetch('/api/mcp-servers/' + encodeURIComponent(id), { method: 'DELETE' });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '删除失败');
          if (mcpEditingId === id) resetMcpForm(); // 正在编辑被删条目 → 复位表单
          await loadMcpServers();
        } catch {
          toast('网络错误');
        }
      }

      // ==== 会话清理 tab ====
      // 当前工作目录：与 chat.js 一致，优先 window.__PROJECT_CWD__（打包版），否则读 localStorage。
      function cleanupCwd() {
        const w = window.__PROJECT_CWD__;
        return typeof w === 'string' ? w : (localStorage.getItem('claude_cwd') || '');
      }

      // 读当前选中的时间窗：range 优先，其次自定义日期。无有效选择返回 null。
      function cleanupWindow() {
        const checked = document.querySelector('input[name="cleanupRange"]:checked');
        if (checked) return { range: checked.value };
        const from = $('#cleanupFrom')?.value || '';
        const to = $('#cleanupTo')?.value || '';
        if (from || to) return { fromDate: from, toDate: to };
        return null;
      }

      // 拉当前目录统计并刷新面板；重置选择与按钮态
      async function loadCleanupStats() {
        const cwd = cleanupCwd();
        $('#cleanupCwd').textContent = cwd || '（服务目录）';
        try {
          const r = await fetch('/api/cleanup/stats?cwd=' + encodeURIComponent(cwd));
          const d = await r.json();
          $('#cleanupTotal').textContent = d.error ? '不可用' : d.totalCount;
        } catch {
          $('#cleanupTotal').textContent = '读取失败';
        }
        $('#cleanupWillDelete').textContent = '0';
        $('#cleanupExecBtn').disabled = true;
      }

      // 预计算待删数（选择变化时触发），并据此启用/禁用清理按钮
      async function previewCleanup() {
        const win = cleanupWindow();
        const willDelete = $('#cleanupWillDelete');
        const btn = $('#cleanupExecBtn');
        if (!win) { willDelete.textContent = '0'; btn.disabled = true; return; }
        const params = new URLSearchParams({ cwd: cleanupCwd() });
        if (win.range) params.set('range', win.range);
        if (win.fromDate) params.set('fromDate', win.fromDate);
        if (win.toDate) params.set('toDate', win.toDate);
        try {
          const r = await fetch('/api/cleanup/preview?' + params.toString());
          const d = await r.json();
          const n = d.willDeleteCount || 0;
          willDelete.textContent = n;
          btn.disabled = n === 0; // 无命中不允许执行
        } catch {
          willDelete.textContent = '?';
          btn.disabled = true;
        }
      }

      // 执行清理：危险操作，先确认再 POST
      async function executeCleanup() {
        const win = cleanupWindow();
        if (!win) return;
        const count = $('#cleanupWillDelete').textContent;
        const ok = await confirmDialog({
          title: '⚠️ 危险操作',
          message: `确定删除 ${count} 个会话？此操作不可恢复。`,
          danger: true,
          confirmText: '确认删除',
        });
        if (!ok) return;
        try {
          const r = await fetch('/api/cleanup/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cwd: cleanupCwd(), ...win, confirmed: true }),
          });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '清理失败');
          const skipped = d.skippedCount ? `，跳过 ${d.skippedCount} 个占用文件` : '';
          toast(`✓ 已删除 ${d.deletedCount} 个会话${skipped}`);
          await loadCleanupStats(); // 刷新总数并复位选择
        } catch {
          toast('网络错误，请重试');
        }
      }

      // 绑定清理页交互（只绑一次，随 bindConfigTransfer 初始化）
      function bindCleanup() {
        $('#cleanupRanges')?.addEventListener('change', previewCleanup);
        $('#cleanupFrom')?.addEventListener('change', previewCleanup);
        $('#cleanupTo')?.addEventListener('change', previewCleanup);
        $('#cleanupCustomToggle')?.addEventListener('click', () => {
          const box = $('#cleanupCustom');
          if (box) box.hidden = !box.hidden;
        });
        $('#cleanupExecBtn')?.addEventListener('click', executeCleanup);
      }

      // 设置页内部 tab（纯显隐，不重复拉数据）
      const settingsTabs = $('#settingsTabs');
      [...settingsTabs.querySelectorAll('button')].forEach((b) => {
        b.addEventListener('click', () => {
          [...settingsTabs.querySelectorAll('button')].forEach((x) =>
            x.classList.toggle('active', x === b),
          );
          // 显式取元素：panelView 常量在 app.js，勿依赖浏览器 id 隐式全局
          $('#panelView')
            .querySelectorAll('.set-tab')
            .forEach((p) => (p.hidden = p.dataset.tab !== b.dataset.tab));
          // 清理页首次/每次打开时拉当前目录统计（数据依赖工作目录，不能只在 loadSettings 拉一次）
          if (b.dataset.tab === 'cleanup') loadCleanupStats();
        });
      });
      bindCleanup();
      $('#tokenAddBtn').addEventListener('click', addTokenUI);
      $('#credAddBtn')?.addEventListener('click', addCredentialUI);
      $('#mcpAddBtn')?.addEventListener('click', submitMcpForm);
      $('#mcpCancelBtn')?.addEventListener('click', resetMcpForm);
      // 基础 tab - 新会话默认值
      document.getElementById('basicDefaultsSaveBtn')?.addEventListener('click', async () => {
        const model = document.getElementById('basicDefaultModel').value;
        const effort = document.getElementById('basicDefaultEffort').value;
        const mode = document.getElementById('basicDefaultMode').value;
        if (await postSettings({ section: 'ui-prefs', defaultModel: model, defaultEffort: effort, defaultMode: mode })) {
          toast('新会话默认值已保存');
        }
      });
      document.getElementById('basicMyFeishuOpenIdSaveBtn')?.addEventListener('click', async () => {
        const myFeishuOpenId = document.getElementById('basicMyFeishuOpenId').value;
        if (await postSettings({ section: 'profile', myFeishuOpenId })) {
          toast('我的飞书 open_id 已保存');
        }
      });

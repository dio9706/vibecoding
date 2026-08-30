/** 动作配置面板：列表 / 表单编辑 / 变量表 / 删除。动作 per-bot 独享：
 *  由 bots-panel 经 setActionsBot(botId) 注入当前机器人上下文后才加载/新建。 */
import { $, escapeHtml } from './util.js';
import { toast, confirmDialog } from './ui.js';
import { getJson, postJson, putJson, delJson } from './api.js';

      let currentBotId = null; // 当前编辑中的机器人（动作归属）

      /** bots-panel 注入机器人上下文；null = 关闭动作区 */
      export function setActionsBot(botId) {
        currentBotId = botId;
        if (botId) renderActionsList();
      }

      // ---- 动作配置（loadActions / renderActionsList / showActionForm / deleteAction）----
      async function loadActions() {
        if (!currentBotId) return [];
        try {
          // 该接口直接返回数组，不是 {actions:[...]}
          const { data } = await getJson('/api/actions?botId=' + encodeURIComponent(currentBotId));
          return Array.isArray(data) ? data : [];
        } catch (e) {
          console.error('加载动作配置失败', e);
          return [];
        }
      }

      async function renderActionsList() {
        const actions = await loadActions();
        const container = $('#actionsList');
        container.innerHTML = actions.length === 0
          ? `<div style="color:var(--faint);font-size:13px;padding:12px 0;">暂无动作配置，点击「+ 添加动作」新建</div>`
          : actions.map((a) => `
          <div class="action-card">
            <div class="action-name">${escapeHtml(a.name)}${a.enabled === false ? ' <span style="color:var(--faint);font-size:11px;">(已禁用)</span>' : ''}</div>
            <div class="action-meta">关键词：${escapeHtml((a.keywords || []).join(', ') || '—')}</div>
            <div class="action-meta">脚本：${escapeHtml(a.scriptName || '—')} · 权限：${escapeHtml(a.permission || 'guest')}</div>
            <div style="margin-top: 8px; display:flex; gap:6px;">
              <button data-action-id="${escapeHtml(a.id)}" class="editActionBtn btn">编辑</button>
              <button data-action-id="${escapeHtml(a.id)}" class="deleteActionBtn btn">删除</button>
            </div>
          </div>
        `).join('');

        // 事件委托
        container.querySelectorAll('.editActionBtn').forEach((btn) => {
          btn.addEventListener('click', () => showActionForm(btn.dataset.actionId));
        });
        container.querySelectorAll('.deleteActionBtn').forEach((btn) => {
          btn.addEventListener('click', () => deleteAction(btn.dataset.actionId));
        });
      }

      async function showActionForm(actionId) {
        const formPanel = $('#actionFormPanel');
        const form = $('#actionForm');

        let action = null;
        if (actionId) {
          const all = await loadActions();
          action = all.find((a) => a.id === actionId) || null;
        }

        form.innerHTML = `
          <h3>${action ? '编辑动作' : '新建动作'}</h3>
          <label>
            动作名称：<input type="text" id="actionName" value="${escapeHtml(action?.name || '')}" required />
          </label>
          <label>
            意图描述：<textarea id="actionDesc" required>${escapeHtml(action?.description || '')}</textarea>
          </label>
          <label>
            示例文案（可选）：<textarea id="actionExample" placeholder="如：输入用户 ID，如 alice@company.com" maxlength="200" rows="2">${escapeHtml(action?.example || '')}</textarea>
            <small style="display:block;margin-top:4px;color:var(--faint);">用于卡片按钮的提示文案，30-100 字符最佳</small>
          </label>
          <label>
            关键词（逗号分隔）：<input type="text" id="actionKeywords" value="${escapeHtml((action?.keywords || []).join(', '))}" />
          </label>
          <label>脚本文件（.py / .js）：</label>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <button type="button" id="uploadScriptBtn" class="btn">上传脚本</button>
            <input type="file" id="scriptFileInput" accept=".py,.js" style="display:none;" />
            <span id="currentScriptLabel" style="font-size:13px;color:var(--faint);"></span>
          </div>
          <label>
            权限：
            <select id="permission">
              <option value="guest" ${action?.permission === 'guest' ? 'selected' : ''}>Guest</option>
              <option value="owner" ${action?.permission === 'owner' ? 'selected' : ''}>Owner</option>
            </select>
          </label>
          <label class="inline-check">
            <input type="checkbox" id="enabled" ${action?.enabled !== false ? 'checked' : ''} />
            启用此动作
          </label>

          <h4>变量</h4>
          <div id="variablesTable"></div>
          <button type="button" id="addVarBtn" class="btn">+ 添加变量</button>

          <div style="margin-top: 16px; display: flex; gap: 8px;">
            <button type="submit" class="btn primary">保存</button>
            <button type="button" id="cancelFormBtn" class="btn">取消</button>
          </div>
        `;

        renderVariablesTable(action?.variables || []);

        // 脚本以上传方式提供：用闭包变量承载，保存时读取（编辑时默认沿用原值）
        let currentScriptName = action?.scriptName || '';
        let currentScriptType = action?.scriptType || '';
        const scriptLabel = $('#currentScriptLabel');
        const paintScript = () => {
          scriptLabel.textContent = currentScriptName
            ? `当前脚本：${currentScriptName}（${currentScriptType || '?'}）`
            : '未选择脚本';
        };
        paintScript();

        const fileInput = $('#scriptFileInput');
        $('#uploadScriptBtn').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files[0];
          if (!file) return;
          try {
            // 刻意不走 api.js：请求体是 File 二进制，不是 JSON。
            // postJson 会强加 Content-Type: application/json 并 JSON.stringify 掉它。
            const res = await fetch('/api/scripts/upload?name=' + encodeURIComponent(file.name), {
              method: 'POST',
              body: file,
            });
            const data = await res.json();
            if (res.ok) {
              currentScriptName = data.scriptName;
              currentScriptType = data.scriptType;
              paintScript();
              toast('脚本已上传：' + data.scriptName);
            } else {
              toast(data.error || '上传失败');
            }
          } catch (e) {
            toast('上传失败: ' + e.message);
          } finally {
            fileInput.value = '';
          }
        });

        // 用 onsubmit 赋值而非 addEventListener：#actionForm 元素常驻，innerHTML 只换子节点，
        // 每次打开表单都 addEventListener 会累积历史闭包，一次「保存」触发多个旧 handler，
        // 造成重复新增（尤其编辑时旧的 actionId=null 闭包会额外 POST 一条）。onsubmit 只保留最新一个。
        form.onsubmit = (e) => {
          e.preventDefault();
          saveAction(actionId, { scriptName: currentScriptName, scriptType: currentScriptType });
        };

        $('#cancelFormBtn').addEventListener('click', () => {
          formPanel.style.display = 'none';
          renderActionsList();
        });

        $('#addVarBtn').addEventListener('click', () => {
          addVariableRow();
        });

        formPanel.style.display = 'block';
      }

      function renderVariablesTable(variables) {
        const table = $('#variablesTable');
        table.innerHTML = `
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr>
                <th>名称</th><th>标签</th><th>追问文案</th><th>必填</th><th>永久存储</th><th>删除</th>
              </tr>
            </thead>
            <tbody id="variablesBody">
            </tbody>
          </table>
        `;
        const body = $('#variablesBody');
        variables.forEach((v) => {
          const row = document.createElement('tr');
          row.innerHTML = `
            <td><input type="text" class="varName" value="${escapeHtml(v.name || '')}" /></td>
            <td><input type="text" class="varLabel" value="${escapeHtml(v.label || '')}" /></td>
            <td><input type="text" class="varPrompt" value="${escapeHtml(v.prompt || '')}" /></td>
            <td><input type="checkbox" class="varRequired" ${v.required ? 'checked' : ''} /></td>
            <td><input type="checkbox" class="varPersistent" ${v.persistent ? 'checked' : ''} /></td>
            <td><button type="button" class="deleteVarBtn btn">删除</button></td>
          `;
          body.appendChild(row);
          row.querySelector('.deleteVarBtn').addEventListener('click', () => row.remove());
        });
      }

      function addVariableRow() {
        const body = $('#variablesBody');
        const row = document.createElement('tr');
        row.innerHTML = `
          <td><input type="text" class="varName" /></td>
          <td><input type="text" class="varLabel" /></td>
          <td><input type="text" class="varPrompt" /></td>
          <td><input type="checkbox" class="varRequired" /></td>
          <td><input type="checkbox" class="varPersistent" /></td>
          <td><button type="button" class="deleteVarBtn btn">删除</button></td>
        `;
        body.appendChild(row);
        row.querySelector('.deleteVarBtn').addEventListener('click', () => row.remove());
      }

      async function saveAction(actionId, scriptInfo) {
        if (!scriptInfo.scriptName) {
          toast('请先上传脚本文件');
          return;
        }
        const variables = Array.from(document.querySelectorAll('#variablesBody tr')).map((row) => ({
          name: row.querySelector('.varName').value,
          label: row.querySelector('.varLabel').value,
          prompt: row.querySelector('.varPrompt').value,
          required: row.querySelector('.varRequired').checked,
          persistent: row.querySelector('.varPersistent').checked,
        }));

        const payload = {
          botId: currentBotId, // 新建时归属当前机器人；更新时服务端剥离（归属不可改）
          name: $('#actionName').value,
          description: $('#actionDesc').value,
          example: $('#actionExample').value || '', // 示例文案（可选）
          keywords: $('#actionKeywords').value.split(',').map((k) => k.trim()).filter(Boolean),
          scriptType: scriptInfo.scriptType,
          scriptName: scriptInfo.scriptName,
          permission: $('#permission').value,
          enabled: $('#enabled').checked,
          variables,
        };

        const url = actionId ? `/api/actions/${actionId}` : '/api/actions';

        try {
          const res = actionId ? await putJson(url, payload) : await postJson(url, payload);
          if (res.ok) {
            $('#actionFormPanel').style.display = 'none';
            await renderActionsList();
            toast('已保存');
          } else {
            toast('保存失败');
          }
        } catch (e) {
          toast('保存失败: ' + e.message);
        }
      }

      async function deleteAction(actionId) {
        if (!(await confirmDialog({ title: '删除动作', message: '确认删除该动作？', danger: true }))) return;
        try {
          const res = await delJson(`/api/actions/${actionId}`);
          if (res.ok) {
            await renderActionsList();
          } else {
            toast('删除失败');
          }
        } catch (e) {
          toast('删除失败: ' + e.message);
        }
      }

      $('#addActionBtn')?.addEventListener('click', () => {
        if (!currentBotId) return toast('请先保存机器人，再配置动作');
        showActionForm(null);
      });

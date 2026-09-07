/** 动作配置面板：列表 / 表单编辑 / 变量表 / 删除。动作 per-bot 独享：
 *  由 bots-panel 经 setActionsBot(botId) 注入当前机器人上下文后才加载/新建。 */
import { $, escapeHtml } from './util.js';
import { toast, confirmDialog } from './ui.js';
import { getJson, postJson, putJson, delJson } from './api.js';
import { parseAliasLines, formatAliasLines, buildVarDecl } from './actions-panel.logic.js';

      let currentBotId = null; // 当前编辑中的机器人（动作归属）

      /**
       * 变量预置表（后端 /api/action-presets）。
       * **不在前端抄一份** —— 这次改造的起因之一就是同一张 env 别名表在 Node 侧与
       * get_qrcode.py 各存一份并已分叉。前端只读展示，真相仍只有 var-presets.js 一份。
       */
      let presetTable = {};

      async function loadPresets() {
        try {
          const { data } = await getJson('/api/action-presets');
          if (data && typeof data === 'object') presetTable = data;
        } catch (e) {
          console.error('加载变量预置表失败（不影响手写 enum/aliases）', e);
        }
      }


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

        // 预置表只用于「展开为可编辑」按钮，拉不到也不影响手写 enum/aliases，故不 await 失败路径
        if (!Object.keys(presetTable).length) await loadPresets();
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

      /**
       * 预置下拉的选项：**从已加载的 presetTable 现算**，不另存一份清单。
       *
       * 这里曾硬编码 `['', 'env', 'phone']` —— 后端 var-presets.js 加一个预置，前端就选不到，
       * 而这正是本次改造要消灭的「同一份知识存两处」的模式（抽取器已经不认变量名了，
       * 前端不该再认预置名）。
       *
       * 两个边界：
       * - presetTable 为空（loadPresets 失败）时只剩「（无）」，是**正确的降级** ——
       *   宁可让用户选不到，也不要给出一个后端不认、保存必被 422 拒的选项。
       * - 编辑既有变量时把它当前的 preset 值也并进来（哪怕后端已经删了这个预置），
       *   否则下拉会静默把它洗成「（无）」，用户一保存就丢配置。
       */
      function presetOptionsFor(current) {
        const known = Object.keys(presetTable);
        const cur = typeof current === 'string' ? current : '';
        return [...new Set(['', ...known, cur])];
      }

      /**
       * 一个变量渲染成**两行**：主行（基础字段）+ 折叠的规则行（抽取契约）。
       * 之所以折叠：字段从 5 个涨到 10 个，全铺在一行会宽到没法用，而抽取规则
       * 对多数变量是可选的（不填 = 自由文本，走 LLM，行为与改造前一致）。
       */
      function variableRows(v = {}) {
        const body = $('#variablesBody');
        const main = document.createElement('tr');
        main.className = 'varRow';
        main.innerHTML = `
          <td><input type="text" class="varName" value="${escapeHtml(v.name || '')}" /></td>
          <td><input type="text" class="varLabel" value="${escapeHtml(v.label || '')}" /></td>
          <td><input type="text" class="varPrompt" value="${escapeHtml(v.prompt || '')}" /></td>
          <td><input type="checkbox" class="varRequired" ${v.required ? 'checked' : ''} /></td>
          <td><input type="checkbox" class="varPersistent" ${v.persistent ? 'checked' : ''} /></td>
          <td>
            <select class="varPreset">
              ${presetOptionsFor(v.preset)
                .map((p) => {
                  const selected = (v.preset || '') === p ? ' selected' : '';
                  const unknown = p && !presetTable[p] ? '（未知）' : '';
                  return `<option value="${escapeHtml(p)}"${selected}>${escapeHtml(p) || '（无）'}${unknown}</option>`;
                })
                .join('')}
            </select>
          </td>
          <td style="white-space:nowrap;">
            <button type="button" class="toggleVarRuleBtn btn">规则</button>
            <button type="button" class="deleteVarBtn btn">删除</button>
          </td>
        `;

        const detail = document.createElement('tr');
        detail.className = 'varRuleRow';
        detail.style.display = 'none';
        detail.innerHTML = `
          <td colspan="7" style="padding:8px 12px;background:var(--panel,#f7f7f8);">
            <div style="font-size:12px;color:var(--faint);margin-bottom:6px;">
              抽取规则决定这个变量<b>怎么被识别</b>。填了「合法值」或「正则」就走本地零成本抽取；
              都不填则视为自由文本，每次都要调模型（慢 8~17 秒）。选了预置且这里留空，即沿用预置内容。
            </div>
            <label style="display:block;margin:4px 0;">合法值（逗号分隔，与正则二选一）：
              <input type="text" class="varEnum" value="${escapeHtml((v.enum || []).join(', '))}" />
            </label>
            <label style="display:block;margin:4px 0;">别名（每行一条 <code>别名=合法值</code>）：
              <textarea class="varAliases" rows="3">${escapeHtml(formatAliasLines(v.aliases))}</textarea>
            </label>
            <label style="display:block;margin:4px 0;">歧义别名（仅在机器人追问时才识别，格式同上）：
              <textarea class="varWeakAliases" rows="2">${escapeHtml(formatAliasLines(v.weakAliases))}</textarea>
            </label>
            <label style="display:block;margin:4px 0;">正则（<b>不要写 ^ 和 $</b>，系统校验时自动加）：
              <input type="text" class="varPattern" value="${escapeHtml(v.pattern || '')}" />
            </label>
            <label style="display:block;margin:4px 0;">示例值（喂给模型看的）：
              <input type="text" class="varExample" value="${escapeHtml(v.example || '')}" />
            </label>
            <button type="button" class="expandPresetBtn btn" style="margin-top:6px;">展开预置为可编辑</button>
            <span style="font-size:12px;color:var(--faint);margin-left:8px;">
              把预置内容填进上面各框，之后可自由增删（填了就不再跟随预置更新）
            </span>
          </td>
        `;

        body.appendChild(main);
        body.appendChild(detail);

        main.querySelector('.deleteVarBtn').addEventListener('click', () => {
          detail.remove();
          main.remove();
        });
        main.querySelector('.toggleVarRuleBtn').addEventListener('click', () => {
          detail.style.display = detail.style.display === 'none' ? '' : 'none';
        });
        detail.querySelector('.expandPresetBtn').addEventListener('click', () => {
          const p = presetTable[main.querySelector('.varPreset').value];
          if (!p) return toast('请先选择一个预置类型');
          // 只在目标框为空时填，避免一键抹掉用户已经写好的内容；
          // 跳过了哪些要**明确告诉用户**，否则他会以为预置内容已经全进来了，
          // 而实际上那几个框还是他自己的旧值 —— 保存后行为与预期不符且很难查。
          const skipped = [];
          const fill = (sel, label, val) => {
            const el = detail.querySelector(sel);
            if (String(el.value || '').trim()) {
              if (val) skipped.push(label);
              return;
            }
            el.value = val;
          };
          fill('.varEnum', '合法值', (p.enum || []).join(', '));
          fill('.varAliases', '别名', formatAliasLines(p.aliases));
          fill('.varWeakAliases', '歧义别名', formatAliasLines(p.weakAliases));
          fill('.varPattern', '正则', p.pattern || '');
          fill('.varExample', '示例值', p.example || '');
          // 标记「已实体化」：此后各框即真相，清空某个框就是「删掉它」，
          // buildVarDecl 会如实下发空值而不是省略（省略会让浅覆盖把预置内容补回来）。
          detail.dataset.expanded = '1';
          toast(
            skipped.length
              ? `预置内容已填入；${skipped.join('、')}已有内容，保留了你填的值`
              : '预置内容已填入，之后可自由增删',
          );
        });

        return main;
      }

      function renderVariablesTable(variables) {
        const table = $('#variablesTable');
        table.innerHTML = `
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr>
                <th>名称</th><th>标签</th><th>追问文案</th><th>必填</th><th>永久存储</th><th>预置</th><th>操作</th>
              </tr>
            </thead>
            <tbody id="variablesBody">
            </tbody>
          </table>
        `;
        variables.forEach((v) => variableRows(v));
      }

      function addVariableRow() {
        variableRows({});
      }

      /**
       * 读一行变量的声明。
       *
       * 规则行是主行的**下一个兄弟节点**（variableRows 成对 append，删除也成对）。
       * 取不到时 val() 回落空串，等价于「规则全部留空」—— 退化成沿用 preset / 自由文本，
       * 不会产出脏声明。拼装逻辑在 actions-panel.logic.js（纯函数，有单测）。
       */
      function readVarRow(main) {
        const detail = main.nextElementSibling?.classList.contains('varRuleRow')
          ? main.nextElementSibling
          : null;
        const val = (sel) => detail?.querySelector(sel)?.value || '';
        return buildVarDecl({
          name: main.querySelector('.varName').value,
          label: main.querySelector('.varLabel').value,
          prompt: main.querySelector('.varPrompt').value,
          required: main.querySelector('.varRequired').checked,
          persistent: main.querySelector('.varPersistent').checked,
          preset: main.querySelector('.varPreset').value,
          enumText: val('.varEnum'),
          aliasesText: val('.varAliases'),
          weakAliasesText: val('.varWeakAliases'),
          pattern: val('.varPattern'),
          example: val('.varExample'),
          expanded: detail?.dataset.expanded === '1',
        });
      }

      async function saveAction(actionId, scriptInfo) {
        if (!scriptInfo.scriptName) {
          toast('请先上传脚本文件');
          return;
        }
        // 只取主行（.varRow）；每个变量还有一条折叠的规则行，由 readVarRow 顺着读
        const variables = Array.from(document.querySelectorAll('#variablesBody tr.varRow')).map(readVarRow);

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
            // 422 = 变量声明校验没过，后端给的是能直接读的中文说明（哪个变量的哪个字段）。
            // 必须原样透出：吞掉只留一句「保存失败」会让用户完全不知道该改哪。
            toast(res.data?.error ? `保存失败：${res.data.error}` : '保存失败');
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

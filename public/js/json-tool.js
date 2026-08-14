/** JSON 美化工具面板（自研可折叠树）。入口 initJsonTool 由 showView('json-tool') 调用。 */
import { $, debounce } from './util.js';
import { toast } from './ui.js';
      // ============================================================
      // JSON 美化工具（自研原生可折叠树，零外部依赖）
      // ============================================================
      let _jsonToolBound = false;
      let _jsonLast = undefined;   // 最近一次成功解析的值（供展开/折叠/复制/格式化）
      let _jsonHasValue = false;
      export function initJsonTool() {
        if (_jsonToolBound) return; // 仅绑定一次；后续进入视图直接复用
        _jsonToolBound = true;
        const inputEl = $('#jsonInput');
        const outputEl = $('#jsonOutput');
        if (!inputEl || !outputEl) return;
        const renderDebounced = debounce(() => renderJsonOutput(inputEl.value), 250);
        inputEl.addEventListener('input', renderDebounced);
        $('#jsonFormatBtn')?.addEventListener('click', () => {
          if (!_jsonHasValue) return;
          inputEl.value = JSON.stringify(_jsonLast, null, 2);
          renderJsonOutput(inputEl.value);
        });
        $('#jsonClearBtn')?.addEventListener('click', () => {
          inputEl.value = '';
          renderJsonOutput('');
          inputEl.focus();
        });
        $('#jsonExpandBtn')?.addEventListener('click', () => setJsonCollapsedAll(false));
        $('#jsonCollapseBtn')?.addEventListener('click', () => setJsonCollapsedAll(true));
        $('#jsonCopyBtn')?.addEventListener('click', () => {
          if (!_jsonHasValue) return;
          const s = JSON.stringify(_jsonLast, null, 2);
          navigator.clipboard?.writeText(s).then(
            () => toast('已复制格式化 JSON'),
            () => toast('复制失败'),
          );
        });
        renderJsonOutput(inputEl.value); // 初次按已有内容渲染
      }
      function setJsonCollapsedAll(collapsed) {
        const outputEl = $('#jsonOutput');
        if (!outputEl) return;
        outputEl
          .querySelectorAll('.jt-node.jt-branch')
          .forEach((n) => n.classList.toggle('collapsed', collapsed));
      }
      function renderJsonOutput(text) {
        const outputEl = $('#jsonOutput');
        if (!outputEl) return;
        const trimmed = (text || '').trim();
        outputEl.innerHTML = '';
        if (!trimmed) {
          _jsonHasValue = false; _jsonLast = undefined;
          const hint = document.createElement('div');
          hint.className = 'jt-hint';
          hint.textContent = '在左侧粘贴 JSON，这里会实时解析。';
          outputEl.appendChild(hint);
          return;
        }
        let value;
        try {
          value = JSON.parse(trimmed);
        } catch (err) {
          _jsonHasValue = false; _jsonLast = undefined;
          const errEl = document.createElement('div');
          errEl.className = 'jt-error';
          errEl.textContent = '✕ JSON 解析失败：' + (err?.message || String(err));
          outputEl.appendChild(errEl);
          return;
        }
        _jsonHasValue = true; _jsonLast = value;
        outputEl.appendChild(buildJsonNode(value, null, true));
      }
      function jsonCommaEl() {
        const c = document.createElement('span');
        c.className = 'jt-comma';
        c.textContent = ',';
        return c;
      }
      function jsonKeyEl(key) {
        if (key === null) return null;
        const k = document.createElement('span');
        k.className = 'jt-key';
        k.textContent = (typeof key === 'number' ? String(key) : JSON.stringify(key)) + ': ';
        return k;
      }
      function jsonValClass(v) {
        if (v === null) return 'jt-null';
        switch (typeof v) {
          case 'string': return 'jt-string';
          case 'number': return 'jt-number';
          case 'boolean': return 'jt-boolean';
          default: return '';
        }
      }
      function jsonValText(v) {
        if (v === null) return 'null';
        if (typeof v === 'string') return JSON.stringify(v); // 带引号并转义
        return String(v);
      }
      // 递归构造可折叠 JSON 节点。key=null 表示无键名（顶层）；数组元素用下标作 key。
      function buildJsonNode(value, key, isLast) {
        const node = document.createElement('div');
        node.className = 'jt-node';
        const isObj = value !== null && typeof value === 'object';

        if (!isObj) {
          const line = document.createElement('div');
          line.className = 'jt-line';
          const ks = jsonKeyEl(key);
          if (ks) line.appendChild(ks);
          const v = document.createElement('span');
          v.className = 'jt-val ' + jsonValClass(value);
          v.textContent = jsonValText(value);
          line.appendChild(v);
          if (!isLast) line.appendChild(jsonCommaEl());
          node.appendChild(line);
          return node;
        }

        node.classList.add('jt-branch');
        const isArr = Array.isArray(value);
        const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
        const openCh = isArr ? '[' : '{';
        const closeCh = isArr ? ']' : '}';

        const head = document.createElement('div');
        head.className = 'jt-line jt-head';
        const toggle = document.createElement('span');
        toggle.className = 'jt-toggle';
        head.appendChild(toggle);
        const ks = jsonKeyEl(key);
        if (ks) head.appendChild(ks);
        const openBr = document.createElement('span');
        openBr.className = 'jt-bracket';
        openBr.textContent = openCh;
        head.appendChild(openBr);
        const summary = document.createElement('span');
        summary.className = 'jt-summary';
        summary.textContent = ' … ' + entries.length + ' 项 ' + closeCh;
        head.appendChild(summary);
        node.appendChild(head);

        const children = document.createElement('div');
        children.className = 'jt-children';
        entries.forEach(([k, v], idx) =>
          children.appendChild(buildJsonNode(v, k, idx === entries.length - 1)),
        );
        node.appendChild(children);

        const foot = document.createElement('div');
        foot.className = 'jt-line jt-foot';
        const closeBr = document.createElement('span');
        closeBr.className = 'jt-bracket';
        closeBr.textContent = closeCh;
        foot.appendChild(closeBr);
        if (!isLast) foot.appendChild(jsonCommaEl());
        node.appendChild(foot);

        if (!entries.length) {
          toggle.classList.add('empty'); // 空容器不可折叠
          summary.textContent = closeCh;
        } else {
          const doToggle = (ev) => { ev.stopPropagation(); node.classList.toggle('collapsed'); };
          toggle.addEventListener('click', doToggle);
          head.addEventListener('click', doToggle);
        }
        return node;
      }

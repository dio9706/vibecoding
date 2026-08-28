/** 工作目录弹层：浏览 / 常用目录 / 选择应用。cwd 归属 app.js——读取与应用经 bindDirPopover 注入，
 *  避免反向依赖；selectDir 留在 app.js（要联动 saveUiPrefs / 历史缓存 / 目录标签）。 */
import { $ } from './util.js';
import { toast } from './ui.js';
// ui.js 的 toast 只有 info 级，系统对话框失败要出红色提示，另取 toast.js 的分级 API
import toastApi from './toast.js';

let _defaults = { getCwd: () => '', selectDir: () => {} };
let _getCwd = () => '';
let _selectDir = () => {};
/** 注入 cwd 读取器与目录应用回调（app.js 在 import 后立即调用） */
export function bindDirPopover({ getCwd, selectDir }) {
  _defaults = { getCwd, selectDir };
  _getCwd = getCwd;
  _selectDir = selectDir;
}

/** 恢复默认宿主（chat）的绑定 */
function restoreDefaults() {
  _getCwd = _defaults.getCwd;
  _selectDir = _defaults.selectDir;
}

/**
 * 供其它面板临时借用目录弹层。
 *
 * 为什么需要它：_getCwd/_selectDir 是模块级单例，chat.js 已经占用；
 * 而 chat 的 selectDir 带「一窗一项目」逻辑（选不同目录会开新窗口），
 * 其它面板直接复用会误触发。弹层是模态的，同一时刻只有一个宿主在用，
 * 时序上安全；借用期结束必须恢复，否则顶栏的工作目录选择会坏掉。
 */
export function openDirPickerFor({ getCwd, selectDir }) {
  _getCwd = getCwd || (() => '');
  _selectDir = (p) => {
    if (selectDir) selectDir(p);
    closeDirModal(); // 内部会 restoreDefaults
  };
  openDirModal();
}

      let browsePath = ''; // 目录弹层当前浏览路径
      // ---- 目录弹层 ----
      async function openDirModal() {
        $('#dirMask').hidden = false;
        await loadSaved();
        await browse(_getCwd() || '');
      }
      export function closeDirModal() {
        $('#dirMask').hidden = true;
        // 无论走「选定」、✕ 还是点遮罩，都在这里统一交还绑定给默认宿主
        restoreDefaults();
      }
      async function loadSaved() {
        const list = document.querySelector('#savedList');
        list.innerHTML = '';
        try {
          const { dirs } = await (await fetch('/api/dirs/saved')).json();
          if (!dirs || !dirs.length) {
            list.innerHTML = '<div style="color:var(--faint);font-size:12px">（暂无，浏览到某目录后点＋常用）</div>';
            return;
          }
          for (const p of dirs) {
            const row = document.createElement('div');
            row.className = 'saved-item';
            row.innerHTML =
              '<span class="folder">📁</span><span class="path"></span><button class="rm">✕</button>';
            row.querySelector('.path').textContent = p;
            row.querySelector('.path').onclick = () => _selectDir(p);
            row.querySelector('.folder').onclick = () => _selectDir(p);
            row.querySelector('.rm').onclick = async (ev) => {
              ev.stopPropagation();
              await fetch('/api/dirs/saved', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'remove', path: p }),
              });
              loadSaved();
            };
            list.appendChild(row);
          }
        } catch {
          list.innerHTML = '<div style="color:var(--red);font-size:12px">读取失败</div>';
        }
      }
      async function browse(path) {
        const rows = $('#dirRows');
        rows.innerHTML = '<div style="color:var(--faint);padding:8px">加载中…</div>';
        try {
          const data = await (
            await fetch('/api/dirs/browse?path=' + encodeURIComponent(path || ''))
          ).json();
          if (data.error) {
            rows.innerHTML = '<div style="color:var(--red);padding:8px">' + data.error + '</div>';
            return;
          }
          browsePath = data.current;
          $('#curPath').textContent = data.current;
          $('#curPath').title = data.current;
          $('#pathInput').value = data.current;
          rows.innerHTML = '';
          if (data.parent) {
            const up = document.createElement('div');
            up.className = 'dir-row up';
            up.innerHTML = '<span class="folder">⬆</span><span>上级目录</span>';
            up.onclick = () => browse(data.parent);
            rows.appendChild(up);
          }
          for (const name of data.dirs) {
            const row = document.createElement('div');
            row.className = 'dir-row';
            row.innerHTML = '<span class="folder">📁</span><span></span>';
            row.querySelector('span:last-child').textContent = name;
            const fullPath = joinPath(data.current, name);
            row.onclick = () => browse(fullPath);
            // 右键菜单：用 AI 编辑器打开
            row.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              showDirContextMenu(e.clientX, e.clientY, fullPath);
            });
            rows.appendChild(row);
          }
          if (!data.dirs.length) {
            const none = document.createElement('div');
            none.style.cssText = 'color:var(--faint);padding:8px;font-size:12px';
            none.textContent = '（无子目录）';
            rows.appendChild(none);
          }
        } catch {
          rows.innerHTML = '<div style="color:var(--red);padding:8px">读取失败</div>';
        }
      }
      /** 目录浏览器右键菜单 */
      function showDirContextMenu(x, y, dirPath) {
        // 关闭已有菜单
        const prev = document.getElementById('_dir-ctx-menu');
        if (prev) prev.remove();

        const menu = document.createElement('div');
        menu.id = '_dir-ctx-menu';
        Object.assign(menu.style, {
          position: 'fixed', left: x + 'px', top: y + 'px',
          // --bg2 从未在 :root 定义过，此前一直静默吃 fallback #252525，
          // 与其它浮层面板色（--panel-2）不一致；改用实际存在的变量。
          background: 'var(--panel-2)',
          border: '1px solid var(--border)',
          borderRadius: '7px', padding: '4px 0',
          zIndex: '99999', boxShadow: '0 4px 20px rgba(0,0,0,.5)',
          minWidth: '180px', fontSize: '13px',
        });

        function addItem(icon, label, onClick) {
          const item = document.createElement('div');
          item.textContent = icon + ' ' + label;
          Object.assign(item.style, {
            padding: '7px 14px', cursor: 'pointer', whiteSpace: 'nowrap',
            borderRadius: '4px', margin: '1px 4px',
          });
          item.addEventListener('mouseenter', () => item.style.background = 'var(--hover, rgba(255,255,255,.08))');
          item.addEventListener('mouseleave', () => item.style.background = '');
          item.addEventListener('click', () => { menu.remove(); onClick(); });
          menu.appendChild(item);
        }

        // 菜单项：用 AI 编辑器打开。
        // 措辞刻意不用产品名 Principal —— 这里打开的是**外部**编辑器（Windsurf/Cursor/VS Code），
        // 叫「用 Principal 打开」会让人以为是本应用在开目录。后端路由仍叫 open-in-vibe，
        // 是历史标识符，改它要同时动路由表与前端，收益不抵风险。
        addItem('⚡', '用 AI 编辑器打开', async () => {
          try {
            const r = await fetch('/api/open-in-vibe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: dirPath }),
            });
            const d = await r.json();
            if (d.ok) {
              if (typeof toast === 'function') toast(`已在 ${d.editor} 中打开`);
            } else {
              if (typeof toast === 'function') toast(d.error || '打开失败');
            }
          } catch (e) {
            if (typeof toast === 'function') toast('打开失败：' + e.message);
          }
        });

        // 菜单项：在文件管理器中打开
        addItem('📂', '在文件管理器中打开', async () => {
          try {
            await fetch('/api/open-in-vibe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: dirPath, editor: process.platform === 'win32' ? 'explorer' : 'open' }),
            });
          } catch {}
        });

        document.body.appendChild(menu);

        // 点击菜单外部关闭
        const dismiss = (e) => {
          if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
        };
        setTimeout(() => document.addEventListener('mousedown', dismiss), 0);

        // 边界检测：避免超出视口
        requestAnimationFrame(() => {
          const rect = menu.getBoundingClientRect();
          if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
          if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
        });
      }

      function joinPath(base, name) {
        const sep = base.includes('\\') ? '\\' : '/';
        return base.replace(/[\\/]+$/, '') + sep + name;
      }

      $('#dirBtn').addEventListener('click', openDirModal);
      $('#dirClose').addEventListener('click', closeDirModal);
      $('#dirMask').addEventListener('click', (e) => {
        if (e.target === $('#dirMask')) closeDirModal();
      });
      $('#goBtn').addEventListener('click', () => browse($('#pathInput').value.trim()));
      $('#pathInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') browse($('#pathInput').value.trim());
      });
      $('#pickBtn').addEventListener('click', () => _selectDir(browsePath));
      /**
       * 系统文件夹选择框（调 /api/dirs/pick，弹在本机桌面）。
       *
       * 这个绑定原先写在 chat.js 里，直接调 chat 自己的 selectDir。但按钮是弹层的控件，
       * 绑定权归弹层——写在外面就绕过了 _selectDir 这个「当前宿主」指针：
       * 其它面板借用弹层（openDirPickerFor）时点它，改的是聊天工作目录、甚至开出新窗口，
       * 借用方的回调一次都没被调用，表现为「选完目录没回填、没生效」。
       * 而旁边的「选择此目录」走 _selectDir，所以只有这一个按钮坏，更难联想到病因。
       */
      $('#sysPickBtn').addEventListener('click', async () => {
        const btn = $('#sysPickBtn');
        const label = btn.textContent;
        btn.textContent = '选择中…';
        btn.disabled = true;
        try {
          const r = await (await fetch('/api/dirs/pick')).json();
          if (r.path) _selectDir(r.path); // 选中即应用并关闭
          else if (r.error) toastApi.error(r.error);
          // r.path=null：用户点了取消，忽略
        } catch {
          toastApi.error('调用系统对话框失败');
        } finally {
          // 放在 finally 而不是 _selectDir 之后：借用宿主的回调可能抛错，
          // 抛了也不能把按钮永久留在禁用态
          btn.textContent = label;
          btn.disabled = false;
        }
      });
      $('#starBtn').addEventListener('click', async () => {
        if (!browsePath) return;
        await fetch('/api/dirs/saved', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', path: browsePath }),
        });
        loadSaved();
      });

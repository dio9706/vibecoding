/** 富输入 composer：contenteditable 文字 + 内联附件（拖入上传副本，发送时序列化为路径）。
 *  自持 promptEl 引用（与 app.js 指向同一 DOM 节点，无状态分裂）。 */
const promptEl = document.querySelector('#prompt');

// 粘贴一律降为纯文本：外部复制的富文本（HTML/样式）直接落进 contenteditable 会把样式带进输入框。
// execCommand('insertText') 保留撤销栈与光标语义（deprecated 但各浏览器长期支持，无等价标准替代）。
promptEl?.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') || '';
  if (text) document.execCommand('insertText', false, text);
});

      // ---- 富输入：文字 + 内联附件（拖入上传副本，发送时序列化为路径）----
      export function getPromptText() {
        const out = [];
        (function walk(node) {
          node.childNodes.forEach((n) => {
            if (n.nodeType === 3) out.push(n.textContent);
            else if (n.nodeType === 1) {
              if (n.classList && n.classList.contains('att-chip')) {
                out.push(' ' + (n.dataset.path || '') + ' '); // 内联附件 → 绝对路径
              } else if (n.tagName === 'BR') {
                out.push('\n');
              } else {
                if (n.tagName === 'DIV' && out.length) out.push('\n'); // 块级边界换行
                walk(n);
              }
            }
          });
        })(promptEl);
        return out
          .join('')
          .replace(/ /g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }
      export function clearPrompt() {
        promptEl.querySelectorAll('.att-chip img').forEach((img) => {
          if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
        });
        promptEl.innerHTML = '';
      }
      // 抽成函数是因为图片加载失败时要拿它替换掉裂图（见 makeChip 的 onerror），两处必须一致
      function makeFileIcon() {
        const ic = document.createElement('span');
        ic.className = 'att-ic';
        ic.textContent = '📄';
        return ic;
      }
      function makeChip(att) {
        const chip = document.createElement('span');
        chip.className = 'att-chip';
        chip.contentEditable = 'false';
        chip.dataset.path = att.path;
        if (att.isImage && att.thumbUrl) {
          const img = document.createElement('img');
          img.src = att.thumbUrl;
          // asset 协议带 scope 白名单（tauri.conf.json 的 assetProtocol.scope），路径落在白名单外
          // 时请求被拒，<img> 不报错、只静默变成一张裂图——onerror 是唯一能感知到「这张图加载不
          // 出来」的信号（同 chat.js:makeImageElement 的处理）。
          // 只把预览换成 📄，dataset.path 与文件名原样保留：路径才是要交给 Claude 的东西，
          // 不能因为缩略图挂了就把附件丢了。
          img.onerror = () => img.replaceWith(makeFileIcon());
          chip.appendChild(img);
        } else {
          chip.appendChild(makeFileIcon());
        }
        const nm = document.createElement('span');
        nm.className = 'att-nm';
        nm.textContent = att.name;
        chip.appendChild(nm);
        const rm = document.createElement('span');
        rm.className = 'att-rm';
        rm.textContent = '×';
        rm.addEventListener('mousedown', (e) => {
          e.preventDefault(); // 阻止失焦，直接移除
          const img = chip.querySelector('img');
          if (img && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
          chip.remove();
        });
        chip.appendChild(rm);
        return chip;
      }
      // 在光标处插入节点（无光标则追加到末尾）
      function insertNodeAtCaret(node) {
        promptEl.focus();
        const sel = window.getSelection();
        let range;
        if (sel && sel.rangeCount && promptEl.contains(sel.anchorNode)) {
          range = sel.getRangeAt(0);
        } else {
          range = document.createRange();
          range.selectNodeContents(promptEl);
          range.collapse(false);
        }
        range.deleteContents();
        range.insertNode(node);
        const space = document.createTextNode(' '); // 尾随空格便于继续输入
        node.after(space);
        range.setStartAfter(space);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      async function uploadDropped(file) {
        const isImage = (file.type || '').startsWith('image/');
        const chip = makeChip({
          path: '',
          name: file.name,
          isImage,
          thumbUrl: isImage ? URL.createObjectURL(file) : '',
        });
        chip.classList.add('uploading');
        insertNodeAtCaret(chip);
        try {
          const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name), {
            method: 'POST',
            body: file,
          });
          const d = await r.json();
          if (!d.path) throw new Error(d.error || '上传失败');
          chip.dataset.path = d.path; // 发送时序列化为此绝对路径
          chip.classList.remove('uploading');
        } catch (err) {
          chip.remove();
          window.toast.error('文件上传失败：' + (err && err.message ? err.message : err));
        }
      }
      /** Web 模式的 HTML5 拖拽入口：浏览器拿不到本地绝对路径，只能读文件内容上传副本。
       *  Tauri 模式不会走到这里——原生拖拽已接管，走 drag-bus 总线拿真实路径（零副本）。 */
      export function handleDrop(e) {
        promptEl.classList.remove('dragover');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        e.preventDefault();
        // 把光标移到落点，附件插在拖放位置
        const r = document.caretRangeFromPoint
          ? document.caretRangeFromPoint(e.clientX, e.clientY)
          : null;
        if (r && promptEl.contains(r.startContainer)) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        }
        for (const f of files) uploadDropped(f);
      }

      /**
       * Tauri 模式：把一批拖入的真实路径转成 chip。
       *
       * 先批量 stat 拿真实类型——旧版用「最后一段不含 . 即目录」的启发式，
       * 会把 README / Dockerfile / LICENSE 判成文件夹。
       */
      export async function insertDroppedPaths(paths) {
        const kinds = new Map();
        try {
          const r = await fetch('/api/fs/stat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths }),
          });
          const d = await r.json();
          for (const it of d.results || []) kinds.set(it.path, it.kind);
        } catch {
          // stat 失败不阻断拖拽：降级到扩展名启发式，chip 照常插入。
          // 拖拽是高频操作，不能因为后端抖动就完全不响应
        }
        for (const p of paths) insertPathChip(p, kinds.get(p));
      }

      /**
       * 插入本地路径 chip（Tauri 模式专用：零副本，Claude 直接读原路径）。
       * @param {string} absPath
       * @param {'file'|'dir'|'missing'} [kind] 来自 /api/fs/stat；缺省时退回扩展名启发式
       */
      export function insertPathChip(absPath, kind) {
        const lastSeg = absPath.split(/[/\\]/).filter(Boolean).pop() || absPath;
        const isDir = kind ? kind === 'dir' : !lastSeg.includes('.');
        const isImage = !isDir && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(lastSeg);
        // 本地图片走 asset 协议预览：原生路径下没有 File 对象，createObjectURL 不再适用。
        // 依赖 Cargo 的 protocol-asset feature 与 tauri.conf.json 的 assetProtocol.scope
        const convert = window.__TAURI__?.core?.convertFileSrc;
        const thumbUrl = isImage && convert ? convert(absPath) : '';
        const chip = makeChip({ path: absPath, name: lastSeg, isImage: !!thumbUrl, thumbUrl });
        if (isDir) {
          const ic = chip.querySelector('.att-ic');
          if (ic) ic.textContent = '📁';
        }
        if (kind === 'missing') {
          chip.classList.add('att-missing'); // 路径已不存在，视觉提示而不是静默丢弃
          chip.title = '路径不存在：' + absPath;
        }
        insertNodeAtCaret(chip);
      }

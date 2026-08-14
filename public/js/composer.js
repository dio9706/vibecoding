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
      function makeChip(att) {
        const chip = document.createElement('span');
        chip.className = 'att-chip';
        chip.contentEditable = 'false';
        chip.dataset.path = att.path;
        if (att.isImage && att.thumbUrl) {
          const img = document.createElement('img');
          img.src = att.thumbUrl;
          chip.appendChild(img);
        } else {
          const ic = document.createElement('span');
          ic.className = 'att-ic';
          ic.textContent = '📄';
          chip.appendChild(ic);
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
      export function handleDrop(e) {
        // dragover 样式无论有无文件都清掉（Tauri 模式下 dataTransfer.files 为空但 DOM drop 仍触发）
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
       * 直接插入本地路径 chip（Tauri 模式专用：无需上传副本，Claude 可直接访问本地路径）。
       * 文件夹与无扩展名文件均显示 📁 图标；有扩展名的显示 📄。
       */
      export function insertPathChip(absPath) {
        // 取路径最后一段作为展示名（兼容 / 与 \ 分隔符）
        const lastSeg = absPath.split(/[/\\]/).filter(Boolean).pop() || absPath;
        // 启发式判断是否为目录：最后段不含 . 视为目录（可能误判无扩展名文件，但实用够用）
        const isDir = !lastSeg.includes('.');
        const chip = makeChip({ path: absPath, name: lastSeg, isImage: false, thumbUrl: '' });
        if (isDir) {
          const ic = chip.querySelector('.att-ic');
          if (ic) ic.textContent = '📁';
        }
        insertNodeAtCaret(chip);
      }

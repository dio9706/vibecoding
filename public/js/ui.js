/** 自封闭 UI 原语：toast（轻提示，代理到统一 toast 组件）与 confirmDialog（Promise 确认弹框）。 */
import toastApi from './toast.js';
      // ---- 通用确认弹框（替代 window.confirm，返回 Promise<boolean>）----
      export function confirmDialog({
        title = '确认',
        message = '',
        confirmText = '确认',
        cancelText = '取消',
        danger = false,
      } = {}) {
        return new Promise((resolve) => {
          const mask = document.createElement('div');
          mask.className = 'mask';
          mask.innerHTML =
            '<div class="modal confirm-modal">' +
            '<div class="head"><h3></h3></div>' +
            '<div class="body"><p class="confirm-msg"></p></div>' +
            '<div class="confirm-foot"><button class="btn cancel"></button><button class="btn ok"></button></div>' +
            '</div>';
          mask.querySelector('h3').textContent = title;
          mask.querySelector('.confirm-msg').textContent = message;
          const cancelBtn = mask.querySelector('.cancel');
          const okBtn = mask.querySelector('.ok');
          cancelBtn.textContent = cancelText;
          okBtn.textContent = confirmText;
          okBtn.classList.add(danger ? 'danger' : 'primary');
          const close = (val) => {
            mask.remove();
            document.removeEventListener('keydown', onKey);
            resolve(val);
          };
          const onKey = (e) => {
            if (e.key === 'Escape') close(false);
            else if (e.key === 'Enter') close(true);
          };
          cancelBtn.onclick = () => close(false);
          okBtn.onclick = () => close(true);
          mask.addEventListener('click', (e) => {
            if (e.target === mask) close(false);
          });
          document.addEventListener('keydown', onKey);
          document.body.appendChild(mask);
          okBtn.focus();
        });
      }

      // ---- 通用输入弹框（替代 window.prompt，返回 Promise<string|null>）----
      // 取消 / Esc / 点遮罩一律 resolve(null)，与原生 prompt 语义一致，
      // 故调用方的 `if (v == null) return` 判断无需改动。
      export function promptDialog({
        title = '输入',
        message = '',
        value = '',
        placeholder = '',
        confirmText = '确认',
        cancelText = '取消',
      } = {}) {
        return new Promise((resolve) => {
          const mask = document.createElement('div');
          mask.className = 'mask';
          mask.innerHTML =
            '<div class="modal confirm-modal">' +
            '<div class="head"><h3></h3></div>' +
            '<div class="body"><p class="confirm-msg"></p><input class="prompt-input" type="text"></div>' +
            '<div class="confirm-foot"><button class="btn cancel"></button><button class="btn ok primary"></button></div>' +
            '</div>';
          mask.querySelector('h3').textContent = title;
          const msgEl = mask.querySelector('.confirm-msg');
          if (message) msgEl.textContent = message;
          else msgEl.remove(); // 无说明文案时不留空行
          const input = mask.querySelector('.prompt-input');
          input.value = value;
          input.placeholder = placeholder;
          const cancelBtn = mask.querySelector('.cancel');
          const okBtn = mask.querySelector('.ok');
          cancelBtn.textContent = cancelText;
          okBtn.textContent = confirmText;
          const close = (val) => {
            mask.remove();
            document.removeEventListener('keydown', onKey);
            resolve(val);
          };
          const onKey = (e) => {
            if (e.key === 'Escape') close(null);
            else if (e.key === 'Enter') close(input.value);
          };
          cancelBtn.onclick = () => close(null);
          okBtn.onclick = () => close(input.value);
          mask.addEventListener('click', (e) => {
            if (e.target === mask) close(null);
          });
          document.addEventListener('keydown', onKey);
          document.body.appendChild(mask);
          input.focus();
          input.select(); // 预填值全选，便于直接覆盖输入
        });
      }

      // ---- 多行输入弹框（Promise 多行文本输入，返回 Promise<string|null>）----
      // 与 promptDialog 类似，支持 Ctrl/Cmd+Enter 提交、Esc 取消，打开时自动聚焦到 textarea。
      export function textareaDialog({
        title = '输入',
        message = '',
        value = '',
        placeholder = '',
        confirmText = '确认',
        cancelText = '取消',
      } = {}) {
        return new Promise((resolve) => {
          const mask = document.createElement('div');
          mask.className = 'mask';
          mask.innerHTML =
            '<div class="modal confirm-modal">' +
            '<div class="head"><h3></h3></div>' +
            '<div class="body"><p class="confirm-msg"></p><textarea class="prompt-input textarea-dialog"></textarea></div>' +
            '<div class="confirm-foot"><button class="btn cancel"></button><button class="btn ok primary"></button></div>' +
            '</div>';
          mask.querySelector('h3').textContent = title;
          const msgEl = mask.querySelector('.confirm-msg');
          if (message) msgEl.textContent = message;
          else msgEl.remove(); // 无说明文案时不留空行
          const textarea = mask.querySelector('textarea');
          textarea.value = value;
          textarea.placeholder = placeholder;
          const cancelBtn = mask.querySelector('.cancel');
          const okBtn = mask.querySelector('.ok');
          cancelBtn.textContent = cancelText;
          okBtn.textContent = confirmText;
          const close = (val) => {
            mask.remove();
            document.removeEventListener('keydown', onKey);
            resolve(val);
          };
          const onKey = (e) => {
            if (e.key === 'Escape') close(null);
            else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') close(textarea.value);
          };
          cancelBtn.onclick = () => close(null);
          okBtn.onclick = () => close(textarea.value);
          mask.addEventListener('click', (e) => {
            if (e.target === mask) close(null);
          });
          document.addEventListener('keydown', onKey);
          document.body.appendChild(mask);
          textarea.focus();
        });
      }

      // ---- 轻量提示（非阻塞 toast，替代原生 alert）----
      // 统一委托给 toast.js 单一实现：本文件曾有一套「直挂 body + .show 淡入」的旧 toast，
      // 与 toast.js 的新组件共用 .toast 类名，被新规则的 animation:forwards 终态压制后
      // 会错位、永不消失且拦截点击。此处保留 toast(msg) 签名以免改动 70+ 处调用点，
      // 内部改为 info 级（旧样式本就是无类型的中性提示，视觉等价）。
      // 需要区分类型时，直接用 window.toast.error / .success / .info。
      export function toast(msg) {
        toastApi.info(msg);
      }

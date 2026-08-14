// public/js/toast.js

let toastContainer = null;
const toastQueue = [];
const maxToasts = 3;

/**
 * 初始化 Toast 容器
 */
function _init() {
  if (toastContainer) return;
  toastContainer = document.createElement('div');
  toastContainer.id = 'toast-container';
  document.body.appendChild(toastContainer);
}

/**
 * 创建并显示一条 Toast
 * @param {string} message - 消息内容
 * @param {string} type - 类型：'error' | 'success' | 'info'
 * @param {number} duration - 显示时长（毫秒），默认 3000
 */
function _show(message, type = 'error', duration = 3000) {
  _init();

  const toastEl = document.createElement('div');
  toastEl.className = `toast toast--${type}`;

  const iconMap = {
    error: '✕',
    success: '✓',
    info: 'ℹ',
  };
  const icon = iconMap[type] || '•';

  toastEl.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-msg">${escapeHtml(message)}</span>
    <button class="toast-close" title="关闭" aria-label="关闭提示">✕</button>
  `;

  toastContainer.appendChild(toastEl);
  toastQueue.push(toastEl);

  // 保存需要清理的资源
  let timeoutId = null;
  const closeBtn = toastEl.querySelector('.toast-close');

  // 关闭按钮处理器（命名函数便于后续移除）
  const handleClose = () => {
    if (timeoutId) clearTimeout(timeoutId);
    _removeToast(toastEl);
  };
  closeBtn.addEventListener('click', handleClose);

  // 直接 setTimeout 触发自动消失，不依赖 animationend（更可靠）
  timeoutId = setTimeout(() => _removeToast(toastEl), duration);

  // 动画事件处理器：仅用于出场动画结束后清理 DOM
  const handleAnimationEnd = (e) => {
    if (e.animationName === 'slideOutToast') {
      // 出场完成，清理所有资源
      if (timeoutId) clearTimeout(timeoutId);
      closeBtn.removeEventListener('click', handleClose);
      toastEl.removeEventListener('animationend', handleAnimationEnd);
      toastEl.remove();
      const idx = toastQueue.indexOf(toastEl);
      if (idx > -1) toastQueue.splice(idx, 1);
    }
  };

  toastEl.addEventListener('animationend', handleAnimationEnd);

  // 超过最大数量时，删除最老的
  if (toastQueue.length > maxToasts) {
    const oldest = toastQueue.shift();
    _removeToast(oldest);
  }
}

/**
 * 移除一条 Toast（触发出场动画）
 */
function _removeToast(toastEl) {
  if (!toastEl.classList.contains('removing')) {
    toastEl.classList.add('removing');
  }
}

/**
 * 转义 HTML 特殊字符
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 导出 API
 */
export default {
  error(message, duration = 3000) {
    _show(message, 'error', duration);
  },
  success(message, duration = 3000) {
    _show(message, 'success', duration);
  },
  info(message, duration = 3000) {
    _show(message, 'info', duration);
  },
  _init,
};

/**
 * 弹窗关闭的通用绑定（零依赖叶子）：Esc + 点遮罩 + 解绑监听，三件事一次做完。
 *
 * 为什么单独一个文件而不放进 ui.js：ui.js 会 import toast.js，业务弹窗其实只需要这段
 * 十几行的关闭语义。保持零依赖，任何弹窗模块都能引，测试也不必把 toast 一起拖进 jsdom。
 *
 * 为什么不顺手把 ui.js 的 confirm/prompt/textarea 也改成用它：那三个的 keydown 还承担
 * **提交**语义（Enter / Ctrl+Enter），且各自的 Esc 要 resolve 不同的值（false / null）。
 * 把提交也塞进来，这个函数就得开始长参数了 —— 它们的 Esc 本来就是好的，不去动。
 *
 * @param {HTMLElement} mask 遮罩元素（弹窗根）
 * @param {Function} onClose 真正的关闭动作（移除 DOM、清定时器、resolve…）
 * @returns {Function} 包装后的 close：调用方点「关闭」按钮时用它，以确保监听同样被解绑
 */
export function bindDialogDismiss(mask, onClose) {
  let done = false;

  const close = () => {
    // 幂等：Esc 与点遮罩可能先后到达，onClose 里常有 clearInterval / resolve，重复执行会出问题
    if (done) return;
    done = true;
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };

  // keydown 只能挂 document（弹窗本身不可聚焦，挂它收不到键）。
  // 代价就是必须解绑：不解绑的话每开一次弹窗就在 document 上永久多留一个监听器，
  // 而它还闭包着已经卸载的 DOM —— 既是内存泄漏，也会让 Esc 触发早已关闭的弹窗的清理逻辑。
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  mask.addEventListener('click', (e) => {
    if (e.target === mask) close(); // 只认遮罩本体：点内容区不该关窗
  });
  document.addEventListener('keydown', onKey);

  return close;
}

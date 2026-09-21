/**
 * 需求功能右侧抽屉 —— 需求变动 / 开发人员 / UI 规范 三个入口的统一容器。
 *
 * 为什么从居中弹框改成抽屉：这三件事都是「对着聊天记录做」的 —— 需求变动要照着刚才
 * 的对话写，UI 规范要比对 AI 刚生成的代码。居中弹框把聊天区整个盖住又压暗，用户只能
 * 关掉看一眼再重开。抽屉贴着需求管理右栏的左边缘展开，右栏按钮与聊天区都还在，
 * 也因此**不要遮罩**：有遮罩就等于又把聊天区锁上了，抽屉的意义就没了。
 *
 * 复用 .modal 的基础外观（背景 / 边框 / head / body / confirm-foot 排版），只覆盖定位与
 * 尺寸：那套样式全站几十个弹框在用，与其新造一份骨架，不如继承它再改四个属性。
 *
 * 停靠随布局走：开发期有需求管理右栏（.req-rail，300px）时贴它左边缘；评审期走
 * panel-view、右栏不显示（app.css 的 `.app.in-panel .req-rail`），贴窗口右边缘。
 */

/**
 * 当前开着的抽屉的 close —— 抽屉是**单例**。
 *
 * 居中弹框时代不需要这个：遮罩把右栏一起盖住了，开着弹框根本点不到第二个入口。
 * 抽屉去掉遮罩后右栏按钮全程可点，不关旧的就会叠出两层、彼此错位。
 */
let currentClose = null;

/** 右栏此刻是否真占着那 300px —— 决定抽屉贴谁的边。 */
function railVisible() {
  const app = document.querySelector('.app');
  return !!app && app.classList.contains('req-rail-open') && !app.classList.contains('in-panel');
}

/**
 * @param {object} opts
 * @param {string} opts.title 标题文本
 * @param {string} [opts.icon] 标题图标（iconHtml 产出的 svg 串，调用方写死的常量）
 * @param {string} [opts.cls] 追加到根节点的类名，供各抽屉写自己的内容样式
 * @param {string} [opts.bodyHtml] 内容区模板
 * @param {string} [opts.footHtml] 底部按钮区模板；按钮固定在底部，不随内容滚动
 * @param {Function} [opts.canClose] 返回 false 时 Esc / 点外部都不关（如提交中）
 * @param {Function} [opts.onClose] 关闭时的清理（清定时器 / 作废在途请求）。**必须走这里**：
 *   Esc 与点外部的关闭发生在本模块内部，调用方自己包一层 close 是拦不到的。
 * @returns {{root: HTMLElement, close: Function}}
 */
export function openReqDrawer({
  title, icon = '', cls = '', bodyHtml = '', footHtml = '', canClose = () => true, onClose,
}) {
  currentClose?.(); // 先收掉上一个，连同它的清理（见 currentClose 注释）

  const root = document.createElement('div');
  root.className = 'modal rq-drawer' + (railVisible() ? ' with-rail' : '') + (cls ? ' ' + cls : '');
  root.innerHTML =
    '<div class="head"><h3></h3></div>' +
    '<div class="body">' + bodyHtml + '</div>' +
    '<div class="confirm-foot">' + footHtml + '</div>';
  // 标题走 textContent：icon 是常量 svg，title 将来可能带上需求名等外部文本
  const h3 = root.querySelector('h3');
  h3.innerHTML = icon;
  h3.append(document.createTextNode(icon ? ' ' + title : title));
  document.body.appendChild(root);

  let closed = false;
  const close = () => {
    if (closed) return; // 幂等：Esc 与点外部可能先后到达，调用方的清理不该跑两遍
    closed = true;
    if (currentClose === close) currentClose = null; // 只让出自己那一格，别把后来者的注销掉
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onOutside);
    root.remove();
    onClose?.();
  };
  currentClose = close;
  const onKey = (e) => {
    if (e.key === 'Escape' && canClose()) close();
  };
  const onOutside = (e) => {
    if (root.contains(e.target)) return;
    // 抽屉之上仍可能压着 confirm / prompt 弹框（挂在 body 的 .mask 上）——
    // 点那些不该把底下的抽屉一起带走
    if (e.target?.closest?.('.mask')) return;
    if (canClose()) close();
  };
  document.addEventListener('keydown', onKey);
  // 延一轮再挂：打开抽屉的那一次点击此刻还在冒泡，立即挂会被它自己当成「点了外部」，
  // 表现为抽屉一闪就没
  setTimeout(() => {
    if (!closed) document.addEventListener('mousedown', onOutside);
  }, 0);

  return { root, close };
}

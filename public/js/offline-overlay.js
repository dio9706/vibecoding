/**
 * 后端掉线罩：纯展示层，不含任何探测逻辑（判定在 net-guard.js）。
 *
 * 为什么懒创建而不像启动罩那样写静态 HTML：index.html 里启动罩必须第一帧就在 DOM 里
 * （注释「无二次挂载抖动」），但那个理由只针对首帧。掉线是运行时事件，触发时 JS 早已
 * 就绪，没有抖动代价，省一段常驻的无用 DOM。
 *
 * 为什么不复用 #bootOverlay：它已承载启动等待 + 经 setOverlayHandoff 移交的新用户引导
 * 两种状态，再塞第三种就是一个 DOM 三套状态机；且掉线罩需要盖在引导面板之上，
 * 同一节点做不到。
 *
 * 本模块与启动罩之间**没有任何 DOM 依赖**：LOGO 各存各的（见 STAR_HTML 注释），
 * 所以 boot-gate 撤罩时可以自由 remove。这是刻意保持的边界。
 */
import { bindWindowControls } from './tauri-init.js';

let el = null;

/** 罩内标题栏：窗口无边框（main.rs 的 decorations(false)），inset:0 的罩子盖住
 *  header.topbar 之后窗口就拖不动也关不掉，只剩托盘和 Alt+F4。与 index.html 里
 *  启动罩那份保持同构（按类不按 id，两处共用 bindWindowControls）。 */
const TITLEBAR_HTML = `
  <div class="ob-titlebar" data-tauri-drag-region>
    <div class="ob-titlebar-drag" data-tauri-drag-region></div>
    <div class="win-controls" hidden>
      <button class="wc-btn wc-min" title="最小化">
        <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
      </button>
      <button class="wc-btn wc-max" title="最大化/还原">
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><rect x="0.5" y="0.5" width="8" height="8" stroke="currentColor"/></svg>
      </button>
      <button class="wc-btn wc-close" title="关闭到托盘">
        <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
    </div>
  </div>`;

/** 六芒星 LOGO。与 index.html 里启动罩那份是同款几何，但**各存各的**：
 *  曾经改成从 #bootStar 克隆以求「不存第二份素材」，代价是 boot-gate 不能 remove 自己的罩子
 *  （跨模块 DOM 契约）+ 一条漏掉就开机黑屏的 CSS + 静默降级分支，而 app.css 里那 8 行动画
 *  规则该复制还是得复制 —— 省下的只有这 6 行 polygon，不划算，已回退。
 *  id 用 offlineStar/obtri1/obtri2 与启动罩区分：动画规则按 id 限定作用域。 */
const STAR_HTML = `
  <svg class="boot-star" id="offlineStar" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g id="obtri1">
      <polygon points="100,25 165,140 35,140" stroke="#d97757" stroke-width="1.5"/>
    </g>
    <g id="obtri2">
      <polygon points="100,175 165,60 35,60" stroke="#e88f6f" stroke-width="1.5" fill="rgba(217,119,87,0.14)"/>
    </g>
  </svg>`;

function create() {
  const box = document.createElement('div');
  box.id = 'offlineOverlay';
  // 复用 .boot-overlay 的布局/背景/淡入；.offline-overlay 只覆盖 z-index
  box.className = 'boot-overlay offline-overlay';
  // .boot-overlay 是 column flex，这里的书写顺序即视觉顺序
  box.innerHTML = `${TITLEBAR_HTML}${STAR_HTML}
    <div class="vibe-title">PRINCIPAL</div>
    <div class="boot-text">服务器后台异常</div>
    <div class="boot-text off-sub">正在尝试重新连接…</div>
    <button class="boot-skip" id="offlineReload" type="button">重新加载</button>`;

  box.querySelector('#offlineReload').addEventListener('click', () => {
    window.location.reload();
  });

  document.body.appendChild(box);
  // 必须补绑：tauri-init 的绑定是一次性 querySelectorAll，此时早已跑完
  bindWindowControls(box);
  return box;
}

/** 升起掉线罩（幂等，首次调用懒创建）。 */
export function showOfflineOverlay() {
  if (!el || !el.isConnected) el = create();
  el.hidden = false;
}

/** 撤下掉线罩（幂等）。保留节点供下次复用——掉线可能反复发生，不必反复建 DOM。 */
export function hideOfflineOverlay() {
  if (el) el.hidden = true;
}

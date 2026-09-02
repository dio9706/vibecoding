/**
 * 吉祥物组件：描边圆环 + 两颗光点眼。零第三方依赖，纯 SVG + CSS 动画。
 *
 * 设计取舍：
 * - 状态是**单一轴**（不是"状态 × 表情"两维）。吉祥物在视觉上不可能既点头庆祝又抖动报错，
 *   两维模型只会带来无意义的组合爆炸和一堆非法态。
 * - 视觉全在 css/mascot.css，这里只负责建 DOM、切类名、管生命周期。
 *   想改动画不用碰 JS；想接新宿主不用碰 CSS。
 * - 几何常数导出给 mascot-particles.js 采样，避免两处各写一份坐标然后慢慢漂移。
 */

/** 几何常数（viewBox 200×200 坐标系）。粒子动画按同一套坐标采样 */
export const MASCOT_GEOMETRY = {
  viewBox: 200,
  cx: 100,
  cy: 100,
  r: 63,
  strokeWidth: 7,
  eyes: [
    { cx: 79, cy: 96, rx: 9, ry: 11 },
    { cx: 121, cy: 96, rx: 9, ry: 11 },
  ],
};

/**
 * 全部合法状态。value 用于 aria-label —— 吉祥物承载真实状态信息，
 * 读屏用户不能只听到"图片"。
 */
export const MASCOT_STATES = {
  idle: '待命中',
  loading: '正在执行',
  waiting: '等待你的确认',
  done: '已完成',
  error: '出现异常',
  happy: '开心',
  sad: '难过',
  wink: '眨眼',
  surprised: '惊讶',
  sleep: '休眠中',
};

const DEFAULT_STATE = 'idle';

const SVG_MARKUP = `
<svg class="pm-svg" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle class="pm-track" cx="100" cy="100" r="63" pathLength="100"/>
  <circle class="pm-ring" cx="100" cy="100" r="63" pathLength="100"/>
  <g class="pm-face">
    <ellipse class="pm-eye" cx="79" cy="96" rx="9" ry="11"/>
    <ellipse class="pm-eye" cx="121" cy="96" rx="9" ry="11"/>
    <path class="pm-arc" d="M69 100 Q79 87 89 100"/>
    <path class="pm-arc" d="M111 100 Q121 87 131 100"/>
  </g>
</svg>`;

/**
 * 创建一个吉祥物实例。
 *
 * @param {object} opts
 * @param {Element} opts.mount   挂载容器（必填）
 * @param {number} [opts.size]   像素边长，默认 120
 * @param {string} [opts.state]  初始状态，默认 idle
 * @returns {{el: Element, setState: Function, getState: Function, flash: Function, setSize: Function, destroy: Function}}
 */
export function createMascot(opts = {}) {
  const { mount, size = 120, state = DEFAULT_STATE } = opts;
  if (!mount) throw new Error('createMascot: 缺少 mount 容器');

  const el = document.createElement('div');
  el.className = 'pm';
  el.setAttribute('role', 'img');
  el.innerHTML = SVG_MARKUP;

  let current = null; // 当前呈现的状态（可能是 flash 的临时态）
  let base = null; // 临时态结束后要回落到的常驻状态
  let flashTimer = null;
  let destroyed = false;

  function setSize(px) {
    el.style.setProperty('--pm-size', `${px}px`);
  }

  function applyClass(next) {
    const name = MASCOT_STATES[next] ? next : DEFAULT_STATE;
    if (current) el.classList.remove(`pm-is-${current}`);
    el.classList.add(`pm-is-${name}`);
    el.setAttribute('aria-label', MASCOT_STATES[name]);
    current = name;
    return name;
  }

  /** 设置常驻状态。会取消进行中的 flash —— 新的常驻状态优先级高于旧的临时反馈 */
  function setState(next) {
    if (destroyed) return current;
    clearTimeout(flashTimer);
    flashTimer = null;
    base = applyClass(next);
    return current;
  }

  /**
   * 临时切到某状态，到点回落到常驻状态。用于「完成」「惊讶」这类瞬时反馈。
   * 回落目标取 base 而非 current，故连续 flash 不会把临时态误当成落点。
   */
  function flash(next, ms = 1800) {
    if (destroyed) return current;
    clearTimeout(flashTimer);
    applyClass(next);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      applyClass(base);
    }, ms);
    return current;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(flashTimer);
    flashTimer = null;
    el.remove();
  }

  setSize(size);
  setState(state);
  mount.appendChild(el);

  return { el, setState, getState: () => current, flash, setSize, destroy };
}

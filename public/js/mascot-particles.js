/**
 * 吉祥物开机粒子动画：粒子螺旋汇聚成形 → 冲击波扩散 → 交叉淡出露出真正的 SVG。
 *
 * 关键做法：
 * - 汇聚走**极坐标插值**（半径和角度分别插值）而不是直线 lerp。直线会让所有粒子
 *   像被吸尘器吸进去，极坐标插值自带旋进感，这是"炫酷"和"廉价"的分界线。
 * - 目标点直接从 MASCOT_GEOMETRY 采样，不另抄一份坐标，改半径时两边不会漂移。
 * - 画布只在动画期间存在，结束即移除；不留常驻 rAF。
 */

import { MASCOT_GEOMETRY as G } from './mascot.js';

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const lerp = (a, b, t) => a + (b - a) * t;

/** 椭圆内均匀取点：sqrt 是为了抵消极坐标采样向圆心堆积的倾向 */
function pointInEllipse(e) {
  const rr = Math.sqrt(Math.random());
  const a = Math.random() * Math.PI * 2;
  return { x: e.cx + e.rx * rr * Math.cos(a), y: e.cy + e.ry * rr * Math.sin(a) };
}

/** 采样吉祥物轮廓：约 78% 铺在环上，其余填进两只眼睛 */
function sampleTargets(count) {
  const out = [];
  const ringN = Math.round(count * 0.78);
  for (let i = 0; i < ringN; i++) {
    // 角度上加半格抖动，避免粒子排成肉眼可见的等分栅格
    const a = ((i + Math.random() * 0.5) / ringN) * Math.PI * 2;
    out.push({ x: G.cx + G.r * Math.cos(a), y: G.cy + G.r * Math.sin(a), onRing: true });
  }
  for (let i = ringN; i < count; i++) {
    const eye = G.eyes[i % G.eyes.length];
    out.push({ ...pointInEllipse(eye), onRing: false });
  }
  return out;
}

/**
 * 播放开机动画。
 *
 * @param {object} mascot            createMascot() 的返回值
 * @param {object} [opts]
 * @param {number} [opts.duration]   总时长 ms，默认 1900
 * @param {number} [opts.count]      粒子数，默认 170
 * @param {string} [opts.color]      粒子颜色，默认取 accent
 * @param {Function} [opts.onDone]   动画结束回调
 * @returns {{cancel: Function}}
 *
 * 注意：会给 mascot.el 的父节点加 .pm-boot（提供定位上下文），画布叠在其上。
 */
export function playMascotBoot(mascot, opts = {}) {
  const {
    duration = 1900,
    count = 170,
    color = '#d97757',
    onDone = () => {},
  } = opts;

  const target = mascot.el;
  const host = target.parentElement;
  if (!host) throw new Error('playMascotBoot: 吉祥物尚未挂载到 DOM');

  const size = target.getBoundingClientRect().width || 160;

  // 自建包裹层而不是给调用方容器加类：给宿主加 position/display 会掀翻它原有的
  // 布局（例如 flex 居中会失效，画布随即贴到容器左上角）。包裹层尺寸恰好等于
  // 吉祥物，inset:0 的画布才会严丝合缝地盖在它上面。
  const wrap = document.createElement('div');
  wrap.className = 'pm-boot';
  host.insertBefore(wrap, target);
  wrap.appendChild(target);

  target.classList.add('pm-boot-target');
  target.classList.remove('pm-boot-revealed'); // 支持在同一实例上重播

  const reveal = () => target.classList.add('pm-boot-revealed');

  // 用户要求减少动效：直接给结果，不放任何过场
  /** 把吉祥物送回原位并拆掉包裹层，使 DOM 结构复原到调用前 */
  function unwrap() {
    if (!wrap.parentElement) return;
    wrap.parentElement.insertBefore(target, wrap);
    wrap.remove();
  }

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    reveal();
    unwrap();
    onDone();
    return { cancel() {} };
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'pm-boot-canvas';
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  wrap.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const k = size / G.viewBox; // viewBox 坐标 → 像素
  const cx = G.cx * k;
  const cy = G.cy * k;

  const particles = sampleTargets(count).map((t) => {
    const tx = t.x * k;
    const ty = t.y * k;
    const dx = tx - cx;
    const dy = ty - cy;
    const tr = Math.hypot(dx, dy);
    const ta = Math.atan2(dy, dx);
    return {
      tr,
      ta,
      // 起始位置：更远的半径 + 随机旋角，插值时自然走出螺旋轨迹
      r0: tr * (1.7 + Math.random() * 1.5) + size * 0.18,
      a0: ta + (Math.random() * 2 - 1) * 1.9,
      delay: Math.random() * 0.38,
      dot: t.onRing ? 1.5 + Math.random() * 0.9 : 1.1 + Math.random() * 0.7,
      px: 0,
      py: 0,
      seeded: false,
    };
  });

  const FORM_AT = 0.72; // 成形时刻：此后开始交叉淡出并放冲击波
  let raf = 0;
  let start = 0;
  let done = false;

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    canvas.remove();
    unwrap();
    onDone();
  }

  function frame(now) {
    if (!start) start = now;
    const t = Math.min(1, (now - start) / duration);

    ctx.clearRect(0, 0, size, size);

    // 成形后画布整体退场，同时 SVG 淡入，两者交叉
    const fade = t <= FORM_AT ? 1 : Math.max(0, 1 - (t - FORM_AT) / (1 - FORM_AT));
    if (t >= FORM_AT) reveal();

    ctx.lineCap = 'round';
    for (const p of particles) {
      const local = Math.min(1, Math.max(0, (t - p.delay) / (1 - p.delay)));
      const e = easeOutCubic(local);
      const r = lerp(p.r0, p.tr, e);
      const a = lerp(p.a0, p.ta, e);
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);

      if (!p.seeded) {
        p.px = x;
        p.py = y;
        p.seeded = true;
      }

      // 拖尾亮度跟着速度走：飞得快时拉出长亮线，落位后自然收敛成一个点
      const speed = Math.hypot(x - p.px, y - p.py);
      const alpha = fade * Math.min(1, local * 3) * (0.35 + Math.min(0.65, speed / 14));

      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = p.dot;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(x, y);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, p.dot * 0.62, 0, Math.PI * 2);
      ctx.fill();

      p.px = x;
      p.py = y;
    }

    // 成形瞬间的冲击波：一圈向外扩散并迅速淡掉
    if (t > FORM_AT) {
      const w = (t - FORM_AT) / (1 - FORM_AT);
      ctx.globalAlpha = (1 - w) * 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, G.r * k * (1 + w * 0.55), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;

    if (t >= 1) return finish();
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);

  return {
    cancel() {
      reveal(); // 取消不等于隐藏结果，仍要把吉祥物留在屏幕上
      finish();
    },
  };
}

/**
 * 鸟瞰图（Minimap）坐标换算 —— 纯函数，零 DOM（单测目标）。
 *
 * 主画布是 `transform-origin: 0 0` + `translate(panX,panY) scale(zoom)`，所以可视区左上角
 * 对应的**内容坐标**是 `-panX / zoom`（注意负号）。这段数学原先埋在 DOM 操作里，符号写反了
 * 也测不出来，用户拖视口框方向是反的 —— 抽出来就是为了让 viewportBox / panFromViewport
 * 的互逆关系能被断言。
 *
 * 有意不做边界钳制：`.rq-minimap` 本身 overflow:hidden，让框自然截断，比钳出一个和
 * panFromViewport 不互逆的值更诚实（钳过的值反推回去会让拖拽在贴边时跳一下）。
 */

export const MM_W = 200; // 与 CSS .rq-minimap 的 width 保持一致
export const MM_H = 150; // 与 CSS .rq-minimap 的 height 保持一致

/** 缩略比：整张地图塞进鸟瞰框，取两轴中更紧的那个。内容尺寸非法时退化为 1，避免除零。 */
export function minimapScale({ contentW, contentH, mmW = MM_W, mmH = MM_H }) {
  if (!(contentW > 0) || !(contentH > 0)) return 1;
  return Math.min(mmW / contentW, mmH / contentH);
}

/** 主画布视口 → 鸟瞰图坐标系里的框。 */
export function viewportBox({ panX, panY, zoom, hostW, hostH, contentW, contentH, mmW = MM_W, mmH = MM_H }) {
  const scale = minimapScale({ contentW, contentH, mmW, mmH });
  const z = zoom > 0 ? zoom : 1;
  return {
    scale,
    x: (-panX / z) * scale,
    y: (-panY / z) * scale,
    w: (hostW / z) * scale,
    h: (hostH / z) * scale,
  };
}

/** 鸟瞰图里的框位置 → 主画布 pan。viewportBox 的逆运算，两者必须严格互逆。 */
export function panFromViewport({ vx, vy, zoom, scale }) {
  const z = zoom > 0 ? zoom : 1;
  const s = scale > 0 ? scale : 1;
  return { panX: (-vx / s) * z, panY: (-vy / s) * z };
}

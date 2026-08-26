import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimapScale, viewportBox, panFromViewport, MM_W, MM_H } from './req-map-minimap.logic.js';

const CONTENT = { contentW: 2000, contentH: 1200 };

test('minimapScale 取两轴中更紧的那个', () => {
  assert.equal(minimapScale({ contentW: 2000, contentH: 1200 }), Math.min(MM_W / 2000, MM_H / 1200));
});

test('minimapScale 内容尺寸非法时退化为 1，不除零', () => {
  assert.equal(minimapScale({ contentW: 0, contentH: 0 }), 1);
});

test('viewportBox 与 panFromViewport 严格互逆', () => {
  const args = { panX: -320, panY: -180, zoom: 1.4, hostW: 900, hostH: 600, ...CONTENT };
  const box = viewportBox(args);
  const back = panFromViewport({ vx: box.x, vy: box.y, zoom: args.zoom, scale: box.scale });
  assert.ok(Math.abs(back.panX - args.panX) < 1e-9, 'panX 不互逆：' + back.panX);
  assert.ok(Math.abs(back.panY - args.panY) < 1e-9, 'panY 不互逆：' + back.panY);
});

test('panX 增大（画布右移）时视口框向左走 —— 方向不能反', () => {
  // 这就是用户报的「向右拖视口框，界面反而向左滚」的回归护栏
  const base = { panY: 0, zoom: 1, hostW: 900, hostH: 600, ...CONTENT };
  assert.ok(viewportBox({ ...base, panX: 200 }).x < viewportBox({ ...base, panX: 0 }).x);
});

test('放大时框变小，位置也按 zoom 同步折算', () => {
  const base = { panX: -400, panY: -200, hostW: 900, hostH: 600, ...CONTENT };
  const z1 = viewportBox({ ...base, zoom: 1 });
  const z2 = viewportBox({ ...base, zoom: 2 });
  assert.ok(z2.w < z1.w && z2.h < z1.h);
  assert.ok(Math.abs(z2.x - z1.x / 2) < 1e-9, '位置漏乘 zoom：' + z2.x);
});

test('zoom 为 0 或负数时退化为 1，不产出 Infinity', () => {
  const b = viewportBox({ panX: 0, panY: 0, zoom: 0, hostW: 900, hostH: 600, ...CONTENT });
  assert.ok(Number.isFinite(b.w) && Number.isFinite(b.h));
});

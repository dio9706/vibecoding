import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutMap } from './req-map-layout.logic.js';

const pg = (id, points = 0) => ({ id, name: id, points: Array.from({ length: points }, (_, i) => ({ id: id + i })) });

test('无边时所有页面排在第 0 层，横向等距', () => {
  const r = layoutMap({ pages: [pg('a'), pg('b'), pg('c')], edges: [] });
  const ys = ['a', 'b', 'c'].map((id) => r.positions[id].y);
  assert.equal(new Set(ys).size, 1);
  const xs = ['a', 'b', 'c'].map((id) => r.positions[id].x);
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2]);
});

test('链式 a→b→c 分三层，y 逐层递增', () => {
  const r = layoutMap({ pages: [pg('a'), pg('b'), pg('c')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
  assert.ok(r.positions.a.y < r.positions.b.y);
  assert.ok(r.positions.b.y < r.positions.c.y);
});

test('多根汇聚 a→c、b→c：a/b 同层，c 下一层', () => {
  const r = layoutMap({ pages: [pg('a'), pg('b'), pg('c')], edges: [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }] });
  assert.equal(r.positions.a.y, r.positions.b.y);
  assert.ok(r.positions.c.y > r.positions.a.y);
});

test('长边跨层时子节点落在最深的父节点之下', () => {
  // a→b→c 且 a→c：c 必须在 b 之下，否则连线会往回穿
  const r = layoutMap({
    pages: [pg('a'), pg('b'), pg('c')],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }],
  });
  assert.ok(r.positions.c.y > r.positions.b.y);
});

test('成环时不死循环且每个节点都有坐标', () => {
  const r = layoutMap({ pages: [pg('a'), pg('b')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
  assert.ok(Number.isFinite(r.positions.a.x));
  assert.ok(Number.isFinite(r.positions.b.y));
});

test('环外挂着的链也能排下去', () => {
  const r = layoutMap({
    pages: [pg('a'), pg('b'), pg('c')],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'b', to: 'c' }],
  });
  assert.equal(Object.keys(r.positions).length, 3);
});

test('孤立节点与链共存时孤立节点也在第 0 层', () => {
  const r = layoutMap({ pages: [pg('a'), pg('b'), pg('solo')], edges: [{ from: 'a', to: 'b' }] });
  assert.equal(r.positions.solo.y, r.positions.a.y);
});

test('节点高度随逻辑点数增长，并影响下一层的 y', () => {
  const few = layoutMap({ pages: [pg('a', 1), pg('b')], edges: [{ from: 'a', to: 'b' }] });
  const many = layoutMap({ pages: [pg('a', 6), pg('b')], edges: [{ from: 'a', to: 'b' }] });
  assert.ok(many.positions.a.h > few.positions.a.h);
  assert.ok(many.positions.b.y > few.positions.b.y);
});

test('画布尺寸能包住所有节点', () => {
  const r = layoutMap({ pages: [pg('a', 3), pg('b'), pg('c')], edges: [{ from: 'a', to: 'b' }] });
  for (const id of ['a', 'b', 'c']) {
    assert.ok(r.positions[id].x + r.nodeW <= r.size.w);
    assert.ok(r.positions[id].y + r.positions[id].h <= r.size.h);
  }
});

test('空地图返回空布局而不抛', () => {
  const r = layoutMap({ pages: [], edges: [] });
  assert.deepEqual(r.positions, {});
  assert.ok(r.size.w > 0 && r.size.h > 0);
});

test('入参缺失时兜底为空布局', () => {
  assert.deepEqual(layoutMap(null).positions, {});
  assert.deepEqual(layoutMap({}).positions, {});
});

test('layoutMap 外露 entries（入度 0 的页面）与 layerOf', () => {
  const r = layoutMap({
    pages: [pg('a'), pg('b'), pg('c')],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  });
  assert.deepEqual(r.entries, ['a']);
  assert.equal(r.layerOf.get('a'), 0);
  assert.equal(r.layerOf.get('b'), 1);
  assert.equal(r.layerOf.get('c'), 2);
});

test('layoutMap 全图成环时 entries 为空，但仍然出得来坐标', () => {
  const r = layoutMap({ pages: [pg('a'), pg('b')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
  assert.deepEqual(r.entries, []);
  assert.ok(r.positions.a && r.positions.b);
});

test('单父多子时父节点水平居中于子节点组', () => {
  const r = layoutMap({
    pages: [pg('hub'), pg('a'), pg('b'), pg('c')],
    edges: [{ from: 'hub', to: 'a' }, { from: 'hub', to: 'b' }, { from: 'hub', to: 'c' }],
  });
  const cx = (id) => r.positions[id].x + r.nodeW / 2;
  assert.equal(cx('hub'), (cx('a') + cx('c')) / 2);
  assert.equal(cx('hub'), cx('b')); // 三个等距子节点，正中那个就是中心
});

test('居中后同层不重叠，且保持 pages 的原始左右顺序', () => {
  // h1 的子节点在右、h2 的子节点在左：居中会想把 h2 拉到 h1 左边，保序推挤必须拦住
  const r = layoutMap({
    pages: [pg('h1'), pg('h2'), pg('x'), pg('y')],
    edges: [{ from: 'h1', to: 'y' }, { from: 'h2', to: 'x' }],
  });
  assert.ok(r.positions.h2.x - r.positions.h1.x >= r.nodeW);
});

test('居中后画布宽度仍然包住所有节点', () => {
  const r = layoutMap({
    pages: [pg('hub'), pg('a'), pg('b'), pg('c')],
    edges: [{ from: 'hub', to: 'a' }, { from: 'hub', to: 'b' }, { from: 'hub', to: 'c' }],
  });
  for (const id of ['hub', 'a', 'b', 'c']) {
    assert.ok(r.positions[id].x + r.nodeW <= r.size.w, id + ' 超出画布宽度');
  }
});

test('同层边与回边不参与居中计算', () => {
  // b→a 是回边（a 在更浅层），不能把 b 往 a 身上拽
  const r = layoutMap({
    pages: [pg('a'), pg('b'), pg('c')],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'b', to: 'a' }],
  });
  const cx = (id) => r.positions[id].x + r.nodeW / 2;
  assert.equal(cx('b'), cx('c')); // b 只有 c 一个更深层子节点
});

test('同层内保持 pages 原始顺序', () => {
  const r = layoutMap({ pages: [pg('z'), pg('y'), pg('x')], edges: [] });
  assert.ok(r.positions.z.x < r.positions.y.x);
  assert.ok(r.positions.y.x < r.positions.x.x);
});

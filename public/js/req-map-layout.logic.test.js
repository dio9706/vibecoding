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

test('同层内保持 pages 原始顺序', () => {
  const r = layoutMap({ pages: [pg('z'), pg('y'), pg('x')], edges: [] });
  assert.ok(r.positions.z.x < r.positions.y.x);
  assert.ok(r.positions.y.x < r.positions.x.x);
});

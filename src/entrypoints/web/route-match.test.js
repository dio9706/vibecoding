import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRouteFrom, findShadowedRoutes } from './route-match.js';

/**
 * 分发层的契约测试。
 *
 * 为什么单独测这一层：各 routes-*.test.js 都是**直接调 handler**，
 * 完全绕过了路由分发。分发一旦错，症状是端点静默 404 或被错误的 handler 接走，
 * 而所有既有测试仍然全绿。
 */

const h = () => 'ok';

// ── 基本匹配 ──────────────────────────────────────────────────

test('精确匹配命中，返回条目与下标', () => {
  const routes = [{ path: '/a', h }, { path: '/b', h }];
  const m = matchRouteFrom(routes, 'GET', '/b');
  assert.equal(m.index, 1);
  assert.equal(m.route.path, '/b');
});

test('精确匹配不做前缀语义（/a 不该命中 /ab）', () => {
  const routes = [{ path: '/a', h }];
  assert.equal(matchRouteFrom(routes, 'GET', '/ab'), null);
});

test('前缀匹配命中子路径', () => {
  const routes = [{ prefix: '/api/req/', h }];
  assert.equal(matchRouteFrom(routes, 'GET', '/api/req/list').index, 0);
});

test('无命中返回 null（调用方据此走静态兜底）', () => {
  assert.equal(matchRouteFrom([{ path: '/a', h }], 'GET', '/zzz'), null);
});

test('空表返回 null', () => {
  assert.equal(matchRouteFrom([], 'GET', '/a'), null);
});

// ── 顺序敏感（契约 1）────────────────────────────────────────

test('精确排在前缀之前时，精确胜出', () => {
  const routes = [
    { path: '/api/history', h },
    { prefix: '/api/history/', h },
  ];
  assert.equal(matchRouteFrom(routes, 'GET', '/api/history').index, 0);
  assert.equal(matchRouteFrom(routes, 'GET', '/api/history/42').index, 1, '子路径仍走前缀');
});

test('顺序颠倒会让精确路由永不命中 —— 这正是 findShadowedRoutes 要拦的', () => {
  const routes = [
    { prefix: '/api/x/', h },
    { path: '/api/x/exact', h },
  ];
  assert.equal(matchRouteFrom(routes, 'GET', '/api/x/exact').index, 0, '被前缀抢走');
});

// ── 方法约束（契约 2）────────────────────────────────────────

test('method 不符则跳过，继续往后找', () => {
  const routes = [
    { path: '/api/bots', method: 'GET', h },
    { path: '/api/bots', method: 'POST', h },
  ];
  assert.equal(matchRouteFrom(routes, 'POST', '/api/bots').index, 1);
});

test('缺省 method 表示不限方法', () => {
  const routes = [{ path: '/api/settings', h }];
  assert.equal(matchRouteFrom(routes, 'DELETE', '/api/settings').index, 0);
});

test('同前缀不同方法各走各的（credentials 的 PUT / DELETE 形态）', () => {
  const routes = [
    { prefix: '/api/credentials/', method: 'PUT', h },
    { prefix: '/api/credentials/', method: 'DELETE', h },
  ];
  assert.equal(matchRouteFrom(routes, 'DELETE', '/api/credentials/abc').index, 1);
});

// ── 从下标继续匹配（契约 3）──────────────────────────────────

test('startIdx 让匹配从指定位置起 —— handler 回 false 后靠它继续', () => {
  const routes = [
    { prefix: '/api/conv-notify/', h },
    { prefix: '/api/', h },
  ];
  // 第一条回 false 时，应从下标 1 继续，而不是从头（从头会死循环）
  assert.equal(matchRouteFrom(routes, 'GET', '/api/conv-notify/x', 1).index, 1);
});

test('startIdx 越界返回 null 而不抛', () => {
  assert.equal(matchRouteFrom([{ path: '/a', h }], 'GET', '/a', 99), null);
});

// ── 遮蔽自检 ──────────────────────────────────────────────────

test('findShadowedRoutes：健康的表返回空数组', () => {
  const routes = [
    { path: '/api/history', h },
    { prefix: '/api/history/', h },
    { path: '/api/ping', h },
  ];
  assert.deepEqual(findShadowedRoutes(routes), []);
});

test('findShadowedRoutes：检出被前面前缀遮蔽的精确路由', () => {
  const routes = [
    { prefix: '/api/req/', h },
    { path: '/api/req/special', h },
  ];
  const bad = findShadowedRoutes(routes);
  assert.equal(bad.length, 1);
  assert.match(bad[0].shadowed, /\/api\/req\/special/);
  assert.match(bad[0].by, /\/api\/req\/\*/);
});

test('findShadowedRoutes：前缀限定了别的方法则不算遮蔽', () => {
  const routes = [
    { prefix: '/api/bots/', method: 'DELETE', h },
    { path: '/api/bots/x', method: 'PUT', h },
  ];
  assert.deepEqual(findShadowedRoutes(routes), [], 'DELETE 前缀不该遮蔽 PUT 精确路由');
});

test('findShadowedRoutes：不限方法的前缀会遮蔽任何方法的精确路由', () => {
  const routes = [
    { prefix: '/api/a/', h },
    { path: '/api/a/x', method: 'PUT', h },
  ];
  assert.equal(findShadowedRoutes(routes).length, 1);
});

test('findShadowedRoutes：精确在前、前缀在后不算遮蔽（正确顺序）', () => {
  const routes = [
    { path: '/api/a/x', h },
    { prefix: '/api/a/', h },
  ];
  assert.deepEqual(findShadowedRoutes(routes), []);
});

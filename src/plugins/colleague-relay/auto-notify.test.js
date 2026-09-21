import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyAutoHandle } from './auto-notify.js';

test('非后端 / 缺参 / 空 ids：不发请求，直接返回 false', async () => {
  assert.equal(await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'product', msgIds: ['m'] }), false);
  assert.equal(await notifyAutoHandle({ reqId: '', colleagueId: 'c', role: 'backend', msgIds: ['m'] }), false);
  assert.equal(await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'backend', msgIds: [] }), false);
  assert.equal(await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'backend', msgIds: [null, ''] }), false);
});

/** 打桩 fetch：这是仓库第一处 fetch 桩，用 node:test 自带的 mock，不引第三方 */
function stubFetch(t, impl) {
  t.mock.method(globalThis, 'fetch', impl);
}

test('web 回 202 → true', async (t) => {
  stubFetch(t, async () => new Response(null, { status: 202 }));
  assert.equal(await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'backend', msgIds: ['m'] }), true);
});

test('web 回 400 且 body 非 JSON → false 不抛（.json() 失败要被吞掉）', async (t) => {
  stubFetch(t, async () => new Response('<html>bad</html>', { status: 400, headers: { 'content-type': 'text/html' } }));
  assert.equal(await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'backend', msgIds: ['m'] }), false);
});

test('fetch 抛错（web 未起 / 超时）→ false 不抛（消息已落盘，飞书回执链路不能被拖死）', async (t) => {
  stubFetch(t, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'backend', msgIds: ['m'] }), false);
});

test('守卫命中时压根不调 fetch', async (t) => {
  const f = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 202 }));
  await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'product', msgIds: ['m'] });
  await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'backend', msgIds: [] });
  assert.equal(f.mock.callCount(), 0);
});

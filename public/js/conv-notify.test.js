/**
 * 飞书补充内容收件箱轮询 —— 认领（/claim）契约测试。
 *
 * 为什么这条必须有测试（2026-08-28 真实事故）：
 * applyInjected 的真身是 chat.js 的 applyInjectedItems，它是 **async**；而 pollInbox 曾把它
 * 当同步函数用 —— `Promise.length` 是 undefined，`if (!applied.length) return` 于是永远提前
 * return，/claim 一次都不发。后果远不止「少认领一次」：条目永远留在服务端收件箱里，5 秒一轮
 * 的轮询把同一条补充内容反复上屏，用户看到的是「自己最后那句话被无限自动重发」；而助手气泡
 * 接的是注入那一刻的 runId，隔天进程早已重启、run 不存在，气泡永久停在「运行中…」。
 *
 * 两条断言互为反面，缺一不可：
 *  - 上了屏必须认领（否则重复上屏）
 *  - 没上屏绝不认领（认领即从服务端删除，这条补充内容会永久蒸发）
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const CONV_ID = 'c_test_inbox';

let dom;
let calls; // 本轮记录到的 fetch 调用：{url, body}
let inboxItems; // /inbox 要返回的条目
let appliedResult; // applyInjected 的返回值（真身 async，这里也必须 async）

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><button id="notifyFabBtn"></button></body></html>', {
    url: 'http://localhost/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  // conv-store 的 _convsCache 是模块级的、首次 loadConvs 即定型 —— 必须在任何调用前种好数据
  localStorage.setItem(
    'claude_convs',
    JSON.stringify([{ id: CONV_ID, title: 't', messages: [], meta: { notifyFeishu: true } }]),
  );
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
    if (u.startsWith('/api/conv-notify/inbox')) {
      return { ok: true, json: async () => ({ active: true, items: inboxItems }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const { bindConvNotify } = await import('./conv-notify.js');
  // 只 bind 一次：每次 bind 都会新建一份闭包定时器，重复 bind 会漏掉旧的那个
  bindConvNotify({
    applyInjected: async () => appliedResult, // 与 chat.js 的 applyInjectedItems 同为 async
    getCurrentConvId: () => CONV_ID,
  });
});

after(() => {
  // 停掉 5s 轮询：切到一个本地没有记录的会话即触发 stopPolling，否则 node --test 不退出
  window.__convNotify?.onConvOpened('__no_such_conv__');
  dom?.window?.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.fetch;
});

beforeEach(() => {
  calls = [];
});

/** 等 pollInbox 的两段 await（fetch + applyInjected）落地 */
const settle = () => new Promise((r) => setTimeout(r, 20));

test('条目上屏后必须 /claim 认领（applyInjected 是 async，不能当同步函数用）', async () => {
  inboxItems = [{ id: 'inj_1', text: '继续', runId: 'run_dead' }];
  appliedResult = ['inj_1'];

  window.__convNotify.onConvOpened(CONV_ID); // 内部立刻 pollInbox 一次
  await settle();

  const claim = calls.find((c) => c.url.includes('/api/conv-notify/claim'));
  assert.ok(claim, '已上屏却没发 /claim：条目留在服务端收件箱，下一轮会把同一条补充内容再上一次屏');
  assert.deepEqual(claim.body, { convId: CONV_ID, ids: ['inj_1'] });
});

test('一条都没上屏 → 绝不认领（认领即删除，这条补充内容会永久蒸发）', async () => {
  inboxItems = [{ id: 'inj_2', text: '再补一句', runId: 'run_dead' }];
  appliedResult = [];

  window.__convNotify.onConvOpened(CONV_ID);
  await settle();

  assert.equal(
    calls.some((c) => c.url.includes('/api/conv-notify/claim')),
    false,
    '没上屏就认领 = 服务端把条目删了、用户永远看不到这条补充内容',
  );
});

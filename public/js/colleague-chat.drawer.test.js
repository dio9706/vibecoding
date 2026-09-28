/**
 * 同事对话**抽屉**的 DOM 回归测试（2026-09-22 由居中 modal 改造而来）。
 *
 * 为什么必须真跑 DOM：这类改造服务端全绿、静态检查也看不出问题，但整条交互可以是死的 ——
 * 切页没切、返回后轮询还在跑、重复打开叠出两层抽屉，都只有驱动一遍才暴露。
 * 同目录的 `req-chat.apidoc.test.js` 就是为同一类事故（handler 引用未声明变量）建的，这里沿用它的骨架。
 *
 * 盯死的几件事：
 * 1. **非模态**：抽屉壳不是遮罩，否则会吃掉主会话区的点击 —— 那正是改抽屉要解决的问题；
 * 2. **两级切页**：列表 ↔ 对话共用一个抽屉，靠 hidden 切换，不叠层；
 * 3. **轮询清理**：返回列表与关闭抽屉都必须停掉 10s 轮询，否则定时器挂在已卸载的 DOM 上一直发请求。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

let dom;
let openColleagueList;
let calls; // fetch 调用流水，断言「标已读」与「轮询是否停了」

const ASSIGNEES = [
  { id: 'cl_1', name: '王德志', role: 'backend', roleLabel: '后端', feishuOpenId: 'ou_1', missing: false, unreadCount: 3 },
  { id: 'cl_2', name: '李四', role: 'frontend', roleLabel: '前端', feishuOpenId: '', missing: false, unreadCount: 0 },
];

/** 打开抽屉并返回壳元素 */
function openDrawer() {
  openColleagueList({ reqId: 'r_1', assigneeList: ASSIGNEES, onChangeAssignees: () => {} });
  return dom.window.document.querySelector('.cc-drawer-host');
}

before(async () => {
  // 用真实 index.html 当骨架：chat.js / dir-popover.js 在模块顶层就绑事件，缺元素会直接抛
  const html = fs.readFileSync('public/index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  dom = new JSDOM(html, { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.File = dom.window.File;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.EventSource = class { addEventListener() {} close() {} };
  globalThis.alert = () => {};
  dom.window.toast = { success() {}, error() {}, info() {} };

  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET' });
    if (u.includes('/api/req/colleague-messages?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          messages: [
            {
              id: 'm1', dir: 'in', text: '接口文档给你', at: new Date().toISOString(),
              files: [{ name: 'api.md', path: 'C:\\t\\api.md' }],
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  ({ openColleagueList } = await import('./colleague-chat.js'));
});

after(() => {
  dom?.window?.document?.querySelector('.cc-drawer-host')?.remove();
  dom?.window?.close();
});

test('抽屉：右侧滑出且非模态（不带遮罩，主会话区仍可点）', () => {
  const host = openDrawer();
  assert.ok(host, '应渲染抽屉壳 .cc-drawer-host');
  assert.ok(host.querySelector('.cc-drawer'), '应有抽屉本体');
  // 关键：壳自身不能是遮罩。带上 .mask 就会盖住主会话区，等于退回改造前的居中弹窗
  assert.ok(!host.classList.contains('mask'), '抽屉壳不应是遮罩');
  assert.equal(host.querySelector('.mask'), null, '抽屉内部不应含遮罩');
  host.querySelector('.cc-close').click();
});

test('抽屉：初始停在列表页，未读数与禁用态照常渲染', () => {
  const host = openDrawer();
  assert.equal(host.querySelector('.cc-page-list').hidden, false, '初始应停在列表页');
  assert.equal(host.querySelector('.cc-page-chat').hidden, true, '对话页应隐藏');
  assert.equal(host.querySelector('.cc-back').hidden, true, '列表页不该显示返回按钮');
  assert.equal(host.querySelector('.cc-drawer-title').textContent, '开发人员');
  assert.equal(host.querySelectorAll('.cc-row').length, 2);
  assert.equal(host.querySelector('.cc-badge').textContent, '3', '未读数应渲染');
  assert.equal(host.querySelectorAll('.cc-row')[1].disabled, true, '没填飞书 open_id 的应禁用');
  host.querySelector('.cc-close').click();
});

test('抽屉：点同事切到对话页（同一抽屉内，不叠层），进页即标已读', async () => {
  const host = openDrawer();
  host.querySelectorAll('.cc-row')[0].click();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(host.querySelector('.cc-page-list').hidden, true, '列表页应隐藏');
  assert.equal(host.querySelector('.cc-page-chat').hidden, false, '对话页应显示');
  assert.equal(host.querySelector('.cc-back').hidden, false, '对话页应显示返回按钮');
  assert.equal(host.querySelector('.cc-drawer-title').textContent, '王德志·后端', '标题应切成同事名');
  assert.ok(host.querySelector('.cc-msg'), '消息应渲染');
  assert.ok(host.querySelector('.cc-file'), '附件应渲染');
  assert.ok(calls.some((c) => c.url.includes('/read') && c.method === 'POST'), '进对话页应标已读');
  assert.equal(dom.window.document.querySelectorAll('.cc-drawer-host').length, 1, '切页不该开出第二个抽屉');
  host.querySelector('.cc-close').click();
});

test('抽屉：附件带下载按钮，且非 md 附件也能下载（查看器只认 md，其余此前拿不到手）', async () => {
  // 这一轮让 fetch 回两个附件：一个 md（可打开）、一个 json（打不开，只能下载）
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET' });
    if (u.includes('/api/req/colleague-messages?')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          messages: [{
            id: 'm2', dir: 'in', text: '两份文档', at: new Date().toISOString(),
            files: [
              { name: 'api.md', path: 'C:\\t\\muc9-api.md' },
              { name: 'openapi.json', path: 'C:\\t\\muc9-openapi.json' },
            ],
          }],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const host = openDrawer();
  host.querySelectorAll('.cc-row')[0].click();
  await new Promise((r) => setTimeout(r, 30));

  const rows = host.querySelectorAll('.cc-file-row');
  assert.equal(rows.length, 2, '两个附件各占一行');
  assert.equal(host.querySelectorAll('.cc-file-dl').length, 2, '每个附件都该有下载按钮，不分类型');
  // md 渲染成可点按钮，json 保持纯文本（点了必然失败的请求不该诱导用户去点）
  assert.equal(rows[0].querySelector('.cc-file').tagName, 'BUTTON', 'md 文件名可点开查看器');
  assert.equal(rows[1].querySelector('.cc-file').tagName, 'SPAN', '非 md 文件名保持纯文本');

  // 点下载：应生成 <a download> 指向 /api/fs/download，且 name 用登记名而非盘上的副本名
  let clickedHref = null;
  const realClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function () { clickedHref = this.href; };
  try {
    rows[1].querySelector('.cc-file-dl').click();
  } finally {
    dom.window.HTMLAnchorElement.prototype.click = realClick;
  }
  assert.ok(clickedHref, '应触发一次 <a> 点击');
  assert.ok(clickedHref.includes('/api/fs/download'), '应打到下载端点');
  assert.ok(clickedHref.includes(encodeURIComponent('C:\\t\\muc9-openapi.json')), 'path 须 encode 后带上');
  assert.ok(clickedHref.includes('name=' + encodeURIComponent('openapi.json')), 'name 应是登记名，不是带前缀的副本名');
  assert.equal(dom.window.document.querySelector('a[href*="/api/fs/download"]'), null, '触发后临时 <a> 必须移除');

  host.querySelector('.cc-close').click();
  globalThis.fetch = orig;
});

test('抽屉：返回列表会清空对话页并停掉轮询（否则定时器挂在隐藏页上继续发请求）', async () => {
  const host = openDrawer();
  host.querySelectorAll('.cc-row')[0].click();
  await new Promise((r) => setTimeout(r, 30));

  host.querySelector('.cc-back').click();
  assert.equal(host.querySelector('.cc-page-list').hidden, false, '应切回列表页');
  assert.equal(host.querySelector('.cc-drawer-title').textContent, '开发人员', '标题应还原');
  assert.equal(host.querySelector('.cc-msgs').innerHTML, '', '对话页须清空，否则下次进别的同事会看到上一个人的残留');

  const before = calls.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, before, '返回后不应再有轮询请求');
  host.querySelector('.cc-close').click();
});

test('抽屉：重复打开只留一个；Esc 与 ✕ 都能关，且关后轮询已停', async () => {
  openDrawer();
  const host = openDrawer();
  assert.equal(dom.window.document.querySelectorAll('.cc-drawer-host').length, 1, '重复打开应只留一个抽屉');

  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(dom.window.document.querySelector('.cc-drawer-host'), null, 'Esc 应关闭抽屉');
  void host;

  // ✕ 关闭时若停在对话页，轮询定时器必须一并清掉
  const h2 = openDrawer();
  h2.querySelectorAll('.cc-row')[0].click();
  await new Promise((r) => setTimeout(r, 30));
  h2.querySelector('.cc-close').click();
  assert.equal(dom.window.document.querySelector('.cc-drawer-host'), null, '✕ 应关闭抽屉');

  const before = calls.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, before, '关闭后不应再有轮询请求（定时器须已清）');
});

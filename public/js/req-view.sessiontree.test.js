/**
 * 侧栏需求会话树的折叠行为回归测试。
 *
 * 背景（2026-08-13）：用户反馈「开发阶段需求下拉会自动收起，箭头也不随状态变化」。
 * 实际不是收起，是**数据被抹掉**：
 *   - 子会话行的渲染条件曾是 `isExpanded && sessions.length > 0`，而箭头只看 `isExpanded`
 *     —— 两个判定源；
 *   - /api/req/list 一度不返回 sessions，30s 轮询用它整体替换 lastList 后 sessions 变空，
 *     于是子行凭空消失、箭头却仍指着「展开」，点它也只是翻个字符（没有子行可显隐），
 *     用户感知就是「自动收起 + 箭头没反应」。
 *
 * 因此本测试锁两件事：轮询后会话树必须还在；箭头状态与子行必须同源。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

let dom;
let refreshReqList;
let doc;

const REQ = {
  id: 'r_tree1',
  title: '会话树需求',
  phase: 'dev', // dev/test 才有折叠箭头，且默认展开
  updatedAt: new Date().toISOString(),
  busy: false,
  sessions: [
    { convId: 'c_main', sessionId: 's1', title: '主会话', kind: 'main', createdAt: '' },
    { convId: 'c_sub', sessionId: null, title: '登录页修复', kind: 'sub', createdAt: '' },
  ],
};

function stubList(requirements) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/req/list')) {
      return { ok: true, status: 200, json: async () => ({ requirements }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

const arrow = () => doc.querySelector('#reqList .req-expand-arrow');
const sessionRows = () => doc.querySelectorAll('#reqList .req-session-row');

before(async () => {
  const html = fs.readFileSync('public/index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  dom = new JSDOM(html, { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.EventSource = class { addEventListener() {} close() {} };
  globalThis.alert = () => {};
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  doc = dom.window.document;

  ({ refreshReqList } = await import('./req-view.js'));
});

after(() => dom?.window?.close());

test('开发期需求：默认展开，箭头标记为展开态且渲染出子会话行', async () => {
  stubList([REQ]);
  await refreshReqList();

  assert.equal(arrow()?.dataset.expanded, '1', '开发期默认展开，箭头应标记展开态');
  const rows = sessionRows();
  assert.equal(rows.length, 2, '两条会话都应渲染');
  assert.ok([...rows].some((r) => r.textContent.includes('登录页修复')), '子会话标题应可见');
});

test('轮询再次刷新后，会话树不得消失（回归：list 少返 sessions 导致子行被抹）', async () => {
  stubList([REQ]);
  await refreshReqList();
  assert.equal(sessionRows().length, 2);

  // 模拟 30s 轮询的第二拍：同样的接口再来一次
  await refreshReqList();

  assert.equal(sessionRows().length, 2, '轮询后子会话行应仍在');
  assert.equal(arrow()?.dataset.expanded, '1', '轮询不应改变展开态');
});

test('后端漏返 sessions 时用上一轮缓存兜底，不把会话树抹空', async () => {
  stubList([REQ]);
  await refreshReqList();
  assert.equal(sessionRows().length, 2);

  // 后端回退/版本不一致：投影里没有 sessions 字段
  const { sessions, ...withoutSessions } = REQ;
  stubList([withoutSessions]);
  await refreshReqList();

  assert.equal(sessionRows().length, 2, '缺字段时应沿用上一轮的会话树');
});

test('点箭头折叠：箭头状态与子会话行同源变化', async () => {
  stubList([REQ]);
  await refreshReqList();
  assert.equal(arrow()?.dataset.expanded, '1');
  assert.ok(sessionRows().length > 0);

  arrow().onclick(new dom.window.MouseEvent('click'));

  assert.equal(arrow()?.dataset.expanded, '0', '折叠后箭头应标记收起态');
  assert.equal(sessionRows().length, 0, '折叠后子会话行应消失（与箭头同源）');

  arrow().onclick(new dom.window.MouseEvent('click'));

  assert.equal(arrow()?.dataset.expanded, '1', '再点应展开');
  assert.equal(sessionRows().length, 2, '展开后子会话行应回来');
});

test('无会话的开发期需求：展开时仍给出「＋新会话」入口', async () => {
  stubList([{ ...REQ, sessions: [] }]);
  await refreshReqList();

  assert.equal(arrow()?.dataset.expanded, '1');
  assert.equal(sessionRows().length, 0);
  assert.ok(
    doc.querySelector('#reqList .req-add-session-row'),
    '没有会话时也该有新建入口，否则开发期需求点开是空的',
  );
});

test('评审期需求：不渲染折叠箭头（没有会话树可展开）', async () => {
  stubList([{ ...REQ, phase: 'review', sessions: [] }]);
  await refreshReqList();

  assert.equal(arrow(), null, '非开发/测试期不应出现折叠箭头');
});

test('会话树点开服务端建的子会话：本地无记录时按既定 id 补建（含 session），二次点击不重复', async () => {
  // 服务端（colleague-dev）起的子会话：本地 localStorage 尚无对应 conv 记录
  const REQ_H = {
    id: 'r_tree_hydrate',
    title: '子会话补建需求',
    phase: 'dev',
    updatedAt: new Date().toISOString(),
    busy: false,
    sessions: [
      { convId: 'c_main_h', sessionId: 's_main_h', title: '主会话', kind: 'main', createdAt: '' },
      { convId: 'c_sub_h', sessionId: 'sess_h', title: '接入接口文档：a.md', kind: 'sub', createdAt: '' },
    ],
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/req/list')) {
      return { ok: true, status: 200, json: async () => ({ requirements: [REQ_H] }) };
    }
    if (u.includes('/api/req/get')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: REQ_H.id,
          phase: 'dev',
          busy: null,
          devCwd: 'D:/x',
          projects: { frontend: { dir: 'D:/x', dev: true }, backend: null },
        }),
      };
    }
    if (u.includes('/api/history')) {
      return { ok: false, status: 404, json: async () => ({ ok: false }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await refreshReqList();

  const subRow = [...sessionRows()].find((r) => r.textContent.includes('接入接口文档：a.md'));
  assert.ok(subRow, '子会话行应渲染');

  const { loadConvs } = await import('./conv-store.js');
  assert.equal(
    loadConvs().filter((c) => c.id === 'c_sub_h').length,
    0,
    '点击前本地不应已有该 conv',
  );

  await subRow.onclick(); // onclick 返回 openSessionConv 的 promise

  const created = loadConvs().find((c) => c.id === 'c_sub_h');
  assert.ok(created, '点击后应按既定 id 补建 conv');
  assert.equal(created.meta.reqId, REQ_H.id, 'reqId 应写入 meta');
  assert.equal(created.cwd, 'D:/x', 'cwd 取自 /api/req/get 的 devCwd');
  assert.equal(created.session, 'sess_h', '须带上 session，否则回放后追问会开一个陌生的 Claude 会话');
  assert.equal(created.meta.kind, 'sub');

  await subRow.onclick(); // 二次点击

  assert.equal(
    loadConvs().filter((c) => c.id === 'c_sub_h').length,
    1,
    '二次点击不应重复补建（幂等）',
  );
});

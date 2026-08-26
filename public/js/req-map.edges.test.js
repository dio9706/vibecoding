/**
 * 需求地图页面跳转连线的渲染回归测试。
 *
 * 背景（2026-08-26）：用户反馈「需求地图只列出了页面和改动，页面之间没有关联」。
 * 根因不在模型，在代码 —— prompt 契约要求 edges 的 from/to 用页面 **name**
 * （见 req-map.logic.js 的 mapOutputContract），而 normalizeMap 却按自动生成的 **id**
 * 校验，于是所有边被静默丢弃：画布上一条线都没有，layoutMap 也因为入度全为 0
 * 把所有页面挤在第 0 层横排一行。
 *
 * 数据层的口径已由 req-map.logic.test.js 锁住，这里锁渲染层：边必须画出来、方向必须
 * 朝目标、层级关系必须决定走向、选中页面必须能把它的链路挑出来。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { layoutMap } from './req-map-layout.logic.js';

let dom;
let doc;
let mountMap;

/** 游戏广场作 hub，两个子游戏页，再挂一条与 hub 无关的边用来验证「淡出」。 */
function makeMap() {
  return {
    pages: [
      {
        id: 'p1',
        name: '游戏广场',
        file: 'src/pages-companion/game-square/index.vue',
        state: 'changed',
        points: [{ id: 'pt1', type: 'add', title: '四宫格入口', before: '—', after: '新增四个游戏入口', src: [], files: [] }],
      },
      { id: 'p2', name: '今晚吃什么转盘', file: 'src/pages-companion/game-roulette/index.vue', state: 'new', points: [] },
      { id: 'p3', name: '赛博饭签', file: 'src/pages-companion/game-fortune-stick/index.vue', state: 'new', points: [] },
      { id: 'p4', name: '转盘结果分享页', file: 'src/pages-companion/share/index.vue', state: 'new', points: [] },
    ],
    edges: [
      { from: 'p1', to: 'p2', label: '点击 今晚吃什么' },
      { from: 'p1', to: 'p3', label: '点击 赛博饭签' },
      { from: 'p2', to: 'p4', label: '点击 生成海报' }, // 与 hub 无关，选中 hub 时应淡出
    ],
    annots: {},
  };
}

// 一律限定在 .rq-canvas-host 内：鸟瞰图里挂着一份画布的 cloneNode 副本，而 .rq-minimap
// 在骨架里排在 .rq-canvas-host **之前**，全局选择器会优先命中那份没有事件监听的克隆体。
const paths = () => [...doc.querySelectorAll('.rq-canvas-host .rq-edges > path')];
const pathOf = (from, to) => paths().find((p) => p.getAttribute('data-from') === from && p.getAttribute('data-to') === to);
const nodeHeadOf = (index) => doc.querySelectorAll('.rq-canvas-host .rq-node')[index].querySelector('.rq-nhead');

/** 抽屉里某一节的行文本。节标题在 .rq-lb 上，行在紧随的 .rq-jump 里。 */
function drawerSectionRows(label) {
  for (const sec of doc.querySelectorAll('.rq-dbody .rq-sec')) {
    if (sec.querySelector('.rq-lb')?.textContent === label) {
      return [...sec.querySelectorAll('.rq-jump-item')].map((r) => r.textContent);
    }
  }
  return null;
}

/** 每个用例都重新挂载：mountMap 会改写传入的 map（annots/fresh），共用会串味。 */
function mount() {
  const container = doc.getElementById('host');
  const map = makeMap();
  mountMap(container, { reqId: 'r_test', phase: 'review', map, versions: [{ v: 1, at: '' }], version: 1 });
  return map;
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  dom.window.toast = { success() {}, error() {} };
  doc = dom.window.document;

  ({ mountMap } = await import('./req-map.js'));
});

after(() => dom?.window?.close());

test('每条 edge 都画出一条带箭头的连线（回归：边曾被 normalizeMap 全部丢弃）', () => {
  mount();
  assert.equal(paths().length, 3, '三条边应画出三条连线');
  for (const p of paths()) {
    assert.match(p.getAttribute('marker-end') || '', /#rq-arrow/, '每条连线都要有箭头 marker');
  }

  // marker 必须真在 SVG 命名空间里 —— 落到 HTML 命名空间的话浏览器不认，箭头会隐形
  const marker = doc.querySelector('.rq-canvas-host .rq-edges defs marker#rq-arrow');
  assert.ok(marker, '常态箭头 marker 应存在');
  assert.equal(marker.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.ok(doc.querySelector('.rq-canvas-host .rq-edges defs marker#rq-arrow-hl'), '高亮箭头 marker 应存在');
});

test('鸟瞰图克隆体不复制 defs，避免 marker id 在文档里撞车', () => {
  mount();
  assert.equal(doc.querySelectorAll('marker#rq-arrow').length, 1, 'marker id 全文档只能有一份');
  assert.ok(doc.querySelector('.rq-minimap-content .rq-canvas'), '鸟瞰图里应有画布克隆体');
});

test('父子连线从父节点下沿出、子节点上沿进（不再按 dx/dy 猜走向）', () => {
  const map = mount();
  const layout = layoutMap(map);
  const hub = layout.positions.p1;
  const kid = layout.positions.p2;

  const d = pathOf('p1', 'p2').getAttribute('d');
  const [, sx, sy] = d.match(/^M([\d.-]+) ([\d.-]+)/);

  assert.equal(Number(sx), hub.x + layout.nodeW / 2, '起点应在父节点水平中线');
  assert.equal(Number(sy), hub.y + hub.h, '起点应在父节点下沿');
  assert.match(d, new RegExp(`${kid.x + layout.nodeW / 2} ${kid.y}$`), '终点应在子节点上沿中点');
});

test('hub 页面水平居中于子节点组', () => {
  const map = mount();
  const layout = layoutMap(map);
  const cx = (id) => layout.positions[id].x + layout.nodeW / 2;
  assert.equal(cx('p1'), (cx('p2') + cx('p3')) / 2, '游戏广场应居中于两个子游戏页之间');
});

test('未选中任何页面时，连线不带高亮/淡出状态', () => {
  mount();
  for (const p of paths()) assert.equal(p.getAttribute('class'), null);
});

test('选中 hub 页面时它的链路高亮、无关连线淡出', () => {
  mount();
  nodeHeadOf(0).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.equal(pathOf('p1', 'p2').getAttribute('class'), 'hl');
  assert.equal(pathOf('p1', 'p3').getAttribute('class'), 'hl');
  assert.equal(pathOf('p2', 'p4').getAttribute('class'), 'dim', '与选中页无关的边应淡出');
  assert.match(pathOf('p1', 'p2').getAttribute('marker-end'), /#rq-arrow-hl/, '高亮边要换高亮箭头');
});

test('入度为 0 的页面打「入口」徽标，其余不打', () => {
  mount();
  const nodes = [...doc.querySelectorAll('.rq-canvas-host .rq-node')];
  const hasEntry = (n) => !!n.querySelector('.rq-nflag.rq-entry');
  assert.ok(hasEntry(nodes[0]), '游戏广场是入口页，应有徽标');
  assert.ok(!hasEntry(nodes[1]) && !hasEntry(nodes[2]) && !hasEntry(nodes[3]), '子页面不该有入口徽标');
});

test('抽屉列出「从哪来 / 去哪」，带跳转动作', () => {
  mount();
  nodeHeadOf(1).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); // 今晚吃什么转盘

  assert.deepEqual(drawerSectionRows('从哪来'), ['游戏广场· 点击 今晚吃什么']);
  assert.deepEqual(drawerSectionRows('去哪'), ['转盘结果分享页· 点击 生成海报']);
});

test('入口页的「从哪来」为空时显示「无」', () => {
  mount();
  nodeHeadOf(0).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); // 游戏广场

  assert.deepEqual(drawerSectionRows('从哪来'), [], '入口页没有上游，不该有可点击行');
  assert.ok(
    [...doc.querySelectorAll('.rq-dbody .rq-sec')].some(
      (s) => s.querySelector('.rq-lb')?.textContent === '从哪来' && s.querySelector('.rq-nempty')?.textContent === '无',
    ),
    '应显示占位「无」',
  );
});

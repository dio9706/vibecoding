/**
 * 通用地图画布内核（map-canvas.js）单测。
 *
 * 覆盖三块：DOM 结构（渲染/重绘）、坐标数学（缩放/平移/fitView）、事件分发边界
 * （nodeClick/nodeHover 只在节点元素内触发）。不测需求地图的业务逻辑——那部分
 * 已经被 req-map.edges.test.js 锁死，本文件只对内核本身负责。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let dom;
let createMapCanvas;
let container;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.MouseEvent = dom.window.MouseEvent;
  ({ createMapCanvas } = await import('./map-canvas.js'));
});

after(() => dom?.window?.close());

beforeEach(() => {
  document.getElementById('host').innerHTML = '<div id="mount"></div>';
  container = document.getElementById('mount');
});

function twoNodes(extra) {
  return [
    { id: 'a', x: 0, y: 0, width: 100, height: 50 },
    { id: 'b', x: 300, y: 0, width: 100, height: 50 },
    ...(extra || []),
  ];
}

test('渲染：每个 node 生成一个 .rq-node，位置由 x/y 决定', () => {
  const api = createMapCanvas(container, { nodes: twoNodes(), edges: [] });
  const nodes = [...container.querySelectorAll('.rq-canvas-host .rq-nodes .rq-node')];
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].style.left, '0px');
  assert.equal(nodes[1].style.left, '300px');
  api.destroy();
});

test('renderNode callback 接到 (node, el)，可以注入内容与样式', () => {
  const seen = [];
  const api = createMapCanvas(container, {
    nodes: twoNodes(),
    edges: [],
    renderNode(node, el) {
      seen.push(node.id);
      el.textContent = 'n:' + node.id;
      el.classList.add('custom');
    },
  });
  assert.deepEqual(seen, ['a', 'b']);
  const nodes = [...container.querySelectorAll('.rq-node')];
  assert.equal(nodes[0].textContent, 'n:a');
  assert.ok(nodes[0].classList.contains('custom'));
  api.destroy();
});

test('setNodes 触发重绘：旧节点清空，换成新集合', () => {
  const api = createMapCanvas(container, { nodes: twoNodes(), edges: [] });
  api.setNodes([{ id: 'c', x: 10, y: 10, width: 40, height: 40 }]);
  const nodes = [...container.querySelectorAll('.rq-canvas-host .rq-node')];
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].dataset.nodeId, 'c');
  api.destroy();
});

test('连线：edge 画成带箭头的 path，label 落在曲线上', () => {
  const api = createMapCanvas(container, {
    nodes: twoNodes(),
    edges: [{ from: 'a', to: 'b', label: '跳转' }],
  });
  const path = container.querySelector('.rq-edges > path');
  assert.ok(path, '应画出一条连线');
  assert.equal(path.getAttribute('data-from'), 'a');
  assert.equal(path.getAttribute('data-to'), 'b');
  assert.match(path.getAttribute('marker-end') || '', /#rq-arrow/);
  const label = container.querySelector('.rq-edges text');
  assert.equal(label.textContent, '跳转');
  api.destroy();
});

test('edge.state 决定连线的高亮/淡出 class 与箭头 marker；无 state 时不带 class', () => {
  const api = createMapCanvas(container, {
    nodes: twoNodes(),
    edges: [{ from: 'a', to: 'b' }],
  });
  let path = container.querySelector('.rq-edges > path');
  assert.equal(path.getAttribute('class'), null);
  assert.match(path.getAttribute('marker-end'), /#rq-arrow"|#rq-arrow$|#rq-arrow\)/);

  api.setEdges([{ from: 'a', to: 'b', state: 'hl' }]);
  path = container.querySelector('.rq-edges > path');
  assert.equal(path.getAttribute('class'), 'hl');
  assert.match(path.getAttribute('marker-end'), /#rq-arrow-hl/);

  api.setEdges([{ from: 'a', to: 'b', state: 'dim' }]);
  path = container.querySelector('.rq-edges > path');
  assert.equal(path.getAttribute('class'), 'dim');
  assert.match(path.getAttribute('marker-end'), /#rq-arrow(?!-hl)/);
  api.destroy();
});

test('缺失端点的 edge 静默跳过，不抛错', () => {
  const api = createMapCanvas(container, {
    nodes: twoNodes(),
    edges: [{ from: 'a', to: 'ghost' }],
  });
  assert.equal(container.querySelectorAll('.rq-edges > path').length, 0);
  api.destroy();
});

test('minimap：内容是画布的克隆体，且不带 defs（避免 marker id 撞车）', () => {
  const api = createMapCanvas(container, {
    nodes: twoNodes(),
    edges: [{ from: 'a', to: 'b' }],
  });
  const clone = container.querySelector('.rq-minimap-content .rq-canvas');
  assert.ok(clone, '鸟瞰图应包含画布克隆体');
  assert.equal(clone.querySelector('defs'), null, '克隆体不应带 defs');
  assert.equal(container.querySelectorAll('marker#rq-arrow').length, 1, 'marker id 全文档只有一份');
  api.destroy();
});

test('getScale 初始为 1，zoom(factor) 按相对倍数缩放并夹在 [0.35, 1.8]', () => {
  const api = createMapCanvas(container, { nodes: twoNodes(), edges: [] });
  assert.equal(api.getScale(), 1);
  api.zoom(0.5);
  assert.equal(api.getScale(), 0.5, '0.5 倍缩放在合法范围内，应精确生效');
  api.zoom(0.1);
  assert.ok(api.getScale() >= 0.35, '不能低于下限');
  api.zoom(100);
  assert.ok(api.getScale() <= 1.8, '不能超过上限');
  api.destroy();
});

test('pan(dx,dy) 平移画布，反映在 canvas 的 transform 上', () => {
  const api = createMapCanvas(container, { nodes: twoNodes(), edges: [] });
  api.pan(10, 20);
  const canvas = container.querySelector('.rq-canvas-host .rq-canvas');
  assert.match(canvas.style.transform, /translate\(10px,20px\)/);
  api.pan(5, -5);
  assert.match(canvas.style.transform, /translate\(15px,15px\)/);
  api.destroy();
});

test('fitView 后画布可见（scale 落在合法范围，viewport 不为负）', () => {
  Object.defineProperty(container.querySelector('.rq-canvas-host') || {}, 'clientWidth', { value: 0, configurable: true });
  const api = createMapCanvas(container, { nodes: twoNodes([{ id: 'c', x: 800, y: 400, width: 100, height: 50 }]), edges: [] });
  api.fitView();
  const scale = api.getScale();
  assert.ok(scale >= 0.35 && scale <= 1.8);
  const vp = api.getMinimapViewport();
  assert.ok(vp.width >= 0 && vp.height >= 0);
  api.destroy();
});

test('getMinimapViewport 返回 {x,y,width,height}', () => {
  const api = createMapCanvas(container, { nodes: twoNodes(), edges: [] });
  const vp = api.getMinimapViewport();
  assert.ok('x' in vp && 'y' in vp && 'width' in vp && 'height' in vp);
  api.destroy();
});

// 一律限定在 .rq-canvas-host 内：鸟瞰图里挂着一份画布的 cloneNode 副本（无事件监听），
// 全局选择器会优先命中那份克隆体（.rq-minimap 在骨架里排在 .rq-canvas-host 之前）。
test('highlightNodes：命中的节点保持不透明，其余降透明度；传空数组恢复', () => {
  const api = createMapCanvas(container, { nodes: twoNodes(), edges: [] });
  api.highlightNodes(['a']);
  const nodes = [...container.querySelectorAll('.rq-canvas-host .rq-node')];
  const nodeA = nodes.find((n) => n.dataset.nodeId === 'a');
  const nodeB = nodes.find((n) => n.dataset.nodeId === 'b');
  assert.notEqual(nodeB.style.opacity, '');
  assert.equal(nodeA.style.opacity, '');
  api.highlightNodes([]);
  assert.equal(nodeB.style.opacity, '');
  api.destroy();
});

test('nodeClick 只在节点元素内触发，点击画布空白不触发', () => {
  let clicked = null;
  const api = createMapCanvas(container, {
    nodes: twoNodes(),
    edges: [],
    onNodeClick: (id) => (clicked = id),
  });
  const nodeA = container.querySelector('.rq-canvas-host .rq-node');
  nodeA.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(clicked, 'a');

  clicked = null;
  container.querySelector('.rq-canvas-host').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(clicked, null, '点击节点之外不该触发 onNodeClick');
  api.destroy();
});

test('onNodeHover 在 mouseenter/mouseleave 时以 (id, isHover) 触发', () => {
  const events = [];
  const api = createMapCanvas(container, {
    nodes: twoNodes(),
    edges: [],
    onNodeHover: (id, isHover) => events.push([id, isHover]),
  });
  const nodeA = container.querySelector('.rq-canvas-host .rq-node');
  nodeA.dispatchEvent(new dom.window.MouseEvent('mouseenter'));
  nodeA.dispatchEvent(new dom.window.MouseEvent('mouseleave'));
  assert.deepEqual(events, [['a', true], ['a', false]]);
  api.destroy();
});

test('destroy 之后 window 级监听全部摘干净（add/remove 配平），重复 destroy 不抛错', () => {
  const added = new Set();
  const removed = new Set();
  const origAdd = dom.window.addEventListener.bind(dom.window);
  const origRemove = dom.window.removeEventListener.bind(dom.window);
  dom.window.addEventListener = (type, fn, opt) => {
    if (type === 'mousemove' || type === 'mouseup') added.add(fn);
    return origAdd(type, fn, opt);
  };
  dom.window.removeEventListener = (type, fn, opt) => {
    if (type === 'mousemove' || type === 'mouseup') removed.add(fn);
    return origRemove(type, fn, opt);
  };

  const api = createMapCanvas(container, { nodes: twoNodes(), edges: [] });
  api.destroy();

  dom.window.addEventListener = origAdd;
  dom.window.removeEventListener = origRemove;

  assert.ok(added.size > 0, '至少应该注册过 mousemove/mouseup（拖拽 + minimap 拖拽各一对）');
  assert.deepEqual(removed, added, 'destroy 应该把注册过的 window 级监听全部摘掉');
  assert.doesNotThrow(() => api.destroy());
});

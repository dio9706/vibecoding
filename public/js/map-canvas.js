/**
 * 通用地图画布内核 —— 节点定位、SVG 连线、缩放/平移、minimap 拖拽。
 *
 * 从 req-map.js（需求地图）里提炼出来，供「需求地图」「项目地图」等多套业务适配层复用。
 * 不认识 annots/flags/versions 这类业务概念：节点内容与样式全部靠 renderNode callback
 * 注入，本文件只管「画在哪、怎么缩放、怎么分发事件」。
 *
 * 边的高亮/淡出也走同一条路：调用方在 edge 对象上打 `state: 'hl' | 'dim'`，本文件只认
 * 这个字段决定 class 与箭头样式，不关心「为什么」（需求地图是「选中页面高亮其链路」，
 * 项目地图可能是别的语义）——业务判断留在适配层。
 *
 * 安全纪律：label 文案来自 LLM/业务数据，一律走 textContent，不拼 innerHTML。
 *
 * 已知耦合（留给 Task 9 项目地图适配层承接）：DOM class 名（rq-node、rq-canvas-host、
 * rq-minimap 系列、rq-edges、rq-arrow 系列、rq-elabel）沿用需求地图的既有命名，对应样式
 * 都写在 public/css/req-v2.css 里，没有拆成独立的 map-canvas.css。项目地图要复用这套
 * 画布，要么引入 req-v2.css 共用这些类名的样式，要么后续把这些类名做成可配置项——先不
 * 做是因为目前只有一个消费者，过早抽象配置项反而增加认知负担。
 */
import { viewportBox, panFromViewport } from './req-map-minimap.logic.js';

export const ZOOM_MIN = 0.35;
export const ZOOM_MAX = 1.8;

const CONTENT_PAD = 28; // 内容包围盒右/下留白，与 req-map-layout.logic.js 的 PAD 保持一致口径
const HORIZONTAL_EDGE_ANCHOR_Y = 34; // 同层横向连线的锚点纵向偏移，对齐卡片头部视觉中心

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/** 三次贝塞尔在 t 处的点，用于把连线标签放在曲线中段而不是几何中点（避免多条出边堆在一起）。 */
function bezierAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/**
 * @param {HTMLElement} container - 挂载容器，会被清空并接管
 * @param {object} opts
 * @param {Array<{id:string,x:number,y:number,width:number,height:number,data?:any}>} opts.nodes -
 *   width/height 必填：连线锚点、内容包围盒都从它们直接算，缺了就地退化成 0（连线会画歪，不抛错）。
 *   另有一条隐性排布契约：drawEdges() 按 `to.y > from.y` 判断连线是纵向（父→子）还是同层横向，
 *   前提是「同一层级的节点 y 完全相同、层级越深 y 越大」——这是 req-map-layout.logic.js 的排布
 *   不变量，不是本文件强制的规则。换一套不满足这个不变量的布局算法（比如自由拖拽定位、
 *   力导向布局），连线方向可能会画得不符合直觉，需要自行评估或改造这段判定逻辑。
 * @param {Array<{from:string,to:string,label?:string,state?:'hl'|'dim'}>} [opts.edges]
 * @param {(node:object, el:HTMLElement)=>void} [opts.renderNode] - 节点内容/样式注入点
 * @param {(nodeId:string)=>void} [opts.onNodeClick] - 点击节点整个区域触发（不区分点在卡片
 *   的哪个子区域）；适配层如果需要"卡片内某个子元素点击语义不同"（比如需求地图的逻辑点行
 *   要打开逻辑点详情而不是打开页面），在 renderNode 里给那个子元素的 click 加 stopPropagation。
 * @param {(nodeId:string, isHover:boolean)=>void} [opts.onNodeHover]
 * @param {{top?:number,bottom?:number}} [opts.fitInsets] - fitView 时给悬浮工具条/汇总条让出的空间
 */
export function createMapCanvas(container, opts) {
  const { renderNode, onNodeClick, onNodeHover, fitInsets = {} } = opts;
  const TOP_INSET = fitInsets.top || 0;
  const BOT_INSET = fitInsets.bottom || 0;

  const state = {
    nodes: opts.nodes || [],
    edges: opts.edges || [],
    zoom: 1,
    panX: 0,
    panY: 0,
    highlighted: null, // Set<id> | null
    minimapScale: 1,
    minimapAttached: false,
    onMinimapDrag: null,
  };

  container.innerHTML =
    '<div class="rq-minimap">' +
    '<div class="rq-minimap-content"></div>' +
    '<div class="rq-minimap-viewport"></div>' +
    '</div>' +
    '<div class="rq-canvas-host">' +
    '<div class="rq-canvas"><svg class="rq-edges"></svg><div class="rq-nodes"></div></div>' +
    '</div>';

  const host = container.querySelector('.rq-canvas-host');
  const canvas = container.querySelector('.rq-canvas');
  const svg = container.querySelector('.rq-edges');
  const nodesBox = container.querySelector('.rq-nodes');
  const minimap = container.querySelector('.rq-minimap');
  const mmContent = container.querySelector('.rq-minimap-content');
  const mmViewport = container.querySelector('.rq-minimap-viewport');

  /** 内容包围盒：取所有节点右/下边界的最大值，四周留白与 req-map-layout.logic 的口径一致。 */
  function contentSize() {
    let maxX = 0;
    let maxY = 0;
    for (const n of state.nodes) {
      maxX = Math.max(maxX, (n.x || 0) + (n.width || 0));
      maxY = Math.max(maxY, (n.y || 0) + (n.height || 0));
    }
    return { w: maxX + CONTENT_PAD, h: maxY + CONTENT_PAD };
  }

  function applyTransform() {
    canvas.style.transform = 'translate(' + state.panX + 'px,' + state.panY + 'px) scale(' + state.zoom + ')';
    updateMinimapViewport();
  }

  // ---------- 节点 ----------
  function applyHighlight() {
    for (const child of nodesBox.children) {
      if (!state.highlighted) {
        child.style.opacity = '';
        continue;
      }
      child.style.opacity = state.highlighted.has(child.dataset.nodeId) ? '' : '0.35';
    }
  }

  function renderNodes() {
    nodesBox.innerHTML = '';
    for (const node of state.nodes) {
      const nodeEl = document.createElement('div');
      nodeEl.className = 'rq-node';
      nodeEl.dataset.nodeId = node.id;
      nodeEl.style.left = (node.x || 0) + 'px';
      nodeEl.style.top = (node.y || 0) + 'px';
      if (node.width) nodeEl.style.width = node.width + 'px';
      renderNode?.(node, nodeEl);
      nodeEl.addEventListener('click', () => onNodeClick?.(node.id));
      nodeEl.addEventListener('mouseenter', () => onNodeHover?.(node.id, true));
      nodeEl.addEventListener('mouseleave', () => onNodeHover?.(node.id, false));
      nodesBox.appendChild(nodeEl);
    }
    applyHighlight();
  }

  // ---------- 连线 ----------
  function drawEdges() {
    const size = contentSize();
    svg.setAttribute('width', size.w);
    svg.setAttribute('height', size.h);
    canvas.style.width = size.w + 'px';
    canvas.style.height = size.h + 'px';

    // 两个 marker：常态 / 高亮。marker 内的 path 不能被 `.rq-edges > path` 的 fill:none 命中，
    // 所以边线样式要求用直接子选择器（消费方 CSS 需保持这个约束）。
    svg.innerHTML =
      '<defs>' +
      '<marker id="rq-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">' +
      '<path d="M0 0 L8 4 L0 8 z" class="rq-ahead"></path></marker>' +
      '<marker id="rq-arrow-hl" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">' +
      '<path d="M0 0 L8 4 L0 8 z" class="rq-ahead-hl"></path></marker>' +
      '</defs>';

    const NS = 'http://www.w3.org/2000/svg';
    const byId = new Map(state.nodes.map((n) => [n.id, n]));

    for (const e of state.edges) {
      const rawA = byId.get(e.from);
      const rawB = byId.get(e.to);
      if (!rawA || !rawB) continue; // 端点缺失（数据不一致）静默跳过，不因为脏数据整块画布挂掉
      // 缺 width/height 时退化成 0 而不是 NaN：宁可画出一条挤在一起的丑线，也不要整条 path 因
      // NaN 变成空字符串、无声无息地消失在 SVG 里（那样排查起来比丑线更折磨人）。
      const a = { x: rawA.x || 0, y: rawA.y || 0, width: rawA.width || 0, height: rawA.height || 0 };
      const b = { x: rawB.x || 0, y: rawB.y || 0, width: rawB.width || 0, height: rawB.height || 0 };

      let p1;
      let p2;
      let c1;
      let c2;
      // 走向按纵坐标判：b 明显更靠下才走纵向贝塞尔，否则按同层横向处理。
      // 不按 |dx| vs |dy| 判——hub 连最左侧子节点时 |dx| 可能大于 |dy|，按大小判会画出绕到侧面的怪线。
      // （此判定假设「同层节点 y 相同、层级越深 y 越大」，详见本文件顶部 opts.nodes 的说明）
      if (b.y > a.y) {
        p1 = { x: a.x + a.width / 2, y: a.y + a.height };
        p2 = { x: b.x + b.width / 2, y: b.y };
        const m = Math.max(30, Math.abs(p2.y - p1.y) / 2);
        c1 = { x: p1.x, y: p1.y + m };
        c2 = { x: p2.x, y: p2.y - m };
      } else {
        const rightward = b.x >= a.x;
        p1 = { x: rightward ? a.x + a.width : a.x, y: a.y + HORIZONTAL_EDGE_ANCHOR_Y };
        p2 = { x: rightward ? b.x : b.x + b.width, y: b.y + HORIZONTAL_EDGE_ANCHOR_Y };
        const m = Math.max(40, Math.abs(p2.x - p1.x) / 2) * (rightward ? 1 : -1);
        c1 = { x: p1.x + m, y: p1.y };
        c2 = { x: p2.x - m, y: p2.y };
      }

      const hl = e.state === 'hl';
      const path = document.createElementNS(NS, 'path');
      path.setAttribute(
        'd',
        'M' + p1.x + ' ' + p1.y + ' C' + c1.x + ' ' + c1.y + ' ' + c2.x + ' ' + c2.y + ' ' + p2.x + ' ' + p2.y,
      );
      path.setAttribute('data-from', e.from);
      path.setAttribute('data-to', e.to);
      if (e.state) path.setAttribute('class', e.state);
      path.setAttribute('marker-end', hl ? 'url(#rq-arrow-hl)' : 'url(#rq-arrow)');
      svg.appendChild(path);

      if (e.label) {
        // 标签落在 t≈0.75 而不是中点：hub 有多条出边时中点会全挤在同一处
        const q = bezierAt(p1, c1, c2, p2, 0.75);
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', q.x);
        t.setAttribute('y', q.y - 5);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'rq-elabel' + (e.state ? ' ' + e.state : ''));
        t.textContent = e.label;
        svg.appendChild(t);
      }
    }
  }

  // ---------- Minimap ----------
  function mmBox() {
    const size = contentSize();
    return viewportBox({
      panX: state.panX,
      panY: state.panY,
      zoom: state.zoom,
      hostW: host.clientWidth,
      hostH: host.clientHeight,
      contentW: size.w,
      contentH: size.h,
    });
  }

  function updateMinimapViewport() {
    const b = mmBox();
    state.minimapScale = b.scale;
    mmViewport.style.left = b.x + 'px';
    mmViewport.style.top = b.y + 'px';
    mmViewport.style.width = Math.max(0, b.w) + 'px';
    mmViewport.style.height = Math.max(0, b.h) + 'px';
  }

  function initMinimap() {
    mmContent.innerHTML = '';
    // 克隆体必须中和 transform：cloneNode 会把主画布的内联 translate/scale 一起带过来，
    // 外层再叠一次缩略比，缩略图就跟着主画布跑了。
    const clone = canvas.cloneNode(true);
    clone.style.transform = 'none';
    // 连 <defs> 一起克隆会让 marker id 在文档里重复一份；删掉后克隆体的 marker-end
    // 自然引用主画布那份（内容一模一样），少一处 id 撞车。
    clone.querySelector('defs')?.remove();
    mmContent.appendChild(clone);

    mmContent.style.transformOrigin = '0 0';
    const b = mmBox();
    state.minimapScale = b.scale;
    mmContent.style.transform = 'scale(' + b.scale + ')';
    updateMinimapViewport();

    if (!state.minimapAttached) {
      attachMinimapInteractions();
      state.minimapAttached = true;
    }
  }

  let mmDrag = null;
  const onMinimapMove = (e) => {
    if (!mmDrag) return;
    const p = panFromViewport({
      vx: mmDrag.vx + (e.clientX - mmDrag.x),
      vy: mmDrag.vy + (e.clientY - mmDrag.y),
      zoom: state.zoom,
      scale: state.minimapScale,
    });
    state.panX = p.panX;
    state.panY = p.panY;
    applyTransform();
    state.onMinimapDrag?.(mmDrag.x, mmDrag.y, e.clientX, e.clientY);
  };
  const onMinimapUp = () => {
    mmDrag = null;
    mmViewport.classList.remove('dragging');
  };

  function attachMinimapInteractions() {
    mmViewport.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      mmDrag = {
        x: e.clientX,
        y: e.clientY,
        vx: parseFloat(mmViewport.style.left) || 0,
        vy: parseFloat(mmViewport.style.top) || 0,
      };
      mmViewport.classList.add('dragging');
    });
    window.addEventListener('mousemove', onMinimapMove);
    window.addEventListener('mouseup', onMinimapUp);

    // 点击鸟瞰图空白处：把该点作为视口中心
    minimap.addEventListener('click', (e) => {
      if (e.target === mmViewport || mmViewport.contains(e.target)) return; // 框上的点击交给拖拽
      const rect = minimap.getBoundingClientRect();
      const b = mmBox();
      const p = panFromViewport({
        vx: e.clientX - rect.left - b.w / 2,
        vy: e.clientY - rect.top - b.h / 2,
        zoom: state.zoom,
        scale: b.scale,
      });
      state.panX = p.panX;
      state.panY = p.panY;
      applyTransform();
    });
  }

  // ---------- 画布拖拽 / 滚轮缩放 ----------
  let drag = null;
  const onHostDown = (e) => {
    if (e.target.closest('.rq-node')) return; // 节点内不触发平移，否则点不中节点内容
    drag = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
    host.classList.add('grabbing');
  };
  const onMove = (e) => {
    if (!drag) return;
    state.panX = drag.px + (e.clientX - drag.x);
    state.panY = drag.py + (e.clientY - drag.y);
    applyTransform();
  };
  const onUp = () => {
    drag = null;
    host.classList.remove('grabbing');
  };
  const onWheel = (e) => {
    e.preventDefault();
    state.zoom = clamp(state.zoom - Math.sign(e.deltaY) * 0.08, ZOOM_MIN, ZOOM_MAX);
    applyTransform();
  };
  host.addEventListener('mousedown', onHostDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  host.addEventListener('wheel', onWheel, { passive: false });

  // ---------- 对外 API ----------
  function setNodes(newNodes) {
    state.nodes = newNodes || [];
    renderNodes();
    drawEdges();
    initMinimap();
  }

  function setEdges(newEdges) {
    state.edges = newEdges || [];
    drawEdges();
    initMinimap();
  }

  function highlightNodes(ids) {
    state.highlighted = ids && ids.length ? new Set(ids) : null;
    applyHighlight();
  }

  function fitView() {
    const size = contentSize();
    const w = host.clientWidth || 1000;
    const h = host.clientHeight || 600;
    const usableH = Math.max(200, h - TOP_INSET - BOT_INSET);
    state.zoom = clamp(Math.min(1, Math.min((w - 40) / size.w, usableH / size.h)), ZOOM_MIN, ZOOM_MAX);
    state.panX = Math.max(0, (w - size.w * state.zoom) / 2);
    state.panY = TOP_INSET;
    applyTransform();
  }

  function zoom(factor) {
    state.zoom = clamp(state.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    applyTransform();
  }

  function pan(dx, dy) {
    state.panX += dx;
    state.panY += dy;
    applyTransform();
  }

  function getMinimapViewport() {
    const b = mmBox();
    return { x: b.x, y: b.y, width: Math.max(0, b.w), height: Math.max(0, b.h) };
  }

  function setMinimapViewportDrag(handler) {
    state.onMinimapDrag = handler || null;
  }

  function getScale() {
    return state.zoom;
  }

  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    host.removeEventListener('mousedown', onHostDown);
    host.removeEventListener('wheel', onWheel);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('mousemove', onMinimapMove);
    window.removeEventListener('mouseup', onMinimapUp);
    container.innerHTML = '';
  }

  renderNodes();
  drawEdges();
  initMinimap();

  return {
    setNodes,
    setEdges,
    highlightNodes,
    fitView,
    zoom,
    pan,
    getMinimapViewport,
    setMinimapViewportDrag,
    destroy,
    getScale,
  };
}

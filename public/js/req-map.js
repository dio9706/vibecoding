/**
 * 需求地图视图 —— 页面为节点、逻辑点挂节点内、连线为页面跳转的流程画布。
 *
 * 一个挂载函数两处复用：评审期内嵌进 #reqPage 的报告页签，开发期从右栏以浮层打开。
 * 坐标不来自后端也不来自 LLM，由 req-map-layout.logic.js 现算（见 spec §3.1）。
 *
 * 安全纪律：pages/points 的文案全部来自 LLM 输出，一律走 textContent 落地，
 * 不用 innerHTML 拼接——骨架用 innerHTML，数据用 DOM API。
 */
import { layoutMap } from './req-map-layout.logic.js';
import { viewportBox, panFromViewport } from './req-map-minimap.logic.js';

const SYM = { add: '＋', mod: '~', del: '－' };
const TYPE_CN = { add: '新增逻辑点', mod: '修改逻辑点', del: '删除逻辑点' };
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 1.8;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** 三次贝塞尔在 t 处的点。只有连线标签定位这一个消费者，所以不单独开 logic 文件。 */
function bezierAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/**
 * @param {HTMLElement} container - 挂载容器（会被清空）
 * @param {object} opts
 * @param {string} opts.reqId
 * @param {string} opts.phase - 'review' 时可标注并提交修订；其余阶段只读浏览（挂设计稿/还原仍可用）
 * @param {object} opts.map - 地图 JSON（含 annots）
 * @param {Array}  opts.versions - [{v, at}]
 * @param {number} [opts.version] - 当前展示的版本号
 * @param {Function} [opts.onReload] - 需要重新拉取需求（提交修订后）时调用
 * @param {Function} [opts.onRestore] - 触发 UI 还原时调用，参数为后端返回的 prompt
 */
export function mountMap(container, opts) {
  const { reqId, phase, map, versions = [], version = null, onReload, onRestore } = opts;
  const canAnnotate = phase === 'review';

  const state = {
    filters: { add: true, mod: true, del: true, flag: false },
    sel: null, // { kind:'point'|'page', id }
    zoom: 1,
    panX: 0,
    panY: 0,
    annots: { ...(map.annots || {}) },
    saveTimer: null,
    minimapScale: 1,                    // 鸟瞰图缩略比，由 viewportBox 算出后缓存给拖拽用
    minimapInteractionsAttached: false, // window 级监听只绑一次
  };

  container.innerHTML =
    '<div class="rq-map">' +
    '<div class="rq-tools">' +
    '<span class="rq-tip-icon" title="鼠标滚轮缩放">🔍</span>' +
    '<button class="rq-fchip rq-f-add on" data-f="add">＋ 新增 <b>0</b></button>' +
    '<button class="rq-fchip rq-f-mod on" data-f="mod">~ 修改 <b>0</b></button>' +
    '<button class="rq-fchip rq-f-del on" data-f="del">－ 删除 <b>0</b></button>' +
    '<span class="rq-sep"></span>' +
    '<button class="rq-fchip rq-f-flag" data-f="flag">⚑ 仅看已标注</button>' +
    '<span class="rq-sep"></span>' +
    '<span class="rq-zoom"><button class="rq-z-out">−</button><i class="rq-z-val">100%</i>' +
    '<button class="rq-z-in">＋</button><button class="rq-z-fit">适应</button></span>' +
    '<span class="rq-ver"></span>' +
    '</div>' +
    '<div class="rq-minimap">' +
    '<div class="rq-minimap-content"></div>' +
    '<div class="rq-minimap-viewport"></div>' +
    '</div>' +
    '<div class="rq-canvas-host">' +
    '<div class="rq-canvas"><svg class="rq-edges"></svg><div class="rq-nodes"></div></div>' +
    '</div>' +
    '<div class="rq-foot" hidden><span class="rq-annot-sum"></span>' +
    '<button class="btn primary rq-submit" disabled>提交标注，AI 修订</button></div>' +
    '<div class="rq-drawer" hidden><div class="rq-dhead"><div class="rq-dt">' +
    '<h4></h4><span class="rq-dtype"></span></div>' +
    '<button class="btn rq-dclose">✕</button></div><div class="rq-dbody"></div></div>' +
    '</div>';

  const root = container.querySelector('.rq-map');
  const host = root.querySelector('.rq-canvas-host');
  const canvas = root.querySelector('.rq-canvas');
  const svg = root.querySelector('.rq-edges');
  const nodesBox = root.querySelector('.rq-nodes');
  const drawer = root.querySelector('.rq-drawer');
  const dBody = root.querySelector('.rq-dbody');
  const foot = root.querySelector('.rq-foot');

  let layout = layoutMap(map);

  // ---------- Minimap ----------
  let mmDrag = null; // Minimap 拖拽状态

  /** 当前视口在鸟瞰图坐标系里的框（含缩略比）。三处消费者共用，避免尺寸常量到处硬编码。 */
  function mmBox() {
    return viewportBox({
      panX: state.panX,
      panY: state.panY,
      zoom: state.zoom,
      hostW: host.clientWidth,
      hostH: host.clientHeight,
      contentW: layout.size.w,
      contentH: layout.size.h,
    });
  }

  function initMinimap() {
    const mmContent = root.querySelector('.rq-minimap-content');
    mmContent.innerHTML = '';

    // 克隆体必须中和 transform：cloneNode 会把主画布的内联 translate/scale 一起带过来，
    // 外层再叠一次缩略比，缩略图就跟着主画布跑了（原 bug：鸟瞰图里内容被推出可视区）。
    const canvasClone = canvas.cloneNode(true);
    canvasClone.style.transform = 'none';
    // 连 <defs> 一起克隆会让 marker id 在文档里重复一份；删掉后克隆体的 marker-end
    // 自然引用主画布那份（内容一模一样），少一处 id 撞车。
    canvasClone.querySelector('defs')?.remove();
    mmContent.appendChild(canvasClone);

    // 以左上角为基准缩放，避免默认居中缩放把内容顶出可视区
    mmContent.style.transformOrigin = '0 0';
    const b = mmBox();
    state.minimapScale = b.scale;
    mmContent.style.transform = 'scale(' + b.scale + ')';

    updateMinimapViewport();

    // 只在首次绑定，避免浮层反复开关后堆积 window 级监听
    if (!state.minimapInteractionsAttached) {
      attachMinimapInteractions();
      state.minimapInteractionsAttached = true;
    }
  }

  function updateMinimapViewport() {
    const vp = root.querySelector('.rq-minimap-viewport');
    const b = mmBox();
    state.minimapScale = b.scale;
    vp.style.left = b.x + 'px';
    vp.style.top = b.y + 'px';
    vp.style.width = Math.max(0, b.w) + 'px';
    vp.style.height = Math.max(0, b.h) + 'px';
  }

  function attachMinimapInteractions() {
    const minimap = root.querySelector('.rq-minimap');
    const mmViewport = root.querySelector('.rq-minimap-viewport');

    // ---- 拖拽视口框 ----
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

    const onMinimapMove = (e) => {
      if (!mmDrag) return;
      // 反推 pan 走 panFromViewport：这里原先是 panX = vx / scale（正相关且漏了 zoom），
      // 所以「视口框往右拖，画面往左滚」。互逆关系由 req-map-minimap.logic 的单测兜着。
      const p = panFromViewport({
        vx: mmDrag.vx + (e.clientX - mmDrag.x),
        vy: mmDrag.vy + (e.clientY - mmDrag.y),
        zoom: state.zoom,
        scale: state.minimapScale,
      });
      state.panX = p.panX;
      state.panY = p.panY;
      applyTransform(); // 内部会调 updateMinimapViewport()
    };

    const onMinimapUp = () => {
      mmDrag = null;
      mmViewport.classList.remove('dragging');
    };

    window.addEventListener('mousemove', onMinimapMove);
    window.addEventListener('mouseup', onMinimapUp);

    // ---- 点击鸟瞰图空白处：把该点作为视口中心 ----
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

  // ---------- 版本切换 ----------
  if (versions.length > 1) {
    const box = root.querySelector('.rq-ver');
    const cur = version ?? versions[versions.length - 1].v;
    for (const vi of versions) {
      const b = el('button', 'rq-vbtn' + (vi.v === cur ? ' on' : ''), 'v' + vi.v);
      b.addEventListener('click', () => {
        if (vi.v === cur) return;
        loadVersion(vi.v);
      });
      box.appendChild(b);
    }
  }

  async function loadVersion(v) {
    try {
      const r = await fetch('/api/req/map?id=' + encodeURIComponent(reqId) + '&v=' + v);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '读取失败');
      mountMap(container, { ...opts, map: d.map, versions: d.versions, version: v });
    } catch (e) {
      window.toast.error('切换版本失败：' + (e?.message || e));
    }
  }

  // ---------- 筛选 ----------
  root.querySelectorAll('.rq-fchip').forEach((b) =>
    b.addEventListener('click', () => {
      const f = b.dataset.f;
      state.filters[f] = !state.filters[f];
      b.classList.toggle('on', state.filters[f]);
      renderNodes();
    }),
  );

  function visiblePoints(page) {
    return (page.points || []).filter((pt) => {
      if (state.filters.flag && !state.annots[pt.id]) return false;
      return state.filters[pt.type];
    });
  }

  // ---------- 画布 ----------
  function applyTransform() {
    canvas.style.transform =
      'translate(' + state.panX + 'px,' + state.panY + 'px) scale(' + state.zoom + ')';
    root.querySelector('.rq-z-val').textContent = Math.round(state.zoom * 100) + '%';
    updateMinimapViewport();
  }
  // 工具条与标注汇总条都是浮在画布上的，「适应」时要把它们的高度让出来，
  // 否则第一层节点会被工具条压住（缩得越小压得越狠）
  const TOP_INSET = 52;
  const BOT_INSET = 70;
  function fitView() {
    const w = host.clientWidth || 1000;
    const h = host.clientHeight || 600;
    const usableH = Math.max(200, h - TOP_INSET - BOT_INSET);
    state.zoom = Math.max(ZOOM_MIN, Math.min(1, Math.min((w - 40) / layout.size.w, usableH / layout.size.h)));
    state.panX = Math.max(0, (w - layout.size.w * state.zoom) / 2);
    state.panY = TOP_INSET;
    applyTransform(); // 内部已含 updateMinimapViewport()
  }
  root.querySelector('.rq-z-in').addEventListener('click', () => {
    state.zoom = Math.min(ZOOM_MAX, state.zoom + 0.1);
    applyTransform();
  });
  root.querySelector('.rq-z-out').addEventListener('click', () => {
    state.zoom = Math.max(ZOOM_MIN, state.zoom - 0.1);
    applyTransform();
  });
  root.querySelector('.rq-z-fit').addEventListener('click', fitView);

  let drag = null;
  // 监听在 host 而非 canvas：缩放后 canvas 视觉尺寸缩小，
  // host 背景（点网格）区域应同样可拖拽，不能只绑在 canvas 上
  host.addEventListener('mousedown', (e) => {
    if (e.target.closest('.rq-node')) return; // 节点内不触发平移，否则点不中逻辑点
    drag = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
    host.classList.add('grabbing');
  });
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
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  host.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.zoom - Math.sign(e.deltaY) * 0.08));
      applyTransform();
      // applyTransform() 内部已包含 updateMinimapViewport() 调用
    },
    { passive: false },
  );
  // 容器被移除时收掉 window 级监听，避免浮层反复开关后堆积
  const cleanup = new MutationObserver(() => {
    if (!document.body.contains(container)) {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      cleanup.disconnect();
    }
  });
  cleanup.observe(document.body, { childList: true, subtree: true });

  // ---------- 节点 ----------
  function renderNodes() {
    nodesBox.innerHTML = '';
    const entrySet = new Set(layout.entries || []);
    for (const page of map.pages) {
      const pts = visiblePoints(page);
      const counts = { add: 0, mod: 0, del: 0 };
      for (const pt of page.points || []) counts[pt.type]++;
      const untouched = page.state === 'untouched';
      const dimmed = !untouched && (page.points || []).length && !pts.length;

      const node = el('div', 'rq-node');
      if (page.state === 'new') node.classList.add('rq-newpage');
      if (untouched || dimmed) node.classList.add('rq-untouched');
      if (state.sel?.kind === 'page' && state.sel.id === page.id) node.classList.add('sel');
      const pos = layout.positions[page.id] || { x: 0, y: 0 };
      node.style.left = pos.x + 'px';
      node.style.top = pos.y + 'px';

      const head = el('div', 'rq-nhead');
      const top = el('div', 'rq-ntop');
      top.appendChild(el('span', 'rq-nname', page.name));
      // 「入口」放在最前：先告诉用户从哪进来，再说这页是新增还是有稿
      if (entrySet.has(page.id)) top.appendChild(el('span', 'rq-nflag rq-entry', '入口'));
      if (page.state === 'new') top.appendChild(el('span', 'rq-nflag', '新页面'));
      if (page.figma) top.appendChild(el('span', 'rq-nflag rq-figma', page.restoredAt ? '🎨 已还原' : '🎨 已挂稿'));
      head.appendChild(top);
      head.appendChild(el('div', 'rq-nfile', page.file || '—'));
      const cnt = el('div', 'rq-ncount');
      if (counts.add) cnt.appendChild(el('i', 'rq-add', '＋' + counts.add));
      if (counts.mod) cnt.appendChild(el('i', 'rq-mod', '~' + counts.mod));
      if (counts.del) cnt.appendChild(el('i', 'rq-del', '－' + counts.del));
      if (!(page.points || []).length) cnt.appendChild(el('i', 'rq-none', '未变更'));
      head.appendChild(cnt);
      head.addEventListener('click', () => openPage(page.id));
      node.appendChild(head);

      if ((page.points || []).length) {
        const box = el('div', 'rq-npts');
        if (!pts.length) box.appendChild(el('div', 'rq-nempty', '当前筛选下无逻辑点'));
        for (const pt of pts) {
          const row = el('div', 'rq-pt rq-' + pt.type);
          if (state.sel?.kind === 'point' && state.sel.id === pt.id) row.classList.add('sel');
          if (pt.fresh) row.classList.add('fresh');
          row.appendChild(el('span', 'rq-sym rq-' + pt.type, SYM[pt.type]));
          row.appendChild(el('span', 'rq-t', pt.title));
          const a = state.annots[pt.id];
          if (a) row.appendChild(el('span', 'rq-mk rq-' + (a.verdict === 'wrong' ? 'wrong' : 'ok'), a.verdict === 'wrong' ? '⚑' : '✓'));
          row.addEventListener('click', () => openPoint(pt.id));
          box.appendChild(row);
        }
        node.appendChild(box);
      } else {
        node.appendChild(el('div', 'rq-nempty', '本次需求不涉及改动，仅作跳转参考'));
      }
      nodesBox.appendChild(node);
    }

    const all = { add: 0, mod: 0, del: 0 };
    for (const p of map.pages) for (const pt of p.points || []) all[pt.type]++;
    const chips = root.querySelectorAll('.rq-fchip b');
    if (chips[0]) chips[0].textContent = all.add;
    if (chips[1]) chips[1].textContent = all.mod;
    if (chips[2]) chips[2].textContent = all.del;

    canvas.style.width = layout.size.w + 'px';
    canvas.style.height = layout.size.h + 'px';
    drawEdges();
    initMinimap(); // 每次节点重绘后同步 Minimap
  }

  function drawEdges() {
    svg.setAttribute('width', layout.size.w);
    svg.setAttribute('height', layout.size.h);
    // 两个 marker：常态 / 高亮。marker 内的 path 不能被 `.rq-edges > path` 的 fill:none 命中，
    // 所以边线样式用直接子选择器，见 req-v2.css。
    svg.innerHTML =
      '<defs>' +
      '<marker id="rq-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">' +
      '<path d="M0 0 L8 4 L0 8 z" class="rq-ahead"></path></marker>' +
      '<marker id="rq-arrow-hl" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">' +
      '<path d="M0 0 L8 4 L0 8 z" class="rq-ahead-hl"></path></marker>' +
      '</defs>';

    const NS = 'http://www.w3.org/2000/svg';
    const layerOf = layout.layerOf || new Map();
    const selPage = state.sel?.kind === 'page' ? state.sel.id : null;

    for (const e of map.edges || []) {
      const a = layout.positions[e.from];
      const b = layout.positions[e.to];
      if (!a || !b) continue;
      const w = layout.nodeW;

      // 走向按**层级关系**判，不按 |dx| vs |dy|：hub 连最左侧子页时 |dx| 会大于 |dy|，
      // 按大小判会误判成横向，画出一条绕到侧面的怪线。
      let p1;
      let p2;
      let c1;
      let c2;
      if ((layerOf.get(e.to) ?? 0) > (layerOf.get(e.from) ?? 0)) {
        // 纵向：下沿 → 上沿
        p1 = { x: a.x + w / 2, y: a.y + a.h };
        p2 = { x: b.x + w / 2, y: b.y };
        const m = Math.max(30, Math.abs(p2.y - p1.y) / 2);
        c1 = { x: p1.x, y: p1.y + m };
        c2 = { x: p2.x, y: p2.y - m };
      } else {
        // 同层横向。目标在左时要从左沿出、右沿进，否则线会从节点内部穿出去。
        const rightward = b.x >= a.x;
        p1 = { x: rightward ? a.x + w : a.x, y: a.y + 34 };
        p2 = { x: rightward ? b.x : b.x + w, y: b.y + 34 };
        const m = Math.max(40, Math.abs(p2.x - p1.x) / 2) * (rightward ? 1 : -1);
        c1 = { x: p1.x + m, y: p1.y };
        c2 = { x: p2.x - m, y: p2.y };
      }

      const hit = !!selPage && (e.from === selPage || e.to === selPage);
      const path = document.createElementNS(NS, 'path');
      path.setAttribute(
        'd',
        'M' + p1.x + ' ' + p1.y + ' C' + c1.x + ' ' + c1.y + ' ' + c2.x + ' ' + c2.y + ' ' + p2.x + ' ' + p2.y,
      );
      path.setAttribute('data-from', e.from);
      path.setAttribute('data-to', e.to);
      if (selPage) path.setAttribute('class', hit ? 'hl' : 'dim');
      path.setAttribute('marker-end', hit ? 'url(#rq-arrow-hl)' : 'url(#rq-arrow)');
      svg.appendChild(path);

      if (e.label) {
        // 标签从中点挪到贴近目标端（t≈0.75）：hub 有多条出边时，中点会全挤在同一处
        const q = bezierAt(p1, c1, c2, p2, 0.75);
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', q.x);
        t.setAttribute('y', q.y - 5);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'rq-elabel' + (selPage ? (hit ? ' hl' : ' dim') : ''));
        t.textContent = e.label;
        svg.appendChild(t);
      }
    }
  }

  // ---------- 抽屉 ----------
  /** 抽屉开合要同步给根节点：底部标注汇总条是居中定位的，抽屉一开就会被压住，靠 CSS 左移让开 */
  function setDrawerOpen(open) {
    drawer.hidden = !open;
    root.classList.toggle('rq-drawer-open', open);
  }
  function closeDrawer() {
    setDrawerOpen(false);
    state.sel = null;
    renderNodes();
  }
  root.querySelector('.rq-dclose').addEventListener('click', closeDrawer);

  function findPoint(id) {
    for (const p of map.pages) {
      const pt = (p.points || []).find((x) => x.id === id);
      if (pt) return { page: p, pt };
    }
    return null;
  }

  function section(label) {
    const s = el('div', 'rq-sec');
    s.appendChild(el('div', 'rq-lb', label));
    return s;
  }

  function openPoint(id) {
    const hit = findPoint(id);
    if (!hit) return;
    const { page, pt } = hit;
    state.sel = { kind: 'point', id };
    renderNodes();
    root.querySelector('.rq-dhead h4').textContent = pt.title;
    const type = root.querySelector('.rq-dtype');
    type.className = 'rq-dtype rq-' + pt.type;
    type.textContent = TYPE_CN[pt.type] + ' · ' + page.name;

    dBody.innerHTML = '';
    const ba = section('前后对照');
    const baBox = el('div', 'rq-ba');
    const before = el('div', 'rq-row rq-before');
    before.appendChild(el('div', 'rq-rl', '变更前'));
    before.appendChild(el('div', null, pt.before));
    const after = el('div', 'rq-row rq-after');
    after.appendChild(el('div', 'rq-rl', '变更后'));
    after.appendChild(el('div', null, pt.after));
    baBox.append(before, after);
    ba.appendChild(baBox);
    dBody.appendChild(ba);

    if ((pt.src || []).length) {
      const s = section('依据来源');
      const box = el('div', 'rq-src');
      for (const x of pt.src) box.appendChild(el('span', null, x));
      s.appendChild(box);
      dBody.appendChild(s);
    }
    if ((pt.files || []).length) {
      const s = section('影响文件');
      const box = el('div', 'rq-files');
      for (const f of pt.files) box.appendChild(el('span', null, f));
      s.appendChild(box);
      dBody.appendChild(s);
    }

    if (canAnnotate) {
      const a = state.annots[id] || { verdict: null, text: '' };
      const s = section('我的标注');
      s.classList.add('rq-annot');
      const ta = el('textarea');
      ta.placeholder = '这里理解错了 / 漏了什么，直接写。攒够一起提交，AI 一次性修订。';
      ta.value = a.text || '';
      const acts = el('div', 'rq-acts');
      const wrong = el('button', 'btn rq-wrong' + (a.verdict === 'wrong' ? ' on' : ''), '⚑ 标记有误');
      const ok = el('button', 'btn rq-okmark' + (a.verdict === 'ok' ? ' on' : ''), '✓ 确认无误');
      wrong.addEventListener('click', () => setAnnot(id, 'wrong', ta.value));
      ok.addEventListener('click', () => setAnnot(id, 'ok', ta.value));
      acts.append(wrong, ok);
      s.append(ta, acts);
      dBody.appendChild(s);
    }
    setDrawerOpen(true);
  }

  function setAnnot(id, verdict, text) {
    const body = String(text || '').trim();
    if (verdict === 'wrong' && !body) {
      window.toast.error('标记有误需要写一句为什么');
      return;
    }
    if (state.annots[id]?.verdict === verdict) delete state.annots[id];
    else state.annots[id] = { verdict, text: body };
    saveAnnots();
    openPoint(id);
    updateFoot();
  }

  /** 标注防抖落盘：用户连点几处不必打几次请求，但刷新页面不能丢。 */
  function saveAnnots() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      try {
        await fetch('/api/req/map/annots', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: reqId, annots: state.annots }),
        });
      } catch {
        window.toast.error('标注保存失败，请检查网络');
      }
    }, 600);
  }

  function openPage(id) {
    const page = map.pages.find((p) => p.id === id);
    if (!page) return;
    state.sel = { kind: 'page', id };
    renderNodes();
    root.querySelector('.rq-dhead h4').textContent = page.name;
    const type = root.querySelector('.rq-dtype');
    type.className = 'rq-dtype rq-page';
    type.textContent =
      page.state === 'new' ? '新增页面' : page.state === 'untouched' ? '未变更 · 仅跳转参考' : '存量页面 · 有改动';

    dBody.innerHTML = '';
    const f = section('文件');
    const fb = el('div', 'rq-files');
    fb.appendChild(el('span', null, page.file || '（未定位）'));
    f.appendChild(fb);
    dBody.appendChild(f);

    dBody.appendChild(buildFigmaSection(page));

    const edges = map.edges || [];
    dBody.appendChild(
      buildLinkSection('从哪来', edges.filter((e) => e.to === id).map((e) => ({ pid: e.from, label: e.label }))),
    );
    dBody.appendChild(
      buildLinkSection('去哪', edges.filter((e) => e.from === id).map((e) => ({ pid: e.to, label: e.label }))),
    );

    const ps = section('本页逻辑点 ' + (page.points || []).length);
    const list = el('div', 'rq-jump');
    for (const pt of page.points || []) {
      const row = el('div', 'rq-jump-item');
      row.appendChild(el('i', 'rq-sym rq-' + pt.type, SYM[pt.type]));
      row.appendChild(el('span', null, pt.title));
      row.addEventListener('click', () => openPoint(pt.id));
      list.appendChild(row);
    }
    if (!(page.points || []).length) list.appendChild(el('div', 'rq-nempty', '无'));
    ps.appendChild(list);
    dBody.appendChild(ps);
    setDrawerOpen(true);
  }

  /**
   * 上下游页面列表。链路是给非技术人员看的，所以行文本是「页面名 · 跳转动作」而不是 id。
   * 点击切到目标页抽屉，顺带把画布高亮也带过去（openPage 会重绘连线）。
   */
  function buildLinkSection(label, items) {
    const s = section(label);
    const list = el('div', 'rq-jump');
    for (const it of items) {
      const target = map.pages.find((p) => p.id === it.pid);
      if (!target) continue;
      const row = el('div', 'rq-jump-item');
      row.appendChild(el('span', null, target.name));
      if (it.label) row.appendChild(el('i', 'rq-elink', '· ' + it.label));
      row.addEventListener('click', () => openPage(target.id));
      list.appendChild(row);
    }
    if (!list.childElementCount) list.appendChild(el('div', 'rq-nempty', '无'));
    s.appendChild(list);
    return s;
  }

  function buildFigmaSection(page) {
    const s = section('UI 设计稿');
    if (!page.figma) {
      const row = el('div', 'rq-figrow');
      const input = el('input');
      input.placeholder = '粘贴 Figma 链接（可稍后补）';
      const add = el('button', 'btn primary', '挂载');
      add.addEventListener('click', () => saveFigma(page, input.value.trim()));
      row.append(input, add);
      s.appendChild(row);
      s.appendChild(el('div', 'rq-tip', '没有设计稿时先按需求地图搭骨架；设计稿到位后回这里挂载，再触发一次 UI 还原。'));
      return s;
    }
    const card = el('div', 'rq-figcard');
    const head = el('div', 'rq-fh');
    head.appendChild(el('span', 'rq-ok', '✓'));
    head.appendChild(el('span', 'rq-furl', page.figma.url));
    card.appendChild(head);
    const body = el('div', 'rq-fb');
    if (page.restoredAt) body.appendChild(el('div', 'rq-restored', '已触发还原 · ' + page.restoredAt.slice(0, 16).replace('T', ' ')));
    const acts = el('div', 'rq-facts');
    const go = el('button', 'btn primary', page.restoredAt ? '再还原一次' : '按 UI 规范还原此页 →');
    go.addEventListener('click', () => doRestore(page, go));
    const unlink = el('button', 'btn', '解绑');
    unlink.addEventListener('click', () => saveFigma(page, ''));
    acts.append(go, unlink);
    body.appendChild(acts);
    card.appendChild(body);
    s.appendChild(card);
    return s;
  }

  async function saveFigma(page, url) {
    try {
      const r = await fetch('/api/req/map/figma', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId, pageId: page.id, url, node: '' }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '保存失败');
      page.figma = d.page.figma;
      page.restoredAt = d.page.restoredAt;
      openPage(page.id);
      window.toast.success(url ? '已挂载设计稿' : '已解绑');
    } catch (e) {
      window.toast.error('设计稿保存失败：' + (e?.message || e));
    }
  }

  async function doRestore(page, btn) {
    btn.disabled = true;
    try {
      const r = await fetch('/api/req/map/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId, pageId: page.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '触发失败');
      page.restoredAt = new Date().toISOString();
      openPage(page.id);
      if (!d.hasSpec) window.toast.error('本项目还没配 UI 规范，已按现有代码风格还原');
      onRestore?.(d.prompt);
    } catch (e) {
      window.toast.error('触发还原失败：' + (e?.message || e));
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 底部标注汇总 ----------
  function updateFoot() {
    if (!canAnnotate) return;
    foot.hidden = false;
    const list = Object.values(state.annots);
    const wrong = list.filter((a) => a.verdict === 'wrong').length;
    const sum = root.querySelector('.rq-annot-sum');
    sum.textContent = list.length
      ? '已标注 ' + list.length + ' 条 · ' + wrong + ' 有误 / ' + (list.length - wrong) + ' 无误'
      : '点逻辑点写标注 · 攒够一起提交';
    root.querySelector('.rq-submit').disabled = wrong === 0;
  }

  if (canAnnotate) {
    root.querySelector('.rq-submit').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '提交中…';
      try {
        // 先把标注同步落盘再提交：防抖窗口内点提交会让服务端读到旧标注
        clearTimeout(state.saveTimer);
        await fetch('/api/req/map/annots', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: reqId, annots: state.annots }),
        });
        const r = await fetch('/api/req/map/annotate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: reqId }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || '提交失败');
        window.toast.success('已提交 · AI 正在修订需求地图');
        onReload?.();
      } catch (err) {
        window.toast.error('提交修订失败：' + (err?.message || err));
        btn.disabled = false;
        btn.textContent = '提交标注，AI 修订';
      }
    });
  }

  document.addEventListener('keydown', function onEsc(e) {
    if (!document.body.contains(container)) {
      document.removeEventListener('keydown', onEsc);
      return;
    }
    if (e.key === 'Escape' && !drawer.hidden) closeDrawer();
  });

  renderNodes();
  updateFoot();
  requestAnimationFrame(fitView);
}

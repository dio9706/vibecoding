/**
 * 需求地图视图 —— 需求地图业务适配层：页面为节点、逻辑点挂节点内、连线为页面跳转。
 *
 * 一个挂载函数两处复用：评审期内嵌进 #reqPage 的报告页签，开发期从右栏以浮层打开。
 * 坐标不来自后端也不来自 LLM，由 req-map-layout.logic.js 现算（见 spec §3.1）。
 * 缩放/平移/minimap/连线绘制这些与需求业务无关的通用画布能力，都下沉到
 * map-canvas.js（Task 8 提炼），本文件只负责：把 pages 铺成 node、渲染页面卡片/
 * 逻辑点徽章、绑定点击打开详情抽屉、以及「版本选择」「重新生成」「提交标注」
 * 这类需求地图特有的业务逻辑。
 *
 * 安全纪律：pages/points 的文案全部来自 LLM 输出，一律走 textContent 落地，
 * 不用 innerHTML 拼接——骨架用 innerHTML，数据用 DOM API。
 */
import { layoutMap } from './req-map-layout.logic.js';
import { createMapCanvas } from './map-canvas.js';
import { confirmDialog } from './ui.js';

const SYM = { add: '＋', mod: '~', del: '－' };
const TYPE_CN = { add: '新增逻辑点', mod: '修改逻辑点', del: '删除逻辑点' };

// 工具条与标注汇总条都是浮在画布上的，「适应」时要把它们的高度让出来，
// 否则第一层节点会被工具条压住（缩得越小压得越狠）。交给 map-canvas 的 fitInsets。
const TOP_INSET = 52;
const BOT_INSET = 70;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * @param {HTMLElement} container - 挂载容器（会被清空）
 * @param {object} opts
 * @param {string} opts.reqId
 * @param {string} opts.phase - 'review' 时可标注并提交修订；其余阶段只读浏览（挂设计稿/还原仍可用）
 * @param {object} opts.map - 地图 JSON（含 annots）
 * @param {Array}  opts.versions - [{v, at}]
 * @param {number} [opts.version] - 当前展示的版本号
 * @param {object|null} [opts.busy] - 需求当前的 busy（非空则禁用「重新生成」）。不传时靠后端 409 兜底
 * @param {Function} [opts.onReload] - 需要重新拉取需求（提交修订后）时调用
 * @param {Function} [opts.onRestore] - 触发 UI 还原时调用，参数为后端返回的 prompt
 * @param {Function} [opts.onRegen] - 触发重新生成成功后的收尾。不复用 onReload：
 *   评审期只需刷新页面，开发期还要关掉浮层并重挂横幅以启动 busy 轮询，两处动作不同
 */
export function mountMap(container, opts) {
  const { reqId, phase, map, versions = [], version = null, busy = null, onReload, onRestore, onRegen } = opts;
  const canAnnotate = phase === 'review';

  // 容器复用挂载（版本切换会对同一个 container 再调一次 mountMap）：
  // 旧实例的 window/document 级监听不会因为 innerHTML 被覆盖而自动解绑，必须先手动清掉，
  // 否则每切一次版本就多攒一份指向旧 DOM/旧 map 数据的监听，越切越漏。
  container.__reqMapCanvas?.destroy?.();
  container.__reqMapCanvas = null;
  document.removeEventListener('keydown', container.__reqMapEsc || (() => {}));
  container.__reqMapEsc = null;

  const state = {
    filters: { add: true, mod: true, del: true, flag: false },
    sel: null, // { kind:'point'|'page', id }
    annots: { ...(map.annots || {}) },
    saveTimer: null,
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
    '<button class="rq-regen" title="以当前代码实现为准，重新扫一遍出新版地图">↻ 重新生成</button>' +
    '<span class="rq-ver"></span>' +
    '</div>' +
    '<div class="rq-canvas-mount"></div>' +
    '<div class="rq-foot" hidden><span class="rq-annot-sum"></span>' +
    '<button class="btn primary rq-submit" disabled>提交标注，AI 修订</button></div>' +
    '<div class="rq-drawer" hidden><div class="rq-dhead"><div class="rq-dt">' +
    '<h4></h4><span class="rq-dtype"></span></div>' +
    '<button class="btn rq-dclose">✕</button></div><div class="rq-dbody"></div></div>' +
    '</div>';

  const root = container.querySelector('.rq-map');
  const drawer = root.querySelector('.rq-drawer');
  const dBody = root.querySelector('.rq-dbody');
  const foot = root.querySelector('.rq-foot');

  const layout = layoutMap(map);

  // ---------- 画布 ----------
  const mapCanvas = createMapCanvas(root.querySelector('.rq-canvas-mount'), {
    nodes: [],
    edges: [],
    renderNode: renderPageNode,
    onNodeClick: (id) => openPage(id),
    onNodeHover: (id, isHover) => onNodeHover(id, isHover),
    fitInsets: { top: TOP_INSET, bottom: BOT_INSET },
  });
  container.__reqMapCanvas = mapCanvas;

  function visiblePoints(page) {
    return (page.points || []).filter((pt) => {
      if (state.filters.flag && !state.annots[pt.id]) return false;
      return state.filters[pt.type];
    });
  }

  /** pages → map-canvas 认识的 node 结构，坐标全部来自 layoutMap，本层不再自己算。 */
  function buildNodes() {
    const entrySet = new Set(layout.entries || []);
    return map.pages.map((page) => {
      const pos = layout.positions[page.id] || { x: 0, y: 0, h: 0 };
      return {
        id: page.id,
        x: pos.x,
        y: pos.y,
        width: layout.nodeW,
        height: pos.h,
        data: { page, isEntry: entrySet.has(page.id) },
      };
    });
  }

  /** 以某页为中心：它相连的边高亮、其余淡出。pageId 为空时不给任何 state（边恢复常态）。 */
  function edgesHighlightedAround(pageId) {
    return (map.edges || []).map((e) => {
      if (!pageId) return { from: e.from, to: e.to, label: e.label };
      const hit = e.from === pageId || e.to === pageId;
      return { from: e.from, to: e.to, label: e.label, state: hit ? 'hl' : 'dim' };
    });
  }

  /** 选中某页时，它相连的边高亮、其余淡出；未选页面（含选中逻辑点）时边不带任何状态。 */
  function buildEdges() {
    const selPage = state.sel?.kind === 'page' ? state.sel.id : null;
    return edgesHighlightedAround(selPage);
  }

  function renderNodes() {
    mapCanvas.setNodes(buildNodes());
    mapCanvas.setEdges(buildEdges());

    const all = { add: 0, mod: 0, del: 0 };
    for (const p of map.pages) for (const pt of p.points || []) all[pt.type]++;
    const chips = root.querySelectorAll('.rq-fchip b');
    if (chips[0]) chips[0].textContent = all.add;
    if (chips[1]) chips[1].textContent = all.mod;
    if (chips[2]) chips[2].textContent = all.del;
  }

  /** 页面卡片的内容与样式——map-canvas 只给了个空 .rq-node，这里往里填页面/逻辑点信息。 */
  function renderPageNode(node, nodeEl) {
    const { page, isEntry } = node.data;
    const pts = visiblePoints(page);
    const counts = { add: 0, mod: 0, del: 0 };
    for (const pt of page.points || []) counts[pt.type]++;
    const untouched = page.state === 'untouched';
    const dimmed = !untouched && (page.points || []).length && !pts.length;

    if (page.state === 'new') nodeEl.classList.add('rq-newpage');
    if (untouched || dimmed) nodeEl.classList.add('rq-untouched');
    if (state.sel?.kind === 'page' && state.sel.id === page.id) nodeEl.classList.add('sel');

    const head = el('div', 'rq-nhead');
    const top = el('div', 'rq-ntop');
    top.appendChild(el('span', 'rq-nname', page.name));
    // 「入口」放在最前：先告诉用户从哪进来，再说这页是新增还是有稿
    if (isEntry) top.appendChild(el('span', 'rq-nflag rq-entry', '入口'));
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
    nodeEl.appendChild(head);

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
        // 逻辑点行要单独打开逻辑点详情，不能让点击冒泡到卡片触发「打开页面」
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          openPoint(pt.id);
        });
        box.appendChild(row);
      }
      nodeEl.appendChild(box);
    } else {
      nodeEl.appendChild(el('div', 'rq-nempty', '本次需求不涉及改动，仅作跳转参考'));
    }
  }

  /** 悬停预览依赖链路：仅在没有页面被选中时生效，避免和点击选中的高亮互相打架。 */
  function onNodeHover(id, isHover) {
    if (state.sel?.kind === 'page') return;
    mapCanvas.setEdges(edgesHighlightedAround(isHover ? id : null));
  }

  // ---------- 重新生成 ----------
  // 与「提交标注修订」并列的第二条回流路径，但驱动源不是用户挑错，而是开发途中代码本身已经变了。
  const regenBtn = root.querySelector('.rq-regen');
  if (busy) {
    regenBtn.disabled = true;
    regenBtn.title = '系统任务运行中，请稍候';
  }
  regenBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '重新生成需求地图',
      message:
        '将忽略当前地图，重新通读一遍代码，按实际实现产出新版地图。\n' +
        '耗时通常数分钟到十几分钟。当前版本会保留，可随时切回。',
      confirmText: '开始重扫',
    });
    if (!ok) return;
    regenBtn.disabled = true;
    regenBtn.textContent = '已提交…';
    try {
      const r = await fetch('/api/req/map/regen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '触发失败');
      window.toast.success('已开始重新生成 · 完成后自动更新到新版本');
      onRegen?.();
    } catch (e) {
      window.toast.error('重新生成失败：' + (e?.message || e));
      regenBtn.disabled = false;
      regenBtn.textContent = '↻ 重新生成';
    }
  });

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

  // 存到 container 上以便下次 mountMap（版本切换）时能精确摘掉这一个，而不是靠
  // 「容器还在不在文档里」这个自愈检查——那个检查只在容器整个被移除时才生效，
  // 版本切换是同一个容器反复复用，永远走不到那个分支。
  function onEsc(e) {
    if (!document.body.contains(container)) {
      document.removeEventListener('keydown', onEsc);
      container.__reqMapEsc = null;
      return;
    }
    if (e.key === 'Escape' && !drawer.hidden) closeDrawer();
  }
  container.__reqMapEsc = onEsc;
  document.addEventListener('keydown', onEsc);

  renderNodes();
  updateFoot();
  requestAnimationFrame(() => mapCanvas.fitView());
}

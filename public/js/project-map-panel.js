/**
 * 项目地图面板：检查是否已生成 → 未生成给生成入口；已生成用通用画布内核画成模块依赖图。
 *
 * 平铺在对话区（panel-page）而不是弹层：依赖图要靠面积才看得清，弹层里画布只剩几百像素高，
 * 节点一多就得反复缩放平移。面板的显示/隐藏由 app.js 的 showView 统管，本模块不碰。
 */
import { $ } from './util.js';
import createGlobe from '/vendor/cobe.esm.js';
import { createMapCanvas } from './map-canvas.js';
import { layoutMap } from './req-map-layout.logic.js';

/** 后台正在运行的生成 job；切走视图不清除，下次进来重附进度流 */
let pendingJobId = null;
/** 后台 SSE 连接；确保只有一条，切换弹框时不会泄漏 */
let activeEs = null;
/** 地球动画的停止函数；弹框关闭或内容重渲染时调用，防止隐藏的 canvas 继续烧 GPU */
let stopGlobe = null;
/** 已生成态的画布句柄；它在 window 上挂了 mousemove/mouseup，不 destroy 会随每次重渲染累积泄漏 */
let mapCanvas = null;

/**
 * 把会持续占资源的东西收干净。
 *
 * 必须显式调用：面板切走只是 hidden=true，容器仍然 isConnected，
 * 地球的 rAF 自检条件不成立，不收就会在看不见的地方一直烧 GPU。
 */
export function disposeProjectMapView() {
  if (stopGlobe) { stopGlobe(); stopGlobe = null; }
  if (mapCanvas) { mapCanvas.destroy(); mapCanvas = null; }
  getBody()?.classList.remove('pm-body--map');
}

function getBody() { return document.getElementById('projectMapBody'); }

/** 从 dirLabel 的 title 属性读取当前工作目录（chat.js 写入） */
function getDir() {
  const title = document.getElementById('dirLabel')?.title || '';
  return (title && title !== '(服务所在目录)') ? title : '';
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 加载地图；knownDir 是已知路径（生成完成后传入），避免重新从 DOM 读取引发路径格式不一致 */
async function load(knownDir) {
  const b = getBody();
  if (!b) return;
  disposeProjectMapView(); // 任何一次重新加载都会覆盖 body，先收掉上一个地球
  const dir = knownDir || getDir();
  if (!dir) {
    b.innerHTML = '<div class="pm-empty"><div class="pm-empty-text">请先在顶栏选择工作目录</div></div>';
    return;
  }
  b.innerHTML = '<div class="pm-empty"><div class="pm-empty-text">加载中…</div></div>';
  try {
    const r = await fetch(`/api/project-map/get?dir=${encodeURIComponent(dir)}`);
    if (r.status === 404) {
      // 后台有正在运行的 job → 重新附加到进度流，而不是显示「未生成」
      if (pendingJobId) {
        attachToStream(pendingJobId, dir);
      } else {
        renderNotGenerated(dir);
      }
    } else if (r.ok) {
      renderMap(await r.json(), dir);
    } else {
      b.innerHTML = `<div class="pm-empty"><div class="pm-empty-text">加载失败（${r.status}）</div></div>`;
    }
  } catch (e) {
    b.innerHTML = `<div class="pm-empty"><div class="pm-empty-text">加载失败：${esc(e.message)}</div></div>`;
  }
}

function renderNotGenerated(dir) {
  const b = getBody();
  b.innerHTML = `
    <div class="pm-no-map">
      <div class="pm-empty-text">该项目尚未生成地图</div>
      <div class="pm-globe-wrap" id="pmGlobeWrap"></div>
      <button class="btn primary pm-gen-btn" id="pmGenBtn">生成项目地图</button>
    </div>
  `;
  document.getElementById('pmGenBtn')?.addEventListener('click', () => startGenerate(dir));
  const wrap = document.getElementById('pmGlobeWrap');
  if (wrap) stopGlobe = startGlobe(wrap);
}

/**
 * 用 cobe（WebGL 点阵世界地图）渲染旋转地球。
 *
 * 必须自己驱动 requestAnimationFrame 循环：cobe v2 拿掉了 v0.6 的 onRender 回调，
 * 内部**不含任何渲染循环**，createGlobe 只同步画一帧就收手。而世界地图是一张
 * base64 PNG 经 `new Image()` 异步解码后才上传成纹理——那唯一一帧画完时纹理还是空的，
 * 采样到 1×1 占位纹理，于是球体渲染成一片纯白。持续调 update() 重绘，
 * 纹理到位后的帧才会显出大陆点阵。
 */
function startGlobe(container) {
  // 只露上半球：canvas 仍画完整的球，靠 .pm-globe-wrap 的固定高度 + overflow:hidden
  // 把下半截裁掉。不能改成只画半张画布——cobe 的投影以画布中心为球心，
  // 压扁画布会把球压成椭圆，而不是切掉一半。
  const SIZE = 330;
  const DPR = Math.min(devicePixelRatio, 2);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `width:${SIZE}px;height:${SIZE}px;display:block;`;
  container.appendChild(canvas);

  let phi = 0;
  let raf = 0;

  const globe = createGlobe(canvas, {
    devicePixelRatio: DPR,
    width: SIZE * DPR,
    height: SIZE * DPR,
    phi: 0,
    theta: 0.25,
    dark: 0,            // 亮色球体，配深色背景出发光感
    diffuse: 0.4,       // 低漫射，避免球面过曝把点阵吃掉
    mapSamples: 16000,
    mapBrightness: 1.2, // 与 baseColor=[1,1,1] 配合：陆地点算出负值被截断成深色
    baseColor: [1, 1, 1],
    markerColor: [0.85, 0.47, 0.34],
    glowColor: [1, 1, 1],
    markers: [], // 不要地标高亮点；空数组而非省略，省略会让实例化绘制拿不到缓冲区
  });

  // update 是部分合并：只传 phi，其余配置沿用闭包内的值
  function frame() {
    if (!container.isConnected) { globe.destroy(); return; }
    phi += 0.003;
    globe.update({ phi });
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // 弹框关闭/重渲染时由调用方停循环，避免看不见的 canvas 还在烧 GPU
  return () => { cancelAnimationFrame(raf); globe.destroy(); };
}

/**
 * 「闲时更新」开关。
 *
 * 真值在服务端 settings.json 的 uiPrefs.projectMapIdleRefresh —— 定时器跑在后端进程里，
 * 只有服务端的值才算数。存 localStorage 会出现「这台浏览器显示开着、另一台显示关着」
 * 而实际行为只由服务端决定的假象，所以每次渲染都从服务端读回。
 */
function bindIdleToggle(box) {
  if (!box) return;
  fetch('/api/settings')
    .then((r) => r.json())
    .then((d) => { box.checked = !!d?.uiPrefs?.projectMapIdleRefresh; })
    .catch(() => { /* 读不到就保持未勾选，用户点一下即可纠正 */ });

  box.addEventListener('change', async () => {
    const next = box.checked;
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: 'ui-prefs', projectMapIdleRefresh: next }),
      });
      const d = await r.json();
      if (!r.ok || d?.ok === false) throw new Error(d?.error || '保存失败');
      window.toast?.success(next ? '已开启：每天凌晨 3 点自动更新地图' : '已关闭闲时更新');
    } catch (e) {
      box.checked = !next; // 回滚勾选态，别让 UI 显示一个没存进去的值
      window.toast?.error('设置失败：' + (e?.message || e));
    }
  });
}

/** 卡片/胶囊上的显示名：末两级路径，够短又能区分同名目录（entrypoints/web vs 别处的 web） */
function displayName(m) {
  const segs = String(m.path || m.id || '').split('/').filter(Boolean);
  if (segs.length <= 1) return m.name || m.id || '';
  return segs.slice(-2).join(' / ');
}

/**
 * 已生成态：把地图画成可交互的模块依赖图（模块 = 卡片节点，A→B = A 依赖 B）。
 *
 * 复用需求地图那套内核与布局：createMapCanvas 管缩放/平移/连线/minimap，layoutMap 做分层排布。
 * layoutMap 认的是 pages，这里把 modules 伪装成「没有逻辑点的页面」喂进去，它据此算出统一的
 * 节点高度；该高度回填到节点的内联 style，连线锚点按它算，两边对不上箭头就会悬空。
 *
 * @param {object} map 落盘的地图
 * @param {string} dir 当前目录；老地图没存 projectPath 时用它兜底展示
 */
function renderMap(map, dir) {
  const b = getBody();
  const modules = Array.isArray(map.modules) ? map.modules : [];
  // 旧版 collect-facts 会产出「模块依赖自己」的自环，画出来是一条绕回原点的怪线。
  // 源头已修，但已落盘的老地图里还有，这里再兜一层。
  const edges = (map.edges || []).filter((e) => e && e.from && e.to && e.from !== e.to);
  const projectPath = map.projectPath || dir || '';
  const when = map.generatedAt ? new Date(map.generatedAt).toLocaleString('zh-CN') : '—';
  const s = map.summary || {};

  b.classList.add('pm-body--map');
  b.innerHTML = `
    <div class="pm-map-bar">
      <div class="pm-map-meta">
        <span class="pm-map-path"></span>
        <span class="pm-map-stat">${modules.length} 模块 · ${edges.length} 依赖 · ${s.totalFiles ?? '—'} 文件 · ${s.totalLines ?? '—'} 行 · 生成于 ${esc(when)}</span>
      </div>
      <input class="pm-map-filter" id="pmFilter" type="search" placeholder="筛选模块：名称 / 路径 / 描述" autocomplete="off" />
      <label class="pm-idle-toggle" title="开启后每天凌晨 3 点自动重扫。只有改动过的模块会重新调用 LLM，没改动的项目几乎零开销。">
        <input type="checkbox" id="pmIdleToggle" /><span>闲时更新</span>
      </label>
      <button class="btn" id="pmRegenBtn">重新生成</button>
    </div>
    <div class="pm-map-canvas">
      <div class="pm-map-mount"></div>
      <aside class="pm-drawer" id="pmDrawer" hidden></aside>
    </div>
  `;
  const pathEl = b.querySelector('.pm-map-path');
  pathEl.textContent = projectPath;
  pathEl.title = projectPath;
  b.querySelector('#pmRegenBtn').addEventListener('click', () => startGenerate(projectPath || getDir()));
  bindIdleToggle(b.querySelector('#pmIdleToggle'));

  const mount = b.querySelector('.pm-map-mount');
  if (!modules.length) {
    mount.innerHTML = '<div class="pm-empty"><div class="pm-empty-text">地图为空：没有识别到任何模块目录</div></div>';
    return;
  }

  const byId = new Map(modules.map((m) => [m.id, m]));
  const layout = layoutMap({ pages: modules.map((m) => ({ id: m.id, points: [] })), edges });
  const nodes = modules.map((m) => {
    const pos = layout.positions[m.id] || { x: 0, y: 0, h: 120 };
    return { id: m.id, x: pos.x, y: pos.y, width: layout.nodeW, height: pos.h, data: m };
  });

  let selected = null;

  /** 以某模块为中心：相连的边高亮、其余淡出；不传则全部恢复常态 */
  function edgesAround(id) {
    return edges.map((e) => {
      if (!id) return { from: e.from, to: e.to };
      return { from: e.from, to: e.to, state: e.from === id || e.to === id ? 'hl' : 'dim' };
    });
  }

  function markSelected() {
    for (const el of mount.querySelectorAll('.rq-node')) {
      el.classList.toggle('sel', el.dataset.nodeId === selected);
    }
  }

  /** 模块卡片内容。业务文本一律 textContent，不进 innerHTML。 */
  function renderModuleNode(node, el) {
    const m = node.data;
    el.classList.add('pm-node');
    el.style.height = node.height + 'px';
    const deps = (m.dependsOn || []).filter((d) => d !== m.id).length;
    const used = (m.usedBy || []).filter((u) => u !== m.id).length;
    el.innerHTML =
      '<div class="pm-node-name"></div>' +
      '<div class="pm-node-path"></div>' +
      '<div class="pm-node-desc"></div>' +
      `<div class="pm-node-foot"><span>${(m.files || []).length} 文件</span><span>${m.lines ?? 0} 行</span>` +
      `<span title="依赖的模块数">↓ ${deps}</span><span title="被多少模块依赖">↑ ${used}</span></div>`;
    // 标题带一级父目录：模块 id 改成路径后会出现 web、team-tools 这类光看目录名
    // 认不出归属的名字，「entrypoints / web」比孤零零一个「web」好认得多
    el.querySelector('.pm-node-name').textContent = displayName(m);
    el.querySelector('.pm-node-path').textContent = m.path || '';
    const desc = m.description && m.description !== '(待补充)' ? m.description : '（暂无描述）';
    el.querySelector('.pm-node-desc').textContent = desc;
  }

  const drawer = b.querySelector('#pmDrawer');
  function closeDrawer() {
    drawer.hidden = true;
    selected = null;
    mc.setEdges(edgesAround(null));
    markSelected();
  }
  function select(id) {
    const m = byId.get(id);
    if (!m) return;
    selected = id;
    mc.setEdges(edgesAround(id));
    markSelected();
    openDrawer(m);
  }
  function chipList(box, ids) {
    box.innerHTML = '';
    for (const id of ids) {
      const chip = document.createElement('button');
      chip.className = 'pm-chip';
      chip.textContent = byId.has(id) ? displayName(byId.get(id)) : id;
      chip.addEventListener('click', () => select(id));
      box.appendChild(chip);
    }
  }
  function openDrawer(m) {
    drawer.hidden = false;
    drawer.innerHTML =
      '<div class="pm-drawer-head"><b class="pm-drawer-name"></b><button class="pm-drawer-close" title="关闭">✕</button></div>' +
      '<div class="pm-drawer-path"></div>' +
      '<div><div class="pm-drawer-label">描述</div><div class="pm-drawer-desc"></div></div>' +
      '<div><div class="pm-drawer-label">关键函数</div><ul class="pm-drawer-list pm-kf"></ul></div>' +
      '<div><div class="pm-drawer-label">依赖</div><div class="pm-chips pm-deps"></div></div>' +
      '<div><div class="pm-drawer-label">被依赖</div><div class="pm-chips pm-used"></div></div>' +
      '<div><div class="pm-drawer-label">导出 <span class="pm-n"></span></div><div class="pm-drawer-exports"></div></div>' +
      '<div><div class="pm-drawer-label">文件 <span class="pm-n"></span></div><ul class="pm-drawer-list pm-files"></ul></div>';
    drawer.querySelector('.pm-drawer-name').textContent = displayName(m);
    drawer.querySelector('.pm-drawer-path').textContent = m.path || '';
    drawer.querySelector('.pm-drawer-desc').textContent =
      m.description && m.description !== '(待补充)' ? m.description : '（暂无描述）';
    const kf = drawer.querySelector('.pm-kf');
    for (const fn of m.keyFunctions || []) {
      const li = document.createElement('li');
      li.textContent = fn;
      kf.appendChild(li);
    }
    if (!kf.children.length) kf.innerHTML = '<li>（暂无）</li>';
    chipList(drawer.querySelector('.pm-deps'), (m.dependsOn || []).filter((d) => d !== m.id));
    chipList(drawer.querySelector('.pm-used'), (m.usedBy || []).filter((u) => u !== m.id));
    const exps = m.exports || [];
    const files = m.files || [];
    const ns = drawer.querySelectorAll('.pm-n');
    ns[0].textContent = `(${exps.length})`;
    ns[1].textContent = `(${files.length})`;
    drawer.querySelector('.pm-drawer-exports').textContent = exps.join(', ') || '（无）';
    const fl = drawer.querySelector('.pm-files');
    for (const f of files) {
      const li = document.createElement('li');
      li.textContent = f;
      fl.appendChild(li);
    }
    drawer.querySelector('.pm-drawer-close').addEventListener('click', closeDrawer);
  }

  const mc = createMapCanvas(mount, {
    nodes,
    edges: edgesAround(null),
    renderNode: renderModuleNode,
    onNodeClick: select,
    // 已有选中时悬停不抢高亮，否则鼠标一划过选中态就丢了
    onNodeHover: (id, on) => { if (!selected) mc.setEdges(edgesAround(on ? id : null)); },
  });
  mapCanvas = mc;

  b.querySelector('#pmFilter').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) return mc.highlightNodes(null);
    const hit = modules
      .filter((m) => [m.name, m.id, m.path, m.description].some((v) => String(v || '').toLowerCase().includes(q)))
      .map((m) => m.id);
    mc.highlightNodes(hit);
  });

  // 容器要先完成布局 fitView 才量得到真实宽高，等一帧
  requestAnimationFrame(() => mc.fitView());
}

async function startGenerate(dir) {
  const b = getBody();
  if (!b) return;
  showGenerating('正在请求生成…');

  let jobId;
  try {
    const r = await fetch('/api/project-map/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409 || r.status === 202 || r.ok) {
      jobId = d.jobId;
    } else {
      showError(`生成请求失败：${d.error || r.status}`);
      return;
    }
  } catch (e) {
    showError(`网络错误：${esc(e.message)}`);
    return;
  }

  pendingJobId = jobId;
  attachToStream(jobId, dir);
}

/** 附加到 SSE 进度流（生成中或重新打开弹框时复用） */
function attachToStream(jobId, dir) {
  // 断开旧连接（如果有）
  if (activeEs) { activeEs.close(); activeEs = null; }

  showGenerating('连接进度流…');

  const es = new EventSource(`/api/project-map/generate-stream?jobId=${encodeURIComponent(jobId)}`);
  activeEs = es;

  // replay：任务已存在时先推全量历史；直接判断是否已完成
  es.addEventListener('replay', (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.status === 'done') {
        finish(es, d.done, dir);
      } else if (d.events?.length) {
        const last = [...d.events].reverse().find((ev) => ev.event === 'step');
        if (last?.data?.detail) setStatus(last.data.detail);
      }
    } catch {}
  });

  es.addEventListener('step', (e) => {
    try {
      const d = JSON.parse(e.data);
      setStatus(d.detail || d.stage || '处理中…');
    } catch {}
  });

  es.addEventListener('done', (e) => {
    try { finish(es, JSON.parse(e.data), dir); } catch { finish(es, { ok: true }, dir); }
  });

  // 服务端关流后 EventSource 会触发 onerror（尝试重连）；
  // 若 finish() 已正常处理（activeEs 已被清空），直接忽略，不覆盖结果视图。
  es.onerror = () => {
    if (activeEs !== es) return;
    es.close();
    activeEs = null;
    showError('连接中断，请重试');
  };
}

function finish(es, done, dir) {
  es.close();
  if (activeEs === es) activeEs = null;
  pendingJobId = null;
  if (done?.ok) {
    // 用生成时的 dir（而非重新读 DOM），避免 Windows 路径格式差异导致 safeProjectId 不同
    load(dir);
  } else {
    showError(`生成失败：${esc(done?.error || '未知错误')}`);
    // 失败后展示重试按钮
    const b = getBody();
    if (b) {
      const btn = document.createElement('button');
      btn.className = 'btn pm-gen-btn';
      btn.textContent = '重试';
      btn.addEventListener('click', () => startGenerate(dir));
      b.querySelector('.pm-empty')?.appendChild(btn);
    }
  }
}

/** 切换到「生成中」进度 UI */
function showGenerating(msg) {
  const b = getBody();
  if (!b) return;
  b.innerHTML = `
    <div class="pm-empty">
      <div class="pm-spinner"></div>
      <div class="pm-empty-text" id="pmGenStatus">${esc(msg)}</div>
    </div>
  `;
}

function setStatus(msg) {
  const el = document.getElementById('pmGenStatus');
  if (el) el.textContent = msg;
}

function showError(msg) {
  const b = getBody();
  if (!b) return;
  b.innerHTML = `<div class="pm-empty"><div class="pm-empty-text pm-error">${esc(msg)}</div></div>`;
}

/**
 * 进入项目地图视图时由 showView 调用。
 *
 * 每次进来都重新拉一次：地图可能刚在别处生成完，缓存住会让用户看到过期的「未生成」。
 * 面板的 hidden 切换归 showView 管，这里只负责内容。
 */
export function initProjectMapPanel() {
  load();
}

/**
 * 需求地图分层布局 —— 纯函数，零 DOM（单测目标）。
 *
 * 坐标不让 LLM 出（既不稳又费 token，见 spec §3.1），这里按 edges 做最长路径分层：
 * 入度为 0 的页面在第 0 层，子节点落在**最深的父节点**之下（避免连线往回穿），
 * 同层横向等距并保持 pages 原始顺序。
 */

const NODE_W = 296;   // 节点宽，与 CSS .rq-node 保持一致
const GAP_X = 90;     // 同层水平间距
const GAP_Y = 76;     // 层间垂直间距
const HEAD_H = 82;    // 节点头部（页面名 + 文件路径 + 计数）高度
const PT_H = 31;      // 单个逻辑点行高
const PTS_PAD = 16;   // 逻辑点区上下内边距
const EMPTY_H = 38;   // 无逻辑点时的占位行高
const PAD = 28;       // 画布四周留白（顶部还会被 fitView 额外让出工具条高度，这里不必留太多）

/** 节点高度：随逻辑点数增长。布局要用到，所以不能等 DOM 渲染完再量。 */
function nodeHeight(page) {
  const n = (page?.points || []).length;
  return HEAD_H + (n ? PTS_PAD + n * PT_H : EMPTY_H);
}

/**
 * 保序防重叠：只把间距不足的节点往右推，绝不重排。
 *
 * 为什么不重排：同层顺序一乱，每次生成的地图左右乱跳，用户没法比对版本差异
 * （「同层保持 pages 原始顺序」是既有性质，不能因为居中就丢掉）。
 */
function spreadRow(bucket, positions) {
  const MIN = NODE_W + GAP_X;
  for (let i = 1; i < bucket.length; i++) {
    const prev = positions[bucket[i - 1]];
    const cur = positions[bucket[i]];
    if (cur.x - prev.x < MIN) cur.x = prev.x + MIN;
  }
}

/**
 * 父节点居中：自底向上，把父节点中心对准其直接子节点的中心均值。
 *
 * 只认「更深层」的子节点 —— 同层边和回边会把父节点往回拽，画出来更乱。
 * 一个节点有多个父节点时，各父节点各自按自己的子集居中、互不协调；这是有意的近似，
 * 不引入全局最优排布（那是另一个量级的复杂度）。
 */
function centerParents(layers, positions, adj, layer) {
  for (let l = layers.length - 2; l >= 0; l--) {
    const bucket = layers[l];
    if (!bucket) continue;
    for (const id of bucket) {
      const kids = (adj.get(id) || []).filter((k) => positions[k] && (layer.get(k) ?? 0) > l);
      if (!kids.length) continue;
      const mean = kids.reduce((s, k) => s + positions[k].x + NODE_W / 2, 0) / kids.length;
      positions[id].x = Math.max(PAD, mean - NODE_W / 2);
    }
    spreadRow(bucket, positions);
  }
}

/**
 * 最长路径分层。返回 Map<id, layer>。
 *
 * 成环时 Kahn 会留下一批永远进不了队的节点（入度减不到 0）。此时按 pages 原序挑第一个
 * 未分层的节点当根、从它 BFS 铺开，直到全部覆盖——保证「有环也画得出来」，
 * 而不是死循环或漏节点。
 */
function assignLayers(ids, adj, indeg) {
  const layer = new Map();
  const queue = ids.filter((id) => indeg.get(id) === 0);
  queue.forEach((id) => layer.set(id, 0));

  const work = [...queue];
  const deg = new Map(indeg);
  while (work.length) {
    const cur = work.shift();
    for (const nb of adj.get(cur) || []) {
      layer.set(nb, Math.max(layer.get(nb) ?? 0, (layer.get(cur) ?? 0) + 1));
      deg.set(nb, deg.get(nb) - 1);
      if (deg.get(nb) === 0) work.push(nb);
    }
  }

  // 环内残余：逐个挑未分层节点作根铺开（visited 防环内死循环）
  for (const root of ids) {
    if (layer.has(root)) continue;
    layer.set(root, 0);
    const seen = new Set([root]);
    const q = [root];
    while (q.length) {
      const cur = q.shift();
      for (const nb of adj.get(cur) || []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        layer.set(nb, Math.max(layer.get(nb) ?? 0, (layer.get(cur) ?? 0) + 1));
        q.push(nb);
      }
    }
  }
  return layer;
}

/**
 * @param {object} map - { pages, edges }
 * @returns {{ positions: Record<string,{x,y,h}>, size:{w,h}, nodeW:number, layers:string[][] }}
 */
export function layoutMap(map) {
  const pages = Array.isArray(map?.pages) ? map.pages : [];
  if (!pages.length) {
    return { positions: {}, size: { w: 600, h: 400 }, nodeW: NODE_W, layers: [], layerOf: new Map(), entries: [] };
  }

  const ids = pages.map((p) => p.id);
  const known = new Set(ids);
  const adj = new Map(ids.map((id) => [id, []]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of Array.isArray(map?.edges) ? map.edges : []) {
    if (!known.has(e?.from) || !known.has(e?.to) || e.from === e.to) continue;
    adj.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }

  // 入口页 = 入度 0。渲染层要据此打「入口」徽标，这里顺手带出去，免得再遍历一遍 edges。
  const entries = ids.filter((id) => indeg.get(id) === 0);

  const layer = assignLayers(ids, adj, indeg);

  // 分桶：同层内保持 pages 原始顺序，避免每次生成的图左右乱跳
  const layers = [];
  pages.forEach((p) => {
    const l = layer.get(p.id) ?? 0;
    (layers[l] ||= []).push(p.id);
  });

  const byId = new Map(pages.map((p) => [p.id, p]));
  const positions = {};
  let y = PAD;
  for (const bucket of layers) {
    if (!bucket) continue;
    let rowH = 0;
    bucket.forEach((id, col) => {
      const h = nodeHeight(byId.get(id));
      positions[id] = { x: PAD + col * (NODE_W + GAP_X), y, h };
      rowH = Math.max(rowH, h);
    });
    y += rowH + GAP_Y;
  }

  // 第二趟：父节点居中。x 会被改写，所以画布宽度只能在这之后统一求。
  centerParents(layers, positions, adj, layer);
  const maxRight = Math.max(...Object.values(positions).map((p) => p.x + NODE_W));

  return {
    positions,
    size: { w: maxRight + PAD, h: y - GAP_Y + PAD },
    nodeW: NODE_W,
    layers: layers.filter(Boolean),
    layerOf: layer, // 渲染层按层级关系决定连线走向（纵向 / 横向）
    entries,
  };
}

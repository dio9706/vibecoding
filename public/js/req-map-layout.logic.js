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
  if (!pages.length) return { positions: {}, size: { w: 600, h: 400 }, nodeW: NODE_W, layers: [] };

  const ids = pages.map((p) => p.id);
  const known = new Set(ids);
  const adj = new Map(ids.map((id) => [id, []]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of Array.isArray(map?.edges) ? map.edges : []) {
    if (!known.has(e?.from) || !known.has(e?.to) || e.from === e.to) continue;
    adj.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }

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
  let maxRight = 0;
  for (const bucket of layers) {
    if (!bucket) continue;
    let rowH = 0;
    bucket.forEach((id, col) => {
      const h = nodeHeight(byId.get(id));
      const x = PAD + col * (NODE_W + GAP_X);
      positions[id] = { x, y, h };
      rowH = Math.max(rowH, h);
      maxRight = Math.max(maxRight, x + NODE_W);
    });
    y += rowH + GAP_Y;
  }

  return {
    positions,
    size: { w: maxRight + PAD, h: y - GAP_Y + PAD },
    nodeW: NODE_W,
    layers: layers.filter(Boolean),
  };
}

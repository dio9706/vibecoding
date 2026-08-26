# 需求地图页面关联与鸟瞰图修复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **提交纪律（覆盖 skill 默认）：** 本仓库约定**不自动 git 提交**，改动一律留在工作区，提交时机由用户掌控。所以下面每个任务的收尾是「跑测试 + 走查」，**没有 commit 步骤**。

**Goal:** 修复需求地图页面跳转连线被静默丢弃的 bug，并让链路在画布上可读（箭头 / 层级路由 / 选中高亮 / 入口徽标 / 抽屉上下游）；同时修掉鸟瞰图的方向反转与内容错位，位置上移。

**Architecture:** 数据层把边端点按页面 name 解析（id 兜底）后统一存 id；布局层外露 `layerOf` / `entries` 并做父节点居中；渲染层按层级决定连线走向；鸟瞰图的坐标数学抽成独立纯函数模块以便单测。

**Tech Stack:** 原生 ES Module（无框架）、`node:test` + `node:assert/strict`、SVG 手绘连线、CSS 变量主题。

**Spec:** `docs/superpowers/specs/2026-08-26-req-map-edges-and-minimap-design.md`

**跑测试：** `npm test`（等价于 `node --test "src/**/*.test.js" "public/**/*.test.js"`）。单文件跑：`node --test <path>`。

---

## 文件结构

| 文件 | 责任 | 本次改动 |
|---|---|---|
| `src/entrypoints/web/req-map.logic.js` | LLM 输出解析 / 地图规范化 / prompt 构造（零 IO 纯逻辑） | 边端点 name→id 解析；契约强化 |
| `src/entrypoints/web/req-map.logic.test.js` | 上者单测 | 补 4 条边解析用例；纠正 3 条误导性用例的命名 |
| `public/js/req-map-layout.logic.js` | 分层布局纯函数（坐标计算） | 外露 `layerOf`/`entries`；父节点居中 + 保序推挤 |
| `public/js/req-map-layout.logic.test.js` | 上者单测 | 补 4 条用例 |
| `public/js/req-map-minimap.logic.js` | **新增**：鸟瞰图坐标换算纯函数（视口 ↔ pan 互逆） | 全新 |
| `public/js/req-map-minimap.logic.test.js` | **新增**：上者单测 | 全新 |
| `public/js/req-map.js` | 画布视图（DOM/SVG 渲染 + 交互） | 连线渲染、入口徽标、抽屉上下游、鸟瞰图接线 |
| `public/css/req-v2.css` | 需求 v2 样式 | 连线状态 / 箭头 / 入口徽标 / 鸟瞰图定位 |

拆分理由：鸟瞰图数学**必须**离开 `req-map.js` —— 这个 bug 上线正是因为它埋在 DOM 操作里无法单测。其余沿用项目既有的「纯逻辑进 `.logic.js` 单测、DOM 层人工走查」约定。

---

## Task 1: 边端点按 name 解析、id 兜底

**Files:**
- Modify: `src/entrypoints/web/req-map.logic.js:147-161`
- Test: `src/entrypoints/web/req-map.logic.test.js:89-108`

- [ ] **Step 1: 先把 3 条误导性的存量用例改名，写清「id 兜底」意图**

这 3 条用例（`req-map.logic.test.js:89-108`）全用 id 造数据，恰好绕开了 name/id 口径分歧，是本次 bug 上线的原因。**留下它们**（id 兜底确实要保）但把意图写进名字。整段替换为：

```js
test('normalizeMap 边端点按 id 兜底时，丢弃指向不存在页面的孤儿边', () => {
  const m = normalizeMap({
    pages: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'ghost' }, { from: 'nope', to: 'b' }],
  });
  assert.equal(m.edges.length, 1);
});

test('normalizeMap 边端点按 id 兜底时，去重同向重复边', () => {
  const m = normalizeMap({
    pages: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    edges: [{ from: 'a', to: 'b', label: '点1' }, { from: 'a', to: 'b', label: '点2' }],
  });
  assert.equal(m.edges.length, 1);
});

test('normalizeMap 边端点按 id 兜底时，丢弃自环边', () => {
  const m = normalizeMap({ pages: [{ id: 'a', name: 'A' }], edges: [{ from: 'a', to: 'a' }] });
  assert.equal(m.edges.length, 0);
});
```

- [ ] **Step 2: 在其后追加 4 条失败测试**

```js
test('normalizeMap 按页面 name 解析边端点，落盘统一存 id', () => {
  // 契约要求 LLM 用 name（mapOutputContract），而 id 是本地自动编号 —— 这正是原 bug 现场
  const m = normalizeMap({
    pages: [{ name: '游戏广场' }, { name: '今晚吃什么转盘' }],
    edges: [{ from: '游戏广场', to: '今晚吃什么转盘', label: '点击 今晚吃什么' }],
  });
  const [square, wheel] = m.pages;
  assert.deepEqual(m.edges, [{ from: square.id, to: wheel.id, label: '点击 今晚吃什么' }]);
});

test('normalizeMap 边端点 name / id 混用都能解析', () => {
  const m = normalizeMap({
    pages: [{ id: 'a', name: '广场' }, { id: 'b', name: '转盘' }],
    edges: [{ from: '广场', to: 'b' }],
  });
  assert.deepEqual(m.edges.map((e) => [e.from, e.to]), [['a', 'b']]);
});

test('normalizeMap 跨表达方式的重复边只留首条', () => {
  // 去重键必须用解析后的 id，否则同一对页面「一次 name 一次 id」会在画布上画出重影
  const m = normalizeMap({
    pages: [{ id: 'a', name: '广场' }, { id: 'b', name: '转盘' }],
    edges: [{ from: '广场', to: '转盘', label: '点击' }, { from: 'a', to: 'b', label: '再点' }],
  });
  assert.equal(m.edges.length, 1);
  assert.equal(m.edges[0].label, '点击');
});

test('normalizeMap 同名页面的边指向首次出现的那个', () => {
  const m = normalizeMap({
    pages: [{ id: 'a', name: '重名' }, { id: 'b', name: '重名' }, { id: 'c', name: '目标' }],
    edges: [{ from: '重名', to: '目标' }],
  });
  assert.deepEqual(m.edges.map((e) => [e.from, e.to]), [['a', 'c']]);
});
```

- [ ] **Step 3: 跑测试确认新用例失败**

Run: `node --test src/entrypoints/web/req-map.logic.test.js`
Expected: 4 条新用例 FAIL（`m.edges` 为 `[]`，因为 name 端点被当孤儿边丢了）；3 条改名后的存量用例 PASS。

- [ ] **Step 4: 实现 name→id 解析**

把 `src/entrypoints/web/req-map.logic.js:147-161` 这段：

```js
  const pageIds = new Set(pages.map((p) => p.id));
  const seenEdges = new Set();
  const edges = (Array.isArray(raw?.edges) ? raw.edges : [])
    .map((e) => ({
      from: String(e?.from ?? '').trim(),
      to: String(e?.to ?? '').trim(),
      label: String(e?.label ?? '').trim(),
    }))
    .filter((e) => pageIds.has(e.from) && pageIds.has(e.to) && e.from !== e.to)
    .filter((e) => {
      const k = `${e.from}>${e.to}`;
      if (seenEdges.has(k)) return false;
      seenEdges.add(k);
      return true;
    });
```

整段替换为：

```js
  // 边端点解析：契约要求 LLM 用页面 name（见 mapOutputContract），而 id 是本地自动编号。
  // 此处曾只按 id 校验，导致所有边被静默丢弃、画布上一条线都没有。历史数据和偶尔跑偏的
  // 模型会给 id，所以 name 优先、id 兜底；落盘统一存 id，布局层/渲染层口径才不用分叉。
  const pageIds = new Set(pages.map((p) => p.id));
  const idByName = new Map();
  for (const p of pages) if (!idByName.has(p.name)) idByName.set(p.name, p.id); // 同名取首个
  const resolveEnd = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return '';
    return idByName.get(s) || (pageIds.has(s) ? s : '');
  };

  const seenEdges = new Set();
  const edges = [];
  for (const e of Array.isArray(raw?.edges) ? raw.edges : []) {
    const from = resolveEnd(e?.from);
    const to = resolveEnd(e?.to);
    if (!from || !to || from === to) continue;
    // 去重键用解析后的 id：同一对页面一次用 name 一次用 id，不能在画布上画出重影
    const k = `${from}>${to}`;
    if (seenEdges.has(k)) continue;
    seenEdges.add(k);
    edges.push({ from, to, label: String(e?.label ?? '').trim() });
  }
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `node --test src/entrypoints/web/req-map.logic.test.js`
Expected: 全部 PASS。

---

## Task 2: 强化 edges 的输出契约

**Files:**
- Modify: `src/entrypoints/web/req-map.logic.js:193-199`（`mapOutputContract` 的「硬性要求」段）
- Test: `src/entrypoints/web/req-map.logic.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `req-map.logic.test.js` 末尾：

```js
test('地图输出契约把 edges 列为硬性要求', () => {
  const p = buildMapgenPrompt({});
  for (const kw of ['入口页', '至少要有一条入边', '全部下钻链路']) {
    assert.ok(p.includes(kw), '契约缺少要求：' + kw);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/req-map.logic.test.js`
Expected: FAIL，提示「契约缺少要求：入口页」。

- [ ] **Step 3: 补契约条目**

在 `mapOutputContract()` 的「硬性要求」列表里，紧跟 `- edges 的 from/to 必须精确等于某个 page 的 name。` 之后插入 4 行：

```js
    `- **必须标出入口页**：用户从哪个页面进入本次需求涉及的功能。其余页面都应能顺着 edges 从它走到。\n` +
    `- 除入口页外，每个页面至少要有一条入边；确实无法到达的，在该页 points 里说清原因。\n` +
    `- hub 型页面（点进去能到多个子页面的那种）必须列出**全部下钻链路**，不能只列改动最大的几条。\n` +
    `- edges 的 label 写用户动作（如「点击 今晚吃什么」），不写 router.push 这类技术描述。\n` +
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/req-map.logic.test.js`
Expected: 全部 PASS。

---

## Task 3: `layoutMap` 外露 `layerOf` 与 `entries`

**Files:**
- Modify: `public/js/req-map-layout.logic.js:70-116`
- Test: `public/js/req-map-layout.logic.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `req-map-layout.logic.test.js` 末尾：

```js
test('layoutMap 外露 entries（入度 0 的页面）与 layerOf', () => {
  const r = layoutMap({
    pages: [pg('a'), pg('b'), pg('c')],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  });
  assert.deepEqual(r.entries, ['a']);
  assert.equal(r.layerOf.get('a'), 0);
  assert.equal(r.layerOf.get('b'), 1);
  assert.equal(r.layerOf.get('c'), 2);
});

test('layoutMap 全图成环时 entries 为空，但仍然出得来坐标', () => {
  const r = layoutMap({ pages: [pg('a'), pg('b')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
  assert.deepEqual(r.entries, []);
  assert.ok(r.positions.a && r.positions.b);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test public/js/req-map-layout.logic.test.js`
Expected: FAIL，`r.entries` 为 `undefined`。

- [ ] **Step 3: 实现**

在 `layoutMap` 里、`const layer = assignLayers(ids, adj, indeg);` 这一行**之前**插入（`indeg` 此时尚未被 `assignLayers` 内部的副本消耗，安全）：

```js
  // 入口页 = 入度 0。渲染层要据此打「入口」徽标，这里顺手带出去，免得再遍历一遍 edges。
  const entries = ids.filter((id) => indeg.get(id) === 0);
```

再把函数末尾的 `return` 改为：

```js
  return {
    positions,
    size: { w: maxRight + PAD, h: y - GAP_Y + PAD },
    nodeW: NODE_W,
    layers: layers.filter(Boolean),
    layerOf: layer,  // 渲染层按层级关系决定连线走向（纵向 / 横向）
    entries,
  };
```

同时把空地图的早退分支（`req-map-layout.logic.js:72`）补齐字段，否则调用方要到处判空：

```js
  if (!pages.length) {
    return { positions: {}, size: { w: 600, h: 400 }, nodeW: NODE_W, layers: [], layerOf: new Map(), entries: [] };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test public/js/req-map-layout.logic.test.js`
Expected: 全部 PASS（含 12 条存量用例）。

---

## Task 4: 父节点水平居中于子节点组

**Files:**
- Modify: `public/js/req-map-layout.logic.js`（新增两个模块级私有函数 + 改 `layoutMap` 定位段）
- Test: `public/js/req-map-layout.logic.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `req-map-layout.logic.test.js` 末尾：

```js
test('单父多子时父节点水平居中于子节点组', () => {
  const r = layoutMap({
    pages: [pg('hub'), pg('a'), pg('b'), pg('c')],
    edges: [{ from: 'hub', to: 'a' }, { from: 'hub', to: 'b' }, { from: 'hub', to: 'c' }],
  });
  const cx = (id) => r.positions[id].x + r.nodeW / 2;
  assert.equal(cx('hub'), (cx('a') + cx('c')) / 2);
  assert.equal(cx('hub'), cx('b')); // 三个等距子节点，正中那个就是中心
});

test('居中后同层不重叠，且保持 pages 的原始左右顺序', () => {
  // h1 的子节点在右、h2 的子节点在左：居中会想把 h2 拉到 h1 左边，保序推挤必须拦住
  const r = layoutMap({
    pages: [pg('h1'), pg('h2'), pg('x'), pg('y')],
    edges: [{ from: 'h1', to: 'y' }, { from: 'h2', to: 'x' }],
  });
  assert.ok(r.positions.h2.x - r.positions.h1.x >= r.nodeW);
});

test('居中后画布宽度仍然包住所有节点', () => {
  const r = layoutMap({
    pages: [pg('hub'), pg('a'), pg('b'), pg('c')],
    edges: [{ from: 'hub', to: 'a' }, { from: 'hub', to: 'b' }, { from: 'hub', to: 'c' }],
  });
  for (const id of ['hub', 'a', 'b', 'c']) {
    assert.ok(r.positions[id].x + r.nodeW <= r.size.w, id + ' 超出画布宽度');
  }
});

test('同层边与回边不参与居中计算', () => {
  // b→a 是回边（a 在更浅层），不能把 b 往 a 身上拽
  const r = layoutMap({
    pages: [pg('a'), pg('b'), pg('c')],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'b', to: 'a' }],
  });
  const cx = (id) => r.positions[id].x + r.nodeW / 2;
  assert.equal(cx('b'), cx('c')); // b 只有 c 一个更深层子节点
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test public/js/req-map-layout.logic.test.js`
Expected: 「单父多子时父节点水平居中」FAIL —— hub 现在硬排在最左（x = 28），不是居中。

- [ ] **Step 3: 加两个模块级私有函数**

放在 `nodeHeight` 之后、`assignLayers` 之前：

```js
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
```

- [ ] **Step 4: 改 `layoutMap` 的定位段**

居中会改动 x，所以 `maxRight` 不能在第一趟里边算边定，必须等居中做完再统一求。把定位段（`req-map-layout.logic.js:93-112`）替换为：

```js
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test public/js/req-map-layout.logic.test.js`
Expected: 全部 PASS（16 条存量 + 4 条新增）。存量的「画布尺寸能包住所有节点」「孤立节点与链共存」「无边时横向等距」都必须仍绿——它们正是居中改动的回归护栏。

---

## Task 5: 新增鸟瞰图坐标换算纯函数

**Files:**
- Create: `public/js/req-map-minimap.logic.js`
- Test: `public/js/req-map-minimap.logic.test.js`

- [ ] **Step 1: 写失败测试**

创建 `public/js/req-map-minimap.logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimapScale, viewportBox, panFromViewport, MM_W, MM_H } from './req-map-minimap.logic.js';

const CONTENT = { contentW: 2000, contentH: 1200 };

test('minimapScale 取两轴中更紧的那个', () => {
  assert.equal(minimapScale({ contentW: 2000, contentH: 1200 }), Math.min(MM_W / 2000, MM_H / 1200));
});

test('minimapScale 内容尺寸非法时退化为 1，不除零', () => {
  assert.equal(minimapScale({ contentW: 0, contentH: 0 }), 1);
});

test('viewportBox 与 panFromViewport 严格互逆', () => {
  const args = { panX: -320, panY: -180, zoom: 1.4, hostW: 900, hostH: 600, ...CONTENT };
  const box = viewportBox(args);
  const back = panFromViewport({ vx: box.x, vy: box.y, zoom: args.zoom, scale: box.scale });
  assert.ok(Math.abs(back.panX - args.panX) < 1e-9, 'panX 不互逆：' + back.panX);
  assert.ok(Math.abs(back.panY - args.panY) < 1e-9, 'panY 不互逆：' + back.panY);
});

test('panX 增大（画布右移）时视口框向左走 —— 方向不能反', () => {
  // 这就是用户报的「向右拖视口框，界面反而向左滚」的回归护栏
  const base = { panY: 0, zoom: 1, hostW: 900, hostH: 600, ...CONTENT };
  assert.ok(viewportBox({ ...base, panX: 200 }).x < viewportBox({ ...base, panX: 0 }).x);
});

test('放大时框变小，位置也按 zoom 同步折算', () => {
  const base = { panX: -400, panY: -200, hostW: 900, hostH: 600, ...CONTENT };
  const z1 = viewportBox({ ...base, zoom: 1 });
  const z2 = viewportBox({ ...base, zoom: 2 });
  assert.ok(z2.w < z1.w && z2.h < z1.h);
  assert.ok(Math.abs(z2.x - z1.x / 2) < 1e-9, '位置漏乘 zoom：' + z2.x);
});

test('zoom 为 0 或负数时退化为 1，不产出 Infinity', () => {
  const b = viewportBox({ panX: 0, panY: 0, zoom: 0, hostW: 900, hostH: 600, ...CONTENT });
  assert.ok(Number.isFinite(b.w) && Number.isFinite(b.h));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test public/js/req-map-minimap.logic.test.js`
Expected: FAIL —— `Cannot find module './req-map-minimap.logic.js'`。

- [ ] **Step 3: 实现**

创建 `public/js/req-map-minimap.logic.js`：

```js
/**
 * 鸟瞰图（Minimap）坐标换算 —— 纯函数，零 DOM（单测目标）。
 *
 * 主画布是 `transform-origin: 0 0` + `translate(panX,panY) scale(zoom)`，所以可视区左上角
 * 对应的**内容坐标**是 `-panX / zoom`（注意负号）。这段数学原先埋在 DOM 操作里，符号写反了
 * 也测不出来，用户拖视口框方向是反的 —— 抽出来就是为了让 viewportBox / panFromViewport
 * 的互逆关系能被断言。
 *
 * 有意不做边界钳制：`.rq-minimap` 本身 overflow:hidden，让框自然截断，比钳出一个和
 * panFromViewport 不互逆的值更诚实（钳过的值反推回去会让拖拽在贴边时跳一下）。
 */

export const MM_W = 200; // 与 CSS .rq-minimap 的 width 保持一致
export const MM_H = 150; // 与 CSS .rq-minimap 的 height 保持一致

/** 缩略比：整张地图塞进鸟瞰框，取两轴中更紧的那个。内容尺寸非法时退化为 1，避免除零。 */
export function minimapScale({ contentW, contentH, mmW = MM_W, mmH = MM_H }) {
  if (!(contentW > 0) || !(contentH > 0)) return 1;
  return Math.min(mmW / contentW, mmH / contentH);
}

/** 主画布视口 → 鸟瞰图坐标系里的框。 */
export function viewportBox({ panX, panY, zoom, hostW, hostH, contentW, contentH, mmW = MM_W, mmH = MM_H }) {
  const scale = minimapScale({ contentW, contentH, mmW, mmH });
  const z = zoom > 0 ? zoom : 1;
  return {
    scale,
    x: (-panX / z) * scale,
    y: (-panY / z) * scale,
    w: (hostW / z) * scale,
    h: (hostH / z) * scale,
  };
}

/** 鸟瞰图里的框位置 → 主画布 pan。viewportBox 的逆运算，两者必须严格互逆。 */
export function panFromViewport({ vx, vy, zoom, scale }) {
  const z = zoom > 0 ? zoom : 1;
  const s = scale > 0 ? scale : 1;
  return { panX: (-vx / s) * z, panY: (-vy / s) * z };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test public/js/req-map-minimap.logic.test.js`
Expected: 6 条全 PASS。

---

## Task 6: 鸟瞰图接上纯函数，修掉克隆污染与方向反转

**Files:**
- Modify: `public/js/req-map.js:10`（import）、`:90-212`（整个 Minimap 段）、`:267-276`（`fitView` 去重复调用）

- [ ] **Step 1: 加 import**

`public/js/req-map.js:10` 的 `import { layoutMap } from './req-map-layout.logic.js';` 之后加一行：

```js
import { viewportBox, panFromViewport } from './req-map-minimap.logic.js';
```

- [ ] **Step 2: 整段替换 `initMinimap` / `updateMinimapViewport`（`req-map.js:93-143`）**

```js
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
    mmContent.appendChild(canvasClone);

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
```

- [ ] **Step 3: 整段替换 `attachMinimapInteractions`（`req-map.js:145-212`）**

```js
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
```

- [ ] **Step 4: 把 `mmDrag` 的注释同步、清掉 `fitView` 的重复调用**

`req-map.js:91` 的 `let mmDrag = null; // Minimap 拖拽状态` 保留不动。

`fitView()`（`req-map.js:267-276`）末尾有 `applyTransform(); updateMinimapViewport();` 两连；`applyTransform()` 内部已经调了 `updateMinimapViewport()`，删掉多余那行（DRY）：

```js
    state.panY = TOP_INSET;
    applyTransform();
  }
```

同理删掉 `state.minimapScale` 在 `state` 初始化处的注释里对 Task 编号的引用（`req-map.js:47-48`），改成说清用途：

```js
    minimapScale: 1,                    // 鸟瞰图缩略比，由 viewportBox 算出后缓存给拖拽用
    minimapInteractionsAttached: false, // window 级监听只绑一次
```

- [ ] **Step 5: 跑全量测试**

Run: `npm test`
Expected: 全部 PASS（本任务只改 DOM 层，护栏是 Task 5 的纯函数测试）。

- [ ] **Step 6: 人工走查鸟瞰图**

启动 `npm start`，打开任一带地图的需求 → 需求地图：
1. 鸟瞰图里应显示**整张地图**的缩略图（不再是空白或错位）。
2. 视口框往右拖，主画布内容应向**左**滚（即看到右边的内容）。上下同理。
3. 主画布滚轮缩放时，视口框应同步变小/变大且位置跟得上。
4. 点击鸟瞰图空白处，主画布应跳到以该点为中心。

---

## Task 7: 鸟瞰图位置上移

**Files:**
- Modify: `public/css/req-v2.css:326-338`

- [ ] **Step 1: 改定位**

`.rq-minimap` 规则里两行改为（工具条在 `left: 14px; top: 14px`，一左一右不打架，上沿对齐更整齐）：

```css
  top: 14px;
  right: 14px;
```

- [ ] **Step 2: 人工确认**

刷新页面，鸟瞰图上沿应与左上角工具条上沿齐平，不被遮挡。

---

## Task 8: 连线加箭头 + 按层级路由

**Files:**
- Modify: `public/js/req-map.js:17-22`（加 `bezierAt` helper）、`:395-444`（`drawEdges`）

- [ ] **Step 1: 在 `el()` 之后加贝塞尔取点 helper**

```js
/** 三次贝塞尔在 t 处的点。只有连线标签定位这一个消费者，所以不单独开 logic 文件。 */
function bezierAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}
```

- [ ] **Step 2: 整体重写 `drawEdges()`（`req-map.js:395-444`）**

```js
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
```

- [ ] **Step 3: 跑全量测试**

Run: `npm test`
Expected: 全部 PASS。

---

## Task 9: 连线状态与箭头样式

**Files:**
- Modify: `public/css/req-v2.css:87-90`

- [ ] **Step 1: 替换连线样式段**

把这三行：

```css
.rq-edges path { fill: none; stroke: var(--border); stroke-width: 1.6; }
.rq-edges circle { fill: var(--border); }
.rq-elabel { fill: var(--faint); font-size: 10.5px; font-family: var(--mono, monospace); }
```

替换为（`.rq-edges circle` 整条删除——终点小圆点已被箭头 marker 取代）：

```css
/* 直接子选择器：不能让 fill:none 命中 <marker> 内部的箭头 path，否则箭头不可见 */
.rq-edges > path { fill: none; stroke: var(--border); stroke-width: 1.6; transition: stroke .12s, opacity .12s; }
.rq-edges > path.hl { stroke: var(--blue); stroke-width: 2.4; }
.rq-edges > path.dim { opacity: .22; }
.rq-ahead { fill: var(--border); }
.rq-ahead-hl { fill: var(--blue); }
.rq-elabel { fill: var(--faint); font-size: 10.5px; font-family: var(--mono, monospace); transition: fill .12s, opacity .12s; }
.rq-elabel.hl { fill: var(--blue); }
.rq-elabel.dim { opacity: .22; }
```

- [ ] **Step 2: 人工走查连线**

启动后打开需求地图：
1. 每条连线终点应有实心箭头，方向朝目标页面。
2. 父页面在上、子页面在下的连线应从**下沿出、上沿进**（不再绕到侧面）。
3. 点击「游戏广场」节点头部：它的出边应变蓝加粗、其余连线淡出到几乎看不见。
4. 关闭抽屉（✕ 或 Esc）后，所有连线恢复常态色。

---

## Task 10: 入口页徽标

**Files:**
- Modify: `public/js/req-map.js:328-347`（`renderNodes` 头部与 `rq-ntop` 段）、`public/css/req-v2.css:138-139`

- [ ] **Step 1: 在 `renderNodes()` 开头取入口集合**

`nodesBox.innerHTML = '';` 之后加一行：

```js
    const entrySet = new Set(layout.entries || []);
```

- [ ] **Step 2: 在 `rq-ntop` 里插徽标**

把 `top.appendChild(el('span', 'rq-nname', page.name));` 之后、`if (page.state === 'new')` 之前插入：

```js
      // 「入口」放在最前：先告诉用户从哪进来，再说这页是新增还是有稿
      if (entrySet.has(page.id)) top.appendChild(el('span', 'rq-nflag rq-entry', '入口'));
```

- [ ] **Step 3: 加样式**

在 `public/css/req-v2.css:139` 的 `.rq-nflag.rq-figma` 之后加一行：

```css
.rq-nflag.rq-entry { background: rgba(108, 195, 138, 0.16); color: var(--green); }
```

（`--green: #6cc38a` 定义在 `public/app.css:15`，与 `.rq-nflag.rq-figma` 用 `--blue` 同一个套路。）

- [ ] **Step 4: 跑测试 + 人工确认**

Run: `npm test`
Expected: 全部 PASS。

人工：入度为 0 的页面（如「游戏广场」）头部应出现绿色「入口」徽标；全图成环时一枚都不出现。

---

## Task 11: 抽屉增「从哪来 / 去哪」

**Files:**
- Modify: `public/js/req-map.js:560-593`（`openPage`）、`public/css/req-v2.css:225` 之后

- [ ] **Step 1: 加 `buildLinkSection`**

放在 `buildFigmaSection` 之前：

```js
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
```

- [ ] **Step 2: 在 `openPage` 里挂上**

`dBody.appendChild(buildFigmaSection(page));` 之后插入：

```js
    const edges = map.edges || [];
    dBody.appendChild(
      buildLinkSection('从哪来', edges.filter((e) => e.to === id).map((e) => ({ pid: e.from, label: e.label }))),
    );
    dBody.appendChild(
      buildLinkSection('去哪', edges.filter((e) => e.from === id).map((e) => ({ pid: e.to, label: e.label }))),
    );
```

- [ ] **Step 3: 加样式**

`public/css/req-v2.css:225`（`.rq-jump-item i { ... }`）之后加一行。注意 `.rq-jump-item i` 已经把 `i` 设成了等宽粗体（那是逻辑点符号 `＋/~/－` 用的），跳转动作要覆盖掉：

```css
.rq-jump-item i.rq-elink { font-family: inherit; font-weight: 400; font-size: 11.5px; color: var(--faint); }
```

- [ ] **Step 4: 跑测试 + 人工确认**

Run: `npm test`
Expected: 全部 PASS。

人工：点开「今晚吃什么转盘」，抽屉里「从哪来」应有一行「游戏广场 · 点击 今晚吃什么」，点它切到游戏广场抽屉，且画布高亮同步跟随；「去哪」为空时显示「无」。

---

## Task 12: 端到端走查

**Files:** 无（纯验证）

- [ ] **Step 1: 跑全量测试**

Run: `npm test`
Expected: 全部 PASS，无 skip。

- [ ] **Step 2: 用真实需求重新生成一次地图**

拿 v5.8 小游戏这个需求，在需求详情里重新触发一次地图生成（或提交一次标注让 AI 修订），因为**历史版本落盘的 `edges` 已经是空数组**，修复只作用于新生成的版本。

- [ ] **Step 3: 逐条核对**

1. 「游戏广场」有绿色「入口」徽标，并且**位于所有子游戏页面之上、水平居中**。
2. 广场到每个子游戏页各有一条带箭头的连线，箭头指向子页面，标签是用户动作。
3. 点击广场节点，它的出边全部变蓝加粗，无关连线淡出。
4. 点开任一子游戏页，抽屉「从哪来」列着「游戏广场 · 点击 …」。
5. 鸟瞰图在右上角与工具条上沿齐平，显示整张地图，拖拽方向正确。
6. 「适应」按钮仍能把整张图缩进可视区，工具条不压住第一层节点。

- [ ] **Step 4: 把没通过的项回报给用户，不要自行扩大改动范围**

---

## 执行记录（2026-08-26）

Task 1–11 全部完成。全量测试 **1545 tests / 1543 pass / 2 fail**，2 条失败是仓库既有问题
（`public/js/chat.path.test.js` 的中文路径截断，把 `chat.js` 暂存回 HEAD 后依然失败，与本次无关）。

### 与计划的两处偏离

1. **新增 `public/js/req-map.edges.test.js`（9 条 jsdom 回归测试）。** 计划原写「渲染层靠人工走查」，
   但项目已有 `req-view.sessiontree.test.js` 这个先例：用户报的 bug 落成 jsdom 回归测试并在头注释
   里写清背景。连线渲染完全可以这样锁住，比让用户眼看更可靠。覆盖：边数与箭头 marker、
   marker 的 SVG 命名空间、父子连线走纵向的精确端点、hub 居中、选中高亮/淡出、入口徽标、
   抽屉上下游、空上游占位。

2. **`initMinimap` 里多删一行克隆体的 `<defs>`。** 写测试时发现鸟瞰图的 `cloneNode(true)` 会把
   `marker#rq-arrow` 一起复制，导致同一个 id 在文档里出现两份。功能上无害（两份 marker 内容
   一样），但属实打实的 id 撞车，顺手删掉克隆体的 defs——克隆体的 `marker-end` 自然引用主画布
   那份。已由「鸟瞰图克隆体不复制 defs」一条测试锁住。

   写测试时踩到的坑值得记下来：`.rq-minimap` 在骨架里排在 `.rq-canvas-host` **之前**，所以
   任何全文档选择器（`.rq-node` / `.rq-edges > path`）都会优先命中那份**没有事件监听**的克隆体。
   测试里一律限定在 `.rq-canvas-host` 内。

### 仍需人工确认的项

鸟瞰图拖拽方向已由 `req-map-minimap.logic.test.js` 的纯函数测试锁住（含「panX 增大时框向左走」
这条专门的回归护栏），但下面几项必须在真实应用里看：

- 鸟瞰图上沿与工具条齐平、缩略图显示整张地图（Task 6 Step 6 / Task 7 Step 2）
- 连线在真实数据下的观感：箭头、label 是否还有重叠（Task 9 Step 2）
- **端到端（Task 12 Step 2–3）：历史版本落盘的 `edges` 已是空数组，必须重新触发一次地图生成
  才能验证。这一步会消耗 LLM 额度，留给用户决定何时跑。**

---

## 自查：Spec 覆盖对照

| Spec 章节 | 落到哪个 Task |
|---|---|
| §1.1 边端点按 name 解析、id 兜底、去重键用 id、同名取首个 | Task 1 |
| §1.2 契约强化四条 | Task 2 |
| §2.1 外露 `layerOf` / `entries` | Task 3 |
| §2.2 父节点居中 + 保序推挤 + 多父近似 | Task 4 |
| §3.1 箭头 / 按层路由 / 选中高亮 / label 位置 | Task 8（渲染）+ Task 9（样式） |
| §3.2 入口徽标 + 成环时不打 | Task 10 |
| §3.3 抽屉上下游 | Task 11 |
| §4.1 克隆 transform 中和 | Task 6 Step 2 |
| §4.2 视口框数学抽纯函数 | Task 5 |
| §4.3 去边界钳制 + 尺寸常量收拢 | Task 5（常量）+ Task 6 Step 3 |
| §4.4 位置上移 | Task 7 |
| §5 样式 | Task 9 / 10 / 11 |
| 测试策略三张表 | Task 1 / 3 / 4 / 5 |

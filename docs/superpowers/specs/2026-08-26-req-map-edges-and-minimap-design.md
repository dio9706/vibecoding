# 需求地图页面关联与鸟瞰图修复设计

**日期:** 2026-08-26
**作者:** AI + User
**版本:** 1.0

---

## 需求概述

需求地图目前能把「哪个页面的哪个逻辑点被改了」标出来，但**页面之间的关联完全缺失**。以
v5.8 小游戏需求为例：游戏广场是所有子游戏的唯一入口，其余几个页面都要从它点击跳转进来，
而地图上这几个页面只是平铺的卡片，没有任何一条线表达这层关系。

同时用户在使用鸟瞰图（Minimap）时发现两个问题：拖拽视口框的方向是反的，以及鸟瞰图的
位置偏低、还有上移空间。

**目标：**

1. 恢复页面跳转连线，并让链路在画布上一眼可读（方向、层级、选中联动）。
2. 修掉鸟瞰图的方向反转与内容错位，位置上移。

---

## 根因分析

### 1. 连线不是「没产出」，而是「被丢掉了」

`src/entrypoints/web/req-map.logic.js` 里 prompt 契约与实现对边端点的口径不一致：

- 契约（`mapOutputContract`）要求 `edges` 的 `from` / `to` **精确等于某个 page 的 `name`**。
- 实现（`normalizeMap`）却按 **`page.id`** 校验：

```js
const pageIds = new Set(pages.map((p) => p.id));   // p1 / p2 / p3…（自动生成，LLM 不产出）
...
.filter((e) => pageIds.has(e.from) && pageIds.has(e.to) && e.from !== e.to)
```

LLM 按契约给的是「游戏广场」这类中文名，`pageIds` 里装的是自动编号，因此**所有边一条不剩
地被过滤掉**。连带产生第二个后果：`layoutMap` 拿不到 edges，所有页面入度都是 0，全部落在
第 0 层横排一行——这正是用户截图里看到的「一排平铺卡片」。

现有单测 `req-map.logic.test.js` 的三条 edges 用例全部用 id 造数据（`pages` 的 id 直接写
成 `'a'` / `'b'`），恰好绕过了这个分歧，所以测试全绿而线上全挂。**这是本次要一并修正的
测试盲区**，不只是改实现。

### 2. 鸟瞰图的两处数学错误 + 一处克隆污染

`.rq-canvas` 是 `transform-origin: 0 0`，`transform: translate(panX, panY) scale(zoom)`。
因此主画布可视区左上角对应的**内容坐标**是 `-panX / zoom`。

| 问题 | 现状 | 应为 |
|---|---|---|
| 方向反转 | `panX = newVx / minimapScale`（正相关） | 负相关：`panX = -vx / scale * zoom` |
| 漏乘 zoom | 视口框宽高除了 `zoom`（`hostW / zoom`），位置没除 | 位置同样要除 `zoom`，否则缩放后框的位置与大小对不上 |
| 克隆污染 | `canvas.cloneNode(true)` 复制了内联 `transform`，缩略图自身又被平移缩放一遍 | 克隆后中和为 `transform: none` |

第三条是截图里「鸟瞰图内容跑到框外、几乎空白」的直接原因。

---

## 方案选择

链路完整性的保障手段评估过三种：

| 方案 | 做法 | 取舍 | 选择 |
|---|---|---|---|
| A | 修 bug + 强化 prompt 契约 | 最小改动，先看真实需求跑出来的效果 | ✅ |
| B | A + 独立的「链路补全」LLM 轮次 | 链路更稳，代价是每次生成多一次往返和一条失败路径 | ❌ 暂不做 |
| C | A + 前端手动连线编辑 | 能补 AI 的漏，但要处理「手工边 vs 下一版 AI 全量重出」的合并 | ❌ 暂不做 |

**采用方案 A。** B / C 都是在「模型产不出好链路」这个假设上加码，而这个假设尚未被验证——
真正的原因是边被代码丢了。先修正确性，再看是否需要加码（YAGNI）。

---

## 详细设计

### 一、数据层：`src/entrypoints/web/req-map.logic.js`

#### 1.1 边端点按 name 解析、id 兜底

在 `normalizeMap` 里建 `name → id` 索引，逐条边解析两端：

1. 先按 name 查索引；
2. 查不到则当作 id 直接匹配（兼容历史数据与偶尔按 id 输出的模型）；
3. 两端都解析成功、且解析后不是自环，才保留；
4. 落盘的 `edges` 统一存**解析后的 id**，渲染层与布局层的口径不变。

**去重键改用解析后的 id 对**（`${fromId}>${toId}`）。否则同一对页面一次用 name、一次用 id
表达时会被判成两条不同的边，画布上出现重影。

同名页面的处理：`uniqueId` 已保证 id 唯一，但 name 可能重复。name 索引取**首次出现**的那
个。这种输入本身说明模型产出有问题，不额外补救——保持行为可预测比猜用户意图更重要。

#### 1.2 契约强化（`mapOutputContract`）

edges 从「顺带提一句」升级为硬性要求，新增四条：

- 必须标出入口页（用户从哪进入这次需求涉及的功能）。
- 除入口页外，每个页面至少要有一条入边；确实无法到达的要说明。
- hub 型页面（如游戏广场）必须把**全部**下钻链路列全，不能只列改动最大的那几条。
- `label` 写用户动作（「点击 今晚吃什么」），不写技术描述（「router.push」）。

### 二、布局层：`public/js/req-map-layout.logic.js`

#### 2.1 外露层级与入口

`layoutMap` 内部已经算出 `indeg` 与 `layer`，但只返回 `layers`。改为额外返回：

- `layerOf: Map<string, number>` —— 渲染层判断连线走向要用；
- `entries: string[]` —— 入度为 0 的页面 id，用于打「入口」徽标。

渲染层复用这两份结果，不再重复遍历一遍 edges（DRY）。

#### 2.2 父节点居中对齐

现状是每层从左往右硬排，hub 会被顶到最左，视觉上不像「父」。改为两趟：

1. 第一趟保持现有基线排布（同层保序、等距）；
2. 第二趟**自底向上**，把每个父节点的**中心 x** 设为其直接子节点**中心 x 的均值**，再换算回
   左上角坐标（节点宽固定为 `NODE_W`，换算就是减 `NODE_W / 2`）；
3. 每次调整后对该层做**保序防重叠推挤**，最小间距 `NODE_W + GAP_X`。

一个节点有多个父节点时，各父节点各自按自己的子集居中，互不协调——这是可接受的近似，不引入
全局最优排布算法（那是另一个量级的复杂度，YAGNI）。

保序推挤而不是重新排序，是为了保住现有「同层维持 pages 原始顺序」的性质——否则每次生成
地图左右乱跳，用户无法比对版本差异。

成环兜底逻辑（`assignLayers` 里的 BFS 铺开）保持不变。

### 三、渲染层：`public/js/req-map.js`

#### 3.1 `drawEdges()`

1. **箭头**：`<defs>` 内两个 `marker`（常态 / 高亮），替掉现在的终点 3px 小圆点。方向不再
   靠猜。
2. **按层路由**，不再按 `|dx| > |dy|` 判断走向。现状下 hub 连最左侧子页时 `|dx|` 会大于
   `|dy|`，被判成「横向：右边→左边」，画出一条绕行的怪线。改为：`layerOf[to] > layerOf[from]`
   走纵向（下沿→上沿），同层才走横向。
3. **选中高亮**：每条 path 挂 `data-from` / `data-to`。当 `state.sel.kind === 'page'` 时，
   命中该页的边加 `.hl`（加粗、换色、换高亮 marker），其余加 `.dim`（降透明度）。复用已有
   的 `renderNodes()` 重绘路径，不新增事件监听。
4. **label 位置**从路径中点挪到贝塞尔 `t ≈ 0.75`（靠近目标端）。hub 有 5 条出边时中点全挤
   在一处，靠近目标端会随目标散开。

**只做点击选中高亮，不做 hover。** hover 要另加一套监听与节流，收益不足。

#### 3.2 入口徽标

`entries` 中的页面在 `.rq-ntop` 追加一枚「入口」徽标，复用现有 `.rq-nflag` 样式体系（与
`新页面` / `🎨 已挂稿` 并列）。

全图成环（所有页面入度都 > 0）时 `entries` 为空，一枚徽标都不打——不去猜「哪个更像入口」。
布局仍由 `assignLayers` 的成环兜底分支保证画得出来。

#### 3.3 抽屉增「从哪来 / 去哪」

`openPage()` 的抽屉里增两节可点击列表，每行 `页面名 · 跳转 label`，点击切到目标页面的抽屉。
非技术人员不看连线也能读懂链路，这是本次投入产出比最高的一项。

### 四、鸟瞰图

#### 4.1 中和克隆体 transform

`initMinimap()` 中克隆后立即 `canvasClone.style.transform = 'none'`。克隆保留了
`width` / `height`（即 `layout.size`），中和后就是 1:1 全图，再由 `.rq-minimap-content`
统一施加 `minimapScale`。

#### 4.2 视口框数学抽成纯函数

新增 `public/js/req-map-minimap.logic.js`，两个互逆的纯函数：

```js
viewportBox({ panX, panY, zoom, hostW, hostH, contentW, contentH, mmW, mmH })
  → { scale, x, y, w, h }

panFromViewport({ vx, vy, zoom, scale }) → { panX, panY }
```

核心关系：`x = -panX / zoom * scale`，`w = hostW / zoom * scale`，
`scale = min(mmW / contentW, mmH / contentH)`。

两者严格互逆，可以直接写往返测试。**这个 bug 之所以能上线，就是因为这段数学埋在 DOM 操作
里无法单测**——抽出来是修复的一部分，不是附带重构。

#### 4.3 去掉视口框边界钳制

现状把框钳制在 `0 ~ mmW - vw`，而反推 pan 时不钳制，两边不对称：一旦贴边，拖拽就会跳。
`.rq-minimap` 本身是 `overflow: hidden`，让框自然被截断更诚实，也省掉一半代码（KISS）。

顺带把散落在 `initMinimap` / `updateMinimapViewport` / `attachMinimapInteractions` 三处的
硬编码 `mmW = 200` / `mmH = 150` 收成模块常量。

#### 4.4 位置上移

`.rq-minimap` 的 `top: 52px → 14px`，`right: 10px → 14px`。工具条在 `left: 14px; top: 14px`，
两者一左一右不打架，上沿对齐更整齐。

### 五、样式：`public/css/req-v2.css`

- `.rq-edges` 新增 `marker` 相关样式、`.hl` / `.dim` 两个连线状态。
- 入口徽标沿用 `.rq-nflag`，只加一个色彩变体。
- 抽屉「从哪来 / 去哪」列表复用现有 `.rq-jump` / `.rq-jump-item`。
- `.rq-minimap` 定位调整。

---

## 测试策略

| 文件 | 覆盖点 |
|---|---|
| `src/entrypoints/web/req-map.logic.test.js` | name 边能留下；name / id 混用能解析；跨表达方式的重复边去重；同名页面取首次出现。**现有三条纯 id 用例改名为显式的「id 兜底」用例**——它们原本掩盖了本次的 bug，要留下但把意图写清 |
| `public/js/req-map-layout.logic.test.js` | 父节点居中；同层防重叠不破坏 pages 原始顺序；`entries` / `layerOf` 正确；成环不死循环（回归） |
| `public/js/req-map-minimap.logic.test.js`（新） | `viewportBox` / `panFromViewport` 往返互逆；缩放后位置与尺寸同步变化；内容小于鸟瞰图时的 scale |

渲染层（`req-map.js`）继续不做单测——项目既有约定是纯逻辑抽到 `.logic.js` 单测、DOM 层靠
人工走查。本次把可测的数学都抽了出来，符合这个约定。

---

## 明确不做

- 手动连线编辑（用户在画布上拖边）
- 独立的「链路补全」LLM 轮次
- 连线 hover 高亮
- 鸟瞰图从 DOM 克隆重构为简化 SVG 自绘

---

## 影响面

| 文件 | 改动 |
|---|---|
| `src/entrypoints/web/req-map.logic.js` | 边解析按 name + 契约强化 |
| `src/entrypoints/web/req-map.logic.test.js` | 补测 + 纠正误导性用例 |
| `public/js/req-map-layout.logic.js` | 外露 `layerOf` / `entries`；父节点居中 |
| `public/js/req-map-layout.logic.test.js` | 补测 |
| `public/js/req-map-minimap.logic.js` | 新增 |
| `public/js/req-map-minimap.logic.test.js` | 新增 |
| `public/js/req-map.js` | 箭头 / 按层路由 / 选中高亮 / 入口徽标 / 抽屉上下游 / 鸟瞰图接线 |
| `public/css/req-v2.css` | 连线状态、入口徽标、鸟瞰图定位 |

**向后兼容：** 历史地图 JSON 里的 edges 若已是 id 形式，走 1.1 的 id 兜底分支，行为不变；
若是 name 形式（此前全被丢弃，落盘的 `edges` 为空数组），本次修复后重新生成地图即可恢复，
无需数据迁移。

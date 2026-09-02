# Task 8: 通用地图画布内核 — 实现规格

> 提案日期：2026-09-02  
> 基础：Tasks 1-7 后端三件套已完成（生成/加载/搜索模块）

## 背景与目标

现有 `req-map.js`（809 行）内含「需求地图特有的页面/逻辑点/标注」逻辑与「通用的缩放/平移/minimap/连线绘制」耦合在一起。计划要拆出**通用画布内核** `map-canvas.js`，供「需求地图」和「项目地图」两套适配层复用，避免代码重复和维护成本。

## 改动范围与原则

### 新建文件

- **`public/js/map-canvas.js`**（约 200-250 行）
  通用画布内核，职责限于：
  - minimap 与 viewport 拖拽（复用 `req-map-minimap.logic.js`）
  - 滚轮缩放（0.35~1.8）与 fitView
  - SVG 贝塞尔连线与箭头（支持标签定位）
  - 节点位置与选中态渲染（无样式，靠 callback 注入）
  - 事件分发（nodeClick/nodeHover，约束在节点元素范围内）
  - 导出 API：`createMapCanvas(container, {nodes, edges, renderNode, onNodeClick, onNodeHover})`
  
  **不含**：
  - 页面/逻辑点/标注业务逻辑
  - 需求地图的「版本选择」「重新生成」「提交标注」等按钮
  - 滤镜、收起节点等交互复杂度

### 修改现有文件

- **`req-map.js`**（目标从 809 行降至 400-500 行）
  改为「需求地图适配层」，职责：
  - 调 `createMapCanvas` 建画布（传 pages 作 nodes）
  - 实现 `renderNode` callback（页面卡片样式、逻辑点徽章、标注提示）
  - 绑定 onNodeClick（打开详情抽屉）、onNodeHover（高亮依赖关系）
  - 保留「版本选择」「重新生成」「提交标注」「标注编辑」逻辑
  - 保留 minimap 交互的"拖拽视口"绑定（`mapCanvas` 会暴露这个能力）
  
  **删除**：缩放按钮、连线绘制、小数据结构（都交给 `map-canvas`）

- **`public/index.html`** / **`public/js/app.js`**（可能）
  若需求地图从内嵌报告改为浮层，涉及 DOM 挂载位置改动，但这是既有功能的交互调整，**暂不涉及**本次提炼。

### 不改

- `req-map-minimap.logic.js`、`req-map-layout.logic.js` —— 复用不动
- 需求地图的现有 API（`mountMap(container, opts)`）—— 对上层无感

## 实现细节

### `createMapCanvas(container, opts)` 签名与行为

```js
function createMapCanvas(container, {
  nodes,        // [{id, x, y, width, height, data?}]
  edges,        // [{from, to, label?}]
  renderNode,   // (node, el) => void  ← 适配层提供，负责内容样式
  onNodeClick,  // (nodeId) => void
  onNodeHover,  // (nodeId, isHover) => void
}) {
  // 返回 api 对象
  return {
    setNodes(newNodes),       // 更新节点（触发重绘）
    highlightNodes(ids),      // 高亮指定节点，其余降透明度
    fitView(),                // 自动缩放/平移使全图可见
    zoom(factor),             // 缩放（相对当前）
    pan(dx, dy),              // 平移
    getMinimapViewport(),     // 返回 {x, y, width, height}，供外层拖拽用
    setMinimapViewportDrag(handler),  // (fromX, fromY, toX, toY) => 绘制与事件绑定
    destroy(),                // 清理 DOM & 监听
    getScale(),               // 返回当前缩放倍数
  }
}
```

### 核心渲染逻辑

1. **节点渲染**：
   - 为每个 node 创建 `<div class="rq-node">` 在 `.rq-nodes` 内
   - 位置与缩放由画布控制（transform 或 absolute）
   - 内容由 `renderNode(node, el)` callback 注入（适配层负责）
   - 点击/悬停绑定在容器，但事件判定要确保仅在 node 元素内触发

2. **连线渲染**：
   - SVG `<path>` 贝塞尔曲线（参考现有 `bezierAt` 函数）
   - 箭头用 `<defs><marker>` + `marker-end` 或纯路径
   - 标签（`edge.label`）定位在曲线中点，用 `textContent` 落地（无 innerHTML）

3. **Minimap**：
   - 复用 `viewportBox(viewport, boundingBox)` 获得缩略框坐标
   - viewport 拖拽时调 `onMinimapDrag(x, y)` 回调，画布自动 pan
   - 鸟瞰图内容是一份 SVG 的等比缩小副本（或者彩色方块快速渲染）

### 测试策略

- **单元测试**（`public/js/map-canvas.test.js`）
  - 渲染/重绘/setNodes 的 DOM 结构验证（无需 LLM）
  - 坐标计算验证（缩放/平移的数学正确性）
  - 事件分发验证（nodeClick 仅在节点元素内触发）
  
- **集成测试**（`req-map.js` 的既有测试）
  - 保证 `req-map` 的现有行为不变（作为适配层的回归防线）

## 风险与防护

| 风险 | 防护 |
|---|---|
| 需求地图功能破坏 | 执行 `npm test` 覆盖 req-map 现有测试（若有），或手工走一遍「评审期打开需求地图」全流程 |
| 提炼不彻底，内核还是耦合业务 | Code review 清单：map-canvas.js 内是否出现 `annots`/`flags`/`versions` 等需求特有概念？ |
| 新内核与适配层接口不稳定 | 实现 project-map 适配层时如发现接口缺口（onNodeHover 不够用、需要更多事件），回头微调内核，但不追溯改 req-map |

## 交付物清单

- `public/js/map-canvas.js`（通用内核）+ `public/js/map-canvas.test.js`（单测）
- `public/js/req-map.js`（精简版，400-500 行，删除通用逻辑）
- 可选：`public/js/map-canvas-logic.js`（如果有独立的坐标/布局计算值得拆出）
- 验收：全量 `npm test` 通过，需求地图在浏览器里「评审期」打开、标注、提交的全流程正常

## 后继计划

Task 9（project-map 适配层）将调 `createMapCanvas` 构造项目地图，模式与 req-map 类似：
- `renderNode` 显示模块卡片（名称/路径/描述/依赖标签）
- `onNodeClick` 打开模块详情抽屉
- 搜索框高亮节点（调 `highlightNodes`）
- 「添加到对话」按钮（待后端注入对话接口完成后）

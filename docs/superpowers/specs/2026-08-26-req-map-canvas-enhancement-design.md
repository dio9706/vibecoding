# 需求地图画布增强设计

**日期:** 2026-08-26  
**作者:** AI + User  
**版本:** 1.0

---

## 需求概述

用户在使用需求地图时面临两个核心痛点：

1. **缩放不易发现** — 只能点击按钮缩放，用户习惯的"滚轮缩放"不可用（需要 Ctrl 修饰键）
2. **大画布难以导航** — 地图很大时，要频繁拖拽才能看到其他区域，没有全局视图

**目标:** 
- 支持纯滚轮缩放（无需 Ctrl 修饰键）
- 添加右上角 Minimap（缩略图），提供全局导航能力

---

## 方案选择

### 评估的三个方案

| 方案 | 实现方式 | 优点 | 缺点 | 选择 |
|------|--------|------|------|------|
| A | 纯 Canvas 自绘 | 渲染轻量 | 坐标换算复杂 | ❌ |
| B | DOM 缩放版 | 零重复、代码少 | 字会模糊（不影响） | ✅ |
| C | SVG 重绘 | 矢量清晰 | 维护成本最高 | ❌ |

**采用方案 B：DOM 缩放版**

---

## 整体架构

### 功能分解

1. **Minimap 模块**
   - 挂载点：`rq-map` 容器内新增 `.rq-minimap` 容器
   - 内容：原 `rq-canvas` 的 DOM 克隆，通过 CSS `scale` 缩小显示
   - 视口框：绝对定位的 `<div>`，实时反映主画布的 panX/panY/zoom

2. **滚轮缩放优化**
   - 移除 `ctrlKey` 限制，直接响应滚轮
   - 工具条添加提示：「🔍 鼠标滚轮缩放」

### 坐标系统

**Minimap 缩放比计算:**
```
mmW = 200px（Minimap 宽）
mmH = 150px（Minimap 高）
layoutW = layout.size.w（地图实际宽）
layoutH = layout.size.h（地图实际高）

minimapScale = min(mmW / layoutW, mmH / layoutH)
```

**视口框位置倒推:**
```
Minimap 坐标系中的视口框位置：
  vx = panX × minimapScale
  vy = panY × minimapScale
  vw = (host.clientWidth / zoom) × minimapScale
  vh = (host.clientHeight / zoom) × minimapScale

主画布坐标系中的 panX/panY：
  panX = vx / minimapScale
  panY = vy / minimapScale
```

---

## 交互设计

### 2.1 Minimap 导航

**拖拽视口框：**
```
1. 用户鼠标按住视口框（mousedown）
2. 记录拖拽起点和视口框的初始位置
3. mousemove 时，计算新的视口框位置（限制在 Minimap 边界内）
4. 倒推主画布的 panX/panY
5. 调用 applyTransform() 更新主画布
6. mouseup 时释放
```

**点击 Minimap：**
```
1. 用户点击 Minimap 上任意位置
2. 计算点击位置相对 Minimap 的坐标
3. 将视口框中心对准该点
4. 倒推 panX/panY，同步主画布
```

### 2.2 滚轮缩放

**移除 Ctrl 限制：**
```
当前：
  if (!e.ctrlKey && !e.metaKey) return;  // 需要 Ctrl

改为：
  e.preventDefault();  // 直接拦截，无条件缩放
```

**新增提示：**
- 工具条左侧添加小图标：「🔍 鼠标滚轮缩放」
- 可选：hover 时显示气泡提示

---

## 实现细节

### 3.1 HTML 结构

在 `req-map.js` 的 `container.innerHTML` 赋值中添加：

```html
<div class="rq-minimap">
  <div class="rq-minimap-content">
    <!-- rq-canvas 将被克隆到这里 -->
  </div>
  <div class="rq-minimap-viewport">
    <!-- 视口框（蓝色矩形） -->
  </div>
</div>
```

### 3.2 CSS 样式

```css
.rq-minimap {
  position: absolute;
  top: 52px;            /* 工具条下方 */
  right: 10px;
  width: 200px;
  height: 150px;
  border: 1px solid #ccc;
  background: #f9f9f9;
  overflow: hidden;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  z-index: 10;
}

.rq-minimap-content {
  width: 100%;
  height: 100%;
  transform-origin: 0 0;
  position: relative;
  /* 实际 scale 由 JS 动态计算 */
}

.rq-minimap-viewport {
  position: absolute;
  border: 2px solid #2563eb;
  background: rgba(37, 99, 235, 0.1);
  cursor: grab;
  box-sizing: border-box;
}

.rq-minimap-viewport:active {
  cursor: grabbing;
  background: rgba(37, 99, 235, 0.2);
}
```

### 3.3 JavaScript 关键函数

#### 初始化 Minimap

```javascript
function initMinimap() {
  const mmContent = root.querySelector('.rq-minimap-content');
  const mmViewport = root.querySelector('.rq-minimap-viewport');
  
  const mmW = 200, mmH = 150;
  const scale = Math.min(mmW / layout.size.w, mmH / layout.size.h);
  state.minimapScale = scale;
  
  // 克隆 rq-canvas 进 Minimap（节点 + SVG 连线一起复制）
  const canvasClone = canvas.cloneNode(true);
  mmContent.appendChild(canvasClone);
  mmContent.style.transform = `scale(${scale})`;
  
  // 初始化视口框
  updateMinimapViewport();
  
  // 绑定交互
  attachMinimapInteractions();
}
```

#### 更新视口框位置和大小

```javascript
function updateMinimapViewport() {
  const mmViewport = root.querySelector('.rq-minimap-viewport');
  const mmW = 200, mmH = 150;
  
  // Minimap 坐标系中的视口框
  const vx = state.panX * state.minimapScale;
  const vy = state.panY * state.minimapScale;
  const vw = (host.clientWidth / state.zoom) * state.minimapScale;
  const vh = (host.clientHeight / state.zoom) * state.minimapScale;
  
  // 约束在 Minimap 边界内
  const constVx = Math.max(0, Math.min(mmW - vw, vx));
  const constVy = Math.max(0, Math.min(mmH - vh, vy));
  
  mmViewport.style.left = constVx + 'px';
  mmViewport.style.top = constVy + 'px';
  mmViewport.style.width = Math.max(0, vw) + 'px';
  mmViewport.style.height = Math.max(0, vh) + 'px';
}
```

#### Minimap 拖拽交互

```javascript
function attachMinimapInteractions() {
  const mmViewport = root.querySelector('.rq-minimap-viewport');
  const mmW = 200;
  
  let drag = null;
  
  mmViewport.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    drag = {
      x: e.clientX,
      y: e.clientY,
      startVx: parseFloat(mmViewport.style.left),
      startVy: parseFloat(mmViewport.style.top),
    };
  });
  
  const onMove = (e) => {
    if (!drag) return;
    
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    const vw = parseFloat(mmViewport.style.width);
    const vh = parseFloat(mmViewport.style.height);
    
    // 新的视口框位置（约束在 Minimap 边界）
    const newVx = Math.max(0, Math.min(mmW - vw, drag.startVx + dx));
    const newVy = Math.max(0, Math.min(150 - vh, drag.startVy + dy));
    
    // 倒推主画布的 panX/panY
    state.panX = newVx / state.minimapScale;
    state.panY = newVy / state.minimapScale;
    
    applyTransform();
  };
  
  const onUp = () => {
    drag = null;
  };
  
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  
  // Minimap 点击跳转
  root.querySelector('.rq-minimap').addEventListener('click', (e) => {
    if (e.target === mmViewport) return; // 拖拽视口框时不跳转
    
    const rect = root.querySelector('.rq-minimap').getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    const vw = parseFloat(mmViewport.style.width);
    const vh = parseFloat(mmViewport.style.height);
    
    // 新视口框位置（居中）
    const newVx = Math.max(0, Math.min(200 - vw, clickX - vw / 2));
    const newVy = Math.max(0, Math.min(150 - vh, clickY - vh / 2));
    
    state.panX = newVx / state.minimapScale;
    state.panY = newVy / state.minimapScale;
    
    applyTransform();
  });
}
```

#### 滚轮缩放（移除 Ctrl 限制）

```javascript
// 原代码：
// host.addEventListener('wheel', (e) => {
//   if (!e.ctrlKey && !e.metaKey) return;
//   e.preventDefault();
//   ...
// });

// 改为：
host.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.zoom - Math.sign(e.deltaY) * 0.08));
    applyTransform();
    updateMinimapViewport();
  },
  { passive: false },
);
```

---

## 对现有代码的影响

### 修改文件

- **`public/js/req-map.js`** — 主要修改
  - 移除 wheel 事件的 `ctrlKey` 检查
  - 添加 Minimap 初始化和交互函数
  - 每次 `applyTransform()` 后调用 `updateMinimapViewport()`

### 新增样式

- **`public/css/req-map.css`** 或相关样式文件
  - 添加 `.rq-minimap` 系列 CSS（约 40 行）
  - 可选：为工具条添加滚轮缩放提示图标

### 版本号管理

无需改动版本号（仅是 UI 增强，不涉及地图数据结构）。

---

## 测试要点

### 单元测试

1. **Minimap 缩放比计算**
   - ✅ 不同 `layout.size` 下，缩放比是否为 `min(200/w, 150/h)`
   - ✅ 极端情况（地图很小或很大）

2. **坐标转换**
   - ✅ Minimap 坐标 → 主画布 panX/panY 的倒推是否正确
   - ✅ 视口框尺寸随 zoom 变化是否正确

### 交互测试

3. **拖拽视口框**
   - ✅ 能否顺畅拖拽
   - ✅ 是否约束在 Minimap 边界内
   - ✅ 主画布是否同步更新

4. **点击 Minimap 跳转**
   - ✅ 点击后视口框是否居中
   - ✅ 主画布是否正确滚动

5. **滚轮缩放**
   - ✅ 任何位置滚轮都能缩放（无需 Ctrl）
   - ✅ 缩放后 Minimap 视口框尺寸是否正确更新

6. **同步性**
   - ✅ 拖拽主画布时，Minimap 视口框是否跟新
   - ✅ 点击工具条按钮缩放时，Minimap 是否更新

7. **边界情况**
   - ✅ 缩放到最小时，Minimap 视口框是否覆盖整个地图
   - ✅ 缩放到最大时，视口框尺寸是否合理

---

## 后续优化方向（不在本次范围内）

1. **Minimap 可折叠** — 右上角添加展开/收起按钮
2. **Minimap 高亮节点类型** — 缩略图中的节点显示颜色（新增/修改/删除）
3. **鼠标滚轮缩放方向反转** — 支持系统偏好设置
4. **键盘快捷键** — 如 `Z` 键重置缩放、`Space + 拖拽` 平移等

---

## 总结

本设计通过 **DOM 缩放** 方案实现 Minimap，同时 **移除 Ctrl 限制** 以支持纯滚轮缩放，为用户提供更直观、高效的地图导航体验。

代码改动集中在 `req-map.js`，无需触及数据模型或后端 API，可独立测试和迭代。

---

## 实现状态

- [x] Task 1: Minimap 基础 DOM 和样式（CSS 位于 `public/css/req-v2.css`）
- [x] Task 2: Minimap 初始化和 Canvas 克隆（含 transform-origin bug 修复）
- [x] Task 3: 视口框位置和尺寸同步
- [x] Task 4: Minimap 拖拽视口框交互（含内存泄漏防护）
- [x] Task 5: Minimap 点击跳转交互
- [x] Task 6: 滚轮缩放优化 - 移除 Ctrl 限制
- [x] Task 7: 工具条提示 - 标注滚轮缩放快捷键

**完成日期:** 2026-08-26

**改动文件:**
- `public/js/req-map.js` — ~160 行新增/修改（Minimap 初始化、视口框同步、拖拽/点击交互、滚轮缩放）
- `public/css/req-v2.css` — ~60 行新增（Minimap 样式、拖拽状态样式、工具条提示样式）

**未提交说明:** 所有改动留在工作区，待用户确认后手动提交。

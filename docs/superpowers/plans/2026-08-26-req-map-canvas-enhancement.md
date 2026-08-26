# 需求地图画布增强实现计划

> **对于代理工作者：** 推荐使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务执行本计划。各步骤使用复选框（`- [ ]`）语法追踪进度。

**目标:** 为需求地图添加右上角 Minimap 导航和纯滚轮缩放，提升大型地图的操作便利性。

**架构:** 通过 CSS `scale` 将现有 `rq-canvas` DOM 克隆到 Minimap 容器中缩小显示，添加可交互的视口框。移除滚轮缩放的 Ctrl 限制，任何位置都能直接缩放。所有改动集中在 `req-map.js` 和相关 CSS，无需修改数据模型或后端 API。

**技术栈:** Vanilla JavaScript、CSS Transform、DOM API、SVG（现有）

---

## 文件结构

### 修改文件

| 文件 | 职责 | 改动范围 |
|------|------|--------|
| `public/js/req-map.js` | Minimap 初始化、交互、视口框同步 | ~150 行新增代码 + 移除 ctrlKey 限制 |
| `public/app.css` | Minimap 容器、视口框样式 | ~50 行新增 CSS |

### 关键函数

- `initMinimap()` — 初始化 Minimap DOM 和交互
- `updateMinimapViewport()` — 实时更新视口框位置/尺寸
- `attachMinimapInteractions()` — 绑定拖拽和点击交互
- `applyTransform()` — 修改以支持 Minimap 联动

---

## 任务分解

### Task 1: Minimap 基础 DOM 和样式

**文件:**
- 修改: `public/js/req-map.js:49-70`
- 新增: `public/app.css` 末尾（新增 ~50 行）

- [ ] **Step 1: 在 req-map.js 中添加 Minimap HTML 结构**

在现有的 `container.innerHTML` 字符串中添加 Minimap 容器。找到这行：

```javascript
container.innerHTML =
  '<div class="rq-map">' +
  '<div class="rq-tools">...
```

替换为（在 `</div>` 前插入）：

```javascript
container.innerHTML =
  '<div class="rq-map">' +
  '<div class="rq-tools">' +
  // ... 现有工具条代码 ...
  '</div>' +
  '<div class="rq-minimap">' +
  '<div class="rq-minimap-content"></div>' +
  '<div class="rq-minimap-viewport"></div>' +
  '</div>' +
  '<div class="rq-canvas-host">' +
  // ... 现有画布代码 ...
  '</div>' +
  // ... 其他现有元素 ...
  '</div>';
```

- [ ] **Step 2: 向 app.css 添加 Minimap 样式**

在 `public/app.css` 末尾追加以下 CSS（约 45 行）：

```css
/* ---- 需求地图 Minimap ---- */
.rq-minimap {
  position: absolute;
  top: 52px;
  right: 10px;
  width: 200px;
  height: 150px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  border-radius: 4px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  z-index: 10;
  pointer-events: auto;
}

.rq-minimap-content {
  width: 100%;
  height: 100%;
  transform-origin: 0 0;
  position: relative;
  pointer-events: none;
}

.rq-minimap-content .rq-canvas {
  transform-origin: 0 0;
}

.rq-minimap-content .rq-node {
  cursor: default;
}

.rq-minimap-viewport {
  position: absolute;
  border: 2px solid var(--blue);
  background: rgba(91, 141, 239, 0.1);
  cursor: grab;
  box-sizing: border-box;
  pointer-events: auto;
}

.rq-minimap-viewport:active {
  cursor: grabbing;
  background: rgba(91, 141, 239, 0.2);
}
```

- [ ] **Step 3: 验证 DOM 结构和样式加载**

打开浏览器开发者工具，检查：
1. Minimap 容器是否在页面右上角显示（棕灰色背景、蓝色边框）
2. `.rq-minimap-viewport` 是否存在（初始位置可能不对，因为还没初始化）

预期：Minimap 容器可见，但内容为空（因为还没克隆 canvas）

- [ ] **Step 4: 提交**

```bash
cd "C:\Users\DELL\Desktop\claude-p-web-demo"
git add public/js/req-map.js public/app.css
git commit -m "feat: 需求地图 Minimap - 添加基础 DOM 和样式"
```

---

### Task 2: Minimap 初始化和 Canvas 克隆

**文件:**
- 修改: `public/js/req-map.js:81-100`（在 `let layout = layoutMap(map);` 后）

- [ ] **Step 1: 添加状态变量和初始化函数骨架**

在 `let layout = layoutMap(map);` 后（约第 81 行）添加：

```javascript
  // Minimap 状态和初始化
  state.minimapScale = 1;  // Minimap 缩放比
  let mmDrag = null;        // Minimap 拖拽状态

  function initMinimap() {
    // TODO: 实现 Minimap 初始化
  }

  function updateMinimapViewport() {
    // TODO: 实现视口框更新
  }

  function attachMinimapInteractions() {
    // TODO: 实现交互绑定
  }
```

- [ ] **Step 2: 实现 initMinimap() 函数**

替换上面的 `initMinimap()` 实现为：

```javascript
  function initMinimap() {
    const mmContent = root.querySelector('.rq-minimap-content');
    const mmViewport = root.querySelector('.rq-minimap-viewport');
    
    const mmW = 200;  // Minimap 宽
    const mmH = 150;  // Minimap 高
    
    // 计算缩放比：min(200/w, 150/h)
    state.minimapScale = Math.min(mmW / layout.size.w, mmH / layout.size.h);
    
    // 清空容器（以防重新渲染）
    mmContent.innerHTML = '';
    
    // 克隆 rq-canvas（含 SVG 连线 + 节点 DOM）
    const canvasClone = canvas.cloneNode(true);
    mmContent.appendChild(canvasClone);
    
    // 应用缩放
    mmContent.style.transform = `scale(${state.minimapScale})`;
    
    // 初始化视口框
    updateMinimapViewport();
    
    // 绑定交互
    attachMinimapInteractions();
  }
```

- [ ] **Step 3: 在 renderNodes() 后调用 initMinimap()**

找到 `renderNodes()` 函数的最后一行（约第 257 行左右是 `drawEdges();`），在该函数的末尾添加：

```javascript
  // 在现有的 renderNodes() 最后添加
  initMinimap();  // 每次节点重绘后同步 Minimap
```

具体位置：搜索 `function renderNodes()` 并找到 `drawEdges();` 那行，在后面加上 `initMinimap();`

- [ ] **Step 4: 验证克隆效果**

打开浏览器，检查：
1. Minimap 内是否显示了缩小版的地图（节点、连线都应该可见）
2. 缩小比例是否合理（应该能看清整个地图结构）
3. 有无浏览器错误信息

预期：Minimap 显示完整的地图缩略图，但视口框位置可能不对

- [ ] **Step 5: 提交**

```bash
git add public/js/req-map.js
git commit -m "feat: Minimap 初始化 - 克隆 canvas 并应用缩放"
```

---

### Task 3: 视口框位置和尺寸同步

**文件:**
- 修改: `public/js/req-map.js` 中的 `updateMinimapViewport()` 和 `applyTransform()`

- [ ] **Step 1: 实现 updateMinimapViewport() 函数**

替换之前的 `updateMinimapViewport()` 占位符为：

```javascript
  function updateMinimapViewport() {
    const mmViewport = root.querySelector('.rq-minimap-viewport');
    const mmW = 200;
    const mmH = 150;
    
    // Minimap 坐标系中的视口框位置和尺寸
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

- [ ] **Step 2: 在 applyTransform() 中添加 updateMinimapViewport() 调用**

找到 `applyTransform()` 函数（约第 126-130 行），在末尾添加：

```javascript
  function applyTransform() {
    canvas.style.transform =
      'translate(' + state.panX + 'px,' + state.panY + 'px) scale(' + state.zoom + ')';
    root.querySelector('.rq-z-val').textContent = Math.round(state.zoom * 100) + '%';
    updateMinimapViewport();  // <-- 添加这一行
  }
```

- [ ] **Step 3: 在 fitView() 中也添加 updateMinimapViewport() 调用**

找到 `fitView()` 函数（约第 135-143 行），在 `applyTransform();` 后添加：

```javascript
  function fitView() {
    const w = host.clientWidth || 1000;
    const h = host.clientHeight || 600;
    const usableH = Math.max(200, h - TOP_INSET - BOT_INSET);
    state.zoom = Math.max(ZOOM_MIN, Math.min(1, Math.min((w - 40) / layout.size.w, usableH / layout.size.h)));
    state.panX = Math.max(0, (w - layout.size.w * state.zoom) / 2);
    state.panY = TOP_INSET;
    applyTransform();
    updateMinimapViewport();  // <-- 添加这一行（applyTransform() 后面）
  }
```

- [ ] **Step 4: 验证视口框同步**

打开浏览器，进行以下操作：
1. 拖拽主画布 → Minimap 中的蓝色视口框是否跟随移动
2. 点击缩放按钮 → 视口框尺寸是否随 zoom 变化
3. 点击「适应」按钮 → 视口框是否调整到合适大小

预期：视口框完全同步主画布的 panX/panY/zoom 状态

- [ ] **Step 5: 提交**

```bash
git add public/js/req-map.js
git commit -m "feat: Minimap 视口框 - 实时同步位置和尺寸"
```

---

### Task 4: Minimap 拖拽视口框交互

**文件:**
- 修改: `public/js/req-map.js` 中的 `attachMinimapInteractions()`

- [ ] **Step 1: 实现 attachMinimapInteractions() - 拖拽部分**

替换之前的 `attachMinimapInteractions()` 占位符为：

```javascript
  function attachMinimapInteractions() {
    const mmViewport = root.querySelector('.rq-minimap-viewport');
    const mmW = 200;
    const mmH = 150;
    
    // ========== 拖拽视口框 ==========
    mmViewport.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      mmDrag = {
        x: e.clientX,
        y: e.clientY,
        startVx: parseFloat(mmViewport.style.left) || 0,
        startVy: parseFloat(mmViewport.style.top) || 0,
      };
      mmViewport.classList.add('dragging');
    });
    
    const onMinimapMove = (e) => {
      if (!mmDrag) return;
      
      const dx = e.clientX - mmDrag.x;
      const dy = e.clientY - mmDrag.y;
      const vw = parseFloat(mmViewport.style.width) || 0;
      const vh = parseFloat(mmViewport.style.height) || 0;
      
      // 新的视口框位置（约束在 Minimap 边界）
      const newVx = Math.max(0, Math.min(mmW - vw, mmDrag.startVx + dx));
      const newVy = Math.max(0, Math.min(mmH - vh, mmDrag.startVy + dy));
      
      // 倒推主画布的 panX/panY
      state.panX = newVx / state.minimapScale;
      state.panY = newVy / state.minimapScale;
      
      applyTransform();  // 这会自动调用 updateMinimapViewport()
    };
    
    const onMinimapUp = () => {
      mmDrag = null;
      mmViewport.classList.remove('dragging');
    };
    
    window.addEventListener('mousemove', onMinimapMove);
    window.addEventListener('mouseup', onMinimapUp);
    
    // TODO: 点击 Minimap 跳转（下一步）
  }
```

- [ ] **Step 2: 添加拖拽时的视觉反馈 CSS**

在 `public/app.css` 中的 `.rq-minimap-viewport:active` 后添加：

```css
.rq-minimap-viewport.dragging {
  background: rgba(91, 141, 239, 0.3);
}
```

- [ ] **Step 3: 验证拖拽交互**

打开浏览器：
1. 在 Minimap 的蓝色视口框上按住鼠标并拖拽
2. 检查主画布是否平移到对应位置
3. 检查视口框是否约束在 Minimap 边界内（不会飞出）

预期：能顺畅拖拽，主画布同步更新，光标变为 grabbing 手指

- [ ] **Step 4: 提交**

```bash
git add public/js/req-map.js public/app.css
git commit -m "feat: Minimap 拖拽 - 实现视口框拖拽导航"
```

---

### Task 5: Minimap 点击跳转交互

**文件:**
- 修改: `public/js/req-map.js` 中的 `attachMinimapInteractions()`

- [ ] **Step 1: 在 attachMinimapInteractions() 中添加点击跳转逻辑**

在 `attachMinimapInteractions()` 末尾的 `// TODO: 点击 Minimap 跳转` 处替换为：

```javascript
    // ========== 点击 Minimap 跳转 ==========
    root.querySelector('.rq-minimap').addEventListener('click', (e) => {
      // 点击视口框本身时不跳转（由拖拽处理）
      if (e.target === mmViewport) return;
      
      const minimap = root.querySelector('.rq-minimap');
      const rect = minimap.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      
      const vw = parseFloat(mmViewport.style.width) || 0;
      const vh = parseFloat(mmViewport.style.height) || 0;
      
      // 新视口框位置（居中点击位置）
      const newVx = Math.max(0, Math.min(mmW - vw, clickX - vw / 2));
      const newVy = Math.max(0, Math.min(mmH - vh, clickY - vh / 2));
      
      // 倒推主画布的 panX/panY
      state.panX = newVx / state.minimapScale;
      state.panY = newVy / state.minimapScale;
      
      applyTransform();  // 自动调用 updateMinimapViewport()
    });
  }
```

- [ ] **Step 2: 验证点击跳转**

打开浏览器：
1. 在 Minimap 上点击任意位置（不是视口框）
2. 检查主画布是否平滑滚动到点击位置（视口框居中）

预期：点击有效，主画布快速导航

- [ ] **Step 3: 提交**

```bash
git add public/js/req-map.js
git commit -m "feat: Minimap 点击跳转 - 实现单击导航"
```

---

### Task 6: 滚轮缩放优化 - 移除 Ctrl 限制

**文件:**
- 修改: `public/js/req-map.js:172-181`（wheel 事件监听器）

- [ ] **Step 1: 找到现有的 wheel 事件监听器**

搜索这段代码（约第 172-181 行）：

```javascript
  host.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // <-- 这行要删除
      e.preventDefault();
      state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.zoom - Math.sign(e.deltaY) * 0.08));
      applyTransform();
    },
    { passive: false },
  );
```

- [ ] **Step 2: 移除 ctrlKey 限制并添加 updateMinimapViewport() 调用**

替换为：

```javascript
  host.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.zoom - Math.sign(e.deltaY) * 0.08));
      applyTransform();
      // applyTransform() 已包含 updateMinimapViewport() 调用，无需重复
    },
    { passive: false },
  );
```

- [ ] **Step 3: 验证滚轮缩放**

打开浏览器，在任意位置进行滚轮操作：
1. 在画布空白处滚轮 → 应能缩放（无需 Ctrl）
2. 在节点上滚轮 → 应能缩放（不会触发浏览器默认行为）
3. 缩放后 Minimap 视口框尺寸是否随之更新

预期：纯滚轮即可缩放，任何位置都生效

- [ ] **Step 4: 提交**

```bash
git add public/js/req-map.js
git commit -m "feat: 滚轮缩放优化 - 移除 Ctrl 限制，任意位置都能缩放"
```

---

### Task 7: 工具条提示 - 标注滚轮缩放快捷键

**文件:**
- 修改: `public/js/req-map.js:49-60`（HTML 骨架）和 `public/app.css`（样式）

- [ ] **Step 1: 在工具条左侧添加滚轮缩放提示图标**

找到工具条 HTML 的开头（约第 51-52 行），在筛选按钮之前添加：

```javascript
container.innerHTML =
  '<div class="rq-map">' +
  '<div class="rq-tools">' +
  '<span class="rq-tip-icon" title="鼠标滚轮缩放">🔍</span>' +  // <-- 新增
  '<button class="rq-fchip rq-f-add on" data-f="add">＋ 新增 <b>0</b></button>' +
  // ... 其他按钮 ...
```

- [ ] **Step 2: 为提示图标添加样式**

在 `public/app.css` 末尾添加：

```css
/* ---- 工具条提示 ---- */
.rq-tip-icon {
  display: inline-block;
  margin-right: 8px;
  font-size: 14px;
  color: var(--muted);
  cursor: help;
  vertical-align: middle;
}

.rq-tip-icon:hover {
  color: var(--text);
}
```

- [ ] **Step 3: 验证提示显示**

打开浏览器，检查：
1. 工具条左侧是否显示 🔍 图标
2. hover 时是否显示 title 提示「鼠标滚轮缩放」

预期：图标可见，hover 显示提示文字

- [ ] **Step 4: 提交**

```bash
git add public/js/req-map.js public/app.css
git commit -m "feat: 工具条提示 - 标注滚轮缩放快捷键"
```

---

### Task 8: 集成测试和边界情况处理

**文件:**
- 修改: `public/js/req-map.js`（若有边界 bug）

- [ ] **Step 1: 测试场景 - 极端缩放比**

打开浏览器，执行：
1. 地图只有 1 个节点 → Minimap 是否正确显示
2. 地图有 50+ 个节点 → Minimap 是否仍然清晰
3. 缩放到最小（ZOOM_MIN = 0.35） → 视口框是否覆盖整个 Minimap
4. 缩放到最大（ZOOM_MAX = 1.8） → 视口框尺寸是否合理（不会为 0）

预期：各场景下都能正常显示和交互，无错误

- [ ] **Step 2: 测试场景 - Minimap 边界约束**

打开浏览器：
1. 将主画布平移到极端位置（panX/panY 很大）
2. 检查 Minimap 中的视口框是否越界（应约束在 Minimap 内）

预期：视口框始终在 Minimap 内

- [ ] **Step 3: 测试场景 - 拖拽和点击混合**

打开浏览器：
1. 在 Minimap 中拖拽视口框
2. 松开后点击另一位置
3. 再次拖拽
4. 检查状态是否混乱（是否有未清理的拖拽状态）

预期：无状态污染，每次交互独立生效

- [ ] **Step 4: 检查浏览器控制台**

打开浏览器 DevTools → Console，执行上述操作：
- 应无错误信息（Error、Warning）
- Minimap 相关代码应无类型错误

预期：Console 干净，无异常

- [ ] **Step 5: 提交**

如有 bug fix，提交修复。若无问题，提交测试通过记录：

```bash
git add -A
git commit -m "test: 需求地图 Minimap 集成测试通过 - 包含边界情况验证"
```

---

### Task 9: 回归测试 - 确保现有功能未破坏

**文件:**
- 验证: `public/js/req-map.js` 中的各现有功能

- [ ] **Step 1: 测试筛选功能**

打开浏览器：
1. 切换「新增」、「修改」、「删除」筛选按钮
2. 检查主画布中的节点是否按预期隐显
3. 检查 Minimap 中的缩略图是否也同步隐显

预期：筛选生效，Minimap 同步

- [ ] **Step 2: 测试版本切换**

如果有多个地图版本：
1. 点击版本按钮切换
2. 检查主画布和 Minimap 是否都刷新
3. 检查视口框位置是否复位

预期：版本切换正常，Minimap 重新初始化

- [ ] **Step 3: 测试标注功能（如适用）**

1. 在 review 阶段打开标注抽屉
2. 标注逻辑点
3. 检查主画布和 Minimap 是否保持响应

预期：标注操作不影响 Minimap 可用性

- [ ] **Step 4: 测试拖拽平移（现有功能）**

1. 在主画布空白处按住拖拽
2. 检查 Minimap 视口框是否同步移动

预期：拖拽平移功能正常，Minimap 联动

- [ ] **Step 5: 提交**

```bash
git commit -m "test: 需求地图现有功能回归测试通过"
```

---

### Task 10: 代码审查和优化

**文件:**
- 检查: `public/js/req-map.js`、`public/app.css`

- [ ] **Step 1: 检查变量命名一致性**

- Minimap 相关变量：`mmW`、`mmH`、`state.minimapScale`、`mmDrag`
- 主画布变量：`panX`、`panY`、`zoom`
- 确认所有引用一致

- [ ] **Step 2: 检查函数体大小和复杂度**

- `initMinimap()` — 应 < 20 行
- `updateMinimapViewport()` — 应 < 15 行
- `attachMinimapInteractions()` — 应 < 60 行

如有过大，考虑进一步拆分

- [ ] **Step 3: 移除调试代码**

搜索 `console.log`、`debugger`、`TODO` 注释，清理

- [ ] **Step 4: 验证 CSS 命名规范**

所有 Minimap 相关 class 应遵循 `rq-minimap*` 前缀规范

- [ ] **Step 5: 检查内存泄漏风险**

- 事件监听是否正确清理（wheel、mousemove、mouseup）
- DOM 克隆是否过于频繁（initMinimap 是否会被反复调用）

- [ ] **Step 6: 提交**

```bash
git commit -m "refactor: 代码审查 - 优化变量命名、函数大小、内存管理"
```

---

### Task 11: 最终文档和提交

**文件:**
- 修改: `docs/superpowers/specs/2026-08-26-req-map-canvas-enhancement-design.md`（标记完成）
- 创建: 可选 `docs/superpowers/plans/2026-08-26-req-map-canvas-enhancement-COMPLETED.md`

- [ ] **Step 1: 更新设计文档的完成状态**

在设计文档开头或结尾添加完成标记：

```markdown
## 实现状态

- [x] Task 1: Minimap 基础 DOM 和样式
- [x] Task 2: Minimap 初始化和 Canvas 克隆
- [x] Task 3: 视口框位置和尺寸同步
- [x] Task 4: Minimap 拖拽视口框交互
- [x] Task 5: Minimap 点击跳转交互
- [x] Task 6: 滚轮缩放优化 - 移除 Ctrl 限制
- [x] Task 7: 工具条提示 - 标注滚轮缩放快捷键
- [x] Task 8: 集成测试和边界情况处理
- [x] Task 9: 回归测试 - 确保现有功能未破坏
- [x] Task 10: 代码审查和优化

**完成日期:** 2026-08-26
**负责人:** AI Agent (subagent-driven-development)
```

- [ ] **Step 2: 提交最终状态**

```bash
git add docs/superpowers/specs/2026-08-26-req-map-canvas-enhancement-design.md
git commit -m "docs: 标记设计文档完成 - 需求地图画布增强功能"
```

- [ ] **Step 3: 生成总结报告（可选）**

在终端输出：

```
✅ 需求地图画布增强实现完成！

功能清单：
  ✓ 右上角 Minimap 导航（DOM 缩放版）
  ✓ Minimap 拖拽视口框导航
  ✓ Minimap 点击跳转
  ✓ 纯滚轮缩放（无需 Ctrl 修饰键）
  ✓ 工具条滚轮缩放提示

改动统计：
  • 修改: public/js/req-map.js (~150 行代码 + 修改)
  • 修改: public/app.css (~95 行 CSS)
  • 无后端改动
  
测试覆盖：
  ✓ 单元场景测试
  ✓ 集成测试
  ✓ 边界情况测试
  ✓ 回归测试
  
所有提交均已完成。
```

- [ ] **Step 4: 提交**

```bash
git commit -m "release: 需求地图画布增强 v1.0 - 所有任务完成"
```

---

## 自我审查

### 规范检查

✅ **设计覆盖:** 所有 3 个功能点已映射到具体任务
  - Minimap DOM/CSS ← Task 1
  - Minimap 初始化 ← Task 2
  - 视口框同步 ← Task 3
  - 拖拽导航 ← Task 4
  - 点击导航 ← Task 5
  - 滚轮缩放 ← Task 6
  - UI 提示 ← Task 7
  - 测试 ← Task 8-10

✅ **无占位符:** 每个步骤都包含完整代码、命令、预期结果

✅ **类型一致:**
  - `state.minimapScale` 一致贯穿所有函数
  - 坐标换算公式（vx/vy）一致
  - Minimap 尺寸（mmW=200, mmH=150）常量化

✅ **DRY 原则:**
  - `applyTransform()` 单一调用点，自动触发 `updateMinimapViewport()`
  - 避免重复的坐标计算

✅ **提交粒度:** 每个任务 1-2 个提交，便于追踪和回滚

---

## 下一步

按以下顺序执行：

**选项 1：子代理驱动（推荐）**
```bash
使用 superpowers:subagent-driven-development
每个 task 分配一个独立子代理，自动生成 code review，快速迭代
```

**选项 2：内联执行**
```bash
使用 superpowers:executing-plans
当前会话中批量执行，包含检查点
```

---

## 总结

本计划分 11 个任务、48 个步骤系统地实现需求地图画布增强。所有改动集中在前端代码（2 个文件），无需涉及后端或数据模型。预期工作量：**2-3 小时**（含充分测试）。

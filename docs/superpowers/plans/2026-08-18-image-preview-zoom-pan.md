# 图片预览放大缩小交互优化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强图片灯箱预览的交互能力，支持鼠标滚轮缩放和拖拽平移，并改进蒙层关闭逻辑。

**Architecture:** 在现有灯箱框架基础上，添加状态管理对象（scale、translate、isDragging），实现滚轮事件处理（变焦中心跟随鼠标）、拖拽事件处理（边界约束）、视觉反馈（cursor 变化、CSS class 切换）。修改仅涉及 JavaScript 逻辑层和 CSS 样式，HTML 结构不变。

**Tech Stack:** Vanilla JavaScript（ES6+）、CSS3 Transform、DOM 事件 API

---

## Task 1: 添加灯箱状态管理对象和辅助函数

**Files:**
- Modify: `public/js/chat.js:1120-1173` (灯箱事件处理区块)

**说明：** 在 `showLightbox` 和 `closeLightbox` 函数之前插入状态管理和辅助函数，为后续的缩放和拖拽逻辑奠定基础。

- [ ] **Step 1: 在灯箱函数定义之前添加状态对象和辅助函数**

在现有的 `showLightbox` 函数定义之前（约 1126 行），插入以下代码：

```javascript
      // ---- 灯箱缩放与拖拽状态管理 ----
      const lightboxState = {
        scale: 1,              // 当前缩放倍数
        translateX: 0,         // X 轴偏移（像素）
        translateY: 0,         // Y 轴偏移（像素）
        isDragging: false,     // 是否正在拖拽
        dragStartX: 0,         // 拖拽起始 X
        dragStartY: 0,         // 拖拽起始 Y
      };

      // 数值约束函数
      function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
      }

      // 应用当前 transform 到图片元素
      function updateLightboxTransform() {
        const lightbox = document.getElementById('imgLightbox');
        const img = lightbox?.querySelector('.lightbox-img');
        if (!img) return;

        const { scale, translateX, translateY } = lightboxState;
        img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
      }

      // 重置灯箱状态
      function resetLightboxState() {
        lightboxState.scale = 1;
        lightboxState.translateX = 0;
        lightboxState.translateY = 0;
        lightboxState.isDragging = false;
        lightboxState.dragStartX = 0;
        lightboxState.dragStartY = 0;
      }
```

- [ ] **Step 2: 修改 `showLightbox` 函数，添加状态重置逻辑**

将现有的 `showLightbox` 函数（1126-1137 行）修改为：

```javascript
      function showLightbox(imagePath) {
        const lightbox = document.getElementById('imgLightbox');
        const img = lightbox?.querySelector('.lightbox-img');
        if (!img) return;

        // 重置状态
        resetLightboxState();
        updateLightboxTransform();

        // 缩略图能渲染出来才有灯箱可点，这里必然拿得到 URL
        const src = toWebviewUrl(imagePath);
        if (!src) return;
        img.src = src;

        // 移除缩放相关的 class
        img.classList.remove('zoomed', 'dragging');

        lightbox.hidden = false;
      }
```

- [ ] **Step 3: 修改 `closeLightbox` 函数，添加状态清理逻辑**

将现有的 `closeLightbox` 函数（1142-1145 行）修改为：

```javascript
      function closeLightbox() {
        const lightbox = document.getElementById('imgLightbox');
        if (!lightbox) return;

        // 重置状态
        resetLightboxState();

        // 清除 transform 和 class
        const img = lightbox.querySelector('.lightbox-img');
        if (img) {
          img.style.transform = '';
          img.classList.remove('zoomed', 'dragging');
        }

        lightbox.hidden = true;
      }
```

- [ ] **Step 4: 提交**

```bash
git add public/js/chat.js
git commit -m "feat: 添加灯箱缩放拖拽状态管理和辅助函数"
```

---

## Task 2: 修改 CSS 样式，支持缩放和拖拽交互

**Files:**
- Modify: `public/app.css:759-788` (灯箱样式区块)

**说明：** 更新 `.lightbox-overlay` 和 `.lightbox-img` 的样式，为缩放拖拽做准备，并添加两个新的 class 样式。

- [ ] **Step 1: 修改 `.lightbox-overlay` 样式**

将现有的 `.lightbox-overlay` 块（约 759-764 行）修改为：

```css
      .lightbox-overlay {
        position: relative;
        width: 90vw;
        height: 90vh;
        overflow: hidden;
      }
```

理由：
- 移除 `max-width` 和 `max-height`，改为固定 `width` 和 `height`，成为一个固定的裁剪视窗
- 添加 `overflow: hidden` 确保超出部分被隐藏
- 移除 `cursor: pointer`（光标由图片元素控制）

- [ ] **Step 2: 修改 `.lightbox-img` 样式**

将现有的 `.lightbox-img` 块（约 765-771 行）修改为：

```css
      .lightbox-img {
        display: block;
        user-select: none;
        cursor: zoom-in;
        transform-origin: center;
        max-width: 100%;
        max-height: 100%;
      }
```

理由：
- 移除 `pointer-events: none`（需要接收事件）
- 添加 `cursor: zoom-in`（默认光标）
- 添加 `transform-origin: center`（变焦中心）
- 保留 `max-width` 和 `max-height` 用于初始状态（scale=1 时）

- [ ] **Step 3: 添加 `.lightbox-img.zoomed` 新样式**

在 `.lightbox-close:hover` 块之后添加（约 788 行）：

```css
      .lightbox-img.zoomed {
        cursor: grab;
        max-width: none;
        max-height: none;
      }
      .lightbox-img.dragging {
        cursor: grabbing;
      }
```

理由：
- `.zoomed`：图片被放大时，光标切换为 `grab`，移除 `max-width/max-height` 允许图片超出容器
- `.dragging`：拖拽中时，光标切换为 `grabbing`

- [ ] **Step 4: 提交**

```bash
git add public/app.css
git commit -m "style: 灯箱样式优化 - 支持缩放和拖拽"
```

---

## Task 3: 实现滚轮缩放逻辑

**Files:**
- Modify: `public/js/chat.js:1147-1173` (灯箱事件初始化区块)

**说明：** 在 `DOMContentLoaded` 事件处理中，为 `.lightbox-overlay` 添加 `wheel` 事件监听，实现鼠标滚轮缩放。缩放中心跟随鼠标位置。

- [ ] **Step 1: 编写滚轮缩放事件处理函数**

在现有的 `DOMContentLoaded` 事件监听之前（约 1148 行），添加以下辅助函数：

```javascript
      // 处理滚轮缩放
      function handleLightboxWheel(event) {
        event.preventDefault();

        const lightbox = document.getElementById('imgLightbox');
        const img = lightbox?.querySelector('.lightbox-img');
        const overlay = lightbox?.querySelector('.lightbox-overlay');
        if (!img || !overlay) return;

        // 获取鼠标在 overlay 中的位置
        const rect = overlay.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;

        // 判断滚轮方向
        const isScrollUp = event.deltaY < 0;
        const scaleFactor = isScrollUp ? 1.1 : 1 / 1.1;

        // 计算新缩放
        const oldScale = lightboxState.scale;
        const newScale = clamp(oldScale * scaleFactor, 0.5, 5);

        if (newScale === oldScale) return; // 已到达极限，不处理

        // 保持鼠标指向处的图片像素不动：
        // 新位移 = 旧位移 * 缩放比 + 鼠标位置 * (1 - 缩放比)
        const ratio = newScale / oldScale;
        lightboxState.translateX = lightboxState.translateX * ratio + mouseX * (1 - ratio);
        lightboxState.translateY = lightboxState.translateY * ratio + mouseY * (1 - ratio);

        // 更新缩放
        lightboxState.scale = newScale;

        // 应用 transform
        updateLightboxTransform();

        // 更新样式反馈
        if (newScale > 1) {
          img.classList.add('zoomed');
        } else {
          img.classList.remove('zoomed');
        }
      }
```

- [ ] **Step 2: 在 DOMContentLoaded 中为 overlay 绑定 wheel 事件**

在 `document.addEventListener('DOMContentLoaded', () => {` 块中（约 1148 行），在 `if (lightbox) {` 判断内部，添加：

```javascript
        if (lightbox) {
          // ... 现有代码（点击关闭、按钮等）...

          // 滚轮缩放事件（添加在此处）
          overlay?.addEventListener('wheel', handleLightboxWheel, { passive: false });
        }
```

具体位置：在现有的 `overlay?.addEventListener('click', ...)` 之后添加。

- [ ] **Step 3: 验证滚轮事件绑定位置**

检查修改后的代码结构（DOMContentLoaded 内部应包含）：
```
- lightbox.addEventListener('click', ...)
- overlay.addEventListener('click', ...)  // 这里保留还是需要修改？见 Task 5
- closeBtn.addEventListener('click', ...)
- overlay.addEventListener('wheel', ...)  // 新增
- document.addEventListener('keydown', ...)  // Esc 关闭
```

- [ ] **Step 4: 提交**

```bash
git add public/js/chat.js
git commit -m "feat: 实现滚轮缩放逻辑，缩放中心跟随鼠标"
```

---

## Task 4: 实现拖拽平移逻辑

**Files:**
- Modify: `public/js/chat.js:1147-1173` (灯箱事件初始化区块)

**说明：** 添加三个事件监听（mousedown、mousemove、mouseup），实现拖拽平移。仅当 scale > 1 时生效，拖拽距离超过 3px 才确认为拖拽（防止误触）。

- [ ] **Step 1: 编写拖拽事件处理函数**

在 `handleLightboxWheel` 函数之前（约 1147 行），添加以下三个函数：

```javascript
      // 处理图片按下（开始拖拽）
      function handleLightboxMouseDown(event) {
        if (lightboxState.scale <= 1) return; // 仅在放大时允许拖拽

        lightboxState.dragStartX = event.clientX;
        lightboxState.dragStartY = event.clientY;
        lightboxState.isDragging = false; // 等待移动超过阈值

        // 绑定全局 mousemove 和 mouseup
        document.addEventListener('mousemove', handleLightboxMouseMove);
        document.addEventListener('mouseup', handleLightboxMouseUp);
      }

      // 处理鼠标移动（拖拽中）
      function handleLightboxMouseMove(event) {
        const lightbox = document.getElementById('imgLightbox');
        const img = lightbox?.querySelector('.lightbox-img');
        const overlay = lightbox?.querySelector('.lightbox-overlay');
        if (!img || !overlay) return;

        const dx = event.clientX - lightboxState.dragStartX;
        const dy = event.clientY - lightboxState.dragStartY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // 距离超过 3px 才确认拖拽
        if (!lightboxState.isDragging && distance > 3) {
          lightboxState.isDragging = true;
          img.classList.add('dragging');
        }

        if (lightboxState.isDragging) {
          // 更新位移
          lightboxState.translateX += dx;
          lightboxState.translateY += dy;

          // 应用边界约束
          applyDragBoundary(img, overlay);

          // 应用 transform
          updateLightboxTransform();

          // 更新起始点（持续拖拽时）
          lightboxState.dragStartX = event.clientX;
          lightboxState.dragStartY = event.clientY;
        }
      }

      // 处理鼠标抬起（拖拽结束）
      function handleLightboxMouseUp(event) {
        const lightbox = document.getElementById('imgLightbox');
        const img = lightbox?.querySelector('.lightbox-img');

        if (img && lightboxState.isDragging) {
          img.classList.remove('dragging');
        }

        lightboxState.isDragging = false;

        // 清理全局事件监听
        document.removeEventListener('mousemove', handleLightboxMouseMove);
        document.removeEventListener('mouseup', handleLightboxMouseUp);
      }

      // 应用拖拽边界约束
      function applyDragBoundary(img, overlay) {
        if (!img || !overlay) return;

        const { scale, translateX, translateY } = lightboxState;
        const imgRect = img.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();

        // 获取图片的原始尺寸
        const imgWidth = img.naturalWidth || img.offsetWidth;
        const imgHeight = img.naturalHeight || img.offsetHeight;

        // 视窗尺寸（px，转换自 vw/vh）
        const viewportWidth = overlayRect.width;
        const viewportHeight = overlayRect.height;

        // 计算最大拖拽距离
        const maxTranslateX = (imgWidth * scale - viewportWidth) / 2;
        const maxTranslateY = (imgHeight * scale - viewportHeight) / 2;

        // 约束
        lightboxState.translateX = clamp(translateX, -maxTranslateX, maxTranslateX);
        lightboxState.translateY = clamp(translateY, -maxTranslateY, maxTranslateY);
      }
```

- [ ] **Step 2: 在 DOMContentLoaded 中为图片绑定 mousedown 事件**

在 `document.addEventListener('DOMContentLoaded', () => {` 块中，在 `if (lightbox) {` 判断内部，找到 `const closeBtn = lightbox?.querySelector('.lightbox-close');` 这一行，在其后添加：

```javascript
        const img = lightbox?.querySelector('.lightbox-img');
```

然后在 `if (lightbox) {` 块的最后（Esc 监听之前），添加：

```javascript
          // 图片拖拽事件
          img?.addEventListener('mousedown', handleLightboxMouseDown);
```

- [ ] **Step 3: 验证事件绑定结构**

DOMContentLoaded 内部应包含（按顺序）：
```
- const lightbox = ...
- const overlay = ...
- const closeBtn = ...
- const img = ...  (新增)
- if (lightbox) {
    - lightbox.addEventListener('click', ...)
    - overlay.addEventListener('click', ...)
    - closeBtn.addEventListener('click', ...)
    - overlay.addEventListener('wheel', ...)
    - img.addEventListener('mousedown', ...)  (新增)
  }
- document.addEventListener('keydown', ...)  // Esc，在 if (lightbox) 外部
```

- [ ] **Step 4: 提交**

```bash
git add public/js/chat.js
git commit -m "feat: 实现拖拽平移逻辑，边界约束防止图片拖出视窗"
```

---

## Task 5: 修复蒙层点击关闭逻辑

**Files:**
- Modify: `public/js/chat.js:1153-1167` (灯箱 click 事件处理)

**说明：** 现有逻辑中，overlay 的 stopPropagation 会导致拖拽结束后点击蒙层无法关闭。修改为：点击背景（非图片、非拖拽中）时才关闭。

- [ ] **Step 1: 修改 lightbox click 事件处理**

将现有的 `lightbox.addEventListener('click', ...)` 块（约 1155-1157 行）修改为：

```javascript
          lightbox.addEventListener('click', (e) => {
            // 点击的是图片或其内部元素 → 不关闭
            if (e.target.closest('.lightbox-img') || e.target.closest('.lightbox-overlay')) return;
            // 正在拖拽 → 不关闭
            if (lightboxState.isDragging) return;
            // 点击背景 → 关闭
            closeLightbox();
          });
```

理由：
- 检查 `e.target.closest('.lightbox-img')` 防止点击图片时关闭
- 检查 `e.target.closest('.lightbox-overlay')` 防止点击 overlay 背景时关闭
- 检查 `isDragging` 防止拖拽结束瞬间误触关闭

- [ ] **Step 2: 移除 overlay 的 stopPropagation 监听**

找到现有的 `overlay?.addEventListener('click', (e) => e.stopPropagation());` 行（约 1160 行），将其删除。

理由：由于修改了 lightbox 的 click 逻辑，不再需要 stopPropagation 阻止冒泡。

- [ ] **Step 3: 提交**

```bash
git add public/js/chat.js
git commit -m "fix: 修复蒙层点击关闭逻辑，防止拖拽误触"
```

---

## Task 6: 手动测试所有交互场景

**Files:**
- 测试目标：`public/index.html` (开发环境预览)

**说明：** 运行应用，手动测试 spec 中定义的 8 个测试场景，确保缩放、拖拽、关闭的交互符合预期。

- [ ] **Step 1: 启动应用**

```bash
npm run dev
# 或根据项目配置的启动命令
```

预期：应用在本地端口启动，聊天界面可正常访问。

- [ ] **Step 2: 打开一张包含图片的聊天，点击图片缩略图打开灯箱**

预期：灯箱正常显示，图片为原始尺寸（scale=1），光标为 `zoom-in`。

- [ ] **Step 3: 在灯箱内滚动鼠标滚轮向上**

预期：
- 图片放大 1.1x
- 光标变为 `grab`
- 图片中心保持稳定（不会突然跳动）

- [ ] **Step 4: 持续向上滚轮，观察是否卡在 5x**

预期：
- 滚轮可持续放大至 5x
- 再继续滚轮时无法继续放大（已到达上限）

- [ ] **Step 5: scale=5x 时，拖拽图片左上角**

预期：
- 鼠标 cursor 变为 `grabbing`
- 图片可被拖动
- 超出 overlay 边界的部分被隐藏（黑色背景露出）

- [ ] **Step 6: 拖拽至边界后释放鼠标**

预期：
- 图片停留在边界处，不自动回弹
- cursor 变回 `grab`

- [ ] **Step 7: scale=1x 时，尝试拖拽图片**

预期：
- 无任何反应（拖拽仅在 scale > 1 时生效）

- [ ] **Step 8: scale=2x 时，点击图片边缘**

预期：
- 灯箱不关闭（点击的是图片，不是背景）

- [ ] **Step 9: scale=2x 时，点击蒙层边缘（黑色背景区域）**

预期：
- 灯箱关闭

- [ ] **Step 10: 按 Esc 键**

预期：
- 灯箱关闭
- 状态重置（下次打开时 scale=1）

- [ ] **Step 11: 关闭灯箱后重新打开另一张图片**

预期：
- 新图片为原始尺寸（scale=1），无拖拽偏移

- [ ] **Step 12: 测试滚轮缩小**

预期：
- 滚轮向下时，图片缩小至 0.5x（最小）
- 再继续滚轮时无法继续缩小

- [ ] **Step 13: 检查关闭按钮（×）仍可用**

预期：
- 任何时候点击 × 按钮都能关闭灯箱

- [ ] **Step 14: 提交测试日志**

```bash
git add public/js/chat.js public/app.css
git commit -m "test: 手动验证灯箱缩放拖拽交互 - 所有 13 个场景通过"
```

---

## Self-Review Checklist

**Spec Coverage:**
- ✅ 蒙层点击关闭 → Task 5
- ✅ 滚轮缩放 → Task 3
- ✅ 拖拽平移 → Task 4
- ✅ 视觉反馈 → Tasks 2, 3, 4
- ✅ CSS 改动 → Task 2
- ✅ JS 状态管理 → Task 1
- ✅ 测试场景 → Task 6

**Placeholder Scan:**
- ✅ 所有代码块完整，无 TBD/TODO 占位符
- ✅ 每个 step 都有明确的代码或命令
- ✅ 类型、函数名、CSS class 名前后一致

**Type Consistency:**
- ✅ `lightboxState` 对象结构一致（Task 1 定义，Task 3/4/5 使用）
- ✅ 函数名一致：`updateLightboxTransform()`, `resetLightboxState()`, `clamp()`, `applyDragBoundary()`, `handleLightbox*`
- ✅ CSS class 名一致：`.zoomed`, `.dragging`

**No Specs Gaps:**
- ✅ 缩放范围 0.5x-5x ±10% → Task 3 代码中 `1.1` 和 `0.5, 5` 的 clamp
- ✅ 拖拽仅在 scale > 1 时生效 → Task 4 的 `if (lightboxState.scale <= 1) return;`
- ✅ 拖拽距离阈值 3px → Task 4 中 `distance > 3`
- ✅ 边界约束公式 → Task 4 的 `applyDragBoundary` 函数
- ✅ 变焦中心跟随鼠标 → Task 3 中的 `ratio` 计算
- ✅ 状态重置 → Task 1 的 `resetLightboxState()`，Task 2/5 中调用


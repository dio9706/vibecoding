# 图片预览放大缩小交互优化设计

**日期**：2026-08-18  
**功能**：图片灯箱预览增强 - 滚轮缩放 + 拖拽平移

---

## 功能概述

优化现有图片灯箱预览交互，增加以下能力：

1. **蒙层点击关闭**：点击蒙层（非图片区域）可关闭预览
2. **滚轮缩放**：鼠标滚轮上下滚动放大/缩小，缩放中心跟随鼠标位置
3. **拖拽平移**：当图片被放大时，可通过拖拽图片移动查看不同部分
4. **视觉反馈**：cursor 样式变化指示当前可交互状态

---

## 技术范围

**受影响文件**：
- `public/js/chat.js`：灯箱逻辑和交互处理
- `public/app.css`：灯箱样式和 cursor 反馈

**HTML 无需修改**：现有结构 `#imgLightbox` → `.lightbox-overlay` → `.lightbox-img` + `.lightbox-close` 保持不变

---

## 缩放规格

| 参数 | 值 |
|---|---|
| **最小缩放倍数** | 0.5x（缩小到原图 50%） |
| **最大缩放倍数** | 5x（放大到原图 500%） |
| **每次滚轮增量** | ±10%（向上滚动 1.1x，向下滚动 1/1.1x） |
| **初始缩放** | 1x（100%，适配视窗）|
| **变焦中心** | 鼠标指针位置（保持指针下的图片像素不动） |

---

## 交互流程

### 1. 打开灯箱
- 调用 `showLightbox(imagePath)`
- **重置状态**：`scale = 1, translateX = 0, translateY = 0, isDragging = false`
- 图片显示为原始尺寸，光标为 `zoom-in`

### 2. 滚轮缩放
- **检测范围**：仅在 `.lightbox-overlay` 内滚动生效（`mousewheel`/`wheel` 事件）
- **计算步骤**：
  1. 读取滚轮方向（`event.deltaY` 或 `event.wheelDelta`）
  2. 计算新缩放：`newScale = clamp(scale * (1 ± 0.1), 0.5, 5)`
  3. 计算新偏移：`newTranslate = translate * ratio + mousePos * (1 - ratio)`  
     - 其中 `ratio = newScale / scale`
  4. 更新 `scale` 和 `translate{X,Y}`
  5. 应用 CSS transform：`transform: translate(tx, ty) scale(s)`
  6. 当 `scale > 1` 时：加 `.zoomed` class（cursor → `grab`），移除则移除
  7. 重新计算拖拽边界（防止图片被拖出视窗）

### 3. 拖拽平移
- **启用条件**：仅当 `scale > 1` 时（图片被放大）
- **按下**（`mousedown` on `.lightbox-img`）：
  - 记录起始坐标：`startX, startY`
  - 设置 `isDragging = false`（等待移动超过阈值确认拖拽，而非点击）
- **移动**（`mousemove`）：
  - 计算位移：`dx = currentX - startX, dy = currentY - startY`
  - 如果 `|dx| + |dy| > 3px`（防止微小抖动误触）：
    - 设置 `isDragging = true`
    - 加 `.dragging` class（cursor → `grabbing`）
    - 更新 `translateX/Y`，施加边界约束（见下节）
    - 应用 transform
- **抬起**（`mouseup`）：
  - 移除 `.dragging` class
  - 设置 `isDragging = false`

### 4. 拖拽边界约束
当图片被放大并拖拽时，防止图片拖到完全离开视窗：

```
maxTranslateX = (imgWidth * scale - viewportWidth) / 2
maxTranslateY = (imgHeight * scale - viewportHeight) / 2

translateX = clamp(translateX, -maxTranslateX, maxTranslateX)
translateY = clamp(translateY, -maxTranslateY, maxTranslateY)
```

其中 `viewportWidth = 90vw, viewportHeight = 90vh`（`.lightbox-overlay` 的尺寸）

### 5. 点击蒙层关闭
- 在 `#imgLightbox` 上监听 click 事件
- 当 `!isDragging && e.target === lightbox`（点击背景而非图片），调用 `closeLightbox()`
- 移除现有的 `.lightbox-overlay.stopPropagation()` 逻辑

### 6. 关闭灯箱
- 调用 `closeLightbox()`
- **重置状态**：`scale = 1, translateX = 0, translateY = 0, isDragging = false`
- 清除 `.zoomed` 和 `.dragging` class
- 清除 transform
- 设置 `lightbox.hidden = true`

---

## CSS 改动清单

### `.lightbox-overlay`
- 移除 `max-width: 90vw; max-height: 90vh;`
- 添加 `width: 90vw; height: 90vh;`（固定尺寸，成为裁剪视窗）
- 添加 `overflow: hidden;`（超出部分隐藏）

### `.lightbox-img`
- 移除 `pointer-events: none;`（需要接收事件）
- 移除 `max-width: 100%; max-height: 100%;`（缩放后允许超尺寸）
- 添加 `cursor: zoom-in;`（默认状态）
- 添加 `user-select: none;`（防止拖拽时文本选中）
- 添加 `transition: transform 0.2s ease-out;`（可选，拖拽结束时平滑回弹，可去掉以获得即时反馈）

### `.lightbox-img.zoomed`（新增）
```css
.lightbox-img.zoomed {
  cursor: grab;
}
```

### `.lightbox-img.dragging`（新增）
```css
.lightbox-img.dragging {
  cursor: grabbing;
}
```

---

## JS 状态管理

### 灯箱全局状态对象
```javascript
const lightboxState = {
  scale: 1,              // 当前缩放倍数
  translateX: 0,         // X 轴偏移（像素）
  translateY: 0,         // Y 轴偏移（像素）
  isDragging: false,     // 是否正在拖拽
  dragStartX: 0,         // 拖拽起始 X
  dragStartY: 0,         // 拖拽起始 Y
};
```

### 函数签名
- `showLightbox(imagePath)` - 打开灯箱并重置状态
- `closeLightbox()` - 关闭灯箱并重置状态
- `updateLightboxTransform()` - 应用当前 transform 到 DOM
- `clamp(value, min, max)` - 数值约束函数（如果不存在）

---

## 事件处理绑定

| 事件 | 目标 | 处理函数 |
|---|---|---|
| `wheel` / `mousewheel` | `.lightbox-overlay` | 滚轮缩放逻辑 |
| `mousedown` | `.lightbox-img` | 记录拖拽起点 |
| `mousemove` | `document` | 拖拽移动 + isDragging 判定 |
| `mouseup` | `document` | 拖拽结束，清理状态 |
| `click` | `#imgLightbox` | 蒙层关闭检查 |
| `keydown` | `document` | Esc 关闭（现有逻辑保留） |
| `DOMContentLoaded` | 初始化事件监听 | 同现有流程 |

---

## 降级和兼容性

- 如果浏览器不支持 `wheel` 事件，降级到 `mousewheel`（IE/老版本浏览器）
- 移动端（触摸）暂不支持，仅支持鼠标交互
- 如果图片加载失败，灯箱仍可打开但为空白，不影响关闭流程

---

## 测试场景

| 场景 | 预期行为 |
|---|---|
| 打开灯箱 → 滚轮向上 | 图片放大 1.1x，鼠标指向处像素保持在相同位置 |
| 持续向上滚轮至 5x | 无法继续放大，scale 卡在 5x |
| scale = 5x，拖拽图片左上方 | 图片左上方被拖离视窗（超出 overflow:hidden），背景黑色露出 |
| scale = 5x，拖拽至边界 → 释放 | 图片停留在边界处，不自动回弹 |
| scale = 1x，拖拽图片 | 无响应（拖拽仅在 scale > 1 时生效） |
| scale = 2x 时点击图片边缘 | 不关闭灯箱（点击的是图片，而非背景） |
| scale = 2x 时点击蒙层边缘 + isDragging = false | 关闭灯箱 |
| 按 Esc | 关闭灯箱，状态重置 |
| 关闭灯箱后重新打开 | scale = 1，无拖拽偏移 |

---

## 未来扩展方向

- 移动端双指捏合放大（`touchstart` / `touchmove`）
- 拖拽结束时的惯性滑动（momentum scrolling）
- 双击快速切换 1x ↔ 2x
- 键盘快捷键（↑↓ 微调缩放，← → 移动图片）

---

## 实现方向

修改仅涉及两个文件，复杂度中等（涉及 transform 计算、拖拽状态机、边界约束），预计 2-3 个中等复杂度的提交。


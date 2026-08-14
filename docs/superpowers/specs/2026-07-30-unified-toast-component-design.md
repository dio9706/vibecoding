# 统一 Toast 提示组件设计

**日期**：2026-07-30  
**目标**：将项目中分散的 `window.alert()` 替换为统一风格的 Toast 轻提示组件

---

## 概述

当前项目在 7 处代码中使用原生 `window.alert()` 展示错误/成功提示，样式不统一且打断用户交互流。本设计引入右下角滑入 Toast 组件，支持多条堆叠、自动消失，与项目深色主题无缝融合。

---

## 需求

### 功能需求

1. **消息类型**：支持三种提示类型
   - `error`（红色）：操作失败、网络错误
   - `success`（绿色）：操作成功（预留，当前 7 处均为错误）
   - `info`（橙色）：信息提示

2. **显示规则**
   - 自动显示 3 秒后消失
   - 同时显示最多 3 条 Toast
   - 超过 3 条时，第 4 条入队时挤掉最老的一条（立即触发其消失动画）
   - 支持手动点击关闭按钮 ✕ 立即消失

3. **交互**
   - 位置：右下角，距离边缘 16px
   - 动画：滑入 100ms（`translateX` 右→左），滑出 200ms（左→右）
   - 支持同时多条 Toast 垂直叠加（间距 8px）

### 技术要求

1. **零依赖**：纯原生 HTML/CSS/JS，无额外库
2. **ES Module**：导出为 `public/js/toast.js`，在 `app.js` 中 `import` 并挂载 `window.toast`
3. **样式集成**：使用项目现有 CSS 变量（`--red`、`--green`、`--accent`、`--accent-soft` 等）
4. **兼容性**：支持所有现代浏览器

---

## 设计细节

### DOM 结构

**容器（一次注入）**：
```html
<div id="toast-container"></div>
```

**单条 Toast（动态生成）**：
```html
<div class="toast toast--error">
  <span class="toast-icon">✕</span>
  <span class="toast-msg">清空失败，请重试</span>
  <button class="toast-close" title="关闭" aria-label="关闭提示">✕</button>
</div>
```

### 样式规格

**容器** (`.toast-container`)：
```css
position: fixed;
bottom: 16px;
right: 16px;
display: flex;
flex-direction: column-reverse;  /* 新 Toast 从下往上堆积 */
gap: 8px;
z-index: 9999;
pointer-events: none;  /* 不拦截下层事件，但 Toast 本身 pointer-events: auto */
```

**单条 Toast** (`.toast`)：
```css
display: flex;
align-items: center;
gap: 10px;
padding: 12px 14px;
border-radius: 8px;
border: 1px solid;
backdrop-filter: blur(10px);
font-size: 13px;
line-height: 1.5;
pointer-events: auto;
min-width: 280px;
max-width: 360px;
box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
```

**类型样式** (`.toast--error / --success / --info`)：

| 类型 | border-color | background | icon |
|---|---|---|---|
| error | `var(--red)` | `rgba(229, 104, 122, 0.12)` | ✕ |
| success | `var(--green)` | `rgba(108, 195, 138, 0.12)` | ✓ |
| info | `var(--accent)` | `var(--accent-soft)` | ℹ |

**图标** (`.toast-icon`)：
```css
color: 对应类型颜色;
font-weight: bold;
flex-shrink: 0;
```

**关闭按钮** (`.toast-close`)：
```css
background: none;
border: none;
color: var(--muted);
cursor: pointer;
font-size: 12px;
padding: 0;
flex-shrink: 0;

&:hover {
  color: var(--text);
}
```

**动画**：
```css
/* 入场 */
@keyframes slideInToast {
  from { opacity: 0; transform: translateX(calc(100% + 16px)); }
  to { opacity: 1; transform: translateX(0); }
}

/* 出场 */
@keyframes slideOutToast {
  from { opacity: 1; transform: translateX(0); }
  to { opacity: 0; transform: translateX(calc(100% + 16px)); }
}

.toast {
  animation: slideInToast 0.1s ease-out forwards;
}

.toast.removing {
  animation: slideOutToast 0.2s ease-in forwards;
}
```

---

## 实现接口

### `public/js/toast.js` 导出对象

```js
export default {
  error(message, duration = 3000),
  success(message, duration = 3000),
  info(message, duration = 3000),
  _init(),  // 内部使用，初始化容器
}
```

### 使用示例

```js
import toast from './toast.js';
// 或在 app.js 中做 window.toast = toast

window.toast.error('文件上传失败：网络超时');
window.toast.success('保存成功');
window.toast.info('已清空日志');
```

---

## 替换清单

| 文件 | 行号 | 原代码 | 替换为 |
|---|---|---|---|
| `public/js/chat.js` | 1572 | `alert(r.error)` | `window.toast.error(r.error)` |
| `public/js/chat.js` | 1575 | `alert('调用系统对话框失败')` | `window.toast.error('调用系统对话框失败')` |
| `public/js/composer.js` | 116 | `alert('文件上传失败：' + ...)` | `window.toast.error('文件上传失败：' + ...)` |
| `public/js/logs-panel.js` | 76 | `alert('清空失败，请重试')` | `window.toast.error('清空失败，请重试')` |
| `public/js/tasks-panel.js` | 334 | `alert(d.error)` | `window.toast.error(d.error)` |
| `public/js/tasks-panel.js` | 337 | `alert('操作失败')` | `window.toast.error('操作失败')` |

**备注**：`docs/superpowers/plans/` 中 plan 文档内的 alert 为文档示例代码，不涉及运行时，保持不变。

---

## 堆叠与出队逻辑

1. 新 Toast 创建时，加入 DOM 并立即执行入场动画
2. 同时监听 `animationend` 事件，入场完成后开始倒计时（3s）
3. 倒计时结束或用户点击关闭时，添加 `.removing` 类触发出场动画
4. 出场动画完成时，从 DOM 中移除该 Toast 实例
5. **出队规则**：维护一个内部 Toast 队列，始终限制 DOM 中最多 3 个 `.toast` 元素
   - 若已有 3 个 Toast，新 Toast 入队时，自动触发最老 Toast 的出场（而非等待其自然超时）
   - 出队的 Toast 仍需经过出场动画，确保视觉连贯

---

## 测试范围

- 单条 Toast 显示和自动消失
- 多条 Toast 垂直堆叠
- 出队逻辑（第 4 条输入时，最老的立即消失）
- 手动点击关闭按钮
- 三种类型样式正确
- 动画流畅（无卡顿）
- CSS 变量适配（亮色主题若添加，自动适配）

---

## 后续扩展点

- 支持自定义 icon（当前写死 ✕/✓/ℹ）
- 支持自定义消失时长
- 支持 Undo 按钮（如"已删除，撤销"）
- 通知声音（可选，需用户授权）


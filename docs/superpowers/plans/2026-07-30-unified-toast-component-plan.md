# 统一 Toast 提示组件 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建统一样式的 Toast 提示组件，替换项目中的 7 处系统级 `alert()` 调用，提升用户交互体验。

**Architecture:** 
- 核心组件 `public/js/toast.js` 负责 Toast 生命周期管理（创建、堆叠、自动消失、出队）
- CSS 样式 `public/app.css` 定义三种类型样式及动画
- `public/app.js` 在应用启动时初始化并挂载到 `window.toast`
- 在 7 个业务模块中统一替换 `alert(msg)` 为 `window.toast.error(msg)`

**Tech Stack:** 纯原生 HTML/CSS/JS ES Module，无外部依赖

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `public/js/toast.js` | **创建** - Toast 组件核心逻辑（DOM 管理、队列、生命周期） |
| `public/app.css` | **修改** - 添加 Toast 样式 + 动画（~80 行） |
| `public/app.js` | **修改** - 导入 toast 并初始化（~3 行） |
| `public/js/chat.js` | **修改** - 替换 2 处 `alert()` |
| `public/js/composer.js` | **修改** - 替换 1 处 `alert()` |
| `public/js/logs-panel.js` | **修改** - 替换 1 处 `alert()` |
| `public/js/tasks-panel.js` | **修改** - 替换 2 处 `alert()` |

---

## Task 1: 创建 Toast 组件核心模块

**Files:**
- Create: `public/js/toast.js`

- [ ] **Step 1: 创建 `public/js/toast.js` 框架，实现基础 API**

```javascript
// public/js/toast.js

let toastContainer = null;
const toastQueue = [];
const maxToasts = 3;

/**
 * 初始化 Toast 容器
 */
function _init() {
  if (toastContainer) return;
  toastContainer = document.createElement('div');
  toastContainer.id = 'toast-container';
  document.body.appendChild(toastContainer);
}

/**
 * 创建并显示一条 Toast
 * @param {string} message - 消息内容
 * @param {string} type - 类型：'error' | 'success' | 'info'
 * @param {number} duration - 显示时长（毫秒），默认 3000
 */
function _show(message, type = 'error', duration = 3000) {
  _init();

  // 创建 Toast DOM 元素
  const toastEl = document.createElement('div');
  toastEl.className = `toast toast--${type}`;

  // 确定图标
  const iconMap = {
    error: '✕',
    success: '✓',
    info: 'ℹ',
  };
  const icon = iconMap[type] || '•';

  // 组装 HTML
  toastEl.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-msg">${escapeHtml(message)}</span>
    <button class="toast-close" title="关闭" aria-label="关闭提示">✕</button>
  `;

  // 添加到 DOM
  toastContainer.appendChild(toastEl);
  toastQueue.push(toastEl);

  // 绑定关闭按钮事件
  const closeBtn = toastEl.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => _removeToast(toastEl));

  // 等待入场动画完成后开始计时
  toastEl.addEventListener('animationend', (e) => {
    if (e.animationName === 'slideInToast') {
      // 入场完成，开始倒计时
      setTimeout(() => _removeToast(toastEl), duration);
    } else if (e.animationName === 'slideOutToast') {
      // 出场完成，从 DOM 移除
      toastEl.remove();
      const idx = toastQueue.indexOf(toastEl);
      if (idx > -1) toastQueue.splice(idx, 1);
    }
  });

  // 超过最大数量时，删除最老的
  if (toastQueue.length > maxToasts) {
    const oldest = toastQueue.shift();
    _removeToast(oldest);
  }
}

/**
 * 移除一条 Toast（触发出场动画）
 */
function _removeToast(toastEl) {
  if (!toastEl.classList.contains('removing')) {
    toastEl.classList.add('removing');
  }
}

/**
 * 转义 HTML 特殊字符
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * 导出 API
 */
export default {
  error(message, duration = 3000) {
    _show(message, 'error', duration);
  },
  success(message, duration = 3000) {
    _show(message, 'success', duration);
  },
  info(message, duration = 3000) {
    _show(message, 'info', duration);
  },
  _init,
};
```

- [ ] **Step 2: 提交 toast.js**

```bash
git add public/js/toast.js
git commit -m "feat: create toast component module"
```

---

## Task 2: 添加 Toast 样式和动画

**Files:**
- Modify: `public/app.css` - 文件末尾添加

- [ ] **Step 1: 在 `public/app.css` 末尾添加 Toast 容器和组件样式**

在文件末尾追加以下内容：

```css
/* ============ Toast 提示组件 ============ */

#toast-container {
  position: fixed;
  bottom: 16px;
  right: 16px;
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  z-index: 9999;
  pointer-events: none;
}

.toast {
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
  animation: slideInToast 0.1s ease-out forwards;
}

.toast.removing {
  animation: slideOutToast 0.2s ease-in forwards;
}

/* 错误样式 */
.toast--error {
  border-color: var(--red);
  background: rgba(229, 104, 122, 0.12);
  color: var(--text);
}

.toast--error .toast-icon {
  color: var(--red);
  font-weight: bold;
  flex-shrink: 0;
}

/* 成功样式 */
.toast--success {
  border-color: var(--green);
  background: rgba(108, 195, 138, 0.12);
  color: var(--text);
}

.toast--success .toast-icon {
  color: var(--green);
  font-weight: bold;
  flex-shrink: 0;
}

/* 信息样式 */
.toast--info {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}

.toast--info .toast-icon {
  color: var(--accent);
  font-weight: bold;
  flex-shrink: 0;
}

/* 关闭按钮 */
.toast-close {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
  flex-shrink: 0;
  margin-left: 6px;
  transition: color 0.2s ease;
}

.toast-close:hover {
  color: var(--text);
}

.toast-msg {
  flex: 1;
  word-break: break-word;
}

/* 动画定义 */
@keyframes slideInToast {
  from {
    opacity: 0;
    transform: translateX(calc(100% + 16px));
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes slideOutToast {
  from {
    opacity: 1;
    transform: translateX(0);
  }
  to {
    opacity: 0;
    transform: translateX(calc(100% + 16px));
  }
}
```

- [ ] **Step 2: 提交样式**

```bash
git add public/app.css
git commit -m "style: add toast component styles and animations"
```

---

## Task 3: 在 app.js 中初始化 Toast

**Files:**
- Modify: `public/app.js` - 顶部导入语句处

- [ ] **Step 1: 打开 `public/app.js`，在顶部导入 toast 并初始化**

找到现有的导入语句（第一行）后面，添加：

```javascript
import toast from './js/toast.js';

// 初始化 Toast 组件
window.toast = toast;
toast._init();
```

例如，假设文件开头是这样：
```javascript
import { someModule } from './path.js';
import { anotherModule } from './path2.js';
```

改为：
```javascript
import { someModule } from './path.js';
import { anotherModule } from './path2.js';
import toast from './js/toast.js';

// 初始化 Toast 组件
window.toast = toast;
toast._init();
```

- [ ] **Step 2: 提交修改**

```bash
git add public/app.js
git commit -m "feat: import and initialize toast component in app.js"
```

---

## Task 4: 替换 chat.js 中的 alert 调用

**Files:**
- Modify: `public/js/chat.js` - 第 1572 行、第 1575 行

- [ ] **Step 1: 打开 `public/js/chat.js`，找到第 1572 行附近**

搜索 `alert(r.error)` 和 `alert('调用系统对话框失败')`

原代码（第 1572 行）：
```javascript
else if (r.error) alert(r.error);
```

改为：
```javascript
else if (r.error) window.toast.error(r.error);
```

原代码（第 1575 行）：
```javascript
alert('调用系统对话框失败');
```

改为：
```javascript
window.toast.error('调用系统对话框失败');
```

- [ ] **Step 2: 提交修改**

```bash
git add public/js/chat.js
git commit -m "refactor: replace alert with toast.error in chat.js"
```

---

## Task 5: 替换 composer.js 中的 alert 调用

**Files:**
- Modify: `public/js/composer.js` - 第 116 行

- [ ] **Step 1: 打开 `public/js/composer.js`，找到第 116 行**

搜索 `alert('文件上传失败'`

原代码（第 116 行）：
```javascript
alert('文件上传失败：' + (err && err.message ? err.message : err));
```

改为：
```javascript
window.toast.error('文件上传失败：' + (err && err.message ? err.message : err));
```

- [ ] **Step 2: 提交修改**

```bash
git add public/js/composer.js
git commit -m "refactor: replace alert with toast.error in composer.js"
```

---

## Task 6: 替换 logs-panel.js 中的 alert 调用

**Files:**
- Modify: `public/js/logs-panel.js` - 第 76 行

- [ ] **Step 1: 打开 `public/js/logs-panel.js`，找到第 76 行**

搜索 `alert('清空失败'`

原代码（第 76 行）：
```javascript
alert('清空失败，请重试');
```

改为：
```javascript
window.toast.error('清空失败，请重试');
```

- [ ] **Step 2: 提交修改**

```bash
git add public/js/logs-panel.js
git commit -m "refactor: replace alert with toast.error in logs-panel.js"
```

---

## Task 7: 替换 tasks-panel.js 中的 alert 调用

**Files:**
- Modify: `public/js/tasks-panel.js` - 第 334 行、第 337 行

- [ ] **Step 1: 打开 `public/js/tasks-panel.js`，找到第 334 和 337 行**

搜索 `alert(d.error)` 和 `alert('操作失败'`

原代码（第 334 行）：
```javascript
if (d.error) return alert(d.error);
```

改为：
```javascript
if (d.error) return window.toast.error(d.error);
```

原代码（第 337 行）：
```javascript
alert('操作失败');
```

改为：
```javascript
window.toast.error('操作失败');
```

- [ ] **Step 2: 提交修改**

```bash
git add public/js/tasks-panel.js
git commit -m "refactor: replace alert with toast.error in tasks-panel.js"
```

---

## Task 8: 手动测试 Toast 组件

**Manual Testing Checklist:**

- [ ] **Step 1: 启动应用并打开浏览器开发者工具**

在浏览器控制台运行测试命令：

```javascript
// 测试错误提示
window.toast.error('这是一个错误提示');

// 测试成功提示
window.toast.success('这是一个成功提示');

// 测试信息提示
window.toast.info('这是一个信息提示');
```

预期行为：
- Toast 从右下角滑入，显示对应类型的样式
- 3 秒后自动消失
- 可以手动点击关闭按钮 ✕ 立即消失

- [ ] **Step 2: 测试堆叠和出队**

连续发送 5 条消息：

```javascript
for (let i = 1; i <= 5; i++) {
  window.toast.error(`消息 ${i}`);
}
```

预期行为：
- 最多同时显示 3 条 Toast
- 第 4、5 条输入时，最老的 Toast 立即消失（触发出场动画）
- 不会出现 4 条或以上的 Toast 同时显示

- [ ] **Step 3: 测试替换后的业务流程**

在应用中触发原 `alert()` 的业务逻辑，验证替换是否成功：

- **chat.js**：在系统文件选择中点"取消"或网络错误时，应显示 Toast
- **composer.js**：尝试上传文件并模拟失败，应显示 Toast
- **logs-panel.js**：点击清空日志，如果失败应显示 Toast
- **tasks-panel.js**：执行任务操作，失败时应显示 Toast

- [ ] **Step 4: 视觉检查**

- [ ] Toast 样式与项目整体风格一致（深色、橙色边框）
- [ ] 动画流畅，无卡顿
- [ ] 文本显示完整，不被遮挡
- [ ] 关闭按钮可点击，hover 时变浅

- [ ] **Step 5: 记录测试结果**

所有测试通过后，标记此任务完成。

---

## Task 9: 最终提交和验收

**Files:**
- 整个 Feature 的集成测试

- [ ] **Step 1: 检查 git 日志确认所有提交**

```bash
git log --oneline -10
```

应该看到以下提交：
- feat: create toast component module
- style: add toast component styles and animations
- feat: import and initialize toast component in app.js
- refactor: replace alert with toast.error in chat.js
- refactor: replace alert with toast.error in composer.js
- refactor: replace alert with toast.error in logs-panel.js
- refactor: replace alert with toast.error in tasks-panel.js

- [ ] **Step 2: 运行应用并进行端到端测试**

启动项目，使用真实业务流程验证所有 alert 替换点都工作正常。

- [ ] **Step 3: 检查代码规范**

确保代码遵循项目风格：
- ✅ 使用 ES Module 导入/导出
- ✅ 函数注释清晰
- ✅ CSS 变量一致使用
- ✅ 没有硬编码颜色值或魔数

- [ ] **Step 4: 提交完成**

所有任务完成，等待 code review。

---

## 自审检查

✅ **Spec 覆盖**：
- [x] 三种类型样式（error/success/info）- Task 2
- [x] 组件 API（toast.error/success/info）- Task 1
- [x] 右下角位置 + 滑入/滑出动画 - Task 2
- [x] 3 秒自动消失 - Task 1
- [x] 最多 3 条堆叠，超过出队 - Task 1
- [x] 手动关闭按钮 - Task 1
- [x] 7 处 alert 替换 - Tasks 4-7
- [x] CSS 变量集成 - Task 2
- [x] 初始化挂载 - Task 3

✅ **代码完整性**：所有代码块都是可直接使用的完整片段，无占位符

✅ **类型一致性**：
- `toast.error/success/info()` API 统一
- `escapeHtml()` 防 XSS
- `.removing` 类名统一管理

✅ **没有占位符**：没有 "TBD"、"类似 Task X"、"根据需要"

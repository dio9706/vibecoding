# 侧边栏展开/收起功能设计

**日期**：2026-07-19  
**功能**：左侧对话历史面板可展开/收起  
**方案**：混合响应式 + 遮罩层

---

## 1. 功能概述

### 目标
为左侧对话历史侧边栏添加展开/收起能力，提升小屏幕用户体验，同时保持桌面端的固定布局。

### 核心需求
- 手动控制：点击顶栏左上角 `☰` 按钮切换状态
- 状态持久化：用户偏好存储在 localStorage
- 响应式：
  - 小屏幕（≤720px）：初始收起，☰ 按钮可见，展开时显示遮罩
  - 大屏幕（>720px）：初始展开，☰ 按钮隐藏，侧边栏固定

---

## 2. 状态管理

### 全局状态
| 属性 | 类型 | 存储 | 初始值 |
|------|------|------|--------|
| `sidebarCollapsed` | boolean | localStorage | 根据屏幕宽度 |
| localStorage 键 | string | 浏览器 | `claude-sidebar-collapsed` |

### 初始值逻辑
```
if (localStorage 有值) {
  sidebarCollapsed = 读取值
} else {
  sidebarCollapsed = (屏幕宽度 ≤ 720px)
  // 小屏幕默认收起，大屏幕默认展开
}
```

---

## 3. UI 组件变更

### 3.1 新增 HTML 元素

**顶栏 ☰ 按钮**
```html
<button class="sidebar-toggle-btn" id="sidebarToggleBtn" title="切换侧边栏">☰</button>
```
- 位置：顶栏左上角，品牌 logo 后面（或替代品牌位置）
- ID：`sidebarToggleBtn`
- 类名：`sidebar-toggle-btn`
- 文本内容：`☰`（U+2630）

**侧边栏遮罩层**
```html
<div class="sidebar-overlay" id="sidebarOverlay"></div>
```
- 位置：`<body>` 底部，`</div><!-- .shell -->` 前
- ID：`sidebarOverlay`
- 类名：`sidebar-overlay`
- 用途：移动端展开侧边栏时显示，点击关闭

### 3.2 CSS 类名

**侧边栏收起状态**
- 类名：`sidebar.collapsed`
- 效果：宽度收缩为 0，内容隐藏

**遮罩可见状态**
- 类名：`sidebar-overlay.visible`
- 效果：背景颜色可见，指针事件激活

---

## 4. 样式设计

### 4.1 侧边栏变更

```css
/* 侧边栏收起状态 */
.sidebar.collapsed {
  width: 0;
  min-width: 0;
  overflow: hidden;
  transition: width 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* 侧边栏展开（默认状态）平滑过渡 */
.sidebar {
  transition: width 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

**变更原因**
- 从 `width: 260px` 平滑过渡到 `width: 0`
- 使用弹性缓动（cubic-bezier），对标项目中其他交互动画
- 150ms 快速响应

### 4.2 遮罩层样式

```css
.sidebar-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 45;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

.sidebar-overlay.visible {
  opacity: 1;
  pointer-events: auto;
}
```

**特点**
- 固定定位，覆盖整个视口
- z-index 45（低于侧边栏的 z-index 50）
- 初始状态不可见、不可交互
- 淡入淡出动画（150ms ease）

### 4.3 ☰ 按钮样式

```css
.sidebar-toggle-btn {
  display: none; /* 桌面端隐藏 */
  font-size: 18px;
  color: var(--muted);
  background: none;
  border: none;
  cursor: pointer;
  margin-right: 8px;
  transition: color 0.15s;
}

.sidebar-toggle-btn:hover {
  color: var(--text);
}

/* 小屏幕显示按钮 */
@media (max-width: 720px) {
  .sidebar-toggle-btn {
    display: block;
  }
  
  /* 小屏幕侧边栏固定定位 */
  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    height: 100vh;
    z-index: 50;
  }
}
```

**特点**
- 桌面端（>720px）：`display: none` 隐藏
- 小屏幕（≤720px）：`display: block` 显示
- hover 颜色变化，与现有按钮风格一致
- 右边距 8px，与其他顶栏元素间距统一

---

## 5. JavaScript 实现

### 5.1 初始化函数

```javascript
function initSidebar() {
  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  const stored = localStorage.getItem('claude-sidebar-collapsed');
  
  let collapsed;
  if (stored !== null) {
    collapsed = stored === 'true';
  } else {
    collapsed = isMobile;
  }
  
  setSidebarCollapsed(collapsed);
}
```

**逻辑**
1. 检测当前屏幕是否为小屏幕（≤720px）
2. 从 localStorage 读取保存状态
3. 若无保存状态，根据屏幕宽度决定初始值
4. 调用 `setSidebarCollapsed()` 应用状态

### 5.2 设置状态函数

```javascript
function setSidebarCollapsed(collapsed) {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebarToggleBtn');
  const overlay = document.getElementById('sidebarOverlay');
  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  
  if (collapsed) {
    sidebar.classList.add('collapsed');
    if (isMobile) {
      overlay.classList.add('visible');
    }
  } else {
    sidebar.classList.remove('collapsed');
    overlay.classList.remove('visible');
  }
  
  localStorage.setItem('claude-sidebar-collapsed', collapsed);
}
```

**逻辑**
- 收起（collapsed=true）：
  - 侧边栏添加 `collapsed` 类
  - 小屏幕：遮罩添加 `visible` 类（显示）
  - 大屏幕：遮罩无操作（保持隐藏）
- 展开（collapsed=false）：
  - 侧边栏移除 `collapsed` 类
  - 遮罩移除 `visible` 类（隐藏）
- 最后持久化到 localStorage

### 5.3 切换函数

```javascript
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const isCollapsed = sidebar.classList.contains('collapsed');
  setSidebarCollapsed(!isCollapsed);
}
```

**逻辑**
- 检查当前状态
- 反转状态并调用 `setSidebarCollapsed()`

### 5.4 事件绑定

```javascript
// ☰ 按钮点击
document.getElementById('sidebarToggleBtn')?.addEventListener('click', toggleSidebar);

// 遮罩点击关闭侧边栏
document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
  setSidebarCollapsed(true);
});

// 窗口大小变化时调整
window.addEventListener('resize', () => {
  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  const sidebar = document.getElementById('sidebar');
  if (!isMobile && sidebar.classList.contains('collapsed')) {
    // 大屏幕时强制展开
    setSidebarCollapsed(false);
  }
});

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', initSidebar);
```

**事件说明**
| 事件 | 触发 | 动作 |
|------|------|------|
| `sidebarToggleBtn#click` | 用户点击 ☰ | 切换状态 |
| `sidebarOverlay#click` | 用户点击遮罩 | 收起侧边栏 |
| `window#resize` | 窗口大小变化 | 大屏幕强制展开 |
| `DOMContentLoaded` | 页面加载完成 | 初始化状态 |

---

## 6. 交互流程

### 6.1 桌面端（>720px）

```
页面加载
  ↓
initSidebar()：isMobile=false → collapsed=false
  ↓
侧边栏展开，☰ 按钮隐藏
  ↓
固定状态（无用户操作）
  ↓
窗口缩小到 ≤720px
  ↓
resize 事件触发
  ↓
若侧边栏已收起，强制展开
```

### 6.2 移动端（≤720px）

```
页面加载
  ↓
initSidebar()：isMobile=true → collapsed=true（或读取 localStorage）
  ↓
侧边栏收起（width=0），☰ 按钮显示，无遮罩
  ↓
用户点击 ☰
  ↓
toggleSidebar() → setSidebarCollapsed(false)
  ↓
侧边栏展开（width=260px），遮罩显示
  ↓
用户点击遮罩或 ☰
  ↓
setSidebarCollapsed(true)
  ↓
侧边栏收起，遮罩隐藏
  ↓
localStorage 记忆偏好
```

---

## 7. 实现清单

### HTML 改动
- [ ] 在 `<header class="topbar">` 中插入 ☰ 按钮（`.brand` 之后或之前）
- [ ] 在 `<body>` 底部（`</div><!-- .shell -->` 前）插入遮罩层 `<div class="sidebar-overlay">`

### CSS 改动
- [ ] 在 `app.css` 中添加 `.sidebar.collapsed` 类样式
- [ ] 添加 `.sidebar` 的 transition 样式
- [ ] 添加 `.sidebar-overlay` 和 `.sidebar-overlay.visible` 样式
- [ ] 添加 `.sidebar-toggle-btn` 和 `@media (max-width: 720px)` 规则
- [ ] 调整小屏幕时 `.sidebar` 的 `position: fixed; left: 0; top: 0; height: 100vh;`

### JavaScript 改动
- [ ] 在 `public/app.js` 中添加 `initSidebar()` 函数
- [ ] 添加 `setSidebarCollapsed()` 函数
- [ ] 添加 `toggleSidebar()` 函数
- [ ] 绑定事件：`sidebarToggleBtn#click`、`sidebarOverlay#click`、`window#resize`、`DOMContentLoaded`

---

## 8. 设计验证检查

- ✅ 功能清晰：手动展开/收起，状态持久化
- ✅ 响应式：小屏幕收起，大屏幕展开
- ✅ 动画平滑：150ms 弹性缓动，对标项目风格
- ✅ 交互友好：遮罩提示，resize 防脱离
- ✅ 无冲突：新增元素不影响现有功能（历史搜索、新对话、删除等）
- ✅ 无歧义：状态转换清晰，变量命名一致


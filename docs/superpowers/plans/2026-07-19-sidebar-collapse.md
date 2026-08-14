# 侧边栏展开/收起功能 实现计划

> **对于代理工作者：** 建议使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 按任务逐步执行此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 为左侧对话历史侧边栏添加手动展开/收起能力，提升移动端体验，保持桌面端固定布局。

**架构：** 
- 顶栏添加 ☰ 按钮，通过点击切换侧边栏 `collapsed` 类
- 状态通过 localStorage 持久化
- 响应式设计：小屏幕（≤720px）初始收起+显示按钮，大屏幕初始展开+隐藏按钮
- 移动端展开时显示半透明遮罩层，点击遮罩可关闭侧边栏

**技术栈：** 原生 HTML / CSS / JavaScript（无框架依赖）

---

## 文件结构

```
public/
├── index.html         # 修改：添加 ☰ 按钮和遮罩层 HTML
├── app.css            # 修改：添加侧边栏收起、遮罩、按钮样式
└── app.js             # 修改：添加初始化和事件绑定逻辑
```

**每个文件的职责：**
- `index.html`：提供新增元素（按钮、遮罩）的 DOM 结构
- `app.css`：定义所有样式（宽度、过渡、显示隐藏、媒体查询）
- `app.js`：管理状态、localStorage、事件监听

---

## Task 1: HTML — 添加顶栏 ☰ 按钮

**文件：**
- Modify: `public/index.html:20-26`（顶栏 header 区域）

- [ ] **Step 1：在顶栏插入 ☰ 按钮**

打开 `public/index.html`，在 `<header class="topbar">` 内找到 `<div class="brand">` 标签。在其后插入：

```html
<button class="sidebar-toggle-btn" id="sidebarToggleBtn" title="切换侧边栏">☰</button>
```

完整顶栏代码应该看起来像：
```html
<header class="topbar">
  <div class="brand"><span class="mark">◆</span></div>
  <button class="sidebar-toggle-btn" id="sidebarToggleBtn" title="切换侧边栏">☰</button>
  <button class="dir-selector" id="dirBtn" title="选择工作目录">
    <!-- ... 后续内容 ... -->
  </button>
  <!-- ... -->
</header>
```

- [ ] **Step 2：验证 HTML 结构**

在浏览器中打开 `public/index.html`（通过项目的 dev server），查看顶栏。此时 ☰ 按钮应该出现但样式为默认，可能不太明显。

- [ ] **Step 3：提交此任务**

```bash
git add public/index.html
git commit -m "html: 在顶栏添加侧边栏折叠按钮"
```

---

## Task 2: HTML — 添加遮罩层

**文件：**
- Modify: `public/index.html:90-200`（关闭 `.shell` div 前）

- [ ] **Step 1：在 body 底部插入遮罩层**

找到 `</div><!-- .shell -->` 这一行（大约在 line 89），在其后（`</body>` 前）插入：

```html
<div class="sidebar-overlay" id="sidebarOverlay"></div>
```

完整的 body 末尾应该看起来像：
```html
      </div>
    </div>
    <!-- 遮罩层：小屏幕时展开侧边栏时显示 -->
    <div class="sidebar-overlay" id="sidebarOverlay"></div>

    <!-- Markdown 渲染组件 -->
    <script src="/vendor/marked.min.js"></script>
    <!-- ... 脚本标签 ... -->
  </body>
</html>
```

- [ ] **Step 2：验证 HTML 结构**

在浏览器 DevTools 中检查 DOM，确保 `<div class="sidebar-overlay" id="sidebarOverlay"></div>` 存在且位于 `</div><!-- .shell -->` 后。

- [ ] **Step 3：提交此任务**

```bash
git add public/index.html
git commit -m "html: 添加侧边栏遮罩层"
```

---

## Task 3: CSS — 侧边栏基础过渡

**文件：**
- Modify: `public/app.css:44-51`（`.sidebar` 初始定义）

- [ ] **Step 1：为侧边栏添加过渡效果**

在 `.sidebar` 样式块中添加 `transition` 属性：

找到现有的：
```css
.sidebar {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-soft);
  background: rgba(22, 23, 31, 0.5);
}
```

修改为：
```css
.sidebar {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-soft);
  background: rgba(22, 23, 31, 0.5);
  transition: width 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

只是在最后添加一行：`transition: width 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);`

- [ ] **Step 2：验证过渡属性**

在浏览器 DevTools 中选中 `.sidebar` 元素，查看 Computed Styles 确认 `transition` 属性已应用。

- [ ] **Step 3：提交此任务**

```bash
git add public/app.css
git commit -m "css: 为侧边栏添加宽度过渡动画"
```

---

## Task 4: CSS — 侧边栏收起状态样式

**文件：**
- Modify: `public/app.css:286`（在 `@media (max-width: 720px)` 前插入）

- [ ] **Step 1：添加侧边栏收起状态类**

在 `app.css` 中找到 `@media (max-width: 720px)` 这行（大约 line 282），在其前插入新的 CSS 规则块：

```css
/* 侧边栏收起状态 */
.sidebar.collapsed {
  width: 0;
  min-width: 0;
  overflow: hidden;
}
```

完整位置应该是：
```css
/* ... 前面的 .sidebar 定义和其他样式 ... */

/* 侧边栏收起状态 */
.sidebar.collapsed {
  width: 0;
  min-width: 0;
  overflow: hidden;
}

@media (max-width: 720px) {
  .sidebar {
    width: 180px;
  }
}
```

- [ ] **Step 2：验证样式定义**

在浏览器 DevTools 中搜索 `.sidebar.collapsed`，确认规则已定义。

- [ ] **Step 3：提交此任务**

```bash
git add public/app.css
git commit -m "css: 添加侧边栏收起状态 .collapsed 类"
```

---

## Task 5: CSS — 遮罩层样式

**文件：**
- Modify: `public/app.css:462`（在滚动条样式前插入）

- [ ] **Step 1：添加遮罩层样式**

在 `app.css` 中找到 `/* ---- 统一滚动条样式 ---- */` 注释（大约 line 438），在其前插入：

```css
/* ---- 侧边栏遮罩层 ---- */
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

完整位置：
```css
/* ... 前面的样式 ... */

/* ---- 侧边栏遮罩层 ---- */
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

/* ---- 统一滚动条样式 ---- */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
```

- [ ] **Step 2：验证样式定义**

在浏览器 DevTools 中搜索 `.sidebar-overlay`，确认两个规则都已定义。

- [ ] **Step 3：提交此任务**

```bash
git add public/app.css
git commit -m "css: 添加侧边栏遮罩层样式"
```

---

## Task 6: CSS — ☰ 按钮和媒体查询

**文件：**
- Modify: `public/app.css:282-286`（现有 `@media (max-width: 720px)` 块）

- [ ] **Step 1：添加按钮基础样式**

在 `.conv-badge.web` 之后（大约 line 256），在滚动条样式前插入：

```css
/* ---- 侧边栏折叠按钮 ---- */
.sidebar-toggle-btn {
  display: none;
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
```

- [ ] **Step 2：修改现有媒体查询块**

找到现有的：
```css
@media (max-width: 720px) {
  .sidebar {
    width: 180px;
  }
}
```

修改为：
```css
@media (max-width: 720px) {
  .sidebar-toggle-btn {
    display: block;
  }
  
  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    height: 100vh;
    z-index: 50;
    width: 260px;
  }
}
```

**说明：** 替换现有的 `width: 180px;` 为完整的固定定位规则。

- [ ] **Step 3：验证媒体查询**

在浏览器中：
1. 打开 DevTools，切换到移动设备视图（宽度 ≤ 720px）
2. 查看顶栏，确认 ☰ 按钮显示
3. 在 DevTools 中检查 `.sidebar` 样式，确认 `position: fixed; left: 0; top: 0; height: 100vh;` 已应用
4. 切换回桌面视图（>720px），确认 ☰ 按钮隐藏

- [ ] **Step 4：提交此任务**

```bash
git add public/app.css
git commit -m "css: 添加按钮样式和小屏幕媒体查询"
```

---

## Task 7: JavaScript — 状态管理函数

**文件：**
- Modify: `public/app.js`（在文件末尾添加）

- [ ] **Step 1：添加初始化函数**

打开 `public/app.js`，在文件末尾添加：

```javascript
// ---- 侧边栏展开/收起功能 ----

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

function setSidebarCollapsed(collapsed) {
  const sidebar = document.getElementById('sidebar');
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

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const isCollapsed = sidebar.classList.contains('collapsed');
  setSidebarCollapsed(!isCollapsed);
}
```

- [ ] **Step 2：验证函数定义**

在浏览器 DevTools Console 中输入 `initSidebar`，应该显示函数定义。

- [ ] **Step 3：提交此任务**

```bash
git add public/app.js
git commit -m "js: 添加侧边栏状态管理函数"
```

---

## Task 8: JavaScript — 事件绑定和初始化

**文件：**
- Modify: `public/app.js`（继续在末尾添加）

- [ ] **Step 1：添加事件监听和初始化调用**

在前一任务添加的函数后继续添加：

```javascript
// 事件绑定
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    initSidebar();
    bindSidebarEvents();
  });
} else {
  // 如果脚本在 DOMContentLoaded 后加载
  initSidebar();
  bindSidebarEvents();
}

function bindSidebarEvents() {
  const toggleBtn = document.getElementById('sidebarToggleBtn');
  const overlay = document.getElementById('sidebarOverlay');
  
  // ☰ 按钮点击
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function(e) {
      e.preventDefault();
      toggleSidebar();
    });
  }
  
  // 遮罩点击关闭侧边栏
  if (overlay) {
    overlay.addEventListener('click', function() {
      setSidebarCollapsed(true);
    });
  }
  
  // 窗口大小变化时调整
  window.addEventListener('resize', function() {
    const isMobile = window.matchMedia('(max-width: 720px)').matches;
    const sidebar = document.getElementById('sidebar');
    if (!isMobile && sidebar.classList.contains('collapsed')) {
      // 大屏幕时强制展开
      setSidebarCollapsed(false);
    }
  });
}
```

- [ ] **Step 2：验证事件绑定**

在浏览器中刷新页面，DevTools Console 应该无错误。点击 ☰ 按钮，应该看到侧边栏消失/出现。

- [ ] **Step 3：提交此任务**

```bash
git add public/app.js
git commit -m "js: 添加事件绑定和初始化逻辑"
```

---

## Task 9: 手动测试 — 桌面端行为

**验证点：**

- [ ] **Step 1：桌面视图初始状态**

1. 打开浏览器，访问项目（刷新确保 localStorage 清空或初始值正确）
2. 调整视口宽度 > 720px（桌面）
3. 观察：
   - ☰ 按钮不显示
   - 侧边栏展开（width=260px），占据左侧
   - localStorage 中 `claude-sidebar-collapsed` 应为 `false`

- [ ] **Step 2：桌面端缩小到移动宽度**

1. 在 DevTools 中切换到移动视图（宽度 ≤ 720px）
2. 观察：
   - ☰ 按钮显示
   - 侧边栏从固定定位变为 `position: fixed`
   - 侧边栏仍展开（因为 localStorage 记忆为 `false`）

- [ ] **Step 3：移动端点击切换**

1. 保持移动视图
2. 点击 ☰ 按钮
3. 观察：
   - 侧边栏平滑收起（width 0-260px 过渡）
   - 遮罩层淡入（opacity 0-1）
   - localStorage 更新为 `true`
4. 再点击 ☰：
   - 侧边栏展开
   - 遮罩淡出
   - localStorage 更新为 `false`

- [ ] **Step 4：点击遮罩关闭**

1. 保持移动视图，侧边栏展开
2. 点击遮罩（侧边栏外的暗区）
3. 观察：
   - 侧边栏立即收起
   - 遮罩淡出

- [ ] **Step 5：resize 事件强制展开**

1. 移动视图，侧边栏收起
2. 逐渐扩大视口到 > 720px（或从 DevTools 切换到桌面视图）
3. 观察：
   - 侧边栏自动展开
   - 遮罩消失
   - ☰ 按钮隐藏

---

## Task 10: 手动测试 — 持久化验证

**验证点：**

- [ ] **Step 1：移动端状态保存**

1. 移动视图（≤720px）
2. 点击 ☰ 多次切换侧边栏状态（最终状态假设为收起）
3. 硬刷页面（Ctrl+Shift+R 或 Cmd+Shift+R）
4. 观察：侧边栏应保持收起状态（从 localStorage 恢复）

- [ ] **Step 2：桌面端忽略 localStorage**

1. 在移动视图中让侧边栏收起（localStorage = `true`）
2. 切换到桌面视图（>720px）
3. 观察：侧边栏立即展开（resize 事件强制展开，忽略 localStorage）
4. 硬刷页面
5. 观察：侧边栏保持展开状态（localStorage 现已更新为 `false`）

- [ ] **Step 3：跨设备持久化**

1. 在桌面视图中点击"新对话"和"历史对话"，确认侧边栏交互功能正常
2. 切换到移动视图，侧边栏应保持之前的展开/收起状态

---

## Task 11: 集成测试 — 与现有功能兼容性

**验证点：**

- [ ] **Step 1：对话列表功能完整**

1. 移动视图，侧边栏展开
2. 在对话列表中：
   - 点击一个旧对话，切换到该对话（观察消息区更新）
   - 搜索历史（输入搜索框），结果应该正常过滤
   - 点击"新对话"，应该创建新对话
   - 在对话项上 hover，删除按钮应显示
   - 点击删除，对话应被移除

- [ ] **Step 2：顶栏功能完整**

1. 移动视图，侧边栏展开
2. 点击"需求/故障"、"访问日志"、"设置"按钮，对话框应正常打开
3. 关闭对话框，侧边栏状态不变
4. 在设置中修改配置（如 token），点击保存，不应影响侧边栏

- [ ] **Step 3：消息区功能完整**

1. 移动视图，侧边栏收起
2. 在消息输入框输入消息，点击发送（或点击 Enter）
3. 消息应正常发送和显示
4. 收起侧边栏不应影响消息交互

- [ ] **Step 4：无遮罩层遮挡顶栏**

1. 移动视图，侧边栏展开（遮罩可见）
2. 观察：遮罩层在侧边栏后方（z-index 45 < 侧边栏 z-index 50）
3. ☰ 按钮仍可点击（不被遮罩遮挡）
4. 顶栏所有按钮仍可交互

---

## Task 12: 清理和最终验证

**验证点：**

- [ ] **Step 1：浏览器控制台无错误**

1. 打开 DevTools Console
2. 多次切换侧边栏、调整视口、切换对话
3. 应该没有 JavaScript 错误（warning 可接受）

- [ ] **Step 2：性能检查**

1. 打开 DevTools Performance 标签
2. 点击 ☰ 按钮触发切换
3. 录制并观察：
   - 动画应流畅（60 FPS）
   - 无明显帧率下降
   - 切换耗时 < 150ms（动画持续时间）

- [ ] **Step 3：跨浏览器快速检查**

如果可用，在以下环境中验证：
- Chrome / Chromium
- Firefox
- Safari（如有 macOS）

预期：行为一致，动画流畅

---

## Task 13: 提交最终版本

**文件：**
- Modified: `public/index.html`
- Modified: `public/app.css`
- Modified: `public/app.js`

- [ ] **Step 1：查看最终 diff**

```bash
git diff public/index.html public/app.css public/app.js
```

确保改动只包括：
- HTML：添加 ☰ 按钮和遮罩层
- CSS：transition、collapsed、overlay、toggle-btn、媒体查询
- JS：initSidebar、setSidebarCollapsed、toggleSidebar、bindSidebarEvents、事件绑定

无意外改动。

- [ ] **Step 2：提交综合功能**

```bash
git add public/index.html public/app.css public/app.js
git commit -m "feat: 侧边栏展开/收起功能实现

- 顶栏添加 ☰ 按钮（小屏幕时显示）
- 侧边栏收起时宽度收缩为 0，平滑过渡（150ms）
- 移动端展开时显示半透明遮罩层（z-index 45）
- localStorage 持久化用户偏好
- 大屏幕强制展开，小屏幕默认收起
- 响应式：resize 事件监听屏幕变化"
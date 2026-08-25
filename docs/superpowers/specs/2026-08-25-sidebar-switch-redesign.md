# 侧边栏对话/需求切换设计文档

**日期**: 2026-08-25  
**状态**: 已设计待批准  
**目标**: 将侧边栏左侧的「[＋新对话] [＋新需求]」按钮改为对话/需求切换 Switch，并将新建按钮移到底部固定栏。

---

## 概述

### 当前状态
- 侧边栏顶部显示「对话」标题
- 标题右侧有工具图标和两个按钮：「＋新对话」「＋新需求」
- 下方列表区显示对话列表（`.conv-list`）或需求列表（`.req-list`）
- 两个列表通过 `.hidden` 属性切换

### 目标状态
- 侧边栏顶部改为：「对话 | [对话 ≡ 需求] 工具图标」布局
- 新增 Switch 组件用于切换对话/需求列表
- 「＋新建对话/需求」按钮移到侧边栏底部，固定吸底
- 新建按钮文本根据 Switch 当前状态动态更新

### 核心收益
1. **操作流程更清晰**：对话和需求的切换入口一目了然
2. **空间利用更高效**：顶部空间从 3 个元素（标题+图标+2按钮）优化为 3 个元素（标题+Switch+图标），释放文字按钮的横向压力
3. **交互更一致**：与顶部其他切换入口（如设置/日志）的视觉模式保持一致

---

## 设计细节

### 1. HTML 结构调整

#### a. 顶部头部（`.sidebar-head`）

**当前**:
```html
<div class="sidebar-head">
  <span id="sidebarTitle">对话</span>
  <div class="sidebar-head-actions">
    <button class="icon-btn" id="toolsToggle" title="工具">...</button>
    <button class="btn" id="sidebarNew">＋ 新对话</button>
    <button class="btn" id="sidebarNewReq">＋ 新需求</button>
  </div>
</div>
```

**改为**:
```html
<div class="sidebar-head">
  <span id="sidebarTitle">对话</span>
  <div class="sidebar-switch" id="sidebarSwitch">
    <button class="switch-btn active" data-target="conv">对话</button>
    <button class="switch-btn" data-target="req">需求</button>
  </div>
  <div class="sidebar-head-actions">
    <button class="icon-btn" id="toolsToggle" title="工具">...</button>
  </div>
</div>
```

**变化**:
- 新增 `.sidebar-switch` 容器，包含两个 `.switch-btn` 按钮
- 删除 `id="sidebarNew"` 和 `id="sidebarNewReq"` 两个按钮
- 保留 `id="toolsToggle"` 工具图标

#### b. 侧边栏底部（新增）

在 `#sidebar` 最后添加固定底栏容器：

```html
<!-- 在 </aside> 前添加 -->
<div class="sidebar-footer" id="sidebarFooter">
  <button class="btn primary" id="sidebarCreateBtn">＋ 新建对话</button>
</div>
```

### 2. CSS 样式

#### a. Switch 组件样式

```css
.sidebar-switch {
  display: inline-flex;
  align-items: center;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px;
  gap: 2px;
  height: 28px;
}

.switch-btn {
  flex: 1;
  min-width: 50px;
  padding: 6px 12px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
  white-space: nowrap;
}

.switch-btn:hover {
  color: var(--text);
}

.switch-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid var(--accent);
  font-weight: 500;
}
```

#### b. 底部固定栏样式

```css
.sidebar-footer {
  flex-shrink: 0;
  padding: 8px 14px;
  border-top: 1px solid var(--border-soft);
  background: rgba(22, 23, 31, 1);
  /* 与 sidebar-head 的 padding 和 border 保持对称 */
}

.sidebar-footer .btn {
  width: 100%;
  padding: 8px 12px;
  font-size: 12px;
}
```

#### c. 侧边栏布局调整

修改 `.sidebar` 的 flex 结构，确保内容区自适应而底栏固定：

```css
.sidebar {
  /* 已有 */
  display: flex;
  flex-direction: column;
  
  /* 保留现有样式 */
}

.conv-list,
.req-list,
.tools-list {
  flex: 1;
  /* 现有样式保留 */
}
```

注：`.sidebar-footer` 作为 flex 容器的子元素，自动下沉到底部（`flex-shrink: 0` 防止被压缩）。

### 3. JavaScript 交互

#### a. Switch 按钮点击事件

在 `public/js/sidebar.js` 或 `public/app.js` 中添加：

```javascript
(function initSidebarSwitch() {
  const switchBtns = document.querySelectorAll('.switch-btn');
  const convList = document.getElementById('convList');
  const reqList = document.getElementById('reqList');
  const sidebarTitle = document.getElementById('sidebarTitle');
  const createBtn = document.getElementById('sidebarCreateBtn');
  
  let currentMode = 'conv'; // 'conv' | 'req'
  
  function setMode(mode) {
    if (currentMode === mode) return;
    currentMode = mode;
    
    // 更新 Switch 按钮状态
    switchBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.target === mode);
    });
    
    // 切换列表显隐
    if (convList) convList.hidden = mode !== 'conv';
    if (reqList) reqList.hidden = mode !== 'req';
    
    // 更新标题
    sidebarTitle.textContent = mode === 'conv' ? '对话' : '需求';
    
    // 更新新建按钮文本
    createBtn.textContent = mode === 'conv' ? '＋ 新建对话' : '＋ 新建需求';
    
    // 保存用户偏好到 localStorage
    localStorage.setItem('claude-sidebar-mode', mode);
  }
  
  // 按钮点击事件
  switchBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.target);
    });
  });
  
  // 新建按钮点击（委托给现有逻辑）
  createBtn?.addEventListener('click', () => {
    if (currentMode === 'conv') {
      document.getElementById('sidebarNew')?.click(); // 兼容旧逻辑
      // 或直接调用 newConversation() 如果已暴露
    } else {
      document.getElementById('sidebarNewReq')?.click(); // 兼容旧逻辑
      // 或直接调用 newRequirement() 如果已暴露
    }
  });
  
  // 页面加载时恢复用户偏好
  const savedMode = localStorage.getItem('claude-sidebar-mode') || 'conv';
  setMode(savedMode);
})();
```

#### b. 新建对话/需求的现有逻辑集成

确保现有的「新建对话」和「新建需求」处理函数在侧边栏切换时被正确调用。若现有代码中这两个按钮的点击回调已定义，新建按钮应委托给它们。

**如果现有代码结构**（待确认）:
- `sidebarNew` 按钮有 `addEventListener('click', ...)` 绑定
- `sidebarNewReq` 按钮有 `addEventListener('click', ...)` 绑定

则新建按钮可以复用这些事件（见上面的 `.click()` 委托），或直接提取回调函数名并调用。

#### c. 与现有工具切换逻辑的协作

现有的工具切换逻辑（`#toolsToggle` 点击）应保持不变，但需确保：
- 点击工具图标进入工具模式时，`currentMode` 不变（工具模式是独立的）
- 从工具模式返回时，应回到之前的 `currentMode`（对话或需求）

现有代码中 `window._setSidebarToolsMode` 已处理模式切换，无需改动。

### 4. 兼容性考虑

#### localStorage 键位
- 新增 `claude-sidebar-mode` 键，存储用户最后选择的模式（`conv` 或 `req`）
- 首次加载默认为 `conv`

#### 旧按钮的过渡期
- 若需兼容旧代码直接引用 `#sidebarNew` 或 `#sidebarNewReq`，可在 HTML 中保留隐藏元素，或在 JavaScript 中创建虚拟元素作为代理
- 建议在迁移完成后彻底删除这两个按钮，避免冗余

---

## 测试清单

### 功能测试
- [ ] Switch 按钮点击：切换对话/需求列表显隐
- [ ] 切换时，标题、新建按钮文本同步更新
- [ ] 新建按钮点击：成功创建对应类型的对话/需求
- [ ] localStorage 持久化：刷新页面后恢复上次选中的模式
- [ ] 工具图标点击：进入工具模式，列表隐藏；返回对话时恢复之前的对话/需求模式

### 样式测试
- [ ] Switch 组件在各屏幕宽度下的排版（特别是移动端 < 720px）
- [ ] 底部新建按钮：始终吸底，列表滚动不会被覆盖
- [ ] active/hover 状态的视觉反馈清晰
- [ ] 列表切换的过渡动画平滑（如有）

### 可访问性
- [ ] Switch 按钮有清晰的 `aria-label` 或 `title` 属性
- [ ] 键盘导航：Tab 能聚焦到 Switch 和新建按钮
- [ ] 新建按钮文本清晰反映当前模式

---

## 迁移计划

### 第一阶段：结构变更
1. 修改 HTML（`public/index.html`）：调整顶部头部，添加底部固定栏
2. 添加 CSS：`.sidebar-switch`、`.switch-btn`、`.sidebar-footer` 样式
3. 添加 JavaScript：`initSidebarSwitch()` 函数及事件绑定

### 第二阶段：集成测试
1. 验证新建按钮的点击回调能否正确触发现有的创建逻辑
2. 确保工具模式切换不受影响
3. 在移动端进行响应式测试

### 第三阶段：清理
1. 删除旧的 `#sidebarNew` 和 `#sidebarNewReq` 按钮
2. 更新任何硬编码引用这两个 ID 的代码
3. 更新注释和文档

---

## 后续扩展

### 可选增强
1. **动画效果**：列表切换时添加淡入淡出或滑动动画
2. **工具列表整合**：将工具项列表也集成到底部栏，提供快速访问
3. **Keyboard Shortcut**：为 Switch 添加快捷键（如 `Ctrl+Shift+T` 切换）

---

## 相关文件

- `public/index.html` — HTML 结构
- `public/app.css` — 样式（1675~1750 行附近有相关 CSS，需在此扩展）
- `public/app.js` — 初始化入口
- `public/js/sidebar.js` — 侧边栏逻辑（可在此或独立文件添加 Switch 逻辑）

---

## 审批清单

- [ ] 设计方案确认
- [ ] HTML 结构调整确认
- [ ] CSS 样式规范确认
- [ ] JavaScript 交互流程确认
- [ ] 兼容性方案确认
- [ ] 准备进入实现阶段

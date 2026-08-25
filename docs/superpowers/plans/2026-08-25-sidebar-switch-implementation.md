# 侧边栏对话/需求切换改版 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将侧边栏左侧的「[＋新对话][＋新需求]」改为对话/需求切换 Switch 组件，并将新建按钮移到底部固定栏，实现自动响应 Switch 状态。

**Architecture:** 
- 顶部：标题 + Switch 双按钮组 + 工具图标，三元素并行
- 中间：列表区 flex:1 自适应占满
- 底部：新建按钮固定吸底，文本动态绑定 Switch 状态
- 状态管理：localStorage 持久化用户选择的模式（对话/需求）

**Tech Stack:** 原生 HTML/CSS/JavaScript（无框架依赖）

---

## Task 1: 修改 HTML 结构 - 顶部 sidebar-head

**Files:**
- Modify: `public/index.html:29-40`

**变更内容：** 将 sidebar-head 中的两个新建按钮替换为 Switch 组件

- [ ] **Step 1: 打开文件并定位目标位置**

打开 `public/index.html`，找到第 29 行 `<aside class="sidebar">` 下的 `<div class="sidebar-head">`，当前内容为：

```html
<div class="sidebar-head">
  <span id="sidebarTitle">对话</span>
  <div class="sidebar-head-actions">
    <button class="icon-btn" id="toolsToggle" title="工具">
      <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M544 552.32v247.68a32 32 0 0 1-32 32 31.36 31.36 0 0 1-32-32V552.32L256 423.04a32 32 0 0 1-11.52-43.52 31.36 31.36 0 0 1 43.52-11.52l224 128 222.08-128a31.36 31.36 0 0 1 43.52 11.52 32 32 0 0 1-11.52 43.52l-222.08 128z"/>
        <path d="M64 256v512l448 256 448-256V256L512 0z m832 480L512 960l-384-224v-448L512 64l384 224z"/>
      </svg>
    </button>
    <button class="btn" id="sidebarNew">＋ 新对话</button>
    <button class="btn" id="sidebarNewReq">＋ 新需求</button>
  </div>
</div>
```

- [ ] **Step 2: 替换 sidebar-head 的完整内容**

将上述 HTML 替换为：

```html
<div class="sidebar-head">
  <span id="sidebarTitle">对话</span>
  <div class="sidebar-switch" id="sidebarSwitch">
    <button class="switch-btn active" data-target="conv">对话</button>
    <button class="switch-btn" data-target="req">需求</button>
  </div>
  <div class="sidebar-head-actions">
    <button class="icon-btn" id="toolsToggle" title="工具">
      <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M544 552.32v247.68a32 32 0 0 1-32 32 31.36 31.36 0 0 1-32-32V552.32L256 423.04a32 32 0 0 1-11.52-43.52 31.36 31.36 0 0 1 43.52-11.52l224 128 222.08-128a31.36 31.36 0 0 1 43.52 11.52 32 32 0 0 1-11.52 43.52l-222.08 128z"/>
        <path d="M64 256v512l448 256 448-256V256L512 0z m832 480L512 960l-384-224v-448L512 64l384 224z"/>
      </svg>
    </button>
  </div>
</div>
```

关键变化：
- 新增 `<div class="sidebar-switch">` 容器，包含 `data-target="conv"` 和 `data-target="req"` 两个按钮
- 删除 `<button id="sidebarNew">` 和 `<button id="sidebarNewReq">`
- 保留工具图标按钮 `#toolsToggle`

- [ ] **Step 3: 验证 HTML 语法**

在浏览器开发者工具中检查 HTML 结构，确保没有标签未闭合。或运行：

```bash
cd public && tidy -q index.html 2>&1 | head -20
```

预期：无错误（或只有 info 级别的警告）

- [ ] **Step 4: 提交改动**

```bash
git add public/index.html
git commit -m "refactor: replace new-button row with sidebar-switch in header"
```

---

## Task 2: 修改 HTML 结构 - 底部 sidebar-footer

**Files:**
- Modify: `public/index.html`，在 `</aside>` 前添加新的底部栏

**变更内容：** 在左侧栏底部添加固定新建按钮容器

- [ ] **Step 1: 找到 </aside> 结束标签位置**

在 `public/index.html` 中找到侧边栏的结束标签。当前文件结构中，`</aside>` 应在约 81 行（需要确认，因为会有其他内容）。

定位到最后一个 `</aside>` 标签（对应 `<aside class="sidebar">`）。

- [ ] **Step 2: 在 </aside> 前插入底部栏 HTML**

在 `</aside>` 前添加以下 HTML：

```html
    <!-- 侧边栏底部固定栏：新建对话/需求按钮 -->
    <div class="sidebar-footer" id="sidebarFooter">
      <button class="btn primary" id="sidebarCreateBtn">＋ 新建对话</button>
    </div>
```

位置应该在：

```html
        </div>
        <!-- 工具态底栏：仅「打开…」快捷入口（原 Markdown 打开历史区已移除） -->
        <div class="tools-footer" id="toolsFooter" hidden>
          <button class="btn" id="mdOpenFileBtn2">📄 打开…</button>
        </div>
      </aside>  <!-- ← 添加新 HTML 应在这行前面
```

改后应为：

```html
        </div>
        <!-- 工具态底栏：仅「打开…」快捷入口（原 Markdown 打开历史区已移除） -->
        <div class="tools-footer" id="toolsFooter" hidden>
          <button class="btn" id="mdOpenFileBtn2">📄 打开…</button>
        </div>
        <!-- 侧边栏底部固定栏：新建对话/需求按钮 -->
        <div class="sidebar-footer" id="sidebarFooter">
          <button class="btn primary" id="sidebarCreateBtn">＋ 新建对话</button>
        </div>
      </aside>
```

- [ ] **Step 3: 验证 HTML 完整性**

打开浏览器，检查侧边栏底部是否显示新建按钮（即使样式未应用）。按 F12 打开开发者工具，验证 DOM 树中有 `#sidebarFooter` 和 `#sidebarCreateBtn`。

- [ ] **Step 4: 提交改动**

```bash
git add public/index.html
git commit -m "feat: add sidebar-footer with create button placeholder"
```

---

## Task 3: 添加 CSS - Switch 组件样式

**Files:**
- Modify: `public/app.css`，在现有 `.sidebar-head-actions` 样式之后（约 1675 行）

**变更内容：** 添加 Switch 按钮组的样式定义

- [ ] **Step 1: 定位 CSS 插入位置**

打开 `public/app.css`，找到约 1675 行处的 `.sidebar-head-actions` 样式块：

```css
.sidebar-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
```

在这个块之后添加新样式。

- [ ] **Step 2: 插入 Switch 容器和按钮样式**

在 `.sidebar-head-actions` 块之后添加：

```css
/* ---- 侧栏头部：对话/需求切换 Switch ---- */
.sidebar-switch {
  display: inline-flex;
  align-items: center;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px;
  gap: 2px;
  height: 28px;
  flex-shrink: 0;
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

注意：`flex: 1` 使两个按钮等宽；`flex-shrink: 0` 防止 Switch 被挤压。

- [ ] **Step 3: 验证样式渲染**

打开浏览器刷新页面（或按 Ctrl+Shift+R 清缓存），检查侧边栏顶部：
- 应该看到一个紧凑的双按钮组「对话 需求」
- 「对话」按钮应该有橙色背景（active 态）
- 鼠标悬停「需求」应该变亮

如果样式未显示，检查浏览器 DevTools 中的 Computed Styles，确保 CSS 选择器正确。

- [ ] **Step 4: 提交改动**

```bash
git add public/app.css
git commit -m "style: add sidebar-switch component styling"
```

---

## Task 4: 添加 CSS - 底部固定栏样式与布局

**Files:**
- Modify: `public/app.css`，在 Switch 样式之后添加底部栏样式，并调整 `.sidebar` flex 布局

**变更内容：** 
1. 添加 `.sidebar-footer` 样式
2. 确保侧边栏是 flex 列布局，列表自适应

- [ ] **Step 1: 添加 sidebar-footer 样式**

在前一个任务的 Switch 样式块之后，添加：

```css
/* ---- 侧栏底部固定栏 ---- */
.sidebar-footer {
  flex-shrink: 0;
  padding: 8px 14px;
  border-top: 1px solid var(--border-soft);
  background: rgba(22, 23, 31, 1);
}

.sidebar-footer .btn {
  width: 100%;
  padding: 8px 12px;
  font-size: 12px;
}
```

关键点：
- `flex-shrink: 0` — 防止按钮栏被列表挤压
- `padding` 与 `.sidebar-head` 对称（都是 `14px` 左右）
- `border-top` 与 `.sidebar-head` 的 `border-bottom` 对称
- `.btn` 宽 100% 占满容器

- [ ] **Step 2: 检查 .sidebar 本身的 flex 布局**

找到 `public/app.css` 中的 `.sidebar` 规则（约 48 行），确保已有：

```css
.sidebar {
  width: 310px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-soft);
  background: rgba(22, 23, 31, 1);
  transition: width 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

如果没有 `display: flex; flex-direction: column;`，添加。这样才能让 footer 自动下沉。

- [ ] **Step 3: 检查列表的 flex 属性**

找到 `.conv-list` 和 `.req-list` 的 CSS（约 67 行），确保有 `flex: 1;`：

```css
.conv-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
```

`.req-list` 应该也有相同的 `flex: 1;`（若还没有，添加）。

- [ ] **Step 4: 在浏览器中验证布局**

打开浏览器，检查：
1. 列表区应该占满侧边栏大部分高度（flex: 1）
2. 底部新建按钮应该始终吸底，不被列表覆盖
3. 列表滚动时，按钮保持固定在底部
4. 按钮的 padding 和边框与顶部头部对称

如果按钮被覆盖，检查是否有 `overflow` 设置导致问题。

- [ ] **Step 5: 提交改动**

```bash
git add public/app.css
git commit -m "style: add sidebar-footer fixed layout and ensure flex structure"
```

---

## Task 5: 添加 JavaScript - Switch 交互初始化函数

**Files:**
- Modify: `public/app.js`（或 `public/js/sidebar.js`，推荐用 `app.js` 保持集中）

**变更内容：** 在现有的 `initToolsToggle()` 函数旁添加 `initSidebarSwitch()` 函数

- [ ] **Step 1: 定位插入位置**

打开 `public/app.js`，找到约 83 行的 `initToolsToggle()` 函数：

```javascript
(function initToolsToggle() {
  const toggle = $('#toolsToggle');
  const convList = $('#convList');
  const toolsList = $('#toolsList');
  const title = $('#sidebarTitle');
  // ... 函数体
})();
```

在这个函数之后添加新函数（约 112 行之后）。

- [ ] **Step 2: 插入 initSidebarSwitch 函数**

在 `initToolsToggle()` 的闭合 `})();` 后添加：

```javascript
      // ---- 侧栏「对话 / 需求」切换 ----
      (function initSidebarSwitch() {
        const switchBtns = document.querySelectorAll('.switch-btn');
        const convList = document.getElementById('convList');
        const reqList = document.getElementById('reqList');
        const sidebarTitle = document.getElementById('sidebarTitle');
        const createBtn = document.getElementById('sidebarCreateBtn');
        
        let currentMode = localStorage.getItem('claude-sidebar-mode') || 'conv';
        
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
          if (sidebarTitle) sidebarTitle.textContent = mode === 'conv' ? '对话' : '需求';
          
          // 更新新建按钮文本
          if (createBtn) {
            createBtn.textContent = mode === 'conv' ? '＋ 新建对话' : '＋ 新建需求';
          }
          
          // 保存用户偏好
          localStorage.setItem('claude-sidebar-mode', mode);
        }
        
        // 按钮点击事件
        switchBtns.forEach(btn => {
          btn.addEventListener('click', () => {
            setMode(btn.dataset.target);
          });
        });
        
        // 新建按钮：委托给现有逻辑
        createBtn?.addEventListener('click', () => {
          if (currentMode === 'conv') {
            // 触发现有的「新建对话」逻辑
            // 方式 1: 寻找并点击旧按钮（如果还存在）
            const oldNewBtn = document.getElementById('sidebarNew');
            if (oldNewBtn) {
              oldNewBtn.click();
            } else {
              // 方式 2: 直接调用回调函数（若已暴露）
              // newConversation?.();
              console.warn('sidebarNew button not found, please implement direct call');
            }
          } else {
            const oldNewReqBtn = document.getElementById('sidebarNewReq');
            if (oldNewReqBtn) {
              oldNewReqBtn.click();
            } else {
              // newRequirement?.();
              console.warn('sidebarNewReq button not found, please implement direct call');
            }
          }
        });
        
        // 页面加载时初始化
        setMode(currentMode);
      })();
```

关键点：
- 使用 IIFE (立即执行函数) 避免全局污染
- `currentMode` 初始从 localStorage 读取，默认 `'conv'`
- `setMode()` 是核心函数，统一管理状态切换
- 新建按钮委托给现有逻辑（先尝试点击旧按钮）
- 每次模式切换都保存到 localStorage

- [ ] **Step 3: 在浏览器中验证交互**

打开浏览器，检查：
1. 点击「对话」按钮 — 应该激活（橙色背景），列表切换到对话列表
2. 点击「需求」按钮 — 应该激活，列表切换到需求列表
3. 标题应该同时更新（「对话」↔「需求」）
4. 新建按钮文本应该同时更新
5. 刷新页面 — 应该恢复到上一次选择的模式

如果新建按钮点击无反应，检查浏览器 Console，看是否有 "sidebarNew button not found" 的警告。若有，需要进行下一个集成任务。

- [ ] **Step 4: 提交改动**

```bash
git add public/app.js
git commit -m "feat: add sidebar switch initialization and mode toggle logic"
```

---

## Task 6: 集成测试 - 验证新建按钮与现有逻辑的衔接

**Files:**
- Modify: `public/app.js` 或 `public/js/chat.js`（根据现有「新建对话」逻辑所在位置）

**变更内容：** 验证并修复新建按钮的委托逻辑

- [ ] **Step 1: 找到现有「新建对话」的实现**

在 `public/app.js` 中搜索 `sidebarNew` 的事件绑定：

```bash
grep -n "sidebarNew" public/app.js public/js/chat.js
```

预期输出类似：
```
public/js/chat.js:150:document.getElementById('sidebarNew').addEventListener('click', newConversation);
```

如果找不到，检查 `public/js/chat.js`、`public/js/req-view.js` 等文件。

- [ ] **Step 2: 记录现有回调函数名**

假设找到：
```javascript
// public/js/chat.js:150
document.getElementById('sidebarNew').addEventListener('click', newConversation);
document.getElementById('sidebarNewReq').addEventListener('click', openNewReq);
```

那么回调函数分别是 `newConversation` 和 `openNewReq`。

- [ ] **Step 3: 更新 Task 5 中的委托逻辑**

如果回调函数已暴露在全局作用域或导出，修改 Task 5 中的新建按钮处理：

```javascript
        createBtn?.addEventListener('click', () => {
          if (currentMode === 'conv') {
            // 直接调用函数（若导出）或触发旧按钮
            newConversation?.() || document.getElementById('sidebarNew')?.click();
          } else {
            openNewReq?.() || document.getElementById('sidebarNewReq')?.click();
          }
        });
```

或者，如果旧按钮已删除，需要找到导出的函数并直接调用。

**若回调函数未暴露**，有两个方案：
- **方案 A**（保守）：保留旧按钮但隐藏，新建按钮点击时触发旧按钮的 click 事件
- **方案 B**（推荐）：直接导出回调函数，然后在新建按钮中调用

- [ ] **Step 4: 在浏览器中测试「新建对话」流程**

打开浏览器：
1. 确保 Switch 在「对话」模式
2. 点击底部「＋ 新建对话」按钮
3. 验证是否弹出新建对话的 UI（或创建了新对话项）

如果没有反应，打开 DevTools Console 检查错误。

- [ ] **Step 5: 在浏览器中测试「新建需求」流程**

1. 切换 Switch 到「需求」模式
2. 按钮文本应变为「＋ 新建需求」
3. 点击按钮，验证是否弹出新建需求的 UI

- [ ] **Step 6: 提交改动**

```bash
git add public/app.js
git commit -m "integration: delegate sidebar create button to existing new-conversation/requirement logic"
```

---

## Task 7: 清理 - 移除或隐藏旧按钮

**Files:**
- Modify: `public/index.html` — 确认旧按钮已删除（应已在 Task 1 中删除）
- Search: `grep -r "sidebarNew\|sidebarNewReq" public/ src/` 检查其他引用

**变更内容：** 验证所有旧按钮引用已清理

- [ ] **Step 1: 确认 HTML 中的旧按钮已删除**

在 `public/index.html` 中搜索：
```bash
grep "sidebarNew\|sidebarNewReq" public/index.html
```

预期：无输出（已删除）

如果还有，删除这两行。

- [ ] **Step 2: 检查 JavaScript 中的其他引用**

```bash
grep -rn "sidebarNew\|sidebarNewReq" public/js/ src/
```

预期：可能有以下几种结果：
- 在 `public/js/chat.js` 或类似文件中的 `addEventListener` 绑定（可以保留，因为委托逻辑会查找并点击）
- 在 Task 5 的新 `initSidebarSwitch()` 中的 `getElementById('sidebarNew')` 查询（保留，用于兼容）

如果有其他地方硬编码这两个 ID，需要更新。

- [ ] **Step 3: 检查注释中的过时说明**

```bash
grep -n "新对话\|新需求" public/index.html | head -10
```

如果注释提到「两个按钮」或「顶部新建」，更新为「底部新建」或删除。

- [ ] **Step 4: 提交清理改动**

```bash
git add public/index.html public/js/chat.js  # 若有修改
git commit -m "cleanup: remove old button references and update comments"
```

---

## Task 8: 手动验证 - 完整功能测试

**Files:**
- Test: 浏览器手动测试，无代码改动

**变更内容：** 验证端到端的完整流程

- [ ] **Step 1: 清缓存并打开应用**

```bash
# 终端中启动应用（若有启动脚本）
npm start  # 或 yarn start，或自定义启动命令

# 浏览器中打开
open http://localhost:3000  # 或应用实际 URL
```

按 Ctrl+Shift+R（强制刷新）清浏览器缓存，确保加载最新代码。

- [ ] **Step 2: 验证初始状态**

检查：
- [ ] 侧边栏顶部显示：「对话 | [对话 ≡ 需求] 🔧」
- [ ] 「对话」按钮有橙色背景（active 态）
- [ ] 「需求」按钮无背景（inactive 态）
- [ ] 侧边栏中间显示对话列表
- [ ] 侧边栏底部有「＋ 新建对话」按钮

- [ ] **Step 3: 验证 Switch 切换**

1. 点击「需求」按钮
   - [ ] 按钮变成橙色背景
   - [ ] 「对话」按钮恢复无背景
   - [ ] 标题改为「需求」
   - [ ] 侧边栏列表切换为需求列表
   - [ ] 底部按钮文本改为「＋ 新建需求」

2. 点击「对话」按钮
   - [ ] 恢复到初始状态（同上）

3. 重复 2-3 次切换，确保稳定

- [ ] **Step 4: 验证 localStorage 持久化**

1. 切换到「需求」模式
2. 关闭标签页或刷新页面（F5）
3. 验证页面加载后仍在「需求」模式（列表、标题、按钮文本都应对应）

重复：先切回「对话」，再刷新，确认回到「对话」模式

- [ ] **Step 5: 验证新建按钮功能**

1. 在「对话」模式下点击「＋ 新建对话」按钮
   - [ ] 应该弹出新建对话的 UI（如输入框或模态窗）
   - [ ] 或创建了一条新对话项

2. 切换到「需求」模式，点击「＋ 新建需求」按钮
   - [ ] 应该弹出新建需求的 UI
   - [ ] 或创建了一条新需求项

若无反应，打开 DevTools Console 检查错误。

- [ ] **Step 6: 验证工具模式不受影响**

1. 点击顶部工具图标（🔧）
2. 侧边栏应该切换到工具列表（JSON、记忆库、优化等）
3. 列表消失，工具项显示
4. 底部新建按钮应该隐藏或变灰

5. 再点击工具图标回到「对话」/「需求」模式
   - [ ] 应该恢复到之前的模式（对话或需求，而不是强制回到对话）
   - [ ] 新建按钮重新显示

- [ ] **Step 7: 验证响应式布局（移动端）**

在浏览器开发者工具中模拟移动端（如 iPhone 12，375px 宽度）：
- [ ] Switch 组件应该仍然显示，不被压缩（若出现换行，则需要调整样式）
- [ ] 新建按钮应该全宽，易于触摸
- [ ] 侧边栏可以展开/收起（现有逻辑不变）

- [ ] **Step 8: 文档记录（如无 bug）**

如果所有验证都通过，在 commit message 中标记：

```bash
git log --oneline | head -10  # 查看最近提交
# 或在 IMPLEMENTATION_COMPLETE.md 中记录完成时间
```

- [ ] **Step 9: 若发现 bug，回到对应 Task 修复**

常见 bug：
- 新建按钮点击无反应 → Task 6（集成）
- Switch 样式错乱 → Task 3/4（CSS）
- 列表不切换 → Task 5（JavaScript）
- localStorage 不工作 → Task 5（JavaScript，检查 browser 是否支持）

---

## Task 9: 可选增强 - 动画过渡

**Files:**
- Modify: `public/app.css`

**变更内容：** 给列表切换添加淡入淡出动画

- [ ] **Step 1: 为 .conv-list 和 .req-list 添加动画属性**

在 CSS 中找到 `.conv-list` 和 `.req-list` 规则，添加：

```css
.conv-list,
.req-list {
  transition: opacity 0.3s ease;
}

.conv-list[hidden],
.req-list[hidden] {
  opacity: 0;
  pointer-events: none;
}
```

注意：`pointer-events: none` 防止隐藏列表被误触。

- [ ] **Step 2: 在浏览器中验证动画**

切换 Switch 时，列表应该有 0.3s 的淡入淡出效果（而不是生硬地消失）。

- [ ] **Step 3: 提交（可选）**

```bash
git add public/app.css
git commit -m "enhancement: add fade transition for list switching"
```

---

## Summary

| Task | 文件 | 改动类型 | 预计时间 |
|------|------|--------|--------|
| 1 | `public/index.html` | 替换 sidebar-head | 3 min |
| 2 | `public/index.html` | 添加 sidebar-footer | 2 min |
| 3 | `public/app.css` | 添加 Switch 样式 | 5 min |
| 4 | `public/app.css` | 添加 Footer 样式 + 调整 flex | 5 min |
| 5 | `public/app.js` | 添加 initSidebarSwitch | 10 min |
| 6 | `public/app.js` | 集成委托逻辑 | 5 min |
| 7 | `public/index.html` | 清理旧引用 | 3 min |
| 8 | 手动测试 | 端到端验证 | 10 min |
| 9 | `public/app.css` | 可选动画 | 3 min |

**总耗时**：约 45 分钟（含测试）

---

## 关键约束与注意事项

1. **localStorage 兼容性**：确保目标浏览器版本支持 localStorage（现代浏览器均支持）
2. **旧按钮生命周期**：Task 1 删除后，Task 5/6 中的 `getElementById('sidebarNew')` 会返回 null，需妥善处理（用 `?.click()` 可选链）
3. **工具模式隔离**：现有工具切换逻辑 `initToolsToggle()` 与新 `initSidebarSwitch()` 应独立运行，不互相干扰
4. **列表初始态**：确保 Task 5 中的 `setMode(currentMode)` 在页面加载时被调用，否则用户第一次看到的列表可能不对
5. **响应式考虑**：移动端（< 720px）时，Switch 容器不应被压缩；如有问题，可设置 `flex-shrink: 0` 或减少 padding


# 会话标题 Cursor 动画设计文档

**日期**：2026-07-21  
**功能**：为会话历史列表中正在运行的会话标题添加 `░▒▓█` cursor 循环动画  
**状态**：已批准实现

---

## 功能概述

在 web 执行台左侧会话列表中，当某个会话处于 `running` 状态（正在执行任务）时，其标题末尾显示动态 cursor 效果（`░▒▓█` 四个字符循环），直到运行结束后消失。

### 用户感知

```
[📄 对话标题         ]  → 静态（不运行）
[⏳ 正在执行的任务 ░ ]  → cursor 循环
[⏳ 正在执行的任务 ▒ ]  
[⏳ 正在执行的任务 ▓ ]  
[⏳ 正在执行的任务 █ ]  → 800ms 循环周期（200ms/字符）
[📄 已完成的对话     ]  → 运行结束，cursor 消失恢复静态
```

---

## 设计方案

### 方案选择：A - Cursor 尾缀 + requestAnimationFrame

**理由**：
- ✅ 与现有 `AnimeAnimations` 框架集成度最高
- ✅ rAF 同步浏览器刷新，60fps 帧同步，不掉帧
- ✅ 文字与 cursor 分离，逻辑清晰且性能优良
- ✅ 单个全局 ticker，多个 running 标题共用一个动画循环

---

## 技术实现

### 1. DOM 结构

在 `public/app.js` 的 `renderConvList` 函数中，创建标题时：

```javascript
const title = document.createElement('span');
title.className = 'conv-title';

// 标题文字容器
const titleText = document.createElement('span');
titleText.className = 'title-text';
titleText.textContent = e.title;
title.appendChild(titleText);

// cursor 容器（初始隐藏）
const cursorSpan = document.createElement('span');
cursorSpan.className = 'title-cursor';
cursorSpan.style.display = 'none';
title.appendChild(cursorSpan);

row.appendChild(title);
```

**最终 HTML**：
```html
<span class="conv-title">
  <span class="title-text">对话标题或任务</span>
  <span class="title-cursor" style="display: none">░</span>
</span>
```

### 2. CSS 样式

在 `public/app.css` 中新增：

```css
.title-text {
  /* 标题文字本身，保持原有样式 */
  word-break: break-word;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

.title-cursor {
  /* cursor 尾缀，由 JS 驱动 */
  display: none; /* 运行时由 JS 切换为 'inline' */
  color: currentColor; /* 继承列表项的文字颜色 */
  font-weight: bold;
  margin-left: 2px;
  user-select: none; /* 防止复制时带上 cursor */
  animation: none; /* 由 JS rAF 驱动，不用 CSS @keyframes */
}

/* 可选：hover 时加粗突显 */
.conv-item.running:hover .title-cursor {
  text-shadow: 0 0 4px currentColor;
}
```

### 3. 动画引擎

在 `AnimeAnimations` 模块（第 3181 行附近）中新增方法：

```javascript
// ---------- Cursor 循环动画 ----------
// cursor 字符集与循环参数
const _CURSOR_CHARS = ['░', '▒', '▓', '█'];
const _CURSOR_FRAME_MS = 200; // 每个字符停留 200ms，总周期 800ms
let _cursorRafId = null;
let _cursorTargets = new Set(); // 正在循环的 cursor 元素集合
let _cursorIdx = 0;
let _cursorLastTime = 0;

/**
 * 启动 cursor 循环：添加目标元素到全局循环集合
 * @param {HTMLElement} cursorEl - .title-cursor 元素
 */
function startCursorLoop(cursorEl) {
  if (!cursorEl || _cursorTargets.has(cursorEl)) return;
  _cursorTargets.add(cursorEl);
  cursorEl.style.display = 'inline';
  
  // 若尚未启动全局 ticker，则启动
  if (!_cursorRafId && _cursorTargets.size > 0) {
    _tickCursor();
  }
}

/**
 * 停止 cursor 循环：从集合中移除目标元素
 * @param {HTMLElement} cursorEl - .title-cursor 元素
 */
function stopCursorLoop(cursorEl) {
  if (!cursorEl) return;
  _cursorTargets.delete(cursorEl);
  cursorEl.style.display = 'none';
  
  // 若没有更多目标，停止全局 ticker
  if (_cursorTargets.size === 0 && _cursorRafId) {
    cancelAnimationFrame(_cursorRafId);
    _cursorRafId = null;
    _cursorIdx = 0;
  }
}

/**
 * 全局 cursor ticker：驱动所有活跃的 cursor 元素
 */
function _tickCursor() {
  const now = performance.now();
  
  // 第一帧初始化时间戳
  if (_cursorLastTime === 0) _cursorLastTime = now;
  
  const elapsed = now - _cursorLastTime;
  
  // 判断是否需要切换到下一个字符
  if (elapsed >= _CURSOR_FRAME_MS) {
    _cursorIdx = (_cursorIdx + 1) % _CURSOR_CHARS.length;
    const cursorChar = _CURSOR_CHARS[_cursorIdx];
    
    // 更新所有活跃目标
    for (const el of _cursorTargets) {
      if (el && el.parentElement) { // 元素仍在 DOM 中
        el.textContent = cursorChar;
      } else {
        // 元素已被移除，清理引用
        _cursorTargets.delete(el);
      }
    }
    
    // 重置计时器
    _cursorLastTime = now;
  }
  
  // 继续循环
  _cursorRafId = requestAnimationFrame(_tickCursor);
}

/**
 * 清理所有 cursor 循环（页面卸载或重置时）
 */
function stopAllCursorLoops() {
  if (_cursorRafId) {
    cancelAnimationFrame(_cursorRafId);
    _cursorRafId = null;
  }
  _cursorTargets.clear();
  _cursorIdx = 0;
  _cursorLastTime = 0;
}

// 暴露公共接口
return {
  // ... 现有接口
  startCursorLoop,
  stopCursorLoop,
  stopAllCursorLoops,
};
```

### 4. 集成点

#### 4a. 列表渲染时（`renderConvList` 函数，第 570-599 行）

```javascript
for (const e of entries) {
  const row = document.createElement('div');
  row.className =
    'conv-item' + (e.active ? ' active' : '') + (e.running ? ' running' : '');
  
  const title = document.createElement('span');
  title.className = 'conv-title';
  
  // 标题文字
  const titleText = document.createElement('span');
  titleText.className = 'title-text';
  titleText.textContent = e.title;
  title.appendChild(titleText);
  
  // cursor 容器（若 running 则启动）
  const cursorSpan = document.createElement('span');
  cursorSpan.className = 'title-cursor';
  cursorSpan.style.display = 'none';
  title.appendChild(cursorSpan);
  
  if (e.running) {
    AnimeAnimations.startCursorLoop(cursorSpan);
  }
  
  title.onclick = () =>
    e.source === 'local' ? openConv(e.convId) : resumeHistorySession(e.sessionId);
  row.appendChild(title);
  
  // ... 其他 info 图标逻辑
  
  frag.appendChild(row);
}
```

#### 4b. 运行状态变化时

在 `handleRunAttach` 或相关事件处理中，监听 `replay` 事件（获取初始 `running` 状态）：

```javascript
// 当重新连接时，根据 run.status 更新列表项 cursor
es.addEventListener('replay', (e) => {
  const data = JSON.parse(e.data);
  if (data.status === 'running') {
    const convItem = document.querySelector(`[data-conv-id="${currentConvId}"]`);
    const cursor = convItem?.querySelector('.title-cursor');
    if (cursor) AnimeAnimations.startCursorLoop(cursor);
  }
});

// 当任务完成或停止时，停止 cursor
es.addEventListener('done', (e) => {
  const convItem = document.querySelector(`[data-conv-id="${currentConvId}"]`);
  const cursor = convItem?.querySelector('.title-cursor');
  if (cursor) AnimeAnimations.stopCursorLoop(cursor);
});
```

#### 4c. 列表重新渲染时

由于 `renderConvList` 会全量重绘列表（销毁旧 DOM 创建新 DOM），旧的 cursor 元素会自动从 `_cursorTargets` 集合中失效（通过 DOM 检查）。新列表项若 `running` 则重新启动。

**无需额外清理代码**，全局 ticker 的 `_tickCursor` 会自动跳过已离 DOM 的元素。

---

## 性能考量

### 内存
- 每个 running 会话增加 2 个 DOM 元素（`title-text` + `title-cursor`）
- 全局 `_cursorTargets` Set 大小 ≤ 同时运行的会话数（通常 ≤ 10）

### CPU
- 单个全局 rAF ticker，无论多少个 cursor 都是 60fps 驱动
- 每帧仅更新活跃的 cursor 元素（O(n) where n = running count）
- 相比 N 个 setInterval，开销减少 95%+

### 网络
- 无额外网络请求

---

## 测试清单

- [ ] 静态列表项无 cursor 显示
- [ ] running 列表项首次渲染时 cursor 正常启动
- [ ] cursor 循环频率 200ms/字符（4字符 = 800ms）
- [ ] 运行完成后 cursor 消失，列表项恢复静态
- [ ] 列表重新渲染（搜索、加载更多）时，running 项 cursor 继续循环
- [ ] 列表滚动、窗口最小化时，cursor 不卡顿
- [ ] 多个 running 项同时存在，cursor 同步循环（所有项显示相同字符）
- [ ] 页面卸载时，cursor ticker 正常清理，无内存泄漏

---

## 回滚计划

若需要禁用该功能：
1. 在 CSS 中添加 `display: none !important` 到 `.title-cursor`
2. 或在列表渲染时注释掉 `AnimeAnimations.startCursorLoop` 调用
3. 不涉及后端改动，纯前端切换

---

## 后续扩展

- 可配置 cursor 字符集、频率（目前硬编码）
- 可添加"点击 running 项快速查看日志"交互
- 可在 cursor 处显示任务进度百分比（如 `░ 45%`）

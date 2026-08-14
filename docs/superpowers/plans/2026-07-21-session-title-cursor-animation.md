# 会话标题 Cursor 动画 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为会话历史列表中正在运行（`running`）的会话标题末尾，添加 `░▒▓█` cursor 循环动画，运行结束后消失。

**Architecture:** 纯前端修改，两个文件。`AnimeAnimations` 模块增加全局 rAF ticker，通过 `Set` 管理所有活跃 cursor 元素；`renderConvList` 拆分标题为 `title-text` + `title-cursor` 两个子 span，running 时挂载 cursor。

**Tech Stack:** 原生 JS（rAF）、CSS Flexbox，无外部依赖。

---

## 文件地图

| 文件 | 改动性质 | 说明 |
|------|----------|------|
| `public/app.css` | 修改 line 93-98，新增 `.title-text` `.title-cursor` | `.conv-title` 改为 flex 容器，cursor 独立子元素 |
| `public/app.js` line 3437-3454 | 新增 cursor 动画方法 | 在 `resetToolState()` 后、`return {}` 前插入 |
| `public/app.js` line 574-578 | 修改 title DOM 创建 | 拆分为 `title-text` + `title-cursor`，running 时启动 |

---

## Task 1：CSS — 拆分 `.conv-title` 为 flex 容器

**Files:**
- Modify: `public/app.css:93-98`（`.conv-title` 块）

- [ ] **Step 1：替换 `.conv-title` 样式，新增 `.title-text` 和 `.title-cursor`**

找到 `app.css` 第 93-98 行的 `.conv-title` 块：

```css
      .conv-title {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
```

替换为：

```css
      .conv-title {
        flex: 1;
        overflow: hidden;
        display: flex;
        align-items: center;
        min-width: 0;
      }
      .title-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        min-width: 0;
      }
      .title-cursor {
        flex-shrink: 0;
        margin-left: 3px;
        user-select: none;
        font-size: 10px;
        opacity: 0.85;
      }
```

- [ ] **Step 2：验证样式**

打开浏览器访问 `http://127.0.0.1:3456`（或项目实际端口），确认：
- 会话列表标题仍正常显示、超长标题仍截断显示 `…`
- 无明显布局错位

---

## Task 2：JS — AnimeAnimations 增加 cursor 动画方法

**Files:**
- Modify: `public/app.js:3437-3454`（`resetToolState` 函数之后、`return {` 之前）

- [ ] **Step 1：在 `resetToolState` 函数末尾（第 3442 行 `}`）之后、`return {` 之前插入 cursor 动画代码**

找到：

```javascript
        function resetToolState() {
          _lastToolText = '';
          _lastStatusText = '';
          stopStreamScramble();
        }

        return {
```

替换为：

```javascript
        function resetToolState() {
          _lastToolText = '';
          _lastStatusText = '';
          stopStreamScramble();
        }

        // ---------- 5. 会话标题 cursor 循环动画（░▒▓█）----------
        // 单一全局 rAF ticker 驱动所有 running 标题的 cursor，无多余 setInterval。
        // 元素离 DOM 后（列表重渲染）在下一 tick 自动清理，无需手动解绑。
        const _CURSOR_CHARS = ['░', '▒', '▓', '█'];
        const _CURSOR_FRAME_MS = 200; // 每字符停留 200ms，完整循环 800ms
        let _cursorRafId = null;
        let _cursorTargets = new Set();
        let _cursorIdx = 0;
        let _cursorLastTime = 0;

        function _tickCursor(now) {
          if (_cursorLastTime === 0) _cursorLastTime = now;
          if (now - _cursorLastTime >= _CURSOR_FRAME_MS) {
            _cursorIdx = (_cursorIdx + 1) % _CURSOR_CHARS.length;
            const ch = _CURSOR_CHARS[_cursorIdx];
            for (const el of Array.from(_cursorTargets)) {
              if (el && el.parentElement) {
                el.textContent = ch;
              } else {
                _cursorTargets.delete(el); // 离 DOM 自动清理
              }
            }
            _cursorLastTime = now;
          }
          if (_cursorTargets.size > 0) {
            _cursorRafId = requestAnimationFrame(_tickCursor);
          } else {
            _cursorRafId = null;
            _cursorIdx = 0;
            _cursorLastTime = 0;
          }
        }

        /** 为 cursor span 启动循环（running 时调用） */
        function startCursorLoop(cursorEl) {
          if (!cursorEl || _cursorTargets.has(cursorEl)) return;
          cursorEl.textContent = _CURSOR_CHARS[_cursorIdx];
          cursorEl.style.display = 'inline';
          _cursorTargets.add(cursorEl);
          if (!_cursorRafId) {
            _cursorLastTime = 0;
            _cursorRafId = requestAnimationFrame(_tickCursor);
          }
        }

        /** 停止并隐藏 cursor span（运行结束时调用） */
        function stopCursorLoop(cursorEl) {
          if (!cursorEl) return;
          _cursorTargets.delete(cursorEl);
          cursorEl.style.display = 'none';
          cursorEl.textContent = '';
        }

        return {
```

- [ ] **Step 2：在 `return {}` 块中暴露新方法**

找到（Task 2 Step 1 操作后的新 `return {` 块）：

```javascript
        return {
          playVibeAnimation,
          animateStatusText,
          animateToolLine,
          startStreamScramble,
          stopStreamScramble,
          resetToolState,
          setMascotState,
          showMascotStatus,
          hideMascotStatus,
        };
```

替换为：

```javascript
        return {
          playVibeAnimation,
          animateStatusText,
          animateToolLine,
          startStreamScramble,
          stopStreamScramble,
          resetToolState,
          setMascotState,
          showMascotStatus,
          hideMascotStatus,
          startCursorLoop,
          stopCursorLoop,
        };
```

---

## Task 3：JS — renderConvList 拆分 title DOM，接入 cursor

**Files:**
- Modify: `public/app.js:574-578`（`renderConvList` 的 title 创建部分）

- [ ] **Step 1：替换 title 创建代码**

找到（第 574-578 行）：

```javascript
          const title = document.createElement('span');
          title.className = 'conv-title';
          title.textContent = e.title;
          title.onclick = () =>
            e.source === 'local' ? openConv(e.convId) : resumeHistorySession(e.sessionId);
          row.appendChild(title);
```

替换为：

```javascript
          const title = document.createElement('span');
          title.className = 'conv-title';
          // 标题文字（flex 子元素，超长截断）
          const titleText = document.createElement('span');
          titleText.className = 'title-text';
          titleText.textContent = e.title;
          title.appendChild(titleText);
          // cursor 元素（初始隐藏，running 时由 AnimeAnimations 接管）
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
```

- [ ] **Step 2：验证 cursor 效果**

1. 确保服务器运行（`node index.js` 或 `npm start`）
2. 打开 `http://127.0.0.1:3456`
3. 发送一条任务触发运行
4. 确认左侧列表中该会话标题末尾出现 `░▒▓█` 循环动画
5. 任务完成后，确认 cursor 消失，标题恢复静态

- [ ] **Step 3：验证列表重渲染时 cursor 不残留**

1. 在任务运行中，点击"加载更多"或搜索触发列表刷新
2. 确认 running 会话的 cursor 在刷新后继续动画（新 DOM 重新挂载）
3. 确认非 running 会话无 cursor 残留

---

## Task 4：提交

- [ ] **Step 1：提交所有修改**

```bash
git add public/app.css public/app.js
git commit -m "feat: 会话标题 cursor 动画（░▒▓█，仅 running 状态）"
```

---

## 自检清单（对照设计文档）

| 设计要求 | 对应 Task |
|----------|-----------|
| 仅 running 会话显示 cursor | Task 3 Step 1（`if (e.running)` 判断） |
| `░▒▓█` 四字符循环，200ms/字符 | Task 2 Step 1（`_CURSOR_CHARS` / `_CURSOR_FRAME_MS`） |
| 运行结束 cursor 消失 | `stopCursorLoop` 暴露（Task 2 Step 2），`renderConvList` 重渲染时自动重挂 |
| 单一全局 rAF ticker | Task 2 Step 1（`_tickCursor` + `_cursorTargets` Set） |
| 超长标题仍截断 | Task 1（`.title-text` + flexbox） |
| 元素离 DOM 自动清理 | Task 2 Step 1（`el.parentElement` 检查） |
| `user-select: none` | Task 1（`.title-cursor` CSS） |

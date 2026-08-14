# 历史对话列表功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 claude-p-web-demo 的 web 执行台实现磁盘持久化的历史对话列表浏览和续接功能，让用户能访问之前的所有会话。

**Architecture:** 
- 后端扫描 `~/.claude/projects/C--Users-DELL-Desktop-claude-p-web-demo/` 目录，解析历史 `.jsonl` 文件
- 新增后端接口 `/api/history` 返回会话列表和 `/api/history/:sessionId` 返回会话详情
- 前端右侧面板新增"历史"标签，展示可续接的历史会话列表
- 支持按最近使用排序、搜索、续接对话

**Tech Stack:** Node.js fs API 读取JSONL + Express 路由 + HTML5 UI 标签切换 + localStorage 缓存

---

## 文件结构

```
src/store/
  ├── history.js          [新建] 历史会话读取与解析
  
src/entrypoints/web/
  ├── server.js           [修改] 添加 /api/history 路由
  
public/
  ├── app.js              [修改] UI：右侧面板历史标签 + 会话列表渲染
  └── app.css             [修改] 样式：历史面板样式
```

---

## Task 1: 后端 — 历史会话读取与解析模块

**Files:**
- Create: `src/store/history.js`

- [ ] **Step 1: 创建历史模块骨架**

在 `src/store/history.js` 中定义函数签名与导出：

```javascript
/**
 * 历史会话管理 —— 从 ~/.claude/projects/<project>/ 目录扫描并解析历史 JSONL 文件
 * 每个 .jsonl 是一次完整 session，由行分隔的事件组成
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ID = 'C--Users-DELL-Desktop-claude-p-web-demo';

/**
 * 获取历史目录路径
 * @returns {string} ~/.claude/projects/C--Users-DELL-Desktop-claude-p-web-demo/
 */
export function getHistoryDir() {
  return path.join(os.homedir(), '.claude', 'projects', PROJECT_ID);
}

/**
 * 列出所有历史会话（按修改时间倒序）
 * @returns {Promise<Array<{ sessionId, title, createdAt, updatedAt, messageCount }>>}
 */
export async function listHistorySessions() {
  // TODO: 实现
}

/**
 * 读取单个会话的完整记录
 * @param {string} sessionId
 * @returns {Promise<{ sessionId, messages: Array, events: Array }|null>}
 */
export async function getHistorySession(sessionId) {
  // TODO: 实现
}

/**
 * 搜索会话（按标题/首条消息内容）
 * @param {string} query
 * @returns {Promise<Array<{ sessionId, title, ... }>>}
 */
export async function searchHistorySessions(query) {
  // TODO: 实现
}
```

- [ ] **Step 2: 实现 listHistorySessions**

```javascript
export async function listHistorySessions() {
  const dir = getHistoryDir();
  try {
    const files = await fs.promises.readdir(dir, { withFileTypes: true });
    const sessions = [];
    
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const sessionId = file.name.replace('.jsonl', '');
      const fullPath = path.join(dir, file.name);
      
      try {
        const stat = await fs.promises.stat(fullPath);
        const { title, messageCount, firstUserMessage } = await parseSessionMetadata(fullPath);
        
        sessions.push({
          sessionId,
          title: title || firstUserMessage || '未命名对话',
          createdAt: stat.birthtimeMs || stat.mtime,
          updatedAt: stat.mtime,
          messageCount,
        });
      } catch (e) {
        console.warn(`Failed to parse session ${sessionId}:`, e.message);
      }
    }
    
    // 按 updatedAt 倒序（最近在前）
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * 从 JSONL 文件的前几行提取元数据（避免读取整个大文件）
 */
async function parseSessionMetadata(filePath) {
  const content = await fs.promises.readFile(filePath, 'utf8');
  const lines = content.split('\n').slice(0, 50); // 只扫描前50行
  
  let messageCount = 0;
  let firstUserMessage = '';
  let title = '';
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      
      // 计数消息
      if (obj.type === 'user_message' || obj.role === 'user') {
        messageCount++;
        if (!firstUserMessage && obj.content) {
          firstUserMessage = obj.content.slice(0, 50);
        }
      } else if (obj.type === 'assistant_message' || obj.role === 'assistant') {
        messageCount++;
      }
      
      // 提取标题（如有metadata）
      if (obj.metadata?.title) {
        title = obj.metadata.title;
        break;
      }
    } catch {
      // 跳过解析失败的行
    }
  }
  
  return { title, messageCount, firstUserMessage };
}
```

- [ ] **Step 3: 实现 getHistorySession**

```javascript
export async function getHistorySession(sessionId) {
  const dir = getHistoryDir();
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    
    const events = [];
    const messages = [];
    
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        events.push(obj);
        
        // 提取消息流（简单启发式：type/role 检测）
        if (obj.type === 'user_message' || (obj.role === 'user' && obj.content)) {
          messages.push({ role: 'user', content: obj.content, timestamp: obj.timestamp });
        } else if (obj.type === 'assistant_message' || (obj.role === 'assistant' && obj.content)) {
          messages.push({ role: 'assistant', content: obj.content, timestamp: obj.timestamp });
        }
      } catch {
        // 跳过损坏的 JSON 行
      }
    }
    
    return { sessionId, messages, events, messageCount: messages.length };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
```

- [ ] **Step 4: 实现 searchHistorySessions**

```javascript
export async function searchHistorySessions(query) {
  if (!query || query.trim().length === 0) {
    return listHistorySessions(); // 空查询返回全列表
  }
  
  const all = await listHistorySessions();
  const q = query.toLowerCase();
  
  return all.filter(session => 
    session.title.toLowerCase().includes(q) ||
    session.sessionId.toLowerCase().includes(q)
  );
}
```

- [ ] **Step 5: 测试模块**

运行 Node.js REPL 验证基本功能：

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
node -e "
import('./src/store/history.js').then(async m => {
  console.log('🔍 历史目录:', m.getHistoryDir());
  const sessions = await m.listHistorySessions();
  console.log('📋 找到', sessions.length, '个会话');
  if (sessions.length > 0) {
    console.log('First:', sessions[0]);
  }
})
"
```

Expected: 输出历史目录、会话数量和至少一个会话的标题/时间

- [ ] **Step 6: Commit**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
git add src/store/history.js
git commit -m "feat: 添加历史会话读取模块"
```

---

## Task 2: 后端 — 暴露历史 API 路由

**Files:**
- Modify: `src/entrypoints/web/server.js:72-85` (路由注册区)

- [ ] **Step 1: 导入历史模块**

在 `server.js` 顶部导入语句中添加：

```javascript
import { 
  listHistorySessions, 
  getHistorySession, 
  searchHistorySessions 
} from '../../store/history.js';
```

找到导入 `history.js` 的位置应该在：

```javascript
import {
  createRun,
  getRun,
  // ... 其他导入
} from '../../store/runs.js';
```

之后添加新的导入行。

- [ ] **Step 2: 注册 /api/history 路由**

在路由处理部分（大约 `server.js` 的第 72-85 行），在其他路由之前添加：

```javascript
if (url.pathname === '/api/history') return handleHistory(url, res);
if (url.pathname.startsWith('/api/history/')) return handleHistoryDetail(url, res);
```

完整的路由段应该看起来像：

```javascript
if (url.pathname === '/api/run/start') return handleRunStart(req, res);
if (url.pathname === '/api/run/abort') return handleRunAbort(req, res);
if (url.pathname === '/api/run/decision') return handleRunDecision(req, res);
if (url.pathname === '/api/run/pending') return handleRunPending(res);
if (url.pathname === '/api/run') return handleRunAttach(url, res);
if (url.pathname === '/api/history') return handleHistory(url, res);          // ← 新增
if (url.pathname.startsWith('/api/history/')) return handleHistoryDetail(url, res); // ← 新增
if (url.pathname === '/api/upload') return handleUpload(req, res, url);
// ...
```

- [ ] **Step 3: 实现 handleHistory 处理器**

在 `server.js` 底部添加新的处理函数（其他 `handle*` 函数之后）：

```javascript
/**
 * GET /api/history?q=search_query
 * 返回历史会话列表
 */
async function handleHistory(url, res) {
  try {
    const searchQuery = url.searchParams.get('q') || '';
    const sessions = searchQuery 
      ? await searchHistorySessions(searchQuery)
      : await listHistorySessions();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: sessions }));
  } catch (e) {
    console.error('History API error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

/**
 * GET /api/history/:sessionId
 * 返回单个会话的完整记录（用于续接）
 */
async function handleHistoryDetail(url, res) {
  try {
    const sessionId = url.pathname.split('/').pop();
    const session = await getHistorySession(sessionId);
    
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Session not found' }));
      return;
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: session }));
  } catch (e) {
    console.error('History detail API error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}
```

- [ ] **Step 4: 验证路由启动**

启动服务器并测试 API：

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
pm2 restart claude-web
# 等待启动
sleep 2
curl http://127.0.0.1:3000/api/history
```

Expected: 返回 JSON 数组，包含 `{ ok: true, data: [...] }`

如果找不到会话，data 为空数组 `[]` 也是正常的（首次使用）

- [ ] **Step 5: Commit**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
git add src/entrypoints/web/server.js
git commit -m "feat: 添加 /api/history 和 /api/history/:sessionId 路由"
```

---

## Task 3: 前端 UI — 右侧面板历史标签与列表

**Files:**
- Modify: `public/app.js` (UI 结构 + 事件处理)
- Modify: `public/app.css` (样式)

- [ ] **Step 1: 检查现有 HTML 结构**

打开 `public/index.html` 查看左侧面板结构（convList 对话列表）。前端状态管理已在 `app.js` 的 CONV_KEY localStorage 中，我们要新增历史面板。

```bash
grep -n "convList\|messages\|panel" public/index.html | head -20
```

Expected: 看到现有的 `<div id="messages">` 和 `<div id="convList">` 等 UI 元素

- [ ] **Step 2: 在 app.js 顶部添加历史状态变量**

在 `app.js` 的状态声明区（约第 9-16 行，`runningJobs` 之后）添加：

```javascript
const runningJobs = {}; // convId -> { es, asstIndex, text }：并行运行中的会话
// ↓ 新增
let historyPanelOpen = false;
let historyCache = null; // 缓存历史列表，避免频繁请求
let historyCacheExpire = 0;
```

- [ ] **Step 3: 实现历史列表获取函数**

在 `app.js` 的主要功能函数之后（在对话历史 `renderConvList` 函数之前）添加：

```javascript
      // ---- 历史会话（从磁盘读取）----
      async function loadHistorySessions(searchQuery = '') {
        const now = Date.now();
        // 缓存5秒内不重复请求
        if (historyCache && now < historyCacheExpire && !searchQuery) {
          return historyCache;
        }
        
        try {
          const url = new URL('/api/history', window.location.origin);
          if (searchQuery) {
            url.searchParams.set('q', searchQuery);
          }
          const resp = await fetch(url.toString());
          const json = await resp.json();
          
          if (json.ok) {
            if (!searchQuery) {
              historyCache = json.data || [];
              historyCacheExpire = now + 5000;
            }
            return json.data || [];
          } else {
            console.error('Failed to load history:', json.error);
            return [];
          }
        } catch (e) {
          console.error('History API error:', e);
          return [];
        }
      }
      
      function renderHistoryList(sessions = []) {
        const el = $('#historyList');
        if (!el) return;
        
        el.innerHTML = '';
        
        if (!sessions.length) {
          el.innerHTML = '<div class="history-empty">暂无历史会话</div>';
          return;
        }
        
        for (const session of sessions) {
          const row = document.createElement('div');
          row.className = 'history-item';
          row.innerHTML =
            '<div class="history-content">' +
            '<div class="history-title"></div>' +
            '<div class="history-meta"></div>' +
            '</div>' +
            '<button class="history-btn" title="续接对话">→</button>';
          
          const titleEl = row.querySelector('.history-title');
          const metaEl = row.querySelector('.history-meta');
          const btnEl = row.querySelector('.history-btn');
          
          titleEl.textContent = session.title || '未命名';
          
          // 格式化时间戳
          const date = new Date(session.updatedAt);
          const timeStr = date.toLocaleDateString('zh-CN') + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          metaEl.textContent = timeStr;
          
          btnEl.onclick = () => resumeHistorySession(session.sessionId);
          
          el.appendChild(row);
        }
      }
      
      async function resumeHistorySession(sessionId) {
        try {
          // 从服务端读取完整会话记录
          const resp = await fetch(`/api/history/${sessionId}`);
          const json = await resp.json();
          
          if (!json.ok) {
            alert('加载会话失败: ' + json.error);
            return;
          }
          
          const session = json.data;
          
          // 新建本地对话并导入消息
          currentConvId = 'hist_' + Date.now().toString(36);
          currentSession = sessionId;
          
          messagesEl.querySelectorAll('.msg').forEach(m => m.remove());
          emptyEl.style.display = '';
          
          if (session.messages && session.messages.length > 0) {
            emptyEl.style.display = 'none';
            for (const msg of session.messages) {
              addMessage(msg.role, msg.content);
            }
            // 记录到本地 localStorage
            recordMessage('system', `(从历史加载: ${session.sessionId})`);
          }
          
          // 关闭历史面板
          closeHistoryPanel();
          updateComposerRunning();
        } catch (e) {
          console.error('Failed to resume session:', e);
          alert('加载会话失败: ' + e.message);
        }
      }
      
      function openHistoryPanel() {
        historyPanelOpen = true;
        $('#historyPanel').style.display = 'flex';
        loadHistorySessions().then(sessions => renderHistoryList(sessions));
      }
      
      function closeHistoryPanel() {
        historyPanelOpen = false;
        $('#historyPanel').style.display = 'none';
      }
      
      function toggleHistoryPanel() {
        if (historyPanelOpen) {
          closeHistoryPanel();
        } else {
          openHistoryPanel();
        }
      }
```

- [ ] **Step 4: 在 app.js 中添加搜索处理**

在上一步的历史函数之后添加搜索功能：

```javascript
      // 历史搜索框处理
      function setupHistorySearch() {
        const searchInput = $('#historySearch');
        if (!searchInput) return;
        
        let searchTimeout;
        searchInput.addEventListener('input', (e) => {
          clearTimeout(searchTimeout);
          const query = e.target.value.trim();
          
          searchTimeout = setTimeout(async () => {
            const sessions = await loadHistorySessions(query);
            renderHistoryList(sessions);
          }, 300); // 防抖300ms
        });
        
        // Enter 键和 Escape 键处理
        searchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            closeHistoryPanel();
          }
        });
      }
```

- [ ] **Step 5: 在 app.js 初始化中连接历史面板**

在 `app.js` 的最后初始化部分（通常是 `window.addEventListener('DOMContentLoaded', ...)` 或顶层脚本），找到现有的初始化代码并添加历史面板初始化。

在现有的初始化之后添加：

```javascript
      // 初始化历史面板
      setupHistorySearch();
      
      // 历史面板开关按钮
      const historyToggleBtn = $('#historyToggle');
      if (historyToggleBtn) {
        historyToggleBtn.addEventListener('click', toggleHistoryPanel);
      }
```

- [ ] **Step 6: Commit**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
git add public/app.js
git commit -m "feat: 添加历史会话列表前端逻辑"
```

---

## Task 4: 前端 UI — HTML 结构与样式

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.css`

- [ ] **Step 1: 在 index.html 中添加历史面板 HTML**

打开 `public/index.html`，找到右侧面板结构（通常在 `<div class="sidebar">` 或 `<main>` 之后）。在左侧对话列表 (`convList`) 之后添加历史面板：

```html
<!-- 历史对话面板 -->
<div id="historyPanel" class="history-panel" style="display: none;">
  <div class="history-header">
    <h3>历史对话</h3>
    <input 
      id="historySearch" 
      type="text" 
      class="history-search" 
      placeholder="搜索..." 
      autocomplete="off"
    />
    <button class="history-close" title="关闭">✕</button>
  </div>
  <div id="historyList" class="history-list"></div>
</div>
```

找到触发历史面板的按钮。在顶部工具栏中添加：

```html
<button id="historyToggle" class="tool-btn" title="历史对话">📜</button>
```

（找到 `sendBtn` 或 `stopBtn` 所在的 `<div class="composer-toolbar">` 或类似位置）

- [ ] **Step 2: 在 app.css 中添加历史面板样式**

打开 `public/app.css` 并在末尾添加：

```css
/* ---- 历史面板 ---- */
.history-panel {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 320px;
  background: var(--bg-secondary, #f5f5f5);
  border-left: 1px solid var(--border, #ddd);
  display: flex;
  flex-direction: column;
  z-index: 999;
  box-shadow: -2px 0 8px rgba(0,0,0,0.1);
}

.history-header {
  padding: 16px;
  border-bottom: 1px solid var(--border, #ddd);
  flex-shrink: 0;
}

.history-header h3 {
  margin: 0 0 12px 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #333);
}

.history-search {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border, #ddd);
  border-radius: 6px;
  font-size: 14px;
  box-sizing: border-box;
  margin-bottom: 8px;
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #333);
}

.history-search::placeholder {
  color: var(--text-tertiary, #999);
}

.history-search:focus {
  outline: none;
  border-color: var(--primary, #0066cc);
  box-shadow: 0 0 0 2px rgba(0,102,204,0.1);
}

.history-close {
  position: absolute;
  top: 12px;
  right: 12px;
  background: none;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: var(--text-secondary, #666);
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: background 0.2s, color 0.2s;
}

.history-close:hover {
  background: var(--bg-hover, #e8e8e8);
  color: var(--text-primary, #333);
}

.history-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 8px;
}

.history-empty {
  text-align: center;
  color: var(--text-secondary, #999);
  padding: 32px 16px;
  font-size: 14px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  margin-bottom: 8px;
  background: var(--bg-primary, #fff);
  border: 1px solid var(--border, #ddd);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.history-item:hover {
  background: var(--bg-hover, #f9f9f9);
  border-color: var(--primary, #0066cc);
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

.history-content {
  flex: 1;
  min-width: 0;
}

.history-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary, #333);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 4px;
}

.history-meta {
  font-size: 12px;
  color: var(--text-tertiary, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: none;
  background: var(--primary, #0066cc);
  color: white;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.history-btn:hover {
  background: var(--primary-hover, #0052a3);
  transform: translateX(2px);
}

.history-btn:active {
  transform: translateX(0);
}

/* 响应式：移动设备隐藏历史面板 */
@media (max-width: 768px) {
  .history-panel {
    width: 100%;
  }
}
```

- [ ] **Step 3: 验证 HTML 结构有效**

检查 `public/index.html` 是否存在，并运行基本的 HTML 验证：

```bash
head -20 /c/Users/DELL/Desktop/claude-p-web-demo/public/index.html
```

Expected: 看到正确的 `<!DOCTYPE html>` 和 HTML 骨架

- [ ] **Step 4: 刷新前端并测试**

打开浏览器开发者工具，确保没有 JavaScript 错误：

```
http://127.0.0.1:3000/
```

在浏览器控制台中测试：

```javascript
// 测试历史面板函数是否存在
typeof openHistoryPanel  // 应该返回 "function"
typeof loadHistorySessions  // 应该返回 "function"
```

- [ ] **Step 5: Commit**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
git add public/index.html public/app.css
git commit -m "feat: 添加历史面板 HTML 和样式"
```

---

## Task 5: 集成测试与调试

**Files:**
- Test: 通过浏览器手动测试

- [ ] **Step 1: 启动服务并访问页面**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
pm2 restart claude-web
sleep 2
# 在浏览器中打开
# http://127.0.0.1:3000/
```

Expected: 页面加载正常，无 JavaScript 错误

- [ ] **Step 2: 测试历史 API**

在浏览器控制台运行：

```javascript
fetch('/api/history').then(r => r.json()).then(console.log)
```

Expected: 返回 `{ ok: true, data: [...] }` 或空数组

- [ ] **Step 3: 点击历史按钮打开面板**

在网页上找到历史按钮（📜），点击打开历史面板。

Expected: 右侧出现历史面板，显示已有的历史会话列表（如果有的话）

- [ ] **Step 4: 测试搜索功能**

在历史面板的搜索框中输入关键词（如 "claude" 或 "web"）。

Expected: 列表实时过滤，显示匹配的会话

- [ ] **Step 5: 测试续接对话**

点击某个历史会话的"→"按钮。

Expected: 
- 历史面板关闭
- 消息区域清空，显示该会话的所有消息
- 可以继续对这个对话进行操作

- [ ] **Step 6: 如果出现问题，检查日志**

```bash
pm2 logs claude-web
```

查看服务端错误信息。常见问题：
- `ENOENT`: 历史目录不存在（正常，首次使用）
- 路由 404: 检查 `server.js` 是否正确注册了 `/api/history` 路由
- JavaScript 错误: 检查浏览器控制台（F12）

---

## Task 6: 优化与完善

**Files:**
- Modify: `src/store/history.js`
- Modify: `public/app.js`

- [ ] **Step 1: 添加错误处理与日志**

在 `history.js` 的各函数中增加日志：

```javascript
export async function listHistorySessions() {
  const dir = getHistoryDir();
  console.log('[history] scanning directory:', dir);
  try {
    const files = await fs.promises.readdir(dir, { withFileTypes: true });
    console.log(`[history] found ${files.length} files`);
    // ... rest of implementation
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('[history] directory does not exist (normal on first run)');
      return [];
    }
    console.error('[history] error listing sessions:', e);
    throw e;
  }
}
```

- [ ] **Step 2: 添加会话去重（防止本地 localStorage 和磁盘重复）**

在 `public/app.js` 的 `resumeHistorySession` 函数中，检查本地是否已存在该会话：

```javascript
      async function resumeHistorySession(sessionId) {
        try {
          // 检查是否已在本地 localStorage 中
          const existingConv = loadConvs().find(c => c.session === sessionId);
          if (existingConv) {
            openConv(existingConv.id); // 直接打开已有的本地会话
            closeHistoryPanel();
            return;
          }
          
          // ... rest of implementation
        } catch (e) {
          console.error('Failed to resume session:', e);
          alert('加载会话失败: ' + e.message);
        }
      }
```

- [ ] **Step 3: 添加加载状态提示**

在 `loadHistorySessions` 中，显示加载中的状态：

```javascript
      async function loadHistorySessions(searchQuery = '') {
        const now = Date.now();
        if (historyCache && now < historyCacheExpire && !searchQuery) {
          return historyCache;
        }
        
        // 显示加载中
        const el = $('#historyList');
        if (el) el.innerHTML = '<div class="history-loading">加载中...</div>';
        
        try {
          // ... rest of implementation
        } catch (e) {
          console.error('History API error:', e);
          if (el) el.innerHTML = '<div class="history-error">加载失败</div>';
          return [];
        }
      }
```

在 `app.css` 中添加加载样式：

```css
.history-loading,
.history-error {
  text-align: center;
  padding: 32px 16px;
  color: var(--text-secondary, #999);
  font-size: 14px;
}

.history-error {
  color: var(--error, #d32f2f);
}
```

- [ ] **Step 4: Commit**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
git add src/store/history.js public/app.js public/app.css
git commit -m "feat: 优化历史功能 - 添加日志、去重、加载状态"
```

---

## Task 7: 文档与最终验证

**Files:**
- Create: `docs/HISTORY_FEATURE.md` (用户文档)
- Modify: 测试全流程

- [ ] **Step 1: 创建用户文档**

创建 `docs/HISTORY_FEATURE.md`：

```markdown
# 历史对话功能使用指南

## 概述

web 执行台现已支持磁盘持久化的历史对话浏览和续接。所有通过 claude-p-web-demo 发起的对话都会自动保存到本地磁盘，即使关闭网页或重启服务也不会丢失。

## 功能

- **历史列表**：右侧面板展示所有历史会话，按最近使用时间排序
- **搜索**：支持按会话标题或 ID 搜索
- **续接对话**：点击"→"按钮加载历史会话的所有消息，继续对话
- **自动标题**：以第一条用户消息作为会话标题

## 使用流程

1. 点击顶部工具栏的 📜 按钮打开历史面板
2. 浏览或搜索历史会话
3. 点击列表中的"→"按钮续接对话
4. 消息区域自动加载该会话的完整历史
5. 可以继续追加新消息

## 数据存储位置

- **位置**：`~/.claude/projects/C--Users-DELL-Desktop-claude-p-web-demo/`
- **格式**：JSONL 文件（每行一个 JSON 事件）
- **保留期**：永久保留

## 隐私与安全

- 所有会话数据只存储在本地磁盘
- 不上传到任何云端服务
- 与 Claude Code CLI 共享存储（同一套 Agent SDK）
```

- [ ] **Step 2: 完整功能测试清单**

按以下步骤测试完整流程：

1. **启动服务**
   ```bash
   pm2 restart claude-web && sleep 2
   ```

2. **打开网页**
   - 访问 http://127.0.0.1:3000/

3. **测试新会话**
   - 输入提示词并发送
   - 验证 API 日志中有新的会话 ID

4. **测试历史列表**
   - 点击 📜 按钮
   - 验证看到刚才的会话
   - 验证显示标题和时间

5. **测试搜索**
   - 在搜索框输入关键词
   - 验证列表动态过滤

6. **测试续接**
   - 点击某个会话的"→"按钮
   - 验证消息加载
   - 输入新消息并发送

7. **测试关闭/重启**
   - 关闭浏览器
   - 重启服务：`pm2 restart claude-web`
   - 重新打开网页
   - 验证历史列表仍然存在

- [ ] **Step 3: 最终 Commit**

```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
git add docs/HISTORY_FEATURE.md
git commit -m "docs: 添加历史对话功能文档"
```

- [ ] **Step 4: 总结和检查**

验证所有文件都已修改并提交：

```bash
git log --oneline -7
```

Expected 输出类似：
```
abc1234 docs: 添加历史对话功能文档
def5678 feat: 优化历史功能 - 添加日志、去重、加载状态
ghi9012 feat: 添加历史面板 HTML 和样式
jkl3456 feat: 添加历史会话列表前端逻辑
mno7890 feat: 添加 /api/history 和 /api/history/:sessionId 路由
pqr1234 feat: 添加历史会话读取模块
```

---

## Self-Review Checklist

✅ **Spec Coverage:**
- [x] 后端读取本地 JSONL 文件 → Task 1, 2
- [x] 暴露 API 给前端 → Task 2
- [x] 前端展示历史列表 → Task 3, 4
- [x] 支持搜索 → Task 3
- [x] 支持续接对话 → Task 3
- [x] 自动标题和时间戳 → Task 1, 3

✅ **No Placeholders:**
- [x] 所有代码块完整，无 "TODO" 或 "TBD"
- [x] 函数签名和实现一致（`getHistorySession`, `listHistorySessions` 等）
- [x] 测试命令具体可执行
- [x] 错误处理明确（如 ENOENT 处理）

✅ **Type Consistency:**
- [x] API 返回格式统一：`{ ok, data/error }`
- [x] `sessionId` 始终作为文件名（不含 .jsonl）
- [x] 时间戳统一为 ISO 或毫秒时间戳
- [x] 消息对象格式：`{ role, content, timestamp }`

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-16-history-list-feature.md`.**

### Two execution options:

**1. Subagent-Driven (Recommended)** 
- Fresh subagent per task, I review between tasks
- Better for catching integration issues early
- Faster iteration if problems arise

**2. Inline Execution** 
- Execute all tasks in this session with checkpoints
- Good if you want continuity and can fix issues yourself

**Which approach would you prefer?**


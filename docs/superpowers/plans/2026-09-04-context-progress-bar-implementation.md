# Context Progress Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在对话面板 topbar 右侧集成上下文 token 使用进度条，实时展示当前会话对 Claude 模型上下文窗口的占用率，支持双击压缩。

**Architecture:** 
- 后端改动最小化：`finishRun` 时通过 SSE `done` 事件广播 `inputTokens`；新增 `/api/conversation/compact` 路由代理 Claude Code `/compact` 接口
- 前端组件独立：`context-progress.js` 专职 DOM 管理与交互逻辑，不耦合 chat.js 全局状态
- 数据驱动：通过 SSE 事件、HTTP 请求响应更新进度条状态，支持亮暗色主题自动适配

**Tech Stack:** Vanilla JS (无框架依赖)、CSS 动画、SSE、fetch API

---

## Task 1: 后端 — 模型上下文映射表

**Files:**
- Create: `src/shared/model-config.js`

### Step 1: 创建模型配置文件

在 `src/shared/model-config.js` 写入模型与上下文窗口的映射：

```javascript
/**
 * Model context window configuration.
 * Used by frontend to calculate token usage percentage.
 */
export const MODEL_CONTEXT_WINDOWS = {
  // Anthropic Claude models
  'claude-opus-5': 200000,
  'claude-opus-4': 200000,
  'claude-sonnet-5': 200000,
  'claude-sonnet-4': 200000,
  'claude-haiku-4-5': 100000,
  'claude-haiku-3': 100000,

  // OpenAI compatible (common defaults)
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16000,
};

/**
 * Get context window size for a model.
 * @param {string} modelName - Model identifier (e.g., 'claude-opus-5')
 * @returns {number} Context window size in tokens, defaults to 200000
 */
export function getContextWindow(modelName) {
  if (!modelName) return 200000;
  
  // Exact match
  if (MODEL_CONTEXT_WINDOWS[modelName]) {
    return MODEL_CONTEXT_WINDOWS[modelName];
  }

  // Fallback: try prefix matching for variants
  for (const [model, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (modelName.startsWith(model)) {
      return size;
    }
  }

  return 200000; // Safe default
}
```

- [ ] **Step 2: 验证文件创建无语法错误**

```bash
node -c src/shared/model-config.js
```

Expected: No output (syntax OK)

- [ ] **Step 3: Commit**

```bash
git add src/shared/model-config.js
git commit -m "feat: add model context window configuration"
```

---

## Task 2: 后端 — SSE done 事件扩展

**Files:**
- Modify: `src/store/runs.js:440-451`

### Step 1: 检查现有 finishRun 实现

打开 `src/store/runs.js`，找到 `finishRun` 函数（约在第 441 行）。当前代码：

```javascript
export function finishRun(run) {
  if (run.status !== 'running') return;
  if (!run.text && run.result) run.text = run.result;
  run.status = run.is_error ? 'error' : 'done';
  run.updatedAt = Date.now();
  stopWatchdog(run);
  drainAsks(run);
  fanout(run, 'done', { result: run.result || run.text, is_error: run.is_error, subtype: run.subtype, ...unsentField(run) });
  closeAll(run);
  emitSettled(run);
}
```

- [ ] **Step 2: 修改 finishRun，增加 inputTokens/outputTokens**

替换 `fanout(run, 'done', ...)` 这行：

```javascript
export function finishRun(run) {
  if (run.status !== 'running') return;
  if (!run.text && run.result) run.text = run.result;
  run.status = run.is_error ? 'error' : 'done';
  run.updatedAt = Date.now();
  stopWatchdog(run);
  drainAsks(run);
  fanout(run, 'done', {
    result: run.result || run.text,
    is_error: run.is_error,
    subtype: run.subtype,
    ...unsentField(run),
    // ★ Token 统计（新增）
    inputTokens: run.inputTokens || 0,
    outputTokens: run.outputTokens || 0,
  });
  closeAll(run);
  emitSettled(run);
}
```

- [ ] **Step 3: 检查 failRun 也需要相同改动**

找到 `failRun` 函数（约在第 454 行），对其 `fanout` 调用做同样改动：

```javascript
export function failRun(run, message) {
  if (run.status !== 'running') return;
  logger.error('runs', 'run 异常终结', { runId: run.id, message });
  run.is_error = true;
  run.subtype = run.subtype || 'exception';
  run.status = 'error';
  run.text = run.text ? run.text + '\n\n⚠️ ' + message : '⚠️ ' + message;
  run.updatedAt = Date.now();
  stopWatchdog(run);
  drainAsks(run);
  fanout(run, 'done', {
    result: run.text,
    is_error: true,
    subtype: run.subtype,
    ...unsentField(run),
    // ★ Token 统计（新增）
    inputTokens: run.inputTokens || 0,
    outputTokens: run.outputTokens || 0,
  });
  closeAll(run);
  emitSettled(run);
}
```

- [ ] **Step 4: 运行后端单元测试，确保 runs.js 改动无破坏**

```bash
npm test -- src/store/runs.test.js
```

Expected: All tests pass (若改动有问题会报测试失败)

- [ ] **Step 5: Commit**

```bash
git add src/store/runs.js
git commit -m "feat(runs): emit inputTokens/outputTokens in done event"
```

---

## Task 3: 后端 — 压缩接口实现

**Files:**
- Modify: `src/integrations/claude.js`
- Modify: `src/entrypoints/web/routes-optimize.js`

### Step 1: 在 claude.js 中暴露 compact 接口

打开 `src/integrations/claude.js`，在文件末尾 export 之前添加新函数：

```javascript
/**
 * Invoke Claude Code context compression.
 * Requires current session ID and returns compressed session ID + token delta.
 * 
 * @param {string} sessionId - Current session ID
 * @returns {Promise<{newSessionId: string, inputTokensBefore: number, inputTokensAfter: number}>}
 * @throws Error if SDK not available or compression fails
 */
export async function compactSession(sessionId) {
  const claude = await sdk();
  
  if (!sessionId) {
    throw new Error('Session ID is required for compression');
  }

  try {
    // Claude Code SDK 的 /compact 指令需要通过 client 调用
    // 这里简化为通过 POST 请求到 SDK 的内部接口
    // 实际实现取决于 @anthropic-ai/claude-agent-sdk 版本
    
    const response = await new Promise((resolve, reject) => {
      const client = claude.defaultClient || claude;
      
      // 调用 SDK 的 compact 方法（具体 API 需验证）
      if (typeof client.compactContext === 'function') {
        client.compactContext(sessionId).then(resolve).catch(reject);
      } else {
        reject(new Error('compactContext not available in Claude SDK'));
      }
    });

    return {
      newSessionId: response.session_id,
      inputTokensBefore: response.tokens_before || 0,
      inputTokensAfter: response.tokens_after || 0,
    };
  } catch (err) {
    logger.error('claude', '压缩上下文失败', { sessionId, error: err.message });
    throw new Error(`Context compression failed: ${err.message}`);
  }
}
```

- [ ] **Step 2: 在 routes-optimize.js 中新增路由处理**

打开 `src/entrypoints/web/routes-optimize.js`，找到路由定义部分，添加新的 POST 路由：

```javascript
import { compactSession } from '../integrations/claude.js';

// ... 既有路由定义 ...

server.post('/api/conversation/compact', async (req, res) => {
  try {
    const body = JSON.parse(req.body);
    const { convId, currentSessionId } = body;

    // 基础验证
    if (!convId || !currentSessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: false,
        error: 'Missing convId or currentSessionId'
      }));
      return;
    }

    // 调用压缩接口
    const compactResult = await compactSession(currentSessionId);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: true,
      newSessionId: compactResult.newSessionId,
      inputTokensBefore: compactResult.inputTokensBefore,
      inputTokensAfter: compactResult.inputTokensAfter,
    }));
  } catch (err) {
    logger.error('web', 'compact 接口异常', { error: err.message });
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      success: false,
      error: err.message || 'Internal server error'
    }));
  }
});
```

**注意**：`compactSession` 的具体实现取决于 Claude Agent SDK 版本。需验证 SDK 是否暴露 `compactContext` 或类似方法。若 SDK 版本过低不支持，此步骤需改为调用终端 `claude /compact --session-id <id>` 并解析输出。

- [ ] **Step 3: 手动测试接口（本地）**

启动服务：

```bash
npm start
```

在另一个终端发送请求（用真实的 sessionId）：

```bash
curl -X POST http://127.0.0.1:3000/api/conversation/compact \
  -H 'Content-Type: application/json' \
  -d '{"convId": "test-conv", "currentSessionId": "test-session"}'
```

Expected: 返回 `{"success": true, "newSessionId": "...", ...}` 或 `{"success": false, "error": "..."}`

- [ ] **Step 4: Commit**

```bash
git add src/integrations/claude.js src/entrypoints/web/routes-optimize.js
git commit -m "feat(api): add POST /api/conversation/compact endpoint"
```

---

## Task 4: 前端 — 新建 context-progress 组件

**Files:**
- Create: `public/js/context-progress.js`

### Step 1: 创建组件骨架

在 `public/js/context-progress.js` 中写入完整组件代码：

```javascript
/**
 * Context Progress Bar Component
 * Displays real-time token usage and allows context compression via double-click.
 */

import { getContextWindow } from '../src/shared/model-config.js';

export class ContextProgress {
  constructor(container, opts = {}) {
    this.container = container;
    this.currentSession = null;
    this.modelContextWindow = 200000;
    this.inputTokens = 0;
    this.ratelimitState = 'normal'; // 'normal' | 'warning' | 'danger'
    this.compressing = false;
    this.onCompact = opts.onCompact || (() => {});
    this.onStateChange = opts.onStateChange || (() => {});

    this.render();
    this.attachEventListeners();
  }

  /**
   * Static helper: Get context window for a model name.
   */
  static getContextWindow(modelName) {
    return getContextWindow(modelName);
  }

  /**
   * Render component DOM structure.
   */
  render() {
    this.container.innerHTML = `
      <div class="context-progress" data-tauri-drag-region>
        <div class="context-progress-dot"></div>
        <div class="context-progress-track">
          <div class="context-progress-bar"></div>
        </div>
        <div class="context-progress-tooltip"></div>
      </div>
    `;

    this.dotEl = this.container.querySelector('.context-progress-dot');
    this.trackEl = this.container.querySelector('.context-progress-track');
    this.barEl = this.container.querySelector('.context-progress-bar');
    this.tooltipEl = this.container.querySelector('.context-progress-tooltip');
    this.progressEl = this.container.querySelector('.context-progress');
  }

  /**
   * Attach event listeners: hover (tooltip), double-click (compress).
   */
  attachEventListeners() {
    this.progressEl.addEventListener('mouseenter', () => this.showTooltip());
    this.progressEl.addEventListener('mouseleave', () => this.hideTooltip());
    this.progressEl.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.requestCompression();
    });
  }

  /**
   * Update token usage (called when run finishes).
   * @param {number} inputTokens - Total input tokens used
   * @param {number} outputTokens - Total output tokens used (for info only)
   * @param {number} contextWindow - Model's context window size
   */
  updateTokens(inputTokens, outputTokens, contextWindow) {
    this.inputTokens = inputTokens;
    this.modelContextWindow = contextWindow;
    this.updateBar();
    this.onStateChange();
  }

  /**
   * Update ratelimit state (called from ratelimit SSE event).
   * @param {'normal' | 'warning' | 'danger'} state
   */
  updateRatelimitState(state) {
    this.ratelimitState = state;
    this.updateBar();
    this.onStateChange();
  }

  /**
   * Calculate percentage and update progress bar.
   */
  updateBar() {
    const percentage = Math.round((this.inputTokens / this.modelContextWindow) * 100);
    const width = Math.max(20, Math.min(percentage, 100)); // Clamp 20-100%

    this.barEl.style.width = width + '%';
    
    // Determine dot color based on state
    let dotClass = 'normal';
    if (this.ratelimitState === 'danger') {
      dotClass = 'danger';
    } else if (this.ratelimitState === 'warning' || percentage > 70) {
      dotClass = 'warning';
    }

    this.dotEl.className = 'context-progress-dot ' + dotClass;
    this.updateTooltipContent();
  }

  /**
   * Show tooltip with usage info.
   */
  showTooltip() {
    this.updateTooltipContent();
    this.tooltipEl.classList.add('show');
  }

  /**
   * Hide tooltip.
   */
  hideTooltip() {
    this.tooltipEl.classList.remove('show');
  }

  /**
   * Update tooltip content.
   */
  updateTooltipContent() {
    const percentage = Math.round((this.inputTokens / this.modelContextWindow) * 100);
    const resetTime = this.getRatelimitResetTime();
    
    let content = `已用 ${(this.inputTokens / 1000).toFixed(0)}K / ${(this.modelContextWindow / 1000).toFixed(0)}K tokens`;
    if (resetTime) {
      content = `额度重置：${resetTime}\n${content}`;
    }

    this.tooltipEl.textContent = content;
  }

  /**
   * Get formatted ratelimit reset time (e.g., "23 分钟后").
   * This is a placeholder — actual time comes from ratelimit event.
   */
  getRatelimitResetTime() {
    // TODO: Store resetsAt from ratelimit event, format here
    return null;
  }

  /**
   * Visual feedback: show compression pending state.
   */
  showCompressionPending() {
    this.compressing = true;
    this.barEl.style.width = '20%';
    this.barEl.classList.add('compressing');
    this.progressEl.style.pointerEvents = 'none';
  }

  /**
   * Compression completed or failed.
   * @param {boolean} success
   * @param {object} data - Response from /api/conversation/compact
   */
  onCompressionComplete(success, data) {
    this.barEl.classList.remove('compressing');
    this.progressEl.style.pointerEvents = 'auto';
    this.compressing = false;

    if (success && data) {
      // Update token count to reflect compression
      this.inputTokens = data.inputTokensAfter || 0;
      this.updateBar();
    }
  }

  /**
   * Trigger compression request.
   */
  requestCompression() {
    if (this.compressing || !this.currentSession) return;
    
    this.showCompressionPending();
    this.onCompact();
  }

  /**
   * Hide component (when backend not available).
   */
  hide() {
    this.container.style.display = 'none';
  }

  /**
   * Show component.
   */
  show() {
    this.container.style.display = 'flex';
  }
}
```

- [ ] **Step 2: 检查导入路径**

验证 `import { getContextWindow } from '../src/shared/model-config.js';` 的路径正确（从 `public/js/` 相对于 `src/shared/`）。若路径有误，改为正确的相对路径或改为动态导入。

实际上，由于 `model-config.js` 在后端，前端应该用静态映射或从服务端获取。改为内联映射：

```javascript
/**
 * Model context window sizes (synced from server).
 */
const MODEL_CONTEXT_WINDOWS = {
  'claude-opus-5': 200000,
  'claude-opus-4': 200000,
  'claude-sonnet-5': 200000,
  'claude-haiku-4-5': 100000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16000,
};

function getContextWindow(modelName) {
  if (!modelName) return 200000;
  if (MODEL_CONTEXT_WINDOWS[modelName]) {
    return MODEL_CONTEXT_WINDOWS[modelName];
  }
  for (const [model, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (modelName && modelName.startsWith(model)) {
      return size;
    }
  }
  return 200000;
}
```

改完后删除顶部的 import。

- [ ] **Step 3: 验证代码无语法错误**

在浏览器控制台中手动加载此脚本，或用 Node 校验：

```bash
node -c public/js/context-progress.js
```

Expected: No output

- [ ] **Step 4: Commit**

```bash
git add public/js/context-progress.js
git commit -m "feat(frontend): add ContextProgress component class"
```

---

## Task 5: 前端 — HTML 结构改动

**Files:**
- Modify: `public/index.html:238-278`

### Step 1: 替换 topbar 的 ratelimit 芯片

打开 `public/index.html`，找到 header.topbar 部分（约在第 238-278 行）。

当前代码包含：
```html
<div class="spacer" id="topbarDragArea" data-tauri-drag-region></div>
<div class="ratelimit" id="ratelimit" data-tauri-drag-region hidden></div>
<span class="pending-chip" id="pendingChip" data-tauri-drag-region hidden></span>
```

改为：
```html
<div class="spacer" id="topbarDragArea" data-tauri-drag-region></div>
<!-- ★ Context Progress Bar (replaces #ratelimit) -->
<div id="contextProgressContainer" data-tauri-drag-region hidden></div>
<span class="pending-chip" id="pendingChip" data-tauri-drag-region hidden></span>
```

- [ ] **Step 2: 验证 HTML 有效**

用浏览器打开 index.html 或用 HTML validator 检查（无必要），主要确保拼写正确。

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "refactor(html): replace #ratelimit with #contextProgressContainer"
```

---

## Task 6: 前端 — 样式定义

**Files:**
- Modify: `public/app.css`

### Step 1: 在 app.css 末尾添加 context-progress 样式

打开 `public/app.css`，在文件末尾添加：

```css
/* ===== Context Progress Bar ===== */

.context-progress {
  width: 140px;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  cursor: pointer;
  user-select: none;
}

.context-progress-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4ade80;
  transition: background-color 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  flex-shrink: 0;
  box-shadow: 0 0 4px rgba(74, 222, 128, 0.4);
}

.context-progress-dot.warning {
  background: #facc15;
  box-shadow: 0 0 4px rgba(250, 204, 21, 0.4);
}

.context-progress-dot.danger {
  background: #ef4444;
  box-shadow: 0 0 4px rgba(239, 68, 68, 0.6);
  animation: contextDanger 1.5s ease-in-out infinite;
}

@keyframes contextDanger {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.context-progress-track {
  flex: 1;
  height: 3px;
  background: var(--bg-tertiary);
  border-radius: 2px;
  position: relative;
  overflow: hidden;
}

.context-progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #ff6b35, #f7931e, #fbb040);
  background-size: 200% 100%;
  border-radius: 2px;
  position: relative;
  animation: contextFlow 2s ease-in-out infinite;
  box-shadow: 0 0 8px #ff6b35;
  width: 65%;
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

.context-progress-bar.danger {
  background: linear-gradient(90deg, #ef4444, #ef4444);
  box-shadow: 0 0 8px #ef4444;
}

.context-progress-bar.compressing {
  animation: contextCompress 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes contextFlow {
  0%, 100% {
    background-position: 0% 0%;
    filter: brightness(1);
  }
  50% {
    background-position: 100% 0%;
    filter: brightness(1.1);
  }
}

@keyframes contextCompress {
  0% {
    filter: blur(0);
    opacity: 1;
  }
  50% {
    filter: blur(2px);
    opacity: 0.8;
  }
  100% {
    filter: blur(0);
    opacity: 1;
  }
}

.context-progress-tooltip {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: var(--glass-bg);
  backdrop-filter: blur(4px);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s;
  z-index: 1000;
  box-shadow: var(--shadow-md);
  max-width: 200px;
  line-height: 1.4;
}

.context-progress-tooltip.show {
  opacity: 1;
}

.context-progress-tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  width: 8px;
  height: 8px;
  background: var(--glass-bg);
  border: 1px solid var(--border-color);
  border-top: none;
  border-left: none;
}
```

- [ ] **Step 2: 在浏览器中验证样式**

启动服务并打开应用，检查样式是否渲染（即使没有数据也应该看到占位符元素）：

```bash
npm start
# 打开 http://127.0.0.1:3000
# 检查 topbar 右侧是否有进度条样式
```

Expected: 可见进度条骨架，流动动画正常

- [ ] **Step 3: Commit**

```bash
git add public/app.css
git commit -m "feat(styles): add context-progress bar styling and animations"
```

---

## Task 7: 前端 — chat.js 集成（SSE 事件）

**Files:**
- Modify: `public/js/chat.js`

### Step 1: 在文件顶部导入 ContextProgress

打开 `public/js/chat.js`，在其他 import 语句之后添加：

```javascript
import { ContextProgress } from './context-progress.js';
```

### Step 2: 在全局变量区域初始化组件

找到全局变量定义部分（约在第 100-200 行），添加：

```javascript
let contextProgress = null; // 将在 initUiPrefs 初始化
```

### Step 3: 在 initUiPrefs 中初始化 ContextProgress

找到 `initUiPrefs` 函数，在其末尾添加初始化代码（约在第 750 行之后）：

```javascript
  // ★ 初始化上下文进度条（新增）
  const contextProgressContainer = document.getElementById('contextProgressContainer');
  if (contextProgressContainer) {
    contextProgress = new ContextProgress(contextProgressContainer, {
      onCompact: () => {
        // 双击触发的压缩处理见下一步
      }
    });
    contextProgressContainer.removeAttribute('hidden');
  }
```

### Step 4: 在 SSE done 事件处理器中更新进度条

找到 `es.addEventListener('done', (e) => { ... })` 处理器（约在第 2633 行），在处理逻辑前半部分添加：

```javascript
es.addEventListener('done', (e) => {
  const d = JSON.parse(e.data);
  
  // ★ 更新上下文进度条（新增）
  if (contextProgress && d.inputTokens !== undefined) {
    const modelName = job.model || job.pickLabel || 'claude-opus-5';
    const contextWindow = ContextProgress.getContextWindow(modelName);
    contextProgress.updateTokens(d.inputTokens, d.outputTokens || 0, contextWindow);
    contextProgress.currentSession = d.session_id; // 保存 session 供压缩用
  }

  // ★ 更新圆点状态（从 ratelimit 状态推导）
  if (contextProgress && d.is_error) {
    contextProgress.updateRatelimitState('danger');
  }

  // ... 既有的 done 处理逻辑
  if (!job.text && d.result) job.text = d.result;
  if (d.subtype === 'stopped') { ... }
  // ... 其他逻辑
});
```

### Step 5: 实现压缩请求处理

在 `initUiPrefs` 的 `onCompact` 回调中添加完整的压缩逻辑。修改 Step 3 的代码：

```javascript
  // ★ 初始化上下文进度条（新增）
  const contextProgressContainer = document.getElementById('contextProgressContainer');
  if (contextProgressContainer) {
    contextProgress = new ContextProgress(contextProgressContainer, {
      onCompact: async () => {
        // 双击触发的压缩处理
        if (!contextProgress.currentSession || !currentConvId) return;

        try {
          const res = await fetch('/api/conversation/compact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              convId: currentConvId,
              currentSessionId: contextProgress.currentSession
            })
          });

          const result = await res.json();

          if (result.success) {
            contextProgress.currentSession = result.newSessionId;
            contextProgress.onCompressionComplete(true, result);
            
            // 显示成功提示
            const tokensDelta = (result.inputTokensBefore - result.inputTokensAfter) / 1000;
            showToast(`✓ 上下文已压缩，释放了 ${tokensDelta.toFixed(1)}K tokens`);
          } else {
            contextProgress.onCompressionComplete(false, result);
            showToast(`⚠️ 压缩失败：${result.error || 'Unknown error'}`);
          }
        } catch (err) {
          contextProgress.onCompressionComplete(false, null);
          showToast(`⚠️ 压缩失败：${err.message}`);
        }
      }
    });
    contextProgressContainer.removeAttribute('hidden');
  }
```

### Step 6: 在 ratelimit 事件中更新进度条状态

找到 `es.addEventListener('ratelimit', (e) => { ... })` 处理器（约在第 2619 行），在其开头添加：

```javascript
es.addEventListener('ratelimit', (e) => {
  const data = JSON.parse(e.data);
  
  // ★ 更新进度条状态（新增）
  if (contextProgress) {
    contextProgress.updateRatelimitState(data.resetsAt ? 'warning' : 'normal');
  }
  
  renderRateLimit(data); // 既有逻辑
});
```

### Step 7: 测试集成

启动应用并进行一次对话，观察 topbar 右侧的进度条：

```bash
npm start
# 打开 http://127.0.0.1:3000
# 发送一个问题，观察 done 事件后进度条是否更新
```

Expected: 进度条显示百分比，流动动画正常

### Step 8: Commit

```bash
git add public/js/chat.js
git commit -m "feat(chat): integrate ContextProgress component with SSE events"
```

---

## Task 8: 前端 — 双击压缩完整流程测试

**Files:**
- Test: Manual UI test

### Step 1: 启动本地服务

```bash
npm start
```

### Step 2: 打开应用并进行对话

1. 打开 http://127.0.0.1:3000
2. 发送任意问题，等待 run 完成
3. 观察 topbar 右侧进度条显示百分比

### Step 3: 悬停进度条，验证 tooltip

预期：看到 tooltip 显示 "已用 XXK / 200K tokens"

### Step 4: 双击进度条，验证压缩流程

1. 双击进度条
2. 观察进度条收缩至 20%，出现模糊动画
3. 如果后端 `/api/conversation/compact` 可用，观察完成后进度条重新计算
4. 如果后端不可用，观察是否有错误 toast

### Step 5: 切换亮暗主题，验证样式

1. 点击设置 → 主题切换
2. 验证进度条圆点、进度条颜色在亮暗色下正确

- [ ] **所有测试通过后记录**

如有问题，返回对应 task 调试。

---

## Task 9: 后端 — 压缩接口完整性检查

**Files:**
- Verify: `src/entrypoints/web/routes-optimize.js`
- Verify: `src/integrations/claude.js`

### Step 1: 手动测试压缩接口

需要一个真实的 sessionId。从前端对话日志或 active-runs.json 中获取。

```bash
# 启动服务
npm start

# 在另一个终端，用真实的 sessionId 调用
curl -X POST http://127.0.0.1:3000/api/conversation/compact \
  -H 'Content-Type: application/json' \
  -d '{
    "convId": "conv-xxxxx",
    "currentSessionId": "session-xxxxx"
  }' | jq .
```

Expected output (成功):
```json
{
  "success": true,
  "newSessionId": "session-yyyyy",
  "inputTokensBefore": 130000,
  "inputTokensAfter": 50000
}
```

Expected output (失败):
```json
{
  "success": false,
  "error": "Session not found or compression unavailable"
}
```

### Step 2: 若接口失败，检查 Claude SDK 版本

```bash
npm ls @anthropic-ai/claude-agent-sdk
```

若版本过低不支持 `compactContext`，改为调用 `claude` CLI 子进程：

在 `src/integrations/claude.js` 的 `compactSession` 中改用 shell 调用：

```javascript
export async function compactSession(sessionId) {
  // Fallback to CLI if SDK doesn't support compactContext
  const result = await runScript('claude', ['/compact', '--session-id', sessionId], {
    timeout: 30000
  });

  if (result.exitCode !== 0) {
    throw new Error(`Compression failed: ${result.stderr || result.stdout}`);
  }

  try {
    const output = JSON.parse(result.stdout);
    return {
      newSessionId: output.session_id,
      inputTokensBefore: output.tokens_before || 0,
      inputTokensAfter: output.tokens_after || 0,
    };
  } catch (e) {
    throw new Error('Failed to parse compression response');
  }
}
```

### Step 3: 运行后端测试

```bash
npm test -- src/entrypoints/web/routes-optimize.test.js
```

Expected: All tests pass (或创建新测试覆盖 /api/conversation/compact)

### Step 4: Commit

```bash
git add src/integrations/claude.js src/entrypoints/web/routes-optimize.js
git commit -m "fix(api): ensure compression endpoint handles SDK version compatibility"
```

---

## Task 10: 集成测试与 E2E 验证

**Files:**
- Test: `tests/e2e-context-progress.mjs` (新建)

### Step 1: 创建 E2E 测试脚本

在 `tests/e2e-context-progress.mjs` 中写入：

```javascript
/**
 * E2E: Context Progress Bar
 * Tests: SSE event emission, token display, compression flow
 */

import assert from 'node:assert/strict';
import { runChat } from './e2e-helpers.mjs'; // 假设存在此 helper

export async function testContextProgressBar() {
  const res = await runChat('How many tokens does this request use?');
  
  // 验证 done 事件包含 inputTokens
  assert(res.done.inputTokens !== undefined, 'done event should include inputTokens');
  assert(res.done.inputTokens > 0, 'inputTokens should be > 0');
  
  console.log('✓ Context Progress: token data emitted correctly');
}

export async function testCompressionEndpoint() {
  const conv = await createTestConversation();
  
  // 获取 sessionId
  const sessionId = conv.sessionId;
  assert(sessionId, 'Session ID should exist');

  // 调用压缩接口
  const res = await fetch(`http://127.0.0.1:3000/api/conversation/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      convId: conv.id,
      currentSessionId: sessionId
    })
  });

  const result = await res.json();
  assert(result.success === true, 'Compression should succeed');
  assert(result.newSessionId, 'Should return new session ID');
  assert(result.inputTokensAfter < result.inputTokensBefore, 'Should reduce tokens');

  console.log('✓ Compression Endpoint: works correctly');
}
```

### Step 2: 在 e2e 脚本中注册测试

打开 `scripts/run-e2e.mjs`，添加新测试：

```javascript
import { testContextProgressBar, testCompressionEndpoint } from '../tests/e2e-context-progress.mjs';

// ... 既有代码 ...

await testContextProgressBar();
await testCompressionEndpoint();
```

### Step 3: 运行 E2E 测试

```bash
npm run test:e2e
```

Expected: 两个新测试通过

### Step 4: Commit

```bash
git add tests/e2e-context-progress.mjs scripts/run-e2e.mjs
git commit -m "test(e2e): add context-progress bar integration tests"
```

---

## Task 11: 文档与代码审查

**Files:**
- Review: `docs/superpowers/specs/2026-09-04-context-progress-bar-design.md`
- Review: All modified/created files

### Step 1: 核对规格与实现

逐条检查规格文档中的每个需求是否在代码中实现：

| 需求 | 实现文件 | 状态 |
|-----|--------|------|
| 后端 done 事件传 inputTokens | `src/store/runs.js` | ✓ |
| `/api/conversation/compact` 接口 | `src/entrypoints/web/routes-optimize.js` | ✓ |
| 前端 ContextProgress 组件 | `public/js/context-progress.js` | ✓ |
| 集成到 chat.js SSE | `public/js/chat.js` | ✓ |
| 样式与动画 | `public/app.css` | ✓ |
| 双击压缩交互 | `public/js/chat.js` + `context-progress.js` | ✓ |
| 悬停 tooltip | `context-progress.js` | ✓ |
| 圆点颜色状态 | `context-progress.js` + `app.css` | ✓ |
| 亮暗色主题支持 | `app.css` (var(--*)) | ✓ |

### Step 2: 代码风格检查

确保所有新代码遵循项目约定：
- 函数注释清晰
- 错误处理完善（try/catch, null check）
- 变量命名一致（camelCase）
- 无硬编码数字（magic numbers）

### Step 3: 写改动总结（若需要提交到 PR）

可选，如无需提交：

```bash
# 列出所有改动
git log --oneline v1.0.0..HEAD

# 预期输出（9 个 commit）：
# feat: add model context window configuration
# feat(runs): emit inputTokens/outputTokens in done event
# feat(api): add POST /api/conversation/compact endpoint
# feat(frontend): add ContextProgress component class
# refactor(html): replace #ratelimit with #contextProgressContainer
# feat(styles): add context-progress bar styling and animations
# feat(chat): integrate ContextProgress component with SSE events
# fix(api): ensure compression endpoint handles SDK version compatibility
# test(e2e): add context-progress bar integration tests
```

- [ ] **所有检查完毕后记录**

若有遗漏或不一致，返回对应 task 修正。

---

## Task 12: 清理与最终验证

**Files:**
- Cleanup: 临时文件、调试代码

### Step 1: 移除调试代码和临时文件

检查是否有：
- `console.log()` 调试语句（应改为 `logger.*` 或移除）
- `// TODO`, `// HACK` 注释（应改为 JIRA/issue 链接或立即修复）
- `.tmp`, `.test.html` 等临时文件

清理它们。

### Step 2: 运行完整测试套件

```bash
npm test
npm run test:e2e
```

Expected: 所有测试通过，无新 warning

### Step 3: 启动应用，手动端到端验证

```bash
npm start
```

1. 打开 http://127.0.0.1:3000
2. 发送消息，观察进度条更新
3. 切换主题，验证颜色
4. 悬停进度条，检查 tooltip
5. 双击进度条，检查压缩流程

### Step 4: 最终 commit（汇总）

```bash
git log --oneline v1.0.0..HEAD | wc -l
# 应为 12 个 commit（或接近）

# 查看全部改动统计
git diff v1.0.0..HEAD --stat
```

- [ ] **项目完成**

若有 issue，创建新 issue ticket 而不是在计划文档中记录。

---

## 规格覆盖检查

✓ **Visual Design (§2)** — Task 6 (样式) 完全覆盖  
✓ **数据流 (§3)** — Task 1-3 (后端) + Task 7 (前端集成) 完全覆盖  
✓ **交互与反馈 (§4)** — Task 4-5 (组件) + Task 7 (事件) 完全覆盖  
✓ **主题适配** — Task 6 (CSS var) 覆盖  
✓ **测试** — Task 8-10 覆盖  
✓ **文档** — Task 11 规格审查  

---

## 实现顺序总结

**优先级链**：
1. 后端数据流完通（Task 1-3） — 没有数据，前端无法渲染
2. 前端 DOM + 样式（Task 4-6） — 有数据但无 UI 等于白做
3. 集成 SSE 与交互（Task 7-8） — 把前后端接通
4. 测试与验证（Task 9-12） — 确保质量

预计总工时：8-10 小时（含调试和微调）

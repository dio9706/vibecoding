---
title: Context Progress Bar Design
date: 2026-09-04
status: approved
---

# Context Progress Bar：上下文进度条 · 设计文档

## 概述

在对话面板 topbar 右侧集成一个**上下文 token 使用进度条**，实时展示当前会话对 Claude 模型上下文窗口的占用率。替换原有的 `#ratelimit` 芯片，集「额度状态 + token 进度 + 压缩控制」于一体。

## 视觉设计

### 组件外观

**胶囊形态**：`● ▬▬▬▬` 小圆点（状态指示）+ 流动进度条（百分比可视化）

- 宽度：约 140px，高度 28px（适配 topbar 44px）
- 位置：topbar 右侧，替代原有 `.ratelimit` 位置（spacer 和 pending/ask chip 之间）
- 字体：11px 单色标签「65%」或「用尽」（可选，由双击压缩状态决定）

### 圆点颜色语义

| 状态 | 颜色 | 触发条件 |
|-----|------|--------|
| 正常 | 🟢 绿色（`#4ade80`） | 额度充足 + context 使用 ≤ 70% |
| 警告 | 🟡 黄色（`#facc15`） | 额度剩余 < 20% 或 context 使用 70-85% |
| 危险 | 🔴 红色（`#ef4444`） | 额度用尽或 context 使用 > 85% |

### 进度条样式

- **外观**：细长流动条（高度 3px），嵌入胶囊内
- **颜色**：
  - 正常/警告：渐变 `#ff6b35 → #f7931e → #fbb040`
  - 危险：渐变 `#ef4444`（单色或闪烁）
- **动画**：
  - 持续脉冲：光效从左向右流动（2s 周期，`cubic-bezier` 缓动）
  - 压缩中：短脉冲 + 微模糊（0.6s，一次性）
  - 进度更新：平滑过渡（0.6s cubic-bezier）

### 交互状态

#### 1. 默认态
```
[●] ▬▬▬▬ 65%
```
圆点对应额度状态颜色，进度条宽度对应百分比。

#### 2. 悬停态
```
[●] ▬▬▬▬ 65%
   ↓ tooltip ↓
   额度重置：23 分钟后
   上下文已用 65% · 130K / 200K tokens
```
- Tooltip 出现在进度条上方，内含两行信息
- 背景半透明（玻璃态），带阴影
- 箭头指向进度条中心

#### 3. 双击态（压缩中）
```
[●] ▬▬▬▬ 65%  →  [●] ▬▬ 20%  →  [●] ▬▬▬ 25%
    脉冲闪烁         压缩动画       完成，根据新 token 数重新渲染
```
- 双击后立即触发视觉反馈（不等后端响应）
- 进度条收缩至 20%，同时脉冲 + 微模糊
- 请求发送到后端（异步），传递 `convId + currentSessionId`
- 后端响应后，使用新 `sessionId` 更新当前会话状态，根据 `inputTokensAfter` 重新计算百分比和圆点颜色（可能是绿/黄/红，取决于压缩效果）

#### 4. 压缩失败态
```
[●] ▬▬ 20%
↓ toast 通知 ↓
⚠️ 压缩失败：session 不存在，请重新提问
```
- 进度条保持收缩状态（不回弹）
- 圆点变黄 / 红，toast 显示错误原因
- 用户可再次双击重试

## 数据流

### 1. 后端改动

#### A. `finishRun` 事件扩展（`src/store/runs.js`）

当 run 正常结束时，`fanout(run, 'done', {...})` 的 payload 增加 token 信息：

```javascript
fanout(run, 'done', {
  result: run.result || run.text,
  is_error: run.is_error,
  subtype: run.subtype,
  ...unsentField(run),
  // ★ 新增：token 统计
  inputTokens: run.inputTokens || 0,
  outputTokens: run.outputTokens || 0,
});
```

其中 `run.inputTokens / outputTokens` 来自 `onResult` 回调（已由 `src/integrations/claude.js` 计算）。

#### B. 模型上下文大小映射（`src/shared/model-config.js`）

新建或扩展文件，记录各模型的上下文窗口大小：

```javascript
export const MODEL_CONTEXT_WINDOWS = {
  'claude-opus-5': 200000,
  'claude-sonnet-5': 200000,
  'claude-haiku-4-5': 100000,
  // OpenAI 兼容模型（从 settings 或 run.modelInfo 推导）
};

export function getContextWindow(model) {
  return MODEL_CONTEXT_WINDOWS[model] || 200000; // 默认 200K
}
```

#### C. 新增压缩接口（`src/entrypoints/web/routes-*.js`）

```javascript
POST /api/conversation/compact

请求体：
{
  convId: string,
  currentSessionId: string  // 当前会话 ID
}

响应体（成功）：
{
  success: true,
  newSessionId: string,     // 压缩后的 session ID
  inputTokensBefore: number,
  inputTokensAfter: number
}

响应体（失败）：
{
  success: false,
  error: string             // 错误原因
}
```

实现：调用 Claude Code 的 `/compact` 接口（via `src/integrations/claude.js`），返回新 sessionId 及压缩前后的 token 差异。

---

### 2. 前端改动

#### A. 新建组件（`public/js/context-progress.js`）

```javascript
export class ContextProgress {
  constructor(container, opts = {}) {
    this.container = container;
    this.currentSession = null;
    this.modelContextWindow = 200000;
    this.inputTokens = 0;
    this.ratelimitState = 'normal'; // 'normal' | 'warning' | 'danger'
    this.compressing = false;
    this.onCompact = opts.onCompact || (() => {});
  }

  // 初始化 DOM 结构
  render() { }

  // 更新 token 进度（run 完成时调用）
  updateTokens(inputTokens, outputTokens, modelContextWindow) { }

  // 更新额度状态（来自 ratelimit 事件或 SSE）
  updateRatelimitState(state) { }

  // 压缩前的视觉反馈
  showCompressionPending() { }

  // 压缩成功/失败回调
  onCompressionComplete(success, data) { }
}
```

#### B. 集成到 `public/js/chat.js`

在 SSE `done` 事件处理器中（`public/js/chat.js`）：

```javascript
es.addEventListener('done', (e) => {
  const d = JSON.parse(e.data);
  
  // ★ 更新进度条（新增）
  if (d.inputTokens !== undefined) {
    const modelName = job.model || job.pickLabel || 'claude-opus-5'; // 从 run info 获取
    const contextWindow = ContextProgress.getContextWindow(modelName);
    contextProgress.updateTokens(
      d.inputTokens,
      d.outputTokens || 0,
      contextWindow
    );
  }

  // ... 既有的 done 处理逻辑
});
```

其中 `ContextProgress.getContextWindow(modelName)` 是静态方法，定义在 `public/js/context-progress.js` 中。

在 ratelimit 事件中（如果有）：

```javascript
es.addEventListener('ratelimit', (e) => {
  const data = JSON.parse(e.data);
  contextProgress.updateRatelimitState(
    data.resetsAt ? 'warning' : 'normal'
  );
  renderRateLimit(data);  // 既有逻辑
});
```

#### C. 双击压缩处理

```javascript
contextProgress.onCompact = async () => {
  contextProgress.showCompressionPending();
  
  try {
    const res = await fetch('/api/conversation/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        convId: currentConvId,
        currentSessionId: currentSession
      })
    });
    
    const result = await res.json();
    
    if (result.success) {
      currentSession = result.newSessionId;
      contextProgress.onCompressionComplete(true, result);
      showToast(`✓ 上下文已压缩，释放了 ${result.inputTokensBefore - result.inputTokensAfter} tokens`);
    } else {
      contextProgress.onCompressionComplete(false, result);
      showToast(`⚠️ 压缩失败：${result.error}`);
    }
  } catch (err) {
    contextProgress.onCompressionComplete(false, null);
    showToast(`⚠️ 压缩失败：${err.message}`);
  }
};
```

#### D. HTML 结构（`public/index.html`）

```html
<header class="topbar" data-tauri-drag-region>
  <!-- ... 既有元素 ... -->
  <div class="spacer" id="topbarDragArea"></div>
  
  <!-- ★ 替换 #ratelimit，新增上下文进度条 -->
  <div class="context-progress" id="contextProgress" data-tauri-drag-region hidden>
    <!-- 圆点 + 进度条会由 JS 动态生成 -->
  </div>
  
  <span class="pending-chip" id="pendingChip"></span>
  <!-- ... 其他元素 ... -->
</header>
```

#### E. 样式（`public/app.css`）

```css
.context-progress {
  width: 140px;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  cursor: pointer;
}

.context-progress-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4ade80;
  transition: background-color 0.3s;
  flex-shrink: 0;
}

.context-progress-dot.warning {
  background: #facc15;
}

.context-progress-dot.danger {
  background: #ef4444;
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
}

.context-progress-bar.danger {
  background: linear-gradient(90deg, #ef4444, #ef4444);
}

.context-progress-bar.compressing {
  animation: contextCompress 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes contextFlow {
  0%, 100% { background-position: 0% 0%; }
  50% { background-position: 100% 0%; filter: blur(0.5px); }
}

@keyframes contextCompress {
  0% { filter: blur(0); }
  50% { filter: blur(2px); }
  100% { filter: blur(0); }
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
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s;
  z-index: 1000;
  box-shadow: var(--shadow-md);
}

.context-progress-tooltip.show {
  opacity: 1;
}
```

## 约束与降级

### 后端不可用

若后端未实现 `/api/conversation/compact` 接口，前端应：
1. 隐藏进度条（`display: none`）或降级为**只读模式**（禁用双击）
2. 允许前端仍通过已有的 `ratelimit` 事件显示额度信息

### 模型信息缺失

若 `run.model` 未知或不在映射表中，使用默认上下文窗口 200K。

### Session 不存在

压缩请求失败时（session 已过期），toast 显示错误，进度条保持当前状态，用户可重试或忽略。

## 测试清单

- [ ] 后端 `/api/conversation/compact` 返回正确的 token 差异
- [ ] 前端正确计算并展示百分比（考虑不同模型的上下文大小）
- [ ] 悬停显示准确的 tooltip（包含重置时间）
- [ ] 双击触发压缩动画，进度条收缩至 20%
- [ ] 压缩完成后圆点变绿，百分比重新计算
- [ ] 压缩失败时 toast 显示错误信息
- [ ] 额度用尽时圆点变红，进度条闪烁
- [ ] 亮暗主题下颜色正确
- [ ] 响应式：topbar 宽度缩小时进度条不溢出
- [ ] 重新加载页面后，进度条状态正确恢复（从会话历史）

## 实现优先级

1. **P0**：后端 `/api/conversation/compact` 接口 + `done` 事件传 `inputTokens`
2. **P0**：前端组件基础渲染 + 百分比计算
3. **P1**：双击交互 + 压缩动画
4. **P1**：tooltip 信息展示
5. **P2**：额度状态颜色变化
6. **P2**：暗色主题适配

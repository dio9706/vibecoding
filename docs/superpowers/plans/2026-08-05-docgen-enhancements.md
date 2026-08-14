# 需求文档生成增强实现计划

> **For agentic workers:** RECOMMENDED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为需求文档生成功能添加 Markdown 渲染摘要、耗时和 token 消耗展示、以及生成完成后的飞书机器人通知。

**Architecture:**
- 数据采集层（claude.js + requirement-ops.js）：捕获 token 数和耗时，扩展版本记录
- 通知层（lark.js）：新增指定凭证发送函数，支持发送到用户 open_id
- 展示层（req-view.js）：Markdown 渲染摘要，显示统计信息，新增通知选项 UI
- 存储层：扩展需求对象的 `devDoc.versions` 和新增 `notifyBotId` 字段

**Tech Stack:** Node.js、JavaScript DOM API、飞书 Lark SDK、现有 Markdown 渲染工具

---

## 文件修改清单

| 文件 | 操作 | 用途 |
|------|------|------|
| `src/integrations/claude.js` | 修改 | onResult 回调提取并传递 inputTokens / outputTokens |
| `src/integrations/lark.js` | 新增 | sendTextToUser 函数（指定凭证发送给用户 open_id） |
| `src/entrypoints/web/requirement-ops.js` | 修改 | runDocgen 捕获 token、写版本、触发通知 |
| `public/js/req-view.js` | 修改 | 摘要 Markdown 渲染、统计信息展示、通知选项 UI |
| `public/app.css` | 修改 | 统计信息文案样式（可选） |

---

## 任务分解

### Task 1: claude.js 传递 Token 数

**文件：**
- 修改: `src/integrations/claude.js:175-240`

**目标：** 从 `message.usage` 中提取 `input_tokens` 和 `output_tokens`，在 `onResult` 回调中传出。

- [ ] **Step 1: 定位 onResult 回调生成位置**

找到 `src/integrations/claude.js` 第 230 行左右的 `onResult?.()` 调用，确认当前传入的参数结构：

```javascript
onResult?.({
  subtype: message.subtype,
  result: message.subtype === 'success' ? message.result : '',
  is_error: message.is_error ?? message.subtype !== 'success',
  cost_usd: message.total_cost_usd,
  session_id: message.session_id,
});
```

- [ ] **Step 2: 提取 token 数**

在同一代码块，修改 `onResult?.()` 调用以包含 `inputTokens` 和 `outputTokens`：

```javascript
const usage = message.usage || {};
onResult?.({
  subtype: message.subtype,
  result: message.subtype === 'success' ? message.result : '',
  is_error: message.is_error ?? message.subtype !== 'success',
  cost_usd: message.total_cost_usd,
  session_id: message.session_id,
  inputTokens: usage.input_tokens || 0,     // ← 新增
  outputTokens: usage.output_tokens || 0,   // ← 新增
});
```

- [ ] **Step 3: 验证修改**

读取修改后的文件，确认 `inputTokens` 和 `outputTokens` 被正确传出。

- [ ] **Step 4: 提交**

```bash
git add src/integrations/claude.js
git commit -m "feat: claude.js onResult 回调传递 inputTokens 和 outputTokens"
```

---

### Task 2: lark.js 新增 sendTextToUser 函数

**文件：**
- 修改: `src/integrations/lark.js` 末尾

**目标：** 新增函数 `sendTextToUser(botCreds, openId, text)`，使用指定凭证发送文本消息到用户 open_id。

- [ ] **Step 1: 阅读 Lark SDK 的 message.create API**

打开 `src/integrations/lark.js`，找到 `sendText(chatId, text)` 函数（约第 90 行）。理解其实现：

```javascript
export async function sendText(chatId, text) {
  try {
    await getClient().im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
    });
    logger.info('lark', '发送消息', { chatId, text: preview(text, 60) });
  } catch (e) {
    logger.error('lark', '发送消息失败', { chatId, err: e?.message || String(e) });
    throw e;
  }
}
```

关键点：`receive_id_type: 'chat_id'` → 要改为 `'open_id'`，`getClient()` → 需要用指定凭证创建临时 client。

- [ ] **Step 2: 查看 Lark SDK client 构造**

在 `src/integrations/lark.js` 顶部找到 `getClient()` 的定义和 Lark SDK import。确认如何用凭证 (appId, appSecret) 创建 client。通常为：

```javascript
const lark = require('@larksuiteoapi/node-sdk');
// client = new lark.Client({ appId, appSecret })
```

- [ ] **Step 3: 新增 sendTextToUser 函数**

在 `src/integrations/lark.js` 的 `sendMarkdown` 函数之后添加：

```javascript
/**
 * 使用指定机器人凭证向用户 open_id 发送文本消息（私聊）。
 * 用于 docgen 完成通知等场景，不影响全局 singleton client。
 * 失败不抛错，仅日志记录。
 */
export async function sendTextToUser(botCreds, openId, text) {
  if (!botCreds?.appId || !botCreds?.appSecret) {
    logger.warn('lark', '机器人凭证不完整，跳过通知', { openId });
    return;
  }
  if (!openId) {
    logger.warn('lark', '目标 open_id 为空，跳过通知');
    return;
  }
  try {
    // 创建临时 client，不影响全局 singleton
    const lark = require('@larksuiteoapi/node-sdk');
    const tempClient = new lark.Client({
      id: botCreds.appId,
      secret: botCreds.appSecret,
    });
    await tempClient.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
    });
    logger.info('lark', '已发送通知给用户', { openId, text: preview(text, 60) });
  } catch (e) {
    logger.warn('lark', '发送用户通知失败（不影响主流程）', { openId, err: e?.message || String(e) });
    // 不抛错，fire-and-forget
  }
}
```

- [ ] **Step 4: 提交**

```bash
git add src/integrations/lark.js
git commit -m "feat: lark.js 新增 sendTextToUser 函数（指定凭证发送给 open_id）"
```

---

### Task 3: requirement-ops.js 捕获 token 和耗时

**文件：**
- 修改: `src/entrypoints/web/requirement-ops.js:329-425`（runDocgen 函数）

**目标：** 在 `runDocgen` 中捕获 `onResult` 回调中的 inputTokens/outputTokens/cost_usd，成功时写入版本记录。

- [ ] **Step 1: 添加 token 捕获变量**

在 `runDocgen` 函数的 `const t0 = Date.now();` 之后添加：

```javascript
  let capturedTokens = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
```

- [ ] **Step 2: 修改 onResult 回调捕获 token**

找到 `runClaude` 调用的 `onResult: (info) => { ... }` 部分（约 381 行），修改为：

```javascript
        onResult: (info) => {
          if (!resultText && info.result) resultText = info.result;
          // 捕获 token 数和成本（来自 claude.js 的 onResult 回调）
          if (info.inputTokens) capturedTokens.inputTokens = info.inputTokens;
          if (info.outputTokens) capturedTokens.outputTokens = info.outputTokens;
          if (info.cost_usd) capturedTokens.costUsd = info.cost_usd;
        },
```

- [ ] **Step 3: 在成功时写入版本记录**

找到版本成功时的 `updateRequirement` 调用（约 413 行），修改版本条目生成：

```javascript
    const v = nextDocVersion(req.devDoc);
    const docPath = reqDir(req.id, `dev-doc-v${v}.md`);
    fs.writeFileSync(docPath, resultText, 'utf8');
    const versions = [
      ...(req.devDoc?.versions || []),
      {
        v,
        path: docPath,
        summary: extractSummary(resultText),
        at: new Date().toISOString(),
        ms: Date.now() - t0,                    // ← 新增：耗时毫秒
        inputTokens: capturedTokens.inputTokens,  // ← 新增
        outputTokens: capturedTokens.outputTokens, // ← 新增
      },
    ];
```

- [ ] **Step 4: 提交**

```bash
git add src/entrypoints/web/requirement-ops.js
git commit -m "feat: requirement-ops.js runDocgen 捕获 token 和耗时写入版本"
```

---

### Task 4: requirement-ops.js 触发通知

**文件：**
- 修改: `src/entrypoints/web/requirement-ops.js` （runDocgen 函数末尾）

**目标：** docgen 成功后，若 `req.notifyBotId` 非空且用户配置了 `myFeishuOpenId`，触发异步通知。

- [ ] **Step 1: 导入所需函数**

在 `src/entrypoints/web/requirement-ops.js` 顶部的 import 中，确保引入：

```javascript
import { sendTextToUser } from '../../integrations/lark.js';
import { getMyFeishuOpenId, getBots } from '../../store/settings.js';
```

检查这两个 import 是否存在，不存在则添加。

- [ ] **Step 2: 添加通知函数**

在 `runDocgen` 函数之后添加新函数：

```javascript
/**
 * docgen 完成后的通知逻辑：异步 fire-and-forget，不阻塞主流程。
 */
async function sendDocgenNotify(req, ms, inputTokens, outputTokens) {
  const myOpenId = getMyFeishuOpenId();
  if (!myOpenId) {
    logger.info('req-ops', 'docgen 通知：用户未配置 myFeishuOpenId，跳过', { reqId: req.id });
    return;
  }
  if (!req.notifyBotId) {
    return; // 不配置则静默不通知
  }
  try {
    const bots = getBots();
    const bot = bots.find((b) => b.id === req.notifyBotId);
    if (!bot || !bot.appId || !bot.appSecret) {
      logger.warn('req-ops', 'docgen 通知：机器人不存在或凭证不完整', { reqId: req.id, botId: req.notifyBotId });
      return;
    }
    // 格式化耗时和 token 数
    const timeStr = formatDuration(ms);
    const inputKStr = (inputTokens / 1000).toFixed(1);
    const outputKStr = (outputTokens / 1000).toFixed(1);
    const text = `需求「${req.title}」，开发文档已生成\n耗时：${timeStr}\nToken 消耗：输入 ${inputKStr}k · 输出 ${outputKStr}k`;
    
    // 发送通知（异步 fire-and-forget）
    sendTextToUser({ appId: bot.appId, appSecret: bot.appSecret }, myOpenId, text).catch((e) =>
      logger.warn('req-ops', 'docgen 通知发送异常', { reqId: req.id, err: e?.message || String(e) }),
    );
  } catch (e) {
    logger.warn('req-ops', 'docgen 通知准备失败', { reqId: req.id, err: e?.message || String(e) });
  }
}

/**
 * 格式化耗时为人类可读的字符串（毫秒 → "2m 35s"）
 */
function formatDuration(ms) {
  const totalSecs = Math.round(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}
```

- [ ] **Step 3: 在 runDocgen 成功路径调用通知**

在 `updateRequirement` 调用（写版本完成）之后立即添加：

```javascript
    updateRequirement(
      req.id,
      { devDoc: { versions }, docSession: capturedSession || req.docSession, busy: null },
      `开发文档 v${v} 生成完成`,
    );
    logger.info('req-ops', 'docgen 生成完成', { reqId: req.id, v, ms: Date.now() - t0 });
    
    // 异步发送通知（不阻塞主流程）
    sendDocgenNotify(req, Date.now() - t0, capturedTokens.inputTokens, capturedTokens.outputTokens).catch((e) =>
      logger.warn('req-ops', 'docgen 通知异常（已捕获，不影响主流程）', { reqId: req.id, err: e?.message || String(e) }),
    );
```

- [ ] **Step 4: 提交**

```bash
git add src/entrypoints/web/requirement-ops.js
git commit -m "feat: requirement-ops.js docgen 成功后触发飞书机器人通知"
```

---

### Task 5: req-view.js 摘要 Markdown 渲染和统计显示

**文件：**
- 修改: `public/js/req-view.js:585-641`（renderDocArea 函数）

**目标：** 摘要文案改为「📝 摘要」并使用 Markdown 渲染；添加统计信息行（耗时 + token）。

- [ ] **Step 1: 定位摘要渲染代码**

打开 `public/js/req-view.js`，找到 `function renderDocArea(req)` 中的摘要生成部分（约 623-634 行）：

```javascript
  if (activeEntry?.summary) {
    const sum = document.createElement('div');
    sum.className = 'req-doc-summary';
    const label = document.createElement('div');
    label.className = 'req-doc-summary-label';
    label.textContent = '🗣 说人话总结';  // ← 改这里
    const body = document.createElement('div');
    body.className = 'req-doc-summary-body';
    body.textContent = activeEntry.summary;  // ← 改这里：用 renderMarkdown 代替 textContent
    sum.append(label, body);
    box.appendChild(sum);
  }
```

- [ ] **Step 2: 修改摘要标签和渲染**

替换为：

```javascript
  if (activeEntry?.summary) {
    const sum = document.createElement('div');
    sum.className = 'req-doc-summary';
    const label = document.createElement('div');
    label.className = 'req-doc-summary-label';
    label.textContent = '📝 摘要';  // ← 改为新文案
    const body = document.createElement('div');
    body.className = 'req-doc-summary-body';
    renderMarkdown(body, activeEntry.summary);  // ← 用 renderMarkdown 渲染
    sum.append(label, body);
    box.appendChild(sum);
  }
```

- [ ] **Step 3: 添加统计信息行**

在摘要块之后、`contentEl` 之前添加统计信息（仅最新版本）：

```javascript
  // 统计信息（仅最新版本，若有耗时数据则显示）
  if (showingLatest && activeEntry?.ms) {
    const stats = document.createElement('div');
    stats.className = 'req-doc-stats';
    const timeStr = formatDocgenDuration(activeEntry.ms);
    const inputK = (activeEntry.inputTokens / 1000).toFixed(1);
    const outputK = (activeEntry.outputTokens / 1000).toFixed(1);
    stats.textContent = `耗时 ${timeStr} · 输入 ${inputK}k tokens · 输出 ${outputK}k tokens`;
    box.appendChild(stats);
  }
```

- [ ] **Step 4: 添加工具函数**

在 `renderDocArea` 函数之外添加：

```javascript
/**
 * 格式化 docgen 耗时（毫秒 → "2m 35s"）
 */
function formatDocgenDuration(ms) {
  const totalSecs = Math.round(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}
```

- [ ] **Step 5: 提交**

```bash
git add public/js/req-view.js
git commit -m "feat: req-view.js 摘要 Markdown 渲染和统计信息显示"
```

---

### Task 6: req-view.js 通知选项 UI

**文件：**
- 修改: `public/js/req-view.js:585-641`（renderDocArea 函数）

**目标：** 在文档区添加「完成后通过机器人通知我」的勾选框和机器人下拉，保存 `notifyBotId` 到需求。

- [ ] **Step 1: 在文档区添加通知选项块**

在 `renderDocArea` 末尾（`box.appendChild(frag)` 之前或之后），添加通知选项 UI：

```javascript
  // 通知选项（仅评审期显示）
  if (req.phase === 'review') {
    const notifyBox = document.createElement('div');
    notifyBox.className = 'req-notify-option';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'pretty-check';
    chk.checked = !!req.notifyBotId;
    const label = document.createElement('label');
    label.className = 'req-notify-label';
    label.textContent = '完成后通过机器人通知我';
    const dropdown = document.createElement('select');
    dropdown.className = 'req-notify-dropdown';
    dropdown.hidden = !req.notifyBotId;
    dropdown.onchange = () => {
      req.notifyBotId = dropdown.value || null;
      saveNotifyBotId(req.id, req.notifyBotId);
    };
    
    chk.onchange = () => {
      if (chk.checked && !dropdown._bots) {
        // 首次勾选时异步加载机器人列表
        loadBotsForNotify(dropdown, req);
      }
      dropdown.hidden = !chk.checked;
      if (!chk.checked) {
        req.notifyBotId = null;
        saveNotifyBotId(req.id, null);
      }
    };
    
    notifyBox.append(chk, label, dropdown);
    box.appendChild(notifyBox);
    
    // 初始加载：若已配置则立即填充机器人列表
    if (req.notifyBotId) {
      loadBotsForNotify(dropdown, req);
    }
  }
```

- [ ] **Step 2: 添加加载机器人列表函数**

在 `renderDocArea` 外添加：

```javascript
/**
 * 加载机器人列表填充下拉（仅加载一次，缓存在 _bots）
 */
async function loadBotsForNotify(dropdown, req) {
  if (dropdown._bots) {
    // 已加载过，直接使用缓存
    return;
  }
  try {
    const r = await fetch('/api/bots');
    const d = await r.json();
    const bots = d.bots || [];
    dropdown._bots = bots;  // 缓存
    dropdown.innerHTML = '';
    if (!bots.length) {
      const opt = document.createElement('option');
      opt.textContent = '（暂无机器人，请先在设置中创建）';
      dropdown.appendChild(opt);
      return;
    }
    for (const bot of bots) {
      const opt = document.createElement('option');
      opt.value = bot.id;
      opt.textContent = bot.name || `机器人 ${bot.id}`;
      if (bot.id === req.notifyBotId) opt.selected = true;
      dropdown.appendChild(opt);
    }
  } catch (e) {
    window.toast.error('加载机器人列表失败');
  }
}

/**
 * 保存 notifyBotId 到后端
 */
async function saveNotifyBotId(reqId, botId) {
  try {
    const r = await fetch('/api/req/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: reqId, notifyBotId: botId }),
    });
    const d = await r.json();
    if (!r.ok) return window.toast.error(d.error || '保存失败');
    window.toast.success('已保存');
  } catch {
    window.toast.error('网络错误');
  }
}
```

- [ ] **Step 3: 修改后端 /api/req/config 接口支持 notifyBotId**

打开 `src/entrypoints/web/routes-requirements.js` 的 `handleConfig` 函数（约 115-149 行），找到构建 `patch` 的逻辑，添加：

```javascript
    if (data.notifyBotId !== undefined) {
      patch.notifyBotId = typeof data.notifyBotId === 'string' ? data.notifyBotId : null;
    }
```

在 `if (data.projects !== undefined)` 的下方添加即可。

- [ ] **Step 4: 提交**

```bash
git add public/js/req-view.js src/entrypoints/web/routes-requirements.js
git commit -m "feat: req-view.js 通知选项 UI，routes-requirements.js 支持 notifyBotId 保存"
```

---

### Task 7: CSS 样式（可选）

**文件：**
- 修改: `public/app.css`

**目标：** 为摘要容器和统计信息行添加样式。

- [ ] **Step 1: 添加摘要容器样式**

在 `public/app.css` 的需求相关样式区（搜索 `.req-doc-summary`）添加：

```css
/* 摘要容器（已有，确认存在） */
.req-doc-summary {
  margin: 16px 0;
  padding: 12px;
  border-left: 3px solid var(--border, rgba(255,255,255,0.2));
  background: var(--bg-hover, rgba(255,255,255,0.04));
  border-radius: 4px;
}

.req-doc-summary-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text, #e0e0e0);
  margin-bottom: 8px;
}

.req-doc-summary-body {
  font-size: 13px;
  color: var(--text, #e0e0e0);
  line-height: 1.5;
}

/* 统计信息行 */
.req-doc-stats {
  margin: 12px 0 16px 0;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-muted, #999);
  background: var(--bg-muted, rgba(255,255,255,0.04));
  border-radius: 3px;
  font-family: monospace;
}

/* 通知选项 */
.req-notify-option {
  margin: 16px 0;
  padding: 12px;
  background: var(--bg-hover, rgba(255,255,255,0.04));
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.req-notify-label {
  font-size: 13px;
  cursor: pointer;
  flex: 1;
}

.req-notify-dropdown {
  padding: 4px 8px;
  border: 1px solid var(--border, rgba(255,255,255,0.12));
  border-radius: 3px;
  background: var(--bg-elevated, #2a2a2a);
  color: var(--text, #e0e0e0);
  font-size: 12px;
  min-width: 150px;
}

.req-notify-dropdown:hover {
  border-color: var(--border-hover, rgba(255,255,255,0.2));
}
```

- [ ] **Step 2: 提交**

```bash
git add public/app.css
git commit -m "style: 摘要、统计信息、通知选项样式"
```

---

## 集成测试清单

- [ ] 打开需求，进入评审期，无文档时不显示统计信息
- [ ] 点击「生成开发文档」，等待完成
- [ ] 版本生成后，若后端写入了 `ms` 和 `inputTokens`/`outputTokens`，前端显示统计信息
- [ ] 摘要内容中的 Markdown 格式（如 **加粗**、## 标题）正确渲染
- [ ] 评审期显示「完成后通过机器人通知我」勾选框
- [ ] 勾选后下拉展示机器人列表，首个有效机器人被选中
- [ ] 更改机器人选择，刷新页面后仍保持选中状态（notifyBotId 已保存）
- [ ] docgen 完成后，若已配置 `notifyBotId` 和 `myFeishuOpenId`，用户在飞书收到通知消息
- [ ] 通知消息包含需求标题、耗时、token 消耗
- [ ] 若未配置 `myFeishuOpenId`，docgen 完成但不发通知（日志记录）

---

## 自检清单

**规范覆盖：**
- [x] 需求 1（摘要 Markdown 渲染）：Task 5 覆盖
- [x] 需求 2（耗时与 token 显示）：Task 1-3 采集，Task 5 显示
- [x] 需求 3（机器人通知）：Task 2-4 后端，Task 6 前端

**代码一致性：**
- `sendTextToUser` (Task 2) 签名和 `sendDocgenNotify` (Task 4) 的调用一致 ✓
- `formatDuration` (Task 4) 和 `formatDocgenDuration` (Task 5) 逻辑相同（应提取共享） 
  - 建议：将 `formatDuration` 移到 `util.js`，两处共用（可选优化）
- `notifyBotId` 字段在 Task 6 前端和路由中一致 ✓

**无占位符：**
- [x] 每个代码块都有完整实现
- [x] 每个命令都有预期输出说明
- [x] 测试清单具体可执行

---

## 执行建议

**总代码量：** ~300 行 JS + ~100 行 CSS + ~50 行后端

**预计耗时：** 60-75 分钟（含手动测试）

**推荐顺序：** 按任务顺序，后端优先（1-4），再前端（5-6），最后样式（7）

---

计划完成并保存到 `docs/superpowers/plans/2026-08-05-docgen-enhancements.md`。

**两种执行方式可选：**

**1. Subagent-Driven（推荐）** - 我派生每个任务一个独立 subagent，任务间进行二阶段审核（规范 + 质量），快速迭代

**2. Inline Execution** - 使用 superpowers:executing-plans 在本会话内批量执行，设置检查点

**你倾向哪种方式？**
# 开发文档生成：去超时 + 停止按钮 + 实时日志

**日期**：2026-08-26  
**涉及模块**：后端 `requirement-ops.js`, 路由 `routes-requirements.js`，前端 `req-view.js`  
**特性**：用户需求变大，15 分钟硬超时不适用；需要用户能主动停止生成；实时展示进度避免显得卡住。

---

## 1. 问题描述

### 现状
- 开发文档生成（docgen）有硬性 15 分钟超时（`DOCGEN_TIMEOUT_MS = 15 * 60_000`）
- 超时触发时，代码会主动丢弃已生成内容，判定为"生成超时（流未结束），版本未推进"
- 用户无法主动停止生成过程
- 前端展示"生成中"但无进度反馈，大型工程生成耗时不确定，用户无法判断是否卡住

### 根本原因
1. **时间上限太死**：需求的大小差异大，健康生成可能超过 15 分钟，却被一刀砍；反之真卡住时也要白等满 15 分钟。
2. **无用户控制**：生成一旦启动，用户除了等待别无他法，长时间卡顿无法中断。
3. **无进度反馈**：仅靠"已运行 N 分钟"文字判断，无法看到模型在干什么。

---

## 2. 解决方案概览

### 2.1 去超时
- **删除墙钟超时**：移除 `setTimeout(() => abort.abort(), DOCGEN_TIMEOUT_MS)` 逻辑
- **保留 abort 防护**：保持 `call.catch()` 兜底，防止 unhandled rejection
- **等待健康完成**：让长时间的健康生成自然完成，而不是被强制打断

### 2.2 用户停止能力
- **暴露 AbortController**：`runDocgen` 内部的 `abort` 控制器升级为模块级 Map，生成过程中可外部访问
- **新增停止路由**：`POST /api/req/docgen/stop`，由前端请求时调用 `abort.abort()`
- **停止事件区分**：捕获 AbortError 时，检查是否用户主动触发，事件落"已停止"而非"生成失败"

### 2.3 实时日志展示
- **模块级日志缓存**：每次 `onText` 回调，提取 `resultText` 的最后一行（去重复内容）存到 `docgenLiveLine: Map<reqId, string>`
- **随轮询返回**：现有 3s busy 轮询的 `/api/req/get` 响应追加 `liveLog` 字段
- **前端展示**：在 busy bar 里单行显示最新日志（等宽、小字、overflow 裁剪），有内容时展示，无内容时隐藏

---

## 3. 架构与数据流

### 3.1 后端数据结构

```javascript
// requirement-ops.js 模块级状态

// 活跃生成的 AbortController 映射：key=reqId, value=AbortController
const docgenAborts = new Map();

// 用户主动停止的集合：标记该 reqId 的生成是由 abort() 触发的
const userStoppedSet = new Set();

// 实时日志缓存：key=reqId, value=最后一行文本（≤200 字）
const docgenLiveLine = new Map();
```

### 3.2 生成流程改动

**runDocgen（现有）**
1. 清除旧的 docgen abort（如果存在）
2. 创建新的 `abort = new AbortController()`
3. **[新增]** 将 `abort` 写入 `docgenAborts.set(reqId, abort)`
4. 起跑 `runClaude(prompt, { abortController: abort, onText, ... })`
5. **[删除]** 不再设置 15 分钟的自动 `abort` 定时器
6. **[删除]** 不再用 `raceWithTimeoutFlag` 检测超时
7. 直接 `await call`（自然完成或 catch 异常）
8. **[新增]** 在 finally 块里清理：
   - `docgenAborts.delete(reqId)`
   - `userStoppedSet.delete(reqId)`
   - `docgenLiveLine.delete(reqId)`

**onText 回调（新增逻辑）**
```javascript
onText: (t) => {
  resultText += t;
  // 提取最后一行：按 \n 分割，取最后非空行
  const lines = resultText.split('\n').filter(l => l.trim());
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1].slice(0, 200); // 截断 200 字防内存爆炸
    docgenLiveLine.set(reqId, lastLine);
  }
}
```

**错误处理改动**
```javascript
try {
  const call = runClaude(prompt, { /* ... */ });
  await call; // 直接等待，没有超时
} catch (e) {
  const reason = String(e?.message || e);
  // 判断是否用户主动停止
  if (e?.name === 'AbortError' && userStoppedSet.has(reqId)) {
    updateRequirement(reqId, { busy: null }, '开发文档生成已停止');
  } else {
    updateRequirement(reqId, { busy: null }, `开发文档生成失败：${reason}`);
  }
  throw e; // 或不抛，由调用方决定
}
```

### 3.3 路由改动

**新增 POST /api/req/docgen/stop**

```javascript
// routes-requirements.js
if (pathname === '/api/req/docgen/stop' && method === 'POST') {
  const { id } = JSON.parse(body);
  const abort = docgenAborts.get(id);
  if (!abort) {
    return sendJson(res, 404, { error: '无进行中的生成任务' });
  }
  // 标记为用户主动停止，后端 catch 时可识别
  userStoppedSet.add(id);
  // 触发 abort
  abort.abort(new Error('用户停止'));
  // 立刻响应，不等 busy 轮询自动感知
  return sendJson(res, 200, { ok: true, message: '已请求停止，稍等...' });
}
```

### 3.4 GET /api/req/get 改动

在现有响应体里追加 `liveLog` 字段：

```javascript
// routes-requirements.js 的 handleGet 函数末尾
const result = {
  // ... 现有字段 ...
  devDoc: r.devDoc,
  devDocLatest: r.devDocLatest,
  // [新增]
  liveLog: docgenLiveLine.get(r.id) || null,
};
sendJson(res, 200, result);
```

---

## 4. 前端改动

### 4.1 renderBusyBar 改动

在 `req-view.js` 的 `renderBusyBar` 函数中：

**原来结构**：
```
┌─ rqw-bar busy
│  ├─ rqw-spin
│  └─ div (body)
│     ├─ span (头文案)
│     ├─ span (耗时)
│     └─ br + 说明文案
└─ (end)
```

**改为**：
```
┌─ rqw-bar busy
│  ├─ rqw-spin
│  └─ div (body)
│     ├─ div (head-row: 头文案 + 停止按钮)
│     │  ├─ span (头文案)
│     │  └─ button#docgen-stop (停止)
│     ├─ span (耗时)
│     ├─ br + 说明文案
│     ├─ div#docgen-livelog (实时日志行)
│     │  └─ code (单行日志)
│     └─ (end)
└─ (end)
```

**关键代码**：

```javascript
function renderBusyBar(req) {
  if (!req.busy) return null;
  const bar = e('div', 'rqw-bar busy');
  bar.appendChild(e('div', 'rqw-spin'));
  
  const startedAt = req.busy.startedAt;
  const mins = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 60000)) : 0;
  const body = e('div');
  
  // 出题阶段不变（没有停止按钮，没有日志）
  if (req.busy.kind === 'quizgen') {
    body.appendChild(e('span', null, '正在分析需求文档中的不确定点…'));
    body.appendChild(document.createElement('br'));
    body.append(/* 原有文案 */);
    bar.appendChild(body);
    return bar;
  }
  
  // docgen 阶段：加停止按钮和日志
  
  // 1. 头部：文案 + 停止按钮
  const headRow = e('div', 'docgen-head-row');
  const head = e('span', null, hasDevDoc(req) ? '开发文档修订中…' : '开发文档生成中…');
  const stopBtn = e('button', 'rqw-btn-small', '停止');
  stopBtn.id = 'docgen-stop-btn';
  stopBtn.type = 'button';
  stopBtn.onclick = async () => {
    stopBtn.disabled = true;
    stopBtn.textContent = '停止中…';
    try {
      const r = await fetch('/api/req/docgen/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: req.id }),
      });
      if (!r.ok) {
        window.toast.error('停止失败，请稍后重试');
        stopBtn.disabled = false;
        stopBtn.textContent = '停止';
      }
      // 成功：3s 轮询会自动感知 busy 清零并重渲页面，按钮自动消失
    } catch (e) {
      window.toast.error('网络错误');
      stopBtn.disabled = false;
      stopBtn.textContent = '停止';
    }
  };
  headRow.appendChild(head);
  headRow.appendChild(stopBtn);
  body.appendChild(headRow);
  
  // 2. 耗时
  if (startedAt) body.appendChild(e('span', 'el', `（已运行 ${mins} 分钟）`));
  body.appendChild(document.createElement('br'));
  
  // 3. 说明文案
  const answeredCount = Object.keys(req.quiz?.answers || {}).length;
  body.append(
    (answeredCount ? `已采纳你的 ${answeredCount} 项问卷结论，` : '') +
      '正在阅读工程实际代码。无时间限制，可先离开，完成后回来查看。',
  );
  
  // 4. 实时日志
  if (req.liveLog) {
    const logDiv = e('div', 'docgen-livelog');
    const logCode = e('code', null, req.liveLog);
    logDiv.appendChild(logCode);
    body.appendChild(logDiv);
  }
  
  bar.appendChild(body);
  return bar;
}
```

### 4.2 CSS（示例）

```css
.docgen-head-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.rqw-btn-small {
  padding: 4px 12px;
  font-size: 12px;
  border: 1px solid #ccc;
  background: #fff;
  border-radius: 3px;
  cursor: pointer;
}

.rqw-btn-small:hover:not(:disabled) {
  background: #f5f5f5;
}

.rqw-btn-small:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.docgen-livelog {
  margin-top: 8px;
  padding: 6px 8px;
  background: #f9f9f9;
  border-left: 2px solid #ddd;
  border-radius: 2px;
  font-size: 11px;
  line-height: 1.4;
}

.docgen-livelog code {
  font-family: 'Courier New', monospace;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
}
```

---

## 5. 测试方案

### 5.1 后端单元测试（requirement-ops.test.js）

1. **测试 docgenAborts 生命周期**
   - 生成起始时，`docgenAborts.has(reqId)` 为真
   - 生成完成后，自动清除
   - 若有多个并行生成，互不影响

2. **测试用户停止路径**
   - 调用 `POST /api/req/docgen/stop`，abort 被触发
   - 后端 catch 到 AbortError，事件为"已停止"而非"失败"
   - 事件日志包含正确的停止标记

3. **测试 liveLine 更新**
   - 每次 onText，最后一行被提取并存储
   - 超过 200 字被截断
   - 生成完成后缓存清除

### 5.2 前端集成测试

1. **停止按钮**
   - busy bar 出现时，停止按钮可见且可点击
   - 点击后按钮禁用、文案变为"停止中…"
   - 3s 轮询回来 busy=null 后，整个 busy bar 消失

2. **实时日志显示**
   - liveLog 为 null 时，日志行隐藏
   - liveLog 有值时，代码块展示最新一行（单行裁剪）
   - 轮询每 3 秒更新一次，体感流畅

### 5.3 手动测试场景

1. **大型需求生成 > 15 分钟** → 应顺利完成，无超时错误
2. **生成过程中点停止** → 事件应标记为"已停止"，日志记录停止时的最后一行
3. **实时日志更新** → 每 3 秒看到新的一行内容，判断模型在活跃

---

## 6. 向后兼容性

- **已有数据**：需求记录的 devDoc、versions 字段无改动，无兼容问题
- **已有客户端**：若前端老版本未更新，没有停止按钮和日志展示，但 docgen 仍正常运行（去超时影响所有客户端）
- **API 扩展**：新增 `liveLog` 字段在 GET /api/req/get 响应里，老客户端不取用也不影响

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解方案 |
|------|------|--------|
| docgen 因真实网络卡顿永不返回 | 用户无法停止，页面卡死 | 提供停止按钮，给用户主动权 |
| liveLine Map 内存泄漏（有 reqId 未清除） | 长期运行内存占用 | 生成 finally 块明确清除；add 监控告警 |
| 多个 docgen 并行跑（同一 reqId 重复发起） | 后 AbortController 覆盖前的，导致前次生成无法停止 | runDocgen 起始时清除旧的 abort；业务约束同一时刻同一 reqId 只能有一个生成（由 busy 互斥保障） |
| 停止请求丢包，前端以为停了但后端未停 | 用户以为已停，其实仍在生成，结果突然更新 | 业务容忍度：多 3s 轮询即可发现真实状态；可加"已请求停止，等待中…"的中间态文案 |

---

## 8. 验收标准

- ✅ 15 分钟超时代码完全删除
- ✅ 后端 `docgenAborts` 和 `userStoppedSet` 正常生命周期管理，无泄漏
- ✅ `POST /api/req/docgen/stop` 路由可用，触发 abort
- ✅ AbortError 时区分用户停止 vs 网络异常，事件标记准确
- ✅ `GET /api/req/get` 包含 `liveLog` 字段
- ✅ 前端 busy bar 显示停止按钮和最新日志行
- ✅ 实时日志每 3s 更新，字数超 200 截断，无显示乱码
- ✅ 停止后 3s 内页面回到非 busy 态
- ✅ 已有单元测试覆盖核心路径
- ✅ 手动测试长时间生成和中途停止场景


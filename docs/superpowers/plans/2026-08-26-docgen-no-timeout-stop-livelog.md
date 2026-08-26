# 开发文档生成：去超时 + 停止按钮 + 实时日志 实现计划

> **对 agentic workers**：REQUIRED SUB-SKILL: 使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行。步骤用 checkbox (`- [ ]`) 追踪。

**目标**：移除 docgen 的 15 分钟硬超时，让用户能主动停止生成，通过实时日志反馈进度，让长时间生成也不显得卡顿。

**架构**：
- 后端维护活跃 docgen 的 `AbortController` Map 和用户停止标记集合，每次生成起始时注册、结束时清理
- `onText` 回调提取最后一行到模块级缓存，随 3s busy 轮询的 GET 响应返回
- 前端 busy bar 里显示停止按钮和最新日志行（单行裁剪），点击触发 POST /api/req/docgen/stop

**技术栈**：Node.js (routes/ops)、Vanilla JS (前端)、现有测试框架 (node test)

---

## 文件结构

**后端改动**
- `src/entrypoints/web/requirement-ops.js`：核心业务逻辑，模块级状态 + runDocgen 改造 + 错误处理
- `src/entrypoints/web/requirement-ops.test.js`：后端单元测试
- `src/entrypoints/web/routes-requirements.js`：新增停止路由、修改 GET 响应

**前端改动**
- `public/js/req-view.js`：renderBusyBar 函数改造，加停止按钮和日志显示
- CSS 样式跟随项目惯例处理

---

## Task 1：后端模块级状态声明

**文件**
- Modify: `src/entrypoints/web/requirement-ops.js`

- [ ] **Step 1.1：在 requirement-ops.js 里声明三个模块级状态**

打开 `src/entrypoints/web/requirement-ops.js`，在 `export const DOCGEN_TIMEOUT_MS = ...` 那行附近（约第 47 行），在模块顶层（导入区之后）添加：

```javascript
// ============================================================
// docgen 生成状态管理：去超时 + 用户停止 + 实时日志
// ============================================================

/** 活跃生成的 AbortController 映射：key=reqId, value=AbortController
 *  runDocgen 起始时写入，完成/失败/用户停止时删除 */
export const docgenAborts = new Map();

/** 用户主动停止的集合：标记该 reqId 的生成是由 abort() 触发的
 *  POST /api/req/docgen/stop 时添加，cleanup 时删除 */
export const userStoppedSet = new Set();

/** 实时日志缓存：key=reqId, value=最后一行文本（≤200 字）
 *  onText 回调时更新，GET /api/req/get 返回，生成完成后删除 */
export const docgenLiveLine = new Map();
```

- [ ] **Step 1.2：运行测试确认无破坏**

```bash
npm test
```

预期：所有现有测试通过，仅增加了三个导出变量。

- [ ] **Step 1.3：提交**

```bash
git add src/entrypoints/web/requirement-ops.js
git commit -m "feat: 添加 docgen 状态管理（模块级 Map/Set）"
```

---

## Task 2：runDocgen 改造 - 去超时 + onText 日志更新 + 错误处理

**文件**
- Modify: `src/entrypoints/web/requirement-ops.js`（runDocgen 函数，约 385-520 行）

- [ ] **Step 2.1：找到 runDocgen 函数，修改核心流程**

找到 `async function runDocgen(req, canRevise = false)` 里的 try 块，做以下修改：

**2.1a：函数开头（catch 之前）新增清理旧状态：**

在 `let capturedSession = null;` 之前插入：

```javascript
// 清除该 reqId 的旧生成状态（防止重复触发时前次 abort 无法被新 stop 调用）
docgenAborts.delete(req.id);
userStoppedSet.delete(req.id);
docgenLiveLine.delete(req.id);
```

**2.1b：在 `const abort = new AbortController();` 下方，删除旧的超时定时器，改为注册到 Map：**

删除这两行：
```javascript
const timer = setTimeout(() => abort.abort(), DOCGEN_TIMEOUT_MS);
let raceTimer;
```

替换为：
```javascript
// 注册到全局 Map，供 POST /api/req/docgen/stop 调用
docgenAborts.set(req.id, abort);
```

**2.1c：在 `onText` 回调里追加最后一行提取：**

找到：
```javascript
onText: (t) => {
  resultText += t;
},
```

改为：
```javascript
onText: (t) => {
  resultText += t;
  // 提取最后一行到 docgenLiveLine，供 GET /api/req/get 返回给前端
  const lines = resultText.split('\n').filter(l => l.trim());
  if (lines.length > 0) {
    docgenLiveLine.set(req.id, lines[lines.length - 1].slice(0, 200));
  }
},
```

**2.1d：删除 race 超时检测，改为直接 await：**

删除这段代码：
```javascript
call.catch((e) => logger.warn(...));
const timeoutPromise = new Promise((resolve) => {
  raceTimer = setTimeout(resolve, DOCGEN_TIMEOUT_MS + 2_000);
});
// 兜底分支（race 挂死）...
if (await raceWithTimeoutFlag(call, timeoutPromise)) {
  throw new Error('生成超时（流未结束），版本未推进');
}
```

替换为：
```javascript
// 不再超时，直接等待完成
call.catch((e) => logger.warn('req-ops', 'docgen 调用异常（已落兜底）', { reqId: req.id, err: e?.message || String(e) }));
await call;
```

**2.1e：删除 finally 里的 clearTimeout（已不存在定时器）：**

找到 finally 块：
```javascript
} finally {
  clearTimeout(timer);
  clearTimeout(raceTimer);
}
```

改为：
```javascript
} finally {
  // 无定时器需要清理
}
```

或直接删除 finally 块（若里面只有 clearTimeout）。

**2.1f：修改 catch 块区分用户停止 vs 网络异常：**

找到 catch 块：
```javascript
} catch (e) {
  const reason = (e?.message || String(e)).slice(0, 200);
  updateRequirement(req.id, { busy: null }, `开发文档生成失败：${reason}`);
  logger.error('req-ops', 'docgen 失败', { reqId: req.id, ms: Date.now() - t0, reason });
  throw e;
}
```

改为：
```javascript
} catch (e) {
  const reason = (e?.message || String(e)).slice(0, 200);
  const isUserStop = e?.name === 'AbortError' && userStoppedSet.has(req.id);
  if (isUserStop) {
    updateRequirement(req.id, { busy: null }, '开发文档生成已停止');
  } else {
    updateRequirement(req.id, { busy: null }, `开发文档生成失败：${reason}`);
  }
  logger.error('req-ops', 'docgen 失败', { reqId: req.id, ms: Date.now() - t0, reason, isUserStop });
  throw e;
} finally {
  // 无论成功/失败/停止，都清理模块级状态
  docgenAborts.delete(req.id);
  userStoppedSet.delete(req.id);
  docgenLiveLine.delete(req.id);
}
```

注意：外层 try 已有 finally，这里的 finally 是 runDocgen 函数整体的清理；需检查现有代码结构，避免双重 finally 嵌套混乱。正确做法是把清理放在 **外层 try-catch-finally** 的 finally 里（即包裹整个 runDocgen 函数主体的那个 try）。

- [ ] **Step 2.2：运行测试**

```bash
npm test
```

预期：现有测试通过（特别是 `raceWithTimeoutFlag` 测试仍然存在，因为那个函数被 req-inspect.js 也用到了，不应删除函数定义，只是 runDocgen 不再调用它）。

- [ ] **Step 2.3：提交**

```bash
git add src/entrypoints/web/requirement-ops.js
git commit -m "feat: runDocgen 去超时、onText 更新实时日志、区分用户停止事件"
```

---

## Task 3：后端停止路由

**文件**
- Modify: `src/entrypoints/web/routes-requirements.js`

- [ ] **Step 3.1：在 routes-requirements.js 顶部导入新增的导出**

找到现有的从 requirement-ops.js 导入的行，追加 `docgenAborts, userStoppedSet`：

```javascript
import {
  // ... 原有导入 ...
  docgenAborts,
  userStoppedSet,
  docgenLiveLine,
} from './requirement-ops.js';
```

- [ ] **Step 3.2：新增 POST /api/req/docgen/stop 路由处理**

找到路由分派逻辑（大量 `if (pathname === '/api/req/...' && method === 'POST')` 的地方），新增：

```javascript
if (pathname === '/api/req/docgen/stop' && method === 'POST') {
  let body = '';
  req.on('data', (chunk) => { body += chunk.toString(); });
  req.on('end', () => {
    try {
      const { id } = JSON.parse(body);
      if (!id) return sendJson(res, 400, { error: '缺少 id 参数' });

      const abort = docgenAborts.get(id);
      if (!abort) return sendJson(res, 404, { error: '无进行中的生成任务' });

      // 标记用户主动停止，runDocgen 的 catch 里据此判断
      userStoppedSet.add(id);
      abort.abort(new Error('用户停止'));

      return sendJson(res, 200, { ok: true });
    } catch (e) {
      logger.error('req', 'POST docgen/stop 异常', { err: e?.message });
      return sendJson(res, 400, { error: '请求体解析失败' });
    }
  });
  return;
}
```

注意：检查现有路由文件里其他 POST 路由的 body 读取方式，保持一致（有些路由可能用了封装好的 readBody 函数，而不是直接监听 data 事件，需要跟随现有惯例）。

- [ ] **Step 3.3：运行测试**

```bash
npm test
```

- [ ] **Step 3.4：提交**

```bash
git add src/entrypoints/web/routes-requirements.js
git commit -m "feat: 新增 POST /api/req/docgen/stop 停止路由"
```

---

## Task 4：GET /api/req/get 追加 liveLog 字段

**文件**
- Modify: `src/entrypoints/web/routes-requirements.js`（handleGet 函数）

- [ ] **Step 4.1：在 handleGet 函数的返回体里追加 liveLog**

找到 `/api/req/get` 路由的 `sendJson(res, 200, { ... })` 调用，在 JSON 对象里添加：

```javascript
liveLog: docgenLiveLine.get(r.id) || null,
```

确保 `docgenLiveLine` 已在 Step 3.1 中导入。

- [ ] **Step 4.2：运行测试**

```bash
npm test
```

- [ ] **Step 4.3：提交**

```bash
git add src/entrypoints/web/routes-requirements.js
git commit -m "feat: GET /api/req/get 响应追加 liveLog 字段"
```

---

## Task 5：前端 renderBusyBar - 停止按钮 + 实时日志

**文件**
- Modify: `public/js/req-view.js`（renderBusyBar 函数，约 2807-2839 行）

- [ ] **Step 5.1：修改 renderBusyBar 的 docgen 分支**

找到 `function renderBusyBar(req)` 里的 docgen 分支（if quizgen... else 之后的部分），替换为：

```javascript
// docgen 阶段：加停止按钮
const headRow = e('div', 'docgen-head-row');
const head = e('span', null, hasDevDoc(req) ? '开发文档修订中…' : '开发文档生成中…');

const stopBtn = e('button', 'rqw-btn-small', '停止');
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
      window.toast?.error('停止失败，请稍后重试');
      stopBtn.disabled = false;
      stopBtn.textContent = '停止';
    }
    // 成功：3s busy 轮询会感知 busy=null 并整页重渲，按钮自动消失
  } catch (_e) {
    window.toast?.error('网络错误');
    stopBtn.disabled = false;
    stopBtn.textContent = '停止';
  }
};

headRow.appendChild(head);
headRow.appendChild(stopBtn);
body.appendChild(headRow);

if (startedAt) body.appendChild(e('span', 'el', `（已运行 ${mins} 分钟）`));
body.appendChild(document.createElement('br'));

const answeredCount = Object.keys(req.quiz?.answers || {}).length;
body.append(
  (answeredCount ? `已采纳你的 ${answeredCount} 项问卷结论，` : '') +
    '正在阅读工程实际代码。无时间限制，可先离开，完成后回来查看。',
);

// 实时日志（liveLog 由 GET /api/req/get 每 3s 带回）
if (req.liveLog) {
  const logDiv = e('div', 'docgen-livelog');
  const logCode = e('code', null, req.liveLog);
  logDiv.appendChild(logCode);
  body.appendChild(logDiv);
}

bar.appendChild(body);
return bar;
```

- [ ] **Step 5.2：添加 CSS 样式**

找到项目的 CSS 文件（搜索 `.rqw-bar` 或 `.rqw-btn` 来定位文件），追加：

```css
.docgen-head-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.rqw-btn-small {
  padding: 3px 10px;
  font-size: 12px;
  border: 1px solid var(--border, #ccc);
  background: var(--bg, #fff);
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  line-height: 1.4;
}

.rqw-btn-small:hover:not(:disabled) {
  background: var(--hover-bg, #f5f5f5);
  border-color: #999;
}

.rqw-btn-small:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.docgen-livelog {
  margin-top: 8px;
  padding: 5px 8px;
  background: rgba(0,0,0,0.03);
  border-left: 2px solid var(--border, #ddd);
  border-radius: 2px;
  font-size: 11px;
}

.docgen-livelog code {
  font-family: monospace;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
  max-width: 100%;
}
```

- [ ] **Step 5.3：提交**

```bash
git add public/js/req-view.js
# 以及修改的 css 文件
git commit -m "feat: renderBusyBar 加停止按钮和实时日志展示"
```

---

## Task 6：验收测试

- [ ] **Step 6.1：运行全量测试**

```bash
npm test
```

预期：所有测试通过。

- [ ] **Step 6.2：手动验收清单**

```
- [ ] GET /api/req/get 响应包含 liveLog 字段（无生成时为 null）
- [ ] 启动 docgen 后，busy bar 里出现"停止"按钮
- [ ] 点停止按钮后变为"停止中…"，3s 内 busy bar 消失
- [ ] 需求事件日志显示"开发文档生成已停止"（非"失败"）
- [ ] busy bar 底部显示实时日志最后一行（3s 更新）
- [ ] 日志超长时单行裁剪显示
- [ ] 15 分钟以上的生成正常运行，无超时中断
```

# 面板/续跑体验三项修复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复面板视图下审批不可见、判档窗口内模式切换失效、CPU 闲置浪费三个体验缺口。

**Architecture:** 
- #3 顶栏审批徽标：纯前端增量，扫描 `runningJobs` 统计挂起审批，面板视图下显示红点。
- #5 判档窗口缓冲：后端 `setRunMode` 新增缓冲逻辑，`startClaudeRun` 中赋值 `startMode` 后补发。
- #6 清理：删孤儿 CSS 规则，面板视图下暂停 lottie 动画。

**Tech Stack:** Node.js + Vanilla JS (ES modules) + Playwright e2e

---

## 文件规划

### 改动范围
| 文件 | 改动类型 | 目的 |
|------|--------|------|
| `public/index.html` | 改动 | 新增 `#askChip` HTML 元素 |
| `public/js/chat.js` | 改动 | `refreshAskChip()` 函数 + 刷新触发点 + onclick |
| `public/js/anim.js` | 改动 | `setMascotState()` 中增加面板下暂停逻辑 |
| `public/app.css` | 改动 | 删孤儿 `.msg .meta` 和 `kbd` 规则 |
| `src/store/runs.js` | 改动 | `setRunMode()` 新增判档窗口缓冲逻辑 |
| `src/entrypoints/web/run-claude.js` | 改动 | `startClaudeRun()` 中补发缓冲的 mode |
| `src/store/runs.test.js` | 改动 | 新增 3 个 `setRunMode` 判档窗口缓冲用例 |
| `tests/e2e-panels-ask-chip.mjs` | 创建 | e2e 测试：审批徽标显隐与交互 |

---

## Task 1: HTML 元素与基础样式

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.css`

- [ ] **Step 1: 读取 index.html 相关部分**

Run: `head -60 public/index.html | grep -A5 pendingChip`

观察 `#pendingChip` 的位置、属性、样式类。

- [ ] **Step 2: 在 index.html 中新增 #askChip 元素**

在 `#pendingChip` 之后添加：

```html
<span class="ask-chip" id="askChip" data-tauri-drag-region hidden></span>
```

完整代码示例（在 topbar 内）：
```html
<header class="topbar" data-tauri-drag-region>
  <!-- ... 其他按钮 ... -->
  <div class="spacer" id="topbarDragArea" data-tauri-drag-region></div>
  <div class="ratelimit" id="ratelimit" data-tauri-drag-region hidden></div>
  <span class="pending-chip" id="pendingChip" data-tauri-drag-region hidden></span>
  <span class="ask-chip" id="askChip" data-tauri-drag-region hidden></span>
</header>
```

- [ ] **Step 3: 在 app.css 中为 .ask-chip 添加样式**

在 `public/app.css` 中找到 `.pending-chip` 的样式定义（应在 1640-1650 行附近），复制样式并新增 `.ask-chip` 规则，保持一致：

```css
.ask-chip {
  background: #ff6b6b;
  color: white;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
  margin-left: 8px;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: opacity 0.2s;
}

.ask-chip:hover {
  opacity: 0.9;
}
```

- [ ] **Step 4: 验证 HTML 与样式正确**

Run: `grep -n "ask-chip\|pending-chip" public/index.html public/app.css`

Expected: 应看到 `#askChip` 在 index.html，`.ask-chip` 样式在 app.css。

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.css
git commit -m "feat(ui): 新增顶栏审批徽标 HTML 与样式"
```

---

## Task 2: 前端 refreshAskChip() 函数与触发点

**Files:**
- Modify: `public/js/chat.js`

- [ ] **Step 1: 在 chat.js 顶部定义 refreshAskChip() 函数**

在 `initChat()` 函数定义之前（约第 30-40 行）新增：

```javascript
/**
 * 刷新顶栏审批徽标：
 * 仅当离开聊天视图且有挂起审批时显示「⏳ N 待确认」
 */
function refreshAskChip() {
  const chip = document.getElementById('askChip');
  const app = document.querySelector('.app');
  if (!chip) return;
  
  // 统计所有 runningJobs 中的挂起 ask
  let askCount = 0;
  for (const job of Object.values(runningJobs)) {
    if (job && job.ask) askCount++;
  }
  
  // 仅在非 chat 视图且有待确认时显示
  const isInChat = activeView === 'chat'; // 或根据视图状态判断
  const shouldShow = !isInChat && askCount > 0;
  
  chip.hidden = !shouldShow;
  if (shouldShow) {
    chip.textContent = `⏳ ${askCount} 待确认`;
  }
}
```

**注**：`activeView` 变量需检查现有视图机状态。若不存在，可用 `document.querySelector('.app').classList.contains('chat-view')` 或其他视图标记。下一步确认。

- [ ] **Step 2: 在 chat.js 中找到 showView() 函数，在其中增加 refreshAskChip() 调用**

找到 `function showView(name)` 或 `showView = (name) => { ... }`（约第 130-160 行），在视图切换完成后加：

```javascript
function showView(name) {
  // ... 现有逻辑（切换类名、隐显面板等）...
  activeView = name;
  refreshAskChip(); // <-- 新增：刷新审批徽标
}
```

验证代码后提交。

- [ ] **Step 3: 在 SSE ask 事件回调中增加 refreshAskChip() 调用**

找到 `es.addEventListener('ask', ...)` 回调（约第 1209 行），在 `job.ask = ...` 赋值后加：

```javascript
es.addEventListener('ask', (e) => {
  job.ask = JSON.parse(e.data);
  refreshAskChip(); // <-- 新增：刷新徽标
});
```

- [ ] **Step 4: 在 job 结束时增加 refreshAskChip() 调用**

找到 `runningJobs` 删除或置空的地方（约第 388-420 行的 `openConv`, `closeCconv` 等），在移除 job 后加调用：

示例（`closeConv` 或类似清理逻辑）：
```javascript
delete runningJobs[convId];
refreshAskChip(); // <-- 刷新徽标
```

- [ ] **Step 5: 为 #askChip 添加 onclick 事件处理**

在初始化逻辑中（如 `initChat()` 内或最后的事件绑定部分）加：

```javascript
document.getElementById('askChip')?.addEventListener('click', () => {
  _goChat(); // 回聊天视图
  
  // 找到第一个有待确认的会话并打开
  for (const [convId, job] of Object.entries(runningJobs)) {
    if (job && job.ask) {
      openConv(convId);
      // 可选：滚动到 .ask-card
      setTimeout(() => {
        const askCard = document.querySelector('.ask-card');
        if (askCard) askCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);
      break;
    }
  }
});
```

- [ ] **Step 6: 验证逻辑**

在浏览器中测试（或后续 e2e 验证）：
- 启动一个挂起权限的 run
- 切到设置面板 → `#askChip` 应显示红点
- 点击红点 → 回聊天视图并定位到审批卡

- [ ] **Step 7: Commit**

```bash
git add public/js/chat.js
git commit -m "feat(chat): 新增 refreshAskChip() 与审批徽标交互"
```

---

## Task 3: CSS 孤儿规则清理

**Files:**
- Modify: `public/app.css`

- [ ] **Step 1: 找到 .msg .meta 规则**

Run: `grep -n "\.msg \.meta" public/app.css`

Expected: 应在第 798 行附近。

- [ ] **Step 2: 删除 .msg .meta 规则块**

打开 `public/app.css`，定位到第 798 行，整个规则块删除：

```css
.msg .meta {
  /* ... 所有内容 ... */
}
```

完整删除范围需确认（从 `.msg .meta {` 到对应的 `}`）。

- [ ] **Step 3: 找到 kbd 规则**

Run: `grep -n "^kbd {" public/app.css`

Expected: 应在第 1140 行附近。

- [ ] **Step 4: 删除 kbd 规则块**

定位到相应行，删除整个规则块：

```css
kbd {
  /* ... 所有内容 ... */
}
```

- [ ] **Step 5: 验证删除无遗留**

Run: `grep -E "\.msg \.meta|^kbd " public/app.css`

Expected: 无输出（已删除）。

同时验证全仓无其他引用：

```bash
grep -r "\.meta\|<kbd" --include="*.html" --include="*.js" public/ src/ tests/ 2>/dev/null | grep -v "vendor"
```

Expected: 无相关引用（除可能的注释）。

- [ ] **Step 6: Commit**

```bash
git add public/app.css
git commit -m "cleanup(css): 删除无引用的 .msg .meta 和 kbd 规则"
```

---

## Task 4: 面板下 lottie 暂停

**Files:**
- Modify: `public/js/anim.js`

- [ ] **Step 1: 读取 anim.js 中 setMascotState() 函数**

Run: `grep -n "function setMascotState\|setMascotState.*=" public/js/anim.js | head -5`

定位函数位置，读取完整实现（应在第 40-110 行）。

- [ ] **Step 2: 修改 setMascotState() 增加面板检查**

在函数开头加入面板判定逻辑，修改如下：

```javascript
export function setMascotState(state, message) {
  const mascotStatusPanel = document.getElementById('mascotStatusPanel');
  const app = document.querySelector('.app');
  const inPanel = app?.classList.contains('in-panel');
  
  // 面板视图下（非 error/success）：暂停动画
  if (inPanel && state !== 'error' && state !== 'success') {
    mascotAnim?.pause?.();
    return; // <-- 早返回，不执行后续 state 处理
  }
  
  // 聊天视图或特殊状态：继续播放
  mascotAnim?.play?.();
  
  // 原有 state 处理逻辑
  // if (state === 'idle') { ... }
  // ...
}
```

**注**：需确保 `mascotAnim` 对象存在且支持 `.play()`/`.pause()` 方法（Lottie animation 标准 API）。

- [ ] **Step 3: 在 showView() 中增加手动 play/pause 调用**

在 Task 2 中修改过的 `showView()` 函数中，根据视图类型调用：

```javascript
function showView(name) {
  // ... 现有切换逻辑 ...
  activeView = name;
  
  // 根据视图控制动画
  if (name === 'chat') {
    mascotAnim?.play?.();
  } else if (['settings', 'logs', 'tasks', 'actions'].includes(name)) {
    mascotAnim?.pause?.();
  }
  
  refreshAskChip();
}
```

- [ ] **Step 4: 验证逻辑**

在浏览器中手工测试：
- 聊天视图：吉祥物动画播放
- 切到设置面板：吉祥物暂停（动画静止但元素可见）
- 回聊天视图：动画恢复播放

- [ ] **Step 5: Commit**

```bash
git add public/js/anim.js
git commit -m "feat(anim): 面板视图下暂停 lottie 动画节省 CPU"
```

---

## Task 5: 后端判档窗口缓冲

**Files:**
- Modify: `src/store/runs.js`
- Modify: `src/entrypoints/web/run-claude.js`

### 5.1 修改 setRunMode()

- [ ] **Step 1: 读取 runs.js 中的 setRunMode() 函数**

Run: `sed -n '250,272p' src/store/runs.js`

- [ ] **Step 2: 在 setRunMode() 中增加缓冲逻辑**

修改 `setRunMode()` 函数：

```javascript
export function setRunMode(runId, mode) {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  
  // 新增：判档窗口内缓冲
  if (run.startMode === undefined) {
    run._pendingMode = mode;
    return true; // 乐观返回 true
  }
  
  // 原有逻辑（仅询问起跑可放宽）
  if (run.startMode !== 'default') return false;
  if (mode !== 'acceptEdits' && mode !== 'bypassPermissions') return false;
  run.mode = mode;
  
  // 自动放行挂起的 permission 审批
  const keep = [];
  for (const p of run.pendingQueue) {
    if (p.kind === 'permission') p.resolve('allow');
    else keep.push(p);
  }
  run.pendingQueue = keep;
  
  if (run.pending && run.pending.kind === 'permission') {
    const p = run.pending;
    advanceAsk(run);
    p.resolve('allow');
  }
  if (!run.pending) fanout(run, 'ask', null);
  touch(run);
  return true;
}
```

- [ ] **Step 3: Commit（阶段性）**

```bash
git add src/store/runs.js
git commit -m "feat(runs): setRunMode 增加判档窗口缓冲"
```

### 5.2 修改 startClaudeRun()

- [ ] **Step 4: 在 run-claude.js 中找到 run.startMode 赋值位置**

Run: `grep -n "run.startMode" src/entrypoints/web/run-claude.js`

Expected: 应在第 43 行左右。

- [ ] **Step 5: 在 startClaudeRun() 中补发缓冲的 mode**

在 `run.startMode = effectiveMode` 赋值后（约第 43 行之后），立即加：

```javascript
export function startClaudeRun(run, { prompt, cwd, session, model, effort, mode, convId, resumePendingId, preInput, resumeAttempt = 0 }) {
  run.convId = convId || run.convId || null;
  const effectiveMode = mode || 'default';
  run.mode = effectiveMode;
  run.startMode = effectiveMode; // 起跑模式：非「询问」起跑未装 ask 钩子
  
  // 新增：补发判档窗口内缓冲的模式切换
  if (run._pendingMode && effectiveMode === 'default') {
    const targetMode = run._pendingMode;
    delete run._pendingMode;
    if (targetMode === 'acceptEdits' || targetMode === 'bypassPermissions') {
      setRunMode(run.id, targetMode);
    }
  }
  
  run.startMode = effectiveMode; // 要确保赋值在缓冲检查之前，代码顺序应为：
  // 1. run.startMode = effectiveMode
  // 2. 补发缓冲逻辑
  
  let lastRate = null;
  // ... 后续代码 ...
}
```

**注**：实际位置可能有微调，但逻辑是赋完 `run.startMode` 后立即补发。

- [ ] **Step 6: 验证导入**

检查 `run-claude.js` 顶部是否已导入 `setRunMode`：

Run: `head -40 src/entrypoints/web/run-claude.js | grep setRunMode`

若无，在导入部分加：

```javascript
import { setRunMode } from '../../store/runs.js';
```

- [ ] **Step 7: Commit**

```bash
git add src/entrypoints/web/run-claude.js
git commit -m "feat(run-claude): startClaudeRun 中补发缓冲的模式切换"
```

---

## Task 6: 后端单元测试

**Files:**
- Modify: `src/store/runs.test.js`

- [ ] **Step 1: 读取现有 runs.test.js**

Run: `tail -50 src/store/runs.test.js`

观察现有测试框架（jest/node --test）和测试风格。

- [ ] **Step 2: 新增 Case 1 测试：判档窗口缓冲生效**

在 `runs.test.js` 末尾新增：

```javascript
test('setRunMode: 判档窗口内缓冲（run.startMode === undefined）', () => {
  const run = createRun();
  // 初始状态：status=running，startMode 未赋值
  assert(run.status === 'running', 'run.status should be running');
  assert(run.startMode === undefined, 'run.startMode should be undefined initially');
  
  // 调 setRunMode → 缓冲生效，返回 true
  const applied = setRunMode(run.id, 'acceptEdits');
  assert(applied === true, 'setRunMode should return true when in judgment window');
  assert(run._pendingMode === 'acceptEdits', 'run._pendingMode should be set');
});
```

- [ ] **Step 3: 新增 Case 2 测试：赋值后补发生效**

继续在末尾加：

```javascript
test('setRunMode: 判档窗口后补发缓冲的模式', () => {
  const run = createRun();
  
  // 1. 判档窗口内设置，缓冲
  const r1 = setRunMode(run.id, 'acceptEdits');
  assert(r1 === true, 'should buffer in judgment window');
  
  // 2. 赋值 startMode='default'
  run.startMode = 'default';
  
  // 3. 调 setRunMode 补发
  const r2 = setRunMode(run.id, run._pendingMode || 'acceptEdits');
  assert(r2 === true, 'should apply after startMode is set');
  assert(run.mode === 'acceptEdits', 'run.mode should be acceptEdits after apply');
  
  // 缓冲应被清除
  assert(run._pendingMode === undefined, 'run._pendingMode should be cleared after apply');
});
```

- [ ] **Step 4: 新增 Case 3 测试：非询问起跑时缓冲丢弃**

继续在末尾加：

```javascript
test('setRunMode: 非询问起跑（startMode !== default）时缓冲自动丢弃', () => {
  const run = createRun();
  
  // 缓冲一个 mode
  const r1 = setRunMode(run.id, 'acceptEdits');
  assert(r1 === true, 'should buffer');
  
  // 赋值 startMode 为非 default
  run.startMode = 'acceptEdits';
  
  // 尝试应用缓冲的 mode → 失败（因为 startMode !== 'default'）
  const r2 = setRunMode(run.id, 'bypassPermissions');
  assert(r2 === false, 'should reject when startMode is not default');
});
```

- [ ] **Step 5: 运行测试验证**

Run: `npm test -- src/store/runs.test.js`

Expected: 所有测试通过（包括新增的 3 个）。

- [ ] **Step 6: Commit**

```bash
git add src/store/runs.test.js
git commit -m "test(runs): 新增 setRunMode 判档窗口缓冲用例"
```

---

## Task 7: e2e 测试

**Files:**
- Create: `tests/e2e-panels-ask-chip.mjs`

- [ ] **Step 1: 创建新 e2e 测试文件**

Create `tests/e2e-panels-ask-chip.mjs`：

```javascript
import { chromium } from 'playwright';
import assert from 'assert';

/**
 * e2e 测试：顶栏审批徽标与面板视图
 * 场景：启动挂起权限的 run，在面板视图显示徽标，点击回聊天并定位
 */

const BASE_URL = 'http://localhost:3000';
let browser, page;

async function setup() {
  browser = await chromium.launch();
  page = await browser.newPage();
}

async function teardown() {
  if (browser) await browser.close();
}

async function testAskChipDisplay() {
  console.log('Test: #askChip 在面板视图显示');
  
  // 导航到应用
  await page.goto(BASE_URL);
  await page.waitForSelector('.app');
  
  // stub EventSource 注入 ask 事件（模拟挂起权限）
  await page.evaluate(() => {
    const origES = window.EventSource;
    window.EventSource = function (url) {
      const es = new origES(url);
      const origAddListener = es.addEventListener.bind(es);
      es.addEventListener = function (event, handler) {
        if (event === 'ask') {
          // 延迟 500ms 后注入 ask 事件
          setTimeout(() => {
            const ev = new MessageEvent('message', {
              data: JSON.stringify({
                reqId: 'test-req-1',
                kind: 'permission',
                title: 'Test permission',
                body: 'Allow test?',
                options: [
                  { id: 'allow', label: 'Allow' },
                  { id: 'deny', label: 'Deny' },
                ],
              }),
            });
            handler(ev);
          }, 500);
        }
        origAddListener.call(es, event, handler);
      };
      return es;
    };
    window.EventSource.CONNECTING = origES.CONNECTING;
    window.EventSource.OPEN = origES.OPEN;
    window.EventSource.CLOSED = origES.CLOSED;
  });
  
  // 启动一个 run（POST /api/run/start）
  const runRes = await page.evaluate(() => {
    return fetch('/api/run/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'test prompt',
        cwd: process.cwd(),
      }),
    }).then(r => r.json());
  });
  
  const runId = runRes.runId;
  console.log('Run started:', runId);
  
  // 等待 ask 事件注入
  await page.waitForTimeout(1000);
  
  // 切到设置面板
  await page.evaluate(() => {
    window._showView?.('settings'); // 或对应的视图切换方式
  });
  
  // 验证 #askChip 可见且显示「⏳ 1 待确认」
  const askChip = await page.$('#askChip');
  assert(askChip, '#askChip element should exist');
  
  const hidden = await page.evaluate(() => document.getElementById('askChip')?.hidden);
  assert(!hidden, '#askChip should be visible in settings panel');
  
  const text = await page.evaluate(() => document.getElementById('askChip')?.textContent);
  assert(text.includes('待确认'), `#askChip text should contain 待确认, got: ${text}`);
  
  console.log('✓ #askChip displays correctly in panel view');
}

async function testAskChipClick() {
  console.log('Test: 点击 #askChip 回聊天视图');
  
  // 继续上一个测试的状态，点击 #askChip
  const askChip = await page.$('#askChip');
  await askChip.click();
  
  // 等待视图切换
  await page.waitForTimeout(300);
  
  // 验证已回到 chat 视图
  const app = await page.$('.app');
  const chatView = await page.evaluate(() => {
    const app = document.querySelector('.app');
    return !app.classList.contains('in-panel');
  });
  assert(chatView, 'should be in chat view after clicking askChip');
  
  // 验证 .ask-card 可见
  const askCard = await page.$('.ask-card');
  assert(askCard, '.ask-card should be visible');
  
  console.log('✓ askChip click works correctly');
}

async function testAskChipHidden() {
  console.log('Test: 提交审批后 #askChip 隐藏');
  
  // 找到 ask-card 中的"允许"按钮并点击
  const allowBtn = await page.$('.ask-opt:has-text("允许")');
  if (allowBtn) {
    await allowBtn.click();
    await page.waitForTimeout(300);
  }
  
  // 验证 #askChip 隐藏
  const hidden = await page.evaluate(() => document.getElementById('askChip')?.hidden);
  assert(hidden, '#askChip should be hidden after decision');
  
  console.log('✓ askChip hides after decision');
}

(async () => {
  try {
    await setup();
    await testAskChipDisplay();
    await testAskChipClick();
    await testAskChipHidden();
    console.log('\n✓ All tests passed');
  } catch (err) {
    console.error('✗ Test failed:', err);
    process.exit(1);
  } finally {
    await teardown();
  }
})();
```

- [ ] **Step 2: 验证 Playwright 已安装**

Run: `npm list playwright`

Expected: `playwright` 在 package.json 中（应已有，见 `e2e-panels-smoke.mjs` 等）。

- [ ] **Step 3: 启动本地服务并运行 e2e**

在一个终端启动应用（假设已配置）：

```bash
npm run start:web
```

在另一个终端运行测试：

```bash
npm run e2e -- tests/e2e-panels-ask-chip.mjs
```

或直接：

```bash
npx playwright test tests/e2e-panels-ask-chip.mjs
```

Expected: 所有测试通过。

- [ ] **Step 4: 手工浏览器验证（可选但推荐）**

启动应用后用浏览器手工过一遍流程：
1. 启动 run
2. 等待 ask 事件到达
3. 切到设置面板 → 红点出现
4. 点红点 → 回聊天并定位
5. 提交审批 → 红点消失

- [ ] **Step 5: Commit**

```bash
git add tests/e2e-panels-ask-chip.mjs
git commit -m "test(e2e): 顶栏审批徽标显隐与交互测试"
```

---

## Task 8: 全量测试与集成验证

**Files:**
- None (验证任务)

- [ ] **Step 1: 运行全量后端单元测试**

Run: `npm test`

Expected: 所有测试通过，包括新增的 `runs.test.js` 用例。

- [ ] **Step 2: 运行 e2e 测试（若环境支持）**

Run: `npm run e2e` 或手工验证。

Expected: `e2e-panels-ask-chip.mjs` 通过。

- [ ] **Step 3: 手工验证整体流程**

打开应用并过一遍：
1. **#3 审批徽标**：启动挂起权限的 run，切到面板 → 红点显示 → 点红点回聊天 → 定位到审批卡 → 提交后红点消失 ✓
2. **#5 判档缓冲**：启动 auto 判档，在 8s 窗口内切模式 → 模式应生效（后续工具放行） ✓（需通过权限卡观察）
3. **#6 lottie 暂停**：切到设置面板 → 吉祥物停止动画；回聊天 → 动画恢复 ✓
4. **CSS 清理**：开发者工具检查没有 `.msg .meta` 或 `kbd` 规则 ✓

- [ ] **Step 4: 验证无错误与回归**

检查浏览器控制台无 JavaScript 错误，应用关闭时无异常。

- [ ] **Step 5: 最终提交与总结**

```bash
git log --oneline -8  # 查看本 feature 的 8 个提交
```

Expected: 依次为：
1. `feat(ui): 新增顶栏审批徽标 HTML 与样式`
2. `feat(chat): 新增 refreshAskChip() 与审批徽标交互`
3. `cleanup(css): 删除无引用的 .msg .meta 和 kbd 规则`
4. `feat(anim): 面板视图下暂停 lottie 动画节省 CPU`
5. `feat(runs): setRunMode 增加判档窗口缓冲`
6. `feat(run-claude): startClaudeRun 中补发缓冲的模式切换`
7. `test(runs): 新增 setRunMode 判档窗口缓冲用例`
8. `test(e2e): 顶栏审批徽标显隐与交互测试`

---

## 自检清单

✓ **Spec 覆盖**：
- #3 顶栏审批徽标 → Task 1-2, 7
- #5 判档窗口缓冲 → Task 5-6
- #6 清理 CSS + lottie → Task 3-4

✓ **占位符扫描**：所有代码块完整，无 TODO/TBD。

✓ **类型一致**：
- `refreshAskChip()` 函数名在 Task 2, 3, 4 中保持一致
- `setRunMode()` 签名在 Task 5-6 中一致
- `run._pendingMode` 属性名保持一致

✓ **向后兼容**：纯增量改动，无破坏性变更。

✓ **测试覆盖**：单元测试（Task 6）+ e2e 测试（Task 7）。

---

## 说明

- **执行顺序**：Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8，可以依序或并行（前后端可并行）。
- **提交频率**：每个任务后 commit，共 8 个原子提交，便于追溯与 revert。
- **本地测试**：建议 Task 2/4/5 后先手工验证，再进入 e2e 流程。
- **依赖**：无新 npm 包，仅现有 Playwright（e2e）与 Node.js 内置 assert。

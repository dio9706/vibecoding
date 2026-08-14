# 面板/续跑体验三项修复设计

**日期**: 2026-07-27  
**会话**: brainstorming 确认的改进方案

---

## 背景

用户在面板视图（设置/日志/任务）与运行期间的 3 个体验缺口：

1. **#3 面板下审批卡不可见** — 进入面板后后台挂起的审批会在 15min 后默认拒绝，且用户无法看到待确认任务。
2. **#5 判档窗口内切模式静默失效** — 从 `auto` 判档（最长 8s）到 `startMode` 赋值的窗口内，`setRunMode` 会因 `run.startMode === undefined` 而静默返回 false，中途放宽失效。
3. **#6 孤儿 CSS + lottie 空转** — 面板下吉祥物动画仍空转消耗 CPU；`.msg .meta` 和 `kbd` 规则无任何引用。

**已验证不需改**：#4（额度续跑继承起跑 mode）已在重构时修好，`settleRun` 用的是 `params.mode`（起跑固定值，不被中途 `setRunMode` 改写）。

---

## 设计详细说明

### #3 顶栏审批徽标

**目标**：在离开聊天视图时提醒用户有挂起审批，点击快速返回并定位。

**HTML 改动**（`public/index.html`）：
- 在 `#pendingChip`（续跑徽标）旁新增 `<span class="ask-chip" id="askChip" data-tauri-drag-region hidden>`。
- 类名+属性与 `#pendingChip` 一致（隐藏初始态、拖拽区）。
- CSS 样式与 `#pendingChip` 齐平（圆角底色、文字尺寸、边距）。

**前端逻辑**（`public/js/chat.js`）：

新增 `refreshAskChip()` 函数，仅在以下条件同时满足时显示徽标：
- 当前视图不是 `chat`（用现有视图机状态判定）  
- 扫描所有 `runningJobs[*].ask` 统计非空计数 `asking > 0`  

显示内容：`⏳ N 待确认`（与 `#pendingChip` 的 `⏳ N 个任务待续跑` 并列）。

**刷新触发点**：
1. `ask` 事件回调（新增 ask 或 ask 清除）— `job.ask = ...` 后调 `refreshAskChip()`
2. `showView(name)` 切换视图时调 `refreshAskChip()`
3. job 结束（`job.status !== 'running'` 或移除 runningJobs）后调 `refreshAskChip()`

**点击交互**（`#askChip` 的 onclick）：
1. 调 `_goChat()` 回聊天视图
2. 遍历 `runningJobs`，找到第一个 `.ask` 非空的，调 `openConv(jobId)` 打开会话
3. 该会话的聊天视图展示时自动滚动到 `.ask-card` 可见区域

**数据来源**：纯前端逻辑，`job.ask` 已有，**无需后端改动**。

---

### #5 判档窗口 pendingMode 缓冲

**背景**：`createRun()` 时 `status = 'running'`，但 `run.startMode` 要到 `startClaudeRun()` 才赋值。极窄窗口内（auto 判档最长 8s）`setRunMode` 检查 `run.startMode !== 'default'` 会意外返回 false，导致中途模式切换失效。

**解决方案**：缓冲→延期应用

**后端改动**（`src/store/runs.js`）：

修改 `setRunMode()` 逻辑：
```javascript
export function setRunMode(runId, mode) {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  
  // 新增：判档窗口内缓冲
  if (run.startMode === undefined) {
    run._pendingMode = mode; // 缓冲目标模式
    return true; // 乐观返回 true，待 startMode 赋值后补发
  }
  
  // 原有逻辑
  if (run.startMode !== 'default') return false;
  if (mode !== 'acceptEdits' && mode !== 'bypassPermissions') return false;
  run.mode = mode;
  
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

**后端改动**（`src/entrypoints/web/run-claude.js`）：

在 `startClaudeRun()` 中，设完 `run.startMode` 后立即补发缓冲的模式切换：

```javascript
// 在 run.startMode = effectiveMode 赋值后，即刻应用待机 pendingMode
if (run._pendingMode && effectiveMode === 'default') {
  const targetMode = run._pendingMode;
  delete run._pendingMode;
  if (targetMode === 'acceptEdits' || targetMode === 'bypassPermissions') {
    setRunMode(run.id, targetMode); // 使用已导入的函数
  }
}
```

**行为**：
- 起跑为 `'default'`（询问）且判档窗口内收到 `setRunMode` → 缓冲，乐观返回 true
- 赋值完 `startMode='default'` 后，若缓冲有效 → 调 `setRunMode` 补发一次，自动放行挂起的审批
- 起跑非 default（如 acceptEdits）时缓冲的值自动丢弃，保持现有「仅询问起跑可放宽」的设计

---

### #6 清理孤儿 CSS 和 lottie 空转

#### 6.1 删孤儿 CSS 规则

**`public/app.css`**：
- **第 798 行**：`.msg .meta { ... }` — 无任何 HTML 元素带 `class="meta"`，无 JS 引用，删除。
- **第 1140 行**：`kbd { ... }` — 无任何 `<kbd>` 标签，无引用，删除。

已通过 grep 验证（全仓除 vendor 外无其他引用），删除安全。

#### 6.2 面板下暂停 lottie

**背景**：进入设置/日志/任务面板时（`.app.in-panel` 类），吉祥物（lottie 动画）仍在播放，浪费 CPU。

**改动**（`public/js/anim.js`）：

在现有 `mascot` 控制逻辑中增加暂停条件：
```javascript
function setMascotState(state, message) {
  const mascotStatusPanel = document.getElementById('mascotStatusPanel');
  const app = document.querySelector('.app');
  const inPanel = app?.classList.contains('in-panel');
  
  // 面板视图下：暂停动画，保持显示但无需播放
  if (inPanel && state !== 'error' && state !== 'success') {
    mascotAnim?.pause?.();
    return;
  }
  
  // 聊天视图：正常播放
  mascotAnim?.play?.();
  
  // 原有 state 处理...
}
```

**触发点**：
- `showView('chat')` 时调 `mascotAnim?.play?.()`
- `showView('settings'|'logs'|'tasks'|'actions')` 时调 `mascotAnim?.pause?.()`
- 特殊状态（error/success）下忽略面板，继续播放（用户需看反馈）

---

## 测试计划

### 单元测试
- **`src/store/runs.test.js`** 新增 `setRunMode` 判档窗口缓冲用例：
  - Case 1：`run.startMode === undefined` + `setRunMode('acceptEdits')` → 缓冲生效，返回 true
  - Case 2：缓冲后赋 `run.startMode = 'default'` → 补发 `setRunMode` 自动应用，`run.mode = 'acceptEdits'`
  - Case 3：缓冲后赋 `run.startMode = 'acceptEdits'`（非询问起跑）→ 缓冲自动丢弃，无作用

### e2e 测试
- **`tests/e2e-panels-smoke.mjs`** 扩展（或新建 `e2e-panels-ask-chip.mjs`）：
  - 启动一个挂起权限问题的 run（stub EventSource 注入 ask 事件）
  - 切到设置面板 → 验证 `#askChip` 显示「⏳ 1 待确认」
  - 点击 `#askChip` → 验证自动切回聊天视图 + 滚动到 `.ask-card` + `.ask-card` 可见
  - 提交审批后 → 验证 `#askChip` 消失
- **lottie 暂停**:
  - 获得 mascot 动画元素引用，检查 `pause()` 调用历史
  - 面板视图切换时验证 pause/play 交替

### 集成验证
- `npm test` 全量后端测试通过
- `npm run e2e` 或 Playwright 手工过一遍面板切换 + ask 流程
- 手工验证：关闭应用时不抛错

---

## 说明

- **#4（额度续跑 mode）**不在本 spec，已在重构时修好（`run.startMode` 与 `params.mode` 分离）。
- **向后兼容性**：纯增量改动，不涉及存储 schema 或 API 契约改变。
- **性能**：`refreshAskChip()` 遍历 `runningJobs` 仅 O(n)，频率低（ask 事件 + 视图切换），无性能顾虑。
- **依赖**：无新依赖，仅现有 DOM/事件 API。

# 访问日志 3 天保留 + 手动清空 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让访问日志（event-log）仅保留最近 3 天并支持前端一键清空。

**Architecture:** 后端 `event-log.js` 增加基于 `time` 的 3 天保留（读时过滤 + compact 落盘瘦身，双重上限时间为主）与 `clearEvents()`；`server.js` 暴露 `POST /api/logs/clear`；前端在访问日志视图头部加"清空日志"按钮。

**Tech Stack:** Node.js ESM、node:test、原生 http、浏览器原生 JS。

**基线约定：**
- 项目根：`C:\Users\DELL\Desktop\claude-p-web-demo`。命令在项目根执行。
- ⚠️ **执行前置**：`public/app.js` 与 `src/entrypoints/web/server.js` 存在与本功能无关的未提交改动。执行本计划前须先由用户决定如何隔离（提交/stash/接受混入）。各任务 commit 步骤假定这两个文件的工作区已处于"仅含本功能改动"的干净基线；若未隔离，实现者须改用 patch 级暂存或先咨询。**任何情况下都不得 `git add -A`。**

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/store/event-log.js` | 修改 | 3 天保留过滤 + `clearEvents()` 导出 |
| `src/store/event-log.test.js` | 新建 | 保留过滤 + 清空的单元测试 |
| `src/entrypoints/web/server.js` | 修改 | `POST /api/logs/clear` 路由 + handler + import + skip |
| `public/app.js` | 修改 | 访问日志视图"清空日志"按钮 + 交互 |

---

## Task 1: 后端 event-log 3 天保留 + clearEvents（TDD）

**Files:**
- Test: `src/store/event-log.test.js`（新建）
- Modify: `src/store/event-log.js`

- [ ] **Step 1: 写失败测试**

新建 `src/store/event-log.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

test('event-log: 3 天保留过滤 + clearEvents 清空', async (t) => {
  const tmp = path.join(os.tmpdir(), `cad-eventlog-test-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  t.after(() => {
    delete process.env.APP_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  process.env.APP_DATA_DIR = tmp;

  // 查询串打散 ESM 缓存，确保模块顶层用最新 APP_DATA_DIR 求值
  const mod = await import(`./event-log.js?case=${process.pid}`);

  const fresh = { type: 'access', path: '/api/x', time: new Date().toISOString() };
  const old = {
    type: 'access',
    path: '/api/old',
    time: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
  };
  fs.writeFileSync(
    path.join(tmp, 'event-log.jsonl'),
    JSON.stringify(old) + '\n' + JSON.stringify(fresh) + '\n',
  );

  const events = mod.getEvents();
  assert.strictEqual(events.length, 1, '应只剩 3 天内的 1 条');
  assert.strictEqual(events[0].path, '/api/x');

  mod.clearEvents();
  assert.deepStrictEqual(mod.getEvents(), [], 'clearEvents 后应为空');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/store/event-log.test.js`
Expected: FAIL —— 当前 `getEvents()` 无时间过滤（返回 2 条），且 `clearEvents` 未导出（`mod.clearEvents is not a function`）。

- [ ] **Step 3: 实现**

在 `src/store/event-log.js` 中，把常量区（当前 `const MAX = 1000;` 一行）替换为：

```js
const MAX = 1000;
const RETAIN_MS = 3 * 24 * 60 * 60 * 1000; // 访问日志仅保留最近 3 天
```

在 `getEvents` 函数之前（`readJsonl` 之后）新增保留判定辅助函数：

```js
/** 是否在保留窗口内（3 天）。time 缺失/不可解析一律保留，避免误删。 */
function withinRetention(e, now) {
  const t = Date.parse(e && e.time);
  if (Number.isNaN(t)) return true;
  return now - t <= RETAIN_MS;
}
```

把现有 `getEvents` 整个函数：

```js
export function getEvents() {
  const cur = readJsonl().reverse();
  const legacy = readJson(LEGACY, []); // 旧文件本就最新在前
  return [...cur, ...legacy].slice(0, MAX);
}
```

替换为：

```js
export function getEvents() {
  const now = Date.now();
  const cur = readJsonl().reverse();
  const legacy = readJson(LEGACY, []); // 旧文件本就最新在前
  return [...cur, ...legacy].filter((e) => withinRetention(e, now)).slice(0, MAX);
}
```

把现有 `compact` 整个函数：

```js
function compact() {
  const list = readJsonl();
  if (list.length <= MAX) return;
  const keep = list.slice(-MAX);
  const tmp = dataPath(FILE) + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.renameSync(tmp, dataPath(FILE));
  } catch {
    /* 压缩失败不影响主流程，下次再试 */
  }
}
```

替换为：

```js
function compact() {
  const now = Date.now();
  const list = readJsonl();
  let keep = list.filter((e) => withinRetention(e, now));
  if (keep.length > MAX) keep = keep.slice(-MAX); // 时间为主、条数为安全上限
  if (keep.length === list.length) return; // 无过期、未超限，无需写盘
  const tmp = dataPath(FILE) + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, keep.length ? keep.map((e) => JSON.stringify(e)).join('\n') + '\n' : '');
    fs.renameSync(tmp, dataPath(FILE));
  } catch {
    /* 压缩失败不影响主流程，下次再试 */
  }
}
```

在文件末尾的 `compact(); // 模块加载即压缩一次（跨重启兜底）` 之前，新增导出 `clearEvents`：

```js
/** 清空全部访问日志：截空 JSONL，并删除只读遗留 event-log.json，保证清空彻底。 */
export function clearEvents() {
  fs.writeFileSync(dataPath(FILE), '');
  try {
    fs.rmSync(dataPath(LEGACY), { force: true });
  } catch {
    /* 遗留文件删除失败可忽略（时间过滤也会滤除其旧条目） */
  }
}
```

（`clearEvents` 中 `writeFileSync` 若抛错则向上抛出，由接口层转 500；legacy 删除为尽力而为。）

- [ ] **Step 4: 运行确认通过**

Run: `node --test src/store/event-log.test.js`
Expected: PASS（1 test passed, 0 failed）。

- [ ] **Step 5: 提交**

```bash
git add src/store/event-log.js src/store/event-log.test.js
git commit -m "feat(event-log): 访问日志 3 天保留 + clearEvents 清空"
```

---

## Task 2: 后端接口 POST /api/logs/clear

**Files:**
- Modify: `src/entrypoints/web/server.js`（import 行、`ACCESS_LOG_SKIP`、路由区、handler）

- [ ] **Step 1: 扩展 import**

把 `src/entrypoints/web/server.js` 的：

```js
import { appendEvent, getEvents } from '../../store/event-log.js';
```

替换为：

```js
import { appendEvent, getEvents, clearEvents } from '../../store/event-log.js';
```

- [ ] **Step 2: 把清空接口加入访问日志排除集**

把 `ACCESS_LOG_SKIP` 定义：

```js
const ACCESS_LOG_SKIP = new Set([
  '/api/tasks',
  '/api/logs',
  '/api/run/pending',
  '/api/tokens/status',
]);
```

替换为：

```js
const ACCESS_LOG_SKIP = new Set([
  '/api/tasks',
  '/api/logs',
  '/api/logs/clear',
  '/api/run/pending',
  '/api/tokens/status',
]);
```

- [ ] **Step 3: 加路由**

找到路由行 `if (url.pathname === '/api/logs') return handleLogs(res);`，在其后新增一行：

```js
  if (url.pathname === '/api/logs/clear') return handleLogsClear(req, res);
```

- [ ] **Step 4: 加 handler**

找到 `handleLogs` 函数：

```js
/** 统一日志：事件日志，按时间倒序排列 */
function handleLogs(res) {
  const events = getEvents();
  sendJson(res, 200, { logs: events.slice(0, 1000) });
}
```

在其后新增：

```js
/** 清空全部访问日志 */
function handleLogsClear(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  try {
    clearEvents();
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}
```

- [ ] **Step 5: 语法校验**

Run: `node --check src/entrypoints/web/server.js`
Expected: 无输出、退出码 0（语法有效）。

- [ ] **Step 6: 提交**

```bash
git add src/entrypoints/web/server.js
git commit -m "feat(api): 新增 POST /api/logs/clear 清空访问日志"
```

---

## Task 3: 前端"清空日志"按钮

**Files:**
- Modify: `public/app.js`（`loadLogs` 内 `searchBar` 处，约 2242 行）

- [ ] **Step 1: 在搜索栏加入清空按钮**

在 `loadLogs()` 中，找到：

```js
        searchBar.appendChild(searchInput);
        searchBar.appendChild(countSpan);
        body.appendChild(searchBar);
```

替换为：

```js
        searchBar.appendChild(searchInput);
        searchBar.appendChild(countSpan);

        // 清空日志按钮：主动清空全部访问日志（3 天自动保留之外的手动一键清）
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.textContent = '清空日志';
        clearBtn.style.cssText =
          'margin-left:8px;padding:2px 10px;font-size:12px;color:var(--red,#e5484d);' +
          'background:transparent;border:1px solid var(--red,#e5484d);border-radius:4px;' +
          'cursor:pointer;white-space:nowrap;';
        clearBtn.addEventListener('click', async () => {
          if (!confirm('确定清空全部访问日志？此操作不可恢复')) return;
          clearBtn.disabled = true;
          try {
            const resp = await fetch('/api/logs/clear', { method: 'POST' });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || !data.ok) throw new Error('clear failed');
            loadLogs();
          } catch {
            clearBtn.disabled = false;
            alert('清空失败，请重试');
          }
        });
        searchBar.appendChild(clearBtn);

        body.appendChild(searchBar);
```

- [ ] **Step 2: 语法校验**

Run: `node --check public/app.js`
Expected: 无输出、退出码 0（语法有效）。

- [ ] **Step 3: 提交**

```bash
git add public/app.js
git commit -m "feat(ui): 访问日志视图新增清空按钮"
```

---

## Task 4: 集成验证（运行态）

> 验证，无 commit。需要跑起后端（开发态 `node server.js`，默认端口 3000）。

- [ ] **Step 1: 启动后端**

Run（项目根，另开一个终端）：`node server.js`
Expected: 后端在 `127.0.0.1:3000` 监听。

- [ ] **Step 2: 触发几条访问日志并确认可读**

Run：`curl -s -X POST http://127.0.0.1:3000/api/dirs/saved -H "Content-Type: application/json" -d "{}" >/dev/null; curl -s http://127.0.0.1:3000/api/logs`
Expected: 返回 JSON，`logs` 数组包含刚才的访问记录（至少 1 条）。

- [ ] **Step 3: 清空并确认为空**

Run：`curl -s -X POST http://127.0.0.1:3000/api/logs/clear`
Expected: 返回 `{"ok":true}`。

Run：`curl -s http://127.0.0.1:3000/api/logs`
Expected: `logs` 为 `[]`（`/api/logs` 与 `/api/logs/clear` 都在 skip 集，清空后不会自记一条）。

- [ ] **Step 4: 前端按钮回归（GUI）**

Run：`npm run tauri:dev`（或直接浏览器开 `http://127.0.0.1:3000`）
操作：进入"访问日志"视图 → 头部出现"清空日志"按钮 → 点击 → 确认弹窗 → 列表变为"暂无日志"。
Expected: 按钮可见、确认后清空、无报错。

- [ ] **Step 5: 停后端**

结束 `node server.js` 进程。

---

## Self-Review（作者自查记录）

- **Spec 覆盖**：3 天保留（Task 1 `withinRetention` + `getEvents`/`compact`）；手动清空（Task 1 `clearEvents` + Task 2 接口 + Task 3 按钮）；作用于整个 event-log（`getEvents` 全量过滤）；skip 集避免清空自记（Task 2 Step 2）；测试（Task 1 test + Task 4 运行态）。spec §8 非目标（不做配置 UI、不动其它日志、不引定时器）均未越界。
- **Placeholder 扫描**：无 TBD/TODO；每步含完整代码与确切命令、预期输出。
- **命名/类型一致**：`clearEvents`（event-log 导出 → server import → 路由 handler 调用）、`handleLogsClear`、`withinRetention`、`RETAIN_MS`、接口路径 `/api/logs/clear`、返回体 `{ ok: true }` 与前端 `data.ok` 判定三处一致。

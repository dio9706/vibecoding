# 飞书通知 + 飞书回控 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** web 执行台会话与需求/故障任务都能"激活飞书通知"，结束/完成后推私聊卡片，并支持从飞书回控（会话：补充内容/结束会话；任务：合并到主分支/补充/放弃改动）。

**Architecture:** 通知落在 `runs.js` 的终结监听器（全 provider、全路径唯一收口）与任务的两个 `done` 写入点；卡片按钮 value 自带 convId/taskId，经既有 `card-actions.js` kind 注册表路由，无内存态；飞书进程通过 `http://127.0.0.1:${config.web.port}` 把补充内容注入 web 会话（resume 原 session），前端轮询收件箱上屏并接流。

**Tech Stack:** Node 20 原生 ESM + `node --test`、Agent SDK、`@larksuiteoapi/node-sdk`、无构建的浏览器 ES modules、Playwright（e2e）。

**规则：本项目不做 git 提交**（用户掌控提交时机）。因此每个任务的收尾步骤是"跑测试 + 勾选"，不是 commit。

**Spec:** `docs/superpowers/specs/2026-08-12-feishu-notify-and-remote-control-design.md`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/shared/pending-supplement.js` ★新 | 「等待补充」瞬态（openId → 闭包执行器 + TTL）。内核级，避免插件↔插件互相 import |
| `src/store/conv-notify.js` ★新 | `conv-notify.json`：会话通知登记表 + 注入收件箱 |
| `src/store/runs.js` ★改 | 新增 `registerRunSettleListener` 接缝，四个终结函数广播 |
| `src/integrations/lark.js` ★改 | 新增 `sendCardToUser`（私聊 open_id 发交互卡片） |
| `src/entrypoints/web/conv-notify.logic.js` ★新 | 纯函数：终结过滤、摘要、耗时、会话卡片构造 |
| `src/entrypoints/web/conv-notify.js` ★新 | 注册终结监听器 → 发通知；`injectToConv` 注入编排 |
| `src/entrypoints/web/routes-conv-notify.js` ★新 | `/api/conv-notify/{on,off,sync,inbox,claim,inject}` |
| `src/entrypoints/web/server.js` ★改 | 挂路由 + `startConvNotify()` |
| `src/plugins/feishu-relay/logic.js` ★新 | 纯函数：卡片回调解析、文本指令、权限 |
| `src/plugins/feishu-relay/index.js` ★新 | order 16 feature + `conv-settled` 卡片处理器 + HTTP 直送 |
| `src/plugins/index.js` ★改 | MANIFEST 登记 `feishu-relay` |
| `src/plugins/team-tools/task-actions.js` ★新 | merge/discard 共享编排（从 routes-ops 抽出）+ `isAwaitingMerge` |
| `src/plugins/team-tools/task-notify.logic.js` ★新 | 纯函数：任务卡片构造/解析 |
| `src/plugins/team-tools/task-notify.js` ★新 | `notifyTaskDone` + `task-done` 卡片处理器 |
| `src/plugins/team-tools/auto-dev/index.js` ★改 | done 写入后通知 |
| `src/plugins/team-tools/task-ops.js` ★改 | 轻度托管 done 写入后通知 |
| `src/entrypoints/web/routes-ops.js` ★改 | merge/discard 改薄壳 |
| `src/store/settings.js` / `routes-settings.js` ★改 | `uiPrefs.taskNotifyFeishu` |
| `public/index.html` / `app.css` ★改 | `#fabRow` 内通知按钮 + 激活态样式 |
| `public/js/conv-notify.js` ★新 | 按钮绑定 + 收件箱轮询（`bindConvNotify` 注入范式） |
| `public/js/chat.js` ★改 | 三处接缝：还原按钮态、session 事件 sync、注入上屏 |
| `public/js/tasks-panel.js` ★改 | 筛选条飞书通知 chip |
| `tests/e2e-conv-notify.mjs` ★新 | e2e：按钮开合/还原 + 收件箱上屏（stub fetch） |

**契约（跨任务共享，改名即为 bug）**

```js
// 卡片按钮 value
{ kind: 'conv-settled', convId, action: 'supplement' | 'end' }
{ kind: 'task-done',    taskId, action: 'merge' | 'supplement' | 'discard' }

// conv-notify.json 单条
{ convId, title, session, cwd, model, effort, mode, enabledAt, lastNotifiedAt,
  inbox: [{ id, text, runId, mode: 'steer'|'run', at }] }

// 会话激活标记存在会话 meta 里（复用 conv-store 守护 API convSetMeta）
conv.meta.notifyFeishu === true
```

---

## P1 内核与基建

### Task 1: 等待补充挂起态（`pending-supplement.js`）

**Files:**
- Create: `src/shared/pending-supplement.js`
- Test: `src/shared/pending-supplement.test.js`

- [ ] **Step 1: 写失败测试**

```js
// src/shared/pending-supplement.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armSupplement, peekSupplement, takeSupplement, clearSupplement } from './pending-supplement.js';

test('arm 后可 peek 到，label 与执行器都在', () => {
  armSupplement('ou_a', { label: '会话《测试》', onText: async (t) => t });
  const e = peekSupplement('ou_a');
  assert.equal(e.label, '会话《测试》');
  assert.equal(typeof e.onText, 'function');
  clearSupplement('ou_a');
});

test('take 取走后即清空（一次性）', async () => {
  armSupplement('ou_b', { label: 'x', onText: async () => 'ran' });
  const e = takeSupplement('ou_b');
  assert.equal(await e.onText(), 'ran');
  assert.equal(peekSupplement('ou_b'), null);
});

test('TTL 过期不命中，且顺手清理', () => {
  armSupplement('ou_c', { label: 'x', onText: async () => {}, ttlMs: -1 });
  assert.equal(peekSupplement('ou_c'), null);
  assert.equal(takeSupplement('ou_c'), null);
});

test('同一 openId 后 arm 覆盖前 arm（单槽）', async () => {
  armSupplement('ou_d', { label: '旧', onText: async () => '旧' });
  armSupplement('ou_d', { label: '新', onText: async () => '新' });
  const e = takeSupplement('ou_d');
  assert.equal(e.label, '新');
  assert.equal(await e.onText(), '新');
});

test('clear 幂等，未 arm 时 peek/take 返回 null', () => {
  clearSupplement('ou_never');
  assert.equal(peekSupplement('ou_never'), null);
  assert.equal(takeSupplement('ou_never'), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/shared/pending-supplement.test.js`
Expected: FAIL —— `Cannot find module ... pending-supplement.js`

- [ ] **Step 3: 实现**

```js
// src/shared/pending-supplement.js
/**
 * 「等待补充内容」瞬态 —— 点了卡片上的「补充内容/补充」后，等用户下一条消息。
 *
 * 为什么可以是内存态：卡片本身无状态（按钮 value 自带 convId/taskId，重启后仍有效），
 * 这里只存「现在在等谁的下一句话、拿到后干什么」。进程重启丢失的后果由两条路兜住：
 * 会话域有文本兜底（「补充内容 xxx」），任务域重新点一次按钮即可。
 *
 * 为什么放内核（shared/）而不是插件里：会话域（feishu-relay）与任务域（team-tools）
 * 都要用它，插件之间禁止互相 import（同 card-actions.js 的处置）。
 * 执行器以闭包（onText）由 arm 的一方提供 → 消费方对 convs/tasks 一无所知。
 */
const pending = new Map(); // openId -> { openId, label, onText, expiresAt }

export const SUPPLEMENT_TTL_MS = 10 * 60 * 1000;

/** 登记等待态；同一 openId 单槽，后来者覆盖（用户连点两张卡片时以最后一次为准） */
export function armSupplement(openId, { label, onText, ttlMs = SUPPLEMENT_TTL_MS }) {
  if (!openId || typeof onText !== 'function') return null;
  const entry = { openId, label: label || '', onText, expiresAt: Date.now() + ttlMs };
  pending.set(openId, entry);
  return entry;
}

/** 只看不取（dispatch 的 hasPending 用）；过期顺手清理 */
export function peekSupplement(openId) {
  const e = pending.get(openId);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) {
    pending.delete(openId);
    return null;
  }
  return e;
}

/** 取走并清空（handle 用）：必须一次性，否则用户下一句闲聊会被再次当成补充内容 */
export function takeSupplement(openId) {
  const e = peekSupplement(openId);
  if (e) pending.delete(openId);
  return e;
}

export function clearSupplement(openId) {
  pending.delete(openId);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/shared/pending-supplement.test.js`
Expected: `# pass 5`

---

### Task 2: 会话通知登记表（`store/conv-notify.js`）

**Files:**
- Create: `src/store/conv-notify.js`
- Test: `src/store/conv-notify.test.js`
- Modify: `.gitignore`

- [ ] **Step 1: 写失败测试**

```js
// src/store/conv-notify.test.js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// store/index.js 在 import 时读 APP_DATA_DIR，必须在 import 之前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'convnotify-'));

let m;
before(async () => {
  m = await import('./conv-notify.js');
});

test('enable → getEntry 拿到快照字段', () => {
  m.enableConv({ convId: 'c1', title: 'T', session: 's1', cwd: 'C:\\p', model: 'auto', effort: 'medium', mode: 'default' });
  const e = m.getEntry('c1');
  assert.equal(e.session, 's1');
  assert.equal(e.mode, 'default');
  assert.ok(e.enabledAt);
  assert.deepEqual(e.inbox, []);
});

test('patch 局部更新，不动 inbox', () => {
  m.pushInjection('c1', { id: 'i1', text: 'x', runId: 'r1', mode: 'run', at: 1 });
  m.patchConv('c1', { session: 's2', lastNotifiedAt: '2026-08-12T00:00:00.000Z' });
  const e = m.getEntry('c1');
  assert.equal(e.session, 's2');
  assert.equal(e.inbox.length, 1);
});

test('inbox 上限 20，超限丢最旧', () => {
  for (let i = 0; i < 25; i++) m.pushInjection('c1', { id: 'x' + i, text: 't', runId: 'r', mode: 'run', at: i });
  const e = m.getEntry('c1');
  assert.equal(e.inbox.length, m.INBOX_MAX);
  assert.equal(e.inbox[e.inbox.length - 1].id, 'x24');
  assert.ok(!e.inbox.some((it) => it.id === 'i1'));
});

test('claim 只删指定 id', () => {
  const ids = m.getEntry('c1').inbox.slice(0, 3).map((i) => i.id);
  m.claimInjections('c1', ids);
  const left = m.getEntry('c1').inbox.map((i) => i.id);
  assert.equal(left.length, m.INBOX_MAX - 3);
  for (const id of ids) assert.ok(!left.includes(id));
});

test('pickLatestNotified 取窗口内最近通知过的一条', () => {
  m.enableConv({ convId: 'c2', title: 'T2', session: 's', cwd: 'C:\\p', model: 'auto', effort: 'medium', mode: 'default' });
  m.patchConv('c1', { lastNotifiedAt: new Date(1000).toISOString() });
  m.patchConv('c2', { lastNotifiedAt: new Date(5000).toISOString() });
  assert.equal(m.pickLatestNotified(10_000, 6000)?.convId, 'c2');
  assert.equal(m.pickLatestNotified(500, 6000), null); // 窗口太窄，全部超龄
});

test('disable 连带丢弃未认领的注入项', () => {
  m.disableConv('c1');
  assert.equal(m.getEntry('c1'), null);
});

test('对未登记会话的写操作是安全 no-op', () => {
  assert.equal(m.pushInjection('nope', { id: 'a', text: 't', runId: 'r', mode: 'run', at: 1 }), null);
  assert.equal(m.patchConv('nope', { session: 'x' }), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/conv-notify.test.js`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现**

```js
// src/store/conv-notify.js
/**
 * 会话飞书通知登记表 —— 哪些 web 会话开了「任务结束/失败推飞书」，以及飞书补充内容的收件箱。
 *
 * 为什么服务端必须存 session/cwd 快照：普通聊天会话的 session 权威副本只在前端 localStorage
 * （conv-store.js），服务端没有 convId→session 的长期映射。飞书侧要把补充内容 resume 回原会话，
 * 只能靠激活时前端上报的这份快照 —— 这也是本表存在的根本理由。
 *
 * 跨进程：web 写、飞书进程读（判断会话是否激活、文本兜底选目标会话），
 * 一律走 updateJson（<file>.lock 文件锁），不得裸 readJson→writeJson。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'conv-notify.json';

/** 收件箱上限：飞书补充是人工节奏，20 条足够；超限丢最旧，防异常刷爆文件 */
export const INBOX_MAX = 20;

export function getAll() {
  return readJson(FILE, {});
}

export function getEntry(convId) {
  if (!convId) return null;
  return getAll()[convId] || null;
}

/** 激活（幂等）：已存在则更新快照并保留 inbox 与 enabledAt */
export function enableConv({ convId, title, session, cwd, model, effort, mode }) {
  if (!convId) return null;
  return updateJson(FILE, {}, (cur) => {
    const prev = cur[convId] || {};
    cur[convId] = {
      convId,
      title: title || prev.title || '',
      session: session || prev.session || '',
      cwd: cwd || prev.cwd || '',
      model: model || prev.model || 'auto',
      effort: effort || prev.effort || 'medium',
      mode: mode || prev.mode || 'default',
      enabledAt: prev.enabledAt || new Date().toISOString(),
      lastNotifiedAt: prev.lastNotifiedAt || null,
      inbox: Array.isArray(prev.inbox) ? prev.inbox : [],
    };
    return cur;
  })[convId];
}

/** 取消激活：连带丢弃未认领的注入项（用户已明确不想要这条链路了） */
export function disableConv(convId) {
  if (!convId) return;
  updateJson(FILE, {}, (cur) => {
    if (!cur[convId]) return undefined; // 无变更，不写盘
    delete cur[convId];
    return cur;
  });
}

/** 局部更新快照字段；未登记会话是 no-op（不能凭空建条目，否则取消激活后又被 sync 复活） */
export function patchConv(convId, patch) {
  if (!convId) return null;
  const next = updateJson(FILE, {}, (cur) => {
    if (!cur[convId]) return undefined;
    cur[convId] = { ...cur[convId], ...patch, convId, inbox: cur[convId].inbox };
    return cur;
  });
  return next[convId] || null;
}

export function pushInjection(convId, item) {
  if (!convId) return null;
  const next = updateJson(FILE, {}, (cur) => {
    const e = cur[convId];
    if (!e) return undefined;
    e.inbox = [...(e.inbox || []), item].slice(-INBOX_MAX);
    return cur;
  });
  return next[convId] || null;
}

export function claimInjections(convId, ids) {
  const set = new Set(Array.isArray(ids) ? ids : []);
  if (!convId || !set.size) return null;
  const next = updateJson(FILE, {}, (cur) => {
    const e = cur[convId];
    if (!e) return undefined;
    e.inbox = (e.inbox || []).filter((it) => !set.has(it.id));
    return cur;
  });
  return next[convId] || null;
}

/**
 * 文本兜底用：最近 maxAgeMs 内被通知过的那个会话。
 * 机器人重启丢了等待态时，用户直接发「补充内容 xxx」就落到这里。
 * @param {number} maxAgeMs 窗口
 * @param {number} [nowMs] 便于测试注入
 */
export function pickLatestNotified(maxAgeMs, nowMs = Date.now()) {
  let best = null;
  for (const e of Object.values(getAll())) {
    if (!e.lastNotifiedAt) continue;
    const t = Date.parse(e.lastNotifiedAt);
    if (Number.isNaN(t) || nowMs - t > maxAgeMs) continue;
    if (!best || t > Date.parse(best.lastNotifiedAt)) best = e;
  }
  return best;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/conv-notify.test.js`
Expected: `# pass 7`

- [ ] **Step 5: 加 gitignore**

在 `.gitignore` 的 `pending-resume.json` 一行下方插入：

```
conv-notify.json
```

---

### Task 3: run 终结监听器接缝（`runs.js`）

**Files:**
- Modify: `src/store/runs.js`（`finishRun`/`failRun`/`blockRun`/`stopRun` 四处 + 新增导出）
- Test: `src/store/runs.test.js`（追加两例）

- [ ] **Step 1: 写失败测试（追加到 `runs.test.js` 末尾）**

```js
test('终结监听器：finishRun 触发一次，带 subtype', () => {
  const seen = [];
  registerRunSettleListener((r) => seen.push({ id: r.id, subtype: r.subtype, status: r.status }));
  const run = createRun();
  run.convId = 'c_listener';
  finishRun(run);
  finishRun(run); // 幂等：status 已非 running，不得二次广播
  const mine = seen.filter((s) => s.id === run.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'done');
});

test('终结监听器：stopRun 带 subtype=stopped（供通知侧过滤）', () => {
  const seen = [];
  registerRunSettleListener((r) => seen.push(r));
  const run = createRun();
  stopRun(run, '已手动停止');
  const mine = seen.filter((r) => r.id === run.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].subtype, 'stopped');
});
```

同时把 `registerRunSettleListener`、`finishRun`、`stopRun` 加进该测试文件顶部的 import 列表。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/runs.test.js`
Expected: FAIL —— `registerRunSettleListener is not a function` / 不是有效导出

- [ ] **Step 3: 实现（`src/store/runs.js`）**

在 `unsentField(run)` 定义之后、`finishRun` 之前插入：

```js
/**
 * run 终结广播 —— 通知等旁路关注方的唯一接缝。
 *
 * 为什么在 store 层而不是 run-claude 的 settleRun：settleRun 只覆盖 Claude provider，
 * 且额度撞墙分支会提前 return；而下面四个终结函数是**全 provider（含 openai-compat）、
 * 全路径（正常/异常/看门狗/手动停止/额度阻塞）**的唯一收口，且都先判 status!=='running' 早退
 * → 每个 run 只广播一次，天然无重复。
 *
 * 层级纪律：store 不 import 业务模块（lark/settings），监听器由上层注册。
 * 监听器异常必须吞掉：绝不能让一个通知失败影响 run 的收尾与 SSE 广播。
 */
const settleListeners = [];

export function registerRunSettleListener(fn) {
  if (typeof fn === 'function') settleListeners.push(fn);
}

function emitSettled(run) {
  for (const fn of settleListeners) {
    try {
      fn(run);
    } catch (e) {
      logger.warn('runs', 'run 终结监听器异常（已忽略）', { runId: run.id, err: e?.message || String(e) });
    }
  }
}
```

然后在四个终结函数的 **`closeAll(run);` 之后**各加一行 `emitSettled(run);`：`finishRun`、`failRun`、`blockRun`、`stopRun`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/runs.test.js`
Expected: 全部通过（原有用例 + 新增 2 例）

---

### Task 4: 私聊发交互卡片（`lark.sendCardToUser`）

**Files:**
- Modify: `src/integrations/lark.js`（紧跟 `sendTextToUser` 之后）

- [ ] **Step 1: 实现**

```js
/**
 * 使用指定机器人凭证向用户 open_id 发送**交互卡片**（私聊）。
 * 与 sendTextToUser 同构（临时 client，不动全局 singleton），补上「私聊发卡片」这个缺口：
 * 既有的 sendCard 只能发 chat_id 且用全局启用机器人的凭证。
 * 失败不抛，返回 null —— 调用方据此降级发纯文本。
 * @returns {Promise<string|null>} message_id
 */
export async function sendCardToUser(botCreds, openId, cardContent) {
  if (!botCreds?.appId || !botCreds?.appSecret) {
    logger.warn('lark', '机器人凭证不完整，跳过卡片通知', { openId });
    return null;
  }
  if (!openId) {
    logger.warn('lark', '目标 open_id 为空，跳过卡片通知');
    return null;
  }
  try {
    const tempClient = new Lark.Client({ appId: botCreds.appId, appSecret: botCreds.appSecret });
    const r = await tempClient.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        content: JSON.stringify(cardContent),
        msg_type: 'interactive',
      },
    });
    logger.info('lark', '已发送卡片通知给用户', { openId });
    // code-gen client 可能已剥外层信封（对齐 sendCard 的兜底写法）
    return r?.data?.message_id || r?.message_id || null;
  } catch (e) {
    logger.warn('lark', '发送卡片通知失败（调用方将降级纯文本）', { openId, err: e?.message || String(e) });
    return null;
  }
}
```

- [ ] **Step 2: 语法自检**

Run: `node --check src/integrations/lark.js`
Expected: 无输出

- [ ] **Step 3: 跑全量测试确认零回归**

Run: `npm test`
Expected: 全绿（新增 12 例：Task 1 的 5 + Task 2 的 7；Task 3 的 2 例并入 runs.test.js）

---

## P2 会话域：通知发送与注入（web 进程）

### Task 5: 会话卡片纯函数（`conv-notify.logic.js`）

**Files:**
- Create: `src/entrypoints/web/conv-notify.logic.js`
- Test: `src/entrypoints/web/conv-notify.logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
// src/entrypoints/web/conv-notify.logic.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONV_CARD_KIND,
  shouldNotifySettle,
  summarize,
  formatDuration,
  buildConvSettledCard,
} from './conv-notify.logic.js';

test('shouldNotifySettle：正常完成与异常失败要通知', () => {
  assert.equal(shouldNotifySettle({ status: 'done', subtype: null }), true);
  assert.equal(shouldNotifySettle({ status: 'error', subtype: 'exception', is_error: true }), true);
});

test('shouldNotifySettle：手动停止与额度阻塞不通知', () => {
  assert.equal(shouldNotifySettle({ status: 'done', subtype: 'stopped' }), false);
  assert.equal(shouldNotifySettle({ status: 'done', subtype: 'quota_blocked' }), false);
});

test('shouldNotifySettle：还在跑的 run 不通知（纵深防御）', () => {
  assert.equal(shouldNotifySettle({ status: 'running' }), false);
});

test('summarize 截断并加省略号，短文本原样', () => {
  assert.equal(summarize('abc', 10), 'abc');
  assert.equal(summarize('a'.repeat(20), 10), 'a'.repeat(10) + '…');
  assert.equal(summarize('', 10), '(无输出)');
  assert.equal(summarize(null, 10), '(无输出)');
});

test('formatDuration：秒/分', () => {
  assert.equal(formatDuration(1500), '1s');
  assert.equal(formatDuration(95_000), '1m 35s');
});

test('buildConvSettledCard：两个按钮 + value 契约', () => {
  const card = buildConvSettledCard(
    { convId: 'c1', title: '重构登录页', mode: 'acceptEdits' },
    { status: 'done', is_error: false, text: 'ok', startedAt: 0, updatedAt: 1000 },
  );
  const actions = card.elements.find((e) => e.tag === 'action').actions;
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0].value, { kind: CONV_CARD_KIND, convId: 'c1', action: 'supplement' });
  assert.deepEqual(actions[1].value, { kind: CONV_CARD_KIND, convId: 'c1', action: 'end' });
  assert.match(card.elements[0].text.content, /重构登录页/);
  assert.match(card.elements[0].text.content, /✅/);
});

test('buildConvSettledCard：失败标 ❌；询问模式加审批提示', () => {
  const card = buildConvSettledCard(
    { convId: 'c1', title: 'T', mode: 'default' },
    { status: 'error', is_error: true, text: 'boom', startedAt: 0, updatedAt: 1000 },
  );
  const content = card.elements[0].text.content;
  assert.match(content, /❌/);
  assert.match(content, /询问模式/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/conv-notify.logic.test.js`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现**

```js
// src/entrypoints/web/conv-notify.logic.js
/**
 * 会话通知的纯函数层（无 I/O，可单测）。
 * 卡片**只在 web 侧构造**，飞书侧只解析按钮 value —— 两侧靠 value 契约耦合，
 * 不共享构造代码（web 进程不 import 插件模块，插件也不 import web 入口模块）。
 */
export const CONV_CARD_KIND = 'conv-settled';

/**
 * 该 run 的终结要不要推飞书。
 * - stopped：用户自己刚点的停止，再推一条纯属噪音
 * - quota_blocked：额度撞墙会自动续跑，任务逻辑上没结束（续跑真终结时才推）
 */
export function shouldNotifySettle(run) {
  if (!run || run.status === 'running') return false;
  return !['stopped', 'quota_blocked'].includes(run.subtype);
}

export function summarize(text, max = 300) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return '(无输出)';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function formatDuration(ms) {
  const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/** 会话终结通知卡片：标题 + 结果 + 耗时 + 摘要 + [补充内容][结束会话] */
export function buildConvSettledCard(entry, run) {
  const ok = !run.is_error && run.status !== 'error';
  const head = ok ? '✅ **任务已完成**' : '❌ **任务失败**';
  const dur = formatDuration((run.updatedAt || Date.now()) - (run.startedAt || Date.now()));
  // 询问模式下注入的补充内容会卡在权限审批上等人 —— 提前说清楚，别让用户在飞书干等
  const askHint =
    entry.mode === 'default'
      ? '\n\n⚠️ 该会话为「询问」权限模式，补充内容若触发改码工具会等待网页端审批。'
      : '';
  return {
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${head}\n会话：「${entry.title || entry.convId}」 · 耗时 ${dur}\n\n${summarize(run.text)}${askHint}`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📝 补充内容' },
            type: 'primary',
            value: { kind: CONV_CARD_KIND, convId: entry.convId, action: 'supplement' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🛑 结束会话' },
            type: 'default',
            value: { kind: CONV_CARD_KIND, convId: entry.convId, action: 'end' },
          },
        ],
      },
    ],
  };
}

/** 点击后的终态卡片（按钮消失，只留结果） */
export function convResultCard(text) {
  return { elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }] };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/conv-notify.logic.test.js`
Expected: `# pass 7`

---

### Task 6: 通知发送与注入编排（`conv-notify.js`）

**Files:**
- Create: `src/entrypoints/web/conv-notify.js`

- [ ] **Step 1: 实现**

```js
// src/entrypoints/web/conv-notify.js
/**
 * 会话飞书通知：run 终结 → 推私聊卡片；飞书补充内容 → 注入回原会话。
 *
 * 通知落点是 store/runs.js 的终结监听器（全 provider、全路径唯一收口），
 * 不是 run-claude 的 settleRun（只覆盖 Claude，且额度分支提前 return）。
 * 全链路 fire-and-forget + 三层兜底：通知失败绝不能影响 run 收尾。
 */
import { registerRunSettleListener, createRun, hasActiveRunForConv, getRun, holdMsg } from '../../store/runs.js';
import { getEntry, patchConv, pushInjection } from '../../store/conv-notify.js';
import { getMyFeishuOpenId, getActiveBot } from '../../store/settings.js';
import { sendCardToUser, sendTextToUser } from '../../integrations/lark.js';
import { logger } from '../../shared/logger.js';
import { startClaudeRun } from './run-claude.js';
import { buildConvSettledCard, shouldNotifySettle, summarize } from './conv-notify.logic.js';

/** 注册终结监听器。由 server.js 在 listen 回调里显式调用（与 startAutoDevPump 同范式） */
export function startConvNotify() {
  registerRunSettleListener(onRunSettled);
  logger.info('conv-notify', '会话飞书通知监听器已注册');
}

function onRunSettled(run) {
  try {
    if (!run?.convId) return;
    if (!shouldNotifySettle(run)) return;
    const entry = getEntry(run.convId);
    if (!entry) return; // 该会话没开通知
    const openId = getMyFeishuOpenId();
    if (!openId) {
      logger.info('conv-notify', '未配置 myFeishuOpenId，跳过通知', { convId: run.convId });
      return;
    }
    const bot = getActiveBot();
    if (!bot?.appId || !bot?.appSecret) {
      logger.info('conv-notify', '无启用中的机器人或凭证不全，跳过通知', { convId: run.convId });
      return;
    }
    const creds = { appId: bot.appId, appSecret: bot.appSecret };
    const card = buildConvSettledCard(entry, run);
    sendCardToUser(creds, openId, card)
      .then((mid) => {
        // 卡片发送失败（返回 null）→ 降级纯文本，并把文本指令说明带上
        if (mid) return;
        const ok = !run.is_error && run.status !== 'error';
        return sendTextToUser(
          creds,
          openId,
          `${ok ? '✅ 任务已完成' : '❌ 任务失败'}\n会话：「${entry.title || entry.convId}」\n\n${summarize(run.text)}\n\n回复「补充内容 <你的补充>」可继续该会话；回复「结束会话」则不做动作。`,
        );
      })
      .then(() => patchConv(run.convId, { lastNotifiedAt: new Date().toISOString() }))
      .catch((e) => logger.warn('conv-notify', '通知发送异常（已捕获）', { convId: run.convId, err: e?.message || String(e) }));
  } catch (e) {
    logger.warn('conv-notify', '通知准备失败（已捕获）', { err: e?.message || String(e) });
  }
}

/**
 * 把一段文本注入某会话：有活跃 run 走插话持有，否则 resume 原 session 新起一轮。
 * @returns {{ok:true, runId:string, mode:'steer'|'run'} | {ok:false, code:number, error:string}}
 */
export function injectToConv(convId, text) {
  const entry = getEntry(convId);
  if (!entry) return { ok: false, code: 404, error: '该会话未激活飞书通知' };
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return { ok: false, code: 400, error: '补充内容为空' };

  if (hasActiveRunForConv(convId)) {
    // 复用既有插话通道：run.steerHold 为真时消息进持有区，SDK 空档期自动发出
    const running = [...listRunningForConv(convId)][0];
    if (running && running.steerHold) {
      const msg = holdMsg(running, body);
      const item = { id: msg?.id || 'inj_' + Date.now().toString(36), text: body, runId: running.id, mode: 'steer', at: Date.now() };
      pushInjection(convId, item);
      logger.info('conv-notify', '补充内容已插话', { convId, runId: running.id });
      return { ok: true, runId: running.id, mode: 'steer' };
    }
  }

  const run = createRun();
  run.convId = convId;
  startClaudeRun(run, {
    prompt: body,
    cwd: entry.cwd,
    session: entry.session || undefined, // 无 session 则等价开新上下文，仍照常执行
    model: entry.model,
    effort: entry.effort,
    mode: entry.mode, // 不静默提权：沿用会话自己的权限模式
    convId,
  });
  pushInjection(convId, { id: 'inj_' + run.id, text: body, runId: run.id, mode: 'run', at: Date.now() });
  logger.info('conv-notify', '补充内容已起新 run', { convId, runId: run.id, mode: entry.mode });
  return { ok: true, runId: run.id, mode: 'run' };
}

/** 取该会话下仍在跑的 run（runs.js 未导出遍历接口，这里按 id 反查一次） */
function* listRunningForConv(convId) {
  for (const id of listRunIds()) {
    const r = getRun(id);
    if (r && r.convId === convId && r.status === 'running') yield r;
  }
}
```

**注意**：`listRunIds` 与 `holdMsg` 若 `runs.js` 未导出，需在 `runs.js` 补导出（`holdMsg` 已被 `routes-run.js` 使用，确认其导出名；`listRunIds` 若不存在，改为在 `runs.js` 新增 `export function findRunningRunByConv(convId)`，并把上面 `listRunningForConv` 整段替换为直接调用它）。**实施时先 grep 确认，优先复用既有导出，不要重复造遍历。**

- [ ] **Step 2: 确认 runs.js 的导出名并对齐**

Run: `grep -n "^export function \(holdMsg\|hasActiveRunForConv\|getRun\|createRun\)" src/store/runs.js`
Expected: 列出这几个导出；若 `holdMsg` 名称不同（如 `holdMessage`），按实际名改上面的 import 与调用。

若没有「按 convId 找运行中 run」的现成导出，在 `runs.js` 的 `hasActiveRunForConv` 之后补：

```js
/** 取该会话当前运行中的 run（供服务端注入判断走插话还是新起一轮） */
export function findRunningRunByConv(convId) {
  if (!convId) return null;
  for (const r of runs.values()) if (r.convId === convId && r.status === 'running') return r;
  return null;
}
```

并把 `conv-notify.js` 里的 `listRunningForConv` 生成器整段删除，改为 `const running = findRunningRunByConv(convId);`。

- [ ] **Step 3: 语法自检**

Run: `node --check src/entrypoints/web/conv-notify.js`
Expected: 无输出

---

### Task 7: 会话通知路由（`routes-conv-notify.js` + server 接线）

**Files:**
- Create: `src/entrypoints/web/routes-conv-notify.js`
- Modify: `src/entrypoints/web/server.js`

- [ ] **Step 1: 实现路由模块**

```js
// src/entrypoints/web/routes-conv-notify.js
/**
 * 会话飞书通知路由。
 * /on /off /sync /inbox /claim 由前端调用；/inject 由**飞书进程**跨进程调用
 * （同机回环；origin 守卫对无 Origin 头放行，见 origin.js 注释）。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { getEntry, enableConv, disableConv, patchConv, claimInjections } from '../../store/conv-notify.js';
import { getMyFeishuOpenId, getActiveBot } from '../../store/settings.js';
import { injectToConv } from './conv-notify.js';

const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function handleConvNotifyRoutes(req, res, url) {
  const p = url.pathname;
  if (p === '/api/conv-notify/on') return handleOn(req, res);
  if (p === '/api/conv-notify/off') return handleOff(req, res);
  if (p === '/api/conv-notify/sync') return handleSync(req, res);
  if (p === '/api/conv-notify/inbox') return handleInbox(res, url);
  if (p === '/api/conv-notify/claim') return handleClaim(req, res);
  if (p === '/api/conv-notify/inject') return handleInject(req, res);
  return false; // 未命中：交回 server.js 继续匹配
}

function handleOn(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const convId = str(data.convId);
    if (!convId) return sendJson(res, 400, { error: '缺少 convId' });
    // 前置校验：缺任一前提就别点亮按钮，避免用户以为开了其实收不到
    if (!getMyFeishuOpenId()) {
      return sendJson(res, 200, { ok: false, error: '请先到设置页填写「我的飞书 open_id」' });
    }
    const bot = getActiveBot();
    if (!bot?.appId || !bot?.appSecret) {
      return sendJson(res, 200, { ok: false, error: '请先在设置页启用一个飞书机器人并填全凭证' });
    }
    const entry = enableConv({
      convId,
      title: str(data.title),
      session: str(data.session),
      cwd: str(data.cwd),
      model: str(data.model) || 'auto',
      effort: str(data.effort) || 'medium',
      mode: str(data.mode) || 'default',
    });
    return sendJson(res, 200, { ok: true, entry });
  });
}

function handleOff(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    disableConv(str(data.convId));
    return sendJson(res, 200, { ok: true });
  });
}

function handleSync(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const convId = str(data.convId);
    const patch = {};
    for (const k of ['title', 'session', 'cwd', 'model', 'effort', 'mode']) {
      const v = str(data[k]);
      if (v) patch[k] = v;
    }
    // 未激活会话是 no-op（patchConv 自带守卫）：取消激活后不会被 sync 复活
    const entry = patchConv(convId, patch);
    return sendJson(res, 200, { ok: true, active: !!entry });
  });
}

function handleInbox(res, url) {
  const convId = str(url.searchParams.get('convId'));
  const entry = getEntry(convId);
  return sendJson(res, 200, { active: !!entry, items: entry?.inbox || [] });
}

function handleClaim(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    claimInjections(str(data.convId), Array.isArray(data.ids) ? data.ids : []);
    return sendJson(res, 200, { ok: true });
  });
}

function handleInject(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  return withJsonBody(req, res, (data) => {
    const r = injectToConv(str(data.convId), data.text);
    if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error });
    return sendJson(res, 200, r);
  });
}
```

- [ ] **Step 2: 确认 body.js 的导出名**

Run: `grep -n "^export" src/entrypoints/web/body.js`
Expected: 至少有 `readJsonBody`；若没有 `withJsonBody`，改用 `readJsonBody` 的形态（参考 `routes-ops.js` 里 `handleTaskAction` 的现成写法，逐字对齐该文件的调用范式）。

- [ ] **Step 3: 接线 server.js**

在路由表里（`/api/tasks/action` 一行附近）加：

```js
  if (url.pathname.startsWith('/api/conv-notify/')) {
    const handled = handleConvNotifyRoutes(req, res, url);
    if (handled !== false) return handled;
  }
```

顶部加 import：

```js
import { handleConvNotifyRoutes } from './routes-conv-notify.js';
import { startConvNotify } from './conv-notify.js';
```

在 `server.listen` 回调里、`startRequirementPump();` 之后加：

```js
    startConvNotify(); // 会话飞书通知：注册 run 终结监听器
```

- [ ] **Step 4: 端到端手测（不烧额度）**

Run（起服务后另开一个终端）：

```bash
curl -s -X POST http://127.0.0.1:3000/api/conv-notify/on -H "Content-Type: application/json" -d "{\"convId\":\"c_test\",\"title\":\"T\",\"cwd\":\"C:\\\\tmp\"}"
curl -s "http://127.0.0.1:3000/api/conv-notify/inbox?convId=c_test"
curl -s -X POST http://127.0.0.1:3000/api/conv-notify/off -H "Content-Type: application/json" -d "{\"convId\":\"c_test\"}"
```

Expected: 第一条回 `{"ok":true,...}`（若未配 openId/机器人则回 `{"ok":false,"error":"请先..."}`，也算通过——说明前置校验生效）；第二条回 `{"active":true,"items":[]}`；第三条回 `{"ok":true}`，之后再查 inbox 应为 `{"active":false,"items":[]}`。

- [ ] **Step 5: 跑全量测试**

Run: `npm test`
Expected: 全绿

---

## P3 飞书回控（会话域）

### Task 8: 回控纯函数（`feishu-relay/logic.js`）

**Files:**
- Create: `src/plugins/feishu-relay/logic.js`
- Test: `src/plugins/feishu-relay/logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
// src/plugins/feishu-relay/logic.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONV_CARD_KIND, parseConvCardAction, matchSupplementText, isEndSessionText, canOperateRelay } from './logic.js';

test('parseConvCardAction：对象 value 正常解析', () => {
  const r = parseConvCardAction({
    action: { value: { kind: CONV_CARD_KIND, convId: 'c1', action: 'supplement' } },
    operator: { open_id: 'ou_1' },
    context: { open_message_id: 'om_1' },
  });
  assert.deepEqual(r, { convId: 'c1', action: 'supplement', operatorOpenId: 'ou_1', messageId: 'om_1' });
});

test('parseConvCardAction：JSON 字符串 value 也认；顶层 message_id 兜底', () => {
  const r = parseConvCardAction({
    action: { value: JSON.stringify({ kind: CONV_CARD_KIND, convId: 'c2', action: 'end' }) },
    operator: { open_id: 'ou_2' },
    message_id: 'om_2',
  });
  assert.equal(r.convId, 'c2');
  assert.equal(r.action, 'end');
  assert.equal(r.messageId, 'om_2');
});

test('parseConvCardAction：别的 kind / 畸形 / 未知 action 一律 null', () => {
  assert.equal(parseConvCardAction({ action: { value: { kind: 'review-verdict', taskId: 't' } } }), null);
  assert.equal(parseConvCardAction({ action: { value: '不是json' } }), null);
  assert.equal(parseConvCardAction({ action: { value: { kind: CONV_CARD_KIND, convId: 'c', action: 'drop' } } }), null);
  assert.equal(parseConvCardAction(null), null);
});

test('matchSupplementText：只匹配开头，且要有非空正文', () => {
  assert.equal(matchSupplementText('补充内容 把按钮改成蓝色'), '把按钮改成蓝色');
  assert.equal(matchSupplementText('补充内容：再加一个筛选'), '再加一个筛选');
  assert.equal(matchSupplementText('补充内容'), null); // 只发前缀不算
  assert.equal(matchSupplementText('补充内容   '), null);
  assert.equal(matchSupplementText('我补充内容如下：xxx'), null); // 不在开头
  assert.equal(matchSupplementText(''), null);
  assert.equal(matchSupplementText(null), null);
});

test('isEndSessionText：trim 后全等才算', () => {
  assert.equal(isEndSessionText(' 结束会话 '), true);
  assert.equal(isEndSessionText('结束会话吧'), false);
  assert.equal(isEndSessionText('请结束会话'), false);
});

test('canOperateRelay：本人/owner/可信名单放行，其他人拒绝', () => {
  const opts = { myOpenId: 'ou_me', ownerOpenIds: ['ou_owner'], trustedOpenIds: ['ou_trust'] };
  assert.equal(canOperateRelay('ou_me', opts), true);
  assert.equal(canOperateRelay('ou_owner', opts), true);
  assert.equal(canOperateRelay('ou_trust', opts), true);
  assert.equal(canOperateRelay('ou_other', opts), false);
  assert.equal(canOperateRelay('', opts), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/feishu-relay/logic.test.js`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现**

```js
// src/plugins/feishu-relay/logic.js
/**
 * 会话回控的纯函数层。卡片由 web 侧构造（entrypoints/web/conv-notify.logic.js），
 * 这里只负责**解析** value 与文本指令 —— 两侧靠 value 契约耦合，不共享构造代码。
 */
export const CONV_CARD_KIND = 'conv-settled';

/** 文本兜底前缀：沿用 intent-keywords 的纪律 —— 只匹配开头、正则不加 g */
const SUPPLEMENT_RE = /^[\s\p{P}\p{S}]*补充内容[\s:：,，、\-—]*/u;
const END_TEXT = '结束会话';

/** 解析 card.action.trigger 回调；非本 kind/结构异常/未知动作 → null */
export function parseConvCardAction(data) {
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  if (!value || value.kind !== CONV_CARD_KIND || !value.convId) return null;
  if (!['supplement', 'end'].includes(value.action)) return null;
  return {
    convId: value.convId,
    action: value.action,
    operatorOpenId: data?.operator?.open_id || null,
    messageId: data?.context?.open_message_id || data?.message_id || null,
  };
}

/**
 * 「补充内容 xxx」文本兜底 → 返回正文；不命中返回 null。
 * 只发前缀不带正文**不命中**：那种情况该走「点卡片按钮」的等待态，
 * 硬当成补充会把一句空话注入会话白烧一轮额度。
 */
export function matchSupplementText(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s.trim()) return null;
  const m = SUPPLEMENT_RE.exec(s);
  if (!m || m.index !== 0) return null;
  const body = s.slice(m[0].length).trim();
  return body || null;
}

/** 「结束会话」必须整条全等：否则「帮我看看怎么结束会话」会被误吞 */
export function isEndSessionText(text) {
  return (typeof text === 'string' ? text.trim() : '') === END_TEXT;
}

/** 谁能点会话卡片：本人（myFeishuOpenId）/ owner / 可信名单 */
export function canOperateRelay(operatorOpenId, { myOpenId = '', ownerOpenIds = [], trustedOpenIds = [] } = {}) {
  if (!operatorOpenId) return false;
  return (
    operatorOpenId === myOpenId ||
    (ownerOpenIds || []).includes(operatorOpenId) ||
    (trustedOpenIds || []).includes(operatorOpenId)
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/feishu-relay/logic.test.js`
Expected: `# pass 6`

---

### Task 9: 回控插件（`feishu-relay/index.js` + MANIFEST）

**Files:**
- Create: `src/plugins/feishu-relay/index.js`
- Modify: `src/plugins/index.js`

- [ ] **Step 1: 实现插件**

```js
// src/plugins/feishu-relay/index.js
/**
 * 飞书 → web 会话回控插件。
 *
 * order 16 是硬约束：必须抢在内核 claude-exec(20) 之前 —— 用户是 owner，
 * claude-exec 对 owner 全接，排在它后面的话「补充内容」会被当成普通对话吃掉。
 * 16 落在 status-report(14) 与 claude-exec(20) 之间，不影响既有可信人指令。
 *
 * 卡片回调只在飞书进程落地，会话注入只能在 web 进程做（run 注册表在内存）→
 * 经 http://127.0.0.1:<port> 直送。同机、无 Origin 头（origin.js 对此放行）。
 * PM2 双进程与 Tauri 一体化 sidecar 两种形态下 config.web.port 都是对的。
 */
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { registerCardKindHandler } from '../../shared/card-actions.js';
import { armSupplement, peekSupplement, takeSupplement, clearSupplement } from '../../shared/pending-supplement.js';
import { getMyFeishuOpenId, getActiveBot } from '../../store/settings.js';
import { getEntry, pickLatestNotified } from '../../store/conv-notify.js';
import { sendTextToUser, updateCard } from '../../integrations/lark.js';
import { resolveTrustedOpenIds } from '../team-tools/feedback/logic.js';
import { parseConvCardAction, matchSupplementText, isEndSessionText, canOperateRelay } from './logic.js';

/** 文本兜底选目标会话的窗口 */
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
const INJECT_TIMEOUT_MS = 3000;

/** 跨进程直送：把补充内容交给 web 台 */
async function postInject(convId, text) {
  const url = `http://127.0.0.1:${config.web.port}/api/conv-notify/inject`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convId, text }),
      signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) return { ok: false, error: data.error || `执行台返回 ${r.status}` };
    return { ok: true, mode: data.mode, runId: data.runId };
  } catch (e) {
    logger.warn('feishu-relay', '注入执行台失败', { convId, err: e?.message || String(e) });
    return { ok: false, error: '执行台未运行或无响应，稍后再发' };
  }
}

/** 私聊回一句（卡片回调里没有 ctx.reply，只能用 open_id 私聊原语） */
async function replyToUser(openId, text) {
  const bot = getActiveBot();
  if (!bot?.appId || !bot?.appSecret) return;
  await sendTextToUser({ appId: bot.appId, appSecret: bot.appSecret }, openId, text);
}

function relayPermOpts() {
  return {
    myOpenId: getMyFeishuOpenId(),
    ownerOpenIds: config.lark.ownerOpenIds,
    trustedOpenIds: resolveTrustedOpenIds(getActiveBot(), config.lark.trustedOpenIds),
  };
}

/** 统一的「注入 + 回执」：卡片路径与文本路径收敛到这里，不双写 */
async function doInject(convId, title, text, reply) {
  const r = await postInject(convId, text);
  if (!r.ok) return reply(`⚠️ ${r.error}`);
  const tail = r.mode === 'steer' ? '（已插入正在运行的任务）' : '（已续接会话开始执行）';
  return reply(`✅ 已把补充内容发到会话「${title}」${tail}`);
}

/** 卡片回调：[补充内容] / [结束会话] */
async function onConvCardAction(data) {
  const parsed = parseConvCardAction(data);
  if (!parsed) return;
  const done = (text) =>
    parsed.messageId
      ? updateCard(parsed.messageId, { elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }] }).catch((e) =>
          logger.warn('feishu-relay', '卡片更新失败（动作已执行）', { err: e?.message || String(e) }),
        )
      : Promise.resolve();

  if (!canOperateRelay(parsed.operatorOpenId, relayPermOpts())) {
    logger.info('feishu-relay', '非授权用户点击会话卡片，忽略', { operator: parsed.operatorOpenId });
    return;
  }
  const entry = getEntry(parsed.convId);

  if (parsed.action === 'end') {
    clearSupplement(parsed.operatorOpenId);
    return done('🛑 已结束本次通知交互（未做任何动作）。');
  }
  // supplement：置等待态，等用户下一条消息
  if (!entry) return done('⚠️ 该会话已取消飞书通知，无法补充。');
  armSupplement(parsed.operatorOpenId, {
    label: entry.title || entry.convId,
    onText: (text, reply) => doInject(entry.convId, entry.title || entry.convId, text, reply),
  });
  await done(`⌛ 等待补充内容（10 分钟内有效）…\n会话：「${entry.title || entry.convId}」`);
  return replyToUser(parsed.operatorOpenId, '请直接发送要补充的内容。');
}

registerCardKindHandler('conv-settled', onConvCardAction);

const feature = {
  name: 'feishu-relay',
  permission: 'any', // hasPending/match 自带门禁
  intents: [],
  /** 等待补充态：整条消息就是补充内容 */
  hasPending: (ctx) => !!peekSupplement(ctx.user?.id),
  handle: async (ctx) => {
    // 文本路径：命中「结束会话」时优先当结束处理（用户可能改主意）
    if (isEndSessionText(ctx.text)) {
      clearSupplement(ctx.user.id);
      return ctx.reply('🛑 已结束本次通知交互（未做任何动作）。');
    }
    const pendingEntry = takeSupplement(ctx.user.id);
    if (pendingEntry) return pendingEntry.onText(String(ctx.text ?? '').trim(), ctx.reply);

    // match 路径（文本兜底）
    if (isEndSessionText(ctx.text)) return ctx.reply('🛑 好的，不做动作。');
    const body = matchSupplementText(ctx.text);
    if (!body) return ctx.reply('没识别到补充内容，请发「补充内容 <你的补充>」。');
    const target = pickLatestNotified(FALLBACK_WINDOW_MS);
    if (!target) return ctx.reply('近 24 小时没有收到过通知的会话，请先在网页端激活飞书通知。');
    return doInject(target.convId, target.title || target.convId, body, ctx.reply);
  },
  /** 文本兜底：机器人重启丢了等待态、或用户不想点按钮时 */
  match: (ctx) => {
    if (!canOperateRelay(ctx.user?.id, relayPermOpts())) return false;
    return isEndSessionText(ctx.text) || !!matchSupplementText(ctx.text);
  },
};

export default {
  id: 'feishu-relay',
  features: [{ order: 16, feature }],
};
```

- [ ] **Step 2: 登记 MANIFEST（`src/plugins/index.js`）**

在 `action-runner` 条目**之前**插入（顺序不影响 order，但读起来与 order 一致）：

```js
  {
    id: 'feishu-relay',
    description: 'web 会话飞书回控：通知卡片的[补充内容]/[结束会话]，把补充内容注入执行台会话',
    load: () => import('./feishu-relay/index.js'),
  },
```

- [ ] **Step 3: 语法自检 + 装配自检**

Run: `node --check src/plugins/feishu-relay/index.js && node -e "import('./src/features/index.js').then(m=>console.log(m.features.map(f=>f.name)))"`
Expected: 打印的 feature 名单里出现 `feishu-relay`，且顺序在 `status-report` 之后、`claude-exec` 之前。

- [ ] **Step 4: 跑全量测试**

Run: `npm test`
Expected: 全绿

---

## P4 前端：开关按钮与收件箱

### Task 10: chat.js 接缝（注入上屏 + 会话开关状态）

**Files:**
- Modify: `public/js/chat.js`

- [ ] **Step 1: 新增导出 `applyInjectedItems`**

紧跟在 `ensureConvRunAttached`（约 1879-1891 行）之后插入。**注意三方同序不变量**：存储（convPushMessage）、DOM（addMessage）、_bubbleMap 必须一起推进，禁止只落库不上屏。

```js
      /** 飞书补充内容上屏：服务端注入的用户消息本地没有气泡（消息不是从本浏览器发出的），
       *  这里补种「用户气泡 + 助手 pending 气泡」并接管该 run 的流，与本地发送后的形态完全一致。
       *  幂等：ensureConvRunAttached 自带 runId 去重；用户气泡靠服务端 claim 去重（认领后不再下发）。 */
      export function applyInjectedItems(convId, items) {
        if (!convId || convId !== currentConvId || !Array.isArray(items) || !items.length) return [];
        const applied = [];
        for (const it of items) {
          if (!it || !it.text) continue;
          const idx = convPushMessage(convId, 'user', it.text);
          convSetMsgFields(convId, idx, { msgId: it.id });
          addMessage('user', it.text);
          if (it.runId) ensureConvRunAttached(convId, it.runId);
          applied.push(it.id);
        }
        return applied;
      }
```

- [ ] **Step 2: 在 `applySessionPrefs` 尾部还原按钮态**

找到 `applySessionPrefs(c)`（约 2189 行），在函数末尾加：

```js
        if (window.__convNotify) window.__convNotify.refreshBtn(c);
```

（用全局挂载而不是 import，避免 chat.js ← conv-notify.js 的反向依赖；conv-notify.js 在 `bindConvNotify` 时写 `window.__convNotify`。这是本仓 `bindTasksNav`/`bindDirPopover` 视图桥范式的等价写法。）

- [ ] **Step 3: SSE `session` 事件后同步快照**

找到 attachStream 里处理 `session` 事件、调用 `convSetSession(convId, sid)` 的位置（约 1685-1700 行），在其后加：

```js
            if (window.__convNotify) window.__convNotify.sync(convId);
```

- [ ] **Step 4: `openConv` 末尾通知开关模块换会话**

在 `openConv(id)`（约 672 行）函数末尾加：

```js
        if (window.__convNotify) window.__convNotify.onConvOpened(id);
```

- [ ] **Step 5: 语法自检**

Run: `node --check public/js/chat.js`
Expected: 无输出

---

### Task 11: 通知按钮与收件箱轮询（`public/js/conv-notify.js` + HTML/CSS）

**Files:**
- Create: `public/js/conv-notify.js`
- Modify: `public/index.html`（`#fabRow` 内）、`public/app.css`、`public/app.js`（启动编排）

- [ ] **Step 1: HTML —— 在 `#fabRow` 内、`#modelFab` 之前插入按钮**

```html
        <div class="notify-fab" id="notifyFab">
          <button class="model-fab-btn" id="notifyFabBtn" title="任务结束/失败后发飞书通知">
            <span id="notifyFabLabel">🔔 飞书</span>
          </button>
        </div>
```

- [ ] **Step 2: CSS —— 追加到 `public/app.css` 的 `.model-fab-btn` 规则之后**

```css
/* 飞书通知开关：复用模型药丸的形状，激活态用主色描边 + 轻底色（与 pill.active 同语汇） */
.notify-fab { position: relative; }
.model-fab-btn.on {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
```

（若仓库 CSS 变量名不是 `--accent`，改用 `.model-pills button.active` 实际使用的那个变量，保持视觉一致。）

- [ ] **Step 3: 实现前端模块**

```js
// public/js/conv-notify.js
/**
 * 会话飞书通知开关 + 补充内容收件箱。
 *
 * 依赖注入（bindConvNotify）而不是 import chat.js：模块只能被 chat.js 单向依赖，
 * 反向 import 会形成环（本仓 bindTasksNav / bindDirPopover 同款范式）。
 */
import { API_BASE } from './bootstrap.js';
import { loadConvs, convSetMeta } from './conv-store.js';

const POLL_MS = 5000;
let _deps = null;
let _timer = null;
let _convId = null;

const btn = () => document.querySelector('#notifyFabBtn');

async function api(path, opts) {
  const r = await fetch(API_BASE + path, opts);
  return r.json().catch(() => ({}));
}

function convOf(id) {
  return loadConvs().find((c) => c.id === id) || null;
}

/** 按钮态只认会话记录里的 meta.notifyFeishu（服务端登记表是它的镜像） */
function refreshBtn(conv) {
  const b = btn();
  if (!b) return;
  const on = !!conv?.meta?.notifyFeishu;
  b.classList.toggle('on', on);
  b.title = on ? '已开启：任务结束/失败会发飞书通知（点击关闭）' : '任务结束/失败后发飞书通知（点击开启）';
}

/** 上报当前会话快照（服务端据此 resume 原 session 注入补充内容） */
async function sync(convId) {
  const c = convOf(convId);
  if (!c?.meta?.notifyFeishu) return;
  await api('/api/conv-notify/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      convId,
      title: c.title || '',
      session: c.session || '',
      cwd: c.cwd || '',
      model: c.model || 'auto',
      effort: c.effort || 'medium',
      mode: c.mode || 'default',
    }),
  });
}

async function toggle() {
  if (!_convId) return;
  const c = convOf(_convId);
  const on = !!c?.meta?.notifyFeishu;
  if (on) {
    convSetMeta(_convId, { notifyFeishu: false });
    refreshBtn(convOf(_convId));
    stopPolling();
    await api('/api/conv-notify/off', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convId: _convId }),
    });
    window.toast?.info?.('已关闭该会话的飞书通知');
    return;
  }
  const d = await api('/api/conv-notify/on', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      convId: _convId,
      title: c?.title || '',
      session: c?.session || '',
      cwd: c?.cwd || '',
      model: c?.model || 'auto',
      effort: c?.effort || 'medium',
      mode: c?.mode || 'default',
    }),
  });
  if (!d.ok) {
    // 缺 openId / 缺启用机器人：不点亮按钮，直接指路，避免"以为开了其实收不到"
    window.toast?.error?.(d.error || '开启失败');
    return;
  }
  convSetMeta(_convId, { notifyFeishu: true });
  refreshBtn(convOf(_convId));
  startPolling();
  window.toast?.success?.('已开启：任务结束或失败会发飞书通知');
}

async function pollInbox() {
  if (!_convId) return;
  const d = await api(`/api/conv-notify/inbox?convId=${encodeURIComponent(_convId)}`);
  if (!d.active) {
    // 服务端已无登记（例如别处取消）→ 本地对齐，停轮询
    convSetMeta(_convId, { notifyFeishu: false });
    refreshBtn(convOf(_convId));
    stopPolling();
    return;
  }
  if (!d.items?.length) return;
  const applied = _deps?.applyInjected?.(_convId, d.items) || [];
  if (!applied.length) return;
  await api('/api/conv-notify/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ convId: _convId, ids: applied }),
  });
}

function startPolling() {
  stopPolling();
  _timer = setInterval(() => pollInbox().catch(() => {}), POLL_MS);
}

function stopPolling() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

/** 切会话：换目标 + 立刻拉一次（后台会话期间收到的补充不会漏） */
function onConvOpened(convId) {
  _convId = convId;
  const c = convOf(convId);
  refreshBtn(c);
  if (c?.meta?.notifyFeishu) {
    pollInbox().catch(() => {});
    startPolling();
  } else {
    stopPolling();
  }
}

export function bindConvNotify(deps) {
  _deps = deps;
  const b = btn();
  if (b) b.onclick = () => toggle().catch((e) => window.toast?.error?.('操作失败：' + (e?.message || e)));
  // chat.js 经全局桥回调，避免反向 import
  window.__convNotify = { refreshBtn, sync, onConvOpened };
}
```

- [ ] **Step 4: 启动编排（`public/app.js`）**

在 `initChat()` 附近（其他 `bind*` 调用处）加：

```js
import { bindConvNotify } from './js/conv-notify.js';
import { applyInjectedItems } from './js/chat.js';
...
bindConvNotify({ applyInjected: applyInjectedItems });
```

（实际 import 路径以 `public/app.js` 现有写法为准；`app.js` 已是 15 模块的启动编排壳。）

- [ ] **Step 5: 冒烟自检**

起服务后浏览器打开，控制台应零 error；点按钮 → 若未配置飞书则弹 toast 指路（按钮不点亮），配置后点亮并变色；切到另一个会话按钮应恢复未点亮；切回来仍点亮。

Run: `node --check public/js/conv-notify.js`
Expected: 无输出

---

### Task 12: e2e（按钮开合 + 收件箱上屏）

**Files:**
- Create: `tests/e2e-conv-notify.mjs`

- [ ] **Step 1: 写 e2e**

沿用 `tests/e2e-panels-smoke.mjs` 的自起服务范式（`spawn` server.js + `PORT` + `APP_DATA_DIR=mkdtemp`，**不碰 pm2**）。预置 `settings.json`（假机器人 + `myFeishuOpenId`）让 `/on` 能通过前置校验；**用页面级 fetch stub 拦 `/api/conv-notify/inbox`**，避免真起 Claude run 烧额度。

```js
// tests/e2e-conv-notify.mjs（骨架，其余步骤照抄 e2e-panels-smoke.mjs）
// 1) mkdtemp APP_DATA_DIR，写入 settings.json：
//    { bots:[{id:'bot_t',name:'T',platform:'feishu',appId:'a',appSecret:'s',enabled:true}], myFeishuOpenId:'ou_test' }
// 2) spawn node src/entrypoints/web/server.js，等 /api/ping
// 3) page.route('**/api/conv-notify/inbox*', route => route.fulfill({ json:
//      { active:true, items:[{ id:'i1', text:'飞书补充：把标题改成蓝色', runId:'', mode:'run', at:Date.now() }] } }))
// 4) 新建会话 → 点 #notifyFabBtn → 断言 classList 含 'on'
// 5) 断言 5.5s 内消息区出现文本「飞书补充：把标题改成蓝色」的用户气泡
// 6) 断言 claim 被调用（page.route 记录 /api/conv-notify/claim 命中）
// 7) 切到另一个会话 → 断言按钮无 'on'；切回 → 断言有 'on'
// 8) 断言全程零 pageerror
```

- [ ] **Step 2: 跑 e2e**

Run: `node tests/e2e-conv-notify.mjs`
Expected: 打印各步 ✔ 并以 exit 0 结束

- [ ] **Step 3: 跑既有门禁不回归**

Run: `node tests/e2e-steer-bubble.mjs`
Expected: PASS（三方同序不变量未被 `applyInjectedItems` 破坏）

---

## P5 任务域：需求/故障完成通知与三操作

### Task 13: merge/discard 共享编排（`task-actions.js`）

**Files:**
- Create: `src/plugins/team-tools/task-actions.js`
- Test: `src/plugins/team-tools/task-actions.test.js`
- Modify: `src/entrypoints/web/routes-ops.js`（merge/discard 两个分支改薄壳）

- [ ] **Step 1: 写失败测试**

```js
// src/plugins/team-tools/task-actions.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAwaitingMerge } from './task-actions.js';

test('isAwaitingMerge：四个条件齐了才算待合并', () => {
  const base = { auto: true, status: 'done', merged: false, branch: 'auto/t_1', baseBranch: 'main' };
  assert.equal(isAwaitingMerge(base), true);
  assert.equal(isAwaitingMerge({ ...base, auto: false }), false);
  assert.equal(isAwaitingMerge({ ...base, status: 'developing' }), false);
  assert.equal(isAwaitingMerge({ ...base, merged: true }), false);
  assert.equal(isAwaitingMerge({ ...base, branch: null }), false);
  assert.equal(isAwaitingMerge({ ...base, baseBranch: null }), false);
  assert.equal(isAwaitingMerge(null), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/task-actions.test.js`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现（把 routes-ops 的编排整体搬过来，语义逐字保留）**

```js
// src/plugins/team-tools/task-actions.js
/**
 * 任务分支操作的共享编排 —— web 路由与飞书卡片两条入口共用，避免逻辑分叉。
 * 语义逐字沿袭原 routes-ops.js 内联实现：
 *  - repo 取任务开发时的快照（防此后切换启用机器人导致操作错仓库）
 *  - r.error 自带「合并冲突：」前缀，不再套一层
 *  - 删分支失败**不改状态**：绝不留「已放弃但分支还在」的半放弃态
 */
import { getTask, updateTask } from '../../store/tasks.js';
import { getActiveBot } from '../../store/settings.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { mergeBranch, deleteBranch } from './auto-dev/git.js';

/** 待合并 = 自动完成、未合并、分支与基线都在（前端 tasks-panel 同款判定） */
export function isAwaitingMerge(task) {
  return !!(task && task.auto && task.status === 'done' && !task.merged && task.branch && task.baseBranch);
}

function repoOf(task) {
  return task.repo || getActiveBot()?.projectDir || config.feedback.frontendDir;
}

/** @returns {{ok:boolean, code:number, error?:string, task?:object, hookBypassed?:boolean}} */
export async function mergeTaskById(id) {
  const task = getTask(id);
  if (!task) return { ok: false, code: 404, error: '任务不存在' };
  if (!isAwaitingMerge(task)) return { ok: false, code: 400, error: '任务不满足合并条件（须为自动完成且未合并）' };
  const r = await mergeBranch(repoOf(task), task.branch, task.baseBranch);
  if (!r.ok) {
    const t = updateTask(task.id, { mergeError: r.error }, r.error);
    logger.warn('task-actions', '任务合并失败', { id: task.id, err: r.error });
    return { ok: false, code: 409, error: r.error, task: t };
  }
  const t = updateTask(
    task.id,
    { merged: true, mergedAt: new Date().toISOString(), mergeError: null },
    `已合并 ${task.branch} → ${task.baseBranch}` +
      (r.hookBypassed ? '（提交钩子拦截，已跳过钩子校验完成合并）' : ''),
  );
  logger.info('task-actions', '任务已合并', {
    id: task.id,
    branch: task.branch,
    base: task.baseBranch,
    hookBypassed: !!r.hookBypassed,
  });
  return { ok: true, code: 200, task: t, hookBypassed: !!r.hookBypassed };
}

export async function discardTaskById(id) {
  const task = getTask(id);
  if (!task) return { ok: false, code: 404, error: '任务不存在' };
  // 条件与 merge 对齐但不要求 baseBranch：只有「待合并」的任务才谈得上放弃改动
  if (!(task.auto && task.status === 'done' && !task.merged && task.branch)) {
    return { ok: false, code: 400, error: '任务不满足放弃条件（须为自动完成且未合并）' };
  }
  const r = await deleteBranch(repoOf(task), task.branch);
  if (!r.ok) {
    logger.warn('task-actions', '任务放弃改动失败', { id: task.id, err: r.error });
    return { ok: false, code: 409, error: r.error, task };
  }
  const t = updateTask(
    task.id,
    {
      status: 'rejected',
      rejectedBy: 'owner',
      discarded: true,
      discardedAt: new Date().toISOString(),
      mergeError: null,
    },
    `放弃改动，已删除分支 ${task.branch}`,
  );
  logger.info('task-actions', '任务已放弃改动', { id: task.id, branch: task.branch });
  return { ok: true, code: 200, task: t };
}
```

- [ ] **Step 4: routes-ops.js 改薄壳**

把 `if (data.action === 'merge') { ... }` 整段替换为：

```js
    if (data.action === 'merge') {
      const r = await mergeTaskById(task.id);
      return sendJson(res, r.code, r.ok ? { task: r.task } : { error: r.error, task: r.task });
    }
    if (data.action === 'discard') {
      const r = await discardTaskById(task.id);
      return sendJson(res, r.code, r.ok ? { task: r.task } : { error: r.error, task: r.task });
    }
```

顶部 import 改为 `import { mergeTaskById, discardTaskById } from '../../plugins/team-tools/task-actions.js';`，并删掉此文件中已无用的 `mergeBranch` / `deleteBranch` import（若无其他引用）。

- [ ] **Step 5: 跑测试确认通过 + 语法自检**

Run: `node --test src/plugins/team-tools/task-actions.test.js && node --check src/entrypoints/web/routes-ops.js`
Expected: `# pass 1`，无语法错误

---

### Task 14: 任务卡片纯函数（`task-notify.logic.js`）

**Files:**
- Create: `src/plugins/team-tools/task-notify.logic.js`
- Test: `src/plugins/team-tools/task-notify.logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
// src/plugins/team-tools/task-notify.logic.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_CARD_KIND, buildTaskDoneCard, parseTaskCardAction, taskResultCard } from './task-notify.logic.js';

const awaiting = {
  id: 't_1', type: 'feature', title: '加导出按钮', status: 'done',
  auto: true, merged: false, branch: 'auto/t_1', baseBranch: 'main', devLog: '已完成开发',
};

test('待合并任务：三个按钮，value 契约正确', () => {
  const actions = buildTaskDoneCard(awaiting, true).elements.find((e) => e.tag === 'action').actions;
  assert.equal(actions.length, 3);
  assert.deepEqual(actions.map((a) => a.value.action), ['merge', 'supplement', 'discard']);
  assert.ok(actions.every((a) => a.value.kind === TASK_CARD_KIND && a.value.taskId === 't_1'));
});

test('无分支任务（轻度托管）：只给补充按钮', () => {
  const t = { ...awaiting, auto: false, branch: null, baseBranch: null };
  const actions = buildTaskDoneCard(t, true).elements.find((e) => e.tag === 'action').actions;
  assert.equal(actions.length, 1);
  assert.equal(actions[0].value.action, 'supplement');
});

test('文案：需求/故障标签与成败标记', () => {
  assert.match(buildTaskDoneCard(awaiting, true).elements[0].text.content, /\[需求\]/);
  assert.match(buildTaskDoneCard({ ...awaiting, type: 'bug' }, true).elements[0].text.content, /\[故障\]/);
  assert.match(buildTaskDoneCard(awaiting, false).elements[0].text.content, /❌/);
  assert.match(buildTaskDoneCard(awaiting, true).elements[0].text.content, /auto\/t_1 → main/);
});

test('parseTaskCardAction：kind/action 校验与 messageId 兜底', () => {
  const ok = parseTaskCardAction({
    action: { value: { kind: TASK_CARD_KIND, taskId: 't_1', action: 'merge' } },
    operator: { open_id: 'ou_1' },
    message_id: 'om_1',
  });
  assert.deepEqual(ok, { taskId: 't_1', action: 'merge', operatorOpenId: 'ou_1', messageId: 'om_1' });
  assert.equal(parseTaskCardAction({ action: { value: { kind: 'conv-settled', convId: 'c' } } }), null);
  assert.equal(parseTaskCardAction({ action: { value: { kind: TASK_CARD_KIND, taskId: 't', action: 'nuke' } } }), null);
});

test('taskResultCard：只剩一句结果，无按钮', () => {
  const c = taskResultCard('✅ 已合并');
  assert.equal(c.elements.length, 1);
  assert.equal(c.elements[0].tag, 'div');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/task-notify.logic.test.js`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现**

```js
// src/plugins/team-tools/task-notify.logic.js
/** 任务完成通知卡片的纯函数层（无 I/O，可单测） */
import { isAwaitingMerge } from './task-actions.js';

export const TASK_CARD_KIND = 'task-done';

function summarize(text, max = 200) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return '(无输出)';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 任务完成卡片：待合并态给三个按钮，其余只给「补充」 */
export function buildTaskDoneCard(task, ok) {
  const tag = task.type === 'bug' ? '[故障]' : '[需求]';
  const head = ok ? '✅ **已处理完成**' : '❌ **处理失败**';
  const branchLine = task.branch && task.baseBranch ? `\n分支：${task.branch} → ${task.baseBranch}` : '';
  const actions = [];
  if (isAwaitingMerge(task)) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '✅ 合并到主分支' },
      type: 'primary',
      value: { kind: TASK_CARD_KIND, taskId: task.id, action: 'merge' },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '📝 补充' },
    type: 'default',
    value: { kind: TASK_CARD_KIND, taskId: task.id, action: 'supplement' },
  });
  if (isAwaitingMerge(task)) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🗑 放弃改动' },
      type: 'danger',
      value: { kind: TASK_CARD_KIND, taskId: task.id, action: 'discard' },
    });
  }
  return {
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${head}\n${tag}「${task.title}」${branchLine}\n\n${summarize(task.devLog)}`,
        },
      },
      { tag: 'action', actions },
    ],
  };
}

export function taskResultCard(text) {
  return { elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }] };
}

export function parseTaskCardAction(data) {
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  if (!value || value.kind !== TASK_CARD_KIND || !value.taskId) return null;
  if (!['merge', 'supplement', 'discard'].includes(value.action)) return null;
  return {
    taskId: value.taskId,
    action: value.action,
    operatorOpenId: data?.operator?.open_id || null,
    messageId: data?.context?.open_message_id || data?.message_id || null,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/task-notify.logic.test.js`
Expected: `# pass 5`

---

### Task 15: 任务完成通知与卡片处理器（`task-notify.js` + 接线）

**Files:**
- Create: `src/plugins/team-tools/task-notify.js`
- Modify: `src/plugins/team-tools/task-ops.js`、`src/plugins/team-tools/auto-dev/index.js`

- [ ] **Step 1: 实现**

```js
// src/plugins/team-tools/task-notify.js
/**
 * 需求/故障任务完成 → 飞书私聊卡片（发给管理员本人），并处理卡片上的三个操作。
 *
 * 与 auto-dev 现有「回告提交人」的纯文本通知并存、互不替代：那条是给提交人看进度，
 * 这条是给管理员本人做决策（合并/补充/放弃）。
 * 全链路 fire-and-forget：通知失败绝不能影响任务状态流转。
 */
import { logger } from '../../shared/logger.js';
import { config } from '../../shared/config.js';
import { registerCardKindHandler } from '../../shared/card-actions.js';
import { armSupplement } from '../../shared/pending-supplement.js';
import { getTask, updateTask } from '../../store/tasks.js';
import { getUiPrefs, getMyFeishuOpenId, getActiveBot } from '../../store/settings.js';
import { sendCardToUser, sendTextToUser, updateCard } from '../../integrations/lark.js';
import { mergeTaskById, discardTaskById, isAwaitingMerge } from './task-actions.js';
import { requestAutoDevelop } from './auto-dev/index.js';
import { buildTaskDoneCard, taskResultCard, parseTaskCardAction } from './task-notify.logic.js';
import { canOperateRelay } from '../feishu-relay/logic.js';
import { resolveTrustedOpenIds } from './feedback/logic.js';

function creds() {
  const bot = getActiveBot();
  return bot?.appId && bot?.appSecret ? { appId: bot.appId, appSecret: bot.appSecret } : null;
}

/** 任务落 done 后调用（两个 done 写入点各一次，互不重叠 → 不会双发） */
export function notifyTaskDone(task, ok) {
  try {
    if (!getUiPrefs()?.taskNotifyFeishu) return; // 廉价判定在前
    const openId = getMyFeishuOpenId();
    if (!openId) return;
    const c = creds();
    if (!c) return;
    const fresh = getTask(task.id) || task; // 现读最新盘上值：分支/合并字段可能刚写入
    sendCardToUser(c, openId, buildTaskDoneCard(fresh, ok))
      .then((mid) => {
        if (mid) return;
        const tag = fresh.type === 'bug' ? '[故障]' : '[需求]';
        return sendTextToUser(c, openId, `${ok ? '✅ 已处理完成' : '❌ 处理失败'}\n${tag}「${fresh.title}」\n请到网页端任务面板处理。`);
      })
      .catch((e) => logger.warn('task-notify', '任务完成通知异常（已捕获）', { id: task.id, err: e?.message || String(e) }));
  } catch (e) {
    logger.warn('task-notify', '任务完成通知准备失败（已捕获）', { err: e?.message || String(e) });
  }
}

async function onTaskCardAction(data) {
  const parsed = parseTaskCardAction(data);
  if (!parsed) return;
  const done = (text) =>
    parsed.messageId
      ? updateCard(parsed.messageId, taskResultCard(text)).catch((e) =>
          logger.warn('task-notify', '卡片更新失败（动作已执行）', { err: e?.message || String(e) }),
        )
      : Promise.resolve();

  const perm = {
    myOpenId: getMyFeishuOpenId(),
    ownerOpenIds: config.lark.ownerOpenIds,
    trustedOpenIds: resolveTrustedOpenIds(getActiveBot(), config.lark.trustedOpenIds),
  };
  if (!canOperateRelay(parsed.operatorOpenId, perm)) {
    logger.info('task-notify', '非授权用户点击任务卡片，忽略', { operator: parsed.operatorOpenId });
    return;
  }

  const task = getTask(parsed.taskId);
  if (!task) return done('⚠️ 任务不存在或已被清理。');

  if (parsed.action === 'supplement') {
    armSupplement(parsed.operatorOpenId, {
      label: `任务「${task.title}」`,
      onText: async (text, reply) => {
        updateTask(task.id, { fixNote: text }, '飞书补充说明');
        requestAutoDevelop(task.id, '飞书补充后重新开发');
        return reply(`✅ 已记录补充并重新排队开发：「${task.title}」`);
      },
    });
    await done(`⌛ 等待补充内容（10 分钟内有效）…\n任务：「${task.title}」`);
    const c = creds();
    if (c) await sendTextToUser(c, parsed.operatorOpenId, '请直接发送要补充的内容。');
    return;
  }

  // 幂等：并发双击/网页端已处理过 → 只更新卡片，不重复执行 git
  if (!isAwaitingMerge(task) && parsed.action === 'merge') return done(`ℹ️「${task.title}」已不在待合并态。`);

  if (parsed.action === 'merge') {
    const r = await mergeTaskById(task.id);
    return done(
      r.ok
        ? `✅ 已合并 ${task.branch} → ${task.baseBranch}` + (r.hookBypassed ? '（已跳过提交钩子校验）' : '')
        : `⚠️ ${r.error}（请到网页端处理）`,
    );
  }
  const r = await discardTaskById(task.id);
  return done(r.ok ? `🗑 已放弃改动并删除分支 ${task.branch}` : `⚠️ ${r.error}（请到网页端处理）`);
}

registerCardKindHandler('task-done', onTaskCardAction);
```

- [ ] **Step 2: 接线 `task-ops.js`（轻度托管 done 写入点）**

在 `develop()` 里写 `status:'done'` 的那段（约 128-132 行）之后加：

```js
    notifyTaskDone(updated, ok); // updated = updateTask 的返回值；ok 为本轮 develop 结果
```

顶部加 `import { notifyTaskDone } from './task-notify.js';`。

**注意**：只在 `!opts.deferStatus` 分支加。`deferStatus:true` 是 auto-dev 调用的路径，那条路径由 auto-dev 自己发通知，否则会双发。

- [ ] **Step 3: 接线 `auto-dev/index.js`（自动管线 done 写入点）**

在 `runOne()` 里写 `status:'done'`（约 157 行，event `'自动开发完成，待确认合并'`）之后加：

```js
    notifyTaskDone(getTask(task.id), true);
```

顶部加 `import { notifyTaskDone } from '../task-notify.js';`。

**循环依赖检查**：`task-notify.js` import 了 `auto-dev/index.js` 的 `requestAutoDevelop`，而 `auto-dev/index.js` 又 import `task-notify.js` —— ESM 能处理这种环（函数调用发生在运行时），但为稳妥，若启动报 `Cannot access before initialization`，把 `auto-dev/index.js` 里的调用改为动态 import：

```js
    import('../task-notify.js').then((m) => m.notifyTaskDone(getTask(task.id), true)).catch(() => {});
```

- [ ] **Step 4: 语法与装配自检**

Run: `node --check src/plugins/team-tools/task-notify.js && node -e "import('./src/features/index.js').then(()=>console.log('assemble ok'))"`
Expected: 打印 `assemble ok`（无循环依赖崩溃）

---

### Task 16: 任务面板通知开关

**Files:**
- Modify: `src/store/settings.js`、`src/entrypoints/web/routes-settings.js`、`public/js/tasks-panel.js`

- [ ] **Step 1: settings 默认值**

`DEFAULTS.uiPrefs` 加字段：

```js
  uiPrefs: { defaultCwd: '', model: 'auto', effort: 'medium', mode: 'default', defaultModel: '', defaultEffort: '', defaultMode: '', disabledTools: [], taskNotifyFeishu: false },
```

- [ ] **Step 2: routes-settings 透传布尔**

在 `data.section === 'ui-prefs'` 分支里，`disabledTools` 处理之后加：

```js
        if (typeof data.taskNotifyFeishu === 'boolean') patch.taskNotifyFeishu = data.taskNotifyFeishu;
```

- [ ] **Step 3: 前端 chip（`public/js/tasks-panel.js` 的 `renderFilterBar`）**

在 `bar.appendChild(chip);` 之后、`return bar;` 之前插入：

```js
        // 飞书通知开关（全局）：任务完成后给管理员本人推卡片，可直接合并/补充/放弃
        const notify = document.createElement('button');
        notify.className = 'btn task-filter-chip' + (taskNotifyOn ? ' active' : '');
        notify.textContent = '🔔 飞书通知';
        notify.title = '任务处理完成后发飞书私聊卡片（可直接合并/补充/放弃）';
        notify.onclick = async () => {
          const next = !taskNotifyOn;
          const r = await fetch(API_BASE + '/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ section: 'ui-prefs', taskNotifyFeishu: next }),
          }).then((x) => x.json()).catch(() => ({}));
          if (r?.ok) {
            taskNotifyOn = next;
            window.toast?.success?.(next ? '已开启任务完成飞书通知' : '已关闭任务完成飞书通知');
            loadTasks();
          } else {
            window.toast?.error?.('保存失败');
          }
        };
        bar.appendChild(notify);
```

在模块顶部加状态变量 `let taskNotifyOn = false;`，并在 `loadTasks()` 里（拉 `/api/tasks` 的同时）读一次设置：

```js
        fetch(API_BASE + '/api/settings').then((r) => r.json()).then((d) => {
          taskNotifyOn = !!d?.uiPrefs?.taskNotifyFeishu;
        }).catch(() => {});
```

（`API_BASE` 从 `./bootstrap.js` import，与本文件其他 fetch 用法保持一致。）

- [ ] **Step 4: 冒烟**

起服务 → 打开任务面板 → 点「🔔 飞书通知」→ chip 高亮 + toast；刷新页面后仍高亮（读的是服务端设置）。

Run: `node --check public/js/tasks-panel.js`
Expected: 无输出

---

### Task 17: 收口

- [ ] **Step 1: 全量单测**

Run: `npm test`
Expected: 全绿（新增约 31 例：5+7+2+7+6+1+5 加既有）

- [ ] **Step 2: e2e 门禁**

Run: `node tests/e2e-conv-notify.mjs && node tests/e2e-steer-bubble.mjs && node tests/e2e-panels-smoke.mjs`
Expected: 前两个 PASS；`panels-smoke` 若因既有存量债失败，确认失败原因与本次改动无关后记录，不修（不在本次范围）。

- [ ] **Step 3: 部署**

Run: `pm2 restart claude-web && pm2 restart claude-feishu`
Expected: 两个进程都 online。**必须两个都重启**：通知发送在 web 进程，卡片回调与文本兜底在飞书进程。

- [ ] **Step 4: 真机走查清单（用户执行，逐条勾）**

- [ ] 会话激活按钮：未配 `myFeishuOpenId` 或无启用机器人时点击 → toast 指路且不点亮
- [ ] 配好后激活 → 发一个短任务 → 结束后飞书私聊收到卡片（标题/耗时/摘要正确）
- [ ] 点卡片 [📝 补充内容] → 机器人回「请直接发送要补充的内容」→ 发一句 → 网页对应会话出现用户气泡并继续执行
- [ ] 补充完成后再次收到通知（闭环）
- [ ] 点 [🛑 结束会话] → 卡片转终态，网页无任何动作、开关仍亮
- [ ] 文本兜底：直接发「补充内容 xxx」→ 回执写明送到了哪个会话
- [ ] 关掉 `claude-web` 后点 [补充内容] 并发一句 → 回「执行台未运行，稍后再发」
- [ ] 手动点「停止」结束的 run → **不**应收到飞书通知
- [ ] 任务面板开「🔔 飞书通知」→ 跑一个需求/故障到完成 → 收到卡片（待合并任务应有三个按钮）
- [ ] 点 [✅ 合并到主分支] → 卡片显示已合并，网页任务面板同步显示已合并
- [ ] 点 [🗑 放弃改动] → 分支被删、任务转已放弃
- [ ] 点 [📝 补充] → 发一句 → 任务重新排队开发（web 台泵接手）
- [ ] 制造一次合并冲突 → 卡片显示「⚠️ 合并冲突：…（请到网页端处理）」且任务状态未变

- [ ] **Step 5: 不提交**

按项目规则，改动全部留在工作区，**不执行 git commit**。向用户汇报改动文件清单与走查结果即可。

---

## 自查记录（写计划时完成）

- **Spec 覆盖**：§1.1→T11、§1.2→T7/T11、§1.3→T2、§1.4→T3/T5/T6、§1.5→T8/T9、§1.6→T6/T7/T10/T11、§2.1→T16、§2.2→T14/T15、§2.3→T13、§2.4→T15；错误处理与降级散落在 T6/T9/T15 的实现注释里；测试→T1/T2/T5/T8/T13/T14/T12/T17；部署→T17。
- **与 spec 的三处对齐微调**（spec 已同步更新）：① 会话激活标记存 `conv.meta.notifyFeishu`（复用 `convSetMeta` 守护 API），不新增 conv 顶层字段；② 监听器注册改为 `server.js` 显式调 `startConvNotify()`（与 `startAutoDevPump()` 同范式），不靠 import 副作用；③ e2e 用页面级 fetch stub 覆盖收件箱上屏，真实注入放进真机走查（避免 e2e 烧额度）。
- **命名一致性**：`CONV_CARD_KIND='conv-settled'` / `TASK_CARD_KIND='task-done'`；`armSupplement/peekSupplement/takeSupplement/clearSupplement`；`enableConv/disableConv/patchConv/pushInjection/claimInjections/pickLatestNotified`；`registerRunSettleListener`；`sendCardToUser`；`injectToConv`；`mergeTaskById/discardTaskById/isAwaitingMerge`；`notifyTaskDone`；`applyInjectedItems`；`bindConvNotify`。跨任务引用均已对齐。
- **两处实施时必须先 grep 确认的既有导出**（已在对应步骤写明）：`runs.js` 的 `holdMsg`（可能需新增 `findRunningRunByConv`）、`body.js` 的 `withJsonBody`（可能只有 `readJsonBody`）。

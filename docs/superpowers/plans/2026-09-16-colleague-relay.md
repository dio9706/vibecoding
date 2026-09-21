# 同事消息中继（三期）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⚠️ **本项目禁止自动 git 提交**（根 `CLAUDE.md`「协作约定」）。本计划**不含任何 `git commit` 步骤**，每个 Task 以「跑测试 / 人工验收」收口。

**Goal:** 同事回复飞书机器人的消息（含文档）进入对应需求的对话流，开发期右栏显示未读气泡，点开可查看往来消息并主动回复。

**Architecture:** 入站分两条链路 —— 文本走 dispatch 新插件 `colleague-relay`（order=35，需 dispatch 的 intents 段支持 PASS），文件/图片走飞书入口的既有分支（它们在 dispatch 之前就 return 了）。归属不确定时落盘缓冲 + kind 路由卡片按钮让同事自选，全程无内存态。消息存成带 `role`/`files[].path`/`status` 的事件流，四期的 AI 自动处理可直接喂给 `/api/req/change` 与 `/api/req/apidoc`。

**Tech Stack:** Node ≥20 原生 ESM、`node --test`、`store/index.js` 文件锁 + 原子写、飞书 SDK（已封装在 `integrations/lark.js`）、原生 DOM 前端。

**Spec:** `docs/superpowers/specs/2026-09-16-colleague-relay-design.md`

---

## 文件结构

### 新建

| 文件 | 职责 |
|---|---|
| `src/store/colleague-messages.js` | 会话消息 + 待归属缓冲的持久化 |
| `src/store/colleague-messages.test.js` | store 单测 |
| `src/plugins/colleague-relay/index.js` | 插件入口（feature 条目 + 卡片 kind 注册） |
| `src/plugins/colleague-relay/logic.js` | 纯逻辑：归属判定、选择卡片构造、确认文案 |
| `src/plugins/colleague-relay/logic.test.js` | 纯逻辑单测 |
| `src/plugins/colleague-relay/feature.js` | feature 实现（hasPending / intents / handle） |
| `public/js/colleague-chat.js` | 对话列表弹窗 + 对话面板 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/app/dispatch.js` | intents 段支持 `PASS` |
| `src/app/dispatch.test.js` | 追加 PASS 回退用例 |
| `src/plugins/index.js` | `PLUGIN_MANIFEST` 登记 colleague-relay |
| `src/entrypoints/feishu/index.js` | image / file 两个分支开头插入同事归属判定 |
| `src/entrypoints/web/requirement-ops.js` | `resolveAssigneeList` 回填 `unreadCount` |
| `src/entrypoints/web/routes-requirements.js` | 三个新端点 + 分发登记 |
| `src/entrypoints/web/routes-requirements.test.js` | 追加端点用例 |
| `public/js/req-chat.js` | 「开发人员」按钮改为打开对话列表 + 未读总数气泡 |
| `public/app.css` | 对话面板样式 |
| `docs/ARCHITECTURE.md` / `src/store/CLAUDE.md` / `src/entrypoints/CLAUDE.md` | 清单登记 |

---

## Task 1：dispatch 的 intents 段支持 PASS

**Files:**
- Modify: `src/app/dispatch.js`
- Test: `src/app/dispatch.test.js`

- [ ] **Step 1: 先写失败的测试**

在 `src/app/dispatch.test.js` 末尾追加：

```js
test('intents 段：feature 返回 PASS 后继续匹配后续 feature（不被第一个命中者吞掉）', async () => {
  const { ctx, replies } = ctxOf();
  const calls = [];
  const passer = {
    name: 'passer',
    permission: 'any',
    intents: ['bug'],
    handle: async () => {
      calls.push('passer');
      return PASS;
    },
  };
  const taker = {
    name: 'taker',
    permission: 'any',
    intents: ['bug'],
    handle: async () => {
      calls.push('taker');
      return 'done';
    },
  };
  const r = await dispatch(ctx, {
    featureList: [passer, taker],
    classifyFn: async () => ({ intent: 'bug' }),
  });
  assert.deepEqual(calls, ['passer', 'taker'], 'passer 让出后 taker 必须接到');
  assert.equal(r, 'done');
  assert.deepEqual(replies, [], '有人接管就不该再弹帮助卡');
});

test('intents 段：所有候选都 PASS → 回落帮助卡（不静默吞掉消息）', async () => {
  const { ctx, replies } = ctxOf();
  const passer = {
    name: 'passer',
    permission: 'any',
    intents: ['bug'],
    handle: async () => PASS,
  };
  await dispatch(ctx, {
    featureList: [passer],
    classifyFn: async () => ({ intent: 'bug' }),
  });
  assert.equal(replies.length, 1, '全员让出后必须走帮助卡，否则用户发了消息毫无反应');
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test src/app/dispatch.test.js
```

预期：新增 2 条 fail（第一条 `calls` 只有 `['passer']`；第二条 `replies.length === 0`）。

- [ ] **Step 3: 改 `src/app/dispatch.js`**

把第 2 段的循环体：

```js
    for (const f of featureList) {
      const permOK = f.permission === 'any' || f.permission === ctx.user.role;
      if (permOK && f.intents.includes(intent.intent)) {
        logger.info('dispatch', `→ ${f.name}（intent=${intent.intent}）`);
        return await f.handle(ctx, intent);
      }
    }
```

替换为：

```js
    for (const f of featureList) {
      const permOK = f.permission === 'any' || f.permission === ctx.user.role;
      if (permOK && f.intents.includes(intent.intent)) {
        logger.info('dispatch', `→ ${f.name}（intent=${intent.intent}）`);
        // 与上面 hasPending 段对齐：feature 接进去后发现不该自己管，可返回 PASS 还回来。
        // colleague-relay 正是这样——它声明了 bug/feature/question 等意图，但只在
        // 「发信人是某个开发期需求的开发人员」时才接管，否则必须让回 feedback。
        const r = await f.handle(ctx, intent);
        if (r !== PASS) return r;
        logger.info('dispatch', `← ${f.name} 放弃接管（PASS），继续匹配`);
      }
    }
```

- [ ] **Step 4: 跑测试，确认全绿**

```bash
node --test src/app/dispatch.test.js
```

预期：`fail 0`。

- [ ] **Step 5: 确认没影响既有 feature**

```bash
npm test
```

预期：`fail 0`。现有 feature 都不返回 `PASS`（只有 hasPending 路径用），所以这是行为兼容的改动。

---

## Task 2：store —— 会话消息与待归属缓冲

**Files:**
- Create: `src/store/colleague-messages.js`
- Test: `src/store/colleague-messages.test.js`

- [ ] **Step 1: 先写失败的测试**

创建 `src/store/colleague-messages.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录：store/index.js 按 APP_DATA_DIR 定位，须在 import store 之前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsg-store-'));
const {
  normalizeEntry,
  appendMessage,
  getThread,
  getUnreadCounts,
  markRead,
  addPending,
  getPending,
  flushPending,
} = await import('./colleague-messages.js');

test('normalizeEntry：补齐缺省字段，status 非法归 unread', () => {
  const e = normalizeEntry({ dir: 'in', text: 'hi' });
  assert.equal(e.dir, 'in');
  assert.equal(e.status, 'unread');
  assert.equal(e.handledBy, null);
  assert.deepEqual(e.files, []);
  assert.match(e.id, /^cm_/);
  assert.ok(e.at);
  assert.equal(normalizeEntry({ dir: 'in', status: 'weird' }).status, 'unread');
  assert.equal(normalizeEntry({ dir: 'out' }).dir, 'out');
  assert.equal(normalizeEntry({ dir: 'nonsense' }).dir, 'in', 'dir 非法时 fail-safe 到 in');
});

test('appendMessage → getThread 回读；in 更新 lastInboundAt，out 不更新', () => {
  appendMessage('r_1', 'cl_a', { dir: 'in', text: '第一条', role: 'backend' });
  const t1 = getThread('r_1', 'cl_a');
  assert.equal(t1.messages.length, 1);
  assert.equal(t1.messages[0].text, '第一条');
  assert.equal(t1.messages[0].role, 'backend');
  assert.ok(t1.lastInboundAt);

  const before = getThread('r_1', 'cl_a').lastInboundAt;
  appendMessage('r_1', 'cl_a', { dir: 'out', text: '我的回复', status: 'read' });
  const t2 = getThread('r_1', 'cl_a');
  assert.equal(t2.messages.length, 2);
  assert.equal(t2.lastInboundAt, before, 'out 方向不该刷新「最近来信时间」');
});

test('getThread：未知需求/未知同事返回空骨架而非 undefined', () => {
  const t = getThread('r_none', 'cl_none');
  assert.deepEqual(t.messages, []);
  assert.equal(t.lastInboundAt, null);
});

test('getUnreadCounts：只数 in+unread；out 与已读不计', () => {
  appendMessage('r_2', 'cl_x', { dir: 'in', text: 'a' });
  appendMessage('r_2', 'cl_x', { dir: 'in', text: 'b' });
  appendMessage('r_2', 'cl_x', { dir: 'out', text: 'c' });
  appendMessage('r_2', 'cl_y', { dir: 'in', text: 'd' });
  assert.deepEqual(getUnreadCounts('r_2'), { cl_x: 2, cl_y: 1 });
  assert.deepEqual(getUnreadCounts('r_none'), {});
});

test('markRead：只清该会话的 in+unread，其它会话不受影响', () => {
  markRead('r_2', 'cl_x');
  assert.deepEqual(getUnreadCounts('r_2'), { cl_y: 1 });
  assert.ok(getThread('r_2', 'cl_x').messages.every((m) => m.dir === 'out' || m.status === 'read'));
});

test('markRead：未知会话不炸、不写盘', () => {
  assert.doesNotThrow(() => markRead('r_none', 'cl_none'));
});

test('addPending / getPending：同一人多条累积在一个缓冲里', () => {
  addPending('ou_1', { dir: 'in', text: '第一条待归属' });
  addPending('ou_1', { dir: 'in', text: '第二条待归属' });
  const p = getPending('ou_1');
  assert.equal(p.messages.length, 2, '累积而非覆盖——否则同事连发两条只有最后一条被归入');
  assert.ok(p.askedAt);
  assert.equal(getPending('ou_none'), null);
});

test('flushPending：缓冲整体归入目标需求并清空', () => {
  const n = flushPending('ou_1', 'r_3', 'cl_z');
  assert.equal(n, 2);
  assert.equal(getThread('r_3', 'cl_z').messages.length, 2);
  assert.equal(getThread('r_3', 'cl_z').messages[0].text, '第一条待归属');
  assert.equal(getPending('ou_1'), null, '归入后必须清空，否则同事再点一次按钮会重复归入');
});

test('flushPending：空缓冲返回 0，不写盘', () => {
  assert.equal(flushPending('ou_none', 'r_3', 'cl_z'), 0);
});

test('_pending 不污染需求命名空间（getUnreadCounts 不把它当成需求）', () => {
  addPending('ou_2', { dir: 'in', text: 'x' });
  assert.deepEqual(getUnreadCounts('_pending'), {}, '缓冲节必须与 reqId 隔离');
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test src/store/colleague-messages.test.js
```

预期：`Cannot find module './colleague-messages.js'`。

- [ ] **Step 3: 实现 `src/store/colleague-messages.js`**

```js
/**
 * 同事 ↔ 机器人的需求对话流（colleague-messages.json）。
 *
 * 形状：{ [reqId]: { [colleagueId]: { messages: [], lastInboundAt } }, _pending: { [openId]: {...} } }
 *
 * 为什么消息条目上带 status/handledBy/role/files[].path，而不是只存聊天记录：
 * 四期要让 AI 按职位自动处理（产品调整需求 → /api/req/change；后端发接口文档 →
 * /api/req/apidoc），那两个接口要的正是「发信当时的职位」与「文件的落盘路径」。
 * 把这些留在三期的数据里，四期只需加一层分类器，不必改数据结构做迁移。
 *
 * 并发：飞书进程写入站、web 进程写出站与已读——两个进程并发写同一文件，
 * 所有写操作必须经 store/index.js 的 updateJson（文件锁 + 原子写），不得裸读写。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'colleague-messages.json';
/** 待归属缓冲的命名空间。下划线前缀与 reqId（r_ 前缀）天然不撞 */
const PENDING_KEY = '_pending';
/** 每条会话保留最近 N 条，简单截断防膨胀（同 conv-messages 的做法） */
export const MAX_MESSAGES = 500;

const STATUSES = ['unread', 'read', 'handled'];

function genId() {
  return 'cm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 条目归一（纯函数）。dir 非法一律 fail-safe 到 'in'：
 * 把来信错记成去信，会让它在界面上靠右显示、且不计未读——等于静默丢一条同事的消息。
 */
export function normalizeEntry(e) {
  const o = isPlainObject(e) ? e : {};
  return {
    id: typeof o.id === 'string' && o.id ? o.id : genId(),
    dir: o.dir === 'out' ? 'out' : 'in',
    text: typeof o.text === 'string' ? o.text : '',
    files: Array.isArray(o.files)
      ? o.files
          .filter(isPlainObject)
          .map((f) => ({
            name: typeof f.name === 'string' ? f.name : '',
            path: typeof f.path === 'string' ? f.path : '',
            kind: f.kind === 'image' ? 'image' : 'file',
          }))
      : [],
    at: typeof o.at === 'string' && o.at ? o.at : new Date().toISOString(),
    role: typeof o.role === 'string' ? o.role : '',
    status: STATUSES.includes(o.status) ? o.status : 'unread',
    handledBy: o.handledBy === 'manual' || o.handledBy === 'ai' ? o.handledBy : null,
    handledNote: typeof o.handledNote === 'string' ? o.handledNote : '',
  };
}

function emptyThread() {
  return { messages: [], lastInboundAt: null };
}

function normalizeThread(raw) {
  if (!isPlainObject(raw)) return emptyThread();
  const messages = Array.isArray(raw.messages) ? raw.messages.map(normalizeEntry) : [];
  return {
    messages: messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages,
    lastInboundAt: typeof raw.lastInboundAt === 'string' ? raw.lastInboundAt : null,
  };
}

function readStore() {
  const s = readJson(FILE, {});
  return isPlainObject(s) ? s : {};
}

export function getThread(reqId, colleagueId) {
  const s = readStore();
  if (reqId === PENDING_KEY) return emptyThread();
  return normalizeThread(s?.[reqId]?.[colleagueId]);
}

/** 追加一条；dir='in' 时刷新 lastInboundAt（out 不刷——那是「最近来信时间」） */
export function appendMessage(reqId, colleagueId, entry) {
  if (!reqId || !colleagueId || reqId === PENDING_KEY) return null;
  const e = normalizeEntry(entry);
  updateJson(FILE, {}, (raw) => {
    const s = isPlainObject(raw) ? raw : {};
    const req = isPlainObject(s[reqId]) ? s[reqId] : {};
    const t = normalizeThread(req[colleagueId]);
    t.messages.push(e);
    if (t.messages.length > MAX_MESSAGES) t.messages = t.messages.slice(t.messages.length - MAX_MESSAGES);
    if (e.dir === 'in') t.lastInboundAt = e.at;
    return { ...s, [reqId]: { ...req, [colleagueId]: t } };
  });
  return e;
}

/** 某需求下各同事的未读数（只数 in + unread） */
export function getUnreadCounts(reqId) {
  if (!reqId || reqId === PENDING_KEY) return {};
  const req = readStore()[reqId];
  if (!isPlainObject(req)) return {};
  const out = {};
  for (const [cid, raw] of Object.entries(req)) {
    const n = normalizeThread(raw).messages.filter((m) => m.dir === 'in' && m.status === 'unread').length;
    if (n > 0) out[cid] = n;
  }
  return out;
}

export function markRead(reqId, colleagueId) {
  if (!reqId || !colleagueId || reqId === PENDING_KEY) return;
  updateJson(FILE, {}, (raw) => {
    const s = isPlainObject(raw) ? raw : {};
    const req = isPlainObject(s[reqId]) ? s[reqId] : null;
    if (!req || !req[colleagueId]) return undefined; // 未知会话：不写盘
    const t = normalizeThread(req[colleagueId]);
    let changed = false;
    t.messages = t.messages.map((m) => {
      if (m.dir === 'in' && m.status === 'unread') {
        changed = true;
        return { ...m, status: 'read' };
      }
      return m;
    });
    if (!changed) return undefined;
    return { ...s, [reqId]: { ...req, [colleagueId]: t } };
  });
}

// ---- 待归属缓冲（同事参与多个开发期需求，等他在卡片上选） ----

/** 累积而非覆盖：同事连发两条时，只留最后一条等于丢消息 */
export function addPending(openId, entry) {
  if (!openId) return;
  const e = normalizeEntry(entry);
  updateJson(FILE, {}, (raw) => {
    const s = isPlainObject(raw) ? raw : {};
    const p = isPlainObject(s[PENDING_KEY]) ? s[PENDING_KEY] : {};
    const cur = isPlainObject(p[openId]) ? p[openId] : { messages: [], askedAt: new Date().toISOString() };
    const messages = Array.isArray(cur.messages) ? cur.messages.map(normalizeEntry) : [];
    messages.push(e);
    return { ...s, [PENDING_KEY]: { ...p, [openId]: { messages, askedAt: cur.askedAt } } };
  });
}

export function getPending(openId) {
  if (!openId) return null;
  const p = readStore()[PENDING_KEY];
  const cur = isPlainObject(p) ? p[openId] : null;
  if (!isPlainObject(cur) || !Array.isArray(cur.messages) || !cur.messages.length) return null;
  return { messages: cur.messages.map(normalizeEntry), askedAt: cur.askedAt || null };
}

/**
 * 把缓冲整体归入目标需求并清空。
 * 必须清空：不清的话同事再点一次卡片按钮，同一批消息会被重复归入。
 * @returns {number} 归入条数
 */
export function flushPending(openId, reqId, colleagueId) {
  const pending = getPending(openId);
  if (!pending || !reqId || !colleagueId) return 0;
  updateJson(FILE, {}, (raw) => {
    const s = isPlainObject(raw) ? raw : {};
    const req = isPlainObject(s[reqId]) ? s[reqId] : {};
    const t = normalizeThread(req[colleagueId]);
    for (const m of pending.messages) {
      t.messages.push(m);
      if (m.dir === 'in') t.lastInboundAt = m.at;
    }
    if (t.messages.length > MAX_MESSAGES) t.messages = t.messages.slice(t.messages.length - MAX_MESSAGES);
    const p = { ...(isPlainObject(s[PENDING_KEY]) ? s[PENDING_KEY] : {}) };
    delete p[openId];
    return { ...s, [reqId]: { ...req, [colleagueId]: t }, [PENDING_KEY]: p };
  });
  return pending.messages.length;
}
```

- [ ] **Step 4: 跑测试，确认全绿**

```bash
node --test src/store/colleague-messages.test.js
```

预期：`pass 10` / `fail 0`。

---

## Task 3：插件纯逻辑 —— 归属判定与选择卡片

**Files:**
- Create: `src/plugins/colleague-relay/logic.js`
- Test: `src/plugins/colleague-relay/logic.test.js`

- [ ] **Step 1: 先写失败的测试**

创建 `src/plugins/colleague-relay/logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargets, buildPickCard, ACK_TEXT, PICK_KIND } from './logic.js';

const COLLEAGUES = [
  { id: 'cl_a', name: '后端丙', role: 'backend', feishuOpenId: 'ou_b' },
  { id: 'cl_b', name: '产品甲', role: 'product', feishuOpenId: 'ou_p' },
];
const REQS = [
  { id: 'r_1', title: '扫码支付', phase: 'dev', assignees: ['cl_a'] },
  { id: 'r_2', title: '对账补偿', phase: 'dev', assignees: ['cl_a', 'cl_b'] },
  { id: 'r_3', title: '已归档的', phase: 'archived', assignees: ['cl_a'] },
  { id: 'r_4', title: '评审中的', phase: 'review', assignees: ['cl_a'] },
];

test('resolveTargets：open_id 不在名册 → 非同事', () => {
  const r = resolveTargets('ou_unknown', COLLEAGUES, REQS);
  assert.equal(r.colleague, null);
  assert.deepEqual(r.reqs, []);
});

test('resolveTargets：只取开发期需求（归档/评审期不算）', () => {
  const r = resolveTargets('ou_p', COLLEAGUES, REQS);
  assert.equal(r.colleague.id, 'cl_b');
  assert.deepEqual(r.reqs.map((x) => x.id), ['r_2'], '产品甲只被指派到 r_2');
});

test('resolveTargets：参与多个开发期需求时全部返回，由调用方发卡让其自选', () => {
  const r = resolveTargets('ou_b', COLLEAGUES, REQS);
  assert.deepEqual(r.reqs.map((x) => x.id), ['r_1', 'r_2']);
  assert.equal(r.reqs.length, 2, 'r_3 已归档、r_4 在评审期，都不该进来');
});

test('resolveTargets：是同事但一个开发期需求都没有 → reqs 空（调用方据此 PASS）', () => {
  const r = resolveTargets('ou_b', COLLEAGUES, [REQS[2], REQS[3]]);
  assert.ok(r.colleague);
  assert.deepEqual(r.reqs, []);
});

test('resolveTargets：入参非数组不炸', () => {
  const r = resolveTargets('ou_b', null, undefined);
  assert.equal(r.colleague, null);
  assert.deepEqual(r.reqs, []);
});

test('buildPickCard：每个需求一个按钮，value 自带 kind/openId/reqId/colleagueId', () => {
  const card = buildPickCard('ou_b', 'cl_a', [REQS[0], REQS[1]]);
  const actionEl = card.elements.find((e) => e.tag === 'action');
  assert.equal(actionEl.actions.length, 2);
  const v = actionEl.actions[0].value;
  assert.equal(v.kind, PICK_KIND);
  assert.equal(v.openId, 'ou_b');
  assert.equal(v.colleagueId, 'cl_a');
  assert.equal(v.reqId, 'r_1');
  assert.equal(actionEl.actions[0].text.content, '扫码支付');
  // 按钮 value 自带全部上下文 = 无内存态，机器人重启后旧卡片仍可点
  assert.ok(Object.keys(v).every((k) => ['kind', 'openId', 'colleagueId', 'reqId', '_timestamp'].includes(k)));
});

test('buildPickCard：说明文案点明「选完才会转达」，否则同事不知道为什么要点', () => {
  const card = buildPickCard('ou_b', 'cl_a', [REQS[0]]);
  const div = card.elements.find((e) => e.tag === 'div');
  assert.match(div.text.content, /哪个需求/);
});

test('ACK_TEXT：与用户拍板的文案逐字一致', () => {
  assert.equal(ACK_TEXT, '已收到，信息会同步发送给主机！');
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test src/plugins/colleague-relay/logic.test.js
```

预期：`Cannot find module './logic.js'`。

- [ ] **Step 3: 实现 `src/plugins/colleague-relay/logic.js`**

```js
/**
 * 同事消息中继的纯逻辑（零 IO）：归属判定 + 选择卡片构造。
 * 抽出来是因为两条入站链路（dispatch 文本 / 飞书入口的文件分支）都要用同一套判定——
 * 各写一份必然分叉，表现成「文字消息归对了需求、发的文档归错了」。
 */

/** 卡片按钮的 kind 路由标识（registerCardKindHandler 注册用） */
export const PICK_KIND = 'colleague-pick';

/** 收到同事消息后的统一回执。刻意不多话：真正的处理由主机看过之后决定 */
export const ACK_TEXT = '已收到，信息会同步发送给主机！';

/**
 * open_id → { 该同事, 他参与的开发期需求 }。
 *
 * 只认 `phase === 'dev'`：评审期需求还没开工，归档的已经结束，往里塞消息都没有意义。
 * 调用方据 `reqs.length` 分三路：0 → PASS 回落 feedback；1 → 直接归入；>1 → 发卡让他自选。
 */
export function resolveTargets(openId, colleagues, requirements) {
  const list = Array.isArray(colleagues) ? colleagues : [];
  const reqList = Array.isArray(requirements) ? requirements : [];
  const colleague = list.find((c) => c && c.feishuOpenId && c.feishuOpenId === openId) || null;
  if (!colleague) return { colleague: null, reqs: [] };
  const reqs = reqList.filter(
    (r) => r && r.phase === 'dev' && Array.isArray(r.assignees) && r.assignees.includes(colleague.id),
  );
  return { colleague, reqs };
}

/**
 * 「这条消息是关于哪个需求？」选择卡。
 *
 * 按钮 value 自带 openId/colleagueId/reqId 全部上下文 → 走 kind 路由、**无内存态**，
 * 机器人重启后同事点旧卡片依然有效。同事可能隔几小时才点，用内存 Map 存回调
 * （registerCardActionHandler）会在重启后静默失效，表现为「点了没反应」。
 * 按钮形态对齐 shared/messages.js:buildWelcomeCard 的 quick-action 按钮。
 */
export function buildPickCard(openId, colleagueId, reqs) {
  return {
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '收到～ 请问这条是关于**哪个需求**的？点一下我就转达给主机。',
        },
      },
      {
        tag: 'action',
        actions: reqs.map((r) => ({
          tag: 'button',
          type: 'primary',
          text: { tag: 'plain_text', content: r.title },
          value: {
            kind: PICK_KIND,
            openId,
            colleagueId,
            reqId: r.id,
            _timestamp: Date.now(),
          },
        })),
      },
    ],
  };
}
```

- [ ] **Step 4: 跑测试，确认全绿**

```bash
node --test src/plugins/colleague-relay/logic.test.js
```

预期：`pass 8` / `fail 0`。

---

## Task 4：插件 feature 与卡片回调

**Files:**
- Create: `src/plugins/colleague-relay/feature.js`
- Create: `src/plugins/colleague-relay/index.js`
- Modify: `src/plugins/index.js`

- [ ] **Step 1: 实现 `src/plugins/colleague-relay/feature.js`**

```js
/**
 * 同事消息中继 feature（dispatch 第 ③ 段）。
 *
 * order=35：在 action-runner(30) 之后、feedback(40) 之前——同事说「帮我退款」仍该触发动作，
 * 说「接口文档给你」才归到需求对话。声明了 feedback 的那几个意图，但只在「发信人是某个
 * 开发期需求的开发人员」时接管，否则返回 PASS 让回 feedback（依赖 dispatch 的 intents 段
 * PASS 支持，见 app/dispatch.js）。
 */
import { PASS } from '../../app/signals.js';
import { logger } from '../../shared/logger.js';
import { getColleagues } from '../../store/colleagues.js';
import { getRequirements } from '../../store/requirements.js';
import { appendMessage, addPending, getPending, flushPending } from '../../store/colleague-messages.js';
import { resolveTargets, buildPickCard, ACK_TEXT } from './logic.js';

/** 待归属缓冲非空 = 正在等他选需求，后续消息直接进缓冲，不重走意图识别 */
export function hasPending(ctx) {
  return !!getPending(ctx?.user?.id);
}

export async function handle(ctx) {
  const openId = ctx?.user?.id;
  const { colleague, reqs } = resolveTargets(openId, getColleagues(), getRequirements());

  // 非同事，或不在任何开发期需求中 → 让回 feedback 等后续 feature
  if (!colleague || !reqs.length) {
    // 已有缓冲却查不到目标（如需求中途归档）：清掉缓冲避免永久粘住
    if (getPending(openId)) {
      flushPendingToNowhere(openId);
      logger.warn('colleague-relay', '待归属缓冲的需求已不在开发期，缓冲已丢弃', { openId });
    }
    return PASS;
  }

  const entry = { dir: 'in', text: ctx.text || '', role: colleague.role };

  if (reqs.length === 1) {
    appendMessage(reqs[0].id, colleague.id, entry);
    logger.info('colleague-relay', '同事消息已归入需求', { reqId: reqs[0].id, colleague: colleague.name });
    return ctx.reply(ACK_TEXT);
  }

  // 多个开发期需求：先入缓冲。已在等待中就不重复发卡，否则同事连发三条会收到三张一样的卡
  const already = !!getPending(openId);
  addPending(openId, entry);
  if (already) return ctx.reply('已记下，请点上面的按钮选一下需求～');
  logger.info('colleague-relay', '同事参与多个开发期需求，发选择卡', { openId, count: reqs.length });
  return ctx.sendCard(buildPickCard(openId, colleague.id, reqs));
}

/** 缓冲失效时的丢弃（目标需求已不在开发期）：归到一个不存在的位置即等于清空 */
function flushPendingToNowhere(openId) {
  flushPending(openId, '', '');
  // flushPending 对空 reqId 返回 0 且不写盘，这里显式再清一次缓冲
  const p = getPending(openId);
  if (p) addPending(openId, { dir: 'in', text: '' }); // 占位，实际清理在 store 侧由下面的 dropPending 完成
}

export default {
  name: 'colleague-relay',
  permission: 'any',
  intents: ['bug', 'feature', 'question', 'material', 'other'],
  hasPending,
  handle,
};
```

> ⚠️ 上面 `flushPendingToNowhere` 是个占位写法，**Step 2 会用 store 的 `dropPending` 替换掉**。先照抄，下一步一起改。

- [ ] **Step 2: 给 store 补 `dropPending` 并修正 feature**

在 `src/store/colleague-messages.js` 的 `flushPending` 之后追加：

```js
/** 丢弃缓冲（目标需求已不在开发期等异常情况），避免 hasPending 永久为真把同事粘住 */
export function dropPending(openId) {
  if (!openId) return;
  updateJson(FILE, {}, (raw) => {
    const s = isPlainObject(raw) ? raw : {};
    const p = isPlainObject(s[PENDING_KEY]) ? s[PENDING_KEY] : null;
    if (!p || !p[openId]) return undefined;
    const next = { ...p };
    delete next[openId];
    return { ...s, [PENDING_KEY]: next };
  });
}
```

然后把 `feature.js` 里的 `flushPendingToNowhere(openId);` 整个函数删掉，改为直接调 `dropPending(openId)`，并把 import 改成：

```js
import { appendMessage, addPending, getPending, dropPending } from '../../store/colleague-messages.js';
```

（`flushPending` 在 feature 里不再需要——归入动作发生在卡片回调里，见 index.js。）

- [ ] **Step 3: 给 store 的 `dropPending` 补测试**

在 `src/store/colleague-messages.test.js` 末尾追加：

```js
test('dropPending：丢弃缓冲，hasPending 不再为真（防同事被永久粘住）', async () => {
  const { dropPending } = await import('./colleague-messages.js');
  addPending('ou_drop', { dir: 'in', text: 'x' });
  assert.ok(getPending('ou_drop'));
  dropPending('ou_drop');
  assert.equal(getPending('ou_drop'), null);
  assert.doesNotThrow(() => dropPending('ou_never'));
});
```

```bash
node --test src/store/colleague-messages.test.js
```

预期：`fail 0`。

- [ ] **Step 4: 实现 `src/plugins/colleague-relay/index.js`**

```js
/**
 * 同事消息中继插件。
 * order=35：action-runner(30) 之后、feedback(40) 之前（理由见 feature.js 头注释）。
 */
import { registerCardKindHandler } from '../../shared/card-actions.js';
import { logger } from '../../shared/logger.js';
import { flushPending } from '../../store/colleague-messages.js';
import { getRequirement } from '../../store/requirements.js';
import { sendTextToUser } from '../../integrations/lark.js';
import { getActiveBot } from '../../store/settings.js';
import { PICK_KIND, ACK_TEXT } from './logic.js';
import feature from './feature.js';

/** 同事在选择卡上点了某个需求 → 把缓冲里全部消息归入它 */
async function onPickCardAction(data) {
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const { openId, colleagueId, reqId } = value || {};
  if (!openId || !colleagueId || !reqId) {
    return logger.warn('colleague-relay', '选择卡回调缺少上下文', { value });
  }
  const req = getRequirement(reqId);
  const n = flushPending(openId, reqId, colleagueId);
  logger.info('colleague-relay', '同事选定需求，缓冲已归入', { reqId, colleagueId, count: n });

  // 回执走主动私聊而不是卡片回复：卡片回调没有 ctx.reply
  const bot = getActiveBot();
  if (!bot?.appId || !bot?.appSecret) return;
  const title = req?.title || '该需求';
  const text = n
    ? `${ACK_TEXT}\n已归入需求「${title}」（${n} 条）`
    : `这条消息已经处理过了，无需重复选择～`;
  await sendTextToUser({ appId: bot.appId, appSecret: bot.appSecret }, openId, text).catch((e) =>
    logger.warn('colleague-relay', '选定回执发送失败', { err: e?.message || String(e) }),
  );
}

// 模块加载即注册（feishu / web 进程都会加载插件；web 进程无卡片事件，注册无害）
registerCardKindHandler(PICK_KIND, onPickCardAction);

export default {
  id: 'colleague-relay',
  features: [{ order: 35, feature }],
};
```

- [ ] **Step 5: 在 `src/plugins/index.js` 登记**

在 `PLUGIN_MANIFEST` 数组的 `tracking-stats` 条目**之后**加：

```js
  {
    id: 'colleague-relay',
    description: '同事消息中继：开发期需求的指派同事发来的消息归入该需求对话流，供 web 端查看与回复',
    load: () => import('./colleague-relay/index.js'),
  },
```

- [ ] **Step 6: 语法与全量回归**

```bash
node --check src/plugins/colleague-relay/index.js && node --check src/plugins/colleague-relay/feature.js && npm test
```

预期：`fail 0`。

---

## Task 5：飞书入口 —— 文件 / 图片消息接入

**Files:**
- Modify: `src/entrypoints/feishu/index.js`

> **这个 Task 不能省**：`onInbound` 在调用 dispatch **之前**就处理了 `m.kind === 'image'` 与 `m.kind === 'file'` 并各自 `return`。只做 Task 4 的话，同事发的文字能收到、发的接口文档永远收不到 —— 而那正是四期最重要的输入。

- [ ] **Step 1: 加 import**

在 `src/entrypoints/feishu/index.js` 的 import 区加：

```js
import { getColleagues } from '../../store/colleagues.js';
import { getRequirements } from '../../store/requirements.js';
import { appendMessage, addPending, getPending } from '../../store/colleague-messages.js';
import { resolveTargets, buildPickCard, ACK_TEXT } from '../../plugins/colleague-relay/logic.js';
```

- [ ] **Step 2: 加共用的归属处理函数**

在 `onInbound` 函数**之前**插入：

```js
/**
 * 同事发来的附件（图片 / 文件）→ 归入其开发期需求的对话流。
 *
 * 独立于 dispatch 的 colleague-relay feature：附件消息在 onInbound 早期就被下面两个
 * 分支接走并 return，根本到不了 dispatch。判定逻辑共用 logic.js 的 resolveTargets，
 * 避免「文字归对了需求、附件归错了」这种两份判定各自漂移的结果。
 *
 * @returns {Promise<boolean>} true = 已接管（调用方应 return），false = 不是同事的附件，走原有材料池
 */
async function relayColleagueAttachment(m, say, sendCard, file, kind) {
  const openId = m.userId;
  const { colleague, reqs } = resolveTargets(openId, getColleagues(), getRequirements());
  if (!colleague || !reqs.length) return false;

  const entry = {
    dir: 'in',
    text: m.text || '',
    role: colleague.role,
    files: [{ name: file.name || '', path: file.path || file, kind }],
  };

  if (reqs.length === 1) {
    appendMessage(reqs[0].id, colleague.id, entry);
    logger.info('feishu', '同事附件已归入需求', { reqId: reqs[0].id, colleague: colleague.name, kind });
    await say(ACK_TEXT);
    return true;
  }
  const already = !!getPending(openId);
  addPending(openId, entry);
  if (already) await say('已记下，请点上面的按钮选一下需求～');
  else await sendCard(buildPickCard(openId, colleague.id, reqs));
  return true;
}
```

- [ ] **Step 3: 在两个分支开头插入调用**

在 `if (m.kind === 'image') {` 分支里，**下载成功拿到 `file` 之后、`attachImageToRecentTask` 之前**插入：

```js
    if (await relayColleagueAttachment(m, say, sendCard, { name: '', path: file }, 'image')) return;
```

在 `if (m.kind === 'file') {` 分支里，同样在拿到文件对象 `f` 之后、挂任务/入池之前插入：

```js
    if (await relayColleagueAttachment(m, say, sendCard, f, 'file')) return;
```

> 实施时按该文件的实际变量名对齐（图片分支的落盘路径变量是 `file`，文件分支是 `f`）。若 `sendCard` 在该作用域不可用，用与 `say` 同源的发送函数（读 `onInbound` 顶部对 `say`/`sendCard` 的定义）。

- [ ] **Step 4: 语法自检**

```bash
node --check src/entrypoints/feishu/index.js && echo OK
```

预期：输出 `OK`。

- [ ] **Step 5: 全量回归**

```bash
npm test
```

预期：`fail 0`。

---

## Task 6：web 后端 —— 未读回填与三个端点

**Files:**
- Modify: `src/entrypoints/web/requirement-ops.js`
- Modify: `src/entrypoints/web/routes-requirements.js`
- Test: `src/entrypoints/web/routes-requirements.test.js`

- [ ] **Step 1: 先写失败的测试**

在 `src/entrypoints/web/routes-requirements.test.js` 末尾追加：

```js
// ==== 三期：同事消息中继 ====

const { appendMessage: cmAppend } = await import('../../store/colleague-messages.js');

test('GET /api/req/get：assigneeList 回填 unreadCount', async () => {
  const c = addColleague({ role: 'backend', name: '后端丙', feishuOpenId: 'ou_be9' });
  const r = await createReq('未读回填验证');
  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });

  let got = await get('/api/req/get?id=' + r.id);
  assert.equal(got.json.assigneeList[0].unreadCount, 0, '无消息时必须是 0 而不是 undefined');

  cmAppend(r.id, c.id, { dir: 'in', text: '接口文档发你了', role: 'backend' });
  cmAppend(r.id, c.id, { dir: 'out', text: '收到', status: 'read' });
  got = await get('/api/req/get?id=' + r.id);
  assert.equal(got.json.assigneeList[0].unreadCount, 1, 'out 方向不计未读');
});

test('GET /api/req/colleague-messages：回读会话；缺参 400', async () => {
  const c = addColleague({ role: 'product', name: '产品甲', feishuOpenId: 'ou_pm9' });
  const r = await createReq('会话回读验证');
  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });
  cmAppend(r.id, c.id, { dir: 'in', text: '需求要改', role: 'product' });

  const ok = await get(`/api/req/colleague-messages?reqId=${r.id}&colleagueId=${c.id}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.messages.length, 1);
  assert.equal(ok.json.messages[0].text, '需求要改');

  assert.equal((await get('/api/req/colleague-messages?reqId=' + r.id)).status, 400);
  assert.equal((await get('/api/req/colleague-messages')).status, 400);
});

test('POST /api/req/colleague-messages/read：清零未读', async () => {
  const c = addColleague({ role: 'frontend', name: '前端乙', feishuOpenId: 'ou_fe9' });
  const r = await createReq('已读验证');
  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });
  cmAppend(r.id, c.id, { dir: 'in', text: 'a', role: 'frontend' });

  assert.equal((await post('/api/req/colleague-messages/read', { reqId: r.id, colleagueId: c.id })).status, 200);
  const got = await get('/api/req/get?id=' + r.id);
  assert.equal(got.json.assigneeList[0].unreadCount, 0);
});

test('POST /api/req/colleague-messages/send：未指派该同事 → 400；无机器人 → 502 且不落消息', async () => {
  const c = addColleague({ role: 'ops', name: '运营丁', feishuOpenId: 'ou_ops9' });
  const r = await createReq('发送校验验证');
  // 没指派就发 → 400
  const notAssigned = await post('/api/req/colleague-messages/send', {
    reqId: r.id, colleagueId: c.id, text: 'hi',
  });
  assert.equal(notAssigned.status, 400);

  await put('/api/req/assignees', { id: r.id, assignees: [c.id] });
  // 测试环境无启用机器人 → 502
  const noBot = await post('/api/req/colleague-messages/send', {
    reqId: r.id, colleagueId: c.id, text: 'hi',
  });
  assert.equal(noBot.status, 502);
  const thread = await get(`/api/req/colleague-messages?reqId=${r.id}&colleagueId=${c.id}`);
  assert.deepEqual(thread.json.messages, [], '发送失败不得落消息——否则界面显示一条其实没发出去的');
});

test('POST /api/req/colleague-messages/send：空文本 400；未知需求 404', async () => {
  const r = await createReq('发送参数验证');
  assert.equal((await post('/api/req/colleague-messages/send', { reqId: r.id, colleagueId: 'cl_x', text: '  ' })).status, 400);
  assert.equal((await post('/api/req/colleague-messages/send', { reqId: 'r_none', colleagueId: 'cl_x', text: 'hi' })).status, 404);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test src/entrypoints/web/routes-requirements.test.js
```

预期：新增 5 条 fail。

- [ ] **Step 3: `requirement-ops.js` 回填 unreadCount**

加 import：

```js
import { getUnreadCounts } from '../../store/colleague-messages.js';
```

把 `resolveAssigneeList` 改成接收未读表（保持纯粹：调用方决定要不要带未读）：

```js
export function resolveAssigneeList(assignees, { reqId = null } = {}) {
  // 未读数与 assigneeList 一起回，复用开发期右栏既有轮询，不另开接口、不加一次请求
  const unread = reqId ? getUnreadCounts(reqId) : {};
  return (Array.isArray(assignees) ? assignees : []).map((cid) => {
    const c = getColleague(cid);
    if (!c) {
      return { id: cid, name: '已移除的同事', role: '', roleLabel: '', feishuOpenId: '', missing: true, unreadCount: unread[cid] || 0 };
    }
    return {
      id: c.id,
      name: c.name,
      role: c.role,
      roleLabel: ROLES.find((x) => x.id === c.role)?.label || '',
      feishuOpenId: c.feishuOpenId,
      missing: false,
      unreadCount: unread[cid] || 0,
    };
  });
}
```

- [ ] **Step 4: `routes-requirements.js` —— handleGet 传 reqId**

把 `handleGet` 里的：

```js
  const assigneeList = resolveAssigneeList(r.assignees);
```

改为：

```js
  const assigneeList = resolveAssigneeList(r.assignees, { reqId: id });
```

- [ ] **Step 5: 加三个 handler**

先加 import：

```js
import { getThread, markRead, appendMessage } from '../../store/colleague-messages.js';
import { getActiveBot } from '../../store/settings.js';
import { sendTextToUser } from '../../integrations/lark.js';
```

在 `handleAssignees` 之后插入：

```js
// ==== GET /api/req/colleague-messages?reqId=&colleagueId= ====
function handleColleagueMessages(url, res) {
  const reqId = str(url.searchParams.get('reqId'));
  const colleagueId = str(url.searchParams.get('colleagueId'));
  if (!reqId || !colleagueId) return sendJson(res, 400, { error: 'reqId / colleagueId 均必填' });
  if (!getRequirement(reqId)) return sendJson(res, 404, { error: '需求不存在' });
  const t = getThread(reqId, colleagueId);
  sendJson(res, 200, { messages: t.messages, lastInboundAt: t.lastInboundAt });
}

// ==== POST /api/req/colleague-messages/read {reqId, colleagueId} ====
function handleColleagueRead(req, res) {
  return withJsonBody(req, res, (data) => {
    const reqId = str(data.reqId);
    const colleagueId = str(data.colleagueId);
    if (!reqId || !colleagueId) return sendJson(res, 400, { error: 'reqId / colleagueId 均必填' });
    markRead(reqId, colleagueId);
    sendJson(res, 200, { ok: true });
  });
}

// ==== POST /api/req/colleague-messages/send {reqId, colleagueId, text} ====
function handleColleagueSend(req, res) {
  return withJsonBody(req, res, async (data) => {
    const reqId = str(data.reqId);
    const colleagueId = str(data.colleagueId);
    const text = str(data.text);
    if (!text) return sendJson(res, 400, { error: '消息内容不能为空' });
    const r = getRequirement(reqId);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (!(r.assignees || []).includes(colleagueId)) {
      return sendJson(res, 400, { error: '该同事不在本需求的开发人员里' });
    }
    const c = getColleague(colleagueId);
    if (!c) return sendJson(res, 400, { error: '同事不存在' });
    if (!c.feishuOpenId) return sendJson(res, 400, { error: `${c.name} 未填飞书 open_id，无法发送` });

    // 与二期同一硬约束：名册 open_id 是用启用机器人的凭证取的，open_id 是应用维度的，
    // 换个应用发根本对不上人
    const bot = getActiveBot();
    if (!bot?.appId || !bot?.appSecret) {
      return sendJson(res, 502, { error: '请先在「托管配置」里启用一个飞书机器人并填全凭证' });
    }
    let ok = false;
    try {
      ok = await sendTextToUser({ appId: bot.appId, appSecret: bot.appSecret }, c.feishuOpenId, text);
    } catch (e) {
      return sendJson(res, 502, { error: '发送失败：' + (e?.message || String(e)) });
    }
    // 发送失败不落消息：落了界面会显示一条其实没送达的消息，比不显示更糟
    if (!ok) return sendJson(res, 502, { error: '飞书发送失败，请检查机器人权限与 open_id' });
    const entry = appendMessage(reqId, colleagueId, { dir: 'out', text, status: 'read', role: c.role });
    logger.info('req-routes', '向同事发送消息', { reqId, colleagueId });
    sendJson(res, 200, { ok: true, message: entry });
  });
}
```

- [ ] **Step 6: 登记分发**

在 `handleRequirementRoutes` 里，`/api/req/assignees` 那行之后加：

```js
  if (pathname === '/api/req/colleague-messages' && method === 'GET') return handleColleagueMessages(url, res);
  if (pathname === '/api/req/colleague-messages/read' && method === 'POST') return handleColleagueRead(req, res);
  if (pathname === '/api/req/colleague-messages/send' && method === 'POST') return handleColleagueSend(req, res);
```

- [ ] **Step 7: 跑测试，确认全绿**

```bash
node --test src/entrypoints/web/routes-requirements.test.js
```

预期：`fail 0`。

---

## Task 7：前端 —— 未读气泡与对话面板

**Files:**
- Create: `public/js/colleague-chat.js`
- Modify: `public/js/req-chat.js`
- Modify: `public/app.css`

- [ ] **Step 1: 实现 `public/js/colleague-chat.js`**

```js
/**
 * 同事对话：列表弹窗（谁有未读）→ 对话面板（看消息 / 回消息）。
 *
 * 不塞进 req-assignee-dialog.js：那个管「指派谁」，这个管「跟谁聊」，两件事。
 * 合在一起就会变成一个文件管两种形态的弹窗，后续任何一边改动都要读懂另一边。
 *
 * 依赖方向：colleague-chat → api.js / util.js；由 req-chat 调用，不反向依赖。
 */
import { getJson, postJson } from './api.js';
import { renderMarkdown, isMarkdownPath } from './util.js';
import { openMarkdownFile } from './markdown-tool.js';

const POLL_MS = 10_000; // 与需求右栏轮询同量级；飞书消息不是秒级场景

/**
 * 对话列表弹窗。
 * @param {object} opts
 * @param {string} opts.reqId
 * @param {object[]} opts.assigneeList `/api/req/get` 的 assigneeList（含 unreadCount）
 * @param {Function} [opts.onChangeAssignees] 点「修改指派」时回调（交回 req-chat 开指派弹窗）
 */
export function openColleagueList({ reqId, assigneeList, onChangeAssignees }) {
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML =
    '<div class="modal cc-list-modal">' +
    '<div class="head"><h3>开发人员</h3></div>' +
    '<div class="body"><div class="cc-list"></div></div>' +
    '<div class="confirm-foot">' +
    '<button class="btn cc-edit">修改指派</button>' +
    '<button class="btn cancel">关闭</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(mask);

  const listBox = mask.querySelector('.cc-list');
  const close = () => mask.remove();
  mask.querySelector('.cancel').addEventListener('click', close);
  mask.addEventListener('click', (ev) => {
    if (ev.target === mask) close();
  });
  mask.querySelector('.cc-edit').addEventListener('click', () => {
    close();
    onChangeAssignees?.();
  });

  const list = Array.isArray(assigneeList) ? assigneeList : [];
  if (!list.length) {
    const tip = document.createElement('div');
    tip.className = 'cc-tip';
    tip.textContent = '还没有指派开发人员。';
    listBox.appendChild(tip);
  }
  for (const a of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cc-row' + (a.missing ? ' missing' : '');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = a.roleLabel ? `${a.name}·${a.roleLabel}` : a.name;
    row.appendChild(nm);
    if (a.unreadCount > 0) {
      const dot = document.createElement('span');
      dot.className = 'cc-badge';
      dot.textContent = a.unreadCount > 99 ? '99+' : String(a.unreadCount);
      row.appendChild(dot);
    }
    if (a.missing) {
      const t = document.createElement('span');
      t.className = 'tl';
      t.textContent = '已移除';
      row.appendChild(t);
      row.disabled = true;
    } else if (!a.feishuOpenId) {
      const t = document.createElement('span');
      t.className = 'tl';
      t.textContent = '未填飞书 ID';
      row.appendChild(t);
      row.disabled = true;
      row.title = '未填飞书 open_id，无法收发消息';
    } else {
      row.addEventListener('click', () => {
        close();
        openColleagueChat({ reqId, colleague: a });
      });
    }
    listBox.appendChild(row);
  }
}

/** 单个同事的对话面板 */
export function openColleagueChat({ reqId, colleague }) {
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML =
    '<div class="modal cc-chat-modal">' +
    '<div class="head"><h3></h3></div>' +
    '<div class="body"><div class="cc-msgs"><div class="cc-tip">加载中…</div></div></div>' +
    '<div class="cc-compose">' +
    '<textarea class="cc-input" rows="2" placeholder="回复（Enter 发送 / Shift+Enter 换行）"></textarea>' +
    '<button class="btn primary cc-send">发送</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(mask);
  mask.querySelector('.head h3').textContent = colleague.roleLabel
    ? `${colleague.name}·${colleague.roleLabel}`
    : colleague.name;

  const msgsBox = mask.querySelector('.cc-msgs');
  const input = mask.querySelector('.cc-input');
  const sendBtn = mask.querySelector('.cc-send');
  let timer = null;
  let lastCount = -1;

  const close = () => {
    clearInterval(timer);
    mask.remove();
  };
  mask.addEventListener('click', (ev) => {
    if (ev.target === mask) close();
  });

  function paint(messages) {
    // 只在条数变化时重绘：每 10s 无脑重绘会打断用户选中文本
    if (messages.length === lastCount) return;
    lastCount = messages.length;
    const atBottom = msgsBox.scrollHeight - msgsBox.scrollTop - msgsBox.clientHeight < 40;
    msgsBox.innerHTML = '';
    if (!messages.length) {
      const tip = document.createElement('div');
      tip.className = 'cc-tip';
      tip.textContent = '还没有消息。可以在下面主动发一条。';
      msgsBox.appendChild(tip);
      return;
    }
    for (const m of messages) {
      const row = document.createElement('div');
      row.className = 'cc-msg ' + (m.dir === 'out' ? 'out' : 'in');
      if (m.text) {
        const body = document.createElement('div');
        body.className = 'cc-body';
        // 同事发来的是外部文本，必须走带消毒的 renderMarkdown，不得裸 innerHTML
        body.innerHTML = renderMarkdown(m.text);
        row.appendChild(body);
      }
      for (const f of m.files || []) {
        const fileEl = document.createElement(isMarkdownPath(f.path) ? 'button' : 'span');
        fileEl.className = 'cc-file';
        fileEl.textContent = '📎 ' + (f.name || f.path);
        fileEl.title = f.path;
        if (isMarkdownPath(f.path)) {
          fileEl.type = 'button';
          fileEl.addEventListener('click', () => {
            if (!openMarkdownFile(f.path)) window.toast.error('Markdown 查看器未就绪，请刷新页面重试');
          });
        }
        row.appendChild(fileEl);
      }
      const t = document.createElement('div');
      t.className = 'cc-at';
      t.textContent = new Date(m.at).toLocaleString('zh-CN', { hour12: false });
      row.appendChild(t);
      msgsBox.appendChild(row);
    }
    if (atBottom) msgsBox.scrollTop = msgsBox.scrollHeight;
  }

  async function load() {
    try {
      const { ok, data } = await getJson(
        `/api/req/colleague-messages?reqId=${encodeURIComponent(reqId)}&colleagueId=${encodeURIComponent(colleague.id)}`,
      );
      if (ok) paint(data.messages || []);
    } catch {
      /* 轮询期的网络抖动不打扰用户，下一轮自愈 */
    }
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      const { ok, data } = await postJson('/api/req/colleague-messages/send', {
        reqId,
        colleagueId: colleague.id,
        text,
      });
      if (!ok) return window.toast.error(data?.error || '发送失败');
      input.value = '';
      lastCount = -1; // 强制重绘
      await load();
    } catch {
      window.toast.error('网络错误');
    } finally {
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });

  // 打开即标已读；失败无所谓，下次打开再标
  postJson('/api/req/colleague-messages/read', { reqId, colleagueId: colleague.id }).catch(() => {});
  load();
  timer = setInterval(load, POLL_MS);
  input.focus();
}
```

- [ ] **Step 2: 改 `public/js/req-chat.js` 的「开发人员」按钮**

加 import：

```js
import { openColleagueList } from './colleague-chat.js';
```

把 `renderReqMgmtSection` 里那段「开发人员」按钮的 `mk(...)` 调用替换为：

```js
  // 开发人员：副标题显示当前指派人，右上角显示未读总数
  const assignees = data.assigneeList || [];
  const unreadTotal = assignees.reduce((n, a) => n + (a.unreadCount || 0), 0);
  const assigneeSub = assignees.length
    ? assignees.map((a) => (a.roleLabel ? `${a.name}·${a.roleLabel}` : a.name)).join('、')
    : '未指派，点击选择';
  const btn = mk(TEAM_ICON_SVG, '开发人员', assigneeSub, () => {
    // 已指派 → 先开对话列表（看消息是高频动作）；未指派 → 直接开指派弹窗
    if (assignees.length) {
      openColleagueList({
        reqId: data.id,
        assigneeList: assignees,
        onChangeAssignees: () =>
          openAssigneeDialog({
            reqId: data.id,
            current: (data.assignees || []).slice(),
            onDone: () => refreshRail(data.id),
          }),
      });
    } else {
      openAssigneeDialog({
        reqId: data.id,
        current: [],
        onDone: () => refreshRail(data.id),
      });
    }
  });
  if (unreadTotal > 0) {
    const dot = document.createElement('span');
    dot.className = 'rq-railbadge';
    dot.textContent = unreadTotal > 99 ? '99+' : String(unreadTotal);
    btn.appendChild(dot);
  }
```

- [ ] **Step 3: `public/app.css` 末尾加样式**

```css
/* ---- 同事对话（colleague-chat.js） ---- */
.rq-railbtn { position: relative; }
.rq-railbadge {
  position: absolute; top: 6px; right: 8px;
  min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box;
  border-radius: 8px; background: var(--red, #e5484d); color: #fff;
  font-size: 10px; line-height: 16px; text-align: center; font-weight: 700;
}
.cc-list-modal { width: min(420px, 92vw); }
.cc-list { display: flex; flex-direction: column; gap: 4px; }
.cc-row {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text); font-size: 13px;
  font-family: inherit; cursor: pointer; text-align: left;
}
.cc-row:hover:not(:disabled) { border-color: var(--accent); }
.cc-row:disabled { opacity: .45; cursor: not-allowed; }
.cc-row .nm { flex: 1; }
.cc-row .tl { font-size: 11px; color: var(--faint); }
.cc-badge {
  min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box;
  border-radius: 9px; background: var(--red, #e5484d); color: #fff;
  font-size: 11px; line-height: 18px; text-align: center; font-weight: 700;
}
.cc-chat-modal { width: min(560px, 94vw); }
.cc-msgs {
  display: flex; flex-direction: column; gap: 8px;
  height: 46vh; overflow-y: auto; padding: 4px 2px;
}
.cc-msg { max-width: 78%; padding: 7px 10px; border-radius: 10px; font-size: 13px; }
.cc-msg.in { align-self: flex-start; background: rgba(127, 127, 127, .14); }
.cc-msg.out { align-self: flex-end; background: var(--accent); color: #fff; }
.cc-msg .cc-body { word-break: break-word; }
.cc-msg .cc-body :is(p, ul, ol) { margin: 0 0 4px; }
.cc-msg .cc-at { margin-top: 3px; font-size: 10px; opacity: .6; }
.cc-file {
  display: inline-block; margin-top: 4px; padding: 2px 7px;
  border: 1px solid currentColor; border-radius: 6px;
  font-size: 11px; background: none; color: inherit; font-family: inherit;
}
button.cc-file { cursor: pointer; }
.cc-compose { display: flex; gap: 8px; align-items: flex-end; padding: 10px 16px; border-top: 1px solid var(--border-soft); }
.cc-input {
  flex: 1; box-sizing: border-box; resize: none;
  padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text); font-size: 13px; font-family: inherit;
}
.cc-input:focus { outline: none; border-color: var(--accent); }
.cc-tip { opacity: .6; padding: 14px 6px; font-size: 13px; text-align: center; }
```

- [ ] **Step 4: 确认依赖存在**

```bash
cd "C:/Users/DELL/Desktop/claude-p-web-demo" && grep -n "export function renderMarkdown\|export function isMarkdownPath" public/js/util.js && grep -n "export function openMarkdownFile" public/js/markdown-tool.js && grep -n -- "--red" public/app.css | head -2
```

预期：三个导出都存在。若 `--red` 变量不存在，把 CSS 里的 `var(--red, #e5484d)` 简化为字面值 `#e5484d`（不要引用不存在的变量）。

- [ ] **Step 5: 语法自检**

```bash
node --check public/js/colleague-chat.js && node --check public/js/req-chat.js && for f in public/app.js public/js/*.js; do node --check "$f" || echo "FAIL $f"; done && echo OK
```

预期：输出 `OK`，无 FAIL。

---

## Task 8：文档登记与全量回归

**Files:**
- Modify: `src/store/CLAUDE.md`、`src/entrypoints/CLAUDE.md`、`docs/ARCHITECTURE.md`

- [ ] **Step 1: `src/store/CLAUDE.md`**

在「### 业务领域 store」清单加：

```markdown
- `colleague-messages.js` — 同事 ↔ 机器人的需求对话流（`colleague-messages.json`）：per `reqId × colleagueId` 的消息数组 + `_pending` 待归属缓冲。消息条目带 `role`/`files[].path`/`status`，是为四期「AI 按职位自动处理」留的形状（可直接喂 `/api/req/change` 与 `/api/req/apidoc`）。飞书进程写入站、web 进程写出站与已读，并发写必须走 `updateJson`。
```

在「## 常见改动入口」加：

```markdown
- **要改同事对话的存储形状 / 未读口径 / 待归属缓冲** → `colleague-messages.js`；注意 `_pending` 与 `reqId` 共用一个顶层命名空间（靠下划线前缀隔离），新增顶层键前先读该文件头注释。
```

- [ ] **Step 2: `src/entrypoints/CLAUDE.md`**

在「## 三、常见改动入口」加：

```markdown
- 要**改同事消息中继**：文本链路在 `src/plugins/colleague-relay/`（feature order=35），附件链路在 `web/../feishu/index.js` 的 image/file 分支（**附件走不到 dispatch，两条链路共用 `colleague-relay/logic.js` 的 resolveTargets**）；web 侧的会话读写端点在 `web/routes-requirements.js` 的 `/api/req/colleague-messages*`。
```

- [ ] **Step 3: `docs/ARCHITECTURE.md`**

在架构图的 store 块里，`colleagues.js` 那行之后加：

```
│  │  ├─ colleague-messages.js (同事对话流 + 未读)   │             │
```

- [ ] **Step 4: 全量单测**

```bash
npm test
```

预期：`fail 0`。若失败，先确认是不是本次改动引入 —— `/api/req/get` 的 `assigneeList` 多了 `unreadCount` 字段，任何断言「assigneeList 条目字段全集」的既有用例都会红，需同步更新那条断言（而不是把字段拿掉）。

- [ ] **Step 5: 前端全模块语法自检**

```bash
for f in public/app.js public/js/*.js; do node --check "$f" || echo "FAIL $f"; done; echo done
```

预期：只输出 `done`。

- [ ] **Step 6: 端到端**

```bash
npm run test:e2e
```

预期：与改动前一致（当前基线 8/10，`e2e-ask-chip` 与 `e2e-panels-smoke` 因 `#taskBtn` 元素已不存在而失败，与本次改动无关）。

- [ ] **Step 7: 人工验收（需真实飞书）**

```bash
npm start
```

1. 确认有一个处于**开发期**的需求，且指派了至少一位填了 open_id 的同事；
2. 用那位同事的飞书账号给机器人发一句「接口文档明天给你」→ 应收到「已收到，信息会同步发送给主机！」；
3. web 端开发期右栏「开发人员」按钮右上角出现红色未读气泡（10s 内）；
4. 点开 → 列表里该同事名字右边有气泡 → 点进对话，看到那条消息，气泡清零；
5. 在底部输入框回一句 → 同事的飞书应收到；
6. 同事发一个 `.md` 文件 → 对话里出现 📎 附件，点击能在 Markdown 查看器里打开；
7. **把同一位同事再指派到第二个开发期需求**，让他再发一条 → 应收到「请问这条是关于哪个需求的？」选择卡，点一个按钮后消息归入所选需求；
8. 在步骤 7 的卡片出现后**不要点**，让他再发两条 → 不应重复收到卡片；点按钮后三条消息一并归入。

---

## 自检对照（计划 ↔ spec）

| spec 章节 | 落点 |
|---|---|
| 3.1 intents 段 PASS | Task 1 |
| 3.2 附件走不到 dispatch | Task 5（整个 Task 就是为这条而存在） |
| 3.3 埋点/动作顺序保持现状 | 不改动，无对应 Task（spec §3.3 已说明理由） |
| 3.4 四期下游接口 | Task 2 的数据形状（`role` / `files[].path` / `status`） |
| 4.1 数据模型 | Task 2 Step 3 |
| 4.2 导出接口 | Task 2 Step 3 + Task 4 Step 2（`dropPending`） |
| 4.3 待归属缓冲落盘 + kind 路由 | Task 2（store）+ Task 3（卡片）+ Task 4（回调） |
| 5.1 文本入站 | Task 4 |
| 5.2 附件入站 | Task 5 |
| 5.3 dispatch 改动 | Task 1 |
| 六、出站 | Task 6 Step 5 |
| 七、HTTP 接口 | Task 6 |
| 8.1 未读气泡 | Task 7 Step 2 |
| 8.2 对话列表弹窗 | Task 7 Step 1（`openColleagueList`） |
| 8.3 对话面板 | Task 7 Step 1（`openColleagueChat`） |
| 九、四期对接点 | 无 Task（本期只验证字段够用，不实现） |
| 十、测试 | Task 1/2/3/6 各自的 Step 1 + Task 8 |

**实施时需要临场对齐的一处**：Task 5 Step 3 的插入点依赖 `feishu/index.js` 里 image/file 分支的实际变量名与 `sendCard` 的可用性，计划里已标注按实际情况对齐 —— 这是全计划唯一需要读现场代码再定的地方。

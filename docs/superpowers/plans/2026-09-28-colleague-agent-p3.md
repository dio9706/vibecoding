# 同事侧对话 Agent 化 P3：入口切换 + 数据迁移 + 旧管线下线 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把同事侧对话从「分类器管线（colleague-relay + colleague-auto）」整体切到「agent 循环」，完成 `colleague-messages.json` 的锚点迁移（按需求 → 按人），并删除旧管线。

**Architecture:** 飞书进程负责**判定 + 落盘 + 跨进程触发**（名册判定、文本与附件合并成一条链路）；web 进程负责**跑 agent**（限流闸、组装 prompt、`runAgentTurn`、回复经 lark 直发同事、落盘 out 消息与 toolTrace）。两进程之间走既有的 `postToWeb` 范式。

> 群聊 `@` 过滤**不属于本期改动** —— 它是 `onInbound` 的通用入口逻辑（对所有消息类型生效，不只同事消息），且**只对文本生效**：飞书图片/文件报文不含 `mentions`（发图时无法 @ 人），所以附件分支从来不过这道闸。初稿把它画进了 relay 层，两点都不对，已订正。

**Tech Stack:** Node ≥20 / `node --test` / Claude Agent SDK（`capabilities/agent-session.js` 已就绪）/ 进程内 MCP（`capabilities/agent-tools.js` 已就绪）

> ## ⛔ 全局约束：本计划的所有「提交」步骤一律跳过
>
> 项目根 `CLAUDE.md` 明文：**不自动 `git` 提交，改动留工作区，提交时机由维护者掌控**。
> 计划正文里残留的 `git add` / `git commit` 代码块是 writing-plans 模板的默认产物，
> **执行时一概不执行**。同理不要 `checkout` / `restore` / `stash` / `branch` ——
> 工作区里长期并存着多个功能的未提交改动，任何 git 写操作都可能卷走别人的活。
> 只读命令（`git status` / `git diff` / `git grep`）随便用。
>
> 每个 Task 的验收依据是 **`npm test` 全绿**，不是「提交成功」。

---

## 零、开工前必读：三个「读 spec 推不出来」的事实

这三条是 2026-09-28 核实代码得到的，与 spec 的画法有出入。**照 spec 的架构图写会撞墙。**

### 0.1 agent 会话必须跑在 web 进程，而 feature 挂在 feishu 进程

spec §4 的架构图把「飞书入口 → feature.js → session.js → agent-session.js」画成一条竖线，看起来同进程。实际不行：

```
src/plugins/colleague-agent/tools/req-write.js:22 的注释原话
  registerApiDoc / enqueueSystemTask 活在 entrypoints/web/requirement-ops.js
```

这两个函数操作的是 **web 进程内存里的需求泵与 busy 状态机**。在 feishu 进程动态 import 它们，拿到的是该进程内一份全新的模块实例 —— 泵不在那里跑，busy 状态机是另一份，`start_dev_task` 入队后永远不会被执行。

**结论：职责按进程切开。**

```
feishu 进程                              web 进程
─────────────────────────────────       ─────────────────────────────────
onInbound  ←（群聊 @ 过滤在这里，且**只对文本生效**：
 │            飞书图片/文件报文不含 mentions，附件分支不过这道闸）
 ├─ 文字 → dispatch → feature.js
 └─ 附件 → 早期分支（到不了 dispatch）
      ↓ 共用 relayToAgent()
   名册判定
   appendTo 落盘（dir:'in'）
   POST /api/req/colleague-agent/turn ──→ handleColleagueAgentTurn
   （fire-and-forget，不回 ACK）           ├─ 限流闸（per-人 + 全局并发）
                                          ├─ session.js 组装 prompt / 取 agentSessionId
                                          ├─ runAgentTurn（工具齐备，因为 server.js
                                          │   已 loadPluginSideEffects(['colleague-agent'])）
                                          ├─ lark.sendTextToUser 直接回复同事
                                          └─ appendMessage(dir:'out') + 回填 sessionId/toolTrace
```

### 0.2 限流必须放在 web 进程，不能放 feature.js

spec §4 架构图把限流闸画在 feature.js（feishu 进程）。**全局并发闸放在那里拦不住任何东西** —— 真正并发跑 agent 的是 web 进程，feishu 进程数的是自己发出去了几个 POST。

per-人频率闸同理：两个闸放两个进程会各持一半真相。**两个闸都放 web 路由**，单一真相源。

### 0.3 `colleague-auto.logic.js` 不能整个删

`entrypoints/web/colleague-dev.js:35` import 了它的 `newSubConvId` 与 `buildBrief`，而 `colleague-dev.js` 是 **P2 改造过、当前在跑**的模块（`start_dev_task` 的执行端）。删文件前必须先把这两个函数搬走（Task 8 Step 1）。

---

## 一、文件结构

### 新建

| 文件 | 职责 |
|---|---|
| `src/store/colleague-messages.migration.js` | 锚点迁移纯函数 `migrateColleagueMessages(raw)`（旧 `{reqId}{colleagueId}` → 新 `{colleagueId}`）。单独成文件而非塞进 store：迁移是一次性代码，混进去会让本就不短的 store 更难读，且参照既有 `bots-migration.js` 的先例 |
| `src/store/colleague-messages.migration.test.js` | 四种输入（旧 / 新 / 混合 / 空）的单测 |
| `src/plugins/colleague-agent/rate-limit.js` | 限流：per-人滑动窗口 + 全局并发闸。纯函数状态机 + 一个进程内单例 |
| `src/plugins/colleague-agent/rate-limit.test.js` | 限流单测 |
| `src/plugins/colleague-agent/session.js` | **web 进程**编排层：组装 prompt → `runAgentTurn` → 回复 → 落盘。有 IO |
| `src/plugins/colleague-agent/session.test.js` | 编排层单测（注入假 `runAgentTurn` / 假 lark） |
| `src/plugins/colleague-agent/feature.js` | **feishu 进程** dispatch feature（order 35）：名册判定 → 落盘 → 跨进程触发 → PASS 回落 |
| `src/plugins/colleague-agent/feature.test.js` | feature 单测 |
| `src/plugins/colleague-agent/relay.js` | 文本与附件**共用**的判定 + 落盘 + 跨进程触发。两条入站链路必须共用，否则会漂移成「文字归对了、附件归错了」（这是 relay 时代已经踩过的，见 `feishu/index.js:81` 注释） |
| `src/plugins/colleague-agent/relay.test.js` | 共用层单测 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/store/colleague-messages.js` | 锚点换成 `colleagueId`；条目加 `reqId` / `toolTrace`；线程加 `agentSessionId`；`getUnreadCounts(reqId)` 改为按 `reqId` **标签**过滤；删除 `_pending` 全族（`addPending`/`getPending`/`flushPending`/`dropPending`/`applyPendingFlush`） |
| `src/entrypoints/web/routes-requirements.js` | 新增 `POST /api/req/colleague-agent/turn`；删除 `POST /api/req/colleague-messages/auto` 与 `handleColleagueAuto`；三个既有端点适配新锚点 |
| `src/entrypoints/web/server.js` | ROUTES 表加一行新路由、删一行旧路由 |
| `src/entrypoints/feishu/index.js` | `relayColleagueAttachment` → 改调 `colleague-agent/relay.js`；文字链路的 import 换源 |
| `src/entrypoints/web/colleague-dev.js` | `newSubConvId` / `buildBrief` 的 import 换源 |
| `src/plugins/index.js` | `PLUGIN_MANIFEST` 删 `colleague-relay` 条目 |
| `src/plugins/colleague-agent/index.js` | `features: []` → 挂上 `feature.js`（order 35） |
| `public/js/colleague-chat.js` | 按需适配（API 对外语义保持不变，力争零改动） |

### 删除

```
src/plugins/colleague-relay/          整个目录（index.js / feature.js / logic.js / auto-notify.js + 4 个 test）
src/entrypoints/web/colleague-auto.js
src/entrypoints/web/colleague-auto.test.js
src/entrypoints/web/colleague-auto.logic.js        ← 先搬走 newSubConvId / buildBrief
src/entrypoints/web/colleague-auto.logic.test.js
```

---

## 二、拍板记录（2026-09-28）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 切换策略 | **一次性切，删掉老代码**。不留 settings 回退开关，回退 = `git revert` + 重新打包桌面版 |
| 2 | 四期自动处理 | **一并下线**，能力由 `register_api_doc` + `start_dev_task` 两个 P2 写工具取代 |
| 3 | 限流参数 | **保守档**：per-人 5 条 / 60s 滑动窗口，全局并发 2 |
| 4 | 限流落点 | **web 进程**（偏离 spec 架构图，理由见 §0.2） |
| 5 | agent 执行进程 | **web 进程**（偏离 spec 架构图，理由见 §0.1） |

---

## Task 1: 锚点迁移纯函数

**Files:**
- Create: `src/store/colleague-messages.migration.js`
- Test: `src/store/colleague-messages.migration.test.js`

- [ ] **Step 1: 先读既有迁移范式**

读 `src/store/bots-migration.js`，注意两点：迁移函数是**纯函数**（不碰文件系统），幂等靠「新形状原样返回」而不是标记位。

读 `src/store/colleague-messages.js:1-13` 的文件头，确认旧形状：

```js
// 旧：{ "<reqId>": { "<colleagueId>": { messages, lastInboundAt } }, _pending: {...} }
// 新：{ "<colleagueId>": { agentSessionId, messages: [...每条带 reqId...], lastInboundAt } }
```

- [ ] **Step 2: 写失败的测试**

创建 `src/store/colleague-messages.migration.test.js`：

```js
/**
 * 锚点迁移单测：旧结构（按需求分组）→ 新结构（按人分组，reqId 降为消息标签）。
 * 迁移是一次性、破坏性的，四种输入形状必须全覆盖 —— 跑错一次，同事的历史对话就散了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateColleagueMessages, migrateColleagueMessagesDetailed, isLegacyShape } from './colleague-messages.migration.js';

const msg = (id, text, at) => ({ id, dir: 'in', text, at, role: 'backend', status: 'unread' });

test('旧结构：按需求分组摊平成按人分组，每条消息补上它原来所在的 reqId', () => {
  const raw = {
    r_a: { cl_1: { messages: [msg('cm_1', 'a-1', '2026-09-01T00:00:00Z')], lastInboundAt: '2026-09-01T00:00:00Z' } },
    r_b: { cl_1: { messages: [msg('cm_2', 'b-1', '2026-09-02T00:00:00Z')], lastInboundAt: '2026-09-02T00:00:00Z' } },
  };
  const out = migrateColleagueMessages(raw);
  assert.deepEqual(Object.keys(out), ['cl_1'], '同一个人在两个需求里的对话必须合成一条线');
  assert.equal(out.cl_1.messages.length, 2);
  assert.equal(out.cl_1.messages[0].reqId, 'r_a', 'reqId 降级成消息标签，不能丢');
  assert.equal(out.cl_1.messages[1].reqId, 'r_b');
  assert.equal(out.cl_1.agentSessionId, null, '新线程的 SDK 锚点初始为 null');
});

test('旧结构：多人多需求，各自归位', () => {
  const raw = {
    r_a: {
      cl_1: { messages: [msg('cm_1', 'x', '2026-09-01T00:00:00Z')], lastInboundAt: '2026-09-01T00:00:00Z' },
      cl_2: { messages: [msg('cm_2', 'y', '2026-09-01T01:00:00Z')], lastInboundAt: '2026-09-01T01:00:00Z' },
    },
  };
  const out = migrateColleagueMessages(raw);
  assert.deepEqual(Object.keys(out).sort(), ['cl_1', 'cl_2']);
  assert.equal(out.cl_1.messages[0].text, 'x');
  assert.equal(out.cl_2.messages[0].text, 'y');
});

test('旧结构：合并后按时间排序 —— 两个需求的消息交错时，对话顺序不能乱', () => {
  const raw = {
    r_a: { cl_1: { messages: [msg('cm_1', '早', '2026-09-01T00:00:00Z'), msg('cm_3', '晚', '2026-09-03T00:00:00Z')] } },
    r_b: { cl_1: { messages: [msg('cm_2', '中', '2026-09-02T00:00:00Z')] } },
  };
  const out = migrateColleagueMessages(raw);
  assert.deepEqual(out.cl_1.messages.map((m) => m.text), ['早', '中', '晚']);
});

test('旧结构：lastInboundAt 取各需求里最晚的那个', () => {
  const raw = {
    r_a: { cl_1: { messages: [msg('cm_1', 'x', '2026-09-01T00:00:00Z')], lastInboundAt: '2026-09-01T00:00:00Z' } },
    r_b: { cl_1: { messages: [msg('cm_2', 'y', '2026-09-05T00:00:00Z')], lastInboundAt: '2026-09-05T00:00:00Z' } },
  };
  assert.equal(migrateColleagueMessages(raw).cl_1.lastInboundAt, '2026-09-05T00:00:00Z');
});

test('_pending 整节丢弃 —— 选择卡已下线，那些消息没有归属也无从补', () => {
  const raw = {
    r_a: { cl_1: { messages: [msg('cm_1', 'x', '2026-09-01T00:00:00Z')] } },
    _pending: { ou_xxx: { messages: [msg('cm_9', '丢', '2026-09-01T00:00:00Z')], askedAt: '2026-09-01T00:00:00Z' } },
  };
  const out = migrateColleagueMessages(raw);
  assert.ok(!('_pending' in out));
  assert.ok(!('ou_xxx' in out), '_pending 里的 openId 绝不能被当成 colleagueId 混进新结构');
  assert.equal(out.cl_1.messages.length, 1);
});

test('新结构：原样返回（幂等，重启多次不会反复迁移）', () => {
  const already = {
    cl_1: { agentSessionId: 'sess_x', messages: [{ ...msg('cm_1', 'x', '2026-09-01T00:00:00Z'), reqId: 'r_a' }], lastInboundAt: '2026-09-01T00:00:00Z' },
  };
  assert.deepEqual(migrateColleagueMessages(already), already);
});

test('混合结构：既有已迁移的人、又有没迁的需求 —— 两边都要保住', () => {
  const raw = {
    cl_1: { agentSessionId: 'sess_x', messages: [{ ...msg('cm_1', '已迁', '2026-09-01T00:00:00Z'), reqId: 'r_a' }] },
    r_b: { cl_2: { messages: [msg('cm_2', '未迁', '2026-09-02T00:00:00Z')] } },
  };
  const out = migrateColleagueMessages(raw);
  assert.equal(out.cl_1.messages[0].text, '已迁');
  assert.equal(out.cl_1.agentSessionId, 'sess_x', '已有的 SDK 锚点不能被抹掉');
  assert.equal(out.cl_2.messages[0].text, '未迁');
  assert.equal(out.cl_2.messages[0].reqId, 'r_b');
});

test('混合结构：同一个人既有已迁移数据、又有旧需求下的数据 → 合并且不丢 sessionId', () => {
  const raw = {
    cl_1: { agentSessionId: 'sess_x', messages: [{ ...msg('cm_1', '已迁', '2026-09-01T00:00:00Z'), reqId: 'r_a' }] },
    r_b: { cl_1: { messages: [msg('cm_2', '未迁', '2026-09-02T00:00:00Z')] } },
  };
  const out = migrateColleagueMessages(raw);
  assert.equal(out.cl_1.messages.length, 2);
  assert.equal(out.cl_1.agentSessionId, 'sess_x');
  assert.deepEqual(out.cl_1.messages.map((m) => m.text), ['已迁', '未迁']);
});

test('空 / 非法输入不炸', () => {
  assert.deepEqual(migrateColleagueMessages({}), {});
  assert.deepEqual(migrateColleagueMessages(null), {});
  assert.deepEqual(migrateColleagueMessages([]), {});
  assert.deepEqual(migrateColleagueMessages('x'), {});
});

test('isLegacyShape：靠 r_ 前缀 + 值形状判定，不靠有没有 _pending', () => {
  assert.equal(isLegacyShape({ r_a: { cl_1: { messages: [] } } }), true);
  assert.equal(isLegacyShape({ cl_1: { messages: [], agentSessionId: null } }), false);
  assert.equal(isLegacyShape({}), false);
  assert.equal(isLegacyShape({ _pending: {} }), false, '只剩 _pending 说明没有真数据，不值得触发迁移写盘');
});

test('Detailed：丢弃的 _pending 条数单独返回，绝不塞进 data（data 会被整份写回盘）', () => {
  const raw = {
    r_a: { cl_1: { messages: [msg('cm_1', 'x', '2026-09-01T00:00:00Z')] } },
    _pending: {
      ou_1: { messages: [msg('cm_8', 'p1', '2026-09-01T00:00:00Z'), msg('cm_9', 'p2', '2026-09-01T00:00:00Z')] },
    },
  };
  const r = migrateColleagueMessagesDetailed(raw);
  assert.equal(r.droppedPending, 2);
  assert.ok(!('droppedPending' in r.data));
  assert.ok(!('__droppedPending' in r.data), '内部计数绝不能进落盘数据');
  assert.equal(Object.keys(r.data).length, 1);
});

test('Detailed：新形状输入时 droppedPending 为 0（没有东西可丢）', () => {
  const r = migrateColleagueMessagesDetailed({ cl_1: { agentSessionId: null, messages: [] } });
  assert.equal(r.droppedPending, 0);
});
```

- [ ] **Step 3: 跑到失败**

Run: `node --test src/store/colleague-messages.migration.test.js`
Expected: FAIL — `Cannot find module './colleague-messages.migration.js'`

- [ ] **Step 4: 实现**

创建 `src/store/colleague-messages.migration.js`：

```js
/**
 * `colleague-messages.json` 锚点迁移（破坏性，一次性）。
 *
 *   旧：{ "<reqId>": { "<colleagueId>": { messages, lastInboundAt } }, _pending: {...} }
 *   新：{ "<colleagueId>": { agentSessionId, messages: [...每条带 reqId...], lastInboundAt } }
 *
 * 为什么要换锚点：2.0 的对话锚在**人**身上（一个同事一条长期 thread，靠 SDK session 续跑），
 * 需求归属降级成每条消息上的 `reqId` 标签，由 agent 自己判定。旧结构按需求分组，
 * 同一个人在三个需求里就有三条互不相通的对话线，agent 没法「记得他上周说过什么」。
 *
 * **纯函数**（参照 `bots-migration.js`）：不碰文件系统，调用方在 `updateJson` 的锁内调它。
 * 幂等靠「新形状原样返回」而非标记位 —— 标记位会在用户手工编辑过 JSON 后骗过自己。
 */

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** 待归属缓冲的旧命名空间。迁移时整节丢弃 */
const PENDING_KEY = '_pending';

/**
 * 顶层键看起来是 reqId 吗。
 *
 * 判据是 `r_` 前缀 + 值是「{colleagueId: thread}」形状，**不看有没有 `_pending`** ——
 * 缓冲经常是空的，拿它当判据会让有真实旧数据的库被判成「已迁移」而静默跳过。
 */
export function isLegacyShape(raw) {
  if (!isPlainObject(raw)) return false;
  for (const [k, v] of Object.entries(raw)) {
    if (k === PENDING_KEY) continue;
    if (!isPlainObject(v)) continue;
    // 新结构的值自带 messages 数组；旧结构的值是「一层 colleagueId → thread」
    if (Array.isArray(v.messages)) continue;
    if (k.startsWith('r_')) return true;
  }
  return false;
}

/** 取一条线程里最晚的 lastInboundAt（两边都可能缺） */
function laterOf(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

function emptyThread() {
  return { agentSessionId: null, messages: [], lastInboundAt: null };
}

/**
 * @param {object} raw 盘上原值
 * @returns {{data: object, droppedPending: number}} 输入已是新形状时 data **原样返回**
 *   （含未知字段，不做裁剪）；droppedPending 是被丢弃的 `_pending` 条数，供调用方留痕
 */
export function migrateColleagueMessagesDetailed(raw) {
  if (!isPlainObject(raw)) return { data: {}, droppedPending: 0 };
  if (!isLegacyShape(raw)) {
    // 已是新形状：原样返回。刻意不 normalize —— 那是 store 读路径的职责，
    // 迁移只管换形状，多做一步就多一个「迁移把字段洗没了」的风险面
    const { [PENDING_KEY]: _dropped, ...rest } = raw;
    return { data: rest, droppedPending: 0 };
  }

  const out = {};
  /** 先把已经是新形状的人原样收下（混合结构） */
  for (const [k, v] of Object.entries(raw)) {
    if (k === PENDING_KEY || !isPlainObject(v)) continue;
    if (Array.isArray(v.messages)) out[k] = { ...emptyThread(), ...v, messages: [...v.messages] };
  }

  let dropped = 0;
  for (const [reqId, byColleague] of Object.entries(raw)) {
    if (reqId === PENDING_KEY) {
      // 未归属且选择卡已下线，补不回来。数一下条数留给日志，别静默
      const p = isPlainObject(byColleague) ? byColleague : {};
      for (const v of Object.values(p)) dropped += Array.isArray(v?.messages) ? v.messages.length : 0;
      continue;
    }
    if (!isPlainObject(byColleague) || Array.isArray(byColleague.messages)) continue; // 后者是已迁移的人，上面收过了

    for (const [colleagueId, thread] of Object.entries(byColleague)) {
      if (!isPlainObject(thread)) continue;
      const cur = out[colleagueId] || emptyThread();
      const msgs = Array.isArray(thread.messages) ? thread.messages : [];
      // reqId 从「分组键」降级成「消息标签」——这是整个迁移的核心动作
      for (const m of msgs) if (isPlainObject(m)) cur.messages.push({ ...m, reqId });
      cur.lastInboundAt = laterOf(cur.lastInboundAt, thread.lastInboundAt);
      out[colleagueId] = cur;
    }
  }

  // 合并多个需求的消息后顺序会乱，必须按时间重排：对话读起来的顺序就是它的全部意义
  for (const t of Object.values(out)) {
    t.messages.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  }

  // 丢弃计数**绝不塞进 out**：out 会被整份写回盘，多一个内部字段就是永久污染。
  // 走第二返回值，由调用方按自己的上下文打日志（迁移是纯函数，不 import logger）。
  return { data: out, droppedPending: dropped };
}

/** 薄包装：绝大多数调用方只要数据 */
export function migrateColleagueMessages(raw) {
  return migrateColleagueMessagesDetailed(raw).data;
}
```

- [ ] **Step 5: 跑到通过**

Run: `node --test src/store/colleague-messages.migration.test.js`
Expected: PASS（12 项）

- [ ] **Step 6: 跑全量**

Run: `npm test`
Expected: 全绿（本 Task 只新增文件，不改既有行为）

---

## Task 2: `colleague-messages.js` 换锚点

**Files:**
- Modify: `src/store/colleague-messages.js`（整体改写读写路径）
- Modify: `src/store/colleague-messages.test.js`

- [ ] **Step 1: 先读现状与消费方**

读 `src/store/colleague-messages.js` 全文（279 行）。

**本 Task 的核心纪律：换的是底层存储形状，不是公开签名。**

底下的数据结构从「按需求分组」变成「按人分组」，但**四个既有函数的签名一个都不改** —— 它们内部适配新结构继续工作。新能力走**新名字**的新函数。

这样中间状态只有一次改动（Task 8 删旧管线时，把仅剩的调用点切到新函数并删掉旧函数），而不是「Task 2 把所有调用点批量改一遍 → Task 8 再改回来」。同一批调用点改两次，每次都是一次出错机会。

| 函数 | 本 Task 的处置 |
|---|---|
| `getThread(reqId, colleagueId)` | **签名不变**。内部读该人整条线，再按 `reqId` 标签过滤后返回 |
| `appendMessage(reqId, colleagueId, entry)` | **签名不变**。内部转成 `appendTo(colleagueId, {...entry, reqId})` |
| `markRead(reqId, colleagueId)` | **签名不变**。内部只标该 `reqId` 标签下的未读 |
| `markHandled(reqId, colleagueId, msgId, o)` | **签名不变**。`reqId` 参数内部忽略（msgId 已全局唯一） |
| `getUnreadCounts(reqId)` | 签名不变，改为**按消息上的 `reqId` 标签过滤** |
| `getUnreadTotals()` | 签名不变，改为遍历人、按每条消息的 `reqId` 标签归集 |
| `dropReqThreads(reqId)` | 签名不变，语义改为**摘掉各人名下带该 reqId 标签的消息**，不再删整条线 |
| `addPending`/`getPending`/`flushPending`/`dropPending`/`applyPendingFlush` | **全部删除**（选择卡已下线，没有调用方会在 Task 8 之后留下） |
| **新增** `getColleagueThread(colleagueId)` | 读整条线（跨需求），agent 要的就是这个 |
| **新增** `appendTo(colleagueId, entry)` | 按人追加，`entry.reqId` 是可选标签 |
| **新增** `markColleagueRead(colleagueId, opts)` | `opts.reqId` 可选；不传则标该人全部未读 |
| **新增** `getAgentSessionId` / `setAgentSessionId(colleagueId, id)` | agent thread 锚点 |

> ⚠️ `addPending` 那一族**现在就删**：它们的调用方全在 `colleague-relay/`（Task 8 会整个删掉）与 `feishu/index.js`（Task 7 会改写）。本 Task 删掉它们会让那两处暂时引用不存在的导出 —— 这是预期的，Step 5 有专门的处置。

确认消费方（迁移时必须同步改）：

Run: `grep -rn "colleague-messages" --include=*.js src/ | grep -v test`
Expected: 命中 `feishu/index.js`、`web/colleague-auto.js`、`web/colleague-dev.js`、`web/requirement-ops.js`、`web/routes-requirements.js`、`plugins/colleague-relay/*`、`store/agent-actions.js`

> `colleague-auto.js` 与 `colleague-relay/*` 会在 Task 8 整体删除，本 Task **不必**为它们适配新签名 —— 但要保证 `npm test` 在 Task 2 结束时是绿的，所以本 Task 暂时保留旧函数作为 deprecated 薄包装，Task 8 删调用方后再删包装。

- [ ] **Step 2: 写失败的测试**

在 `src/store/colleague-messages.test.js` 追加：

```js
// ---- 2.0 锚点：按人存，reqId 降为消息标签 ----
// 新能力走新函数名；四个既有函数签名一个不改（见 Step 1 的纪律），它们的回归用例在本段末尾。

test('appendTo(colleagueId, entry)：按人落盘，reqId 作为标签存在消息上', () => {
  appendTo('cl_1', { dir: 'in', text: 'hi', role: 'backend', reqId: 'r_a' });
  const t = getColleagueThread('cl_1');
  assert.equal(t.messages.length, 1);
  assert.equal(t.messages[0].reqId, 'r_a');
  assert.equal(t.messages[0].text, 'hi');
});

test('同一个人跨需求的消息落在同一条线上（这是换锚点的全部目的）', () => {
  appendTo('cl_2', { dir: 'in', text: 'a', reqId: 'r_a' });
  appendTo('cl_2', { dir: 'in', text: 'b', reqId: 'r_b' });
  assert.equal(getColleagueThread('cl_2').messages.length, 2);
});

test('reqId 缺省（agent 还没判出归属）也能落盘，标签为 null', () => {
  appendTo('cl_3', { dir: 'in', text: '不知道属于哪个需求' });
  assert.equal(getColleagueThread('cl_3').messages[0].reqId, null);
});

test('getUnreadCounts(reqId)：按消息上的 reqId 标签过滤，对外语义不变', () => {
  appendTo('cl_4', { dir: 'in', text: 'x', reqId: 'r_x' });
  appendTo('cl_4', { dir: 'in', text: 'y', reqId: 'r_y' });
  appendTo('cl_5', { dir: 'in', text: 'z', reqId: 'r_x' });
  const c = getUnreadCounts('r_x');
  assert.equal(c.cl_4, 1, '只数带 r_x 标签的那条');
  assert.equal(c.cl_5, 1);
});

test('getUnreadCounts：无 reqId 标签的消息不计入任何需求（但仍在整条线里）', () => {
  appendTo('cl_6', { dir: 'in', text: '无归属' });
  assert.equal(getUnreadCounts('r_x').cl_6, undefined);
  assert.equal(getColleagueThread('cl_6').messages.length, 1);
});

test('markColleagueRead(colleagueId)：不带 reqId 时标记该人全部未读', () => {
  appendTo('cl_7', { dir: 'in', text: 'a', reqId: 'r_a' });
  appendTo('cl_7', { dir: 'in', text: 'b', reqId: 'r_b' });
  markColleagueRead('cl_7');
  assert.equal(getColleagueThread('cl_7').messages.every((m) => m.status === 'read'), true);
});

test('markColleagueRead(colleagueId, {reqId})：只标该需求下的，别的需求红点要留着', () => {
  appendTo('cl_8', { dir: 'in', text: 'a', reqId: 'r_a' });
  appendTo('cl_8', { dir: 'in', text: 'b', reqId: 'r_b' });
  markColleagueRead('cl_8', { reqId: 'r_a' });
  const t = getColleagueThread('cl_8');
  assert.equal(t.messages.find((m) => m.reqId === 'r_a').status, 'read');
  assert.equal(t.messages.find((m) => m.reqId === 'r_b').status, 'unread');
});

test('agentSessionId：读写往返，初始为 null', () => {
  assert.equal(getAgentSessionId('cl_9'), null);
  appendTo('cl_9', { dir: 'in', text: 'x' });
  setAgentSessionId('cl_9', 'sess_abc');
  assert.equal(getAgentSessionId('cl_9'), 'sess_abc');
});

test('setAgentSessionId：对没有任何消息的人也能写（agent 可能先起会话后落消息）', () => {
  setAgentSessionId('cl_10', 'sess_x');
  assert.equal(getAgentSessionId('cl_10'), 'sess_x');
});

test('toolTrace：出站消息可带工具轨迹，读回来形状不变', () => {
  appendTo('cl_11', { dir: 'out', text: '查过了', toolTrace: [{ name: 'get_requirement', input: { reqId: 'r_a' } }] });
  const m = getColleagueThread('cl_11').messages[0];
  assert.equal(m.toolTrace.length, 1);
  assert.equal(m.toolTrace[0].name, 'get_requirement');
});

test('toolTrace：入站消息没有轨迹，归一成 null 而非空数组（空数组会让前端误渲染出一个空轨迹区）', () => {
  appendTo('cl_12', { dir: 'in', text: 'x' });
  assert.equal(getColleagueThread('cl_12').messages[0].toolTrace, null);
});

test('dropReqThreads(reqId)：只摘掉该需求的消息，同一个人其它需求的对话必须留着', () => {
  appendTo('cl_13', { dir: 'in', text: 'a', reqId: 'r_del' });
  appendTo('cl_13', { dir: 'in', text: 'b', reqId: 'r_keep' });
  dropReqThreads('r_del');
  const t = getColleagueThread('cl_13');
  assert.equal(t.messages.length, 1);
  assert.equal(t.messages[0].reqId, 'r_keep');
});

test('_pending 全族已删除', async () => {
  const mod = await import('./colleague-messages.js');
  for (const name of ['addPending', 'getPending', 'flushPending', 'dropPending', 'applyPendingFlush']) {
    assert.equal(mod[name], undefined, `${name} 应随选择卡一起下线`);
  }
});

// ---- 四个既有函数的签名回归：旧调用方一行不改也必须照常工作 ----
// 这四条是本 Task「不改签名」纪律的守门人。它们红了就说明旧调用方会一起红，
// 而那正是这个策略要避免的（否则就得把所有调用点改两遍）。

test('旧签名 appendMessage(reqId, colleagueId, entry) 仍可用，reqId 自动落成标签', () => {
  appendMessage('r_old', 'cl_20', { dir: 'in', text: '走旧签名' });
  const t = getColleagueThread('cl_20');
  assert.equal(t.messages.length, 1);
  assert.equal(t.messages[0].reqId, 'r_old', '旧签名的第一个参数要变成消息标签');
});

test('旧签名 getThread(reqId, colleagueId) 仍按该需求过滤（web 面板依赖这个语义）', () => {
  appendTo('cl_21', { dir: 'in', text: '属于A', reqId: 'r_a' });
  appendTo('cl_21', { dir: 'in', text: '属于B', reqId: 'r_b' });
  const t = getThread('r_a', 'cl_21');
  assert.equal(t.messages.length, 1, '旧签名必须只返回该需求的消息，不能把整条线倒出去');
  assert.equal(t.messages[0].text, '属于A');
});

test('旧签名 markRead(reqId, colleagueId) 只标该需求下的未读', () => {
  appendTo('cl_22', { dir: 'in', text: 'a', reqId: 'r_a' });
  appendTo('cl_22', { dir: 'in', text: 'b', reqId: 'r_b' });
  markRead('r_a', 'cl_22');
  const t = getColleagueThread('cl_22');
  assert.equal(t.messages.find((m) => m.reqId === 'r_a').status, 'read');
  assert.equal(t.messages.find((m) => m.reqId === 'r_b').status, 'unread');
});

test('旧签名 markHandled(reqId, colleagueId, msgId, o) 仍能命中（msgId 本就全局唯一）', () => {
  const saved = appendTo('cl_23', { dir: 'in', text: 'x', reqId: 'r_a' });
  assert.equal(markHandled('r_a', 'cl_23', saved.id, { handledBy: 'ai', handledNote: '已处理' }), true);
  assert.equal(getColleagueThread('cl_23').messages[0].handledBy, 'ai');
});
```

- [ ] **Step 3: 跑到失败**

Run: `node --test src/store/colleague-messages.test.js`
Expected: FAIL — 新签名不存在、`getAgentSessionId is not a function` 等

- [ ] **Step 4: 实现**

改写 `src/store/colleague-messages.js`。关键片段（完整替换 `normalizeEntry` / `normalizeThread` / 读写口）：

```js
import { readJson, updateJson } from './index.js';
import { migrateColleagueMessages, isLegacyShape } from './colleague-messages.migration.js';
import { logger } from '../shared/logger.js';

const FILE = 'colleague-messages.json';
export const MAX_MESSAGES = 500;

const STATUSES = ['unread', 'read', 'handled'];
const HANDLED_BY = ['manual', 'ai'];

/**
 * 条目归一。2.0 新增两个字段：
 * - `reqId`：agent 判定的需求归属**标签**（旧版是分组键）。判不出来就是 null，不是空串 ——
 *   空串会在 `getUnreadCounts` 的 `===` 比较里跟「真的属于某需求」混淆。
 * - `toolTrace`：这轮 agent 调了什么，审计用。入站消息**恒为 null**，不是空数组：
 *   前端拿空数组会渲染出一个空的轨迹区。
 */
export function normalizeEntry(e) {
  const o = isPlainObject(e) ? e : {};
  return {
    id: typeof o.id === 'string' && o.id ? o.id : genId(),
    dir: o.dir === 'out' ? 'out' : 'in',
    text: typeof o.text === 'string' ? o.text : '',
    files: Array.isArray(o.files)
      ? o.files.filter(isPlainObject).map((f) => ({
          name: typeof f.name === 'string' ? f.name : '',
          path: typeof f.path === 'string' ? f.path : '',
          kind: f.kind === 'image' ? 'image' : 'file',
        }))
      : [],
    at: typeof o.at === 'string' && o.at ? o.at : new Date().toISOString(),
    role: typeof o.role === 'string' ? o.role : '',
    reqId: typeof o.reqId === 'string' && o.reqId ? o.reqId : null,
    status: STATUSES.includes(o.status) ? o.status : 'unread',
    handledBy: HANDLED_BY.includes(o.handledBy) ? o.handledBy : null,
    handledNote: typeof o.handledNote === 'string' ? o.handledNote : '',
    toolTrace: Array.isArray(o.toolTrace) && o.toolTrace.length
      ? o.toolTrace.filter(isPlainObject).map((t) => ({
          name: typeof t.name === 'string' ? t.name : '',
          input: isPlainObject(t.input) ? t.input : {},
          brief: typeof t.brief === 'string' ? t.brief : '',
        }))
      : null,
  };
}

function emptyThread() {
  return { agentSessionId: null, messages: [], lastInboundAt: null };
}

function normalizeThread(raw) {
  if (!isPlainObject(raw)) return emptyThread();
  const messages = Array.isArray(raw.messages) ? raw.messages.map(normalizeEntry) : [];
  return {
    agentSessionId: typeof raw.agentSessionId === 'string' && raw.agentSessionId ? raw.agentSessionId : null,
    messages: messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages,
    lastInboundAt: typeof raw.lastInboundAt === 'string' ? raw.lastInboundAt : null,
  };
}

/**
 * 读盘并**就地迁移**。
 *
 * 迁移放在读路径而不是启动时跑一次：两个进程都会读这个文件，谁先读到旧数据谁负责转换，
 * 不需要协调「谁来迁」。`isLegacyShape` 是纯判定，新形状下零成本。
 *
 * 只读不写：写回由下一次 `updateJson` 自然完成（那里本来就整份重写）。
 * 好处是读路径不需要拿锁；代价是旧数据在第一次写之前每次读都转一遍 —— 可接受。
 */
function readStore() {
  const s = readJson(FILE, {});
  if (!isPlainObject(s)) return {};
  return isLegacyShape(s) ? migrateColleagueMessages(s) : s;
}

/** 写路径的锁内迁移：必须在这里也做一次，否则旧结构会被新写入覆盖成半新半旧 */
function migrateInLock(raw) {
  const s = isPlainObject(raw) ? raw : {};
  if (!isLegacyShape(s)) return s;
  const { data, droppedPending } = migrateColleagueMessagesDetailed(s);
  logger.warn('colleague-messages', '已迁移到按人锚点', { droppedPending });
  return data;
}

// ================= 新锚点：按人读写（agent 链路用这些） =================

/** 读某人的整条线（跨需求）。agent 要的就是这个 —— 它得记得这个人上周说过什么 */
export function getColleagueThread(colleagueId) {
  if (!colleagueId) return emptyThread();
  return normalizeThread(readStore()[colleagueId]);
}

/** 按人追加一条；`entry.reqId` 是可选的归属标签；dir='in' 时刷新 lastInboundAt */
export function appendTo(colleagueId, entry) {
  if (!colleagueId) return null;
  const e = normalizeEntry(entry);
  updateJson(FILE, {}, (raw) => {
    const s = migrateInLock(raw);
    const t = normalizeThread(s[colleagueId]);
    t.messages.push(e);
    if (t.messages.length > MAX_MESSAGES) t.messages = t.messages.slice(t.messages.length - MAX_MESSAGES);
    if (e.dir === 'in') t.lastInboundAt = e.at;
    return { ...s, [colleagueId]: t };
  });
  return e;
}

/** @param {{reqId?: string}} [opts] 带 reqId 则只标该需求下的（别的需求红点要留着） */
export function markColleagueRead(colleagueId, opts = {}) {
  if (!colleagueId) return;
  const only = opts.reqId || null;
  updateJson(FILE, {}, (raw) => {
    const s = migrateInLock(raw);
    if (!s[colleagueId]) return undefined;
    const t = normalizeThread(s[colleagueId]);
    let changed = false;
    t.messages = t.messages.map((m) => {
      if (m.dir === 'in' && m.status === 'unread' && (!only || m.reqId === only)) {
        changed = true;
        return { ...m, status: 'read' };
      }
      return m;
    });
    if (!changed) return undefined;
    return { ...s, [colleagueId]: t };
  });
}

// ========== 旧签名（Task 8 删除）：内部适配新结构，让旧调用方一行不改 ==========
//
// 为什么留着而不是一次改干净：这四个函数的调用方散在 colleague-relay / feishu 入口 /
// web 路由里，它们在 Task 7/8 会被整体删除或改写。现在改签名 = 把这些调用点改一遍，
// Task 8 删文件时再改回来 —— 同一批代码改两次，每次都是一次出错机会。
// **不要给它们加新功能，也不要在新代码里用它们。**

/** @deprecated 用 getColleagueThread。旧语义是「该需求下该同事的消息」，故按标签过滤 */
export function getThread(reqId, colleagueId) {
  const all = getColleagueThread(colleagueId);
  if (!reqId) return all;
  const messages = all.messages.filter((m) => m.reqId === reqId);
  return {
    ...all,
    messages,
    // lastInboundAt 也要按过滤后的算：不然面板上「最近来信」显示的是别的需求的时间
    lastInboundAt: messages.filter((m) => m.dir === 'in').at(-1)?.at || null,
  };
}

/** @deprecated 用 appendTo。第一个参数落成消息上的 reqId 标签 */
export function appendMessage(reqId, colleagueId, entry) {
  return appendTo(colleagueId, { ...entry, reqId: reqId || null });
}

/** @deprecated 用 markColleagueRead */
export function markRead(reqId, colleagueId) {
  return markColleagueRead(colleagueId, { reqId });
}

/** 某需求下各同事的未读数 —— 现在按消息上的 reqId **标签**过滤（对外语义不变） */
export function getUnreadCounts(reqId) {
  if (!reqId) return {};
  const out = {};
  for (const [cid, raw] of Object.entries(readStore())) {
    const n = normalizeThread(raw).messages.filter(
      (m) => m.dir === 'in' && m.status === 'unread' && m.reqId === reqId,
    ).length;
    if (n > 0) out[cid] = n;
  }
  return out;
}

export function getUnreadTotals() {
  const out = {};
  for (const raw of Object.values(readStore())) {
    for (const m of normalizeThread(raw).messages) {
      // 无归属标签的消息不计入任何需求的红点 —— 它在「按人」的视图里看得到，
      // 但侧栏是按需求组织的，硬塞进某个需求是错的
      if (m.dir === 'in' && m.status === 'unread' && m.reqId) out[m.reqId] = (out[m.reqId] || 0) + 1;
    }
  }
  return out;
}

/**
 * @deprecated 签名保持四参（Task 8 收窄成 `(colleagueId, msgId, opts)`）。
 * `reqId` 参数**内部忽略**：`msgId` 本就全局唯一，换锚点后更不需要靠需求定位消息。
 */
export function markHandled(reqId, colleagueId, msgId, { handledBy, handledNote = '' } = {}) {
  if (!colleagueId || !msgId) return false;
  if (!HANDLED_BY.includes(handledBy)) return false;
  let hit = false;
  updateJson(FILE, {}, (raw) => {
    const s = migrateInLock(raw);
    if (!s[colleagueId]) return undefined;
    const t = normalizeThread(s[colleagueId]);
    t.messages = t.messages.map((m) => {
      if (m.id !== msgId) return m;
      hit = true;
      return normalizeEntry({ ...m, handledBy, handledNote });
    });
    if (!hit) return undefined;
    return { ...s, [colleagueId]: t };
  });
  return hit;
}

/**
 * 需求被物理移除：摘掉**各人名下带该 reqId 标签的消息**，不再删整条线。
 * 换锚点后一条线属于人不属于需求，删线等于把同事的全部历史对话一起抹掉。
 */
export function dropReqThreads(reqId) {
  if (!reqId) return;
  updateJson(FILE, {}, (raw) => {
    const s = migrateInLock(raw);
    let changed = false;
    const next = {};
    for (const [cid, raw2] of Object.entries(s)) {
      const t = normalizeThread(raw2);
      const kept = t.messages.filter((m) => m.reqId !== reqId);
      if (kept.length !== t.messages.length) changed = true;
      next[cid] = { ...t, messages: kept };
    }
    return changed ? next : undefined;
  });
}

// ---- agent thread 锚点 ----

export function getAgentSessionId(colleagueId) {
  if (!colleagueId) return null;
  return normalizeThread(readStore()[colleagueId]).agentSessionId;
}

/** agent 可能先起会话后落消息，所以对没有任何消息的人也要能写 */
export function setAgentSessionId(colleagueId, sessionId) {
  if (!colleagueId) return;
  updateJson(FILE, {}, (raw) => {
    const s = migrateInLock(raw);
    const t = normalizeThread(s[colleagueId]);
    if (t.agentSessionId === (sessionId || null)) return undefined;
    return { ...s, [colleagueId]: { ...t, agentSessionId: sessionId || null } };
  });
}
```

> 别忘了在文件顶部 import `migrateColleagueMessagesDetailed`（`migrateInLock` 用到）。

- [ ] **Step 5: 跑到通过**

Run: `node --test src/store/colleague-messages.test.js`
Expected: PASS

Run: `npm test`
Expected: **会红**，但只红在一个地方 —— 四个既有函数签名没动，所以它们的调用方全都不受影响；**唯一断裂的是 `addPending` 那一族被删掉后的引用**：

```
src/plugins/colleague-relay/feature.js      import { appendMessage, addPending, getPending, dropPending }
src/plugins/colleague-relay/index.js        flushPending（卡片回调里）
src/entrypoints/feishu/index.js             getPending / addPending（附件分支）
```

ESM 的缺失导出是**加载期**错误（`does not provide an export named 'addPending'`），会让这三个文件所在的整条测试链全红，不处理没法验收本 Task。

**处置：本 Task 的范围包含「摘掉 `_pending` 的全部用法」。** 这三处的多需求选择卡逻辑本来就要在 Task 7/8 被删或改写，现在摘掉不会在后续被改回来 —— 不存在返工。

- [ ] **Step 6: 摘掉 `_pending` 的三处用法**

**`src/plugins/colleague-relay/feature.js`**：删掉 `hasPending` 导出、删掉多需求分支，`reqs.length > 1` 时直接归入**第一个**需求并留 warn：

```js
// _pending 选择卡已随锚点迁移下线（P3 Task 2）。这个文件整体将在 Task 8 删除，
// 这里只做最小处置让它在过渡期仍能跑：多需求时归入第一个并留痕。
if (reqs.length > 1) {
  logger.warn('colleague-relay', '同事参与多个开发期需求，选择卡已下线，归入第一个', {
    openId, count: reqs.length, picked: reqs[0].id,
  });
}
const target = reqs[0];
const saved = appendMessage(target.id, colleague.id, entry);
void notifyAutoHandle({ reqId: target.id, colleagueId: colleague.id, role: colleague.role, msgIds: [saved?.id] });
return ctx.reply(ACK_TEXT);
```

同时从 `default` 导出里删掉 `hasPending` 字段。

**`src/plugins/colleague-relay/index.js`**：删掉 `colleague-pick` 卡片回调的整个注册（`flushPending` 的唯一调用方）。

**`src/entrypoints/feishu/index.js`**：`relayColleagueAttachment` 里同样删掉多需求分支，改为归入第一个。

**测试**：删掉 `colleague-relay/*.test.js` 与 `colleague-messages.test.js` 里所有针对 `_pending` / 选择卡 / `hasPending` 的用例（它们测的功能已经不存在了，留着就是在钉一个已下线的契约）。

**验收 grep 必须限定范围，不能全仓跑。** `hasPending` 是 dispatch **Feature 契约**里的通用字段名（`action-runner` / `task-triage` / `bug-patrol` / `feishu-relay` 各有各的实现），`addPending` / `getPending` 在 `store/pending-resume.js` 里是**待续跑队列**——跟本 Task 要下线的 `colleague-messages.json` 的 `_pending` 缓冲毫无关系。全仓跑会有 90+ 处命中，照着它删就是拆掉别的功能。

Run:
```bash
grep -rn "addPending\|getPending\|flushPending\|dropPending\|applyPendingFlush\|hasPending\|colleague-pick" --include=*.js \
  src/store/colleague-messages.js src/store/colleague-messages.test.js \
  src/plugins/colleague-relay/ src/entrypoints/feishu/index.js
```

Expected: 至多 2 行良性命中 ——
- `colleague-messages.test.js` 里「`_pending` 全族已删除」那条用例**必须**把函数名当字符串列出来才能断言它们是 `undefined`，删不掉；
- `feishu/index.js` 里若有一句提到 `bug-patrol` 自己的 `hasPending` 的旧注释，那是另一个功能，不动。

Run: `npm test`
Expected: 全绿

---

## Task 3: 限流

**Files:**
- Create: `src/plugins/colleague-agent/rate-limit.js`
- Test: `src/plugins/colleague-agent/rate-limit.test.js`

**参数（拍板 #3，保守档）：per-人 5 条 / 60s 滑动窗口；全局并发 2。**

- [ ] **Step 1: 写失败的测试**

```js
/**
 * 限流单测。两个闸防的是不同的东西：
 * - per-人滑动窗口：防一个人连珠炮刷额度
 * - 全局并发：防多人同时来把机器打满（每轮 ~10s，2 并发 ≈ 12 轮/分）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, PER_PERSON_MAX, PER_PERSON_WINDOW_MS, GLOBAL_MAX_CONCURRENT } from './rate-limit.js';

test('参数是保守档（改动前先确认是有意的）', () => {
  assert.equal(PER_PERSON_MAX, 5);
  assert.equal(PER_PERSON_WINDOW_MS, 60_000);
  assert.equal(GLOBAL_MAX_CONCURRENT, 2);
});

// ⚠️ 下面三条 per-人用例**必须在每次 tryAcquire 后 release()**。
// 两道闸是不同维度：per-人窗口按**时间**滑出，全局并发按 **release** 释放。
// 不 release 地连调 5 次，模拟的是「5 个会话同时挂着不结束」——那会在第 3 次就撞上
// GLOBAL_MAX_CONCURRENT=2 返回 'busy'，根本走不到第 6 次去验证 'rate'，
// 测的就不是 per-人窗口了。（2026-09-28 实施时实测踩到，原计划漏了 release。）

test('per-人：窗口内第 6 条被拒，理由是 rate', () => {
  let now = 1_000_000;
  const rl = createRateLimiter({ now: () => now });
  // 每条都处理完再来下一条 —— 这才是「一个人连发 6 条」的真实形态
  for (let i = 0; i < 5; i++) {
    const r = rl.tryAcquire('cl_1');
    assert.equal(r.ok, true, `第 ${i + 1} 条应放行`);
    r.release();
  }
  const r = rl.tryAcquire('cl_1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rate', '并发位已全部释放，唯一该拦住它的是 per-人窗口');
});

test('per-人：滑出窗口后恢复', () => {
  let now = 1_000_000;
  const rl = createRateLimiter({ now: () => now });
  for (let i = 0; i < 5; i++) rl.tryAcquire('cl_1').release();
  now += 60_001;
  assert.equal(rl.tryAcquire('cl_1').ok, true);
});

test('per-人：互不影响，一个人刷爆不该挡住别人', () => {
  let now = 1_000_000;
  const rl = createRateLimiter({ now: () => now });
  for (let i = 0; i < 5; i++) rl.tryAcquire('cl_1').release();
  assert.equal(rl.tryAcquire('cl_2').ok, true);
});

test('全局并发：第 3 个并发被拒，理由是 busy', () => {
  const rl = createRateLimiter();
  assert.equal(rl.tryAcquire('cl_1').ok, true);
  assert.equal(rl.tryAcquire('cl_2').ok, true);
  const r = rl.tryAcquire('cl_3');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'busy');
});

test('全局并发：release 后位置腾出来', () => {
  const rl = createRateLimiter();
  const a = rl.tryAcquire('cl_1');
  rl.tryAcquire('cl_2');
  assert.equal(rl.tryAcquire('cl_3').ok, false);
  a.release();
  assert.equal(rl.tryAcquire('cl_3').ok, true);
});

test('release 幂等 —— 重复调用不能把并发数减成负的（finally 里调两次是常见写法）', () => {
  const rl = createRateLimiter();
  const a = rl.tryAcquire('cl_1');
  a.release();
  a.release();
  a.release();
  rl.tryAcquire('cl_2');
  rl.tryAcquire('cl_3');
  assert.equal(rl.tryAcquire('cl_4').ok, false, '并发计数被减成负数的话这里会误放行');
});

test('被拒时不占用配额 —— 否则超限那条会把人的窗口越撑越满', () => {
  let now = 1_000_000;
  const rl = createRateLimiter({ now: () => now });
  rl.tryAcquire('cl_1');
  rl.tryAcquire('cl_2');
  rl.tryAcquire('cl_3'); // 被全局并发拒
  // cl_3 一条都没跑成，它的 per-人窗口应该还是空的
  assert.equal(rl.peekPersonCount('cl_3'), 0);
});
```

- [ ] **Step 2: 跑到失败**

Run: `node --test src/plugins/colleague-agent/rate-limit.test.js`
Expected: FAIL — `Cannot find module './rate-limit.js'`

- [ ] **Step 3: 实现**

```js
/**
 * 同事 agent 的两道限流闸。
 *
 * **必须跑在 web 进程**（agent 真正执行的地方）。放 feishu 进程的 feature 里，
 * 全局并发闸数的只是「自己发出去了几个 POST」，拦不住任何实际并发。
 *
 * 内存态，不落盘：限流是秒级短时状态，进程重启清零完全可接受，
 * 而落盘会给每条消息加一次文件锁往返。
 */

/** 拍板 #3 保守档。改这三个数前先想清楚额度影响：每轮 ~10s，并发 2 ≈ 12 轮/分 */
export const PER_PERSON_MAX = 5;
export const PER_PERSON_WINDOW_MS = 60_000;
export const GLOBAL_MAX_CONCURRENT = 2;

/**
 * @param {{now?: () => number}} [deps] 注入时钟便于测试
 */
export function createRateLimiter(deps = {}) {
  const now = deps.now || (() => Date.now());
  /** colleagueId → 该窗口内的放行时间戳数组 */
  const hits = new Map();
  let running = 0;

  function prune(id, t) {
    const arr = (hits.get(id) || []).filter((x) => t - x < PER_PERSON_WINDOW_MS);
    if (arr.length) hits.set(id, arr);
    else hits.delete(id); // 不留空数组：同事名册会增长，空条目积起来就是内存泄漏
    return arr;
  }

  return {
    /**
     * @returns {{ok:true, release:Function} | {ok:false, reason:'rate'|'busy'}}
     *   **被拒时不占配额**：否则超限那条会把人的窗口越撑越满，越刷越久解不开。
     */
    tryAcquire(colleagueId) {
      const t = now();
      const arr = prune(colleagueId, t);
      if (arr.length >= PER_PERSON_MAX) return { ok: false, reason: 'rate' };
      if (running >= GLOBAL_MAX_CONCURRENT) return { ok: false, reason: 'busy' };

      arr.push(t);
      hits.set(colleagueId, arr);
      running++;
      let released = false;
      return {
        ok: true,
        // 幂等：调用方大概率写在 finally 里，异常路径下可能被调两次
        release() {
          if (released) return;
          released = true;
          running--;
        },
      };
    },
    /** 测试与诊断用 */
    peekPersonCount(colleagueId) {
      return prune(colleagueId, now()).length;
    },
    peekRunning() {
      return running;
    },
  };
}

/** 进程内单例：限流的全局性必须全进程唯一，每次 new 一个等于没有限流 */
export const rateLimiter = createRateLimiter();
```

- [ ] **Step 4: 跑到通过**

Run: `node --test src/plugins/colleague-agent/rate-limit.test.js`
Expected: PASS（8 项）

Run: `npm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/plugins/colleague-agent/rate-limit.js src/plugins/colleague-agent/rate-limit.test.js
git commit -m "feat(colleague-agent): 限流闸（per-人 5/60s + 全局并发 2）"
```

---

## 三、Task 4 及以后

详细步骤见本文件 **第二部分**：`2026-09-28-colleague-agent-p3-part2.md`。

| Task | 内容 |
|---|---|
| 4 | `session.js` —— web 进程的 agent 编排层（失败一律退化到 ACK） |
| 5 | web 路由 `POST /api/req/colleague-agent/turn` |
| 6 | 入站共用层 `relay.js` + dispatch feature（order 35） |
| 7 | 飞书入口合并（附件链路改走同一份判定） |
| 8 | 下线 colleague-relay 与四期自动处理 |
| 9 | 前端与 API 语义验证（三个端点对外语义不变） |
| 10 | **per-需求 worktree 的登记与回收** —— 补 spec §5.3 的漏，P2 从没实现，与 P3 主线无关但会持续泄漏磁盘 |
| 11 | 文档更新（四份模块地图 + spec 分期状态） |

拆两个文件的理由：单文件超过 ~50KB 后，执行期的 agent 每读一次计划就要吞掉大量上下文，而 Task 1-3 是纯新增、与后面 7 个 Task 无交叉依赖，天然是一个可独立验收的批次（数据层 + 限流就绪）。

**Task 1-3 完成后的验收标准：**

```bash
npm test                    # 全绿
```

```bash
# 迁移在真实数据上的干跑（绝不写盘）
node -e "
const fs=require('fs');
const p='C:/Users/DELL/AppData/Roaming/com.principal.desktop/colleague-messages.json';
const raw=JSON.parse(fs.readFileSync(p,'utf8'));
import('./src/store/colleague-messages.migration.js').then(({migrateColleagueMessagesDetailed,isLegacyShape})=>{
  console.log('isLegacy =', isLegacyShape(raw));
  const r=migrateColleagueMessagesDetailed(raw);
  console.log('迁移后人数 =', Object.keys(r.data).length);
  console.log('丢弃的 _pending 条数 =', r.droppedPending);
  for(const [cid,t] of Object.entries(r.data)) console.log(' ', cid, t.messages.length, '条');
});
"
```

**迁移前必须先备份真实数据**（破坏性，拍板 #1 没有回退开关）：

```bash
cp "C:/Users/DELL/AppData/Roaming/com.principal.desktop/colleague-messages.json" \
   "C:/Users/DELL/AppData/Roaming/com.principal.desktop/colleague-messages.pre-p3.bak.json"
```

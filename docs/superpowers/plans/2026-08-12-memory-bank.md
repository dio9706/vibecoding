# 记忆库（Memory Bank）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从已落盘的会话转录里持续提炼用户偏好，形成结构化条目库，经人工确认或阈值自动晋升后渲染进 `CLAUDE.md` 引用的记忆文件，使 AI 越用越懂用户；库可整体导出。

**Architecture:** 五个纯函数模块（预筛 / 状态机 / 渲染 / 调度 / 转录解析）承担全部逻辑并单测覆盖，IO 与 LLM 调用集中在薄胶水层。注入走 `CLAUDE.md` 的 `@` 引用单一路径（探针已证 SDK 自动加载），不写任何 systemPrompt 注入代码。

**Tech Stack:** Node ESM · `node:test` + `node:assert/strict` · 原生 `http` 路由 · 原生 ES module 前端（无构建）· 复用 `runClassifierOnce`（LLM）与 `store/index.js`（文件锁）

**Spec:** `docs/superpowers/specs/2026-08-12-memory-bank-design.md`

---

## 本项目特有约定（务必遵守）

1. **不做 git 提交。** 本项目所有工作改动留工作区，提交时机由用户掌控。因此下文每个任务的收尾步骤是「跑测试确认无回归」，**不是** commit。
2. **只改 `public/`，绝不手改 `src-tauri/resources/`** —— 后者由 `scripts/prepare-sidecar.mjs` 在构建时重新生成。
3. **CSP 限制**：`script-src 'self'` 无 `unsafe-inline`，新前端代码必须放 `public/js/*.js` 由模块导入，不得内联 `<script>`。
4. **测试命令**：全量 `npm test`；单文件 `node --test src/features/memory-bank/prefilter.test.js`。
5. `readJson(name, fallback)` 的 `fallback` **只在 ENOENT 生效**，解析失败会 throw —— 不要当兜底默认值用。

---

## 文件结构

| 文件 | 职责 | 任务 |
|------|------|:---:|
| `src/features/memory-bank/prefilter.js` | 事件流 → 高信号片段（纯） | 1 |
| `src/features/memory-bank/promote.js` | 合并 / 晋升 / 冲突 / 失效状态机（纯） | 2 |
| `src/features/memory-bank/render.js` | 条目 → Markdown + 预算截断（纯） | 3 |
| `src/features/memory-bank/schedule.js` | 调度窗口判定（纯） | 4 |
| `src/store/memory-bank.js` | `memory-bank.json` 读写 | 5 |
| `src/shared/claude-md.js` | `CLAUDE.md` 的 `@` 引用行幂等挂接 | 6 |
| `src/features/token-rotation.js` | 新增 `windowResetsAt` 字段（改） | 7 |
| `src/store/settings.js` | 新增 `memoryBank` 配置段（改） | 8 |
| `src/store/transcript.js` | 按 sessionId 读 JSONL 事件数组 | 9 |
| `src/features/memory-bank/extract.js` | 片段 → 候选条目（LLM） | 10 |
| `src/features/memory-bank/index.js` | 胶水：runOnce / tick / 写盘 / 挂接 | 11 |
| `src/entrypoints/web/routes-memory.js` | `/api/memory/*` | 12 |
| `src/entrypoints/web/server.js` | 挂载子路由（改） | 12 |
| `public/js/memory-view.js` | 面板渲染与操作 | 13 |
| `public/index.html` · `public/app.js` · `public/app.css` | 面板容器 / 入口 / 样式（改） | 13 |

---

## Task 1: 预筛器（`prefilter.js`）

从一次会话的事件流里捞高信号片段。**这是成本控制的第一道闸**，也是最容易写错的一处：工具结果在转录里伪装成 `type==='user'`，不排除就会把工具输出当用户发言。

**Files:**
- Create: `src/features/memory-bank/prefilter.js`
- Test: `src/features/memory-bank/prefilter.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/features/memory-bank/prefilter.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSignals, isRealUserMessage, classifySignal } from './prefilter.js';

const userMsg = (text, i) => ({
  type: 'user',
  message: { role: 'user', content: text },
  timestamp: `2026-08-11T00:0${i}:00.000Z`,
  sessionId: 's1',
});
const asstMsg = (text, i) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  timestamp: `2026-08-11T00:0${i}:00.000Z`,
  sessionId: 's1',
});
const toolResult = (text, i) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content: text, tool_use_id: 't1' }] },
  timestamp: `2026-08-11T00:0${i}:00.000Z`,
  sessionId: 's1',
});
// 工具调用：顶层 type='assistant'，content 块是 tool_use；messageText 对它返回 ''
const toolUse = (i) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} }] },
  timestamp: `2026-08-11T00:0${i}:00.000Z`,
  sessionId: 's1',
});

test('工具结果伪装成 type=user —— 必须排除，否则工具输出会被当成用户偏好', () => {
  assert.equal(isRealUserMessage(toolResult('不对，应该改成 ESM', 1)), false);
  const { segments } = extractSignals([toolResult('不对，应该改成 ESM', 1)]);
  assert.deepEqual(segments, []);
});

test('classifySignal：explicit 优先级高于 correction', () => {
  assert.equal(classifySignal('以后都要用中文写注释'), 'explicit');
  assert.equal(classifySignal('不对，应该用中文'), 'correction');
  assert.equal(classifySignal('帮我看下这个函数'), null);
});

test('classifySignal：同时命中 explicit 和 correction 正则时必须判为 explicit —— 守住判定顺序这个不变量，因为用互不重叠的字符串测不出「顺序判反」这种 bug（两条正则各自命中各自的分支，谁先判都能通过），只有同时命中两个正则的字符串才能真正暴露顺序问题', () => {
  // "以后"命中 EXPLICIT_RE，"应该"命中 CORRECTION_RE，两者同时出现在一句话里
  assert.equal(classifySignal('以后应该这样做'), 'explicit');
  // "记住"命中 EXPLICIT_RE，"改成"命中 CORRECTION_RE
  assert.equal(classifySignal('记住，改成中文'), 'explicit');
  // "每次"命中 EXPLICIT_RE，"不对"命中 CORRECTION_RE
  assert.equal(classifySignal('每次都不对，一律用中文'), 'explicit');
});

test('命中信号时带上前后各 2 条上下文，且不含自身', () => {
  const events = [
    asstMsg('我加了英文注释', 1),
    userMsg('不对，注释写中文', 2),
    asstMsg('好的，改成中文', 3),
  ];
  const { segments } = extractSignals(events);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, 'correction');
  assert.equal(segments[0].quote, '不对，注释写中文');
  assert.equal(segments[0].sessionId, 's1');
  assert.deepEqual(segments[0].context, [
    'assistant: 我加了英文注释',
    'assistant: 好的，改成中文',
  ]);
});

test('工具事件（tool_use/tool_result）不占用上下文窗口名额 —— 按索引开窗会被工具事件的空文本挤掉被纠正的那句原话', () => {
  const events = [
    asstMsg('我加了英文注释', 1),
    toolUse(2),
    toolResult('ok', 3),
    userMsg('不对，注释写中文', 4),
  ];
  const { segments } = extractSignals(events);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].context, ['assistant: 我加了英文注释'],
    '应向左游走跳过两条空文本的工具事件，找到真正的助手原话，而不是拿到 []');
});

test('extractSignals 不得修改传入的 events 数组或其元素 —— 纯函数契约回归测试', () => {
  const events = [userMsg('不对，这里错了', 1), asstMsg('好的', 2)];
  const snapshot = JSON.parse(JSON.stringify(events));
  extractSignals(events);
  assert.deepEqual(events, snapshot, '调用后入参事件数组内容不该被修改');
});

test('超出 maxSegments 时按 kind 优先级保留，并如实报告丢弃数', () => {
  const events = [
    userMsg('不对，这里错了', 1),
    userMsg('记住，以后都用 ESM', 2),
    userMsg('别这样写', 3),
  ];
  const { segments, dropped } = extractSignals(events, { maxSegments: 1 });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, 'explicit', 'explicit 必须优先于 correction 被保留');
  assert.equal(dropped, 2);
});

test('畸形输入不抛异常', () => {
  assert.deepEqual(extractSignals(null).segments, []);
  assert.deepEqual(extractSignals([null, {}, { type: 'user' }]).segments, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/memory-bank/prefilter.test.js`
Expected: FAIL — `Cannot find module './prefilter.js'`

- [ ] **Step 3: 实现**

创建 `src/features/memory-bank/prefilter.js`：

```js
/**
 * 记忆库预筛器 —— 从一次会话的 JSONL 事件流里捞出高信号片段。
 * 纯函数、零 IO、零 LLM：一次会话数百条消息，全量喂 LLM 会安静吃掉用户干正事的额度，
 * 预筛后通常只剩 3-5 段。
 *
 * 头号陷阱：工具结果在转录里顶层也是 type==='user'，
 * 不先排除就会把工具输出当成用户发言去提炼偏好。
 */

/** 显式偏好声明：用户直接下规矩，几乎不会误判 → 单条证据即可晋升 */
const EXPLICIT_RE = /记住|以后|每次|下次|不许|一律|统一用|都要/;
/** 纠正措辞：紧邻上下文就是被纠正的行为 */
const CORRECTION_RE = /不对|不是这样|别这样|不要这样|应该|改成|重来|错了|回退|我说过|说了多少次|又忘了/;

/** kind 优先级（越小越先保留），超预算截断时用 */
const KIND_PRIORITY = { explicit: 0, correction: 1, denial: 2, rework: 3 };

/** 取事件文本：content 可能是字符串，也可能是块数组（只收 text 块） */
export function messageText(ev) {
  const c = ev?.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b?.type === 'text')
    .map((b) => b.text || '')
    .join('\n');
}

/** 是否工具结果（顶层 type==='user'，但 content 块是 tool_result） */
export function isToolResult(ev) {
  const c = ev?.message?.content;
  return Array.isArray(c) && c.some((b) => b?.type === 'tool_result');
}

/** 是否「真」用户发言 */
export function isRealUserMessage(ev) {
  if (ev?.type !== 'user') return false;
  if (isToolResult(ev)) return false;
  return messageText(ev).trim().length > 0;
}

/** 文本 → 信号类型；无信号返回 null。explicit 先判，优先级高于 correction */
export function classifySignal(text) {
  const s = String(text || '');
  if (EXPLICIT_RE.test(s)) return 'explicit';
  if (CORRECTION_RE.test(s)) return 'correction';
  return null;
}

/**
 * @param {Array} events 一次会话的事件数组（已 JSON.parse）
 * @param {{maxSegments?:number, contextRadius?:number}} [opts]
 * @returns {{segments:Array<{kind,quote,at,sessionId,context:string[]}>, dropped:number}}
 */
export function extractSignals(events, { maxSegments = 30, contextRadius = 2 } = {}) {
  const list = Array.isArray(events) ? events : [];
  const norm = list.map((ev) => ({
    role: ev?.type === 'assistant' ? 'assistant' : 'user',
    text: messageText(ev),
    isUser: isRealUserMessage(ev),
    at: ev?.timestamp || '',
    sessionId: ev?.sessionId || '',
  }));

  const hits = [];
  for (let i = 0; i < norm.length; i++) {
    if (!norm[i].isUser) continue;
    const kind = classifySignal(norm[i].text);
    if (!kind) continue;
    // 从命中位置 i 向两侧游走，各收集最多 contextRadius 条「非空文本」的消息 ——
    // 不能按原始事件索引直接开窗：真实转录里 tool_use/tool_result 的 messageText 是 ''，
    // 密度又极高，按索引开窗会被它们把名额占满，导致被纠正的那句助手原话被挤到窗口外。
    const before = [];
    for (let j = i - 1; j >= 0 && before.length < contextRadius; j--) {
      const t = norm[j].text.trim();
      // 单条上下文截断到 300 字，防长工具输出/长回答撑爆 prompt
      if (t) before.push(`${norm[j].role}: ${t.slice(0, 300)}`);
    }
    before.reverse();
    const after = [];
    for (let j = i + 1; j < norm.length && after.length < contextRadius; j++) {
      const t = norm[j].text.trim();
      if (t) after.push(`${norm[j].role}: ${t.slice(0, 300)}`);
    }
    const context = [...before, ...after];
    hits.push({
      kind,
      quote: norm[i].text.trim(),
      at: norm[i].at,
      sessionId: norm[i].sessionId,
      context,
    });
  }

  hits.sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
  const dropped = Math.max(0, hits.length - maxSegments);
  return { segments: hits.slice(0, maxSegments), dropped };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/memory-bank/prefilter.test.js`
Expected: PASS，8 个用例全绿

- [ ] **Step 5: 跑全量确认无回归**

Run: `npm test`
Expected: 原有用例数 + 8 全绿。**不提交**，改动留工作区。

---

## Task 2: 晋升状态机（`promote.js`）

功能的核心。**最关键的不变量：同一次会话里的重复不算多份证据** —— 否则 AI 在一次会话里连犯三次错、用户连说三遍「别加注释」，会被误判成三票独立证据直接自动生效。

**Files:**
- Create: `src/features/memory-bank/promote.js`
- Test: `src/features/memory-bank/promote.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/features/memory-bank/promote.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandidates, applyDormancy, DEFAULT_THRESHOLD } from './promote.js';

const NOW = Date.parse('2026-08-11T00:00:00.000Z');
const DAY = 86400000;

// 递增 id 生成器：显式注入，保证纯函数可测（无 random / 无 Date.now）
const idGen = () => { let n = 0; return () => `mem_${++n}`; };

const cand = (over = {}) => ({
  category: 'code-style',
  scope: 'global',
  projectDir: '',
  statement: '注释写中文',
  fingerprint: 'code-style:注释语言',
  source: 'inferred',
  quote: '不对，注释写中文',
  sessionId: 's1',
  at: '2026-08-11T00:00:00.000Z',
  kind: 'correction',
  ...over,
});

const emptyState = () => ({ items: [], blacklist: [] });

test('新候选建为 candidate，不直接生效', () => {
  const r = mergeCandidates(emptyState(), [cand()], { now: NOW, makeId: idGen() });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].status, 'candidate');
  assert.equal(r.items[0].evidenceCount, 1);
  assert.deepEqual(r.promoted, []);
});

test('同一会话内重复三次 —— 不得自动晋升（同一事件不是三份证据）', () => {
  const r = mergeCandidates(emptyState(), [cand(), cand(), cand()], { now: NOW, makeId: idGen() });
  assert.equal(r.items.length, 1, '同 fingerprint 必须合并成一条');
  assert.equal(r.items[0].evidenceCount, 3);
  assert.deepEqual(r.items[0].evidenceSessions, ['s1'], '同会话只记一个 session');
  assert.equal(r.items[0].status, 'candidate', '跨会话数不足，不能晋升');
  assert.deepEqual(r.promoted, []);
});

test('3 次证据且跨 2 个会话 → 自动晋升，acked=false 供红点消费', () => {
  const makeId = idGen();
  let s = mergeCandidates(emptyState(), [cand(), cand({ sessionId: 's2' })], { now: NOW, makeId });
  assert.equal(s.items[0].status, 'candidate');
  s = mergeCandidates(s, [cand({ sessionId: 's3' })], { now: NOW, makeId });
  assert.equal(s.items[0].status, 'active');
  assert.equal(s.items[0].promotedBy, 'auto');
  assert.equal(s.items[0].acked, false);
  assert.deepEqual(s.promoted, ['mem_1']);
});

test('显式偏好单条证据即晋升（用户直说「以后都用 X」，不该等三次）', () => {
  const r = mergeCandidates(emptyState(), [cand({ source: 'explicit', kind: 'explicit' })], {
    now: NOW, makeId: idGen(),
  });
  assert.equal(r.items[0].status, 'active');
  assert.deepEqual(r.promoted, ['mem_1']);
});

test('黑名单命中直接丢弃 —— 否掉的条目不得反复骚扰', () => {
  const state = { items: [], blacklist: [{ fingerprint: 'code-style:注释语言', rejectedAt: NOW }] };
  const r = mergeCandidates(state, [cand()], { now: NOW, makeId: idGen() });
  assert.deepEqual(r.items, []);
});

test('已有条目的 statement 不被覆盖（用户可能已手工编辑过）', () => {
  const makeId = idGen();
  let s = mergeCandidates(emptyState(), [cand()], { now: NOW, makeId });
  s.items[0].statement = '注释写中文，只解释为什么';
  s = mergeCandidates(s, [cand({ statement: '注释用中文' })], { now: NOW, makeId });
  assert.equal(s.items[0].statement, '注释写中文，只解释为什么');
});

test('evidence 最多留 5 条丢最旧，但 evidenceCount 是累计值', () => {
  const makeId = idGen();
  let s = emptyState();
  for (let i = 1; i <= 7; i++) {
    s = mergeCandidates(s, [cand({ sessionId: `s${i}`, quote: `第${i}次` })], { now: NOW, makeId });
  }
  assert.equal(s.items[0].evidence.length, 5);
  assert.equal(s.items[0].evidence[0].quote, '第3次');
  assert.equal(s.items[0].evidenceCount, 7);
});

test('冲突：新证据与已生效条目对立时不覆盖，两边都置 conflict 停止注入', () => {
  const makeId = idGen();
  let s = mergeCandidates(emptyState(), [cand({ source: 'explicit' })], { now: NOW, makeId });
  assert.equal(s.items[0].status, 'active');
  s = mergeCandidates(s, [cand({ statement: '注释写英文', contradicts: true, source: 'explicit' })], {
    now: NOW, makeId,
  });
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0].status, 'conflict');
  assert.equal(s.items[1].status, 'conflict');
  assert.equal(s.items[0].conflictWith, s.items[1].id);
  assert.equal(s.items[1].conflictWith, s.items[0].id);
});

test('applyDormancy：90 天无新证据降级 dormant，数据保留', () => {
  const items = [
    { id: 'a', status: 'active', lastSeenAt: NOW - 91 * DAY, statement: 'x' },
    { id: 'b', status: 'active', lastSeenAt: NOW - 10 * DAY, statement: 'y' },
    { id: 'c', status: 'candidate', lastSeenAt: NOW - 200 * DAY, statement: 'z' },
  ];
  const out = applyDormancy(items, { now: NOW, dormantDays: 90 });
  assert.equal(out[0].status, 'dormant');
  assert.equal(out[0].statement, 'x', '降级只改状态，不删数据');
  assert.equal(out[1].status, 'active');
  assert.equal(out[2].status, 'candidate', 'candidate 不参与休眠降级');
});

test('dormant 条目再次出现证据 → 复活为 active', () => {
  const state = {
    items: [{
      id: 'mem_x', category: 'code-style', scope: 'global', projectDir: '',
      statement: '注释写中文', fingerprint: 'code-style:注释语言',
      status: 'dormant', inject: true, source: 'inferred',
      evidenceCount: 3, evidenceSessions: ['s1', 's2'], evidence: [],
      promotedBy: 'auto', acked: true, conflictWith: null,
      createdAt: NOW - 200 * DAY, updatedAt: NOW - 200 * DAY, lastSeenAt: NOW - 200 * DAY,
    }],
    blacklist: [],
  };
  const r = mergeCandidates(state, [cand({ sessionId: 's9' })], { now: NOW, makeId: idGen() });
  assert.equal(r.items[0].status, 'active');
});

test('DEFAULT_THRESHOLD 暴露为可配值', () => {
  assert.deepEqual(DEFAULT_THRESHOLD, { minEvidence: 3, minSessions: 2 });
});

test('mergeCandidates 不得修改传入的 state —— 文件头注明「纯函数」，调用方有权假设旧引用不被污染', () => {
  const makeId = idGen();
  const originalSessions = ['s1'];
  const originalEvidence = [{ sessionId: 's1', at: '2026-08-01T00:00:00.000Z', quote: '旧证据', kind: 'correction' }];
  const state = {
    items: [{
      id: 'mem_x', category: 'code-style', scope: 'global', projectDir: '',
      statement: '注释写中文', fingerprint: 'code-style:注释语言',
      status: 'candidate', inject: true, source: 'inferred',
      evidenceCount: 1, evidenceSessions: originalSessions, evidence: originalEvidence,
      promotedBy: null, acked: true, conflictWith: null,
      createdAt: NOW, updatedAt: NOW, lastSeenAt: NOW,
    }],
    blacklist: [],
  };

  const r = mergeCandidates(state, [cand({ sessionId: 's2' })], { now: NOW, makeId });

  // 只做了浅拷贝：items 数组和 item 对象是新的，但 item 内部的数组字段仍是原引用；
  // 若实现里对 evidenceSessions 用 .push()，就会原地改到调用方持有的旧数组上。
  assert.deepEqual(originalSessions, ['s1'], '调用前持有的 evidenceSessions 引用，调用后内容不该变');
  assert.notEqual(r.items[0].evidenceSessions, originalSessions, '返回值的 evidenceSessions 必须是新数组，不能与入参共享引用');
  assert.deepEqual(originalEvidence, [{ sessionId: 's1', at: '2026-08-01T00:00:00.000Z', quote: '旧证据', kind: 'correction' }], 'evidence 字段同理不该被污染（当前用 concat+slice 重新赋值，此断言应天然通过）');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/memory-bank/promote.test.js`
Expected: FAIL — `Cannot find module './promote.js'`

- [ ] **Step 3: 实现**

创建 `src/features/memory-bank/promote.js`：

```js
/**
 * 记忆库状态机 —— 候选合并、证据累计、晋升、冲突、失效。
 * 纯函数：无 IO、无 Date.now、无 random。时间与 id 生成由调用方注入（now / makeId），便于单测。
 *
 * 核心不变量：晋升要求「evidenceCount 达标 **且** 跨 >=2 个不同 session」。
 * 只数 evidenceCount 会把「一次会话里连说三遍」误判成三份独立证据。
 */

export const DEFAULT_THRESHOLD = { minEvidence: 3, minSessions: 2 };
export const MAX_EVIDENCE = 5;
export const DEFAULT_DORMANT_DAYS = 90;

/** 注入组：这三类渲染进 CLAUDE.md；dialogue / tech-pref 仅记录 */
const INJECT_CATEGORIES = new Set(['code-style', 'collaboration', 'writing']);

const DAY_MS = 86400000;

function makeEvidence(c) {
  return { sessionId: c.sessionId || '', at: c.at || '', quote: c.quote || '', kind: c.kind || 'correction' };
}

/** 够格晋升？显式偏好走例外通道：用户直说的规矩不该等三次 */
function shouldPromote(item, threshold) {
  if (item.source === 'explicit') return item.evidenceCount >= 1;
  return item.evidenceCount >= threshold.minEvidence
    && item.evidenceSessions.length >= threshold.minSessions;
}

function newItem(c, id, now) {
  return {
    id,
    category: c.category,
    scope: c.scope === 'project' ? 'project' : 'global',
    projectDir: c.scope === 'project' ? c.projectDir || '' : '',
    statement: c.statement,
    fingerprint: c.fingerprint,
    status: 'candidate',
    inject: INJECT_CATEGORIES.has(c.category),
    source: c.source === 'explicit' ? 'explicit' : 'inferred',
    evidenceCount: 1,
    evidenceSessions: c.sessionId ? [c.sessionId] : [],
    evidence: [makeEvidence(c)],
    promotedBy: null,
    acked: true,
    conflictWith: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
}

/**
 * 合并一批候选进现有状态。
 * @param {{items:Array, blacklist:Array}} state
 * @param {Array} candidates 含 fingerprint / statement / category / sessionId / quote / source / contradicts?
 * @param {{now:number, makeId:function, threshold?:object}} ctx
 * @returns {{items:Array, blacklist:Array, promoted:string[]}} promoted = 本轮自动晋升的 id
 */
export function mergeCandidates(state, candidates, { now, makeId, threshold = DEFAULT_THRESHOLD }) {
  const items = (state?.items || []).map((it) => ({ ...it }));
  const blacklist = (state?.blacklist || []).slice();
  const banned = new Set(blacklist.map((b) => b.fingerprint));
  const promoted = [];

  for (const c of candidates || []) {
    if (!c?.fingerprint || !c?.statement || !c?.category) continue;
    if (banned.has(c.fingerprint)) continue; // 用户否过的，永不复活

    const idx = items.findIndex((it) => it.fingerprint === c.fingerprint && it.status !== 'conflict');
    if (idx < 0) {
      const fresh = newItem(c, makeId(), now);
      if (shouldPromote(fresh, threshold)) {
        fresh.status = 'active';
        fresh.promotedBy = 'auto';
        fresh.acked = false;
        promoted.push(fresh.id);
      }
      items.push(fresh);
      continue;
    }

    const it = items[idx];

    // 冲突：与已生效条目对立 —— 不覆盖，两边停注入交用户裁决
    if (it.status === 'active' && c.contradicts && c.statement.trim() !== it.statement.trim()) {
      const rival = newItem(c, makeId(), now);
      rival.status = 'conflict';
      rival.conflictWith = it.id;
      rival.acked = false;
      it.status = 'conflict';
      it.conflictWith = rival.id;
      it.acked = false;
      it.updatedAt = now;
      items.push(rival);
      continue;
    }

    // 常规累计。statement 不覆盖：用户可能已手工编辑过
    it.evidenceCount += 1;
    // 重新赋值而非 .push()：浅拷贝只新建了 item 对象本身，evidenceSessions 仍是调用方传入的原数组引用，
    // 原地 push 会污染调用方手里的旧 state —— 与 evidence 字段的处理方式（concat 重新赋值）保持一致
    if (c.sessionId && !it.evidenceSessions.includes(c.sessionId)) {
      it.evidenceSessions = it.evidenceSessions.concat(c.sessionId);
    }
    it.evidence = it.evidence.concat(makeEvidence(c)).slice(-MAX_EVIDENCE);
    if (c.source === 'explicit') it.source = 'explicit';
    it.lastSeenAt = now;
    it.updatedAt = now;

    if ((it.status === 'candidate' || it.status === 'dormant') && shouldPromote(it, threshold)) {
      it.status = 'active';
      it.promotedBy = it.promotedBy || 'auto';
      it.acked = false;
      promoted.push(it.id);
    }
  }

  return { items, blacklist, promoted };
}

/** 超期无新证据 → dormant：停注入但保留全部数据（导出与数字分身仍需要） */
export function applyDormancy(items, { now, dormantDays = DEFAULT_DORMANT_DAYS }) {
  const limit = dormantDays * DAY_MS;
  return (items || []).map((it) =>
    it.status === 'active' && now - (it.lastSeenAt || 0) > limit ? { ...it, status: 'dormant' } : it,
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/memory-bank/promote.test.js`
Expected: PASS，12 个用例全绿

- [ ] **Step 5: 跑全量确认无回归**

Run: `npm test`
Expected: 全绿。**不提交**。

---

## Task 3: Markdown 渲染与预算截断（`render.js`）

**Files:**
- Create: `src/features/memory-bank/render.js`
- Test: `src/features/memory-bank/render.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/features/memory-bank/render.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, selectForInjection } from './render.js';

const NOW = Date.parse('2026-08-11T00:00:00.000Z');
const DAY = 86400000;

const item = (over = {}) => ({
  id: 'm1', category: 'code-style', scope: 'global', projectDir: '',
  statement: '注释写中文', status: 'active', inject: true, source: 'inferred',
  evidenceCount: 3, evidenceSessions: ['s1', 's2'], lastSeenAt: NOW,
  ...over,
});

test('只渲染 active 且 inject 的条目', () => {
  const items = [
    item({ id: 'a', statement: '生效的' }),
    item({ id: 'b', statement: '候选的', status: 'candidate' }),
    item({ id: 'c', statement: '休眠的', status: 'dormant' }),
    item({ id: 'd', statement: '冲突的', status: 'conflict' }),
    item({ id: 'e', statement: '仅记录的', category: 'dialogue', inject: false }),
  ];
  const { text, included } = renderMarkdown(items, { scope: 'global', now: NOW });
  assert.equal(included.length, 1);
  assert.match(text, /生效的/);
  assert.doesNotMatch(text, /候选的|休眠的|冲突的|仅记录的/);
});

test('按 category 分节，用中文小节名', () => {
  const items = [
    item({ id: 'a', category: 'code-style', statement: '注释写中文' }),
    item({ id: 'b', category: 'collaboration', statement: '大改前先问我' }),
  ];
  const { text } = renderMarkdown(items, { scope: 'global', now: NOW });
  assert.match(text, /## 代码风格\n- 注释写中文/);
  assert.match(text, /## 协作习惯\n- 大改前先问我/);
});

test('未知 category 的条目不会被静默丢弃 —— 必须计入 truncated', () => {
  const items = [item({ id: 'x', category: 'other', statement: '未知分类的规则' })];
  const { text, included, truncated } = renderMarkdown(items, { scope: 'global', now: NOW });
  assert.equal(included.length, 0, '未知 category 不该进入 included');
  assert.equal(truncated, 1, '被挡掉的条目必须诚实计入 truncated，否则面板会显示「0 条未注入」但规则实际哪儿都不在');
  assert.equal(text, '', '没有任何已知分类的条目时，text 应为空串，而不是只含头部注释的“假非空”');
});

test('顶部带「勿手工编辑」声明，避免用户改了被覆盖', () => {
  const { text } = renderMarkdown([item()], { scope: 'global', now: NOW });
  assert.match(text, /自动生成/);
});

test('scope 过滤：project 渲染只取该 projectDir 的条目', () => {
  const items = [
    item({ id: 'a', scope: 'global', statement: '全局的' }),
    item({ id: 'b', scope: 'project', projectDir: 'C:/x', statement: 'X 工程的' }),
    item({ id: 'c', scope: 'project', projectDir: 'C:/y', statement: 'Y 工程的' }),
  ];
  const g = renderMarkdown(items, { scope: 'global', now: NOW });
  assert.deepEqual(g.included.map((i) => i.id), ['a']);
  const p = renderMarkdown(items, { scope: 'project', projectDir: 'C:/x', now: NOW });
  assert.deepEqual(p.included.map((i) => i.id), ['b']);
});

test('超条数预算 —— explicit 优先保留，并如实报告截断数', () => {
  const items = [
    item({ id: 'a', source: 'inferred', statement: '推断的', evidenceCount: 9 }),
    item({ id: 'b', source: 'explicit', statement: '我明说的', evidenceCount: 1 }),
  ];
  const { included, truncated } = renderMarkdown(items, { scope: 'global', now: NOW, maxItems: 1 });
  assert.deepEqual(included.map((i) => i.id), ['b'], 'explicit 必须压过高证据数的 inferred');
  assert.equal(truncated, 1);
});

test('同为 inferred 时，证据多且新的排前面', () => {
  const items = [
    item({ id: 'old', evidenceCount: 3, lastSeenAt: NOW - 60 * DAY }),
    item({ id: 'new', evidenceCount: 3, lastSeenAt: NOW }),
  ];
  const { included } = selectForInjection(items, { scope: 'global', now: NOW, maxItems: 2, maxChars: 9999 });
  assert.equal(included[0].id, 'new');
});

test('同为 inferred 且 lastSeenAt 相同时，证据多的排前面（单独验证 evidenceCount 因子，不与 recency 混着测）', () => {
  const items = [
    item({ id: 'few', evidenceCount: 1, lastSeenAt: NOW }),
    item({ id: 'many', evidenceCount: 5, lastSeenAt: NOW }),
  ];
  const { included } = selectForInjection(items, { scope: 'global', now: NOW, maxItems: 2, maxChars: 9999 });
  assert.equal(included[0].id, 'many', 'lastSeenAt 相同时，evidenceCount 更大的必须排前面');
});

test('statement 为 null 时不抛异常（手工编辑或迁移来的 memory-bank.json 可能有脏字段）', () => {
  const items = [item({ id: 'x', statement: null })];
  assert.doesNotThrow(() => selectForInjection(items, { scope: 'global', now: NOW }));
});

test('selectForInjection 不得修改传入的 items 数组 —— 纯函数契约，防止「优化」把 filter 去掉或改成 items.sort() 后原地重排调用方数组', () => {
  const items = [
    item({ id: 'a', evidenceCount: 1, lastSeenAt: NOW - 60 * DAY }),
    item({ id: 'b', evidenceCount: 9, lastSeenAt: NOW }),
  ];
  const originalOrder = items.map((it) => it.id);
  selectForInjection(items, { scope: 'global', now: NOW });
  assert.deepEqual(items.map((it) => it.id), originalOrder, '调用后入参数组的顺序不该被就地打乱');
});

test('超字符预算按行截断，truncated 计入', () => {
  const items = [
    item({ id: 'a', source: 'explicit', statement: 'A'.repeat(100) }),
    item({ id: 'b', source: 'inferred', statement: 'B'.repeat(100) }),
  ];
  const { text, included, truncated } = renderMarkdown(items, {
    scope: 'global', now: NOW, maxItems: 40, maxChars: 160,
  });
  assert.equal(included.length, 1);
  assert.equal(truncated, 1);
  assert.doesNotMatch(text, /B{100}/, '被截断的条目不能出现在正文里 —— 只断言长度上界会近乎恒真，验证不到任何截断行为');
});

test('无可渲染条目时返回空串 —— 调用方必须把 memory-bank.md 写成空文件，而不是跳过写盘（跳过会让旧内容继续被 CLAUDE.md 引用，用户否掉的规则将永久生效）', () => {
  const { text, included } = renderMarkdown([], { scope: 'global', now: NOW });
  assert.equal(text, '');
  assert.deepEqual(included, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/memory-bank/render.test.js`
Expected: FAIL — `Cannot find module './render.js'`

- [ ] **Step 3: 实现**

创建 `src/features/memory-bank/render.js`：

```js
/**
 * 条目 → Markdown。纯函数。
 * 预算截断是刚性要求：注入内容每次对话都要烧 token，攒半年会失控。
 * 被截断的条目数必须如实返回，由面板显式提示 —— 静默丢弃会让用户以为规则生效了，
 * 实际没有，这是最难排查的一类问题。
 */

export const CATEGORY_LABEL = {
  'code-style': '代码风格',
  collaboration: '协作习惯',
  writing: '写作习惯',
  dialogue: '对话风格',
  'tech-pref': '技术偏好',
};

/** 分节顺序：与 CATEGORY_LABEL 无关，显式固定，保证渲染结果稳定可 diff */
const SECTION_ORDER = ['code-style', 'collaboration', 'writing', 'dialogue', 'tech-pref'];

/** 已知分类集合：renderMarkdown 按 SECTION_ORDER 分节，不在此集合里的 category 无处落地，
 * 必须在 selectForInjection 就挡掉，否则会在渲染阶段被无声丢弃且不计入 truncated */
const KNOWN_CATEGORIES = new Set(Object.keys(CATEGORY_LABEL));

const HEADER = '<!-- 由记忆库自动生成，勿手工编辑；改动请在执行台「记忆库」面板操作 -->';

const DAY_MS = 86400000;

/**
 * 排序权重：运行时计算、不落盘（少一个要维护一致性的持久化字段）。
 * 证据越多越重；最后一次出现越近越重（半衰期 60 天）。
 */
export function weight(item, now) {
  const ageDays = Math.max(0, (now - (item.lastSeenAt || 0)) / DAY_MS);
  const recency = 1 / (1 + ageDays / 60);
  return (item.evidenceCount || 0) * recency;
}

/** 按 scope 过滤 + 排序 + 预算截断，返回入选条目 */
export function selectForInjection(items, { scope, projectDir = '', now, maxItems = 40, maxChars = 3000 }) {
  // 未知 category 的条目在渲染阶段无处落地（renderMarkdown 按 SECTION_ORDER 分节），
  // 必须在这里就诚实地计入 truncated，否则会被无声丢弃：面板报 0 条未注入，规则却哪儿都不在。
  // 只统计「本该有资格注入、但因 category 未知被挡掉」的条目，dormant/inject=false 等本就不合格的不算。
  let categoryRejected = 0;
  const pool = (items || []).filter((it) => {
    if (it.status !== 'active' || !it.inject) return false;
    if (scope === 'project') {
      if (!(it.scope === 'project' && it.projectDir === projectDir)) return false;
    } else if (it.scope !== 'global') {
      return false;
    }
    if (!KNOWN_CATEGORIES.has(it.category)) {
      categoryRejected += 1;
      return false;
    }
    return true;
  });

  // explicit 永远压过 inferred：用户明说的规矩不该被推断出来的挤掉
  pool.sort((a, b) => {
    const ea = a.source === 'explicit' ? 0 : 1;
    const eb = b.source === 'explicit' ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return weight(b, now) - weight(a, now);
  });

  const included = [];
  let chars = 0;
  for (const it of pool) {
    if (included.length >= maxItems) break;
    const cost = String(it.statement || '').length + 3; // '- ' + 换行；与 weight() 的 || 0 兜底姿态保持一致
    if (chars + cost > maxChars) break;
    included.push(it);
    chars += cost;
  }
  return { included, truncated: pool.length - included.length + categoryRejected };
}

/**
 * @returns {{text:string, included:Array, truncated:number}} text 为空串表示该 scope 已无可注入条目 ——
 *   调用方必须把对应的 memory-bank.md 写成空文件，而不是跳过写盘。
 *   跳过会让磁盘上的旧内容继续被 CLAUDE.md 引用，用户否掉的规则将永久生效。
 */
export function renderMarkdown(items, opts) {
  const { included, truncated } = selectForInjection(items, opts);
  if (included.length === 0) return { text: '', included: [], truncated };

  const lines = [HEADER, ''];
  for (const cat of SECTION_ORDER) {
    const group = included.filter((it) => it.category === cat);
    if (group.length === 0) continue;
    lines.push(`## ${CATEGORY_LABEL[cat] || cat}`);
    for (const it of group) lines.push(`- ${it.statement}`);
    lines.push('');
  }
  return { text: lines.join('\n').trimEnd() + '\n', included, truncated };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/memory-bank/render.test.js`
Expected: PASS，12 个用例全绿

- [ ] **Step 5: 跑全量确认无回归**

Run: `npm test`
Expected: 全绿。**不提交**。

---

## Task 4: 调度窗口判定（`schedule.js`）

用本来就要作废的额度干活。**共同前置条件里「无活跃 run」是硬约束** —— 记忆库绝不能跟用户抢额度，否则用户会亲手把功能关掉。

**Files:**
- Create: `src/features/memory-bank/schedule.js`
- Test: `src/features/memory-bank/schedule.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/features/memory-bank/schedule.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRun, parseHm } from './schedule.js';

// 用本地时间构造，避免时区差异导致用例在别的机器上飘
const at = (h, m = 0) => new Date(2026, 7, 11, h, m, 0, 0).getTime();
const SEC = 1000;

const settings = (over = {}) => ({
  enabled: true, nightStart: '03:00', nightEnd: '08:00', minIntervalHours: 6, ...over,
});
const healthy = (windowResetsAt) => [
  { id: 't1', providerId: 'claude-agent', status: 'healthy', windowResetsAt },
];

test('parseHm 解析为当天分钟数', () => {
  assert.equal(parseHm('03:00'), 180);
  assert.equal(parseHm('08:30'), 510);
  assert.equal(parseHm('bad'), null);
});

test('功能未开启 → 不跑', () => {
  const r = shouldRun({ now: at(4), settings: settings({ enabled: false }), tokens: healthy(0), activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false);
  assert.equal(r.reason, 'disabled');
});

test('有活跃 run → 绝不跑（不跟用户抢额度）', () => {
  const r = shouldRun({ now: at(4), settings: settings(), tokens: healthy(0), activeRunCount: 1, lastExtractAt: 0 });
  assert.equal(r.run, false);
  assert.equal(r.reason, 'busy');
});

test('距上次提炼不足最小间隔 → 冷却中', () => {
  const now = at(4);
  const r = shouldRun({ now, settings: settings(), tokens: healthy(0), activeRunCount: 0, lastExtractAt: now - 3600000 });
  assert.equal(r.run, false);
  assert.equal(r.reason, 'cooldown');
});

test('token 池全耗尽 → 不跑', () => {
  const tokens = [{ id: 't1', providerId: 'claude-agent', status: 'exhausted', resetsAt: 999 }];
  const r = shouldRun({ now: at(4), settings: settings(), tokens, activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false);
  assert.equal(r.reason, 'exhausted');
});

test('窗口①：额度正常且距重置 <30 分钟 → 跑', () => {
  const now = at(14);
  const resetsAt = Math.floor((now + 20 * 60 * SEC) / 1000);
  const r = shouldRun({ now, settings: settings(), tokens: healthy(resetsAt), activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, true);
  assert.equal(r.window, 'window-end');
});

test('窗口①：距重置还有 2 小时且不在凌晨 → 不跑', () => {
  const now = at(14);
  const resetsAt = Math.floor((now + 120 * 60 * SEC) / 1000);
  const r = shouldRun({ now, settings: settings(), tokens: healthy(resetsAt), activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false);
  assert.equal(r.reason, 'out-of-window');
});

test('窗口①：重置时刻已过（负数）不得误判为命中', () => {
  const now = at(14);
  const resetsAt = Math.floor((now - 10 * 60 * SEC) / 1000);
  const r = shouldRun({ now, settings: settings(), tokens: healthy(resetsAt), activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false);
});

test('窗口②：凌晨窗口内即可跑，不依赖 windowResetsAt（降级路径）', () => {
  const r = shouldRun({ now: at(4), settings: settings(), tokens: healthy(null), activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, true);
  assert.equal(r.window, 'night');
});

test('窗口②：08:00 为开区间上界，08:30 不再跑', () => {
  const r = shouldRun({ now: at(8, 30), settings: settings(), tokens: healthy(null), activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false);
});

test('凌晨窗口可跨零点配置（22:00-02:00）', () => {
  const s = settings({ nightStart: '22:00', nightEnd: '02:00' });
  assert.equal(shouldRun({ now: at(23), settings: s, tokens: healthy(null), activeRunCount: 0, lastExtractAt: 0 }).run, true);
  assert.equal(shouldRun({ now: at(1), settings: s, tokens: healthy(null), activeRunCount: 0, lastExtractAt: 0 }).run, true);
  assert.equal(shouldRun({ now: at(12), settings: s, tokens: healthy(null), activeRunCount: 0, lastExtractAt: 0 }).run, false);
});

// —— I1：跨 provider 混放的 token 池必须先按 providerId 过滤，不能拿别的号的窗口时刻做判断 ——
test('跨 provider：非目标 provider 的号处于窗口末尾，不得用它的重置时刻误判 claude-agent 该跑（I1）', () => {
  const now = at(14);
  const otherResetsAt = Math.floor((now + 20 * 60 * SEC) / 1000); // openai-compat 20 分钟后重置——落在窗口①
  const claudeResetsAt = Math.floor((now + 5 * 3600 * SEC) / 1000); // claude-agent 自己 5 小时后重置——不该跑
  const tokens = [
    { id: 'o1', providerId: 'openai-compat', status: 'healthy', windowResetsAt: otherResetsAt },
    { id: 'c1', providerId: 'claude-agent', status: 'healthy', windowResetsAt: claudeResetsAt },
  ];
  const r = shouldRun({ now, settings: settings(), tokens, activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false, '不该被 openai-compat 的窗口末尾误判为该跑——提炼实际用的是 claude-agent 的号');
  assert.equal(r.reason, 'out-of-window');
});

// —— I2：warning 是 pickActive 语义里的「可用」状态，退而取之而非视为不可用 ——
test('目标 provider 的号处于 warning 且临近重置 → 仍应跑（I2：warning 是可用状态，与 pickActive 对齐）', () => {
  const now = at(14);
  const resetsAt = Math.floor((now + 10 * 60 * SEC) / 1000); // 10 分钟后重置，落在窗口①
  const tokens = [{ id: 'c1', providerId: 'claude-agent', status: 'warning', windowResetsAt: resetsAt }];
  const r = shouldRun({ now, settings: settings(), tokens, activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, true, 'warning 即将作废的额度正是窗口①设计意图里最该跑的时刻，不该被当成不可用');
  assert.equal(r.window, 'window-end');
});

// —— I3：耗尽判定必须分 provider，否则会放行到 claudeAuthOpts() 而无人值守地烧用户主账号额度 ——
test('目标 provider 已耗尽、但其它 provider 健康 → 不得跑（I3：耗尽判定要分 provider）', () => {
  const tokens = [
    { id: 'o1', providerId: 'openai-compat', status: 'healthy' },
    { id: 'c1', providerId: 'claude-agent', status: 'exhausted', resetsAt: 999 },
  ];
  const r = shouldRun({ now: at(4), settings: settings(), tokens, activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false, 'claude-agent 侧全 exhausted 时不能被 openai-compat 的健康状态掩盖');
  assert.equal(r.reason, 'exhausted');
});

// —— M6：lastExtractAt 落在未来（时钟回拨/落盘坏值）不该让冷却判定恒为真、功能静默死掉 ——
test('lastExtractAt 为未来时刻不应导致永久冷却（M6：minIntervalHours=0 时负数恒小于 0 会永远判定冷却）', () => {
  const now = at(4);
  const future = now + 3600000; // 比 now 还晚 1 小时——系统时钟回拨或落盘坏值的典型形态
  const s = settings({ minIntervalHours: 0 }); // 未设最小间隔：理应随时可跑，不该被负数 elapsed 卡死
  const r = shouldRun({ now, settings: s, tokens: healthy(null), activeRunCount: 0, lastExtractAt: future });
  assert.equal(r.run, true, 'now - lastExtractAt 为负数时不该被当成"刚提炼过"而永久卡在 cooldown');
  assert.equal(r.window, 'night');
});

// —— M3：纯函数不得修改入参，防止未来"优化"引入原地排序/回写之类的副作用（同 promote.test.js 末尾用例）——
test('shouldRun 不得修改传入的 tokens / settings（M3：纯函数调用方有权假设旧引用不被污染）', () => {
  const tokens = [
    { id: 'c1', providerId: 'claude-agent', status: 'warning', windowResetsAt: 100 },
    { id: 'c2', providerId: 'claude-agent', status: 'healthy', windowResetsAt: 200 },
  ];
  const tokensSnapshot = JSON.parse(JSON.stringify(tokens));
  const s = settings();
  const settingsSnapshot = JSON.parse(JSON.stringify(s));

  shouldRun({ now: at(14), settings: s, tokens, activeRunCount: 0, lastExtractAt: 0 });

  assert.deepEqual(tokens, tokensSnapshot, '调用后 tokens 内容不该被改动（例如排序、状态回写）');
  assert.deepEqual(s, settingsSnapshot, '调用后 settings 内容不该被改动');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/memory-bank/schedule.test.js`
Expected: FAIL — `Cannot find module './schedule.js'`

- [ ] **Step 3: 实现**

创建 `src/features/memory-bank/schedule.js`：

```js
/**
 * 记忆库调度判定。纯函数：now / settings / tokens / activeRunCount 全部注入。
 *
 * 双窗口设计：
 *   ①窗口末尾 —— 距当前计费窗口重置 <30 分钟且额度正常，用本来要作废的额度，边际成本最低；
 *   ②凌晨窗口 —— 保底路径。若某天拿不到 windowResetsAt（SDK 未推限流事件），①自动失效，②仍可跑。
 *
 * token 语义与 src/features/token-rotation.js 对齐（就地复刻谓词，不 import 该文件——
 * 它在模块级 import 了 store/settings.js，会把 IO 依赖带进来，破坏本文件的纯函数可测性）：
 *   - warning（对应 SDK 的 allowed_warning）是「可用」状态而非耗尽，选号要退而取之（对齐 pickActive）；
 *   - 选号 / 耗尽判定都必须先按 providerId 过滤——getTokens() 返回的是跨 provider 混放的全量池，
 *     不过滤会拿到别的 provider（如 openai-compat）的号的窗口时刻/耗尽状态，来判断 claude-agent 该不该跑。
 */

import { DEFAULT_PROVIDER_ID } from '../../shared/provider-ids.js';

export const WINDOW_END_LEAD_MS = 30 * 60 * 1000;

/** 'HH:MM' → 当天分钟数；非法返回 null */
export function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 当前分钟数是否落在 [start, end) —— 支持跨零点（22:00-02:00）。
 *  注意（M8）：start === end 时区间长度为 0，恒为 false —— 把起止配成同一个值不是「全天」，
 *  是「永不」。若想要「全天」应配 00:00-23:59（parseHm 不接受 24:00），这里不做隐式改写。 */
function inWindow(minutes, start, end) {
  if (start === null || end === null) return false;
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** 就地复刻 token-rotation.js 的 pickActive：先按 providerId 过滤，再 healthy 优先、退而取 warning。
 *  缺 providerId 字段的旧 token 视为 DEFAULT_PROVIDER_ID，与 token-rotation.js 保持一致。 */
function pickActiveToken(tokens, providerId) {
  const list = (tokens || []).filter((t) => (t.providerId || DEFAULT_PROVIDER_ID) === providerId);
  return list.find((t) => t.status === 'healthy') || list.find((t) => t.status === 'warning') || null;
}

/** 就地复刻 token-rotation.js 的 isPoolExhausted，但先按 providerId 过滤：
 *  该 provider 下没有任何 healthy/warning 号才算耗尽；该 provider 无任何 token（空列表）不算耗尽——
 *  未配置该 provider 的备用池时不应 fail-fast 挡掉调度（对齐 isPoolExhausted 对空池的处理）。 */
function isProviderExhausted(tokens, providerId) {
  const list = (tokens || []).filter((t) => (t.providerId || DEFAULT_PROVIDER_ID) === providerId);
  if (list.length === 0) return false;
  return !list.some((t) => t.status === 'healthy' || t.status === 'warning');
}

/**
 * @param {{now:number, settings:object, tokens:Array, activeRunCount:number, lastExtractAt:number, providerId?:string}} ctx
 *   providerId 默认 DEFAULT_PROVIDER_ID（'claude-agent'）——提炼实际走 claudeAuthOpts() → pickActive(tokens,'claude-agent')，
 *   调度判断必须锁定同一个 provider，否则会拿混在同一个 token 池里的其它 provider（如 openai-compat）的号做判断（I1/I3）。
 * @returns {{run:boolean, reason:string, window:('window-end'|'night'|null)}}
 */
export function shouldRun({ now, settings, tokens, activeRunCount, lastExtractAt, providerId = DEFAULT_PROVIDER_ID }) {
  const s = settings || {};
  if (!s.enabled) return { run: false, reason: 'disabled', window: null };
  // 硬约束：绝不与用户的任务抢额度
  if (activeRunCount > 0) return { run: false, reason: 'busy', window: null };

  const minInterval = Math.max(0, Number(s.minIntervalHours) || 0) * 3600000;
  // M6：lastExtractAt 若为未来时刻（系统时钟回拨、或落盘坏值），now - lastExtractAt 为负；
  // 不clamp的话，在 minIntervalHours=0（不设冷却）时负数仍恒小于 0，会被永久判定为冷却中，功能静默死掉。
  const elapsed = Math.max(0, now - (lastExtractAt || 0));
  if (elapsed < minInterval) return { run: false, reason: 'cooldown', window: null };

  // I3：耗尽判定必须按 providerId 过滤，否则会被别的 provider 的健康号掩盖 claude-agent 侧的全耗尽——
  // 一旦误放行到 claudeAuthOpts()，该 provider 无可用号会返回 {}，退回主账号登录，无人值守地烧用户额度。
  if (isProviderExhausted(tokens, providerId)) {
    return { run: false, reason: 'exhausted', window: null };
  }

  // 窗口① —— 距重置 <30 分钟且仍在可用额度内。
  // I1：选号先按 providerId 过滤，不能拿其它 provider 的窗口重置时刻来判断这个 provider 该不该跑；
  // I2：healthy 优先、退而取 warning（与 pickActive 对齐）——warning 反而是最该抓紧窗口①的时刻。
  const active = pickActiveToken(tokens, providerId);
  const resetsAt = active && typeof active.windowResetsAt === 'number' ? active.windowResetsAt : null;
  if (resetsAt) {
    const left = resetsAt * 1000 - now;
    if (left > 0 && left < WINDOW_END_LEAD_MS) return { run: true, reason: 'window-end', window: 'window-end' };
  }

  // 窗口② —— 凌晨保底。
  // M7：getHours() 取的是进程本地时区。服务若跑在 UTC 容器而人在 +08 时区，nightStart/nightEnd
  // 按本地时间配的「凌晨」会与进程时区错位，长期不触发但报不出错，排查成本很高——部署时需确认进程时区。
  const d = new Date(now);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (inWindow(minutes, parseHm(s.nightStart), parseHm(s.nightEnd))) {
    return { run: true, reason: 'night', window: 'night' };
  }

  return { run: false, reason: 'out-of-window', window: null };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/memory-bank/schedule.test.js`
Expected: PASS，16 个用例全绿

- [ ] **Step 5: 跑全量确认无回归**

Run: `npm test`
Expected: 全绿。**不提交**。

---

## Task 5: 条目库持久化（`store/memory-bank.js`）

**Files:**
- Create: `src/store/memory-bank.js`
- Test: `src/store/memory-bank.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/store/memory-bank.test.js`（**`APP_DATA_DIR` 必须在 import store 之前设置，故用动态 import**）：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'membank-'));
const {
  readBank, writeBank, patchItem, rejectItem, ackItems, EMPTY_BANK,
} = await import('./memory-bank.js');

test('文件不存在时返回空库骨架', () => {
  assert.deepEqual(readBank(), EMPTY_BANK());
});

test('写入后可回读', () => {
  const bank = EMPTY_BANK();
  bank.items.push({ id: 'm1', statement: 'x', status: 'candidate', fingerprint: 'f1', acked: true });
  writeBank(bank);
  assert.equal(readBank().items.length, 1);
});

test('patchItem 局部更新，不动其它字段', () => {
  patchItem('m1', { status: 'active', statement: 'y' });
  const it = readBank().items.find((i) => i.id === 'm1');
  assert.equal(it.status, 'active');
  assert.equal(it.statement, 'y');
  assert.equal(it.fingerprint, 'f1');
});

test('patchItem 找不到 id 时不写盘也不抛错', () => {
  const before = JSON.stringify(readBank());
  patchItem('nope', { status: 'active' });
  assert.equal(JSON.stringify(readBank()), before);
});

test('rejectItem：移出 items 且 fingerprint 入黑名单', () => {
  rejectItem('m1', 1234);
  const bank = readBank();
  assert.equal(bank.items.length, 0);
  assert.equal(bank.blacklist.length, 1);
  assert.equal(bank.blacklist[0].fingerprint, 'f1');
  assert.equal(bank.blacklist[0].rejectedAt, 1234);
});

test('rejectItem 同一 fingerprint 重复否掉不产生重复黑名单项', () => {
  const bank = readBank();
  bank.items.push({ id: 'm2', statement: 'z', status: 'candidate', fingerprint: 'f1', acked: true });
  writeBank(bank);
  rejectItem('m2', 5678);
  assert.equal(readBank().blacklist.length, 1);
});

test('ackItems：清红点', () => {
  const bank = readBank();
  bank.items.push({ id: 'm3', fingerprint: 'f3', status: 'active', acked: false, statement: 'a' });
  bank.items.push({ id: 'm4', fingerprint: 'f4', status: 'active', acked: false, statement: 'b' });
  writeBank(bank);
  ackItems(['m3']);
  const after = readBank().items;
  assert.equal(after.find((i) => i.id === 'm3').acked, true);
  assert.equal(after.find((i) => i.id === 'm4').acked, false);
  ackItems(null); // null = 全部已读
  assert.ok(readBank().items.every((i) => i.acked));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/memory-bank.test.js`
Expected: FAIL — `Cannot find module './memory-bank.js'`

- [ ] **Step 3: 实现**

创建 `src/store/memory-bank.js`：

```js
/**
 * 记忆库持久化 —— memory-bank.json 是偏好条目的唯一真相源。
 * Markdown 与导出包都是它的渲染产物，不反向写回。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'memory-bank.json';

export const EMPTY_BANK = () => ({ version: 1, lastScannedAt: 0, lastExtractAt: 0, items: [], blacklist: [] });

export function readBank() {
  const raw = readJson(FILE, EMPTY_BANK());
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    lastScannedAt: Number(b.lastScannedAt) || 0,
    lastExtractAt: Number(b.lastExtractAt) || 0,
    items: Array.isArray(b.items) ? b.items : [],
    blacklist: Array.isArray(b.blacklist) ? b.blacklist : [],
  };
}

export function writeBank(bank) {
  return updateJson(FILE, EMPTY_BANK(), () => bank);
}

/** 局部更新一条；找不到则不写盘（updateJson 的 fn 返回 undefined = 放弃） */
export function patchItem(id, patch) {
  return updateJson(FILE, EMPTY_BANK(), (cur) => {
    const items = Array.isArray(cur?.items) ? cur.items : [];
    const i = items.findIndex((it) => it.id === id);
    if (i < 0) return undefined;
    items[i] = { ...items[i], ...patch };
    return { ...cur, items };
  });
}

/** 否掉：移出 items，fingerprint 入黑名单（去重），此后同 fingerprint 的候选一律丢弃 */
export function rejectItem(id, now) {
  return updateJson(FILE, EMPTY_BANK(), (cur) => {
    const items = Array.isArray(cur?.items) ? cur.items : [];
    const blacklist = Array.isArray(cur?.blacklist) ? cur.blacklist : [];
    const i = items.findIndex((it) => it.id === id);
    if (i < 0) return undefined;
    const [gone] = items.splice(i, 1);
    if (gone.fingerprint && !blacklist.some((b) => b.fingerprint === gone.fingerprint)) {
      blacklist.push({ fingerprint: gone.fingerprint, statement: gone.statement || '', rejectedAt: now });
    }
    return { ...cur, items, blacklist };
  });
}

/** 清红点。ids 为 null / 空 → 全部标记已读 */
export function ackItems(ids) {
  const set = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  return updateJson(FILE, EMPTY_BANK(), (cur) => {
    const items = Array.isArray(cur?.items) ? cur.items : [];
    let changed = false;
    const next = items.map((it) => {
      if (it.acked || (set && !set.has(it.id))) return it;
      changed = true;
      return { ...it, acked: true };
    });
    if (!changed) return undefined;
    return { ...cur, items: next };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/memory-bank.test.js`
Expected: PASS，7 个用例全绿

- [ ] **Step 5: 跑全量确认无回归**

Run: `npm test`
Expected: 全绿。**不提交**。

---

## Task 6: CLAUDE.md 引用挂接（`shared/claude-md.js`）

**本任务是全功能风险最高处** —— 写坏 `CLAUDE.md` 会污染用户此后所有会话。用户全局 `CLAUDE.md` 现有手写内容（如「Always respond in Chinese-simplified」）必须逐字保留。

与「优化汇总 / pitfalls」共用（spec §3），故做成通用的 `ensureImport(claudeMdPath, importLine)`。

**Files:**
- Create: `src/shared/claude-md.js`
- Test: `src/shared/claude-md.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/shared/claude-md.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureImport, hasImport } from './claude-md.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-'));

test('无 CLAUDE.md → 创建，仅含引用行', () => {
  const dir = tmp();
  const p = path.join(dir, 'CLAUDE.md');
  const r = ensureImport(p, '@.claude/memory-bank.md');
  assert.equal(r.created, true);
  assert.equal(r.appended, true);
  assert.equal(fs.readFileSync(p, 'utf8').trim(), '@.claude/memory-bank.md');
});

test('已有手写内容 → 逐字保留，仅追加一行', () => {
  const dir = tmp();
  const p = path.join(dir, 'CLAUDE.md');
  const original = '# 我的规矩\n\nAlways respond in Chinese-simplified\n';
  fs.writeFileSync(p, original, 'utf8');
  ensureImport(p, '@.claude/memory-bank.md');
  const after = fs.readFileSync(p, 'utf8');
  assert.ok(after.startsWith(original), '原内容必须逐字保留在开头');
  assert.match(after, /@\.claude\/memory-bank\.md/);
});

test('幂等：已含引用行则不重复追加', () => {
  const dir = tmp();
  const p = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(p, 'x\n@.claude/memory-bank.md\n', 'utf8');
  const r = ensureImport(p, '@.claude/memory-bank.md');
  assert.equal(r.appended, false);
  const body = fs.readFileSync(p, 'utf8');
  assert.equal(body.match(/@\.claude\/memory-bank\.md/g).length, 1);
});

test('引用行出现在注释或正文中间也算已存在，不重复追加', () => {
  const dir = tmp();
  const p = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(p, '见 @.claude/memory-bank.md 里的偏好\n', 'utf8');
  assert.equal(hasImport(p, '@.claude/memory-bank.md'), true);
  assert.equal(ensureImport(p, '@.claude/memory-bank.md').appended, false);
});

test('原文件末尾无换行时，追加不会粘连成一行', () => {
  const dir = tmp();
  const p = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(p, '最后一行没换行', 'utf8');
  ensureImport(p, '@.claude/memory-bank.md');
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  assert.equal(lines[0], '最后一行没换行');
  assert.ok(lines.includes('@.claude/memory-bank.md'));
});

test('目标目录不存在 → 自动创建', () => {
  const dir = tmp();
  const p = path.join(dir, 'nested', 'deep', 'CLAUDE.md');
  ensureImport(p, '@.claude/memory-bank.md');
  assert.ok(fs.existsSync(p));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/shared/claude-md.test.js`
Expected: FAIL — `Cannot find module './claude-md.js'`

- [ ] **Step 3: 实现**

创建 `src/shared/claude-md.js`：

```js
/**
 * CLAUDE.md 的 @ 引用行幂等挂接。记忆库与「优化汇总/pitfalls」共用（spec §3）。
 *
 * 铁律：只追加引用行，绝不改写、重排、删除任何既有内容。
 * CLAUDE.md 里是用户手写的规矩，写坏它会污染此后所有会话 —— 比功能失效严重得多。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 引用行是否已存在（子串匹配：写在注释或句中也算，避免重复追加） */
export function hasImport(claudeMdPath, importLine) {
  try {
    return fs.readFileSync(claudeMdPath, 'utf8').includes(importLine);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * @returns {{created:boolean, appended:boolean}}
 */
export function ensureImport(claudeMdPath, importLine) {
  let body = null;
  try {
    body = fs.readFileSync(claudeMdPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  if (body === null) {
    fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
    fs.writeFileSync(claudeMdPath, `${importLine}\n`, 'utf8');
    return { created: true, appended: true };
  }

  if (body.includes(importLine)) return { created: false, appended: false };

  // 原文末尾无换行时先补一个，否则会和引用行粘成一行
  const sep = body.length === 0 || body.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(claudeMdPath, `${sep}${importLine}\n`, 'utf8');
  return { created: false, appended: true };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/shared/claude-md.test.js`
Expected: PASS，6 个用例全绿

- [ ] **Step 5: 加注入前提的防回归测试**

整个功能的注入依赖一个隐含前提：`claude.js` **不设置** `settingSources`，SDK 才会按 CLI 默认加载 `CLAUDE.md`（spec §9.3 / §14-b）。若将来有人加上 `settingSources: []`（SDK 隔离模式），记忆库会**静默失效且无任何报错** —— 必须让测试先红。

在 `src/shared/claude-md.test.js` 末尾追加：

```js
test('防回归：claude.js 不得设置 settingSources —— 否则 CLAUDE.md 不再自动加载，记忆库静默失效', () => {
  const src = fs.readFileSync(new URL('../integrations/claude.js', import.meta.url), 'utf8');
  assert.ok(
    !/settingSources\s*:/.test(src),
    'claude.js 出现了 settingSources 配置。SDK 文档：omitted 时按 CLI 默认加载全部来源，'
    + '必须含 project 才会读 CLAUDE.md。若确需设置，请显式包含 "project"，并同步更新本断言与 spec §9.3。',
  );
});
```

Run: `node --test src/shared/claude-md.test.js`
Expected: PASS（当前 `claude.js` 确实没有该配置）

- [ ] **Step 6: 跑全量确认无回归**

Run: `npm test`
Expected: 全绿。**不提交**。

---

## Task 7: token 计费窗口时刻（`windowResetsAt`）

探针实证：`status:'allowed'` 的限流事件**本来就带 `resetsAt`**（452 条日志），只是 `reduceRateLimit` 的 `allowed` 分支把它清掉了。新增独立字段承接。

语义区分（不要复用 `resetsAt`）：
- `resetsAt` = 被限流后何时解禁（healthy 时无意义，故清空）
- `windowResetsAt` = 当前计费窗口何时结束（任何状态下都有意义，**不随状态清空**）

**Files:**
- Modify: `src/features/token-rotation.js:45-58`
- Test: `src/features/token-rotation.test.js`（追加用例）

- [ ] **Step 1: 追加失败测试**

在 `src/features/token-rotation.test.js` 末尾追加：

```js
test('reduceRateLimit：allowed 状态记录 windowResetsAt，且不清空 resetsAt 之外的窗口信息', () => {
  const tokens = [{ id: 't1', providerId: 'claude-agent', status: 'healthy', resetsAt: null }];
  const r = reduceRateLimit(tokens, 't1', { status: 'allowed', resetsAt: 1785412800 }, 1785400000);
  assert.equal(r.tokens[0].status, 'healthy');
  assert.equal(r.tokens[0].resetsAt, null, 'healthy 时 resetsAt 仍应清空（原语义不变）');
  assert.equal(r.tokens[0].windowResetsAt, 1785412800, '计费窗口时刻必须留下，调度器要用');
});

test('reduceRateLimit：allowed 未带 resetsAt 时，保留上一次的 windowResetsAt 不抹掉', () => {
  const tokens = [{ id: 't1', providerId: 'claude-agent', status: 'healthy', windowResetsAt: 111 }];
  const r = reduceRateLimit(tokens, 't1', { status: 'allowed' }, 1000);
  assert.equal(r.tokens[0].windowResetsAt, 111);
});

test('reduceRateLimit：限流/告警状态同样记录 windowResetsAt', () => {
  const tokens = [{ id: 't1', providerId: 'claude-agent', status: 'healthy' }];
  const warn = reduceRateLimit(tokens, 't1', { status: 'allowed_warning', resetsAt: 222, utilization: 0.9 }, 1000);
  assert.equal(warn.tokens[0].windowResetsAt, 222);
  const rej = reduceRateLimit(tokens, 't1', { status: 'rejected', resetsAt: 333 }, 1000);
  assert.equal(rej.tokens[0].windowResetsAt, 333);
});

test('recoverExpired 恢复 healthy 时不得抹掉 windowResetsAt', () => {
  const tokens = [{ id: 't1', providerId: 'claude-agent', status: 'exhausted', resetsAt: 100, windowResetsAt: 100 }];
  const r = recoverExpired(tokens, 200);
  assert.equal(r.tokens[0].status, 'healthy');
  assert.equal(r.tokens[0].windowResetsAt, 100);
});
```

若该测试文件顶部未导入 `recoverExpired`，把它加进现有 import 列表。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/token-rotation.test.js`
Expected: FAIL — `windowResetsAt` 为 `undefined`

- [ ] **Step 3: 实现**

修改 `src/features/token-rotation.js` 的 `reduceRateLimit`，三个状态分支各加一行，并在 `recoverExpired` 保留字段：

```js
  const t = { ...list[idx] };
  // 当前计费窗口结束时刻：与 resetsAt（被限流后何时解禁）语义不同，任何状态下都有意义，
  // 不随状态清空 —— 记忆库调度器靠它命中「重置前 30 分钟」窗口（spec §10）
  if (typeof info.resetsAt === 'number') t.windowResetsAt = info.resetsAt;
  if (info.status === 'allowed') {
    t.status = 'healthy';
    t.resetsAt = null;
    t.utilization = null;
    t.rateLimitType = null;
  } else if (info.status === 'allowed_warning') {
```

（其余分支不动。）

同文件 `recoverExpired` 中的恢复对象补上该字段：

```js
      return { ...t, status: 'healthy', resetsAt: null, utilization: null, rateLimitType: null,
               windowResetsAt: t.windowResetsAt ?? null };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/token-rotation.test.js`
Expected: PASS，原有用例 + 4 全绿

- [ ] **Step 5: 跑全量确认无回归**

Run: `npm test`
Expected: 全绿。`settings.js` 的 token 归一化用的是展开语法 `{ providerId: DEFAULT_PROVIDER_ID, ...t }`，新字段自动透传，**无需改动**。**不提交**。

---

## Task 8: 设置段（`memoryBank`）

新增配置段必须改 **3 处**：`DEFAULTS` / `normalizeSettings` / `replaceSettings`。**漏 `normalizeSettings` 会被静默清空**（整份读-改-回写范式），漏 `replaceSettings` 会导致配置导入丢数据。

**Files:**
- Modify: `src/store/settings.js`
- Test: `src/store/settings.test.js`（追加用例）

- [ ] **Step 1: 追加失败测试**

在 `src/store/settings.test.js` 末尾追加（按该文件现有 import 风格补 `getMemoryBankSettings, setMemoryBankSettings`）：

```js
test('memoryBank：默认值完整', () => {
  const s = normalizeSettings({});
  assert.deepEqual(s.memoryBank, {
    enabled: false,
    nightStart: '03:00',
    nightEnd: '08:00',
    minIntervalHours: 6,
    model: '',
    maxItems: 40,
    maxChars: 3000,
    dormantDays: 90,
    minEvidence: 3,
    minSessions: 2,
  });
});

test('memoryBank：局部覆盖时其余字段回落默认', () => {
  const s = normalizeSettings({ memoryBank: { enabled: true, nightStart: '02:30' } });
  assert.equal(s.memoryBank.enabled, true);
  assert.equal(s.memoryBank.nightStart, '02:30');
  assert.equal(s.memoryBank.nightEnd, '08:00');
});

test('memoryBank：非对象/数组输入回落全默认，不抛错', () => {
  assert.equal(normalizeSettings({ memoryBank: null }).memoryBank.enabled, false);
  assert.equal(normalizeSettings({ memoryBank: [] }).memoryBank.nightEnd, '08:00');
});

test('memoryBank：默认关闭 —— 功能要用户显式开启后才跑', () => {
  assert.equal(normalizeSettings({}).memoryBank.enabled, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/settings.test.js`
Expected: FAIL — `s.memoryBank` 为 `undefined`

- [ ] **Step 3: 实现**

`src/store/settings.js` 改三处，另加一对 get/set（`updateSettings` 是模块私有，get/set 只能写在本文件内）：

```js
// (1) DEFAULTS 里新增
  memoryBank: {
    enabled: false,        // 默认关闭：提炼要花额度，必须用户显式开启
    nightStart: '03:00',
    nightEnd: '08:00',
    minIntervalHours: 6,
    model: '',             // 空 = 用 config 的分类模型（便宜档）
    maxItems: 40,
    maxChars: 3000,
    dormantDays: 90,
    minEvidence: 3,
    minSessions: 2,
  },

// (2) normalizeSettings 的返回对象里新增（照搬 uiPrefs 的对象合并范式）
    memoryBank: s.memoryBank && typeof s.memoryBank === 'object' && !Array.isArray(s.memoryBank)
      ? { ...DEFAULTS.memoryBank, ...s.memoryBank }
      : { ...DEFAULTS.memoryBank },

// (3) replaceSettings 末尾新增一行
  s.memoryBank = n.memoryBank;
```

文件末尾新增导出：

```js
export function getMemoryBankSettings() {
  return getSettings().memoryBank;
}

export function setMemoryBankSettings(patch) {
  return updateSettings((s) => {
    s.memoryBank = { ...s.memoryBank, ...(patch && typeof patch === 'object' ? patch : {}) };
  }).memoryBank;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/settings.test.js`
Expected: PASS，原有用例 + 4 全绿

- [ ] **Step 5: 核验 `/api/settings` 是否透传新段**

spec §13 约定设置项走既有 `/api/settings`，不另开接口。但该 handler 若是**字段白名单**式回写，新段会被静默吞掉。

Run: `node server.js`，另开终端：
```bash
curl -s http://127.0.0.1:3000/api/settings | head -c 400
```

Expected: 响应里含 `memoryBank` 段。

- 若**含** → 无需改动，跳到 Step 6。
- 若**不含** → 打开 `src/entrypoints/web/routes-settings.js` 找到 GET 的响应构造与 POST 的字段处理，按其现有写法把 `memoryBank` 补进去（与 `uiPrefs` 同样处理）。注意 POST 侧要做局部合并而非整段替换，避免前端只传一个字段时抹掉其余配置。

- [ ] **Step 6: 跑全量确认无回归**

Run: `npm test`
Expected: 全绿。**不提交**。

---

## Task 9: 转录读取（`store/transcript.js`）

按 mtime 游标列出待扫会话、读单个会话的原始事件数组。`history.js` 现有的 `getHistorySession` 返回的是**已折叠成 role/content 的消息**，丢掉了 `tool_result` 标记与块结构 —— 预筛器需要**原始事件**，故另立模块（spec §3 共用基础设施）。

**Files:**
- Create: `src/store/transcript.js`
- Test: `src/store/transcript.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/store/transcript.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readTranscriptEvents, listTranscriptsSince, encodeProjectId } from './transcript.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));

function writeJsonl(name, lines, mtimeMs) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  if (mtimeMs) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

test('encodeProjectId 与 Claude CLI 目录名规则一致', () => {
  assert.equal(encodeProjectId('C:\\Users\\DELL\\Desktop\\claude-p-web-demo'),
    'C--Users-DELL-Desktop-claude-p-web-demo');
});

test('readTranscriptEvents 返回原始事件，保留块结构', () => {
  const p = writeJsonl('a.jsonl', [
    { type: 'user', message: { role: 'user', content: '你好' }, sessionId: 'a' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] }, sessionId: 'a' },
  ]);
  const evs = readTranscriptEvents(p);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].message.content, '你好');
  assert.equal(evs[1].message.content[0].type, 'tool_result', 'tool_result 块必须原样保留');
});

test('readTranscriptEvents 跳过坏行而不是整体失败', () => {
  const p = path.join(tmpDir, 'bad.jsonl');
  fs.writeFileSync(p, '{"type":"user"}\n{坏行\n\n{"type":"assistant"}\n', 'utf8');
  const evs = readTranscriptEvents(p);
  assert.equal(evs.length, 2);
});

test('readTranscriptEvents：文件不存在返回空数组', () => {
  assert.deepEqual(readTranscriptEvents(path.join(tmpDir, 'nope.jsonl')), []);
});

test('listTranscriptsSince 只返回 mtime 更新的会话，按 mtime 升序', () => {
  writeJsonl('old.jsonl', [{ type: 'user' }], 1000000);
  writeJsonl('new1.jsonl', [{ type: 'user' }], 3000000);
  writeJsonl('new2.jsonl', [{ type: 'user' }], 2000000);
  const got = listTranscriptsSince(tmpDir, 1500000).map((f) => path.basename(f.file));
  assert.deepEqual(got, ['new2.jsonl', 'new1.jsonl']);
});

test('listTranscriptsSince：目录不存在返回空数组', () => {
  assert.deepEqual(listTranscriptsSince(path.join(tmpDir, 'nodir'), 0), []);
});

test('listTranscriptsSince 忽略非 .jsonl 文件', () => {
  fs.writeFileSync(path.join(tmpDir, 'note.txt'), 'x', 'utf8');
  const got = listTranscriptsSince(tmpDir, 0).map((f) => path.basename(f.file));
  assert.ok(!got.includes('note.txt'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/transcript.test.js`
Expected: FAIL — `Cannot find module './transcript.js'`

- [ ] **Step 3: 实现**

创建 `src/store/transcript.js`：

```js
/**
 * 会话转录原始事件读取 —— 记忆库与「优化汇总/pitfalls」共用（spec §3）。
 *
 * 与 history.js 的分工：history.js 面向"给人看的历史列表"，返回折叠后的 role/content 消息；
 * 本模块返回**原始事件**，保留 tool_result / tool_use 块结构 —— 预筛器靠它区分
 * 「真用户发言」与「伪装成 user 的工具结果」（spec §14-c）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 把工作目录绝对路径编码为 Claude Code 的 project 目录名（与 CLI 规则一致） */
export function encodeProjectId(cwd) {
  return String(cwd || '').replace(/[:\\/.]/g, '-');
}

/** 某工作目录对应的转录目录 */
export function transcriptDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectId(cwd));
}

/** 单个 jsonl → 事件数组。坏行跳过（转录可能被写入中途截断），文件不存在返回 [] */
export function readTranscriptEvents(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // 坏行跳过：整体失败会让一次写坏的转录永久卡住扫描游标
    }
  }
  return out;
}

/**
 * 列出 mtime 晚于游标的转录，按 mtime 升序（老的先扫，游标推进才单调）。
 * @returns {Array<{file:string, sessionId:string, mtimeMs:number}>}
 */
export function listTranscriptsSince(dir, sinceMs) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs <= sinceMs) continue;
    out.push({ file, sessionId: name.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/transcript.test.js`
Expected: PASS，7 个用例全绿

- [ ] **Step 5: 跑全量确认无回归**

Run: `npm test`
Expected: 全绿。**不提交**。

---

## Task 10: 提炼器（`extract.js`）

复用 `runClassifierOnce` —— 它已封装本场景需要的全部防护：额度耗尽 fail-fast、30s 超时 abort、单轮禁全部工具、首个 JSON 块提取。

**Files:**
- Create: `src/features/memory-bank/extract.js`
- Test: `src/features/memory-bank/extract.test.js`

- [ ] **Step 1: 写失败测试**

只测**纯函数部分**（prompt 构造与产出校验），不测 LLM 质量。创建 `src/features/memory-bank/extract.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, sanitizeCandidates, EXTRACT_SYSTEM_PROMPT, extractFromSegments } from './extract.js';

const seg = (over = {}) => ({
  kind: 'correction', quote: '不对，注释写中文', at: '2026-08-11T00:00:00.000Z',
  sessionId: 's1', context: ['assistant: 我加了英文注释'], ...over,
});

test('buildPrompt 含片段原话、kind 与上下文', () => {
  const p = buildPrompt([seg()], { cwd: 'C:/proj' });
  assert.match(p, /不对，注释写中文/);
  assert.match(p, /correction/);
  assert.match(p, /我加了英文注释/);
  assert.match(p, /C:\/proj/, '要给出工程路径，模型才能判 scope');
});

test('系统提示词写死「宁缺毋滥」与禁空话约束', () => {
  assert.match(EXTRACT_SYSTEM_PROMPT.custom, /空数组/);
  assert.match(EXTRACT_SYSTEM_PROMPT.custom, /逐字/);
});

test('sanitizeCandidates 丢弃缺字段的条目', () => {
  const out = sanitizeCandidates({ items: [
    { category: 'code-style', statement: 'A', fingerprint: 'f1' },
    { category: 'code-style', statement: '', fingerprint: 'f2' },
    { statement: 'C', fingerprint: 'f3' },
    { category: 'code-style', statement: 'D' },
  ] }, { cwd: 'C:/proj', sessionId: 's1' });
  assert.equal(out.length, 1);
  assert.equal(out[0].statement, 'A');
});

test('sanitizeCandidates 拒绝未知 category', () => {
  const out = sanitizeCandidates({ items: [
    { category: 'vibes', statement: 'A', fingerprint: 'f1' },
  ] }, { cwd: 'C:/proj', sessionId: 's1' });
  assert.deepEqual(out, []);
});

test('sanitizeCandidates 回填 sessionId/projectDir，scope 非 project 时清空 projectDir', () => {
  const out = sanitizeCandidates({ items: [
    { category: 'code-style', statement: 'A', fingerprint: 'f1', scope: 'project' },
    { category: 'code-style', statement: 'B', fingerprint: 'f2', scope: 'global', projectDir: 'C:/x' },
  ] }, { cwd: 'C:/proj', sessionId: 's9' });
  assert.equal(out[0].projectDir, 'C:/proj');
  assert.equal(out[0].sessionId, 's9');
  assert.equal(out[1].projectDir, '', 'global 条目不得带 projectDir');
});

test('sanitizeCandidates：非法/空返回值一律得到空数组，不抛错', () => {
  const ctx = { cwd: 'C:/proj', sessionId: 's1' };
  assert.deepEqual(sanitizeCandidates(null, ctx), []);
  assert.deepEqual(sanitizeCandidates({}, ctx), []);
  assert.deepEqual(sanitizeCandidates({ items: 'nope' }, ctx), []);
});

test('sanitizeCandidates 截断超长 statement，防污染注入预算', () => {
  const out = sanitizeCandidates({ items: [
    { category: 'code-style', statement: 'X'.repeat(500), fingerprint: 'f1' },
  ] }, { cwd: 'C:/proj', sessionId: 's1' });
  assert.ok(out[0].statement.length <= 200);
});

// —— extractFromSegments 的返回契约：null（调用失败）与 []（正常无产出）不可混同 ——
// 全部通过 _runner 注入假实现，绝不触达真实 runClassifierOnce / LLM，防止单测烧用户额度。

test('底层调用失败（_runner 返回 null，对应超时/额度耗尽/解析不出）时，extractFromSegments 必须返回 null，而不是 []', async () => {
  const fakeRunner = async () => null;
  const out = await extractFromSegments([seg()], { cwd: 'C:/proj', sessionId: 's1', _runner: fakeRunner });
  assert.equal(out, null, '调用失败必须能与「正常但无产出」区分开，否则调用方无法决定是否推进游标');
});

test('调用成功但模型判定确实提炼不出偏好（_runner 返回 {items:[]}）时，extractFromSegments 返回 []', async () => {
  const fakeRunner = async () => ({ items: [] });
  const out = await extractFromSegments([seg()], { cwd: 'C:/proj', sessionId: 's1', _runner: fakeRunner });
  assert.deepEqual(out, [], '正常无产出属成功路径，必须与调用失败的 null 区分开');
});

test('调用成功且有产出时，extractFromSegments 透传 sanitizeCandidates 的结果', async () => {
  const fakeRunner = async () => ({ items: [
    { category: 'code-style', statement: '注释写中文', fingerprint: 'code-style:注释语言' },
  ] });
  const out = await extractFromSegments([seg()], { cwd: 'C:/proj', sessionId: 's1', _runner: fakeRunner });
  assert.equal(out.length, 1);
  assert.equal(out[0].statement, '注释写中文');
});

test('片段为空数组时直接返回 []，不发起任何调用（_runner 不会被调用）', async () => {
  let called = false;
  const fakeRunner = async () => { called = true; return null; };
  const out = await extractFromSegments([], { cwd: 'C:/proj', sessionId: 's1', _runner: fakeRunner });
  assert.deepEqual(out, []);
  assert.equal(called, false, '无片段时不该发起 LLM 调用');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/memory-bank/extract.test.js`
Expected: FAIL — `Cannot find module './extract.js'`

- [ ] **Step 3: 实现**

创建 `src/features/memory-bank/extract.js`：

```js
/**
 * 片段 → 候选偏好条目。LLM 层。
 * 复用 runClassifierOnce（额度耗尽 fail-fast / 30s 超时 / 单轮禁工具 / 首个 JSON 块提取）。
 */
import { runClassifierOnce } from '../llm-classify.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

export const CATEGORIES = ['code-style', 'collaboration', 'writing', 'dialogue', 'tech-pref'];
const MAX_STATEMENT = 200;

export const EXTRACT_SYSTEM_PROMPT = {
  type: 'custom',
  custom: [
    '你是用户偏好提炼器。输入是若干「用户纠正 AI」的对话片段，输出用户的稳定偏好。',
    '仅输出一个 JSON 对象，不要任何解释文字。格式：',
    '{"items":[{"category":"code-style|collaboration|writing|dialogue|tech-pref",',
    '"scope":"global|project","statement":"...","fingerprint":"...","source":"explicit|inferred",',
    '"quote":"...","contradicts":false}]}',
    '',
    '类别定义：',
    '- code-style 代码怎么写（语言、命名、注释、文件大小、测试写法）',
    '- collaboration 怎么和 AI 配合（先给方案再动手、改动前请示、不许自动提交）',
    '- writing 怎么写字（commit 措辞、文档语言、格式约定）',
    '- dialogue 对话风格（回复长度、语气、是否要 emoji）',
    '- tech-pref 技术选型倾向',
    '',
    '硬约束：',
    '1. statement 必须是可执行的具体规则。禁止「用户喜欢清晰的代码」这类无操作性的空话。',
    '2. 提炼不出确定偏好时返回 {"items":[]}。宁缺毋滥 —— 错误的规则比没有规则伤害更大。',
    '3. quote 必须逐字来自输入片段，不得改写、不得拼接。',
    '4. fingerprint 是该偏好的语义键，形如 "code-style:注释语言"，同一主题必须产出相同 fingerprint。',
    '5. scope：规则只对当前工程成立填 project，跨工程通用填 global。',
    '6. 片段里用户明说「以后/记住/每次」的填 source=explicit，从纠正行为推断的填 inferred。',
    '7. 若该偏好与常见默认做法相反、疑似推翻用户过去的规则，contradicts 填 true。',
  ].join('\n'),
};

export function buildPrompt(segments, { cwd }) {
  const blocks = (segments || []).map((s, i) => [
    `# 片段 ${i + 1}（信号类型：${s.kind}）`,
    `用户原话：${s.quote}`,
    s.context?.length ? `上下文：\n${s.context.join('\n')}` : '',
  ].filter(Boolean).join('\n'));
  return [`当前工程目录：${cwd}`, '', ...blocks].join('\n\n');
}

/** 校验并归一化 LLM 产出。任何非法输入都得到空数组，绝不抛错 */
export function sanitizeCandidates(json, { cwd, sessionId }) {
  const items = json && Array.isArray(json.items) ? json.items : [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const category = String(it.category || '');
    const statement = String(it.statement || '').trim();
    const fingerprint = String(it.fingerprint || '').trim();
    if (!CATEGORIES.includes(category) || !statement || !fingerprint) continue;
    const scope = it.scope === 'project' ? 'project' : 'global';
    out.push({
      category,
      scope,
      projectDir: scope === 'project' ? cwd : '',
      statement: statement.slice(0, MAX_STATEMENT),
      fingerprint,
      source: it.source === 'explicit' ? 'explicit' : 'inferred',
      quote: String(it.quote || '').slice(0, 500),
      contradicts: it.contradicts === true,
      sessionId,
      at: new Date().toISOString(),
      kind: it.source === 'explicit' ? 'explicit' : 'correction',
    });
  }
  return out;
}

/**
 * 跑一次提炼。
 *
 * 返回值契约（调用方 index.js 的 runOnce 据此决定是否推进扫描游标，两者含义截然不同，不可混同）：
 * - `null`   —— 底层调用失败（超时 / 额度耗尽 fail-fast / 解析不出 JSON）。调用方不应推进游标，
 *   否则一次超时会让这个会话被永久跳过、证据静默丢失。
 * - `[]`     —— 调用成功，但模型判定这批片段确实提炼不出确定偏好（EXTRACT_SYSTEM_PROMPT 里
 *   「宁缺毋滥」的正常产出）。属正常完成，调用方可以推进游标。
 * - `[...]`  —— 调用成功且有产出。
 *
 * @param {Array} segments
 * @param {{cwd:string, sessionId:string, model?:string, _runner?:Function}} opts
 *   `_runner` 仅供测试注入替换 `runClassifierOnce`，避免单测发起真实 LLM 调用（会烧用户额度）；
 *   默认使用真实实现，生产路径行为不变。
 * @returns {Promise<Array|null>} 候选条目数组；`null` 表示底层调用失败
 */
export async function extractFromSegments(segments, { cwd, sessionId, model, _runner = runClassifierOnce } = {}) {
  if (!segments?.length) return [];
  const json = await _runner({
    prompt: buildPrompt(segments, { cwd }),
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    model: model || config.intent.classifyModel,
    logTag: 'memory-bank/extract',
  });
  if (!json) {
    logger.warn('memory-bank', '提炼调用无结果（超时/额度/解析失败）', { sessionId });
    return null;
  }
  return sanitizeCandidates(json, { cwd, sessionId });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/memory-bank/extract.test.js`
Expected: PASS，11 个用例全绿

- [ ] **Step 5: 跑全量确认无回归**

Run: `npm test`
Expected: 全绿。**不提交**。

---

## Task 11: 胶水层（`memory-bank/index.js`）

串起：扫描游标 → 预筛 → 提炼 → 合并 → 休眠降级 → 渲染 → 写 Markdown → 挂接 CLAUDE.md。外加 10 分钟 tick。

**Files:**
- Create: `src/features/memory-bank/index.js`
- Modify: `src/entrypoints/web/server.js`（启动时挂 tick）

- [ ] **Step 1: 实现 `runOnce`**

创建 `src/features/memory-bank/index.js`：

```js
/**
 * 记忆库胶水层：调度 tick + 跑一轮提炼 + 渲染落盘。
 * 逻辑全在纯函数模块里（prefilter/promote/render/schedule），这里只做 IO 编排。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../../shared/logger.js';
import { ensureImport } from '../../shared/claude-md.js';
import { readBank, writeBank } from '../../store/memory-bank.js';
import { getMemoryBankSettings } from '../../store/settings.js';
import { listActiveRuns, isPidAlive } from '../../store/active-runs.js';
import { getTokens } from '../token-rotation.js';
import { listTranscriptsSince, readTranscriptEvents, transcriptDir } from '../../store/transcript.js';
import { extractSignals } from './prefilter.js';
import { extractFromSegments } from './extract.js';
import { mergeCandidates, applyDormancy } from './promote.js';
import { renderMarkdown } from './render.js';
import { shouldRun } from './schedule.js';

const TICK_MS = 10 * 60 * 1000;
/** 单轮最多扫的会话数：防首次启用时几百个历史会话一次性烧穿额度 */
const MAX_SESSIONS_PER_RUN = 5;

let _timer = null;
let _running = false;

/**
 * 条目 id 生成器。id 是条目主键（patchItem/rejectItem/ackItems 都按它定位），重复即改错条目，
 * 因此盐里必须带**完整**毫秒时间戳 + 随机段：只取 now % 1000 的话，同一天里两轮提炼有 1/1000
 * 的概率首个 id 撞车（生日问题下几十轮就接近必然），而撞车后用户在面板上「否掉」A 会连带删掉 B。
 */
function makeIdFactory(now) {
  let n = 0;
  const stamp = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
  const salt = `${Math.floor(now).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return () => `mem_${stamp}_${salt}${(++n).toString(36)}`;
}

/** 黑名单按 fingerprint 去重合并（磁盘最新 + 内存快照） */
function mergeBlacklist(a, b) {
  const out = [];
  const seen = new Set();
  for (const e of [...(a || []), ...(b || [])]) {
    const fp = e?.fingerprint;
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    out.push(e);
  }
  return out;
}

/**
 * 渲染并落盘两个 scope 的 Markdown，同时挂接对应 CLAUDE.md。
 *
 * 铁律：渲染结果为空串也必须写盘，不能跳过 —— 用户在面板上否掉最后一条条目后，渲染结果会变空；
 * 若此时跳过写盘，磁盘上的 memory-bank.md 会原封不动，CLAUDE.md 的 @ 引用继续生效，
 * 刚被否掉的规则会在此后每一轮对话里照常静默注入，且用户完全无感知（与 render.js 的 renderMarkdown 契约一致）。
 */
export function writeRenders(items, { now, settings, projectDirs }) {
  const budget = { maxItems: settings.maxItems, maxChars: settings.maxChars, now };
  const results = [];

  // 全局：~/.claude/memory-bank.md，引用行 @memory-bank.md（该目录本身就是配置目录，不再嵌 .claude/）
  // 无论 g.text 是否为空都要写盘（空串也写成空文件），否则旧内容会被 CLAUDE.md 永久引用下去；
  // ensureImport 只在有内容时调用 —— 没有任何条目时没必要去动用户的 CLAUDE.md 加一行引用。
  const g = renderMarkdown(items, { scope: 'global', ...budget });
  const gPath = path.join(os.homedir(), '.claude', 'memory-bank.md');
  fs.mkdirSync(path.dirname(gPath), { recursive: true });
  fs.writeFileSync(gPath, g.text, 'utf8');
  if (g.text) {
    ensureImport(path.join(os.homedir(), '.claude', 'CLAUDE.md'), '@memory-bank.md');
  }
  results.push({ scope: 'global', ...g });

  // 项目级：<dir>/.claude/memory-bank.md，引用行 @.claude/memory-bank.md
  // 结果为空串时：该工程此前若已生成过 memory-bank.md，必须把它写空（同上，防止旧规则死灰复燃）；
  // 若从未生成过（文件不存在），说明这个工程本就没有 project-scope 记忆，不必凭空造一个空文件。
  for (const dir of projectDirs) {
    if (!dir) continue;
    const p = renderMarkdown(items, { scope: 'project', projectDir: dir, ...budget });
    const file = path.join(dir, '.claude', 'memory-bank.md');
    if (!p.text && !fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, p.text, 'utf8');
    if (p.text) ensureImport(path.join(dir, 'CLAUDE.md'), '@.claude/memory-bank.md');
    results.push({ scope: 'project', projectDir: dir, ...p });
  }
  return results;
}

/**
 * 需要重渲染的工程目录集合。
 * 必须并上当前 cwd：条目全被否掉后 items 里就再也找不到这个 projectDir，
 * 只从 items 推导的话，该工程磁盘上的旧 memory-bank.md 永远不会被写空 —— 正是上面那条铁律要防的情形。
 */
function collectProjectDirs(items, cwd) {
  const set = new Set(
    (items || []).filter((i) => i.scope === 'project' && i.projectDir).map((i) => i.projectDir),
  );
  if (cwd) set.add(cwd);
  return [...set];
}

/**
 * 跑一轮。手动触发与定时触发共用。
 * @param {{cwd?:string, now?:number}} opts cwd = 要扫描的工作目录
 * @returns {Promise<{scanned:number, candidates:number, promoted:string[], truncated:number}>}
 */
export async function runOnce({ cwd = process.cwd(), now = Date.now() } = {}) {
  if (_running) return { scanned: 0, candidates: 0, promoted: [], truncated: 0, skipped: 'already-running' };
  _running = true;
  try {
    const settings = getMemoryBankSettings();
    const bank = readBank();
    const dir = transcriptDir(cwd);
    const pending = listTranscriptsSince(dir, bank.lastScannedAt).slice(0, MAX_SESSIONS_PER_RUN);

    const makeId = makeIdFactory(now);
    let state = { items: bank.items, blacklist: bank.blacklist };
    let candidateCount = 0;
    const promoted = [];
    // 游标只在「连续成功的前缀」上推进：pending 按 mtime 升序，游标是单个标量，
    // 一旦中途某个会话提炼失败就不能再往后推 —— 否则失败会话会被永久跳过、证据静默丢失。
    let cursor = bank.lastScannedAt;
    let cursorStalled = false;
    let llmCalls = 0;

    for (const t of pending) {
      const events = readTranscriptEvents(t.file);
      const { segments, dropped } = extractSignals(events);
      if (dropped > 0) logger.info('memory-bank', '片段超上限已截断', { sessionId: t.sessionId, dropped });
      if (segments.length === 0) {
        // 无高信号片段 = 已扫完且无事可做，属成功，可推进
        if (!cursorStalled) cursor = Math.max(cursor, t.mtimeMs);
        continue;
      }
      // llmCalls 在发起调用前就计数：失败的调用也烧了额度，必须计入，否则一轮全失败会被
      // shouldRun 误判为「没跑过」，白白多起一轮冷却窗之外的重试。
      llmCalls += 1;
      const cands = await extractFromSegments(segments, { cwd, sessionId: t.sessionId, model: settings.model });
      // extractFromSegments 的返回契约：null = 底层调用失败（超时/额度耗尽/解析不出），本会话
      // 提炼失败，不推进游标，下轮重试；[] = 调用成功但模型判定确实提炼不出偏好，属正常完成，可以推进游标。
      if (cands === null) {
        cursorStalled = true;
      } else {
        candidateCount += cands.length;
        const merged = mergeCandidates(state, cands, {
          now, makeId,
          threshold: { minEvidence: settings.minEvidence, minSessions: settings.minSessions },
        });
        state = { items: merged.items, blacklist: merged.blacklist };
        promoted.push(...merged.promoted);
      }
      if (!cursorStalled) cursor = Math.max(cursor, t.mtimeMs);
    }

    state.items = applyDormancy(state.items, { now, dormantDays: settings.dormantDays });

    // 落盘前与磁盘最新状态对账：本轮跨了多次 await（每次提炼最长 30s），
    // 期间用户可能在面板上否掉某条 —— rejectItem 已把 fingerprint 写进磁盘黑名单并删掉条目，
    // 而我们手上的 state 还是开跑前的快照，整体回写会让它复活，破坏 promote.js 的「否过的永不复活」不变量。
    const disk = readBank();
    const blacklist = mergeBlacklist(disk.blacklist, state.blacklist);
    const banned = new Set(blacklist.map((b) => b?.fingerprint).filter(Boolean));
    const items = state.items.filter((it) => !banned.has(it.fingerprint));

    // 无论本轮有没有扫到新转录都要渲染落盘：用户刚否掉最后一条时 pending 往往是空的，
    // 此时若直接返回，被否掉的规则会继续躺在磁盘上被 CLAUDE.md 引用（同 writeRenders 的铁律）；
    // applyDormancy 的降级也同理，需要在没有新转录的日子里照常生效。
    const renders = writeRenders(items, { now, settings, projectDirs: collectProjectDirs(items, cwd) });
    const truncated = renders.reduce((a, r) => a + (r.truncated || 0), 0);
    if (truncated > 0) logger.info('memory-bank', '条目因注入预算未渲染', { truncated });

    writeBank({
      version: 1,
      // 提炼失败时不推进游标，下轮重试；否则失败的会话会被永久跳过
      lastScannedAt: cursor,
      // 只有真发起过 LLM 调用才算「跑过一轮」：没花额度就不该起冷却，
      // 否则一次空扫会把 shouldRun 的 minIntervalHours 冷却窗白白吃掉。
      lastExtractAt: llmCalls > 0 ? now : bank.lastExtractAt,
      items,
      blacklist,
    });

    logger.info('memory-bank', '提炼完成', {
      scanned: pending.length, candidates: candidateCount, promoted: promoted.length, truncated,
    });
    return { scanned: pending.length, candidates: candidateCount, promoted, truncated };
  } catch (e) {
    logger.error('memory-bank', '提炼异常', { err: e?.message || String(e) });
    return { scanned: 0, candidates: 0, promoted: [], truncated: 0, error: e?.message || String(e) };
  } finally {
    _running = false;
  }
}

/** 定时 tick：判定窗口后才跑。web 入口启动时调用一次 */
export function startMemoryBankTicker({ cwd = process.cwd() } = {}) {
  // 幂等：重复调用不叠加定时器（否则每次调用都多一路 tick，提炼频率成倍上涨）
  if (_timer) clearInterval(_timer);
  _timer = setInterval(async () => {
    // 整个 tick 体兜异常：readBank/getTokens 等任一处抛错（如配置文件被写坏）都不能变成
    // unhandledRejection 打死常驻进程 —— 记忆库是锦上添花的功能，绝不该拖垮执行台。
    try {
      const now = Date.now();
      const bank = readBank();
      const decision = shouldRun({
        now,
        settings: getMemoryBankSettings(),
        tokens: getTokens(),
        activeRunCount: listActiveRuns().filter((e) => isPidAlive(e?.pid)).length,
        lastExtractAt: bank.lastExtractAt,
        // providerId 走默认值 DEFAULT_PROVIDER_ID('claude-agent')：提炼最终经
        // runClassifierOnce → claudeAuthOpts() → getActiveToken() 也是这个默认 provider，两边必须一致。
      });
      if (!decision.run) return;
      logger.info('memory-bank', '进入提炼窗口', { window: decision.window });
      await runOnce({ cwd, now });
    } catch (e) {
      logger.error('memory-bank', 'tick 异常', { err: e?.message || String(e) });
    }
  }, TICK_MS);
  // 不阻止进程退出：记忆库定时器不该让 node 因为一个后台 tick 迟迟不退
  if (_timer.unref) _timer.unref();
  return _timer;
}

/** 停表（测试/优雅退出用）；未启动时无副作用 */
export function stopMemoryBankTicker() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
```

- [ ] **Step 2: 挂到 web 启动**

在 `src/entrypoints/web/server.js` 的 `server.listen` 回调里（与现有 `scheduleAllSwitchBacks()` 同处）追加：

```js
import { startMemoryBankTicker } from '../../features/memory-bank/index.js';
// ...listen 回调内：
startMemoryBankTicker({ cwd: process.cwd() });
```

- [ ] **Step 3: 语法检查**

Run: `node --check src/features/memory-bank/index.js && node --check src/entrypoints/web/server.js`
Expected: 无输出（通过）

- [ ] **Step 4: 冒烟 —— 手动跑一轮，确认不炸且游标推进**

Run:
```bash
node -e "process.env.APP_DATA_DIR=process.cwd(); import('./src/features/memory-bank/index.js').then(async m => { const r = await m.runOnce({ cwd: process.cwd() }); console.log(JSON.stringify(r)); })"
```
Expected: 打印 `{"scanned":N,...}`。**功能默认关闭时 `runOnce` 仍可手动跑**（开关只管定时器）；若 token 池耗尽，`extractFromSegments` 会 fail-fast 返回空，`scanned` 有值而 `candidates` 为 0，属正常。

- [ ] **Step 5: 跑全量确认无回归**

Run: `npm test`
Expected: 全绿。**不提交**。

---

## Task 12: HTTP 接口（`routes-memory.js`）

**Files:**
- Create: `src/entrypoints/web/routes-memory.js`
- Modify: `src/entrypoints/web/server.js`（挂子路由）
- Test: `src/entrypoints/web/routes-memory.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/entrypoints/web/routes-memory.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-routes-'));
const { handleMemoryRoutes } = await import('./routes-memory.js');
const { writeBank, readBank, EMPTY_BANK } = await import('../../store/memory-bank.js');

function startServer() {
  const server = createServer((req, res) => handleMemoryRoutes(req, res, new URL(req.url, 'http://x')));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
let server, base;
test.before(async () => { server = await startServer(); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

async function call(pathname, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(base + pathname, opts);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const get = (p) => call(p, 'GET');
const post = (p, b) => call(p, 'POST', b ?? {});

const seed = () => {
  const bank = EMPTY_BANK();
  bank.items = [
    { id: 'm1', category: 'code-style', scope: 'global', projectDir: '', statement: '注释写中文',
      fingerprint: 'f1', status: 'candidate', inject: true, source: 'inferred',
      evidenceCount: 1, evidenceSessions: ['s1'],
      evidence: [{ quote: '不对', sessionId: 's1', at: '', kind: 'correction' }],
      promotedBy: null, acked: true, conflictWith: null, createdAt: 1, updatedAt: 1, lastSeenAt: 1 },
    { id: 'm2', category: 'collaboration', scope: 'global', projectDir: '', statement: '大改前先问我',
      fingerprint: 'f2', status: 'active', inject: true, source: 'explicit',
      evidenceCount: 1, evidenceSessions: ['s2'], evidence: [],
      promotedBy: 'auto', acked: false, conflictWith: null, createdAt: 1, updatedAt: 1, lastSeenAt: 1 },
  ];
  writeBank(bank);
};

test('GET /api/memory/list 返回条目与红点计数', async () => {
  seed();
  const r = await get('/api/memory/list');
  assert.equal(r.status, 200);
  assert.equal(r.json.items.length, 2);
  assert.equal(r.json.unackedCount, 1, '未读的自动晋升条目计入红点');
  assert.equal(r.json.conflictCount, 0);
  assert.ok(r.json.budget, '必须回传预算信息供面板提示截断');
});

test('POST /api/memory/confirm 置 active 且 promotedBy=manual', async () => {
  seed();
  const r = await post('/api/memory/confirm', { id: 'm1' });
  assert.equal(r.status, 200);
  const it = readBank().items.find((i) => i.id === 'm1');
  assert.equal(it.status, 'active');
  assert.equal(it.promotedBy, 'manual');
  assert.equal(it.acked, true, '手工确认的不该再亮红点');
});

test('POST /api/memory/confirm 可同时改写 statement / category / inject', async () => {
  seed();
  await post('/api/memory/confirm', { id: 'm1', statement: '注释写中文，只解释为什么', category: 'writing', inject: false });
  const it = readBank().items.find((i) => i.id === 'm1');
  assert.equal(it.statement, '注释写中文，只解释为什么');
  assert.equal(it.category, 'writing');
  assert.equal(it.inject, false);
});

test('POST /api/memory/confirm 拒绝未知 category', async () => {
  seed();
  assert.equal((await post('/api/memory/confirm', { id: 'm1', category: 'vibes' })).status, 400);
});

test('POST /api/memory/reject 移出条目并入黑名单', async () => {
  seed();
  const r = await post('/api/memory/reject', { id: 'm1' });
  assert.equal(r.status, 200);
  const bank = readBank();
  assert.equal(bank.items.find((i) => i.id === 'm1'), undefined);
  assert.equal(bank.blacklist[0].fingerprint, 'f1');
});

test('POST /api/memory/ack 清红点', async () => {
  seed();
  await post('/api/memory/ack', { all: true });
  assert.ok(readBank().items.every((i) => i.acked));
});

test('缺 id 返回 400，未知 id 返回 404', async () => {
  seed();
  assert.equal((await post('/api/memory/confirm', {})).status, 400);
  assert.equal((await post('/api/memory/confirm', { id: 'nope' })).status, 404);
});

test('GET /api/memory/export 含全部条目与证据链', async () => {
  seed();
  const r = await get('/api/memory/export?format=json');
  assert.equal(r.status, 200);
  assert.equal(r.json.schema, 'memory-bank/v1');
  assert.equal(r.json.items.length, 2);
  assert.ok(r.json.items[0].evidence, '导出必须含证据链 —— 数字分身要用');
  assert.ok(r.json.stats.byCategory);
});

test('未知路径 404', async () => {
  assert.equal((await get('/api/memory/nope')).status, 404);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/routes-memory.test.js`
Expected: FAIL — `Cannot find module './routes-memory.js'`

- [ ] **Step 3: 实现**

创建 `src/entrypoints/web/routes-memory.js`：

```js
/**
 * 记忆库 HTTP 接口。沿用本项目单入口子路由范式（对齐 routes-requirements.js）。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';
import { readBank, patchItem, rejectItem, ackItems } from '../../store/memory-bank.js';
import { getMemoryBankSettings } from '../../store/settings.js';
import { selectForInjection, CATEGORY_LABEL } from '../../features/memory-bank/render.js';
import { runOnce } from '../../features/memory-bank/index.js';

const CATEGORIES = Object.keys(CATEGORY_LABEL);

function budgetInfo(items, settings, now) {
  const { included, truncated } = selectForInjection(items, {
    scope: 'global', now, maxItems: settings.maxItems, maxChars: settings.maxChars,
  });
  return { used: included.length, total: settings.maxItems, truncated };
}

function handleList(res) {
  const now = Date.now();
  const bank = readBank();
  const settings = getMemoryBankSettings();
  sendJson(res, 200, {
    items: bank.items,
    unackedCount: bank.items.filter((i) => !i.acked).length,
    conflictCount: bank.items.filter((i) => i.status === 'conflict').length,
    budget: budgetInfo(bank.items, settings, now),
    lastExtractAt: bank.lastExtractAt,
    enabled: settings.enabled,
  });
}

function handleConfirm(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: 'id 不能为空' });
    const patch = { status: 'active', promotedBy: 'manual', acked: true, updatedAt: Date.now() };
    if (data.statement !== undefined) {
      const s = str(data.statement).trim();
      if (!s) return sendJson(res, 400, { error: 'statement 不能为空' });
      patch.statement = s.slice(0, 200);
    }
    if (data.category !== undefined) {
      const c = str(data.category);
      if (!CATEGORIES.includes(c)) return sendJson(res, 400, { error: '未知 category' });
      patch.category = c;
    }
    if (data.scope !== undefined) {
      const sc = str(data.scope);
      if (sc !== 'global' && sc !== 'project') return sendJson(res, 400, { error: '未知 scope' });
      patch.scope = sc;
      if (sc === 'global') patch.projectDir = '';
    }
    if (data.inject !== undefined) patch.inject = data.inject === true;
    if (!readBank().items.some((i) => i.id === id)) return sendJson(res, 404, { error: '条目不存在' });
    patchItem(id, patch);
    sendJson(res, 200, { ok: true });
  });
}

function handleReject(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: 'id 不能为空' });
    if (!readBank().items.some((i) => i.id === id)) return sendJson(res, 404, { error: '条目不存在' });
    rejectItem(id, Date.now());
    sendJson(res, 200, { ok: true });
  });
}

function handleAck(req, res) {
  return withJsonBody(req, res, (data) => {
    if (data.all === true) { ackItems(null); return sendJson(res, 200, { ok: true }); }
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: 'id 或 all 必须提供其一' });
    ackItems([id]);
    sendJson(res, 200, { ok: true });
  });
}

/** 手动提炼：202 立即返回，前端轮询 list（对齐 handleBitable 的长任务范式） */
function handleExtract(req, res) {
  sendJson(res, 202, { ok: true });
  runOnce({ cwd: process.cwd() }).catch((e) =>
    logger.error('memory-routes', '手动提炼异常', { err: e?.message || String(e) }));
}

function handleExport(url, res) {
  const bank = readBank();
  const byCategory = {};
  for (const it of bank.items) byCategory[it.category] = (byCategory[it.category] || 0) + 1;
  const payload = {
    schema: 'memory-bank/v1',
    exportedAt: new Date().toISOString(),
    stats: {
      total: bank.items.length,
      active: bank.items.filter((i) => i.status === 'active').length,
      byCategory,
    },
    // 全量：含 dormant / candidate / 仅记录组 / 证据链 —— 数字分身要用
    items: bank.items,
  };
  if (str(url.searchParams.get('format')) === 'md') {
    const lines = ['# 我的开发者档案', '', `导出时间：${payload.exportedAt}`, ''];
    for (const cat of CATEGORIES) {
      const group = bank.items.filter((i) => i.category === cat);
      if (!group.length) continue;
      lines.push(`## ${CATEGORY_LABEL[cat]}`, '');
      for (const it of group) lines.push(`- ${it.statement}  \`${it.status}\` · 证据 ${it.evidenceCount}`);
      lines.push('');
    }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(lines.join('\n'));
  }
  sendJson(res, 200, payload);
}

export function handleMemoryRoutes(req, res, url) {
  const { pathname } = url;
  const { method } = req;
  if (pathname === '/api/memory/list' && method === 'GET') return handleList(res);
  if (pathname === '/api/memory/confirm' && method === 'POST') return handleConfirm(req, res);
  if (pathname === '/api/memory/reject' && method === 'POST') return handleReject(req, res);
  if (pathname === '/api/memory/ack' && method === 'POST') return handleAck(req, res);
  if (pathname === '/api/memory/extract' && method === 'POST') return handleExtract(req, res);
  if (pathname === '/api/memory/export' && method === 'GET') return handleExport(url, res);
  return sendJson(res, 404, { error: 'not found' });
}
```

- [ ] **Step 4: 挂载到 server.js**

在 `src/entrypoints/web/server.js` 顶部加 import、路由 if 链中（`/api/req/` 那行附近）加一行：

```js
import { handleMemoryRoutes } from './routes-memory.js';
// ...路由链内：
if (url.pathname.startsWith('/api/memory/')) return handleMemoryRoutes(req, res, url);
```

同时把 `/api/memory/list` 加进 `ACCESS_LOG_SKIP`（面板会轮询，免刷屏）。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test src/entrypoints/web/routes-memory.test.js`
Expected: PASS，9 个用例全绿

- [ ] **Step 6: 跑全量确认无回归**

Run: `npm test && node --check src/entrypoints/web/server.js`
Expected: 全绿。**不提交**。

---

## Task 13: 记忆库面板（前端）

沿用既有内嵌面板范式（`panel-page` + `showView`），不做新弹层。**只改 `public/`**；`src-tauri/resources/` 是构建产物，手改会被覆盖。CSP 为 `script-src 'self'`，禁止内联脚本。

**Files:**
- Create: `public/js/memory-view.js`
- Modify: `public/index.html`（面板容器 + 侧栏入口）
- Modify: `public/app.js`（import / showView 分支 / 入口绑定 / 红点轮询）
- Modify: `public/app.css`（行样式 + 入口定位）

- [ ] **Step 1: 加面板容器**

`public/index.html` 的 `#panelView` 内，`data-view="logs"` 那块之后追加：

```html
<div class="panel-page" data-view="memory" hidden>
  <div class="panel-head">
    <h3>记忆库</h3>
    <button class="panel-close" title="返回对话">✕</button>
  </div>
  <div class="mem-toolbar">
    <span id="memBudgetTip" class="mem-budget-tip"></span>
    <button class="btn" id="memExtractBtn">立即提炼</button>
    <button class="btn" id="memExportBtn">导出</button>
  </div>
  <div id="memBody"></div>
</div>
```

侧栏工具列表 `#toolsList` 内追加入口（红点用既有 `.badge-dot`）：

```html
<button class="tool-item" id="toolMemory" data-tool="memory">
  <span class="tool-item-icon">🧠</span>
  <span class="tool-item-body">
    <span class="tool-item-title">记忆库<span class="badge-dot" id="memBadge" hidden></span></span>
    <span class="tool-item-desc">我的偏好 · 待确认与已生效</span>
  </span>
</button>
```

- [ ] **Step 2: 加样式**

`public/app.css` 末尾追加：

```css
/* 记忆库面板 */
.mem-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
.mem-budget-tip { flex: 1; color: var(--faint); font-size: 12px; }
.mem-section-label { margin: 12px 0 6px; color: var(--faint); font-size: 12px; }
.mem-item { display: flex; align-items: flex-start; gap: 8px; padding: 8px; border-radius: 6px; }
.mem-item:hover { background: var(--hover, rgba(127, 127, 127, 0.08)); }
.mem-item-body { flex: 1; min-width: 0; }
.mem-item-statement { display: block; word-break: break-word; }
.mem-item-meta { display: block; margin-top: 2px; color: var(--faint); font-size: 12px; }
.mem-evidence { margin: 4px 0 0 0; padding: 6px 8px; border-left: 2px solid var(--faint);
  color: var(--faint); font-size: 12px; white-space: pre-wrap; }
.mem-act { opacity: 0; transition: opacity 0.15s; background: none; border: none;
  color: var(--faint); cursor: pointer; font-family: inherit; }
.mem-item:hover .mem-act { opacity: 1; }
.mem-act:hover { color: var(--fg); }
.mem-act.danger:hover { color: var(--red); }
/* .badge-dot 是绝对定位，宿主必须建立定位上下文 */
#toolMemory .tool-item-title { position: relative; overflow: visible; }
```

- [ ] **Step 3: 实现面板模块**

创建 `public/js/memory-view.js`：

```js
/**
 * 记忆库面板：候选确认 / 已生效 / 冲突 / 休眠。
 * 渲染一律 createElement + textContent（条目内容来自 LLM，绝不用 innerHTML）。
 */
import { $ } from './util.js';
import { confirmDialog, promptDialog } from './ui.js';

const CATEGORY_LABEL = {
  'code-style': '代码风格', collaboration: '协作习惯', writing: '写作习惯',
  dialogue: '对话风格', 'tech-pref': '技术偏好',
};

let _items = [];
let _expanded = new Set();   // 展开证据的条目 id（内存态，切页不保留）
let _showDormant = false;

async function api(path, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const r = await fetch(path, opts);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.error || '请求失败');
  return d;
}

function makeAct(label, title, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'mem-act' + (cls ? ' ' + cls : '');
  b.textContent = label;
  b.title = title;
  b.onclick = onClick;
  return b;
}

function makeRow(it) {
  const row = document.createElement('div');
  row.className = 'mem-item';

  const body = document.createElement('div');
  body.className = 'mem-item-body';

  const st = document.createElement('span');
  st.className = 'mem-item-statement';
  st.textContent = it.statement;
  body.appendChild(st);

  const meta = document.createElement('span');
  meta.className = 'mem-item-meta';
  const parts = [
    CATEGORY_LABEL[it.category] || it.category,
    it.scope === 'project' ? '本工程' : '全局',
    `证据 ${it.evidenceCount}（${it.evidenceSessions?.length || 0} 个会话）`,
  ];
  if (it.source === 'explicit') parts.push('你明确说过');
  if (!it.inject) parts.push('仅记录');
  if (it.status === 'conflict') parts.push('⚠ 与已有偏好冲突，请裁决');
  if (!it.acked) parts.push('🔴 新');
  meta.textContent = parts.join(' · ');
  body.appendChild(meta);

  if (_expanded.has(it.id)) {
    const ev = document.createElement('pre');
    ev.className = 'mem-evidence';
    ev.textContent = (it.evidence || []).length
      ? it.evidence.map((e) => `[${e.sessionId?.slice(0, 8) || '?'}] ${e.quote}`).join('\n')
      : '（无留存原话）';
    body.appendChild(ev);
  }
  row.appendChild(body);

  row.appendChild(makeAct(_expanded.has(it.id) ? '收起' : '原话', '查看证据原话', '', () => {
    if (_expanded.has(it.id)) _expanded.delete(it.id); else _expanded.add(it.id);
    render();
  }));

  if (it.status !== 'active') {
    row.appendChild(makeAct('✓', '确认并生效', '', async () => {
      try { await api('/api/memory/confirm', { id: it.id }); window.toast.success('已生效'); refresh(); }
      catch (e) { window.toast.error(e.message); }
    }));
  }

  row.appendChild(makeAct('✎', '编辑措辞', '', async () => {
    const v = await promptDialog({ title: '编辑偏好', value: it.statement });
    if (v === null || v.trim() === '') return;
    try { await api('/api/memory/confirm', { id: it.id, statement: v.trim() }); window.toast.success('已保存'); refresh(); }
    catch (e) { window.toast.error(e.message); }
  }));

  row.appendChild(makeAct('✗', '否掉（此后不再提炼这条）', 'danger', async () => {
    const ok = await confirmDialog({
      title: '否掉这条偏好？', message: `「${it.statement}」\n\n否掉后不会再被提炼出来。`, danger: true,
    });
    if (!ok) return;
    try { await api('/api/memory/reject', { id: it.id }); window.toast.success('已否掉'); refresh(); }
    catch (e) { window.toast.error(e.message); }
  }));

  return row;
}

function makeLabel(text) {
  const d = document.createElement('div');
  d.className = 'mem-section-label';
  d.textContent = text;
  return d;
}

function render() {
  const el = $('#memBody');
  if (!el) return;
  el.innerHTML = '';
  const frag = document.createDocumentFragment();

  const groups = [
    ['⚠ 待裁决（冲突）', _items.filter((i) => i.status === 'conflict')],
    ['待确认', _items.filter((i) => i.status === 'candidate')],
    ['已生效', _items.filter((i) => i.status === 'active')],
  ];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    frag.appendChild(makeLabel(`${label}（${list.length}）`));
    for (const it of list) frag.appendChild(makeRow(it));
  }

  const dormant = _items.filter((i) => i.status === 'dormant');
  if (dormant.length) {
    const toggle = makeLabel(`${_showDormant ? '▾' : '▸'} 休眠（${dormant.length}）`);
    toggle.style.cursor = 'pointer';
    toggle.onclick = () => { _showDormant = !_showDormant; render(); };
    frag.appendChild(toggle);
    if (_showDormant) for (const it of dormant) frag.appendChild(makeRow(it));
  }

  if (!_items.length) frag.appendChild(makeLabel('还没有提炼出偏好。开启功能后，它会在额度空闲时段自动积累。'));
  el.appendChild(frag);
}

async function refresh() {
  let d;
  try { d = await api('/api/memory/list'); }
  catch { return; }   // 失败沿用上次渲染，不清空面板
  _items = d.items || [];
  const tip = $('#memBudgetTip');
  if (tip) {
    tip.textContent = d.budget?.truncated
      ? `⚠ ${d.budget.truncated} 条因注入预算未生效（已用 ${d.budget.used}/${d.budget.total}）`
      : `已注入 ${d.budget?.used || 0}/${d.budget?.total || 0} 条`;
  }
  render();
  // 打开面板即视为已读
  if (d.unackedCount > 0) {
    try { await api('/api/memory/ack', { all: true }); } catch { /* 忽略 */ }
    updateMemBadge(0);
  }
}

export function initMemoryPanel() {
  refresh();
  $('#memExtractBtn').onclick = async () => {
    try {
      await api('/api/memory/extract', {});
      window.toast.info('已开始提炼，稍后刷新查看');
      setTimeout(refresh, 15000);
    } catch (e) { window.toast.error(e.message); }
  };
  $('#memExportBtn').onclick = () => { window.open('/api/memory/export?format=json', '_blank'); };
}

function updateMemBadge(n) {
  const b = $('#memBadge');
  if (b) b.hidden = !n;
}

/** 静默轮询红点。面板已打开时跳过（打开即已读） */
export async function refreshMemBadge() {
  try {
    const d = await (await fetch('/api/memory/list')).json();
    updateMemBadge((d.unackedCount || 0) + (d.conflictCount || 0));
  } catch { /* 忽略轮询失败 */ }
}
```

- [ ] **Step 4: 接进 app.js**

`public/app.js` 顶部 import 区加：

```js
import { initMemoryPanel, refreshMemBadge } from './js/memory-view.js';
```

`showView` 的分支链里加一条（与 `else if (name === 'logs') loadLogs();` 同级）：

```js
  else if (name === 'memory') initMemoryPanel();
```

纯 DOM 绑定区（boot gate **之外**，与 `#toolJson` 同处）加：

```js
$('#toolMemory')?.addEventListener('click', () => showView('memory'));
```

boot gate **之内**（`await whenBackendReady()` 之后，与 `refreshTaskBadge` 同处）加：

```js
  refreshMemBadge();
  setInterval(refreshMemBadge, 60000);
```

- [ ] **Step 5: 起服务人工验面板**

Run: `node server.js`，浏览器开 `http://127.0.0.1:3000`

逐项确认：
1. 侧栏「工具」里出现「记忆库」入口，点击进入面板，空态显示引导文案
2. 面板顶部显示「已注入 0/40 条」
3. 点「立即提炼」不报错，toast 提示已开始
4. `Esc` 或 ✕ 能回到对话视图
5. 浏览器控制台无 CSP 报错、无 404

- [ ] **Step 6: 跑全量确认无回归**

Run: `npm test`
Expected: 全绿。**不提交**。

---

## Task 14: 端到端走查与验收

前面所有任务都是单元级验证。本任务确认功能真的按设计跑通，尤其是**注入是否真的生效**。

**Files:** 无代码改动

- [ ] **Step 1: 开启功能并配置**

在 `settings.json` 的 `memoryBank` 段设 `"enabled": true`（或从设置页开启，若已接 UI）。确认 `nightStart`/`nightEnd` 为 `03:00`/`08:00`。

- [ ] **Step 2: 手动灌一轮真实数据**

Run: `curl -X POST http://127.0.0.1:3000/api/memory/extract`
等 1-2 分钟后 Run: `curl -s http://127.0.0.1:3000/api/memory/list`

Expected: `items` 非空；每条带 `evidence[].quote` 且**原话逐字来自真实会话**（抽查 2 条，回到对应 sessionId 的转录里搜这句话，必须能搜到）。

- [ ] **Step 3: 验红点与确认流**

面板确认：候选条目可见 → 点 ✓ 确认 → 条目移入「已生效」→ 侧栏红点消失。
点 ✗ 否掉一条 → 再次「立即提炼」→ **该条不得重新出现**（黑名单生效）。

- [ ] **Step 4: 验文件落盘与 CLAUDE.md 安全性（最高风险项）**

Run:
```bash
cat ~/.claude/memory-bank.md
git -C . diff --stat ~/.claude/CLAUDE.md 2>/dev/null || cat ~/.claude/CLAUDE.md
```

Expected:
- `memory-bank.md` 只含代码风格 / 协作习惯 / 写作习惯三节，**不含**对话风格与技术偏好
- `~/.claude/CLAUDE.md` 中原有手写内容（含「Always respond in Chinese-simplified」）**逐字未变**，仅新增一行 `@memory-bank.md`

**若此项不通过，立即停止并回滚 —— 污染 CLAUDE.md 会影响此后所有会话。**

- [ ] **Step 5: 验注入真的生效**

新开一个对话，问：「不要读任何文件，直接说：你现在知道我的哪些代码风格偏好？」

Expected: 回答复述出 `memory-bank.md` 里的条目。若答不出，说明 `@` 引用未被加载 —— 检查引用行路径是否相对 `CLAUDE.md` 所在目录正确，以及 `claude.js` 是否被人加上了 `settingSources: []`。

- [ ] **Step 6: 验调度不抢额度**

起一个长任务（正常对话），期间观察 `logs/app-*.log`：

Expected: 任务运行期间**不出现** `[memory-bank] 进入提炼窗口`。`shouldRun` 的 `busy` 短路必须生效。

- [ ] **Step 7: 验导出**

Run: `curl -s "http://127.0.0.1:3000/api/memory/export?format=json" | head -40`

Expected: `schema` 为 `memory-bank/v1`；`items` 含**全部五类**（包括仅记录的对话风格 / 技术偏好）与完整 `evidence`。

- [ ] **Step 8: 记录走查结果**

把通过/未通过项与真机现象补进 spec 的 §17 验收清单旁，或记入项目 memory。**全程不提交**，改动留工作区由用户处置。

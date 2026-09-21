# BUG 巡检循环化与需求测试期对接 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `\10001` BUG 巡检从一次性变成可循环（修完待命 20 分钟再扫、12 小时上限、`\10004` 可停），并在关联测试期需求时对确认的缺陷做前后端归属判定，后端问题转派给后端同事。

**Architecture:** 循环状态落盘到 `store/patrol-loop.js`，循环泵常驻 **web 进程**（与 auto-dev 泵同进程，才能直接读任务终态判「全修完」）；飞书进程只做指令识别与跨进程 POST 下发。归属判定是独立于 `reviewTask` 的第二次只读 Claude 调用。

**Tech Stack:** Node ≥20 原生 ESM、`node --test` 单测、飞书开放平台 bitable/im API、Claude Agent SDK（只读模式）。

**规格依据：** `docs/superpowers/specs/2026-09-18-patrol-loop-design.md`

---

## ⚠️ 执行约定（偏离默认 skill 行为）

本项目 `CLAUDE.md` 明确「**不自动 `git` 提交，改动留工作区，提交时机由维护者掌控**」。因此本计划**所有任务都不含 `git commit` 步骤**，每个任务以「跑测试验证」收尾。请勿自行提交。

---

## 文件结构

### 新建

| 文件 | 职责 | 依赖 |
|---|---|---|
| `src/store/patrol-loop.js` | 循环状态落盘（锁 + 原子写） | `store/index.js` |
| `src/plugins/team-tools/bug-patrol/side-review.logic.js` | 归属判定纯函数 | 零 IO |
| `src/plugins/team-tools/bug-patrol/side-review.js` | 归属判定调用体（只读 Claude + 超时） | `integrations/claude` |
| `src/plugins/team-tools/bug-patrol/loop.logic.js` | 轮次结算 / 汇报文案纯函数 | 零 IO |
| `src/plugins/team-tools/bug-patrol/loop.js` | 循环泵（web 进程常驻） | store / review / auto-dev queue / lark |
| `src/plugins/team-tools/stop-patrol/index.js` | feature `\10004`（order 15） | `shared/config` |
| `src/plugins/team-tools/stop-patrol/logic.js` | `STOP_TRIGGERS` 常量 | 零依赖 |
| `src/entrypoints/web/routes-patrol.js` | `/api/patrol/start`、`/api/patrol/stop` | web 入口层 |
| 对应 `*.test.js` × 4 | 纯函数单测 | — |

### 修改

| 文件 | 改动 |
|---|---|
| `src/plugins/team-tools/bug-patrol/logic.js` | 新增 `filterUnseen` / `parseReqChoice` / `buildStartReply` |
| `src/plugins/team-tools/bug-patrol/index.js` | 收链接后找测试期需求 → 跨进程 POST；新增「选需求」等待态 |
| `src/plugins/team-tools/index.js` | 注册 `stop-patrol`（order 15） |
| `src/entrypoints/web/server.js` | ROUTES 加 `/api/patrol` 前缀；listen 回调启 `startPatrolLoopPump` |
| `src/plugins/CLAUDE.md`、`src/store/CLAUDE.md`、`src/entrypoints/CLAUDE.md` | 模块地图补条目 |

---

## Task 1: 循环状态 store

**Files:**
- Create: `src/store/patrol-loop.js`
- Test: `src/store/patrol-loop.test.js`

- [ ] **Step 1: 写失败测试**

```js
// src/store/patrol-loop.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOOP, normalizeLoop } from './patrol-loop.js';

test('normalizeLoop：null/非对象 → 默认态（active=false）', () => {
  assert.deepEqual(normalizeLoop(null), DEFAULT_LOOP);
  assert.deepEqual(normalizeLoop('x'), DEFAULT_LOOP);
  assert.equal(normalizeLoop({}).active, false);
});

test('normalizeLoop：补全缺失字段，保留已有值', () => {
  const r = normalizeLoop({ active: true, openId: 'ou_a', roundNo: 3 });
  assert.equal(r.active, true);
  assert.equal(r.openId, 'ou_a');
  assert.equal(r.roundNo, 3);
  assert.deepEqual(r.seen, {});           // 缺失的补默认
  assert.deepEqual(r.cycleTaskIds, []);
  assert.equal(r.phase, 'scanning');
});

test('normalizeLoop：seen/report 类型错时回退默认（防读坏配置打穿下游）', () => {
  const r = normalizeLoop({ seen: 'bad', cycleTaskIds: 'bad', report: 42 });
  assert.deepEqual(r.seen, {});
  assert.deepEqual(r.cycleTaskIds, []);
  assert.deepEqual(r.report, DEFAULT_LOOP.report);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/store/patrol-loop.test.js
```
预期：`Cannot find module './patrol-loop.js'`

- [ ] **Step 3: 实现**

```js
// src/store/patrol-loop.js
/**
 * BUG 巡检循环状态（patrol-loop.json）—— 单例，同时只允许一个循环在跑。
 *
 * 为什么是单例：auto-dev 只有一个常驻工作区（auto worktree），两个循环会抢同一个
 * 任务分支。与其做并发控制，不如直接拒绝第二个触发并告知启动人。
 *
 * 为什么落盘而不是内存：循环最长跑 12 小时，期间 pm2 重启（崩溃自重启 / 代码更新）
 * 是常态。内存态会让循环在无人察觉时静默消失——而这功能正是为无人值守设计的。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'patrol-loop.json';

/** 默认态。active=false 时泵直接 return，不做任何事 */
export const DEFAULT_LOOP = {
  active: false,
  stopping: false,       // \10004 已收到：不再新扫，等已入队任务跑完后发终报
  openId: '',
  chatId: '',
  chatType: '',
  appToken: '',
  tableId: null,
  url: '',
  reqId: null,           // 只存 id 不存 title 快照（对齐 colleagues 的 assignees 纪律）
  startedAt: 0,
  phase: 'scanning',     // 'scanning' | 'standby'
  nextRunAt: 0,
  roundNo: 0,
  seen: {},              // { [recordId]: { verdict, side, at } }
  cycleTaskIds: [],
  retried: {},           // { [taskId]: true }
  report: { fixed: [], handoff: [], failed: [], unknown: [] },
};

/**
 * 形状归一（纯函数）。每个字段独立兜底：读坏一个字段不该让整份状态回退，
 * 否则一次手改 JSON 出错就会把正在跑的循环整个抹掉。
 */
export function normalizeLoop(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const rep = obj(o.report);
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    active: o.active === true,
    stopping: o.stopping === true,
    openId: typeof o.openId === 'string' ? o.openId : '',
    chatId: typeof o.chatId === 'string' ? o.chatId : '',
    chatType: typeof o.chatType === 'string' ? o.chatType : '',
    appToken: typeof o.appToken === 'string' ? o.appToken : '',
    tableId: typeof o.tableId === 'string' ? o.tableId : null,
    url: typeof o.url === 'string' ? o.url : '',
    reqId: typeof o.reqId === 'string' ? o.reqId : null,
    startedAt: Number.isFinite(o.startedAt) ? o.startedAt : 0,
    phase: o.phase === 'standby' ? 'standby' : 'scanning',
    nextRunAt: Number.isFinite(o.nextRunAt) ? o.nextRunAt : 0,
    roundNo: Number.isFinite(o.roundNo) ? o.roundNo : 0,
    seen: obj(o.seen),
    cycleTaskIds: arr(o.cycleTaskIds),
    retried: obj(o.retried),
    report: {
      fixed: arr(rep.fixed),
      handoff: arr(rep.handoff),
      failed: arr(rep.failed),
      unknown: arr(rep.unknown),
    },
  };
}

/** 读当前循环状态（永远返回合法形状） */
export function readLoop() {
  return normalizeLoop(readJson(FILE, null));
}

/** 锁内浅合并补丁。注意 seen/retried/report 是整体替换，增量请用下面三个专用函数 */
export function updateLoop(patch = {}) {
  let out = null;
  updateJson(FILE, null, (raw) => {
    out = normalizeLoop({ ...normalizeLoop(raw), ...patch });
    return out;
  });
  return out;
}

/** 锁内增量记 seen —— 逐条评审是串行的，但泵 tick 可能并发进来，必须锁内读改写 */
export function markSeen(recordId, info) {
  let out = null;
  updateJson(FILE, null, (raw) => {
    const cur = normalizeLoop(raw);
    cur.seen = { ...cur.seen, [recordId]: { ...info, at: Date.now() } };
    out = cur;
    return cur;
  });
  return out;
}

/** 锁内追加本轮任务 id */
export function pushCycleTask(taskId) {
  let out = null;
  updateJson(FILE, null, (raw) => {
    const cur = normalizeLoop(raw);
    if (!cur.cycleTaskIds.includes(taskId)) cur.cycleTaskIds = [...cur.cycleTaskIds, taskId];
    out = cur;
    return cur;
  });
  return out;
}

/** 锁内往 report 的某一类追加一条 */
export function pushReport(kind, item) {
  let out = null;
  updateJson(FILE, null, (raw) => {
    const cur = normalizeLoop(raw);
    if (!Array.isArray(cur.report[kind])) return undefined; // 非法 kind：不写盘
    cur.report = { ...cur.report, [kind]: [...cur.report[kind], item] };
    out = cur;
    return cur;
  });
  return out;
}

/** 锁内标记某任务已重试过一次 */
export function markRetried(taskId) {
  updateJson(FILE, null, (raw) => {
    const cur = normalizeLoop(raw);
    cur.retried = { ...cur.retried, [taskId]: true };
    return cur;
  });
}

/** 结束循环：整份回默认态（下次触发是全新一轮，不该继承上次的 seen） */
export function clearLoop() {
  updateJson(FILE, null, () => ({ ...DEFAULT_LOOP }));
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/store/patrol-loop.test.js
```
预期：3 tests pass

---

## Task 2: bug-patrol 纯函数增补

**Files:**
- Modify: `src/plugins/team-tools/bug-patrol/logic.js`
- Modify: `src/plugins/team-tools/bug-patrol/logic.test.js`

- [ ] **Step 1: 写失败测试（追加到现有测试文件末尾）**

```js
// 追加 import：filterUnseen, parseReqChoice, buildStartReply
test('filterUnseen：已判过的 recordId 被过滤掉（成本护栏）', () => {
  const records = [{ record_id: 'r1' }, { record_id: 'r2' }, { record_id: 'r3' }];
  const seen = { r1: { verdict: 'reject' }, r3: { verdict: 'backend' } };
  assert.deepEqual(filterUnseen(records, seen).map((r) => r.record_id), ['r2']);
});

test('filterUnseen：seen 为空/非法 → 原样返回（不吞记录）', () => {
  const records = [{ record_id: 'r1' }];
  assert.equal(filterUnseen(records, {}).length, 1);
  assert.equal(filterUnseen(records, null).length, 1);
  assert.equal(filterUnseen(null, {}).length, 0);
});

test('parseReqChoice：解析 1-based 序号，越界/非数字返回 null', () => {
  assert.equal(parseReqChoice('2', 3), 1);        // 返回 0-based 下标
  assert.equal(parseReqChoice(' 1 ', 3), 0);
  assert.equal(parseReqChoice('4', 3), null);     // 越界
  assert.equal(parseReqChoice('0', 3), null);
  assert.equal(parseReqChoice('abc', 3), null);
  assert.equal(parseReqChoice('', 3), null);
});

test('buildStartReply：有需求名则回显，无则给出未关联说明', () => {
  const withReq = buildStartReply('订单中心改版');
  assert.match(withReq, /关联需求：订单中心改版/);
  assert.match(withReq, /每 20 分钟/);
  assert.match(withReq, /\\10004/);

  const without = buildStartReply(null);
  assert.doesNotMatch(without, /关联需求/);
  assert.match(without, /未找到测试期需求/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/plugins/team-tools/bug-patrol/logic.test.js
```
预期：`filterUnseen is not defined`

- [ ] **Step 3: 实现（追加到 `logic.js` 末尾）**

```js
/**
 * 成本护栏：滤掉本次循环里已经判过的记录。
 * 驳回（ask/reject）的记录不写表、状态仍是「待处理」，不过滤就会在每一轮重新评审，
 * 12 小时下来是主要的额度消耗源。
 * 代价：在表里补了描述让某条变得可修，本轮循环不会重评，需重新触发 \10001 全量扫。
 */
export function filterUnseen(records, seen) {
  const s = seen && typeof seen === 'object' ? seen : {};
  return (Array.isArray(records) ? records : []).filter((r) => !s[r?.record_id]);
}

/**
 * 「选需求」等待态下解析用户回的序号。
 * @returns {number|null} 0-based 下标；非数字 / 越界 / 空 一律 null（调用方重新提示）
 */
export function parseReqChoice(text, total) {
  const t = String(text ?? '').trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > total) return null;
  return n - 1;
}

/** 启动应答文案。reqTitle 为空表示未关联需求（不做前后端判定），该事实必须当场说清 */
export function buildStartReply(reqTitle) {
  const head = reqTitle
    ? `关联需求：${reqTitle}\n🔍 已收到表格，开始巡检…（逐条评审需要几分钟，完成后在此汇报）`
    : `🔍 已收到表格，开始巡检…（未找到测试期需求，本次不做前后端归属判定）`;
  return `${head}\n每 20 分钟自动复查一次，累计 12 小时后自动停止；发「\\10004 停止巡检」可随时结束。`;
}

/** 多个测试期需求时的选择提示 */
export function buildReqChoicePrompt(reqs) {
  const lines = reqs.map((r, i) => `${i + 1}. ${r.title || '（未命名需求）'}`);
  return `找到 ${reqs.length} 个处于测试阶段的需求，回复序号选择：\n${lines.join('\n')}\n（回复「取消」退出）`;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/plugins/team-tools/bug-patrol/logic.test.js
```
预期：全部 pass（含原有用例）

---

## Task 3: 归属判定纯函数

**Files:**
- Create: `src/plugins/team-tools/bug-patrol/side-review.logic.js`
- Test: `src/plugins/team-tools/bug-patrol/side-review.logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
// src/plugins/team-tools/bug-patrol/side-review.logic.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSidePrompt,
  parseSideJson,
  resolveBackendOpenId,
  buildAssigneePatch,
} from './side-review.logic.js';

test('buildSidePrompt：带上前后端目录与记录详情，要求单行 JSON', () => {
  const p = buildSidePrompt(
    { title: '分页错乱', detail: 'total 对不上' },
    { frontendDir: 'C:/fe', backendDir: 'C:/be' },
  );
  assert.match(p, /C:\/fe/);
  assert.match(p, /C:\/be/);
  assert.match(p, /分页错乱/);
  assert.match(p, /"side"/);
  assert.match(p, /只读/);
});

test('parseSideJson：正常解析三种 side', () => {
  assert.equal(parseSideJson('{"side":"backend","evidence":"e","advice":"a"}').side, 'backend');
  assert.equal(parseSideJson('前言\n{"side":"frontend","evidence":"e"}').side, 'frontend');
  assert.equal(parseSideJson('{"side":"unknown"}').side, 'unknown');
});

test('parseSideJson：畸形/非法 side 一律落 unknown（绝不误判成 backend 去打扰同事）', () => {
  assert.equal(parseSideJson('').side, 'unknown');
  assert.equal(parseSideJson('not json').side, 'unknown');
  assert.equal(parseSideJson('{"side":"both"}').side, 'unknown');
  assert.equal(parseSideJson(null).side, 'unknown');
});

test('parseSideJson：advice 缺失补空串，不返回 undefined', () => {
  assert.equal(parseSideJson('{"side":"backend"}').advice, '');
});

test('resolveBackendOpenId：优先 assignees 里的后端', () => {
  const colleagues = [
    { id: 'c1', role: 'frontend', name: '小前', feishuOpenId: 'ou_fe' },
    { id: 'c2', role: 'backend', name: '李四', feishuOpenId: 'ou_be' },
    { id: 'c3', role: 'backend', name: '王五', feishuOpenId: 'ou_be2' },
  ];
  const r = resolveBackendOpenId({ assignees: ['c1', 'c2'], colleagues });
  assert.deepEqual(r, { openId: 'ou_be', name: '李四' });
});

test('resolveBackendOpenId：assignees 里没后端 → 回退全局名册第一个有 open_id 的', () => {
  const colleagues = [
    { id: 'c2', role: 'backend', name: '无号', feishuOpenId: '' },
    { id: 'c3', role: 'backend', name: '王五', feishuOpenId: 'ou_be2' },
  ];
  const r = resolveBackendOpenId({ assignees: [], colleagues });
  assert.deepEqual(r, { openId: 'ou_be2', name: '王五' });
});

test('resolveBackendOpenId：全都没有 → null（调用方降级为仅移除我）', () => {
  assert.equal(resolveBackendOpenId({ assignees: [], colleagues: [] }), null);
  assert.equal(resolveBackendOpenId({ assignees: [], colleagues: [{ role: 'backend', feishuOpenId: '' }] }), null);
});

test('buildAssigneePatch：移除我 + 追加后端，保留其他人', () => {
  const cur = [{ id: 'ou_me' }, { id: 'ou_other' }];
  assert.deepEqual(buildAssigneePatch(cur, 'ou_me', 'ou_be'), [{ id: 'ou_other' }, { id: 'ou_be' }]);
});

test('buildAssigneePatch：后端已在列表里不重复追加', () => {
  const cur = [{ id: 'ou_me' }, { id: 'ou_be' }];
  assert.deepEqual(buildAssigneePatch(cur, 'ou_me', 'ou_be'), [{ id: 'ou_be' }]);
});

test('buildAssigneePatch：backendOpenId 为空 → 仅移除我（降级路径）', () => {
  const cur = [{ id: 'ou_me' }, { id: 'ou_other' }];
  assert.deepEqual(buildAssigneePatch(cur, 'ou_me', null), [{ id: 'ou_other' }]);
});

test('buildAssigneePatch：非数组当前值 → 只放后端（不抛错）', () => {
  assert.deepEqual(buildAssigneePatch(null, 'ou_me', 'ou_be'), [{ id: 'ou_be' }]);
  assert.deepEqual(buildAssigneePatch(undefined, 'ou_me', null), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/plugins/team-tools/bug-patrol/side-review.logic.test.js
```
预期：`Cannot find module './side-review.logic.js'`

- [ ] **Step 3: 实现**

```js
// src/plugins/team-tools/bug-patrol/side-review.logic.js
/**
 * 前后端归属判定的纯函数 —— prompt 构造 / 输出解析 / 后端人选解析 / 人员字段补丁。
 *
 * 判定本身是独立于 reviewTask 的第二次只读调用（review/index.js 已两轮过审保持稳定，不动它）。
 * 这里的铁律：**判不准一律 unknown**。unknown 会按前端自动修（修在任务分支上等人工 review，
 * 改错了也进不了主干），而误判成 backend 会去打扰真实同事——后者代价高得多。
 */

/** 合法 side 白名单：模型输出任何其它值都当 unknown */
const SIDES = new Set(['frontend', 'backend', 'unknown']);

/** 构造归属判定 prompt。要求的 advice 是给人看的，所以明确禁止贴代码/堆栈 */
export function buildSidePrompt(record, { frontendDir, backendDir } = {}) {
  return (
    `你要判断一个 BUG 属于前端还是后端。请在代码中实际查证（只读，不修改任何文件）后作答。\n\n` +
    `前端工程：${frontendDir || '（未配置）'}\n` +
    `后端工程：${backendDir || '（未配置）'}\n\n` +
    `BUG 标题：${record?.title || ''}\n` +
    `BUG 详情：${record?.detail || ''}\n\n` +
    `判定要求：\n` +
    `1. 必须在代码里找到依据才能下结论，写进 evidence（文件/函数/逻辑链）。\n` +
    `2. 只要有一点拿不准，就填 unknown —— 误判成 backend 会去打扰真实同事，代价很高。\n` +
    `3. side=backend 时必须写 advice：给后端同事看的处理建议。要求简短、口语、**一两句话说清**，\n` +
    `   讲现象和怀疑方向即可，不要贴代码、不要贴堆栈、不要写「建议排查」这类空话。\n` +
    `   例：「接口返回的 total 和实际条数对不上，前端只是照着渲染。建议查一下分页 SQL 的 count 语句。」\n\n` +
    `最终回复只输出一行 JSON，不要任何其他文字：\n` +
    `{"side":"frontend|backend|unknown","evidence":"代码依据","advice":"给后端的人话建议（side=backend 时必填）"}`
  );
}

/**
 * 解析模型输出（括号配平从后往前找最后一个合法 JSON，同 review/logic.js#parseReviewJson 思路）。
 * 任何解析失败或非法 side 都落 unknown，绝不抛错——这是无人值守链路，抛错会中断整轮。
 */
export function parseSideJson(text) {
  const fallback = { side: 'unknown', evidence: '', advice: '' };
  const s = String(text || '');
  const starts = [];
  for (let i = 0; i < s.length; i++) if (s[i] === '{') starts.push(i);
  for (let k = starts.length - 1; k >= 0; k--) {
    let depth = 0;
    for (let i = starts[k]; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            const j = JSON.parse(s.slice(starts[k], i + 1));
            if (j && typeof j === 'object') {
              return {
                side: SIDES.has(j.side) ? j.side : 'unknown',
                evidence: typeof j.evidence === 'string' ? j.evidence : '',
                advice: typeof j.advice === 'string' ? j.advice : '',
              };
            }
          } catch {
            /* 该候选不合法，试更前面的起点 */
          }
          break;
        }
      }
    }
  }
  return fallback;
}

/**
 * 解析要转派给谁：需求指派的后端优先，回退全局名册。
 * @param {{ assignees: string[], colleagues: Array }} p colleagues 为 getColleagues() 全量
 * @returns {{ openId: string, name: string } | null} null = 拿不到，调用方降级为仅移除我
 */
export function resolveBackendOpenId({ assignees = [], colleagues = [] } = {}) {
  const list = Array.isArray(colleagues) ? colleagues : [];
  const ids = new Set(Array.isArray(assignees) ? assignees : []);
  const usable = (c) => c?.role === 'backend' && typeof c.feishuOpenId === 'string' && c.feishuOpenId;
  const hit = list.find((c) => ids.has(c?.id) && usable(c)) || list.find(usable);
  return hit ? { openId: hit.feishuOpenId, name: hit.name || '后端' } : null;
}

/**
 * 构造人员字段的新值：移除我 + 追加后端（去重），**保留其他原有成员**。
 * 只把自己摘出去，不替别人做指派决定——表里可能本来就挂着测试、产品等人。
 * @returns {Array<{id:string}>} 直接作为 updateBitableRecord 的人员字段值
 */
export function buildAssigneePatch(current, myOpenId, backendOpenId) {
  const kept = (Array.isArray(current) ? current : [])
    .filter((u) => u?.id && u.id !== myOpenId)
    .map((u) => ({ id: u.id }));
  if (backendOpenId && !kept.some((u) => u.id === backendOpenId)) kept.push({ id: backendOpenId });
  return kept;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/plugins/team-tools/bug-patrol/side-review.logic.test.js
```
预期：11 tests pass

---

## Task 4: 归属判定调用体

**Files:**
- Create: `src/plugins/team-tools/bug-patrol/side-review.js`
- Test: `src/plugins/team-tools/bug-patrol/side-review.test.js`

- [ ] **Step 1: 写失败测试**（只测超时与异常兜底；真实 Claude 调用靠人工验收）

```js
// src/plugins/team-tools/bug-patrol/side-review.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewSideWithTimeout } from './side-review.js';

test('reviewSideWithTimeout：正常返回原样透传', async () => {
  const r = await reviewSideWithTimeout({}, {}, {
    review: async () => ({ side: 'backend', evidence: 'e', advice: 'a' }),
    timeoutMs: 1000,
  });
  assert.equal(r.side, 'backend');
});

test('reviewSideWithTimeout：超时 → unknown（不中断整轮）', async () => {
  const r = await reviewSideWithTimeout({}, {}, {
    review: () => new Promise((res) => setTimeout(() => res({ side: 'backend' }), 200)),
    timeoutMs: 20,
  });
  assert.equal(r.side, 'unknown');
  assert.match(r.evidence, /超时/);
});

test('reviewSideWithTimeout：调用抛错 → unknown（无人值守链路绝不向上抛）', async () => {
  const r = await reviewSideWithTimeout({}, {}, {
    review: async () => { throw new Error('网络炸了'); },
    timeoutMs: 1000,
  });
  assert.equal(r.side, 'unknown');
  assert.match(r.evidence, /网络炸了/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/plugins/team-tools/bug-patrol/side-review.test.js
```
预期：`Cannot find module './side-review.js'`

- [ ] **Step 3: 实现**

```js
// src/plugins/team-tools/bug-patrol/side-review.js
/**
 * 前后端归属判定 —— 独立于 reviewTask 的第二次只读 Claude 调用。
 * 为什么不并进 reviewTask：那个文件已两轮过审保持稳定，且判决矩阵是共享资源
 * （feedback / task-triage 都在用），为巡检一条支线改它不划算。
 */
import { runClaude } from '../../../integrations/claude.js';
import { claudeAuthOpts } from '../../../capabilities/token-rotation.js';
import { logger } from '../../../shared/logger.js';
import { buildSidePrompt, parseSideJson } from './side-review.logic.js';

/** 单条判定超时（对齐 req-inspect.js 的 REVIEW_TIMEOUT_MS） */
export const SIDE_TIMEOUT_MS = 5 * 60_000;

/** 真实调用：只读闸与 reviewTask 同款（dontAsk + allowedTools 才构成限制，缺一不可） */
async function callSideReview(record, { frontendDir, backendDir }) {
  let out = '';
  await runClaude(buildSidePrompt(record, { frontendDir, backendDir }), {
    ...claudeAuthOpts(),
    cwd: frontendDir,
    additionalDirectories: backendDir ? [backendDir] : undefined,
    permissionMode: 'dontAsk',
    allowedTools: ['Read', 'Grep', 'Glob'],
    persistSession: false,
    onText: (t) => (out += t),
    onResult: (i) => {
      if (i.result) out = i.result;
    },
  });
  return parseSideJson(out);
}

/**
 * 带超时与异常兜底的归属判定。两种失败都落 unknown：
 * unknown 会按前端自动修（改在任务分支上，人工 review 前进不了主干），
 * 比中断整轮或误判成 backend 打扰同事都更可接受。
 * @param {{review?:Function, timeoutMs?:number}} opts 供测试注入
 */
export async function reviewSideWithTimeout(record, dirs, opts = {}) {
  const { review = callSideReview, timeoutMs = SIDE_TIMEOUT_MS } = opts;
  let timer;
  try {
    const TIMEOUT = Symbol('timeout');
    const r = await Promise.race([
      review(record, dirs),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      }),
    ]);
    if (r === TIMEOUT) {
      logger.warn('bug-patrol', '归属判定超时，按 unknown 处理', { title: record?.title });
      return { side: 'unknown', evidence: '归属判定超时', advice: '' };
    }
    return r;
  } catch (e) {
    const msg = (e?.message || String(e)).slice(0, 200);
    logger.warn('bug-patrol', '归属判定失败，按 unknown 处理', { err: msg });
    return { side: 'unknown', evidence: `归属判定失败：${msg}`, advice: '' };
  } finally {
    // 调用先赢时计时器仍会挂到 timeoutMs 后才触发，不清会拖住进程退出
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/plugins/team-tools/bug-patrol/side-review.test.js
```
预期：3 tests pass

---

## Task 5: 轮次结算与汇报纯函数

**Files:**
- Create: `src/plugins/team-tools/bug-patrol/loop.logic.js`
- Test: `src/plugins/team-tools/bug-patrol/loop.logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
// src/plugins/team-tools/bug-patrol/loop.logic.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TICK_MS, STANDBY_MS, QUOTA_HOLD_MS,
  pickRetryable, allSettled, isExpired, hasAnything, isQuotaError,
  buildRoundReport, formatDuration,
} from './loop.logic.js';

test('isSettled：done 与 analyzed 都是终态（auto-dev 失败退回 analyzed，没有 failed 态）', () => {
  assert.equal(isSettled({ status: 'done' }), true);
  assert.equal(isSettled({ status: 'analyzed' }), true);
  assert.equal(isSettled({ status: 'queued' }), false);
  assert.equal(isSettled({ status: 'developing' }), false);
  assert.equal(isSettled(null), true);  // 任务被删：当终态，否则泵永远等不到
});

test('allSettled：全终态才算本轮结束', () => {
  const get = (id) => ({ t1: { status: 'done' }, t2: { status: 'queued' } })[id] || null;
  assert.equal(allSettled(['t1'], get), true);
  assert.equal(allSettled(['t1', 't2'], get), false);
  assert.equal(allSettled([], get), true);
});

test('pickRetryable：analyzed 且没重试过的才给重试，done 不重试', () => {
  const get = (id) => ({
    t1: { id: 't1', status: 'analyzed' },
    t2: { id: 't2', status: 'analyzed' },
    t3: { id: 't3', status: 'done' },
  })[id] || null;
  assert.deepEqual(pickRetryable(['t1', 't2', 't3'], get, { t2: true }), ['t1']);
});

test('isExpired：超过 12 小时判到期', () => {
  const now = 1_000_000_000;
  assert.equal(isExpired(now - MAX_LIFETIME_MS - 1, now), true);
  assert.equal(isExpired(now - 1000, now), false);
  assert.equal(isExpired(0, now), false);  // startedAt=0 视为未启动，不判到期
});

test('isQuotaError：识别额度类错误（挂起而非 20 分钟后空转重试）', () => {
  assert.equal(isQuotaError('rate limit exceeded'), true);
  assert.equal(isQuotaError('额度已耗尽'), true);
  assert.equal(isQuotaError('usage limit reached'), true);
  assert.equal(isQuotaError('quota exceeded'), true);
  assert.equal(isQuotaError('ECONNRESET'), false);
  assert.equal(isQuotaError(''), false);
  assert.equal(isQuotaError(null), false);
});

test('hasAnything：四类全空才算无事发生（空报抑制的判据）', () => {
  const empty = { fixed: [], handoff: [], failed: [], unknown: [] };
  assert.equal(hasAnything(empty), false);
  assert.equal(hasAnything({ ...empty, fixed: [{ title: 'x' }] }), true);
  assert.equal(hasAnything({ ...empty, handoff: [{ title: 'x' }] }), true);
  assert.equal(hasAnything({ ...empty, unknown: [{ title: 'x' }] }), true);
  assert.equal(hasAnything(null), false);
});

test('formatDuration：毫秒 → 人读时长', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(90 * 60_000), '1h30m');
  assert.equal(formatDuration(20 * 60_000), '20m');
});

test('buildRoundReport：轮次汇报带需求名与 @，四类分别成段', () => {
  const s = buildRoundReport({
    kind: 'round',
    atSelf: '<at user_id="ou_me"></at> ',
    reqTitle: '订单中心改版',
    elapsedMs: 3 * 3600_000 + 20 * 60_000,
    roundNo: 2,
    report: {
      fixed: [{ title: '导出无响应', branch: 'task/t_a' }],
      handoff: [{ title: '分页错乱', to: '<at user_id="ou_be"></at> ', advice: 'count 语句有问题' }],
      failed: [{ title: '崩溃', reason: '无代码改动' }],
      unknown: [{ title: '样式抖动', branch: 'task/t_b' }],
    },
  });
  assert.match(s, /<at user_id="ou_me"><\/at>/);
  assert.match(s, /【订单中心改版】/);
  assert.match(s, /3h20m/);
  assert.match(s, /已修复待你 review 并提交（1 条）/);
  assert.match(s, /task\/t_a/);
  assert.match(s, /已转后端/);
  assert.match(s, /count 语句有问题/);
  assert.match(s, /归属判不准，已按前端修（1 条）/);
  assert.match(s, /修复失败（1 条，已重试一次）/);
});

test('buildRoundReport：无需求名时不出现方括号标题', () => {
  const s = buildRoundReport({
    kind: 'round', atSelf: '', reqTitle: null, elapsedMs: 60_000, roundNo: 1,
    report: { fixed: [{ title: 'x', branch: 'b' }], handoff: [], failed: [], unknown: [] },
  });
  assert.doesNotMatch(s, /【/);
});

test('buildRoundReport：final 类型首行不同，且空 report 也给一句话', () => {
  const s = buildRoundReport({
    kind: 'final', atSelf: '', reqTitle: '需求A', elapsedMs: 60_000, roundNo: 5,
    reason: '手动停止',
    report: { fixed: [], handoff: [], failed: [], unknown: [] },
  });
  assert.match(s, /巡检已停止/);
  assert.match(s, /手动停止/);
  assert.match(s, /共跑 5 轮/);
  assert.match(s, /本轮无新增问题/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/plugins/team-tools/bug-patrol/loop.logic.test.js
```
预期：`Cannot find module './loop.logic.js'`

- [ ] **Step 3: 实现**

```js
// src/plugins/team-tools/bug-patrol/loop.logic.js
/**
 * 巡检循环的纯判定与文案层（零 IO，单测目标）。
 * 泵本体（loop.js）全是落盘 + 网络 + Claude 调用，没法直测，判据一律抽到这里。
 */

export const TICK_MS = 30_000;              // 泵 tick 间隔
export const STANDBY_MS = 20 * 60_000;      // 待命 20 分钟后复查
export const MAX_LIFETIME_MS = 12 * 3600_000; // 循环 12 小时上限
export const QUOTA_HOLD_MS = 30 * 60_000;   // 额度耗尽后的挂起时长（比常规待命更长，等 token 重置）

/**
 * 是否额度类错误。额度耗尽时 20 分钟后重试只会再撞一次墙，白烧一轮调用，
 * 所以挂起 QUOTA_HOLD_MS 并告警一次（spec §9「循环挂起不空转」）。
 */
export function isQuotaError(msg) {
  return /rate.?limit|quota|usage limit|额度|超出限制/i.test(String(msg || ''));
}

/**
 * 任务是否已终结。
 * **关键契约**：auto-dev 失败时状态退回 'analyzed'（见 auto-dev/index.js 的 7 处失败分支），
 * 并没有 failed 状态。只认 done 会让泵永远等一个到不了的终态，循环卡死在 scanning。
 * 任务查不到（被人工删了）也当终态，同理防卡死。
 */
export function isSettled(task) {
  if (!task) return true;
  return task.status === 'done' || task.status === 'analyzed';
}

/** 本轮任务是否全部终结 */
export function allSettled(taskIds, getTaskById) {
  return (Array.isArray(taskIds) ? taskIds : []).every((id) => isSettled(getTaskById(id)));
}

/** 挑出可以重试一次的任务：退回 analyzed 且本轮还没重试过（拍板：只重试一次） */
export function pickRetryable(taskIds, getTaskById, retried = {}) {
  return (Array.isArray(taskIds) ? taskIds : []).filter((id) => {
    const t = getTaskById(id);
    return t && t.status === 'analyzed' && !retried[id];
  });
}

/** 是否超过 12 小时上限。startedAt=0 视为未启动，不判到期 */
export function isExpired(startedAt, now = Date.now()) {
  if (!startedAt) return false;
  return now - startedAt > MAX_LIFETIME_MS;
}

/** 本轮是否真的处理过东西（空报抑制的判据：四类全空就不打扰人） */
export function hasAnything(report) {
  if (!report || typeof report !== 'object') return false;
  return ['fixed', 'handoff', 'failed', 'unknown'].some((k) => (report[k] || []).length > 0);
}

/** 毫秒 → 人读时长（3h20m / 45m） */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h${m}m` : `${m}m`;
}

/**
 * 汇报文案。
 * @param {object} p
 * @param {'round'|'final'} p.kind round=轮次汇报（受空报抑制）；final=最终汇报（无论空否都发）
 * @param {string} p.atSelf 已拼好的 @ 前缀（群聊为 <at> 标签，私聊为空串）
 * @param {string|null} p.reqTitle 关联需求名，空则不显示
 * @param {string} [p.reason] final 专用：停止原因
 */
export function buildRoundReport({ kind, atSelf = '', reqTitle, elapsedMs, roundNo, report, reason }) {
  const tag = reqTitle ? `【${reqTitle}】` : '';
  const dur = formatDuration(elapsedMs);
  const head =
    kind === 'final'
      ? `${atSelf}${tag}巡检已停止（${reason || '已满 12 小时'}），共跑 ${roundNo} 轮，累计 ${dur}`
      : `${atSelf}${tag}本轮处理完毕，已进入待命（下次扫描 20 分钟后，累计已跑 ${dur}）`;

  const r = report || {};
  const lines = [head];
  const section = (title, items, render) => {
    if (!items?.length) return;
    lines.push('');
    lines.push(title(items.length));
    items.forEach((it, i) => lines.push(`  ${i + 1}. ${render(it)}`));
  };

  section(
    (n) => `🔧 已修复待你 review 并提交（${n} 条）`,
    r.fixed,
    (it) => `${it.title}  → 分支 ${it.branch || '（未知）'}`,
  );
  section(
    (n) => `📮 已转后端（${n} 条）`,
    r.handoff,
    (it) => `${it.to || ''}${it.title} —— ${it.advice || '（无建议）'}${it.demoted ? '［名册未配 open_id，仅移除了你］' : ''}`,
  );
  section(
    (n) => `❓ 归属判不准，已按前端修（${n} 条）`,
    r.unknown,
    (it) => `${it.title}  → 分支 ${it.branch || '（未知）'}`,
  );
  section(
    (n) => `⚠️ 修复失败（${n} 条，已重试一次）`,
    r.failed,
    (it) => `${it.title} —— ${it.reason || '未知原因'}`,
  );

  if (lines.length === 1) lines.push('本轮无新增问题。');
  return lines.join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/plugins/team-tools/bug-patrol/loop.logic.test.js
```
预期：10 tests pass

---

## Task 6: 循环泵本体

**Files:**
- Create: `src/plugins/team-tools/bug-patrol/loop.js`
- Modify: `src/plugins/team-tools/bug-patrol/index.js`（抽出 `runPatrolRound` 供泵复用）

- [ ] **Step 1: 从 `index.js` 抽出可复用的单轮扫描**

把 `index.js` 现有的 `runPatrol` 改造成导出的 `runPatrolRound(params)`，签名与行为变化：

```js
// src/plugins/team-tools/bug-patrol/index.js —— 替换原 runPatrol
/**
 * 单轮巡检（供 loop.js 的泵调用；\10001 不再直接调它，改为启动循环）。
 * 与改造前的差异：
 *  1. 多一道 filterUnseen 成本护栏；
 *  2. verdict==='fix' 且关联了需求时，走归属判定分支；
 *  3. 不再自己发汇总——汇总由泵在「本轮任务全终结」后统一发。
 * @returns {{ mine:number, skippedTables:Array }} 供泵记日志；处理结果直接写进 store 的 report
 */
export async function runPatrolRound({ appToken, tableId, url, openId, chatId, chatType, reqId }) {
  const summary = { mine: 0, skippedTables: [] };
  const loop = readLoop();
  const req = reqId ? getRequirement(reqId) : null;
  const frontendDir = req?.projects?.frontend?.dir || null;
  const backendDir = req?.projects?.backend?.dir || null;

  const tables = tableId ? [{ tableId, name: '' }] : await listBitableTables(appToken);
  for (const t of tables) {
    const tableLabel = t.name || t.tableId;
    let fields;
    try {
      fields = await listBitableFields(appToken, t.tableId);
    } catch (e) {
      summary.skippedTables.push({ name: tableLabel, reason: `读取字段失败：${e?.message || e}` });
      continue;
    }
    const mapping = await mapFields(fields);
    const v = validateFieldMapping(mapping, fields);
    if (!v.ok) {
      summary.skippedTables.push({ name: tableLabel, reason: v.error });
      continue;
    }
    let records;
    try {
      records = await searchBitableRecords(appToken, t.tableId, {
        filter: buildStatusFilter(v.statusField, v.pendingValue),
      });
    } catch (e) {
      summary.skippedTables.push({ name: tableLabel, reason: `查记录失败：${e?.message || e}` });
      continue;
    }
    const mine = filterUnseen(records.filter((r) => isAssignedToMe(r, v.assigneeField, openId)), loop.seen);
    summary.mine += mine.length;

    const titleField = primaryFieldName(fields);
    for (const rec of mine) {
      const title = recordTitle(rec, titleField);
      const detail = buildRecordDetail(rec, { tableName: t.name, url });
      try {
        const r = await reviewTask({ id: 'patrol_' + rec.record_id, type: 'bug', title, detail });
        if (r.verdict !== 'fix') {
          markSeen(rec.record_id, { verdict: r.verdict });
          continue;
        }
        // 关联需求且后端目录齐备才做归属判定；否则一律按前端（现有逻辑）
        let side = 'frontend';
        let advice = '';
        if (reqId && frontendDir && backendDir) {
          const sr = await reviewSideWithTimeout({ title, detail }, { frontendDir, backendDir });
          side = sr.side;
          advice = sr.advice;
        }

        if (side === 'backend') {
          await handoffToBackend({
            appToken, tableId: t.tableId, record: rec, assigneeField: v.assigneeField,
            openId, req, title, advice,
          });
          markSeen(rec.record_id, { verdict: 'fix', side: 'backend' });
          continue;
        }

        // frontend / unknown：写「修复中」+ 建任务 + 入队（先写表再建任务，理由见原注释）
        await updateBitableRecord(appToken, t.tableId, rec.record_id, { [v.statusField]: v.fixingValue });
        const task = createTask({
          type: 'bug', title: title.slice(0, 40), detail,
          source: { openId, via: 'feishu', chatId, chatType },
        });
        requestAutoDevelop(task.id, 'BUG 巡检确认，自动修复');
        pushCycleTask(task.id);
        markSeen(rec.record_id, { verdict: 'fix', side });
        pushReport(side === 'unknown' ? 'unknown' : 'fixed', { title, taskId: task.id, branch: '' });
      } catch (e) {
        const reason = (e?.message || String(e)).slice(0, 120);
        markSeen(rec.record_id, { verdict: 'error' });
        pushReport('failed', { title, reason });
        logger.error('bug-patrol', '单条记录处理失败', { recordId: rec.record_id, err: reason });
      }
    }
  }
  return summary;
}

/** 转派后端：人员字段移除我 + 加后端（状态字段刻意不动，表结构不一定有对应选项） */
async function handoffToBackend({ appToken, tableId, record, assigneeField, openId, req, title, advice }) {
  const backend = resolveBackendOpenId({
    assignees: req?.assignees || [],
    colleagues: getColleagues(),
  });
  const next = buildAssigneePatch(record?.fields?.[assigneeField], openId, backend?.openId || null);
  await updateBitableRecord(appToken, tableId, record.record_id, { [assigneeField]: next });
  const loop = readLoop();
  pushReport('handoff', {
    title,
    to: backend ? atPrefix(backend.openId, loop.chatType) || `@${backend.name}（后端） ` : '',
    advice,
    demoted: !backend,
  });
  logger.info('bug-patrol', '记录转派后端', { recordId: record.record_id, to: backend?.name || '(未配置)' });
}
```

同时在 `index.js` 顶部补齐 import：

```js
import { readLoop, markSeen, pushCycleTask, pushReport } from '../../../store/patrol-loop.js';
import { getRequirement } from '../../../store/requirements.js';
import { getColleagues } from '../../../store/colleagues.js';
import { atPrefix } from '../../../shared/mention.js';
import { reviewSideWithTimeout } from './side-review.js';
import { resolveBackendOpenId, buildAssigneePatch } from './side-review.logic.js';
import { filterUnseen, buildStartReply, buildReqChoicePrompt, parseReqChoice } from './logic.js';
```

- [ ] **Step 2: 写泵**

```js
// src/plugins/team-tools/bug-patrol/loop.js
/**
 * BUG 巡检循环泵 —— **仅 web 进程**常驻（与 auto-dev 泵同进程）。
 *
 * 为什么必须在 web 进程：判「本轮问题是否全修完」要读任务终态，而 auto-dev 执行泵只在
 * web 进程跑。放 feishu 进程就得跨进程轮询 tasks.json，多一层无谓的竞争。
 * 飞书进程只负责收 \10001/\10004 指令并跨进程 POST 过来。
 *
 * 状态机：scanning（扫 + 等修完）→ standby（待命 20min）→ scanning → …
 * 出口两个：\10004（stopping，等已入队跑完）、12 小时到期。
 */
import { getTask } from '../../../store/tasks.js';
import { getRequirement } from '../../../store/requirements.js';
import { readLoop, updateLoop, clearLoop, markRetried } from '../../../store/patrol-loop.js';
import { requestAutoDevelop } from '../auto-dev/queue.js';
import { sendText } from '../../../integrations/lark.js';
import { atPrefix } from '../../../shared/mention.js';
import { logger } from '../../../shared/logger.js';
import { runPatrolRound } from './index.js';
import {
  TICK_MS, STANDBY_MS,
  allSettled, pickRetryable, isExpired, hasAnything, buildRoundReport,
} from './loop.logic.js';

let pumpTimer = null;
let busy = false;

/** 仅 principal-web 进程调用（对齐 startAutoDevPump 范式） */
export function startPatrolLoopPump() {
  if (pumpTimer) return;
  pumpTimer = setInterval(() => {
    tick().catch((e) => logger.error('bug-patrol', 'loop pump 异常', { err: e?.message || String(e) }));
  }, TICK_MS);
  pumpTimer.unref(); // 与 auto-dev/requirement 泵一致：别拖住测试进程退出
  logger.info('bug-patrol', '巡检循环泵已启动');
}

async function tick() {
  if (busy) return;
  const loop = readLoop();
  if (!loop.active) return;

  busy = true;
  try {
    // 12 小时到期：无论处于哪个 phase 都收尾（stopping 也走这里的终报路径）
    if (isExpired(loop.startedAt)) return void (await finish(loop, '已满 12 小时'));

    if (loop.phase === 'scanning') return void (await settleRound(loop));
    if (loop.phase === 'standby') {
      if (loop.stopping) return void (await finish(loop, '手动停止'));
      if (Date.now() >= loop.nextRunAt) await startRound(loop);
    }
  } finally {
    busy = false;
  }
}

/** scanning：本轮任务是否全终结；失败的给一次重试；全完了就结算 */
async function settleRound(loop) {
  const retryable = pickRetryable(loop.cycleTaskIds, getTask, loop.retried);
  for (const id of retryable) {
    markRetried(id);
    requestAutoDevelop(id, 'BUG 巡检自动重试');
    logger.info('bug-patrol', '修复失败，自动重试一次', { taskId: id });
  }
  if (retryable.length) return; // 重试刚入队，下个 tick 再看

  if (!allSettled(loop.cycleTaskIds, getTask)) return;

  // 全终结：按任务终态一次性分流回填。
  // 入队那一刻拿不到分支名，也不知道最终成败（重试一次后才见分晓），所以 fixed/unknown
  // 在这里重建：done 的补分支名留在原类，analyzed（失败）的移进 failed。
  // failed 以 runPatrolRound 里 catch 记下的那批为基线，不能丢。
  const cur = readLoop();
  const report = { ...cur.report, fixed: [], unknown: [], failed: [...cur.report.failed] };
  for (const kind of ['fixed', 'unknown']) {
    for (const it of cur.report[kind]) {
      const t = it.taskId ? getTask(it.taskId) : null;
      if (t?.status === 'done') report[kind].push({ ...it, branch: t.branch || '' });
      else report.failed.push({ title: it.title, reason: t ? lastFailReason(t) : '任务记录已丢失' });
    }
  }

  if (cur.stopping) return void (await finish({ ...cur, report }, '手动停止'));

  if (hasAnything(report)) await report_(cur, report, 'round');
  updateLoop({
    phase: 'standby',
    nextRunAt: Date.now() + STANDBY_MS,
    cycleTaskIds: [],
    retried: {},
    report: { fixed: [], handoff: [], failed: [], unknown: [] },
  });
  logger.info('bug-patrol', '本轮结算完成，进入待命', { roundNo: cur.roundNo });
}

/** 从任务 history 里取最后一条失败原因（auto-dev 把原因写在 history 事件里） */
function lastFailReason(task) {
  const h = (task?.history || []).filter((e) => /自动开发失败|异常/.test(e.event || ''));
  return h.length ? h[h.length - 1].event : '自动开发失败';
}

/** standby → scanning：跑新一轮 */
async function startRound(loop) {
  const roundNo = loop.roundNo + 1;
  updateLoop({ phase: 'scanning', roundNo, cycleTaskIds: [], retried: {} });
  logger.info('bug-patrol', '开始新一轮巡检', { roundNo });
  try {
    await runPatrolRound({
      appToken: loop.appToken, tableId: loop.tableId, url: loop.url,
      openId: loop.openId, chatId: loop.chatId, chatType: loop.chatType, reqId: loop.reqId,
    });
  } catch (e) {
    const msg = (e?.message || String(e)).slice(0, 200);
    logger.error('bug-patrol', '巡检轮次失败', { roundNo, err: msg });
    // 额度耗尽单独处理：20 分钟后重试只会再撞一次墙，挂起更久等 token 重置
    const quota = isQuotaError(msg);
    const holdMs = quota ? QUOTA_HOLD_MS : STANDBY_MS;
    await say(
      loop,
      quota
        ? `⚠️ 额度已耗尽，巡检暂停 ${formatDuration(QUOTA_HOLD_MS)} 后自动重试（12 小时总时长照常计算）。`
        : `⚠️ 第 ${roundNo} 轮巡检失败：${msg}\n循环继续，${formatDuration(STANDBY_MS)} 后重试。`,
    );
    updateLoop({ phase: 'standby', nextRunAt: Date.now() + holdMs });
  }
}

/** 收尾：发最终汇报（无论 report 空否）并清空状态 */
async function finish(loop, reason) {
  await report_(loop, loop.report, 'final', reason);
  clearLoop();
  logger.info('bug-patrol', '巡检循环结束', { reason, roundNo: loop.roundNo });
}

async function report_(loop, report, kind, reason) {
  const req = loop.reqId ? getRequirement(loop.reqId) : null;
  const text = buildRoundReport({
    kind,
    atSelf: atPrefix(loop.openId, loop.chatType),
    reqTitle: req?.title || null,
    elapsedMs: Date.now() - loop.startedAt,
    roundNo: loop.roundNo,
    report,
    reason,
  });
  await say(loop, text);
}

/** 发送失败绝不能中断循环（对齐 conv-notify 的 fire-and-forget 纪律） */
async function say(loop, text) {
  try {
    await sendText(loop.chatId, text);
  } catch (e) {
    logger.error('bug-patrol', '汇报发送失败', { err: e?.message || String(e) });
  }
}
```

- [ ] **Step 3: 跑全量测试确认没打破既有用例**

```bash
npm test
```
预期：原有用例全绿 + 本计划新增用例全绿

---

## Task 7: web 路由与泵接线

**Files:**
- Create: `src/entrypoints/web/routes-patrol.js`
- Modify: `src/entrypoints/web/server.js`

- [ ] **Step 1: 写路由**

```js
// src/entrypoints/web/routes-patrol.js
/**
 * 巡检循环 HTTP 接口（单入口子路由范式，对齐 routes-memory.js）。
 * 只服务飞书进程的跨进程调用——循环泵在 web 进程，指令在 feishu 进程收。
 */
import { sendJson } from './http-util.js';
import { withJsonBody } from './body.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';
import { readLoop, updateLoop, DEFAULT_LOOP } from '../../store/patrol-loop.js';

// ==== POST /api/patrol/start ====
function handleStart(req, res) {
  return withJsonBody(req, res, (d) => {
    const cur = readLoop();
    // 单例：auto-dev 只有一个常驻工作区，两个循环会抢同一个任务分支
    if (cur.active) {
      return sendJson(res, 409, {
        ok: false,
        error: '已有巡检在跑',
        startedAt: cur.startedAt,
        openId: cur.openId,
      });
    }
    const appToken = str(d.appToken);
    const chatId = str(d.chatId);
    const openId = str(d.openId);
    if (!appToken || !chatId || !openId) {
      return sendJson(res, 400, { ok: false, error: 'appToken / chatId / openId 不能为空' });
    }
    updateLoop({
      ...DEFAULT_LOOP,
      active: true,
      openId, chatId,
      chatType: str(d.chatType),
      appToken,
      tableId: str(d.tableId) || null,
      url: str(d.url),
      reqId: str(d.reqId) || null,
      startedAt: Date.now(),
      phase: 'standby',
      nextRunAt: 0,   // 立即开跑第一轮（下个 tick 就命中）
      roundNo: 0,
    });
    logger.info('bug-patrol', '循环已启动', { openId, reqId: str(d.reqId) || null });
    sendJson(res, 200, { ok: true });
  });
}

// ==== POST /api/patrol/stop ====
function handleStop(req, res) {
  return withJsonBody(req, res, () => {
    const cur = readLoop();
    if (!cur.active) return sendJson(res, 200, { ok: true, wasActive: false });
    // 只置 stopping：已入队的修复要跑完（半途截断会留下未提交的工作区改动）
    updateLoop({ stopping: true });
    logger.info('bug-patrol', '收到停止指令，等已入队任务跑完', { roundNo: cur.roundNo });
    sendJson(res, 200, { ok: true, wasActive: true, phase: cur.phase });
  });
}

/** 单入口：未命中返回 false 交回 server.js 继续匹配 */
export function handlePatrolRoutes(req, res, url) {
  const p = url.pathname;
  if (p === '/api/patrol/start' && req.method === 'POST') return handleStart(req, res), true;
  if (p === '/api/patrol/stop' && req.method === 'POST') return handleStop(req, res), true;
  return false;
}
```

- [ ] **Step 2: 接线 `server.js`**

在 import 区加：

```js
import { handlePatrolRoutes } from './routes-patrol.js';
import { startPatrolLoopPump } from '../../plugins/team-tools/bug-patrol/loop.js';
```

在 `ROUTES` 数组里加（放在 `/api/` 其它前缀条目之间即可，`/api/patrol/` 不与任何现有路径重叠）：

```js
  { prefix: '/api/patrol/', h: (req, res, url) => handlePatrolRoutes(req, res, url) },
```

在 listen 回调里（`startConvNotify()` 那一行下面）加：

```js
    startPatrolLoopPump(); // BUG 巡检循环泵：仅 web 进程（需读 auto-dev 任务终态判「全修完」）
```

- [ ] **Step 3: 启动自检确认没有路由遮蔽**

```bash
npm start
```
预期：启动日志里出现「巡检循环泵已启动」，且**没有** `findShadowedRoutes` 的遮蔽告警。确认后 Ctrl-C 停掉。

---

## Task 8: `\10004` 停止巡检 feature

**Files:**
- Create: `src/plugins/team-tools/stop-patrol/logic.js`
- Create: `src/plugins/team-tools/stop-patrol/index.js`
- Create: `src/plugins/team-tools/stop-patrol/logic.test.js`
- Modify: `src/plugins/team-tools/index.js`

- [ ] **Step 1: 写失败测试**

```js
// src/plugins/team-tools/stop-patrol/logic.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOP_TRIGGERS } from './logic.js';
import { matchesExactTrigger } from '../trusted-trigger.js';

test('STOP_TRIGGERS 是触发文案的回归锚点（改动必须是有意的）', () => {
  assert.deepEqual(STOP_TRIGGERS, ['\\10004 停止巡检']);
});

test('全等才命中：前后缀 / 变体一律不触发', () => {
  assert.equal(matchesExactTrigger('\\10004 停止巡检', STOP_TRIGGERS), true);
  assert.equal(matchesExactTrigger('  \\10004 停止巡检  ', STOP_TRIGGERS), true); // 仅去首尾空白
  assert.equal(matchesExactTrigger('\\10004 停止巡检吧', STOP_TRIGGERS), false);
  assert.equal(matchesExactTrigger('停止巡检', STOP_TRIGGERS), false);
  assert.equal(matchesExactTrigger('', STOP_TRIGGERS), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/plugins/team-tools/stop-patrol/logic.test.js
```
预期：`Cannot find module './logic.js'`

- [ ] **Step 3: 实现**

```js
// src/plugins/team-tools/stop-patrol/logic.js
/**
 * \10004 触发文案（全等匹配，零 LLM —— 沿用可信提交人指令的铁律）。
 * 与 \10001 不同，这里不做「带后缀的变体兼容」：停止是个明确动作，宁可不触发也不要误触发。
 */
export const STOP_TRIGGERS = ['\\10004 停止巡检'];
```

```js
// src/plugins/team-tools/stop-patrol/index.js
/**
 * feature: 停止 BUG 巡检（\10004，可信提交人专属）。
 * 循环状态在 web 进程，这里只跨进程下发停止指令（沿用 create-session 的 postToWeb 范式）。
 *
 * order 15 —— 必须 < claude-exec(20) 才能抢在「owner 全接」之前；排在 status-report(14)
 * 之后、feishu-relay(16) 之前，与其它可信人指令挨在一起。
 */
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';
import { getMyFeishuOpenId } from '../../../store/settings.js';
import { resolveTrustedOpenIds, isTrustedSubmitter } from '../../../shared/trusted-ids.js';
import { matchesExactTrigger } from '../trusted-trigger.js';
import { STOP_TRIGGERS } from './logic.js';

const TIMEOUT_MS = 3000; // 与 create-session / feishu-relay 的跨进程调用一致

async function postStop() {
  const url = `http://127.0.0.1:${config.web.port}/api/patrol/stop`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) return { ok: false, error: data.error || `执行台返回 ${r.status}` };
    return { ok: true, wasActive: data.wasActive };
  } catch (e) {
    logger.warn('stop-patrol', '调用 web 路由失败', { err: e?.message || String(e) });
    return { ok: false, error: '执行台未运行或无响应，稍后再试' };
  }
}

function isTrusted(ctx) {
  return isTrustedSubmitter(ctx, resolveTrustedOpenIds(getMyFeishuOpenId()));
}

export default {
  name: 'stop-patrol',
  permission: 'any', // 门禁藏在 match 里：非可信人发同样文案不命中，不暴露功能存在
  intents: [],
  match: (ctx) => matchesExactTrigger(ctx.text, STOP_TRIGGERS) && isTrusted(ctx),
  handle: async (ctx) => {
    const r = await postStop();
    if (!r.ok) return ctx.reply(`⚠️ ${r.error}`);
    if (!r.wasActive) return ctx.reply('当前没有正在运行的巡检。');
    return ctx.reply('好的，已停止巡检。已经在修的问题会跑完，完成后给你一份最终汇报。');
  },
};
```

- [ ] **Step 4: 注册到 team-tools**

在 `src/plugins/team-tools/index.js` 的 features 数组里加一条（放在 status-report 之后）：

```js
import stopPatrol from './stop-patrol/index.js';
// …
    { order: 15, feature: stopPatrol },
```

- [ ] **Step 5: 跑测试确认通过**

```bash
node --test src/plugins/team-tools/stop-patrol/logic.test.js && node --test src/plugins/index.test.js
```
预期：两个文件都 pass（后者验证装配层排序没被打乱）

---

## Task 9: `\10001` 改造为启动循环

**Files:**
- Modify: `src/plugins/team-tools/bug-patrol/index.js`

- [ ] **Step 1: 扩展会话态，支持「选需求」**

把文件顶部的 `sessions` 注释与结构改为：

```js
/**
 * 等待态会话：openId → { expiresAt, stage, link, reqs }
 *   stage='link' 等多维表格链接；stage='req' 等用户选需求序号。
 * 两个 stage 共用同一个 10 分钟 TTL 与同一个「取消」出口。
 */
const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map();
```

- [ ] **Step 2: 实现跨进程启动**

```js
/** 跨进程启动循环（循环泵在 web 进程，见 loop.js 文件头） */
async function postStart(payload) {
  const url = `http://127.0.0.1:${config.web.port}/api/patrol/start`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    const data = await r.json().catch(() => ({}));
    // 单例冲突：告知启动人与时间（spec §9）——否则用户只看到「已有巡检」却不知道是谁开的
    if (r.status === 409) {
      const who = data.openId === payload.openId ? '你' : `另一位可信提交人（${String(data.openId || '').slice(-6)}）`;
      const when = data.startedAt ? new Date(data.startedAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间';
      return { ok: false, error: `已有巡检在运行中（${who}于 ${when} 启动）。先发「\\10004 停止巡检」再重新开始。` };
    }
    if (!r.ok || data.ok === false) return { ok: false, error: data.error || `执行台返回 ${r.status}` };
    return { ok: true };
  } catch (e) {
    logger.warn('bug-patrol', '启动循环失败', { err: e?.message || String(e) });
    return { ok: false, error: '执行台未运行或无响应，稍后再试' };
  }
}

/** 测试期需求（phase==='test'）。0 个 → 不做归属判定；1 个 → 自动关联；多个 → 让用户选 */
function testPhaseRequirements() {
  return getRequirements().filter((r) => r.phase === 'test');
}
```

- [ ] **Step 3: 改写 `handle`**

```js
  handle: async (ctx) => {
    const openId = ctx.user.id;
    const chatId = ctx.meta?.chatId || ctx.sessionKey;
    const chatType = ctx.meta?.chatType || null;

    // A. 触发文案：进入等表状态
    if (matchesExactTrigger(ctx.text, PATROL_TRIGGERS)) {
      sessions.set(openId, { expiresAt: Date.now() + SESSION_TTL_MS, stage: 'link' });
      return ctx.reply('好的～请把要巡检的多维表格链接发我（/base/ 直链或 wiki 链接均可；10 分钟内有效，回复「取消」退出）。');
    }

    const s = sessions.get(openId);
    if (isCancelText(ctx.text)) {
      sessions.delete(openId);
      return ctx.reply('已取消 BUG 巡检。');
    }

    // C. 选需求阶段
    if (s?.stage === 'req') {
      const idx = parseReqChoice(ctx.text, s.reqs.length);
      if (idx === null) return ctx.reply(`没看懂～请回复 1-${s.reqs.length} 之间的序号（回复「取消」退出）。`);
      sessions.delete(openId);
      return launch(ctx, { ...s.link, openId, chatId, chatType }, s.reqs[idx]);
    }

    // B. 等表阶段
    const link = parseBitableLink(ctx.text);
    if (!link) return ctx.reply('没识别出多维表格链接～请发 /base/ 直链或含多维表格的 wiki 链接（回复「取消」退出）。');

    let appToken = link.kind === 'base' ? link.appToken : null;
    if (link.kind === 'wiki') {
      try {
        const node = await resolveWikiNodeObj(link.token);
        if (node?.objType !== 'bitable' || !node.objToken) {
          return ctx.reply('该 wiki 链接不是多维表格～请重新触发巡检并发多维表格链接。');
        }
        appToken = node.objToken;
      } catch (e) {
        return ctx.reply(`读取该 wiki 链接失败：${e?.message || e}${permissionHint(e)}`);
      }
    }

    const resolved = { appToken, tableId: link.tableId, url: link.url };
    const reqs = testPhaseRequirements();
    if (reqs.length > 1) {
      sessions.set(openId, { expiresAt: Date.now() + SESSION_TTL_MS, stage: 'req', link: resolved, reqs });
      return ctx.reply(buildReqChoicePrompt(reqs));
    }
    sessions.delete(openId);
    return launch(ctx, { ...resolved, openId, chatId, chatType }, reqs[0] || null);
  },
};

/** 启动循环并回执（需求名按 §4.1 回显） */
async function launch(ctx, payload, req) {
  const r = await postStart({ ...payload, reqId: req?.id || null });
  if (!r.ok) return ctx.reply(`⚠️ ${r.error}`);
  return ctx.reply(buildStartReply(req?.title || null));
}
```

注意 `hasPending` 保持不变（两个 stage 都靠它劫持），并补 import：

```js
import { getRequirements } from '../../../store/requirements.js';
```

- [ ] **Step 4: 跑全量测试**

```bash
npm test
```
预期：全绿

---

## Task 10: 文档与最终验证

**Files:**
- Modify: `src/plugins/CLAUDE.md`、`src/store/CLAUDE.md`、`src/entrypoints/CLAUDE.md`

- [ ] **Step 1: 更新三份模块地图**

`src/store/CLAUDE.md` 文件清单加：

```markdown
- `patrol-loop.js` — BUG 巡检循环状态（`patrol-loop.json`）：单例，存 active/phase/seen/cycleTaskIds/report。落盘而非内存的理由见文件头（循环最长 12 小时，pm2 重启是常态）。
```

`src/plugins/CLAUDE.md` 的 team-tools 清单加：

```markdown
- `team-tools/bug-patrol/loop.js` — **巡检循环泵**（仅 web 进程，对齐 startAutoDevPump）：scanning → standby(20min) → scanning，12 小时上限。`loop.logic.js` 存终态判定/汇报文案纯函数。
- `team-tools/bug-patrol/side-review.js` — 前后端归属判定（独立只读 Claude 调用，超时落 unknown）。`side-review.logic.js` 存 prompt/解析/后端人选/人员字段补丁纯函数。
- `team-tools/stop-patrol/index.js` — feature「停止巡检」（`\10004`，可信提交人专属，order 15）：跨进程 POST `/api/patrol/stop`。
```

并在「常见改动入口」加：

```markdown
- **要改巡检循环的周期 / 上限 / 汇报文案** → 改 `team-tools/bug-patrol/loop.logic.js`（`STANDBY_MS` / `MAX_LIFETIME_MS` / `buildRoundReport`）；改状态机流转 → `loop.js`。
- **要改前后端归属判定的口径** → 改 `team-tools/bug-patrol/side-review.logic.js#buildSidePrompt`；**不要**改 `review/logic.js`（那是 feedback/task-triage 共用的判决矩阵）。
```

`src/entrypoints/CLAUDE.md` 的 web 路由清单加：

```markdown
- `web/routes-patrol.js` — 巡检循环 HTTP 接口（`/api/patrol/start|stop`，单入口范式）；只服务 feishu 进程的跨进程调用。
```

- [ ] **Step 2: 全量测试**

```bash
npm test
```
预期：全绿。新增测试文件 5 个（`store/patrol-loop.test.js`、`bug-patrol/side-review.logic.test.js`、`bug-patrol/side-review.test.js`、`bug-patrol/loop.logic.test.js`、`stop-patrol/logic.test.js`）+ 扩充 `bug-patrol/logic.test.js`，合计新增约 31 例。

- [ ] **Step 3: 前端模块图自检**（本次无前端改动，但按项目惯例过一遍）

```bash
node --check src/plugins/team-tools/bug-patrol/loop.js && node --check src/plugins/team-tools/bug-patrol/index.js && node --check src/entrypoints/web/routes-patrol.js
```
预期：无输出（语法正确）

---

## 人工验收清单（实现完成后，交维护者执行）

这些无法自动化，必须真机跑：

- [ ] **1. ⚠️ 人员字段写入先验证** —— 手动触发一次 `\10001`，确认转派后端时 `[{id:'ou_xxx'}]` 格式写入成功。这是唯一会改表格数据的新动作，且 `\10001` 当初「单选值写入」的走查项至今未真机验证。**不验证不要开 12 小时无人值守。**
- [ ] **2. 把 `MAX_LIFETIME_MS` 临时改成 20 分钟**跑一轮完整循环，确认 scanning → standby → 再扫 → 汇报的状态机正确，然后改回。
- [ ] **3. 群聊与私聊各触发一次**，确认群里 @ 真实生效、私聊降级文案可读。
- [ ] **4. 测试期需求 0 / 1 / 多个**三种情况各走一次（多个时确认序号选择可用）。
- [ ] **5. `\10004` 在 scanning 中途触发**，确认已入队任务跑完后才发最终汇报。
- [ ] **6. `pm2 restart principal-web`** 后确认循环自动续跑且剩余时长正确。
- [ ] **7. 非可信人**发 `\10004 停止巡检`，确认走常规流程（不暴露功能存在）。

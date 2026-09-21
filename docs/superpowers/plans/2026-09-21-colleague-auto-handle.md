# 后端同事消息自动处理（同事中继四期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⛔ **本仓规则：不做任何 git 提交**（`git add` / `git commit` 一律不执行），改动留工作区，提交时机由维护者掌控。计划里因此没有 Commit 步骤。
>
> ⚠️ **并行会话提醒**：本仓同日有另一会话在改 `src/store/requirements.js` / `src/entrypoints/web/routes-requirements.js` / `public/js/req-view.js`。**每次 Edit 之前重新 Read 目标文件**，绝不 `git checkout` 还原任何文件。

**Goal:** 后端同事在飞书发来的接口文档 / 需前端配合的文字，自动登记、自动新开需求子会话让 Claude 接入，并回同事一句进度与结果。

**Architecture:** 飞书进程在消息归属确定后 fire-and-forget 一个跨进程 POST；web 进程做 LLM 分类（接口文档识别 / 文字是否需处理），命中则登记 API 文档、把 `colleague-dev` 任务送进需求串行闸；泵派发时服务端新建子会话并以 `bypassPermissions` 起 run，收尾时回填 sessionId、标记消息 `handledBy:'ai'`、回飞书简报。前端补「服务端建的子会话本地无 conv 记录」的 hydrate 与 busy 接流的 convId 纠正。

**Tech Stack:** Node ≥20 ESM、`node --test`、既有 `llm-classify`（Haiku 单轮）、`store/index.js` 文件锁原子写、飞书 `sendTextToUser`、前端原生 ES modules（localStorage conv-store）。

**Spec:** `docs/superpowers/specs/2026-09-21-colleague-auto-handle-design.md`

---

## 文件结构

| 文件 | 性质 | 职责 |
|---|---|---|
| `src/store/colleague-messages.js` | 改 | `markHandled`；`applyPendingFlush` / `flushPending` 返回 `ids` |
| `src/entrypoints/web/colleague-auto.logic.js` | 新 | 零 IO 纯函数：扩展名白名单、两个分类 prompt、两个解析、简报截取、子会话 id |
| `src/entrypoints/web/colleague-dev.js` | 新 | 系统任务 `colleague-dev` 执行侧：`replyColleague` / `dispatchColleagueDev` / `buildColleagueDevOnSettle`。**不 import** `requirement-ops.js` 与 `colleague-auto.js`（防环） |
| `src/entrypoints/web/colleague-auto.js` | 新 | 分类编排：`autoHandleMessages`（deps 注入便于单测） |
| `src/entrypoints/web/requirement-ops.js` | 改 | 抽出 `registerApiDoc`；`dispatch` 加 `colleague-dev` 支 |
| `src/entrypoints/web/routes-requirements.js` | 改 | `handleApidocPost` 改调 `registerApiDoc`；新增 `POST /api/req/colleague-messages/auto` |
| `src/plugins/colleague-relay/auto-notify.js` | 新 | 飞书进程跨进程 POST 封装 `notifyAutoHandle` |
| `src/plugins/colleague-relay/feature.js` | 改 | 单需求直归后调 `notifyAutoHandle` |
| `src/plugins/colleague-relay/index.js` | 改 | 选卡 flush 后调 `notifyAutoHandle` |
| `src/entrypoints/feishu/index.js` | 改 | `relayColleagueAttachment` 单需求直归后调 `notifyAutoHandle` |
| `public/js/chat.js` | 改 | `createReqConv` 可选 `id`（幂等） |
| `public/js/req-view.js` | 改 | 会话树点击走 `openSessionConv`（hydrate + 回放） |
| `public/js/req-chat.js` | 改 | 两处 `ensureConvRunAttached` 传 `busy.convId` |

依赖方向（无环）：`routes-requirements → colleague-auto → {colleague-dev, requirement-ops}`；`requirement-ops → colleague-dev`；`colleague-dev → colleague-auto.logic`。

---

### Task 1: store —— `markHandled` 与 `flushPending` 返回 ids

**Files:**
- Modify: `src/store/colleague-messages.js`
- Test: `src/store/colleague-messages.test.js`

- [ ] **Step 1: 写失败测试**

在 `src/store/colleague-messages.test.js` 顶部的解构里加入 `markHandled`，文件末尾追加：

```js
// ---- 四期：AI 自动处理落点 ----

test('markHandled：只改目标条目的 handledBy/handledNote，不动 status，其余条目不变', () => {
  const a = appendMessage('r_h', 'cl_h', { dir: 'in', text: '接口文档', role: 'backend' });
  const b = appendMessage('r_h', 'cl_h', { dir: 'in', text: '另一条', role: 'backend' });
  assert.equal(markHandled('r_h', 'cl_h', a.id, { handledBy: 'ai', handledNote: '已处理 · 接入接口文档' }), true);
  const msgs = getThread('r_h', 'cl_h').messages;
  const ma = msgs.find((m) => m.id === a.id);
  const mb = msgs.find((m) => m.id === b.id);
  assert.equal(ma.handledBy, 'ai');
  assert.equal(ma.handledNote, '已处理 · 接入接口文档');
  assert.equal(ma.status, 'unread', 'status 是「主机看没看过」，AI 处理过主机仍该看到红点');
  assert.equal(mb.handledBy, null, '其余条目不受影响');
});

test('markHandled：未知 id / 未知会话返回 false，不写盘', () => {
  assert.equal(markHandled('r_h', 'cl_h', 'cm_nope', { handledBy: 'ai' }), false);
  assert.equal(markHandled('r_none', 'cl_none', 'cm_x', { handledBy: 'ai' }), false);
  assert.equal(markHandled('_pending', 'cl_h', 'cm_x', { handledBy: 'ai' }), false, '缓冲节不是会话');
});

test('markHandled：handledBy 非法 / 缺省 → 返回 false 且条目不变（不能把已处理改回未处理还报成功）', () => {
  const a = appendMessage('r_h2', 'cl_h2', { dir: 'in', text: 'x' });
  markHandled('r_h2', 'cl_h2', a.id, { handledBy: 'manual', handledNote: '人工' });
  assert.equal(markHandled('r_h2', 'cl_h2', a.id, { handledBy: 'robot' }), false);
  assert.equal(markHandled('r_h2', 'cl_h2', a.id), false, '缺省 options 也拒绝');
  const m = getThread('r_h2', 'cl_h2').messages[0];
  assert.equal(m.handledBy, 'manual');
  assert.equal(m.handledNote, '人工');
});

test('markHandled：handledNote 省略时归空串', () => {
  const a = appendMessage('r_h3', 'cl_h3', { dir: 'in', text: 'x' });
  assert.equal(markHandled('r_h3', 'cl_h3', a.id, { handledBy: 'ai' }), true);
  assert.equal(getThread('r_h3', 'cl_h3').messages[0].handledNote, '');
});

test('markHandled：同一条二次标记是覆盖而非拒绝（失败重试时要能改写 note）', () => {
  const a = appendMessage('r_h4', 'cl_h4', { dir: 'in', text: 'x' });
  markHandled('r_h4', 'cl_h4', a.id, { handledBy: 'ai', handledNote: '处理失败 · T' });
  assert.equal(markHandled('r_h4', 'cl_h4', a.id, { handledBy: 'ai', handledNote: '已处理 · T' }), true);
  assert.equal(getThread('r_h4', 'cl_h4').messages[0].handledNote, '已处理 · T');
});

test('flushPending：返回 {count, ids}，ids 与归入条目一一对应', () => {
  addPending('ou_ids', { id: 'cm_i1', dir: 'in', text: '一' });
  addPending('ou_ids', { id: 'cm_i2', dir: 'in', text: '二' });
  const r = flushPending('ou_ids', 'r_ids', 'cl_ids');
  assert.equal(r.count, 2);
  assert.deepEqual(r.ids, ['cm_i1', 'cm_i2']);
  assert.deepEqual(getThread('r_ids', 'cl_ids').messages.map((m) => m.id), ['cm_i1', 'cm_i2']);
});
```

同时修改既有两个断言（返回值形状变了）：

```js
// 原：const n = flushPending('ou_1', 'r_3', 'cl_z'); assert.equal(n, 2);
const { count: n } = flushPending('ou_1', 'r_3', 'cl_z');
assert.equal(n, 2);
```

```js
// 原：assert.equal(flushPending('ou_none', 'r_3', 'cl_z'), 0);
assert.deepEqual(flushPending('ou_none', 'r_3', 'cl_z'), { count: 0, ids: [] });
```

`applyPendingFlush` 的竞态测试用的是解构 `{ next, count }`，新增 `ids` 字段不影响它，不用改。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/colleague-messages.test.js`
Expected: FAIL —— `markHandled is not a function`；两个 flushPending 用例因返回值形状不同失败。

- [ ] **Step 3: 实现**

`src/store/colleague-messages.js`，在 `const STATUSES = [...]` 旁加共享常量，并让 `normalizeEntry` 改用它：

```js
/** 处理者取值。与 STATUSES 并列：normalizeEntry 归一与 markHandled 守卫共用，两处各写一份会漂移 */
const HANDLED_BY = ['manual', 'ai'];
// normalizeEntry 里：
    handledBy: HANDLED_BY.includes(o.handledBy) ? o.handledBy : null,
```

在 `markRead` 之后加：

```js
/**
 * 标记单条消息已被处理（四期：AI 自动处理的落点）。
 *
 * 只写 handledBy / handledNote，**不动 status**：status 是「主机看没看过」，handledBy 是「谁处理了」，
 * 两个维度独立 —— AI 处理过的消息主机仍该看到红点，知道后端说过话。
 * 未知会话 / 未知 id 不写盘，返回 false。
 * @param {'manual'|'ai'} handledBy 处理者；其它值一律拒绝
 * @returns {boolean} 命中并写盘为 true
 */
export function markHandled(reqId, colleagueId, msgId, { handledBy, handledNote = '' } = {}) {
  if (!reqId || !colleagueId || !msgId || reqId === PENDING_KEY) return false;
  // 非法值不进锁、不写盘：否则「标记已处理」会把条目改回未处理（null）还返回 true，调用方据此误判成功
  if (!HANDLED_BY.includes(handledBy)) return false;
  let hit = false;
  updateJson(FILE, {}, (raw) => {
    const s = isPlainObject(raw) ? raw : {};
    const req = isPlainObject(s[reqId]) ? s[reqId] : null;
    if (!req || !req[colleagueId]) return undefined;
    const t = normalizeThread(req[colleagueId]);
    t.messages = t.messages.map((m) => {
      if (m.id !== msgId) return m;
      hit = true;
      return normalizeEntry({ ...m, handledBy, handledNote }); // 经 normalizeEntry：非法 handledBy 归 null
    });
    if (!hit) return undefined;
    return { ...s, [reqId]: { ...req, [colleagueId]: t } };
  });
  return hit;
}
```

`applyPendingFlush` 的返回值加 `ids`（两处 return）：

```js
  if (!pendingMsgs.length) return { next: undefined, count: 0, ids: [] };
  ...
  return {
    next: { ...s, [reqId]: { ...req, [colleagueId]: t }, [PENDING_KEY]: nextPending },
    count: pendingMsgs.length,
    ids: pendingMsgs.map((m) => m.id), // 四期：调用方据此触发自动处理
  };
```

`applyPendingFlush` 的 JSDoc `@returns` 改为 `{{next: object|undefined, count: number, ids: string[]}}`。

`flushPending` 整体替换：

```js
/**
 * 把缓冲整体归入目标需求并清空。
 * 必须清空：不清的话同事再点一次卡片按钮，同一批消息会被重复归入。
 * @returns {{count: number, ids: string[]}} 归入条数与各条 id（四期自动处理要按 id 逐条判定）
 */
export function flushPending(openId, reqId, colleagueId) {
  if (!openId || !reqId || !colleagueId || reqId === PENDING_KEY) return { count: 0, ids: [] };
  let count = 0;
  let ids = [];
  updateJson(FILE, {}, (raw) => {
    const r = applyPendingFlush(raw, openId, reqId, colleagueId);
    count = r.count;
    ids = r.ids;
    return r.next;
  });
  return { count, ids };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/store/colleague-messages.test.js`
Expected: PASS（全部）

- [ ] **Step 5: 修 flushPending 的唯一调用方**

`src/plugins/colleague-relay/index.js:32` 原 `const n = flushPending(openId, reqId, colleagueId);` 改为：

```js
  const { count: n, ids } = flushPending(openId, reqId, colleagueId);
```

（`ids` 在 Task 7 用到，此处先解构出来。）

Run: `node --test src/plugins/colleague-relay/ && node --check src/plugins/colleague-relay/index.js`
Expected: PASS

---

### Task 2: `colleague-auto.logic.js` 纯函数

**Files:**
- Create: `src/entrypoints/web/colleague-auto.logic.js`
- Test: `src/entrypoints/web/colleague-auto.logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extOf,
  isApiDocCandidate,
  API_DOC_SAMPLE_CHARS,
  buildApiDocClassifyPrompt,
  parseApiDocVerdict,
  buildTextClassifyPrompt,
  parseTextVerdict,
  buildBrief,
  BRIEF_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  buildColleagueDevPrompt,
  newSubConvId,
} from './colleague-auto.logic.js';

test('extOf：取小写扩展名；无扩展名 / 空 / 非字符串归空串', () => {
  assert.equal(extOf('api.MD'), 'md');
  assert.equal(extOf('a.b.yaml'), 'yaml');
  assert.equal(extOf('README'), '');
  assert.equal(extOf(''), '');
  assert.equal(extOf(null), '');
});

test('isApiDocCandidate：只放行能抽出文本的格式', () => {
  for (const ok of ['a.md', 'a.txt', 'a.json', 'a.yaml', 'a.yml', 'a.docx', 'A.DOCX']) assert.equal(isApiDocCandidate(ok), true, ok);
  for (const no of ['a.pdf', 'a.png', 'a.xlsx', 'a', 'a.doc']) assert.equal(isApiDocCandidate(no), false, no);
});

test('buildApiDocClassifyPrompt：含文件名、样本、只输出 JSON 的契约', () => {
  const p = buildApiDocClassifyPrompt({ fileName: 'order-api.md', sample: 'GET /api/orders' });
  assert.match(p, /order-api\.md/);
  assert.match(p, /GET \/api\/orders/);
  assert.match(p, /"isApiDoc"/);
  assert.match(p, /只输出/);
  assert.match(p, /README/);
  assert.match(p, /以内容为准/);
});

test('parseApiDocVerdict：只认字面 true', () => {
  assert.equal(parseApiDocVerdict({ isApiDoc: true }), true);
  assert.equal(parseApiDocVerdict({ isApiDoc: 'true' }), false);
  assert.equal(parseApiDocVerdict({ isApiDoc: false }), false);
  assert.equal(parseApiDocVerdict(null), false);
  assert.equal(parseApiDocVerdict({}), false);
});

test('buildTextClassifyPrompt：含需求标题与原句，要求 needsAction/summary/prompt 三字段', () => {
  const p = buildTextClassifyPrompt({ reqTitle: '订单导出', text: '列表接口加了 status 字段' });
  assert.match(p, /订单导出/);
  assert.match(p, /status 字段/);
  assert.match(p, /"needsAction"/);
  assert.match(p, /"summary"/);
  assert.match(p, /"prompt"/);
  assert.match(p, /只输出/);
  assert.match(p, /原文保留/);
  assert.match(p, /不要换行/);
  assert.match(p, new RegExp(String(SUMMARY_MAX_CHARS)));
});

test('parseTextVerdict：needsAction 为真且 prompt 非空才返回任务，summary 截 30 字且缺省取 prompt 开头', () => {
  const v = parseTextVerdict({ needsAction: true, summary: '加 status 字段', prompt: '后端列表接口新增 status，前端表格加一列' });
  assert.deepEqual(v, { summary: '加 status 字段', prompt: '后端列表接口新增 status，前端表格加一列' });
  const long = parseTextVerdict({ needsAction: true, summary: '一'.repeat(50), prompt: 'p' });
  assert.equal(Array.from(long.summary).length, SUMMARY_MAX_CHARS);
  const noSummary = parseTextVerdict({ needsAction: true, summary: '', prompt: '接口改了字段名 foo→bar，前端同步' });
  assert.equal(noSummary.summary, '接口改了字段名 foo→bar，前端同步'.slice(0, 30));
  const nl = parseTextVerdict({ needsAction: true, summary: '加\n\nstatus  字段', prompt: 'p' });
  assert.equal(nl.summary, '加 status 字段', 'summary 会成为会话标题，内部空白要压平');
});

test('parseTextVerdict：不需要 / prompt 空 / 脏输入一律 null', () => {
  assert.equal(parseTextVerdict({ needsAction: false, summary: 'x', prompt: 'y' }), null);
  assert.equal(parseTextVerdict({ needsAction: true, summary: 'x', prompt: '   ' }), null, '没有任务描述的 run 只会让 Claude 反问');
  assert.equal(parseTextVerdict({ needsAction: 'true', prompt: 'y' }), null);
  assert.equal(parseTextVerdict(null), null);
  assert.equal(parseTextVerdict('junk'), null);
  assert.equal(parseTextVerdict([{ needsAction: true, prompt: 'x' }]), null, '数组不是判定对象');
});

test('buildBrief：成功带结果并截断，失败固定文案，空结果不带冒号', () => {
  assert.equal(buildBrief(false, '随便什么'), '接入遇到问题，已转主机处理');
  assert.equal(buildBrief(true, ''), '已处理完成');
  assert.equal(buildBrief(true, '  改了\n\n三个  文件 '), '已处理完成：改了 三个 文件');
  const b = buildBrief(true, 'x'.repeat(BRIEF_MAX_CHARS + 50));
  assert.equal(b, '已处理完成：' + 'x'.repeat(BRIEF_MAX_CHARS) + '…');
  assert.equal(buildBrief(true, 'y'.repeat(BRIEF_MAX_CHARS)), '已处理完成：' + 'y'.repeat(BRIEF_MAX_CHARS), '恰好到上限不加省略号');
  // 必须用星际平面字符（😀 .length===2）：BMP 内的 ✅ 用旧的 slice 也能过，测不出代理对是否被切开
  const emoji = buildBrief(true, '😀'.repeat(BRIEF_MAX_CHARS + 1));
  assert.ok(emoji.endsWith('…'));
  assert.equal(Array.from(emoji).length, Array.from('已处理完成：').length + BRIEF_MAX_CHARS + 1, '按字符截断，不切开 emoji 代理对');
  assert.ok(emoji.isWellFormed(), '不能含孤立的半个代理对（Node ≥20 的 isWellFormed 直接判）');
});

test('newSubConvId：c + 13 位时间戳 + 3 位随机，与前端纯数字 id 不撞', () => {
  assert.match(newSubConvId(1700000000000), /^c1700000000000[a-z0-9]{3}$/);
  assert.notEqual(newSubConvId(1700000000000).slice(0, 14), newSubConvId(1700000000001).slice(0, 14), '不同时间戳前缀不同');
  assert.match(newSubConvId(), /^c\d{13}[a-z0-9]{3}$/);
});

test('API_DOC_SAMPLE_CHARS 是正整数', () => {
  assert.ok(Number.isInteger(API_DOC_SAMPLE_CHARS) && API_DOC_SAMPLE_CHARS > 0);
});

test('buildColleagueDevPrompt：同时带原话与提炼，要求以原话为准', () => {
  const p = buildColleagueDevPrompt({ reqTitle: '订单导出', original: 'status 改成 number', task: '表格列类型同步' });
  assert.match(p, /订单导出/);
  assert.match(p, /status 改成 number/);
  assert.match(p, /表格列类型同步/);
  assert.match(p, /以原话为准/);
  assert.match(p, /只读参考工程禁止修改/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/colleague-auto.logic.test.js`
Expected: FAIL —— `Cannot find module './colleague-auto.logic.js'`

- [ ] **Step 3: 实现**

```js
/**
 * 后端同事消息自动处理的纯逻辑（零 IO）：分类 prompt / 输出解析 / 子会话提示词 / 简报文案 / 子会话 id。
 *
 * 为什么单独成文件：编排层 colleague-auto.js 全是 LLM 与落盘调用，无法直测；
 * 这里的每个函数都是「输入 → 输出」，测试钉住契约后编排层只需接线。
 */

/** 接口文档候选扩展名：本仓能抽出文本的格式。pdf 无抽取能力、图片无意义，都不在列 → 走三期归档。
 *  不导出：外部只该问 isApiDocCandidate，直接暴露集合会诱使调用方自己写第二套判定 */
const API_DOC_EXTS = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'docx']);

/** 喂给分类器的样本长度。接口文档头几千字就足够判定形态，整份喂进去只是烧 token */
export const API_DOC_SAMPLE_CHARS = 4000;

/** 回给同事的简报上限。飞书私聊里一屏能读完的量 */
export const BRIEF_MAX_CHARS = 200;

/** summary 上限。prompt 文案与解析器共用一份，改一处两边同步（兄弟文件 req-quiz.logic 的 QUIZ_MAX 同款做法） */
export const SUMMARY_MAX_CHARS = 30;

/** 按「字符」而非 UTF-16 码元截断：Claude 结果里常见 emoji，从代理对中间切开飞书会渲染成乱码 */
function clipChars(s, n) {
  const chars = Array.from(s);
  return chars.length > n ? { text: chars.slice(0, n).join(''), clipped: true } : { text: s, clipped: false };
}

/** 小写扩展名（不含点）；无扩展名 / 空 / 非字符串归空串 */
export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** 能抽出文本的格式才是接口文档候选；其余走三期归档 */
export function isApiDocCandidate(name) {
  return API_DOC_EXTS.has(extOf(name));
}

/** @param {{fileName: string, sample: string}} p sample 由编排层按 API_DOC_SAMPLE_CHARS 截好再传入 */
export function buildApiDocClassifyPrompt({ fileName, sample }) {
  return (
    `下面是一份文件「${fileName}」的开头部分。判断它是否是**后端接口 / API 文档**。\n\n` +
    `算：文档**主体**是接口定义 —— 请求路径 + 方法 + 参数 / 返回字段（表格或示例），或 OpenAPI / Swagger / Postman 导出。\n` +
    `不算：需求文档、会议纪要、项目 README、部署 / 环境说明、数据库表结构、前端组件文档、mock 数据或配置文件、代码片段。\n` +
    `以内容为准，文件名与发送方身份仅供参考。\n\n` +
    `文件开头：\n「${sample}」\n\n` +
    `只输出一个 JSON 对象，不要代码围栏，不要解释：{"isApiDoc": true} 或 {"isApiDoc": false}`
  );
}

/** 只认字面 true：模型偶尔输出 "true" 字符串，那不是肯定回答 */
export function parseApiDocVerdict(data) {
  return data?.isApiDoc === true;
}

/**
 * @param {{reqTitle: string, text: string}} p
 * 三条硬性要求的由来：产物会经 buildColleagueDevPrompt 喂给在前端仓库里跑的 Claude ——
 * Haiku 看不到前端代码，编出来的「实现方案」只会误导；改写字段名则永远找不回来；
 * 字符串里的裸换行会让 JSON.parse 抛错、整条被静默归「不处理」（llm-classify 的 unparsable 路径）。
 */
export function buildTextClassifyPrompt({ reqTitle, text }) {
  return (
    `这是需求「${reqTitle}」的后端开发同事对前端说的一段话：\n「${text}」\n\n` +
    `判断它是否包含**需要前端修改代码才能配合**的具体信息（接口变更、字段增删改名、返回结构调整、联调时发现的问题等）。\n` +
    `纯沟通、确认、提问、闲聊、「收到」「好的」这类都算不需要。\n\n` +
    `若需要处理，prompt 字段是写给前端开发 AI 的任务描述，硬性要求：\n` +
    `- 原话里出现的接口路径、字段名、类型、枚举值**必须原文保留**，不得改写或省略；\n` +
    `- 只转述后端说了什么、前端需要核对或配合的点；**不要编造**前端的具体文件或实现方案，不确定处写「需在代码中查证」；\n` +
    `- 写成单段，分点用分号。\n\n` +
    `只输出一个 JSON 对象，不要代码围栏，不要解释，**所有字符串值内不要换行**：\n` +
    `{"needsAction": true|false, "summary": "一句话概括这次改动（不超过 ${SUMMARY_MAX_CHARS} 字）", "prompt": "任务描述；不需要则空字符串"}`
  );
}

/**
 * 文字判定 → {summary, prompt} 或 null（不处理）。
 * needsAction 为真但 prompt 空也归 null：没有任务描述的 run 只会让 Claude 反问一句就结束，白烧额度。
 * summary 会成为子会话标题，压平内部空白：模型偶尔在 30 字里塞换行。
 */
export function parseTextVerdict(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.needsAction !== true) return null;
  const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
  if (!prompt) return null;
  const rawSummary = typeof data.summary === 'string' ? data.summary.trim() : '';
  // 回落到 prompt 时同样压平：模型违约带了换行，也不该原样进会话标题
  const summarySrc = (rawSummary || prompt).replace(/\s+/g, ' ').trim();
  return { summary: clipChars(summarySrc, SUMMARY_MAX_CHARS).text, prompt };
}

/** 回同事的简报。成功时压平空白再截断；失败时不透传错误细节（那是主机该看的） */
export function buildBrief(ok, resultText) {
  if (!ok) return '接入遇到问题，已转主机处理';
  const t = String(resultText || '').replace(/\s+/g, ' ').trim();
  if (!t) return '已处理完成';
  const { text, clipped } = clipChars(t, BRIEF_MAX_CHARS);
  return '已处理完成：' + text + (clipped ? '…' : '');
}

/**
 * 子会话真正喂给 Claude 的任务提示词：固定模板**同时**承载后端原话与 Haiku 的提炼。
 * 只给提炼不给原话，Haiku 漏掉或改写的字段名就永远找不回来；Claude 在前端仓库里对照原话查证更稳。
 * 「只读参考工程禁止修改」与 req-logic#buildBugFixPrompt 同一口径。
 */
export function buildColleagueDevPrompt({ reqTitle, original, task }) {
  return (
    `【后端同事沟通 · 需求「${reqTitle}」】\n\n` +
    `后端原话：\n「${original}」\n\n` +
    `提炼出的前端任务：\n${task}\n\n` +
    `请以原话为准核对上面的提炼，在本工程里定位相关调用并完成对应修改；只读参考工程禁止修改。修改后自查。`
  );
}

/**
 * 服务端生成的子会话 id。前端 createReqConv 是 `'c' + Date.now()`（c + 13 位数字），
 * 这里多拖 3 位字母数字，两边天然不撞；openConv 不校验 id 格式。
 * padEnd：Math.random 的 36 进制表示偶尔不足 3 位小数，不补齐会让长度契约偶发失守。
 */
export function newSubConvId(now = Date.now()) {
  return 'c' + now + Math.random().toString(36).slice(2, 5).padEnd(3, '0');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/colleague-auto.logic.test.js`
Expected: PASS（11 条）

---

### Task 3: 抽出 `registerApiDoc`，路由改调

**Files:**
- Modify: `src/entrypoints/web/requirement-ops.js`（在 `setBugStatus` 之后加导出）
- Modify: `src/entrypoints/web/routes-requirements.js:449-481`（`handleApidocPost`）
- Test: `src/entrypoints/web/requirement-ops.test.js`

- [ ] **Step 1: 写失败测试**

`src/entrypoints/web/requirement-ops.test.js` 顶部解构加 `registerApiDoc`，末尾追加：

```js
// ---- registerApiDoc（路由与四期自动处理共用）----

test('registerApiDoc：dev 期同名更新、异名新增，history 留痕', () => {
  const r = createRequirement({ title: 'apidoc 登记' });
  updateRequirement(r.id, { phase: 'dev' });
  const f = path.join(process.env.APP_DATA_DIR, 'order-api.md');
  fs.writeFileSync(f, '# API', 'utf8');

  const a = registerApiDoc(getRequirement(r.id), { name: 'order-api.md', path: f });
  assert.equal(a.ok, true);
  assert.equal(a.action, '新增');
  assert.match(a.doc.id, /^ad_/);

  const b = registerApiDoc(getRequirement(r.id), { name: 'order-api.md', path: f });
  assert.equal(b.action, '更新');
  assert.equal(b.doc.id, a.doc.id, '同名更新保留原 id');

  const after = getRequirement(r.id);
  assert.equal(after.apiDocs.length, 1);
  assert.equal(after.history.at(-1).event, 'API 文档更新：order-api.md');

  // 异名新增
  const f2 = path.join(process.env.APP_DATA_DIR, 'pay-api.md');
  fs.writeFileSync(f2, '# PAY', 'utf8');
  const c = registerApiDoc(getRequirement(r.id), { name: 'pay-api.md', path: f2 });
  assert.equal(c.action, '新增');
  assert.equal(getRequirement(r.id).apiDocs.length, 2);
});

test('registerApiDoc：同一 req 快照连登两份异名文档，两份都在（写盘前现读，不被快照覆盖）', () => {
  const r = createRequirement({ title: 'apidoc 快照' });
  updateRequirement(r.id, { phase: 'dev' });
  const f1 = path.join(process.env.APP_DATA_DIR, 'snap-a.md');
  const f2 = path.join(process.env.APP_DATA_DIR, 'snap-b.md');
  fs.writeFileSync(f1, 'a', 'utf8');
  fs.writeFileSync(f2, 'b', 'utf8');
  const snapshot = getRequirement(r.id); // 模拟自动处理循环里复用的同一个 req
  registerApiDoc(snapshot, { name: 'snap-a.md', path: f1 });
  registerApiDoc(snapshot, { name: ' snap-b.md ', path: f2 }); // 顺带验证 name 会 trim
  const names = getRequirement(r.id).apiDocs.map((d) => d.name).sort();
  assert.deepEqual(names, ['snap-a.md', 'snap-b.md']);
});

test('registerApiDoc：非 dev 期 409、缺参 400、文件不存在 400、需求空 404', () => {
  const r = createRequirement({ title: 'apidoc 守卫' });
  const f = path.join(process.env.APP_DATA_DIR, 'x.md');
  fs.writeFileSync(f, 'x', 'utf8');
  assert.deepEqual(registerApiDoc(getRequirement(r.id), { name: 'x.md', path: f }), { ok: false, status: 409, error: '仅开发期可维护 API 文档' });
  updateRequirement(r.id, { phase: 'dev' });
  assert.equal(registerApiDoc(getRequirement(r.id), { name: '', path: f }).status, 400);
  assert.equal(registerApiDoc(getRequirement(r.id), { name: 'x.md', path: f + '.nope' }).status, 400);
  assert.equal(registerApiDoc(null, { name: 'x.md', path: f }).status, 404);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/requirement-ops.test.js`
Expected: FAIL —— `registerApiDoc is not a function`

- [ ] **Step 3: 实现（requirement-ops.js）**

在 `export function setBugStatus` 之后加：

```js
/**
 * 登记 / 更新一份后端 API 文档（同名即更新，保留原 id）。
 *
 * 路由 handleApidocPost 与四期「同事发来接口文档」自动处理共用 —— 两处各写一份迟早漂移
 *（比如一处校验文件存在、一处不校验，或 history 文案不一致）。
 * @param {object|null} req 需求记录；null 映射为 404。只用它的 id / phase 做守卫，apiDocs 现读盘上最新值
 * @param {{name: string, path: string}} doc name 会 trim（飞书原始文件名不经 str()）
 * @returns {{ok:true, action:'新增'|'更新', doc:object} | {ok:false, status:400|404|409, error:string}}
 */
export function registerApiDoc(req, { name: rawName, path: p }) {
  if (!req) return { ok: false, status: 404, error: '需求不存在' };
  const name = String(rawName ?? '').trim();
  if (req.phase !== 'dev') return { ok: false, status: 409, error: '仅开发期可维护 API 文档' };
  if (!name || !p) return { ok: false, status: 400, error: 'name/path 均必填' };
  if (!fs.existsSync(p)) return { ok: false, status: 400, error: '文件不存在：' + p };

  // apiDocs 以盘上最新为准而不用调用方快照：自动处理会在一个循环里对多条消息复用同一个 req，
  // 拿快照整体覆盖会让同一批的第二份文档把第一份静默冲掉（updateRequirement 是浅合并）
  const apiDocs = (getRequirement(req.id) || req).apiDocs || [];
  const idx = apiDocs.findIndex((d) => d.name === name);
  const now = new Date().toISOString();
  let doc, action, next;
  if (idx >= 0) {
    doc = { ...apiDocs[idx], path: p, updatedAt: now };
    next = apiDocs.map((d, i) => (i === idx ? doc : d));
    action = '更新';
  } else {
    doc = { id: 'ad_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, path: p, updatedAt: now };
    next = [...apiDocs, doc];
    action = '新增';
  }
  updateRequirement(req.id, { apiDocs: next }, `API 文档${action}：${name}`);
  return { ok: true, action, doc };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/requirement-ops.test.js`
Expected: PASS

- [ ] **Step 5: 路由改调（routes-requirements.js）**

先 Read 文件确认 `handleApidocPost` 当前原文（并行会话可能改过），再把 `newApiDocId` 与 `handleApidocPost` 整体替换为：

```js
// ==== POST /api/req/apidoc {id,name,path} / DELETE /api/req/apidoc {id,docId} ====
// 登记逻辑在 requirement-ops#registerApiDoc（与同事消息自动处理共用），路由只做 body 归一与状态码映射
function handleApidocPost(req, res) {
  return withJsonBody(req, res, (data) => {
    const result = registerApiDoc(getRequirement(str(data.id)), { name: str(data.name), path: str(data.path) });
    if (!result.ok) return sendJson(res, result.status, { error: result.error });
    sendJson(res, 202, { ok: true, action: result.action, doc: result.doc });
  });
}
```

在第 4 行的 `requirement-ops.js` import 里加 `registerApiDoc`。`newApiDocId` 函数删除（id 生成已内聚到 `registerApiDoc`）。

Run: `node --check src/entrypoints/web/routes-requirements.js && node --test src/entrypoints/web/routes-requirements.test.js`
Expected: PASS（既有 apidoc 用例覆盖 202/404/409/400 行为不变）

---

### Task 4: `colleague-dev.js` 执行侧 + `dispatch` 加支

**Files:**
- Create: `src/entrypoints/web/colleague-dev.js`
- Modify: `src/entrypoints/web/requirement-ops.js`（`dispatch` 在 `mapregen` 支之后、`develop/api-fix` 废弃支之前加一支；顶部加 import）
- Test: `src/entrypoints/web/colleague-dev.test.js`、`src/entrypoints/web/requirement-ops.test.js`

- [ ] **Step 1: 写失败测试（colleague-dev.test.js）**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'colleague-dev-'));
delete process.env.LARK_APP_ID;
delete process.env.LARK_APP_SECRET;

const { replyColleague, buildColleagueDevOnSettle, dispatchColleagueDev, COLLEAGUE_DEV_KIND } = await import('./colleague-dev.js');
const { createRequirement, updateRequirement, getRequirement } = await import('../../store/requirements.js');
const { addColleague } = await import('../../store/colleagues.js');
const { appendMessage, getThread } = await import('../../store/colleague-messages.js');
const { getRun, finishRun } = await import('../../store/runs.js');

function setupReq() {
  const c = addColleague({ name: '后端小王', role: 'backend', feishuOpenId: 'ou_wang' });
  const r = createRequirement({ title: '订单导出' });
  updateRequirement(r.id, { phase: 'dev', assignees: [c.id], convId: 'c_main' });
  return { c, r: getRequirement(r.id) };
}

test('COLLEAGUE_DEV_KIND 常量', () => {
  assert.equal(COLLEAGUE_DEV_KIND, 'colleague-dev');
});

test('replyColleague：无机器人凭证时返回 false，且不落 out 消息（落了界面会显示一条其实没送达的）', async () => {
  const { c, r } = setupReq();
  const ok = await replyColleague(r.id, c.id, '测试回复');
  assert.equal(ok, false);
  assert.equal(getThread(r.id, c.id).messages.length, 0);
});

test('replyColleague：同事无 open_id 时返回 false', async () => {
  const c = addColleague({ name: '无号', role: 'backend' });
  const r = createRequirement({ title: 'x' });
  assert.equal(await replyColleague(r.id, c.id, 'hi'), false);
});

test('onSettle 成功：清 busy、回填子会话 sessionId、消息标 handledBy:ai、history 留痕', async () => {
  const { c, r } = setupReq();
  const msg = appendMessage(r.id, c.id, { dir: 'in', text: '接口文档', role: 'backend' });
  const convId = 'c1700000000000abc';
  updateRequirement(r.id, {
    sessions: [{ convId, sessionId: null, title: '接入接口文档：a.md', kind: 'sub', phase: 'dev', createdAt: 'x' }],
    busy: { kind: COLLEAGUE_DEV_KIND, runId: 'run_1', startedAt: 1, convId },
  });
  const onSettle = buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: '接入接口文档：a.md' }, convId);
  onSettle(true, { id: 'run_1', session_id: 'sess_9', result: '改了两个文件' });
  await new Promise((res) => setImmediate(res)); // 让 fire-and-forget 的回复 promise 在用例内结束，避免跨用例噪声

  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.equal(after.sessions[0].sessionId, 'sess_9');
  assert.equal(after.history.at(-1).event, `系统任务 ${COLLEAGUE_DEV_KIND} 完成：接入接口文档：a.md`);
  const m = getThread(r.id, c.id).messages.find((x) => x.id === msg.id);
  assert.equal(m.handledBy, 'ai');
  assert.equal(m.handledNote, '已处理 · 接入接口文档：a.md');
});

test('onSettle 失败：handledNote 记失败，history 记失败', () => {
  const { c, r } = setupReq();
  const msg = appendMessage(r.id, c.id, { dir: 'in', text: 'x', role: 'backend' });
  updateRequirement(r.id, { busy: { kind: COLLEAGUE_DEV_KIND, runId: 'run_2', startedAt: 1, convId: 'c_x' } });
  buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_x')(false, { id: 'run_2' });
  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.equal(after.history.at(-1).event, `系统任务 ${COLLEAGUE_DEV_KIND} 失败：T`);
  assert.equal(getThread(r.id, c.id).messages[0].handledNote, '处理失败 · T');
});

test('onSettle 归属校验：busy.runId 不是本 run 时不清 busy（防击穿串行闸），其余照做', () => {
  const { c, r } = setupReq();
  const msg = appendMessage(r.id, c.id, { dir: 'in', text: 'x', role: 'backend' });
  updateRequirement(r.id, { busy: { kind: 'bug-fix', runId: 'run_other', startedAt: 1 } });
  buildColleagueDevOnSettle(r.id, { msgId: msg.id, colleagueId: c.id, title: 'T' }, 'c_y')(true, { id: 'run_mine', session_id: 's' });
  assert.equal(getRequirement(r.id).busy.runId, 'run_other', 'healStaleBusy 可能已清过并派了下一个，那份 busy 不归本回调管');
  assert.equal(getThread(r.id, c.id).messages[0].handledBy, 'ai');
});

test('onSettle：需求已被删时静默返回', () => {
  assert.doesNotThrow(() => buildColleagueDevOnSettle('r_gone', { msgId: 'm', colleagueId: 'c', title: 'T' }, 'c_z')(true, { id: 'r' }));
});

test('dispatchColleagueDev 主路径：建子会话、busy 带 convId、以 bypassPermissions 起新上下文 run', (t) => {
  const c = addColleague({ name: '后端', role: 'backend', feishuOpenId: 'ou_x' });
  const r = createRequirement({ title: '主路径' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cwd-'));
  updateRequirement(r.id, { phase: 'dev', assignees: [c.id], convId: 'c_main', projects: { frontend: { dir, dev: true }, backend: null } });
  let seen = null;
  dispatchColleagueDev(getRequirement(r.id), { msgId: 'm1', colleagueId: c.id, prompt: 'P', title: 'T' }, { start: (run, opts) => { seen = { run, opts }; } });
  // 注入的 start 是空操作，不会像真实 startClaudeRun 那样走到终结口——run 会一直挂在 running，
  // 看门狗 setInterval 未 unref，不清掉会让 node --test 进程挂起（对齐 routes-run.test.js 的 t.after 用法）
  t.after(() => finishRun(seen.run));
  const after = getRequirement(r.id);
  const sub = after.sessions.at(-1);
  assert.equal(sub.kind, 'sub');
  assert.equal(sub.phase, 'dev');
  assert.equal(sub.title, 'T');
  assert.equal(after.busy.kind, COLLEAGUE_DEV_KIND);
  assert.equal(after.busy.convId, sub.convId, 'busy.convId 指向新建的子会话，前端接流与 healStaleBusy 都靠它');
  assert.equal(after.busy.runId, seen.run.id);
  assert.equal(seen.opts.mode, 'bypassPermissions');
  assert.equal(seen.opts.convId, sub.convId);
  assert.equal(seen.opts.cwd, dir);
  assert.equal(seen.opts.session, undefined, '新上下文，不 resume devSession');
  assert.equal(typeof seen.run.onSettle, 'function');
  assert.equal(after.history.at(-1).event, `系统任务 ${COLLEAGUE_DEV_KIND} 启动：T`);
});

test('dispatchColleagueDev 起跑抛错：清 busy、撤掉子会话条目、run 置错、onSettle 摘掉', async () => {
  const c = addColleague({ name: '后端', role: 'backend', feishuOpenId: 'ou_y' });
  const r = createRequirement({ title: '起跑失败' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cwd2-'));
  updateRequirement(r.id, { phase: 'dev', assignees: [c.id], convId: 'c_main', projects: { frontend: { dir, dev: true }, backend: null } });
  let runRef = null;
  dispatchColleagueDev(getRequirement(r.id), { msgId: 'm2', colleagueId: c.id, prompt: 'P', title: 'T2' }, { start: (run) => { runRef = run; throw new Error('settings 损坏'); } });
  await new Promise((res) => setImmediate(res)); // 让 fire-and-forget 的回复 promise 在用例内结束
  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.equal(after.sessions.some((s) => s.title === 'T2'), false, '失败的子会话不该留空壳');
  assert.match(after.history.at(-1).event, /起跑失败：settings 损坏/);
  assert.equal(runRef.onSettle, null);
  assert.equal(getRun(runRef.id)?.status, 'error');
});
```

- [ ] **Step 2: 写失败测试（requirement-ops.test.js 追加 dispatch 守卫）**

```js
test('dispatch(colleague-dev)：非 dev 期作废留痕，不写 busy、不建子会话', () => {
  const r = createRequirement({ title: 'colleague-dev 守卫' });
  updateRequirement(r.id, { phase: 'test' });
  dispatch({ reqId: r.id, kind: 'colleague-dev', payload: { msgId: 'm', colleagueId: 'c', prompt: 'p', title: 'T' } });
  const after = getRequirement(r.id);
  assert.equal(after.busy, null);
  assert.deepEqual(after.sessions, []);
  assert.equal(after.history.at(-1).event, '系统任务 colleague-dev 作废：需求已离开开发期');
});

test('dispatch(colleague-dev)：dev 期但无工程目录时作废留痕', () => {
  const r = createRequirement({ title: 'colleague-dev 无目录' });
  updateRequirement(r.id, { phase: 'dev', projects: { frontend: null, backend: null } });
  dispatch({ reqId: r.id, kind: 'colleague-dev', payload: { msgId: 'm', colleagueId: 'c', prompt: 'p', title: 'T' } });
  assert.equal(getRequirement(r.id).history.at(-1).event, '系统任务 colleague-dev 作废：无可用工程目录');
});

test('canDispatch：busy.kind===colleague-dev 也挡（串行闸不认 kind）', () => {
  assert.equal(canDispatch({ busy: { kind: 'colleague-dev', runId: 'x' }, convId: 'c1' }, () => false), false);
});

test('isBusyStale：busy.convId 与需求主会话不同（colleague-dev 子会话）时，按 busy.convId 查待续跑', () => {
  // 额度续跑的 pending 登记在 run 自己的 conv（子会话）上；拿主会话 convId 查会误判泄漏、清 busy 击穿串行闸
  const dep = { getRunStatus: () => 'done', hasPendingResume: (id) => id === 'c_sub' };
  assert.equal(isBusyStale({ busy: { kind: 'colleague-dev', runId: 'r1', convId: 'c_sub' }, convId: 'c_main' }, dep), false);
  assert.equal(isBusyStale({ busy: { kind: 'bug-fix', runId: 'r1' }, convId: 'c_main' }, dep), true, '无 busy.convId 时仍按主会话查，bug-fix 行为不变');
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test src/entrypoints/web/colleague-dev.test.js src/entrypoints/web/requirement-ops.test.js`
Expected: FAIL —— 找不到模块；dispatch 未识别 kind 落到 bug-fix 守卫（history 文案不匹配）

- [ ] **Step 4: 实现 colleague-dev.js**

```js
/**
 * 系统任务 colleague-dev 的执行侧 —— 后端同事的消息（接口文档 / 需协作的文字）触发的自动接入。
 *
 * 独立成文件而不塞进 requirement-ops.js：那里已 1300+ 行且本仓有并行会话在改；本 kind 与
 * bug-fix 的差别（新开子会话而非 resume 主会话、完成后回飞书、标记消息条目）足够多，
 * 硬放一起只会让 dispatchSystemTask 长出第二套分支。requirement-ops 的 dispatch 只加一支调
 * dispatchColleagueDev。
 *
 * 依赖方向：requirement-ops → 本文件；colleague-auto → 本文件。本文件**不得** import 这两者（成环）。
 */
import { getRequirement, updateRequirement, normalizeSessions } from '../../store/requirements.js';
import { createRun, failRun } from '../../store/runs.js';
import { appendMessage, markHandled } from '../../store/colleague-messages.js';
import { getColleague } from '../../store/colleagues.js';
import { getActiveBot } from '../../store/settings.js';
import { sendTextToUser } from '../../integrations/lark.js';
import { startClaudeRun } from './run-claude.js';
import { pickCwdAndDirs } from './req-logic.js';
import { newSubConvId, buildBrief } from './colleague-auto.logic.js';
import { logger } from '../../shared/logger.js';

export const COLLEAGUE_DEV_KIND = 'colleague-dev';

/**
 * 以机器人身份回同事一句，并落 dir:'out' 进对话流 —— 主机在 web 端同事面板能看到 AI 替他说了什么。
 * 与 routes-requirements#handleColleagueSend 同一条路。发送失败不落消息：落了界面会显示一条其实没送达的。
 * @returns {Promise<boolean>} 是否确实送达
 */
export async function replyColleague(reqId, colleagueId, text) {
  const c = getColleague(colleagueId);
  if (!c?.feishuOpenId) {
    logger.warn('colleague-dev', '同事无 open_id，回复跳过', { reqId, colleagueId });
    return false;
  }
  const bot = getActiveBot();
  let ok = false;
  try {
    ok = await sendTextToUser({ appId: bot?.appId, appSecret: bot?.appSecret }, c.feishuOpenId, text);
  } catch (e) {
    logger.warn('colleague-dev', '回复同事失败', { reqId, colleagueId, err: e?.message || String(e) });
  }
  if (ok) appendMessage(reqId, colleagueId, { dir: 'out', text, role: c.role, status: 'read' });
  return ok;
}

/**
 * run 收尾回调（run-claude#settleRun 在真正终结时调，此时 run.result / run.text 已可读）。
 * 清 busy 前必须确认 busy.runId 仍是本 run —— 与 requirement-ops#buildSystemTaskOnSettle 同一口径：
 * healStaleBusy 或另一条迟到的回调可能已清过并派发了下一个任务，无脑清会击穿串行闸。
 */
export function buildColleagueDevOnSettle(reqId, { msgId, colleagueId, title }, convId) {
  return (ok, run) => {
    const fresh = getRequirement(reqId);
    if (!fresh) return;
    const patch = {};
    if (fresh.busy?.runId === run?.id) patch.busy = null;
    // 子会话回填 sessionId：前端点开时靠它从 Claude 转录回放（跑时可能没人看着）
    if (run?.session_id) {
      patch.sessions = normalizeSessions(fresh).map((s) =>
        s.convId === convId && !s.sessionId ? { ...s, sessionId: run.session_id } : s,
      );
    }
    updateRequirement(reqId, patch, `系统任务 ${COLLEAGUE_DEV_KIND} ${ok ? '完成' : '失败'}：${title}`);
    markHandled(reqId, colleagueId, msgId, { handledBy: 'ai', handledNote: (ok ? '已处理 · ' : '处理失败 · ') + title });
    // fire-and-forget：回复失败不该影响收尾其余步骤，且 onSettle 是同步回调
    replyColleague(reqId, colleagueId, buildBrief(ok, run?.result || run?.text)).catch(() => {});
  };
}

/**
 * 泵派发入口：新建子会话 + 起 run。与 dispatchSystemTask(bug-fix) 的两点差别：
 * ① 新 session 上下文、落到新建的子会话（不 resume devSession、不占主会话 —— 主会话可能正在开发中）；
 * ② busy 带 convId，前端据此把 run 接到正确的会话（req-chat mountReqChrome）。
 * @param {{start?: Function}} [deps] 测试注入起跑函数；本体是真实 SDK 调用，无法直测
 */
export function dispatchColleagueDev(req, payload, { start = startClaudeRun } = {}) {
  const { cwd, addDirs } = pickCwdAndDirs(req.projects);
  if (!cwd) {
    updateRequirement(req.id, {}, `系统任务 ${COLLEAGUE_DEV_KIND} 作废：无可用工程目录`);
    return;
  }
  const convId = newSubConvId();
  const sessions = [
    ...normalizeSessions(req),
    { convId, sessionId: null, title: payload.title, kind: 'sub', phase: req.phase, createdAt: new Date().toISOString() },
  ];
  const run = createRun();
  updateRequirement(
    req.id,
    { sessions, busy: { kind: COLLEAGUE_DEV_KIND, runId: run.id, startedAt: Date.now(), convId } },
    `系统任务 ${COLLEAGUE_DEV_KIND} 启动：${payload.title}`,
  );
  run.onSettle = buildColleagueDevOnSettle(req.id, payload, convId);
  try {
    start(run, { prompt: payload.prompt, cwd, addDirs, mode: 'bypassPermissions', convId });
  } catch (e) {
    // startClaudeRun 起跑前会读盘（getUiPrefs），settings.json 损坏时会同步抛。
    // 不收拾的话 busy 一直挂着直到 healStaleBusy 兜底，期间该需求所有系统任务排队等一个死 run。
    const msg = e?.message || String(e);
    logger.warn('colleague-dev', '起跑失败', { reqId: req.id, runId: run.id, err: msg });
    run.onSettle = null; // failRun 不走 settleRun，onSettle 不会被调；显式摘掉避免误解
    failRun(run, `起跑失败：${msg}`);
    // 连同刚 push 的子会话条目一起撤掉：留着会让前端 hydrate 出一个空壳会话，用户只能翻 history 才知道它失败了
    const fresh = getRequirement(req.id);
    updateRequirement(
      req.id,
      { busy: null, sessions: normalizeSessions(fresh || req).filter((s) => s.convId !== convId) },
      `系统任务 ${COLLEAGUE_DEV_KIND} 起跑失败：${msg.slice(0, 160)}`,
    );
    replyColleague(req.id, payload.colleagueId, buildBrief(false)).catch(() => {});
  }
}
```

- [ ] **Step 5: `requirement-ops.js` 接线**

顶部 import 区加：

```js
import { dispatchColleagueDev, COLLEAGUE_DEV_KIND } from './colleague-dev.js';
```

`dispatch` 函数里，在 `mapregen` 支的 `return;` 之后、`// develop/api-fix 已改为客户端会话驱动` 注释之前插入：

```js
  // 四期：后端同事消息触发的自动接入。只在开发期有意义（/api/req/apidoc 本身也只在 dev 开放；
  // 测试期的后端改动该走 BUG 巡检那条路）。执行体在 colleague-dev.js，理由见其文件头。
  if (kind === COLLEAGUE_DEV_KIND) {
    if (req.phase !== 'dev') {
      try {
        updateRequirement(reqId, {}, `系统任务 ${kind} 作废：需求已离开开发期`);
      } catch (e) {
        logger.error('req-ops', 'updateRequirement 失败', { reqId, kind, err: e?.message || String(e) });
      }
      return;
    }
    dispatchColleagueDev(req, payload);
    return;
  }
```

同文件 `isBusyStale`（约 :105-109）改为按 run 自己的 conv 查待续跑 —— **这是 Critical 修复**：colleague-dev 的 run 挂在子会话，
额度续跑 / 异常重试时 pending 登记在子会话 convId 下，拿主会话 convId 查必然查不到 → 误判泄漏 → 清 busy → 泵派下一个任务 → 两个 Claude 并发写同一仓库：

```js
export function isBusyStale({ busy, convId }, { getRunStatus, hasPendingResume }) {
  if (!busy?.runId) return false;
  if (getRunStatus(busy.runId) === 'running') return false;
  // 待续跑登记挂在 run 自己的 conv 上。系统任务落在子会话时（colleague-dev）busy.convId 才是那个 conv，
  // 拿需求的主会话 convId 去查必然查不到，会把正在额度续跑的任务误判成泄漏、清掉 busy 击穿串行闸
  return !hasPendingResume(busy.convId || convId);
}
```

JSDoc 补一行：`busy.convId（系统任务落在非主会话时才有）优先于需求的 convId —— 它既是前端接流的依据，也是这里判泄漏的依据。`

`src/store/requirements.js` 的 `busy` 字段注释改为：`// { kind, runId, startedAt, convId? } —— 串行闸落盘镜像；convId 仅系统任务落在非主会话时有（colleague-dev 子会话），前端接流与 healStaleBusy 判泄漏都靠它`（该文件有并行会话在改，先 Read）。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test src/entrypoints/web/colleague-dev.test.js src/entrypoints/web/requirement-ops.test.js && node --check src/entrypoints/web/requirement-ops.js`
Expected: PASS（colleague-dev 9 条；requirement-ops 51 + 4 = 55 条；进程须迅速退出 —— 主路径测试里注入的空 `start` 不会终结 run，靠 `t.after(() => finishRun(run))` 停看门狗）

---

### Task 5: `colleague-auto.js` 分类编排

**Files:**
- Create: `src/entrypoints/web/colleague-auto.js`
- Test: `src/entrypoints/web/colleague-auto.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'colleague-auto-'));

const { autoHandleMessages } = await import('./colleague-auto.js');
const { createRequirement, updateRequirement, getRequirement } = await import('../../store/requirements.js');
const { addColleague } = await import('../../store/colleagues.js');
const { appendMessage } = await import('../../store/colleague-messages.js');
const { enqueueSystemTask, queuedTasks } = await import('./requirement-ops.js');

function setup() {
  const c = addColleague({ name: '后端', role: 'backend', feishuOpenId: 'ou_b' });
  const r = createRequirement({ title: '订单导出' });
  updateRequirement(r.id, { phase: 'dev', assignees: [c.id] });
  return { c, r: getRequirement(r.id) };
}

/** 替身依赖：记录调用，不碰 LLM / 飞书 */
function fakeDeps({ classifyResult = null, sample = { path: '/tmp/x.md', sample: 'GET /x' } } = {}) {
  const calls = { classify: [], register: [], enqueue: [], reply: [] };
  return {
    calls,
    deps: {
      classify: async (prompt, tag) => (calls.classify.push({ prompt, tag }), classifyResult),
      readSample: async () => sample,
      register: (req, doc) => (calls.register.push(doc), { ok: true, action: '新增', doc: { id: 'ad_1', name: doc.name, path: doc.path } }),
      enqueue: (reqId, kind, payload) => calls.enqueue.push({ reqId, kind, payload }),
      reply: async (reqId, cid, text) => (calls.reply.push(text), true),
    },
  };
}

test('文件：扩展名不在白名单 → skip:ext，不调分类', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '', role: 'backend', files: [{ name: 'a.pdf', path: '/tmp/a.pdf', kind: 'file' }] });
  const { deps, calls } = fakeDeps();
  assert.deepEqual(await autoHandleMessages(r, c.id, [m.id], deps), ['skip:ext']);
  assert.equal(calls.classify.length, 0);
});

test('文件：判定为接口文档 → 登记、入队 colleague-dev、回「已收到，开始接入」', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '', role: 'backend', files: [{ name: 'order-api.md', path: '/tmp/o.md', kind: 'file' }] });
  const { deps, calls } = fakeDeps({ classifyResult: { isApiDoc: true } });
  assert.deepEqual(await autoHandleMessages(r, c.id, [m.id], deps), ['queued:apidoc']);
  assert.equal(calls.classify[0].tag, 'colleague-auto/apidoc');
  assert.deepEqual(calls.register[0], { name: 'order-api.md', path: '/tmp/x.md' }, 'path 用 readSample 返回的（docx 已转 md）');
  assert.equal(calls.enqueue[0].kind, 'colleague-dev');
  assert.equal(calls.enqueue[0].payload.msgId, m.id);
  assert.equal(calls.enqueue[0].payload.colleagueId, c.id);
  assert.equal(calls.enqueue[0].payload.title, '接入接口文档：order-api.md');
  assert.match(calls.enqueue[0].payload.prompt, /order-api\.md/);
  assert.match(calls.reply[0], /接口文档「order-api\.md」已收到，开始接入开发/);
});

test('文件：判定不是接口文档 → skip:not-apidoc，不登记不入队不回复', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '', role: 'backend', files: [{ name: 'notes.md', path: '/tmp/n.md', kind: 'file' }] });
  const { deps, calls } = fakeDeps({ classifyResult: { isApiDoc: false } });
  assert.deepEqual(await autoHandleMessages(r, c.id, [m.id], deps), ['skip:not-apidoc']);
  assert.equal(calls.enqueue.length + calls.reply.length + calls.register.length, 0);
});

test('文件：读不到样本 → skip:unreadable', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '', role: 'backend', files: [{ name: 'a.md', path: '', kind: 'file' }] });
  const { deps } = fakeDeps({ sample: null });
  assert.deepEqual(await autoHandleMessages(r, c.id, [m.id], deps), ['skip:unreadable']);
});

test('文件：登记失败 → skip:register-failed，不入队不回复', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '', role: 'backend', files: [{ name: 'a.md', path: '/tmp/a.md', kind: 'file' }] });
  const { deps, calls } = fakeDeps({ classifyResult: { isApiDoc: true } });
  deps.register = () => ({ ok: false, status: 400, error: '文件不存在' });
  assert.deepEqual(await autoHandleMessages(r, c.id, [m.id], deps), ['skip:register-failed']);
  assert.equal(calls.enqueue.length + calls.reply.length, 0);
});

test('文字：需要处理 → 入队（prompt 为固定模板：含原话与提炼）、回「正在接入处理：summary」', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '列表接口加了 status 字段', role: 'backend' });
  const { deps, calls } = fakeDeps({ classifyResult: { needsAction: true, summary: '加 status', prompt: '表格加一列 status' } });
  assert.deepEqual(await autoHandleMessages(r, c.id, [m.id], deps), ['queued:text']);
  assert.equal(calls.classify[0].tag, 'colleague-auto/text');
  assert.match(calls.classify[0].prompt, /订单导出/);
  // 子会话 prompt 是固定模板：原话与提炼都要在，Claude 才能对照查证
  assert.match(calls.enqueue[0].payload.prompt, /列表接口加了 status 字段/);
  assert.match(calls.enqueue[0].payload.prompt, /表格加一列 status/);
  assert.match(calls.enqueue[0].payload.prompt, /以原话为准/);
  assert.equal(calls.enqueue[0].payload.title, '后端沟通：加 status');
  assert.equal(calls.reply[0], '已收到，正在接入处理：加 status');
});

test('文字：不需要处理 / 分类返回 null / 空文本 → skip，零副作用', async () => {
  const { c, r } = setup();
  const m1 = appendMessage(r.id, c.id, { dir: 'in', text: '收到，我看看', role: 'backend' });
  const m2 = appendMessage(r.id, c.id, { dir: 'in', text: '   ', role: 'backend' });
  const { deps, calls } = fakeDeps({ classifyResult: { needsAction: false } });
  assert.deepEqual(await autoHandleMessages(r, c.id, [m1.id, m2.id], deps), ['skip:no-action', 'skip:empty']);
  assert.equal(calls.enqueue.length + calls.reply.length, 0);
  deps.classify = async () => null; // 超时 / 额度耗尽 / 解析失败
  assert.deepEqual(await autoHandleMessages(r, c.id, [m1.id], deps), ['skip:no-action']);
});

test('过滤：只处理属于该线程、dir=in、未 handled 的 id；单条异常不拖累其它', async () => {
  const { c, r } = setup();
  const m1 = appendMessage(r.id, c.id, { dir: 'in', text: 'a', role: 'backend' });
  const m2 = appendMessage(r.id, c.id, { dir: 'out', text: 'b', role: 'backend' });
  const m3 = appendMessage(r.id, c.id, { dir: 'in', text: 'c', role: 'backend', handledBy: 'manual' });
  const m4 = appendMessage(r.id, c.id, { dir: 'in', text: 'd', role: 'backend' });
  const { deps } = fakeDeps({ classifyResult: { needsAction: false } });
  let n = 0;
  deps.classify = async () => { if (++n === 1) throw new Error('boom'); return { needsAction: false }; };
  const out = await autoHandleMessages(r, c.id, [m1.id, m2.id, m3.id, m4.id, 'cm_ghost'], deps);
  assert.deepEqual(out, ['error', 'skip:no-action'], 'm2(out)/m3(已 handled)/ghost 被过滤；m1 异常记 error 不影响 m4');
});

test('两条都「需要处理」的消息各成一个任务，不被 enqueueSystemTask 的同类合并顶掉（真实入队）', async () => {
  const { c, r } = setup();
  const m1 = appendMessage(r.id, c.id, { dir: 'in', text: 'A 接口加字段', role: 'backend' });
  const m2 = appendMessage(r.id, c.id, { dir: 'in', text: 'B 接口改名', role: 'backend' });
  const { deps } = fakeDeps({ classifyResult: { needsAction: true, summary: 's', prompt: 'p' } });
  deps.enqueue = enqueueSystemTask; // 只有这一处用真的：合并语义是本模块最关键的集成面
  await autoHandleMessages(r, c.id, [m1.id, m2.id], deps);
  const q = queuedTasks(r.id).filter((t) => t.kind === 'colleague-dev');
  assert.deepEqual(q.map((t) => t.payload.msgId), [m1.id, m2.id], '第一条不能被第二条顶掉，否则同事收到「正在接入 A」却永远等不到');
});

test('同时带文字与附件的消息只走文件路径（飞书文件报文正文恒空；将来接富文本时这条会喊）', async () => {
  const { c, r } = setup();
  const m = appendMessage(r.id, c.id, { dir: 'in', text: '加了字段', role: 'backend', files: [{ name: 'a.md', path: '/tmp/a.md', kind: 'file' }] });
  const { deps, calls } = fakeDeps({ classifyResult: { isApiDoc: false } });
  await autoHandleMessages(r, c.id, [m.id], deps);
  assert.deepEqual(calls.classify.map((x) => x.tag), ['colleague-auto/apidoc']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/colleague-auto.test.js`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现**

```js
/**
 * 后端同事消息自动处理 —— 分类编排（四期）。
 *
 * 入口 autoHandleMessages 由路由 /api/req/colleague-messages/auto 在校验通过后 fire-and-forget 调用。
 * 逐条：有附件走接口文档识别，无附件走文字判定；命中则登记 / 入队 colleague-dev / 回同事一句。
 * 任何分类失败（超时 / 额度耗尽 / 解析不出 / 缺字段）一律视同「不处理」：同事手里已有三期那条 ACK，
 * 主机 web 端也能看到原消息 —— 退化到三期行为，不会更糟。**不重试**。
 *
 * deps 注入：分类是真实 SDK 调用、回复是真实飞书调用，单测只能用替身。默认实现见 defaultDeps。
 */
import fs from 'node:fs';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { runClassifierDetailed } from '../../capabilities/llm-classify.js';
import { docxToMdFile } from '../../integrations/docx.js';
import { getThread } from '../../store/colleague-messages.js';
import { buildApiFixPrompt } from './req-logic.js';
import { enqueueSystemTask, registerApiDoc } from './requirement-ops.js';
import { replyColleague, COLLEAGUE_DEV_KIND } from './colleague-dev.js';
import {
  isApiDocCandidate,
  extOf,
  API_DOC_SAMPLE_CHARS,
  buildApiDocClassifyPrompt,
  parseApiDocVerdict,
  buildTextClassifyPrompt,
  parseTextVerdict,
  buildColleagueDevPrompt,
} from './colleague-auto.logic.js';

const defaultDeps = {
  // 用 Detailed 而不是 Once：超时 / 额度耗尽 / 解析不出在 llm-classify 里大半是静默的，
  // 这里不留一行 warn，主机排查「后端发了消息为啥没反应」时只会看到 skip:no-action、误以为是模型判定
  classify: async (prompt, logTag) => {
    const { data, reason } = await runClassifierDetailed({ prompt, model: config.intent.classifyModel, logTag });
    if (reason) logger.warn('colleague-auto', '分类失败，视同不处理', { logTag, reason });
    return data;
  },
  /**
   * 读取文件开头作分类样本；docx 先转 md（转出的 md 路径同时也是登记给 Claude Read 的路径）。
   * 返回 null = 读不到；抛错（docx 解析失败等）由上层 catch 记 'error' 标签（warn 级日志）。
   */
  readSample: async (file) => {
    let p = file?.path;
    if (!p || !fs.existsSync(p)) return null;
    if (extOf(file.name) === 'docx') p = await docxToMdFile(p, file.name);
    return { path: p, sample: fs.readFileSync(p, 'utf8').slice(0, API_DOC_SAMPLE_CHARS) };
  },
  register: registerApiDoc,
  enqueue: enqueueSystemTask,
  reply: replyColleague,
};

async function handleFileMessage(req, colleagueId, m, d) {
  const file = m.files[0];
  if (!isApiDocCandidate(file.name)) return 'skip:ext';
  const s = await d.readSample(file);
  if (!s) return 'skip:unreadable';
  const verdict = await d.classify(buildApiDocClassifyPrompt({ fileName: file.name, sample: s.sample }), 'colleague-auto/apidoc');
  if (!parseApiDocVerdict(verdict)) return 'skip:not-apidoc';
  const reg = await d.register(req, { name: file.name, path: s.path });
  if (!reg.ok) {
    logger.warn('colleague-auto', '接口文档登记失败', { reqId: req.id, msgId: m.id, error: reg.error });
    return 'skip:register-failed';
  }
  d.enqueue(req.id, COLLEAGUE_DEV_KIND, {
    msgId: m.id,
    colleagueId,
    prompt: buildApiFixPrompt({ action: reg.action, doc: reg.doc }),
    title: '接入接口文档：' + file.name,
  });
  // 入队已是不可逆副作用；回复失败只 warn，标签仍如实记 queued（onSettle 收尾时还会补简报）
  await d
    .reply(req.id, colleagueId, `接口文档「${file.name}」已收到，开始接入开发`)
    .catch((e) => logger.warn('colleague-auto', '回复同事失败', { reqId: req.id, msgId: m.id, err: e?.message || String(e) }));
  return 'queued:apidoc';
}

async function handleTextMessage(req, colleagueId, m, d) {
  const text = (m.text || '').trim();
  if (!text) return 'skip:empty';
  const verdict = parseTextVerdict(await d.classify(buildTextClassifyPrompt({ reqTitle: req.title, text }), 'colleague-auto/text'));
  if (!verdict) return 'skip:no-action';
  d.enqueue(req.id, COLLEAGUE_DEV_KIND, {
    msgId: m.id,
    colleagueId,
    // 固定模板同时带原话与提炼：Haiku 漏掉的字段名靠原话找回（见 buildColleagueDevPrompt 注释）
    prompt: buildColleagueDevPrompt({ reqTitle: req.title, original: text, task: verdict.prompt }),
    title: '后端沟通：' + verdict.summary,
  });
  // 入队已是不可逆副作用；回复失败只 warn，标签仍如实记 queued（onSettle 收尾时还会补简报）
  await d
    .reply(req.id, colleagueId, `已收到，正在接入处理：${verdict.summary}`)
    .catch((e) => logger.warn('colleague-auto', '回复同事失败', { reqId: req.id, msgId: m.id, err: e?.message || String(e) }));
  return 'queued:text';
}

/**
 * @param {object} req 需求记录（调用方已校验 phase==='dev'）
 * @param {string} colleagueId
 * @param {string[]} msgIds 候选消息 id；不属于该线程 / dir!=='in' / 已 handled 的静默过滤
 * @param {object} [deps] 测试注入
 * @returns {Promise<string[]>} 逐条结果标签（顺序与过滤后的消息一致），供日志与测试
 */
export async function autoHandleMessages(req, colleagueId, msgIds, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const wanted = new Set(Array.isArray(msgIds) ? msgIds : []);
  const targets = getThread(req.id, colleagueId).messages.filter((m) => wanted.has(m.id) && m.dir === 'in' && !m.handledBy);
  const out = [];
  for (const m of targets) {
    try {
      const r = m.files?.length ? await handleFileMessage(req, colleagueId, m, d) : await handleTextMessage(req, colleagueId, m, d);
      logger.info('colleague-auto', '同事消息判定', { reqId: req.id, msgId: m.id, result: r });
      out.push(r);
    } catch (e) {
      logger.warn('colleague-auto', '单条处理异常，跳过', { reqId: req.id, msgId: m.id, err: e?.message || String(e) });
      out.push('error');
    }
  }
  return out;
}
```

同时改 `src/entrypoints/web/requirement-ops.js#taskDiscriminator`（约 :151-153）—— **Critical 修复**：`enqueueSystemTask` 对同需求同 kind 的排队任务按判别键去重（last-writer-wins），
colleague-dev 的 payload 没有 bug.id / doc.id / changeId，键恒为空，后端连发两条「需要处理」的消息时第一条任务会被第二条静默顶掉、同事却已收到「正在接入 A」：

```js
  // msgId：colleague-dev（四期）按同事消息逐条成任务，同 msgId 重复入队才算重复，不同消息绝不能互相顶掉
  return payload?.bug?.id || payload?.doc?.id || payload?.changeId || payload?.msgId || '';
```

（该文件有并行会话在改，先 Read。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/colleague-auto.test.js`
Expected: PASS（10 条；其中「真实入队」一条用真的 enqueueSystemTask/queuedTasks 钉住 taskDiscriminator 修复）。另跑 `node --test src/entrypoints/web/requirement-ops.test.js` 确认仍 55 通过。

---

### Task 6: 路由 `POST /api/req/colleague-messages/auto`

**Files:**
- Modify: `src/entrypoints/web/routes-requirements.js`（`handleColleagueSend` 之后加 handler；分发表 `/colleague-messages/send` 行之后加一行；import 加 `autoHandleMessages`）
- Test: `src/entrypoints/web/routes-requirements.test.js`

- [ ] **Step 1: 写失败测试**

`routes-requirements.test.js` 里 `addColleague` 已在文件中部（「开发人员指派」一节）以顶层 `const { addColleague } = await import('../../store/colleagues.js')` 引入，末尾的新测试直接复用，**不要重复声明**（同一模块两个同名顶层 const 是语法错误）。末尾追加：

```js
// ---- POST /api/req/colleague-messages/auto（四期触发口）----

test('/auto：需求不存在 404', async () => {
  const r = await post('/api/req/colleague-messages/auto', { reqId: 'r_nope', colleagueId: 'c', msgIds: ['m'] });
  assert.equal(r.status, 404);
});

test('/auto：非 dev 期 409', async () => {
  const req = await createReq('auto 非 dev');
  const c = addColleague({ name: 'b', role: 'backend' });
  const m = appendMessage(req.id, c.id, { dir: 'in', text: 'x', role: 'backend' });
  const r = await post('/api/req/colleague-messages/auto', { reqId: req.id, colleagueId: c.id, msgIds: [m.id] });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /开发期/);
});

test('/auto：非后端同事 400', async () => {
  const req = await createReq('auto 非后端');
  updateRequirement(req.id, { phase: 'dev' });
  const c = addColleague({ name: 'p', role: 'product' });
  const m = appendMessage(req.id, c.id, { dir: 'in', text: 'x', role: 'product' });
  const r = await post('/api/req/colleague-messages/auto', { reqId: req.id, colleagueId: c.id, msgIds: [m.id] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /后端/);
  // 同事不存在与非后端是两条独立错误：飞书侧 warn 要能看出真实原因
  const ghost = await post('/api/req/colleague-messages/auto', { reqId: req.id, colleagueId: 'cl_ghost', msgIds: [m.id] });
  assert.equal(ghost.status, 400);
  assert.match(ghost.json.error, /不存在/);
});

test('/auto：msgIds 为空 / 不属于线程 / 已 handled → 400', async () => {
  const req = await createReq('auto msgIds');
  updateRequirement(req.id, { phase: 'dev' });
  const c = addColleague({ name: 'b', role: 'backend' });
  const done = appendMessage(req.id, c.id, { dir: 'in', text: 'x', role: 'backend', handledBy: 'manual' });
  assert.equal((await post('/api/req/colleague-messages/auto', { reqId: req.id, colleagueId: c.id, msgIds: [] })).status, 400);
  assert.equal((await post('/api/req/colleague-messages/auto', { reqId: req.id, colleagueId: c.id, msgIds: ['cm_ghost'] })).status, 400);
  assert.equal((await post('/api/req/colleague-messages/auto', { reqId: req.id, colleagueId: c.id, msgIds: [done.id] })).status, 400);
});

test('/auto：校验通过 202 并回 accepted 数（只数有效 id）', async () => {
  const req = await createReq('auto 202');
  updateRequirement(req.id, { phase: 'dev' });
  const c = addColleague({ name: 'b', role: 'backend' });
  // 空文本无附件 → autoHandleMessages 同步走 skip:empty，不触发真实 LLM 调用；不依赖扩展名白名单
  const m = appendMessage(req.id, c.id, { dir: 'in', text: '', role: 'backend' });
  const r = await post('/api/req/colleague-messages/auto', { reqId: req.id, colleagueId: c.id, msgIds: [m.id, 'cm_ghost'] });
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { ok: true, accepted: 1 });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/routes-requirements.test.js`
Expected: FAIL —— 路由未命中（分发表末尾的 404 或 fall-through）

- [ ] **Step 3: 实现**

import 区加：

```js
import { autoHandleMessages } from './colleague-auto.js';
```

`handleColleagueSend` 之后加：

```js
// ==== POST /api/req/colleague-messages/auto {reqId, colleagueId, msgIds} ====
// 飞书进程在消息归属确定后跨进程触发（四期）。路由只做四道校验就 202 交给 colleague-auto，
// 分类是 LLM 调用（秒级），不能让飞书侧的 3s 超时等它。
// handledBy 过滤在这里和 autoHandleMessages 内部各有一份，不要二选一删掉：路由这层是为了「一个 id 都不合法」
// 能直接 400 给飞书侧留痕；内部那层是因为 autoHandleMessages 是可独立调用的契约、不该信任调用方。
// 两层都只认 handledBy，而它在 run 收尾（onSettle）才写 —— 入队到收尾之间同 msgId 的重复触发两层都挡不住；
// 排队中的重复靠 enqueueSystemTask 按 msgId 去重，运行中的重复是已知限制（调用方 notifyAutoHandle 不重试）。
function handleColleagueAuto(req, res) {
  return withJsonBody(req, res, (data) => {
    const reqId = str(data.reqId);
    const colleagueId = str(data.colleagueId);
    // Set 去重：[m, m] 只处理一条，accepted 不能多报
    const msgIds = [...new Set((Array.isArray(data.msgIds) ? data.msgIds : []).map((x) => str(x)).filter(Boolean))];
    const r = getRequirement(reqId);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    if (r.phase !== 'dev') return sendJson(res, 409, { error: '仅开发期自动处理同事消息' });
    const c = getColleague(colleagueId);
    if (!c) return sendJson(res, 400, { error: '同事不存在' });
    if (c.role !== 'backend') return sendJson(res, 400, { error: '仅后端同事的消息自动处理' });
    if (!msgIds.length) return sendJson(res, 400, { error: 'msgIds 为空' });
    // 只认该线程里 dir=in 且尚未处理的：防重复触发与跨线程串号
    const known = new Set(getThread(reqId, colleagueId).messages.filter((m) => m.dir === 'in' && !m.handledBy).map((m) => m.id));
    const valid = msgIds.filter((id) => known.has(id));
    if (!valid.length) return sendJson(res, 400, { error: 'msgIds 不属于该线程或已处理' });
    // 路由级留痕：访问日志只有 method/path/status，看不到「传了 3 个 id 只受理 1 个」这种部分丢弃
    logger.info('req-routes', '同事消息自动处理已受理', { reqId, colleagueId, accepted: valid.length, rejected: msgIds.length - valid.length });
    sendJson(res, 202, { ok: true, accepted: valid.length });
    autoHandleMessages(r, colleagueId, valid).catch((e) =>
      logger.error('req-routes', '同事消息自动处理异常', { reqId, colleagueId, err: e?.message || String(e) }),
    );
  });
}
```

分发表 `/api/req/colleague-messages/send` 行之后加：

```js
  if (pathname === '/api/req/colleague-messages/auto' && method === 'POST') return handleColleagueAuto(req, res);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/routes-requirements.test.js && node --check src/entrypoints/web/routes-requirements.js`
Expected: PASS

---

### Task 7: 飞书侧 `auto-notify.js` + 三处接线

**Files:**
- Create: `src/plugins/colleague-relay/auto-notify.js`
- Modify: `src/plugins/colleague-relay/feature.js:46-50`
- Modify: `src/plugins/colleague-relay/index.js`（`onPickCardAction`）
- Modify: `src/entrypoints/feishu/index.js:108-113`（`relayColleagueAttachment` 单需求分支）
- Test: `src/plugins/colleague-relay/auto-notify.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyAutoHandle } from './auto-notify.js';

test('非后端 / 缺参 / 空 ids：不发请求，直接返回 false', async () => {
  assert.equal(await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'product', msgIds: ['m'] }), false);
  assert.equal(await notifyAutoHandle({ reqId: '', colleagueId: 'c', role: 'backend', msgIds: ['m'] }), false);
  assert.equal(await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'backend', msgIds: [] }), false);
  assert.equal(await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'backend', msgIds: [null, ''] }), false);
});

/** 打桩 fetch：这是仓库第一处 fetch 桩，用 node:test 自带的 mock，不引第三方 */
function stubFetch(t, impl) {
  t.mock.method(globalThis, 'fetch', impl);
}

test('web 回 202 → true', async (t) => {
  stubFetch(t, async () => new Response(null, { status: 202 }));
  assert.equal(await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'backend', msgIds: ['m'] }), true);
});

test('web 回 400 且 body 非 JSON → false 不抛（.json() 失败要被吞掉）', async (t) => {
  stubFetch(t, async () => new Response('<html>bad</html>', { status: 400, headers: { 'content-type': 'text/html' } }));
  assert.equal(await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'backend', msgIds: ['m'] }), false);
});

test('fetch 抛错（web 未起 / 超时）→ false 不抛（消息已落盘，飞书回执链路不能被拖死）', async (t) => {
  stubFetch(t, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'backend', msgIds: ['m'] }), false);
});

test('守卫命中时压根不调 fetch', async (t) => {
  const f = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 202 }));
  await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'product', msgIds: ['m'] });
  await notifyAutoHandle({ reqId: 'r', colleagueId: 'c', role: 'backend', msgIds: [] });
  assert.equal(f.mock.callCount(), 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/colleague-relay/auto-notify.test.js`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 实现**

```js
/**
 * 归属确定后通知 web 进程做四期自动处理（分类 + 起子会话）。
 *
 * fire-and-forget：消息已 appendMessage 落盘，web 不可达只是「这次不自动处理」，
 * 绝不能让飞书回执链路被它拖慢或打断。沿用 create-session / bug-patrol 的跨进程范式：
 * 3s 超时 + 非 JSON 不抛穿。**不重试**：路由是校验后立即 202，不该超时；重试会在
 * 「入队到收尾」的窗口里制造同 msgId 的重复任务（见 routes-requirements#handleColleagueAuto 注释）。
 *
 * role 在这里预判而不只靠 web 端 400：非后端同事每条消息都打一次注定被拒的请求，
 * 日志里全是噪音。web 端的 400 仍保留，那是防御。
 */
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

const TIMEOUT_MS = 3000;

/**
 * @param {{reqId: string, colleagueId: string, role: string, msgIds: string[]}} p
 * @returns {Promise<boolean>} 是否被 web 受理（202）。调用方通常不 await，返回值只给测试用
 */
export async function notifyAutoHandle({ reqId, colleagueId, role, msgIds } = {}) {
  const ids = (Array.isArray(msgIds) ? msgIds : []).filter((x) => typeof x === 'string' && x);
  if (role !== 'backend' || !reqId || !colleagueId || !ids.length) return false;
  const url = `http://127.0.0.1:${config.web.port}/api/req/colleague-messages/auto`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reqId, colleagueId, msgIds: ids }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status === 202) return true;
    const data = await r.json().catch(() => ({}));
    // 400（id 已处理 / 不属于线程 / 同事不存在）与 409（非开发期 —— 选卡回调是用户点卡时才 flush，需求可能已离开 dev）
    // 都是「按规则不该自动处理」，info 级；其它状态才 warn。error 字段一并带出，事后能翻
    const level = r.status === 400 || r.status === 409 ? 'info' : 'warn';
    logger[level]('colleague-relay', '自动处理未受理', { reqId, colleagueId, status: r.status, error: data.error });
    return false;
  } catch (e) {
    logger.warn('colleague-relay', '通知 web 自动处理失败（消息已落盘，不影响回执）', { reqId, err: e?.message || String(e) });
    return false;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/colleague-relay/auto-notify.test.js`
Expected: PASS（5 条，全部用 `t.mock.method(globalThis, 'fetch')` 打桩 —— 仓库第一处 fetch 桩；不打真实端口，否则 dev server 开着时会在它的日志里留 404，且 DROP 型防火墙会等满 3s）

- [ ] **Step 5: 接线 ① feature.js（单需求直归）**

import 加 `import { notifyAutoHandle } from './auto-notify.js';`，`reqs.length === 1` 分支改为：

```js
  if (reqs.length === 1) {
    const saved = appendMessage(reqs[0].id, colleague.id, entry);
    logger.info('colleague-relay', '同事消息已归入需求', { reqId: reqs[0].id, colleague: colleague.name });
    // 四期：不 await —— 回执必须立刻发，自动处理的分类要几秒
    void notifyAutoHandle({ reqId: reqs[0].id, colleagueId: colleague.id, role: colleague.role, msgIds: [saved?.id] });
    return ctx.reply(ACK_TEXT);
  }
```

- [ ] **Step 6: 接线 ② index.js（选卡 flush 后）**

import 加 `import { notifyAutoHandle } from './auto-notify.js';` 与 `import { getColleague } from '../../store/colleagues.js';`。在 `logger.info('colleague-relay', '同事选定需求，缓冲已归入', ...)` 之后加：

```js
  // 四期：flush 进来的这批一并送去判定（角色查名册；不 await，回执优先）
  if (ids.length) void notifyAutoHandle({ reqId, colleagueId, role: getColleague(colleagueId)?.role, msgIds: ids });
```

- [ ] **Step 7: 接线 ③ feishu/index.js（附件单需求直归）**

先 Read 确认行号。import 区加 `import { notifyAutoHandle } from '../../plugins/colleague-relay/auto-notify.js';`（与已有 `resolveTargets` 的 import 相邻）。`relayColleagueAttachment` 的 `reqs.length === 1` 分支改为：

```js
  if (reqs.length === 1) {
    const saved = appendMessage(reqs[0].id, colleague.id, entry);
    logger.info('feishu', '同事附件已归入需求', { reqId: reqs[0].id, colleague: colleague.name, kind });
    void notifyAutoHandle({ reqId: reqs[0].id, colleagueId: colleague.id, role: colleague.role, msgIds: [saved?.id] });
    await say(ACK_TEXT);
    return true;
  }
```

- [ ] **Step 8: 语法与既有测试**

Run: `node --check src/plugins/colleague-relay/feature.js src/plugins/colleague-relay/index.js src/entrypoints/feishu/index.js && node --test src/plugins/colleague-relay/*.test.js`
Expected: PASS（11 条 = 9 既有 + 2 新增。Windows 上 `node --test <目录>` 会把目录当成单个条目只报 `tests 1`，必须用 glob）

---

### Task 8: 前端 —— `createReqConv({id})` 与会话树 hydrate

**Files:**
- Modify: `public/js/chat.js:820-837`（`createReqConv`）
- Modify: `public/js/req-view.js`（import 加 `loadReqTranscript`；`makeSessionRow` 的 `row.onclick`；新增 `openSessionConv`）

- [ ] **Step 1: `createReqConv` 支持既定 id、幂等**

先 Read `public/js/chat.js` 的 `createReqConv`，替换为：

```js
      export function createReqConv({ id, reqId, cwd: reqCwd, session, title, kind = 'sub', seedPending = false, seedText = '' }) {
        const list = loadConvs();
        // 服务端起的子会话（colleague-dev）先于本地存在：按既定 id 补建；已有同 id 直接返回，防重复插入
        if (id && list.some((c) => c.id === id)) return id;
        const c = {
          id: id || 'c' + String(Date.now()),
          title: title || '需求会话',
          session: session || null,
          cwd: reqCwd || '',
          messages: [],
          updatedAt: Date.now(),
          meta: { reqId, kind, seedPending, seedText },
          // 需求系统任务固定跑 Claude；显式声明可防 openai-compat 用户打开需求会话时
          // applySessionPrefs 把缺失 provider 归一成 claude-agent 并静默写穿 localStorage
          provider: 'claude-agent',
        };
        list.push(c);
        saveConvs(list);
        return c.id;
      }
```

- [ ] **Step 2: `req-view.js` 会话树点击走 hydrate**

import 行 6 改为：

```js
import { openConv, createReqConv, isConvRunning, getCurrentConvId, sendMessageProgrammatically, loadReqTranscript } from './chat.js';
```

`makeSessionRow` 里 `row.onclick = () => openConv(session.convId);` 改为：

```js
  row.onclick = () => openSessionConv(session, reqId);
```

`makeSessionRow` 函数之后新增：

```js
/**
 * 打开会话树里的一行。
 *
 * 服务端起的子会话（colleague-dev，见 src/entrypoints/web/colleague-dev.js）本地 localStorage
 * 没有 conv 记录，而 openConv 对不存在的 id 直接 return —— 用户点了没反应。必须先按既定 id 补建，
 * 且要带上 session：否则回放出来之后用户追问一句，会新开一个对刚才内容一无所知的 Claude 会话。
 *
 * 回放只在会话**不在跑**时做：mountReqChrome 的接流不被 await，这里紧接着发的 /api/history 若先回，
 * 半截转录会灌进去再叠上实时流（跨标签页点开正在跑的子会话就是这个场景）。
 * 判「在跑」两条：本页 runningJobs（isConvRunning），或需求 busy 正落在这个子会话上（另一标签页在接流）。
 * 与 openRetroConv 同款：loadReqTranscript 自带「有实时流 / 已有内容就不动」护栏。
 */
async function openSessionConv(session, reqId) {
  const missing = !loadConvs().some((c) => c.id === session.convId);
  let d = null;
  if (missing || session.sessionId) {
    try {
      const r = await fetch('/api/req/get?id=' + encodeURIComponent(reqId));
      if (!r.ok) {
        // 需求在轮询与点击之间被删了：别 hydrate 出一个指向已删需求的孤儿 conv
        if (missing) return window.toast.error('需求已不存在');
      } else {
        d = await r.json();
      }
    } catch {
      /* 网络失败：cwd 留空，仍继续打开 */
    }
  }
  const cwd = d?.devCwd || ''; // devCwd 就是 pickCwdAndDirs 的第一个工程目录，无需再回退 projects
  if (missing) {
    // 必须带 session：否则回放出来之后用户追问一句，会新开一个对刚才内容一无所知的 Claude 会话
    createReqConv({ id: session.convId, reqId, cwd, title: session.title, kind: session.kind, session: session.sessionId || null });
  }
  await openConv(session.convId);
  // 回放只在会话不在跑时做：mountReqChrome 的接流不被 await，这里紧接着发的 /api/history 若先回，
  // 半截转录会灌进去再叠上实时流（跨标签页点开正在跑的子会话就是这个场景）。
  // 判「在跑」两条：本页 runningJobs（isConvRunning），或需求 busy 正落在这个子会话上（另一标签页在接流）
  const liveHere = isConvRunning(session.convId) || (d?.busy?.runId && (d.busy.convId || d.convId) === session.convId);
  if (session.sessionId && session.kind !== 'main' && !liveHere) {
    try {
      await loadReqTranscript(session.convId, session.sessionId, cwd);
    } catch (e) {
      console.warn('[openSessionConv] 转录回放失败', e);
    }
  }
}
```

- [ ] **Step 3: jsdom 测试 —— hydrate 幂等**

`public/js/req-view.sessiontree.test.js` 的 harness 已完整加载 `index.html` + `req-view.js` + `chat.js`，且 `row.onclick` 返回 `openSessionConv` 的 Promise，能真跑 `openConv` 全路径。追加一条：

- fetch 桩加 `GET /api/req/get?id=<树里的 req id>` → `{ id, phase:'dev', busy:null, devCwd:'D:/x', projects:{ frontend:{ dir:'D:/x', dev:true }, backend:null } }`，`GET /api/history/…` → `{ ok:false }`
- 渲染含 `{ convId:'c_sub_h', sessionId:'sess_h', title:'接入接口文档：a.md', kind:'sub', phase:'dev' }` 的树（本地 conv-store 里**没有**它）
- `await row.onclick()` 后，从 `./conv-store.js` 导入 `loadConvs()` 断言 `c_sub_h` 存在且 `meta.reqId` / `cwd === 'D:/x'` / `session === 'sess_h'` / `meta.kind === 'sub'`
- 再点一次，断言 `loadConvs().filter((c) => c.id === 'c_sub_h').length === 1`

用例名：`会话树点开服务端建的子会话：本地无记录时按既定 id 补建（含 session），二次点击不重复`。

- [ ] **Step 4: 语法自检与测试**

Run: `node --check public/js/chat.js public/js/req-view.js && node --test public/js/req-view.sessiontree.test.js public/js/chat.pagination.test.js public/js/chat.path.test.js`
Expected: `node --check` 无输出；测试 34 通过（33 既有 + 1 新增）

---

### Task 9: 前端 —— `mountReqChrome` 接流传 `busy.convId`

**Files:**
- Modify: `public/js/req-chat.js:166`、`:192`（先 Read 确认行号）

- [ ] **Step 1: 两处替换**

行 166 原 `if (data.busy?.runId) ensureConvRunAttached(data.convId, data.busy.runId);` 改为：

```js
  // busy.convId：系统任务落在非主会话时（colleague-dev 起子会话）才有。ensureConvRunAttached 内部只为
  // currentConvId 接流 —— 传真实 convId 后，用户在主会话时子会话的 run 被自然忽略（不错接），
  // 点开子会话时正常接流。bug-fix 的 busy 无 convId，回落主会话，行为不变。
  if (data.busy?.runId) ensureConvRunAttached(data.busy.convId || data.convId, data.busy.runId);
```

行 192 原 `if (d.busy?.runId) ensureConvRunAttached(d.convId, d.busy.runId);` 改为：

```js
        if (d.busy?.runId) ensureConvRunAttached(d.busy.convId || d.convId, d.busy.runId);
```

- [ ] **Step 2: `BUSY_KIND_LABELS` 补新 kind**

同文件 `const BUSY_KIND_LABELS = {…}`（约 :311）加一项，否则 busy 芯片会把原始英文 key 直接露给用户（`系统任务运行中（colleague-dev）`）—— 而这枚芯片是用户在主会话里感知「子会话正在跑」的**唯一**信号：

```js
  'colleague-dev': '后端沟通接入', // 四期：后端同事消息触发的自动接入（src/entrypoints/web/colleague-dev.js）
```

并在该常量上方注释补一句「新增 kind 必须同步加这里」。

- [ ] **Step 3: 语法自检**

Run: `node --check public/js/req-chat.js && grep -n "colleague-dev" public/js/req-chat.js`
Expected: 通过；`BUSY_KIND_LABELS` 里能 grep 到 `'colleague-dev'`

---

### Task 10: 全量验证与人工验收清单

- [ ] **Step 1: 全量单测**

Run: `npm test 2>&1 | tail -8`
Expected: `fail 0`；tests 数 ≥ 3026 + 本计划新增（约 +30）

- [ ] **Step 2: 前端 import 图语法自检**

Run: `for f in public/js/*.js; do node --check "$f" || echo "FAIL $f"; done`
Expected: 无 FAIL

- [ ] **Step 3: 后端模块图加载自检（防成环）**

Run: `node -e "import('./src/entrypoints/web/routes-requirements.js').then(() => console.log('routes OK')); import('./src/entrypoints/feishu/index.js').then(() => console.log('feishu OK')).catch(e => console.error('feishu import fail', e.message))"`
Expected: 两行 OK（feishu 入口若因缺 `.env` 凭证抛错属正常，只要不是 `ReferenceError: Cannot access ... before initialization` 这类环状 import 报错）

- [ ] **Step 4: 交付说明里列出人工验收项**（无法自动验证，由用户在真机执行）

1. 飞书：后端同事（名册 role=backend、有 open_id、被指派到一个 `phase=dev` 需求）发一份 `.md` 接口文档 → 先收「已收到，信息会同步发送给主机！」，几秒后收「接口文档「x.md」已收到，开始接入开发」；web 端右栏 API 文档列表出现该文件；会话树出现「接入接口文档：x.md」子会话，运行灯亮。
2. 点开该子会话：能看到实时进度（用户在主会话时主会话**不**出现子会话的输出）。
3. run 结束：同事收「已处理完成：…」；web 端同事面板出现 AI 的两条 `out` 消息；原消息条目 `handledBy:'ai'`（面板若未渲染该字段，查 `colleague-messages.json`）。
4. 后端同事发「收到，我看看」→ 只收一条 ACK，无子会话。
5. 后端同事发「列表接口加了 status 字段，前端表格要多一列」→ 收「已收到，正在接入处理：…」，子会话标题「后端沟通：…」。
6. 后端同事发 `.pdf` → 只收 ACK（走三期归档）。
7. 产品同事（role=product）发任何内容 → 只收 ACK；飞书日志无 `/auto` 请求（`notifyAutoHandle` 预判 role）。
8. 主会话正在跑自动开发时后端发接口文档 → 同事收「开始接入开发」，但子会话等主会话结束才起（串行闸）；需求 history 可见先后顺序。
9. 关掉 web 进程，后端发消息 → 收 ACK，飞书日志 warn「通知 web 自动处理失败（消息已落盘）」；重启 web 后 web 端同事面板能看到该消息。
10. 刷新浏览器后点开已完成的子会话 → 从转录回放出内容（`sessionId` 已回填）。
11. 桌面版：`public/` 与 `src/` 都是构建快照，**需重新构建重装**。

---

## 终审修补（Task 10 附录，整体审查后落地）

整体终审在逐任务审查之外抓出三条 Important，各触到一条拍板，已全部落地并有测试（全量 3127 通过）：

### A. 插件停用时 web 路由拒绝自动处理（拍板 #7）

`routes-requirements.js#handleColleagueAuto` 第一道校验（`if (!r)` 之前）：

```js
    // 拍板 #7：自动处理跟随 colleague-relay 插件启停。飞书侧附件链路（relayColleagueAttachment）是刻意绕过
    // 插件开关的（三期决定：不该因插件停用就让同事发的文档变成「不支持的消息类型」），所以开关只能在这里认——
    // 否则停用后文字不再中继、文件却仍会烧一次 Haiku 并起 bypassPermissions 的 run
    if (!getPluginEnabled('colleague-relay')) return sendJson(res, 409, { error: '同事消息中继插件已停用，不自动处理' });
```
（`getPluginEnabled` 从 `store/settings.js` import。）测试：`setPluginEnabled('colleague-relay', false)` → 409，`finally` 恢复。

### B. 进程重启时不清「有待续跑登记」的 busy（拍板 #2）

`server.js` 先 `recoverPendingAndOrphans()`（孤儿 run 登记待续跑，convId = run 自己的 conv）再 `startRequirementPump()` → `recoverBusyOnBoot`。原实现无条件清 busy，随后 `doResume` 在子会话续跑改代码，而 `canDispatch` 只查主会话有无活跃 run → 新任务被派发 → 并发改同一目录。改为：

```js
export function recoverBusyOnBoot() {
  for (const r of getRequirements()) {
    if (!r.busy) continue;
    if (defaultHasPendingResume(r.busy.convId || r.convId)) {
      logger.info('req-ops', 'busy 对应 conv 有待续跑登记，保留等续跑', { reqId: r.id, kind: r.busy.kind, convId: r.busy.convId || r.convId });
      continue; // 留给 healStaleBusy 在续跑链结束后按现有口径清
    }
    updateRequirement(r.id, { busy: null }, `任务 ${r.busy.kind} 因进程重启中断`);
  }
}
```
测试：两条需求，一条 busy.convId 上有 `addPending` 登记 → 保留；一条无 → 照旧清。

### C. 作废路径给同事收尾 + markHandled

`colleague-dev.js` 新增导出：
```js
export function abandonColleagueDev(reqId, { msgId, colleagueId, title }, reason) {
  updateRequirement(reqId, {}, `系统任务 ${COLLEAGUE_DEV_KIND} 作废：${reason}`);
  markHandled(reqId, colleagueId, msgId, { handledBy: 'ai', handledNote: `作废（${reason}） · ${title}` });
  replyColleague(reqId, colleagueId, buildBrief(false)).catch(() => {});
}
```
`dispatchColleagueDev` 的无工程目录分支与 `requirement-ops.js#dispatch` 的 phase 守卫分支都改调它（history 文案不变，存量断言不受影响）。

### D. Minor：`registerApiDoc` 的 phase 也现读

`const fresh = getRequirement(req.id) || req;` —— phase 守卫、`apiDocs`、`updateRequirement` 的 id 全用 `fresh`：分类要几秒，期间需求可能已流转。

### E. 测试补漏

`/auto` 202 用例追加 `[m2.id, m2.id]` → `accepted: 1`（Set 去重）。

### F. 文档

`src/entrypoints/CLAUDE.md`（三个新文件 + kind 列表 + `busy.convId` 双重契约 + 改动入口）、`src/plugins/CLAUDE.md`（新增 `colleague-relay/` 小节，三期时就漏了）、`src/store/CLAUDE.md`（`handledBy` 两维独立）、`docs/ARCHITECTURE.md`（全景图两行）均已更新。

**范围外待办**：跨进程 `postToWeb` 范式已有 5 份复制（create-session / stop-patrol / feishu-relay / bug-patrol / auto-notify），可抽到 `shared/`；同事面板对 `handledBy:'ai'` 的消息尚无视觉标记（spec §七未列，下一期）。

---

## Self-Review

**Spec coverage：**
- §三 数据流三处触发 → Task 7 ✓；跨进程 POST → Task 7 ✓；四道校验 → Task 6 ✓
- §4.1 两级识别 / docx 转 md / 4000 字 / registerApiDoc 抽出 → Task 2、3、5 ✓
- §4.2 一次调用产出判定与 prompt / needsAction 但 prompt 空归不处理 → Task 2、5 ✓
- §4.3 失败语义 → Task 5（classify 返 null → skip；异常 → error）✓
- §五 dispatchColleagueDev 五步 / onSettle 四步 / busy.convId → Task 4 ✓；phase 守卫 dev → Task 4 ✓
- §六 三时点回复 + dir:'out' 落库 + 不改 status → Task 4、5、1 ✓
- §7.1 hydrate + 回放 → Task 8 ✓；§7.2 传 busy.convId → Task 9 ✓
- §八 markHandled / flushPending ids / busy.convId → Task 1、4 ✓
- §十 错误处理：起跑失败分支 → Task 4 的 try/catch ✓；其余各 Task 覆盖 ✓
- §十一 测试清单 → 各 Task 的 Step 1 ✓（前端 `createReqConv({id})` 幂等无 jsdom 测试，靠 Task 10 人工项 10）

**Placeholder scan：** 无 TBD / "similar to" / 未定义引用。

**Type consistency：**
- `flushPending` 返回 `{count, ids}`：Task 1 定义、Task 7 Step 6 消费 ✓
- `registerApiDoc` 返回 `{ok, action, doc}` / `{ok:false, status, error}`：Task 3 定义、Task 3 Step 5 与 Task 5 消费 ✓
- `notifyAutoHandle({reqId, colleagueId, role, msgIds})`：Task 7 定义与三处调用一致 ✓
- `enqueueSystemTask(reqId, 'colleague-dev', {msgId, colleagueId, prompt, title})`：Task 5 入队、Task 4 `dispatchColleagueDev` / `buildColleagueDevOnSettle` 解构同名字段 ✓
- `COLLEAGUE_DEV_KIND` 在 Task 4 定义，Task 5 import 使用 ✓
- `buildBrief(ok, text)` 在 Task 2 定义，Task 4 两处调用 ✓

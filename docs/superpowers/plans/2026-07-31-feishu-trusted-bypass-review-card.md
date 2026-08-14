# 飞书可信提交人直通 + 评审否定挽回（按钮卡片）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 可信提交人（TRUSTED_OPEN_IDS）的需求/故障跳过 AI 评审直接自动开发；评审否定（ask/reject）改发「坚持修改/算了」按钮卡片，并修复 reject 后文本「坚持修改」失效的 bug。

**Architecture:** 评审否定的挽回判定抽为 `feedback/logic.js` 纯函数（含卡片构造/回调解析）；卡片回调走「按钮 value 携带 taskId + kind 全局路由」（新增 `shared/card-actions.js` 注册表，避免 feedback ↔ feishu 入口循环依赖），无内存态、重启后按钮仍有效；直通分流插在 feedback 立案后、托管等级分流前。

**Tech Stack:** Node ESM、`node --test` + `node:assert/strict`、@larksuiteoapi/node-sdk（交互卡片 + card.action.trigger 长连接回调）。

**规格文档：** `docs/superpowers/specs/2026-07-31-feishu-trusted-bypass-review-card-design.md`

**⚠️ 项目铁律：所有任务均不做 git 提交（用户规则覆盖技能默认流程，提交时机由用户掌控）。任务里没有 commit 步骤，这是有意为之，不要自行补加。**

**注释语言：** 全部中文（与代码库一致）。

---

### Task 1: config 解析 `TRUSTED_OPEN_IDS`

**Files:**
- Modify: `src/shared/config.js`（`lark.ownerOpenIds` 附近）
- Create: `src/shared/config.test.js`
- Modify: `.env.example`（`TRIAGE_OWNER_OPEN_ID` 块之后）

- [ ] **Step 1: 写失败测试**

创建 `src/shared/config.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenIdList } from './config.js';

test('parseOpenIdList：逗号分隔 + trim + 去空', () => {
  assert.deepEqual(parseOpenIdList('ou_a, ou_b ,,ou_c'), ['ou_a', 'ou_b', 'ou_c']);
});

test('parseOpenIdList：空串 / undefined → 空数组', () => {
  assert.deepEqual(parseOpenIdList(''), []);
  assert.deepEqual(parseOpenIdList(undefined), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/shared/config.test.js`
Expected: FAIL（`parseOpenIdList` 未导出，SyntaxError: The requested module ... does not provide an export named 'parseOpenIdList'）

- [ ] **Step 3: 实现**

在 `src/shared/config.js` 中，`export const config`（或文件内 config 对象定义）之前加：

```js
/** 逗号分隔 open_id 列表 → 数组（trim + 去空）；OWNER_OPEN_IDS / TRUSTED_OPEN_IDS 共用 */
export function parseOpenIdList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
```

把现有 ownerOpenIds 块：

```js
    // owner 白名单（逗号分隔 open_id）→ 完整 Claude 能力
    ownerOpenIds: (process.env.OWNER_OPEN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
```

替换为：

```js
    // owner 白名单（逗号分隔 open_id）→ 完整 Claude 能力
    ownerOpenIds: parseOpenIdList(process.env.OWNER_OPEN_IDS),
    // 可信提交人白名单（逗号分隔 open_id）→ 需求/故障跳过 AI 评审门，直接进自动开发队列
    trustedOpenIds: parseOpenIdList(process.env.TRUSTED_OPEN_IDS),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/shared/config.test.js`
Expected: PASS（2 tests）

- [ ] **Step 5: 更新 `.env.example`**

在 `TRIAGE_OWNER_OPEN_ID=` 行之后追加（保持空行分隔）：

```
# 可信提交人白名单：这些 open_id 提交的需求/故障【跳过 AI 评审】直接进自动开发队列
# （在独立任务分支改码，合并仍需管理员在 web 管理台确认）。多个用逗号分隔。
# 注意：与 OWNER_OPEN_IDS 互斥使用——owner 的消息被 claude-exec 全接，进不了提交流程；
# 想让「本人」提交直通，把自己的 open_id 填这里，且不要填进 OWNER_OPEN_IDS。
TRUSTED_OPEN_IDS=
```

---

### Task 2: `feedback/logic.js` 挽回判定纯函数

**Files:**
- Create: `src/plugins/team-tools/feedback/logic.js`
- Create: `src/plugins/team-tools/feedback/logic.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/plugins/team-tools/feedback/logic.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReviewableTask, findReviewableTask } from './logic.js';

const NOW = new Date('2026-07-31T10:00:00.000Z').getTime();
const mk = (o) => ({
  id: o.id,
  type: o.type || 'feature',
  title: o.title || o.id,
  status: o.status,
  review: o.review,
  source: { openId: 'ou_me', chatId: 'oc_1', ...(o.source || {}) },
  updatedAt: o.updatedAt || new Date(NOW - 60_000).toISOString(),
});

test('isReviewableTask：challenged 可挽回', () => {
  assert.equal(isReviewableTask(mk({ id: 'a', status: 'challenged' })), true);
});

test('isReviewableTask：rejected + 评审 reject 可挽回', () => {
  assert.equal(isReviewableTask(mk({ id: 'a', status: 'rejected', review: { verdict: 'reject' } })), true);
});

test('isReviewableTask：rejected + 评审 ask（「算了」后反悔）可挽回', () => {
  assert.equal(isReviewableTask(mk({ id: 'a', status: 'rejected', review: { verdict: 'ask' } })), true);
});

test('isReviewableTask：无评审否定判决的 rejected（owner triage 手动放弃）不可挽回', () => {
  assert.equal(isReviewableTask(mk({ id: 'a', status: 'rejected' })), false);
  assert.equal(isReviewableTask(mk({ id: 'a', status: 'rejected', review: { verdict: 'plan' } })), false);
});

test('isReviewableTask：其他状态与空值不可挽回', () => {
  for (const status of ['new', 'reviewing', 'analyzing', 'analyzed', 'queued', 'developing', 'done']) {
    assert.equal(isReviewableTask(mk({ id: 'a', status })), false, status);
  }
  assert.equal(isReviewableTask(null), false);
});

test('findReviewableTask：命中同人同会话窗口内任务', () => {
  const t = mk({ id: 'a', status: 'challenged' });
  assert.equal(findReviewableTask([t], { openId: 'ou_me', chatId: 'oc_1', now: NOW }), t);
});

test('findReviewableTask：超窗（>30 分钟）不命中', () => {
  const stale = mk({ id: 'a', status: 'challenged', updatedAt: new Date(NOW - 31 * 60_000).toISOString() });
  assert.equal(findReviewableTask([stale], { openId: 'ou_me', chatId: 'oc_1', now: NOW }), null);
});

test('findReviewableTask：跨用户 / 跨会话不命中', () => {
  const t = mk({ id: 'a', status: 'challenged' });
  assert.equal(findReviewableTask([t], { openId: 'ou_you', chatId: 'oc_1', now: NOW }), null);
  assert.equal(findReviewableTask([t], { openId: 'ou_me', chatId: 'oc_2', now: NOW }), null);
});

test('findReviewableTask：空列表 / undefined 容错', () => {
  assert.equal(findReviewableTask([], { openId: 'ou_me', chatId: 'oc_1', now: NOW }), null);
  assert.equal(findReviewableTask(undefined, { openId: 'ou_me', chatId: 'oc_1', now: NOW }), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/feedback/logic.test.js`
Expected: FAIL（Cannot find module ... logic.js）

- [ ] **Step 3: 实现**

创建 `src/plugins/team-tools/feedback/logic.js`：

```js
/**
 * feedback 纯逻辑（无副作用，可单测）：评审否定任务的挽回判定 + 评审否定卡片的构造/回调解析。
 */

const REVIEW_WINDOW_MS = 30 * 60 * 1000;

/**
 * 任务是否处于「可挽回」态：被评审质疑等待应答（challenged），
 * 或被评审否定后进了 rejected（评审 reject 直接拒绝 / ask 质疑后用户「算了」——反悔也允许）。
 * owner 在 triage 手动放弃的任务无评审否定判决（verdict 非 reject/ask）→ 不匹配，不受影响。
 */
export function isReviewableTask(t) {
  if (!t) return false;
  if (t.status === 'challenged') return true;
  return t.status === 'rejected' && ['reject', 'ask'].includes(t.review?.verdict);
}

/** 同人同会话、30 分钟窗口内可挽回的任务（文本「坚持修改/算了」的查找入口）；无则 null */
export function findReviewableTask(tasks, { openId, chatId, now = Date.now(), windowMs = REVIEW_WINDOW_MS }) {
  const cutoff = now - windowMs;
  return (
    (tasks || []).find(
      (t) =>
        isReviewableTask(t) &&
        t.source?.openId === openId &&
        t.source?.chatId === chatId &&
        new Date(t.updatedAt).getTime() >= cutoff,
    ) || null
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/feedback/logic.test.js`
Expected: PASS（9 tests）

---

### Task 3: `feedback/logic.js` 卡片构造与回调解析纯函数

**Files:**
- Modify: `src/plugins/team-tools/feedback/logic.js`（追加）
- Modify: `src/plugins/team-tools/feedback/logic.test.js`（追加）

- [ ] **Step 1: 追加失败测试**

在 `logic.test.js` 顶部 import 行改为：

```js
import {
  isReviewableTask,
  findReviewableTask,
  buildVerdictCard,
  verdictResultCard,
  parseVerdictCardAction,
  canOperateVerdict,
} from './logic.js';
```

文件末尾追加：

```js
test('buildVerdictCard：按钮 value 携带 kind/taskId/action', () => {
  const card = buildVerdictCard(mk({ id: 't1', status: 'rejected' }), 'reject', '与现有功能重复');
  const actions = card.elements.find((e) => e.tag === 'action').actions;
  assert.deepEqual(
    actions.map((a) => a.value),
    [
      { kind: 'review-verdict', taskId: 't1', action: 'insist' },
      { kind: 'review-verdict', taskId: 't1', action: 'giveup' },
    ],
  );
});

test('buildVerdictCard：reject 与 ask 文案不同，理由入正文', () => {
  const rj = buildVerdictCard(mk({ id: 't1', status: 'rejected', type: 'bug' }), 'reject', '无法复现');
  assert.match(rj.elements[0].text.content, /未通过评审/);
  assert.match(rj.elements[0].text.content, /无法复现/);
  const ask = buildVerdictCard(mk({ id: 't1', status: 'challenged' }), 'ask', '范围太大');
  assert.match(ask.elements[0].text.content, /建议暂缓/);
});

test('buildVerdictCard：群聊加 <at id>，p2p 不加，非法 openId 不拼', () => {
  const grp = buildVerdictCard(mk({ id: 't1', status: 'rejected', source: { chatType: 'group' } }), 'reject', 'r');
  assert.match(grp.elements[0].text.content, /^<at id=ou_me><\/at> /);
  const p2p = buildVerdictCard(mk({ id: 't1', status: 'rejected', source: { chatType: 'p2p' } }), 'reject', 'r');
  assert.doesNotMatch(p2p.elements[0].text.content, /<at/);
  const bad = buildVerdictCard(
    mk({ id: 't1', status: 'rejected', source: { chatType: 'group', openId: 'x"><script' } }),
    'reject',
    'r',
  );
  assert.doesNotMatch(bad.elements[0].text.content, /<at/);
});

test('verdictResultCard：无按钮纯文本终态', () => {
  const card = verdictResultCard('✋ 已坚持修改');
  assert.equal(card.elements.length, 1);
  assert.equal(card.elements[0].text.content, '✋ 已坚持修改');
});

test('parseVerdictCardAction：对象 value 常态解析（v2 schema）', () => {
  const parsed = parseVerdictCardAction({
    operator: { open_id: 'ou_op' },
    context: { open_message_id: 'om_1' },
    action: { value: { kind: 'review-verdict', taskId: 't1', action: 'insist' } },
  });
  assert.deepEqual(parsed, { taskId: 't1', action: 'insist', operatorOpenId: 'ou_op', messageId: 'om_1' });
});

test('parseVerdictCardAction：JSON 字符串 value + 顶层 message_id 兼容', () => {
  const parsed = parseVerdictCardAction({
    message_id: 'om_2',
    action: { value: JSON.stringify({ kind: 'review-verdict', taskId: 't1', action: 'giveup' }) },
  });
  assert.equal(parsed.action, 'giveup');
  assert.equal(parsed.messageId, 'om_2');
});

test('parseVerdictCardAction：非本 kind / 缺 taskId / 非法 action / 空报文 → null', () => {
  assert.equal(parseVerdictCardAction({ action: { value: { kind: 'other', taskId: 't1', action: 'insist' } } }), null);
  assert.equal(parseVerdictCardAction({ action: { value: { kind: 'review-verdict', action: 'insist' } } }), null);
  assert.equal(parseVerdictCardAction({ action: { value: { kind: 'review-verdict', taskId: 't1', action: 'x' } } }), null);
  assert.equal(parseVerdictCardAction({ action: { value: 'not-json{' } }), null);
  assert.equal(parseVerdictCardAction({}), null);
});

test('canOperateVerdict：提交人/可信白名单/owner 可操作，其他人与空值不可', () => {
  const t = mk({ id: 't1', status: 'challenged' });
  assert.equal(canOperateVerdict('ou_me', t, {}), true);
  assert.equal(canOperateVerdict('ou_t', t, { trustedOpenIds: ['ou_t'] }), true);
  assert.equal(canOperateVerdict('ou_o', t, { ownerOpenIds: ['ou_o'] }), true);
  assert.equal(canOperateVerdict('ou_x', t, { trustedOpenIds: ['ou_t'], ownerOpenIds: ['ou_o'] }), false);
  assert.equal(canOperateVerdict(null, t, {}), false);
  assert.equal(canOperateVerdict('ou_me', null, {}), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/feedback/logic.test.js`
Expected: FAIL（does not provide an export named 'buildVerdictCard'）

- [ ] **Step 3: 实现**

在 `logic.js` 末尾追加：

```js
// —— 评审否定卡片（坚持修改 / 算了）——
// 按钮 value 携带 taskId 做全局 kind 路由：不依赖内存注册，机器人重启后旧卡片按钮仍有效。

const CARD_KIND = 'review-verdict';
// 与 shared/mention.js 同源的 open_id 白名单校验：防把用户可控内容拼进 <at> 标签属性
const OPEN_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 评审否定按钮卡片。
 * @param {object} task    含 id/type/title/source
 * @param {'reject'|'ask'} verdict
 * @param {string} reason  评审理由
 */
export function buildVerdictCard(task, verdict, reason) {
  const kind = task.type === 'bug' ? '故障' : '需求';
  // 卡片 lark_md 的 @ 语法是 <at id=xxx></at>（与文本消息的 <at user_id> 不同）；仅群聊拼，p2p 渲染异常
  const at =
    task.source?.chatType === 'group' && OPEN_ID_RE.test(task.source?.openId || '')
      ? `<at id=${task.source.openId}></at> `
      : '';
  const head =
    verdict === 'reject' ? `❌ **该${kind}未通过评审，暂不处理**` : `🤔 **关于这条${kind}，评审建议暂缓**`;
  return {
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `${at}${head}\n${reason || '(未给出理由)'}\n\n「${task.title}」` },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✋ 坚持修改' },
            type: 'primary',
            value: { kind: CARD_KIND, taskId: task.id, action: 'insist' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🗑 算了' },
            type: 'danger',
            value: { kind: CARD_KIND, taskId: task.id, action: 'giveup' },
          },
        ],
      },
    ],
  };
}

/** 点击后的终态卡片：按钮消失，只留一句结果 */
export function verdictResultCard(text) {
  return { elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }] };
}

/**
 * 解析 card.action.trigger 回调 → { taskId, action, operatorOpenId, messageId }；非本 kind/结构异常 → null。
 * 兼容两种报文形态：value 为对象（常态）或 JSON 字符串；message_id 取 context.open_message_id（v2 schema），
 * 顶层 message_id 兜底。
 */
export function parseVerdictCardAction(data) {
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  if (!value || value.kind !== CARD_KIND || !value.taskId) return null;
  if (!['insist', 'giveup'].includes(value.action)) return null;
  return {
    taskId: value.taskId,
    action: value.action,
    operatorOpenId: data?.operator?.open_id || null,
    messageId: data?.context?.open_message_id || data?.message_id || null,
  };
}

/** 谁可以点评审卡片：提交人本人 / 可信白名单 / owner；其他人忽略（群聊卡片人人可见） */
export function canOperateVerdict(operatorOpenId, task, { trustedOpenIds = [], ownerOpenIds = [] } = {}) {
  if (!operatorOpenId || !task) return false;
  return (
    operatorOpenId === task.source?.openId ||
    trustedOpenIds.includes(operatorOpenId) ||
    ownerOpenIds.includes(operatorOpenId)
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/feedback/logic.test.js`
Expected: PASS（17 tests）

---

### Task 4: 文本「坚持修改」挽回 rejected 任务（bug 修复）

**Files:**
- Modify: `src/plugins/team-tools/feedback/index.js`

- [ ] **Step 1: 替换窗口常量与查找函数**

删除常量 `CHALLENGE_WINDOW_MS`（窗口语义已移入 logic.js），把：

```js
// challenged 应答窗口与关键词：仅「短回复且命中」才接管（否则放行正常分流）。
// 长文本极可能是新的需求/故障描述（如「登录页的按钮颜色要修改一下」），绝不能被劫持成对旧任务的应答。
const CHALLENGE_WINDOW_MS = 30 * 60 * 1000;
const REPLY_MAX_LEN = 20;
```

改为：

```js
// 评审否定应答关键词：仅「短回复且命中」才接管（否则放行正常分流）。
// 长文本极可能是新的需求/故障描述（如「登录页的按钮颜色要修改一下」），绝不能被劫持成对旧任务的应答。
const REPLY_MAX_LEN = 20;
```

把 `pendingChallenged` 整个函数：

```js
/** 该用户同会话 30 分钟内被评审质疑的任务 */
function pendingChallenged(ctx) {
  const cutoff = Date.now() - CHALLENGE_WINDOW_MS;
  const chatId = ctx.meta?.chatId || ctx.sessionKey;
  return (
    getTasks().find(
      (t) =>
        t.status === 'challenged' &&
        t.source?.openId === ctx.user.id &&
        t.source?.chatId === chatId &&
        new Date(t.updatedAt).getTime() >= cutoff,
    ) || null
  );
}
```

替换为：

```js
/** 该用户同会话 30 分钟内被评审否定（质疑 challenged / 拒绝 rejected）的任务；谓词见 logic.findReviewableTask */
function pendingReviewable(ctx) {
  return findReviewableTask(getTasks(), {
    openId: ctx.user.id,
    chatId: ctx.meta?.chatId || ctx.sessionKey,
  });
}
```

并在 import 区追加：

```js
import { findReviewableTask } from './logic.js';
```

- [ ] **Step 2: 更新 hasPending 与 A 段应答**

`hasPending` 行：

```js
  // challenged 应答拦截：存在质疑中的任务且文本是明确的短应答才接管
  hasPending: (ctx) => isChallengeReply(ctx.text) && !!pendingChallenged(ctx),
```

改为：

```js
  // 评审否定应答拦截：存在可挽回任务（质疑中/被拒 30 分钟内）且文本是明确的短应答才接管
  hasPending: (ctx) => isChallengeReply(ctx.text) && !!pendingReviewable(ctx),
```

handle 里的 A 段：

```js
    // A. challenged 应答（hasPending 路径，intentResult=null）
    const pending = !intentResult && isChallengeReply(ctx.text) ? pendingChallenged(ctx) : null;
    if (pending) {
      // 交叠时 YES 优先（如「算了，还是改吧」按坚持处理）
      if (!YES_RE.test(ctx.text || '')) {
        updateTask(pending.id, { status: 'rejected' }, '用户放弃（评审质疑后）');
        return ctx.reply(`好的，已取消「${pending.title}」。`);
      }
```

改为：

```js
    // A. 评审否定应答（hasPending 路径，intentResult=null）：challenged 质疑 + rejected 被拒都可挽回
    const pending = !intentResult && isChallengeReply(ctx.text) ? pendingReviewable(ctx) : null;
    if (pending) {
      // 交叠时 YES 优先（如「算了，还是改吧」按坚持处理）
      if (!YES_RE.test(ctx.text || '')) {
        // 已 rejected（评审拒绝 / 此前已「算了」）再说算了 → 幂等提示，不重复改状态
        if (pending.status === 'rejected') return ctx.reply(`「${pending.title}」已是取消状态，无需再操作～`);
        updateTask(pending.id, { status: 'rejected' }, '用户放弃（评审质疑后）');
        return ctx.reply(`好的，已取消「${pending.title}」。`);
      }
```

（A 段后半的 `recordOverride(pending)` + `proceedAfterReview(pending, ctx, { overridden: true })` 不变——对 rejected 任务同样适用：bug 直接入自动开发队列，需求置回 analyzing 出方案。）

- [ ] **Step 3: 模块可加载性冒烟 + 全量测试**

Run: `node -e "import('./src/plugins/team-tools/feedback/index.js').then(() => console.log('import ok'))"`
Expected: 输出 `import ok`

Run: `npm test`
Expected: 全绿（本任务无新增测试；挽回谓词已在 Task 2 覆盖）

---

### Task 5: 可信提交人直通自动开发

**Files:**
- Modify: `src/plugins/team-tools/feedback/index.js`（handle B 段，托管等级分流前）

- [ ] **Step 1: 加 config import**

import 区追加：

```js
import { config } from '../../../shared/config.js';
```

- [ ] **Step 2: 插入直通分流**

handle 里：

```js
    const autonomy = getActiveBot()?.autonomy || 'light';
    const matsNote = mats.length ? `（已带上材料 ${mats.length} 份）` : '';
    if (autonomy === 'light') {
```

改为：

```js
    const autonomy = getActiveBot()?.autonomy || 'light';
    const matsNote = mats.length ? `（已带上材料 ${mats.length} 份）` : '';

    // 可信提交人（TRUSTED_OPEN_IDS，如老板本人）直通：不判断合理性，跳过评审门与方案生成，
    // 直接进自动开发队列（独立任务分支改码，泵在 web 进程常驻；合并仍需管理员确认）。不分托管等级。
    if (config.lark.trustedOpenIds.includes(ctx.user.id)) {
      requestAutoDevelop(withMats.id, '可信提交人直通，自动开发');
      logger.info('feedback', '可信提交人直通 → 自动开发', { id: withMats.id, openId: ctx.user.id });
      return ctx.reply(`✅ 已直接进入自动开发（独立分支，完成后通知你确认合并）。${matsNote}`);
    }

    if (autonomy === 'light') {
```

- [ ] **Step 3: 更新文件头部说明**

文件头 doc 注释：

```js
/**
 * feature: 需求 / 故障 记录（飞书「其他人」提交）。
 * 意图确定后先发即时应答（ackBug/ackFeature，取代原「已收集」文案），让用户第一秒就有反馈。
 * 轻度托管：即时应答 → 记 Task → 自动分析 → 补一句闭环回复（否则用户等不到任何后续）。
 * 中度/完全托管：先过 AI 评审门（review/）——
 *   reject=回复理由并结案；ask=质疑并等用户答复（坚持→人工覆盖判例→继续；放弃→结案）；
 *   fix=BUG 进自动开发管线；plan=生成方案（中度等 owner 确认，完全托管直接自动开发）。
 */
```

改为：

```js
/**
 * feature: 需求 / 故障 记录（飞书「其他人」提交）。
 * 意图确定后先发即时应答（ackBug/ackFeature，取代原「已收集」文案），让用户第一秒就有反馈。
 * 可信提交人（TRUSTED_OPEN_IDS）：跳过评审与方案生成，直接进自动开发队列（不分托管等级）。
 * 轻度托管：即时应答 → 记 Task → 自动分析 → 补一句闭环回复（否则用户等不到任何后续）。
 * 中度/完全托管：先过 AI 评审门（review/）——
 *   reject/ask=发「坚持修改/算了」按钮卡片（非飞书或发卡失败降级纯文本），30 分钟内文本挽回同样有效；
 *   fix=BUG 进自动开发管线；plan=生成方案（中度等 owner 确认，完全托管直接自动开发）。
 */
```

- [ ] **Step 4: 冒烟 + 全量测试**

Run: `node -e "import('./src/plugins/team-tools/feedback/index.js').then(() => console.log('import ok'))"`
Expected: `import ok`

Run: `npm test`
Expected: 全绿

---

### Task 6: 卡片回调基建（sendCard 返回值 + kind 注册表 + 入口路由）

**Files:**
- Modify: `src/integrations/lark.js`（sendCard）
- Create: `src/shared/card-actions.js`
- Modify: `src/entrypoints/feishu/index.js`（onCardAction）

- [ ] **Step 1: sendCard 返回 message_id**

`src/integrations/lark.js` 的 `sendCard`：

```js
export async function sendCard(chatId, cardContent) {
  try {
    await getClient().im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify(cardContent),
        msg_type: 'interactive',
      },
    });
    logger.info('lark', '发送卡片消息', { chatId });
  } catch (e) {
```

改为：

```js
export async function sendCard(chatId, cardContent) {
  try {
    const r = await getClient().im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify(cardContent),
        msg_type: 'interactive',
      },
    });
    logger.info('lark', '发送卡片消息', { chatId });
    // code-gen client 可能已剥外层信封（对齐 uploadImage 的兜底写法）；拿不到返回 null，调用方自行兜底
    return r?.data?.message_id || r?.message_id || null;
  } catch (e) {
```

（catch 块不动。）

- [ ] **Step 2: 新建 kind 注册表**

创建 `src/shared/card-actions.js`：

```js
/**
 * 卡片回调 kind 注册表 —— 按钮 value.kind → 处理器（如 feedback 的 review-verdict）。
 * 独立小模块而非放 feishu 入口：feedback 等插件与入口都要 import，
 * 放入口会形成 entrypoint → features → plugins → entrypoint 的环，
 * 且 web 进程 import 入口模块会误触发飞书 channel.start 等模块级副作用。
 */
const handlers = new Map();

/** 注册 kind 处理器（插件模块加载时调用；重复注册后者覆盖前者） */
export function registerCardKindHandler(kind, handler) {
  handlers.set(kind, handler);
}

/** 取 kind 处理器；未注册返回 null（如插件被停用未加载） */
export function getCardKindHandler(kind) {
  return handlers.get(kind) || null;
}
```

- [ ] **Step 3: 入口 onCardAction 加 kind 路由**

`src/entrypoints/feishu/index.js` import 区追加：

```js
import { getCardKindHandler } from '../../shared/card-actions.js';
```

把现有 `onCardAction`：

```js
async function onCardAction(data) {
  const messageId = data?.message_id;
  const handler = messageId && cardActionHandlers.get(messageId);
  if (handler) {
    try {
      await handler(data);
    } finally {
      // 处理完后删除，避免重复处理
      cardActionHandlers.delete(messageId);
    }
  } else {
    logger.warn('feishu', '未注册卡片回调处理', { messageId });
  }
}
```

替换为：

```js
async function onCardAction(data) {
  // v2 schema 的 message_id 在 context.open_message_id；顶层字段兜底（旧机制假设的形态）
  const messageId = data?.context?.open_message_id || data?.message_id || null;
  const handler = messageId && cardActionHandlers.get(messageId);
  if (handler) {
    try {
      await handler(data);
    } finally {
      // 处理完后删除，避免重复处理
      cardActionHandlers.delete(messageId);
    }
    return;
  }
  // kind 路由：按钮 value 自带 taskId 等全部上下文，无内存态 → 机器人重启后旧卡片按钮仍有效
  let value = data?.action?.value ?? null;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const kindHandler = value?.kind ? getCardKindHandler(value.kind) : null;
  if (kindHandler) {
    await kindHandler(data);
    return;
  }
  logger.warn('feishu', '未注册卡片回调处理', { messageId, kind: value?.kind || null });
}
```

- [ ] **Step 4: 全量测试**

Run: `npm test`
Expected: 全绿

（feishu 入口模块有 channel.start 副作用，不做 import 冒烟；语法由 Task 9 全量回归与人工走查兜底。）

---

### Task 7: 评审否定改发按钮卡片（含降级）

**Files:**
- Modify: `src/plugins/team-tools/feedback/index.js`（runReviewFlow + 新增 replyVerdict）

- [ ] **Step 1: 扩展 import**

logic import 行扩为：

```js
import { findReviewableTask, isReviewableTask, buildVerdictCard, verdictResultCard, parseVerdictCardAction, canOperateVerdict } from './logic.js';
```

import 区追加：

```js
import { sendCard, updateCard, sendText } from '../../../integrations/lark.js';
import { atPrefix } from '../../../shared/mention.js';
import { registerCardKindHandler } from '../../../shared/card-actions.js';
import { getTask } from '../../../store/tasks.js';
```

注意：`getTask` 并入现有行 `import { createTask, getTasks, updateTask } from '../../../store/tasks.js';` → `import { createTask, getTask, getTasks, updateTask } from '../../../store/tasks.js';`，不要重复 import 语句。（`isReviewableTask`、`verdictResultCard`、`parseVerdictCardAction`、`canOperateVerdict`、`updateCard`、`sendText`、`atPrefix`、`registerCardKindHandler`、`getTask` 供 Task 8 的回调处理器使用，此处一并加齐。）

- [ ] **Step 2: 新增 replyVerdict 送达函数**

在 `runReviewFlow` 函数之前加：

```js
/** 评审否定结论送达：飞书发「坚持修改/算了」按钮卡片；非飞书渠道或发卡失败降级纯文本 */
async function replyVerdict(task, ctx, verdict, reason, fallbackText) {
  if (ctx.source === 'feishu' && task.source?.chatId) {
    try {
      await sendCard(task.source.chatId, buildVerdictCard(task, verdict, reason));
      return;
    } catch (e) {
      logger.warn('feedback', '评审卡片发送失败，降级纯文本', { id: task.id, err: e?.message || String(e) });
    }
  }
  await ctx.reply(fallbackText);
}
```

- [ ] **Step 3: runReviewFlow 接卡片**

把：

```js
    const kind = task.type === 'bug' ? '故障' : '需求';
    if (r.verdict === 'reject') {
      updateTask(taskId, { status: 'rejected' }, '评审拒绝');
      return await ctx.reply(`❌ 该${kind}未通过评审，暂不处理：${r.reason}`);
    }
    if (r.verdict === 'ask') {
      updateTask(taskId, { status: 'challenged' }, '评审存疑，等待用户确认');
      return await ctx.reply(`🤔 关于这条${kind}，评审建议暂缓：${r.reason}\n如仍需处理请回复「坚持修改」；回复「算了」则取消。`);
    }
```

替换为：

```js
    const kind = task.type === 'bug' ? '故障' : '需求';
    if (r.verdict === 'reject') {
      updateTask(taskId, { status: 'rejected' }, '评审拒绝');
      // 纯文本降级文案补挽回指引（原文案无任何挽回入口，是「坚持修改」失效 bug 的一半根因）
      return await replyVerdict(updated, ctx, 'reject', r.reason,
        `❌ 该${kind}未通过评审，暂不处理：${r.reason}\n如仍需处理请回复「坚持修改」。`);
    }
    if (r.verdict === 'ask') {
      updateTask(taskId, { status: 'challenged' }, '评审存疑，等待用户确认');
      return await replyVerdict(updated, ctx, 'ask', r.reason,
        `🤔 关于这条${kind}，评审建议暂缓：${r.reason}\n如仍需处理请回复「坚持修改」；回复「算了」则取消。`);
    }
```

（`updated` 是本函数上文 `updateTask(taskId, { review: ... })` 的返回值，含 source/type/title/id，卡片构造所需齐全。）

- [ ] **Step 4: 冒烟 + 全量测试**

Run: `node -e "import('./src/plugins/team-tools/feedback/index.js').then(() => console.log('import ok'))"`
Expected: `import ok`

Run: `npm test`
Expected: 全绿

---

### Task 8: 卡片回调处理器（insist / giveup）

**Files:**
- Modify: `src/plugins/team-tools/feedback/index.js`（新增 onVerdictCardAction + 模块级注册）

- [ ] **Step 1: 实现回调处理器**

在 `export default {` 之前加：

```js
/**
 * 「坚持修改/算了」卡片回调（kind: review-verdict）。
 * 无内存态：taskId 从按钮 value 来，任务状态从盘上读 → 机器人重启后旧卡片按钮仍有效；
 * 幂等靠任务状态：已不在可挽回态则只更新卡片提示，不重复处理。
 * 与文本挽回（A 段）收敛到同一套动作：recordOverride + proceedAfterReview / 置 rejected。
 */
async function onVerdictCardAction(data) {
  const parsed = parseVerdictCardAction(data);
  if (!parsed) return;
  const task = getTask(parsed.taskId);
  // 终态更新卡片；拿不到 messageId（报文形态异常）只能跳过更新，动作本身照常执行
  const done = (text) =>
    parsed.messageId
      ? updateCard(parsed.messageId, verdictResultCard(text)).catch((e) =>
          logger.warn('feedback', '评审卡片更新失败', { id: parsed.taskId, err: e?.message || String(e) }),
        )
      : Promise.resolve();
  if (!task) return done('⚠️ 任务不存在或已被清理。');
  if (
    !canOperateVerdict(parsed.operatorOpenId, task, {
      trustedOpenIds: config.lark.trustedOpenIds,
      ownerOpenIds: config.lark.ownerOpenIds,
    })
  ) {
    // 群聊卡片人人可见：非提交人/白名单/owner 点击一律忽略（不回文本，避免群噪音）
    logger.info('feedback', '非授权用户点击评审卡片，忽略', { id: task.id, operator: parsed.operatorOpenId });
    return;
  }
  if (!isReviewableTask(task)) {
    return done(`ℹ️「${task.title}」已在处理中或已完结，无需重复操作。`);
  }
  if (parsed.action === 'giveup') {
    if (task.status === 'challenged') updateTask(task.id, { status: 'rejected' }, '用户放弃（评审卡片）');
    logger.info('feedback', '用户放弃（评审卡片）', { id: task.id });
    return done(`🗑 已取消「${task.title}」。`);
  }
  // insist：与文本「坚持修改」同一套动作
  recordOverride(task);
  logger.info('feedback', '用户坚持修改（评审卡片覆盖）', { id: task.id });
  await done(`✋ 已坚持修改「${task.title}」，转入处理。`);
  // 后续进度回复发回任务来源会话；群聊 @ 提交人（p2p 前缀为空串）
  const at = atPrefix(task.source?.openId, task.source?.chatType);
  const reply = (t) => sendText(task.source.chatId, at ? at + '\n' + t : String(t ?? ''));
  return proceedAfterReview(task, { reply }, { overridden: true });
}
```

- [ ] **Step 2: 模块级注册**

在 `export default {` 之前（onVerdictCardAction 定义之后）加：

```js
// 模块加载即注册（feishu/web 进程都会加载插件；web 进程无卡片事件，注册无害）。
// team-tools 停用时本模块不加载 → 回调自然落空（入口仅记 warn 日志）。
registerCardKindHandler('review-verdict', onVerdictCardAction);
```

- [ ] **Step 3: 冒烟 + 全量测试**

Run: `node -e "import('./src/plugins/team-tools/feedback/index.js').then(() => console.log('import ok'))"`
Expected: `import ok`

Run: `npm test`
Expected: 全绿

---

### Task 9: 全量回归 + 人工走查清单

**Files:** 无代码改动

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部通过（原有 264+ 与新增约 19 条）

- [ ] **Step 2: 静态自查**

逐项确认：

1. `grep -n "pendingChallenged" src/` 无残留引用；
2. `grep -n "CHALLENGE_WINDOW_MS" src/` 无残留；
3. `src/plugins/team-tools/feedback/index.js` 中 `store/tasks.js` 只有一条 import（含 getTask）；
4. `.env.example` 有 `TRUSTED_OPEN_IDS` 且注释说明与 OWNER_OPEN_IDS 的互斥关系。

- [ ] **Step 3: 输出人工走查清单（交用户执行，代码任务到此完成）**

提示用户按下列场景走查（需真实飞书环境）：

1. `.env` 配好 `TRUSTED_OPEN_IDS`（本人 open_id，不在 OWNER_OPEN_IDS），重启后本人发「提交需求：xxx」→ 收到即时应答 + 「✅ 已直接进入自动开发…」，任务进 queued，web 泵在独立分支完成后通知确认合并；
2. 非白名单账号在中度托管下提一条会被评审拒绝的需求 → 收到带「✋ 坚持修改 / 🗑 算了」按钮的卡片；
3. 点「坚持修改」→ 卡片原地变「✋ 已坚持修改…」，任务转入处理（bug 自动修 / 需求出方案）；
4. 点「算了」→ 卡片变「🗑 已取消…」；
5. 群聊里其他人点卡片按钮 → 无任何反应，日志有「非授权用户点击」记录；
6. 被拒后不点按钮，30 分钟内直接打字「坚持修改」→ 挽回生效（本次修复的 bug 场景）；打字「算了」→ 幂等提示；
7. 重启机器人进程后点击重启前发出的旧卡片按钮 → 仍生效（value 路由无内存态）；
8. web/console 渠道触发评审否定 → 收到纯文本 + 「回复坚持修改」指引（降级路径）。

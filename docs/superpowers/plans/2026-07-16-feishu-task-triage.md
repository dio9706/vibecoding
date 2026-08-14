# 飞书交互式待处理项处理流程（task-triage）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 owner 本人在飞书里通过交互式对话，批量分诊（列表 → 排序 → 逐个决策 → 后台串行开发）已有方案的待处理任务。

**Architecture:** 新增 owner 专属 feature `task-triage`，靠现有 dispatch 的 `match`（触发词进入）+ `hasPending`（会话中接管）接入，零改动路由；`analyze/develop` 抽到共享 `features/task-ops.js` 避免 app↔features 循环依赖；后台串行队列执行开发，决策不阻塞。

**Tech Stack:** Node.js (ESM)、`@larksuiteoapi/node-sdk`、`@anthropic-ai/claude-agent-sdk`、`node:test`（内置测试，零新依赖）。

**关联设计文档：** `docs/superpowers/specs/2026-07-16-feishu-task-triage-design.md`

**约定：** 全项目 ESM（`package.json` `"type":"module"`）；持久化只经 `store/`；飞书只经 `integrations/lark`；env 只经 `shared/config`。注释用中文（与现有代码库一致）。

---

## 文件结构

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/features/task-ops.js` | 创建 | 共享领域模块：`analyze(task)` / `develop(task)`（从 feedback 抽出，唯一定义处） |
| `src/features/feedback/index.js` | 修改 | 从 `task-ops.js` 引入 `analyze/develop` 并调用，删除本地定义 |
| `src/entrypoints/web/server.js` | 修改 | `analyze/develop` 的 import 源改为 `../../features/task-ops.js` |
| `src/features/task-triage/logic.js` | 创建 | 纯函数：`groupPending` / `sortForTriage` / `parseAction` / `parseYesNo` |
| `src/features/task-triage/logic.test.js` | 创建 | `node:test` 单测 |
| `src/features/task-triage/index.js` | 创建 | Feature 契约 + 会话状态机 + 后台串行队列 |
| `src/shared/config.js` | 修改 | 新增 `taskTriage` 段 |
| `src/features/index.js` | 修改 | 注册 `taskTriage`，排在 `claudeExec` 之前 |

**实现顺序（依赖驱动）：** Task 1（抽 task-ops，行为不变）→ Task 2（config）→ Task 3（纯逻辑 + 单测）→ Task 4（feature 主体）→ Task 5（注册接线）→ Task 6（联调验收）。

---

## Task 1: 抽出共享 task-ops 模块（行为不变的重构）

**Files:**
- Create: `src/features/task-ops.js`
- Modify: `src/features/feedback/index.js`
- Modify: `src/entrypoints/web/server.js:18`

这是纯搬家重构：把 `feedback/index.js` 里的 `analyze`/`develop` 原样移到 `task-ops.js`，feedback 与 web 改为引入。**行为完全不变**，靠 `node --check` + 现有功能路径验证。

- [ ] **Step 1: 创建 `src/features/task-ops.js`**

把 feedback 现有的 `analyze`/`develop` 连同它们的 import 依赖一并搬入（内容与现状逐字一致，仅换文件）：

```js
/**
 * 共享领域模块：任务的「只读分析」与「实际开发」。
 * 从 feedback 抽出，供 feedback / task-triage / web 入口共用（见 ARCHITECTURE §10 —— 协作走共享模块，不 feature 互相 import）。
 * 只依赖下层 integrations/store/shared，不注册为 feature、无 Feature 契约。
 */
import { updateTask } from '../store/tasks.js';
import { systemNotify } from '../integrations/notify.js';
import { runClaude } from '../integrations/claude.js';
import { config } from '../shared/config.js';

/** 只读分析：判断要做什么，不改任何代码 */
export async function analyze(task) {
  updateTask(task.id, { status: 'analyzing' }, '开始分析');
  const isBug = task.type === 'bug';
  let out = '';
  try {
    await runClaude(
      `用户提交了一个${isBug ? '故障/BUG' : '需求'}：\n「${task.detail}」\n\n` +
        `请分析当前代码库，判断要做什么来${isBug ? '定位并修复它' : '实现它'}。\n` +
        `⚠️ 只做分析，绝对不要修改任何文件、不要执行有副作用的命令。\n` +
        (task.fixNote ? `补充修正方案（请据此重新分析）：${task.fixNote}\n` : '') +
        `相关后端项目在：${config.feedback.backendDir}（若与后端相关可一并参考）。\n` +
        `输出格式：\n1) 要做什么（分点，具体）\n2) 涉及的文件/模块\n简洁清晰。`,
      {
        cwd: config.feedback.frontendDir,
        permissionMode: 'default',
        allowedTools: ['Read', 'Grep', 'Glob'],
        onText: (t) => (out += t),
        onResult: (i) => {
          if (!out && i.result) out = i.result;
        },
      },
    );
  } catch (e) {
    out = `分析失败：${e?.message || String(e)}`;
  }
  updateTask(task.id, { status: 'analyzed', analysis: { suggestion: out || '(无分析输出)' } }, '分析完成');
  systemNotify(
    `分析完成 ${isBug ? '[故障]' : '[需求]'}`,
    `${task.title}\n可在 web 管理台确认：开始进行 / 修正 / 放弃`,
  );
}

/** 开发：按分析在项目里实际改码（bypassPermissions），完成后可 git diff 审查 */
export async function develop(task) {
  const isBug = task.type === 'bug';
  let out = '';
  try {
    await runClaude(
      `请在当前项目实际实现这个${isBug ? '修复' : '需求'}：\n` +
        `原始反馈：「${task.detail}」\n` +
        `分析建议：\n${task.analysis?.suggestion || '(无)'}\n\n` +
        `请修改代码完成它；完成后用一段话说明你改了哪些文件、做了什么。`,
      {
        cwd: config.feedback.frontendDir,
        permissionMode: 'bypassPermissions',
        onText: (t) => (out += t),
        onResult: (i) => {
          if (!out && i.result) out = i.result;
        },
      },
    );
  } catch (e) {
    out = `开发出错：${e?.message || String(e)}`;
  }
  updateTask(task.id, { status: 'done', devLog: out || '(无输出)' }, '开发完成');
  systemNotify(`开发完成 ${isBug ? '[故障]' : '[需求]'}`, `${task.title}\n请在项目里 git diff 审查改动`);
}
```

- [ ] **Step 2: 改 `src/features/feedback/index.js` —— 删除本地定义，改为引入**

删除文件顶部对 `updateTask`/`systemNotify`/`runClaude`/`config` 里仅供 analyze/develop 用的 import 及这两个函数体，替换为从 task-ops 引入。改后文件应为：

```js
/**
 * feature: 需求 / 故障 记录（飞书「其他人」提交）。
 * 意图 bug/feature → 记 Task（标 [故障]/[需求]）→ 回「已收集」→ 系统提醒
 *   → 自动分析（analyze，只读、不改码、产出「要做什么」，见 features/task-ops.js）。
 * 后续在 web 管理台「开始进行 / 修正 / 放弃」（见 web 入口的 tasks API）。
 */
import { createTask } from '../../store/tasks.js';
import { systemNotify } from '../../integrations/notify.js';
import { analyze } from '../task-ops.js';

export default {
  name: 'feedback',
  permission: 'guest',
  intents: ['bug', 'feature'],
  handle: async (ctx, intentResult) => {
    const type = intentResult?.intent === 'bug' ? 'bug' : 'feature';
    const tag = type === 'bug' ? '[故障]' : '[需求]';
    const task = createTask({
      type,
      title: (ctx.text || '').slice(0, 40),
      detail: ctx.text || '',
      source: { openId: ctx.user.id, via: ctx.source },
    });

    await ctx.reply(`${tag} 问题/需求已收集，感谢反馈～ 后续我确认后会进行处理。`);
    systemNotify(`新${type === 'bug' ? '故障' : '需求'} ${tag}`, (ctx.text || '').slice(0, 80));

    // 异步分析，不阻塞回复
    analyze(task).catch((e) => console.error('[feedback] 分析失败:', e));
  },
};
```

> 注意：`develop` 不再由 feedback 导出。下一步 web 入口改从 task-ops 引入。

- [ ] **Step 3: 改 `src/entrypoints/web/server.js` 第 18 行 import 源**

当前：
```js
import { analyze, develop } from '../../features/feedback/index.js';
```
改为：
```js
import { analyze, develop } from '../../features/task-ops.js';
```

- [ ] **Step 4: 语法校验**

Run:
```bash
node --check src/features/task-ops.js && node --check src/features/feedback/index.js && node --check src/entrypoints/web/server.js
```
Expected: 无输出（3 个文件均通过）

- [ ] **Step 5: 验证引用图无遗漏**

Run:
```bash
grep -rn "from '../../features/feedback/index.js'" src/ ; grep -rn "feedback/index.js'" src/entrypoints/
```
Expected: 无任何结果引用 feedback 的 `develop`/`analyze`（web 已切到 task-ops；dispatch 经 features/index.js 只用 default export，不受影响）

- [ ] **Step 6: Commit**

```bash
git add src/features/task-ops.js src/features/feedback/index.js src/entrypoints/web/server.js
git commit -m "refactor: 抽 analyze/develop 到共享 task-ops 模块"
```

---

## Task 2: 新增 taskTriage 配置段

**Files:**
- Modify: `src/shared/config.js`

- [ ] **Step 1: 在 `config` 对象内、`feedback` 段之后追加 `taskTriage` 段**

在 `src/shared/config.js` 的 `feedback: { ... },` 之后、`}` 之前插入：

```js
  taskTriage: {
    // 进入待处理流程的触发词正则（env TRIAGE_TRIGGER 可覆盖）
    triggerPattern: process.env.TRIAGE_TRIGGER
      ? new RegExp(process.env.TRIAGE_TRIGGER)
      : /待处理|待办|要处理|处理一下/,
    // 可选单人白名单 open_id；空 = 沿用 lark.ownerOpenIds（满足「仅我本人」）
    ownerOpenId: (process.env.TRIAGE_OWNER_OPEN_ID || '').trim() || null,
    // 流程内意图分类兜底模型（复用 intent 的轻模型）
    classifyModel: process.env.CLASSIFY_MODEL || 'claude-sonnet-4-6',
  },
```

- [ ] **Step 2: 语法校验 + 冒烟**

Run:
```bash
node --check src/shared/config.js && node -e "import('./src/shared/config.js').then(m=>{console.log('trigger:', m.config.taskTriage.triggerPattern.test('看下待处理'), '| ownerOpenId:', m.config.taskTriage.ownerOpenId)})"
```
Expected: `trigger: true | ownerOpenId: null`

- [ ] **Step 3: Commit**

```bash
git add src/shared/config.js
git commit -m "feat(config): 新增 taskTriage 触发词/白名单配置"
```

---

## Task 3: 纯逻辑函数 + 单测（TDD）

**Files:**
- Create: `src/features/task-triage/logic.test.js`
- Create: `src/features/task-triage/logic.js`

先写测试，再写实现。4 个纯函数：`groupPending` / `sortForTriage` / `parseAction` / `parseYesNo`。

- [ ] **Step 1: 写失败测试 `src/features/task-triage/logic.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPending, sortForTriage, parseAction, parseYesNo } from './logic.js';

const mk = (o) => ({
  id: o.id,
  type: o.type || 'feature',
  title: o.title || o.id,
  status: o.status,
  createdAt: o.createdAt || '2026-01-01T00:00:00.000Z',
  analysis: o.analysis,
});

test('groupPending：按状态分「已有方案 / 分析中」，排除 done/rejected/developing', () => {
  const tasks = [
    mk({ id: 'a', status: 'analyzed', analysis: { suggestion: '方案A' } }),
    mk({ id: 'b', status: 'analyzing' }),
    mk({ id: 'c', status: 'new' }),
    mk({ id: 'd', status: 'analyzed', analysis: { suggestion: '' } }), // 空方案 → 归入分析中
    mk({ id: 'e', status: 'done' }),
    mk({ id: 'f', status: 'rejected' }),
    mk({ id: 'g', status: 'developing' }),
  ];
  const { ready, analyzing } = groupPending(tasks);
  assert.deepEqual(ready.map((t) => t.id), ['a']);
  assert.deepEqual(analyzing.map((t) => t.id).sort(), ['b', 'c', 'd']);
});

test('sortForTriage：bug 优先，同类按 createdAt 升序', () => {
  const ready = [
    mk({ id: 'f1', type: 'feature', createdAt: '2026-01-01T00:00:00.000Z' }),
    mk({ id: 'b2', type: 'bug', createdAt: '2026-01-03T00:00:00.000Z' }),
    mk({ id: 'b1', type: 'bug', createdAt: '2026-01-02T00:00:00.000Z' }),
    mk({ id: 'f2', type: 'feature', createdAt: '2026-01-04T00:00:00.000Z' }),
  ];
  assert.deepEqual(sortForTriage(ready).map((t) => t.id), ['b1', 'b2', 'f1', 'f2']);
});

test('sortForTriage：不修改原数组', () => {
  const ready = [mk({ id: 'x', type: 'feature' }), mk({ id: 'y', type: 'bug' })];
  const before = ready.map((t) => t.id);
  sortForTriage(ready);
  assert.deepEqual(ready.map((t) => t.id), before);
});

test('parseAction：关键词命中', () => {
  assert.equal(parseAction('开始处理'), 'start');
  assert.equal(parseAction('就这个'), 'start');
  assert.equal(parseAction('ok'), 'start');
  assert.equal(parseAction('放弃'), 'reject');
  assert.equal(parseAction('不做了'), 'reject');
  assert.equal(parseAction('跳过'), 'skip');
  assert.equal(parseAction('下一个'), 'skip');
  assert.equal(parseAction('补充：要考虑移动端'), 'fix');
  assert.equal(parseAction('重新分析'), 'fix');
  assert.equal(parseAction('退出'), 'exit');
  assert.equal(parseAction('结束'), 'exit');
});

test('parseAction：无关文本 → unknown（交给 Claude 兜底）', () => {
  assert.equal(parseAction('今天天气不错'), 'unknown');
  assert.equal(parseAction(''), 'unknown');
});

test('parseAction：extractFixNote 取「补充」后的正文', () => {
  const r = parseAction('补充：要考虑移动端', { withNote: true });
  assert.equal(r.action, 'fix');
  assert.equal(r.note, '要考虑移动端');
});

test('parseYesNo', () => {
  assert.equal(parseYesNo('开始'), 'yes');
  assert.equal(parseYesNo('好的'), 'yes');
  assert.equal(parseYesNo('取消'), 'no');
  assert.equal(parseYesNo('先不了'), 'no');
  assert.equal(parseYesNo('嗯嗯天气'), 'unknown');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
node --test src/features/task-triage/logic.test.js
```
Expected: FAIL —— `Cannot find module './logic.js'`（文件尚未创建）

- [ ] **Step 3: 写实现 `src/features/task-triage/logic.js`**

```js
/**
 * task-triage 纯逻辑（无副作用，可单测）：分组 / 排序 / 意图解析。
 * 意图解析走「关键词优先」，未命中返回 unknown 交由 feature 层用 Claude 兜底（省额度）。
 */

/** 未完结且有非空方案 = ready；new/analyzing 或空方案 = analyzing；其余(done/rejected/developing)剔除 */
export function groupPending(tasks) {
  const ready = [];
  const analyzing = [];
  for (const t of tasks) {
    if (t.status === 'analyzed' && t.analysis?.suggestion) ready.push(t);
    else if (t.status === 'new' || t.status === 'analyzing') analyzing.push(t);
    else if (t.status === 'analyzed') analyzing.push(t); // analyzed 但方案为空 → 视为仍需分析
  }
  return { ready, analyzing };
}

/** bug 优先，同类按 createdAt 升序；返回新数组，不改入参 */
export function sortForTriage(ready) {
  return [...ready].sort((a, b) => {
    const ab = a.type === 'bug' ? 0 : 1;
    const bb = b.type === 'bug' ? 0 : 1;
    if (ab !== bb) return ab - bb;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

/**
 * 解析流程内动作。命中关键词返回 action；未命中返回 'unknown'。
 * @param {string} text
 * @param {{withNote?:boolean}} [opts] withNote=true 时返回 { action, note }
 */
export function parseAction(text, opts = {}) {
  const s = (text || '').trim();
  let action = 'unknown';
  if (/退出|结束|取消|停止|停$/.test(s)) action = 'exit';
  else if (/补充|修正|重新分析|不对|不太对/.test(s)) action = 'fix';
  else if (/跳过|下一个|skip|先不看/.test(s)) action = 'skip';
  else if (/放弃|拒绝|不做|不用了|算了|不要/.test(s)) action = 'reject';
  else if (/开始|处理|好的|好$|可以|就这个|就它|ok|OK|^1$|确认|干/.test(s)) action = 'start';

  if (!opts.withNote) return action;
  let note = '';
  if (action === 'fix') {
    // 取「补充/修正」等词之后的正文（去掉前导标点）
    note = s.replace(/^.*?(补充|修正|重新分析|不对|不太对)[：:，,\s]*/, '').trim();
  }
  return { action, note };
}

/** 解析 listed 步的是否开始。yes/no/unknown */
export function parseYesNo(text) {
  const s = (text || '').trim();
  if (/取消|不了|先不|不用|放弃|no|停/.test(s)) return 'no';
  if (/开始|好|可以|行|嗯|确认|继续|yes|ok|OK|^1$/.test(s)) return 'yes';
  return 'unknown';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
node --test src/features/task-triage/logic.test.js
```
Expected: PASS —— 所有测试通过（`# pass 8` 或类似，0 fail）

- [ ] **Step 5: Commit**

```bash
git add src/features/task-triage/logic.js src/features/task-triage/logic.test.js
git commit -m "feat(task-triage): 分组/排序/意图解析纯函数 + 单测"
```

---

## Task 4: task-triage feature 主体（会话状态机 + 后台串行队列）

**Files:**
- Create: `src/features/task-triage/index.js`

依赖 Task 1（task-ops.develop）、Task 2（config.taskTriage）、Task 3（logic 纯函数）。

- [ ] **Step 1: 写 `src/features/task-triage/index.js`**

```js
/**
 * feature: 待处理项交互式处理（owner 专属，飞书入口）。
 * 触发词进入 → 列分组列表并询问 → 按「故障优先+时间」逐个呈现已有方案项
 *   → owner 决策（开始/补充/放弃/跳过/退出，支持自然语言）→「开始」入后台串行队列改码。
 * 决策不阻塞；开发严格串行（避免并发改同一代码库冲突）。会话/队列均为内存态。
 */
import { getTasks, getTask, updateTask } from '../../store/tasks.js';
import { sendText } from '../../integrations/lark.js';
import { runClaude } from '../../integrations/claude.js';
import { config } from '../../shared/config.js';
import { develop, analyze } from '../task-ops.js';
import { groupPending, sortForTriage, parseAction, parseYesNo } from './logic.js';

// openId → 会话
const sessions = new Map();

// ---- 后台串行开发队列（模块级，纯内存）----
const devQueue = []; // 待开发 taskId
let devRunning = false;
let notifyChatId = null;

function enqueueDevelop(taskId, chatId) {
  devQueue.push(taskId);
  notifyChatId = chatId;
  pumpQueue();
}

async function pumpQueue() {
  if (devRunning || !devQueue.length) return;
  devRunning = true;
  const task = getTask(devQueue.shift());
  if (!task) {
    devRunning = false;
    return pumpQueue();
  }
  try {
    await develop(task);
    await sendText(notifyChatId, `✅ 已完成开发：${task.title}\n请在项目里 git diff 审查改动`).catch(() => {});
  } catch (e) {
    await sendText(notifyChatId, `❌ 开发失败：${task.title}\n${e?.message || String(e)}`).catch(() => {});
  } finally {
    devRunning = false;
    pumpQueue();
  }
}

// ---- 意图兜底：关键词未命中时用 Claude 判 action ----
async function classifyAction(text) {
  let out = '';
  try {
    await runClaude(text, {
      model: config.taskTriage.classifyModel,
      systemPrompt: {
        type: 'custom',
        custom:
          '你是待处理项处理流程的动作分类器。仅输出一行 JSON，不要任何解释。\n' +
          'action 取值：start（同意开始开发当前项）、reject（放弃当前项）、' +
          'skip（跳过当前项、暂不处理）、fix（要补充说明/重新分析）、exit（退出整个流程）、other。\n' +
          '严格输出：{"action":"start|reject|skip|fix|exit|other"}',
      },
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      onText: (t) => (out += t),
      onResult: (i) => {
        if (!out && i.result) out = i.result;
      },
    });
  } catch {
    /* 落 unknown */
  }
  const m = out.match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (['start', 'reject', 'skip', 'fix', 'exit'].includes(j.action)) return j.action;
    } catch {
      /* ignore */
    }
  }
  return 'unknown';
}

// ---- 判断是否 triage owner ----
function isTriageOwner(ctx) {
  if (config.taskTriage.ownerOpenId) return ctx.user.id === config.taskTriage.ownerOpenId;
  return ctx.user.role === 'owner';
}

// ---- 呈现列表文本 ----
function renderList(ready, analyzing) {
  const lines = [`📋 待处理共 ${ready.length + analyzing.length} 项`];
  lines.push(`✅ 已有方案（${ready.length}）`);
  sortForTriage(ready).forEach((t, i) => {
    lines.push(`  ${i + 1}. ${t.type === 'bug' ? '[故障]' : '[需求]'} ${t.title}`);
  });
  if (analyzing.length) {
    lines.push(`🕒 分析中（${analyzing.length}）`);
    analyzing.forEach((t) => {
      lines.push(`  · ${t.type === 'bug' ? '[故障]' : '[需求]'} ${t.title}`);
    });
  }
  lines.push(`——— 要开始处理「已有方案」的 ${ready.length} 项吗？（开始 / 取消）`);
  return lines.join('\n');
}

// ---- 呈现当前待决策项；返回 false 表示队列已空（应结束）----
async function presentCurrent(sess, reply) {
  while (sess.cursor < sess.queue.length) {
    const task = getTask(sess.queue[sess.cursor]);
    // 双端并发：已被 web 管理台改动 → 跳过
    if (!task || task.status !== 'analyzed' || !task.analysis?.suggestion) {
      sess.cursor += 1;
      continue;
    }
    const n = sess.cursor + 1;
    const total = sess.queue.length;
    const tag = task.type === 'bug' ? '[故障]' : '[需求]';
    const plan = (task.analysis.suggestion || '').slice(0, 600);
    await reply(
      `（${n}/${total}）${tag} ${task.title}\n💡 方案：${plan}\n` +
        `——— 开始处理 / 补充<说明> / 放弃 / 跳过 / 退出`,
    );
    return true;
  }
  return false;
}

async function finish(sess, reply) {
  const s = sess.stats;
  const queued = devQueue.length + (devRunning ? 1 : 0);
  await reply(
    `✅ 本轮处理完毕：开始 ${s.started} · 放弃 ${s.rejected} · 跳过 ${s.skipped} · 重新分析 ${s.refixed}\n` +
      (queued ? `后台开发队列还有 ${queued} 个在排队，完成后我逐个告诉你。` : `没有后台开发任务。`),
  );
}

export default {
  name: 'task-triage',
  permission: 'owner',
  intents: [],
  // 有会话中：接管 owner 的任何消息
  hasPending: (ctx) => isTriageOwner(ctx) && sessions.has(ctx.user.id),
  // 无会话时：仅 owner + 触发词命中才进入（否则落到 claude-exec）
  match: (ctx) => isTriageOwner(ctx) && config.taskTriage.triggerPattern.test(ctx.text || ''),
  handle: async (ctx) => {
    const userId = ctx.user.id;
    const reply = ctx.reply;
    const text = (ctx.text || '').trim();
    const chatId = ctx.meta?.chatId || ctx.sessionKey;
    let sess = sessions.get(userId);

    // === A. 无会话（match 触发进入）→ 列表 ===
    if (!sess) {
      const { ready, analyzing } = groupPending(getTasks());
      if (!ready.length && !analyzing.length) return reply('🎉 当前没有待处理项。');
      await reply(renderList(ready, analyzing));
      if (!ready.length) {
        return reply('目前没有「已有方案」的项可处理（都还在分析中）。稍后再发「待处理」查看。');
      }
      sessions.set(userId, {
        step: 'listed',
        chatId,
        queue: sortForTriage(ready).map((t) => t.id),
        cursor: 0,
        stats: { started: 0, rejected: 0, skipped: 0, refixed: 0 },
      });
      return;
    }

    // === B. listed：是否开始 ===
    if (sess.step === 'listed') {
      let yn = parseYesNo(text);
      if (yn === 'unknown') {
        // 兜底：把 start/exit 也纳入
        const a = parseAction(text);
        yn = a === 'start' ? 'yes' : a === 'exit' ? 'no' : 'unknown';
      }
      if (yn === 'no') {
        sessions.delete(userId);
        return reply('已取消。需要时再发「待处理」。');
      }
      if (yn === 'yes') {
        sess.step = 'reviewing';
        const has = await presentCurrent(sess, reply);
        if (!has) {
          await finish(sess, reply);
          sessions.delete(userId);
        }
        return;
      }
      return reply('回复「开始」进入逐个处理，或「取消」结束。');
    }

    // === C. awaiting_fix_note：收集补充说明 ===
    if (sess.step === 'awaiting_fix_note') {
      const note = text;
      const task = getTask(sess.queue[sess.cursor]);
      if (task) {
        updateTask(task.id, { fixNote: note, status: 'analyzing' }, '补充修正方案，重新分析');
        analyze(getTask(task.id)).catch((e) => console.error('[task-triage] 重新分析失败:', e));
        sess.stats.refixed += 1;
      }
      sess.step = 'reviewing';
      sess.cursor += 1;
      await reply('已记录补充说明，正在后台重新分析。继续下一个。');
      const has = await presentCurrent(sess, reply);
      if (!has) {
        await finish(sess, reply);
        sessions.delete(userId);
      }
      return;
    }

    // === D. reviewing：对当前项决策 ===
    if (sess.step === 'reviewing') {
      const parsed = parseAction(text, { withNote: true });
      let action = parsed.action;
      if (action === 'unknown') action = await classifyAction(text);
      if (action === 'unknown') {
        return reply('没太懂～请回复：开始处理 / 补充<说明> / 放弃 / 跳过 / 退出。');
      }

      const task = getTask(sess.queue[sess.cursor]);

      if (action === 'exit') {
        await finish(sess, reply);
        sessions.delete(userId);
        return;
      }

      if (action === 'start') {
        if (task) {
          updateTask(task.id, { status: 'developing' }, '确认开始开发（飞书 triage）');
          enqueueDevelop(task.id, chatId);
          sess.stats.started += 1;
          await reply(`👌 已加入后台开发队列：${task.title}`);
        }
        sess.cursor += 1;
      } else if (action === 'reject') {
        if (task) {
          updateTask(task.id, { status: 'rejected' }, '放弃（飞书 triage）');
          sess.stats.rejected += 1;
          await reply(`🗑 已放弃：${task.title}`);
        }
        sess.cursor += 1;
      } else if (action === 'skip') {
        sess.stats.skipped += 1;
        await reply('⏭ 已跳过（保留方案，下次仍会出现）。');
        sess.cursor += 1;
      } else if (action === 'fix') {
        if (parsed.note) {
          // 「补充<内容>」一步到位
          if (task) {
            updateTask(task.id, { fixNote: parsed.note, status: 'analyzing' }, '补充修正方案，重新分析');
            analyze(getTask(task.id)).catch((e) => console.error('[task-triage] 重新分析失败:', e));
            sess.stats.refixed += 1;
          }
          sess.cursor += 1;
          await reply('已记录补充说明，正在后台重新分析。继续下一个。');
        } else {
          // 只说「补充」→ 追问内容，不推进 cursor
          sess.step = 'awaiting_fix_note';
          return reply('请发送要补充的说明（将据此重新分析）：');
        }
      }

      const has = await presentCurrent(sess, reply);
      if (!has) {
        await finish(sess, reply);
        sessions.delete(userId);
      }
      return;
    }

    // 兜底：异常状态 → 重置
    sessions.delete(userId);
    return reply('会话状态异常，已重置。请重新发「待处理」。');
  },
};
```

- [ ] **Step 2: 语法校验**

Run:
```bash
node --check src/features/task-triage/index.js
```
Expected: 无输出（通过）

- [ ] **Step 3: Commit**

```bash
git add src/features/task-triage/index.js
git commit -m "feat(task-triage): 会话状态机 + 后台串行开发队列"
```

---

## Task 5: 注册 feature（接线）

**Files:**
- Modify: `src/features/index.js`

- [ ] **Step 1: 在 `src/features/index.js` 注册 taskTriage，排在 claudeExec 之前**

改后文件为：

```js
/**
 * 功能模块注册表 —— 新增功能时在此登记即可（见 ARCHITECTURE §5）。
 * 顺序影响匹配优先级：owner 兜底(match) / 意图匹配(intents) 由 dispatch 统一处理。
 */
import taskTriage from './task-triage/index.js';
import claudeExec from './claude-exec/index.js';
import dataCleanup from './data-cleanup/index.js';
import feedback from './feedback/index.js';

export const features = [
  taskTriage, // owner：待处理项交互处理（触发词进入；排在 claude-exec 前以抢占 match）
  claudeExec, // owner 全接
  dataCleanup, // 其他人：清理数据
  feedback, // 其他人：提交需求/故障
  // 后续：qrcode / dev-task / doc-driven
];
```

- [ ] **Step 2: 语法校验 + 加载校验**

Run:
```bash
node --check src/features/index.js && node -e "import('./src/features/index.js').then(m=>{const f=m.features.map(x=>x.name);console.log(f.join(',')); if(f.indexOf('task-triage')>=f.indexOf('claude-exec')) process.exit(1)})"
```
Expected: 打印 `task-triage,claude-exec,data-cleanup,feedback`，且退出码 0（task-triage 在 claude-exec 之前）

- [ ] **Step 3: 全量测试回归**

Run:
```bash
node --test src/features/task-triage/logic.test.js
```
Expected: PASS，0 fail

- [ ] **Step 4: Commit**

```bash
git add src/features/index.js
git commit -m "feat(task-triage): 注册 feature（排在 claude-exec 前）"
```

---

## Task 6: 联调验收（手动，飞书）

**Files:** 无（手动验证 + 记录）

自动化到此为止（纯逻辑已单测，副作用部分靠联调）。按 §10 验收标准逐条手测。

- [ ] **Step 1: 启动飞书入口**

Run:
```bash
node --env-file=.env feishu.js
```
Expected: 打印「飞书 bot 已启动（长连接）」，无报错

- [ ] **Step 2: 验证进入与权限（验收 1）**

- owner 本人发「看下待处理」→ 收到分组列表 + 「要开始处理…吗」询问。
- （若有第二个非 owner 账号）guest 发「待处理」→ **不进入**该流程（走 data-cleanup/feedback/帮助）。
- owner 发普通话（如「cwd: xxx 跑个命令」）→ 仍走完整 claude-exec，不被拦截。

- [ ] **Step 3: 验证逐个决策不阻塞（验收 2/3/4）**

- 回「开始」→ 按故障优先顺序出现第 1 项（含方案摘要）。
- 对第 1 项回「开始处理」→ 立即回「已加入后台开发队列」并**马上**呈现第 2 项（不等开发完）。
- 对第 2 项回「放弃」→ 回「已放弃」并出现第 3 项。
- 观察：后台开发**串行**执行，每个完成后收到「✅ 已完成开发」通知。

- [ ] **Step 4: 验证补充/退出/汇总（验收 5）**

- 某项回「补充：要兼容移动端」→ 回「已记录…后台重新分析」并进入下一项。
- 某项只回「补充」→ 追问「请发送要补充的说明」，发送后继续。
- 回「退出」→ 输出本轮汇总（开始/放弃/跳过/重新分析计数 + 队列剩余）。

- [ ] **Step 5: 验证边界**

- 处理中再发一次「待处理」→ 覆盖重置为新列表。
- 无任何 analyzed 项时发「待处理」→ 提示「都还在分析中」。

- [ ] **Step 6: 记录联调结果**

在本文件末尾追加一节「## 联调记录（YYYY-MM-DD）」，记录每条验收项的实际结果（通过/问题）。若发现 bug，回到对应 Task 修复并补测。

---

## 验收标准（对应设计文档 §10）

1. owner 发触发词 → 分组列表 + 询问；guest 不进入。
2. 「开始」→ 故障优先 + 时间顺序逐个呈现（含方案摘要）。
3. 决策（开始/放弃/跳过/补充/退出，含自然语言）行为正确，且不被开发阻塞。
4. 「开始」的任务后台串行开发，各自完成后飞书通知。
5. 全部过完 → 本轮汇总（计数 + 队列剩余）。
6. `logic.test.js` 全绿；`node --check` 无语法错误；owner 日常 Claude 指令不受影响。

---

## 联调记录（2026-07-16）

### 已完成的自动化验证 ✅
- 7 个改动文件 `node --check` 全部通过。
- `logic.test.js` 单测 11/11 通过（含否定误判、confirmed 状态、空数组等负向边界）。
- 路由集成冒烟（mock ctx，不连飞书/不触发 Claude）：owner+触发词 → match=true 进入；owner 普通消息 → match=false 落 claude-exec；guest → 不进入；无会话 hasPending=false；契约完整。→ **验收标准 1（仅 owner 触发）在路由层通过**。
- feature 注册顺序：`task-triage > claude-exec > data-cleanup > feedback`，task-triage 抢占正确。

### 两级审查结论
- Task1/3/4 各经 spec 合规 + 代码质量两级审查；最终整体审查结论 **Ready**。
- 审查发现并已修复的真实问题：① `parseYesNo/parseAction` 否定词（不行/不好）被误判为 yes/start；② `develop` 失败被误报为「✅ 已完成」（改为返回 `{ok,log}`）；③ chatId 随任务入队防覆盖；④ pumpQueue 幂等闸防重复改码。

### 待用户手动联调（需 .env 飞书凭证 + owner 账号，会真实调用 Claude 改码）
- [ ] 验收 2：owner 发触发词 → 分组列表 + 询问；guest 发同样话不进入。
- [ ] 验收 3：回「开始」→ 故障优先逐个呈现；决策不被开发阻塞（回「开始」立即出下一项）。
- [ ] 验收 4：「开始」的任务后台**串行**改码，各自完成后飞书通知（成功 ✅ / 失败 ❌）。
- [ ] 验收 5：「补充<说明>」（一步到位）与只说「补充」（追问）两形态；「退出」输出汇总。
- [ ] 边界：处理中再发「待处理」覆盖重置；无 analyzed 项时提示「都在分析中」。
- [ ] 并发：triage 进行中用 web 管理台并发 start/reject 同一任务，验证 presentCurrent 自动跳过。

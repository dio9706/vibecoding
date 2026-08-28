# Claude 提问 → 结构化选择 UI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude 遇到需要用户拍板的问题时，把它渲染成可点选的卡片，而不是退化成在正文里列「1. 2. 3.」等用户手打。

**Architecture:** 三处小改动，无新模块。`parseDialog`（纯函数）加一个 `questions[]` 分支认出 `AskUserQuestion` 的 payload；`supportedDialogKinds` 删掉三个查无此物的死 kind；`onUserDialog` 落一条完整 payload 日志作为观测兜底。前端 `renderAskCard` 已支持 N 个带说明的选项，**零改动**。

**Tech Stack:** Node 原生 `node:test`；`@anthropic-ai/claude-agent-sdk@0.3.210` 的 `onUserDialog` / `UserDialogResult` 契约。

**依据 spec:** `docs/superpowers/specs/2026-08-28-ask-user-question-ui-design.md`

**提交纪律:** 改动留工作区，**不要执行 git commit**。每个 Task 末步是自检。

**关于「押注」:** `UserDialogRequest.payload` 的类型是 `Record<string, unknown>`，协议注释明说 per-dialogKind 不透明，静态无法确定字段路径。本计划按 `AskUserQuestionInput` 的 schema 实现，押错的下限等于现状（认不出 → `cancelled` → Claude 退回正文列 1.2.3.），不会更坏；Task 2 的日志会给出真实形状供校准。**这一点在实现时不要试图"消除不确定性"，它已被有意识地接受。**

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/entrypoints/web/tool-summary.js` | 修改 | `parseDialog` 加 `questions[]` 分支（认 `AskUserQuestion` 结构） |
| `src/entrypoints/web/tool-summary.test.js` | 创建 | `parseDialog` 单测（该模块目前无测试） |
| `src/entrypoints/web/run-claude.js` | 修改 | `supportedDialogKinds` 收敛；`onUserDialog` 落 payload 观测日志 |

Task 1 是主体（可独立验收），Task 2 是配套的收敛与观测。

---

### Task 1: `parseDialog` 认出 AskUserQuestion 结构

**Files:**
- Modify: `src/entrypoints/web/tool-summary.js:54-76`
- Create: `src/entrypoints/web/tool-summary.test.js`

- [ ] **Step 1: 写失败测试**

新建 `src/entrypoints/web/tool-summary.test.js`：

```js
/**
 * dialog payload 解析。
 *
 * 为什么这条重要：Claude 需要用户拍板时会调 AskUserQuestion 工具，CLI 据此向宿主发
 * request_user_dialog。宿主答不出来（parseDialog 返回 null → behavior:'cancelled'）时，
 * CLI 按 sdk.d.ts:3369 的约定 fail closed，把 dialog-gated 流程退化成 no-dialog 行为 ——
 * 表现就是 Claude 只能在正文里列「1. 2. 3.」让用户手打回答（2026-08-28 实测形态）。
 *
 * AskUserQuestionInput 的 schema（sdk-tools.d.ts:800）：
 *   questions[1-4] { question, header, options[2-4]{ label, description, preview? }, multiSelect? }
 * 旧实现只猜 p.options / p.choices / p.answers，认不出这层 questions 嵌套。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDialog } from './tool-summary.js';

/** 造一条最简 AskUserQuestion payload */
const askPayload = (over = {}) => ({
  questions: [
    {
      question: '状态放 Context 还是 Zustand？',
      header: '状态方案',
      options: [
        { label: 'Context', description: '零依赖，跨层更新会重渲染' },
        { label: 'Zustand', description: '选择性订阅，多一个依赖' },
      ],
      ...over,
    },
  ],
});

test('标准 AskUserQuestion payload → 解析出问句与带说明的选项', () => {
  const d = parseDialog({ dialogKind: 'ask_user_question', payload: askPayload() });
  assert.ok(d, '认不出就会被 cancelled，Claude 只能退回正文列 1.2.3.');
  assert.equal(d.title, '❓ 状态放 Context 还是 Zustand？');
  assert.equal(d.body, '', 'header 是 ≤12 字符的 chip 标签，当正文读是噪音；问句已在 title');
  assert.equal(d.options.length, 2);
  assert.deepEqual(
    d.options.map((o) => [o.id, o.label, o.desc]),
    [
      ['0', 'Context', '零依赖，跨层更新会重渲染'],
      ['1', 'Zustand', '选择性订阅，多一个依赖'],
    ],
  );
});

test('toResult 按 AskUserQuestionOutput 形状回传选中项的 label', () => {
  const d = parseDialog({ dialogKind: 'ask_user_question', payload: askPayload() });
  const out = d.toResult('1');
  assert.deepEqual(out.questions[0].answers, ['Zustand']);
  assert.equal(out.questions[0].question, '状态放 Context 还是 Zustand？', '原问题字段须原样带回');
  assert.equal(out.questions[0].header, '状态方案');
});

test('toResult 收到未知 id → 回落为该 id 原值，不抛', () => {
  const d = parseDialog({ dialogKind: 'ask_user_question', payload: askPayload() });
  assert.deepEqual(d.toResult('99').questions[0].answers, ['99']);
});

test('多问 payload → 只呈现第一问（不自攒队列，剩下的靠 CLI 下一轮再发）', () => {
  const payload = {
    questions: [
      { question: '第一问？', header: 'A', options: [{ label: 'a1', description: '' }, { label: 'a2', description: '' }] },
      { question: '第二问？', header: 'B', options: [{ label: 'b1', description: '' }, { label: 'b2', description: '' }] },
      { question: '第三问？', header: 'C', options: [{ label: 'c1', description: '' }, { label: 'c2', description: '' }] },
    ],
  };
  const d = parseDialog({ dialogKind: 'ask_user_question', payload });
  assert.equal(d.title, '❓ 第一问？');
  assert.deepEqual(d.options.map((o) => o.label), ['a1', 'a2']);
});

test('multiSelect 降级为单选（本轮不做多选，答一项也能让 Claude 继续）', () => {
  const d = parseDialog({ dialogKind: 'ask_user_question', payload: askPayload({ multiSelect: true }) });
  assert.equal(d.options.length, 2);
  assert.deepEqual(d.toResult('0').questions[0].answers, ['Context']);
});

test('option 缺 description → desc 为空串，不是 undefined（渲染层按真值判断是否加副行）', () => {
  const payload = { questions: [{ question: 'Q？', header: 'H', options: [{ label: 'x' }, { label: 'y' }] }] };
  const d = parseDialog({ dialogKind: 'ask_user_question', payload });
  assert.deepEqual(d.options.map((o) => o.desc), ['', '']);
});

test('questions 存在但 options 空/缺失 → 回落旧分支；两者都无 → null', () => {
  // options 空数组 + 无旧字段 → null
  assert.equal(parseDialog({ payload: { questions: [{ question: 'Q？', options: [] }] } }), null);
  // options 缺失但有旧式 p.options → 走旧分支
  const d = parseDialog({ payload: { questions: [{ question: 'Q？' }], options: ['甲', '乙'] } });
  assert.ok(d, '新分支不该把旧结构挡掉');
  assert.deepEqual(d.options.map((o) => o.label), ['甲', '乙']);
});

test('旧结构 p.options 行为不变（回归保护）', () => {
  const d = parseDialog({ dialogKind: 'x', payload: { question: '选一个', options: ['甲', '乙'] } });
  assert.equal(d.title, '❓ 选一个');
  assert.deepEqual(d.options.map((o) => o.label), ['甲', '乙']);
  assert.equal(d.toResult('0'), '甲', '旧分支的 toResult 回传原始选项，保持原契约');
});

test('questions 非数组 / payload 空 / 无 payload → null，不抛', () => {
  assert.equal(parseDialog({ payload: { questions: 'nope' } }), null);
  assert.equal(parseDialog({ payload: {} }), null);
  assert.equal(parseDialog({}), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test src/entrypoints/web/tool-summary.test.js`
Expected: FAIL — 前 6 条挂在「认不出就会被 cancelled」等断言上（`parseDialog` 对 `questions` 结构返回 `null`）；最后两条「旧结构回归保护」「非法入参」应已通过

- [ ] **Step 3: 最小实现**

`src/entrypoints/web/tool-summary.js` 的 `parseDialog` 里，在现有 `const rawOpts = ...` **之前**插入新分支。改动后完整函数：

```js
/** 尽力从 dialog payload 解析出可渲染的问题/选项；结构不认识返回 null（→ cancelled） */
export function parseDialog(request) {
  const p = request.payload || {};
  // ---- AskUserQuestion（Claude 主动向用户拍板）----
  // 这个结构比下面的旧猜测更具体，必须先匹配：它的选项藏在 questions[].options 里，
  // 旧的 p.options 猜测认不出这层嵌套，于是每次 Claude 提问都被静默 cancelled ——
  // CLI 随后 fail closed 退化成 no-dialog 行为，表现为 Claude 在正文里列「1. 2. 3.」等人手打。
  // schema 见 sdk-tools.d.ts:800 AskUserQuestionInput。
  const q = Array.isArray(p.questions) ? p.questions[0] : null;
  if (q && Array.isArray(q.options) && q.options.length) {
    const options = q.options.map((o, i) => ({
      id: String(i),
      label: o?.label || String(i),
      desc: o?.description || '',
    }));
    return {
      // header 是 ≤12 字符的 chip 标签（如「状态方案」），当正文读是噪音；问句已在 title
      title: '❓ ' + String(q.question || '请选择'),
      body: '',
      options,
      // 按 AskUserQuestionOutput（sdk-tools.d.ts:3175）形状回传：输入结构原样 + answers。
      // multiSelect 本轮降级单选，answers 恒为单元素数组 —— 语义上是「多选题只答了一项」，
      // Claude 能继续；比压根不呈现好。
      toResult: (choice) => {
        const opt = options.find((x) => x.id === choice);
        return { questions: [{ ...q, answers: [opt ? opt.label : choice] }] };
      },
    };
  }
  // ---- 旧的通用猜测（保留：其它 dialogKind 可能是扁平结构）----
  const question = p.question || p.message || p.prompt || p.title || request.dialogKind || '请选择';
  const rawOpts = p.options || p.choices || p.answers || null;
  if (Array.isArray(rawOpts) && rawOpts.length) {
    const options = rawOpts.map((o, i) => ({
      id: String(i),
      label: typeof o === 'string' ? o : o.label || o.title || o.name || String(o.value ?? i),
      desc: typeof o === 'string' ? '' : o.description || o.desc || '',
      _raw: o,
    }));
    return {
      title: '❓ ' + String(question),
      body: p.description || '',
      options,
      toResult: (choice) => {
        const opt = options.find((x) => x.id === choice);
        return opt ? opt._raw : choice; // 尽力回传原始选项对象
      },
    };
  }
  return null;
}
```

注意新分支**不带 `_raw`**：`toResult` 直接用 `q` 与 `label` 构造输出，不需要单个选项的原始对象。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/entrypoints/web/tool-summary.test.js`
Expected: PASS，9 条全绿

- [ ] **Step 5: 自检（不提交）**

确认 `summarizeTool` 等同文件其它导出未被牵连：

Run: `node --test src/entrypoints/web/tool-summary.test.js src/entrypoints/web/routes-run.test.js`
Expected: 全绿

---

### Task 2: 收敛 dialogKind + 落 payload 观测日志

**Files:**
- Modify: `src/entrypoints/web/run-claude.js:111-117`（`supportedDialogKinds`）
- Modify: `src/entrypoints/web/run-claude.js:162-176`（`onUserDialog`）

- [ ] **Step 1: 收敛 supportedDialogKinds**

把 `run-claude.js:111` 起的五项：

```js
    supportedDialogKinds: [
      'refusal_fallback_prompt',
      'ask_user_question',
      'user_question',
      'question',
      'multiple_choice',
    ],
```

改为：

```js
    // 只声明查得到实据的 kind。CLI 把「未声明」当作「宿主渲染不了」并 fail closed
    //（sdk.d.ts:3369），所以多声明不会让 dialog 多发出来，只会让人误以为已经适配过。
    // 核查结论（SDK 0.3.210 bundle + claude.exe 字符串）：
    //   refusal_fallback_prompt —— SDK 3 处 / CLI 14 处，类型注释里明确举例
    //   ask_user_question       —— CLI 侧有完整提问闭环遥测（tengu_ask_user_question_*）
    //   user_question / question / multiple_choice —— 两侧均查无此物，已删
    supportedDialogKinds: ['refusal_fallback_prompt', 'ask_user_question'],
```

- [ ] **Step 2: 落 payload 观测日志**

`run-claude.js:162` 的 `onUserDialog` 里，在 `appendEvent` 之后加一行 `logger.info`：

```js
    onUserDialog: async (request) => {
      appendEvent({ type: 'dialog', dialogKind: request.dialogKind }); // 记录真实 kind，便于后续精确适配
      // payload 是 per-dialogKind 的不透明结构（UserDialogRequest.payload: Record<string, unknown>），
      // 静态拿不到形状，这条日志是唯一途径。走 logger 而不是 event-log：后者只留 3 天、封顶 1000 条，
      // 而每个 API 请求都记一条 access —— dialog 记录会被洪流挤干净（实测 1497 行日志全是 access，
      // type=dialog 一条不剩，这正是「dialogKind 待观测项」一直观测不到的原因）。
      logger.info('claude', 'onUserDialog', {
        dialogKind: request.dialogKind,
        payload: request.payload,
      });
      const parsed = parseDialog(request);
      if (!parsed) return { behavior: 'cancelled' };
      // ...以下不变
```

`logger` 已在该文件顶部导入（`run-claude.js:2`），无需补 import。

- [ ] **Step 3: 确认改动没破坏模块加载**

Run: `node -e "import('./src/entrypoints/web/run-claude.js').then(()=>console.log('模块加载 OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `模块加载 OK`

- [ ] **Step 4: 自检（不提交）**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 2` —— 仅 `public/js/chat.path.test.js` 的两条 `.md` 图标断言（期望 📄 实得 📝）。这是 HEAD `013663a` 起的既有红，与本计划无关，**不要去"修"它**。

Run: `git status --short`
Expected: 3 个文件为 M/??，**无 commit**

---

## 验收（spec §6）

**前提：需真实消耗额度。** 2026-08-28 当天账号处于 `out_of_credits` / `five_hour` 限流（日志里每条 run 都带 `overageStatus:"rejected"`），须等额度恢复后再做。

1. 起服务，在会话里给 Claude 一个明确需要拍板的任务，例如：

   > 这个组件的状态放 Context 还是 Zustand？先问我，别自己定。

2. 观察聊天区是否出现 ask 卡片，选项是否带说明副行
3. 点一个选项 → Claude 应按所选继续，且**不再**在正文里重复列选项
4. **无论成败都要做**：查 `logs/app-<date>.log` 里的 `onUserDialog` 行，记下真实 `dialogKind` 与 `payload` 形状
5. 按第 4 步结果判定：
   - **完全没有 `onUserDialog` 日志** → `ask_user_question` 不是真实 kind，或 headless 下 CLI 压根不为该工具发 dialog。此路不通，把结论回写到 spec §4，Task 1 的解析代码留着无害（认不出即 `null`，等同现状）
   - **有日志但没出卡片** → kind 对、payload 形状不对。按日志里的真实字段路径校准 Task 1 的 `parseDialog` 分支，重跑 `tool-summary.test.js` 并按真实形状补一条用例
   - **出了卡片但 Claude 没按所选继续** → 回传形状不对。按日志里 CLI 的后续反应校准 `toResult`

无论落到哪一支，第 4 步的日志都是净收益：它把「待观测项」变成确定结论。

# Workflow 多智能体编排接入 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Claude Agent SDK 内置的 Workflow 工具接进 Principal：模型选择器弹层新增「会话」区放飞书通知与 ⚡ ultracode 两个开关，工作流事件在活动转录中正确标识，用户可关闭 Workflow 工具，同时把 Fable 5.1 加进模型列表。

**Architecture:** 触发走客户端文本前缀（开关亮着时 `send()` 给 prompt 拼 `ultracode `，交给 CLI 原生关键字触发），服务端零协议改动。ultracode 是会话级偏好，完全照 `chatMode` 的 recordMessage / persistPrefsToConv / applySessionPrefs 流程走。后端只补两处展示层：`summarizeTool` 的 Workflow 摘要、task_* 事件按 task_id 记类型打标签（抽成纯函数）。

**Tech Stack:** Node ≥20 ESM、`node --test` + `node:assert/strict`、前端原生 DOM（无框架）、jsdom（仅 conv-notify 测试）。

**Spec:** `docs/superpowers/specs/2026-09-02-workflow-ultracode-design.md`

---

## 实施记录（2026-09-02，与下文计划文本的偏差）

本计划已按「子代理逐任务实现 + spec 合规审查 + 代码质量审查」执行完毕，全量 `npm test` 1950 通过，`tests/e2e-conv-notify.mjs` 实跑通过，Playwright 驱动真实页面按 Task 7 清单 12 项全过。下文各任务的代码块是**执行前的草稿**，审查过程中有以下修订已落地到代码与 spec（v2），计划正文不再逐条回改，以 spec 与代码为准：

- Task 1：`workflowMetaField` 先锚 `export const meta = {` 再在 2000 字窗口取字段；正则处理转义与 `\n`/`\t` 序列、折叠空白；名字 clip 24；文案改为 `工作流(名)：描述` 与转录行同形；加 `READONLY_TOOLS` 不含 Workflow 的回归测试（20 用例）。
- Task 2：Map 存 `{ name, label, skip }` 而非字符串；常驻任务（skip_transcript）的 progress 也压掉；回落优先用 progress 自带的 `subagent_type`；导出 `isTaskEvent` 替代 claude.js 里的正则；秒数为 0/缺失时不留孤立空格（18 用例）。
- Task 3：头注释标明 `workflowKeywordTriggerEnabled` 是 CLI 侧设置且本项目未实测；补双前缀用例（6 用例）。
- Task 4：会话区两行名字带初始 `off`；`.tool-row.disabled .tool-row-name { pointer-events: auto }` 保住 tooltip；Fable pill title 加「撞墙仍会切号」。
- Task 5：`change` 监听加 `busy` + `input.disabled` 在途保护；成功分支冗余 `refreshBtn` 删除；夹具换成完整行标记；**`tests/e2e-conv-notify.mjs` 一并迁移**（计划原本漏了它）。
- Task 6：`newConversation` 同时复位 🔔 行（`onConvOpened(null)`）；关掉「工作流」工具时同步熄掉 ⚡；`applySessionPrefs` 还原时加 `canEnableUltracode` 守卫；`syncUltracodeRow` 同时设 `ultracodeToggle.disabled`；运行中切换给 toast。
- Task 7：`src/integrations/CLAUDE.md` 除文件清单外还改了「一句话判断」段与「关键流程」「常见改动入口」。

未做、留给维护者的：冒烟（烧额度，Task 7 Step 3）——ultracode 关键字触发在自定义 systemPrompt 下是否生效仍未实测，兜底方案见 spec 第 7 节。

## 执行前必读

1. **不要 git commit。** 维护者约定：改动留工作区，提交时机由维护者掌控。本计划所有任务都没有 commit 步骤。
2. **工作区有别人的未提交改动。** `public/js/chat.js`（+87 行，集中在 83-320 与 841-900 两段）、`public/index.html`、`public/app.css` 都是 `M` 状态，且 chat.js 在本计划撰写期间还在变（行号已漂移两次）。**每次 Edit 前先 Read 目标区域**，只做定点替换，绝不整文件 Write，绝不碰非本计划的 hunk。本计划里的行号仅供定位参考，以函数名 / 唯一锚点字符串为准。
3. **注释用中文，解释「为什么」。** 计划里给出的注释就是最终注释，照抄即可。
4. 测试命令：单文件 `node --test <path>`；全量 `npm test`（= `node --test "src/**/*.test.js" "public/**/*.test.js"`）。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/entrypoints/web/tool-summary.js` | 工具调用 → 中文摘要（审批弹窗 / 活动转录共用） | 加 `Workflow` 分支 + meta 正则解析 |
| `src/entrypoints/web/tool-summary.test.js` | 同名单测 | 加 5 条 Workflow 用例 |
| `src/integrations/claude.logic.js` | **新建**：task_* 事件 → 活动文案的纯函数 | `describeTaskEvent` / `taskKindLabel` |
| `src/integrations/claude.logic.test.js` | **新建**：同名单测 | 9 条用例 |
| `src/integrations/claude.js` | SDK 封装 | 三个 task_* 分支合并成一处调 `describeTaskEvent`；删掉只剩它们在用的 `clipText` |
| `public/js/ultracode.logic.js` | **新建**：ultracode 开关纯逻辑 | `decorateUltracode` / `canEnableUltracode` |
| `public/js/ultracode.logic.test.js` | **新建**：同名单测 | 5 条用例 |
| `public/index.html` | 页面骨架 | 删 `#notifyFab`；`#modelPop` 加「会话」区；两处加 Fable 5.1 |
| `public/app.css` | 样式 | 删 `.notify-fab` / `.model-fab-btn.on`；加 `.tool-row.disabled` |
| `public/js/conv-notify.js` | 飞书通知开关 + 收件箱轮询 | DOM 绑定从按钮改 checkbox，业务逻辑不动 |
| `public/js/conv-notify.test.js` | 同名单测 | 夹具改 checkbox |
| `public/js/chat.js` | 聊天体 | `chatUltracode` 会话级接线、`send()` 前缀、toggle 绑定、`BUILTIN_TOOLS` / `MODEL_LABELS` / `shortModel` 各加一项 |
| `src/integrations/CLAUDE.md` | 模块地图 | 文件清单补两行 |

---

### Task 1: `summarizeTool` 的 Workflow 摘要

**Files:**
- Modify: `src/entrypoints/web/tool-summary.js`
- Test: `src/entrypoints/web/tool-summary.test.js`

- [ ] **Step 1: 写失败的测试**

在 `src/entrypoints/web/tool-summary.test.js` 顶部把 import 改成同时引入 `summarizeTool`：

```js
import { parseDialog, summarizeTool } from './tool-summary.js';
```

在文件末尾追加：

```js
// ---- summarizeTool：Workflow（多智能体编排）----
// 为什么单独测：Workflow 是最烧额度的工具，询问模式下审批弹窗正文就是这一行摘要，
// 用户得看到「哪个工作流、干什么」才知道自己在批什么；default 分支的「调用 Workflow」等于没说。

test('Workflow：script 含 meta → 「工作流 名字：描述」', () => {
  const script = `export const meta = {
  name: 'review-changes',
  description: '审查变更并逐条核实',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
const results = await pipeline([])`;
  assert.equal(summarizeTool({ name: 'Workflow', input: { script } }), '工作流 review-changes：审查变更并逐条核实');
});

test('Workflow：描述超 40 字被截断并加省略号', () => {
  const desc = 'x'.repeat(60);
  const script = `export const meta = { name: 'spec', description: '${desc}' }`;
  const out = summarizeTool({ name: 'Workflow', input: { script } });
  assert.ok(out.startsWith('工作流 spec：'));
  assert.ok(out.endsWith('…'));
  assert.equal(out.length, '工作流 spec：'.length + 40 + 1);
});

test('Workflow：无 script 用 input.name（预定义工作流），无描述不带冒号', () => {
  assert.equal(summarizeTool({ name: 'Workflow', input: { name: 'spec' } }), '工作流 spec');
});

test('Workflow：只有 scriptPath → 取文件名（兼容 Windows 反斜杠）', () => {
  assert.equal(summarizeTool({ name: 'Workflow', input: { scriptPath: 'C:\\Users\\x\\.claude\\wf-abc.js' } }), '工作流 wf-abc.js');
  assert.equal(summarizeTool({ name: 'Workflow', input: { scriptPath: '/tmp/session/wf-def.js' } }), '工作流 wf-def.js');
});

test('Workflow：什么都没有 → 「工作流 (未命名)」，不抛', () => {
  assert.equal(summarizeTool({ name: 'Workflow', input: {} }), '工作流 (未命名)');
  assert.equal(summarizeTool({ name: 'Workflow' }), '工作流 (未命名)');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/entrypoints/web/tool-summary.test.js`  
Expected: 5 条新用例 FAIL，断言信息里实际值为 `'调用 Workflow'`（default 分支）。原有 parseDialog 用例仍 PASS。

- [ ] **Step 3: 最小实现**

在 `src/entrypoints/web/tool-summary.js` 的 `summarizeTool` 函数**之前**加辅助函数：

```js
/**
 * 从 Workflow 脚本开头的 `export const meta = {...}` 里正则取字段。
 * 不 eval：meta 按工具契约必须是纯字面量（无变量/调用/插值），正则足够，也不给脚本任何执行机会。
 */
function workflowMetaField(script, key) {
  const m = new RegExp(key + '\\s*:\\s*([\'"`])([\\s\\S]*?)\\1').exec(String(script || ''));
  return m ? m[2] : '';
}
```

在 `switch (name)` 里、`case 'TodoWrite':` 之前插入：

```js
    case 'Workflow': {
      // 名字优先级：脚本 meta.name → 预定义工作流 input.name → scriptPath 文件名 → 兜底
      const name =
        workflowMetaField(inp.script, 'name') ||
        inp.name ||
        (inp.scriptPath ? String(inp.scriptPath).split(/[\\/]/).pop() : '') ||
        '(未命名)';
      const desc = workflowMetaField(inp.script, 'description');
      return desc ? `工作流 ${name}：${clip(desc, 40)}` : `工作流 ${name}`;
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/entrypoints/web/tool-summary.test.js`  
Expected: 全部 PASS（原有 8 条 + 新 5 条）。

- [ ] **Step 5: 确认 `READONLY_TOOLS` 没被顺手加上 Workflow**

打开 `src/entrypoints/web/tool-summary.js`，`READONLY_TOOLS` 集合保持原样（含 `Agent`，**不含** `Workflow`）。在 `'Agent', // SDK 0.3.210+ ...` 那行之后加一行注释说明为什么不加：

```js
  // Workflow 刻意不放行：它一次能拉起十几个子代理，风险不在改文件而在烧额度；询问模式下必须让用户点头
```

---

### Task 2: task_* 事件标签纯函数 + 接入 `runClaude`

**Files:**
- Create: `src/integrations/claude.logic.js`
- Create: `src/integrations/claude.logic.test.js`
- Modify: `src/integrations/claude.js`（`for await` 循环内三个 `task_*` 分支；顶部 import；删 `clipText`）

- [ ] **Step 1: 写失败的测试**

新建 `src/integrations/claude.logic.test.js`：

```js
/**
 * describeTaskEvent：SDK task_* 系统事件 → 活动转录文案。
 *
 * 为什么要测：task_progress / task_notification 自身不带 workflow_name，只能靠 task_started 时
 * 按 task_id 记类型、后续查表。记错或漏记，工作流就会被标成「子代理」（改前的实际表现）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeTaskEvent, taskKindLabel } from './claude.logic.js';

const started = (over = {}) => ({ type: 'system', subtype: 'task_started', task_id: 't1', description: '审查 src/store 的 Promise 处理', ...over });
const progress = (over = {}) => ({ type: 'system', subtype: 'task_progress', task_id: 't1', description: '读取 runs.js', usage: { total_tokens: 1, tool_uses: 3, duration_ms: 12400 }, last_tool_name: 'Read', ...over });
const notified = (over = {}) => ({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', output_file: '/x', summary: '发现 2 处未 catch', ...over });

test('taskKindLabel：工作流 > 子代理 > 后台任务', () => {
  assert.equal(taskKindLabel({ workflow_name: 'spec', subagent_type: 'Explore' }), '工作流(spec)');
  assert.equal(taskKindLabel({ subagent_type: 'Explore' }), '子代理(Explore)');
  assert.equal(taskKindLabel({}), '后台任务');
});

test('task_started（工作流）→ 记类型 + 「工作流(名)启动：描述」，name 为 Workflow', () => {
  const kinds = new Map();
  const a = describeTaskEvent(started({ workflow_name: 'spec', task_type: 'local_workflow' }), kinds);
  assert.equal(kinds.get('t1'), '工作流(spec)');
  assert.equal(a.name, 'Workflow');
  assert.equal(a.sub, true);
  assert.equal(a.text, '工作流(spec)启动：审查 src/store 的 Promise 处理');
});

test('task_started（子代理）→ 「子代理(类型)启动：…」，name 为 Agent', () => {
  const kinds = new Map();
  const a = describeTaskEvent(started({ subagent_type: 'Explore' }), kinds);
  assert.equal(a.name, 'Agent');
  assert.equal(a.text, '子代理(Explore)启动：审查 src/store 的 Promise 处理');
});

test('task_started（无类型）→ 「后台任务启动：…」', () => {
  const a = describeTaskEvent(started(), new Map());
  assert.equal(a.text, '后台任务启动：审查 src/store 的 Promise 处理');
});

test('task_started 描述超 40 字被截断', () => {
  const a = describeTaskEvent(started({ description: 'x'.repeat(50) }), new Map());
  assert.equal(a.text, `后台任务启动：${'x'.repeat(40)}…`);
});

test('task_progress 沿用 started 记下的标签，文案含工具名 / 次数 / 秒数', () => {
  const kinds = new Map();
  describeTaskEvent(started({ workflow_name: 'spec' }), kinds);
  const a = describeTaskEvent(progress(), kinds);
  assert.equal(a.name, 'Workflow');
  assert.equal(a.text, '工作流(spec)正在 Read · 已 3 次工具 12s：读取 runs.js');
});

test('task_progress 未知 task_id → 回落「子代理」（兼容早于 started 到达）', () => {
  const a = describeTaskEvent(progress({ task_id: 'ghost', last_tool_name: undefined, usage: {} }), new Map());
  assert.equal(a.name, 'Agent');
  assert.equal(a.text, '子代理执行中 · 已 ? 次工具 ：读取 runs.js');
});

test('task_notification 沿用标签、按 status 映射中文、随后清理 kinds', () => {
  const kinds = new Map();
  describeTaskEvent(started({ workflow_name: 'spec' }), kinds);
  const a = describeTaskEvent(notified(), kinds);
  assert.equal(a.text, '工作流(spec)完成：发现 2 处未 catch');
  assert.equal(kinds.has('t1'), false, 'notification 是终态，不清会让 Map 随会话无限增长');
  assert.equal(describeTaskEvent(notified({ task_id: 't9', status: 'failed', summary: '' }), kinds).text, '子代理失败：');
  assert.equal(describeTaskEvent(notified({ task_id: 't9', status: 'stopped' }), kinds).text.startsWith('子代理已停止：'), true);
});

test('skip_transcript：started 仍记类型但不出文案；notification 清类型且不出文案；其它 subtype → null', () => {
  const kinds = new Map();
  assert.equal(describeTaskEvent(started({ workflow_name: 'spec', skip_transcript: true }), kinds), null);
  assert.equal(kinds.get('t1'), '工作流(spec)', '常驻任务的 progress 仍要能查到类型');
  assert.equal(describeTaskEvent(notified({ skip_transcript: true }), kinds), null);
  assert.equal(kinds.has('t1'), false);
  assert.equal(describeTaskEvent({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: {} }, kinds), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/integrations/claude.logic.test.js`  
Expected: FAIL，`Cannot find module` / `ERR_MODULE_NOT_FOUND`（文件尚不存在）。

- [ ] **Step 3: 写纯逻辑文件**

新建 `src/integrations/claude.logic.js`：

```js
/**
 * SDK task_* 系统事件 → onActivity 载荷（纯函数，零 IO）。
 *
 * 为什么抽出来：runClaude 的消费循环全是 SDK 流与回调，无法直测；而「工作流还是子代理」的标签
 * 判定正是会出错的地方 —— task_progress / task_notification 自身不带 workflow_name，只能靠
 * task_started 时按 task_id 记下类型，后续事件查表。kinds 由调用方持有一次 runClaude 的生命周期。
 */

const FALLBACK_KIND = '子代理'; // progress 早于 started 到达 / 跨重试丢表时的回落，与改前文案一致

const clipText = (s, n) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n) + '…' : str;
};

/** task_started 的类型标签：工作流 > 子代理 > 后台任务 */
export function taskKindLabel(message) {
  if (message.workflow_name) return `工作流(${message.workflow_name})`;
  if (message.subagent_type) return `子代理(${message.subagent_type})`;
  return '后台任务';
}

// onActivity.name 暂无消费方（run-claude.js 只认 TodoWrite），但载荷要诚实：工作流就是 Workflow
const nameOf = (label) => (label.startsWith('工作流') ? 'Workflow' : 'Agent');

/**
 * @param {object} message  SDK system 消息（subtype 为 task_started / task_progress / task_notification）
 * @param {Map<string,string>} kinds  task_id → 类型标签，调用方按 runClaude 生命周期持有
 * @returns {{ name: 'Workflow'|'Agent', input: {}, sub: true, text: string } | null}  null = 不进转录
 */
export function describeTaskEvent(message, kinds) {
  if (message.subtype === 'task_started') {
    const label = taskKindLabel(message);
    kinds.set(message.task_id, label); // skip_transcript 的常驻任务也要记：它的 progress 仍会来
    if (message.skip_transcript) return null;
    return { name: nameOf(label), input: {}, sub: true, text: `${label}启动：${clipText(message.description, 40)}` };
  }
  if (message.subtype === 'task_progress') {
    const label = kinds.get(message.task_id) || FALLBACK_KIND;
    const u = message.usage || {};
    const tool = message.last_tool_name ? `正在 ${message.last_tool_name}` : '执行中';
    const secs = u.duration_ms ? `${Math.round(u.duration_ms / 1000)}s` : '';
    return {
      name: nameOf(label),
      input: {},
      sub: true,
      text: `${label}${tool} · 已 ${u.tool_uses ?? '?'} 次工具 ${secs}：${clipText(message.description, 30)}`,
    };
  }
  if (message.subtype === 'task_notification') {
    const label = kinds.get(message.task_id) || FALLBACK_KIND;
    kinds.delete(message.task_id); // 终态：不清会让 Map 随长会话无限增长
    if (message.skip_transcript) return null;
    const status = { completed: '完成', failed: '失败', stopped: '已停止' }[message.status] || message.status;
    return { name: nameOf(label), input: {}, sub: true, text: `${label}${status}：${clipText(message.summary || '', 60)}` };
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/integrations/claude.logic.test.js`  
Expected: 9 条全部 PASS。

- [ ] **Step 5: 接入 `runClaude`**

先 Read `src/integrations/claude.js` 确认下面三段原文仍在。

(a) 顶部 import 区，在 `import { logger, preview } from '../shared/logger.js';` 之后加：

```js
import { describeTaskEvent } from './claude.logic.js';
```

(b) 删除 `runClaude` 里的 `clipText`（原文如下，改后只有 task_* 分支用它，而它们已迁走）：

```js
  const clipText = (s, n) => {
    const str = String(s ?? '').replace(/\s+/g, ' ').trim();
    return str.length > n ? str.slice(0, n) + '…' : str;
  };
```

(c) 在 `for await (const message of q) {` **之前**（`if (inputQueue) onInputHandle(...)` 那行之后）加：

```js
      const taskKinds = new Map(); // task_id → 「工作流(名)/子代理(类)/后台任务」，progress/notification 查表打标签
```

(d) 把原来的三个分支——从注释 `// 子代理/后台任务进度（SDK 0.3.210+：...` 开始，到 `task_notification` 分支的 `continue;\n        }` 结束——整体替换为：

```js
        // 子代理 / 工作流 / 后台任务进度（SDK 0.3.210+：子代理不再透流内消息，进度经 system task_* 事件给出）。
        // 文案与类型判定在 claude.logic.js；skip_transcript=true 的常驻任务不进转录（返回 null）。
        if (message.type === 'system' && /^task_(started|progress|notification)$/.test(message.subtype)) {
          const activity = describeTaskEvent(message, taskKinds);
          if (activity) onActivity?.(activity);
          continue;
        }
```

- [ ] **Step 6: 跑 integrations 目录全部测试 + 语法检查**

Run: `node --test src/integrations/claude.test.js src/integrations/claude-retry.test.js src/integrations/claude.logic.test.js && node --check src/integrations/claude.js`  
Expected: 全部 PASS，`node --check` 无输出（无语法错误）。

---

### Task 3: ultracode 开关纯逻辑

**Files:**
- Create: `public/js/ultracode.logic.js`
- Create: `public/js/ultracode.logic.test.js`

- [ ] **Step 1: 写失败的测试**

新建 `public/js/ultracode.logic.test.js`：

```js
/**
 * ultracode 开关纯逻辑。
 * decorateUltracode 决定 prompt 要不要带关键字 —— 拼错位置（气泡/记忆库）或拼给别家模型都是事故，
 * 所以把「拼不拼」从 chat.js 的 send() 里抽出来单测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decorateUltracode, canEnableUltracode, ULTRACODE_KEYWORD } from './ultracode.logic.js';

test('开着 + Claude provider → 前缀 "ultracode "', () => {
  assert.equal(decorateUltracode('重构支付模块', { on: true, provider: 'claude-agent' }), 'ultracode 重构支付模块');
  assert.equal(ULTRACODE_KEYWORD, 'ultracode');
});

test('关着 → 原样返回', () => {
  assert.equal(decorateUltracode('重构支付模块', { on: false, provider: 'claude-agent' }), '重构支付模块');
});

test('openai-compat → 原样返回（别家模型没有 Workflow 工具）', () => {
  assert.equal(decorateUltracode('重构支付模块', { on: true, provider: 'openai-compat' }), '重构支付模块');
});

test('canEnableUltracode：Workflow 被禁用时为 false', () => {
  assert.equal(canEnableUltracode(['Bash', 'Workflow']), false);
});

test('canEnableUltracode：未禁用 / 空数组 / 非数组 → true', () => {
  assert.equal(canEnableUltracode(['Bash']), true);
  assert.equal(canEnableUltracode([]), true);
  assert.equal(canEnableUltracode(undefined), true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test public/js/ultracode.logic.test.js`  
Expected: FAIL，`ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 写实现**

新建 `public/js/ultracode.logic.js`：

```js
/**
 * ultracode（多智能体编排）开关的纯逻辑 —— 零 DOM，供 chat.js 调用、node --test 直测。
 *
 * 链路：模型选择器弹层「会话」区的 ⚡ ultracode 行 → chat.js 会话级状态 chatUltracode →
 * send() 新建 run 时经 decorateUltracode 给 prompt 加 `ultracode ` 前缀 → CLI 原生关键字触发
 * （settings.workflowKeywordTriggerEnabled，默认开）→ 模型调用 Workflow 工具。
 * 气泡、记忆库、会话记录都存用户原文，前缀只进 prompt。插话路径不加前缀（会污染记忆库语料）。
 */

export const ULTRACODE_KEYWORD = 'ultracode';
const CLAUDE_PROVIDER = 'claude-agent';

/** 开着且走 Claude provider 才拼关键字；openai-compat 没有 Workflow 工具，拼了只会让别家模型困惑 */
export function decorateUltracode(text, { on, provider }) {
  if (!on || provider !== CLAUDE_PROVIDER) return text;
  return `${ULTRACODE_KEYWORD} ${text}`;
}

/** Workflow 工具被用户禁用时不允许点亮：两处开关不得互相矛盾（反向顺序由服务端 canUseTool 兜底） */
export function canEnableUltracode(disabledTools) {
  return !(Array.isArray(disabledTools) && disabledTools.includes('Workflow'));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test public/js/ultracode.logic.test.js`  
Expected: 5 条全部 PASS。

---

### Task 4: `index.html` 与 `app.css`

**Files:**
- Modify: `public/index.html`（`#fabRow` 区、`#modelPills`、`#toolsSection` 之前、`#basicDefaultModel`）
- Modify: `public/app.css`（约 199-209 行；约 2604 行之后）

先 `Read` 这两个文件的目标区域，确认锚点原文一致（文件有别人的未提交改动，行号会漂）。

- [ ] **Step 1: 删掉右下角 🔔 悬浮按钮**

`public/index.html`，找到并把这段：

```html
      <div class="fab-row" id="fabRow">
        <div class="notify-fab" id="notifyFab">
          <button class="model-fab-btn" id="notifyFabBtn" title="任务结束/失败后发飞书通知">
            <span id="notifyFabLabel">🔔 飞书</span>
          </button>
        </div>
        <div class="model-fab" id="modelFab">
```

替换为：

```html
      <div class="fab-row" id="fabRow">
        <div class="model-fab" id="modelFab">
```

- [ ] **Step 2: 模型 pills 加 Fable 5.1**

同文件 `#modelPills` 内，把：

```html
              <button data-m="auto">Auto</button>
              <button data-m="claude-opus-5">Opus 5</button>
```

替换为：

```html
              <button data-m="auto">Auto</button>
              <button data-m="claude-fable-5-1" title="最强模型 · 独立限流桶 · 单价高于 Opus">Fable 5.1</button>
              <button data-m="claude-opus-5">Opus 5</button>
```

- [ ] **Step 3: 在工具区之前插入「会话」区**

同文件，把（`id="toolsSection"` 全文唯一，用它定位）：

```html
            <div class="pop-divider"></div>
            <div class="tools-section" id="toolsSection">
```

替换为：

```html
            <div class="pop-divider"></div>
            <!-- 会话级行为偏好（与「哪些工具可用」是两个维度，故不并入下方工具列表） -->
            <div class="tools-section" id="convPrefsSection">
              <div class="tools-section-hdr">会话</div>
              <div class="tool-row" id="notifyRow">
                <span class="tool-row-name" title="任务结束/失败后发飞书私聊卡片">🔔 飞书通知</span>
                <label class="tool-toggle"><input type="checkbox" id="notifyToggle" /><span class="toggle-slider"></span></label>
              </div>
              <div class="tool-row" id="ultracodeRow">
                <span class="tool-row-name" title="多智能体编排：开着时本会话发送的新消息带 ultracode 关键字（插话不带）">⚡ ultracode</span>
                <label class="tool-toggle"><input type="checkbox" id="ultracodeToggle" /><span class="toggle-slider"></span></label>
              </div>
            </div>
            <div class="pop-divider"></div>
            <div class="tools-section" id="toolsSection">
```

- [ ] **Step 4: 设置页「新会话默认值」下拉加 Fable 5.1**

同文件 `<select id="basicDefaultModel" ...>` 内，把：

```html
        <option value="auto">Auto</option>
        <option value="claude-opus-5">Opus 5</option>
        <option value="claude-opus-4-8">Opus 4.8</option>
```

替换为：

```html
        <option value="auto">Auto</option>
        <option value="claude-fable-5-1">Fable 5.1</option>
        <option value="claude-opus-5">Opus 5</option>
        <option value="claude-opus-4-8">Opus 4.8</option>
```

- [ ] **Step 5: `app.css` 删死样式**

`public/app.css`，删除这一整段（`.model-fab-btn.on` 与 `.notify-fab` 都没有使用方了）：

```css
      /* 会话级飞书通知开关的激活态。复用 .model-pills button.active 的同一套主色变量
         （--accent / --accent-soft），不写死色值：主题换肤时这颗按钮才不会掉队。
         规则放在 :hover 之后：两者特异性相同，靠源序保证开启态在 hover 时不被灰回去。 */
      .model-fab-btn.on {
        color: var(--accent);
        border-color: var(--accent);
        background: var(--accent-soft);
      }
      .notify-fab {
        position: relative;
      }
```

- [ ] **Step 6: `app.css` 加禁用态**

在 `.tool-row-name.off { color: var(--muted); }` 之后、`/* Toggle 开关 */` 之前插入：

```css
/* 会话区 ultracode 行在 openai-compat 下整体灰掉：别家模型没有 Workflow 工具，开了也拼不上关键字 */
.tool-row.disabled {
  opacity: 0.5;
  pointer-events: none;
}
```

- [ ] **Step 7: 确认没有残留引用**

Run: `grep -rn "notifyFab\|notify-fab\|model-fab-btn.on" public/ --include=*.html --include=*.css --include=*.js | grep -v vendor`  
Expected: 只剩 `public/js/conv-notify.js` 与 `public/js/conv-notify.test.js` 各一处 `notifyFabBtn`（Task 5 处理）。

---

### Task 5: 飞书通知开关迁到 checkbox

**Files:**
- Modify: `public/js/conv-notify.js`（文件头注释、`btn` 声明、`refreshBtn`、事件绑定）
- Modify: `public/js/conv-notify.test.js:27`（JSDOM 夹具）

- [ ] **Step 1: 改测试夹具**

`public/js/conv-notify.test.js` 里把：

```js
  dom = new JSDOM('<!doctype html><html><body><button id="notifyFabBtn"></button></body></html>', {
```

替换为：

```js
  dom = new JSDOM('<!doctype html><html><body><input type="checkbox" id="notifyToggle" /></body></html>', {
```

- [ ] **Step 2: 跑测试确认仍通过（夹具换了但模块还找旧 id，`btn?.` 可选链让它静默不绑）**

Run: `node --test public/js/conv-notify.test.js`  
Expected: 3 条 PASS。这一步是基线，证明接下来的改动不是靠夹具改动「碰巧」过的。

- [ ] **Step 3: 改模块**

`public/js/conv-notify.js`：

(a) 文件头第 2 行注释，把：

```js
 * 会话级飞书通知开关（输入框上方的 🔔 按钮）+ 补充内容收件箱轮询。
```

改为：

```js
 * 会话级飞书通知开关（模型选择器弹层「会话」区的 🔔 行）+ 补充内容收件箱轮询。
```

(b) 把：

```js
  const btn = document.getElementById('notifyFabBtn');
```

替换为：

```js
  const input = document.getElementById('notifyToggle');
  // 同行的名字 span：勾选态之外再切 .off 灰字，与下方工具列表行的视觉一致。测试夹具里没有它，故可选链
  const rowName = input?.closest('.tool-row')?.querySelector('.tool-row-name') || null;
```

(c) 把整个 `refreshBtn`：

```js
  function refreshBtn(conv) {
    if (!btn) return;
    const on = !!conv?.meta?.notifyFeishu;
    btn.classList.toggle('on', on);
    btn.title = on
      ? '已开启：任务结束/失败后发飞书通知（点击关闭）'
      : '任务结束/失败后发飞书通知';
  }
```

替换为（函数名保留：chat.js 三处经 `window.__convNotify.refreshBtn` 调用，不值得为改名扫一遍）：

```js
  function refreshBtn(conv) {
    if (!input) return;
    const on = !!conv?.meta?.notifyFeishu;
    input.checked = on;
    rowName?.classList.toggle('off', !on);
  }
```

(d) 把：

```js
  btn?.addEventListener('click', () => toggle());
```

替换为：

```js
  // change 而非 click：checkbox 在事件到达前已被浏览器改了勾选态；toggle() 有多条拒绝路径
  //（无会话 / 网络失败 / 服务端配置缺失），所以无论成败收尾都按 conv.meta 真值回写一次，
  // 否则拒绝路径会留下「勾着但没登记」的假象。
  input?.addEventListener('change', () => {
    toggle().finally(() => refreshBtn(findConv(getConvId())));
  });
```

- [ ] **Step 4: 跑测试**

Run: `node --test public/js/conv-notify.test.js`  
Expected: 3 条 PASS。

- [ ] **Step 5: 确认旧 id 已无引用**

Run: `grep -rn "notifyFabBtn" public/ | grep -v vendor`  
Expected: 无输出。

---

### Task 6: `chat.js` 接线

**Files:**
- Modify: `public/js/chat.js`——以下每个子步骤都先 `Read` 对应函数确认原文，再定点 Edit。函数名：`recordMessage`、`persistPrefsToConv`、`newConversation`、`shortModel`、`send`、`BUILTIN_TOOLS`、`MODEL_LABELS`、`syncModelUI`、`applySessionPrefs`、`modelFabBtn.addEventListener`。

- [ ] **Step 1: import**

在文件顶部 `import { $, debounce, renderMarkdown, lsSet, isMarkdownPath } from './util.js';` 之后加：

```js
import { decorateUltracode, canEnableUltracode } from './ultracode.logic.js';
```

- [ ] **Step 2: 会话级状态变量**

找到 `let chatCustomCredId = localStorage.getItem('claude_custom_cred_id') || '';`，在其后加：

```js
      // ultracode（多智能体编排）会话级开关。刻意不落 localStorage 全局默认：新会话永远从关开始，
      // 否则在 A 会话开了编排做大重构、切到 B 问个小问题，B 的每条消息也会去拉工作流烧额度。
      // 持久化与还原完全照 chatMode 的流程：recordMessage 快照 / persistPrefsToConv 写穿 / applySessionPrefs 还原。
      let chatUltracode = false;
```

- [ ] **Step 3: `recordMessage` 快照**

在 `recordMessage` 内把：

```js
        c.customCredId = chatCustomCredId;
        c.updatedAt = Date.now();
```

替换为：

```js
        c.customCredId = chatCustomCredId;
        c.ultracode = chatUltracode; // 首条消息建会话记录时一并写入：解决「会话还没建就先开了开关」的时序
        c.updatedAt = Date.now();
```

- [ ] **Step 4: `persistPrefsToConv` 写穿**

在 `persistPrefsToConv` 内把：

```js
        c.customCredId = chatCustomCredId;
        saveConvs(list); // 不动 updatedAt：纯偏好变更不改变左栏排序
```

替换为：

```js
        c.customCredId = chatCustomCredId;
        c.ultracode = chatUltracode;
        saveConvs(list); // 不动 updatedAt：纯偏好变更不改变左栏排序
```

- [ ] **Step 5: `newConversation` 复位**

在 `newConversation` 内把：

```js
        restorePrompt(localStorage.getItem(NEW_DRAFT_KEY)); // 回填上次「新对话」里没发出去的内容
        currentSession = null;
```

替换为：

```js
        restorePrompt(localStorage.getItem(NEW_DRAFT_KEY)); // 回填上次「新对话」里没发出去的内容
        currentSession = null;
        chatUltracode = false; // 新会话从关开始（见变量声明处）
        syncUltracodeRow();
```

- [ ] **Step 6: `shortModel` 认 Fable**

把：

```js
        const name = /opus/.test(m) ? 'Opus' : /haiku/.test(m) ? 'Haiku' : 'Sonnet';
```

替换为：

```js
        const name = /fable/.test(m) ? 'Fable' : /opus/.test(m) ? 'Opus' : /haiku/.test(m) ? 'Haiku' : 'Sonnet';
```

- [ ] **Step 7: `send()` 加前缀**

在 `send` 内把种子前置块的结尾到占位 job 之间：

```js
          saveConvs(list); // 直接用已获取的列表引用，无需重读
        }

        // 先建占位 job（es 待填），立即显示”运行中…”，避免 start 往返期间无反馈
```

替换为：

```js
          saveConvs(list); // 直接用已获取的列表引用，无需重读
        }
        // ultracode 前缀只进 prompt：气泡（上面 addMessage）与记忆库（launchRun 的 typedText）都是原文
        finalText = decorateUltracode(finalText, { on: chatUltracode, provider: chatProvider });

        // 先建占位 job（es 待填），立即显示”运行中…”，避免 start 往返期间无反馈
```

- [ ] **Step 8: `BUILTIN_TOOLS` 加 Workflow**

把：

```js
        { id: 'Task',      label: '子代理',  desc: '启动子任务代理（含 Agent）' },
        { id: 'TodoWrite', label: '任务清单', desc: '管理待办清单' },
```

替换为：

```js
        { id: 'Task',      label: '子代理',  desc: '启动子任务代理（含 Agent）' },
        { id: 'Workflow',  label: '工作流',  desc: '多智能体编排（ultracode 触发，可拉起多个子代理）' },
        { id: 'TodoWrite', label: '任务清单', desc: '管理待办清单' },
```

- [ ] **Step 9: `MODEL_LABELS` 加 Fable**

把：

```js
      const MODEL_LABELS = {
        auto: 'Auto',
        'claude-opus-5': 'Opus 5',
```

替换为：

```js
      const MODEL_LABELS = {
        auto: 'Auto',
        'claude-fable-5-1': 'Fable 5.1',
        'claude-opus-5': 'Opus 5',
```

- [ ] **Step 10: DOM 引用 + `syncUltracodeRow`**

把：

```js
      const effortSlider = $('#effortSlider');
```

替换为：

```js
      const effortSlider = $('#effortSlider');
      const ultracodeToggle = $('#ultracodeToggle');
      const ultracodeRow = $('#ultracodeRow');
      /** ⚡ ultracode 行：勾选态跟会话级状态；openai-compat 下整行灰掉（别家模型没有 Workflow 工具） */
      function syncUltracodeRow() {
        if (!ultracodeToggle) return;
        ultracodeToggle.checked = chatUltracode;
        ultracodeRow.classList.toggle('disabled', chatProvider !== 'claude-agent');
        ultracodeRow.querySelector('.tool-row-name').classList.toggle('off', !chatUltracode);
      }
```

- [ ] **Step 11: `syncModelUI` 里带上它**

把 `syncModelUI` 的开头：

```js
      function syncModelUI() {
        if (chatProvider === 'openai-compat') {
```

替换为：

```js
      function syncModelUI() {
        syncUltracodeRow(); // 放在 provider 分支之前：openai-compat 分支会提前 return
        if (chatProvider === 'openai-compat') {
```

- [ ] **Step 12: `applySessionPrefs` 还原**

在 `applySessionPrefs` 内把：

```js
        if (changed) {
          syncModelUI();
```

替换为：

```js
        // ultracode 是会话级开关：缺字段视为关（老会话、CLI 历史会话天然为关），不参与 changed 的 toast
        const nextUltracode = !!prefs.ultracode;
        if (nextUltracode !== chatUltracode) {
          chatUltracode = nextUltracode;
          syncUltracodeRow();
        }
        if (changed) {
          syncModelUI();
```

- [ ] **Step 13: toggle 事件绑定**

在 `modelFabBtn.addEventListener('click', ...)` 这个语句块之后（即 `document.addEventListener('click', (e) => { if (!modelPop.hidden ...` 之前）插入：

```js
      ultracodeToggle?.addEventListener('change', () => {
        if (ultracodeToggle.checked && !canEnableUltracode(chatDisabledTools)) {
          toast('工作流工具已关闭，请先在下方工具列表开启');
          ultracodeToggle.checked = false; // 浏览器已先打勾，按真值回写
          return;
        }
        chatUltracode = ultracodeToggle.checked;
        persistPrefsToConv(); // 无会话时 no-op，首条消息由 recordMessage 快照带入
        syncUltracodeRow();
      });
```

- [ ] **Step 14: 语法检查 + 全量测试**

Run: `node --check public/js/chat.js && npm test`  
Expected: `node --check` 无输出；`npm test` 全部 PASS（含 Task 1-5 新增用例）。

---

### Task 7: 文档 + 人工验证

**Files:**
- Modify: `src/integrations/CLAUDE.md`（「文件清单」小节）

- [ ] **Step 1: 模块地图补文件**

`src/integrations/CLAUDE.md` 的「## 文件清单」里，在 `- \`claude.js\` — ...` 那行之后加：

```md
- `claude.logic.js` — `claude.js` 的纯逻辑层（零 IO）：`describeTaskEvent` 把 SDK task_* 系统事件翻成活动转录文案，按 task_id 记住「工作流 / 子代理 / 后台任务」类型（progress / notification 自身不带类型，只能查表）。
```

并把 `- \`claude.test.js\` / \`claude-retry.test.js\` — ...` 那行改为：

```md
- `claude.test.js` / `claude-retry.test.js` / `claude.logic.test.js` — `createInputQueue` 队列语义、`runClaude` 重试逻辑、task_* 事件标签单测。
```

同文件「关键流程 → 1. claude.js」第 3 点里的 `task_*→onActivity（子代理进度）` 改为 `task_*→describeTaskEvent→onActivity（子代理 / 工作流进度，见 claude.logic.js）`。

同文件开头「一句话判断」段落断言「这四个源文件之间互不调用、无编排关系」——`claude.js` 现在 import 了 `claude.logic.js`，该断言不再成立。把这句改为：「适配器文件（`claude.js` / `lark.js` / `shell.js` / `notify.js` / `docx.js`）之间互不调用、无编排关系；`claude.logic.js` 是 `claude.js` 的纯逻辑层，只被它 import。」（Task 2 代码审查提出；本仓 `project-checkup` 有地图过期维度会扫出这处。）

- [ ] **Step 2: 启动服务做人工核对（不烧额度的部分）**

Run: `npm start`，浏览器开 `http://127.0.0.1:3000`，逐项确认：

1. 右下角只剩模型按钮，🔔 悬浮按钮消失。
2. 打开模型选择器：模型 pills 出现「Fable 5.1」；权限模式下方多出「会话」区两行（🔔 飞书通知、⚡ ultracode）；工具列表多出「工作流」。
3. 在一个已有消息的会话里勾 🔔 飞书通知：未配置飞书时出现 toast 且勾选态回落为未勾（拒绝路径回写生效）。
4. 新对话（无消息）勾 ⚡ ultracode → 勾上；发一条消息 → 切到别的会话 → ⚡ 变为未勾 → 切回 → 重新勾上；点「新对话」→ 未勾。
5. 关掉工具列表的「工作流」，再勾 ⚡ → toast「工作流工具已关闭…」且勾不上。
6. 选一个自定义（openai-compat）模型 → ⚡ 行整体变灰不可点；切回 Claude → 恢复。
7. 设置页「新会话默认值 → 默认模型」下拉有 Fable 5.1。

- [ ] **Step 3: 冒烟（烧额度，由维护者决定是否执行）**

模式选「自动」，勾 ⚡ ultracode，发：

```
用两个代理分别检查 src/store 和 src/plugins 的未处理 Promise，汇总给我
```

预期活动转录出现 `工作流(…)启动：…`，随后 `工作流(…)正在 … · 已 N 次工具 …`，结束 `工作流(…)完成：…`。若模型没有调 Workflow（转录里只有普通子代理），执行 spec 第 7 节的兜底：在 `src/entrypoints/web/run-claude.js` 的自定义 `systemPrompt.content` 末尾追加一段：

```
当用户消息包含 ultracode 关键字时，使用 Workflow 工具做多智能体编排。
```

- [ ] **Step 4: 最终检查**

Run: `npm test && grep -rn "notifyFabBtn\|notify-fab" public/ tests/ scripts/ src/ ; git status --short`  
Expected: 测试全绿；grep 无输出（Task 5 代码审查发现 `tests/e2e-conv-notify.mjs` 也引用旧 id，已一并迁移）；`git status` 里本计划涉及的文件全部处于 `M` / `??`，**没有**任何 commit 动作发生。

- [ ] **Step 5: 端到端（需 playwright 浏览器，由维护者执行）**

Run: `npm run test:e2e`  
Expected: `tests/e2e-conv-notify.mjs` 通过，尤其「不变量②：ok:false 时不得点亮」这条门禁真的在读 `#notifyToggle.checked`。

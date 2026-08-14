# 飞书会话化收集 + 分层分类 + 文档提取 + 常驻 auto 工作区 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复飞书机器人三大问题——连续消息无法归并为一个任务、长文本/文档被误判为故障、auto-dev 工作区残留导致「状态异常」——并新增飞书文档识别能力。

**Architecture:** 三阶段独立可交付：① 材料暂存池（内存 TTL）+ 分层意图分类（收紧关键词快路 + Haiku 结构化分类新增 material 类别）；② 常驻 git worktree（`<projectDir>.auto`）承接全部自动开发，主工作区永不被切分支；③ 飞书文档双通道提取（本地文件下载解析 + 云文档 docx OpenAPI）。

**Tech Stack:** Node.js ESM、node:test、@larksuiteoapi/node-sdk、mammoth（阶段三唯一新增依赖）。

**规格文档:** `docs/superpowers/specs/2026-07-29-feishu-conversation-and-autodev-design.md`

**约束（用户全局规则）:**
- ⚠️ 本计划**不包含任何 git commit/branch 步骤**——提交时机由用户自行决定。每个 Task 完成后停在「测试通过」状态即可。
- 在当前分支（feat/unattended-mode）工作目录直接实施，不新建 worktree/分支。
- 测试命令：整体 `npm test`；单文件 `node --test <path>`（Windows Git Bash 下路径用正斜杠）。
- 新代码注释用中文（与代码库一致）。

---

## 阶段一：材料暂存池 + 分层分类（止血）

### Task 1: 材料暂存池模块

**Files:**
- Create: `src/plugins/team-tools/material-pool.js`
- Create: `src/plugins/team-tools/material-pool.test.js`

材料池是内存 Map（TTL 10 分钟、单 key 上限 10 条），所有材料入池前已落盘为本地文件（text/doc 由 `saveTextMaterial` 写盘），池里只存 `{ kind, path, title?, at }`。

- [ ] **Step 1: 写失败测试**

```js
// src/plugins/team-tools/material-pool.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMaterial,
  hasMaterials,
  drainMaterials,
  materialDetailLine,
  clearPool,
} from './material-pool.js';

beforeEach(() => clearPool());

test('addMaterial 后 hasMaterials 为真，drain 取出并清空', () => {
  const t0 = 1_000_000;
  addMaterial('u1', 'c1', { kind: 'image', path: 'C:/x/a.png' }, t0);
  assert.equal(hasMaterials('u1', 'c1', t0), true);
  const mats = drainMaterials('u1', 'c1', t0);
  assert.equal(mats.length, 1);
  assert.equal(mats[0].kind, 'image');
  assert.equal(hasMaterials('u1', 'c1', t0), false);
});

test('不同 openId/chatId 互相隔离', () => {
  const t0 = 1_000_000;
  addMaterial('u1', 'c1', { kind: 'file', path: 'C:/x/a.pdf' }, t0);
  assert.equal(hasMaterials('u1', 'c2', t0), false);
  assert.equal(hasMaterials('u2', 'c1', t0), false);
});

test('TTL 10 分钟：过期材料不可见也不被 drain 出', () => {
  const t0 = 1_000_000;
  addMaterial('u1', 'c1', { kind: 'text', path: 'C:/x/m.md' }, t0);
  const later = t0 + 10 * 60 * 1000 + 1;
  assert.equal(hasMaterials('u1', 'c1', later), false);
  assert.deepEqual(drainMaterials('u1', 'c1', later), []);
});

test('单 key 上限 10 条，超出丢最旧', () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 12; i++) {
    addMaterial('u1', 'c1', { kind: 'image', path: `C:/x/${i}.png` }, t0 + i);
  }
  const mats = drainMaterials('u1', 'c1', t0 + 20);
  assert.equal(mats.length, 10);
  assert.equal(mats[0].path, 'C:/x/2.png'); // 0、1 被挤掉
});

test('materialDetailLine 按 kind 格式化', () => {
  assert.equal(materialDetailLine({ kind: 'image', path: 'C:/a.png' }), '[补充截图] C:/a.png');
  assert.equal(materialDetailLine({ kind: 'file', path: 'C:/a.pdf', title: '接口文档.pdf' }), '[附件] 接口文档.pdf：C:/a.pdf');
  assert.equal(materialDetailLine({ kind: 'file', path: 'C:/a.pdf' }), '[附件] C:/a.pdf');
  assert.equal(materialDetailLine({ kind: 'doc', path: 'C:/d.md', title: '联调文档' }), '[参考文档] 联调文档：C:/d.md');
  assert.equal(materialDetailLine({ kind: 'text', path: 'C:/m.md' }), '[参考材料] C:/m.md');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/material-pool.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```js
// src/plugins/team-tools/material-pool.js
/**
 * 材料暂存池 —— 「先发文件/文档，再发需求描述」的归并机制。
 * 附件/文档/纯材料消息挂不上近期任务时先入池；下一条文字立案时 drain 吸附进 detail。
 * 内存态 + TTL 10 分钟 + 单 key 上限 10 条（与 channels/feishu.js 的 seen 去重同一哲学：
 * 短暂临时态不落盘，进程重启丢失的代价只是用户重发一次）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 与 lark.js 的 RESOURCE_DIR 同根：.uploads/feishu 下不被 web 入口顶层清理
const MATERIAL_DIR = path.join(__dirname, '..', '..', '..', '.uploads', 'feishu', 'materials');

const TTL_MS = 10 * 60 * 1000;
const MAX_PER_KEY = 10;

// key = `${openId}:${chatId}` → [{ kind:'image'|'file'|'doc'|'text', path, title?, at }]
const pool = new Map();

const keyOf = (openId, chatId) => `${openId}:${chatId}`;

/** 取 key 下未过期材料（懒清理：顺手把过期的剔掉） */
function alive(key, now) {
  const list = pool.get(key) || [];
  const fresh = list.filter((m) => now - m.at <= TTL_MS);
  if (fresh.length) pool.set(key, fresh);
  else pool.delete(key);
  return fresh;
}

/** 入池；超上限丢最旧 */
export function addMaterial(openId, chatId, material, now = Date.now()) {
  const key = keyOf(openId, chatId);
  const list = alive(key, now);
  list.push({ ...material, at: now });
  while (list.length > MAX_PER_KEY) list.shift();
  pool.set(key, list);
}

export function hasMaterials(openId, chatId, now = Date.now()) {
  return alive(keyOf(openId, chatId), now).length > 0;
}

/** 取出并清空该 key 的全部未过期材料 */
export function drainMaterials(openId, chatId, now = Date.now()) {
  const key = keyOf(openId, chatId);
  const list = alive(key, now);
  pool.delete(key);
  return list;
}

/** 纯格式化：材料 → detail 追加行（image 沿用「补充截图」标签，保持 analyze prompt 兼容） */
export function materialDetailLine(m) {
  if (m.kind === 'image') return `[补充截图] ${m.path}`;
  if (m.kind === 'file') return m.title ? `[附件] ${m.title}：${m.path}` : `[附件] ${m.path}`;
  if (m.kind === 'doc') return `[参考文档] ${m.title || '飞书文档'}：${m.path}`;
  return `[参考材料] ${m.path}`;
}

/** 长文本材料落盘为 md，返回绝对路径（供入池/挂任务；Claude 可 Read） */
export function saveTextMaterial(title, content) {
  fs.mkdirSync(MATERIAL_DIR, { recursive: true });
  const file = path.join(MATERIAL_DIR, Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + '.md');
  fs.writeFileSync(file, `# ${title}\n\n${content}`, 'utf8');
  return file;
}

/** 仅测试用：清空池 */
export function clearPool() {
  pool.clear();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/material-pool.test.js`
Expected: PASS（5 个用例）

### Task 2: 分层路由纯函数（收紧关键词快路）

**Files:**
- Modify: `src/app/intent.js`（`feedbackKeyword` 附近，约 :19-29）
- Modify: `src/app/intent.test.js`（追加用例）

- [ ] **Step 1: 写失败测试（追加到现有 intent.test.js）**

```js
// 追加到 src/app/intent.test.js（import 行合并到文件顶部现有 import）
import { feedbackRoute, FAST_PATH_MAX_LEN } from './intent.js';

test('feedbackRoute：短文本单类命中 → fast', () => {
  assert.deepEqual(feedbackRoute('登录页白屏了', false), { mode: 'fast', type: 'bug' });
  assert.deepEqual(feedbackRoute('希望增加导出功能', false), { mode: 'fast', type: 'feature' });
});

test('feedbackRoute：bug/feature 双类命中 → llm', () => {
  // 「报错」命中 bug，「优化」命中 feature
  assert.deepEqual(feedbackRoute('登录报错，希望优化一下提示', false), { mode: 'llm' });
});

test('feedbackRoute：超过 120 字 → llm（长文档贴入不走快路）', () => {
  const long = '这个是本次需求的后端接口文档，' + '错误码说明：'.repeat(30);
  assert.ok(long.length > FAST_PATH_MAX_LEN);
  assert.deepEqual(feedbackRoute(long, false), { mode: 'llm' });
});

test('feedbackRoute：有待归属材料 → llm（即使无关键词）', () => {
  assert.deepEqual(feedbackRoute('按这个文档联调宝宝辅食页面', true), { mode: 'llm' });
});

test('feedbackRoute：短文本无关键词无材料 → none', () => {
  assert.deepEqual(feedbackRoute('今天天气不错', false), { mode: 'none' });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/app/intent.test.js`
Expected: FAIL（feedbackRoute 未导出）

- [ ] **Step 3: 实现（intent.js，放在 feedbackKeyword 之后）**

把现有 `feedbackKeyword` 的两个正则提出为模块常量（`BUG_RE` / `FEATURE_RE`），`feedbackKeyword` 改用常量（行为不变），然后新增：

```js
// —— 分层路由：关键词快路只在「短文本 + 恰好单类命中 + 无待归属材料」时生效；
//    其余（长文本 / 双类命中 / 带材料）交给 LLM 结构化分类（含 material 类别）。
//    背景事故：后端接口文档整篇贴入，全文命中「错误/异常」被误判为故障——长文本关键词匹配无意义。
export const FAST_PATH_MAX_LEN = 120;

export function feedbackRoute(text, hasMaterials) {
  const t = String(text || '');
  const bug = BUG_RE.test(t);
  const feature = FEATURE_RE.test(t);
  const long = t.length > FAST_PATH_MAX_LEN;
  if (!long && !hasMaterials && bug !== feature) {
    return { mode: 'fast', type: bug ? 'bug' : 'feature' };
  }
  if (bug || feature || long || hasMaterials) return { mode: 'llm' };
  return { mode: 'none' };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/app/intent.test.js`
Expected: PASS（新增 5 个用例 + 原有用例全绿）

### Task 3: Haiku feedback 分类器 + classify 重排 + dispatch 接线

**Files:**
- Modify: `src/app/intent.js`（`classify` 函数，:151-168；新增 `claudeClassifyFeedback`）
- Modify: `src/app/dispatch.js:37`

- [ ] **Step 1: 实现 claudeClassifyFeedback（intent.js，放在 claudeClassifyAction 之后，同款防卡死模式）**

```js
/** 用 Claude(Haiku) 做 feedback 四分类（bug/feature/material/other）；单轮+禁工具+超时，防卡死 */
async function claudeClassifyFeedback(text, hasMaterials) {
  // 额度耗尽 fail-fast（与 classifyAction 同因：SDK 流可能永不结束）
  if (isPoolExhausted(getTokens())) {
    logger.warn('intent', 'token 池全部耗尽，跳过 feedback 分类（fail-fast）');
    return null;
  }
  let out = '';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    const prompt =
      `你是团队消息分类器，仅输出一行 JSON。\n` +
      `判断这条消息属于哪类：\n` +
      `- bug：报告软件故障/异常，期望修复\n` +
      `- feature：提出需求/改进，期望实现\n` +
      `- material：仅提供参考材料（接口文档/设计稿/日志片段等），本身不构成独立诉求\n` +
      `- other：都不是（寒暄/提问/无关内容）\n` +
      (hasMaterials ? `（提示：该用户刚发过待归属的参考材料，这条消息很可能是对应的需求/故障描述）\n` : '') +
      `消息（截取首 500 字）：\n「${String(text || '').slice(0, 500)}」\n\n` +
      `严格输出：{"type":"bug|feature|material|other"}`;
    const call = runClaude(prompt, {
      ...claudeAuthOpts(),
      persistSession: false,
      model: config.intent.classifyModel,
      maxTurns: 1,
      disallowedTools: ['Agent', 'Task', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      abortController: abort,
      onText: (t) => (out += t),
      onResult: (info) => {
        if (!out && info.result) out = info.result;
      },
    });
    call.catch((e) => logger.warn('intent', 'feedback 分类调用异常（落兜底）', { err: e?.message || String(e) }));
    await Promise.race([call, new Promise((resolve) => setTimeout(resolve, CLASSIFY_TIMEOUT_MS + 2_000))]);
  } catch {
    /* 超时/异常 → 返回 null 落兜底 */
  } finally {
    clearTimeout(timer);
  }
  const m = out.match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (['bug', 'feature', 'material', 'other'].includes(j.type)) return j.type;
    } catch {
      /* ignore */
    }
  }
  return null; // 解析失败 → 调用方走关键词兜底
}
```

- [ ] **Step 2: 重排 classify（整体替换现有 classify 函数）**

```js
/**
 * 统一入口（分层分类）：寒暄快路 → 收紧的关键词快路 → Haiku 四分类（含 material）
 * → 兜底关键词全文匹配（宁可误判不丢消息）→ action 分类 → other。
 * @param {string} text
 * @param {{ hasMaterials?: boolean }} [opts] 该用户当前会话是否有待归属材料（影响快路旁路与分类提示）
 */
export async function classify(text, opts = {}) {
  const hasMaterials = !!opts.hasMaterials;

  // 1. 寒暄快路：免 LLM（提前到最先——问候语不可能命中反馈关键词，判空/纯寒暄直接 other）
  if (isChitchat(text)) return { intent: 'other', env: null, keyword: null };

  // 2. 分层路由
  const route = feedbackRoute(text, hasMaterials);
  if (route.mode === 'fast') return { intent: route.type, env: null, keyword: null };
  if (route.mode === 'llm') {
    const type = await claudeClassifyFeedback(text, hasMaterials);
    if (type === 'material') return { intent: 'material', env: null, keyword: null };
    if (type === 'bug' || type === 'feature') return { intent: type, env: null, keyword: null };
    if (type === null) {
      // Haiku 超时/失败兜底：退回全文关键词匹配（老行为），绝不丢消息
      const fb = feedbackKeyword(text);
      if (fb) return { intent: fb, env: null, keyword: null };
    }
    // type === 'other' → 继续 action 分类
  }

  // 3. action 分类
  const action = await classifyAction(text);
  if (action.intent === 'action') {
    return { intent: 'action', actionId: action.actionId, actionName: action.actionName };
  }

  // 4. fallback
  return { intent: 'other', env: null, keyword: null };
}
```

- [ ] **Step 3: dispatch 接线（dispatch.js:37）**

```js
    // 2. 意图识别 → 按 权限 + intents 匹配（hasMaterials 由入口层写入 ctx.meta，影响分类分层）
    const intent = await classify(ctx.text, { hasMaterials: !!ctx.meta?.hasMaterials });
```

- [ ] **Step 4: 全量测试回归**

Run: `npm test`
Expected: PASS（classify 的调用方兼容：opts 可选默认空对象）

### Task 4: 材料归属泛化（task-ops.js）

**Files:**
- Modify: `src/plugins/team-tools/task-ops.js:118-142`

- [ ] **Step 1: 实现 attachMaterialToRecentTask，attachImageToRecentTask 委托之（整体替换现有 attachImageToRecentTask 及其上方注释）**

```js
// 单发材料（图/文件/文档）可归属到该用户最近提交的任务的时间窗口
const ATTACH_WINDOW_MS = 10 * 60 * 1000;

/**
 * 把单发材料归属到该用户最近（10 分钟内）提交且未开发的任务：
 * 按 kind 格式化追加到 detail；若不在分析中则带材料重新分析。
 * @param {string} openId
 * @param {{ kind:'image'|'file'|'doc'|'text', path:string, title?:string }} material
 * @returns 归属到的 task，找不到返回 null（调用方入材料池或提示用户）
 */
export function attachMaterialToRecentTask(openId, material) {
  const cutoff = Date.now() - ATTACH_WINDOW_MS;
  const task = getTasks().find(
    (t) =>
      t.source?.openId === openId &&
      // 评审中/被质疑的任务同样未开发，补材料后一并进入后续评审与修复的上下文
      ['new', 'reviewing', 'challenged', 'analyzing', 'analyzed'].includes(t.status) &&
      new Date(t.createdAt).getTime() >= cutoff,
  );
  if (!task) return null;
  const updated = updateTask(task.id, { detail: `${task.detail}\n${materialDetailLine(material)}` }, '补充材料');
  logger.info('task-ops', '补充材料', { id: task.id, kind: material.kind, path: material.path });
  // 分析中不重复起分析（当前这轮看不到新材料，但 detail 已留存，develop 阶段仍可读到）
  if (task.status !== 'analyzing') {
    analyze(updated).catch((e) =>
      logger.error('task-ops', '带材料重新分析失败', { id: task.id, err: e?.message || String(e) }),
    );
  }
  return updated;
}

/** 兼容旧调用：单发截图归属（等价于 kind:'image' 的材料） */
export function attachImageToRecentTask(openId, imagePath) {
  return attachMaterialToRecentTask(openId, { kind: 'image', path: imagePath });
}
```

文件顶部 import 增加：

```js
import { materialDetailLine } from './material-pool.js';
```

- [ ] **Step 2: 回归**

Run: `npm test`
Expected: PASS（detail 追加格式 `[补充截图] <path>` 与原先一致，行为无变化）

### Task 5: feedback 插件接管 material + 出池吸附 + 入口接线 + 文案

**Files:**
- Modify: `src/shared/messages.js:14-26`（REGISTRY 增 key）
- Modify: `src/shared/messages.test.js`（追加用例）
- Modify: `src/plugins/team-tools/feedback/index.js`
- Modify: `src/entrypoints/feishu/index.js:20-53`

- [ ] **Step 1: 写失败测试（messages.test.js 追加）**

```js
test('materialAck 在注册表且不可配（不在 BOT_MESSAGE_KEYS）', () => {
  assert.equal(typeof REGISTRY.materialAck.defaultText, 'string');
  assert.ok(!BOT_MESSAGE_KEYS.includes('materialAck'));
  assert.equal(resolveMessage('materialAck', {}), REGISTRY.materialAck.defaultText);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/shared/messages.test.js`
Expected: FAIL（REGISTRY.materialAck undefined）

- [ ] **Step 3: messages.js REGISTRY 增加（放在 feedbackAck 之后）**

```js
  materialAck: {
    label: '材料收讫提示',
    defaultText: '📎 已收到材料～请描述对应的需求或问题，我会把材料一并带上（10 分钟内有效）。',
  },
```

Run: `node --test src/shared/messages.test.js` → PASS

- [ ] **Step 4: feedback/index.js —— intents 增 material + material 分支 + 立案出池**

顶部 import 增加：

```js
import { addMaterial, drainMaterials, saveTextMaterial, materialDetailLine } from '../material-pool.js';
import { attachMaterialToRecentTask } from '../task-ops.js';
```

`intents: ['bug', 'feature']` 改为 `intents: ['bug', 'feature', 'material']`。

`handle` 中，在「A. challenged 应答」块之后、「B. 正常收集」之前插入：

```js
    // A2. 纯材料消息（长文本文档等）：先试挂近期任务，挂不上入池等待下一条文字立案
    if (intentResult?.intent === 'material') {
      const title = (ctx.text || '').trim().slice(0, 30);
      const path = saveTextMaterial(title, ctx.text || '');
      const material = { kind: 'text', path, title };
      const attached = attachMaterialToRecentTask(ctx.user.id, material);
      if (attached) return ctx.reply(`📎 已把材料补充到「${attached.title}」，会结合材料一并处理。`);
      addMaterial(ctx.user.id, ctx.meta?.chatId || ctx.sessionKey, material);
      logger.info('feedback', '材料入池', { openId: ctx.user.id, title });
      return ctx.reply(msg('materialAck'));
    }
```

「B. 正常收集」的 `createTask` 之后（`logger.info('feedback', '收集到反馈', …)` 之前）插入出池吸附：

```js
    // 吸附待归属材料（先发文件后发描述的归并出口）
    const mats = drainMaterials(ctx.user.id, ctx.meta?.chatId || ctx.sessionKey);
    const withMats = mats.length
      ? updateTask(task.id, { detail: `${task.detail}\n${mats.map(materialDetailLine).join('\n')}` }, `吸附材料 ${mats.length} 份`)
      : task;
```

其后所有对 `task` 的引用（`logger.info`、`systemNotify`、`analyze(task)`、`runReviewFlow(task.id, ctx)`）改用 `withMats`；两处 ack 回复改为：

```js
      await ctx.reply(`${tag} ${msg('feedbackAck')}${mats.length ? `（已带上材料 ${mats.length} 份）` : ''}`);
```

```js
    await ctx.reply(`${tag} ${msg('feedbackAck')}${mats.length ? `（已带上材料 ${mats.length} 份）` : ''}（AI 评审中，稍后回复结论）`);
```

- [ ] **Step 5: entrypoints/feishu/index.js —— 图片挂不上入池 + ctx.meta.hasMaterials**

顶部 import 增加：

```js
import { addMaterial, hasMaterials } from '../../plugins/team-tools/material-pool.js';
import { msg } from '../../shared/messages.js';
```

图片分支（原 :27-40）改为：

```js
  if (m.kind === 'image') {
    const file = m.images[0];
    if (!file) {
      await channel.send(m.chatKey, { text: '图片下载失败，请稍后重试～' });
      return;
    }
    const task = attachImageToRecentTask(m.userId, file);
    if (task) {
      await channel.send(m.chatKey, { text: `🖼 已把截图补充到「${task.title}」，会结合截图分析处理。` });
    } else {
      // 先图后文：入材料池，等下一条文字立案时吸附（替代原「请随文字一起发」提示）
      addMaterial(m.userId, m.chatKey, { kind: 'image', path: file });
      await channel.send(m.chatKey, { text: msg('materialAck') });
    }
    return;
  }
```

ctx 组装（原 :46-53）的 meta 加一个字段：

```js
    meta: { messageId: m.messageId, chatId: m.chatKey, hasMaterials: hasMaterials(m.userId, m.chatKey) },
```

- [ ] **Step 6: 全量回归**

Run: `npm test`
Expected: PASS

---

## 阶段二：常驻 auto 工作区

### Task 6: git.js worktree 能力

**Files:**
- Modify: `src/plugins/team-tools/auto-dev/git.js`
- Modify: `src/plugins/team-tools/auto-dev/git.test.js`（追加用例）

- [ ] **Step 1: 写失败测试（git.test.js 追加；纯函数部分）**

```js
import { autoWorktreeDir, worktreeAddArgs, checkoutNewFromBaseArgs } from './git.js';

test('autoWorktreeDir：项目路径 + .auto 后缀，容忍尾部斜杠', () => {
  assert.equal(autoWorktreeDir('C:/work/my-app'), 'C:/work/my-app.auto');
  assert.equal(autoWorktreeDir('C:/work/my-app/'), 'C:/work/my-app.auto');
  assert.equal(autoWorktreeDir('C:\\work\\my-app\\'), 'C:\\work\\my-app.auto');
});

test('worktreeAddArgs / checkoutNewFromBaseArgs 参数拼装', () => {
  assert.deepEqual(worktreeAddArgs('C:/r', 'C:/r.auto'), ['-C', 'C:/r', 'worktree', 'add', '--detach', 'C:/r.auto']);
  assert.deepEqual(checkoutNewFromBaseArgs('C:/r.auto', 'auto/t1', 'main'), ['-C', 'C:/r.auto', 'checkout', '-B', 'auto/t1', 'main']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/auto-dev/git.test.js`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现（git.js 追加）**

```js
// ---- 常驻 auto 工作区：所有自动任务在 <repo>.auto 里执行，主工作区永不被切分支 ----

/** auto 工作区目录：项目路径去尾斜杠 + .auto 后缀（纯函数） */
export function autoWorktreeDir(repo) {
  return String(repo).replace(/[\\/]+$/, '') + '.auto';
}

export function worktreeAddArgs(repo, dir) {
  return ['-C', repo, 'worktree', 'add', '--detach', dir];
}

/** -B 从 base 的 commit 建/重置分支——不检出 base 本身，绕开「同一分支不能双 worktree 检出」限制 */
export function checkoutNewFromBaseArgs(dir, branch, base) {
  return ['-C', dir, 'checkout', '-B', branch, base];
}

/**
 * 确保常驻 auto 工作区可用：健康 → 直接用；缺失 → prune 后重建；
 * 目录存在但已不是有效 worktree → 明确失败（绝不自动删用户目录）。
 * @returns {{ ok:boolean, dir:string, created?:boolean, error?:string }}
 */
export async function ensureAutoWorktree(repo) {
  const dir = autoWorktreeDir(repo);
  const health = await git(['-C', dir, 'rev-parse', '--is-inside-work-tree']);
  if (health.ok) return { ok: true, dir };
  await git(['-C', repo, 'worktree', 'prune']);
  const r = await git(worktreeAddArgs(repo, dir));
  if (!r.ok) {
    const error = (r.err || r.msg || 'worktree add 失败').slice(0, 300);
    logger.warn('auto-dev', 'ensureAutoWorktree 失败', { repo, dir, error });
    return { ok: false, dir, error };
  }
  return { ok: true, dir, created: true };
}

/**
 * 自愈：auto 工作区有未提交残留（上个任务异常中断）→ 就地 commit 留痕，不丢数据。
 * detached HEAD 上的 commit 也可行（仅留痕，不追求可达性）。
 */
export async function commitResidue(dir) {
  const r = await git(['-C', dir, 'status', '--porcelain']);
  if (!r.ok || !(r.out || '').trim()) return { committed: false };
  await git(['-C', dir, 'add', '-A']);
  const c = await git(['-C', dir, 'commit', '-m', 'wip: 自动保存上个任务残留（auto 工作区自愈）']);
  logger.warn('auto-dev', 'auto 工作区残留已自动提交留痕', { dir, ok: c.ok });
  return { committed: c.ok };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/auto-dev/git.test.js`
Expected: PASS

### Task 7: develop 支持 cwd 覆盖（task-ops.js）

**Files:**
- Modify: `src/plugins/team-tools/task-ops.js:80-113`

- [ ] **Step 1: 实现**

`develop` 签名与 cwd 取值改为（其余不动）：

```js
export async function develop(task, opts = {}) {
  logger.info('task-ops', '▶ develop', { id: task.id, type: task.type, title: task.title });
  const isBug = task.type === 'bug';
  const botCtx = botTaskContext();
  const cwd = opts.cwd || botCtx.cwd; // auto-dev 管线传 auto 工作区；其余调用方保持原目录
  let out = '';
  let ok = true;
```

`runClaude` 选项里 `cwd: botCtx.cwd,` 改为 `cwd,`。

- [ ] **Step 2: 回归**

Run: `npm test`
Expected: PASS（opts 可选，旧调用 develop(task) 行为不变）

### Task 8: auto-dev runOne 改造（核心）

**Files:**
- Modify: `src/plugins/team-tools/auto-dev/index.js`

- [ ] **Step 1: import 与 recoverOnBoot 调整**

import 行更新：

```js
import { currentBranch, ensureBranch, commitAll, ensureAutoWorktree, commitResidue, checkoutNewFromBaseArgs } from './git.js';
import { runScript } from '../../../integrations/shell.js';
import { systemNotify } from '../../../integrations/notify.js';
import fs from 'node:fs';
import path from 'node:path';
```

`recoverOnBoot` 中删除「尽力切回基线」两行（`if (t.repo && t.baseBranch) { ensureBranch(...) }`）——auto 工作区自愈已接管，主工作区从未被切走。`ensureBranch` 若因此不再被本文件引用，从 import 中移除。

- [ ] **Step 2: 新增 runSetup（放在 runOne 之前）**

```js
/** worktree 首建初始化：bot.setupScript 优先；未配置且缺依赖 → 通知 owner（不阻塞任务） */
async function runSetup(autoDir) {
  const setup = (getActiveBot()?.setupScript || '').trim();
  if (setup) {
    logger.info('auto-dev', '执行 worktree 初始化脚本', { autoDir, setup });
    const r = await runScript(setup, [], { cwd: autoDir, shell: true });
    if (!r.ok) logger.warn('auto-dev', 'setupScript 失败（不阻塞）', { err: (r.err || r.msg || '').slice(0, 300) });
    return;
  }
  if (fs.existsSync(path.join(autoDir, 'package.json')) && !fs.existsSync(path.join(autoDir, 'node_modules'))) {
    systemNotify('auto 工作区需要安装依赖', `${autoDir}\n请在该目录执行安装命令，或在机器人配置里填写初始化脚本`);
  }
}
```

- [ ] **Step 3: 整体替换 runOne**

```js
async function runOne(task) {
  const repo = getActiveBot()?.projectDir || config.feedback.frontendDir;
  const baseBranch = await currentBranch(repo);
  if (!baseBranch || baseBranch === 'HEAD') {
    updateTask(task.id, { status: 'analyzed' }, '自动开发失败：目标工程不是 git 仓库或处于 detached HEAD');
    await replySource(task, false, null, '目标工程无法识别当前分支');
    return;
  }
  // 常驻 auto 工作区：所有自动任务在 <repo>.auto 执行，主工作区永不被切分支。
  // 创建失败明确报错转人工，不降级回主工作区（隐性降级会静默回到互相干扰的旧模型）。
  const wt = await ensureAutoWorktree(repo);
  if (!wt.ok) {
    updateTask(task.id, { status: 'analyzed' }, `自动开发失败：auto 工作区不可用（${wt.error}）`);
    await replySource(task, false, null, `auto 工作区创建失败：${wt.error}`);
    return;
  }
  const autoDir = wt.dir;
  if (wt.created) await runSetup(autoDir);
  await commitResidue(autoDir); // 自愈：上个任务异常中断的残留就地留痕

  const branch = taskBranchName(task);
  // -B 从 baseBranch 的 commit 建分支（不检出 baseBranch 本身）；幂等，崩溃重跑安全
  const co = await runScript('git', checkoutNewFromBaseArgs(autoDir, branch, baseBranch), { shell: false });
  if (!co.ok) {
    updateTask(task.id, { status: 'analyzed' }, `自动开发失败：创建任务分支 ${branch} 失败`);
    await replySource(task, false, null, '创建任务分支失败');
    return;
  }
  // repo 一并快照：合并时用任务自己的仓库（主工作区路径），不受此后切换启用机器人影响
  updateTask(task.id, { status: 'developing', auto: true, repo, branch, baseBranch, merged: false },
    `自动开发（auto 工作区，分支 ${branch}，基线 ${baseBranch}）`);

  const r = await develop(task, { cwd: autoDir }); // 在 auto 工作区改码
  await commitAll(autoDir, buildCommitMessage(task, r.ok));
  // 不切回基线：auto 工作区停在任务分支无碍，下个任务 checkout -B 直接覆盖；主工作区自始至终没动

  if (!r.ok) {
    updateTask(task.id, { status: 'analyzed' }, '自动开发失败，退回待开发（可人工重试）');
    await replySource(task, false, null, null);
    return;
  }

  // 编译二维码：在 auto 工作区跑（可选能力，失败不阻塞）
  let qrUrl = null;
  try {
    const c = await compileDevQrcode({ repo: autoDir, branch });
    qrUrl = c.qrUrl;
  } catch (e) {
    logger.warn('auto-dev', '编译二维码失败（忽略）', { id: task.id, err: e?.message || String(e) });
  }
  updateTask(task.id, {}, '自动开发完成，待确认合并');
  await replySource(task, true, qrUrl, null, { branch, baseBranch });
}
```

注意：原「基线守卫」`if (baseBranch.startsWith('auto/'))` 整段删除——主工作区分支即基线且永不被切，「工作区状态异常」路径不复存在。合并流程（`mergeBranch`，在主工作区 repo 上执行）不动：worktree 分支互通，merge 只 checkout target 不 checkout source。

- [ ] **Step 4: 回归 + 语法检查**

Run: `npm test && node --check src/plugins/team-tools/auto-dev/index.js`
Expected: PASS

### Task 9: bot 配置 setupScript 字段（存储 + 路由 + UI）

**Files:**
- Modify: `src/store/settings.js:69-83`（makeBotEntry）
- Modify: `src/entrypoints/web/routes-settings.js:151-191`（botView + cleanBotInput）
- Modify: `public/index.html:308-310` 附近（表单）
- Modify: `public/js/bots-panel.js:104-138`（回填 + 收集）
- Modify: `src/store/settings.test.js`（追加用例）

- [ ] **Step 1: 写失败测试（settings.test.js 追加）**

```js
test('makeBotEntry：setupScript 字符串收录，非字符串归空', () => {
  const now = '2026-07-29T00:00:00.000Z';
  const a = makeBotEntry({ id: 'b1', setupScript: 'npm install', index: 0, now });
  assert.equal(a.setupScript, 'npm install');
  const b = makeBotEntry({ id: 'b2', setupScript: 123, index: 0, now });
  assert.equal(b.setupScript, '');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/store/settings.test.js`
Expected: FAIL（setupScript undefined）

- [ ] **Step 3: settings.js**

`makeBotEntry` 参数列表加 `setupScript`，返回对象 `projectNotes` 行后加：

```js
    setupScript: typeof setupScript === 'string' ? setupScript : '', // auto 工作区首建初始化脚本（如 npm install）
```

`addBot` 的参数解构与 `makeBotEntry` 调用各加 `setupScript`（`updateBot` 走 patch 展开，无需改）。

Run: `node --test src/store/settings.test.js` → PASS

- [ ] **Step 4: routes-settings.js**

`botView` 返回对象加 `setupScript: b.setupScript || '',`（projectNotes 行后）。
`cleanBotInput` 的 projectNotes 块后加：

```js
  if (typeof data.setupScript === 'string') {
    const setup = data.setupScript.trim();
    if (setup.length > MAX_LEN) return { error: `初始化脚本超过 ${MAX_LEN} 字符` };
    out.setupScript = setup;
  }
```

- [ ] **Step 5: 前端表单**

`public/index.html` 在工程说明 `</label>`（:310）之后插入：

```html
              <label class="set-field">auto 工作区初始化脚本（可空；自动开发工作区首次创建后执行一次）
                <input id="botSetupScript" placeholder="如 npm install" autocomplete="off" />
              </label>
```

`public/js/bots-panel.js` 回填处（:110 后）加 `$('#botSetupScript').value = bot?.setupScript || '';`；收集处（:135 后）加 `setupScript: $('#botSetupScript').value.trim(),`。

- [ ] **Step 6: 回归**

Run: `npm test`
Expected: PASS

---

## 阶段三：飞书文档提取

### Task 10: 报文解析纯函数（file 消息 + 富文本链接 + 云文档链接提取）

**Files:**
- Modify: `src/channels/feishu-normalize.js`
- Create/Modify: `src/channels/feishu-normalize.test.js`（无则新建）

- [ ] **Step 1: 写失败测试**

```js
// src/channels/feishu-normalize.test.js（如已存在则追加用例，import 合并）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFileContent, extractDocLinks, stripDocLinks, parsePostContent } from './feishu-normalize.js';

test('parseFileContent：取 file_key 与文件名', () => {
  assert.deepEqual(
    parseFileContent(JSON.stringify({ file_key: 'fk1', file_name: '联调文档.docx' })),
    { fileKey: 'fk1', fileName: '联调文档.docx' },
  );
  assert.equal(parseFileContent('{}'), null);
  assert.equal(parseFileContent('not-json'), null);
});

test('extractDocLinks：识别 docx/wiki 链接与 token', () => {
  const text = '看这个 https://abc.feishu.cn/docx/AbCd1234 和 https://abc.feishu.cn/wiki/WkTk5678?from=x';
  assert.deepEqual(extractDocLinks(text), [
    { url: 'https://abc.feishu.cn/docx/AbCd1234', kind: 'docx', token: 'AbCd1234' },
    { url: 'https://abc.feishu.cn/wiki/WkTk5678', kind: 'wiki', token: 'WkTk5678' },
  ]);
  assert.deepEqual(extractDocLinks('没有链接'), []);
});

test('stripDocLinks：去掉链接后剩余文本', () => {
  assert.equal(stripDocLinks('https://abc.feishu.cn/docx/AbCd1234'), '');
  assert.equal(stripDocLinks('按这个联调 https://abc.feishu.cn/docx/AbCd1234'), '按这个联调');
});

test('parsePostContent：a 标签保留 href（云文档链接不再丢失）', () => {
  const content = JSON.stringify({
    title: 'T',
    content: [[{ tag: 'a', text: '联调文档', href: 'https://abc.feishu.cn/docx/AbCd1234' }]],
  });
  const r = parsePostContent(content);
  assert.ok(r.text.includes('https://abc.feishu.cn/docx/AbCd1234'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/channels/feishu-normalize.test.js`
Expected: FAIL

- [ ] **Step 3: 实现（feishu-normalize.js）**

`parsePostContent` 中 a 标签行改为（href 一并保留，供 extractDocLinks 识别）：

```js
      else if (node.tag === 'a') {
        const s = [node.text, node.href].filter(Boolean).join(' ');
        if (s) parts.push(s);
      }
```

文件末尾追加：

```js
/** file 消息 content → { fileKey, fileName }（解析失败返回 null） */
export function parseFileContent(content) {
  try {
    const c = JSON.parse(content);
    return c.file_key ? { fileKey: c.file_key, fileName: c.file_name || '' } : null;
  } catch {
    return null;
  }
}

// 飞书云文档链接（docx 直链 / wiki 需换 token）；token 后允许 ?query
const DOC_LINK_RE = /https?:\/\/[\w.-]+\.(?:feishu\.cn|larksuite\.com)\/(docx|wiki)\/([A-Za-z0-9]+)(?:\?[\w&=%.~-]*)?/g;

/** 抽取文本中的云文档链接：[{ url, kind:'docx'|'wiki', token }] */
export function extractDocLinks(text) {
  const out = [];
  for (const m of String(text || '').matchAll(DOC_LINK_RE)) {
    out.push({ url: m[0], kind: m[1], token: m[2] });
  }
  return out;
}

/** 去掉云文档链接后的剩余文本（判断消息是否「纯链接」） */
export function stripDocLinks(text) {
  return String(text || '').replace(DOC_LINK_RE, '').trim();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/channels/feishu-normalize.test.js`
Expected: PASS

### Task 11: lark.js —— 文件下载保留扩展名 + 云文档 API

**Files:**
- Modify: `src/integrations/lark.js:124-151`（downloadMessageResource）+ 文件末尾追加两个 API

- [ ] **Step 1: downloadMessageResource 支持文件名（第 4 参可选，向后兼容）**

签名与命名逻辑改为：

```js
export async function downloadMessageResource(messageId, fileKey, type = 'image', fileName = '') {
  try {
    const resp = await getClient().im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    const chunks = [];
    for await (const c of await resp.getReadableStream()) chunks.push(c);
    const buf = Buffer.concat(chunks);
    fs.mkdirSync(RESOURCE_DIR, { recursive: true });
    // 文件消息带原始文件名 → 保留（清洗+截尾），Claude 按扩展名识别；图片仍按魔数判扩展名
    const safeName = fileName ? fileName.replace(/[^\w.一-龥-]+/g, '_').slice(-60) : '';
    const suffix = type === 'file' && safeName ? '-' + safeName : imageExt(buf);
    const file = path.join(
      RESOURCE_DIR,
      Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + suffix,
    );
    fs.writeFileSync(file, buf);
    logger.info('lark', '下载消息资源', { messageId, fileKey, file, bytes: buf.length });
    return file;
  } catch (e) {
    logger.error('lark', '下载消息资源失败', { messageId, fileKey, err: e?.message || String(e) });
    return null;
  }
}
```

- [ ] **Step 2: 追加云文档 API（文件末尾）**

```js
/**
 * 拉取飞书云文档纯文本（docx OpenAPI）。
 * 前置：应用需 docx:document:readonly 权限，且文档对机器人可见（分享协作者/组织内可读）。
 * 无权限/不存在 → 抛错（调用方回复引导话术，不静默丢材料）。
 */
export async function fetchDocRawContent(documentId) {
  const r = await getClient().docx.v1.document.rawContent({ path: { document_id: documentId } });
  const content = r?.data?.content ?? r?.content;
  if (typeof content !== 'string') throw new Error('raw_content 无内容返回');
  return content;
}

/** wiki 链接换 docx token（需 wiki:wiki:readonly）；非 docx 类型节点返回 null */
export async function resolveWikiNode(token) {
  const r = await getClient().request({
    method: 'GET',
    url: '/open-apis/wiki/v2/spaces/get_node',
    params: { token },
  });
  const node = r?.data?.node || r?.node;
  return node?.obj_type === 'docx' ? node.obj_token : null;
}
```

- [ ] **Step 3: 语法检查 + 回归**

Run: `node --check src/integrations/lark.js && npm test`
Expected: PASS

### Task 12: docx 解析（mammoth）

**Files:**
- Create: `src/integrations/docx.js`
- Modify: `package.json`（新增依赖）

- [ ] **Step 1: 安装依赖**

Run: `npm install mammoth`
Expected: package.json dependencies 出现 mammoth

- [ ] **Step 2: 实现**

```js
// src/integrations/docx.js
/**
 * docx → 纯文本（mammoth.extractRawText，够材料用途；不追求版式还原）。
 * 失败抛错，调用方降级为附原文件路径。
 */
import fs from 'node:fs';
import mammoth from 'mammoth';

/** 解析 docx 为文本，并在原目录旁存 .md，返回 md 路径 */
export async function docxToMdFile(docxPath, title = '') {
  const r = await mammoth.extractRawText({ path: docxPath });
  const text = (r.value || '').trim();
  if (!text) throw new Error('docx 解析结果为空');
  const mdPath = docxPath.replace(/\.docx$/i, '') + '.md';
  fs.writeFileSync(mdPath, `# ${title || 'docx 材料'}\n\n${text}`, 'utf8');
  return mdPath;
}
```

- [ ] **Step 3: 冒烟验证（用系统里任意 docx，或跳过留给走查）**

Run: `node -e "import('./src/integrations/docx.js').then(m => console.log(typeof m.docxToMdFile))"`
Expected: 输出 `function`

### Task 13: channel file 分支 + 入口整合（文件/云文档 → 材料）

**Files:**
- Modify: `src/channels/feishu.js:85-128`（toInbound）
- Modify: `src/entrypoints/feishu/index.js`（onInbound）

- [ ] **Step 1: channels/feishu.js —— file 消息归一化**

import 行补 `parseFileContent`：

```js
import { parseTextContent, parseImageContent, parsePostContent, parseFileContent } from './feishu-normalize.js';
```

`toInbound` 中 `if (msgType === 'text')` 之前插入：

```js
    if (msgType === 'file') {
      const parsed = parseFileContent(data.message.content);
      if (!parsed) return null;
      const file = await downloadMessageResource(messageId, parsed.fileKey, 'file', parsed.fileName);
      // 下载失败 → files 空数组，业务侧据此提示
      return { ...base, kind: 'file', text: '', images: [], files: file ? [{ path: file, name: parsed.fileName }] : [] };
    }
```

同文件 import（来自 integrations/lark.js）已含 `downloadMessageResource`，无需改。末尾 `unsupported` 提示文案（在 entrypoints 侧）本 Task Step 3 一并更新。

- [ ] **Step 2: entrypoints/feishu/index.js —— 文件与云文档处理**

顶部 import 增加：

```js
import { extractDocLinks, stripDocLinks } from '../../channels/feishu-normalize.js';
import { fetchDocRawContent, resolveWikiNode } from '../../integrations/lark.js';
import { saveTextMaterial } from '../../plugins/team-tools/material-pool.js';
import { attachMaterialToRecentTask } from '../../plugins/team-tools/task-ops.js';
import { docxToMdFile } from '../../integrations/docx.js';
```

（Task 5 已引入 `addMaterial/hasMaterials/msg`，合并到同一 import 行。）

`onInbound` 中，图片分支之后插入两个处理块：

```js
  // 文件消息：按扩展名归一化为材料（先挂近期任务，挂不上入池）
  if (m.kind === 'file') {
    if (!getPluginEnabled('team-tools')) {
      await channel.send(m.chatKey, { text: '目前支持文本和富文本消息～' });
      return;
    }
    const f = m.files?.[0];
    if (!f) {
      await channel.send(m.chatKey, { text: '文件下载失败，请稍后重试～' });
      return;
    }
    const ext = (f.name.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || '';
    let material = null;
    if (['md', 'txt', 'json', 'pdf'].includes(ext)) {
      material = { kind: 'file', path: f.path, title: f.name };
    } else if (ext === 'docx') {
      try {
        const mdPath = await docxToMdFile(f.path, f.name);
        material = { kind: 'file', path: mdPath, title: f.name };
      } catch (e) {
        logger.warn('feishu', 'docx 解析失败，附原件路径', { err: e?.message || String(e) });
        material = { kind: 'file', path: f.path, title: `${f.name}（未能解析，docx 原件）` };
      }
    } else {
      await channel.send(m.chatKey, { text: `暂不支持解析 .${ext || '未知'} 文件，请转成文档（md/pdf/docx）或直接粘贴关键内容～` });
      return;
    }
    const task = attachMaterialToRecentTask(m.userId, material);
    await channel.send(m.chatKey, {
      text: task ? `📎 已把「${f.name}」补充到「${task.title}」，会结合材料处理。` : msg('materialAck'),
    });
    if (!task) addMaterial(m.userId, m.chatKey, material);
    return;
  }
```

文本分支（构造 ctx 之前）插入云文档链接提取：

```js
  // 云文档链接：拉取内容存为材料；纯链接消息不进 dispatch，带正文的链接消息取完材料继续分发
  const docLinks = getPluginEnabled('team-tools') ? extractDocLinks(m.text) : [];
  if (docLinks.length) {
    for (const link of docLinks) {
      try {
        const docToken = link.kind === 'wiki' ? await resolveWikiNode(link.token) : link.token;
        if (!docToken) throw new Error('wiki 节点不是 docx 文档');
        const content = await fetchDocRawContent(docToken);
        const title = content.split('\n')[0]?.trim().slice(0, 30) || '飞书文档';
        const path = saveTextMaterial(title, content);
        const material = { kind: 'doc', path, title };
        const task = attachMaterialToRecentTask(m.userId, material);
        if (task) {
          await channel.send(m.chatKey, { text: `📄 已把文档「${title}」补充到「${task.title}」。` });
        } else {
          addMaterial(m.userId, m.chatKey, material);
        }
      } catch (e) {
        logger.warn('feishu', '云文档拉取失败', { url: link.url, err: e?.message || String(e) });
        await channel.send(m.chatKey, {
          text: '📄 检测到飞书文档链接，但机器人没有阅读权限或文档不存在。请在文档右上角把机器人加为协作者，或导出为文件/粘贴内容发我～',
        });
      }
    }
    const rest = stripDocLinks(m.text);
    if (!rest) {
      // 纯链接消息：材料已归属/入池，若入了池补一句提示
      if (hasMaterials(m.userId, m.chatKey)) await channel.send(m.chatKey, { text: msg('materialAck') });
      return;
    }
    m = { ...m, text: rest }; // 带正文：剥掉链接后继续正常分发（材料已入池，hasMaterials 生效）
  }
```

`unsupported` 分支提示更新为：`'目前支持文本、图片、文件和富文本消息～'`。

- [ ] **Step 3: 语法检查 + 全量回归**

Run: `node --check src/entrypoints/feishu/index.js && node --check src/channels/feishu.js && npm test`
Expected: PASS

### Task 14: 人工走查（真实飞书环境验收）

**Files:** 无代码改动；逐条验证并记录结果。

- [ ] **走查 1（原始误判案例）**：向机器人整篇粘贴一份含「错误码」表的接口文档 → 应回复「已收到材料」（不再立案为故障）；接着发「按这个文档联调宝宝辅食页面」→ 应立案为 **[需求]** 且 ack 带「已带上材料 1 份」
- [ ] **走查 2（先图后文）**：单发一张截图（此前 10 分钟无任务）→ 应回复 materialAck；再发「这个页面按钮点不动」→ 立案 [故障] 且吸附截图
- [ ] **走查 3（文件上传）**：发送 .docx 文件 → materialAck；查看 `.uploads/feishu/materials/`（或资源目录）应有转换后的 .md
- [ ] **走查 4（云文档，需先配好开放平台权限）**：发送 docx 云文档链接 → 有权限时回 materialAck / 无权限时回引导话术
- [ ] **走查 5（auto 工作区自愈）**：中度托管下提交一个 BUG 并坚持修改 → 确认改码发生在 `<projectDir>.auto`、主工作区分支未变；手动在 `<projectDir>.auto` 制造脏文件后再跑一个任务 → 应看到「wip: 自动保存上个任务残留」提交且任务正常执行
- [ ] **走查 6（合并链路回归）**：走查 5 的任务在 web 管理台点确认合并 → auto/<id> 成功合入基线分支

---

## 依赖与风险备忘

| 事项 | 说明 |
|---|---|
| 开放平台权限（阶段三前置，人工） | `docx:document:readonly` + `wiki:wiki:readonly`，加权限后需发布新版本；文档需对机器人可见 |
| mammoth 依赖 | 阶段三才引入；纯 JS 无原生编译，Tauri 打包无影响 |
| `im.message.receive_v1` 事件已含 file 类型 | 无需新增事件订阅；仅消息体解析扩展 |
| 老任务兼容 | 阶段二上线前已入队的任务：`repo/baseBranch` 快照字段含义不变，合并链路不受影响 |

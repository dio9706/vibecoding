# 飞书意图识别收缩 + 即时应答 + 放弃改动 + 群聊 @ 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把飞书机器人的意图识别收缩为「需求 / 故障 / 项目问询 / 自定义动作」四类显式意图，识别即秒回，未识别只回引导文案；并补齐待合并任务的「放弃改动」与群聊 @ 回复。

**Architecture:** 意图识别改为四层短路（寒暄 → 强意图前缀 → 动作关键词单命中 → 一次 Haiku 合并分类 10s 超时 → 引导文案兜底），最坏 LLM 调用从 2×30s 降到 1×10s；即时应答由各 feature 首步发送；`project-qa` 从 `intents:['other']` 兜底改为 `intents:['question']` 显式问询（这是「放开限制后变慢」的元凶）；放弃改动走 `git branch -D` + web 面板按钮；群聊靠 `chat_type` + `mentions` 过滤并给回复加 `<at>` 前缀。

**Tech Stack:** Node.js ESM、`node --test`（内置 test runner）、`@larksuiteoapi/node-sdk`、`@anthropic-ai/claude-agent-sdk`、原生 DOM（无框架前端）。

**Spec:** `docs/superpowers/specs/2026-07-30-feishu-intent-shrink-design.md`

**项目铁律（务必遵守）：**
- **本项目所有工作不做 git 提交**（提交时机由用户掌控）。计划里没有 commit 步骤，每个任务以「跑测试」收口。
- 正则一律**不加 `g` flag**（`.test()` 有状态会导致重复调用结果不确定，本项目踩过）。
- 用户可见文案统一走 `src/shared/messages.js`，调用点每次调 `msg()`，**不要存模块级常量**（配置保存后下一条消息即生效）。
- 全量测试命令：`npm test`（等价 `node --test "src/**/*.test.js"`）。

---

## 文件结构

**新建：**
- `src/app/intent-keywords.js` —— 强意图前缀词表 + `matchStrongIntent`（纯函数，唯一职责：把「提交需求：xxx」变成 `{type,body}`）
- `src/app/intent-keywords.test.js`
- `src/shared/mention.js` —— `atPrefix(openId, chatType)`（纯函数，群聊 @ 前缀唯一出口）
- `src/shared/mention.test.js`
- `src/shared/messages.test.js`

**修改：**
- `src/app/intent.js` —— 重写编排，删宽泛正则与两段式 LLM
- `src/app/intent.test.js` —— 删 `feedbackRoute` 用例，补新流程
- `src/features/llm-classify.js` —— `runClassifierOnce` 增加可选 `timeoutMs`
- `src/shared/messages.js` —— 新增 3 条即时应答、改 `welcome`、删 `feedbackAck`
- `src/plugins/team-tools/feedback/index.js` —— 即时应答 + 空正文保护 + 轻度托管闭环 + `source.chatType`
- `src/plugins/team-tools/project-qa/index.js` —— `intents:['question']` + 串行闸 + 超时 + 截断
- `src/channels/feishu-normalize.js` + `.test.js` —— `parseMentions` / `stripMentions`
- `src/channels/feishu.js` —— `toInbound` 带出 `chatType` / `mentions`，正文剥占位符
- `src/integrations/lark.js` —— `getBotOpenId()`（带缓存，`resetApiClient` 清缓存）
- `src/entrypoints/feishu/index.js` —— 群聊仅 @ 才响应 + `ctx.reply` 加 @ 前缀
- `src/plugins/team-tools/auto-dev/index.js` —— `replySource` 加 @ 前缀
- `src/plugins/team-tools/auto-dev/git.js` + `git.test.js` —— `deleteBranchArgs` / `deleteBranch`
- `src/entrypoints/web/routes-ops.js` —— `action:'discard'`
- `public/js/tasks-panel.js` —— 「放弃改动」按钮
- `docs/ARCHITECTURE.md` —— 意图识别数据流章节

---

## Task 1：强意图前缀词表（纯函数）

**Files:**
- Create: `src/app/intent-keywords.js`
- Test: `src/app/intent-keywords.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/app/intent-keywords.test.js`：

```js
/**
 * 强意图前缀单测 —— 收缩后的零成本快路。
 * 铁律：只匹配消息开头；长文中间出现关键词绝不命中（历史事故：接口文档整篇贴入被误判为故障）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchStrongIntent } from './intent-keywords.js';

test('需求前缀：各种说法都命中 feature，并剥出正文', () => {
  const cases = [
    ['提交需求：登录页加记住密码', '登录页加记住密码'],
    ['提交需求: 登录页加记住密码', '登录页加记住密码'],
    ['提个需求，登录页加记住密码', '登录页加记住密码'],
    ['提一个需求 登录页加记住密码', '登录页加记住密码'],
    ['有个需求：登录页加记住密码', '登录页加记住密码'],
    ['有一个需求 登录页加记住密码', '登录页加记住密码'],
    ['提需求：登录页加记住密码', '登录页加记住密码'],
    ['需求：登录页加记住密码', '登录页加记住密码'],
  ];
  for (const [input, body] of cases) {
    assert.deepEqual(matchStrongIntent(input), { type: 'feature', body }, `输入：${input}`);
  }
});

test('故障前缀：各种说法都命中 bug，bug 大小写不敏感', () => {
  const cases = [
    ['提交故障：扫码页白屏', '扫码页白屏'],
    ['提个故障 扫码页白屏', '扫码页白屏'],
    ['有个故障：扫码页白屏', '扫码页白屏'],
    ['提交BUG：扫码页白屏', '扫码页白屏'],
    ['提个bug，扫码页白屏', '扫码页白屏'],
    ['有个Bug：扫码页白屏', '扫码页白屏'],
    ['报个bug：扫码页白屏', '扫码页白屏'],
    ['提交问题：扫码页白屏', '扫码页白屏'],
    ['故障：扫码页白屏', '扫码页白屏'],
    ['bug：扫码页白屏', '扫码页白屏'],
  ];
  for (const [input, body] of cases) {
    assert.deepEqual(matchStrongIntent(input), { type: 'bug', body }, `输入：${input}`);
  }
});

test('问询前缀：各种说法都命中 question', () => {
  const cases = [
    ['问个问题：订单状态怎么流转', '订单状态怎么流转'],
    ['问一个问题 订单状态怎么流转', '订单状态怎么流转'],
    ['想问一下，订单状态怎么流转', '订单状态怎么流转'],
    ['问一下 订单状态怎么流转', '订单状态怎么流转'],
    ['请问订单状态怎么流转', '订单状态怎么流转'],
    ['有个疑问：订单状态怎么流转', '订单状态怎么流转'],
    ['咨询一下 订单状态怎么流转', '订单状态怎么流转'],
  ];
  for (const [input, body] of cases) {
    assert.deepEqual(matchStrongIntent(input), { type: 'question', body }, `输入：${input}`);
  }
});

test('只发前缀不带正文 → 命中且 body 为空串（调用方据此追问）', () => {
  assert.deepEqual(matchStrongIntent('提交需求'), { type: 'feature', body: '' });
  assert.deepEqual(matchStrongIntent('提交故障：'), { type: 'bug', body: '' });
  assert.deepEqual(matchStrongIntent('问个问题 '), { type: 'question', body: '' });
});

test('关键词出现在长文中间 → 不命中（避免整篇文档被误判）', () => {
  const long = '这是本次联调的接口文档，若有需求：请联系产品；如遇bug：请提工单。' + '字'.repeat(200);
  assert.equal(matchStrongIntent(long), null);
});

test('歧义表达不入词表 → 不命中，交给语义分类', () => {
  for (const t of ['有个问题想跟你说', '这个不能用了', '希望能优化一下', '登录页白屏了', '今天天气不错']) {
    assert.equal(matchStrongIntent(t), null, `期望不命中：${t}`);
  }
});

test('前导空白/表情不影响命中', () => {
  assert.deepEqual(matchStrongIntent('  提交需求：加导出'), { type: 'feature', body: '加导出' });
  assert.deepEqual(matchStrongIntent('👍 提交故障：白屏'), { type: 'bug', body: '白屏' });
});

test('空/非字符串输入 → null（不抛错）', () => {
  assert.equal(matchStrongIntent(''), null);
  assert.equal(matchStrongIntent(null), null);
  assert.equal(matchStrongIntent(undefined), null);
});

test('重复调用结果稳定（正则无 g flag 的回归保护）', () => {
  const t = '提交需求：加导出';
  assert.deepEqual(matchStrongIntent(t), matchStrongIntent(t));
  assert.deepEqual(matchStrongIntent(t), { type: 'feature', body: '加导出' });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/app/intent-keywords.test.js`
Expected: FAIL —— `Cannot find module ... intent-keywords.js`

- [ ] **Step 3: 实现**

创建 `src/app/intent-keywords.js`：

```js
/**
 * 强意图前缀词表（纯函数，零 LLM 成本的意图快路）。
 *
 * 设计铁律：
 * 1. **只匹配消息开头**——历史事故：后端接口文档整篇贴入，全文命中「错误/异常」被误判为故障。
 * 2. 只收**显式提交意图**的说法；歧义表达（「有个问题」「不能用了」「希望优化」）一律不收，
 *    交给一次 Haiku 语义分类。宁可多花一次分类调用，也不要误立案。
 * 3. 正则不加 g flag（.test()/.exec() 有状态会让重复调用结果不确定）。
 */

// 前缀与正文之间允许的分隔符（也允许直接相接，如「请问订单状态…」）
const SEP = '[\\s:：,，。、\\-—]*';
// 行首允许的噪声：空白 / 标点 / 表情（\p{S} 覆盖 emoji 的符号类，\p{Emoji_Presentation} 覆盖其余）
const LEAD = '^[\\s\\p{P}\\p{S}\\p{Emoji_Presentation}]*';

/** 每类的前缀候选（长的写在前，避免「提需求」抢先吃掉「提交需求」的匹配） */
const GROUPS = [
  {
    type: 'feature',
    words: ['提交需求', '提个需求', '提一个需求', '有一个需求', '有个需求', '提需求', '需求'],
  },
  {
    type: 'bug',
    words: [
      '提交故障', '提个故障', '有一个故障', '有个故障', '提交问题',
      '提交bug', '提个bug', '有一个bug', '有个bug', '报个bug', '报一个bug',
      '故障', 'bug',
    ],
  },
  {
    type: 'question',
    words: ['问一个问题', '问个问题', '想问一下', '想问', '问一下', '有个疑问', '有一个疑问', '咨询一下', '咨询', '请问'],
  },
];

/** 词表 → 编译好的正则（模块加载时一次性编译；u flag 供 \p{...} 使用，无 g flag） */
const PATTERNS = GROUPS.map(({ type, words }) => ({
  type,
  re: new RegExp(`${LEAD}(?:${words.join('|')})${SEP}`, 'iu'),
}));

/**
 * 匹配强意图前缀。
 * @param {unknown} text
 * @returns {{ type:'bug'|'feature'|'question', body:string } | null}
 *   body = 剥掉前缀与分隔符后的正文（只发前缀时为空串，调用方据此追问）
 */
export function matchStrongIntent(text) {
  const t = typeof text === 'string' ? text : '';
  if (!t.trim()) return null;
  for (const { type, re } of PATTERNS) {
    const m = re.exec(t);
    // 必须从开头命中（LEAD 已锚 ^，此处再确认 index===0 以防意外）
    if (m && m.index === 0 && m[0].trim()) {
      return { type, body: t.slice(m[0].length).trim() };
    }
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/app/intent-keywords.test.js`
Expected: PASS（9 个 test 全绿）

若「关键词出现在长文中间」用例失败，检查 `LEAD` 是否把中文字符也算进了噪声类——`\p{P}\p{S}` 不含汉字，正常不会。

---

## Task 2：文案注册表改造（即时应答 / 引导兜底）

**Files:**
- Modify: `src/shared/messages.js`
- Modify: `src/shared/messages.test.js`（**已存在**，9 个用例，多处以 `feedbackAck` 作可配 key 样例）
- Modify: `src/store/bots-migration.test.js` / `src/store/settings.test.js`（若它们把 `feedbackAck` 当可配 key 样例而挂）

**注意（实施时发现的事实）：** `src/shared/messages.test.js` 不是新文件，已有以下需要跟着改的用例：
- `sanitizeMessages：只收机器人可配 key…` 里用 `feedbackAck` 当样例 → 换成 `ackBug`
- `sanitizeMessages：单条超长报错并指明条目` 断言 `/需求\/故障收集确认/` → 换成新 label `/需求即时应答/`（对应 `ackFeature`）
- `listBotMessages：仅两条可配文案…` 名称与断言 → 改为四条（`ackBug/ackFeature/ackQuestion/execProcessing`），`feedbackAck` 样例换成 `ackQuestion`
- `bots-migration.js` 用 `BOT_MESSAGE_KEYS` 做迁移白名单 → `src/store/bots-migration.test.js` 里若把 `feedbackAck` 当「保留的可配 key」断言，同步换成 `ackBug`；`src/store/settings.test.js` 同理。

- [ ] **Step 1: 改测试（先失败）**

把 `src/shared/messages.test.js` 里引用 `feedbackAck` 的三处按上面说明改掉，并追加以下用例：

```js
test('三条即时应答已注册且默认文案与产品口径一致', () => {
  assert.equal(REGISTRY.ackBug.defaultText, '请稍等，我先思考此故障是否由我的项目引发！');
  assert.equal(REGISTRY.ackFeature.defaultText, '请稍等，我先思考此需求的复杂度与收益是否值得做！');
  assert.equal(REGISTRY.ackQuestion.defaultText, '请稍等，我先去翻阅代码再回来回答你的问题！');
});

test('三条即时应答可 per-bot 配置（出现在 BOT_MESSAGE_KEYS）', () => {
  for (const k of ['ackBug', 'ackFeature', 'ackQuestion']) {
    assert.ok(BOT_MESSAGE_KEYS.includes(k), `${k} 应可配置`);
  }
});

test('feedbackAck 已下线（被即时应答取代）', () => {
  assert.equal(REGISTRY.feedbackAck, undefined);
  assert.equal(BOT_MESSAGE_KEYS.includes('feedbackAck'), false);
});

test('welcome 变为未识别意图引导文案，含三种示例说法', () => {
  const w = REGISTRY.welcome.defaultText;
  assert.match(w, /没有识别到你的意图/);
  assert.match(w, /提交需求/);
  assert.match(w, /提交故障/);
  assert.match(w, /问个问题/);
});

test('sanitizeMessages：丢弃已下线的 feedbackAck，保留新 key', () => {
  const r = sanitizeMessages({ ackBug: ' 稍等 ', feedbackAck: '旧文案' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, { ackBug: '稍等' });
});
```

（`resolveMessage` 的覆盖值/未知 key 用例文件里已有，不要重复添加。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/shared/messages.test.js`
Expected: FAIL —— `REGISTRY.ackBug` 为 undefined（读 `.defaultText` 抛 TypeError）

- [ ] **Step 3: 改 `src/shared/messages.js`**

把 `BOT_MESSAGE_KEYS` 与 `REGISTRY` 两处替换为：

```js
/** 机器人可配文案 key（per-bot）；welcome/materialAck/execNewChat 不可配，恒用默认 */
export const BOT_MESSAGE_KEYS = ['ackBug', 'ackFeature', 'ackQuestion', 'execProcessing'];

export const REGISTRY = {
  welcome: {
    label: '未识别意图兜底提示',
    defaultText:
      '没有识别到你的意图，你可以跟我说：\n' +
      '· 提交需求：XXXX\n' +
      '· 提交故障：XXXX\n' +
      '· 问个问题：XXXX\n' +
      '或其他已配置的功能。识别到我会及时回复你～',
  },
  // 三条即时应答：意图确定后的第一条回复（取代原「已收集」确认文案）
  ackBug: {
    label: '故障即时应答',
    defaultText: '请稍等，我先思考此故障是否由我的项目引发！',
  },
  ackFeature: {
    label: '需求即时应答',
    defaultText: '请稍等，我先思考此需求的复杂度与收益是否值得做！',
  },
  ackQuestion: {
    label: '问询即时应答',
    defaultText: '请稍等，我先去翻阅代码再回来回答你的问题！',
  },
  materialAck: {
    label: '材料收讫提示',
    defaultText: '📎 已收到材料～请描述对应的需求或问题，我会把材料一并带上（10 分钟内有效）。',
  },
  execNewChat: { label: '新对话确认（owner）', defaultText: '🆕 已开始新对话' },
  execProcessing: { label: '处理中提示（owner）', defaultText: '🤔 处理中…' },
};
```

同时把文件头注释的第三行改为：
`* 可配 key 限 BOT_MESSAGE_KEYS（机器人编辑表单渲染）；welcome/materialAck/execNewChat 恒用默认文案。`

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/shared/messages.test.js`
Expected: PASS

- [ ] **Step 5: 确认没有残留的 feedbackAck 调用点**

Run: `grep -rn "feedbackAck" src/ public/`
Expected: 只剩 `src/plugins/team-tools/feedback/index.js` 里的两处（Task 4 会一并删掉）；`public/` 无命中。
若 `public/js/bots-panel.js` 里有硬编码 `feedbackAck`，说明表单没走 `listBotMessages`，一并改为动态渲染。

---

## Task 3：分类超时可配 + intent.js 重写编排

**Files:**
- Modify: `src/features/llm-classify.js`
- Modify: `src/app/intent.js`
- Test: `src/app/intent.test.js`（改写）

- [ ] **Step 1: 给 `runClassifierOnce` 加 `timeoutMs`**

改 `src/features/llm-classify.js`：

`export const CLASSIFY_TIMEOUT_MS = 30_000;` 保留（task-triage 仍用默认），函数签名与超时用法改为：

```js
export async function runClassifierOnce({ prompt, systemPrompt, model, logTag, timeoutMs }) {
  // 额度耗尽 fail-fast：曾发生五小时限流窗口内 SDK 流永不结束 → 不发起注定失败 / 会 stall 的分类调用
  if (isPoolExhausted(getTokens())) {
    logger.warn('llm-classify', 'token 池全部耗尽，跳过分类（fail-fast）', { logTag });
    return null;
  }
  // 意图分类点传 10s（用户在等第一条回复）；其余调用点不传，沿用 30s
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : CLASSIFY_TIMEOUT_MS;
  let out = '';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budget);
```

并把函数体末尾的 race 兜底改为用 `budget`：

```js
    await Promise.race([call, new Promise((resolve) => setTimeout(resolve, budget + 2_000))]);
```

JSDoc 增加一行：
`* @param {number} [opts.timeoutMs] 超时预算（默认 CLASSIFY_TIMEOUT_MS=30s；意图分类点传 10s）`

- [ ] **Step 2: 写 intent 新测试（先失败）**

把 `src/app/intent.test.js` 整体替换为：

```js
/**
 * intent 单测：
 * - isChitchat：寒暄本地快路（免 LLM），保守匹配，宁可漏判不可误判真实请求。
 * - classify：L0 寒暄 / L1 强前缀 的零 LLM 短路（L2 动作、L3 Haiku 需读盘与网络，不在单测覆盖）。
 * - isPoolExhausted：备用 token 池健康度（定义在 token-rotation，此处就近测试池语义）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChitchat, classify, INTENT_CLASSIFY_TIMEOUT_MS } from './intent.js';
import { isPoolExhausted } from '../features/token-rotation.js';

test('isChitchat：常见问候/寒暄/纯表情标点 → true（走免 LLM 快路）', () => {
  for (const t of ['你好', '您好', 'hi', 'Hello', '在吗', '谢谢', '好的', 'ok', '收到', '你好呀', '👍', '   ', '。。。']) {
    assert.equal(isChitchat(t), true, `期望 "${t}" 判为寒暄`);
  }
});

test('isChitchat：真实请求 / 含动作内容 → false（必须落到正常分类）', () => {
  for (const t of ['帮我清理test环境数据', '体验版二维码', '你好，帮我清理test环境', '这里有个bug', '正式版二维码']) {
    assert.equal(isChitchat(t), false, `期望 "${t}" 不判为寒暄`);
  }
});

test('classify：寒暄 → other，零 LLM（L0 短路）', async () => {
  assert.deepEqual(await classify('你好'), { intent: 'other', body: '', env: null, keyword: null });
});

test('classify：强前缀 → 直接出意图并带 body，零 LLM（L1 短路）', async () => {
  assert.deepEqual(await classify('提交需求：加导出功能'), {
    intent: 'feature', body: '加导出功能', env: null, keyword: null,
  });
  assert.deepEqual(await classify('提交故障：扫码白屏'), {
    intent: 'bug', body: '扫码白屏', env: null, keyword: null,
  });
  assert.deepEqual(await classify('问个问题 订单怎么流转'), {
    intent: 'question', body: '订单怎么流转', env: null, keyword: null,
  });
});

test('classify：强前缀无正文 → 仍出意图，body 为空串（调用方追问）', async () => {
  assert.deepEqual(await classify('提交需求'), {
    intent: 'feature', body: '', env: null, keyword: null,
  });
});

test('意图分类超时预算为 10s（用户在等第一条回复）', () => {
  assert.equal(INTENT_CLASSIFY_TIMEOUT_MS, 10_000);
});

test('isPoolExhausted：空池 → false（未配置池，用主账号，不 fail-fast）', () => {
  assert.equal(isPoolExhausted([]), false);
});

test('isPoolExhausted：存在 healthy / warning → false（仍可用）', () => {
  assert.equal(isPoolExhausted([{ status: 'exhausted' }, { status: 'healthy' }]), false);
  assert.equal(isPoolExhausted([{ status: 'warning' }]), false);
});

test('isPoolExhausted：全部 exhausted → true（应 fail-fast，跳过注定失败的分类调用）', () => {
  assert.equal(isPoolExhausted([{ status: 'exhausted' }, { status: 'exhausted' }]), true);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test src/app/intent.test.js`
Expected: FAIL —— `INTENT_CLASSIFY_TIMEOUT_MS` 未导出 / `classify` 返回值不含 `body`

- [ ] **Step 4: 重写 `src/app/intent.js`**

整体替换为：

```js
/**
 * 意图识别 —— 收缩为四类显式意图，逐层短路，绝不瞎归类：
 *   L0 寒暄快路 → L1 强意图前缀（零成本）→ L2 动作关键词单命中（零成本）
 *   → L3 一次 Haiku 合并分类（bug/feature/question/material/action，10s 超时）→ L4 other（引导文案兜底）
 *
 * 收缩原因（真实事故，勿放宽）：
 * - 旧版宽泛关键词（希望/建议/优化/无法/不能用…）几乎人人命中，随口一说被立案成需求/故障。
 * - 旧版未命中要串两次 LLM（feedback 四分类 30s + action 消歧 30s），用户等一分钟见不到回复。
 * L3 失败/超时一律落 other（不再退回全文关键词兜底——那正是误判来源），让用户按引导重说一次。
 *
 * 新增动作意图无需改此文件，走 action-configs 配置即可。
 */
import { matchStrongIntent } from './intent-keywords.js';
import { runClassifierOnce } from '../features/llm-classify.js';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

/** 意图分类超时预算：用户正在等第一条回复，10s 到点就落引导文案（其余分类点仍用 30s） */
export const INTENT_CLASSIFY_TIMEOUT_MS = 10_000;

/** LLM 分类输入的正文上限（长文只取首段判意图，够用且省 token） */
const CLASSIFY_TEXT_MAX = 500;

/** LLM 消歧的动作候选上限 */
const ACTION_POOL_MAX = 20;

export function extractEnv(text) {
  const t = text.toLowerCase();
  if (/\btest\b|测试环境|test\s*环境/.test(t)) return 'test';
  if (/\bdev\b|开发环境|dev\s*环境/.test(t)) return 'dev';
  return null;
}

// —— 寒暄 / 闲聊本地快路：整条消息仅由「问候词 + 标点 / 表情 / 语气助词」组成时判为闲聊，
//    直接落 other（免一次分类模型调用）。保守匹配：宁可漏判（退化为走分类），绝不误吞真实请求。
const CHITCHAT_RE =
  /^(?:[\s\p{P}\p{S}呀啊哦喔嗯呢啦哈嘿哟额诶~]|你好|您好|哈喽|哈啰|嗨|hi|hello|hey|在吗|在不在|在么|在|早上好|中午好|下午好|晚上好|早安|晚安|早|谢谢|多谢|谢啦|感谢|thanks|thank\s*you|thx|辛苦了|辛苦啦|辛苦|收到|好的|好嘞|okay|ok|明白了|明白|了解|再见|拜拜|byebye|bye)+$/iu;

export function isChitchat(text) {
  const t = String(text ?? '').trim();
  if (!t) return true; // 空 / 纯空白
  return CHITCHAT_RE.test(t);
}

/** 统一返回形状（env/keyword 保留字段，dispatch 日志与旧调用方仍读） */
function result(intent, extra = {}) {
  return { intent, body: '', env: null, keyword: null, ...extra };
}

/** 当前启用机器人的可用动作（动作 per-bot 独享；无启用机器人 → 空） */
async function enabledActions() {
  const { getConfigs } = await import('../store/action-configs.js');
  const { getActiveBot } = await import('../store/settings.js');
  const activeBot = getActiveBot();
  if (!activeBot) return [];
  return getConfigs().filter((c) => c.enabled !== false && c.botId === activeBot.id);
}

/**
 * L3：一次 Haiku 合并分类（原 feedback 四分类 + action 消歧两次调用合并为一次）。
 * @returns {{ type:string, actionId?:string } | null} null = 超时/失败/解析不出
 */
async function quickClassify(text, { hasMaterials, actions }) {
  const list = actions.map((c, i) => `${i + 1}. id=${c.id}  ${c.name} — ${c.description}`).join('\n');
  const prompt =
    `你是团队消息分类器，仅输出一行 JSON，不要任何解释。\n` +
    `判断这条消息属于哪类：\n` +
    `- bug：报告软件故障/异常，期望修复\n` +
    `- feature：提出需求/改进，期望实现\n` +
    `- question：询问项目/功能/代码相关的问题，期望得到解答（不期望改动代码）\n` +
    `- material：仅提供参考材料（接口文档/设计稿/日志片段等），本身不构成独立诉求\n` +
    (list ? `- action：想执行下面某个已配置动作，此时必须给出 action_id\n\n可选动作：\n${list}\n\n` : '') +
    `- other：都不是（寒暄/闲聊/无关内容）\n` +
    (hasMaterials ? `（提示：该用户刚发过待归属的参考材料，这条消息很可能是对应的需求/故障描述）\n` : '') +
    `消息（截取首 ${CLASSIFY_TEXT_MAX} 字）：\n「${String(text ?? '').slice(0, CLASSIFY_TEXT_MAX)}」\n\n` +
    `严格输出：{"type":"bug|feature|question|material|action|other","action_id":null}`;

  const j = await runClassifierOnce({
    prompt,
    model: config.intent.classifyModel,
    logTag: 'intent/quick',
    timeoutMs: INTENT_CLASSIFY_TIMEOUT_MS,
  });
  if (!j) return null;
  if (j.type === 'action') {
    const found = actions.find((c) => c.id === j.action_id);
    return found ? { type: 'action', actionId: found.id, actionName: found.name } : { type: 'other' };
  }
  if (['bug', 'feature', 'question', 'material', 'other'].includes(j.type)) return { type: j.type };
  return null;
}

/**
 * 统一入口。
 * @param {string} text
 * @param {{ hasMaterials?: boolean }} [opts] 该用户当前会话是否有待归属材料（影响分类提示）
 * @returns {Promise<{intent:string, body:string, env:null, keyword:null, actionId?:string, actionName?:string}>}
 */
export async function classify(text, opts = {}) {
  const hasMaterials = !!opts.hasMaterials;

  // L0 寒暄：免 LLM（问候语不可能是显式诉求）
  if (isChitchat(text)) return result('other');

  // L1 强意图前缀：免 LLM，body 为剥掉前缀的正文
  const strong = matchStrongIntent(text);
  if (strong) {
    logger.info('intent', 'L1 强前缀命中', { type: strong.type });
    return result(strong.type, { body: strong.body });
  }

  // L2 动作关键词单命中：免 LLM
  const actions = await enabledActions();
  const hit = actions.filter((c) => (c.keywords || []).some((kw) => text.includes(kw)));
  if (hit.length === 1) {
    logger.info('intent', 'L2 动作关键词单命中', { actionId: hit[0].id });
    return result('action', { actionId: hit[0].id, actionName: hit[0].name });
  }

  // L3 一次 Haiku 合并分类；候选：多命中取子集，0 命中给全量（上限 20）
  const poolAll = hit.length > 1 ? hit : actions;
  if (poolAll.length > ACTION_POOL_MAX) {
    logger.warn('intent', 'action 候选超过 20 条，已截断', { total: poolAll.length });
  }
  const r = await quickClassify(text, { hasMaterials, actions: poolAll.slice(0, ACTION_POOL_MAX) });
  if (r && r.type !== 'other') {
    logger.info('intent', 'L3 语义分类命中', { type: r.type, actionId: r.actionId ?? null });
    return result(r.type, r.actionId ? { actionId: r.actionId, actionName: r.actionName } : {});
  }

  // L4 兜底：不猜，交给 dispatch 回引导文案
  return result('other');
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test src/app/intent.test.js`
Expected: PASS

- [ ] **Step 6: 确认没有调用方还在用被删除的导出**

Run: `grep -rn "feedbackRoute\|FAST_PATH_MAX_LEN\|classifyAction" src/app src/features src/plugins src/entrypoints`
Expected: 只剩 `src/plugins/team-tools/task-triage/index.js` 里自己的私有 `classifyAction`（同名但无关，不要动）。
若还有对 `intent.js` 的 `classifyAction` import，删掉——功能已并入 `classify`。

- [ ] **Step 7: 跑全量测试**

Run: `npm test`
Expected: 全绿（`intent.test.js` / `intent-keywords.test.js` / `messages.test.js` 都在内）

---

## Task 4：feedback 即时应答 + 空正文保护 + 轻度托管闭环

**Files:**
- Modify: `src/plugins/team-tools/feedback/index.js`

无新单测（该文件全是 I/O 编排，项目现状也未对其单测）；靠 Task 9 的人工走查验证。

- [ ] **Step 1: 加空正文追问的纯函数与文案**

在 `src/plugins/team-tools/feedback/index.js` 的常量区（`NO_RE` 之后）加：

```js
/** 强前缀命中但没带正文时的追问语（如用户只发了「提交需求」） */
const ASK_BODY = {
  bug: '好的，请把故障内容发我～ 例如「提交故障：扫码页白屏，安卓 13 必现」。',
  feature: '好的，请把需求内容发我～ 例如「提交需求：登录页加记住密码」。',
};
```

- [ ] **Step 2: 在 `handle` 的「B. 正常收集」段前插入即时应答与空正文保护**

把 `handle` 里 `// B. 正常收集` 那一段（从 `const type = ...` 到 `const task = createTask({...})`）替换为：

```js
    // B. 正常收集
    const type = intentResult?.intent === 'bug' ? 'bug' : 'feature';
    const tag = type === 'bug' ? '[故障]' : '[需求]';

    // 强前缀命中但没带正文（只发了「提交需求」）→ 追问，不建任务、不起 Claude。
    // 判据：L1 强前缀命中才有 body 字段且为空串；L3 语义分类的 body 恒为空串但原文非空，
    // 故必须同时看「原文去掉前缀后是否还有内容」→ 用 matchStrongIntent 的结果，即 intentResult.body。
    const body = (intentResult?.body ?? '').trim();
    const prefixOnly = !body && !!matchStrongIntent(ctx.text);
    if (prefixOnly) {
      logger.info('feedback', '强前缀无正文 → 追问内容', { type, openId: ctx.user.id });
      return ctx.reply(ASK_BODY[type]);
    }

    // 即时应答：意图确定后的第一条回复（取代原「已收集」文案，让用户第一秒就有反馈）
    await ctx.reply(msg(type === 'bug' ? 'ackBug' : 'ackFeature'));

    const task = createTask({
      type,
      // title 用剥掉「提交需求：」前缀的正文（更干净）；detail 保留原文全文（不丢上下文）
      title: (body || ctx.text || '').slice(0, 40),
      detail: ctx.text || '',
      source: {
        openId: ctx.user.id,
        via: ctx.source,
        chatId: ctx.meta?.chatId || ctx.sessionKey,
        chatType: ctx.meta?.chatType || null, // 群聊异步通知要据此决定是否 @ 提交人
      },
    });
```

同时在该文件的 import 区加上：

```js
import { matchStrongIntent } from '../../../app/intent-keywords.js';
```

（feedback 是插件层、intent-keywords 是 app 层纯函数，方向向下依赖，符合本项目分层。）

- [ ] **Step 3: 去掉两处「已收集」回复，轻度托管改为分析后闭环**

把 `handle` 末尾的托管分支（从 `const autonomy = getActiveBot()...` 到方法结束）替换为：

```js
    const autonomy = getActiveBot()?.autonomy || 'light';
    const matsNote = mats.length ? `（已带上材料 ${mats.length} 份）` : '';
    if (autonomy === 'light') {
      // 轻度托管：即时应答已发，这里不再重复确认；分析完成后补一句闭环回复（否则用户等不到任何后续）
      analyze(withMats)
        .then(() => ctx.reply(`📋「${withMats.title}」已记录并初步分析完成，等管理员确认后处理。${matsNote}`))
        .catch((e) => logger.error('feedback', '分析失败', { id: withMats.id, err: e?.message || String(e) }));
      return;
    }
    // 中度/完全托管：即时应答已发，评审结论由 runReviewFlow 回复
    runReviewFlow(withMats.id, ctx).catch((e) =>
      logger.error('feedback', '评审流失败', { id: withMats.id, err: e?.message || String(e) }),
    );
```

- [ ] **Step 4: 确认 material 分支与 challenged 分支未被波及**

Run: `grep -n "ackBug\|ackFeature\|feedbackAck\|materialAck" src/plugins/team-tools/feedback/index.js`
Expected：`ackBug`/`ackFeature` 各 1 处（在 B 段）、`materialAck` 1 处（A2 材料分支）、`feedbackAck` **0 处**。
即时应答绝不能出现在 A（challenged 应答）与 A2（材料）分支。

- [ ] **Step 5: 语法自检 + 全量测试**

Run: `node --check src/plugins/team-tools/feedback/index.js && npm test`
Expected: 无输出（语法 OK）+ 测试全绿

---

## Task 5：project-qa 改为显式问询（含串行闸与超时）

**Files:**
- Modify: `src/plugins/team-tools/project-qa/index.js`

- [ ] **Step 1: 整体替换 `src/plugins/team-tools/project-qa/index.js`**

```js
/**
 * feature: 项目问答（显式问询意图）。
 *
 * 变更历史（重要，勿回退）：原先挂 intents:['other'] 作完全托管兜底 —— 任何未命中消息都会触发
 * 一次「读代码查证再回答」，冷启动 + 工具探索动辄几十秒，闲聊也走这条路，是「放开对话限制后
 * 响应变慢」的直接原因。现改为只接显式问询意图（intent=question），且不再看托管档位：
 * 用户明确问了，就该查代码回答。未识别的消息由 dispatch 回引导文案。
 *
 * 三道保护：同用户串行闸（防连问打爆额度）、3 分钟超时（SDK 流在限流时可能永不结束）、答案截断（飞书 2000 字上限）。
 */
import { runClaude } from '../../../integrations/claude.js';
import { claudeAuthOpts } from '../../../features/token-rotation.js';
import { getActiveBot } from '../../../store/settings.js';
import { botSystemAppend } from '../../../shared/bot-scope.js';
import { msg } from '../../../shared/messages.js';
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';

/** 读码问答超时：到点 abort 并回提示，绝不让用户无限等 */
const QA_TIMEOUT_MS = 180_000;
/** 答案长度上限（飞书单条文本 2000 字，留余量给截断提示） */
const ANSWER_MAX = 1800;

/** 同一用户串行闸：正在查的 openId 集合（纯内存，进程级） */
const running = new Set();

export default {
  name: 'project-qa',
  permission: 'any',
  intents: ['question'],
  handle: async (ctx) => {
    const question = (ctx.body || '').trim() || (ctx.text || '').trim();
    if (!question) return ctx.reply('好的，你想问什么？直接说「问个问题 XXXX」就行～');

    const bot = getActiveBot();
    const cwd = bot?.projectDir || config.feedback.frontendDir;
    if (!cwd) return ctx.reply('我还没被配置项目目录，暂时答不了这个问题～');

    // 串行闸：一个用户同时只查一个问题（连问会各起一个 Claude 进程，额度与机器都吃不住）
    if (running.has(ctx.user.id)) {
      return ctx.reply('我还在查上一个问题，稍等一下～');
    }
    running.add(ctx.user.id);

    // 即时应答：先让用户知道我去翻代码了
    await ctx.reply(msg('ackQuestion'));

    const append = botSystemAppend(bot);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), QA_TIMEOUT_MS);
    let out = '';
    let timedOut = false;
    try {
      const call = runClaude(
        `团队成员提问：「${question}」\n\n` +
          `请基于当前工程代码实际查证后回答（只读，不修改任何文件）。\n` +
          `回答面向提问者：简洁清晰、说结论和依据，不超过 500 字；工程中查证不到的内容直说不知道，不要编造。`,
        {
          ...claudeAuthOpts(), // 跟随备用账号轮换
          cwd,
          permissionMode: 'default',
          allowedTools: ['Read', 'Grep', 'Glob'], // 只读，物理上无法改码
          persistSession: false, // 单轮问答不落盘 session
          abortController: abort,
          ...(append ? { systemPrompt: { type: 'preset', preset: 'claude_code', append } } : {}),
          onText: (t) => (out += t),
          onResult: (i) => {
            if (i.result) out = i.result;
          },
        },
      );
      // abort 后 SDK 流可能迟迟不结束（限流实测拖十分钟+）→ race 兜底，绝不被拖死
      call.catch((e) => logger.warn('project-qa', '问答调用异常（已落兜底）', { err: e?.message || String(e) }));
      const raced = await Promise.race([
        call.then(() => 'done'),
        new Promise((r) => setTimeout(() => r('timeout'), QA_TIMEOUT_MS + 2_000)),
      ]);
      timedOut = raced === 'timeout';
    } catch (e) {
      logger.error('project-qa', '问答失败', { err: e?.message || String(e) });
      return ctx.reply('查询出错了，请稍后再试～');
    } finally {
      clearTimeout(timer);
      running.delete(ctx.user.id); // 异常路径也必须解闸，否则该用户永久卡住
    }

    if (timedOut && !out) {
      logger.warn('project-qa', '问答超时', { openId: ctx.user.id });
      return ctx.reply('这个问题我查得有点久，稍后再试或换个问法～');
    }
    const answer = out.length > ANSWER_MAX ? out.slice(0, ANSWER_MAX) + '\n…（内容过长已截断）' : out;
    return ctx.reply(answer || '没有查到相关内容～');
  },
};
```

- [ ] **Step 2: 把 `body` 透传进 ctx（问询正文要剥掉「问个问题」前缀）**

改 `src/app/dispatch.js` 的意图匹配段，把分类结果的 `body` 挂到 ctx 上（feature 侧读 `ctx.body`）：

```js
    // 2. 意图识别 → 按 权限 + intents 匹配（hasMaterials 由入口层写入 ctx.meta，影响分类分层）
    const intent = await classify(ctx.text, { hasMaterials: !!ctx.meta?.hasMaterials });
    logger.info('dispatch', '意图识别', { intent: intent.intent, env: intent.env ?? null });
    ctx.body = intent.body || ''; // 强前缀命中时的正文（已剥掉「提交需求：」这类前缀）
    for (const f of features) {
```

- [ ] **Step 3: 更新 team-tools 装配注释（order 语义变了）**

改 `src/plugins/team-tools/index.js` 文件头注释最后一行：

```js
 * project-qa(90) 只接显式问询意图（intent=question）；未识别消息由 dispatch 回引导文案，不再走读码问答。
```

`features` 数组本身不动（order 90 保持）。

- [ ] **Step 4: 语法自检 + 全量测试**

Run: `node --check src/plugins/team-tools/project-qa/index.js && node --check src/app/dispatch.js && npm test`
Expected: 无输出 + 测试全绿

- [ ] **Step 5: 确认 welcome 兜底链路唯一**

Run: `grep -rn "msg('welcome')" src/`
Expected: 只有 `src/app/dispatch.js` 一处（project-qa 里的 autonomy 分支已删）。

---

## Task 6：@ 前缀纯函数 + 报文 mentions 解析

**Files:**
- Create: `src/shared/mention.js`
- Create: `src/shared/mention.test.js`
- Modify: `src/channels/feishu-normalize.js`
- Modify: `src/channels/feishu-normalize.test.js`

- [ ] **Step 1: 写 mention 纯函数的失败测试**

创建 `src/shared/mention.test.js`：

```js
/**
 * 群聊 @ 前缀纯函数单测 —— 只有群聊才 @，p2p 加 <at> 会渲染成怪东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atPrefix } from './mention.js';

test('群聊 → 输出飞书 at 标签前缀（含尾随空格）', () => {
  assert.equal(atPrefix('ou_abc', 'group'), '<at user_id="ou_abc"></at> ');
});

test('p2p → 空串（单聊不需要 @）', () => {
  assert.equal(atPrefix('ou_abc', 'p2p'), '');
});

test('chatType 缺失（老任务无该字段）→ 空串，安全降级', () => {
  assert.equal(atPrefix('ou_abc', null), '');
  assert.equal(atPrefix('ou_abc', undefined), '');
});

test('openId 缺失 → 空串（绝不输出半截标签）', () => {
  assert.equal(atPrefix('', 'group'), '');
  assert.equal(atPrefix(null, 'group'), '');
});

test('openId 含引号等异常字符 → 空串（防标签注入）', () => {
  assert.equal(atPrefix('ou_a"b', 'group'), '');
  assert.equal(atPrefix('ou_a<b>', 'group'), '');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/shared/mention.test.js`
Expected: FAIL —— 找不到 `./mention.js`

- [ ] **Step 3: 实现 `src/shared/mention.js`**

```js
/**
 * 群聊 @ 前缀（纯函数）—— 飞书文本消息里 @ 某人的唯一出口。
 * 只在群聊生效：p2p 里 <at> 标签会渲染成奇怪的一串，反而干扰阅读。
 * openId 做白名单校验（飞书 open_id 形如 ou_xxx，只含字母数字下划线），防把用户内容拼进标签属性。
 */
const OPEN_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @param {string} openId   被 @ 的人（消息发送者 / 任务提交人）
 * @param {string} chatType 'group' | 'p2p' | null
 * @returns {string} 群聊返回 `<at user_id="xxx"></at> `，否则空串
 */
export function atPrefix(openId, chatType) {
  if (chatType !== 'group') return '';
  const id = typeof openId === 'string' ? openId : '';
  if (!id || !OPEN_ID_RE.test(id)) return '';
  return `<at user_id="${id}"></at> `;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/shared/mention.test.js`
Expected: PASS

- [ ] **Step 5: 给 feishu-normalize 写 mentions 解析的失败测试**

在 `src/channels/feishu-normalize.test.js` 末尾追加：

```js
import { parseMentions, stripMentions } from './feishu-normalize.js';

test('parseMentions：抽出 key/openId/name', () => {
  const message = {
    mentions: [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '开发助手' },
      { key: '@_user_2', id: { open_id: 'ou_me' }, name: '张三' },
    ],
  };
  assert.deepEqual(parseMentions(message), [
    { key: '@_user_1', openId: 'ou_bot', name: '开发助手' },
    { key: '@_user_2', openId: 'ou_me', name: '张三' },
  ]);
});

test('parseMentions：无 mentions / 字段缺失 → 空数组（不抛错）', () => {
  assert.deepEqual(parseMentions({}), []);
  assert.deepEqual(parseMentions(null), []);
  assert.deepEqual(parseMentions({ mentions: [{}] }), []);
});

test('stripMentions：剥掉 @_user_N 占位符，压缩空白', () => {
  const mentions = [{ key: '@_user_1', openId: 'ou_bot', name: '开发助手' }];
  assert.equal(stripMentions('@_user_1 提交需求：加导出', mentions), '提交需求：加导出');
  assert.equal(stripMentions('提交需求：加导出 @_user_1', mentions), '提交需求：加导出');
  assert.equal(stripMentions('帮我 @_user_1  看看', mentions), '帮我 看看');
});

test('stripMentions：占位符是纯 @ 消息 → 空串（调用方据此丢弃）', () => {
  const mentions = [{ key: '@_user_1', openId: 'ou_bot', name: '开发助手' }];
  assert.equal(stripMentions('@_user_1', mentions), '');
  assert.equal(stripMentions('  @_user_1  ', mentions), '');
});

test('stripMentions：多个占位符（@_user_10 不会被 @_user_1 吃掉前缀）', () => {
  const mentions = [
    { key: '@_user_1', openId: 'ou_a', name: 'A' },
    { key: '@_user_10', openId: 'ou_b', name: 'B' },
  ];
  assert.equal(stripMentions('@_user_10 @_user_1 提需求', mentions), '提需求');
});

test('stripMentions：无 mentions → 原文 trim（不动内容）', () => {
  assert.equal(stripMentions(' 提交需求：加导出 ', []), '提交需求：加导出');
  assert.equal(stripMentions('a @b c', undefined), 'a @b c');
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `node --test src/channels/feishu-normalize.test.js`
Expected: FAIL —— `parseMentions is not a function`

- [ ] **Step 7: 实现两个纯函数**

在 `src/channels/feishu-normalize.js` 末尾追加：

```js
/**
 * mentions 报文 → [{ key, openId, name }]。
 * 飞书群聊里被 @ 的人以 mentions 数组给出，正文里对应位置是 `@_user_N` 占位符。
 */
export function parseMentions(message) {
  const arr = message?.mentions;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((m) => ({ key: m?.key || '', openId: m?.id?.open_id || '', name: m?.name || '' }))
    .filter((m) => m.key && m.openId);
}

/**
 * 剥掉正文里的 `@_user_N` 占位符并压缩空白。
 * 不做这一步的话，「@_user_1 提交需求：xxx」会带着占位符进意图识别与任务 title（历史污染源）。
 * 按 key 长度降序替换：避免 `@_user_1` 先把 `@_user_10` 的前缀吃掉。
 */
export function stripMentions(text, mentions) {
  let t = String(text ?? '');
  const keys = (Array.isArray(mentions) ? mentions : [])
    .map((m) => m?.key)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const key of keys) {
    // key 形如 @_user_1，只含固定字符集，无需转义；不加 g flag 会漏掉重复 @，故用 split/join 替代
    t = t.split(key).join(' ');
  }
  return t.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `node --test src/channels/feishu-normalize.test.js`
Expected: PASS（原有用例也全绿）

- [ ] **Step 9: 全量测试**

Run: `npm test`
Expected: 全绿

---

## Task 7：渠道接线 —— 群聊只响应 @ 我，回复 @ 对方

**Files:**
- Modify: `src/integrations/lark.js`
- Modify: `src/channels/feishu.js`
- Modify: `src/entrypoints/feishu/index.js`

无单测（全是 SDK / 网络编排）；靠 Task 10 走查第 6 条验证。

- [ ] **Step 1: `lark.js` 增加机器人自身 open_id 查询（带缓存）**

在 `src/integrations/lark.js` 的 `resetApiClient` 之后插入：

```js
let _botOpenId = null; // 机器人自身 open_id 缓存（判断群聊是否 @ 了我）

/**
 * 机器人自身 open_id（GET /open-apis/bot/v3/info）。
 * 模块级缓存；取不到返回 null —— 调用方据此降级为「不过滤群消息」，绝不因为查不到 id 就失声。
 */
export async function getBotOpenId() {
  if (_botOpenId) return _botOpenId;
  try {
    const r = await getClient().request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    // SDK generic request 不校验业务 code：HTTP 200 + code!=0 也是失败
    if (r?.code) throw new Error(`bot/v3/info 失败: ${r.msg || r.code}`);
    const id = r?.bot?.open_id || r?.data?.bot?.open_id || null;
    if (id) {
      _botOpenId = id;
      logger.info('lark', '机器人 open_id 已缓存', { openId: id });
    }
    return _botOpenId;
  } catch (e) {
    logger.warn('lark', '获取机器人 open_id 失败（群聊将不做 @ 过滤）', { err: e?.message || String(e) });
    return null;
  }
}
```

并在 `resetApiClient` 里换号时清缓存（函数体末尾加一行）：

```js
export function resetApiClient(creds) {
  const c = creds || getLarkCredentials();
  _client = new Lark.Client({ appId: c.appId, appSecret: c.appSecret });
  _botOpenId = null; // 换号即失效，绝不拿旧机器人的 id 判 @
}
```

- [ ] **Step 2: `channels/feishu.js` 的 `toInbound` 带出 chatType / mentions，并清洗正文**

先在 import 区补两个纯函数：

```js
import {
  parseTextContent,
  parseImageContent,
  parsePostContent,
  parseFileContent,
  parseMentions,
  stripMentions,
} from './feishu-normalize.js';
```

`toInbound` 里 `base` 与 text/post 分支改为：

```js
    const mentions = parseMentions(data?.message);
    const base = {
      channelId: 'feishu',
      chatKey: chatId,
      messageId,
      userId: openId,
      // 群聊策略与 @ 回复要用：'p2p' | 'group'
      chatType: data?.message?.chat_type || null,
      mentions,
      raw: data,
    };
```

```js
    if (msgType === 'text') {
      // 剥掉 @_user_N 占位符：否则占位符会进意图识别与任务 title（历史污染源）
      const text = stripMentions(parseTextContent(data.message.content), mentions);
      return text ? { ...base, kind: 'text', text, images: [] } : null;
    }
    if (msgType === 'post') {
      // 富文本：抽取文字 + 下载内嵌图片，图片以本地路径附在文末（detail 随之带图，Claude 可 Read）
      const parsed = parsePostContent(data.message.content);
      let text = stripMentions(parsed.text, mentions);
      const images = [];
      for (const key of parsed.imageKeys) {
        const file = await downloadMessageResource(messageId, key, 'image');
        if (file) {
          images.push(file);
          text += `\n[附图] ${file}`;
        }
      }
      text = text.trim();
      return text ? { ...base, kind: 'text', text, images } : null;
    }
```

注意：纯 @ 消息（正文只剩空串）会返回 null，被静默忽略——正是想要的行为。

`capabilities` 增加一项，声明本渠道支持 @：

```js
    capabilities: { text: true, richText: true, image: true, reaction: true, mention: true },
```

- [ ] **Step 3: `entrypoints/feishu/index.js` 加群聊过滤与 @ 前缀**

import 区补：

```js
import { fetchDocRawContent, resolveWikiNode, getBotOpenId } from '../../integrations/lark.js';
import { atPrefix } from '../../shared/mention.js';
```

在 `onInbound` 函数体**最开头**（`// 单发图片` 注释之前）插入群聊过滤：

```js
  // 群聊策略：只处理 @ 了本机器人的消息（群里闲聊不该触发意图识别与读码问答）。
  // 取不到机器人 open_id（网络/权限问题）→ 不过滤，降级为原全响应行为，绝不因此失声。
  if (m.chatType === 'group') {
    const botOpenId = await getBotOpenId();
    if (botOpenId && !(m.mentions || []).some((x) => x.openId === botOpenId)) {
      logger.info('feishu', '群聊消息未 @ 机器人，忽略', { chatId: m.chatKey, userId: m.userId });
      return;
    }
  }
```

把 `ctx` 组装段改为（reply 带 @ 前缀、meta 带 chatType）：

```js
  const mention = atPrefix(m.userId, m.chatType); // 群聊回复 @ 提问人；p2p 为空串
  const ctx = {
    source: 'feishu',
    user: { id: m.userId, role: roleOf(m.userId) },
    text: m.text,
    sessionKey: m.chatKey,
    reply: (t) => channel.send(m.chatKey, { text: mention + String(t ?? '') }),
    meta: {
      messageId: m.messageId,
      chatId: m.chatKey,
      chatType: m.chatType, // feedback 落进 task.source，异步通知据此决定是否 @
      hasMaterials: hasMaterials(m.userId, m.chatKey),
    },
  };
```

- [ ] **Step 4: 图片/文件/不支持类型的提示也加 @（群聊里同样要认领）**

`onInbound` 里那些**直接** `channel.send(m.chatKey, { text: ... })` 的早返回分支（图片、文件、unsupported、云文档失败提示、materialAck），统一改为经一个局部函数发送。在群聊过滤之后、图片分支之前插入：

```js
  // 早返回分支（图片/文件/文档提示）也走同一个 @ 前缀出口
  const mentionEarly = atPrefix(m.userId, m.chatType);
  const say = (text) => channel.send(m.chatKey, { text: mentionEarly + String(text ?? '') });
```

然后把该函数内所有 `await channel.send(m.chatKey, { text: X });` 替换为 `await say(X);`
（共 9 处：图片停用提示、图片下载失败、截图已补充、materialAck、文件停用提示、文件下载失败、
不支持扩展名、文件已补充/materialAck、unsupported、云文档已补充、云文档失败提示、纯链接 materialAck——
以 `grep -c` 结果为准，全部替换，不要漏）。

`ctx.reply` 里的 `mention` 与这里的 `mentionEarly` 是同一个值，实现上可只保留一个变量：
把 `mentionEarly` 提到函数顶部命名为 `mention`，`ctx.reply` 直接复用。

Run 校验：`grep -c "channel.send(m.chatKey" src/entrypoints/feishu/index.js`
Expected: `1`（只剩 `say` 里那一处）

- [ ] **Step 5: 语法自检**

Run: `node --check src/entrypoints/feishu/index.js && node --check src/channels/feishu.js && node --check src/integrations/lark.js`
Expected: 无输出

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全绿

---

## Task 8：异步通知也 @ 提交人

**Files:**
- Modify: `src/plugins/team-tools/auto-dev/index.js`
- Modify: `src/plugins/team-tools/task-triage/index.js`

- [ ] **Step 1: auto-dev 的 `replySource` 加前缀**

`src/plugins/team-tools/auto-dev/index.js` import 区补：

```js
import { atPrefix } from '../../../shared/mention.js';
```

`replySource` 改为：

```js
/** 回复来源会话（仅飞书源且有 chatId）；群聊 @ 提交人；失败仅告警不阻塞 */
async function replySource(task, ok, qrUrl, failReason, branchInfo) {
  const chatId = task.source?.chatId;
  if (!chatId || task.source?.via !== 'feishu') return;
  const tag = task.type === 'bug' ? '[故障]' : '[需求]';
  // 老任务无 chatType → 前缀为空串，行为同现状（安全降级）
  const at = atPrefix(task.source?.openId, task.source?.chatType);
  try {
    if (ok) {
      await sendText(
        chatId,
        `${at}✅ ${tag}「${task.title}」已自动完成（分支 ${branchInfo?.branch}），等待管理员确认合并到 ${branchInfo?.baseBranch}。`,
      );
      if (qrUrl) await sendImageByUrl(chatId, qrUrl);
    } else {
      await sendText(chatId, `${at}❌ ${tag}「${task.title}」自动处理失败${failReason ? '：' + failReason : ''}，已转人工处理。`);
    }
  } catch (e) {
    logger.warn('auto-dev', '回复来源会话失败', { id: task.id, err: e?.message || String(e) });
  }
}
```

- [ ] **Step 2: task-triage 的开发结果通知加前缀**

`src/plugins/team-tools/task-triage/index.js` import 区补 `atPrefix`（路径同上），
`pumpQueue` 里两处 `sendText(job.chatId, ...)` 与 catch 里那一处，前缀改为 `atPrefix(task?.source?.openId, task?.source?.chatType)`：

```js
    const at = atPrefix(task?.source?.openId, task?.source?.chatType);
    const r = await develop(task);
    if (r?.ok) {
      await sendText(job.chatId, `${at}✅ 已完成开发：${task.title}\n请在项目里 git diff 审查改动`).catch(notifyFail);
    } else {
      await sendText(job.chatId, `${at}❌ 开发失败：${task.title}\n${(r?.log || '').slice(-500)}`).catch(notifyFail);
    }
```

catch 分支同样加 `${at}`（`at` 需在 try 外声明，避免作用域问题——在 `const task = getTask(job.taskId);` 之后就声明）。

注意：triage 会话内的交互回复走 `ctx.reply`，已在 Task 7 带上 @，**不要重复加**。

- [ ] **Step 3: 语法自检 + 全量测试**

Run: `node --check src/plugins/team-tools/auto-dev/index.js && node --check src/plugins/team-tools/task-triage/index.js && npm test`
Expected: 无输出 + 测试全绿

---

## Task 9：放弃改动（git + API + 面板按钮）

**Files:**
- Modify: `src/plugins/team-tools/auto-dev/git.js`
- Modify: `src/plugins/team-tools/auto-dev/git.test.js`
- Modify: `src/entrypoints/web/routes-ops.js`
- Modify: `public/js/tasks-panel.js`

- [ ] **Step 1: 写 `deleteBranchArgs` 的失败测试**

在 `src/plugins/team-tools/auto-dev/git.test.js` 末尾追加（import 区补 `deleteBranchArgs`）：

```js
test('deleteBranchArgs：-C repo branch -D <branch>（强删，任务分支未合并也要能删）', () => {
  assert.deepEqual(deleteBranchArgs('C:\\proj', 'task/t_abc-bug'), [
    '-C', 'C:\\proj', 'branch', '-D', 'task/t_abc-bug',
  ]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/plugins/team-tools/auto-dev/git.test.js`
Expected: FAIL —— `deleteBranchArgs is not exported`

- [ ] **Step 3: 实现 git 层**

在 `src/plugins/team-tools/auto-dev/git.js` 的 `pushArgs` 之后加纯函数：

```js
export function deleteBranchArgs(repo, branch) {
  return ['-C', repo, 'branch', '-D', branch];
}
```

在 `mergeBranch` 之后加：

```js
/**
 * 放弃改动：删除任务分支（-D 强删，任务分支从未合并）。
 * 分支已不存在 → 视为已放弃（ok:true，幂等：避免脏数据把任务永久卡在待合并）。
 * 仍被某个 worktree 检出 → git 拒绝删除，原样上报错误（正常流程 auto-dev 完成后已 detach HEAD）。
 * @returns {{ ok:boolean, error?:string }}
 */
export async function deleteBranch(repo, branch) {
  if (!(await branchExists(repo, branch))) {
    logger.warn('auto-dev', '放弃改动：分支已不存在，视为已放弃', { repo, branch });
    return { ok: true };
  }
  const r = await git(deleteBranchArgs(repo, branch));
  if (!r.ok) {
    const error = (r.err || r.out || '删除分支失败').slice(0, 300);
    logger.warn('auto-dev', '放弃改动失败', { repo, branch, error });
    return { ok: false, error };
  }
  logger.info('auto-dev', '放弃改动：分支已删除', { repo, branch });
  return { ok: true };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/plugins/team-tools/auto-dev/git.test.js`
Expected: PASS

- [ ] **Step 5: 加 `discard` API**

`src/entrypoints/web/routes-ops.js` import 区把 `mergeBranch` 那行改为：

```js
import { mergeBranch, deleteBranch } from '../../plugins/team-tools/auto-dev/git.js';
```

在 `if (data.action === 'merge') { ... }` 那个 block **之后**、`sendJson(res, 400, { error: '未知操作' })` 之前插入：

```js
    if (data.action === 'discard') {
      // 条件与 merge 对齐（自动完成、未合并、有分支）——只有「待合并」的任务才谈得上放弃改动
      if (!(task.auto && task.status === 'done' && !task.merged && task.branch)) {
        return sendJson(res, 400, { error: '任务不满足放弃条件（须为自动完成且未合并）' });
      }
      // 用任务开发时快照的 repo（防此后切换启用机器人导致删错仓库的分支）；旧数据无快照才兜底
      const repo = task.repo || getActiveBot()?.projectDir || config.feedback.frontendDir;
      const r = await deleteBranch(repo, task.branch);
      if (!r.ok) {
        // 删分支失败不改状态：绝不留「已放弃但分支还在」的半放弃态
        logger.warn('web', '任务放弃改动失败', { id: task.id, err: r.error });
        return sendJson(res, 409, { error: r.error, task });
      }
      const t = updateTask(
        task.id,
        { status: 'rejected', discarded: true, discardedAt: new Date().toISOString(), mergeError: null },
        `放弃改动，已删除分支 ${task.branch}`,
      );
      logger.info('web', '任务已放弃改动', { id: task.id, branch: task.branch });
      return sendJson(res, 200, { task: t });
    }
```

- [ ] **Step 6: 面板加按钮**

`public/js/tasks-panel.js` 的 `actionsFor` 里，把 `isAwaitingMerge(t)` 分支改为：

```js
        } else if (isAwaitingMerge(t)) {
          add('合并到主分支', 'primary', () => mergeTask(t));
          add('放弃改动', 'danger', () => discardTask(t));
        } else {
```

在 `mergeTask` 函数之后插入：

```js
      // 放弃改动确认：明示要删除的分支名与不可恢复（与合并同一档二次提醒）
      async function discardTask(t) {
        const ok = await confirmDialog({
          title: '放弃改动',
          message: `确认放弃「${t.title}」的自动改动？\n将删除分支「${t.branch}」，改动不可恢复。`,
          confirmText: '确认放弃',
          danger: true,
        });
        if (!ok) return;
        taskAction(t.id, 'discard');
      }
```

- [ ] **Step 7: 语法自检 + 全量测试**

Run: `node --check src/entrypoints/web/routes-ops.js && node --check public/js/tasks-panel.js && npm test`
Expected: 无输出 + 测试全绿

若 `public/js/tasks-panel.js` 是 IIFE / 模板字符串包裹的形式导致 `node --check` 报错，跳过该文件的 check，改为在浏览器控制台确认无报错。

---

## Task 10：文档更新与人工走查

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/superpowers/specs/2026-07-30-feishu-intent-shrink-design.md`（勾掉遗留项）

- [ ] **Step 1: 更新 ARCHITECTURE 的意图识别数据流**

`docs/ARCHITECTURE.md` 约 175-190 行的「数据流」代码块替换为：

```
飞书消息 → WSClient.onMessage
  ↓
群聊过滤：chat_type=group 且未 @ 机器人 → 静默忽略
  ↓
权限判定 OWNER_OPEN_IDS
  ├─ owner → match 兜底（task-triage / claude-exec，不走意图识别）
  └─ guest → 意图识别
  ↓
意图识别（app/intent.js，逐层短路）
  L0 寒暄 → other
  L1 强意图前缀（app/intent-keywords.js，零成本）
     「提交需求/提个需求/需求：」 → feature
     「提交故障/提交BUG/提个bug/故障：」 → bug
     「问个问题/请问/有个疑问」    → question
  L2 动作关键词单命中 → action（action-configs 配置驱动）
  L3 一次 Haiku 合并分类（bug/feature/question/material/action，10s 超时）
  L4 都不是 → other
  ↓
feature 分发（features/index.js 注册顺序）
  ├─ feature/bug → feedback（即时应答 → 建任务 → 按托管档位评审/分析/自动开发）
  ├─ question    → project-qa（即时应答 → 只读查代码 → 回答）
  ├─ action      → action-runner（脚本 + 槽位填充）
  ├─ material    → feedback（材料入池，等下一条文字立案）
  └─ other       → 引导文案（msg('welcome')）
  ↓
result 回复到飞书会话（群聊自动 @ 提问人）
```

并把该文件 54 行与 408 行的 `task-triage/ (意图识别)` 注释改为 `task-triage/ (owner 待办分诊)`——
意图识别早已归 `app/intent.js`，那两处注释是历史残留。

- [ ] **Step 2: 人工走查（用户执行，逐条勾）**

重启飞书进程后逐条验证：

- [ ] p2p 发「提交需求：登录页加记住密码」→ **1 秒内**回需求即时应答 → 后续流程按托管档位正常
- [ ] p2p 发「提交故障：扫码页白屏」→ 1 秒内回故障即时应答
- [ ] p2p 发「问个问题 订单状态是怎么流转的」→ 1 秒内回问询应答 → 数十秒后给出基于代码的回答
- [ ] p2p 连着再问一个问题（上一个还在查）→ 回「我还在查上一个问题」
- [ ] p2p 发「今天天气不错」→ 回引导文案，**日志里没有 project-qa 记录**（确认不再触发读码问答）
- [ ] p2p 发「你好」→ 回引导文案，日志显示零 LLM 调用
- [ ] p2p 只发「提交需求」→ 回「请把需求内容发我」，`tasks.json` 未新增任务
- [ ] p2p 发「帮我清一下 dev 环境数据」等已配置动作关键词 → 动作照旧触发（L2 未回归）
- [ ] 群聊 @ 机器人「提交需求：xxx」→ 回复带 @ 提问人，且任务 title 里**没有** `@_user_1`
- [ ] 群聊不 @ 随便说话 → 机器人沉默（日志有「群聊消息未 @ 机器人，忽略」）
- [ ] 中/完全托管跑一个自动开发任务到「待合并」→ web 面板点「放弃改动」→ 二次确认 → 任务显示「已放弃」，
      `git -C <projectDir> branch -a` 里对应 `task/...` 分支消失
- [ ] 同一场景点「合并到主分支」仍正常（合并链路未回归）
- [ ] 轻度托管提一个需求 → 即时应答 + 分析完成后的闭环回复，共两条
- [ ] 设置页 → 机器人编辑 → 三条即时应答文案可改，改完下一条消息即生效

- [ ] **Step 3: 收尾**

- [ ] `npm test` 全绿
- [ ] `grep -rn "feedbackAck\|feedbackRoute\|FAST_PATH_MAX_LEN" src/ public/` → 无命中
- [ ] 在 spec 的「遗留 / 待观察」里记录走查结论（尤其 material 误伤率的观察结果）
- [ ] **不做 git 提交**（项目铁律，提交时机由用户掌控）

---

## 计划自检（写完后已核对）

**Spec 覆盖：** §3 意图识别 → Task 1/3；§3.4 空正文保护 → Task 4；§4 即时应答与文案 → Task 2/4；
§5 project-qa → Task 5；§6 放弃改动 → Task 9；§7 群聊 @ → Task 6/7/8；§9 测试 → 各任务内 + Task 10；
§10 文档 → Task 10。无遗漏项。

**命名一致性：** `matchStrongIntent` / `atPrefix` / `parseMentions` / `stripMentions` / `deleteBranchArgs` /
`deleteBranch` / `INTENT_CLASSIFY_TIMEOUT_MS` / `QA_TIMEOUT_MS` / `ackBug|ackFeature|ackQuestion` /
`action:'discard'` / `task.source.chatType` —— 定义处与使用处名称一致。

**已知实施顺序约束：** Task 1 → 3（intent.js import 词表）；Task 2 → 4/5（文案 key）；
Task 6 → 7/8（`atPrefix` 与 mentions 解析）；Task 3 → 5（`ctx.body` 由 dispatch 写入）。
Task 9 独立，可任意时点插入。

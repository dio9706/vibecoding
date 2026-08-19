# 飞书会话回控功能 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标**：优化飞书通知功能，移除鸡肋按钮，新增会话 ID 路由和新建会话指令。

**架构**：核心逻辑分散在 4 个层级——纯函数解析层（logic.js）、数据层（store）、路由层（web routes）、消息处理层（插件）。采用 TDD 方式，先测试后实现，频繁提交。

**技术栈**：Node.js，Express（web），纯函数设计，文件锁并发控制（updateJson）

---

## Task 1：修改摘要函数 — 末尾截断，字数改 500

**文件**：`src/entrypoints/web/conv-notify.logic.js`

**概述**：将 `summarize()` 从头部截断改为末尾截断，保留最新产出的内容。

- [ ] **Step 1：查看现有代码**

打开 `src/entrypoints/web/conv-notify.logic.js`，找到 `summarize()` 函数（约第 20-24 行）。

现有代码：
```javascript
export function summarize(text, max = 300) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return '(无输出)';
  return s.length > max ? s.slice(0, max) + '…' : s;
}
```

- [ ] **Step 2：修改为末尾截断，参数改为 500**

```javascript
export function summarize(text, max = 500) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return '(无输出)';
  return s.length > max ? '…' + s.slice(-max) : s;
}
```

关键改动：
- 默认参数 `300` → `500`
- `s.slice(0, max)` → `s.slice(-max)`（末尾保留）
- 前缀 `''` → `'…'`（开头加省略号）

- [ ] **Step 3：验证改动**

在项目根目录运行测试（如果存在）：

```bash
npm test -- summarize
```

或手动验证逻辑：
```javascript
const test1 = summarize('a'.repeat(600), 500);
// 预期：'…' + 'a'.repeat(500)，开头有省略号
const test2 = summarize('hello', 500);
// 预期：'hello'（未超长）
```

- [ ] **Step 4：提交**

```bash
git add src/entrypoints/web/conv-notify.logic.js
git commit -m "refactor: summarize 改末尾截断，字数改 500"
```

---

## Task 2：修改卡片构造 — 删按钮，加会话 ID 提示行

**文件**：`src/entrypoints/web/conv-notify.logic.js`

**概述**：在 `buildConvSettledCard()` 中删除两个按钮的 `action` 标签，在文本末尾追加会话 ID 提示行。

- [ ] **Step 1：查看现有卡片结构**

打开 `src/entrypoints/web/conv-notify.logic.js`，找到 `buildConvSettledCard()` 函数（约第 33-70 行）。

现有的返回值结构：
```javascript
return {
  elements: [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: '...' },  // 第 44-49 行
    },
    {
      tag: 'action',
      actions: [ /* 两个按钮 */ ],  // 第 51-67 行 — 这整个要删
    },
  ],
};
```

- [ ] **Step 2：修改 div 的 text.content，追加会话 ID 提示行**

将第 48 行的 content 字符串末尾，从：
```javascript
content: `${head}\n会话：「${entry.title || entry.convId}」 · 耗时 ${dur}\n\n${summarize(run.text)}${askHint}`,
```

改为：
```javascript
const shortId = entry.convId.slice(0, 8);
const sessionHint = `\n\n---\n会话ID：\`${shortId}\`\n如需继续对话，向我发送：会话 ${shortId} 你的内容`;
return {
  elements: [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `${head}\n会话：「${entry.title || entry.convId}」 · 耗时 ${dur}\n\n${summarize(run.text)}${askHint}${sessionHint}`,
      },
    },
  ],
};
```

完整修改后的函数（第 33-49 行改为）：
```javascript
export function buildConvSettledCard(entry, run) {
  const ok = !run.is_error && run.status !== 'error';
  const head = ok ? '✅ **任务已完成**' : '❌ **任务失败**';
  const dur = formatDuration((run.updatedAt || Date.now()) - (run.startedAt || Date.now()));
  const askHint =
    entry.mode === 'default'
      ? '\n\n⚠️ 该会话为「询问模式」，补充内容若触发改码工具会等待网页端审批。'
      : '';
  
  const shortId = entry.convId.slice(0, 8);
  const sessionHint = `\n\n---\n会话ID：\`${shortId}\`\n如需继续对话，向我发送：会话 ${shortId} 你的内容`;
  
  return {
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${head}\n会话：「${entry.title || entry.convId}」 · 耗时 ${dur}\n\n${summarize(run.text)}${askHint}${sessionHint}`,
        },
      },
    ],
  };
}
```

- [ ] **Step 3：验证卡片输出格式**

手动验证卡片 JSON 结构：
```javascript
const entry = { convId: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', title: 'test', mode: 'default' };
const run = { is_error: false, status: 'done', text: 'Result here', startedAt: Date.now() - 5000, updatedAt: Date.now() };
const card = buildConvSettledCard(entry, run);

// 验证：
// - card.elements.length === 1 （只有 div，无 action）
// - card.elements[0].text.content 包含 '会话ID: a1b2c3d4'
// - card.elements[0].text.content 包含 '会话 a1b2c3d4 你的内容'
console.log(JSON.stringify(card, null, 2));
```

- [ ] **Step 4：提交**

```bash
git add src/entrypoints/web/conv-notify.logic.js
git commit -m "feat: 删除卡片按钮，添加会话 ID 提示行"
```

---

## Task 3：新增文本解析函数 — matchSessionText()

**文件**：`src/plugins/feishu-relay/logic.js`

**概述**：新增纯函数 `matchSessionText(text)` 识别用户发送的「会话 xxxx 内容」格式。

- [ ] **Step 1：确认文件位置和现有函数**

打开 `src/plugins/feishu-relay/logic.js`，此文件已存在以下导出函数：
- `parseConvCardAction(data)`
- `matchSupplementText(text)`（已有）
- `isEndSessionText(text)`

现在要新增 `matchSessionText`。

- [ ] **Step 2：实现 matchSessionText()**

在文件末尾（第 37 行后）添加：

```javascript
/**
 * 识别「会话 <至少8位ID> <正文>」格式。
 * @param {string} text 用户输入的完整文本
 * @returns {{ shortId: string, body: string } | null}
 * 
 * 例如：
 * matchSessionText('会话 a1b2c3d4 我想补充一些东西')
 * → { shortId: 'a1b2c3d4', body: '我想补充一些东西' }
 * 
 * matchSessionText('会话补充内容')
 * → null
 */
export function matchSessionText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  
  // 正则：「会话」+ 空格 + 至少8位字母/数字 + 空格 + 至少1个字符
  const match = trimmed.match(/^会话\s+([a-zA-Z0-9]{8,})\s+(.+)$/);
  if (!match) return null;
  
  return {
    shortId: match[1],
    body: match[2],
  };
}
```

- [ ] **Step 3：测试覆盖**

在项目的现有测试文件中（或新建 `tests/plugins/feishu-relay/logic.test.js`），添加测试：

```javascript
import { matchSessionText } from '../../../src/plugins/feishu-relay/logic.js';

describe('matchSessionText', () => {
  it('正常匹配：8位 ID + 正文', () => {
    const result = matchSessionText('会话 a1b2c3d4 我要补充内容');
    expect(result).toEqual({ shortId: 'a1b2c3d4', body: '我要补充内容' });
  });

  it('超过8位 ID 也匹配', () => {
    const result = matchSessionText('会话 a1b2c3d4e5f6g7h8 详细说明');
    expect(result).toEqual({ shortId: 'a1b2c3d4e5f6g7h8', body: '详细说明' });
  });

  it('少于8位 ID 不匹配', () => {
    const result = matchSessionText('会话 a1b2c3 内容');
    expect(result).toBeNull();
  });

  it('不是「会话」开头不匹配', () => {
    const result = matchSessionText('我要说 a1b2c3d4 内容');
    expect(result).toBeNull();
  });

  it('空格不足不匹配', () => {
    const result = matchSessionText('会话a1b2c3d4内容');
    expect(result).toBeNull();
  });

  it('非字符串输入返回 null', () => {
    expect(matchSessionText(null)).toBeNull();
    expect(matchSessionText(123)).toBeNull();
  });
});
```

- [ ] **Step 4：运行测试**

```bash
npm test -- logic.test.js
```

预期：全部通过

- [ ] **Step 5：提交**

```bash
git add src/plugins/feishu-relay/logic.js tests/plugins/feishu-relay/logic.test.js
git commit -m "feat: 新增 matchSessionText() 解析会话指令"
```

---

## Task 4：新增查表函数 — findEntryByShortId()

**文件**：`src/store/conv-notify.js`

**概述**：新增函数 `findEntryByShortId(shortId)` 按前 8 位 ID 查找会话条目。

- [ ] **Step 1：查看现有数据结构**

打开 `src/store/conv-notify.js`，此文件已有：
- `getAll()` — 返回所有会话条目的 Map
- `getEntry(convId)` — 按完整 ID 查询

现在要新增按前缀查询的函数。

- [ ] **Step 2：实现 findEntryByShortId()**

在 `pickLatestNotified()` 函数之前（约第 107 行前）添加：

```javascript
/**
 * 按前 8 位短 ID 查找会话条目。
 * @param {string} shortId 前 8 位 ID（如 'a1b2c3d4'）
 * @returns {Object | null} 匹配的会话条目，或 null
 * 
 * 冲突处理：若多个会话 convId 都以 shortId 开头，返回 enabledAt 最晚的那个（最近创建）。
 * 
 * 例如：
 * findEntryByShortId('a1b2c3d4')
 * → { convId: 'a1b2c3d4-...', title: '...' }
 */
export function findEntryByShortId(shortId) {
  if (!shortId || typeof shortId !== 'string') return null;
  
  let best = null;
  for (const entry of Object.values(getAll())) {
    // 检查 convId 是否以 shortId 开头
    if (!entry.convId || !entry.convId.startsWith(shortId)) continue;
    
    // 冲突时选最近创建的（enabledAt 最晚）
    if (!best || (entry.enabledAt && best.enabledAt && entry.enabledAt > best.enabledAt)) {
      best = entry;
    }
  }
  return best;
}
```

- [ ] **Step 3：测试覆盖**

新建或更新 `tests/store/conv-notify.test.js`，添加测试：

```javascript
import { findEntryByShortId, enableConv, getAll } from '../../../src/store/conv-notify.js';

describe('findEntryByShortId', () => {
  beforeEach(() => {
    // 清空所有会话（测试隔离）
    // 如果 store 有导出 clearAll() 就用，否则你可能需要 mock readJson/updateJson
  });

  it('精确找到以短 ID 开头的会话', () => {
    enableConv({ convId: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', title: 'test' });
    const result = findEntryByShortId('a1b2c3d4');
    expect(result?.convId).toBe('a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d');
    expect(result?.title).toBe('test');
  });

  it('短 ID 不匹配时返回 null', () => {
    enableConv({ convId: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', title: 'test' });
    const result = findEntryByShortId('ffffffff');
    expect(result).toBeNull();
  });

  it('冲突时返回最近创建的会话', () => {
    // 模拟两个会话，前 8 位相同（极小概率但需要处理）
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 10000).toISOString();
    
    // 这里需要能直接写入 store，可能需要 mock updateJson
    // 假设能直接调用内部的写入逻辑
    enableConv({ convId: 'a1b2c3d4-old-date-xxxx', title: 'old' });
    // 然后更新 enabledAt 为过去的时间（实际测试中需要 mock 或重设计）
    enableConv({ convId: 'a1b2c3d4-new-date-yyyy', title: 'new' });
    
    const result = findEntryByShortId('a1b2c3d4');
    expect(result?.title).toBe('new');  // 最新创建的
  });

  it('非字符串输入返回 null', () => {
    expect(findEntryByShortId(null)).toBeNull();
    expect(findEntryByShortId(123)).toBeNull();
  });
});
```

- [ ] **Step 4：运行测试**

```bash
npm test -- conv-notify.test.js
```

- [ ] **Step 5：提交**

```bash
git add src/store/conv-notify.js tests/store/conv-notify.test.js
git commit -m "feat: 新增 findEntryByShortId() 按前缀查询会话"
```

---

## Task 5：扩展飞书消息路由 — 处理「会话 xxxx」指令

**文件**：`src/plugins/feishu-relay/index.js`

**概述**：在 `match()` 和 `handle()` 中新增分支，识别和处理「会话 xxxx 内容」文本，调用既有的 `doInject()` 完成注入。

- [ ] **Step 1：查看现有结构**

打开 `src/plugins/feishu-relay/index.js`，了解：
- 第 20 行：`import { parseConvCardAction, matchSupplementText, isEndSessionText, canOperateRelay } from './logic.js'`
  - 需要追加导入 `matchSessionText`
- 第 153-155 行：`match()` 函数的现有逻辑
- 第 129-146 行：`handle()` 函数的现有逻辑

- [ ] **Step 2：在 import 语句中添加 matchSessionText**

第 20 行改为：
```javascript
import { parseConvCardAction, matchSupplementText, isEndSessionText, canOperateRelay, matchSessionText } from './logic.js';
```

并在 logic.js 中导出 `matchSessionText`（可从上一个 task 中导入）。

同时，需要导入 `findEntryByShortId`（第 18 行后添加）：
```javascript
import { getEntry, findEntryByShortId } from '../../store/conv-notify.js';
```

- [ ] **Step 3：修改 match() 函数**

第 153-155 行的现有代码：
```javascript
match: (ctx) =>
  (isEndSessionText(ctx.text) || !!matchSupplementText(ctx.text)) &&
  canOperateRelay(ctx.user?.id, relayPermOpts()),
```

改为：
```javascript
match: (ctx) =>
  (isEndSessionText(ctx.text) || !!matchSupplementText(ctx.text) || !!matchSessionText(ctx.text)) &&
  canOperateRelay(ctx.user?.id, relayPermOpts()),
```

- [ ] **Step 4：修改 handle() 函数 — 新增「会话 xxxx」分支**

在第 129-146 的 `handle()` 函数中，原有三个分支：
1. 「结束会话」（第 132-135）
2. 等待态命中（第 136-138）
3. 文本兜底「补充内容 xxx」（第 140-145）

在第 140 行（第 3 分支之前）插入新分支：

```javascript
// 2.5. 会话 ID 路由：用户发「会话 a1b2c3d4 内容」
const sessionMatch = matchSessionText(ctx.text);
if (sessionMatch) {
  const target = findEntryByShortId(sessionMatch.shortId);
  if (!target) {
    return ctx.reply(`⚠️ 未找到会话「${sessionMatch.shortId}」，请检查会话 ID 是否正确。`);
  }
  const label = target.title || target.convId;
  return doInject(target.convId, label, sessionMatch.body, ctx.reply);
}
```

完整的 `handle()` 函数应为：
```javascript
handle: async (ctx) => {
  // 1. 「结束会话」放最前面
  if (isEndSessionText(ctx.text)) {
    clearSupplement(ctx.user?.id);
    return ctx.reply('🛑 已结束本次通知交互（未做任何动作）。');
  }
  
  // 2. 等待态命中
  const pendingEntry = takeSupplement(ctx.user?.id);
  if (pendingEntry) return pendingEntry.onText(String(ctx.text ?? '').trim(), ctx.reply);

  // 2.5. 会话 ID 路由
  const sessionMatch = matchSessionText(ctx.text);
  if (sessionMatch) {
    const target = findEntryByShortId(sessionMatch.shortId);
    if (!target) {
      return ctx.reply(`⚠️ 未找到会话「${sessionMatch.shortId}」，请检查会话 ID 是否正确。`);
    }
    const label = target.title || target.convId;
    return doInject(target.convId, label, sessionMatch.body, ctx.reply);
  }

  // 3. 文本兜底（补充内容 xxx）
  const body = matchSupplementText(ctx.text);
  if (!body) return ctx.reply('没识别到补充内容，请发「补充内容 <你的补充>」或「会话 <ID> <内容>」。');
  const target = pickLatestNotified(FALLBACK_WINDOW_MS);
  if (!target) return ctx.reply('近 24 小时没有收到过通知的会话，请先在网页端激活飞书通知。');
  return doInject(target.convId, target.title || target.convId, body, ctx.reply);
},
```

注意第 142 行的错误提示信息也要更新（增加「会话 <ID>」选项）。

- [ ] **Step 5：验证逻辑**

手动追踪一个场景：
```javascript
// 场景：用户发「会话 a1b2c3d4 我要补充」
const ctx = {
  text: '会话 a1b2c3d4 我要补充',
  user: { id: 'user_123' },
  reply: (msg) => console.log('BOT:', msg),
};

const sessionMatch = matchSessionText(ctx.text);
// → { shortId: 'a1b2c3d4', body: '我要补充' }

const target = findEntryByShortId('a1b2c3d4');
// → { convId: 'a1b2c3d4-...', title: 'task' } （假设找到）

// 然后调 doInject('a1b2c3d4-...', 'task', '我要补充', ctx.reply)
```

- [ ] **Step 6：提交**

```bash
git add src/plugins/feishu-relay/index.js src/plugins/feishu-relay/logic.js
git commit -m "feat: 新增「会话 xxxx 内容」路由处理"
```

---

## Task 6：新增 Web 路由 — POST /api/conv-notify/new

**文件**：`src/entrypoints/web/routes-conv-notify.js`

**概述**：新增 POST 路由生成新会话、写入 conv-notify.json、创建网页端会话、返回 convId。

- [ ] **Step 1：查看现有路由**

打开 `src/entrypoints/web/routes-conv-notify.js`，了解现有的路由结构（如何注册路由、错误处理）。

现有路由应包括：
- `POST /api/conv-notify/on`
- `POST /api/conv-notify/off`
- `POST /api/conv-notify/sync`
- `GET /api/conv-notify/inbox`
- `POST /api/conv-notify/claim`
- `POST /api/conv-notify/inject`

- [ ] **Step 2：查看会话创建的既有 API**

需要找到 web 侧创建会话的函数。可能在：
- `src/app/conv-store.js` 或类似的会话管理模块
- 查找 `createConv` / `createSession` / `newConv` 等函数

假设找到的创建函数为 `createConversation(opts)` 或类似的。

- [ ] **Step 3：在 routes-conv-notify.js 中新增 POST /api/conv-notify/new**

在文件末尾（或路由列表中）添加：

```javascript
/**
 * 创建新会话（供飞书 \10003 指令调用）
 * 
 * 请求：POST /api/conv-notify/new
 * 响应：{ ok: true, convId: "a1b2c3d4-..." } 或 { ok: false, error: "..." }
 */
router.post('/new', async (req, res) => {
  try {
    // 1. 生成 UUID 作为 convId
    const convId = generateUUID(); // 需要 import 或使用 crypto.randomUUID()
    
    // 2. 在 conv-notify.json 中注册会话
    const entry = enableConv({
      convId,
      title: '飞书新建会话',
      session: '', // 初始为空，前端打开时会同步
      cwd: '',
      model: 'auto',
      effort: 'medium',
      mode: 'default',
    });
    
    if (!entry) {
      return res.json({ ok: false, error: '会话注册失败' });
    }
    
    // 3. 在 web 侧创建真实会话（关键：这样前端才能在侧边栏看到）
    // 假设已有 createConversation() 函数
    const newConv = await createConversation({
      title: `会话 ${convId.slice(0, 8)}`,
      metadata: { convId, source: 'feishu' },
    });
    
    if (!newConv) {
      return res.json({ ok: false, error: '创建网页端会话失败' });
    }
    
    logger.info('conv-notify', '新建会话成功', { convId, newConvId: newConv.id });
    
    // 4. 返回 convId 给飞书侧
    return res.json({ ok: true, convId });
  } catch (e) {
    logger.error('conv-notify', '新建会话异常', { err: e?.message || String(e) });
    return res.json({ ok: false, error: '服务异常' });
  }
});
```

关键点：
- 需要 import `{ enableConv }` 从 `../../store/conv-notify.js`
- 需要 import `{ createConversation }` （确切的导入路径需要查代码）
- 需要 import `{ logger }` 
- UUID 生成可用 Node.js 的 `crypto.randomUUID()`

- [ ] **Step 4：处理 UUID 生成**

在文件头部添加导入：
```javascript
import { randomUUID } from 'crypto';

function generateUUID() {
  return randomUUID();
}
```

或直接用 `crypto.randomUUID()`。

- [ ] **Step 5：测试覆盖**

新建 `tests/entrypoints/web/routes-conv-notify.test.js`（或追加到现有测试），添加：

```javascript
import request from 'supertest';
import app from '../../../src/app/index.js';

describe('POST /api/conv-notify/new', () => {
  it('成功创建新会话', async () => {
    const res = await request(app)
      .post('/api/conv-notify/new')
      .expect(200);
    
    expect(res.body.ok).toBe(true);
    expect(res.body.convId).toBeDefined();
    expect(res.body.convId).toMatch(/^[a-f0-9-]{36}$/); // UUID 格式
  });

  it('返回的 convId 可查询', async () => {
    const createRes = await request(app)
      .post('/api/conv-notify/new')
      .expect(200);
    
    const convId = createRes.body.convId;
    
    // 验证会话已注册
    const entry = getEntry(convId);
    expect(entry).toBeDefined();
    expect(entry.title).toBe('飞书新建会话');
  });

  it('异常时返回错误信息', async () => {
    // mock createConversation 失败
    // ... 需要 mock 框架支持
    
    // 测试错误处理
  });
});
```

- [ ] **Step 6：验证跨进程通讯**

确保飞书侧可以成功调用这个路由（参考 `postInject` 的模式）。

- [ ] **Step 7：提交**

```bash
git add src/entrypoints/web/routes-conv-notify.js tests/entrypoints/web/routes-conv-notify.test.js
git commit -m "feat: 新增 POST /api/conv-notify/new 创建会话路由"
```

---

## Task 7：新增飞书指令处理器 — `\10003 新建会话`

**文件**：`src/plugins/trusted-commands/index.js`

**概述**：在 trusted-commands 插件中新增 `\10003 新建会话` 指令处理器，调用 web 路由、返回会话 ID 给用户。

- [ ] **Step 1：查看现有指令**

打开 `src/plugins/trusted-commands/index.js`，了解：
- 现有的 `\10001`、`\10002` 如何实现
- 如何注册指令处理器
- 权限校验的模式

假设现有结构类似：
```javascript
const feature = {
  name: 'trusted-commands',
  permission: 'owner',  // 或其他权限
  intents: [],
  match: (ctx) => ctx.text?.startsWith('\\10'),
  handle: async (ctx) => {
    if (ctx.text === '\\10001 BUG巡检') { ... }
    if (ctx.text === '\\10002 任务清单') { ... }
    // 这里要新增 \10003
  },
};
```

- [ ] **Step 2：新增 \10003 处理分支**

在 `handle()` 函数中（或适当的位置）添加：

```javascript
if (ctx.text === '\\10003 新建会话') {
  // 权限校验：确保只有 owner/trusted 用户能调用
  // (trusted-commands 的权限应该已经在 feature.permission 中设置，或在这里检查)
  
  try {
    // 1. 调 web 侧路由新建会话
    const createRes = await fetch(`http://127.0.0.1:${config.web.port}/api/conv-notify/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
    });
    
    const data = await createRes.json();
    
    if (!createRes.ok || data.ok === false) {
      logger.warn('trusted-commands', '新建会话失败', { error: data.error });
      return ctx.reply(`⚠️ ${data.error || '新建会话失败'}`);
    }
    
    // 2. 获取前 8 位 shortId
    const convId = data.convId;
    const shortId = convId.slice(0, 8);
    
    // 3. 回复用户
    logger.info('trusted-commands', '新建会话成功', { convId });
    return ctx.reply(
      `✅ 已新建会话\n` +
      `会话ID：${shortId}\n` +
      `向我发送「会话 ${shortId} 你的内容」即可开始对话`
    );
  } catch (e) {
    logger.error('trusted-commands', '新建会话异常', { err: e?.message || String(e) });
    return ctx.reply(`⚠️ 执行台无响应，请稍后再试`);
  }
}
```

注意导入：
- `config` （如果还没有的话）
- `logger`
- `INJECT_TIMEOUT_MS` 常量（可从 feishu-relay/index.js 复用，或定义为 3000）

- [ ] **Step 3：处理超时和错误**

确保超时处理正确（参考 Task 6 中的 `postInject()` 逻辑）。

- [ ] **Step 4：验证指令流程**

手动追踪场景：
```
用户在飞书发：\10003 新建会话
  ↓
trusted-commands match → 匹配 '\\10003 新建会话'
  ↓
handle() → POST /api/conv-notify/new
  ↓
web 响应 { ok: true, convId: 'a1b2c3d4-...' }
  ↓
extractShortId → 'a1b2c3d4'
  ↓
ctx.reply('✅ 已新建会话\n会话ID: a1b2c3d4\n...')
```

- [ ] **Step 5：提交**

```bash
git add src/plugins/trusted-commands/index.js
git commit -m "feat: 新增 \\10003 新建会话指令"
```

---

## Task 8：集成测试 + 全链路验证

**文件**：手动测试，无需新建

**概述**：验证整个流程：飞书发指令 → 网页端创建会话 → 发「会话 xxxx」路由成功。

- [ ] **Step 1：启动项目**

```bash
npm run dev
# 或项目的启动命令
```

确保 web 进程和飞书进程都在运行。

- [ ] **Step 2：飞书侧测试 — \10003 新建会话**

在飞书（或测试账户）发送：
```
\10003 新建会话
```

预期回复：
```
✅ 已新建会话
会话ID：a1b2c3d4
向我发送「会话 a1b2c3d4 你的内容」即可开始对话
```

检查：
- 会话 ID 是 8 位字母数字组合
- web 端侧边栏出现新会话

- [ ] **Step 3：飞书侧测试 — 会话 xxxx 内容**

获取上一步的会话 ID（如 `a1b2c3d4`），在飞书发送：
```
会话 a1b2c3d4 你好，请帮我写一个 hello world
```

预期：
- 飞书回复：`✅ 已把补充内容发到会话「...」(...)`
- web 端该会话出现新消息，Claude 开始执行

- [ ] **Step 4：网页端测试 — 查看会话**

打开网页，侧边栏应显示新创建的会话，点开可查看与飞书发送的内容。

- [ ] **Step 5：会话通知卡片测试**

让某个会话完成（或模拟完成），收到飞书通知卡片，验证：
- ✅ 无「补充内容」和「结束会话」按钮
- ✅ 卡片末尾显示 `会话ID: a1b2c3d4` 和使用说明
- ✅ 内容摘要为末尾 500 字（若超过 500 字，开头有 `…`）

- [ ] **Step 6：记录测试结果**

创建一个简单的测试报告（可选，但推荐）：

```markdown
# 全链路测试报告 — 2026-08-19

## ✅ 测试场景 1：\10003 新建会话
- 飞书发送 `\10003 新建会话`
- ✅ 收到确认回复，包含会话 ID
- ✅ web 侧边栏出现新会话

## ✅ 测试场景 2：会话 xxxx 内容
- 飞书发送 `会话 a1b2c3d4 帮我写个脚本`
- ✅ 飞书回复成功注入
- ✅ web 该会话收到消息，Claude 执行

## ✅ 测试场景 3：通知卡片
- 会话完成
- ✅ 卡片无旧按钮，显示会话 ID
- ✅ 内容截断正常（末尾，500 字）
```

- [ ] **Step 7：提交（可选）**

如果有测试报告文件：
```bash
git add TESTING_REPORT.md
git commit -m "test: 全链路测试通过"
```

---

## 完整文件改动清单

| 优先级 | 文件 | 改动 | Task |
|--------|------|------|------|
| P0 | `src/entrypoints/web/conv-notify.logic.js` | 修改 `summarize()` 末尾截断 + 修改 `buildConvSettledCard()` | 1,2 |
| P0 | `src/plugins/feishu-relay/logic.js` | 新增 `matchSessionText()` | 3 |
| P0 | `src/store/conv-notify.js` | 新增 `findEntryByShortId()` | 4 |
| P0 | `src/plugins/feishu-relay/index.js` | 扩展 match/handle，处理会话路由 | 5 |
| P1 | `src/entrypoints/web/routes-conv-notify.js` | 新增 POST /api/conv-notify/new | 6 |
| P1 | `src/plugins/trusted-commands/index.js` | 新增 \10003 处理器 | 7 |

---

## 测试清单

- [ ] Task 1：summarize() 函数单测（末尾截断，字数 500）
- [ ] Task 2：buildConvSettledCard() 卡片结构验证（无按钮，有 ID 提示）
- [ ] Task 3：matchSessionText() 正则测试（格式识别）
- [ ] Task 4：findEntryByShortId() 查表测试（冲突处理）
- [ ] Task 5：feishu-relay 集成测试（路由逻辑）
- [ ] Task 6：Web 路由单测（UUID 生成，会话创建）
- [ ] Task 7：trusted-commands 集成测试（指令识别，跨进程）
- [ ] Task 8：全链路手动测试（\10003 → 会话 xxxx → 通知卡片）

---

## 完成标准

- ✅ 所有代码通过既有的测试框架（如有）
- ✅ 飞书 `\10003 新建会话` 指令可用
- ✅ `会话 xxxx 内容` 精确路由生效
- ✅ 通知卡片无旧按钮，显示会话 ID 和使用说明
- ✅ 摘要末尾截断，最多 500 字
- ✅ 频繁提交，每个 Task 一个 commit

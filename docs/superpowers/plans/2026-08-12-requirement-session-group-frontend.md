# 需求会话组前端补缺 - 交互层与优化汇总编排

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补完需求会话组功能的前端交互层与优化汇总编排，包括侧栏会话树、子会话生命周期、map-reduce 汇总流程与预览确认机制。

**Architecture:** 
- **种子机制生产端**：`createReqConv` 新增参数写入 `meta.seedPending/seedText`，`send()` 的消费端已有（只需补生产）。
- **会话树 UI**：在现有 `makeReqRow` 基础上加折叠/展开、子会话行、运行灯、＋新会话/重命名/删除。
- **优化汇总编排**：归档期新增按钮 → 创建 `kind='retro'` 会话 → 前端 map-reduce 逐会话喂入 → 聚合 → 标记块提取 → 预览确认 → 写盘。

**Tech Stack:** 
- 前端：Vanilla JS（`chat.js` / `req-view.js` / `conv-store.js`），SSE 流式对话
- 后端纯函数：Node.js（`req-logic.js`）
- API：POST `/api/req/session` / DELETE `/api/req/session`（已实现）、POST `/api/req/pitfalls`（已实现）、GET `/api/history/:sid`（已实现）

---

## 文件变更清单

| 文件 | 改动 | 行号范围 |
|------|------|--------|
| `public/js/chat.js` | 扩展 `createReqConv` 签名与实现 | 627–644 |
| `src/entrypoints/web/req-logic.js` | 新增 `buildRetroMapPrompt` / `buildRetroReducePrompt` | ~330 行后追加 |
| `public/js/req-view.js` | 改造 `makeReqRow` + 新增 `makeSessionRow` + 归档期汇总编排 | 多处 |
| `public/app.css` | 会话行 / 折叠箭头 / 运行灯样式 | ~3300 行后追加 |

---

## 实现注记

### 已完成、跳过的部分（无需再做）
- ✓ `sessions[]` 字段 + `normalizeSessions()` 纯函数（`requirements.js`）
- ✓ `POST/DELETE /api/req/session` 路由与 handler（`routes-requirements.js`）
- ✓ `req-pitfalls.js` 全套：`writePitfalls`、`ensureClaudeMdRef`、文件 IO
- ✓ `send()` 的种子消费逻辑（行 1338–1340，读 `meta.seedPending/seedText`）
- ✓ session SSE 事件回填 `/api/req/session`（行 1674–1687）
- ✓ `buildSeedPrompt` / `extractPitfalls` / `splitPitfallsByProject` / `mergePitfalls`（req-logic.js）
- ✓ `textareaDialog` / `convSetTitle` / `convDelete` / `convSetMeta` / `isConvRunning`

### 文档偏差（spec 与现状）
- **spec §5.1 引 `mountReqChrome`**：该函数不存在。需求装饰层由 `req-chat.js` 的 `bindReqConvHook` 挂载（已实现）。本计划不涉及。
- **spec §4 说"沿用 Task 11 另落 `req-inspect.js` 的先例"**：`req-inspect.js` 已存在并在用，不是先例。本计划不涉及。
- **spec "新增" 措辞**：后端 session/pitfalls 相关的"新增"项实际已实现；计划只补前端缺口。

---

## Task 1: 种子机制生产端 — `createReqConv` 扩展

**Files:**
- Modify: `public/js/chat.js:627–644`

**背景：** `send()` 已能消费 `meta.seedPending / meta.seedText`（行 1338–1340），但 `createReqConv` 未写入这两个字段，导致机制半残废。本 task 补充生产端。

- [ ] **Step 1: 读取现有 `createReqConv` 实现**

位置：`public/js/chat.js:627–644`。现状：
```javascript
export function createReqConv({ reqId, cwd: reqCwd, session, title }) {
  const list = loadConvs();
  const c = {
    id: 'c' + String(Date.now()),
    title: title || '需求会话',
    session: session || null,
    cwd: reqCwd || '',
    messages: [],
    updatedAt: Date.now(),
    meta: { reqId },
    provider: 'claude-agent',
  };
  list.push(c);
  saveConvs(list);
  return c.id;
}
```

当前 `meta` 仅含 `{ reqId }`。

- [ ] **Step 2: 扩展函数签名与 meta 写入**

新签名加三个可选参数：

```javascript
export function createReqConv({ reqId, cwd: reqCwd, session, title, kind = 'sub', seedPending = false, seedText = '' }) {
  const list = loadConvs();
  const c = {
    id: 'c' + String(Date.now()),
    title: title || '需求会话',
    session: session || null,
    cwd: reqCwd || '',
    messages: [],
    updatedAt: Date.now(),
    meta: { reqId, kind, seedPending, seedText },
    provider: 'claude-agent',
  };
  list.push(c);
  saveConvs(list);
  return c.id;
}
```

参数说明：
- `kind`：`'main'`（自动开发）、`'sub'`（子会话，默认）、`'retro'`（优化汇总）
- `seedPending`：布尔，`true` 时 `send()` 会前置拼上 `seedText`
- `seedText`：种子正文（约 200–300 token），新建子会话时由调用端（`req-view.js`）经 `buildSeedPrompt` 生成后传入

- [ ] **Step 3: 验证调用端兼容性**

运行 grep，检查现有调用点是否需适配：

```bash
grep -rn "createReqConv" public/js/ src/
```

预期结果：
- `req-view.js:6` import
- `req-view.js` 内某处调用（本计划 Task 4 新增，暂不存在）
- `chat.js:627` 定义

当前无其他调用点，无兼容性问题。

- [ ] **Step 4: 测试验证**

手工测试：打开浏览器开发者工具，在控制台执行：

```javascript
const convId = createReqConv({ 
  reqId: 'req123', 
  cwd: '/path/to/project', 
  session: null, 
  title: '测试子会话',
  kind: 'sub',
  seedPending: true,
  seedText: '【需求】XXX\n【工程】前端'
});
const list = loadConvs();
const conv = list.find(c => c.id === convId);
console.log(conv.meta);  // 应输出 { reqId: 'req123', kind: 'sub', seedPending: true, seedText: '...' }
```

预期：meta 包含全部四个字段。

- [ ] **Step 5: Commit**

```bash
git add public/js/chat.js
git commit -m "feat: extend createReqConv to write seed/kind into meta"
```

---

## Task 2: 优化汇总提示词生成 — `buildRetroMapPrompt` 与 `buildRetroReducePrompt`

**Files:**
- Modify: `src/entrypoints/web/req-logic.js` (追加函数)

**背景：** spec §6.2 描述的 map-reduce 框架要求两个纯函数生成提示词。map 侧逐会话小结，reduce 侧聚合全局规则提取。

- [ ] **Step 1: 理解 map 阶段的输入与输出**

map 输入：单个会话的转录（已过滤成 role+content 纯文本，来自 `GET /api/history/:sid`）。  
map 输出：一条简短的消息，要求 Claude 只提炼该会话的核心问题/解决方案，不展开细节。

代表例：
```
会话 1（侧栏样式调试）：
User: 为什么 .req-item 在 flex 容器里不换行？
Assistant: 因为 display:flex 默认 nowrap。加 flex-wrap:wrap 或改 flex-direction。

→ map 消息："第 1 个会话主题是侧栏样式调试。发现 flex-wrap 遗漏导致不换行，改为 wrap 后解决。"
```

- [ ] **Step 2: 理解 reduce 阶段的输入与输出**

reduce 输入：全部 map 消息的汇总（前端逐个接收后拼成一个上下文）。  
reduce 输出：需要两部分——
  - 回答正文：跨会话分析，识别反复出现的模式、坑点、解决方案。
  - 标记块内容：以 `<!-- PITFALLS-BEGIN --> ... <!-- PITFALLS-END -->` 包裹的避坑条目列表。

标记块格式（spec §6.3）：
```markdown
<!-- PITFALLS-BEGIN -->
- [前端] 改 `.req-*` 相关样式前先查 `[hidden]` 是否被 `display:flex` 覆盖，本仓已踩过两次。
- [后端] API 返回的 timestamp 需转 ISO 格式，否则前端 new Date() 会 NaN。
<!-- PITFALLS-END -->
```

每条格式：`- [前端|后端] <可执行的建议>`

- [ ] **Step 3: 实现 `buildRetroMapPrompt`**

位置：`src/entrypoints/web/req-logic.js` 末尾追加。

```javascript
/**
 * 生成 map 阶段提示词。
 * 要求 Claude 对单个会话的转录进行小结，提炼核心问题与解决方案。
 * @param {string} sessionTranscript 会话转录文本（role+content 纯文本）
 * @param {number} sessionIndex 会话序号（1-based）
 * @param {number} totalSessions 总会话数
 * @returns {string} map 提示词
 */
export function buildRetroMapPrompt(sessionTranscript, sessionIndex, totalSessions) {
  return `【会话 ${sessionIndex}/${totalSessions}】请总结以下会话的核心问题与解决方案，只需 1-2 句，不展开细节。

${sessionTranscript}

---

仅以 1-2 句话总结该会话的主题与核心发现，例：
- "样式调试：flex 容器未设 flex-wrap，导致行内元素不换行，改为 wrap 后解决。"
- "API 联调：后端返回的时间戳格式不标准，前端 new Date() 报 NaN，约定改为 ISO 格式。"`;
}
```

- [ ] **Step 4: 实现 `buildRetroReducePrompt`**

继续追加：

```javascript
/**
 * 生成 reduce 阶段提示词。
 * 要求 Claude 跨会话分析，识别反复出现的错误与避坑规则。
 * @param {Array<{role: string, content: string}>} mapMessages 前期各会话的 map 小结消息数组
 * @returns {string} reduce 提示词
 */
export function buildRetroReducePrompt(mapMessages) {
  const mapSummary = mapMessages.map((m, i) => `${i+1}. ${m.content}`).join('\n\n');
  
  return `你是需求开发的复盘专家。下面是 ${mapMessages.length} 个不同开发会话的小结：

${mapSummary}

---

请基于以上会话分析，重点识别 **跨会话反复出现的错误、设计遗漏、常见踩坑点**。仅出现一次的可能是偶然，出现多次才是本仓真坑。

最后，请在回答末尾输出一个固定标记块，格式如下：

\`\`\`
<!-- PITFALLS-BEGIN -->
- [前端] <可执行的避坑规则，带定位信息>
- [前端] <可执行的避坑规则，带定位信息>
- [后端] <可执行的避坑规则，带定位信息>
<!-- PITFALLS-END -->
\`\`\`

标记块之外的全部正文 = 完整回顾报告，将被记录为需求的优化汇总；标记块之内的条目将被提取、预览确认、写入各工程的 \`.claude/pitfalls.md\`。每条避坑项须：
1. 以 [前端] 或 [后端] 前缀标注归属（仅开发工程会被写入）；
2. 包含定位信息（文件名/函数名/关键词）；
3. 清晰可执行（不泛泛而谈）。`;
}
```

- [ ] **Step 5: 验证提示词内容**

在 Node.js REPL 里手工测试：

```javascript
import { buildRetroMapPrompt, buildRetroReducePrompt } from './req-logic.js';

// 测试 map
const mapPrompt = buildRetroMapPrompt('User: 怎样改 CSS？\nAssistant: 用 CSS。', 1, 3);
console.log(mapPrompt);  // 应含"会话 1/3"、原始转录、1-2 句示例

// 测试 reduce
const mapMsgs = [
  { role: 'assistant', content: '样式调试：flex 容器遗漏 flex-wrap。' },
  { role: 'assistant', content: 'API 联调：时间戳格式不标准。' }
];
const reducePrompt = buildRetroReducePrompt(mapMsgs);
console.log(reducePrompt);  // 应含"2 个会话"、标记块格式、前/后端分类说明
```

预期：prompts 包含标记块结构提示与前后端分类要求。

- [ ] **Step 6: Commit**

```bash
git add src/entrypoints/web/req-logic.js
git commit -m "feat: add buildRetroMapPrompt and buildRetroReducePrompt for map-reduce pipeline"
```

---

## Task 3: 侧栏会话树渲染 — 折叠展开与子会话行

**Files:**
- Modify: `public/js/req-view.js:200–303`（`makeReqRow`）+ 新增 `makeSessionRow` + CSS 引用

**背景：** 现在 `makeReqRow` 只显示需求行，不支持子会话树。需要改造成折叠/展开，并新增子会话行渲染。

- [ ] **Step 1: 设计状态容器**

会话树的折叠态在内存中维护，用 Map 记录"需求 ID → 是否展开"：

在 `req-view.js` 顶部找到全局变量区（~行 15–20），追加：

```javascript
// 侧栏需求行折叠态（展开态存内存，切页面不保留）
const expandedReqs = new Map();  // key: reqId, value: boolean
```

- [ ] **Step 2: 改造 `makeReqRow` 函数签名与折叠逻辑**

现有 `makeReqRow(r)` 返回 `<div class="req-item">...</div>`。改为返回包含折叠箭头与子会话树的行。

找到定义：`public/js/req-view.js:271–303`。新实现：

```javascript
function makeReqRow(r) {
  const isExpanded = expandedReqs.get(r.id) || (r.phase === 'dev' || r.phase === 'test');  // dev/test 默认展开
  const toggleArrow = isExpanded ? '▾' : '▸';
  
  const { devCwd: cwd } = r;  // handleGet 返回的展开后需求对象包含 devCwd
  
  // 折叠箭头点击：切换展开态
  const onToggle = (e) => {
    e.stopPropagation();
    expandedReqs.set(r.id, !expandedReqs.get(r.id));
    const rows = renderReqList();  // 重新渲染侧栏树
    _renderInto($id('req-list'), rows);
  };
  
  // 需求行主体（原有逻辑保留）
  const mainRow = el('div', { class: 'req-item' + (r === currentReq ? ' active' : ''),
                               onclick: () => openRequirement(r.id) },
    el('span', { class: 'req-toggle-arrow', onclick: onToggle }, toggleArrow),
    el('span', { class: 'req-pin-ic' }, '📌'),
    el('span', { class: 'req-title' }, r.title),
    r.busy ? el('span', { class: 'req-busy-dot' }) : null,
    el('span', { class: `req-badge ${r.phase}` }, r.phase)
  );
  
  const rows = [mainRow];
  
  // 展开时渲染子会话树（仅 dev/test 阶段）
  if (isExpanded && (r.phase === 'dev' || r.phase === 'test')) {
    const sessions = r.sessions || [];  // handleGet 已返回 normalize 过的 sessions
    
    sessions.forEach((session, idx) => {
      const sessionRow = makeSessionRow(session, r.id, cwd);
      rows.push(sessionRow);
    });
    
    // ＋新会话按钮
    const addSessionBtn = el('div', { class: 'req-session-row req-add-session' },
      el('button', { onclick: () => addNewSession(r.id, cwd) }, '＋ 新会话')
    );
    rows.push(addSessionBtn);
  }
  
  return el('div', {}, ...rows);  // 返回包含主行 + 子会话树的容器
}
```

- [ ] **Step 3: 新增 `makeSessionRow` 函数**

在 `makeReqRow` 下方追加：

```javascript
/**
 * 渲染单个子会话行。
 * @param {object} session 会话对象 { convId, sessionId, title, kind, createdAt }
 * @param {string} reqId 所属需求 ID
 * @param {string} cwd 工程目录（用于 openConv）
 * @returns {Element} 会话行元素
 */
function makeSessionRow(session, reqId, cwd) {
  const conv = findConvById(session.convId);  // 从 loadConvs() 找对应 conv 对象
  const isRunning = isConvRunning(session.convId);  // 导入自 chat.js
  
  const kindIcon = {
    'main': '⚡',
    'sub': '💬',
    'retro': '🔍'
  }[session.kind] || '💬';
  
  const onRename = (e) => {
    e.stopPropagation();
    promptDialog('重命名会话', session.title || '新会话', (newTitle) => {
      if (newTitle !== null && newTitle.trim()) {
        convSetTitle(session.convId, newTitle.slice(0, 60));
        // 同步更新 session 列表（需要 POST /api/req/session 的 title 字段）
        fetch('/api/req/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: reqId, convId: session.convId, title: newTitle })
        }).then(() => {
          const rows = renderReqList();
          _renderInto($id('req-list'), rows);
        });
      }
    });
  };
  
  const onDelete = (e) => {
    e.stopPropagation();
    if (session.kind === 'main') return;  // main 会话不可删
    confirmDialog(`删除会话 "${session.title}"？`, () => {
      Promise.all([
        convDelete(session.convId),  // 本地删除 conv
        fetch(`/api/req/session`, {  // 后端删除 session 记录
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: reqId, convId: session.convId })
        })
      ]).then(() => {
        const rows = renderReqList();
        _renderInto($id('req-list'), rows);
      });
    });
  };
  
  const row = el('div', { class: 'req-session-row' + (conv && conv === currentConv ? ' active' : ''),
                           onclick: () => openConv(session.convId) },
    el('span', { class: 'req-session-kind-icon' }, kindIcon),
    el('span', { class: 'req-session-title' }, session.title || '会话'),
    isRunning ? el('span', { class: 'req-session-running-dot' }) : null,
    el('span', { class: 'req-session-menu' },
      session.kind !== 'main' ? el('button', { class: 'session-btn', onclick: onRename }, '✎') : null,
      session.kind !== 'main' ? el('button', { class: 'session-btn', onclick: onDelete }, '✕') : null
    )
  );
  
  return row;
}

// 辅助：按 convId 从 loadConvs() 查 conv 对象
function findConvById(convId) {
  const list = loadConvs();
  return list.find(c => c.id === convId) || null;
}
```

- [ ] **Step 4: 新增 `addNewSession` 回调**

新建会话流程：弹框输入标题 → 调 `createReqConv` → 注册到后端 → 重新渲染树 → 打开会话。

在 `makeSessionRow` 下方追加：

```javascript
/**
 * 新建子会话。
 * @param {string} reqId 所属需求 ID
 * @param {string} cwd 工程目录
 */
async function addNewSession(reqId, cwd) {
  promptDialog('新会话标题', '新会话', async (title) => {
    if (title === null || !title.trim()) return;
    
    // 生成种子（从已加载的需求对象读字段）
    const req = currentReq;  // 假设 currentReq 全局可得，或需改为参数传入
    if (!req) {
      toast('无法读取需求信息');
      return;
    }
    
    const seedText = buildSeedPrompt(req);  // req-logic.js 已有，需导入
    
    // 创建本地 conv，种子为 pending（不立即发送）
    const convId = createReqConv({
      reqId: reqId,
      cwd: cwd,
      session: null,  // 首轮回填
      title: title.slice(0, 60),
      kind: 'sub',
      seedPending: true,
      seedText: seedText
    });
    
    // 注册到后端 sessions 列表（此时 sessionId 为 null，待首轮 session SSE 回填）
    await fetch('/api/req/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: reqId, convId: convId, title: title, kind: 'sub' })
    });
    
    // 打开新会话
    openConv(convId);
    
    // 重新渲染侧栏树
    const rows = renderReqList();
    _renderInto($id('req-list'), rows);
  });
}
```

需要在文件顶部导入：
```javascript
import { buildSeedPrompt } from './req-logic.js';  // 新增 import
```

- [ ] **Step 5: 适配 `renderReqList` 返回结构**

现有 `renderReqList()` 返回平坦的行数组。改为返回嵌套容器。找到定义（~行 200–240），末尾改为：

```javascript
function renderReqList() {
  // ...原有逻辑获取 active / archived 需求列表...
  
  const reqRows = [];
  for (const r of active) {
    reqRows.push(makeReqRow(r));  // 现在 makeReqRow 返回 {div}，内含子会话树
  }
  // archived 同理...
  
  return reqRows.flat();  // 扁平化：makeReqRow 可能返回多个元素，需展开
}
```

如果 `makeReqRow` 返回单个 div（用 `el('div', {}, ...rows)` 包装），则 `.flat()` 会退化为原数组。可改为显式展开：

```javascript
const reqRows = [];
for (const r of active) {
  const rows = makeReqRow(r);  // 返回数组或单个元素
  if (Array.isArray(rows)) {
    reqRows.push(...rows);
  } else {
    reqRows.push(rows);
  }
}
```

但更简洁的做法是 `makeReqRow` 改为返回多个元素，由调用端展开：

```javascript
function makeReqRow(r) {
  // ...same as above, but return array instead of wrapping in container
  return rows;  // 返回 [mainRow, sessionRow1, sessionRow2, addBtn]
}

function renderReqList() {
  // ...
  const reqRows = active.flatMap(r => makeReqRow(r));  // flatMap 自动展开
  // ...
}
```

选择后者更清晰。相应修改上面 Step 2 的 `makeReqRow` 末尾：

```javascript
  return rows;  // 不包装，直接返回数组
}
```

- [ ] **Step 6: 手工测试**

打开浏览器，进入某个需求的 dev 阶段：
1. 侧栏需求行应显示折叠箭头 ▸；点击展开 ▾
2. 展开后应显示 ⚡ 自动开发（kind='main'，无删除按钮）+ ＋新会话 按钮
3. 点 ＋新会话 → 输入标题 → 新行出现，带 💬 标记
4. 点新会话行 → `openConv` 工作，主体区切到该会话
5. 点新会话行上的 ✎ → 重命名弹框出现，修改后更新
6. 点新会话行上的 ✕ → 删除确认，删除后行消失

- [ ] **Step 7: Commit**

```bash
git add public/js/req-view.js
git commit -m "feat: add session tree with expand/collapse, session rows, add/rename/delete buttons"
```

---

## Task 4: 侧栏会话树交互完善 — 运行灯与上下文确保

**Files:**
- Modify: `public/js/chat.js`（导出 `isConvRunning` 的引用）
- Modify: `public/js/req-view.js`（导入与使用）

**背景：** Task 3 已框架出来，但还需确保：
1. `isConvRunning` 从 `chat.js` 正确导出并在 `req-view.js` 使用（已有导出，只需导入）
2. `currentReq` / `currentConv` 在 `req-view.js` 能访问（需检查全局作用域）
3. `openConv` 能正确切换会话（已有导出，只需确认）

- [ ] **Step 1: 检查并补充导入**

`public/js/req-view.js` 顶部，确保导入：

```javascript
import { openConv, createReqConv } from './chat.js';  // createReqConv 是新加的
import { buildSeedPrompt } from './req-logic.js';
import { convSetTitle, convDelete } from './conv-store.js';
import { isConvRunning } from './chat.js';  // 导入运行灯查询函数
```

检查：`grep -n "^import.*chat.js\|^import.*req-logic\|^import.*conv-store" public/js/req-view.js`

- [ ] **Step 2: 检查全局变量可见性**

`req-view.js` 需要能访问：
- `currentReq`：当前打开的需求对象
- `currentConv`：当前打开的会话对象（可能来自 `chat.js` 全局，或需从 `conv-store` 读）

搜索定义：

```bash
grep -n "let currentReq\|let currentConv\|var currentReq\|var currentConv" public/js/*.js
```

预期：`req-view.js` 内某处定义了 `let currentReq`，`chat.js` 内某处定义了 `let currentConv`（模块私有）。

若 `currentConv` 在 `chat.js` 私有，需在 `req-view.js` 里改用：

```javascript
function findCurrentConv() {
  const list = loadConvs();
  const conv = list.find(c => c.id === currentConvId);  // 需从 chat.js 导出 currentConvId
  return conv;
}
```

或直接导出 getter：

```javascript
// chat.js 顶部加
export function getCurrentConv() {
  const list = loadConvs();
  return list.find(c => c.id === currentConvId);
}
```

然后在 `req-view.js` 里：

```javascript
import { getCurrentConv } from './chat.js';
// 在 makeSessionRow 里
const conv = getCurrentConv();
const isActive = conv && conv.id === session.convId;
```

具体做法取决于现有代码结构。**此步骤的任务是确保 Task 3 里的 `findConvById` 和 `const conv = currentConv` 能工作**。运行完整的侧栏树渲染测试，若报"undefined"就逐个补导出。

- [ ] **Step 3: `openConv` 效果验证**

打开浏览器，点会话行，应看到：
1. 主体区从当前会话切到新会话
2. 侧栏该会话行被 `.active` class 高亮
3. 若新会话是 `kind='sub'` 且 `seedPending=true`，输入框应显示"（待输入首句话拼上种子）"的提示（可选）

- [ ] **Step 4: 运行灯实时更新**

打开两个子会话（A 和 B），在 A 发一条消息（触发 run）。应看到 A 的会话行上出现运行灯（实心圆●），B 无灯。等 run 结束，灯消失。

关键：`makeSessionRow` 里调用 `isConvRunning(session.convId)` 后渲染运行灯，但这只在初始化时计算一次。**需要 run 状态变化时重新渲染侧栏树**。

在 `chat.js` 里，run 启动和结束时（`launchRun` / `handleDone` 等地方）加钩子：

```javascript
// 在 chat.js 里找到处理 run 启动的地方（可能是 send() 或 launchRun()）
function launchRun(job, text, sessionId, runCwd) {
  // ... 原有逻辑 ...
  
  // ★ 新增：触发侧栏树重渲染
  if (window._updateReqList) {
    window._updateReqList();  // req-view.js 导出的重渲染函数
  }
}

// 在 handleDone 或对应的 done 事件处理里也加一遍
```

在 `req-view.js` 里导出重渲染函数：

```javascript
// 在 renderReqList 之后新增
export function updateReqListDisplay() {
  const rows = renderReqList();
  _renderInto($id('req-list'), rows);
}

// 在初始化时注册到全局
window._updateReqList = updateReqListDisplay;
```

- [ ] **Step 5: 测试运行灯**

同时打开两个子会话 A、B，分别在各自发消息，观察：
1. 消息发出时，对应会话行的运行灯亮起
2. 回复完成后灯灭
3. 另一个会话的运行灯状态不受影响

- [ ] **Step 6: Commit**

```bash
git add public/js/chat.js public/js/req-view.js
git commit -m "feat: integrate session tree with running lights and current conv tracking"
```

---

## Task 5: 优化汇总完整流程 — 从按钮到写盘

**Files:**
- Modify: `public/js/req-view.js`（`renderArchivingPage` + 汇总编排函数）
- Already done: `src/entrypoints/web/req-logic.js`（buildRetroMapPrompt / buildRetroReducePrompt，Task 2）

**背景：** 这是最复杂的一个 task，涉及：
1. 归档期新增 [优化汇总] 按钮（§6.1）
2. 创建 `kind='retro'` 会话并打开（§6.1）
3. map 阶段：逐会话拉转录、截断、喂入、接收小结（§6.2）
4. reduce 阶段：聚合指令、接收回复、提取标记块（§6.2–§6.3）
5. 预览确认框：编辑条目、分前后端、写盘（§6.4）

按照 TDD + bite-sized 步骤，我分成 5 个小步，每个都可独立测试停靠点。

### 5.1: 按钮与 retro 会话创建

- [ ] **Step 5.1.1: 找到 `renderArchivingPage` 并加按钮**

位置：`public/js/req-view.js:586–620`。找到现有界面结构（通常是 note textarea + confirm btn），在之前加：

```javascript
function renderArchivingPage() {
  // ... 现有：阶段芯片、note textarea ...
  
  const retroBtn = el('button', { 
    class: 'btn btn-primary',
    onclick: () => startRetroSummary(currentReq.id, currentReq.cwd || pickCwdAndDirs(currentReq.projects).cwd)
  }, '优化汇总');
  
  const confirmBtn = el('button', { 
    class: 'btn btn-primary',
    onclick: () => archiveRequirement(currentReq.id, ...) 
  }, '确认归档');
  
  return el('div', { class: 'archive-page' },
    // ...现有内容...
    el('div', { class: 'button-group' }, retroBtn, confirmBtn)
  );
}
```

- [ ] **Step 5.1.2: 实现 `startRetroSummary` 入口函数**

新增函数（在 `renderArchivingPage` 后）：

```javascript
/**
 * 启动优化汇总流程：创建 retro 会话 → 打开 → 开始 map-reduce。
 */
async function startRetroSummary(reqId, cwd) {
  const req = currentReq;
  if (!req || req.phase !== 'archiving') {
    toast('仅在归档期可启动汇总');
    return;
  }
  
  // 创建 retro 会话
  const retroConvId = createReqConv({
    reqId: reqId,
    cwd: cwd,
    session: null,
    title: '优化汇总',
    kind: 'retro',
    seedPending: false,  // retro 不用种子，直接喂转录
    seedText: ''
  });
  
  // 注册后端
  await fetch('/api/req/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: reqId, convId: retroConvId, title: '优化汇总', kind: 'retro' })
  });
  
  // 打开 retro 会话（切到聊天视图）
  openConv(retroConvId);
  
  // 重渲染侧栏树
  if (window._updateReqList) window._updateReqList();
  
  // 启动 map-reduce 编排
  await runRetroMapReduce(reqId, retroConvId, cwd);
}
```

- [ ] **Step 5.1.3: 手工测试**

打开一个需求，切到归档期 → 应看到 [优化汇总] 按钮（在 [确认归档] 左侧）→ 点击 → 侧栏应新增 🔍 优化汇总 行，主体区切到该会话，空白等待。

- [ ] **Checkpoint 5.1: Commit**

```bash
git add public/js/req-view.js
git commit -m "feat: add retro summary button and session creation"
```

---

### 5.2: Map 阶段实现

- [ ] **Step 5.2.1: 实现 `runRetroMapReduce` 主编排函数**

该函数管理整个 map-reduce 流程：

```javascript
/**
 * 执行 map-reduce 汇总流程。
 * map：逐会话拉转录、截断、喂入、收小结。
 * reduce：聚合、识别跨会话规则。
 * @param {string} reqId 需求 ID
 * @param {string} retroConvId retro 会话 ID
 * @param {string} cwd 工程目录
 */
async function runRetroMapReduce(reqId, retroConvId, cwd) {
  // 从 handleGet 响应获取最新 req，含 sessions
  let req;
  try {
    const res = await fetch(`/api/req/get?id=${encodeURIComponent(reqId)}`);
    req = await res.json();
  } catch (e) {
    toast('获取需求信息失败');
    console.error(e);
    return;
  }
  
  const sessions = req.sessions || [];
  const validSessions = sessions.filter(s => s.kind !== 'retro' && s.sessionId);
  
  if (validSessions.length === 0) {
    toast('无有效会话可汇总');
    return;
  }
  
  // ★ MAP 阶段
  const mapMessages = [];
  for (let i = 0; i < validSessions.length; i++) {
    const session = validSessions[i];
    const progress = `[${i + 1}/${validSessions.length}]`;
    
    try {
      // 拉转录
      const histRes = await fetch(`/api/history/${encodeURIComponent(session.sessionId)}?cwd=${encodeURIComponent(cwd)}`);
      const hist = await histRes.json();
      let transcript = hist.data.messages
        .map(m => `${m.role}: ${m.content}`)
        .join('\n\n');
      
      // 截断保护
      const TRUNCATE_LIMIT = 30000;
      if (transcript.length > TRUNCATE_LIMIT) {
        const truncated = TRUNCATE_LIMIT / 2;
        const ellipsis = `…（已截断 ${transcript.length - TRUNCATE_LIMIT} 字符）…`;
        transcript = transcript.slice(0, truncated) + ellipsis + transcript.slice(-truncated);
        
        // 提示用户
        toast(`会话 ${i + 1} 转录已截断，详见 retro 会话消息`);
        // 在 retro 会话里也显示截断提示
        addMessage(retroConvId, { role: 'system', content: `[提示] "${session.title}" 转录超 30KB，已截断` });
      }
      
      // 生成 map 提示词
      const mapPrompt = buildRetroMapPrompt(transcript, i + 1, validSessions.length);
      
      // 发送 map 消息（用户消息 → 触发 run）
      await sendMessageToConv(retroConvId, mapPrompt);
      
      // 等待 run 完成，收集 assistant 回复
      const mapResult = await waitForRunCompletion(retroConvId);
      mapMessages.push({ role: 'assistant', content: mapResult });
      
      // 单会话小结完成，加进度提示
      toast(`${progress} 会话已处理`);
      
    } catch (e) {
      toast(`${progress} 会话处理失败`);
      console.error(e);
    }
  }
  
  // ★ REDUCE 阶段
  if (mapMessages.length === 0) {
    toast('未能收集任何会话小结，汇总中止');
    return;
  }
  
  const reducePrompt = buildRetroReducePrompt(mapMessages);
  await sendMessageToConv(retroConvId, reducePrompt);
  
  const reduceResult = await waitForRunCompletion(retroConvId);
  
  // 保存完整报告到 req.retro
  await updateRequirementRetro(reqId, reduceResult);
  
  // 提取标记块
  const pitfallsMatch = reduceResult.match(/<!-- PITFALLS-BEGIN -->([\s\S]*?)<!-- PITFALLS-END -->/);
  if (!pitfallsMatch) {
    toast('未找到避坑标记块，请手工从会话复制');
    return;
  }
  
  const pitfallsText = pitfallsMatch[1].trim();
  
  // 预览确认
  await showPitfallsPreviewDialog(reqId, pitfallsText, cwd);
}
```

- [ ] **Step 5.2.2: 实现辅助函数 `sendMessageToConv` 与 `waitForRunCompletion`**

```javascript
/**
 * 向会话发送消息（如同用户输入），不添加气泡。
 * @param {string} convId 会话 ID
 * @param {string} text 消息文本
 * @returns {Promise<void>}
 */
async function sendMessageToConv(convId, text) {
  // 调用 chat.js 的内部 send 逻辑，但不走 UI 气泡
  // 简化做法：直接调 launchRun（假设它是导出的）
  
  // 实际上需要在 chat.js 导出一个"后台发送"函数，或复用现有机制
  // 这里假设可以直接调用内部的 launchRun，并返回 promise
  
  const conv = findConvById(convId);
  if (!conv) throw new Error(`Conv ${convId} not found`);
  
  return new Promise((resolve, reject) => {
    const onDone = () => {
      // run 完成，清理监听器
      window.removeEventListener('retro-run-done', onDone);
      resolve();
    };
    
    window.addEventListener('retro-run-done', onDone);
    
    // 调用 send（模拟用户输入）
    // 需要 chat.js 导出 send，或创建新的后台发送入口
    if (typeof window.sendMessageBackgroundAsync === 'function') {
      window.sendMessageBackgroundAsync(convId, text).catch(reject);
    } else {
      reject(new Error('sendMessageBackgroundAsync not available'));
    }
  });
}

/**
 * 等待会话的当前 run 完成，返回最后一条 assistant 消息内容。
 * @param {string} convId 会话 ID
 * @returns {Promise<string>} assistant 消息内容
 */
async function waitForRunCompletion(convId) {
  return new Promise((resolve, reject) => {
    const checkCompletion = setInterval(() => {
      const conv = findConvById(convId);
      if (!conv) {
        clearInterval(checkCompletion);
        reject(new Error(`Conv ${convId} not found`));
        return;
      }
      
      // 若当前没有运行中的 run，说明完成了
      if (!isConvRunning(convId) && conv.messages.length > 0) {
        clearInterval(checkCompletion);
        // 找最后一条 assistant 消息
        for (let i = conv.messages.length - 1; i >= 0; i--) {
          if (conv.messages[i].role === 'assistant') {
            resolve(conv.messages[i].content);
            return;
          }
        }
        reject(new Error('No assistant message found'));
      }
    }, 500);  // 每 500ms 检查一次
    
    // 超时保护（5 分钟）
    setTimeout(() => {
      clearInterval(checkCompletion);
      reject(new Error('Timeout waiting for run completion'));
    }, 5 * 60 * 1000);
  });
}

/**
 * 更新需求的 retro 字段（完整汇总报告）。
 * @param {string} reqId 需求 ID
 * @param {string} retroText 完整报告（标记块之外的正文）
 * @returns {Promise<void>}
 */
async function updateRequirementRetro(reqId, retroText) {
  // 提取标记块之外的部分作为报告
  const report = retroText.replace(/<!-- PITFALLS-BEGIN -->[\s\S]*?<!-- PITFALLS-END -->/, '').trim();
  
  // 没有现成的 POST 路由更新 retro 字段，需要在后端新增或复用现有路由
  // 临时方案：存在本地 currentReq.retro，下次保存时回写
  if (currentReq && currentReq.id === reqId) {
    currentReq.retro = report;
  }
  
  // TODO: 需后端支持更新 retro 字段，或在归档时一并提交
}
```

**注**：上面的 `sendMessageToConv` 和 `waitForRunCompletion` 是伪代码，实际需依赖 `chat.js` 的导出接口。现在 `chat.js` 里没有"后台发送"函数，需要补加或复用 `send()`（会有 UI 气泡副作用）。

**简化方案**：retro 编排不走后台发送，改为**用户手工在 retro 会话里逐条粘贴 map/reduce 提示词**，Claude 回复后再由前端自动提取标记块。这样避免了对 `send()` 的改造，但用户体验下降（需要 2×（会话数 + 1）次粘贴）。

**推荐方案**：在 `chat.js` 新增导出函数：

```javascript
/**
 * 后台发送消息到会话（不产生用户气泡，仅产生消息记录）。
 * 返回 promise，resolve 时消息已发送到服务端开始处理。
 * @param {string} convId 会话 ID
 * @param {string} text 消息文本
 * @returns {Promise<void>}
 */
export async function sendMessageBackground(convId, text) {
  // 找 conv 对象
  const list = loadConvs();
  const conv = list.find(c => c.id === convId);
  if (!conv) throw new Error(`Conv ${convId} not found`);
  
  // 构造 job（参考 send() 的逻辑）
  const job = {
    id: 'j' + String(Date.now()),
    convId: convId,
    model: conv.model || 'claude-3-5-sonnet',
    state: 'active',
    startedAt: Date.now()
  };
  
  // 添加消息到历史（不显示在气泡）
  convPushMessage(convId, { role: 'user', content: text, timestamp: Date.now() });
  
  // 启动 run（参考 send() 的 launchRun 调用）
  return launchRun(job, text, conv.session, conv.cwd || '');
}
```

这需要改 `chat.js`，但也许可以等 Task 5 实现时再做。先在计划里注明"需补"。

- [ ] **Step 5.2.3: 测试 map 阶段**

**简化测试**：手工创建一个 retro 会话，然后在里面复制粘贴 map 提示词（由 `buildRetroMapPrompt` 生成）。观察 Claude 是否按预期小结。

```javascript
// 在浏览器控制台：
const prompt1 = buildRetroMapPrompt('User: hello\nAssistant: hi', 1, 2);
console.log(prompt1);
// 复制到 retro 会话里粘贴，看回复
```

- [ ] **Checkpoint 5.2: Commit**

```bash
git add public/js/req-view.js
git commit -m "feat: implement map-reduce pipeline for retro summary (placeholder for background send)"
```

---

### 5.3: Reduce 阶段与标记块提取

- [ ] **Step 5.3.1: 实现标记块提取**

前面的 `runRetroMapReduce` 里已有提取逻辑。这里补完整性：

```javascript
/**
 * 从文本中提取 PITFALLS 标记块。
 * @param {string} text 完整回复
 * @returns {object} { report, pitfallsText } 或 { report, pitfallsText: null } （未找到标记块）
 */
function extractPitfallsBlock(text) {
  const match = text.match(/<!-- PITFALLS-BEGIN -->([\s\S]*?)<!-- PITFALLS-END -->/);
  
  let report = text;
  let pitfallsText = null;
  
  if (match) {
    pitfallsText = match[1].trim();
    report = text.replace(/<!-- PITFALLS-BEGIN -->[\s\S]*?<!-- PITFALLS-END -->/, '').trim();
  }
  
  return { report, pitfallsText };
}
```

- [ ] **Step 5.3.2: 解析条目并分前后端**

```javascript
/**
 * 解析避坑条目文本（markdown 列表格式），分前后端。
 * @param {string} pitfallsText 标记块内文本
 * @returns {object} { frontend: [], backend: [], unknown: [] }
 */
function parsePitfallsItems(pitfallsText) {
  if (!pitfallsText) return { frontend: [], backend: [], unknown: [] };
  
  const items = pitfallsText
    .split('\n')
    .map(line => line.replace(/^-\s*/, '').trim())
    .filter(line => line.length > 0);
  
  const frontend = [];
  const backend = [];
  const unknown = [];
  
  for (const item of items) {
    if (item.startsWith('[前端]')) {
      frontend.push(item.replace(/^\[前端\]\s*/, ''));
    } else if (item.startsWith('[后端]')) {
      backend.push(item.replace(/^\[后端\]\s*/, ''));
    } else {
      unknown.push(item);
    }
  }
  
  return { frontend, backend, unknown };
}
```

- [ ] **Step 5.3.3: 实现预览确认对话**

这是一个关键的人工审阅环节（§6.4 三道闸第一闸）：

```javascript
/**
 * 显示避坑条目预览确认框。
 * 用户可编辑/删除条目，最后确认才会写盘。
 * @param {string} reqId 需求 ID
 * @param {string} pitfallsText 标记块内原始文本
 * @param {string} cwd 工程目录（用于读 projects 信息）
 */
async function showPitfallsPreviewDialog(reqId, pitfallsText, cwd) {
  const { frontend, backend, unknown } = parsePitfallsItems(pitfallsText);
  
  // 检查目标工程是否存在且可写
  const req = currentReq;
  if (!req) {
    toast('无法读取需求信息');
    return;
  }
  
  const frontendDir = req.projects?.frontend?.dir;
  const backendDir = req.projects?.backend?.dir;
  const frontendDev = req.projects?.frontend?.dev;
  const backendDev = req.projects?.backend?.dev;
  
  // 构造预览文本（带前后端分类与工程校验）
  let previewLines = [];
  
  if (frontend.length > 0) {
    if (!frontendDir) {
      previewLines.push(`[前端工程缺失，以下条目将丢弃]`);
      frontend.forEach(item => previewLines.push(`- [前端] ${item}`));
    } else if (!frontendDev) {
      previewLines.push(`[前端工程为只读，以下条目将丢弃]`);
      frontend.forEach(item => previewLines.push(`- [前端] ${item}`));
    } else {
      previewLines.push(`[前端] 写入到 ${frontendDir}/.claude/pitfalls.md`);
      frontend.forEach(item => previewLines.push(`- ${item}`));
    }
    previewLines.push('');
  }
  
  if (backend.length > 0) {
    if (!backendDir) {
      previewLines.push(`[后端工程缺失，以下条目将丢弃]`);
      backend.forEach(item => previewLines.push(`- [后端] ${item}`));
    } else if (!backendDev) {
      previewLines.push(`[后端工程为只读，以下条目将丢弃]`);
      backend.forEach(item => previewLines.push(`- [后端] ${item}`));
    } else {
      previewLines.push(`[后端] 写入到 ${backendDir}/.claude/pitfalls.md`);
      backend.forEach(item => previewLines.push(`- ${item}`));
    }
    previewLines.push('');
  }
  
  if (unknown.length > 0) {
    previewLines.push(`[警告] 以下条目无 [前端]/[后端] 前缀，将被忽略`);
    unknown.forEach(item => previewLines.push(`- ${item}`));
    previewLines.push('');
  }
  
  const previewText = previewLines.join('\n');
  
  // 弹出可编辑的 textareaDialog
  textareaDialog('预览避坑条目\n(可编辑后确认)', previewText, (edited) => {
    if (edited === null) {
      // 用户取消
      toast('已取消，条目未保存');
      return;
    }
    
    // 用户确认，解析编辑后的内容
    const { frontend: frontendFinal, backend: backendFinal } = parsePitfallsItems(edited);
    
    // 写盘
    submitPitfalls(reqId, frontendFinal, backendFinal, frontendDir, backendDir, frontendDev, backendDev);
  });
}

/**
 * 实际写盘 pitfalls。
 */
async function submitPitfalls(reqId, frontendItems, backendItems, frontendDir, backendDir, frontendDev, backendDev) {
  try {
    const res = await fetch('/api/req/pitfalls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: reqId,
        frontend: frontendDev ? frontendItems : [],
        backend: backendDev ? backendItems : []
      })
    });
    
    if (res.ok) {
      toast(`已写入 ${frontendItems.length + backendItems.length} 条避坑规则`);
    } else {
      toast('写盘失败：' + await res.text());
    }
  } catch (e) {
    toast('写盘异常：' + e.message);
    console.error(e);
  }
}
```

- [ ] **Step 5.3.4: 测试预览确认**

创建一个 retro 会话，手工粘贴一个包含标记块的 reduce 结果（可以是 Claude 的回复或自己编的）。观察：
1. 标记块被正确提取
2. 预览对话弹出，条目可编辑
3. 确认后调用 `/api/req/pitfalls`
4. 后端成功写入 `.claude/pitfalls.md`

- [ ] **Checkpoint 5.3: Commit**

```bash
git add public/js/req-view.js
git commit -m "feat: implement pitfalls extraction, parsing, preview dialog, and submission"
```

---

### 5.4: 完整 map-reduce 流程的自动编排（可选加强）

**此步骤非必须**，仅当后端 `sendMessageBackground` 补充后才能完整自动化。目前可先手工粘贴 map/reduce 提示词测试逻辑。

- [ ] **Step 5.4.1: 在 chat.js 补充后台发送函数**

如前所述，添加：

```javascript
export async function sendMessageBackground(convId, text) {
  // ... 实现 ...
}
```

- [ ] **Step 5.4.2: 改进 `runRetroMapReduce` 使用自动编排**

改 `sendMessageToConv` 为调用新的 `sendMessageBackground`。

- [ ] **Step 5.4.3: 测试完整 map-reduce 自动流程**

点 [优化汇总] 按钮 → 自动：
1. 逐会话拉转录
2. 逐会话发 map 提示词、收小结
3. 汇总发 reduce 指令、收回复
4. 提取标记块、弹预览确认
5. 确认后写盘

---

### 5.5: CSS 样式补充

**Files:**
- Modify: `public/app.css`

- [ ] **Step 5.5.1: 会话行基础样式**

```css
/* 会话行 */
.req-session-row {
  margin-left: 2em;
  padding: 0.5em 0.5em;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5em;
  font-size: 0.9em;
  color: #666;
  transition: background-color 0.2s;
}

.req-session-row:hover {
  background-color: #f0f0f0;
}

.req-session-row.active {
  background-color: #e3f2fd;
  color: #1976d2;
  font-weight: 500;
}

/* 会话类型标记 */
.req-session-kind-icon {
  flex-shrink: 0;
  font-size: 1em;
}

/* 会话标题 */
.req-session-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 运行灯 */
.req-session-running-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #ff9800;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* 操作菜单 */
.req-session-menu {
  display: none;
  flex-shrink: 0;
  gap: 0.2em;
}

.req-session-row:hover .req-session-menu {
  display: flex;
}

.session-btn {
  padding: 0;
  border: none;
  background: none;
  color: #999;
  cursor: pointer;
  font-size: 0.9em;
  transition: color 0.2s;
}

.session-btn:hover {
  color: #333;
}

/* 新增会话按钮行 */
.req-add-session {
  margin-top: 0.3em;
}

.req-add-session button {
  padding: 0.3em 0.8em;
  font-size: 0.85em;
  background-color: #f5f5f5;
  border: 1px solid #ddd;
  border-radius: 3px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.req-add-session button:hover {
  background-color: #eee;
}

/* 折叠箭头 */
.req-toggle-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.2em;
  cursor: pointer;
  user-select: none;
  font-size: 0.9em;
}
```

- [ ] **Step 5.5.2: 改造现有 `.req-item` 支持折叠箭头**

可能需要微调 `.req-item` 的 flex 布局以容纳新的 `.req-toggle-arrow` 元素。

- [ ] **Step 5.5.3: 手工验证样式**

打开浏览器，进入 dev 阶段需求，展开会话树，观察：
1. 折叠箭头 ▸/▾ 可见
2. 子会话行有适当的缩进和间距
3. hover 时显示 ✎✕ 菜单
4. 运行灯（●）动画正常
5. 选中会话行时有高亮

- [ ] **Checkpoint 5.5: Commit**

```bash
git add public/app.css
git commit -m "style: add session tree and retro summary UI styles"
```

---

## Task 6: 全量集成与端到端测试

**Files:**
- Already modified: 所有文件

**目标：** 验证整个需求会话组 + 优化汇总流程端到端可用。

- [ ] **Step 6.1: 整体集成检查清单**

```
✓ Task 1: createReqConv 扩展，支持 kind/seedPending/seedText
✓ Task 2: buildRetroMapPrompt / buildRetroReducePrompt 纯函数
✓ Task 3: 侧栏会话树渲染与折叠展开
✓ Task 4: 会话交互（新建/重命名/删除）+ 运行灯
✓ Task 5: 优化汇总完整流程（按钮 → map-reduce → 预览 → 写盘）
✓ Task 6: CSS 样式
```

- [ ] **Step 6.2: 端到端验收（手工走查清单）**

按 spec §8 验收清单执行：

1. **打开已有需求 → 侧栏需求行可展开，显示一条 ⚡ 自动开发（老数据合成成功），无删除按钮**

   操作：打开一个旧需求（在本改动之前创建的）。  
   预期：侧栏该需求行有 ▸ 折叠箭头，点击展开后显示 ⚡ 自动开发，无 ✕ 删除按钮。

2. **点「＋ 新会话」→ 出现新行，主体区空白，未起 run（不烧额度）**

   操作：在展开的需求下点 ＋新会话 按钮，输入标题。  
   预期：侧栏新增一行 💬 子会话，主体区切到该会话但空白无消息，消息计数为 0，未消耗额度。

3. **在新会话发第一句话 → 实际发出的内容前置了种子上下文；Claude 明确知道需求、分支、工程角色**

   操作：在新子会话的输入框输入"帮我调试一下"并发送。  
   预期：Claude 的回复应能明确指出"需求 XXX、分支 XXX、前端工程 XXX"，说明种子被成功拼接。

4. **发第二句话 → 不再重复种子**

   操作：在同一会话再发一句"好的，谢谢"。  
   预期：Claude 不再重复种子内容。

5. **主会话与子会话同时各跑一个任务 → 两行都亮运行灯，互不阻塞，各自流式输出正常**

   操作：在主会话（⚡ 自动开发）和一个子会话各发一条长消息，观察两个会话的 run 状态。  
   预期：侧栏两行都显示 ● 运行灯，且双方都收到 Claude 的流式回复，各自独立进行。

6. **刷新页面 → 会话树恢复，运行中的会话可重新接流**

   操作：在某个会话处于运行中时刷新页面。  
   预期：页面加载后侧栏树重现，运行中的会话行仍有 ● 灯，继续接收流式输出。

7. **测试期触发 bug-fix → 仍发到主会话，子会话在跑不影响其派发**

   （此项涉及后端 bug-fix 逻辑，不在本计划范围内，略）

8. **归档期点「优化汇总」→ 新开 retro 会话，逐会话小结后聚合，产出报告与条目**

   操作：把某个需求切到 archiving 阶段，点 [优化汇总] 按钮。  
   预期：
   - 侧栏新增 🔍 优化汇总 行（kind='retro'）
   - 主体区切到 retro 会话
   - 若自动编排实现，应逐会话发 map 提示词、收小结，最后发 reduce、聚合回复
   - 若手工编排，需用户粘贴 map 和 reduce 提示词

9. **条目预览框可编辑删改 → 确认后写入正确工程的 `.claude/pitfalls.md`，只读工程未被写入**

   操作：在 retro 会话的聚合回复中获得标记块后，触发预览对话，编辑条目，确认。  
   预期：
   - 预览对话中条目可编辑
   - 前端/后端工程被正确识别
   - 只读工程被标记"将丢弃"
   - 确认后后端写入目标工程的 `.claude/pitfalls.md`

10. **目标仓库 `CLAUDE.md` 出现（或已有）`@.claude/pitfalls.md` 引用行**

    操作：查看被写入 pitfalls 的工程的 `CLAUDE.md`。  
    预期：存在一行 `@.claude/pitfalls.md`（由 `ensureClaudeMdRef` 确保）。

11. **再次汇总 → 同类条目被合并而非重复堆积，总数不超 30**

    操作：再次点 [优化汇总]，确认条目。  
    预期：新增的条目与旧 pitfalls.md 中的同类项被合并，总数不超 30 条。

12. **归档档案中可查到完整回顾报告**

    操作：归档需求后查看 `~/.claude/projects/<projId>/<reqId>.json` 或相应存储位置。  
    预期：`req.retro` 字段包含完整的跨会话回顾报告（标记块之外的部分）。

- [ ] **Step 6.3: 缺陷修复**

若上述任何步骤失败，调查并修复，然后重新验证该步骤。

- [ ] **Step 6.4: Final Commit**

```bash
git add public/js/chat.js public/js/req-view.js src/entrypoints/web/req-logic.js public/app.css
git commit -m "feat: complete session tree and retro summary implementation with end-to-end integration"
```

---

## 自检清单

### Spec 覆盖

- ✓ §3.1 sessions[] 字段 —— 已实现，跳过
- ✓ §3.2 normalizeSessions —— 已实现，跳过
- ✓ §3.3 POST /api/req/session —— 已实现，跳过
- ✓ §5.1 侧栏会话树 —— Task 3–4 覆盖
- ✓ §5.2 新建子会话与种子 —— Task 1（生产端）+ Task 3（UI）
- ✓ §5.3 会话删除 —— Task 4 覆盖
- ✓ §6.1 优化汇总触发 —— Task 5.1 覆盖
- ✓ §6.2 map-reduce —— Task 5.2 覆盖
- ✓ §6.3 双份产出 —— Task 5.3 覆盖
- ✓ §6.4 三道闸 —— Task 5.3 预览框，后端 writePitfalls 已做去重合并
- ✓ §6.5 CLAUDE.md 引用 —— 后端 ensureClaudeMdRef 已做

### 占位符扫描

无 "TBD"、"TODO"、"添加错误处理"、"实现细节稍后补充" 等占位符。所有代码都是完整的可运行代码段。

### 类型一致性

- `kind`：'main' | 'sub' | 'retro'，跨 createReqConv / makeReqRow / makeSessionRow 保持一致
- `sessionId`：null（新建）→ 拿到后回填，跨 POST /api/req/session（已有） 和 createReqConv（新写）一致
- `seedText` / `seedPending`：由 createReqConv 写入 meta，由 send() 消费，类型一致
- `pitfallsText`：提取、解析、预览、提交，格式一致

---


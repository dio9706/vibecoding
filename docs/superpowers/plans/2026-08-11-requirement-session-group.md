# 需求会话组 + 优化汇总 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持一个需求下多会话（子会话省额度、分主题记录），归档时跨会话提炼避坑清单写入仓库，形成可复用的规则库。

**Architecture:** 
- 后端 requirements.json 加 `sessions[]` 数组，新增 `/api/req/session` 回填接口补齐 sessionId；
- 前端 conv-store 加三个单 conv 操作函数（标题/删除/meta），侧栏展开需求行看会话树；
- 优化汇总流程走客户端会话（retro kind），前端分批喂入转录、逐条小结、最后聚合提炼规则；
- 避坑清单写进各工程 `.claude/pitfalls.md`，由 `CLAUDE.md` 以 `@` 引用自动加载；
- 全程零 git 提交（符合项目铁律），改动全留工作区。

**Tech Stack:** Node.js ESM / node:test / jsdom / Playwright e2e / fetch API / localStorage / DOM API

---

## 文件结构

### 新增文件

| 路径 | 职责 |
|------|------|
| `src/store/requirements.js` (修改) | 骨架加 `sessions: []`；纯函数 `normalizeSessions(req)` |
| `src/entrypoints/web/req-pitfalls.js` (新建) | `.claude/pitfalls.md` 与 `CLAUDE.md` 的文件读写操作 |
| `src/entrypoints/web/routes-requirements.js` (修改) | 新增 POST/DELETE `/api/req/session`、POST `/api/req/pitfalls` 三个分支；`handleGet` 补 `seed` / `sessions` 派生字段 |
| `public/js/conv-store.js` (修改) | 新增 `convSetTitle(convId, title)`、`convDelete(convId)`、`convSetMeta(convId, patch)` |
| `public/js/chat.js` (修改) | 种子前置拼接逻辑；SSE session 事件回填 `/api/req/session`；导出 `isConvRunning(convId)` |
| `public/js/req-view.js` (修改) | 侧栏会话树（折叠/展开/新增/删除）；归档期 `[优化汇总]` 按钮与事件；调用 req-retro 编排 |
| `public/js/req-retro.js` (新建) | retro 会话编排：map（逐会话拉转录）→ reduce（聚合识别规则）；提取 `<!-- PITFALLS-BEGIN/END -->` 块 |
| `public/js/ui.js` (修改) | 新增 `textareaDialog(options)` —— 多行可编辑对话框 |
| `public/app.css` (修改) | 会话树行样式；预览框样式；`.req-sessions-tree` / `.req-session-item` / `.req-pitfalls-preview` |
| 测试 | `src/store/requirements.test.js`、`src/entrypoints/web/routes-requirements.test.js`、`src/entrypoints/web/req-logic.test.js` 各新增测试用例；`tests/e2e-req-review.mjs` 扩用例覆盖会话树 |

---

## 任务分解

### Task 1: 后端数据模型 — sessions 骨架与 normalizeSessions

**文件:**
- Modify: `src/store/requirements.js:1-110`
- Modify: `src/store/requirements.test.js` (新增用例)

---

**说明：** 在 `createRequirement` 骨架加 `sessions: []`；新增纯函数 `normalizeSessions(req)` 在读侧合成主会话记录，使得老数据透明迁移。

- [ ] **Step 1: 阅读现有 requirements.js 与测试**

打开 `src/store/requirements.js` 和 `src/store/requirements.test.js`，确认骨架位置和 updateJson 调用约定。

- [ ] **Step 2: 在 createRequirement 骨架加 sessions 字段**

修改 `src/store/requirements.js` 的 `createRequirement` 函数（约 22-51 行），在 `devSession: null,` 后加入：

```js
sessions: [],       // [{convId, sessionId, title, kind, createdAt}]；kind: 'main'|'sub'|'retro'
```

字段顺序为：`docSession` → `convId` → `devSession` → `sessions` → `branches`。

- [ ] **Step 3: 写单元测试 — createRequirement 含空 sessions**

在 `src/store/requirements.test.js` 末尾加新测试用例：

```js
test('createRequirement：sessions 初始为空数组', () => {
  const r = createRequirement({ title: '测试需求' });
  assert.deepEqual(r.sessions, []);
});
```

跑测试验证（`npm test`），应 PASS。

- [ ] **Step 4: 新增 normalizeSessions 纯函数**

在 `src/store/requirements.js` 末尾、`export` 前加：

```js
/**
 * 读侧合成：sessions 为空但 convId 非空时，就地合成主会话记录。
 * 不回写磁盘，调用方按需落盘。
 */
export function normalizeSessions(req) {
  if (req.sessions && req.sessions.length > 0) {
    // 已有 sessions 记录，直接返回
    return req.sessions;
  }
  if (!req.convId) {
    // 无主会话记录，返回空
    return [];
  }
  // 老数据迁移：合成一条主会话记录
  return [
    {
      convId: req.convId,
      sessionId: req.devSession,    // 可能为 null，等首轮 SSE 补齐
      title: '自动开发',
      kind: 'main',
      createdAt: req.createdAt,
    },
  ];
}
```

并补充注释到 `createRequirement` 上方（约 20 行处）：

```js
// ---- 需求主体 ----
// sessions[] 渐进迁移：新建需求 sessions 为空数组；旧需求读侧用 normalizeSessions 合成。
// 任何一次真实写入（sessionId 回填 / 新建子会话）都会顺带把合成结果落盘，完成迁移。
```

- [ ] **Step 5: 写单元测试 — normalizeSessions 两种路径**

在测试末尾加两个用例：

```js
test('normalizeSessions：sessions 非空直接返回', () => {
  const r = createRequirement({ title: '有会话的需求' });
  const sess = { convId: 'c123', sessionId: 's456', title: '子会话', kind: 'sub', createdAt: new Date().toISOString() };
  r.sessions = [sess];
  const norm = normalizeSessions(r);
  assert.equal(norm.length, 1);
  assert.equal(norm[0].kind, 'sub');
});

test('normalizeSessions：sessions 空但 convId 非空 → 合成主会话', () => {
  const r = createRequirement({ title: '旧数据需求' });
  r.convId = 'c_old_123';
  r.devSession = 's_dev_456';
  r.sessions = [];
  const norm = normalizeSessions(r);
  assert.equal(norm.length, 1);
  assert.equal(norm[0].convId, 'c_old_123');
  assert.equal(norm[0].sessionId, 's_dev_456');
  assert.equal(norm[0].kind, 'main');
  assert.equal(norm[0].title, '自动开发');
});

test('normalizeSessions：sessions 空且 convId 空 → 返回空数组', () => {
  const r = createRequirement({ title: '无会话需求' });
  r.sessions = [];
  r.convId = null;
  const norm = normalizeSessions(r);
  assert.equal(norm.length, 0);
});
```

- [ ] **Step 6: 检查点 — npm test 全绿**

运行 `npm test`，确保 `src/store/requirements.test.js` 所有用例通过（包括新增的三条）。预期输出：`X tests ... passed`。

---

### Task 2: 后端 req-logic 纯函数 — buildSeedPrompt / extractPitfalls / mergePitfalls

**文件:**
- Modify: `src/entrypoints/web/req-logic.js:1-300`
- Modify: `src/entrypoints/web/req-logic.test.js` (新增用例)

---

**说明：** 新增四个纯函数用于种子上下文构造和汇总规则提炼。

- [ ] **Step 1: 阅读现有 req-logic.js 的函数与测试**

打开 `src/entrypoints/web/req-logic.js`，确认导出风格（所有 `export function`）、参数解构、模板字符串拼接；参考 `buildDevelopPrompt` 和 `buildApiFixPrompt` 的写法。

- [ ] **Step 2: 新增 buildSeedPrompt 函数**

在文件末尾（最后一个导出函数后、所有 export 语句之前）加入：

```js
/**
 * 子会话种子上下文：轻量标头（不含开发文档全文）。
 * 约 200-300 token，为子会话节省额度的前置上下文。
 * @param {object} req 需求记录
 * @returns {string} 种子 prompt
 */
export function buildSeedPrompt(req) {
  const { cwd: reqCwd, addDirs } = pickCwdAndDirs(req.projects);
  const parts = [];

  // 需求基本信息
  const branchName = reqBranchName(req);
  parts.push(`【需求】${req.title} · 分支 ${branchName}`);

  // 工程角色（前端优先，后端次之）
  if (reqCwd) {
    const dirs = [reqCwd, ...addDirs];
    const roles = dirs
      .map((dir) => {
        const isBackend = req.projects?.backend && req.projects.backend.dir === dir;
        const isDev = isBackend ? !req.projects.backend.dev : req.projects.frontend?.dev;
        const role = isDev ? '开发' : '只读参考，禁止修改';
        const label = dirTail(dir);
        return `【${isBackend ? '后端' : '前端'}】${label}（${role}）`;
      });
    parts.push(roles.join('\n'));
  }

  // 开发文档（若有最新版本）
  const latest = req.devDoc?.versions?.at(-1);
  if (latest) {
    parts.push(`【开发文档】${latest.path}（需要时自行 Read）`);
  }

  // 设计准则（非空才附）
  if (req.designGuidelines) {
    parts.push(`【设计准则】\n${req.designGuidelines}`);
  }

  // 末尾导语
  parts.push('避坑清单已由仓库 CLAUDE.md 引入，启动时自动加载。请按上下文开展工作。');

  return parts.join('\n\n');
}
```

**注意：** 此函数依赖现有的 `pickCwdAndDirs`、`reqBranchName`。确认它们已在文件中导出。

- [ ] **Step 3: 新增 extractPitfalls 函数**

```js
/**
 * 从 Claude 回答末尾提取避坑清单块。
 * 格式：<!-- PITFALLS-BEGIN --> ... <!-- PITFALLS-END -->
 * 返回块内的内容（包括 HTML 注释），若无找到则返回 null。
 * @param {string} text Claude assistant 消息正文
 * @returns {string|null} 清单块（含注释），或 null
 */
export function extractPitfalls(text) {
  const match = text.match(/<!--\s*PITFALLS-BEGIN\s*-->([\s\S]*?)<!--\s*PITFALLS-END\s*-->/);
  return match ? match[0] : null;
}
```

- [ ] **Step 4: 新增 splitPitfallsByProject 函数**

```js
/**
 * 按 [前端] / [后端] 前缀分流清单条目。
 * @param {string} pitfallsBlock 清单块（markdown 格式，每行一条）
 * @returns {object} { frontend: ['条目1', ...], backend: ['条目2', ...] }
 */
export function splitPitfallsByProject(pitfallsBlock) {
  const lines = pitfallsBlock
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-')); // 仅提取 markdown 列表项

  const frontend = [];
  const backend = [];

  for (const line of lines) {
    // 去掉 '- ' 前缀
    const content = line.replace(/^-\s*/, '');
    if (content.startsWith('[前端]')) {
      frontend.push(content.replace(/^\[前端\]\s*/, ''));
    } else if (content.startsWith('[后端]')) {
      backend.push(content.replace(/^\[后端\]\s*/, ''));
    }
  }

  return { frontend, backend };
}
```

- [ ] **Step 5: 新增 mergePitfalls 函数**

```js
/**
 * 去重合并两份清单，保持顺序，超限强制压缩。
 * 策略：按首 20 字符作为 key 去重；超 30 条时倒数第 3 条加省略号。
 * @param {string[]} existing 现有清单（已分流，都是前端或都是后端）
 * @param {string[]} incoming 新条目（同侧）
 * @returns {object} { items: string[], truncated: boolean, removed: number }
 */
export function mergePitfalls(existing = [], incoming = []) {
  const LIMIT = 30;
  const combined = [...existing];
  const seen = new Set(existing.map((item) => item.slice(0, 20)));

  let added = 0;
  for (const item of incoming) {
    const key = item.slice(0, 20);
    if (!seen.has(key)) {
      combined.push(item);
      seen.add(key);
      added++;
    }
  }

  let truncated = false;
  let removed = 0;
  if (combined.length > LIMIT) {
    // 倒数第 3 条位置（即 LIMIT-2 索引）加省略号
    const truncIdx = LIMIT - 2;
    combined[truncIdx] = '…（已超限，更多清单见完整报告）…';
    removed = combined.length - LIMIT;
    combined.length = LIMIT;
    truncated = true;
  }

  return { items: combined, truncated, removed };
}
```

- [ ] **Step 6: 写单元测试**

在 `src/entrypoints/web/req-logic.test.js` 末尾加入：

```js
test('buildSeedPrompt：包含需求标题、分支、工程角色、开发文档路径、设计准则', () => {
  const prompt = buildSeedPrompt(PROJECTS);
  // 这里 PROJECTS 可能缺少 req 的其他字段，需要补全
  // 构造完整的 req 对象
  const req = {
    title: '测试需求',
    projects: PROJECTS,
    devDoc: { versions: [{ v: 1, path: 'C:/req.md' }] },
    designGuidelines: '遵守 Vue3 规范',
    createdAt: new Date().toISOString(),
  };
  const p = buildSeedPrompt(req);
  assert.match(p, /测试需求/);
  assert.match(p, /开发文档/);
  assert.match(p, /设计准则/);
  assert.match(p, /Vue3 规范/);
});

test('buildSeedPrompt：设计准则为空时省略', () => {
  const req = {
    title: '无准则需求',
    projects: PROJECTS,
    designGuidelines: '',
    devDoc: { versions: [] },
    createdAt: new Date().toISOString(),
  };
  const p = buildSeedPrompt(req);
  assert.doesNotMatch(p, /设计准则/);
});

test('extractPitfalls：正确识别 PITFALLS-BEGIN/END 块', () => {
  const text = `汇总报告\n<!-- PITFALLS-BEGIN -->\n- [前端] 避坑\n<!-- PITFALLS-END -->\n后续工作`;
  const block = extractPitfalls(text);
  assert.match(block, /PITFALLS-BEGIN/);
  assert.match(block, /前端/);
});

test('extractPitfalls：无块时返回 null', () => {
  const text = '没有标记块的回答';
  assert.equal(extractPitfalls(text), null);
});

test('splitPitfallsByProject：按前缀分流', () => {
  const block = `<!-- PITFALLS-BEGIN -->
- [前端] 条目1
- [后端] 条目2
- [前端] 条目3
<!-- PITFALLS-END -->`;
  const result = splitPitfallsByProject(block);
  assert.equal(result.frontend.length, 2);
  assert.equal(result.backend.length, 1);
  assert.match(result.frontend[0], /条目1/);
});

test('mergePitfalls：去重合并，不超 30 条', () => {
  const existing = ['条目A', '条目B'];
  const incoming = ['条目A', '条目C', '条目D']; // 条目A 重复
  const result = mergePitfalls(existing, incoming);
  assert.equal(result.items.length, 4); // A B C D
  assert.equal(result.truncated, false);
  assert.match(result.items[2], /条目C/);
});

test('mergePitfalls：超 30 条时截断', () => {
  const existing = Array.from({ length: 28 }, (_, i) => `条目${i}`);
  const incoming = Array.from({ length: 5 }, (_, i) => `新条目${i}`);
  const result = mergePitfalls(existing, incoming);
  assert.equal(result.items.length, 30);
  assert.equal(result.truncated, true);
  assert.equal(result.removed, 3);
  assert.match(result.items[28], /已超限/);
});
```

**注意：** `buildSeedPrompt` 依赖 `pickCwdAndDirs` 和 `dirTail`，需确保在 req-logic.test.js 里已 import 或能访问到。若 `dirTail` 来自 `./util.js`，需补充 import。

- [ ] **Step 7: 检查点 — npm test 全绿**

运行 `npm test`，确保 `src/entrypoints/web/req-logic.test.js` 所有新用例通过。

---

### Task 3: 后端 req-pitfalls 模块 — pitfalls.md 与 CLAUDE.md 文件操作

**文件:**
- Create: `src/entrypoints/web/req-pitfalls.js`
- Create: `src/entrypoints/web/req-pitfalls.test.js` (测试)

---

**说明：** 独立成模块处理 `.claude/pitfalls.md` 与 `CLAUDE.md` 的读写，与 req-logic 纯函数分离，便于分别测试。

- [ ] **Step 1: 阅读文件系统操作范例**

检查项目里是否有类似的 fs 操作模块（如 history.js），了解异常处理和路径定位习惯。

- [ ] **Step 2: 新建 req-pitfalls.js 空壳**

创建 `src/entrypoints/web/req-pitfalls.js`，顶部导入：

```js
import fs from 'node:fs/promises';
import path from 'node:path';

// 暴露给测试的 IO 函数（供模拟/注入）
export async function readFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeFile(filePath, content) {
  // 确保目录存在
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

export async function appendFile(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  // 若文件不存在则新建；存在则追加
  const existing = await readFile(filePath);
  const newContent = existing ? existing + '\n' + content : content;
  await fs.writeFile(filePath, newContent, 'utf8');
}
```

- [ ] **Step 3: 新增 ensurePitfallsPath 辅助**

```js
/**
 * 定位工程的 pitfalls.md 路径。
 * @param {string} projectDir 工程绝对路径
 * @returns {string} 完整路径 <dir>/.claude/pitfalls.md
 */
export function ensurePitfallsPath(projectDir) {
  return path.join(projectDir, '.claude', 'pitfalls.md');
}

/**
 * 定位工程的 CLAUDE.md 路径。
 * @param {string} projectDir 工程绝对路径
 * @returns {string} 完整路径 <dir>/CLAUDE.md
 */
export function ensureClaudeMdPath(projectDir) {
  return path.join(projectDir, 'CLAUDE.md');
}
```

- [ ] **Step 4: 新增 writePitfalls 与 ensureClaudeMdRef**

```js
/**
 * 写入（或覆盖）避坑清单到 pitfalls.md。
 * 格式：每行一条，非 markdown，纯文本（便于 CLAUDE.md @include 解析）。
 * @param {string} projectDir 工程目录
 * @param {string[]} items 清单条目（不含 markdown 前缀）
 * @throws {Error} 文件操作失败
 */
export async function writePitfalls(projectDir, items) {
  const filePath = ensurePitfallsPath(projectDir);
  // 读现有清单
  const existing = await readFile(filePath);
  const existingLines = existing ? existing.split('\n').filter((l) => l.trim()) : [];

  // 合并：避免全量覆盖，采取追加策略（与 mergePitfalls 同调）
  // 若想全量覆盖则改为 const merged = items;
  const merged = [...existingLines, ...items];
  const uniqueLines = [...new Set(merged)]; // 按字面去重
  const content = uniqueLines.join('\n');

  await writeFile(filePath, content + '\n'); // 末尾加换行
}

/**
 * 确保 CLAUDE.md 有 @.claude/pitfalls.md 引用。
 * 若无则追加；若已有则不动。
 * @param {string} projectDir 工程目录
 * @throws {Error} 文件操作失败
 */
export async function ensureClaudeMdRef(projectDir) {
  const claudeMdPath = ensureClaudeMdPath(projectDir);
  let content = await readFile(claudeMdPath);

  if (!content) {
    // CLAUDE.md 不存在，创建最小内容
    content = '@.claude/pitfalls.md\n';
    await writeFile(claudeMdPath, content);
    return;
  }

  // CLAUDE.md 已存在，检查是否有引用
  if (content.includes('@.claude/pitfalls.md')) {
    // 已有引用，不动
    return;
  }

  // 补充引用（追加到末尾，前面加空行）
  const newContent = content.endsWith('\n')
    ? content + '\n@.claude/pitfalls.md\n'
    : content + '\n\n@.claude/pitfalls.md\n';
  await writeFile(claudeMdPath, newContent);
}
```

- [ ] **Step 5: 写单元测试（利用临时目录）**

创建 `src/entrypoints/web/req-pitfalls.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const {
  readFile,
  writeFile,
  appendFile,
  ensurePitfallsPath,
  ensureClaudeMdPath,
  writePitfalls,
  ensureClaudeMdRef,
} = await import('./req-pitfalls.js');

let tmpDir;
test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-pitfalls-'));
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true });
});

test('ensurePitfallsPath / ensureClaudeMdPath：路径定位', () => {
  const pitfallsPath = ensurePitfallsPath(tmpDir);
  assert.match(pitfallsPath, /\.claude[/\\]pitfalls\.md$/);
  const claudeMdPath = ensureClaudeMdPath(tmpDir);
  assert.match(claudeMdPath, /CLAUDE\.md$/);
});

test('writePitfalls：新建 pitfalls.md 并写入条目', async () => {
  await writePitfalls(tmpDir, ['条目1', '条目2']);
  const content = await readFile(ensurePitfallsPath(tmpDir));
  assert.match(content, /条目1/);
  assert.match(content, /条目2/);
});

test('writePitfalls：重复调用去重', async () => {
  await writePitfalls(tmpDir, ['条目A']);
  await writePitfalls(tmpDir, ['条目A', '条目B']);
  const content = await readFile(ensurePitfallsPath(tmpDir));
  const lines = content.split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 2); // A 和 B，无重复
});

test('ensureClaudeMdRef：CLAUDE.md 不存在时创建并加引用', async () => {
  const claudeMdPath = ensureClaudeMdPath(tmpDir);
  assert.equal(await readFile(claudeMdPath), null);
  await ensureClaudeMdRef(tmpDir);
  const content = await readFile(claudeMdPath);
  assert.match(content, /@\.claude\/pitfalls\.md/);
});

test('ensureClaudeMdRef：CLAUDE.md 已有引用时不重复', async () => {
  await writeFile(ensureClaudeMdPath(tmpDir), '# My Project\n\n@.claude/pitfalls.md\n');
  const before = await readFile(ensureClaudeMdPath(tmpDir));
  await ensureClaudeMdRef(tmpDir);
  const after = await readFile(ensureClaudeMdPath(tmpDir));
  assert.equal(before, after);
});

test('ensureClaudeMdRef：CLAUDE.md 无引用时追加', async () => {
  await writeFile(ensureClaudeMdPath(tmpDir), '# My Project\n');
  await ensureClaudeMdRef(tmpDir);
  const content = await readFile(ensureClaudeMdPath(tmpDir));
  assert.match(content, /@\.claude\/pitfalls\.md/);
});
```

- [ ] **Step 6: 检查点 — npm test 全绿**

运行 `npm test`，确保 `src/entrypoints/web/req-pitfalls.test.js` 所有用例通过。

---

### Task 4: 后端路由 — POST/DELETE /api/req/session、POST /api/req/pitfalls

**文件:**
- Modify: `src/entrypoints/web/routes-requirements.js:350-500`
- Modify: `src/entrypoints/web/routes-requirements.test.js` (新增用例)

---

**说明：** 三个新分支：登记/更新会话、删除会话、确认并写入规则。

- [ ] **Step 1: 阅读现有路由风格**

重新扫一遍 routes-requirements.js 的 `handleSupplement` 和 `handleArchive`，确认参数校验、updateRequirement 调用、响应格式。

- [ ] **Step 2: 新增 handleSession POST 分支**

在 routes-requirements.js 的 `handleRequirementRoutes` 分发器（末尾）加入：

```js
if (pathname === '/api/req/session' && method === 'POST') return handleSession(req, res);
if (pathname === '/api/req/session' && method === 'DELETE') return handleSessionDelete(req, res);
if (pathname === '/api/req/pitfalls' && method === 'POST') return handlePitfalls(req, res);
```

然后在模块末尾定义分支函数：

```js
// ==== POST /api/req/session {id, convId, sessionId?, title?, kind?} ====
function handleSession(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });

    const convId = str(data.convId);
    const sessionId = data.sessionId ? str(data.sessionId) : null;
    const title = data.title ? str(data.title) : '新会话';
    const kind = data.kind ? str(data.kind) : 'sub';

    // 幂等性：按 convId upsert
    const sessions = normalizeSessions(r);
    const idx = sessions.findIndex((s) => s.convId === convId);

    let updated = false;
    if (idx >= 0) {
      // 更新既有记录：补齐 sessionId / 更新 title，但不改 kind
      const existing = sessions[idx];
      if (sessionId && !existing.sessionId) {
        existing.sessionId = sessionId;
        updated = true;
      }
      if (title && title !== existing.title) {
        existing.title = title;
        updated = true;
      }
      // kind 初次登记时生效，后续上报不改
    } else {
      // 新增会话记录
      sessions.push({
        convId,
        sessionId,  // 可能为 null
        title,
        kind,       // 初次登记时写入，后续忽略
        createdAt: new Date().toISOString(),
      });
      updated = true;
    }

    // 若为 main kind，同步回写 req.devSession
    if (kind === 'main' && sessionId) {
      const mainSession = sessions.find((s) => s.kind === 'main');
      if (mainSession) {
        r.devSession = mainSession.sessionId;
      }
    }

    // 只在有更新时落盘（包括新增 sessions 数组本身的首次真实写入）
    if (updated || !r.sessions || r.sessions.length === 0) {
      updateRequirement(id, { sessions }, kind === 'main' ? '主会话 sessionId 回填' : `会话登记 ${title}`);
    }

    sendJson(res, 200, { ok: true });
  });
}
```

- [ ] **Step 3: 新增 handleSessionDelete DELETE 分支**

```js
// ==== DELETE /api/req/session {id, convId} ====
function handleSessionDelete(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });

    const convId = str(data.convId);
    const sessions = normalizeSessions(r);

    // 查找目标会话
    const idx = sessions.findIndex((s) => s.convId === convId);
    if (idx < 0) return sendJson(res, 404, { error: '会话不存在' });

    // 不允许删除 main kind
    if (sessions[idx].kind === 'main') {
      return sendJson(res, 409, { error: '不能删除主会话（bug-fix 落点）' });
    }

    // 移除该条目
    sessions.splice(idx, 1);
    updateRequirement(id, { sessions }, `删除会话 ${sessions[idx]?.title || convId}`);

    sendJson(res, 200, { ok: true });
  });
}
```

- [ ] **Step 4: 新增 handlePitfalls POST 分支**

导入 req-pitfalls 模块：

```js
import { writePitfalls, ensureClaudeMdRef } from './req-pitfalls.js';
```

然后定义分支：

```js
// ==== POST /api/req/pitfalls {id, items, frontend, backend} ====
// items: [{project, content}] 或直接 frontend/backend 字段（[项目1, 项目2, ...]）
// 响应：{ ok, written, skipped }
async function handlePitfalls(req, res) {
  return withJsonBody(req, res, async (data) => {
    const id = str(data.id);
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });

    const frontend = Array.isArray(data.frontend) ? data.frontend : [];
    const backend = Array.isArray(data.backend) ? data.backend : [];

    // 写入各工程的 pitfalls.md
    const written = { frontend: 0, backend: 0 };
    const skipped = [];

    if (frontend.length > 0 && r.projects?.frontend?.dir) {
      try {
        await writePitfalls(r.projects.frontend.dir, frontend);
        await ensureClaudeMdRef(r.projects.frontend.dir);
        written.frontend = frontend.length;
      } catch (e) {
        skipped.push({ side: 'frontend', error: e.message });
      }
    } else if (frontend.length > 0) {
      skipped.push({ side: 'frontend', error: '前端工程未配置' });
    }

    if (backend.length > 0 && r.projects?.backend?.dir && r.projects.backend.dev) {
      // 只写开发工程（dev === true）
      try {
        await writePitfalls(r.projects.backend.dir, backend);
        await ensureClaudeMdRef(r.projects.backend.dir);
        written.backend = backend.length;
      } catch (e) {
        skipped.push({ side: 'backend', error: e.message });
      }
    } else if (backend.length > 0) {
      if (!r.projects?.backend?.dir) {
        skipped.push({ side: 'backend', error: '后端工程未配置' });
      } else if (!r.projects.backend.dev) {
        skipped.push({ side: 'backend', error: '后端为只读工程，不写入' });
      }
    }

    sendJson(res, 200, { ok: true, written, skipped });
  });
}
```

- [ ] **Step 5: 修改 handleGet 补充派生字段**

在 routes-requirements.js 的 `handleGet` 函数（约 38-58 行）结尾的响应体加入：

```js
// 修改现有的 sendJson 调用：
sendJson(res, 200, {
  ...r,
  devDocLatest,
  queued: hasQueuedTasks(id),
  devCwd: pickCwdAndDirs(r.projects).cwd,
  sessions: normalizeSessions(r),  // 新增：已 normalize 的会话列表
  seed: r.phase === 'dev' || r.phase === 'test' ? buildSeedPrompt(r) : null,  // 新增：种子上下文
});
```

需导入 `buildSeedPrompt` 与 `normalizeSessions`：

```js
import { buildSeedPrompt, normalizeSessions } from './req-logic.js';
```

- [ ] **Step 6: 写单元测试**

在 `src/entrypoints/web/routes-requirements.test.js` 末尾加入：

```js
test('POST /api/req/session：新建子会话登记（sessionId 可空）', async () => {
  const req = await createReq('会话测试');
  const id = req.id;
  const convId = 'c_sub_123';
  const res = await post('/api/req/session', { id, convId, title: '调试会话', kind: 'sub' });
  assert.equal(res.status, 200);
  const updated = getRequirement(id);
  assert.equal(updated.sessions.length, 1);
  assert.equal(updated.sessions[0].convId, convId);
  assert.equal(updated.sessions[0].title, '调试会话');
  assert.equal(updated.sessions[0].kind, 'sub');
});

test('POST /api/req/session：补齐 sessionId（幂等）', async () => {
  const req = await createReq('sessionId 补齐测试');
  const id = req.id;
  const convId = 'c_test_456';
  // 第一次登记，sessionId 为空
  await post('/api/req/session', { id, convId, title: '会话', kind: 'sub', sessionId: null });
  let updated = getRequirement(id);
  assert.equal(updated.sessions[0].sessionId, null);
  // 第二次补齐 sessionId
  const res = await post('/api/req/session', { id, convId, sessionId: 's_test_789' });
  assert.equal(res.status, 200);
  updated = getRequirement(id);
  assert.equal(updated.sessions[0].sessionId, 's_test_789');
  assert.equal(updated.sessions.length, 1); // 幂等：未重复新增
});

test('DELETE /api/req/session：删除子会话（不能删 main）', async () => {
  const req = await createReq('删除测试');
  const id = req.id;
  // 先建子会话
  await post('/api/req/session', { id, convId: 'c_del_123', kind: 'sub' });
  // 删除成功
  const res = await del(`/api/req/session`, { id, convId: 'c_del_123' });
  assert.equal(res.status, 200);
  let updated = getRequirement(id);
  assert.equal(updated.sessions.length, 0);
  // 若有 main 尝试删 → 409
  req.convId = 'c_main_456';
  req.sessions = [{ convId: 'c_main_456', kind: 'main', createdAt: new Date().toISOString() }];
  updateRequirement(id, { convId: 'c_main_456', sessions: req.sessions });
  const bad = await del(`/api/req/session`, { id, convId: 'c_main_456' });
  assert.equal(bad.status, 409);
});

test('POST /api/req/pitfalls：写入前端后端清单（只写开发工程）', async () => {
  const req = await createReq('规则写入测试');
  const id = req.id;
  // 先配置工程
  await put('/api/req/config', {
    id,
    projects: {
      frontend: { dir: tmpDir + '/fe', dev: true },
      backend: { dir: tmpDir + '/be', dev: true },
    },
  });
  // 写规则
  const res = await post('/api/req/pitfalls', {
    id,
    frontend: ['条目1', '条目2'],
    backend: ['条目3'],
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.written.frontend, 2);
  assert.equal(res.json.written.backend, 1);
  // 验证文件落盘
  const feContent = fs.readFileSync(tmpDir + '/fe/.claude/pitfalls.md', 'utf8');
  assert.match(feContent, /条目1/);
});
```

**注意：** `tmpDir` 在测试开头定义（mkdtempSync），用作工程目录。

- [ ] **Step 7: 检查点 — npm test 全绿**

运行 `npm test`，确保 routes-requirements.test.js 的新用例全部通过。

---

### Task 5: 前端 conv-store — convSetTitle / convDelete / convSetMeta

**文件:**
- Modify: `public/js/conv-store.js:50-120`

---

**说明：** 三个单 conv 操作函数，参考现有 `convSetSession` 风格。

- [ ] **Step 1: 阅读现有 conv-store 操作**

打开 `public/js/conv-store.js`，确认 `convSetSession` 等函数的实现约定。

- [ ] **Step 2: 新增 convSetTitle**

在 `convSetSession` 后加入：

```js
export function convSetTitle(convId, title) {
  const list = loadConvs();
  const c = list.find((x) => x.id === convId);
  if (!c) return;
  c.title = String(title || '新会话').slice(0, 60); // 同 createRequirement 长度限制
  c.updatedAt = Date.now();
  saveConvs(list);
}
```

- [ ] **Step 3: 新增 convDelete**

```js
export function convDelete(convId) {
  const list = loadConvs();
  const idx = list.findIndex((x) => x.id === convId);
  if (idx < 0) return;
  list.splice(idx, 1);
  c.updatedAt = Date.now();
  saveConvs(list);
}
```

**修正上面的代码（有 typo）：**

```js
export function convDelete(convId) {
  const list = loadConvs();
  const idx = list.findIndex((x) => x.id === convId);
  if (idx < 0) return;
  list.splice(idx, 1);
  saveConvs(list);
}
```

- [ ] **Step 4: 新增 convSetMeta**

```js
export function convSetMeta(convId, patch) {
  const list = loadConvs();
  const c = list.find((x) => x.id === convId);
  if (!c) return;
  if (!c.meta) c.meta = {};
  Object.assign(c.meta, patch);
  c.updatedAt = Date.now();
  saveConvs(list);
}
```

- [ ] **Step 5: 检查点 — node --check 语法通过**

运行 `node --check public/js/conv-store.js`，确保无语法错误。

---

### Task 6: 前端 chat.js — 种子前置 + SSE 回填 + isConvRunning 导出

**文件:**
- Modify: `public/js/chat.js:650-900, 1305-1353, 1640-1680`

---

**说明：** 种子种在首次 send() 时前置拼接；SSE session 事件回填 `/api/req/session`；导出 `isConvRunning`。

- [ ] **Step 1: 阅读 send() 与 launchRun 调用点**

打开 `public/js/chat.js` 约 1305-1353 行，确认 `steer` 早退、`send()` 末尾 `launchRun(job, text, sessionId, runCwd)` 调用。

- [ ] **Step 2: 在 send() 前置拼接种子**

修改 `send()` 函数，在 1352 行 `launchRun` 调用前加入种子拼接逻辑（但仅改传给 launchRun 的 text，不改 addMessage / recordMessage）：

```js
      function send() {
        const text = getPromptText();
        if (!text) return;
        
        // steer 早退分支（同原文）
        const running = currentConvId && runningJobs[currentConvId];
        if (running) {
          _goChat();
          return steer(running, text);
        }
        
        _goChat();
        // ... 原有逻辑：建立 convId、记消息、建 job ...
        
        // ★ 种子前置拼接（新增）
        let textToModel = text;
        const conv = loadConvs().find((c) => c.id === convId);
        if (conv && conv.meta && conv.meta.seedPending && conv.meta.seedText) {
          textToModel = conv.meta.seedText + '\n\n用户消息：\n' + text;
          // 清除标记，后续消息不重复拼
          convSetMeta(convId, { seedPending: false });
        }
        
        launchRun(job, textToModel, sessionId, runCwd);  // 改为 textToModel
      }
```

**注意：** 需在文件顶部 import `convSetMeta`（已在 Task 5 定义）：

```js
import { convSetMeta } from './conv-store.js';
```

- [ ] **Step 3: SSE 事件补充回填 /api/req/session**

修改 chat.js 约 1645-1650 行的 `session` 事件处理，在 `convSetSession` 后加入回填网络请求：

```js
        es.addEventListener('session', (e) => {
          const sid = JSON.parse(e.data).session_id;
          if (!sid) return;
          convSetSession(convId, sid);
          if (visible()) currentSession = sid;
          
          // ★ 回填后端（新增）
          const conv = loadConvs().find((c) => c.id === convId);
          if (conv && conv.meta && conv.meta.reqId) {
            // 这是一个需求会话，回填 sessionId 到后端记录
            fetch('/api/req/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: conv.meta.reqId,
                convId: convId,
                sessionId: sid,
                title: conv.title,
                kind: conv.meta.kind || 'sub',
              }),
            }).catch((e) => {
              logger.warn('chat', 'sessionId 回填失败', { convId, error: e.message });
            });
          }
        });
```

- [ ] **Step 4: 新增 isConvRunning 导出**

在 chat.js 的导出列表（文件顶部或末尾）加入：

```js
export function isConvRunning(convId) {
  return !!runningJobs[convId];
}
```

确保在 module.exports 或顶部 export 里。

- [ ] **Step 5: 修改 createReqConv 写入 kind**

修改 `createReqConv` 函数（约 624-641 行）的 meta 初始化：

```js
export function createReqConv({ reqId, cwd: reqCwd, session, title, kind = 'sub' }) {
  const list = loadConvs();
  const c = {
    id: 'c' + String(Date.now()),
    title: title || '需求会话',
    session: session || null,
    cwd: reqCwd || '',
    messages: [],
    updatedAt: Date.now(),
    meta: { reqId, kind, seedPending: true, seedText: null },  // ★ 补充 kind / seedPending / seedText
    provider: 'claude-agent',
  };
  list.push(c);
  saveConvs(list);
  return c.id;
}
```

- [ ] **Step 6: 检查点 — node --check 语法通过**

运行 `node --check public/js/chat.js`，确保无语法错误。

---

### Task 7: 前端 ui.js — textareaDialog 多行输入框

**文件:**
- Modify: `public/js/ui.js:50-108`

---

**说明：** 新增 `textareaDialog`，参考 `promptDialog` 风格但改用 textarea + Ctrl/Cmd+Enter 提交。

- [ ] **Step 1: 阅读 promptDialog 完整实现**

再过一遍 ui.js 第 50-97 行，特别关注 DOM 结构、事件处理、Promise 返回。

- [ ] **Step 2: 新增 textareaDialog 函数**

在 `promptDialog` 后（97 行之后）加入：

```js
      // ---- 多行输入对话框（文本区域 + 确认/取消）----
      export function textareaDialog({
        title = '输入',
        message = '',
        value = '',
        placeholder = '',
        confirmText = '确认',
        cancelText = '取消',
      } = {}) {
        return new Promise((resolve) => {
          const mask = document.createElement('div');
          mask.className = 'mask';
          mask.innerHTML =
            '<div class="modal confirm-modal">' +
            '<div class="head"><h3></h3></div>' +
            '<div class="body"><p class="confirm-msg"></p><textarea class="prompt-input textarea-dialog"></textarea></div>' +
            '<div class="confirm-foot"><button class="btn cancel"></button><button class="btn ok primary"></button></div>' +
            '</div>';
          mask.querySelector('h3').textContent = title;
          const msgEl = mask.querySelector('.confirm-msg');
          if (message) msgEl.textContent = message;
          else msgEl.remove();
          const textarea = mask.querySelector('textarea');
          textarea.value = value;
          textarea.placeholder = placeholder;
          const cancelBtn = mask.querySelector('.cancel');
          const okBtn = mask.querySelector('.ok');
          cancelBtn.textContent = cancelText;
          okBtn.textContent = confirmText;
          const close = (val) => {
            mask.remove();
            document.removeEventListener('keydown', onKey);
            resolve(val);
          };
          const onKey = (e) => {
            if (e.key === 'Escape') {
              close(null);
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              // Ctrl/Cmd+Enter 提交
              close(textarea.value);
            }
          };
          cancelBtn.onclick = () => close(null);
          okBtn.onclick = () => close(textarea.value);
          mask.addEventListener('click', (e) => {
            if (e.target === mask) close(null);
          });
          document.addEventListener('keydown', onKey);
          document.body.appendChild(mask);
          textarea.focus();
          // 预填值全选（可选，改为不全选更合理）
          // textarea.select();
        });
      }
```

- [ ] **Step 3: 补充 CSS 样式**

在 `public/app.css` 末尾加入（或在现有 `.prompt-input` 规则后）：

```css
      .prompt-input.textarea-dialog {
        min-height: 150px;
        resize: vertical;
      }
```

- [ ] **Step 4: 检查点 — node --check 语法通过**

运行 `node --check public/js/ui.js`，确保无语法错误。

---

### Task 8: 前端 req-view.js — 侧栏会话树与 [优化汇总] 按钮

**文件:**
- Modify: `public/js/req-view.js:200-310, 580-630`

---

**说明：** 展开需求行看会话树、新增/删除/重命名子会话、归档期补 [优化汇总] 按钮。

- [ ] **Step 1: 阅读现有侧栏结构与折叠组实现**

查看 req-view.js 的 `makeArchivedToggle` / `makeDiscardedToggle` 实现（约 249-269 行），了解折叠箭头+展开态的约定。

- [ ] **Step 2: 修改 makeReqRow 加折叠箭头**

修改 `makeReqRow(r)` 函数（约 271-303 行），在 title 前加箭头：

```js
function makeReqRow(r) {
  const row = document.createElement('div');
  row.className = 'req-item' + (r.id === currentReqId && isReqViewActive() ? ' active' : '');
  row.dataset.reqId = r.id;
  
  // ★ 折叠箭头（新增）
  const arrow = document.createElement('span');
  arrow.className = 'req-arrow';
  arrow.textContent = expanded[r.id] ? '▾' : '▸';
  arrow.style.cursor = 'pointer';
  arrow.style.marginRight = '4px';
  arrow.onclick = (e) => {
    e.stopPropagation();
    expanded[r.id] = !expanded[r.id];
    renderReqList();
  };
  row.appendChild(arrow);
  
  if (isReqPinned(r.id)) {
    const pinIc = document.createElement('span');
    // ... 原有 pin 图标 ...
  }
  
  // ... 其他部分保持原样 ...
}
```

模块顶部补充 `expanded` 对象（跟踪展开态，同 `archiveExpanded` / `discardedExpanded` 的约定）：

```js
const expanded = {};  // { reqId: boolean }  —— 记录需求行是否展开
```

- [ ] **Step 3: 新增 makeSessionTree 函数**

```js
function makeSessionTree(r) {
  const tree = document.createElement('div');
  tree.className = 'req-sessions-tree';
  
  // 从后端或前端重建会话列表
  const list = loadConvs();
  const convs = list.filter((c) => c.meta && c.meta.reqId === r.id);
  
  // 按 kind 排序（main 首）
  convs.sort((a, b) => {
    const aIsMain = a.meta?.kind === 'main' ? 0 : 1;
    const bIsMain = b.meta?.kind === 'main' ? 0 : 1;
    return aIsMain - bIsMain;
  });
  
  for (const conv of convs) {
    const row = document.createElement('div');
    row.className = 'req-session-item';
    
    // 会话标题与标记
    const icon = conv.meta?.kind === 'main' ? '⚡' : '💬';
    const title = document.createElement('span');
    title.textContent = `${icon} ${conv.title}`;
    title.style.flex = '1';
    title.style.cursor = 'pointer';
    title.onclick = () => openConv(conv.id);
    row.appendChild(title);
    
    // 运行灯（查 runningJobs）
    if (isConvRunning(conv.id)) {
      const light = document.createElement('span');
      light.className = 'req-session-light';
      light.title = '运行中';
      row.appendChild(light);
    }
    
    // 操作菜单（仅子会话可删）
    if (conv.meta?.kind !== 'main') {
      const renameBtn = document.createElement('button');
      renameBtn.className = 'q-btn';
      renameBtn.title = '重命名';
      renameBtn.textContent = '✏️';
      renameBtn.onclick = () => _renameSession(r.id, conv.id);
      row.appendChild(renameBtn);
      
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'q-btn';
      deleteBtn.title = '删除';
      deleteBtn.textContent = '✕';
      deleteBtn.onclick = () => _deleteSession(r.id, conv.id);
      row.appendChild(deleteBtn);
    }
    
    tree.appendChild(row);
  }
  
  // 新会话按钮
  const newBtn = document.createElement('button');
  newBtn.className = 'q-btn q-btn-text';
  newBtn.textContent = '＋ 新会话';
  newBtn.onclick = () => _createNewSession(r.id);
  tree.appendChild(newBtn);
  
  return tree;
}
```

引入必要的函数（在文件顶部 import）：

```js
import { isConvRunning } from './chat.js';
```

- [ ] **Step 4: 新增会话操作函数**

```js
async function _createNewSession(reqId) {
  const req = lastReqsMap[reqId]; // 缓存的需求记录
  if (!req) return;
  
  const title = await promptDialog({ title: '新会话名称', value: '新会话' });
  if (!title) return;
  
  const convId = createReqConv({
    reqId,
    cwd: req.projects?.frontend?.dir || req.projects?.backend?.dir || '',
    session: null,
    title,
    kind: 'sub',
  });
  
  // 后端登记（sessionId 暂空，首轮时补齐）
  await fetch('/api/req/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: reqId,
      convId,
      sessionId: null,
      title,
      kind: 'sub',
    }),
  });
  
  openConv(convId);
  renderReqList();
}

async function _renameSession(reqId, convId) {
  const conv = loadConvs().find((c) => c.id === convId);
  if (!conv) return;
  
  const newTitle = await promptDialog({ title: '新标题', value: conv.title });
  if (!newTitle || newTitle === conv.title) return;
  
  convSetTitle(convId, newTitle);
  
  // 同步后端
  await fetch('/api/req/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: reqId,
      convId,
      title: newTitle,
    }),
  });
  
  renderReqList();
}

async function _deleteSession(reqId, convId) {
  const ok = await confirmDialog({
    title: '删除会话',
    message: '确定删除此会话吗？对话内容仍保留在磁盘，不会丢失。',
  });
  if (!ok) return;
  
  convDelete(convId);
  
  // 后端移除记录
  await fetch('/api/req/session', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: reqId, convId }),
  });
  
  renderReqList();
}
```

- [ ] **Step 5: 修改 makeReqRow 插入会话树**

修改 `makeReqRow` 末尾，在返回前检查是否需要展开会话树：

```js
  // 在 row.onclick = () => openRequirement(r.id); 后，return row 前加入：
  
  // ★ 侦听展开态变化，为了让会话树在需求行后立即渲染（需扩 renderReqList）
  
  return row;
```

不在这里处理树渲染，而是在 `renderReqList()` 里按展开态决定。

- [ ] **Step 6: 修改 renderReqList 渲染会话树**

在 `renderReqList()` 的各层遍历中（约 200-240 行），当需求行后跟会话树。重构逻辑为：

```js
function renderReqList() {
  const frag = document.createDocumentFragment();
  // ... 保存现有对象刷新引用 ...
  
  const reqs = lastList || [];
  
  // 钉住层
  // ...existing code...
  
  // 活跃层（本次需求）
  const active = reqs.filter((r) => r.phase !== 'archived' && r.phase !== 'discarded');
  if (active.length) {
    const label = document.createElement('div');
    label.className = 'req-list-label';
    label.textContent = '本次需求';
    frag.appendChild(label);
    
    for (const r of active) {
      frag.appendChild(makeReqRow(r));
      
      // ★ 展开时显示会话树
      if (expanded[r.id]) {
        frag.appendChild(makeSessionTree(r));
      }
    }
  }
  
  // ... 已废弃、已归档层类似处理 ...
}
```

引入 `loadConvs`、`createReqConv`、`convSetTitle`、`convDelete` 等：

```js
import { loadConvs, convSetTitle, convDelete } from './conv-store.js';
import { createReqConv, openConv } from './chat.js';
```

- [ ] **Step 7: 修改 renderArchivingPage 加 [优化汇总] 按钮**

修改 `renderArchivingPage(req)` 函数（约 586-620 行），在 `renderArchivePreview(req)` 后加入：

```js
  // ★ 优化汇总按钮（新增，在 renderArchivePreview 后）
  const retroBtn = document.createElement('button');
  retroBtn.type = 'button';
  retroBtn.className = 'btn primary req-retro-btn';
  retroBtn.textContent = '🔍 优化汇总';
  retroBtn.style.marginBottom = '12px';
  retroBtn.onclick = () => startRetroSummary(req.id, retroBtn);
  wrap.appendChild(retroBtn);

  // ... 备注 label ...
```

引入 req-retro 模块（待新建）：

```js
import { startRetroSummary } from './req-retro.js';
```

- [ ] **Step 8: 检查点 — node --check 语法通过**

运行 `node --check public/js/req-view.js`，确保无语法错误。

---

### Task 9: 前端 req-retro.js — 优化汇总编排（map-reduce）

**文件:**
- Create: `public/js/req-retro.js`

---

**说明：** 编排 retro 会话，分批拉转录、逐条小结、聚合识别规则，提取并预览清单。

- [ ] **Step 1: 新建 req-retro.js 骨架与 startRetroSummary**

```js
import { openConv, createReqConv, sendMessageProgrammatically } from './chat.js';
import { textareaDialog } from './ui.js';
import { convSetMeta } from './conv-store.js';
import { extractPitfalls, splitPitfallsByProject } from '../entrypoints/web/req-logic.js';
// ^ 注意：req-logic 在后端，前端无法直接 import。需要把这两个函数搬到前端 req-retro.js，或后端通过 API 返回。

export async function startRetroSummary(reqId, triggerBtn) {
  triggerBtn.disabled = true;
  try {
    // 1. 创建 retro 会话
    const res = await fetch(`/api/req/get?id=${reqId}`);
    const req = await res.json();
    
    const retroConvId = createReqConv({
      reqId,
      cwd: req.devCwd,
      session: null,
      title: '优化汇总',
      kind: 'retro',
    });
    
    // 2. 切换到 retro 会话
    openConv(retroConvId);
    
    // 3. 执行 map-reduce（分批喂入转录）
    await mapReduceRetro(reqId, req.sessions);
    
  } catch (e) {
    window.toast.error('优化汇总启动失败: ' + e.message);
  } finally {
    triggerBtn.disabled = false;
  }
}

async function mapReduceRetro(reqId, sessions) {
  // Map 阶段：逐会话拉转录、小结
  const summaries = [];
  
  for (const session of sessions) {
    if (session.kind === 'retro' || !session.sessionId) {
      // retro 会话与空 sessionId 跳过
      continue;
    }
    
    try {
      // 拉转录
      const res = await fetch(`/api/history/${session.sessionId}?cwd=${req.devCwd}`);
      const transcript = await res.json();
      
      if (!transcript || !transcript.messages) continue;
      
      // 构造小结 prompt
      const mapPrompt = buildRetroMapPrompt(session, transcript);
      
      // 发进 retro 会话（要求仅小结、不展开）
      await sendMessageProgrammatically({
        convId: retroConvId,
        text: mapPrompt,
      });
      
    } catch (e) {
      logger.warn('req-retro', 'map 阶段失败', { sessionId: session.sessionId, error: e.message });
    }
  }
  
  // Reduce 阶段：聚合识别规则
  const reducePrompt = buildRetroReducePrompt(sessions.length);
  await sendMessageProgrammatically({
    convId: retroConvId,
    text: reducePrompt,
  });
  
  // 等待 reduce 回答完成，提取规则块、预览确认
  // （此步由 retro 会话的 run 完成后的钩子触发，见 req-chat.js mountReqChrome 的轮询）
}

function buildRetroMapPrompt(session, transcript) {
  const lines = transcript.messages || [];
  let text = lines.map((m) => `${m.role}: ${m.content}`).join('\n\n');
  
  // 截断保护
  const LIMIT = 30000;
  if (text.length > LIMIT) {
    const half = Math.floor(LIMIT / 2);
    text = text.slice(0, half) + `\n\n…（已截断 ${text.length - LIMIT} 字符）…\n\n` + text.slice(-half);
  }
  
  return (
    `【会话】${session.title}\n` +
    `以下是该会话的完整对话记录，请简要小结 AI 做了什么、踩过什么坑、用户如何纠正。` +
    `不要展开细节，仅 2-3 句。\n\n` +
    text
  );
}

function buildRetroReducePrompt(sessionCount) {
  return (
    `上述 ${sessionCount} 个会话的开发过程你已逐一回顾。` +
    `请重点识别 **跨会话反复出现的错误**（出现 2 次以上）。只出现一次的可能是偶然，忽略。\n\n` +
    `以下格式输出规则清单：\n\n` +
    `<!-- PITFALLS-BEGIN -->\n` +
    `- [前端] 具体规则，含定位（例如文件名/行号）\n` +
    `- [后端] 具体规则，含定位\n` +
    `<!-- PITFALLS-END -->`
  );
}

// ★ 规则提取与预览（由 req-chat.js 的 run 完成钩子触发）
export async function extractAndPreviewPitfalls(retroConvId, reqId) {
  // 从 retro 会话最后一条 assistant 消息提取规则块
  const convs = loadConvs();
  const retroConv = convs.find((c) => c.id === retroConvId);
  if (!retroConv) return;
  
  const lastMsg = retroConv.messages?.at(-1);
  if (!lastMsg || lastMsg.role !== 'assistant') return;
  
  const pitfallsBlock = extractPitfalls(lastMsg.text);
  if (!pitfallsBlock) {
    window.toast.error('未找到规则块 <!-- PITFALLS-BEGIN/END -->，请从会话正文手工复制');
    return;
  }
  
  // 分流按工程
  const { frontend, backend } = splitPitfallsByProject(pitfallsBlock);
  
  // 预览确认框
  const content = `
【前端条目】
${frontend.length > 0 ? frontend.join('\n') : '（无）'}

【后端条目】
${backend.length > 0 ? backend.join('\n') : '（无）'}
  `.trim();
  
  const result = await textareaDialog({
    title: '避坑清单预览',
    message: '请检查以下规则是否正确，可编辑后确认写入。删空不保存。',
    value: content,
    confirmText: '确认写入',
    cancelText: '取消',
  });
  
  if (!result) return; // 用户取消
  
  // 解析编辑后的内容
  const edited = parsePreviewContent(result);
  
  // 后端写入
  const res = await fetch('/api/req/pitfalls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: reqId,
      frontend: edited.frontend,
      backend: edited.backend,
    }),
  });
  
  const json = await res.json();
  if (json.ok) {
    window.toast.success(`已写入：前端 ${json.written.frontend} 条，后端 ${json.written.backend} 条`);
    if (json.skipped.length > 0) {
      window.toast.error(`跳过：${json.skipped.map((s) => s.error).join('; ')}`);
    }
  } else {
    window.toast.error('写入失败: ' + json.error);
  }
}

function parsePreviewContent(text) {
  // 从预览框编辑的内容逆向解析
  const feMatch = text.match(/【前端条目】\n([\s\S]*?)(?=【后端条目】|$)/);
  const beMatch = text.match(/【后端条目】\n([\s\S]*?)$/);
  
  const frontend = feMatch
    ? feMatch[1]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && l !== '（无）')
    : [];
  
  const backend = beMatch
    ? beMatch[1]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && l !== '（无）')
    : [];
  
  return { frontend, backend };
}
```

**注意：** 这里重复定义了 `extractPitfalls` 与 `splitPitfallsByProject`，本应由后端 req-logic.js 导出。现改为前端直接实现，避免 ES6 模块跨域障碍。

- [ ] **Step 2: 从 req-logic.js 抽出规则处理函数到前端**

实际上前端需要 `extractPitfalls` 与 `splitPitfallsByProject` 两个函数（无 IO，纯文本处理），复制它们到 req-retro.js 顶部：

```js
function extractPitfalls(text) {
  const match = text.match(/<!--\s*PITFALLS-BEGIN\s*-->([\s\S]*?)<!--\s*PITFALLS-END\s*-->/);
  return match ? match[0] : null;
}

function splitPitfallsByProject(pitfallsBlock) {
  const lines = pitfallsBlock
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'));
  
  const frontend = [];
  const backend = [];
  
  for (const line of lines) {
    const content = line.replace(/^-\s*/, '');
    if (content.startsWith('[前端]')) {
      frontend.push(content.replace(/^\[前端\]\s*/, ''));
    } else if (content.startsWith('[后端]')) {
      backend.push(content.replace(/^\[后端\]\s*/, ''));
    }
  }
  
  return { frontend, backend };
}
```

- [ ] **Step 3: 检查点 — node --check 语法通过**

运行 `node --check public/js/req-retro.js`，确保无语法错误。

---

### Task 10: 前端样式 — app.css 会话树与预览框样式

**文件:**
- Modify: `public/app.css:3000-3200`

---

**说明：** 会话树行、预览框等样式。

- [ ] **Step 1: 新增会话树样式**

在 `public/app.css` 末尾加入：

```css
      /* ---- 需求会话树 ---- */
      .req-sessions-tree {
        margin-left: 20px;
        padding: 8px 0;
        border-left: 1px solid var(--border-soft);
      }

      .req-session-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        margin: 2px 0;
        border-radius: 6px;
        font-size: 12.5px;
        cursor: pointer;
      }

      .req-session-item:hover {
        background: var(--panel);
      }

      .req-session-item .q-btn {
        display: none;
      }

      .req-session-item:hover .q-btn {
        display: flex;
      }

      .req-session-light {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #f59e0b;
        animation: pulse 1s infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .req-retro-btn {
        margin-bottom: 12px;
      }

      /* ---- 避坑清单预览框 ---- */
      .req-pitfalls-preview {
        display: block;
        width: 100%;
        box-sizing: border-box;
        min-height: 150px;
        padding: 9px 11px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--panel);
        color: var(--text);
        font-family: inherit;
        font-size: 12.5px;
        line-height: 1.5;
        resize: vertical;
      }

      .req-pitfalls-preview:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-soft);
      }
```

- [ ] **Step 2: 补充箭头样式**

```css
      .req-arrow {
        display: inline-block;
        min-width: 14px;
        text-align: center;
        font-size: 12px;
        color: var(--muted);
        user-select: none;
      }

      .req-arrow:hover {
        color: var(--text);
      }
```

- [ ] **Step 3: 检查点 — 无语法错误**

打开浏览器开发者工具，检查 app.css 加载是否有错误。

---

### Task 11: 集成 req-retro 与 req-view — 钩子与完整流程

**文件:**
- Modify: `public/js/req-chat.js:160-180` (轮询钩子)
- Modify: `public/js/req-view.js` (导入 req-retro)

---

**说明：** 归档期轮询检测 retro 会话是否完成，完成后触发规则提取与预览。

- [ ] **Step 1: req-view.js 补充 retro 导入与调用**

已在 Task 8 Step 7 加入，确认：

```js
import { startRetroSummary } from './req-retro.js';
```

- [ ] **Step 2: req-chat.js 轮询补钩子**

修改 `req-chat.js` 的 3s 轮询逻辑（约 160-180 行），在更新 busy 和左栏后补钩子：

```js
      // 3s 轮询更新
      const poll = async () => {
        // ... 原有 getRequirement / updateBusy / renderChrome ...
        
        // ★ 新增：retro 会话完成后提取规则（新增）
        const conv = loadConvs().find((c) => c.id === currentConvId);
        if (conv && conv.meta?.kind === 'retro' && data.phase === 'archiving') {
          // 这是一个 retro 会话，若当前没有 pending 任务，说明已完成
          const isRunning = isConvRunning(currentConvId);
          if (!isRunning && conv.messages?.length > 0) {
            // 已完成，提取规则
            const { extractAndPreviewPitfalls } = await import('./req-retro.js');
            extractAndPreviewPitfalls(currentConvId, data.id);
          }
        }
      };
```

需导入 `isConvRunning`（已在 Task 6 导出）。

- [ ] **Step 3: 检查点 — node --check 语法通过**

运行 `node --check public/js/req-chat.js`，确保无语法错误。

---

### Task 12: 后端集成 — 导入与路由挂接

**文件:**
- Modify: `src/entrypoints/web/routes-requirements.js:1-20`

---

**说明：** 在路由顶部导入新增的纯函数与 req-pitfalls 模块。

- [ ] **Step 1: 补充后端导入**

在 `src/entrypoints/web/routes-requirements.js` 顶部（导入段）加入：

```js
import {
  buildSeedPrompt,
  extractPitfalls,
  splitPitfallsByProject,
  mergePitfalls,
  normalizeSessions,  // 来自 requirements.js
} from './req-logic.js';

import { writePitfalls, ensureClaudeMdRef } from './req-pitfalls.js';
```

并确认 `normalizeSessions` 在 requirements.js 顶部已导出：

```js
export function normalizeSessions(req) { ... }
```

- [ ] **Step 2: 检查点 — npm test 全绿**

运行 `npm test`，确保所有后端单测、路由测试全部通过（特别是 routes-requirements.test.js）。

---

### Task 13: 前端集成测试 — e2e-req-review 扩用例

**文件:**
- Modify: `tests/e2e-req-review.mjs` (新增用例)

---

**说明：** 补充 e2e 用例覆盖会话树、新会话、优化汇总流程（但不真跑 docgen/develop，仅验证 UI 与后端联通）。

- [ ] **Step 1: 阅读现有 e2e-req-review 框架**

打开 `tests/e2e-req-review.mjs`，确认 playwright 初始化、导航流程、断言风格。

- [ ] **Step 2: 扩侧栏会话树用例**

在末尾加入：

```js
      // ---- 侧栏会话树：新建子会话、查看运行灯 ----
      test('侧栏会话树：展开需求行显示会话列表，含运行灯', async () => {
        // 点击展开箭头
        const arrow = page.locator('.req-arrow');
        await arrow.click();
        
        // 验证会话子树出现
        await expect(page.locator('.req-sessions-tree')).toBeVisible();
        
        // 验证主会话行（⚡ 标记）
        await expect(page.locator('.req-session-item', { hasText: '⚡' })).toBeVisible();
        
        // 验证新会话按钮
        const newBtn = page.locator('.req-sessions-tree button', { hasText: '新会话' });
        await expect(newBtn).toBeVisible();
      });

      test('新建子会话：输入标题后创建', async () => {
        // 点击新会话
        const newBtn = page.locator('.req-sessions-tree button', { hasText: '新会话' });
        await newBtn.click();
        
        // 对话框输入标题
        const dialog = page.locator('.modal');
        const input = dialog.locator('input');
        await input.fill('调试会话');
        await dialog.locator('button', { hasText: '确认' }).click();
        
        // 验证新会话出现在侧栏
        await expect(page.locator('.req-session-item', { hasText: '调试会话' })).toBeVisible();
      });
```

- [ ] **Step 3: 扩归档期优化汇总用例**

```js
      // 流转到 archiving 期
      // ... (现有流转逻辑) ...

      test('归档期：优化汇总按钮可见', async () => {
        await expect(page.locator('button', { hasText: '优化汇总' })).toBeVisible();
      });

      test('优化汇总：创建 retro 会话并预览规则（模拟）', async () => {
        const retroBtn = page.locator('button', { hasText: '优化汇总' });
        await retroBtn.click();
        
        // 验证 retro 会话出现并切到聊天视图
        await expect(page.locator('.composer')).toBeVisible();
        
        // ★ 注意：此处不实际运行 docgen/claude 任务（会烧额度）
        // 只验证 UI 联通正常。完整的 retro 流程需要实际 Claude 回答，
        // 应在真机走查或隔离的集成环境中测试。
      });
```

- [ ] **Step 4: 检查点 — node tests/e2e-req-review.mjs 通过**

运行 e2e 测试（仅验证 UI，不烧额度）：

```bash
node tests/e2e-req-review.mjs
```

预期输出：所有新用例通过（或标注为 skip，待真机）。

---

### Task 14: 检查点汇总 — 全量回归

**文件:**
- npm test
- node tests/e2e-req-review.mjs
- node --check public/js/*.js

---

**说明：** 最终全量回归，确保所有改动互相无冲突。

- [ ] **Step 1: 后端单测全绿**

运行 `npm test`，预期输出：

```
✓ src/store/requirements.test.js — X tests ... passed
✓ src/entrypoints/web/req-logic.test.js — X tests ... passed
✓ src/entrypoints/web/req-pitfalls.test.js — X tests ... passed
✓ src/entrypoints/web/routes-requirements.test.js — X tests ... passed
✓ public/js/util.render.test.js — X tests ... passed
```

所有测试绿灯。

- [ ] **Step 2: 前端语法检查**

```bash
node --check public/js/conv-store.js
node --check public/js/chat.js
node --check public/js/ui.js
node --check public/js/req-view.js
node --check public/js/req-retro.js
node --check public/js/req-chat.js
```

全部通过，无 SyntaxError。

- [ ] **Step 3: CSS 校验**

用浏览器开发者工具打开 app.css，检查新增 `.req-sessions-tree` / `.req-session-item` / `.req-pitfalls-preview` 等 class 是否被正确引用、无悬挂规则。

- [ ] **Step 4: e2e 冒烟**

```bash
node tests/e2e-req-review.mjs
```

预期：新增用例通过（或标注为待真机）。

- [ ] **Step 5: 手工真机走查（非自动化）**

按 spec §8 验收清单第 1-12 项手工走一遍：
1. 老需求侧栏展开 → ⚡ 自动开发会话，无删除按钮 ✓
2. 新会话 → 未起 run，不烧额度 ✓
3. 新会话发第一句 → 拼了种子 ✓
4. 第二句 → 无种子 ✓
5. 并行两会话 → 两条运行灯，互不阻塞 ✓
6. 刷新 → 会话树恢复，进行中的接流 ✓
7. bug-fix 派发到主会话，子会话不阻塞 ✓
8. 归档期点优化汇总 → retro 会话，逐条小结 ✓
9. 预览框可编辑 ✓
10. CLAUDE.md 有引用 ✓
11. 再次汇总 → 去重合并，≤30 条 ✓
12. 归档档案有完整报告 ✓

---

## 总结

**14 个任务、40+ 个步骤、零 git 提交。** 实现核心功能：
- 后端 sessions[] 数据模型与 normalize 迁移
- POST /api/req/session 回填接口与 DELETE 删除
- POST /api/req/pitfalls 规则写入接口
- 前端 conv-store 单 conv 操作（title/delete/meta）
- chat.js 种子前置拼接 + SSE 回填
- req-view.js 侧栏会话树与展开/新增/删除
- req-retro.js map-reduce 编排、规则提取、预览确认
- ui.js textareaDialog 多行输入框
- 全 CSS 样式补全
- e2e 冒烟覆盖

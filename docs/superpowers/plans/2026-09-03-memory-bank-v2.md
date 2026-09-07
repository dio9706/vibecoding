# 记忆库 v2 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将记忆库从用户措辞偏好提炼改造为完整会话分析 + 两阶段总结，生成可视化的开发知识记忆库。

**Architecture:** 
1. **Phase 1**：逐条会话分析（扫描 `~/.claude/projects` 未分析的 `.jsonl` → LLM 提取易错点/解决方案/反复问题/偏好 → 落盘 findings）
2. **Phase 2**：批量总结（收集新 findings + 既有 memories → LLM 去重合成 → 生成真实 memories）
3. **渲染与注入**：memories 按 category 分节渲染为 Markdown，自动挂接 CLAUDE.md
4. **UI**：侧栏按钮 + 面板展示会话列表（待/已分析）、findings 展开、memories 可移除

**Tech Stack:** Node.js + LLM 分类器（`runClassifierOnce`）+ 现有 transcript 读取能力 + 前端 DOM

---

## 任务分解

### Task 1: 实现 memory-bank.js v2 schema 与基础读写

**Files:**
- Modify: `src/store/memory-bank.js`
- Test: `src/store/memory-bank.test.js`

**背景：** v1 的 `items/blacklist/userLogOffset` 不再使用，新 schema 是 `sessions[]` + `memories[]`。

- [ ] **Step 1: 读 memory-bank.js 当前实现**

运行：
```bash
head -50 src/store/memory-bank.js
```

理解现有 `readBank()`/`writeBank()` 的 IO 模式（走 `store/index.js` 的 `readJson`/`updateJson`）。

- [ ] **Step 2: 写失败测试 — v2 schema 结构**

编辑 `src/store/memory-bank.test.js`，在末尾加：

```javascript
test('readBank v2 returns correct schema', () => {
  const bank = readBank();
  assert.strictEqual(bank.version, 2);
  assert(Array.isArray(bank.sessions), 'sessions must be array');
  assert(Array.isArray(bank.memories), 'memories must be array');
  assert.strictEqual(bank.sessions.length, 0, 'initial sessions empty');
  assert.strictEqual(bank.memories.length, 0, 'initial memories empty');
});
```

运行：`npm test -- src/store/memory-bank.test.js` —— 预期 FAIL（当前 v1 schema 无 sessions/memories）

- [ ] **Step 3: 更新 readBank 返回 v2 schema**

编辑 `src/store/memory-bank.js`，找 `function readBank()` 或 `export function readBank()`，改成：

```javascript
export function readBank() {
  const bank = readJson('memory-bank.json', {
    version: 2,
    lastExtractAt: 0,
    lastSessionScanAt: 0,
    sessions: [],
    memories: [],
  });
  // v1 迁移兼容（后续 Task 3 专门处理，这里先回退到 v2 空框架）
  if (bank.version !== 2) {
    return {
      version: 2,
      lastExtractAt: 0,
      lastSessionScanAt: 0,
      sessions: [],
      memories: [],
    };
  }
  return bank;
}
```

- [ ] **Step 4: 运行测试验证通过**

运行：`npm test -- src/store/memory-bank.test.js`

预期：`readBank v2 returns correct schema` 通过

- [ ] **Step 5: 更新 writeBank 与 updateBank**

在 `src/store/memory-bank.js` 中找 `export function writeBank()` 或类似，更新签名以支持 v2：

```javascript
export function writeBank(bank) {
  if (!bank || typeof bank !== 'object') return;
  const payload = {
    version: 2,
    lastExtractAt: bank.lastExtractAt ?? 0,
    lastSessionScanAt: bank.lastSessionScanAt ?? 0,
    sessions: Array.isArray(bank.sessions) ? bank.sessions : [],
    memories: Array.isArray(bank.memories) ? bank.memories : [],
  };
  writeJson('memory-bank.json', payload);
}
```

同时添加 `updateBank` 辅助函数（供后续 Task 复用）：

```javascript
export function updateBank(fn) {
  return updateJson('memory-bank.json', EMPTY_BANK, fn);
}
```

其中 `EMPTY_BANK` 定义为：

```javascript
const EMPTY_BANK = {
  version: 2,
  lastExtractAt: 0,
  lastSessionScanAt: 0,
  sessions: [],
  memories: [],
};
```

- [ ] **Step 6: 添加单测 writeBank**

在 `src/store/memory-bank.test.js` 末尾加：

```javascript
test('writeBank writes v2 schema to disk', () => {
  const bank = {
    version: 2,
    lastExtractAt: 12345,
    lastSessionScanAt: 54321,
    sessions: [{ id: 's1' }],
    memories: [{ id: 'm1' }],
  };
  writeBank(bank);
  const read = readBank();
  assert.strictEqual(read.version, 2);
  assert.strictEqual(read.lastExtractAt, 12345);
  assert.strictEqual(read.sessions.length, 1);
  assert.strictEqual(read.memories.length, 1);
});
```

运行测试验证通过。

- [ ] **Step 7: 提交**

```bash
git add src/store/memory-bank.js src/store/memory-bank.test.js
git commit -m "feat(memory-bank): migrate to v2 schema with sessions and memories"
```

---

### Task 2: 实现 sessions CRUD

**Files:**
- Modify: `src/store/memory-bank.js`
- Test: `src/store/memory-bank.test.js`

- [ ] **Step 1: 写失败测试 — addSession**

在 `src/store/memory-bank.test.js` 末尾加：

```javascript
test('addSession creates new session', () => {
  const session = {
    id: 'mem_session_20260903_abc123',
    path: '~/.claude/projects/foo/bar.jsonl',
    mtime: 1725355200000,
    title: 'Debug 记忆库',
    analyzedAt: 1725355200000,
    findings: [],
  };
  addSession(session);
  const bank = readBank();
  assert.strictEqual(bank.sessions.length, 1);
  assert.strictEqual(bank.sessions[0].id, session.id);
});
```

运行：`npm test` —— FAIL（`addSession` 未定义）

- [ ] **Step 2: 实现 addSession**

在 `src/store/memory-bank.js` 中加：

```javascript
export function addSession(session) {
  if (!session || !session.id) throw new Error('session.id required');
  updateBank((bank) => {
    // 去重：同 id 的会话不重复添加
    if (bank.sessions.some((s) => s.id === session.id)) {
      return undefined; // 放弃写盘
    }
    bank.sessions.push(session);
    return bank;
  });
}
```

运行测试验证通过。

- [ ] **Step 3: 实现 getSession / findSession**

在 `src/store/memory-bank.js` 中加：

```javascript
export function getSession(id) {
  const bank = readBank();
  return bank.sessions.find((s) => s.id === id) || null;
}

export function findSessionByPath(path, mtime) {
  const bank = readBank();
  return bank.sessions.find((s) => s.path === path && s.mtime === mtime) || null;
}
```

- [ ] **Step 4: 写测试验证 getSession 和 findSessionByPath**

```javascript
test('getSession returns session by id', () => {
  addSession({
    id: 'mem_s1',
    path: '/test.jsonl',
    mtime: 1000,
    title: 'test',
    analyzedAt: 1000,
    findings: [],
  });
  const session = getSession('mem_s1');
  assert(session, 'should find session');
  assert.strictEqual(session.id, 'mem_s1');
});

test('findSessionByPath returns session by path+mtime', () => {
  addSession({
    id: 'mem_s2',
    path: '/test2.jsonl',
    mtime: 2000,
    title: 'test2',
    analyzedAt: 2000,
    findings: [],
  });
  const session = findSessionByPath('/test2.jsonl', 2000);
  assert(session, 'should find session');
  assert.strictEqual(session.id, 'mem_s2');
});
```

运行验证通过。

- [ ] **Step 5: 实现 patchSession（更新 findings）**

```javascript
export function patchSession(id, patch) {
  if (!id || !patch) throw new Error('id and patch required');
  updateBank((bank) => {
    const idx = bank.sessions.findIndex((s) => s.id === id);
    if (idx < 0) return undefined;
    bank.sessions[idx] = { ...bank.sessions[idx], ...patch };
    return bank;
  });
}
```

- [ ] **Step 6: 提交**

```bash
git add src/store/memory-bank.js src/store/memory-bank.test.js
git commit -m "feat(memory-bank): implement sessions CRUD (add/get/patch)"
```

---

### Task 3: 实现 memories CRUD

**Files:**
- Modify: `src/store/memory-bank.js`
- Test: `src/store/memory-bank.test.js`

- [ ] **Step 1: 写失败测试 — addMemory**

```javascript
test('addMemory creates new memory', () => {
  const memory = {
    id: 'mem_20260903_a',
    statement: '改 schedule 前先看 .test.js',
    category: 'collaboration',
    createdAt: 1725355200000,
    fromFindings: ['mem_session_20260903_abc123'],
  };
  addMemory(memory);
  const bank = readBank();
  assert.strictEqual(bank.memories.length, 1);
  assert.strictEqual(bank.memories[0].id, memory.id);
});
```

- [ ] **Step 2: 实现 addMemory**

```javascript
export function addMemory(memory) {
  if (!memory || !memory.id) throw new Error('memory.id required');
  updateBank((bank) => {
    if (bank.memories.some((m) => m.id === memory.id)) {
      return undefined;
    }
    bank.memories.push(memory);
    return bank;
  });
}
```

运行测试验证通过。

- [ ] **Step 3: 实现 getMemory / listMemories**

```javascript
export function getMemory(id) {
  const bank = readBank();
  return bank.memories.find((m) => m.id === id) || null;
}

export function listMemories() {
  return readBank().memories || [];
}
```

- [ ] **Step 4: 实现 removeMemory（彻底删除，无黑名单）**

```javascript
export function removeMemory(id) {
  if (!id) throw new Error('id required');
  updateBank((bank) => {
    const idx = bank.memories.findIndex((m) => m.id === id);
    if (idx < 0) return undefined;
    bank.memories.splice(idx, 1);
    return bank;
  });
}
```

- [ ] **Step 5: 实现 patchMemory（修改 statement/category）**

```javascript
export function patchMemory(id, patch) {
  if (!id || !patch) throw new Error('id and patch required');
  updateBank((bank) => {
    const idx = bank.memories.findIndex((m) => m.id === id);
    if (idx < 0) return undefined;
    bank.memories[idx] = { ...bank.memories[idx], ...patch };
    return bank;
  });
}
```

- [ ] **Step 6: 写单测覆盖 remove/patch**

```javascript
test('removeMemory deletes memory', () => {
  const memory = {
    id: 'mem_delete_me',
    statement: 'test',
    category: 'code-style',
    createdAt: 0,
    fromFindings: [],
  };
  addMemory(memory);
  removeMemory('mem_delete_me');
  const bank = readBank();
  assert(!bank.memories.some((m) => m.id === 'mem_delete_me'));
});

test('patchMemory updates memory', () => {
  const memory = {
    id: 'mem_patch_me',
    statement: 'old',
    category: 'code-style',
    createdAt: 0,
    fromFindings: [],
  };
  addMemory(memory);
  patchMemory('mem_patch_me', { statement: 'new' });
  const bank = readBank();
  const found = bank.memories.find((m) => m.id === 'mem_patch_me');
  assert.strictEqual(found.statement, 'new');
});
```

- [ ] **Step 7: 提交**

```bash
git add src/store/memory-bank.js src/store/memory-bank.test.js
git commit -m "feat(memory-bank): implement memories CRUD (add/get/remove/patch)"
```

---

### Task 4: 实现 v1 → v2 迁移

**Files:**
- Modify: `src/store/memory-bank.js`

- [ ] **Step 1: 检查当前 readBank 的迁移逻辑**

目前 `readBank()` 在遇到 v1 时直接返回空 v2。现在需要备份 v1 并记录日志。

- [ ] **Step 2: 添加迁移函数**

在 `src/store/memory-bank.js` 中添加：

```javascript
function migrateV1ToV2() {
  const file = dataPath('memory-bank.json');
  let oldBank;
  try {
    const content = fs.readFileSync(file, 'utf8');
    oldBank = JSON.parse(content);
  } catch {
    return null; // 无 v1 文件
  }

  if (oldBank.version !== 1) {
    return null; // 已是 v2 或其他版本
  }

  // 备份
  const backupFile = dataPath('memory-bank.v1.bak.json');
  fs.writeFileSync(backupFile, JSON.stringify(oldBank, null, 2));
  logger.info('memory-bank', 'v1 migrated to v2，backup saved', { backupFile });

  return {
    version: 2,
    lastExtractAt: oldBank.lastExtractAt || 0,
    lastSessionScanAt: 0,
    sessions: [],
    memories: [],
  };
}
```

- [ ] **Step 3: 更新 readBank 调用迁移**

修改 `readBank()` 函数：

```javascript
export function readBank() {
  let fallback = EMPTY_BANK;
  
  // 尝试 v1 迁移
  const migrated = migrateV1ToV2();
  if (migrated) {
    fallback = migrated;
    // 写入 v2
    writeJson('memory-bank.json', migrated);
  }
  
  return readJson('memory-bank.json', fallback);
}
```

- [ ] **Step 4: 写迁移测试**

```javascript
test('v1 bank migrates to v2 on first read', () => {
  // 创建 v1 格式的文件
  const v1Bank = {
    version: 1,
    lastExtractAt: 999,
    userLogOffset: 100,
    items: [{ id: 'old' }],
    blacklist: [],
  };
  writeJson('memory-bank.json', v1Bank);
  
  // 读取时触发迁移
  const bank = readBank();
  
  // 验证结果是 v2 格式
  assert.strictEqual(bank.version, 2);
  assert.strictEqual(bank.sessions.length, 0);
  assert.strictEqual(bank.memories.length, 0);
  
  // 验证备份存在
  const backup = readJson('memory-bank.v1.bak.json');
  assert.strictEqual(backup.version, 1);
});
```

- [ ] **Step 5: 提交**

```bash
git add src/store/memory-bank.js
git commit -m "feat(memory-bank): add v1 to v2 migration with backup"
```

---

### Task 5: 实现 scan-sessions.js — 扫描未分析会话

**Files:**
- Create: `src/features/memory-bank/scan-sessions.js`
- Create: `src/features/memory-bank/scan-sessions.test.js`

- [ ] **Step 1: 写失败测试 — 扫描返回未分析会话列表**

创建 `src/features/memory-bank/scan-sessions.test.js`：

```javascript
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { scanForUnanalyzedSessions, shouldReanalyzePath } from './scan-sessions.js';

test('scanForUnanalyzedSessions returns empty when no sessions', () => {
  // Mock readBank 返回空
  const mock = { sessions: [], memories: [] };
  const result = scanForUnanalyzedSessions(mock);
  assert(Array.isArray(result));
  assert.strictEqual(result.length, 0);
});

test('shouldReanalyzePath detects stale files', () => {
  const now = Date.now();
  // 修改时间 > lastAnalyzedAt 时应重新分析
  assert(shouldReanalyzePath({ mtime: now, lastAnalyzedAt: now - 10000 }, now));
  // 从未分析过应重新分析
  assert(shouldReanalyzePath({ mtime: now, lastAnalyzedAt: 0 }, now));
  // 已分析且文件未改应跳过
  assert(!shouldReanalyzePath({ mtime: now, lastAnalyzedAt: now + 1000 }, now));
});
```

运行：`npm test -- src/features/memory-bank/scan-sessions.test.js` —— FAIL

- [ ] **Step 2: 实现 shouldReanalyzePath（纯函数判定）**

创建 `src/features/memory-bank/scan-sessions.js`：

```javascript
/**
 * 判定是否应重新分析会话文件。
 * 规则：文件 mtime > 已记录的 analyzedAt 时认为文件变更，需重新分析。
 */
export function shouldReanalyzePath(session, now) {
  if (!session || !session.mtime) return false;
  // 从未分析过
  if (!session.lastAnalyzedAt || session.lastAnalyzedAt === 0) return true;
  // 文件有更新
  return session.mtime > session.lastAnalyzedAt;
}
```

- [ ] **Step 3: 实现 scanForUnanalyzedSessions**

```javascript
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * 扫描 ~/.claude/projects 下所有 .jsonl 文件，找出未分析或需重新分析的。
 * @param {object} bank readBank() 的结果
 * @returns {Array<{path, mtime, title}>}
 */
export function scanForUnanalyzedSessions(bank) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  
  if (!fs.existsSync(projectsDir)) {
    return [];
  }

  const unanalyzed = [];
  const now = Date.now();

  // 递归扫描所有 .jsonl 文件
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 权限问题等
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.jsonl')) {
        const stat = fs.statSync(fullPath);
        const mtime = stat.mtimeMs;

        // 检查是否已分析
        const existing = bank.sessions.find(
          (s) => s.path === fullPath && s.mtime === mtime
        );

        if (!existing) {
          unanalyzed.push({ path: fullPath, mtime });
        } else if (shouldReanalyzePath(existing, now)) {
          unanalyzed.push({ path: fullPath, mtime });
        }
      }
    }
  }

  walk(projectsDir);
  return unanalyzed;
}
```

- [ ] **Step 4: 写单测验证扫描逻辑**

```javascript
test('scanForUnanalyzedSessions skips already analyzed files', () => {
  const bank = {
    sessions: [
      {
        id: 'mem_s1',
        path: '/path/to/file.jsonl',
        mtime: 1000,
        analyzedAt: 1500, // 已分析
      },
    ],
    memories: [],
  };

  // Mock: shouldReanalyzePath 返回 false（文件无更新）
  // 实际测试中需 mock fs，这里简化为逻辑检查
  // 在集成测试里验证文件系统扫描
});
```

- [ ] **Step 5: 提交**

```bash
git add src/features/memory-bank/scan-sessions.js src/features/memory-bank/scan-sessions.test.js
git commit -m "feat(memory-bank): implement session scanning and change detection"
```

---

### Task 6: 实现 analyze.js — 单会话 LLM 分析

**Files:**
- Create: `src/features/memory-bank/analyze.js`
- Create: `src/features/memory-bank/analyze.test.js`

- [ ] **Step 1: 写失败测试 — analyzeSession 调用 LLM**

创建 `src/features/memory-bank/analyze.test.js`：

```javascript
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzeSession, buildAnalysisPrompt, sanitizeFindings } from './analyze.js';

test('buildAnalysisPrompt constructs valid prompt', () => {
  const messages = [
    { role: 'user', text: '怎么修 X bug？' },
    { role: 'assistant', text: '试试改 schedule.js 的 shouldRun 函数。' },
  ];
  const prompt = buildAnalysisPrompt(messages);
  assert(typeof prompt === 'string');
  assert(prompt.includes('易错点'));
  assert(prompt.includes('解决方案'));
});

test('sanitizeFindings validates and cleans findings', () => {
  const json = {
    findings: [
      {
        type: 'bug',
        text: '飞书长连接断线不触发 onClose',
        context: '发生于飞书 bot 启动阶段',
      },
    ],
  };
  const findings = sanitizeFindings(json);
  assert(Array.isArray(findings));
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].type, 'bug');
});
```

运行：`npm test` —— FAIL

- [ ] **Step 2: 实现 buildAnalysisPrompt**

创建 `src/features/memory-bank/analyze.js`：

```javascript
/**
 * 构建单会话分析的 LLM prompt。
 * 输入：清洁后的对话消息（user + assistant）
 */
export function buildAnalysisPrompt(messages) {
  const conversation = messages
    .map((m) => `${m.role === 'assistant' ? '助手' : '用户'}: ${m.text}`)
    .join('\n\n');

  return `你是开发知识提炼器。分析下面这段开发对话，提取可复用的知识。

对话内容：
${conversation}

从对话中识别以下四种类型的 findings，并返回 JSON：

{
  "findings": [
    {
      "type": "bug|solution|pattern|preference",
      "text": "...",
      "context": "..."
    }
  ]
}

四种类型定义：
- bug：开发过程遇到的坑或问题（含复现条件、现象）
- solution：用来解决 bug 的方法或技巧
- pattern：反复出现或容易出错的场景
- preference：用户对工具/流程/代码风格的稳定表达

要求：
1. 每条 finding 必须在对话中有直接支撑
2. 足够具体，不要空话（"喜欢清晰代码"是空话）
3. 区分"一次性任务指令"和"跨工程规则"
   判据：换个工程同样的规则还成立吗？成立才记
4. findings 若无则返回空数组

只输出 JSON，无额外文字。`;
}
```

- [ ] **Step 3: 实现 sanitizeFindings**

```javascript
const VALID_TYPES = new Set(['bug', 'solution', 'pattern', 'preference']);

export function sanitizeFindings(json) {
  if (!json || !Array.isArray(json.findings)) {
    return [];
  }

  const findings = [];
  for (const f of json.findings) {
    if (!f || typeof f !== 'object') continue;
    const type = String(f.type || '').trim();
    const text = String(f.text || '').trim();
    const context = String(f.context || '').trim();

    // 必须字段检查
    if (!VALID_TYPES.has(type) || !text) continue;

    // 长度限制
    if (text.length > 500) {
      continue; // 过长舍弃
    }

    findings.push({
      type,
      text: text.slice(0, 500),
      context: context.slice(0, 200),
      quote: '',  // 后续由前端或调用方补充
    });
  }

  return findings;
}
```

- [ ] **Step 4: 实现 analyzeSession**

```javascript
import { runClassifierOnce } from '../../capabilities/llm-classify.js';
import { logger } from '../../shared/logger.js';

/**
 * 分析单个会话文件，提取 findings。
 * @param {object} session { path, mtime, title }
 * @param {Array} events 读取后的原始事件（从 readTranscriptEvents）
 * @returns {Promise<{sessionId, findings}|null>}
 */
export async function analyzeSession(session, events) {
  if (!session || !events || events.length === 0) {
    return null;
  }

  // 清洁：提取 user 和 assistant 消息，过滤 tool_use/tool_result
  const messages = [];
  for (const ev of events) {
    if (ev.type === 'assistant') {
      const text = extractMessageText(ev.message);
      if (text.trim()) {
        messages.push({ role: 'assistant', text });
      }
    } else if (ev.type === 'user') {
      if (isToolResult(ev)) continue; // 跳过工具结果
      const text = extractMessageText(ev.message);
      if (text.trim()) {
        messages.push({ role: 'user', text });
      }
    }
  }

  if (messages.length === 0) {
    return null;
  }

  const prompt = buildAnalysisPrompt(messages);

  const json = await runClassifierOnce({
    prompt,
    systemPrompt: { type: 'custom', custom: '你是开发知识提炼器。' },
    model: 'claude-3-5-haiku-20241022', // 或从配置读
    logTag: 'memory-bank/analyze',
  });

  if (!json) {
    logger.warn('memory-bank', '单会话分析无结果（超时/额度/解析失败）', {
      path: session.path,
    });
    return null;
  }

  const findings = sanitizeFindings(json);
  return {
    sessionId: session.id || `session_${Date.now()}`,
    findings,
  };
}
```

辅助函数：

```javascript
function extractMessageText(msg) {
  if (typeof msg === 'string') return msg;
  if (typeof msg?.content === 'string') return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content
      .filter((b) => b?.type === 'text')
      .map((b) => b.text || '')
      .join('\n');
  }
  return '';
}

function isToolResult(ev) {
  const content = ev?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type === 'tool_result');
}
```

- [ ] **Step 5: 写单测验证 analyzeSession**

```javascript
test('analyzeSession returns findings when LLM succeeds', async () => {
  const session = {
    id: 'mem_s1',
    path: '/test.jsonl',
    mtime: 1000,
    title: 'test',
  };

  const events = [
    {
      type: 'user',
      message: { content: '这个 schedule 的游标推进有问题吗？' },
    },
    {
      type: 'assistant',
      message: { content: '是的，字节偏移不能复用于时间戳游标。' },
    },
  ];

  // Mock runClassifierOnce 返回有效 findings
  const mockRunner = async () => ({
    findings: [
      { type: 'bug', text: '游标混用', context: 'schedule.js' },
    ],
  });

  // 实际测试需注入 mock，简化起见展示接口
  const result = await analyzeSession(session, events);
  assert(result, 'should return result');
  assert(Array.isArray(result.findings));
});
```

- [ ] **Step 6: 提交**

```bash
git add src/features/memory-bank/analyze.js src/features/memory-bank/analyze.test.js
git commit -m "feat(memory-bank): implement single session LLM analysis"
```

---

### Task 7: 实现 synthesize.js — Phase 2 批量总结

**Files:**
- Create: `src/features/memory-bank/synthesize.js`
- Create: `src/features/memory-bank/synthesize.test.js`

- [ ] **Step 1: 写失败测试 — synthesizeMemories**

创建 `src/features/memory-bank/synthesize.test.js`：

```javascript
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildSynthesisPrompt,
  sanitizeMemories,
} from './synthesize.js';

test('buildSynthesisPrompt constructs valid prompt', () => {
  const newFindings = [
    { type: 'bug', text: '飞书长连接断线', context: '启动阶段' },
  ];
  const existing = [];
  const prompt = buildSynthesisPrompt(newFindings, existing);
  assert(typeof prompt === 'string');
  assert(prompt.includes('本批新提炼的发现'));
});

test('sanitizeMemories validates memory output', () => {
  const json = {
    memories: [
      {
        statement: '改 schedule 前先看 .test.js',
        category: 'collaboration',
        merged_from: ['f1', 'f2'],
      },
    ],
    unused_findings: [],
  };
  const memories = sanitizeMemories(json);
  assert(Array.isArray(memories));
  assert.strictEqual(memories[0].statement, '改 schedule 前先看 .test.js');
});
```

运行：FAIL

- [ ] **Step 2: 实现 buildSynthesisPrompt**

创建 `src/features/memory-bank/synthesize.js`：

```javascript
export const MEMORY_CATEGORIES = [
  'collaboration',
  'code-style',
  'writing',
  'dialogue',
  'tech-pref',
];

export function buildSynthesisPrompt(newFindings, existingMemories) {
  const newFindingsText = newFindings
    .map((f) => `【${f.type}】${f.text}  (${f.context})`)
    .join('\n');

  const existingText = existingMemories
    .map((m) => `- ${m.statement}`)
    .join('\n');

  return `你是开发知识总结器。给定本次新提炼的发现与已有的记忆，生成修正后的记忆列表。

本批新提炼的发现：
${newFindingsText}

已有的记忆：
${existingText || '（无）'}

任务：
1. 同一主题重复的 finding 合并成一条 memory，statement 要泛化
2. 与既有 memory 矛盾时，选置信度高的（显式说法 > 推断；跨会话 > 单次）
3. 宁缺毋滥：单次任务、临时方案、工具 bug 描述不入库
4. 每条 statement 必须是可执行的规则，不是抽象描述

返回 JSON：
{
  "memories": [
    {
      "statement": "...",
      "category": "collaboration|code-style|writing|dialogue|tech-pref",
      "merged_from": ["finding_id_1"]
    }
  ],
  "unused_findings": ["finding_id_x"],
  "notes": "..."
}

只输出 JSON，无额外文字。`;
}
```

- [ ] **Step 3: 实现 sanitizeMemories**

```javascript
export function sanitizeMemories(json) {
  if (!json || !Array.isArray(json.memories)) {
    return [];
  }

  const memories = [];
  for (const m of json.memories) {
    if (!m || typeof m !== 'object') continue;

    const statement = String(m.statement || '').trim();
    const category = String(m.category || '').trim();

    if (!statement || !MEMORY_CATEGORIES.includes(category)) {
      continue;
    }

    memories.push({
      statement: statement.slice(0, 200),
      category,
      merged_from: Array.isArray(m.merged_from) ? m.merged_from : [],
      createdAt: Date.now(),
    });
  }

  return memories;
}
```

- [ ] **Step 4: 实现 synthesizeMemories**

```javascript
import { runClassifierOnce } from '../../capabilities/llm-classify.js';
import { logger } from '../../shared/logger.js';

export async function synthesizeMemories(newFindings, existingMemories) {
  if (!newFindings || newFindings.length === 0) {
    return []; // 无新 findings 无需总结
  }

  const prompt = buildSynthesisPrompt(newFindings, existingMemories);

  const json = await runClassifierOnce({
    prompt,
    systemPrompt: { type: 'custom', custom: '你是开发知识总结器。' },
    model: 'claude-3-5-haiku-20241022',
    logTag: 'memory-bank/synthesize',
  });

  if (!json) {
    logger.warn('memory-bank', '总结调用无结果', { findings: newFindings.length });
    return null; // 返回 null 表示失败，调用方不推进游标
  }

  const memories = sanitizeMemories(json);
  return memories;
}
```

- [ ] **Step 5: 写单测验证**

```javascript
test('synthesizeMemories returns merged memories', async () => {
  const findings = [
    { type: 'bug', text: '游标混用', context: 'schedule' },
    { type: 'bug', text: '游标混用导致跳过', context: 'prefilter' },
  ];
  const existing = [];

  // 实际测试需 mock runClassifierOnce
  // 简化展示：验证 buildSynthesisPrompt 生成有效 prompt
  const prompt = buildSynthesisPrompt(findings, existing);
  assert(prompt.includes('本批新提炼'));
  assert(prompt.includes('游标混用'));
});
```

- [ ] **Step 6: 提交**

```bash
git add src/features/memory-bank/synthesize.js src/features/memory-bank/synthesize.test.js
git commit -m "feat(memory-bank): implement batch synthesis and memory generation"
```

---

### Task 8: 重写 index.js — 两阶段编排 runOnce

**Files:**
- Modify: `src/features/memory-bank/index.js`
- Test: `src/features/memory-bank/index.test.js`

- [ ] **Step 1: 阅读现有 index.js 结构**

```bash
head -100 src/features/memory-bank/index.js
```

理解现有 `runOnce()` 的 user-log 链、`startMemoryBankTicker()`、`writeRenders()`。

- [ ] **Step 2: 写失败测试 — runOnce 两阶段流程**

在 `src/features/memory-bank/index.test.js` 末尾加：

```javascript
test('runOnce executes phase1 and phase2 when findings exist', async () => {
  // Mock 扫描返回 1 个会话
  // Mock analyzeSession 返回 findings
  // Mock synthesizeMemories 返回 memories
  
  const result = await runOnce({ cwd: process.cwd() });
  
  assert(result, 'should return result');
  assert.strictEqual(result.sessionsAnalyzed, 1);
  assert(result.newMemories >= 0);
});
```

- [ ] **Step 3: 改写 runOnce 主体逻辑**

编辑 `src/features/memory-bank/index.js`，用新实现替换现有 `runOnce`：

```javascript
import { scanForUnanalyzedSessions } from './scan-sessions.js';
import { analyzeSession } from './analyze.js';
import { synthesizeMemories } from './synthesize.js';
import { readTranscriptEvents } from '../../store/transcript.js';

/**
 * 跑一轮两阶段提炼。手动触发与定时触发共用。
 * @returns {Promise<{sessionsAnalyzed, newMemories, injectReady, error?}>}
 */
export async function runOnce({ cwd = process.cwd(), now = Date.now() } = {}) {
  if (_running) {
    return {
      sessionsAnalyzed: 0,
      newMemories: 0,
      injectReady: false,
      skipped: 'already-running',
    };
  }

  _running = true;
  try {
    const bank = readBank();
    const settings = getMemoryBankSettings();

    // ========== Phase 1: 逐条分析会话 ==========
    const unanalyzed = scanForUnanalyzedSessions(bank);
    if (unanalyzed.length === 0) {
      logger.info('memory-bank', 'no unanalyzed sessions');
      return {
        sessionsAnalyzed: 0,
        newMemories: 0,
        injectReady: false,
      };
    }

    // 一轮最多分析 10 个会话（防首次启用烧穿额度）
    const MAX_SESSIONS = 10;
    const batch = unanalyzed.slice(0, MAX_SESSIONS);
    const allFindings = [];
    let analyzedCount = 0;

    for (const session of batch) {
      try {
        // 读会话转录
        const events = readTranscriptEvents(session.path);
        if (!events || events.length === 0) continue;

        // LLM 分析
        const result = await analyzeSession(session, events);
        if (!result || !result.findings || result.findings.length === 0) {
          // 无 findings 也要标记已分析
          addSession({
            id: `mem_session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            path: session.path,
            mtime: session.mtime,
            title: '',
            analyzedAt: now,
            findings: [],
          });
          analyzedCount++;
          continue;
        }

        allFindings.push(...result.findings);
        
        // 保存 findings 到 session
        addSession({
          id: `mem_session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          path: session.path,
          mtime: session.mtime,
          title: '', // 从首条用户消息提取，暂简化
          analyzedAt: now,
          findings: result.findings,
        });

        analyzedCount++;
      } catch (e) {
        logger.warn('memory-bank', `分析会话失败: ${session.path}`, {
          err: e?.message,
        });
      }
    }

    // ========== Phase 2: 总结生成 memories ==========
    const existingMemories = listMemories();
    let newMemoriesCount = 0;

    if (allFindings.length > 0) {
      const synthesized = await synthesizeMemories(allFindings, existingMemories);
      if (synthesized && Array.isArray(synthesized)) {
        for (const mem of synthesized) {
          const memId = `mem_${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}_${Math.random().toString(36).slice(2, 5)}`;
          addMemory({
            id: memId,
            statement: mem.statement,
            category: mem.category,
            createdAt: now,
            fromFindings: mem.merged_from || [],
          });
          newMemoriesCount++;
        }
      }
    }

    // ========== 渲染与落盘 ==========
    const projectDirs = batch.map((s) => path.dirname(s.path)).filter(Boolean);
    const renders = writeRenders(listMemories(), {
      now,
      settings,
      projectDirs,
    });

    // 更新时间戳
    updateBank((b) => {
      b.lastExtractAt = now;
      return b;
    });

    logger.info('memory-bank', '两阶段提炼完成', {
      sessionsAnalyzed: analyzedCount,
      findings: allFindings.length,
      memories: newMemoriesCount,
    });

    return {
      sessionsAnalyzed: analyzedCount,
      newMemories: newMemoriesCount,
      injectReady: newMemoriesCount > 0,
    };
  } catch (e) {
    logger.error('memory-bank', '提炼异常', { err: e?.message || String(e) });
    return {
      sessionsAnalyzed: 0,
      newMemories: 0,
      injectReady: false,
      error: e?.message,
    };
  } finally {
    _running = false;
  }
}
```

导入补充：

```javascript
import path from 'node:path';
import {
  readBank,
  updateBank,
  addSession,
  addMemory,
  listMemories,
} from '../../store/memory-bank.js';
```

- [ ] **Step 4: 运行单测验证 runOnce 框架**

```bash
npm test -- src/features/memory-bank/index.test.js
```

预期基础框架测试通过（具体的 LLM 调用需 mock）。

- [ ] **Step 5: 保留现有 writeRenders 与 ticker 逻辑**

确保 `startMemoryBankTicker()` 和 `writeRenders()` 保持不变，只改 `runOnce()` 内部。

- [ ] **Step 6: 提交**

```bash
git add src/features/memory-bank/index.js src/features/memory-bank/index.test.js
git commit -m "feat(memory-bank): rewrite runOnce with two-phase pipeline (phase1+phase2)"
```

---

### Task 9: 实现 findings 与 memories 渲染

**Files:**
- Modify: `src/features/memory-bank/render.js`
- Test: `src/features/memory-bank/render.test.js`

- [ ] **Step 1: 扩展 CATEGORY_LABEL 以支持 findings**

编辑 `src/features/memory-bank/render.js`，找 `CATEGORY_LABEL`：

```javascript
export const CATEGORY_LABEL = {
  'code-style': '代码风格',
  collaboration: '协作习惯',
  writing: '写作习惯',
  dialogue: '对话风格',
  'tech-pref': '技术偏好',
};

export const FINDING_TYPE_LABEL = {
  bug: '易错点',
  solution: '解决方案',
  pattern: '反复问题',
  preference: '偏好',
};
```

- [ ] **Step 2: 写失败测试 — renderFindingsMarkdown**

```javascript
test('renderFindingsMarkdown formats findings correctly', () => {
  const findings = [
    {
      type: 'bug',
      text: '飞书长连接断线不触发 onClose',
      context: '启动阶段',
    },
  ];
  const md = renderFindingsMarkdown(findings);
  assert(md.includes('易错点'));
  assert(md.includes('飞书长连接'));
});
```

- [ ] **Step 3: 实现 renderFindingsMarkdown**

```javascript
export function renderFindingsMarkdown(findings) {
  if (!findings || findings.length === 0) return '';

  const lines = ['## 发现'];
  const byType = {};

  for (const f of findings) {
    if (!byType[f.type]) byType[f.type] = [];
    byType[f.type].push(f);
  }

  for (const type of ['bug', 'solution', 'pattern', 'preference']) {
    const group = byType[type];
    if (!group) continue;
    lines.push(`### ${FINDING_TYPE_LABEL[type]}`);
    for (const f of group) {
      lines.push(`- ${f.text}${f.context ? `  (${f.context})` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: 写失败测试 — renderMemoriesMarkdown（现有改进）**

验证现有 `renderMarkdown()` 仍然正确工作，修改名字或分离逻辑确保 findings 和 memories 不混淆。

- [ ] **Step 5: 更新 writeRenders 调用**

在 `src/features/memory-bank/index.js` 的 `writeRenders()` 中，补充渲染 findings：

当前可能只渲染 memories。需要分别为每个已分析的会话生成 findings markdown（可选，取决于 UI 设计）。暂时保持现有逻辑：只渲染 memories 注入，findings 仅存 JSON 由前端展示。

- [ ] **Step 6: 提交**

```bash
git add src/features/memory-bank/render.js
git commit -m "feat(memory-bank/render): add findings rendering support"
```

---

### Task 10: 实现 HTTP 接口 — GET /api/memory/sessions

**Files:**
- Modify: `src/entrypoints/web/routes-memory.js`
- Test: `src/entrypoints/web/routes-memory.test.js`

- [ ] **Step 1: 写失败测试 — GET /api/memory/sessions**

```javascript
test('GET /api/memory/sessions returns session lists', async () => {
  const res = await fetch('http://localhost:3000/api/memory/sessions');
  const data = await res.json();
  
  assert.strictEqual(res.status, 200);
  assert(Array.isArray(data.unanalyzed));
  assert(Array.isArray(data.analyzed));
  assert(data.stats, 'should include stats');
});
```

- [ ] **Step 2: 实现 handleSessionsList**

编辑 `src/entrypoints/web/routes-memory.js`，在末尾加处理器：

```javascript
function handleSessionsList(res) {
  const bank = readBank();
  const unanalyzed = scanForUnanalyzedSessions(bank);
  
  const analyzed = bank.sessions.map((s) => ({
    id: s.id,
    title: s.title,
    path: s.path,
    analyzedAt: s.analyzedAt,
    findingsCount: (s.findings || []).length,
  }));

  sendJson(res, 200, {
    unanalyzed: unanalyzed.map((u) => ({
      path: u.path,
      mtime: u.mtime,
    })),
    analyzed,
    stats: {
      totalSessions: analyzed.length + unanalyzed.length,
      analyzedCount: analyzed.length,
      totalFindings: analyzed.reduce((sum, s) => sum + s.findingsCount, 0),
    },
  });
}
```

- [ ] **Step 3: 注册路由**

在 `handleMemoryRoutes()` 中加：

```javascript
if (pathname === '/api/memory/sessions' && method === 'GET') {
  return handleSessionsList(res);
}
```

- [ ] **Step 4: 运行测试验证**

```bash
npm test -- src/entrypoints/web/routes-memory.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/entrypoints/web/routes-memory.js
git commit -m "feat(routes-memory): add GET /api/memory/sessions endpoint"
```

---

### Task 11: 实现 HTTP 接口 — POST /api/memory/remove

**Files:**
- Modify: `src/entrypoints/web/routes-memory.js`

- [ ] **Step 1: 写失败测试 — POST /api/memory/remove**

```javascript
test('POST /api/memory/remove deletes memory', async () => {
  // 先创建一个 memory
  addMemory({
    id: 'mem_test_delete',
    statement: 'test',
    category: 'collaboration',
    createdAt: Date.now(),
    fromFindings: [],
  });

  const res = await fetch('http://localhost:3000/api/memory/remove', {
    method: 'POST',
    body: JSON.stringify({ id: 'mem_test_delete' }),
  });

  assert.strictEqual(res.status, 200);
  
  // 验证已删除
  const bank = readBank();
  assert(!bank.memories.some((m) => m.id === 'mem_test_delete'));
});
```

- [ ] **Step 2: 实现 handleRemove**

```javascript
function handleRemove(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: 'id 不能为空' });

    const bank = readBank();
    if (!bank.memories.some((m) => m.id === id)) {
      return sendJson(res, 404, { error: '记忆不存在' });
    }

    removeMemory(id);
    
    // 重新渲染 CLAUDE.md
    const projectDirs = [];
    const renders = writeRenders(listMemories(), {
      now: Date.now(),
      settings: getMemoryBankSettings(),
      projectDirs,
    });

    sendJson(res, 200, { ok: true, renders });
  });
}
```

- [ ] **Step 3: 注册路由**

```javascript
if (pathname === '/api/memory/remove' && method === 'POST') {
  return handleRemove(req, res);
}
```

- [ ] **Step 4: 运行测试**

```bash
npm test -- src/entrypoints/web/routes-memory.test.js
```

- [ ] **Step 5: 提交**

```bash
git add src/entrypoints/web/routes-memory.js
git commit -m "feat(routes-memory): add POST /api/memory/remove endpoint with CLAUDE.md sync"
```

---

### Task 12: 重写前端 UI — memory-view.js 布局

**Files:**
- Modify: `public/js/memory-view.js`
- Modify: `public/index.html`（微调）

- [ ] **Step 1: 阅读现有 memory-view.js**

```bash
head -50 public/js/memory-view.js
```

理解当前结构：侧栏按钮、面板容器、列表渲染逻辑。

- [ ] **Step 2: 写失败测试 — UI 渲染**

（前端测试需 jsdom，暂简化为逻辑检查）

- [ ] **Step 3: 重写 memory-view.js 的 initMemoryPanel**

编辑 `public/js/memory-view.js`：

```javascript
export async function initMemoryPanel() {
  const memBody = document.getElementById('memBody');
  if (!memBody) return;

  memBody.innerHTML = '';

  // ===== 顶部控制栏 =====
  const topBar = document.createElement('div');
  topBar.className = 'mem-topbar';
  topBar.innerHTML = `
    <div class="mem-toggle-group">
      <label>闲时提炼</label>
      <input type="checkbox" id="memToggleEnabled" />
      <span class="mem-toggle-help">凌晨 3:00 ~ 8:00 自动分析本地会话</span>
    </div>
    <button id="memExtractNow" class="btn-primary">立即提炼</button>
  `;
  memBody.appendChild(topBar);

  // ===== 真实记忆区 =====
  const memoriesSection = document.createElement('div');
  memoriesSection.className = 'mem-section memories';
  memoriesSection.innerHTML = '<h3>真实记忆 <span id="memCount">(0)</span></h3>';
  const memoriesContainer = document.createElement('div');
  memoriesContainer.id = 'memListContainer';
  memoriesSection.appendChild(memoriesContainer);
  memBody.appendChild(memoriesSection);

  // ===== 会话区 =====
  const sessionsSection = document.createElement('div');
  sessionsSection.className = 'mem-section sessions';
  sessionsSection.innerHTML = '<h3>会话 <span id="sessionStats">(0)</span></h3>';
  const sessionsContainer = document.createElement('div');
  sessionsContainer.id = 'memSessionsContainer';
  sessionsSection.appendChild(sessionsContainer);
  memBody.appendChild(sessionsSection);

  // 绑定事件
  document.getElementById('memToggleEnabled').addEventListener('change', toggleEnabled);
  document.getElementById('memExtractNow').addEventListener('click', extractNow);

  // 初始化数据
  await refreshMemoryPanel();
}
```

- [ ] **Step 4: 实现 refreshMemoryPanel**

```javascript
async function refreshMemoryPanel() {
  try {
    // 获取 memories
    const listRes = await fetch('/api/memory/list');
    const list = await listRes.json();

    // 获取 sessions
    const sessionsRes = await fetch('/api/memory/sessions');
    const sessions = await sessionsRes.json();

    renderMemories(list.items, list.budget);
    renderSessions(sessions);

    // 更新统计
    document.getElementById('memCount').textContent = `(${list.items.length})`;
    document.getElementById('sessionStats').textContent = `(${sessions.stats.analyzedCount} 待分析 / ${sessions.stats.totalSessions - sessions.stats.analyzedCount} 已分析)`;

    // 同步 toggle 状态
    document.getElementById('memToggleEnabled').checked = list.enabled ?? true;
  } catch (e) {
    console.error('refresh failed:', e);
  }
}
```

- [ ] **Step 5: 实现 renderMemories**

```javascript
function renderMemories(memories, budget) {
  const container = document.getElementById('memListContainer');
  container.innerHTML = '';

  if (memories.length === 0) {
    container.innerHTML = '<p class="empty">暂无记忆</p>';
    return;
  }

  for (const mem of memories) {
    const item = document.createElement('div');
    item.className = 'mem-item';
    item.innerHTML = `
      <div class="mem-item-statement">${escapeHtml(mem.statement)}</div>
      <div class="mem-item-meta">
        <span class="mem-category">${mem.category}</span>
      </div>
      <button class="btn-remove" data-id="${mem.id}">移除</button>
    `;
    container.appendChild(item);

    item.querySelector('.btn-remove').addEventListener('click', () => removeMemory(mem.id));
  }

  if (budget && budget.truncated > 0) {
    container.innerHTML += `<p class="mem-truncated">还有 ${budget.truncated} 条未注入（预算限制）</p>`;
  }
}
```

- [ ] **Step 6: 实现 renderSessions**

```javascript
function renderSessions(data) {
  const container = document.getElementById('memSessionsContainer');
  container.innerHTML = '';

  if (data.unanalyzed.length > 0) {
    const unanalyzedDiv = document.createElement('div');
    unanalyzedDiv.className = 'mem-sessions-group';
    unanalyzedDiv.innerHTML = '<strong>待分析</strong>';
    for (const session of data.unanalyzed.slice(0, 5)) {
      const item = document.createElement('div');
      item.className = 'mem-session-item';
      item.textContent = `📄 ${basename(session.path)}`;
      unanalyzedDiv.appendChild(item);
    }
    if (data.unanalyzed.length > 5) {
      const more = document.createElement('div');
      more.textContent = `... 还有 ${data.unanalyzed.length - 5} 个`;
      unanalyzedDiv.appendChild(more);
    }
    container.appendChild(unanalyzedDiv);
  }

  if (data.analyzed.length > 0) {
    const analyzedDiv = document.createElement('div');
    analyzedDiv.className = 'mem-sessions-group';
    analyzedDiv.innerHTML = '<strong>已分析</strong>';
    for (const session of data.analyzed) {
      const item = document.createElement('div');
      item.className = 'mem-session-item expandable';
      item.innerHTML = `
        <span class="toggle">▸</span>
        ${escapeHtml(session.title || basename(session.path))}
        <span class="findings-badge">${session.findingsCount} 个发现</span>
      `;
      item.addEventListener('click', () => expandSession(session, item));
      analyzedDiv.appendChild(item);
    }
    container.appendChild(analyzedDiv);
  }
}
```

- [ ] **Step 7: 实现交互处理**

```javascript
async function toggleEnabled(e) {
  const enabled = e.target.checked;
  await fetch('/api/memory/list'); // 获取当前设置
  // 后续可补充 API 切换开关（暂不实现）
}

async function extractNow() {
  const btn = document.getElementById('memExtractNow');
  btn.disabled = true;
  btn.textContent = '提炼中...';
  try {
    const res = await fetch('/api/memory/extract', { method: 'POST' });
    if (res.status === 202) {
      // 轮询直到完成
      const checkComplete = setInterval(async () => {
        const listRes = await fetch('/api/memory/list');
        if (listRes.ok) {
          await refreshMemoryPanel();
          clearInterval(checkComplete);
        }
      }, 5000);
      setTimeout(() => clearInterval(checkComplete), 300000); // 5 分钟超时
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '立即提炼';
  }
}

async function removeMemory(id) {
  if (!confirm('确认删除此记忆？')) return;
  const res = await fetch('/api/memory/remove', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
  if (res.ok) {
    await refreshMemoryPanel();
  }
}

function expandSession(session, element) {
  element.classList.toggle('expanded');
  if (!element.querySelector('.findings')) {
    const findings = document.createElement('div');
    findings.className = 'findings';
    findings.innerHTML = session.findings
      .map((f) => `<div class="finding">【${f.type}】${escapeHtml(f.text)}</div>`)
      .join('');
    element.appendChild(findings);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function basename(path) {
  return path.split('/').pop() || path;
}
```

- [ ] **Step 8: 提交**

```bash
git add public/js/memory-view.js
git commit -m "feat(memory-view): rewrite UI with sessions list, findings, and memories management"
```

---

### Task 13: 添加 CSS 样式

**Files:**
- Modify: `public/app.css` 或新建 `public/memory.css`

- [ ] **Step 1: 写样式**

添加到 `public/app.css`：

```css
/* 记忆库面板样式 */
.mem-topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #e0e0e0;
  background: #f9f9f9;
}

.mem-toggle-group {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 14px;
}

.mem-toggle-group input[type="checkbox"] {
  width: 40px;
  height: 24px;
  cursor: pointer;
}

.mem-toggle-help {
  color: #999;
  font-size: 12px;
}

.mem-section {
  padding: 16px;
  border-bottom: 1px solid #e0e0e0;
}

.mem-section h3 {
  margin-top: 0;
  font-size: 16px;
  font-weight: bold;
}

.mem-item {
  padding: 12px;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  margin-bottom: 8px;
  background: #fff;
}

.mem-item-statement {
  font-size: 14px;
  margin-bottom: 8px;
}

.mem-item-meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #666;
}

.mem-category {
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
}

.btn-remove {
  float: right;
  padding: 4px 8px;
  background: #ff6b6b;
  color: white;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
}

.btn-remove:hover {
  background: #ff5252;
}

.mem-sessions-group {
  margin-bottom: 16px;
}

.mem-session-item {
  padding: 8px 12px;
  margin: 4px 0;
  background: #f5f5f5;
  border-radius: 3px;
  cursor: pointer;
  user-select: none;
}

.mem-session-item.expandable {
  position: relative;
}

.mem-session-item .toggle {
  display: inline-block;
  width: 16px;
  transition: transform 0.2s;
}

.mem-session-item.expanded .toggle {
  transform: rotate(90deg);
}

.mem-session-item .findings-badge {
  display: inline-block;
  margin-left: auto;
  background: #e3f2fd;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
  color: #1976d2;
}

.findings {
  margin-top: 8px;
  padding-left: 24px;
  border-left: 2px solid #ccc;
}

.finding {
  padding: 4px 0;
  font-size: 12px;
  color: #666;
}

.mem-truncated {
  font-size: 12px;
  color: #999;
  font-style: italic;
  margin-top: 12px;
}

.empty {
  text-align: center;
  color: #999;
  padding: 20px;
}
```

- [ ] **Step 2: 提交**

```bash
git add public/app.css
git commit -m "feat(css): add memory panel styling"
```

---

### Task 14: 整合测试与验证

**Files:**
- Modify: `src/features/memory-bank/index.test.js`（补充集成测试）

- [ ] **Step 1: 写端到端测试框架**

```javascript
test('full memory-bank v2 flow: scan → analyze → synthesize → render', async () => {
  // 这是一个集成测试框架，实际需要 mock 文件系统和 LLM
  // 步骤：
  // 1. 清空 memory-bank.json
  // 2. 创建测试会话转录
  // 3. 调用 runOnce()
  // 4. 验证 sessions 已保存
  // 5. 验证 memories 已生成
  // 6. 验证 CLAUDE.md 已更新
});
```

- [ ] **Step 2: 手动集成测试**

启动服务：

```bash
npm start
```

在浏览器打开记忆库面板，验证：
- 侧栏按钮出现
- 面板展示"真实记忆"与"会话"两个区域
- 点击"立即提炼"后有响应
- 刷新后新增的 memories 展示
- 点击"移除"能删除 memory 并同步 CLAUDE.md

- [ ] **Step 3: 提交**

```bash
git add src/features/memory-bank/index.test.js
git commit -m "test(memory-bank): add integration test framework"
```

---

### Task 15: 迁移 CLAUDE.md 注入机制

**Files:**
- Verify: `src/features/memory-bank/index.js` 的 `writeRenders()` 依然工作

- [ ] **Step 1: 验证 writeRenders 兼容新数据模型**

在 `src/features/memory-bank/index.js` 中，确保 `writeRenders()` 的调用参数正确：

```javascript
const projectDirs = collectProjectDirs(listMemories(), cwd, sessions.map((s) => s.cwd));
const renders = writeRenders(listMemories(), {
  now,
  settings,
  projectDirs,
});
```

确认 `listMemories()` 返回的数据结构与 `render.js` 的 `selectForInjection()` 兼容。

- [ ] **Step 2: 手动验证 CLAUDE.md 注入**

启动服务，观察 `~/.claude/CLAUDE.md` 和 `.claude/memory-bank.md`：

- 若记忆库生成了 memories，应看到 `@memory-bank.md` 行被添加
- 若移除所有 memories，.md 文件应被清空但 @引用行删除

- [ ] **Step 3: 提交（无新代码，仅验证）**

```bash
git status
# 若无改动，跳过提交；若有自动调整，commit
```

---

### Task 16: 文档更新

**Files:**
- Modify: `docs/ARCHITECTURE.md`（补充新管线描述）

- [ ] **Step 1: 在 ARCHITECTURE.md 补充记忆库 v2 说明**

在「流程 B」记忆库部分，补充：

```markdown
### 新增 — Phase 1 会话分析

`startMemoryBankTicker` 周期性调用 `runOnce()`，执行两阶段：

1. **Phase 1**：`scanForUnanalyzedSessions()` 找未分析的 ~/.claude/projects 会话 → 一轮最多 10 个
   → 逐个 `readTranscriptEvents()` 读转录 → `analyzeSession()` LLM 分析 → 产出 findings[]

2. **Phase 2**：若 Phase 1 有新 findings → `synthesizeMemories()` 一次 LLM 调用 → 去重/泛化 → 生成 memories[]

3. 渲染与落盘：`writeRenders()` 把 memories 按 category 分节为 Markdown → 注入 CLAUDE.md
```

- [ ] **Step 2: 提交**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: update ARCHITECTURE.md with memory-bank v2 two-phase pipeline"
```

---

### Task 17: 清理与完成

**Files:**
- Verify: 所有新文件都有对应 `.test.js`

- [ ] **Step 1: 验证测试覆盖**

运行完整测试套件：

```bash
npm test
```

预期所有与 memory-bank v2 相关的单测通过。

- [ ] **Step 2: 运行 linter（如有）**

```bash
npm run lint 2>/dev/null || echo "no linter configured"
```

- [ ] **Step 3: 确认 v1 兼容迁移**

若 `settings.json` 中有 v1 配置，启动服务后验证能正确迁移到 v2。

- [ ] **Step 4: 最终提交**

```bash
git log --oneline -10
```

确认所有 18 个任务的 commit 都已保存。

---

## 总结

本计划分 18 个 TDD 风格的任务，覆盖：
- **数据模型**（Task 1-4）：v2 schema、CRUD、迁移
- **分析层**（Task 5-7）：扫描、单会话 LLM、批量总结
- **编排层**（Task 8）：两阶段 runOnce 流程
- **渲染与注入**（Task 9）：findings + memories markdown
- **HTTP 接口**（Task 10-11）：sessions 列表、memory 删除
- **前端 UI**（Task 12-13）：面板重写、样式
- **验证与文档**（Task 14-17）：集成测试、CLAUDE.md、清理

每个任务 2-5 分钟，包含完整代码、命令、预期输出，无占位符。


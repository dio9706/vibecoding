# 功能账本（Feature Ledger）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在需求工作流中增加功能模块标签 + 历史文件索引（功能账本），让 AI 开发时直接命中已知文件集，无需全局扫码，降低 token 消耗并提升开发速度。

**Architecture:** 三层协作——① `store/feature-index.js` 持久化功能账本（feature-index.json），按标签存储文件频次列表；② `req-logic.js` 更新 docgen 输出契约（AI 自动推断标签）+ buildSeedPrompt（注入文件快照）；③ `requirement-ops.js` 在归档时从真实 git diff --name-only 收割改动文件写入账本。`buildSeedPrompt` 是实际开发 prompt（通过 `GET /api/req/get` 的 `seed` 字段下发给前端，前端 sendMessageProgrammatically 发出）——改这里就是改开发期 AI 上下文。前端 req-view.js 在评审期展示/允许修改功能标签 chip。

**Tech Stack:** Node.js ESM，store/index.js readJson/updateJson 文件锁，git diff --name-only，req-logic.js 纯函数模式，node:test 单测。

---

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `src/store/feature-index.js` | 功能账本 CRUD（harvestFiles/getTopFiles/listFeatureTags） |
| 新建 | `src/store/feature-index.test.js` | store 单测 |
| 修改 | `src/store/requirements.js` | createRequirement 新增 `featureTag: null` 字段 |
| 修改 | `src/entrypoints/web/req-logic.js` | docOutputContract 加 §三；parseFeatureTag；buildDocgenPrompt/buildRevisePrompt 加 existingTags；buildSeedPrompt 加 featureSnapshot 注入 |
| 修改 | `src/entrypoints/web/req-logic.test.js` | 新增 parseFeatureTag / buildSeedPrompt 快照单测 |
| 修改 | `src/entrypoints/web/requirement-ops.js` | runDocgen 保存 featureTag；archiveRequirement 新增 runGitDiff 收割 |
| 修改 | `src/entrypoints/web/requirement-ops.test.js` | 新增 docgen tag 保存 / archive 收割测试 |
| 修改 | `src/entrypoints/web/routes-requirements.js` | PUT /api/req/feature-tag；GET /api/feature-index；handleGet 注入 featureSnapshot |
| 修改 | `src/entrypoints/web/routes-requirements.test.js` | 新增路由测试 |
| 修改 | `public/js/req-view.js` | 评审期功能标签 chip（展示 + 内联编辑） |

---

## Task 1: store/feature-index.js — 功能账本数据层

**Files:**
- Create: `src/store/feature-index.js`
- Create: `src/store/feature-index.test.js`
- Modify: `src/store/requirements.js`

- [ ] **Step 1: 写 feature-index.js**

```js
// src/store/feature-index.js
/**
 * 功能账本（Feature Ledger）——以功能标签（如「宝宝辅食」）为键，
 * 记录历次需求归档时 git diff 收割出的改动文件及其出现频次。
 * 频次越高表示该文件与本功能模块的耦合越强，开发期优先读取。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'feature-index.json';

/** 获取全量功能账本（对象：tag → entry） */
export function getFeatureIndex() {
  return readJson(FILE, {});
}

/** 获取单条功能条目；不存在时返回 null */
export function getFeature(tag) {
  return readJson(FILE, {})[String(tag || '')] ?? null;
}

/** 列出所有已知功能标签名称（供 docgen prompt 注入） */
export function listFeatureTags() {
  return Object.keys(readJson(FILE, {}));
}

/**
 * 从 git diff 收割的文件路径列表，合并入指定功能标签的文件频次记录。
 * 已存在的路径计数 +1，新路径计数置 1；最终按频次降序排列。
 * tag 为空或 filePaths 为空时静默跳过。
 */
export function harvestFiles(tag, filePaths) {
  if (!tag || !filePaths?.length) return;
  updateJson(FILE, {}, (index) => {
    const entry = index[String(tag)] ?? { tag: String(tag), files: [], lastHarvestedAt: null };
    const fileMap = new Map(entry.files.map((f) => [f.path, f.count]));
    for (const p of filePaths) {
      const clean = String(p).trim();
      if (clean) fileMap.set(clean, (fileMap.get(clean) ?? 0) + 1);
    }
    entry.files = [...fileMap.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count);
    entry.lastHarvestedAt = new Date().toISOString();
    index[String(tag)] = entry;
    return index;
  });
}

/**
 * 获取功能标签的高频文件列表（按频次降序取前 N 条，默认 20）。
 * 供 buildSeedPrompt 注入开发 prompt。标签不存在或无文件记录时返回 null。
 */
export function getTopFiles(tag, n = 20) {
  const entry = getFeature(tag);
  if (!entry?.files?.length) return null;
  return entry.files.slice(0, n);
}
```

- [ ] **Step 2: 写 feature-index.test.js**

```js
// src/store/feature-index.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 必须在 import store 之前设置 APP_DATA_DIR（store/index.js 模块加载时读取）
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-idx-'));
const { getFeatureIndex, getFeature, listFeatureTags, harvestFiles, getTopFiles } =
  await import('./feature-index.js');

test('getFeature：不存在的标签返回 null', () => {
  assert.equal(getFeature('不存在'), null);
});

test('harvestFiles：首次收割写入文件及 count=1', () => {
  harvestFiles('宝宝辅食', ['src/views/BabyFood.vue', 'src/api/babyFood.js']);
  const entry = getFeature('宝宝辅食');
  assert.ok(entry);
  assert.equal(entry.tag, '宝宝辅食');
  assert.equal(entry.files.length, 2);
  assert.equal(entry.files[0].count, 1);
  assert.ok(entry.lastHarvestedAt);
});

test('harvestFiles：重复收割同一文件 count 累加并置顶', () => {
  harvestFiles('宝宝辅食', ['src/views/BabyFood.vue']); // 已有 count=1，现在+1=2
  const entry = getFeature('宝宝辅食');
  assert.equal(entry.files[0].path, 'src/views/BabyFood.vue');
  assert.equal(entry.files[0].count, 2);
  assert.equal(entry.files[1].path, 'src/api/babyFood.js');
  assert.equal(entry.files[1].count, 1);
});

test('harvestFiles：tag 为空或 filePaths 为空时静默跳过', () => {
  const before = JSON.stringify(getFeatureIndex());
  harvestFiles('', ['a.js']);
  harvestFiles('盘子需求', []);
  harvestFiles(null, ['a.js']);
  assert.equal(JSON.stringify(getFeatureIndex()), before);
});

test('listFeatureTags：返回已知标签列表', () => {
  const tags = listFeatureTags();
  assert.ok(tags.includes('宝宝辅食'));
});

test('getTopFiles：按频次排序返回前 N 条', () => {
  const files = getTopFiles('宝宝辅食', 1);
  assert.equal(files?.length, 1);
  assert.equal(files[0].path, 'src/views/BabyFood.vue');
  assert.equal(files[0].count, 2);
});

test('getTopFiles：标签不存在返回 null', () => {
  assert.equal(getTopFiles('不存在'), null);
});
```

- [ ] **Step 3: 运行测试确认通过**

```bash
node --test src/store/feature-index.test.js
```

预期：7 条全绿

- [ ] **Step 4: 修改 requirements.js 加 featureTag 字段**

在 `createRequirement` 函数的 req 对象里，`designGuidelines: ''` 之后加一行：

```js
// src/store/requirements.js createRequirement 内 req 对象
featureTag: null,          // 功能模块标签（docgen 自动推断或用户手改）
```

- [ ] **Step 5: 运行 requirements 测试确认无破坏**

```bash
node --test src/store/requirements.test.js
```

预期：全绿

- [ ] **Step 6: Commit**

```bash
git add src/store/feature-index.js src/store/feature-index.test.js src/store/requirements.js
git commit -m "feat: 新增功能账本 store（feature-index.js）及需求 featureTag 字段"
```

---

## Task 2: req-logic.js — docgen 输出契约 + parseFeatureTag

**Files:**
- Modify: `src/entrypoints/web/req-logic.js`
- Modify: `src/entrypoints/web/req-logic.test.js`

- [ ] **Step 1: 修改 docOutputContract，接受 existingTags / currentTag，加入 §三**

将当前 `function docOutputContract()` 替换为：

```js
// src/entrypoints/web/req-logic.js
/** docgen/revise 共用的输出契约段：三节固定结构，§三包含功能模块标签推断指引。 */
function docOutputContract({ existingTags = [], currentTag = null } = {}) {
  const tagLine = existingTags.length
    ? `已有功能模块（从中选一个，或新建 2-4 字简短名称）：${existingTags.join('、')}`
    : `（暂无已有模块，请新建一个 2-4 字简短名称，如「宝宝辅食」「盘子需求」）`;
  const hint = currentTag ? `（当前已识别为「${currentTag}」，若无变化直接保持）` : '';
  return (
    `输出契约（严格遵守）：只输出 markdown 正文，不要任何解释性开场白。结构必须是——\n` +
    `## 一、说人话总结\n（用大白话概括要改什么、影响哪些地方，非技术人员能看懂）\n\n` +
    `## 二、详细设计\n（逐【开发工程】列出：新增 / 删除 / 更新 的文件与内容要点，精确到文件路径；只读参考工程仅作依据引用）\n\n` +
    `## 三、功能模块标签${hint}\n${tagLine}\n本需求所属功能模块：`
  );
}
```

- [ ] **Step 2: 修改 buildDocgenPrompt，接受并透传 existingTags**

将函数签名从 `({ reqDocText, supplements = [], projects })` 改为：

```js
/** 评审期 docgen prompt：需求文档全文 + 补充说明（按时间序）+ 工程角色表 + 输出契约（含功能标签推断）。 */
export function buildDocgenPrompt({ reqDocText, supplements = [], projects, existingTags = [] }) {
  const sup = supplements.length
    ? `\n补充说明（按时间序，后者优先级更高）：\n${supplementLines(supplements)}\n`
    : '';
  return (
    `你是资深架构师，请阅读需求文档并实际查证下列工程后，产出一份开发文档。\n\n` +
    `工程角色（只读查证，本次不做任何修改）：\n${projectRoleLines(projects).join('\n')}\n\n` +
    `需求文档全文：\n「${reqDocText}」\n${sup}\n` +
    docOutputContract({ existingTags })
  );
}
```

- [ ] **Step 3: 修改 buildRevisePrompt，接受并透传 existingTags / currentTag**

```js
/** 补充说明 → 增量修订 prompt；resume 同一 docgen session，在上一版基础上修订，输出契约同 docgen。 */
export function buildRevisePrompt({ supplement, existingTags = [], currentTag = null }) {
  const { text, files } = supplement || {};
  return (
    `用户对开发文档提出新的补充说明如下：\n「${text}」${attachmentsPart(files)}\n\n` +
    `请在你上一版开发文档基础上修订，输出完整新版文档。\n\n` +
    docOutputContract({ existingTags, currentTag })
  );
}
```

- [ ] **Step 4: 新增 parseFeatureTag 函数，加在 extractSummary 之后**

```js
/**
 * 从 docgen/revise 输出文本中解析「## 三、功能模块标签」节的标签值。
 * 支持格式：`本需求所属功能模块：宝宝辅食` 或 `：「宝宝辅食」`。
 * 解析失败（无该节或格式异常）返回 null。
 */
export function parseFeatureTag(docText) {
  const m = String(docText ?? '').match(
    /##\s*三、功能模块标签[\s\S]*?\n本需求所属功能模块[：:]\s*([^\n]+)/,
  );
  if (!m) return null;
  const raw = m[1].trim().replace(/[`'"「」【】（）()]/g, '').trim();
  return raw || null;
}
```

- [ ] **Step 5: 在 req-logic.test.js 中新增测试**

在文件末尾追加（注意保持 APP_DATA_DIR 设置在 import 之前，与文件其他测试共用同一进程头）：

```js
// 在 req-logic.test.js 末尾追加

test('parseFeatureTag：标准格式解析成功', () => {
  const doc = `## 一、说人话总结\n改宝宝辅食\n\n## 二、详细设计\n略\n\n## 三、功能模块标签\n已有功能模块：宝宝辅食\n本需求所属功能模块：宝宝辅食`;
  assert.equal(parseFeatureTag(doc), '宝宝辅食');
});

test('parseFeatureTag：带书名号也能解析', () => {
  const doc = `## 三、功能模块标签\n已有：宝宝辅食\n本需求所属功能模块：「宝宝辅食」`;
  assert.equal(parseFeatureTag(doc), '宝宝辅食');
});

test('parseFeatureTag：无 §三 返回 null', () => {
  assert.equal(parseFeatureTag('## 一、说人话总结\n内容'), null);
});

test('parseFeatureTag：值为空字符串返回 null', () => {
  const doc = `## 三、功能模块标签\n本需求所属功能模块：`;
  assert.equal(parseFeatureTag(doc), null);
});

test('buildDocgenPrompt：existingTags 注入到输出契约', () => {
  const prompt = buildDocgenPrompt({
    reqDocText: '改宝宝辅食页面',
    projects: { frontend: { dir: '/app', dev: true }, backend: null },
    existingTags: ['宝宝辅食', '盘子需求'],
  });
  assert.ok(prompt.includes('宝宝辅食、盘子需求'));
  assert.ok(prompt.includes('## 三、功能模块标签'));
});

test('buildRevisePrompt：currentTag 注入到输出契约 hint', () => {
  const prompt = buildRevisePrompt({
    supplement: { text: '补充说明' },
    existingTags: ['宝宝辅食'],
    currentTag: '宝宝辅食',
  });
  assert.ok(prompt.includes('当前已识别为「宝宝辅食」'));
});
```

确认这些函数已从 req-logic.js 导出（`parseFeatureTag` 是新增的 export）。

- [ ] **Step 6: 运行测试**

```bash
node --test src/entrypoints/web/req-logic.test.js
```

预期：全绿（包括原有测试）

- [ ] **Step 7: Commit**

```bash
git add src/entrypoints/web/req-logic.js src/entrypoints/web/req-logic.test.js
git commit -m "feat: docgen 输出契约加 §三功能模块标签，新增 parseFeatureTag"
```

---

## Task 3: req-logic.js — buildSeedPrompt 注入功能快照

**Files:**
- Modify: `src/entrypoints/web/req-logic.js`
- Modify: `src/entrypoints/web/req-logic.test.js`

- [ ] **Step 1: 修改 buildSeedPrompt 签名，加入 featureSnapshot 参数**

将当前 `export function buildSeedPrompt(req)` 改为：

```js
/**
 * 子会话轻量种子：需求基本信息 + 工程角色 + 开发文档 + 功能文件快照（有才注入）+ 设计准则。
 * 返回 300-500 token 左右的纯文本 prompt 前缀。
 * featureSnapshot: { tag: string, files: [{path, count}] } | null
 */
export function buildSeedPrompt(req, { featureSnapshot = null } = {}) {
  const { cwd: reqCwd, addDirs } = pickCwdAndDirs(req.projects);
  const parts = [];

  // 需求基本信息
  const branchName = reqBranchName(req);
  parts.push(`【需求】${req.title} · 分支 ${branchName}`);

  // 工程角色（前端优先，后端次之）
  if (reqCwd) {
    const dirs = [reqCwd, ...addDirs];
    const roles = dirs.map((dir) => {
      const isBackend = req.projects?.backend && req.projects.backend.dir === dir;
      const isDev = isBackend ? req.projects.backend.dev : req.projects.frontend?.dev;
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

  // 功能文件快照（有才注入）——基于历史 git diff 收割，频次越高置信度越强
  if (featureSnapshot?.files?.length) {
    const fileLines = featureSnapshot.files
      .map((f) => `- ${f.path}（出现 ${f.count} 次）`)
      .join('\n');
    parts.push(
      `【功能快照·${featureSnapshot.tag}】基于历史开发记录，本功能模块涉及以下文件（按改动频次排序）：\n${fileLines}\n\n` +
        `开发规范：先读快照文件定位实现，范围不足时再局部探索；禁止全局 glob/grep 扫整个工程。` +
        `若快照中有文件不存在，请在首条回复标注「[快照过期]」并说明变动文件。`,
    );
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

- [ ] **Step 2: 在 req-logic.test.js 末尾追加 buildSeedPrompt 快照测试**

```js
// req-logic.test.js 末尾追加

const mockReqWithSnapshot = {
  title: '改宝宝辅食',
  projects: { frontend: { dir: '/kxmall-app-ui', dev: true }, backend: null },
  devDoc: { versions: [{ v: 1, path: '/data/req/r_abc/dev-doc-v1.md', summary: '', at: '' }] },
  branches: [{ dir: '/kxmall-app-ui', branch: 'req/r_abc-babyFood', baseBranch: 'main' }],
  designGuidelines: '',
  featureTag: '宝宝辅食',
};

test('buildSeedPrompt：无 featureSnapshot 时不包含快照节', () => {
  const seed = buildSeedPrompt(mockReqWithSnapshot);
  assert.ok(!seed.includes('功能快照'));
});

test('buildSeedPrompt：有 featureSnapshot 时注入快照及开发规范', () => {
  const snapshot = {
    tag: '宝宝辅食',
    files: [
      { path: 'src/views/BabyFood.vue', count: 3 },
      { path: 'src/api/babyFood.js', count: 1 },
    ],
  };
  const seed = buildSeedPrompt(mockReqWithSnapshot, { featureSnapshot: snapshot });
  assert.ok(seed.includes('【功能快照·宝宝辅食】'));
  assert.ok(seed.includes('src/views/BabyFood.vue（出现 3 次）'));
  assert.ok(seed.includes('禁止全局 glob/grep'));
  assert.ok(seed.includes('[快照过期]'));
});
```

- [ ] **Step 3: 运行测试**

```bash
node --test src/entrypoints/web/req-logic.test.js
```

预期：全绿

- [ ] **Step 4: Commit**

```bash
git add src/entrypoints/web/req-logic.js src/entrypoints/web/req-logic.test.js
git commit -m "feat: buildSeedPrompt 支持功能文件快照注入"
```

---

## Task 4: requirement-ops.js — docgen 完成后保存 featureTag

**Files:**
- Modify: `src/entrypoints/web/requirement-ops.js`
- Modify: `src/entrypoints/web/requirement-ops.test.js`

- [ ] **Step 1: 在 requirement-ops.js 顶部 import 区加入新依赖**

在已有 import 行之后追加：

```js
import { parseFeatureTag } from './req-logic.js';
import { listFeatureTags, harvestFiles } from '../../store/feature-index.js';
```

（`parseFeatureTag` 在 req-logic.js 中已是 export，Task 2 已添加）

- [ ] **Step 2: 修改 runDocgen 中的 buildDocgenPrompt 调用，注入 existingTags**

找到 `runDocgen` 内调用 `buildDocgenPrompt` 的地方（当前大约在第 390 行附近，`const prompt = buildDocgenPrompt({...})`），将其改为：

```js
const prompt = buildDocgenPrompt({
  reqDocText,
  supplements: req.supplements,
  projects: req.projects,
  existingTags: listFeatureTags(),  // 注入已有功能模块列表供 AI 选择
});
```

- [ ] **Step 3: 修改 runDocgen 内的 buildRevisePrompt 调用（revise 路径），注入 existingTags / currentTag**

找到 revise 分支里的 `buildRevisePrompt` 调用，改为：

```js
const prompt = buildRevisePrompt({
  supplement,
  existingTags: listFeatureTags(),
  currentTag: req.featureTag ?? null,
});
```

- [ ] **Step 4: 修改 runDocgen 成功落盘处，解析并保存 featureTag**

找到 `updateRequirement(req.id, { devDoc: { versions }, docSession: ..., busy: null }, ...)` 这一行，将其改为：

```js
const featureTag = parseFeatureTag(resultText);
updateRequirement(
  req.id,
  {
    devDoc: { versions },
    docSession: capturedSession || req.docSession,
    busy: null,
    ...(featureTag ? { featureTag } : {}), // 仅 docgen 成功解析到标签时才写入，不覆盖用户手动设置
  },
  `开发文档 v${v} 生成完成${featureTag ? `（功能模块：${featureTag}）` : ''}`,
);
```

- [ ] **Step 5: 在 requirement-ops.test.js 末尾追加 featureTag 保存测试**

```js
// requirement-ops.test.js 末尾追加

test('runDocgen：docgen 输出含 §三 时自动写入 featureTag', async () => {
  // 构造包含 §三 的 mock docgen 输出
  const docWithTag =
    '## 一、说人话总结\n改宝宝辅食\n\n## 二、详细设计\n略\n\n' +
    '## 三、功能模块标签\n已有功能模块：（暂无）\n本需求所属功能模块：宝宝辅食';

  // 注意：此测试需要 mock runClaude，参照文件中已有的 runDocgen 测试范式
  // 若现有测试文件已有辅助函数 makeReq / stubClaude，复用它们：
  const req = createTestReq({ phase: 'review', projects: { frontend: { dir: '/app', dev: true }, backend: null }, reqDoc: { name: 't', path: '/app/req.md' } });
  // stub：runClaude 直接 resolve docWithTag
  const saved = await runDocgenWithStub(req, docWithTag);
  assert.equal(saved.featureTag, '宝宝辅食');
});

test('runDocgen：docgen 输出无 §三 时 featureTag 不写入（不覆盖已有）', async () => {
  const docNoTag = '## 一、说人话总结\n改页面\n\n## 二、详细设计\n略';
  const req = createTestReq({ phase: 'review', featureTag: '已有标签', ... });
  const saved = await runDocgenWithStub(req, docNoTag);
  assert.equal(saved.featureTag, '已有标签'); // 不覆盖
});
```

> **注意**：在 requirement-ops.test.js 中查找已有的 runDocgen 测试写法（mock runClaude 的方式）并对齐范式。若文件已有 `makeReq`、`stubClaude` 或 dependency injection 模式，直接复用。测试的关键验证点是：解析到 tag → 写盘；未解析到 → 保留原值。

- [ ] **Step 6: 运行测试**

```bash
node --test src/entrypoints/web/requirement-ops.test.js
```

预期：全绿

- [ ] **Step 7: Commit**

```bash
git add src/entrypoints/web/requirement-ops.js src/entrypoints/web/requirement-ops.test.js
git commit -m "feat: docgen 完成后自动解析并保存功能模块标签"
```

---

## Task 5: requirement-ops.js — archive 收割 git diff 文件

**Files:**
- Modify: `src/entrypoints/web/requirement-ops.js`
- Modify: `src/entrypoints/web/requirement-ops.test.js`

- [ ] **Step 1: 在 defaultRunGit 下方新增 defaultRunGitDiff**

```js
// src/entrypoints/web/requirement-ops.js
// 紧接 defaultRunGit 函数之后

/** 默认 git diff 实现（单测经 { runGitDiff } 注入桩替换，对齐 runGit 先例）。 */
function defaultRunGitDiff(dir, baseBranch, branch) {
  return runScript('git', ['-C', dir, 'diff', `${baseBranch}..${branch}`, '--name-only'], {
    shell: false,
  });
}
```

- [ ] **Step 2: 修改 archiveRequirement 签名，加入 runGitDiff 注入**

```js
export async function archiveRequirement(id, note, { runGit = defaultRunGit, runGitDiff = defaultRunGitDiff } = {}) {
```

- [ ] **Step 3: 在 archiveRequirement 内 branchLogs 循环之后，紧接 const cleanNote = ... 之前，插入收割逻辑**

```js
// archiveRequirement 内，branchLogs 已填充完毕，cleanNote 之前插入：

// 收割改动文件至功能账本（有 featureTag 才执行；失败降级静默跳过，不阻塞归档）
if (req.featureTag) {
  try {
    const allFiles = [];
    for (const b of req.branches || []) {
      const r = await runGitDiff(b.dir, b.baseBranch, b.branch);
      if (r?.ok && r.out?.trim()) {
        allFiles.push(...r.out.trim().split('\n').filter(Boolean));
      }
    }
    if (allFiles.length) {
      harvestFiles(req.featureTag, allFiles);
      logger.info('req-ops', '功能账本收割完成', {
        reqId: id,
        tag: req.featureTag,
        fileCount: allFiles.length,
      });
    }
  } catch (e) {
    logger.warn('req-ops', '功能账本收割异常（已跳过，不影响归档）', {
      reqId: id,
      err: e?.message || String(e),
    });
  }
}
```

- [ ] **Step 4: 在 requirement-ops.test.js 末尾追加 archive 收割测试**

```js
// requirement-ops.test.js 末尾追加

test('archiveRequirement：有 featureTag 时收割 git diff 文件', async () => {
  const req = createArchivedTestReq({ featureTag: '宝宝辅食' }); // 参照文件中 archiveRequirement 已有测试
  const mockRunGitDiff = async (_dir, _base, _branch) => ({
    ok: true,
    out: 'src/views/BabyFood.vue\nsrc/api/babyFood.js\n',
  });
  const mockRunGit = async () => ({ ok: true, out: 'abc123 feat: 改宝宝辅食' });

  await archiveRequirement(req.id, '测试备注', {
    runGit: mockRunGit,
    runGitDiff: mockRunGitDiff,
  });

  const { getTopFiles } = await import('../../store/feature-index.js');
  const files = getTopFiles('宝宝辅食');
  assert.ok(files?.some((f) => f.path === 'src/views/BabyFood.vue'));
});

test('archiveRequirement：runGitDiff 失败时归档仍成功', async () => {
  const req = createArchivedTestReq({ featureTag: '盘子需求' });
  const mockRunGitDiff = async () => ({ ok: false, out: '' });
  const mockRunGit = async () => ({ ok: true, out: '(no commits)' });

  const result = await archiveRequirement(req.id, '', {
    runGit: mockRunGit,
    runGitDiff: mockRunGitDiff,
  });
  assert.equal(result.ok, true); // 收割失败不阻塞归档
});

test('archiveRequirement：无 featureTag 时跳过收割', async () => {
  const req = createArchivedTestReq({ featureTag: null });
  // runGitDiff 不应被调用
  let called = false;
  const mockRunGitDiff = async () => { called = true; return { ok: true, out: '' }; };
  const mockRunGit = async () => ({ ok: true, out: '' });

  await archiveRequirement(req.id, '', { runGit: mockRunGit, runGitDiff: mockRunGitDiff });
  assert.equal(called, false);
});
```

> **注意**：`createArchivedTestReq` 需要在 test 文件中找到已有的 archiveRequirement 测试辅助函数并复用。关键是需求 `phase='archiving'`，有 `branches` 记录，且 `busy=null`。

- [ ] **Step 5: 运行测试**

```bash
node --test src/entrypoints/web/requirement-ops.test.js
```

预期：全绿

- [ ] **Step 6: Commit**

```bash
git add src/entrypoints/web/requirement-ops.js src/entrypoints/web/requirement-ops.test.js
git commit -m "feat: 需求归档时收割 git diff 文件至功能账本"
```

---

## Task 6: routes-requirements.js — 功能标签路由 + handleGet 注入快照

**Files:**
- Modify: `src/entrypoints/web/routes-requirements.js`
- Modify: `src/entrypoints/web/routes-requirements.test.js`

- [ ] **Step 1: 在 routes-requirements.js 顶部 import 区追加**

```js
import { getTopFiles, getFeatureIndex } from '../../store/feature-index.js';
```

- [ ] **Step 2: 修改 handleGet，查询功能快照并传入 buildSeedPrompt**

找到 `handleGet` 函数，将 `seed:` 那行改为：

```js
// handleGet 内，sendJson 之前：
const featureSnapshot =
  r.featureTag && (r.phase === 'dev' || r.phase === 'test')
    ? (() => {
        const files = getTopFiles(r.featureTag);
        return files ? { tag: r.featureTag, files } : null;
      })()
    : null;

sendJson(res, 200, {
  ...r,
  devDocLatest,
  queued: hasQueuedTasks(id),
  devCwd: pickCwdAndDirs(r.projects).cwd,
  sessions: normalizeSessions(r),
  seed: r.phase === 'dev' || r.phase === 'test' ? buildSeedPrompt(r, { featureSnapshot }) : null,
  featureTag: r.featureTag ?? null,
});
```

- [ ] **Step 3: 新增 handleFeatureTag 函数**

```js
// routes-requirements.js 末尾附近，在 handleRequirementRoutes 前加：

// ==== PUT /api/req/feature-tag ====
function handleFeatureTag(req, res) {
  return withJsonBody(req, res, (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { error: 'id 不能为空' });
    const r = getRequirement(id);
    if (!r) return sendJson(res, 404, { error: '需求不存在' });
    // tag 为空字符串视为清除
    const tag = str(data.tag) || null;
    if (tag && tag.length > 20) return sendJson(res, 400, { error: 'tag 不能超过 20 字符' });
    updateRequirement(id, { featureTag: tag }, tag ? `手动设置功能模块标签：${tag}` : '清除功能模块标签');
    sendJson(res, 200, { ok: true, featureTag: tag });
  });
}

// ==== GET /api/feature-index ====
function handleFeatureIndex(res) {
  sendJson(res, 200, { index: getFeatureIndex() });
}
```

- [ ] **Step 4: 在 handleRequirementRoutes 分发函数里注册新路由**

找到 `handleRequirementRoutes` 内的路由分发 switch/if-else，添加两条：

```js
if (method === 'PUT' && pathname === '/api/req/feature-tag') return handleFeatureTag(req, res);
if (method === 'GET' && pathname === '/api/feature-index') return handleFeatureIndex(res);
```

- [ ] **Step 5: 在 routes-requirements.test.js 末尾追加路由测试**

```js
// routes-requirements.test.js 末尾追加

test('PUT /api/req/feature-tag：设置功能标签', async () => {
  // 参照已有 routes 测试的 fetch/createReq 辅助函数
  const req = await createTestRequirement({ title: '改宝宝辅食' });
  const res = await fetch(`${BASE}/api/req/feature-tag`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: req.id, tag: '宝宝辅食' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.featureTag, '宝宝辅食');

  // 验证持久化
  const getRes = await fetch(`${BASE}/api/req/get?id=${req.id}`);
  const data = await getRes.json();
  assert.equal(data.featureTag, '宝宝辅食');
});

test('PUT /api/req/feature-tag：tag 为空字符串时清除标签', async () => {
  const req = await createTestRequirement({ title: '清标签测试' });
  // 先设置
  await fetch(`${BASE}/api/req/feature-tag`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: req.id, tag: '宝宝辅食' }),
  });
  // 再清除
  const res = await fetch(`${BASE}/api/req/feature-tag`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: req.id, tag: '' }),
  });
  const body = await res.json();
  assert.equal(body.featureTag, null);
});

test('GET /api/feature-index：返回功能账本', async () => {
  const res = await fetch(`${BASE}/api/feature-index`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok('index' in body);
});
```

- [ ] **Step 6: 运行路由测试**

```bash
node --test src/entrypoints/web/routes-requirements.test.js
```

预期：全绿

- [ ] **Step 7: Commit**

```bash
git add src/entrypoints/web/routes-requirements.js src/entrypoints/web/routes-requirements.test.js
git commit -m "feat: 新增功能标签路由（PUT feature-tag / GET feature-index）及 seed 快照注入"
```

---

## Task 7: public/js/req-view.js — 评审期功能标签 chip

**Files:**
- Modify: `public/js/req-view.js`

- [ ] **Step 1: 找到评审期配置芯片条渲染代码**

在 `req-view.js` 中搜索渲染「工程配置芯片」的函数（一般是 `renderReviewChips` 或 `renderConfigChips` 或类似名称）。找到项目配置芯片渲染的最后一项，记录周围的 DOM 结构模式（`div.chip` 或 `span.chip` 等）。

- [ ] **Step 2: 在配置芯片区末尾追加功能标签 chip 渲染逻辑**

在芯片容器内，所有项目 chip 之后，追加：

```js
// req-view.js 芯片渲染区（紧接 projects/reqDoc chip 之后）

// 功能标签 chip（仅在 devDoc 至少有一版后才显示——docgen 完成才有标签）
if (req.devDoc?.versions?.length) {
  const tagChip = document.createElement('div');
  tagChip.className = 'req-chip req-chip--tag';
  tagChip.dataset.reqId = req.id;

  function renderTagChip(tag) {
    tagChip.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'req-chip__label';
    label.textContent = `功能模块：${tag || '未识别'}`;
    tagChip.appendChild(label);

    const editBtn = document.createElement('button');
    editBtn.className = 'req-chip__edit';
    editBtn.title = '修改功能模块标签';
    editBtn.textContent = '✏️';
    editBtn.onclick = () => showTagEditMode(tag);
    tagChip.appendChild(editBtn);
  }

  function showTagEditMode(currentTag) {
    tagChip.innerHTML = '';
    const input = document.createElement('input');
    input.className = 'req-chip__input';
    input.type = 'text';
    input.value = currentTag || '';
    input.placeholder = '如：宝宝辅食';
    input.maxLength = 20;
    tagChip.appendChild(input);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'req-chip__save';
    saveBtn.textContent = '保存';
    saveBtn.onclick = async () => {
      const newTag = input.value.trim();
      try {
        const res = await fetch('/api/req/feature-tag', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: req.id, tag: newTag }),
        });
        if (!res.ok) throw new Error(await res.text());
        renderTagChip(newTag || null);
      } catch (e) {
        // 显示错误不离开编辑模式
        input.style.borderColor = 'red';
        input.title = e.message;
      }
    };
    tagChip.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'req-chip__cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = () => renderTagChip(currentTag);
    tagChip.appendChild(cancelBtn);

    input.focus();
    input.select();
  }

  renderTagChip(req.featureTag);
  chipsContainer.appendChild(tagChip);  // chipsContainer = 芯片容器变量，按实际代码调整
}
```

- [ ] **Step 3: 在 app.css（或 req-view 内联样式区）添加 chip 样式**

```css
/* 功能标签 chip */
.req-chip--tag { display: inline-flex; align-items: center; gap: 4px; }
.req-chip__label { font-size: 12px; }
.req-chip__edit { background: none; border: none; cursor: pointer; padding: 0 2px; font-size: 12px; }
.req-chip__input { font-size: 12px; width: 120px; padding: 2px 4px; border: 1px solid #ccc; border-radius: 4px; }
.req-chip__save, .req-chip__cancel { font-size: 11px; padding: 2px 6px; margin-left: 2px; cursor: pointer; }
```

- [ ] **Step 4: 确认 GET /api/req/get 返回的 featureTag 字段被正确读取**

检查 `req-view.js` 中处理 `GET /api/req/get` 响应的地方（一般是 `openRequirement` 或 `fetchAndRenderReq`），确认 `req.featureTag` 从响应中正确传递到芯片渲染函数。如果渲染函数接收的 `req` 对象就是 API 响应体，则已自动可用（Task 6 中 handleGet 已加入 `featureTag: r.featureTag ?? null`）。

- [ ] **Step 5: 真机走查验证（无自动化测试）**

1. 创建新需求 → 配置工程 + 需求文档 → 触发 docgen
2. Docgen 完成后，评审期顶部芯片条出现「功能模块：宝宝辅食 ✏️」chip
3. 点 ✏️ → 内联输入框，修改后保存 → 芯片更新
4. 定稿 → 开发期 → 切换需求触发 `GET /api/req/get` → 检查 `seed` 字段是否包含「功能快照·宝宝辅食」

- [ ] **Step 6: Commit**

```bash
git add public/js/req-view.js public/css/app.css
git commit -m "feat: 评审期展示功能模块标签 chip，支持内联编辑"
```

---

## 自检清单（开始执行前）

1. **Spec 覆盖**：store/feature-index ✅ | docOutputContract §三 ✅ | parseFeatureTag ✅ | buildSeedPrompt 快照 ✅ | docgen 保存 tag ✅ | archive 收割 ✅ | 路由 ✅ | 前端 chip ✅
2. **类型一致性**：`featureSnapshot: { tag: string, files: [{path, count}] }` —— Task 1（store）/ Task 3（buildSeedPrompt）/ Task 6（handleGet 构造）三处定义一致
3. **降级保障**：runGitDiff 失败 → 跳过收割、归档不阻塞 ✅ | docgen 无 §三 → featureTag 不覆盖 ✅ | featureTag 为 null → seed 不注入快照 ✅
4. **不破坏已有测试**：docOutputContract 参数改为可选对象（旧调用方无参数仍可工作）✅ | buildRevisePrompt 旧签名 `{ supplement }` 仍有效（新参数有默认值）✅ | buildSeedPrompt 第二参数可选 ✅

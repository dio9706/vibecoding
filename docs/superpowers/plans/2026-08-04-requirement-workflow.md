# 「新需求」全生命周期工作流 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** web 执行台新增「新需求」入口，承载 评审设计期→开发期→测试期→归档 完整链条（spec：`docs/superpowers/specs/2026-08-04-requirement-workflow-design.md`，本计划所有契约以 spec 为准）。

**Architecture:** 后端新增 requirements store + requirement-ops 编排（docgen 只读生成/串行闸/系统任务走既有 startClaudeRun 基建）+ 薄路由；前端寄生复用 chat.js（需求会话=特殊 conv，仅 3 处钩子），评审/归档为独立文档视图模块 req-view.js。

**Tech Stack:** Node ESM（无框架 http 路由表）、node --test、原生 ES modules 前端（无构建）、@anthropic-ai/claude-agent-sdk、@larksuiteoapi/node-sdk（bitable 复用既有封装）。

**⚠️ 项目铁律（覆盖本技能默认）：**
1. **不做任何 git 提交**——提交时机由用户掌控。计划里所有「Commit」步骤替换为「跑全量测试确认绿」。
2. 注释一律中文，风格对齐所在文件。
3. 每个任务完成后运行 `npm test`（node --test，当前基线 485 例全绿）确认无回归。
4. 改后端需 `pm2 restart claude-web` 才生效（真机验收时）；前端静态文件实时读盘。

---

## 里程碑总览

| 里程碑 | 任务 | 交付 |
|---|---|---|
| P1 评审设计期 | Task 1-8 | 建需求→配置→docgen→补充修订→定稿建分支 端到端 |
| P2 开发期 | Task 9-10 | 定稿自动开发+需求会话寄生+横幅/右栏+API 文档修正管线 |
| P3 测试期 | Task 11-12 | bitable→BUG 面板→自动修/确认修 |
| P4 归档+打磨 | Task 13-14 | 归档档案+已归档分组+e2e |

---

### Task 1: requirements store（数据模型 + 状态机纯函数）

**Files:**
- Create: `src/store/requirements.js`
- Test: `src/store/requirements.test.js`

- [ ] **Step 1: 写失败测试**（`src/store/requirements.test.js`）

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 隔离数据目录：store/index.js 按 APP_DATA_DIR 定位，须在 import store 之前设置
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'req-store-'));
const { createRequirement, getRequirement, getRequirements, updateRequirement, canTransition, PHASE_FLOW } =
  await import('./requirements.js');

test('createRequirement：初始 review 期、空骨架、history 有创建记录', () => {
  const r = createRequirement({ title: '扫码支付改造' });
  assert.match(r.id, /^r_/);
  assert.equal(r.phase, 'review');
  assert.equal(r.title, '扫码支付改造');
  assert.deepEqual(r.projects, { frontend: null, backend: null });
  assert.deepEqual(r.devDoc, { versions: [] });
  assert.deepEqual(r.supplements, []);
  assert.deepEqual(r.apiDocs, []);
  assert.deepEqual(r.bugs, []);
  assert.equal(r.busy, null);
  assert.equal(r.history[0].event, '创建');
  assert.equal(getRequirement(r.id).id, r.id);
});

test('updateRequirement：patch 合并 + event 入 history；不存在返回 null', () => {
  const r = createRequirement({ title: 'X' });
  const u = updateRequirement(r.id, { designGuidelines: '主色 #4F6EF7' }, '更新设计准则');
  assert.equal(u.designGuidelines, '主色 #4F6EF7');
  assert.equal(u.history.at(-1).event, '更新设计准则');
  assert.equal(updateRequirement('r_none', {}, 'x'), null);
});

test('canTransition：只允许相邻推进，phase 不符返回 error', () => {
  assert.equal(canTransition('review', 'dev').ok, true);
  assert.equal(canTransition('dev', 'test').ok, true);
  assert.equal(canTransition('test', 'archiving').ok, true);
  assert.equal(canTransition('archiving', 'archived').ok, true);
  assert.equal(canTransition('review', 'test').ok, false);
  assert.equal(canTransition('archived', 'review').ok, false);
  assert.match(canTransition('review', 'test').error, /不允许/);
});

test('getRequirements 按 updatedAt 倒序', () => {
  const a = createRequirement({ title: 'A' });
  updateRequirement(a.id, {}, '触发更新');
  assert.equal(getRequirements()[0].id, a.id);
});
```

- [ ] **Step 2: 跑测试确认失败**：`node --test src/store/requirements.test.js` → FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/store/requirements.js`**

```js
/**
 * 需求（Requirement）存储 —— 「新需求」全生命周期工作流的数据模型。
 * 状态机：review → dev → test → archiving → archived（只允许相邻推进，守卫见 canTransition + ops 层）。
 * 与对话体系完全隔离：需求 conv 由前端 localStorage 持有，这里只记 convId/devSession 锚点。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'requirements.json';

/** 阶段推进表：key → 唯一合法的下一阶段 */
export const PHASE_FLOW = { review: 'dev', dev: 'test', test: 'archiving', archiving: 'archived' };

export function getRequirements() {
  // 倒序：列表/徽标都按最近更新展示
  return readJson(FILE, []).slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export function getRequirement(id) {
  return readJson(FILE, []).find((r) => r.id === id) || null;
}

export function createRequirement({ title }) {
  const now = new Date().toISOString();
  const req = {
    id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: String(title || '').slice(0, 60),
    phase: 'review',
    projects: { frontend: null, backend: null }, // { dir, dev:boolean } | null
    reqDoc: null, // { name, path }
    supplements: [], // [{ id, text, files:[{name,path}], at }]
    devDoc: { versions: [] }, // [{ v, path, summary, at }]
    docSession: null, // 评审期 docgen 的 Claude session（增量修订）
    convId: null, // 开发/测试期聊天 conv（前端回填）
    devSession: null, // 开发会话 session_id（onInit 回填，换浏览器重建 conv 续接）
    branches: [], // 定稿时逐开发工程 [{ dir, branch, baseBranch }]
    apiDocs: [], // [{ id, name, path, updatedAt }]
    designGuidelines: '',
    bitable: null, // { url, appToken, tableId }
    bugs: [], // [{ id, recordId, title, detail, verdict:'sure'|'doubt', reason, status, at }]
    busy: null, // { kind, runId, startedAt } —— 串行闸落盘镜像
    archive: null, // { note, summary, archivedAt }
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, event: '创建' }],
  };
  updateJson(FILE, [], (list) => {
    list.unshift(req);
    return list;
  });
  return req;
}

export function updateRequirement(id, patch = {}, event) {
  let updated = null;
  updateJson(FILE, [], (list) => {
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) return undefined; // 无此需求：不写盘
    const now = new Date().toISOString();
    list[i] = { ...list[i], ...patch, updatedAt: now };
    if (event) list[i].history.push({ at: now, event });
    updated = list[i];
    return list;
  });
  return updated;
}

/** 阶段流转守卫（纯函数）：只查相邻推进；busy/活跃 run 守卫在 ops 层（需要 runs 注册表） */
export function canTransition(from, to) {
  if (PHASE_FLOW[from] === to) return { ok: true };
  return { ok: false, error: `不允许从「${from}」流转到「${to}」` };
}
```

- [ ] **Step 4: 跑测试确认通过**：`node --test src/store/requirements.test.js` → PASS
- [ ] **Step 5: 全量回归**：`npm test` → 全绿

---

### Task 2: additionalDirectories 透传 + runs 按 conv 查活跃

**Files:**
- Modify: `src/integrations/claude.js`（runClaude 解构 + query options）
- Modify: `src/entrypoints/web/run-claude.js`（startClaudeRun 参数 + provider opts）
- Modify: `src/store/runs.js`（新增 hasActiveRunForConv）
- Test: `src/store/runs.test.js`（追加用例）

- [ ] **Step 1: runs.test.js 追加失败测试**

```js
test('hasActiveRunForConv：仅 running 且 convId 匹配为真', () => {
  const run = createRun();
  run.convId = 'c_req_1';
  assert.equal(hasActiveRunForConv('c_req_1'), true);
  assert.equal(hasActiveRunForConv('c_other'), false);
  finishRun(run.id);
  assert.equal(hasActiveRunForConv('c_req_1'), false);
  assert.equal(hasActiveRunForConv(''), false);
});
```
（import 行追加 `hasActiveRunForConv`；若该文件测试需要 finishRun 未导入则一并补。）

- [ ] **Step 2: 跑测试确认失败** → FAIL（未导出）

- [ ] **Step 3: 实现三处**

`src/store/runs.js`（`getRun` 附近追加）：
```js
/** 该 conv 是否有进行中的 run（需求串行闸用：系统任务须等用户对话空闲） */
export function hasActiveRunForConv(convId) {
  if (!convId) return false;
  for (const r of runs.values()) if (r.convId === convId && r.status === 'running') return true;
  return false;
}
```

`src/integrations/claude.js`：
- JSDoc 参数表加一行 `@param {string[]} [opts.additionalDirectories] 额外可访问目录（单会话跨双工程）`；
- 解构列表加 `additionalDirectories,`（放 `cwd,` 之后）；
- `query({ options: { ... } })` 内 `...(cwd ? { cwd } : {})` 之后加：
```js
      ...(additionalDirectories?.length ? { additionalDirectories } : {}),
```

`src/entrypoints/web/run-claude.js`：
- `startClaudeRun(run, {...})` 参数解构追加 `addDirs`（默认 undefined）；
- `providers.get(DEFAULT_PROVIDER_ID).run(prompt, {` 的 opts 对象里 `cwd: cwd || undefined,` 之后加：
```js
    ...(addDirs?.length ? { additionalDirectories: addDirs } : {}),
```
（provider claude-agent 是 opts 全透传，无需改。）

- [ ] **Step 4: 跑测试** `node --test src/store/runs.test.js` → PASS；`npm test` 全绿

---

### Task 3: req-logic 纯函数（prompt 构造 / summary 抽取 / bug 映射 / 档案拼装）

**Files:**
- Create: `src/entrypoints/web/req-logic.js`
- Test: `src/entrypoints/web/req-logic.test.js`

全部纯函数一次到位（P2-P4 的 prompt 也在此，后续任务只做接线）。

- [ ] **Step 1: 写失败测试**（要点用例，完整断言按下述行为写）

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectRoleLines, buildDocgenPrompt, buildRevisePrompt, extractSummary, nextDocVersion,
  buildDevelopPrompt, buildApiFixPrompt, buildBugFixPrompt,
  verdictToBug, mergeBugs, buildArchiveSummary, reqBranchName, pickCwdAndDirs,
} from './req-logic.js';

const PROJECTS = {
  frontend: { dir: 'D:/work/ui', dev: true },
  backend: { dir: 'D:/work/server', dev: false },
};

test('projectRoleLines：开发/只读角色显式声明；null 工程跳过', () => {
  const lines = projectRoleLines(PROJECTS).join('\n');
  assert.match(lines, /前端工程.*D:\/work\/ui.*【开发工程】/);
  assert.match(lines, /后端工程.*D:\/work\/server.*【只读参考工程，禁止修改其中任何文件】/);
  assert.equal(projectRoleLines({ frontend: null, backend: null }).length, 0);
});

test('pickCwdAndDirs：前端优先为 cwd，其余目录进 addDirs；单工程 addDirs 空', () => {
  assert.deepEqual(pickCwdAndDirs(PROJECTS), { cwd: 'D:/work/ui', addDirs: ['D:/work/server'] });
  assert.deepEqual(pickCwdAndDirs({ frontend: null, backend: { dir: 'D:/s', dev: true } }),
    { cwd: 'D:/s', addDirs: [] });
  assert.equal(pickCwdAndDirs({ frontend: null, backend: null }).cwd, null);
});

test('extractSummary：抽「说人话总结」节；解析失败取前 300 字', () => {
  const md = '## 一、说人话总结\n本次要在前端加扫码收银页。\n改动 6 个文件。\n\n## 二、详细设计\n...';
  assert.equal(extractSummary(md), '本次要在前端加扫码收银页。\n改动 6 个文件。');
  const noSec = 'x'.repeat(400);
  assert.equal(extractSummary(noSec), 'x'.repeat(300));
});

test('nextDocVersion：空=1，否则 max+1', () => {
  assert.equal(nextDocVersion({ versions: [] }), 1);
  assert.equal(nextDocVersion({ versions: [{ v: 1 }, { v: 3 }] }), 4);
});

test('buildDocgenPrompt/buildRevisePrompt：注入需求文档、补充、角色表与输出契约', () => {
  const p = buildDocgenPrompt({ reqDocText: '需求正文', supplements: [{ text: '补充1', files: [] }], projects: PROJECTS });
  assert.match(p, /需求正文/);
  assert.match(p, /补充1/);
  assert.match(p, /## 一、说人话总结/);
  assert.match(p, /只输出 markdown/);
  const rp = buildRevisePrompt({ supplement: { text: '新补充', files: [{ name: 'a.png', path: 'C:/a.png' }] } });
  assert.match(rp, /新补充/);
  assert.match(rp, /C:\/a\.png/);
});

test('verdictToBug：fix→sure/pending；ask|reject→doubt 带 reason', () => {
  const b = verdictToBug({ recordId: 'rec1', title: 'T', detail: 'D' }, { verdict: 'fix', reason: '' });
  assert.equal(b.verdict, 'sure');
  assert.equal(b.status, 'pending');
  const d = verdictToBug({ recordId: 'rec2', title: 'T2', detail: 'D2' }, { verdict: 'ask', reason: '无法定位' });
  assert.equal(d.verdict, 'doubt');
  assert.equal(d.reason, '无法定位');
});

test('mergeBugs：按 recordId 去重，已存在保留原状态，新记录追加', () => {
  const old = [{ id: 'b1', recordId: 'rec1', status: 'fixed' }];
  const merged = mergeBugs(old, [{ id: 'b9', recordId: 'rec1', status: 'pending' }, { id: 'b2', recordId: 'rec2', status: 'pending' }]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((b) => b.recordId === 'rec1').status, 'fixed');
});

test('reqBranchName：req/<id去前缀>-<slug 截断>', () => {
  assert.match(reqBranchName({ id: 'r_abc123', title: '扫码支付改造' }, ), /^req\/abc123-/);
});

test('buildArchiveSummary：文档版次/分支提交/BUG 统计/备注齐备；git 摘要缺失降级', () => {
  const s = buildArchiveSummary({
    req: { title: 'T', devDoc: { versions: [{ v: 3 }] }, branches: [{ dir: 'D:/ui', branch: 'req/x', baseBranch: 'main' }],
      bugs: [{ status: 'fixed', title: 'b1' }, { status: 'ignored', title: 'b2' }] },
    note: '注意灰度', branchLogs: [{ branch: 'req/x', log: null }],
  });
  assert.match(s, /开发文档.*v3/);
  assert.match(s, /req\/x/);
  assert.match(s, /无法读取提交摘要/);
  assert.match(s, /修复 1/);
  assert.match(s, /注意灰度/);
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现 `req-logic.js`**（行为契约如下，全部无 IO）

```js
/**
 * 需求工作流纯逻辑 —— prompt 构造 / 文档解析 / BUG 判决映射 / 档案拼装（单测目标，零 IO）。
 * docgen 输出契约（spec §5.3）：纯 markdown，第一节「## 一、说人话总结」，第二节「## 二、详细设计」。
 */

export function projectRoleLines(projects) {
  const out = [];
  const add = (label, p) => {
    if (!p?.dir) return;
    out.push(`- ${label}：${p.dir} ${p.dev ? '【开发工程】' : '【只读参考工程，禁止修改其中任何文件】'}`);
  };
  add('前端工程', projects?.frontend);
  add('后端工程', projects?.backend);
  return out;
}

/** cwd=前端优先无则后端；其余已配置目录进 addDirs（spec：全篇「第一个工程」按此序） */
export function pickCwdAndDirs(projects) {
  const dirs = [projects?.frontend?.dir, projects?.backend?.dir].filter(Boolean);
  return { cwd: dirs[0] || null, addDirs: dirs.slice(1) };
}

export function buildDocgenPrompt({ reqDocText, supplements = [], projects }) { /* 见下方契约 */ }
export function buildRevisePrompt({ supplement }) { /* 增量修订：只给新补充，要求输出完整新版文档（同一契约） */ }
export function extractSummary(md) { /* 抽「## 一、说人话总结」到下一个 ## 之间的正文 trim；无则前 300 字 */ }
export function nextDocVersion(devDoc) { /* versions 空=1，否则 max(v)+1 */ }
export function buildDevelopPrompt({ req, docPath }) { /* 角色表+开发文档路径（让 AI Read）+设计准则+API 文档列表+「按文档开始可进行的开发」 */ }
export function buildApiFixPrompt({ action, doc }) { /* 「API 文档 X 已新增/更新/删除（路径 …）→ 对照修正本需求已实现代码」 */ }
export function buildBugFixPrompt({ bug }) { /* BUG 标题+detail → 修复；不修改只读参考工程 */ }
export function verdictToBug(record, { verdict, reason }) { /* fix→{verdict:'sure',status:'pending'}；其余→{verdict:'doubt',status:'pending',reason}；id='b_'+ts36+rand */ }
export function mergeBugs(oldBugs, incoming) { /* recordId 去重：已存在的保留旧条目（状态不回退），新 recordId 追加 */ }
export function reqBranchName(req) { /* 'req/' + id去掉 r_ 前缀 + '-' + title slug（[\w一-龥]，截 20 字） */ }
export function buildArchiveSummary({ req, note, branchLogs }) { /* markdown：标题/终稿版次/逐分支提交摘要（log 为 null → 「（无法读取提交摘要）」）/BUG 统计（fixed/ignored/failed 计数+清单）/用户备注 */ }
```

buildDocgenPrompt 全文（buildRevisePrompt 尾部同样带输出契约段）：

```js
export function buildDocgenPrompt({ reqDocText, supplements = [], projects }) {
  const sup = supplements.length
    ? `\n补充说明（按时间序，后者优先级更高）：\n` + supplements.map((s, i) =>
        `${i + 1}. ${s.text}${(s.files || []).length ? `（附件：${s.files.map((f) => `${f.name} → ${f.path}`).join('、')}，请先 Read）` : ''}`).join('\n') + '\n'
    : '';
  return (
    `你是资深架构师，请阅读需求文档并实际查证下列工程后，产出一份开发文档。\n\n` +
    `工程角色（只读查证，本次不做任何修改）：\n${projectRoleLines(projects).join('\n')}\n\n` +
    `需求文档全文：\n「${reqDocText}」\n${sup}\n` +
    `输出契约（严格遵守）：只输出 markdown 正文，不要任何解释性开场白。结构必须是——\n` +
    `## 一、说人话总结\n（用大白话概括要改什么、影响哪些地方，非技术人员能看懂）\n\n` +
    `## 二、详细设计\n（逐【开发工程】列出：新增 / 删除 / 更新 的文件与内容要点，精确到文件路径；只读参考工程仅作依据引用）`
  );
}
```

- [ ] **Step 4: 跑测试** → PASS；`npm test` 全绿

---

### Task 4: requirement-ops 核心（串行闸队列 + docgen 编排 + 崩溃恢复）

**Files:**
- Create: `src/entrypoints/web/requirement-ops.js`
- Test: `src/entrypoints/web/requirement-ops.test.js`（纯队列判定用依赖注入测）

- [ ] **Step 1: 失败测试**（队列出队条件纯函数 `canDispatch`）

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDispatch } from './requirement-ops.js';

test('canDispatch：busy 空且 conv 无活跃 run 才放行', () => {
  assert.equal(canDispatch({ busy: null, convId: 'c1' }, () => false), true);
  assert.equal(canDispatch({ busy: { kind: 'develop' }, convId: 'c1' }, () => false), false);
  assert.equal(canDispatch({ busy: null, convId: 'c1' }, (id) => id === 'c1'), false);
  assert.equal(canDispatch({ busy: null, convId: null }, () => true), true); // 无 conv（docgen）只看 busy
});
```

- [ ] **Step 2: 确认失败** → FAIL

- [ ] **Step 3: 实现 requirement-ops.js 骨架 + docgen**

```js
/**
 * 需求工作流编排 —— docgen / 定稿建分支 / 系统任务串行闸 / bitable 巡检 / 归档。
 * 串行闸（spec §5.3）：内存队列单泵（仅 claude-web 进程），出队条件 = busy 空 且 conv 无活跃 run；
 * busy 落盘镜像供崩溃恢复：启动时清残留并记 history，不自动重跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getRequirement, getRequirements, updateRequirement } from '../../store/requirements.js';
import { hasActiveRunForConv, createRun } from '../../store/runs.js';
import { startClaudeRun } from './run-claude.js';
import { runClaude } from '../../integrations/claude.js';
import { claudeAuthOpts } from '../../features/token-rotation.js';
import { appDataPath } from '../../shared/app-paths.js';
import { logger } from '../../shared/logger.js';
import * as L from './req-logic.js';

export const DOCGEN_TIMEOUT_MS = 15 * 60_000; // spec §5.3：docgen race 上限
const POLL_MS = 5000;

export function reqDir(id, ...rest) {
  const dir = appDataPath('requirements', id, ...rest.slice(0, -1));
  fs.mkdirSync(dir, { recursive: true });
  return rest.length ? path.join(dir, rest.at(-1)) : dir;
}

/** 出队条件（纯函数，测试注入 hasActive） */
export function canDispatch(req, hasActive = hasActiveRunForConv) {
  if (!req || req.busy) return false;
  return !(req.convId && hasActive(req.convId));
}

// —— 系统任务队列（develop / api-fix / bug-fix；docgen 不进 conv 但同样占 busy）——
const queue = []; // [{ reqId, kind, payload }]
let pumping = false;

export function enqueueSystemTask(reqId, kind, payload = {}) {
  queue.push({ reqId, kind, payload });
  logger.info('req-ops', '系统任务入队', { reqId, kind, queueLen: queue.length });
}

export function startRequirementPump() {
  recoverBusyOnBoot();
  setInterval(() => pump().catch((e) => logger.error('req-ops', '泵异常', { err: e?.message || String(e) })), POLL_MS);
}

/** 崩溃恢复：busy 残留 = 上个进程死在任务中途 → 清标记记档，不自动重跑（spec §5.3/§7） */
function recoverBusyOnBoot() {
  for (const r of getRequirements()) {
    if (r.busy) updateRequirement(r.id, { busy: null }, `任务 ${r.busy.kind} 因进程重启中断`);
  }
}

async function pump() {
  if (pumping || !queue.length) return;
  const i = queue.findIndex((t) => canDispatch(getRequirement(t.reqId)));
  if (i < 0) return;
  pumping = true;
  const task = queue.splice(i, 1)[0];
  try {
    await dispatch(task);
  } finally {
    pumping = false;
  }
}

async function dispatch({ reqId, kind, payload }) {
  const req = getRequirement(reqId);
  if (!req) return;
  if (kind === 'docgen') return runDocgen(req, payload);
  // develop / api-fix / bug-fix：走 startClaudeRun（conv 流可见），结束回调里清 busy
  const { cwd, addDirs } = L.pickCwdAndDirs(req.projects);
  const prompt =
    kind === 'develop' ? L.buildDevelopPrompt({ req, docPath: req.devDoc.versions.at(-1)?.path }) :
    kind === 'api-fix' ? L.buildApiFixPrompt(payload) :
    L.buildBugFixPrompt(payload);
  const run = createRun();
  updateRequirement(reqId, { busy: { kind, runId: run.id, startedAt: Date.now() } }, `系统任务 ${kind} 启动`);
  if (kind === 'bug-fix') setBugStatus(reqId, payload.bug.id, 'fixing');
  run.onSettle = (ok) => { // 见 Step 4：startClaudeRun 收尾钩子
    updateRequirement(reqId, { busy: null }, `系统任务 ${kind} ${ok ? '完成' : '失败'}`);
    if (kind === 'bug-fix') setBugStatus(reqId, payload.bug.id, ok ? 'fixed' : 'failed');
  };
  startClaudeRun(run, { prompt, cwd, addDirs, session: req.devSession || undefined,
    mode: 'bypassPermissions', convId: req.convId || undefined });
}

function setBugStatus(reqId, bugId, status) {
  const req = getRequirement(reqId);
  if (!req) return;
  updateRequirement(reqId, { bugs: req.bugs.map((b) => (b.id === bugId ? { ...b, status } : b)) });
}
```

`runDocgen(req)`（同文件）：守卫（≥1 工程目录 + reqDoc，否则 throw 业务错误）→ 写 busy →
`runClaude(prompt, { ...claudeAuthOpts(), cwd, additionalDirectories: addDirs, permissionMode:'default',
allowedTools:['Read','Grep','Glob'], resume: req.docSession || undefined, persistSession: true,
onInit: (i)=>docSession 回填, onResult: 收 result })`，外面套 `Promise.race` 15min；
成功 → `dev-doc-v{N}.md` 落 `reqDir(id, 'dev-doc-v'+N+'.md')`，versions push `{v,path,summary:extractSummary,at}`，清 busy；
失败/超时 → 清 busy + history 记原因 + 重新 throw（路由侧不感知——docgen 经队列异步跑，前端靠轮询 busy/history）。
首版用 `buildDocgenPrompt`（全量上下文），修订用 `buildRevisePrompt`（resume docSession 只给新补充）。

- [ ] **Step 4: startClaudeRun 收尾钩子**：`run-claude.js` 的 `settleRun`（finish/fail/block 汇聚点）开头加：

```js
  if (typeof run.onSettle === 'function') {
    try { run.onSettle(kind === 'finish'); } catch (e) { logger.warn('web', 'onSettle 回调异常', { err: e?.message || String(e) }); }
    run.onSettle = null;
  }
```
（先读 settleRun 现有形态，把 `kind==='finish'` 换成该函数内表示「正常完成」的实际判据；devSession 回填同点：
`run.session_id && updateRequirement(reqId,{devSession:run.session_id})`——由 onSettle 闭包内做，reqId 在闭包里。）

- [ ] **Step 5: web 启动接线**：`server.js` listen 回调（找 `startAutoDevPump()` 或孤儿恢复调用处）追加
`startRequirementPump();`（import 自 requirement-ops）。

- [ ] **Step 6: 跑测试**：`node --test src/entrypoints/web/requirement-ops.test.js` → PASS；`npm test` 全绿

---

### Task 5: finalize 定稿（建分支 + 自动首轮开发）

**Files:**
- Modify: `src/entrypoints/web/requirement-ops.js`
- Test: `src/entrypoints/web/requirement-ops.test.js`（追加 finalize 纯判定测试）

- [ ] **Step 1: 失败测试**（守卫纯函数）

```js
import { finalizeGuard } from './requirement-ops.js';

test('finalizeGuard：无文档/无开发工程拒绝；OK 返回开发工程清单', () => {
  const ok = finalizeGuard({ phase: 'review', devDoc: { versions: [{ v: 1 }] },
    projects: { frontend: { dir: 'D:/ui', dev: true }, backend: { dir: 'D:/s', dev: false } } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.devProjects.map((p) => p.dir), ['D:/ui']);
  assert.equal(finalizeGuard({ phase: 'review', devDoc: { versions: [] }, projects: { frontend: { dir: 'D:/ui', dev: true }, backend: null } }).ok, false);
  assert.equal(finalizeGuard({ phase: 'review', devDoc: { versions: [{ v: 1 }] }, projects: { frontend: { dir: 'D:/ui', dev: false }, backend: null } }).ok, false);
  assert.equal(finalizeGuard({ phase: 'dev', devDoc: { versions: [{ v: 1 }] }, projects: { frontend: { dir: 'D:/ui', dev: true }, backend: null } }).ok, false);
});
```

- [ ] **Step 2: 确认失败** → FAIL

- [ ] **Step 3: 实现**（requirement-ops.js 追加；git 复用 `plugins/team-tools/auto-dev/git.js` 的
`currentBranch`/`isClean` + `integrations/shell.js` 的 `runScript`）

```js
export function finalizeGuard(req) {
  if (req.phase !== 'review') return { ok: false, error: '仅评审设计期可定稿' };
  if (!req.devDoc.versions.length) return { ok: false, error: '请先生成开发文档' };
  const devProjects = [req.projects.frontend, req.projects.backend].filter((p) => p?.dir && p.dev);
  if (!devProjects.length) return { ok: false, error: '至少需要一个「开发工程」' };
  return { ok: true, devProjects };
}

/** 定稿：脏区检查（force 可越）→ 逐开发工程建分支 → phase=dev → 自动首轮开发入队 */
export async function finalizeRequirement(id, { force = false } = {}) {
  const req = getRequirement(id);
  const g = finalizeGuard(req || {});
  if (!g.ok) return { ok: false, status: 409, error: g.error };
  if (!force) {
    const dirty = [];
    for (const p of g.devProjects) if (!(await isClean(p.dir))) dirty.push(p.dir);
    if (dirty.length) return { ok: false, status: 409, warn: 'dirty', dirs: dirty };
  }
  const branch = L.reqBranchName(req);
  const branches = [];
  for (const p of g.devProjects) {
    const baseBranch = await currentBranch(p.dir);
    if (!baseBranch || baseBranch === 'HEAD') return { ok: false, status: 400, error: `${p.dir} 不是 git 仓库或处于 detached HEAD` };
    const co = await runScript('git', ['-C', p.dir, 'checkout', '-b', branch], { shell: false });
    if (!co.ok) return { ok: false, status: 500, error: `创建分支失败（${p.dir}）：${(co.err || '').slice(0, 200)}` };
    branches.push({ dir: p.dir, branch, baseBranch });
  }
  updateRequirement(id, { phase: 'dev', branches }, `定稿：建分支 ${branch}，进入开发期`);
  enqueueSystemTask(id, 'develop');
  return { ok: true, branch };
}
```
注意：多工程时第二个建分支失败 → 前面已建分支保留（history 记明），错误直接回告，不做回滚魔法（KISS，用户可 force 重试——`checkout -b` 已存在分支会失败，重试路径改用 `checkout -B`？不——幂等处理：branchExists(dir,branch) 为真则 `checkout` 切过去即可，复用 auto-dev/git.js `ensureBranch`）。**实现用 `ensureBranch(p.dir, branch)`**（已存在则切换，不存在则创建），上面 co 段替换为：
```js
    const ok = await ensureBranch(p.dir, branch);
    if (!ok) return { ok: false, status: 500, error: `创建/切换分支失败（${p.dir}）` };
```

- [ ] **Step 4: 跑测试** → PASS；`npm test` 全绿

---

### Task 6: routes-requirements + server.js 挂载

**Files:**
- Create: `src/entrypoints/web/routes-requirements.js`
- Modify: `src/entrypoints/web/server.js`（import + 路由行）
- Test: `src/entrypoints/web/routes-requirements.test.js`

薄壳：解析 body → 调 store/ops → JSON 应答。路由清单（spec §5.2，全部 POST 除标注外）：

```
POST /api/req/create {title}                    → createRequirement
GET  /api/req/list                              → getRequirements() 精简投影 [{id,title,phase,updatedAt,busy:!!busy}]
GET  /api/req/get?id=                           → 完整记录 + devDocLatest（最新版 md 原文）
GET  /api/req/doc?id=&v=                        → 指定版 md 原文 {content}
PUT  /api/req/config {id,projects,reqDoc:{name,text|path}}   → 仅 review 期（否则 409）；text 落盘 reqDir(id,'req-doc.md')
POST /api/req/docgen {id}                       → 守卫后 enqueueSystemTask(id,'docgen')，busy 或队列已有同类任务 → 409
POST /api/req/supplement {id,text,files}        → supplements push + enqueue docgen（修订）
POST /api/req/finalize {id,force}               → finalizeRequirement
POST /api/req/apidoc {id,name,path} / DELETE 同路径 {id,docId}  → apiDocs 增删 + enqueue api-fix（仅 dev 期）
PUT  /api/req/guidelines {id,text}              → designGuidelines（仅 dev/test 期）
POST /api/req/conv {id,convId}                  → convId 回填
POST /api/req/dev-done {id} / test-pass {id} / archive {id,note}   → 阶段流转（canTransition + busy/活跃 run 守卫）
POST /api/req/bitable {id,url}                  → P3 接入（本任务先注册路由返回 501）
POST /api/req/bug/confirm|ignore|retry {id,bugId} → P3（先 501）
```

- [ ] **Step 1: 失败测试**：直调 handler（模仿既有 routes 测试风格；若无先例则用 node:http 起临时 server 打真请求，
  APP_DATA_DIR 用 mkdtemp）。覆盖：create→list→get 回读；config 在 dev 期 409；docgen 无工程目录 400；
  dev-done 在 review 期 409（相邻推进守卫）；busy 非空时 dev-done 409。
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现路由文件**（http-util.js 有 readBody/json 辅助，先读它对齐用法）；server.js 在
  `/api/tasks` 行附近追加 `if (url.pathname.startsWith('/api/req/')) return handleRequirementRoutes(req, res, url);`
  （单入口分发，routes-requirements 内部按 pathname/method 细分，避免 server.js 膨胀 15 行）。
- [ ] **Step 4: 跑测试** → PASS；`npm test` 全绿

---

### Task 7: 设置页「我的飞书 open_id」

**Files:**
- Modify: `src/store/settings.js`（DEFAULTS + normalizeSettings 加 `myFeishuOpenId: ''`）
- Modify: `src/entrypoints/web/routes-settings.js`（GET 透出 / PUT 白名单收字符串，≤128 字符）
- Modify: `public/js/settings-panel.js` + `public/index.html`（基础 tab 一个输入框，带说明「测试期筛多维表格 BUG 用；留空回退可信提交人名单第一个」）
- Test: `src/store/settings.test.js` 追加 normalize 用例

- [ ] Step 1-4：同前 TDD 节奏（normalize 非字符串归空串 → 实现 → 面板输入框对齐现有 set-field 结构）→ `npm test` 全绿

---

### Task 8: 前端 P1（侧栏 + 评审期文档模式）

**Files:**
- Modify: `public/index.html`（侧栏按钮/需求列表挂载点 + panelView 新增 `panel-page[data-view="req"]`）
- Create: `public/js/req-view.js`
- Modify: `public/app.js`（import req-view、showView 桥接）
- Modify: `public/js/chat.js`（仅 renderConvList 过滤钩子——本任务只需这一处）
- Modify: `public/app.css`（req 区样式）
- Test: `tests/e2e-req-review.mjs`（Playwright，对齐 e2e-panels-smoke.mjs 写法）

- [ ] **Step 1: index.html**
  - `#sidebarNew` 按钮行改为双按钮：`<button class="btn" id="sidebarNew">＋ 新对话</button><button class="btn" id="sidebarNewReq">＋ 新需求</button>`（同容器内，样式沿用 .btn）；
  - `#convList` 前插 `<div class="req-list" id="reqList" hidden></div>`；
  - `#panelView` 内追加 `<section class="panel-page" data-view="req" hidden><div id="reqPage"></div></section>`。

- [ ] **Step 2: req-view.js（P1 范围）** —— 导出 `initReqView({ showView })`、`openRequirement(id)`、`refreshReqList()`。
  行为契约（DOM 全部动态构建进 `#reqList` / `#reqPage`）：
  - `refreshReqList()`：GET /api/req/list → 「本次需求」分组（phase≠archived）+「已归档」折叠组；行=标题+阶段徽标
    （评审=橙/开发=蓝/测试=紫/归档中=灰），点击 `openRequirement(id)`；列表空则整个 `#reqList` 隐藏；30s 轮询 + 打开视图时即刷。
  - `＋新需求`：`ui.js` 若有输入弹窗则复用，否则用 `prompt()` 同款自建最小弹窗 → POST /api/req/create → 打开。
  - `openRequirement(id)`：GET /api/req/get → P1 一律进文档模式 `showView('req')` 并渲染 `#reqPage`：
    - 顶部芯片条：前端/后端工程芯片（目录+开发/只读，点击开配置编辑弹层——两个目录输入框各带「开发工程」checkbox，
      目录选择复用 dir-popover 若接口可注入，否则纯文本输入）+ 需求文档芯片（未配置=「＋需求文档」，弹层里
      粘贴文本 textarea 或文件上传走 /api/upload）+ 保存调 PUT /api/req/config；phase≠review 时芯片只读。
    - 文档区：无版本 → 空态引导+［生成开发文档］（POST docgen）；有版本 → 版本页签 v1..vN（GET /api/req/doc 渲染
      markdown，用 util.renderMarkdown）+ 顶部「说人话总结」高亮块（summary）+ 右上［✓ 定稿，进入开发期］；
    - busy.docgen 进行中 → 页签区顶部进度条 + 3s 轮询 GET /api/req/get，busy 消失即刷新版本；history 末条含
      「失败/中断」→ 错误横条+［重试］。
    - 底部补充框（`#reqPage` 内自带，非 chat composer）：textarea + 📎（/api/upload 多文件）+［提交补充说明］
      → POST /api/req/supplement → toast「已提交，文档修订中」+ 进入 busy 轮询。
    - ［定稿］→ confirmDialog →POST finalize；返回 `warn:'dirty'` → 二次 confirmDialog（列脏目录，「强制定稿」）
      带 force 重发；成功 → toast + refreshReqList（P1 阶段 dev 期视图尚未实现，openRequirement 对 dev 期先渲染
      占位「开发期视图将在 P2 交付」）。

- [ ] **Step 3: app.js 接线**：import `initReqView, openRequirement, refreshReqList`；`showView` 的 else-if 链加
  `else if (name === 'req') { /* req-view 自渲染，无需额外加载 */ }`；启动闸门内 `initChat()` 后加
  `initReqView({ showView }); refreshReqList();`；绑定 `$('#sidebarNewReq')` 点击。

- [ ] **Step 4: chat.js 过滤钩子**：`renderConvList` 的 `buildMergedHistory()` 结果处（`const allEntries = ...` 下一行）加：
```js
        const entries = allEntries.filter((e) => !e.meta?.reqId && !loadConvs().find((c) => c.id === e.convId)?.meta?.reqId);
```
（先读 buildMergedHistory 的 entry 形态，用其真实字段实现「conv.meta.reqId 排除」，后续引用统一换成 entries。）

- [ ] **Step 5: app.css**：`.req-list`（分组标题/行/徽标色）、`.req-page`（芯片条/文档区/版本页签/总结高亮块/底部补充框）、
  进度条动画。风格对齐现有 panel-page 内部样式（settings 面板的 set-sec 家族可参考）。

- [ ] **Step 6: e2e**（`tests/e2e-req-review.mjs`，需先 `pm2 restart claude-web`）：加载页面零 pageerror →
  点＋新需求→建「e2e 测试需求」→ 出现在列表→ 打开→ 配置芯片可开弹层→ 断言 docgen 按钮存在（不真跑 docgen）。
  运行：`node tests/e2e-req-review.mjs` → PASS

- [ ] **Step 7: `npm test` 全绿 + 真机走查 P1**（用户）：配置真实工程+需求文档 → 生成文档 → 补充修订 → 定稿建分支。

---

### Task 9: P2 后端（API 文档修正管线 + guidelines 生效）

**Files:**
- Modify: `src/entrypoints/web/routes-requirements.js`（apidoc/guidelines 由 501 转实调）
- Modify: `src/entrypoints/web/requirement-ops.js`（无新逻辑，验证 develop/api-fix 链路）
- Test: routes 测试追加

- [ ] Step 1-4：TDD——apidoc POST（dev 期外 409；成功 push apiDocs + enqueue `api-fix` payload `{action:'新增'|'更新'|'删除', doc}`；
  同名 name 视为「更新」替换 path）；DELETE 移除 + enqueue（action 删除）；guidelines PUT 存文本。
  buildDevelopPrompt/buildApiFixPrompt 已在 Task 3 定形，此处只接线。`npm test` 全绿。

---

### Task 10: P2 前端（需求会话寄生 + 横幅 + 开发期右栏）

**Files:**
- Modify: `public/js/chat.js`（钩子 2/3：openConv 挂卸载通知 + createReqConv 导出）
- Modify: `public/js/req-view.js`（聊天模式：横幅/右栏/完成开发）
- Modify: `public/index.html`（chat 视图内横幅/右栏挂载点）+ `public/app.css`

- [ ] **Step 1: index.html 挂载点**：messages 区外层（`.messages` 的父容器内、messages 之前）加
  `<div id="reqBanner" hidden></div>`；messages 同级右侧加 `<aside id="reqRail" hidden></aside>`
  （flex 布局：`.chat-body{display:flex}` 包裹 messages+rail，先读现有结构选最小侵入包法）。

- [ ] **Step 2: chat.js 钩子**
  - 模块顶部：`let _reqConvHook = null; export function bindReqConvHook(fn) { _reqConvHook = fn; }`
  - `openConv(id)` 末尾（`renderPendingBanner()` 之后）：`_reqConvHook?.(c.meta?.reqId || null);`
  - `newConversation()` 内 `renderPendingBanner()` 之后：`_reqConvHook?.(null);`
  - 导出 `createReqConv({ reqId, cwd, session, title })`：构造 conv 对象 push 进 loadConvs()（字段对齐
    newConversation 后首次 send 建 conv 的形态——先读 send() 里建 conv 的代码块照抄字段），带
    `meta:{reqId}`、`session`，saveConvs 后返回 convId。**不**调 renderConvList（req conv 不进列表）。

- [ ] **Step 3: req-view.js 聊天模式**
  - `openRequirement`：phase dev/test → 确保 conv（record.convId 且本地存在 → openConv；本地丢失/无 convId →
    `createReqConv({reqId, cwd: 第一个开发工程, session: record.devSession})` + POST /api/req/conv 回填 → openConv）。
  - `bindReqConvHook(reqId => reqId ? mountReqChrome(reqId) : unmountReqChrome())`：
    - `mountReqChrome`：fetch 记录 → `#reqBanner` 渲染工程芯片×2+需求文档芯片（点开抽屉显 md）+ 阶段按钮
      （dev=［✅ 完成开发］→confirm→POST dev-done→重开需求；test=［✅ 测试通过］）；`#reqRail` 按 phase 渲染：
      dev 期=API 文档列表（每项：名称+更新时间+［替换］［删除］；顶部［＋上传 API 文档］走 /api/upload→POST apidoc；
      变更后 toast「已入队自动修正」）+ 设计准则 textarea（失焦 PUT guidelines）；busy 芯片（「⚙ 系统任务运行中」）
      3s 轮询。
    - `unmountReqChrome`：两容器清空置 hidden。
  - ≤960px：`#reqRail` display:none，横幅加「📚/🐞」芯片点开浮层承载同内容（CSS media + 同一渲染函数换容器）。

- [ ] **Step 4: e2e 补充**：打开 dev 期需求 → 横幅/右栏出现 → 切普通会话消失 → 零 pageerror。`npm test` 全绿。
- [ ] **Step 5: 真机走查 P2**（用户）：定稿 → 自动首轮开发在对话流可见 → 上传 API 文档触发修正 → 对话调整 → 完成开发。

---

### Task 11: P3 后端（bitable 巡检 → bugs + 确认/忽略/重试）

**Files:**
- Modify: `src/entrypoints/web/requirement-ops.js`（`inspectBitable` + bug 操作）
- Modify: `src/entrypoints/web/routes-requirements.js`（bitable/bug 路由转实调）
- Test: ops 测试追加（verdict 映射与去重已在 Task 3 测过，这里测 bug confirm/ignore 状态流转）

- [ ] **Step 1-2: 失败测试 → FAIL**：`confirmBug`（doubt→pending 入队 bug-fix）、`ignoreBug`（→ignored）、
  `retryBug`（failed→pending 入队）；非法 bugId/状态返回 error。

- [ ] **Step 3: 实现 `inspectBitable(id, url)`**（复用清单见 spec §5.4）：
  - 身份：`getSettings().myFeishuOpenId || resolveTrustedOpenIds(getActiveBot(), config.lark.trustedOpenIds)[0]`，
    皆空 → `{ok:false,error:'请先在设置页填写「我的飞书 open_id」'}`；
  - `parseBitableLink`（import 自 `plugins/team-tools/bug-patrol/logic.js`）→ base 直用 / wiki 经
    `resolveWikiNodeObj` 换 token（objType!=='bitable' 报错）；
  - 表定位/字段映射/筛选：与 bug-patrol `runPatrol` 同套（listBitableTables→listBitableFields→Haiku 映射
    `runClassifierOnce(buildFieldMappingPrompt)`→`validateFieldMapping`→`searchBitableRecords(buildStatusFilter)`
    →`isAssignedToMe`）；
  - 逐条 `reviewTask({id:'reqbug_'+recordId, type:'bug', title, detail})` → `verdictToBug` → `mergeBugs` 合入
    `req.bugs`（去重保状态）→ `bitable` 字段落 `{url, appToken, tableId}`；
  - **sure 且 status pending 的新 bug 自动 `enqueueSystemTask(id,'bug-fix',{bug})`**；doubt 等面板确认；
  - **不回写表格状态**（spec §5.4）；巡检期间占 busy `{kind:'bitable'}`（防重复提交），结束清。
  - 路由：POST /api/req/bitable 仅 test 期 & busy 空 → 202 受理（异步跑，前端轮询 bugs/busy）。

- [ ] **Step 4: 跑测试 → PASS；`npm test` 全绿**

---

### Task 12: P3 前端（测试期右栏 BUG 面板）

**Files:**
- Modify: `public/js/req-view.js` + `public/app.css`

- [ ] **Step 1: 实现**：test 期 `#reqRail` = 贴表格输入框（url+［开始巡检］→POST bitable→busy 轮询「巡检中…」）+
  BUG 卡列表（sure=绿左边框：状态徽标 修复中/已修复/失败[重试]；doubt=橙左边框：reason + ［确认修复］［忽略］），
  操作调 /api/req/bug/*；3s 轮询刷新（复用 dev 期 busy 轮询器）。
- [ ] **Step 2: e2e 补充**（面板渲染与按钮存在性，桩数据）；`npm test` 全绿。
- [ ] **Step 3: 真机走查 P3**（用户）：真表格全流程（依赖 \10001 已开通的 bitable 权限）。

---

### Task 13: P4 归档

**Files:**
- Modify: `src/entrypoints/web/requirement-ops.js`（`archiveRequirement`：`git log baseBranch..branch --oneline`
  逐分支收集（失败 log=null）→ `buildArchiveSummary` → 落 `reqDir(id,'archive.md')` → phase=archived）
- Modify: `src/entrypoints/web/routes-requirements.js`（archive 转实调；GET /api/req/get 附带 archive.md 内容）
- Modify: `public/js/req-view.js`（archiving=文档模式变体：档案预览块+备注 textarea+［确认归档］；
  archived=只读档案渲染；侧栏「已归档」折叠组点击可看）
- Test: ops 测试（git 摘要注入桩：branchLogs 参数化已在 Task 3 覆盖，这里测 phase 流转+文件落盘）

- [ ] Step 1-4：TDD 同节奏；`npm test` 全绿；真机：测试通过 → 填备注 → 归档 → 已归档组回看。

---

### Task 14: 收尾（e2e 全链路 + 打磨 + 交付走查清单）

- [ ] **Step 1**: `tests/e2e-req-review.mjs` 扩为四阶段全景（桩后端数据直写 requirements.json 构造各 phase 需求，
  逐一打开断言视图正确 + 零 pageerror）；纳入与既有 e2e 相同的运行说明。
- [ ] **Step 2**: 打磨清单——窄屏（≤960 rail 收芯片、≤720 侧栏既有行为不回归）、docgen 错误态、
  finalize dirty 弹窗文案、busy 期间按钮禁用态。
- [ ] **Step 3**: `npm test` 全绿 + 四道既有 e2e 门禁全过（panels-smoke / steer-bubble / sidebar-groups / req-review）。
- [ ] **Step 4**: 输出用户走查清单：pm2 restart claude-web；P1-P4 真机项（见各任务末条）；
  提醒「不 git 提交，改动留工作区」。

---

## Self-Review 记录

- **Spec 覆盖**：§3→Task1；§5.1 claude.js/settings→Task2/7；§5.2 路由→Task6/9/11/13；§5.3 docgen/串行闸/恢复→Task3/4；
  finalize→Task5；§5.4→Task11；§5.5→Task13；§6 前端→Task8/10/12/13；§8 测试→各任务内嵌+Task14。无缺口。
- **占位符**：req-logic 若干函数以「行为契约注释」给出而非全量代码——契约含输入/输出/边界，测试用例即规格，执行者按测试实现（TDD 本意）；无 TBD。
- **类型一致性**：`enqueueSystemTask(reqId, kind, payload)`、`canDispatch(req, hasActive)`、`finalizeGuard(req)`、
  bug 状态集 `pending|fixing|fixed|ignored|failed` 与 store/前端一致；`addDirs` 命名贯穿 startClaudeRun→provider。
- **执行注意**：Task 4 Step 4 与 Task 8 Step 4 要求执行者先读目标函数真实形态再落钩子（settleRun 判据、
  buildMergedHistory entry 字段）——这是有意的「锚点核实」步骤，防照抄漂移。

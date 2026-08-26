# 体检扩展为「项目代码健壮性」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **本项目规则：不自动 git 提交。** 每个 Task 末尾是「验收」而非 commit，改动留工作区。

**Goal:** 体检从「AI 协作配置健康度」扩展为「项目代码健壮性」：新增 `tests` / `hygiene` 两个维度、重分配权重，并修掉扫描范围把构建产物当源码的缺陷。

**Architecture:** 扫描范围改用 `git ls-files` 追踪清单（项目自己的 `.gitignore` 即权威来源），仅作用于读取内容做分析的 `comments`/`prompts`。两个新维度沿用项目既有的 `check-X.js`（fs 层薄）+ `check-X.logic.js`（纯函数可测）分层。

**Tech Stack:** Node.js ESM、`node --test`、`execFile` 跑 git/npm（范式见 `project-optimize/git-guard.js`）。

**Spec:** `docs/superpowers/specs/2026-08-26-checkup-code-robustness-design.md`

---

## 已验证的环境事实（写代码前不必再查）

| 事实 | 证据 |
|---|---|
| `git ls-files` 输出**相对 cwd**，不是相对仓库根 | 实测 `cd src && git ls-files` → `app/dispatch.js`；仓库根 → `.env.example`。与 `collectSourceFiles` 的 `rel` 基准一致，可直接 `Set.has(rel)` |
| 前端维度列表硬编码在 `optimize-view.logic.js:5` 的 `DIM_META` | `dimListFrom` 基于它 map，不遍历 `report.dims`。不加就不显示 |
| `busy` 闸已有陈旧接管 | `store/optimize.js:91` `isStale()`，`BUSY_STALE_MS = 1 小时` |
| `acquireBusy` 早于目录校验 | `startCheckup:106` 先占闸，`runStaticCheckup:26` 才校验 → 非法路径留垃圾条目 |
| Tauri 构建产物已被 gitignore | `src-tauri/target/...` 与 `src-tauri/resources/sidecar/...` 均 `git check-ignore` 命中 |

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/store/review-log.js` | 修改 | 收敛到 `jsonl.js`，顺带获得加锁 |
| `src/store/review-log.test.js` | 创建 | 读写往返 + 超限压缩 |
| `src/features/project-checkup/git-tracked.js` | 创建 | `gitTrackedFiles(dir)` → `Set|null` |
| `src/features/project-checkup/git-tracked.fs.test.js` | 创建 | 真实仓库 / 非仓库降级 |
| `src/features/project-checkup/check-comments.js` | 修改 | 收集时按追踪清单过滤 |
| `src/features/project-checkup/check-prompts.js` | 修改 | 同上 |
| `src/entrypoints/web/optimize-ops.js` | 修改 | 目录校验前移到占闸之前 |
| `src/features/project-checkup/check-tests.logic.js` | 创建 | 配对判定 + 评分（纯函数） |
| `src/features/project-checkup/check-tests.logic.test.js` | 创建 | |
| `src/features/project-checkup/check-tests.js` | 创建 | 执行测试 + 扫大文件（fs 层） |
| `src/features/project-checkup/check-tests.fs.test.js` | 创建 | 三重防护 |
| `src/features/project-checkup/check-hygiene.logic.js` | 创建 | 卫生判定（纯函数） |
| `src/features/project-checkup/check-hygiene.logic.test.js` | 创建 | |
| `src/features/project-checkup/check-hygiene.js` | 创建 | 取追踪清单（fs 层，极薄） |
| `src/features/project-checkup/score.logic.js` | 修改 | 权重重分配 |
| `src/features/project-checkup/score.logic.test.js` | 修改 | 6 维度加权 |
| `src/features/project-checkup/index.js` | 修改 | 接入两个新维度 |
| `public/js/optimize-view.logic.js` | 修改 | `DIM_META` 两处 |

---

## Task 1: `review-log.js` 收敛到 `jsonl.js`（独立 bug 修）

`compact()` 现在是「读全量 → rename 覆盖」且**无锁**，跨进程会吞掉对方追加的行。收敛后自动获得 `compactJsonl` 的加锁保护。

**Files:**
- Modify: `src/store/review-log.js`
- Test: `src/store/review-log.test.js`

- [ ] **Step 1: 写测试（针对现有实现，应直接通过 = 基线）**

创建 `src/store/review-log.test.js`：

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// APP_DATA_DIR 必须先于 store 模块引入设定（DATA_DIR 全进程只求值一次，详见 jsonl.test.js）
const TMP = path.join(os.tmpdir(), `cad-reviewlog-test-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.APP_DATA_DIR = TMP;

const { appendReviewVerdict, recentOverrides } = await import('./review-log.js');
const FILE = path.join(TMP, 'review-log.jsonl');

after(() => {
  delete process.env.APP_DATA_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('appendReviewVerdict 落盘 + at 自动补齐', () => {
  fs.rmSync(FILE, { recursive: true, force: true });
  appendReviewVerdict({ taskId: 't1', type: 'bug', title: 'X', verdict: 'approve' });

  const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.taskId, 't1');
  assert.ok(rec.at, 'at 应由 store 补齐');
});

test('recentOverrides 只取 override 判例，按旧→新返回末 N 条', () => {
  fs.rmSync(FILE, { recursive: true, force: true });
  appendReviewVerdict({ taskId: 'a', verdict: 'reject' });               // 非 override
  appendReviewVerdict({ taskId: 'b', verdict: 'reject', override: true });
  appendReviewVerdict({ taskId: 'c', verdict: 'reject', override: true });

  const got = recentOverrides(2).map((e) => e.taskId);
  assert.deepStrictEqual(got, ['b', 'c'], '过滤 override 且保持旧→新');
  assert.deepStrictEqual(recentOverrides(1).map((e) => e.taskId), ['c'], '只要最新一条');
});

test('坏行（进程被杀留下的半截 JSON）跳过', () => {
  fs.writeFileSync(FILE, '{"taskId":"ok","override":true}\n{"taskId":"bad"\n');
  assert.deepStrictEqual(recentOverrides(5).map((e) => e.taskId), ['ok']);
});

test('写失败不抛（目标文件名被目录占住）', () => {
  fs.rmSync(FILE, { recursive: true, force: true });
  fs.mkdirSync(FILE);
  try {
    appendReviewVerdict({ taskId: 'x' }); // 不抛即通过
  } finally {
    fs.rmSync(FILE, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认通过（基线，未改实现）**

Run: `node --test src/store/review-log.test.js`
Expected: PASS，4 个 test

- [ ] **Step 3: 改写 `src/store/review-log.js`**

```js
/**
 * 评审判例库 —— review-log.jsonl（追加写，最新在后）。
 * 记录每次评审判决与人工覆盖（override）；覆盖判例注入后续评审 prompt 做 few-shot 校准，
 * 让「AI 倾向修改」的偏置随人工纠偏逐步收敛。
 *
 * 读取与压缩下沉到 store/jsonl.js。收敛的动因不只是去重：原来的 compact 是
 * 「读全量 → rename 覆盖」却**没加锁**，而 web / feishu 是两个进程，
 * 压缩窗口内对方追加的行会被整段吞掉（event-log.js 的注释警告过同一场景）。
 */
import fs from 'node:fs';
import { dataPath } from './index.js';
import { readJsonl, compactJsonl } from './jsonl.js';

const FILE = 'review-log.jsonl';
const MAX = 500;
const COMPACT_EVERY = 200;

let _appends = 0;

/** 追加一条判例：{ taskId, type, title, scores?, verdict, override? } */
export function appendReviewVerdict(entry) {
  try {
    fs.appendFileSync(dataPath(FILE), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* 判例写失败不影响主流程 */
  }
  if (++_appends >= COMPACT_EVERY) {
    _appends = 0;
    compact();
  }
}

/** 最近 N 条人工覆盖判例（旧→新），供评审 prompt few-shot 注入 */
export function recentOverrides(limit = 5) {
  return readJsonl(FILE).filter((e) => e && e.override).slice(-limit);
}

function compact() {
  compactJsonl(FILE, { max: MAX });
}
```

注意：本文件的时间字段是 `at` 而非 `time`。`compactJsonl` 不传 `retainMs` 时不读取任何时间字段，因此字段名差异无影响。

- [ ] **Step 4: 跑测试 + store 全量回归**

Run: `node --test "src/store/*.test.js"`
Expected: PASS（含 review-log 4 个新测试）

- [ ] **Step 5: 验收**

Run: `rg -n "renameSync|readFileSync" src/store/review-log.js`
Expected: 无输出（只剩 `appendFileSync`，读取与压缩都已下沉）

---

## Task 2: `gitTrackedFiles` 模块

**Files:**
- Create: `src/features/project-checkup/git-tracked.js`
- Test: `src/features/project-checkup/git-tracked.fs.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/features/project-checkup/git-tracked.fs.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gitTrackedFiles } from './git-tracked.js';

function tmpDir(t, name) {
  const dir = path.join(os.tmpdir(), `cad-gittracked-${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (dir, args) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' });

test('真实仓库：只返回被追踪的文件，gitignore 的产物不在其中', async (t) => {
  const dir = tmpDir(t, 'repo');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);

  fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n*.log\n');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a\n');
  fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build', 'a.js'), '// 构建产物副本\n');
  fs.writeFileSync(path.join(dir, 'run.log'), 'x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);

  const tracked = await gitTrackedFiles(dir);
  assert.ok(tracked instanceof Set);
  assert.equal(tracked.has('a.js'), true, '真实源码在清单里');
  assert.equal(tracked.has('build/a.js'), false, '构建产物不在清单里');
  assert.equal(tracked.has('run.log'), false, '日志不在清单里');
  assert.equal(tracked.has('.gitignore'), true);
});

test('路径用正斜杠，且相对传入目录（子目录也成立）', async (t) => {
  const dir = tmpDir(t, 'sub');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
  fs.mkdirSync(path.join(dir, 'src', 'store'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'store', 'x.js'), '// x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);

  const fromRoot = await gitTrackedFiles(dir);
  assert.equal(fromRoot.has('src/store/x.js'), true, '相对仓库根');

  const fromSub = await gitTrackedFiles(path.join(dir, 'src'));
  assert.equal(fromSub.has('store/x.js'), true, '相对传入的子目录，不带 src/ 前缀');
});

test('非 git 目录 → null（调用方据此降级为目录遍历）', async (t) => {
  const dir = tmpDir(t, 'plain');
  fs.writeFileSync(path.join(dir, 'a.js'), '// a\n');
  assert.equal(await gitTrackedFiles(dir), null);
});

test('目录不存在 → null，不抛', async () => {
  assert.equal(await gitTrackedFiles(path.join(os.tmpdir(), 'cad-no-such-dir-xyz')), null);
});

test('仓库存在但零追踪文件 → null（降级而不是「什么都别扫」）', async (t) => {
  const dir = tmpDir(t, 'bare');
  git(dir, ['init', '-q']);
  // 只有未追踪文件
  fs.writeFileSync(path.join(dir, 'a.js'), '// a\n');
  assert.equal(await gitTrackedFiles(dir), null, '空清单必须当 null，否则会把整个项目排除掉');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/features/project-checkup/git-tracked.fs.test.js`
Expected: FAIL —— `Cannot find module ... git-tracked.js`

- [ ] **Step 3: 实现**

```js
/**
 * git 追踪清单 —— 「什么是真实源码」的权威来源。
 *
 * 动机（实测）：comments 维度把 .gitignore 的构建产物当源码扫了，
 * `src/shared/app-paths.js:37` 的同一处注释被报了 3 次（真实源码 1 份 +
 * src-tauri/target 与 src-tauri/resources/sidecar 各 1 份副本）。后果是用户看到重复问题、
 * 评分公式两端被副本抬高失真，且**每份副本都单独烧了一次 LLM 额度**。
 *
 * 用项目自己的 .gitignore 判定比手工维护 SKIP_DIR 列表准确且零维护——它能一次性覆盖
 * target/、打包副本以及未来任何构建输出。SKIP_DIR 仍然保留：fixtures 是被 git 追踪的
 * 真实文件，只有它挡得住。两者叠加，不是替代。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * @param {string} projectDir
 * @returns {Promise<Set<string>|null>} 相对 projectDir 的正斜杠路径集合；
 *   非 git 仓库 / git 不可用 / 零追踪文件一律返回 null，调用方据此降级为目录遍历。
 *
 * 用 -z（NUL 分隔）而不是按行切：路径里有空格或非 ASCII 时，git 默认会加引号并转义，
 * 按行切会拿到带引号的坏路径，匹配全部失配。
 */
export async function gitTrackedFiles(projectDir) {
  try {
    const { stdout } = await exec('git', ['ls-files', '-z'], {
      cwd: projectDir,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    const set = new Set();
    for (const p of stdout.split('\0')) {
      if (p) set.add(p); // git 输出已是正斜杠，且相对 cwd（实测）
    }
    // 空清单当 null：真返回空 Set 会让调用方把整个项目都过滤掉，
    // 表现为「体检什么都没扫到」的静默失败。宁可降级为目录遍历。
    return set.size ? set : null;
  } catch {
    // git 不存在、目录不存在、不是仓库，都走这里
    return null;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test src/features/project-checkup/git-tracked.fs.test.js`
Expected: PASS，5 个 test

- [ ] **Step 5: 验收**

改动留工作区。

---

## Task 3: 把追踪清单接入 `comments` 与 `prompts`

**只改这两个维度。** 不动 `check-map.js`：它的 `buildPathIndex` 语义是「地图引用的路径在仓库里存不存在」，被 gitignore 的目录**确实存在于磁盘上**，改用追踪清单会把这类引用误判成死链——那是退化不是修复。

**Files:**
- Modify: `src/features/project-checkup/check-comments.js:154`、`:454`
- Modify: `src/features/project-checkup/check-prompts.js`（`collectPromptFiles` 与其调用处）

- [ ] **Step 1: 改 `check-comments.js` 的收集函数签名**

`collectSourceFiles(projectDir)` → 增加第二参：

```js
function collectSourceFiles(projectDir, tracked) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (shouldSkipDir(e.name)) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      // tracked 为 null = 非 git 仓库，退回「全都算」的旧行为
      if (tracked && !tracked.has(r)) continue;
      try {
        const st = fs.statSync(full);
        out.push({ full, rel: r, mtime: st.mtimeMs, size: st.size });
      } catch { /* 竞态删除等，跳过 */ }
    }
  };
  walk(projectDir, '');
  return out;
}
```

- [ ] **Step 2: 在 `checkComments` 里取清单并传入**

把 `check-comments.js:454` 的 `const all = collectSourceFiles(projectDir);` 改为：

```js
  // 只看 git 追踪的文件：构建产物副本会让同一处注释被重复报告并重复烧额度（详见 git-tracked.js）
  const tracked = await gitTrackedFiles(projectDir);
  const all = collectSourceFiles(projectDir, tracked);
```

并在顶部 import 区加：

```js
import { gitTrackedFiles } from './git-tracked.js';
```

- [ ] **Step 3: 同样改 `check-prompts.js`**

`collectPromptFiles(projectDir)` → `collectPromptFiles(projectDir, tracked)`，在 walk 的文件分支加同一条过滤：

```js
      if (e.name === 'CLAUDE.md' || e.name === 'CLAUDE.local.md') {
        if (tracked && !tracked.has(r)) continue;
        add(full, r);
      }
```

`.claude/rules/*.md` 那段也要过滤（它不走 walk，单独拼路径）。找到 `const rulesDir = path.join(projectDir, '.claude', 'rules');` 之后的收集循环，在 `add(...)` 前插入同样的 `tracked` 判定，rel 用 `.claude/rules/<name>` 形式。

`checkPrompts` 开头改为：

```js
export async function checkPrompts(projectDir, { cache = null, force = false } = {}) {
  const tracked = await gitTrackedFiles(projectDir);
  const files = collectPromptFiles(projectDir, tracked);
```

并加 import：`import { gitTrackedFiles } from './git-tracked.js';`

- [ ] **Step 4: 跑 project-checkup 全量回归**

Run: `node --test "src/features/project-checkup/*.test.js"`
Expected: PASS。基线是本次改动前的 **163 + 5（git-tracked）= 168**。

- [ ] **Step 5: 端到端验证副本已消失**

起服务后对本项目跑体检（`node docs/../scratchpad/run-checkup.mjs` 或直接 curl POST `/api/optimize/checkup` 带 `{"dir":"C:/Users/DELL/Desktop/claude-p-web-demo","force":true}`），等 `comments` 维度回填后检查：

```bash
node -e "const j=require('./optimize.json');const p=j.projects['C:/Users/DELL/Desktop/claude-p-web-demo'];const is=p.llmCache.comments.result.issues||[];console.log('issues:',is.length);console.log('含构建产物路径:',is.filter(i=>/src-tauri\/(target|resources)/.test(i.file)).length)"
```

Expected: 「含构建产物路径」为 **0**（改动前是 2）。

- [ ] **Step 6: 验收**

`llmCache` 的 fingerprint 会因文件集合变化而失效并触发重算，属预期。

---

## Task 4: D2 —— 目录校验前移，不再留垃圾条目

**Files:**
- Modify: `src/entrypoints/web/optimize-ops.js:105-117`（`startCheckup`）

- [ ] **Step 1: 在占闸之前校验目录**

`startCheckup` 改为：

```js
export async function startCheckup(dir, { force = false } = {}) {
  // 目录合法性必须先于 acquireBusy：占闸会写 optimize.json，而非法路径最终只会返回 400，
  // 垃圾条目却已经落盘。实测残留过一条 key 为 'C:UsersDELLDesktop…'（反斜杠被吞）的项目条目。
  assertValidProjectDir(dir);

  const gate = acquireBusy(dir, 'checkup');
  if (!gate.ok) return { busy: gate.busy };
  try {
    const out = await runCheckup(dir, { force, ownsBusy: true });
    // 没有 checkupId = 没起后台 job，没人会替我们释放
    if (!out.checkupId) releaseBusy(dir);
    return out;
  } catch (e) {
    releaseBusy(dir);
    throw e;
  }
}
```

在 `optimize-ops.js` 里新增该校验函数（放在 `startCheckup` 之前）：

```js
/** 目录必须存在且是目录。错误文案与 runStaticCheckup 保持一致，前端已按它显示 */
function assertValidProjectDir(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('目录不存在或不可读');
  }
}
```

`fs` 已在该文件顶部 import（第 11 行），无需新增。

- [ ] **Step 2: 验证非法路径不再落盘**

```bash
node -e "
const fs=require('fs');
const before=JSON.stringify(Object.keys(JSON.parse(fs.readFileSync('optimize.json','utf8')).projects||{}));
fetch('http://127.0.0.1:3000/api/optimize/checkup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir:'C:NoSuchGarbagePath'})})
 .then(r=>r.json()).then(r=>{
   const after=JSON.stringify(Object.keys(JSON.parse(fs.readFileSync('optimize.json','utf8')).projects||{}));
   console.log('响应:',r.error);
   console.log('projects keys 是否新增:', before!==after ? '❌ 仍在落盘' : '✅ 未落盘');
 });
"
```

Expected: 响应 `目录不存在或不可读`，且 keys 未新增。

- [ ] **Step 3: 清理已有的畸形条目**

```bash
node -e "
const fs=require('fs');
const j=JSON.parse(fs.readFileSync('optimize.json','utf8'));
const bad=Object.keys(j.projects||{}).filter(k=>!fs.existsSync(k));
console.log('待清理的无效项目条目:',bad);
for(const k of bad) delete j.projects[k];
fs.writeFileSync('optimize.json', JSON.stringify(j,null,2));
console.log('已清理',bad.length,'条');
"
```

Expected: 清理掉 `C:UsersDELLDesktopclaude-p-web-demo` 这条。

- [ ] **Step 4（可选，优先级最低）: 把 `BUSY_STALE_MS` 从 1 小时降到 15 分钟**

`src/store/optimize.js:23`：

```js
// 15 分钟：LLM 维度实测最慢在分钟级，1 小时会让异常终止后的用户白等太久。
// 注意这是「陈旧接管」阈值，不是超时——正常跑完会主动 releaseBusy。
export const BUSY_STALE_MS = 15 * 60 * 1000;
```

这不是修 bug（`isStale` 早已存在且生效），纯调参。若担心长跑的 LLM 维度被误接管，跳过本步。

- [ ] **Step 5: 验收**

Run: `node --test "src/store/*.test.js"`
Expected: PASS（若第 4 步改了阈值，确认没有测试硬编码 1 小时）

---

## Task 5: `tests` 维度 —— 纯函数层

**Files:**
- Create: `src/features/project-checkup/check-tests.logic.js`
- Test: `src/features/project-checkup/check-tests.logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LARGE_FILE_LINES, testPathsFor, findLargeFilesWithoutTest, evaluateTests,
} from './check-tests.logic.js';

test('配对规则：x.js 的测试是 x.test.js 或 x.logic.test.js', () => {
  assert.deepStrictEqual(
    testPathsFor('src/store/runs.js'),
    ['src/store/runs.test.js', 'src/store/runs.logic.test.js'],
  );
});

test('只报超过阈值且无配对测试的文件', () => {
  const files = [
    { rel: 'a/big.js', lines: 900 },      // 超阈值，无测试 → 报
    { rel: 'a/tested.js', lines: 900 },   // 超阈值，有测试 → 不报
    { rel: 'a/logic.js', lines: 900 },    // 超阈值，有 .logic.test.js → 不报
    { rel: 'a/small.js', lines: 100 },    // 未超阈值 → 不报
  ];
  const all = new Set(['a/tested.test.js', 'a/logic.logic.test.js']);
  assert.deepStrictEqual(findLargeFilesWithoutTest(files, all), [{ file: 'a/big.js', lines: 900 }]);
});

test('阈值边界：恰好等于阈值不报，超过才报', () => {
  const all = new Set();
  assert.equal(findLargeFilesWithoutTest([{ rel: 'x.js', lines: LARGE_FILE_LINES }], all).length, 0);
  assert.equal(findLargeFilesWithoutTest([{ rel: 'x.js', lines: LARGE_FILE_LINES + 1 }], all).length, 1);
});

test('测试红了 → error 级 issue，重扣分', () => {
  const r = evaluateTests({
    testRun: { status: 'fail', reason: '测试未通过（退出码 1）' },
    largeFilesWithoutTest: [], testFileCount: 10, sourceFileCount: 20,
  });
  assert.equal(r.status, 'done');
  assert.equal(r.issues[0].code, 'S1_TESTS_FAILING');
  assert.equal(r.issues[0].severity, 'error');
  assert.ok(r.score <= 60, `测试红了分数应显著下降，实际 ${r.score}`);
});

test('超时 → 整个维度 partial，不计入总分，且绝不判成「测试失败」', () => {
  const r = evaluateTests({
    testRun: { status: 'timeout', reason: '测试执行超过 120s' },
    largeFilesWithoutTest: [], testFileCount: 10, sourceFileCount: 20,
  });
  assert.equal(r.status, 'partial', '超时是「无法判断」，不是「测试红了」');
  assert.equal(r.score, null);
  assert.equal(r.issues.filter((i) => i.code === 'S1_TESTS_FAILING').length, 0);
});

test('占位 test 脚本 → 不因此扣分（npm init 的默认脚本就是 exit 1）', () => {
  const r = evaluateTests({
    testRun: { status: 'na', reason: 'test 脚本是 npm init 的占位脚本' },
    largeFilesWithoutTest: [], testFileCount: 5, sourceFileCount: 10,
  });
  assert.equal(r.status, 'done');
  assert.equal(r.score, 100, '无法执行测试不等于测试失败');
  assert.equal(r.issues.length, 0);
});

test('项目完全没有测试文件 → warn', () => {
  const r = evaluateTests({
    testRun: { status: 'na', reason: 'package.json 未定义 test 脚本' },
    largeFilesWithoutTest: [], testFileCount: 0, sourceFileCount: 12,
  });
  assert.equal(r.issues[0].code, 'S3_NO_TESTS');
  assert.equal(r.issues[0].severity, 'warn');
  assert.ok(r.score < 100);
});

test('没有测试文件时不再重复报「大文件无测试」（否则同一件事报两遍）', () => {
  const r = evaluateTests({
    testRun: { status: 'na' },
    largeFilesWithoutTest: [{ file: 'a.js', lines: 900 }, { file: 'b.js', lines: 800 }],
    testFileCount: 0, sourceFileCount: 12,
  });
  assert.equal(r.issues.length, 1, '只报 S3');
  assert.equal(r.issues[0].code, 'S3_NO_TESTS');
});

test('大文件无测试 → 每个一条 info，分数按条数递减但有下限', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ file: `f${i}.js`, lines: 900 }));
  const r = evaluateTests({
    testRun: { status: 'pass' }, largeFilesWithoutTest: many,
    testFileCount: 5, sourceFileCount: 40,
  });
  assert.equal(r.issues.every((i) => i.code === 'S2_LARGE_FILE_UNTESTED'), true);
  assert.ok(r.score >= 0, '分数不能为负');
  assert.ok(r.score < 100);
});

test('全绿且无大文件缺口 → 100 done', () => {
  const r = evaluateTests({
    testRun: { status: 'pass' }, largeFilesWithoutTest: [],
    testFileCount: 10, sourceFileCount: 20,
  });
  assert.equal(r.score, 100);
  assert.equal(r.status, 'done');
  assert.deepStrictEqual(r.issues, []);
});

test('没有任何源文件 → na（空仓库不该扣分也不该计入）', () => {
  const r = evaluateTests({ testRun: { status: 'na' }, largeFilesWithoutTest: [], testFileCount: 0, sourceFileCount: 0 });
  assert.equal(r.status, 'na');
  assert.equal(r.score, null);
});

test('容错：不传参不抛', () => {
  assert.doesNotThrow(() => evaluateTests());
  assert.doesNotThrow(() => evaluateTests({}));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/features/project-checkup/check-tests.logic.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```js
/**
 * 维度「测试健康度」的判定层（纯函数，不碰 fs / 不起进程）。
 *
 * 三个检查项：
 *   S1 测试未全绿（error）—— 唯一需要执行项目代码的检查，执行细节在 check-tests.js
 *   S2 超阈值源文件无配对测试（info）
 *   S3 项目完全没有测试文件（warn）
 */

/** 超过这个行数的源文件才要求有配对测试。取 500 而非 300：300 会一次报出 20 个文件、
 *  且大概率一个都不会改——报了不修的条目就是噪音。 */
export const LARGE_FILE_LINES = 500;

const DEDUCT_TESTS_FAILING = 45; // 测试红了是最严重的健壮性信号
const DEDUCT_NO_TESTS = 30;
const DEDUCT_LARGE_UNTESTED = 5;
const MAX_LARGE_DEDUCT = 30; // 大文件缺口的扣分上限，避免 20 个文件把分数打到 0

/** 项目既有约定：x.js 的测试是 x.test.js 或 x.logic.test.js */
export function testPathsFor(rel) {
  const base = String(rel).replace(/\.js$/, '');
  return [`${base}.test.js`, `${base}.logic.test.js`];
}

/**
 * @param {Array<{rel:string, lines:number}>} files 候选源文件（已排除测试文件本身）
 * @param {Set<string>} allRelSet 项目内所有文件的相对路径集合，用来查配对测试是否存在
 */
export function findLargeFilesWithoutTest(files, allRelSet, { minLines = LARGE_FILE_LINES } = {}) {
  const all = allRelSet instanceof Set ? allRelSet : new Set();
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && Number(f.lines) > minLines)
    .filter((f) => !testPathsFor(f.rel).some((p) => all.has(p)))
    .map((f) => ({ file: f.rel, lines: Number(f.lines) }));
}

/**
 * @param {object} p
 * @param {{status:'pass'|'fail'|'timeout'|'na', reason?:string}} p.testRun 执行结果
 * @param {Array<{file:string, lines:number}>} p.largeFilesWithoutTest
 * @param {number} p.testFileCount 项目里 *.test.js 的数量
 * @param {number} p.sourceFileCount 非测试源文件数量
 */
export function evaluateTests({
  testRun = { status: 'na' },
  largeFilesWithoutTest = [],
  testFileCount = 0,
  sourceFileCount = 0,
} = {}) {
  // 空仓库/没有源码：不是缺陷，不扣分也不计入总分
  if (!sourceFileCount) {
    return { score: null, status: 'na', issues: [], reason: '项目里没有可分析的源文件' };
  }

  // 超时必须判 partial 而不是「测试失败」。混为一谈会让所有大项目永久不及格——
  // 超时的语义是「这次没测出来」，不是「测试红了」。
  if (testRun?.status === 'timeout') {
    return {
      score: null,
      status: 'partial',
      issues: [],
      reason: testRun.reason || '测试执行超时，本维度不计入总分',
    };
  }

  const issues = [];
  let score = 100;

  if (testRun?.status === 'fail') {
    score -= DEDUCT_TESTS_FAILING;
    issues.push({
      code: 'S1_TESTS_FAILING',
      severity: 'error',
      file: 'package.json',
      line: 1,
      message: testRun.reason || '项目测试未通过',
      fixable: false,
      fixHint: '本地跑一遍测试命令，修掉失败用例后再体检',
    });
  }

  if (testFileCount === 0) {
    // 一个测试文件都没有时，再逐个报「大文件无测试」是把同一件事说 N 遍
    score -= DEDUCT_NO_TESTS;
    issues.push({
      code: 'S3_NO_TESTS',
      severity: 'warn',
      file: '.',
      line: 1,
      message: `项目里没有任何测试文件（扫到 ${sourceFileCount} 个源文件）`,
      fixable: false,
      fixHint: '从改动最频繁的模块开始补测试',
    });
  } else {
    const list = Array.isArray(largeFilesWithoutTest) ? largeFilesWithoutTest : [];
    score -= Math.min(list.length * DEDUCT_LARGE_UNTESTED, MAX_LARGE_DEDUCT);
    for (const f of list) {
      issues.push({
        code: 'S2_LARGE_FILE_UNTESTED',
        severity: 'info',
        file: f.file,
        line: 1,
        message: `${f.lines} 行的源文件没有配对测试，改动风险高`,
        fixable: false,
        fixHint: `新建 ${String(f.file).replace(/\.js$/, '')}.test.js；文件过大时可先把纯逻辑拆到 .logic.js 再测`,
        meta: { lines: f.lines },
      });
    }
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    status: 'done',
    issues,
    reason: testRun?.status === 'na' ? testRun.reason || '未执行测试命令' : '',
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test src/features/project-checkup/check-tests.logic.test.js`
Expected: PASS，12 个 test

- [ ] **Step 5: 验收**

改动留工作区。

---

## Task 6: `tests` 维度 —— fs / 执行层

**Files:**
- Create: `src/features/project-checkup/check-tests.js`
- Test: `src/features/project-checkup/check-tests.fs.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runProjectTests } from './check-tests.js';

function tmpProject(t, name, pkg) {
  const dir = path.join(os.tmpdir(), `cad-checktests-${name}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('没有 package.json → na，不执行任何命令', async (t) => {
  const dir = tmpProject(t, 'nopkg', null);
  const r = await runProjectTests(dir);
  assert.equal(r.status, 'na');
  assert.match(r.reason, /package\.json/);
});

test('未定义 test 脚本 → na', async (t) => {
  const dir = tmpProject(t, 'noscript', { name: 'x', scripts: { build: 'echo 1' } });
  const r = await runProjectTests(dir);
  assert.equal(r.status, 'na');
});

test('npm init 的占位脚本 → na（不能报成测试失败）', async (t) => {
  // 这是最容易踩的误报：npm init 默认生成 `exit 1`，不识别的话每个没写测试的项目
  // 都会被报成 error 级「测试失败」
  const dir = tmpProject(t, 'placeholder', {
    name: 'x',
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
  });
  const r = await runProjectTests(dir);
  assert.equal(r.status, 'na', '占位脚本必须识别为 na');
  assert.match(r.reason, /占位/);
});

test('测试通过 → pass', async (t) => {
  const dir = tmpProject(t, 'pass', { name: 'x', scripts: { test: 'node -e "process.exit(0)"' } });
  const r = await runProjectTests(dir);
  assert.equal(r.status, 'pass');
});

test('测试失败 → fail，带退出码', async (t) => {
  const dir = tmpProject(t, 'fail', { name: 'x', scripts: { test: 'node -e "process.exit(3)"' } });
  const r = await runProjectTests(dir);
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /3|未通过/);
});

test('超时 → timeout（不是 fail）', async (t) => {
  const dir = tmpProject(t, 'timeout', {
    name: 'x',
    scripts: { test: 'node -e "setTimeout(()=>{},60000)"' },
  });
  const r = await runProjectTests(dir, { timeoutMs: 1500 });
  assert.equal(r.status, 'timeout', '超时不能判成测试失败');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/features/project-checkup/check-tests.fs.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `check-tests.js`**

```js
/**
 * 维度「测试健康度」的 fs / 执行层。
 *
 * 这是体检里**唯一会执行目标项目代码**的检查项（用户明确选择默认开启）。三重防护：
 *   1. 超时判 partial 而不是「失败」——超时是「没测出来」，不是「测试红了」
 *   2. 识别 npm init 的占位 test 脚本（`exit 1`），否则每个没写测试的项目都会被报成测试失败
 *   3. 只读退出码，不解析输出（各框架输出格式不通用），maxBuffer 设上限防输出爆内存
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shouldSkipDir } from './scan-dirs.logic.js';
import { gitTrackedFiles } from './git-tracked.js';
import { findLargeFilesWithoutTest, evaluateTests } from './check-tests.logic.js';

const exec = promisify(execFile);

const TEST_TIMEOUT_MS = 120_000;
const CODE_EXT = /\.(m?js|cjs)$/i;
const TEST_FILE = /\.test\.m?js$/i;

/** Windows 上 npm 是 npm.cmd —— execFile 不走 shell，传 'npm' 会 ENOENT */
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * 执行项目测试命令。
 * @returns {Promise<{status:'pass'|'fail'|'timeout'|'na', reason?:string}>}
 */
export async function runProjectTests(projectDir, { timeoutMs = TEST_TIMEOUT_MS } = {}) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  } catch {
    return { status: 'na', reason: '没有 package.json 或无法解析，未执行测试' };
  }
  const script = pkg?.scripts?.test;
  if (!script) return { status: 'na', reason: 'package.json 未定义 test 脚本' };
  if (/no test specified/i.test(script)) {
    return { status: 'na', reason: 'test 脚本是 npm init 生成的占位脚本，未执行' };
  }

  try {
    await exec(NPM_BIN, ['test', '--silent'], {
      cwd: projectDir,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { status: 'pass' };
  } catch (e) {
    // execFile 超时会 kill 子进程并置 killed=true（Node 也可能给 ETIMEDOUT）
    if (e?.killed || e?.code === 'ETIMEDOUT' || e?.signal) {
      return { status: 'timeout', reason: `测试执行超过 ${Math.round(timeoutMs / 1000)}s，本维度不计入总分` };
    }
    if (typeof e?.code === 'number') {
      return { status: 'fail', reason: `测试未通过（退出码 ${e.code}）` };
    }
    // npm 本身不存在等：当成无法判断，不是测试失败
    return { status: 'na', reason: `无法执行测试命令：${e?.message || String(e)}` };
  }
}

/** 收集源文件（行数）与全部相对路径集合。只看 git 追踪的文件，非 git 仓库降级为全扫。 */
function collectFiles(projectDir, tracked) {
  const sources = [];
  const allRel = new Set();
  let testFileCount = 0;

  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (shouldSkipDir(e.name)) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      if (tracked && !tracked.has(r)) continue;
      allRel.add(r);
      if (!CODE_EXT.test(e.name)) continue;
      if (TEST_FILE.test(e.name)) { testFileCount += 1; continue; }
      try {
        const lines = fs.readFileSync(full, 'utf8').split('\n').length;
        sources.push({ rel: r, lines });
      } catch { /* 读不到就跳过 */ }
    }
  };
  walk(projectDir, '');
  return { sources, allRel, testFileCount };
}

/**
 * 第二参 `_opts` 只为与 RUNNERS 里其他 runner 的签名对齐（编排层统一按 (dir, {cache,force}) 调用）。
 * 返回值补 cacheEntry/fingerprint/cached：本维度不做指纹缓存（每次都要重跑测试），
 * 给 null 即可——`store/optimize.js:70` 的 saveLlmCache 开头就是 `if (!entry) return`，
 * 传 null 不会写脏 llmCache。
 */
export async function checkTests(projectDir, _opts) {
  const tracked = await gitTrackedFiles(projectDir);
  const { sources, allRel, testFileCount } = collectFiles(projectDir, tracked);
  const testRun = await runProjectTests(projectDir);
  const largeFilesWithoutTest = findLargeFilesWithoutTest(sources, allRel);

  return {
    ...evaluateTests({
      testRun,
      largeFilesWithoutTest,
      testFileCount,
      sourceFileCount: sources.length,
    }),
    cacheEntry: null,
    fingerprint: null,
    cached: false,
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test src/features/project-checkup/check-tests.fs.test.js`
Expected: PASS，6 个 test。超时那条约需 1.5s。

- [ ] **Step 5: 验收**

改动留工作区。

---

## Task 7: 权重重分配 + 接入 `tests`

**Files:**
- Modify: `src/features/project-checkup/score.logic.js:9-14`
- Modify: `src/features/project-checkup/score.logic.test.js`
- Modify: `src/features/project-checkup/index.js`

- [ ] **Step 1: 改权重**

```js
export const WEIGHTS = {
  map: 25,
  prompts: 20,
  rules: 10,
  comments: 15,
  tests: 20,
  hygiene: 10,
};
```

并把文件头注释里「维度④（无用代码）v1 不做，不出现在权重表里」改为：

```
 * tests / hygiene 是体检从「AI 协作配置」扩展到「项目代码健壮性」时加入的：
 * 测试是健壮性的核心信号（20），仓库卫生问题明确但影响面小（10）。
```

- [ ] **Step 2: 更新 `score.logic.test.js`**

**现有 10 个用例在新权重下全部仍然绿**（已手算逐条验证，不需要改任何期望值）：

| 用例 | 旧算式 | 新算式 | 结果 |
|---|---|---|---|
| 不同分数按权重加权 | `(60·35+80·30+100·15+90·20)/100 = 78` | `(60·25+80·20+100·10+90·15)/70 = 5450/70 = 77.86` | 都 **78** |
| pending 不计入 | `(80·35+60·15)/50 = 74` | `(80·25+60·10)/35 = 2600/35 = 74.29` | 都 **74** |
| 其余 8 个 | 全 100 分 / 单维度 / null 场景，与权重值无关 | 同 | 不变 |

两个带小数的用例四舍五入后恰好落回原值，属巧合但数学上成立。**先跑一遍确认**：

Run: `node --test src/features/project-checkup/score.logic.test.js`
Expected: PASS。若意外有红，按 `Σ(score×weight)/Σweight` 重算，**不要改断言语义**（「只有 done 参与加权」必须保持）。

`权重合计为 100` 这条会自动校验新权重表：25+20+10+15+20+10 = 100 ✓

再补两个针对新维度的护栏用例：

```js
test('6 个维度全 done 时的加权（权重表变更的护栏）', () => {
  const dims = {
    map: { status: 'done', score: 100 },
    prompts: { status: 'done', score: 100 },
    rules: { status: 'done', score: 100 },
    comments: { status: 'done', score: 100 },
    tests: { status: 'done', score: 0 },
    hygiene: { status: 'done', score: 0 },
  };
  const { total, countedDims } = aggregateScore(dims);
  // (100*25 + 100*20 + 100*10 + 100*15) / 100 = 70
  assert.equal(total, 70);
  assert.equal(countedDims.length, 6);
});

test('新维度为 na 时权重按比例分摊给其余维度', () => {
  const dims = {
    map: { status: 'done', score: 80 },
    prompts: { status: 'na', score: null },
    rules: { status: 'na', score: null },
    comments: { status: 'na', score: null },
    tests: { status: 'done', score: 60 },
    hygiene: { status: 'na', score: null },
  };
  const { total, countedDims } = aggregateScore(dims);
  // (80*25 + 60*20) / 45 = 3200/45 = 71.1 → 71
  assert.equal(total, 71);
  assert.deepStrictEqual(countedDims.sort(), ['map', 'tests']);
});
```

- [ ] **Step 3: 在 `index.js` 接入 `tests`**

`tests` 维度要执行测试命令（异步、可能 120s），**不能放进同步的 `runStaticCheckup`**——否则整个体检 HTTP 请求会阻塞到测试跑完。

按现有 LLM 维度的模式处理：`runStaticCheckup` 里给它占位，由上层异步回填。

改 `src/features/project-checkup/index.js`：

```js
/** 需要异步回填的维度（LLM 分析 + 执行测试），顺序仅用于上层遍历 */
export const LLM_DIM_KEYS = ['prompts', 'comments'];
/** 异步但不走 LLM 的维度：执行项目测试命令，耗时可达 120s，不能挡住同步体检响应 */
export const ASYNC_DIM_KEYS = ['tests'];

export function runStaticCheckup(projectDir, now = Date.now()) {
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error('目录不存在或不可读');
  }

  const dims = {
    map: checkMap(projectDir),
    prompts: { score: null, status: 'pending', issues: [], reason: '未启动 AI 分析' },
    rules: checkRules(projectDir),
    tests: { score: null, status: 'pending', issues: [], reason: '未开始执行测试' },
    hygiene: checkHygiene(projectDir),
    comments: { score: null, status: 'pending', issues: [], reason: '未启动 AI 分析' },
  };

  return recomputeReport({
    dir: projectDir,
    at: new Date(now).toISOString(),
    dims,
  });
}
```

注意 `deadcode` 键**整个删除**（重定义为 `hygiene`，见 Task 8/9），并在顶部 import `checkHygiene`。

- [ ] **Step 4: 在 `optimize-ops.js` 把 `tests` 加入异步回填**

`RUNNERS`（第 29 行）扩展：

```js
import { checkTests } from '../../features/project-checkup/check-tests.js';

const RUNNERS = { prompts: checkPrompts, comments: checkComments, tests: checkTests };
```

并把遍历 `LLM_DIM_KEYS` 的地方改为遍历 `[...LLM_DIM_KEYS, ...ASYNC_DIM_KEYS]`。

签名兼容性**已在 Task 6 处理完**：`checkTests(projectDir, _opts)` 的第二参与 LLM runner 对齐，返回值带 `cacheEntry: null`。

编排层无需任何改动——`optimize-ops.js:198` 的 `saveLlmCache(dir, key, out.r.cacheEntry)` 落到
`store/optimize.js:70` 的 `if (!entry) return`，`null` 直接被忽略，不会写脏 `llmCache`。**已核实，不必再查。**

- [ ] **Step 5: 跑回归**

Run: `node --test "src/features/project-checkup/*.test.js"`
Expected: PASS

- [ ] **Step 6: 验收**

改动留工作区。

---

## Task 8: `hygiene` 维度 —— 纯函数层

**Files:**
- Create: `src/features/project-checkup/check-hygiene.logic.js`
- Test: `src/features/project-checkup/check-hygiene.logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHygiene } from './check-hygiene.logic.js';

test('非 git 仓库 → na（无法判断版本库卫生）', () => {
  const r = evaluateHygiene({ trackedFiles: null });
  assert.equal(r.status, 'na');
  assert.equal(r.score, null);
});

test('运行数据被追踪 → warn', () => {
  const r = evaluateHygiene({ trackedFiles: new Set(['src/a.js', 'event-log.jsonl', 'logs/run.log']) });
  const codes = r.issues.map((i) => i.code);
  assert.equal(codes.filter((c) => c === 'H1_RUNTIME_DATA_TRACKED').length, 2);
  assert.equal(r.issues.find((i) => i.code === 'H1_RUNTIME_DATA_TRACKED').severity, 'warn');
  assert.ok(r.score < 100);
});

test('夹具里的 .jsonl 不报（那是测试数据，本该入库）', () => {
  const r = evaluateHygiene({
    trackedFiles: new Set(['tests/fixtures/sample.jsonl', 'src/__fixtures__/x.log']),
  });
  assert.deepStrictEqual(r.issues, []);
  assert.equal(r.score, 100);
});

test('根目录一次性脚本被追踪 → info', () => {
  const r = evaluateHygiene({
    trackedFiles: new Set(['tmp-probe.mjs', 'temp-x.js', 'debug-y.mjs', 'src/a.js']),
  });
  assert.equal(r.issues.filter((i) => i.code === 'H2_ONESHOT_TRACKED').length, 3);
  assert.equal(r.issues.find((i) => i.code === 'H2_ONESHOT_TRACKED').severity, 'info');
});

test('非根目录的 tmp- 文件不报（收窄到根目录，避免误伤正常命名）', () => {
  const r = evaluateHygiene({ trackedFiles: new Set(['src/utils/tmp-buffer.js']) });
  assert.deepStrictEqual(r.issues, []);
});

test('干净仓库 → 100 done', () => {
  const r = evaluateHygiene({ trackedFiles: new Set(['src/a.js', 'README.md', 'package.json']) });
  assert.equal(r.score, 100);
  assert.equal(r.status, 'done');
  assert.deepStrictEqual(r.issues, []);
});

test('分数有下限，不会为负', () => {
  const many = new Set(Array.from({ length: 40 }, (_, i) => `log-${i}.jsonl`));
  const r = evaluateHygiene({ trackedFiles: many });
  assert.ok(r.score >= 0);
});

test('容错：不传参不抛', () => {
  assert.doesNotThrow(() => evaluateHygiene());
  assert.equal(evaluateHygiene().status, 'na');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test src/features/project-checkup/check-hygiene.logic.test.js`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```js
/**
 * 维度「仓库卫生」的判定层（纯函数）。落地原先恒为 disabled 的 deadcode 槽位。
 *
 * 只做两件**零误报**的判定：
 *   H1 运行数据/日志被 git 追踪（warn）—— 会让工作区永远脏，还可能把用户数据推上远端
 *   H2 项目根目录下的一次性脚本被追踪（info）
 *
 * 刻意不做的：文档时效（不改往往就是不需要改）、重复代码（需相似度比对，假阳性高）、
 * 并发缺锁启发式（判错代价高）。见设计文档 §4。
 */

/** 运行期产物的扩展名。日志/追加流一旦入库就会让工作区永远脏 */
const RUNTIME_EXT = /\.(jsonl|log)$/i;

/** 测试夹具目录：里面的 .jsonl 是测试数据，本该入库 */
const FIXTURE_SEG = /(^|\/)(fixtures|__fixtures__)(\/|$)/;

/**
 * 一次性脚本的命名约定。刻意只认这三个前缀且只在项目根：
 * 它们是临时文件的通用约定，零误报。`verify-*` 这类**不**收——在别的项目里
 * 可能是正经的校验工具，为多抓一两个文件放宽规则不值得。
 */
const ONESHOT_PREFIX = /^(tmp|temp|debug)-/i;

const DEDUCT_RUNTIME = 10;
const DEDUCT_ONESHOT = 5;

/**
 * @param {Set<string>|null} p.trackedFiles git 追踪的相对路径；null = 非 git 仓库
 */
export function evaluateHygiene({ trackedFiles = null } = {}) {
  if (!(trackedFiles instanceof Set)) {
    return { score: null, status: 'na', issues: [], reason: '不是 git 仓库，无法判断版本库卫生' };
  }

  const issues = [];
  let score = 100;

  for (const rel of trackedFiles) {
    if (FIXTURE_SEG.test(rel)) continue;

    if (RUNTIME_EXT.test(rel)) {
      score -= DEDUCT_RUNTIME;
      issues.push({
        code: 'H1_RUNTIME_DATA_TRACKED',
        severity: 'warn',
        file: rel,
        line: 1,
        message: '运行期日志/数据文件被 git 追踪，会让工作区持续变脏，也可能把本地数据推上远端',
        fixable: false,
        fixHint: `把它加入 .gitignore，并用 git rm --cached ${rel} 从索引里移除`,
      });
      continue;
    }

    // 仅项目根：rel 不含 '/'
    if (!rel.includes('/') && ONESHOT_PREFIX.test(rel)) {
      score -= DEDUCT_ONESHOT;
      issues.push({
        code: 'H2_ONESHOT_TRACKED',
        severity: 'info',
        file: rel,
        line: 1,
        message: '临时/调试脚本被 git 追踪，长期留在版本库里会被误当成正式代码',
        fixable: false,
        fixHint: '确认不再需要就删除；仍要用则移到 scripts/ 并起个正式名字',
      });
    }
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    status: 'done',
    issues,
    reason: '',
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test src/features/project-checkup/check-hygiene.logic.test.js`
Expected: PASS，8 个 test

- [ ] **Step 5: 验收**

改动留工作区。

---

## Task 9: `hygiene` 维度 —— fs 层 + 接入

**Files:**
- Create: `src/features/project-checkup/check-hygiene.js`
- Modify: `src/features/project-checkup/index.js`（Task 7 已加 import，此处确认可用）

- [ ] **Step 1: 实现 fs 层（极薄）**

```js
/**
 * 维度「仓库卫生」的 fs 层。刻意保持极薄：所有判断都在 check-hygiene.logic.js。
 *
 * 注意本模块是 async（要跑 git ls-files），而 runStaticCheckup 是同步的 ——
 * 所以 hygiene 走异步回填，和 tests 一样。
 */
import { gitTrackedFiles } from './git-tracked.js';
import { evaluateHygiene } from './check-hygiene.logic.js';

export async function checkHygiene(projectDir, _opts) {
  const trackedFiles = await gitTrackedFiles(projectDir);
  return { ...evaluateHygiene({ trackedFiles }), cacheEntry: null, fingerprint: null, cached: false };
}
```

- [ ] **Step 2: 修正 Task 7 里 `index.js` 的写法**

`checkHygiene` 是 async，**不能**在同步的 `runStaticCheckup` 里直接调用。把 Task 7 Step 3 写的 `hygiene: checkHygiene(projectDir)` 改为占位：

```js
    hygiene: { score: null, status: 'pending', issues: [], reason: '未开始检查' },
```

并把 `ASYNC_DIM_KEYS` 改为：

```js
/** 异步但不走 LLM 的维度：执行测试命令 / 跑 git 查询，都不能挡住同步体检响应 */
export const ASYNC_DIM_KEYS = ['tests', 'hygiene'];
```

同时删掉 Task 7 里加的 `import { checkHygiene }`——`index.js` 不再直接调用它。

- [ ] **Step 3: 在 `optimize-ops.js` 注册 runner**

```js
import { checkHygiene } from '../../features/project-checkup/check-hygiene.js';

const RUNNERS = {
  prompts: checkPrompts,
  comments: checkComments,
  tests: checkTests,
  hygiene: checkHygiene,
};
```

- [ ] **Step 4: 跑全量回归**

Run: `node --test "src/features/project-checkup/*.test.js"`
Expected: PASS

- [ ] **Step 5: 验收**

Run: `rg -n "deadcode" src/ public/js/`
Expected: 无输出（`deadcode` 已被 `hygiene` 完全取代）。若前端仍有残留，Task 10 会处理。

---

## Task 10: 前端 `DIM_META`

**Files:**
- Modify: `public/js/optimize-view.logic.js:5-11`

- [ ] **Step 1: 改 `DIM_META`**

```js
export const DIM_META = [
  { key: 'map', label: '项目地图', hint: '地图是否建立、是否过期、引用是否失效' },
  { key: 'tests', label: '测试健康度', hint: '测试是否全绿、大文件是否缺测试' },
  { key: 'prompts', label: '提示词质量', hint: '规则是否过度宽泛、是否互相冲突' },
  { key: 'rules', label: '规范加载方式', hint: '大块规范是否该从 rules 降级为 skill' },
  { key: 'comments', label: '注释合理性', hint: '注释是否解释「为什么」、是否已过期' },
  { key: 'hygiene', label: '仓库卫生', hint: '运行数据、临时脚本是否误入版本库' },
];
```

`deadcode` 条目整个删除。顺序即面板展示顺序：`tests` 紧随 `map`（两者都是高权重健壮性信号），`hygiene` 收尾。

- [ ] **Step 2: 确认前端测试仍绿**

Run: `node --test "public/js/*.test.js"`
Expected: PASS。若 `optimize-view.logic.test.js` 里有断言 `DIM_META.length === 5` 或按索引取维度，按新列表更新。

- [ ] **Step 3: 验收**

Run: `rg -n "deadcode" public/`
Expected: 无输出

---

## Task 11: 端到端验证

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 新增测试全绿。**已知有 2 个预先存在的失败**（`chat.path.test.js` 的 `📄`/`📝`，来自提交 `7487573`，与本次无关）——除这 2 个之外不应有其他失败。

- [ ] **Step 2: 起服务跑真实体检**

```bash
node server.js &
sleep 6
node -e "
fetch('http://127.0.0.1:3000/api/optimize/checkup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir:'C:/Users/DELL/Desktop/claude-p-web-demo',force:true})})
 .then(r=>r.json()).then(r=>{
   if(r.error) return console.log('错误:',r.error);
   const rep=r.report;
   console.log('总分:',rep.score,'| 等级:',rep.grade,'| 计入:',rep.countedDims);
   for(const [k,d] of Object.entries(rep.dims)) console.log('  ',k,'score='+d.score,'status='+d.status,'issues='+(d.issues||[]).length);
 });
"
```

Expected：
- `dims` 含 6 个键，`deadcode` 不再出现
- `tests` / `hygiene` 初始为 `pending`，随后经 SSE 回填
- `map` 仍为 0（本项目无 CLAUDE.md）

- [ ] **Step 3: 等异步维度回填后核对**

等约 2-3 分钟（`tests` 要跑完本项目 1600+ 测试），然后读 `optimize.json` 的最新报告：

```bash
node -e "
const j=require('./optimize.json');
const p=j.projects['C:/Users/DELL/Desktop/claude-p-web-demo'];
const c=p.llmCache||{};
console.log('comments issues 里的构建产物路径数:', (c.comments?.result?.issues||[]).filter(i=>/src-tauri\/(target|resources)/.test(i.file)).length, '(应为 0)');
"
```

逐项核对本项目的预期结果：

| 维度 | 预期 |
|---|---|
| `tests` | `S1` 应命中（本项目有 2 个预存失败测试）→ `error` 级；`S2` 应报 6 个文件（chat.js/req-view.js/req-chat.js/req-map.js/lark.js/markdown-tool.js） |
| `hygiene` | `H1` 应为 0 条（日志文件都已 gitignore）；`H2` 应为 0 条（`tmp-*` 都未入库） |
| `comments` | 构建产物路径 0 条（改动前是 2 条） |

**如果 `hygiene` 报出 0 个问题**，说明本仓库卫生本来就好——这是正确结果，不是检测器失效。Task 8 的 8 个单测已覆盖各分支。

- [ ] **Step 4: 停服务（只停 3000 端口，别 taskkill 全部 node）**

```bash
for p in $(netstat -ano | grep ":3000" | grep LISTENING | awk '{print $5}' | sort -u); do taskkill //F //PID "$p"; done
```

- [ ] **Step 5: 验收并汇报**

向用户报告：`npm test` 实际输出、体检前后总分对比、各新维度实际报出的问题数、以及 `tests` 维度跑一次的实际耗时（这直接决定要不要把它改成默认关闭）。

---

## 完成标准

- [ ] `npm test` 除 2 个预存失败外全绿
- [ ] `review-log.js` 压缩已加锁（收敛到 `jsonl.js`）
- [ ] `comments` 不再扫 `.gitignore` 的构建产物，重复 issue 消失
- [ ] 非法路径不再在 `optimize.json` 留垃圾条目，已有畸形条目已清理
- [ ] `tests` 维度：三重防护各有测试覆盖（占位脚本 → na、超时 → partial、退出码 → fail）
- [ ] `hygiene` 维度落地 `deadcode` 槽位，全项目无 `deadcode` 残留
- [ ] 权重 25/20/10/15/20/10，`score.logic.test.js` 有 6 维度加权护栏
- [ ] 前端 `DIM_META` 含 6 个维度，面板能显示两个新维度
